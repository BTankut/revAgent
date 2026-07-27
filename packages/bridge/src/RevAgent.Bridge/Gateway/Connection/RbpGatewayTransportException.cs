namespace RevAgent.Bridge.Gateway.Connection;

internal enum RbpGatewayFailureKind
{
    EnrollmentRequired,
    Authentication,
    Authorization,
    Version,
    Trust,
    Protocol,
    Network,
    RemoteClosed,
}

internal enum RbpRetryAfterDisposition
{
    Absent,
    Accepted,
    IgnoredMalformed,
    IgnoredOutOfRange,
}

internal sealed record RbpVersionWindow(
    int MinimumProtocol,
    int MaximumProtocol,
    string ManifestUrl);

internal sealed class RbpGatewayTransportException : Exception
{
    internal RbpGatewayTransportException(
        RbpGatewayFailureKind kind,
        string message,
        int? statusCode = null,
        int? closeCode = null,
        DateTimeOffset? retryNotBeforeUtc = null,
        RbpRetryAfterDisposition retryAfterDisposition =
            RbpRetryAfterDisposition.Absent,
        RbpVersionWindow? versionWindow = null,
        Exception? innerException = null)
        : base(message, innerException)
    {
        Kind = kind;
        StatusCode = statusCode;
        CloseCode = closeCode;
        RetryNotBeforeUtc = retryNotBeforeUtc;
        RetryAfterDisposition = retryAfterDisposition;
        VersionWindow = versionWindow;
    }

    internal RbpGatewayFailureKind Kind { get; }

    internal int? StatusCode { get; }

    internal int? CloseCode { get; }

    internal DateTimeOffset? RetryNotBeforeUtc { get; }

    internal RbpRetryAfterDisposition RetryAfterDisposition { get; }

    internal RbpVersionWindow? VersionWindow { get; }

    internal bool RetryPaused =>
        Kind is RbpGatewayFailureKind.EnrollmentRequired or
            RbpGatewayFailureKind.Authentication or
            RbpGatewayFailureKind.Authorization or
            RbpGatewayFailureKind.Version or
            RbpGatewayFailureKind.Trust;
}
