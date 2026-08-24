using System.Security.Cryptography;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Storage;

internal sealed partial class RbpJournalStore
{
    internal Task<RbpSequenceState> LoadSequenceAsync(
        string rsid,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), maximumLength: 256);
        return ReadAsync(
            connection => LoadSequence(connection, rsid).State,
            cancellationToken);
    }

    internal Task<RbpReceiveFrontier> GetReceiveFrontierAsync(
        string rsid,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), maximumLength: 256);
        return ReadAsync(
            connection =>
            {
                LoadedSequence loaded = LoadSequence(connection, rsid);
                return new RbpReceiveFrontier(
                    loaded.State.LastRxSequence,
                    loaded.LastJournaledReceivedSequence);
            },
            cancellationToken);
    }

    /// <summary>
    /// Atomically pins an already protected, exact terminal payload and
    /// reserves the current outbound sequence for its C39 carrier.  No wire
    /// envelope or payload bytes are written here; the coordinator owns
    /// framing and must first mark this immutable reservation send-started.
    /// </summary>
    internal Task<RbpRecoveryCarrierReservation>
        PersistProtectedRecoveryTerminalAndReserveAsync(
            RbpRecoveryCarrierReservationRequest request,
            CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ValidateIdentifier(request.Rsid, nameof(request), 256);
        ValidateRecoveryReservationRequest(request);
        long now = NowMilliseconds();
        long expiry = request.ExpiresAt.ToUnixTimeMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                RequireActiveSession(context, request.Rsid);
                RbpRecoveryCarrierReservation? existing =
                    ReadRecoveryCarrierReservation(
                        context, request.RecoveryInvocationId);
                if (existing is not null)
                {
                    RequireExactRecoveryReservation(existing, request);
                    return existing;
                }

                if (ReadActiveRecoveryCarrierReservation(context, request.Rsid) is not null)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "The RBP session has an active recovery carrier fence.");
                }

                (string rawIdempotencyKey, int plaintextLength) = ReadExactRecoveryPayloadKey(
                    context, request);
                int chunkCount = checked((plaintextLength + request.ChunkSize - 1) / request.ChunkSize);
                string headerJcs = CanonicalRecoveryCarrierHeader(request.Header);
                LoadedSequence loaded = LoadSequence(context, request.Rsid);
                long sequence = loaded.State.NextTxSequence ?? throw new RbpJournalException(
                    RbpJournalErrorCode.ProtocolConflict,
                    "The RBP session cannot reserve a recovery sequence after exhaustion.");
                RbpSequenceState reserved = loaded.State with
                {
                    NextTxSequence = sequence == RbpSequenceReducer.MaximumSafeSequence
                        ? null : sequence + 1,
                    HighestTxSequence = sequence,
                };
                using (SqliteCommand insert = context.CreateCommand("""
                    INSERT INTO rbp_recovery_carrier_reservations(
                      recovery_invocation_id,rsid,origin_invocation_id,result_digest,
                      raw_idempotency_key,raw_payload_version,header_jcs,plaintext_length,chunk_size,
                      chunk_count,phase,chunk_index,current_reserved_seq,
                      canonical_envelope_digest,send_started_at_ms,highest_reserved_seq,
                      acknowledgement_cursor,plan_version,created_at_ms,expires_at_ms,
                      updated_at_ms,completed_at_ms,tombstoned_at_ms,tombstone_reason)
                    VALUES($recovery,$rsid,$origin,$digest,$raw,7,$header,$length,
                           $chunk_size,$chunk_count,'reserved',0,$seq,$envelope,
                           NULL,$seq,$ack,1,$now,$expires,$now,NULL,NULL,NULL);
                    """))
                {
                    insert.Parameters.AddWithValue("$recovery", request.RecoveryInvocationId);
                    insert.Parameters.AddWithValue("$rsid", request.Rsid);
                    insert.Parameters.AddWithValue("$origin", request.OriginInvocationId);
                    insert.Parameters.AddWithValue("$digest", request.ResultDigest);
                    insert.Parameters.AddWithValue("$raw", rawIdempotencyKey);
                    insert.Parameters.AddWithValue("$length", plaintextLength);
                    insert.Parameters.AddWithValue("$chunk_size", request.ChunkSize);
                    insert.Parameters.AddWithValue("$chunk_count", chunkCount);
                    insert.Parameters.AddWithValue("$seq", sequence);
                    insert.Parameters.AddWithValue("$header", headerJcs);
                    insert.Parameters.AddWithValue("$envelope", request.CanonicalEnvelopeDigest);
                    insert.Parameters.AddWithValue("$ack", loaded.State.LastPeerAcknowledgement);
                    insert.Parameters.AddWithValue("$now", now);
                    insert.Parameters.AddWithValue("$expires", expiry);
                    if (insert.ExecuteNonQuery() != 1)
                    {
                        throw RbpJournalSerialization.Corrupt("The recovery carrier reservation was not persisted.");
                    }
                }
                PersistSequenceState(context, reserved, now);
                return ReadRecoveryCarrierReservation(context, request.RecoveryInvocationId) ??
                    throw RbpJournalSerialization.Corrupt("The recovery carrier reservation disappeared after persistence.");
            }, cancellationToken);
    }

    internal Task<RbpRecoveryCarrierReservation?> GetRecoveryCarrierReservationAsync(
        string recoveryInvocationId,
        CancellationToken cancellationToken = default)
    {
        ValidateUuidV7(recoveryInvocationId, nameof(recoveryInvocationId));
        return ReadAsync(connection =>
        {
            RbpRecoveryCarrierReservation? reservation = ReadRecoveryCarrierReservation(connection, recoveryInvocationId);
            if (reservation is null || reservation.Phase == RbpRecoveryCarrierPhase.Tombstoned)
                return reservation;
            using RbpRecoveredPayload? raw = ReadCorrelatedRecoveryPayload(connection, reservation.Rsid,
                reservation.OriginInvocationId, reservation.ResultDigest);
            return raw is not null && raw.RawResponseBytes.Length == reservation.PlaintextLength
                ? reservation : null;
        }, cancellationToken);
    }

    internal Task<RbpRecoveryCarrierReservation> MarkRecoveryCarrierSendStartedAsync(
        string recoveryInvocationId,
        CancellationToken cancellationToken = default)
    {
        ValidateUuidV7(recoveryInvocationId, nameof(recoveryInvocationId));
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(context =>
        {
            RbpRecoveryCarrierReservation current = ReadRecoveryCarrierReservation(context, recoveryInvocationId) ??
                throw new RbpJournalException(RbpJournalErrorCode.ProtocolConflict, "The recovery carrier reservation is missing.");
            if (current.Phase is RbpRecoveryCarrierPhase.Completed or RbpRecoveryCarrierPhase.Tombstoned)
            {
                return current;
            }
            if (current.RawPayloadVersion != RbpRecoveryPayloadEnvelope.Version ||
                current.CurrentReservedSequence < 1 ||
                LoadSequence(context, current.Rsid).State.LastPeerAcknowledgement < current.CurrentReservedSequence - 1)
            {
                TombstoneRecoveryCarrierReservation(context, current.RecoveryInvocationId, now, "predecessor_not_acknowledged");
                return ReadRecoveryCarrierReservation(context, recoveryInvocationId)!;
            }
            using SqliteCommand update = context.CreateCommand("""
                UPDATE rbp_recovery_carrier_reservations
                SET phase='send_started',send_started_at_ms=COALESCE(send_started_at_ms,$now),
                    updated_at_ms=MAX(updated_at_ms,$now)
                WHERE recovery_invocation_id=$recovery
                  AND phase IN ('reserved','send_started','awaiting_ack');
                """);
            update.Parameters.AddWithValue("$now", now);
            update.Parameters.AddWithValue("$recovery", recoveryInvocationId);
            if (update.ExecuteNonQuery() != 1)
            {
                throw new RbpJournalException(RbpJournalErrorCode.ProtocolConflict, "The recovery carrier reservation changed during send-start.");
            }
            return ReadRecoveryCarrierReservation(context, recoveryInvocationId) ??
                throw RbpJournalSerialization.Corrupt("The recovery carrier reservation disappeared during send-start.");
        }, cancellationToken);
    }

    /// <summary>
    /// Applies an acknowledgement only to the currently reserved recovery
    /// fence. A lower acknowledgement is deliberately a no-op. An equal
    /// acknowledgement consumes exactly that sent sequence and either reserves
    /// the next chunk or completes the plan. Above/unsent acknowledgements are
    /// recorded as an immutable tombstone so ordinary dispatch remains blocked.
    /// </summary>
    internal Task<RbpRecoveryCarrierReservation?> ApplyRecoveryCarrierFenceAcknowledgementAsync(
        string rsid,
        long acknowledgement,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), 256);
        if (acknowledgement < 0) throw new ArgumentOutOfRangeException(nameof(acknowledgement));
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(context =>
        {
            RbpRecoveryCarrierReservation? current = ReadActiveRecoveryCarrierReservation(context, rsid);
            if (current is null || current.Phase == RbpRecoveryCarrierPhase.Tombstoned)
            {
                return current;
            }
            if (acknowledgement < current.CurrentReservedSequence)
            {
                return current;
            }
            if (acknowledgement > current.CurrentReservedSequence || current.Phase != RbpRecoveryCarrierPhase.SendStarted)
            {
                TombstoneRecoveryCarrierReservation(context, current.RecoveryInvocationId, now,
                    acknowledgement > current.CurrentReservedSequence ? "ack_above_reserved" : "ack_before_send_started");
                return ReadRecoveryCarrierReservation(context, current.RecoveryInvocationId);
            }

            LoadedSequence loaded = LoadSequence(context, rsid);
            if (loaded.State.LastPeerAcknowledgement != current.AcknowledgementCursor ||
                loaded.State.HighestTxSequence != current.CurrentReservedSequence)
            {
                TombstoneRecoveryCarrierReservation(context, current.RecoveryInvocationId, now, "sequence_authority_mismatch");
                return ReadRecoveryCarrierReservation(context, current.RecoveryInvocationId);
            }

            if (current.ChunkIndex + 1 >= current.ChunkCount)
            {
                RbpSequenceState completed = loaded.State with { LastPeerAcknowledgement = acknowledgement };
                PersistSequenceState(context, completed, now);
                using SqliteCommand complete = context.CreateCommand("""
                    UPDATE rbp_recovery_carrier_reservations
                    SET phase='completed',acknowledgement_cursor=$ack,completed_at_ms=$now,updated_at_ms=MAX(updated_at_ms,$now)
                    WHERE recovery_invocation_id=$recovery AND phase='send_started'
                      AND current_reserved_seq=$ack;
                    """);
                complete.Parameters.AddWithValue("$ack", acknowledgement);
                complete.Parameters.AddWithValue("$now", now);
                complete.Parameters.AddWithValue("$recovery", current.RecoveryInvocationId);
                if (complete.ExecuteNonQuery() != 1) throw RbpJournalSerialization.Corrupt("The recovery completion CAS failed.");
            }
            else
            {
                long next = loaded.State.NextTxSequence ?? throw new RbpJournalException(
                    RbpJournalErrorCode.ProtocolConflict, "The recovery carrier cannot reserve a next chunk after sequence exhaustion.");
                RbpSequenceState advanced = loaded.State with
                {
                    LastPeerAcknowledgement = acknowledgement,
                    HighestTxSequence = next,
                    NextTxSequence = next == RbpSequenceReducer.MaximumSafeSequence ? null : next + 1,
                };
                using SqliteCommand advance = context.CreateCommand("""
                    UPDATE rbp_recovery_carrier_reservations
                    SET phase='reserved',chunk_index=chunk_index+1,current_reserved_seq=$next,
                        highest_reserved_seq=$next,acknowledgement_cursor=$ack,
                        send_started_at_ms=NULL,updated_at_ms=MAX(updated_at_ms,$now)
                    WHERE recovery_invocation_id=$recovery AND phase='send_started'
                      AND current_reserved_seq=$ack;
                    """);
                advance.Parameters.AddWithValue("$next", next);
                advance.Parameters.AddWithValue("$ack", acknowledgement);
                advance.Parameters.AddWithValue("$now", now);
                advance.Parameters.AddWithValue("$recovery", current.RecoveryInvocationId);
                if (advance.ExecuteNonQuery() != 1) throw RbpJournalSerialization.Corrupt("The recovery advance CAS failed.");
                PersistSequenceState(context, advanced, now);
            }
            return ReadRecoveryCarrierReservation(context, current.RecoveryInvocationId) ??
                throw RbpJournalSerialization.Corrupt("The recovery carrier reservation disappeared after acknowledgement.");
        }, cancellationToken);
    }

    private static void TombstoneRecoveryCarrierReservation(
        RbpJournalWriteContext context, string recoveryInvocationId, long now, string reason)
    {
        string? rawKey;
        string? rsid = null;
        long highWater = 0;
        using (SqliteCommand read = context.CreateCommand("SELECT rsid,current_reserved_seq,raw_idempotency_key FROM rbp_recovery_carrier_reservations WHERE recovery_invocation_id=$recovery;"))
        {
            read.Parameters.AddWithValue("$recovery", recoveryInvocationId);
            using SqliteDataReader reader = read.ExecuteReader();
            if (!reader.Read()) throw RbpJournalSerialization.Corrupt("The recovery reservation is missing before tombstone.");
            rsid = reader.GetString(0);
            highWater = reader.GetInt64(1);
            rawKey = reader.GetString(2);
        }
        using SqliteCommand update = context.CreateCommand("""
            UPDATE rbp_recovery_carrier_reservations
            SET phase='tombstoned',tombstone_reason=$reason,tombstoned_at_ms=$now,updated_at_ms=MAX(updated_at_ms,$now)
            WHERE recovery_invocation_id=$recovery AND phase<>'completed';
            """);
        update.Parameters.AddWithValue("$reason", reason);
        update.Parameters.AddWithValue("$now", now);
        update.Parameters.AddWithValue("$recovery", recoveryInvocationId);
        if (update.ExecuteNonQuery() != 1) throw RbpJournalSerialization.Corrupt("The recovery carrier tombstone CAS failed.");
        using (SqliteCommand minimal = context.CreateCommand("""
            INSERT INTO rbp_recovery_sequence_tombstones(rsid,format_version,tombstoned_at_ms,reason_code,sequence_high_water)
            VALUES($rsid,1,$now,$reason,$high)
            ON CONFLICT(rsid) DO NOTHING;
            """))
        {
            minimal.Parameters.AddWithValue("$rsid", rsid);
            minimal.Parameters.AddWithValue("$now", now);
            minimal.Parameters.AddWithValue("$reason", string.Equals(reason, "session_unregistered", StringComparison.Ordinal) ? "session_closed" : "recovery_fence_fault");
            minimal.Parameters.AddWithValue("$high", highWater);
            if (minimal.ExecuteNonQuery() > 1) throw RbpJournalSerialization.Corrupt("The minimal recovery tombstone is not unique.");
        }
        if (rawKey is not null)
        {
            using SqliteCommand delete = context.CreateCommand("DELETE FROM rbp_recovery_payloads WHERE idempotency_key=$key;");
            delete.Parameters.AddWithValue("$key", rawKey);
            _ = delete.ExecuteNonQuery();
        }
    }

    private static void ValidateRecoveryReservationRequest(RbpRecoveryCarrierReservationRequest request)
    {
        ValidateUuidV7(request.RecoveryInvocationId, nameof(request));
        ValidateUuidV7(request.OriginInvocationId, nameof(request));
        RequireSha256(request.ResultDigest, nameof(request));
        RequireSha256(request.CanonicalEnvelopeDigest, nameof(request));
        if (request.Header is null || request.ChunkSize is < 1 or > 1_048_576 ||
            request.ExpiresAt.ToUnixTimeMilliseconds() < 0)
        {
            throw new ArgumentException("Recovery carrier reservation metadata is invalid.", nameof(request));
        }
    }

    private static string CanonicalRecoveryCarrierHeader(RbpRecoveryCarrierHeader header)
    {
        if (!string.Equals(header.ContentType, RbpRecoveryCarrierHeader.RequiredContentType, StringComparison.Ordinal) ||
            !string.Equals(header.ContentEncoding, RbpRecoveryCarrierHeader.RequiredContentEncoding, StringComparison.Ordinal))
            throw new ArgumentException("The recovery carrier header is not an allowlisted JSON/base64 header.", nameof(header));
        return "{\"content_encoding\":\"base64\",\"content_type\":\"application/json\",\"v\":1}";
    }

    private static void ValidateUuidV7(string value, string parameterName)
    {
        if (!RbpRecoveryClearance.IsUuidV7(value))
        {
            throw new ArgumentException("The recovery carrier identity must be UUIDv7.", parameterName);
        }
    }

    internal Task<IReadOnlyList<RbpSessionAcknowledgement>>
        LoadJournaledAcknowledgementsAsync(
            IReadOnlyList<string> rsids,
            CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(rsids);
        foreach (string rsid in rsids)
        {
            ValidateIdentifier(rsid, nameof(rsids), maximumLength: 256);
        }

        if (rsids.Distinct(StringComparer.Ordinal).Count() != rsids.Count)
        {
            throw new ArgumentException(
                "RBP acknowledgement rsids must be distinct.",
                nameof(rsids));
        }

        string[] ordered =
            rsids.Order(StringComparer.Ordinal).ToArray();
        return ReadAsync(
            connection =>
            {
                var values = new List<RbpSessionAcknowledgement>(
                    ordered.Length);
                foreach (string rsid in ordered)
                {
                    RequireActiveSession(connection, rsid);
                    LoadedSequence loaded =
                        LoadSequence(connection, rsid);
                    values.Add(
                        new RbpSessionAcknowledgement(
                            rsid,
                            loaded.LastJournaledReceivedSequence));
                }

                return (IReadOnlyList<RbpSessionAcknowledgement>)
                    values.AsReadOnly();
            },
            cancellationToken);
    }

    internal async Task<RbpQueueOutboundResult> QueueOutboundDataAsync(
        string rsid,
        RbpOutboundDataDraft draft,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), maximumLength: 256);
        ArgumentNullException.ThrowIfNull(draft);
        ValidateIdentifier(draft.Id, nameof(draft), maximumLength: 128);
        ValidateIdentifier(draft.Type, nameof(draft), maximumLength: 128);
        draft = draft with { Payload = draft.Payload.Clone() };
        long now = NowMilliseconds();
        try
        {
            return await ExecuteImmediateAsync(
                    context =>
                    {
                        RequireActiveSession(context, rsid);
                        LoadedSequence loaded =
                            LoadSequence(context, rsid);
                        if (ReadActiveRecoveryCarrierReservation(context, rsid) is not null)
                        {
                            throw new RbpJournalException(
                                RbpJournalErrorCode.ProtocolConflict,
                                "Outbound data is blocked by the active recovery carrier fence.");
                        }
                        if (draft.Acknowledgement is { } acknowledgement &&
                            acknowledgement >
                            loaded.LastJournaledReceivedSequence)
                        {
                            throw new RbpJournalException(
                                RbpJournalErrorCode.ProtocolConflict,
                                "Outbound RBP acknowledgement cannot pass " +
                                "the contiguous invocation-journal frontier.");
                        }

                        RbpRetainedOutboundData? existing =
                            FindOutboxByEnvelopeId(
                                context,
                                rsid,
                                draft.Id);
                        if (existing is not null)
                        {
                            RequireExactOutboundReplay(existing, draft);
                            return new RbpQueueOutboundResult(
                                RbpQueueOutboundKind.Queued,
                                loaded.State,
                                existing.Envelope.Snapshot(),
                                RenewalRequired:
                                    loaded.State.NextTxSequence is null,
                                OutboxDrained: false);
                        }

                        RbpQueueOutboundResult queued =
                            RbpSequenceReducer.QueueOutboundData(
                                loaded.State,
                                draft);
                        if (queued.Kind ==
                            RbpQueueOutboundKind.RenewalRequired)
                        {
                            return queued;
                        }

                        RbpDataEnvelopeSnapshot envelope =
                            queued.Envelope ??
                            throw RbpJournalSerialization.Corrupt(
                                "The sequence reducer queued no envelope.");
                        string digest =
                            Rfc8785Json.ImmutableEnvelopeDigest(envelope);
                        using (SqliteCommand insert = context.CreateCommand(
                                   """
                                   INSERT INTO rbp_outbox(
                                     rsid,seq,envelope_id,message_type,
                                     immutable_digest,envelope_json,
                                     created_at_ms
                                   ) VALUES(
                                     $rsid,$seq,$envelope_id,$message_type,
                                     $immutable_digest,$envelope_json,
                                     $created_at_ms
                                   );
                                   """))
                        {
                            insert.Parameters.AddWithValue("$rsid", rsid);
                            insert.Parameters.AddWithValue(
                                "$seq",
                                envelope.Sequence);
                            insert.Parameters.AddWithValue(
                                "$envelope_id",
                                envelope.Id);
                            insert.Parameters.AddWithValue(
                                "$message_type",
                                envelope.Type);
                            insert.Parameters.AddWithValue(
                                "$immutable_digest",
                                digest);
                            insert.Parameters.AddWithValue(
                                "$envelope_json",
                                RbpJournalSerialization.SerializeEnvelope(
                                    envelope));
                            insert.Parameters.AddWithValue(
                                "$created_at_ms",
                                now);
                            _ = insert.ExecuteNonQuery();
                        }

                        PersistSequenceState(
                            context,
                            queued.State,
                            now);
                        return queued;
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpJournalException exception)
            when (exception.ErrorCode ==
                  RbpJournalErrorCode.PostCommitFailure)
        {
            return await RecoverQueuedOutboundAsync(
                    rsid,
                    draft,
                    exception,
                    CancellationToken.None)
                .ConfigureAwait(false);
        }
    }

    internal async Task<RbpInboundDataResult> AcceptInboundDataAsync(
        RbpDataEnvelopeSnapshot incoming,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(incoming);
        ValidateIdentifier(
            incoming.Rsid,
            nameof(incoming),
            maximumLength: 256);
        ValidateIdentifier(
            incoming.Id,
            nameof(incoming),
            maximumLength: 128);
        ValidateIdentifier(
            incoming.Type,
            nameof(incoming),
            maximumLength: 128);
        incoming = incoming.Snapshot();
        long now = NowMilliseconds();
        RbpInboundDataResult? attemptedResult = null;
        try
        {
            return await ExecuteImmediateAsync(
                    context =>
                    {
                        RequireActiveSession(context, incoming.Rsid);
                        LoadedSequence loaded =
                            LoadSequence(context, incoming.Rsid);
                        RbpSequenceState reducerState = loaded.State;
                        if (incoming.Sequence <=
                            loaded.State.LastRxSequence)
                        {
                            RbpAcceptedInboundData? retained =
                                FindInboundReceiptBySequence(
                                    context,
                                    incoming.Rsid,
                                    incoming.Sequence);
                            reducerState = loaded.State with
                            {
                                AcceptedInbound = retained is null
                                    ? Array.AsReadOnly(
                                        Array.Empty<
                                            RbpAcceptedInboundData>())
                                    : Array.AsReadOnly(
                                        new[] { retained }),
                            };
                        }

                        long? existingSequence =
                            FindInboundSequenceByEnvelopeId(
                                context,
                                incoming.Rsid,
                                incoming.Id);
                        if (existingSequence is { } boundSequence &&
                            boundSequence != incoming.Sequence)
                        {
                            throw new RbpJournalException(
                                RbpJournalErrorCode.ProtocolConflict,
                                "The inbound RBP envelope id is already bound " +
                                "to a different sequence.");
                        }

                        RbpInboundDataResult accepted =
                            RbpSequenceReducer.AcceptInboundData(
                                reducerState,
                                incoming);
                        if (accepted.Kind is
                            RbpInboundDataKind.Gap or
                            RbpInboundDataKind.ProtocolFault)
                        {
                            RbpInboundDataResult result = accepted with
                            {
                                State = loaded.State,
                                Acknowledgement =
                                    loaded
                                        .LastJournaledReceivedSequence,
                            };
                            attemptedResult = result;
                            return result;
                        }

                        if (accepted.Kind ==
                            RbpInboundDataKind.Accepted)
                        {
                            string digest =
                                Rfc8785Json.ImmutableEnvelopeDigest(
                                    incoming);
                            using SqliteCommand insert =
                                context.CreateCommand(
                                    """
                                    INSERT INTO rbp_inbound_receipts(
                                      rsid,seq,envelope_id,message_type,
                                      immutable_digest,envelope_json,
                                      handoff_state,accepted_at_ms
                                    ) VALUES(
                                      $rsid,$seq,$envelope_id,$message_type,
                                      $immutable_digest,$envelope_json,
                                      'pending',$accepted_at_ms
                                    );
                                    """);
                            insert.Parameters.AddWithValue(
                                "$rsid",
                                incoming.Rsid);
                            insert.Parameters.AddWithValue(
                                "$seq",
                                incoming.Sequence);
                            insert.Parameters.AddWithValue(
                                "$envelope_id",
                                incoming.Id);
                            insert.Parameters.AddWithValue(
                                "$message_type",
                                incoming.Type);
                            insert.Parameters.AddWithValue(
                                "$immutable_digest",
                                digest);
                            insert.Parameters.AddWithValue(
                                "$envelope_json",
                                RbpJournalSerialization.SerializeEnvelope(
                                    incoming));
                            insert.Parameters.AddWithValue(
                                "$accepted_at_ms",
                                now);
                            _ = insert.ExecuteNonQuery();
                        }

                        PersistSequenceState(context, accepted.State, now);
                        DeleteAcknowledgedOutbox(
                            context,
                            incoming.Rsid,
                            accepted.State.LastPeerAcknowledgement);
                        RbpInboundDataResult durableResult = accepted with
                        {
                            Acknowledgement =
                                loaded.LastJournaledReceivedSequence,
                        };
                        attemptedResult = durableResult;
                        return durableResult;
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpJournalException exception)
            when (exception.ErrorCode ==
                  RbpJournalErrorCode.PostCommitFailure)
        {
            return await RecoverAcceptedInboundAsync(
                    incoming,
                    attemptedResult,
                    exception,
                    CancellationToken.None)
                .ConfigureAwait(false);
        }
    }

    private async Task<RbpQueueOutboundResult> RecoverQueuedOutboundAsync(
        string rsid,
        RbpOutboundDataDraft draft,
        RbpJournalException original,
        CancellationToken cancellationToken)
    {
        return await ReadAsync(
                connection =>
                {
                    RequireActiveSession(connection, rsid);
                    LoadedSequence loaded = LoadSequence(connection, rsid);
                    RbpRetainedOutboundData? retained =
                        FindOutboxByEnvelopeId(connection, rsid, draft.Id);
                    if (retained is null)
                    {
                        throw original;
                    }

                    RequireExactOutboundReplay(retained, draft);
                    return new RbpQueueOutboundResult(
                        RbpQueueOutboundKind.Queued,
                        loaded.State,
                        retained.Envelope.Snapshot(),
                        RenewalRequired:
                            loaded.State.NextTxSequence is null,
                        OutboxDrained: false);
                },
                cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<RbpInboundDataResult> RecoverAcceptedInboundAsync(
        RbpDataEnvelopeSnapshot incoming,
        RbpInboundDataResult? attemptedResult,
        RbpJournalException original,
        CancellationToken cancellationToken)
    {
        if (attemptedResult is null)
        {
            throw original;
        }

        RbpInboundDataResult expectedResult = attemptedResult;
        return await ReadAsync(
                connection =>
                {
                    RequireActiveSession(connection, incoming.Rsid);
                    LoadedSequence loaded =
                        LoadSequence(connection, incoming.Rsid);
                    bool exactState =
                        loaded.State.NextTxSequence ==
                        expectedResult.State.NextTxSequence &&
                        loaded.State.HighestTxSequence ==
                        expectedResult.State.HighestTxSequence &&
                        loaded.State.LastRxSequence ==
                        expectedResult.State.LastRxSequence &&
                        loaded.State.LastPeerAcknowledgement ==
                        expectedResult.State.LastPeerAcknowledgement;
                    if (!exactState)
                    {
                        throw original;
                    }

                    if (expectedResult.Kind is
                        RbpInboundDataKind.Gap or
                        RbpInboundDataKind.ProtocolFault)
                    {
                        return expectedResult with
                        {
                            State = loaded.State,
                            Acknowledgement =
                                loaded.LastJournaledReceivedSequence,
                        };
                    }

                    RbpAcceptedInboundData? retained =
                        FindInboundReceiptBySequence(
                            connection,
                            incoming.Rsid,
                            incoming.Sequence);
                    if (retained is null)
                    {
                        throw original;
                    }

                    string digest =
                        Rfc8785Json.ImmutableEnvelopeDigest(incoming);
                    if (!string.Equals(
                            retained.ImmutableDigest,
                            digest,
                            StringComparison.Ordinal))
                    {
                        throw new RbpJournalException(
                            RbpJournalErrorCode.ProtocolConflict,
                            "The committed inbound sequence belongs to a " +
                            "different immutable envelope.",
                            original);
                    }

                    return expectedResult with
                    {
                        State = loaded.State,
                        Acknowledgement =
                            loaded.LastJournaledReceivedSequence,
                    };
                },
                cancellationToken)
            .ConfigureAwait(false);
    }

    private LoadedSequence LoadSequence(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand sequenceCommand = context.CreateCommand(
            """
            SELECT next_tx_seq,highest_tx_seq,last_rx_seq,
                   last_journaled_rx_seq,last_peer_ack
            FROM rbp_session_sequence
            WHERE rsid=$rsid;
            """);
        sequenceCommand.Parameters.AddWithValue("$rsid", rsid);
        return LoadSequence(
            sequenceCommand,
            () => ReadOutbox(context, rsid),
            () => ReadInboundSummary(context, rsid),
            () => ReadActiveRecoveryCarrierReservedSequence(context, rsid),
            rsid);
    }

    private LoadedSequence LoadSequence(
        SqliteConnection connection,
        string rsid)
    {
        using SqliteCommand sequenceCommand = CreateCommand(
            connection,
            """
            SELECT next_tx_seq,highest_tx_seq,last_rx_seq,
                   last_journaled_rx_seq,last_peer_ack
            FROM rbp_session_sequence
            WHERE rsid=$rsid;
            """);
        sequenceCommand.CommandTimeout = _commandTimeoutSeconds;
        sequenceCommand.Parameters.AddWithValue("$rsid", rsid);
        return LoadSequence(
            sequenceCommand,
            () => ReadOutbox(connection, rsid),
            () => ReadInboundSummary(connection, rsid),
            () => ReadActiveRecoveryCarrierReservedSequence(connection, rsid),
            rsid);
    }

    private static LoadedSequence LoadSequence(
        SqliteCommand sequenceCommand,
        Func<IReadOnlyList<RbpRetainedOutboundData>> readOutbox,
        Func<LoadedInboundSummary> readInboundSummary,
        Func<long?> readReservedSequence,
        string rsid)
    {
        long? nextTx;
        long highestTx;
        long lastRx;
        long lastJournaledRx;
        long lastPeerAcknowledgement;
        using (SqliteDataReader reader = sequenceCommand.ExecuteReader())
        {
            if (!reader.Read())
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.SessionNotFound,
                    "The RBP session sequence authority is missing.");
            }

            nextTx = reader.IsDBNull(0) ? null : reader.GetInt64(0);
            highestTx = reader.GetInt64(1);
            lastRx = reader.GetInt64(2);
            lastJournaledRx = reader.GetInt64(3);
            lastPeerAcknowledgement = reader.GetInt64(4);
        }

        IReadOnlyList<RbpRetainedOutboundData> outbox = readOutbox();
        LoadedInboundSummary inbound =
            readInboundSummary();
        long? reservedSequence = readReservedSequence();
        ValidateSequenceMaterial(
            rsid,
            nextTx,
            highestTx,
            lastRx,
            lastJournaledRx,
            lastPeerAcknowledgement,
            outbox,
            reservedSequence,
            inbound);
        return new LoadedSequence(
            new RbpSequenceState(
                rsid,
                nextTx,
                highestTx,
                lastRx,
                lastPeerAcknowledgement,
                outbox,
                Array.AsReadOnly(
                    Array.Empty<RbpAcceptedInboundData>())),
            lastJournaledRx);
    }

    private IReadOnlyList<RbpRetainedOutboundData> ReadOutbox(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT seq,envelope_id,message_type,immutable_digest,envelope_json
            FROM rbp_outbox
            WHERE rsid=$rsid
            ORDER BY seq;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeOutbox(reader, rsid);
    }

    private static long? ReadActiveRecoveryCarrierReservedSequence(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand("""
            SELECT current_reserved_seq
            FROM rbp_recovery_carrier_reservations
            WHERE rsid=$rsid
              AND phase IN ('reserved','send_started','awaiting_ack','tombstoned');
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        object? value = command.ExecuteScalar();
        return value is null ? null : Convert.ToInt64(value);
    }

    private long? ReadActiveRecoveryCarrierReservedSequence(
        SqliteConnection connection,
        string rsid)
    {
        using SqliteCommand command = CreateCommand(connection, """
            SELECT current_reserved_seq
            FROM rbp_recovery_carrier_reservations
            WHERE rsid=$rsid
              AND phase IN ('reserved','send_started','awaiting_ack','tombstoned');
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        object? value = command.ExecuteScalar();
        return value is null ? null : Convert.ToInt64(value);
    }

    private static RbpRecoveryCarrierReservation? ReadActiveRecoveryCarrierReservation(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand("""
            SELECT recovery_invocation_id,rsid,origin_invocation_id,result_digest,
                   raw_idempotency_key,raw_payload_version,header_jcs,plaintext_length,chunk_size,
                   chunk_count,phase,chunk_index,current_reserved_seq,
                   canonical_envelope_digest,send_started_at_ms,highest_reserved_seq,
                   acknowledgement_cursor,plan_version,created_at_ms,expires_at_ms,
                   updated_at_ms,completed_at_ms,tombstoned_at_ms,tombstone_reason
            FROM rbp_recovery_carrier_reservations
            WHERE rsid=$rsid AND phase IN ('reserved','send_started','awaiting_ack','tombstoned');
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeSingleRecoveryCarrierReservation(reader);
    }

    private static RbpRecoveryCarrierReservation? ReadRecoveryCarrierReservation(
        RbpJournalWriteContext context,
        string recoveryInvocationId)
    {
        using SqliteCommand command = context.CreateCommand(RecoveryCarrierReservationByIdSql);
        command.Parameters.AddWithValue("$recovery", recoveryInvocationId);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeSingleRecoveryCarrierReservation(reader);
    }

    private RbpRecoveryCarrierReservation? ReadRecoveryCarrierReservation(
        SqliteConnection connection,
        string recoveryInvocationId)
    {
        using SqliteCommand command = CreateCommand(connection, RecoveryCarrierReservationByIdSql);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$recovery", recoveryInvocationId);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeSingleRecoveryCarrierReservation(reader);
    }

    private const string RecoveryCarrierReservationByIdSql = """
        SELECT recovery_invocation_id,rsid,origin_invocation_id,result_digest,
               raw_idempotency_key,raw_payload_version,header_jcs,plaintext_length,chunk_size,
               chunk_count,phase,chunk_index,current_reserved_seq,
               canonical_envelope_digest,send_started_at_ms,highest_reserved_seq,
               acknowledgement_cursor,plan_version,created_at_ms,expires_at_ms,
               updated_at_ms,completed_at_ms,tombstoned_at_ms,tombstone_reason
        FROM rbp_recovery_carrier_reservations
        WHERE recovery_invocation_id=$recovery;
        """;

    private static RbpRecoveryCarrierReservation? MaterializeSingleRecoveryCarrierReservation(SqliteDataReader reader)
    {
        if (!reader.Read()) return null;
        RbpRecoveryCarrierReservation result = new(
            reader.GetString(1), reader.GetString(0), reader.GetString(2), reader.GetString(3),
            reader.GetString(4), reader.GetString(6), reader.GetInt32(7), reader.GetInt32(8), reader.GetInt32(9),
            reader.GetString(10) switch
            {
                "reserved" => RbpRecoveryCarrierPhase.Reserved,
                "send_started" => RbpRecoveryCarrierPhase.SendStarted,
                "awaiting_ack" => RbpRecoveryCarrierPhase.AwaitingAcknowledgement,
                "completed" => RbpRecoveryCarrierPhase.Completed,
                "tombstoned" => RbpRecoveryCarrierPhase.Tombstoned,
                _ => throw RbpJournalSerialization.Corrupt("The recovery carrier phase is invalid."),
            }, reader.GetInt32(11), reader.GetInt64(12), reader.GetInt32(5), reader.GetString(13),
            reader.IsDBNull(14) ? null : reader.GetInt64(14), reader.GetInt64(15), reader.GetInt64(16),
            reader.GetInt32(17), reader.GetInt64(18), reader.GetInt64(19), reader.GetInt64(20),
            reader.IsDBNull(21) ? null : reader.GetInt64(21), reader.IsDBNull(22) ? null : reader.GetInt64(22),
            reader.IsDBNull(23) ? null : reader.GetString(23));
        if (reader.Read()) throw RbpJournalSerialization.Corrupt("A recovery carrier reservation is not unique.");
        return result;
    }

    private (string Key, int Length) ReadExactRecoveryPayloadKey(
        RbpJournalWriteContext context,
        RbpRecoveryCarrierReservationRequest request)
    {
        using SqliteCommand command = context.CreateCommand("""
            SELECT payload.idempotency_key,payload.protection_scheme,payload.protected_envelope,
                   payload.plaintext_length,payload.created_at_ms,payload.retention_expires_at_ms
            FROM rbp_recovery_payloads AS payload
            JOIN rbp_invocations AS invocation
              ON invocation.idempotency_key=payload.idempotency_key
            WHERE payload.rsid=$rsid
              AND payload.invocation_id=$origin
              AND payload.result_digest=$digest
              AND invocation.rsid=$rsid
              AND invocation.invocation_id=$origin
              AND invocation.result_digest=$digest
              AND invocation.state IN ('completed','guarded');
            """);
        command.Parameters.AddWithValue("$rsid", request.Rsid);
        command.Parameters.AddWithValue("$origin", request.OriginInvocationId);
        command.Parameters.AddWithValue("$digest", request.ResultDigest);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            throw new RbpJournalException(RbpJournalErrorCode.ProtocolConflict,
                "The exact protected terminal recovery payload is unavailable.");
        }
        string key = reader.GetString(0);
        string scheme = reader.GetString(1);
        byte[] ciphertext = (byte[])reader.GetValue(2);
        int length = reader.GetInt32(3);
        long created = reader.GetInt64(4);
        long expires = reader.GetInt64(5);
        if (reader.Read() || length is < 1 or > RbpRecoveryPayloadEnvelope.MaxBytes ||
            expires <= NowMilliseconds())
            throw new RbpJournalException(RbpJournalErrorCode.IntegrityCheckFailed, "Recovery payload metadata is invalid.");
        byte[] envelope = _recoveryPayloadProtector.Unprotect(new RbpProtectedRecoveryPayload(scheme, ciphertext));
        try
        {
            byte[] raw = RbpRecoveryPayloadEnvelope.Read(request.Rsid, request.OriginInvocationId,
                key, request.ResultDigest, created, expires, envelope);
            try
            {
                if (raw.Length != length || !string.Equals(RawResponseDigest(raw), request.ResultDigest, StringComparison.Ordinal))
                    throw new RbpJournalException(RbpJournalErrorCode.IntegrityCheckFailed, "Recovery payload digest is invalid.");
                return (key, length);
            }
            finally { CryptographicOperations.ZeroMemory(raw); }
        }
        finally { CryptographicOperations.ZeroMemory(envelope); }
    }

    private static void RequireExactRecoveryReservation(
        RbpRecoveryCarrierReservation existing,
        RbpRecoveryCarrierReservationRequest request)
    {
        if (!string.Equals(existing.Rsid, request.Rsid, StringComparison.Ordinal) ||
            !string.Equals(existing.OriginInvocationId, request.OriginInvocationId, StringComparison.Ordinal) ||
            !string.Equals(existing.ResultDigest, request.ResultDigest, StringComparison.Ordinal) ||
            !string.Equals(existing.HeaderJcs, CanonicalRecoveryCarrierHeader(request.Header), StringComparison.Ordinal) ||
            existing.ChunkSize != request.ChunkSize ||
            !string.Equals(existing.CanonicalEnvelopeDigest, request.CanonicalEnvelopeDigest, StringComparison.Ordinal))
        {
            throw new RbpJournalException(RbpJournalErrorCode.ProtocolConflict,
                "The recovery carrier reservation is immutable.");
        }
    }

    private IReadOnlyList<RbpRetainedOutboundData> ReadOutbox(
        SqliteConnection connection,
        string rsid)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT seq,envelope_id,message_type,immutable_digest,envelope_json
            FROM rbp_outbox
            WHERE rsid=$rsid
            ORDER BY seq;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeOutbox(reader, rsid);
    }

    private static IReadOnlyList<RbpRetainedOutboundData> MaterializeOutbox(
        SqliteDataReader reader,
        string rsid)
    {
        var values = new List<RbpRetainedOutboundData>();
        while (reader.Read())
        {
            long sequence = reader.GetInt64(0);
            string envelopeId = reader.GetString(1);
            string messageType = reader.GetString(2);
            string digest = reader.GetString(3);
            RbpDataEnvelopeSnapshot envelope =
                RbpJournalSerialization.ParseEnvelope(
                    reader.GetString(4),
                    digest);
            if (envelope.Sequence != sequence ||
                !string.Equals(
                    envelope.Rsid,
                    rsid,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    envelope.Id,
                    envelopeId,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    envelope.Type,
                    messageType,
                    StringComparison.Ordinal))
            {
                throw RbpJournalSerialization.Corrupt(
                    "Retained outbox columns disagree with the envelope.");
            }

            values.Add(new RbpRetainedOutboundData(digest, envelope));
        }

        return values.AsReadOnly();
    }

    private static LoadedInboundSummary ReadInboundSummary(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            RbpJournalSql.InboundBoundsByRsid);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeInboundSummary(reader);
    }

    private LoadedInboundSummary ReadInboundSummary(
        SqliteConnection connection,
        string rsid)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            RbpJournalSql.InboundBoundsByRsid);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeInboundSummary(reader);
    }

    private static long? FindInboundSequenceByEnvelopeId(
        RbpJournalWriteContext context,
        string rsid,
        string envelopeId)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT seq
            FROM rbp_inbound_receipts
            WHERE rsid=$rsid AND envelope_id=$envelope_id;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$envelope_id", envelopeId);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        long sequence = reader.GetInt64(0);
        if (reader.Read())
        {
            throw RbpJournalSerialization.Corrupt(
                "An inbound envelope id maps to multiple receipt rows.");
        }

        return sequence;
    }

    private static RbpAcceptedInboundData? FindInboundReceiptBySequence(
        RbpJournalWriteContext context,
        string rsid,
        long sequence)
    {
        using SqliteCommand command = context.CreateCommand(
            RbpJournalSql.InboundIdentityBySequence);
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$seq", sequence);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeSingleInboundReceipt(reader, sequence);
    }

    private RbpAcceptedInboundData? FindInboundReceiptBySequence(
        SqliteConnection connection,
        string rsid,
        long sequence)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            RbpJournalSql.InboundIdentityBySequence);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$seq", sequence);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeSingleInboundReceipt(reader, sequence);
    }

    private static RbpAcceptedInboundData? MaterializeSingleInboundReceipt(
        SqliteDataReader reader,
        long expectedSequence)
    {
        if (!reader.Read())
        {
            return null;
        }

        long sequence = reader.GetInt64(0);
        string digest = reader.GetString(1);
        if (sequence != expectedSequence ||
            !RbpJournalSerialization.IsSha256Digest(digest))
        {
            throw RbpJournalSerialization.Corrupt(
                "The retained inbound receipt identity is invalid.");
        }

        if (reader.Read())
        {
            throw RbpJournalSerialization.Corrupt(
                "An inbound sequence maps to multiple receipt rows.");
        }

        return new RbpAcceptedInboundData(sequence, digest);
    }

    private static LoadedInboundSummary MaterializeInboundSummary(
        SqliteDataReader reader)
    {
        if (!reader.Read())
        {
            throw RbpJournalSerialization.Corrupt(
                "The inbound receipt summary returned no row.");
        }

        var summary = new LoadedInboundSummary(
            reader.GetInt64(0),
            reader.GetInt64(1),
            reader.GetInt64(2));
        if (reader.Read())
        {
            throw RbpJournalSerialization.Corrupt(
                "The inbound receipt summary returned multiple rows.");
        }

        return summary;
    }

    private RbpRetainedOutboundData? FindOutboxByEnvelopeId(
        RbpJournalWriteContext context,
        string rsid,
        string envelopeId)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT seq,envelope_id,message_type,immutable_digest,envelope_json
            FROM rbp_outbox
            WHERE rsid=$rsid AND envelope_id=$envelope_id;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$envelope_id", envelopeId);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeSingleOutbox(reader, rsid);
    }

    private RbpRetainedOutboundData? FindOutboxByEnvelopeId(
        SqliteConnection connection,
        string rsid,
        string envelopeId)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT seq,envelope_id,message_type,immutable_digest,envelope_json
            FROM rbp_outbox
            WHERE rsid=$rsid AND envelope_id=$envelope_id;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$envelope_id", envelopeId);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeSingleOutbox(reader, rsid);
    }

    private static RbpRetainedOutboundData? MaterializeSingleOutbox(
        SqliteDataReader reader,
        string rsid)
    {
        IReadOnlyList<RbpRetainedOutboundData> values =
            MaterializeOutbox(reader, rsid);
        if (values.Count > 1)
        {
            throw RbpJournalSerialization.Corrupt(
                "An envelope id maps to multiple outbox rows.");
        }

        return values.Count == 0 ? null : values[0];
    }

    private static void PersistSequenceState(
        RbpJournalWriteContext context,
        RbpSequenceState state,
        long updatedAtMilliseconds)
    {
        using SqliteCommand update = context.CreateCommand(
            """
            UPDATE rbp_session_sequence
            SET next_tx_seq=$next_tx_seq,
                highest_tx_seq=$highest_tx_seq,
                last_rx_seq=$last_rx_seq,
                last_peer_ack=$last_peer_ack,
                updated_at_ms=MAX(updated_at_ms,$updated_at_ms)
            WHERE rsid=$rsid;
            """);
        object nextTxValue = state.NextTxSequence is { } next
            ? next
            : DBNull.Value;
        update.Parameters.AddWithValue("$next_tx_seq", nextTxValue);
        update.Parameters.AddWithValue(
            "$highest_tx_seq",
            state.HighestTxSequence);
        update.Parameters.AddWithValue(
            "$last_rx_seq",
            state.LastRxSequence);
        update.Parameters.AddWithValue(
            "$last_peer_ack",
            state.LastPeerAcknowledgement);
        update.Parameters.AddWithValue(
            "$updated_at_ms",
            updatedAtMilliseconds);
        update.Parameters.AddWithValue("$rsid", state.Rsid);
        if (update.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.SessionNotFound,
                "The RBP sequence authority disappeared during update.");
        }
    }

    private static void DeleteAcknowledgedOutbox(
        RbpJournalWriteContext context,
        string rsid,
        long lastPeerAcknowledgement)
    {
        using SqliteCommand delete = context.CreateCommand(
            """
            DELETE FROM rbp_outbox
            WHERE rsid=$rsid AND seq<=$acknowledgement;
            """);
        delete.Parameters.AddWithValue("$rsid", rsid);
        delete.Parameters.AddWithValue(
            "$acknowledgement",
            lastPeerAcknowledgement);
        _ = delete.ExecuteNonQuery();
    }

    private static void RequireExactOutboundReplay(
        RbpRetainedOutboundData existing,
        RbpOutboundDataDraft draft)
    {
        var candidate = new RbpDataEnvelopeSnapshot(
            draft.Type,
            draft.Id,
            existing.Envelope.Rsid,
            existing.Envelope.Sequence,
            draft.Payload,
            draft.Acknowledgement,
            draft.Timestamp,
            draft.Version ?? 1);
        string digest = Rfc8785Json.ImmutableEnvelopeDigest(candidate);
        if (!string.Equals(
                digest,
                existing.ImmutableDigest,
                StringComparison.Ordinal))
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "The outbound envelope id is already retained with " +
                "different immutable content.");
        }
    }

    private static void ValidateSequenceMaterial(
        string rsid,
        long? nextTx,
        long highestTx,
        long lastRx,
        long lastJournaledRx,
        long lastPeerAcknowledgement,
        IReadOnlyList<RbpRetainedOutboundData> outbox,
        long? reservedSequence,
        LoadedInboundSummary inbound)
    {
        bool validCounters =
            highestTx >= 0 &&
            highestTx <= RbpSequenceReducer.MaximumSafeSequence &&
            lastRx >= 0 &&
            lastRx <= RbpSequenceReducer.MaximumSafeSequence &&
            lastJournaledRx >= 0 &&
            lastJournaledRx <= lastRx &&
            lastPeerAcknowledgement >= 0 &&
            lastPeerAcknowledgement <= highestTx &&
            ((nextTx is null &&
              highestTx == RbpSequenceReducer.MaximumSafeSequence) ||
             (nextTx is { } next &&
              next >= 1 &&
              next <= RbpSequenceReducer.MaximumSafeSequence &&
              next == highestTx + 1));
        if (!validCounters)
        {
            throw RbpJournalSerialization.Corrupt(
                "The RBP sequence counters are inconsistent.");
        }

        long previousOutbox = lastPeerAcknowledgement;
        foreach (RbpRetainedOutboundData retained in outbox)
        {
            if (!string.Equals(
                    retained.Envelope.Rsid,
                    rsid,
                    StringComparison.Ordinal) ||
                retained.Envelope.Sequence != previousOutbox + 1 ||
                retained.Envelope.Sequence > highestTx)
            {
                throw RbpJournalSerialization.Corrupt(
                    "The RBP outbox sequence is inconsistent.");
            }

            previousOutbox = retained.Envelope.Sequence;
        }

        // C39 reserves exactly one current sequence outside rbp_outbox so no
        // payload/frame material is ever journaled as ordinary transport data.
        if (reservedSequence is { } reserved &&
            reserved == previousOutbox + 1 &&
            reserved == highestTx)
        {
            previousOutbox = reserved;
        }
        if (previousOutbox != highestTx)
        {
            throw RbpJournalSerialization.Corrupt(
                "The RBP outbox does not cover every unacknowledged " +
                "outbound sequence.");
        }

        bool validInboundRange =
            inbound.ContiguousJournaledSequence == lastJournaledRx &&
            ((lastRx == 0 &&
              inbound.MinimumSequence == 0 &&
              inbound.MaximumSequence == 0) ||
             (lastRx > 0 &&
              inbound.MinimumSequence == 1 &&
              inbound.MaximumSequence == lastRx));
        if (!validInboundRange)
        {
            throw RbpJournalSerialization.Corrupt(
                "The inbound receipt summary disagrees with the receive " +
                "and contiguous invocation-handoff frontiers.");
        }
    }

    private static void RequireActiveSession(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT
              CASE WHEN EXISTS(
                SELECT 1 FROM rbp_sessions WHERE rsid=$rsid
              ) THEN 1 ELSE 0 END,
              CASE WHEN EXISTS(
                SELECT 1 FROM rbp_unregister_tombstones WHERE rsid=$rsid
              ) OR EXISTS(
                SELECT 1 FROM rbp_recovery_sequence_tombstones WHERE rsid=$rsid
              ) THEN 1 ELSE 0 END;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read() || reader.GetInt32(0) != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.SessionNotFound,
                "The RBP session does not exist.");
        }

        if (reader.GetInt32(1) == 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.SessionConflict,
                "The RBP session has durable unregister intent and cannot " +
                "accept transport state.");
        }
    }

    private void RequireActiveSession(
        SqliteConnection connection,
        string rsid)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT
              CASE WHEN EXISTS(
                SELECT 1 FROM rbp_sessions WHERE rsid=$rsid
              ) THEN 1 ELSE 0 END,
              CASE WHEN EXISTS(
                SELECT 1 FROM rbp_unregister_tombstones WHERE rsid=$rsid
              ) OR EXISTS(
                SELECT 1 FROM rbp_recovery_sequence_tombstones WHERE rsid=$rsid
              ) THEN 1 ELSE 0 END;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read() || reader.GetInt32(0) != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.SessionNotFound,
                "The RBP session does not exist.");
        }

        if (reader.GetInt32(1) == 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.SessionConflict,
                "The RBP session has durable unregister intent and cannot " +
                "accept transport state.");
        }
    }

    private sealed record LoadedSequence(
        RbpSequenceState State,
        long LastJournaledReceivedSequence);

    private sealed record LoadedInboundSummary(
        long MinimumSequence,
        long MaximumSequence,
        long ContiguousJournaledSequence);

}
