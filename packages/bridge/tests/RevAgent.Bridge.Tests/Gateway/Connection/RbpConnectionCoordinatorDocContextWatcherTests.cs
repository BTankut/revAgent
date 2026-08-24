using System.Collections.Concurrent;
using System.Reflection;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Protocol;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed partial class RbpConnectionCoordinatorTests
{
    [Fact]
    public void DocumentContextDigestVectorsMatchPinnedRfc8785Canonicalization()
    {
        using JsonDocument fixture = LoadDocumentContextDigestFixture();
        int count = 0;
        foreach (JsonElement vector in fixture.RootElement
                     .GetProperty("accepted")
                     .EnumerateArray())
        {
            JsonElement payload = vector.GetProperty("payload");
            string digest = RbpDocumentContextObservation.MakeContextDigest(
                payload);

            Assert.Equal(
                vector.GetProperty("canonical").GetString(),
                Rfc8785Json.Canonicalize(payload));
            Assert.Equal(
                vector.GetProperty("contextDigest").GetString(),
                digest);
            Assert.Matches("^[0-9a-f]{64}$", digest);
            Assert.NotEqual(
                vector.GetProperty("wrongDomainDigest").GetString(),
                digest);
            count++;
        }

        Assert.Equal(4, count);
    }

    [Fact]
    public void DocumentContextDigestRejectionsOmitTheDiagnosticObservation()
    {
        using JsonDocument fixture = LoadDocumentContextDigestFixture();
        int count = 0;
        foreach (JsonElement vector in fixture.RootElement
                     .GetProperty("rejected")
                     .EnumerateArray())
        {
            string raw = vector.GetProperty("raw").GetString() ??
                         throw new InvalidDataException(
                             "Digest rejection vector is missing raw JSON.");
            try
            {
                using JsonDocument payload = JsonDocument.Parse(raw);
                Assert.False(RbpDocumentContextObservation.TryCreate(
                    "snapshot",
                    "ready",
                    "rs-sensitive",
                    payload.RootElement,
                    sequence: 1,
                    out RbpDocumentContextObservation? observation));
                Assert.Null(observation);
            }
            catch (JsonException)
            {
                // Malformed JSON cannot produce a JsonElement, therefore it
                // cannot produce a document-context diagnostic observation.
            }

            count++;
        }

        Assert.Equal(3, count);
    }

    [Fact]
    public void DocumentContextDigestIsStableButObservationsRemainDistinctAndValueFree()
    {
        const string sensitiveTitle = "Confidential MEP Model";
        const string sensitiveDocumentId = "doc-secret-017";
        using JsonDocument payload = JsonDocument.Parse(
            $$"""
              {
                "title":"{{sensitiveTitle}}",
                "document_id":"{{sensitiveDocumentId}}",
                "revision":7
              }
              """);

        Assert.True(RbpDocumentContextObservation.TryCreate(
            "snapshot",
            "ready",
            "rs-sensitive",
            payload.RootElement,
            sequence: 7,
            out RbpDocumentContextObservation? first));
        Assert.True(RbpDocumentContextObservation.TryCreate(
            "queue",
            "not_queued",
            "rs-sensitive",
            payload.RootElement,
            sequence: 8,
            out RbpDocumentContextObservation? second));

        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.Equal(first.ContextDigest, second.ContextDigest);
        Assert.NotEqual(first, second);
        Assert.Matches("^[0-9a-f]{64}$", first.ContextDigest!);

        string transcript = JsonSerializer.Serialize(new[] { first, second });
        Assert.DoesNotContain(sensitiveTitle, transcript, StringComparison.Ordinal);
        Assert.DoesNotContain(
            sensitiveDocumentId,
            transcript,
            StringComparison.Ordinal);
        Assert.DoesNotContain("rs-sensitive", transcript, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CoordinatorPayloadObservationsFailClosedWithoutChangingWireOrAuthState()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8091, 1011));
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);
        await EventuallyAsync(() => harness.Observations.Count > 0);

        int wireBefore = harness.SentDocContextUpdates().Length;
        int callsBefore = harness.Channel.CallCount;
        int observationsBefore = harness.Observations.Count;
        using JsonDocument duplicate = JsonDocument.Parse(
            "{\"outer\":{\"same\":1,\"same\":2}}");

        foreach ((string Stage, string Outcome) in new[]
                 {
                     ("queue", "durably_queued"),
                     ("send", "sent"),
                     ("failure", "send_deferred"),
                 })
        {
            InvokeCoordinatorObservation(
                harness.Coordinator,
                Stage,
                Outcome,
                duplicate.RootElement,
                sequence: 41);
        }

        await Task.Delay(30);
        Assert.Equal(observationsBefore, harness.Observations.Count);
        Assert.Equal(wireBefore, harness.SentDocContextUpdates().Length);
        Assert.Equal(callsBefore, harness.Channel.CallCount);

        using JsonDocument valid = JsonDocument.Parse("{\"z\":2,\"a\":1}");
        InvokeCoordinatorObservation(
            harness.Coordinator,
            "queue",
            "durably_queued",
            valid.RootElement,
            sequence: 42);
        await EventuallyAsync(() => harness.Observations.Any(
            observation => observation.Stage == "queue" &&
                observation.Outcome == "durably_queued" &&
                observation.Sequence == 42));

        RbpDocumentContextObservation observed = harness.Observations.Single(
            observation => observation.Stage == "queue" &&
                observation.Outcome == "durably_queued" &&
                observation.Sequence == 42);
        Assert.Equal(
            RbpDocumentContextObservation.MakeContextDigest(valid.RootElement),
            observed.ContextDigest);
        Assert.NotNull(observed.ContextDigest);
        Assert.Equal(wireBefore, harness.SentDocContextUpdates().Length);
        Assert.Equal(callsBefore, harness.Channel.CallCount);
    }

    [Fact]
    public async Task RegistrationTriggersImmediatePollAndEmitsUpdate()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8080, 1000));

        await EventuallyAsync(() => harness.Channel.CallCount == 1);
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);

        RbpEnvelope update =
            Assert.Single(harness.SentDocContextUpdates());
        Assert.Equal("doc_context_update", update.Type);
        Assert.Equal(RbpEnvelopeScope.Data, update.Scope);
        Assert.Equal("rs-8080", update.Rsid);
        Assert.Equal(1, update.Sequence);
        Assert.False(update.Payload.TryGetProperty("contextDigest", out _));
        JsonElement document = Assert.Single(
            update.Payload.GetProperty("documents").EnumerateArray());
        Assert.Equal(
            "doc-1",
            document.GetProperty("document_id").GetString());
        Assert.Equal(
            "Project A",
            document.GetProperty("title").GetString());
        Assert.Equal(
            JsonValueKind.Null,
            document.GetProperty("path_digest").ValueKind);
        Assert.Equal(
            "doc-1",
            update.Payload.GetProperty("active_document").GetString());
        Assert.Equal(
            "Level 2 HVAC",
            update.Payload
                .GetProperty("active_view")
                .GetProperty("name")
                .GetString());
        Assert.Equal(
            "mech",
            update.Payload.GetProperty("discipline_hint").GetString());
        Assert.True(harness.Channel.AllLeasesReleased);
    }

    [Fact]
    public async Task UnchangedSnapshotStaysSilentAtTheNextTick()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8081, 1001));
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);

        harness.Clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => harness.Channel.CallCount >= 2);
        await Task.Delay(30);

        Assert.Single(harness.SentDocContextUpdates());
    }

    [Fact]
    public async Task ChangedSnapshotEmitsExactlyOneUpdate()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8082, 1002));
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);

        harness.Channel.SetSnapshot(revision: 2, title: "Project B");
        harness.Clock.Advance(TimeSpan.FromSeconds(15));

        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 2);
        RbpEnvelope second = harness.SentDocContextUpdates()[1];
        Assert.Equal(2, second.Sequence);
        Assert.Equal(
            "Project B",
            Assert.Single(
                    second.Payload.GetProperty("documents").EnumerateArray())
                .GetProperty("title")
                .GetString());
    }

    [Fact]
    public async Task ResumeTriggersAnImmediatePollWithoutATick()
    {
        RbpLocalSessionSnapshot local = DocContextLocalSession(8083, 1003);
        await using var harness = await DocContextHarness.StartAsync(
            local,
            seedAsync: async store =>
                _ = await store.PersistRegisteredSessionAsync(
                    Registration(local, "rs-8083")));

        await EventuallyAsync(() => harness.Channel.CallCount == 1);
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);
        Assert.Contains(
            harness.Cycle.Sent,
            envelope => envelope.Type == "session_resume");
        Assert.DoesNotContain(
            harness.Cycle.Sent,
            envelope => envelope.Type == "session_register");
        Assert.Equal("rs-8083", harness.SentDocContextUpdates()[0].Rsid);
    }

    [Fact]
    public async Task CapabilityAbsentSessionIsNeverPolled()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(
                8084,
                1004,
                advertisesCachedContext: false));
        await EventuallyAsync(
            () => harness.Cycle.Sent.Any(
                envelope => envelope.Type == "session_register"));
        await EventuallyAsync(
            () => harness.Clock.HasOutstandingDelayDueIn(
                TimeSpan.FromSeconds(15)));

        harness.Clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            () => harness.Cycle.Sent.Any(
                envelope => envelope.Type == "heartbeat"));
        harness.Clock.Advance(TimeSpan.FromSeconds(15));
        await Task.Delay(30);

        Assert.Equal(0, harness.Channel.CallCount);
        Assert.Empty(harness.SentDocContextUpdates());
    }

    [Fact]
    public async Task AddinFailureEmitsNothingAndRetriesAtTheNextTick()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8085, 1005),
            failFirstPoll: true);

        await EventuallyAsync(() => harness.Channel.CallCount == 1);
        await Task.Delay(30);
        Assert.Equal(1, harness.Channel.CallCount);
        Assert.Empty(harness.SentDocContextUpdates());

        harness.Clock.Advance(TimeSpan.FromSeconds(15));

        await EventuallyAsync(() => harness.Channel.CallCount == 2);
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);
    }

    [Fact]
    public async Task RouteFailureIsObservedSeparatelyFromSnapshotNotReady()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8089, 1009),
            failFirstRoute: true);

        await EventuallyAsync(() => harness.Channel.CallCount == 1);
        await EventuallyAsync(() => harness.Observations.Any(
            observation => observation.Stage == "failure" &&
                observation.Outcome == "route_failure"));
        Assert.DoesNotContain(
            harness.Observations,
            observation => observation.Stage == "snapshot" &&
                observation.Outcome == "not_ready");
        Assert.Empty(harness.SentDocContextUpdates());
    }

    [Fact]
    public async Task SessionEndStopsTheWatcherCleanly()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8086, 1006));
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);

        harness.Catalog.Replace();
        harness.Clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            () => harness.Cycle.Sent.Any(
                envelope => envelope.Type == "session_unregister"));
        int settled = harness.Channel.CallCount;

        harness.Clock.Advance(TimeSpan.FromSeconds(15));
        harness.Clock.Advance(TimeSpan.FromSeconds(15));
        await Task.Delay(50);

        Assert.Equal(settled, harness.Channel.CallCount);
        Assert.Single(harness.SentDocContextUpdates());
    }

    [Fact]
    public async Task WatcherRoutesOnlyTheCachedDocumentContextMethod()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8087, 1007));
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);
        harness.Channel.SetSnapshot(revision: 2, title: "Project C");
        harness.Clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => harness.Channel.CallCount >= 2);

        string[] methods = harness.Channel.Methods;
        Assert.NotEmpty(methods);
        Assert.All(
            methods,
            method => Assert.Equal("get_document_context", method));
        Assert.DoesNotContain("get_current_view_info", methods);
        Assert.DoesNotContain("list_open_views", methods);
    }

    private static RbpLocalSessionSnapshot DocContextLocalSession(
        int port,
        int processId,
        bool advertisesCachedContext = true)
    {
        string capabilities = advertisesCachedContext
            ? "\"doc_context_cached_v1\""
            : string.Empty;
        string localKey = $"port:{port}:pid:{processId}:started:100";
        return new RbpLocalSessionSnapshot(
            localKey,
            Json(
                $$"""
                {
                  "local_session_key":"{{localKey}}",
                  "user_hint":{"name":"BT"},
                  "machine":{
                    "hostname":"WS01",
                    "fingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                  },
                  "revit":{
                    "version":"2024",
                    "build":"24.1",
                    "pid":{{processId}}
                  },
                  "addin_version":"2026.07.26.0",
                  "result_contract_version":2,
                  "session_capabilities":[{{capabilities}}],
                  "bridge_version":"0.1.0",
                  "documents":[],
                  "port":{{port}}
                }
                """),
            port,
            Json("""{"active_task":null,"addin_reachable":true}"""));
    }

    private static JsonDocument LoadDocumentContextDigestFixture()
    {
        string path = Path.Combine(
            RbpFixtureReader.FindRepositoryRoot(),
            "packages",
            "bridge",
            "tests",
            "RevAgent.Bridge.Tests",
            "Gateway",
            "Connection",
            "Fixtures",
            "doc-context-digest.json");
        return JsonDocument.Parse(File.ReadAllBytes(path));
    }

    private static void InvokeCoordinatorObservation(
        RbpConnectionCoordinator coordinator,
        string stage,
        string outcome,
        JsonElement payload,
        long sequence)
    {
        MethodInfo method = typeof(RbpConnectionCoordinator).GetMethod(
            "ObserveDocumentContext",
            BindingFlags.Instance | BindingFlags.NonPublic) ??
            throw new MissingMethodException(
                nameof(RbpConnectionCoordinator),
                "ObserveDocumentContext");
        _ = method.Invoke(
            coordinator,
            new object?[]
            {
                stage,
                outcome,
                "rs-8091",
                payload,
                sequence,
            });
    }

    /// <summary>
    /// A scripted stand-in for the routed add-in invocation channel. It
    /// records every routed method name so the tests can prove the frozen
    /// Section 14 prohibition: only <c>get_document_context</c> is ever
    /// dispatched, never a <c>get_current_view_info</c> plus
    /// <c>list_open_views</c> composition.
    /// </summary>
    private sealed class ScriptedDocContextChannel : IRbpInvocationChannel
    {
        private readonly ConcurrentQueue<string> _methods = new();
        private readonly ConcurrentQueue<RecordingLease> _leases = new();
        private int _callCount;
        private int _failNextPolls;
        private int _failNextRoutes;
        private long _revision = 1;
        private string _title = "Project A";

        internal int CallCount => Volatile.Read(ref _callCount);

        internal string[] Methods => _methods.ToArray();

        internal bool AllLeasesReleased =>
            _leases.All(lease => lease.Released);

        internal void FailNextPoll() =>
            Interlocked.Increment(ref _failNextPolls);

        internal void FailNextRoute() =>
            Interlocked.Increment(ref _failNextRoutes);

        internal void SetSnapshot(long revision, string title)
        {
            lock (_methods)
            {
                _revision = revision;
                _title = title;
            }
        }

        public Task<RbpAddinOutcome> InvokeAsync(
            string rsid,
            AddinCall call,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _methods.Enqueue(call.Method);
            Interlocked.Increment(ref _callCount);
            if (Interlocked.CompareExchange(ref _failNextRoutes, 0, 0) > 0)
            {
                Interlocked.Decrement(ref _failNextRoutes);
                return Task.FromResult(
                    new RbpAddinOutcome(
                        RbpAddinOutcomeKind.KnownNotDispatched,
                        default,
                        Array.Empty<byte>(),
                        RequestBytes: 0,
                        ResponseBytes: 0,
                        FaultClass: "addin_unreachable",
                        Message: "routed session unavailable",
                        RouteFailure: true));
            }

            if (Interlocked.CompareExchange(ref _failNextPolls, 0, 0) > 0)
            {
                Interlocked.Decrement(ref _failNextPolls);
                return Task.FromResult(
                    new RbpAddinOutcome(
                        RbpAddinOutcomeKind.KnownNotDispatched,
                        default,
                        Array.Empty<byte>(),
                        RequestBytes: 0,
                        ResponseBytes: 0,
                        FaultClass: "addin_unreachable",
                        Message: "The scripted add-in session is offline."));
            }

            long revision;
            string title;
            lock (_methods)
            {
                revision = _revision;
                title = _title;
            }

            var lease = new RecordingLease();
            _leases.Enqueue(lease);
            return Task.FromResult(
                DocContextOutcome(call, revision, title, lease));
        }

        private static RbpAddinOutcome DocContextOutcome(
            AddinCall call,
            long revision,
            string title,
            IRbpDispatchLease lease)
        {
            string result =
                $$"""
                {
                  "resultContractVersion":2,
                  "documentContextContractVersion":1,
                  "capturedAtUtc":"2026-07-26T10:00:00.000Z",
                  "revision":{{revision}},
                  "cacheState":"ready",
                  "unavailableReason":null,
                  "documents":[
                    {
                      "documentId":"doc-1",
                      "title":"{{title}}",
                      "pathDigest":null,
                      "isWorkshared":false,
                      "isActive":true
                    }
                  ],
                  "activeDocumentId":"doc-1",
                  "activeView":{
                    "documentId":"doc-1",
                    "id":"123",
                    "name":"Level 2 HVAC",
                    "type":"FloorPlan",
                    "level":"Level 2"
                  },
                  "disciplineHint":"mech"
                }
                """;
            byte[] raw = Encoding.UTF8.GetBytes(
                $$"""
                {"jsonrpc":"2.0","id":"{{call.InvocationId}}","result":{{result}}}
                """.Trim());
            using JsonDocument document = JsonDocument.Parse(result);
            return new RbpAddinOutcome(
                RbpAddinOutcomeKind.Completed,
                document.RootElement.Clone(),
                raw,
                RequestBytes: 64,
                ResponseBytes: raw.Length,
                Lease: lease);
        }

        private sealed class RecordingLease : IRbpDispatchLease
        {
            private int _released;

            internal bool Released => Volatile.Read(ref _released) != 0;

            public void ReleaseAfterDurableDecision() =>
                Interlocked.Exchange(ref _released, 1);
        }
    }

    private sealed class DocContextHarness : IAsyncDisposable
    {
        private readonly RbpJournalTestDirectory _directory;
        private readonly RbpJournalStore _store;
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _run;

        private DocContextHarness(
            RbpJournalTestDirectory directory,
            RbpJournalStore store,
            ManualCoordinatorClock clock,
            MutableSessionCatalog catalog,
            FakeConnectionCycle cycle,
            ScriptedDocContextChannel channel,
            ConcurrentQueue<RbpDocumentContextObservation> observations,
            RbpConnectionCoordinator coordinator)
        {
            _directory = directory;
            _store = store;
            Clock = clock;
            Catalog = catalog;
            Cycle = cycle;
            Channel = channel;
            Observations = observations;
            Coordinator = coordinator;
            _run = coordinator.RunAsync(_stop.Token);
        }

        internal ManualCoordinatorClock Clock { get; }

        internal MutableSessionCatalog Catalog { get; }

        internal FakeConnectionCycle Cycle { get; }

        internal ScriptedDocContextChannel Channel { get; }

        internal ConcurrentQueue<RbpDocumentContextObservation> Observations { get; }

        internal RbpConnectionCoordinator Coordinator { get; }

        internal RbpEnvelope[] SentDocContextUpdates() =>
            Cycle.Sent
                .Where(envelope => envelope.Type == "doc_context_update")
                .ToArray();

        internal static async Task<DocContextHarness> StartAsync(
            RbpLocalSessionSnapshot local,
            bool failFirstPoll = false,
            bool failFirstRoute = false,
            Func<RbpJournalStore, Task>? seedAsync = null)
        {
            var directory = new RbpJournalTestDirectory();
            var clock = new ManualCoordinatorClock();
            RbpJournalStore store = OpenStore(directory, clock);
            if (seedAsync is not null)
            {
                await seedAsync(store);
            }

            var channel = new ScriptedDocContextChannel();
            if (failFirstPoll)
            {
                channel.FailNextPoll();
            }
            if (failFirstRoute)
            {
                channel.FailNextRoute();
            }

            var responder = new ScriptedGatewayResponder(clock);
            var cycle = new FakeConnectionCycle(responder.Respond);
            var catalog = new MutableSessionCatalog(local);
            var observations = new ConcurrentQueue<RbpDocumentContextObservation>();
            var watcher = new RbpDocContextWatcher(
                channel,
                clock,
                onObservation: observation =>
                {
                    observations.Enqueue(observation);
                    return ValueTask.CompletedTask;
                });
            var coordinator = new RbpConnectionCoordinator(
                new FakeConnectionCycleFactory(cycle),
                store,
                catalog,
                new RbpConnectionCoordinatorOptions(
                    new Uri("wss://gateway.revagent.app/bridge/v1"),
                    new RbpHelloProfile(
                        "0.1.0",
                        "WS01",
                        "Windows 11",
                        new[] { "2026.07.26.0" })),
                new StubInvocationDispatcher(),
                inboundJournal: null,
                clock,
                new FixedRandomSource(0),
                watcher,
                onDocumentContextObservation: observation =>
                {
                    observations.Enqueue(observation);
                    return ValueTask.CompletedTask;
                });
            return new DocContextHarness(
                directory,
                store,
                clock,
                catalog,
                cycle,
                channel,
                observations,
                coordinator);
        }

        public async ValueTask DisposeAsync()
        {
            _stop.Cancel();
            try
            {
                await _run.WaitAsync(TimeSpan.FromSeconds(5));
            }
            catch (TimeoutException)
            {
            }
            catch (OperationCanceledException)
            {
            }

            _stop.Dispose();
            await _store.DisposeAsync();
            _directory.Dispose();
        }
    }
}
