using System.Text;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

/// <summary>
/// Frozen O1 conformance for invocation execution: the Section 12.1 durability
/// ordering as observed from the dispatch path, every Section 12.2 redelivery
/// rule, the Section 10.1 single-flight rule, and the Section 15 promotion of
/// an uncertain mutation to <c>journal_indeterminate</c>.
/// </summary>
public sealed class RbpInvocationDispatcherTests
{
    private const string ReadMethod = "get_current_view_info";
    private const string WriteMethod = "create_wall";
    private const string Rsid = "rs-test";

    [Fact]
    public async Task ReceivedIsDurableBeforeTheFirstAddinByte()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);

        RbpStoredInvocation? observedAtDispatch = null;
        var channel = new StubChannel(
            onInvoke: async () =>
            {
                // Section 12.1 step 1: by the time the channel is entered the
                // journal must already hold the row. Reading it from inside the
                // dispatch callback is the only way to prove the ordering
                // rather than assume it.
                observedAtDispatch = await store.GetInvocationAsync(
                    Rsid + "/" + ReadRequest().InvocationId);
                return Completed("""{"ok":true}""");
            });

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                ReadRequest(),
                CancellationToken.None);

        Assert.Equal("result", answer.Type);
        Assert.NotNull(observedAtDispatch);
        Assert.Equal(
            RbpInvocationState.Executing,
            observedAtDispatch!.State);
    }

    [Fact]
    public async Task TerminalOutcomeIsDurableBeforeTheAnswerIsReturned()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(
            () => Task.FromResult(Completed("""{"ok":true}""")));

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                ReadRequest(),
                CancellationToken.None);

        // Section 12.1 step 3.
        RbpStoredInvocation? stored = await store.GetInvocationAsync(
            Rsid + "/" + ReadRequest().InvocationId);
        Assert.Equal(RbpInvocationState.Completed, stored!.State);
        Assert.NotNull(stored.TerminalOutcomeJson);
        Assert.Equal("result", answer.Type);
        Assert.Equal(
            "completed",
            answer.Payload.GetProperty("status").GetString());
        Assert.False(answer.Payload.GetProperty("replayed").GetBoolean());
    }

    [Fact]
    public async Task ResultDigestCoversTheRawAddinResponseBytes()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await RbpCorrelatedVerificationFlowTests
            .OpenForRoute(directory, fixture);
        RbpInvocationDispatcher dispatcher = Dispatcher(store, fixture.Channel);
        RbpInvocationAnswer mutation = await dispatcher.DispatchAsync(
            RbpApplicationErrorSafetyTests.Request(mutating: true),
            CancellationToken.None);
        string holdId = mutation.Payload.GetProperty("verification_hold_id").GetString()!;
        fixture.Transport.SetResponse("{\"ok\":true}");
        RbpInvokeRequest request = RbpCorrelatedVerificationFlowTests.VerificationRequest(
            "0197a3c2-0000-7000-8000-0000000000e1",
            holdId);

        // Section 10.3 requires the digest on a terminal read that carries a
        // Section 6.2.1 verification correlation.
        RbpInvocationAnswer answer =
            await dispatcher.DispatchAsync(
                request,
                CancellationToken.None);

        string expected = "sha256:" + Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(fixture.Transport.LastBytes))
            .ToLowerInvariant();
        Assert.Equal(
            expected,
            answer.Payload.GetProperty("result_digest").GetString());
    }

    [Fact]
    public async Task Rule1ReplaysATerminalRowWithoutCallingTheAddin()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(
            () => Task.FromResult(Completed("""{"ok":true}""")));
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);
        _ = await dispatcher.DispatchAsync(
            ReadRequest(),
            CancellationToken.None);
        Assert.Equal(1, channel.Calls);

        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(
            ReadRequest(),
            CancellationToken.None);

        Assert.Equal(1, channel.Calls);
        Assert.Equal("result", replay.Type);
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());
        Assert.False(
            replay.Payload
                .GetProperty("late_after_indeterminate")
                .GetBoolean());
    }

    [Fact]
    public async Task CarrierPlanIsDurableBeforeTerminalAndReplaysItsExactPrefixes()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        string payload = new('x', RbpArtifactCarrierProducer.MaximumChunkBytes + 1);
        var channel = new StubChannel(
            () => Task.FromResult(Completed(
                JsonSerializer.Serialize(new { payload }))));
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        var dispatcher = new RbpInvocationDispatcher(
            store,
            channel,
            new RbpInFlightGate(),
            carrierProducer: producer);

        using IRbpInvocationClaim claim = Assert.IsAssignableFrom<IRbpInvocationClaim>(
            dispatcher.TryClaim(Rsid));
        RbpInvocationAnswer first = await dispatcher.DispatchClaimedAsync(
            claim,
            ReadPayload(),
            new[] { "journal_v1", "chunked_results", "artifact_result_v1" },
            CancellationToken.None);

        RbpStoredInvocation stored = Assert.IsType<RbpStoredInvocation>(
            await store.GetInvocationAsync(Rsid + "/" + ReadRequest().InvocationId));
        RbpCarrierPlan plan = Assert.IsType<RbpCarrierPlan>(stored.CarrierPlan);
        Assert.Equal(plan.CarrierKey, first.CarrierKey);
        Assert.Equal(plan.OrderedPrefixes.Count, first.Prefixes!.Count);
        Assert.Equal(
            plan.OrderedPrefixes.Select(frame => frame.Payload.GetRawText()),
            first.Prefixes.Select(frame => frame.Payload.GetRawText()));
        Assert.Equal(plan.TerminalPayload.GetRawText(), first.Payload.GetRawText());
        Assert.NotNull(stored.TerminalOutcomeJson);
        claim.Dispose();

        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(
            ReadRequest(), CancellationToken.None);
        Assert.Equal(1, channel.Calls);
        Assert.Equal(plan.CarrierKey, replay.CarrierKey);
        Assert.Equal(
            plan.OrderedPrefixes.Select(frame => frame.Payload.GetRawText()),
            replay.Prefixes!.Select(frame => frame.Payload.GetRawText()));
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());
    }

    [Fact]
    public async Task CarrierPlanAndTerminalRetryTogetherAfterExactRollbackReadback()
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new ArmedJournalFaultInjector();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(faultInjector: faults));
        _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        string payload = new('x', RbpArtifactCarrierProducer.MaximumChunkBytes + 1);
        var channel = new StubChannel(
            () =>
            {
                faults.Arm(RbpJournalFaultPoint.BeforeCommit);
                return Task.FromResult(Completed(JsonSerializer.Serialize(new { payload })));
            });
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        var dispatcher = new RbpInvocationDispatcher(
            store, channel, new RbpInFlightGate(), carrierProducer: producer);
        using IRbpInvocationClaim claim = Assert.IsAssignableFrom<IRbpInvocationClaim>(
            dispatcher.TryClaim(Rsid));

        _ = await dispatcher.DispatchClaimedAsync(
            claim,
            ReadPayload(),
            new[] { "journal_v1", "chunked_results", "artifact_result_v1" },
            CancellationToken.None);

        RbpStoredInvocation stored = Assert.IsType<RbpStoredInvocation>(
            await store.GetInvocationAsync(Rsid + "/" + ReadRequest().InvocationId));
        Assert.Equal(RbpInvocationState.Completed, stored.State);
        Assert.NotNull(stored.CarrierPlan);
        Assert.Equal(1, channel.Calls);
        int plans = await store.ReadAsync(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM rbp_carrier_plans;";
            return Convert.ToInt32(command.ExecuteScalar(),
                System.Globalization.CultureInfo.InvariantCulture);
        });
        Assert.Equal(1, plans);
    }

    [Fact]
    public async Task CarrierAckCleansSpoolButRetainsExactPlanForDuplicateReplay()
    {
        using var directory = new RbpJournalTestDirectory();
        long now = RbpJournalTestData.Now.ToUnixTimeMilliseconds();
        var faults = new ArmedJournalFaultInjector();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(
                faultInjector: faults,
                nowMilliseconds: () => now));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        string payload = new('x', RbpArtifactCarrierProducer.MaximumChunkBytes + 1);
        var channel = new StubChannel(
            () => Task.FromResult(Completed(JsonSerializer.Serialize(new { payload }))));
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        var dispatcher = new RbpInvocationDispatcher(
            store, channel, new RbpInFlightGate(), carrierProducer: producer);
        using IRbpInvocationClaim claim = Assert.IsAssignableFrom<IRbpInvocationClaim>(
            dispatcher.TryClaim(Rsid));
        RbpInvocationAnswer answer = await dispatcher.DispatchClaimedAsync(
            claim, ReadPayload(),
            new[] { "journal_v1", "chunked_results", "artifact_result_v1" },
            CancellationToken.None);
        RbpCarrierPlan plan = Assert.IsType<RbpCarrierPlan>((await store
            .GetInvocationAsync(Rsid + "/" + ReadRequest().InvocationId))!.CarrierPlan);

        int ordinal = 0;
        foreach (RbpInvocationAnswer prefix in answer.Prefixes!)
        {
            _ = await store.QueueOutboundDataAsync(Rsid, new RbpOutboundDataDraft(
                prefix.Type, "prefix-" + ordinal++, prefix.Payload));
        }
        RbpQueueOutboundResult terminal = await store.QueueOutboundDataAsync(
            Rsid,
            new RbpOutboundDataDraft("result", "terminal", answer.Payload));
        long terminalSequence = Assert.IsType<RbpDataEnvelopeSnapshot>(terminal.Envelope)
            .Sequence;
        await store.RecordCarrierTerminalQueuedAsync(
            plan.CarrierKey, Rsid, terminalSequence);
        producer.RecordTerminalQueued(plan.CarrierKey, Rsid, terminalSequence);
        string carrierRoot = Path.Combine(
            directory.Path, "artifact-spool", plan.CarrierKey);

        Assert.Empty(await store.ApplyCarrierPlanAcknowledgementsAsync(
            new[] { new RbpSessionAcknowledgement(Rsid, terminalSequence - 1) }));
        Assert.NotNull((await store.GetInvocationAsync(
            Rsid + "/" + ReadRequest().InvocationId))!.CarrierPlan);

        IReadOnlyList<RbpReleasedCarrier> released =
            await store.ApplyCarrierPlanAcknowledgementsAsync(
                new[] { new RbpSessionAcknowledgement(Rsid, terminalSequence) });
        RbpReleasedCarrier release = Assert.Single(released);
        Assert.Equal(plan.CarrierKey, release.CarrierKey);
        Assert.Equal(Rsid, release.Rsid);
        Assert.Equal(terminalSequence, release.TerminalSequence);
        // Crash after the ACK transaction but before cleanup: the same
        // pending token is reissued, not a second release identity.
        RbpReleasedCarrier reissued = Assert.Single(
            await store.ApplyCarrierPlanAcknowledgementsAsync(
                new[] { new RbpSessionAcknowledgement(Rsid, terminalSequence) }));
        Assert.Equal(release.ReleaseToken, reissued.ReleaseToken);
        producer.SweepExpired(released);
        Assert.False(Directory.Exists(carrierRoot));
        // Crash after delete but before confirmation: absent cleanup is safe
        // and the durable pending token can be confirmed exactly once.
        producer.SweepExpired(new[] { reissued });
        await Assert.ThrowsAsync<RbpJournalException>(() =>
            store.ConfirmSpoolReleasedAsync(reissued with
            {
                ReleaseToken = "v1:mismatched-release-token",
            }));
        await store.ConfirmSpoolReleasedAsync(reissued);
        Assert.Empty(await store.ApplyCarrierPlanAcknowledgementsAsync(
            new[] { new RbpSessionAcknowledgement(Rsid, terminalSequence) }));
        await store.ConfirmSpoolReleasedAsync(reissued);

        // Acknowledged plans remain in the journal for exact duplicate replay,
        // but restart must not demand the already-released spool fence.
        RbpArtifactCarrierProducer restarted =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        await restarted.RehydrateFencesAsync(CancellationToken.None);
        Assert.False(Directory.Exists(carrierRoot));

        RbpStoredInvocation acknowledged = Assert.IsType<RbpStoredInvocation>(
            await store.GetInvocationAsync(Rsid + "/" + ReadRequest().InvocationId));
        Assert.Equal(plan.PlanId, acknowledged.CarrierPlan!.PlanId);
        claim.Dispose();
        RbpInvocationAnswer duplicate = await dispatcher.DispatchAsync(
            ReadRequest(), CancellationToken.None);
        Assert.Equal(1, channel.Calls);
        Assert.Equal(plan.CarrierKey, duplicate.CarrierKey);
        Assert.Equal(
            plan.OrderedPrefixes.Select(frame => frame.Payload.GetRawText()),
            duplicate.Prefixes!.Select(frame => frame.Payload.GetRawText()));
        Assert.True(duplicate.Payload.GetProperty("replayed").GetBoolean());

        now += (long)TimeSpan.FromDays(8).TotalMilliseconds;
        faults.Arm(RbpJournalFaultPoint.BeforeCommit);
        await Assert.ThrowsAsync<IOException>(() => store.ApplyRetentionAsync(
            RbpJournalStore.MinimumRetentionPeriod));
        Assert.NotNull(await store.GetInvocationAsync(
            Rsid + "/" + ReadRequest().InvocationId));
        Assert.NotNull((await store.GetInvocationAsync(
            Rsid + "/" + ReadRequest().InvocationId))!.CarrierPlan);

        RbpJournalRetentionResult expired = await store.ApplyRetentionAsync(
            RbpJournalStore.MinimumRetentionPeriod);
        Assert.Equal(1, expired.PrunedCarrierPlans);
        Assert.Equal(1, expired.PrunedInvocations);
        RbpReleasedCarrier retainedRelease = Assert.Single(
            expired.ExactReleasedCarriers);
        Assert.Equal(plan.CarrierKey, retainedRelease.CarrierKey);
        Assert.Equal(Rsid, retainedRelease.Rsid);
        Assert.Equal(terminalSequence, retainedRelease.TerminalSequence);
        Assert.Null(await store.GetInvocationAsync(
            Rsid + "/" + ReadRequest().InvocationId));
    }

    [Fact]
    public async Task CarrierReleaseSurvivesBothCleanupCrashWindowsAndRetainsReplayUntilSevenDays()
    {
        using var directory = new RbpJournalTestDirectory();
        long now = RbpJournalTestData.Now.ToUnixTimeMilliseconds();
        string invocationKey = Rsid + "/" + ReadRequest().InvocationId;
        RbpReleasedCarrier committedRelease;
        RbpCarrierPlan plan;
        long terminalSequence;

        // Simulate a process crash immediately after the ACK transaction. The
        // spool remains, but only the durable pending release token may be
        // used after the next open.
        await using (RbpJournalStore first = RbpJournalStore.Open(
                         directory.JournalPath,
                         new TestResumeTokenProtector(),
                         RbpJournalTestData.Options(nowMilliseconds: () => now)))
        {
            _ = await first.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration());
            string payload = new('x', RbpArtifactCarrierProducer.MaximumChunkBytes + 1);
            var channel = new StubChannel(
                () => Task.FromResult(Completed(JsonSerializer.Serialize(new { payload }))));
            RbpArtifactCarrierProducer producer =
                RbpArtifactCarrierProducer.CreateProduction(directory.Path, first);
            var dispatcher = new RbpInvocationDispatcher(
                first, channel, new RbpInFlightGate(), carrierProducer: producer);
            using IRbpInvocationClaim claim = Assert.IsAssignableFrom<IRbpInvocationClaim>(
                dispatcher.TryClaim(Rsid));
            RbpInvocationAnswer answer = await dispatcher.DispatchClaimedAsync(
                claim, ReadPayload(),
                new[] { "journal_v1", "chunked_results", "artifact_result_v1" },
                CancellationToken.None);
            plan = Assert.IsType<RbpCarrierPlan>(
                (await first.GetInvocationAsync(invocationKey))!.CarrierPlan);

            int prefixOrdinal = 0;
            foreach (RbpInvocationAnswer prefix in answer.Prefixes!)
            {
                _ = await first.QueueOutboundDataAsync(Rsid, new RbpOutboundDataDraft(
                    prefix.Type, "prefix-" + prefixOrdinal++, prefix.Payload));
            }

            RbpQueueOutboundResult terminal = await first.QueueOutboundDataAsync(
                Rsid, new RbpOutboundDataDraft("result", "terminal", answer.Payload));
            terminalSequence = Assert.IsType<RbpDataEnvelopeSnapshot>(terminal.Envelope).Sequence;
            await first.RecordCarrierTerminalQueuedAsync(
                plan.CarrierKey, Rsid, terminalSequence);
            producer.RecordTerminalQueued(plan.CarrierKey, Rsid, terminalSequence);
            committedRelease = Assert.Single(await first.ApplyCarrierPlanAcknowledgementsAsync(
                new[] { new RbpSessionAcknowledgement(Rsid, terminalSequence) }));
            Assert.True(Directory.Exists(Path.Combine(
                directory.Path, "artifact-spool", plan.CarrierKey)));
        }

        RbpReleasedCarrier afterAckCrash;
        await using (RbpJournalStore reopenedAfterAck = RbpJournalStore.Open(
                         directory.JournalPath,
                         new TestResumeTokenProtector(),
                         RbpJournalTestData.Options(nowMilliseconds: () => now)))
        {
            afterAckCrash = Assert.Single(
                (await reopenedAfterAck.LoadCarrierRecoveryAsync()).PendingReleases);
            Assert.Equal(committedRelease.ReleaseToken, afterAckCrash.ReleaseToken);
            RbpArtifactCarrierProducer producer =
                RbpArtifactCarrierProducer.CreateProduction(directory.Path, reopenedAfterAck);
            producer.SweepExpired(new[] { afterAckCrash });
            Assert.False(Directory.Exists(Path.Combine(
                directory.Path, "artifact-spool", plan.CarrierKey)));
        }

        // A second crash has now occurred after filesystem cleanup but before
        // the journal confirmation. Reopening must reissue the exact token;
        // repeated cleanup is idempotent and a mismatched token fails closed.
        await using (RbpJournalStore reopenedAfterCleanup = RbpJournalStore.Open(
                         directory.JournalPath,
                         new TestResumeTokenProtector(),
                         RbpJournalTestData.Options(nowMilliseconds: () => now)))
        {
            RbpReleasedCarrier afterCleanupCrash = Assert.Single(
                (await reopenedAfterCleanup.LoadCarrierRecoveryAsync()).PendingReleases);
            Assert.Equal(committedRelease.ReleaseToken, afterCleanupCrash.ReleaseToken);
            RbpArtifactCarrierProducer producer =
                RbpArtifactCarrierProducer.CreateProduction(directory.Path, reopenedAfterCleanup);
            producer.SweepExpired(new[] { afterCleanupCrash });
            await Assert.ThrowsAsync<RbpJournalException>(() =>
                reopenedAfterCleanup.ConfirmSpoolReleasedAsync(afterCleanupCrash with
                {
                    ReleaseToken = "v1:mismatched-release-token",
                }));
            await reopenedAfterCleanup.ConfirmSpoolReleasedAsync(afterCleanupCrash);
            Assert.Empty((await reopenedAfterCleanup.LoadCarrierRecoveryAsync()).PendingReleases);

            var replayChannel = new StubChannel(
                () => Task.FromResult(Completed("""{"should_not_execute":true}""")));
            RbpInvocationAnswer duplicate = await Dispatcher(
                reopenedAfterCleanup, replayChannel).DispatchAsync(
                ReadRequest(), CancellationToken.None);
            Assert.Equal(0, replayChannel.Calls);
            Assert.Equal(plan.CarrierKey, duplicate.CarrierKey);
            Assert.NotEmpty(duplicate.Prefixes!);
            Assert.True(duplicate.Payload.GetProperty("replayed").GetBoolean());

            now += (long)TimeSpan.FromDays(7).TotalMilliseconds - 1;
            Assert.Equal(
                new RbpJournalRetentionResult(0, 0, 0, 0, 0),
                await reopenedAfterCleanup.ApplyRetentionAsync(
                    RbpJournalStore.MinimumRetentionPeriod));
            now += 1;
            RbpJournalRetentionResult expired = await reopenedAfterCleanup.ApplyRetentionAsync(
                RbpJournalStore.MinimumRetentionPeriod);
            Assert.Equal(1, expired.PrunedCarrierPlans);
            Assert.Equal(1, expired.PrunedInvocations);
            Assert.Null(await reopenedAfterCleanup.GetInvocationAsync(invocationKey));
        }
    }

    [Fact]
    public async Task Rule4RefusesToReexecuteAMutationAndInstallsAHold()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);

        // Leave the row in `executing`, which is exactly the state a crash
        // between Section 12.1 steps 2 and 3 produces.
        RbpInvokeRequest write = WriteRequest();
        _ = await store.AdmitInvocationAsync(write.ToIdentity());
        await store.MarkInvocationExecutingAsync(
            write.ToIdentity().IdempotencyKey);

        var channel = new StubChannel(
            () => Task.FromResult(Completed("""{"ok":true}""")));
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                write,
                CancellationToken.None);

        Assert.Equal(0, channel.Calls);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "journal_indeterminate",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.False(answer.Payload.GetProperty("retryable").GetBoolean());
        Assert.Equal(
            "indeterminate",
            answer.Payload.GetProperty("outcome").GetString());
        Assert.True(
            answer.Payload.GetProperty("verification_required").GetBoolean());
        Assert.StartsWith(
            "vh:",
            answer.Payload.GetProperty("verification_hold_id").GetString());
        Assert.True(
            answer.Payload.TryGetProperty("mutation_scope", out _));

        // Section 15 forbids a result digest on this class: there is no
        // durable response to digest.
        Assert.False(answer.Payload.TryGetProperty("result_digest", out _));
    }

    [Fact]
    public async Task Rule3AllowsANonMutatingRetryToExecuteOnceMore()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        RbpInvokeRequest read = ReadRequest();
        _ = await store.AdmitInvocationAsync(read.ToIdentity());
        await store.MarkInvocationExecutingAsync(
            read.ToIdentity().IdempotencyKey);

        var channel = new StubChannel(
            () => Task.FromResult(Completed("""{"ok":true}""")));
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                read,
                CancellationToken.None);

        Assert.Equal(1, channel.Calls);
        Assert.Equal("result", answer.Type);
    }

    [Fact]
    public async Task Rule5TreatsAChangedDigestUnderTheSameKeyAsProtocol()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(
            () => Task.FromResult(Completed("""{"ok":true}""")));
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);
        _ = await dispatcher.DispatchAsync(
            ReadRequest(),
            CancellationToken.None);

        RbpInvocationAnswer answer = await dispatcher.DispatchAsync(
            ReadRequest(parameters: """{"changed":true}"""),
            CancellationToken.None);

        Assert.Equal(1, channel.Calls);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "protocol",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(
            "known",
            answer.Payload.GetProperty("outcome").GetString());
    }

    [Fact]
    public async Task Section101RejectsASecondInFlightInvokeWithoutAddinBytes()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var released = new TaskCompletionSource();
        var entered = new TaskCompletionSource();
        var channel = new StubChannel(async () =>
        {
            entered.TrySetResult();
            await released.Task;
            return Completed("""{"ok":true}""");
        });
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);

        Task<RbpInvocationAnswer> first = dispatcher.DispatchAsync(
            ReadRequest(),
            CancellationToken.None);
        await entered.Task;

        RbpInvocationAnswer second = await dispatcher.DispatchAsync(
            ReadRequest(invocationId: "0197a3c2-0000-7000-8000-0000000000d4"),
            CancellationToken.None);

        // The duplicate is refused before the add-in and before the journal.
        Assert.Equal(1, channel.Calls);
        Assert.Equal("error", second.Type);
        Assert.Equal(
            "protocol",
            second.Payload.GetProperty("fault_class").GetString());
        Assert.Null(
            await store.GetInvocationAsync(
                Rsid + "/0197a3c2-0000-7000-8000-0000000000d4"));

        released.SetResult();
        Assert.Equal("result", (await first).Type);
    }

    [Fact]
    public async Task AnUncertainMutationBecomesJournalIndeterminate()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(
            () => Task.FromResult(PossiblyDispatched("the socket reset")));

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                WriteRequest(),
                CancellationToken.None);

        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "journal_indeterminate",
            answer.Payload.GetProperty("fault_class").GetString());
        RbpStoredInvocation? stored = await store.GetInvocationAsync(
            WriteRequest().ToIdentity().IdempotencyKey);
        Assert.Equal(RbpInvocationState.Indeterminate, stored!.State);
        Assert.NotNull(stored.VerificationHoldId);
    }

    [Fact]
    public async Task AnUncertainReadStaysAKnownEnvironmentFailure()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(
            () => Task.FromResult(PossiblyDispatched("the socket reset")));

        // Re-running a read cannot commit anything, so Section 15's promotion
        // to journal_indeterminate does not apply.
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                ReadRequest(),
                CancellationToken.None);

        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "environment",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(
            "known",
            answer.Payload.GetProperty("outcome").GetString());
        Assert.True(answer.Payload.GetProperty("retryable").GetBoolean());
    }

    [Fact]
    public async Task AGuardedAddinAnswerStaysAResult()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(() => Task.FromResult(
            Completed("""{"detail":"blocked"}""") with
            {
                Kind = RbpAddinOutcomeKind.Guarded,
                GuardedReason = "workset_locked",
            }));

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                WriteRequest(),
                CancellationToken.None);

        // Section 10.3: a guarded add-in result remains a result, not a
        // transport failure.
        Assert.Equal("result", answer.Type);
        Assert.Equal(
            "guarded",
            answer.Payload.GetProperty("status").GetString());
        Assert.Equal(
            "workset_locked",
            answer.Payload.GetProperty("guarded_reason").GetString());
        RbpStoredInvocation? stored = await store.GetInvocationAsync(
            WriteRequest().ToIdentity().IdempotencyKey);
        Assert.Equal(RbpInvocationState.Guarded, stored!.State);
    }

    [Fact]
    public async Task MetricsAlwaysDeclareLengthPrefixedFraming()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(
            () => Task.FromResult(Completed("""{"ok":true}""")));

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                ReadRequest(),
                CancellationToken.None);

        JsonElement metrics = answer.Payload.GetProperty("metrics");
        Assert.Equal("length-prefixed", metrics.GetProperty("framing").GetString());
        Assert.True(metrics.TryGetProperty("execute_ms", out _));
        Assert.True(metrics.TryGetProperty("request_bytes", out _));
        Assert.True(metrics.TryGetProperty("response_bytes", out _));
    }

    [Fact]
    public async Task UnavailableRecoveryIsDurablyTerminalizedAsTheFixedOpaqueWireErrorAndReplays()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(() => Task.FromResult(Completed("{\"unexpected\":true}")));
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);
        RbpInvokeRequest request = RecoveryRequest("0197a3c2-0000-7000-8000-0000000000d1");

        RbpInvocationAnswer first = await dispatcher.DispatchAsync(request, CancellationToken.None);
        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(request, CancellationToken.None);

        Assert.Equal("error", first.Type);
        Assert.Equal("environment", first.Payload.GetProperty("fault_class").GetString());
        Assert.Equal("The correlated recovery payload is unavailable.",
            first.Payload.GetProperty("message").GetString());
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());
        Assert.Equal(first.Payload.GetProperty("fault_class").GetString(),
            replay.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(0, channel.Calls);
        Assert.Equal(RbpInvocationState.Failed,
            (await store.GetInvocationAsync(request.ToIdentity().IdempotencyKey))!.State);
    }

    [Fact]
    public async Task CommittedUnavailableRecoveryTerminalReadbackReturnsTheSameOpaqueWireError()
    {
        using var directory = new RbpJournalTestDirectory();
        await using (RbpJournalStore seed = RbpJournalStore.Open(directory.JournalPath,
                         new TestResumeTokenProtector(), RbpJournalTestData.Options()))
        {
            _ = await seed.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        }
        var faults = new OrdinalJournalFaultInjector(RbpJournalFaultPoint.AfterCommitBeforeReturn, 3);
        await using RbpJournalStore store = RbpJournalStore.Open(directory.JournalPath,
            new TestResumeTokenProtector(), RbpJournalTestData.Options(faultInjector: faults));
        RbpInvokeRequest request = RecoveryRequest("0197a3c2-0000-7000-8000-0000000000d2");
        RbpInvocationAnswer answer = await Dispatcher(store,
            new StubChannel(() => Task.FromResult(Completed("{\"unexpected\":true}"))))
            .DispatchAsync(request, CancellationToken.None);

        Assert.Equal("error", answer.Type);
        Assert.Equal("environment", answer.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(RbpInvocationState.Failed,
            (await store.GetInvocationAsync(request.ToIdentity().IdempotencyKey))!.State);
    }

    [Fact]
    public async Task UncommittedUnavailableRecoveryTerminalFaultThrowsAndNeverReturnsAWireAnswer()
    {
        using var directory = new RbpJournalTestDirectory();
        await using (RbpJournalStore seed = RbpJournalStore.Open(directory.JournalPath,
                         new TestResumeTokenProtector(), RbpJournalTestData.Options()))
        {
            _ = await seed.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        }
        var faults = new OrdinalJournalFaultInjector(RbpJournalFaultPoint.BeforeCommit, 3);
        await using RbpJournalStore store = RbpJournalStore.Open(directory.JournalPath,
            new TestResumeTokenProtector(), RbpJournalTestData.Options(faultInjector: faults));
        RbpInvokeRequest request = RecoveryRequest("0197a3c2-0000-7000-8000-0000000000d3");

        await Assert.ThrowsAsync<IOException>(() => Dispatcher(store,
            new StubChannel(() => Task.FromResult(Completed("{\"unexpected\":true}"))))
            .DispatchAsync(request, CancellationToken.None));
        Assert.Equal(RbpInvocationState.Executing,
            (await store.GetInvocationAsync(request.ToIdentity().IdempotencyKey))!.State);
    }

    private static RbpInvocationDispatcher Dispatcher(
        RbpJournalStore store,
        IRbpInvocationChannel channel) =>
        new(store, channel, new RbpInFlightGate());

    private static JsonElement ReadPayload()
    {
        using JsonDocument document = JsonDocument.Parse(
            """
            {
              "invocation_id":"0197a3c2-0000-7000-8000-0000000000a1",
              "method":"get_current_view_info","params":{"view":"active"},
              "timeout_ms":120000,"mutating":false,"mutation_scope":null,
              "policy":{"class":"auto","decision":"auto","confirmation_id":null},
              "verification":null,"recovery_clearances":[]
            }
            """);
        return document.RootElement.Clone();
    }

    private static async Task<RbpJournalStore> OpenAsync(
        RbpJournalTestDirectory directory)
    {
        RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        return store;
    }

    private static RbpInvokeRequest ReadRequest(
        string invocationId = "0197a3c2-0000-7000-8000-0000000000a1",
        string parameters = """{"view":"active"}""",
        string verification = "null") =>
        Parse(
            $$"""
            {
              "invocation_id": "{{invocationId}}",
              "method": "{{ReadMethod}}",
              "params": {{parameters}},
              "timeout_ms": 120000,
              "mutating": false,
              "mutation_scope": null,
              "policy": {"class":"auto","decision":"auto","confirmation_id":null},
              "verification": {{verification}},
              "recovery_clearances": []
            }
            """);

    private static RbpInvokeRequest WriteRequest(
        string invocationId = "0197a3c2-0000-7000-8000-0000000000b2") =>
        Parse(
            $$"""
            {
              "invocation_id": "{{invocationId}}",
              "method": "{{WriteMethod}}",
              "params": {"length": 3000},
              "timeout_ms": 120000,
              "mutating": true,
              "mutation_scope": {"kind":"document","document_id":"doc-1"},
              "policy": {"class":"confirm","decision":"confirmed","confirmation_id":"c1"},
              "verification": null,
              "recovery_clearances": []
            }
            """);

    private static RbpInvokeRequest RecoveryRequest(string invocationId) =>
        Parse(
            $$"""
            {
              "invocation_id": "{{invocationId}}",
              "method": "dispatch_payload_recovery",
              "params": {
                "origin_invocation_id": "0197a3c2-0000-7000-8000-0000000000f1",
                "expected_result_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
              },
              "timeout_ms": 120000,
              "mutating": false,
              "mutation_scope": null,
              "policy": {"class":"auto","decision":"auto","confirmation_id":null},
              "verification": null,
              "recovery_clearances": []
            }
            """);

    private static RbpInvokeRequest Parse(string payloadJson)
    {
        using JsonDocument document = JsonDocument.Parse(payloadJson);
        return RbpInvokeRequest.Parse(Rsid, document.RootElement.Clone());
    }

    private static RbpAddinOutcome Completed(
        string resultJson,
        byte[]? raw = null)
    {
        using JsonDocument document = JsonDocument.Parse(resultJson);
        raw ??= Encoding.UTF8.GetBytes(resultJson);
        return new RbpAddinOutcome(
            RbpAddinOutcomeKind.Completed,
            document.RootElement.Clone(),
            raw,
            RequestBytes: 128,
            ResponseBytes: raw.Length);
    }

    private static RbpAddinOutcome PossiblyDispatched(string message) =>
        new(
            RbpAddinOutcomeKind.PossiblyDispatched,
            default,
            [],
            RequestBytes: 128,
            ResponseBytes: 0,
            Message: message);

    private sealed class StubChannel(Func<Task<RbpAddinOutcome>> onInvoke)
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
            return onInvoke();
        }
    }
}
