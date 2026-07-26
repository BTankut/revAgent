using System.Security.Cryptography;

namespace RevAgent.Bridge.Gateway.Protocol;

internal interface IRbpRandomSource
{
    void Fill(Span<byte> destination);

    double NextUnitInterval();
}

internal sealed class CryptographicRbpRandomSource : IRbpRandomSource
{
    internal static CryptographicRbpRandomSource Shared { get; } = new();

    private CryptographicRbpRandomSource()
    {
    }

    public void Fill(Span<byte> destination)
    {
        RandomNumberGenerator.Fill(destination);
    }

    public double NextUnitInterval()
    {
        Span<byte> bytes = stackalloc byte[8];
        RandomNumberGenerator.Fill(bytes);
        ulong sample = BitConverter.ToUInt64(bytes);

        // Retain 53 random bits, exactly matching the precision of a JSON/
        // ECMAScript number in the frozen reference reducer.
        return (sample >> 11) * (1.0 / (1UL << 53));
    }
}
