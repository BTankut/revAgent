using System.Collections.ObjectModel;
using System.Text.Json;

namespace RevAgent.Bridge.Gateway.Protocol;

internal sealed record RbpBatchDigestPolicy(
    string PolicyClass,
    string? ConfirmationId,
    string Decision);

internal sealed record RbpBatchDigestStep(
    string InvocationId,
    string Method,
    bool Mutating,
    JsonElement MutationScope,
    string ParametersDigest,
    RbpBatchDigestPolicy Policy);

internal sealed record RbpBatchDigestInput(
    bool Atomic,
    string BatchId,
    IReadOnlyList<JsonElement> RecoveryClearances,
    IReadOnlyList<RbpBatchDigestStep> Steps,
    long TimeoutMilliseconds)
{
    internal static RbpBatchDigestInput Parse(JsonElement payload)
    {
        Rfc8785Json.EnsureUniqueObjectKeys(payload);
        RequireKind(payload, JsonValueKind.Object, "/");
        JsonElement atomicValue = Required(payload, "atomic", "/");
        RequireKind(
            atomicValue,
            JsonValueKind.True,
            JsonValueKind.False,
            "/atomic");
        bool atomic = atomicValue.GetBoolean();
        string batchId = RequiredString(payload, "batch_id", "/");
        JsonElement clearances = Required(
            payload,
            "recovery_clearances",
            "/");
        RequireKind(
            clearances,
            JsonValueKind.Array,
            "/recovery_clearances");
        IReadOnlyList<JsonElement> parsedClearances = Freeze(
            clearances.EnumerateArray().Select(item => item.Clone()));

        JsonElement steps = Required(payload, "steps", "/");
        RequireKind(steps, JsonValueKind.Array, "/steps");
        var parsedSteps = new List<RbpBatchDigestStep>();
        int index = 0;
        foreach (JsonElement step in steps.EnumerateArray())
        {
            string path = $"/steps/{index}";
            RequireKind(step, JsonValueKind.Object, path);
            JsonElement mutating = Required(step, "mutating", path);
            RequireKind(
                mutating,
                JsonValueKind.True,
                JsonValueKind.False,
                path + "/mutating");
            JsonElement policy = Required(step, "policy", path);
            RequireKind(policy, JsonValueKind.Object, path + "/policy");
            JsonElement confirmation = Required(
                policy,
                "confirmation_id",
                path + "/policy");
            if (confirmation.ValueKind is not (
                    JsonValueKind.String or JsonValueKind.Null))
            {
                throw Invalid(
                    path + "/policy/confirmation_id",
                    "confirmation_id must be a string or null.");
            }

            parsedSteps.Add(
                new RbpBatchDigestStep(
                    RequiredString(step, "invocation_id", path),
                    RequiredString(step, "method", path),
                    mutating.GetBoolean(),
                    Required(step, "mutation_scope", path).Clone(),
                    RequiredString(step, "params_digest", path),
                    new RbpBatchDigestPolicy(
                        RequiredString(
                            policy,
                            "class",
                            path + "/policy"),
                        confirmation.ValueKind == JsonValueKind.Null
                            ? null
                            : confirmation.GetString(),
                        RequiredString(
                            policy,
                            "decision",
                            path + "/policy"))));
            index++;
        }

        JsonElement timeout = Required(payload, "timeout_ms", "/");
        if (!TryReadJsonInteger(timeout, out long timeoutMilliseconds) ||
            timeoutMilliseconds < 0 ||
            timeoutMilliseconds > RbpEnvelopeCodec.MaximumSafeInteger)
        {
            throw Invalid(
                "/timeout_ms",
                "timeout_ms must be a non-negative JSON-safe integer.");
        }

        return new RbpBatchDigestInput(
            atomic,
            batchId,
            parsedClearances,
            new ReadOnlyCollection<RbpBatchDigestStep>(
                parsedSteps.ToArray()),
            timeoutMilliseconds);
    }

    private static JsonElement Required(
        JsonElement owner,
        string name,
        string parentPath)
    {
        if (!owner.TryGetProperty(name, out JsonElement value))
        {
            throw Invalid(
                parentPath + "/" + name,
                $"{name} is required for the batch digest.");
        }

        return value;
    }

    private static string RequiredString(
        JsonElement owner,
        string name,
        string parentPath)
    {
        JsonElement value = Required(owner, name, parentPath);
        if (value.ValueKind != JsonValueKind.String)
        {
            throw Invalid(
                parentPath + "/" + name,
                $"{name} must be a string.");
        }

        return value.GetString() ?? string.Empty;
    }

    private static void RequireKind(
        JsonElement value,
        JsonValueKind expected,
        string path)
    {
        if (value.ValueKind != expected)
        {
            throw Invalid(path, $"Expected {expected}.");
        }
    }

    private static bool TryReadJsonInteger(
        JsonElement value,
        out long integer)
    {
        integer = 0;
        if (value.ValueKind != JsonValueKind.Number)
        {
            return false;
        }

        if (value.TryGetInt64(out integer))
        {
            return true;
        }

        if (!value.TryGetDouble(out double number) ||
            !double.IsFinite(number) ||
            Math.Truncate(number) != number ||
            number < long.MinValue ||
            number >= 9_223_372_036_854_775_808d)
        {
            return false;
        }

        integer = (long)number;
        return true;
    }

    private static void RequireKind(
        JsonElement value,
        JsonValueKind first,
        JsonValueKind second,
        string path)
    {
        if (value.ValueKind != first && value.ValueKind != second)
        {
            throw Invalid(path, $"Expected {first} or {second}.");
        }
    }

    private static RbpFrameException Invalid(string path, string message)
    {
        return new RbpFrameException(
            RbpFrameErrorCode.InvalidEnvelope,
            message,
            path);
    }

    private static IReadOnlyList<T> Freeze<T>(IEnumerable<T> values)
    {
        return new ReadOnlyCollection<T>(values.ToArray());
    }
}
