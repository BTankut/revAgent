using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Connection;

internal interface IRbpConnectionCycle : IAsyncDisposable
{
    RbpHelloAckPayload Acknowledgement { get; }

    Task SendAsync(
        RbpEnvelope envelope,
        CancellationToken cancellationToken = default);

    Task<RbpEnvelope> ReceiveAsync(
        CancellationToken cancellationToken = default);

    Task CloseAsync(CancellationToken cancellationToken = default);
}

internal interface IRbpConnectionCycleFactory
{
    /// <summary>
    /// The one immutable production binding this factory admits at its
    /// public endpoint boundary.  The coordinator uses this contract rather
    /// than a factory type name, so a configured HTTP/SSE worker cannot
    /// accidentally be given a WebSocket URI (or vice versa).
    /// </summary>
    RbpConnectionBindingKind BindingKind { get; }

    /// <summary>
    /// The URI scheme required for <see cref="OpenAsync"/>.  This is derived
    /// solely from <see cref="BindingKind"/> and is intentionally not an
    /// option supplied by the caller.
    /// </summary>
    string ExpectedEndpointScheme =>
        RbpConnectionBindingContract.ExpectedEndpointScheme(BindingKind);

    Task<IRbpConnectionCycle> OpenAsync(
        Uri endpoint,
        RbpHelloProfile profile,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Named, immutable RBP connection bindings.  The primary/fallback factory
/// receives the WSS production endpoint and derives the HTTPS endpoint only
/// for its separately capability-gated fallback attempt.
/// </summary>
internal enum RbpConnectionBindingKind
{
    Wss,
    StreamableHttpSse,
    WssWithStreamableHttpSseFallback,
}

internal static class RbpConnectionBindingContract
{
    internal static string ExpectedEndpointScheme(
        RbpConnectionBindingKind bindingKind) =>
        bindingKind switch
        {
            RbpConnectionBindingKind.Wss or
            RbpConnectionBindingKind.WssWithStreamableHttpSseFallback =>
                Uri.UriSchemeWss,
            RbpConnectionBindingKind.StreamableHttpSse =>
                Uri.UriSchemeHttps,
            _ => throw new ArgumentOutOfRangeException(nameof(bindingKind)),
        };

    internal static void RequireExpectedEndpointScheme(
        Uri endpoint,
        string expectedScheme,
        string parameterName)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        if (!endpoint.IsAbsoluteUri ||
            !string.Equals(
                endpoint.Scheme,
                expectedScheme,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException(
                $"The selected RBP binding requires a {expectedScheme} " +
                "endpoint.",
                parameterName);
        }
    }

    internal static Uri WithExpectedScheme(
        Uri endpoint,
        string expectedScheme)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        return new UriBuilder(endpoint)
        {
            Scheme = expectedScheme,
        }.Uri;
    }
}

internal sealed class WssRbpConnectionCycleFactory :
    IRbpConnectionCycleFactory
{
    private readonly RbpGatewayHandshakeClient _handshakeClient;

    internal WssRbpConnectionCycleFactory(
        RbpGatewayHandshakeClient handshakeClient)
    {
        _handshakeClient = handshakeClient ??
            throw new ArgumentNullException(nameof(handshakeClient));
    }

    public RbpConnectionBindingKind BindingKind =>
        RbpConnectionBindingKind.Wss;

    public string ExpectedEndpointScheme => Uri.UriSchemeWss;

    public async Task<IRbpConnectionCycle> OpenAsync(
        Uri endpoint,
        RbpHelloProfile profile,
        CancellationToken cancellationToken = default)
    {
        RbpConnectionBindingContract.RequireExpectedEndpointScheme(
            endpoint,
            ExpectedEndpointScheme,
            nameof(endpoint));
        RbpGatewayHandshake handshake =
            await _handshakeClient.ConnectAsync(
                    endpoint,
                    profile,
                    cancellationToken)
                .ConfigureAwait(false);
        return new WssRbpConnectionCycle(handshake);
    }
}

internal sealed class WssRbpConnectionCycle : IRbpConnectionCycle
{
    private readonly RbpGatewayHandshake _handshake;

    internal WssRbpConnectionCycle(RbpGatewayHandshake handshake)
    {
        _handshake = handshake ??
            throw new ArgumentNullException(nameof(handshake));
    }

    public RbpHelloAckPayload Acknowledgement =>
        _handshake.Acknowledgement;

    public Task SendAsync(
        RbpEnvelope envelope,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        return _handshake.Connection.SendTextAsync(
            RbpEnvelopeCodec.Encode(envelope),
            cancellationToken);
    }

    public async Task<RbpEnvelope> ReceiveAsync(
        CancellationToken cancellationToken = default)
    {
        byte[] frame = await _handshake.Connection
            .ReceiveTextAsync(cancellationToken)
            .ConfigureAwait(false);
        try
        {
            return RbpEnvelopeCodec.Decode(frame);
        }
        catch (RbpFrameException exception)
        {
            throw new RbpGatewayTransportException(
                RbpGatewayFailureKind.Protocol,
                "The Gateway returned an invalid negotiated RBP frame.",
                innerException: exception);
        }
    }

    public Task CloseAsync(CancellationToken cancellationToken = default) =>
        _handshake.Connection.CloseAsync(cancellationToken);

    public ValueTask DisposeAsync() => _handshake.DisposeAsync();
}
