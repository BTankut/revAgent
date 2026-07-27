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
    private int _disposeStarted;
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
            throw new RbpGatewayTransportException(
                RbpGatewayFailureKind.Network,
                "The RBP text frame could not be sent.",
                innerException: exception);
        }
        finally
        {
            _sendGate.Release();
        }
    }

    internal async Task<byte[]> ReceiveTextAsync(
        CancellationToken cancellationToken = default)
    {
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
                    throw new RbpGatewayTransportException(
                        RbpGatewayFailureKind.Network,
                        "The RBP text frame could not be received.",
                        innerException: exception);
                }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    throw CreateRemoteCloseException();
                }

                if (result.MessageType != WebSocketMessageType.Text)
                {
                    _socket.Abort();
                    throw new RbpGatewayTransportException(
                        RbpGatewayFailureKind.Protocol,
                        "RBP accepts WebSocket text messages only.");
                }

                if (stream.Length + result.Count >
                    RbpProtocolLimits.MaximumWireFrameBytes)
                {
                    _socket.Abort();
                    throw new RbpGatewayTransportException(
                        RbpGatewayFailureKind.Protocol,
                        "The inbound RBP frame exceeds the frozen wire limit.");
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

    internal async Task CloseAsync(
        CancellationToken cancellationToken = default)
    {
        if (_disposed ||
            _socket.State is WebSocketState.Closed or WebSocketState.Aborted)
        {
            return;
        }

        await _sendGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_socket.State is
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
                    _socket.Abort();
                    throw;
                }
                catch (WebSocketException)
                {
                    _socket.Abort();
                }
                catch (IOException)
                {
                    _socket.Abort();
                }
            }
        }
        finally
        {
            _sendGate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposeStarted, 1) != 0)
        {
            return;
        }

        try
        {
            using var timeout = new CancellationTokenSource(
                TimeSpan.FromSeconds(2));
            try
            {
                await CloseAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
                when (timeout.IsCancellationRequested)
            {
                _socket.Abort();
            }
        }
        finally
        {
            _disposed = true;
            _socket.Dispose();
        }
    }

    private void EnsureOpen()
    {
        ObjectDisposedException.ThrowIf(
            Volatile.Read(ref _disposeStarted) != 0 || _disposed,
            this);
        if (_socket.State != WebSocketState.Open)
        {
            throw CreateRemoteCloseException();
        }
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
