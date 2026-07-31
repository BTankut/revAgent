using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// One probed Appendix A.2 batch command descriptor as the add-in advertised
/// it (spec ~1687-1698).
/// </summary>
/// <remarks>
/// <c>resultDelivery</c> and <c>maxInlineResultBytes</c> are the add-in's
/// pre-dispatch attestation that the command never needs a Section 13
/// chunk/artifact carrier and that its canonical result stays inline. The
/// bridge tests that attestation rather than assuming it, because a batch step
/// has no reachable spool carrier (spec ~912-915, ~999-1006).
/// </remarks>
internal sealed record RbpBatchCommandDescriptor(
    string Method,
    string Effect,
    string ResultDelivery,
    long MaximumInlineResultBytes)
{
    internal const string InlineOnly = "inline_only";

    internal bool IsInlineOnly =>
        string.Equals(ResultDelivery, InlineOnly, StringComparison.Ordinal);
}

/// <summary>
/// What one <c>rsid</c> is actually allowed to do with <c>invoke_batch</c>.
/// </summary>
/// <remarks>
/// Section 6.1 makes <c>batch_atomic</c> a per-session grant and states that
/// dispatch MUST test that per-<c>rsid</c> grant rather than a connection-wide
/// version string, so the grant and the probed descriptor set are two separate
/// facts here: an add-in may advertise the descriptor contract that
/// <c>atomic:false</c> fan-out needs while the Gateway has not granted
/// <c>batch_atomic</c> to this session (spec ~344-352, ~588-591, ~904-905).
/// </remarks>
internal sealed record RbpBatchCapability(
    bool BatchAtomicGranted,
    IReadOnlyDictionary<string, RbpBatchCommandDescriptor> Descriptors,
    long MaximumAggregateResultBytes)
{
    internal const string BatchAtomicCapability = "batch_atomic";

    internal RbpBatchCommandDescriptor? Descriptor(string method) =>
        Descriptors.TryGetValue(method, out RbpBatchCommandDescriptor? found)
            ? found
            : null;
}

/// <summary>
/// Resolves the per-<c>rsid</c> batch grant and probed descriptor set.
/// </summary>
internal interface IRbpBatchCapabilitySource
{
    Task<RbpBatchCapability> ResolveAsync(
        string rsid,
        CancellationToken cancellationToken);
}

/// <summary>
/// The production seam: the grant comes from the durable
/// <c>granted_session_capabilities</c> of that <c>rsid</c>, and the descriptor
/// set comes from the most recent successful add-in loopback status probe for
/// the routed local session.
/// </summary>
/// <remarks>
/// Neither fact is inferred from the other. A session with no routable add-in,
/// or an add-in that advertises no <c>batch_atomic</c> capability contract, has
/// an empty descriptor set, so every batch step fails the frozen
/// <c>inline_only</c> gate and no step is dispatched. That is deliberately
/// fail-closed: spec ~912-915 requires descriptor-set membership for every
/// step, including an <c>atomic:false</c> fan-out step.
/// </remarks>
internal sealed class RbpRoutedBatchCapabilitySource(
    RbpJournalStore journal,
    AddinSessionRouter router,
    IRbpSessionRouteResolver routes,
    int negotiatedMaximumResultBytes)
    : IRbpBatchCapabilitySource
{
    private readonly RbpJournalStore _journal =
        journal ?? throw new ArgumentNullException(nameof(journal));

    private readonly AddinSessionRouter _router =
        router ?? throw new ArgumentNullException(nameof(router));

    private readonly IRbpSessionRouteResolver _routes =
        routes ?? throw new ArgumentNullException(nameof(routes));

    public async Task<RbpBatchCapability> ResolveAsync(
        string rsid,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);

        RbpStoredSession? session = await _journal
            .GetStoredSessionAsync(rsid, cancellationToken)
            .ConfigureAwait(false);
        bool granted =
            session is not null &&
            session.GrantedCapabilities.Contains(
                RbpBatchCapability.BatchAtomicCapability,
                StringComparer.Ordinal);

        return new RbpBatchCapability(
            granted,
            ReadDescriptors(rsid),
            negotiatedMaximumResultBytes);
    }

    private IReadOnlyDictionary<string, RbpBatchCommandDescriptor>
        ReadDescriptors(string rsid)
    {
        var descriptors =
            new Dictionary<string, RbpBatchCommandDescriptor>(
                StringComparer.Ordinal);
        if (_routes.Resolve(rsid) is not { } handle)
        {
            return descriptors;
        }

        foreach (AddinSessionRouter.SessionRoute route in
                 _router.GetAvailableSessions())
        {
            if (!string.Equals(
                    route.Handle.LocalSessionKey,
                    handle.LocalSessionKey,
                    StringComparison.Ordinal))
            {
                continue;
            }

            AddinBatchAtomicCapability? contract =
                route.Session.Status.BatchAtomic;
            if (contract is null)
            {
                break;
            }

            foreach (AddinBatchableCommand command in
                     contract.BatchableCommands)
            {
                // Spec ~1697-1699: one unique descriptor per method. A
                // duplicate method makes the advertised set ambiguous, and an
                // ambiguous attestation is not an attestation.
                if (!descriptors.TryAdd(
                        command.Method,
                        new RbpBatchCommandDescriptor(
                            command.Method,
                            command.Effect,
                            command.ResultDelivery,
                            command.MaxInlineResultBytes)))
                {
                    return new Dictionary<
                        string,
                        RbpBatchCommandDescriptor>(StringComparer.Ordinal);
                }
            }

            break;
        }

        return descriptors;
    }
}
