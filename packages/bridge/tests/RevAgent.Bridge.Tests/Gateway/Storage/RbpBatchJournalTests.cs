using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Dispatch;

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
    private const string SuccessorBatchId =
        "0197a3c2-0000-7000-8000-0000000000e3";
    private const string SuccessorWriteId =
        "0197a3c2-0000-7000-8000-0000000000e4";
    private const string FreshSuccessorBatchId =
        "0197a3c2-0000-7000-8000-0000000000e5";
    private const string FreshSuccessorWriteId =
        "0197a3c2-0000-7000-8000-0000000000e6";
    private const string ReceivedSuccessorBatchId =
        "0197a3c2-0000-7000-8000-0000000000e7";
    private const string ReceivedSuccessorWriteId =
        "0197a3c2-0000-7000-8000-0000000000e8";
    private const string SameRsidReceivedBatchId =
        "0197a3c2-0000-7000-8000-0000000000e9";
    private const string SameRsidReceivedWriteId =
        "0197a3c2-0000-7000-8000-0000000000ea";
    private const string SameRsidHistoricalOriginId =
        "0197a3c2-0000-7000-8000-0000000000eb";
    private const string ReadAvailabilityBatchId =
        "0197a3c2-0000-7000-8000-0000000000ec";
    private const string ReadAvailabilityPrefixId =
        "0197a3c2-0000-7000-8000-0000000000ed";
    private const string ReadAvailabilityReadId =
        "0197a3c2-0000-7000-8000-0000000000ee";
    private const string ReadAvailabilityWriteId =
        "0197a3c2-0000-7000-8000-0000000000ef";
    private const string ReadAvailabilityHistoricalOriginId =
        "0197a3c2-0000-7000-8000-0000000000f0";
    private const string SuccessorRsid = "rs-successor";
    private const string VerificationId =
        "0197a3c2-0000-7000-8000-0000000000aa";

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

        // Section 21 item 28: the fresh batch fails closed before any
        // coordination or step row exists.
        Assert.Null(gated.Admission);
        Assert.Equal(holdId, gated.BlockingHold?.VerificationHoldId);
        Assert.Null(await store.GetBatchAsync(batch.BatchKey));
        Assert.Null(
            await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(WriteId)));
        Assert.Equal(
            RbpHoldState.Active,
            (await store.GetHoldAsync("rs-test", holdId))!.State);
    }

    [Fact]
    public async Task SameLocalSessionKeyPredecessorHoldRejectsSuccessorBatchBeforeAnyRow()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        const string localSessionKey = "port:8080:pid:1234";
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                localSessionKey: localSessionKey));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                SuccessorRsid,
                localSessionKey: localSessionKey));

        string predecessorHold = await RbpBatchTestData.InstallActiveHoldAsync(
            store,
            RbpBatchTestData.DocumentOneScope,
            "0197a3c2-0000-7000-8000-0000000000a9");
        RbpVerificationHold predecessorBefore =
            (await store.GetHoldAsync("rs-test", predecessorHold))!;
        RbpBatchIdentity successor = RbpBatchTestData.Batch(
            atomic: false,
            SuccessorBatchId,
            new[] { RbpBatchTestData.WriteStep(SuccessorWriteId) },
            rsid: SuccessorRsid);

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitBatchAsync(
                    successor,
                    Array.Empty<RbpRecoveryClearance>()));

        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
        Assert.Contains("legacy_outcome_unverified", fault.Message, StringComparison.Ordinal);
        Assert.Null(await store.GetBatchAsync(successor.BatchKey));
        Assert.Null(
            await store.GetInvocationAsync(
                SuccessorRsid + "/" + SuccessorWriteId));
        RbpVerificationHold predecessorAfter =
            (await store.GetHoldAsync("rs-test", predecessorHold))!;
        Assert.Equal(predecessorBefore.VerificationHoldId, predecessorAfter.VerificationHoldId);
        Assert.Equal(predecessorBefore.State, predecessorAfter.State);
        Assert.Equal(
            predecessorBefore.OrderedOriginIdempotencyKeys.ToArray(),
            predecessorAfter.OrderedOriginIdempotencyKeys.ToArray());
        Assert.Equal(predecessorBefore.VerificationInvocationId, predecessorAfter.VerificationInvocationId);
        Assert.Equal(predecessorBefore.EvidenceDigest, predecessorAfter.EvidenceDigest);
        Assert.Equal(predecessorBefore.ResolutionId, predecessorAfter.ResolutionId);
    }

    [Fact]
    public async Task SameLocalSessionKeyPredecessorDoesNotBlockExactSuccessorReplay()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        const string localSessionKey = "port:8080:pid:1234";
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                localSessionKey: localSessionKey));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                SuccessorRsid,
                localSessionKey: localSessionKey));

        RbpBatchIdentity successor = RbpBatchTestData.Batch(
            atomic: false,
            SuccessorBatchId,
            new[] { RbpBatchTestData.WriteStep(SuccessorWriteId) },
            rsid: SuccessorRsid);
        _ = await store.AdmitBatchAsync(
            successor,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkBatchDispatchedAsync(successor.BatchKey);
        string successorStepKey = SuccessorRsid + "/" + SuccessorWriteId;
        await store.MarkInvocationExecutingAsync(successorStepKey);
        _ = await store.PersistInvocationTerminalAsync(
            successorStepKey,
            RbpBatchTestData.StepTerminal(
                RbpInvocationState.Completed,
                """{"ok":true}"""));
        RbpStoredBatch terminal = await store.PersistBatchTerminalAsync(
            successor.BatchKey,
            RbpBatchTestData.BatchTerminal(
                """{"status":"completed","transaction_state":"committed"}"""));

        RbpBatchIdentity received = RbpBatchTestData.Batch(
            atomic: true,
            ReceivedSuccessorBatchId,
            new[] { RbpBatchTestData.WriteStep(ReceivedSuccessorWriteId) },
            rsid: SuccessorRsid);
        _ = await store.AdmitBatchAsync(
            received,
            Array.Empty<RbpRecoveryClearance>());
        RbpStoredBatch receivedBefore =
            (await store.GetBatchAsync(received.BatchKey))!;

        RbpInvocationIdentity predecessor = new(
            "rs-test",
            "0197a3c2-0000-7000-8000-0000000000a9",
            "set_element_parameter",
            Mutating: true,
            MutationScopeJcs: RbpBatchTestData.DocumentOneScope,
            ParamsDigest: "sha256:" + new string('b', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");
        string predecessorHold = InsertHistoricalUnresolvedPredecessor(
            directory.JournalPath,
            predecessor);
        RbpVerificationHold predecessorBeforeReplay =
            (await store.GetHoldAsync("rs-test", predecessorHold))!;
        RbpStoredInvocation predecessorBeforeReplayOrigin =
            (await store.GetInvocationAsync(predecessor.IdempotencyKey))!;
        Assert.Equal(RbpInvocationState.Indeterminate, predecessorBeforeReplayOrigin.State);
        Assert.Equal(predecessorHold, predecessorBeforeReplayOrigin.VerificationHoldId);
        Assert.Equal(
            Rfc8785Json.Sha256Digest(
                RbpJournalTestData.Json("""{"fault_class":"journal_indeterminate"}""")),
            predecessorBeforeReplayOrigin.ResultDigest);

        RbpBatchAdmissionResult replay =
            (await store.AdmitBatchAsync(
                successor,
                Array.Empty<RbpRecoveryClearance>())).Admission!;
        Assert.Equal(RbpBatchAdmission.ReplayTerminal, replay.Admission);
        Assert.Equal(terminal.TerminalOutcomeJson, replay.Stored.TerminalOutcomeJson);
        Assert.Equal(RbpBatchStepDisposition.ReplayTerminal, replay.Steps[0].Disposition);
        Assert.Equal(
            RbpInvocationState.Completed,
            (await store.GetInvocationAsync(successorStepKey))!.State);
        RbpVerificationHold predecessorAfterReplay =
            (await store.GetHoldAsync("rs-test", predecessorHold))!;
        Assert.Equal(predecessorBeforeReplay.State, predecessorAfterReplay.State);
        Assert.Equal(
            predecessorBeforeReplay.OrderedOriginIdempotencyKeys,
            predecessorAfterReplay.OrderedOriginIdempotencyKeys);
        Assert.Equal(
            predecessorBeforeReplay.VerificationInvocationId,
            predecessorAfterReplay.VerificationInvocationId);
        Assert.Equal(
            predecessorBeforeReplay.EvidenceDigest,
            predecessorAfterReplay.EvidenceDigest);

        RbpJournalException receivedDenied =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitBatchAsync(
                    received,
                    Array.Empty<RbpRecoveryClearance>()));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, receivedDenied.ErrorCode);
        Assert.Contains(
            "legacy_outcome_unverified",
            receivedDenied.Message,
            StringComparison.Ordinal);
        RbpStoredBatch receivedAfter =
            (await store.GetBatchAsync(received.BatchKey))!;
        Assert.Equal(RbpBatchState.Received, receivedAfter.State);
        Assert.Equal(receivedBefore.StepsJcs, receivedAfter.StepsJcs);
        Assert.Equal(
            RbpInvocationState.Received,
            (await store.GetInvocationAsync(
                SuccessorRsid + "/" + ReceivedSuccessorWriteId))!.State);

        RbpBatchIdentity fresh = RbpBatchTestData.Batch(
            atomic: false,
            FreshSuccessorBatchId,
            new[] { RbpBatchTestData.WriteStep(FreshSuccessorWriteId) },
            rsid: SuccessorRsid);
        RbpJournalException denied =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitBatchAsync(
                    fresh,
                    Array.Empty<RbpRecoveryClearance>()));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, denied.ErrorCode);
        Assert.Contains("legacy_outcome_unverified", denied.Message, StringComparison.Ordinal);
        Assert.Null(await store.GetBatchAsync(fresh.BatchKey));
        Assert.Null(
            await store.GetInvocationAsync(
                SuccessorRsid + "/" + FreshSuccessorWriteId));
    }

    [Fact]
    public async Task HistoricalSameRsidHoldBlocksDispatchCapableReceivedBatchRedelivery()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(SuccessorRsid));
        RbpBatchIdentity received = RbpBatchTestData.Batch(
            atomic: true,
            SameRsidReceivedBatchId,
            new[] { RbpBatchTestData.WriteStep(SameRsidReceivedWriteId) },
            rsid: SuccessorRsid);
        _ = await store.AdmitBatchAsync(
            received,
            Array.Empty<RbpRecoveryClearance>());
        RbpInvocationIdentity predecessor = new(
            SuccessorRsid,
            SameRsidHistoricalOriginId,
            "set_element_parameter",
            Mutating: true,
            MutationScopeJcs: RbpBatchTestData.DocumentOneScope,
            ParamsDigest: "sha256:" + new string('b', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");
        string predecessorHold = InsertHistoricalUnresolvedPredecessor(
            directory.JournalPath,
            predecessor);
        Assert.Equal(
            RbpHoldState.Active,
            (await store.GetHoldAsync(SuccessorRsid, predecessorHold))!.State);

        var denied = await store.AdmitBatchAsync(
            received,
            Array.Empty<RbpRecoveryClearance>());

        Assert.Null(denied.Admission);
        Assert.Equal(
            predecessorHold,
            denied.BlockingHold?.VerificationHoldId);
        Assert.Equal(
            RbpBatchState.Received,
            (await store.GetBatchAsync(received.BatchKey))!.State);
        Assert.Equal(
            RbpInvocationState.Received,
            (await store.GetInvocationAsync(
                SuccessorRsid + "/" + SameRsidReceivedWriteId))!.State);
    }

    [Fact]
    public async Task HistoricalPredecessorStillAllowsExactRedeliveryToRetryPendingRead()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        const string localSessionKey = "port:8080:pid:1234";
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                localSessionKey: localSessionKey));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                SuccessorRsid,
                localSessionKey: localSessionKey));
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: false,
            ReadAvailabilityBatchId,
            new[]
            {
                RbpBatchTestData.ReadStep(ReadAvailabilityPrefixId),
                RbpBatchTestData.ReadStep(ReadAvailabilityReadId),
                RbpBatchTestData.WriteStep(ReadAvailabilityWriteId),
            },
            rsid: SuccessorRsid);
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkBatchDispatchedAsync(batch.BatchKey);
        string prefixKey = SuccessorRsid + "/" + ReadAvailabilityPrefixId;
        await store.MarkInvocationExecutingAsync(prefixKey);
        _ = await store.PersistInvocationTerminalAsync(
            prefixKey,
            RbpBatchTestData.StepTerminal(
                RbpInvocationState.Completed,
                """{"ok":true}"""));

        RbpInvocationIdentity predecessor = new(
            "rs-test",
            ReadAvailabilityHistoricalOriginId,
            "set_element_parameter",
            Mutating: true,
            MutationScopeJcs: RbpBatchTestData.DocumentOneScope,
            ParamsDigest: "sha256:" + new string('b', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");
        _ = InsertHistoricalUnresolvedPredecessor(
            directory.JournalPath,
            predecessor);

        RbpBatchAdmissionResult replay =
            (await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;

        Assert.Equal(RbpBatchAdmission.ArbitratedSteps, replay.Admission);
        Assert.Equal(
            new[]
            {
                RbpBatchStepDisposition.ReplayTerminal,
                RbpBatchStepDisposition.RetryNonMutating,
                RbpBatchStepDisposition.NotStarted,
            },
            replay.Steps.Select(step => step.Disposition).ToArray());
        Assert.Equal(
            RbpInvocationState.Received,
            (await store.GetInvocationAsync(
                SuccessorRsid + "/" + ReadAvailabilityReadId))!.State);
        RbpStoredInvocation write =
            (await store.GetInvocationAsync(
                SuccessorRsid + "/" + ReadAvailabilityWriteId))!;
        Assert.Equal(RbpInvocationState.Received, write.State);
        Assert.Null(write.StartedAtMilliseconds);
    }

    [Fact]
    public async Task ClearanceEnvelopeOpensTheBatchAndClearsTheHoldAtomically()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", -32603);
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                localSessionKey: fixture.Route.Handle!.LocalSessionKey));
        await RbpJournalStoreProductionEvidence.BindInvocationAuthorityAsync(
            store, fixture);
        string holdId = await RbpBatchTestData.InstallActiveHoldAsync(
            store,
            RbpBatchTestData.DocumentOneScope,
            "0197a3c2-0000-7000-8000-0000000000a9");
        string evidenceDigest = await ProduceCorrelatedVerificationEvidenceAsync(
            store,
            fixture,
            holdId,
            RbpBatchTestData.DocumentOneScope);
        var clearance = new RbpRecoveryClearance(
            holdId,
            RbpBatchTestData.DocumentOneScope,
            "0197a3c2-0000-7000-8000-0000000000ab",
            RbpClearanceBasis.VerificationRead,
            VerificationId,
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
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", -32603);
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                localSessionKey: fixture.Route.Handle!.LocalSessionKey));
        await RbpJournalStoreProductionEvidence.BindInvocationAuthorityAsync(
            store, fixture);

        // These are deliberately non-conflicting document scopes. The
        // legacy barrier correctly refuses a fresh session-scoped origin
        // after the first unresolved document hold, so two independent
        // active holds must be created on two documents before the batch
        // admission tests its all-or-nothing clearance behavior.
        RbpInvocationIdentity documentOrigin =
            await RbpBatchTestData.StartPossiblyDispatchedMutationAsync(
                store,
                RbpBatchTestData.DocumentOneScope,
                "0197a3c2-0000-7000-8000-0000000000a9");
        RbpInvocationIdentity documentTwoOrigin =
            await RbpBatchTestData.StartPossiblyDispatchedMutationAsync(
                store,
                RbpBatchTestData.DocumentTwoScope,
                "0197a3c2-0000-7000-8000-0000000000b9");
        string documentHold = await RbpBatchTestData.RefuseRedeliveryAsync(
            store,
            documentOrigin);
        string documentTwoHold = await RbpBatchTestData.RefuseRedeliveryAsync(
            store,
            documentTwoOrigin);
        string evidenceDigest = await ProduceCorrelatedVerificationEvidenceAsync(
            store,
            fixture,
            documentHold,
            RbpBatchTestData.DocumentOneScope);
        var clearance = new RbpRecoveryClearance(
            documentHold,
            RbpBatchTestData.DocumentOneScope,
            "0197a3c2-0000-7000-8000-0000000000ab",
            RbpClearanceBasis.VerificationRead,
            VerificationId,
            evidenceDigest,
            RbpClearanceDecision.PostconditionVerified,
            "0197a3c2-0000-7000-8000-0000000000ac");
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: false,
            BatchId,
            new[]
            {
                RbpBatchTestData.WriteStep(WriteId),
                RbpBatchTestData.WriteStep(
                    ReadId,
                    RbpBatchTestData.DocumentTwoScope),
            },
            clearancesJcs: RbpBatchTestData.ClearanceArrayJcs(clearance));

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitBatchAsync(batch, new[] { clearance }));

        // The one permitted evidence-bound envelope carries every
        // conflicting hold; a document-one clearance cannot partially clear
        // ahead of the still-conflicting document-two hold, so the rollback
        // keeps both holds uncleared and writes no batch row.
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
        Assert.NotEqual(
            RbpHoldState.Cleared,
            (await store.GetHoldAsync("rs-test", documentHold))!.State);
        Assert.NotEqual(
            RbpHoldState.Cleared,
            (await store.GetHoldAsync("rs-test", documentTwoHold))!.State);
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

    private static string InsertHistoricalUnresolvedPredecessor(
        string journalPath,
        RbpInvocationIdentity identity)
    {
        using JsonDocument scope = JsonDocument.Parse(identity.MutationScopeJcs!);
        string holdId = Rfc8785Json.MakeVerificationHoldId(
            identity.Rsid,
            scope.RootElement,
            new[] { identity.IdempotencyKey });
        const long fixtureTimestamp = 1_785_060_000_000;
        const string terminalJson = """{"fault_class":"journal_indeterminate"}""";
        string terminalDigest = Rfc8785Json.Sha256Digest(
            RbpJournalTestData.Json(terminalJson));

        using var connection = new SqliteConnection(
            $"Data Source={journalPath};Pooling=False");
        connection.Open();
        using SqliteTransaction transaction =
            (SqliteTransaction)connection.BeginTransaction();
        using (SqliteCommand hold = connection.CreateCommand())
        {
            hold.Transaction = transaction;
            hold.CommandText =
                """
                INSERT INTO rbp_verification_holds(
                  verification_hold_id,rsid,scope_kind,document_id,scope_jcs,
                  ordered_origin_idempotency_keys_json,state,
                  created_at_ms,updated_at_ms)
                VALUES($id,$rsid,'document','doc-1',$scope,$origins,'active',
                       $created,$updated);
                """;
            hold.Parameters.AddWithValue("$id", holdId);
            hold.Parameters.AddWithValue("$rsid", identity.Rsid);
            hold.Parameters.AddWithValue("$scope", identity.MutationScopeJcs);
            hold.Parameters.AddWithValue(
                "$origins",
                JsonSerializer.Serialize(new[] { identity.IdempotencyKey }));
            hold.Parameters.AddWithValue("$created", fixtureTimestamp);
            hold.Parameters.AddWithValue("$updated", fixtureTimestamp);
            Assert.Equal(1, hold.ExecuteNonQuery());
        }

        using (SqliteCommand origin = connection.CreateCommand())
        {
            origin.Transaction = transaction;
            origin.CommandText =
                """
                INSERT INTO rbp_invocations(
                  idempotency_key,rsid,invocation_id,batch_id,batch_index,
                  method,mutating,mutation_scope_jcs,params_digest,policy_jcs,
                  recovery_clearances_jcs,state,terminal_outcome_json,result_digest,
                  verification_hold_id,created_at_ms,finished_at_ms)
                VALUES($key,$rsid,$invocation,NULL,NULL,
                       $method,1,$scope,$params,$policy,
                       $clearances,'indeterminate',$terminal,$digest,
                       $hold,$created,$finished);
                """;
            origin.Parameters.AddWithValue("$key", identity.IdempotencyKey);
            origin.Parameters.AddWithValue("$rsid", identity.Rsid);
            origin.Parameters.AddWithValue("$invocation", identity.InvocationId);
            origin.Parameters.AddWithValue("$method", identity.Method);
            origin.Parameters.AddWithValue("$scope", identity.MutationScopeJcs);
            origin.Parameters.AddWithValue("$params", identity.ParamsDigest);
            origin.Parameters.AddWithValue("$policy", identity.PolicyJcs);
            origin.Parameters.AddWithValue("$clearances", identity.RecoveryClearancesJcs);
            origin.Parameters.AddWithValue("$terminal", terminalJson);
            origin.Parameters.AddWithValue("$digest", terminalDigest);
            origin.Parameters.AddWithValue("$hold", holdId);
            origin.Parameters.AddWithValue("$created", fixtureTimestamp);
            origin.Parameters.AddWithValue("$finished", fixtureTimestamp);
            Assert.Equal(1, origin.ExecuteNonQuery());
        }

        transaction.Commit();
        return holdId;
    }

    private static async Task<string> ProduceCorrelatedVerificationEvidenceAsync(
        RbpJournalStore store,
        RbpApplicationErrorSafetyTests.RoutedFixture fixture,
        string holdId,
        string scopeJcs)
    {
        fixture.Transport.SetResponse("""{"success":true}""", null);
        var dispatcher = new RbpInvocationDispatcher(
            store,
            fixture.Channel,
            new RbpInFlightGate());
        RbpInvocationAnswer verification = await
            RbpCorrelatedVerificationFlowTests.DispatchVerificationAsync(
                dispatcher,
                fixture,
                VerificationReadRequest(holdId, scopeJcs));

        Assert.Equal("result", verification.Type);
        RbpVerificationHold hold =
            (await store.GetHoldAsync("rs-test", holdId))!;
        Assert.Equal(RbpHoldState.EvidenceRecorded, hold.State);
        Assert.Equal(VerificationId, hold.VerificationInvocationId);
        return hold.EvidenceDigest!;
    }

    private static RbpInvokeRequest VerificationReadRequest(
        string holdId,
        string scopeJcs)
    {
        string payload =
            $$"""
            {
              "invocation_id": "{{VerificationId}}",
              "method": "get_element_parameter",
              "params": {"element_id": 42},
              "timeout_ms": 30000,
              "mutating": false,
              "mutation_scope": null,
              "policy": {"class":"read","decision":"allow"},
              "verification": {
                "hold_id": "{{holdId}}",
                "mutation_scope": {{scopeJcs}},
                "purpose": "resolve_indeterminate"
              },
              "recovery_clearances": []
            }
            """;
        using JsonDocument document = JsonDocument.Parse(payload);
        return RbpInvokeRequest.Parse("rs-test", document.RootElement.Clone());
    }
}
