using System.Reflection;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Enrollment;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Runtime;

/// <summary>
/// The RBP data plane as one owned object graph inside the worker process:
/// the journal store, the add-in discovery/routing surface, and the connection
/// coordinator that owns the Gateway binding, invocation dispatch, and the
/// standing document-context watcher.
/// </summary>
/// <remarks>
/// <para>
/// Construction is the fail-closed gate. Everything a connection needs — the
/// canonical journal at the state root, the production resume-token
/// protector, the enrollment seam, the routed dispatch surface — is built
/// before the runtime exists. A precondition that cannot be met throws out of
/// <see cref="CreateProduction"/> and no half-built runtime is ever handed to
/// the host.
/// </para>
/// <para>
/// Nothing here touches the network. <see cref="RunAsync"/> is what starts
/// connecting, and it inherits the coordinator's existing full-jitter backoff
/// and frozen retry pauses, so an offline machine never blocks SCM start and
/// an unenrolled machine never retry-storms.
/// </para>
/// </remarks>
internal sealed class WorkerGatewayRuntime : IAsyncDisposable
{
    /// <summary>
    /// How often the background pump reconciles the coordinator's active
    /// <c>rsid</c> set against the durable session bindings.
    /// </summary>
    internal static readonly TimeSpan DefaultBindingRefreshInterval =
        TimeSpan.FromMilliseconds(250);

    /// <summary>
    /// The carrier producer's constructor sweep is recovery-only.  This pump
    /// keeps the seven-day terminal-fenced expiry policy alive for a long-lived
    /// worker without making any send path a cleanup authority.
    /// </summary>
    internal static readonly TimeSpan DefaultCarrierSweepInterval =
        TimeSpan.FromHours(1);

    private readonly RbpConnectionCoordinator _coordinator;
    private readonly IRbpSessionRouteBinder? _binder;
    private readonly RbpJournalStore? _ownedJournal;
    private readonly RbpArtifactCarrierProducer? _carrierProducer;
    private readonly TimeSpan _bindingRefreshInterval;
    private readonly TimeSpan _carrierSweepInterval;
    private int _disposed;

    internal WorkerGatewayRuntime(
        RbpConnectionCoordinator coordinator,
        IRbpSessionRouteBinder? binder = null,
        RbpJournalStore? ownedJournal = null,
        TimeSpan? bindingRefreshInterval = null,
        RbpArtifactCarrierProducer? carrierProducer = null,
        TimeSpan? carrierSweepInterval = null)
    {
        _coordinator = coordinator ??
            throw new ArgumentNullException(nameof(coordinator));
        _binder = binder;
        _ownedJournal = ownedJournal;
        _carrierProducer = carrierProducer;
        _bindingRefreshInterval =
            bindingRefreshInterval ?? DefaultBindingRefreshInterval;
        _carrierSweepInterval =
            carrierSweepInterval ?? DefaultCarrierSweepInterval;
        if (_bindingRefreshInterval <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(bindingRefreshInterval));
        }
        if (_carrierSweepInterval <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(carrierSweepInterval));
        }
    }

    internal RbpConnectionCoordinator Coordinator => _coordinator;

    /// <summary>
    /// Composes the production runtime at the canonical install layout.
    /// </summary>
    internal static WorkerGatewayRuntime CreateProduction(
        BridgeInstallLayout layout,
        ResolvedBridgeConfiguration configuration,
        RbpJournalOpenOptions? journalOptions = null,
        TimeSpan? bindingRefreshInterval = null,
        Action<AddinDiscoveryEvidence>? onDiscovered = null,
        Action<string>? onDispatchDiagnostic = null,
        Func<RbpConnectionFailureObservation, ValueTask>?
            onConnectionFailureObservation = null)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(configuration);

        string bridgeVersion = GetBridgeVersion();
        RbpJournalStore journal = WorkerGatewayComposition.OpenJournal(
            layout,
            WorkerResumeTokenProtector.CreateProduction(),
            journalOptions);
        try
        {
            var credentialClaims = new RbpCredentialClaimBinding(
                WorkerGatewayComposition.CreateEnrollmentStateProvider(
                    layout));
            RbpArtifactCarrierProducer? carrierProducer = null;
            try
            {
                carrierProducer = RbpArtifactCarrierProducer.CreateProduction(
                    layout.StateRoot,
                    journal);
            }
            catch (RbpArtifactCarrierException)
            {
                // A missing or unsafe spool never becomes a degraded carrier:
                // keep the existing inline-only posture and omit the carrier
                // capabilities from hello. The journal remains usable.
            }
            var transport = new AddinTcpTransport();
            var router = new AddinSessionRouter(transport);
            var catalog = new WorkerAddinSessionCatalog(
                new AddinDiscovery(transport),
                router,
                configuration,
                () => BridgeDeviceCredentialProvider.CreateProduction(layout),
                async (rsid, token) =>
                    (await journal
                        .GetStoredSessionAsync(rsid, token)
                        .ConfigureAwait(false))?.LocalSessionKey,
                bridgeVersion,
                hostname: null,
                onDiscovered: onDiscovered,
                credentialClaims: credentialClaims);

            RbpConnectionCoordinator coordinator =
                WorkerGatewayComposition.CreateCoordinator(
                    new WorkerGatewayServices(
                        WorkerGatewayComposition.CreateConnectionCycleFactory(
                            credentialClaims),
                        journal,
                        catalog,
                        new RbpConnectionCoordinatorOptions(
                            configuration.GatewayUri,
                            RbpHelloProfile.Production(
                                bridgeVersion,
                                Array.Empty<string>(),
                                carrierProducer is null
                                    ? null
                                    : RbpArtifactCarrierProducer
                                        .ConnectionCapabilities),
                            CredentialClaimInvalidator: credentialClaims),
                        new WorkerAddinDispatchSurface(router, catalog),
                        Clock: null,
                        Random: null,
                        OnDispatchDiagnostic: onDispatchDiagnostic,
                        OnConnectionFailureObservation:
                            onConnectionFailureObservation,
                        CarrierProducer: carrierProducer));

            return new WorkerGatewayRuntime(
                coordinator,
                catalog,
                journal,
                bindingRefreshInterval,
                carrierProducer);
        }
        catch
        {
            // A half-built runtime must never survive: release the machine-wide
            // single-writer journal lease before the failure propagates.
            journal.DisposeAsync().AsTask().GetAwaiter().GetResult();
            throw;
        }
    }

    /// <summary>
    /// Owns the connection for the lifetime of <paramref name="cancellationToken"/>.
    /// </summary>
    /// <remarks>
    /// The coordinator's own contract decides everything about retry. This
    /// method only guarantees that the background binding pump never outlives
    /// the connection and that a coordinator fault reaches the caller intact —
    /// including <see cref="RbpCoordinatorErrorCode.NonDrainingConnectionAuthority"/>,
    /// which the host must turn into a process exit.
    /// </remarks>
    internal async Task RunAsync(CancellationToken cancellationToken)
    {
        using var pumpCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken);
        Task pump = _binder is null
            ? Task.CompletedTask
            : RunBindingPumpAsync(pumpCancellation.Token);
        Task carrierSweep = _carrierProducer is null
            ? Task.CompletedTask
            : RunCarrierSweepAsync(pumpCancellation.Token);
        try
        {
            await _coordinator.RunAsync(cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            pumpCancellation.Cancel();
            await pump.ConfigureAwait(false);
            await carrierSweep.ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        if (_ownedJournal is not null)
        {
            await _ownedJournal.DisposeAsync().ConfigureAwait(false);
        }
    }

    private async Task RunBindingPumpAsync(CancellationToken cancellationToken)
    {
        IRbpSessionRouteBinder binder = _binder!;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await binder
                    .BindAsync(
                        _coordinator.GetSnapshot().ActiveRsids,
                        cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
                when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception)
            {
                // Route binding is an optimisation over the fail-closed
                // default: an unbound rsid resolves to a provable
                // non-dispatch, so a failed pass is retried, never escalated.
            }

            try
            {
                await Task.Delay(_bindingRefreshInterval, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task RunCarrierSweepAsync(CancellationToken cancellationToken)
    {
        RbpArtifactCarrierProducer producer = _carrierProducer!;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                producer.SweepExpired(DateTimeOffset.UtcNow);
                if (_ownedJournal is not null)
                {
                    _ = await _ownedJournal.ApplyRetentionAsync(
                            RbpJournalStore.MinimumRetentionPeriod,
                            cancellationToken)
                        .ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
                when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (RbpArtifactCarrierException)
            {
                // A fenced spool cleanup error leaves evidence intact and is
                // retried later. It must not terminate a live connection.
            }
            catch (IOException)
            {
                // Same posture for transient filesystem contention.
            }
            catch (RbpJournalException)
            {
                // Retention is bounded maintenance. A failed sweep leaves the
                // replay plan intact and retries on the next serialized pass.
            }

            try
            {
                await Task.Delay(_carrierSweepInterval, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private static string GetBridgeVersion()
    {
        Assembly assembly = Assembly.GetEntryAssembly() ??
            typeof(WorkerGatewayRuntime).Assembly;
        string version = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion ??
            assembly.GetName().Version?.ToString() ??
            "unknown";
        if (version.Length == 0)
        {
            return "unknown";
        }

        return version.Length <= 128 ? version : version[..128];
    }
}
