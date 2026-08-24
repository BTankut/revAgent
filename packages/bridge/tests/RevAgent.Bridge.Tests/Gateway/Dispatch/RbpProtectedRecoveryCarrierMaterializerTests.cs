using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

/// <summary>
/// C39 materialization is source-backed: its caller has only the recovery id
/// and RSID, and every byte comes back from a fresh protected journal read.
/// No artifact spool or ordinary RBP outbox participates in this path.
/// </summary>
public sealed class RbpProtectedRecoveryCarrierMaterializerTests
{
    private const string Rsid = "rs-test";
    private const string OriginId = "0197a3c2-0000-7000-8000-0000000000c1";
    private const string RecoveryId = "0197a3c2-0000-7000-8000-0000000000c2";

    [Fact]
    public async Task FreshStoreReloadMaterializesExactNoncanonicalJsonBytesFromOnlyRsidAndRecoveryId()
    {
        using var directory = new RbpJournalTestDirectory();
        byte[] raw = Encoding.UTF8.GetBytes("{\"z\": 1, \"a\":[true, false]}");
        await using (RbpJournalStore store = await OpenAsync(directory))
        {
            await ReserveAndStartAsync(store, raw);
        }

        await using RbpJournalStore reopened = await OpenAsync(directory, register: false);
        RbpRecoveryCarrierMaterializedFrame? frame = await new RbpProtectedRecoveryCarrierMaterializer(reopened)
            .MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None);

        RbpRecoveryCarrierMaterializedFrame materialized = Assert.IsType<RbpRecoveryCarrierMaterializedFrame>(frame);
        Assert.Equal(1, materialized.ReservedSequence);
        Assert.Equal(1, materialized.PlanVersion);
        RbpInvocationAnswer answer = materialized.Answer;
        Assert.Equal("partial", answer.Type);
        JsonElement chunk = answer.Payload;
        Assert.Equal(RecoveryId, chunk.GetProperty("invocation_id").GetString());
        Assert.Equal("result", chunk.GetProperty("stream_id").GetString());
        Assert.Equal("base64", chunk.GetProperty("encoding").GetString());
        Assert.Equal(raw, Convert.FromBase64String(chunk.GetProperty("data").GetString()!));
        Assert.Empty((await reopened.LoadSequenceAsync(Rsid)).Outbox);
        Assert.False(Directory.Exists(Path.Combine(directory.Path, "artifact-spool")));
    }

    [Fact]
    public async Task WrongRsidAndUnsentReservationNeverMaterializeOrWriteWireState()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        await ReserveAndStartAsync(store, Encoding.UTF8.GetBytes("{\"ok\":true}"), start: false);
        var materializer = new RbpProtectedRecoveryCarrierMaterializer(store);
        Assert.Null(await materializer.MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        Assert.Null(await materializer.MaterializeCurrentAsync(RecoveryId, "rs-forged", CancellationToken.None));
        Assert.Empty((await store.LoadSequenceAsync(Rsid)).Outbox);
    }

    [Fact]
    public async Task InvalidUtf8OrJsonIsDeniedWithoutSpoolOrOutbox()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        await ReserveAndStartAsync(store, new byte[] { 0xff, 0xfe });
        Assert.Null(await new RbpProtectedRecoveryCarrierMaterializer(store)
            .MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        Assert.Empty((await store.LoadSequenceAsync(Rsid)).Outbox);
        Assert.False(Directory.Exists(Path.Combine(directory.Path, "artifact-spool")));
    }

    [Fact]
    public async Task ConcurrentMaterializationsAreDeterministicAndCarryTheSameEpochTaggedDraft()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        byte[] raw = Encoding.UTF8.GetBytes("{\"noncanonical\":  true}");
        await ReserveAndStartAsync(store, raw);
        var materializer = new RbpProtectedRecoveryCarrierMaterializer(store);
        RbpRecoveryCarrierMaterializedFrame?[] frames = await Task.WhenAll(
            materializer.MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None),
            materializer.MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        RbpRecoveryCarrierMaterializedFrame first = Assert.IsType<RbpRecoveryCarrierMaterializedFrame>(frames[0]);
        RbpRecoveryCarrierMaterializedFrame second = Assert.IsType<RbpRecoveryCarrierMaterializedFrame>(frames[1]);
        Assert.Equal(first.ReservedSequence, second.ReservedSequence);
        Assert.Equal(first.PlanVersion, second.PlanVersion);
        Assert.Equal(first.Answer.Payload.GetProperty("data").GetString(), second.Answer.Payload.GetProperty("data").GetString());
        Assert.Empty((await store.LoadSequenceAsync(Rsid)).Outbox);
    }

    [Fact]
    public async Task AuthoritativeUnregisterTombstoneDeniesMaterializationWithoutAnyDraft()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        await ReserveAndStartAsync(store, Encoding.UTF8.GetBytes("{\"ok\":true}"));
        _ = await store.RecordUnregisterIntentAsync(Rsid, RbpSessionUnregisterReason.OperatorRequested);
        Assert.Null(await new RbpProtectedRecoveryCarrierMaterializer(store)
            .MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        Assert.Empty((await store.LoadSequenceAsync(Rsid)).Outbox);
    }

    [Fact]
    public async Task MinimalRecoveryFenceTombstoneDeniesMaterializationAndNeverCreatesAnOrdinaryWireEnvelope()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        await ReserveAndStartAsync(store, Encoding.UTF8.GetBytes("{\"ok\":true}"));
        RbpRecoveryCarrierReservation tombstone = Assert.IsType<RbpRecoveryCarrierReservation>(
            await store.ApplyRecoveryCarrierFenceAcknowledgementAsync(Rsid, 2));
        Assert.Equal(RbpRecoveryCarrierPhase.Tombstoned, tombstone.Phase);
        Assert.Null(await new RbpProtectedRecoveryCarrierMaterializer(store)
            .MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        Assert.Empty((await store.LoadSequenceAsync(Rsid)).Outbox);
    }

    [Fact]
    public void PostSnapshotDriftRequiresADeterministicMaterializerTestInterlock()
    {
        // The implementation performs a second authoritative read, but has no
        // injectable point between the two reads. Without this seam a test
        // cannot deterministically tombstone/advance the reservation in that
        // interval and prove the method returns null before a draft exists.
        Assert.NotNull(typeof(RbpProtectedRecoveryCarrierMaterializer).GetProperty(
            "TestBeforePostSnapshotRecheck"));
    }

    private static async Task<RbpJournalStore> OpenAsync(RbpJournalTestDirectory directory, bool register = true)
    {
        RbpJournalStore store = RbpJournalStore.Open(directory.JournalPath,
            new TestResumeTokenProtector(), RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        if (register) _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        return store;
    }

    private static async Task ReserveAndStartAsync(RbpJournalStore store, byte[] raw, bool start = true)
    {
        string digest = "sha256:" + Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
        var origin = new RbpInvocationIdentity(Rsid, OriginId, "get_current_view_info", false, null,
            "sha256:" + new string('a', 64), "{\"decision\":\"allow\"}", "[]");
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        _ = await store.PersistInvocationTerminalAsync(origin.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed,
                RbpJournalTestData.Json("{\"outcome\":\"completed\"}"), digest,
                RecoveryPayload: new RbpRecoveryPayload(digest, raw)));
        var recovery = new RbpInvocationIdentity(Rsid, RecoveryId, "dispatch_payload_recovery", false, null,
            "sha256:" + new string('b', 64), "{\"decision\":\"allow\"}", "[]");
        _ = await store.AdmitInvocationAsync(recovery);
        await store.MarkInvocationExecutingAsync(recovery.IdempotencyKey);
        var request = new RbpRecoveryCarrierReservationRequest(Rsid, RecoveryId, OriginId, digest,
            raw.Length, new RbpRecoveryCarrierHeader("application/json", "base64"),
            "sha256:" + new string('e', 64), DateTimeOffset.UtcNow.AddHours(1));
        _ = await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
        if (start) _ = await store.MarkRecoveryCarrierSendStartedAsync(RecoveryId);
    }
}
