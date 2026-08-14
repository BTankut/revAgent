using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Connection;

internal enum RbpRetryWaitAuthority
{
    RetryConditionSignal,
}

/// <summary>
/// Closed, value-free evidence that an opening authorization refusal reached
/// the reducer's existing retry pause. Arbitrary exception text cannot be
/// represented by this type.
/// </summary>
internal sealed record RbpConnectionFailureObservation
{
    internal const string Contract =
        "revagent.m4-rbp-refusal-observer/v1";

    private RbpConnectionFailureObservation(
        string correlationId,
        RbpOpeningBinding binding,
        bool hasHttpStatus,
        bool hasCloseCode)
    {
        CorrelationId = correlationId;
        Binding = binding;
        HasHttpStatus = hasHttpStatus;
        HasCloseCode = hasCloseCode;
    }

    internal string CorrelationId { get; }

    internal RbpOpeningBinding Binding { get; }

    internal RbpGatewayFailureKind GatewayFailure =>
        RbpGatewayFailureKind.Authorization;

    internal RbpOpeningFailureClass OpeningFailure =>
        RbpOpeningFailureClass.Auth;

    internal RbpConnectionPhase Phase => RbpConnectionPhase.RetryPaused;

    internal RbpRetryPauseReason RetryPauseReason =>
        RbpRetryPauseReason.Auth;

    internal RbpRetryAction RetryAction => RbpRetryAction.Pause;

    internal RbpRetryWaitAuthority WaitAuthority =>
        RbpRetryWaitAuthority.RetryConditionSignal;

    internal bool HasHttpStatus { get; }

    internal bool HasCloseCode { get; }

    internal static RbpConnectionFailureObservation? TryCreate(
        RbpGatewayFailureKind gatewayFailure,
        int? httpStatus,
        int? closeCode,
        RbpOpeningFailureContext? openingContext,
        RbpConnectionLifecycleState lifecycle)
    {
        if (gatewayFailure != RbpGatewayFailureKind.Authorization ||
            openingContext is null ||
            lifecycle.Phase != RbpConnectionPhase.RetryPaused ||
            lifecycle.RetryPauseReason != RbpRetryPauseReason.Auth ||
            lifecycle.LastRetryDecision is not
            {
                Action: RbpRetryAction.Pause,
                PauseReason: RbpRetryPauseReason.Auth,
            } ||
            (httpStatus != 403 && closeCode != 4403))
        {
            return null;
        }

        return new RbpConnectionFailureObservation(
            openingContext.CorrelationId,
            openingContext.Binding,
            httpStatus == 403,
            closeCode == 4403);
    }

    internal string ToLogMessage()
    {
        string binding = Binding switch
        {
            RbpOpeningBinding.Wss => "wss",
            RbpOpeningBinding.HttpSse => "http_sse",
            _ => throw new InvalidOperationException(
                "Unknown RBP opening binding."),
        };
        return
            $"observer_contract={Contract} " +
            $"correlation_id={CorrelationId} " +
            $"binding={binding} " +
            "gateway_failure=authorization " +
            $"http_status={(HasHttpStatus ? "403" : "none")} " +
            $"close_code={(HasCloseCode ? "4403" : "none")} " +
            "opening_failure=auth phase=retry_paused " +
            "retry_pause_reason=auth retry_action=pause " +
            "wait_authority=retry_condition_signal";
    }
}
