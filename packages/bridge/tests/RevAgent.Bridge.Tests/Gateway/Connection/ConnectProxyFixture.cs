using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using RevAgent.Bridge.Gateway.Connection;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

internal sealed class ConnectProxyFixture : IAsyncDisposable
{
    private readonly TcpListener _listener;
    private readonly int _targetPort;
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentBag<Task> _connections = new();
    private readonly Task _acceptLoop;
    private int _disposed;

    internal ConnectProxyFixture(int targetPort)
    {
        _targetPort = targetPort;
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        int port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        Uri = new Uri($"http://127.0.0.1:{port}");
        _acceptLoop = AcceptAsync();
    }

    internal Uri Uri { get; }

    internal ConcurrentQueue<string> ConnectAuthorities { get; } = new();

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _stop.Cancel();
        _listener.Stop();
        await IgnoreExpectedAsync(_acceptLoop).ConfigureAwait(false);
        Task[] connections = _connections.ToArray();
        if (connections.Length != 0)
        {
            Task all = Task.WhenAll(connections);
            Task completed = await Task.WhenAny(
                    all,
                    Task.Delay(TimeSpan.FromSeconds(5)))
                .ConfigureAwait(false);
            if (ReferenceEquals(completed, all))
            {
                await IgnoreExpectedAsync(all).ConfigureAwait(false);
            }
        }

        _stop.Dispose();
    }

    private async Task AcceptAsync()
    {
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                TcpClient client = await _listener.AcceptTcpClientAsync(
                        _stop.Token)
                    .ConfigureAwait(false);
                Task connection = HandleAsync(client);
                _connections.Add(connection);
            }
        }
        catch (OperationCanceledException)
            when (_stop.IsCancellationRequested)
        {
        }
        catch (SocketException)
            when (_stop.IsCancellationRequested)
        {
        }
    }

    private async Task HandleAsync(TcpClient downstreamClient)
    {
        using (downstreamClient)
        using (var upstreamClient = new TcpClient())
        {
            NetworkStream downstream = downstreamClient.GetStream();
            string headers =
                await ReadHeadersAsync(downstream, _stop.Token)
                    .ConfigureAwait(false);
            string firstLine = headers.Split(
                new[] { "\r\n" },
                2,
                StringSplitOptions.None)[0];
            string[] parts = firstLine.Split(' ');
            if (parts.Length != 3 ||
                !string.Equals(
                    parts[0],
                    "CONNECT",
                    StringComparison.Ordinal) ||
                !string.Equals(
                    parts[2],
                    "HTTP/1.1",
                    StringComparison.Ordinal))
            {
                return;
            }

            ConnectAuthorities.Enqueue(parts[1]);
            await upstreamClient.ConnectAsync(
                    IPAddress.Loopback,
                    _targetPort,
                    _stop.Token)
                .ConfigureAwait(false);
            NetworkStream upstream = upstreamClient.GetStream();
            await downstream.WriteAsync(
                    "HTTP/1.1 200 Connection Established\r\n\r\n"u8
                        .ToArray(),
                    _stop.Token)
                .ConfigureAwait(false);
            await downstream.FlushAsync(_stop.Token)
                .ConfigureAwait(false);

            using var relayStop =
                CancellationTokenSource.CreateLinkedTokenSource(
                    _stop.Token);
            Task downstreamToUpstream = downstream.CopyToAsync(
                upstream,
                relayStop.Token);
            Task upstreamToDownstream = upstream.CopyToAsync(
                downstream,
                relayStop.Token);
            await Task.WhenAny(
                    downstreamToUpstream,
                    upstreamToDownstream)
                .ConfigureAwait(false);
            relayStop.Cancel();
            await IgnoreExpectedAsync(
                    Task.WhenAll(
                        downstreamToUpstream,
                        upstreamToDownstream))
                .ConfigureAwait(false);
        }
    }

    private static async Task<string> ReadHeadersAsync(
        Stream stream,
        CancellationToken cancellationToken)
    {
        const int maximumHeaderBytes = 16 * 1024;
        using var bytes = new MemoryStream();
        int matched = 0;
        byte[] terminator = "\r\n\r\n"u8.ToArray();
        var one = new byte[1];
        while (bytes.Length < maximumHeaderBytes)
        {
            int read = await stream.ReadAsync(
                    one.AsMemory(),
                    cancellationToken)
                .ConfigureAwait(false);
            if (read == 0)
            {
                throw new IOException(
                    "The proxy client closed before CONNECT headers.");
            }

            bytes.WriteByte(one[0]);
            if (one[0] == terminator[matched])
            {
                matched++;
                if (matched == terminator.Length)
                {
                    return Encoding.ASCII.GetString(bytes.ToArray());
                }
            }
            else
            {
                matched = one[0] == terminator[0] ? 1 : 0;
            }
        }

        throw new IOException("The CONNECT headers exceeded the test limit.");
    }

    private static async Task IgnoreExpectedAsync(Task task)
    {
        try
        {
            await task.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (IOException)
        {
        }
        catch (SocketException)
        {
        }
        catch (ObjectDisposedException)
        {
        }
    }
}

internal sealed class ExactGatewayCertificateHttpClientFactory :
    IRbpHttpClientFactory
{
    private readonly StreamableHttpGatewayStubProcess _stub;
    private readonly IWebProxy _proxy;

    internal ExactGatewayCertificateHttpClientFactory(
        StreamableHttpGatewayStubProcess stub,
        IWebProxy proxy)
    {
        _stub = stub;
        _proxy = proxy;
    }

    public HttpClient Create()
    {
        var handler = new HttpClientHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
            Proxy = _proxy,
            ServerCertificateCustomValidationCallback =
                (_, certificate, _, _) =>
                    _stub.TrustsExactCertificate(certificate),
            UseCookies = false,
            UseProxy = true,
        };
        return new HttpClient(handler, disposeHandler: true)
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
    }
}
