using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Contracts.AddinLoopback;

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

    private enum CleanupReceiveDisposition
    {
        NotPermitted,
        Discarded,
        Conflict,
    }

    private sealed record CleanupReceivePermit(
        string Rsid,
        string LocalSessionKey,
        string RegistrationDigest,
        string SafetyDecisionDigest,
        string GrantedCapabilitiesDigest,
        IReadOnlySet<string> OfferedCapabilities,
        IReadOnlySet<string> GrantedCapabilities,
        string ConnectionId,
        long ConnectionGeneration,
        long ExpiresAtMonotonicMilliseconds,
        int ObservationCount,
        string? WorkType,
        string? WorkCorrelationId,
        string? WorkImmutableDigest,
        string? CancelImmutableDigest);

    private sealed record HeartbeatFlight(
        RbpHeartbeatFence Fence,
        Task Deadline,
        TaskCompletionSource Observed,
        TaskCompletionSource Applied);

    private sealed record FailureTransition(
        RbpOpeningFailureClass Class,
        double ContinuousSteadyMilliseconds,
        double RetryAfterMilliseconds,
        RbpGatewayFailureKind? GatewayFailure = null,
        int? HttpStatus = null,
        int? CloseCode = null,
        RbpOpeningFailureContext? OpeningContext = null);

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
        private readonly Dictionary<string, CleanupReceivePermit>
            _cleanupReceivePermits = new(StringComparer.Ordinal);
        private readonly Queue<long> _cleanupDiscardObservations = new();
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
        private readonly List<Task> _invocations = new();
        private long _steadyStartedMilliseconds = -1;
        private Exception? _terminalFailure;
        private int _disposed;

        internal ConnectionCycleContext(
            RbpConnectionCoordinator owner,
            IRbpConnectionCycle cycle,
            long generation,
            IReadOnlyList<string> grantedConnectionCapabilities,
            CancellationToken serviceCancellationToken)
        {
            _owner = owner;
            Cycle = cycle;
            Generation = generation;
            GrantedConnectionCapabilities = grantedConnectionCapabilities ??
                throw new ArgumentNullException(nameof(grantedConnectionCapabilities));
            _cancellation =
                CancellationTokenSource.CreateLinkedTokenSource(
                    serviceCancellationToken);
            _token = _cancellation.Token;
        }

        internal IRbpConnectionCycle Cycle { get; }

        internal long Generation { get; }

        internal IReadOnlyList<string> GrantedConnectionCapabilities { get; }

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

        internal void AcknowledgeRegistrationDeferred(
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

        internal void InstallCleanupReceivePermit(
            RbpCleanupRegistrationReceipt receipt,
            long acknowledgedAtMonotonicMilliseconds)
        {
            ArgumentNullException.ThrowIfNull(receipt);
            if (!string.Equals(
                    receipt.Session.Rsid,
                    receipt.Tombstone.Rsid,
                    StringComparison.Ordinal) ||
                receipt.Tombstone.Reason !=
                    RbpSessionUnregisterReason.OperatorRequested ||
                receipt.Tombstone.Phase != RbpUnregisterPhase.Pending ||
                !RbpJournalSerialization.IsSha256Digest(
                    receipt.SafetyDecisionDigest))
            {
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "The durable cleanup-only registration receipt is not " +
                    "exact or pending.");
            }

            string capabilitiesDigest = Rfc8785Json.Sha256Digest(
                JsonSerializer.SerializeToElement(
                    receipt.Session.GrantedCapabilities));
            ValidateGrantedSessionCapabilities(
                receipt.Session.RegistrationPayload,
                receipt.Session.GrantedCapabilities);
            IReadOnlySet<string> offeredCapabilities =
                ReadCleanupPermitCapabilities(
                    receipt.Session.RegistrationPayload);
            IReadOnlySet<string> grantedCapabilities =
                new HashSet<string>(
                    receipt.Session.GrantedCapabilities,
                    StringComparer.Ordinal);
            long expiresAt = checked(
                acknowledgedAtMonotonicMilliseconds + 60_000);
            lock (_sync)
            {
                RemoveExpiredCleanupReceivePermits(
                    acknowledgedAtMonotonicMilliseconds);
                if (_sessions.ContainsKey(receipt.Session.Rsid))
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.SessionAuthorityConflict,
                        "A cleanup-only RBP session cannot overlap a bound route.");
                }

                if (!string.Equals(
                        _pendingRegistrationLocalKey,
                        receipt.Session.LocalSessionKey,
                        StringComparison.Ordinal) ||
                    _pendingRegistration is null ||
                    !_pendingRegistration.Response.Task.IsCompletedSuccessfully)
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.SessionAuthorityConflict,
                        "A cleanup receive permit requires the exact current " +
                        "registration acknowledgement.");
                }

                if (_cleanupReceivePermits.TryGetValue(
                        receipt.Session.Rsid,
                        out CleanupReceivePermit? existing))
                {
                    bool exact =
                        string.Equals(
                            existing.LocalSessionKey,
                            receipt.Session.LocalSessionKey,
                            StringComparison.Ordinal) &&
                        string.Equals(
                            existing.RegistrationDigest,
                            receipt.Session.RegistrationDigest,
                            StringComparison.Ordinal) &&
                        string.Equals(
                            existing.SafetyDecisionDigest,
                            receipt.SafetyDecisionDigest,
                            StringComparison.Ordinal) &&
                        string.Equals(
                            existing.GrantedCapabilitiesDigest,
                            capabilitiesDigest,
                            StringComparison.Ordinal) &&
                        existing.OfferedCapabilities.SetEquals(
                            offeredCapabilities) &&
                        existing.GrantedCapabilities.SetEquals(
                            grantedCapabilities) &&
                        string.Equals(
                            existing.ConnectionId,
                            Cycle.Acknowledgement.ConnectionId,
                            StringComparison.Ordinal) &&
                        existing.ConnectionGeneration == Generation;
                    if (!exact)
                    {
                        throw new RbpCoordinatorException(
                            RbpCoordinatorErrorCode.SessionAuthorityConflict,
                            "A conflicting cleanup receive permit already exists.");
                    }

                    return;
                }

                if (_cleanupReceivePermits.Count >= 128)
                {
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.SessionAuthorityConflict,
                        "The bounded cleanup receive permit inventory is full.");
                }

                _cleanupReceivePermits.Add(
                    receipt.Session.Rsid,
                    new CleanupReceivePermit(
                        receipt.Session.Rsid,
                        receipt.Session.LocalSessionKey,
                        receipt.Session.RegistrationDigest,
                        receipt.SafetyDecisionDigest,
                        capabilitiesDigest,
                        offeredCapabilities,
                        grantedCapabilities,
                        Cycle.Acknowledgement.ConnectionId,
                        Generation,
                        expiresAt,
                        ObservationCount: 0,
                        WorkType: null,
                        WorkCorrelationId: null,
                        WorkImmutableDigest: null,
                        CancelImmutableDigest: null));
            }
        }

        internal bool HasCleanupReceivePermit(
            string rsid,
            long observedAtMonotonicMilliseconds)
        {
            lock (_sync)
            {
                RemoveExpiredCleanupReceivePermits(
                    observedAtMonotonicMilliseconds);
                return _cleanupReceivePermits.ContainsKey(rsid);
            }
        }

        internal CleanupReceiveDisposition TryDiscardCleanupData(
            RbpDataEnvelopeSnapshot envelope,
            string immutableDigest,
            string correlationId,
            long observedAtMonotonicMilliseconds)
        {
            lock (_sync)
            {
                RemoveExpiredCleanupReceivePermits(
                    observedAtMonotonicMilliseconds);
                if (!_cleanupReceivePermits.TryGetValue(
                        envelope.Rsid,
                        out CleanupReceivePermit? permit))
                {
                    return CleanupReceiveDisposition.NotPermitted;
                }

                bool exactCycle =
                    string.Equals(
                        permit.ConnectionId,
                        Cycle.Acknowledgement.ConnectionId,
                        StringComparison.Ordinal) &&
                    permit.ConnectionGeneration == Generation;
                if (!exactCycle ||
                    observedAtMonotonicMilliseconds >=
                        permit.ExpiresAtMonotonicMilliseconds ||
                    (envelope.Acknowledgement is { } acknowledgement &&
                     acknowledgement != 0) ||
                    !CleanupEnvelopeMatchesPermit(envelope, permit))
                {
                    return CleanupReceiveDisposition.Conflict;
                }

                if (permit.ObservationCount >= 8 ||
                    !TryClaimCleanupDiscardObservation(
                        observedAtMonotonicMilliseconds))
                {
                    return CleanupReceiveDisposition.Conflict;
                }

                CleanupReceivePermit updated;
                if (envelope.Sequence == 1 &&
                    envelope.Type is "invoke" or "invoke_batch")
                {
                    if (permit.WorkImmutableDigest is null)
                    {
                        updated = permit with
                        {
                            ObservationCount = permit.ObservationCount + 1,
                            WorkType = envelope.Type,
                            WorkCorrelationId = correlationId,
                            WorkImmutableDigest = immutableDigest,
                        };
                    }
                    else if (
                        string.Equals(
                            permit.WorkType,
                            envelope.Type,
                            StringComparison.Ordinal) &&
                        string.Equals(
                            permit.WorkCorrelationId,
                            correlationId,
                            StringComparison.Ordinal) &&
                        string.Equals(
                            permit.WorkImmutableDigest,
                            immutableDigest,
                            StringComparison.Ordinal))
                    {
                        updated = permit with
                        {
                            ObservationCount = permit.ObservationCount + 1,
                        };
                    }
                    else
                    {
                        RollbackCleanupDiscardObservation();
                        return CleanupReceiveDisposition.Conflict;
                    }
                }
                else if (envelope.Sequence == 2 &&
                    string.Equals(
                        envelope.Type,
                        "cancel",
                        StringComparison.Ordinal) &&
                    permit.WorkImmutableDigest is not null &&
                    string.Equals(
                        permit.WorkCorrelationId,
                        correlationId,
                        StringComparison.Ordinal))
                {
                    if (permit.CancelImmutableDigest is null)
                    {
                        updated = permit with
                        {
                            ObservationCount = permit.ObservationCount + 1,
                            CancelImmutableDigest = immutableDigest,
                        };
                    }
                    else if (string.Equals(
                                 permit.CancelImmutableDigest,
                                 immutableDigest,
                                 StringComparison.Ordinal))
                    {
                        updated = permit with
                        {
                            ObservationCount = permit.ObservationCount + 1,
                        };
                    }
                    else
                    {
                        RollbackCleanupDiscardObservation();
                        return CleanupReceiveDisposition.Conflict;
                    }
                }
                else
                {
                    RollbackCleanupDiscardObservation();
                    return CleanupReceiveDisposition.Conflict;
                }

                _cleanupReceivePermits[envelope.Rsid] = updated;
                return CleanupReceiveDisposition.Discarded;
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
                _ = _cleanupReceivePermits.Remove(rsid);
            }
        }

        private void RemoveExpiredCleanupReceivePermits(long now)
        {
            string[] expired = _cleanupReceivePermits
                .Where(item =>
                    now >= item.Value.ExpiresAtMonotonicMilliseconds)
                .Select(item => item.Key)
                .ToArray();
            foreach (string rsid in expired)
            {
                _ = _cleanupReceivePermits.Remove(rsid);
            }
        }

        private static IReadOnlySet<string> ReadCleanupPermitCapabilities(
            JsonElement registrationPayload)
        {
            JsonElement values = registrationPayload.GetProperty(
                "session_capabilities");
            return new HashSet<string>(
                values.EnumerateArray().Select(value => value.GetString()!),
                StringComparer.Ordinal);
        }

        private static bool CleanupEnvelopeMatchesPermit(
            RbpDataEnvelopeSnapshot envelope,
            CleanupReceivePermit permit)
        {
            if (!string.Equals(
                    envelope.Type,
                    "invoke_batch",
                    StringComparison.Ordinal))
            {
                return true;
            }

            RbpBatchRequest request =
                RbpBatchRequest.Parse(envelope.Rsid, envelope.Payload);
            if (!permit.OfferedCapabilities.Contains(
                    RbpBatchCapability.BatchAtomicCapability) ||
                (request.Atomic &&
                 !permit.GrantedCapabilities.Contains(
                     RbpBatchCapability.BatchAtomicCapability)))
            {
                return false;
            }

            return request.Steps.All(step =>
                AddinBatchContract.TryGetDescriptor(step.Method, out _));
        }

        private bool TryClaimCleanupDiscardObservation(long now)
        {
            long windowStart = now - 60_000;
            while (_cleanupDiscardObservations.TryPeek(out long observed) &&
                   observed <= windowStart)
            {
                _ = _cleanupDiscardObservations.Dequeue();
            }

            if (_cleanupDiscardObservations.Count >= 32)
            {
                return false;
            }

            _cleanupDiscardObservations.Enqueue(now);
            return true;
        }

        private void RollbackCleanupDiscardObservation()
        {
            if (_cleanupDiscardObservations.Count == 0)
            {
                return;
            }

            long[] retained = _cleanupDiscardObservations.ToArray();
            _cleanupDiscardObservations.Clear();
            for (int index = 0; index < retained.Length - 1; index++)
            {
                _cleanupDiscardObservations.Enqueue(retained[index]);
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

        /// <summary>
        /// Serializes queue-then-send for data envelopes on this cycle.
        /// </summary>
        /// <remarks>
        /// Outbound sequence numbers are allocated inside the journal's write
        /// gate, which is released before the frame reaches the socket. Two
        /// concurrent senders could therefore take seq N and N+1 and write them
        /// in the opposite order. The heartbeat path sends control envelopes
        /// and never takes this gate, so it cannot be starved and there is no
        /// lock inversion: the order is always this gate, then the journal's.
        /// </remarks>
        internal SemaphoreSlim OutboundGate { get; } = new(1, 1);

        /// <summary>
        /// Claims the Section 10.1 window and starts the invocation task.
        /// </summary>
        /// <remarks>
        /// The claim is taken here, synchronously on the receive loop, so the
        /// invoke that arrived <em>second</em> is the one rejected. Claiming
        /// inside the task would make that a scheduling accident.
        /// </remarks>
        internal void StartInvocation(RbpDataEnvelopeSnapshot envelope)
        {
            IRbpInvocationClaim? claim =
                _owner._invocationDispatcher.TryClaim(envelope.Rsid);
            _owner.InvocationStarted();
            lock (_sync)
            {
                _invocations.RemoveAll(task => task.IsCompleted);
                _invocations.Add(
                    claim is null
                        ? _owner.RunConcurrentRejectionAsync(this, envelope)
                        : _owner.RunInvocationAsync(this, claim, envelope));
            }
        }

        /// <summary>
        /// Claims the same Section 10.1 window an invoke claims — one in-flight
        /// dispatch per session regardless of carrier — and runs the batch as a
        /// detached, cycle-scoped task.
        /// </summary>
        internal void StartBatch(RbpDataEnvelopeSnapshot envelope)
        {
            IRbpInvocationClaim? claim =
                _owner._invocationDispatcher.TryClaim(envelope.Rsid);
            _owner.InvocationStarted();
            lock (_sync)
            {
                _invocations.RemoveAll(task => task.IsCompleted);
                _invocations.Add(
                    claim is null
                        ? _owner.RunBatchConcurrentRejectionAsync(this, envelope)
                        : _owner.RunBatchAsync(this, claim, envelope));
            }
        }

        internal void CompleteInvocation() => _owner.InvocationCompleted();

        /// <summary>
        /// Waits for in-flight invocations to reach a durable decision, within
        /// a budget.
        /// </summary>
        /// <remarks>
        /// Deliberately separate from <see cref="AwaitOwnedTasksAsync"/>: a
        /// false return there poisons connection authority and requires a
        /// process restart, which is the right answer for a handler that will
        /// not drain but the wrong answer for an add-in call that simply has
        /// not finished. Expiring here is not loss — the terminal outcome is
        /// persisted before the dispatcher returns, so a redelivery replays it
        /// under Section 12.2 rule 1.
        /// </remarks>
        internal async Task<bool> DrainInvocationsAsync(TimeSpan budget)
        {
            Task[] pending;
            lock (_sync)
            {
                pending = _invocations
                    .Where(task => !task.IsCompleted)
                    .ToArray();
            }

            if (pending.Length == 0)
            {
                return true;
            }

            Task all = Task.WhenAll(pending);
            Task finished = await Task
                .WhenAny(all, Task.Delay(budget))
                .ConfigureAwait(false);
            if (!ReferenceEquals(finished, all))
            {
                ObserveLateFault(all);
                return false;
            }

            return true;
        }

        /// <summary>
        /// Keeps a straggler's fault from surfacing as an unobserved task
        /// exception once it eventually completes.
        /// </summary>
        private static void ObserveLateFault(Task task) =>
            _ = task.ContinueWith(
                completed => _ = completed.Exception,
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted |
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);

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
                    OutboundGate.Dispose();
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
