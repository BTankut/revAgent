using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

/// <summary>
/// The coordinator side of invocation dispatch: the receive loop stays free
/// while the add-in works, Section 10.1 rejects the second invoke
/// deterministically, and a closing cycle is bounded.
/// </summary>
public sealed partial class RbpConnectionCoordinatorTests
{
    [Fact]
    public void PreparedSendCancellationProvesExactNoStart()
    {
        var cycle = new FakeConnectionCycle(_ => null);
        RbpEnvelope envelope = DataEnvelope(
            "result", Id(900), "rs-8080", 1, Json("{}"));

        RbpPreparedSend prepared = ((IRbpConnectionCycle)cycle)
            .PrepareSend(envelope, CancellationToken.None);

        Assert.Empty(cycle.Sent);
        Assert.True(prepared.TryCancelBeforeStart());
        Assert.False(prepared.TryStart(out Task? started));
        Assert.Null(started);
        Assert.Empty(cycle.Sent);
    }

    [Fact]
    public async Task PreparedSendSynchronousThrowIsStartedAndSingleUse()
    {
        var cycle = new FakeConnectionCycle(
            _ => null,
            sendBehavior: (_, _, _) =>
                throw new IOException("synchronous send-start failure"));
        RbpPreparedSend prepared = ((IRbpConnectionCycle)cycle).PrepareSend(
            DataEnvelope("result", Id(901), "rs-8080", 1, Json("{}")),
            CancellationToken.None);

        Assert.True(prepared.TryStart(out Task? started));
        Assert.NotNull(started);
        await Assert.ThrowsAsync<IOException>(() => started!);
        Assert.False(prepared.TryCancelBeforeStart());
        Assert.False(prepared.TryStart(out Task? repeated));
        Assert.Same(started, repeated);
        Assert.Single(cycle.Sent);
    }

    [Fact]
    public async Task PreparedSendPublishesTheExactHotTaskIdentity()
    {
        var hot = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var cycle = new FakeConnectionCycle(
            _ => null,
            sendBehavior: (_, _, _) => hot.Task);
        RbpPreparedSend prepared = ((IRbpConnectionCycle)cycle).PrepareSend(
            DataEnvelope("result", Id(902), "rs-8080", 1, Json("{}")),
            CancellationToken.None);

        Assert.True(prepared.TryStart(out Task? started));
        Assert.Same(hot.Task, started);
        Assert.Same(hot.Task, prepared.StartedTask);
        Assert.Same(hot.Task, await prepared.HotTaskPublished);
        Assert.False(prepared.TryCancelBeforeStart());

        hot.TrySetResult();
        await started!;
    }

    [Fact]
    public void ExactAckWinningBeforeExposureIsIdempotentConsumedSuccess()
    {
        const string rsid = "rs-c39-ack-race";
        const string resultDigest =
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const string outerDigest =
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        var attestation = new AddinProcessAttestation(
            new AddinProcessIdentity(481, 638400000000000000),
            "2025",
            "addin-loopback-fixture/test-only");
        var observation = RbpConformanceOmittedOriginObservation
            .CreateFixtureOneShot(() => attestation);
        using JsonDocument payload = JsonDocument.Parse(
            """
            {
              "invocation_id":"0197a3c2-0000-7000-8000-0000000000f1",
              "method":"fixture_multi_file_output",
              "params":{"scenario":"valid_multifile","fileCount":1,"bytesPerFile":1048577},
              "timeout_ms":120000,
              "mutating":false,
              "mutation_scope":null,
              "policy":{"class":"auto","decision":"auto","confirmation_id":null},
              "verification":null,
              "recovery_clearances":[]
            }
            """);
        RbpInvokeRequest request = RbpInvokeRequest.Parse(
            rsid, payload.RootElement.Clone());
        RbpInvocationIdentity identity = request.ToIdentity();
        using JsonDocument result = JsonDocument.Parse("{\"fixture\":true}");
        byte[] raw = Encoding.UTF8.GetBytes("{\"fixture\":true}");
        var outcome = new RbpAddinOutcome(
            RbpAddinOutcomeKind.Completed,
            result.RootElement.Clone(),
            raw,
            RequestBytes: 128,
            ResponseBytes: raw.Length)
        {
            ProcessAttestation = attestation,
        };

        Assert.True(observation.TryArm(
            request, identity, outcome, resultDigest));
        var replay = new RbpConformanceOmittedOriginReplay(
            1,
            rsid,
            identity.IdempotencyKey,
            identity.InvocationId,
            resultDigest);
        Assert.True(observation.TryBindReplay(
            replay, attemptGeneration: 7, sequence: 9, outerDigest));

        Assert.True(observation.TryConsumeDurableAcknowledgement(rsid, 9));
        Assert.True(observation.TryExposeReplay(
            replay, attemptGeneration: 7, sequence: 9, outerDigest));
        Assert.True(observation.TryExposeReplay(
            replay, attemptGeneration: 7, sequence: 9, outerDigest));
        Assert.False(observation.AbortBoundReplay(
            replay, attemptGeneration: 7, sequence: 9, outerDigest));
        Assert.False(observation.TryExposeReplay(
            replay, attemptGeneration: 8, sequence: 9, outerDigest));
    }

    [Fact]
    public void ExactNoStartAbortRearmsMarkerWithoutExposureOrOldReplayReuse()
    {
        const string rsid = "rs-c39-abort-race";
        const string resultDigest =
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        const string outerDigest =
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        var attestation = new AddinProcessAttestation(
            new AddinProcessIdentity(482, 638400000000000001),
            "2025", "addin-loopback-fixture/test-only");
        var observation = RbpConformanceOmittedOriginObservation
            .CreateFixtureOneShot(() => attestation);
        using JsonDocument payload = JsonDocument.Parse(
            """
            {
              "invocation_id":"0197a3c2-0000-7000-8000-0000000000f2",
              "method":"fixture_multi_file_output",
              "params":{"scenario":"valid_multifile","fileCount":1,"bytesPerFile":1048577},
              "timeout_ms":120000,"mutating":false,"mutation_scope":null,
              "policy":{"class":"auto","decision":"auto","confirmation_id":null},
              "verification":null,"recovery_clearances":[]
            }
            """);
        RbpInvokeRequest request = RbpInvokeRequest.Parse(
            rsid, payload.RootElement.Clone());
        RbpInvocationIdentity identity = request.ToIdentity();
        using JsonDocument result = JsonDocument.Parse("{\"fixture\":true}");
        byte[] raw = Encoding.UTF8.GetBytes("{\"fixture\":true}");
        var outcome = new RbpAddinOutcome(
            RbpAddinOutcomeKind.Completed,
            result.RootElement.Clone(), raw, 128, raw.Length)
        {
            ProcessAttestation = attestation,
        };
        Assert.True(observation.TryArm(
            request, identity, outcome, resultDigest));
        var replay = new RbpConformanceOmittedOriginReplay(
            1, rsid, identity.IdempotencyKey, identity.InvocationId,
            resultDigest);
        Assert.True(observation.TryBindReplay(
            replay, attemptGeneration: 11, sequence: 13, outerDigest));

        Assert.False(observation.AbortBoundReplay(
            replay, attemptGeneration: 11, sequence: 12, outerDigest));
        Assert.True(observation.AbortBoundReplay(
            replay, attemptGeneration: 11, sequence: 13, outerDigest));
        Assert.True(observation.AbortBoundReplay(
            replay, attemptGeneration: 11, sequence: 13, outerDigest));
        Assert.True(observation.IsArmedExactReplay(
            rsid, payload.RootElement));
        Assert.False(observation.TryConsumeDurableAcknowledgement(rsid, 13));
        Assert.False(observation.TryExposeReplay(
            replay, attemptGeneration: 11, sequence: 13, outerDigest));
        Assert.False(observation.TryBindReplay(
            replay, attemptGeneration: 12, sequence: 14, outerDigest));
    }

    [Fact]
    public async Task PreparedSendAsyncFailureRetainsSingleStartedTask()
    {
        var hot = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var cycle = new FakeConnectionCycle(
            _ => null,
            sendBehavior: (_, _, _) => hot.Task);
        RbpPreparedSend prepared = ((IRbpConnectionCycle)cycle).PrepareSend(
            DataEnvelope("result", Id(903), "rs-8080", 1, Json("{}")),
            CancellationToken.None);

        Assert.True(prepared.TryStart(out Task? started));
        hot.TrySetException(new IOException("asynchronous send failure"));
        await Assert.ThrowsAsync<IOException>(() => started!);
        Assert.False(prepared.TryCancelBeforeStart());
        Assert.False(prepared.TryStart(out Task? repeated));
        Assert.Same(started, repeated);
        Assert.Single(cycle.Sent);
    }

    [Fact]
    public async Task IntegratedMarkerIsBoundBeforeSynchronousSendAckConsumesIt()
    {
        ArmedReplayFixture fixture = CreateArmedReplayFixture(
            "rs-8080", Id(904), 483);
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        int sendStarts = 0;
        int consumed = 0;
        var cycle = new FakeConnectionCycle(
            _ => null,
            sendBehavior: (current, envelope, _) =>
            {
                if (envelope.Type == "result" &&
                    envelope.Payload.GetProperty("invocation_id").GetString() ==
                        fixture.InvocationId)
                {
                    Interlocked.Increment(ref sendStarts);
                    if (fixture.Observation.TryConsumeDurableAcknowledgement(
                            fixture.Rsid, envelope.Sequence!.Value))
                        Interlocked.Increment(ref consumed);
                }
                RbpEnvelope? response = responder.Respond(envelope);
                if (response is not null) current.Deliver(response);
                return Task.CompletedTask;
            });
        var dispatcher = new OmittedReplayDispatcher(
            fixture.Replay, fixture.InvocationId);
        var coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(cycle), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                new RbpHelloProfile(
                    "0.1.0", "WS01", "Windows 11",
                    new[] { "2026.07.26.0" })),
            dispatcher, new RecordingInboundJournal(), clock,
            new FixedRandomSource(0),
            omittedOriginObservation: fixture.Observation);
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
            cycle.Deliver(DataEnvelope(
                "invoke", Id(905), fixture.Rsid, 1,
                fixture.Payload.Clone()));
            await EventuallyAsync(() => dispatcher.DispatchCalls == 1);
            await EventuallyAsync(() => Volatile.Read(ref sendStarts) == 1);

            Assert.Equal(1, Volatile.Read(ref consumed));
            Assert.Equal("Consumed", ReplayMarkerState(fixture.Observation));
            Assert.Equal(1, dispatcher.DispatchCalls);
            _ = Assert.Single(cycle.Sent, envelope =>
                envelope.Type == "result" &&
                envelope.Payload.GetProperty("invocation_id").GetString() ==
                    fixture.InvocationId);
        }
        finally
        {
            Task<RbpCoordinatorTeardownResult> teardown =
                coordinator.RequestStopTeardown();
            stop.Cancel();
            _ = await teardown.WaitAsync(TimeSpan.FromSeconds(2));
            await run.WaitAsync(TimeSpan.FromSeconds(2));
        }
    }

    [Fact]
    public async Task IntegratedEmergencyCancelsBoundMarkerBeforeAnyHotSend()
    {
        ArmedReplayFixture fixture = CreateArmedReplayFixture(
            "rs-8080", Id(906), 484);
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        int sendStarts = 0;
        var cycle = new FakeConnectionCycle(
            responder.Respond,
            sendBehavior: (current, envelope, _) =>
            {
                if (envelope.Type == "result" &&
                    envelope.Payload.GetProperty("invocation_id").GetString() ==
                        fixture.InvocationId)
                    Interlocked.Increment(ref sendStarts);
                RbpEnvelope? response = responder.Respond(envelope);
                if (response is not null) current.Deliver(response);
                return Task.CompletedTask;
            });
        var dispatcher = new OmittedReplayDispatcher(
            fixture.Replay, fixture.InvocationId);
        RbpConnectionCoordinator? coordinator = null;
        Task<RbpCoordinatorTeardownResult>? teardown = null;
        var teardownPublished = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        int stopWinner = 0;
        coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(cycle), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                new RbpHelloProfile(
                    "0.1.0", "WS01", "Windows 11",
                    new[] { "2026.07.26.0" })),
            dispatcher, new RecordingInboundJournal(), clock,
            new FixedRandomSource(0),
            onDispatchDiagnostic: message =>
            {
                if (string.Equals(
                        message,
                        "prepared invocation send committed",
                        StringComparison.Ordinal) &&
                    Interlocked.Exchange(ref stopWinner, 1) == 0)
                {
                    teardown = coordinator!.RequestStopTeardown();
                    teardownPublished.TrySetResult();
                }
            },
            omittedOriginObservation: fixture.Observation);
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
            cycle.Deliver(DataEnvelope(
                "invoke", Id(907), fixture.Rsid, 1,
                fixture.Payload.Clone()));
            await EventuallyAsync(() => dispatcher.DispatchCalls == 1);
            await teardownPublished.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Assert.NotNull(teardown);
            RbpCoordinatorTeardownResult result = await teardown.WaitAsync(
                TimeSpan.FromSeconds(2));
            RbpCoordinatorException failure =
                await Assert.ThrowsAsync<RbpCoordinatorException>(
                    () => run.WaitAsync(TimeSpan.FromSeconds(2)));

            Assert.Equal(
                RbpCoordinatorTeardownDisposition.EmergencyMustExit,
                result.Disposition);
            Assert.Equal(
                RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
                failure.ErrorCode);
            Assert.Equal(0, Volatile.Read(ref sendStarts));
            Assert.Equal(
                "BoundUnexposed",
                ReplayMarkerState(fixture.Observation));
            Assert.Equal(4, AttemptStopState(coordinator));
        }
        finally
        {
            if (!run.IsCompleted)
            {
                _ = coordinator.RequestStopTeardown();
                stop.Cancel();
                try { await run.WaitAsync(TimeSpan.FromSeconds(2)); }
                catch { }
            }
        }
    }

    [Fact]
    public async Task AnInFlightInvocationDoesNotBlockTheReceiveLoop()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var handoff = new RecordingInboundJournal();
        var dispatcher = new StubInvocationDispatcher
        {
            Hold = new TaskCompletionSource(),
        };
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            handoff,
            invocationDispatcher: dispatcher);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);

        cycle.Deliver(
            DataEnvelope(
                "invoke",
                Id(401),
                "rs-8080",
                1,
                Json($$"""{"invocation_id":"{{Id(402)}}"}""")));
        await EventuallyAsync(() => dispatcher.Dispatched.Count == 1);

        // The add-in is still working. A second inbound frame must still be
        // sequenced and journaled — this is the regression guard: awaiting the
        // dispatch on the receive loop would stall every later frame, including
        // the Section 16 cancel for the very invocation that is running.
        cycle.Deliver(
            DataEnvelope(
                "cancel",
                Id(403),
                "rs-8080",
                2,
                Json($$"""{"invocation_id":"{{Id(402)}}"}""")));

        await EventuallyAsync(() => handoff.Count == 2);
        RbpReceiveFrontier frontier =
            await store.GetReceiveFrontierAsync("rs-8080");
        Assert.Equal(2, frontier.LastJournaledSequence);
        Assert.Equal(1, coordinator.GetSnapshot().ActiveInvocationCount);

        dispatcher.Hold!.SetResult();
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task Section101RejectsTheSecondInvokeWithoutDispatchingIt()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var dispatcher = new StubInvocationDispatcher
        {
            Hold = new TaskCompletionSource(),
        };
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            new RecordingInboundJournal(),
            invocationDispatcher: dispatcher);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);

        cycle.Deliver(
            DataEnvelope(
                "invoke",
                Id(411),
                "rs-8080",
                1,
                Json($$"""{"invocation_id":"{{Id(412)}}"}""")));
        await EventuallyAsync(() => dispatcher.Dispatched.Count == 1);

        cycle.Deliver(
            DataEnvelope(
                "invoke",
                Id(413),
                "rs-8080",
                2,
                Json($$"""{"invocation_id":"{{Id(414)}}"}""")));

        await EventuallyAsync(
            () => dispatcher.RejectedInvocationIds.Count == 1);

        // The claim is taken synchronously on the receive loop, in arrival
        // order, so it is deterministically the SECOND invoke that loses.
        Assert.True(
            dispatcher.RejectedInvocationIds.TryDequeue(out string? rejected));
        Assert.Equal(Id(414), rejected);
        Assert.Single(dispatcher.Dispatched);

        dispatcher.Hold!.SetResult();
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task DistinctSessionsExecuteConcurrently()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var dispatcher = new StubInvocationDispatcher
        {
            Hold = new TaskCompletionSource(),
        };
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(
                LocalSession(8080, 1000),
                LocalSession(8081, 1001)),
            clock,
            new RecordingInboundJournal(),
            invocationDispatcher: dispatcher);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 2);

        cycle.Deliver(
            DataEnvelope(
                "invoke", Id(421), "rs-8080", 1,
                Json($$"""{"invocation_id":"{{Id(422)}}"}""")));
        cycle.Deliver(
            DataEnvelope(
                "invoke", Id(423), "rs-8081", 1,
                Json($$"""{"invocation_id":"{{Id(424)}}"}""")));

        // Section 10.1 bounds concurrency per rsid, not per connection.
        await EventuallyAsync(() => dispatcher.ConcurrentPeak == 2);
        Assert.Equal(2, coordinator.GetSnapshot().ActiveInvocationCount);

        dispatcher.Hold!.SetResult();
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task ClosingWithAnInvocationInFlightStaysBoundedAndUnpoisoned()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var dispatcher = new StubInvocationDispatcher
        {
            // Never completes: stands in for an add-in call that cannot be
            // cancelled past the dispatch boundary.
            Hold = new TaskCompletionSource(),
        };
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            new RecordingInboundJournal(),
            invocationDispatcher: dispatcher,
            invocationDrainTimeout: TimeSpan.FromMilliseconds(200));
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        cycle.Deliver(
            DataEnvelope(
                "invoke", Id(431), "rs-8080", 1,
                Json($$"""{"invocation_id":"{{Id(432)}}"}""")));
        await EventuallyAsync(() => dispatcher.Dispatched.Count == 1);

        var elapsed = Stopwatch.StartNew();
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));
        elapsed.Stop();

        // P3-T2 requires a clean stop well inside 10 s. An add-in call that
        // will not finish must not extend it, and — because invocation tasks
        // are deliberately not enrolled in AwaitOwnedTasksAsync — must not
        // poison connection authority either.
        Assert.True(
            elapsed.Elapsed < TimeSpan.FromSeconds(10),
            $"stop took {elapsed.Elapsed}");
        Assert.Equal(0, coordinator.GetSnapshot().OwnedBackgroundTaskCount);

        dispatcher.Hold!.SetResult();
    }

    [Fact]
    public async Task AMalformedInvokeIsThatInvocationsFaultNotTheConnections()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var handoff = new RecordingInboundJournal();

        // The real dispatcher, so the real parse path runs.
        var dispatcher = new RevAgent.Bridge.Gateway.Dispatch
            .RbpInvocationDispatcher(
                store,
                new UnreachableChannel(),
                new RevAgent.Bridge.Gateway.Dispatch.RbpInFlightGate());
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            handoff,
            invocationDispatcher: dispatcher);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);

        // Missing every required Section 10.2 field but `invocation_id`.
        cycle.Deliver(
            DataEnvelope(
                "invoke", Id(441), "rs-8080", 1,
                Json($$"""{"invocation_id":"{{Id(442)}}"}""")));

        RbpEnvelope error = await EventuallySentAsync(
            cycle,
            envelope => envelope.Type == "error");
        Assert.Equal(
            "protocol",
            error.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(
            "known",
            error.Payload.GetProperty("outcome").GetString());

        // The connection survived: it is still bound and still sequencing.
        Assert.Single(coordinator.GetSnapshot().ActiveRsids);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private static async Task<RbpEnvelope> EventuallySentAsync(
        FakeConnectionCycle cycle,
        Func<RbpEnvelope, bool> predicate)
    {
        RbpEnvelope? found = null;
        await EventuallyAsync(() =>
        {
            found = cycle.Sent.FirstOrDefault(predicate);
            return found is not null;
        });
        return found!;
    }

    private static ArmedReplayFixture CreateArmedReplayFixture(
        string rsid,
        string invocationId,
        int processId)
    {
        var attestation = new AddinProcessAttestation(
            new AddinProcessIdentity(
                processId, 638400000000000000 + processId),
            "2025", "addin-loopback-fixture/test-only");
        var observation = RbpConformanceOmittedOriginObservation
            .CreateFixtureOneShot(() => attestation);
        using JsonDocument payload = JsonDocument.Parse(
            $$"""
            {
              "invocation_id":"{{invocationId}}",
              "method":"fixture_multi_file_output",
              "params":{"scenario":"valid_multifile","fileCount":1,"bytesPerFile":1048577},
              "timeout_ms":120000,"mutating":false,"mutation_scope":null,
              "policy":{"class":"auto","decision":"auto","confirmation_id":null},
              "verification":null,"recovery_clearances":[]
            }
            """);
        RbpInvokeRequest request = RbpInvokeRequest.Parse(
            rsid, payload.RootElement.Clone());
        RbpInvocationIdentity identity = request.ToIdentity();
        using JsonDocument result = JsonDocument.Parse("{\"fixture\":true}");
        byte[] raw = Encoding.UTF8.GetBytes("{\"fixture\":true}");
        var outcome = new RbpAddinOutcome(
            RbpAddinOutcomeKind.Completed,
            result.RootElement.Clone(), raw, 128, raw.Length)
        {
            ProcessAttestation = attestation,
        };
        string digest =
            $"sha256:{new string((char)('a' + processId % 20), 64)}";
        if (!observation.TryArm(request, identity, outcome, digest))
            throw new InvalidOperationException(
                "The integrated replay fixture could not arm.");
        object marker = ReplayMarker(observation);
        T MarkerValue<T>(string name) =>
            (T)(marker.GetType().GetProperty(
                    name,
                    BindingFlags.Instance | BindingFlags.Public |
                    BindingFlags.NonPublic)?.GetValue(marker) ??
                throw new MissingMemberException(
                    $"Replay marker {name}"));
        return new ArmedReplayFixture(
            rsid,
            invocationId,
            payload.RootElement.Clone(),
            observation,
            new RbpConformanceOmittedOriginReplay(
                MarkerValue<long>("ReservationGeneration"),
                MarkerValue<string>("Rsid"),
                MarkerValue<string>("IdempotencyKey"),
                MarkerValue<string>("OriginInvocationId"),
                MarkerValue<string>("ResultDigest")));
    }

    private static string ReplayMarkerState(
        RbpConformanceOmittedOriginObservation observation)
    {
        object marker = ReplayMarker(observation);
        return marker.GetType().GetProperty(
                       "State",
                       BindingFlags.Instance | BindingFlags.Public |
                       BindingFlags.NonPublic)?.GetValue(marker)?.ToString() ??
               throw new MissingMemberException("Replay marker state");
    }

    private static object ReplayMarker(
        RbpConformanceOmittedOriginObservation observation) =>
        typeof(RbpConformanceOmittedOriginObservation)
            .GetField(
                "_marker",
                BindingFlags.Instance | BindingFlags.NonPublic)?
            .GetValue(observation) ??
        throw new InvalidOperationException("Replay marker is absent.");

    private sealed record ArmedReplayFixture(
        string Rsid,
        string InvocationId,
        JsonElement Payload,
        RbpConformanceOmittedOriginObservation Observation,
        RbpConformanceOmittedOriginReplay Replay);

    private sealed class OmittedReplayDispatcher(
        RbpConformanceOmittedOriginReplay replay,
        string invocationId) : IRbpInvocationDispatcher
    {
        private int _dispatchCalls;
        internal int DispatchCalls => Volatile.Read(ref _dispatchCalls);

        public IRbpInvocationClaim? TryClaim(string rsid) =>
            throw new InvalidOperationException(
                "Integrated dispatch must use exact authority.");

        public IRbpInvocationClaim? TryClaim(
            string rsid,
            RbpInvocationAuthoritySnapshot authority) =>
            new ReplayClaim(rsid, authority);

        public Task<RbpInvocationAnswer> DispatchClaimedAsync(
            IRbpInvocationClaim claim,
            JsonElement invokePayload,
            IReadOnlyList<string> grantedConnectionCapabilities,
            CancellationToken cancellationToken)
        {
            _ = claim;
            _ = invokePayload;
            _ = grantedConnectionCapabilities;
            cancellationToken.ThrowIfCancellationRequested();
            Interlocked.Increment(ref _dispatchCalls);
            return Task.FromResult(RbpInvocationAnswer.Result(
                RbpInvocationPayloads.ConformanceOmittedOriginReplay(
                    invocationId, replay.ResultDigest),
                omittedOriginReplay: replay));
        }

        public RbpInvocationAnswer RejectConcurrent(string rejectedId) =>
            RbpInvocationAnswer.Error(Json($$"""
                {
                  "invocation_id":"{{rejectedId}}",
                  "retryable":false,
                  "fault_class":"protocol",
                  "outcome":"known"
                }
                """));

        private sealed class ReplayClaim(
            string rsid,
            RbpInvocationAuthoritySnapshot authority) : IRbpInvocationClaim
        {
            public string Rsid { get; } = rsid;
            public RbpInvocationAuthoritySnapshot? Authority { get; } =
                authority;
            public void Dispose()
            {
            }
        }
    }

    /// <summary>
    /// Fails if the add-in is ever reached. A malformed invoke must be refused
    /// before dispatch, so this channel exists to prove no byte was written.
    /// </summary>
    private sealed class UnreachableChannel
        : RevAgent.Bridge.Gateway.Dispatch.IRbpInvocationChannel
    {
        public Task<RevAgent.Bridge.Gateway.Dispatch.RbpAddinOutcome>
            InvokeAsync(
                string rsid,
                RevAgent.Bridge.AddinLoopback.AddinCall call,
                CancellationToken cancellationToken) =>
            throw new InvalidOperationException(
                "A malformed invoke must never reach the add-in.");
    }
}
