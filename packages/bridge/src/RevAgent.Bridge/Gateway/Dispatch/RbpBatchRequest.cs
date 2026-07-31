using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// One frozen Section 11 <c>invoke_batch</c> step exactly as the Gateway sent
/// it (spec ~838-880).
/// </summary>
/// <remarks>
/// <c>params</c>, <c>params_digest</c>, and <c>mutation_scope</c> are REQUIRED
/// on every step and <c>params</c> is never replaced by its digest, so this
/// type carries the functional parameters verbatim. Bridge-local code invents
/// none of them.
/// </remarks>
internal sealed record RbpBatchStepRequest(
    int Index,
    string InvocationId,
    string Method,
    JsonElement Parameters,
    string ParametersDigest,
    bool Mutating,
    JsonElement MutationScope,
    JsonElement Policy);

/// <summary>
/// The bridge-side reading of a frozen Section 11 <c>invoke_batch</c> payload.
/// </summary>
/// <remarks>
/// The envelope codec and <c>RbpPayloadValidator</c> have already verified the
/// schema, every step <c>params_digest</c>, and the canonical
/// <c>batch_digest</c>, so a failure here is a bridge-side defect rather than a
/// peer protocol fault. Nothing in this type re-derives a batch rule: it only
/// projects the wire payload onto the durable Section 12.1 coordination
/// identity that the journal already owns.
/// </remarks>
internal sealed record RbpBatchRequest(
    string Rsid,
    string BatchId,
    string BatchDigest,
    bool Atomic,
    long TimeoutMilliseconds,
    JsonElement RecoveryClearances,
    IReadOnlyList<RbpBatchStepRequest> Steps)
{
    internal TimeSpan Timeout =>
        TimeSpan.FromMilliseconds(TimeoutMilliseconds);

    internal string BatchKey => Rsid + "/" + BatchId;

    /// <summary>
    /// The canonical Section 12.1 idempotency key of one ordered step. Every
    /// step has its own key and journal row; all steps share
    /// <c>batch_id</c> (spec ~872-873).
    /// </summary>
    internal string StepKey(int index) =>
        Rsid + "/" + Steps[index].InvocationId;

    internal static RbpBatchRequest Parse(string rsid, JsonElement payload)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);

        long timeoutMilliseconds = RequireInt64(payload, "timeout_ms");
        if (timeoutMilliseconds <= 0 || timeoutMilliseconds > int.MaxValue)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Protocol,
                "The invoke_batch timeout is outside the bounded dispatch " +
                "range.");
        }

        JsonElement steps = RequireProperty(payload, "steps");
        if (steps.ValueKind != JsonValueKind.Array ||
            steps.GetArrayLength() == 0)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Protocol,
                "An invoke_batch payload requires at least one ordered " +
                "step.");
        }

        var parsed = new List<RbpBatchStepRequest>(steps.GetArrayLength());
        int index = 0;
        foreach (JsonElement step in steps.EnumerateArray())
        {
            if (step.ValueKind != JsonValueKind.Object)
            {
                throw new RbpDispatchException(
                    RbpDispatchErrorCode.Protocol,
                    "Every invoke_batch step must be a JSON object.");
            }

            parsed.Add(
                new RbpBatchStepRequest(
                    index,
                    RequireString(step, "invocation_id"),
                    RequireString(step, "method"),
                    RequireProperty(step, "params"),
                    RequireString(step, "params_digest"),
                    RequireBoolean(step, "mutating"),
                    RequireProperty(step, "mutation_scope"),
                    RequireProperty(step, "policy")));
            index++;
        }

        JsonElement clearances =
            RequireProperty(payload, "recovery_clearances");
        if (clearances.ValueKind != JsonValueKind.Array)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Protocol,
                "recovery_clearances is REQUIRED and must be an array.");
        }

        return new RbpBatchRequest(
            rsid,
            RequireString(payload, "batch_id"),
            RequireString(payload, "batch_digest"),
            RequireBoolean(payload, "atomic"),
            timeoutMilliseconds,
            clearances,
            parsed.AsReadOnly());
    }

    /// <summary>
    /// Projects the batch onto the durable Section 12.1 coordination identity.
    /// </summary>
    /// <remarks>
    /// The journal recomputes the Section 11 <c>batch_digest</c> over exactly
    /// this material and refuses a mismatch before creating any row, so this
    /// projection deliberately carries the wire digest through untouched
    /// rather than recomputing a value that would agree with itself.
    /// </remarks>
    internal RbpBatchIdentity ToIdentity()
    {
        var steps = new List<RbpBatchStepIdentity>(Steps.Count);
        foreach (RbpBatchStepRequest step in Steps)
        {
            JsonElement policy = step.Policy;
            steps.Add(
                new RbpBatchStepIdentity(
                    step.InvocationId,
                    step.Method,
                    step.Mutating,

                    // Spec ~874-876: mutation_scope is null exactly for a
                    // read step, so a read never binds a canonical scope.
                    step.Mutating
                        ? Rfc8785Json.Canonicalize(step.MutationScope)
                        : null,
                    step.ParametersDigest,
                    RequireString(policy, "class"),
                    ReadNullableString(policy, "confirmation_id"),
                    RequireString(policy, "decision")));
        }

        return new RbpBatchIdentity(
            Rsid,
            BatchId,
            BatchDigest,
            Atomic,
            TimeoutMilliseconds,
            Rfc8785Json.Canonicalize(RecoveryClearances),
            steps.AsReadOnly());
    }

    /// <summary>
    /// The typed Section 6.2.1 clearances the journal accepts in the same
    /// transaction that admits the batch.
    /// </summary>
    internal IReadOnlyList<RbpRecoveryClearance> ParseClearances()
    {
        var clearances = new List<RbpRecoveryClearance>();
        foreach (JsonElement clearance in RecoveryClearances.EnumerateArray())
        {
            clearances.Add(RbpRecoveryClearance.Parse(clearance));
        }

        return clearances.AsReadOnly();
    }

    private static JsonElement RequireProperty(
        JsonElement payload,
        string name)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty(name, out JsonElement value))
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Protocol,
                $"The invoke_batch payload is missing the required " +
                $"'{name}' field.");
        }

        return value;
    }

    private static string RequireString(JsonElement payload, string name)
    {
        JsonElement value = RequireProperty(payload, name);
        if (value.ValueKind != JsonValueKind.String ||
            value.GetString() is not { Length: > 0 } text)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Protocol,
                $"The invoke_batch field '{name}' must be a non-empty " +
                "string.");
        }

        return text;
    }

    private static string? ReadNullableString(
        JsonElement payload,
        string name)
    {
        JsonElement value = RequireProperty(payload, name);
        return value.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.String => value.GetString(),
            _ => throw new RbpDispatchException(
                RbpDispatchErrorCode.Protocol,
                $"The invoke_batch field '{name}' must be a string or " +
                "explicit null."),
        };
    }

    private static bool RequireBoolean(JsonElement payload, string name)
    {
        JsonElement value = RequireProperty(payload, name);
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => throw new RbpDispatchException(
                RbpDispatchErrorCode.Protocol,
                $"The invoke_batch field '{name}' must be a boolean."),
        };
    }

    private static long RequireInt64(JsonElement payload, string name)
    {
        JsonElement value = RequireProperty(payload, name);
        if (value.ValueKind != JsonValueKind.Number ||
            !value.TryGetInt64(out long number))
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Protocol,
                $"The invoke_batch field '{name}' must be an integer.");
        }

        return number;
    }
}
