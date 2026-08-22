using System.Text.Json;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

/// <summary>
/// Frozen O1 Section 6.2.1 conformance for clearance acceptance: the
/// deterministic hold state machine, evidence-is-not-clearance, atomic
/// accept-before-first-add-in-byte, idempotent duplicate acceptance, and
/// Section 21 item 28 — an invalid or inconclusive clearance never opens
/// dispatch.
/// </summary>
public sealed class RbpJournalStoreHoldClearanceTests
{
    private const string ReadMethod = "get_current_view_info";
    private const string WriteMethod = "create_wall";
    private const string DocumentScope =
        """{"document_id":"doc-1","kind":"document"}""";
    private const string SecondDocumentScope =
        """{"document_id":"doc-2","kind":"document"}""";
    private const string SessionScope = """{"kind":"session"}""";
    private const string VerificationId =
        "0197a3c2-0000-7000-8000-0000000000e1";
    private const string OtherVerificationId =
        "0197a3c2-0000-7000-8000-0000000000e2";
    private const string ResolutionId =
        "0197a3c2-0000-7000-8000-000000000101";
    private const string OtherResolutionId =
        "0197a3c2-0000-7000-8000-000000000103";
    private const string AuditId =
        "0197a3c2-0000-7000-8000-000000000102";
    private const string OtherAuditId =
        "0197a3c2-0000-7000-8000-000000000104";

    private static readonly string EvidenceDigest =
        "sha256:" + new string('d', 64);

    private static readonly string LateDigest =
        "sha256:" + new string('e', 64);

    private static readonly string WrongDigest =
        "sha256:" + new string('f', 64);

    [Fact]
    public async Task ConclusiveEvidenceIsRecordedButIsNotClearance()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());

        RbpVerificationHold evidenced =
            await store.RecordHoldVerificationEvidenceAsync(
                "rs-test",
                Evidence(holdId));

        Assert.Equal(RbpHoldState.EvidenceRecorded, evidenced.State);
        Assert.Equal(EvidenceDigest, evidenced.EvidenceDigest);
        Assert.Equal(VerificationId, evidenced.VerificationInvocationId);

        // A successful read is evidence, not clearance: dispatch stays
        // closed for a fresh mutating envelope on the held scope.
        RbpClearanceGatedAdmission blocked =
            await store.AdmitInvocationWithClearancesAsync(
                FreshMutationIdentity(),
                Array.Empty<RbpRecoveryClearance>());
        Assert.Null(blocked.Admission);
        Assert.Equal(holdId, blocked.BlockingHold?.VerificationHoldId);
        Assert.Null(
            await store.GetInvocationAsync(
                FreshMutationIdentity().IdempotencyKey));
    }

    [Fact]
    public async Task InconclusiveEvidenceIsRetainedWhileTheHoldStaysActive()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());

        RbpVerificationHold retained =
            await store.RecordHoldVerificationEvidenceAsync(
                "rs-test",
                Evidence(holdId, conclusive: false));

        // The inconclusive attempt is retained as evidence while the hold
        // stays `active` and blocking; operator intervention is required.
        Assert.Equal(RbpHoldState.Active, retained.State);
        Assert.Equal(EvidenceDigest, retained.EvidenceDigest);

        RbpClearanceGatedAdmission blocked =
            await store.AdmitInvocationWithClearancesAsync(
                FreshMutationIdentity(),
                Array.Empty<RbpRecoveryClearance>());
        Assert.Null(blocked.Admission);
        Assert.Equal(holdId, blocked.BlockingHold?.VerificationHoldId);
    }

    [Fact]
    public async Task AcceptedClearanceClearsAtomicallyWithAdmission()
    {
        using var directory = new RbpJournalTestDirectory();
        RbpInvocationIdentity fresh = FreshMutationIdentity();
        string holdId;
        await using (RbpJournalStore store = OpenStore(directory))
        {
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration());
            holdId = await InstallIndeterminateHoldAsync(
                store,
                OriginIdentity());
            _ = await store.RecordHoldVerificationEvidenceAsync(
                "rs-test",
                Evidence(holdId));

            RbpClearanceGatedAdmission admitted =
                await store.AdmitInvocationWithClearancesAsync(
                    fresh,
                    new[] { Clearance(holdId) });

            Assert.Null(admitted.BlockingHold);
            Assert.Equal(
                RbpInvocationAdmission.Accepted,
                admitted.Admission?.Admission);
            Assert.Equal(
                RbpInvocationState.Received,
                admitted.Admission?.Stored.State);
        }

        // The cleared hold and the received row committed together before
        // the caller could have written the first add-in byte, so both
        // survive a crash between commit and dispatch.
        await using RbpJournalStore reopened = OpenStore(directory);
        RbpVerificationHold? hold =
            await reopened.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.Cleared, hold?.State);
        Assert.Equal(ResolutionId, hold?.ResolutionId);
        Assert.Equal("verification_read", hold?.ResolutionBasis);
        Assert.Equal("postcondition_verified", hold?.ResolutionDecision);
        Assert.Equal(AuditId, hold?.AuditId);
        Assert.NotNull(hold?.ClearedAtMilliseconds);
        RbpStoredInvocation? admittedRow =
            await reopened.GetInvocationAsync(fresh.IdempotencyKey);
        Assert.Equal(RbpInvocationState.Received, admittedRow?.State);
    }

    [Fact]
    public async Task ClearanceAndAdmissionRollBackTogether()
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new ArmedJournalFaultInjector();
        await using RbpJournalStore store = OpenStore(directory, faults);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            Evidence(holdId));

        faults.Arm(RbpJournalFaultPoint.BeforeCommit);
        await Assert.ThrowsAsync<IOException>(
            () => store.AdmitInvocationWithClearancesAsync(
                FreshMutationIdentity(),
                new[] { Clearance(holdId) }));

        // Neither half of the atomic accept survived: the hold is still
        // uncleared and no invocation row was admitted.
        RbpVerificationHold? hold =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.EvidenceRecorded, hold?.State);
        Assert.Null(
            await store.GetInvocationAsync(
                FreshMutationIdentity().IdempotencyKey));
    }

    [Fact]
    public async Task V3ClearanceAdmissionPowerCutsAreAllOrNothing()
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new ArmedJournalFaultInjector();
        await using RbpJournalStore store = OpenStore(directory, faults);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            Evidence(holdId));
        _ = await store.EnsureOutcomeV3ForSessionAsync("rs-test");
        RbpInvocationIdentity first = FreshMutationIdentity(
            invocationId: "0197a3c2-0000-7000-8000-000000000461");

        faults.Arm(RbpJournalFaultPoint.BeforeCommit);
        await Assert.ThrowsAsync<IOException>(
            () => store.AdmitInvocationOutcomeV3Async(
                first,
                new[] { Clearance(holdId) },
                RbpTransactionMode.Native));
        Assert.Equal(
            RbpHoldState.EvidenceRecorded,
            (await store.GetHoldAsync("rs-test", holdId))!.State);
        Assert.Null(await store.GetInvocationAsync(first.IdempotencyKey));

        faults.Arm(RbpJournalFaultPoint.AfterCommitBeforeReturn);
        RbpClearanceGatedAdmission recovered =
            await store.AdmitInvocationOutcomeV3Async(
                first,
                new[] { Clearance(holdId) },
                RbpTransactionMode.Native);
        Assert.Equal(
            RbpInvocationAdmission.Accepted,
            recovered.Admission!.Admission);
        Assert.Equal(
            RbpHoldState.Cleared,
            (await store.GetHoldAsync("rs-test", holdId))!.State);
        Assert.Equal(
            RbpInvocationState.Received,
            (await store.GetInvocationAsync(first.IdempotencyKey))!.State);
    }

    [Fact]
    public async Task DuplicateDeliveryOfTheIdenticalClearanceIsIdempotent()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            Evidence(holdId));
        RbpInvocationIdentity fresh = FreshMutationIdentity();
        _ = await store.AdmitInvocationWithClearancesAsync(
            fresh,
            new[] { Clearance(holdId) });
        await store.MarkInvocationExecutingAsync(fresh.IdempotencyKey);
        _ = await store.PersistInvocationTerminalAsync(
            fresh.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, """{"ok":true}"""));

        RbpClearanceGatedAdmission redelivered =
            await store.AdmitInvocationWithClearancesAsync(
                fresh,
                new[] { Clearance(holdId) });

        Assert.Null(redelivered.BlockingHold);
        Assert.Equal(
            RbpInvocationAdmission.ReplayTerminal,
            redelivered.Admission?.Admission);
        RbpVerificationHold? hold =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.Cleared, hold?.State);
        Assert.Equal(ResolutionId, hold?.ResolutionId);
    }

    [Theory]
    [InlineData("resolution")]
    [InlineData("decision")]
    [InlineData("audit")]
    [InlineData("evidence")]
    [InlineData("verification")]
    public async Task AChangedClearanceIsNeverIdempotent(string drift)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            Evidence(holdId));
        RbpInvocationIdentity fresh = FreshMutationIdentity();
        _ = await store.AdmitInvocationWithClearancesAsync(
            fresh,
            new[] { Clearance(holdId) });

        RbpRecoveryClearance changed = drift switch
        {
            "resolution" =>
                Clearance(holdId, resolutionId: OtherResolutionId),
            "decision" => Clearance(
                holdId,
                decision: RbpClearanceDecision.NonExecutionProven),
            "audit" => Clearance(holdId, auditId: OtherAuditId),
            "evidence" => Clearance(holdId, evidenceDigest: WrongDigest),
            _ => Clearance(
                holdId,
                verificationInvocationId: OtherVerificationId),
        };

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationWithClearancesAsync(
                    fresh,
                    new[] { changed }));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);

        // The original resolution stays authoritative.
        RbpVerificationHold? hold =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.Cleared, hold?.State);
        Assert.Equal(ResolutionId, hold?.ResolutionId);
        Assert.Equal(AuditId, hold?.AuditId);
    }

    [Theory]
    [InlineData("wrong_evidence")]
    [InlineData("wrong_verification_id")]
    [InlineData("unknown_hold")]
    [InlineData("malformed_hold_id")]
    [InlineData("no_evidence")]
    [InlineData("inconclusive_evidence")]
    public async Task AnInvalidClearanceNeverClearsTheHoldOrOpensDispatch(
        string kind)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        switch (kind)
        {
            case "no_evidence":
                break;
            case "inconclusive_evidence":
                _ = await store.RecordHoldVerificationEvidenceAsync(
                    "rs-test",
                    Evidence(holdId, conclusive: false));
                break;
            default:
                _ = await store.RecordHoldVerificationEvidenceAsync(
                    "rs-test",
                    Evidence(holdId));
                break;
        }

        RbpRecoveryClearance invalid = kind switch
        {
            "wrong_evidence" =>
                Clearance(holdId, evidenceDigest: WrongDigest),
            "wrong_verification_id" => Clearance(
                holdId,
                verificationInvocationId: OtherVerificationId),
            "unknown_hold" =>
                Clearance("vh:" + new string('f', 64)),
            "malformed_hold_id" => Clearance("vh:not-hex"),
            _ => Clearance(holdId),
        };
        RbpInvocationIdentity fresh = FreshMutationIdentity();

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationWithClearancesAsync(
                    fresh,
                    new[] { invalid }));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);

        // Section 21 item 28: the hold never transitions to cleared, the
        // refused envelope wrote no row, and dispatch stays closed.
        RbpVerificationHold? hold =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.NotEqual(RbpHoldState.Cleared, hold?.State);
        Assert.Null(await store.GetInvocationAsync(fresh.IdempotencyKey));
        RbpClearanceGatedAdmission blocked =
            await store.AdmitInvocationWithClearancesAsync(
                fresh,
                Array.Empty<RbpRecoveryClearance>());
        Assert.Null(blocked.Admission);
        Assert.Equal(holdId, blocked.BlockingHold?.VerificationHoldId);
    }

    [Fact]
    public async Task ALateTerminalClearanceWithoutDurableEvidenceFailsClosed()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationWithClearancesAsync(
                    FreshMutationIdentity(),
                    new[]
                    {
                        Clearance(
                            holdId,
                            basis: RbpClearanceBasis.LateTerminal,
                            verificationInvocationId: null,
                            evidenceDigest: LateDigest),
                    }));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
        RbpVerificationHold? hold =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.Active, hold?.State);
    }

    [Fact]
    public async Task AConclusiveLateTerminalSupportsTheLateTerminalBasis()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity origin = OriginIdentity();
        string holdId = await InstallIndeterminateHoldAsync(store, origin);

        // The real add-in outcome becomes durable after the indeterminate
        // terminal. It is late evidence only: the hold does not clear.
        _ = await store.PersistInvocationTerminalAsync(
            origin.IdempotencyKey,
            Terminal(
                RbpInvocationState.Completed,
                """{"late":true}""",
                LateDigest));
        RbpVerificationHold? unclearedHold =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.Active, unclearedHold?.State);

        RbpClearanceGatedAdmission admitted =
            await store.AdmitInvocationWithClearancesAsync(
                FreshMutationIdentity(),
                new[]
                {
                    Clearance(
                        holdId,
                        basis: RbpClearanceBasis.LateTerminal,
                        verificationInvocationId: null,
                        evidenceDigest: LateDigest),
                });

        Assert.Equal(
            RbpInvocationAdmission.Accepted,
            admitted.Admission?.Admission);
        RbpVerificationHold? hold =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.Cleared, hold?.State);
        Assert.Equal("late_terminal", hold?.ResolutionBasis);
        Assert.Null(hold?.VerificationInvocationId);
        Assert.Equal(LateDigest, hold?.EvidenceDigest);
    }

    [Fact]
    public async Task GroupedAtomicHoldRequiresBoundVerificationAndClearsWithItsAdmission()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        _ = await store.EnsureOutcomeV3ForSessionAsync("rs-test");

        const string firstId = "0197a3c2-0000-7000-8000-0000000005a1";
        const string secondId = "0197a3c2-0000-7000-8000-0000000005a2";
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: true,
            "0197a3c2-0000-7000-8000-0000000005a0",
            new[]
            {
                RbpBatchTestData.WriteStep(firstId),
                RbpBatchTestData.WriteStep(secondId),
            });
        _ = await store.AdmitBatchOutcomeV3Async(
            batch,
            Array.Empty<RbpRecoveryClearance>(),
            new[] { RbpTransactionMode.Native, RbpTransactionMode.Native });
        await store.MarkBatchDispatchedOutcomeV3Async(
            batch.BatchKey,
            new[] { RbpTransactionMode.Native, RbpTransactionMode.Native });

        // A fresh same-scope mutation recovers the complete atomic batch in
        // one durable grouped hold before it can be admitted.
        RbpClearanceGatedAdmission blocked =
            await store.AdmitInvocationOutcomeV3Async(
                FreshMutationIdentity(
                    invocationId: "0197a3c2-0000-7000-8000-0000000005a3"),
                Array.Empty<RbpRecoveryClearance>(),
                RbpTransactionMode.Native);
        Assert.Null(blocked.Admission);
        RbpVerificationHold hold = blocked.BlockingHold!;
        Assert.Equal(
            new[]
            {
                RbpBatchTestData.StepKey(firstId),
                RbpBatchTestData.StepKey(secondId),
            },
            hold.OrderedOriginIdempotencyKeys);
        Assert.Equal(
            hold.VerificationHoldId,
            (await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(firstId)))!.VerificationHoldId);
        Assert.Equal(
            hold.VerificationHoldId,
            (await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(secondId)))!.VerificationHoldId);

        // A late terminal for one member is retained and replayed, but it is
        // not aggregate authority for the other unknown member.
        await store.PersistInvocationTerminalAsync(
            RbpBatchTestData.StepKey(firstId),
            Terminal(RbpInvocationState.Completed, """{"late":"first"}""", LateDigest));
        RbpClearanceGatedAdmission lateReplay =
            await store.AdmitInvocationOutcomeV3Async(
                (await store.GetInvocationAsync(
                    RbpBatchTestData.StepKey(firstId)))!.Identity,
                Array.Empty<RbpRecoveryClearance>(),
                RbpTransactionMode.Native);
        Assert.Equal(
            RbpInvocationAdmission.ReplayLateAfterIndeterminate,
            lateReplay.Admission?.Admission);

        RbpJournalException lateTerminalFault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationOutcomeV3Async(
                    FreshMutationIdentity(
                        invocationId: "0197a3c2-0000-7000-8000-0000000005a4"),
                    new[]
                    {
                        Clearance(
                            hold.VerificationHoldId,
                            hold.ScopeJcs,
                            RbpClearanceBasis.LateTerminal,
                            verificationInvocationId: null,
                            evidenceDigest: LateDigest),
                    },
                    RbpTransactionMode.Native));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, lateTerminalFault.ErrorCode);
        Assert.Equal(
            RbpHoldState.Active,
            (await store.GetHoldAsync("rs-test", hold.VerificationHoldId))!.State);

        // A different second-member terminal/digest cannot convert the
        // grouped authority into a per-origin late-terminal clearance.
        await store.PersistInvocationTerminalAsync(
            RbpBatchTestData.StepKey(secondId),
            Terminal(RbpInvocationState.Completed, """{"late":"second"}""", WrongDigest));
        RbpJournalException changedLateFault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationOutcomeV3Async(
                    FreshMutationIdentity(
                        invocationId: "0197a3c2-0000-7000-8000-0000000005a5"),
                    new[]
                    {
                        Clearance(
                            hold.VerificationHoldId,
                            hold.ScopeJcs,
                            RbpClearanceBasis.LateTerminal,
                            verificationInvocationId: null,
                            evidenceDigest: WrongDigest),
                    },
                    RbpTransactionMode.Native));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, changedLateFault.ErrorCode);
        Assert.Equal(
            RbpHoldState.Active,
            (await store.GetHoldAsync("rs-test", hold.VerificationHoldId))!.State);
        Assert.Equal(
            hold.VerificationHoldId,
            (await store.FindConflictingHoldAsync(
                "rs-test",
                hold.ScopeJcs))!.VerificationHoldId);

        RbpJournalException unboundVerification =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.RecordHoldVerificationEvidenceAsync(
                    "rs-test",
                    new RbpHoldVerificationEvidence(
                        hold.VerificationHoldId,
                        VerificationId,
                        EvidenceDigest,
                        Conclusive: true)));
        Assert.Equal(
            RbpJournalErrorCode.ProtocolConflict,
            unboundVerification.ErrorCode);

        string groupedEvidence =
            RbpJournalStore.MakeGroupedHoldVerificationEvidenceDigest(
                hold,
                VerificationId,
                conclusive: true);
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            new RbpHoldVerificationEvidence(
                hold.VerificationHoldId,
                VerificationId,
                groupedEvidence,
                Conclusive: true));

        // The exact scope, ordered origins, and verified postcondition are
        // bound into the only clearance that clears the whole grouped hold;
        // clearance and the next same-envelope admission commit together.
        RbpClearanceGatedAdmission admitted =
            await store.AdmitInvocationOutcomeV3Async(
                FreshMutationIdentity(
                    invocationId: "0197a3c2-0000-7000-8000-0000000005a6"),
                new[]
                {
                    Clearance(
                        hold.VerificationHoldId,
                        hold.ScopeJcs,
                        RbpClearanceBasis.VerificationRead,
                        VerificationId,
                        groupedEvidence),
                },
                RbpTransactionMode.Native);
        Assert.Equal(RbpInvocationAdmission.Accepted, admitted.Admission?.Admission);
        Assert.Equal(
            RbpHoldState.Cleared,
            (await store.GetHoldAsync("rs-test", hold.VerificationHoldId))!.State);
    }

    [Fact]
    public async Task TheClearanceEnvelopeMustCoverEveryConflictingHold()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string firstHold = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        string secondHold = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity(
                scopeJcs: SecondDocumentScope,
                invocationId: "0197a3c2-0000-7000-8000-0000000000b3"));
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            Evidence(firstHold));

        // A session-scope mutation conflicts with both document holds, so
        // an envelope clearing only one of them is not the one permitted
        // evidence-bound envelope; the whole transaction fails closed.
        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationWithClearancesAsync(
                    FreshMutationIdentity(scopeJcs: SessionScope),
                    new[] { Clearance(firstHold) }));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);

        RbpVerificationHold? first =
            await store.GetHoldAsync("rs-test", firstHold);
        RbpVerificationHold? second =
            await store.GetHoldAsync("rs-test", secondHold);
        Assert.Equal(RbpHoldState.EvidenceRecorded, first?.State);
        Assert.Equal(RbpHoldState.Active, second?.State);
    }

    [Fact]
    public async Task AClearanceForANonConflictingHoldIsAProtocolFault()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            Evidence(holdId));

        // The frozen array contains every and only conflicting holds; a
        // doc-2 mutation may not carry the doc-1 clearance.
        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationWithClearancesAsync(
                    FreshMutationIdentity(scopeJcs: SecondDocumentScope),
                    new[] { Clearance(holdId) }));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
        RbpVerificationHold? hold =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.EvidenceRecorded, hold?.State);
    }

    [Fact]
    public async Task ANonMutatingEnvelopeMayNotCarryClearances()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationWithClearancesAsync(
                    FreshReadIdentity(),
                    new[] { Clearance(holdId) }));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
    }

    [Fact]
    public async Task OriginRedeliveryAndReadsAreExemptFromTheConflictBlock()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity origin = OriginIdentity();
        string holdId = await InstallIndeterminateHoldAsync(store, origin);

        // Redelivery of an origin key replays the durable indeterminate
        // outcome instead of being blocked by its own hold.
        RbpClearanceGatedAdmission replay =
            await store.AdmitInvocationWithClearancesAsync(
                origin,
                Array.Empty<RbpRecoveryClearance>());
        Assert.Null(replay.BlockingHold);
        Assert.Equal(
            RbpInvocationAdmission.ReplayTerminal,
            replay.Admission?.Admission);
        Assert.Equal(holdId, replay.Admission?.VerificationHoldId);

        // A read-only invocation is never blocked by the mutation hold.
        RbpClearanceGatedAdmission read =
            await store.AdmitInvocationWithClearancesAsync(
                FreshReadIdentity(),
                Array.Empty<RbpRecoveryClearance>());
        Assert.Null(read.BlockingHold);
        Assert.Equal(
            RbpInvocationAdmission.Accepted,
            read.Admission?.Admission);
    }

    [Fact]
    public async Task AClearedHoldAcceptsNoFurtherVerificationEvidence()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            Evidence(holdId));
        _ = await store.AdmitInvocationWithClearancesAsync(
            FreshMutationIdentity(),
            new[] { Clearance(holdId) });

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.RecordHoldVerificationEvidenceAsync(
                    "rs-test",
                    Evidence(holdId, evidenceDigest: WrongDigest)));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
    }

    [Fact]
    public async Task AClearanceFromAnotherSessionNeverMatchesTheHold()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                rsid: "rs-other",
                localSessionKey: "port:9090:pid:4321",
                resumeToken: "other-resume-token"));
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            Evidence(holdId));

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationWithClearancesAsync(
                    FreshMutationIdentity() with { Rsid = "rs-other" },
                    new[] { Clearance(holdId) }));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
        RbpVerificationHold? hold =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.EvidenceRecorded, hold?.State);
    }

    private static RbpJournalStore OpenStore(
        RbpJournalTestDirectory directory,
        ArmedJournalFaultInjector? faults = null) =>
        RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(faults));

    private static async Task<string> InstallIndeterminateHoldAsync(
        RbpJournalStore store,
        RbpInvocationIdentity origin)
    {
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        RbpInvocationAdmissionResult refused =
            await store.AdmitInvocationAsync(origin);
        Assert.Equal(
            RbpInvocationAdmission.RefuseIndeterminate,
            refused.Admission);
        return refused.VerificationHoldId!;
    }

    private static RbpHoldVerificationEvidence Evidence(
        string holdId,
        bool conclusive = true,
        string? evidenceDigest = null) =>
        new(
            holdId,
            VerificationId,
            evidenceDigest ?? EvidenceDigest,
            conclusive);

    private static RbpRecoveryClearance Clearance(
        string holdId,
        string scopeJcs = DocumentScope,
        RbpClearanceBasis basis = RbpClearanceBasis.VerificationRead,
        string? verificationInvocationId = VerificationId,
        string? evidenceDigest = null,
        string resolutionId = ResolutionId,
        RbpClearanceDecision decision =
            RbpClearanceDecision.PostconditionVerified,
        string auditId = AuditId) =>
        new(
            holdId,
            scopeJcs,
            resolutionId,
            basis,
            verificationInvocationId,
            evidenceDigest ?? EvidenceDigest,
            decision,
            auditId);

    private static RbpInvocationTerminal Terminal(
        RbpInvocationState state,
        string outcomeJson,
        string? resultDigest = null)
    {
        using var document = JsonDocument.Parse(outcomeJson);
        return new RbpInvocationTerminal(
            state,
            document.RootElement.Clone(),
            resultDigest ?? "sha256:" + new string('c', 64));
    }

    private static RbpInvocationIdentity OriginIdentity(
        string scopeJcs = DocumentScope,
        string invocationId = "0197a3c2-0000-7000-8000-0000000000b2") =>
        new(
            "rs-test",
            invocationId,
            WriteMethod,
            Mutating: true,
            MutationScopeJcs: scopeJcs,
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");

    private static RbpInvocationIdentity FreshMutationIdentity(
        string scopeJcs = DocumentScope,
        string invocationId = "0197a3c2-0000-7000-8000-0000000000f4") =>
        new(
            "rs-test",
            invocationId,
            WriteMethod,
            Mutating: true,
            MutationScopeJcs: scopeJcs,
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");

    private static RbpInvocationIdentity FreshReadIdentity() =>
        new(
            "rs-test",
            "0197a3c2-0000-7000-8000-0000000000a7",
            ReadMethod,
            Mutating: false,
            MutationScopeJcs: null,
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");
}
