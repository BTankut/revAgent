namespace RevAgent.Bridge.Gateway.Connection;

/// <summary>Value-free stages from the Streamable HTTP/SSE receive boundary.</summary>
internal sealed record RbpSseReceiveObservation(
    string ContractVersion,
    string Event,
    string Stage,
    string MethodKind,
    string Outcome)
{
    internal const string Contract =
        "revagent.wp12-rbp-sse-receive-observation/v1";

    internal static RbpSseReceiveObservation Create(
        string stage,
        string methodKind = "other",
        string outcome = "observed")
    {
        if (stage is not ("headers_received" or "event_line" or "data_line" or
            "blank_terminator" or "method_kind" or "stream_end" or "parser_error") ||
            methodKind is not ("session_registered" or "other") ||
            outcome is not ("observed" or "error"))
        {
            throw new ArgumentOutOfRangeException(nameof(stage));
        }
        return new RbpSseReceiveObservation(
            Contract,
            "bridge.streamable_http_sse_receive",
            stage,
            methodKind,
            outcome);
    }
}
