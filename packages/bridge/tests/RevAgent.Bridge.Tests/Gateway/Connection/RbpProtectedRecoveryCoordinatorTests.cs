using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
        Assert.NotEqual(
            Rfc8785Json.Sha256Digest(partial.Payload),
            "sha256:" + Convert.ToHexString(SHA256.HashData(
                RbpEnvelopeCodec.Encode(partial))).ToLowerInvariant());

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

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
}
