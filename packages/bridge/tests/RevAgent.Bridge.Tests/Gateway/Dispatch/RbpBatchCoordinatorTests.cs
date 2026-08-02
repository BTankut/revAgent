using System.Text.Json;
using System.Text.Json.Nodes;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;
using static RevAgent.Bridge.Tests.Gateway.Dispatch.RbpBatchCoordinatorTestData;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

/// <summary>
/// Frozen O1 conformance for <c>invoke_batch</c> execution and its Section
/// 11.1 result carrier: Section 21 items 20, 21, 22, 38, and 39, the
/// descriptor-set <c>inline_only</c> gate (spec ~912-915), the Appendix A.4
/// response verification that turns a contradictory add-in answer into an
/// indeterminate dispatched batch (spec ~1830-1834), and redelivery of a
/// partially executed <c>atomic:false</c> batch under the journal's own
/// arbitration (spec ~1106-1119).
/// </summary>
public sealed class RbpBatchCoordinatorTests
{
    private const string BatchId = "0197a3c2-0000-7000-8000-0000000000f0";
    private const string StepOne = "0197a3c2-0000-7000-8000-0000000000f1";
    private const string StepTwo = "0197a3c2-0000-7000-8000-0000000000f2";
    private const string StepThree = "0197a3c2-0000-7000-8000-0000000000f3";

    [Fact]
    public async Task
        Item20_AtomicFalseFanOutStopsAtTheFirstNonSuccessAndReportsItsIndex()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel()
            .Then(Completed("""{"views":1}"""))
            .Then(KnownFailure("revit_api", "the view no longer exists"));

        RbpInvocationAnswer answer = await Coordinator(store, channel)
            .DispatchAsync(Rsid, ThreeReadPayload(), CancellationToken.None);

        // Spec ~906-909: ordered fan-out stops at the first
        // guarded|failed|cancelled|indeterminate step and every later input
        // step is not_started; the third step is never dispatched.
        Assert.Equal(2, channel.Calls.Count);
        Assert.Equal("result", answer.Type);
        Assert.Equal("batch", answer.Payload.GetProperty("kind").GetString());
        Assert.False(answer.Payload.GetProperty("atomic").GetBoolean());
        Assert.Equal("failed", Status(answer));
        Assert.Equal(
            "not_applicable",
            answer.Payload.GetProperty("transaction_state").GetString());

        // failed_step_index is carried at the top level of the payload, not
        // hidden in a step result or metrics object.
        Assert.Equal(1, answer.Payload.GetProperty("failed_step_index").GetInt32());
        Assert.Equal("completed", StepStatus(answer, 0));
        Assert.Equal("failed", StepStatus(answer, 1));
        Assert.Equal("not_started", StepStatus(answer, 2));
        Assert.Equal(StepThree, Step(answer, 2).GetProperty("invocation_id").GetString());
    }

    [Fact]
    public async Task
        Item20_AtomicFalseFanOutCompletesEveryStepInInputOrderWithoutAFailureIndex()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel()
            .Then(Completed("""{"a":1}"""))
            .Then(Completed("""{"b":2}"""));

        RbpInvocationAnswer answer = await Coordinator(store, channel)
            .DispatchAsync(Rsid, TwoReadPayload(), CancellationToken.None);

        Assert.Equal(2, channel.Calls.Count);
        Assert.Equal(StepOne, channel.Calls[0].InvocationId);
        Assert.Equal(StepTwo, channel.Calls[1].InvocationId);
        Assert.Equal("completed", Status(answer));

        // failed_step_index is null only when every step completed.
        Assert.Equal(
            JsonValueKind.Null,
            answer.Payload.GetProperty("failed_step_index").ValueKind);
        Assert.False(answer.Payload.GetProperty("replayed").GetBoolean());
    }

    [Fact]
    public async Task
        Item21_AtomicTrueWithoutBatchAtomicIsUnsupportedAndExecutesNoStep()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel();

        RbpInvocationAnswer answer = await Coordinator(
                store,
                channel,
                StubBatchCapabilities.Standard(batchAtomicGranted: false))
            .DispatchAsync(
                Rsid,
                Payload(BatchId, atomic: true, [Write(StepOne)]),
                CancellationToken.None);

        // Spec ~905: without batch_atomic, atomic:true returns terminal
        // unsupported without executing any step.
        Assert.Empty(channel.Calls);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "unsupported",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.False(answer.Payload.GetProperty("retryable").GetBoolean());
        Assert.Equal(
            "known",
            answer.Payload.GetProperty("outcome").GetString());
        Assert.False(
            answer.Payload.GetProperty("verification_required").GetBoolean());

        // The refusal is decided before journal admission, so no
        // coordination row exists for a redelivery to arbitrate.
        Assert.Null(await store.GetBatchAsync(Rsid + "/" + BatchId));
    }

    [Fact]
    public async Task
        Item22_AtomicTrueSendsOneExecuteBatchFrameAndMapsTheCommittedGroup()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        JsonElement payload = Payload(
            BatchId,
            atomic: true,
            [Read(StepOne), Write(StepTwo)]);
        string digest = payload.GetProperty("batch_digest").GetString()!;
        var channel = new StubBatchChannel().Then(
            AtomicEnvelope(
                BatchId,
                digest,
                [
                    new AtomicStepSpec(
                        StepOne,
                        ReadMethod,
                        "completed",
                        "read_only",
                        ResultJson: """{"views":2}"""),
                    new AtomicStepSpec(
                        StepTwo,
                        WriteMethod,
                        "completed",
                        "committed",
                        ResultJson: """{"deleted":true}"""),
                ]));

        RbpInvocationAnswer answer = await Coordinator(
                store,
                channel,
                StubBatchCapabilities.Standard(batchAtomicGranted: true))
            .DispatchAsync(Rsid, payload, CancellationToken.None);

        // Spec ~904, ~1760-1765: exactly one length-prefixed execute_batch
        // request whose outer JSON-RPC id equals params.batchId.
        Assert.Single(channel.Calls);
        Assert.Equal("execute_batch", channel.Calls[0].Method);
        Assert.Equal(BatchId, channel.Calls[0].InvocationId);
        JsonNode parameters =
            JsonNode.Parse(channel.Calls[0].CopyParameters().ToString())!;
        Assert.Equal(1, parameters["batchContractVersion"]!.GetValue<int>());
        Assert.Equal(BatchId, parameters["batchId"]!.GetValue<string>());
        Assert.Equal(digest, parameters["batchDigest"]!.GetValue<string>());
        Assert.True(parameters["atomic"]!.GetValue<bool>());
        Assert.Equal(
            "rollback_on_non_success",
            parameters["rollbackPolicy"]!.GetValue<string>());
        Assert.Equal(
            33_554_432L,
            parameters["maxAggregateResultBytes"]!.GetValue<long>());
        JsonArray steps = parameters["steps"]!.AsArray();
        Assert.Equal(0, steps[0]!["index"]!.GetValue<int>());
        Assert.Equal(StepOne, steps[0]!["invocationId"]!.GetValue<string>());
        Assert.Equal("read_only", steps[0]!["effect"]!.GetValue<string>());
        Assert.Equal(
            "model_transaction",
            steps[1]!["effect"]!.GetValue<string>());

        // Spec ~1007-1008: for atomic:true, success requires
        // transaction_state:"committed".
        Assert.Equal("completed", Status(answer));
        Assert.Equal(
            "committed",
            answer.Payload.GetProperty("transaction_state").GetString());
        Assert.Equal(
            JsonValueKind.Null,
            answer.Payload.GetProperty("failed_step_index").ValueKind);

        // Spec ~999-1009 gives effect_state only to a delivery fault or a
        // cancelled step, so that neither hides a known model effect, and the
        // frozen batchStepResult schema pairs it with a required error. A
        // completed step states its outcome through transaction_state, and
        // carrying effect_state here made the whole carrier fail outbound
        // validation.
        Assert.False(
            Step(answer, 1).TryGetProperty("effect_state", out _));
    }

    [Fact]
    public async Task
        Item22_AtomicTrueMapsACleanTransactionGroupRollbackWithoutACommitClaim()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        JsonElement payload = Payload(
            BatchId,
            atomic: true,
            [Write(StepOne), Read(StepTwo), Read(StepThree, SecondReadMethod)]);
        string digest = payload.GetProperty("batch_digest").GetString()!;
        var channel = new StubBatchChannel().Then(
            AtomicEnvelope(
                BatchId,
                digest,
                [
                    new AtomicStepSpec(
                        StepOne,
                        WriteMethod,
                        "completed",
                        "rolled_back",
                        ResultSuppressed: "batch_rolled_back"),
                    new AtomicStepSpec(
                        StepTwo,
                        ReadMethod,
                        "failed",
                        "discarded",
                        ErrorCode: "revit_exception",
                        ErrorMessage: "the element was not found"),
                    new AtomicStepSpec(
                        StepThree,
                        SecondReadMethod,
                        "not_started",
                        "not_started"),
                ]));

        RbpInvocationAnswer answer = await Coordinator(
                store,
                channel,
                StubBatchCapabilities.Standard(batchAtomicGranted: true))
            .DispatchAsync(Rsid, payload, CancellationToken.None);

        Assert.Single(channel.Calls);
        Assert.Equal("failed", Status(answer));
        Assert.Equal(
            "rolled_back",
            answer.Payload.GetProperty("transaction_state").GetString());
        Assert.Equal(
            1,
            answer.Payload.GetProperty("failed_step_index").GetInt32());

        // Spec ~1008-1009: no step may claim a committed mutation on a clean
        // rollback, and the rolled-back result is not exposed.
        JsonElement rolledBack = Step(answer, 0);
        Assert.Equal(
            "rolled_back",
            rolledBack.GetProperty("effect_state").GetString());
        Assert.Equal(
            "batch_rolled_back",
            rolledBack.GetProperty("result_suppressed").GetString());
        Assert.False(rolledBack.TryGetProperty("result", out _));
        Assert.Equal("not_started", StepStatus(answer, 2));
    }

    [Fact]
    public async Task
        Item38_FirstDeliveryStopsOnAGuardedStepAndMarksEverySuccessorNotStarted()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel()
            .Then(Completed("""{"a":1}"""))
            .Then(Guarded("workset_locked"));

        RbpInvocationAnswer answer = await Coordinator(store, channel)
            .DispatchAsync(Rsid, ThreeReadPayload(), CancellationToken.None);

        // Spec ~908-909: a guarded step never allows the next step to run
        // merely because it arrived in a result rather than an error.
        Assert.Equal(2, channel.Calls.Count);
        Assert.Equal("guarded", Status(answer));
        Assert.Equal(
            1,
            answer.Payload.GetProperty("failed_step_index").GetInt32());
        Assert.Equal("not_started", StepStatus(answer, 2));

        // Section 21 item 38: status guarded requires a valid guarded_reason.
        Assert.Equal(
            "workset_locked",
            Step(answer, 1).GetProperty("guarded_reason").GetString());
    }

    [Fact]
    public async Task
        Item38_AtomicGuardedStepWithoutAReasonIsNotAcceptedAsAGuardedResult()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        JsonElement payload = Payload(
            BatchId,
            atomic: true,
            [Read(StepOne), Read(StepTwo, SecondReadMethod)]);
        string digest = payload.GetProperty("batch_digest").GetString()!;
        var channel = new StubBatchChannel().Then(
            AtomicEnvelope(
                BatchId,
                digest,
                [
                    new AtomicStepSpec(
                        StepOne,
                        ReadMethod,
                        "guarded",
                        "discarded",
                        ResultSuppressed: "batch_rolled_back"),
                    new AtomicStepSpec(
                        StepTwo,
                        SecondReadMethod,
                        "not_started",
                        "not_started"),
                ]));

        RbpInvocationAnswer answer = await Coordinator(
                store,
                channel,
                StubBatchCapabilities.Standard(batchAtomicGranted: true))
            .DispatchAsync(Rsid, payload, CancellationToken.None);

        // An unnamed guard is not a guard: the contradictory envelope cannot
        // be repaired by inference, and the all-read missing carrier becomes
        // the narrow known environment failure (spec ~990-994, ~1833-1834).
        Assert.NotEqual("guarded", Status(answer));
        Assert.Equal("failed", Status(answer));
        Assert.Equal(
            "rolled_back",
            answer.Payload.GetProperty("transaction_state").GetString());
        Assert.Equal(
            0,
            answer.Payload.GetProperty("failed_step_index").GetInt32());
        JsonElement error = Step(answer, 0).GetProperty("error");
        Assert.Equal(
            "environment",
            error.GetProperty("fault_class").GetString());
        Assert.Equal("known", error.GetProperty("outcome").GetString());
        Assert.False(
            error.GetProperty("verification_required").GetBoolean());
    }

    [Fact]
    public async Task
        Item39_NotStartedStepCarriesNoResultErrorOrOmissionFields()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel()
            .Then(Completed())
            .Then(KnownFailure());

        RbpInvocationAnswer answer = await Coordinator(store, channel)
            .DispatchAsync(Rsid, ThreeReadPayload(), CancellationToken.None);

        JsonElement notStarted = Step(answer, 2);
        Assert.Equal("not_started", notStarted.GetProperty("status").GetString());
        Assert.False(notStarted.TryGetProperty("result", out _));
        Assert.False(notStarted.TryGetProperty("error", out _));
        Assert.False(notStarted.TryGetProperty("payload_omitted", out _));
        Assert.False(notStarted.TryGetProperty("result_digest", out _));
        Assert.False(notStarted.GetProperty("replayed").GetBoolean());
    }

    [Fact]
    public async Task Item39_AFirstDeliveryResultIsCarriedRatherThanOmitted()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel()
            .Then(Completed("""{"views":7}"""))
            .Then(Completed("""{"views":8}"""));

        RbpInvocationAnswer answer = await Coordinator(store, channel)
            .DispatchAsync(Rsid, TwoReadPayload(), CancellationToken.None);

        // payload_omitted is replay-only; a first delivery carries the real
        // result and claims no omission.
        JsonElement first = Step(answer, 0);
        Assert.False(first.GetProperty("replayed").GetBoolean());
        Assert.False(first.TryGetProperty("payload_omitted", out _));
        Assert.Equal(7, first.GetProperty("result").GetProperty("views").GetInt32());
    }

    [Fact]
    public async Task InlineOnlyGateRejectsAStepOutsideTheProbedDescriptorSet()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel();
        var capabilities = new StubBatchCapabilities()
            .Describe(ReadMethod);

        RbpInvocationAnswer answer = await Coordinator(
                store,
                channel,
                capabilities)
            .DispatchAsync(Rsid, TwoReadPayload(), CancellationToken.None);

        // Spec ~912-915: an absent descriptor is unsupported before any step
        // is dispatched, including on the atomic:false fan-out path.
        Assert.Empty(channel.Calls);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "unsupported",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.Null(await store.GetBatchAsync(Rsid + "/" + BatchId));
    }

    [Fact]
    public async Task InlineOnlyGateRejectsADescriptorThatIsNotInlineOnly()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel();
        var capabilities = new StubBatchCapabilities()
            .Describe(ReadMethod)
            .Describe(SecondReadMethod, resultDelivery: "chunked");

        RbpInvocationAnswer answer = await Coordinator(
                store,
                channel,
                capabilities)
            .DispatchAsync(Rsid, TwoReadPayload(), CancellationToken.None);

        // Nested batch steps never use Section 13 chunk or artifact carriers.
        Assert.Empty(channel.Calls);
        Assert.Equal(
            "unsupported",
            answer.Payload.GetProperty("fault_class").GetString());
    }

    [Fact]
    public async Task AtomicStepCarryingAReservedParameterNameIsRejected()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel();

        RbpInvocationAnswer answer = await Coordinator(
                store,
                channel,
                StubBatchCapabilities.Standard(batchAtomicGranted: true))
            .DispatchAsync(
                Rsid,
                Payload(
                    BatchId,
                    atomic: true,
                    [Read(StepOne, ReadMethod, """{"timeoutMs":5000}""")]),
                CancellationToken.None);

        // Spec ~1772-1782: the exact reserved-name set is rejected before
        // dispatch, so a connection/timeout/display control field can never
        // ride inside an atomic step's functional parameters.
        Assert.Empty(channel.Calls);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "parameter",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.Null(await store.GetBatchAsync(Rsid + "/" + BatchId));
    }

    [Fact]
    public async Task
        NestedStepErrorCarriesTheCompleteSection15BodyWithoutAnInvocationId()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel()
            .Then(KnownFailure("revit_api", "bounded operator-safe message"));

        RbpInvocationAnswer answer = await Coordinator(store, channel)
            .DispatchAsync(Rsid, TwoReadPayload(), CancellationToken.None);

        // Spec ~1000-1006: the nested error is the complete Section 15 body
        // except that invocation_id is carried by the enclosing step, and no
        // parent status supplies any of its fields by implication.
        JsonElement step = Step(answer, 0);
        Assert.Equal(StepOne, step.GetProperty("invocation_id").GetString());
        JsonElement error = step.GetProperty("error");
        Assert.False(error.TryGetProperty("invocation_id", out _));
        Assert.Equal("revit_api", error.GetProperty("fault_class").GetString());
        Assert.False(error.GetProperty("retryable").GetBoolean());
        Assert.Equal("known", error.GetProperty("outcome").GetString());
        Assert.False(
            error.GetProperty("verification_required").GetBoolean());
        Assert.Equal(
            "bounded operator-safe message",
            error.GetProperty("message").GetString());
    }

    [Fact]
    public async Task
        AResponseContradictingTheDispatchedStepsBecomesIndeterminate()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        JsonElement payload = Payload(
            BatchId,
            atomic: true,
            [Write(StepOne), Read(StepTwo)]);
        string digest = payload.GetProperty("batch_digest").GetString()!;

        // The add-in answers about a step that was never dispatched.
        var channel = new StubBatchChannel().Then(
            AtomicEnvelope(
                BatchId,
                digest,
                [
                    new AtomicStepSpec(
                        StepThree,
                        WriteMethod,
                        "completed",
                        "committed",
                        ResultJson: "{}"),
                    new AtomicStepSpec(
                        StepTwo,
                        ReadMethod,
                        "completed",
                        "read_only",
                        ResultJson: "{}"),
                ]));

        RbpInvocationAnswer answer = await Coordinator(
                store,
                channel,
                StubBatchCapabilities.Standard(batchAtomicGranted: true))
            .DispatchAsync(Rsid, payload, CancellationToken.None);

        // Spec ~1833-1834: a contradictory response cannot be repaired by
        // inference and becomes an indeterminate dispatched batch.
        Assert.Equal("indeterminate", Status(answer));
        Assert.Equal(
            "indeterminate",
            answer.Payload.GetProperty("transaction_state").GetString());
        Assert.Equal(
            0,
            answer.Payload.GetProperty("failed_step_index").GetInt32());

        JsonElement mutation = Step(answer, 0).GetProperty("error");
        Assert.Equal(
            "journal_indeterminate",
            mutation.GetProperty("fault_class").GetString());
        Assert.Equal(
            "indeterminate",
            mutation.GetProperty("outcome").GetString());
        Assert.True(
            mutation.GetProperty("verification_required").GetBoolean());
        Assert.True(mutation.TryGetProperty("mutation_scope", out _));
        string holdId =
            mutation.GetProperty("verification_hold_id").GetString()!;
        Assert.StartsWith("vh:", holdId, StringComparison.Ordinal);
        Assert.NotNull(await store.GetHoldAsync(Rsid, holdId));

        // The lost read is the narrow known environment failure, never a
        // synthetic success.
        JsonElement read = Step(answer, 1).GetProperty("error");
        Assert.Equal("environment", read.GetProperty("fault_class").GetString());
        Assert.Equal("known", read.GetProperty("outcome").GetString());
    }

    [Fact]
    public async Task
        AnUncertainMutationStopsTheFanOutAsJournalIndeterminateWithItsHold()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel().Then(PossiblyDispatched());

        RbpInvocationAnswer answer = await Coordinator(store, channel)
            .DispatchAsync(
                Rsid,
                Payload(BatchId, atomic: false, [Write(StepOne), Read(StepTwo)]),
                CancellationToken.None);

        // Section 15: after the first add-in byte may have been sent,
        // journal_indeterminate replaces the otherwise retryable environment
        // class and activates the Section 6.2.1 scope hold.
        Assert.Single(channel.Calls);
        Assert.Equal("indeterminate", Status(answer));
        Assert.Equal(
            0,
            answer.Payload.GetProperty("failed_step_index").GetInt32());
        JsonElement error = Step(answer, 0).GetProperty("error");
        Assert.Equal(
            "journal_indeterminate",
            error.GetProperty("fault_class").GetString());
        Assert.False(error.GetProperty("retryable").GetBoolean());
        Assert.NotNull(
            await store.GetHoldAsync(
                Rsid,
                error.GetProperty("verification_hold_id").GetString()!));
        Assert.Equal("not_started", StepStatus(answer, 1));
    }

    [Fact]
    public async Task ATerminalBatchReplaysWithoutCallingTheAddin()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel()
            .Then(Completed("""{"a":1}"""))
            .Then(Completed("""{"b":2}"""));
        RbpBatchCoordinator coordinator = Coordinator(store, channel);
        _ = await coordinator.DispatchAsync(
            Rsid,
            TwoReadPayload(),
            CancellationToken.None);
        Assert.Equal(2, channel.Calls.Count);

        RbpInvocationAnswer replay = await coordinator.DispatchAsync(
            Rsid,
            TwoReadPayload(),
            CancellationToken.None);

        // Spec ~1121-1122: a durable terminal batch outcome replays with
        // identical semantics without calling the add-in.
        Assert.Equal(2, channel.Calls.Count);
        Assert.Equal("completed", Status(replay));
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());
        Assert.True(Step(replay, 0).GetProperty("replayed").GetBoolean());
        Assert.Equal(
            1,
            Step(replay, 0).GetProperty("result").GetProperty("a").GetInt32());
    }

    [Fact]
    public async Task
        RedeliveryOfAPartiallyExecutedFanOutResumesUnderTheJournalArbitration()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);

        // The first delivery completes step 0 and is lost while step 1 is
        // executing: exactly the state a crash between Section 12.1 steps 2
        // and 3 leaves behind.
        var first = new StubBatchChannel()
            .Then(Completed("""{"a":1}"""))
            .Then(_ => throw new OperationCanceledException());
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Coordinator(store, first).DispatchAsync(
                Rsid,
                ThreeReadPayload(),
                CancellationToken.None));

        var second = new StubBatchChannel().Then(Completed("""{"b":2}"""));
        RbpInvocationAnswer resumed = await Coordinator(store, second)
            .DispatchAsync(Rsid, ThreeReadPayload(), CancellationToken.None);

        // Spec ~1109-1116: the terminal prefix replays and is never
        // re-executed, the first non-terminal read executes once under rule
        // 3, and ordered successors stay not_started.
        Assert.Single(second.Calls);
        Assert.Equal(StepTwo, second.Calls[0].InvocationId);
        Assert.True(Step(resumed, 0).GetProperty("replayed").GetBoolean());
        Assert.Equal("completed", StepStatus(resumed, 0));
        Assert.False(Step(resumed, 1).GetProperty("replayed").GetBoolean());
        Assert.Equal("completed", StepStatus(resumed, 1));
        Assert.Equal("not_started", StepStatus(resumed, 2));

        // A step executed during this delivery forbids batch replayed:true.
        Assert.False(resumed.Payload.GetProperty("replayed").GetBoolean());

        // The batch is not frozen terminal, because ordered not_started
        // successors may execute after a recovered step is
        // terminal-successful.
        RbpStoredBatch? stored = await store.GetBatchAsync(Rsid + "/" + BatchId);
        Assert.Equal(RbpBatchState.Dispatched, stored!.State);

        var third = new StubBatchChannel().Then(Completed("""{"c":3}"""));
        RbpInvocationAnswer finished = await Coordinator(store, third)
            .DispatchAsync(Rsid, ThreeReadPayload(), CancellationToken.None);

        Assert.Single(third.Calls);
        Assert.Equal(StepThree, third.Calls[0].InvocationId);
        Assert.Equal("completed", Status(finished));
        Assert.Equal(
            RbpBatchState.Terminal,
            (await store.GetBatchAsync(Rsid + "/" + BatchId))!.State);
    }

    [Fact]
    public async Task
        AtomicDispatchLossRecoveryReplaysWithoutCallingTheAddinAgain()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        JsonElement payload = Payload(
            BatchId,
            atomic: true,
            [Write(StepOne), Read(StepTwo)]);

        // The bridge dies after the one atomic dispatch and before a durable
        // terminal batch outcome.
        var lost = new StubBatchChannel()
            .Then(_ => throw new OperationCanceledException());
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Coordinator(
                    store,
                    lost,
                    StubBatchCapabilities.Standard(batchAtomicGranted: true))
                .DispatchAsync(Rsid, payload, CancellationToken.None));

        var recovery = new StubBatchChannel();
        RbpInvocationAnswer answer = await Coordinator(
                store,
                recovery,
                StubBatchCapabilities.Standard(batchAtomicGranted: true))
            .DispatchAsync(Rsid, payload, CancellationToken.None);

        // Spec ~1123-1131: the whole transaction and every possibly mutating
        // step are indeterminate, no individual step is retried, and the
        // recovery delivery executes no add-in step.
        Assert.Empty(recovery.Calls);
        Assert.Equal("indeterminate", Status(answer));
        Assert.Equal(
            "indeterminate",
            answer.Payload.GetProperty("transaction_state").GetString());
        Assert.Equal(
            0,
            answer.Payload.GetProperty("failed_step_index").GetInt32());
        Assert.True(answer.Payload.GetProperty("replayed").GetBoolean());
        Assert.True(Step(answer, 0).GetProperty("replayed").GetBoolean());

        JsonElement mutation = Step(answer, 0).GetProperty("error");
        Assert.Equal(
            "journal_indeterminate",
            mutation.GetProperty("fault_class").GetString());
        Assert.NotNull(
            await store.GetHoldAsync(
                Rsid,
                mutation.GetProperty("verification_hold_id").GetString()!));

        // Spec ~985-994: a read lost with the missing carrier is the narrow
        // known environment failure, never a synthetic success.
        JsonElement read = Step(answer, 1).GetProperty("error");
        Assert.Equal("environment", read.GetProperty("fault_class").GetString());
        Assert.True(read.GetProperty("retryable").GetBoolean());
    }

    [Fact]
    public async Task AChangedBoundElementUnderTheSameBatchIdIsAProtocolFault()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = Open(directory);
        await RegisterAsync(store);
        var channel = new StubBatchChannel()
            .Then(Completed())
            .Then(Completed());
        RbpBatchCoordinator coordinator = Coordinator(store, channel);
        _ = await coordinator.DispatchAsync(
            Rsid,
            TwoReadPayload(),
            CancellationToken.None);

        RbpInvocationAnswer answer = await coordinator.DispatchAsync(
            Rsid,
            Payload(
                BatchId,
                atomic: false,
                [Read(StepOne), Read(StepTwo, SecondReadMethod, """{"q":1}""")]),
            CancellationToken.None);

        // Spec ~1102-1105: any changed bound element under the same batch_id
        // is a terminal protocol fault, decided before any add-in byte.
        Assert.Equal(2, channel.Calls.Count);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "protocol",
            answer.Payload.GetProperty("fault_class").GetString());
    }

    private static JsonElement ThreeReadPayload() =>
        Payload(
            BatchId,
            atomic: false,
            [
                Read(StepOne),
                Read(StepTwo, SecondReadMethod),
                Read(StepThree),
            ]);

    private static JsonElement TwoReadPayload() =>
        Payload(
            BatchId,
            atomic: false,
            [Read(StepOne), Read(StepTwo, SecondReadMethod)]);

    private static string Status(RbpInvocationAnswer answer) =>
        answer.Payload.GetProperty("status").GetString()!;

    private static JsonElement Step(RbpInvocationAnswer answer, int index) =>
        answer.Payload.GetProperty("steps")[index];

    private static string StepStatus(RbpInvocationAnswer answer, int index) =>
        Step(answer, index).GetProperty("status").GetString()!;

    private static RbpBatchCoordinator Coordinator(
        RbpJournalStore store,
        StubBatchChannel channel,
        StubBatchCapabilities? capabilities = null) =>
        new(
            store,
            channel,
            capabilities ?? StubBatchCapabilities.Standard());

    private static RbpJournalStore Open(RbpJournalTestDirectory directory) =>
        RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());

    private static Task RegisterAsync(RbpJournalStore store) =>
        store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
}
