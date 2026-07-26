using System.Globalization;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Protocol;

public sealed class RbpUuidV7Tests
{
    [Fact]
    public void InjectedClockAndRandomSourceProduceDeterministicUuidV7()
    {
        DateTimeOffset now = DateTimeOffset.Parse(
            "2026-07-22T12:34:56.789Z",
            CultureInfo.InvariantCulture);
        var generator = new RbpUuidV7(
            new FixedTimeProvider(now),
            new CountingRandomSource());

        string first = generator.NewId();
        string second = generator.NewId();
        string hex = first.Replace("-", string.Empty, StringComparison.Ordinal);

        Assert.Matches(
            "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-" +
            "[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            first);
        Assert.Equal(
            now.ToUnixTimeMilliseconds(),
            long.Parse(
                hex[..12],
                NumberStyles.HexNumber,
                CultureInfo.InvariantCulture));
        Assert.Equal('7', first[14]);
        Assert.Contains(first[19], "89ab");
        Assert.NotEqual(first, second);
        Assert.Equal(first, first.ToLowerInvariant());
    }

    private sealed class FixedTimeProvider : TimeProvider
    {
        private readonly DateTimeOffset _now;

        internal FixedTimeProvider(DateTimeOffset now)
        {
            _now = now;
        }

        public override DateTimeOffset GetUtcNow()
        {
            return _now;
        }
    }

    private sealed class CountingRandomSource : IRbpRandomSource
    {
        private byte _next;

        public void Fill(Span<byte> destination)
        {
            for (int index = 0; index < destination.Length; index++)
            {
                destination[index] = _next++;
            }
        }

        public double NextUnitInterval()
        {
            return 0;
        }
    }
}
