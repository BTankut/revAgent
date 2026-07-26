using System.Net;
using System.Net.Sockets;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.Tests.AddinLoopback;

internal sealed class ScriptedTcpPeer : IAsyncDisposable
{
    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Task _serverTask;
    private readonly object _primaryClientGate = new();
    private TcpClient? _primaryClient;
    private int _acceptCount;

    internal ScriptedTcpPeer(
        Func<NetworkStream, CancellationToken, Task> script)
    {
        ArgumentNullException.ThrowIfNull(script);

        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _serverTask = RunAsync(script);
    }

    internal int Port { get; }

    internal int AcceptCount => Volatile.Read(ref _acceptCount);

    public async ValueTask DisposeAsync()
    {
        _shutdown.Cancel();
        _listener.Stop();
        ClosePrimaryClient();

        try
        {
            await _serverTask.WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally
        {
            if (_serverTask.IsCompleted)
            {
                _shutdown.Dispose();
            }
        }
    }

    internal static async Task<JObject> ReadRequestAsync(
        NetworkStream stream,
        CancellationToken cancellationToken)
    {
        var payload = await ReadFrameAsync(
            stream,
            AddinFrameLimits.AbsoluteMaxRequestPayloadBytes,
            cancellationToken);
        var request = AddinJsonRpcCodec.ParseRequest(payload);
        return new JObject
        {
            ["id"] = request.Id,
            ["method"] = request.Method,
            ["params"] = request.Params,
        };
    }

    internal static byte[] SuccessFrame(string id, JObject? result = null)
    {
        var resultObject = result is null
            ? new JObject()
            : (JObject)result.DeepClone();
        resultObject["resultContractVersion"] = AddinJsonRpcCodec.ResultContractVersion;

        var response = new JObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["result"] = resultObject,
        };
        var payload = System.Text.Encoding.UTF8.GetBytes(
            response.ToString(Formatting.None));
        return LengthPrefixedFrameCodec.EncodePayload(
            payload,
            AddinFrameLimits.MaxResponsePayloadBytes);
    }

    internal static async Task WriteChunksAsync(
        NetworkStream stream,
        byte[] bytes,
        IReadOnlyList<int> chunkSizes,
        CancellationToken cancellationToken)
    {
        var offset = 0;
        foreach (var requestedSize in chunkSizes)
        {
            if (offset >= bytes.Length)
            {
                break;
            }

            var count = Math.Min(requestedSize, bytes.Length - offset);
            await stream.WriteAsync(
                bytes.AsMemory(offset, count),
                cancellationToken);
            offset += count;
            await Task.Delay(TimeSpan.FromMilliseconds(5), cancellationToken);
        }

        if (offset < bytes.Length)
        {
            await stream.WriteAsync(bytes.AsMemory(offset), cancellationToken);
        }
    }

    private async Task RunAsync(
        Func<NetworkStream, CancellationToken, Task> script)
    {
        Task? primaryConnection = null;
        try
        {
            while (true)
            {
                var client = await _listener.AcceptTcpClientAsync(_shutdown.Token);
                var connectionNumber = Interlocked.Increment(ref _acceptCount);
                if (connectionNumber == 1)
                {
                    primaryConnection = RunPrimaryConnectionAsync(client, script);
                }
                else
                {
                    client.Dispose();
                }
            }
        }
        catch (Exception exception) when (
            _shutdown.IsCancellationRequested &&
            exception is OperationCanceledException or
                SocketException or
                ObjectDisposedException)
        {
        }
        finally
        {
            if (primaryConnection is not null)
            {
                await primaryConnection;
            }
        }
    }

    private async Task RunPrimaryConnectionAsync(
        TcpClient client,
        Func<NetworkStream, CancellationToken, Task> script)
    {
        using (client)
        {
            client.NoDelay = true;
            using var stream = client.GetStream();

            lock (_primaryClientGate)
            {
                if (_shutdown.IsCancellationRequested)
                {
                    return;
                }

                _primaryClient = client;
            }

            try
            {
                await script(stream, _shutdown.Token);
            }
            catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
            {
            }
            catch (SocketException) when (_shutdown.IsCancellationRequested)
            {
            }
            finally
            {
                lock (_primaryClientGate)
                {
                    if (ReferenceEquals(_primaryClient, client))
                    {
                        _primaryClient = null;
                    }
                }
            }
        }
    }

    private void ClosePrimaryClient()
    {
        lock (_primaryClientGate)
        {
            _primaryClient?.Dispose();
            _primaryClient = null;
        }
    }

    private static async Task<byte[]> ReadFrameAsync(
        NetworkStream stream,
        int maxPayloadBytes,
        CancellationToken cancellationToken)
    {
        var header = new byte[AddinFrameLimits.HeaderBytes];
        await ReadExactlyAsync(stream, header, cancellationToken);

        var payloadLength = LengthPrefixedFrameCodec.ReadPayloadLength(header, 0);
        if (payloadLength > maxPayloadBytes)
        {
            throw new InvalidOperationException(
                "The scripted peer received an oversized request.");
        }

        var payload = new byte[(int)payloadLength];
        await ReadExactlyAsync(stream, payload, cancellationToken);
        return payload;
    }

    private static async Task ReadExactlyAsync(
        NetworkStream stream,
        byte[] destination,
        CancellationToken cancellationToken)
    {
        for (var offset = 0; offset < destination.Length;)
        {
            var bytesRead = await stream.ReadAsync(
                destination.AsMemory(offset),
                cancellationToken);
            if (bytesRead == 0)
            {
                throw new IOException("Peer connection closed before a frame completed.");
            }

            offset += bytesRead;
        }
    }
}
