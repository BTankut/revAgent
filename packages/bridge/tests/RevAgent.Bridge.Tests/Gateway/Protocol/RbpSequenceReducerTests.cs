using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Protocol;

public sealed class RbpSequenceReducerTests
{
    [Fact]
    public void RetransmissionRetainsOrderAndRefreshesOnlyAckAndTimestamp()
    {
        RbpSequenceState state = QueueCount(3);
        for (long sequence = 1; sequence <= 7; sequence++)
        {
            RbpInboundDataResult received =
                RbpSequenceReducer.AcceptInboundData(
                    state,
                    Inbound("rs-a", sequence, sequence));
            Assert.Equal(RbpInboundDataKind.Accepted, received.Kind);
            state = received.State;
        }

        string[] before = state.Outbox
            .Select(entry => entry.ImmutableDigest)
            .ToArray();
        RbpAcknowledgementResult acknowledged =
            RbpSequenceReducer.ApplyCumulativeAcknowledgement(state, 1);
        Assert.Equal(RbpAcknowledgementKind.Advanced, acknowledged.Kind);

        IReadOnlyList<RbpDataEnvelopeSnapshot> retransmissions =
            RbpSequenceReducer.RetransmitOutbox(
                acknowledged.State,
                acknowledgement: 7,
                timestamp: "2026-07-22T15:00:00.000Z");

        Assert.Equal(new long[] { 2, 3 }, retransmissions
            .Select(envelope => envelope.Sequence));
        Assert.All(
            retransmissions,
            envelope => Assert.Equal(7, envelope.Acknowledgement));
        Assert.Equal(
            before[1..],
            retransmissions
                .Select(Rfc8785Json.ImmutableEnvelopeDigest)
                .ToArray());
    }

    [Fact]
    public void SendAndReceiveAcknowledgementAxesRemainIndependentAndBounded()
    {
        RbpSequenceState state = QueueCount(2);
        Assert.Throws<ArgumentOutOfRangeException>(
            () => RbpSequenceReducer.QueueOutboundData(
                state,
                Draft("bad-ack", acknowledgement: 1)));
        Assert.Throws<ArgumentOutOfRangeException>(
            () => RbpSequenceReducer.RetransmitOutbox(
                state,
                acknowledgement: 1));

        RbpInboundDataResult peerOne =
            RbpSequenceReducer.AcceptInboundData(
                state,
                Inbound("rs-a", 1, 1, acknowledgement: 2));
        Assert.Equal(RbpInboundDataKind.Accepted, peerOne.Kind);
        state = peerOne.State;
        Assert.Equal(1, state.LastRxSequence);
        Assert.Equal(2, state.LastPeerAcknowledgement);
        Assert.Empty(state.Outbox);

        RbpQueueOutboundResult bounded =
            RbpSequenceReducer.QueueOutboundData(
                state,
                Draft("bounded-ack", acknowledgement: 1));
        Assert.Equal(RbpQueueOutboundKind.Queued, bounded.Kind);
        Assert.Equal(1, bounded.Envelope?.Acknowledgement);
    }

    [Fact]
    public void PeerAcknowledgementBeyondSentDoesNotAdvanceReceiveState()
    {
        RbpSequenceState state = QueueCount(2);
        RbpInboundDataResult result =
            RbpSequenceReducer.AcceptInboundData(
                state,
                Inbound("rs-a", 1, 1, acknowledgement: 3));

        Assert.Equal(RbpInboundDataKind.ProtocolFault, result.Kind);
        Assert.Equal(
            RbpSequenceFault.AcknowledgementBeyondSent,
            result.Fault);
        Assert.Same(state, result.State);
        Assert.Equal(0, state.LastRxSequence);
        Assert.Equal(2, state.Outbox.Count);
    }

    [Fact]
    public void CumulativeAcknowledgementsAdvanceDuplicateStaleAndFaultExactly()
    {
        RbpSequenceState state = QueueCount(3);
        RbpAcknowledgementResult advanced =
            RbpSequenceReducer.ApplyCumulativeAcknowledgement(state, 2);
        Assert.Equal(RbpAcknowledgementKind.Advanced, advanced.Kind);
        Assert.Equal(new long[] { 1, 2 }, advanced.AcknowledgedSequences);
        Assert.Equal(
            RbpAcknowledgementKind.Stale,
            RbpSequenceReducer.ApplyCumulativeAcknowledgement(
                    advanced.State,
                    1)
                .Kind);
        Assert.Equal(
            RbpAcknowledgementKind.Duplicate,
            RbpSequenceReducer.ApplyCumulativeAcknowledgement(
                    advanced.State,
                    2)
                .Kind);
        RbpAcknowledgementResult fault =
            RbpSequenceReducer.ApplyCumulativeAcknowledgement(
                advanced.State,
                4);
        Assert.Equal(RbpAcknowledgementKind.ProtocolFault, fault.Kind);
        Assert.Equal(
            RbpSequenceFault.AcknowledgementBeyondSent,
            fault.Fault);
    }

    [Fact]
    public void IdenticalDuplicatesAreAcceptedButIdentityReuseAndGapsFailClosed()
    {
        RbpSequenceState initial = RbpSequenceReducer.Create("rs-a");
        RbpInboundDataResult first =
            RbpSequenceReducer.AcceptInboundData(
                initial,
                Inbound("rs-a", 1, 10));
        Assert.Equal(RbpInboundDataKind.Accepted, first.Kind);

        RbpInboundDataResult duplicate =
            RbpSequenceReducer.AcceptInboundData(
                first.State,
                Inbound("rs-a", 1, 10));
        Assert.Equal(RbpInboundDataKind.Duplicate, duplicate.Kind);
        Assert.Equal(1, duplicate.Acknowledgement);

        RbpInboundDataResult identityReuse =
            RbpSequenceReducer.AcceptInboundData(
                first.State,
                Inbound("rs-a", 1, 11));
        Assert.Equal(RbpInboundDataKind.ProtocolFault, identityReuse.Kind);
        Assert.Equal(
            RbpSequenceFault.DuplicateIdentityMismatch,
            identityReuse.Fault);

        RbpInboundDataResult gap =
            RbpSequenceReducer.AcceptInboundData(
                first.State,
                Inbound("rs-a", 3, 30));
        Assert.Equal(RbpInboundDataKind.Gap, gap.Kind);
        Assert.Equal(2, gap.ExpectedSequence);
        Assert.Equal(3, gap.ReceivedSequence);
        Assert.Equal(1, gap.Acknowledgement);
        Assert.Same(first.State, gap.State);
    }

    [Fact]
    public void MaximumSafeSequenceIsUsedOnceAndRequiresDrainBeforeRenewal()
    {
        RbpSequenceState nearLimit =
            RbpSequenceReducer.Create("rs-limit") with
            {
                NextTxSequence = RbpSequenceReducer.MaximumSafeSequence,
                HighestTxSequence =
                    RbpSequenceReducer.MaximumSafeSequence - 1,
                LastPeerAcknowledgement =
                    RbpSequenceReducer.MaximumSafeSequence - 1,
            };
        RbpQueueOutboundResult final =
            RbpSequenceReducer.QueueOutboundData(
                nearLimit,
                Draft("id-limit"));

        Assert.Equal(RbpQueueOutboundKind.Queued, final.Kind);
        Assert.Equal(
            RbpSequenceReducer.MaximumSafeSequence,
            final.Envelope?.Sequence);
        Assert.True(final.RenewalRequired);
        Assert.Equal(
            RbpSequenceRenewalStatus.DrainRequired,
            RbpSequenceReducer.RenewalStatus(final.State));
        Assert.Equal(
            RbpQueueOutboundKind.RenewalRequired,
            RbpSequenceReducer.QueueOutboundData(
                    final.State,
                    Draft("never-wrap"))
                .Kind);

        RbpAcknowledgementResult drained =
            RbpSequenceReducer.ApplyCumulativeAcknowledgement(
                final.State,
                RbpSequenceReducer.MaximumSafeSequence);
        Assert.Equal(RbpAcknowledgementKind.Advanced, drained.Kind);
        Assert.Equal(
            RbpSequenceRenewalStatus.ReadyForNewRsid,
            RbpSequenceReducer.RenewalStatus(drained.State));

        RbpInboundDataResult unsafeSequence =
            RbpSequenceReducer.AcceptInboundData(
                RbpSequenceReducer.Create("rs-limit"),
                Inbound(
                    "rs-limit",
                    RbpSequenceReducer.MaximumSafeSequence + 1,
                    1));
        Assert.Equal(RbpInboundDataKind.ProtocolFault, unsafeSequence.Kind);
        Assert.Equal(
            RbpSequenceFault.UnsafeSequence,
            unsafeSequence.Fault);
    }

    [Fact]
    public void DispatchWindowIsOnePerRsidAndParallelAcrossSessions()
    {
        RbpDispatchWindowLedger ledger =
            RbpSequenceReducer.CreateDispatchWindowLedger();
        RbpOpenDispatchWindowResult first =
            RbpSequenceReducer.OpenDispatchWindow(
                ledger,
                new RbpDispatchWindowEntry(
                    "rs-a",
                    "inv-a1",
                    RbpDispatchKind.Invoke));
        Assert.Equal(RbpOpenDispatchWindowKind.Opened, first.Kind);
        ledger = first.Ledger;

        RbpOpenDispatchWindowResult collision =
            RbpSequenceReducer.OpenDispatchWindow(
                ledger,
                new RbpDispatchWindowEntry(
                    "rs-a",
                    "inv-a2",
                    RbpDispatchKind.InvokeBatch));
        Assert.Equal(
            RbpOpenDispatchWindowKind.ProtocolFault,
            collision.Kind);
        Assert.Equal("inv-a1", collision.Active?.InvocationId);

        RbpOpenDispatchWindowResult parallel =
            RbpSequenceReducer.OpenDispatchWindow(
                ledger,
                new RbpDispatchWindowEntry(
                    "rs-b",
                    "inv-b1",
                    RbpDispatchKind.Invoke));
        Assert.Equal(RbpOpenDispatchWindowKind.Opened, parallel.Kind);
        Assert.Equal(2, parallel.Ledger.Active.Count);

        RbpDispatchWindowLedger closed =
            RbpSequenceReducer.CloseDispatchWindow(
                parallel.Ledger,
                "rs-a",
                "inv-a1");
        Assert.Single(closed.Active);
        Assert.Equal("rs-b", closed.Active[0].Rsid);
    }

    [Fact]
    public void MonotonicAcknowledgementsPreserveOutboxInvariant()
    {
        for (int sent = 1; sent <= 100; sent++)
        {
            RbpSequenceState state = QueueCount(sent);
            for (int acknowledgement = 0;
                 acknowledgement <= sent;
                 acknowledgement++)
            {
                RbpAcknowledgementResult result =
                    RbpSequenceReducer.ApplyCumulativeAcknowledgement(
                        state,
                        acknowledgement);
                Assert.NotEqual(
                    RbpAcknowledgementKind.ProtocolFault,
                    result.Kind);
                state = result.State;
                Assert.Equal(
                    acknowledgement,
                    state.LastPeerAcknowledgement);
                Assert.All(
                    state.Outbox,
                    retained => Assert.True(
                        retained.Envelope.Sequence > acknowledgement));
            }
        }
    }

    [Fact]
    public void ForwardGapsNeverAdvanceReceiveState()
    {
        foreach (long sequence in new long[] { 2, 3, 100, 100_000 })
        {
            RbpSequenceState state = RbpSequenceReducer.Create("rs-gap");
            RbpInboundDataResult result =
                RbpSequenceReducer.AcceptInboundData(
                    state,
                    Inbound("rs-gap", sequence, sequence));
            Assert.Equal(RbpInboundDataKind.Gap, result.Kind);
            Assert.Same(state, result.State);
            Assert.Equal(0, result.State.LastRxSequence);
        }
    }

    private static RbpSequenceState QueueCount(int count)
    {
        RbpSequenceState state = RbpSequenceReducer.Create("rs-a");
        for (int index = 0; index < count; index++)
        {
            RbpQueueOutboundResult queued =
                RbpSequenceReducer.QueueOutboundData(
                    state,
                    Draft($"id-{index + 1}", index));
            Assert.Equal(RbpQueueOutboundKind.Queued, queued.Kind);
            state = queued.State;
        }

        return state;
    }

    private static RbpOutboundDataDraft Draft(
        string id,
        int value = 0,
        long? acknowledgement = null)
    {
        return new RbpOutboundDataDraft(
            "result",
            id,
            Json(value),
            acknowledgement);
    }

    private static RbpDataEnvelopeSnapshot Inbound(
        string rsid,
        long sequence,
        long value,
        long? acknowledgement = null)
    {
        return new RbpDataEnvelopeSnapshot(
            "invoke",
            $"id-{sequence}",
            rsid,
            sequence,
            Json(value),
            acknowledgement);
    }

    private static JsonElement Json(long value)
    {
        using JsonDocument document =
            JsonDocument.Parse($"{{\"value\":{value}}}");
        return document.RootElement.Clone();
    }
}
