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
    private Exception? _terminalFailure;
    private int _closeStarted;
    private int _disposeStarted;

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
        EnsureActive();
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
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (Interlocked.Exchange(ref _closeStarted, 1) == 0)
        {
            _lifetime.Cancel();
            _eventsStream.Dispose();
            _eventsResponse.Dispose();
        }

        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposeStarted, 1) != 0)
        {
            return ValueTask.CompletedTask;
        }

        _ = CloseAsync();
        _client.Dispose();
        // Coordinator disposal is deliberately bounded before its owned
        // receive/send tasks join. Keep this managed CTS alive so their linked
        // registrations can unwind without racing ObjectDisposedException.
        return ValueTask.CompletedTask;
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
        if (Volatile.Read(ref _disposeStarted) != 0)
        {
            throw new ObjectDisposedException(
                nameof(StreamableHttpRbpConnectionCycle));
        }

        if (Volatile.Read(ref _terminalFailure) is { } terminal)
        {
            throw terminal;
        }

        if (Volatile.Read(ref _closeStarted) != 0)
        {
            throw new RbpGatewayTransportException(
                RbpGatewayFailureKind.RemoteClosed,
                "The fallback connection cycle is closed.");
        }
    }

    private void Terminate(Exception exception)
    {
        if (Interlocked.CompareExchange(
                ref _terminalFailure,
                exception,
                comparand: null) is not null)
        {
            return;
        }

        _lifetime.Cancel();
        _eventsStream.Dispose();
        _eventsResponse.Dispose();
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
