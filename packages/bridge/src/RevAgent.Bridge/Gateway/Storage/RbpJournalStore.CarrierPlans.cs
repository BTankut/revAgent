using Microsoft.Data.Sqlite;

namespace RevAgent.Bridge.Gateway.Storage;

internal sealed partial class RbpJournalStore
{
    /// <summary>
    /// Fences a durable carrier plan to the terminal outbox sequence after the
    /// outbox transaction has committed, but before any socket send. Repeating
    /// the same fence is idempotent; a different fence is a protocol defect.
    /// </summary>
    internal Task RecordCarrierTerminalQueuedAsync(
        string carrierKey,
        string rsid,
        long terminalSequence,
        CancellationToken cancellationToken = default)
    {
        ValidateCarrierKey(carrierKey);
        ValidateIdentifier(rsid, nameof(rsid), maximumLength: 256);
        if (terminalSequence < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(terminalSequence));
        }

        return ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand read = context.CreateCommand("""
                    SELECT plan.plan_id,plan.terminal_rsid,plan.terminal_sequence,
                           invocation.rsid
                    FROM rbp_carrier_plans AS plan
                    JOIN rbp_invocations AS invocation
                      ON invocation.idempotency_key=plan.idempotency_key
                    WHERE plan.carrier_key=$carrier_key;
                    """);
                read.Parameters.AddWithValue("$carrier_key", carrierKey);
                using SqliteDataReader reader = read.ExecuteReader();
                if (!reader.Read())
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "A carrier terminal has no durable plan.");
                }
                string planId = reader.GetString(0);
                string? existingRsid = reader.IsDBNull(1) ? null : reader.GetString(1);
                long? existingSequence = reader.IsDBNull(2) ? null : reader.GetInt64(2);
                string planRsid = reader.GetString(3);
                if (reader.Read())
                {
                    throw RbpJournalSerialization.Corrupt(
                        "A carrier key maps to multiple durable plans.");
                }
                reader.Close();

                if (!string.Equals(planRsid, rsid, StringComparison.Ordinal))
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "A carrier terminal rsid disagrees with its plan.");
                }
                if (existingRsid is not null || existingSequence is not null)
                {
                    if (!string.Equals(existingRsid, rsid, StringComparison.Ordinal) ||
                        existingSequence != terminalSequence)
                    {
                        throw new RbpJournalException(
                            RbpJournalErrorCode.ProtocolConflict,
                            "A carrier terminal fence is immutable.");
                    }
                    return true;
                }

                using SqliteCommand outbox = context.CreateCommand("""
                    SELECT message_type FROM rbp_outbox
                    WHERE rsid=$rsid AND seq=$sequence;
                    """);
                outbox.Parameters.AddWithValue("$rsid", rsid);
                outbox.Parameters.AddWithValue("$sequence", terminalSequence);
                if (outbox.ExecuteScalar() is not string messageType ||
                    !string.Equals(messageType, "result", StringComparison.Ordinal))
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "A carrier plan can fence only a durable result outbox row.");
                }

                using SqliteCommand update = context.CreateCommand("""
                    UPDATE rbp_carrier_plans
                    SET terminal_rsid=$rsid,terminal_sequence=$sequence
                    WHERE plan_id=$plan_id
                      AND terminal_rsid IS NULL
                      AND terminal_sequence IS NULL;
                    """);
                update.Parameters.AddWithValue("$rsid", rsid);
                update.Parameters.AddWithValue("$sequence", terminalSequence);
                update.Parameters.AddWithValue("$plan_id", planId);
                if (update.ExecuteNonQuery() != 1)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "The carrier terminal fence changed during persistence.");
                }
                return true;
            },
            cancellationToken);
    }

    /// <summary>
    /// Marks only plans whose fenced terminal was acknowledged by the peer.
    /// The immutable frame plan remains attached to its invocation for
    /// idempotent replay after outbox pruning; the returned keys are only a
    /// spool-release signal for the producer's independent cleanup API.
    /// </summary>
    internal Task<IReadOnlyList<string>> ApplyCarrierPlanAcknowledgementsAsync(
        IReadOnlyList<RbpSessionAcknowledgement> acknowledgements,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(acknowledgements);
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                var released = new List<string>();
                foreach (RbpSessionAcknowledgement acknowledgement in acknowledgements
                             .OrderBy(value => value.Rsid, StringComparer.Ordinal))
                {
                    ValidateIdentifier(acknowledgement.Rsid, nameof(acknowledgements), 256);
                    if (acknowledgement.Sequence < 0)
                    {
                        throw new ArgumentOutOfRangeException(nameof(acknowledgements));
                    }

                    using SqliteCommand read = context.CreateCommand("""
                        SELECT plan_id,carrier_key FROM rbp_carrier_plans
                        WHERE terminal_rsid=$rsid AND terminal_sequence <= $sequence
                        ORDER BY terminal_sequence,plan_id;
                        """);
                    read.Parameters.AddWithValue("$rsid", acknowledgement.Rsid);
                    read.Parameters.AddWithValue("$sequence", acknowledgement.Sequence);
                    using SqliteDataReader reader = read.ExecuteReader();
                    var plans = new List<(string PlanId, string CarrierKey)>();
                    while (reader.Read())
                    {
                        plans.Add((reader.GetString(0), reader.GetString(1)));
                    }
                    reader.Close();

                    foreach ((string planId, string carrierKey) in plans)
                    {
                        using SqliteCommand mark = context.CreateCommand("""
                            UPDATE rbp_carrier_plans
                            SET acknowledged_at_ms=COALESCE(acknowledged_at_ms,$now)
                            WHERE plan_id=$plan_id;
                            """);
                        mark.Parameters.AddWithValue("$now", now);
                        mark.Parameters.AddWithValue("$plan_id", planId);
                        if (mark.ExecuteNonQuery() != 1)
                        {
                            throw RbpJournalSerialization.Corrupt(
                                "A carrier plan disappeared before acknowledgement.");
                        }
                        released.Add(carrierKey);
                    }
                }
                return (IReadOnlyList<string>)released.AsReadOnly();
            },
            cancellationToken);
    }

    private static void ValidateCarrierKey(string carrierKey)
    {
        if (carrierKey.Length != 64 || carrierKey.Any(value =>
                !Uri.IsHexDigit(value) || char.IsUpper(value)))
        {
            throw new ArgumentException("Carrier plan key is malformed.", nameof(carrierKey));
        }
    }
}
