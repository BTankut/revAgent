namespace RevAgent.Bridge.Gateway.Connection;

/// <summary>Closed, value-free lifecycle timeout evidence for test harnesses.</summary>
internal sealed record RbpLifecycleTimeoutObservation(
    string ContractVersion,
    string Event,
    string Binding,
    string LifecycleControl,
    string State,
    string Reason)
{
    internal const string Contract =
        "revagent.wp12-rbp-lifecycle-timeout-observation/v1";

    internal static RbpLifecycleTimeoutObservation Create(
        RbpConnectionBindingKind binding,
        string lifecycleControl)
    {
        string bindingName = binding switch
        {
            RbpConnectionBindingKind.Wss => "wss",
            RbpConnectionBindingKind.StreamableHttpSse => "streamable_http_sse",
            _ => "unknown",
        };
        if (lifecycleControl is not ("session_register" or "session_resume"))
        {
            throw new ArgumentOutOfRangeException(nameof(lifecycleControl));
        }
        return new RbpLifecycleTimeoutObservation(
            Contract,
            "bridge.lifecycle_control_timeout",
            bindingName,
            lifecycleControl,
            "awaiting_control",
            "bounded_timeout");
    }
}
