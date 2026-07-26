namespace RevAgent.Bridge.Gateway.Protocol;

internal static class RbpReconnectBackoff
{
    internal const int InitialMilliseconds = 1_000;
    internal const int Factor = 2;
    internal const int CapMilliseconds = 60_000;
    internal const int ResetAfterSteadyMilliseconds = 120_000;

    internal static int LimitMilliseconds(long attemptIndex)
    {
        if (attemptIndex is < 0 or > RbpProtocolLimits.MaximumSafeInteger)
        {
            throw new ArgumentOutOfRangeException(
                nameof(attemptIndex),
                attemptIndex,
                "Attempt index must be a non-negative JSON-safe integer.");
        }

        if (attemptIndex >= 6)
        {
            return CapMilliseconds;
        }

        return Math.Min(
            CapMilliseconds,
            checked(InitialMilliseconds * (1 << checked((int)attemptIndex))));
    }

    internal static int FullJitterDelayMilliseconds(
        long attemptIndex,
        IRbpRandomSource? random = null)
    {
        double sample =
            (random ?? CryptographicRbpRandomSource.Shared).NextUnitInterval();
        if (!double.IsFinite(sample) || sample < 0 || sample >= 1)
        {
            throw new ArgumentOutOfRangeException(
                nameof(random),
                sample,
                "Random source must return a finite value in [0, 1).");
        }

        int limit = LimitMilliseconds(attemptIndex);
        return checked((int)Math.Floor(sample * (limit + 1d)));
    }

    internal static bool ShouldReset(double steadyDurationMilliseconds)
    {
        if (!IsNonNegativeFinite(steadyDurationMilliseconds))
        {
            throw new ArgumentOutOfRangeException(
                nameof(steadyDurationMilliseconds),
                steadyDurationMilliseconds,
                "Steady duration must be non-negative and finite.");
        }

        return steadyDurationMilliseconds >= ResetAfterSteadyMilliseconds;
    }

    internal static bool IsNonNegativeFinite(double value)
    {
        return double.IsFinite(value) && value >= 0;
    }
}
