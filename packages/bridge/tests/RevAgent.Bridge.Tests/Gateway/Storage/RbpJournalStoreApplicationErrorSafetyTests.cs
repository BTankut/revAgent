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
