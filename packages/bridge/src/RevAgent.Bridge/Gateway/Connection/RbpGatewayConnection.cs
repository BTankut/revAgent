using System.Buffers;
using System.Net.WebSockets;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed class RbpGatewayConnection : IAsyncDisposable
{
    private readonly ClientWebSocket _socket;
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private readonly SemaphoreSlim _receiveGate = new(1, 1);
    private readonly object _lifetimeSync = new();
    private Task? _closeTask;
    private TaskCompletionSource? _operationsQuiesced;
    private Exception? _abortReason;
    private int _admittedOperations;
    private bool _disposeRequested;
    private bool _disposed;

    internal RbpGatewayConnection(ClientWebSocket socket)
    {
        _socket = socket ?? throw new ArgumentNullException(nameof(socket));
        if (_socket.State != WebSocketState.Open)
        {
            throw new ArgumentException(
                "The RBP Gateway socket must already be open.",
                nameof(socket));
        }
    }

    internal WebSocketState State => _socket.State;

    internal async Task SendTextAsync(
        ReadOnlyMemory<byte> frame,
        CancellationToken cancellationToken = default)
    {
        if (frame.Length > RbpProtocolLimits.MaximumWireFrameBytes)
        {
            throw new RbpGatewayTransportException(
                RbpGatewayFailureKind.Protocol,
                "The outbound RBP frame exceeds the frozen wire limit.");
        }

        using TransportOperationLease admitted = AdmitOperation();
        await _sendGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            EnsureOpen();
            await _socket.SendAsync(
                    frame,
                    WebSocketMessageType.Text,
                    endOfMessage: true,
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
            when (exception is WebSocketException or IOException)
        {
            var failure = new RbpGatewayTransportException(
                RbpGatewayFailureKind.Network,
                "The RBP text frame could not be sent.",
                innerException: exception);
            AbortOnce(failure);
            throw failure;
        }
        finally
        {
            _sendGate.Release();
        }
    }

    internal async Task<byte[]> ReceiveTextAsync(
        CancellationToken cancellationToken = default)
    {
        using TransportOperationLease admitted = AdmitOperation();
        await _receiveGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        byte[]? rented = null;
        try
        {
            rented = ArrayPool<byte>.Shared.Rent(16 * 1024);
            EnsureOpen();
            using var stream = new MemoryStream();
            while (true)
            {
                ValueWebSocketReceiveResult result;
                try
                {
                    result = await _socket.ReceiveAsync(
                            rented.AsMemory(),
                            cancellationToken)
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                    when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception exception)
                    when (exception is WebSocketException or IOException)
                {
                    var failure = new RbpGatewayTransportException(
                        RbpGatewayFailureKind.Network,
                        "The RBP text frame could not be received.",
                        innerException: exception);
                    AbortOnce(failure);
                    throw failure;
                }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    throw CreateRemoteCloseException();
                }

                if (result.MessageType != WebSocketMessageType.Text)
                {
                    var failure = new RbpGatewayTransportException(
                        RbpGatewayFailureKind.Protocol,
                        "RBP accepts WebSocket text messages only.");
                    AbortOnce(failure);
                    throw failure;
                }

                if (stream.Length + result.Count >
                    RbpProtocolLimits.MaximumWireFrameBytes)
                {
                    var failure = new RbpGatewayTransportException(
                        RbpGatewayFailureKind.Protocol,
                        "The inbound RBP frame exceeds the frozen wire limit.");
                    AbortOnce(failure);
                    throw failure;
                }

                stream.Write(rented, 0, result.Count);
                if (result.EndOfMessage)
                {
                    return stream.ToArray();
                }
            }
        }
        finally
        {
            if (rented is not null)
            {
                ArrayPool<byte>.Shared.Return(rented);
            }

            _receiveGate.Release();
        }
    }

    internal Task CloseAsync(
        CancellationToken cancellationToken = default)
    {
        TaskCompletionSource? owner = null;
        Task quiescence = Task.CompletedTask;
        Task close;
        lock (_lifetimeSync)
        {
            if (_closeTask is not null) return _closeTask;
            if (_disposeRequested || _disposed)
                return Task.FromException(
                    new ObjectDisposedException(nameof(RbpGatewayConnection)));
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
            close = _closeTask;
        }
        _ = CompleteCloseAsync(owner!, cancellationToken, quiescence);
        return close;
    }

    private async Task CompleteCloseAsync(
        TaskCompletionSource owner,
        CancellationToken cancellationToken,
        Task quiescence)
    {
        try
        {
            await CloseCoreAsync(cancellationToken, quiescence)
                .ConfigureAwait(false);
            owner.TrySetResult();
        }
        catch (OperationCanceledException exception)
            when (cancellationToken.IsCancellationRequested)
        {
            AbortOnce(exception);
            try { await quiescence.ConfigureAwait(false); }
            catch { }
            owner.TrySetException(exception);
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

    private async Task CloseCoreAsync(
        CancellationToken cancellationToken,
        Task quiescence)
    {
        await _sendGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (Volatile.Read(ref _abortReason) is null &&
                _socket.State is
                WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try
                {
                    await _socket.CloseOutputAsync(
                            WebSocketCloseStatus.NormalClosure,
                            "bridge_shutdown",
                            cancellationToken)
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                    when (cancellationToken.IsCancellationRequested)
                {
                    AbortOnce(new OperationCanceledException(
                        "The retained WSS close was cancelled.",
                        cancellationToken));
                    throw;
                }
                catch (WebSocketException exception)
                {
                    AbortOnce(exception);
                }
                catch (IOException exception)
                {
                    AbortOnce(exception);
                }
            }
        }
        finally
        {
            _sendGate.Release();
        }
        // Do not hold the send gate while waiting for already-admitted sends:
        // one may have acquired its lease before Close but still be queued on
        // this gate. It must be able to observe the published close and settle.
        await quiescence.WaitAsync(cancellationToken).ConfigureAwait(false);
    }

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
                        "Direct WSS disposal has no retained lifetime owner."));
            _disposeRequested = true;
            if (_closeTask is null)
            {
                if (_admittedOperations != 0)
                {
                    _operationsQuiesced = new TaskCompletionSource(
                        TaskCreationOptions.RunContinuationsAsynchronously);
                    quiescence = _operationsQuiesced.Task;
                }
                owner = new TaskCompletionSource(
                    TaskCreationOptions.RunContinuationsAsynchronously);
                _closeTask = owner.Task;
            }
            ending = _closeTask;
        }
        if (owner is not null)
        {
            AbortOnce(new ObjectDisposedException(
                nameof(RbpGatewayConnection)));
            _ = CompleteDirectDisposeAsync(owner, quiescence);
        }
        TryFinalizeAfterOperation();
        return new ValueTask(ending);
    }

    private async Task CompleteDirectDisposeAsync(
        TaskCompletionSource owner,
        Task quiescence)
    {
        try
        {
            await quiescence.ConfigureAwait(false);
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

    private void EnsureOpen()
    {
        ObjectDisposedException.ThrowIf(
            _disposeRequested || _disposed || _closeTask is not null ||
            Volatile.Read(ref _abortReason) is not null,
            this);
        if (_socket.State != WebSocketState.Open)
        {
            throw CreateRemoteCloseException();
        }
    }

    private TransportOperationLease AdmitOperation()
    {
        lock (_lifetimeSync)
        {
            if (_disposed || _disposeRequested || _closeTask is not null ||
                Volatile.Read(ref _abortReason) is not null)
                throw new ObjectDisposedException(nameof(RbpGatewayConnection));
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
                    "The WSS transport operation lease was released twice.");
            _admittedOperations--;
            if (_admittedOperations == 0)
                _operationsQuiesced?.TrySetResult();
        }
        TryFinalizeAfterOperation();
    }

    private void TryFinalizeAfterOperation()
    {
        bool finalize = false;
        lock (_lifetimeSync)
        {
            bool closeSettled = _closeTask?.IsCompleted == true;
            if (_disposeRequested && !_disposed &&
                _admittedOperations == 0 &&
                closeSettled)
            {
                _disposed = true;
                finalize = true;
            }
        }
        if (!finalize) return;
        _socket.Dispose();
        _sendGate.Dispose();
        _receiveGate.Dispose();
    }

    private void AbortOnce(Exception reason)
    {
        ArgumentNullException.ThrowIfNull(reason);
        TaskCompletionSource? owner = null;
        Task quiescence = Task.CompletedTask;
        lock (_lifetimeSync)
        {
            if (_abortReason is not null) return;
            Volatile.Write(ref _abortReason, reason);
            if (_closeTask is null)
            {
                if (_admittedOperations != 0)
                {
                    _operationsQuiesced = new TaskCompletionSource(
                        TaskCreationOptions.RunContinuationsAsynchronously);
                    quiescence = _operationsQuiesced.Task;
                }
                owner = new TaskCompletionSource(
                    TaskCreationOptions.RunContinuationsAsynchronously);
                _closeTask = owner.Task;
            }
        }
        try { _socket.Abort(); }
        catch
        {
            // The first abort reason remains authoritative. Physical Abort is
            // best effort and never creates a second lifecycle owner.
        }
        if (owner is not null)
            _ = CompleteAbortOwnerAsync(owner, quiescence);
    }

    private async Task CompleteAbortOwnerAsync(
        TaskCompletionSource owner,
        Task quiescence)
    {
        try
        {
            await quiescence.ConfigureAwait(false);
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

    internal Exception? AbortReason => Volatile.Read(ref _abortReason);

    private sealed class TransportOperationLease(
        RbpGatewayConnection owner) : IDisposable
    {
        private RbpGatewayConnection? _owner = owner;
        public void Dispose() =>
            Interlocked.Exchange(ref _owner, null)?.ReleaseOperation();
    }

    internal static RbpGatewayFailureKind ClassifyCloseCode(
        int? closeCode) =>
        closeCode switch
        {
            4401 => RbpGatewayFailureKind.Authentication,
            4403 => RbpGatewayFailureKind.Authorization,
            4426 => RbpGatewayFailureKind.Version,
            4400 => RbpGatewayFailureKind.Protocol,
            1002 or 1003 or 1007 or 1008 or 1009 or 1010 =>
                RbpGatewayFailureKind.Protocol,
            _ => RbpGatewayFailureKind.RemoteClosed,
        };

    internal static RbpVersionWindow? ParseVersionWindow(
        string? closeReason)
    {
        if (string.IsNullOrWhiteSpace(closeReason))
        {
            return null;
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(
                closeReason,
                new JsonDocumentOptions
                {
                    AllowTrailingCommas = false,
                    CommentHandling = JsonCommentHandling.Disallow,
                    MaxDepth = 4,
                });
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in root.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    return null;
                }
            }

            if (!names.SetEquals(
                    new[]
                    {
                        "min_protocol",
                        "max_protocol",
                        "manifest_url",
                    }) ||
                !root.GetProperty("min_protocol").TryGetInt32(
                    out int minimumProtocol) ||
                !root.GetProperty("max_protocol").TryGetInt32(
                    out int maximumProtocol) ||
                minimumProtocol < 1 ||
                maximumProtocol < minimumProtocol ||
                root.GetProperty("manifest_url").ValueKind !=
                    JsonValueKind.String)
            {
                return null;
            }

            string? manifestUrl =
                root.GetProperty("manifest_url").GetString();
            if (!string.Equals(
                    manifestUrl,
                    "/bridge/update/manifest",
                    StringComparison.Ordinal))
            {
                return null;
            }

            return new RbpVersionWindow(
                minimumProtocol,
                maximumProtocol,
                "/bridge/update/manifest");
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private RbpGatewayTransportException CreateRemoteCloseException()
    {
        int? closeCode = (int?)_socket.CloseStatus;
        return new RbpGatewayTransportException(
            ClassifyCloseCode(closeCode),
            "The Gateway closed the RBP connection.",
            closeCode: closeCode,
            versionWindow: closeCode == 4426
                ? ParseVersionWindow(_socket.CloseStatusDescription)
                : null);
    }
}
