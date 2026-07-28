namespace RevAgent.Bridge.Gateway.Dispatch;

internal enum RbpDispatchErrorCode
{
    /// <summary>
    /// A terminal protocol fault. Section 10.1 and Section 12.2 rule 5 both
    /// terminate this way, and neither may reach the add-in.
    /// </summary>
    Protocol,

    /// <summary>
    /// The add-in session needed for this invocation is not routable.
    /// </summary>
    SessionUnavailable,

    /// <summary>
    /// The add-in was reached or may have been reached and did not produce a
    /// usable terminal answer.
    /// </summary>
    Environment,
}

internal sealed class RbpDispatchException : Exception
{
    internal RbpDispatchException(
        RbpDispatchErrorCode errorCode,
        string message,
        Exception? innerException = null)
        : base(message, innerException)
    {
        ErrorCode = errorCode;
    }

    internal RbpDispatchErrorCode ErrorCode { get; }

    internal string WireCode => ErrorCode switch
    {
        RbpDispatchErrorCode.Protocol => "protocol",
        RbpDispatchErrorCode.SessionUnavailable => "session_unavailable",
        _ => "environment",
    };
}
