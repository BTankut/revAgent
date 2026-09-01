using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed class StreamableHttpRbpConnectionCycle :
    IRbpConnectionCycle
{
    private readonly HttpClient _client;
    private readonly HttpResponseMessage _eventsResponse;
    private readonly Stream _eventsStream;
    private readonly SseRbpEventReader _events;
    private readonly Uri _messagesUri;
    private readonly RbpDeviceCredential _credential;
    private readonly TimeProvider _timeProvider;
    private readonly Action<RbpSseReceiveObservation>? _onSseReceiveObservation;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly SemaphoreSlim _receiveGate = new(1, 1);
    private readonly SemaphoreSlim _lifecycleGate = new(1, 1);
    private readonly SemaphoreSlim _heartbeatGate = new(1, 1);
    private readonly ConcurrentDictionary<string, SemaphoreSlim>
        _sessionGates = new(StringComparer.Ordinal);
    private readonly object _lifetimeSync = new();
    private Exception? _terminalFailure;
    private Task? _closeTask;
    private TaskCompletionSource? _operationsQuiesced;
    private LifetimeEndOwner _lifetimeEndOwner;
    private int _admittedOperations;
    private bool _disposeRequested;
    private bool _disposed;
    private int _streamEnded;

    internal StreamableHttpRbpConnectionCycle(
        HttpClient client,
        HttpResponseMessage eventsResponse,
        Stream eventsStream,
        Uri messagesUri,
        RbpDeviceCredential credential,
        RbpHelloAckPayload acknowledgement,
        TimeProvider timeProvider,
        Action<RbpSseReceiveObservation>? onSseReceiveObservation = null)
    {
        _client = client ?? throw new ArgumentNullException(nameof(client));
        _eventsResponse = eventsResponse ??
            throw new ArgumentNullException(nameof(eventsResponse));
        _eventsStream = eventsStream ??
            throw new ArgumentNullException(nameof(eventsStream));
        _onSseReceiveObservation = onSseReceiveObservation;
        _events = new SseRbpEventReader(
            _eventsStream,
            stage => ObserveSseReceive(stage));
        _messagesUri = messagesUri ??
            throw new ArgumentNullException(nameof(messagesUri));
        _credential = credential ??
            throw new ArgumentNullException(nameof(credential));
        Acknowledgement = acknowledgement ??
            throw new ArgumentNullException(nameof(acknowledgement));
        _timeProvider = timeProvider ??
            throw new ArgumentNullException(nameof(timeProvider));
    }

    public RbpHelloAckPayload Acknowledgement { get; }

    public async Task SendAsync(
        RbpEnvelope envelope,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        using TransportOperationLease admitted = AdmitOperation();
        if (envelope.Scope == RbpEnvelopeScope.PreNegotiation)
        {
            throw RbpHttpBindingProtocol.Protocol(
                "Fallback hello is carried only by connection creation.");
        }

        SemaphoreSlim gate = SelectSendGate(envelope);
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            EnsureActive();
            await PostMessageAsync(envelope, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<RbpEnvelope> ReceiveAsync(
        CancellationToken cancellationToken = default)
    {
        using TransportOperationLease admitted = AdmitOperation();
        await _receiveGate.WaitAsync(cancellationToken)
            .ConfigureAwait(false);
        try
        {
            EnsureActive();
            using CancellationTokenSource linked =
                CancellationTokenSource.CreateLinkedTokenSource(
                    cancellationToken,
                    _lifetime.Token);
            byte[] frame;
            try
            {
                frame = await _events.ReadAsync(linked.Token)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
                when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException)
                when (_lifetime.IsCancellationRequested)
            {
                throw TerminalOrRemoteClosed();
            }
            catch (RbpGatewayTransportException exception)
            {
                ObserveSseReceive("parser_error", outcome: "error");
                Terminate(exception);
                throw;
            }
            catch (Exception exception)
                when (exception is HttpRequestException or
                    IOException or
                    ObjectDisposedException)
            {
                ObserveSseReceive("stream_end", outcome: "error");
                if (Volatile.Read(ref _terminalFailure) is { } terminal)
                {
                    throw terminal;
                }

                RbpGatewayTransportException failure =
                    RbpHttpBindingProtocol.RequestFailure(
                        "The fallback SSE stream failed.",
                        exception);
                Terminate(failure);
                throw failure;
            }

            try
            {
                RbpEnvelope envelope = RbpEnvelopeCodec.Decode(frame);
                ObserveSseReceive(
                    "method_kind",
                    string.Equals(envelope.Type, "session_registered", StringComparison.Ordinal)
                        ? "session_registered"
                        : "other");
                return envelope;
            }
            catch (RbpFrameException exception)
            {
                ObserveSseReceive("parser_error", outcome: "error");
                RbpGatewayTransportException failure =
                    RbpHttpBindingProtocol.Protocol(
                        "The fallback SSE event contained invalid RBP.",
                        exception);
                Terminate(failure);
                throw failure;
            }
        }
        finally
        {
            _receiveGate.Release();
        }
    }

    public Task CloseAsync(
        CancellationToken cancellationToken = default) =>
        BeginLifetimeEnd(LifetimeEndOwner.Close, cancellationToken);

    public ValueTask DisposeAsync()
    {
        TaskCompletionSource? owner = null;
        Task quiescence = Task.CompletedTask;
        Task ending;
        lock (_lifetimeSync)
        {
            if (_disposed)
                return _closeTask is { } settled
                    ? new ValueTask(settled)
                    : ValueTask.CompletedTask;
            if (_disposeRequested)
                return new ValueTask(_closeTask ??
                    throw new InvalidOperationException(
                        "Direct HTTP disposal has no retained lifetime owner."));
            _disposeRequested = true;
            ending = PublishLifetimeEndUnderLock(
                LifetimeEndOwner.DirectDispose,
                out owner,
                out quiescence);
        }
        if (owner is not null)
            _ = CompleteLifetimeEndAsync(
                owner, CancellationToken.None, quiescence);
        TryFinalizeAfterOperation();
        return new ValueTask(ending);
    }

    private Task BeginLifetimeEnd(
        LifetimeEndOwner ownerKind,
        CancellationToken cancellationToken)
    {
        TaskCompletionSource? owner = null;
        Task quiescence = Task.CompletedTask;
        Task ending;
        lock (_lifetimeSync)
        {
            if (_closeTask is not null) return _closeTask;
            if (_disposed)
                return Task.FromException(new ObjectDisposedException(
                    nameof(StreamableHttpRbpConnectionCycle)));
            ending = PublishLifetimeEndUnderLock(
                ownerKind, out owner, out quiescence);
        }
        if (owner is not null)
            _ = CompleteLifetimeEndAsync(
                owner, cancellationToken, quiescence);
        return ending;
    }

    private Task PublishLifetimeEndUnderLock(
        LifetimeEndOwner ownerKind,
        out TaskCompletionSource? owner,
        out Task quiescence)
    {
        if (_closeTask is not null)
        {
            owner = null;
            quiescence = Task.CompletedTask;
            return _closeTask;
        }
        _lifetimeEndOwner = ownerKind;
        if (_admittedOperations == 0)
        {
            quiescence = Task.CompletedTask;
        }
        else
        {
            _operationsQuiesced = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously);
            quiescence = _operationsQuiesced.Task;
        }
        owner = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        _closeTask = owner.Task;
        return _closeTask;
    }

    private async Task CompleteLifetimeEndAsync(
        TaskCompletionSource owner,
        CancellationToken cancellationToken,
        Task quiescence)
    {
        try
        {
            // The exact owner task is already published. Cancellation callbacks
            // and operation releases can therefore re-enter without taking a
            // second close owner or running under _lifetimeSync.
            EndEventStream();
            cancellationToken.ThrowIfCancellationRequested();
            await quiescence.WaitAsync(cancellationToken)
                .ConfigureAwait(false);
            owner.TrySetResult();
        }
        catch (Exception exception)
        {
            owner.TrySetException(exception);
        }
        finally
        {
            TryFinalizeAfterOperation();
        }
    }

    private async Task PostMessageAsync(
        RbpEnvelope envelope,
        CancellationToken cancellationToken)
    {
        using var request =
            new HttpRequestMessage(HttpMethod.Post, _messagesUri);
        RbpHttpBindingProtocol.ApplyHttpVersion(request);
        RbpHttpBindingProtocol.ApplyAuthenticatedHeaders(
            request,
            _credential);
        request.Headers.Accept.Add(
            new MediaTypeWithQualityHeaderValue("application/json"));
        request.Content =
            new ByteArrayContent(RbpEnvelopeCodec.Encode(envelope));
        request.Content.Headers.ContentType =
            new MediaTypeHeaderValue("application/json");
        using CancellationTokenSource linked =
            CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken,
                _lifetime.Token);
        HttpResponseMessage response;
        try
        {
            response = await _client.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    linked.Token)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            Terminate(
                RbpHttpBindingProtocol.RequestFailure(
                    "The fallback RBP message POST was cancelled after " +
                    "dispatch.",
                    new OperationCanceledException(cancellationToken),
                    durableAcceptanceUnknown: true));
            throw;
        }
        catch (OperationCanceledException exception)
            when (_lifetime.IsCancellationRequested)
        {
            throw TerminalOrRemoteClosed(exception);
        }
        catch (Exception exception)
            when (exception is HttpRequestException or IOException)
        {
            RbpGatewayTransportException failure =
                RbpHttpBindingProtocol.RequestFailure(
                    "The fallback RBP message POST failed.",
                    exception,
                    durableAcceptanceUnknown: true);
            Terminate(failure);
            throw failure;
        }

        using (response)
        {
            if (response.StatusCode == HttpStatusCode.Accepted)
            {
                return;
            }

            RbpGatewayTransportException failure =
                RbpHttpBindingProtocol.StatusFailure(
                    response,
                    connectionAlreadyCreated: true,
                    _timeProvider.GetUtcNow());
            Terminate(failure);
            throw failure;
        }
    }

    private SemaphoreSlim SelectSendGate(RbpEnvelope envelope)
    {
        if (envelope.Scope == RbpEnvelopeScope.Data)
        {
            if (string.IsNullOrEmpty(envelope.Rsid))
            {
                throw RbpHttpBindingProtocol.Protocol(
                    "Fallback session data requires rsid.");
            }

            return _sessionGates.GetOrAdd(
                envelope.Rsid,
                static _ => new SemaphoreSlim(1, 1));
        }

        return string.Equals(
                envelope.Type,
                "heartbeat",
                StringComparison.Ordinal)
            ? _heartbeatGate
            : _lifecycleGate;
    }

    private void EnsureActive()
    {
        lock (_lifetimeSync)
        {
            if (_lifetimeEndOwner == LifetimeEndOwner.Terminate &&
                _terminalFailure is { } terminal)
                throw terminal;
            if (_disposeRequested || _disposed || _closeTask is not null)
            {
                throw new ObjectDisposedException(
                    nameof(StreamableHttpRbpConnectionCycle));
            }
        }

    }

    private void Terminate(Exception exception)
    {
        ArgumentNullException.ThrowIfNull(exception);
        TaskCompletionSource? owner;
        Task quiescence;
        lock (_lifetimeSync)
        {
            _terminalFailure ??= exception;
            _ = PublishLifetimeEndUnderLock(
                LifetimeEndOwner.Terminate, out owner, out quiescence);
        }
        if (owner is not null)
            _ = CompleteLifetimeEndAsync(
                owner, CancellationToken.None, quiescence);
        else
            EndEventStream();
    }

    private TransportOperationLease AdmitOperation()
    {
        lock (_lifetimeSync)
        {
            if (_lifetimeEndOwner == LifetimeEndOwner.Terminate &&
                _terminalFailure is { } terminal)
                throw terminal;
            if (_disposed || _disposeRequested || _closeTask is not null)
                throw new ObjectDisposedException(
                    nameof(StreamableHttpRbpConnectionCycle));
            checked { _admittedOperations++; }
            return new TransportOperationLease(this);
        }
    }

    private void ReleaseOperation()
    {
        lock (_lifetimeSync)
        {
            if (_admittedOperations <= 0)
                throw new InvalidOperationException(
                    "The HTTP transport operation lease was released twice.");
            _admittedOperations--;
            if (_admittedOperations == 0)
                _operationsQuiesced?.TrySetResult();
        }
        TryFinalizeAfterOperation();
    }

    private void EndEventStream()
    {
        if (Interlocked.Exchange(ref _streamEnded, 1) != 0) return;
        _lifetime.Cancel();
        _eventsStream.Dispose();
        _eventsResponse.Dispose();
    }

    private void TryFinalizeAfterOperation()
    {
        bool finalize = false;
        lock (_lifetimeSync)
        {
            if (_disposeRequested && !_disposed &&
                _admittedOperations == 0 &&
                _closeTask?.IsCompleted == true)
            {
                _disposed = true;
                finalize = true;
            }
        }
        if (!finalize) return;
        _client.Dispose();
        _receiveGate.Dispose();
        _lifecycleGate.Dispose();
        _heartbeatGate.Dispose();
        foreach (SemaphoreSlim gate in _sessionGates.Values) gate.Dispose();
        _lifetime.Dispose();
    }

    internal string LifetimeEndReason
    {
        get
        {
            lock (_lifetimeSync) return _lifetimeEndOwner.ToString();
        }
    }

    private enum LifetimeEndOwner
    {
        Open,
        Terminate,
        Close,
        DirectDispose,
    }

    private sealed class TransportOperationLease(
        StreamableHttpRbpConnectionCycle owner) : IDisposable
    {
        private StreamableHttpRbpConnectionCycle? _owner = owner;
        public void Dispose() =>
            Interlocked.Exchange(ref _owner, null)?.ReleaseOperation();
    }

    private Exception TerminalOrRemoteClosed(
        Exception? innerException = null) =>
        Volatile.Read(ref _terminalFailure) ??
        new RbpGatewayTransportException(
            RbpGatewayFailureKind.RemoteClosed,
            "The fallback connection cycle ended.",
            innerException: innerException);

    private void ObserveSseReceive(
        string stage,
        string methodKind = "other",
        string outcome = "observed")
    {
        try
        {
            _onSseReceiveObservation?.Invoke(
                RbpSseReceiveObservation.Create(stage, methodKind, outcome));
        }
        catch
        {
            // Observation is never a transport owner.
        }
    }
}
