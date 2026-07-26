using System.Buffers;
using System.Security.Cryptography;
using System.Text;

namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal static class BridgeMachineFingerprintPolicy
{
    internal const string Name = "bridge_random_seed_v1";
    internal const int SeedSizeBytes = 32;

    internal static string Derive(ReadOnlySpan<byte> seed)
    {
        if (seed.Length != SeedSizeBytes)
        {
            throw new ArgumentException(
                $"The bridge identity seed must contain exactly {SeedSizeBytes} bytes.",
                nameof(seed));
        }

        Span<byte> digest = stackalloc byte[SHA256.HashSizeInBytes];
        _ = SHA256.HashData(seed, digest);
        return "sha256:" + Convert.ToHexString(digest).ToLowerInvariant();
    }
}

internal sealed class BridgeMachineIdentity : IDisposable
{
    private byte[]? _seed;

    internal BridgeMachineIdentity(byte[] seed)
        : this(seed.AsSpan())
    {
    }

    internal BridgeMachineIdentity(ReadOnlySpan<byte> seed)
    {
        if (seed.Length != BridgeMachineFingerprintPolicy.SeedSizeBytes)
        {
            throw new ArgumentException(
                $"The bridge identity seed must contain exactly " +
                $"{BridgeMachineFingerprintPolicy.SeedSizeBytes} bytes.",
                nameof(seed));
        }

        _seed = seed.ToArray();
        MachineFingerprint = BridgeMachineFingerprintPolicy.Derive(_seed);
    }

    internal string FingerprintPolicy => BridgeMachineFingerprintPolicy.Name;

    internal string MachineFingerprint { get; }

    internal byte[] CopySeed()
    {
        ObjectDisposedException.ThrowIf(_seed is null, this);
        return (byte[])_seed.Clone();
    }

    public void Dispose()
    {
        byte[]? seed = Interlocked.Exchange(ref _seed, null);
        if (seed is not null)
        {
            CryptographicOperations.ZeroMemory(seed);
        }
    }

    public override string ToString() =>
        $"BridgeMachineIdentity {{ FingerprintPolicy = {FingerprintPolicy}, " +
        $"MachineFingerprint = {MachineFingerprint} }}";
}

internal sealed class BridgeSecretString : IDisposable
{
    private const int MinimumUtf8Bytes = 32;
    private const int MaximumUtf8Bytes = 16 * 1024;
    private static readonly UTF8Encoding StrictUtf8 =
        new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
    private byte[]? _utf8Value;

    internal BridgeSecretString(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (string.IsNullOrWhiteSpace(value))
        {
            throw InvalidSecret(nameof(value));
        }

        _utf8Value = StrictUtf8.GetBytes(value);
        try
        {
            ValidateLength(_utf8Value.Length, nameof(value));
        }
        catch
        {
            CryptographicOperations.ZeroMemory(_utf8Value);
            _utf8Value = null;
            throw;
        }
    }

    internal BridgeSecretString(ReadOnlySpan<byte> utf8Value)
    {
        ValidateLength(utf8Value.Length, nameof(utf8Value));
        ValidateUtf8Content(utf8Value, nameof(utf8Value));
        _utf8Value = utf8Value.ToArray();
    }

    ~BridgeSecretString()
    {
        DisposeCore();
    }

    internal string Reveal()
    {
        byte[] value = _utf8Value ??
            throw new ObjectDisposedException(nameof(BridgeSecretString));
        return StrictUtf8.GetString(value);
    }

    internal byte[] CopyUtf8Bytes()
    {
        byte[] value = _utf8Value ??
            throw new ObjectDisposedException(nameof(BridgeSecretString));
        return (byte[])value.Clone();
    }

    internal BridgeSecretString Clone()
    {
        byte[] copy = CopyUtf8Bytes();
        try
        {
            return new BridgeSecretString(copy);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(copy);
        }
    }

    public void Dispose()
    {
        DisposeCore();
        GC.SuppressFinalize(this);
    }

    public override string ToString() => "[redacted]";

    private void DisposeCore()
    {
        byte[]? value = Interlocked.Exchange(ref _utf8Value, null);
        if (value is not null)
        {
            CryptographicOperations.ZeroMemory(value);
        }
    }

    private static void ValidateLength(int byteCount, string parameterName)
    {
        if (byteCount < MinimumUtf8Bytes ||
            byteCount > MaximumUtf8Bytes)
        {
            throw InvalidSecret(parameterName);
        }
    }

    private static void ValidateUtf8Content(
        ReadOnlySpan<byte> utf8Value,
        string parameterName)
    {
        bool hasNonWhitespace = false;
        while (!utf8Value.IsEmpty)
        {
            OperationStatus status = Rune.DecodeFromUtf8(
                utf8Value,
                out Rune rune,
                out int consumed);
            if (status != OperationStatus.Done || consumed <= 0)
            {
                throw InvalidSecret(parameterName);
            }

            hasNonWhitespace |= !Rune.IsWhiteSpace(rune);
            utf8Value = utf8Value[consumed..];
        }

        if (!hasNonWhitespace)
        {
            throw InvalidSecret(parameterName);
        }
    }

    private static ArgumentException InvalidSecret(string parameterName) =>
        new(
            "The device token must be a bounded opaque secret of at least " +
            "256 bits.",
            parameterName);
}

internal sealed class BridgeDeviceCredential : IDisposable
{
    internal BridgeDeviceCredential(
        string deviceId,
        BridgeSecretString deviceToken,
        DateTimeOffset issuedAtUtc)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(deviceId);
        ArgumentNullException.ThrowIfNull(deviceToken);
        if (deviceId.Length > 256)
        {
            throw new ArgumentOutOfRangeException(
                nameof(deviceId),
                "The Gateway device id must not exceed 256 characters.");
        }

        DateTimeOffset normalizedIssuedAt = issuedAtUtc.ToUniversalTime();
        if (normalizedIssuedAt < DateTimeOffset.UnixEpoch)
        {
            throw new ArgumentOutOfRangeException(
                nameof(issuedAtUtc),
                "The device-token issue time must not precede the Unix epoch.");
        }

        DeviceId = deviceId;
        DeviceToken = deviceToken;
        IssuedAtUtc = normalizedIssuedAt;
    }

    internal string DeviceId { get; }

    internal BridgeSecretString DeviceToken { get; }

    internal DateTimeOffset IssuedAtUtc { get; }

    public void Dispose() => DeviceToken.Dispose();

    public override string ToString() =>
        $"BridgeDeviceCredential {{ DeviceId = {DeviceId}, " +
        $"DeviceToken = [redacted], IssuedAtUtc = {IssuedAtUtc:O} }}";
}

internal sealed class BridgeRuntimeCredentialState : IDisposable
{
    internal BridgeRuntimeCredentialState(
        string machineFingerprint,
        BridgeDeviceCredential? deviceCredential)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(machineFingerprint);
        MachineFingerprint = machineFingerprint;
        DeviceCredential = deviceCredential;
    }

    internal string MachineFingerprint { get; }

    internal BridgeDeviceCredential? DeviceCredential { get; }

    internal bool IsEnrolled => DeviceCredential is not null;

    public void Dispose() => DeviceCredential?.Dispose();

    public override string ToString() =>
        $"BridgeRuntimeCredentialState {{ MachineFingerprint = " +
        $"{MachineFingerprint}, " +
        $"IsEnrolled = {IsEnrolled}, DeviceCredential = " +
        $"{(DeviceCredential is null ? "null" : "[redacted]")} }}";
}
