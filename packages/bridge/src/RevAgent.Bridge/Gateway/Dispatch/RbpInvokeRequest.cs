using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// The bridge-side reading of a frozen Section 10.2 <c>invoke</c> payload.
/// </summary>
/// <remarks>
/// Section 10.2 makes <c>mutation_scope</c>, <c>verification</c>, and
/// <c>recovery_clearances</c> REQUIRED fields and states that bridge-local code
/// never invents any of them. This type therefore only reads what the Gateway
/// sent; every field is carried through verbatim, and a missing required field
/// is a fault rather than a default.
/// </remarks>
internal sealed record RbpInvokeRequest(
    string Rsid,
    string InvocationId,
    string Method,
    JsonElement Parameters,
    TimeSpan Timeout,
    bool Mutating,
    JsonElement MutationScope,
    JsonElement Policy,
    JsonElement Verification,
    JsonElement RecoveryClearances)
{
    /// <summary>
    /// Reads a validated <c>invoke</c> payload. The envelope codec has already
    /// enforced the schema, so a failure here is a bridge-side defect rather
    /// than a peer protocol fault.
    /// </summary>
    internal static RbpInvokeRequest Parse(string rsid, JsonElement payload)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);

        long timeoutMilliseconds = RequireInt64(payload, "timeout_ms");
        if (timeoutMilliseconds <= 0 || timeoutMilliseconds > int.MaxValue)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Protocol,
                "The invoke timeout is outside the bounded dispatch range.");
        }

        return new RbpInvokeRequest(
            rsid,
            RequireString(payload, "invocation_id"),
            RequireString(payload, "method"),
            RequireProperty(payload, "params"),
            TimeSpan.FromMilliseconds(timeoutMilliseconds),
            RequireBoolean(payload, "mutating"),
            RequireProperty(payload, "mutation_scope"),
            RequireProperty(payload, "policy"),
            RequireProperty(payload, "verification"),
            RequireProperty(payload, "recovery_clearances"));
    }

    /// <summary>
    /// Projects the request onto the durable journal identity.
    /// </summary>
    /// <remarks>
    /// Section 12.1 fixes <c>params_digest</c> over the functional
    /// <c>params</c> value before any display or audit side-channel field is
    /// merged, which is exactly the element carried on <see cref="Parameters"/>.
    /// Section 12.2 rule 5 compares method, scope, policy, and clearance
    /// separately, so each is canonicalized into its own durable column instead
    /// of being folded into the parameter digest.
    /// </remarks>
    internal RbpInvocationIdentity ToIdentity() =>
        new(
            Rsid,
            InvocationId,
            Method,
            Mutating,
            Mutating ? Rfc8785Json.Canonicalize(MutationScope) : null,
            Rfc8785Json.MakeParametersDigest(Parameters),
            Rfc8785Json.Canonicalize(Policy),
            Rfc8785Json.Canonicalize(RecoveryClearances));

    /// <summary>
    /// The typed Section 6.2.1 clearances the journal accepts in the same
    /// transaction that admits this invocation.
    /// </summary>
    /// <remarks>
    /// An empty array is the ordinary case and carries no clearance; a
    /// non-empty array makes this the one evidence-bound envelope, which the
    /// clearance-gated admission path must see. An entry that cannot become
    /// an acceptance input fails closed here, at the boundary, and never
    /// reaches the journal or the add-in.
    /// </remarks>
    internal IReadOnlyList<RbpRecoveryClearance> ParseClearances()
    {
        if (RecoveryClearances.ValueKind != JsonValueKind.Array)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Protocol,
                "recovery_clearances is REQUIRED and must be an array.");
        }

        int count = RecoveryClearances.GetArrayLength();
        if (count == 0)
        {
            return Array.Empty<RbpRecoveryClearance>();
        }

        var clearances = new List<RbpRecoveryClearance>(count);
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
        if (!payload.TryGetProperty(name, out JsonElement value))
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Protocol,
                $"The invoke payload is missing the required '{name}' field.");
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
                $"The invoke payload field '{name}' must be a non-empty string.");
        }

        return text;
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
                $"The invoke payload field '{name}' must be a boolean."),
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
                $"The invoke payload field '{name}' must be an integer.");
        }

        return number;
    }
}
