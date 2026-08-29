using System.Text.Json;
using RevAgent.Bridge.Tests.Gateway.Dispatch;
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
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(
            store, fixture);
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());

        _ = await ProduceEvidenceAsync(store, fixture, holdId);
        RbpVerificationHold evidenced = Assert.IsType<RbpVerificationHold>(
            await store.GetHoldAsync("rs-test", holdId));

        Assert.Equal(RbpHoldState.EvidenceRecorded, evidenced.State);
        Assert.NotNull(evidenced.EvidenceDigest);
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
    public async Task CallerSeededInconclusiveEvidenceIsDeniedAndTheHoldStaysActive()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(store, fixture);
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.RecordHoldVerificationEvidenceAsync(
                    "rs-test",
                    Evidence(holdId, conclusive: false)));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);

        // The compatibility lookup cannot turn a caller-supplied flag into
        // evidence; the hold remains active and still blocks dispatch.
        RbpVerificationHold retained =
            Assert.IsType<RbpVerificationHold>(await store.GetHoldAsync("rs-test", holdId));
        Assert.Equal(RbpHoldState.Active, retained.State);
        Assert.Null(retained.EvidenceDigest);

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
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        RbpInvocationIdentity fresh = FreshMutationIdentity();
        string holdId;
        await using (RbpJournalStore store = OpenStore(directory))
        {
            await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(
                store, fixture);
            holdId = await InstallIndeterminateHoldAsync(
                store,
                OriginIdentity());
            RbpHoldVerificationEvidence evidence =
                await ProduceEvidenceAsync(store, fixture, holdId);

            RbpClearanceGatedAdmission admitted =
                await store.AdmitInvocationWithClearancesAsync(
                    BindClearances(fresh, Clearance(holdId, evidence)),
                    new[] { Clearance(holdId, evidence) });

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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ClearanceAndAdmissionHaveExactBeforeAndAfterCommitState(
        bool afterCommit)
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new ArmedJournalFaultInjector();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory, faults);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(
            store, fixture);
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        RbpHoldVerificationEvidence evidence =
            await ProduceEvidenceAsync(store, fixture, holdId);

        RbpInvocationIdentity consumer = FreshMutationIdentity();
        faults.Arm(afterCommit
            ? RbpJournalFaultPoint.AfterCommitBeforeReturn
            : RbpJournalFaultPoint.BeforeCommit);
        RbpClearanceGatedAdmission admitted =
            await store.AdmitInvocationWithClearancesAsync(
                BindClearances(consumer, Clearance(holdId, evidence)),
                new[] { Clearance(holdId, evidence) });

        // The final reconciliation rule re-reads exact durable state. An
        // after-commit loss returns the proved complete decision; a
        // before-commit loss may make one persistence-only retry, never a
        // second model execution.
        Assert.Null(admitted.BlockingHold);
        Assert.Equal(RbpInvocationAdmission.Accepted, admitted.Admission?.Admission);
        RbpVerificationHold? hold =
            await store.GetHoldAsync("rs-test", holdId);
        RbpStoredInvocation? stored =
            await store.GetInvocationAsync(consumer.IdempotencyKey);
        Assert.Equal(RbpHoldState.Cleared, hold?.State);
        Assert.Equal(RbpInvocationState.Received, stored?.State);
    }

    [Fact]
    public async Task DuplicateDeliveryOfTheIdenticalClearanceIsIdempotent()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(
            store, fixture);
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        RbpHoldVerificationEvidence evidence =
            await ProduceEvidenceAsync(store, fixture, holdId);
        RbpInvocationIdentity fresh = FreshMutationIdentity();
        _ = await store.AdmitInvocationWithClearancesAsync(
            BindClearances(fresh, Clearance(holdId, evidence)),
            new[] { Clearance(holdId, evidence) });
        await store.MarkInvocationExecutingAsync(fresh.IdempotencyKey);
        _ = await store.PersistInvocationTerminalAsync(
            fresh.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, """{"ok":true}"""));

        RbpClearanceGatedAdmission redelivered =
            await store.AdmitInvocationWithClearancesAsync(
                BindClearances(fresh, Clearance(holdId, evidence)),
                new[] { Clearance(holdId, evidence) });

        Assert.Null(redelivered.BlockingHold);
        Assert.Equal(
            RbpInvocationAdmission.ReplayTerminal,
            redelivered.Admission?.Admission);
        RbpVerificationHold? hold =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.Cleared, hold?.State);
        Assert.Equal(ResolutionId, hold?.ResolutionId);
    }

    [Fact]
    public async Task ExactTerminalClearanceRedeliveryIgnoresLaterSharedKeyUncertainty()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(store, fixture);
        string clearedHold = await InstallIndeterminateHoldAsync(store, OriginIdentity());
        RbpHoldVerificationEvidence evidence =
            await ProduceEvidenceAsync(store, fixture, clearedHold);
        RbpRecoveryClearance clearance = Clearance(clearedHold, evidence);
        RbpInvocationIdentity consumer = BindClearances(
            FreshMutationIdentity(), clearance);
        _ = await store.AdmitInvocationWithClearancesAsync(consumer, [clearance]);
        await store.MarkInvocationExecutingAsync(consumer.IdempotencyKey);
        _ = await store.PersistInvocationTerminalAsync(
            consumer.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, """{"ok":true}"""));

        const string externalRsid = "rs-shared-key-predecessor";
        await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration(
            rsid: externalRsid,
            localSessionKey: fixture.Route.Handle!.LocalSessionKey,
            resumeToken: "shared-key-predecessor-resume"));
        RbpInvocationIdentity externalOrigin = OriginIdentity(
            invocationId: "0197a3c2-0000-7000-8000-0000000000c9") with
        {
            Rsid = externalRsid,
        };
        string externalHold = await InstallIndeterminateHoldAsync(
            store, externalOrigin);
        Assert.NotNull(await store.GetHoldAsync(externalRsid, externalHold));
        long holdsBeforeRedelivery = await HoldCountAsync(store);

        RbpClearanceGatedAdmission replay =
            await store.AdmitInvocationWithClearancesAsync(consumer, [clearance]);

        Assert.Null(replay.BlockingHold);
        Assert.Equal(RbpInvocationAdmission.ReplayTerminal, replay.Admission?.Admission);
        Assert.Equal(RbpInvocationState.Completed, replay.Admission?.Stored.State);
        Assert.Equal(holdsBeforeRedelivery, await HoldCountAsync(store));
        Assert.Equal(
            RbpInvocationState.Completed,
            (await store.GetInvocationAsync(consumer.IdempotencyKey))?.State);

        RbpInvocationIdentity fresh = BindClearances(
            FreshMutationIdentity(
                invocationId: "0197a3c2-0000-7000-8000-0000000000ca"),
            clearance);
        RbpJournalException denied = await Assert.ThrowsAsync<RbpJournalException>(
            () => store.AdmitInvocationWithClearancesAsync(fresh, [clearance]));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, denied.ErrorCode);
        Assert.Null(await store.GetInvocationAsync(fresh.IdempotencyKey));
    }

    [Fact]
    public async Task IdenticalAuditedClearanceCannotAuthorizeAFreshConsumer()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(store, fixture);
        string holdId = await InstallIndeterminateHoldAsync(store, OriginIdentity());
        RbpHoldVerificationEvidence evidence =
            await ProduceEvidenceAsync(store, fixture, holdId);
        RbpRecoveryClearance clearance = Clearance(holdId, evidence);
        RbpInvocationIdentity first = FreshMutationIdentity();
        _ = await store.AdmitInvocationWithClearancesAsync(
            BindClearances(first, clearance), [clearance]);

        // Idempotency is bound to redelivery of this envelope, not to the
        // clearance object. A distinct invocation id must never consume an
        // already-audited clearance as a fresh mutation admission.
        RbpInvocationIdentity second = FreshMutationIdentity(
            invocationId: "0197a3c2-0000-7000-8000-0000000000f5");
        RbpJournalException fault = await Assert.ThrowsAsync<RbpJournalException>(
            () => store.AdmitInvocationWithClearancesAsync(
                BindClearances(second, clearance), [clearance]));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
        Assert.Null(await store.GetInvocationAsync(second.IdempotencyKey));
    }

    [Fact]
    public async Task OneInvalidClearanceLeavesEveryCandidateHoldAndAdmissionUnchanged()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(store, fixture);
        string firstHold = await InstallIndeterminateHoldAsync(store, OriginIdentity());
        string secondHold = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity(
                scopeJcs: SecondDocumentScope,
                invocationId: "0197a3c2-0000-7000-8000-0000000000b3"));
        RbpHoldVerificationEvidence firstEvidence =
            await ProduceEvidenceAsync(store, fixture, firstHold);
        RbpHoldVerificationEvidence secondEvidence =
            await RbpJournalStoreProductionEvidence
                .ProduceEligibleCorrelatedReadAsync(
                    store,
                    fixture,
                    secondHold,
                    SecondDocumentScope,
                    OtherVerificationId);
        RbpInvocationIdentity consumer = FreshMutationIdentity(
            scopeJcs: SessionScope,
            invocationId: "0197a3c2-0000-7000-8000-0000000000f6");

        RbpRecoveryClearance[] mixed =
        [
            Clearance(firstHold, firstEvidence),
            Clearance(
                secondHold,
                secondEvidence,
                scopeJcs: SecondDocumentScope,
                evidenceDigest: WrongDigest),
        ];
        Array.Sort(mixed, static (left, right) =>
            string.CompareOrdinal(left.HoldId, right.HoldId));
        RbpJournalException fault = await Assert.ThrowsAsync<RbpJournalException>(
            () => store.AdmitInvocationWithClearancesAsync(
                BindClearances(consumer, mixed), mixed));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
        Assert.Equal(
            RbpHoldState.EvidenceRecorded,
            (await store.GetHoldAsync("rs-test", firstHold))?.State);
        Assert.Equal(
            RbpHoldState.EvidenceRecorded,
            (await store.GetHoldAsync("rs-test", secondHold))?.State);
        Assert.Null(await store.GetInvocationAsync(consumer.IdempotencyKey));
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
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(store, fixture);
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        RbpHoldVerificationEvidence evidence =
            await ProduceEvidenceAsync(store, fixture, holdId);
        RbpInvocationIdentity fresh = FreshMutationIdentity();
        _ = await store.AdmitInvocationWithClearancesAsync(
            BindClearances(fresh, Clearance(holdId, evidence)),
            new[] { Clearance(holdId, evidence) });

        RbpRecoveryClearance changed = drift switch
        {
            "resolution" =>
                Clearance(holdId, evidence, resolutionId: OtherResolutionId),
            "decision" => Clearance(
                holdId,
                evidence,
                decision: RbpClearanceDecision.NonExecutionProven),
            "audit" => Clearance(holdId, evidence, auditId: OtherAuditId),
            "evidence" => Clearance(holdId, evidence, evidenceDigest: WrongDigest),
            _ => Clearance(
                holdId,
                evidence,
                verificationInvocationId: OtherVerificationId),
        };

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationWithClearancesAsync(
                    BindClearances(fresh, changed),
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
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(
            store, fixture);
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        RbpHoldVerificationEvidence? evidence = null;
        switch (kind)
        {
            case "no_evidence":
                break;
            case "inconclusive_evidence":
                RbpJournalException seeded = await Assert.ThrowsAsync<RbpJournalException>(
                    () => store.RecordHoldVerificationEvidenceAsync(
                        "rs-test", Evidence(holdId, conclusive: false)));
                Assert.Equal(RbpJournalErrorCode.ProtocolConflict, seeded.ErrorCode);
                break;
            default:
                evidence = await ProduceEvidenceAsync(store, fixture, holdId);
                break;
        }

        RbpRecoveryClearance invalid = kind switch
        {
            "wrong_evidence" =>
                Clearance(holdId, evidence!, evidenceDigest: WrongDigest),
            "wrong_verification_id" => Clearance(
                holdId,
                evidence!,
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
                    BindClearances(fresh, invalid),
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
                    BindClearances(
                        FreshMutationIdentity(),
                        Clearance(
                            holdId,
                            basis: RbpClearanceBasis.LateTerminal,
                            verificationInvocationId: null,
                            evidenceDigest: LateDigest)),
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
                BindClearances(
                    FreshMutationIdentity(),
                    Clearance(
                        holdId,
                        basis: RbpClearanceBasis.LateTerminal,
                        verificationInvocationId: null,
                        evidenceDigest: LateDigest)),
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

    [Theory]
    [InlineData("missing_origin")]
    [InlineData("wrong_digest")]
    [InlineData("reordered_origins")]
    public async Task APartialOrReorderedLateTerminalGroupNeverClearsOrAdmits(
        string evidenceCase)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        (string holdId, string[] origins) = await InstallGroupedIndeterminateHoldAsync(
            store);

        // A late terminal is historical evidence, not caller-supplied
        // conclusive evidence.  The group can be cleared only when every
        // exact, ordered origin supplies the exact durable digest (or a
        // future explicit group-bound aggregate does so).
        _ = await store.PersistInvocationTerminalAsync(
            origins[0],
            Terminal(RbpInvocationState.Completed, """{"late":"first"}""", LateDigest));

        string clearanceHoldId = holdId;
        switch (evidenceCase)
        {
            case "wrong_digest":
                _ = await store.PersistInvocationTerminalAsync(
                    origins[1],
                    Terminal(
                        RbpInvocationState.Completed,
                        """{"late":"second"}""",
                        WrongDigest));
                break;
            case "reordered_origins":
                _ = await store.PersistInvocationTerminalAsync(
                    origins[1],
                    Terminal(
                        RbpInvocationState.Completed,
                        """{"late":"second"}""",
                        LateDigest));
                using (JsonDocument scope = JsonDocument.Parse(DocumentScope))
                {
                    clearanceHoldId = Rfc8785Json.MakeVerificationHoldId(
                        "rs-test",
                        scope.RootElement,
                        new[] { origins[1], origins[0] });
                }
                Assert.NotEqual(holdId, clearanceHoldId);
                break;
        }

        RbpInvocationIdentity consumer = FreshMutationIdentity();
        RbpRecoveryClearance clearance = Clearance(
            clearanceHoldId,
            basis: RbpClearanceBasis.LateTerminal,
            verificationInvocationId: null,
            evidenceDigest: LateDigest);
        RbpJournalException fault = await Assert.ThrowsAsync<RbpJournalException>(
            () => store.AdmitInvocationWithClearancesAsync(
                BindClearances(consumer, clearance),
                new[] { clearance }));

        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
        Assert.Equal(RbpHoldState.Active,
            (await store.GetHoldAsync("rs-test", holdId))?.State);
        foreach (string origin in origins)
        {
            Assert.Equal(
                RbpInvocationState.Indeterminate,
                (await store.GetInvocationAsync(origin))?.State);
        }
        Assert.Null(await store.GetInvocationAsync(consumer.IdempotencyKey));

        RbpClearanceGatedAdmission blocked =
            await store.AdmitInvocationWithClearancesAsync(
                consumer,
                Array.Empty<RbpRecoveryClearance>());
        Assert.Null(blocked.Admission);
        Assert.Equal(holdId, blocked.BlockingHold?.VerificationHoldId);
    }

    [Fact]
    public async Task CompleteExactLateTerminalGroupClearsAndAdmitsAtomically()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        (string holdId, string[] origins) = await InstallGroupedIndeterminateHoldAsync(
            store);

        foreach (string origin in origins)
        {
            _ = await store.PersistInvocationTerminalAsync(
                origin,
                Terminal(RbpInvocationState.Completed, """{"late":true}""", LateDigest));
        }

        RbpInvocationIdentity consumer = FreshMutationIdentity();
        RbpRecoveryClearance clearance = Clearance(
            holdId,
            basis: RbpClearanceBasis.LateTerminal,
            verificationInvocationId: null,
            evidenceDigest: LateDigest);
        RbpClearanceGatedAdmission admitted =
            await store.AdmitInvocationWithClearancesAsync(
                BindClearances(consumer, clearance),
                new[] { clearance });

        Assert.Equal(RbpInvocationAdmission.Accepted, admitted.Admission?.Admission);
        RbpVerificationHold? hold = await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.Cleared, hold?.State);
        Assert.Equal("late_terminal", hold?.ResolutionBasis);
        Assert.Equal(LateDigest, hold?.EvidenceDigest);
        foreach (string origin in origins)
        {
            Assert.Equal(
                LateDigest,
                (await store.GetInvocationAsync(origin))?.LateResultDigest);
        }
        Assert.Equal(
            RbpInvocationState.Received,
            (await store.GetInvocationAsync(consumer.IdempotencyKey))?.State);
    }

    [Fact]
    public async Task TheClearanceEnvelopeMustCoverEveryConflictingHold()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(store, fixture);
        string firstHold = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        string secondHold = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity(
                scopeJcs: SecondDocumentScope,
                invocationId: "0197a3c2-0000-7000-8000-0000000000b3"));
        RbpHoldVerificationEvidence evidence =
            await ProduceEvidenceAsync(store, fixture, firstHold);

        // A session-scope mutation conflicts with both document holds, so
        // an envelope clearing only one of them is not the one permitted
        // evidence-bound envelope; the whole transaction fails closed.
        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationWithClearancesAsync(
                    BindClearances(
                        FreshMutationIdentity(scopeJcs: SessionScope),
                        Clearance(firstHold, evidence)),
                    new[] { Clearance(firstHold, evidence) }));
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
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(store, fixture);
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        RbpHoldVerificationEvidence evidence =
            await ProduceEvidenceAsync(store, fixture, holdId);

        // The frozen array contains every and only conflicting holds; a
        // doc-2 mutation may not carry the doc-1 clearance.
        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationWithClearancesAsync(
                    BindClearances(
                        FreshMutationIdentity(scopeJcs: SecondDocumentScope),
                        Clearance(holdId, evidence)),
                    new[] { Clearance(holdId, evidence) }));
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
                    BindClearances(FreshReadIdentity(), Clearance(holdId)),
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
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(store, fixture);
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        RbpHoldVerificationEvidence evidence =
            await ProduceEvidenceAsync(store, fixture, holdId);
        _ = await store.AdmitInvocationWithClearancesAsync(
            BindClearances(
                FreshMutationIdentity(),
                Clearance(holdId, evidence)),
            new[] { Clearance(holdId, evidence) });

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
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(store, fixture);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                rsid: "rs-other",
                localSessionKey: "port:9090:pid:4321",
                resumeToken: "other-resume-token"));
        string holdId = await InstallIndeterminateHoldAsync(
            store,
            OriginIdentity());
        RbpHoldVerificationEvidence evidence =
            await ProduceEvidenceAsync(store, fixture, holdId);

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationWithClearancesAsync(
                    BindClearances(
                        FreshMutationIdentity() with { Rsid = "rs-other" },
                        Clearance(holdId, evidence)),
                    new[] { Clearance(holdId, evidence) }));
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

    private static Task<long> HoldCountAsync(RbpJournalStore store) =>
        store.ReadAsync(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM rbp_verification_holds;";
            return Convert.ToInt64(command.ExecuteScalar());
        });

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

    private static async Task<(string HoldId, string[] Origins)>
        InstallGroupedIndeterminateHoldAsync(RbpJournalStore store)
    {
        const string firstInvocationId =
            "0197a3c2-0000-7000-8000-0000000000c5";
        const string secondInvocationId =
            "0197a3c2-0000-7000-8000-0000000000c6";
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: true,
            "0197a3c2-0000-7000-8000-0000000000c7",
            new[]
            {
                RbpBatchTestData.WriteStep(firstInvocationId),
                RbpBatchTestData.WriteStep(
                    secondInvocationId,
                    DocumentScope,
                    method: "set_element_parameter"),
            });
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkBatchDispatchedAsync(batch.BatchKey);
        RbpBatchAdmissionResult arbitrated =
            (await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;

        string holdId = arbitrated.Steps[0].VerificationHoldId!;
        Assert.Equal(holdId, arbitrated.Steps[1].VerificationHoldId);
        string[] origins =
        [
            RbpBatchTestData.StepKey(firstInvocationId),
            RbpBatchTestData.StepKey(secondInvocationId),
        ];
        RbpVerificationHold hold = Assert.IsType<RbpVerificationHold>(
            await store.GetHoldAsync("rs-test", holdId));
        Assert.Equal(origins, hold.OrderedOriginIdempotencyKeys);
        return (holdId, origins);
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

    private static async Task<RbpHoldVerificationEvidence> ProduceEvidenceAsync(
        RbpJournalStore store,
        RbpApplicationErrorSafetyTests.RoutedFixture fixture,
        string holdId) =>
        await RbpJournalStoreProductionEvidence
            .ProduceEligibleCorrelatedReadAsync(
                store,
                fixture,
                holdId,
                DocumentScope,
                VerificationId);

    private static RbpRecoveryClearance Clearance(
        string holdId,
        RbpHoldVerificationEvidence evidence,
        string scopeJcs = DocumentScope,
        RbpClearanceBasis basis = RbpClearanceBasis.VerificationRead,
        string? verificationInvocationId = null,
        string? evidenceDigest = null,
        string resolutionId = ResolutionId,
        RbpClearanceDecision decision =
            RbpClearanceDecision.PostconditionVerified,
        string auditId = AuditId) =>
        Clearance(
            holdId,
            scopeJcs,
            basis,
            verificationInvocationId ?? evidence.VerificationInvocationId,
            evidenceDigest ?? evidence.EvidenceDigest,
            resolutionId,
            decision,
            auditId);

    private static RbpInvocationIdentity BindClearances(
        RbpInvocationIdentity identity,
        params RbpRecoveryClearance[] clearances)
    {
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(clearances);
        if (clearances.Length == 0)
        {
            return identity with { RecoveryClearancesJcs = "[]" };
        }

        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            foreach (RbpRecoveryClearance clearance in clearances)
            {
                writer.WriteStartObject();
                writer.WriteString("hold_id", clearance.HoldId);
                writer.WritePropertyName("mutation_scope");
                using (JsonDocument scope = JsonDocument.Parse(clearance.MutationScopeJcs))
                {
                    scope.RootElement.WriteTo(writer);
                }
                writer.WriteString("resolution_id", clearance.ResolutionId);
                writer.WriteString("basis", clearance.Basis == RbpClearanceBasis.VerificationRead
                    ? "verification_read" : "late_terminal");
                writer.WriteString("verification_invocation_id", clearance.VerificationInvocationId);
                writer.WriteString("evidence_digest", clearance.EvidenceDigest);
                writer.WriteString("decision", clearance.Decision == RbpClearanceDecision.NonExecutionProven
                    ? "non_execution_proven" : "postcondition_verified");
                writer.WriteString("audit_id", clearance.AuditId);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        using JsonDocument bound = JsonDocument.Parse(buffer.ToArray());
        return identity with
        {
            RecoveryClearancesJcs = Rfc8785Json.Canonicalize(bound.RootElement),
        };
    }

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
