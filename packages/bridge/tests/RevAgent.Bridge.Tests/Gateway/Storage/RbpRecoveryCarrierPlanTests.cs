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
        await EnsureRecoveryExecutingAsync(store, request);
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
            await EnsureRecoveryExecutingAsync(store, request);
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
        await EnsureRecoveryExecutingAsync(store, request);

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
    public async Task ReservedRecoveryWaitsForEarlierGenericAcknowledgementInsteadOfTombstoning()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        (RbpInvocationIdentity origin, byte[] raw, string digest) =
            await PersistRecoverableTerminalAsync(
                store, "0197a3c2-0000-7000-8000-0000000000d5");
        RbpQueueOutboundResult generic = await store.QueueOutboundDataAsync(
            origin.Rsid, new RbpOutboundDataDraft(
                "result", "generic-before-recovery", RbpJournalTestData.Json("{}")));
        Assert.Equal(1, generic.Envelope!.Sequence);
        var request = new RbpRecoveryCarrierReservationRequest(
            origin.Rsid, "0197a3c2-0000-7000-8000-0000000000d6",
            origin.InvocationId, digest, raw.Length,
            new RbpRecoveryCarrierHeader("application/json", "base64"),
            "sha256:" + new string('d', 64), RbpJournalTestData.Now.AddHours(1));
        await EnsureRecoveryExecutingAsync(store, request);
        RbpRecoveryCarrierReservation reserved =
            await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
        Assert.Equal(2, reserved.CurrentReservedSequence);

        Assert.Equal(RbpRecoveryCarrierPhase.Reserved,
            (await store.MarkRecoveryCarrierSendStartedAsync(
                request.RecoveryInvocationId)).Phase);
        _ = await store.ApplyResumeAcknowledgementAsync(
            origin.Rsid, 1, RbpJournalTestData.Now.AddHours(1));
        Assert.Equal(RbpRecoveryCarrierPhase.SendStarted,
            (await store.MarkRecoveryCarrierSendStartedAsync(
                request.RecoveryInvocationId)).Phase);
        Assert.Empty((await store.LoadSequenceAsync(origin.Rsid)).Outbox);
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
        await EnsureRecoveryExecutingAsync(store, request);
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

    [Fact]
    public async Task V9TerminalPlanIsExactAcrossRestartAndOnlyAnEqualReceiptReleasesItsProtectedSource()
    {
        using var directory = new RbpJournalTestDirectory();
        RbpRecoveryCarrierReservationRequest request;
        RbpRecoveryTerminalPlan reserved;
        await using (RbpJournalStore store = OpenStore(directory))
        {
            (RbpInvocationIdentity origin, byte[] raw, string digest) =
                await PersistRecoverableTerminalAsync(store,
                    "0197a3c2-0000-7000-8000-0000000000d9");
            request = new RbpRecoveryCarrierReservationRequest(
                origin.Rsid, "0197a3c2-0000-7000-8000-0000000000da",
                origin.InvocationId, digest, raw.Length,
                new RbpRecoveryCarrierHeader("application/json", "base64"),
                "sha256:" + new string('b', 64), RbpJournalTestData.Now.AddHours(1));
            await EnsureRecoveryExecutingAsync(store, request);
            _ = await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
            _ = await store.MarkRecoveryCarrierSendStartedAsync(request.RecoveryInvocationId);
            Assert.Equal(RbpRecoveryCarrierPhase.Completed,
                (await store.ApplyRecoveryCarrierFenceAcknowledgementAsync(origin.Rsid, 1))!.Phase);

            reserved = await store.ReserveRecoveryTerminalAsync(request.RecoveryInvocationId, origin.Rsid);
            Assert.Equal(9, reserved.PlanVersion);
            Assert.Equal(2, reserved.FinalSequence);
            Assert.Equal(1, reserved.AcknowledgementBaseline);
            Assert.Equal("reserved", reserved.State);
            Assert.Equal("completed", reserved.TerminalPayload.GetProperty("status").GetString());
            Assert.True(reserved.TerminalPayload.GetProperty("chunked").GetBoolean());
            Assert.False(reserved.TerminalPayload.TryGetProperty("payload_omitted", out _));
            Assert.Equal(digest, reserved.TerminalPayload.GetProperty("result_digest").GetString());
            Assert.Equal(Rfc8785Json.Sha256Digest(reserved.TerminalPayload), reserved.TerminalDigest);
            Assert.Empty((await store.LoadSequenceAsync(origin.Rsid)).Outbox);
            Assert.NotNull(await store.GetCorrelatedRecoveryPayloadAsync(origin.Rsid, origin.InvocationId, digest));
        }

        await using RbpJournalStore reopened = OpenStore(directory);
        RbpRecoveryTerminalPlan materialized = Assert.IsType<RbpRecoveryTerminalPlan>(
            await reopened.ReadRecoveryTerminalPlanForMaterializationAsync(
                request.RecoveryInvocationId, request.Rsid, reserved.PlanVersion,
                reserved.FinalSequence, reserved.PayloadCommitment));
        Assert.Equal(reserved.TerminalDigest, materialized.TerminalDigest);
        Assert.True(await reopened.ConfirmRecoveryTerminalMaterializationAsync(
            request.RecoveryInvocationId, request.Rsid, materialized.PlanVersion,
            materialized.FinalSequence, materialized.PayloadCommitment));
        Assert.False(await reopened.ConfirmRecoveryTerminalMaterializationAsync(
            request.RecoveryInvocationId, request.Rsid, materialized.PlanVersion,
            materialized.FinalSequence, "sha256:" + new string('c', 64)));

        RbpRecoveryTerminalPlan below = Assert.IsType<RbpRecoveryTerminalPlan>(
            await reopened.ApplyRecoveryTerminalAcknowledgementAsync(
                request.Rsid, 1, gatewayDeliveryReceiptRecorded: false,
                sourceReleaseEligible: false));
        Assert.Equal("reserved", below.State);
        RbpRecoveryTerminalPlan confirmed = Assert.IsType<RbpRecoveryTerminalPlan>(
            await reopened.ApplyRecoveryTerminalAcknowledgementAsync(
                request.Rsid, 2, gatewayDeliveryReceiptRecorded: true,
                sourceReleaseEligible: true));
        Assert.Equal("confirmed", confirmed.State);
        Assert.NotNull(confirmed.ConfirmedAtMilliseconds);
        Assert.Null(await reopened.GetCorrelatedRecoveryPayloadAsync(
            request.Rsid, request.OriginInvocationId, request.ResultDigest));
        Assert.Equal(2, (await reopened.LoadSequenceAsync(request.Rsid)).LastPeerAcknowledgement);
    }

    [Fact]
    public async Task InboundAckBaselineIsDurableAndSeparateFromThePeerFenceAcrossCarrierAndTerminal()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        (RbpInvocationIdentity origin, byte[] raw, string digest) =
            await PersistRecoverableTerminalAsync(store,
                "0197a3c2-0000-7000-8000-0000000000e8");

        // Deliberately diverge the two directions: the peer has acknowledged
        // four outbound frames while we have accepted only three inbound
        // frames.  The C39 carrier must be seq5/fence4 but wire ACK3.
        for (int sequence = 1; sequence <= 4; sequence++)
        {
            _ = await store.QueueOutboundDataAsync(origin.Rsid,
                new RbpOutboundDataDraft("result", "predecessor-" + sequence,
                    RbpJournalTestData.Json("{}")));
        }
        _ = await store.ApplyResumeAcknowledgementAsync(origin.Rsid, 4,
            RbpJournalTestData.Now.AddHours(1));
        for (int sequence = 1; sequence <= 3; sequence++)
        {
            _ = await store.AcceptInboundDataAsync(RbpJournalTestData.Inbound(
                origin.Rsid, sequence,
                $"0197a3c2-0000-7000-8000-0000000002{sequence:D2}", sequence));
        }
        RbpSequenceState before = await store.LoadSequenceAsync(origin.Rsid);
        Assert.Equal(3, before.LastRxSequence);
        Assert.Equal(4, before.LastPeerAcknowledgement);

        var request = new RbpRecoveryCarrierReservationRequest(
            origin.Rsid, "0197a3c2-0000-7000-8000-0000000000e9",
            origin.InvocationId, digest, raw.Length,
            new RbpRecoveryCarrierHeader("application/json", "base64"),
            "sha256:" + new string('e', 64), RbpJournalTestData.Now.AddHours(1));
        await EnsureRecoveryExecutingAsync(store, request);
        RbpRecoveryCarrierReservation reservation =
            await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
        Assert.Equal(5, reservation.CurrentReservedSequence);
        Assert.Equal(4, reservation.AcknowledgementCursor);
        Assert.Equal(3, reservation.InboundAcknowledgementBaseline);

        _ = await store.MarkRecoveryCarrierSendStartedAsync(request.RecoveryInvocationId);
        // A later receive must not rewrite the outer ACK of an already
        // reserved recovery carrier.
        _ = await store.AcceptInboundDataAsync(RbpJournalTestData.Inbound(
            origin.Rsid, 4, "0197a3c2-0000-7000-8000-000000000204", 4));
        RbpRecoveryCarrierReservation stable = Assert.IsType<RbpRecoveryCarrierReservation>(
            await store.GetRecoveryCarrierReservationAsync(request.RecoveryInvocationId));
        Assert.Equal(3, stable.InboundAcknowledgementBaseline);
        Assert.Equal(4, (await store.LoadSequenceAsync(origin.Rsid)).LastRxSequence);

        _ = await store.ApplyRecoveryCarrierFenceAcknowledgementAsync(origin.Rsid, 5);
        RbpRecoveryTerminalPlan terminal = await store.ReserveRecoveryTerminalAsync(
            request.RecoveryInvocationId, origin.Rsid);
        Assert.Equal(6, terminal.FinalSequence);
        Assert.Equal(5, terminal.AcknowledgementBaseline);
        Assert.Equal(3, terminal.InboundAcknowledgementBaseline);

        // The shared RBP codec is used by both WSS and Streamable HTTP cycles;
        // each must serialize the immutable inbound acknowledgement, never the
        // outbound predecessor fence.
        var partial = new RbpEnvelope(1, "partial", request.RecoveryInvocationId,
            RbpJournalTestData.Now.ToString("O"), RbpJournalTestData.Json(
                $$"""{"kind":"chunk","invocation_id":"{{request.RecoveryInvocationId}}","stream_id":"result","chunk_index":0,"encoding":"base64","content_type":"application/json","data":"e30="}"""),
            RbpEnvelopeScope.Data, origin.Rsid, reservation.CurrentReservedSequence,
            reservation.InboundAcknowledgementBaseline, null, null,
            RbpEnvelopeDisposition.Known, RbpEnvelope.FreezeAdditionalProperties(
                new Dictionary<string, JsonElement>(StringComparer.Ordinal)));
        var terminalEnvelope = new RbpEnvelope(1, "result", request.RecoveryInvocationId,
            RbpJournalTestData.Now.ToString("O"), terminal.TerminalPayload,
            RbpEnvelopeScope.Data, origin.Rsid, terminal.FinalSequence,
            terminal.InboundAcknowledgementBaseline, null, null,
            RbpEnvelopeDisposition.Known, RbpEnvelope.FreezeAdditionalProperties(
                new Dictionary<string, JsonElement>(StringComparer.Ordinal)));
        Assert.Equal(3, RbpEnvelopeCodec.Decode(RbpEnvelopeCodec.Encode(partial)).Acknowledgement);
        Assert.Equal(3, RbpEnvelopeCodec.Decode(RbpEnvelopeCodec.Encode(terminalEnvelope)).Acknowledgement);
    }

    [Fact]
    public async Task MissingOrTamperedInboundAckBaselineFailsClosedWithoutSamplingLiveReceiveState()
    {
        using var directory = new RbpJournalTestDirectory();
        const string recoveryId = "0197a3c2-0000-7000-8000-0000000000ee";
        await using (RbpJournalStore store = OpenStore(directory))
        {
            (RbpInvocationIdentity origin, byte[] raw, string digest) =
                await PersistRecoverableTerminalAsync(store,
                    "0197a3c2-0000-7000-8000-0000000000ed");
            var request = new RbpRecoveryCarrierReservationRequest(
                origin.Rsid, recoveryId, origin.InvocationId, digest, raw.Length,
                new RbpRecoveryCarrierHeader("application/json", "base64"),
                "sha256:" + new string('e', 64), RbpJournalTestData.Now.AddHours(1));
            await EnsureRecoveryExecutingAsync(store, request);
            _ = await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
            _ = await store.MarkRecoveryCarrierSendStartedAsync(recoveryId);
        }

        using (var connection = new SqliteConnection($"Data Source={directory.JournalPath}"))
        {
            connection.Open();
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = "UPDATE rbp_recovery_carrier_reservations SET inbound_ack_baseline=NULL WHERE recovery_invocation_id=$id;";
            command.Parameters.AddWithValue("$id", recoveryId);
            Assert.Equal(1, command.ExecuteNonQuery());
        }
        await using (RbpJournalStore reopened = OpenStore(directory))
        {
            await Assert.ThrowsAsync<RbpJournalException>(() =>
                reopened.GetRecoveryCarrierReservationAsync(recoveryId));
        }

        using (var connection = new SqliteConnection($"Data Source={directory.JournalPath}"))
        {
            connection.Open();
            using SqliteCommand command = connection.CreateCommand();
            // A syntactically valid replacement still cannot pass because the
            // original durable commitment bound the captured value.
            command.CommandText = "UPDATE rbp_recovery_carrier_reservations SET inbound_ack_baseline=1 WHERE recovery_invocation_id=$id;";
            command.Parameters.AddWithValue("$id", recoveryId);
            Assert.Equal(1, command.ExecuteNonQuery());
        }
        await using RbpJournalStore tampered = OpenStore(directory);
        Assert.Null(await tampered.ReadRecoveryCarrierMaterializationSnapshotAsync(
            recoveryId, "rs-test"));
    }

    [Fact]
    public async Task V9TerminalPlanMaterializesAsTheExistingResultBodyWithoutProtectedPayloadRead()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        (RbpInvocationIdentity origin, byte[] raw, string digest) =
            await PersistRecoverableTerminalAsync(store,
                "0197a3c2-0000-7000-8000-0000000000de");
        var request = new RbpRecoveryCarrierReservationRequest(
            origin.Rsid, "0197a3c2-0000-7000-8000-0000000000df",
            origin.InvocationId, digest, raw.Length,
            new RbpRecoveryCarrierHeader("application/json", "base64"),
            "sha256:" + new string('e', 64), RbpJournalTestData.Now.AddHours(1));
        await EnsureRecoveryExecutingAsync(store, request);
        _ = await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
        _ = await store.MarkRecoveryCarrierSendStartedAsync(request.RecoveryInvocationId);
        _ = await store.ApplyRecoveryCarrierFenceAcknowledgementAsync(
            request.Rsid, 1);
        RbpRecoveryTerminalPlan plan = await store.ReserveRecoveryTerminalAsync(
            request.RecoveryInvocationId, request.Rsid);

        var materializer = new RevAgent.Bridge.Gateway.Dispatch
            .RbpProtectedRecoveryCarrierMaterializer(store);
        RevAgent.Bridge.Gateway.Dispatch.RbpRecoveryTerminalMaterializedFrame?
            materialized = await materializer.MaterializeTerminalAsync(
                plan, CancellationToken.None);
        RevAgent.Bridge.Gateway.Dispatch.RbpRecoveryTerminalMaterializedFrame
            frame = Assert.IsType<
                RevAgent.Bridge.Gateway.Dispatch.RbpRecoveryTerminalMaterializedFrame>(materialized);
        Assert.Equal("result", frame.Answer.Type);
        Assert.Equal(plan.TerminalDigest,
            Rfc8785Json.Sha256Digest(frame.Answer.Payload));
        Assert.Equal(plan.FinalSequence, frame.ReservedSequence);
        var envelope = new RbpEnvelope(1, frame.Answer.Type,
            plan.RecoveryInvocationId, RbpJournalTestData.Now.ToString("O"),
            frame.Answer.Payload, RbpEnvelopeScope.Data, plan.Rsid,
            plan.FinalSequence, plan.InboundAcknowledgementBaseline, null, null,
            RbpEnvelopeDisposition.Known,
            RbpEnvelope.FreezeAdditionalProperties(
                new Dictionary<string, JsonElement>(StringComparer.Ordinal)));
        Assert.NotEmpty(RbpEnvelopeCodec.Encode(envelope));
    }

    [Fact]
    public async Task V9TerminalAckWithoutGatewayReceiptTombstonesButRetainsTheProtectedSource()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        (RbpInvocationIdentity origin, byte[] raw, string digest) =
            await PersistRecoverableTerminalAsync(store,
                "0197a3c2-0000-7000-8000-0000000000db");
        var request = new RbpRecoveryCarrierReservationRequest(
            origin.Rsid, "0197a3c2-0000-7000-8000-0000000000dc",
            origin.InvocationId, digest, raw.Length,
            new RbpRecoveryCarrierHeader("application/json", "base64"),
            "sha256:" + new string('d', 64), RbpJournalTestData.Now.AddHours(1));
        await EnsureRecoveryExecutingAsync(store, request);
        _ = await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
        _ = await store.MarkRecoveryCarrierSendStartedAsync(request.RecoveryInvocationId);
        _ = await store.ApplyRecoveryCarrierFenceAcknowledgementAsync(request.Rsid, 1);
        RbpRecoveryTerminalPlan plan = await store.ReserveRecoveryTerminalAsync(
            request.RecoveryInvocationId, request.Rsid);

        RbpRecoveryTerminalPlan tombstoned = Assert.IsType<RbpRecoveryTerminalPlan>(
            await store.ApplyRecoveryTerminalAcknowledgementAsync(request.Rsid,
                plan.FinalSequence, gatewayDeliveryReceiptRecorded: false,
                sourceReleaseEligible: false));
        Assert.Equal("tombstoned", tombstoned.State);
        using RbpRecoveredPayload? source = await store.GetCorrelatedRecoveryPayloadAsync(
            request.Rsid, request.OriginInvocationId, request.ResultDigest);
        Assert.NotNull(source);
        Assert.Equal(raw, source!.RawResponseBytes.ToArray());
        await Assert.ThrowsAsync<RbpJournalException>(() => store.QueueOutboundDataAsync(
            request.Rsid, new RbpOutboundDataDraft("result", "terminal-fenced", RbpJournalTestData.Json("{}"))));
    }

    [Fact]
    public async Task RawRecoveryJsonAndItsBase64NeverAppearInJournalWalShmOrAdjacentSpoolTempAndLogFiles()
    {
        using var directory = new RbpJournalTestDirectory();
        const string ownerSentinel = "C39_CALLER_OWNER_SENTINEL_620b";
        const string headerSentinel = "C39_FORBIDDEN_FREEFORM_HEADER_ae73";
        byte[] raw = Encoding.UTF8.GetBytes(
            "{\"owner\":\"" + ownerSentinel + "\",\"header\":\"" + headerSentinel + "\"}");
        string digest = "sha256:" + Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
        string base64 = Convert.ToBase64String(raw);
        var origin = new RbpInvocationIdentity("rs-test", "0197a3c2-0000-7000-8000-0000000000c1",
            "get_current_view_info", false, null, "sha256:" + new string('a', 64), "{\"decision\":\"allow\"}", "[]");
        var request = new RbpRecoveryCarrierReservationRequest(origin.Rsid,
            "0197a3c2-0000-7000-8000-0000000000c2", origin.InvocationId, digest, raw.Length,
            new RbpRecoveryCarrierHeader("application/json", "base64"),
            "sha256:" + new string('e', 64), RbpJournalTestData.Now.AddHours(1));
        await using (RbpJournalStore store = OpenStore(directory))
        {
            _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
            _ = await store.AdmitInvocationAsync(origin);
            await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
            _ = await store.PersistInvocationTerminalAsync(origin.IdempotencyKey,
                new RbpInvocationTerminal(RbpInvocationState.Completed,
                    RbpJournalTestData.Json("{\"outcome\":\"completed\"}"), digest,
                    RecoveryPayload: new RbpRecoveryPayload(digest, raw)));
            await EnsureRecoveryExecutingAsync(store, request);
            _ = await store.PersistProtectedRecoveryTerminalAndReserveAsync(request);
        }
        // Closing only releases the file handles; the active reservation is
        // still durable and must not have emitted plaintext into its DB/WAL,
        // spool, temp, or log neighbors.
        AssertNoPlaintextLeak(directory.Path, raw, base64, ownerSentinel, headerSentinel);
        await using (RbpJournalStore store = OpenStore(directory))
        {
            _ = await store.MarkRecoveryCarrierSendStartedAsync(request.RecoveryInvocationId);
            _ = await store.ApplyRecoveryCarrierFenceAcknowledgementAsync(origin.Rsid, 2);
        }
        AssertNoPlaintextLeak(directory.Path, raw, base64, ownerSentinel, headerSentinel);
    }

    private static RbpJournalStore OpenStore(RbpJournalTestDirectory directory) =>
        RbpJournalStore.Open(directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());

    private static async Task EnsureRecoveryExecutingAsync(
        RbpJournalStore store, RbpRecoveryCarrierReservationRequest request)
    {
        var recovery = new RbpInvocationIdentity(request.Rsid,
            request.RecoveryInvocationId, "dispatch_payload_recovery", false,
            null, "sha256:" + new string('f', 64),
            "{\"decision\":\"auto\"}", "[]");
        _ = await store.AdmitInvocationAsync(recovery);
        await store.MarkInvocationExecutingAsync(recovery.IdempotencyKey);
    }

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

    private static void AssertNoPlaintextLeak(
        string root,
        byte[] raw,
        string base64,
        string ownerSentinel,
        string headerSentinel)
    {
        foreach (string path in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            byte[] bytes = File.ReadAllBytes(path);
            string text = Encoding.UTF8.GetString(bytes);
            Assert.DoesNotContain(Encoding.UTF8.GetString(raw), text, StringComparison.Ordinal);
            Assert.DoesNotContain(base64, text, StringComparison.Ordinal);
            Assert.DoesNotContain(ownerSentinel, text, StringComparison.Ordinal);
            Assert.DoesNotContain(headerSentinel, text, StringComparison.Ordinal);
        }
    }
}
