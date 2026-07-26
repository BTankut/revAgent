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
    Task<IRbpConnectionCycle> OpenAsync(
        Uri endpoint,
        RbpHelloProfile profile,
        CancellationToken cancellationToken = default);
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

    public async Task<IRbpConnectionCycle> OpenAsync(
        Uri endpoint,
        RbpHelloProfile profile,
        CancellationToken cancellationToken = default)
    {
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
