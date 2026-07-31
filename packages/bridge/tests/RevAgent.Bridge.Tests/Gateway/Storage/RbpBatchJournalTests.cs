using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

/// <summary>
/// Frozen O1 conformance for the durable <c>invoke_batch</c> coordination
/// row: spec ~1071-1075 (bind <c>batch_digest</c>, <c>batch_id</c>,
/// <c>atomic</c>, timeout, clearances, and the complete ordered step set in
/// one transaction before any add-in byte), spec ~1102-1105 (any changed
/// element on redelivery is a terminal <c>protocol</c> fault), and Section
/// 21 item 28 (batch writes flow through Section 6.2.1 clearance gating).
/// </summary>
public sealed class RbpBatchJournalTests
{
    private const string BatchId = "0197a3c2-0000-7000-8000-0000000000e0";
    private const string WriteId = "0197a3c2-0000-7000-8000-0000000000e1";
    private const string ReadId = "0197a3c2-0000-7000-8000-0000000000e2";

    [Fact]
    public async Task FirstDeliveryBindsCoordinationRowAndAllStepsAtomically()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity batch = TwoStepBatch(atomic: false);

        RbpBatchGatedAdmission gated = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());

        Assert.Null(gated.BlockingHold);
        RbpBatchAdmissionResult admitted = gated.Admission!;
        Assert.Equal(RbpBatchAdmission.Accepted, admitted.Admission);
        Assert.All(
            admitted.Steps,
            step => Assert.Equal(
                RbpBatchStepDisposition.Accepted,
                step.Disposition));
        Assert.False(admitted.ReplayPermitted);
        Assert.Null(admitted.FirstNonSuccessStepIndex);

        // Spec ~1071-1075: every element of the coordination row is durably
        // bound before any add-in byte could have been written.
        RbpStoredBatch? stored =
            await store.GetBatchAsync(batch.BatchKey);
        Assert.NotNull(stored);
        Assert.Equal(batch.BatchDigest, stored!.BatchDigest);
        Assert.False(stored.Atomic);
        Assert.Equal(120_000, stored.TimeoutMilliseconds);
        Assert.Equal("[]", stored.RecoveryClearancesJcs);
        Assert.Equal(2, stored.StepCount);
        Assert.Equal(RbpBatchState.Received, stored.State);
        Assert.Contains(WriteId, stored.StepsJcs, StringComparison.Ordinal);
        Assert.Contains(ReadId, stored.StepsJcs, StringComparison.Ordinal);

        // Every step has its own journal row sharing batch_id, in input
        // order (spec ~873).
        RbpStoredInvocation? first =
            await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(WriteId));
        RbpStoredInvocation? second =
            await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(ReadId));
        Assert.Equal(RbpInvocationState.Received, first!.State);
        Assert.Equal(RbpInvocationState.Received, second!.State);
        Assert.Equal(BatchId, first.Identity.BatchId);
        Assert.Equal(0, first.Identity.BatchIndex);
        Assert.Equal(BatchId, second.Identity.BatchId);
        Assert.Equal(1, second.Identity.BatchIndex);
    }

    [Fact]
    public async Task MismatchedBatchDigestIsRejectedBeforeAnyRow()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity forged = TwoStepBatch(atomic: false) with
        {
            BatchDigest = "sha256:" + new string('d', 64),
        };

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitBatchAsync(
                    forged,
                    Array.Empty<RbpRecoveryClearance>()));

        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
        Assert.Null(await store.GetBatchAsync(forged.BatchKey));
        Assert.Null(
            await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(WriteId)));
    }

    [Theory]
    [InlineData("atomic")]
    [InlineData("timeout")]
    [InlineData("clearances")]
    [InlineData("step-omitted")]
    [InlineData("step-reordered")]
    [InlineData("step-method")]
    [InlineData("step-scope")]
    [InlineData("step-params")]
    [InlineData("step-policy")]
    public async Task AnyChangedElementOnRedeliveryIsATerminalProtocolFault(
        string change)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity original = TwoStepBatch(atomic: false);
        _ = await store.AdmitBatchAsync(
            original,
            Array.Empty<RbpRecoveryClearance>());

        RbpBatchStepIdentity write = RbpBatchTestData.WriteStep(WriteId);
        RbpBatchStepIdentity read = RbpBatchTestData.ReadStep(ReadId);
        RbpBatchIdentity changed = change switch
        {
            "atomic" => Rebuild(atomic: true, write, read),
            "timeout" => RbpBatchTestData.Batch(
                atomic: false,
                BatchId,
                new[] { write, read },
                timeoutMilliseconds: 180_000),
            "clearances" => RbpBatchTestData.Batch(
                atomic: false,
                BatchId,
                new[] { write, read },
                clearancesJcs: """["stale"]"""),
            "step-omitted" => Rebuild(atomic: false, write),
            "step-reordered" => Rebuild(atomic: false, read, write),
            "step-method" => Rebuild(
                atomic: false,
                write with { Method = "delete_wall" },
                read),
            "step-scope" => Rebuild(
                atomic: false,
                write with
                {
                    MutationScopeJcs = RbpBatchTestData.DocumentTwoScope,
                },
                read),
            "step-params" => Rebuild(
                atomic: false,
                write with
                {
                    ParamsDigest = "sha256:" + new string('e', 64),
                },
                read),
            _ => Rebuild(
                atomic: false,
                write with { Decision = "denied" },
                read),
        };

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitBatchAsync(
                    changed,
                    Array.Empty<RbpRecoveryClearance>()));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);

        // The durable binding is untouched by the faulted redelivery.
        RbpStoredBatch? stored = await store.GetBatchAsync(original.BatchKey);
        Assert.Equal(original.BatchDigest, stored!.BatchDigest);
        Assert.Equal(RbpBatchState.Received, stored.State);
        RbpStoredInvocation? step =
            await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(WriteId));
        Assert.Equal(RbpInvocationState.Received, step!.State);
    }

    [Fact]
    public async Task HarmlessReserializationOfBoundJsonIsNotAMismatch()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity original = TwoStepBatch(atomic: true);
        _ = await store.AdmitBatchAsync(
            original,
            Array.Empty<RbpRecoveryClearance>());

        // Spec ~1104-1105: property reordering that yields the same RFC
        // 8785 value is not a changed element.
        RbpBatchStepIdentity reorderedScope =
            RbpBatchTestData.WriteStep(
                WriteId,
                scopeJcs: """{"kind":"document","document_id":"doc-1"}""");
        RbpBatchIdentity reserialized = original with
        {
            Steps = new[]
            {
                reorderedScope,
                RbpBatchTestData.ReadStep(ReadId),
            },
        };

        RbpBatchGatedAdmission redelivered = await store.AdmitBatchAsync(
            reserialized,
            Array.Empty<RbpRecoveryClearance>());

        Assert.Equal(
            RbpBatchAdmission.ExecuteFromReceived,
            redelivered.Admission!.Admission);
    }

    [Fact]
    public async Task FreshBatchConflictingWithAnUnclearedHoldIsBlocked()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await RbpBatchTestData.InstallActiveHoldAsync(
            store,
            RbpBatchTestData.DocumentOneScope,
            "0197a3c2-0000-7000-8000-0000000000a9");
        RbpBatchIdentity batch = TwoStepBatch(atomic: false);

        RbpBatchGatedAdmission gated = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());

        // Section 21 item 28: the fresh batch write is blocked and no
        // coordination or step row exists.
        Assert.Null(gated.Admission);
        Assert.Equal(holdId, gated.BlockingHold!.VerificationHoldId);
        Assert.Null(await store.GetBatchAsync(batch.BatchKey));
        Assert.Null(
            await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(WriteId)));
    }

    [Fact]
    public async Task ClearanceEnvelopeOpensTheBatchAndClearsTheHoldAtomically()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string holdId = await RbpBatchTestData.InstallActiveHoldAsync(
            store,
            RbpBatchTestData.DocumentOneScope,
            "0197a3c2-0000-7000-8000-0000000000a9");
        const string verificationId =
            "0197a3c2-0000-7000-8000-0000000000aa";
        string evidenceDigest = "sha256:" + new string('f', 64);
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            new RbpHoldVerificationEvidence(
                holdId,
                verificationId,
                evidenceDigest,
                Conclusive: true));
        var clearance = new RbpRecoveryClearance(
            holdId,
            RbpBatchTestData.DocumentOneScope,
            "0197a3c2-0000-7000-8000-0000000000ab",
            RbpClearanceBasis.VerificationRead,
            verificationId,
            evidenceDigest,
            RbpClearanceDecision.PostconditionVerified,
            "0197a3c2-0000-7000-8000-0000000000ac");
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: true,
            BatchId,
            new[]
            {
                RbpBatchTestData.WriteStep(WriteId),
                RbpBatchTestData.ReadStep(ReadId),
            },
            clearancesJcs: RbpBatchTestData.ClearanceArrayJcs(clearance));

        RbpBatchGatedAdmission gated = await store.AdmitBatchAsync(
            batch,
            new[] { clearance });

        Assert.Null(gated.BlockingHold);
        Assert.Equal(
            RbpBatchAdmission.Accepted,
            gated.Admission!.Admission);
        RbpVerificationHold? cleared =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.Cleared, cleared!.State);

        // Redelivery of the identical envelope is idempotent and, with the
        // coordination row still `received`, proves no add-in byte was sent.
        RbpBatchGatedAdmission redelivered = await store.AdmitBatchAsync(
            batch,
            new[] { clearance });
        Assert.Equal(
            RbpBatchAdmission.ExecuteFromReceived,
            redelivered.Admission!.Admission);
    }

    [Fact]
    public async Task ResidualHoldConflictFailsClosedAndClearsNothing()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string documentHold = await RbpBatchTestData.InstallActiveHoldAsync(
            store,
            RbpBatchTestData.DocumentOneScope,
            "0197a3c2-0000-7000-8000-0000000000a9");
        string sessionHold = await RbpBatchTestData.InstallActiveHoldAsync(
            store,
            """{"kind":"session"}""",
            "0197a3c2-0000-7000-8000-0000000000b9");
        const string verificationId =
            "0197a3c2-0000-7000-8000-0000000000aa";
        string evidenceDigest = "sha256:" + new string('f', 64);
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            new RbpHoldVerificationEvidence(
                documentHold,
                verificationId,
                evidenceDigest,
                Conclusive: true));
        var clearance = new RbpRecoveryClearance(
            documentHold,
            RbpBatchTestData.DocumentOneScope,
            "0197a3c2-0000-7000-8000-0000000000ab",
            RbpClearanceBasis.VerificationRead,
            verificationId,
            evidenceDigest,
            RbpClearanceDecision.PostconditionVerified,
            "0197a3c2-0000-7000-8000-0000000000ac");
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: false,
            BatchId,
            new[] { RbpBatchTestData.WriteStep(WriteId) },
            clearancesJcs: RbpBatchTestData.ClearanceArrayJcs(clearance));

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitBatchAsync(batch, new[] { clearance }));

        // The one permitted evidence-bound envelope carries every
        // conflicting hold; the rollback keeps both holds uncleared and
        // writes no batch row.
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
        Assert.NotEqual(
            RbpHoldState.Cleared,
            (await store.GetHoldAsync("rs-test", documentHold))!.State);
        Assert.NotEqual(
            RbpHoldState.Cleared,
            (await store.GetHoldAsync("rs-test", sessionHold))!.State);
        Assert.Null(await store.GetBatchAsync(batch.BatchKey));
    }

    [Fact]
    public async Task AReadOnlyBatchMayNotCarryRecoveryClearances()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        var clearance = new RbpRecoveryClearance(
            "vh:" + new string('a', 64),
            RbpBatchTestData.DocumentOneScope,
            "0197a3c2-0000-7000-8000-0000000000ab",
            RbpClearanceBasis.VerificationRead,
            "0197a3c2-0000-7000-8000-0000000000aa",
            "sha256:" + new string('f', 64),
            RbpClearanceDecision.PostconditionVerified,
            "0197a3c2-0000-7000-8000-0000000000ac");
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: false,
            BatchId,
            new[] { RbpBatchTestData.ReadStep(ReadId) },
            clearancesJcs: RbpBatchTestData.ClearanceArrayJcs(clearance));

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitBatchAsync(batch, new[] { clearance }));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
    }

    [Fact]
    public async Task DispatchOwnershipIsOnceOnlyAndTerminalIsImmutable()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity batch = TwoStepBatch(atomic: true);
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());

        await store.MarkBatchDispatchedAsync(batch.BatchKey);
        RbpJournalException repeated =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.MarkBatchDispatchedAsync(batch.BatchKey));
        Assert.Equal(
            RbpJournalErrorCode.ProtocolConflict,
            repeated.ErrorCode);

        RbpStoredBatch terminal = await store.PersistBatchTerminalAsync(
            batch.BatchKey,
            RbpBatchTestData.BatchTerminal(
                """{"status":"completed","transaction_state":"committed"}"""));
        Assert.Equal(RbpBatchState.Terminal, terminal.State);

        RbpJournalException immutable =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.PersistBatchTerminalAsync(
                    batch.BatchKey,
                    RbpBatchTestData.BatchTerminal(
                        """{"status":"failed"}""")));
        Assert.Equal(
            RbpJournalErrorCode.ProtocolConflict,
            immutable.ErrorCode);
    }

    private static RbpBatchIdentity TwoStepBatch(bool atomic) =>
        Rebuild(
            atomic,
            RbpBatchTestData.WriteStep(WriteId),
            RbpBatchTestData.ReadStep(ReadId));

    private static RbpBatchIdentity Rebuild(
        bool atomic,
        params RbpBatchStepIdentity[] steps) =>
        RbpBatchTestData.Batch(atomic, BatchId, steps);

    private static RbpJournalStore OpenStore(
        RbpJournalTestDirectory directory) =>
        RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
}
