using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Dispatch;

namespace RevAgent.Bridge.Gateway.Storage;

/// <summary>
/// Exact per-authority row counts removed by one deterministic
/// <see cref="RbpJournalStore.ApplyRetentionAsync"/> sweep.
/// </summary>
internal sealed record RbpJournalRetentionResult(
    int PrunedInvocations,
    int PrunedClearedHolds,
    int PrunedInboundReceipts,
    int PrunedOutboxEnvelopes,
    int PrunedTransportSessions,
    int PrunedTerminalBatches = 0,
    int PrunedCarrierPlans = 0,
    IReadOnlyList<RbpReleasedCarrier>? ReleasedCarriers = null)
{
    internal IReadOnlyList<RbpReleasedCarrier> ExactReleasedCarriers =>
        ReleasedCarriers ?? Array.Empty<RbpReleasedCarrier>();
}

/// <summary>
/// Frozen O1 Section 12.2 journal retention. The journal retains entries
/// for at least seven days (frozen floor) and defaults to fourteen; it
/// never prunes a non-terminal invocation row, never prunes an
/// <c>active|evidence_recorded|resolved_pending_bridge</c> hold, and never
/// prunes a row such a hold still references, no matter how old the row or
/// how large the store. Cleared holds and their evidence remain for at
/// least the retention period. Transport rows are removed only as a whole
/// per-session set, and only for sessions whose resume window closed at
/// least one full retention period ago, so no supported resume/redelivery
/// window is ever shortened and the inbound receipt history stays
/// contiguous with its durable receive frontiers.
/// </summary>
internal sealed partial class RbpJournalStore
{
    internal static readonly TimeSpan MinimumRetentionPeriod =
        TimeSpan.FromDays(7);

    internal static readonly TimeSpan DefaultRetentionPeriod =
        TimeSpan.FromDays(14);

    private const string PrunableTransportSessions = """
        SELECT sessions.rsid
        FROM rbp_sessions AS sessions
        WHERE sessions.resume_expires_at_ms<=$cutoff
          AND NOT EXISTS(
            SELECT 1
            FROM rbp_unregister_tombstones AS tombstones
            WHERE tombstones.rsid=sessions.rsid
          )
          AND NOT EXISTS(
            SELECT 1
            FROM rbp_inbound_receipts AS receipts
            WHERE receipts.rsid=sessions.rsid
              AND (receipts.handoff_state='pending'
                   OR receipts.accepted_at_ms>$cutoff)
          )
          AND NOT EXISTS(
            SELECT 1
            FROM rbp_outbox AS outbox
            WHERE outbox.rsid=sessions.rsid
              AND outbox.created_at_ms>$cutoff
          )
        """;

    /// <summary>
    /// Applies one deterministic, transactional retention sweep and returns
    /// the exact number of rows removed per authority. A retention period
    /// below the frozen seven-day floor is rejected, never clamped.
    /// </summary>
    internal Task<RbpJournalRetentionResult> ApplyRetentionAsync(
        TimeSpan? retentionPeriod = null,
        CancellationToken cancellationToken = default)
    {
        TimeSpan period = retentionPeriod ?? DefaultRetentionPeriod;
        if (period < MinimumRetentionPeriod)
        {
            throw new ArgumentOutOfRangeException(
                nameof(retentionPeriod),
                "The frozen journal retention floor is seven days.");
        }

        long now = NowMilliseconds();
        long cutoff = now - (long)period.TotalMilliseconds;
        return ExecuteImmediateAsync(
            context =>
            {
                PruneRecoveryPayloadsWithParents(context, cutoff, now);
                (IReadOnlyList<RbpReleasedCarrier> releasedCarriers,
                 int carrierInvocations) =
                    PruneExpiredCarrierPlans(context, cutoff);
                int invocations = carrierInvocations +
                    PruneTerminalInvocations(context, cutoff);
                int batches = PruneTerminalBatches(context, cutoff);
                int holds = PruneClearedHolds(context, cutoff);
                int receipts = PruneTransportRows(
                    context,
                    "rbp_inbound_receipts",
                    cutoff);
                int outbox = PruneTransportRows(
                    context,
                    "rbp_outbox",
                    cutoff);
                int sessions = PruneTransportRows(
                    context,
                    "rbp_session_sequence",
                    cutoff);
                return releasedCarriers.Count == 0
                    ? new RbpJournalRetentionResult(
                        invocations,
                        holds,
                        receipts,
                        outbox,
                        sessions,
                        batches,
                        0)
                    : new RbpJournalRetentionResult(
                        invocations,
                        holds,
                        receipts,
                        outbox,
                        sessions,
                        batches,
                        releasedCarriers.Count,
                        releasedCarriers);
            },
            cancellationToken);
    }

    private static void PruneRecoveryPayloadsWithParents(
        RbpJournalWriteContext context,
        long cutoff,
        long now)
    {
        // v7 recovery material has the same parent lifetime as the terminal
        // invocation.  Delete the child first, in this retention transaction,
        // only where the parent is itself eligible; this is a coupled prune,
        // never an early byte-cap eviction.
        using SqliteCommand delete = context.CreateCommand("""
            DELETE FROM rbp_recovery_payloads
            WHERE retention_expires_at_ms<=$now
               OR idempotency_key IN (
              SELECT invocation.idempotency_key
              FROM rbp_invocations AS invocation
              WHERE invocation.state IN ('completed','failed','guarded','cancelled','indeterminate')
                AND invocation.finished_at_ms<=$cutoff
                AND invocation.carrier_plan_id IS NULL
                AND NOT EXISTS(
                  SELECT 1 FROM rbp_verification_holds AS holds
                  WHERE holds.state<>'cleared' AND (
                    holds.verification_hold_id=invocation.verification_hold_id OR
                    (holds.rsid=invocation.rsid AND holds.verification_invocation_id=invocation.invocation_id) OR
                    EXISTS(SELECT 1 FROM json_each(holds.ordered_origin_idempotency_keys_json) AS origin
                           WHERE origin.value=invocation.idempotency_key)
                  )
                )
                AND (invocation.batch_id IS NULL OR NOT EXISTS(
                  SELECT 1 FROM rbp_batches AS batches
                  WHERE batches.rsid=invocation.rsid AND batches.batch_id=invocation.batch_id
                    AND batches.state<>'terminal'
                ))
            );
            """);
        delete.Parameters.AddWithValue("$cutoff", cutoff);
        delete.Parameters.AddWithValue("$now", now);
        _ = delete.ExecuteNonQuery();
    }

    private static (IReadOnlyList<RbpReleasedCarrier> ReleasedCarriers,
                    int Invocations) PruneExpiredCarrierPlans(
        RbpJournalWriteContext context,
        long cutoff)
    {
        // A plan is durable replay evidence until the parent invocation itself
        // is eligible for retention expiry.  The acknowledgement and both
        // age gates are checked in the same immediate transaction that first
        // unlinks then removes the plan, so a crash leaves either both plan
        // and invocation or neither — never a terminal-only replay state.
        using SqliteCommand read = context.CreateCommand("""
            SELECT plan.plan_id,invocation.idempotency_key,plan.carrier_key,
                   plan.terminal_rsid,plan.terminal_sequence,
                   plan.spool_release_token
            FROM rbp_carrier_plans AS plan
            JOIN rbp_invocations AS invocation
              ON invocation.idempotency_key=plan.idempotency_key
            WHERE plan.acknowledged_at_ms IS NOT NULL
              AND plan.acknowledged_at_ms<=$cutoff
              AND plan.spool_release_state='completed'
              AND plan.spool_released_at_ms<=$cutoff
              AND plan.created_at_ms<=$cutoff
              AND invocation.state IN (
                'completed','failed','guarded','cancelled','indeterminate'
              )
              AND invocation.finished_at_ms<=$cutoff
              AND NOT EXISTS(
                SELECT 1 FROM rbp_verification_holds AS holds
                WHERE holds.state<>'cleared'
                  AND (
                    holds.verification_hold_id=invocation.verification_hold_id
                    OR (holds.rsid=invocation.rsid AND
                        holds.verification_invocation_id=invocation.invocation_id)
                    OR EXISTS(
                      SELECT 1 FROM json_each(
                        holds.ordered_origin_idempotency_keys_json
                      ) AS origin WHERE origin.value=invocation.idempotency_key
                    )
                  )
              )
              AND (
                invocation.batch_id IS NULL OR NOT EXISTS(
                  SELECT 1 FROM rbp_batches AS batches
                  WHERE batches.rsid=invocation.rsid
                    AND batches.batch_id=invocation.batch_id
                    AND batches.state<>'terminal'
                )
              )
            ORDER BY plan.plan_id;
            """);
        read.Parameters.AddWithValue("$cutoff", cutoff);
        using SqliteDataReader reader = read.ExecuteReader();
        var plans = new List<(string PlanId, string InvocationKey,
                              RbpReleasedCarrier Released)>();
        while (reader.Read())
        {
            if (reader.IsDBNull(3) || reader.IsDBNull(4) || reader.IsDBNull(5))
            {
                throw RbpJournalSerialization.Corrupt(
                    "An expiring carrier plan lacks its immutable fence.");
            }
            plans.Add((reader.GetString(0), reader.GetString(1),
                new RbpReleasedCarrier(
                    reader.GetString(2), reader.GetString(3),
                    reader.GetInt64(4), reader.GetString(5))));
        }
        reader.Close();

        foreach ((string planId, string invocationKey,
                  RbpReleasedCarrier _) in plans)
        {
            using SqliteCommand unlink = context.CreateCommand("""
                UPDATE rbp_invocations SET carrier_plan_id=NULL
                WHERE idempotency_key=$key AND carrier_plan_id=$plan_id;
                """);
            unlink.Parameters.AddWithValue("$plan_id", planId);
            unlink.Parameters.AddWithValue("$key", invocationKey);
            if (unlink.ExecuteNonQuery() != 1)
            {
                throw RbpJournalSerialization.Corrupt(
                    "An expiring carrier plan lost its invocation reference.");
            }
            using SqliteCommand remove = context.CreateCommand("""
                DELETE FROM rbp_carrier_plans
                WHERE plan_id=$plan_id
                  AND acknowledged_at_ms<=$cutoff
                  AND spool_release_state='completed'
                  AND spool_released_at_ms<=$cutoff;
                """);
            remove.Parameters.AddWithValue("$plan_id", planId);
            remove.Parameters.AddWithValue("$cutoff", cutoff);
            if (remove.ExecuteNonQuery() != 1)
            {
                throw RbpJournalSerialization.Corrupt(
                    "An expiring carrier plan changed during its fenced purge.");
            }
            using SqliteCommand invocation = context.CreateCommand("""
                DELETE FROM rbp_invocations
                WHERE idempotency_key=$key
                  AND carrier_plan_id IS NULL
                  AND state IN (
                    'completed','failed','guarded','cancelled','indeterminate'
                  )
                  AND finished_at_ms<=$cutoff;
                """);
            invocation.Parameters.AddWithValue("$key", invocationKey);
            invocation.Parameters.AddWithValue("$cutoff", cutoff);
            if (invocation.ExecuteNonQuery() != 1)
            {
                throw RbpJournalSerialization.Corrupt(
                    "An expiring carrier invocation changed during fenced purge.");
            }
        }
        return (plans.Select(value => value.Released).ToArray(), plans.Count);
    }

    private static int PruneTerminalInvocations(
        RbpJournalWriteContext context,
        long cutoff)
    {
        // All absolute guards live in the statement itself: a non-terminal
        // row never matches the state list, no row referenced by an
        // uncleared hold — as its installed hold, as its journaled
        // verification read, or as one of its origin idempotency keys — is
        // ever deleted, and no step row of a batch whose coordination row
        // is not terminal is ever deleted, because Section 12.2 replays
        // terminal prefix steps of an in-progress batch from their
        // journals, regardless of age.
        using SqliteCommand delete = context.CreateCommand(
            """
            DELETE FROM rbp_invocations
            WHERE state IN (
                'completed','failed','guarded','cancelled','indeterminate'
              )
              AND finished_at_ms<=$cutoff
              AND carrier_plan_id IS NULL
              AND NOT EXISTS(
                SELECT 1
                FROM rbp_verification_holds AS holds
                WHERE holds.state<>'cleared'
                  AND (
                    holds.verification_hold_id=
                      rbp_invocations.verification_hold_id
                    OR (holds.rsid=rbp_invocations.rsid AND
                        holds.verification_invocation_id=
                          rbp_invocations.invocation_id)
                    OR EXISTS(
                      SELECT 1
                      FROM json_each(
                        holds.ordered_origin_idempotency_keys_json
                      ) AS origin
                      WHERE origin.value=rbp_invocations.idempotency_key
                    )
                  )
              )
              AND (
                rbp_invocations.batch_id IS NULL
                OR NOT EXISTS(
                  SELECT 1
                  FROM rbp_batches AS batches
                  WHERE batches.rsid=rbp_invocations.rsid
                    AND batches.batch_id=rbp_invocations.batch_id
                    AND batches.state<>'terminal'
                )
              );
            """);
        delete.Parameters.AddWithValue("$cutoff", cutoff);
        return delete.ExecuteNonQuery();
    }

    private static int PruneTerminalBatches(
        RbpJournalWriteContext context,
        long cutoff)
    {
        // A batch coordination row is prunable only once it is terminal,
        // older than the retention period, and no step journal row still
        // references it; a non-terminal batch is never pruned and keeps
        // every one of its step rows retained above.
        using SqliteCommand delete = context.CreateCommand(
            """
            DELETE FROM rbp_batches
            WHERE state='terminal'
              AND finished_at_ms<=$cutoff
              AND NOT EXISTS(
                SELECT 1
                FROM rbp_invocations AS steps
                WHERE steps.rsid=rbp_batches.rsid
                  AND steps.batch_id=rbp_batches.batch_id
              );
            """);
        delete.Parameters.AddWithValue("$cutoff", cutoff);
        return delete.ExecuteNonQuery();
    }

    private static int PruneClearedHolds(
        RbpJournalWriteContext context,
        long cutoff)
    {
        // Only cleared holds are ever prunable, and only once their
        // clearing is older than the retention period and no retained
        // invocation row still references them.
        using SqliteCommand delete = context.CreateCommand(
            """
            DELETE FROM rbp_verification_holds
            WHERE state='cleared'
              AND cleared_at_ms<=$cutoff
              AND updated_at_ms<=$cutoff
              AND NOT EXISTS(
                SELECT 1
                FROM rbp_invocations
                WHERE rbp_invocations.verification_hold_id=
                      rbp_verification_holds.verification_hold_id
              );
            """);
        delete.Parameters.AddWithValue("$cutoff", cutoff);
        return delete.ExecuteNonQuery();
    }

    private static int PruneTransportRows(
        RbpJournalWriteContext context,
        string table,
        long cutoff)
    {
        using SqliteCommand delete = context.CreateCommand(
            $"""
             DELETE FROM {table}
             WHERE rsid IN ({PrunableTransportSessions});
             """);
        delete.Parameters.AddWithValue("$cutoff", cutoff);
        return delete.ExecuteNonQuery();
    }
}
