using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

public sealed class RbpRecoveryCarrierPlanTests
{
    [Fact]
    public async Task HeaderAndChunkBoundsAreStrictAndRetentionMayPruneDetailedTombstoneButNeverItsMinimalFence()
    {
        using var directory = new RbpJournalTestDirectory();
        long now = RbpJournalTestData.Now.ToUnixTimeMilliseconds();
        await using RbpJournalStore store = RbpJournalStore.Open(directory.JournalPath,
            new TestResumeTokenProtector(), RbpJournalTestData.Options(nowMilliseconds: () => now), new TestRecoveryPayloadProtector());
        _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        var origin = new RbpInvocationIdentity("rs-test", "0197a3c2-0000-7000-8000-0000000000e3", "read",
            false, null, "sha256:" + new string('c', 64), "{\"decision\":\"allow\"}", "[]");
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        byte[] raw = Encoding.UTF8.GetBytes("{\"sentinel\":\"not-in-reservation\"}");
        string digest = "sha256:" + Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
        using JsonDocument outcome = JsonDocument.Parse("{\"outcome\":\"completed\"}");
        _ = await store.PersistInvocationTerminalAsync(origin.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed, outcome.RootElement.Clone(), digest,
                RecoveryPayload: new RbpRecoveryPayload(digest, raw)));
        var bad = new RbpRecoveryCarrierReservationRequest(origin.Rsid,
            "0197a3c2-0000-7000-8000-0000000000e4", origin.InvocationId, digest,
            1_048_577, new RbpRecoveryCarrierHeader("text/plain", "base64"),
            "sha256:" + new string('d', 64), RbpJournalTestData.Now.AddHours(1));
        _ = await Assert.ThrowsAsync<ArgumentException>(() => store.PersistProtectedRecoveryTerminalAndReserveAsync(bad));

        var request = bad with { ChunkSize = raw.Length, Header = new RbpRecoveryCarrierHeader("application/json", "base64") };
        RbpRecoveryCarrierReservation reserved = await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
        _ = await store.MarkRecoveryCarrierSendStartedAsync(reserved.RecoveryInvocationId);
        RbpRecoveryCarrierReservation tombstone = (await store.ApplyRecoveryCarrierFenceAcknowledgementAsync(origin.Rsid, 2))!;
        Assert.Equal(RbpRecoveryCarrierPhase.Tombstoned, tombstone.Phase);
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(origin.Rsid, origin.InvocationId, digest));

        // The seven-day floor is not a deletion permission.  The detailed
        // audit record survives before the full fourteen-day default window.
        now += (long)TimeSpan.FromDays(6).TotalMilliseconds;
        _ = await store.ApplyRetentionAsync(TimeSpan.FromDays(7));
        Assert.Equal(RbpRecoveryCarrierPhase.Tombstoned,
            (await store.GetRecoveryCarrierReservationAsync(request.RecoveryInvocationId))!.Phase);

        // After the full default window the non-secret detailed row may go,
        // but only the production tombstone path (never test SQL) may leave
        // the minimal, restart-stable dispatch fence behind.
        now += (long)TimeSpan.FromDays(9).TotalMilliseconds;
        _ = await store.ApplyRetentionAsync();
        Assert.Null(await store.GetRecoveryCarrierReservationAsync(request.RecoveryInvocationId));
        await store.DisposeAsync();
        await using RbpJournalStore reopened = RbpJournalStore.Open(directory.JournalPath,
            new TestResumeTokenProtector(), RbpJournalTestData.Options(nowMilliseconds: () => now), new TestRecoveryPayloadProtector());
        _ = await Assert.ThrowsAsync<RbpJournalException>(() => reopened.QueueOutboundDataAsync(origin.Rsid,
            new RbpOutboundDataDraft("result", "still-blocked", RbpJournalTestData.Json("{}"))));
    }

    [Fact]
    public async Task ReopenPreservesExactReservedCarrierMetadataAndPredecessorFence()
    {
        using var directory = new RbpJournalTestDirectory();
        RbpRecoveryCarrierReservation reservation;
        RbpRecoveryCarrierReservationRequest request;
        await using (RbpJournalStore store = OpenStore(directory))
        {
            (RbpInvocationIdentity origin, byte[] raw, string digest) =
                await PersistRecoverableTerminalAsync(
                    store, "0197a3c2-0000-7000-8000-0000000000f1");
            request = new RbpRecoveryCarrierReservationRequest(
                origin.Rsid, "0197a3c2-0000-7000-8000-0000000000f2", origin.InvocationId, digest,
                raw.Length, new RbpRecoveryCarrierHeader("application/json", "base64"),
                "sha256:" + new string('e', 64), RbpJournalTestData.Now.AddHours(1));
            reservation = await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
            Assert.Equal(RbpRecoveryCarrierPhase.Reserved, reservation.Phase);
            Assert.Equal(1, reservation.CurrentReservedSequence);
            Assert.Equal("{\"content_encoding\":\"base64\",\"content_type\":\"application/json\",\"v\":1}", reservation.HeaderJcs);
        }

        await using RbpJournalStore reopened = OpenStore(directory);
        RbpRecoveryCarrierReservation recovered =
            (await reopened.GetRecoveryCarrierReservationAsync(request.RecoveryInvocationId))!;
        Assert.Equal(reservation.Rsid, recovered.Rsid);
        Assert.Equal(reservation.OriginInvocationId, recovered.OriginInvocationId);
        Assert.Equal(reservation.ResultDigest, recovered.ResultDigest);
        Assert.Equal(reservation.CurrentReservedSequence, recovered.CurrentReservedSequence);
        Assert.Equal(reservation.HeaderJcs, recovered.HeaderJcs);
        Assert.Equal(reservation.PlanVersion, recovered.PlanVersion);
        Assert.Equal(RbpRecoveryCarrierPhase.SendStarted,
            (await reopened.MarkRecoveryCarrierSendStartedAsync(request.RecoveryInvocationId)).Phase);
        Assert.Equal(RbpRecoveryCarrierPhase.SendStarted,
            (await reopened.ApplyRecoveryCarrierFenceAcknowledgementAsync(reservation.Rsid, 0))!.Phase);
        Assert.Equal(RbpRecoveryCarrierPhase.Completed,
            (await reopened.ApplyRecoveryCarrierFenceAcknowledgementAsync(reservation.Rsid, 1))!.Phase);
        Assert.Null(await reopened.ApplyRecoveryCarrierFenceAcknowledgementAsync(reservation.Rsid, 1));
    }

    [Fact]
    public async Task RecoveryAndGenericAllocatorsSerializeWithoutSequenceCollisionThenFenceLaterGenericDispatch()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        (RbpInvocationIdentity origin, byte[] raw, string digest) =
            await PersistRecoverableTerminalAsync(
                store, "0197a3c2-0000-7000-8000-0000000000d1");
        var request = new RbpRecoveryCarrierReservationRequest(
            origin.Rsid, "0197a3c2-0000-7000-8000-0000000000d2", origin.InvocationId, digest,
            raw.Length, new RbpRecoveryCarrierHeader("application/json", "base64"),
            "sha256:" + new string('f', 64), RbpJournalTestData.Now.AddHours(1));

        Task<RbpRecoveryCarrierReservation> reserve =
            store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
        Task<RbpQueueOutboundResult> generic = store.QueueOutboundDataAsync(
            origin.Rsid, new RbpOutboundDataDraft("result", "generic-race", RbpJournalTestData.Json("{}")));
        RbpRecoveryCarrierReservation fenced = await reserve;
        try
        {
            RbpQueueOutboundResult ordinary = await generic;
            Assert.NotNull(ordinary.Envelope);
            Assert.NotEqual(ordinary.Envelope!.Sequence, fenced.CurrentReservedSequence);
            Assert.Equal(2, (await store.LoadSequenceAsync(origin.Rsid)).HighestTxSequence);
        }
        catch (RbpJournalException exception)
        {
            Assert.Equal(RbpJournalErrorCode.ProtocolConflict, exception.ErrorCode);
            Assert.Equal(fenced.CurrentReservedSequence,
                (await store.LoadSequenceAsync(origin.Rsid)).HighestTxSequence);
        }
        _ = await Assert.ThrowsAsync<RbpJournalException>(() => store.QueueOutboundDataAsync(
            origin.Rsid, new RbpOutboundDataDraft("result", "generic-after-fence", RbpJournalTestData.Json("{}"))));
    }

    [Fact]
    public async Task ExactProtectedTerminalReservesCurrentSequenceWithoutOutboxPayload()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        var origin = new RbpInvocationIdentity(
            "rs-test", "0197a3c2-0000-7000-8000-0000000000e1", "get_current_view_info",
            false, null, "sha256:" + new string('a', 64), "{\"decision\":\"allow\"}", "[]");
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        byte[] raw = Encoding.UTF8.GetBytes("{\"jsonrpc\":\"2.0\",\"result\":{\"x\":1}}");
        string digest = "sha256:" + Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
        using JsonDocument outcome = JsonDocument.Parse("{\"outcome\":\"completed\"}");
        _ = await store.PersistInvocationTerminalAsync(origin.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed, outcome.RootElement.Clone(), digest,
                RecoveryPayload: new RbpRecoveryPayload(digest, raw)));

        var request = new RbpRecoveryCarrierReservationRequest(
            origin.Rsid, "0197a3c2-0000-7000-8000-0000000000e2", origin.InvocationId, digest,
            raw.Length, new RbpRecoveryCarrierHeader("application/json", "base64"),
            "sha256:" + new string('b', 64),
            RbpJournalTestData.Now.AddHours(1));
        RbpRecoveryCarrierReservation reservation =
            await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);

        Assert.Equal(RbpRecoveryCarrierPhase.Reserved, reservation.Phase);
        Assert.Equal(1, reservation.CurrentReservedSequence);
        RbpSequenceState state = await store.LoadSequenceAsync(origin.Rsid);
        Assert.Equal(1, state.HighestTxSequence);
        Assert.Equal(2, state.NextTxSequence);
        Assert.Empty(state.Outbox);
        _ = await Assert.ThrowsAsync<RbpJournalException>(() => store.QueueOutboundDataAsync(
            origin.Rsid, new RbpOutboundDataDraft("result", "blocked", RbpJournalTestData.Json("{}"))));

        RbpRecoveryCarrierReservation replay =
            await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
        Assert.Equal(reservation, replay);
        RbpRecoveryCarrierReservation started = await store.MarkRecoveryCarrierSendStartedAsync(
            request.RecoveryInvocationId);
        Assert.Equal(RbpRecoveryCarrierPhase.SendStarted, started.Phase);
        Assert.Equal(RbpRecoveryCarrierPhase.SendStarted,
            (await store.ApplyRecoveryCarrierFenceAcknowledgementAsync(origin.Rsid, 0))!.Phase);
        Assert.Equal(RbpRecoveryCarrierPhase.Completed,
            (await store.ApplyRecoveryCarrierFenceAcknowledgementAsync(origin.Rsid, 1))!.Phase);
        Assert.Equal(1, (await store.LoadSequenceAsync(origin.Rsid)).LastPeerAcknowledgement);

        RbpQueueOutboundResult next = await store.QueueOutboundDataAsync(origin.Rsid,
            new RbpOutboundDataDraft("result", "after-recovery", RbpJournalTestData.Json("{}")));
        Assert.Equal(2, next.Envelope!.Sequence);
    }

    private static RbpJournalStore OpenStore(RbpJournalTestDirectory directory) =>
        RbpJournalStore.Open(directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());

    private static async Task<(RbpInvocationIdentity Origin, byte[] Raw, string Digest)> PersistRecoverableTerminalAsync(
        RbpJournalStore store,
        string invocationId)
    {
        _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        var origin = new RbpInvocationIdentity("rs-test", invocationId, "get_current_view_info",
            false, null, "sha256:" + new string('a', 64), "{\"decision\":\"allow\"}", "[]");
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        byte[] raw = Encoding.UTF8.GetBytes("{\"jsonrpc\":\"2.0\",\"result\":{\"recovered\":true}}");
        string digest = "sha256:" + Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
        using JsonDocument outcome = JsonDocument.Parse("{\"outcome\":\"completed\"}");
        _ = await store.PersistInvocationTerminalAsync(origin.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed, outcome.RootElement.Clone(), digest,
                RecoveryPayload: new RbpRecoveryPayload(digest, raw)));
        return (origin, raw, digest);
    }
}
