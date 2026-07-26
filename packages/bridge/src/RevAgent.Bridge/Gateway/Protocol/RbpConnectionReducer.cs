using System.Collections.ObjectModel;

namespace RevAgent.Bridge.Gateway.Protocol;

internal enum RbpConnectionPhase
{
    Idle,
    Connecting,
    Authenticating,
    HelloExchange,
    Steady,
    Degraded,
    Resuming,
    ReEnrolling,
    Backoff,
    Disconnected,
    RetryPaused,
    Shutdown,
}

internal enum RbpRetryPauseReason
{
    Auth,
    VersionUpdate,
    Trust,
    AuthRevoked,
}

internal enum RbpRetryAction
{
    Backoff,
    Pause,
    Stop,
}

internal sealed record RbpRetryDecision(
    RbpRetryAction Action,
    long? WaitAttemptIndex,
    int? JitterLimitMilliseconds,
    double RetryAfterFloorMilliseconds,
    bool ResetApplied,
    RbpRetryPauseReason? PauseReason);

internal sealed record RbpConnectionLifecycleState(
    RbpConnectionPhase Phase,
    long NextAttemptIndex,
    long? SelectedProtocol,
    IReadOnlyList<string> GrantedCapabilities,
    RbpRetryPauseReason? RetryPauseReason,
    RbpRetryDecision? LastRetryDecision);

internal enum RbpOpeningFailureClass
{
    Environment,
    Protocol,
    Auth,
    Version,
    Trust,
}

internal enum RbpGoodbyeReason
{
    Shutdown,
    Update,
    ServerDraining,
    ProtocolError,
    AuthRevoked,
}

internal enum RbpConnectionEventType
{
    Start,
    TransportOpened,
    AuthenticationAccepted,
    HelloAccepted,
    BeginResume,
    ResumeComplete,
    BeginReEnrollment,
    ReEnrollmentComplete,
    HeartbeatSilence,
    ConnectionFailed,
    RetryTimerElapsed,
    RetryConditionChanged,
    Goodbye,
    ShutdownRequested,
    ServiceStarted,
}

internal sealed record RbpConnectionEvent(
    RbpConnectionEventType Type,
    long? SelectedProtocol = null,
    IReadOnlyList<string>? GrantedCapabilities = null,
    double? SilenceMilliseconds = null,
    double? ContinuousSteadyMilliseconds = null,
    double? RetryAfterMilliseconds = null,
    RbpOpeningFailureClass? Failure = null,
    RbpGoodbyeReason? GoodbyeReason = null);

internal enum RbpTransitionKind
{
    Transitioned,
    InvalidTransition,
}

internal sealed record RbpConnectionTransition(
    RbpTransitionKind Kind,
    RbpConnectionLifecycleState State,
    RbpConnectionEventType? InvalidEvent = null);

internal enum RbpSessionPhase
{
    Discovered,
    Registering,
    Registered,
    Disconnected,
    Resuming,
    ReEnrolling,
    Unregistered,
}

internal enum RbpSessionUnregisterReason
{
    RevitExited,
    BridgeShutdown,
    SessionReplaced,
    OperatorRequested,
}

internal sealed record RbpSessionLifecycleState(
    string LocalSessionKey,
    string? Rsid,
    RbpSessionPhase Phase,
    bool ResumeAllowed,
    bool DispatchAllowed,
    RbpSessionUnregisterReason? UnregisterReason);

internal enum RbpSessionEventType
{
    RegisterRequested,
    Registered,
    ConnectionLost,
    ResumeRequested,
    Resumed,
    ResumeRejected,
    ReEnrolled,
    Unregister,
}

internal sealed record RbpSessionEvent(
    RbpSessionEventType Type,
    string? Rsid = null,
    RbpSessionUnregisterReason? UnregisterReason = null);

internal sealed record RbpSessionTransition(
    RbpTransitionKind Kind,
    RbpSessionLifecycleState State,
    RbpSessionEventType? InvalidEvent = null);

internal static class RbpConnectionReducer
{
    internal const int HeartbeatDegradedAfterMilliseconds = 35_000;
    internal const int HeartbeatDisconnectedAfterMilliseconds = 65_000;

    internal static RbpConnectionLifecycleState CreateConnectionLifecycle()
    {
        return new RbpConnectionLifecycleState(
            RbpConnectionPhase.Idle,
            NextAttemptIndex: 0,
            SelectedProtocol: null,
            Empty<string>(),
            RetryPauseReason: null,
            LastRetryDecision: null);
    }

    internal static RbpConnectionTransition TransitionConnection(
        RbpConnectionLifecycleState state,
        RbpConnectionEvent connectionEvent)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(connectionEvent);

        switch (connectionEvent.Type)
        {
            case RbpConnectionEventType.Start:
                return state.Phase is RbpConnectionPhase.Idle or
                    RbpConnectionPhase.Disconnected
                    ? Transitioned(state with
                    {
                        Phase = RbpConnectionPhase.Connecting,
                    })
                    : Invalid(state, connectionEvent);
            case RbpConnectionEventType.TransportOpened:
                return state.Phase == RbpConnectionPhase.Connecting
                    ? Transitioned(state with
                    {
                        Phase = RbpConnectionPhase.Authenticating,
                    })
                    : Invalid(state, connectionEvent);
            case RbpConnectionEventType.AuthenticationAccepted:
                return state.Phase == RbpConnectionPhase.Authenticating
                    ? Transitioned(state with
                    {
                        Phase = RbpConnectionPhase.HelloExchange,
                    })
                    : Invalid(state, connectionEvent);
            case RbpConnectionEventType.HelloAccepted:
                return AcceptHello(state, connectionEvent);
            case RbpConnectionEventType.BeginResume:
                return state.Phase is RbpConnectionPhase.Steady or
                    RbpConnectionPhase.Degraded
                    ? Transitioned(state with
                    {
                        Phase = RbpConnectionPhase.Resuming,
                    })
                    : Invalid(state, connectionEvent);
            case RbpConnectionEventType.ResumeComplete:
                return state.Phase == RbpConnectionPhase.Resuming
                    ? Transitioned(state with
                    {
                        Phase = RbpConnectionPhase.Steady,
                    })
                    : Invalid(state, connectionEvent);
            case RbpConnectionEventType.BeginReEnrollment:
                return state.Phase is RbpConnectionPhase.Resuming or
                    RbpConnectionPhase.Steady or RbpConnectionPhase.Degraded
                    ? Transitioned(state with
                    {
                        Phase = RbpConnectionPhase.ReEnrolling,
                    })
                    : Invalid(state, connectionEvent);
            case RbpConnectionEventType.ReEnrollmentComplete:
                return state.Phase == RbpConnectionPhase.ReEnrolling
                    ? Transitioned(state with
                    {
                        Phase = RbpConnectionPhase.Steady,
                    })
                    : Invalid(state, connectionEvent);
            case RbpConnectionEventType.HeartbeatSilence:
                return ApplyHeartbeatSilence(state, connectionEvent);
            case RbpConnectionEventType.ConnectionFailed:
                return ApplyConnectionFailure(state, connectionEvent);
            case RbpConnectionEventType.RetryTimerElapsed:
                return state.Phase == RbpConnectionPhase.Backoff
                    ? Transitioned(state with
                    {
                        Phase = RbpConnectionPhase.Connecting,
                    })
                    : Invalid(state, connectionEvent);
            case RbpConnectionEventType.RetryConditionChanged:
                return state.Phase == RbpConnectionPhase.RetryPaused
                    ? Transitioned(state with
                    {
                        Phase = RbpConnectionPhase.Idle,
                        RetryPauseReason = null,
                        LastRetryDecision = null,
                    })
                    : Invalid(state, connectionEvent);
            case RbpConnectionEventType.Goodbye:
                return ApplyGoodbye(state, connectionEvent);
            case RbpConnectionEventType.ShutdownRequested:
                return Transitioned(Stop(state));
            case RbpConnectionEventType.ServiceStarted:
                return state.Phase == RbpConnectionPhase.Shutdown
                    ? Transitioned(state with
                    {
                        Phase = RbpConnectionPhase.Idle,
                        RetryPauseReason = null,
                        LastRetryDecision = null,
                    })
                    : Invalid(state, connectionEvent);
            default:
                throw new ArgumentOutOfRangeException(
                    nameof(connectionEvent),
                    connectionEvent.Type,
                    "Unknown connection event.");
        }
    }

    internal static RbpSessionLifecycleState CreateSessionLifecycle(
        string localSessionKey)
    {
        if (string.IsNullOrEmpty(localSessionKey))
        {
            throw new ArgumentException(
                "Local session key must not be empty.",
                nameof(localSessionKey));
        }

        return new RbpSessionLifecycleState(
            localSessionKey,
            Rsid: null,
            RbpSessionPhase.Discovered,
            ResumeAllowed: false,
            DispatchAllowed: false,
            UnregisterReason: null);
    }

    internal static RbpSessionTransition TransitionSession(
        RbpSessionLifecycleState state,
        RbpSessionEvent sessionEvent)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(sessionEvent);

        if (sessionEvent.Type == RbpSessionEventType.Unregister)
        {
            if (sessionEvent.UnregisterReason is not { } reason ||
                !Enum.IsDefined(typeof(RbpSessionUnregisterReason), reason))
            {
                return InvalidSession(state, sessionEvent);
            }

            if (state.Phase == RbpSessionPhase.Unregistered)
            {
                return state.UnregisterReason == reason
                    ? TransitionedSession(state)
                    : InvalidSession(state, sessionEvent);
            }

            return TransitionedSession(state with
            {
                Phase = RbpSessionPhase.Unregistered,
                ResumeAllowed = false,
                DispatchAllowed = false,
                UnregisterReason = reason,
            });
        }

        switch (sessionEvent.Type)
        {
            case RbpSessionEventType.RegisterRequested:
                return state.Phase is RbpSessionPhase.Discovered or
                    RbpSessionPhase.ReEnrolling
                    ? TransitionedSession(state with
                    {
                        Phase = RbpSessionPhase.Registering,
                        DispatchAllowed = false,
                    })
                    : InvalidSession(state, sessionEvent);
            case RbpSessionEventType.Registered:
                return state.Phase == RbpSessionPhase.Registering &&
                       !string.IsNullOrEmpty(sessionEvent.Rsid)
                    ? TransitionedSession(state with
                    {
                        Rsid = sessionEvent.Rsid,
                        Phase = RbpSessionPhase.Registered,
                        ResumeAllowed = true,
                        DispatchAllowed = true,
                        UnregisterReason = null,
                    })
                    : InvalidSession(state, sessionEvent);
            case RbpSessionEventType.ConnectionLost:
                return state.Phase switch
                {
                    RbpSessionPhase.Registering =>
                        TransitionedSession(state with
                        {
                            Rsid = null,
                            Phase = RbpSessionPhase.Discovered,
                            ResumeAllowed = false,
                            DispatchAllowed = false,
                        }),
                    RbpSessionPhase.Registered or
                        RbpSessionPhase.Resuming =>
                        TransitionedSession(state with
                        {
                            Phase = RbpSessionPhase.Disconnected,
                            DispatchAllowed = false,
                        }),
                    RbpSessionPhase.Disconnected or
                        RbpSessionPhase.ReEnrolling =>
                        TransitionedSession(state),
                    _ => InvalidSession(state, sessionEvent),
                };
            case RbpSessionEventType.ResumeRequested:
                return state.Phase == RbpSessionPhase.Disconnected &&
                       state.ResumeAllowed
                    ? TransitionedSession(state with
                    {
                        Phase = RbpSessionPhase.Resuming,
                        DispatchAllowed = false,
                    })
                    : InvalidSession(state, sessionEvent);
            case RbpSessionEventType.Resumed:
                return state.Phase == RbpSessionPhase.Resuming &&
                       state.ResumeAllowed &&
                       !string.IsNullOrEmpty(state.Rsid) &&
                       string.Equals(
                           state.Rsid,
                           sessionEvent.Rsid,
                           StringComparison.Ordinal)
                    ? TransitionedSession(state with
                    {
                        Phase = RbpSessionPhase.Registered,
                        DispatchAllowed = true,
                    })
                    : InvalidSession(state, sessionEvent);
            case RbpSessionEventType.ResumeRejected:
                return state.Phase == RbpSessionPhase.Resuming
                    ? TransitionedSession(state with
                    {
                        Rsid = null,
                        Phase = RbpSessionPhase.ReEnrolling,
                        ResumeAllowed = false,
                        DispatchAllowed = false,
                    })
                    : InvalidSession(state, sessionEvent);
            case RbpSessionEventType.ReEnrolled:
                return state.Phase == RbpSessionPhase.ReEnrolling &&
                       !string.IsNullOrEmpty(sessionEvent.Rsid)
                    ? TransitionedSession(state with
                    {
                        Rsid = sessionEvent.Rsid,
                        Phase = RbpSessionPhase.Registered,
                        ResumeAllowed = true,
                        DispatchAllowed = true,
                    })
                    : InvalidSession(state, sessionEvent);
            default:
                return InvalidSession(state, sessionEvent);
        }
    }

    private static RbpConnectionTransition AcceptHello(
        RbpConnectionLifecycleState state,
        RbpConnectionEvent connectionEvent)
    {
        IReadOnlyList<string>? grantedCapabilities =
            connectionEvent.GrantedCapabilities;
        if (state.Phase != RbpConnectionPhase.HelloExchange ||
            connectionEvent.SelectedProtocol is not { } selectedProtocol ||
            selectedProtocol is < 1 or > RbpProtocolLimits.MaximumSafeInteger ||
            grantedCapabilities is null)
        {
            return Invalid(state, connectionEvent);
        }

        IReadOnlyList<string> capabilities = Freeze(
            grantedCapabilities
                .Distinct(StringComparer.Ordinal)
                .OrderBy(value => value, StringComparer.Ordinal));
        return Transitioned(state with
        {
            Phase = RbpConnectionPhase.Steady,
            SelectedProtocol = selectedProtocol,
            GrantedCapabilities = capabilities,
            RetryPauseReason = null,
        });
    }

    private static RbpConnectionTransition ApplyHeartbeatSilence(
        RbpConnectionLifecycleState state,
        RbpConnectionEvent connectionEvent)
    {
        if (state.Phase is not (
                RbpConnectionPhase.Steady or RbpConnectionPhase.Degraded) ||
            connectionEvent.SilenceMilliseconds is not { } silence ||
            !RbpReconnectBackoff.IsNonNegativeFinite(silence))
        {
            return Invalid(state, connectionEvent);
        }

        if (silence >= HeartbeatDisconnectedAfterMilliseconds)
        {
            return Transitioned(
                ScheduleBackoff(
                    state,
                    connectionEvent.ContinuousSteadyMilliseconds ?? 0));
        }

        return Transitioned(state with
        {
            Phase = silence >= HeartbeatDegradedAfterMilliseconds
                ? RbpConnectionPhase.Degraded
                : RbpConnectionPhase.Steady,
        });
    }

    private static RbpConnectionTransition ApplyConnectionFailure(
        RbpConnectionLifecycleState state,
        RbpConnectionEvent connectionEvent)
    {
        if (state.Phase is RbpConnectionPhase.Idle or
                RbpConnectionPhase.Backoff or
                RbpConnectionPhase.RetryPaused or
                RbpConnectionPhase.Shutdown ||
            connectionEvent.Failure is not { } failure)
        {
            return Invalid(state, connectionEvent);
        }

        return failure switch
        {
            RbpOpeningFailureClass.Auth =>
                Transitioned(PauseRetry(state, RbpRetryPauseReason.Auth)),
            RbpOpeningFailureClass.Version =>
                Transitioned(
                    PauseRetry(state, RbpRetryPauseReason.VersionUpdate)),
            RbpOpeningFailureClass.Trust =>
                Transitioned(PauseRetry(state, RbpRetryPauseReason.Trust)),
            RbpOpeningFailureClass.Environment or
                RbpOpeningFailureClass.Protocol =>
                Transitioned(
                    ScheduleBackoff(
                        state,
                        connectionEvent.ContinuousSteadyMilliseconds ?? 0,
                        connectionEvent.RetryAfterMilliseconds ?? 0)),
            _ => Invalid(state, connectionEvent),
        };
    }

    private static RbpConnectionTransition ApplyGoodbye(
        RbpConnectionLifecycleState state,
        RbpConnectionEvent connectionEvent)
    {
        if (state.Phase is not (
                RbpConnectionPhase.Steady or
                RbpConnectionPhase.Degraded or
                RbpConnectionPhase.Resuming or
                RbpConnectionPhase.ReEnrolling) ||
            connectionEvent.GoodbyeReason is not { } reason ||
            !Enum.IsDefined(typeof(RbpGoodbyeReason), reason))
        {
            return Invalid(state, connectionEvent);
        }

        return reason switch
        {
            RbpGoodbyeReason.Shutdown => Transitioned(Stop(state)),
            RbpGoodbyeReason.AuthRevoked =>
                Transitioned(
                    PauseRetry(state, RbpRetryPauseReason.AuthRevoked)),
            RbpGoodbyeReason.Update or
                RbpGoodbyeReason.ServerDraining or
                RbpGoodbyeReason.ProtocolError => Transitioned(
                ScheduleBackoff(
                    state,
                    connectionEvent.ContinuousSteadyMilliseconds ?? 0,
                    connectionEvent.RetryAfterMilliseconds ?? 0)),
            _ => Invalid(state, connectionEvent),
        };
    }

    private static RbpConnectionLifecycleState ScheduleBackoff(
        RbpConnectionLifecycleState state,
        double continuousSteadyMilliseconds = 0,
        double retryAfterMilliseconds = 0)
    {
        if (!RbpReconnectBackoff.IsNonNegativeFinite(
                continuousSteadyMilliseconds) ||
            !RbpReconnectBackoff.IsNonNegativeFinite(retryAfterMilliseconds))
        {
            throw new ArgumentOutOfRangeException(
                nameof(continuousSteadyMilliseconds),
                "Retry timing inputs must be non-negative and finite.");
        }

        bool resetApplied = RbpReconnectBackoff.ShouldReset(
            continuousSteadyMilliseconds);
        long waitAttemptIndex =
            resetApplied ? 0 : state.NextAttemptIndex;
        var decision = new RbpRetryDecision(
            RbpRetryAction.Backoff,
            waitAttemptIndex,
            RbpReconnectBackoff.LimitMilliseconds(waitAttemptIndex),
            retryAfterMilliseconds,
            resetApplied,
            PauseReason: null);
        return state with
        {
            Phase = RbpConnectionPhase.Backoff,
            NextAttemptIndex = Math.Min(
                waitAttemptIndex + 1,
                RbpProtocolLimits.MaximumSafeInteger),
            RetryPauseReason = null,
            LastRetryDecision = decision,
        };
    }

    private static RbpConnectionLifecycleState PauseRetry(
        RbpConnectionLifecycleState state,
        RbpRetryPauseReason reason)
    {
        return state with
        {
            Phase = RbpConnectionPhase.RetryPaused,
            RetryPauseReason = reason,
            LastRetryDecision = new RbpRetryDecision(
                RbpRetryAction.Pause,
                WaitAttemptIndex: null,
                JitterLimitMilliseconds: null,
                RetryAfterFloorMilliseconds: 0,
                ResetApplied: false,
                PauseReason: reason),
        };
    }

    private static RbpConnectionLifecycleState Stop(
        RbpConnectionLifecycleState state)
    {
        return state with
        {
            Phase = RbpConnectionPhase.Shutdown,
            LastRetryDecision = new RbpRetryDecision(
                RbpRetryAction.Stop,
                WaitAttemptIndex: null,
                JitterLimitMilliseconds: null,
                RetryAfterFloorMilliseconds: 0,
                ResetApplied: false,
                PauseReason: null),
        };
    }

    private static RbpConnectionTransition Transitioned(
        RbpConnectionLifecycleState state)
    {
        return new RbpConnectionTransition(
            RbpTransitionKind.Transitioned,
            state);
    }

    private static RbpConnectionTransition Invalid(
        RbpConnectionLifecycleState state,
        RbpConnectionEvent connectionEvent)
    {
        return new RbpConnectionTransition(
            RbpTransitionKind.InvalidTransition,
            state,
            connectionEvent.Type);
    }

    private static RbpSessionTransition TransitionedSession(
        RbpSessionLifecycleState state)
    {
        return new RbpSessionTransition(
            RbpTransitionKind.Transitioned,
            state);
    }

    private static RbpSessionTransition InvalidSession(
        RbpSessionLifecycleState state,
        RbpSessionEvent sessionEvent)
    {
        return new RbpSessionTransition(
            RbpTransitionKind.InvalidTransition,
            state,
            sessionEvent.Type);
    }

    private static IReadOnlyList<T> Empty<T>()
    {
        return Array.AsReadOnly(Array.Empty<T>());
    }

    private static IReadOnlyList<T> Freeze<T>(IEnumerable<T> source)
    {
        return new ReadOnlyCollection<T>(source.ToArray());
    }
}
