using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

/// <summary>
/// The production P3-T5 inbound handoff: now that the Section 12 invocation
/// journal is installed, an accepted data envelope is bound to that journal's
/// durable receipt inside the same immediate transaction that compacts it.
/// </summary>
/// <remarks>
/// <para>
/// The compacted receipt row accepts only a bounded journal-record identifier
/// and a lowercase SHA-256 digest of that record (the P3-T4b compaction
/// contract in <c>packages/bridge/README.md</c>). The durable record this
/// handoff stands for is the immutable receipt itself: the correlation id is
/// the retained envelope id, and the record digest is the RFC 8785 immutable
/// envelope digest that <see cref="RbpJournalWriteContext.MarkInboundJournaled"/>
/// verifies against the retained row in the same transaction. Section 12
/// invocation rows are deliberately not reserved here — admission stays with
/// <see cref="RevAgent.Bridge.Gateway.Storage.RbpJournalStore.AdmitInvocationAsync"/>,
/// which owns the Section 12.2 redelivery arbitration for the <c>invoke</c>
/// this envelope may carry.
/// </para>
/// <para>
/// Both receipt values are derived deterministically from the envelope alone,
/// so a crash between the handoff commit and its acknowledgement replays
/// byte-identically through the exact-replay check in
/// <see cref="RbpJournalWriteContext.MarkInboundJournaled"/> during restart
/// recovery.
/// </para>
/// </remarks>
internal sealed class RbpInvocationJournalHandoff : IRbpInboundDataJournal
{
    internal static RbpInvocationJournalHandoff Instance { get; } = new();

    private RbpInvocationJournalHandoff()
    {
    }

    public RbpInboundJournalReceipt Journal(
        RbpJournalWriteContext context,
        RbpDataEnvelopeSnapshot envelope)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(envelope);
        return new RbpInboundJournalReceipt(
            envelope.Id,
            Rfc8785Json.ImmutableEnvelopeDigest(envelope));
    }
}
