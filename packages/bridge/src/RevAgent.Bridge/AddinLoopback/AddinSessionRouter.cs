using System.Collections.ObjectModel;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevAgent.Bridge.AddinLoopback;

internal sealed class AddinSessionRouter
{
    private readonly object _sync = new();
    private readonly IAddinTransport _transport;
    private readonly List<SessionSlot> _slots = new();
    private long _latestIssuedRefreshGeneration;
    private long _lastAppliedRefreshGeneration;

    internal AddinSessionRouter(IAddinTransport transport)
    {
        _transport = transport ?? throw new ArgumentNullException(nameof(transport));
    }

    internal enum LifecycleChangeKind
    {
        Added,
        Unavailable,
        Reappeared,
        Replaced,
    }

    internal enum RouteFailureKind
    {
        InvalidHandle,
        StaleHandle,
        Unavailable,
        InvocationInFlight,
    }

    internal sealed class SessionHandle
    {
        internal SessionHandle(
            AddinSessionRouter owner,
            object slotAuthority,
            string localSessionKey,
            long generation)
        {
            Owner = owner;
            SlotAuthority = slotAuthority;
            LocalSessionKey = localSessionKey;
            Generation = generation;
        }

        internal AddinSessionRouter Owner { get; }

        internal object SlotAuthority { get; }

        internal string LocalSessionKey { get; }

        internal long Generation { get; }
    }

    internal sealed class RefreshTicket
    {
        internal RefreshTicket(
            AddinSessionRouter owner,
            long generation)
        {
            Owner = owner;
            Generation = generation;
        }

        internal AddinSessionRouter Owner { get; }

        internal long Generation { get; }
    }

    internal sealed class InvocationLease
    {
        private SessionSlot? _slot;

        internal InvocationLease(
            SessionSlot slot,
            AddinCallResult? result,
            Exception? failure)
        {
            if ((result == null) == (failure == null))
            {
                throw new ArgumentException(
                    "An invocation lease requires exactly one transport outcome.");
            }

            _slot = slot;
            Result = result;
            Failure = failure;
        }

        internal AddinCallResult? Result { get; }

        internal Exception? Failure { get; }

        internal bool IsReleased => Volatile.Read(ref _slot) == null;

        internal AddinCallResult GetResult()
        {
            if (Failure != null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo
                    .Capture(Failure)
                    .Throw();
            }

            return Result ??
                throw new InvalidOperationException(
                    "The invocation lease has no transport result.");
        }

        // Intentionally not IDisposable: abandoning a call or leaving a
        // scope must keep this session fail-closed. The journal owner releases
        // only after persisting a terminal or indeterminate decision.
        internal void ReleaseAfterDurableDecision()
        {
            SessionSlot? slot = Interlocked.Exchange(ref _slot, null);
            slot?.InvocationGate.Release();
        }
    }

    internal sealed record SessionRoute(
        SessionHandle Handle,
        ProbedAddinSession Session);

    internal sealed record LifecycleChange(
        LifecycleChangeKind Kind,
        SessionRoute? Previous,
        SessionRoute? Current);

    internal sealed record ReconciliationResult(
        long RefreshGeneration,
        IReadOnlyList<SessionRoute> AvailableSessions,
        IReadOnlyList<LifecycleChange> Changes);

    internal sealed class SnapshotException : Exception
    {
        internal SnapshotException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        internal string Code { get; }
    }

    internal sealed class RouteException : Exception
    {
        private RouteException(
            RouteFailureKind kind,
            string code,
            string message)
            : base(message)
        {
            Kind = kind;
            Code = code;
            Evidence = NotStartedEvidence();
        }

        internal RouteFailureKind Kind { get; }

        internal string Code { get; }

        internal AddinTransportEvidence Evidence { get; }

        internal bool IsTerminalProtocolFault =>
            Kind == RouteFailureKind.InvocationInFlight;

        internal string? FaultClass =>
            IsTerminalProtocolFault ? "protocol" : null;

        internal bool? Retryable =>
            IsTerminalProtocolFault ? false : null;

        internal string? Outcome =>
            IsTerminalProtocolFault ? "known" : null;

        internal bool? VerificationRequired =>
            IsTerminalProtocolFault ? false : null;

        internal static RouteException InvalidHandle() =>
            new(
                RouteFailureKind.InvalidHandle,
                "invalid_addin_session_handle",
                "The add-in session handle was not issued by this router.");

        internal static RouteException StaleHandle() =>
            new(
                RouteFailureKind.StaleHandle,
                "stale_addin_session_handle",
                "The add-in session handle is stale.");

        internal static RouteException Unavailable() =>
            new(
                RouteFailureKind.Unavailable,
                "addin_session_unavailable",
                "The local add-in session is unavailable.");

        internal static RouteException InvocationInFlight() =>
            new(
                RouteFailureKind.InvocationInFlight,
                "same_session_invocation_inflight",
                "A data-plane invocation is already active for this add-in session.");
    }

    internal RefreshTicket BeginRefresh()
    {
        lock (_sync)
        {
            if (_latestIssuedRefreshGeneration == long.MaxValue)
            {
                throw InvalidSnapshot(
                    "addin_session_refresh_generation_exhausted",
                    "The add-in discovery refresh generation cannot advance.");
            }

            _latestIssuedRefreshGeneration++;
            return new RefreshTicket(
                this,
                _latestIssuedRefreshGeneration);
        }
    }

    internal ReconciliationResult Reconcile(
        RefreshTicket refreshTicket,
        AddinDiscoveryResult completeSnapshot)
    {
        ArgumentNullException.ThrowIfNull(refreshTicket);
        ArgumentNullException.ThrowIfNull(completeSnapshot);
        lock (_sync)
        {
            RequireCurrentRefresh(refreshTicket);
        }

        List<IncomingSession> incoming = ValidateAndOrder(completeSnapshot);

        lock (_sync)
        {
            RequireCurrentRefresh(refreshTicket);
            List<Assignment> assignments =
                BuildAssignments(incoming);
            var assignedSlots = assignments
                .Where(assignment => assignment.Slot != null)
                .Select(assignment => assignment.Slot!)
                .ToHashSet();

            List<SessionSlot> unavailableSlots = _slots
                .Where(slot =>
                    slot.IsAvailable &&
                    !assignedSlots.Contains(slot))
                .ToList();

            ThrowIfGenerationWouldOverflow(assignments);

            var changes = new List<LifecycleChange>();
            foreach (Assignment assignment in assignments)
            {
                ApplyAssignment(assignment, changes);
            }

            foreach (SessionSlot slot in unavailableSlots)
            {
                SessionRoute previous = slot.CurrentRoute;
                slot.AdvanceToUnavailable();
                changes.Add(
                    new LifecycleChange(
                        LifecycleChangeKind.Unavailable,
                        previous,
                        Current: null));
            }

            IReadOnlyList<SessionRoute> availableSessions =
                SnapshotAvailableRoutes();
            IReadOnlyList<LifecycleChange> orderedChanges =
                SortChanges(changes);
            _lastAppliedRefreshGeneration = refreshTicket.Generation;
            return new ReconciliationResult(
                refreshTicket.Generation,
                availableSessions,
                orderedChanges);
        }
    }

    internal IReadOnlyList<SessionRoute> GetAvailableSessions()
    {
        lock (_sync)
        {
            return SnapshotAvailableRoutes();
        }
    }

    internal Task<InvocationLease> InvokeAsync(
        SessionHandle handle,
        AddinCall call,
        CancellationToken preDispatchCancellationToken = default,
        CancellationToken transportShutdownToken = default)
    {
        ArgumentNullException.ThrowIfNull(handle);
        ArgumentNullException.ThrowIfNull(call);

        SessionSlot slot;
        AddinEndpoint endpoint;
        AddinProcessAttestation expectedProcessAttestation;
        int probedMaxRequestPayloadBytes;
        lock (_sync)
        {
            if (!ReferenceEquals(handle.Owner, this) ||
                handle.SlotAuthority is not SessionSlot ownedSlot ||
                !_slots.Contains(ownedSlot))
            {
                return Task.FromException<InvocationLease>(
                    RouteException.InvalidHandle());
            }

            slot = ownedSlot;
            if (handle.Generation != slot.Generation ||
                !ReferenceEquals(handle, slot.CurrentHandle))
            {
                return Task.FromException<InvocationLease>(
                    RouteException.StaleHandle());
            }

            if (!slot.IsAvailable)
            {
                return Task.FromException<InvocationLease>(
                    RouteException.Unavailable());
            }

            if (!slot.InvocationGate.Wait(0))
            {
                return Task.FromException<InvocationLease>(
                    RouteException.InvocationInFlight());
            }

            endpoint = slot.Session.Target;
            expectedProcessAttestation =
                slot.Session.ProcessAttestation;
            probedMaxRequestPayloadBytes =
                slot.Session.Status.Service.Framing.MaxRequestPayloadBytes;
        }

        return InvokeWithLeaseAsync(
            slot,
            endpoint,
            expectedProcessAttestation,
            call,
            probedMaxRequestPayloadBytes,
            preDispatchCancellationToken,
            transportShutdownToken);
    }

    private async Task<InvocationLease> InvokeWithLeaseAsync(
        SessionSlot slot,
        AddinEndpoint endpoint,
        AddinProcessAttestation expectedProcessAttestation,
        AddinCall call,
        int probedMaxRequestPayloadBytes,
        CancellationToken preDispatchCancellationToken,
        CancellationToken transportShutdownToken)
    {
        try
        {
            AddinCall boundedCall =
                call.MaxRequestPayloadBytes <= probedMaxRequestPayloadBytes
                    ? call
                    : new AddinCall(
                        call.InvocationId,
                        call.Method,
                        call.CopyParameters(),
                        call.Timeout,
                        probedMaxRequestPayloadBytes);
            AddinCallResult result = await _transport.InvokeAsync(
                endpoint,
                boundedCall,
                preDispatchCancellationToken,
                transportShutdownToken,
                new ExpectedAddinProcessAttestor(
                    new WindowsAddinProcessAttestor(),
                    expectedProcessAttestation)).ConfigureAwait(false);
            return new InvocationLease(slot, result, failure: null);
        }
        catch (Exception exception)
        {
            return new InvocationLease(
                slot,
                result: null,
                failure: exception);
        }
    }

    private void RequireCurrentRefresh(RefreshTicket refreshTicket)
    {
        if (!ReferenceEquals(refreshTicket.Owner, this))
        {
            throw InvalidSnapshot(
                "invalid_addin_session_refresh_ticket",
                "The discovery refresh ticket belongs to another router.");
        }

        if (refreshTicket.Generation != _latestIssuedRefreshGeneration ||
            refreshTicket.Generation <= _lastAppliedRefreshGeneration)
        {
            throw InvalidSnapshot(
                "stale_addin_session_snapshot",
                "A newer add-in discovery refresh superseded this snapshot.");
        }
    }

    private static List<IncomingSession> ValidateAndOrder(
        AddinDiscoveryResult completeSnapshot)
    {
        if (completeSnapshot.Sessions == null ||
            completeSnapshot.Evidence == null)
        {
            throw InvalidSnapshot(
                "addin_session_snapshot_invalid",
                "The discovery snapshot is incomplete.");
        }

        ValidateSnapshotPartition(completeSnapshot);

        var localSessionKeys = new HashSet<string>(StringComparer.Ordinal);
        var processIds = new HashSet<long>();
        var endpoints = new HashSet<AddinEndpoint>();
        var incoming = new List<IncomingSession>(
            completeSnapshot.Sessions.Count);

        foreach (ProbedAddinSession? session in completeSnapshot.Sessions)
        {
            if (session == null ||
                session.Target == null ||
                session.Status == null ||
                session.ProcessAttestation == null)
            {
                throw InvalidSnapshot(
                    "addin_session_snapshot_invalid",
                    "The discovery snapshot contains an incomplete session.");
            }

            AddinProcessAttestation attestation =
                session.ProcessAttestation;
            if (attestation.Identity.ProcessId !=
                    session.Status.Revit.ProcessId ||
                attestation.Identity.StartTimeFileTimeUtc <= 0 ||
                !string.Equals(
                    attestation.RevitVersion,
                    session.Status.Revit.Version,
                    StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(attestation.ImagePath) ||
                !string.Equals(
                    session.LocalSessionKey,
                    attestation.Identity.CreateLocalSessionKey(
                        session.Target),
                    StringComparison.Ordinal))
            {
                throw InvalidSnapshot(
                    "addin_process_attestation_invalid",
                    "The discovery snapshot process attestation is inconsistent.");
            }

            if (string.IsNullOrWhiteSpace(session.LocalSessionKey) ||
                session.LocalSessionKey.Length > 256)
            {
                throw InvalidSnapshot(
                    "invalid_local_session_key",
                    "The attested local session key is missing or unbounded.");
            }

            if (!localSessionKeys.Add(session.LocalSessionKey))
            {
                throw InvalidSnapshot(
                    "duplicate_local_session_key",
                    "The discovery snapshot repeats a local session key.");
            }

            if (!processIds.Add(session.Status.Revit.ProcessId))
            {
                throw InvalidSnapshot(
                    "duplicate_revit_process_identity",
                    "The discovery snapshot repeats a Revit process identity.");
            }

            if (!endpoints.Add(session.Target))
            {
                throw InvalidSnapshot(
                    "duplicate_addin_endpoint",
                    "The discovery snapshot repeats an add-in endpoint.");
            }

            incoming.Add(
                new IncomingSession(
                    session,
                    RegistrationSignature(session)));
        }

        return incoming
            .OrderBy(candidate => candidate.Session.Target.Port)
            .ThenBy(candidate => candidate.Session.Status.Revit.ProcessId)
            .ThenBy(
                candidate => candidate.Session.LocalSessionKey,
                StringComparer.Ordinal)
            .ToList();
    }

    private static void ValidateSnapshotPartition(
        AddinDiscoveryResult completeSnapshot)
    {
        AddinDiscoveryEvidence evidence = completeSnapshot.Evidence;
        if (evidence.ProbedTargets == null ||
            evidence.AcceptedTargets == null ||
            evidence.RejectedTargets == null)
        {
            throw InvalidSnapshot(
                "addin_session_snapshot_partition_invalid",
                "The discovery evidence partition is incomplete.");
        }

        HashSet<AddinEndpoint> probed = RequireDistinctTargets(
            evidence.ProbedTargets,
            "probed");
        HashSet<AddinEndpoint> accepted = RequireDistinctTargets(
            evidence.AcceptedTargets,
            "accepted");
        var rejected = new HashSet<AddinEndpoint>();
        bool duplicateProcessIdentity = false;
        foreach (AddinDiscoveryRejection? rejection in
                 evidence.RejectedTargets)
        {
            if (rejection == null ||
                rejection.Target == null ||
                !rejected.Add(rejection.Target))
            {
                throw InvalidSnapshot(
                    "addin_session_snapshot_partition_invalid",
                    "The discovery evidence repeats or omits a rejected target.");
            }

            duplicateProcessIdentity |=
                rejection.Kind ==
                AddinDiscoveryFailureKind.DuplicateProcessIdentity;
        }

        if (accepted.Overlaps(rejected))
        {
            throw InvalidSnapshot(
                "addin_session_snapshot_partition_invalid",
                "A discovery target cannot be both accepted and rejected.");
        }

        var accounted = new HashSet<AddinEndpoint>(accepted);
        accounted.UnionWith(rejected);
        if (!accounted.SetEquals(probed))
        {
            throw InvalidSnapshot(
                "addin_session_snapshot_partition_invalid",
                "Every probed target must have exactly one discovery outcome.");
        }

        var sessionTargets = new HashSet<AddinEndpoint>();
        foreach (ProbedAddinSession? session in completeSnapshot.Sessions)
        {
            if (session == null ||
                session.Target == null ||
                !sessionTargets.Add(session.Target))
            {
                throw InvalidSnapshot(
                    "addin_session_snapshot_partition_invalid",
                    "Accepted session targets must be complete and distinct.");
            }
        }

        if (!sessionTargets.SetEquals(accepted))
        {
            throw InvalidSnapshot(
                "addin_session_snapshot_partition_invalid",
                "Accepted evidence must match the routed session targets.");
        }

        ValidateProbedTargetSet(evidence.Source, probed);
        if (duplicateProcessIdentity)
        {
            throw InvalidSnapshot(
                "duplicate_revit_process_identity",
                "The discovery snapshot contains ambiguous process identity evidence.");
        }
    }

    private static HashSet<AddinEndpoint> RequireDistinctTargets(
        IReadOnlyList<AddinEndpoint> targets,
        string partitionName)
    {
        var values = new HashSet<AddinEndpoint>();
        foreach (AddinEndpoint? target in targets)
        {
            if (target == null || !values.Add(target))
            {
                throw InvalidSnapshot(
                    "addin_session_snapshot_partition_invalid",
                    "The discovery " + partitionName +
                    " target partition is invalid.");
            }
        }

        return values;
    }

    private static void ValidateProbedTargetSet(
        AddinDiscoverySource source,
        HashSet<AddinEndpoint> probed)
    {
        if (source == AddinDiscoverySource.ExplicitEnvironmentOverride)
        {
            if (probed.Count != 1)
            {
                throw InvalidSnapshot(
                    "addin_session_snapshot_partition_invalid",
                    "An explicit discovery refresh must probe one target.");
            }

            return;
        }

        if (source != AddinDiscoverySource.BoundedScan)
        {
            throw InvalidSnapshot(
                "addin_session_snapshot_partition_invalid",
                "The discovery source is not recognized.");
        }

        var expected = new HashSet<AddinEndpoint>(
            Enumerable
                .Range(
                    AddinDiscovery.ScanStartPort,
                    AddinDiscovery.ScanEndPort -
                    AddinDiscovery.ScanStartPort +
                    1)
                .Select(port =>
                    AddinEndpoint.Create(
                        AddinDiscovery.ScanAddress,
                        port)));
        if (!probed.SetEquals(expected))
        {
            throw InvalidSnapshot(
                "addin_session_snapshot_partition_invalid",
                "A bounded discovery refresh must cover the frozen port range.");
        }
    }

    private List<Assignment> BuildAssignments(
        IReadOnlyList<IncomingSession> incoming)
    {
        var matches = incoming
            .Select(candidate =>
                new SlotMatch(
                    candidate,
                    _slots
                        .Where(slot =>
                            string.Equals(
                                slot.Session.LocalSessionKey,
                                candidate.Session.LocalSessionKey,
                                StringComparison.Ordinal) ||
                            slot.Session.Target.Equals(
                                candidate.Session.Target) ||
                            slot.Session.Status.Revit.ProcessId ==
                            candidate.Session.Status.Revit.ProcessId)
                        .Distinct()
                        .ToList()))
            .ToList();

        if (matches.Any(match => match.Candidates.Count > 1))
        {
            throw InvalidSnapshot(
                "ambiguous_addin_session_replacement",
                "A discovered process resolves to more than one stable slot.");
        }

        bool multipleIncomingForOneSlot = matches
            .Where(match => match.Candidates.Count == 1)
            .GroupBy(match => match.Candidates[0])
            .Any(group => group.Count() > 1);
        if (multipleIncomingForOneSlot)
        {
            throw InvalidSnapshot(
                "ambiguous_addin_session_replacement",
                "More than one discovered process resolves to the same stable slot.");
        }

        var assignments = new List<Assignment>(matches.Count);
        foreach (SlotMatch match in matches)
        {
            SessionSlot? slot = match.Candidates.Count == 1
                ? match.Candidates[0]
                : null;
            LifecycleChangeKind? changeKind;
            if (slot == null)
            {
                changeKind = LifecycleChangeKind.Added;
            }
            else if (string.Equals(
                         slot.RegistrationSignature,
                         match.Incoming.RegistrationSignature,
                         StringComparison.Ordinal))
            {
                changeKind = slot.IsAvailable
                    ? null
                    : LifecycleChangeKind.Reappeared;
            }
            else
            {
                changeKind = LifecycleChangeKind.Replaced;
            }

            assignments.Add(
                new Assignment(
                    match.Incoming,
                    slot,
                    changeKind));
        }

        return assignments;
    }

    private static void ThrowIfGenerationWouldOverflow(
        IEnumerable<Assignment> assignments)
    {
        bool assignmentOverflow = assignments.Any(assignment =>
            assignment.Slot != null &&
            assignment.ChangeKind != null &&
            assignment.Slot.Generation == long.MaxValue);
        if (assignmentOverflow)
        {
            throw InvalidSnapshot(
                "addin_session_generation_exhausted",
                "The local add-in session generation cannot advance.");
        }
    }

    private void ApplyAssignment(
        Assignment assignment,
        List<LifecycleChange> changes)
    {
        IncomingSession incoming = assignment.Incoming;
        if (assignment.Slot == null)
        {
            var added = new SessionSlot(
                this,
                incoming.Session,
                incoming.RegistrationSignature);
            _slots.Add(added);
            changes.Add(
                new LifecycleChange(
                    LifecycleChangeKind.Added,
                    Previous: null,
                    added.CurrentRoute));
            return;
        }

        SessionSlot slot = assignment.Slot;
        SessionRoute previous = slot.CurrentRoute;
        if (assignment.ChangeKind == null)
        {
            slot.Refresh(
                incoming.Session,
                incoming.RegistrationSignature);
            return;
        }

        slot.AdvanceToAvailable(
            this,
            incoming.Session,
            incoming.RegistrationSignature);
        changes.Add(
            new LifecycleChange(
                assignment.ChangeKind.Value,
                previous,
                slot.CurrentRoute));
    }

    private IReadOnlyList<SessionRoute> SnapshotAvailableRoutes()
    {
        return new ReadOnlyCollection<SessionRoute>(
            _slots
                .Where(slot => slot.IsAvailable)
                .Select(slot => slot.CurrentRoute)
                .OrderBy(route => route.Session.Target.Port)
                .ThenBy(route => route.Session.Status.Revit.ProcessId)
                .ThenBy(
                    route => route.Session.LocalSessionKey,
                    StringComparer.Ordinal)
                .ToList());
    }

    private static IReadOnlyList<LifecycleChange> SortChanges(
        IEnumerable<LifecycleChange> changes)
    {
        return new ReadOnlyCollection<LifecycleChange>(
            changes
                .OrderBy(change =>
                    (change.Current ?? change.Previous)!.Session.Target.Port)
                .ThenBy(change =>
                    (change.Current ?? change.Previous)!
                    .Session.Status.Revit.ProcessId)
                .ThenBy(
                    change =>
                        (change.Current ?? change.Previous)!
                        .Session.LocalSessionKey,
                    StringComparer.Ordinal)
                .ThenBy(change => change.Kind)
                .ToList());
    }

    private static string RegistrationSignature(ProbedAddinSession session)
    {
        var status = session.Status;
        var signature = new JObject
        {
            ["localSessionKey"] = session.LocalSessionKey,
            ["targetAddress"] = session.Target.Address.ToString(),
            ["targetPort"] = session.Target.Port,
            ["addinVersion"] = status.AddinVersion,
            ["resultContractVersion"] = status.ResultContractVersion,
            ["addinLoopbackContractVersion"] =
                status.AddinLoopbackContractVersion,
            ["revit"] = new JObject
            {
                ["version"] = status.Revit.Version,
                ["build"] = status.Revit.Build,
                ["processId"] = status.Revit.ProcessId,
            },
            ["service"] = new JObject
            {
                ["port"] = status.Service.Port,
                ["binding"] = status.Service.Binding,
                ["boundAddresses"] =
                    new JArray(
                        status.Service.BoundAddresses.OrderBy(
                            address => address,
                            StringComparer.Ordinal)),
                ["framing"] = new JObject
                {
                    ["protocol"] = status.Service.Framing.Protocol,
                    ["headerBytes"] = status.Service.Framing.HeaderBytes,
                    ["byteOrder"] = status.Service.Framing.ByteOrder,
                    ["payloadEncoding"] =
                        status.Service.Framing.PayloadEncoding,
                    ["maxRequestPayloadBytes"] =
                        status.Service.Framing.MaxRequestPayloadBytes,
                    ["maxResponsePayloadBytes"] =
                        status.Service.Framing.MaxResponsePayloadBytes,
                },
            },
            ["sessionCapabilities"] =
                new JArray(
                    status.SessionCapabilities.OrderBy(
                        capability => capability,
                        StringComparer.Ordinal)),
            ["batchAtomic"] = BatchAtomicSignature(status),
            ["documentContextCached"] =
                DocumentContextSignature(status),
        };

        return signature.ToString(Formatting.None);
    }

    private static JToken BatchAtomicSignature(
        RevAgent.Contracts.AddinLoopback.AddinStatusSnapshot status)
    {
        if (status.BatchAtomic == null)
        {
            return JValue.CreateNull();
        }

        return new JObject
        {
            ["contractVersion"] = status.BatchAtomic.ContractVersion,
            ["method"] = status.BatchAtomic.Method,
            ["maxSteps"] = status.BatchAtomic.MaxSteps,
            ["maxRequestPayloadBytes"] =
                status.BatchAtomic.MaxRequestPayloadBytes,
            ["maxResponsePayloadBytes"] =
                status.BatchAtomic.MaxResponsePayloadBytes,
            ["transactionBoundary"] =
                status.BatchAtomic.TransactionBoundary,
            ["rollbackPolicy"] = status.BatchAtomic.RollbackPolicy,
            ["batchableCommands"] = new JArray(
                status.BatchAtomic.BatchableCommands
                    .OrderBy(
                        command => command.Method,
                        StringComparer.Ordinal)
                    .ThenBy(
                        command => command.Effect,
                        StringComparer.Ordinal)
                    .ThenBy(
                        command => command.TransactionPolicy,
                        StringComparer.Ordinal)
                    .ThenBy(
                        command => command.RollbackDisposition,
                        StringComparer.Ordinal)
                    .ThenBy(
                        command => command.ParameterProfile,
                        StringComparer.Ordinal)
                    .Select(command =>
                        new JObject
                        {
                            ["method"] = command.Method,
                            ["effect"] = command.Effect,
                            ["transactionPolicy"] =
                                command.TransactionPolicy,
                            ["rollbackDisposition"] =
                                command.RollbackDisposition,
                            ["parameterProfile"] =
                                command.ParameterProfile,
                            ["resultDelivery"] = command.ResultDelivery,
                            ["maxInlineResultBytes"] =
                                command.MaxInlineResultBytes,
                        })),
        };
    }

    private static JToken DocumentContextSignature(
        RevAgent.Contracts.AddinLoopback.AddinStatusSnapshot status)
    {
        if (status.DocumentContextCached == null)
        {
            return JValue.CreateNull();
        }

        return new JObject
        {
            ["contractVersion"] =
                status.DocumentContextCached.ContractVersion,
            ["method"] = status.DocumentContextCached.Method,
            ["source"] = status.DocumentContextCached.Source,
            ["pollIntervalMs"] =
                status.DocumentContextCached.PollIntervalMs,
            ["uiThreadRoundTrip"] =
                status.DocumentContextCached.UiThreadRoundTrip,
        };
    }

    private static SnapshotException InvalidSnapshot(
        string code,
        string message) =>
        new(code, message);

    private static AddinTransportEvidence NotStartedEvidence() =>
        new(
            AddinDispatchState.NotStarted,
            RequestPayloadBytes: 0,
            RequestFrameBytes: 0,
            BytesWrittenLowerBound: 0,
            RequestFullyWritten: false,
            ResponseBytesObserved: 0);

    private sealed record IncomingSession(
        ProbedAddinSession Session,
        string RegistrationSignature);

    private sealed record Assignment(
        IncomingSession Incoming,
        SessionSlot? Slot,
        LifecycleChangeKind? ChangeKind);

    private sealed record SlotMatch(
        IncomingSession Incoming,
        IReadOnlyList<SessionSlot> Candidates);

    internal sealed class SessionSlot
    {
        internal SessionSlot(
            AddinSessionRouter owner,
            ProbedAddinSession session,
            string registrationSignature)
        {
            Session = session;
            RegistrationSignature = registrationSignature;
            Generation = 1;
            IsAvailable = true;
            InvocationGate = new SemaphoreSlim(1, 1);
            CurrentHandle = new SessionHandle(
                owner,
                this,
                session.LocalSessionKey,
                Generation);
        }

        internal ProbedAddinSession Session { get; private set; }

        internal string RegistrationSignature { get; private set; }

        internal long Generation { get; private set; }

        internal bool IsAvailable { get; private set; }

        internal SemaphoreSlim InvocationGate { get; }

        internal SessionHandle CurrentHandle { get; private set; }

        internal SessionRoute CurrentRoute =>
            new(CurrentHandle, Session);

        internal void Refresh(
            ProbedAddinSession session,
            string registrationSignature)
        {
            Session = session;
            RegistrationSignature = registrationSignature;
        }

        internal void AdvanceToAvailable(
            AddinSessionRouter owner,
            ProbedAddinSession session,
            string registrationSignature)
        {
            Generation++;
            Session = session;
            RegistrationSignature = registrationSignature;
            IsAvailable = true;
            CurrentHandle = new SessionHandle(
                owner,
                this,
                session.LocalSessionKey,
                Generation);
        }

        internal void AdvanceToUnavailable()
        {
            IsAvailable = false;
        }
    }
}
