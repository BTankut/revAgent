using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Storage;

internal sealed class RbpJournalWriteContext
{
    private readonly SqliteConnection _connection;
    private readonly SqliteTransaction _transaction;
    private readonly int _commandTimeoutSeconds;

    internal bool SensitiveCompactionPerformed { get; private set; }

    internal RbpJournalWriteContext(
        SqliteConnection connection,
        SqliteTransaction transaction,
        int commandTimeoutSeconds)
    {
        _connection = connection;
        _transaction = transaction;
        _commandTimeoutSeconds = commandTimeoutSeconds;
    }

    internal SqliteCommand CreateCommand(string commandText)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(commandText);
        SqliteCommand command = _connection.CreateCommand();
        command.Transaction = _transaction;
        command.CommandTimeout = _commandTimeoutSeconds;
        command.CommandText = commandText;
        return command;
    }

    internal void MarkInboundJournaled(
        string rsid,
        long sequence,
        string expectedEnvelopeId,
        string expectedImmutableDigest,
        string correlationId,
        string contextJson,
        long journaledAtMilliseconds)
    {
        RequireText(rsid, nameof(rsid));
        RequireText(expectedEnvelopeId, nameof(expectedEnvelopeId));
        RequireText(expectedImmutableDigest, nameof(expectedImmutableDigest));
        RequireText(correlationId, nameof(correlationId));
        RequireText(contextJson, nameof(contextJson));
        if (sequence < 1 ||
            sequence > RbpSequenceReducer.MaximumSafeSequence)
        {
            throw new ArgumentOutOfRangeException(nameof(sequence));
        }

        if (journaledAtMilliseconds < 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(journaledAtMilliseconds));
        }

        using SqliteCommand read = CreateCommand(
            """
            SELECT envelope_id,immutable_digest,handoff_state,
                   correlation_id,context_json,journaled_at_ms
            FROM rbp_inbound_receipts
            WHERE rsid=$rsid AND seq=$seq;
            """);
        read.Parameters.AddWithValue("$rsid", rsid);
        read.Parameters.AddWithValue("$seq", sequence);
        using SqliteDataReader reader = read.ExecuteReader();
        if (!reader.Read())
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "The inbound RBP envelope was not durably accepted before " +
                "journal handoff.");
        }

        bool exactEnvelope =
            string.Equals(
                reader.GetString(0),
                expectedEnvelopeId,
                StringComparison.Ordinal) &&
            string.Equals(
                reader.GetString(1),
                expectedImmutableDigest,
                StringComparison.Ordinal);
        if (!exactEnvelope)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "The inbound RBP journal handoff does not match the retained " +
                "immutable envelope.");
        }

        string state = reader.GetString(2);
        if (string.Equals(state, "journaled", StringComparison.Ordinal))
        {
            bool exactReplay =
                string.Equals(
                    reader.GetString(3),
                    correlationId,
                    StringComparison.Ordinal) &&
                string.Equals(
                    reader.GetString(4),
                    contextJson,
                    StringComparison.Ordinal);
            if (!exactReplay)
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.ProtocolConflict,
                    "The inbound RBP envelope is already bound to different " +
                    "journal evidence.");
            }

            reader.Dispose();
            AdvanceJournaledFrontier(rsid, journaledAtMilliseconds);
            return;
        }

        reader.Dispose();
        using SqliteCommand update = CreateCommand(
            """
            UPDATE rbp_inbound_receipts
            SET handoff_state='journaled',
                envelope_json=NULL,
                correlation_id=$correlation_id,
                context_json=$context_json,
                journaled_at_ms=MAX(accepted_at_ms,$journaled_at_ms)
            WHERE rsid=$rsid AND seq=$seq AND handoff_state='pending';
            """);
        update.Parameters.AddWithValue("$correlation_id", correlationId);
        update.Parameters.AddWithValue("$context_json", contextJson);
        update.Parameters.AddWithValue(
            "$journaled_at_ms",
            journaledAtMilliseconds);
        update.Parameters.AddWithValue("$rsid", rsid);
        update.Parameters.AddWithValue("$seq", sequence);
        if (update.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "The inbound RBP journal handoff lost its pending receipt.");
        }

        SensitiveCompactionPerformed = true;
        AdvanceJournaledFrontier(rsid, journaledAtMilliseconds);
    }

    private void AdvanceJournaledFrontier(
        string rsid,
        long updatedAtMilliseconds)
    {
        long current;
        long lastAccepted;
        using (SqliteCommand frontier = CreateCommand(
                   """
                   SELECT last_journaled_rx_seq,last_rx_seq
                   FROM rbp_session_sequence
                   WHERE rsid=$rsid;
                   """))
        {
            frontier.Parameters.AddWithValue("$rsid", rsid);
            using SqliteDataReader reader = frontier.ExecuteReader();
            if (!reader.Read())
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.SessionNotFound,
                    "The RBP receive frontier is missing.");
            }

            current = reader.GetInt64(0);
            lastAccepted = reader.GetInt64(1);
        }

        long next = current == RbpSequenceReducer.MaximumSafeSequence
            ? current
            : current + 1;
        using (SqliteCommand receipts = CreateCommand(
                   """
                   SELECT seq,handoff_state
                   FROM rbp_inbound_receipts
                   WHERE rsid=$rsid AND seq>$current
                   ORDER BY seq;
                   """))
        {
            receipts.Parameters.AddWithValue("$rsid", rsid);
            receipts.Parameters.AddWithValue("$current", current);
            using SqliteDataReader reader = receipts.ExecuteReader();
            while (reader.Read())
            {
                long sequence = reader.GetInt64(0);
                if (sequence != next ||
                    !string.Equals(
                        reader.GetString(1),
                        "journaled",
                        StringComparison.Ordinal))
                {
                    break;
                }

                current = sequence;
                next++;
            }
        }

        if (current > lastAccepted)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The journaled receive frontier exceeds accepted data.");
        }

        using SqliteCommand update = CreateCommand(
            """
            UPDATE rbp_session_sequence
            SET last_journaled_rx_seq=$frontier,
                updated_at_ms=MAX(updated_at_ms,$updated_at_ms)
            WHERE rsid=$rsid AND last_journaled_rx_seq<=$frontier;
            """);
        update.Parameters.AddWithValue("$frontier", current);
        update.Parameters.AddWithValue(
            "$updated_at_ms",
            updatedAtMilliseconds);
        update.Parameters.AddWithValue("$rsid", rsid);
        if (update.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "The RBP journaled receive frontier changed unexpectedly.");
        }
    }

    private static void RequireText(string value, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException(
                "Value must not be empty.",
                parameterName);
        }
    }
}
