using System.Net;
using System.Text;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed class StreamableHttpRbpConnectionCycleTests
{
    private const string ConnectionId = "conn-test";

    [Fact]
    public async Task CreateAndEventsUseFrozenAuthenticatedLifecycle()
    {
        await using var harness = new HttpFallbackHarness();

        IRbpConnectionCycle cycle = await harness.OpenAsync();

        Assert.Equal(ConnectionId, cycle.Acknowledgement.ConnectionId);
        Assert.Contains(
            RbpTransportCapabilities.StreamableHttp,
            cycle.Acknowledgement.GrantedCapabilities);
        RecordedHttpRequest[] requests =
            harness.Handler.Requests.ToArray();
        Assert.Equal(2, requests.Length);
        RecordedHttpRequest create = requests[0];
        Assert.Equal(HttpMethod.Post, create.Method);
        Assert.Equal(
            "https://gateway.revagent.example/bridge/v1/http/connections",
            create.Uri.AbsoluteUri);
        Assert.Equal(HttpVersion.Version20, create.Version);
        Assert.Equal(
            HttpVersionPolicy.RequestVersionOrLower,
            create.VersionPolicy);
        Assert.Equal(
            new[] { "Bearer test-device-token" },
            create.Header("Authorization"));
        Assert.Equal(new[] { "1" }, create.Header("X-RBP-Versions"));
        Assert.Equal(
            new[] { "application/json" },
            create.Header("Content-Type"));
        RbpEnvelope hello = RbpEnvelopeCodec.Decode(create.Body);
        Assert.Equal("hello", hello.Type);
        Assert.Contains(
            RbpTransportCapabilities.StreamableHttp,
            hello.Hello!.Capabilities);

        RecordedHttpRequest events = requests[1];
        Assert.Equal(HttpMethod.Get, events.Method);
        Assert.Equal(
            "https://gateway.revagent.example/bridge/v1/http/" +
            "connections/conn-test/events",
            events.Uri.AbsoluteUri);
        Assert.Equal(
            new[] { "Bearer test-device-token" },
            events.Header("Authorization"));
        Assert.Equal(
            new[] { "text/event-stream" },
            events.Header("Accept"));
        Assert.Empty(events.Header("Last-Event-ID"));

        await cycle.DisposeAsync();
    }

    [Fact]
    public async Task SseUsesRbpPayloadAndIgnoresIdAuthority()
    {
        await using var harness = new HttpFallbackHarness();
        await using IRbpConnectionCycle cycle = await harness.OpenAsync();
        string inbound = InboundHeartbeatAckJson();
        harness.Events.WriteUtf8(
            ": proxy keepalive\r\n\r\n" +
            "id: deliberately-not-authority\r\n" +
            "event: rbp\r\n" +
            "data: " +
            inbound +
            "\r\n\r\n");

        RbpEnvelope envelope = await cycle.ReceiveAsync();

        Assert.Equal("heartbeat_ack", envelope.Type);
        Assert.Equal(RbpEnvelopeScope.Control, envelope.Scope);
    }

    [Fact]
    public async Task FragmentedMultiEventSseDeliversSessionRegisteredBeforeLaterFrames()
    {
        await using var harness = new HttpFallbackHarness();
        await using IRbpConnectionCycle cycle = await harness.OpenAsync();
        string registered = InboundSessionRegisteredJson();
        string heartbeat = InboundHeartbeatAckJson();
        const string Prefix = "event: rbp\r\ndata: ";
        int split = registered.Length / 2;

        // The real carrier sees arbitrary TLS/H1.1/H2 response chunks.  Do
        // not let a partial session_registered frame be mistaken for a
        // complete lifecycle event or bleed into the next SSE event.
        harness.Events.WriteUtf8(Prefix + registered[..split]);
        Task<RbpEnvelope> firstRead = cycle.ReceiveAsync();
        await Task.Delay(20);
        Assert.False(firstRead.IsCompleted);
        harness.Events.WriteUtf8(
            registered[split..] + "\r\n\r\n" +
            "event: rbp\n" +
            "data: " + heartbeat + "\n\n");

        RbpEnvelope registeredEnvelope = await firstRead.WaitAsync(
            TimeSpan.FromSeconds(2));
        RbpEnvelope heartbeatEnvelope = await cycle.ReceiveAsync()
            .WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal("session_registered", registeredEnvelope.Type);
        Assert.Equal("heartbeat_ack", heartbeatEnvelope.Type);
    }

    [Fact]
    public async Task UplinkUsesAuthenticatedJsonAndRequires202()
    {
        await using var harness = new HttpFallbackHarness();
        await using IRbpConnectionCycle cycle = await harness.OpenAsync();
        RbpEnvelope heartbeat = Heartbeat();

        await cycle.SendAsync(heartbeat);

        RecordedHttpRequest message =
            Assert.Single(harness.Handler.Requests.Skip(2));
        Assert.Equal(HttpMethod.Post, message.Method);
        Assert.Equal(
            "https://gateway.revagent.example/bridge/v1/http/" +
            "connections/conn-test/messages",
            message.Uri.AbsoluteUri);
        Assert.Equal(
            new[] { "Bearer test-device-token" },
            message.Header("Authorization"));
        Assert.Equal(
            new[] { "application/json" },
            message.Header("Content-Type"));
        RbpEnvelope sent = RbpEnvelopeCodec.Decode(message.Body);
        Assert.Equal(heartbeat.Type, sent.Type);
        Assert.Equal(heartbeat.Id, sent.Id);
        Assert.Equal(
            RbpEnvelopeCodec.Encode(heartbeat),
            RbpEnvelopeCodec.Encode(sent));
    }

    [Theory]
    [InlineData("event: wrong\ndata: {}\n\n")]
    [InlineData("event: rbp\ndata: {}\ndata: {}\n\n")]
    [InlineData("event: rbp\n\n")]
    public async Task MalformedSseEventEndsCycleAsProtocol(string value)
    {
        await using var harness = new HttpFallbackHarness();
        await using IRbpConnectionCycle cycle = await harness.OpenAsync();
        harness.Events.WriteUtf8(value);

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => cycle.ReceiveAsync());

        Assert.Equal(RbpGatewayFailureKind.Protocol, exception.Kind);
    }

    [Fact]
    public async Task InvalidSseUtf8EndsCycleAsProtocol()
    {
        await using var harness = new HttpFallbackHarness();
        await using IRbpConnectionCycle cycle = await harness.OpenAsync();
        harness.Events.WriteBytes(
            new byte[]
            {
                (byte)'e', (byte)'v', (byte)'e', (byte)'n', (byte)'t',
                (byte)':', (byte)' ', (byte)'r', (byte)'b', (byte)'p',
                (byte)'\n', (byte)'d', (byte)'a', (byte)'t', (byte)'a',
                (byte)':', (byte)' ', 0xC3, 0x28, (byte)'\n', (byte)'\n',
            });

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => cycle.ReceiveAsync());

        Assert.Equal(RbpGatewayFailureKind.Protocol, exception.Kind);
    }

    [Fact]
    public async Task SseEofEndsConnectionWithoutReplayAuthority()
    {
        await using var harness = new HttpFallbackHarness();
        await using IRbpConnectionCycle cycle = await harness.OpenAsync();
        harness.Events.Complete();

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => cycle.ReceiveAsync());

        Assert.Equal(
            RbpGatewayFailureKind.RemoteClosed,
            exception.Kind);
    }

    [Theory]
    [InlineData(404, (int)RbpGatewayFailureKind.RemoteClosed)]
    [InlineData(410, (int)RbpGatewayFailureKind.RemoteClosed)]
    [InlineData(401, (int)RbpGatewayFailureKind.Authentication)]
    [InlineData(403, (int)RbpGatewayFailureKind.Authorization)]
    [InlineData(426, (int)RbpGatewayFailureKind.Version)]
    [InlineData(503, (int)RbpGatewayFailureKind.Network)]
    [InlineData(200, (int)RbpGatewayFailureKind.Protocol)]
    public async Task UplinkStatusEndsWholeConnection(
        int status,
        int expectedKind)
    {
        await using var harness = new HttpFallbackHarness(
            messageStatus: (HttpStatusCode)status);
        await using IRbpConnectionCycle cycle = await harness.OpenAsync();

        RbpGatewayTransportException sendFailure =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => cycle.SendAsync(Heartbeat()));
        RbpGatewayTransportException receiveFailure =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => cycle.ReceiveAsync());

        Assert.Equal(
            (RbpGatewayFailureKind)expectedKind,
            sendFailure.Kind);
        Assert.Same(sendFailure, receiveFailure);
    }

    [Fact]
    public async Task UnknownUplinkAcceptanceEndsConnection()
    {
        await using var harness = new HttpFallbackHarness(
            throwMessageFailure: true);
        await using IRbpConnectionCycle cycle = await harness.OpenAsync();

        RbpGatewayTransportException sendFailure =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => cycle.SendAsync(Heartbeat()));
        RbpGatewayTransportException receiveFailure =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => cycle.ReceiveAsync());

        Assert.Equal(RbpGatewayFailureKind.Network, sendFailure.Kind);
        Assert.Contains(
            "acceptance is unknown",
            sendFailure.Message,
            StringComparison.Ordinal);
        Assert.Same(sendFailure, receiveFailure);
    }

    [Fact]
    public async Task SameSessionUplinksAreSerialized()
    {
        var firstEntered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        int messageCount = 0;
        await using var harness = new HttpFallbackHarness(
            async cancellationToken =>
            {
                if (Interlocked.Increment(ref messageCount) == 1)
                {
                    firstEntered.TrySetResult();
                    await releaseFirst.Task.WaitAsync(cancellationToken);
                }

                return new HttpResponseMessage(HttpStatusCode.Accepted);
            });
        await using IRbpConnectionCycle cycle = await harness.OpenAsync();

        Task first = cycle.SendAsync(Data("rs-1", sequence: 1));
        await firstEntered.Task;
        Task second = cycle.SendAsync(Data("rs-1", sequence: 2));
        await Task.Delay(30);

        Assert.Equal(1, Volatile.Read(ref messageCount));
        releaseFirst.TrySetResult();
        await Task.WhenAll(first, second);
        Assert.Equal(2, Volatile.Read(ref messageCount));
    }

    [Fact]
    public async Task DistinctSessionsAndHeartbeatUseIndependentStreams()
    {
        var allEntered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        int messageCount = 0;
        await using var harness = new HttpFallbackHarness(
            async cancellationToken =>
            {
                if (Interlocked.Increment(ref messageCount) == 3)
                {
                    allEntered.TrySetResult();
                }

                await release.Task.WaitAsync(cancellationToken);
                return new HttpResponseMessage(HttpStatusCode.Accepted);
            });
        await using IRbpConnectionCycle cycle = await harness.OpenAsync();

        Task first = cycle.SendAsync(Data("rs-1", sequence: 1));
        Task second = cycle.SendAsync(Data("rs-2", sequence: 1));
        Task heartbeat = cycle.SendAsync(Heartbeat());
        await allEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(3, Volatile.Read(ref messageCount));
        release.TrySetResult();
        await Task.WhenAll(first, second, heartbeat);
    }

    internal static RbpEnvelope Heartbeat() =>
        Decode(
            """
            {
              "v":1,
              "type":"heartbeat",
              "id":"019f9add-7a83-7d11-a6a9-d2f8108c0001",
              "ts":"2026-07-26T10:00:00.000Z",
              "payload":{
                "bridge_version":"0.1.0-test",
                "acks":[],
                "sessions":[]
              }
            }
            """);

    private static RbpEnvelope Data(string rsid, long sequence) =>
        Decode(
            $$"""
            {
              "v":1,
              "type":"doc_context_update",
              "id":"019f9add-7a83-7d11-a6a9-d2f8108c000{{sequence}}",
              "ts":"2026-07-26T10:00:00.000Z",
              "rsid":"{{rsid}}",
              "seq":{{sequence}},
              "payload":{"documents":[],"active_document":null,"active_view":null}
            }
            """);

    private static RbpEnvelope Decode(string json) =>
        RbpEnvelopeCodec.Decode(Encoding.UTF8.GetBytes(json));

    private static string InboundHeartbeatAckJson() =>
        """
        {"v":1,"type":"heartbeat_ack","id":"019f9add-7a83-7d11-a6a9-d2f8108c0099","ts":"2026-07-26T10:00:00.000Z","payload":{"server_time":"2026-07-26T10:00:00.000Z","acks":[]}}
        """;

    private static string InboundSessionRegisteredJson() =>
        """
        {"v":1,"type":"session_registered","id":"019f9add-7a83-7d11-a6a9-d2f8108c0098","ts":"2026-07-26T10:00:00.000Z","payload":{"rsid":"018f7f7e-1234-7abc-8def-1234567890ab","resume_token":"resume-test-token","resume_expires_at":"2026-07-27T10:00:00.000Z","principal":{"tenant_id":"tenant-test","user_id":"user-test"},"seat":{"granted":true,"seat_id":"seat-test"},"granted_session_capabilities":[]}}
        """;

    private sealed class HttpFallbackHarness : IAsyncDisposable
    {
        private readonly Func<
            CancellationToken,
            Task<HttpResponseMessage>>? _messageResponder;
        private readonly HttpStatusCode _messageStatus;
        private readonly bool _throwMessageFailure;

        internal HttpFallbackHarness(
            HttpStatusCode messageStatus = HttpStatusCode.Accepted,
            bool throwMessageFailure = false)
        {
            _messageStatus = messageStatus;
            _throwMessageFailure = throwMessageFailure;
            Handler = new ScriptedHttpMessageHandler(RespondAsync);
        }

        internal HttpFallbackHarness(
            Func<CancellationToken, Task<HttpResponseMessage>>
                messageResponder)
            : this()
        {
            _messageResponder = messageResponder;
        }

        internal PushSseStream Events { get; } = new();

        internal ScriptedHttpMessageHandler Handler { get; }

        internal async Task<IRbpConnectionCycle> OpenAsync()
        {
            var factory =
                new StreamableHttpRbpConnectionCycleFactory(
                    new FixedEnrollmentProvider(Credential()),
                    new[] { RbpTransportCapabilities.StreamableHttp },
                    new FixedHttpClientFactory(Handler));
            return await factory.OpenAsync(Endpoint(), Profile());
        }

        public ValueTask DisposeAsync()
        {
            Events.Dispose();
            Handler.Dispose();
            return ValueTask.CompletedTask;
        }

        private async Task<HttpResponseMessage> RespondAsync(
            RecordedHttpRequest request,
            CancellationToken cancellationToken)
        {
            string path = request.Uri.AbsolutePath;
            if (string.Equals(
                    path,
                    "/bridge/v1/http/connections",
                    StringComparison.Ordinal))
            {
                return StreamableHttpResponses.Created(
                    ConnectionId,
                    HelloAck(ConnectionId));
            }

            if (path.EndsWith(
                    "/events",
                    StringComparison.Ordinal))
            {
                return StreamableHttpResponses.Events(Events);
            }

            if (_throwMessageFailure)
            {
                throw new HttpRequestException(
                    HttpRequestError.ConnectionError,
                    "scripted reset");
            }

            if (_messageResponder is not null)
            {
                return await _messageResponder(cancellationToken);
            }

            return new HttpResponseMessage(_messageStatus);
        }
    }

    internal static byte[] HelloAck(
        string connectionId,
        bool grantFallback = true)
    {
        string capabilities = grantFallback
            ? "\"transport_streamable_http\""
            : string.Empty;
        return Encoding.UTF8.GetBytes(
            $$"""
            {
              "type":"hello_ack",
              "id":"019f9add-7a83-7d11-a6a9-d2f8108c0000",
              "ts":"2026-07-26T10:00:00.000Z",
              "payload":{
                "protocol":1,
                "connection_id":"{{connectionId}}",
                "granted_capabilities":[{{capabilities}}],
                "heartbeat_interval_ms":15000,
                "limits":{
                  "max_params_bytes":4194304,
                  "max_result_bytes":33554432,
                  "max_partial_bytes":1048576
                },
                "manifest":{
                  "latest_bridge_version":"0.1.0-test",
                  "manifest_url":"/bridge/update/manifest"
                }
              }
            }
            """);
    }

    internal static Uri Endpoint() =>
        new("https://gateway.revagent.example/bridge/v1");

    internal static RbpDeviceCredential Credential() =>
        new(
            "device-01",
            "test-device-token",
            $"sha256:{new string('0', 64)}");

    internal static RbpHelloProfile Profile() =>
        new(
            "0.1.0-test",
            "fixture-host",
            "Windows test",
            Array.Empty<string>(),
            new[] { RbpTransportCapabilities.StreamableHttp });
}
