using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Storage;

internal sealed record RbpOutcomeV3Snapshot(
    string IdempotencyKey,
    string Rsid,
    string DispatchState,
    string EffectState,
    string TransactionMode,
    string EvidenceJcs,
    string TerminalState,
    long RecordVersion);

internal sealed record RbpOutcomeV3Cutover(
    string Rsid,
    string LegacyDigest,
    long ImportedDispatchCount,
    long ImportedHoldCount,
    long ImportedConflictCount,
    long ImportedResolutionCount,
    string TargetGeneration,
    string State);

internal sealed record RbpOutcomeV3ResolutionSnapshot(
    string ResolutionId,
    string HoldId,
    string Basis,
    string? VerificationInvocationId,
    string EvidenceDigest,
    string Decision,
    string AuditId,
    string State,
    long RecordVersion);

/// <summary>
/// DC-02's Bridge-local journal-v3 overlay. It deliberately lives in the
/// Dispatch-owned slice while extending the existing store as a partial, so
/// outcome facts, legacy import, holds, conflicts, resolutions, and the
/// per-session cutover marker participate in the same SQLite transaction as
/// the v2 invocation authority.
/// </summary>
internal sealed partial class RbpJournalStore
{
    private const string OutcomeV3Generation = "bridge-outcome-v3";

    private const string OutcomeV3Schema = """
        CREATE TABLE IF NOT EXISTS rbp_outcome_schema_v3(
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          schema_version INTEGER NOT NULL CHECK(schema_version=3),
          generation TEXT NOT NULL CHECK(generation='bridge-outcome-v3'),
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS rbp_outcome_dispatch_v3(
          idempotency_key TEXT PRIMARY KEY
            REFERENCES rbp_invocations(idempotency_key) ON DELETE RESTRICT,
          record_schema TEXT NOT NULL
            CHECK(record_schema='bridge.rbp-dispatch/v3'),
          rsid TEXT NOT NULL REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          dispatch_state TEXT NOT NULL CHECK(dispatch_state IN (
            'not_started','may_have_reached_addin','response_observed'
          )),
          effect_state TEXT NOT NULL CHECK(effect_state IN (
            'not_started','read_only','rolled_back','committed','unknown'
          )),
          transaction_mode TEXT NOT NULL CHECK(transaction_mode IN (
            'auto','none','native','not_applicable'
          )),
          evidence_jcs TEXT NOT NULL
            CHECK(length(evidence_jcs) BETWEEN 2 AND 2048),
          terminal_state TEXT NOT NULL CHECK(terminal_state IN (
            'received','executing','completed','failed','guarded','cancelled',
            'indeterminate'
          )),
          record_version INTEGER NOT NULL CHECK(record_version>=1),
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
          updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS ix_rbp_outcome_dispatch_v3_session
          ON rbp_outcome_dispatch_v3(rsid,terminal_state,updated_at_ms);

        CREATE TABLE IF NOT EXISTS rbp_mutation_holds_v3(
          hold_id TEXT PRIMARY KEY,
          record_schema TEXT NOT NULL
            CHECK(record_schema='bridge.mutation-hold/v1'),
          rsid TEXT NOT NULL REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          mutation_scope_jcs TEXT NOT NULL CHECK(length(mutation_scope_jcs)>0),
          ordered_origin_keys_json TEXT NOT NULL
            CHECK(length(ordered_origin_keys_json)>0),
          state TEXT NOT NULL CHECK(state IN (
            'active','evidence_recorded','resolved_pending_bridge','cleared'
          )),
          evidence_digest TEXT,
          resolution_id TEXT,
          record_version INTEGER NOT NULL CHECK(record_version>=1),
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
          updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),
          CHECK(length(hold_id)=67 AND substr(hold_id,1,3)='vh:' AND
                substr(hold_id,4) NOT GLOB '*[^0-9a-f]*')
        ) STRICT;

        CREATE TABLE IF NOT EXISTS rbp_mutation_conflicts_v3(
          conflict_key TEXT PRIMARY KEY,
          record_schema TEXT NOT NULL
            CHECK(record_schema='bridge.mutation-conflict/v1'),
          rsid TEXT NOT NULL REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          scope_digest TEXT NOT NULL,
          hold_id TEXT NOT NULL
            REFERENCES rbp_mutation_holds_v3(hold_id) ON DELETE RESTRICT,
          mutation_scope_jcs TEXT NOT NULL CHECK(length(mutation_scope_jcs)>0),
          active INTEGER NOT NULL CHECK(active IN (0,1)),
          record_version INTEGER NOT NULL CHECK(record_version>=1),
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
          updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),
          UNIQUE(rsid,scope_digest),
          CHECK(length(scope_digest)=71 AND
                substr(scope_digest,1,7)='sha256:' AND
                substr(scope_digest,8) NOT GLOB '*[^0-9a-f]*')
        ) STRICT;

        CREATE INDEX IF NOT EXISTS ix_rbp_mutation_conflicts_v3_active
          ON rbp_mutation_conflicts_v3(rsid,active,scope_digest);

        CREATE TABLE IF NOT EXISTS rbp_mutation_resolutions_v3(
          resolution_id TEXT PRIMARY KEY,
          record_schema TEXT NOT NULL
            CHECK(record_schema='bridge.mutation-resolution/v1'),
          hold_id TEXT NOT NULL
            REFERENCES rbp_mutation_holds_v3(hold_id) ON DELETE RESTRICT,
          basis TEXT NOT NULL CHECK(basis IN (
            'verification_read','late_terminal'
          )),
          verification_invocation_id TEXT,
          evidence_digest TEXT NOT NULL,
          decision TEXT NOT NULL CHECK(decision IN (
            'non_execution_proven','postcondition_verified'
          )),
          audit_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending_bridge','accepted')),
          record_version INTEGER NOT NULL CHECK(record_version>=1),
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
          updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),
          CHECK(
            (basis='verification_read' AND
             verification_invocation_id IS NOT NULL) OR
            (basis='late_terminal' AND
             verification_invocation_id IS NULL)
          ),
          CHECK(length(evidence_digest)=71 AND
                substr(evidence_digest,1,7)='sha256:' AND
                substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*')
        ) STRICT;

        CREATE TABLE IF NOT EXISTS rbp_hold_cutover_v3(
          rsid TEXT PRIMARY KEY REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          record_schema TEXT NOT NULL
            CHECK(record_schema='bridge.hold-cutover/v1'),
          legacy_digest TEXT NOT NULL,
          imported_dispatch_count INTEGER NOT NULL
            CHECK(imported_dispatch_count>=0),
          imported_hold_count INTEGER NOT NULL CHECK(imported_hold_count>=0),
          imported_conflict_count INTEGER NOT NULL
            CHECK(imported_conflict_count>=0),
          imported_resolution_count INTEGER NOT NULL
            CHECK(imported_resolution_count>=0),
          target_generation TEXT NOT NULL
            CHECK(target_generation='bridge-outcome-v3'),
          state TEXT NOT NULL CHECK(state='normalized_authoritative'),
          record_version INTEGER NOT NULL CHECK(record_version=1),
          cutover_at_ms INTEGER NOT NULL CHECK(cutover_at_ms>=0)
        ) STRICT;
        """;

    internal Task<RbpOutcomeV3Cutover> EnsureOutcomeV3ForSessionAsync(
        string rsid,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), 256);
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                RequireActiveSession(context, rsid);
                EnsureOutcomeV3Schema(context, now);
                return EnsureOutcomeV3Cutover(context, rsid, now);
            },
            cancellationToken);
    }

    internal Task<RbpClearanceGatedAdmission>
        AdmitInvocationOutcomeV3Async(
            RbpInvocationIdentity identity,
            IReadOnlyList<RbpRecoveryClearance> clearances,
            RbpTransactionMode transactionMode,
            CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(clearances);
        ValidateInvocationIdentity(identity);
        ValidateClearanceShapes(identity, clearances);
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                RequireActiveSession(context, identity.Rsid);
                EnsureOutcomeV3Schema(context, now);
                _ = EnsureOutcomeV3Cutover(context, identity.Rsid, now);

                foreach (RbpRecoveryClearance clearance in clearances)
                {
                    AcceptClearance(
                        context,
                        identity.Rsid,
                        new[] { identity.MutationScopeJcs! },
                        clearance,
                        now);
                }

                RbpInvocationAdmissionResult admitted =
                    AdmitInvocation(context, identity, now);
                if (admitted.BlockingHold is { } blocking)
                {
                    if (clearances.Count > 0)
                    {
                        throw ClearanceFault(
                            "the clearance envelope does not cover every " +
                            "hold conflicting with its mutation scope");
                    }

                    return new RbpClearanceGatedAdmission(null, blocking);
                }

                foreach (RbpRecoveryClearance clearance in clearances)
                {
                    MirrorHoldV3(context, identity.Rsid, clearance.HoldId, now);
                }

                if (admitted.Admission == RbpInvocationAdmission.Accepted)
                {
                    UpsertOutcomeV3(
                        context,
                        admitted.Stored,
                        RbpMutationOutcomeEvidence.NotDispatched(
                            transactionMode),
                        ToStorageState(admitted.Stored.State),
                        now);
                }
                else if (admitted.Admission ==
                         RbpInvocationAdmission.RefuseIndeterminate &&
                         admitted.VerificationHoldId is { } refusedHoldId)
                {
                    UpsertOutcomeV3(
                        context,
                        admitted.Stored,
                        RbpMutationOutcomeEvidence.Uncertain(
                            RbpDispatchState.MayHaveReachedAddin,
                            transactionMode,
                            "redelivery_promotion"),
                        "indeterminate",
                        now);
                    MirrorHoldV3(
                        context,
                        identity.Rsid,
                        refusedHoldId,
                        now);
                }

                return new RbpClearanceGatedAdmission(admitted, null);
            },
            cancellationToken);
    }

    internal Task MarkInvocationExecutingOutcomeV3Async(
        string idempotencyKey,
        RbpTransactionMode transactionMode,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(idempotencyKey, nameof(idempotencyKey), 293);
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                RbpStoredInvocation existing =
                    ReadInvocation(context, idempotencyKey) ??
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "An unknown invocation cannot take dispatch ownership.");
                RequireActiveSession(context, existing.Identity.Rsid);
                EnsureOutcomeV3Schema(context, now);
                _ = EnsureOutcomeV3Cutover(
                    context,
                    existing.Identity.Rsid,
                    now);

                using SqliteCommand update = context.CreateCommand(
                    """
                    UPDATE rbp_invocations
                    SET state='executing',
                        started_at_ms=COALESCE(started_at_ms,$now)
                    WHERE idempotency_key=$key AND state='received';
                    """);
                update.Parameters.AddWithValue("$key", idempotencyKey);
                update.Parameters.AddWithValue("$now", now);
                if (update.ExecuteNonQuery() != 1)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "Only a durably received invocation may take " +
                        "dispatch ownership.");
                }

                RbpStoredInvocation executing =
                    ReadInvocation(context, idempotencyKey) ??
                    throw new RbpJournalException(
                        RbpJournalErrorCode.IntegrityCheckFailed,
                        "The executing invocation disappeared.");
                UpsertOutcomeV3(
                    context,
                    executing,
                    RbpMutationOutcomeEvidence.Uncertain(
                        RbpDispatchState.MayHaveReachedAddin,
                        transactionMode,
                        "dispatch_ownership"),
                    "executing",
                    now);
                return true;
            },
            cancellationToken);
    }

    internal Task<RbpBatchGatedAdmission> AdmitBatchOutcomeV3Async(
        RbpBatchIdentity identity,
        IReadOnlyList<RbpRecoveryClearance> clearances,
        IReadOnlyList<RbpTransactionMode> transactionModes,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(clearances);
        ArgumentNullException.ThrowIfNull(transactionModes);
        ValidateBatchIdentity(identity);
        RbpBatchIdentity normalized = NormalizeBatchIdentity(identity);
        ValidateBatchClearances(normalized, clearances);
        VerifyBatchDigestBinding(normalized);
        if (transactionModes.Count != normalized.Steps.Count)
        {
            throw new ArgumentException(
                "Every batch step requires one transaction mode.",
                nameof(transactionModes));
        }

        string stepsJcs = BuildStepsJcs(normalized);
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                RequireActiveSession(context, normalized.Rsid);
                EnsureOutcomeV3Schema(context, now);
                _ = EnsureOutcomeV3Cutover(context, normalized.Rsid, now);

                RbpBatchGatedAdmission gated;
                RbpStoredBatch? existing =
                    ReadBatch(context, normalized.BatchKey);
                if (existing is null)
                {
                    gated = AdmitFreshBatch(
                        context,
                        normalized,
                        clearances,
                        stepsJcs,
                        now);
                }
                else
                {
                    RequireIdenticalBatch(existing, normalized, stepsJcs);
                    IReadOnlyList<string> scopes = MutatingScopes(normalized);
                    foreach (RbpRecoveryClearance clearance in clearances)
                    {
                        AcceptClearance(
                            context,
                            normalized.Rsid,
                            scopes,
                            clearance,
                            now);
                    }

                    gated = new RbpBatchGatedAdmission(
                        ArbitrateRedelivery(
                            context,
                            existing,
                            normalized,
                            now),
                        null);
                }

                if (gated.BlockingHold is not null)
                {
                    return gated;
                }

                RbpBatchAdmissionResult admission =
                    gated.Admission ??
                    throw new RbpJournalException(
                        RbpJournalErrorCode.IntegrityCheckFailed,
                        "The v3 batch admission has no decision.");
                foreach (RbpBatchStepArbitration step in admission.Steps)
                {
                    if (step.Stored is null)
                    {
                        continue;
                    }

                    RbpMutationOutcomeEvidence evidence =
                        step.Disposition ==
                            RbpBatchStepDisposition.RefuseIndeterminate
                            ? RbpMutationOutcomeEvidence.Uncertain(
                                RbpDispatchState.MayHaveReachedAddin,
                                transactionModes[step.BatchIndex],
                                "batch_redelivery_promotion")
                            : RbpMutationOutcomeEvidence.NotDispatched(
                                transactionModes[step.BatchIndex],
                                "batch_admission");
                    if (step.Disposition is
                        RbpBatchStepDisposition.Accepted or
                        RbpBatchStepDisposition.RefuseIndeterminate)
                    {
                        UpsertOutcomeV3(
                            context,
                            step.Stored,
                            evidence,
                            ToStorageState(step.Stored.State),
                            now);
                    }
                }

                foreach (string holdId in HoldIds(context, normalized.Rsid))
                {
                    _ = MirrorHoldV3(
                        context,
                        normalized.Rsid,
                        holdId,
                        now);
                }

                return gated;
            },
            cancellationToken);
    }

    internal Task MarkBatchDispatchedOutcomeV3Async(
        string batchKey,
        IReadOnlyList<RbpTransactionMode> transactionModes,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(batchKey, nameof(batchKey), 293);
        ArgumentNullException.ThrowIfNull(transactionModes);
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                RbpStoredBatch batch = ReadBatch(context, batchKey) ??
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "An unknown batch cannot take dispatch ownership.");
                if (transactionModes.Count != batch.StepCount)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "Batch transaction-mode count does not match its " +
                        "durable step count.");
                }

                RequireActiveSession(context, batch.Rsid);
                EnsureOutcomeV3Schema(context, now);
                _ = EnsureOutcomeV3Cutover(context, batch.Rsid, now);
                using (SqliteCommand update = context.CreateCommand(
                           """
                           UPDATE rbp_batches
                           SET state='dispatched',
                               dispatched_at_ms=COALESCE(dispatched_at_ms,$now)
                           WHERE batch_key=$key AND state='received';
                           """))
                {
                    update.Parameters.AddWithValue("$key", batchKey);
                    update.Parameters.AddWithValue("$now", now);
                    if (update.ExecuteNonQuery() != 1)
                    {
                        throw new RbpJournalException(
                            RbpJournalErrorCode.ProtocolConflict,
                            "Only a durably received batch may take " +
                            "dispatch ownership.");
                    }
                }

                IReadOnlyList<string> keys =
                    BatchInvocationKeys(context, batch.Rsid, batch.BatchId);
                if (keys.Count != transactionModes.Count)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.IntegrityCheckFailed,
                        "The durable batch step set is incomplete.");
                }

                for (int index = 0; index < keys.Count; index++)
                {
                    RbpStoredInvocation step =
                        ReadInvocation(context, keys[index]) ??
                        throw new RbpJournalException(
                            RbpJournalErrorCode.IntegrityCheckFailed,
                            "A durable batch step disappeared.");
                    UpsertOutcomeV3(
                        context,
                        step,
                        RbpMutationOutcomeEvidence.Uncertain(
                            RbpDispatchState.MayHaveReachedAddin,
                            transactionModes[index],
                            "batch_dispatch_ownership"),
                        ToStorageState(step.State),
                        now);
                }

                return true;
            },
            cancellationToken);
    }

    internal Task<string?> PersistInvocationOutcomeV3Async(
        string idempotencyKey,
        RbpInvocationTerminal terminal,
        RbpMutationOutcomeEvidence evidence,
        bool error,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(idempotencyKey, nameof(idempotencyKey), 293);
        ArgumentNullException.ThrowIfNull(terminal);
        ArgumentNullException.ThrowIfNull(evidence);
        ValidateOutcomeEvidence(evidence);
        if (terminal.State is RbpInvocationState.Received or
            RbpInvocationState.Executing)
        {
            throw new ArgumentException(
                "A terminal transition requires a terminal state.",
                nameof(terminal));
        }

        if (terminal.ResultDigest is not null)
        {
            RequireSha256(terminal.ResultDigest, nameof(terminal));
        }

        bool storeMintsOutcome =
            terminal.State == RbpInvocationState.Indeterminate &&
            terminal.Outcome.ValueKind == JsonValueKind.Undefined;
        string outcomeJson = storeMintsOutcome
            ? string.Empty
            : Rfc8785Json.Canonicalize(terminal.Outcome);
        string? resultDigest = terminal.ResultDigest;
        long now = NowMilliseconds();
        return ExecuteImmediateAsync<string?>(
            context =>
            {
                RbpStoredInvocation existing =
                    ReadInvocation(context, idempotencyKey) ??
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "An unknown invocation cannot be terminalized.");
                RequireActiveSession(context, existing.Identity.Rsid);
                EnsureOutcomeV3Schema(context, now);
                _ = EnsureOutcomeV3Cutover(
                    context,
                    existing.Identity.Rsid,
                    now);

                if (existing.State == RbpInvocationState.Indeterminate)
                {
                    RecordLateTerminal(
                        context,
                        idempotencyKey,
                        outcomeJson,
                        terminal.ResultDigest,
                        now);
                    RbpStoredInvocation late =
                        ReadInvocation(context, idempotencyKey) ?? existing;
                    UpsertOutcomeV3(
                        context,
                        late,
                        evidence,
                        "indeterminate",
                        now);
                    if (existing.VerificationHoldId is { } lateHoldId)
                    {
                        MirrorHoldV3(
                            context,
                            existing.Identity.Rsid,
                            lateHoldId,
                            now);
                    }

                    return existing.VerificationHoldId;
                }

                if (existing.IsTerminal)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "A terminal invocation outcome is immutable.");
                }

                RbpInvocationState finalState = terminal.State;
                string? holdId = null;
                bool installHold =
                    evidence.RequiresMutationHold(
                        existing.Identity.Mutating,
                        error) ||
                    (terminal.State == RbpInvocationState.Indeterminate &&
                     existing.Identity.Mutating);
                if (installHold)
                {
                    holdId = InstallHold(context, existing.Identity, now);
                    (outcomeJson, resultDigest) =
                        BuildJournalIndeterminateOutcome(
                            existing.Identity,
                            holdId);
                    finalState = RbpInvocationState.Indeterminate;
                }

                using SqliteCommand update = context.CreateCommand(
                    """
                    UPDATE rbp_invocations
                    SET state=$state,
                        terminal_outcome_json=$outcome,
                        result_digest=$digest,
                        verification_hold_id=
                          COALESCE($hold,verification_hold_id),
                        finished_at_ms=$now
                    WHERE idempotency_key=$key
                      AND state IN ('received','executing');
                    """);
                update.Parameters.AddWithValue(
                    "$state",
                    ToStorageState(finalState));
                update.Parameters.AddWithValue("$outcome", outcomeJson);
                update.Parameters.AddWithValue(
                    "$digest",
                    (object?)resultDigest ?? DBNull.Value);
                update.Parameters.AddWithValue(
                    "$hold",
                    (object?)holdId ?? DBNull.Value);
                update.Parameters.AddWithValue("$now", now);
                update.Parameters.AddWithValue("$key", idempotencyKey);
                if (update.ExecuteNonQuery() != 1)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "The invocation left its non-terminal state before " +
                        "the outcome decision committed.");
                }

                RbpStoredInvocation stored =
                    ReadInvocation(context, idempotencyKey) ??
                    throw new RbpJournalException(
                        RbpJournalErrorCode.IntegrityCheckFailed,
                        "The terminal invocation disappeared.");
                UpsertOutcomeV3(
                    context,
                    stored,
                    evidence,
                    ToStorageState(finalState),
                    now);
                if (holdId is not null)
                {
                    MirrorHoldV3(
                        context,
                        existing.Identity.Rsid,
                        holdId,
                        now);
                }

                return holdId;
            },
            cancellationToken);
    }

    internal Task<RbpOutcomeV3Snapshot?> GetOutcomeV3Async(
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(idempotencyKey, nameof(idempotencyKey), 293);
        return ReadAsync(
            connection =>
            {
                if (!TableExists(connection, "rbp_outcome_dispatch_v3"))
                {
                    return null;
                }

                using SqliteCommand command = CreateCommand(
                    connection,
                    """
                    SELECT idempotency_key,rsid,dispatch_state,effect_state,
                           transaction_mode,evidence_jcs,terminal_state,
                           record_version
                    FROM rbp_outcome_dispatch_v3
                    WHERE idempotency_key=$key;
                    """);
                command.CommandTimeout = _commandTimeoutSeconds;
                command.Parameters.AddWithValue("$key", idempotencyKey);
                using SqliteDataReader reader = command.ExecuteReader();
                return reader.Read()
                    ? new RbpOutcomeV3Snapshot(
                        reader.GetString(0),
                        reader.GetString(1),
                        reader.GetString(2),
                        reader.GetString(3),
                        reader.GetString(4),
                        reader.GetString(5),
                        reader.GetString(6),
                        reader.GetInt64(7))
                    : null;
            },
            cancellationToken);
    }

    internal Task<RbpOutcomeV3Cutover?> GetOutcomeV3CutoverAsync(
        string rsid,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), 256);
        return ReadAsync(
            connection =>
            {
                if (!TableExists(connection, "rbp_hold_cutover_v3"))
                {
                    return null;
                }

                using SqliteCommand command = CreateCommand(
                    connection,
                    """
                    SELECT rsid,legacy_digest,imported_dispatch_count,
                           imported_hold_count,imported_conflict_count,
                           imported_resolution_count,target_generation,state
                    FROM rbp_hold_cutover_v3 WHERE rsid=$rsid;
                    """);
                command.CommandTimeout = _commandTimeoutSeconds;
                command.Parameters.AddWithValue("$rsid", rsid);
                using SqliteDataReader reader = command.ExecuteReader();
                return reader.Read() ? MaterializeOutcomeV3Cutover(reader) : null;
            },
            cancellationToken);
    }

    internal Task<RbpOutcomeV3ResolutionSnapshot?>
        GetOutcomeV3ResolutionAsync(
            string resolutionId,
            CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(resolutionId, nameof(resolutionId), 36);
        return ReadAsync(
            connection =>
            {
                if (!TableExists(
                        connection,
                        "rbp_mutation_resolutions_v3"))
                {
                    return null;
                }

                using SqliteCommand command = CreateCommand(
                    connection,
                    """
                    SELECT resolution_id,hold_id,basis,
                           verification_invocation_id,evidence_digest,
                           decision,audit_id,state,record_version
                    FROM rbp_mutation_resolutions_v3
                    WHERE resolution_id=$resolution;
                    """);
                command.CommandTimeout = _commandTimeoutSeconds;
                command.Parameters.AddWithValue(
                    "$resolution",
                    resolutionId);
                using SqliteDataReader reader = command.ExecuteReader();
                if (!reader.Read())
                {
                    return null;
                }

                return new RbpOutcomeV3ResolutionSnapshot(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.IsDBNull(3) ? null : reader.GetString(3),
                    reader.GetString(4),
                    reader.GetString(5),
                    reader.GetString(6),
                    reader.GetString(7),
                    reader.GetInt64(8));
            },
            cancellationToken);
    }

    private static void EnsureOutcomeV3Schema(
        RbpJournalWriteContext context,
        long now)
    {
        using (SqliteCommand schema = context.CreateCommand(OutcomeV3Schema))
        {
            _ = schema.ExecuteNonQuery();
        }

        using SqliteCommand version = context.CreateCommand(
            """
            INSERT INTO rbp_outcome_schema_v3(
              singleton,schema_version,generation,created_at_ms
            ) VALUES(1,3,'bridge-outcome-v3',$now)
            ON CONFLICT(singleton) DO NOTHING;
            """);
        version.Parameters.AddWithValue("$now", now);
        _ = version.ExecuteNonQuery();
    }

    private static RbpOutcomeV3Cutover EnsureOutcomeV3Cutover(
        RbpJournalWriteContext context,
        string rsid,
        long now)
    {
        RbpOutcomeV3Cutover? existing = ReadOutcomeV3Cutover(context, rsid);
        if (existing is not null)
        {
            if (existing.TargetGeneration != OutcomeV3Generation ||
                existing.State != "normalized_authoritative")
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "The Bridge outcome cutover marker is contradictory.");
            }

            return existing;
        }

        var digestRows = new List<string>();
        long dispatchCount = 0;
        foreach (string key in InvocationKeys(context, rsid))
        {
            RbpStoredInvocation stored =
                ReadInvocation(context, key) ??
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "A legacy invocation disappeared during outcome import.");
            digestRows.Add(key + "|" + ToStorageState(stored.State));
            ImportLegacyInvocation(context, stored, now);
            dispatchCount++;
        }

        long holdCount = 0;
        long conflictCount = 0;
        long resolutionCount = 0;
        foreach (string holdId in HoldIds(context, rsid))
        {
            (bool Active, bool HasResolution) mirrored =
                MirrorHoldV3(context, rsid, holdId, now);
            holdCount++;
            conflictCount++;

            if (mirrored.HasResolution)
            {
                resolutionCount++;
            }

            digestRows.Add(holdId);
        }

        digestRows.Sort(StringComparer.Ordinal);
        string legacyDigest = Sha256(
            string.Join("\n", digestRows));
        using SqliteCommand insert = context.CreateCommand(
            """
            INSERT INTO rbp_hold_cutover_v3(
              rsid,record_schema,legacy_digest,imported_dispatch_count,
              imported_hold_count,imported_conflict_count,
              imported_resolution_count,target_generation,state,
              record_version,cutover_at_ms
            ) VALUES(
              $rsid,'bridge.hold-cutover/v1',$digest,$dispatches,$holds,
              $conflicts,$resolutions,'bridge-outcome-v3',
              'normalized_authoritative',1,$now
            );
            """);
        insert.Parameters.AddWithValue("$rsid", rsid);
        insert.Parameters.AddWithValue("$digest", legacyDigest);
        insert.Parameters.AddWithValue("$dispatches", dispatchCount);
        insert.Parameters.AddWithValue("$holds", holdCount);
        insert.Parameters.AddWithValue("$conflicts", conflictCount);
        insert.Parameters.AddWithValue("$resolutions", resolutionCount);
        insert.Parameters.AddWithValue("$now", now);
        if (insert.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The Bridge outcome cutover marker did not commit.");
        }

        return ReadOutcomeV3Cutover(context, rsid) ??
               throw new RbpJournalException(
                   RbpJournalErrorCode.IntegrityCheckFailed,
                   "The Bridge outcome cutover marker disappeared.");
    }

    private static void ImportLegacyInvocation(
        RbpJournalWriteContext context,
        RbpStoredInvocation stored,
        long now)
    {
        RbpStoredInvocation imported = stored;
        RbpMutationOutcomeEvidence evidence;
        if (stored.State == RbpInvocationState.Received)
        {
            evidence = RbpMutationOutcomeEvidence.NotDispatched(
                RbpTransactionMode.NotApplicable,
                "legacy_received");
        }
        else if (stored.Identity.Mutating &&
                 stored.State == RbpInvocationState.Failed)
        {
            string holdId = InstallHold(context, stored.Identity, now);
            (string outcomeJson, string outcomeDigest) =
                BuildJournalIndeterminateOutcome(stored.Identity, holdId);
            using SqliteCommand update = context.CreateCommand(
                """
                UPDATE rbp_invocations
                SET state='indeterminate',verification_hold_id=$hold,
                    terminal_outcome_json=$outcome,result_digest=$digest,
                    finished_at_ms=COALESCE(finished_at_ms,$now)
                WHERE idempotency_key=$key
                  AND state IN ('executing','failed');
                """);
            update.Parameters.AddWithValue("$hold", holdId);
            update.Parameters.AddWithValue("$outcome", outcomeJson);
            update.Parameters.AddWithValue("$digest", outcomeDigest);
            update.Parameters.AddWithValue("$now", now);
            update.Parameters.AddWithValue(
                "$key",
                stored.Identity.IdempotencyKey);
            if (update.ExecuteNonQuery() != 1)
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "A legacy uncertain mutation could not be imported " +
                    "fail-closed.");
            }

            imported = ReadInvocation(
                context,
                stored.Identity.IdempotencyKey) ?? stored;
            evidence = RbpMutationOutcomeEvidence.Uncertain(
                RbpDispatchState.MayHaveReachedAddin,
                RbpTransactionMode.NotApplicable,
                "legacy_missing_truth");
        }
        else if (stored.Identity.Mutating &&
                 stored.State == RbpInvocationState.Executing)
        {
            // Keep the v2 row non-terminal so the delivery that observes it
            // still performs rule-4 promotion and emits replayed:false. The
            // v3 cutover nevertheless records that dispatch may have begun.
            evidence = RbpMutationOutcomeEvidence.Uncertain(
                RbpDispatchState.MayHaveReachedAddin,
                RbpTransactionMode.NotApplicable,
                "legacy_executing");
        }
        else if (stored.State == RbpInvocationState.Cancelled)
        {
            evidence = RbpMutationOutcomeEvidence.NotDispatched(
                RbpTransactionMode.NotApplicable,
                "legacy_cancelled");
        }
        else if (!stored.Identity.Mutating)
        {
            evidence = new RbpMutationOutcomeEvidence(
                RbpDispatchState.ResponseObserved,
                RbpEffectState.ReadOnly,
                RbpTransactionMode.NotApplicable,
                RbpMutationOutcomeEvidence.ForLegacyOutcome(
                    RbpAddinOutcomeKind.Completed,
                    RbpTransactionMode.NotApplicable,
                    mutating: false).EvidenceJcs);
        }
        else
        {
            // Legacy completed/guarded rows remain terminal by DC-02. Their
            // missing effect proof is retained as unknown and never guessed.
            evidence = RbpMutationOutcomeEvidence.Uncertain(
                RbpDispatchState.ResponseObserved,
                RbpTransactionMode.NotApplicable,
                "legacy_terminal");
        }

        UpsertOutcomeV3(
            context,
            imported,
            evidence,
            ToStorageState(imported.State),
            now);
    }

    private static void UpsertOutcomeV3(
        RbpJournalWriteContext context,
        RbpStoredInvocation invocation,
        RbpMutationOutcomeEvidence evidence,
        string terminalState,
        long now)
    {
        ValidateOutcomeEvidence(evidence);
        using SqliteCommand upsert = context.CreateCommand(
            """
            INSERT INTO rbp_outcome_dispatch_v3(
              idempotency_key,record_schema,rsid,dispatch_state,effect_state,
              transaction_mode,evidence_jcs,terminal_state,record_version,
              created_at_ms,updated_at_ms
            ) VALUES(
              $key,'bridge.rbp-dispatch/v3',$rsid,$dispatch,$effect,$mode,
              $evidence,$terminal,1,$created,$now
            )
            ON CONFLICT(idempotency_key) DO UPDATE SET
              dispatch_state=excluded.dispatch_state,
              effect_state=excluded.effect_state,
              transaction_mode=excluded.transaction_mode,
              evidence_jcs=excluded.evidence_jcs,
              terminal_state=excluded.terminal_state,
              record_version=rbp_outcome_dispatch_v3.record_version+1,
              updated_at_ms=MAX(rbp_outcome_dispatch_v3.updated_at_ms,
                                excluded.updated_at_ms)
            WHERE rbp_outcome_dispatch_v3.record_schema=
                    'bridge.rbp-dispatch/v3'
              AND rbp_outcome_dispatch_v3.rsid=excluded.rsid;
            """);
        upsert.Parameters.AddWithValue(
            "$key",
            invocation.Identity.IdempotencyKey);
        upsert.Parameters.AddWithValue("$rsid", invocation.Identity.Rsid);
        upsert.Parameters.AddWithValue(
            "$dispatch",
            RbpMutationOutcomeEvidence.ToWire(evidence.DispatchState));
        upsert.Parameters.AddWithValue(
            "$effect",
            RbpMutationOutcomeEvidence.ToWire(evidence.EffectState));
        upsert.Parameters.AddWithValue(
            "$mode",
            RbpMutationOutcomeEvidence.ToWire(evidence.TransactionMode));
        upsert.Parameters.AddWithValue("$evidence", evidence.EvidenceJcs);
        upsert.Parameters.AddWithValue("$terminal", terminalState);
        upsert.Parameters.AddWithValue(
            "$created",
            invocation.CreatedAtMilliseconds);
        upsert.Parameters.AddWithValue("$now", now);
        if (upsert.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The v3 dispatch outcome identity is contradictory.");
        }
    }

    private static (bool Active, bool HasResolution) MirrorHoldV3(
        RbpJournalWriteContext context,
        string rsid,
        string holdId,
        long now)
    {
        RbpVerificationHold hold =
            FindHoldById(context, rsid, holdId) ??
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "A v3 mutation hold lost its v2 source authority.");
        string state = ToStorageHoldState(hold.State);
        using (SqliteCommand upsert = context.CreateCommand(
                   """
                   INSERT INTO rbp_mutation_holds_v3(
                     hold_id,record_schema,rsid,mutation_scope_jcs,
                     ordered_origin_keys_json,state,evidence_digest,
                     resolution_id,record_version,created_at_ms,updated_at_ms
                   ) VALUES(
                     $id,'bridge.mutation-hold/v1',$rsid,$scope,$origins,
                     $state,$evidence,$resolution,1,$created,$now
                   )
                   ON CONFLICT(hold_id) DO UPDATE SET
                     state=excluded.state,
                     evidence_digest=excluded.evidence_digest,
                     resolution_id=excluded.resolution_id,
                     record_version=rbp_mutation_holds_v3.record_version+1,
                     updated_at_ms=MAX(rbp_mutation_holds_v3.updated_at_ms,
                                       excluded.updated_at_ms)
                   WHERE rbp_mutation_holds_v3.record_schema=
                           'bridge.mutation-hold/v1'
                     AND rbp_mutation_holds_v3.rsid=excluded.rsid
                     AND rbp_mutation_holds_v3.mutation_scope_jcs=
                           excluded.mutation_scope_jcs
                     AND rbp_mutation_holds_v3.ordered_origin_keys_json=
                           excluded.ordered_origin_keys_json;
                   """))
        {
            upsert.Parameters.AddWithValue("$id", hold.VerificationHoldId);
            upsert.Parameters.AddWithValue("$rsid", hold.Rsid);
            upsert.Parameters.AddWithValue("$scope", hold.ScopeJcs);
            upsert.Parameters.AddWithValue(
                "$origins",
                JsonSerializer.Serialize(hold.OrderedOriginIdempotencyKeys));
            upsert.Parameters.AddWithValue("$state", state);
            upsert.Parameters.AddWithValue(
                "$evidence",
                (object?)hold.EvidenceDigest ?? DBNull.Value);
            upsert.Parameters.AddWithValue(
                "$resolution",
                (object?)hold.ResolutionId ?? DBNull.Value);
            upsert.Parameters.AddWithValue(
                "$created",
                hold.CreatedAtMilliseconds);
            upsert.Parameters.AddWithValue("$now", now);
            if (upsert.ExecuteNonQuery() != 1)
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "The v3 hold identity is contradictory.");
            }
        }

        string scopeDigest = Sha256(hold.ScopeJcs);
        using (SqliteCommand conflict = context.CreateCommand(
                   """
                   INSERT INTO rbp_mutation_conflicts_v3(
                     conflict_key,record_schema,rsid,scope_digest,hold_id,
                     mutation_scope_jcs,active,record_version,
                     created_at_ms,updated_at_ms
                   ) VALUES(
                     $key,'bridge.mutation-conflict/v1',$rsid,$digest,$hold,
                     $scope,$active,1,$created,$now
                   )
                   ON CONFLICT(conflict_key) DO UPDATE SET
                     hold_id=excluded.hold_id,
                     mutation_scope_jcs=excluded.mutation_scope_jcs,
                     active=excluded.active,
                     record_version=rbp_mutation_conflicts_v3.record_version+1,
                     updated_at_ms=MAX(rbp_mutation_conflicts_v3.updated_at_ms,
                                       excluded.updated_at_ms)
                   WHERE rbp_mutation_conflicts_v3.record_schema=
                           'bridge.mutation-conflict/v1'
                     AND rbp_mutation_conflicts_v3.rsid=excluded.rsid
                     AND rbp_mutation_conflicts_v3.scope_digest=
                           excluded.scope_digest
                     AND rbp_mutation_conflicts_v3.hold_id=excluded.hold_id
                     AND rbp_mutation_conflicts_v3.mutation_scope_jcs=
                           excluded.mutation_scope_jcs;
                   """))
        {
            conflict.Parameters.AddWithValue(
                "$key",
                hold.Rsid + "/" + scopeDigest);
            conflict.Parameters.AddWithValue("$rsid", hold.Rsid);
            conflict.Parameters.AddWithValue("$digest", scopeDigest);
            conflict.Parameters.AddWithValue("$hold", hold.VerificationHoldId);
            conflict.Parameters.AddWithValue("$scope", hold.ScopeJcs);
            conflict.Parameters.AddWithValue(
                "$active",
                hold.State == RbpHoldState.Cleared ? 0 : 1);
            conflict.Parameters.AddWithValue(
                "$created",
                hold.CreatedAtMilliseconds);
            conflict.Parameters.AddWithValue("$now", now);
            if (conflict.ExecuteNonQuery() != 1)
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "The v3 conflict identity is contradictory.");
            }
        }

        bool hasResolution = hold.ResolutionId is { Length: > 0 };
        if (hasResolution)
        {
            MirrorResolutionV3(context, hold, now);
        }

        return (hold.State != RbpHoldState.Cleared, hasResolution);
    }

    private static void MirrorResolutionV3(
        RbpJournalWriteContext context,
        RbpVerificationHold hold,
        long now)
    {
        string resolutionId = hold.ResolutionId!;
        string basis = hold.ResolutionBasis ?? string.Empty;
        bool validVerificationId = basis == "verification_read"
            ? RbpRecoveryClearance.IsUuidV7(hold.VerificationInvocationId)
            : basis == "late_terminal" &&
              hold.VerificationInvocationId is null;
        if (!RbpRecoveryClearance.IsUuidV7(resolutionId) ||
            !RbpRecoveryClearance.IsUuidV7(hold.AuditId) ||
            !RbpRecoveryClearance.IsSha256Digest(hold.EvidenceDigest) ||
            !validVerificationId ||
            hold.ResolutionDecision is not (
                "non_execution_proven" or "postcondition_verified"))
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "A durable hold resolution violates DC-02 evidence shape.");
        }

        using SqliteCommand resolution = context.CreateCommand(
            """
            INSERT INTO rbp_mutation_resolutions_v3(
              resolution_id,record_schema,hold_id,basis,
              verification_invocation_id,evidence_digest,decision,audit_id,
              state,record_version,created_at_ms,updated_at_ms
            ) VALUES(
              $resolution,'bridge.mutation-resolution/v1',$hold,$basis,$vid,
              $evidence,$decision,$audit,$state,1,$created,$now
            )
            ON CONFLICT(resolution_id) DO UPDATE SET
              state=excluded.state,
              record_version=rbp_mutation_resolutions_v3.record_version+1,
              updated_at_ms=MAX(rbp_mutation_resolutions_v3.updated_at_ms,
                                excluded.updated_at_ms)
            WHERE rbp_mutation_resolutions_v3.record_schema=
                    'bridge.mutation-resolution/v1'
              AND rbp_mutation_resolutions_v3.hold_id=excluded.hold_id
              AND rbp_mutation_resolutions_v3.basis=excluded.basis
              AND rbp_mutation_resolutions_v3.verification_invocation_id
                    IS excluded.verification_invocation_id
              AND rbp_mutation_resolutions_v3.evidence_digest=
                    excluded.evidence_digest
              AND rbp_mutation_resolutions_v3.decision=excluded.decision
              AND rbp_mutation_resolutions_v3.audit_id=excluded.audit_id;
            """);
        resolution.Parameters.AddWithValue("$resolution", resolutionId);
        resolution.Parameters.AddWithValue("$hold", hold.VerificationHoldId);
        resolution.Parameters.AddWithValue("$basis", basis);
        resolution.Parameters.AddWithValue(
            "$vid",
            (object?)hold.VerificationInvocationId ?? DBNull.Value);
        resolution.Parameters.AddWithValue("$evidence", hold.EvidenceDigest!);
        resolution.Parameters.AddWithValue(
            "$decision",
            hold.ResolutionDecision!);
        resolution.Parameters.AddWithValue("$audit", hold.AuditId!);
        resolution.Parameters.AddWithValue(
            "$state",
            hold.State == RbpHoldState.Cleared
                ? "accepted"
                : "pending_bridge");
        resolution.Parameters.AddWithValue(
            "$created",
            hold.CreatedAtMilliseconds);
        resolution.Parameters.AddWithValue("$now", now);
        if (resolution.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The v3 resolution identity is contradictory.");
        }
    }

    private static IReadOnlyList<string> InvocationKeys(
        RbpJournalWriteContext context,
        string rsid)
    {
        var keys = new List<string>();
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT idempotency_key FROM rbp_invocations
            WHERE rsid=$rsid ORDER BY idempotency_key;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            keys.Add(reader.GetString(0));
        }

        return keys.AsReadOnly();
    }

    private static IReadOnlyList<string> BatchInvocationKeys(
        RbpJournalWriteContext context,
        string rsid,
        string batchId)
    {
        var keys = new List<string>();
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT idempotency_key FROM rbp_invocations
            WHERE rsid=$rsid AND batch_id=$batch
            ORDER BY batch_index;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$batch", batchId);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            keys.Add(reader.GetString(0));
        }

        return keys.AsReadOnly();
    }

    private static IReadOnlyList<string> HoldIds(
        RbpJournalWriteContext context,
        string rsid)
    {
        var ids = new List<string>();
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT verification_hold_id FROM rbp_verification_holds
            WHERE rsid=$rsid ORDER BY verification_hold_id;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            ids.Add(reader.GetString(0));
        }

        return ids.AsReadOnly();
    }

    private static RbpOutcomeV3Cutover? ReadOutcomeV3Cutover(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT rsid,legacy_digest,imported_dispatch_count,
                   imported_hold_count,imported_conflict_count,
                   imported_resolution_count,target_generation,state
            FROM rbp_hold_cutover_v3 WHERE rsid=$rsid;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return reader.Read() ? MaterializeOutcomeV3Cutover(reader) : null;
    }

    private static RbpOutcomeV3Cutover MaterializeOutcomeV3Cutover(
        SqliteDataReader reader) =>
        new(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetInt64(2),
            reader.GetInt64(3),
            reader.GetInt64(4),
            reader.GetInt64(5),
            reader.GetString(6),
            reader.GetString(7));

    private static void ValidateOutcomeEvidence(
        RbpMutationOutcomeEvidence evidence)
    {
        if (Encoding.UTF8.GetByteCount(evidence.EvidenceJcs) >
            RbpMutationOutcomeEvidence.MaximumEvidenceBytes ||
            evidence.EvidenceJcs.Length < 2 ||
            (evidence.DispatchState == RbpDispatchState.NotStarted &&
             evidence.EffectState != RbpEffectState.NotStarted) ||
            (evidence.EffectState == RbpEffectState.Committed &&
             evidence.DispatchState != RbpDispatchState.ResponseObserved))
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "Mutation outcome evidence is contradictory or unbounded.");
        }

        try
        {
            using JsonDocument parsed = JsonDocument.Parse(
                evidence.EvidenceJcs);
            if (!string.Equals(
                    Rfc8785Json.Canonicalize(parsed.RootElement),
                    evidence.EvidenceJcs,
                    StringComparison.Ordinal))
            {
                throw new FormatException();
            }
        }
        catch (Exception exception) when (
            exception is JsonException or FormatException or
                InvalidOperationException)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "Mutation outcome evidence must be bounded RFC 8785 JSON.",
                exception);
        }
    }

    private static string ToStorageHoldState(RbpHoldState state) =>
        state switch
        {
            RbpHoldState.Active => "active",
            RbpHoldState.EvidenceRecorded => "evidence_recorded",
            RbpHoldState.ResolvedPendingBridge => "resolved_pending_bridge",
            RbpHoldState.Cleared => "cleared",
            _ => throw new ArgumentOutOfRangeException(nameof(state)),
        };

    private static string Sha256(string value) =>
        "sha256:" +
        Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(value)))
            .ToLowerInvariant();
}
