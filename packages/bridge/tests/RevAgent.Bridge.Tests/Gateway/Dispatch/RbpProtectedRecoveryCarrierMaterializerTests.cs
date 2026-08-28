using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
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
        Assert.Equal(0, CountOutbox(directory.JournalPath));
    }

    [Fact]
    public async Task InvalidUtf8OrJsonIsDeniedWithoutSpoolOrOutbox()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        await ReserveAndStartAsync(store, new byte[] { 0xff, 0xfe });
        Assert.Null(await new RbpProtectedRecoveryCarrierMaterializer(store)
            .MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        Assert.Equal(0, CountOutbox(directory.JournalPath));
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
        Assert.Equal(0, CountOutbox(directory.JournalPath));
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
        Assert.Equal(0, CountOutbox(directory.JournalPath));
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
        Assert.Equal(0, CountOutbox(directory.JournalPath));
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

    [Fact]
    public async Task PostSnapshotTombstoneProducesNoDraftOrOrdinaryWireState()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        await ReserveAndStartAsync(store, Encoding.UTF8.GetBytes("{\"ok\":true}"));
        var materializer = new RbpProtectedRecoveryCarrierMaterializer(store)
        {
            TestBeforePostSnapshotRecheck = async _ =>
            {
                RbpRecoveryCarrierReservation? ignored =
                    await store.ApplyRecoveryCarrierFenceAcknowledgementAsync(Rsid, 2);
            },
        };

        Assert.Null(await materializer.MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        Assert.Equal(0, CountOutbox(directory.JournalPath));
        Assert.Equal(RbpRecoveryCarrierPhase.Tombstoned,
            (await store.GetRecoveryCarrierReservationAsync(RecoveryId))!.Phase);
    }

    [Fact]
    public async Task PostSnapshotAcknowledgementAdvanceProducesNoStaleDraft()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        byte[] raw = JsonBytes(RbpArtifactCarrierProducer.MaximumChunkBytes + 1);
        await ReserveAndStartAsync(store, raw, chunkSize: RbpArtifactCarrierProducer.MaximumChunkBytes);
        var materializer = new RbpProtectedRecoveryCarrierMaterializer(store)
        {
            TestBeforePostSnapshotRecheck = async _ =>
            {
                RbpRecoveryCarrierReservation? ignored =
                    await store.ApplyRecoveryCarrierFenceAcknowledgementAsync(Rsid, 1);
            },
        };

        Assert.Null(await materializer.MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        RbpRecoveryCarrierReservation reservation =
            (await store.GetRecoveryCarrierReservationAsync(RecoveryId))!;
        Assert.Equal(RbpRecoveryCarrierPhase.Reserved, reservation.Phase);
        Assert.Equal(2, reservation.CurrentReservedSequence);
        Assert.Equal(0, CountOutbox(directory.JournalPath));
    }

    [Theory]
    [InlineData("plan_version")]
    [InlineData("header_jcs")]
    [InlineData("canonical_envelope_digest")]
    public async Task PostSnapshotMetadataDriftMustProduceNoDraft(string field)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        await ReserveAndStartAsync(store, Encoding.UTF8.GetBytes("{\"ok\":true}"));
        var materializer = new RbpProtectedRecoveryCarrierMaterializer(store)
        {
            TestBeforePostSnapshotRecheck = _ =>
            {
                MutateReservation(directory.JournalPath, field);
                return Task.CompletedTask;
            },
        };

        Assert.Null(await materializer.MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        Assert.Equal(0, CountOutbox(directory.JournalPath));
    }

    [Theory]
    [InlineData("last_peer_ack")]
    [InlineData("highest_tx_seq")]
    [InlineData("next_tx_seq")]
    [InlineData("outbox_collision")]
    [InlineData("raw_payload_version")]
    [InlineData("header_jcs")]
    [InlineData("canonical_envelope_digest")]
    [InlineData("expires_at_ms")]
    [InlineData("current_reserved_seq")]
    [InlineData("plan_version")]
    public async Task AuthoritativeSnapshotDeniesEachIndividuallyTamperedField(string field)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        await ReserveAndStartAsync(store, Encoding.UTF8.GetBytes("{\"ok\":true}"));
        int outboxBefore = CountOutbox(directory.JournalPath);
        MutateReservation(directory.JournalPath, field);

        Assert.Null(await new RbpProtectedRecoveryCarrierMaterializer(store)
            .MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        Assert.Equal(outboxBefore + (field == "outbox_collision" ? 1 : 0),
            CountOutbox(directory.JournalPath));
    }

    [Fact]
    public async Task ExactOneMebibyteIsOneFrameAndOneByteOverIsTwoFrames()
    {
        using var oneDirectory = new RbpJournalTestDirectory();
        await using RbpJournalStore oneStore = await OpenAsync(oneDirectory);
        byte[] exact = JsonBytes(RbpArtifactCarrierProducer.MaximumChunkBytes);
        await ReserveAndStartAsync(oneStore, exact, chunkSize: RbpArtifactCarrierProducer.MaximumChunkBytes);
        RbpRecoveryCarrierMaterializedFrame one = Assert.IsType<RbpRecoveryCarrierMaterializedFrame>(
            await new RbpProtectedRecoveryCarrierMaterializer(oneStore)
                .MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        Assert.Equal(exact, Convert.FromBase64String(one.Answer.Payload.GetProperty("data").GetString()!));
        Assert.Equal(Rfc8785Json.Sha256Digest(one.Answer.Payload), one.PayloadDigest);
        Assert.Null(typeof(RbpRecoveryCarrierMaterializedFrame).GetProperty("OuterEnvelopeDigest"));
        Assert.Equal(1, (await oneStore.GetRecoveryCarrierReservationAsync(RecoveryId))!.ChunkCount);

        using var splitDirectory = new RbpJournalTestDirectory();
        await using RbpJournalStore splitStore = await OpenAsync(splitDirectory);
        byte[] split = JsonBytes(RbpArtifactCarrierProducer.MaximumChunkBytes + 1);
        await ReserveAndStartAsync(splitStore, split, chunkSize: RbpArtifactCarrierProducer.MaximumChunkBytes);
        RbpRecoveryCarrierMaterializedFrame first = Assert.IsType<RbpRecoveryCarrierMaterializedFrame>(
            await new RbpProtectedRecoveryCarrierMaterializer(splitStore)
                .MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        Assert.Equal(RbpArtifactCarrierProducer.MaximumChunkBytes,
            Convert.FromBase64String(first.Answer.Payload.GetProperty("data").GetString()!).Length);
        Assert.Equal(2, (await splitStore.GetRecoveryCarrierReservationAsync(RecoveryId))!.ChunkCount);
    }

    [Fact]
    public async Task CountMismatchIsRejectedBeforeAnyDraftExists()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        await ReserveAndStartAsync(store, Encoding.UTF8.GetBytes("{\"ok\":true}"));
        MutateReservation(directory.JournalPath, "chunk_count");

        Assert.Null(await new RbpProtectedRecoveryCarrierMaterializer(store)
            .MaterializeCurrentAsync(RecoveryId, Rsid, CancellationToken.None));
        Assert.Equal(0, CountOutbox(directory.JournalPath));
    }

    private static async Task<RbpJournalStore> OpenAsync(RbpJournalTestDirectory directory, bool register = true)
    {
        RbpJournalStore store = RbpJournalStore.Open(directory.JournalPath,
            new TestResumeTokenProtector(), RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        if (register) _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        return store;
    }

    private static async Task ReserveAndStartAsync(
        RbpJournalStore store, byte[] raw, bool start = true, int? chunkSize = null)
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
            chunkSize ?? raw.Length, new RbpRecoveryCarrierHeader("application/json", "base64"),
            Rfc8785Json.Sha256Digest(JsonSerializer.SerializeToElement(new
            {
                invocation_id = RecoveryId,
                origin_invocation_id = OriginId,
                expected_result_digest = digest
            })), DateTimeOffset.UtcNow.AddHours(1));
        _ = await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
        if (start) _ = await store.MarkRecoveryCarrierSendStartedAsync(RecoveryId);
    }

    private static byte[] JsonBytes(int length)
    {
        byte[] bytes = new byte[length];
        bytes[0] = (byte)'\"';
        Array.Fill(bytes, (byte)' ', 1, length - 2);
        bytes[^1] = (byte)'\"';
        return bytes;
    }

    private static void MutateReservation(string journalPath, string field)
    {
        using var connection = new SqliteConnection($"Data Source={journalPath};Pooling=False");
        connection.Open();
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = field switch
        {
            "last_peer_ack" => "UPDATE rbp_session_sequence SET last_peer_ack=1 WHERE rsid='rs-test';",
            "highest_tx_seq" => "PRAGMA ignore_check_constraints=ON; UPDATE rbp_session_sequence SET highest_tx_seq=2 WHERE rsid='rs-test';",
            "next_tx_seq" => "PRAGMA ignore_check_constraints=ON; UPDATE rbp_session_sequence SET next_tx_seq=3 WHERE rsid='rs-test';",
            "outbox_collision" => "INSERT INTO rbp_outbox(rsid,seq,envelope_id,message_type,immutable_digest,envelope_json,created_at_ms) VALUES('rs-test',1,'c39-collision','result','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{}',0);",
            "raw_payload_version" => "PRAGMA ignore_check_constraints=ON; UPDATE rbp_recovery_carrier_reservations SET raw_payload_version=6 WHERE recovery_invocation_id='0197a3c2-0000-7000-8000-0000000000c2';",
            "header_jcs" => "UPDATE rbp_recovery_carrier_reservations SET header_jcs='{\"content_encoding\":\"base64\",\"content_type\":\"application/json\",\"v\":2}' WHERE recovery_invocation_id='0197a3c2-0000-7000-8000-0000000000c2';",
            "canonical_envelope_digest" => "UPDATE rbp_recovery_carrier_reservations SET canonical_envelope_digest='sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE recovery_invocation_id='0197a3c2-0000-7000-8000-0000000000c2';",
            "expires_at_ms" => "PRAGMA ignore_check_constraints=ON; UPDATE rbp_recovery_carrier_reservations SET expires_at_ms=0 WHERE recovery_invocation_id='0197a3c2-0000-7000-8000-0000000000c2';",
            "current_reserved_seq" => "UPDATE rbp_recovery_carrier_reservations SET current_reserved_seq=2,highest_reserved_seq=2 WHERE recovery_invocation_id='0197a3c2-0000-7000-8000-0000000000c2';",
            "plan_version" => "PRAGMA ignore_check_constraints=ON; UPDATE rbp_recovery_carrier_reservations SET plan_version=2 WHERE recovery_invocation_id='0197a3c2-0000-7000-8000-0000000000c2';",
            "chunk_count" => "UPDATE rbp_recovery_carrier_reservations SET chunk_count=2 WHERE recovery_invocation_id='0197a3c2-0000-7000-8000-0000000000c2';",
            _ => throw new ArgumentOutOfRangeException(nameof(field)),
        };
        _ = command.ExecuteNonQuery();
    }

    private static int CountOutbox(string journalPath)
    {
        using var connection = new SqliteConnection($"Data Source={journalPath};Pooling=False");
        connection.Open();
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM rbp_outbox WHERE rsid='rs-test';";
        return Convert.ToInt32(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }
}
