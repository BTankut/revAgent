using System.Text.Json;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Harness;

/// <summary>
/// P3-T13: the scripted fault scenarios, run unattended against the launched
/// O1 Gateway stub.
/// </summary>
/// <remarks>
/// <para>
/// Each scenario reproduces one frozen P3-T4/P3-T5 acceptance clause end to
/// end — link kill mid-invocation, duplicate delivery, slow consumer, and
/// machine sleep/wake — over the real WSS binding, the real connection
/// coordinator, and the real SQLite invocation journal.
/// </para>
/// <para>
/// The scenarios share one class so the launched Node stubs run one at a time:
/// xUnit parallelises across classes, and a fault harness that races other
/// fault harnesses for ports and CPU stops being deterministic.
/// </para>
/// </remarks>
[Collection(SocketIntegrationCollection.Name)]
public sealed class RbpFaultScenarioTests
{
    /// <summary>
    /// P3-T5: a byte-identical redelivery of the same <c>invoke</c> frame is
    /// absorbed by the sequence authority, so the add-in runs exactly once.
    /// </summary>
    [Fact]
    public async Task DuplicateInvokeDeliveryCausesExactlyOneExecution()
    {
        await using RbpFaultScenarioHarness harness =
            await RbpFaultScenarioHarness.StartAsync();
        string invocationId = harness.NewInvocationId();

        // The stub writes the next invoke frame twice, byte for byte, on the
        // same sequence number — the shape a retransmitting Gateway produces.
        await harness.Control.EnqueueFrameFaultAsync(
            GatewayFaultDirection.GatewayToBridge,
            GatewayFrameFaultAction.Duplicate,
            messageType: "invoke");
        await harness.Control.DispatchInvokeAsync(
            harness.Rsid,
            RbpFaultScenarioHarness.ReadInvoke(invocationId));

        Assert.Equal(
            "result",
            await harness.WaitForGatewayTerminalAsync(invocationId));
        Assert.Equal(1, harness.Addin.ExecutionsOf(invocationId));
        Assert.Equal(1, harness.Addin.TotalExecutions);

        // One accepted inbound sequence, not two: the duplicate never became a
        // second journal delivery either.
        RbpReceiveFrontier frontier =
            await harness.Journal.GetReceiveFrontierAsync(harness.Rsid);
        Assert.Equal(1, frontier.LastJournaledSequence);
        RbpStoredInvocation? stored =
            await harness.ReadJournalAsync(invocationId);
        Assert.Equal(RbpInvocationState.Completed, stored!.State);
    }

    /// <summary>
    /// P3-T4 and P3-T5 together: killing the link while the add-in is working
    /// must resume the same session without orphaning it, and the redelivery
    /// that follows must be answered from the journal — one execution, ever.
    /// </summary>
    [Fact]
    public async Task LinkKillMidInvocationResumesAndReplaysTheTerminalOnce()
    {
        await using RbpFaultScenarioHarness harness =
            await RbpFaultScenarioHarness.StartAsync();
        string rsid = harness.Rsid;
        string invocationId = harness.NewInvocationId();
        string connectionId = await harness.ConnectionIdAsync();

        // Park the add-in so the kill lands provably mid-invocation rather
        // than probably mid-invocation.
        Task reachedAddin = harness.Addin.ArmGate();
        await harness.Control.DispatchInvokeAsync(
            rsid,
            RbpFaultScenarioHarness.ReadInvoke(invocationId));
        await reachedAddin.WaitAsync(TimeSpan.FromSeconds(20));

        await harness.Control.KillLinkAsync(connectionId);
        harness.Addin.ReleaseGate();

        await harness.WaitForConnectionGenerationAsync(2);
        await harness.WaitForSingleBoundSessionAsync();

        // Resume, not re-register: the same rsid survived the kill, so the
        // Gateway holds no orphaned session.
        Assert.Equal(rsid, harness.Rsid);
        using (GatewayStubView view = await harness.Control.SnapshotAsync())
        {
            Assert.Equal(new[] { rsid }, view.AllRsids);
            Assert.Equal(new[] { rsid }, view.LiveRsids);
            Assert.Equal(1, view.OpenConnectionCount);
        }

        // The outcome the add-in already produced is durable, and the
        // reconnect did not re-run it.
        RbpStoredInvocation? stored =
            await harness.ReadJournalAsync(invocationId);
        Assert.Equal(RbpInvocationState.Completed, stored!.State);
        Assert.Equal(1, harness.Addin.TotalExecutions);

        // P-BRIDGE-3 redelivery: the Gateway releases its expired dispatch
        // window and sends the very same invocation again.
        await harness.Control.ExpirePendingAsync(rsid);
        await harness.Control.DispatchInvokeAsync(
            rsid,
            RbpFaultScenarioHarness.ReadInvoke(invocationId));

        await RbpFaultScenarioHarness.EventuallyAsync(
            async () =>
            {
                using GatewayStubView view =
                    await harness.Control.SnapshotAsync();
                return view.TerminalPayload(rsid, invocationId) is
                { } payload &&
                    payload.GetProperty("replayed").GetBoolean();
            },
            "the redelivered invocation was not answered as a journal replay");

        // Section 12.2 rule 1: the replay is answered from the journal, so the
        // add-in execution count is still exactly one.
        Assert.Equal(1, harness.Addin.TotalExecutions);
        Assert.Equal(1, harness.Addin.ExecutionsOf(invocationId));

        // Sequence state survived the reconnect on both peers rather than
        // restarting: the Gateway's outbound high-water mark and the bridge's
        // durable receive frontier still agree, at 2.
        RbpReceiveFrontier frontier =
            await harness.Journal.GetReceiveFrontierAsync(rsid);
        using GatewayStubView resumed = await harness.Control.SnapshotAsync();
        Assert.Equal(2, frontier.LastJournaledSequence);
        Assert.Equal(2, resumed.HighestTransmittedSequence(rsid));
    }

    /// <summary>
    /// P3-T13 slow consumer, outbound leg: the Gateway stops draining while a
    /// terminal is in flight. The terminal must be neither lost nor produced
    /// twice once the consumer catches up.
    /// </summary>
    [Fact]
    public async Task SlowConsumerStallsTheTerminalWithoutLosingOrRepeatingIt()
    {
        await using RbpFaultScenarioHarness harness =
            await RbpFaultScenarioHarness.StartAsync();
        string rsid = harness.Rsid;
        string invocationId = harness.NewInvocationId();

        await harness.Control.EnqueueFrameFaultAsync(
            GatewayFaultDirection.BridgeToGateway,
            GatewayFrameFaultAction.Hold,
            messageType: "result");
        await harness.Control.DispatchInvokeAsync(
            rsid,
            RbpFaultScenarioHarness.ReadInvoke(invocationId));

        await RbpFaultScenarioHarness.EventuallyAsync(
            async () =>
            {
                using GatewayStubView view =
                    await harness.Control.SnapshotAsync();
                return view.HeldInboundFrameCount == 1;
            },
            "the slow consumer never parked the bridge's terminal");

        // The bridge is done and durable; the Gateway has not seen it yet.
        RbpStoredInvocation? stored =
            await harness.ReadJournalAsync(invocationId);
        Assert.Equal(RbpInvocationState.Completed, stored!.State);
        using (GatewayStubView stalled = await harness.Control.SnapshotAsync())
        {
            Assert.Null(stalled.TerminalClassification(rsid, invocationId));
            Assert.True(stalled.HasInFlight(rsid));
        }

        Assert.Equal(1, await harness.Control.FlushHeldAsync());

        Assert.Equal(
            "result",
            await harness.WaitForGatewayTerminalAsync(invocationId));
        using GatewayStubView drained = await harness.Control.SnapshotAsync();
        JsonElement payload = drained.TerminalPayload(rsid, invocationId)!.Value;
        Assert.Equal(
            invocationId,
            payload.GetProperty("invocation_id").GetString());
        Assert.Equal("completed", payload.GetProperty("status").GetString());
        Assert.False(payload.GetProperty("replayed").GetBoolean());
        Assert.False(drained.HasInFlight(rsid));

        // Back-pressure is not a redelivery trigger.
        Assert.Equal(1, harness.Addin.TotalExecutions);
    }

    /// <summary>
    /// P3-T13 slow consumer, inbound leg: two Gateway frames are parked and
    /// then released together. They must reach the journal in dispatch order —
    /// a reorder would be a forward sequence gap and would kill the connection.
    /// </summary>
    [Fact]
    public async Task SlowConsumerFlushPreservesInboundFrameOrder()
    {
        await using RbpFaultScenarioHarness harness =
            await RbpFaultScenarioHarness.StartAsync();
        string rsid = harness.Rsid;
        string invocationId = harness.NewInvocationId();
        long generation = harness.Coordinator.GetSnapshot().ConnectionGeneration;

        await harness.Control.EnqueueFrameFaultAsync(
            GatewayFaultDirection.GatewayToBridge,
            GatewayFrameFaultAction.Hold,
            messageType: "invoke");
        await harness.Control.EnqueueFrameFaultAsync(
            GatewayFaultDirection.GatewayToBridge,
            GatewayFrameFaultAction.Hold,
            messageType: "cancel");

        await harness.Control.DispatchInvokeAsync(
            rsid,
            RbpFaultScenarioHarness.ReadInvoke(invocationId));
        await harness.Control.DispatchCancelAsync(rsid, invocationId);

        using (GatewayStubView parked = await harness.Control.SnapshotAsync())
        {
            Assert.Equal(2, parked.HeldOutboundFrameCount);
        }

        Assert.Equal(0, harness.Addin.TotalExecutions);

        Assert.Equal(2, await harness.Control.FlushHeldAsync());

        await RbpFaultScenarioHarness.EventuallyAsync(
            async () =>
                (await harness.Journal.GetReceiveFrontierAsync(rsid))
                .LastJournaledSequence == 2,
            "the released frames did not both reach the durable journal");

        // Same connection generation: neither frame arrived out of order, so
        // the sequence authority never had to fail the cycle closed.
        Assert.Equal(
            generation,
            harness.Coordinator.GetSnapshot().ConnectionGeneration);

        // The invoke, and only the invoke, reached the add-in — once.
        await RbpFaultScenarioHarness.EventuallyAsync(
            () => harness.Addin.TotalExecutions == 1,
            "the released invoke never reached the add-in");
        Assert.Equal(
            new[] { invocationId },
            harness.Addin.ExecutionOrder);
        Assert.Equal(
            "cancelled",
            await harness.WaitForGatewayTerminalAsync(invocationId));
    }

    /// <summary>
    /// P3-T4: a machine suspend shows up as a monotonic-clock gap wider than
    /// the liveness window. The bridge must abandon the stale socket, resume
    /// the same session, and leave nothing orphaned at the Gateway.
    /// </summary>
    [Fact]
    public async Task SleepWakeReconnectsAndResumesWithoutOrphanedSessions()
    {
        await using RbpFaultScenarioHarness harness =
            await RbpFaultScenarioHarness.StartAsync();
        string rsid = harness.Rsid;
        string connectionId = await harness.ConnectionIdAsync();

        // Wait until the heartbeat loop is genuinely parked on its interval so
        // the jump lands where a real suspend would land.
        await RbpFaultScenarioHarness.EventuallyAsync(
            () => harness.Clock.HasPendingDelayDueIn(TimeSpan.FromSeconds(15)),
            "the heartbeat loop never armed its interval");

        // 70 s > the 65 s liveness window: the wake-gap detector must fire.
        harness.Clock.Advance(TimeSpan.FromSeconds(70));

        await harness.WaitForConnectionGenerationAsync(2);
        await harness.WaitForSingleBoundSessionAsync();

        Assert.Equal(rsid, harness.Rsid);
        await RbpFaultScenarioHarness.EventuallyAsync(
            async () =>
            {
                using GatewayStubView view =
                    await harness.Control.SnapshotAsync();
                return view.OpenConnectionCount == 1 &&
                       !view.ConnectionIds.Contains(
                           connectionId,
                           StringComparer.Ordinal);
            },
            "the pre-suspend connection was never replaced");

        using GatewayStubView woken = await harness.Control.SnapshotAsync();
        Assert.Equal(new[] { rsid }, woken.AllRsids);
        Assert.Equal(new[] { rsid }, woken.LiveRsids);

        // A suspend is not an invocation event.
        Assert.Equal(0, harness.Addin.TotalExecutions);

        // The resumed session can still carry work, which is the real proof
        // that resume restored sequence authority rather than merely a socket.
        string invocationId = harness.NewInvocationId();
        await harness.Control.DispatchInvokeAsync(
            rsid,
            RbpFaultScenarioHarness.ReadInvoke(invocationId));
        Assert.Equal(
            "result",
            await harness.WaitForGatewayTerminalAsync(invocationId));
        Assert.Equal(1, harness.Addin.TotalExecutions);
    }

    /// <summary>
    /// P3-T5, the fail-closed boundary of the indeterminate rule: a mutation
    /// the transport can prove it never dispatched stays a known failure. No
    /// Section 6.2.1 hold is installed on either peer, and nothing is blocked.
    /// </summary>
    [Fact]
    public async Task ProvablyUndispatchedMutationStaysKnownAndInstallsNoHold()
    {
        await using RbpFaultScenarioHarness harness =
            await RbpFaultScenarioHarness.StartAsync();
        string rsid = harness.Rsid;
        string invocationId = harness.NewInvocationId();
        long generation = harness.Coordinator.GetSnapshot().ConnectionGeneration;
        harness.Addin.Behavior = HarnessAddinBehavior.KnownNotDispatched;

        await harness.Control.DispatchInvokeAsync(
            rsid,
            RbpFaultScenarioHarness.MutatingInvoke(
                invocationId,
                harness.NewInvocationId()));

        Assert.Equal(
            "error",
            await harness.WaitForGatewayTerminalAsync(invocationId));

        // Failed, not indeterminate: the row carries no hold, because nothing
        // about the model state is unknown.
        RbpStoredInvocation? stored =
            await harness.ReadJournalAsync(invocationId);
        Assert.Equal(RbpInvocationState.Failed, stored!.State);
        Assert.Null(stored.VerificationHoldId);

        using GatewayStubView view = await harness.Control.SnapshotAsync();
        Assert.Empty(view.ActiveMutationHoldIds);
        Assert.False(view.HasInFlight(rsid));
        JsonElement payload = view.TerminalPayload(rsid, invocationId)!.Value;
        Assert.Equal("known", payload.GetProperty("outcome").GetString());
        Assert.False(payload.GetProperty("verification_required").GetBoolean());
        Assert.False(payload.GetProperty("retryable").GetBoolean());

        // A known failure is an invocation fault, never a connection fault.
        Assert.Equal(
            generation,
            harness.Coordinator.GetSnapshot().ConnectionGeneration);
        Assert.Equal(1, harness.Addin.TotalExecutions);
    }

    /// <summary>
    /// P3-T4: the soak shape, scaled to one unattended run — repeated induced
    /// faults must leave zero orphaned sessions and a session that still works.
    /// </summary>
    /// <remarks>
    /// This is the loop body the nightly soak job runs for hours; the duration
    /// is the only thing the soak job adds. Alternating the two fault kinds
    /// matters: a link kill closes the socket from the Gateway side, a wake gap
    /// abandons it from the bridge side, and only the second exercises the
    /// bridge deciding on its own that a live-looking socket is stale.
    /// </remarks>
    [Fact]
    public async Task RepeatedInducedFaultsLeaveZeroOrphanedSessions()
    {
        const int cycles = 4;
        await using RbpFaultScenarioHarness harness =
            await RbpFaultScenarioHarness.StartAsync();
        string rsid = harness.Rsid;

        for (int cycle = 0; cycle < cycles; cycle++)
        {
            if (cycle % 2 == 0)
            {
                await harness.Control.KillLinkAsync(
                    await harness.ConnectionIdAsync());
            }
            else
            {
                await RbpFaultScenarioHarness.EventuallyAsync(
                    () => harness.Clock.HasPendingDelayDueIn(
                        TimeSpan.FromSeconds(15)),
                    "the heartbeat loop never armed its interval");
                harness.Clock.Advance(TimeSpan.FromSeconds(70));
            }

            await harness.WaitForConnectionGenerationAsync(cycle + 2);
            await harness.WaitForSingleBoundSessionAsync();
            Assert.Equal(rsid, harness.Rsid);

            // The resumed session must still be able to carry an invocation to
            // a Gateway-accepted terminal, or "not orphaned" would be a claim
            // about bookkeeping rather than about a usable session.
            string invocationId = harness.NewInvocationId();
            await harness.Control.DispatchInvokeAsync(
                rsid,
                RbpFaultScenarioHarness.ReadInvoke(invocationId));
            Assert.Equal(
                "result",
                await harness.WaitForGatewayTerminalAsync(invocationId));
            Assert.Equal(1, harness.Addin.ExecutionsOf(invocationId));
        }

        using GatewayStubView view = await harness.Control.SnapshotAsync();
        Assert.Equal(new[] { rsid }, view.AllRsids);
        Assert.Equal(new[] { rsid }, view.LiveRsids);
        Assert.Equal(1, view.OpenConnectionCount);
        Assert.Empty(view.ActiveMutationHoldIds);
        Assert.False(view.HasInFlight(rsid));

        // One execution per cycle, and not one more: no induced fault turned
        // into a redelivery the add-in had to run twice.
        Assert.Equal(cycles, harness.Addin.TotalExecutions);
        Assert.Equal(
            cycles,
            harness.Addin.ExecutionOrder.Distinct(StringComparer.Ordinal)
                .Count());
    }
}
