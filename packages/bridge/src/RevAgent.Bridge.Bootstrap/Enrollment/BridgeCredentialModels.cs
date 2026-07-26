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
    {
        ArgumentNullException.ThrowIfNull(seed);
        if (seed.Length != BridgeMachineFingerprintPolicy.SeedSizeBytes)
        {
            throw new ArgumentException(
                $"The bridge identity seed must contain exactly " +
                $"{BridgeMachineFingerprintPolicy.SeedSizeBytes} bytes.",
                nameof(seed));
        }

        _seed = (byte[])seed.Clone();
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

internal sealed class BridgeSecretString
{
    private const int MinimumUtf8Bytes = 32;
    private const int MaximumUtf8Bytes = 16 * 1024;
    private readonly string _value;

    internal BridgeSecretString(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        int byteCount = Encoding.UTF8.GetByteCount(value);
        if (string.IsNullOrWhiteSpace(value) ||
            byteCount < MinimumUtf8Bytes ||
            byteCount > MaximumUtf8Bytes)
        {
            throw new ArgumentException(
                "The device token must be a bounded opaque secret of at least " +
                "256 bits.",
                nameof(value));
        }

        _value = value;
    }

    internal string Reveal() => _value;

    public override string ToString() => "[redacted]";
}

internal sealed class BridgeDeviceCredential
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

    public override string ToString() =>
        $"BridgeDeviceCredential {{ DeviceId = {DeviceId}, " +
        $"DeviceToken = [redacted], IssuedAtUtc = {IssuedAtUtc:O} }}";
}

internal sealed class BridgeRuntimeCredentialState
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

    public override string ToString() =>
        $"BridgeRuntimeCredentialState {{ MachineFingerprint = " +
        $"{MachineFingerprint}, " +
        $"IsEnrolled = {IsEnrolled}, DeviceCredential = " +
        $"{(DeviceCredential is null ? "null" : "[redacted]")} }}";
}
