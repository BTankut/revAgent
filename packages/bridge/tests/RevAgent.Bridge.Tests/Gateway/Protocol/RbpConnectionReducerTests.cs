using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Protocol;

public sealed class RbpConnectionReducerTests
{
    [Fact]
    public void TransportAuthAndHelloNegotiationAreRequiredBeforeSteady()
    {
        RbpConnectionLifecycleState steady = OpenSteady();

        Assert.Equal(RbpConnectionPhase.Steady, steady.Phase);
        Assert.Equal(1, steady.SelectedProtocol);
        Assert.Equal(
            new[] { "chunked_results", "journal_v1" },
            steady.GrantedCapabilities);
        Assert.Equal(
            RbpTransitionKind.InvalidTransition,
            RbpConnectionReducer.TransitionConnection(
                    RbpConnectionReducer.CreateConnectionLifecycle(),
                    Event(
                        RbpConnectionEventType.AuthenticationAccepted))
                .Kind);
    }

    [Fact]
    public void PositiveNegotiatedProtocolIsRetainedWithoutHardCodingV1()
    {
        RbpConnectionLifecycleState state =
            RbpConnectionReducer.CreateConnectionLifecycle();
        state = Apply(state, Event(RbpConnectionEventType.Start));
        state = Apply(
            state,
            Event(RbpConnectionEventType.TransportOpened));
        state = Apply(
            state,
            Event(RbpConnectionEventType.AuthenticationAccepted));
        RbpConnectionLifecycleState accepted = Apply(
            state,
            new RbpConnectionEvent(
                RbpConnectionEventType.HelloAccepted,
                SelectedProtocol: 2,
                GrantedCapabilities: Array.Empty<string>()));

        Assert.Equal(RbpConnectionPhase.Steady, accepted.Phase);
        Assert.Equal(2, accepted.SelectedProtocol);
        Assert.Equal(
            RbpTransitionKind.InvalidTransition,
            RbpConnectionReducer.TransitionConnection(
                    state,
                    new RbpConnectionEvent(
                        RbpConnectionEventType.HelloAccepted,
                        SelectedProtocol: 0,
                        GrantedCapabilities: Array.Empty<string>()))
                .Kind);
    }

    [Fact]
    public void HeartbeatThresholdsMatchTheFrozenProtocol()
    {
        RbpConnectionLifecycleState steady = OpenSteady();
        Assert.Equal(
            RbpConnectionPhase.Steady,
            Apply(
                    steady,
                    new RbpConnectionEvent(
                        RbpConnectionEventType.HeartbeatSilence,
                        SilenceMilliseconds:
                            RbpConnectionReducer
                                .HeartbeatDegradedAfterMilliseconds -
                            1))
                .Phase);
        Assert.Equal(
            RbpConnectionPhase.Degraded,
            Apply(
                    steady,
                    new RbpConnectionEvent(
                        RbpConnectionEventType.HeartbeatSilence,
                        SilenceMilliseconds:
                            RbpConnectionReducer
                                .HeartbeatDegradedAfterMilliseconds))
                .Phase);

        RbpConnectionLifecycleState disconnected = Apply(
            steady,
            new RbpConnectionEvent(
                RbpConnectionEventType.HeartbeatSilence,
                SilenceMilliseconds:
                    RbpConnectionReducer
                        .HeartbeatDisconnectedAfterMilliseconds));
        Assert.Equal(RbpConnectionPhase.Backoff, disconnected.Phase);
        Assert.Equal(1, disconnected.NextAttemptIndex);
        Assert.Equal(
            RbpRetryAction.Backoff,
            disconnected.LastRetryDecision?.Action);
        Assert.Equal(
            0,
            disconnected.LastRetryDecision?.WaitAttemptIndex);
        Assert.Equal(
            1_000,
            disconnected.LastRetryDecision?.JitterLimitMilliseconds);
    }

    [Fact]
    public void RetryAttemptsAreZeroBasedAndResetOnlyAfter120SecondsSteady()
    {
        RbpConnectionLifecycleState state = Apply(
            OpenSteady(),
            new RbpConnectionEvent(
                RbpConnectionEventType.ConnectionFailed,
                ContinuousSteadyMilliseconds: 119_999,
                Failure: RbpOpeningFailureClass.Environment));
        Assert.Equal(0, state.LastRetryDecision?.WaitAttemptIndex);
        Assert.Equal(1_000, state.LastRetryDecision?.JitterLimitMilliseconds);
        Assert.False(state.LastRetryDecision!.ResetApplied);

        state = Apply(
            state,
            Event(RbpConnectionEventType.RetryTimerElapsed));
        state = Apply(
            state,
            new RbpConnectionEvent(
                RbpConnectionEventType.ConnectionFailed,
                ContinuousSteadyMilliseconds: 0,
                Failure: RbpOpeningFailureClass.Protocol));
        Assert.Equal(1, state.LastRetryDecision?.WaitAttemptIndex);
        Assert.Equal(2_000, state.LastRetryDecision?.JitterLimitMilliseconds);

        state = Apply(
            state,
            Event(RbpConnectionEventType.RetryTimerElapsed));
        state = Apply(
            state,
            new RbpConnectionEvent(
                RbpConnectionEventType.ConnectionFailed,
                ContinuousSteadyMilliseconds: 120_000,
                RetryAfterMilliseconds: 30_000,
                Failure: RbpOpeningFailureClass.Environment));
        Assert.Equal(0, state.LastRetryDecision?.WaitAttemptIndex);
        Assert.Equal(1_000, state.LastRetryDecision?.JitterLimitMilliseconds);
        Assert.Equal(
            30_000,
            state.LastRetryDecision?.RetryAfterFloorMilliseconds);
        Assert.True(state.LastRetryDecision!.ResetApplied);
    }

    [Theory]
    [InlineData(
        (int)RbpOpeningFailureClass.Auth,
        (int)RbpRetryPauseReason.Auth)]
    [InlineData(
        (int)RbpOpeningFailureClass.Version,
        (int)RbpRetryPauseReason.VersionUpdate)]
    [InlineData(
        (int)RbpOpeningFailureClass.Trust,
        (int)RbpRetryPauseReason.Trust)]
    public void AuthVersionAndTrustRefusalsPauseAutomaticRetry(
        int failureValue,
        int reasonValue)
    {
        var failure = (RbpOpeningFailureClass)failureValue;
        var reason = (RbpRetryPauseReason)reasonValue;
        RbpConnectionLifecycleState paused = Apply(
            OpenSteady(),
            new RbpConnectionEvent(
                RbpConnectionEventType.ConnectionFailed,
                Failure: failure));

        Assert.Equal(RbpConnectionPhase.RetryPaused, paused.Phase);
        Assert.Equal(reason, paused.RetryPauseReason);
        Assert.Equal(0, paused.NextAttemptIndex);

        RbpConnectionLifecycleState resumed = Apply(
            paused,
            Event(RbpConnectionEventType.RetryConditionChanged));
        Assert.Equal(RbpConnectionPhase.Idle, resumed.Phase);
        Assert.Null(resumed.RetryPauseReason);
    }

    [Fact]
    public void RetryIndexSurvivesPauseAndServiceRestart()
    {
        RbpConnectionLifecycleState state = Apply(
            OpenSteady(),
            new RbpConnectionEvent(
                RbpConnectionEventType.ConnectionFailed,
                Failure: RbpOpeningFailureClass.Environment));
        state = Apply(
            state,
            Event(RbpConnectionEventType.RetryTimerElapsed));
        RbpConnectionLifecycleState paused = Apply(
            state,
            new RbpConnectionEvent(
                RbpConnectionEventType.ConnectionFailed,
                Failure: RbpOpeningFailureClass.Trust));
        Assert.Equal(1, paused.NextAttemptIndex);

        state = Apply(
            paused,
            Event(RbpConnectionEventType.RetryConditionChanged));
        state = Apply(state, Event(RbpConnectionEventType.Start));
        state = Apply(
            state,
            Event(RbpConnectionEventType.TransportOpened));
        state = Apply(
            state,
            Event(RbpConnectionEventType.AuthenticationAccepted));
        state = Apply(
            state,
            new RbpConnectionEvent(
                RbpConnectionEventType.HelloAccepted,
                SelectedProtocol: 1,
                GrantedCapabilities: Array.Empty<string>()));
        state = Apply(
            state,
            Event(RbpConnectionEventType.ShutdownRequested));
        state = Apply(
            state,
            Event(RbpConnectionEventType.ServiceStarted));

        Assert.Equal(RbpConnectionPhase.Idle, state.Phase);
        Assert.Equal(1, state.NextAttemptIndex);
        Assert.Equal(
            1,
            Apply(state, Event(RbpConnectionEventType.Start))
                .NextAttemptIndex);
    }

    [Fact]
    public void ResumeReEnrollmentAndShutdownTransitionsAreExplicit()
    {
        RbpConnectionLifecycleState connection = Apply(
            OpenSteady(),
            Event(RbpConnectionEventType.BeginResume));
        connection = Apply(
            connection,
            Event(RbpConnectionEventType.BeginReEnrollment));
        connection = Apply(
            connection,
            Event(RbpConnectionEventType.ReEnrollmentComplete));
        Assert.Equal(RbpConnectionPhase.Steady, connection.Phase);
        connection = Apply(
            connection,
            new RbpConnectionEvent(
                RbpConnectionEventType.Goodbye,
                GoodbyeReason: RbpGoodbyeReason.Shutdown));
        Assert.Equal(RbpConnectionPhase.Shutdown, connection.Phase);
        Assert.Equal(
            RbpRetryAction.Stop,
            connection.LastRetryDecision?.Action);
        Assert.Equal(
            RbpConnectionPhase.Idle,
            Apply(
                    connection,
                    Event(RbpConnectionEventType.ServiceStarted))
                .Phase);
    }

    [Fact]
    public void UndefinedGoodbyeReasonIsRejected()
    {
        RbpConnectionLifecycleState state = OpenSteady();
        RbpConnectionTransition transition =
            RbpConnectionReducer.TransitionConnection(
                state,
                new RbpConnectionEvent(
                    RbpConnectionEventType.Goodbye,
                    GoodbyeReason: (RbpGoodbyeReason)int.MaxValue));

        Assert.Equal(
            RbpTransitionKind.InvalidTransition,
            transition.Kind);
        Assert.Same(state, transition.State);
    }

    [Fact]
    public void SessionRegistersResumesAndReEnrolls()
    {
        RbpSessionLifecycleState session =
            RbpConnectionReducer.CreateSessionLifecycle(
                "port:8080:pid:1234");
        session = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.RegisterRequested));
        session = ApplySession(
            session,
            new RbpSessionEvent(
                RbpSessionEventType.Registered,
                Rsid: "rs-a"));
        Assert.True(session.DispatchAllowed);
        Assert.True(session.ResumeAllowed);

        session = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.ConnectionLost));
        session = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.ResumeRequested));
        session = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.ResumeRejected));
        Assert.Equal(RbpSessionPhase.ReEnrolling, session.Phase);
        Assert.Null(session.Rsid);

        session = ApplySession(
            session,
            new RbpSessionEvent(
                RbpSessionEventType.ReEnrolled,
                Rsid: "rs-b"));
        Assert.Equal(RbpSessionPhase.Registered, session.Phase);
        Assert.Equal("rs-b", session.Rsid);
        Assert.True(session.DispatchAllowed);
    }

    [Fact]
    public void ConnectionLossDuringRegistrationReturnsToRetryableDiscovery()
    {
        RbpSessionLifecycleState session =
            RbpConnectionReducer.CreateSessionLifecycle("local");
        session = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.RegisterRequested));

        session = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.ConnectionLost));

        Assert.Equal(RbpSessionPhase.Discovered, session.Phase);
        Assert.Null(session.Rsid);
        Assert.False(session.ResumeAllowed);
        Assert.False(session.DispatchAllowed);

        session = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.RegisterRequested));
        session = ApplySession(
            session,
            new RbpSessionEvent(
                RbpSessionEventType.Registered,
                Rsid: "rs-a"));

        Assert.Equal(RbpSessionPhase.Registered, session.Phase);
        Assert.True(session.DispatchAllowed);
    }

    [Fact]
    public void ConnectionLossDuringResumeReturnsToRetryableDisconnect()
    {
        RbpSessionLifecycleState session = BeginResume();

        session = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.ConnectionLost));

        Assert.Equal(RbpSessionPhase.Disconnected, session.Phase);
        Assert.Equal("rs-a", session.Rsid);
        Assert.True(session.ResumeAllowed);
        Assert.False(session.DispatchAllowed);

        RbpSessionLifecycleState duplicateLoss = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.ConnectionLost));
        Assert.Same(session, duplicateLoss);

        session = ApplySession(
            duplicateLoss,
            SessionEvent(RbpSessionEventType.ResumeRequested));
        session = ApplySession(
            session,
            new RbpSessionEvent(
                RbpSessionEventType.Resumed,
                Rsid: "rs-a"));

        Assert.Equal(RbpSessionPhase.Registered, session.Phase);
        Assert.True(session.DispatchAllowed);
    }

    [Fact]
    public void ConnectionLossDuringReEnrollmentKeepsRegistrationRetryable()
    {
        RbpSessionLifecycleState session = BeginResume();
        session = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.ResumeRejected));

        RbpSessionLifecycleState afterLoss = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.ConnectionLost));

        Assert.Same(session, afterLoss);
        Assert.Equal(RbpSessionPhase.ReEnrolling, afterLoss.Phase);
        Assert.False(afterLoss.DispatchAllowed);
        Assert.Equal(
            RbpSessionPhase.Registering,
            ApplySession(
                    afterLoss,
                    SessionEvent(RbpSessionEventType.RegisterRequested))
                .Phase);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("rs-b")]
    public void ResumeAckRequiresThePendingRsid(string? acknowledgedRsid)
    {
        RbpSessionLifecycleState session = BeginResume();

        RbpSessionTransition transition =
            RbpConnectionReducer.TransitionSession(
                session,
                new RbpSessionEvent(
                    RbpSessionEventType.Resumed,
                    Rsid: acknowledgedRsid));

        Assert.Equal(
            RbpTransitionKind.InvalidTransition,
            transition.Kind);
        Assert.Same(session, transition.State);
        Assert.False(transition.State.DispatchAllowed);
    }

    [Theory]
    [InlineData((int)RbpSessionUnregisterReason.RevitExited)]
    [InlineData((int)RbpSessionUnregisterReason.BridgeShutdown)]
    [InlineData((int)RbpSessionUnregisterReason.SessionReplaced)]
    [InlineData((int)RbpSessionUnregisterReason.OperatorRequested)]
    public void UnregisterRevokesResumeAndDispatch(int reasonValue)
    {
        var reason = (RbpSessionUnregisterReason)reasonValue;
        RbpSessionLifecycleState session =
            RbpConnectionReducer.CreateSessionLifecycle("local");
        session = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.RegisterRequested));
        session = ApplySession(
            session,
            new RbpSessionEvent(
                RbpSessionEventType.Registered,
                Rsid: "rs-a"));
        session = ApplySession(
            session,
            new RbpSessionEvent(
                RbpSessionEventType.Unregister,
                UnregisterReason: reason));

        Assert.Equal(RbpSessionPhase.Unregistered, session.Phase);
        Assert.False(session.ResumeAllowed);
        Assert.False(session.DispatchAllowed);
        Assert.Equal(reason, session.UnregisterReason);
    }

    [Fact]
    public void UnregisterReplayRequiresTheExactDefinedReason()
    {
        RbpSessionLifecycleState registered = OpenRegisteredSession();
        RbpSessionLifecycleState unregistered = ApplySession(
            registered,
            new RbpSessionEvent(
                RbpSessionEventType.Unregister,
                UnregisterReason:
                    RbpSessionUnregisterReason.RevitExited));

        RbpSessionTransition exactReplay =
            RbpConnectionReducer.TransitionSession(
                unregistered,
                new RbpSessionEvent(
                    RbpSessionEventType.Unregister,
                    UnregisterReason:
                        RbpSessionUnregisterReason.RevitExited));
        Assert.Equal(
            RbpTransitionKind.Transitioned,
            exactReplay.Kind);
        Assert.Same(unregistered, exactReplay.State);

        RbpSessionTransition conflictingReplay =
            RbpConnectionReducer.TransitionSession(
                unregistered,
                new RbpSessionEvent(
                    RbpSessionEventType.Unregister,
                    UnregisterReason:
                        RbpSessionUnregisterReason.OperatorRequested));
        Assert.Equal(
            RbpTransitionKind.InvalidTransition,
            conflictingReplay.Kind);
        Assert.Same(unregistered, conflictingReplay.State);

        RbpSessionTransition undefinedReason =
            RbpConnectionReducer.TransitionSession(
                registered,
                new RbpSessionEvent(
                    RbpSessionEventType.Unregister,
                    UnregisterReason:
                        (RbpSessionUnregisterReason)int.MaxValue));
        Assert.Equal(
            RbpTransitionKind.InvalidTransition,
            undefinedReason.Kind);
        Assert.Same(registered, undefinedReason.State);
    }

    private static RbpConnectionLifecycleState OpenSteady()
    {
        RbpConnectionLifecycleState state =
            RbpConnectionReducer.CreateConnectionLifecycle();
        state = Apply(state, Event(RbpConnectionEventType.Start));
        state = Apply(
            state,
            Event(RbpConnectionEventType.TransportOpened));
        state = Apply(
            state,
            Event(RbpConnectionEventType.AuthenticationAccepted));
        return Apply(
            state,
            new RbpConnectionEvent(
                RbpConnectionEventType.HelloAccepted,
                SelectedProtocol: 1,
                GrantedCapabilities: new[]
                {
                    "journal_v1",
                    "chunked_results",
                    "journal_v1",
                }));
    }

    private static RbpConnectionLifecycleState Apply(
        RbpConnectionLifecycleState state,
        RbpConnectionEvent connectionEvent)
    {
        RbpConnectionTransition result =
            RbpConnectionReducer.TransitionConnection(
                state,
                connectionEvent);
        Assert.Equal(RbpTransitionKind.Transitioned, result.Kind);
        return result.State;
    }

    private static RbpSessionLifecycleState ApplySession(
        RbpSessionLifecycleState state,
        RbpSessionEvent sessionEvent)
    {
        RbpSessionTransition result =
            RbpConnectionReducer.TransitionSession(state, sessionEvent);
        Assert.Equal(RbpTransitionKind.Transitioned, result.Kind);
        return result.State;
    }

    private static RbpSessionLifecycleState OpenRegisteredSession()
    {
        RbpSessionLifecycleState session =
            RbpConnectionReducer.CreateSessionLifecycle("local");
        session = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.RegisterRequested));
        return ApplySession(
            session,
            new RbpSessionEvent(
                RbpSessionEventType.Registered,
                Rsid: "rs-a"));
    }

    private static RbpSessionLifecycleState BeginResume()
    {
        RbpSessionLifecycleState session = OpenRegisteredSession();
        session = ApplySession(
            session,
            SessionEvent(RbpSessionEventType.ConnectionLost));
        return ApplySession(
            session,
            SessionEvent(RbpSessionEventType.ResumeRequested));
    }

    private static RbpConnectionEvent Event(
        RbpConnectionEventType type)
    {
        return new RbpConnectionEvent(type);
    }

    private static RbpSessionEvent SessionEvent(RbpSessionEventType type)
    {
        return new RbpSessionEvent(type);
    }
}
