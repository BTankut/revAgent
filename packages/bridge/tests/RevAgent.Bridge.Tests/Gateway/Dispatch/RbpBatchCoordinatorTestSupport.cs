using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

/// <summary>
/// One frozen Section 11 batch step as a test declares it. The
/// <c>params_digest</c> and the enclosing <c>batch_digest</c> are computed
/// from these values through the same frozen engines the payload validator
/// and the journal use, so a fixture can never bind a digest the production
/// path would reject.
/// </summary>
internal sealed record BatchStepSpec(
    string InvocationId,
    string Method,
    string ParametersJson = "{}",
    bool Mutating = false,
    string? MutationScopeJson = null,
    string PolicyClass = "auto",
    string Decision = "auto",
    string? ConfirmationId = null);

internal static class RbpBatchCoordinatorTestData
{
    internal const string Rsid = "rs-test";

    internal const string ReadMethod = "get_current_view_info";

    internal const string SecondReadMethod = "find_elements";

    internal const string WriteMethod = "delete_review_view";

    internal const string DocumentScope =
        """{"document_id":"doc-1","kind":"document"}""";

    internal static BatchStepSpec Read(
        string invocationId,
        string method = ReadMethod,
        string parametersJson = "{}") =>
        new(invocationId, method, parametersJson);

    internal static BatchStepSpec Write(
        string invocationId,
        string parametersJson =
            """{"confirmDelete":true,"mode":"commit","viewId":"1"}""") =>
        new(
            invocationId,
            WriteMethod,
            parametersJson,
            Mutating: true,
            MutationScopeJson: DocumentScope,
            PolicyClass: "confirm",
            Decision: "confirmed",
            ConfirmationId: "0197a3c2-0000-7000-8000-0000000000c1");

    /// <summary>
    /// Builds a schema-valid <c>invoke_batch</c> payload with the canonical
    /// Section 11 <c>batch_digest</c> over its own semantics.
    /// </summary>
    internal static JsonElement Payload(
        string batchId,
        bool atomic,
        IReadOnlyList<BatchStepSpec> steps,
        long timeoutMilliseconds = 120_000,
        string recoveryClearancesJson = "[]")
    {
        var ordered = new JsonArray();
        foreach (BatchStepSpec step in steps)
        {
            ordered.Add(
                new JsonObject
                {
                    ["invocation_id"] = step.InvocationId,
                    ["method"] = step.Method,
                    ["params"] = JsonNode.Parse(step.ParametersJson),
                    ["params_digest"] = ParametersDigest(step.ParametersJson),
                    ["mutating"] = step.Mutating,
                    ["mutation_scope"] = step.MutationScopeJson is null
                        ? null
                        : JsonNode.Parse(step.MutationScopeJson),
                    ["policy"] = new JsonObject
                    {
                        ["class"] = step.PolicyClass,
                        ["confirmation_id"] = step.ConfirmationId,
                        ["decision"] = step.Decision,
                    },
                });
        }

        var payload = new JsonObject
        {
            ["batch_id"] = batchId,
            ["atomic"] = atomic,
            ["timeout_ms"] = timeoutMilliseconds,
            ["recovery_clearances"] =
                JsonNode.Parse(recoveryClearancesJson),
            ["steps"] = ordered,
        };

        using (JsonDocument material =
               JsonDocument.Parse(payload.ToJsonString()))
        {
            payload["batch_digest"] = Rfc8785Json.MakeBatchDigest(
                RbpBatchDigestInput.Parse(material.RootElement));
        }

        return Json(payload.ToJsonString());
    }

    internal static string ParametersDigest(string parametersJson) =>
        Rfc8785Json.MakeParametersDigest(Json(parametersJson));

    internal static JsonElement Json(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    internal static RbpAddinOutcome Completed(string resultJson = "{}")
    {
        byte[] raw = Encoding.UTF8.GetBytes(resultJson);
        return new RbpAddinOutcome(
            RbpAddinOutcomeKind.Completed,
            Json(resultJson),
            raw,
            RequestBytes: 128,
            ResponseBytes: raw.Length);
    }

    internal static RbpAddinOutcome Guarded(
        string guardedReason = "policy_guard",
        string resultJson = """{"status":"guarded"}""")
    {
        byte[] raw = Encoding.UTF8.GetBytes(resultJson);
        return new RbpAddinOutcome(
            RbpAddinOutcomeKind.Guarded,
            Json(resultJson),
            raw,
            RequestBytes: 128,
            ResponseBytes: raw.Length,
            GuardedReason: guardedReason);
    }

    internal static RbpAddinOutcome KnownFailure(
        string faultClass = "revit_api",
        string message = "the add-in refused the command") =>
        new(
            RbpAddinOutcomeKind.ApplicationError,
            default,
            [],
            RequestBytes: 128,
            ResponseBytes: 0,
            FaultClass: faultClass,
            Message: message,
            AddinError: new AddinErrorDetail(-32000, message),
            Retryable: false);

    internal static RbpAddinOutcome PossiblyDispatched(
        string message = "the loopback socket closed after the first byte") =>
        new(
            RbpAddinOutcomeKind.PossiblyDispatched,
            default,
            [],
            RequestBytes: 128,
            ResponseBytes: 0,
            Message: message);

    /// <summary>
    /// One step of an Appendix A.4 <c>execute_batch</c> success envelope.
    /// </summary>
    internal sealed record AtomicStepSpec(
        string InvocationId,
        string Method,
        string ExecutionState,
        string EffectState,
        string? ResultJson = null,
        string? GuardedReason = null,
        string? ErrorCode = null,
        string? ErrorMessage = null,
        string? ResultSuppressed = null);

    /// <summary>
    /// Builds an internally consistent Appendix A.4 success envelope: status,
    /// transaction state, failure index, and the rollback record are all
    /// derived from the ordered step states, so a contradiction vector has to
    /// corrupt the envelope on purpose.
    /// </summary>
    internal static RbpAddinOutcome AtomicEnvelope(
        string batchId,
        string batchDigest,
        IReadOnlyList<AtomicStepSpec> steps)
    {
        int? trigger = null;
        for (int index = 0; index < steps.Count; index++)
        {
            if (!string.Equals(
                    steps[index].ExecutionState,
                    "completed",
                    StringComparison.Ordinal))
            {
                trigger = index;
                break;
            }
        }

        var envelope = new JsonObject
        {
            ["resultContractVersion"] = 2,
            ["batchContractVersion"] = 1,
            ["batchId"] = batchId,
            ["batchDigest"] = batchDigest,
            ["atomic"] = true,
            ["status"] = trigger is { } failedIndex
                ? steps[failedIndex].ExecutionState
                : "completed",
            ["transactionState"] = trigger is null
                ? "committed"
                : "rolled_back",
            ["failedStepIndex"] = trigger,
            ["steps"] = BuildSteps(steps),
            ["rollback"] = trigger is { } rollbackIndex
                ? new JsonObject
                {
                    ["attempted"] = true,
                    ["succeeded"] = true,
                    ["triggerStepIndex"] = rollbackIndex,
                    ["triggerState"] = steps[rollbackIndex].ExecutionState,
                }
                : new JsonObject
                {
                    ["attempted"] = false,
                    ["succeeded"] = null,
                    ["triggerStepIndex"] = null,
                    ["triggerState"] = null,
                },
        };

        return AtomicOutcome(envelope);
    }

    internal static RbpAddinOutcome AtomicOutcome(JsonObject envelope)
    {
        string json = envelope.ToJsonString();
        byte[] raw = Encoding.UTF8.GetBytes(json);
        JsonElement body = Json(json);
        bool guarded = string.Equals(
            envelope["status"]?.GetValue<string>(),
            "guarded",
            StringComparison.Ordinal);
        return new RbpAddinOutcome(
            guarded
                ? RbpAddinOutcomeKind.Guarded
                : RbpAddinOutcomeKind.Completed,
            body,
            raw,
            RequestBytes: 512,
            ResponseBytes: raw.Length,
            GuardedReason: guarded ? "unspecified_guarded" : null);
    }

    private static JsonArray BuildSteps(
        IReadOnlyList<AtomicStepSpec> steps)
    {
        var ordered = new JsonArray();
        for (int index = 0; index < steps.Count; index++)
        {
            AtomicStepSpec step = steps[index];
            var entry = new JsonObject
            {
                ["index"] = index,
                ["invocationId"] = step.InvocationId,
                ["method"] = step.Method,
                ["executionState"] = step.ExecutionState,
                ["effectState"] = step.EffectState,
            };
            if (step.ResultJson is { } result)
            {
                entry["result"] = JsonNode.Parse(result);
            }

            if (step.GuardedReason is { } reason)
            {
                entry["guardedReason"] = reason;
            }

            if (step.ResultSuppressed is { } suppressed)
            {
                entry["resultSuppressed"] = suppressed;
            }

            if (step.ErrorCode is { } code)
            {
                entry["error"] = new JsonObject
                {
                    ["code"] = code,
                    ["message"] = step.ErrorMessage ?? code,
                };
            }

            ordered.Add(entry);
        }

        return ordered;
    }
}

/// <summary>
/// A scripted add-in seam. Every call is recorded, and an unscripted call
/// fails the test loudly rather than silently returning a default, because
/// "no add-in byte was written" is exactly what several frozen vectors have
/// to prove.
/// </summary>
internal sealed class StubBatchChannel : IRbpInvocationChannel
{
    private readonly Queue<Func<AddinCall, RbpAddinOutcome>> _script = new();

    internal List<AddinCall> Calls { get; } = [];

    internal StubBatchChannel Then(RbpAddinOutcome outcome)
    {
        _script.Enqueue(_ => outcome);
        return this;
    }

    internal StubBatchChannel Then(Func<AddinCall, RbpAddinOutcome> step)
    {
        _script.Enqueue(step);
        return this;
    }

    internal StubBatchChannel ThenThrow(string message)
    {
        _script.Enqueue(
            _ => throw new InvalidOperationException(message));
        return this;
    }

    public Task<RbpAddinOutcome> InvokeAsync(
        string rsid,
        AddinCall call,
        CancellationToken cancellationToken)
    {
        Calls.Add(call);
        if (_script.Count == 0)
        {
            throw new InvalidOperationException(
                $"Unscripted add-in call to '{call.Method}'.");
        }

        return Task.FromResult(_script.Dequeue()(call));
    }
}

/// <summary>
/// The per-<c>rsid</c> grant and probed descriptor set as a test states them.
/// The two are independent on purpose: an add-in may advertise the descriptor
/// contract an <c>atomic:false</c> fan-out needs while the Gateway has not
/// granted <c>batch_atomic</c> to this session.
/// </summary>
internal sealed class StubBatchCapabilities : IRbpBatchCapabilitySource
{
    private readonly Dictionary<string, RbpBatchCommandDescriptor>
        _descriptors = new(StringComparer.Ordinal);

    internal bool BatchAtomicGranted { get; set; }

    internal long MaximumAggregateResultBytes { get; set; } = 33_554_432;

    internal StubBatchCapabilities Describe(
        string method,
        string effect = "read_only",
        string resultDelivery = "inline_only",
        long maximumInlineResultBytes = 8 * 1024 * 1024)
    {
        _descriptors[method] = new RbpBatchCommandDescriptor(
            method,
            effect,
            resultDelivery,
            maximumInlineResultBytes);
        return this;
    }

    internal static StubBatchCapabilities Standard(
        bool batchAtomicGranted = false) =>
        new StubBatchCapabilities { BatchAtomicGranted = batchAtomicGranted }
            .Describe(RbpBatchCoordinatorTestData.ReadMethod)
            .Describe(RbpBatchCoordinatorTestData.SecondReadMethod)
            .Describe(
                RbpBatchCoordinatorTestData.WriteMethod,
                effect: "model_transaction");

    public Task<RbpBatchCapability> ResolveAsync(
        string rsid,
        CancellationToken cancellationToken) =>
        Task.FromResult(
            new RbpBatchCapability(
                BatchAtomicGranted,
                _descriptors,
                MaximumAggregateResultBytes));
}
