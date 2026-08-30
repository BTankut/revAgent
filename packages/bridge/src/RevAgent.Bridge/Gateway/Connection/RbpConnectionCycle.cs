using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Connection;

internal interface IRbpConnectionCycle : IAsyncDisposable
{
    RbpHelloAckPayload Acknowledgement { get; }

    Task SendAsync(
        RbpEnvelope envelope,
        CancellationToken cancellationToken = default);

    RbpPreparedSend PrepareSend(
        RbpEnvelope envelope,
        CancellationToken cancellationToken = default) =>
        new(this, envelope, cancellationToken);

    Task<RbpEnvelope> ReceiveAsync(
        CancellationToken cancellationToken = default);

    Task CloseAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// Side-effect-free, single-use reservation for one connection send. Exact
/// no-start proof exists only when cancellation wins before <see cref="TryStart"/>.
/// </summary>
internal sealed class RbpPreparedSend
{
    private readonly IRbpConnectionCycle _cycle;
    private readonly RbpEnvelope _envelope;
    private readonly CancellationToken _cancellationToken;
    private readonly TaskCompletionSource _settlement = new(
        TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<Task?> _hotPublished = new(
        TaskCreationOptions.RunContinuationsAsynchronously);
    private Task? _hotTask;
    private int _state;

    internal RbpPreparedSend(
        IRbpConnectionCycle cycle,
        RbpEnvelope envelope,
        CancellationToken cancellationToken)
    {
        _cycle = cycle ?? throw new ArgumentNullException(nameof(cycle));
        ArgumentNullException.ThrowIfNull(envelope);
        _envelope = envelope with
        {
            Payload = envelope.Payload.Clone(),
            Hello = envelope.Hello is { } hello
                ? hello with
                {
                    Capabilities = Array.AsReadOnly(
                        hello.Capabilities.ToArray()),
                    AddinVersions = Array.AsReadOnly(
                        hello.AddinVersions.ToArray()),
                    Machine = hello.Machine with { },
                }
                : null,
            HelloAck = envelope.HelloAck is { } helloAck
                ? helloAck with
                {
                    GrantedCapabilities = Array.AsReadOnly(
                        helloAck.GrantedCapabilities.ToArray()),
                    Limits = helloAck.Limits with { },
                    Manifest = helloAck.Manifest with { },
                }
                : null,
            AdditionalProperties = RbpEnvelope.FreezeAdditionalProperties(
                envelope.AdditionalProperties.ToDictionary(
                    pair => pair.Key,
                    pair => pair.Value.Clone(),
                    StringComparer.Ordinal)),
        };
        _cancellationToken = cancellationToken;
    }

    internal bool TryCancelBeforeStart()
    {
        if (Interlocked.CompareExchange(ref _state, 2, 0) != 0)
            return false;
        _hotPublished.TrySetResult(null);
        _settlement.TrySetCanceled(_cancellationToken);
        return true;
    }

    internal bool TryStart(out Task? task)
    {
        if (Interlocked.CompareExchange(ref _state, 1, 0) != 0)
        {
            task = Volatile.Read(ref _state) == 1
                ? Volatile.Read(ref _hotTask) ?? _settlement.Task
                : null;
            return false;
        }

        try
        {
            Task hot = _cycle.SendAsync(_envelope, _cancellationToken);
            if (hot is null)
                throw new InvalidOperationException(
                    "The connection send returned no operation task.");
            Volatile.Write(ref _hotTask, hot);
            _hotPublished.TrySetResult(hot);
            CompleteSettlement(hot);
            task = hot;
            return true;
        }
        catch (Exception exception)
        {
            _hotPublished.TrySetResult(null);
            _settlement.TrySetException(exception);
        }
        task = _settlement.Task;
        return true;
    }

    internal Task? StartedTask => Volatile.Read(ref _state) == 0
        ? null
        : Volatile.Read(ref _hotTask) ?? _settlement.Task;
    internal Task<Task?> HotTaskPublished => _hotPublished.Task;
    internal bool IsCancelledBeforeStart => Volatile.Read(ref _state) == 2;

    private void CompleteSettlement(Task hot) =>
        _ = hot.ContinueWith(
            completed =>
            {
                if (completed.IsCanceled)
                    _settlement.TrySetCanceled();
                else if (completed.IsFaulted)
                    _settlement.TrySetException(
                        completed.Exception!.InnerExceptions);
                else
                    _settlement.TrySetResult();
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
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
