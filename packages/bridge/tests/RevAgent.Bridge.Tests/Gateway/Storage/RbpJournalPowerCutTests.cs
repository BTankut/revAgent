using System.Diagnostics;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

/// <summary>
/// P3-T5 power-cut gate: the frozen O1 Section 12.1 durability ordering under
/// abrupt process death.
///
/// Every other durability suite in this repository ends its "crash" with an
/// orderly <c>await using</c> dispose, which runs
/// <c>PRAGMA wal_checkpoint(TRUNCATE)</c> and closes SQLite cleanly, so the
/// next open never performs write-ahead-log recovery. These tests instead run
/// the production journal inside a child process, freeze it at an exact
/// durability boundary, and terminate it with
/// <c>Process.Kill(entireProcessTree: true)</c>: no dispose, no close, no
/// rollback of the open transaction, no checkpoint, and a write-ahead log
/// still carrying frames. The parent then reopens through the production
/// <c>RbpJournalStore.Open</c> path and proves that the three mandatory
/// Section 12.1 facts survived, that nothing uncommitted survived, that
/// SQLite's own <c>PRAGMA integrity_check</c> reports <c>ok</c>, and that the
/// Section 12.2 redelivery rules arbitrate the recovered state correctly.
/// </summary>
public sealed class RbpJournalPowerCutTests
{
    private static readonly TimeSpan RecoveryOpenTimeout =
        TimeSpan.FromSeconds(5);

    private static readonly TimeSpan RecoveryOpenRetryDelay =
        TimeSpan.FromMilliseconds(25);

    /// <summary>
    /// Kill point (a). Section 12.1 step 1: <c>received</c> plus
    /// <c>params_digest</c> are durable on their own commit, before the first
    /// add-in byte. A power cut here must leave the invocations exactly
    /// <c>received</c> — never advanced to <c>executing</c>, never lost — and
    /// redelivery must arbitrate them, not admit them afresh.
    /// </summary>
    [Fact]
    public async Task KillAfterReceivedCommitKeepsReceivedDurableAndUndispatched()
    {
        using var directory = new RbpJournalTestDirectory();

        RbpJournalPowerCutReadiness readiness =
            await RbpJournalPowerCutProcess.KillAtAsync(
                RbpJournalPowerCutMode.ReceivedCommitted,
                directory.JournalPath);

        AssertKilledUnderProductionDurability(readiness);
        RbpJournalPowerCutFiles.AssertWalRecoveryPending(
            directory.JournalPath);

        await using (RbpJournalStore recovered =
                         await OpenRecoveredAsync(directory))
        {
            await AssertIntegrityCheckIsOkAsync(recovered);

            RbpStoredInvocation? read = await recovered.GetInvocationAsync(
                RbpJournalPowerCutData.ReadKey);
            RbpStoredInvocation? write = await recovered.GetInvocationAsync(
                RbpJournalPowerCutData.WriteKey);
            Assert.NotNull(read);
            Assert.NotNull(write);
            Assert.Equal(RbpInvocationState.Received, read!.State);
            Assert.Equal(RbpInvocationState.Received, write!.State);
            Assert.Equal(
                RbpJournalPowerCutData.ParamsDigest,
                write.Identity.ParamsDigest);
            Assert.Equal(
                RbpJournalPowerCutData.DocumentScopeJcs,
                write.Identity.MutationScopeJcs);

            // `executing` was never committed, so no dispatch ownership was
            // ever taken and no terminal evidence can exist.
            Assert.Null(read.StartedAtMilliseconds);
            Assert.Null(write.StartedAtMilliseconds);
            Assert.Null(write.FinishedAtMilliseconds);
            Assert.Null(write.TerminalOutcomeJson);
            Assert.Null(write.VerificationHoldId);
            Assert.Null(
                await recovered.FindConflictingHoldAsync(
                    RbpJournalPowerCutData.Rsid,
                    RbpJournalPowerCutData.DocumentScopeJcs));

            // Section 12.2 rule 3 on the recovered read.
            RbpInvocationAdmissionResult retried =
                await recovered.AdmitInvocationAsync(
                    RbpJournalPowerCutData.ReadIdentity());
            Assert.Equal(
                RbpInvocationAdmission.RetryNonMutating,
                retried.Admission);
            Assert.Null(retried.VerificationHoldId);

            // Section 12.2 rule 4 on the recovered mutation: a durable
            // `received` row is still a possibly dispatched mutation, so it is
            // refused with a scope hold rather than admitted afresh.
            RbpInvocationAdmissionResult refused =
                await recovered.AdmitInvocationAsync(
                    RbpJournalPowerCutData.WriteIdentity());
            Assert.Equal(
                RbpInvocationAdmission.RefuseIndeterminate,
                refused.Admission);
            Assert.Equal(
                RbpInvocationState.Indeterminate,
                refused.Stored.State);
            Assert.StartsWith(
                "vh:",
                refused.VerificationHoldId,
                StringComparison.Ordinal);
        }

        RbpJournalPowerCutFiles.AssertRecoveredFileSetIsSane(
            directory.JournalPath);
    }

    /// <summary>
    /// Kill point (b). Section 12.1 step 2: <c>executing</c> is durable before
    /// dispatch ownership, and a crash after add-in completion but before
    /// terminal persistence deliberately leaves <c>executing</c>. That is the
    /// <c>journal_indeterminate</c> case: the recovered row must arbitrate as
    /// Section 12.2 rule 4 with a durable Section 6.2.1 hold, never as a fresh
    /// admission and never as a retry.
    /// </summary>
    [Fact]
    public async Task KillAfterExecutingCommitRecoversAsRule4JournalIndeterminate()
    {
        using var directory = new RbpJournalTestDirectory();

        RbpJournalPowerCutReadiness readiness =
            await RbpJournalPowerCutProcess.KillAtAsync(
                RbpJournalPowerCutMode.ExecutingCommitted,
                directory.JournalPath);

        AssertKilledUnderProductionDurability(readiness);
        RbpJournalPowerCutFiles.AssertWalRecoveryPending(
            directory.JournalPath);

        await using (RbpJournalStore recovered =
                         await OpenRecoveredAsync(directory))
        {
            await AssertIntegrityCheckIsOkAsync(recovered);

            RbpStoredInvocation? write = await recovered.GetInvocationAsync(
                RbpJournalPowerCutData.WriteKey);
            Assert.NotNull(write);
            Assert.Equal(RbpInvocationState.Executing, write!.State);
            Assert.NotNull(write.StartedAtMilliseconds);
            Assert.Null(write.FinishedAtMilliseconds);
            Assert.Null(write.TerminalOutcomeJson);
            Assert.Null(write.ResultDigest);
            Assert.Null(write.VerificationHoldId);
            Assert.Null(
                await recovered.FindConflictingHoldAsync(
                    RbpJournalPowerCutData.Rsid,
                    RbpJournalPowerCutData.DocumentScopeJcs));

            RbpInvocationAdmissionResult refused =
                await recovered.AdmitInvocationAsync(
                    RbpJournalPowerCutData.WriteIdentity());

            Assert.Equal(
                RbpInvocationAdmission.RefuseIndeterminate,
                refused.Admission);
            Assert.Equal(
                RbpInvocationState.Indeterminate,
                refused.Stored.State);
            Assert.NotNull(refused.VerificationHoldId);
            string holdId = refused.VerificationHoldId!;
            Assert.StartsWith("vh:", holdId, StringComparison.Ordinal);
            Assert.Contains(
                "\"outcome\":\"indeterminate\"",
                refused.Stored.TerminalOutcomeJson,
                StringComparison.Ordinal);
            Assert.Contains(
                holdId,
                refused.Stored.TerminalOutcomeJson,
                StringComparison.Ordinal);

            RbpVerificationHold? hold =
                await recovered.FindConflictingHoldAsync(
                    RbpJournalPowerCutData.Rsid,
                    RbpJournalPowerCutData.DocumentScopeJcs);
            Assert.NotNull(hold);
            Assert.Equal(holdId, hold!.VerificationHoldId);
            Assert.Equal(RbpHoldState.Active, hold.State);
            Assert.Equal(
                new[] { RbpJournalPowerCutData.WriteKey },
                hold.OrderedOriginIdempotencyKeys);
        }

        RbpJournalPowerCutFiles.AssertRecoveredFileSetIsSane(
            directory.JournalPath);
    }

    /// <summary>
    /// Kill point (c). The store's own write authority is
    /// <c>BEGIN IMMEDIATE</c> plus one commit. Killing the process between the
    /// two must leave no fragment of that transaction — no invocation row, no
    /// hold row — because Section 12.1 makes the durable <c>received</c> row
    /// the proof that an add-in byte may follow. Nothing durable therefore
    /// means nothing was dispatched, and the identity may still be admitted
    /// afresh.
    /// </summary>
    [Fact]
    public async Task KillInsideAnUncommittedAdmissionLeavesNoPartialRow()
    {
        using var directory = new RbpJournalTestDirectory();

        RbpJournalPowerCutReadiness readiness =
            await RbpJournalPowerCutProcess.KillAtAsync(
                RbpJournalPowerCutMode.MidInvocationTransaction,
                directory.JournalPath);

        AssertKilledUnderProductionDurability(readiness);
        RbpJournalPowerCutFiles.AssertWalRecoveryPending(
            directory.JournalPath);

        await using (RbpJournalStore recovered =
                         await OpenRecoveredAsync(directory))
        {
            await AssertIntegrityCheckIsOkAsync(recovered);

            // Everything committed before the kill is intact.
            RbpStoredInvocation? read = await recovered.GetInvocationAsync(
                RbpJournalPowerCutData.ReadKey);
            Assert.NotNull(read);
            Assert.Equal(RbpInvocationState.Received, read!.State);
            Assert.Equal(
                RbpJournalPowerCutData.ParamsDigest,
                read.Identity.ParamsDigest);

            // The interrupted transaction left nothing at all.
            Assert.Null(
                await recovered.GetInvocationAsync(
                    RbpJournalPowerCutData.WriteKey));
            Assert.Null(
                await recovered.FindConflictingHoldAsync(
                    RbpJournalPowerCutData.Rsid,
                    RbpJournalPowerCutData.DocumentScopeJcs));

            RbpInvocationAdmissionResult fresh =
                await recovered.AdmitInvocationAsync(
                    RbpJournalPowerCutData.WriteIdentity());

            Assert.Equal(
                RbpInvocationAdmission.Accepted,
                fresh.Admission);
            Assert.Equal(RbpInvocationState.Received, fresh.Stored.State);
            Assert.Null(fresh.VerificationHoldId);
        }

        RbpJournalPowerCutFiles.AssertRecoveredFileSetIsSane(
            directory.JournalPath);
    }

    /// <summary>
    /// Kill point (d). Spec ~1071-1075 binds the batch coordination row and
    /// the complete ordered step set in one transaction before any add-in
    /// byte. A power cut during that install must leave neither the
    /// coordination row nor any step row — a surviving prefix would be exactly
    /// the reconstruction from partial state the spec forbids — and the same
    /// batch must then admit cleanly.
    /// </summary>
    [Fact]
    public async Task KillInsideAnUncommittedBatchInstallLeavesNoCoordinationOrStepRow()
    {
        using var directory = new RbpJournalTestDirectory();

        RbpJournalPowerCutReadiness readiness =
            await RbpJournalPowerCutProcess.KillAtAsync(
                RbpJournalPowerCutMode.MidBatchTransaction,
                directory.JournalPath);

        AssertKilledUnderProductionDurability(readiness);
        RbpJournalPowerCutFiles.AssertWalRecoveryPending(
            directory.JournalPath);

        await using (RbpJournalStore recovered =
                         await OpenRecoveredAsync(directory))
        {
            await AssertIntegrityCheckIsOkAsync(recovered);

            RbpStoredInvocation? read = await recovered.GetInvocationAsync(
                RbpJournalPowerCutData.ReadKey);
            Assert.NotNull(read);
            Assert.Equal(RbpInvocationState.Received, read!.State);

            Assert.Null(
                await recovered.GetBatchAsync(
                    RbpJournalPowerCutData.BatchKey));
            Assert.Null(
                await recovered.GetInvocationAsync(
                    RbpBatchTestData.StepKey(
                        RbpJournalPowerCutData.BatchWriteStepId)));
            Assert.Null(
                await recovered.GetInvocationAsync(
                    RbpBatchTestData.StepKey(
                        RbpJournalPowerCutData.BatchReadStepId)));
            Assert.Null(
                await recovered.FindConflictingHoldAsync(
                    RbpJournalPowerCutData.Rsid,
                    RbpJournalPowerCutData.DocumentScopeJcs));

            RbpBatchIdentity batch = RbpJournalPowerCutData.BatchIdentity();
            RbpBatchGatedAdmission gated = await recovered.AdmitBatchAsync(
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

            RbpStoredBatch? stored = await recovered.GetBatchAsync(
                RbpJournalPowerCutData.BatchKey);
            Assert.NotNull(stored);
            Assert.Equal(batch.BatchDigest, stored!.BatchDigest);
            Assert.Equal(2, stored.StepCount);
            Assert.Equal(RbpBatchState.Received, stored.State);
        }

        RbpJournalPowerCutFiles.AssertRecoveredFileSetIsSane(
            directory.JournalPath);
    }

    /// <summary>
    /// Kill point (e). Section 12.1 step 3: the terminal outcome is durable
    /// before <c>result</c>/<c>error</c> reaches the Gateway. Killing the
    /// process after that commit but before the caller could send anything is
    /// the exact window the ordering exists for: the answer was never sent,
    /// yet the recovered journal must still be able to give it, once, without
    /// re-executing the add-in (Section 12.2 rule 1).
    /// </summary>
    [Fact]
    public async Task KillAfterTerminalCommitReplaysTheDurableOutcomeWithoutReexecution()
    {
        using var directory = new RbpJournalTestDirectory();

        RbpJournalPowerCutReadiness readiness =
            await RbpJournalPowerCutProcess.KillAtAsync(
                RbpJournalPowerCutMode.TerminalCommitted,
                directory.JournalPath);

        AssertKilledUnderProductionDurability(readiness);
        RbpJournalPowerCutFiles.AssertWalRecoveryPending(
            directory.JournalPath);

        await using (RbpJournalStore recovered =
                         await OpenRecoveredAsync(directory))
        {
            await AssertIntegrityCheckIsOkAsync(recovered);

            RbpStoredInvocation? write = await recovered.GetInvocationAsync(
                RbpJournalPowerCutData.WriteKey);
            Assert.NotNull(write);
            Assert.Equal(RbpInvocationState.Completed, write!.State);
            Assert.Equal(
                RbpJournalPowerCutData.CanonicalTerminalOutcomeJson(),
                write.TerminalOutcomeJson);
            Assert.Equal(
                RbpJournalPowerCutData.TerminalResultDigest(),
                write.ResultDigest);
            Assert.NotNull(write.StartedAtMilliseconds);
            Assert.NotNull(write.FinishedAtMilliseconds);
            Assert.Null(write.LateTerminalOutcomeJson);

            RbpInvocationAdmissionResult replay =
                await recovered.AdmitInvocationAsync(
                    RbpJournalPowerCutData.WriteIdentity());

            Assert.Equal(
                RbpInvocationAdmission.ReplayTerminal,
                replay.Admission);
            Assert.Equal(
                RbpInvocationState.Completed,
                replay.Stored.State);
            Assert.Equal(
                RbpJournalPowerCutData.CanonicalTerminalOutcomeJson(),
                replay.Stored.TerminalOutcomeJson);

            // A terminal replay never installs a mutation-recovery hold.
            Assert.Null(replay.VerificationHoldId);
            Assert.Null(
                await recovered.FindConflictingHoldAsync(
                    RbpJournalPowerCutData.Rsid,
                    RbpJournalPowerCutData.DocumentScopeJcs));
        }

        RbpJournalPowerCutFiles.AssertRecoveredFileSetIsSane(
            directory.JournalPath);
    }

    [Fact]
    public async Task RecoveryOpenWaitsForTransientWriterLeaseHandoff()
    {
        using var directory = new RbpJournalTestDirectory();
        using RbpJournalWriterLease blocker =
            RbpJournalWriterLease.Acquire(directory.JournalPath);

        Task<RbpJournalStore> pending = OpenRecoveredAsync(
            directory,
            TimeSpan.FromSeconds(1));
        await Task.Delay(TimeSpan.FromMilliseconds(100));
        Assert.False(pending.IsCompleted);

        blocker.Dispose();
        await using RbpJournalStore recovered = await pending;
        Assert.Equal(
            Path.GetFullPath(directory.JournalPath),
            recovered.DatabasePath);
    }

    [Fact]
    public async Task RecoveryOpenDoesNotMaskPersistentWriterLease()
    {
        using var directory = new RbpJournalTestDirectory();
        using RbpJournalWriterLease blocker =
            RbpJournalWriterLease.Acquire(directory.JournalPath);

        RbpJournalException failure =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => OpenRecoveredAsync(
                    directory,
                    TimeSpan.FromMilliseconds(100)));
        Assert.Equal(
            RbpJournalErrorCode.WriterLeaseUnavailable,
            failure.ErrorCode);
    }

    private static Task<RbpJournalStore> OpenRecoveredAsync(
        RbpJournalTestDirectory directory) =>
        OpenRecoveredAsync(directory, RecoveryOpenTimeout);

    private static async Task<RbpJournalStore> OpenRecoveredAsync(
        RbpJournalTestDirectory directory,
        TimeSpan timeout)
    {
        var elapsed = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                return RbpJournalStore.Open(
                    directory.JournalPath,
                    new TestResumeTokenProtector(),
                    RbpJournalTestData.Options());
            }
            catch (RbpJournalException exception)
                when (exception.ErrorCode ==
                    RbpJournalErrorCode.WriterLeaseUnavailable)
            {
                // Under shared-host Windows load, the boundary between the
                // killed harness and the recovery open can briefly contend on
                // the just-released writer lease. Retry only that exact
                // handoff; every other recovery failure remains immediate.
                if (elapsed.Elapsed >= timeout)
                {
                    throw;
                }

                await Task.Delay(RecoveryOpenRetryDelay)
                    .ConfigureAwait(false);
            }
        }
    }

    private static void AssertKilledUnderProductionDurability(
        RbpJournalPowerCutReadiness readiness)
    {
        // The killed process really was running the production durability
        // profile: WAL journalling with PRAGMA synchronous=FULL, which is what
        // extends process-death crash consistency to media loss.
        Assert.Equal("wal", readiness.JournalMode);
        Assert.Equal(2, readiness.Synchronous);
        Assert.True(readiness.ProcessId > 0);
    }

    private static async Task AssertIntegrityCheckIsOkAsync(
        RbpJournalStore store)
    {
        IReadOnlyList<string> rows =
            await store.ReadAsync<IReadOnlyList<string>>(RunIntegrityCheck);
        Assert.Equal(new[] { "ok" }, rows);
    }

    private static IReadOnlyList<string> RunIntegrityCheck(
        SqliteConnection connection)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "PRAGMA integrity_check;";
        using SqliteDataReader reader = command.ExecuteReader();
        var rows = new List<string>();
        while (reader.Read())
        {
            rows.Add(reader.GetString(0));
        }

        return rows.AsReadOnly();
    }
}
