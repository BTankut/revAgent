using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Storage;

internal sealed partial class RbpJournalStore
{
    internal Task<long> ActivateConnectionGenerationAsync(
        long connectionGeneration,
        CancellationToken cancellationToken = default)
    {
        if (connectionGeneration < 1 ||
            connectionGeneration > RbpSequenceReducer.MaximumSafeSequence)
        {
            throw new ArgumentOutOfRangeException(
                nameof(connectionGeneration),
                "Connection generation must be a positive JSON-safe integer.");
        }

        return ReadAsync(
            _ =>
            {
                if (connectionGeneration <= _activeConnectionGeneration)
                {
                    throw InvalidHeartbeat(
                        "Connection generation must advance monotonically.");
                }

                _activeConnectionGeneration = connectionGeneration;
                return connectionGeneration;
            },
            cancellationToken);
    }

    internal Task<RbpJournalRecoveryPlan> LoadRecoveryPlanAsync(
        CancellationToken cancellationToken = default)
    {
        long now = NowMilliseconds();
        return ReadAsync(
            connection => BuildRecoveryPlan(connection, now),
            cancellationToken);
    }

    internal async Task<RbpResumeAcknowledgementResult>
        ApplyResumeAcknowledgementAsync(
            string rsid,
            long lastReceivedSequence,
            DateTimeOffset resumeExpiresAt,
            CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), maximumLength: 256);
        long expiresAtMilliseconds =
            resumeExpiresAt.ToUnixTimeMilliseconds();
        if (expiresAtMilliseconds < 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(resumeExpiresAt));
        }

        long now = NowMilliseconds();
        try
        {
            return await ExecuteImmediateAsync(
                    context =>
                    {
                        RequireActiveSession(context, rsid);
                        LoadedSequence loaded =
                            LoadSequence(context, rsid);
                        RequireNoUnresolvedRecoveryTerminalAcknowledgement(
                            context, rsid, lastReceivedSequence);
                        RbpAcknowledgementResult acknowledgement =
                            RbpSequenceReducer
                                .ApplyCumulativeAcknowledgement(
                                    loaded.State,
                                    lastReceivedSequence);
                        if (acknowledgement.Kind is
                            RbpAcknowledgementKind.Stale or
                            RbpAcknowledgementKind.ProtocolFault)
                        {
                            throw new RbpJournalException(
                                RbpJournalErrorCode.ProtocolConflict,
                                "The resume acknowledgement regresses or " +
                                "exceeds durable outbound authority.");
                        }

                        PersistSequenceState(
                            context,
                            acknowledgement.State,
                            now);
                        DeleteAcknowledgedOutbox(
                            context,
                            rsid,
                            acknowledgement
                                .State
                                .LastPeerAcknowledgement);
                        using (SqliteCommand update =
                               context.CreateCommand(
                                    """
                                    UPDATE rbp_sessions
                                    SET resume_expires_at_ms=$expires_at_ms,
                                        updated_at_ms=
                                          MAX(updated_at_ms,$updated_at_ms)
                                    WHERE rsid=$rsid;
                                    """))
                        {
                            update.Parameters.AddWithValue(
                                "$expires_at_ms",
                                expiresAtMilliseconds);
                            update.Parameters.AddWithValue(
                                "$updated_at_ms",
                                now);
                            update.Parameters.AddWithValue("$rsid", rsid);
                            if (update.ExecuteNonQuery() != 1)
                            {
                                throw new RbpJournalException(
                                    RbpJournalErrorCode.SessionNotFound,
                                    "The resumed RBP session disappeared.");
                            }
                        }

                        RbpStoredSession session =
                            ReadStoredSession(context, rsid) ??
                            throw new RbpJournalException(
                                RbpJournalErrorCode.SessionNotFound,
                                "The resumed RBP session disappeared.");
                        IReadOnlyList<RbpDataEnvelopeSnapshot> retransmit =
                            RbpSequenceReducer.RetransmitOutbox(
                                acknowledgement.State,
                                loaded
                                    .LastJournaledReceivedSequence);
                        return new RbpResumeAcknowledgementResult(
                            acknowledgement,
                            session,
                            retransmit);
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpJournalException exception)
            when (exception.ErrorCode ==
                  RbpJournalErrorCode.PostCommitFailure)
        {
            return await RecoverResumeAcknowledgementAsync(
                    rsid,
                    lastReceivedSequence,
                    resumeExpiresAt,
                    exception,
                    CancellationToken.None)
                .ConfigureAwait(false);
        }
    }

    internal async Task<RbpUnregisterTombstone>
        RecordUnregisterIntentAsync(
            string rsid,
            RbpSessionUnregisterReason reason,
            CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), maximumLength: 256);
        string wireReason = RbpJournalSerialization.ReasonToWire(reason);
        long now = NowMilliseconds();
        try
        {
            return await ExecuteImmediateAsync(
                    context =>
                    {
                        RequireSessionExists(context, rsid);
                        // A close/revoke must never silently discard the one
                        // unacknowledged recovery fence.  Tombstone it before
                        // recording unregister intent, retaining its audit
                        // metadata and keeping ordinary outbound dispatch
                        // fail-closed across restart.
                        RbpRecoveryCarrierReservation? recovery =
                            ReadActiveRecoveryCarrierReservation(context, rsid);
                        if (recovery is not null &&
                            recovery.Phase != RbpRecoveryCarrierPhase.Tombstoned)
                        {
                            TombstoneRecoveryCarrierReservation(
                                context,
                                recovery.RecoveryInvocationId,
                                now,
                                "session_unregistered");
                        }
                        RbpUnregisterTombstone? existing =
                            ReadTombstone(context, rsid);
                        if (existing is not null)
                        {
                            if (existing.Reason != reason)
                            {
                                throw new RbpJournalException(
                                    RbpJournalErrorCode.SessionConflict,
                                    "The RBP session already has unregister " +
                                    "intent with a different reason.");
                            }

                            return existing;
                        }

                        using SqliteCommand insert =
                            context.CreateCommand(
                                """
                                INSERT INTO rbp_unregister_tombstones(
                                  rsid,reason,phase,
                                  created_at_ms,updated_at_ms
                                ) VALUES(
                                  $rsid,$reason,'pending',$now,$now
                                );
                                """);
                        insert.Parameters.AddWithValue("$rsid", rsid);
                        insert.Parameters.AddWithValue(
                            "$reason",
                            wireReason);
                        insert.Parameters.AddWithValue("$now", now);
                        _ = insert.ExecuteNonQuery();
                        return new RbpUnregisterTombstone(
                            rsid,
                            reason,
                            RbpUnregisterPhase.Pending,
                            now,
                            now);
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpJournalException exception)
            when (exception.ErrorCode ==
                  RbpJournalErrorCode.PostCommitFailure)
        {
            RbpUnregisterTombstone? observed =
                await GetUnregisterTombstoneAsync(
                        rsid,
                        CancellationToken.None)
                    .ConfigureAwait(false);
            if (observed is not null && observed.Reason == reason)
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.PostCommitFailure,
                    "Matching durable unregister intent was observed after " +
                    "the write result failed. Local dispatch must remain " +
                    "revoked and unregister must not be sent until recovery " +
                    "replays the tombstone.",
                    exception,
                    durableStateObserved: true);
            }

            if (observed is not null)
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.SessionConflict,
                    "A conflicting unregister intent was observed during " +
                    "post-commit recovery.",
                    exception);
            }

            throw;
        }
    }

    internal Task<RbpUnregisterTombstone?> GetUnregisterTombstoneAsync(
        string rsid,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), maximumLength: 256);
        return ReadAsync(
            connection => ReadTombstone(connection, rsid),
            cancellationToken);
    }

    internal async Task<RbpHeartbeatFenceResult>
        ApplyHeartbeatFenceAcknowledgementAsync(
            RbpHeartbeatFence fence,
            CancellationToken cancellationToken = default)
    {
        ValidateHeartbeatFenceShape(fence);
        fence = fence with
        {
            ExpectedActiveRsids = Array.AsReadOnly(
                fence.ExpectedActiveRsids.ToArray()),
            Acknowledgements = Array.AsReadOnly(
                fence.Acknowledgements.ToArray()),
            ConfirmUnregisterRsids = Array.AsReadOnly(
                fence.ConfirmUnregisterRsids.ToArray()),
        };
        long now = NowMilliseconds();
        try
        {
            return await ExecuteImmediateAsync(
                    context =>
                    {
                        RequireActiveConnectionGeneration(
                            fence.ConnectionGeneration);
                        var expected = new HashSet<string>(
                            fence.ExpectedActiveRsids,
                            StringComparer.Ordinal);
                        var acknowledgements =
                            fence.Acknowledgements.ToDictionary(
                                item => item.Rsid,
                                item => item.Sequence,
                                StringComparer.Ordinal);
                        if (!expected.SetEquals(acknowledgements.Keys))
                        {
                            throw InvalidHeartbeat(
                                "Heartbeat acknowledgement rsids do not " +
                                "exactly match the fenced active set.");
                        }

                        foreach (string rsid in
                                 fence.ConfirmUnregisterRsids)
                        {
                            if (expected.Contains(rsid))
                            {
                                throw InvalidHeartbeat(
                                    "A tombstoned rsid cannot also be in the " +
                                    "fenced active set.");
                            }

                            RbpUnregisterTombstone? tombstone =
                                ReadTombstone(context, rsid);
                            if (tombstone is null ||
                                tombstone.Phase !=
                                RbpUnregisterPhase.Pending)
                            {
                                throw InvalidHeartbeat(
                                    "The heartbeat fence can confirm only " +
                                    "pending unregister tombstones.");
                            }

                            if (HasPendingInboundHandoff(context, rsid))
                            {
                                throw InvalidHeartbeat(
                                    "An unregister tombstone cannot be " +
                                    "confirmed before every accepted inbound " +
                                    "envelope has an atomic journal handoff.");
                            }
                        }

                        var acknowledgementResults =
                            new List<(string Rsid,
                                RbpAcknowledgementResult Result)>();
                        foreach (string rsid in expected.Order(
                                     StringComparer.Ordinal))
                        {
                            RequireActiveSession(context, rsid);
                            LoadedSequence loaded =
                                LoadSequence(context, rsid);
                            RequireNoUnresolvedRecoveryTerminalAcknowledgement(
                                context, rsid, acknowledgements[rsid]);
                            RbpAcknowledgementResult result =
                                RbpSequenceReducer
                                    .ApplyCumulativeAcknowledgement(
                                        loaded.State,
                                        acknowledgements[rsid]);
                            if (result.Kind is
                                RbpAcknowledgementKind.Stale or
                                RbpAcknowledgementKind.ProtocolFault)
                            {
                                throw InvalidHeartbeat(
                                    "A heartbeat data acknowledgement " +
                                    "regresses or exceeds durable outbound " +
                                    "authority.");
                            }

                            acknowledgementResults.Add((rsid, result));
                        }

                        foreach ((string rsid,
                                 RbpAcknowledgementResult result)
                                 in acknowledgementResults)
                        {
                            PersistSequenceState(context, result.State, now);
                            DeleteAcknowledgedOutbox(
                                context,
                                rsid,
                                result.State.LastPeerAcknowledgement);
                        }

                        foreach (string rsid in
                                 fence.ConfirmUnregisterRsids)
                        {
                            using (SqliteCommand confirm =
                                   context.CreateCommand(
                                       """
                                       UPDATE rbp_unregister_tombstones
                                       SET phase='confirmed',
                                           updated_at_ms=
                                             MAX(updated_at_ms,$updated_at_ms)
                                       WHERE rsid=$rsid AND phase='pending';
                                       """))
                            {
                                confirm.Parameters.AddWithValue(
                                    "$updated_at_ms",
                                    now);
                                confirm.Parameters.AddWithValue("$rsid", rsid);
                                if (confirm.ExecuteNonQuery() != 1)
                                {
                                    throw InvalidHeartbeat(
                                        "A pending unregister tombstone " +
                                        "changed during fence processing.");
                                }
                            }

                            DeleteTransportState(context, rsid);
                        }

                        return new RbpHeartbeatFenceResult(
                            Array.AsReadOnly(
                                expected
                                    .Order(StringComparer.Ordinal)
                                    .ToArray()),
                            Array.AsReadOnly(
                                fence.ConfirmUnregisterRsids
                                    .Order(StringComparer.Ordinal)
                                    .ToArray()));
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpJournalException exception)
            when (exception.ErrorCode ==
                  RbpJournalErrorCode.PostCommitFailure)
        {
            return await RecoverHeartbeatFenceAsync(
                    fence,
                    exception,
                    CancellationToken.None)
                .ConfigureAwait(false);
        }
    }

    internal async Task<bool> CompleteConfirmedUnregisterAsync(
        string rsid,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), maximumLength: 256);
        try
        {
            return await ExecuteImmediateAsync(
                    context =>
                    {
                        RbpUnregisterTombstone? tombstone =
                            ReadTombstone(context, rsid);
                        if (tombstone is null)
                        {
                            return false;
                        }

                        if (tombstone.Phase !=
                            RbpUnregisterPhase.Confirmed)
                        {
                            throw new RbpJournalException(
                                RbpJournalErrorCode.CleanupIncomplete,
                                "Unregister cleanup cannot finish before a " +
                                "heartbeat fence confirms the tombstone.");
                        }

                        EnsureTransportStateDeleted(context, rsid);
                        using SqliteCommand delete = context.CreateCommand(
                            """
                            DELETE FROM rbp_sessions WHERE rsid=$rsid;
                            """);
                        delete.Parameters.AddWithValue("$rsid", rsid);
                        try
                        {
                            if (delete.ExecuteNonQuery() != 1)
                            {
                                throw new RbpJournalException(
                                    RbpJournalErrorCode.CleanupIncomplete,
                                    "The confirmed RBP session could not be " +
                                    "removed.");
                            }
                        }
                        catch (SqliteException exception)
                        {
                            throw new RbpJournalException(
                                RbpJournalErrorCode.CleanupIncomplete,
                                "Session artifacts still reference the " +
                                "confirmed RBP session. Cleanup must finish " +
                                "before the tombstone is removed.",
                                exception);
                        }

                        return true;
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpJournalException exception)
            when (exception.ErrorCode ==
                  RbpJournalErrorCode.PostCommitFailure)
        {
            RbpUnregisterTombstone? observed =
                await GetUnregisterTombstoneAsync(
                        rsid,
                        CancellationToken.None)
                    .ConfigureAwait(false);
            if (observed is null)
            {
                return true;
            }

            throw;
        }
    }

    private RbpJournalRecoveryPlan BuildRecoveryPlan(
        SqliteConnection connection,
        long nowMilliseconds)
    {
        IReadOnlyList<RbpUnregisterTombstone> tombstones =
            ReadTombstones(connection);
        var tombstoneRsids = new HashSet<string>(
            tombstones.Select(item => item.Rsid),
            StringComparer.Ordinal);
        IReadOnlyList<RbpPendingInboundHandoff> pendingHandoffs =
            ReadPendingInboundHandoffs(connection);
        var resume = new List<RbpResumeCandidate>();
        var expired = new List<RbpExpiredSession>();
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT rsid,local_session_key,resume_expires_at_ms
            FROM rbp_sessions
            ORDER BY rsid;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        using SqliteDataReader reader = command.ExecuteReader();
        var sessionRows = new List<RecoverySessionRow>();
        while (reader.Read())
        {
            sessionRows.Add(
                new RecoverySessionRow(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetInt64(2)));
        }

        foreach (RecoverySessionRow row in sessionRows)
        {
            string rsid = row.Rsid;
            if (tombstoneRsids.Contains(rsid))
            {
                continue;
            }

            if (row.ResumeExpiresAtMilliseconds <= nowMilliseconds)
            {
                expired.Add(
                    new RbpExpiredSession(
                        rsid,
                        row.LocalSessionKey,
                        DateTimeOffset.FromUnixTimeMilliseconds(
                            row.ResumeExpiresAtMilliseconds)));
                continue;
            }

            RbpStoredSession session =
                ReadStoredSession(connection, rsid) ??
                throw RbpJournalSerialization.Corrupt(
                    "A recovery session disappeared during its read.");
            LoadedSequence sequence = LoadSequence(connection, rsid);
            IReadOnlyList<RbpDataEnvelopeSnapshot> outbox =
                RbpSequenceReducer.RetransmitOutbox(
                    sequence.State,
                    sequence.LastJournaledReceivedSequence);
            resume.Add(
                new RbpResumeCandidate(
                    session,
                    sequence.LastJournaledReceivedSequence,
                    outbox));
        }

        return new RbpJournalRecoveryPlan(
            Array.AsReadOnly(
                tombstones
                    .Where(
                        item =>
                            item.Phase == RbpUnregisterPhase.Confirmed)
                    .ToArray()),
            Array.AsReadOnly(
                tombstones
                    .Where(
                        item =>
                            item.Phase == RbpUnregisterPhase.Pending)
                    .ToArray()),
            pendingHandoffs,
            resume.AsReadOnly(),
            expired.AsReadOnly());
    }

    private async Task<RbpResumeAcknowledgementResult>
        RecoverResumeAcknowledgementAsync(
            string rsid,
            long lastReceivedSequence,
            DateTimeOffset resumeExpiresAt,
            RbpJournalException original,
            CancellationToken cancellationToken)
    {
        return await ReadAsync(
                connection =>
                {
                    RequireActiveSession(connection, rsid);
                    RbpStoredSession? session =
                        ReadStoredSession(connection, rsid);
                    if (session is null ||
                        session.ResumeExpiresAt.ToUnixTimeMilliseconds() !=
                        resumeExpiresAt.ToUnixTimeMilliseconds())
                    {
                        throw original;
                    }

                    LoadedSequence loaded =
                        LoadSequence(connection, rsid);
                    if (loaded.State.LastPeerAcknowledgement !=
                        lastReceivedSequence)
                    {
                        throw original;
                    }

                    RbpAcknowledgementResult replay =
                        RbpSequenceReducer.ApplyCumulativeAcknowledgement(
                            loaded.State,
                            lastReceivedSequence);
                    return new RbpResumeAcknowledgementResult(
                        replay,
                        session,
                        RbpSequenceReducer.RetransmitOutbox(
                            loaded.State,
                            loaded.LastJournaledReceivedSequence));
                },
                cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<RbpHeartbeatFenceResult>
        RecoverHeartbeatFenceAsync(
            RbpHeartbeatFence fence,
            RbpJournalException original,
            CancellationToken cancellationToken)
    {
        return await ReadAsync(
                connection =>
                {
                    RequireActiveConnectionGeneration(
                        fence.ConnectionGeneration);
                    foreach (RbpSessionAcknowledgement acknowledgement in
                             fence.Acknowledgements)
                    {
                        RequireActiveSession(
                            connection,
                            acknowledgement.Rsid);
                        LoadedSequence loaded =
                            LoadSequence(connection, acknowledgement.Rsid);
                        if (loaded.State.LastPeerAcknowledgement !=
                            acknowledgement.Sequence)
                        {
                            throw original;
                        }
                    }

                    foreach (string rsid in
                             fence.ConfirmUnregisterRsids)
                    {
                        RbpUnregisterTombstone? tombstone =
                            ReadTombstone(connection, rsid);
                        if (tombstone is null ||
                            tombstone.Phase !=
                            RbpUnregisterPhase.Confirmed ||
                            HasTransportState(connection, rsid))
                        {
                            throw original;
                        }
                    }

                    return new RbpHeartbeatFenceResult(
                        Array.AsReadOnly(
                            fence.ExpectedActiveRsids
                                .Order(StringComparer.Ordinal)
                                .ToArray()),
                        Array.AsReadOnly(
                            fence.ConfirmUnregisterRsids
                                .Order(StringComparer.Ordinal)
                                .ToArray()));
                },
                cancellationToken)
            .ConfigureAwait(false);
    }

    private IReadOnlyList<RbpPendingInboundHandoff>
        ReadPendingInboundHandoffs(SqliteConnection connection)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT rsid,seq,envelope_id,message_type,immutable_digest,
                   envelope_json,accepted_at_ms
            FROM rbp_inbound_receipts
            WHERE handoff_state='pending'
            ORDER BY rsid,seq;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        using SqliteDataReader reader = command.ExecuteReader();
        var values = new List<RbpPendingInboundHandoff>();
        while (reader.Read())
        {
            string rsid = reader.GetString(0);
            long sequence = reader.GetInt64(1);
            string envelopeId = reader.GetString(2);
            string messageType = reader.GetString(3);
            string digest = reader.GetString(4);
            RbpDataEnvelopeSnapshot envelope =
                RbpJournalSerialization.ParseEnvelope(
                    reader.GetString(5),
                    digest);
            if (!string.Equals(
                    envelope.Rsid,
                    rsid,
                    StringComparison.Ordinal) ||
                envelope.Sequence != sequence ||
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
                    "A pending inbound handoff disagrees with its receipt.");
            }

            values.Add(
                new RbpPendingInboundHandoff(
                    rsid,
                    envelope,
                    reader.GetInt64(6)));
        }

        return values.AsReadOnly();
    }

    private IReadOnlyList<RbpUnregisterTombstone> ReadTombstones(
        SqliteConnection connection)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT rsid,reason,phase,created_at_ms,updated_at_ms
            FROM rbp_unregister_tombstones
            ORDER BY rsid;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        using SqliteDataReader reader = command.ExecuteReader();
        var values = new List<RbpUnregisterTombstone>();
        while (reader.Read())
        {
            values.Add(MaterializeTombstone(reader));
        }

        return values.AsReadOnly();
    }

    private RbpUnregisterTombstone? ReadTombstone(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT rsid,reason,phase,created_at_ms,updated_at_ms
            FROM rbp_unregister_tombstones
            WHERE rsid=$rsid;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return reader.Read() ? MaterializeTombstone(reader) : null;
    }

    private RbpUnregisterTombstone? ReadTombstone(
        SqliteConnection connection,
        string rsid)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT rsid,reason,phase,created_at_ms,updated_at_ms
            FROM rbp_unregister_tombstones
            WHERE rsid=$rsid;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return reader.Read() ? MaterializeTombstone(reader) : null;
    }

    private static RbpUnregisterTombstone MaterializeTombstone(
        SqliteDataReader reader)
    {
        return new RbpUnregisterTombstone(
            reader.GetString(0),
            RbpJournalSerialization.ParseReason(reader.GetString(1)),
            RbpJournalSerialization.ParsePhase(reader.GetString(2)),
            reader.GetInt64(3),
            reader.GetInt64(4));
    }

    private static void RequireSessionExists(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT COUNT(*) FROM rbp_sessions WHERE rsid=$rsid;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        if (Convert.ToInt32(command.ExecuteScalar()) != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.SessionNotFound,
                "The RBP session does not exist.");
        }
    }

    private static void DeleteTransportState(
        RbpJournalWriteContext context,
        string rsid)
    {
        foreach (string table in new[]
                 {
                     "rbp_outbox",
                     "rbp_inbound_receipts",
                     "rbp_session_sequence",
                 })
        {
            using SqliteCommand delete = context.CreateCommand(
                $"DELETE FROM {table} WHERE rsid=$rsid;");
            delete.Parameters.AddWithValue("$rsid", rsid);
            _ = delete.ExecuteNonQuery();
        }
    }

    private static void EnsureTransportStateDeleted(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT
              (SELECT COUNT(*) FROM rbp_outbox WHERE rsid=$rsid) +
              (SELECT COUNT(*) FROM rbp_inbound_receipts WHERE rsid=$rsid) +
              (SELECT COUNT(*) FROM rbp_session_sequence WHERE rsid=$rsid);
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        if (Convert.ToInt64(command.ExecuteScalar()) != 0)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.CleanupIncomplete,
                "Confirmed unregister transport state has not been removed.");
        }
    }

    private static bool HasPendingInboundHandoff(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT COUNT(*)
            FROM rbp_inbound_receipts
            WHERE rsid=$rsid AND handoff_state='pending';
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        return Convert.ToInt64(command.ExecuteScalar()) != 0;
    }

    private bool HasTransportState(
        SqliteConnection connection,
        string rsid)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT
              (SELECT COUNT(*) FROM rbp_outbox WHERE rsid=$rsid) +
              (SELECT COUNT(*) FROM rbp_inbound_receipts WHERE rsid=$rsid) +
              (SELECT COUNT(*) FROM rbp_session_sequence WHERE rsid=$rsid);
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        return Convert.ToInt64(command.ExecuteScalar()) != 0;
    }

    private static void ValidateHeartbeatFenceShape(
        RbpHeartbeatFence fence)
    {
        ArgumentNullException.ThrowIfNull(fence);
        if (fence.ConnectionGeneration < 1)
        {
            throw InvalidHeartbeat(
                "Heartbeat fence connection generation must be positive.");
        }

        ArgumentNullException.ThrowIfNull(fence.ExpectedActiveRsids);
        ArgumentNullException.ThrowIfNull(fence.Acknowledgements);
        ArgumentNullException.ThrowIfNull(
            fence.ConfirmUnregisterRsids);
        RequireDistinctRsids(
            fence.ExpectedActiveRsids,
            "Heartbeat active-session rsids must be distinct.");
        RequireDistinctRsids(
            fence.Acknowledgements.Select(item => item.Rsid),
            "Heartbeat acknowledgement rsids must be distinct.");
        RequireDistinctRsids(
            fence.ConfirmUnregisterRsids,
            "Heartbeat unregister confirmations must be distinct.");
        foreach (RbpSessionAcknowledgement acknowledgement in
                 fence.Acknowledgements)
        {
            if (acknowledgement.Sequence < 0 ||
                acknowledgement.Sequence >
                RbpSequenceReducer.MaximumSafeSequence)
            {
                throw InvalidHeartbeat(
                    "Heartbeat acknowledgement is outside the JSON-safe " +
                    "sequence range.");
            }
        }
    }

    private static void RequireDistinctRsids(
        IEnumerable<string> values,
        string message)
    {
        var unique = new HashSet<string>(StringComparer.Ordinal);
        foreach (string value in values)
        {
            if (string.IsNullOrWhiteSpace(value) ||
                value.Length > 256 ||
                !unique.Add(value))
            {
                throw InvalidHeartbeat(message);
            }
        }
    }

    private static RbpJournalException InvalidHeartbeat(string message) =>
        new(RbpJournalErrorCode.InvalidHeartbeatFence, message);

    private void RequireActiveConnectionGeneration(long observed)
    {
        if (_activeConnectionGeneration < 1 ||
            observed != _activeConnectionGeneration)
        {
            throw InvalidHeartbeat(
                "Heartbeat acknowledgement belongs to a stale or " +
                "unregistered connection generation.");
        }
    }

    private sealed record RecoverySessionRow(
        string Rsid,
        string LocalSessionKey,
        long ResumeExpiresAtMilliseconds);
}
