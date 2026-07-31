using System.Text.Json;

namespace RevAgent.Bridge.Gateway.Protocol;

/// <summary>
/// Frozen O1 Section 6.2.1 clearance basis. <c>verification_read</c> binds
/// the clearance to the hold's durable correlated verification evidence;
/// <c>late_terminal</c> binds it to a durable conclusive late add-in
/// outcome retained after <c>journal_indeterminate</c>.
/// </summary>
internal enum RbpClearanceBasis
{
    VerificationRead,
    LateTerminal,
}

/// <summary>
/// Frozen O1 Section 6.2.1 clearance decision. The enum is closed on
/// purpose: no <c>inconclusive</c> value exists because an inconclusive
/// attempt is retained evidence, never a clearance.
/// </summary>
internal enum RbpClearanceDecision
{
    NonExecutionProven,
    PostconditionVerified,
}

/// <summary>
/// One frozen Section 6.2.1 <c>recovery_clearances[]</c> entry. Every
/// displayed envelope field is REQUIRED, and <see cref="Parse"/> is the one
/// seam between wire validation and journal acceptance: an entry that
/// cannot become an acceptance input fails closed at the boundary and can
/// never transition a hold or open dispatch.
/// </summary>
internal sealed record RbpRecoveryClearance(
    string HoldId,
    string MutationScopeJcs,
    string ResolutionId,
    RbpClearanceBasis Basis,
    string? VerificationInvocationId,
    string EvidenceDigest,
    RbpClearanceDecision Decision,
    string AuditId)
{
    internal static RbpRecoveryClearance Parse(JsonElement clearance)
    {
        if (clearance.ValueKind != JsonValueKind.Object)
        {
            throw Invalid("a recovery clearance must be an object");
        }

        string holdId = RequiredString(clearance, "hold_id");
        if (!IsVerificationHoldId(holdId))
        {
            throw Invalid(
                "hold_id must be vh: plus 64 lowercase hex characters");
        }

        string resolutionId = RequiredString(clearance, "resolution_id");
        if (!IsUuidV7(resolutionId))
        {
            throw Invalid("resolution_id must be a lowercase UUIDv7");
        }

        string auditId = RequiredString(clearance, "audit_id");
        if (!IsUuidV7(auditId))
        {
            throw Invalid("audit_id must be a lowercase UUIDv7");
        }

        string evidenceDigest = RequiredString(clearance, "evidence_digest");
        if (!IsSha256Digest(evidenceDigest))
        {
            throw Invalid(
                "evidence_digest must be sha256: plus 64 lowercase hex " +
                "characters");
        }

        RbpClearanceBasis basis =
            RequiredString(clearance, "basis") switch
            {
                "verification_read" => RbpClearanceBasis.VerificationRead,
                "late_terminal" => RbpClearanceBasis.LateTerminal,
                _ => throw Invalid(
                    "basis must be verification_read or late_terminal"),
            };

        // The decision enum is closed: any other value, including
        // "inconclusive", is not a clearance.
        RbpClearanceDecision decision =
            RequiredString(clearance, "decision") switch
            {
                "non_execution_proven" =>
                    RbpClearanceDecision.NonExecutionProven,
                "postcondition_verified" =>
                    RbpClearanceDecision.PostconditionVerified,
                _ => throw Invalid(
                    "decision must be non_execution_proven or " +
                    "postcondition_verified; no inconclusive value is a " +
                    "clearance"),
            };

        if (!clearance.TryGetProperty(
                "verification_invocation_id",
                out JsonElement verification))
        {
            throw Invalid("verification_invocation_id is required");
        }

        string? verificationInvocationId;
        if (basis == RbpClearanceBasis.VerificationRead)
        {
            verificationInvocationId =
                verification.ValueKind == JsonValueKind.String
                    ? verification.GetString()
                    : null;
            if (!IsUuidV7(verificationInvocationId))
            {
                throw Invalid(
                    "verification_invocation_id must be a lowercase UUIDv7 " +
                    "for the verification_read basis");
            }
        }
        else
        {
            if (verification.ValueKind != JsonValueKind.Null)
            {
                throw Invalid(
                    "verification_invocation_id must be explicit null for " +
                    "the late_terminal basis");
            }

            verificationInvocationId = null;
        }

        if (!clearance.TryGetProperty(
                "mutation_scope",
                out JsonElement scope))
        {
            throw Invalid("mutation_scope is required");
        }

        return new RbpRecoveryClearance(
            holdId,
            CanonicalScope(scope),
            resolutionId,
            basis,
            verificationInvocationId,
            evidenceDigest,
            decision,
            auditId);
    }

    internal static bool IsVerificationHoldId(string? value)
    {
        if (value is null ||
            value.Length != 67 ||
            !value.StartsWith("vh:", StringComparison.Ordinal))
        {
            return false;
        }

        for (int index = 3; index < value.Length; index++)
        {
            if (!IsLowerHex(value[index]))
            {
                return false;
            }
        }

        return true;
    }

    internal static bool IsUuidV7(string? value)
    {
        if (value is null || value.Length != 36)
        {
            return false;
        }

        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (index is 8 or 13 or 18 or 23)
            {
                if (character != '-')
                {
                    return false;
                }
            }
            else if (!IsLowerHex(character))
            {
                return false;
            }
        }

        return value[14] == '7' &&
               value[19] is '8' or '9' or 'a' or 'b';
    }

    internal static bool IsSha256Digest(string? value)
    {
        if (value is null ||
            value.Length != 71 ||
            !value.StartsWith("sha256:", StringComparison.Ordinal))
        {
            return false;
        }

        for (int index = 7; index < value.Length; index++)
        {
            if (!IsLowerHex(value[index]))
            {
                return false;
            }
        }

        return true;
    }

    private static string CanonicalScope(JsonElement scope)
    {
        if (scope.ValueKind != JsonValueKind.Object ||
            !scope.TryGetProperty("kind", out JsonElement kind) ||
            kind.ValueKind != JsonValueKind.String)
        {
            throw Invalid("mutation_scope requires a string kind");
        }

        string scopeKind = kind.GetString() ?? string.Empty;
        bool documentScope =
            string.Equals(scopeKind, "document", StringComparison.Ordinal);
        if (!documentScope &&
            !string.Equals(scopeKind, "session", StringComparison.Ordinal))
        {
            throw Invalid("mutation_scope kind must be session or document");
        }

        if (documentScope &&
            (!scope.TryGetProperty(
                 "document_id",
                 out JsonElement documentId) ||
             documentId.ValueKind != JsonValueKind.String ||
             documentId.GetString() is not { Length: > 0 }))
        {
            throw Invalid(
                "a document mutation_scope requires a non-empty document_id");
        }

        try
        {
            return Rfc8785Json.Canonicalize(scope);
        }
        catch (Exception exception) when (
            exception is RbpFrameException or
                InvalidOperationException or
                FormatException)
        {
            throw Invalid("mutation_scope is not RFC 8785 JSON");
        }
    }

    private static string RequiredString(JsonElement owner, string name)
    {
        if (!owner.TryGetProperty(name, out JsonElement value) ||
            value.ValueKind != JsonValueKind.String)
        {
            throw Invalid($"{name} must be a string");
        }

        return value.GetString() ?? string.Empty;
    }

    private static bool IsLowerHex(char character) =>
        (character >= '0' && character <= '9') ||
        (character >= 'a' && character <= 'f');

    private static FormatException Invalid(string message) =>
        new(message);
}
