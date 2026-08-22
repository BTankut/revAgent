using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Storage;

internal sealed record RbpOutcomeV3Snapshot(
    string IdempotencyKey,
    string Rsid,
    string DispatchState,
    string EffectState,
    string TransactionMode,
    string EvidenceJcs,
    string TerminalState,
    long RecordVersion);

internal sealed record RbpOutcomeV3EvidenceSnapshot(
    RbpDispatchState DispatchState,
    RbpEffectState EffectState,
    RbpTransactionMode TransactionMode,
    string EvidenceJcs,
    string? LateProvenanceDigest);

internal sealed record RbpOutcomeV3Cutover(
    string Rsid,
    string LegacyDigest,
    long ImportedDispatchCount,
    long ImportedHoldCount,
    long ImportedConflictCount,
    long ImportedResolutionCount,
    long ImportedCanonicalBytes,
    string TargetGeneration,
    string State);

internal sealed record RbpOutcomeV3ResolutionSnapshot(
    string ResolutionId,
    string Rsid,
    string HoldId,
    string Basis,
    string? VerificationInvocationId,
    string EvidenceDigest,
    string Decision,
    string AuditId,
    string State,
    long RecordVersion);

/// <summary>
/// Canonical DC-02 journal-v3 authority. Schema creation is owned exclusively
/// by <see cref="RbpJournalSchema.OutcomeJournalV3Migration"/>; this partial
/// owns bounded per-session import, v3-only outcome/hold/conflict/resolution
/// reads and writes, quarantine, and exact transactional read-back.
/// </summary>
internal sealed partial class RbpJournalStore
{
    private const string OutcomeV3Generation = "bridge-outcome-v3";
    private const int OutcomeV3ImportMaximumRows = 10_000;
    private const long OutcomeV3ImportMaximumCanonicalBytes = 16_777_216;
    private readonly HashSet<string> _outcomeV3Quarantined =
        new(StringComparer.Ordinal);

    internal async Task<RbpOutcomeV3Cutover> EnsureOutcomeV3ForSessionAsync(
        string rsid,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), 256);
        bool quarantined;
        lock (_outcomeV3Quarantined)
        {
            quarantined = _outcomeV3Quarantined.Contains(rsid);
        }

        if (quarantined ||
            await ReadAsync(
                    connection =>
                    {
                        using SqliteCommand command = CreateCommand(
                            connection,
                            "SELECT COUNT(*) FROM " +
                            "rbp_outcome_quarantine_v3 WHERE rsid=$rsid;");
                        command.Parameters.AddWithValue("$rsid", rsid);
                        return Convert.ToInt32(command.ExecuteScalar()) != 0;
                    },
                    cancellationToken)
                .ConfigureAwait(false))
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The RBP session outcome journal is quarantined.");
        }

        RbpOutcomeV3Cutover? observed = await GetOutcomeV3CutoverAsync(
                rsid,
                cancellationToken)
            .ConfigureAwait(false);
        if (observed is not null)
        {
            ValidateOutcomeV3Cutover(observed);
            return observed;
        }

        long now = NowMilliseconds();
        try
        {
            return await ExecuteImmediateAsync(
                    context =>
                    {
                        RequireActiveSession(context, rsid);
                        RequireOutcomeV3Schema();
                        ThrowIfOutcomeV3Quarantined(context, rsid);
                        return EnsureOutcomeV3Cutover(context, rsid, now);
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception exception) when (
            exception is RbpOutcomeV3ImportException or
            RbpJournalException
            {
                ErrorCode: RbpJournalErrorCode.IntegrityCheckFailed or
                    RbpJournalErrorCode.MigrationMismatch,
            })
        {
            await QuarantineOutcomeV3Async(
                    rsid,
                    exception is RbpOutcomeV3ImportException import
                        ? import.ReasonCode
                        : "import_integrity",
                    exception.Message,
                    CancellationToken.None)
                .ConfigureAwait(false);
            throw;
        }
    }

    internal async Task<RbpClearanceGatedAdmission>
        AdmitInvocationOutcomeV3Async(
            RbpInvocationIdentity identity,
            IReadOnlyList<RbpRecoveryClearance> clearances,
            RbpTransactionMode transactionMode,
            CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(clearances);
        ValidateInvocationIdentity(identity);
        ValidateClearanceShapes(identity, clearances);
        if (transactionMode == RbpTransactionMode.NotApplicable)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "An explicit invocation requires a known transaction mode.");
        }
        _ = await EnsureOutcomeV3ForSessionAsync(
                identity.Rsid,
                cancellationToken)
            .ConfigureAwait(false);
        long now = NowMilliseconds();
        try
        {
            return await ExecuteImmediateAsync(
                    context =>
                    {
                        RequireActiveSession(context, identity.Rsid);
                        RequireOutcomeV3Schema();
                        ThrowIfOutcomeV3Quarantined(context, identity.Rsid);
                        RecoverUnresolvedOutcomeV3ForSession(
                            context,
                            identity.Rsid,
                            now);
                        return AdmitInvocationV3(
                            context,
                            identity,
                            clearances,
                            transactionMode,
                            now);
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpJournalException exception)
            when (exception.ErrorCode ==
                  RbpJournalErrorCode.PostCommitFailure)
        {
            RbpClearanceGatedAdmission? recovered =
                await RecoverAdmissionV3Async(
                        identity,
                        clearances,
                        CancellationToken.None)
                    .ConfigureAwait(false);
            if (recovered is not null)
            {
                return recovered;
            }

            await QuarantineOutcomeV3Async(
                    identity.Rsid,
                    "admission_persistence_uncertain",
                    exception.Message,
                    CancellationToken.None)
                .ConfigureAwait(false);
            throw;
        }
    }

    internal async Task MarkInvocationExecutingOutcomeV3Async(
        string idempotencyKey,
        RbpTransactionMode transactionMode,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(idempotencyKey, nameof(idempotencyKey), 293);
        if (transactionMode == RbpTransactionMode.NotApplicable)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "Dispatch ownership requires a known transaction mode.");
        }
        string rsid = IdempotencyKeyRsid(idempotencyKey);
        _ = await EnsureOutcomeV3ForSessionAsync(rsid, cancellationToken)
            .ConfigureAwait(false);
        long now = NowMilliseconds();
        await ExecuteImmediateAsync(
                context =>
                {
                    RequireActiveSession(context, rsid);
                    ThrowIfOutcomeV3Quarantined(context, rsid);
                    RbpStoredInvocation existing =
                        ReadOutcomeV3Invocation(context, idempotencyKey) ??
                        throw new RbpJournalException(
                            RbpJournalErrorCode.ProtocolConflict,
                            "An unknown v3 invocation cannot take dispatch ownership.");
                    if (existing.State != RbpInvocationState.Received)
                    {
                        throw new RbpJournalException(
                            RbpJournalErrorCode.ProtocolConflict,
                            "Only a durably received v3 invocation may dispatch.");
                    }

                    RbpStoredInvocation executing = existing with
                    {
                        State = RbpInvocationState.Executing,
                        StartedAtMilliseconds =
                            existing.StartedAtMilliseconds ?? now,
                    };
                    UpsertOutcomeV3(
                        context,
                        executing,
                        RbpMutationOutcomeEvidence.Uncertain(
                            RbpDispatchState.MayHaveReachedAddin,
                            transactionMode,
                            "dispatch_ownership"),
                        "executing",
                        now);
                    return true;
                },
                cancellationToken)
            .ConfigureAwait(false);
    }

    private static RbpClearanceGatedAdmission AdmitInvocationV3(
        RbpJournalWriteContext context,
        RbpInvocationIdentity identity,
        IReadOnlyList<RbpRecoveryClearance> clearances,
        RbpTransactionMode transactionMode,
        long now)
    {
        foreach (RbpRecoveryClearance clearance in clearances)
        {
            AcceptClearanceV3(
                context,
                identity.Rsid,
                new[] { identity.MutationScopeJcs! },
                clearance,
                now);
        }

        RbpStoredInvocation? legacy =
            ReadLegacyInvocationV2(context, identity.IdempotencyKey);
        if (legacy is null)
        {
            RbpVerificationHold? blocking = identity.Mutating
                ? FindConflictingHoldV3(
                    context,
                    identity.Rsid,
                    identity.MutationScopeJcs!)
                : null;
            if (blocking is not null)
            {
                if (clearances.Count > 0)
                {
                    throw ClearanceFault(
                        "the clearance envelope does not cover every " +
                        "v3 hold conflicting with its mutation scope");
                }

                return new RbpClearanceGatedAdmission(null, blocking);
            }

            InsertReceivedInvocation(context, identity, now);
            RbpStoredInvocation received =
                ReadLegacyInvocationV2(context, identity.IdempotencyKey) ??
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "The v3 invocation identity disappeared during admission.");
            UpsertOutcomeV3(
                context,
                received,
                RbpMutationOutcomeEvidence.NotDispatched(transactionMode),
                "received",
                now);
            return new RbpClearanceGatedAdmission(
                new RbpInvocationAdmissionResult(
                    RbpInvocationAdmission.Accepted,
                    ReadOutcomeV3Invocation(
                        context,
                        identity.IdempotencyKey) ?? received),
                null);
        }

        RequireIdenticalIdentity(legacy.Identity, identity);
        RbpStoredInvocation existing =
            ReadOutcomeV3Invocation(context, identity.IdempotencyKey) ??
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "A post-cutover invocation is missing its v3 outcome.");
        if (existing.State == RbpInvocationState.Indeterminate &&
            existing.LateTerminalOutcomeJson is not null)
        {
            return new RbpClearanceGatedAdmission(
                new RbpInvocationAdmissionResult(
                    RbpInvocationAdmission.ReplayLateAfterIndeterminate,
                    existing,
                    existing.VerificationHoldId),
                null);
        }

        if (existing.IsTerminal)
        {
            return new RbpClearanceGatedAdmission(
                new RbpInvocationAdmissionResult(
                    RbpInvocationAdmission.ReplayTerminal,
                    existing,
                    existing.VerificationHoldId),
                null);
        }

        if (!existing.Identity.Mutating)
        {
            return new RbpClearanceGatedAdmission(
                new RbpInvocationAdmissionResult(
                    RbpInvocationAdmission.RetryNonMutating,
                    existing),
                null);
        }

        string holdId = InstallHoldV3(
            context,
            existing.Identity,
            new[] { existing.Identity.IdempotencyKey },
            now);
        (string outcomeJson, string outcomeDigest) =
            BuildJournalIndeterminateOutcome(
                context,
                existing.Identity,
                holdId);
        RbpStoredInvocation indeterminate = existing with
        {
            State = RbpInvocationState.Indeterminate,
            TerminalOutcomeJson = outcomeJson,
            ResultDigest = outcomeDigest,
            VerificationHoldId = holdId,
            FinishedAtMilliseconds = now,
        };
        UpsertOutcomeV3(
            context,
            indeterminate,
            RbpMutationOutcomeEvidence.Uncertain(
                RbpDispatchState.MayHaveReachedAddin,
                transactionMode,
                "redelivery_promotion"),
            "indeterminate",
            now);
        return new RbpClearanceGatedAdmission(
            new RbpInvocationAdmissionResult(
                RbpInvocationAdmission.RefuseIndeterminate,
                indeterminate,
                holdId),
            null);
    }

    private async Task<RbpClearanceGatedAdmission?> RecoverAdmissionV3Async(
        RbpInvocationIdentity identity,
        IReadOnlyList<RbpRecoveryClearance> clearances,
        CancellationToken cancellationToken)
    {
        RbpStoredInvocation? stored = await GetInvocationAsync(
                identity.IdempotencyKey,
                cancellationToken)
            .ConfigureAwait(false);
        if (stored is null)
        {
            return null;
        }

        try
        {
            RequireIdenticalIdentity(stored.Identity, identity);
        }
        catch (RbpJournalException)
        {
            return null;
        }

        foreach (RbpRecoveryClearance clearance in clearances)
        {
            RbpVerificationHold? hold = await GetHoldAsync(
                    identity.Rsid,
                    clearance.HoldId,
                    cancellationToken)
                .ConfigureAwait(false);
            if (hold is null ||
                hold.State != RbpHoldState.Cleared ||
                hold.ResolutionId != clearance.ResolutionId ||
                hold.EvidenceDigest != clearance.EvidenceDigest)
            {
                return null;
            }
        }

        RbpInvocationAdmission admission = stored.State switch
        {
            RbpInvocationState.Received => RbpInvocationAdmission.Accepted,
            RbpInvocationState.Indeterminate
                when stored.LateTerminalOutcomeJson is not null =>
                RbpInvocationAdmission.ReplayLateAfterIndeterminate,
            RbpInvocationState.Indeterminate =>
                RbpInvocationAdmission.RefuseIndeterminate,
            RbpInvocationState.Completed or
                RbpInvocationState.Failed or
                RbpInvocationState.Guarded or
                RbpInvocationState.Cancelled =>
                RbpInvocationAdmission.ReplayTerminal,
            _ => RbpInvocationAdmission.RetryNonMutating,
        };
        return new RbpClearanceGatedAdmission(
            new RbpInvocationAdmissionResult(
                admission,
                stored,
                stored.VerificationHoldId),
            null);
    }

    private static void AcceptClearanceV3(
        RbpJournalWriteContext context,
        string rsid,
        IReadOnlyList<string> envelopeScopeJcsList,
        RbpRecoveryClearance clearance,
        long now)
    {
        RbpVerificationHold hold =
            ReadHoldV3(context, rsid, clearance.HoldId) ??
            throw ClearanceFault(
                "no authoritative v3 hold matches the clearance");
        if (!string.Equals(
                hold.ScopeJcs,
                clearance.MutationScopeJcs,
                StringComparison.Ordinal) ||
            !envelopeScopeJcsList.Any(scope => ScopeConflicts(scope, hold)))
        {
            throw ClearanceFault(
                "the clearance scope is not the hold's conflicting scope");
        }

        string basis = clearance.Basis switch
        {
            RbpClearanceBasis.VerificationRead => "verification_read",
            RbpClearanceBasis.LateTerminal => "late_terminal",
            _ => throw ClearanceFault("unknown clearance basis"),
        };
        string decision = clearance.Decision switch
        {
            RbpClearanceDecision.NonExecutionProven =>
                "non_execution_proven",
            RbpClearanceDecision.PostconditionVerified =>
                "postcondition_verified",
            _ => throw ClearanceFault("unknown clearance decision"),
        };
        RequireGroupedHoldMaterialForClearance(hold);
        if (hold.State == RbpHoldState.Cleared)
        {
            RbpOutcomeV3ResolutionSnapshot? existing =
                ReadResolutionV3(context, clearance.ResolutionId);
            if (existing is null ||
                hold.VerificationHoldId != clearance.HoldId ||
                hold.ResolutionId != clearance.ResolutionId ||
                hold.ResolutionBasis != basis ||
                hold.VerificationInvocationId !=
                    clearance.VerificationInvocationId ||
                hold.EvidenceDigest != clearance.EvidenceDigest ||
                hold.ResolutionDecision != decision ||
                hold.AuditId != clearance.AuditId ||
                existing.Rsid != rsid ||
                existing.HoldId != clearance.HoldId ||
                existing.Basis != basis ||
                existing.VerificationInvocationId !=
                    clearance.VerificationInvocationId ||
                existing.EvidenceDigest != clearance.EvidenceDigest ||
                existing.Decision != decision ||
                existing.AuditId != clearance.AuditId ||
                existing.State != "accepted")
            {
                throw ClearanceFault(
                    "a cleared hold rejects a changed resolution");
            }

            return;
        }

        RequireGroupedHoldClearanceAuthority(hold, clearance);

        if (clearance.Basis == RbpClearanceBasis.VerificationRead)
        {
            if (hold.State is not (RbpHoldState.EvidenceRecorded or
                RbpHoldState.ResolvedPendingBridge) ||
                hold.VerificationInvocationId !=
                    clearance.VerificationInvocationId ||
                hold.EvidenceDigest != clearance.EvidenceDigest)
            {
                throw ClearanceFault(
                    "verification clearance lacks matching v3 evidence");
            }
        }
        else if (!HasDurableLateTerminalV3(
                     context,
                     hold.VerificationHoldId,
                     clearance.EvidenceDigest))
        {
            throw ClearanceFault(
                "late-terminal clearance lacks matching v3 evidence");
        }

        InsertResolutionV3(
            context,
            hold,
            clearance,
            basis,
            decision,
            now);
        RbpVerificationHold cleared = hold with
        {
            State = RbpHoldState.Cleared,
            VerificationInvocationId = clearance.VerificationInvocationId,
            EvidenceDigest = clearance.EvidenceDigest,
            ResolutionId = clearance.ResolutionId,
            ResolutionBasis = basis,
            ResolutionDecision = decision,
            AuditId = clearance.AuditId,
            UpdatedAtMilliseconds = now,
            ClearedAtMilliseconds = now,
        };
        WriteHoldHistoryV3(context, cleared, now);
        SynchronizeConflictV3(context, cleared, now);
    }

    private static RbpVerificationHold RecordHoldVerificationEvidenceV3(
        RbpJournalWriteContext context,
        string rsid,
        RbpHoldVerificationEvidence evidence,
        long now)
    {
        RbpVerificationHold hold =
            ReadHoldV3(context, rsid, evidence.VerificationHoldId) ??
            throw ClearanceFault(
                "verification evidence does not match a v3 hold");
        if (hold.State is RbpHoldState.Cleared or
            RbpHoldState.ResolvedPendingBridge)
        {
            throw ClearanceFault(
                "a resolved or cleared v3 hold accepts no evidence");
        }

        RbpVerificationHold updated = hold with
        {
            State = evidence.Conclusive
                ? RbpHoldState.EvidenceRecorded
                : hold.State,
            VerificationInvocationId = evidence.VerificationInvocationId,
            EvidenceDigest = evidence.EvidenceDigest,
            UpdatedAtMilliseconds = now,
        };
        WriteHoldHistoryV3(context, updated, now);
        return ReadHoldV3(context, rsid, evidence.VerificationHoldId) ??
               throw new RbpJournalException(
                   RbpJournalErrorCode.IntegrityCheckFailed,
                   "The evidenced v3 hold disappeared.");
    }

    internal async Task<RbpBatchGatedAdmission> AdmitBatchOutcomeV3Async(
        RbpBatchIdentity identity,
        IReadOnlyList<RbpRecoveryClearance> clearances,
        IReadOnlyList<RbpTransactionMode> transactionModes,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(clearances);
        ArgumentNullException.ThrowIfNull(transactionModes);
        ValidateBatchIdentity(identity);
        RbpBatchIdentity normalized = NormalizeBatchIdentity(identity);
        ValidateBatchClearances(normalized, clearances);
        VerifyBatchDigestBinding(normalized);
        if (transactionModes.Count != normalized.Steps.Count)
        {
            throw new ArgumentException(
                "Every batch step requires one transaction mode.",
                nameof(transactionModes));
        }
        if (transactionModes.Any(
                mode => mode == RbpTransactionMode.NotApplicable))
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "Every explicit batch step requires a known transaction mode.");
        }

        _ = await EnsureOutcomeV3ForSessionAsync(
                normalized.Rsid,
                cancellationToken)
            .ConfigureAwait(false);

        string stepsJcs = BuildStepsJcs(normalized);
        long now = NowMilliseconds();
        return await ExecuteImmediateAsync(
            context =>
            {
                RequireActiveSession(context, normalized.Rsid);
                RequireOutcomeV3Schema();
                ThrowIfOutcomeV3Quarantined(context, normalized.Rsid);
                RecoverUnresolvedOutcomeV3ForSession(
                    context,
                    normalized.Rsid,
                    now);

                RbpBatchGatedAdmission gated;
                RbpStoredBatch? existing =
                    ReadBatch(context, normalized.BatchKey);
                if (existing is null)
                {
                    gated = AdmitFreshBatch(
                        context,
                        normalized,
                        clearances,
                        stepsJcs,
                        now);
                }
                else
                {
                    RequireIdenticalBatch(existing, normalized, stepsJcs);
                    IReadOnlyList<string> scopes = MutatingScopes(normalized);
                    foreach (RbpRecoveryClearance clearance in clearances)
                    {
                        AcceptClearance(
                            context,
                            normalized.Rsid,
                            scopes,
                            clearance,
                            now);
                    }

                    gated = new RbpBatchGatedAdmission(
                        ArbitrateRedelivery(
                            context,
                            existing,
                            normalized,
                            now),
                        null);
                }

                if (gated.BlockingHold is not null)
                {
                    return gated;
                }

                RbpBatchAdmissionResult admission =
                    gated.Admission ??
                    throw new RbpJournalException(
                        RbpJournalErrorCode.IntegrityCheckFailed,
                        "The v3 batch admission has no decision.");
                foreach (RbpBatchStepArbitration step in admission.Steps)
                {
                    if (step.Stored is null)
                    {
                        continue;
                    }

                    RbpMutationOutcomeEvidence evidence =
                        step.Disposition ==
                            RbpBatchStepDisposition.RefuseIndeterminate
                            ? RbpMutationOutcomeEvidence.Uncertain(
                                RbpDispatchState.MayHaveReachedAddin,
                                transactionModes[step.BatchIndex],
                                "batch_redelivery_promotion")
                            : RbpMutationOutcomeEvidence.NotDispatched(
                                transactionModes[step.BatchIndex],
                                "batch_admission");
                    if (step.Disposition is
                        RbpBatchStepDisposition.Accepted or
                        RbpBatchStepDisposition.RefuseIndeterminate)
                    {
                        UpsertOutcomeV3(
                            context,
                            step.Stored,
                            evidence,
                            ToStorageState(step.Stored.State),
                            now);
                    }
                }

                return gated;
            },
                cancellationToken)
            .ConfigureAwait(false);
    }

    internal async Task<RbpBatchAdmissionResult>
        RecoverAtomicBatchLossOutcomeV3Async(
            RbpBatchIdentity identity,
            CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(identity);
        if (!identity.Atomic)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "Atomic loss recovery requires an atomic batch.");
        }

        _ = await EnsureOutcomeV3ForSessionAsync(
                identity.Rsid,
                cancellationToken)
            .ConfigureAwait(false);
        long now = NowMilliseconds();
        return await ExecuteImmediateAsync(
                context =>
                {
                    RequireActiveSession(context, identity.Rsid);
                    ThrowIfOutcomeV3Quarantined(context, identity.Rsid);
                    RbpStoredBatch batch =
                        ReadBatchV3(context, identity.BatchKey) ??
                        throw new RbpJournalException(
                            RbpJournalErrorCode.ProtocolConflict,
                            "The dispatched v3 atomic batch is missing.");
                    RequireIdenticalBatch(
                        batch,
                        NormalizeBatchIdentity(identity),
                        BuildStepsJcs(NormalizeBatchIdentity(identity)));
                    if (batch.State != RbpBatchState.Dispatched)
                    {
                        throw new RbpJournalException(
                            RbpJournalErrorCode.ProtocolConflict,
                            "Only a dispatched v3 atomic batch can recover loss.");
                    }

                    // The existing storage arbitration first computes the
                    // complete batch-index-ordered hold plan (including
                    // session-scope subsumption), then writes every grouped
                    // hold/conflict, every affected step, and the batch
                    // terminal inside this one BEGIN IMMEDIATE transaction.
                    return ArbitrateAtomicDispatchLoss(
                        context,
                        batch,
                        NormalizeBatchIdentity(identity),
                        now);
                },
                cancellationToken)
            .ConfigureAwait(false);
    }

    private static void RecoverUnresolvedOutcomeV3ForSession(
        RbpJournalWriteContext context,
        string rsid,
        long now)
    {
        using SqliteCommand batches = context.CreateCommand(
            """
            SELECT outcome.batch_key
            FROM rbp_batches_v3 AS outcome
            JOIN rbp_batches AS identity
              ON identity.batch_key=outcome.batch_key
             AND identity.rsid=outcome.rsid
            WHERE outcome.rsid=$rsid AND outcome.state='dispatched'
            ORDER BY identity.created_at_ms,identity.batch_key
            LIMIT 10001;
            """);
        batches.Parameters.AddWithValue("$rsid", rsid);
        var atomicBatchKeys = new List<string>();
        using (SqliteDataReader reader = batches.ExecuteReader())
        {
            while (reader.Read())
            {
                atomicBatchKeys.Add(reader.GetString(0));
            }
        }

        if (atomicBatchKeys.Count > OutcomeV3ImportMaximumRows)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "Outcome-v3 restart recovery exceeded its bounded batch set.");
        }

        foreach (string batchKey in atomicBatchKeys)
        {
            RbpStoredBatch batch = ReadBatchV3(context, batchKey) ??
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "A dispatched v3 batch disappeared during recovery.");
            RbpBatchIdentity identity;
            try
            {
                identity = RehydrateBatchIdentity(batch);
            }
            catch (RbpOutcomeV3ImportException exception)
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "A dispatched v3 batch has corrupt identity evidence.",
                    exception);
            }

            _ = batch.Atomic
                ? ArbitrateAtomicDispatchLoss(
                    context,
                    batch,
                    identity,
                    now)
                : ArbitrateRedelivery(context, batch, identity, now);
        }

        using SqliteCommand pending = context.CreateCommand(
            """
            SELECT outcome.idempotency_key
            FROM rbp_outcome_dispatch_v3 AS outcome
            JOIN rbp_invocations AS identity
              ON identity.idempotency_key=outcome.idempotency_key
             AND identity.rsid=outcome.rsid
            WHERE outcome.rsid=$rsid AND identity.mutating=1
              AND outcome.terminal_state IN ('received','executing')
              AND outcome.dispatch_state IN (
                'may_have_reached_addin','response_observed'
              )
              AND NOT EXISTS(
                SELECT 1 FROM rbp_batches_v3 AS batch
                WHERE batch.rsid=outcome.rsid
                  AND batch.batch_key=outcome.rsid || '/' || identity.batch_id
                  AND batch.state='dispatched'
              )
            ORDER BY identity.created_at_ms,identity.idempotency_key
            LIMIT 10001;
            """);
        pending.Parameters.AddWithValue("$rsid", rsid);
        var keys = new List<string>();
        using (SqliteDataReader reader = pending.ExecuteReader())
        {
            while (reader.Read())
            {
                keys.Add(reader.GetString(0));
            }
        }

        if (keys.Count > OutcomeV3ImportMaximumRows)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "Outcome-v3 restart recovery exceeded its bounded row set.");
        }

        foreach (string key in keys)
        {
            RbpStoredInvocation row =
                ReadOutcomeV3Invocation(context, key) ??
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "A pending v3 mutation disappeared during recovery.");
            RbpOutcomeV3EvidenceSnapshot provenance =
                ReadOutcomeV3Evidence(context, key);
            string holdId = InstallHoldV3(
                context,
                row.Identity,
                new[] { row.Identity.IdempotencyKey },
                now);
            (string outcomeJson, string outcomeDigest) =
                BuildJournalIndeterminateOutcome(
                    context,
                    row.Identity,
                    holdId);
            UpsertOutcomeV3(
                context,
                row with
                {
                    State = RbpInvocationState.Indeterminate,
                    TerminalOutcomeJson = outcomeJson,
                    ResultDigest = outcomeDigest,
                    VerificationHoldId = holdId,
                    FinishedAtMilliseconds = now,
                },
                new RbpMutationOutcomeEvidence(
                    provenance.DispatchState,
                    RbpEffectState.Unknown,
                    provenance.TransactionMode,
                    SerializeOutcomeEvidenceV3(
                        provenance.DispatchState,
                        RbpEffectState.Unknown,
                        provenance.TransactionMode)),
                "indeterminate",
                now);
        }
    }

    internal Task MarkBatchDispatchedOutcomeV3Async(
        string batchKey,
        IReadOnlyList<RbpTransactionMode> transactionModes,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(batchKey, nameof(batchKey), 293);
        ArgumentNullException.ThrowIfNull(transactionModes);
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                RbpStoredBatch batch = ReadBatch(context, batchKey) ??
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "An unknown batch cannot take dispatch ownership.");
                if (transactionModes.Count != batch.StepCount)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "Batch transaction-mode count does not match its " +
                        "durable step count.");
                }

                RequireActiveSession(context, batch.Rsid);
                RequireOutcomeV3Schema();
                ThrowIfOutcomeV3Quarantined(context, batch.Rsid);
                if (batch.State != RbpBatchState.Received)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "Only a durably received v3 batch may dispatch.");
                }

                UpsertBatchV3(
                    context,
                    batch with
                    {
                        State = RbpBatchState.Dispatched,
                        DispatchedAtMilliseconds = now,
                    },
                    now);

                // Atomic dispatch is one add-in envelope, so every step may
                // have reached the add-in. Ordered fan-out claims ownership
                // per step in MarkInvocationExecutingOutcomeV3Async; marking
                // its untouched suffix here would manufacture uncertainty.
                if (!batch.Atomic)
                {
                    return true;
                }

                IReadOnlyList<string> keys =
                    BatchInvocationKeys(context, batch.Rsid, batch.BatchId);
                if (keys.Count != transactionModes.Count)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.IntegrityCheckFailed,
                        "The durable batch step set is incomplete.");
                }

                for (int index = 0; index < keys.Count; index++)
                {
                    RbpStoredInvocation step =
                        ReadInvocation(context, keys[index]) ??
                        throw new RbpJournalException(
                            RbpJournalErrorCode.IntegrityCheckFailed,
                            "A durable batch step disappeared.");
                    UpsertOutcomeV3(
                        context,
                        step,
                        RbpMutationOutcomeEvidence.Uncertain(
                            RbpDispatchState.MayHaveReachedAddin,
                            transactionModes[index],
                            "batch_dispatch_ownership"),
                        ToStorageState(step.State),
                        now);
                }

                return true;
            },
            cancellationToken);
    }

    internal async Task<string?> PersistInvocationOutcomeV3Async(
        string idempotencyKey,
        RbpInvocationTerminal terminal,
        RbpMutationOutcomeEvidence evidence,
        bool error,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(idempotencyKey, nameof(idempotencyKey), 293);
        ArgumentNullException.ThrowIfNull(terminal);
        ArgumentNullException.ThrowIfNull(evidence);
        ValidateOutcomeEvidence(evidence);
        if (terminal.State is RbpInvocationState.Received or
            RbpInvocationState.Executing)
        {
            throw new ArgumentException(
                "A terminal transition requires a terminal state.",
                nameof(terminal));
        }

        if (terminal.ResultDigest is not null)
        {
            RequireSha256(terminal.ResultDigest, nameof(terminal));
        }

        string rsid = IdempotencyKeyRsid(idempotencyKey);
        _ = await EnsureOutcomeV3ForSessionAsync(rsid, cancellationToken)
            .ConfigureAwait(false);
        bool storeMintsOutcome =
            terminal.State == RbpInvocationState.Indeterminate &&
            terminal.Outcome.ValueKind == JsonValueKind.Undefined;
        string outcomeJson = storeMintsOutcome
            ? string.Empty
            : Rfc8785Json.Canonicalize(terminal.Outcome);
        string? resultDigest = terminal.ResultDigest;
        RbpInvocationState expectedState = terminal.State;
        string? expectedHoldId = null;
        string? expectedDigest = resultDigest;
        string? expectedLateDigest = null;
        string? expectedLateProvenance = null;
        long now = NowMilliseconds();
        try
        {
            return await ExecuteImmediateAsync<string?>(
                    context =>
                    {
                        RequireActiveSession(context, rsid);
                        ThrowIfOutcomeV3Quarantined(context, rsid);
                        RbpStoredInvocation existing =
                            ReadOutcomeV3Invocation(
                                context,
                                idempotencyKey) ??
                            throw new RbpJournalException(
                                RbpJournalErrorCode.ProtocolConflict,
                                "An unknown v3 invocation cannot be terminalized.");

                        if (existing.State == RbpInvocationState.Indeterminate)
                        {
                            if (terminal.ResultDigest is not { Length: > 0 })
                            {
                                throw new RbpJournalException(
                                    RbpJournalErrorCode.ProtocolConflict,
                                    "Late terminal evidence requires a digest.");
                            }

                            RbpOutcomeV3EvidenceSnapshot durableProvenance =
                                ReadOutcomeV3Evidence(context, idempotencyKey);
                            string incomingEvidenceJcs =
                                SerializeOutcomeEvidenceV3(
                                    evidence.DispatchState,
                                    evidence.EffectState,
                                    evidence.TransactionMode);
                            string incomingProvenanceDigest =
                                Sha256(evidence.EvidenceJcs);
                            if (existing.LateTerminalOutcomeJson is not null)
                            {
                                if (existing.LateTerminalOutcomeJson !=
                                        outcomeJson ||
                                    existing.LateResultDigest !=
                                        terminal.ResultDigest ||
                                    durableProvenance.DispatchState !=
                                        evidence.DispatchState ||
                                    durableProvenance.EffectState !=
                                        evidence.EffectState ||
                                    durableProvenance.TransactionMode !=
                                        evidence.TransactionMode ||
                                    durableProvenance.EvidenceJcs !=
                                        incomingEvidenceJcs ||
                                    durableProvenance.LateProvenanceDigest !=
                                        incomingProvenanceDigest)
                                {
                                    throw new RbpJournalException(
                                        RbpJournalErrorCode.ProtocolConflict,
                                        "Late terminal evidence is immutable.");
                                }

                                expectedState =
                                    RbpInvocationState.Indeterminate;
                                expectedHoldId = existing.VerificationHoldId;
                                expectedDigest = existing.ResultDigest;
                                expectedLateDigest =
                                    existing.LateResultDigest;
                                expectedLateProvenance =
                                    durableProvenance.LateProvenanceDigest;
                                return existing.VerificationHoldId;
                            }

                            RbpStoredInvocation late = existing with
                            {
                                LateTerminalOutcomeJson = outcomeJson,
                                LateResultDigest = terminal.ResultDigest,
                            };
                            UpsertOutcomeV3(
                                context,
                                late,
                                evidence,
                                "indeterminate",
                                now,
                                incomingProvenanceDigest);
                            expectedState = RbpInvocationState.Indeterminate;
                            expectedHoldId = existing.VerificationHoldId;
                            expectedDigest = existing.ResultDigest;
                            expectedLateDigest = terminal.ResultDigest;
                            expectedLateProvenance =
                                incomingProvenanceDigest;
                            return existing.VerificationHoldId;
                        }

                        if (existing.IsTerminal)
                        {
                            throw new RbpJournalException(
                                RbpJournalErrorCode.ProtocolConflict,
                                "A terminal v3 invocation outcome is immutable.");
                        }

                        RbpInvocationState finalState = terminal.State;
                        string? holdId = null;
                        bool installHold =
                            evidence.RequiresMutationHold(
                                existing.Identity.Mutating,
                                error) ||
                            (terminal.State ==
                                 RbpInvocationState.Indeterminate &&
                             existing.Identity.Mutating);
                        if (installHold)
                        {
                            holdId = InstallHoldV3(
                                context,
                                existing.Identity,
                                new[] { existing.Identity.IdempotencyKey },
                                now);
                            (outcomeJson, resultDigest) =
                                BuildJournalIndeterminateOutcome(
                                    context,
                                    existing.Identity,
                                    holdId);
                            finalState = RbpInvocationState.Indeterminate;
                        }

                        RbpStoredInvocation stored = existing with
                        {
                            State = finalState,
                            TerminalOutcomeJson = outcomeJson,
                            ResultDigest = resultDigest,
                            VerificationHoldId =
                                holdId ?? existing.VerificationHoldId,
                            FinishedAtMilliseconds = now,
                        };
                        UpsertOutcomeV3(
                            context,
                            stored,
                            evidence,
                            ToStorageState(finalState),
                            now);
                        RbpStoredInvocation readBack =
                            ReadOutcomeV3Invocation(
                                context,
                                idempotencyKey) ??
                            throw new RbpJournalException(
                                RbpJournalErrorCode.IntegrityCheckFailed,
                                "The terminal v3 invocation disappeared.");
                        if (readBack.State != finalState ||
                            readBack.ResultDigest != resultDigest ||
                            readBack.VerificationHoldId !=
                                stored.VerificationHoldId)
                        {
                            throw new RbpJournalException(
                                RbpJournalErrorCode.IntegrityCheckFailed,
                                "The terminal v3 invocation failed read-back.");
                        }

                        expectedState = finalState;
                        expectedHoldId = stored.VerificationHoldId;
                        expectedDigest = resultDigest;
                        return holdId;
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpJournalException exception)
            when (exception.ErrorCode ==
                  RbpJournalErrorCode.PostCommitFailure)
        {
            bool recovered = await VerifyTerminalOutcomeV3Async(
                    idempotencyKey,
                    expectedState,
                    expectedDigest,
                    expectedHoldId,
                    expectedLateDigest,
                    expectedLateProvenance,
                    CancellationToken.None)
                .ConfigureAwait(false);
            if (recovered)
            {
                return expectedHoldId;
            }

            await QuarantineOutcomeV3Async(
                    rsid,
                    "terminal_persistence_uncertain",
                    exception.Message,
                    CancellationToken.None)
                .ConfigureAwait(false);
            throw;
        }
    }

    private Task<bool> VerifyTerminalOutcomeV3Async(
        string idempotencyKey,
        RbpInvocationState expectedState,
        string? expectedDigest,
        string? expectedHoldId,
        string? expectedLateDigest,
        string? expectedLateProvenance,
        CancellationToken cancellationToken) =>
        ReadAsync(
            connection =>
            {
                using SqliteCommand command = CreateCommand(
                    connection,
                    """
                    SELECT terminal_state,result_digest,
                           verification_hold_id,late_result_digest,
                           late_provenance_digest
                    FROM rbp_outcome_dispatch_v3
                    WHERE idempotency_key=$key;
                    """);
                command.CommandTimeout = _commandTimeoutSeconds;
                command.Parameters.AddWithValue("$key", idempotencyKey);
                using SqliteDataReader reader = command.ExecuteReader();
                if (!reader.Read())
                {
                    return false;
                }

                return reader.GetString(0) == ToStorageState(expectedState) &&
                       (reader.IsDBNull(1) ? null : reader.GetString(1)) ==
                           expectedDigest &&
                       (reader.IsDBNull(2) ? null : reader.GetString(2)) ==
                           expectedHoldId &&
                       (reader.IsDBNull(3) ? null : reader.GetString(3)) ==
                            expectedLateDigest &&
                       (reader.IsDBNull(4) ? null : reader.GetString(4)) ==
                            expectedLateProvenance &&
                       !reader.Read();
            },
            cancellationToken);

    internal Task<RbpOutcomeV3Snapshot?> GetOutcomeV3Async(
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(idempotencyKey, nameof(idempotencyKey), 293);
        return ReadAsync(
            connection =>
            {
                if (!TableExists(connection, "rbp_outcome_dispatch_v3"))
                {
                    return null;
                }

                using SqliteCommand command = CreateCommand(
                    connection,
                    """
                    SELECT idempotency_key,rsid,dispatch_state,effect_state,
                           transaction_mode,evidence_jcs,terminal_state,
                           record_version
                    FROM rbp_outcome_dispatch_v3
                    WHERE idempotency_key=$key;
                    """);
                command.CommandTimeout = _commandTimeoutSeconds;
                command.Parameters.AddWithValue("$key", idempotencyKey);
                using SqliteDataReader reader = command.ExecuteReader();
                return reader.Read()
                    ? new RbpOutcomeV3Snapshot(
                        reader.GetString(0),
                        reader.GetString(1),
                        reader.GetString(2),
                        reader.GetString(3),
                        reader.GetString(4),
                        reader.GetString(5),
                        reader.GetString(6),
                        reader.GetInt64(7))
                    : null;
            },
            cancellationToken);
    }

    internal Task<RbpOutcomeV3Cutover?> GetOutcomeV3CutoverAsync(
        string rsid,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), 256);
        return ReadAsync(
            connection =>
            {
                if (!TableExists(connection, "rbp_hold_cutover_v3"))
                {
                    return null;
                }

                using SqliteCommand command = CreateCommand(
                    connection,
                    """
                    SELECT rsid,legacy_digest,imported_dispatch_count,
                           imported_hold_count,imported_conflict_count,
                           imported_resolution_count,imported_canonical_bytes,
                           target_generation,state
                    FROM rbp_hold_cutover_v3 WHERE rsid=$rsid;
                    """);
                command.CommandTimeout = _commandTimeoutSeconds;
                command.Parameters.AddWithValue("$rsid", rsid);
                using SqliteDataReader reader = command.ExecuteReader();
                return reader.Read() ? MaterializeOutcomeV3Cutover(reader) : null;
            },
            cancellationToken);
    }

    internal Task<RbpOutcomeV3ResolutionSnapshot?>
        GetOutcomeV3ResolutionAsync(
            string resolutionId,
            CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(resolutionId, nameof(resolutionId), 36);
        return ReadAsync(
            connection =>
            {
                if (!TableExists(
                        connection,
                        "rbp_mutation_resolutions_v3"))
                {
                    return null;
                }

                using SqliteCommand command = CreateCommand(
                    connection,
                    """
                    SELECT resolution_id,rsid,hold_id,basis,
                           verification_invocation_id,evidence_digest,
                           decision,audit_id,state,record_version
                    FROM rbp_mutation_resolutions_v3
                    WHERE resolution_id=$resolution;
                    """);
                command.CommandTimeout = _commandTimeoutSeconds;
                command.Parameters.AddWithValue(
                    "$resolution",
                    resolutionId);
                using SqliteDataReader reader = command.ExecuteReader();
                if (!reader.Read())
                {
                    return null;
                }

                return new RbpOutcomeV3ResolutionSnapshot(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetString(3),
                    reader.IsDBNull(4) ? null : reader.GetString(4),
                    reader.GetString(5),
                    reader.GetString(6),
                    reader.GetString(7),
                    reader.GetString(8),
                    reader.GetInt64(9));
            },
            cancellationToken);
    }

    private void RequireOutcomeV3Schema()
    {
        if (SchemaVersion != RbpJournalSchema.CurrentVersion)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.MigrationMismatch,
                "Outcome-v3 operations require the canonical schema-v3 " +
                "migration.");
        }
    }

    private void ThrowIfOutcomeV3Quarantined(
        RbpJournalWriteContext context,
        string rsid)
    {
        lock (_outcomeV3Quarantined)
        {
            if (_outcomeV3Quarantined.Contains(rsid))
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "The RBP session outcome journal is quarantined.");
            }
        }

        using SqliteCommand command = context.CreateCommand(
            """
            SELECT COUNT(*) FROM rbp_outcome_quarantine_v3
            WHERE rsid=$rsid;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        if (Convert.ToInt32(command.ExecuteScalar()) != 0)
        {
            lock (_outcomeV3Quarantined)
            {
                _outcomeV3Quarantined.Add(rsid);
            }

            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The RBP session outcome journal is durably quarantined.");
        }
    }

    private async Task QuarantineOutcomeV3Async(
        string rsid,
        string reasonCode,
        string evidence,
        CancellationToken cancellationToken)
    {
        lock (_outcomeV3Quarantined)
        {
            _outcomeV3Quarantined.Add(rsid);
        }

        try
        {
            long now = NowMilliseconds();
            await ExecuteImmediateAsync(
                    context =>
                    {
                        RequireSessionExists(context, rsid);
                        using SqliteCommand insert = context.CreateCommand(
                            """
                            INSERT INTO rbp_outcome_quarantine_v3(
                              rsid,reason_code,evidence_digest,created_at_ms
                            ) VALUES($rsid,$reason,$digest,$now)
                            ON CONFLICT(rsid) DO NOTHING;
                            """);
                        insert.Parameters.AddWithValue("$rsid", rsid);
                        insert.Parameters.AddWithValue(
                            "$reason",
                            BoundOutcomeCode(reasonCode));
                        insert.Parameters.AddWithValue(
                            "$digest",
                            Sha256(evidence));
                        insert.Parameters.AddWithValue("$now", now);
                        _ = insert.ExecuteNonQuery();
                        return true;
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch
        {
            // The in-process quarantine remains fail-closed when even its
            // durable marker cannot be written. The original import failure
            // is preserved for the caller.
        }
    }

    private static string BoundOutcomeCode(string value) =>
        value is { Length: > 0 and <= 64 } &&
        value.All(character =>
            character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_')
            ? value
            : "import_integrity";

    private static string IdempotencyKeyRsid(string idempotencyKey)
    {
        int separator = idempotencyKey.LastIndexOf('/');
        if (separator <= 0 || separator == idempotencyKey.Length - 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "The invocation idempotency key is malformed.");
        }

        return idempotencyKey[..separator];
    }

    private static RbpOutcomeV3Cutover EnsureOutcomeV3Cutover(
        RbpJournalWriteContext context,
        string rsid,
        long now)
    {
        RbpOutcomeV3Cutover? existing = ReadOutcomeV3Cutover(context, rsid);
        if (existing is not null)
        {
            ValidateOutcomeV3Cutover(existing);
            return existing;
        }

        IReadOnlyList<string> invocationKeys = InvocationKeys(
            context,
            rsid,
            OutcomeV3ImportMaximumRows + 1);
        IReadOnlyList<string> batchKeys = BatchKeys(
            context,
            rsid,
            OutcomeV3ImportMaximumRows + 1);
        IReadOnlyList<string> holdIds = HoldIds(
            context,
            rsid,
            OutcomeV3ImportMaximumRows + 1);
        long totalRows =
            (long)invocationKeys.Count + batchKeys.Count + holdIds.Count;
        if (totalRows > OutcomeV3ImportMaximumRows)
        {
            throw new RbpOutcomeV3ImportException(
                "import_max_rows",
                "The per-session outcome-v3 import exceeds 10000 rows.");
        }

        // Reject an oversized source row in SQL before any large legacy text
        // value is materialized. The exact RFC 8785 byte budget is then
        // accumulated one canonical row at a time below, so cumulative +1 is
        // rejected without retaining the preceding canonical strings.
        PreflightLegacyImportRowBytes(context, rsid);
        using IncrementalHash legacyHash =
            IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long canonicalBytes = 0;
        bool hasDigestRow = false;

        // Holds are mirrored first so every imported indeterminate outcome can
        // be checked against a same-session composite parent.
        foreach (string holdId in holdIds)
        {
            RbpVerificationHold hold =
                FindHoldById(context, rsid, holdId) ??
                throw new RbpOutcomeV3ImportException(
                    "import_missing_hold",
                    "A legacy hold disappeared during outcome import.");
            AppendLegacyImportDigest(
                legacyHash,
                "hold|" + CanonicalLegacyHold(hold),
                ref canonicalBytes,
                ref hasDigestRow);
            MirrorLegacyHoldV3(context, hold, now);
        }

        var batches = new List<RbpStoredBatch>(batchKeys.Count);
        var batchIdentities =
            new Dictionary<string, RbpBatchIdentity>(StringComparer.Ordinal);
        var atomicHoldByInvocation =
            new Dictionary<string, string>(StringComparer.Ordinal);
        var supersededAtomicLegacyHolds =
            new HashSet<string>(StringComparer.Ordinal);
        var atomicDispatchKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (string key in batchKeys)
        {
            RbpStoredBatch stored =
                ReadLegacyBatchV2(context, key) ??
                throw new RbpOutcomeV3ImportException(
                    "import_missing_batch",
                    "A legacy batch disappeared during outcome import.");
            AppendLegacyImportDigest(
                legacyHash,
                "batch|" + CanonicalLegacyBatch(stored),
                ref canonicalBytes,
                ref hasDigestRow);
            batches.Add(stored);
            if (stored.Atomic && stored.State == RbpBatchState.Dispatched)
            {
                RbpBatchIdentity identity = RehydrateBatchIdentity(stored);
                batchIdentities.Add(stored.BatchKey, identity);
                IReadOnlyDictionary<string, string> planned =
                    InstallLegacyAtomicBatchHoldsV3(
                        context,
                        identity,
                        supersededAtomicLegacyHolds,
                        now);
                foreach ((string invocationKey, string holdId) in planned)
                {
                    atomicHoldByInvocation.Add(invocationKey, holdId);
                }

                foreach (RbpBatchStepIdentity step in identity.Steps)
                {
                    atomicDispatchKeys.Add(
                        identity.Rsid + "/" + step.InvocationId);
                }
            }
        }

        foreach (string key in invocationKeys)
        {
            RbpStoredInvocation stored =
                ReadLegacyInvocationV2(context, key) ??
                throw new RbpOutcomeV3ImportException(
                    "import_missing_invocation",
                    "A legacy invocation disappeared during outcome import.");
            AppendLegacyImportDigest(
                legacyHash,
                "invocation|" + CanonicalLegacyInvocation(stored),
                ref canonicalBytes,
                ref hasDigestRow);
            ImportLegacyInvocation(
                context,
                stored,
                atomicHoldByInvocation,
                supersededAtomicLegacyHolds,
                atomicDispatchKeys.Contains(key),
                now);
            _ = ReadOutcomeV3Invocation(context, key) ??
                throw new RbpOutcomeV3ImportException(
                    "import_readback_mismatch",
                    "An imported outcome failed exact v3 read-back.");
        }

        foreach (RbpStoredBatch batch in batches)
        {
            if (batchIdentities.TryGetValue(
                    batch.BatchKey,
                    out RbpBatchIdentity? identity))
            {
                ImportLegacyBatch(
                    context,
                    BuildImportedAtomicBatchTerminal(
                        context,
                        batch,
                        identity,
                        now),
                    now);
            }
            else
            {
                ImportLegacyBatch(context, batch, now);
            }
        }

        long dispatchCount =
            CountRowsForSession(context, "rbp_outcome_dispatch_v3", rsid);
        long batchCount =
            CountRowsForSession(context, "rbp_batches_v3", rsid);
        long holdCount =
            CountRowsForSession(context, "rbp_mutation_holds_v3", rsid);
        long conflictCount =
            CountRowsForSession(context, "rbp_mutation_conflicts_v3", rsid);
        long resolutionCount = CountResolutionsForSession(context, rsid);
        if (dispatchCount != invocationKeys.Count ||
            batchCount != batchKeys.Count ||
            holdCount < holdIds.Count - supersededAtomicLegacyHolds.Count)
        {
            throw new RbpOutcomeV3ImportException(
                "import_count_mismatch",
                "Outcome-v3 import read-back counts do not match its source.");
        }

        string legacyDigest = "sha256:" +
            Convert.ToHexString(legacyHash.GetHashAndReset())
                .ToLowerInvariant();
        using SqliteCommand insert = context.CreateCommand(
            """
            INSERT INTO rbp_hold_cutover_v3(
              rsid,record_schema,legacy_digest,imported_dispatch_count,
              imported_hold_count,imported_conflict_count,
              imported_resolution_count,imported_canonical_bytes,
              target_generation,state,record_version,cutover_at_ms
            ) VALUES(
              $rsid,'bridge.hold-cutover/v1',$digest,$dispatches,$holds,
              $conflicts,$resolutions,$bytes,'bridge-outcome-v3',
              'normalized_authoritative',1,$now
            );
            """);
        insert.Parameters.AddWithValue("$rsid", rsid);
        insert.Parameters.AddWithValue("$digest", legacyDigest);
        insert.Parameters.AddWithValue("$dispatches", dispatchCount);
        insert.Parameters.AddWithValue("$holds", holdCount);
        insert.Parameters.AddWithValue("$conflicts", conflictCount);
        insert.Parameters.AddWithValue("$resolutions", resolutionCount);
        insert.Parameters.AddWithValue("$bytes", canonicalBytes);
        insert.Parameters.AddWithValue("$now", now);
        if (insert.ExecuteNonQuery() != 1)
        {
            throw new RbpOutcomeV3ImportException(
                "import_marker_write",
                "The Bridge outcome cutover marker did not commit.");
        }

        RbpOutcomeV3Cutover marker =
            ReadOutcomeV3Cutover(context, rsid) ??
            throw new RbpOutcomeV3ImportException(
                "import_marker_readback",
                "The Bridge outcome cutover marker disappeared.");
        ValidateOutcomeV3Cutover(marker);
        if (marker.LegacyDigest != legacyDigest ||
            marker.ImportedDispatchCount != dispatchCount ||
            marker.ImportedHoldCount != holdCount ||
            marker.ImportedConflictCount != conflictCount ||
            marker.ImportedResolutionCount != resolutionCount ||
            marker.ImportedCanonicalBytes != canonicalBytes)
        {
            throw new RbpOutcomeV3ImportException(
                "import_marker_mismatch",
                "The Bridge outcome cutover marker failed exact read-back.");
        }

        return marker;
    }

    private static void PreflightLegacyImportRowBytes(
        RbpJournalWriteContext context,
        string rsid)
    {
        string[] queries =
        [
            "SELECT COALESCE(MAX(" +
            "length(CAST(idempotency_key AS BLOB))+" +
            "length(CAST(rsid AS BLOB))+" +
            "length(CAST(invocation_id AS BLOB))+" +
            "COALESCE(length(CAST(batch_id AS BLOB)),0)+" +
            "length(CAST(method AS BLOB))+" +
            "COALESCE(length(CAST(mutation_scope_jcs AS BLOB)),0)+" +
            "length(CAST(params_digest AS BLOB))+" +
            "length(CAST(policy_jcs AS BLOB))+" +
            "length(CAST(recovery_clearances_jcs AS BLOB))+" +
            "length(CAST(state AS BLOB))+" +
            "COALESCE(length(CAST(terminal_outcome_json AS BLOB)),0)+" +
            "COALESCE(length(CAST(result_digest AS BLOB)),0)+" +
            "COALESCE(length(CAST(verification_hold_id AS BLOB)),0)+" +
            "COALESCE(length(CAST(verification_correlation_json AS BLOB)),0)+" +
            "COALESCE(length(CAST(late_terminal_outcome_json AS BLOB)),0)+" +
            "COALESCE(length(CAST(late_result_digest AS BLOB)),0)),0) " +
            "FROM rbp_invocations WHERE rsid=$rsid;",
            "SELECT COALESCE(MAX(" +
            "length(CAST(batch_key AS BLOB))+" +
            "length(CAST(rsid AS BLOB))+" +
            "length(CAST(batch_id AS BLOB))+" +
            "length(CAST(batch_digest AS BLOB))+" +
            "length(CAST(recovery_clearances_jcs AS BLOB))+" +
            "length(CAST(steps_jcs AS BLOB))+" +
            "length(CAST(state AS BLOB))+" +
            "COALESCE(length(CAST(terminal_outcome_json AS BLOB)),0)+" +
            "COALESCE(length(CAST(result_digest AS BLOB)),0)),0) " +
            "FROM rbp_batches WHERE rsid=$rsid;",
            "SELECT COALESCE(MAX(" +
            "length(CAST(verification_hold_id AS BLOB))+" +
            "length(CAST(rsid AS BLOB))+" +
            "length(CAST(scope_kind AS BLOB))+" +
            "COALESCE(length(CAST(document_id AS BLOB)),0)+" +
            "length(CAST(scope_jcs AS BLOB))+" +
            "length(CAST(ordered_origin_idempotency_keys_json AS BLOB))+" +
            "length(CAST(state AS BLOB))+" +
            "COALESCE(length(CAST(verification_invocation_id AS BLOB)),0)+" +
            "COALESCE(length(CAST(evidence_digest AS BLOB)),0)+" +
            "COALESCE(length(CAST(resolution_id AS BLOB)),0)+" +
            "COALESCE(length(CAST(resolution_basis AS BLOB)),0)+" +
            "COALESCE(length(CAST(resolution_decision AS BLOB)),0)+" +
            "COALESCE(length(CAST(audit_id AS BLOB)),0)),0) " +
            "FROM rbp_verification_holds WHERE rsid=$rsid;",
        ];
        foreach (string sql in queries)
        {
            using SqliteCommand command = context.CreateCommand(sql);
            command.Parameters.AddWithValue("$rsid", rsid);
            if (Convert.ToInt64(command.ExecuteScalar()) >
                OutcomeV3ImportMaximumCanonicalBytes)
            {
                throw new RbpOutcomeV3ImportException(
                    "import_max_bytes",
                    "A legacy outcome row exceeds the bounded import size.");
            }
        }
    }

    internal static void ValidateOutcomeV3ImportByteAddition(
        ref long canonicalBytes,
        long nextRowBytes)
    {
        if (nextRowBytes < 0 ||
            nextRowBytes >= OutcomeV3ImportMaximumCanonicalBytes ||
            canonicalBytes >
                OutcomeV3ImportMaximumCanonicalBytes - nextRowBytes - 1L)
        {
            throw new RbpOutcomeV3ImportException(
                "import_max_bytes",
                "The per-session outcome-v3 import exceeds 16777216 bytes.");
        }

        canonicalBytes += nextRowBytes + 1L;
    }

    private static void AppendLegacyImportDigest(
        IncrementalHash hash,
        string row,
        ref long canonicalBytes,
        ref bool hasDigestRow)
    {
        long rowBytes = Encoding.UTF8.GetByteCount(row);
        ValidateOutcomeV3ImportByteAddition(ref canonicalBytes, rowBytes);
        if (hasDigestRow)
        {
            hash.AppendData([(byte)'\n']);
        }

        byte[] encoded = Encoding.UTF8.GetBytes(row);
        hash.AppendData(encoded);
        CryptographicOperations.ZeroMemory(encoded);
        hasDigestRow = true;
    }

    private static RbpBatchIdentity RehydrateBatchIdentity(
        RbpStoredBatch stored)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(stored.StepsJcs);
            if (document.RootElement.ValueKind != JsonValueKind.Array ||
                document.RootElement.GetArrayLength() != stored.StepCount)
            {
                throw new JsonException();
            }

            var steps = new List<RbpBatchStepIdentity>((int)stored.StepCount);
            foreach (JsonElement value in document.RootElement.EnumerateArray())
            {
                JsonElement scope = value.GetProperty("mutation_scope");
                JsonElement policy = value.GetProperty("policy");
                JsonElement confirmation =
                    policy.GetProperty("confirmation_id");
                steps.Add(
                    new RbpBatchStepIdentity(
                        value.GetProperty("invocation_id").GetString()!,
                        value.GetProperty("method").GetString()!,
                        value.GetProperty("mutating").GetBoolean(),
                        scope.ValueKind == JsonValueKind.Null
                            ? null
                            : Rfc8785Json.Canonicalize(scope),
                        value.GetProperty("params_digest").GetString()!,
                        policy.GetProperty("class").GetString()!,
                        confirmation.ValueKind == JsonValueKind.Null
                            ? null
                            : confirmation.GetString(),
                        policy.GetProperty("decision").GetString()!));
            }

            RbpBatchIdentity identity = NormalizeBatchIdentity(
                new RbpBatchIdentity(
                    stored.Rsid,
                    stored.BatchId,
                    stored.BatchDigest,
                    stored.Atomic,
                    stored.TimeoutMilliseconds,
                    stored.RecoveryClearancesJcs,
                    steps.AsReadOnly()));
            RequireIdenticalBatch(stored, identity, BuildStepsJcs(identity));
            VerifyBatchDigestBinding(identity);
            return identity;
        }
        catch (Exception exception) when (
            exception is JsonException or InvalidOperationException or
                KeyNotFoundException or ArgumentException or
                RbpJournalException)
        {
            throw new RbpOutcomeV3ImportException(
                "import_batch_identity_corrupt",
                "A legacy atomic batch identity is contradictory.");
        }
    }

    private static IReadOnlyDictionary<string, string>
        InstallLegacyAtomicBatchHoldsV3(
            RbpJournalWriteContext context,
            RbpBatchIdentity identity,
            ISet<string> supersededLegacyHoldIds,
            long now)
    {
        var uncertain = new List<RbpStoredInvocation>();
        for (int index = 0; index < identity.Steps.Count; index++)
        {
            RbpInvocationIdentity stepIdentity =
                StepInvocationIdentity(identity, index);
            RbpStoredInvocation row =
                ReadLegacyInvocationV2(
                    context,
                    stepIdentity.IdempotencyKey) ??
                throw new RbpOutcomeV3ImportException(
                    "import_missing_batch_step",
                    "A legacy atomic batch step is missing.");
            try
            {
                RequireIdenticalIdentity(row.Identity, stepIdentity);
            }
            catch (RbpJournalException)
            {
                throw new RbpOutcomeV3ImportException(
                    "import_batch_step_identity",
                    "A legacy atomic batch step identity is contradictory.");
            }
            if (stepIdentity.Mutating &&
                row.State is not (RbpInvocationState.Completed or
                    RbpInvocationState.Guarded))
            {
                uncertain.Add(row);
            }
        }

        var holdByKey =
            new Dictionary<string, string>(StringComparer.Ordinal);
        if (uncertain.Count == 0)
        {
            return holdByKey;
        }

        RbpStoredInvocation? sessionOrigin = uncertain.FirstOrDefault(
            row => ReadScopeShape(row.Identity.MutationScopeJcs!).ScopeKind ==
                   "session");
        if (sessionOrigin is not null)
        {
            string[] origins = uncertain
                .Select(row => row.Identity.IdempotencyKey)
                .ToArray();
            SupersedeLegacyAtomicHoldsV3(
                context,
                sessionOrigin.Identity.MutationScopeJcs!,
                uncertain,
                origins,
                supersededLegacyHoldIds);
            string holdId = InstallHoldV3(
                context,
                sessionOrigin.Identity,
                origins,
                now);
            foreach (string origin in origins)
            {
                holdByKey.Add(origin, holdId);
            }

            return holdByKey;
        }

        foreach (IGrouping<string, RbpStoredInvocation> group in uncertain
                     .GroupBy(
                         row => row.Identity.MutationScopeJcs!,
                         StringComparer.Ordinal))
        {
            RbpStoredInvocation first = group.First();
            string[] origins = group
                .Select(row => row.Identity.IdempotencyKey)
                .ToArray();
            RbpStoredInvocation[] groupedRows = group.ToArray();
            SupersedeLegacyAtomicHoldsV3(
                context,
                first.Identity.MutationScopeJcs!,
                groupedRows,
                origins,
                supersededLegacyHoldIds);
            string holdId = InstallHoldV3(
                context,
                first.Identity,
                origins,
                now);
            foreach (string origin in origins)
            {
                holdByKey.Add(origin, holdId);
            }
        }

        return holdByKey;
    }

    private static void SupersedeLegacyAtomicHoldsV3(
        RbpJournalWriteContext context,
        string targetScopeJcs,
        IReadOnlyCollection<RbpStoredInvocation> groupedRows,
        IReadOnlyList<string> groupedOrigins,
        ISet<string> supersededLegacyHoldIds)
    {
        string rsid = groupedRows.First().Identity.Rsid;
        var groupedOriginSet = new HashSet<string>(
            groupedOrigins,
            StringComparer.Ordinal);
        string targetScopeKind = ReadScopeShape(targetScopeJcs).ScopeKind;
        foreach (string legacyHoldId in groupedRows
                     .Select(row => row.VerificationHoldId)
                     .Where(id => id is { Length: > 0 })
                     .Cast<string>()
                     .Distinct(StringComparer.Ordinal))
        {
            RbpVerificationHold legacy =
                FindHoldById(context, rsid, legacyHoldId) ??
                throw new RbpOutcomeV3ImportException(
                    "import_cross_session_hold",
                    "An atomic legacy step references no same-session hold.");
            bool alreadyGrouped =
                legacy.ScopeJcs == targetScopeJcs &&
                legacy.OrderedOriginIdempotencyKeys.SequenceEqual(
                    groupedOrigins,
                    StringComparer.Ordinal);
            if (alreadyGrouped)
            {
                continue;
            }

            bool scopeIsSubsumed = targetScopeKind == "session" ||
                                   legacy.ScopeJcs == targetScopeJcs;
            bool simpleUnresolvedAuthority =
                legacy.State == RbpHoldState.Active &&
                legacy.VerificationInvocationId is null &&
                legacy.EvidenceDigest is null &&
                legacy.ResolutionId is null &&
                legacy.ResolutionBasis is null &&
                legacy.ResolutionDecision is null &&
                legacy.AuditId is null &&
                legacy.OrderedOriginIdempotencyKeys.Count > 0 &&
                legacy.OrderedOriginIdempotencyKeys.All(
                    groupedOriginSet.Contains);
            if (!scopeIsSubsumed || !simpleUnresolvedAuthority)
            {
                throw new RbpOutcomeV3ImportException(
                    "import_atomic_hold_mismatch",
                    "Legacy atomic hold evidence cannot be grouped safely.");
            }

            if (!supersededLegacyHoldIds.Add(legacyHoldId))
            {
                continue;
            }

            using (SqliteCommand conflicts = context.CreateCommand(
                       "DELETE FROM rbp_mutation_conflicts_v3 " +
                       "WHERE rsid=$rsid AND hold_id=$hold;"))
            {
                conflicts.Parameters.AddWithValue("$rsid", rsid);
                conflicts.Parameters.AddWithValue("$hold", legacyHoldId);
                _ = conflicts.ExecuteNonQuery();
            }

            using (SqliteCommand resolutions = context.CreateCommand(
                       "DELETE FROM rbp_mutation_resolutions_v3 " +
                       "WHERE rsid=$rsid AND hold_id=$hold;"))
            {
                resolutions.Parameters.AddWithValue("$rsid", rsid);
                resolutions.Parameters.AddWithValue("$hold", legacyHoldId);
                _ = resolutions.ExecuteNonQuery();
            }

            using SqliteCommand hold = context.CreateCommand(
                "DELETE FROM rbp_mutation_holds_v3 " +
                "WHERE rsid=$rsid AND hold_id=$hold;");
            hold.Parameters.AddWithValue("$rsid", rsid);
            hold.Parameters.AddWithValue("$hold", legacyHoldId);
            if (hold.ExecuteNonQuery() != 1)
            {
                throw new RbpOutcomeV3ImportException(
                    "import_atomic_hold_replace",
                    "A superseded legacy atomic hold could not be replaced.");
            }
        }
    }

    private static RbpStoredBatch BuildImportedAtomicBatchTerminal(
        RbpJournalWriteContext context,
        RbpStoredBatch batch,
        RbpBatchIdentity identity,
        long now)
    {
        var holdIds = new List<string>();
        int? firstNonSuccess = null;
        bool anyIndeterminateMutation = false;
        for (int index = 0; index < identity.Steps.Count; index++)
        {
            RbpStoredInvocation row =
                ReadOutcomeV3Invocation(
                    context,
                    StepInvocationIdentity(identity, index).IdempotencyKey) ??
                throw new RbpOutcomeV3ImportException(
                    "import_missing_batch_step_outcome",
                    "An atomic batch step outcome failed v3 import.");
            if (row.State != RbpInvocationState.Completed)
            {
                firstNonSuccess ??= index;
            }

            if (row.State == RbpInvocationState.Indeterminate)
            {
                anyIndeterminateMutation = true;
                AppendDistinct(holdIds, row.VerificationHoldId);
            }
        }

        (string outcomeJson, string outcomeDigest) = BuildDispatchLossOutcome(
            identity,
            anyIndeterminateMutation,
            holdIds,
            firstNonSuccess);
        return batch with
        {
            State = RbpBatchState.Terminal,
            TerminalOutcomeJson = outcomeJson,
            ResultDigest = outcomeDigest,
            FinishedAtMilliseconds = now,
        };
    }

    private static void ImportLegacyInvocation(
        RbpJournalWriteContext context,
        RbpStoredInvocation stored,
        IReadOnlyDictionary<string, string> atomicHoldByInvocation,
        ISet<string> supersededAtomicLegacyHolds,
        bool dispatchedAtomicStep,
        long now)
    {
        RbpStoredInvocation imported = stored;
        bool uncertainMutation =
            stored.Identity.Mutating &&
            stored.State is not (RbpInvocationState.Completed or
                RbpInvocationState.Guarded or
                RbpInvocationState.Received) ||
            stored.Identity.Mutating &&
            stored.State == RbpInvocationState.Received &&
            dispatchedAtomicStep;

        RbpMutationOutcomeEvidence evidence;
        if (uncertainMutation)
        {
            string holdId;
            if (!atomicHoldByInvocation.TryGetValue(
                    stored.Identity.IdempotencyKey,
                    out holdId!))
            {
                if (stored.State == RbpInvocationState.Indeterminate)
                {
                    holdId = stored.VerificationHoldId ??
                        throw new RbpOutcomeV3ImportException(
                            "import_indeterminate_without_hold",
                            "A legacy indeterminate mutation has no hold.");
                }
                else
                {
                    holdId = InstallHoldV3(
                        context,
                        stored.Identity,
                        new[] { stored.Identity.IdempotencyKey },
                        now);
                }
            }

            RbpVerificationHold hold =
                ReadHoldV3(context, stored.Identity.Rsid, holdId) ??
                throw new RbpOutcomeV3ImportException(
                    "import_cross_session_hold",
                    "A legacy outcome references no same-session hold.");
            if (!hold.OrderedOriginIdempotencyKeys.Contains(
                    stored.Identity.IdempotencyKey,
                    StringComparer.Ordinal) ||
                stored.State == RbpInvocationState.Indeterminate &&
                stored.VerificationHoldId != holdId &&
                !supersededAtomicLegacyHolds.Contains(
                    stored.VerificationHoldId!))
            {
                throw new RbpOutcomeV3ImportException(
                    "import_hold_origin_mismatch",
                    "A legacy hold does not contain this uncertain origin.");
            }

            (string outcomeJson, string outcomeDigest) =
                BuildJournalIndeterminateOutcome(
                    context,
                    stored.Identity,
                    holdId);
            imported = stored with
            {
                State = RbpInvocationState.Indeterminate,
                TerminalOutcomeJson = outcomeJson,
                ResultDigest = outcomeDigest,
                VerificationHoldId = holdId,
                FinishedAtMilliseconds =
                    stored.FinishedAtMilliseconds ?? now,
            };
            evidence = RbpMutationOutcomeEvidence.Uncertain(
                RbpDispatchState.MayHaveReachedAddin,
                RbpTransactionMode.NotApplicable,
                dispatchedAtomicStep
                    ? "legacy_atomic_dispatch"
                    : "legacy_missing_truth");
        }
        else if (dispatchedAtomicStep &&
                 !stored.Identity.Mutating &&
                 !stored.IsTerminal)
        {
            (string outcomeJson, string outcomeDigest) =
                BuildEnvironmentReadOutcome();
            imported = stored with
            {
                State = RbpInvocationState.Failed,
                TerminalOutcomeJson = outcomeJson,
                ResultDigest = outcomeDigest,
                FinishedAtMilliseconds = now,
            };
            evidence = new RbpMutationOutcomeEvidence(
                RbpDispatchState.MayHaveReachedAddin,
                RbpEffectState.ReadOnly,
                RbpTransactionMode.NotApplicable,
                SerializeOutcomeEvidenceV3(
                    RbpDispatchState.MayHaveReachedAddin,
                    RbpEffectState.ReadOnly,
                    RbpTransactionMode.NotApplicable));
        }
        else if (stored.State == RbpInvocationState.Received)
        {
            evidence = RbpMutationOutcomeEvidence.NotDispatched(
                RbpTransactionMode.NotApplicable,
                "legacy_received");
        }
        else if (!stored.Identity.Mutating)
        {
            evidence = new RbpMutationOutcomeEvidence(
                RbpDispatchState.ResponseObserved,
                RbpEffectState.ReadOnly,
                RbpTransactionMode.NotApplicable,
                RbpMutationOutcomeEvidence.ForLegacyOutcome(
                    RbpAddinOutcomeKind.Completed,
                    RbpTransactionMode.NotApplicable,
                    mutating: false).EvidenceJcs);
        }
        else
        {
            // DC-02 keeps legacy completed/guarded mutations terminal. Their
            // absent effect proof remains explicit unknown.
            evidence = RbpMutationOutcomeEvidence.Uncertain(
                RbpDispatchState.ResponseObserved,
                RbpTransactionMode.NotApplicable,
                "legacy_terminal");
        }

        UpsertOutcomeV3(
            context,
            imported,
            evidence,
            ToStorageState(imported.State),
            now);
    }

    private static void ImportLegacyBatch(
        RbpJournalWriteContext context,
        RbpStoredBatch batch,
        long now)
    {
        using SqliteCommand insert = context.CreateCommand(
            """
            INSERT INTO rbp_batches_v3(
              batch_key,record_schema,rsid,state,terminal_outcome_json,
              result_digest,dispatched_at_ms,finished_at_ms,record_version,
              created_at_ms,updated_at_ms
            ) VALUES(
              $key,'bridge.rbp-batch/v3',$rsid,$state,$outcome,$digest,
              $dispatched,$finished,1,$created,$now
            );
            """);
        insert.Parameters.AddWithValue("$key", batch.BatchKey);
        insert.Parameters.AddWithValue("$rsid", batch.Rsid);
        insert.Parameters.AddWithValue(
            "$state",
            batch.State switch
            {
                RbpBatchState.Received => "received",
                RbpBatchState.Dispatched => "dispatched",
                RbpBatchState.Terminal => "terminal",
                _ => throw new RbpOutcomeV3ImportException(
                    "import_unknown_batch_state",
                    "A legacy batch has an unknown state."),
            });
        insert.Parameters.AddWithValue(
            "$outcome",
            (object?)batch.TerminalOutcomeJson ?? DBNull.Value);
        insert.Parameters.AddWithValue(
            "$digest",
            (object?)batch.ResultDigest ?? DBNull.Value);
        insert.Parameters.AddWithValue(
            "$dispatched",
            (object?)batch.DispatchedAtMilliseconds ?? DBNull.Value);
        insert.Parameters.AddWithValue(
            "$finished",
            (object?)batch.FinishedAtMilliseconds ?? DBNull.Value);
        insert.Parameters.AddWithValue("$created", batch.CreatedAtMilliseconds);
        insert.Parameters.AddWithValue("$now", now);
        if (insert.ExecuteNonQuery() != 1)
        {
            throw new RbpOutcomeV3ImportException(
                "import_batch_write",
                "A legacy batch could not be imported.");
        }
    }

    private static RbpStoredBatch? ReadLegacyBatchV2(
        RbpJournalWriteContext context,
        string batchKey)
    {
        using SqliteCommand command = context.CreateCommand(
            $"""
             SELECT {BatchColumns}
             FROM rbp_batches
             WHERE batch_key=$key;
             """);
        command.Parameters.AddWithValue("$key", batchKey);
        return MaterializeBatch(command);
    }

    private static RbpStoredBatch? ReadBatchV3(
        RbpJournalWriteContext context,
        string batchKey)
    {
        RbpStoredBatch? identity = ReadLegacyBatchV2(context, batchKey);
        if (identity is null)
        {
            return null;
        }

        using SqliteCommand command = context.CreateCommand(
            """
            SELECT state,terminal_outcome_json,result_digest,
                   dispatched_at_ms,finished_at_ms,created_at_ms
            FROM rbp_batches_v3 WHERE batch_key=$key AND rsid=$rsid;
            """);
        command.Parameters.AddWithValue("$key", batchKey);
        command.Parameters.AddWithValue("$rsid", identity.Rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        RbpBatchState state = reader.GetString(0) switch
        {
            "received" => RbpBatchState.Received,
            "dispatched" => RbpBatchState.Dispatched,
            "terminal" => RbpBatchState.Terminal,
            _ => throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "A v3 batch has an unknown state."),
        };
        return identity with
        {
            State = state,
            TerminalOutcomeJson =
                reader.IsDBNull(1) ? null : reader.GetString(1),
            ResultDigest = reader.IsDBNull(2) ? null : reader.GetString(2),
            DispatchedAtMilliseconds =
                reader.IsDBNull(3) ? null : reader.GetInt64(3),
            FinishedAtMilliseconds =
                reader.IsDBNull(4) ? null : reader.GetInt64(4),
        };
    }

    private RbpStoredBatch? ReadBatchV3(
        SqliteConnection connection,
        RbpStoredBatch identity)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT state,terminal_outcome_json,result_digest,
                   dispatched_at_ms,finished_at_ms
            FROM rbp_batches_v3 WHERE batch_key=$key AND rsid=$rsid;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$key", identity.BatchKey);
        command.Parameters.AddWithValue("$rsid", identity.Rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        return identity with
        {
            State = reader.GetString(0) switch
            {
                "received" => RbpBatchState.Received,
                "dispatched" => RbpBatchState.Dispatched,
                "terminal" => RbpBatchState.Terminal,
                _ => throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "A v3 batch has an unknown state."),
            },
            TerminalOutcomeJson =
                reader.IsDBNull(1) ? null : reader.GetString(1),
            ResultDigest = reader.IsDBNull(2) ? null : reader.GetString(2),
            DispatchedAtMilliseconds =
                reader.IsDBNull(3) ? null : reader.GetInt64(3),
            FinishedAtMilliseconds =
                reader.IsDBNull(4) ? null : reader.GetInt64(4),
        };
    }

    private static void UpsertBatchV3(
        RbpJournalWriteContext context,
        RbpStoredBatch batch,
        long now)
    {
        using SqliteCommand upsert = context.CreateCommand(
            """
            INSERT INTO rbp_batches_v3(
              batch_key,record_schema,rsid,state,terminal_outcome_json,
              result_digest,dispatched_at_ms,finished_at_ms,record_version,
              created_at_ms,updated_at_ms
            ) VALUES(
              $key,'bridge.rbp-batch/v3',$rsid,$state,$outcome,$digest,
              $dispatched,$finished,1,$created,$now
            )
            ON CONFLICT(batch_key) DO UPDATE SET
              state=excluded.state,
              terminal_outcome_json=excluded.terminal_outcome_json,
              result_digest=excluded.result_digest,
              dispatched_at_ms=excluded.dispatched_at_ms,
              finished_at_ms=excluded.finished_at_ms,
              record_version=rbp_batches_v3.record_version+1,
              updated_at_ms=MAX(rbp_batches_v3.updated_at_ms,
                                excluded.updated_at_ms)
            WHERE rbp_batches_v3.rsid=excluded.rsid;
            """);
        upsert.Parameters.AddWithValue("$key", batch.BatchKey);
        upsert.Parameters.AddWithValue("$rsid", batch.Rsid);
        upsert.Parameters.AddWithValue(
            "$state",
            batch.State switch
            {
                RbpBatchState.Received => "received",
                RbpBatchState.Dispatched => "dispatched",
                RbpBatchState.Terminal => "terminal",
                _ => throw new ArgumentOutOfRangeException(nameof(batch)),
            });
        upsert.Parameters.AddWithValue(
            "$outcome",
            (object?)batch.TerminalOutcomeJson ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$digest",
            (object?)batch.ResultDigest ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$dispatched",
            (object?)batch.DispatchedAtMilliseconds ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$finished",
            (object?)batch.FinishedAtMilliseconds ?? DBNull.Value);
        upsert.Parameters.AddWithValue("$created", batch.CreatedAtMilliseconds);
        upsert.Parameters.AddWithValue("$now", now);
        if (upsert.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The v3 batch identity is contradictory.");
        }
    }

    private static string CanonicalLegacyInvocation(
        RbpStoredInvocation value) =>
        CanonicalizeImportValue(
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["batch_id"] = value.Identity.BatchId,
                ["batch_index"] = value.Identity.BatchIndex,
                ["created_at_ms"] = value.CreatedAtMilliseconds,
                ["finished_at_ms"] = value.FinishedAtMilliseconds,
                ["idempotency_key"] = value.Identity.IdempotencyKey,
                ["late_result_digest"] = value.LateResultDigest,
                ["late_terminal_outcome_json"] =
                    value.LateTerminalOutcomeJson,
                ["method"] = value.Identity.Method,
                ["mutating"] = value.Identity.Mutating,
                ["mutation_scope_jcs"] = value.Identity.MutationScopeJcs,
                ["params_digest"] = value.Identity.ParamsDigest,
                ["policy_jcs"] = value.Identity.PolicyJcs,
                ["recovery_clearances_jcs"] =
                    value.Identity.RecoveryClearancesJcs,
                ["result_digest"] = value.ResultDigest,
                ["rsid"] = value.Identity.Rsid,
                ["started_at_ms"] = value.StartedAtMilliseconds,
                ["state"] = ToStorageState(value.State),
                ["terminal_outcome_json"] = value.TerminalOutcomeJson,
                ["verification_correlation_json"] =
                    value.VerificationCorrelationJson,
                ["verification_hold_id"] = value.VerificationHoldId,
            });

    internal static long OutcomeV3CanonicalInvocationImportBytes(
        RbpStoredInvocation value) =>
        Encoding.UTF8.GetByteCount(
            "invocation|" + CanonicalLegacyInvocation(value)) + 1L;

    private static string CanonicalLegacyBatch(RbpStoredBatch value) =>
        CanonicalizeImportValue(
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["atomic"] = value.Atomic,
                ["batch_digest"] = value.BatchDigest,
                ["batch_key"] = value.BatchKey,
                ["created_at_ms"] = value.CreatedAtMilliseconds,
                ["dispatched_at_ms"] = value.DispatchedAtMilliseconds,
                ["finished_at_ms"] = value.FinishedAtMilliseconds,
                ["recovery_clearances_jcs"] =
                    value.RecoveryClearancesJcs,
                ["result_digest"] = value.ResultDigest,
                ["rsid"] = value.Rsid,
                ["state"] = value.State.ToString(),
                ["step_count"] = value.StepCount,
                ["steps_jcs"] = value.StepsJcs,
                ["terminal_outcome_json"] = value.TerminalOutcomeJson,
                ["timeout_ms"] = value.TimeoutMilliseconds,
            });

    private static string CanonicalLegacyHold(RbpVerificationHold value) =>
        CanonicalizeImportValue(
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["audit_id"] = value.AuditId,
                ["cleared_at_ms"] = value.ClearedAtMilliseconds,
                ["created_at_ms"] = value.CreatedAtMilliseconds,
                ["document_id"] = value.DocumentId,
                ["evidence_digest"] = value.EvidenceDigest,
                ["hold_id"] = value.VerificationHoldId,
                ["ordered_origin_keys"] =
                    value.OrderedOriginIdempotencyKeys,
                ["resolution_basis"] = value.ResolutionBasis,
                ["resolution_decision"] = value.ResolutionDecision,
                ["resolution_id"] = value.ResolutionId,
                ["rsid"] = value.Rsid,
                ["scope_jcs"] = value.ScopeJcs,
                ["scope_kind"] = value.ScopeKind,
                ["state"] = ToStorageHoldState(value.State),
                ["updated_at_ms"] = value.UpdatedAtMilliseconds,
                ["verification_invocation_id"] =
                    value.VerificationInvocationId,
            });

    private static string CanonicalizeImportValue(object value)
    {
        using JsonDocument document = JsonDocument.Parse(
            JsonSerializer.Serialize(value));
        return Rfc8785Json.Canonicalize(document.RootElement);
    }

    private static long CountRowsForSession(
        RbpJournalWriteContext context,
        string tableName,
        string rsid)
    {
        string table = tableName switch
        {
            "rbp_outcome_dispatch_v3" => "rbp_outcome_dispatch_v3",
            "rbp_batches_v3" => "rbp_batches_v3",
            "rbp_mutation_holds_v3" => "rbp_mutation_holds_v3",
            "rbp_mutation_conflicts_v3" => "rbp_mutation_conflicts_v3",
            _ => throw new ArgumentOutOfRangeException(nameof(tableName)),
        };
        using SqliteCommand command = context.CreateCommand(
            $"SELECT COUNT(*) FROM {table} WHERE rsid=$rsid;");
        command.Parameters.AddWithValue("$rsid", rsid);
        return Convert.ToInt64(command.ExecuteScalar());
    }

    private static long CountResolutionsForSession(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT COUNT(*) FROM rbp_mutation_resolutions_v3
            WHERE rsid=$rsid;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        return Convert.ToInt64(command.ExecuteScalar());
    }

    private static void ValidateOutcomeV3Cutover(
        RbpOutcomeV3Cutover marker)
    {
        if (marker.TargetGeneration != OutcomeV3Generation ||
            marker.State != "normalized_authoritative" ||
            marker.ImportedDispatchCount < 0 ||
            marker.ImportedHoldCount < 0 ||
            marker.ImportedConflictCount < 0 ||
            marker.ImportedResolutionCount < 0 ||
            marker.ImportedCanonicalBytes < 0 ||
            marker.ImportedCanonicalBytes >
                OutcomeV3ImportMaximumCanonicalBytes ||
            !RbpRecoveryClearance.IsSha256Digest(marker.LegacyDigest))
        {
            throw new RbpOutcomeV3ImportException(
                "import_marker_corrupt",
                "The Bridge outcome cutover marker is contradictory.");
        }
    }

    private static void UpsertOutcomeV3(
        RbpJournalWriteContext context,
        RbpStoredInvocation invocation,
        RbpMutationOutcomeEvidence evidence,
        string terminalState,
        long now,
        string? lateProvenanceDigest = null)
    {
        ValidateOutcomeEvidence(evidence);
        string? effectiveLateProvenance =
            invocation.LateTerminalOutcomeJson is null
                ? null
                : lateProvenanceDigest ?? Sha256("legacy_late_terminal");
        using SqliteCommand upsert = context.CreateCommand(
            """
            INSERT INTO rbp_outcome_dispatch_v3(
              idempotency_key,record_schema,rsid,dispatch_state,effect_state,
              transaction_mode,evidence_jcs,terminal_state,
              terminal_outcome_json,result_digest,verification_hold_id,
              verification_correlation_json,late_terminal_outcome_json,
              late_result_digest,late_provenance_digest,started_at_ms,
              finished_at_ms,record_version,
              created_at_ms,updated_at_ms
            ) VALUES(
              $key,'bridge.rbp-dispatch/v3',$rsid,$dispatch,$effect,$mode,
              $evidence,$terminal,$outcome,$result_digest,$hold,
              $verification,$late_outcome,$late_digest,$late_provenance,
              $started,$finished,
              1,$created,$now
            )
            ON CONFLICT(idempotency_key) DO UPDATE SET
              dispatch_state=excluded.dispatch_state,
              effect_state=excluded.effect_state,
              transaction_mode=excluded.transaction_mode,
              evidence_jcs=excluded.evidence_jcs,
              terminal_state=excluded.terminal_state,
              terminal_outcome_json=excluded.terminal_outcome_json,
              result_digest=excluded.result_digest,
              verification_hold_id=excluded.verification_hold_id,
              verification_correlation_json=
                excluded.verification_correlation_json,
              late_terminal_outcome_json=COALESCE(
                rbp_outcome_dispatch_v3.late_terminal_outcome_json,
                excluded.late_terminal_outcome_json),
              late_result_digest=COALESCE(
                rbp_outcome_dispatch_v3.late_result_digest,
                excluded.late_result_digest),
              late_provenance_digest=COALESCE(
                rbp_outcome_dispatch_v3.late_provenance_digest,
                excluded.late_provenance_digest),
              started_at_ms=excluded.started_at_ms,
              finished_at_ms=excluded.finished_at_ms,
              record_version=rbp_outcome_dispatch_v3.record_version+1,
              updated_at_ms=MAX(rbp_outcome_dispatch_v3.updated_at_ms,
                                excluded.updated_at_ms)
            WHERE rbp_outcome_dispatch_v3.record_schema=
                    'bridge.rbp-dispatch/v3'
              AND rbp_outcome_dispatch_v3.rsid=excluded.rsid
              AND (
                rbp_outcome_dispatch_v3.late_terminal_outcome_json IS NULL OR
                excluded.late_terminal_outcome_json IS NULL OR
                (
                  rbp_outcome_dispatch_v3.late_terminal_outcome_json=
                    excluded.late_terminal_outcome_json AND
                  rbp_outcome_dispatch_v3.late_result_digest=
                    excluded.late_result_digest AND
                  rbp_outcome_dispatch_v3.late_provenance_digest=
                    excluded.late_provenance_digest
                )
              );
            """);
        upsert.Parameters.AddWithValue(
            "$key",
            invocation.Identity.IdempotencyKey);
        upsert.Parameters.AddWithValue("$rsid", invocation.Identity.Rsid);
        upsert.Parameters.AddWithValue(
            "$dispatch",
            RbpMutationOutcomeEvidence.ToWire(evidence.DispatchState));
        upsert.Parameters.AddWithValue(
            "$effect",
            RbpMutationOutcomeEvidence.ToWire(evidence.EffectState));
        upsert.Parameters.AddWithValue(
            "$mode",
            RbpMutationOutcomeEvidence.ToWire(evidence.TransactionMode));
        upsert.Parameters.AddWithValue(
            "$evidence",
            SerializeOutcomeEvidenceV3(
                evidence.DispatchState,
                evidence.EffectState,
                evidence.TransactionMode));
        upsert.Parameters.AddWithValue("$terminal", terminalState);
        upsert.Parameters.AddWithValue(
            "$outcome",
            (object?)invocation.TerminalOutcomeJson ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$result_digest",
            (object?)invocation.ResultDigest ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$hold",
            (object?)invocation.VerificationHoldId ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$verification",
            (object?)invocation.VerificationCorrelationJson ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$late_outcome",
            (object?)invocation.LateTerminalOutcomeJson ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$late_digest",
            (object?)invocation.LateResultDigest ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$late_provenance",
            (object?)effectiveLateProvenance ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$started",
            (object?)invocation.StartedAtMilliseconds ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$finished",
            (object?)invocation.FinishedAtMilliseconds ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$created",
            invocation.CreatedAtMilliseconds);
        upsert.Parameters.AddWithValue("$now", now);
        if (upsert.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The v3 dispatch outcome identity is contradictory.");
        }
    }

    private static void MirrorLegacyHoldV3(
        RbpJournalWriteContext context,
        RbpVerificationHold hold,
        long now)
    {
        if (hold.OrderedOriginIdempotencyKeys.Count > 1)
        {
            ValidateGroupedHoldMaterial(hold);
        }

        WriteHoldHistoryV3(context, hold, now);
        SynchronizeConflictV3(context, hold, now);
        bool hasResolution = hold.ResolutionId is { Length: > 0 };
        if (hasResolution)
        {
            MirrorResolutionV3(context, hold, now);
        }

    }

    private static string InstallHoldV3(
        RbpJournalWriteContext context,
        RbpInvocationIdentity identity,
        IReadOnlyList<string> orderedOriginIdempotencyKeys,
        long now)
    {
        if (identity.MutationScopeJcs is not { Length: > 0 } scopeJcs)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "A v3 mutation hold requires a mutation scope.");
        }

        RbpVerificationHold? existing =
            FindExactActiveHoldV3(context, identity.Rsid, scopeJcs);
        if (existing is not null)
        {
            if (!existing.OrderedOriginIdempotencyKeys.SequenceEqual(
                    orderedOriginIdempotencyKeys,
                    StringComparer.Ordinal))
            {
                if (!HasOutcomeV3Cutover(context, identity.Rsid))
                {
                    throw new RbpOutcomeV3ImportException(
                        "import_independent_scope_collision",
                        "Independent legacy uncertainties share one scope.");
                }

                throw new RbpJournalException(
                    RbpJournalErrorCode.ProtocolConflict,
                    "An active v3 scope hold has different ordered origins.");
            }

            return existing.VerificationHoldId;
        }

        string holdId;
        using (JsonDocument scope = JsonDocument.Parse(scopeJcs))
        {
            holdId = Rfc8785Json.MakeVerificationHoldId(
                identity.Rsid,
                scope.RootElement,
                orderedOriginIdempotencyKeys);
        }

        if (ReadHoldV3(context, identity.Rsid, holdId) is not null)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "A cleared v3 hold identity cannot be resurrected.");
        }

        (string scopeKind, string? documentId) = ReadScopeShape(scopeJcs);
        var hold = new RbpVerificationHold(
            holdId,
            identity.Rsid,
            scopeKind,
            documentId,
            scopeJcs,
            Array.AsReadOnly(orderedOriginIdempotencyKeys.ToArray()),
            RbpHoldState.Active,
            VerificationInvocationId: null,
            EvidenceDigest: null,
            ResolutionId: null,
            ResolutionBasis: null,
            ResolutionDecision: null,
            AuditId: null,
            CreatedAtMilliseconds: now,
            UpdatedAtMilliseconds: now,
            ClearedAtMilliseconds: null);
        WriteHoldHistoryV3(context, hold, now);
        SynchronizeConflictV3(context, hold, now);
        return holdId;
    }

    private static void WriteHoldHistoryV3(
        RbpJournalWriteContext context,
        RbpVerificationHold hold,
        long now)
    {
        using SqliteCommand upsert = context.CreateCommand(
            """
            INSERT INTO rbp_mutation_holds_v3(
              hold_id,record_schema,rsid,mutation_scope_jcs,
              ordered_origin_keys_json,state,verification_invocation_id,
              evidence_digest,resolution_id,record_version,created_at_ms,
              updated_at_ms,cleared_at_ms
            ) VALUES(
              $id,'bridge.mutation-hold/v1',$rsid,$scope,$origins,$state,
              $verification,$evidence,$resolution,1,$created,$now,$cleared
            )
            ON CONFLICT(hold_id) DO UPDATE SET
              state=excluded.state,
              verification_invocation_id=excluded.verification_invocation_id,
              evidence_digest=excluded.evidence_digest,
              resolution_id=excluded.resolution_id,
              cleared_at_ms=excluded.cleared_at_ms,
              record_version=rbp_mutation_holds_v3.record_version+1,
              updated_at_ms=MAX(
                rbp_mutation_holds_v3.updated_at_ms,
                excluded.updated_at_ms)
            WHERE rbp_mutation_holds_v3.record_schema=
                    'bridge.mutation-hold/v1'
              AND rbp_mutation_holds_v3.rsid=excluded.rsid
              AND rbp_mutation_holds_v3.mutation_scope_jcs=
                    excluded.mutation_scope_jcs
              AND rbp_mutation_holds_v3.ordered_origin_keys_json=
                    excluded.ordered_origin_keys_json;
            """);
        upsert.Parameters.AddWithValue("$id", hold.VerificationHoldId);
        upsert.Parameters.AddWithValue("$rsid", hold.Rsid);
        upsert.Parameters.AddWithValue("$scope", hold.ScopeJcs);
        upsert.Parameters.AddWithValue(
            "$origins",
            JsonSerializer.Serialize(hold.OrderedOriginIdempotencyKeys));
        upsert.Parameters.AddWithValue("$state", ToStorageHoldState(hold.State));
        upsert.Parameters.AddWithValue(
            "$verification",
            (object?)hold.VerificationInvocationId ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$evidence",
            (object?)hold.EvidenceDigest ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$resolution",
            (object?)hold.ResolutionId ?? DBNull.Value);
        upsert.Parameters.AddWithValue(
            "$created",
            hold.CreatedAtMilliseconds);
        upsert.Parameters.AddWithValue("$now", now);
        upsert.Parameters.AddWithValue(
            "$cleared",
            (object?)hold.ClearedAtMilliseconds ?? DBNull.Value);
        if (upsert.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The v3 hold identity is contradictory.");
        }
    }

    private static void SynchronizeConflictV3(
        RbpJournalWriteContext context,
        RbpVerificationHold hold,
        long now)
    {
        string scopeDigest = Sha256(hold.ScopeJcs);
        string conflictKey = hold.Rsid + "/" + scopeDigest;
        if (hold.State == RbpHoldState.Cleared)
        {
            using SqliteCommand clear = context.CreateCommand(
                """
                UPDATE rbp_mutation_conflicts_v3
                SET active=0,
                    record_version=record_version+1,
                    updated_at_ms=MAX(updated_at_ms,$now)
                WHERE conflict_key=$key AND rsid=$rsid
                  AND hold_id=$hold AND active=1;
                """);
            clear.Parameters.AddWithValue("$key", conflictKey);
            clear.Parameters.AddWithValue("$rsid", hold.Rsid);
            clear.Parameters.AddWithValue("$hold", hold.VerificationHoldId);
            clear.Parameters.AddWithValue("$now", now);
            if (clear.ExecuteNonQuery() == 1)
            {
                return;
            }

            using SqliteCommand insertInactive = context.CreateCommand(
                """
                INSERT INTO rbp_mutation_conflicts_v3(
                  conflict_key,record_schema,rsid,scope_digest,hold_id,
                  mutation_scope_jcs,active,record_version,
                  created_at_ms,updated_at_ms
                ) VALUES(
                  $key,'bridge.mutation-conflict/v1',$rsid,$digest,$hold,
                  $scope,0,1,$created,$now
                ) ON CONFLICT(conflict_key) DO NOTHING;
                """);
            insertInactive.Parameters.AddWithValue("$key", conflictKey);
            insertInactive.Parameters.AddWithValue("$rsid", hold.Rsid);
            insertInactive.Parameters.AddWithValue("$digest", scopeDigest);
            insertInactive.Parameters.AddWithValue(
                "$hold",
                hold.VerificationHoldId);
            insertInactive.Parameters.AddWithValue("$scope", hold.ScopeJcs);
            insertInactive.Parameters.AddWithValue(
                "$created",
                hold.CreatedAtMilliseconds);
            insertInactive.Parameters.AddWithValue("$now", now);
            _ = insertInactive.ExecuteNonQuery();
            return;
        }

        using SqliteCommand attach = context.CreateCommand(
            """
            INSERT INTO rbp_mutation_conflicts_v3(
              conflict_key,record_schema,rsid,scope_digest,hold_id,
              mutation_scope_jcs,active,record_version,
              created_at_ms,updated_at_ms
            ) VALUES(
              $key,'bridge.mutation-conflict/v1',$rsid,$digest,$hold,$scope,
              1,1,$created,$now
            )
            ON CONFLICT(conflict_key) DO UPDATE SET
              hold_id=excluded.hold_id,
              mutation_scope_jcs=excluded.mutation_scope_jcs,
              active=1,
              record_version=rbp_mutation_conflicts_v3.record_version+1,
              updated_at_ms=MAX(
                rbp_mutation_conflicts_v3.updated_at_ms,
                excluded.updated_at_ms)
            WHERE rbp_mutation_conflicts_v3.record_schema=
                    'bridge.mutation-conflict/v1'
              AND rbp_mutation_conflicts_v3.rsid=excluded.rsid
              AND rbp_mutation_conflicts_v3.scope_digest=
                    excluded.scope_digest
              AND rbp_mutation_conflicts_v3.mutation_scope_jcs=
                    excluded.mutation_scope_jcs
              AND (
                rbp_mutation_conflicts_v3.active=0 OR
                rbp_mutation_conflicts_v3.hold_id=excluded.hold_id
              );
            """);
        attach.Parameters.AddWithValue("$key", conflictKey);
        attach.Parameters.AddWithValue("$rsid", hold.Rsid);
        attach.Parameters.AddWithValue("$digest", scopeDigest);
        attach.Parameters.AddWithValue("$hold", hold.VerificationHoldId);
        attach.Parameters.AddWithValue("$scope", hold.ScopeJcs);
        attach.Parameters.AddWithValue(
            "$created",
            hold.CreatedAtMilliseconds);
        attach.Parameters.AddWithValue("$now", now);
        if (attach.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "A different active v3 hold already owns this scope.");
        }
    }

    private static bool HasOutcomeV3Cutover(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT COUNT(*) FROM rbp_hold_cutover_v3
            WHERE rsid=$rsid AND target_generation='bridge-outcome-v3'
              AND state='normalized_authoritative';
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        return Convert.ToInt32(command.ExecuteScalar()) == 1;
    }

    private bool HasOutcomeV3Cutover(
        SqliteConnection connection,
        string rsid)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT COUNT(*) FROM rbp_hold_cutover_v3
            WHERE rsid=$rsid AND target_generation='bridge-outcome-v3'
              AND state='normalized_authoritative';
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        return Convert.ToInt32(command.ExecuteScalar()) == 1;
    }

    private static RbpVerificationHold? FindExactActiveHoldV3(
        RbpJournalWriteContext context,
        string rsid,
        string scopeJcs)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT hold_id FROM rbp_mutation_holds_v3
            WHERE rsid=$rsid AND mutation_scope_jcs=$scope
              AND state<>'cleared'
            ORDER BY created_at_ms,hold_id
            LIMIT 1;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$scope", scopeJcs);
        object? scalar = command.ExecuteScalar();
        return scalar is string holdId
            ? ReadHoldV3(context, rsid, holdId)
            : null;
    }

    private static RbpVerificationHold? FindConflictingHoldV3(
        RbpJournalWriteContext context,
        string rsid,
        string scopeJcs)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT hold_id FROM rbp_mutation_conflicts_v3
            WHERE rsid=$rsid AND active=1
            ORDER BY created_at_ms,hold_id;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        var holdIds = new List<string>();
        using (SqliteDataReader reader = command.ExecuteReader())
        {
            while (reader.Read())
            {
                holdIds.Add(reader.GetString(0));
            }
        }

        foreach (string holdId in holdIds)
        {
            RbpVerificationHold hold =
                ReadHoldV3(context, rsid, holdId) ??
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "An active v3 conflict lost its hold.");
            if (ScopeConflicts(scopeJcs, hold))
            {
                return hold;
            }
        }

        return null;
    }

    private RbpVerificationHold? FindConflictingHoldV3(
        SqliteConnection connection,
        string rsid,
        string scopeJcs)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT hold_id FROM rbp_mutation_conflicts_v3
            WHERE rsid=$rsid AND active=1
            ORDER BY created_at_ms,hold_id;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        var holdIds = new List<string>();
        using (SqliteDataReader reader = command.ExecuteReader())
        {
            while (reader.Read())
            {
                holdIds.Add(reader.GetString(0));
            }
        }

        foreach (string holdId in holdIds)
        {
            RbpVerificationHold hold =
                ReadHoldV3(connection, rsid, holdId) ??
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "An active v3 conflict lost its hold.");
            if (ScopeConflicts(scopeJcs, hold))
            {
                return hold;
            }
        }

        return null;
    }

    private static RbpVerificationHold? ReadHoldV3(
        RbpJournalWriteContext context,
        string rsid,
        string holdId)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT hold.hold_id,hold.rsid,hold.mutation_scope_jcs,
                   hold.ordered_origin_keys_json,hold.state,
                   hold.verification_invocation_id,hold.evidence_digest,
                   hold.resolution_id,resolution.basis,resolution.decision,
                   resolution.audit_id,hold.created_at_ms,hold.updated_at_ms,
                   hold.cleared_at_ms
            FROM rbp_mutation_holds_v3 AS hold
            LEFT JOIN rbp_mutation_resolutions_v3 AS resolution
              ON resolution.resolution_id=hold.resolution_id
             AND resolution.rsid=hold.rsid
            WHERE hold.hold_id=$hold AND hold.rsid=$rsid;
            """);
        command.Parameters.AddWithValue("$hold", holdId);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        string scopeJcs = reader.GetString(2);
        (string scopeKind, string? documentId) = ReadScopeShape(scopeJcs);
        IReadOnlyList<string> origins =
            JsonSerializer.Deserialize<string[]>(reader.GetString(3)) ??
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "A v3 hold has unreadable ordered origins.");
        var hold = new RbpVerificationHold(
            reader.GetString(0),
            reader.GetString(1),
            scopeKind,
            documentId,
            scopeJcs,
            origins,
            FromStorageHoldState(reader.GetString(4)),
            reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.IsDBNull(7) ? null : reader.GetString(7),
            reader.IsDBNull(8) ? null : reader.GetString(8),
            reader.IsDBNull(9) ? null : reader.GetString(9),
            reader.IsDBNull(10) ? null : reader.GetString(10),
            reader.GetInt64(11),
            reader.GetInt64(12),
            reader.IsDBNull(13) ? null : reader.GetInt64(13));
        if (reader.Read())
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "A v3 hold has multiple resolution rows.");
        }

        return hold;
    }

    private RbpVerificationHold? ReadHoldV3(
        SqliteConnection connection,
        string rsid,
        string holdId)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT hold.hold_id,hold.rsid,hold.mutation_scope_jcs,
                   hold.ordered_origin_keys_json,hold.state,
                   hold.verification_invocation_id,hold.evidence_digest,
                   hold.resolution_id,resolution.basis,resolution.decision,
                   resolution.audit_id,hold.created_at_ms,hold.updated_at_ms,
                   hold.cleared_at_ms
            FROM rbp_mutation_holds_v3 AS hold
            LEFT JOIN rbp_mutation_resolutions_v3 AS resolution
              ON resolution.resolution_id=hold.resolution_id
             AND resolution.rsid=hold.rsid
            WHERE hold.hold_id=$hold AND hold.rsid=$rsid;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$hold", holdId);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        string scopeJcs = reader.GetString(2);
        (string scopeKind, string? documentId) = ReadScopeShape(scopeJcs);
        IReadOnlyList<string> origins =
            JsonSerializer.Deserialize<string[]>(reader.GetString(3)) ??
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "A v3 hold has unreadable ordered origins.");
        return new RbpVerificationHold(
            reader.GetString(0),
            reader.GetString(1),
            scopeKind,
            documentId,
            scopeJcs,
            origins,
            FromStorageHoldState(reader.GetString(4)),
            reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.IsDBNull(7) ? null : reader.GetString(7),
            reader.IsDBNull(8) ? null : reader.GetString(8),
            reader.IsDBNull(9) ? null : reader.GetString(9),
            reader.IsDBNull(10) ? null : reader.GetString(10),
            reader.GetInt64(11),
            reader.GetInt64(12),
            reader.IsDBNull(13) ? null : reader.GetInt64(13));
    }

    private static RbpOutcomeV3ResolutionSnapshot? ReadResolutionV3(
        RbpJournalWriteContext context,
        string resolutionId)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT resolution_id,rsid,hold_id,basis,verification_invocation_id,
                   evidence_digest,decision,audit_id,state,record_version
            FROM rbp_mutation_resolutions_v3
            WHERE resolution_id=$resolution;
            """);
        command.Parameters.AddWithValue("$resolution", resolutionId);
        using SqliteDataReader reader = command.ExecuteReader();
        return reader.Read()
            ? new RbpOutcomeV3ResolutionSnapshot(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.GetString(5),
                reader.GetString(6),
                reader.GetString(7),
                reader.GetString(8),
                reader.GetInt64(9))
            : null;
    }

    private static bool HasDurableLateTerminalV3(
        RbpJournalWriteContext context,
        string holdId,
        string evidenceDigest)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT COUNT(*) FROM rbp_outcome_dispatch_v3
            WHERE verification_hold_id=$hold
              AND terminal_state='indeterminate'
              AND late_terminal_outcome_json IS NOT NULL
              AND late_result_digest=$digest;
            """);
        command.Parameters.AddWithValue("$hold", holdId);
        command.Parameters.AddWithValue("$digest", evidenceDigest);
        return Convert.ToInt32(command.ExecuteScalar()) == 1;
    }

    private static void InsertResolutionV3(
        RbpJournalWriteContext context,
        RbpVerificationHold hold,
        RbpRecoveryClearance clearance,
        string basis,
        string decision,
        long now)
    {
        using SqliteCommand insert = context.CreateCommand(
            """
            INSERT INTO rbp_mutation_resolutions_v3(
              resolution_id,record_schema,rsid,hold_id,basis,
              verification_invocation_id,evidence_digest,decision,audit_id,
              state,record_version,created_at_ms,updated_at_ms
            ) VALUES(
              $resolution,'bridge.mutation-resolution/v1',$rsid,$hold,$basis,
              $vid,
              $evidence,$decision,$audit,'accepted',1,$now,$now
            )
            ON CONFLICT(resolution_id) DO UPDATE SET
              state='accepted',
              record_version=rbp_mutation_resolutions_v3.record_version+1,
              updated_at_ms=MAX(
                rbp_mutation_resolutions_v3.updated_at_ms,
                excluded.updated_at_ms)
            WHERE rbp_mutation_resolutions_v3.rsid=excluded.rsid
              AND rbp_mutation_resolutions_v3.hold_id=excluded.hold_id
              AND rbp_mutation_resolutions_v3.basis=excluded.basis
              AND rbp_mutation_resolutions_v3.verification_invocation_id
                    IS excluded.verification_invocation_id
              AND rbp_mutation_resolutions_v3.evidence_digest=
                    excluded.evidence_digest
              AND rbp_mutation_resolutions_v3.decision=excluded.decision
              AND rbp_mutation_resolutions_v3.audit_id=excluded.audit_id;
            """);
        insert.Parameters.AddWithValue(
            "$resolution",
            clearance.ResolutionId);
        insert.Parameters.AddWithValue("$rsid", hold.Rsid);
        insert.Parameters.AddWithValue("$hold", hold.VerificationHoldId);
        insert.Parameters.AddWithValue("$basis", basis);
        insert.Parameters.AddWithValue(
            "$vid",
            (object?)clearance.VerificationInvocationId ?? DBNull.Value);
        insert.Parameters.AddWithValue(
            "$evidence",
            clearance.EvidenceDigest);
        insert.Parameters.AddWithValue("$decision", decision);
        insert.Parameters.AddWithValue("$audit", clearance.AuditId);
        insert.Parameters.AddWithValue("$now", now);
        if (insert.ExecuteNonQuery() != 1)
        {
            throw ClearanceFault(
                "the v3 resolution identity conflicts with durable history");
        }
    }

    private static void MirrorResolutionV3(
        RbpJournalWriteContext context,
        RbpVerificationHold hold,
        long now)
    {
        string resolutionId = hold.ResolutionId!;
        string basis = hold.ResolutionBasis ?? string.Empty;
        bool validVerificationId = basis == "verification_read"
            ? RbpRecoveryClearance.IsUuidV7(hold.VerificationInvocationId)
            : basis == "late_terminal" &&
              hold.VerificationInvocationId is null;
        if (!RbpRecoveryClearance.IsUuidV7(resolutionId) ||
            !RbpRecoveryClearance.IsUuidV7(hold.AuditId) ||
            !RbpRecoveryClearance.IsSha256Digest(hold.EvidenceDigest) ||
            !validVerificationId ||
            hold.ResolutionDecision is not (
                "non_execution_proven" or "postcondition_verified"))
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "A durable hold resolution violates DC-02 evidence shape.");
        }

        if (hold.OrderedOriginIdempotencyKeys.Count > 1 &&
            basis != "verification_read")
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "A grouped legacy hold lacks aggregate verification_read " +
                "authority.");
        }

        using SqliteCommand resolution = context.CreateCommand(
            """
            INSERT INTO rbp_mutation_resolutions_v3(
              resolution_id,record_schema,rsid,hold_id,basis,
              verification_invocation_id,evidence_digest,decision,audit_id,
              state,record_version,created_at_ms,updated_at_ms
            ) VALUES(
              $resolution,'bridge.mutation-resolution/v1',$rsid,$hold,$basis,
              $vid,
              $evidence,$decision,$audit,$state,1,$created,$now
            )
            ON CONFLICT(resolution_id) DO UPDATE SET
              state=excluded.state,
              record_version=rbp_mutation_resolutions_v3.record_version+1,
              updated_at_ms=MAX(rbp_mutation_resolutions_v3.updated_at_ms,
                                excluded.updated_at_ms)
            WHERE rbp_mutation_resolutions_v3.record_schema=
                    'bridge.mutation-resolution/v1'
              AND rbp_mutation_resolutions_v3.rsid=excluded.rsid
              AND rbp_mutation_resolutions_v3.hold_id=excluded.hold_id
              AND rbp_mutation_resolutions_v3.basis=excluded.basis
              AND rbp_mutation_resolutions_v3.verification_invocation_id
                    IS excluded.verification_invocation_id
              AND rbp_mutation_resolutions_v3.evidence_digest=
                    excluded.evidence_digest
              AND rbp_mutation_resolutions_v3.decision=excluded.decision
              AND rbp_mutation_resolutions_v3.audit_id=excluded.audit_id;
            """);
        resolution.Parameters.AddWithValue("$resolution", resolutionId);
        resolution.Parameters.AddWithValue("$rsid", hold.Rsid);
        resolution.Parameters.AddWithValue("$hold", hold.VerificationHoldId);
        resolution.Parameters.AddWithValue("$basis", basis);
        resolution.Parameters.AddWithValue(
            "$vid",
            (object?)hold.VerificationInvocationId ?? DBNull.Value);
        resolution.Parameters.AddWithValue("$evidence", hold.EvidenceDigest!);
        resolution.Parameters.AddWithValue(
            "$decision",
            hold.ResolutionDecision!);
        resolution.Parameters.AddWithValue("$audit", hold.AuditId!);
        resolution.Parameters.AddWithValue(
            "$state",
            hold.State == RbpHoldState.Cleared
                ? "accepted"
                : "pending_bridge");
        resolution.Parameters.AddWithValue(
            "$created",
            hold.CreatedAtMilliseconds);
        resolution.Parameters.AddWithValue("$now", now);
        if (resolution.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The v3 resolution identity is contradictory.");
        }
    }

    private static IReadOnlyList<string> InvocationKeys(
        RbpJournalWriteContext context,
        string rsid,
        int maximumResults)
    {
        var keys = new List<string>();
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT idempotency_key FROM rbp_invocations
            WHERE rsid=$rsid ORDER BY idempotency_key
            LIMIT $limit;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$limit", maximumResults);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            keys.Add(reader.GetString(0));
        }

        return keys.AsReadOnly();
    }

    private static IReadOnlyList<string> BatchKeys(
        RbpJournalWriteContext context,
        string rsid,
        int maximumResults)
    {
        var keys = new List<string>();
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT batch_key FROM rbp_batches
            WHERE rsid=$rsid ORDER BY batch_key
            LIMIT $limit;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$limit", maximumResults);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            keys.Add(reader.GetString(0));
        }

        return keys.AsReadOnly();
    }

    private static IReadOnlyList<string> BatchInvocationKeys(
        RbpJournalWriteContext context,
        string rsid,
        string batchId)
    {
        var keys = new List<string>();
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT idempotency_key FROM rbp_invocations
            WHERE rsid=$rsid AND batch_id=$batch
            ORDER BY batch_index;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$batch", batchId);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            keys.Add(reader.GetString(0));
        }

        return keys.AsReadOnly();
    }

    private static IReadOnlyList<string> HoldIds(
        RbpJournalWriteContext context,
        string rsid,
        int maximumResults = OutcomeV3ImportMaximumRows + 1)
    {
        var ids = new List<string>();
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT verification_hold_id FROM rbp_verification_holds
            WHERE rsid=$rsid ORDER BY verification_hold_id
            LIMIT $limit;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$limit", maximumResults);
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            ids.Add(reader.GetString(0));
        }

        return ids.AsReadOnly();
    }

    private static RbpOutcomeV3Cutover? ReadOutcomeV3Cutover(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT rsid,legacy_digest,imported_dispatch_count,
                   imported_hold_count,imported_conflict_count,
                   imported_resolution_count,imported_canonical_bytes,
                   target_generation,state
            FROM rbp_hold_cutover_v3 WHERE rsid=$rsid;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return reader.Read() ? MaterializeOutcomeV3Cutover(reader) : null;
    }

    private static RbpOutcomeV3Cutover MaterializeOutcomeV3Cutover(
        SqliteDataReader reader) =>
        new(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetInt64(2),
            reader.GetInt64(3),
            reader.GetInt64(4),
            reader.GetInt64(5),
            reader.GetInt64(6),
            reader.GetString(7),
            reader.GetString(8));

    private static RbpStoredInvocation? ReadOutcomeV3Invocation(
        RbpJournalWriteContext context,
        string idempotencyKey)
    {
        RbpStoredInvocation? identity =
            ReadLegacyInvocationV2(context, idempotencyKey);
        if (identity is null)
        {
            return null;
        }

        using SqliteCommand command = context.CreateCommand(
            """
            SELECT dispatch_state,effect_state,transaction_mode,evidence_jcs,
                   terminal_state,terminal_outcome_json,result_digest,
                   verification_hold_id,verification_correlation_json,
                   late_terminal_outcome_json,late_result_digest,
                   started_at_ms,finished_at_ms,created_at_ms
            FROM rbp_outcome_dispatch_v3
            WHERE idempotency_key=$key AND rsid=$rsid;
            """);
        command.Parameters.AddWithValue("$key", idempotencyKey);
        command.Parameters.AddWithValue("$rsid", identity.Identity.Rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        string dispatch = reader.GetString(0);
        string effect = reader.GetString(1);
        string mode = reader.GetString(2);
        string evidenceJcs = reader.GetString(3);
        if (!string.Equals(
                evidenceJcs,
                SerializeOutcomeEvidenceV3(
                    ParseDispatchStateV3(dispatch),
                    ParseEffectStateV3(effect),
                    ParseTransactionModeV3(mode)),
                StringComparison.Ordinal))
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "Outcome-v3 evidence columns disagree with evidence_jcs.");
        }

        var stored = new RbpStoredInvocation(
            identity.Identity,
            FromStorageState(reader.GetString(4)),
            reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.IsDBNull(7) ? null : reader.GetString(7),
            reader.IsDBNull(8) ? null : reader.GetString(8),
            reader.IsDBNull(9) ? null : reader.GetString(9),
            reader.IsDBNull(10) ? null : reader.GetString(10),
            reader.GetInt64(13),
            reader.IsDBNull(11) ? null : reader.GetInt64(11),
            reader.IsDBNull(12) ? null : reader.GetInt64(12));
        if (reader.Read())
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "Outcome-v3 has duplicate invocation rows.");
        }

        return stored;
    }

    private static RbpOutcomeV3EvidenceSnapshot ReadOutcomeV3Evidence(
        RbpJournalWriteContext context,
        string idempotencyKey)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT dispatch_state,effect_state,transaction_mode,evidence_jcs,
                   late_provenance_digest
            FROM rbp_outcome_dispatch_v3
            WHERE idempotency_key=$key;
            """);
        command.Parameters.AddWithValue("$key", idempotencyKey);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "Outcome-v3 evidence disappeared during read-back.");
        }

        RbpDispatchState dispatch = ParseDispatchStateV3(reader.GetString(0));
        RbpEffectState effect = ParseEffectStateV3(reader.GetString(1));
        RbpTransactionMode mode = ParseTransactionModeV3(reader.GetString(2));
        string evidenceJcs = reader.GetString(3);
        string? lateProvenance =
            reader.IsDBNull(4) ? null : reader.GetString(4);
        if (evidenceJcs != SerializeOutcomeEvidenceV3(dispatch, effect, mode) ||
            reader.Read())
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "Outcome-v3 typed evidence is contradictory.");
        }

        return new RbpOutcomeV3EvidenceSnapshot(
            dispatch,
            effect,
            mode,
            evidenceJcs,
            lateProvenance);
    }

    private static RbpStoredInvocation? ReadLegacyInvocationV2(
        RbpJournalWriteContext context,
        string idempotencyKey)
    {
        using SqliteCommand command = context.CreateCommand(
            $"""
             SELECT {InvocationColumns}
             FROM rbp_invocations
             WHERE idempotency_key=$key;
             """);
        command.Parameters.AddWithValue("$key", idempotencyKey);
        return MaterializeInvocation(command);
    }

    private RbpStoredInvocation? ReadOutcomeV3Invocation(
        SqliteConnection connection,
        string idempotencyKey)
    {
        using SqliteCommand identityCommand = CreateCommand(
            connection,
            $"""
             SELECT {InvocationColumns}
             FROM rbp_invocations
             WHERE idempotency_key=$key;
             """);
        identityCommand.CommandTimeout = _commandTimeoutSeconds;
        identityCommand.Parameters.AddWithValue("$key", idempotencyKey);
        RbpStoredInvocation? identity =
            MaterializeInvocation(identityCommand);
        if (identity is null)
        {
            return null;
        }

        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT dispatch_state,effect_state,transaction_mode,evidence_jcs,
                   terminal_state,terminal_outcome_json,result_digest,
                   verification_hold_id,verification_correlation_json,
                   late_terminal_outcome_json,late_result_digest,
                   started_at_ms,finished_at_ms,created_at_ms
            FROM rbp_outcome_dispatch_v3
            WHERE idempotency_key=$key AND rsid=$rsid;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$key", idempotencyKey);
        command.Parameters.AddWithValue("$rsid", identity.Identity.Rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        string expectedEvidence = SerializeOutcomeEvidenceV3(
            ParseDispatchStateV3(reader.GetString(0)),
            ParseEffectStateV3(reader.GetString(1)),
            ParseTransactionModeV3(reader.GetString(2)));
        if (reader.GetString(3) != expectedEvidence)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "Outcome-v3 evidence columns disagree with evidence_jcs.");
        }

        return new RbpStoredInvocation(
            identity.Identity,
            FromStorageState(reader.GetString(4)),
            reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.IsDBNull(7) ? null : reader.GetString(7),
            reader.IsDBNull(8) ? null : reader.GetString(8),
            reader.IsDBNull(9) ? null : reader.GetString(9),
            reader.IsDBNull(10) ? null : reader.GetString(10),
            reader.GetInt64(13),
            reader.IsDBNull(11) ? null : reader.GetInt64(11),
            reader.IsDBNull(12) ? null : reader.GetInt64(12));
    }

    private static string SerializeOutcomeEvidenceV3(
        RbpDispatchState dispatchState,
        RbpEffectState effectState,
        RbpTransactionMode transactionMode)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString(
                "dispatchState",
                RbpMutationOutcomeEvidence.ToWire(dispatchState));
            writer.WriteString(
                "effectState",
                RbpMutationOutcomeEvidence.ToWire(effectState));
            writer.WriteStartObject("evidence");
            writer.WriteString("source", "storage_typed");
            writer.WriteString(
                "transactionStatus",
                RbpMutationOutcomeEvidence.ToWire(effectState));
            writer.WriteEndObject();
            writer.WriteString("schema", RbpMutationOutcomeEvidence.Schema);
            writer.WriteString(
                "transactionMode",
                RbpMutationOutcomeEvidence.ToWire(transactionMode));
            writer.WriteEndObject();
        }

        using JsonDocument document = JsonDocument.Parse(buffer.ToArray());
        return Rfc8785Json.Canonicalize(document.RootElement);
    }

    private static RbpDispatchState ParseDispatchStateV3(string value) =>
        value switch
        {
            "not_started" => RbpDispatchState.NotStarted,
            "may_have_reached_addin" =>
                RbpDispatchState.MayHaveReachedAddin,
            "response_observed" => RbpDispatchState.ResponseObserved,
            _ => throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "Outcome-v3 has an unknown dispatch state."),
        };

    private static RbpEffectState ParseEffectStateV3(string value) =>
        value switch
        {
            "not_started" => RbpEffectState.NotStarted,
            "read_only" => RbpEffectState.ReadOnly,
            "rolled_back" => RbpEffectState.RolledBack,
            "committed" => RbpEffectState.Committed,
            "unknown" => RbpEffectState.Unknown,
            _ => throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "Outcome-v3 has an unknown effect state."),
        };

    private static RbpTransactionMode ParseTransactionModeV3(string value) =>
        value switch
        {
            "auto" => RbpTransactionMode.Auto,
            "none" => RbpTransactionMode.None,
            "native" => RbpTransactionMode.Native,
            "not_applicable" => RbpTransactionMode.NotApplicable,
            _ => throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "Outcome-v3 has an unknown transaction mode."),
        };

    private static void ValidateOutcomeEvidence(
        RbpMutationOutcomeEvidence evidence)
    {
        if (Encoding.UTF8.GetByteCount(evidence.EvidenceJcs) >
            RbpMutationOutcomeEvidence.MaximumEvidenceBytes ||
            evidence.EvidenceJcs.Length < 2 ||
            (evidence.DispatchState == RbpDispatchState.NotStarted &&
             evidence.EffectState != RbpEffectState.NotStarted) ||
            (evidence.EffectState == RbpEffectState.Committed &&
             evidence.DispatchState != RbpDispatchState.ResponseObserved))
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "Mutation outcome evidence is contradictory or unbounded.");
        }

        try
        {
            using JsonDocument parsed = JsonDocument.Parse(
                evidence.EvidenceJcs);
            if (!string.Equals(
                    Rfc8785Json.Canonicalize(parsed.RootElement),
                    evidence.EvidenceJcs,
                    StringComparison.Ordinal))
            {
                throw new FormatException();
            }
        }
        catch (Exception exception) when (
            exception is JsonException or FormatException or
                InvalidOperationException)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "Mutation outcome evidence must be bounded RFC 8785 JSON.",
                exception);
        }
    }

    private static string ToStorageHoldState(RbpHoldState state) =>
        state switch
        {
            RbpHoldState.Active => "active",
            RbpHoldState.EvidenceRecorded => "evidence_recorded",
            RbpHoldState.ResolvedPendingBridge => "resolved_pending_bridge",
            RbpHoldState.Cleared => "cleared",
            _ => throw new ArgumentOutOfRangeException(nameof(state)),
        };

    private static string Sha256(string value) =>
        "sha256:" +
        Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(value)))
            .ToLowerInvariant();
}

internal sealed class RbpOutcomeV3ImportException(
    string reasonCode,
    string message)
    : Exception(message)
{
    internal string ReasonCode { get; } = reasonCode;
}
