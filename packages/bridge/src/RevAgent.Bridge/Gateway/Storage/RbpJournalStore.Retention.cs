using Microsoft.Data.Sqlite;

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
    int PrunedTerminalBatches = 0);

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
                int invocations =
                    PruneTerminalInvocationsV3(context, cutoff) +
                    PruneTerminalInvocations(context, cutoff);
                int batches =
                    PruneTerminalBatchesV3(context, cutoff) +
                    PruneTerminalBatches(context, cutoff);
                int holds =
                    PruneClearedHoldsV3(context, cutoff) +
                    PruneClearedHolds(context, cutoff);
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
                return new RbpJournalRetentionResult(
                    invocations,
                    holds,
                    receipts,
                    outbox,
                    sessions,
                    batches);
            },
            cancellationToken);
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
              AND NOT EXISTS(
                SELECT 1 FROM rbp_hold_cutover_v3 AS cutover
                WHERE cutover.rsid=rbp_invocations.rsid
              )
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

    private static int PruneTerminalInvocationsV3(
        RbpJournalWriteContext context,
        long cutoff)
    {
        using (SqliteCommand stage = context.CreateCommand(
                   """
                   CREATE TEMP TABLE IF NOT EXISTS wp03_prunable_invocations(
                     idempotency_key TEXT PRIMARY KEY
                   ) WITHOUT ROWID;
                   DELETE FROM wp03_prunable_invocations;
                   INSERT INTO wp03_prunable_invocations(idempotency_key)
                   SELECT outcome.idempotency_key
                   FROM rbp_outcome_dispatch_v3 AS outcome
                   JOIN rbp_invocations AS identity
                     ON identity.idempotency_key=outcome.idempotency_key
                   WHERE outcome.terminal_state IN (
                       'completed','failed','guarded','cancelled','indeterminate'
                     )
                     AND outcome.finished_at_ms<=$cutoff
                     AND NOT EXISTS(
                       SELECT 1 FROM rbp_mutation_holds_v3 AS hold
                       WHERE hold.state<>'cleared'
                         AND (
                           hold.hold_id=outcome.verification_hold_id OR
                           hold.verification_invocation_id=
                             identity.invocation_id OR
                           hold.ordered_origin_keys_json LIKE
                             '%"' || identity.idempotency_key || '"%'
                         )
                     )
                     AND (
                       identity.batch_id IS NULL OR
                       EXISTS(
                         SELECT 1 FROM rbp_batches_v3 AS batch
                         WHERE batch.rsid=identity.rsid
                           AND substr(batch.batch_key,
                               length(batch.rsid)+2)=identity.batch_id
                           AND batch.state='terminal'
                       )
                     );
                   """))
        {
            stage.Parameters.AddWithValue("$cutoff", cutoff);
            _ = stage.ExecuteNonQuery();
        }

        using (SqliteCommand deleteOutcomes = context.CreateCommand(
                   """
                   DELETE FROM rbp_outcome_dispatch_v3
                   WHERE idempotency_key IN (
                     SELECT idempotency_key FROM wp03_prunable_invocations
                   );
                   """))
        {
            _ = deleteOutcomes.ExecuteNonQuery();
        }

        using SqliteCommand deleteIdentity = context.CreateCommand(
            """
            DELETE FROM rbp_invocations
            WHERE idempotency_key IN (
              SELECT idempotency_key FROM wp03_prunable_invocations
            );
            """);
        return deleteIdentity.ExecuteNonQuery();
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
              AND NOT EXISTS(
                SELECT 1 FROM rbp_hold_cutover_v3 AS cutover
                WHERE cutover.rsid=rbp_batches.rsid
              )
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

    private static int PruneTerminalBatchesV3(
        RbpJournalWriteContext context,
        long cutoff)
    {
        using (SqliteCommand deleteV3 = context.CreateCommand(
                   """
                   DELETE FROM rbp_batches_v3
                   WHERE state='terminal' AND finished_at_ms<=$cutoff
                     AND NOT EXISTS(
                       SELECT 1 FROM rbp_invocations AS steps
                       WHERE steps.rsid=rbp_batches_v3.rsid
                         AND steps.batch_id=substr(
                           rbp_batches_v3.batch_key,
                           length(rbp_batches_v3.rsid)+2)
                     );
                   """))
        {
            deleteV3.Parameters.AddWithValue("$cutoff", cutoff);
            _ = deleteV3.ExecuteNonQuery();
        }

        using SqliteCommand deleteLegacy = context.CreateCommand(
            """
            DELETE FROM rbp_batches
            WHERE NOT EXISTS(
              SELECT 1 FROM rbp_batches_v3 AS v3
              WHERE v3.batch_key=rbp_batches.batch_key
            )
              AND state='terminal' AND finished_at_ms<=$cutoff
              AND NOT EXISTS(
                SELECT 1 FROM rbp_invocations AS steps
                WHERE steps.rsid=rbp_batches.rsid
                  AND steps.batch_id=rbp_batches.batch_id
              )
              AND EXISTS(
                SELECT 1 FROM rbp_hold_cutover_v3 AS cutover
                WHERE cutover.rsid=rbp_batches.rsid
              );
            """);
        deleteLegacy.Parameters.AddWithValue("$cutoff", cutoff);
        return deleteLegacy.ExecuteNonQuery();
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
              AND NOT EXISTS(
                SELECT 1 FROM rbp_hold_cutover_v3 AS cutover
                WHERE cutover.rsid=rbp_verification_holds.rsid
              )
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

    private static int PruneClearedHoldsV3(
        RbpJournalWriteContext context,
        long cutoff)
    {
        using (SqliteCommand deleteResolutions = context.CreateCommand(
                   """
                   DELETE FROM rbp_mutation_resolutions_v3 AS resolution
                   WHERE EXISTS (
                     SELECT 1 FROM rbp_mutation_holds_v3 AS hold
                     WHERE hold.rsid=resolution.rsid
                       AND hold.hold_id=resolution.hold_id
                       AND hold.state='cleared'
                       AND hold.cleared_at_ms<=$cutoff
                       AND hold.updated_at_ms<=$cutoff
                       AND NOT EXISTS(
                          SELECT 1 FROM rbp_outcome_dispatch_v3 AS outcome
                          WHERE outcome.rsid=hold.rsid
                            AND outcome.verification_hold_id=hold.hold_id
                        )
                   );
                   """))
        {
            deleteResolutions.Parameters.AddWithValue("$cutoff", cutoff);
            _ = deleteResolutions.ExecuteNonQuery();
        }

        using (SqliteCommand deleteConflicts = context.CreateCommand(
                   """
                   DELETE FROM rbp_mutation_conflicts_v3 AS conflict
                   WHERE conflict.active=0 AND EXISTS (
                     SELECT 1 FROM rbp_mutation_holds_v3 AS hold
                     WHERE hold.rsid=conflict.rsid
                       AND hold.hold_id=conflict.hold_id
                       AND hold.state='cleared'
                       AND hold.cleared_at_ms<=$cutoff
                       AND hold.updated_at_ms<=$cutoff
                       AND NOT EXISTS(
                          SELECT 1 FROM rbp_outcome_dispatch_v3 AS outcome
                          WHERE outcome.rsid=hold.rsid
                            AND outcome.verification_hold_id=hold.hold_id
                        )
                   );
                   """))
        {
            deleteConflicts.Parameters.AddWithValue("$cutoff", cutoff);
            _ = deleteConflicts.ExecuteNonQuery();
        }

        using (SqliteCommand deleteHolds = context.CreateCommand(
                   """
                   DELETE FROM rbp_mutation_holds_v3
                   WHERE state='cleared' AND cleared_at_ms<=$cutoff
                     AND updated_at_ms<=$cutoff
                     AND NOT EXISTS(
                        SELECT 1 FROM rbp_outcome_dispatch_v3 AS outcome
                        WHERE outcome.rsid=rbp_mutation_holds_v3.rsid
                          AND outcome.verification_hold_id=
                            rbp_mutation_holds_v3.hold_id
                     );
                   """))
        {
            deleteHolds.Parameters.AddWithValue("$cutoff", cutoff);
            int deleted = deleteHolds.ExecuteNonQuery();

            using SqliteCommand deleteLegacy = context.CreateCommand(
                """
                DELETE FROM rbp_verification_holds
                WHERE state='cleared' AND cleared_at_ms<=$cutoff
                  AND updated_at_ms<=$cutoff
                  AND EXISTS(
                    SELECT 1 FROM rbp_hold_cutover_v3 AS cutover
                    WHERE cutover.rsid=rbp_verification_holds.rsid
                  )
                  AND NOT EXISTS(
                    SELECT 1 FROM rbp_mutation_holds_v3 AS v3
                    WHERE v3.rsid=rbp_verification_holds.rsid
                      AND v3.hold_id=
                      rbp_verification_holds.verification_hold_id
                  )
                  AND NOT EXISTS(
                    SELECT 1 FROM rbp_invocations
                    WHERE rbp_invocations.verification_hold_id=
                      rbp_verification_holds.verification_hold_id
                  );
                """);
            deleteLegacy.Parameters.AddWithValue("$cutoff", cutoff);
            _ = deleteLegacy.ExecuteNonQuery();
            return deleted;
        }
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
