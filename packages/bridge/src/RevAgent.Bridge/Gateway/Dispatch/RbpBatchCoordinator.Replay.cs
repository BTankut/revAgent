using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// Answering an <c>invoke_batch</c> delivery entirely from the journal.
/// </summary>
/// <remarks>
/// Spec ~1121-1122 and ~1129-1131: a durable terminal batch outcome replays
/// with identical semantics without calling the add-in, and a recovery
/// delivery that executed no add-in step reports <c>replayed:true</c>. None of
/// the rules are re-derived here; every disposition comes from the journal's
/// arbitration.
/// </remarks>
internal sealed partial class RbpBatchCoordinator
{
    private static RbpInvocationAnswer ReplayTerminal(
        RbpBatchRequest request,
        RbpBatchAdmissionResult admission)
    {
        JsonElement stored = RequireBatchOutcome(admission.Stored);

        // A carrier the bridge itself journaled is reissued verbatim apart
        // from the per-delivery replay flags; rewriting it would let a later
        // bridge build answer differently from the one that actually ran.
        if (stored.TryGetProperty("steps", out JsonElement storedSteps) &&
            storedSteps.ValueKind == JsonValueKind.Array)
        {
            var replayedSteps =
                new List<RbpBatchStepOutcome>(storedSteps.GetArrayLength());
            foreach (JsonElement step in storedSteps.EnumerateArray())
            {
                bool notStarted = string.Equals(
                    ReadString(step, "status"),
                    RbpBatchStepStatus.NotStarted,
                    StringComparison.Ordinal);
                replayedSteps.Add(
                    new RbpBatchStepOutcome(
                        ReadInt32(step, "index"),
                        ReadString(step, "invocation_id") ?? string.Empty,
                        step,

                        // A step that never ran has nothing to replay.
                        Replayed: !notStarted));
            }

            return RbpInvocationAnswer.Result(
                RbpBatchPayloads.Carrier(
                    request.BatchId,
                    request.Atomic,
                    ReadRequiredString(stored, "status"),
                    ReadRequiredString(stored, "transaction_state"),
                    ReadNullableInt32(stored, "failed_step_index"),
                    replayedSteps.AsReadOnly(),
                    replayed: true));
        }

        // The journal authored this aggregate itself while arbitrating an
        // atomic dispatch loss, so the ordered steps are rebuilt from the
        // durable rows it wrote in that same transaction.
        var rebuilt = new List<RbpBatchStepOutcome>(admission.Steps.Count);
        foreach (RbpBatchStepArbitration step in admission.Steps)
        {
            rebuilt.Add(FromArbitration(step));
        }

        return RbpInvocationAnswer.Result(
            RbpBatchPayloads.Carrier(
                request.BatchId,
                request.Atomic,
                ReadRequiredString(stored, "status"),
                ReadRequiredString(stored, "transaction_state"),
                ReadNullableInt32(stored, "failed_step_index"),
                rebuilt.AsReadOnly(),
                replayed: true));
    }

    /// <summary>
    /// One arbitrated step answered from its durable row.
    /// </summary>
    private static RbpBatchStepOutcome FromArbitration(
        RbpBatchStepArbitration step)
    {
        if (step.Disposition == RbpBatchStepDisposition.NotStarted ||
            step.Stored is not { IsTerminal: true } row)
        {
            return new RbpBatchStepOutcome(
                step.BatchIndex,
                step.InvocationId,
                RbpBatchPayloads.NotStartedEvidence(),
                Replayed: false);
        }

        return FromStoredRow(
            step.BatchIndex,
            step.InvocationId,
            row,
            replayed: true,
            lateAfterIndeterminate:
                step.Disposition ==
                RbpBatchStepDisposition.ReplayLateAfterIndeterminate);
    }

    /// <summary>
    /// Rebuilds one step body from its durable invocation row.
    /// </summary>
    /// <remarks>
    /// An indeterminate row stores the Section 12.2 rule 4 evidence authored
    /// from its canonical hold. Its nested Section 15 error is rebuilt from
    /// that durable body rather than from immutable step identity, because a
    /// session-scoped atomic hold may subsume a document-scoped step. Every
    /// other terminal row already stores the step body verbatim, including
    /// the journal's own narrow
    /// <c>environment</c> body for a read lost with an atomic carrier.
    /// </remarks>
    private static RbpBatchStepOutcome FromStoredRow(
        int index,
        string invocationId,
        RbpStoredInvocation row,
        bool replayed,
        bool lateAfterIndeterminate = false,
        string? indeterminateMessage = null)
    {
        if (row.State == RbpInvocationState.Indeterminate)
        {
            if (row.VerificationHoldId is not { Length: > 0 } holdId)
            {
                throw new RbpDispatchException(
                    RbpDispatchErrorCode.Environment,
                    "An indeterminate batch step requires its installed " +
                    "Section 6.2.1 verification hold id.");
            }

            if (row.TerminalOutcomeJson is not { Length: > 0 } outcomeJson ||
                row.ResultDigest is not { Length: > 0 } outcomeDigest)
            {
                throw new RbpDispatchException(
                    RbpDispatchErrorCode.Environment,
                    "An indeterminate batch step requires its durable hold " +
                    "evidence and digest.");
            }

            using JsonDocument outcome = JsonDocument.Parse(outcomeJson);
            JsonElement durable = outcome.RootElement;
            if (durable.ValueKind != JsonValueKind.Object ||
                !durable.TryGetProperty(
                    "mutation_scope",
                    out JsonElement scope) ||
                scope.ValueKind != JsonValueKind.Object ||
                !durable.TryGetProperty(
                    "verification_hold_id",
                    out JsonElement durableHold) ||
                durableHold.ValueKind != JsonValueKind.String ||
                durableHold.GetString() != holdId ||
                !durable.TryGetProperty("outcome", out JsonElement state) ||
                state.ValueKind != JsonValueKind.String ||
                state.GetString() != "indeterminate" ||
                !durable.TryGetProperty(
                    "verification_required",
                    out JsonElement required) ||
                required.ValueKind != JsonValueKind.True ||
                !durable.TryGetProperty("retryable", out JsonElement retryable) ||
                retryable.ValueKind != JsonValueKind.False ||
                Rfc8785Json.Sha256Digest(durable) != outcomeDigest)
            {
                throw new RbpDispatchException(
                    RbpDispatchErrorCode.Environment,
                    "An indeterminate batch step has contradictory durable " +
                    "hold evidence.");
            }

            return new RbpBatchStepOutcome(
                index,
                invocationId,
                RbpBatchPayloads.ErrorEvidence(
                    RbpBatchStepStatus.Indeterminate,
                    RbpBatchPayloads.NestedError(
                        RbpInvocationPayloads.JournalIndeterminateError(
                            invocationId,
                            holdId,
                            scope,
                            indeterminateMessage ??
                                RbpInvocationPayloads
                                    .MutationMayHaveExecutedMessage,
                            replayed),
                        replayed,

                        // Rule 2 evidence does not clear the hold and does
                        // not turn the step into a success.
                        lateAfterIndeterminate ? true : null,
                        lateAfterIndeterminate ? row.LateResultDigest : null)),
                replayed);
        }

        if (row.TerminalOutcomeJson is not { Length: > 0 } json)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "A terminal batch step row is missing its outcome body.");
        }

        using JsonDocument body = JsonDocument.Parse(json);
        return new RbpBatchStepOutcome(
            index,
            invocationId,
            body.RootElement.Clone(),
            replayed);
    }

    private static JsonElement RequireBatchOutcome(RbpStoredBatch stored)
    {
        if (stored.TerminalOutcomeJson is not { Length: > 0 } json)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "A terminal batch row is missing its durable outcome.");
        }

        using JsonDocument document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static string ReadRequiredString(
        JsonElement value,
        string name) =>
        ReadString(value, name) is { Length: > 0 } text
            ? text
            : throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                $"A durable batch outcome is missing its '{name}'.");
}
