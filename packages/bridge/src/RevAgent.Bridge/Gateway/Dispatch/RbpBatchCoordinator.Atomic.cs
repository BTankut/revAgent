using System.Text.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// The frozen Appendix A.4 <c>atomic:true</c> half: one length-prefixed
/// <c>execute_batch</c> dispatch, its response verification, and the
/// indeterminate classification that a contradictory response produces.
/// </summary>
internal sealed partial class RbpBatchCoordinator
{
    private const string ExecuteBatchMethod = "execute_batch";

    private const string RollbackPolicy = "rollback_on_non_success";

    private const int BatchContractVersion = 1;

    /// <summary>
    /// Spec ~904, ~1760-1806: with <c>batch_atomic</c> granted, the whole
    /// batch is one framed <c>execute_batch</c> request that the add-in runs
    /// under one Revit <c>TransactionGroup</c>.
    /// </summary>
    private async Task<RbpInvocationAnswer> ExecuteAtomicAsync(
        RbpBatchRequest request,
        RbpBatchCapability capability,
        CancellationToken cancellationToken)
    {
        if (!_decisionQuarantine.TryReserve(request.Rsid))
            throw new RbpDispatchException(RbpDispatchErrorCode.Environment,
                "The bounded dispatch-decision owner is unavailable.");
        await EnsureBatchDispatchedAsync(request, cancellationToken)
            .ConfigureAwait(false);

        RbpAddinOutcome outcome;
        try
        {
            outcome = await _channel
                .InvokeAsync(
                    request.Rsid,
                    new AddinCall(
                        // Appendix A.4: the outer JSON-RPC id MUST equal
                        // params.batchId.
                        request.BatchId,
                        ExecuteBatchMethod,
                        BuildExecuteBatchParameters(request, capability),
                        request.Timeout),
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            outcome = new RbpAddinOutcome(RbpAddinOutcomeKind.PossiblyDispatched,
                default, [], 0, 0, Message: exception.Message);
        }

        outcome = outcome.ConservativeClassification();
        _decisionQuarantine.Own(request.Rsid, outcome.Lease);
        bool durableDecisionProven = false;
        try
        {
            RbpInvocationAnswer answer = outcome.Kind switch
            {
                // The add-in batch envelope carries its own `status`, so a
                // clean guarded rollback reaches the channel as a guarded
                // result. Both kinds carry the same success envelope.
                RbpAddinOutcomeKind.Completed or
                    RbpAddinOutcomeKind.Guarded =>
                    await MapAtomicEnvelopeAsync(request, outcome)
                        .ConfigureAwait(false),

                // Only the independently validated native atomic envelope can
                // prove rollback. An application code or nested caller claim cannot.
                RbpAddinOutcomeKind.ApplicationError when IsValidatedAtomicRollback(request, outcome.Result) =>
                    await MapAtomicEnvelopeAsync(request, outcome).ConfigureAwait(false),

                // Only a proven bridge/transport no-send refusal establishes
                // zero executed steps. A JSON-RPC error is not that proof.
                RbpAddinOutcomeKind.KnownNotDispatched =>
                    await CleanAtomicRejectionAsync(request, outcome)
                        .ConfigureAwait(false),

                // Transport success is never commit evidence, and loss of
                // the socket or process before a valid terminal response is
                // promoted to the Section 11/12 indeterminate path.
                _ => await IndeterminateDispatchedBatchAsync(
                            request,
                            outcome.Message ??
                                "The atomic batch dispatch outcome is " +
                                "unknown.",
                            outcome.Kind == RbpAddinOutcomeKind.ApplicationError || outcome.Retryable == false
                                ? outcome.FaultClass ?? "revit_api" : null)
                        .ConfigureAwait(false),
            };
            durableDecisionProven = true;
            return answer;
        }
        finally
        {
            if (durableDecisionProven)
                _decisionQuarantine.ReleaseProven(request.Rsid, outcome.Lease);
        }
    }

    private static JObject BuildExecuteBatchParameters(
        RbpBatchRequest request,
        RbpBatchCapability capability)
    {
        var steps = new JArray();
        foreach (RbpBatchStepRequest step in request.Steps)
        {
            steps.Add(
                new JObject
                {
                    ["index"] = step.Index,
                    ["invocationId"] = step.InvocationId,
                    ["method"] = step.Method,
                    ["params"] = JObject.Parse(
                        step.Parameters.GetRawText()),

                    // The digests are copied for correlation with the
                    // already-verified RBP request; they do not replace raw
                    // params and do not move Section 12.1 digest authority
                    // into the add-in.
                    ["paramsDigest"] = step.ParametersDigest,
                    ["effect"] =
                        capability.Descriptor(step.Method)?.Effect ??
                        throw new RbpDispatchException(
                            RbpDispatchErrorCode.Protocol,
                            "An atomic batch step left the probed " +
                            "descriptor set before dispatch."),
                });
        }

        return new JObject
        {
            ["batchContractVersion"] = BatchContractVersion,
            ["batchId"] = request.BatchId,
            ["batchDigest"] = request.BatchDigest,
            ["atomic"] = true,
            ["rollbackPolicy"] = RollbackPolicy,

            // MUST equal the connection-negotiated RBP max_result_bytes and
            // is the authoritative aggregate response cap for this dispatch.
            ["maxAggregateResultBytes"] =
                capability.MaximumAggregateResultBytes,
            ["steps"] = steps,
        };
    }

    private static bool IsValidatedAtomicRollback(RbpBatchRequest request, JsonElement result) =>
        // TryReadEnvelope validates correlation, ordered members, failure
        // index and an attempted/succeeded rollback matching that failure.
        // A valid completed/committed matrix is NOT an application-error
        // escape hatch: the outer failure still makes its effect uncertain.
        TryReadEnvelope(request, result, out AtomicEnvelope? envelope, out _) &&
        envelope is
        {
            TransactionState: RbpBatchTransactionState.RolledBack,
            Status: RbpBatchStepStatus.Failed or RbpBatchStepStatus.Guarded,
        };

    /// <summary>
    /// Maps a verified add-in batch envelope onto the Section 11.1 carrier.
    /// </summary>
    /// <remarks>
    /// Spec ~1830-1834: the bridge verifies request/response batch id,
    /// digest, step count, contiguous indices, invocation ids, methods,
    /// failure index, rollback trigger, and the prefix/suffix state machine
    /// before journaling a terminal RBP batch. A malformed or contradictory
    /// response cannot be repaired by inference and becomes an indeterminate
    /// dispatched batch.
    /// </remarks>
    private async Task<RbpInvocationAnswer> MapAtomicEnvelopeAsync(
        RbpBatchRequest request,
        RbpAddinOutcome outcome)
    {
        if (!TryReadEnvelope(
                request,
                outcome.Result,
                out AtomicEnvelope? envelope,
                out string contradiction))
        {
            return await IndeterminateDispatchedBatchAsync(
                    request,
                    contradiction)
                .ConfigureAwait(false);
        }

        // A reported rollback failure is indeterminate: every possibly
        // executed mutation stays in doubt and no step may retain a
        // committed, rolled-back, or visible-result claim.
        if (string.Equals(
                envelope!.Status,
                RbpBatchStepStatus.Indeterminate,
                StringComparison.Ordinal))
        {
            return await IndeterminateDispatchedBatchAsync(
                    request,
                    envelope.RollbackError ??
                        "The add-in reported a failed TransactionGroup " +
                        "rollback.")
                .ConfigureAwait(false);
        }

        var steps = new List<RbpBatchStepOutcome>(request.Steps.Count);
        foreach (AtomicStep step in envelope.Steps)
        {
            JsonElement evidence = StepEvidence(step);
            if (!string.Equals(
                    step.ExecutionState,
                    RbpBatchStepStatus.NotStarted,
                    StringComparison.Ordinal))
            {
                await _journal
                    .PersistBatchStepDecisionAsync(
                        request.ToIdentity(), step.Index,
                        new RbpInvocationTerminal(
                            ToInvocationState(step.ExecutionState),
                            evidence,
                            Rfc8785Json.Sha256Digest(evidence)),
                        DurableDecisionToken)
                    .ConfigureAwait(false);
            }

            steps.Add(
                new RbpBatchStepOutcome(
                    step.Index,
                    step.InvocationId,
                    evidence,
                    Replayed: false));
        }

        return await TerminalizeAtomicAsync(
                request,
                envelope.Status,
                envelope.TransactionState,
                envelope.FailedStepIndex,
                steps,
                replayed: false)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// A proven pre-dispatch refusal: zero steps executed, nothing committed.
    /// </summary>
    private async Task<RbpInvocationAnswer> CleanAtomicRejectionAsync(
        RbpBatchRequest request,
        RbpAddinOutcome outcome)
    {
        var steps = new List<RbpBatchStepOutcome>(request.Steps.Count);
        for (int index = 0; index < request.Steps.Count; index++)
        {
            RbpBatchStepRequest step = request.Steps[index];
            if (index > 0)
            {
                steps.Add(NotStarted(request, index));
                continue;
            }

            JsonElement evidence = RbpBatchPayloads.ErrorEvidence(
                RbpBatchStepStatus.Failed,
                RbpBatchPayloads.NestedError(
                    RbpInvocationPayloads.KnownError(
                        step.InvocationId,
                        outcome.FaultClass ?? "revit_api",
                        Retryable(
                            outcome.FaultClass ?? "revit_api",
                            step.Mutating),
                        outcome.Message ??
                            "The add-in rejected the atomic batch before " +
                            "opening its TransactionGroup.",
                        outcome.AddinError),
                    replayed: false),
                step.Mutating ? "not_committed" : "read_only");
            await _journal
                .PersistBatchStepDecisionAsync(
                    request.ToIdentity(), index,
                    new RbpInvocationTerminal(
                        RbpInvocationState.Failed,
                        evidence,
                        Rfc8785Json.Sha256Digest(evidence)),
                    DurableDecisionToken)
                .ConfigureAwait(false);
            steps.Add(
                new RbpBatchStepOutcome(
                    index,
                    step.InvocationId,
                    evidence,
                    Replayed: false));
        }

        return await TerminalizeAtomicAsync(
                request,
                RbpBatchStepStatus.Failed,
                RbpBatchTransactionState.RolledBack,
                failedStepIndex: 0,
                steps,
                replayed: false)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Spec ~986-994, ~1123-1131: dispatch may have started and the complete
    /// add-in terminal carrier is unavailable.
    /// </summary>
    /// <remarks>
    /// Every possibly executed mutating step stays
    /// <c>journal_indeterminate</c> with its Section 6.2.1 hold, and every
    /// unavailable read is the narrow known <c>environment</c> failure, never
    /// a synthetic success. The aggregate stays indeterminate whenever such a
    /// mutating step exists; an all-read batch uses the
    /// <c>failed</c>/<c>rolled_back</c> carrier, the only atomic carrier that
    /// may contain more than one non-success step instead of a
    /// <c>not_started</c> suffix.
    /// </remarks>
    private async Task<RbpInvocationAnswer> IndeterminateDispatchedBatchAsync(
        RbpBatchRequest request,
        string reason,
        string? applicationFaultClass = null)
    {
        RbpBatchAdmissionResult decision = await _journal.PersistAtomicDispatchFailureAsync(
            request.ToIdentity(), applicationFaultClass, DurableDecisionToken).ConfigureAwait(false);
        JsonElement aggregate = RequireBatchOutcome(decision.Stored);
        RbpBatchStepOutcome[] steps = decision.Steps.Select(step => FromStoredRow(
            step.BatchIndex, step.InvocationId,
            step.Stored ?? throw new RbpDispatchException(RbpDispatchErrorCode.Environment,
                "The grouped durable decision is missing a member."),
            replayed: false)).ToArray();
        return RbpInvocationAnswer.Result(RbpBatchPayloads.Carrier(
            request.BatchId, atomic: true,
            ReadRequiredString(aggregate, "status"),
            ReadRequiredString(aggregate, "transaction_state"),
            ReadNullableInt32(aggregate, "failed_step_index"),
            steps, replayed: false));
    }

    private async Task<RbpInvocationAnswer> TerminalizeAtomicAsync(
        RbpBatchRequest request,
        string status,
        string transactionState,
        int? failedStepIndex,
        IReadOnlyList<RbpBatchStepOutcome> steps,
        bool replayed)
    {
        JsonElement carrier = RbpBatchPayloads.Carrier(
            request.BatchId,
            atomic: true,
            status,
            transactionState,
            failedStepIndex,
            steps,
            replayed);
        await _journal.PersistBatchTerminalAsync(
            request.BatchKey,
            new RbpBatchTerminal(carrier, Rfc8785Json.Sha256Digest(carrier)),
            DurableDecisionToken, expectedIdentity: request.ToIdentity()).ConfigureAwait(false);

        return RbpInvocationAnswer.Result(carrier);
    }

    private static JsonElement StepEvidence(AtomicStep step)
    {
        if (string.Equals(
                step.ExecutionState,
                RbpBatchStepStatus.NotStarted,
                StringComparison.Ordinal))
        {
            return RbpBatchPayloads.NotStartedEvidence();
        }

        if (step.Error is { } error)
        {
            return RbpBatchPayloads.ErrorEvidence(
                step.ExecutionState,
                RbpBatchPayloads.NestedError(
                    RbpInvocationPayloads.KnownError(
                        step.InvocationId,
                        FaultClassFor(step.ErrorCode),
                        retryable: false,
                        step.ErrorMessage ??
                            "The add-in reported a bounded batch step " +
                            "failure.",
                        new AddinErrorDetail(0, error.GetRawText())),
                    replayed: false),
                step.EffectState,
                step.GuardedReason);
        }

        if (step.ResultSuppressed is { Length: > 0 } suppressed)
        {
            // On rollback neither a rolled-back mutation nor a discarded read
            // result is exposed; the step omits `result` and says why.
            return RbpBatchPayloads.SuppressedEvidence(
                step.ExecutionState,
                step.EffectState,
                suppressed,
                step.GuardedReason);
        }

        return RbpBatchPayloads.SuccessEvidence(
            step.ExecutionState,
            step.Result ?? default,
            step.GuardedReason,
            resultDigest: null,
            step.EffectState);
    }

    private static string FaultClassFor(string? code) => code switch
    {
        "response_payload_limit" => "oversize",
        "invalid_result" => "protocol",
        _ => "revit_api",
    };

    private static RbpInvocationState ToInvocationState(
        string executionState) =>
        executionState switch
        {
            RbpBatchStepStatus.Completed => RbpInvocationState.Completed,
            RbpBatchStepStatus.Guarded => RbpInvocationState.Guarded,
            RbpBatchStepStatus.Cancelled => RbpInvocationState.Cancelled,
            RbpBatchStepStatus.Indeterminate =>
                RbpInvocationState.Indeterminate,
            _ => RbpInvocationState.Failed,
        };

    private async Task EnsureBatchDispatchedAsync(
        RbpBatchRequest request,
        CancellationToken cancellationToken)
    {
        RbpStoredBatch? stored = await _journal
            .GetBatchAsync(request.BatchKey, cancellationToken)
            .ConfigureAwait(false);
        if (stored is { State: RbpBatchState.Received })
        {
            await _journal
                .MarkBatchDispatchedAsync(request.BatchKey, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private static bool TryReadEnvelope(
        RbpBatchRequest request,
        JsonElement result,
        out AtomicEnvelope? envelope,
        out string contradiction)
    {
        envelope = null;
        contradiction = string.Empty;
        if (result.ValueKind != JsonValueKind.Object)
        {
            contradiction = "The execute_batch response is not an object.";
            return false;
        }

        if (!Matches(result, "batchId", request.BatchId) ||
            !Matches(result, "batchDigest", request.BatchDigest))
        {
            contradiction =
                "The execute_batch response does not correlate with the " +
                "dispatched batch identity.";
            return false;
        }

        if (!ReadBoolean(result, "atomic"))
        {
            contradiction =
                "The execute_batch response denies the atomic dispatch it " +
                "answered.";
            return false;
        }

        if (ReadString(result, "status") is not { Length: > 0 } status ||
            ReadString(result, "transactionState") is not
            { Length: > 0 } transactionState)
        {
            contradiction =
                "The execute_batch response is missing its terminal " +
                "status or transaction state.";
            return false;
        }

        if (!result.TryGetProperty("steps", out JsonElement steps) ||
            steps.ValueKind != JsonValueKind.Array ||
            steps.GetArrayLength() != request.Steps.Count)
        {
            contradiction =
                "The execute_batch response step count does not match the " +
                "dispatched batch.";
            return false;
        }

        var parsed = new List<AtomicStep>(request.Steps.Count);
        int index = 0;
        bool suffix = false;
        int? firstNonSuccess = null;
        foreach (JsonElement step in steps.EnumerateArray())
        {
            RbpBatchStepRequest sent = request.Steps[index];
            if (step.ValueKind != JsonValueKind.Object ||
                ReadInt32(step, "index") != index ||
                !Matches(step, "invocationId", sent.InvocationId) ||
                !Matches(step, "method", sent.Method))
            {
                contradiction =
                    "The execute_batch response steps are not the ordered " +
                    "steps that were dispatched.";
                return false;
            }

            string executionState =
                ReadString(step, "executionState") ?? string.Empty;
            if (!IsKnownExecutionState(executionState))
            {
                contradiction =
                    "The execute_batch response carries an unknown step " +
                    "execution state.";
                return false;
            }

            bool notStarted = string.Equals(
                executionState,
                RbpBatchStepStatus.NotStarted,
                StringComparison.Ordinal);
            if (suffix && !notStarted)
            {
                contradiction =
                    "The execute_batch response violates the prefix/suffix " +
                    "state machine: an executed step follows a not_started " +
                    "step.";
                return false;
            }

            suffix |= notStarted;
            if (!string.Equals(
                    executionState,
                    RbpBatchStepStatus.Completed,
                    StringComparison.Ordinal))
            {
                firstNonSuccess ??= index;
            }

            if (string.Equals(
                    executionState,
                    RbpBatchStepStatus.Guarded,
                    StringComparison.Ordinal) &&
                ReadString(step, "guardedReason") is not { Length: > 0 })
            {
                // Section 21 item 38: status guarded requires a valid
                // guarded_reason; an unnamed guard is not a guard.
                contradiction =
                    "A guarded execute_batch step carries no normalized " +
                    "guarded reason.";
                return false;
            }

            parsed.Add(
                new AtomicStep(
                    index,
                    sent.InvocationId,
                    sent.Method,
                    executionState,
                    ReadString(step, "effectState"),
                    step.TryGetProperty("result", out JsonElement stepResult)
                        ? stepResult
                        : null,
                    step.TryGetProperty("error", out JsonElement stepError)
                        ? stepError
                        : null,
                    ReadString(step, "guardedReason"),
                    ReadString(step, "resultSuppressed"),
                    ReadErrorCode(step)));
            index++;
        }

        int? failedStepIndex = ReadNullableInt32(result, "failedStepIndex");
        if (failedStepIndex != firstNonSuccess)
        {
            contradiction =
                "The execute_batch failure index does not identify the " +
                "first non-success step.";
            return false;
        }

        if (!VerifyTerminalMatrix(
                result,
                status,
                transactionState,
                failedStepIndex,
                parsed,
                out contradiction))
        {
            return false;
        }

        envelope = new AtomicEnvelope(
            status,
            transactionState,
            failedStepIndex,
            parsed.AsReadOnly(),
            ReadRollbackError(result));
        return true;
    }

    /// <summary>
    /// The exact Appendix A.4 terminal matrix.
    /// </summary>
    private static bool VerifyTerminalMatrix(
        JsonElement result,
        string status,
        string transactionState,
        int? failedStepIndex,
        IReadOnlyList<AtomicStep> steps,
        out string contradiction)
    {
        contradiction = string.Empty;
        if (!result.TryGetProperty("rollback", out JsonElement rollback) ||
            rollback.ValueKind != JsonValueKind.Object)
        {
            contradiction =
                "The execute_batch response carries no rollback record.";
            return false;
        }

        bool attempted = ReadBoolean(rollback, "attempted");
        bool? succeeded = ReadNullableBoolean(rollback, "succeeded");
        int? triggerIndex = ReadNullableInt32(rollback, "triggerStepIndex");
        string? triggerState = ReadString(rollback, "triggerState");

        switch (status)
        {
            case RbpBatchStepStatus.Completed:
                if (!string.Equals(
                        transactionState,
                        RbpBatchTransactionState.Committed,
                        StringComparison.Ordinal) ||
                    failedStepIndex is not null ||
                    attempted)
                {
                    contradiction =
                        "A completed atomic batch requires a committed " +
                        "transaction, no failure index, and no rollback.";
                    return false;
                }

                foreach (AtomicStep step in steps)
                {
                    if (!string.Equals(
                            step.ExecutionState,
                            RbpBatchStepStatus.Completed,
                            StringComparison.Ordinal))
                    {
                        contradiction =
                            "A completed atomic batch cannot contain a " +
                            "non-completed step.";
                        return false;
                    }
                }

                return true;

            case RbpBatchStepStatus.Guarded:
            case RbpBatchStepStatus.Failed:
                if (!string.Equals(
                        transactionState,
                        RbpBatchTransactionState.RolledBack,
                        StringComparison.Ordinal) ||
                    failedStepIndex is not { } trigger ||
                    !attempted ||
                    succeeded != true ||
                    triggerIndex != trigger ||
                    !string.Equals(
                        triggerState,
                        steps[trigger].ExecutionState,
                        StringComparison.Ordinal) ||
                    !string.Equals(
                        triggerState,
                        status,
                        StringComparison.Ordinal))
                {
                    contradiction =
                        "A clean guarded or failed atomic batch requires a " +
                        "rolled-back transaction whose successful rollback " +
                        "was triggered by the reported step.";
                    return false;
                }

                return true;

            case RbpBatchStepStatus.Indeterminate:
                if (!string.Equals(
                        transactionState,
                        RbpBatchTransactionState.Indeterminate,
                        StringComparison.Ordinal) ||
                    !attempted ||
                    succeeded != false)
                {
                    contradiction =
                        "An indeterminate atomic batch requires an " +
                        "indeterminate transaction and a failed rollback.";
                    return false;
                }

                return true;

            default:
                contradiction =
                    "The execute_batch response carries an unknown " +
                    "terminal status.";
                return false;
        }
    }

    private static bool IsKnownExecutionState(string executionState) =>
        executionState is RbpBatchStepStatus.Completed or
            RbpBatchStepStatus.Guarded or
            RbpBatchStepStatus.Failed or
            RbpBatchStepStatus.Cancelled or
            RbpBatchStepStatus.Indeterminate or
            RbpBatchStepStatus.NotStarted;

    private static string? ReadErrorCode(JsonElement step) =>
        step.TryGetProperty("error", out JsonElement error) &&
        error.ValueKind == JsonValueKind.Object
            ? ReadString(error, "code")
            : null;

    private static string? ReadRollbackError(JsonElement result) =>
        result.TryGetProperty("rollback", out JsonElement rollback) &&
        rollback.ValueKind == JsonValueKind.Object &&
        rollback.TryGetProperty("error", out JsonElement error) &&
        error.ValueKind == JsonValueKind.Object
            ? ReadString(error, "message")
            : null;

    private static bool Matches(
        JsonElement value,
        string name,
        string expected) =>
        string.Equals(ReadString(value, name), expected, StringComparison.Ordinal);

    private static string? ReadString(JsonElement value, string name) =>
        value.TryGetProperty(name, out JsonElement property) &&
        property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;

    private static bool ReadBoolean(JsonElement value, string name) =>
        value.TryGetProperty(name, out JsonElement property) &&
        property.ValueKind == JsonValueKind.True;

    private static bool? ReadNullableBoolean(
        JsonElement value,
        string name) =>
        value.TryGetProperty(name, out JsonElement property)
            ? property.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => null,
            }
            : null;

    private static int ReadInt32(JsonElement value, string name) =>
        value.TryGetProperty(name, out JsonElement property) &&
        property.ValueKind == JsonValueKind.Number &&
        property.TryGetInt32(out int number)
            ? number
            : -1;

    private static int? ReadNullableInt32(JsonElement value, string name) =>
        value.TryGetProperty(name, out JsonElement property) &&
        property.ValueKind == JsonValueKind.Number &&
        property.TryGetInt32(out int number)
            ? number
            : null;

    private sealed record AtomicStep(
        int Index,
        string InvocationId,
        string Method,
        string ExecutionState,
        string? EffectState,
        JsonElement? Result,
        JsonElement? Error,
        string? GuardedReason,
        string? ResultSuppressed,
        string? ErrorCode)
    {
        internal string? ErrorMessage =>
            Error is { ValueKind: JsonValueKind.Object } error
                ? ReadString(error, "message")
                : null;
    }

    private sealed record AtomicEnvelope(
        string Status,
        string TransactionState,
        int? FailedStepIndex,
        IReadOnlyList<AtomicStep> Steps,
        string? RollbackError);
}
