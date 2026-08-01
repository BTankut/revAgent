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
        bool fallbackEligible = false,
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
        FallbackEligible = fallbackEligible;
        RetryNotBeforeUtc = retryNotBeforeUtc;
        RetryAfterDisposition = retryAfterDisposition;
        VersionWindow = versionWindow;
    }

    internal RbpGatewayFailureKind Kind { get; }

    internal int? StatusCode { get; }

    internal int? CloseCode { get; }

    /// <summary>
    /// Whether this failure is the Section 4.1 opening class that may try
    /// the provisioned Streamable HTTP/SSE fallback once: a retryable
    /// network/proxy/upgrade failure that prevented WSS from opening.
    /// Authentication, authorization, version, and trust failures never
    /// downgrade transport.
    /// </summary>
    internal bool FallbackEligible { get; }

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
