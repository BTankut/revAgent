using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

/// <summary>
/// Frozen O1 Section 12 conformance for the invocation journal: the durability
/// ordering in 12.1 and every redelivery rule in 12.2.
/// </summary>
public sealed class RbpInvocationJournalTests
{
    private const string ReadMethod = "get_current_view_info";
    private const string WriteMethod = "create_wall";

    [Fact]
    public async Task FirstDeliveryPersistsReceivedBeforeDispatch()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());

        RbpInvocationAdmissionResult admitted =
            await store.AdmitInvocationAsync(ReadIdentity());

        Assert.Equal(RbpInvocationAdmission.Accepted, admitted.Admission);
        Assert.Equal(RbpInvocationState.Received, admitted.Stored.State);

        // Durability ordering step 1: the row and its digest are durable
        // before any add-in byte could have been written.
        RbpStoredInvocation? persisted =
            await store.GetInvocationAsync(ReadIdentity().IdempotencyKey);
        Assert.NotNull(persisted);
        Assert.Equal(RbpInvocationState.Received, persisted!.State);
        Assert.Equal(
            ReadIdentity().ParamsDigest,
            persisted.Identity.ParamsDigest);
    }

    [Fact]
    public async Task ExecutingIsOnlyReachableFromReceived()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity identity = ReadIdentity();
        _ = await store.AdmitInvocationAsync(identity);

        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        RbpStoredInvocation? executing =
            await store.GetInvocationAsync(identity.IdempotencyKey);
        Assert.Equal(RbpInvocationState.Executing, executing!.State);
        Assert.NotNull(executing.StartedAtMilliseconds);

        // A second ownership claim is refused; dispatch ownership is once-only.
        RbpJournalException repeated =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.MarkInvocationExecutingAsync(
                    identity.IdempotencyKey));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, repeated.ErrorCode);
    }

    [Fact]
    public async Task TerminalOutcomeIsDurableAndImmutable()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity identity = ReadIdentity();
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);

        _ = await store.PersistInvocationTerminalAsync(
            identity.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, """{"ok":true}"""));

        RbpStoredInvocation? stored =
            await store.GetInvocationAsync(identity.IdempotencyKey);
        Assert.Equal(RbpInvocationState.Completed, stored!.State);
        Assert.NotNull(stored.FinishedAtMilliseconds);

        RbpJournalException immutable =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.PersistInvocationTerminalAsync(
                    identity.IdempotencyKey,
                    Terminal(RbpInvocationState.Failed, """{"ok":false}""")));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, immutable.ErrorCode);
    }

    [Fact]
    public async Task Rule1KnownTerminalReplaysWithoutCallingTheAddin()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity identity = ReadIdentity();
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        _ = await store.PersistInvocationTerminalAsync(
            identity.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, """{"ok":true}"""));

        RbpInvocationAdmissionResult replay =
            await store.AdmitInvocationAsync(identity);

        Assert.Equal(
            RbpInvocationAdmission.ReplayTerminal,
            replay.Admission);
        Assert.Equal(RbpInvocationState.Completed, replay.Stored.State);
        Assert.Equal(
            """{"ok":true}""",
            replay.Stored.TerminalOutcomeJson);
    }

    [Fact]
    public async Task Rule3NonMutatingNonTerminalMayExecuteOnceMore()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity identity = ReadIdentity();
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);

        RbpInvocationAdmissionResult retry =
            await store.AdmitInvocationAsync(identity);

        Assert.Equal(
            RbpInvocationAdmission.RetryNonMutating,
            retry.Admission);
        Assert.Null(retry.VerificationHoldId);
    }

    [Fact]
    public async Task Rule4MutatingNonTerminalRefusesAndInstallsScopeHold()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity identity = WriteIdentity();
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);

        RbpInvocationAdmissionResult refused =
            await store.AdmitInvocationAsync(identity);

        Assert.Equal(
            RbpInvocationAdmission.RefuseIndeterminate,
            refused.Admission);
        Assert.Equal(
            RbpInvocationState.Indeterminate,
            refused.Stored.State);
        Assert.NotNull(refused.VerificationHoldId);
        Assert.StartsWith(
            "vh:",
            refused.VerificationHoldId,
            StringComparison.Ordinal);

        // The hold now blocks a later conflicting mutation on the same scope.
        RbpVerificationHold? conflict =
            await store.FindConflictingHoldAsync(
                "rs-test",
                identity.MutationScopeJcs!);
        Assert.NotNull(conflict);
        Assert.Equal(RbpHoldState.Active, conflict!.State);
        Assert.Equal(
            new[] { identity.IdempotencyKey },
            conflict.OrderedOriginIdempotencyKeys);
    }

    [Fact]
    public async Task Rule2LateTerminalReplaysAsEvidenceWithoutClearingHold()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity identity = WriteIdentity();
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        RbpInvocationAdmissionResult refused =
            await store.AdmitInvocationAsync(identity);
        string holdId = refused.VerificationHoldId!;

        // A real add-in outcome becomes durable after the indeterminate.
        _ = await store.PersistInvocationTerminalAsync(
            identity.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, """{"late":true}"""));

        RbpInvocationAdmissionResult replay =
            await store.AdmitInvocationAsync(identity);

        Assert.Equal(
            RbpInvocationAdmission.ReplayLateAfterIndeterminate,
            replay.Admission);
        // The row stays indeterminate; the late outcome is evidence only.
        Assert.Equal(RbpInvocationState.Indeterminate, replay.Stored.State);
        Assert.Equal(
            """{"late":true}""",
            replay.Stored.LateTerminalOutcomeJson);
        Assert.Equal(holdId, replay.VerificationHoldId);

        // The hold is NOT auto-cleared by late evidence.
        RbpVerificationHold? hold =
            await store.FindConflictingHoldAsync(
                "rs-test",
                identity.MutationScopeJcs!);
        Assert.NotNull(hold);
        Assert.NotEqual(RbpHoldState.Cleared, hold!.State);
    }

    [Theory]
    [InlineData("method")]
    [InlineData("params")]
    [InlineData("policy")]
    [InlineData("clearances")]
    [InlineData("scope")]
    [InlineData("batch")]
    public async Task Rule5IdentityDriftUnderTheSameKeyIsAProtocolFault(
        string drift)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity original = WriteIdentity();
        _ = await store.AdmitInvocationAsync(original);

        RbpInvocationIdentity mutated = drift switch
        {
            "method" => original with { Method = "delete_wall" },
            "params" => original with
            {
                ParamsDigest = "sha256:" + new string('b', 64),
            },
            "policy" => original with { PolicyJcs = """{"decision":"deny"}""" },
            "clearances" => original with
            {
                RecoveryClearancesJcs = """["vh:other"]""",
            },
            "scope" => original with
            {
                MutationScopeJcs =
                    """{"document_id":"doc-2","kind":"document"}""",
            },
            _ => original with { BatchId = NewUuid(), BatchIndex = 0 },
        };

        RbpJournalException fault =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AdmitInvocationAsync(mutated));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, fault.ErrorCode);
    }

    [Fact]
    public async Task ASessionScopeHoldConflictsWithEveryDocumentScope()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity sessionWide = WriteIdentity(
            scopeJcs: """{"kind":"session"}""");
        _ = await store.AdmitInvocationAsync(sessionWide);
        await store.MarkInvocationExecutingAsync(sessionWide.IdempotencyKey);
        _ = await store.AdmitInvocationAsync(sessionWide);

        RbpVerificationHold? conflict =
            await store.FindConflictingHoldAsync(
                "rs-test",
                """{"document_id":"doc-1","kind":"document"}""");

        Assert.NotNull(conflict);
        Assert.Equal("session", conflict!.ScopeKind);
    }

    [Fact]
    public async Task AdmissionSurvivesReopen()
    {
        using var directory = new RbpJournalTestDirectory();
        RbpInvocationIdentity identity = WriteIdentity();
        await using (RbpJournalStore store = OpenStore(directory))
        {
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration());
            _ = await store.AdmitInvocationAsync(identity);
            await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        }

        // A crash after dispatch but before terminal persistence must stay
        // `executing`, which is indeterminate by design.
        await using RbpJournalStore reopened = OpenStore(directory);
        RbpStoredInvocation? recovered =
            await reopened.GetInvocationAsync(identity.IdempotencyKey);
        Assert.Equal(RbpInvocationState.Executing, recovered!.State);

        RbpInvocationAdmissionResult refused =
            await reopened.AdmitInvocationAsync(identity);
        Assert.Equal(
            RbpInvocationAdmission.RefuseIndeterminate,
            refused.Admission);
    }

    [Fact]
    public async Task LegacyMutationStateMatrixImportsFailClosed()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity failed = WriteIdentity(
            "{\"document_id\":\"doc-1\",\"kind\":\"document\"}") with
        {
            InvocationId = "0197a3c2-0000-7000-8000-000000000401",
        };
        RbpInvocationIdentity executing = WriteIdentity(
            "{\"document_id\":\"doc-2\",\"kind\":\"document\"}") with
        {
            InvocationId = "0197a3c2-0000-7000-8000-000000000402",
        };
        RbpInvocationIdentity cancelled = WriteIdentity(
            "{\"document_id\":\"doc-3\",\"kind\":\"document\"}") with
        {
            InvocationId = "0197a3c2-0000-7000-8000-000000000403",
        };
        RbpInvocationIdentity completed = WriteIdentity() with
        {
            InvocationId = "0197a3c2-0000-7000-8000-000000000404",
        };
        RbpInvocationIdentity guarded = WriteIdentity() with
        {
            InvocationId = "0197a3c2-0000-7000-8000-000000000405",
        };
        foreach (RbpInvocationIdentity identity in
                 new[] { failed, executing, cancelled, completed, guarded })
        {
            _ = await store.AdmitInvocationAsync(identity);
            await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        }

        _ = await store.PersistInvocationTerminalAsync(
            failed.IdempotencyKey,
            Terminal(RbpInvocationState.Failed, """{"failed":true}"""));
        _ = await store.PersistInvocationTerminalAsync(
            cancelled.IdempotencyKey,
            Terminal(
                RbpInvocationState.Cancelled,
                """{"cancelled":true}"""));
        _ = await store.PersistInvocationTerminalAsync(
            completed.IdempotencyKey,
            Terminal(
                RbpInvocationState.Completed,
                """{"completed":true}"""));
        _ = await store.PersistInvocationTerminalAsync(
            guarded.IdempotencyKey,
            Terminal(RbpInvocationState.Guarded, """{"guarded":true}"""));

        _ = await store.EnsureOutcomeV3ForSessionAsync("rs-test");

        foreach (RbpInvocationIdentity uncertain in
                 new[] { failed, executing, cancelled })
        {
            RbpStoredInvocation row =
                (await store.GetInvocationAsync(uncertain.IdempotencyKey))!;
            Assert.Equal(RbpInvocationState.Indeterminate, row.State);
            Assert.NotNull(row.VerificationHoldId);
            Assert.NotNull(
                await store.GetHoldAsync(
                    "rs-test",
                    row.VerificationHoldId!));
        }

        Assert.Equal(
            RbpInvocationState.Completed,
            (await store.GetInvocationAsync(completed.IdempotencyKey))!.State);
        Assert.Equal(
            RbpInvocationState.Guarded,
            (await store.GetInvocationAsync(guarded.IdempotencyKey))!.State);
    }

    [Fact]
    public async Task PostMarkerV2DriftIsIgnoredAndV3MismatchBlocks()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity identity = WriteIdentity() with
        {
            InvocationId = "0197a3c2-0000-7000-8000-000000000406",
        };
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        _ = await store.EnsureOutcomeV3ForSessionAsync("rs-test");
        RbpStoredInvocation authoritative =
            (await store.GetInvocationAsync(identity.IdempotencyKey))!;
        Assert.Equal(RbpInvocationState.Indeterminate, authoritative.State);

        await store.ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand drift = context.CreateCommand(
                    """
                    UPDATE rbp_invocations
                    SET state='completed',terminal_outcome_json='{}',
                        result_digest=$digest,finished_at_ms=9999999999999
                    WHERE idempotency_key=$key;
                    """);
                drift.Parameters.AddWithValue(
                    "$digest",
                    "sha256:" + new string('d', 64));
                drift.Parameters.AddWithValue("$key", identity.IdempotencyKey);
                Assert.Equal(1, drift.ExecuteNonQuery());
                return true;
            });
        Assert.Equal(
            RbpInvocationState.Indeterminate,
            (await store.GetInvocationAsync(identity.IdempotencyKey))!.State);

        await store.ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand corrupt = context.CreateCommand(
                    """
                    UPDATE rbp_outcome_dispatch_v3 SET effect_state='rolled_back'
                    WHERE idempotency_key=$key;
                    """);
                corrupt.Parameters.AddWithValue("$key", identity.IdempotencyKey);
                Assert.Equal(1, corrupt.ExecuteNonQuery());
                return true;
            });
        RbpJournalException mismatch =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.GetInvocationAsync(identity.IdempotencyKey));
        Assert.Equal(
            RbpJournalErrorCode.IntegrityCheckFailed,
            mismatch.ErrorCode);
    }

    private static RbpJournalStore OpenStore(RbpJournalTestDirectory directory) =>
        RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());

    private static RbpInvocationTerminal Terminal(
        RbpInvocationState state,
        string outcomeJson)
    {
        using var document = JsonDocument.Parse(outcomeJson);
        return new RbpInvocationTerminal(
            state,
            document.RootElement.Clone(),
            "sha256:" + new string('c', 64));
    }

    private static RbpInvocationIdentity ReadIdentity() =>
        new(
            "rs-test",
            "0197a3c2-0000-7000-8000-0000000000a1",
            ReadMethod,
            Mutating: false,
            MutationScopeJcs: null,
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");

    private static RbpInvocationIdentity WriteIdentity(
        string scopeJcs = """{"document_id":"doc-1","kind":"document"}""") =>
        new(
            "rs-test",
            "0197a3c2-0000-7000-8000-0000000000b2",
            WriteMethod,
            Mutating: true,
            MutationScopeJcs: scopeJcs,
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");

    private static string NewUuid() =>
        "0197a3c2-0000-7000-8000-0000000000c3";
}
