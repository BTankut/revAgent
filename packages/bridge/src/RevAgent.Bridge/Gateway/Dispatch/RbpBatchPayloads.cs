using System.Text.Json;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// The frozen Section 11.1 step statuses. <c>not_started</c> is a real
/// reported status, not an absence.
/// </summary>
internal static class RbpBatchStepStatus
{
    internal const string Completed = "completed";
    internal const string Guarded = "guarded";
    internal const string Failed = "failed";
    internal const string Cancelled = "cancelled";
    internal const string Indeterminate = "indeterminate";
    internal const string NotStarted = "not_started";
}

/// <summary>
/// The frozen Section 11.1 aggregate transaction states.
/// </summary>
internal static class RbpBatchTransactionState
{
    internal const string Committed = "committed";
    internal const string RolledBack = "rolled_back";
    internal const string NotApplicable = "not_applicable";
    internal const string Indeterminate = "indeterminate";
}

/// <summary>
/// One ordered batch step as it will appear in the Section 11.1 carrier.
/// </summary>
/// <remarks>
/// <see cref="Evidence"/> is the durable per-step body: exactly the Section
/// 11.1 step object minus <c>index</c>, <c>invocation_id</c>, and
/// <c>replayed</c>. Those three are positional or per-delivery facts that the
/// enclosing carrier owns, so keeping them out of the journal means a
/// redelivery reissues the step it actually recorded instead of rebuilding one
/// from inference.
/// </remarks>
internal sealed record RbpBatchStepOutcome(
    int Index,
    string InvocationId,
    JsonElement Evidence,
    bool Replayed)
{
    internal string Status =>
        Evidence.ValueKind == JsonValueKind.Object &&
        Evidence.TryGetProperty("status", out JsonElement status) &&
        status.ValueKind == JsonValueKind.String &&
        status.GetString() is { Length: > 0 } text
            ? text
            : throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "A durable batch step body is missing its status.");

    internal bool IsCompleted =>
        string.Equals(
            Status,
            RbpBatchStepStatus.Completed,
            StringComparison.Ordinal);
}

/// <summary>
/// Builds the frozen Section 11.1 batch result carrier and its durable
/// per-step evidence bodies (spec ~918-1013).
/// </summary>
internal static class RbpBatchPayloads
{
    /// <summary>
    /// The one <c>result</c> every batch terminates with.
    /// </summary>
    /// <remarks>
    /// <c>failed_step_index</c> is written at the top level of the payload,
    /// never hidden inside a step result or metrics object, and it is null
    /// only when every step completed. Every input step appears exactly once
    /// and in input order.
    /// </remarks>
    internal static JsonElement Carrier(
        string batchId,
        bool atomic,
        string status,
        string transactionState,
        int? failedStepIndex,
        IReadOnlyList<RbpBatchStepOutcome> steps,
        bool replayed)
    {
        ArgumentNullException.ThrowIfNull(steps);

        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("kind", "batch");
            writer.WriteString("batch_id", batchId);
            writer.WriteBoolean("atomic", atomic);
            writer.WriteString("status", status);
            writer.WriteString("transaction_state", transactionState);
            if (failedStepIndex is { } index)
            {
                writer.WriteNumber("failed_step_index", index);
            }
            else
            {
                writer.WriteNull("failed_step_index");
            }

            writer.WriteStartArray("steps");
            foreach (RbpBatchStepOutcome step in steps)
            {
                WriteStep(writer, step);
            }

            writer.WriteEndArray();

            // Spec ~1012-1013: batch replayed:true means this delivery
            // executed no add-in step.
            writer.WriteBoolean("replayed", replayed);
            writer.WriteEndObject();
        }

        return Materialize(buffer);
    }

    /// <summary>
    /// The aggregate status implied by the ordered step statuses.
    /// </summary>
    /// <remarks>
    /// Batch status normally matches the first non-success step. A
    /// <c>not_started</c> first non-success only occurs on an
    /// <c>atomic:false</c> redelivery whose recovered step succeeded while
    /// ordered successors have not run yet (spec ~1109-1119); that delivery
    /// did not complete the batch, and reporting <c>completed</c> would claim
    /// steps that provably never executed, so it reports <c>failed</c> with
    /// the first unexecuted index. No mutation doubt is invented for it,
    /// because none exists.
    /// </remarks>
    internal static string AggregateStatus(
        IReadOnlyList<RbpBatchStepOutcome> steps)
    {
        ArgumentNullException.ThrowIfNull(steps);
        foreach (RbpBatchStepOutcome step in steps)
        {
            if (step.IsCompleted)
            {
                continue;
            }

            return string.Equals(
                step.Status,
                RbpBatchStepStatus.NotStarted,
                StringComparison.Ordinal)
                ? RbpBatchStepStatus.Failed
                : step.Status;
        }

        return RbpBatchStepStatus.Completed;
    }

    /// <summary>
    /// The zero-based first non-success step, or null when every step
    /// completed.
    /// </summary>
    internal static int? FirstNonSuccessIndex(
        IReadOnlyList<RbpBatchStepOutcome> steps)
    {
        ArgumentNullException.ThrowIfNull(steps);
        for (int index = 0; index < steps.Count; index++)
        {
            if (!steps[index].IsCompleted)
            {
                return index;
            }
        }

        return null;
    }

    /// <summary>
    /// A completed or guarded step body. A guarded step requires its
    /// normalized Section 10.3 reason.
    /// </summary>
    internal static JsonElement SuccessEvidence(
        string status,
        JsonElement result,
        string? guardedReason,
        string? resultDigest,
        string? effectState)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("status", status);
            writer.WritePropertyName("result");
            if (result.ValueKind == JsonValueKind.Undefined)
            {
                writer.WriteStartObject();
                writer.WriteEndObject();
            }
            else
            {
                result.WriteTo(writer);
            }

            if (guardedReason is { Length: > 0 } reason)
            {
                writer.WriteString("guarded_reason", reason);
            }

            if (resultDigest is { Length: > 0 } digest)
            {
                writer.WriteString("result_digest", digest);
            }

            if (effectState is { Length: > 0 } effect)
            {
                writer.WriteString("effect_state", effect);
            }

            writer.WriteEndObject();
        }

        return Materialize(buffer);
    }

    /// <summary>
    /// A completed or guarded step whose result the add-in suppressed because
    /// the enclosing <c>TransactionGroup</c> rolled back or is in doubt.
    /// </summary>
    /// <remarks>
    /// Spec ~1812-1817: a rolled-back mutation and a discarded transient read
    /// are both hidden, and the step says why instead of exposing a result
    /// that no longer describes the model.
    /// </remarks>
    internal static JsonElement SuppressedEvidence(
        string status,
        string? effectState,
        string resultSuppressed,
        string? guardedReason)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("status", status);
            writer.WriteString("result_suppressed", resultSuppressed);
            if (guardedReason is { Length: > 0 } reason)
            {
                writer.WriteString("guarded_reason", reason);
            }

            if (effectState is { Length: > 0 } effect)
            {
                writer.WriteString("effect_state", effect);
            }

            writer.WriteEndObject();
        }

        return Materialize(buffer);
    }

    /// <summary>
    /// A non-success step body carrying a complete Section 15 error.
    /// </summary>
    internal static JsonElement ErrorEvidence(
        string status,
        JsonElement nestedError,
        string? effectState = null,
        string? guardedReason = null)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("status", status);
            writer.WritePropertyName("error");
            nestedError.WriteTo(writer);
            if (guardedReason is { Length: > 0 } reason)
            {
                writer.WriteString("guarded_reason", reason);
            }

            if (effectState is { Length: > 0 } effect)
            {
                writer.WriteString("effect_state", effect);
            }

            writer.WriteEndObject();
        }

        return Materialize(buffer);
    }

    /// <summary>
    /// The body of an ordered successor behind the stopping step.
    /// <c>not_started</c> never carries result, error, or omission fields.
    /// </summary>
    internal static JsonElement NotStartedEvidence()
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("status", RbpBatchStepStatus.NotStarted);
            writer.WriteEndObject();
        }

        return Materialize(buffer);
    }

    /// <summary>
    /// Nests a Section 15 invocation-error body inside a batch step.
    /// </summary>
    /// <remarks>
    /// Spec ~1000-1002: the nested error is the complete Section 15 body
    /// except that <c>invocation_id</c> is carried by the enclosing step.
    /// <c>retryable</c>, <c>fault_class</c>, <c>outcome</c>,
    /// <c>verification_required</c>, and <c>message</c> survive verbatim
    /// because no parent status may supply them by implication.
    /// </remarks>
    internal static JsonElement NestedError(
        JsonElement invocationError,
        bool replayed,
        bool? lateAfterIndeterminate = null,
        string? resultDigest = null)
    {
        RequireObject(invocationError, "A nested batch error");
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (JsonProperty property in
                     invocationError.EnumerateObject())
            {
                if (property.NameEquals("invocation_id") ||
                    property.NameEquals("replayed") ||
                    (lateAfterIndeterminate is not null &&
                     property.NameEquals("late_after_indeterminate")) ||
                    (resultDigest is not null &&
                     property.NameEquals("result_digest")))
                {
                    continue;
                }

                property.WriteTo(writer);
            }

            writer.WriteBoolean("replayed", replayed);
            if (lateAfterIndeterminate is { } late)
            {
                writer.WriteBoolean("late_after_indeterminate", late);
            }

            if (resultDigest is { Length: > 0 } digest)
            {
                writer.WriteString("result_digest", digest);
            }

            writer.WriteEndObject();
        }

        return Materialize(buffer);
    }

    /// <summary>
    /// A batch-level Section 15 error: a whole <c>invoke_batch</c> refused
    /// before any step could be dispatched, so no step owns it and no
    /// <c>invocation_id</c> applies.
    /// </summary>
    internal static JsonElement BatchError(JsonElement invocationError)
    {
        RequireObject(invocationError, "A batch error");
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (JsonProperty property in
                     invocationError.EnumerateObject())
            {
                if (property.NameEquals("invocation_id"))
                {
                    continue;
                }

                property.WriteTo(writer);
            }

            writer.WriteEndObject();
        }

        return Materialize(buffer);
    }

    private static void WriteStep(
        Utf8JsonWriter writer,
        RbpBatchStepOutcome step)
    {
        RequireObject(step.Evidence, "A batch step body");
        writer.WriteStartObject();
        writer.WriteNumber("index", step.Index);
        writer.WriteString("invocation_id", step.InvocationId);
        foreach (JsonProperty property in step.Evidence.EnumerateObject())
        {
            if (property.NameEquals("index") ||
                property.NameEquals("invocation_id") ||
                property.NameEquals("replayed"))
            {
                continue;
            }

            property.WriteTo(writer);
        }

        writer.WriteBoolean("replayed", step.Replayed);
        writer.WriteEndObject();
    }

    private static void RequireObject(JsonElement value, string what)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                $"{what} must be a JSON object.");
        }
    }

    private static JsonElement Materialize(MemoryStream buffer)
    {
        using JsonDocument document = JsonDocument.Parse(buffer.ToArray());
        return document.RootElement.Clone();
    }
}
