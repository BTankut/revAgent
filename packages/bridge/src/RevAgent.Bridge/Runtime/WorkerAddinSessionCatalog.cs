using System.Collections.ObjectModel;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Enrollment;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Contracts.AddinLoopback;
using RevAgent.Contracts.Rbp;

namespace RevAgent.Bridge.Runtime;

/// <summary>
/// Learns the durable <c>rsid</c> to local-session binding for the sessions
/// the coordinator currently owns.
/// </summary>
/// <summary>
/// Capability-scoped, read-only pre-resume context acquisition.  It accepts
/// only an RBP session id; callers cannot select a handle, endpoint, process,
/// method, parameters, or timeout.
/// </summary>
internal interface IRbpFreshResumeProofContextReader
{
    Task<RbpFreshDocumentContext?> ReadAsync(
        string rsid,
        CancellationToken cancellationToken);
}

/// <summary>
/// The worker's production add-in surface: bounded loopback discovery
/// reconciled through <see cref="AddinSessionRouter"/>, projected into the
/// frozen <c>session_register</c> payloads the coordinator registers, plus the
/// <c>rsid</c> route authority the dispatch path and the document-context
/// watcher share.
/// </summary>
/// <remarks>
/// <para>
/// One type owns both roles on purpose. The catalog snapshot and the route
/// table are two views of the same reconciliation, so binding them together
/// makes it impossible for dispatch to reach a Revit session the registration
/// evidence never described.
/// </para>
/// <para>
/// Every projection is fail-closed per session: a probed session whose status
/// cannot produce a frozen-shape registration payload is dropped from the
/// snapshot rather than registered with a repaired payload, so one malformed
/// add-in can never take the whole connection down or register under invented
/// evidence.
/// </para>
/// </remarks>
internal sealed class WorkerAddinSessionCatalog :
    IRbpLocalSessionCatalog,
    IRbpSessionRouteResolver,
    IRbpFreshResumeProofContextReader,
    IRbpSessionRouteBindingAuthority
{
    private static readonly Regex CapabilityPattern = new(
        "^[a-z][a-z0-9_]{0,127}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    private static readonly Regex FingerprintPattern = new(
        "^sha256:[0-9a-f]{64}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    private readonly AddinDiscovery _discovery;
    private readonly AddinSessionRouter _router;
    private readonly ResolvedBridgeConfiguration _configuration;
    private readonly Func<IBridgeDeviceCredentialProvider> _credentials;
    private readonly Func<string, CancellationToken, Task<string?>>
        _localSessionKeyLookup;
    private readonly string _bridgeVersion;
    private readonly string _hostname;
    private readonly RbpCredentialClaimBinding? _credentialClaims;

    /// <summary>
    /// Receives the evidence of every discovery pass. Discovery computes an
    /// exact rejection code per probed port and previously discarded it, so a
    /// machine whose Revit was never registered produced no record of why.
    /// </summary>
    private readonly Action<AddinDiscoveryEvidence>? _onDiscovered;

    // A route is a handle, not a local-session key.  A key is merely the
    // durable registration identity; resolving it again after registration
    // used to leave a refresh window in which the route could select a stale
    // router generation.  Keep the current attested handle and every rsid
    // projection under one lock so a caller observes one complete snapshot.
    private readonly object _routeSync = new();

    private readonly Dictionary<string, AddinSessionRouter.SessionHandle>
        _handlesByLocalKey = new(StringComparer.Ordinal);
    private readonly Dictionary<string, bool> _documentContextCapabilityByLocalKey =
        new(StringComparer.Ordinal);

    private readonly Dictionary<string, BoundRoute> _routesByRsid =
        new(StringComparer.Ordinal);
    private readonly HashSet<string> _revokedRsidsInEpoch =
        new(StringComparer.Ordinal);
    private long _activeRouteEpoch;
    private long _highestRouteEpoch;

    internal WorkerAddinSessionCatalog(
        AddinDiscovery discovery,
        AddinSessionRouter router,
        ResolvedBridgeConfiguration configuration,
        Func<IBridgeDeviceCredentialProvider> credentials,
        Func<string, CancellationToken, Task<string?>> localSessionKeyLookup,
        string bridgeVersion,
        string? hostname = null,
        Action<AddinDiscoveryEvidence>? onDiscovered = null,
        RbpCredentialClaimBinding? credentialClaims = null)
    {
        _onDiscovered = onDiscovered;
        _discovery = discovery ??
            throw new ArgumentNullException(nameof(discovery));
        _router = router ?? throw new ArgumentNullException(nameof(router));
        _configuration = configuration ??
            throw new ArgumentNullException(nameof(configuration));
        _credentials = credentials ??
            throw new ArgumentNullException(nameof(credentials));
        _localSessionKeyLookup = localSessionKeyLookup ??
            throw new ArgumentNullException(nameof(localSessionKeyLookup));
        ArgumentException.ThrowIfNullOrWhiteSpace(bridgeVersion);
        _bridgeVersion = bridgeVersion;
        _hostname = string.IsNullOrWhiteSpace(hostname)
            ? Environment.MachineName
            : hostname;
        _credentialClaims = credentialClaims;
    }

    /// <summary>
    /// Runs one bounded discovery pass, reconciles it into the router, and
    /// projects the surviving routes into frozen registration snapshots.
    /// </summary>
    public async Task<IReadOnlyList<RbpLocalSessionSnapshot>> ReadAsync(
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        AddinSessionRouter.RefreshTicket ticket = _router.BeginRefresh();
        AddinDiscoveryResult discovered = await _discovery
            .DiscoverAsync(
                _configuration,
                probeTimeout: null,
                cancellationToken,
                cancellationToken)
            .ConfigureAwait(false);
        if (_onDiscovered is { } observer)
        {
            try
            {
                observer(discovered.Evidence);
            }
            catch (Exception)
            {
                // Observing discovery must never own the discovery outcome.
            }
        }

        AddinSessionRouter.ReconciliationResult reconciled =
            _router.Reconcile(ticket, discovered);

        string fingerprint = ReadMachineFingerprint();
        var snapshots = new List<RbpLocalSessionSnapshot>(
            reconciled.AvailableSessions.Count);
        var handles = new Dictionary<string, AddinSessionRouter.SessionHandle>(
            StringComparer.Ordinal);
        var documentContextCapabilities = new Dictionary<string, bool>(
            StringComparer.Ordinal);
        foreach (AddinSessionRouter.SessionRoute route in
                 reconciled.AvailableSessions)
        {
            if (TryProject(route.Session, fingerprint) is not { } snapshot)
            {
                continue;
            }

            handles[route.Session.LocalSessionKey] = route.Handle;
            documentContextCapabilities[route.Session.LocalSessionKey] =
                RbpDocContextWatcher.AdvertisesCachedDocumentContext(snapshot);
            snapshots.Add(snapshot);
        }

        ReplaceHandles(handles, documentContextCapabilities);
        return new ReadOnlyCollection<RbpLocalSessionSnapshot>(snapshots);
    }

    /// <inheritdoc />
    public AddinSessionRouter.SessionHandle? Resolve(string rsid)
    {
        if (string.IsNullOrEmpty(rsid))
        {
            return null;
        }

        lock (_routeSync)
        {
            if (_routesByRsid.TryGetValue(rsid, out BoundRoute? route) &&
                route.Epoch == _activeRouteEpoch &&
                _handlesByLocalKey.TryGetValue(
                    route.LocalSessionKey,
                    out AddinSessionRouter.SessionHandle? current) &&
                SameHandle(route.Handle, current))
            {
                return route.Handle;
            }

            // Never fall back from a formerly attested route to a key lookup.
            // A vanished/replaced handle fences this rsid until the lifecycle
            // registration path publishes a new authoritative route.
            _ = _routesByRsid.Remove(rsid);
        }

        // Unknown or superseded binding. Returning null is the fail-closed
        // answer: a resolver miss is pure lookup and can never construct a
        // dispatch route by consulting the durable journal in the background.
        return null;
    }

    /// <summary>
    /// Reads the sole capability-scoped pre-resume proof input without using
    /// route resolution or the routed invocation channel.  The durable
    /// rsid-to-local-key relation and the catalog's current attested handle
    /// are both re-read around the fixed, empty-parameter call.
    /// </summary>
    public async Task<RbpFreshDocumentContext?> ReadAsync(
        string rsid,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(rsid) || rsid.Length > 256) return null;

        try
        {
            string? localKey = await _localSessionKeyLookup(rsid, cancellationToken)
                .ConfigureAwait(false);
            if (string.IsNullOrEmpty(localKey) || localKey.Length > 512) return null;

            AddinSessionRouter.SessionHandle? handle;
            long epoch;
            lock (_routeSync)
            {
                // A pre-resume route is authority corruption, not an
                // alternate way to obtain this proof. Refuse rather than
                // inheriting a stale connection's dispatch capability.
                if (_activeRouteEpoch <= 0 || _routesByRsid.ContainsKey(rsid))
                {
                    return null;
                }
                if (!_handlesByLocalKey.TryGetValue(localKey, out handle))
                {
                    return null;
                }
                if (!_documentContextCapabilityByLocalKey.TryGetValue(
                        localKey, out bool hasDocumentContextCapability) ||
                    !hasDocumentContextCapability)
                {
                    return null;
                }
                epoch = _activeRouteEpoch;
            }

            var call = new AddinCall(
                "route-proof-" + Guid.NewGuid().ToString("N"),
                RbpDocContextWatcher.CachedContextMethod,
                new Newtonsoft.Json.Linq.JObject(),
                TimeSpan.FromSeconds(10));
            AddinSessionRouter.InvocationLease lease = await _router
                .InvokeAsync(handle, call, cancellationToken, cancellationToken)
                .ConfigureAwait(false);
            try
            {
                AddinCallResult result = lease.GetResult();
                cancellationToken.ThrowIfCancellationRequested();
                AddinDocumentContextResponse response =
                    AddinDocumentContextParser.ParseResponse(
                        Encoding.UTF8.GetString(result.Response.RawPayload));
                if (!string.Equals(response.RequestId, call.InvocationId,
                        StringComparison.Ordinal) ||
                    response.Context.CacheState != DocumentContextCacheState.Ready ||
                    !RbpDocumentContextDiagnosticPair.TryCreate(
                        response.Context.Revision,
                        response.Context.CacheIncarnationDigest,
                        out RbpDocumentContextDiagnosticPair? freshness))
                {
                    return null;
                }

                string? afterLocalKey = await _localSessionKeyLookup(
                        rsid, cancellationToken).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                if (!string.Equals(localKey, afterLocalKey, StringComparison.Ordinal))
                {
                    return null;
                }
                lock (_routeSync)
                {
                    if (_activeRouteEpoch != epoch ||
                        _routesByRsid.ContainsKey(rsid) ||
                        !_handlesByLocalKey.TryGetValue(localKey, out var current) ||
                        !SameHandle(handle, current) ||
                        !_documentContextCapabilityByLocalKey.TryGetValue(
                            localKey, out bool hasDocumentContextCapability) ||
                        !hasDocumentContextCapability)
                    {
                        return null;
                    }
                }

                string normalized = DocumentContextMapper.NormalizeForComparison(
                    response.Context);
                using JsonDocument document = JsonDocument.Parse(normalized);
                return new RbpFreshDocumentContext(
                    document.RootElement.Clone(), freshness!);
            }
            finally
            {
                // The read is effect-free. Do not retain its single-flight
                // lease after the response/durable mapping decision.
                lease.ReleaseAfterDurableDecision();
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException) { return null; }
        catch
        {
            return null;
        }
    }

    /// <inheritdoc />
    public bool BeginConnectionEpoch(long epoch)
    {
        if (epoch <= 0) return false;
        lock (_routeSync)
        {
            if (epoch <= _highestRouteEpoch) return false;
            _highestRouteEpoch = epoch;
            _activeRouteEpoch = epoch;
            _routesByRsid.Clear();
            _revokedRsidsInEpoch.Clear();
            return true;
        }
    }

    /// <inheritdoc />
    public void FenceConnectionEpoch(long epoch)
    {
        lock (_routeSync)
        {
            if (_activeRouteEpoch != epoch) return;
            _routesByRsid.Clear();
            _revokedRsidsInEpoch.Clear();
            _activeRouteEpoch = 0;
        }
    }

    /// <inheritdoc />
    public bool TryBindRegisteredSession(
        string rsid,
        string localSessionKey,
        long epoch)
    {
        if (string.IsNullOrEmpty(rsid) || string.IsNullOrEmpty(localSessionKey))
        {
            return false;
        }

        lock (_routeSync)
        {
            if (_activeRouteEpoch != epoch ||
                _revokedRsidsInEpoch.Contains(rsid)) return false;
            if (!_handlesByLocalKey.TryGetValue(
                    localSessionKey,
                    out AddinSessionRouter.SessionHandle? current))
            {
                return false;
            }

            if (_routesByRsid.TryGetValue(rsid, out BoundRoute? existing))
            {
                return string.Equals(
                    existing.LocalSessionKey,
                    localSessionKey,
                    StringComparison.Ordinal) &&
                    existing.Epoch == epoch && SameHandle(existing.Handle, current);
            }

            _routesByRsid.Add(
                rsid,
                new BoundRoute(localSessionKey, current, epoch));
            return true;
        }
    }

    /// <inheritdoc />
    public void RevokeBoundSession(string rsid, long epoch)
    {
        if (string.IsNullOrEmpty(rsid)) return;
        lock (_routeSync)
        {
            if (_activeRouteEpoch == epoch &&
                _revokedRsidsInEpoch.Add(rsid))
            {
                _ = _routesByRsid.Remove(rsid);
            }
        }
    }

    private void ReplaceHandles(
        IReadOnlyDictionary<string, AddinSessionRouter.SessionHandle> handles,
        IReadOnlyDictionary<string, bool> documentContextCapabilities)
    {
        lock (_routeSync)
        {
            _handlesByLocalKey.Clear();
            _documentContextCapabilityByLocalKey.Clear();
            foreach (KeyValuePair<string, AddinSessionRouter.SessionHandle>
                     pair in handles)
            {
                _handlesByLocalKey.Add(pair.Key, pair.Value);
                _documentContextCapabilityByLocalKey.Add(
                    pair.Key,
                    documentContextCapabilities.TryGetValue(pair.Key,
                        out bool hasDocumentContextCapability) &&
                    hasDocumentContextCapability);
            }

            // Discovery is not route authority. A refresh may retain an
            // already-authorized route only when its exact handle identity and
            // epoch still match; it must never publish/rebind an absent or
            // replaced handle. Process-attestation drift is included in the
            // router's registration identity, therefore produces a new handle.
            foreach (string rsid in _routesByRsid.Keys.ToArray())
            {
                BoundRoute route = _routesByRsid[rsid];
                if (!_handlesByLocalKey.TryGetValue(
                        route.LocalSessionKey,
                        out AddinSessionRouter.SessionHandle? current))
                {
                    _ = _routesByRsid.Remove(rsid);
                    continue;
                }
                if (route.Epoch != _activeRouteEpoch ||
                    !SameHandle(route.Handle, current))
                {
                    _ = _routesByRsid.Remove(rsid);
                }
            }
        }
    }

    private static bool SameHandle(
        AddinSessionRouter.SessionHandle left,
        AddinSessionRouter.SessionHandle right) =>
        ReferenceEquals(left, right) &&
        left.Generation == right.Generation &&
        string.Equals(
            left.LocalSessionKey,
            right.LocalSessionKey,
            StringComparison.Ordinal);

    private sealed record BoundRoute(
        string LocalSessionKey,
        AddinSessionRouter.SessionHandle Handle,
        long Epoch);

    private string ReadMachineFingerprint()
    {
        using BridgeGatewayCredential credential =
            _credentials().GetRequired();
        if (!FingerprintPattern.IsMatch(credential.MachineFingerprint))
        {
            throw new BridgeCredentialUnavailableException(
                BridgeCredentialUnavailableErrorCode.StoreUnavailable,
                "The enrolled machine fingerprint is not a lower-case " +
                "sha256 digest.");
        }

        return _credentialClaims?.RequireSessionClaim(
                   credential.DeviceId,
                   credential.DeviceToken.Reveal(),
                   credential.MachineFingerprint) ??
               credential.MachineFingerprint;
    }

    private RbpLocalSessionSnapshot? TryProject(
        ProbedAddinSession session,
        string machineFingerprint)
    {
        AddinStatusSnapshot status = session.Status;
        if (session.LocalSessionKey.Length is 0 or > 512 ||
            status.Revit.ProcessId is < 1 or > int.MaxValue ||
            !IsBounded(status.Revit.Version) ||
            !IsBounded(status.Revit.Build) ||
            !IsBounded(status.AddinVersion) ||
            status.ResultContractVersion < 1 ||
            status.Service.Port is < 1 or > 65_535)
        {
            return null;
        }

        return new RbpLocalSessionSnapshot(
            session.LocalSessionKey,
            CreateRegistrationPayload(session, machineFingerprint),
            status.Service.Port,
            CreateRevitStatus(status));
    }

    private JsonElement CreateRegistrationPayload(
        ProbedAddinSession session,
        string machineFingerprint)
    {
        AddinStatusSnapshot status = session.Status;
        var buffer = new System.Buffers.ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("local_session_key", session.LocalSessionKey);

            writer.WriteStartObject("user_hint");

            // The Bridge runs under the machine service account and never
            // observes the interactive Revit user, so it declares no name
            // rather than inventing one from its own identity.
            writer.WriteString("name", string.Empty);
            writer.WriteEndObject();

            writer.WriteStartObject("machine");
            writer.WriteString("hostname", _hostname);
            writer.WriteString("fingerprint", machineFingerprint);
            writer.WriteEndObject();

            writer.WriteStartObject("revit");
            writer.WriteString("version", status.Revit.Version);
            writer.WriteString("build", status.Revit.Build);
            writer.WriteNumber("pid", status.Revit.ProcessId);
            writer.WriteEndObject();

            writer.WriteString("addin_version", status.AddinVersion);
            writer.WriteNumber(
                "result_contract_version",
                status.ResultContractVersion);

            writer.WriteStartArray("session_capabilities");
            foreach (string capability in SessionCapabilities(status))
            {
                writer.WriteStringValue(capability);
            }

            writer.WriteEndArray();

            writer.WriteString("bridge_version", _bridgeVersion);

            // Registration carries no documents. Section 14 makes the standing
            // document-context watcher the only authority for document state,
            // so an empty array here cannot go stale.
            writer.WriteStartArray("documents");
            writer.WriteEndArray();

            writer.WriteNumber("port", status.Service.Port);
            writer.WriteEndObject();
        }

        return Parse(buffer.WrittenSpan);
    }

    private static IReadOnlyList<string> SessionCapabilities(
        AddinStatusSnapshot status)
    {
        // A status probe is per local Revit session. Its parsed descriptor is
        // separate evidence from the connection hello and from the Gateway's
        // later per-rsid grant, so no capability may leak across sessions.
        var emitted = new List<string>(capacity: 2);
        foreach (string capability in status.SessionCapabilities)
        {
            bool hasMatchingDescriptor = capability switch
            {
                AddinStatusContract.BatchAtomicCapability =>
                    status.BatchAtomic is not null,
                AddinStatusContract.DocumentContextCachedCapability =>
                    status.DocumentContextCached is not null,
                _ => false,
            };
            if (hasMatchingDescriptor && CapabilityPattern.IsMatch(capability))
            {
                emitted.Add(capability);
            }
        }

        return emitted;
    }

    private static JsonElement CreateRevitStatus(AddinStatusSnapshot status)
    {
        var buffer = new System.Buffers.ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteBoolean("addin_reachable", true);
            if (status.ActiveTask is { } active)
            {
                writer.WriteStartObject("active_task");
                writer.WriteString("task_name", Bound(active.TaskName));
                writer.WriteString("state", Bound(active.State));
                writer.WriteNumber("elapsed_ms", active.ElapsedMs);
                writer.WriteEndObject();
            }
            else
            {
                writer.WriteNull("active_task");
            }

            writer.WriteEndObject();
        }

        return Parse(buffer.WrittenSpan);
    }

    private static JsonElement Parse(ReadOnlySpan<byte> utf8)
    {
        var reader = new Utf8JsonReader(utf8);
        using JsonDocument document = JsonDocument.ParseValue(ref reader);
        return document.RootElement.Clone();
    }

    private static bool IsBounded(string value) =>
        value is { Length: > 0 and <= 128 };

    private static string Bound(string? value)
    {
        if (value is not { Length: > 0 })
        {
            return string.Empty;
        }

        return value.Length <= 128 ? value : value[..128];
    }
}
