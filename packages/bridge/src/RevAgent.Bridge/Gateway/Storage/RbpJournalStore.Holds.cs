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
    private sealed record RbpAdmissionConsumer(
        string Kind,
        string Rsid,
        string Key,
        string IdentityDigest,
        IReadOnlyList<string> MutationScopesJcs,
        bool ExistingExactReplay);

    private sealed record RbpClearanceTransition(
        RbpVerificationHold Before,
        RbpRecoveryClearance Clearance,
        bool RequiresWrite);

    private sealed record RbpClearancePlan(
        RbpAdmissionConsumer Consumer,
        IReadOnlyList<RbpClearanceTransition> Entries,
        RbpProjectedHoldView ProjectedView,
        string PlanDigest);

    /// <summary>
    /// Journals a verification attempt against an uncleared hold. A
    /// successful read is evidence, not clearance, so the hold keeps
    /// blocking its scope either way; an inconclusive attempt is retained
    /// while the hold stays <c>active</c> and never regresses durable
    /// conclusive evidence.
    /// </summary>
    internal Task<RbpVerificationHold> RecordHoldVerificationEvidenceAsync(
        string rsid,
        RbpHoldVerificationEvidence evidence,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(evidence);
        ValidateIdentifier(rsid, nameof(rsid), 256);
        RequireSha256(evidence.EvidenceDigest, nameof(evidence));
        // Compatibility lookup only. A caller flag can neither manufacture
        // evidence nor override the joint terminal/candidate producer.
        return ReadAsync(connection =>
        {
            using SqliteTransaction transaction = connection.BeginTransaction(deferred: true);
            var context = new RbpJournalWriteContext(connection, transaction, _commandTimeoutSeconds);
            RequireActiveSession(context, rsid);
            RbpVerificationHold hold = FindHoldById(context, rsid, evidence.VerificationHoldId) ??
                throw ClearanceFault("no durable hold matches this verification lookup");
            if (!HasEligibleVerificationRead(context, hold, evidence.VerificationInvocationId, evidence.EvidenceDigest) ||
                hold.State != RbpHoldState.EvidenceRecorded ||
                hold.VerificationInvocationId != evidence.VerificationInvocationId ||
                hold.EvidenceDigest != evidence.EvidenceDigest)
                throw ClearanceFault("only a production-written correlated read candidate is evidence");
            return hold;
        }, cancellationToken);
    }

    private static bool HasEligibleVerificationRead(RbpJournalWriteContext context,
        RbpVerificationHold hold, string? invocationId, string evidenceDigest)
    {
        if (invocationId is null) return false;
        RbpStoredInvocation? read = ReadInvocation(context, hold.Rsid + "/" + invocationId);
        if (read is null || read.Identity.Mutating || read.State != RbpInvocationState.Completed ||
            read.Identity.Rsid != hold.Rsid || read.Identity.InvocationId != invocationId ||
            read.ResultDigest != evidenceDigest || read.VerificationCorrelationJson is null)
            return false;
        using System.Text.Json.JsonDocument correlation = ReadVerificationCorrelation(read);
        System.Text.Json.JsonElement root = correlation.RootElement;
        System.Text.Json.JsonElement verification = root.GetProperty("verification");
        System.Text.Json.JsonElement terminal = root.GetProperty("terminal");
        return verification.GetProperty("hold_id").GetString() == hold.VerificationHoldId &&
            Rfc8785Json.Canonicalize(verification.GetProperty("mutation_scope")) == hold.ScopeJcs &&
            terminal.ValueKind == System.Text.Json.JsonValueKind.Object &&
            terminal.EnumerateObject().Count() == 3 &&
            terminal.GetProperty("status").GetString() == "completed" &&
            terminal.GetProperty("eligible").ValueKind == System.Text.Json.JsonValueKind.True &&
            terminal.GetProperty("raw_response_digest").GetString() == evidenceDigest;
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
        RbpClearanceGatedAdmission Operation(RbpJournalWriteContext context)
        {
            RequireActiveSession(context, identity.Rsid);
            RbpStoredInvocation? existing =
                ReadInvocation(context, identity.IdempotencyKey);
            if (existing is not null)
                RequireIdenticalIdentity(existing.Identity, identity);
            RbpAdmissionConsumer consumer = InvocationConsumer(identity,
                existing is not null);
            RbpClearancePlan plan = ValidateClearancePlan(context, consumer,
                identity.RecoveryClearancesJcs, clearances, now);
            RbpLegacySafetyPlan safety = ClassifyLegacySafety(context,
                RbpLegacySafetyQuery.ForAdmission(identity.Rsid,
                    consumer.MutationScopesJcs,
                    existing?.Identity.IdempotencyKey), plan.ProjectedView,
                RbpLegacySafetyBudget.Admission);
            if (safety.Outcome == RbpLegacySafetyOutcome.InventoryLimit)
                throw LegacyAdmissionFault("legacy_inventory_limit");
            if (safety.Outcome == RbpLegacySafetyOutcome.Unsafe)
            {
                if (clearances.Count != 0)
                    throw LegacyAdmissionFault("legacy_outcome_unverified");
                InstallLegacyHoldPlans(context, safety.NewHoldPlans, now);
            }
            else
            {
                InstallLegacyHoldPlans(context, safety.NewHoldPlans, now);
                ApplyClearancePlan(context, plan, now);
            }

            RbpInvocationAdmissionResult admitted =
                AdmitInvocation(context, identity, now);
            if (admitted.BlockingHold is { } blocking)
            {
                if (clearances.Count > 0)
                {
                    throw ClearanceFault(
                        "the clearance envelope does not cover every " +
                        "hold conflicting with its mutation scope");
                }

                return new RbpClearanceGatedAdmission(null, blocking);
            }
            return new RbpClearanceGatedAdmission(admitted, null);
        }

        if (clearances.Count == 0)
            return ExecuteImmediateAsync(Operation, cancellationToken);
        IReadOnlyDictionary<string, string> holdRsids = clearances
            .ToDictionary(clearance => clearance.HoldId,
                _ => identity.Rsid, StringComparer.Ordinal);
        return ExecuteProvenDecisionAsync(Operation,
            new[] { identity.IdempotencyKey }, batchKey: null,
            cancellationToken, allowRetry: true,
            additionalHoldRsids: holdRsids);
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
            if (!HasEligibleVerificationRead(context, hold, clearance.VerificationInvocationId, clearance.EvidenceDigest))
                throw ClearanceFault("the clearance has no matching production-written verification terminal");
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

    private static RbpAdmissionConsumer InvocationConsumer(
        RbpInvocationIdentity identity,
        bool existingExactReplay)
    {
        JsonElement material = JsonSerializer.SerializeToElement(identity);
        return new RbpAdmissionConsumer("invocation", identity.Rsid,
            identity.IdempotencyKey, Rfc8785Json.Sha256Digest(material),
            identity.Mutating && identity.MutationScopeJcs is { } scope
                ? new[] { scope }
                : Array.Empty<string>(), existingExactReplay);
    }

    private static RbpAdmissionConsumer BatchConsumer(
        RbpBatchIdentity identity,
        bool existingExactReplay) =>
        new("batch", identity.Rsid, identity.BatchKey, identity.BatchDigest,
            MutatingScopes(identity), existingExactReplay);

    private static RbpClearancePlan ValidateClearancePlan(
        RbpJournalWriteContext context,
        RbpAdmissionConsumer consumer,
        string boundClearancesJcs,
        IReadOnlyList<RbpRecoveryClearance> clearances,
        long now)
    {
        ValidateClearanceEnvelopeShapes(clearances);
        using JsonDocument bound = JsonDocument.Parse(boundClearancesJcs);
        if (bound.RootElement.ValueKind != JsonValueKind.Array ||
            bound.RootElement.GetArrayLength() != clearances.Count ||
            Rfc8785Json.Canonicalize(bound.RootElement) != boundClearancesJcs)
            throw ClearanceFault(
                "the durable consumer clearance binding is not an exact canonical array");
        string? previous = null;
        int index = 0;
        foreach (JsonElement item in bound.RootElement.EnumerateArray())
        {
            RbpRecoveryClearance parsed = RbpRecoveryClearance.Parse(item);
            if (parsed != clearances[index] ||
                (previous is not null && string.CompareOrdinal(previous,
                    parsed.HoldId) >= 0))
                throw ClearanceFault(
                    "the caller clearance list is not sorted, unique and exactly identity-bound");
            previous = parsed.HoldId;
            index++;
        }

        var transitions = new List<RbpClearanceTransition>(clearances.Count);
        var projected = new Dictionary<string, RbpVerificationHold>(
            StringComparer.Ordinal);
        foreach (RbpRecoveryClearance clearance in clearances)
        {
            RbpVerificationHold hold = ValidateClearance(context, consumer,
                clearance);
            bool requiresWrite = hold.State != RbpHoldState.Cleared;
            RbpVerificationHold projectedHold = requiresWrite
                ? hold with
                {
                    State = RbpHoldState.Cleared,
                    VerificationInvocationId = clearance.VerificationInvocationId,
                    EvidenceDigest = clearance.EvidenceDigest,
                    ResolutionId = clearance.ResolutionId,
                    ResolutionBasis = ToStorageBasis(clearance.Basis),
                    ResolutionDecision = ToStorageDecision(clearance.Decision),
                    AuditId = clearance.AuditId,
                    UpdatedAtMilliseconds = Math.Max(hold.UpdatedAtMilliseconds, now),
                    ClearedAtMilliseconds = now,
                }
                : hold;
            transitions.Add(new RbpClearanceTransition(hold, clearance,
                requiresWrite));
            projected.Add(hold.VerificationHoldId, projectedHold);
        }
        JsonElement material = JsonSerializer.SerializeToElement(new
        {
            consumer,
            entries = transitions.Select(entry => new
            {
                before = entry.Before,
                clearance = entry.Clearance,
                entry.RequiresWrite,
            }),
        });
        return new RbpClearancePlan(consumer, transitions.AsReadOnly(),
            new RbpProjectedHoldView(projected),
            Rfc8785Json.Sha256Digest(material));
    }

    private static RbpVerificationHold ValidateClearance(
        RbpJournalWriteContext context,
        RbpAdmissionConsumer consumer,
        RbpRecoveryClearance clearance)
    {
        RbpVerificationHold hold = FindHoldById(context, consumer.Rsid,
            clearance.HoldId) ?? throw ClearanceFault(
                "no durable hold matches the clearance for this session");
        if (hold.ScopeJcs != clearance.MutationScopeJcs ||
            !consumer.MutationScopesJcs.Any(scope => ScopeConflicts(scope, hold)))
            throw ClearanceFault(
                "the clearance scope does not conflict with its exact consumer");
        string basis = ToStorageBasis(clearance.Basis);
        string decision = ToStorageDecision(clearance.Decision);
        if (hold.State == RbpHoldState.Cleared)
        {
            bool identical = hold.ResolutionId == clearance.ResolutionId &&
                hold.ResolutionBasis == basis &&
                hold.ResolutionDecision == decision &&
                hold.AuditId == clearance.AuditId &&
                hold.EvidenceDigest == clearance.EvidenceDigest &&
                hold.VerificationInvocationId == clearance.VerificationInvocationId;
            if (!identical || !consumer.ExistingExactReplay)
                throw ClearanceFault(
                    "a cleared hold is reusable only by its exact durable consumer replay");
            return hold;
        }
        if (clearance.Basis == RbpClearanceBasis.VerificationRead)
        {
            if (hold.State is not (RbpHoldState.EvidenceRecorded or
                    RbpHoldState.ResolvedPendingBridge) ||
                hold.VerificationInvocationId != clearance.VerificationInvocationId ||
                hold.EvidenceDigest != clearance.EvidenceDigest ||
                !HasEligibleVerificationRead(context, hold,
                    clearance.VerificationInvocationId,
                    clearance.EvidenceDigest))
                throw ClearanceFault(
                    "the clearance has no exact production-written verification candidate");
        }
        else if (!HasDurableLateTerminal(context, clearance.HoldId,
                     clearance.EvidenceDigest))
            throw ClearanceFault(
                "the clearance has no exact retained late-terminal evidence");
        return hold;
    }

    private static void ApplyClearancePlan(
        RbpJournalWriteContext context,
        RbpClearancePlan plan,
        long now)
    {
        foreach (RbpClearanceTransition transition in plan.Entries)
        {
            RbpVerificationHold current = FindHoldById(context,
                plan.Consumer.Rsid, transition.Before.VerificationHoldId) ??
                throw ClearanceFault("a planned hold disappeared before consume");
            if (JsonSerializer.Serialize(current) !=
                JsonSerializer.Serialize(transition.Before))
                throw ClearanceFault(
                    "a planned hold changed before atomic consume");
        }
        foreach (RbpClearanceTransition transition in plan.Entries)
        {
            if (!transition.RequiresWrite) continue;
            RbpRecoveryClearance clearance = transition.Clearance;
            using SqliteCommand update = context.CreateCommand(
                """
                UPDATE rbp_verification_holds
                SET state='cleared',verification_invocation_id=$vid,
                    evidence_digest=$digest,resolution_id=$resolution,
                    resolution_basis=$basis,resolution_decision=$decision,
                    audit_id=$audit,cleared_at_ms=$now,
                    updated_at_ms=MAX(updated_at_ms,$now)
                WHERE verification_hold_id=$id AND state=$before_state
                  AND updated_at_ms=$before_updated;
                """);
            update.Parameters.AddWithValue("$vid",
                (object?)clearance.VerificationInvocationId ?? DBNull.Value);
            update.Parameters.AddWithValue("$digest", clearance.EvidenceDigest);
            update.Parameters.AddWithValue("$resolution", clearance.ResolutionId);
            update.Parameters.AddWithValue("$basis", ToStorageBasis(clearance.Basis));
            update.Parameters.AddWithValue("$decision", ToStorageDecision(clearance.Decision));
            update.Parameters.AddWithValue("$audit", clearance.AuditId);
            update.Parameters.AddWithValue("$now", now);
            update.Parameters.AddWithValue("$id", clearance.HoldId);
            update.Parameters.AddWithValue("$before_state",
                transition.Before.State switch
                {
                    RbpHoldState.Active => "active",
                    RbpHoldState.EvidenceRecorded => "evidence_recorded",
                    RbpHoldState.ResolvedPendingBridge => "resolved_pending_bridge",
                    _ => throw ClearanceFault("a clearance transition has no writable source state"),
                });
            update.Parameters.AddWithValue("$before_updated",
                transition.Before.UpdatedAtMilliseconds);
            if (update.ExecuteNonQuery() != 1)
                throw ClearanceFault("the validated clearance plan lost its atomic compare-and-set");
        }
    }

    private static void InstallLegacyHoldPlans(
        RbpJournalWriteContext context,
        IReadOnlyList<RbpLegacyHoldPlan> plans,
        long now)
    {
        foreach (RbpLegacyHoldPlan plan in plans)
        {
            using JsonDocument scope = JsonDocument.Parse(plan.ScopeJcs);
            if (Rfc8785Json.MakeVerificationHoldId(plan.Rsid,
                    scope.RootElement, plan.OrderedOriginKeys) !=
                plan.DeterministicHoldId)
                throw RbpJournalSerialization.Corrupt(
                    "A legacy hold plan has changed deterministic material.");
            RbpVerificationHold? existing = FindHoldByExactScope(context,
                plan.Rsid, plan.ScopeJcs);
            if (existing is not null &&
                (existing.VerificationHoldId != plan.DeterministicHoldId ||
                 !existing.OrderedOriginIdempotencyKeys.SequenceEqual(
                     plan.OrderedOriginKeys, StringComparer.Ordinal)))
                throw LegacyAdmissionFault("legacy_hold_representation_collision");
        }
        foreach (RbpLegacyHoldPlan plan in plans)
            _ = InstallHold(context, plan.Rsid, plan.ScopeJcs,
                plan.OrderedOriginKeys, now);
    }

    private static RbpJournalException LegacyAdmissionFault(string reason) =>
        new(RbpJournalErrorCode.ProtocolConflict,
            "Mutating admission failed closed: " + reason + ".");

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
        using SqliteCommand holdCommand = context.CreateCommand(
            $"""
             SELECT {HoldColumns}
             FROM rbp_verification_holds
             WHERE verification_hold_id=$hold;
             """);
        holdCommand.Parameters.AddWithValue("$hold", verificationHoldId);
        RbpVerificationHold? hold = MaterializeHold(holdCommand);
        if (hold is null || hold.OrderedOriginIdempotencyKeys.Count == 0 ||
            hold.OrderedOriginIdempotencyKeys.Count > 10_000 ||
            hold.OrderedOriginIdempotencyKeys.Distinct(StringComparer.Ordinal).Count() !=
                hold.OrderedOriginIdempotencyKeys.Count)
            return false;
        using JsonDocument scope = JsonDocument.Parse(hold.ScopeJcs);
        if (Rfc8785Json.MakeVerificationHoldId(hold.Rsid, scope.RootElement,
                hold.OrderedOriginIdempotencyKeys) != verificationHoldId)
            return false;
        foreach (string originKey in hold.OrderedOriginIdempotencyKeys)
        {
            RbpStoredInvocation? origin = ReadInvocation(context, originKey);
            if (origin is null || !origin.Identity.Mutating ||
                origin.Identity.Rsid != hold.Rsid ||
                origin.Identity.IdempotencyKey != originKey ||
                origin.State != RbpInvocationState.Indeterminate ||
                origin.VerificationHoldId != verificationHoldId ||
                origin.LateTerminalOutcomeJson is null ||
                origin.LateResultDigest != evidenceDigest ||
                origin.Identity.MutationScopeJcs is null ||
                !ScopeConflicts(origin.Identity.MutationScopeJcs, hold))
                return false;
        }
        return true;
    }

    private static RbpVerificationHold? FindHoldById(
        RbpJournalWriteContext context,
        string rsid,
        string verificationHoldId)
    {
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
