namespace RevAgent.Bridge.Gateway.Connection;

internal static class RbpTransportCapabilities
{
    internal const string StreamableHttp =
        "transport_streamable_http";
}

internal sealed class RbpPrimaryFallbackConnectionCycleFactory :
    IRbpConnectionCycleFactory
{
    private readonly IRbpConnectionCycleFactory _primary;
    private readonly IRbpConnectionCycleFactory _fallback;
    private readonly bool _streamableHttpProvisioned;

    internal RbpPrimaryFallbackConnectionCycleFactory(
        IRbpConnectionCycleFactory primary,
        IRbpConnectionCycleFactory fallback,
        IReadOnlyCollection<string> provisionedCapabilities)
    {
        _primary = primary ??
            throw new ArgumentNullException(nameof(primary));
        _fallback = fallback ??
            throw new ArgumentNullException(nameof(fallback));
        ArgumentNullException.ThrowIfNull(provisionedCapabilities);
        _streamableHttpProvisioned =
            provisionedCapabilities.Contains(
                RbpTransportCapabilities.StreamableHttp,
                StringComparer.Ordinal);
    }

    public async Task<IRbpConnectionCycle> OpenAsync(
        Uri endpoint,
        RbpHelloProfile profile,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        ArgumentNullException.ThrowIfNull(profile);
        try
        {
            return await _primary.OpenAsync(
                    endpoint,
                    profile,
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpGatewayTransportException exception)
            when (CanTryFallback(exception, profile))
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return await _fallback.OpenAsync(
                        endpoint,
                        profile,
                        cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (RbpGatewayTransportException fallbackFailure)
            {
                throw PreserveRetryFloor(
                    exception,
                    fallbackFailure);
            }
        }
    }

    private bool CanTryFallback(
        RbpGatewayTransportException exception,
        RbpHelloProfile profile) =>
        exception.Kind == RbpGatewayFailureKind.Network &&
        exception.FallbackEligible &&
        _streamableHttpProvisioned &&
        profile.Capabilities.Contains(
            RbpTransportCapabilities.StreamableHttp,
            StringComparer.Ordinal);

    private static RbpGatewayTransportException PreserveRetryFloor(
        RbpGatewayTransportException primary,
        RbpGatewayTransportException fallback)
    {
        if (fallback.RetryPaused)
        {
            return fallback;
        }

        DateTimeOffset? retryFloor =
            primary.RetryNotBeforeUtc is { } primaryFloor &&
            (fallback.RetryNotBeforeUtc is null ||
             primaryFloor > fallback.RetryNotBeforeUtc)
                ? primaryFloor
                : fallback.RetryNotBeforeUtc;
        RbpRetryAfterDisposition disposition =
            StrongerDisposition(
                primary.RetryAfterDisposition,
                fallback.RetryAfterDisposition);
        if (retryFloor == fallback.RetryNotBeforeUtc &&
            disposition == fallback.RetryAfterDisposition)
        {
            return fallback;
        }

        return new RbpGatewayTransportException(
            fallback.Kind,
            fallback.Message,
            statusCode: fallback.StatusCode,
            closeCode: fallback.CloseCode,
            retryNotBeforeUtc: retryFloor,
            retryAfterDisposition: disposition,
            versionWindow: fallback.VersionWindow,
            innerException: new AggregateException(primary, fallback));
    }

    private static RbpRetryAfterDisposition StrongerDisposition(
        RbpRetryAfterDisposition left,
        RbpRetryAfterDisposition right) =>
        Rank(left) >= Rank(right) ? left : right;

    private static int Rank(RbpRetryAfterDisposition disposition) =>
        disposition switch
        {
            RbpRetryAfterDisposition.Accepted => 3,
            RbpRetryAfterDisposition.IgnoredOutOfRange => 2,
            RbpRetryAfterDisposition.IgnoredMalformed => 1,
            _ => 0,
        };
}
