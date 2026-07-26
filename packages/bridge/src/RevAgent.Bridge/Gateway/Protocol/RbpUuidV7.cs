using System.Globalization;

namespace RevAgent.Bridge.Gateway.Protocol;

internal sealed class RbpUuidV7
{
    private const long MaximumUnixMilliseconds = (1L << 48) - 1;
    private readonly TimeProvider _timeProvider;
    private readonly IRbpRandomSource _random;

    internal RbpUuidV7(
        TimeProvider? timeProvider = null,
        IRbpRandomSource? random = null)
    {
        _timeProvider = timeProvider ?? TimeProvider.System;
        _random = random ?? CryptographicRbpRandomSource.Shared;
    }

    internal string NewId()
    {
        long timestamp = _timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (timestamp is < 0 or > MaximumUnixMilliseconds)
        {
            throw new InvalidOperationException(
                "The current time is outside the UUIDv7 48-bit timestamp range.");
        }

        Span<byte> bytes = stackalloc byte[16];
        _random.Fill(bytes);
        bytes[0] = (byte)(timestamp >> 40);
        bytes[1] = (byte)(timestamp >> 32);
        bytes[2] = (byte)(timestamp >> 24);
        bytes[3] = (byte)(timestamp >> 16);
        bytes[4] = (byte)(timestamp >> 8);
        bytes[5] = (byte)timestamp;
        bytes[6] = (byte)((bytes[6] & 0x0f) | 0x70);
        bytes[8] = (byte)((bytes[8] & 0x3f) | 0x80);

        string hex = Convert.ToHexString(bytes).ToLower(CultureInfo.InvariantCulture);
        return $"{hex[..8]}-{hex[8..12]}-{hex[12..16]}-" +
               $"{hex[16..20]}-{hex[20..]}";
    }
}
