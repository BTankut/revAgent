using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// Executes a frozen Section 11 <c>invoke_batch</c> and builds its Section
/// 11.1 result carrier.
/// </summary>
/// <remarks>
/// <para>
/// This type is the execution half only. Every batch admission, redelivery,
/// and arbitration rule already lives in the Section 12 journal
/// (<see cref="RbpJournalStore.AdmitBatchAsync"/>); the coordinator consumes
/// that decision and never re-derives it. Likewise the single-invocation
/// semantics are not forked: the add-in seam is the same
/// <see cref="IRbpInvocationChannel"/> the single-invocation dispatcher uses,
/// and every Section 15 body is built by
/// <see cref="RbpInvocationPayloads"/>.
/// </para>
/// <para>
/// The frozen ordering it does own is: capability and descriptor gates first,
/// because an <c>unsupported</c> batch must reach neither the journal nor the
/// add-in; then journal admission, which is durable before the first add-in
/// byte; then execution; then the durable terminal outcome before the carrier
/// leaves the bridge.
/// </para>
/// </remarks>
internal sealed partial class RbpBatchCoordinator
{
    /// <summary>
    /// Bounded Section 11.1 carrier overhead the aggregate budget reserves
    /// before the first step runs (spec ~1688-1692).
    /// </summary>
    /// <remarks>
    /// The reservation is deliberately a bounded wrapper/error/not-started
    /// allowance rather than a sum of theoretical per-step maxima, which the
    /// same paragraph forbids because it would turn the aggregate cap into an
    /// artificial batch-length limit.
    /// </remarks>
    private const int CarrierOverheadBytes = 512;

    private const int StepOverheadBytes = 1024;

    /// <summary>
    /// Section 12.1 step 3 must not be cancellable: a cancel arriving between
    /// the add-in answering and the terminal persist would destroy an outcome
    /// that has already happened.
    /// </summary>
    private static readonly CancellationToken DurableDecisionToken =
        CancellationToken.None;

    /// <summary>
    /// Methods that are unconditionally non-batchable in v1 (spec
    /// ~1720-1724). Descriptor-set membership already excludes them; this
    /// list makes the bridge fail closed against an add-in that
    /// misadvertises one instead of trusting the advertisement.
    /// </summary>
    private static readonly HashSet<string> NonBatchableMethods =
        new(StringComparer.Ordinal)
        {
            "mcp_status",
            "get_document_context",
            "execute_batch",
            "send_code_to_revit",
            "activate_view",
            "close_view",
            "clear_selection",
            "open_existing_plan_for_element_level",
            "focus_elements",
            "section_box_elements",
            "create_3d_view_for_elements",
        };

    private static readonly HashSet<string> ReservedParameterNames =
        new(StringComparer.Ordinal)
        {
            "target", "host", "port", "timeoutMs",
            "statusRefreshTimeoutMs", "refreshStatusAfterCommand",
            "responseMode", "transactionMode", "parseJsonResult",
            "taskName", "taskId", "wrapperAction", "logicalToolName",
            "toolName", "parentTaskName", "parentTaskId",
            "suppressTaskStatusWindow", "display", "invocation_id",
            "batch_id", "batch_digest", "params_digest", "mutating",
            "mutation_scope", "policy", "verification",
            "recovery_clearances", "timeout_ms", "batchContractVersion",
            "batchId", "batchDigest", "invocationId", "paramsDigest",
            "effect", "atomic", "rollbackPolicy", "maxAggregateResultBytes",
        };

    private readonly RbpJournalStore _journal;
    private readonly IRbpInvocationChannel _channel;
    private readonly IRbpBatchCapabilitySource _capabilities;

    internal RbpBatchCoordinator(
        RbpJournalStore journal,
        IRbpInvocationChannel channel,
        IRbpBatchCapabilitySource capabilities)
    {
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        _channel = channel ?? throw new ArgumentNullException(nameof(channel));
        _capabilities = capabilities ??
            throw new ArgumentNullException(nameof(capabilities));
    }

    /// <summary>
    /// Answers one <c>invoke_batch</c> payload. A malformed payload becomes
    /// this batch's own terminal Section 15 <c>protocol</c> error rather than
    /// an exception thrown into the connection cycle; no add-in byte is
    /// written and no journal row is reserved on that path.
    /// </summary>
    /// <summary>
    /// Answers a batch refused by the Section 10.1 window: the session already
    /// holds an in-flight invocation or batch, so nothing is journaled and no
    /// add-in byte is written. Mirrors
    /// <see cref="RbpInvocationDispatcher.RejectConcurrent"/> for the batch
    /// carrier shape.
    /// </summary>
    internal static RbpInvocationAnswer RejectConcurrent(JsonElement payload) =>
        BatchFault(
            ReadBatchId(payload),
            faultClass: "protocol",
            "The Section 10.1 dispatch window already holds an in-flight " +
            "invocation for this session; the batch was not dispatched.");

    /// <summary>
    /// Answers a batch that reached a coordinator composed without a batch
    /// execution surface. The frame was already sequenced and acknowledged, so
    /// a terminal <c>unsupported</c> fault is the only honest reply; silence
    /// would leave the Gateway's Section 10.1 window occupied forever.
    /// </summary>
    internal static RbpInvocationAnswer Unavailable(JsonElement payload) =>
        BatchFault(
            ReadBatchId(payload),
            faultClass: "unsupported",
            "This bridge has no batch dispatch surface; no step was " +
            "dispatched.");

    internal async Task<RbpInvocationAnswer> DispatchAsync(
        string rsid,
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        RbpBatchRequest request;
        try
        {
            request = RbpBatchRequest.Parse(rsid, payload);
        }
        catch (RbpDispatchException exception)
            when (exception.ErrorCode == RbpDispatchErrorCode.Protocol)
        {
            return BatchFault(
                ReadBatchId(payload),
                faultClass: "protocol",
                exception.Message);
        }

        return await DispatchAsync(request, cancellationToken)
            .ConfigureAwait(false);
    }

    internal async Task<RbpInvocationAnswer> DispatchAsync(
        RbpBatchRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        foreach (RbpBatchStepRequest step in request.Steps)
        {
            RbpTransactionMode mode =
                RbpMutationOutcomeEvidence.ReadRequestedMode(
                    step.Method,
                    step.Parameters);
            if (step.Mutating &&
                mode == RbpTransactionMode.None &&
                !RbpMutationOutcomeEvidence.HasNativeConformanceDeclaration(
                    step.Parameters))
            {
                return BatchFault(
                    request.BatchId,
                    "protocol",
                    "A mutating transactionMode none batch step requires " +
                    "the exact revagent.mutation-outcome/v1 native " +
                    "outcome-evidence declaration before dispatch.");
            }
        }

        RbpBatchCapability capability = await _capabilities
            .ResolveAsync(request.Rsid, cancellationToken)
            .ConfigureAwait(false);

        // Spec ~912-915: every step, including an atomic:false fan-out step,
        // MUST be in the probed Appendix A.2 descriptor set with
        // resultDelivery:"inline_only", otherwise the bridge returns
        // unsupported before dispatching any step. The gate runs before
        // journal admission so a batch that can never execute leaves no
        // coordination or step row for a later redelivery to arbitrate.
        if (DescriptorGateFailure(request, capability) is { } gate)
        {
            return BatchFault(request.BatchId, "unsupported", gate);
        }

        // Spec ~904-905: with batch_atomic in that rsid's granted session
        // capabilities atomic:true is one framed execute_batch dispatch;
        // without it, atomic:true is terminal unsupported and no step
        // executes.
        if (request.Atomic && !capability.BatchAtomicGranted)
        {
            return BatchFault(
                request.BatchId,
                "unsupported",
                "atomic:true requires the batch_atomic capability granted " +
                "for this rsid; no batch step was executed.");
        }

        if (request.Atomic &&
            ReservedParameterName(request) is { } reserved)
        {
            return BatchFault(
                request.BatchId,
                "parameter",
                $"An atomic batch step carries the reserved parameter " +
                $"'{reserved}', which is a connection, timeout, " +
                "response-mode, display/audit, RBP, or batch-control field " +
                "and is rejected before dispatch.");
        }

        RbpBatchGatedAdmission gated;
        try
        {
            gated = await _journal
                .AdmitBatchOutcomeV3Async(
                    request.ToIdentity(),
                    request.ParseClearances(),
                    TransactionModes(request),
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpJournalException exception)
            when (exception.ErrorCode == RbpJournalErrorCode.ProtocolConflict)
        {
            // Spec ~1102-1105: any changed bound element under the same
            // batch_id is a terminal protocol fault, decided before any
            // add-in byte.
            return BatchFault(request.BatchId, "protocol", exception.Message);
        }
        catch (Exception exception) when (
            exception is RbpFrameException or FormatException ||
            exception is ArgumentException and not ArgumentNullException ||
            (exception is RbpDispatchException dispatch &&
             dispatch.ErrorCode == RbpDispatchErrorCode.Protocol))
        {
            // A clearance envelope or policy binding that cannot become an
            // acceptance input fails closed at this boundary and never
            // reaches the add-in.
            return BatchFault(request.BatchId, "protocol", exception.Message);
        }

        if (gated.BlockingHold is { } hold)
        {
            return BlockedByHold(request, hold);
        }

        RbpBatchAdmissionResult admission =
            gated.Admission ??
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "A batch admission returned neither a decision nor a " +
                "blocking hold.");

        return admission.Admission switch
        {
            RbpBatchAdmission.ReplayTerminal =>
                ReplayTerminal(request, admission),

            // The journal already terminalized this recovery delivery and it
            // executed no add-in step (spec ~1129-1131).
            RbpBatchAdmission.DispatchLossArbitrated =>
                ReplayTerminal(request, admission),

            RbpBatchAdmission.ArbitratedSteps =>
                await ResumeFanOutAsync(
                        request,
                        capability,
                        admission,
                        cancellationToken)
                    .ConfigureAwait(false),

            RbpBatchAdmission.ExecuteFromReceived =>
                await ExecuteAtomicAsync(
                        request,
                        capability,
                        cancellationToken)
                    .ConfigureAwait(false),

            RbpBatchAdmission.Accepted => request.Atomic
                ? await ExecuteAtomicAsync(
                        request,
                        capability,
                        cancellationToken)
                    .ConfigureAwait(false)
                : await ExecuteFanOutAsync(
                        request,
                        capability,
                        cancellationToken)
                    .ConfigureAwait(false),

            _ => throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "The journal returned an unknown batch admission."),
        };
    }

    /// <summary>
    /// Spec ~906-909: an <c>atomic:false</c> first delivery executes by
    /// ordered bridge fan-out, stops at the first
    /// <c>guarded|failed|cancelled|indeterminate</c> step, and reports every
    /// later input step as <c>not_started</c>. No atomicity is claimed.
    /// </summary>
    private async Task<RbpInvocationAnswer> ExecuteFanOutAsync(
        RbpBatchRequest request,
        RbpBatchCapability capability,
        CancellationToken cancellationToken)
    {
        // Durable dispatch ownership before the first add-in byte, so a lost
        // terminal outcome is provably a dispatch loss rather than a batch
        // that never started.
        await EnsureBatchDispatchedAsync(request, cancellationToken)
            .ConfigureAwait(false);

        var outcomes = new List<RbpBatchStepOutcome>(request.Steps.Count);
        long remaining = RemainingAggregateBudget(request, capability);
        bool stopped = false;
        for (int index = 0; index < request.Steps.Count; index++)
        {
            if (stopped)
            {
                outcomes.Add(NotStarted(request, index));
                continue;
            }

            RbpBatchStepOutcome outcome = await ExecuteStepAsync(
                    request,
                    capability,
                    index,
                    remaining,
                    claimDispatchOwnership: true,
                    cancellationToken)
                .ConfigureAwait(false);
            outcomes.Add(outcome);
            remaining -= EvidenceResultBytes(outcome.Evidence);

            // In particular, a guarded step never allows the next step to run
            // merely because it arrived in a result rather than an error.
            stopped = !outcome.IsCompleted;
        }

        return await FinishAsync(request, outcomes, replayed: false)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Spec ~1109-1119: an <c>atomic:false</c> redelivery answers from the
    /// journal's per-step arbitration. Terminal prefix steps replay and are
    /// never re-executed; the one step the journal marked executable runs
    /// once; every ordered successor stays <c>not_started</c>.
    /// </summary>
    private async Task<RbpInvocationAnswer> ResumeFanOutAsync(
        RbpBatchRequest request,
        RbpBatchCapability capability,
        RbpBatchAdmissionResult admission,
        CancellationToken cancellationToken)
    {
        var outcomes = new List<RbpBatchStepOutcome>(request.Steps.Count);
        long remaining = RemainingAggregateBudget(request, capability);
        bool executed = false;
        foreach (RbpBatchStepArbitration step in admission.Steps)
        {
            if (step.Disposition is
                RbpBatchStepDisposition.RetryNonMutating or
                RbpBatchStepDisposition.Accepted)
            {
                if (!executed)
                {
                    await EnsureBatchDispatchedAsync(
                            request,
                            cancellationToken)
                        .ConfigureAwait(false);
                }

                executed = true;

                // Rule 3 resumes a row that is already received or
                // executing. Dispatch ownership was taken on the delivery
                // that stalled, and Section 12.1 makes that claim once-only,
                // so re-asserting it would be refused by the journal.
                RbpBatchStepOutcome ran = await ExecuteStepAsync(
                        request,
                        capability,
                        step.BatchIndex,
                        remaining,
                        claimDispatchOwnership:
                            step.Stored?.State == RbpInvocationState.Received,
                        cancellationToken)
                    .ConfigureAwait(false);
                outcomes.Add(ran);
                remaining -= EvidenceResultBytes(ran.Evidence);
                continue;
            }

            // A replayed step's result still occupies the same aggregate
            // carrier, so it is accounted exactly like an executed one.
            RbpBatchStepOutcome replayedStep = FromArbitration(step);
            outcomes.Add(replayedStep);
            remaining -= EvidenceResultBytes(replayedStep.Evidence);
        }

        // Spec ~1117-1119: batch replayed:true is permitted only when no step
        // executed during this delivery.
        return await FinishAsync(
                request,
                outcomes,
                replayed: admission.ReplayPermitted && !executed)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Executes one ordered step through the same add-in seam the
    /// single-invocation dispatcher uses, under the Section 12.1 durability
    /// ordering: <c>executing</c> before dispatch ownership, the terminal
    /// outcome durable before it can appear in a carrier.
    /// </summary>
    private async Task<RbpBatchStepOutcome> ExecuteStepAsync(
        RbpBatchRequest request,
        RbpBatchCapability capability,
        int index,
        long remainingAggregateBytes,
        bool claimDispatchOwnership,
        CancellationToken cancellationToken)
    {
        RbpBatchStepRequest step = request.Steps[index];
        if (claimDispatchOwnership)
        {
            await _journal
                .MarkInvocationExecutingOutcomeV3Async(
                    request.StepKey(index),
                    RbpMutationOutcomeEvidence.ReadRequestedMode(
                        step.Method,
                        step.Parameters),
                    cancellationToken)
                .ConfigureAwait(false);
        }

        RbpAddinOutcome outcome;
        try
        {
            outcome = await _channel
                .InvokeAsync(
                    request.Rsid,
                    new AddinCall(
                        step.InvocationId,
                        step.Method,
                        JObject.Parse(step.Parameters.GetRawText()),
                        request.Timeout),
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception exception)
            when (exception is not OperationCanceledException)
        {
            // The channel threw rather than reporting dispatch evidence, so
            // non-execution cannot be proved.
            return await TerminalizeUncertainStepAsync(
                    request,
                    index,
                    exception.Message,
                    RbpMutationOutcomeEvidence.Uncertain(
                        RbpDispatchState.MayHaveReachedAddin,
                        RbpMutationOutcomeEvidence.ReadRequestedMode(
                            step.Method,
                            step.Parameters),
                        "batch_channel_exception"))
                .ConfigureAwait(false);
        }

        try
        {
            return outcome.Kind switch
            {
                RbpAddinOutcomeKind.Completed or
                    RbpAddinOutcomeKind.Guarded =>
                    await TerminalizeStepResultAsync(
                            request,
                            capability,
                            index,
                            outcome,
                            remainingAggregateBytes)
                        .ConfigureAwait(false),

                RbpAddinOutcomeKind.KnownNotDispatched =>
                    await TerminalizeKnownStepFailureAsync(
                            request,
                            index,
                            outcome)
                        .ConfigureAwait(false),

                _ when ResolveStepOutcomeEvidence(step, outcome)
                        .KnownNonCommittingError ||
                    (!step.Mutating &&
                     ResolveStepOutcomeEvidence(step, outcome).EffectState ==
                        RbpEffectState.ReadOnly) =>
                    await TerminalizeKnownStepFailureAsync(
                            request,
                            index,
                            outcome)
                        .ConfigureAwait(false),

                _ => await TerminalizeUncertainStepAsync(
                            request,
                            index,
                            outcome.Message ??
                                "The add-in dispatch outcome is unknown.",
                            ResolveStepOutcomeEvidence(step, outcome))
                        .ConfigureAwait(false),
            };
        }
        finally
        {
            // Only after the step's fate is durable; releasing earlier would
            // reopen the add-in session while the outcome lives solely in
            // memory.
            outcome.Lease?.ReleaseAfterDurableDecision();
        }
    }

    private async Task<RbpBatchStepOutcome> TerminalizeStepResultAsync(
        RbpBatchRequest request,
        RbpBatchCapability capability,
        int index,
        RbpAddinOutcome outcome,
        long remainingAggregateBytes)
    {
        RbpBatchStepRequest step = request.Steps[index];
        bool guarded = outcome.Kind == RbpAddinOutcomeKind.Guarded;

        // Spec ~999-1006: an attested inline-only command that nevertheless
        // returns artifact-shaped data or exceeds the remaining negotiated
        // inline budget after dispatch never gets an unreachable spool
        // carrier. The raw payload is neither journaled nor placed on the
        // wire; the step becomes a protocol delivery fault with an explicit
        // effect state and stops all successors.
        if (DeliveryFaultReason(
                capability,
                step,
                outcome.Result,
                remainingAggregateBytes) is { } faultReason)
        {
            JsonElement faultEvidence = RbpBatchPayloads.ErrorEvidence(
                RbpBatchStepStatus.Failed,
                RbpBatchPayloads.NestedError(
                    RbpInvocationPayloads.KnownError(
                        step.InvocationId,
                        faultClass: "protocol",
                        retryable: false,
                        faultReason),
                    replayed: false),
                DeliveryFaultEffectState(step, guarded));
            return await PersistStepAsync(
                    request,
                    index,
                    RbpInvocationState.Failed,
                    faultEvidence,
                    Rfc8785Json.Sha256Digest(faultEvidence),
                    ResolveStepOutcomeEvidence(step, outcome),
                    error: true,
                    faultReason)
                .ConfigureAwait(false);
        }

        JsonElement evidence = RbpBatchPayloads.SuccessEvidence(
            guarded ? RbpBatchStepStatus.Guarded : RbpBatchStepStatus.Completed,
            outcome.Result,
            guarded ? outcome.GuardedReason : null,
            resultDigest: null,
            effectState: step.Mutating ? "committed" : "read_only");

        // Section 10.3 defines result_digest over the exact raw add-in
        // response bytes, so the durable evidence digest is those bytes and
        // not a re-serialization neither peer could reproduce.
        return await PersistStepAsync(
                request,
                index,
                guarded
                    ? RbpInvocationState.Guarded
                    : RbpInvocationState.Completed,
                evidence,
                ResultDigest(outcome.RawResponsePayload),
                ResolveStepOutcomeEvidence(step, outcome),
                error: false,
                message: null)
            .ConfigureAwait(false);
    }

    private async Task<RbpBatchStepOutcome> TerminalizeKnownStepFailureAsync(
        RbpBatchRequest request,
        int index,
        RbpAddinOutcome outcome)
    {
        RbpBatchStepRequest step = request.Steps[index];
        string faultClass = outcome.FaultClass ?? "addin_unreachable";
        JsonElement evidence = RbpBatchPayloads.ErrorEvidence(
            RbpBatchStepStatus.Failed,
            RbpBatchPayloads.NestedError(
                RbpInvocationPayloads.KnownError(
                    step.InvocationId,
                    faultClass,
                    Retryable(faultClass, step.Mutating),
                    outcome.Message ?? "The add-in could not be reached.",
                    outcome.AddinError),
                replayed: false),
            step.Mutating ? "not_committed" : "read_only");
        return await PersistStepAsync(
                request,
                index,
                RbpInvocationState.Failed,
                evidence,
                Rfc8785Json.Sha256Digest(evidence),
                ResolveStepOutcomeEvidence(step, outcome),
                error: true,
                outcome.Message)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// A step whose dispatch cannot be proved either way. Section 15 forbids
    /// labelling an unknown write a retryable environment fault, so a
    /// mutation is promoted to <c>journal_indeterminate</c> with its Section
    /// 6.2.1 scope hold while a read stays a known non-committing failure.
    /// </summary>
    private async Task<RbpBatchStepOutcome> TerminalizeUncertainStepAsync(
        RbpBatchRequest request,
        int index,
        string message,
        RbpMutationOutcomeEvidence outcomeEvidence)
    {
        RbpBatchStepRequest step = request.Steps[index];
        if (!step.Mutating)
        {
            JsonElement readEvidence = RbpBatchPayloads.ErrorEvidence(
                RbpBatchStepStatus.Failed,
                RbpBatchPayloads.NestedError(
                    RbpInvocationPayloads.KnownError(
                        step.InvocationId,
                        faultClass: "environment",
                        retryable: true,
                        message),
                    replayed: false),
                effectState: "read_only");
            return await PersistStepAsync(
                    request,
                    index,
                    RbpInvocationState.Failed,
                    readEvidence,
                    Rfc8785Json.Sha256Digest(readEvidence),
                    NormalizeReadOutcomeEvidence(outcomeEvidence),
                    error: true,
                    message)
                .ConfigureAwait(false);
        }

        // The store mints and installs the hold as part of persisting the
        // indeterminate terminal, and writes its own durable rule 4 evidence
        // body, so no outcome is supplied here.
        string? holdId = await _journal
            .PersistInvocationOutcomeV3Async(
                request.StepKey(index),
                new RbpInvocationTerminal(
                    RbpInvocationState.Indeterminate,
                    Outcome: default,
                    ResultDigest: null),
                outcomeEvidence,
                error: true,
                DurableDecisionToken)
            .ConfigureAwait(false);
        if (holdId is not { Length: > 0 })
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "Persisting an indeterminate batch mutation must install a " +
                "Section 6.2.1 scope hold.");
        }

        return new RbpBatchStepOutcome(
            index,
            step.InvocationId,
            RbpBatchPayloads.ErrorEvidence(
                RbpBatchStepStatus.Indeterminate,
                RbpBatchPayloads.NestedError(
                    RbpInvocationPayloads.JournalIndeterminateError(
                        step.InvocationId,
                        holdId,
                        step.MutationScope,
                        message,
                        replayed: false),
                    replayed: false)),
            Replayed: false);
    }

    private async Task<RbpBatchStepOutcome> PersistStepAsync(
        RbpBatchRequest request,
        int index,
        RbpInvocationState state,
        JsonElement evidence,
        string? resultDigest,
        RbpMutationOutcomeEvidence outcomeEvidence,
        bool error,
        string? message)
    {
        string? holdId = await _journal
            .PersistInvocationOutcomeV3Async(
                request.StepKey(index),
                new RbpInvocationTerminal(state, evidence, resultDigest),
                outcomeEvidence,
                error,
                DurableDecisionToken)
            .ConfigureAwait(false);
        if (holdId is { Length: > 0 })
        {
            RbpBatchStepRequest step = request.Steps[index];
            JsonElement indeterminate = RbpBatchPayloads.ErrorEvidence(
                RbpBatchStepStatus.Indeterminate,
                RbpBatchPayloads.NestedError(
                    RbpInvocationPayloads.JournalIndeterminateError(
                        step.InvocationId,
                        holdId,
                        step.MutationScope,
                        message ??
                            RbpInvocationPayloads
                                .MutationMayHaveExecutedMessage,
                        replayed: false),
                    replayed: false));
            return new RbpBatchStepOutcome(
                index,
                step.InvocationId,
                indeterminate,
                Replayed: false);
        }

        return new RbpBatchStepOutcome(
            index,
            request.Steps[index].InvocationId,
            evidence,
            Replayed: false);
    }

    private static RbpMutationOutcomeEvidence ResolveStepOutcomeEvidence(
        RbpBatchStepRequest step,
        RbpAddinOutcome outcome) =>
        outcome.OutcomeEvidence ??
        RbpMutationOutcomeEvidence.ForLegacyOutcome(
            outcome.Kind,
            RbpMutationOutcomeEvidence.ReadRequestedMode(
                step.Method,
                step.Parameters),
            step.Mutating);

    private static RbpMutationOutcomeEvidence NormalizeReadOutcomeEvidence(
        RbpMutationOutcomeEvidence evidence)
    {
        if (evidence.DispatchState == RbpDispatchState.NotStarted)
        {
            return evidence;
        }

        return new RbpMutationOutcomeEvidence(
            evidence.DispatchState,
            RbpEffectState.ReadOnly,
            evidence.TransactionMode,
            evidence.EvidenceJcs.Replace(
                "\"effectState\":\"unknown\"",
                "\"effectState\":\"read_only\"",
                StringComparison.Ordinal).Replace(
                "\"transactionStatus\":\"unknown\"",
                "\"transactionStatus\":\"read_only\"",
                StringComparison.Ordinal));
    }

    /// <summary>
    /// Builds the Section 11.1 carrier and persists the durable terminal
    /// batch outcome before it reaches the Gateway.
    /// </summary>
    /// <remarks>
    /// A delivery that ended with executed successes and an unexecuted
    /// <c>not_started</c> tail is deliberately not terminalized: spec
    /// ~1114-1116 lets ordered <c>not_started</c> successors execute only
    /// after a recovered step is terminal-successful, which a frozen terminal
    /// batch outcome would make impossible forever.
    /// </remarks>
    private async Task<RbpInvocationAnswer> FinishAsync(
        RbpBatchRequest request,
        IReadOnlyList<RbpBatchStepOutcome> steps,
        bool replayed)
    {
        string status = RbpBatchPayloads.AggregateStatus(steps);
        JsonElement carrier = RbpBatchPayloads.Carrier(
            request.BatchId,
            request.Atomic,

            // Spec ~906-909: an atomic:false fan-out claims no atomicity.
            status,
            RbpBatchTransactionState.NotApplicable,
            RbpBatchPayloads.FirstNonSuccessIndex(steps),
            steps,
            replayed);

        if (IsResumable(steps))
        {
            return RbpInvocationAnswer.Result(carrier);
        }

        RbpStoredBatch? stored = await _journal
            .GetBatchAsync(request.BatchKey, DurableDecisionToken)
            .ConfigureAwait(false);
        if (stored is not null && stored.State != RbpBatchState.Terminal)
        {
            await _journal
                .PersistBatchTerminalAsync(
                    request.BatchKey,
                    new RbpBatchTerminal(
                        carrier,
                        Rfc8785Json.Sha256Digest(carrier)),
                    DurableDecisionToken)
                .ConfigureAwait(false);
        }

        return RbpInvocationAnswer.Result(carrier);
    }

    private static bool IsResumable(IReadOnlyList<RbpBatchStepOutcome> steps)
    {
        bool anyNotStarted = false;
        foreach (RbpBatchStepOutcome step in steps)
        {
            if (string.Equals(
                    step.Status,
                    RbpBatchStepStatus.NotStarted,
                    StringComparison.Ordinal))
            {
                anyNotStarted = true;
                continue;
            }

            if (!step.IsCompleted)
            {
                return false;
            }
        }

        return anyNotStarted;
    }

    private static RbpBatchStepOutcome NotStarted(
        RbpBatchRequest request,
        int index) =>
        new(
            index,
            request.Steps[index].InvocationId,
            RbpBatchPayloads.NotStartedEvidence(),
            Replayed: false);

    private static long RemainingAggregateBudget(
        RbpBatchRequest request,
        RbpBatchCapability capability) =>
        capability.MaximumAggregateResultBytes -
        CarrierOverheadBytes -
        ((long)request.Steps.Count * StepOverheadBytes);

    private static long EvidenceResultBytes(JsonElement evidence) =>
        evidence.ValueKind == JsonValueKind.Object &&
        evidence.TryGetProperty("result", out JsonElement result)
            ? Encoding.UTF8.GetByteCount(Rfc8785Json.Canonicalize(result))
            : 0;

    /// <summary>
    /// The frozen descriptor-set gate (spec ~910-915).
    /// </summary>
    private static string? DescriptorGateFailure(
        RbpBatchRequest request,
        RbpBatchCapability capability)
    {
        foreach (RbpBatchStepRequest step in request.Steps)
        {
            if (NonBatchableMethods.Contains(step.Method))
            {
                return $"'{step.Method}' is unconditionally non-batchable " +
                       "in v1 and can never be nested as a batch step.";
            }

            RbpBatchCommandDescriptor? descriptor =
                capability.Descriptor(step.Method);
            if (descriptor is null)
            {
                return $"'{step.Method}' is not present in the probed " +
                       "Appendix A.2 batchable descriptor set for this " +
                       "session.";
            }

            if (!descriptor.IsInlineOnly)
            {
                return $"'{step.Method}' does not advertise " +
                       "resultDelivery:\"inline_only\"; a nested batch step " +
                       "never uses a Section 13 chunk or artifact carrier.";
            }
        }

        return null;
    }

    private static IReadOnlyList<RbpTransactionMode> TransactionModes(
        RbpBatchRequest request) =>
        Array.AsReadOnly(
            request.Steps
                .Select(step =>
                    RbpMutationOutcomeEvidence.ReadRequestedMode(
                        step.Method,
                        step.Parameters))
                .ToArray());

    /// <summary>
    /// The exact Appendix A.4 reserved-name set (spec ~1772-1782).
    /// </summary>
    /// <remarks>
    /// Rejecting these exact names before dispatch keeps connection,
    /// timeout, response-mode, display/audit, RBP, and add-in batch-control
    /// fields out of an atomic step's functional parameters. It deliberately
    /// does not close the params object to future functional tool
    /// parameters: only this closed set is refused.
    /// </remarks>
    private static string? ReservedParameterName(RbpBatchRequest request)
    {
        foreach (RbpBatchStepRequest step in request.Steps)
        {
            if (step.Parameters.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            foreach (JsonProperty property in
                     step.Parameters.EnumerateObject())
            {
                if (ReservedParameterNames.Contains(property.Name))
                {
                    return property.Name;
                }
            }
        }

        return null;
    }

    /// <summary>
    /// The post-dispatch inline-delivery check for one completed step.
    /// </summary>
    private static string? DeliveryFaultReason(
        RbpBatchCapability capability,
        RbpBatchStepRequest step,
        JsonElement result,
        long remainingAggregateBytes)
    {
        if (IsArtifactShaped(result))
        {
            return "an inline_only-attested command returned " +
                   "artifact-shaped data; no spool carrier is reachable " +
                   "from a batch step.";
        }

        if (result.ValueKind == JsonValueKind.Undefined)
        {
            return null;
        }

        long bytes = Encoding.UTF8.GetByteCount(
            Rfc8785Json.Canonicalize(result));
        long allowed = Math.Min(
            capability.Descriptor(step.Method)?.MaximumInlineResultBytes ??
                0,
            remainingAggregateBytes);
        return bytes > allowed
            ? "the step result exceeds the remaining negotiated inline " +
              "result budget for this batch."
            : null;
    }

    private static string DeliveryFaultEffectState(
        RbpBatchStepRequest step,
        bool guarded)
    {
        if (!step.Mutating)
        {
            return "read_only";
        }

        // When the add-in reported a completed mutation the delivery-fault
        // row keeps effect_state:"committed" rather than becoming a normal
        // replayable success, so a crash cannot run later batch successors
        // and the known model effect is never discarded.
        return guarded ? "not_committed" : "committed";
    }

    /// <summary>
    /// A bounded shape check for the Section 13.1 artifact carrier fields.
    /// </summary>
    private static bool IsArtifactShaped(JsonElement result)
    {
        if (result.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        foreach (JsonProperty property in result.EnumerateObject())
        {
            if (property.NameEquals("artifacts") ||
                property.NameEquals("artifact_id") ||
                property.NameEquals("artifact_index"))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// The frozen Section 15 default retryability for the fault classes a
    /// nested batch step can carry.
    /// </summary>
    /// <remarks>
    /// Only <c>environment</c>, <c>addin_unreachable</c>, and a read
    /// <c>revit_timeout</c> are conditionally retryable; <c>revit_api</c>
    /// means the command executed and answered, so nothing is in doubt and
    /// nothing may be replayed. Retryability is explicit on every nested
    /// error because no parent batch status supplies it by implication.
    /// </remarks>
    private static bool Retryable(string faultClass, bool mutating) =>
        faultClass switch
        {
            "environment" or "addin_unreachable" or "revit_timeout" =>
                !mutating,
            "revit_busy" => true,
            _ => false,
        };

    private static string ResultDigest(byte[] rawResponsePayload) =>
        "sha256:" +
        Convert.ToHexString(SHA256.HashData(rawResponsePayload))
            .ToLowerInvariant();

    private static string ReadBatchId(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty("batch_id", out JsonElement value) &&
        value.ValueKind == JsonValueKind.String &&
        value.GetString() is { Length: > 0 } text
            ? text
            : "00000000-0000-7000-8000-000000000000";

    /// <summary>
    /// A whole batch refused before any step could be dispatched. The Section
    /// 15 body is complete; only <c>invocation_id</c> is absent, because no
    /// step owns this fault.
    /// </summary>
    private static RbpInvocationAnswer BatchFault(
        string batchId,
        string faultClass,
        string message) =>
        RbpInvocationAnswer.Error(
            RbpBatchPayloads.BatchError(
                RbpInvocationPayloads.KnownError(
                    batchId,
                    faultClass,
                    retryable: false,
                    message)));

    /// <summary>
    /// Section 21 item 28: a fresh batch write whose mutation scope conflicts
    /// with an uncleared hold wrote no coordination or step row and is
    /// answered from the blocking hold without add-in contact.
    /// </summary>
    private static RbpInvocationAnswer BlockedByHold(
        RbpBatchRequest request,
        RbpVerificationHold hold)
    {
        using JsonDocument scope = JsonDocument.Parse(hold.ScopeJcs);
        return RbpInvocationAnswer.Error(
            RbpBatchPayloads.BatchError(
                RbpInvocationPayloads.JournalIndeterminateError(
                    request.BatchId,
                    hold.VerificationHoldId,
                    scope.RootElement,
                    RbpInvocationPayloads.MutationMayHaveExecutedMessage,
                    replayed: false)));
    }
}
