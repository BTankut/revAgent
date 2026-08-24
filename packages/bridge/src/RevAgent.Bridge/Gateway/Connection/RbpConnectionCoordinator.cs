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
        Func<CancellationToken, Task>? beforeRecoveryCarrierWrite = null)
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
        lock (_sync)
        {
            lifecycle = _lifecycle;
            generation = _connectionGeneration;
            active = _active;
            ownedTasks = _ownedBackgroundTasks;
            invocations = _activeInvocations;
        }

        return new RbpConnectionCoordinatorSnapshot(
            lifecycle,
            generation,
            active is not null,
            active?.ActiveRsids ??
            Array.AsReadOnly(Array.Empty<string>()),
            ownedTasks,
            invocations);
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
                active.Dispose();
            }

            if (_lifecycle.Phase != RbpConnectionPhase.Shutdown)
            {
                AdvanceConnection(
                    new RbpConnectionEvent(
                        RbpConnectionEventType.ShutdownRequested));
            }

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
            if (context is not null)
            {
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
