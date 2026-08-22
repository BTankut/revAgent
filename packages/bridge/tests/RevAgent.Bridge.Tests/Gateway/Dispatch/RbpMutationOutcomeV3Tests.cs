using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

public sealed class RbpMutationOutcomeV3Tests
{
    private const string Rsid = "rs-test";
    private const string FirstInvocation =
        "0197a3c2-0000-7000-8000-000000000301";
    private const string SecondInvocation =
        "0197a3c2-0000-7000-8000-000000000302";
    private const string ThirdInvocation =
        "0197a3c2-0000-7000-8000-000000000303";

    [Fact]
    public async Task JsonRpcErrorWithoutEffectTruthInstallsHoldAndBlocksConflict()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        RbpAddinOutcome error = ReduceJsonRpcError(FirstInvocation);
        Assert.Equal(RbpAddinOutcomeKind.PossiblyDispatched, error.Kind);
        Assert.Equal(
            RbpDispatchState.ResponseObserved,
            error.OutcomeEvidence!.DispatchState);
        Assert.Equal(RbpEffectState.Unknown, error.OutcomeEvidence.EffectState);

        var channel = new CountingChannel(error);
        var dispatcher = new RbpInvocationDispatcher(
            store,
            channel,
            new RbpInFlightGate());
        RbpInvocationAnswer first = await dispatcher.DispatchAsync(
            DynamicWrite(FirstInvocation),
            CancellationToken.None);
        RbpInvocationAnswer blocked = await dispatcher.DispatchAsync(
            DynamicWrite(SecondInvocation),
            CancellationToken.None);

        Assert.Equal(1, channel.Calls);
        Assert.Equal(
            "journal_indeterminate",
            first.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(
            first.Payload.GetProperty("verification_hold_id").GetString(),
            blocked.Payload.GetProperty("verification_hold_id").GetString());
        Assert.False(blocked.Payload.GetProperty("replayed").GetBoolean());

        RbpOutcomeV3Snapshot snapshot =
            (await store.GetOutcomeV3Async(Rsid + "/" + FirstInvocation))!;
        Assert.Equal("response_observed", snapshot.DispatchState);
        Assert.Equal("unknown", snapshot.EffectState);
        Assert.Equal("indeterminate", snapshot.TerminalState);
    }

    [Fact]
    public async Task ManualCommitThenThrowEvidenceIsIndeterminateNotReplayable()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        RbpAddinOutcome committedError = ReduceHandlerResult(
            FirstInvocation,
            success: false,
            effectState: "committed",
            errorMessage: "manual commit completed before throw");
        var channel = new CountingChannel(committedError);
        var dispatcher = new RbpInvocationDispatcher(
            store,
            channel,
            new RbpInFlightGate());

        RbpInvocationAnswer answer = await dispatcher.DispatchAsync(
            DynamicWrite(FirstInvocation),
            CancellationToken.None);

        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "journal_indeterminate",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.False(answer.Payload.GetProperty("retryable").GetBoolean());
        Assert.Equal(1, channel.Calls);
        Assert.Equal(
            RbpInvocationState.Indeterminate,
            (await store.GetInvocationAsync(Rsid + "/" + FirstInvocation))!
                .State);
    }

    [Fact]
    public async Task AutoRollbackEvidenceIsKnownFailedWithoutHold()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var dispatcher = new RbpInvocationDispatcher(
            store,
            new CountingChannel(
                ReduceHandlerResult(
                    FirstInvocation,
                    success: false,
                    effectState: "rolled_back",
                    errorMessage: "auto transaction rolled back")),
            new RbpInFlightGate());

        RbpInvocationAnswer answer = await dispatcher.DispatchAsync(
            DynamicWrite(FirstInvocation),
            CancellationToken.None);

        Assert.Equal("error", answer.Type);
        Assert.Equal("known", answer.Payload.GetProperty("outcome").GetString());
        RbpStoredInvocation stored =
            (await store.GetInvocationAsync(Rsid + "/" + FirstInvocation))!;
        Assert.Equal(RbpInvocationState.Failed, stored.State);
        Assert.Null(stored.VerificationHoldId);
        Assert.Null(await store.FindConflictingHoldAsync(
            Rsid,
            stored.Identity.MutationScopeJcs!));
        Assert.Equal(
            "rolled_back",
            (await store.GetOutcomeV3Async(stored.Identity.IdempotencyKey))!
                .EffectState);
    }

    [Fact]
    public async Task SuccessfulCommittedMutationRemainsTerminal()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var dispatcher = new RbpInvocationDispatcher(
            store,
            new CountingChannel(
                ReduceHandlerResult(
                    FirstInvocation,
                    success: true,
                    effectState: "committed")),
            new RbpInFlightGate());

        RbpInvocationAnswer answer = await dispatcher.DispatchAsync(
            DynamicWrite(FirstInvocation),
            CancellationToken.None);

        Assert.Equal("result", answer.Type);
        Assert.Equal("completed", answer.Payload.GetProperty("status").GetString());
        RbpStoredInvocation stored =
            (await store.GetInvocationAsync(Rsid + "/" + FirstInvocation))!;
        Assert.Equal(RbpInvocationState.Completed, stored.State);
        Assert.Null(stored.VerificationHoldId);
        Assert.Equal(
            "committed",
            (await store.GetOutcomeV3Async(stored.Identity.IdempotencyKey))!
                .EffectState);
    }

    [Fact]
    public async Task NestedCommittedApplicationFailureInstallsHold()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        RbpAddinOutcome outcome = ReduceHandlerResult(
            FirstInvocation,
            success: true,
            effectState: "committed",
            nestedResult: new JObject
            {
                ["success"] = false,
                ["error"] = "nested application failure",
            });
        var dispatcher = new RbpInvocationDispatcher(
            store,
            new CountingChannel(outcome),
            new RbpInFlightGate());

        RbpInvocationAnswer answer = await dispatcher.DispatchAsync(
            DynamicWrite(FirstInvocation),
            CancellationToken.None);

        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "journal_indeterminate",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.NotNull(
            await store.GetHoldAsync(
                Rsid,
                answer.Payload
                    .GetProperty("verification_hold_id")
                    .GetString()!));
    }

    [Fact]
    public async Task ForgedNativeNoneRollbackEvidenceRemainsUnknown()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        RbpAddinOutcome forged = ReduceHandlerResult(
            FirstInvocation,
            success: false,
            effectState: "rolled_back",
            errorMessage: "caller claims rollback",
            transactionMode: "none");
        Assert.Equal(RbpEffectState.Unknown, forged.OutcomeEvidence!.EffectState);
        var dispatcher = new RbpInvocationDispatcher(
            store,
            new CountingChannel(forged),
            new RbpInFlightGate());

        RbpInvocationAnswer answer = await dispatcher.DispatchAsync(
            DynamicWrite(
                FirstInvocation,
                transactionMode: "none"),
            CancellationToken.None);

        Assert.Equal(
            "journal_indeterminate",
            answer.Payload.GetProperty("fault_class").GetString());
    }

    [Fact]
    public async Task UnknownExplicitTransactionModeFailsBeforeDispatch()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new CountingChannel(
            ReduceHandlerResult(
                FirstInvocation,
                success: true,
                effectState: "committed"));
        var dispatcher = new RbpInvocationDispatcher(
            store,
            channel,
            new RbpInFlightGate());

        RbpInvocationAnswer answer = await dispatcher.DispatchAsync(
            DynamicWrite(
                FirstInvocation,
                transactionMode: "mystery"),
            CancellationToken.None);

        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "protocol",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(0, channel.Calls);
    }

    [Theory]
    [InlineData("ERROR: direct failure")]
    [InlineData("\"ERROR: encoded once\"")]
    [InlineData("\"\\\"ERROR: encoded twice\\\"\"")]
    public void ErrorStringsAreDecodedAtMostTwice(string nested)
    {
        var body = new JObject
        {
            ["success"] = true,
            ["result"] = nested,
        };
        Assert.StartsWith(
            "ERROR:",
            RbpRoutedInvocationChannel.ReadApplicationFailure(body));
    }

    [Fact]
    public async Task PersistenceReadbackMismatchRetainsLeaseAndQuarantines()
    {
        using var directory = new RbpJournalTestDirectory();
        var fault = new CorruptingPostCommitFault(
            directory.JournalPath,
            Rsid + "/" + FirstInvocation);
        await using RbpJournalStore store =
            await OpenAsync(directory, fault);
        var lease = new TrackingLease();
        RbpAddinOutcome outcome = ReduceHandlerResult(
            FirstInvocation,
            success: true,
            effectState: "committed") with
        {
            Lease = lease,
        };
        var channel = new ArmingChannel(outcome, fault.Arm);
        var dispatcher = new RbpInvocationDispatcher(
            store,
            channel,
            new RbpInFlightGate());

        _ = await Assert.ThrowsAsync<RbpJournalException>(
            () => dispatcher.DispatchAsync(
                DynamicWrite(FirstInvocation),
                CancellationToken.None));

        Assert.Equal(0, lease.Releases);
        Assert.Equal(
            1,
            await store.ReadAsync(
                connection =>
                {
                    using SqliteCommand command = connection.CreateCommand();
                    command.CommandText =
                        "SELECT COUNT(*) FROM rbp_outcome_quarantine_v3 " +
                        "WHERE rsid='rs-test';";
                    return Convert.ToInt32(command.ExecuteScalar());
                }));
    }

    [Fact]
    public async Task RestartImportsLegacyFailedMutationAsHoldBeforeReplay()
    {
        using var directory = new RbpJournalTestDirectory();
        string key = Rsid + "/" + FirstInvocation;
        await using (RbpJournalStore legacy = await OpenAsync(directory))
        {
            RbpInvocationIdentity identity =
                DynamicWrite(FirstInvocation).ToIdentity();
            _ = await legacy.AdmitInvocationAsync(identity);
            await legacy.MarkInvocationExecutingAsync(key);
            JsonElement body = RbpInvocationPayloads.KnownError(
                FirstInvocation,
                "revit_api",
                retryable: false,
                "legacy failure without effect proof");
            _ = await legacy.PersistInvocationTerminalAsync(
                key,
                new RbpInvocationTerminal(
                    RbpInvocationState.Failed,
                    body,
                    Rfc8785Json.Sha256Digest(body)));
        }

        await using RbpJournalStore reopened = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        var channel = new CountingChannel(
            ReduceHandlerResult(
                FirstInvocation,
                success: true,
                effectState: "committed"));
        var dispatcher = new RbpInvocationDispatcher(
            reopened,
            channel,
            new RbpInFlightGate());

        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(
            DynamicWrite(FirstInvocation),
            CancellationToken.None);

        Assert.Equal(0, channel.Calls);
        Assert.Equal(
            "journal_indeterminate",
            replay.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(
            RbpInvocationState.Indeterminate,
            (await reopened.GetInvocationAsync(key))!.State);
        RbpOutcomeV3Cutover marker =
            (await reopened.GetOutcomeV3CutoverAsync(Rsid))!;
        Assert.Equal("bridge-outcome-v3", marker.TargetGeneration);
        Assert.Equal("normalized_authoritative", marker.State);
        Assert.True(marker.ImportedDispatchCount >= 1);
        Assert.True(marker.ImportedHoldCount >= 1);
    }

    [Fact]
    public async Task AtomicDispatchLossRetainsEachDistinctBatchMutationScope()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        BatchStepSpec first = new(
            FirstInvocation,
            RbpBatchCoordinatorTestData.WriteMethod,
            "{}",
            Mutating: true,
            MutationScopeJson:
                """{"document_id":"doc-1","kind":"document"}""",
            PolicyClass: "confirm",
            Decision: "confirmed",
            ConfirmationId: "0197a3c2-0000-7000-8000-000000000311");
        BatchStepSpec second = first with
        {
            InvocationId = SecondInvocation,
            MutationScopeJson =
                """{"document_id":"doc-2","kind":"document"}""",
        };
        const string batchId =
            "0197a3c2-0000-7000-8000-000000000312";
        var channel = new StubBatchChannel().Then(
            RbpBatchCoordinatorTestData.PossiblyDispatched());
        var coordinator = new RbpBatchCoordinator(
            store,
            channel,
            StubBatchCapabilities.Standard(batchAtomicGranted: true));

        RbpInvocationAnswer answer = await coordinator.DispatchAsync(
            Rsid,
            RbpBatchCoordinatorTestData.Payload(
                batchId,
                atomic: true,
                new[] { first, second }),
            CancellationToken.None);

        Assert.Equal("indeterminate", answer.Payload.GetProperty("status").GetString());
        RbpVerificationHold holdOne = (await store.FindConflictingHoldAsync(
            Rsid,
            Rfc8785Json.Canonicalize(
                RbpBatchCoordinatorTestData.Json(first.MutationScopeJson!))))!;
        RbpVerificationHold holdTwo = (await store.FindConflictingHoldAsync(
            Rsid,
            Rfc8785Json.Canonicalize(
                RbpBatchCoordinatorTestData.Json(second.MutationScopeJson!))))!;
        Assert.NotEqual(holdOne.VerificationHoldId, holdTwo.VerificationHoldId);
        Assert.Equal(
            new[] { Rsid + "/" + FirstInvocation },
            holdOne.OrderedOriginIdempotencyKeys);
        Assert.Equal(
            new[] { Rsid + "/" + SecondInvocation },
            holdTwo.OrderedOriginIdempotencyKeys);
        Assert.Equal(
            "indeterminate",
            (await store.GetOutcomeV3Async(Rsid + "/" + FirstInvocation))!
                .TerminalState);
        Assert.Equal(
            "indeterminate",
            (await store.GetOutcomeV3Async(Rsid + "/" + SecondInvocation))!
                .TerminalState);
    }

    [Fact]
    public async Task EvidenceBoundClearanceAndNextAdmissionCommitAtomically()
    {
        const string verificationId =
            "0197a3c2-0000-7000-8000-000000000331";
        const string resolutionId =
            "0197a3c2-0000-7000-8000-000000000332";
        const string auditId =
            "0197a3c2-0000-7000-8000-000000000333";
        const string evidenceDigest =
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var firstDispatcher = new RbpInvocationDispatcher(
            store,
            new CountingChannel(ReduceJsonRpcError(FirstInvocation)),
            new RbpInFlightGate());
        RbpInvocationAnswer first = await firstDispatcher.DispatchAsync(
            DynamicWrite(FirstInvocation),
            CancellationToken.None);
        string holdId = first.Payload
            .GetProperty("verification_hold_id")
            .GetString()!;
        _ = await store.RecordHoldVerificationEvidenceAsync(
            Rsid,
            new RbpHoldVerificationEvidence(
                holdId,
                verificationId,
                evidenceDigest,
                Conclusive: true));

        string clearances = $$"""
        [{"hold_id":"{{holdId}}","mutation_scope":{"document_id":"doc-1","kind":"document"},"resolution_id":"{{resolutionId}}","basis":"verification_read","verification_invocation_id":"{{verificationId}}","evidence_digest":"{{evidenceDigest}}","decision":"postcondition_verified","audit_id":"{{auditId}}"}]
        """;
        var secondDispatcher = new RbpInvocationDispatcher(
            store,
            new CountingChannel(
                ReduceHandlerResult(
                    SecondInvocation,
                    success: true,
                    effectState: "committed")),
            new RbpInFlightGate());

        RbpInvocationAnswer accepted = await secondDispatcher.DispatchAsync(
            DynamicWrite(SecondInvocation, clearances),
            CancellationToken.None);

        Assert.Equal("result", accepted.Type);
        RbpVerificationHold hold = (await store.GetHoldAsync(Rsid, holdId))!;
        Assert.Equal(RbpHoldState.Cleared, hold.State);
        RbpOutcomeV3ResolutionSnapshot resolution =
            (await store.GetOutcomeV3ResolutionAsync(resolutionId))!;
        Assert.Equal("accepted", resolution.State);
        Assert.Equal(verificationId, resolution.VerificationInvocationId);
        Assert.Equal(
            RbpInvocationState.Completed,
            (await store.GetInvocationAsync(Rsid + "/" + SecondInvocation))!
                .State);

        var thirdDispatcher = new RbpInvocationDispatcher(
            store,
            new CountingChannel(ReduceJsonRpcError(ThirdInvocation)),
            new RbpInFlightGate());
        RbpInvocationAnswer third = await thirdDispatcher.DispatchAsync(
            DynamicWrite(ThirdInvocation),
            CancellationToken.None);
        string nextHoldId = third.Payload
            .GetProperty("verification_hold_id")
            .GetString()!;
        Assert.NotEqual(holdId, nextHoldId);
        Assert.Equal(
            RbpHoldState.Cleared,
            (await store.GetHoldAsync(Rsid, holdId))!.State);
        Assert.Equal(
            RbpHoldState.Active,
            (await store.GetHoldAsync(Rsid, nextHoldId))!.State);
        Assert.Equal(
            "accepted",
            (await store.GetOutcomeV3ResolutionAsync(resolutionId))!.State);
    }

    [Theory]
    [MemberData(nameof(InvalidClearances))]
    public void ResolutionVerificationIdMatrixFailsClosed(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        _ = Assert.Throws<FormatException>(
            () => RbpRecoveryClearance.Parse(document.RootElement));
    }

    public static TheoryData<string> InvalidClearances()
    {
        string verification = ValidClearance("verification_read", $"\"{FirstInvocation}\"");
        string late = ValidClearance("late_terminal", "null");
        return new TheoryData<string>
        {
            verification.Replace(
                $",\"verification_invocation_id\":\"{FirstInvocation}\"",
                string.Empty,
                StringComparison.Ordinal),
            verification.Replace(
                $"\"{FirstInvocation}\"",
                "null",
                StringComparison.Ordinal),
            verification.Replace(
                FirstInvocation,
                "0197a3c2-0000-4000-8000-000000000301",
                StringComparison.Ordinal),
            verification.Replace(
                FirstInvocation,
                "0197A3C2-0000-7000-8000-000000000301",
                StringComparison.Ordinal),
            verification.Replace(
                FirstInvocation,
                "not-a-uuid",
                StringComparison.Ordinal),
            late.Replace(
                "\"verification_invocation_id\":null",
                $"\"verification_invocation_id\":\"{FirstInvocation}\"",
                StringComparison.Ordinal),
            late.Replace(
                ",\"verification_invocation_id\":null",
                string.Empty,
                StringComparison.Ordinal),
        };
    }

    private static string ValidClearance(string basis, string verificationId) =>
        $$"""
        {"hold_id":"vh:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mutation_scope":{"document_id":"doc-1","kind":"document"},"resolution_id":"0197a3c2-0000-7000-8000-000000000321","basis":"{{basis}}","verification_invocation_id":{{verificationId}},"evidence_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","decision":"postcondition_verified","audit_id":"0197a3c2-0000-7000-8000-000000000322"}
        """;

    private static RbpAddinOutcome ReduceJsonRpcError(string invocationId)
    {
        var envelope = new JObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = invocationId,
            ["error"] = new JObject
            {
                ["code"] = -32603,
                ["message"] = "manual transaction threw",
            },
        };
        byte[] raw = Encoding.UTF8.GetBytes(
            envelope.ToString(Newtonsoft.Json.Formatting.None));
        AddinJsonRpcResponse response =
            AddinJsonRpcCodec.ParseResponse(raw, invocationId);
        return Reduce(response, invocationId);
    }

    private static RbpAddinOutcome ReduceHandlerResult(
        string invocationId,
        bool success,
        string effectState,
        string? errorMessage = null,
        string transactionMode = "auto",
        JToken? nestedResult = null)
    {
        var result = new JObject
        {
            ["resultContractVersion"] = 2,
            ["success"] = success,
            ["result"] = nestedResult ?? new JObject { ["ok"] = success },
            ["errorMessage"] = errorMessage ?? string.Empty,
            ["outcomeEvidence"] = new JObject
            {
                ["schema"] = RbpMutationOutcomeEvidence.Schema,
                ["effectState"] = effectState,
                ["transactionMode"] = transactionMode,
                ["evidence"] = new JObject
                {
                    ["source"] = "execute_dynamic_code",
                    ["transactionStatus"] = effectState,
                },
            },
        };
        var envelope = new JObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = invocationId,
            ["result"] = result,
        };
        byte[] raw = Encoding.UTF8.GetBytes(envelope.ToString(Newtonsoft.Json.Formatting.None));
        AddinJsonRpcResponse response =
            AddinJsonRpcCodec.ParseResponse(raw, invocationId);
        return Reduce(response, invocationId, transactionMode);
    }

    private static RbpAddinOutcome Reduce(
        AddinJsonRpcResponse response,
        string invocationId,
        string transactionMode = "auto")
    {
        var call = new AddinCall(
            invocationId,
            "send_code_to_revit",
            new JObject
            {
                ["code"] = "return null;",
                ["transactionMode"] = transactionMode,
                ["nativeOutcomeEvidenceConformance"] =
                    transactionMode == "none"
                        ? RbpMutationOutcomeEvidence.NativeConformance
                        : null,
            },
            TimeSpan.FromSeconds(30));
        var result = new AddinCallResult(
            response,
            new AddinTransportEvidence(
                AddinDispatchState.ResponseObserved,
                RequestPayloadBytes: 128,
                RequestFrameBytes: 132,
                BytesWrittenLowerBound: 132,
                RequestFullyWritten: true,
                ResponseBytesObserved: response.RawPayload.Length));
        return RbpRoutedInvocationChannel.FromResponse(
            result,
            new TestLease(),
            call);
    }

    private static RbpInvokeRequest DynamicWrite(
        string invocationId,
        string recoveryClearances = "[]",
        string transactionMode = "auto")
    {
        using JsonDocument document = JsonDocument.Parse(
            $$"""
            {
              "invocation_id":"{{invocationId}}",
              "method":"send_code_to_revit",
              "params":{"code":"return null;","transactionMode":"{{transactionMode}}"{{(transactionMode == "none" ? ",\"nativeOutcomeEvidenceConformance\":\"revagent.mutation-outcome/v1\"" : string.Empty)}}},
              "timeout_ms":120000,
              "mutating":true,
              "mutation_scope":{"document_id":"doc-1","kind":"document"},
              "policy":{"class":"confirm","decision":"confirmed","confirmation_id":"0197a3c2-0000-7000-8000-000000000399"},
              "verification":null,
              "recovery_clearances":{{recoveryClearances}}
            }
            """);
        return RbpInvokeRequest.Parse(Rsid, document.RootElement.Clone());
    }

    private static async Task<RbpJournalStore> OpenAsync(
        RbpJournalTestDirectory directory,
        IRbpJournalFaultInjector? faultInjector = null)
    {
        RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            new RbpJournalOpenOptions(
                NowMilliseconds: () =>
                    RbpJournalTestData.Now.ToUnixTimeMilliseconds(),
                FaultInjector: faultInjector));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        return store;
    }

    private sealed class CountingChannel(RbpAddinOutcome outcome)
        : IRbpInvocationChannel
    {
        private int _calls;
        internal int Calls => Volatile.Read(ref _calls);

        public Task<RbpAddinOutcome> InvokeAsync(
            string rsid,
            AddinCall call,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _calls);
            return Task.FromResult(outcome);
        }
    }

    private sealed class TestLease : IRbpDispatchLease
    {
        public void ReleaseAfterDurableDecision()
        {
        }
    }

    private sealed class TrackingLease : IRbpDispatchLease
    {
        private int _releases;
        internal int Releases => Volatile.Read(ref _releases);

        public void ReleaseAfterDurableDecision() =>
            Interlocked.Increment(ref _releases);
    }

    private sealed class ArmingChannel(
        RbpAddinOutcome outcome,
        Action arm) : IRbpInvocationChannel
    {
        public Task<RbpAddinOutcome> InvokeAsync(
            string rsid,
            AddinCall call,
            CancellationToken cancellationToken)
        {
            arm();
            return Task.FromResult(outcome);
        }
    }

    private sealed class CorruptingPostCommitFault(
        string journalPath,
        string idempotencyKey) : IRbpJournalFaultInjector
    {
        private int _armed;
        internal void Arm() => Interlocked.Exchange(ref _armed, 1);

        public void Hit(RbpJournalFaultPoint point)
        {
            if (point != RbpJournalFaultPoint.AfterCommitBeforeReturn ||
                Interlocked.Exchange(ref _armed, 0) == 0)
            {
                return;
            }

            using var connection = new SqliteConnection(
                new SqliteConnectionStringBuilder
                {
                    DataSource = journalPath,
                    Mode = SqliteOpenMode.ReadWrite,
                    Pooling = false,
                }.ToString());
            connection.Open();
            using SqliteCommand corrupt = connection.CreateCommand();
            corrupt.CommandText =
                "UPDATE rbp_outcome_dispatch_v3 SET result_digest=$digest " +
                "WHERE idempotency_key=$key;";
            corrupt.Parameters.AddWithValue(
                "$digest",
                "sha256:" + new string('e', 64));
            corrupt.Parameters.AddWithValue("$key", idempotencyKey);
            _ = corrupt.ExecuteNonQuery();
            throw new IOException("Injected corrupt post-commit read-back.");
        }
    }
}
