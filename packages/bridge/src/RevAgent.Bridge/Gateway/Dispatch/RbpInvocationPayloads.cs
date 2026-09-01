using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// Builds the frozen Section 10.3 result bodies and Section 15 error bodies.
/// </summary>
/// <remarks>
/// Every writer here is deliberately explicit about <c>replayed</c>,
/// <c>late_after_indeterminate</c>, <c>outcome</c>, and
/// <c>verification_required</c>. Section 15 states that no parent status may
/// supply those by implication, so nothing is left to a schema default.
/// </remarks>
internal static class RbpInvocationPayloads
{
    internal const string FramingLengthPrefixed = "length-prefixed";

    /// <summary>
    /// The bounded operator-safe Section 12.2 rule 4 message. Shared so a
    /// redelivered indeterminate answer reads identically to the refusal that
    /// first classified it — the durable row stores no per-delivery message.
    /// </summary>
    internal const string MutationMayHaveExecutedMessage =
        "A mutating invocation may already have executed; correlated " +
        "read-only verification is required before another mutation.";

    /// <summary>
    /// A first-delivery terminal result for a call the add-in actually ran.
    /// </summary>
    internal static JsonElement InvocationResult(
        string invocationId,
        string status,
        JsonElement result,
        string? guardedReason,
        string? resultDigest,
        RbpInvocationMetrics metrics)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("kind", "invocation");
            writer.WriteString("invocation_id", invocationId);
            writer.WriteString("status", status);
            writer.WritePropertyName("result");
            result.WriteTo(writer);
            if (guardedReason is not null)
            {
                writer.WriteString("guarded_reason", guardedReason);
            }

            writer.WriteBoolean("replayed", false);
            writer.WriteBoolean("payload_omitted", false);
            writer.WriteBoolean("late_after_indeterminate", false);
            if (resultDigest is not null)
            {
                writer.WriteString("result_digest", resultDigest);
            }

            WriteMetrics(writer, metrics);
            writer.WriteEndObject();
        }

        return Materialize(buffer);
    }

    /// <summary>
    /// Section 12.2 rule 1: replay a durable terminal outcome without calling
    /// the add-in.
    /// </summary>
    /// <remarks>
    /// The stored body is reissued verbatim apart from the per-delivery replay
    /// flags. Rewriting the outcome on replay would let a later bridge build
    /// answer differently from the one that actually ran, which is exactly the
    /// drift the journal exists to prevent. That verbatim rule includes the
    /// stored <c>result_digest</c>: Section 10.3 makes it REQUIRED on a
    /// terminal read carrying a verification correlation precisely so a later
    /// clearance can be checked independently, and a replay that dropped it
    /// would break that check on redelivery.
    /// </remarks>
    internal static JsonElement ReplayTerminal(JsonElement storedOutcome) =>
        OverrideReplayFlags(
            storedOutcome,
            replayed: true,
            lateAfterIndeterminate: false,
            verificationHoldId: null,
            resultDigest: ReadStoredResultDigest(storedOutcome));

    /// <summary>
    /// Fixture-attested C39 reconnect evidence. This is the existing
    /// non-chunked omitted-payload replay shape; no result bytes are emitted.
    /// </summary>
    internal static JsonElement ConformanceOmittedOriginReplay(
        string originInvocationId, string resultDigest)
    {
        if (!RbpRecoveryClearance.IsUuidV7(originInvocationId) ||
            !RbpJournalSerialization.IsSha256Digest(resultDigest))
        {
            throw new ArgumentException("A UUIDv7 origin and SHA-256 digest are required.");
        }
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("kind", "invocation");
            writer.WriteString("invocation_id", originInvocationId);
            writer.WriteString("status", "completed");
            writer.WriteBoolean("payload_omitted", true);
            writer.WriteString("result_digest", resultDigest);
            writer.WriteBoolean("replayed", true);
            writer.WriteBoolean("late_after_indeterminate", false);
            WriteMetrics(writer, new RbpInvocationMetrics(0, 0, 0));
            writer.WriteEndObject();
        }
        return Materialize(buffer);
    }

    /// <summary>
    /// Section 12.2 rule 2: a durable outcome that became known after the same
    /// invocation had already been answered <c>journal_indeterminate</c>.
    /// </summary>
    /// <remarks>
    /// This is recovery evidence under Section 6.2.1, not a second user-visible
    /// execution, and it does not clear the hold. Section 10.3 makes
    /// <c>replayed</c>, <c>verification_hold_id</c>, and <c>result_digest</c>
    /// all REQUIRED here, so the caller must supply the last two.
    /// </remarks>
    internal static JsonElement ReplayLateAfterIndeterminate(
        JsonElement storedOutcome,
        string verificationHoldId,
        string resultDigest) =>
        OverrideReplayFlags(
            storedOutcome,
            replayed: true,
            lateAfterIndeterminate: true,
            verificationHoldId: verificationHoldId,
            resultDigest: resultDigest);

    /// <summary>
    /// Section 12.2 rule 4 / Section 15: a mutating invocation that may have
    /// executed. Never retryable, always verification-bearing.
    /// </summary>
    /// <remarks>
    /// Section 15 forbids <c>result_digest</c> on this class precisely because
    /// there is no durable response to digest; emitting one would assert
    /// evidence the bridge does not have. <paramref name="replayed"/> is the
    /// only per-delivery bit: a Section 12.2 rule 1 redelivery answers with
    /// this same complete body, flagged <c>replayed:true</c>.
    /// </remarks>
    internal static JsonElement JournalIndeterminateError(
        string invocationId,
        string verificationHoldId,
        JsonElement mutationScope,
        string message,
        bool replayed)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("invocation_id", invocationId);
            writer.WriteBoolean("retryable", false);
            writer.WriteString("fault_class", "journal_indeterminate");
            writer.WriteString("outcome", "indeterminate");
            writer.WriteBoolean("verification_required", true);
            writer.WriteBoolean("replayed", replayed);
            writer.WriteBoolean("late_after_indeterminate", false);
            writer.WriteString("verification_hold_id", verificationHoldId);
            writer.WritePropertyName("mutation_scope");
            mutationScope.WriteTo(writer);
            writer.WriteString("message", Bound(message));
            writer.WriteEndObject();
        }

        return Materialize(buffer);
    }

    /// <summary>
    /// A terminal error whose outcome is known — the invocation provably did
    /// not commit, or the add-in itself reported the failure.
    /// </summary>
    internal static JsonElement KnownError(
        string invocationId,
        string faultClass,
        bool retryable,
        string message,
        AddinErrorDetail? addinError = null)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("invocation_id", invocationId);
            writer.WriteBoolean("retryable", retryable);
            writer.WriteString("fault_class", faultClass);
            writer.WriteString("outcome", "known");
            writer.WriteBoolean("verification_required", false);
            writer.WriteBoolean("replayed", false);
            writer.WriteBoolean("late_after_indeterminate", false);
            writer.WriteString("message", Bound(message));
            if (addinError is { } detail)
            {
                writer.WriteStartObject("addin_error");
                writer.WriteNumber("code", detail.Code);
                if (detail.Message is { Length: > 0 } addinMessage)
                {
                    writer.WriteString("message", Bound(addinMessage));
                }

                writer.WriteEndObject();
            }

            writer.WriteEndObject();
        }

        return Materialize(buffer);
    }

    /// <summary>
    /// C39's final chunked recovery result.  This is deliberately a distinct
    /// builder instead of an object rewrite: the frozen schema forbids the
    /// <c>payload_omitted</c> member entirely on a chunked terminal, including
    /// when its value would otherwise be false.
    /// </summary>
    internal static JsonElement ChunkedRecoveryTerminal(
        string invocationId,
        int totalChunks,
        int totalSize,
        string resultDigest)
    {
        if (totalChunks < 1) throw new ArgumentOutOfRangeException(nameof(totalChunks));
        if (totalSize < 1) throw new ArgumentOutOfRangeException(nameof(totalSize));
        if (string.IsNullOrWhiteSpace(resultDigest) ||
            !resultDigest.StartsWith("sha256:", StringComparison.Ordinal))
        {
            throw new ArgumentException("A SHA-256 result digest is required.",
                nameof(resultDigest));
        }

        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("kind", "invocation");
            writer.WriteString("invocation_id", invocationId);
            writer.WriteString("status", "completed");
            writer.WriteBoolean("replayed", false);
            writer.WriteBoolean("late_after_indeterminate", false);
            writer.WriteString("result_digest", resultDigest);
            WriteMetrics(writer, new RbpInvocationMetrics(0, 0, 0));
            writer.WriteBoolean("chunked", true);
            writer.WriteString("stream_id", "result");
            writer.WriteString("content_type", "application/json");
            writer.WriteNumber("total_chunks", totalChunks);
            writer.WriteNumber("total_size", totalSize);
            writer.WriteString("sha256", resultDigest);
            writer.WriteEndObject();
        }

        return Materialize(buffer);
    }

    /// <summary>
    /// Rehydrates C39's already durable terminal answer without changing its
    /// wire shape.  The terminal plan is the authority; this adapter merely
    /// rejects malformed or substituted plan material before the connection
    /// can frame it.
    /// </summary>
    internal static RbpInvocationAnswer RecoveryTerminalDraft(
        RbpRecoveryTerminalPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        JsonElement payload = plan.TerminalPayload;
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("kind", out JsonElement kind) ||
            !string.Equals(kind.GetString(), "invocation", StringComparison.Ordinal) ||
            !payload.TryGetProperty("invocation_id", out JsonElement invocationId) ||
            !string.Equals(invocationId.GetString(), plan.RecoveryInvocationId,
                StringComparison.Ordinal) ||
            !payload.TryGetProperty("status", out JsonElement status) ||
            !string.Equals(status.GetString(), "completed", StringComparison.Ordinal) ||
            !payload.TryGetProperty("chunked", out JsonElement chunked) ||
            chunked.ValueKind is not JsonValueKind.True ||
            payload.TryGetProperty("payload_omitted", out _) ||
            !payload.TryGetProperty("result_digest", out JsonElement digest) ||
            digest.ValueKind != JsonValueKind.String ||
            !digest.GetString()!.StartsWith("sha256:", StringComparison.Ordinal) ||
            !string.Equals(Rfc8785Json.Sha256Digest(payload), plan.TerminalDigest,
                StringComparison.Ordinal))
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "The durable C39 terminal plan is invalid.");
        }

        return RbpInvocationAnswer.Result(payload);
    }

    private static JsonElement OverrideReplayFlags(
        JsonElement storedOutcome,
        bool replayed,
        bool lateAfterIndeterminate,
        string? verificationHoldId,
        string? resultDigest)
    {
        if (storedOutcome.ValueKind != JsonValueKind.Object)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "The journalled terminal outcome is not a JSON object.");
        }

        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (JsonProperty property in storedOutcome.EnumerateObject())
            {
                if (IsReplayFlag(property.Name))
                {
                    continue;
                }

                property.WriteTo(writer);
            }

            writer.WriteBoolean("replayed", replayed);
            writer.WriteBoolean(
                "late_after_indeterminate",
                lateAfterIndeterminate);
            if (verificationHoldId is not null)
            {
                writer.WriteString("verification_hold_id", verificationHoldId);
            }

            if (resultDigest is not null)
            {
                writer.WriteString("result_digest", resultDigest);
            }

            writer.WriteEndObject();
        }

        return Materialize(buffer);
    }

    private static string? ReadStoredResultDigest(JsonElement storedOutcome) =>
        storedOutcome.ValueKind == JsonValueKind.Object &&
        storedOutcome.TryGetProperty(
            "result_digest",
            out JsonElement digest) &&
        digest.ValueKind == JsonValueKind.String
            ? digest.GetString()
            : null;

    private static bool IsReplayFlag(string name) =>
        name is "replayed" or
            "late_after_indeterminate" or
            "verification_hold_id" or
            "result_digest";

    private static void WriteMetrics(
        Utf8JsonWriter writer,
        RbpInvocationMetrics metrics)
    {
        writer.WriteStartObject("metrics");
        writer.WriteNumber("execute_ms", metrics.ExecuteMilliseconds);
        writer.WriteNumber("request_bytes", metrics.RequestBytes);
        writer.WriteNumber("response_bytes", metrics.ResponseBytes);
        writer.WriteString("framing", FramingLengthPrefixed);
        writer.WriteEndObject();
    }

    private static string Bound(string message) =>
        message.Length <= 512 ? message : message[..512];

    private static JsonElement Materialize(MemoryStream buffer)
    {
        using JsonDocument document = JsonDocument.Parse(buffer.ToArray());
        return document.RootElement.Clone();
    }
}

internal sealed record RbpInvocationMetrics(
    long ExecuteMilliseconds,
    int RequestBytes,
    int ResponseBytes);

internal sealed record AddinErrorDetail(int Code, string? Message);

internal sealed record RbpPayloadRecoveryRequest(
    string OriginInvocationId,
    string ExpectedResultDigest)
{
    internal static RbpPayloadRecoveryRequest Parse(RbpInvokeRequest request)
    {
        JsonElement origin = default;
        JsonElement digest = default;
        if (request.Mutating || request.Parameters.ValueKind != JsonValueKind.Object ||
            request.Parameters.EnumerateObject().Count() != 2 ||
            request.RecoveryClearances.ValueKind != JsonValueKind.Array ||
            request.RecoveryClearances.GetArrayLength() != 0 ||
            !request.Parameters.TryGetProperty("origin_invocation_id", out origin) ||
            !request.Parameters.TryGetProperty("expected_result_digest", out digest) ||
            origin.ValueKind != JsonValueKind.String || digest.ValueKind != JsonValueKind.String ||
            !RbpRecoveryClearance.IsUuidV7(origin.GetString()) ||
            !RbpJournalSerialization.IsSha256Digest(digest.GetString() ?? string.Empty))
        {
            throw new RbpDispatchException(RbpDispatchErrorCode.Protocol,
                "dispatch_payload_recovery requires exactly origin_invocation_id and expected_result_digest.");
        }
        return new RbpPayloadRecoveryRequest(origin.GetString()!, digest.GetString()!);
    }

    internal string EnvelopeDigest(string recoveryInvocationId) =>
        Rfc8785Json.Sha256Digest(JsonSerializer.SerializeToElement(new
        {
            invocation_id = recoveryInvocationId,
            origin_invocation_id = OriginInvocationId,
            expected_result_digest = ExpectedResultDigest,
        }));
}
