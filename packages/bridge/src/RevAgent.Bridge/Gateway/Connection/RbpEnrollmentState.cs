using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace RevAgent.Bridge.Gateway.Connection;

internal enum RbpEnrollmentStatus
{
    Ready,
    EnrollmentRequired,
    Invalid,
}

internal sealed class RbpDeviceCredential
{
    private static readonly Regex FingerprintPattern = new(
        "^sha256:[0-9a-f]{64}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private readonly string _token;

    internal RbpDeviceCredential(
        string deviceId,
        string token,
        string machineFingerprint)
    {
        DeviceId = RequireBoundedText(deviceId, nameof(deviceId), 4096);
        _token = RequireBoundedText(token, nameof(token), 16 * 1024);
        if (_token.Contains('\r') || _token.Contains('\n'))
        {
            throw new ArgumentException(
                "The device credential cannot contain header delimiters.",
                nameof(token));
        }

        if (!FingerprintPattern.IsMatch(machineFingerprint))
        {
            throw new ArgumentException(
                "The machine fingerprint must be a lower-case sha256 digest.",
                nameof(machineFingerprint));
        }

        MachineFingerprint = machineFingerprint;
        CredentialBindingDigest = CreateBindingDigest(
            DeviceId,
            _token,
            MachineFingerprint);
    }

    internal string DeviceId { get; }

    internal string MachineFingerprint { get; }

    internal string CredentialBindingDigest { get; }

    internal string CreateAuthorizationHeader() => "Bearer " + _token;

    internal static string CreateBindingDigest(
        string deviceId,
        string token,
        string machineFingerprint)
    {
        byte[] deviceBytes = Encoding.UTF8.GetBytes(deviceId);
        byte[] tokenBytes = Encoding.UTF8.GetBytes(token);
        byte[] claimBytes = Encoding.UTF8.GetBytes(machineFingerprint);
        try
        {
            using IncrementalHash hash =
                IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(deviceBytes);
            hash.AppendData(stackalloc byte[] { 0 });
            hash.AppendData(tokenBytes);
            hash.AppendData(stackalloc byte[] { 0 });
            hash.AppendData(claimBytes);
            return Convert.ToHexString(hash.GetHashAndReset())
                .ToLowerInvariant();
        }
        finally
        {
            CryptographicOperations.ZeroMemory(deviceBytes);
            CryptographicOperations.ZeroMemory(tokenBytes);
            CryptographicOperations.ZeroMemory(claimBytes);
        }
    }

    public override string ToString() =>
        $"RbpDeviceCredential(DeviceId={DeviceId}, Token=[REDACTED])";

    private static string RequireBoundedText(
        string value,
        string parameterName,
        int maximumLength)
    {
        ArgumentNullException.ThrowIfNull(value, parameterName);
        if (value.Length is 0 || value.Length > maximumLength)
        {
            throw new ArgumentOutOfRangeException(
                parameterName,
                $"The value must contain 1 through {maximumLength} characters.");
        }

        return value;
    }
}

internal sealed record RbpEnrollmentSnapshot
{
    private static readonly Regex DiagnosticCodePattern = new(
        "^[a-z][a-z0-9_]{0,127}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    private RbpEnrollmentSnapshot(
        RbpEnrollmentStatus status,
        RbpDeviceCredential? credential,
        string diagnosticCode)
    {
        Status = status;
        Credential = credential;
        DiagnosticCode = diagnosticCode;
    }

    internal RbpEnrollmentStatus Status { get; }

    internal RbpDeviceCredential? Credential { get; }

    internal string DiagnosticCode { get; }

    internal static RbpEnrollmentSnapshot Ready(
        RbpDeviceCredential credential)
    {
        ArgumentNullException.ThrowIfNull(credential);
        return new RbpEnrollmentSnapshot(
            RbpEnrollmentStatus.Ready,
            credential,
            "ready");
    }

    internal static RbpEnrollmentSnapshot NotReady(
        RbpEnrollmentStatus status,
        string diagnosticCode)
    {
        if (status == RbpEnrollmentStatus.Ready)
        {
            throw new ArgumentOutOfRangeException(
                nameof(status),
                "A ready enrollment snapshot requires a credential.");
        }

        if (string.IsNullOrEmpty(diagnosticCode) ||
            !DiagnosticCodePattern.IsMatch(diagnosticCode))
        {
            throw new ArgumentException(
                "The enrollment diagnostic code must be a bounded value.",
                nameof(diagnosticCode));
        }

        return new RbpEnrollmentSnapshot(status, null, diagnosticCode);
    }
}

internal interface IRbpEnrollmentStateProvider
{
    ValueTask<RbpEnrollmentSnapshot> ReadAsync(
        CancellationToken cancellationToken = default);
}

internal sealed class EnrollmentRequiredStateProvider :
    IRbpEnrollmentStateProvider
{
    public ValueTask<RbpEnrollmentSnapshot> ReadAsync(
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(
            RbpEnrollmentSnapshot.NotReady(
                RbpEnrollmentStatus.EnrollmentRequired,
                "enrollment_required"));
    }
}
