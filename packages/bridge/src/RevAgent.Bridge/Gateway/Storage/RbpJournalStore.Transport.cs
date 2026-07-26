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
                                loaded.State,
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
                        loaded.State.AcceptedInbound.FirstOrDefault(
                            item => item.Sequence == incoming.Sequence);
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
            () => ReadAcceptedInbound(context, rsid),
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
            () => ReadAcceptedInbound(connection, rsid),
            rsid);
    }

    private static LoadedSequence LoadSequence(
        SqliteCommand sequenceCommand,
        Func<IReadOnlyList<RbpRetainedOutboundData>> readOutbox,
        Func<LoadedInboundReceipts> readAcceptedInbound,
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
        LoadedInboundReceipts inbound =
            readAcceptedInbound();
        ValidateSequenceMaterial(
            rsid,
            nextTx,
            highestTx,
            lastRx,
            lastJournaledRx,
            lastPeerAcknowledgement,
            outbox,
            inbound.Accepted,
            inbound.ContiguousJournaledSequence);
        return new LoadedSequence(
            new RbpSequenceState(
                rsid,
                nextTx,
                highestTx,
                lastRx,
                lastPeerAcknowledgement,
                outbox,
                inbound.Accepted),
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

    private LoadedInboundReceipts ReadAcceptedInbound(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT seq,envelope_id,message_type,immutable_digest,envelope_json,
                   handoff_state
            FROM rbp_inbound_receipts
            WHERE rsid=$rsid
            ORDER BY seq;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeAcceptedInbound(reader, rsid);
    }

    private LoadedInboundReceipts ReadAcceptedInbound(
        SqliteConnection connection,
        string rsid)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT seq,envelope_id,message_type,immutable_digest,envelope_json,
                   handoff_state
            FROM rbp_inbound_receipts
            WHERE rsid=$rsid
            ORDER BY seq;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return MaterializeAcceptedInbound(reader, rsid);
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

    private static LoadedInboundReceipts
        MaterializeAcceptedInbound(
            SqliteDataReader reader,
            string rsid)
    {
        var values = new List<RbpAcceptedInboundData>();
        long contiguousJournaledSequence = 0;
        bool journaledPrefixEnded = false;
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
                    "Inbound receipt columns disagree with the envelope.");
            }

            values.Add(new RbpAcceptedInboundData(sequence, digest));
            string handoffState = reader.GetString(5);
            if (!string.Equals(
                    handoffState,
                    "pending",
                    StringComparison.Ordinal) &&
                !string.Equals(
                    handoffState,
                    "journaled",
                    StringComparison.Ordinal))
            {
                throw RbpJournalSerialization.Corrupt(
                    "An inbound receipt has an invalid handoff state.");
            }

            if (!journaledPrefixEnded &&
                sequence == contiguousJournaledSequence + 1 &&
                string.Equals(
                    handoffState,
                    "journaled",
                    StringComparison.Ordinal))
            {
                contiguousJournaledSequence = sequence;
            }
            else
            {
                journaledPrefixEnded = true;
            }
        }

        return new LoadedInboundReceipts(
            values.AsReadOnly(),
            contiguousJournaledSequence);
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
        IReadOnlyList<RbpAcceptedInboundData> acceptedInbound,
        long observedJournaledFrontier)
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

        if (previousOutbox != highestTx)
        {
            throw RbpJournalSerialization.Corrupt(
                "The RBP outbox does not cover every unacknowledged " +
                "outbound sequence.");
        }

        long expectedInbound = 1;
        foreach (RbpAcceptedInboundData accepted in acceptedInbound)
        {
            if (accepted.Sequence != expectedInbound)
            {
                throw RbpJournalSerialization.Corrupt(
                    "The accepted inbound sequence is not contiguous.");
            }

            expectedInbound++;
        }

        if (acceptedInbound.Count != lastRx)
        {
            throw RbpJournalSerialization.Corrupt(
                "The accepted inbound receipt count disagrees with the " +
                "receive frontier.");
        }

        if (observedJournaledFrontier != lastJournaledRx)
        {
            throw RbpJournalSerialization.Corrupt(
                "The stored journaled receive frontier does not match the " +
                "contiguous invocation-handoff prefix.");
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

    private sealed record LoadedInboundReceipts(
        IReadOnlyList<RbpAcceptedInboundData> Accepted,
        long ContiguousJournaledSequence);

}
