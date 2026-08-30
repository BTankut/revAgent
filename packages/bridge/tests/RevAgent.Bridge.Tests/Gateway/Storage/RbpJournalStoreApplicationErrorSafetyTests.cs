using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Dispatch;
using static RevAgent.Bridge.Tests.Gateway.Dispatch.RbpApplicationErrorSafetyTests;
using static RevAgent.Bridge.Tests.Gateway.Dispatch.RbpBatchCoordinatorTestData;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

public sealed class RbpJournalStoreApplicationErrorSafetyTests
{
    [Fact]
    public async Task OperationAdmittedBeforePoisonCannotEnterTheStoreAfterPoison()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();

        Task<int> holding = Task.Run(() => store.ReadAsync(_ =>
            {
                entered.Set();
                release.Wait();
                return 1;
            }));
        try
        {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(2)));
            Task<int> admittedBeforePoison = store.ReadAsync(_ => 2);

            store.PoisonProcessAuthority();
            release.Set();

            Assert.Equal(1, await holding);
            RbpJournalException denied = await Assert.ThrowsAsync<
                RbpJournalException>(() => admittedBeforePoison);
            Assert.Equal(RbpJournalErrorCode.StoreClosed, denied.ErrorCode);
        }
        finally
        {
            release.Set();
        }
    }

    [Fact]
    public async Task ConnectionGenerationDeactivateIsSignedIdempotentAndMonotonic()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);

        Assert.Equal(1, await store.ActivateConnectionGenerationAsync(1));
        Assert.Equal(1, await store.DeactivateConnectionGenerationAsync(
            1, CancellationToken.None));
        Assert.Equal(1, await store.DeactivateConnectionGenerationAsync(
            1, CancellationToken.None));
        await Assert.ThrowsAsync<RbpJournalException>(() =>
            store.ActivateConnectionGenerationAsync(1));
        Assert.Equal(2, await store.ActivateConnectionGenerationAsync(2));
        await Assert.ThrowsAsync<RbpJournalException>(() =>
            store.DeactivateConnectionGenerationAsync(
                1, CancellationToken.None));
        await Assert.ThrowsAsync<RbpJournalException>(() =>
            store.ActivateConnectionGenerationAsync(3));
    }

    [Theory]
    [InlineData("repeated", false)]
    [InlineData("distinct", false)]
    [InlineData("session", false)]
    [InlineData("repeated", true)]
    [InlineData("distinct", true)]
    [InlineData("session", true)]
    public async Task AtomicPowerCutNeverExposesPartialHoldsOrMembers(string scopes, bool afterCommit)
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new DecisionFaults();
        await using RbpJournalStore store = await Open(directory, faults);
        BatchStepSpec second = Write(Second) with
        {
            MutationScopeJson = scopes switch
            {
                "distinct" => "{\"kind\":\"document\",\"document_id\":\"doc-2\"}",
                "session" => "{\"kind\":\"session\"}",
                _ => DocumentScope,
            },
        };
        RbpBatchRequest request = RbpBatchRequest.Parse(Rsid, Payload(Batch, true,
            [Write(First), second, Read(Third)]));
        await store.AdmitBatchAsync(request.ToIdentity(), []);
        await store.MarkBatchDispatchedAsync(request.BatchKey);
        faults.Arm(afterCommit ? RbpJournalFaultPoint.AfterCommitBeforeReturn : RbpJournalFaultPoint.BeforeCommit,
            afterCommit ? 1 : 2);
        if (!afterCommit)
        {
            await Assert.ThrowsAsync<IOException>(() => store.PersistAtomicDispatchFailureAsync(request.ToIdentity(), "parameter"));
            Assert.Equal(RbpBatchState.Dispatched, (await store.GetBatchAsync(request.BatchKey))!.State);
            for (int i = 0; i < 3; i++)
            {
                RbpStoredInvocation row = (await store.GetInvocationAsync(request.StepKey(i)))!;
                Assert.Equal(RbpInvocationState.Received, row.State);
                Assert.Null(row.VerificationHoldId);
                Assert.Null(row.TerminalOutcomeJson);
            }
            Assert.Equal(0, await HoldCount(store));
            Assert.Equal(2, faults.Failures);
            return;
        }

        RbpBatchAdmissionResult decision = await store.PersistAtomicDispatchFailureAsync(request.ToIdentity(), "parameter");
        Assert.False(decision.ReplayPermitted);
        Assert.Equal(RbpBatchState.Terminal, decision.Stored.State);
        Assert.Equal(scopes == "distinct" ? 2 : 1, await HoldCount(store));
        string[] expectedOrigins = [request.StepKey(0), request.StepKey(1)];
        foreach (RbpBatchStepArbitration member in decision.Steps.Take(2))
        {
            Assert.Equal(RbpInvocationState.Indeterminate, member.Stored!.State);
            RbpVerificationHold hold = (await store.GetHoldAsync(Rsid, member.VerificationHoldId!))!;
            string[] origins = scopes == "distinct" ? [request.StepKey(member.BatchIndex)] : expectedOrigins;
            Assert.Equal(origins, hold.OrderedOriginIdempotencyKeys);
            Assert.Equal(Rfc8785Json.MakeVerificationHoldId(Rsid, Json(hold.ScopeJcs), origins), hold.VerificationHoldId);
            // Synthetic O1 evidence has a canonical JSON digest, not raw add-in bytes.
            Assert.Equal(Rfc8785Json.Sha256Digest(Json(member.Stored.TerminalOutcomeJson!)), member.Stored.ResultDigest);
        }
        RbpStoredInvocation read = decision.Steps[2].Stored!;
        Assert.Equal(RbpInvocationState.Failed, read.State);
        Assert.Contains("\"retryable\":false", read.TerminalOutcomeJson);
        Assert.Contains("\"fault_class\":\"parameter\"", read.TerminalOutcomeJson);
        Assert.Equal(1, faults.Failures);
    }

    [Fact]
    public async Task AppliedCommitWithSubstitutedTerminalIsNotAcceptedAsExactProof()
    {
        using var directory = new RbpJournalTestDirectory();
        var fault = new TamperAfterCommit(directory.JournalPath);
        await using RbpJournalStore store = await Open(directory, fault);
        RbpInvokeRequest request = Request(true);
        await store.AdmitInvocationAsync(request.ToIdentity());
        await store.MarkInvocationExecutingAsync(request.ToIdentity().IdempotencyKey);
        fault.Armed = true;
        await Assert.ThrowsAsync<RbpJournalException>(() => store.PersistInvocationTerminalAsync(
            request.ToIdentity().IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Indeterminate, default, null),
            expectedIdentity: request.ToIdentity()));
        Assert.Equal(1, fault.Calls);
    }

    [Fact]
    public async Task ReopenPreservesCurrentGroupedDecisionAndBlocksEveryScope()
    {
        using var directory = new RbpJournalTestDirectory();
        RbpBatchRequest request = RbpBatchRequest.Parse(Rsid, Payload(Batch, true,
            [Write(First), Write(Second) with { MutationScopeJson = "{\"kind\":\"document\",\"document_id\":\"doc-2\"}" }]));
        await using (RbpJournalStore store = await Open(directory))
        {
            await store.AdmitBatchAsync(request.ToIdentity(), []);
            await store.MarkBatchDispatchedAsync(request.BatchKey);
            await store.PersistAtomicDispatchFailureAsync(request.ToIdentity(), "revit_api");
        }
        await using RbpJournalStore reopened = RbpJournalStore.Open(directory.JournalPath,
            new TestResumeTokenProtector(), RbpJournalTestData.Options());
        Assert.Equal(2, await HoldCount(reopened));
        var channel = new StubBatchChannel();
        var coordinator = new RbpBatchCoordinator(reopened, channel, StubBatchCapabilities.Standard(true));
        foreach (string scope in new[] { DocumentScope, "{\"kind\":\"document\",\"document_id\":\"doc-2\"}" })
        {
            RbpInvocationAnswer blocked = await coordinator.DispatchAsync(Rsid,
                Payload("0197a3c2-0000-7000-8000-0000000000b2", true, [Write(Third) with { MutationScopeJson = scope }]), CancellationToken.None);
            Assert.Equal("journal_indeterminate", blocked.Payload.GetProperty("fault_class").GetString());
        }
        Assert.Empty(channel.Calls);
    }

    [Fact]
    public async Task SharedLocalSessionSuccessorCannotAdmitPastPredecessorUncertainty()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        const string predecessor = "rs-predecessor";
        const string successor = "rs-successor";
        const string sharedLocalSessionKey = "port:8080:pid:4242";
        await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration(
            rsid: predecessor,
            localSessionKey: sharedLocalSessionKey,
            resumeToken: "predecessor-resume"));
        await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration(
            rsid: successor,
            localSessionKey: sharedLocalSessionKey,
            resumeToken: "successor-resume"));

        RbpInvocationIdentity origin = MutationIdentity(
            predecessor,
            "0197a3c2-0000-7000-8000-0000000000c1");
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        RbpInvocationAdmissionResult refused =
            await store.AdmitInvocationAsync(origin);
        Assert.Equal(RbpInvocationAdmission.RefuseIndeterminate, refused.Admission);
        string holdId = Assert.IsType<string>(refused.VerificationHoldId);
        RbpVerificationHold before = Assert.IsType<RbpVerificationHold>(
            await store.GetHoldAsync(predecessor, holdId));

        RbpInvocationIdentity fresh = MutationIdentity(
            successor,
            "0197a3c2-0000-7000-8000-0000000000c2");
        RbpJournalException fault = await Assert.ThrowsAsync<RbpJournalException>(
            () => store.AdmitInvocationWithClearancesAsync(
                fresh,
                Array.Empty<RbpRecoveryClearance>()));

        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
        Assert.Contains("legacy_outcome_unverified", fault.Message,
            StringComparison.Ordinal);
        Assert.Null(await store.GetInvocationAsync(fresh.IdempotencyKey));
        RbpVerificationHold after = Assert.IsType<RbpVerificationHold>(
            await store.GetHoldAsync(predecessor, holdId));
        Assert.Equal(before.State, after.State);
        Assert.Equal(before.EvidenceDigest, after.EvidenceDigest);
        Assert.Equal(before.VerificationInvocationId, after.VerificationInvocationId);
    }

    [Fact]
    public async Task ExactTerminalReplaySurvivesLaterSharedLocalSessionPredecessorUncertainty()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        const string predecessor = "rs-replay-predecessor";
        const string successor = "rs-replay-successor";
        const string sharedLocalSessionKey = "port:8080:pid:4242";
        await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration(
            rsid: predecessor,
            localSessionKey: sharedLocalSessionKey,
            resumeToken: "predecessor-replay-resume"));
        await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration(
            rsid: successor,
            localSessionKey: sharedLocalSessionKey,
            resumeToken: "successor-replay-resume"));

        RbpInvocationIdentity completed = MutationIdentity(
            successor, "0197a3c2-0000-7000-8000-0000000000d1");
        Assert.Equal(RbpInvocationAdmission.Accepted,
            (await store.AdmitInvocationAsync(completed)).Admission);
        await store.MarkInvocationExecutingAsync(completed.IdempotencyKey);
        const string completedJson = "{\"ok\":true}";
        await store.PersistInvocationTerminalAsync(completed.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed,
                Json(completedJson), Rfc8785Json.Sha256Digest(Json(completedJson))));
        RbpStoredInvocation beforeReplay = Assert.IsType<RbpStoredInvocation>(
            await store.GetInvocationAsync(completed.IdempotencyKey));

        RbpInvocationIdentity origin = MutationIdentity(
            predecessor, "0197a3c2-0000-7000-8000-0000000000d2");
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        Assert.Equal(RbpInvocationAdmission.RefuseIndeterminate,
            (await store.AdmitInvocationAsync(origin)).Admission);

        RbpInvocationAdmissionResult replay = await store.AdmitInvocationAsync(completed);
        Assert.Equal(RbpInvocationAdmission.ReplayTerminal, replay.Admission);
        Assert.Equal(beforeReplay, replay.Stored);

        RbpInvocationIdentity fresh = MutationIdentity(
            successor, "0197a3c2-0000-7000-8000-0000000000d3");
        RbpJournalException denied = await Assert.ThrowsAsync<RbpJournalException>(
            () => store.AdmitInvocationAsync(fresh));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, denied.ErrorCode);
        Assert.Contains("legacy_outcome_unverified", denied.Message,
            StringComparison.Ordinal);
        Assert.Null(await store.GetInvocationAsync(fresh.IdempotencyKey));
    }

    [Theory]
    [InlineData(10_000, false)]
    [InlineData(10_001, true)]
    public async Task LegacyInvocationRowBoundIsExactAndOverflowIsAtomic(
        int historicalRows,
        bool expectOverflow)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        await SeedReceivedReadInvocationsAsync(directory.JournalPath, Rsid,
            historicalRows);
        (long Rows, long Received, long Executing, long Bytes) before =
            await InvocationSnapshotAsync(store, Rsid);

        RbpInvocationIdentity incoming = FreshMutationIdentity(100_001);
        if (!expectOverflow)
        {
            RbpInvocationAdmissionResult accepted =
                await store.AdmitInvocationAsync(incoming);
            Assert.Equal(RbpInvocationAdmission.Accepted, accepted.Admission);
            Assert.Equal(0, await HoldCount(store));
            Assert.Equal(before.Rows + 1,
                (await InvocationSnapshotAsync(store, Rsid)).Rows);
            return;
        }

        RbpJournalException denied = await Assert.ThrowsAsync<RbpJournalException>(
            () => store.AdmitInvocationAsync(incoming));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, denied.ErrorCode);
        Assert.Contains("legacy_inventory_limit", denied.Message,
            StringComparison.Ordinal);
        Assert.Equal(before, await InvocationSnapshotAsync(store, Rsid));
        Assert.Equal(0, await HoldCount(store));
        Assert.Null(await store.GetInvocationAsync(incoming.IdempotencyKey));
    }

    [Theory]
    [InlineData(1_024, false)]
    [InlineData(1_025, true)]
    public async Task LegacyReferencedBatchBoundIsExactAndOverflowIsAtomic(
        int historicalBatches,
        bool expectOverflow)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        await SeedReceivedReadBatchesAsync(directory.JournalPath, historicalBatches);
        (long Rows, long Bytes) beforeBatches = await BatchSnapshotAsync(store, Rsid);
        (long Rows, long Received, long Executing, long Bytes) beforeInvocations =
            await InvocationSnapshotAsync(store, Rsid);

        RbpInvocationIdentity incoming = FreshMutationIdentity(200_001);
        if (!expectOverflow)
        {
            Assert.Equal(RbpInvocationAdmission.Accepted,
                (await store.AdmitInvocationAsync(incoming)).Admission);
            Assert.Equal(beforeBatches, await BatchSnapshotAsync(store, Rsid));
            Assert.Equal(beforeInvocations.Rows + 1,
                (await InvocationSnapshotAsync(store, Rsid)).Rows);
            Assert.Equal(0, await HoldCount(store));
            return;
        }

        RbpJournalException denied = await Assert.ThrowsAsync<RbpJournalException>(
            () => store.AdmitInvocationAsync(incoming));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, denied.ErrorCode);
        Assert.Contains("legacy_inventory_limit", denied.Message,
            StringComparison.Ordinal);
        Assert.Equal(beforeBatches, await BatchSnapshotAsync(store, Rsid));
        Assert.Equal(beforeInvocations, await InvocationSnapshotAsync(store, Rsid));
        Assert.Equal(0, await HoldCount(store));
        Assert.Null(await store.GetInvocationAsync(incoming.IdempotencyKey));
    }

    [Theory]
    [InlineData(10_000, 10_000, false)]
    [InlineData(10_001, 10_000, true)]
    public async Task LegacyOrderedStepReferenceBoundIsExactAndOverflowIsAtomic(
        int storedStepReferences,
        int materializedStepRows,
        bool expectOverflow)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        await SeedReceivedReadBatchWithStepsAsync(directory.JournalPath,
            storedStepReferences, materializedStepRows);
        (long Rows, long Bytes) beforeBatches = await BatchSnapshotAsync(store, Rsid);
        (long Rows, long Received, long Executing, long Bytes) beforeInvocations =
            await InvocationSnapshotAsync(store, Rsid);

        RbpInvocationIdentity incoming = FreshMutationIdentity(300_001);
        if (!expectOverflow)
        {
            Assert.Equal(RbpInvocationAdmission.Accepted,
                (await store.AdmitInvocationAsync(incoming)).Admission);
            Assert.Equal(beforeBatches, await BatchSnapshotAsync(store, Rsid));
            Assert.Equal(beforeInvocations.Rows + 1,
                (await InvocationSnapshotAsync(store, Rsid)).Rows);
            Assert.Equal(0, await HoldCount(store));
            return;
        }

        // The 10,001st persisted ordered reference is deliberately left
        // unmaterialized: the classifier must reject its count before it can
        // read or normalize any possibly partial batch-member inventory.
        RbpJournalException denied = await Assert.ThrowsAsync<RbpJournalException>(
            () => store.AdmitInvocationAsync(incoming));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, denied.ErrorCode);
        Assert.Contains("legacy_inventory_limit", denied.Message,
            StringComparison.Ordinal);
        Assert.Equal(beforeBatches, await BatchSnapshotAsync(store, Rsid));
        Assert.Equal(beforeInvocations, await InvocationSnapshotAsync(store, Rsid));
        Assert.Equal(0, await HoldCount(store));
        Assert.Null(await store.GetInvocationAsync(incoming.IdempotencyKey));
    }

    [Theory]
    [InlineData(0L, false)]
    [InlineData(1L, true)]
    public async Task LegacyInspectedCanonicalJsonBoundIsExactAndOverflowIsAtomic(
        long bytesOverLimit,
        bool expectOverflow)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        await SeedExactInspectedJsonBudgetAsync(store, directory.JournalPath,
            bytesOverLimit);
        const long maxBytes = 32L * 1024 * 1024;
        Assert.Equal(maxBytes + bytesOverLimit,
            await InspectedJsonBytesAsync(store, Rsid));
        (long Rows, long Received, long Executing, long Bytes) before =
            await InvocationSnapshotAsync(store, Rsid);

        RbpInvocationIdentity incoming = FreshMutationIdentity(400_001);
        if (!expectOverflow)
        {
            Assert.Equal(RbpInvocationAdmission.Accepted,
                (await store.AdmitInvocationAsync(incoming)).Admission);
            Assert.Equal(0, await HoldCount(store));
            Assert.Equal(before.Rows + 1,
                (await InvocationSnapshotAsync(store, Rsid)).Rows);
            return;
        }

        RbpJournalException denied = await Assert.ThrowsAsync<RbpJournalException>(
            () => store.AdmitInvocationAsync(incoming));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, denied.ErrorCode);
        Assert.Contains("legacy_inventory_limit", denied.Message,
            StringComparison.Ordinal);
        Assert.Equal(before, await InvocationSnapshotAsync(store, Rsid));
        Assert.Equal(0, await HoldCount(store));
        Assert.Null(await store.GetInvocationAsync(incoming.IdempotencyKey));
    }

    [Theory]
    [InlineData(128, false)]
    [InlineData(129, true)]
    public async Task LegacyNewHoldPlanBoundIsExactAndOverflowIsAtomic(
        int unsafeOrigins,
        bool expectOverflow)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        await SeedExecutingMutationOriginsAsync(directory.JournalPath, Rsid,
            unsafeOrigins);
        (long Rows, long Received, long Executing, long Bytes) before =
            await InvocationSnapshotAsync(store, Rsid);
        RbpInvocationIdentity incoming = FreshMutationIdentity(500_001);

        if (!expectOverflow)
        {
            Assert.Equal(RbpInvocationAdmission.Accepted,
                (await store.AdmitInvocationAsync(incoming)).Admission);
            Assert.Equal(unsafeOrigins, await HoldCount(store));
            (long Rows, long Received, long Executing, long Bytes) after =
                await InvocationSnapshotAsync(store, Rsid);
            Assert.Equal(before.Rows + 1, after.Rows);
            Assert.Equal(before.Executing, after.Executing);
            return;
        }

        RbpJournalException denied = await Assert.ThrowsAsync<RbpJournalException>(
            () => store.AdmitInvocationAsync(incoming));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, denied.ErrorCode);
        Assert.Contains("legacy_inventory_limit", denied.Message,
            StringComparison.Ordinal);
        Assert.Equal(before, await InvocationSnapshotAsync(store, Rsid));
        Assert.Equal(0, await HoldCount(store));
        Assert.Null(await store.GetInvocationAsync(incoming.IdempotencyKey));
    }

    private static RbpInvocationIdentity MutationIdentity(
        string rsid,
        string invocationId) =>
        new(
            rsid,
            invocationId,
            "create_wall",
            Mutating: true,
            MutationScopeJcs: """{"document_id":"doc-1","kind":"document"}""",
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");

    private static RbpInvocationIdentity FreshMutationIdentity(int ordinal) =>
        MutationIdentity(Rsid, UuidV7(ordinal));

    private static string UuidV7(int ordinal) =>
        $"0197a3c2-0000-7000-8000-{ordinal:x12}";

    private static async Task SeedReceivedReadInvocationsAsync(
        string journalPath,
        string rsid,
        int count)
    {
        await using var connection = OpenFixtureConnection(journalPath);
        await using SqliteTransaction transaction =
            (SqliteTransaction)await connection.BeginTransactionAsync();
        await using SqliteCommand insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = """
            WITH RECURSIVE sequence(value) AS (
              VALUES(0)
              UNION ALL SELECT value + 1 FROM sequence WHERE value + 1 < $count
            )
            INSERT INTO rbp_invocations(
              idempotency_key,rsid,invocation_id,batch_id,batch_index,
              method,mutating,mutation_scope_jcs,params_digest,policy_jcs,
              recovery_clearances_jcs,state,created_at_ms)
            SELECT
              $rsid || '/' || printf('0197a3c2-0000-7000-8000-%012x',value),
              $rsid,printf('0197a3c2-0000-7000-8000-%012x',value),NULL,NULL,
              'get_current_view_info',0,NULL,$digest,'{"decision":"allow"}',
              '[]','received',$now
            FROM sequence;
            """;
        insert.Parameters.AddWithValue("$count", count);
        insert.Parameters.AddWithValue("$rsid", rsid);
        insert.Parameters.AddWithValue("$digest", Digest);
        insert.Parameters.AddWithValue("$now", RbpJournalTestData.Now.ToUnixTimeMilliseconds());
        Assert.Equal(count, await insert.ExecuteNonQueryAsync());
        await transaction.CommitAsync();
    }

    private static async Task SeedReceivedReadBatchesAsync(
        string journalPath,
        int count)
    {
        await using var connection = OpenFixtureConnection(journalPath);
        await using SqliteTransaction transaction =
            (SqliteTransaction)await connection.BeginTransactionAsync();
        await using SqliteCommand invocation = CreateReceivedInvocationInsert(
            connection, transaction);
        await using SqliteCommand batch = CreateReceivedBatchInsert(connection,
            transaction);
        for (int index = 0; index < count; index++)
        {
            RbpBatchIdentity identity = RbpBatchRequest.Parse(Rsid, Payload(
                UuidV7(20_000 + index), false,
                [Read(UuidV7(index))])).ToIdentity();
            InsertReceivedInvocation(invocation, new RbpInvocationIdentity(
                identity.Rsid, identity.Steps[0].InvocationId,
                identity.Steps[0].Method, false, null,
                identity.Steps[0].ParamsDigest,
                BatchStepPolicyJcs(identity.Steps[0]), "[]",
                identity.BatchId, 0));
            InsertReceivedBatch(batch, identity, StoredStepsJcs(identity.Steps));
        }
        await transaction.CommitAsync();
    }

    private static async Task SeedReceivedReadBatchWithStepsAsync(
        string journalPath,
        int storedStepReferences,
        int materializedStepRows)
    {
        BatchStepSpec[] specifications = Enumerable.Range(0, storedStepReferences)
            .Select(index => Read(UuidV7(index))).ToArray();
        RbpBatchIdentity identity = RbpBatchRequest.Parse(Rsid, Payload(
            UuidV7(40_000), false, specifications)).ToIdentity();
        await using var connection = OpenFixtureConnection(journalPath);
        await using SqliteTransaction transaction =
            (SqliteTransaction)await connection.BeginTransactionAsync();
        await using SqliteCommand invocation = CreateReceivedInvocationInsert(
            connection, transaction);
        await using SqliteCommand batch = CreateReceivedBatchInsert(connection,
            transaction);
        for (int index = 0; index < materializedStepRows; index++)
        {
            RbpBatchStepIdentity step = identity.Steps[index];
            InsertReceivedInvocation(invocation, new RbpInvocationIdentity(
                identity.Rsid, step.InvocationId, step.Method, false, null,
                step.ParamsDigest, BatchStepPolicyJcs(step), "[]",
                identity.BatchId, index));
        }
        InsertReceivedBatch(batch, identity, StoredStepsJcs(identity.Steps));
        await transaction.CommitAsync();
    }

    private static async Task SeedExecutingMutationOriginsAsync(
        string journalPath,
        string rsid,
        int count)
    {
        await using var connection = OpenFixtureConnection(journalPath);
        await using SqliteTransaction transaction =
            (SqliteTransaction)await connection.BeginTransactionAsync();
        await using SqliteCommand insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = """
            WITH RECURSIVE sequence(value) AS (
              VALUES(0)
              UNION ALL SELECT value + 1 FROM sequence WHERE value + 1 < $count
            )
            INSERT INTO rbp_invocations(
              idempotency_key,rsid,invocation_id,batch_id,batch_index,
              method,mutating,mutation_scope_jcs,params_digest,policy_jcs,
              recovery_clearances_jcs,state,created_at_ms,started_at_ms)
            SELECT
              $rsid || '/' || printf('0197a3c2-0000-7000-8000-%012x',value),
              $rsid,printf('0197a3c2-0000-7000-8000-%012x',value),NULL,NULL,
              'create_wall',1,
              '{"document_id":"legacy-' || printf('%04d',value) || '","kind":"document"}',
              $digest,'{"decision":"allow"}','[]','executing',$now,$now
            FROM sequence;
            """;
        insert.Parameters.AddWithValue("$count", count);
        insert.Parameters.AddWithValue("$rsid", rsid);
        insert.Parameters.AddWithValue("$digest", Digest);
        insert.Parameters.AddWithValue("$now", RbpJournalTestData.Now.ToUnixTimeMilliseconds());
        Assert.Equal(count, await insert.ExecuteNonQueryAsync());
        await transaction.CommitAsync();
    }

    private static async Task SeedExactInspectedJsonBudgetAsync(
        RbpJournalStore store,
        string journalPath,
        long bytesOverLimit)
    {
        const long maximum = 32L * 1024 * 1024;
        await SeedReceivedReadInvocationsAsync(journalPath, Rsid, 1);
        await using var connection = OpenFixtureConnection(journalPath);
        await using SqliteCommand initial = connection.CreateCommand();
        initial.CommandText = """
            UPDATE rbp_invocations
            SET policy_jcs='{"decision":"allow","padding":""}'
            WHERE idempotency_key=$key;
            """;
        initial.Parameters.AddWithValue("$key", Rsid + "/" + UuidV7(0));
        Assert.Equal(1, await initial.ExecuteNonQueryAsync());
        long baseline = await InspectedJsonBytesAsync(store, Rsid);
        int paddingLength = checked((int)(maximum + bytesOverLimit - baseline));
        Assert.True(paddingLength >= 0);
        string canonicalPolicy = "{\"decision\":\"allow\",\"padding\":\"" +
            new string('x', paddingLength) + "\"}";
        await using SqliteCommand update = connection.CreateCommand();
        update.CommandText = "UPDATE rbp_invocations SET policy_jcs=$policy WHERE idempotency_key=$key;";
        update.Parameters.AddWithValue("$policy", canonicalPolicy);
        update.Parameters.AddWithValue("$key", Rsid + "/" + UuidV7(0));
        Assert.Equal(1, await update.ExecuteNonQueryAsync());
    }

    private static SqliteConnection OpenFixtureConnection(string journalPath)
    {
        var connection = new SqliteConnection($"Data Source={journalPath};Pooling=False");
        connection.Open();
        return connection;
    }

    private static SqliteCommand CreateReceivedInvocationInsert(
        SqliteConnection connection,
        SqliteTransaction transaction)
    {
        SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO rbp_invocations(
              idempotency_key,rsid,invocation_id,batch_id,batch_index,
              method,mutating,mutation_scope_jcs,params_digest,policy_jcs,
              recovery_clearances_jcs,state,created_at_ms)
            VALUES(
              $key,$rsid,$invocation,$batch,$index,$method,$mutating,$scope,
              $digest,$policy,$clearances,'received',$now);
            """;
        command.Parameters.Add("$key", SqliteType.Text);
        command.Parameters.Add("$rsid", SqliteType.Text);
        command.Parameters.Add("$invocation", SqliteType.Text);
        command.Parameters.Add("$batch", SqliteType.Text);
        command.Parameters.Add("$index", SqliteType.Integer);
        command.Parameters.Add("$method", SqliteType.Text);
        command.Parameters.Add("$mutating", SqliteType.Integer);
        command.Parameters.Add("$scope", SqliteType.Text);
        command.Parameters.Add("$digest", SqliteType.Text);
        command.Parameters.Add("$policy", SqliteType.Text);
        command.Parameters.Add("$clearances", SqliteType.Text);
        command.Parameters.Add("$now", SqliteType.Integer);
        command.Prepare();
        return command;
    }

    private static SqliteCommand CreateReceivedBatchInsert(
        SqliteConnection connection,
        SqliteTransaction transaction)
    {
        SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO rbp_batches(
              batch_key,rsid,batch_id,batch_digest,atomic,timeout_ms,
              recovery_clearances_jcs,steps_jcs,step_count,state,created_at_ms)
            VALUES(
              $key,$rsid,$batch,$digest,$atomic,$timeout,$clearances,$steps,
              $count,'received',$now);
            """;
        command.Parameters.Add("$key", SqliteType.Text);
        command.Parameters.Add("$rsid", SqliteType.Text);
        command.Parameters.Add("$batch", SqliteType.Text);
        command.Parameters.Add("$digest", SqliteType.Text);
        command.Parameters.Add("$atomic", SqliteType.Integer);
        command.Parameters.Add("$timeout", SqliteType.Integer);
        command.Parameters.Add("$clearances", SqliteType.Text);
        command.Parameters.Add("$steps", SqliteType.Text);
        command.Parameters.Add("$count", SqliteType.Integer);
        command.Parameters.Add("$now", SqliteType.Integer);
        command.Prepare();
        return command;
    }

    private static void InsertReceivedInvocation(
        SqliteCommand command,
        RbpInvocationIdentity identity)
    {
        command.Parameters["$key"].Value = identity.IdempotencyKey;
        command.Parameters["$rsid"].Value = identity.Rsid;
        command.Parameters["$invocation"].Value = identity.InvocationId;
        command.Parameters["$batch"].Value = (object?)identity.BatchId ?? DBNull.Value;
        command.Parameters["$index"].Value = (object?)identity.BatchIndex ?? DBNull.Value;
        command.Parameters["$method"].Value = identity.Method;
        command.Parameters["$mutating"].Value = identity.Mutating ? 1 : 0;
        command.Parameters["$scope"].Value = (object?)identity.MutationScopeJcs ?? DBNull.Value;
        command.Parameters["$digest"].Value = identity.ParamsDigest;
        command.Parameters["$policy"].Value = identity.PolicyJcs;
        command.Parameters["$clearances"].Value = identity.RecoveryClearancesJcs;
        command.Parameters["$now"].Value = RbpJournalTestData.Now.ToUnixTimeMilliseconds();
        Assert.Equal(1, command.ExecuteNonQuery());
    }

    private static void InsertReceivedBatch(
        SqliteCommand command,
        RbpBatchIdentity identity,
        string stepsJcs)
    {
        command.Parameters["$key"].Value = identity.BatchKey;
        command.Parameters["$rsid"].Value = identity.Rsid;
        command.Parameters["$batch"].Value = identity.BatchId;
        command.Parameters["$digest"].Value = identity.BatchDigest;
        command.Parameters["$atomic"].Value = identity.Atomic ? 1 : 0;
        command.Parameters["$timeout"].Value = identity.TimeoutMilliseconds;
        command.Parameters["$clearances"].Value = identity.RecoveryClearancesJcs;
        command.Parameters["$steps"].Value = stepsJcs;
        command.Parameters["$count"].Value = identity.Steps.Count;
        command.Parameters["$now"].Value = RbpJournalTestData.Now.ToUnixTimeMilliseconds();
        Assert.Equal(1, command.ExecuteNonQuery());
    }

    private static string StoredStepsJcs(IReadOnlyList<RbpBatchStepIdentity> steps)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            foreach (RbpBatchStepIdentity step in steps)
            {
                writer.WriteStartObject();
                writer.WriteString("invocation_id", step.InvocationId);
                writer.WriteString("method", step.Method);
                writer.WriteBoolean("mutating", step.Mutating);
                writer.WritePropertyName("mutation_scope");
                if (step.MutationScopeJcs is null) writer.WriteNullValue();
                else Json(step.MutationScopeJcs).WriteTo(writer);
                writer.WriteString("params_digest", step.ParamsDigest);
                writer.WritePropertyName("policy");
                writer.WriteStartObject();
                writer.WriteString("class", step.PolicyClass);
                if (step.ConfirmationId is null) writer.WriteNull("confirmation_id");
                else writer.WriteString("confirmation_id", step.ConfirmationId);
                writer.WriteString("decision", step.Decision);
                writer.WriteEndObject();
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        using JsonDocument document = JsonDocument.Parse(buffer.ToArray());
        return Rfc8785Json.Canonicalize(document.RootElement);
    }

    private static string BatchStepPolicyJcs(RbpBatchStepIdentity step) =>
        "{\"class\":\"" + step.PolicyClass + "\",\"confirmation_id\":" +
        (step.ConfirmationId is null ? "null" : "\"" + step.ConfirmationId + "\"") +
        ",\"decision\":\"" + step.Decision + "\"}";

    private static Task<(long Rows, long Received, long Executing, long Bytes)>
        InvocationSnapshotAsync(RbpJournalStore store, string rsid) =>
        store.ReadAsync(connection =>
        {
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = """
                SELECT COUNT(*),
                  COALESCE(SUM(state='received'),0),
                  COALESCE(SUM(state='executing'),0),
                  COALESCE(SUM(length(CAST(policy_jcs AS BLOB))),0)
                FROM rbp_invocations WHERE rsid=$rsid;
                """;
            command.Parameters.AddWithValue("$rsid", rsid);
            using SqliteDataReader reader = command.ExecuteReader();
            Assert.True(reader.Read());
            return (reader.GetInt64(0), reader.GetInt64(1), reader.GetInt64(2),
                reader.GetInt64(3));
        });

    private static Task<(long Rows, long Bytes)> BatchSnapshotAsync(
        RbpJournalStore store,
        string rsid) => store.ReadAsync(connection =>
        {
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = """
                SELECT COUNT(*),COALESCE(SUM(length(CAST(steps_jcs AS BLOB))),0)
                FROM rbp_batches WHERE rsid=$rsid;
                """;
            command.Parameters.AddWithValue("$rsid", rsid);
            using SqliteDataReader reader = command.ExecuteReader();
            Assert.True(reader.Read());
            return (reader.GetInt64(0), reader.GetInt64(1));
        });

    private static Task<long> InspectedJsonBytesAsync(
        RbpJournalStore store,
        string rsid) => store.ReadAsync(connection =>
        {
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = """
                SELECT COALESCE(SUM(
                  length(CAST(COALESCE(terminal_outcome_json,'') AS BLOB))+
                  length(CAST(COALESCE(late_terminal_outcome_json,'') AS BLOB))+
                  length(CAST(policy_jcs AS BLOB))+
                  length(CAST(recovery_clearances_jcs AS BLOB))+
                  length(CAST(COALESCE(mutation_scope_jcs,'') AS BLOB))+
                  length(CAST(COALESCE(verification_correlation_json,'') AS BLOB))),0)
                FROM rbp_invocations WHERE rsid=$rsid;
                """;
            command.Parameters.AddWithValue("$rsid", rsid);
            long invocationBytes = Convert.ToInt64(command.ExecuteScalar());
            command.CommandText = """
                SELECT COALESCE(SUM(
                  length(CAST(steps_jcs AS BLOB))+
                  length(CAST(recovery_clearances_jcs AS BLOB))+
                  length(CAST(COALESCE(terminal_outcome_json,'') AS BLOB))),0)
                FROM rbp_batches WHERE rsid=$rsid;
                """;
            long batchBytes = Convert.ToInt64(command.ExecuteScalar());
            command.CommandText = """
                SELECT COALESCE(SUM(
                  length(CAST(scope_jcs AS BLOB))+
                  length(CAST(ordered_origin_idempotency_keys_json AS BLOB))+
                  length(CAST(COALESCE(evidence_digest,'') AS BLOB))+
                  length(CAST(COALESCE(resolution_id,'') AS BLOB))+
                  length(CAST(COALESCE(resolution_basis,'') AS BLOB))+
                  length(CAST(COALESCE(resolution_decision,'') AS BLOB))+
                  length(CAST(COALESCE(audit_id,'') AS BLOB))),0)
                FROM rbp_verification_holds WHERE rsid=$rsid;
                """;
            long holdBytes = Convert.ToInt64(command.ExecuteScalar());
            command.CommandText = """
                SELECT COALESCE(SUM(
                  length(CAST(local_session_key AS BLOB))+
                  length(CAST(registration_json AS BLOB))+
                  length(CAST(registration_digest AS BLOB))+
                  length(CAST(granted_capabilities_json AS BLOB))),0)
                FROM rbp_sessions WHERE rsid=$rsid;
                """;
            long sessionBytes = Convert.ToInt64(command.ExecuteScalar());
            return checked(invocationBytes + batchBytes + holdBytes + sessionBytes);
        });

    private const string Digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    private static Task<long> HoldCount(RbpJournalStore store) => store.ReadAsync(connection =>
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM rbp_verification_holds;";
        return (long)command.ExecuteScalar()!;
    });

    private sealed class TamperAfterCommit(string path) : IRbpJournalFaultInjector
    {
        internal bool Armed;
        internal int Calls;
        public void Hit(RbpJournalFaultPoint point)
        {
            if (!Armed || point != RbpJournalFaultPoint.AfterCommitBeforeReturn) return;
            Armed = false; Calls++;
            using var connection = new SqliteConnection($"Data Source={path};Pooling=False");
            connection.Open();
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = "UPDATE rbp_invocations SET terminal_outcome_json='{}' WHERE state='indeterminate';";
            command.ExecuteNonQuery();
            throw new IOException("Injected altered post-commit snapshot.");
        }
    }
}

/// <summary>
/// Test-only route through the production dispatcher that produces the one
/// durable verification candidate a clearance may consume.  It deliberately
/// does not write a hold or its evidence directly: the journal only records
/// evidence after it has durably observed an eligible correlated read result.
/// </summary>
internal static class RbpJournalStoreProductionEvidence
{
    internal static async Task<RbpHoldVerificationEvidence>
        ProduceEligibleCorrelatedReadAsync(
            RbpJournalStore store,
            RbpApplicationErrorSafetyTests.RoutedFixture fixture,
            string holdId,
            string scopeJcs,
            string verificationInvocationId)
    {
        fixture.Transport.SetResponse("""{"success":true}""", null);
        var dispatcher = new RbpInvocationDispatcher(
            store,
            fixture.Channel,
            new RbpInFlightGate());
        RbpInvocationAnswer answer = await
            RbpCorrelatedVerificationFlowTests.DispatchVerificationAsync(
            dispatcher,
            fixture,
            VerificationReadRequest(
                holdId,
                scopeJcs,
                verificationInvocationId));

        Assert.Equal("result", answer.Type);
        RbpVerificationHold hold = Assert.IsType<RbpVerificationHold>(
            await store.GetHoldAsync("rs-test", holdId));
        Assert.Equal(RbpHoldState.EvidenceRecorded, hold.State);
        Assert.Equal(verificationInvocationId, hold.VerificationInvocationId);
        Assert.NotNull(hold.EvidenceDigest);
        return new RbpHoldVerificationEvidence(
            holdId,
            hold.VerificationInvocationId!,
            hold.EvidenceDigest!,
            Conclusive: true);
    }

    internal static async Task RegisterRoutedSessionAsync(
        RbpJournalStore store,
        RbpApplicationErrorSafetyTests.RoutedFixture fixture,
        int expiresInHours = 24)
    {
        await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                localSessionKey: fixture.Route.Handle!.LocalSessionKey,
                expiresInHours: expiresInHours));
        await BindInvocationAuthorityAsync(store, fixture);
    }

    internal static async Task BindInvocationAuthorityAsync(
        RbpJournalStore store,
        RbpApplicationErrorSafetyTests.RoutedFixture fixture)
    {
        await store.ActivateConnectionGenerationAsync(1);
        RbpStoredSession session = (await store.GetStoredSessionAsync(
            "rs-test"))!;
        fixture.InvocationAuthority = new RbpInvocationAuthoritySnapshot(
            "rs-test",
            "0197a3c2-0000-7000-8000-0000000000e2",
            1,
            1,
            RbpInvocationAuthoritySnapshot.CapabilitiesDigest(
                Array.Empty<string>()),
            session.LocalSessionKey,
            session.RegistrationDigest,
            RbpInvocationAuthoritySnapshot.CapabilitiesDigest(
                session.GrantedCapabilities));
    }

    private static RbpInvokeRequest VerificationReadRequest(
        string holdId,
        string scopeJcs,
        string verificationInvocationId)
    {
        string payload =
            $$"""
            {
              "invocation_id": "{{verificationInvocationId}}",
              "method": "get_element_parameter",
              "params": {"element_id":42},
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
