using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Protocol;

public sealed class RbpReconnectBackoffTests
{
    [Fact]
    public void FrozenReconnectLimitsJitterAndResetVectorsMatch()
    {
        using JsonDocument fixture =
            RbpFixtureReader.Load("reconnect-backoff.json");
        foreach (JsonElement vector in fixture.RootElement
                     .GetProperty("limits")
                     .EnumerateArray())
        {
            Assert.Equal(
                vector.GetProperty("limit_ms").GetInt32(),
                RbpReconnectBackoff.LimitMilliseconds(
                    vector.GetProperty("attempt_index").GetInt64()));
        }

        foreach (JsonElement vector in fixture.RootElement
                     .GetProperty("jitter")
                     .EnumerateArray())
        {
            Assert.Equal(
                vector.GetProperty("delay_ms").GetInt32(),
                RbpReconnectBackoff.FullJitterDelayMilliseconds(
                    vector.GetProperty("attempt_index").GetInt64(),
                    new FixedRandomSource(
                        vector.GetProperty("sample").GetDouble())));
        }

        foreach (JsonElement vector in fixture.RootElement
                     .GetProperty("reset")
                     .EnumerateArray())
        {
            Assert.Equal(
                vector.GetProperty("reset").GetBoolean(),
                RbpReconnectBackoff.ShouldReset(
                    vector.GetProperty("steady_ms").GetDouble()));
        }
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(9_007_199_254_740_992)]
    public void UnsafeAttemptIndexesFailClosed(long attemptIndex)
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => RbpReconnectBackoff.LimitMilliseconds(attemptIndex));
    }

    private sealed class FixedRandomSource : IRbpRandomSource
    {
        private readonly double _sample;

        internal FixedRandomSource(double sample)
        {
            _sample = sample;
        }

        public void Fill(Span<byte> destination)
        {
            destination.Clear();
        }

        public double NextUnitInterval()
        {
            return _sample;
        }
    }
}
