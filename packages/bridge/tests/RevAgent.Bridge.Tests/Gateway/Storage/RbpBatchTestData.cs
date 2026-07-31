using System.Text.Json;
using System.Text.Json.Nodes;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

/// <summary>
/// Builders for frozen Section 11/12 batch identities. The batch digest is
/// computed by round-tripping the identity through the on-wire payload shape
/// and the frozen <see cref="RbpBatchDigestInput"/> parser, so the journal's
/// internal digest material is independently cross-checked; the digest
/// engine itself is anchored to the spec example by the golden-vector suite.
/// </summary>
internal static class RbpBatchTestData
{
    internal const string EmptyObjectDigest =
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

    internal const string DocumentOneScope =
        """{"document_id":"doc-1","kind":"document"}""";

    internal const string DocumentTwoScope =
        """{"document_id":"doc-2","kind":"document"}""";

    internal static RbpBatchStepIdentity ReadStep(
        string invocationId,
        string method = "get_current_view_info") =>
        new(
            invocationId,
            method,
            Mutating: false,
            MutationScopeJcs: null,
            ParamsDigest: EmptyObjectDigest,
            PolicyClass: "auto",
            ConfirmationId: null,
            Decision: "allowed");

    internal static RbpBatchStepIdentity WriteStep(
        string invocationId,
        string scopeJcs = DocumentOneScope,
        string method = "create_wall",
        string paramsDigest = "",
        string decision = "confirmed") =>
        new(
            invocationId,
            method,
            Mutating: true,
            MutationScopeJcs: scopeJcs,
            ParamsDigest: paramsDigest.Length > 0
                ? paramsDigest
                : "sha256:" + new string('a', 64),
            PolicyClass: "confirm",
            ConfirmationId: "confirmation-1",
            Decision: decision);

    internal static RbpBatchIdentity Batch(
        bool atomic,
        string batchId,
        IReadOnlyList<RbpBatchStepIdentity> steps,
        string clearancesJcs = "[]",
        long timeoutMilliseconds = 120_000,
        string rsid = "rs-test")
    {
        var identity = new RbpBatchIdentity(
            rsid,
            batchId,
            "sha256:" + new string('0', 64),
            atomic,
            timeoutMilliseconds,
            clearancesJcs,
            steps);
        return identity with { BatchDigest = ComputeBatchDigest(identity) };
    }

    internal static string ComputeBatchDigest(RbpBatchIdentity identity)
    {
        var steps = new JsonArray();
        foreach (RbpBatchStepIdentity step in identity.Steps)
        {
            steps.Add(
                new JsonObject
                {
                    ["invocation_id"] = step.InvocationId,
                    ["method"] = step.Method,
                    ["mutating"] = step.Mutating,
                    ["mutation_scope"] = step.MutationScopeJcs is null
                        ? null
                        : JsonNode.Parse(step.MutationScopeJcs),
                    ["params_digest"] = step.ParamsDigest,
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
            ["batch_id"] = identity.BatchId,
            ["atomic"] = identity.Atomic,
            ["timeout_ms"] = identity.TimeoutMilliseconds,
            ["recovery_clearances"] =
                JsonNode.Parse(identity.RecoveryClearancesJcs),
            ["steps"] = steps,
        };
        using JsonDocument document =
            JsonDocument.Parse(payload.ToJsonString());
        return Rfc8785Json.MakeBatchDigest(
            RbpBatchDigestInput.Parse(document.RootElement));
    }

    internal static string ClearanceArrayJcs(RbpRecoveryClearance clearance)
    {
        var envelope = new JsonArray
        {
            new JsonObject
            {
                ["hold_id"] = clearance.HoldId,
                ["mutation_scope"] =
                    JsonNode.Parse(clearance.MutationScopeJcs),
                ["resolution_id"] = clearance.ResolutionId,
                ["basis"] =
                    clearance.Basis == RbpClearanceBasis.VerificationRead
                        ? "verification_read"
                        : "late_terminal",
                ["verification_invocation_id"] =
                    clearance.VerificationInvocationId,
                ["evidence_digest"] = clearance.EvidenceDigest,
                ["decision"] =
                    clearance.Decision ==
                    RbpClearanceDecision.NonExecutionProven
                        ? "non_execution_proven"
                        : "postcondition_verified",
                ["audit_id"] = clearance.AuditId,
            },
        };
        using JsonDocument document =
            JsonDocument.Parse(envelope.ToJsonString());
        return Rfc8785Json.Canonicalize(document.RootElement);
    }

    internal static RbpInvocationTerminal StepTerminal(
        RbpInvocationState state,
        string outcomeJson)
    {
        JsonElement outcome = RbpJournalTestData.Json(outcomeJson);
        return new RbpInvocationTerminal(
            state,
            outcome,
            Rfc8785Json.Sha256Digest(outcome));
    }

    internal static RbpBatchTerminal BatchTerminal(string outcomeJson)
    {
        JsonElement outcome = RbpJournalTestData.Json(outcomeJson);
        return new RbpBatchTerminal(
            outcome,
            Rfc8785Json.Sha256Digest(outcome));
    }

    /// <summary>
    /// Installs an active Section 6.2.1 hold by refusing the redelivery of
    /// a possibly dispatched single mutation on the supplied scope.
    /// </summary>
    internal static async Task<string> InstallActiveHoldAsync(
        RbpJournalStore store,
        string scopeJcs,
        string invocationId)
    {
        var identity = new RbpInvocationIdentity(
            "rs-test",
            invocationId,
            "set_element_parameter",
            Mutating: true,
            MutationScopeJcs: scopeJcs,
            ParamsDigest: "sha256:" + new string('b', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        RbpInvocationAdmissionResult refused =
            await store.AdmitInvocationAsync(identity);
        Assert.Equal(
            RbpInvocationAdmission.RefuseIndeterminate,
            refused.Admission);
        return refused.VerificationHoldId!;
    }

    internal static string StepKey(string invocationId) =>
        "rs-test/" + invocationId;
}
