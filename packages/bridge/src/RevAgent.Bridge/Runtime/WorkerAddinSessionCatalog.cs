using System.Collections.Concurrent;
using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Enrollment;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.Runtime;

/// <summary>
/// Learns the durable <c>rsid</c> to local-session binding for the sessions
/// the coordinator currently owns.
/// </summary>
/// <remarks>
/// <see cref="IRbpSessionRouteResolver.Resolve"/> is synchronous by contract,
/// while the binding it needs lives in SQLite. Rather than block a dispatch
/// thread on the journal, the runtime pumps this seam in the background and an
/// unbound <c>rsid</c> resolves to <see langword="null"/> — a provable
/// non-dispatch — until the binding is known.
/// </remarks>
internal interface IRbpSessionRouteBinder
{
    Task BindAsync(
        IReadOnlyList<string> rsids,
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
    IRbpSessionRouteBinder
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

    /// <summary>
    /// Receives the evidence of every discovery pass. Discovery computes an
    /// exact rejection code per probed port and previously discarded it, so a
    /// machine whose Revit was never registered produced no record of why.
    /// </summary>
    private readonly Action<AddinDiscoveryEvidence>? _onDiscovered;

    private readonly ConcurrentDictionary<string,
        AddinSessionRouter.SessionHandle> _handlesByLocalKey =
        new(StringComparer.Ordinal);

    private readonly ConcurrentDictionary<string, string> _localKeyByRsid =
        new(StringComparer.Ordinal);

    private readonly ConcurrentDictionary<string, byte> _bindingsInFlight =
        new(StringComparer.Ordinal);

    private string? _machineFingerprint;

    internal WorkerAddinSessionCatalog(
        AddinDiscovery discovery,
        AddinSessionRouter router,
        ResolvedBridgeConfiguration configuration,
        Func<IBridgeDeviceCredentialProvider> credentials,
        Func<string, CancellationToken, Task<string?>> localSessionKeyLookup,
        string bridgeVersion,
        string? hostname = null,
        Action<AddinDiscoveryEvidence>? onDiscovered = null)
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
        foreach (AddinSessionRouter.SessionRoute route in
                 reconciled.AvailableSessions)
        {
            if (TryProject(route.Session, fingerprint) is not { } snapshot)
            {
                continue;
            }

            handles[route.Session.LocalSessionKey] = route.Handle;
            snapshots.Add(snapshot);
        }

        ReplaceHandles(handles);
        return new ReadOnlyCollection<RbpLocalSessionSnapshot>(snapshots);
    }

    /// <inheritdoc />
    public AddinSessionRouter.SessionHandle? Resolve(string rsid)
    {
        if (string.IsNullOrEmpty(rsid))
        {
            return null;
        }

        if (_localKeyByRsid.TryGetValue(rsid, out string? localKey) &&
            _handlesByLocalKey.TryGetValue(
                localKey,
                out AddinSessionRouter.SessionHandle? handle))
        {
            return handle;
        }

        // Unknown or superseded binding. Returning null is the fail-closed
        // answer: the routed channel reports a known non-dispatch and nothing
        // reaches an add-in session whose identity was not proved here.
        BeginBinding(rsid);
        return null;
    }

    /// <inheritdoc />
    public async Task BindAsync(
        IReadOnlyList<string> rsids,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(rsids);
        foreach (string rsid in rsids)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (string.IsNullOrEmpty(rsid) ||
                _localKeyByRsid.ContainsKey(rsid))
            {
                continue;
            }

            string? localKey = await _localSessionKeyLookup(
                    rsid,
                    cancellationToken)
                .ConfigureAwait(false);
            if (localKey is { Length: > 0 })
            {
                _ = _localKeyByRsid.TryAdd(rsid, localKey);
            }
        }
    }

    /// <summary>
    /// Test and recovery seam: records a known durable binding directly.
    /// </summary>
    internal void Bind(string rsid, string localSessionKey)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);
        ArgumentException.ThrowIfNullOrEmpty(localSessionKey);
        _localKeyByRsid[rsid] = localSessionKey;
    }

    private void BeginBinding(string rsid)
    {
        if (!_bindingsInFlight.TryAdd(rsid, 0))
        {
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                await BindAsync([rsid], CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch (Exception)
            {
                // A binding miss stays fail-closed; the journal read is
                // retried on the next dispatch attempt or background pump.
            }
            finally
            {
                _ = _bindingsInFlight.TryRemove(rsid, out _);
            }
        });
    }

    private void ReplaceHandles(
        IReadOnlyDictionary<string, AddinSessionRouter.SessionHandle> handles)
    {
        foreach (string stale in _handlesByLocalKey.Keys)
        {
            if (!handles.ContainsKey(stale))
            {
                _ = _handlesByLocalKey.TryRemove(stale, out _);
            }
        }

        foreach (KeyValuePair<string, AddinSessionRouter.SessionHandle> pair
                 in handles)
        {
            _handlesByLocalKey[pair.Key] = pair.Value;
        }
    }

    private string ReadMachineFingerprint()
    {
        if (_machineFingerprint is { Length: > 0 } cached)
        {
            return cached;
        }

        using BridgeGatewayCredential credential =
            _credentials().GetRequired();
        if (!FingerprintPattern.IsMatch(credential.MachineFingerprint))
        {
            throw new BridgeCredentialUnavailableException(
                BridgeCredentialUnavailableErrorCode.StoreUnavailable,
                "The enrolled machine fingerprint is not a lower-case " +
                "sha256 digest.");
        }

        _machineFingerprint = credential.MachineFingerprint;
        return _machineFingerprint;
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
            var emitted = new HashSet<string>(StringComparer.Ordinal);
            foreach (string capability in status.SessionCapabilities)
            {
                // A capability that does not match the frozen token shape is
                // dropped, never repaired: claiming less than the add-in
                // offered is safe, claiming a malformed token is not.
                if (CapabilityPattern.IsMatch(capability) &&
                    emitted.Add(capability))
                {
                    writer.WriteStringValue(capability);
                }
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
