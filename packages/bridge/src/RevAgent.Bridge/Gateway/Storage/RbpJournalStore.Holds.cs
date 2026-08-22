using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Storage;

/// <summary>
/// Frozen O1 Section 6.2.1 clearance acceptance for the mutation-recovery
/// hold authority.
///
/// The deterministic state machine is
/// <c>active -&gt; evidence_recorded -&gt; resolved_pending_bridge -&gt; cleared</c>.
/// Evidence is never clearance:
/// <see cref="RecordHoldVerificationEvidenceAsync"/> only journals
/// verification attempts, and only
/// <see cref="AdmitInvocationWithClearancesAsync"/> may mark a hold
/// <c>cleared</c> — atomically with acceptance of the one evidence-bound
/// mutation, before the caller may write its first add-in byte. A mismatch
/// is a terminal <c>protocol</c> fault, duplicate delivery of the identical
/// clearance is idempotent, and an invalid or inconclusive clearance never
/// transitions the hold and never opens dispatch (Section 21 item 28).
/// </summary>
internal sealed partial class RbpJournalStore
{
    private static void ValidateGroupedHoldMaterial(RbpVerificationHold hold)
    {
        if (hold.OrderedOriginIdempotencyKeys.Count <= 1)
        {
            return;
        }

        using JsonDocument scope = JsonDocument.Parse(hold.ScopeJcs);
        if (Rfc8785Json.Canonicalize(scope.RootElement) != hold.ScopeJcs ||
            Rfc8785Json.MakeVerificationHoldId(
                hold.Rsid,
                scope.RootElement,
                hold.OrderedOriginIdempotencyKeys) !=
            hold.VerificationHoldId)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "Grouped verification hold material is contradictory.");
        }
    }

    private static void RequireGroupedHoldClearanceAuthority(
        RbpVerificationHold hold,
        RbpRecoveryClearance clearance)
    {
        if (hold.OrderedOriginIdempotencyKeys.Count <= 1)
        {
            return;
        }

        if (clearance.Basis == RbpClearanceBasis.LateTerminal)
        {
            throw ClearanceFault(
                "a grouped hold has no atomic aggregate late-terminal " +
                "attestation and requires verification_read");
        }

        ValidateGroupedHoldMaterial(hold);
        if (clearance.VerificationInvocationId is not { Length: > 0 } vid ||
            !RbpRecoveryClearance.IsUuidV7(vid) ||
            hold.State is not (RbpHoldState.EvidenceRecorded or
                RbpHoldState.ResolvedPendingBridge) ||
            hold.VerificationInvocationId != vid ||
            hold.EvidenceDigest != clearance.EvidenceDigest)
        {
            throw ClearanceFault(
                "grouped verification_read lacks matching durable correlated " +
                "Gateway evidence");
        }
    }

    /// <summary>
    /// Journals a verification attempt against an uncleared hold. A
    /// successful read is evidence, not clearance, so the hold keeps
    /// blocking its scope either way; an inconclusive attempt is retained
    /// while the hold stays <c>active</c> and never regresses durable
    /// conclusive evidence. This is the Bridge-internal trusted Gateway
    /// recovery port; parsing caller-supplied <c>recovery_clearances</c> never
    /// invokes it and therefore cannot create the durable evidence it must
    /// later match exactly.
    /// </summary>
    internal Task<RbpVerificationHold> RecordHoldVerificationEvidenceAsync(
        string rsid,
        RbpHoldVerificationEvidence evidence,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), 256);
        ArgumentNullException.ThrowIfNull(evidence);
        if (!RbpRecoveryClearance.IsVerificationHoldId(
                evidence.VerificationHoldId))
        {
            throw new ArgumentException(
                "Value must be vh: plus 64 lowercase hex characters.",
                nameof(evidence));
        }

        if (!RbpRecoveryClearance.IsUuidV7(
                evidence.VerificationInvocationId))
        {
            throw new ArgumentException(
                "Value must be a lowercase UUIDv7.",
                nameof(evidence));
        }

        RequireSha256(evidence.EvidenceDigest, nameof(evidence));
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                RequireActiveSession(context, rsid);
                if (HasOutcomeV3Cutover(context, rsid))
                {
                    return RecordHoldVerificationEvidenceV3(
                        context,
                        rsid,
                        evidence,
                        now);
                }

                RbpVerificationHold hold =
                    FindHoldById(
                        context,
                        rsid,
                        evidence.VerificationHoldId) ??
                    throw ClearanceFault(
                        "verification evidence does not match a durable " +
                        "hold for this session");
                if (hold.State is RbpHoldState.Cleared or
                    RbpHoldState.ResolvedPendingBridge)
                {
                    throw ClearanceFault(
                        "a resolved or cleared hold accepts no further " +
                        "verification evidence");
                }

                if (evidence.Conclusive)
                {
                    using SqliteCommand update = context.CreateCommand(
                        """
                        UPDATE rbp_verification_holds
                        SET state='evidence_recorded',
                            verification_invocation_id=$vid,
                            evidence_digest=$digest,
                            updated_at_ms=MAX(updated_at_ms,$now)
                        WHERE verification_hold_id=$id
                          AND state IN ('active','evidence_recorded');
                        """);
                    update.Parameters.AddWithValue(
                        "$vid",
                        evidence.VerificationInvocationId);
                    update.Parameters.AddWithValue(
                        "$digest",
                        evidence.EvidenceDigest);
                    update.Parameters.AddWithValue("$now", now);
                    update.Parameters.AddWithValue(
                        "$id",
                        evidence.VerificationHoldId);
                    if (update.ExecuteNonQuery() != 1)
                    {
                        throw new RbpJournalException(
                            RbpJournalErrorCode.IntegrityCheckFailed,
                            "The hold verification evidence could not be " +
                            "persisted.");
                    }
                }
                else if (hold.State == RbpHoldState.Active)
                {
                    // The inconclusive attempt is retained as evidence
                    // while the hold stays `active` and blocking.
                    using SqliteCommand retain = context.CreateCommand(
                        """
                        UPDATE rbp_verification_holds
                        SET verification_invocation_id=$vid,
                            evidence_digest=$digest,
                            updated_at_ms=MAX(updated_at_ms,$now)
                        WHERE verification_hold_id=$id AND state='active';
                        """);
                    retain.Parameters.AddWithValue(
                        "$vid",
                        evidence.VerificationInvocationId);
                    retain.Parameters.AddWithValue(
                        "$digest",
                        evidence.EvidenceDigest);
                    retain.Parameters.AddWithValue("$now", now);
                    retain.Parameters.AddWithValue(
                        "$id",
                        evidence.VerificationHoldId);
                    _ = retain.ExecuteNonQuery();
                }

                return FindHoldById(
                           context,
                           rsid,
                           evidence.VerificationHoldId) ??
                       throw new RbpJournalException(
                           RbpJournalErrorCode.IntegrityCheckFailed,
                           "The evidenced hold disappeared inside its own " +
                           "transaction.");
            },
            cancellationToken);
    }

    /// <summary>
    /// Admits an invocation after accepting its Section 6.2.1 recovery
    /// clearances in the same transaction, so hold clearing and the durable
    /// <c>received</c> row are atomic and both committed before the caller
    /// may write the first add-in byte. A fresh mutating envelope that
    /// still conflicts with an uncleared hold is refused: with an empty
    /// clearance list it returns the blocking hold for the original
    /// <c>journal_indeterminate</c> answer; with a non-empty list the whole
    /// transaction fails closed, because the one permitted evidence-bound
    /// envelope carries every conflicting hold. Redelivery of an origin key
    /// is exempt from the conflict block.
    /// </summary>
    internal Task<RbpClearanceGatedAdmission>
        AdmitInvocationWithClearancesAsync(
            RbpInvocationIdentity identity,
            IReadOnlyList<RbpRecoveryClearance> clearances,
            CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(clearances);
        ValidateInvocationIdentity(identity);
        ValidateClearanceShapes(identity, clearances);
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                RequireActiveSession(context, identity.Rsid);
                foreach (RbpRecoveryClearance clearance in clearances)
                {
                    AcceptClearance(
                        context,
                        identity.Rsid,
                        new[] { identity.MutationScopeJcs! },
                        clearance,
                        now);
                }

                // The conflict gate is not re-implemented here: the ordinary
                // admission runs it for every new mutating invocation, so
                // both invoke paths consult the same durable local index
                // through the same query, in the same transaction.
                RbpInvocationAdmissionResult admitted =
                    AdmitInvocation(context, identity, now);
                if (admitted.BlockingHold is { } blocking)
                {
                    if (clearances.Count > 0)
                    {
                        // The one permitted evidence-bound envelope carries
                        // every conflicting hold; a residual conflict proves
                        // this envelope is not it, and the rollback keeps
                        // every hold uncleared.
                        throw ClearanceFault(
                            "the clearance envelope does not cover every " +
                            "hold conflicting with its mutation scope");
                    }

                    return new RbpClearanceGatedAdmission(null, blocking);
                }

                return new RbpClearanceGatedAdmission(admitted, null);
            },
            cancellationToken);
    }

    /// <summary>
    /// Reads a durable hold by its stable correlation id, including cleared
    /// holds retained for the journal retention period.
    /// </summary>
    internal Task<RbpVerificationHold?> GetHoldAsync(
        string rsid,
        string verificationHoldId,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), 256);
        ValidateIdentifier(verificationHoldId, nameof(verificationHoldId), 67);
        return ReadAsync(
            connection =>
            {
                if (HasOutcomeV3Cutover(connection, rsid))
                {
                    return ReadHoldV3(
                        connection,
                        rsid,
                        verificationHoldId);
                }

                using SqliteCommand command = CreateCommand(
                    connection,
                    $"""
                     SELECT {HoldColumns}
                     FROM rbp_verification_holds
                     WHERE verification_hold_id=$id AND rsid=$rsid;
                     """);
                command.CommandTimeout = _commandTimeoutSeconds;
                command.Parameters.AddWithValue("$id", verificationHoldId);
                command.Parameters.AddWithValue("$rsid", rsid);
                return MaterializeHold(command);
            },
            cancellationToken);
    }

    private static void AcceptClearance(
        RbpJournalWriteContext context,
        string rsid,
        IReadOnlyList<string> envelopeScopeJcsList,
        RbpRecoveryClearance clearance,
        long now)
    {
        if (HasOutcomeV3Cutover(context, rsid))
        {
            AcceptClearanceV3(
                context,
                rsid,
                envelopeScopeJcsList,
                clearance,
                now);
            return;
        }

        RbpVerificationHold hold =
            FindHoldById(context, rsid, clearance.HoldId) ??
            throw ClearanceFault(
                "no durable hold matches the clearance for this session");
        if (!string.Equals(
                hold.ScopeJcs,
                clearance.MutationScopeJcs,
                StringComparison.Ordinal))
        {
            throw ClearanceFault(
                "the clearance mutation scope is not the hold's frozen " +
                "scope");
        }

        bool conflicts = false;
        foreach (string envelopeScopeJcs in envelopeScopeJcsList)
        {
            if (ScopeConflicts(envelopeScopeJcs, hold))
            {
                conflicts = true;
                break;
            }
        }

        if (!conflicts)
        {
            // The frozen array contains every and only active holds that
            // conflict with the envelope's mutation scopes.
            throw ClearanceFault(
                "the clearance hold does not conflict with the envelope's " +
                "mutation scope");
        }

        string basis = ToStorageBasis(clearance.Basis);
        string decision = ToStorageDecision(clearance.Decision);
        RequireGroupedHoldClearanceAuthority(hold, clearance);
        if (hold.State == RbpHoldState.Cleared)
        {
            bool identical =
                string.Equals(
                    hold.ResolutionId,
                    clearance.ResolutionId,
                    StringComparison.Ordinal) &&
                string.Equals(
                    hold.ResolutionBasis,
                    basis,
                    StringComparison.Ordinal) &&
                string.Equals(
                    hold.ResolutionDecision,
                    decision,
                    StringComparison.Ordinal) &&
                string.Equals(
                    hold.AuditId,
                    clearance.AuditId,
                    StringComparison.Ordinal) &&
                string.Equals(
                    hold.EvidenceDigest,
                    clearance.EvidenceDigest,
                    StringComparison.Ordinal) &&
                string.Equals(
                    hold.VerificationInvocationId,
                    clearance.VerificationInvocationId,
                    StringComparison.Ordinal);
            if (!identical)
            {
                throw ClearanceFault(
                    "the hold is already cleared by a different " +
                    "resolution; a changed clearance is never idempotent");
            }

            // Duplicate delivery of the identical envelope is idempotent.
            return;
        }

        if (clearance.Basis == RbpClearanceBasis.VerificationRead)
        {
            if (hold.State is not (RbpHoldState.EvidenceRecorded or
                RbpHoldState.ResolvedPendingBridge))
            {
                // An inconclusive or missing verification attempt is not
                // durable conclusive evidence; the hold stays blocking.
                throw ClearanceFault(
                    "the hold has no durable conclusive verification " +
                    "evidence");
            }

            if (!string.Equals(
                    hold.VerificationInvocationId,
                    clearance.VerificationInvocationId,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    hold.EvidenceDigest,
                    clearance.EvidenceDigest,
                    StringComparison.Ordinal))
            {
                throw ClearanceFault(
                    "the clearance does not match the hold's durable " +
                    "verification evidence");
            }
        }
        else if (!HasDurableLateTerminal(
                     context,
                     clearance.HoldId,
                     clearance.EvidenceDigest))
        {
            throw ClearanceFault(
                "no durable conclusive late terminal supports the " +
                "late_terminal clearance");
        }

        using SqliteCommand update = context.CreateCommand(
            """
            UPDATE rbp_verification_holds
            SET state='cleared',
                verification_invocation_id=$vid,
                evidence_digest=$digest,
                resolution_id=$resolution,
                resolution_basis=$basis,
                resolution_decision=$decision,
                audit_id=$audit,
                cleared_at_ms=$now,
                updated_at_ms=MAX(updated_at_ms,$now)
            WHERE verification_hold_id=$id AND state<>'cleared';
            """);
        update.Parameters.AddWithValue(
            "$vid",
            (object?)clearance.VerificationInvocationId ?? DBNull.Value);
        update.Parameters.AddWithValue("$digest", clearance.EvidenceDigest);
        update.Parameters.AddWithValue(
            "$resolution",
            clearance.ResolutionId);
        update.Parameters.AddWithValue("$basis", basis);
        update.Parameters.AddWithValue("$decision", decision);
        update.Parameters.AddWithValue("$audit", clearance.AuditId);
        update.Parameters.AddWithValue("$now", now);
        update.Parameters.AddWithValue("$id", clearance.HoldId);
        if (update.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The hold clearance could not be persisted.");
        }
    }

    private static void ValidateClearanceShapes(
        RbpInvocationIdentity identity,
        IReadOnlyList<RbpRecoveryClearance> clearances)
    {
        if (clearances.Count == 0)
        {
            return;
        }

        if (!identity.Mutating)
        {
            throw ClearanceFault(
                "only the one evidence-bound mutating envelope may carry " +
                "recovery clearances");
        }

        ValidateClearanceEnvelopeShapes(clearances);
    }

    private static void ValidateClearanceEnvelopeShapes(
        IReadOnlyList<RbpRecoveryClearance> clearances)
    {
        var holdIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (RbpRecoveryClearance clearance in clearances)
        {
            if (clearance is null)
            {
                throw new ArgumentException(
                    "Clearance entries must not be null.",
                    nameof(clearances));
            }

            bool shapeValid =
                RbpRecoveryClearance.IsVerificationHoldId(
                    clearance.HoldId) &&
                RbpRecoveryClearance.IsUuidV7(clearance.ResolutionId) &&
                RbpRecoveryClearance.IsUuidV7(clearance.AuditId) &&
                RbpJournalSerialization.IsSha256Digest(
                    clearance.EvidenceDigest) &&
                clearance.MutationScopeJcs is { Length: > 0 } &&
                (clearance.Basis == RbpClearanceBasis.VerificationRead
                    ? RbpRecoveryClearance.IsUuidV7(
                        clearance.VerificationInvocationId)
                    : clearance.VerificationInvocationId is null);
            if (!shapeValid || !holdIds.Add(clearance.HoldId))
            {
                throw ClearanceFault(
                    "a clearance entry violates the frozen envelope shape");
            }
        }
    }

    private static bool ScopeConflicts(
        string envelopeScopeJcs,
        RbpVerificationHold hold)
    {
        if (string.Equals(
                hold.ScopeJcs,
                envelopeScopeJcs,
                StringComparison.Ordinal))
        {
            return true;
        }

        (string envelopeKind, _) = ReadScopeShape(envelopeScopeJcs);
        return string.Equals(
                   hold.ScopeKind,
                   "session",
                   StringComparison.Ordinal) ||
               string.Equals(
                   envelopeKind,
                   "session",
                   StringComparison.Ordinal);
    }

    private static bool HasDurableLateTerminal(
        RbpJournalWriteContext context,
        string verificationHoldId,
        string evidenceDigest)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT COUNT(*)
            FROM rbp_invocations
            WHERE verification_hold_id=$hold
              AND state='indeterminate'
              AND late_result_digest=$digest;
            """);
        command.Parameters.AddWithValue("$hold", verificationHoldId);
        command.Parameters.AddWithValue("$digest", evidenceDigest);
        return Convert.ToInt64(command.ExecuteScalar()) != 0;
    }

    private static RbpVerificationHold? FindHoldById(
        RbpJournalWriteContext context,
        string rsid,
        string verificationHoldId)
    {
        if (HasOutcomeV3Cutover(context, rsid))
        {
            return ReadHoldV3(context, rsid, verificationHoldId);
        }

        using SqliteCommand command = context.CreateCommand(
            $"""
             SELECT {HoldColumns}
             FROM rbp_verification_holds
             WHERE verification_hold_id=$id AND rsid=$rsid;
             """);
        command.Parameters.AddWithValue("$id", verificationHoldId);
        command.Parameters.AddWithValue("$rsid", rsid);
        return MaterializeHold(command);
    }

    /// <summary>
    /// The frozen conflict query against the durable local index, inside
    /// the admission transaction: an exact scope match conflicts, and a
    /// session-scope hold additionally conflicts with every document scope
    /// under the same <c>rsid</c> (and vice versa).
    /// </summary>
    private static RbpVerificationHold? FindConflictingHold(
        RbpJournalWriteContext context,
        string rsid,
        string scopeJcs)
    {
        if (HasOutcomeV3Cutover(context, rsid))
        {
            return FindConflictingHoldV3(context, rsid, scopeJcs);
        }

        (string scopeKind, _) = ReadScopeShape(scopeJcs);
        using SqliteCommand command = context.CreateCommand(
            $"""
             SELECT {HoldColumns}
             FROM rbp_verification_holds
             WHERE rsid=$rsid
               AND state<>'cleared'
               AND (
                 scope_jcs=$scope
                 OR scope_kind='session'
                 OR $kind='session'
               )
             ORDER BY created_at_ms ASC
             LIMIT 1;
             """);
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$scope", scopeJcs);
        command.Parameters.AddWithValue("$kind", scopeKind);
        return MaterializeHold(command);
    }

    private static string ToStorageBasis(RbpClearanceBasis basis) =>
        basis switch
        {
            RbpClearanceBasis.VerificationRead => "verification_read",
            RbpClearanceBasis.LateTerminal => "late_terminal",
            _ => throw new ArgumentOutOfRangeException(nameof(basis)),
        };

    private static string ToStorageDecision(
        RbpClearanceDecision decision) =>
        decision switch
        {
            RbpClearanceDecision.NonExecutionProven =>
                "non_execution_proven",
            RbpClearanceDecision.PostconditionVerified =>
                "postcondition_verified",
            _ => throw new ArgumentOutOfRangeException(nameof(decision)),
        };

    private static RbpJournalException ClearanceFault(string reason) =>
        new(
            RbpJournalErrorCode.ProtocolConflict,
            "Section 6.2.1 clearance acceptance failed closed: " +
            reason + ".");
}
