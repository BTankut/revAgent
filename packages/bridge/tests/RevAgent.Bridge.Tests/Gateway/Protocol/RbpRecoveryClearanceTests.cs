using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Protocol;

/// <summary>
/// Frozen O1 Section 6.2.1 conformance for the typed clearance parse — the
/// one seam between wire validation and journal acceptance. Every displayed
/// envelope field is REQUIRED and no inconclusive value is a clearance.
/// </summary>
public sealed class RbpRecoveryClearanceTests
{
    private const string SpecificationExample = """
        {
          "hold_id": "vh:9c6c84634429ac77c06a69a975688e815a44217a9e47c7a845dd7da4dbcb6a7b",
          "mutation_scope": {"kind":"document","document_id":"doc_session_stable_id"},
          "resolution_id": "0197a3c2-0000-7000-8000-000000000101",
          "basis": "verification_read",
          "verification_invocation_id": "0197a3c2-0000-7000-8000-000000000099",
          "evidence_digest": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "decision": "postcondition_verified",
          "audit_id": "0197a3c2-0000-7000-8000-000000000102"
        }
        """;

    [Fact]
    public void ParseAcceptsTheFrozenSpecificationExample()
    {
        using JsonDocument document =
            JsonDocument.Parse(SpecificationExample);

        RbpRecoveryClearance parsed =
            RbpRecoveryClearance.Parse(document.RootElement);

        Assert.Equal(
            "vh:9c6c84634429ac77c06a69a975688e815a44217a9e47c7a845" +
            "dd7da4dbcb6a7b",
            parsed.HoldId);
        Assert.Equal(
            """{"document_id":"doc_session_stable_id","kind":"document"}""",
            parsed.MutationScopeJcs);
        Assert.Equal(
            "0197a3c2-0000-7000-8000-000000000101",
            parsed.ResolutionId);
        Assert.Equal(RbpClearanceBasis.VerificationRead, parsed.Basis);
        Assert.Equal(
            "0197a3c2-0000-7000-8000-000000000099",
            parsed.VerificationInvocationId);
        Assert.Equal(
            "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e83" +
            "10c060f61caaff8a",
            parsed.EvidenceDigest);
        Assert.Equal(
            RbpClearanceDecision.PostconditionVerified,
            parsed.Decision);
        Assert.Equal(
            "0197a3c2-0000-7000-8000-000000000102",
            parsed.AuditId);
    }

    [Fact]
    public void ParseAcceptsALateTerminalClearanceWithExplicitNull()
    {
        using JsonDocument document = JsonDocument.Parse(
            Mutated(
                "\"basis\": \"verification_read\"",
                "\"basis\": \"late_terminal\"",
                "\"verification_invocation_id\": " +
                "\"0197a3c2-0000-7000-8000-000000000099\"",
                "\"verification_invocation_id\": null"));

        RbpRecoveryClearance parsed =
            RbpRecoveryClearance.Parse(document.RootElement);

        Assert.Equal(RbpClearanceBasis.LateTerminal, parsed.Basis);
        Assert.Null(parsed.VerificationInvocationId);
    }

    [Theory]
    [InlineData(
        "\"decision\": \"postcondition_verified\"",
        "\"decision\": \"inconclusive\"")]
    [InlineData(
        "\"decision\": \"postcondition_verified\"",
        "\"decision\": \"operator_override\"")]
    [InlineData(
        "\"basis\": \"verification_read\"",
        "\"basis\": \"operator_hunch\"")]
    [InlineData(
        "\"hold_id\": \"vh:9c6c84634429ac77c06a69a975688e815a44217a9e47c7a845dd7da4dbcb6a7b\"",
        "\"hold_id\": \"vh:short\"")]
    [InlineData(
        "\"evidence_digest\": \"sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\"",
        "\"evidence_digest\": \"sha256:zz136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\"")]
    [InlineData(
        "\"resolution_id\": \"0197a3c2-0000-7000-8000-000000000101\"",
        "\"resolution_id\": \"0197a3c2-0000-4000-8000-000000000101\"")]
    [InlineData(
        "\"audit_id\": \"0197a3c2-0000-7000-8000-000000000102\"",
        "\"audit_id\": \"0197A3C2-0000-7000-8000-000000000102\"")]
    [InlineData(
        "\"verification_invocation_id\": \"0197a3c2-0000-7000-8000-000000000099\"",
        "\"verification_invocation_id\": null")]
    [InlineData(
        "\"audit_id\": \"0197a3c2-0000-7000-8000-000000000102\"",
        "\"unrelated\": \"0197a3c2-0000-7000-8000-000000000102\"")]
    [InlineData(
        "\"mutation_scope\": {\"kind\":\"document\",\"document_id\":\"doc_session_stable_id\"}",
        "\"mutation_scope\": {\"kind\":\"document\"}")]
    [InlineData(
        "\"mutation_scope\": {\"kind\":\"document\",\"document_id\":\"doc_session_stable_id\"}",
        "\"mutation_scope\": {\"kind\":\"workset\",\"document_id\":\"doc_session_stable_id\"}")]
    public void ParseFailsClosedOnEveryInvalidEnvelopeShape(
        string original,
        string replacement)
    {
        using JsonDocument document = JsonDocument.Parse(
            Mutated(original, replacement));

        _ = Assert.Throws<FormatException>(
            () => RbpRecoveryClearance.Parse(document.RootElement));
    }

    [Fact]
    public void ANonNullVerificationIdNeverSupportsTheLateTerminalBasis()
    {
        using JsonDocument document = JsonDocument.Parse(
            Mutated(
                "\"basis\": \"verification_read\"",
                "\"basis\": \"late_terminal\""));

        _ = Assert.Throws<FormatException>(
            () => RbpRecoveryClearance.Parse(document.RootElement));
    }

    private static string Mutated(params string[] pairs)
    {
        string value = SpecificationExample;
        for (int index = 0; index < pairs.Length; index += 2)
        {
            Assert.Contains(pairs[index], value, StringComparison.Ordinal);
            value = value.Replace(
                pairs[index],
                pairs[index + 1],
                StringComparison.Ordinal);
        }

        return value;
    }
}
