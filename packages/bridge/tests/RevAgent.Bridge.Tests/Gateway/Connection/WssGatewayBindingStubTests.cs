using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

[Collection(SocketIntegrationCollection.Name)]
public sealed class WssGatewayBindingStubTests
{
    [Fact]
    public async Task RealTlsStubAcceptsAuthenticatedHelloWithEmptyCapabilities()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        var binding = new WssGatewayBinding(
            new ExactCertificateSocketFactory(stub));
        var client = new RbpGatewayHandshakeClient(
            new FixedEnrollmentProvider(Credential("test-device-token")),
            binding);

        await using RbpGatewayHandshake handshake =
            await client.ConnectAsync(
                stub.WebSocketUri,
                Profile());

        Assert.Equal(1, handshake.Acknowledgement.Protocol);
        Assert.Empty(handshake.Acknowledgement.GrantedCapabilities);
        Assert.Equal(15_000, handshake.Acknowledgement
            .HeartbeatIntervalMilliseconds);
        Assert.Equal(
            RbpConnectionPhase.Steady,
            handshake.Lifecycle.Phase);
        Assert.Equal(
            WebSocketState.Open,
            handshake.Connection.State);
    }

    [Fact]
    public async Task PostHelloAuthorizationRefusalCarriesOnlyHelloCorrelation()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        const string syntheticDevice = "SYNTHETIC-REVOKED-DEVICE";
        var binding = new WssGatewayBinding(
            new ExactCertificateSocketFactory(stub));
        var client = new RbpGatewayHandshakeClient(
            new FixedEnrollmentProvider(
                new RbpDeviceCredential(
                    syntheticDevice,
                    "test-device-token",
                    $"sha256:{new string('0', 64)}")),
            binding);

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => client.ConnectAsync(stub.WebSocketUri, Profile()));

        Assert.Equal(RbpGatewayFailureKind.Authorization, exception.Kind);
        Assert.Equal(4403, exception.CloseCode);
        Assert.NotNull(exception.OpeningContext);
        Assert.Equal(
            RbpOpeningBinding.Wss,
            exception.OpeningContext.Binding);
        Assert.True(Guid.TryParse(exception.OpeningContext.CorrelationId, out _));
        Assert.DoesNotContain(
            syntheticDevice,
            exception.OpeningContext.CorrelationId,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task StubRejectsBadCredentialWithoutLeakingIt()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        const string rejectedToken = "wrong-token-must-not-appear";
        var binding = new WssGatewayBinding(
            new ExactCertificateSocketFactory(stub));

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => binding.ConnectAsync(
                    new RbpGatewayConnectRequest(
                        stub.WebSocketUri,
                        Credential(rejectedToken),
                        new[] { 1 })));

        Assert.Equal(
            RbpGatewayFailureKind.Authentication,
            exception.Kind);
        Assert.Equal(401, exception.StatusCode);
        Assert.DoesNotContain(
            rejectedToken,
            exception.ToString(),
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task StubUpgrade426IsVersionPaused()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        await stub.EnqueueOpeningFaultAsync(426);
        var binding = new WssGatewayBinding(
            new ExactCertificateSocketFactory(stub));

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => binding.ConnectAsync(
                    new RbpGatewayConnectRequest(
                        stub.WebSocketUri,
                        Credential("test-device-token"),
                        new[] { 1 })));

        Assert.Equal(RbpGatewayFailureKind.Version, exception.Kind);
        Assert.Equal(426, exception.StatusCode);
        Assert.True(exception.RetryPaused);
    }

    [Fact]
    public async Task Stub429IsRetryableAndCarriesBoundedRetryAfter()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        await stub.EnqueueOpeningFaultAsync(429, retryAfter: "7");
        var binding = new WssGatewayBinding(
            new ExactCertificateSocketFactory(stub));

        DateTimeOffset before = DateTimeOffset.UtcNow;
        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => binding.ConnectAsync(
                    new RbpGatewayConnectRequest(
                        stub.WebSocketUri,
                        Credential("test-device-token"),
                        new[] { 1 })));
        DateTimeOffset after = DateTimeOffset.UtcNow;

        Assert.Equal(RbpGatewayFailureKind.Network, exception.Kind);
        Assert.Equal(429, exception.StatusCode);
        Assert.Equal(
            RbpRetryAfterDisposition.Accepted,
            exception.RetryAfterDisposition);
        Assert.InRange(
            exception.RetryNotBeforeUtc!.Value,
            before.AddSeconds(7),
            after.AddSeconds(7));
        Assert.False(exception.RetryPaused);
    }

    [Theory]
    [InlineData(4400, (int)RbpGatewayFailureKind.Protocol)]
    [InlineData(4401, (int)RbpGatewayFailureKind.Authentication)]
    [InlineData(4403, (int)RbpGatewayFailureKind.Authorization)]
    [InlineData(4426, (int)RbpGatewayFailureKind.Version)]
    [InlineData(1002, (int)RbpGatewayFailureKind.Protocol)]
    [InlineData(1009, (int)RbpGatewayFailureKind.Protocol)]
    [InlineData(1000, (int)RbpGatewayFailureKind.RemoteClosed)]
    [InlineData(1011, (int)RbpGatewayFailureKind.RemoteClosed)]
    public void CloseCodesMapToFrozenRetryClasses(
        int closeCode,
        int expected)
    {
        Assert.Equal(
            (RbpGatewayFailureKind)expected,
            RbpGatewayConnection.ClassifyCloseCode(closeCode));
    }

    [Fact]
    public void VersionCloseReasonParsesOnlyTheFrozenShape()
    {
        RbpVersionWindow? window =
            RbpGatewayConnection.ParseVersionWindow(
                """
                {"min_protocol":2,"max_protocol":3,"manifest_url":"/bridge/update/manifest"}
                """);

        Assert.Equal(2, window!.MinimumProtocol);
        Assert.Equal(3, window.MaximumProtocol);
        Assert.Equal(
            "/bridge/update/manifest",
            window.ManifestUrl);
        Assert.Null(
            RbpGatewayConnection.ParseVersionWindow(
                """
                {
                  "min_protocol": 2,
                  "max_protocol": 3,
                  "manifest_url": "/bridge/update/manifest",
                  "extra": true
                }
                """));
        Assert.Null(
            RbpGatewayConnection.ParseVersionWindow(
                """
                {"min_protocol":2,"max_protocol":3,"manifest_url":"https://evil.invalid/manifest"}
                """));
    }

    [Theory]
    [InlineData("wss://127.0.0.1/bridge/v1")]
    [InlineData("wss://[::1]/bridge/v1")]
    [InlineData("wss://localhost./bridge/v1")]
    public async Task NonDnsEndpointIsRejectedBeforeOpening(
        string endpoint)
    {
        var binding = new WssGatewayBinding();

        ArgumentException exception =
            await Assert.ThrowsAsync<ArgumentException>(
                () => binding.ConnectAsync(
                    new RbpGatewayConnectRequest(
                        new Uri(endpoint),
                        Credential("test-device-token"),
                        new[] { 1 })));

        Assert.Contains("DNS", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RetryAfterParserRejectsAmbiguousAndOverlongValues()
    {
        DateTimeOffset now =
            new(2026, 7, 25, 12, 0, 0, TimeSpan.Zero);
        RbpRetryAfterDecision ambiguous =
            WssGatewayBinding.GetBoundedRetryAfter(
                new Dictionary<string, IEnumerable<string>>
                {
                    ["Retry-After"] = new[] { "7", "8" },
                },
                now);
        RbpRetryAfterDecision overlong =
            WssGatewayBinding.GetBoundedRetryAfter(
                new Dictionary<string, IEnumerable<string>>
                {
                    ["Retry-After"] = new[] { "901" },
                },
                now);

        Assert.Equal(
            RbpRetryAfterDisposition.IgnoredMalformed,
            ambiguous.Disposition);
        Assert.Equal(
            RbpRetryAfterDisposition.IgnoredOutOfRange,
            overlong.Disposition);
        Assert.Null(ambiguous.NotBeforeUtc);
        Assert.Null(overlong.NotBeforeUtc);
    }

    [Fact]
    public void PastRetryAfterDateBecomesImmediateNotBefore()
    {
        DateTimeOffset now =
            new(2026, 7, 25, 12, 0, 0, TimeSpan.Zero);
        RbpRetryAfterDecision decision =
            WssGatewayBinding.GetBoundedRetryAfter(
                new Dictionary<string, IEnumerable<string>>
                {
                    ["Retry-After"] = new[]
                    {
                        "Sat, 25 Jul 2026 11:59:00 GMT",
                    },
                },
                now);

        Assert.Equal(
            RbpRetryAfterDisposition.Accepted,
            decision.Disposition);
        Assert.Equal(now, decision.NotBeforeUtc);
    }

    [Theory]
    [InlineData(200)]
    [InlineData(302)]
    [InlineData(500)]
    public void UnexpectedHttpResponsesFailClosedAsProtocol(
        int statusCode)
    {
        Assert.Equal(
            RbpGatewayFailureKind.Protocol,
            WssGatewayBinding.ClassifyOpeningFailure(
                (HttpStatusCode)statusCode,
                trustFailure: false));
    }

    [Fact]
    public async Task SystemTrustRefusesTheSelfSignedStubCertificate()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        var binding = new WssGatewayBinding();

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => binding.ConnectAsync(
                    new RbpGatewayConnectRequest(
                        stub.WebSocketUri,
                        Credential("test-device-token"),
                        new[] { 1 })));

        Assert.Equal(RbpGatewayFailureKind.Trust, exception.Kind);
        Assert.True(exception.RetryPaused);
    }

    [Fact]
    public async Task CancelledCloseThenDisposeKeepsOneAbortReasonAndCloseOwner()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        var client = new RbpGatewayHandshakeClient(
            new FixedEnrollmentProvider(Credential("test-device-token")),
            new WssGatewayBinding(new ExactCertificateSocketFactory(stub)));
        RbpGatewayHandshake handshake =
            await client.ConnectAsync(stub.WebSocketUri, Profile());
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Task<byte[]> receive = handshake.Connection.ReceiveTextAsync();
        await Task.Delay(20);

        Task close = handshake.Connection.CloseAsync(cancelled.Token);
        Assert.Same(close, handshake.Connection.CloseAsync());
        Exception receiveFailure = Assert.IsAssignableFrom<Exception>(
            await Record.ExceptionAsync(() => receive));
        Assert.True(receiveFailure is OperationCanceledException or
            RbpGatewayTransportException);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => close);
        Exception reason = Assert.IsAssignableFrom<OperationCanceledException>(
            handshake.Connection.AbortReason);

        Task dispose = handshake.Connection.DisposeAsync().AsTask();
        Assert.Same(close, dispose);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => dispose);
        Assert.Same(reason, handshake.Connection.AbortReason);
        Assert.Same(close, handshake.Connection.CloseAsync());
    }

    [Fact]
    public async Task OperationProtocolAbortPublishesOwnerBeforeLaterClose()
    {
        await using RawBinaryWebSocketPeer peer =
            await RawBinaryWebSocketPeer.OpenAsync();
        RbpGatewayConnection connection = peer.Connection;

        Task<byte[]> receive = connection.ReceiveTextAsync();
        await peer.SendBinaryAsync(0x7f);
        RbpGatewayTransportException failure =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => receive.WaitAsync(TimeSpan.FromSeconds(2)));
        Task abortOwner = connection.CloseAsync();

        Assert.Equal(RbpGatewayFailureKind.Protocol, failure.Kind);
        Assert.Same(failure, connection.AbortReason);
        Assert.Same(abortOwner, connection.CloseAsync());
        await abortOwner.WaitAsync(TimeSpan.FromSeconds(2));
        Task dispose = connection.DisposeAsync().AsTask();
        Assert.Same(abortOwner, dispose);
        await dispose;
    }

    [Fact]
    public async Task DirectDisposeThenCloseNeverCreatesASecondAbortReason()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        var client = new RbpGatewayHandshakeClient(
            new FixedEnrollmentProvider(Credential("test-device-token")),
            new WssGatewayBinding(new ExactCertificateSocketFactory(stub)));
        await using RbpGatewayHandshake handshake =
            await client.ConnectAsync(stub.WebSocketUri, Profile());

        Task<byte[]> receive = handshake.Connection.ReceiveTextAsync();
        await Task.Delay(20);
        Task dispose = handshake.Connection.DisposeAsync().AsTask();
        Assert.Same(dispose, handshake.Connection.CloseAsync());
        Exception receiveFailure = Assert.IsAssignableFrom<Exception>(
            await Record.ExceptionAsync(() => receive));
        Assert.True(receiveFailure is OperationCanceledException or
            RbpGatewayTransportException);
        await dispose;
        Exception reason = Assert.IsType<ObjectDisposedException>(
            handshake.Connection.AbortReason);
        Assert.Same(dispose, handshake.Connection.DisposeAsync().AsTask());
        Assert.Same(dispose, handshake.Connection.CloseAsync());

        Assert.Same(reason, handshake.Connection.AbortReason);
    }

    private static RbpDeviceCredential Credential(string token) =>
        new(
            "device-01",
            token,
            $"sha256:{new string('0', 64)}");

    private static RbpHelloProfile Profile() =>
        new(
            "0.1.0-test",
            "fixture-host",
            "Windows test",
            Array.Empty<string>(),
            capabilities: Array.Empty<string>());

    private sealed class FixedEnrollmentProvider :
        IRbpEnrollmentStateProvider
    {
        private readonly RbpEnrollmentSnapshot _snapshot;

        internal FixedEnrollmentProvider(RbpDeviceCredential credential)
        {
            _snapshot = RbpEnrollmentSnapshot.Ready(credential);
        }

        public ValueTask<RbpEnrollmentSnapshot> ReadAsync(
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(_snapshot);
        }
    }

    private sealed class ExactCertificateSocketFactory :
        IRbpClientWebSocketFactory
    {
        private readonly GatewayStubProcess _stub;

        internal ExactCertificateSocketFactory(GatewayStubProcess stub)
        {
            _stub = stub;
        }

        public ClientWebSocket Create()
        {
            var socket = new ClientWebSocket();
            socket.Options.Proxy = new WebProxy();
            socket.Options.RemoteCertificateValidationCallback =
                (_, certificate, _, _) =>
                    _stub.TrustsExactCertificate(certificate);
            return socket;
        }
    }

    private sealed class RawBinaryWebSocketPeer : IAsyncDisposable
    {
        private readonly TcpClient _server;
        private readonly NetworkStream _stream;

        private RawBinaryWebSocketPeer(
            TcpClient server,
            NetworkStream stream,
            RbpGatewayConnection connection)
        {
            _server = server;
            _stream = stream;
            Connection = connection;
        }

        internal RbpGatewayConnection Connection { get; }

        internal static async Task<RawBinaryWebSocketPeer> OpenAsync()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            try
            {
                int port = ((IPEndPoint)listener.LocalEndpoint).Port;
                var socket = new ClientWebSocket();
                socket.Options.Proxy = new WebProxy();
                Task connect = socket.ConnectAsync(
                    new Uri($"ws://127.0.0.1:{port}/"),
                    CancellationToken.None);
                TcpClient server = await listener.AcceptTcpClientAsync()
                    .WaitAsync(TimeSpan.FromSeconds(2));
                NetworkStream stream = server.GetStream();
                string headers = await ReadHeadersAsync(stream);
                string key = headers.Split("\r\n", StringSplitOptions.None)
                    .Select(line => line.Split(':', 2))
                    .Where(parts => parts.Length == 2 && string.Equals(
                        parts[0], "Sec-WebSocket-Key",
                        StringComparison.OrdinalIgnoreCase))
                    .Select(parts => parts[1].Trim())
                    .Single();
                string accept = Convert.ToBase64String(SHA1.HashData(
                    Encoding.ASCII.GetBytes(
                        key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                byte[] response = Encoding.ASCII.GetBytes(
                    "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Upgrade: websocket\r\n" +
                    "Connection: Upgrade\r\n" +
                    $"Sec-WebSocket-Accept: {accept}\r\n\r\n");
                await stream.WriteAsync(response);
                await stream.FlushAsync();
                await connect.WaitAsync(TimeSpan.FromSeconds(2));
                return new RawBinaryWebSocketPeer(
                    server, stream, new RbpGatewayConnection(socket));
            }
            finally
            {
                listener.Stop();
            }
        }

        internal async Task SendBinaryAsync(byte value)
        {
            byte[] frame = [0x82, 0x01, value];
            await _stream.WriteAsync(frame);
            await _stream.FlushAsync();
        }

        private static async Task<string> ReadHeadersAsync(
            NetworkStream stream)
        {
            var bytes = new List<byte>();
            var buffer = new byte[1];
            while (bytes.Count < 16 * 1024)
            {
                int read = await stream.ReadAsync(buffer)
                    .AsTask()
                    .WaitAsync(TimeSpan.FromSeconds(2));
                if (read == 0) break;
                bytes.Add(buffer[0]);
                int count = bytes.Count;
                if (count >= 4 && bytes[count - 4] == '\r' &&
                    bytes[count - 3] == '\n' && bytes[count - 2] == '\r' &&
                    bytes[count - 1] == '\n')
                    return Encoding.ASCII.GetString(bytes.ToArray());
            }
            throw new InvalidDataException(
                "The scripted WebSocket handshake headers were incomplete.");
        }

        public async ValueTask DisposeAsync()
        {
            try { await Connection.DisposeAsync(); }
            catch { }
            _stream.Dispose();
            _server.Dispose();
        }
    }
}
