using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    private static readonly Regex Rfc3339Pattern = new(
        "^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:" +
        "[0-9]{2}(?:\\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex CapabilityPattern = new(
        "^[a-z][a-z0-9_]{0,127}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex Sha256Pattern = new(
        "^sha256:[0-9a-f]{64}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    private readonly object _sync = new();
    private readonly IRbpConnectionCycleFactory _cycleFactory;
    private readonly RbpJournalStore _journal;
    private readonly IRbpLocalSessionCatalog _catalog;
    private readonly IRbpInboundDataJournal _inboundJournal;
    private readonly IRbpCoordinatorClock _clock;
    private readonly IRbpRandomSource _random;
    private readonly RbpConnectionCoordinatorOptions _options;
    private readonly RbpUuidV7 _identifiers;

    /// <summary>
    /// Required. A coordinator that accepts sessions and receives <c>invoke</c>
    /// frames but has no add-in dispatch surface can only strand the Gateway,
    /// so the case is made unrepresentable rather than handled.
    /// </summary>
    private readonly IRbpInvocationDispatcher _invocationDispatcher;

    /// <summary>
    /// Optional because a coordinator without a dispatch surface cannot execute
    /// a batch. Unlike the missing-surface invoke case, a batch that arrives
    /// while this is null is answered with a terminal <c>unsupported</c> fault
    /// rather than swallowed: the frame was already sequenced and acknowledged,
    /// so silence here would strand the Gateway's window forever.
    /// </summary>
    private readonly RbpBatchCoordinator? _batchCoordinator;
    private readonly RbpArtifactCarrierProducer? _carrierProducer;
    private readonly RbpProtectedRecoveryCarrierMaterializer
        _recoveryCarrierMaterializer;
    private readonly Func<CancellationToken, Task>? _beforeRecoveryCarrierWrite;
    private readonly Func<CancellationToken, Task>? _beforeRecoveryTerminalWrite;
    private readonly Func<CancellationToken, Task>? _afterRecoveryCarrierWriteBeforeAck;
    private readonly RbpConformanceOmittedOriginObservation _omittedOriginObservation;
    private readonly IRbpRecoveryCarrierObservationSink
        _recoveryCarrierObservationSink;
    private readonly IRbpReconnectObservationSink _reconnectObservationSink;

    /// <summary>
    /// Bounded, non-secret dispatch trace. The batch path has several silent
    /// returns by design — a per-session journal condition, a closed transport,
    /// a session that lost dispatch authority — and every one of them looks
    /// identical from outside: the Gateway's window stays occupied and nothing
    /// is written anywhere. This makes which one happened observable.
    /// </summary>
    private readonly Action<string>? _onDispatchDiagnostic;
    private readonly Func<RbpConnectionFailureObservation, ValueTask>?
        _onConnectionFailureObservation;
    private readonly Func<RbpLifecycleTimeoutObservation, ValueTask>?
        _onLifecycleTimeoutObservation;
    private readonly Func<RbpDocumentContextObservation, ValueTask>?
        _onDocumentContextObservation;
    private readonly SemaphoreSlim _retryConditionSignal = new(0, 1);
    private RbpConnectionLifecycleState _lifecycle =
        RbpConnectionReducer.CreateConnectionLifecycle();
    private ConnectionCycleContext? _active;
    private long _connectionGeneration;
    private int _runStarted;
    private int _connectionAuthorityPoisoned;
    private int _ownedBackgroundTasks;
    private int _activeInvocations;
    private readonly Dictionary<string, DocumentContextQueuedDiagnostic> _documentContextQueued =
        new(StringComparer.Ordinal);
    private readonly object _recoveryCarrierClaimSync = new();
    private readonly HashSet<RecoveryCarrierCycleKey> _recoveryCarrierClaims = new();
    private readonly HashSet<RecoveryCarrierAckGateKey> _recoveryCarrierAckGates = new();
    private readonly HashSet<RecoveryTerminalDeliveryKey> _recoveryTerminalDeliveries = new();
    private readonly HashSet<RecoveryTerminalCycleKey> _recoveryTerminalClaims = new();
    // Observations are volatile only, but a recovery receipt can arrive on a
    // later connection cycle. Keep the one unacknowledged digest by durable
    // recovery identity rather than a socket-cycle object.
    private readonly Dictionary<RecoveryCarrierDigestKey, string>
        _recoveryCarrierOuterDigests = new();
    private long _recoveryCarrierObservationOrdinal;
    private long _c39CausalOrdinal;
    private readonly Dictionary<RouteAuthorityCheckpointKey, string>
        _routeAuthorityCheckpoints = new();

    internal RbpConnectionCoordinator(
        IRbpConnectionCycleFactory cycleFactory,
        RbpJournalStore journal,
        IRbpLocalSessionCatalog catalog,
        RbpConnectionCoordinatorOptions options,
        IRbpInvocationDispatcher invocationDispatcher,
        IRbpInboundDataJournal? inboundJournal = null,
        IRbpCoordinatorClock? clock = null,
        IRbpRandomSource? random = null,
        RbpDocContextWatcher? docContextWatcher = null,
        RbpBatchCoordinator? batchCoordinator = null,
        Action<string>? onDispatchDiagnostic = null,
        Func<RbpConnectionFailureObservation, ValueTask>?
            onConnectionFailureObservation = null,
        RbpArtifactCarrierProducer? carrierProducer = null,
        Func<RbpLifecycleTimeoutObservation, ValueTask>?
            onLifecycleTimeoutObservation = null,
        Func<RbpDocumentContextObservation, ValueTask>?
            onDocumentContextObservation = null,
        RbpProtectedRecoveryCarrierMaterializer?
            recoveryCarrierMaterializer = null,
        Func<CancellationToken, Task>? beforeRecoveryCarrierWrite = null,
        Func<CancellationToken, Task>? beforeRecoveryTerminalWrite = null,
        Func<CancellationToken, Task>? afterRecoveryCarrierWriteBeforeAck = null,
        RbpConformanceOmittedOriginObservation? omittedOriginObservation = null,
        IRbpRecoveryCarrierObservationSink? recoveryCarrierObservationSink = null,
        IRbpReconnectObservationSink? reconnectObservationSink = null)
    {
        _batchCoordinator = batchCoordinator;
        _carrierProducer = carrierProducer;
        _onDispatchDiagnostic = onDispatchDiagnostic;
        _onConnectionFailureObservation = onConnectionFailureObservation;
        _onLifecycleTimeoutObservation = onLifecycleTimeoutObservation;
        _onDocumentContextObservation = onDocumentContextObservation;
        _invocationDispatcher = invocationDispatcher ??
            throw new ArgumentNullException(nameof(invocationDispatcher));
        _cycleFactory = cycleFactory ??
            throw new ArgumentNullException(nameof(cycleFactory));
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        _recoveryCarrierMaterializer = recoveryCarrierMaterializer ??
            new RbpProtectedRecoveryCarrierMaterializer(_journal);
        _beforeRecoveryCarrierWrite = beforeRecoveryCarrierWrite;
        _beforeRecoveryTerminalWrite = beforeRecoveryTerminalWrite;
        _afterRecoveryCarrierWriteBeforeAck = afterRecoveryCarrierWriteBeforeAck;
        _omittedOriginObservation = omittedOriginObservation ??
            RbpConformanceOmittedOriginObservation.Never;
        _recoveryCarrierObservationSink = recoveryCarrierObservationSink ??
            RbpRecoveryCarrierObservationSink.None;
        _reconnectObservationSink = reconnectObservationSink ??
            RbpReconnectObservationSink.None;
        _catalog = catalog ?? throw new ArgumentNullException(nameof(catalog));
        _options = options ??
            throw new ArgumentNullException(nameof(options));
        _inboundJournal =
            inboundJournal ?? FailClosedRbpInboundDataJournal.Instance;
        _clock = clock ?? SystemRbpCoordinatorClock.Instance;
        _random = random ?? CryptographicRbpRandomSource.Shared;
        _docContextWatcher = docContextWatcher;
        _identifiers = new RbpUuidV7(
            new CoordinatorTimeProvider(_clock),
            _random);
        ValidateOptions(cycleFactory, options);
    }

    internal RbpConnectionCoordinatorSnapshot GetSnapshot()
    {
        RbpConnectionLifecycleState lifecycle;
        long generation;
        ConnectionCycleContext? active;
        int ownedTasks;
        int invocations;
        bool routeRebindProofGranted;
        lock (_sync)
        {
            lifecycle = _lifecycle;
            generation = _connectionGeneration;
            active = _active;
            ownedTasks = _ownedBackgroundTasks;
            invocations = _activeInvocations;
            routeRebindProofGranted = active is not null &&
                _connectionGeneration == active.Generation &&
                active.GrantedConnectionCapabilities.Contains(
                    RbpHelloProfile.RouteRebindProofCapability,
                    StringComparer.Ordinal);
        }

        return new RbpConnectionCoordinatorSnapshot(
            lifecycle,
            generation,
            active is not null,
            active?.ActiveRsids ??
            Array.AsReadOnly(Array.Empty<string>()),
            ownedTasks,
            invocations,
            routeRebindProofGranted);
    }

    internal void NotifyRetryConditionChanged()
    {
        lock (_sync)
        {
            if (_lifecycle.Phase != RbpConnectionPhase.RetryPaused)
            {
                return;
            }

            try
            {
                _retryConditionSignal.Release();
            }
            catch (SemaphoreFullException)
            {
                // One pending change notification is sufficient.
            }
        }
    }

    internal async Task RunAsync(
        CancellationToken cancellationToken = default)
    {
        if (Volatile.Read(ref _connectionAuthorityPoisoned) != 0)
        {
            throw NonDrainingConnectionAuthority();
        }

        if (Interlocked.CompareExchange(ref _runStarted, 1, 0) != 0)
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.AlreadyRunning,
                "The RBP connection coordinator already owns its run loop.");
        }

        try
        {
            AdvanceConnection(new RbpConnectionEvent(
                RbpConnectionEventType.Start));
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    await RunOneConnectionAsync(cancellationToken)
                        .ConfigureAwait(false);
                    throw new RbpGatewayTransportException(
                        RbpGatewayFailureKind.RemoteClosed,
                        "The RBP connection cycle ended without a terminal " +
                        "transport event.");
                }
                catch (OperationCanceledException)
                    when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
                catch (RbpGoodbyeCycleException goodbye)
                {
                    if (goodbye.Reason == RbpGoodbyeReason.AuthRevoked)
                    {
                        _options.CredentialClaimInvalidator?
                            .InvalidateActiveCredential();
                    }

                    AdvanceConnection(
                        new RbpConnectionEvent(
                            RbpConnectionEventType.Goodbye,
                            ContinuousSteadyMilliseconds:
                                goodbye.ContinuousSteadyMilliseconds,
                            RetryAfterMilliseconds:
                                goodbye.RetryAfterMilliseconds,
                            GoodbyeReason: goodbye.Reason));
                }
                catch (RbpCoordinatorException exception)
                    when (exception.ErrorCode ==
                          RbpCoordinatorErrorCode
                              .NonDrainingConnectionAuthority)
                {
                    throw;
                }
                catch (Exception exception)
                {
                    FailureTransition failure = ClassifyFailure(exception);
                    if (failure.GatewayFailure ==
                            RbpGatewayFailureKind.Authorization &&
                        (failure.HttpStatus == 403 ||
                         failure.CloseCode == 4403))
                    {
                        _options.CredentialClaimInvalidator?
                            .InvalidateActiveCredential();
                    }

                    AdvanceConnection(
                        new RbpConnectionEvent(
                            RbpConnectionEventType.ConnectionFailed,
                            ContinuousSteadyMilliseconds:
                                failure.ContinuousSteadyMilliseconds,
                            RetryAfterMilliseconds:
                                failure.RetryAfterMilliseconds,
                            Failure: failure.Class));
                    ObserveConnectionFailure(failure);
                }

                try
                {
                    await WaitForRetryAuthorityAsync(cancellationToken)
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                    when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
            }
        }
        finally
        {
            ConnectionCycleContext? active;
            lock (_sync)
            {
                active = _active;
            }

            if (active is not null)
            {
                active.Cancel();
                await CloseCycleBoundedAsync(active.Cycle)
                    .ConfigureAwait(false);
                bool ownedTasksDrained =
                    await active.AwaitOwnedTasksAsync(
                        _options.EffectiveCloseTimeout)
                    .ConfigureAwait(false);
                if (!ownedTasksDrained)
                {
                    Interlocked.Exchange(
                        ref _connectionAuthorityPoisoned,
                        1);
                }

                ClearActiveContext(active);
                ClearRouteAuthorityCheckpoints(active);
                active.Dispose();
            }

            if (_lifecycle.Phase != RbpConnectionPhase.Shutdown)
            {
                AdvanceConnection(
                    new RbpConnectionEvent(
                        RbpConnectionEventType.ShutdownRequested));
            }

            ClearAllRecoveryCarrierOuterDigests();
            Interlocked.Exchange(ref _runStarted, 0);
        }
    }

    private async Task RunOneConnectionAsync(
        CancellationToken serviceCancellationToken)
    {
        // Each fresh transport cycle starts from durable fences. This covers
        // both process startup and reconnect after a crash between the ACK
        // transaction and spool cleanup; no spool directory is discovered.
        if (_carrierProducer is not null)
        {
            RbpCarrierRecovery carrierRecovery =
                await _carrierProducer.RehydrateFencesAsync(serviceCancellationToken)
                .ConfigureAwait(false);
            await CompleteCarrierSpoolReleasesAsync(
                    carrierRecovery.PendingReleases,
                    serviceCancellationToken)
                .ConfigureAwait(false);
        }

        IRbpConnectionCycle cycle = await _cycleFactory
            .OpenAsync(
                _options.Endpoint,
                _options.HelloProfile,
                serviceCancellationToken)
            .ConfigureAwait(false);

        ConnectionCycleContext? context = null;
        long? routeAuthorityEpoch = null;
        try
        {
            ValidateCycleAcknowledgement(cycle.Acknowledgement);
            AdvanceConnection(
                new RbpConnectionEvent(
                    RbpConnectionEventType.TransportOpened));
            AdvanceConnection(
                new RbpConnectionEvent(
                    RbpConnectionEventType.AuthenticationAccepted));
            AdvanceConnection(
                new RbpConnectionEvent(
                    RbpConnectionEventType.HelloAccepted,
                    SelectedProtocol: cycle.Acknowledgement.Protocol,
                    GrantedCapabilities:
                        cycle.Acknowledgement.GrantedCapabilities));

            long generation = NextConnectionGeneration();
            routeAuthorityEpoch = generation;
            BeginRouteAuthorityEpoch(generation);
            await _journal.ActivateConnectionGenerationAsync(
                    generation,
                    serviceCancellationToken)
                .ConfigureAwait(false);

            context = new ConnectionCycleContext(
                this,
                cycle,
                generation,
                cycle.Acknowledgement.GrantedCapabilities,
                serviceCancellationToken);
            SetActiveContext(context);

            RbpJournalRecoveryPlan recovery =
                await _journal.LoadRecoveryPlanAsync(context.Token)
                    .ConfigureAwait(false);
            await RecoverPendingInboundHandoffsAsync(
                    recovery.PendingInboundHandoffs,
                    context.Token)
                .ConfigureAwait(false);
            await CompleteConfirmedCleanupAsync(
                    recovery.ConfirmedCleanup,
                    context.Token)
                .ConfigureAwait(false);

            context.StartReceiveLoop();
            await SynchronizeSessionsAsync(context, recovery)
                .ConfigureAwait(false);
            context.MarkSteady(_clock.MonotonicMilliseconds);
            context.StartHeartbeatLoop();
            await FlushPendingRetransmitAsync(context)
                .ConfigureAwait(false);
            await ScheduleActiveRecoveryCarriersAsync(context)
                .ConfigureAwait(false);
            await ScheduleActiveRecoveryTerminalsAsync(context)
                .ConfigureAwait(false);

            Task completed = await Task.WhenAny(
                        context.ReceiveTask,
                        context.HeartbeatTask)
                    .WaitAsync(serviceCancellationToken)
                .ConfigureAwait(false);
            await completed.ConfigureAwait(false);
        }
        catch (Exception exception)
            when (context is not null &&
                  exception is not RbpGoodbyeCycleException &&
                  exception is not RbpWakeGapException &&
                  !(exception is OperationCanceledException &&
                    serviceCancellationToken.IsCancellationRequested))
        {
            Exception cause =
                exception is OperationCanceledException &&
                context.TerminalFailure is { } terminalFailure
                    ? terminalFailure
                    : exception;
            throw new RbpConnectedCycleFailureException(
                cause,
                context.ContinuousSteadyMilliseconds);
        }
        finally
        {
            // This also covers failure between BeginConnectionEpoch and
            // context construction/journal activation.
            if (routeAuthorityEpoch is { } begunEpoch)
            {
                FenceRouteAuthorityEpoch(begunEpoch);
            }
            if (context is not null)
            {
                // Route authority ends before cancellation/drain.  Any late
                // callback from this connection must observe no dispatchable
                // route, not a route retained until transport close finishes.
                ClearRecoveryCarrierClaims(context);
                bool serviceShutdown =
                    serviceCancellationToken.IsCancellationRequested;
                if (serviceShutdown)
                {
                    await TryRecordShutdownUnregistersAsync(context)
                        .ConfigureAwait(false);
                }

                context.Cancel();
                await CloseCycleBoundedAsync(cycle).ConfigureAwait(false);

                // Give in-flight invocations a bounded chance to reach a
                // durable decision. P-UPD-4 allows "finishes in-flight
                // invocation OR journals it", so an expiry here loses the
                // delivery, never the decision. The result is deliberately not
                // consulted: an unfinished add-in call must not poison
                // connection authority.
                _ = await context
                    .DrainInvocationsAsync(
                        _options.EffectiveInvocationDrainTimeout)
                    .ConfigureAwait(false);
                bool ownedTasksDrained =
                    await context.AwaitOwnedTasksAsync(
                        _options.EffectiveCloseTimeout)
                    .ConfigureAwait(false);
                ClearActiveContext(context);
                ClearRouteAuthorityCheckpoints(context);
                context.Dispose();

                if (!ownedTasksDrained)
                {
                    Interlocked.Exchange(
                        ref _connectionAuthorityPoisoned,
                        1);
                    if (!serviceCancellationToken.IsCancellationRequested)
                    {
                        throw NonDrainingConnectionAuthority();
                    }
                }
            }
            else
            {
                await CloseCycleBoundedAsync(cycle).ConfigureAwait(false);
            }
        }
    }

    private static RbpCoordinatorException
        NonDrainingConnectionAuthority() =>
        new(
            RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
            "An RBP connection-owned handler ignored cancellation and did " +
            "not drain before the close deadline. Connection authority is " +
            "poisoned; restart the Bridge process before reconnecting.");

}
