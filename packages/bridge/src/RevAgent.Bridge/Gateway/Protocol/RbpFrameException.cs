namespace RevAgent.Bridge.Gateway.Protocol;

internal enum RbpFrameErrorCode
{
    DuplicateKey,
    InvalidEnvelope,
    BinaryFrame,
    InvalidUtf8,
    Utf8Bom,
    InvalidJson,
    FrameTooLarge,
}

internal sealed class RbpFrameException : Exception
{
    internal RbpFrameException(
        RbpFrameErrorCode code,
        string message,
        string? path = null,
        Exception? innerException = null,
        long? actualBytes = null,
        long? limitBytes = null)
        : base(message, innerException)
    {
        Code = code;
        Path = path;
        ActualBytes = actualBytes;
        LimitBytes = limitBytes;
    }

    internal RbpFrameErrorCode Code { get; }

    internal string? Path { get; }

    internal long? ActualBytes { get; }

    internal long? LimitBytes { get; }
}
