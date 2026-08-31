using System.Collections;
using System.Collections.Concurrent;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed partial class RbpConnectionCoordinatorTests
{
    [Fact]
    public async Task C39RecoveryCarrierUsesReservedSequenceWithoutGenericOutbox()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(),
            new TestRecoveryPayloadProtector());
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond,
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0101");
        var factory = new FakeConnectionCycleFactory(cycle);
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        using (RbpRecoveredPayload? initial =
               await store.GetCorrelatedRecoveryPayloadAsync(
                   reservation.Rsid,
                   reservation.OriginInvocationId,
                   reservation.ResultDigest))
        {
            Assert.NotNull(initial);
        }
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            new RecordingInboundJournal(),
            invocationDispatcher: new RecoveryDispatcher(reservation),
            helloProfile: RouteProofHelloProfile(),
            docContextWatcher: RouteProofWatcher(clock));
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        cycle.Deliver(DataEnvelope(
            "invoke", Id(9701), "rs-8080", 1,
            Json($$"""{"invocation_id":"{{reservation.RecoveryInvocationId}}"}""")));

        RbpEnvelope partial = await EventuallySentAsync(
            cycle,
            envelope => envelope.Type == "partial" &&
                        envelope.Id == reservation.RecoveryInvocationId);
        Assert.Equal(reservation.CurrentReservedSequence, partial.Sequence);
        Assert.Equal(reservation.InboundAcknowledgementBaseline, partial.Acknowledgement);
        Assert.Equal(reservation.Rsid, partial.Rsid);
        Assert.Equal("chunk", partial.Payload.GetProperty("kind").GetString());
        Assert.Empty((await store.LoadSequenceAsync(reservation.Rsid)).Outbox);
        byte[] firstOuter = RbpEnvelopeCodec.Encode(partial);
        string payloadDigest = Rfc8785Json.Sha256Digest(partial.Payload);
        string outerDigest = "sha256:" + Convert.ToHexString(
            SHA256.HashData(firstOuter)).ToLowerInvariant();
        Assert.NotEqual(payloadDigest, outerDigest);
        Assert.Equal(payloadDigest, Rfc8785Json.Sha256Digest(partial.Payload));
        Assert.Equal(outerDigest, "sha256:" + Convert.ToHexString(
            SHA256.HashData(RbpEnvelopeCodec.Encode(partial))).ToLowerInvariant());
        Assert.Empty((await store.LoadSequenceAsync(reservation.Rsid)).Outbox);

        // A second same-cycle dispatcher completion observes the already sent
        // reservation and cannot emit a second byte-identical carrier frame.
        cycle.Deliver(DataEnvelope(
            "invoke", Id(9704), reservation.Rsid, 2,
            Json($$"""{"invocation_id":"{{reservation.RecoveryInvocationId}}"}"""))
            with
        { Acknowledgement = reservation.CurrentReservedSequence });
        await EventuallyAsync(async () =>
            (await store.GetReceiveFrontierAsync(reservation.Rsid))
                .LastJournaledSequence == 2);
        _ = Assert.Single(cycle.Sent, item =>
            item.Scope == RbpEnvelopeScope.Data &&
            item.Id == reservation.RecoveryInvocationId);
        object coordinatorSync = typeof(RbpConnectionCoordinator).GetField(
            "_sync", BindingFlags.Instance | BindingFlags.NonPublic)?
            .GetValue(coordinator) ?? throw new InvalidOperationException(
                "Coordinator synchronization root was unavailable.");
        Task<RbpCoordinatorTeardownResult>? teardown = null;
        for (int attempt = 0; attempt < 1_000 && teardown is null; attempt++)
        {
            lock (coordinatorSync)
            {
                RbpConnectionCoordinatorSnapshot current =
                    coordinator.GetSnapshot();
                if (current.ActiveInvocationCount == 0 &&
                    AttemptStopState(coordinator) is 2 or 5)
                {
                    teardown = coordinator.RequestStopTeardown();
                }
            }
            if (teardown is null) await Task.Delay(5);
        }
        Assert.NotNull(teardown);
        stop.Cancel();
        RbpCoordinatorTeardownResult result = await teardown.WaitAsync(
            TimeSpan.FromSeconds(5));
        Assert.Equal(
            RbpCoordinatorTeardownDisposition.NormalStopped,
            result.Disposition);
        await run.WaitAsync(TimeSpan.FromSeconds(5));
        RbpConnectionCoordinatorSnapshot stopped = coordinator.GetSnapshot();
        Assert.False(stopped.HasActiveConnection);
        Assert.Equal(0, stopped.ActiveInvocationCount);
    }

    [Fact]
    public async Task C39C1cRealDispatcherReservesCorrelatedCarrierWithoutOriginOrAddin()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(),
            new TestRecoveryPayloadProtector());
        _ = await store.PersistRegisteredSessionAsync(
            Registration(LocalSession(8080, 1000), "rs-8080"));

        string originId = Id(9711);
        byte[] raw = Encoding.UTF8.GetBytes(
            "{\"jsonrpc\":\"2.0\",\"result\":{\"recovered\":true}}");
        string digest = "sha256:" + Convert.ToHexString(
            SHA256.HashData(raw)).ToLowerInvariant();
        var origin = new RbpInvocationIdentity(
            "rs-8080", originId, "get_current_view_info", false, null,
            "sha256:" + new string('a', 64), "{\"decision\":\"allow\"}", "[]");
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        using (JsonDocument outcome = JsonDocument.Parse("{\"outcome\":\"completed\"}"))
        {
            _ = await store.PersistInvocationTerminalAsync(
                origin.IdempotencyKey,
                new RbpInvocationTerminal(RbpInvocationState.Completed,
                    outcome.RootElement.Clone(), digest,
                    RecoveryPayload: new RbpRecoveryPayload(digest, raw)));
        }

        var channel = new ThrowingRecoveryChannel();
        var dispatcher = new RbpInvocationDispatcher(
            store, channel, new RbpInFlightGate());
        string recoveryId = Id(9712);
        using JsonDocument request = JsonDocument.Parse($$"""
            {
              "invocation_id":"{{recoveryId}}",
              "method":"dispatch_payload_recovery",
              "params":{"origin_invocation_id":"{{originId}}","expected_result_digest":"{{digest}}"},
              "timeout_ms":120000,"mutating":false,"mutation_scope":null,
              "policy":{"class":"auto","decision":"auto","confirmation_id":null},
              "verification":null,"recovery_clearances":[]
            }
            """);
        IRbpInvocationClaim claim = Assert.IsAssignableFrom<IRbpInvocationClaim>(
            dispatcher.TryClaim("rs-8080"));
        RbpInvocationAnswer answer;
        try
        {
            answer = await dispatcher.DispatchClaimedAsync(
                claim, request.RootElement.Clone(), new[] { "chunked_results" },
                CancellationToken.None);
        }
        finally
        {
            claim.Dispose();
        }

        RbpRecoveryCarrierReservation reservation = Assert.IsType<
            RbpRecoveryCarrierReservation>(answer.RecoveryReservation);
        Assert.Equal(recoveryId, reservation.RecoveryInvocationId);
        Assert.Equal(originId, reservation.OriginInvocationId);
        Assert.Equal(digest, reservation.ResultDigest);
        Assert.Equal(0, channel.Calls);
        Assert.Empty((await store.LoadSequenceAsync("rs-8080")).Outbox);
        Assert.Equal(RbpInvocationState.Completed,
            (await store.GetInvocationAsync(origin.IdempotencyKey))!.State);
    }

    [Fact]
    public async Task C39C1cReconnectAfterRecoveryWriteReencodesTheExactUnacknowledgedFrameOnce()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(),
            new TestRecoveryPayloadProtector());
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(responder.Respond,
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0201");
        var second = new FakeConnectionCycle(responder.Respond,
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0202");
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var observations = new RecordingRecoveryCarrierObservationSink();
        var coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(first, second),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                RouteProofHelloProfile()),
            new RecoveryDispatcher(reservation),
            new RecordingInboundJournal(),
            clock,
            new FixedRandomSource(0),
            docContextWatcher: RouteProofWatcher(clock),
            recoveryCarrierObservationSink: observations);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        first.Deliver(DataEnvelope(
            "invoke", Id(9721), reservation.Rsid, 1,
            Json($$"""{"invocation_id":"{{reservation.RecoveryInvocationId}}"}""")));
        RbpEnvelope initial = await EventuallySentAsync(first,
            envelope => envelope.Type == "partial" &&
                        envelope.Id == reservation.RecoveryInvocationId);
        byte[] initialBytes = RbpEnvelopeCodec.Encode(initial);

        first.Fail(new IOException("C39 deterministic disconnect after write before ACK"));
        await EventuallyAsync(() => coordinator.GetSnapshot().ConnectionGeneration == 2);
        RbpEnvelope replay = await EventuallySentAsync(second,
            envelope => envelope.Type == "partial" &&
                        envelope.Id == reservation.RecoveryInvocationId);

        Assert.Equal(initial.Sequence, replay.Sequence);
        Assert.Equal(initial.Rsid, replay.Rsid);
        Assert.Equal(initialBytes, RbpEnvelopeCodec.Encode(replay));
        _ = Assert.Single(first.Sent, item => item.Scope == RbpEnvelopeScope.Data);
        _ = Assert.Single(second.Sent, item => item.Scope == RbpEnvelopeScope.Data);
        Assert.Empty((await store.LoadSequenceAsync(reservation.Rsid)).Outbox);
        Assert.Equal(new[] { RbpRecoveryCarrierObservationPhase.Materialized,
            RbpRecoveryCarrierObservationPhase.Write,
            RbpRecoveryCarrierObservationPhase.Materialized,
            RbpRecoveryCarrierObservationPhase.RestartResend },
            observations.Rows.Select(row => row.Phase));
        Assert.All(observations.Rows, row =>
        {
            Assert.Equal(reservation.CurrentReservedSequence, row.Sequence);
            Assert.Matches("^sha256:[0-9a-f]{64}$", row.HashedRecoveryId);
            Assert.Matches("^sha256:[0-9a-f]{64}$", row.OuterDigest);
        });

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task C39C1cEqualCoordinatorAckCompletesTheCarrierWithoutANextDuplicate()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(),
            new TestRecoveryPayloadProtector());
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(envelope =>
            envelope.Type == "heartbeat" ? null : responder.Respond(envelope),
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0102");
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            new RecordingInboundJournal(),
            invocationDispatcher: new RecoveryDispatcher(reservation),
            helloProfile: RouteProofHelloProfile(),
            docContextWatcher: RouteProofWatcher(clock));
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        cycle.Deliver(DataEnvelope(
            "invoke", Id(9731), reservation.Rsid, 1,
            Json($$"""{"invocation_id":"{{reservation.RecoveryInvocationId}}"}""")));
        _ = await EventuallySentAsync(cycle, item =>
            item.Type == "partial" && item.Id == reservation.RecoveryInvocationId);
        await EventuallyAsync(() => coordinator.GetSnapshot().ActiveInvocationCount == 0);

        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => cycle.Sent.Any(item => item.Type == "heartbeat"));
        cycle.Deliver(HeartbeatAck(clock, Id(9732), reservation.Rsid,
            reservation.CurrentReservedSequence));
        await EventuallyAsync(async () =>
            (await store.GetRecoveryCarrierReservationAsync(
                reservation.RecoveryInvocationId))!.Phase ==
            RbpRecoveryCarrierPhase.Completed);

        // Completion must leave no schedulable protected carrier behind.
        await Task.Delay(25);
        _ = Assert.Single(cycle.Sent, item =>
            item.Type == "partial" && item.Id == reservation.RecoveryInvocationId);
        Assert.Empty((await store.LoadSequenceAsync(reservation.Rsid)).Outbox);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task C39C1dFinalPartialReceiptReservesAndSendsOneDirectTerminalThenEqualReceiptReleasesIt()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(envelope =>
            envelope.Type == "heartbeat" ? null : responder.Respond(envelope),
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0205");
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var observations = new RecordingRecoveryCarrierObservationSink();
        var coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(cycle), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                RouteProofHelloProfile()),
            new RecoveryDispatcher(reservation), new RecordingInboundJournal(),
            clock, new FixedRandomSource(0), RouteProofWatcher(clock),
            recoveryCarrierObservationSink: observations);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        RbpEnvelope partial = await EventuallySentAsync(cycle, item =>
            item.Type == "partial" && item.Id == reservation.RecoveryInvocationId);
        Assert.Equal(reservation.CurrentReservedSequence, partial.Sequence);

        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => cycle.Sent.Any(item => item.Type == "heartbeat"));
        cycle.Deliver(HeartbeatAck(clock, Id(9734), reservation.Rsid,
            reservation.CurrentReservedSequence));
        await EventuallyAsync(async () =>
            (await store.ListActiveRecoveryTerminalPlansAsync()).Count == 1);
        RbpEnvelope terminal = await EventuallySentAsync(cycle, item =>
            item.Type == "result" && item.Id == reservation.RecoveryInvocationId);
        Assert.Equal(reservation.CurrentReservedSequence + 1, terminal.Sequence);
        Assert.Equal(reservation.InboundAcknowledgementBaseline, terminal.Acknowledgement);
        Assert.True(terminal.Payload.GetProperty("chunked").GetBoolean());
        Assert.False(terminal.Payload.TryGetProperty("payload_omitted", out _));
        Assert.Empty((await store.LoadSequenceAsync(reservation.Rsid)).Outbox);

        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => cycle.Sent.Count(item => item.Type == "heartbeat") >= 2);
        cycle.Deliver(HeartbeatAck(clock, Id(9735), reservation.Rsid,
            terminal.Sequence!.Value));
        await EventuallyAsync(async () =>
            !(await store.ListActiveRecoveryTerminalPlansAsync()).Any());
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(
            reservation.Rsid, reservation.OriginInvocationId,
            reservation.ResultDigest));
        _ = Assert.Single(cycle.Sent, item => item.Type == "result" &&
            item.Id == reservation.RecoveryInvocationId);
        RbpRecoveryCarrierObservation acknowledged = observations.Rows.Last();
        Assert.Equal(RbpRecoveryCarrierObservationPhase.Acknowledged,
            acknowledged.Phase);
        Assert.Equal(terminal.Sequence, acknowledged.Sequence);
        Assert.True(acknowledged.Ordinal > observations.Rows
            .Where(row => row.Phase == RbpRecoveryCarrierObservationPhase.Write)
            .Max(row => row.Ordinal));

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task C39C1dLostTerminalReceiptReconnectsOneExactDirectTerminalWithoutOutbox()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(envelope =>
            envelope.Type == "heartbeat" ? null : responder.Respond(envelope),
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0103");
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var second = new FakeConnectionCycle(envelope =>
            envelope.Type == "session_resume"
                ? RecoveryResumeAck(clock, envelope, reservation.CurrentReservedSequence)
                : envelope.Type == "heartbeat" ? null : responder.Respond(envelope),
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0104");
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(first, second), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)), clock,
            new RecordingInboundJournal(),
            invocationDispatcher: new RecoveryDispatcher(reservation),
            helloProfile: RouteProofHelloProfile(),
            docContextWatcher: RouteProofWatcher(clock));
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        _ = await EventuallySentAsync(first, item => item.Type == "partial" &&
            item.Id == reservation.RecoveryInvocationId);
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => first.Sent.Any(item => item.Type == "heartbeat"));
        first.Deliver(HeartbeatAck(clock, Id(9736), reservation.Rsid,
            reservation.CurrentReservedSequence));
        RbpEnvelope initial = await EventuallySentAsync(first, item =>
            item.Type == "result" && item.Id == reservation.RecoveryInvocationId);
        byte[] initialBytes = RbpEnvelopeCodec.Encode(initial);
        Assert.Empty((await store.LoadSequenceAsync(reservation.Rsid)).Outbox);

        first.Fail(new IOException("C39 terminal acknowledgement lost"));
        await EventuallyAsync(() => coordinator.GetSnapshot().ConnectionGeneration == 2);
        await EventuallyAsync(() => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        await EventuallyAsync(async () =>
            (await store.ListActiveRecoveryTerminalPlansAsync()).Count == 1);
        RbpEnvelope replay = await EventuallySentAsync(second, item =>
            item.Type == "result" && item.Id == reservation.RecoveryInvocationId);
        Assert.Equal(initial.Sequence, replay.Sequence);
        Assert.Equal(initialBytes, RbpEnvelopeCodec.Encode(replay));
        _ = Assert.Single(first.Sent, item => item.Type == "result" &&
            item.Id == reservation.RecoveryInvocationId);
        _ = Assert.Single(second.Sent, item => item.Type == "result" &&
            item.Id == reservation.RecoveryInvocationId);
        Assert.Empty((await store.LoadSequenceAsync(reservation.Rsid)).Outbox);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task C39C1dResumeReceiptAtTerminalSequenceConfirmsBeforeAnyResend()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(envelope =>
            envelope.Type == "heartbeat" ? null : responder.Respond(envelope),
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0203");
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var second = new FakeConnectionCycle(envelope =>
            envelope.Type == "session_resume"
                ? RecoveryResumeAck(clock, envelope,
                    reservation.CurrentReservedSequence + 1)
                : envelope.Type == "heartbeat" ? null : responder.Respond(envelope),
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0204");
        var observations = new RecordingRecoveryCarrierObservationSink();
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(first, second), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)), clock,
            new RecordingInboundJournal(),
            invocationDispatcher: new RecoveryDispatcher(reservation),
            helloProfile: RouteProofHelloProfile(),
            docContextWatcher: RouteProofWatcher(clock),
            recoveryCarrierObservationSink: observations);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        _ = await EventuallySentAsync(first, item => item.Type == "partial" &&
            item.Id == reservation.RecoveryInvocationId);
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => first.Sent.Any(item => item.Type == "heartbeat"));
        first.Deliver(HeartbeatAck(clock, Id(9746), reservation.Rsid,
            reservation.CurrentReservedSequence));
        RbpEnvelope terminal = await EventuallySentAsync(first, item => item.Type == "result" &&
            item.Id == reservation.RecoveryInvocationId);
        RbpRecoveryTerminalPlan terminalPlan = Assert.Single(
            await store.ListActiveRecoveryTerminalPlansAsync());

        first.Fail(new IOException("resume carries the terminal receipt"));
        await EventuallyAsync(() => coordinator.GetSnapshot().ConnectionGeneration == 2);
        await EventuallyAsync(async () =>
            !(await store.ListActiveRecoveryTerminalPlansAsync()).Any());
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(
            reservation.Rsid, reservation.OriginInvocationId,
            reservation.ResultDigest));
        await Task.Delay(25);
        Assert.DoesNotContain(second.Sent, item => item.Type == "result" &&
            item.Id == reservation.RecoveryInvocationId);
        RbpRecoveryCarrierObservation acknowledgement = Assert.Single(
            observations.Rows, item => item.Phase ==
                RbpRecoveryCarrierObservationPhase.Acknowledged &&
                item.Sequence == terminal.Sequence);
        Assert.Equal(terminal.Sequence, acknowledgement.Sequence);
        Assert.Equal(terminalPlan.TerminalDigest, acknowledgement.OuterDigest);

        // The observation digest is consumed once, so a later duplicate ACK
        // cannot report the same receipt again.
        second.Deliver(HeartbeatAck(clock, Id(9747), reservation.Rsid,
            terminal.Sequence!.Value));
        await Task.Delay(25);
        _ = Assert.Single(observations.Rows, item => item.Phase ==
            RbpRecoveryCarrierObservationPhase.Acknowledged &&
            item.Sequence == terminal.Sequence);

        await StopAfterAssertedConnectionFailureAsync(
            coordinator, stop, run, () => first.CloseCount > 0);
    }

    [Fact]
    public async Task C39C1dPrePeerTerminalFaultRetainsAuthorityThenRestartsExactlyOnce()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(envelope =>
            envelope.Type == "heartbeat" ? null : responder.Respond(envelope),
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0203");
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var second = new FakeConnectionCycle(envelope =>
            envelope.Type == "session_resume"
                ? RecoveryResumeAck(clock, envelope,
                    reservation.CurrentReservedSequence)
                : envelope.Type == "heartbeat" ? null : responder.Respond(envelope),
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0204");
        var observations = new RecordingRecoveryCarrierObservationSink();
        int prePeerCalls = 0;
        var prePeerEntered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(first, second), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                RouteProofHelloProfile()),
            new RecoveryDispatcher(reservation), new RecordingInboundJournal(),
            clock, new FixedRandomSource(0),
            docContextWatcher: RouteProofWatcher(clock),
            beforeRecoveryTerminalWrite: _ =>
            {
                if (Interlocked.Increment(ref prePeerCalls) == 1)
                {
                    prePeerEntered.TrySetResult();
                    throw new RbpGatewayTransportException(
                        RbpGatewayFailureKind.Network,
                        "test terminal pre-peer fault");
                }
                return Task.CompletedTask;
            },
            recoveryCarrierObservationSink: observations);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        RbpEnvelope partial = await EventuallySentAsync(first, item =>
            item.Type == "partial" && item.Id == reservation.RecoveryInvocationId);
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => first.Sent.Any(item => item.Type == "heartbeat"));
        first.Deliver(HeartbeatAck(clock, Id(9751), reservation.Rsid,
            reservation.CurrentReservedSequence));
        await prePeerEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, Volatile.Read(ref prePeerCalls));
        Assert.DoesNotContain(first.Sent, item => item.Type == "result" &&
            item.Id == reservation.RecoveryInvocationId);
        RbpRecoveryTerminalPlan durable = Assert.Single(
            await store.ListActiveRecoveryTerminalPlansAsync());
        Assert.Equal(reservation.CurrentReservedSequence + 1,
            durable.FinalSequence);
        using (RbpRecoveredPayload? retained =
               await store.GetCorrelatedRecoveryPayloadAsync(
                   reservation.Rsid, reservation.OriginInvocationId,
                   reservation.ResultDigest))
        {
            Assert.NotNull(retained);
        }
        Assert.Empty((await store.LoadSequenceAsync(reservation.Rsid)).Outbox);

        await EventuallyAsync(() => coordinator.GetSnapshot().ConnectionGeneration == 2);
        RbpEnvelope restart = await EventuallySentAsync(second, item =>
            item.Type == "result" && item.Id == reservation.RecoveryInvocationId);
        Assert.Equal(durable.FinalSequence, restart.Sequence);
        Assert.Equal(2, Volatile.Read(ref prePeerCalls));
        _ = Assert.Single(second.Sent, item => item.Type == "result" &&
            item.Id == reservation.RecoveryInvocationId);
        RbpRecoveryCarrierObservation[] terminalWrites = observations.Rows
            .Where(item => item.Sequence == durable.FinalSequence &&
                item.Phase is RbpRecoveryCarrierObservationPhase.Write or
                    RbpRecoveryCarrierObservationPhase.RestartResend)
            .ToArray();
        Assert.Equal(2, terminalWrites.Length);
        Assert.Equal(terminalWrites[0].OuterDigest, terminalWrites[1].OuterDigest);
        Assert.Equal(RbpRecoveryCarrierObservationPhase.RestartResend,
            terminalWrites[1].Phase);

        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => second.Sent.Any(item => item.Type == "heartbeat"));
        second.Deliver(HeartbeatAck(clock, Id(9752), reservation.Rsid,
            restart.Sequence!.Value));
        await EventuallyAsync(async () =>
            !(await store.ListActiveRecoveryTerminalPlansAsync()).Any());
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(
            reservation.Rsid, reservation.OriginInvocationId,
            reservation.ResultDigest));
        await EventuallyAsync(() => observations.Rows.ToArray().Any(item =>
            item.Phase == RbpRecoveryCarrierObservationPhase.Acknowledged &&
            item.Sequence == restart.Sequence));
        _ = Assert.Single(observations.Rows.ToArray(), item =>
            item.Phase == RbpRecoveryCarrierObservationPhase.Acknowledged &&
            item.Sequence == restart.Sequence);
        Assert.Equal(partial.Sequence!.Value + 1, restart.Sequence);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task C39C1cCrashAfterFinalConfirmationBeforeWriteReconnectsOneExactReservedFrame()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(),
            new TestRecoveryPayloadProtector());
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(responder.Respond,
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0206");
        var second = new FakeConnectionCycle(responder.Respond,
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0207");
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var dispatcher = new RecoveryDispatcher(reservation);
        var diagnostics = new ConcurrentQueue<string>();
        int crashAttempts = 0;
        var postConfirmationEntered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var crashBeforeWrite = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(first, second),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                RouteProofHelloProfile()),
            dispatcher,
            new RecordingInboundJournal(),
            clock,
            new FixedRandomSource(0), RouteProofWatcher(clock),
            onDispatchDiagnostic: diagnostics.Enqueue,
            beforeRecoveryCarrierWrite: _ =>
            {
                if (Interlocked.Increment(ref crashAttempts) != 1)
                {
                    return Task.CompletedTask;
                }

                postConfirmationEntered.TrySetResult();
                return crashBeforeWrite.Task;
            });
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        // Startup scheduling consumes the durable reservation directly; no
        // inbound replay, origin dispatch, or add-in call is permitted.
        await postConfirmationEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, Volatile.Read(ref crashAttempts));
        Assert.DoesNotContain(first.Sent, item => item.Scope == RbpEnvelopeScope.Data);
        crashBeforeWrite.TrySetException(new IOException(
            "C39 post-confirmation crash before first SendAsync"));
        await EventuallyAsync(() => coordinator.GetSnapshot().ConnectionGeneration == 2);
        Assert.DoesNotContain(first.Sent, item => item.Scope == RbpEnvelopeScope.Data);

        RbpEnvelope replay = await EventuallySentAsync(second,
            item => item.Type == "partial" &&
                    item.Id == reservation.RecoveryInvocationId);
        Assert.Equal(reservation.CurrentReservedSequence, replay.Sequence);
        Assert.Equal(reservation.Rsid, replay.Rsid);
        byte[] serialized = RbpEnvelopeCodec.Encode(replay);
        Assert.Equal(serialized, RbpEnvelopeCodec.Encode(replay));
        _ = Assert.Single(second.Sent, item => item.Scope == RbpEnvelopeScope.Data &&
            item.Id == reservation.RecoveryInvocationId);
        Assert.Equal(0, dispatcher.DispatchCalls);
        Assert.Empty((await store.LoadSequenceAsync(reservation.Rsid)).Outbox);
        Assert.NotEqual(RbpRecoveryCarrierPhase.Tombstoned,
            (await store.GetRecoveryCarrierReservationAsync(
                reservation.RecoveryInvocationId))!.Phase);
        // Recovery success and the injected pre-write fault never emit raw
        // payload, base64, digest, owner, or JSON through diagnostics.
        Assert.Empty(diagnostics);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task RecoveryAckGateInstalledBeforeStopIsRemovedAfterOwnedCallbackDrains()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(
            envelope => envelope.Type == "heartbeat"
                ? null
                : responder.Respond(envelope),
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0210");
        var entered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(cycle), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                RouteProofHelloProfile()),
            new RecoveryDispatcher(reservation), new RecordingInboundJournal(),
            clock, new FixedRandomSource(0), RouteProofWatcher(clock),
            afterRecoveryCarrierWriteBeforeAck: async _ =>
            {
                entered.TrySetResult();
                await release.Task.ConfigureAwait(false);
            });
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        Task<RbpCoordinatorTeardownResult>? teardown = null;
        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
            _ = await EventuallySentAsync(cycle, item =>
                item.Type == "partial" &&
                item.Id == reservation.RecoveryInvocationId);
            clock.Advance(TimeSpan.FromSeconds(15));
            await EventuallyAsync(
                () => cycle.Sent.Any(item => item.Type == "heartbeat"));
            cycle.Deliver(HeartbeatAck(
                clock, Id(9781), reservation.Rsid,
                reservation.CurrentReservedSequence));
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal(1, RecoveryAckGateCount(coordinator));

            teardown = coordinator.RequestStopTeardown();
            stop.Cancel();
            await Task.Delay(20);
            Assert.False(teardown.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
            stop.Cancel();
        }
        Assert.NotNull(teardown);
        RbpCoordinatorTeardownResult result = await teardown.WaitAsync(
            TimeSpan.FromSeconds(2));
        Assert.Equal(
            RbpCoordinatorTeardownDisposition.NormalStopped,
            result.Disposition);
        await run.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(0, RecoveryAckGateCount(coordinator));
        Assert.Equal(1, cycle.CloseCount);
        Assert.Equal(1, cycle.DisposeCount);
    }

    [Fact]
    public async Task StopBeforeAckGateInstallStartsNoGateOrTerminalSend()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(
            envelope => envelope.Type == "heartbeat"
                ? null
                : responder.Respond(envelope),
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0211");
        var entered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(cycle), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                RouteProofHelloProfile()),
            new RecoveryDispatcher(reservation), new RecordingInboundJournal(),
            clock, new FixedRandomSource(0), RouteProofWatcher(clock),
            beforeRecoveryTerminalWrite: async _ =>
            {
                entered.TrySetResult();
                await release.Task.ConfigureAwait(false);
            },
            afterRecoveryCarrierWriteBeforeAck: _ => Task.CompletedTask);
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        Task<RbpCoordinatorTeardownResult>? teardown = null;
        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
            _ = await EventuallySentAsync(cycle, item =>
                item.Type == "partial" &&
                item.Id == reservation.RecoveryInvocationId);
            clock.Advance(TimeSpan.FromSeconds(15));
            await EventuallyAsync(
                () => cycle.Sent.Any(item => item.Type == "heartbeat"));
            cycle.Deliver(HeartbeatAck(
                clock, Id(9782), reservation.Rsid,
                reservation.CurrentReservedSequence));
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal(0, RecoveryAckGateCount(coordinator));

            teardown = coordinator.RequestStopTeardown();
            stop.Cancel();
        }
        finally
        {
            release.TrySetResult();
            stop.Cancel();
        }
        Assert.NotNull(teardown);
        _ = await teardown.WaitAsync(TimeSpan.FromSeconds(2));
        await run.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(0, RecoveryAckGateCount(coordinator));
        Assert.DoesNotContain(cycle.Sent, item =>
            item.Type == "result" &&
            item.Id == reservation.RecoveryInvocationId);
    }

    [Fact]
    public async Task StopAfterRecoveryListBeforeClaimUsesShutdownTombstoneNoSend()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        var faults = new BlockingJournalFaultInjector();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(faults),
            new TestRecoveryPayloadProtector());
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        using (RbpRecoveredPayload? initial =
               await store.GetCorrelatedRecoveryPayloadAsync(
                   reservation.Rsid,
                   reservation.OriginInvocationId,
                   reservation.ResultDigest))
        {
            Assert.NotNull(initial);
        }
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(
            responder.Respond,
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0212");
        var coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(cycle), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                RouteProofHelloProfile()),
            new RecoveryDispatcher(reservation), new RecordingInboundJournal(),
            clock, new FixedRandomSource(0), RouteProofWatcher(clock));
        using var stop = new CancellationTokenSource();
        faults.Arm(RbpJournalFaultPoint.RecoverySendStarted);
        Task run = coordinator.RunAsync(stop.Token);
        Task<RbpCoordinatorTeardownResult>? teardown = null;
        try
        {
            await faults.Entered.WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal(0, RecoverySetCount(
                coordinator, "_recoveryCarrierClaims"));
            teardown = coordinator.RequestStopTeardown();
            stop.Cancel();
        }
        finally
        {
            faults.Release();
            stop.Cancel();
        }
        Assert.NotNull(teardown);
        RbpCoordinatorTeardownResult result = await teardown.WaitAsync(
            TimeSpan.FromSeconds(2));
        Assert.Equal(
            RbpCoordinatorTeardownDisposition.NormalStopped,
            result.Disposition);
        await run.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.DoesNotContain(cycle.Sent, item =>
            item.Scope == RbpEnvelopeScope.Data);
        Assert.Equal(0, RecoverySetCount(
            coordinator, "_recoveryCarrierClaims"));
        RbpRecoveryCarrierReservation tombstoned = Assert.IsType<
            RbpRecoveryCarrierReservation>(
            await store.GetRecoveryCarrierReservationAsync(
                reservation.RecoveryInvocationId));
        Assert.Equal(RbpRecoveryCarrierPhase.Tombstoned, tombstoned.Phase);
        Assert.Equal("session_unregistered", tombstoned.TombstoneReason);
        RbpUnregisterTombstone unregister = Assert.IsType<
            RbpUnregisterTombstone>(
            await store.GetUnregisterTombstoneAsync(reservation.Rsid));
        Assert.Equal(RbpSessionUnregisterReason.BridgeShutdown, unregister.Reason);
        Assert.Equal(RbpUnregisterPhase.Pending, unregister.Phase);
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(
            reservation.Rsid,
            reservation.OriginInvocationId,
            reservation.ResultDigest));
    }

    [Fact]
    public async Task StopAfterConfirmBeforeCarrierSendClearsClaimViaShutdownTombstone()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        using (RbpRecoveredPayload? initial =
               await store.GetCorrelatedRecoveryPayloadAsync(
                   reservation.Rsid,
                   reservation.OriginInvocationId,
                   reservation.ResultDigest))
        {
            Assert.NotNull(initial);
        }
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(
            responder.Respond,
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0213");
        var entered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(cycle), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                RouteProofHelloProfile()),
            new RecoveryDispatcher(reservation), new RecordingInboundJournal(),
            clock, new FixedRandomSource(0), RouteProofWatcher(clock),
            beforeRecoveryCarrierWrite: async _ =>
            {
                entered.TrySetResult();
                await release.Task.ConfigureAwait(false);
            });
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        Task<RbpCoordinatorTeardownResult>? teardown = null;
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal(1, RecoverySetCount(
                coordinator, "_recoveryCarrierClaims"));
            teardown = coordinator.RequestStopTeardown();
            stop.Cancel();
        }
        finally
        {
            release.TrySetResult();
            stop.Cancel();
        }
        Assert.NotNull(teardown);
        RbpCoordinatorTeardownResult result = await teardown.WaitAsync(
            TimeSpan.FromSeconds(2));
        Assert.Equal(
            RbpCoordinatorTeardownDisposition.NormalStopped,
            result.Disposition);
        await run.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.DoesNotContain(cycle.Sent, item =>
            item.Scope == RbpEnvelopeScope.Data);
        Assert.Equal(0, RecoverySetCount(
            coordinator, "_recoveryCarrierClaims"));
        RbpRecoveryCarrierReservation tombstoned = Assert.IsType<
            RbpRecoveryCarrierReservation>(
            await store.GetRecoveryCarrierReservationAsync(
                reservation.RecoveryInvocationId));
        Assert.Equal(RbpRecoveryCarrierPhase.Tombstoned, tombstoned.Phase);
        Assert.Equal("session_unregistered", tombstoned.TombstoneReason);
        RbpUnregisterTombstone unregister = Assert.IsType<
            RbpUnregisterTombstone>(
            await store.GetUnregisterTombstoneAsync(reservation.Rsid));
        Assert.Equal(RbpSessionUnregisterReason.BridgeShutdown, unregister.Reason);
        Assert.Equal(RbpUnregisterPhase.Pending, unregister.Phase);
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(
            reservation.Rsid,
            reservation.OriginInvocationId,
            reservation.ResultDigest));
    }

    [Fact]
    public async Task StopDuringTerminalSourceReleaseCommitsPriorDeleteAndNoSuccessor()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        var faults = new BlockingJournalFaultInjector();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(faults),
            new TestRecoveryPayloadProtector());
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(
            envelope => envelope.Type == "heartbeat"
                ? null
                : responder.Respond(envelope),
            grantedConnectionCapabilities: RouteProofCapabilities(),
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0214");
        var coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(cycle), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                RouteProofHelloProfile()),
            new RecoveryDispatcher(reservation), new RecordingInboundJournal(),
            clock, new FixedRandomSource(0), RouteProofWatcher(clock));
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        Task<RbpCoordinatorTeardownResult>? teardown = null;
        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
            _ = await EventuallySentAsync(cycle, item =>
                item.Type == "partial" &&
                item.Id == reservation.RecoveryInvocationId);
            clock.Advance(TimeSpan.FromSeconds(15));
            await EventuallyAsync(
                () => cycle.Sent.Any(item => item.Type == "heartbeat"));
            cycle.Deliver(HeartbeatAck(
                clock, Id(9783), reservation.Rsid,
                reservation.CurrentReservedSequence));
            RbpEnvelope terminal = await EventuallySentAsync(cycle, item =>
                item.Type == "result" &&
                item.Id == reservation.RecoveryInvocationId);
            faults.Arm(RbpJournalFaultPoint.RecoveryTerminalEqualAcknowledgement);
            clock.Advance(TimeSpan.FromSeconds(15));
            await EventuallyAsync(() =>
                cycle.Sent.Count(item => item.Type == "heartbeat") >= 2);
            cycle.Deliver(HeartbeatAck(
                clock, Id(9784), reservation.Rsid,
                terminal.Sequence!.Value));
            await faults.Entered.WaitAsync(TimeSpan.FromSeconds(2));
            teardown = coordinator.RequestStopTeardown();
            stop.Cancel();
        }
        finally
        {
            faults.Release();
            stop.Cancel();
        }
        Assert.NotNull(teardown);
        _ = await teardown.WaitAsync(TimeSpan.FromSeconds(2));
        await run.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(
            reservation.Rsid,
            reservation.OriginInvocationId,
            reservation.ResultDigest));
        Assert.Empty(await store.ListActiveRecoveryTerminalPlansAsync());
        Assert.Equal(0, RecoverySetCount(
            coordinator, "_recoveryTerminalClaims"));
        _ = Assert.Single(cycle.Sent, item =>
            item.Type == "result" &&
            item.Id == reservation.RecoveryInvocationId);
    }

    [Fact]
    public void C39C1cExposesPostConfirmationPreSendCrashHook()
    {
        Assert.Contains(typeof(RbpConnectionCoordinator).GetConstructors(
            System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.NonPublic), constructor =>
            constructor.GetParameters().Any(parameter =>
                parameter.Name == "beforeRecoveryCarrierWrite" &&
                parameter.ParameterType == typeof(Func<CancellationToken, Task>)));
    }

    private static int RecoveryAckGateCount(
        RbpConnectionCoordinator coordinator) =>
        RecoverySetCount(coordinator, "_recoveryCarrierAckGates");

    private static int RecoverySetCount(
        RbpConnectionCoordinator coordinator,
        string fieldName)
    {
        FieldInfo syncField = typeof(RbpConnectionCoordinator).GetField(
            "_recoveryCarrierClaimSync",
            BindingFlags.Instance | BindingFlags.NonPublic) ??
            throw new MissingFieldException("_recoveryCarrierClaimSync");
        FieldInfo gatesField = typeof(RbpConnectionCoordinator).GetField(
            fieldName,
            BindingFlags.Instance | BindingFlags.NonPublic) ??
            throw new MissingFieldException(fieldName);
        object sync = syncField.GetValue(coordinator) ??
            throw new InvalidOperationException("Recovery gate lock is null.");
        lock (sync)
        {
            object gates = gatesField.GetValue(coordinator) ??
                throw new InvalidOperationException("Recovery gate set is null.");
            return (int)(gates.GetType().GetProperty("Count")?.GetValue(gates) ??
                throw new MissingMemberException("Recovery gate count"));
        }
    }

    [Fact]
    public void C39C1dExposesTerminalPrePeerCrashHook()
    {
        Assert.Contains(typeof(RbpConnectionCoordinator).GetConstructors(
            System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.NonPublic), constructor =>
            constructor.GetParameters().Any(parameter =>
                parameter.Name == "beforeRecoveryTerminalWrite" &&
                parameter.ParameterType == typeof(Func<CancellationToken, Task>)));
    }

    private static RbpEnvelope HeartbeatAck(
        ManualCoordinatorClock clock,
        string id,
        string rsid,
        long sequence) =>
        new(
            1,
            "heartbeat_ack",
            id,
            clock.UtcNow.ToString("O"),
            JsonSerializer.SerializeToElement(new
            {
                server_time = clock.UtcNow.ToString("O"),
                acks = new[] { new { rsid, seq = sequence } },
            }),
            RbpEnvelopeScope.Control,
            Rsid: null,
            Sequence: null,
            Acknowledgement: null,
            Hello: null,
            HelloAck: null,
            RbpEnvelopeDisposition.Known,
            RbpEnvelope.FreezeAdditionalProperties(
                new Dictionary<string, JsonElement>()));

    [Fact]
    public async Task C39ProofBearingResumeCreatesOneCausalCheckpointBeforeRestartResendAndAcknowledgement()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        const string firstConnection = "019f9add-7a83-7d11-a6a9-d2f8108c0001";
        const string secondConnection = "019f9add-7a83-7d11-a6a9-d2f8108c0002";
        string[] capability = [RbpHelloProfile.RouteRebindProofCapability];
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(envelope =>
            envelope.Type == "heartbeat" ? null : responder.Respond(envelope),
            grantedConnectionCapabilities: capability,
            connectionId: firstConnection);
        var second = new FakeConnectionCycle(envelope =>
            envelope.Type == "heartbeat" ? null : responder.Respond(envelope),
            grantedConnectionCapabilities: capability,
            connectionId: secondConnection);
        var channel = new ScriptedDocContextChannel();
        channel.SetSnapshot(7, "Project A",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        var watcher = new RbpDocContextWatcher(
            channel, clock,
            freshResumeProofReader: new ScriptedFreshResumeProofReader());
        var recovery = new RecordingRecoveryCarrierObservationSink();
        var reconnect = new RecordingReconnectObservationSink();
        var coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(first, second), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                new RbpHelloProfile("0.1.0", "WS01", "Windows 11",
                    new[] { "2026.07.26.0" }, capability)),
            new RecoveryDispatcher(reservation), new RecordingInboundJournal(),
            clock, new FixedRandomSource(0), watcher,
            recoveryCarrierObservationSink: recovery,
            reconnectObservationSink: reconnect);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        RbpEnvelope firstResume = await EventuallySentAsync(first,
            item => item.Type == "session_resume");
        Assert.True(firstResume.Payload.TryGetProperty("route_rebind_proof", out _));
        _ = await EventuallySentAsync(first, item => item.Type == "partial" &&
            item.Id == reservation.RecoveryInvocationId);
        await EventuallyAsync(() => reconnect.Rows.Any(item =>
            item.Phase == RbpReconnectObservationPhase.ResumeAcknowledgementApplied &&
            item.Generation == 1));

        first.Fail(new IOException("force a proof-bearing C39 restart resend"));
        await EventuallyAsync(() => coordinator.GetSnapshot().ConnectionGeneration == 2);
        RbpEnvelope secondResume = await EventuallySentAsync(second,
            item => item.Type == "session_resume");
        JsonElement proof = secondResume.Payload.GetProperty("route_rebind_proof");
        string expectedCheckpoint = RbpRouteRebindProof.MakeAuthorityCheckpoint(
            proof, reservation.Rsid);
        string expectedConnectionDigest = RbpRouteRebindProof.MakeConnectionDigest(
            reservation.Rsid, secondConnection);
        RbpEnvelope resent = await EventuallySentAsync(second,
            item => item.Type == "partial" &&
            item.Id == reservation.RecoveryInvocationId);

        await EventuallyAsync(() => recovery.Rows.Any(item =>
            item.Phase == RbpRecoveryCarrierObservationPhase.RestartResend &&
            item.ConnectionDigest == expectedConnectionDigest));
        RbpReconnectObservation resumeApplied = Assert.Single(reconnect.Rows,
            item => item.Phase ==
                RbpReconnectObservationPhase.ResumeAcknowledgementApplied &&
                item.Generation == 2);
        RbpRecoveryCarrierObservation[] sameRoute = recovery.Rows
            .Where(item => item.ConnectionDigest == expectedConnectionDigest)
            .ToArray();
        RbpRecoveryCarrierObservation materialized = Assert.Single(sameRoute,
            item => item.Phase == RbpRecoveryCarrierObservationPhase.Materialized);
        RbpRecoveryCarrierObservation restart = Assert.Single(sameRoute,
            item => item.Phase == RbpRecoveryCarrierObservationPhase.RestartResend);
        Assert.Equal(expectedCheckpoint, resumeApplied.RouteAuthorityCheckpoint);
        Assert.Equal(expectedConnectionDigest, resumeApplied.ConnectionDigest);
        Assert.True(resumeApplied.RouteRebindProofGranted);
        Assert.Equal(expectedCheckpoint, materialized.RouteAuthorityCheckpoint);
        Assert.Equal(expectedCheckpoint, restart.RouteAuthorityCheckpoint);
        Assert.Equal(expectedConnectionDigest, materialized.ConnectionDigest);
        Assert.Equal(expectedConnectionDigest, restart.ConnectionDigest);
        Assert.Equal(materialized.OuterDigest, restart.OuterDigest);
        Assert.Equal(resent.Sequence, restart.Sequence);
        Assert.True(resumeApplied.CausalOrdinal < restart.CausalOrdinal);

        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => second.Sent.Any(item => item.Type == "heartbeat"));
        second.Deliver(HeartbeatAck(clock, Id(9762), reservation.Rsid,
            reservation.CurrentReservedSequence));
        await EventuallyAsync(() => recovery.Rows.Any(item =>
            item.Phase == RbpRecoveryCarrierObservationPhase.Acknowledged &&
            item.ConnectionDigest == expectedConnectionDigest));
        RbpRecoveryCarrierObservation acknowledged = Assert.Single(recovery.Rows,
            item => item.Phase == RbpRecoveryCarrierObservationPhase.Acknowledged &&
            item.ConnectionDigest == expectedConnectionDigest);
        Assert.Equal(expectedCheckpoint, acknowledged.RouteAuthorityCheckpoint);
        Assert.Equal(expectedConnectionDigest, acknowledged.ConnectionDigest);
        Assert.True(restart.CausalOrdinal < acknowledged.CausalOrdinal);

        // The failed first cycle must not retain a checkpoint alongside the
        // second cycle, and shutdown must erase the final correlation too.
        Assert.Equal(1, RouteAuthorityCheckpointCount(coordinator));
        string diagnostic = JsonSerializer.Serialize(new
        {
            reconnect = reconnect.Rows,
            recovery = recovery.Rows,
        });
        Assert.DoesNotContain(reservation.Rsid, diagnostic, StringComparison.Ordinal);
        Assert.DoesNotContain(secondConnection, diagnostic, StringComparison.Ordinal);
        Assert.DoesNotContain(proof.GetProperty("proof_id").GetString()!, diagnostic,
            StringComparison.Ordinal);
        Assert.DoesNotContain("Project A", diagnostic, StringComparison.Ordinal);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, RouteAuthorityCheckpointCount(coordinator));
    }

    [Fact]
    public async Task ProoflessResumePublishesNoCheckpointAuthority()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        const string rsid = "rs-8080";
        _ = await store.PersistRegisteredSessionAsync(
            Registration(LocalSession(8080, 1000), rsid));
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var reconnect = new RecordingReconnectObservationSink();
        var coordinator = new RbpConnectionCoordinator(
            new FakeConnectionCycleFactory(cycle), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                new RbpHelloProfile("0.1.0", "WS01", "Windows 11",
                    new[] { "2026.07.26.0" })),
            new StubInvocationDispatcher(), new RecordingInboundJournal(),
            clock, new FixedRandomSource(0),
            reconnectObservationSink: reconnect);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        RbpEnvelope resume = await EventuallySentAsync(cycle,
            item => item.Type == "session_resume");
        Assert.False(resume.Payload.TryGetProperty("route_rebind_proof", out _));
        await EventuallyAsync(() => reconnect.Rows.Any());
        RbpReconnectObservation observed = Assert.Single(reconnect.Rows,
            item => item.Phase ==
                RbpReconnectObservationPhase.ResumeAcknowledgementApplied);
        Assert.Null(observed.RouteAuthorityCheckpoint);
        Assert.False(observed.RouteRebindProofGranted);
        Assert.Equal(0, RouteAuthorityCheckpointCount(coordinator));

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private static int RouteAuthorityCheckpointCount(
        RbpConnectionCoordinator coordinator)
    {
        FieldInfo field = typeof(RbpConnectionCoordinator).GetField(
            "_routeAuthorityCheckpoints", BindingFlags.Instance |
            BindingFlags.NonPublic)!;
        return ((ICollection)field.GetValue(coordinator)!).Count;
    }

    private static string[] RouteProofCapabilities() =>
        [RbpHelloProfile.RouteRebindProofCapability];

    private static RbpHelloProfile RouteProofHelloProfile() =>
        new("0.1.0", "WS01", "Windows 11", new[] { "2026.07.26.0" },
            RouteProofCapabilities());

    private static RbpDocContextWatcher RouteProofWatcher(
        ManualCoordinatorClock clock)
    {
        var channel = new ScriptedDocContextChannel();
        channel.SetSnapshot(1, "Project A",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        return new RbpDocContextWatcher(
            channel, clock,
            freshResumeProofReader: new ScriptedFreshResumeProofReader());
    }

    private static RbpEnvelope RecoveryResumeAck(
        ManualCoordinatorClock clock,
        RbpEnvelope request,
        long lastReceivedSequence) =>
        new(
            1,
            "resume_ack",
            Id(9737),
            clock.UtcNow.ToString("O"),
            JsonSerializer.SerializeToElement(new
            {
                rsid = request.Payload.GetProperty("rsid").GetString(),
                last_rx_seq = lastReceivedSequence,
                resume_expires_at = "2026-07-27T10:00:00.000Z",
            }),
            RbpEnvelopeScope.Control,
            Rsid: null,
            Sequence: null,
            Acknowledgement: null,
            Hello: null,
            HelloAck: null,
            RbpEnvelopeDisposition.Known,
            RbpEnvelope.FreezeAdditionalProperties(
                new Dictionary<string, JsonElement>()));

    private static async Task<RbpRecoveryCarrierReservation>
        PrepareRecoveryReservationAsync(RbpJournalStore store)
    {
        const string rsid = "rs-8080";
        string originId = Id(9702);
        string recoveryId = Id(9703);
        _ = await store.PersistRegisteredSessionAsync(
            Registration(LocalSession(8080, 1000), rsid));
        var origin = new RbpInvocationIdentity(
            rsid, originId, "get_current_view_info", false, null,
            "sha256:" + new string('a', 64), "{\"decision\":\"allow\"}", "[]");
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        byte[] raw = Encoding.UTF8.GetBytes("{\"jsonrpc\":\"2.0\",\"result\":{\"recovered\":true}}");
        string digest = "sha256:" + Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
        using JsonDocument outcome = JsonDocument.Parse("{\"outcome\":\"completed\"}");
        _ = await store.PersistInvocationTerminalAsync(origin.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed,
                outcome.RootElement.Clone(), digest,
                RecoveryPayload: new RbpRecoveryPayload(digest, raw)));
        var recovery = new RbpInvocationIdentity(
            rsid, recoveryId, "dispatch_payload_recovery", false, null,
            "sha256:" + new string('b', 64), "{\"decision\":\"auto\"}", "[]");
        _ = await store.AdmitInvocationAsync(recovery);
        await store.MarkInvocationExecutingAsync(recovery.IdempotencyKey);
        return await store.PersistProtectedRecoveryTerminalAndReserveAsync(
            new RbpRecoveryCarrierReservationRequest(
                rsid, recoveryId, originId, digest, raw.Length,
                new RbpRecoveryCarrierHeader("application/json", "base64"),
                "sha256:" + new string('c', 64),
                DateTimeOffset.UtcNow.AddHours(1)));
    }

    private sealed class RecoveryDispatcher(RbpRecoveryCarrierReservation reservation)
        : IRbpInvocationDispatcher
    {
        private readonly RbpInFlightGate _gate = new();

        internal int DispatchCalls { get; private set; }

        public IRbpInvocationClaim? TryClaim(string rsid) =>
            _gate.TryEnter(rsid) ? new GateClaim(_gate, rsid) : null;

        public IRbpInvocationClaim? TryClaim(
            string rsid,
            RbpInvocationAuthoritySnapshot authority) =>
            _gate.TryEnter(rsid)
                ? new GateClaim(_gate, rsid, authority)
                : null;

        public Task<RbpInvocationAnswer> DispatchClaimedAsync(
            IRbpInvocationClaim claim, JsonElement payload,
            IReadOnlyList<string> capabilities, CancellationToken cancellationToken)
        {
            _ = claim;
            _ = payload;
            _ = capabilities;
            _ = cancellationToken;
            DispatchCalls++;
            return Task.FromResult(RbpInvocationAnswer.Recovery(reservation));
        }

        public RbpInvocationAnswer RejectConcurrent(string invocationId) =>
            RbpInvocationAnswer.Error(Json("{}"));
    }

    private sealed class ThrowingRecoveryChannel : IRbpInvocationChannel
    {
        internal int Calls { get; private set; }

        public Task<RbpAddinOutcome> InvokeAsync(
            string rsid,
            RevAgent.Bridge.AddinLoopback.AddinCall call,
            CancellationToken cancellationToken)
        {
            _ = rsid;
            _ = call;
            _ = cancellationToken;
            Calls++;
            throw new InvalidOperationException(
                "C39 correlated recovery must not reach the add-in or origin.");
        }
    }

    private sealed class RecordingRecoveryCarrierObservationSink :
        IRbpRecoveryCarrierObservationSink
    {
        internal List<RbpRecoveryCarrierObservation> Rows { get; } = [];

        public void Observe(RbpRecoveryCarrierObservation observation) =>
            Rows.Add(observation);
    }

    private sealed class RecordingReconnectObservationSink :
        IRbpReconnectObservationSink
    {
        internal List<RbpReconnectObservation> Rows { get; } = [];

        public void Observe(RbpReconnectObservation observation) =>
            Rows.Add(observation);
    }
}
