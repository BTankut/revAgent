using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;

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
                RbpRetentionCandidateWindow candidates =
                    ReadRetentionCandidateRsids(context, now);
                RbpRetentionSafetyPlan whitelist =
                    BuildRetentionWhitelist(context, candidates.Rsids);
                PruneFinalRecoveryCarrierAudit(context, cutoff, whitelist);
                PruneRecoveryPayloadsWithParents(context, cutoff, now,
                    whitelist);
                (IReadOnlyList<RbpReleasedCarrier> releasedCarriers,
                 int carrierInvocations) =
                    PruneExpiredCarrierPlans(context, cutoff, whitelist);
                int invocations = carrierInvocations +
                    PruneTerminalInvocations(context, cutoff, whitelist);
                int batches = PruneTerminalBatches(context, cutoff, whitelist);
                int holds = PruneClearedHolds(context, cutoff, whitelist);
                int receipts = PruneTransportRows(
                    context,
                    "rbp_inbound_receipts",
                    cutoff,
                    whitelist);
                int outbox = PruneTransportRows(
                    context,
                    "rbp_outbox",
                    cutoff,
                    whitelist);
                int sessions = PruneTransportRows(
                    context,
                    "rbp_session_sequence",
                    cutoff,
                    whitelist);
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

    private void PruneFinalRecoveryCarrierAudit(
        RbpJournalWriteContext context,
        long cutoff,
        RbpRetentionSafetyPlan whitelist)
    {
        // Only final, nonsecret audit metadata expires with its parent policy;
        // active/send/tombstoned fences remain authoritative and never reopen
        // sequence space through retention.
        using SqliteCommand delete = context.CreateCommand("""
            DELETE FROM rbp_recovery_carrier_reservations
            WHERE recovery_invocation_id IN (SELECT value FROM json_each($eligible))
              AND ((phase='completed' AND completed_at_ms<=$cutoff)
               OR (phase='tombstoned' AND tombstoned_at_ms<=$cutoff))
              AND (raw_idempotency_key IS NULL OR EXISTS(
                SELECT 1 FROM rbp_invocations AS parent
                WHERE parent.idempotency_key=raw_idempotency_key
                  AND parent.state IN ('completed','failed','guarded','cancelled','indeterminate')
                  AND parent.finished_at_ms<=$cutoff
                  AND parent.carrier_plan_id IS NULL
              ));
            """);
        delete.Parameters.AddWithValue("$cutoff", cutoff);
        delete.Parameters.AddWithValue("$eligible",
            JsonSerializer.Serialize(whitelist.EligibleRecoveryReservationIds));
        _ = delete.ExecuteNonQuery();
        _faultInjector?.Hit(RbpJournalFaultPoint.RecoveryDetailedAuditPruned);
    }

    private static void PruneRecoveryPayloadsWithParents(
        RbpJournalWriteContext context,
        long cutoff,
        long now,
        RbpRetentionSafetyPlan whitelist)
    {
        // v7 recovery material has the same parent lifetime as the terminal
        // invocation.  Delete the child first, in this retention transaction,
        // only where the parent is itself eligible; this is a coupled prune,
        // never an early byte-cap eviction.
        using SqliteCommand delete = context.CreateCommand("""
            DELETE FROM rbp_recovery_payloads
            WHERE idempotency_key IN (SELECT value FROM json_each($eligible))
              AND NOT EXISTS(
                SELECT 1 FROM rbp_recovery_carrier_reservations AS reservation
                WHERE reservation.raw_idempotency_key=rbp_recovery_payloads.idempotency_key
                  AND reservation.phase IN ('reserved','send_started','awaiting_ack','tombstoned')
            )
              AND retention_expires_at_ms<=$now
              AND idempotency_key IN (
              SELECT invocation.idempotency_key
              FROM rbp_invocations AS invocation
              WHERE invocation.state IN ('completed','failed','guarded','cancelled','indeterminate')
                AND invocation.finished_at_ms<=$cutoff
                AND invocation.carrier_plan_id IS NULL
                AND NOT EXISTS(
                  SELECT 1 FROM rbp_verification_holds AS holds
                  WHERE (
                    holds.verification_hold_id=invocation.verification_hold_id OR
                    (holds.rsid=invocation.rsid AND holds.verification_invocation_id=invocation.invocation_id) OR
                    EXISTS(SELECT 1 FROM json_each(holds.ordered_origin_idempotency_keys_json) AS origin
                           WHERE origin.value=invocation.idempotency_key)
                  )
                  AND (holds.state<>'cleared' OR holds.cleared_at_ms>$cutoff
                       OR holds.updated_at_ms>$cutoff OR EXISTS(
                    SELECT 1 FROM rbp_invocations AS dependency
                    WHERE dependency.rsid=holds.rsid AND (
                      dependency.verification_hold_id=holds.verification_hold_id OR
                      dependency.invocation_id=holds.verification_invocation_id OR
                      EXISTS(SELECT 1 FROM json_each(holds.ordered_origin_idempotency_keys_json) AS origin
                             WHERE origin.value=dependency.idempotency_key)
                    ) AND (dependency.state NOT IN ('completed','failed','guarded','cancelled','indeterminate')
                           OR dependency.finished_at_ms IS NULL
                           OR dependency.finished_at_ms>$cutoff
                           OR dependency.carrier_plan_id IS NOT NULL)
                  ))
                )
                AND (invocation.batch_id IS NULL OR NOT EXISTS(
                  SELECT 1 FROM rbp_batches AS batches
                  WHERE batches.rsid=invocation.rsid AND batches.batch_id=invocation.batch_id
                    AND (batches.state<>'terminal'
                         OR batches.finished_at_ms IS NULL
                         OR batches.finished_at_ms>$cutoff)
                ))
                AND (invocation.batch_id IS NULL OR NOT EXISTS(
                  SELECT 1 FROM rbp_invocations AS sibling
                  WHERE sibling.rsid=invocation.rsid
                    AND sibling.batch_id=invocation.batch_id
                    AND (sibling.state NOT IN ('completed','failed','guarded','cancelled','indeterminate')
                         OR sibling.finished_at_ms IS NULL
                         OR sibling.finished_at_ms>$cutoff
                         OR sibling.carrier_plan_id IS NOT NULL)
                ))
            );
            """);
        delete.Parameters.AddWithValue("$cutoff", cutoff);
        delete.Parameters.AddWithValue("$now", now);
        delete.Parameters.AddWithValue("$eligible",
            JsonSerializer.Serialize(whitelist.EligibleRecoveryPayloadKeys));
        _ = delete.ExecuteNonQuery();
    }

    private static (IReadOnlyList<RbpReleasedCarrier> ReleasedCarriers,
                    int Invocations) PruneExpiredCarrierPlans(
        RbpJournalWriteContext context,
        long cutoff,
        RbpRetentionSafetyPlan whitelist)
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
              AND plan.plan_id IN (SELECT value FROM json_each($eligible_plans))
              AND invocation.idempotency_key IN (SELECT value FROM json_each($eligible_invocations))
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
                WHERE (
                    holds.verification_hold_id=invocation.verification_hold_id
                    OR (holds.rsid=invocation.rsid AND
                        holds.verification_invocation_id=invocation.invocation_id)
                    OR EXISTS(
                      SELECT 1 FROM json_each(
                        holds.ordered_origin_idempotency_keys_json
                      ) AS origin WHERE origin.value=invocation.idempotency_key
                    )
                  )
                  AND (holds.state<>'cleared' OR holds.cleared_at_ms>$cutoff
                       OR holds.updated_at_ms>$cutoff OR EXISTS(
                    SELECT 1 FROM rbp_invocations AS dependency
                    WHERE dependency.rsid=holds.rsid AND (
                      dependency.verification_hold_id=holds.verification_hold_id OR
                      dependency.invocation_id=holds.verification_invocation_id OR
                      EXISTS(SELECT 1 FROM json_each(holds.ordered_origin_idempotency_keys_json) AS origin
                             WHERE origin.value=dependency.idempotency_key)
                    ) AND dependency.idempotency_key<>invocation.idempotency_key
                      AND (dependency.state NOT IN ('completed','failed','guarded','cancelled','indeterminate')
                           OR dependency.finished_at_ms IS NULL
                           OR dependency.finished_at_ms>$cutoff
                           OR dependency.carrier_plan_id IS NOT NULL)
                  ))
              )
              AND (
                invocation.batch_id IS NULL OR NOT EXISTS(
                  SELECT 1 FROM rbp_batches AS batches
                  WHERE batches.rsid=invocation.rsid
                    AND batches.batch_id=invocation.batch_id
                    AND (batches.state<>'terminal'
                         OR batches.finished_at_ms IS NULL
                         OR batches.finished_at_ms>$cutoff)
                )
              )
              AND (invocation.batch_id IS NULL OR NOT EXISTS(
                SELECT 1 FROM rbp_invocations AS sibling
                WHERE sibling.rsid=invocation.rsid
                  AND sibling.batch_id=invocation.batch_id
                  AND sibling.idempotency_key<>invocation.idempotency_key
                  AND (sibling.state NOT IN ('completed','failed','guarded','cancelled','indeterminate')
                       OR sibling.finished_at_ms IS NULL
                       OR sibling.finished_at_ms>$cutoff
                       OR sibling.carrier_plan_id IS NOT NULL)
              ))
            ORDER BY plan.plan_id;
            """);
        read.Parameters.AddWithValue("$cutoff", cutoff);
        read.Parameters.AddWithValue("$eligible_plans",
            JsonSerializer.Serialize(whitelist.EligibleCarrierPlanIds));
        read.Parameters.AddWithValue("$eligible_invocations",
            JsonSerializer.Serialize(whitelist.EligibleInvocationKeys));
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
        long cutoff,
        RbpRetentionSafetyPlan whitelist)
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
            WHERE idempotency_key IN (SELECT value FROM json_each($eligible))
              AND state IN (
                'completed','failed','guarded','cancelled','indeterminate'
              )
              AND finished_at_ms<=$cutoff
              AND carrier_plan_id IS NULL
              AND NOT EXISTS(
                SELECT 1
                FROM rbp_verification_holds AS holds
                WHERE (
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
                  AND (holds.state<>'cleared' OR holds.cleared_at_ms>$cutoff
                       OR holds.updated_at_ms>$cutoff OR EXISTS(
                    SELECT 1 FROM rbp_invocations AS dependency
                    WHERE dependency.rsid=holds.rsid AND (
                      dependency.verification_hold_id=holds.verification_hold_id OR
                      dependency.invocation_id=holds.verification_invocation_id OR
                      EXISTS(SELECT 1 FROM json_each(holds.ordered_origin_idempotency_keys_json) AS origin
                             WHERE origin.value=dependency.idempotency_key)
                    ) AND (dependency.state NOT IN ('completed','failed','guarded','cancelled','indeterminate')
                           OR dependency.finished_at_ms IS NULL
                           OR dependency.finished_at_ms>$cutoff
                           OR dependency.carrier_plan_id IS NOT NULL)
                  ))
              )
              AND (
                rbp_invocations.batch_id IS NULL
                OR NOT EXISTS(
                  SELECT 1
                  FROM rbp_batches AS batches
                  WHERE batches.rsid=rbp_invocations.rsid
                    AND batches.batch_id=rbp_invocations.batch_id
                    AND (batches.state<>'terminal'
                         OR batches.finished_at_ms IS NULL
                         OR batches.finished_at_ms>$cutoff)
                )
              )
              AND (rbp_invocations.batch_id IS NULL OR NOT EXISTS(
                SELECT 1 FROM rbp_invocations AS sibling
                WHERE sibling.rsid=rbp_invocations.rsid
                  AND sibling.batch_id=rbp_invocations.batch_id
                  AND (sibling.state NOT IN ('completed','failed','guarded','cancelled','indeterminate')
                       OR sibling.finished_at_ms IS NULL
                       OR sibling.finished_at_ms>$cutoff
                       OR sibling.carrier_plan_id IS NOT NULL)
              ));
            """);
        delete.Parameters.AddWithValue("$cutoff", cutoff);
        delete.Parameters.AddWithValue("$eligible",
            JsonSerializer.Serialize(whitelist.EligibleInvocationKeys));
        return delete.ExecuteNonQuery();
    }

    private static int PruneTerminalBatches(
        RbpJournalWriteContext context,
        long cutoff,
        RbpRetentionSafetyPlan whitelist)
    {
        // A batch coordination row is prunable only once it is terminal,
        // older than the retention period, and no step journal row still
        // references it; a non-terminal batch is never pruned and keeps
        // every one of its step rows retained above.
        using SqliteCommand delete = context.CreateCommand(
            """
            DELETE FROM rbp_batches
            WHERE batch_key IN (SELECT value FROM json_each($eligible))
              AND state='terminal'
              AND finished_at_ms<=$cutoff
              AND NOT EXISTS(
                SELECT 1
                FROM rbp_invocations AS steps
                WHERE steps.rsid=rbp_batches.rsid
                  AND steps.batch_id=rbp_batches.batch_id
              );
            """);
        delete.Parameters.AddWithValue("$cutoff", cutoff);
        delete.Parameters.AddWithValue("$eligible",
            JsonSerializer.Serialize(whitelist.EligibleBatchKeys));
        return delete.ExecuteNonQuery();
    }

    private static int PruneClearedHolds(
        RbpJournalWriteContext context,
        long cutoff,
        RbpRetentionSafetyPlan whitelist)
    {
        // Only cleared holds are ever prunable, and only once their
        // clearing is older than the retention period and no retained
        // invocation row still references them.
        using SqliteCommand delete = context.CreateCommand(
            """
            DELETE FROM rbp_verification_holds
            WHERE verification_hold_id IN (SELECT value FROM json_each($eligible))
              AND state='cleared'
              AND cleared_at_ms<=$cutoff
              AND updated_at_ms<=$cutoff
              AND NOT EXISTS(
                SELECT 1
                FROM rbp_invocations
                WHERE rbp_invocations.rsid=rbp_verification_holds.rsid
                  AND (
                    rbp_invocations.verification_hold_id=
                      rbp_verification_holds.verification_hold_id
                    OR rbp_invocations.invocation_id=
                      rbp_verification_holds.verification_invocation_id
                    OR EXISTS(
                      SELECT 1 FROM json_each(
                        rbp_verification_holds.ordered_origin_idempotency_keys_json
                      ) AS origin
                      WHERE origin.value=rbp_invocations.idempotency_key
                    )
                  )
              );
            """);
        delete.Parameters.AddWithValue("$cutoff", cutoff);
        delete.Parameters.AddWithValue("$eligible",
            JsonSerializer.Serialize(whitelist.EligibleHoldIds));
        return delete.ExecuteNonQuery();
    }

    private static int PruneTransportRows(
        RbpJournalWriteContext context,
        string table,
        long cutoff,
        RbpRetentionSafetyPlan whitelist)
    {
        using SqliteCommand delete = context.CreateCommand(
            $"""
             DELETE FROM {table}
             WHERE rsid IN (SELECT value FROM json_each($eligible))
               AND rsid IN ({PrunableTransportSessions});
             """);
        delete.Parameters.AddWithValue("$cutoff", cutoff);
        delete.Parameters.AddWithValue("$eligible",
            JsonSerializer.Serialize(whitelist.EligibleTransportRsids));
        return delete.ExecuteNonQuery();
    }

    private sealed record RbpRetentionCandidateWindow(
        IReadOnlyList<string> Rsids,
        bool Overflow);

    private static RbpRetentionCandidateWindow ReadRetentionCandidateRsids(
        RbpJournalWriteContext context,
        long now)
    {
        const string candidateCte = """
            WITH candidates AS (
              SELECT rsid FROM rbp_sessions
              UNION SELECT rsid FROM rbp_invocations
              UNION SELECT rsid FROM rbp_batches
              UNION SELECT rsid FROM rbp_verification_holds
              UNION SELECT rsid FROM rbp_inbound_receipts
              UNION SELECT rsid FROM rbp_outbox
              UNION SELECT rsid FROM rbp_recovery_payloads
              UNION SELECT rsid FROM rbp_recovery_carrier_reservations
            )
            """;
        using SqliteCommand countCommand = context.CreateCommand(
            candidateCte + " SELECT COUNT(*) FROM candidates;");
        long count = Convert.ToInt64(countCommand.ExecuteScalar() ?? 0);
        if (count == 0)
            return new RbpRetentionCandidateWindow(Array.Empty<string>(), false);
        long offset = Math.Abs(now / 60_000) % count;
        var values = new List<string>(129);
        void ReadWindow(long windowOffset, int limit)
        {
            if (limit <= 0) return;
            using SqliteCommand command = context.CreateCommand(candidateCte +
                " SELECT rsid FROM candidates ORDER BY rsid LIMIT $limit OFFSET $offset;");
            command.Parameters.AddWithValue("$limit", limit);
            command.Parameters.AddWithValue("$offset", windowOffset);
            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read())
            {
                if (reader.IsDBNull(0))
                    throw RbpJournalSerialization.Corrupt(
                        "A retention candidate cannot be bound to an RSID.");
                values.Add(reader.GetString(0));
            }
        }
        ReadWindow(offset, 129);
        if (values.Count < 129 && values.Count < count)
            ReadWindow(0, (int)Math.Min(129 - values.Count, offset));
        bool overflow = count > 128;
        if (values.Count > 128) values.RemoveRange(128, values.Count - 128);
        return new RbpRetentionCandidateWindow(values.AsReadOnly(), overflow);
    }

    private static RbpRetentionSafetyPlan BuildRetentionWhitelist(
        RbpJournalWriteContext context,
        IReadOnlyList<string> candidates)
    {
        var invocations = new HashSet<string>(StringComparer.Ordinal);
        var batches = new HashSet<string>(StringComparer.Ordinal);
        var holds = new HashSet<string>(StringComparer.Ordinal);
        var carrierPlans = new HashSet<string>(StringComparer.Ordinal);
        var recoveryPayloads = new HashSet<string>(StringComparer.Ordinal);
        var reservations = new HashSet<string>(StringComparer.Ordinal);
        var transport = new HashSet<string>(StringComparer.Ordinal);
        long usedInvocations = 0, usedSteps = 0, usedBatches = 0,
            usedBytes = 0;
        foreach (string rsid in candidates)
        {
            try
            {
                RetentionInventoryUsage usage = ReadRetentionInventoryUsage(
                    context, rsid);
                if (usedInvocations + usage.Invocations > 10_000 ||
                    usedSteps + usage.StepReferences > 10_000 ||
                    usedBatches + usage.Batches > 1_024 ||
                    usedBytes + usage.JsonBytes > 32L * 1024 * 1024)
                    continue;
                usedInvocations += usage.Invocations;
                usedSteps += usage.StepReferences;
                usedBatches += usage.Batches;
                usedBytes += usage.JsonBytes;
                ValidateRetentionRecoveryFacts(context, rsid);
                RbpLegacySafetyPlan plan = ClassifyLegacySafety(context,
                    RbpLegacySafetyQuery.ForRetention(new[] { rsid }),
                    RbpProjectedHoldView.Empty,
                    RbpLegacySafetyBudget.Retention with { MaxCandidateRsids = 1 });
                if (plan.Outcome == RbpLegacySafetyOutcome.InventoryLimit)
                    continue;
                invocations.UnionWith(plan.RetentionSafety.EligibleInvocationKeys);
                batches.UnionWith(plan.RetentionSafety.EligibleBatchKeys);
                holds.UnionWith(plan.RetentionSafety.EligibleHoldIds);
                carrierPlans.UnionWith(plan.RetentionSafety.EligibleCarrierPlanIds);
                recoveryPayloads.UnionWith(plan.RetentionSafety.EligibleRecoveryPayloadKeys);
                reservations.UnionWith(plan.RetentionSafety.EligibleRecoveryReservationIds);
                transport.UnionWith(plan.RetentionSafety.EligibleTransportRsids);
            }
            catch (RbpJournalException exception) when (
                exception.ErrorCode == RbpJournalErrorCode.IntegrityCheckFailed)
            {
                // Classification queries are already bound to this exact
                // RSID, so malformed retained material pins only that RSID.
            }
            catch (OverflowException)
            {
                // A bound affected RSID whose measured inventory cannot be
                // represented remains pinned; independent RSIDs continue.
            }
        }
        return new RbpRetentionSafetyPlan(invocations, batches, holds,
            carrierPlans, recoveryPayloads, reservations, transport);
    }

    private static void ValidateRetentionRecoveryFacts(
        RbpJournalWriteContext context,
        string rsid)
    {
        try
        {
            using (SqliteCommand reservations = context.CreateCommand(
                       "SELECT header_jcs FROM rbp_recovery_carrier_reservations WHERE rsid=$rsid ORDER BY recovery_invocation_id;"))
            {
                reservations.Parameters.AddWithValue("$rsid", rsid);
                using SqliteDataReader reader = reservations.ExecuteReader();
                while (reader.Read()) RequireCanonicalJson(reader.GetString(0),
                    "recovery carrier header");
            }
            using SqliteCommand plans = context.CreateCommand(
                "SELECT terminal_jcs,terminal_digest FROM rbp_recovery_terminal_plans WHERE rsid=$rsid ORDER BY recovery_invocation_id;");
            plans.Parameters.AddWithValue("$rsid", rsid);
            using SqliteDataReader planReader = plans.ExecuteReader();
            while (planReader.Read())
            {
                string terminal = planReader.GetString(0);
                string digest = planReader.GetString(1);
                RequireCanonicalJson(terminal, "recovery terminal");
                using JsonDocument document = JsonDocument.Parse(terminal);
                if (Rfc8785Json.Sha256Digest(document.RootElement) != digest)
                    throw RbpJournalSerialization.Corrupt(
                        "A recovery terminal digest does not bind its canonical bytes.");
            }
        }
        catch (RbpJournalException)
        {
            throw;
        }
        catch (Exception exception) when (exception is JsonException or
            InvalidOperationException or ArgumentException)
        {
            throw RbpJournalSerialization.Corrupt(
                "The retained recovery terminal inventory is malformed.",
                exception);
        }
    }

    private sealed record RetentionInventoryUsage(
        long Invocations,
        long StepReferences,
        long Batches,
        long JsonBytes);

    private static RetentionInventoryUsage ReadRetentionInventoryUsage(
        RbpJournalWriteContext context,
        string rsid)
    {
        long Scalar(string sql)
        {
            using SqliteCommand command = context.CreateCommand(sql);
            command.Parameters.AddWithValue("$rsid", rsid);
            return Convert.ToInt64(command.ExecuteScalar() ?? 0);
        }
        long invocationCount = Scalar(
            "SELECT COUNT(*) FROM rbp_invocations WHERE rsid=$rsid;");
        long batchCount = Scalar(
            "SELECT COUNT(*) FROM rbp_batches WHERE rsid=$rsid;");
        long stepCount = Scalar(
            "SELECT COALESCE(SUM(step_count),0) FROM rbp_batches WHERE rsid=$rsid;");
        long bytes = Scalar(
            """
            SELECT COALESCE(SUM(length(CAST(COALESCE(terminal_outcome_json,'') AS BLOB))+
              length(CAST(COALESCE(late_terminal_outcome_json,'') AS BLOB))+
              length(CAST(policy_jcs AS BLOB))+length(CAST(recovery_clearances_jcs AS BLOB))+
              length(CAST(COALESCE(mutation_scope_jcs,'') AS BLOB))+
              length(CAST(COALESCE(verification_correlation_json,'') AS BLOB))),0)
            FROM rbp_invocations WHERE rsid=$rsid;
            """) + Scalar(
            """
            SELECT COALESCE(SUM(length(CAST(steps_jcs AS BLOB))+
              length(CAST(recovery_clearances_jcs AS BLOB))+
              length(CAST(COALESCE(terminal_outcome_json,'') AS BLOB))),0)
            FROM rbp_batches WHERE rsid=$rsid;
            """) + Scalar(
            """
            SELECT COALESCE(SUM(length(CAST(scope_jcs AS BLOB))+
              length(CAST(ordered_origin_idempotency_keys_json AS BLOB))+
              length(CAST(COALESCE(evidence_digest,'') AS BLOB))+
              length(CAST(COALESCE(resolution_id,'') AS BLOB))+
              length(CAST(COALESCE(resolution_basis,'') AS BLOB))+
              length(CAST(COALESCE(resolution_decision,'') AS BLOB))+
              length(CAST(COALESCE(audit_id,'') AS BLOB))),0)
            FROM rbp_verification_holds WHERE rsid=$rsid;
            """) + Scalar(
            """
            SELECT COALESCE(SUM(length(CAST(header_jcs AS BLOB))),0)
            FROM rbp_recovery_carrier_reservations WHERE rsid=$rsid;
            """) + Scalar(
            """
            SELECT COALESCE(SUM(length(CAST(terminal_jcs AS BLOB))),0)
            FROM rbp_recovery_terminal_plans WHERE rsid=$rsid;
            """) + Scalar(
            """
            SELECT COALESCE(SUM(length(CAST(local_session_key AS BLOB))+
              length(CAST(registration_json AS BLOB))+
              length(CAST(registration_digest AS BLOB))+
              length(CAST(granted_capabilities_json AS BLOB))),0)
            FROM rbp_sessions WHERE rsid=$rsid;
            """);
        return new RetentionInventoryUsage(invocationCount, stepCount,
            batchCount, bytes);
    }
}
