using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

/// <summary>
/// Frozen O1 Section 12.2 <c>invoke_batch</c> redelivery arbitration and the
/// Section 21 item 29 mixed matrix: <c>atomic:false</c> per-step rules
/// (~1109-1119) with replayed terminal prefix, stop-at-non-success,
/// rule-3 read retry, rule-4 mutating refusal with scope holds, late
/// terminal evidence-only replay, and partial-progress persistence across
/// reopen; <c>atomic:true</c> terminal replay, received-proof execution,
/// and whole-transaction indeterminacy (~1121-1131).
/// </summary>
public sealed class RbpBatchRedeliveryTests
{
    private const string BatchId = "0197a3c2-0000-7000-8000-0000000000c0";
    private const string StepA = "0197a3c2-0000-7000-8000-0000000000c1";
    private const string StepB = "0197a3c2-0000-7000-8000-0000000000c2";
    private const string StepC = "0197a3c2-0000-7000-8000-0000000000c3";
    private const string StepD = "0197a3c2-0000-7000-8000-0000000000c4";

    [Fact]
    public async Task MixedRedeliveryReplaysTerminalPrefixAndStopsAtTheMutation()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: false,
            BatchId,
            new[]
            {
                RbpBatchTestData.ReadStep(StepA),
                RbpBatchTestData.WriteStep(StepB),
                RbpBatchTestData.ReadStep(StepC),
                RbpBatchTestData.WriteStep(
                    StepD,
                    RbpBatchTestData.DocumentTwoScope),
            });
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkBatchDispatchedAsync(batch.BatchKey);

        // First delivery progressed: the read completed, the mutation was
        // possibly dispatched, then the bridge crashed.
        await store.MarkInvocationExecutingAsync(
            RbpBatchTestData.StepKey(StepA));
        _ = await store.PersistInvocationTerminalAsync(
            RbpBatchTestData.StepKey(StepA),
            RbpBatchTestData.StepTerminal(
                RbpInvocationState.Completed,
                """{"ok":true}"""));
        await store.MarkInvocationExecutingAsync(
            RbpBatchTestData.StepKey(StepB));

        RbpBatchGatedAdmission gated = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());

        RbpBatchAdmissionResult arbitrated = gated.Admission!;
        Assert.Equal(
            RbpBatchAdmission.ArbitratedSteps,
            arbitrated.Admission);
        Assert.Equal(
            new[]
            {
                RbpBatchStepDisposition.ReplayTerminal,
                RbpBatchStepDisposition.RefuseIndeterminate,
                RbpBatchStepDisposition.NotStarted,
                RbpBatchStepDisposition.NotStarted,
            },
            arbitrated.Steps.Select(step => step.Disposition).ToArray());
        Assert.Equal(1, arbitrated.FirstNonSuccessStepIndex);

        // No step executes during this delivery, so batch replayed:true is
        // permitted (spec ~1119).
        Assert.True(arbitrated.ReplayPermitted);

        // Rule 4 evidence: explicit outcome/verification fields plus the
        // affected scope hold (Section 21 item 29).
        RbpBatchStepArbitration refused = arbitrated.Steps[1];
        Assert.NotNull(refused.VerificationHoldId);
        Assert.Equal(
            RbpInvocationState.Indeterminate,
            refused.Stored!.State);
        Assert.Contains(
            "\"outcome\":\"indeterminate\"",
            refused.Stored.TerminalOutcomeJson,
            StringComparison.Ordinal);
        Assert.Contains(
            "\"verification_required\":true",
            refused.Stored.TerminalOutcomeJson,
            StringComparison.Ordinal);
        Assert.Contains(
            refused.VerificationHoldId!,
            refused.Stored.TerminalOutcomeJson,
            StringComparison.Ordinal);
        RbpVerificationHold? hold = await store.FindConflictingHoldAsync(
            "rs-test",
            RbpBatchTestData.DocumentOneScope);
        Assert.Equal(refused.VerificationHoldId, hold!.VerificationHoldId);
        Assert.Equal(RbpHoldState.Active, hold.State);

        // The suffix keeps its durable received rows untouched.
        Assert.Equal(
            RbpInvocationState.Received,
            (await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(StepC)))!.State);
        Assert.Equal(
            RbpInvocationState.Received,
            (await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(StepD)))!.State);
    }

    [Fact]
    public async Task ATerminalNonSuccessStepStopsTheBatchWithNotStartedSuffix()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: false,
            BatchId,
            new[]
            {
                RbpBatchTestData.WriteStep(StepA),
                RbpBatchTestData.ReadStep(StepB),
            });
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkInvocationExecutingAsync(
            RbpBatchTestData.StepKey(StepA));
        _ = await store.PersistInvocationTerminalAsync(
            RbpBatchTestData.StepKey(StepA),
            RbpBatchTestData.StepTerminal(
                RbpInvocationState.Failed,
                """{"error":{"fault_class":"revit_api"}}"""));

        RbpBatchAdmissionResult arbitrated =
            (await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;

        Assert.Equal(
            new[]
            {
                RbpBatchStepDisposition.ReplayTerminal,
                RbpBatchStepDisposition.NotStarted,
            },
            arbitrated.Steps.Select(step => step.Disposition).ToArray());
        Assert.Equal(0, arbitrated.FirstNonSuccessStepIndex);
        Assert.True(arbitrated.ReplayPermitted);
        Assert.Equal(
            RbpInvocationState.Failed,
            arbitrated.Steps[0].Stored!.State);
    }

    [Fact]
    public async Task TheFirstNonTerminalReadMayExecuteOnceAndSuccessorsWait()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: false,
            BatchId,
            new[]
            {
                RbpBatchTestData.ReadStep(StepA),
                RbpBatchTestData.WriteStep(StepB),
            });
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());

        RbpBatchAdmissionResult arbitrated =
            (await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;

        // Spec ~1112-1116: the read may run once under rule 3; the ordered
        // mutating successor is not refused and not started until the read
        // recovers terminal-successful.
        Assert.Equal(
            new[]
            {
                RbpBatchStepDisposition.RetryNonMutating,
                RbpBatchStepDisposition.NotStarted,
            },
            arbitrated.Steps.Select(step => step.Disposition).ToArray());
        Assert.Null(arbitrated.FirstNonSuccessStepIndex);
        Assert.False(arbitrated.ReplayPermitted);
        Assert.Equal(
            RbpInvocationState.Received,
            (await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(StepB)))!.State);
        Assert.Null(
            await store.FindConflictingHoldAsync(
                "rs-test",
                RbpBatchTestData.DocumentOneScope));
    }

    [Fact]
    public async Task LateTerminalAfterRefusalReplaysAsEvidenceOnly()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: false,
            BatchId,
            new[] { RbpBatchTestData.WriteStep(StepA) });
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkInvocationExecutingAsync(
            RbpBatchTestData.StepKey(StepA));

        RbpBatchAdmissionResult refused =
            (await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;
        string holdId = refused.Steps[0].VerificationHoldId!;

        // The real add-in outcome becomes durable after the indeterminate.
        _ = await store.PersistInvocationTerminalAsync(
            RbpBatchTestData.StepKey(StepA),
            RbpBatchTestData.StepTerminal(
                RbpInvocationState.Completed,
                """{"late":true}"""));

        RbpBatchAdmissionResult replay =
            (await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;

        RbpBatchStepArbitration step = replay.Steps[0];
        Assert.Equal(
            RbpBatchStepDisposition.ReplayLateAfterIndeterminate,
            step.Disposition);
        Assert.Equal(RbpInvocationState.Indeterminate, step.Stored!.State);
        Assert.Equal(
            """{"late":true}""",
            step.Stored.LateTerminalOutcomeJson);
        Assert.Equal(holdId, step.VerificationHoldId);
        Assert.True(replay.ReplayPermitted);

        // The hold is NOT auto-cleared by the late evidence.
        Assert.NotEqual(
            RbpHoldState.Cleared,
            (await store.GetHoldAsync("rs-test", holdId))!.State);
    }

    [Fact]
    public async Task PartialProgressPersistsAcrossReopen()
    {
        using var directory = new RbpJournalTestDirectory();
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: false,
            BatchId,
            new[]
            {
                RbpBatchTestData.ReadStep(StepA),
                RbpBatchTestData.WriteStep(StepB),
                RbpBatchTestData.ReadStep(StepC),
            });
        await using (RbpJournalStore store = OpenStore(directory))
        {
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration());
            _ = await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>());
            await store.MarkBatchDispatchedAsync(batch.BatchKey);
            foreach (string stepId in new[] { StepA, StepB })
            {
                await store.MarkInvocationExecutingAsync(
                    RbpBatchTestData.StepKey(stepId));
                _ = await store.PersistInvocationTerminalAsync(
                    RbpBatchTestData.StepKey(stepId),
                    RbpBatchTestData.StepTerminal(
                        RbpInvocationState.Completed,
                        """{"ok":true}"""));
            }
        }

        await using RbpJournalStore reopened = OpenStore(directory);
        RbpBatchAdmissionResult arbitrated =
            (await reopened.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;

        // Spec ~1109: terminal prefix steps are replayed from their
        // journals and never re-executed, across restart.
        Assert.Equal(
            new[]
            {
                RbpBatchStepDisposition.ReplayTerminal,
                RbpBatchStepDisposition.ReplayTerminal,
                RbpBatchStepDisposition.RetryNonMutating,
            },
            arbitrated.Steps.Select(step => step.Disposition).ToArray());
        Assert.Null(arbitrated.FirstNonSuccessStepIndex);
        Assert.False(arbitrated.ReplayPermitted);
        Assert.All(
            arbitrated.Steps.Take(2),
            step => Assert.Equal(
                RbpInvocationState.Completed,
                step.Stored!.State));
    }

    [Fact]
    public async Task ADurableTerminalBatchOutcomeReplaysWithoutTheAddin()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: false,
            BatchId,
            new[]
            {
                RbpBatchTestData.WriteStep(StepA),
                RbpBatchTestData.ReadStep(StepB),
            });
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkBatchDispatchedAsync(batch.BatchKey);
        await store.MarkInvocationExecutingAsync(
            RbpBatchTestData.StepKey(StepA));
        _ = await store.PersistInvocationTerminalAsync(
            RbpBatchTestData.StepKey(StepA),
            RbpBatchTestData.StepTerminal(
                RbpInvocationState.Guarded,
                """{"guarded_reason":"workset_locked"}"""));
        RbpStoredBatch terminal = await store.PersistBatchTerminalAsync(
            batch.BatchKey,
            RbpBatchTestData.BatchTerminal(
                """
                {"failed_step_index":0,"status":"guarded",
                 "transaction_state":"not_applicable"}
                """));

        RbpBatchAdmissionResult replay =
            (await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;

        Assert.Equal(RbpBatchAdmission.ReplayTerminal, replay.Admission);
        Assert.Equal(
            terminal.TerminalOutcomeJson,
            replay.Stored.TerminalOutcomeJson);
        Assert.True(replay.ReplayPermitted);
        Assert.Equal(
            new[]
            {
                RbpBatchStepDisposition.ReplayTerminal,
                RbpBatchStepDisposition.NotStarted,
            },
            replay.Steps.Select(step => step.Disposition).ToArray());
        Assert.Equal(0, replay.FirstNonSuccessStepIndex);
    }

    [Fact]
    public async Task AnAtomicReceivedRowProvesNoAddinByteAndMayExecute()
    {
        using var directory = new RbpJournalTestDirectory();
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: true,
            BatchId,
            new[]
            {
                RbpBatchTestData.WriteStep(StepA),
                RbpBatchTestData.ReadStep(StepB),
            });
        await using (RbpJournalStore store = OpenStore(directory))
        {
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration());
            _ = await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>());
        }

        // Spec ~1122-1123 across restart: the coordination row still in
        // `received` durably proves no add-in byte was sent.
        await using RbpJournalStore reopened = OpenStore(directory);
        RbpBatchAdmissionResult redelivered =
            (await reopened.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;

        Assert.Equal(
            RbpBatchAdmission.ExecuteFromReceived,
            redelivered.Admission);
        Assert.False(redelivered.ReplayPermitted);
        Assert.All(
            redelivered.Steps,
            step => Assert.Equal(
                RbpBatchStepDisposition.Accepted,
                step.Disposition));
        Assert.Null(
            await reopened.FindConflictingHoldAsync(
                "rs-test",
                RbpBatchTestData.DocumentOneScope));
    }

    [Fact]
    public async Task AtomicDispatchLossMakesTheWholeTransactionIndeterminate()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: true,
            BatchId,
            new[]
            {
                RbpBatchTestData.WriteStep(StepA),
                RbpBatchTestData.ReadStep(StepB),
                RbpBatchTestData.WriteStep(
                    StepC,
                    RbpBatchTestData.DocumentOneScope,
                    method: "set_element_parameter"),
                RbpBatchTestData.WriteStep(
                    StepD,
                    RbpBatchTestData.DocumentTwoScope),
            });
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkBatchDispatchedAsync(batch.BatchKey);

        RbpBatchAdmissionResult arbitrated =
            (await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;

        // Spec ~1123-1127: every possibly mutating step is indeterminate,
        // the lost read is the narrow known environment failure, and no
        // individual step is retried.
        Assert.Equal(
            RbpBatchAdmission.DispatchLossArbitrated,
            arbitrated.Admission);
        Assert.Equal(
            new[]
            {
                RbpBatchStepDisposition.RefuseIndeterminate,
                RbpBatchStepDisposition.EnvironmentFailed,
                RbpBatchStepDisposition.RefuseIndeterminate,
                RbpBatchStepDisposition.RefuseIndeterminate,
            },
            arbitrated.Steps.Select(step => step.Disposition).ToArray());
        Assert.Equal(0, arbitrated.FirstNonSuccessStepIndex);
        Assert.True(arbitrated.ReplayPermitted);

        // One hold per distinct conflicting mutation scope with the ordered
        // possibly executed step keys as origins.
        string documentOneHold = arbitrated.Steps[0].VerificationHoldId!;
        Assert.Equal(
            documentOneHold,
            arbitrated.Steps[2].VerificationHoldId);
        string documentTwoHold = arbitrated.Steps[3].VerificationHoldId!;
        Assert.NotEqual(documentOneHold, documentTwoHold);
        RbpVerificationHold? sharedScopeHold =
            await store.GetHoldAsync("rs-test", documentOneHold);
        Assert.Equal(
            new[]
            {
                RbpBatchTestData.StepKey(StepA),
                RbpBatchTestData.StepKey(StepC),
            },
            sharedScopeHold!.OrderedOriginIdempotencyKeys);

        // The lost read is failed with retryable environment,
        // outcome:"known", verification_required:false (spec ~985).
        RbpStoredInvocation lostRead = arbitrated.Steps[1].Stored!;
        Assert.Equal(RbpInvocationState.Failed, lostRead.State);
        Assert.Contains(
            "\"fault_class\":\"environment\"",
            lostRead.TerminalOutcomeJson,
            StringComparison.Ordinal);
        Assert.Contains(
            "\"outcome\":\"known\"",
            lostRead.TerminalOutcomeJson,
            StringComparison.Ordinal);
        Assert.Contains(
            "\"verification_required\":false",
            lostRead.TerminalOutcomeJson,
            StringComparison.Ordinal);

        // The batch itself is durably terminal-indeterminate and carries
        // both scope holds in order.
        RbpStoredBatch stored =
            (await store.GetBatchAsync(batch.BatchKey))!;
        Assert.Equal(RbpBatchState.Terminal, stored.State);
        Assert.Contains(
            "\"transaction_state\":\"indeterminate\"",
            stored.TerminalOutcomeJson,
            StringComparison.Ordinal);
        Assert.Contains(
            $"\"verification_hold_ids\":[\"{documentOneHold}\",\"{documentTwoHold}\"]",
            stored.TerminalOutcomeJson,
            StringComparison.Ordinal);

        // A later redelivery replays the durable indeterminate outcome with
        // replayed:true and no add-in call (spec ~1129-1131).
        RbpBatchAdmissionResult replay =
            (await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;
        Assert.Equal(RbpBatchAdmission.ReplayTerminal, replay.Admission);
        Assert.True(replay.ReplayPermitted);
        Assert.Equal(
            stored.TerminalOutcomeJson,
            replay.Stored.TerminalOutcomeJson);
        Assert.Equal(
            RbpBatchStepDisposition.ReplayTerminal,
            replay.Steps[0].Disposition);
        Assert.Equal(
            RbpInvocationState.Indeterminate,
            replay.Steps[0].Stored!.State);
    }

    [Fact]
    public async Task AnAllReadAtomicDispatchLossIsTheKnownEnvironmentFailure()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: true,
            BatchId,
            new[]
            {
                RbpBatchTestData.ReadStep(StepA),
                RbpBatchTestData.ReadStep(
                    StepB,
                    method: "get_document_context"),
            });
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkBatchDispatchedAsync(batch.BatchKey);

        RbpBatchAdmissionResult arbitrated =
            (await store.AdmitBatchAsync(
                batch,
                Array.Empty<RbpRecoveryClearance>())).Admission!;

        // Spec ~990-994: every unavailable read is the known environment
        // failure; the aggregate is failed/rolled_back with
        // failed_step_index 0 and no fabricated result.
        Assert.Equal(
            new[]
            {
                RbpBatchStepDisposition.EnvironmentFailed,
                RbpBatchStepDisposition.EnvironmentFailed,
            },
            arbitrated.Steps.Select(step => step.Disposition).ToArray());
        Assert.Equal(0, arbitrated.FirstNonSuccessStepIndex);
        Assert.True(arbitrated.ReplayPermitted);
        RbpStoredBatch stored =
            (await store.GetBatchAsync(batch.BatchKey))!;
        Assert.Equal(RbpBatchState.Terminal, stored.State);
        Assert.Contains(
            "\"status\":\"failed\"",
            stored.TerminalOutcomeJson,
            StringComparison.Ordinal);
        Assert.Contains(
            "\"transaction_state\":\"rolled_back\"",
            stored.TerminalOutcomeJson,
            StringComparison.Ordinal);
        Assert.Contains(
            "\"failed_step_index\":0",
            stored.TerminalOutcomeJson,
            StringComparison.Ordinal);
        Assert.Null(
            await store.FindConflictingHoldAsync(
                "rs-test",
                RbpBatchTestData.DocumentOneScope));
    }

    [Fact]
    public async Task RetentionNeverPrunesStepsOfANonTerminalBatch()
    {
        using var directory = new RbpJournalTestDirectory();
        long clock = RbpJournalTestData.Now.ToUnixTimeMilliseconds();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(nowMilliseconds: () => clock));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(expiresInHours: 24 * 365));
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: false,
            BatchId,
            new[] { RbpBatchTestData.ReadStep(StepA) });
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkBatchDispatchedAsync(batch.BatchKey);
        await store.MarkInvocationExecutingAsync(
            RbpBatchTestData.StepKey(StepA));
        _ = await store.PersistInvocationTerminalAsync(
            RbpBatchTestData.StepKey(StepA),
            RbpBatchTestData.StepTerminal(
                RbpInvocationState.Completed,
                """{"ok":true}"""));

        // Far past the retention window the terminal step row survives,
        // because its batch is not terminal and Section 12.2 replays the
        // terminal prefix from the step journals.
        clock += (long)TimeSpan.FromDays(15).TotalMilliseconds;
        RbpJournalRetentionResult guarded =
            await store.ApplyRetentionAsync();
        Assert.Equal(0, guarded.PrunedInvocations);
        Assert.Equal(0, guarded.PrunedTerminalBatches);
        Assert.NotNull(
            await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(StepA)));
        Assert.NotNull(await store.GetBatchAsync(batch.BatchKey));

        // Once the batch outcome is durable and ages out, the step row and
        // then the coordination row become prunable.
        _ = await store.PersistBatchTerminalAsync(
            batch.BatchKey,
            RbpBatchTestData.BatchTerminal(
                """
                {"failed_step_index":null,"status":"completed",
                 "transaction_state":"not_applicable"}
                """));
        clock += (long)TimeSpan.FromDays(15).TotalMilliseconds;
        RbpJournalRetentionResult swept = await store.ApplyRetentionAsync();
        Assert.Equal(1, swept.PrunedInvocations);
        Assert.Equal(1, swept.PrunedTerminalBatches);
        Assert.Null(
            await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(StepA)));
        Assert.Null(await store.GetBatchAsync(batch.BatchKey));
    }

    [Fact]
    public async Task LegacyDispatchedAtomicBatchImportsEveryMutationScope()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpBatchIdentity batch = RbpBatchTestData.Batch(
            atomic: true,
            "0197a3c2-0000-7000-8000-000000000471",
            new[]
            {
                RbpBatchTestData.WriteStep(
                    "0197a3c2-0000-7000-8000-000000000472"),
                RbpBatchTestData.ReadStep(
                    "0197a3c2-0000-7000-8000-000000000473"),
                RbpBatchTestData.WriteStep(
                    "0197a3c2-0000-7000-8000-000000000474",
                    RbpBatchTestData.DocumentTwoScope),
            });
        _ = await store.AdmitBatchAsync(
            batch,
            Array.Empty<RbpRecoveryClearance>());
        await store.MarkBatchDispatchedAsync(batch.BatchKey);

        _ = await store.EnsureOutcomeV3ForSessionAsync("rs-test");

        RbpStoredInvocation first =
            (await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(
                    "0197a3c2-0000-7000-8000-000000000472")))!;
        RbpStoredInvocation second =
            (await store.GetInvocationAsync(
                RbpBatchTestData.StepKey(
                    "0197a3c2-0000-7000-8000-000000000474")))!;
        Assert.Equal(RbpInvocationState.Indeterminate, first.State);
        Assert.Equal(RbpInvocationState.Indeterminate, second.State);
        Assert.NotEqual(first.VerificationHoldId, second.VerificationHoldId);
        Assert.Equal(
            RbpBatchState.Dispatched,
            (await store.GetBatchAsync(batch.BatchKey))!.State);

        RbpBatchGatedAdmission recovery =
            await store.AdmitBatchOutcomeV3Async(
                batch,
                Array.Empty<RbpRecoveryClearance>(),
                new[]
                {
                    RbpTransactionMode.Native,
                    RbpTransactionMode.Native,
                    RbpTransactionMode.Native,
                });
        Assert.Equal(
            RbpBatchAdmission.DispatchLossArbitrated,
            recovery.Admission!.Admission);
    }

    private static RbpJournalStore OpenStore(
        RbpJournalTestDirectory directory) =>
        RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
}
