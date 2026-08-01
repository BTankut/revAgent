using System.Collections.Concurrent;
using System.Net;
using System.Text;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed partial class RbpConnectionCoordinatorTests
{
    /// <summary>
    /// The 03-bridge-addin-installer transport-parity requirement: the same
    /// journal/resume fixture must yield the same replay identity over the
    /// Streamable HTTP/SSE binding, across a forced SSE EOF and reconnect,
    /// as it does over WSS (O1 conformance case 36).
    /// </summary>
    [Fact]
    public async Task HttpFallbackReconnectUsesSameJournalReplayIdentity()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot local = LocalSession(8080, 1000);
        await store.PersistRegisteredSessionAsync(
            Registration(local, "rs-8080"));
        RbpQueueOutboundResult queued =
            await store.QueueOutboundDataAsync(
                "rs-8080",
                new RbpOutboundDataDraft(
                    "doc_context_update",
                    Id(301),
                    Json(
                        """
                        {"documents":[],"active_document":null,"active_view":null}
                        """),
                    Timestamp: clock.UtcNow.ToString("O")));
        var responder = new ScriptedGatewayResponder(clock);
        var first = new CoordinatorHttpHandler(
            "conn-http-1",
            responder);
        var second = new CoordinatorHttpHandler(
            "conn-http-2",
            responder);
        var clients =
            new CoordinatorHttpClientFactory(first, second);
        var cycleFactory =
            new StreamableHttpRbpConnectionCycleFactory(
                new FixedEnrollmentProvider(
                    StreamableHttpRbpConnectionCycleTests.Credential()),
                new[] { RbpTransportCapabilities.StreamableHttp },
                clients);
        var coordinator = new RbpConnectionCoordinator(
            cycleFactory,
            store,
            new MutableSessionCatalog(local),
            new RbpConnectionCoordinatorOptions(
                StreamableHttpRbpConnectionCycleTests.Endpoint(),
                StreamableHttpRbpConnectionCycleTests.Profile()),
            new StubInvocationDispatcher(),
            inboundJournal: null,
            clock,
            new FixedRandomSource(0));
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => first.Sent.Any(
                item => item.Scope == RbpEnvelopeScope.Data));
        RbpEnvelope firstReplay = Assert.Single(
            first.Sent,
            item => item.Scope == RbpEnvelopeScope.Data);

        first.Events.Complete();
        await EventuallyAsync(() => clients.CreateCount == 2);
        await EventuallyAsync(
            () => second.Sent.Any(
                item => item.Scope == RbpEnvelopeScope.Data));
        RbpEnvelope secondReplay = Assert.Single(
            second.Sent,
            item => item.Scope == RbpEnvelopeScope.Data);

        Assert.Equal(queued.Envelope!.Id, firstReplay.Id);
        Assert.Equal(firstReplay.Id, secondReplay.Id);
        Assert.Equal(firstReplay.Sequence, secondReplay.Sequence);
        Assert.Equal(
            firstReplay.Payload.GetRawText(),
            secondReplay.Payload.GetRawText());
        Assert.Equal(
            2,
            coordinator.GetSnapshot().ConnectionGeneration);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    private sealed class CoordinatorHttpClientFactory :
        IRbpHttpClientFactory
    {
        private readonly object _sync = new();
        private readonly Queue<CoordinatorHttpHandler> _handlers;
        private int _createCount;

        internal CoordinatorHttpClientFactory(
            params CoordinatorHttpHandler[] handlers)
        {
            _handlers = new Queue<CoordinatorHttpHandler>(handlers);
        }

        internal int CreateCount => Volatile.Read(ref _createCount);

        public HttpClient Create()
        {
            lock (_sync)
            {
                if (_handlers.Count == 0)
                {
                    throw new InvalidOperationException(
                        "No scripted HTTP connection remains.");
                }

                Interlocked.Increment(ref _createCount);
                return new HttpClient(
                    _handlers.Dequeue(),
                    disposeHandler: false)
                {
                    Timeout = Timeout.InfiniteTimeSpan,
                };
            }
        }
    }

    private sealed class CoordinatorHttpHandler : HttpMessageHandler
    {
        private readonly string _connectionId;
        private readonly ScriptedGatewayResponder _responder;

        internal CoordinatorHttpHandler(
            string connectionId,
            ScriptedGatewayResponder responder)
        {
            _connectionId = connectionId;
            _responder = responder;
        }

        internal PushSseStream Events { get; } = new();

        internal ConcurrentQueue<RbpEnvelope> Sent { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            string path = request.RequestUri?.AbsolutePath ??
                throw new InvalidOperationException("HTTP URI is absent.");
            if (string.Equals(
                    path,
                    "/bridge/v1/http/connections",
                    StringComparison.Ordinal))
            {
                return StreamableHttpResponses.Created(
                    _connectionId,
                    StreamableHttpRbpConnectionCycleTests.HelloAck(
                        _connectionId));
            }

            if (path.EndsWith("/events", StringComparison.Ordinal))
            {
                return StreamableHttpResponses.Events(Events);
            }

            byte[] frame = await (
                    request.Content ??
                    throw new InvalidOperationException(
                        "HTTP message body is absent."))
                .ReadAsByteArrayAsync(cancellationToken);
            RbpEnvelope envelope = RbpEnvelopeCodec.Decode(frame);
            Sent.Enqueue(envelope);
            RbpEnvelope? response = _responder.Respond(envelope);
            if (response is not null)
            {
                Events.WriteUtf8(
                    "event: rbp\n" +
                    "data: " +
                    Encoding.UTF8.GetString(
                        RbpEnvelopeCodec.Encode(response)) +
                    "\n\n");
            }

            return new HttpResponseMessage(HttpStatusCode.Accepted);
        }
    }
}
