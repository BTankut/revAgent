using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Storage;

/// <summary>
/// Frozen O1 Section 12 batch coordination authority.
///
/// <see cref="AdmitBatchAsync"/> binds the verified <c>batch_digest</c>,
/// <c>batch_id</c>, <c>atomic</c> flag, timeout, recovery clearances, and
/// the complete ordered step representation in one transaction before any
/// add-in byte may be written (spec ~1071-1075). On redelivery the
/// coordination row is checked before any step row: any changed element is
/// a terminal <c>protocol</c> fault (spec ~1102-1105); an unchanged
/// redelivery is arbitrated under the frozen Section 12.2 core per step for
/// <c>atomic:false</c> (spec ~1109-1119) and as one indivisible transaction
/// for <c>atomic:true</c> (spec ~1121-1131). A malformed or contradictory
/// durable state cannot be repaired by inference and fails closed.
/// </summary>
internal sealed partial class RbpJournalStore
{
    private const string BatchColumns =
        """
        batch_key,rsid,batch_id,batch_digest,atomic,timeout_ms,
        recovery_clearances_jcs,steps_jcs,step_count,state,
        terminal_outcome_json,result_digest,created_at_ms,
        dispatched_at_ms,finished_at_ms
        """;

    /// <summary>
    /// Admits an <c>invoke_batch</c> under its durable coordination key
    /// after accepting its Section 6.2.1 recovery clearances against every
    /// mutating step scope in the same transaction. On first delivery the
    /// coordination row and every ordered step row are durable
    /// (<c>received</c>) before this method returns, so the caller cannot
    /// have written an add-in byte yet. A fresh batch whose mutating step
    /// scope conflicts with an uncleared hold is blocked exactly like a
    /// fresh invocation (Section 21 item 28); redelivery of the bound batch
    /// is exempt from the conflict block and is arbitrated instead.
    /// </summary>
    internal Task<RbpBatchGatedAdmission> AdmitBatchAsync(
        RbpBatchIdentity identity,
        IReadOnlyList<RbpRecoveryClearance> clearances,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(clearances);
        ValidateBatchIdentity(identity);
        RbpBatchIdentity normalized = NormalizeBatchIdentity(identity);
        ValidateBatchClearances(normalized, clearances);
        VerifyBatchDigestBinding(normalized);
        string stepsJcs = BuildStepsJcs(normalized);
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                RequireActiveSession(context, normalized.Rsid);
                RbpStoredBatch? existing =
                    ReadBatch(context, normalized.BatchKey);
                if (existing is null)
                {
                    return AdmitFreshBatch(
                        context,
                        normalized,
                        clearances,
                        stepsJcs,
                        now);
                }

                // Spec ~1102-1105: the coordination row is checked before
                // any step row; any changed element is a terminal protocol
                // fault, while an RFC 8785-identical reserialization is not
                // a mismatch.
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

                return new RbpBatchGatedAdmission(
                    ArbitrateRedelivery(context, existing, normalized, now),
                    null);
            },
            cancellationToken);
    }

    /// <summary>
    /// Persists <c>dispatched</c> before or atomically with the first add-in
    /// byte of this batch, so a later missing terminal outcome is provably
    /// a dispatch loss and a <c>received</c> row durably proves that no
    /// add-in byte was sent (spec ~1122-1123).
    /// </summary>
    internal Task MarkBatchDispatchedAsync(
        string batchKey,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(batchKey, nameof(batchKey), 293);
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand update = context.CreateCommand(
                    """
                    UPDATE rbp_batches
                    SET state='dispatched',
                        dispatched_at_ms=COALESCE(dispatched_at_ms,$now)
                    WHERE batch_key=$key AND state='received';
                    """);
                update.Parameters.AddWithValue("$key", batchKey);
                update.Parameters.AddWithValue("$now", now);
                if (update.ExecuteNonQuery() != 1)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "Only a durably received batch may take dispatch " +
                        "ownership.");
                }

                return true;
            },
            cancellationToken);
    }

    /// <summary>
    /// Persists the durable terminal batch outcome before any Section 11.1
    /// carrier reaches the Gateway. A terminal batch outcome is immutable
    /// and replays with identical semantics on every later redelivery.
    /// </summary>
    internal Task<RbpStoredBatch> PersistBatchTerminalAsync(
        string batchKey,
        RbpBatchTerminal terminal,
        CancellationToken cancellationToken = default,
        RbpBatchIdentity? expectedIdentity = null)
    {
        ValidateIdentifier(batchKey, nameof(batchKey), 293);
        ArgumentNullException.ThrowIfNull(terminal);
        RequireSha256(terminal.ResultDigest, nameof(terminal));
        string outcomeJson = Rfc8785Json.Canonicalize(terminal.Outcome);
        long now = NowMilliseconds();
        // The exact ordered member keys participate in aggregate readback.
        // They are loaded from the durable binding, never caller reconstruction.
        return PersistBatchDecisionAsync(batchKey, terminal, outcomeJson, now, cancellationToken, expectedIdentity);
    }

    private async Task<RbpStoredBatch> PersistBatchDecisionAsync(
        string batchKey, RbpBatchTerminal terminal, string outcomeJson, long now,
        CancellationToken cancellationToken, RbpBatchIdentity? expectedIdentity)
    {
        RbpStoredBatch binding = await GetBatchAsync(batchKey, cancellationToken).ConfigureAwait(false) ??
            throw MissingStepRow();
        using JsonDocument ordered = JsonDocument.Parse(binding.StepsJcs);
        string[] keys = ordered.RootElement.EnumerateArray()
            .Select(step => binding.Rsid + "/" + step.GetProperty("invocation_id").GetString()).ToArray();
        return await ExecuteProvenDecisionAsync(
            context =>
            {
                RbpStoredBatch existing =
                    ReadBatch(context, batchKey) ??
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "An unknown batch cannot be terminalized.");
                if (expectedIdentity is not null)
                {
                    RbpBatchIdentity normalized = NormalizeBatchIdentity(expectedIdentity);
                    RequireIdenticalBatch(existing, normalized, BuildStepsJcs(normalized));
                    for (int index = 0; index < normalized.Steps.Count; index++)
                    {
                        RbpInvocationIdentity member = StepInvocationIdentity(normalized, index);
                        RequireIdenticalIdentity((ReadInvocation(context, member.IdempotencyKey) ?? throw MissingStepRow()).Identity, member);
                    }
                }
                if (existing.State == RbpBatchState.Terminal)
                {
                    if (expectedIdentity is not null && existing.TerminalOutcomeJson == outcomeJson &&
                        existing.ResultDigest == terminal.ResultDigest)
                        return existing;
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "A terminal batch outcome is immutable.");
                }

                UpdateBatchTerminal(
                    context,
                    batchKey,
                    outcomeJson,
                    terminal.ResultDigest,
                    now);
                return ReadBatch(context, batchKey) ??
                       throw new RbpJournalException(
                           RbpJournalErrorCode.IntegrityCheckFailed,
                           "The terminalized batch row disappeared inside " +
                           "its own transaction.");
            },
            keys, batchKey, cancellationToken).ConfigureAwait(false);
    }

    internal Task<string?> PersistBatchStepDecisionAsync(
        RbpBatchIdentity identity, int index, RbpInvocationTerminal terminal,
        CancellationToken cancellationToken = default) =>
        PersistInvocationTerminalAsync(StepInvocationIdentity(identity, index).IdempotencyKey,
            terminal, cancellationToken, StepInvocationIdentity(identity, index));

    /// <summary>First-delivery failure, not a synthetic admission/redelivery.</summary>
    internal Task<RbpBatchAdmissionResult> PersistAtomicDispatchFailureAsync(
        RbpBatchIdentity identity, string? applicationFaultClass = null,
        CancellationToken cancellationToken = default)
    {
        ValidateBatchIdentity(identity);
        RbpBatchIdentity normalized = NormalizeBatchIdentity(identity);
        VerifyBatchDigestBinding(normalized);
        if (!normalized.Atomic || applicationFaultClass is not (null or "unsupported" or "parameter" or "revit_api" or "protocol"))
            throw new ArgumentException("Invalid atomic dispatch failure classification.");
        string stepsJcs = BuildStepsJcs(normalized);
        string[] keys = Enumerable.Range(0, normalized.Steps.Count)
            .Select(index => StepInvocationIdentity(normalized, index).IdempotencyKey).ToArray();
        long now = NowMilliseconds();
        return ExecuteProvenDecisionAsync(context =>
        {
            RbpStoredBatch stored = ReadBatch(context, normalized.BatchKey) ?? throw MissingStepRow();
            RequireIdenticalBatch(stored, normalized, stepsJcs);
            if (stored.State != RbpBatchState.Dispatched || stored.DispatchedAtMilliseconds is null)
                throw new RbpJournalException(RbpJournalErrorCode.IntegrityCheckFailed,
                    "Only the exact dispatched atomic batch can record this decision.");
            for (int index = 0; index < normalized.Steps.Count; index++)
            {
                RbpStoredInvocation row = ReadInvocation(context, keys[index]) ?? throw MissingStepRow();
                RequireIdenticalIdentity(row.Identity, StepInvocationIdentity(normalized, index));
                if (row.IsTerminal)
                    throw new RbpJournalException(RbpJournalErrorCode.IntegrityCheckFailed,
                        "A first-delivery atomic failure cannot replace an immutable member terminal.");
            }
            return ArbitrateAtomicDispatchLoss(context, stored, normalized, now, applicationFaultClass, requireExactOrigins: true)
                with
            { ReplayPermitted = false };
        }, keys, normalized.BatchKey, cancellationToken);
    }

    /// <summary>
    /// Reads a durable batch coordination row by canonical key, for
    /// answer-from-journal paths that do not admit a delivery.
    /// </summary>
    internal Task<RbpStoredBatch?> GetBatchAsync(
        string batchKey,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(batchKey, nameof(batchKey), 293);
        return ReadAsync(
            connection =>
            {
                using SqliteCommand command = CreateCommand(
                    connection,
                    $"""
                     SELECT {BatchColumns}
                     FROM rbp_batches
                     WHERE batch_key=$key;
                     """);
                command.CommandTimeout = _commandTimeoutSeconds;
                command.Parameters.AddWithValue("$key", batchKey);
                return MaterializeBatch(command);
            },
            cancellationToken);
    }

    private static RbpBatchGatedAdmission AdmitFreshBatch(
        RbpJournalWriteContext context,
        RbpBatchIdentity identity,
        IReadOnlyList<RbpRecoveryClearance> clearances,
        string stepsJcs,
        long now)
    {
        IReadOnlyList<string> scopes = MutatingScopes(identity);
        foreach (RbpRecoveryClearance clearance in clearances)
        {
            AcceptClearance(context, identity.Rsid, scopes, clearance, now);
        }

        // Section 21 item 28: every step scope is checked against Section
        // 6.2.1 before any step row is created or dispatched. A residual
        // conflict with a non-empty clearance list proves this envelope is
        // not the one permitted evidence-bound batch, and the rollback
        // keeps every hold uncleared.
        foreach (string scope in scopes)
        {
            RbpVerificationHold? blocking =
                FindConflictingHold(context, identity.Rsid, scope);
            if (blocking is not null)
            {
                if (clearances.Count > 0)
                {
                    throw ClearanceFault(
                        "the clearance envelope does not cover every hold " +
                        "conflicting with a batch step mutation scope");
                }

                return new RbpBatchGatedAdmission(null, blocking);
            }
        }

        InsertBatchRow(context, identity, stepsJcs, now);
        var steps =
            new List<RbpBatchStepArbitration>(identity.Steps.Count);
        for (int index = 0; index < identity.Steps.Count; index++)
        {
            RbpInvocationIdentity stepIdentity =
                StepInvocationIdentity(identity, index);
            RbpInvocationAdmissionResult admitted =
                AdmitInvocation(context, stepIdentity, now);
            if (admitted.Admission != RbpInvocationAdmission.Accepted)
            {
                // A step id with a pre-existing journal row under a fresh
                // coordination row cannot be repaired by inference.
                throw new RbpJournalException(
                    RbpJournalErrorCode.ProtocolConflict,
                    "A fresh batch may not bind a step invocation id that " +
                    "already has a journal row.");
            }

            steps.Add(
                new RbpBatchStepArbitration(
                    index,
                    stepIdentity.InvocationId,
                    RbpBatchStepDisposition.Accepted,
                    admitted.Stored,
                    null));
        }

        RbpStoredBatch stored =
            ReadBatch(context, identity.BatchKey) ??
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The admitted batch row disappeared inside its own " +
                "transaction.");
        return new RbpBatchGatedAdmission(
            new RbpBatchAdmissionResult(
                RbpBatchAdmission.Accepted,
                stored,
                steps.AsReadOnly(),
                null,
                ReplayPermitted: false),
            null);
    }

    private static RbpBatchAdmissionResult ArbitrateRedelivery(
        RbpJournalWriteContext context,
        RbpStoredBatch stored,
        RbpBatchIdentity identity,
        long now)
    {
        if (stored.State == RbpBatchState.Terminal)
        {
            return BuildTerminalReplay(context, stored, identity);
        }

        if (identity.Atomic)
        {
            // Spec ~1122-1123: a coordination row still in `received` may
            // execute only when it durably proves that no add-in byte was
            // sent; any advanced step state contradicts that proof and
            // fails closed into the dispatch-loss path.
            if (stored.State == RbpBatchState.Received &&
                AllStepsStillReceived(context, identity))
            {
                return BuildExecuteFromReceived(context, stored, identity);
            }

            return ArbitrateAtomicDispatchLoss(context, stored, identity, now);
        }

        return ArbitrateOrderedSteps(context, stored, identity, now);
    }

    private static RbpBatchAdmissionResult BuildTerminalReplay(
        RbpJournalWriteContext context,
        RbpStoredBatch stored,
        RbpBatchIdentity identity)
    {
        var steps =
            new List<RbpBatchStepArbitration>(identity.Steps.Count);
        int? firstNonSuccess = null;
        for (int index = 0; index < identity.Steps.Count; index++)
        {
            RbpInvocationIdentity stepIdentity =
                StepInvocationIdentity(identity, index);
            RbpStoredInvocation? row =
                ReadInvocation(context, stepIdentity.IdempotencyKey);
            if (row is null)
            {
                // The per-step evidence aged out after the batch became
                // terminal; the durable batch outcome remains the replay
                // authority.
                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.ReplayTerminal,
                        null,
                        null));
                continue;
            }

            RequireIdenticalIdentity(row.Identity, stepIdentity);
            if (row.State == RbpInvocationState.Indeterminate &&
                row.LateTerminalOutcomeJson is not null)
            {
                firstNonSuccess ??= index;
                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.ReplayLateAfterIndeterminate,
                        row,
                        row.VerificationHoldId));
            }
            else if (row.IsTerminal)
            {
                if (row.State != RbpInvocationState.Completed)
                {
                    firstNonSuccess ??= index;
                }

                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.ReplayTerminal,
                        row,
                        row.VerificationHoldId));
            }
            else
            {
                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.NotStarted,
                        row,
                        null));
            }
        }

        // Spec ~1119, ~1129-1130: the replay delivery executes no add-in
        // step, so batch replayed:true is permitted.
        return new RbpBatchAdmissionResult(
            RbpBatchAdmission.ReplayTerminal,
            stored,
            steps.AsReadOnly(),
            firstNonSuccess,
            ReplayPermitted: true);
    }

    private static RbpBatchAdmissionResult BuildExecuteFromReceived(
        RbpJournalWriteContext context,
        RbpStoredBatch stored,
        RbpBatchIdentity identity)
    {
        var steps =
            new List<RbpBatchStepArbitration>(identity.Steps.Count);
        for (int index = 0; index < identity.Steps.Count; index++)
        {
            RbpInvocationIdentity stepIdentity =
                StepInvocationIdentity(identity, index);
            RbpStoredInvocation row =
                ReadInvocation(context, stepIdentity.IdempotencyKey) ??
                throw MissingStepRow();
            steps.Add(
                new RbpBatchStepArbitration(
                    index,
                    stepIdentity.InvocationId,
                    RbpBatchStepDisposition.Accepted,
                    row,
                    null));
        }

        return new RbpBatchAdmissionResult(
            RbpBatchAdmission.ExecuteFromReceived,
            stored,
            steps.AsReadOnly(),
            null,
            ReplayPermitted: false);
    }

    private static RbpBatchAdmissionResult ArbitrateOrderedSteps(
        RbpJournalWriteContext context,
        RbpStoredBatch stored,
        RbpBatchIdentity identity,
        long now)
    {
        var steps =
            new List<RbpBatchStepArbitration>(identity.Steps.Count);
        int? firstNonSuccess = null;
        bool stopped = false;
        bool mayExecute = false;
        for (int index = 0; index < identity.Steps.Count; index++)
        {
            RbpInvocationIdentity stepIdentity =
                StepInvocationIdentity(identity, index);
            RbpStoredInvocation row =
                ReadInvocation(context, stepIdentity.IdempotencyKey) ??
                throw MissingStepRow();
            RequireIdenticalIdentity(row.Identity, stepIdentity);
            if (stopped)
            {
                // Spec ~1110-1111, ~1115-1116: every ordered successor
                // behind the stopping step is returned as not_started and
                // may run only after a recovered step is terminal-successful
                // and no active hold conflicts with its mutation.
                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.NotStarted,
                        row,
                        null));
                continue;
            }

            if (row.State == RbpInvocationState.Indeterminate &&
                row.LateTerminalOutcomeJson is not null)
            {
                // Rule 2: evidence-only replay; the hold is not cleared and
                // the indeterminate step still stops the batch.
                firstNonSuccess ??= index;
                stopped = true;
                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.ReplayLateAfterIndeterminate,
                        row,
                        row.VerificationHoldId));
            }
            else if (row.IsTerminal)
            {
                // Rule 1: terminal prefix steps replay from their journals
                // and are never re-executed. A terminal
                // guarded|failed|cancelled|indeterminate step stops the
                // batch (spec ~1109-1111).
                if (row.State != RbpInvocationState.Completed)
                {
                    firstNonSuccess ??= index;
                    stopped = true;
                }

                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.ReplayTerminal,
                        row,
                        row.VerificationHoldId));
            }
            else if (!stepIdentity.Mutating)
            {
                // Spec ~1112-1113: the first non-terminal read step may
                // execute once under invocation redelivery rule 3; ordered
                // successors wait for its terminal-successful recovery.
                stopped = true;
                mayExecute = true;
                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.RetryNonMutating,
                        row,
                        null));
            }
            else
            {
                // Spec ~1113-1114 (rule 4): the first non-terminal mutating
                // step becomes indeterminate, installs its Section 6.2.1
                // scope hold, stops the batch, and requires correlated
                // verification. Exactly one step becomes uncertain here, so
                // spec ~477 applies unchanged: the origin list has one key.
                string holdId = InstallHold(context, row.Identity, now);
                MarkInvocationIndeterminate(
                    context,
                    row.Identity,
                    holdId,
                    now);
                RbpStoredInvocation refused =
                    ReadInvocation(context, stepIdentity.IdempotencyKey) ??
                    throw MissingStepRow();
                firstNonSuccess ??= index;
                stopped = true;
                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.RefuseIndeterminate,
                        refused,
                        holdId));
            }
        }

        return new RbpBatchAdmissionResult(
            RbpBatchAdmission.ArbitratedSteps,
            stored,
            steps.AsReadOnly(),
            firstNonSuccess,
            ReplayPermitted: !mayExecute);
    }

    private static RbpBatchAdmissionResult ArbitrateAtomicDispatchLoss(
        RbpJournalWriteContext context,
        RbpStoredBatch stored,
        RbpBatchIdentity identity,
        long now,
        string? applicationFaultClass = null,
        bool requireExactOrigins = false)
    {
        // Spec ~477-480: for an uncertain atomic batch each scope's origin
        // list holds, in input order, every possibly executed mutating step
        // key in that scope, and a session-scoped uncertain step collapses
        // the batch into one subsuming session hold. The derived id is a
        // function of the complete ordered list, so every hold of this batch
        // is grouped and derived before the first step row is marked
        // indeterminate; deriving step by step would bind each earlier step
        // to an id the next step's origin invalidates.
        IReadOnlyDictionary<string, string> holdByStepKey =
            InstallAtomicBatchHolds(context, identity, now, requireExactOrigins);
        var steps =
            new List<RbpBatchStepArbitration>(identity.Steps.Count);
        var holdIds = new List<string>();
        int? firstNonSuccess = null;
        bool anyIndeterminateMutation = false;
        for (int index = 0; index < identity.Steps.Count; index++)
        {
            RbpInvocationIdentity stepIdentity =
                StepInvocationIdentity(identity, index);
            RbpStoredInvocation row =
                ReadInvocation(context, stepIdentity.IdempotencyKey) ??
                throw MissingStepRow();
            RequireIdenticalIdentity(row.Identity, stepIdentity);
            if (row.State == RbpInvocationState.Indeterminate &&
                row.LateTerminalOutcomeJson is not null)
            {
                anyIndeterminateMutation = true;
                firstNonSuccess ??= index;
                AppendDistinct(holdIds, row.VerificationHoldId);
                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.ReplayLateAfterIndeterminate,
                        row,
                        row.VerificationHoldId));
            }
            else if (row.IsTerminal)
            {
                if (row.State != RbpInvocationState.Completed)
                {
                    firstNonSuccess ??= index;
                }

                if (row.State == RbpInvocationState.Indeterminate)
                {
                    anyIndeterminateMutation = true;
                    AppendDistinct(holdIds, row.VerificationHoldId);
                }

                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.ReplayTerminal,
                        row,
                        row.VerificationHoldId));
            }
            else if (stepIdentity.Mutating)
            {
                // Spec ~1123-1127: every possibly mutating step is
                // indeterminate; one hold per distinct conflicting mutation
                // scope with the ordered possibly executed step keys as
                // origins; no individual step is retried.
                string holdId = holdByStepKey[stepIdentity.IdempotencyKey];
                MarkInvocationIndeterminate(
                    context,
                    row.Identity,
                    holdId,
                    now);
                RbpStoredInvocation refused =
                    ReadInvocation(context, stepIdentity.IdempotencyKey) ??
                    throw MissingStepRow();
                anyIndeterminateMutation = true;
                firstNonSuccess ??= index;
                AppendDistinct(holdIds, holdId);
                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.RefuseIndeterminate,
                        refused,
                        holdId));
            }
            else
            {
                // Spec ~985-986, ~1128-1129: a read result lost with the
                // missing carrier is terminalized as the narrow known
                // environment failure, never as a synthetic success.
                TerminalizeEnvironmentRead(context, row.Identity, now, applicationFaultClass);
                RbpStoredInvocation failed =
                    ReadInvocation(context, stepIdentity.IdempotencyKey) ??
                    throw MissingStepRow();
                firstNonSuccess ??= index;
                steps.Add(
                    new RbpBatchStepArbitration(
                        index,
                        stepIdentity.InvocationId,
                        RbpBatchStepDisposition.EnvironmentFailed,
                        failed,
                        null));
            }
        }

        (string outcomeJson, string outcomeDigest) =
            BuildDispatchLossOutcome(
                identity,
                anyIndeterminateMutation,
                holdIds,
                firstNonSuccess);
        UpdateBatchTerminal(
            context,
            identity.BatchKey,
            outcomeJson,
            outcomeDigest,
            now);
        RbpStoredBatch terminal =
            ReadBatch(context, identity.BatchKey) ??
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The arbitrated batch row disappeared inside its own " +
                "transaction.");

        // Spec ~1129-1130: the recovery delivery executes no add-in step,
        // so the resulting batch and its terminal steps use replayed:true.
        return new RbpBatchAdmissionResult(
            RbpBatchAdmission.DispatchLossArbitrated,
            terminal,
            steps.AsReadOnly(),
            firstNonSuccess,
            ReplayPermitted: true);
    }

    /// <summary>
    /// Groups the possibly executed mutating steps of one uncertain atomic
    /// batch into their Section 6.2.1 holds and installs each derived hold
    /// once (spec ~477-480).
    /// </summary>
    /// <remarks>
    /// The frozen text is: "For an uncertain atomic batch, each scope's list
    /// contains, in input order, every possibly executed mutating step key in
    /// that scope. If any uncertain step uses session scope, one session hold
    /// contains all possibly executed mutating origin keys and subsumes
    /// document holds for that batch; otherwise there is one hold per
    /// affected document." A step whose journal row is already terminal has a
    /// known effect and is therefore not an origin of a new hold.
    /// </remarks>
    private static IReadOnlyDictionary<string, string> InstallAtomicBatchHolds(
        RbpJournalWriteContext context,
        RbpBatchIdentity identity,
        long now,
        bool requireExactOrigins = false)
    {
        var uncertain = new List<(string Key, string ScopeJcs)>();
        for (int index = 0; index < identity.Steps.Count; index++)
        {
            RbpInvocationIdentity stepIdentity =
                StepInvocationIdentity(identity, index);
            RbpStoredInvocation row =
                ReadInvocation(context, stepIdentity.IdempotencyKey) ??
                throw MissingStepRow();
            if (!row.IsTerminal &&
                stepIdentity.MutationScopeJcs is { } scopeJcs)
            {
                uncertain.Add((stepIdentity.IdempotencyKey, scopeJcs));
            }
        }

        var holdByStepKey =
            new Dictionary<string, string>(StringComparer.Ordinal);
        if (uncertain.Count == 0)
        {
            return holdByStepKey;
        }

        string? sessionScopeJcs = null;
        foreach ((string _, string scopeJcs) in uncertain)
        {
            if (string.Equals(
                    ReadScopeShape(scopeJcs).ScopeKind,
                    "session",
                    StringComparison.Ordinal))
            {
                sessionScopeJcs = scopeJcs;
                break;
            }
        }

        if (sessionScopeJcs is not null)
        {
            var subsumedOrigins = new List<string>(uncertain.Count);
            foreach ((string key, string _) in uncertain)
            {
                subsumedOrigins.Add(key);
            }

            string sessionHoldId = InstallHold(
                context,
                identity.Rsid,
                sessionScopeJcs,
                subsumedOrigins,
                now);
            if (requireExactOrigins)
                RequireExactDecisionHold(context, identity.Rsid, sessionScopeJcs, subsumedOrigins, sessionHoldId);
            foreach (string key in subsumedOrigins)
            {
                holdByStepKey[key] = sessionHoldId;
            }

            return holdByStepKey;
        }

        var scopeOrder = new List<string>();
        var originsByScope =
            new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach ((string key, string scopeJcs) in uncertain)
        {
            if (!originsByScope.TryGetValue(
                    scopeJcs,
                    out List<string>? scopeOrigins))
            {
                scopeOrigins = [];
                originsByScope.Add(scopeJcs, scopeOrigins);
                scopeOrder.Add(scopeJcs);
            }

            scopeOrigins.Add(key);
        }

        foreach (string scopeJcs in scopeOrder)
        {
            List<string> scopeOrigins = originsByScope[scopeJcs];
            string holdId = InstallHold(
                context,
                identity.Rsid,
                scopeJcs,
                scopeOrigins,
                now);
            if (requireExactOrigins)
                RequireExactDecisionHold(context, identity.Rsid, scopeJcs, scopeOrigins, holdId);
            foreach (string key in scopeOrigins)
            {
                holdByStepKey[key] = holdId;
            }
        }

        return holdByStepKey;
    }

    private static bool AllStepsStillReceived(
        RbpJournalWriteContext context,
        RbpBatchIdentity identity)
    {
        for (int index = 0; index < identity.Steps.Count; index++)
        {
            RbpInvocationIdentity stepIdentity =
                StepInvocationIdentity(identity, index);
            RbpStoredInvocation row =
                ReadInvocation(context, stepIdentity.IdempotencyKey) ??
                throw MissingStepRow();
            RequireIdenticalIdentity(row.Identity, stepIdentity);
            if (row.State != RbpInvocationState.Received)
            {
                return false;
            }
        }

        return true;
    }

    private static void TerminalizeEnvironmentRead(
        RbpJournalWriteContext context,
        RbpInvocationIdentity identity,
        long now,
        string? applicationFaultClass = null)
    {
        (string outcomeJson, string outcomeDigest) =
            applicationFaultClass is null ? BuildEnvironmentReadOutcome() :
                BuildApplicationReadOutcome(applicationFaultClass);
        using SqliteCommand update = context.CreateCommand(
            """
            UPDATE rbp_invocations
            SET state='failed',
                terminal_outcome_json=$outcome,
                result_digest=$digest,
                finished_at_ms=$now
            WHERE idempotency_key=$key
              AND state IN ('received','executing');
            """);
        update.Parameters.AddWithValue("$outcome", outcomeJson);
        update.Parameters.AddWithValue("$digest", outcomeDigest);
        update.Parameters.AddWithValue("$now", now);
        update.Parameters.AddWithValue("$key", identity.IdempotencyKey);
        if (update.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The unavailable batch read could not be terminalized.");
        }
    }

    private static (string Json, string Digest) BuildEnvironmentReadOutcome()
    {
        // Frozen spec ~985: failed with retryable `environment`,
        // outcome:"known", verification_required:false; never a synthetic
        // success.
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("error");
            writer.WriteStartObject();
            writer.WriteString("fault_class", "environment");
            writer.WriteString(
                "message",
                "The atomic batch terminal carrier was lost before this " +
                "read result became durable.");
            writer.WriteString("outcome", "known");
            writer.WriteBoolean("retryable", true);
            writer.WriteBoolean("verification_required", false);
            writer.WriteEndObject();
            writer.WriteString("status", "failed");
            writer.WriteEndObject();
        }

        using JsonDocument built = JsonDocument.Parse(buffer.ToArray());
        return (
            Rfc8785Json.Canonicalize(built.RootElement),
            Rfc8785Json.Sha256Digest(built.RootElement));
    }

    private static (string Json, string Digest) BuildApplicationReadOutcome(string faultClass)
    {
        JsonElement body = JsonSerializer.SerializeToElement(new
        {
            status = "failed",
            effect_state = "read_only",
            error = new
            {
                fault_class = faultClass,
                message = "The add-in atomic response reported an application failure or was unusable.",
                outcome = "known",
                retryable = false,
                verification_required = false,
            },
        });
        return (Rfc8785Json.Canonicalize(body), Rfc8785Json.Sha256Digest(body));
    }

    private static (string Json, string Digest) BuildDispatchLossOutcome(
        RbpBatchIdentity identity,
        bool anyIndeterminateMutation,
        IReadOnlyList<string> holdIds,
        int? firstNonSuccess)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteBoolean("atomic", true);
            writer.WriteString("batch_id", identity.BatchId);
            if (firstNonSuccess is { } failedIndex)
            {
                writer.WriteNumber("failed_step_index", failedIndex);
            }
            else
            {
                writer.WriteNull("failed_step_index");
            }

            if (anyIndeterminateMutation)
            {
                // Spec ~986-989: the aggregate batch and transaction stay
                // indeterminate whenever a possibly executed mutating step
                // exists.
                writer.WriteString("outcome", "indeterminate");
                writer.WriteBoolean("retryable", false);
                writer.WriteString("status", "indeterminate");
                writer.WriteString("transaction_state", "indeterminate");
                writer.WritePropertyName("verification_hold_ids");
                writer.WriteStartArray();
                foreach (string holdId in holdIds)
                {
                    writer.WriteStringValue(holdId);
                }

                writer.WriteEndArray();
                writer.WriteBoolean("verification_required", true);
            }
            else
            {
                // Spec ~990-994: the all-read atomic missing carrier is the
                // known environment failure with a rolled-back transaction.
                writer.WriteString("status", "failed");
                writer.WriteString("transaction_state", "rolled_back");
            }

            writer.WriteEndObject();
        }

        using JsonDocument built = JsonDocument.Parse(buffer.ToArray());
        return (
            Rfc8785Json.Canonicalize(built.RootElement),
            Rfc8785Json.Sha256Digest(built.RootElement));
    }

    private static void AppendDistinct(List<string> values, string? value)
    {
        if (value is not null &&
            !values.Contains(value, StringComparer.Ordinal))
        {
            values.Add(value);
        }
    }

    private static void InsertBatchRow(
        RbpJournalWriteContext context,
        RbpBatchIdentity identity,
        string stepsJcs,
        long now)
    {
        using SqliteCommand insert = context.CreateCommand(
            """
            INSERT INTO rbp_batches(
              batch_key,rsid,batch_id,batch_digest,atomic,timeout_ms,
              recovery_clearances_jcs,steps_jcs,step_count,state,
              created_at_ms)
            VALUES(
              $key,$rsid,$batch_id,$digest,$atomic,$timeout,
              $clearances,$steps,$count,'received',$now);
            """);
        insert.Parameters.AddWithValue("$key", identity.BatchKey);
        insert.Parameters.AddWithValue("$rsid", identity.Rsid);
        insert.Parameters.AddWithValue("$batch_id", identity.BatchId);
        insert.Parameters.AddWithValue("$digest", identity.BatchDigest);
        insert.Parameters.AddWithValue(
            "$atomic",
            identity.Atomic ? 1 : 0);
        insert.Parameters.AddWithValue(
            "$timeout",
            identity.TimeoutMilliseconds);
        insert.Parameters.AddWithValue(
            "$clearances",
            identity.RecoveryClearancesJcs);
        insert.Parameters.AddWithValue("$steps", stepsJcs);
        insert.Parameters.AddWithValue("$count", identity.Steps.Count);
        insert.Parameters.AddWithValue("$now", now);
        if (insert.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The batch journal did not accept the coordination row.");
        }
    }

    private static void UpdateBatchTerminal(
        RbpJournalWriteContext context,
        string batchKey,
        string outcomeJson,
        string resultDigest,
        long now)
    {
        using SqliteCommand update = context.CreateCommand(
            """
            UPDATE rbp_batches
            SET state='terminal',
                terminal_outcome_json=$outcome,
                result_digest=$digest,
                finished_at_ms=$now
            WHERE batch_key=$key AND state IN ('received','dispatched');
            """);
        update.Parameters.AddWithValue("$outcome", outcomeJson);
        update.Parameters.AddWithValue("$digest", resultDigest);
        update.Parameters.AddWithValue("$now", now);
        update.Parameters.AddWithValue("$key", batchKey);
        if (update.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "The batch left its non-terminal state before the terminal " +
                "outcome could be persisted.");
        }
    }

    private static void RequireIdenticalBatch(
        RbpStoredBatch stored,
        RbpBatchIdentity incoming,
        string stepsJcs)
    {
        bool identical =
            string.Equals(
                stored.BatchDigest,
                incoming.BatchDigest,
                StringComparison.Ordinal) &&
            stored.Atomic == incoming.Atomic &&
            stored.TimeoutMilliseconds == incoming.TimeoutMilliseconds &&
            string.Equals(
                stored.RecoveryClearancesJcs,
                incoming.RecoveryClearancesJcs,
                StringComparison.Ordinal) &&
            string.Equals(
                stored.StepsJcs,
                stepsJcs,
                StringComparison.Ordinal) &&
            stored.StepCount == incoming.Steps.Count;
        if (!identical)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "The batch id was redelivered with a changed digest, " +
                "atomic flag, timeout, clearance, or step element; a " +
                "changed batch cannot be repaired by inference.");
        }
    }

    private static RbpStoredBatch? ReadBatch(
        RbpJournalWriteContext context,
        string batchKey)
    {
        using SqliteCommand command = context.CreateCommand(
            $"""
             SELECT {BatchColumns}
             FROM rbp_batches
             WHERE batch_key=$key;
             """);
        command.Parameters.AddWithValue("$key", batchKey);
        return MaterializeBatch(command);
    }

    private static RbpStoredBatch? MaterializeBatch(SqliteCommand command)
    {
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        return new RbpStoredBatch(
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetInt64(4) == 1,
            reader.GetInt64(5),
            reader.GetString(6),
            reader.GetString(7),
            reader.GetInt64(8),
            FromStorageBatchState(reader.GetString(9)),
            reader.IsDBNull(10) ? null : reader.GetString(10),
            reader.IsDBNull(11) ? null : reader.GetString(11),
            reader.GetInt64(12),
            reader.IsDBNull(13) ? null : reader.GetInt64(13),
            reader.IsDBNull(14) ? null : reader.GetInt64(14));
    }

    private static RbpBatchState FromStorageBatchState(string state) =>
        state switch
        {
            "received" => RbpBatchState.Received,
            "dispatched" => RbpBatchState.Dispatched,
            "terminal" => RbpBatchState.Terminal,
            _ => throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The batch journal holds an unknown state."),
        };

    private static RbpInvocationIdentity StepInvocationIdentity(
        RbpBatchIdentity batch,
        int index)
    {
        RbpBatchStepIdentity step = batch.Steps[index];
        return new RbpInvocationIdentity(
            batch.Rsid,
            step.InvocationId,
            step.Method,
            step.Mutating,
            step.MutationScopeJcs,
            step.ParamsDigest,
            BuildPolicyJcs(step),
            batch.RecoveryClearancesJcs,
            batch.BatchId,
            index);
    }

    private static string BuildPolicyJcs(RbpBatchStepIdentity step)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("class", step.PolicyClass);
            if (step.ConfirmationId is null)
            {
                writer.WriteNull("confirmation_id");
            }
            else
            {
                writer.WriteString("confirmation_id", step.ConfirmationId);
            }

            writer.WriteString("decision", step.Decision);
            writer.WriteEndObject();
        }

        using JsonDocument built = JsonDocument.Parse(buffer.ToArray());
        return Rfc8785Json.Canonicalize(built.RootElement);
    }

    private static string BuildStepsJcs(RbpBatchIdentity identity)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            foreach (RbpBatchStepIdentity step in identity.Steps)
            {
                writer.WriteStartObject();
                writer.WriteString("invocation_id", step.InvocationId);
                writer.WriteString("method", step.Method);
                writer.WriteBoolean("mutating", step.Mutating);
                writer.WritePropertyName("mutation_scope");
                if (step.MutationScopeJcs is null)
                {
                    writer.WriteNullValue();
                }
                else
                {
                    using JsonDocument scope =
                        JsonDocument.Parse(step.MutationScopeJcs);
                    scope.RootElement.WriteTo(writer);
                }

                writer.WriteString("params_digest", step.ParamsDigest);
                writer.WritePropertyName("policy");
                writer.WriteStartObject();
                writer.WriteString("class", step.PolicyClass);
                if (step.ConfirmationId is null)
                {
                    writer.WriteNull("confirmation_id");
                }
                else
                {
                    writer.WriteString(
                        "confirmation_id",
                        step.ConfirmationId);
                }

                writer.WriteString("decision", step.Decision);
                writer.WriteEndObject();
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
        }

        using JsonDocument built = JsonDocument.Parse(buffer.ToArray());
        return Rfc8785Json.Canonicalize(built.RootElement);
    }

    private static void VerifyBatchDigestBinding(RbpBatchIdentity identity)
    {
        // Spec ~882-884, ~1071-1075: the Section 11 canonical batch_digest
        // is recomputed and verified before any coordination or step row is
        // created; a coordination row never binds a digest that disagrees
        // with its own bound elements.
        string recomputed;
        try
        {
            recomputed = Rfc8785Json.MakeBatchDigest(ToDigestInput(identity));
        }
        catch (RbpFrameException exception)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "The batch semantics are not canonical RFC 8785 material.",
                exception);
        }

        if (!string.Equals(
                recomputed,
                identity.BatchDigest,
                StringComparison.Ordinal))
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "The supplied batch_digest does not bind these batch " +
                "semantics.");
        }
    }

    private static RbpBatchDigestInput ToDigestInput(
        RbpBatchIdentity identity)
    {
        var steps = new List<RbpBatchDigestStep>(identity.Steps.Count);
        foreach (RbpBatchStepIdentity step in identity.Steps)
        {
            steps.Add(
                new RbpBatchDigestStep(
                    step.InvocationId,
                    step.Method,
                    step.Mutating,
                    ParseJsonElement(step.MutationScopeJcs ?? "null"),
                    step.ParamsDigest,
                    new RbpBatchDigestPolicy(
                        step.PolicyClass,
                        step.ConfirmationId,
                        step.Decision)));
        }

        var clearances = new List<JsonElement>();
        using (JsonDocument document =
               JsonDocument.Parse(identity.RecoveryClearancesJcs))
        {
            foreach (JsonElement item in
                     document.RootElement.EnumerateArray())
            {
                clearances.Add(item.Clone());
            }
        }

        return new RbpBatchDigestInput(
            identity.Atomic,
            identity.BatchId,
            clearances.AsReadOnly(),
            steps.AsReadOnly(),
            identity.TimeoutMilliseconds);
    }

    private static RbpBatchIdentity NormalizeBatchIdentity(
        RbpBatchIdentity identity)
    {
        // Spec ~1104-1105: harmless JSON property order or escape
        // reserialization that yields the same RFC 8785 value is not a
        // mismatch, so every bound JSON element is canonicalized once here.
        try
        {
            using JsonDocument clearances =
                JsonDocument.Parse(identity.RecoveryClearancesJcs);
            if (clearances.RootElement.ValueKind != JsonValueKind.Array)
            {
                throw new ArgumentException(
                    "recovery_clearances must be a JSON array.",
                    nameof(identity));
            }

            string clearancesJcs =
                Rfc8785Json.Canonicalize(clearances.RootElement);
            var steps =
                new List<RbpBatchStepIdentity>(identity.Steps.Count);
            foreach (RbpBatchStepIdentity step in identity.Steps)
            {
                if (step.MutationScopeJcs is null)
                {
                    steps.Add(step);
                    continue;
                }

                steps.Add(
                    step with
                    {
                        MutationScopeJcs = Rfc8785Json.Canonicalize(
                            ParseJsonElement(step.MutationScopeJcs)),
                    });
            }

            return identity with
            {
                RecoveryClearancesJcs = clearancesJcs,
                Steps = steps.AsReadOnly(),
            };
        }
        catch (JsonException exception)
        {
            throw new ArgumentException(
                "Batch identity JSON elements must be well-formed.",
                nameof(identity),
                exception);
        }
    }

    private static JsonElement ParseJsonElement(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static IReadOnlyList<string> MutatingScopes(
        RbpBatchIdentity identity)
    {
        var scopes = new List<string>();
        foreach (RbpBatchStepIdentity step in identity.Steps)
        {
            if (step.MutationScopeJcs is { } scope &&
                !scopes.Contains(scope, StringComparer.Ordinal))
            {
                scopes.Add(scope);
            }
        }

        return scopes;
    }

    private static void ValidateBatchIdentity(RbpBatchIdentity identity)
    {
        ValidateIdentifier(identity.Rsid, nameof(identity), 256);
        ValidateIdentifier(identity.BatchId, nameof(identity), 36);
        if (identity.BatchId.Length != 36)
        {
            throw new ArgumentException(
                "A batch id must be exactly 36 characters.",
                nameof(identity));
        }

        RequireSha256(identity.BatchDigest, nameof(identity));
        if (identity.TimeoutMilliseconds < 1 ||
            identity.TimeoutMilliseconds >
            RbpProtocolLimits.MaximumSafeInteger)
        {
            throw new ArgumentException(
                "A batch timeout must be a positive JSON-safe integer.",
                nameof(identity));
        }

        ArgumentException.ThrowIfNullOrWhiteSpace(
            identity.RecoveryClearancesJcs);
        if (identity.Steps is not { Count: > 0 })
        {
            throw new ArgumentException(
                "A batch requires at least one step.",
                nameof(identity));
        }

        var invocationIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (RbpBatchStepIdentity step in identity.Steps)
        {
            ValidateIdentifier(step.InvocationId, nameof(identity), 36);
            if (step.InvocationId.Length != 36)
            {
                throw new ArgumentException(
                    "A step invocation id must be exactly 36 characters.",
                    nameof(identity));
            }

            ArgumentException.ThrowIfNullOrWhiteSpace(step.Method);
            ArgumentException.ThrowIfNullOrWhiteSpace(step.PolicyClass);
            ArgumentException.ThrowIfNullOrWhiteSpace(step.Decision);
            RequireSha256(step.ParamsDigest, nameof(identity));
            if (step.Mutating !=
                (step.MutationScopeJcs is { Length: > 0 }))
            {
                throw new ArgumentException(
                    "mutation_scope is null exactly for a read step.",
                    nameof(identity));
            }

            if (!invocationIds.Add(step.InvocationId))
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.ProtocolConflict,
                    "Every batch step requires its own canonical " +
                    "idempotency key; duplicate step invocation ids cannot " +
                    "be repaired by inference.");
            }
        }
    }

    private static void ValidateBatchClearances(
        RbpBatchIdentity identity,
        IReadOnlyList<RbpRecoveryClearance> clearances)
    {
        if (clearances.Count == 0)
        {
            return;
        }

        bool anyMutating = false;
        foreach (RbpBatchStepIdentity step in identity.Steps)
        {
            if (step.Mutating)
            {
                anyMutating = true;
                break;
            }
        }

        if (!anyMutating)
        {
            throw ClearanceFault(
                "only the one evidence-bound envelope with a mutating step " +
                "may carry recovery clearances");
        }

        ValidateClearanceEnvelopeShapes(clearances);
    }

    private static RbpJournalException MissingStepRow() =>
        new(
            RbpJournalErrorCode.IntegrityCheckFailed,
            "A bound batch step journal row is missing while its batch is " +
            "not terminal; the batch cannot be reconstructed from a " +
            "prefix.");
}
