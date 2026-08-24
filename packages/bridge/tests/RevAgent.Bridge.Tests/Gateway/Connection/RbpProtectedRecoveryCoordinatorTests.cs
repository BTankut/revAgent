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
        var cycle = new FakeConnectionCycle(responder.Respond);
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            new RecordingInboundJournal(),
            invocationDispatcher: new RecoveryDispatcher(reservation));
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
        Assert.Equal(reservation.AcknowledgementCursor, partial.Acknowledgement);
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
            Json($$"""{"invocation_id":"{{reservation.RecoveryInvocationId}}"}""")));
        await EventuallyAsync(async () =>
            (await store.GetReceiveFrontierAsync(reservation.Rsid))
                .LastJournaledSequence == 2);
        await Task.Delay(25);
        _ = Assert.Single(cycle.Sent, item =>
            item.Scope == RbpEnvelopeScope.Data &&
            item.Id == reservation.RecoveryInvocationId);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
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
        var first = new FakeConnectionCycle(responder.Respond);
        var second = new FakeConnectionCycle(responder.Respond);
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(first, second),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            new RecordingInboundJournal(),
            invocationDispatcher: new RecoveryDispatcher(reservation));
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
            envelope.Type == "heartbeat" ? null : responder.Respond(envelope));
        RbpRecoveryCarrierReservation reservation =
            await PrepareRecoveryReservationAsync(store);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            new RecordingInboundJournal(),
            invocationDispatcher: new RecoveryDispatcher(reservation));
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
    public void C39C1cExposesPostConfirmationPreSendCrashHook()
    {
        Assert.Contains(typeof(RbpConnectionCoordinator).GetConstructors(
            System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.NonPublic), constructor =>
            constructor.GetParameters().Any(parameter =>
                parameter.Name == "beforeRecoveryCarrierWrite" &&
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

        public IRbpInvocationClaim? TryClaim(string rsid) =>
            _gate.TryEnter(rsid) ? new GateClaim(_gate, rsid) : null;

        public Task<RbpInvocationAnswer> DispatchClaimedAsync(
            IRbpInvocationClaim claim, JsonElement payload,
            IReadOnlyList<string> capabilities, CancellationToken cancellationToken) =>
            Task.FromResult(RbpInvocationAnswer.Recovery(reservation));

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
}
