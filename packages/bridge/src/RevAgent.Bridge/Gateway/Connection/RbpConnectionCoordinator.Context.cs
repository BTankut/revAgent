using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    private sealed record RbpSessionRegistered(
        string Rsid,
        string ResumeToken,
        DateTimeOffset ResumeExpiresAt,
        IReadOnlyList<string> GrantedCapabilities);

    private sealed record RbpResumeAck(
        string Rsid,
        long LastReceivedSequence,
        DateTimeOffset ResumeExpiresAt);

    private sealed record BoundSession(
        RbpLocalSessionSnapshot Local,
        RbpStoredSession Stored,
        RbpSessionLifecycleState Lifecycle);

    private sealed record HeartbeatFlight(
        RbpHeartbeatFence Fence,
        Task Deadline,
        TaskCompletionSource Observed,
        TaskCompletionSource Applied);

    private sealed record FailureTransition(
        RbpOpeningFailureClass Class,
        double ContinuousSteadyMilliseconds,
        double RetryAfterMilliseconds);

    private sealed class RbpWakeGapException : Exception
    {
        internal RbpWakeGapException(
            double continuousSteadyMilliseconds)
            : base("A monotonic sleep/wake gap ended the active binding.")
        {
            ContinuousSteadyMilliseconds = continuousSteadyMilliseconds;
        }

        internal double ContinuousSteadyMilliseconds { get; }
    }

    private sealed class RbpGoodbyeCycleException : Exception
    {
        internal RbpGoodbyeCycleException(
            RbpGoodbyeReason reason,
            double retryAfterMilliseconds,
            double continuousSteadyMilliseconds)
            : base($"The Gateway sent goodbye ({reason}).")
        {
            Reason = reason;
            RetryAfterMilliseconds = retryAfterMilliseconds;
            ContinuousSteadyMilliseconds =
                continuousSteadyMilliseconds;
        }

        internal RbpGoodbyeReason Reason { get; }

        internal double RetryAfterMilliseconds { get; }

        internal double ContinuousSteadyMilliseconds { get; }
    }

    private sealed class RbpConnectedCycleFailureException : Exception
    {
        internal RbpConnectedCycleFailureException(
            Exception cause,
            double continuousSteadyMilliseconds)
            : base("The active RBP connection cycle failed.", cause)
        {
            ContinuousSteadyMilliseconds =
                continuousSteadyMilliseconds;
        }

        internal double ContinuousSteadyMilliseconds { get; }
    }

    private sealed class CoordinatorTimeProvider : TimeProvider
    {
        private readonly IRbpCoordinatorClock _clock;

        internal CoordinatorTimeProvider(IRbpCoordinatorClock clock)
        {
            _clock = clock;
        }

        public override DateTimeOffset GetUtcNow() => _clock.UtcNow;
    }

    private sealed class ConnectionCycleContext : IDisposable
    {
        private readonly object _sync = new();
        private readonly RbpConnectionCoordinator _owner;
        private readonly CancellationTokenSource _cancellation;
        private readonly CancellationToken _token;
        private readonly Dictionary<string, BoundSession> _sessions =
            new(StringComparer.Ordinal);
        private readonly HashSet<string> _sentUnregister =
            new(StringComparer.Ordinal);
        private readonly List<RbpDataEnvelopeSnapshot> _pendingRetransmit =
            new();
        private readonly Dictionary<string, PendingControl>
            _pendingResume = new(StringComparer.Ordinal);
        private PendingControl? _pendingRegistration;
        private string? _pendingRegistrationLocalKey;
        private HeartbeatFlight? _heartbeatFlight;
        private bool _heartbeatFlightConsumed;
        private Task? _receiveTask;
        private Task? _heartbeatTask;
        private long _steadyStartedMilliseconds = -1;
        private Exception? _terminalFailure;
        private int _disposed;

        internal ConnectionCycleContext(
            RbpConnectionCoordinator owner,
            IRbpConnectionCycle cycle,
            long generation,
            CancellationToken serviceCancellationToken)
        {
            _owner = owner;
            Cycle = cycle;
            Generation = generation;
            _cancellation =
                CancellationTokenSource.CreateLinkedTokenSource(
                    serviceCancellationToken);
            _token = _cancellation.Token;
        }

        internal IRbpConnectionCycle Cycle { get; }

        internal long Generation { get; }

        internal long SteadyStartedMilliseconds
        {
            get
            {
                lock (_sync)
                {
                    return _steadyStartedMilliseconds;
                }
            }
        }

        internal CancellationToken Token => _token;

        internal Exception? TerminalFailure
        {
            get
            {
                lock (_sync)
                {
                    return _terminalFailure;
                }
            }
        }

        internal double ContinuousSteadyMilliseconds
        {
            get
            {
                long started = SteadyStartedMilliseconds;
                return started < 0
                    ? 0
                    : Math.Max(
                        0,
                        _owner._clock.MonotonicMilliseconds - started);
            }
        }

        internal void MarkSteady(long monotonicMilliseconds)
        {
            if (monotonicMilliseconds < 0)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(monotonicMilliseconds));
            }

            lock (_sync)
            {
                _steadyStartedMilliseconds = monotonicMilliseconds;
            }
        }

        internal IReadOnlyList<string> ActiveRsids
        {
            get
            {
                lock (_sync)
                {
                    return Array.AsReadOnly(
                        _sessions.Values
                            .Where(item => item.Lifecycle.DispatchAllowed)
                            .Select(item => item.Stored.Rsid)
                            .Order(StringComparer.Ordinal)
                            .ToArray());
                }
            }
        }

        internal Task ReceiveTask => _receiveTask ??
            throw new InvalidOperationException(
                "The receive loop has not started.");

        internal Task HeartbeatTask => _heartbeatTask ??
            throw new InvalidOperationException(
                "The heartbeat loop has not started.");

        internal void StartReceiveLoop()
        {
            lock (_sync)
            {
                if (_receiveTask is not null)
                {
                    throw new InvalidOperationException(
                        "The receive loop already started.");
                }

                _receiveTask = Own(
                    _owner.ReceiveLoopAsync(this));
            }
        }

        internal void StartHeartbeatLoop()
        {
            lock (_sync)
            {
                if (_heartbeatTask is not null)
                {
                    throw new InvalidOperationException(
                        "The heartbeat loop already started.");
                }

                _heartbeatTask = Own(
                    RunHeartbeatLoopAsync());
            }
        }

        private async Task RunHeartbeatLoopAsync()
        {
            try
            {
                await _owner.HeartbeatLoopAsync(this)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
                when (Token.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                FailPending(exception);
                Cancel();
                throw;
            }
        }

        internal Task<RbpEnvelope> BeginRegistration(string localSessionKey)
        {
            lock (_sync)
            {
                if (_pendingRegistration is not null)
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.SessionAuthorityConflict,
                        "Only one session registration control may be " +
                        "outstanding.");
                }

                _pendingRegistrationLocalKey = localSessionKey;
                _pendingRegistration = new PendingControl();
                return _pendingRegistration.Response.Task;
            }
        }

        internal Task DeliverRegistrationAsync(RbpEnvelope envelope)
        {
            lock (_sync)
            {
                if (_pendingRegistration is null)
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.UnexpectedControl,
                        "Unsolicited session_registered response.");
                }

                if (!_pendingRegistration.Response.TrySetResult(envelope))
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.UnexpectedControl,
                        "Duplicate session_registered response.");
                }

                return _pendingRegistration.Applied.Task;
            }
        }

        internal void AcknowledgeRegistrationApplied(
            string localSessionKey)
        {
            lock (_sync)
            {
                if (string.Equals(
                        _pendingRegistrationLocalKey,
                        localSessionKey,
                        StringComparison.Ordinal))
                {
                    _pendingRegistration?.Applied.TrySetResult();
                }
            }
        }

        internal void RejectRegistrationApplication(
            string localSessionKey,
            Exception exception)
        {
            lock (_sync)
            {
                if (string.Equals(
                        _pendingRegistrationLocalKey,
                        localSessionKey,
                        StringComparison.Ordinal))
                {
                    RejectApplication(
                        _pendingRegistration,
                        exception,
                        Token);
                }
            }
        }

        internal void EndRegistration(string localSessionKey)
        {
            lock (_sync)
            {
                if (string.Equals(
                        _pendingRegistrationLocalKey,
                        localSessionKey,
                        StringComparison.Ordinal))
                {
                    _pendingRegistration = null;
                    _pendingRegistrationLocalKey = null;
                }
            }
        }

        internal Task<RbpEnvelope> BeginResume(string rsid)
        {
            lock (_sync)
            {
                var pending = new PendingControl();
                if (!_pendingResume.TryAdd(rsid, pending))
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.SessionAuthorityConflict,
                        "A resume control is already outstanding for this " +
                        "rsid.");
                }

                return pending.Response.Task;
            }
        }

        internal Task DeliverResumeAsync(
            string rsid,
            RbpEnvelope envelope)
        {
            lock (_sync)
            {
                if (!_pendingResume.TryGetValue(
                        rsid,
                        out PendingControl? pending))
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.UnexpectedControl,
                        "Unsolicited resume_ack response.");
                }

                if (!pending.Response.TrySetResult(envelope))
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.UnexpectedControl,
                        "Duplicate resume_ack response.");
                }

                return pending.Applied.Task;
            }
        }

        internal void AcknowledgeResumeApplied(string rsid)
        {
            lock (_sync)
            {
                if (_pendingResume.TryGetValue(
                        rsid,
                        out PendingControl? pending))
                {
                    pending.Applied.TrySetResult();
                }
            }
        }

        internal void RejectResumeApplication(
            string rsid,
            Exception exception)
        {
            lock (_sync)
            {
                if (_pendingResume.TryGetValue(
                        rsid,
                        out PendingControl? pending))
                {
                    RejectApplication(pending, exception, Token);
                }
            }
        }

        internal void EndResume(string rsid)
        {
            lock (_sync)
            {
                _ = _pendingResume.Remove(rsid);
            }
        }

        internal void AddBoundSession(BoundSession session)
        {
            lock (_sync)
            {
                if (_sessions.ContainsKey(session.Stored.Rsid) ||
                    _sessions.Values.Any(item =>
                        string.Equals(
                            item.Local.LocalSessionKey,
                            session.Local.LocalSessionKey,
                            StringComparison.Ordinal)))
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.SessionAuthorityConflict,
                        "The connection already owns this RBP or local " +
                        "session.");
                }

                _sessions.Add(session.Stored.Rsid, session);
            }
        }

        internal void QueueRetransmit(
            IReadOnlyList<RbpDataEnvelopeSnapshot> envelopes)
        {
            ArgumentNullException.ThrowIfNull(envelopes);
            lock (_sync)
            {
                _pendingRetransmit.AddRange(
                    envelopes
                        .OrderBy(item => item.Rsid, StringComparer.Ordinal)
                        .ThenBy(item => item.Sequence)
                        .Select(item => item.Snapshot()));
            }
        }

        internal IReadOnlyList<RbpDataEnvelopeSnapshot>
            GetPendingRetransmit()
        {
            lock (_sync)
            {
                return Array.AsReadOnly(
                    _pendingRetransmit
                        .OrderBy(item => item.Rsid, StringComparer.Ordinal)
                        .ThenBy(item => item.Sequence)
                        .Select(item => item.Snapshot())
                        .ToArray());
            }
        }

        internal void ClearPendingRetransmit()
        {
            lock (_sync)
            {
                _pendingRetransmit.Clear();
            }
        }

        internal IReadOnlyList<BoundSession> GetBoundSessions()
        {
            lock (_sync)
            {
                return Array.AsReadOnly(
                    _sessions.Values
                        .OrderBy(
                            item => item.Stored.Rsid,
                            StringComparer.Ordinal)
                        .ToArray());
            }
        }

        internal bool IsDispatchAllowed(string rsid)
        {
            lock (_sync)
            {
                return _sessions.TryGetValue(
                           rsid,
                           out BoundSession? session) &&
                       session.Lifecycle.DispatchAllowed;
            }
        }

        internal void RefreshBoundSession(
            string rsid,
            RbpLocalSessionSnapshot local)
        {
            lock (_sync)
            {
                if (_sessions.TryGetValue(
                        rsid,
                        out BoundSession? existing))
                {
                    _sessions[rsid] = existing with { Local = local };
                }
            }
        }

        internal void RevokeBoundSession(
            string rsid,
            RbpSessionUnregisterReason reason)
        {
            lock (_sync)
            {
                if (_sessions.Remove(
                        rsid,
                        out BoundSession? existing))
                {
                    _ = AdvanceSession(
                        existing.Lifecycle,
                        new RbpSessionEvent(
                            RbpSessionEventType.Unregister,
                            UnregisterReason: reason));
                }
            }
        }

        internal void MarkUnregisterSent(string rsid)
        {
            lock (_sync)
            {
                _ = _sentUnregister.Add(rsid);
            }
        }

        internal IReadOnlyList<string> GetSentUnregisterRsids()
        {
            lock (_sync)
            {
                return Array.AsReadOnly(
                    _sentUnregister
                        .Order(StringComparer.Ordinal)
                        .ToArray());
            }
        }

        internal void MarkUnregisterConfirmed(string rsid)
        {
            lock (_sync)
            {
                _ = _sentUnregister.Remove(rsid);
            }
        }

        internal HeartbeatFlight InstallHeartbeatFlight(
            RbpHeartbeatFence fence,
            Task deadline)
        {
            ArgumentNullException.ThrowIfNull(fence);
            ArgumentNullException.ThrowIfNull(deadline);
            lock (_sync)
            {
                if (_heartbeatFlight is not null)
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.SessionAuthorityConflict,
                        "RBP heartbeats must remain globally single-flight.");
                }

                var flight = new HeartbeatFlight(
                    fence,
                    deadline,
                    NewCompletion(),
                    NewCompletion());
                ObserveLateFault(flight.Observed.Task);
                ObserveLateFault(flight.Applied.Task);
                _heartbeatFlight = flight;
                _heartbeatFlightConsumed = false;
                return flight;
            }
        }

        internal HeartbeatFlight? ConsumeAndObserveHeartbeatFlight()
        {
            lock (_sync)
            {
                if (_heartbeatFlight is not { } flight ||
                    _heartbeatFlightConsumed)
                {
                    return null;
                }

                _heartbeatFlightConsumed = true;
                flight.Observed.TrySetResult();
                return flight;
            }
        }

        internal void CompleteHeartbeatFlight(HeartbeatFlight flight)
        {
            lock (_sync)
            {
                if (!ReferenceEquals(_heartbeatFlight, flight) ||
                    !_heartbeatFlightConsumed)
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.SessionAuthorityConflict,
                        "Only the consumed current heartbeat flight may be " +
                        "completed.");
                }

                _heartbeatFlight = null;
                _heartbeatFlightConsumed = false;
                flight.Applied.TrySetResult();
            }
        }

        internal void FailHeartbeatFlight(
            HeartbeatFlight flight,
            Exception exception)
        {
            ArgumentNullException.ThrowIfNull(exception);
            lock (_sync)
            {
                if (ReferenceEquals(_heartbeatFlight, flight))
                {
                    _heartbeatFlight = null;
                    _heartbeatFlightConsumed = false;
                }

                flight.Observed.TrySetException(exception);
                flight.Applied.TrySetException(exception);
            }
        }

        internal bool TryRollbackHeartbeatFlight(HeartbeatFlight flight)
        {
            lock (_sync)
            {
                if (ReferenceEquals(_heartbeatFlight, flight) &&
                    !_heartbeatFlightConsumed)
                {
                    _heartbeatFlight = null;
                    _heartbeatFlightConsumed = false;
                    flight.Observed.TrySetCanceled(Token);
                    flight.Applied.TrySetCanceled(Token);
                    return true;
                }

                return false;
            }
        }

        internal void FailPending(Exception exception)
        {
            lock (_sync)
            {
                _terminalFailure ??= exception;
                _pendingRegistration?.Response.TrySetException(exception);
                RejectApplication(
                    _pendingRegistration,
                    exception,
                    Token);
                foreach (PendingControl pending in _pendingResume.Values)
                {
                    pending.Response.TrySetException(exception);
                    RejectApplication(pending, exception, Token);
                }

                if (_heartbeatFlight is { } heartbeatFlight &&
                    !_heartbeatFlightConsumed)
                {
                    _heartbeatFlight = null;
                    _heartbeatFlightConsumed = false;
                    heartbeatFlight.Observed.TrySetException(exception);
                    heartbeatFlight.Applied.TrySetException(exception);
                }
            }
        }

        internal void Cancel()
        {
            if (Volatile.Read(ref _disposed) == 0 &&
                !_cancellation.IsCancellationRequested)
            {
                _cancellation.Cancel();
            }
        }

        internal async Task<bool> AwaitOwnedTasksAsync(TimeSpan timeout)
        {
            if (timeout <= TimeSpan.Zero)
            {
                throw new ArgumentOutOfRangeException(nameof(timeout));
            }

            Task[] tasks;
            lock (_sync)
            {
                tasks = new[] { _receiveTask, _heartbeatTask }
                    .Where(task => task is not null)
                    .Cast<Task>()
                    .ToArray();
            }

            if (tasks.Length == 0)
            {
                return true;
            }

            Task all = Task.WhenAll(tasks);
            Task completed = await Task.WhenAny(
                    all,
                    Task.Delay(timeout))
                .ConfigureAwait(false);
            if (!ReferenceEquals(completed, all))
            {
                ObserveLateFault(all);
                return false;
            }

            try
            {
                await all.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
                when (Token.IsCancellationRequested)
            {
            }
            catch
            {
                // The owning run path already observed the first terminal
                // task. Awaiting here prevents orphaned task exceptions.
            }

            return true;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                try
                {
                    if (!_cancellation.IsCancellationRequested)
                    {
                        _cancellation.Cancel();
                    }
                }
                finally
                {
                    _cancellation.Dispose();
                }
            }
        }

        private async Task Own(Task task)
        {
            _owner.OwnedTaskStarted();
            try
            {
                await task.ConfigureAwait(false);
            }
            finally
            {
                _owner.OwnedTaskCompleted();
            }
        }

        private static TaskCompletionSource<T> NewCompletion<T>() =>
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        private static TaskCompletionSource NewCompletion() =>
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        private static void RejectApplication(
            PendingControl? pending,
            Exception exception,
            CancellationToken cancellationToken)
        {
            if (pending is null)
            {
                return;
            }

            if (pending.Response.Task.IsCompletedSuccessfully)
            {
                pending.Applied.TrySetException(exception);
            }
            else
            {
                pending.Applied.TrySetCanceled(cancellationToken);
            }
        }

        private sealed class PendingControl
        {
            internal TaskCompletionSource<RbpEnvelope> Response { get; } =
                NewCompletion<RbpEnvelope>();

            internal TaskCompletionSource Applied { get; } =
                NewCompletion();
        }
    }
}
