using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

public sealed class RbpRecoveryCarrierPlanTests
{
    [Fact]
    public async Task HeaderAndChunkBoundsAreStrictAndTombstoneDeletesRawMaterial()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(directory.JournalPath,
            new TestResumeTokenProtector(), RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
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
        await store.DisposeAsync();
        using (var connection = new SqliteConnection($"Data Source={directory.JournalPath}"))
        {
            connection.Open();
            using SqliteCommand prune = connection.CreateCommand();
            prune.CommandText = "DELETE FROM rbp_recovery_carrier_reservations WHERE rsid='rs-test';";
            _ = prune.ExecuteNonQuery();
        }
        await using RbpJournalStore reopened = RbpJournalStore.Open(directory.JournalPath,
            new TestResumeTokenProtector(), RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        _ = await Assert.ThrowsAsync<RbpJournalException>(() => reopened.QueueOutboundDataAsync(origin.Rsid,
            new RbpOutboundDataDraft("result", "still-blocked", RbpJournalTestData.Json("{}"))));
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
}
