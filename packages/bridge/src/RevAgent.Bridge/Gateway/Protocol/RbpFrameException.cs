namespace RevAgent.Bridge.Gateway.Protocol;

internal enum RbpFrameErrorCode
{
    DuplicateKey,
    InvalidEnvelope,
}

internal sealed class RbpFrameException : Exception
{
    internal RbpFrameException(
        RbpFrameErrorCode code,
        string message,
        string? path = null,
        Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
        Path = path;
    }

    internal RbpFrameErrorCode Code { get; }

    internal string? Path { get; }
}
