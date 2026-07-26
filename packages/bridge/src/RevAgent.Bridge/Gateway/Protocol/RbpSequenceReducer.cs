using System.Collections.ObjectModel;
using System.Text.Json;

namespace RevAgent.Bridge.Gateway.Protocol;

internal sealed record RbpOutboundDataDraft(
    string Type,
    string Id,
    JsonElement Payload,
    long? Acknowledgement = null,
    string? Timestamp = null,
    int? Version = null);

internal sealed record RbpRetainedOutboundData(
    string ImmutableDigest,
    RbpDataEnvelopeSnapshot Envelope);

internal sealed record RbpAcceptedInboundData(
    long Sequence,
    string ImmutableDigest);

internal sealed record RbpSequenceState(
    string Rsid,
    long? NextTxSequence,
    long HighestTxSequence,
    long LastRxSequence,
    long LastPeerAcknowledgement,
    IReadOnlyList<RbpRetainedOutboundData> Outbox,
    IReadOnlyList<RbpAcceptedInboundData> AcceptedInbound);

internal enum RbpQueueOutboundKind
{
    Queued,
    RenewalRequired,
}

internal sealed record RbpQueueOutboundResult(
    RbpQueueOutboundKind Kind,
    RbpSequenceState State,
    RbpDataEnvelopeSnapshot? Envelope = null,
    bool RenewalRequired = false,
    bool OutboxDrained = false);

internal enum RbpAcknowledgementKind
{
    Advanced,
    Duplicate,
    Stale,
    ProtocolFault,
}

internal enum RbpSequenceFault
{
    None,
    WrongRsid,
    UnsafeSequence,
    UnsafeAcknowledgement,
    AcknowledgementBeyondSent,
    SequenceExhausted,
    DuplicateIdentityMismatch,
}

internal sealed record RbpAcknowledgementResult(
    RbpAcknowledgementKind Kind,
    RbpSequenceState State,
    IReadOnlyList<long> AcknowledgedSequences,
    RbpSequenceFault Fault = RbpSequenceFault.None);

internal enum RbpInboundDataKind
{
    Accepted,
    Duplicate,
    Gap,
    ProtocolFault,
}

internal sealed record RbpInboundDataResult(
    RbpInboundDataKind Kind,
    RbpSequenceState State,
    long Acknowledgement,
    RbpSequenceFault Fault = RbpSequenceFault.None,
    long? ExpectedSequence = null,
    long? ReceivedSequence = null);

internal enum RbpSequenceRenewalStatus
{
    NotRequired,
    DrainRequired,
    ReadyForNewRsid,
}

internal enum RbpDispatchKind
{
    Invoke,
    InvokeBatch,
}

internal sealed record RbpDispatchWindowEntry(
    string Rsid,
    string InvocationId,
    RbpDispatchKind Kind);

internal sealed record RbpDispatchWindowLedger(
    IReadOnlyList<RbpDispatchWindowEntry> Active);

internal enum RbpOpenDispatchWindowKind
{
    Opened,
    ProtocolFault,
}

internal sealed record RbpOpenDispatchWindowResult(
    RbpOpenDispatchWindowKind Kind,
    RbpDispatchWindowLedger Ledger,
    RbpDispatchWindowEntry? Active = null);

internal static class RbpSequenceReducer
{
    internal const long MaximumSafeSequence =
        RbpProtocolLimits.MaximumSafeInteger;

    internal static RbpSequenceState Create(string rsid)
    {
        RequireNonEmpty(rsid, nameof(rsid));
        return new RbpSequenceState(
            rsid,
            NextTxSequence: 1,
            HighestTxSequence: 0,
            LastRxSequence: 0,
            LastPeerAcknowledgement: 0,
            Empty<RbpRetainedOutboundData>(),
            Empty<RbpAcceptedInboundData>());
    }

    internal static RbpQueueOutboundResult QueueOutboundData(
        RbpSequenceState state,
        RbpOutboundDataDraft draft)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(draft);
        RequireNonEmpty(draft.Type, nameof(draft.Type));
        RequireNonEmpty(draft.Id, nameof(draft.Id));
        if (draft.Version is not null and not 1)
        {
            throw new ArgumentOutOfRangeException(
                nameof(draft),
                "RBP/1 outbound data must use v=1.");
        }

        if (draft.Acknowledgement is { } acknowledgement)
        {
            RequireSafeSequence(
                acknowledgement,
                allowZero: true,
                nameof(draft.Acknowledgement));
            if (acknowledgement > state.LastRxSequence)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(draft),
                    "Outbound acknowledgement cannot exceed LastRxSequence.");
            }
        }

        if (state.NextTxSequence is not { } sequence)
        {
            return new RbpQueueOutboundResult(
                RbpQueueOutboundKind.RenewalRequired,
                state,
                OutboxDrained: state.Outbox.Count == 0);
        }

        RequireSafeSequence(
            sequence,
            allowZero: false,
            nameof(state.NextTxSequence));
        var envelope = new RbpDataEnvelopeSnapshot(
            draft.Type,
            draft.Id,
            state.Rsid,
            sequence,
            draft.Payload.Clone(),
            draft.Acknowledgement,
            draft.Timestamp);
        var retained = new RbpRetainedOutboundData(
            Rfc8785Json.ImmutableEnvelopeDigest(envelope),
            envelope.Snapshot());
        long? nextSequence =
            sequence == MaximumSafeSequence ? null : sequence + 1;
        RbpSequenceState nextState = state with
        {
            NextTxSequence = nextSequence,
            HighestTxSequence = sequence,
            Outbox = Append(state.Outbox, retained),
        };

        return new RbpQueueOutboundResult(
            RbpQueueOutboundKind.Queued,
            nextState,
            envelope.Snapshot(),
            RenewalRequired: nextSequence is null);
    }

    internal static RbpAcknowledgementResult ApplyCumulativeAcknowledgement(
        RbpSequenceState state,
        long acknowledgement)
    {
        ArgumentNullException.ThrowIfNull(state);
        if (!IsSafeSequence(acknowledgement, allowZero: true))
        {
            return FaultedAcknowledgement(
                state,
                RbpSequenceFault.UnsafeAcknowledgement);
        }

        if (acknowledgement > state.HighestTxSequence)
        {
            return FaultedAcknowledgement(
                state,
                RbpSequenceFault.AcknowledgementBeyondSent);
        }

        if (acknowledgement < state.LastPeerAcknowledgement)
        {
            return new RbpAcknowledgementResult(
                RbpAcknowledgementKind.Stale,
                state,
                Empty<long>());
        }

        if (acknowledgement == state.LastPeerAcknowledgement)
        {
            return new RbpAcknowledgementResult(
                RbpAcknowledgementKind.Duplicate,
                state,
                Empty<long>());
        }

        IReadOnlyList<long> acknowledged = Freeze(
            state.Outbox
                .Where(entry => entry.Envelope.Sequence <= acknowledgement)
                .Select(entry => entry.Envelope.Sequence));
        RbpSequenceState nextState = state with
        {
            LastPeerAcknowledgement = acknowledgement,
            Outbox = Freeze(
                state.Outbox.Where(
                    entry => entry.Envelope.Sequence > acknowledgement)),
        };

        return new RbpAcknowledgementResult(
            RbpAcknowledgementKind.Advanced,
            nextState,
            acknowledged);
    }

    internal static RbpInboundDataResult AcceptInboundData(
        RbpSequenceState state,
        RbpDataEnvelopeSnapshot incoming)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(incoming);
        if (!string.Equals(incoming.Rsid, state.Rsid, StringComparison.Ordinal))
        {
            return FaultedInbound(state, RbpSequenceFault.WrongRsid);
        }

        RbpSequenceState stateAfterAcknowledgement = state;
        if (incoming.Acknowledgement is { } acknowledgement)
        {
            RbpAcknowledgementResult acknowledgementResult =
                ApplyCumulativeAcknowledgement(state, acknowledgement);
            if (acknowledgementResult.Kind ==
                RbpAcknowledgementKind.ProtocolFault)
            {
                return FaultedInbound(state, acknowledgementResult.Fault);
            }

            stateAfterAcknowledgement = acknowledgementResult.State;
        }

        if (!IsSafeSequence(incoming.Sequence, allowZero: false))
        {
            return FaultedInbound(
                stateAfterAcknowledgement,
                RbpSequenceFault.UnsafeSequence);
        }

        string digest = Rfc8785Json.ImmutableEnvelopeDigest(incoming);
        if (incoming.Sequence <= stateAfterAcknowledgement.LastRxSequence)
        {
            RbpAcceptedInboundData? retained =
                stateAfterAcknowledgement.AcceptedInbound.FirstOrDefault(
                    entry => entry.Sequence == incoming.Sequence);
            if (retained is not null &&
                string.Equals(
                    retained.ImmutableDigest,
                    digest,
                    StringComparison.Ordinal))
            {
                return new RbpInboundDataResult(
                    RbpInboundDataKind.Duplicate,
                    stateAfterAcknowledgement,
                    stateAfterAcknowledgement.LastRxSequence);
            }

            return FaultedInbound(
                stateAfterAcknowledgement,
                RbpSequenceFault.DuplicateIdentityMismatch);
        }

        if (stateAfterAcknowledgement.LastRxSequence == MaximumSafeSequence)
        {
            return FaultedInbound(
                stateAfterAcknowledgement,
                RbpSequenceFault.SequenceExhausted);
        }

        long expectedSequence =
            stateAfterAcknowledgement.LastRxSequence + 1;
        if (incoming.Sequence != expectedSequence)
        {
            return new RbpInboundDataResult(
                RbpInboundDataKind.Gap,
                stateAfterAcknowledgement,
                stateAfterAcknowledgement.LastRxSequence,
                ExpectedSequence: expectedSequence,
                ReceivedSequence: incoming.Sequence);
        }

        RbpSequenceState nextState = stateAfterAcknowledgement with
        {
            LastRxSequence = incoming.Sequence,
            AcceptedInbound = Append(
                stateAfterAcknowledgement.AcceptedInbound,
                new RbpAcceptedInboundData(incoming.Sequence, digest)),
        };
        return new RbpInboundDataResult(
            RbpInboundDataKind.Accepted,
            nextState,
            incoming.Sequence);
    }

    internal static IReadOnlyList<RbpDataEnvelopeSnapshot> RetransmitOutbox(
        RbpSequenceState state,
        long? acknowledgement = null,
        string? timestamp = null)
    {
        ArgumentNullException.ThrowIfNull(state);
        if (acknowledgement is { } ack)
        {
            RequireSafeSequence(
                ack,
                allowZero: true,
                nameof(acknowledgement));
            if (ack > state.LastRxSequence)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(acknowledgement),
                    "Retransmission acknowledgement cannot exceed " +
                    "LastRxSequence.");
            }
        }

        return Freeze(
            state.Outbox
                .OrderBy(entry => entry.Envelope.Sequence)
                .Select(
                    entry => entry.Envelope.Snapshot(
                        acknowledgement,
                        replaceAcknowledgement: acknowledgement.HasValue,
                        timestamp,
                        replaceTimestamp: timestamp is not null)));
    }

    internal static RbpSequenceRenewalStatus RenewalStatus(
        RbpSequenceState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        if (state.NextTxSequence is not null)
        {
            return RbpSequenceRenewalStatus.NotRequired;
        }

        return state.Outbox.Count == 0
            ? RbpSequenceRenewalStatus.ReadyForNewRsid
            : RbpSequenceRenewalStatus.DrainRequired;
    }

    internal static RbpDispatchWindowLedger CreateDispatchWindowLedger()
    {
        return new RbpDispatchWindowLedger(
            Empty<RbpDispatchWindowEntry>());
    }

    internal static RbpOpenDispatchWindowResult OpenDispatchWindow(
        RbpDispatchWindowLedger ledger,
        RbpDispatchWindowEntry entry)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(entry);
        RequireNonEmpty(entry.Rsid, nameof(entry.Rsid));
        RequireNonEmpty(entry.InvocationId, nameof(entry.InvocationId));
        RbpDispatchWindowEntry? active = ledger.Active.FirstOrDefault(
            candidate => string.Equals(
                candidate.Rsid,
                entry.Rsid,
                StringComparison.Ordinal));
        if (active is not null)
        {
            return new RbpOpenDispatchWindowResult(
                RbpOpenDispatchWindowKind.ProtocolFault,
                ledger,
                active);
        }

        return new RbpOpenDispatchWindowResult(
            RbpOpenDispatchWindowKind.Opened,
            new RbpDispatchWindowLedger(Append(ledger.Active, entry)));
    }

    internal static RbpDispatchWindowLedger CloseDispatchWindow(
        RbpDispatchWindowLedger ledger,
        string rsid,
        string invocationId)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        RequireNonEmpty(rsid, nameof(rsid));
        RequireNonEmpty(invocationId, nameof(invocationId));
        RbpDispatchWindowEntry? active = ledger.Active.FirstOrDefault(
            candidate => string.Equals(
                candidate.Rsid,
                rsid,
                StringComparison.Ordinal));
        if (active is null)
        {
            throw new InvalidOperationException(
                $"No active dispatch window exists for '{rsid}'.");
        }

        if (!string.Equals(
                active.InvocationId,
                invocationId,
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"Dispatch window for '{rsid}' belongs to " +
                $"'{active.InvocationId}'.");
        }

        return new RbpDispatchWindowLedger(
            Freeze(
                ledger.Active.Where(
                    candidate => !string.Equals(
                        candidate.Rsid,
                        rsid,
                        StringComparison.Ordinal))));
    }

    private static RbpAcknowledgementResult FaultedAcknowledgement(
        RbpSequenceState state,
        RbpSequenceFault fault)
    {
        return new RbpAcknowledgementResult(
            RbpAcknowledgementKind.ProtocolFault,
            state,
            Empty<long>(),
            fault);
    }

    private static RbpInboundDataResult FaultedInbound(
        RbpSequenceState state,
        RbpSequenceFault fault)
    {
        return new RbpInboundDataResult(
            RbpInboundDataKind.ProtocolFault,
            state,
            state.LastRxSequence,
            fault);
    }

    private static bool IsSafeSequence(long value, bool allowZero)
    {
        return value >= (allowZero ? 0 : 1) &&
               value <= MaximumSafeSequence;
    }

    private static void RequireSafeSequence(
        long value,
        bool allowZero,
        string parameterName)
    {
        if (!IsSafeSequence(value, allowZero))
        {
            throw new ArgumentOutOfRangeException(
                parameterName,
                value,
                "Sequence value is outside the JSON-safe integer range.");
        }
    }

    private static void RequireNonEmpty(string value, string parameterName)
    {
        if (string.IsNullOrEmpty(value))
        {
            throw new ArgumentException(
                "Value must not be empty.",
                parameterName);
        }
    }

    private static IReadOnlyList<T> Append<T>(
        IReadOnlyList<T> source,
        T value)
    {
        var values = new T[source.Count + 1];
        for (int index = 0; index < source.Count; index++)
        {
            values[index] = source[index];
        }

        values[^1] = value;
        return Array.AsReadOnly(values);
    }

    private static IReadOnlyList<T> Empty<T>()
    {
        return Array.AsReadOnly(Array.Empty<T>());
    }

    private static IReadOnlyList<T> Freeze<T>(IEnumerable<T> source)
    {
        return new ReadOnlyCollection<T>(source.ToArray());
    }
}
