using System.Reflection;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed partial class RbpConnectionCoordinatorTests
{
    [Fact]
    public async Task DeferredNewLocalNeverRegistersAndHealthyResumeStaysCurrent()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot healthy = LocalSession(8080, 1000);
        await store.PersistRegisteredSessionAsync(
            Registration(healthy, "rs-8080"));
        await InstallUnresolvedMutationAsync(store, "rs-8080", 801);

        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var dispatcher = new StubInvocationDispatcher();
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(
                healthy,
                LocalSession(8081, 1001)),
            clock,
            invocationDispatcher: dispatcher);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.SequenceEqual(
                new[] { "rs-8080" }));

        for (int cycleIndex = 0; cycleIndex < 10; cycleIndex++)
        {
            await EventuallyAsync(
                () => clock.HasOutstandingDelayDueIn(
                    TimeSpan.FromSeconds(15)));
            int priorHeartbeats = cycle.Sent.Count(
                item => item.Type == "heartbeat");
            clock.Advance(TimeSpan.FromSeconds(15));
            await EventuallyAsync(
                () => cycle.Sent.Count(item => item.Type == "heartbeat") >
                    priorHeartbeats);
        }

        Assert.Equal(1, coordinator.GetSnapshot().ConnectionGeneration);
        Assert.Equal(new[] { "rs-8080" },
            coordinator.GetSnapshot().ActiveRsids);
        Assert.DoesNotContain(
            cycle.Sent,
            envelope => envelope.Type == "session_register" &&
                envelope.Payload.GetProperty("port").GetInt32() == 8081);
        Assert.Empty(dispatcher.Dispatched);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PostAckRefusalInstallsPermitBeforeQueuedWorkAndKeepsAHealthy(
        bool streamableHttp)
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var catalog = new MutableSessionCatalog(LocalSession(8080, 1000));
        var dispatcher = new StubInvocationDispatcher();
        var unregisterRelease = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        int raceArmed = 0;
        RbpEnvelope queued = DataEnvelope(
            "invoke",
            Id(821),
            "rs-8081",
            1,
            CleanupReadPayload(Id(822)));
        var cycle = new FakeConnectionCycle(
            _ => null,
            sendBehavior: async (current, envelope, cancellationToken) =>
            {
                if (envelope.Type == "session_register" &&
                    envelope.Payload.GetProperty("port").GetInt32() == 8081 &&
                    Volatile.Read(ref raceArmed) != 0)
                {
                    await InstallUnresolvedMutationAsync(
                        store,
                        "rs-8080",
                        811);
                    current.Deliver(responder.Respond(envelope)!);
                    current.Deliver(queued);
                    return;
                }

                if (envelope.Type == "session_unregister" &&
                    envelope.Payload.GetProperty("rsid").GetString() ==
                        "rs-8081")
                {
                    await unregisterRelease.Task.WaitAsync(cancellationToken);
                    return;
                }

                RbpEnvelope? response = responder.Respond(envelope);
                if (response is not null)
                {
                    current.Deliver(response);
                }
            });
        RbpConnectionBindingKind binding = streamableHttp
            ? RbpConnectionBindingKind.StreamableHttpSse
            : RbpConnectionBindingKind.Wss;
        var coordinator = CoordinatorForBinding(
            new InProcessBindingFactory(binding, cycle),
            store,
            catalog,
            clock,
            dispatcher);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.SequenceEqual(
                new[] { "rs-8080" }));
        Volatile.Write(ref raceArmed, 1);
        catalog.Replace(
            LocalSession(8080, 1000),
            LocalSession(8081, 1001));
        clock.Advance(TimeSpan.FromSeconds(15));

        await EventuallyAsync(
            async () =>
                (await store.GetUnregisterTombstoneAsync("rs-8081")) is
                { Phase: RbpUnregisterPhase.Pending });
        Assert.Equal(new[] { "rs-8080" },
            coordinator.GetSnapshot().ActiveRsids);
        Assert.Equal(1, coordinator.GetSnapshot().ConnectionGeneration);
        Assert.DoesNotContain("rs-8081", dispatcher.Dispatched);
        Assert.Null(await store.GetInvocationAsync("rs-8081/" + Id(822)));
        Assert.DoesNotContain(
            cycle.Sent,
            item => item.Scope == RbpEnvelopeScope.Data &&
                item.Rsid == "rs-8081");

        for (int replay = 0; replay < 7; replay++)
        {
            cycle.Deliver(queued);
        }
        await Task.Delay(50);
        Assert.False(run.IsCompleted);
        Assert.DoesNotContain("rs-8081", dispatcher.Dispatched);

        unregisterRelease.TrySetResult();
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task StopWinningBlockedRegistrationSendPreventsLateAckBinding()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var catalog = new MutableSessionCatalog(LocalSession(8080, 1000));
        var entered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var cycle = new FakeConnectionCycle(
            _ => null,
            leaveInboundOpenAfterClose: true,
            sendBehavior: async (current, envelope, _) =>
            {
                if (envelope.Type == "session_register" &&
                    envelope.Payload.GetProperty("port").GetInt32() == 8081)
                {
                    entered.TrySetResult();
                    await release.Task.ConfigureAwait(false);
                }
                RbpEnvelope? response = responder.Respond(envelope);
                if (response is not null) current.Deliver(response);
            });
        var factory = new InProcessBindingFactory(
            RbpConnectionBindingKind.Wss, cycle);
        RbpConnectionCoordinator coordinator = CoordinatorForBinding(
            factory, store, catalog, clock, new StubInvocationDispatcher());
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        Task<RbpCoordinatorTeardownResult>? teardown = null;
        try
        {
            await EventuallyAsync(() =>
                coordinator.GetSnapshot().ActiveRsids.SequenceEqual(
                    new[] { "rs-8080" }));
            catalog.Replace(
                LocalSession(8080, 1000),
                LocalSession(8081, 1001));
            clock.Advance(TimeSpan.FromSeconds(15));
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));

            teardown = coordinator.RequestStopTeardown();
            stop.Cancel();
        }
        finally
        {
            release.TrySetResult();
            stop.Cancel();
        }

        Assert.NotNull(teardown);
        RbpCoordinatorTeardownResult result = await teardown.WaitAsync(
            TimeSpan.FromSeconds(2));
        Assert.Equal(
            RbpCoordinatorTeardownDisposition.NormalStopped,
            result.Disposition);
        await run.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Null(await store.GetStoredSessionAsync("rs-8081"));
        Assert.Empty(coordinator.GetSnapshot().ActiveRsids);
        Assert.Equal(1, factory.OpenCount);
        Assert.Equal(1, cycle.CloseCount);
        Assert.Equal(1, cycle.DisposeCount);
    }

    [Fact]
    public async Task StopWinningBlockedResumeJournalCommitPreventsLateRouteBind()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        var faults = new BlockingJournalFaultInjector();
        await using RbpJournalStore store = OpenStore(directory, clock, faults);
        RbpLocalSessionSnapshot local = LocalSession(8080, 1000);
        _ = await store.PersistRegisteredSessionAsync(
            Registration(local, "rs-8080"));
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(cycle);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(local),
            clock);
        using var stop = new CancellationTokenSource();
        faults.Arm(RbpJournalFaultPoint.BeforeCommit);
        Task run = coordinator.RunAsync(stop.Token);
        Task<RbpCoordinatorTeardownResult>? teardown = null;
        try
        {
            await faults.Entered.WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Contains(cycle.Sent, item => item.Type == "session_resume");
            Assert.Empty(coordinator.GetSnapshot().ActiveRsids);

            teardown = coordinator.RequestStopTeardown();
            stop.Cancel();
        }
        finally
        {
            faults.Release();
            stop.Cancel();
        }

        Assert.NotNull(teardown);
        RbpCoordinatorTeardownResult result = await teardown.WaitAsync(
            TimeSpan.FromSeconds(2));
        Assert.Equal(
            RbpCoordinatorTeardownDisposition.EmergencyMustExit,
            result.Disposition);
        RbpCoordinatorException failure =
            await Assert.ThrowsAsync<RbpCoordinatorException>(
                () => run.WaitAsync(TimeSpan.FromSeconds(2)));
        Assert.Equal(
            RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
            failure.ErrorCode);
        Assert.Empty(coordinator.GetSnapshot().ActiveRsids);
        Assert.DoesNotContain(cycle.Sent, item => item.Type == "session_register");
        Assert.Equal(1, factory.OpenCount);
        Assert.Equal(1, cycle.CloseCount);
        Assert.Equal(0, cycle.DisposeCount);
    }

    [Fact]
    public async Task PostCommitReadbackRequiresJointCleanupSessionAndTombstone()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        var faults = new BlockingJournalFaultInjector();
        await using RbpJournalStore store = OpenStore(directory, clock, faults);
        RbpLocalSessionSnapshot first = LocalSession(8080, 1000);
        RbpLocalSessionSnapshot second = LocalSession(8081, 1001);
        await store.PersistRegisteredSessionAsync(
            Registration(first, "rs-8080"));
        (_, string secondDigest) =
            RbpJournalSerialization.CanonicalRegistration(
                second.RegistrationPayload);
        RbpRegistrationSafetyAssessment preflight =
            await store.AssessRegistrationSafetyAsync(
                second.LocalSessionKey,
                secondDigest);
        Assert.Equal(
            RbpRegistrationSafetyDisposition.Eligible,
            preflight.Disposition);
        await InstallUnresolvedMutationAsync(store, "rs-8080", 831);
        faults.Arm(RbpJournalFaultPoint.AfterCommitBeforeReturn);

        Task<RbpRegistrationCommitResult> write =
            Task.Run(
                () => store.PersistRegistrationAfterAcknowledgementAsync(
                    Registration(second, "rs-8081"),
                    preflight));
        await faults.Entered.WaitAsync(TimeSpan.FromSeconds(2));
        faults.Release();
        RbpRegistrationCommitResult result = await write;

        Assert.Equal(
            RbpLocalRegistrationDisposition.CleanupPending,
            result.Disposition);
        Assert.NotNull(result.CleanupReceipt);
        Assert.Equal(
            RbpUnregisterPhase.Pending,
            result.CleanupReceipt!.Tombstone.Phase);
        Assert.Equal(
            RbpSessionUnregisterReason.OperatorRequested,
            result.CleanupReceipt.Tombstone.Reason);
        Assert.Equal(
            "rs-8081",
            result.CleanupReceipt.Session.Rsid);
        string cleanupDigest = CleanupSuppressionDigest(
            result.CleanupReceipt.Session,
            result.CleanupReceipt.Tombstone);
        Assert.NotEqual(preflight.SafetyDecisionDigest, cleanupDigest);
        Assert.Equal(cleanupDigest, result.SafetyDecisionDigest);
        Assert.Equal(
            cleanupDigest,
            result.CleanupReceipt.SafetyDecisionDigest);
    }

    [Fact]
    public async Task SameCoordinatorReconnectReplaysExactCleanupWithoutAuthority()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot healthy = LocalSession(8080, 1000);
        RbpLocalSessionSnapshot cleanup = LocalSession(8081, 1001);
        await store.PersistRegisteredSessionAsync(
            Registration(healthy, "rs-8080"));
        var responder = new ScriptedGatewayResponder(clock);
        var catalog = new MutableSessionCatalog(healthy);
        var dispatcher = new StubInvocationDispatcher();
        int raceArmed = 0;
        var first = new FakeConnectionCycle(
            _ => null,
            connectionId: "conn-cleanup-first",
            sendBehavior: async (current, envelope, _) =>
            {
                if (envelope.Type == "session_register" &&
                    envelope.Payload.GetProperty("port").GetInt32() == 8081 &&
                    Volatile.Read(ref raceArmed) != 0)
                {
                    await InstallUnresolvedMutationAsync(
                        store,
                        "rs-8080",
                        835);
                    current.Deliver(responder.Respond(envelope)!);
                    return;
                }

                if (envelope.Type != "heartbeat")
                {
                    RbpEnvelope? response = responder.Respond(envelope);
                    if (response is not null)
                    {
                        current.Deliver(response);
                    }
                }
            });
        var second = new FakeConnectionCycle(
            responder.Respond,
            connectionId: "conn-cleanup-second");
        var factory = new FakeConnectionCycleFactory(first, second);
        var coordinator = Coordinator(
            factory,
            store,
            catalog,
            clock,
            invocationDispatcher: dispatcher);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.SequenceEqual(
                new[] { "rs-8080" }));
        Volatile.Write(ref raceArmed, 1);
        catalog.Replace(healthy, cleanup);
        await EventuallyAsync(
            () => clock.HasOutstandingDelayDueIn(
                TimeSpan.FromSeconds(15)));
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            async () =>
                (await store.GetUnregisterTombstoneAsync("rs-8081")) is
                { Phase: RbpUnregisterPhase.Pending });
        await EventuallyAsync(
            () => first.Sent.Count(
                item => item.Type == "session_unregister" &&
                    item.Payload.GetProperty("rsid").GetString() ==
                        "rs-8081") == 1);
        RbpEnvelope firstUnregister = Assert.Single(
            first.Sent,
            item =>
                item.Type == "session_unregister" &&
                item.Payload.GetProperty("rsid").GetString() == "rs-8081");

        await EventuallyAsync(
            () => clock.HasOutstandingDelayDueIn(
                TimeSpan.FromSeconds(10)));
        clock.Advance(TimeSpan.FromSeconds(10));
        await EventuallyAsync(() => factory.OpenCount == 2);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ConnectionGeneration == 2 &&
                coordinator.GetSnapshot().ActiveRsids.SequenceEqual(
                    new[] { "rs-8080" }));
        await EventuallyAsync(
            () => second.Sent.Count(
                item => item.Type == "session_unregister" &&
                    item.Payload.GetProperty("rsid").GetString() ==
                        "rs-8081") == 1);

        RbpEnvelope replay = Assert.Single(
            second.Sent,
            item =>
                item.Type == "session_unregister" &&
                item.Payload.GetProperty("rsid").GetString() == "rs-8081");
        Assert.Equal(
            firstUnregister.Payload.GetRawText(),
            replay.Payload.GetRawText());
        Assert.DoesNotContain(
            second.Sent,
            item => item.Type == "session_resume" &&
                item.Payload.TryGetProperty("rsid", out JsonElement rsid) &&
                rsid.GetString() == "rs-8081");
        Assert.DoesNotContain(
            second.Sent,
            item => item.Type == "session_register" &&
                item.Payload.GetProperty("port").GetInt32() == 8081);
        Assert.Empty(dispatcher.Dispatched);

        second.Deliver(DataEnvelope(
            "invoke",
            Id(836),
            "rs-8081",
            1,
            CleanupReadPayload(Id(837))));
        await EventuallyAsync(() => second.CloseCount > 0);
        Assert.Empty(dispatcher.Dispatched);
        Assert.Null(await store.GetInvocationAsync("rs-8081/" + Id(837)));

        await StopAfterAssertedConnectionFailureAsync(
            coordinator, stop, run, () => second.CloseCount > 0);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CleanupBatchAndRelatedCancelReplayStayDiscardOnly(
        bool streamableHttp)
    {
        string batchId = Id(841);
        RbpEnvelope batch = DataEnvelope(
            "invoke_batch",
            Id(842),
            "rs-8081",
            1,
            CleanupBatchPayload(batchId, Id(843)));
        RbpEnvelope cancel = DataEnvelope(
            "cancel",
            Id(844),
            "rs-8081",
            2,
            Json($$"""{"invocation_id":"{{batchId}}"}"""));
        await using CleanupRaceHarness harness =
            await CreateCleanupRaceAsync(
                new[] { batch, cancel },
                streamableHttp);

        harness.Cycle.Deliver(batch);
        harness.Cycle.Deliver(cancel);
        await Task.Delay(50);

        Assert.False(harness.Run.IsCompleted);
        Assert.Equal(new[] { "rs-8080" },
            harness.Coordinator.GetSnapshot().ActiveRsids);
        Assert.Empty(harness.Dispatcher.Dispatched);
        Assert.Null(await harness.Store.GetBatchAsync(
            "rs-8081/" + batchId));
        Assert.Null(await harness.Store.GetInvocationAsync(
            "rs-8081/" + Id(843)));
    }

    [Theory]
    [InlineData("missing_atomic_grant")]
    [InlineData("unsupported_method")]
    public async Task CleanupBatchRequiresExactGrantAndSupportedMethod(
        string violation)
    {
        string batchId = Id(845);
        string invocationId = Id(846);
        RbpEnvelope invalid = DataEnvelope(
            "invoke_batch",
            Id(847),
            "rs-8081",
            1,
            CleanupBatchPayload(
                batchId,
                invocationId,
                atomic: violation == "missing_atomic_grant",
                method: violation == "unsupported_method"
                    ? "unsupported_cleanup_method"
                    : "get_current_view_info"));
        await using CleanupRaceHarness harness =
            await CreateCleanupRaceAsync(
                Array.Empty<RbpEnvelope>(),
                batchCapable: true);

        harness.Cycle.Deliver(invalid);
        await EventuallyAsync(() => harness.Cycle.CloseCount > 0);
        harness.AllowExpectedPresteadyMustExitOnDispose();

        Assert.Empty(harness.Dispatcher.Dispatched);
        Assert.Null(await harness.Store.GetBatchAsync(
            "rs-8081/" + batchId));
        Assert.Null(await harness.Store.GetInvocationAsync(
            "rs-8081/" + invocationId));
    }

    [Theory]
    [InlineData("digest")]
    [InlineData("id")]
    [InlineData("type")]
    [InlineData("target")]
    [InlineData("ack")]
    [InlineData("gap")]
    public async Task CleanupWindowRejectsConflictingTraffic(
        string conflict)
    {
        string invocationId = Id(851);
        RbpEnvelope original = DataEnvelope(
            "invoke",
            Id(852),
            "rs-8081",
            1,
            CleanupReadPayload(invocationId));
        await using CleanupRaceHarness harness =
            await CreateCleanupRaceAsync(new[] { original });

        RbpEnvelope conflicting = conflict switch
        {
            "digest" => original with
            {
                Payload = CleanupReadPayload(Id(853)),
            },
            "id" => original with { Id = Id(854) },
            "type" => DataEnvelope(
                "invoke_batch",
                Id(855),
                "rs-8081",
                1,
                CleanupBatchPayload(Id(856), Id(857))),
            "target" => DataEnvelope(
                "cancel",
                Id(858),
                "rs-8081",
                2,
                Json($$"""{"invocation_id":"{{Id(859)}}"}""")),
            "ack" => original with { Acknowledgement = 1 },
            "gap" => DataEnvelope(
                "cancel",
                Id(860),
                "rs-8081",
                3,
                Json($$"""{"invocation_id":"{{invocationId}}"}""")),
            _ => throw new ArgumentOutOfRangeException(nameof(conflict)),
        };

        harness.Cycle.Deliver(conflicting);
        await EventuallyAsync(() => harness.Cycle.CloseCount > 0);
        harness.AllowExpectedPresteadyMustExitOnDispose();
        Assert.Empty(harness.Dispatcher.Dispatched);
        Assert.Null(await harness.Store.GetInvocationAsync(
            "rs-8081/" + invocationId));
    }

    [Fact]
    public async Task CleanupPermitEighthReplayIsLastAndNinthFaults()
    {
        RbpEnvelope original = DataEnvelope(
            "invoke",
            Id(861),
            "rs-8081",
            1,
            CleanupReadPayload(Id(862)));
        await using CleanupRaceHarness harness =
            await CreateCleanupRaceAsync(new[] { original });

        for (int replay = 0; replay < 7; replay++)
        {
            harness.Cycle.Deliver(original);
        }
        await Task.Delay(50);
        Assert.False(harness.Run.IsCompleted);

        harness.Cycle.Deliver(original);
        await EventuallyAsync(() => harness.Cycle.CloseCount > 0);
        harness.AllowExpectedPresteadyMustExitOnDispose();
        Assert.Empty(harness.Dispatcher.Dispatched);
    }

    [Fact]
    public async Task CleanupPermitExpiresAtAbsoluteSixtySeconds()
    {
        RbpEnvelope original = DataEnvelope(
            "invoke",
            Id(871),
            "rs-8081",
            1,
            CleanupReadPayload(Id(872)));
        await using CleanupRaceHarness harness =
            await CreateCleanupRaceAsync(new[] { original });

        harness.Clock.Advance(TimeSpan.FromSeconds(60));
        harness.Cycle.Deliver(original);
        await EventuallyAsync(() => harness.Cycle.CloseCount > 0);
        harness.AllowExpectedPresteadyMustExitOnDispose();
        Assert.Empty(harness.Dispatcher.Dispatched);
    }

    [Fact]
    public async Task ConfirmedCleanupImmediatelyEndsReceiveExemption()
    {
        RbpEnvelope original = DataEnvelope(
            "invoke",
            Id(881),
            "rs-8081",
            1,
            CleanupReadPayload(Id(882)));
        await using CleanupRaceHarness harness =
            await CreateCleanupRaceAsync(new[] { original });

        harness.UnregisterRelease.TrySetResult();
        await EventuallyAsync(
            async () =>
                await harness.Store.GetStoredSessionAsync("rs-8081") is null);
        harness.Cycle.Deliver(original);
        await EventuallyAsync(() => harness.Cycle.CloseCount > 0);
        harness.AllowExpectedPresteadyMustExitOnDispose();
        Assert.Empty(harness.Dispatcher.Dispatched);
    }

    [Fact]
    public async Task RetainedTombstoneOnNewConnectionDoesNotMintPermit()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot healthy = LocalSession(8080, 1000);
        RbpLocalSessionSnapshot cleanup = LocalSession(8081, 1001);
        await store.PersistRegisteredSessionAsync(
            Registration(healthy, "rs-8080"));
        await store.PersistRegisteredSessionAsync(
            Registration(cleanup, "rs-8081"));
        _ = await store.RecordUnregisterIntentAsync(
            "rs-8081",
            RbpSessionUnregisterReason.OperatorRequested);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var dispatcher = new StubInvocationDispatcher();
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(healthy),
            clock,
            invocationDispatcher: dispatcher);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.SequenceEqual(
                new[] { "rs-8080" }));
        cycle.Deliver(DataEnvelope(
            "invoke",
            Id(901),
            "rs-8081",
            1,
            CleanupReadPayload(Id(902))));

        await EventuallyAsync(() => cycle.CloseCount > 0);
        Assert.Empty(dispatcher.Dispatched);
        Assert.Null(await store.GetInvocationAsync("rs-8081/" + Id(902)));
        await StopAfterAssertedConnectionFailureAsync(
            coordinator, stop, run, () => cycle.CloseCount > 0);
    }

    [Fact]
    public async Task CleanupBeforeCommitFailureLeavesNoPartialReceipt()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        var faults = new ArmedJournalFaultInjector();
        await using RbpJournalStore store = OpenStore(directory, clock, faults);
        RbpLocalSessionSnapshot first = LocalSession(8080, 1000);
        RbpLocalSessionSnapshot second = LocalSession(8081, 1001);
        await store.PersistRegisteredSessionAsync(
            Registration(first, "rs-8080"));
        (_, string secondDigest) =
            RbpJournalSerialization.CanonicalRegistration(
                second.RegistrationPayload);
        RbpRegistrationSafetyAssessment preflight =
            await store.AssessRegistrationSafetyAsync(
                second.LocalSessionKey,
                secondDigest);
        await InstallUnresolvedMutationAsync(store, "rs-8080", 911);
        faults.Arm(RbpJournalFaultPoint.BeforeCommit);

        Task<RbpRegistrationCommitResult> write =
            store.PersistRegistrationAfterAcknowledgementAsync(
                Registration(second, "rs-8081"),
                preflight);
        await Assert.ThrowsAsync<IOException>(() => write);

        Assert.Null(await store.GetStoredSessionAsync("rs-8081"));
        Assert.Null(await store.GetUnregisterTombstoneAsync("rs-8081"));
    }

    [Fact]
    public async Task ContradictoryCleanupTombstoneFailsExactReplayClosed()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot first = LocalSession(8080, 1000);
        RbpLocalSessionSnapshot second = LocalSession(8081, 1001);
        await store.PersistRegisteredSessionAsync(
            Registration(first, "rs-8080"));
        (_, string secondDigest) =
            RbpJournalSerialization.CanonicalRegistration(
                second.RegistrationPayload);
        RbpRegistrationSafetyAssessment preflight =
            await store.AssessRegistrationSafetyAsync(
                second.LocalSessionKey,
                secondDigest);
        await InstallUnresolvedMutationAsync(store, "rs-8080", 921);
        _ = await store.PersistRegistrationAfterAcknowledgementAsync(
            Registration(second, "rs-8081"),
            preflight);
        _ = await store.ExecuteImmediateAsync(
            context =>
            {
                using Microsoft.Data.Sqlite.SqliteCommand update =
                    context.CreateCommand(
                        """
                        UPDATE rbp_unregister_tombstones
                        SET reason='bridge_shutdown'
                        WHERE rsid='rs-8081';
                        """);
                return update.ExecuteNonQuery();
            });

        RbpJournalException failure =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.PersistRegistrationAfterAcknowledgementAsync(
                    Registration(second, "rs-8081"),
                    preflight));
        Assert.Equal(
            RbpJournalErrorCode.IntegrityCheckFailed,
            failure.ErrorCode);
    }

    [Fact]
    public async Task CleanupPermitLedgerEnforcesGlobalAndInventoryCaps()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var cycle = new FakeConnectionCycle(_ => null);
        RbpConnectionCoordinator coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(),
            clock);
        Type contextType = typeof(RbpConnectionCoordinator).GetNestedType(
            "ConnectionCycleContext",
            BindingFlags.NonPublic) ??
            throw new InvalidOperationException("Context type missing.");
        ConstructorInfo constructor = Assert.Single(
            contextType.GetConstructors(
                BindingFlags.Instance | BindingFlags.NonPublic));
        object context = constructor.Invoke(
            new object[]
            {
                coordinator,
                cycle,
                1L,
                Array.Empty<string>(),
                CancellationToken.None,
            });
        try
        {
            MethodInfo discard = RequiredContextMethod(
                contextType,
                "TryDiscardCleanupData");
            for (int permitIndex = 0; permitIndex < 128; permitIndex++)
            {
                InstallSyntheticPermit(
                    contextType,
                    context,
                    permitIndex,
                    acknowledgedAt: 0);
            }

            TargetInvocationException capacity = Assert.Throws<
                TargetInvocationException>(
                () => InstallSyntheticPermit(
                    contextType,
                    context,
                    128,
                    acknowledgedAt: 0));
            Assert.IsType<RbpCoordinatorException>(capacity.InnerException);

            for (int permitIndex = 0; permitIndex < 4; permitIndex++)
            {
                RbpDataEnvelopeSnapshot snapshot =
                    SyntheticCleanupSnapshot(permitIndex);
                string digest = Rfc8785Json.ImmutableEnvelopeDigest(snapshot);
                for (int observation = 0; observation < 8; observation++)
                {
                    object disposition = discard.Invoke(
                        context,
                        new object[]
                        {
                            snapshot,
                            digest,
                            snapshot.Payload.GetProperty("invocation_id")
                                .GetString()!,
                            1L,
                        })!;
                    Assert.Equal("Discarded", disposition.ToString());
                }
            }

            RbpDataEnvelopeSnapshot overflow = SyntheticCleanupSnapshot(4);
            object blocked = discard.Invoke(
                context,
                new object[]
                {
                    overflow,
                    Rfc8785Json.ImmutableEnvelopeDigest(overflow),
                    overflow.Payload.GetProperty("invocation_id").GetString()!,
                    1L,
                })!;
            Assert.Equal("Conflict", blocked.ToString());
        }
        finally
        {
            ((IDisposable)context).Dispose();
        }
    }

    [Fact]
    public async Task DeferredRegistrationRechecksOnlyAtExactThirtySecondCadence()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        await store.PersistRegisteredSessionAsync(
            Registration(LocalSession(8079, 979), "rs-predecessor"));
        await InstallUnresolvedMutationAsync(store, "rs-predecessor", 931);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(),
            store,
            new MutableSessionCatalog(),
            clock);
        RbpLocalSessionSnapshot local = LocalSession(8090, 1090);
        int assessmentCount = 0;

        (bool first, bool firstEligible) =
            await AssessRegistrationPreflightAsync(coordinator, local);
        assessmentCount += first ? 1 : 0;
        Assert.True(first);
        Assert.False(firstEligible);

        for (int repeat = 0; repeat < 6; repeat++)
        {
            (bool performed, bool eligible) =
                await AssessRegistrationPreflightAsync(coordinator, local);
            assessmentCount += performed ? 1 : 0;
            Assert.False(performed);
            Assert.False(eligible);
        }

        clock.Advance(TimeSpan.FromMilliseconds(29_999));
        (bool early, _) =
            await AssessRegistrationPreflightAsync(coordinator, local);
        assessmentCount += early ? 1 : 0;
        Assert.False(early);
        Assert.Equal(1, assessmentCount);

        clock.Advance(TimeSpan.FromMilliseconds(1));
        (bool due, bool dueEligible) =
            await AssessRegistrationPreflightAsync(coordinator, local);
        assessmentCount += due ? 1 : 0;
        Assert.True(due);
        Assert.False(dueEligible);
        Assert.Equal(2, assessmentCount);

        (bool immediate, _) =
            await AssessRegistrationPreflightAsync(coordinator, local);
        assessmentCount += immediate ? 1 : 0;
        Assert.False(immediate);
        Assert.Equal(2, assessmentCount);
    }

    [Fact]
    public async Task ReconciliationAssessesAtMostFourDeferredLocalsPerPass()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot healthy = LocalSession(8080, 1000);
        await store.PersistRegisteredSessionAsync(
            Registration(healthy, "rs-8080"));
        await InstallUnresolvedMutationAsync(store, "rs-8080", 932);
        RbpLocalSessionSnapshot[] deferred = Enumerable.Range(1, 5)
            .Select(index => LocalSession(8080 + index, 1000 + index))
            .ToArray();
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(
                new[] { healthy }.Concat(deferred).ToArray()),
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => DeferredRegistrationCount(coordinator) == 4);
        Assert.Equal(4, DeferredRegistrationCount(coordinator));
        Assert.DoesNotContain(
            cycle.Sent,
            item => item.Type == "session_register");

        await EventuallyAsync(
            () => clock.HasOutstandingDelayDueIn(
                TimeSpan.FromSeconds(15)));
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => DeferredRegistrationCount(coordinator) == 5);
        Assert.Equal(5, DeferredRegistrationCount(coordinator));
        Assert.DoesNotContain(
            cycle.Sent,
            item => item.Type == "session_register");

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task DeferredRegistrationInventoryStopsAtOneHundredTwentyEight()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        await store.PersistRegisteredSessionAsync(
            Registration(LocalSession(8079, 979), "rs-predecessor"));
        await InstallUnresolvedMutationAsync(store, "rs-predecessor", 933);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(),
            store,
            new MutableSessionCatalog(),
            clock);
        int assessmentCount = 0;

        for (int index = 0; index < 128; index++)
        {
            (bool performed, bool eligible) =
                await AssessRegistrationPreflightAsync(
                    coordinator,
                    LocalSession(10_000 + index, 20_000 + index));
            assessmentCount += performed ? 1 : 0;
            Assert.True(performed);
            Assert.False(eligible);
        }

        (bool overflowPerformed, bool overflowEligible) =
            await AssessRegistrationPreflightAsync(
                coordinator,
                LocalSession(20_000, 30_000));
        assessmentCount += overflowPerformed ? 1 : 0;

        Assert.False(overflowPerformed);
        Assert.False(overflowEligible);
        Assert.Equal(128, assessmentCount);
        Assert.Equal(128, DeferredRegistrationCount(coordinator));
    }

    [Fact]
    public async Task ChangedLocalIdentityRemainsDeferredByUnresolvedPredecessor()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot healthy = LocalSession(8080, 1000);
        RbpLocalSessionSnapshot original = LocalSession(8081, 1001);
        RbpLocalSessionSnapshot changed = LocalSession(8082, 2002);
        await store.PersistRegisteredSessionAsync(
            Registration(healthy, "rs-8080"));
        await InstallUnresolvedMutationAsync(store, "rs-8080", 934);
        (_, string originalDigest) =
            RbpJournalSerialization.CanonicalRegistration(
                original.RegistrationPayload);
        (_, string changedDigest) =
            RbpJournalSerialization.CanonicalRegistration(
                changed.RegistrationPayload);
        RbpRegistrationSafetyAssessment originalAssessment =
            await store.AssessRegistrationSafetyAsync(
                original.LocalSessionKey,
                originalDigest);
        RbpRegistrationSafetyAssessment changedAssessment =
            await store.AssessRegistrationSafetyAsync(
                changed.LocalSessionKey,
                changedDigest);
        Assert.NotEqual(
            originalAssessment.SafetyDecisionDigest,
            changedAssessment.SafetyDecisionDigest);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var catalog = new MutableSessionCatalog(healthy, original);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            catalog,
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => DeferredRegistrationCount(coordinator) == 1);
        catalog.Replace(healthy, changed);
        await EventuallyAsync(
            () => clock.HasOutstandingDelayDueIn(
                TimeSpan.FromSeconds(15)));
        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(() => DeferredRegistrationCount(coordinator) == 2);

        Assert.DoesNotContain(
            cycle.Sent,
            item => item.Type == "session_register" &&
                item.Payload.GetProperty("port").GetInt32() is 8081 or 8082);
        Assert.Equal(new[] { "rs-8080" },
            coordinator.GetSnapshot().ActiveRsids);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task SafetyTransitionEmitsExactlyOneRegistrationWithoutStorm()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot healthy = LocalSession(8080, 1000);
        RbpLocalSessionSnapshot deferred = LocalSession(8081, 1001);
        await store.PersistRegisteredSessionAsync(
            Registration(healthy, "rs-8080"));
        await InstallUnresolvedMutationAsync(store, "rs-8080", 935);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(healthy, deferred),
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => DeferredRegistrationCount(coordinator) == 1);
        await ClearUnresolvedMutationAsync(store, "rs-8080");

        await AdvanceHeartbeatAsync(clock);
        Assert.DoesNotContain(
            cycle.Sent,
            item => item.Type == "session_register" &&
                item.Payload.GetProperty("port").GetInt32() == 8081);
        await AdvanceHeartbeatAsync(clock);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Contains("rs-8081"));

        for (int heartbeat = 0; heartbeat < 3; heartbeat++)
        {
            await AdvanceHeartbeatAsync(clock);
        }

        Assert.Equal(
            1,
            cycle.Sent.Count(item => item.Type == "session_register" &&
                item.Payload.GetProperty("port").GetInt32() == 8081));
        Assert.Equal(
            new[] { "rs-8080", "rs-8081" },
            coordinator.GetSnapshot().ActiveRsids);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task ExistingRowReplayRechecksSafetyBeforeRoutePublication()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot healthy = LocalSession(8080, 1000);
        RbpLocalSessionSnapshot replay = LocalSession(8081, 1001);
        await store.PersistRegisteredSessionAsync(
            Registration(healthy, "rs-8080"));
        await store.PersistRegisteredSessionAsync(
            Registration(replay, "rs-8081"));
        (_, string replayDigest) =
            RbpJournalSerialization.CanonicalRegistration(
                replay.RegistrationPayload);
        RbpRegistrationSafetyAssessment preflight =
            await store.AssessRegistrationSafetyAsync(
                replay.LocalSessionKey,
                replayDigest);
        Assert.Equal(
            RbpRegistrationSafetyDisposition.Eligible,
            preflight.Disposition);

        await InstallUnresolvedMutationAsync(store, "rs-8080", 936);
        RbpRegistrationSafetyAssessment changed =
            await store.AssessRegistrationSafetyAsync(
                replay.LocalSessionKey,
                replayDigest);
        Assert.Equal(
            RbpRegistrationSafetyDisposition.Deferred,
            changed.Disposition);
        Assert.NotEqual(
            preflight.SafetyDecisionDigest,
            changed.SafetyDecisionDigest);

        RbpRegistrationCommitResult result =
            await store.PersistRegistrationAfterAcknowledgementAsync(
                Registration(replay, "rs-8081"),
                preflight);

        Assert.Equal(
            RbpLocalRegistrationDisposition.CleanupPending,
            result.Disposition);
        Assert.NotNull(result.CleanupReceipt);
        Assert.Equal(
            RbpUnregisterPhase.Pending,
            (await store.GetUnregisterTombstoneAsync("rs-8081"))?.Phase);
    }

    private static async Task<CleanupRaceHarness> CreateCleanupRaceAsync(
        IReadOnlyList<RbpEnvelope> queued,
        bool streamableHttp = false,
        bool batchCapable = false)
    {
        var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var catalog = new MutableSessionCatalog(LocalSession(8080, 1000));
        var dispatcher = new StubInvocationDispatcher();
        var unregisterRelease = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        int raceArmed = 0;
        var cycle = new FakeConnectionCycle(
            _ => null,
            sendBehavior: async (current, envelope, cancellationToken) =>
            {
                if (envelope.Type == "session_register" &&
                    envelope.Payload.GetProperty("port").GetInt32() == 8081 &&
                    Volatile.Read(ref raceArmed) != 0)
                {
                    await InstallUnresolvedMutationAsync(
                        store,
                        "rs-8080",
                        891);
                    current.Deliver(responder.Respond(envelope)!);
                    foreach (RbpEnvelope item in queued)
                    {
                        current.Deliver(item);
                    }
                    return;
                }

                if (envelope.Type == "session_unregister" &&
                    envelope.Payload.GetProperty("rsid").GetString() ==
                        "rs-8081")
                {
                    await unregisterRelease.Task.WaitAsync(cancellationToken);
                    return;
                }

                RbpEnvelope? response = responder.Respond(envelope);
                if (response is not null)
                {
                    current.Deliver(response);
                }
            });
        RbpConnectionBindingKind binding = streamableHttp
            ? RbpConnectionBindingKind.StreamableHttpSse
            : RbpConnectionBindingKind.Wss;
        var factory = new InProcessBindingFactory(binding, cycle);
        RbpConnectionCoordinator coordinator = CoordinatorForBinding(
            factory,
            store,
            catalog,
            clock,
            dispatcher);
        var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        var harness = new CleanupRaceHarness(
            directory,
            store,
            clock,
            cycle,
            catalog,
            dispatcher,
            coordinator,
            stop,
            run,
            unregisterRelease);
        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().ActiveRsids.SequenceEqual(
                    new[] { "rs-8080" }));
            Volatile.Write(ref raceArmed, 1);
            catalog.Replace(
                LocalSession(8080, 1000),
                batchCapable || queued.Any(item =>
                    item.Type == "invoke_batch")
                    ? BatchCapableLocalSession(8081, 1001)
                    : LocalSession(8081, 1001));
            await EventuallyAsync(
                () => clock.HasOutstandingDelayDueIn(
                    TimeSpan.FromSeconds(15)));
            clock.Advance(TimeSpan.FromSeconds(15));
            await EventuallyAsync(
                async () =>
                    (await store.GetUnregisterTombstoneAsync("rs-8081")) is
                    { Phase: RbpUnregisterPhase.Pending });
            return harness;
        }
        catch
        {
            await harness.DisposeAsync();
            throw;
        }
    }

    private static void InstallSyntheticPermit(
        Type contextType,
        object context,
        int index,
        long acknowledgedAt)
    {
        string localSessionKey = $"synthetic-local-{index}";
        string rsid = $"synthetic-rsid-{index}";
        _ = RequiredContextMethod(contextType, "BeginRegistration")
            .Invoke(context, new object[] { localSessionKey });
        _ = RequiredContextMethod(contextType, "DeliverRegistrationAsync")
            .Invoke(
                context,
                new object[]
                {
                    DataEnvelope(
                        "invoke",
                        Id(950 + index),
                        rsid,
                        1,
                        CleanupReadPayload(Id(600 + index))),
                });
        var session = new RbpStoredSession(
            rsid,
            localSessionKey,
            Json("""{"session_capabilities":[]}"""),
            "sha256:" + index.ToString("x64"),
            new RbpSecretString("synthetic-token"),
            DateTimeOffset.Parse("2026-09-01T00:00:00Z"),
            Array.Empty<string>(),
            0,
            0);
        var tombstone = new RbpUnregisterTombstone(
            rsid,
            RbpSessionUnregisterReason.OperatorRequested,
            RbpUnregisterPhase.Pending,
            0,
            0);
        var receipt = new RbpCleanupRegistrationReceipt(
            session,
            tombstone,
            "sha256:" + (index + 1).ToString("x64"));
        RequiredContextMethod(contextType, "InstallCleanupReceivePermit")
            .Invoke(context, new object[] { receipt, acknowledgedAt });
        RequiredContextMethod(contextType, "AcknowledgeRegistrationDeferred")
            .Invoke(context, new object[] { localSessionKey });
        RequiredContextMethod(contextType, "EndRegistration")
            .Invoke(context, new object[] { localSessionKey });
    }

    private static RbpDataEnvelopeSnapshot SyntheticCleanupSnapshot(
        int index)
    {
        string invocationId = Id(600 + index);
        return new RbpDataEnvelopeSnapshot(
            "invoke",
            Id(950 + index),
            $"synthetic-rsid-{index}",
            1,
            CleanupReadPayload(invocationId),
            Acknowledgement: null,
            Timestamp: "2026-08-29T00:00:00Z",
            Version: 1);
    }

    private static MethodInfo RequiredContextMethod(
        Type contextType,
        string name) =>
        contextType.GetMethod(
            name,
            BindingFlags.Instance | BindingFlags.NonPublic) ??
        throw new InvalidOperationException($"Context method {name} missing.");

    private static async Task<(bool Performed, bool Eligible)>
        AssessRegistrationPreflightAsync(
            RbpConnectionCoordinator coordinator,
            RbpLocalSessionSnapshot local)
    {
        var cycle = new FakeConnectionCycle(_ => null);
        Type contextType = typeof(RbpConnectionCoordinator).GetNestedType(
            "ConnectionCycleContext",
            BindingFlags.NonPublic) ??
            throw new InvalidOperationException("Context type missing.");
        ConstructorInfo constructor = Assert.Single(
            contextType.GetConstructors(
                BindingFlags.Instance | BindingFlags.NonPublic));
        object context = constructor.Invoke(new object[]
        {
            coordinator,
            cycle,
            1L,
            Array.Empty<string>(),
            CancellationToken.None,
        });
        FieldInfo active = typeof(RbpConnectionCoordinator).GetField(
            "_active", BindingFlags.Instance | BindingFlags.NonPublic) ??
            throw new InvalidOperationException("Active context field missing.");
        FieldInfo generation = typeof(RbpConnectionCoordinator).GetField(
            "_connectionGeneration",
            BindingFlags.Instance | BindingFlags.NonPublic) ??
            throw new InvalidOperationException("Generation field missing.");
        FieldInfo stopState = typeof(RbpConnectionCoordinator).GetField(
            "_attemptStopState",
            BindingFlags.Instance | BindingFlags.NonPublic) ??
            throw new InvalidOperationException("Attempt state field missing.");
        active.SetValue(coordinator, context);
        generation.SetValue(coordinator, 1L);
        stopState.SetValue(coordinator, 2);
        MethodInfo method = typeof(RbpConnectionCoordinator).GetMethod(
            "AssessRegistrationPreflightAsync",
            BindingFlags.Instance | BindingFlags.NonPublic) ??
            throw new InvalidOperationException(
                "Registration preflight method missing.");
        try
        {
            object pending = method.Invoke(
                coordinator,
                new object[]
                {
                    context,
                    local,
                    true,
                    CancellationToken.None,
                }) ?? throw new InvalidOperationException(
                    "Registration preflight task missing.");
            var task = Assert.IsAssignableFrom<Task>(pending);
            await task;
            object result = pending.GetType().GetProperty("Result")?.GetValue(
                pending) ?? throw new InvalidOperationException(
                    "Registration preflight result missing.");
            Type resultType = result.GetType();
            bool performed = (bool)(resultType.GetProperty(
                "AssessmentPerformed")?.GetValue(result) ?? false);
            bool eligible = resultType.GetProperty(
                "EligibleAssessment")?.GetValue(result) is not null;
            return (performed, eligible);
        }
        finally
        {
            active.SetValue(coordinator, null);
            ((IDisposable)context).Dispose();
        }
    }

    private static int DeferredRegistrationCount(
        RbpConnectionCoordinator coordinator)
    {
        FieldInfo field = typeof(RbpConnectionCoordinator).GetField(
            "_deferredRegistrations",
            BindingFlags.Instance | BindingFlags.NonPublic) ??
            throw new InvalidOperationException(
                "Deferred registration inventory missing.");
        object inventory = field.GetValue(coordinator) ??
            throw new InvalidOperationException(
                "Deferred registration inventory unavailable.");
        return (int)(inventory.GetType().GetProperty("Count")?.GetValue(
            inventory) ?? -1);
    }

    private static async Task AdvanceHeartbeatAsync(
        ManualCoordinatorClock clock)
    {
        await EventuallyAsync(
            () => clock.HasOutstandingDelayDueIn(
                TimeSpan.FromSeconds(15)));
        clock.Advance(TimeSpan.FromSeconds(15));
        await Task.Delay(20);
    }

    private static async Task ClearUnresolvedMutationAsync(
        RbpJournalStore store,
        string rsid)
    {
        _ = await store.ExecuteImmediateAsync(
            context =>
            {
                using (Microsoft.Data.Sqlite.SqliteCommand invocations =
                       context.CreateCommand(
                           "DELETE FROM rbp_invocations WHERE rsid=$rsid;"))
                {
                    invocations.Parameters.AddWithValue("$rsid", rsid);
                    _ = invocations.ExecuteNonQuery();
                }

                using Microsoft.Data.Sqlite.SqliteCommand holds =
                    context.CreateCommand(
                        "DELETE FROM rbp_verification_holds " +
                        "WHERE rsid=$rsid;");
                holds.Parameters.AddWithValue("$rsid", rsid);
                _ = holds.ExecuteNonQuery();
                return true;
            });
    }

    private static RbpLocalSessionSnapshot BatchCapableLocalSession(
        int port,
        int processId)
    {
        RbpLocalSessionSnapshot local = LocalSession(port, processId);
        string registration = local.RegistrationPayload.GetRawText().Replace(
            "\"session_capabilities\":[]",
            "\"session_capabilities\":[\"batch_atomic\"]",
            StringComparison.Ordinal);
        return local with { RegistrationPayload = Json(registration) };
    }

    private static string CleanupSuppressionDigest(
        RbpStoredSession session,
        RbpUnregisterTombstone tombstone) =>
        Rfc8785Json.Sha256Digest(
            JsonSerializer.SerializeToElement(
                new
                {
                    schema = "bridge.registration-cleanup-suppression/v1",
                    session.Rsid,
                    session.LocalSessionKey,
                    session.RegistrationDigest,
                    Reason = tombstone.Reason.ToString(),
                    Phase = tombstone.Phase.ToString(),
                }));

    private static RbpConnectionCoordinator CoordinatorForBinding(
        IRbpConnectionCycleFactory factory,
        RbpJournalStore store,
        IRbpLocalSessionCatalog catalog,
        ManualCoordinatorClock clock,
        IRbpInvocationDispatcher dispatcher) =>
        new(
            factory,
            store,
            catalog,
            new RbpConnectionCoordinatorOptions(
                factory.BindingKind ==
                    RbpConnectionBindingKind.StreamableHttpSse
                    ? new Uri("https://gateway.revagent.app/bridge/v1")
                    : new Uri("wss://gateway.revagent.app/bridge/v1"),
                new RbpHelloProfile(
                    "0.1.0",
                    "WS01",
                    "Windows 11",
                    new[] { "2026.07.26.0" })),
            dispatcher,
            clock: clock,
            random: new FixedRandomSource(0));

    private sealed class InProcessBindingFactory :
        IRbpConnectionCycleFactory
    {
        private readonly IRbpConnectionCycle _cycle;
        private int _opened;

        internal InProcessBindingFactory(
            RbpConnectionBindingKind bindingKind,
            IRbpConnectionCycle cycle)
        {
            BindingKind = bindingKind;
            _cycle = cycle;
        }

        public RbpConnectionBindingKind BindingKind { get; }
        internal int OpenCount => Volatile.Read(ref _opened);

        public Task<IRbpConnectionCycle> OpenAsync(
            Uri endpoint,
            RbpHelloProfile profile,
            CancellationToken cancellationToken = default)
        {
            _ = endpoint;
            _ = profile;
            cancellationToken.ThrowIfCancellationRequested();
            if (Interlocked.Exchange(ref _opened, 1) != 0)
            {
                throw new IOException("No second in-process cycle exists.");
            }

            return Task.FromResult(_cycle);
        }
    }

    private sealed class CleanupRaceHarness : IAsyncDisposable
    {
        internal CleanupRaceHarness(
            RbpJournalTestDirectory directory,
            RbpJournalStore store,
            ManualCoordinatorClock clock,
            FakeConnectionCycle cycle,
            MutableSessionCatalog catalog,
            StubInvocationDispatcher dispatcher,
            RbpConnectionCoordinator coordinator,
            CancellationTokenSource stop,
            Task run,
            TaskCompletionSource unregisterRelease)
        {
            Directory = directory;
            Store = store;
            Clock = clock;
            Cycle = cycle;
            Catalog = catalog;
            Dispatcher = dispatcher;
            Coordinator = coordinator;
            Stop = stop;
            Run = run;
            UnregisterRelease = unregisterRelease;
        }

        internal RbpJournalTestDirectory Directory { get; }
        internal RbpJournalStore Store { get; }
        internal ManualCoordinatorClock Clock { get; }
        internal FakeConnectionCycle Cycle { get; }
        internal MutableSessionCatalog Catalog { get; }
        internal StubInvocationDispatcher Dispatcher { get; }
        internal RbpConnectionCoordinator Coordinator { get; }
        internal CancellationTokenSource Stop { get; }
        internal Task Run { get; }
        internal TaskCompletionSource UnregisterRelease { get; }
        private int _allowExpectedPresteadyMustExit;

        internal void AllowExpectedPresteadyMustExitOnDispose() =>
            Interlocked.Exchange(ref _allowExpectedPresteadyMustExit, 1);

        public async ValueTask DisposeAsync()
        {
            UnregisterRelease.TrySetResult();
            Task<RbpCoordinatorTeardownResult> teardown =
                Coordinator.RequestStopTeardown();
            Stop.Cancel();
            try
            {
                _ = await teardown.WaitAsync(TimeSpan.FromSeconds(2));
                await Run.WaitAsync(TimeSpan.FromSeconds(2));
            }
            catch (OperationCanceledException)
            {
            }
            catch (RbpCoordinatorException exception) when (
                Volatile.Read(ref _allowExpectedPresteadyMustExit) != 0 &&
                exception.ErrorCode ==
                RbpCoordinatorErrorCode.NonDrainingConnectionAuthority)
            {
                // These exact cases already asserted the protocol/cleanup
                // close. Their synthetic one-cycle factory can be cancelled
                // during the replacement attempt's PreSteady window; V11
                // requires that cleanup-only race to publish must-exit.
            }
            finally
            {
                Stop.Dispose();
                await Store.DisposeAsync();
                Directory.Dispose();
            }
        }
    }

    private static async Task InstallUnresolvedMutationAsync(
        RbpJournalStore store,
        string rsid,
        int suffix)
    {
        string invocationId = Id(suffix);
        var identity = new RbpInvocationIdentity(
            rsid,
            invocationId,
            "set_element_parameter",
            Mutating: true,
            MutationScopeJcs:
                "{\"document_id\":\"doc-1\",\"kind\":\"document\"}",
            ParamsDigest:
                "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            PolicyJcs:
                "{\"class\":\"confirm\",\"confirmation_id\":\"c1\",\"decision\":\"confirmed\"}",
            RecoveryClearancesJcs: "[]");
        Assert.Equal(
            RbpInvocationAdmission.Accepted,
            (await store.AdmitInvocationAsync(identity)).Admission);
        Assert.Equal(
            RbpInvocationAdmission.RefuseIndeterminate,
            (await store.AdmitInvocationAsync(identity)).Admission);
    }

    private static JsonElement CleanupBatchPayload(
        string batchId,
        string invocationId,
        bool atomic = false,
        string method = "get_current_view_info")
    {
        RbpBatchIdentity identity = RbpBatchTestData.Batch(
            atomic,
            batchId,
            new[] { RbpBatchTestData.ReadStep(invocationId, method: method) },
            rsid: "rs-8081");
        return Json(
            $$"""
            {
              "batch_id":"{{batchId}}",
              "batch_digest":"{{identity.BatchDigest}}",
              "atomic":{{atomic.ToString().ToLowerInvariant()}},
              "timeout_ms":120000,
              "recovery_clearances":[],
              "steps":[{
                "invocation_id":"{{invocationId}}",
                "method":"{{method}}",
                "params":{},
                "params_digest":"{{RbpBatchTestData.EmptyObjectDigest}}",
                "mutating":false,
                "mutation_scope":null,
                "policy":{"class":"auto","decision":"allowed","confirmation_id":null}
              }]
            }
            """);
    }

    private static JsonElement CleanupReadPayload(string invocationId) =>
        Json(
            $$"""
            {
              "invocation_id":"{{invocationId}}",
              "method":"get_current_view_info",
              "params":{},
              "timeout_ms":120000,
              "mutating":false,
              "mutation_scope":null,
              "policy":{"class":"auto","decision":"auto","confirmation_id":null},
              "verification":null,
              "recovery_clearances":[]
            }
            """);
}
