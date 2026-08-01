using System.Net;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Authentication;

namespace RevAgent.Bridge.Gateway.Connection;

internal interface IRbpClientWebSocketFactory
{
    ClientWebSocket Create();
}

internal sealed class SystemTrustClientWebSocketFactory :
    IRbpClientWebSocketFactory
{
    public ClientWebSocket Create() => new();
}

internal sealed class WssGatewayBinding : IRbpGatewayBinding
{
    private readonly IRbpClientWebSocketFactory _socketFactory;

    internal WssGatewayBinding(
        IRbpClientWebSocketFactory? socketFactory = null)
    {
        _socketFactory =
            socketFactory ?? new SystemTrustClientWebSocketFactory();
    }

    public async Task<RbpGatewayConnection> ConnectAsync(
        RbpGatewayConnectRequest request,
        CancellationToken cancellationToken = default)
    {
        ValidateRequest(request);
        ClientWebSocket socket = _socketFactory.Create();
        try
        {
            socket.Options.CollectHttpResponseDetails = true;
            socket.Options.KeepAliveInterval = Timeout.InfiniteTimeSpan;
            socket.Options.SetRequestHeader(
                "Authorization",
                request.Credential.CreateAuthorizationHeader());
            socket.Options.SetRequestHeader(
                "X-RBP-Versions",
                string.Join(",", request.SupportedProtocols));

            await socket.ConnectAsync(request.Endpoint, cancellationToken)
                .ConfigureAwait(false);
            return new RbpGatewayConnection(socket);
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            socket.Dispose();
            throw;
        }
        catch (Exception exception)
            when (exception is WebSocketException or
                HttpRequestException or
                AuthenticationException or
                IOException)
        {
            RbpGatewayTransportException translated =
                TranslateOpeningFailure(socket, exception);
            socket.Dispose();
            throw translated;
        }
    }

    private static void ValidateRequest(RbpGatewayConnectRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Endpoint);
        ArgumentNullException.ThrowIfNull(request.Credential);
        ArgumentNullException.ThrowIfNull(request.SupportedProtocols);
        Uri endpoint = request.Endpoint;
        if (!endpoint.IsAbsoluteUri ||
            !string.Equals(
                endpoint.Scheme,
                Uri.UriSchemeWss,
                StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(
                endpoint.AbsolutePath,
                "/bridge/v1",
                StringComparison.Ordinal) ||
            endpoint.Query.Length != 0 ||
            endpoint.Fragment.Length != 0 ||
            endpoint.UserInfo.Length != 0 ||
            endpoint.HostNameType != UriHostNameType.Dns ||
            Uri.CheckHostName(endpoint.DnsSafeHost) !=
                UriHostNameType.Dns ||
            endpoint.DnsSafeHost.StartsWith(
                ".",
                StringComparison.Ordinal) ||
            endpoint.DnsSafeHost.EndsWith(
                ".",
                StringComparison.Ordinal))
        {
            throw new ArgumentException(
                "The RBP WSS endpoint must use a DNS host and the exact " +
                "wss://dns-name/bridge/v1 shape.",
                nameof(request));
        }

        if (request.SupportedProtocols.Count == 0 ||
            request.SupportedProtocols.Any(
                version => version != 1) ||
            request.SupportedProtocols
                .Distinct()
                .Count() != request.SupportedProtocols.Count)
        {
            throw new ArgumentException(
                "The frozen Bridge supports only one RBP/1 version hint.",
                nameof(request));
        }
    }

    private static RbpGatewayTransportException TranslateOpeningFailure(
        ClientWebSocket socket,
        Exception exception)
    {
        int statusCode = (int)socket.HttpStatusCode;
        RbpGatewayFailureKind kind = ClassifyOpeningFailure(
            socket.HttpStatusCode,
            ContainsAuthenticationFailure(exception));
        string message = kind switch
        {
            RbpGatewayFailureKind.Authentication =>
                "The Gateway rejected the device credential.",
            RbpGatewayFailureKind.Authorization =>
                "The Gateway rejected device or seat authorization.",
            RbpGatewayFailureKind.Version =>
                "The Gateway rejected the offered RBP protocol version.",
            RbpGatewayFailureKind.Trust =>
                "The Gateway TLS certificate did not satisfy machine trust.",
            RbpGatewayFailureKind.Protocol =>
                "The Gateway rejected the RBP WebSocket upgrade.",
            _ => "The RBP WebSocket connection could not be opened.",
        };
        RbpRetryAfterDecision retryAfter =
            kind == RbpGatewayFailureKind.Network
                ? GetBoundedRetryAfter(
                    socket.HttpResponseHeaders,
                    DateTimeOffset.UtcNow)
                : RbpRetryAfterDecision.Absent;
        return new RbpGatewayTransportException(
            kind,
            message,
            statusCode == 0 ? null : statusCode,
            fallbackEligible: kind == RbpGatewayFailureKind.Network,
            retryNotBeforeUtc: retryAfter.NotBeforeUtc,
            retryAfterDisposition: retryAfter.Disposition,
            innerException: exception);
    }

    internal static RbpGatewayFailureKind ClassifyOpeningFailure(
        HttpStatusCode status,
        bool trustFailure)
    {
        if (trustFailure)
        {
            return RbpGatewayFailureKind.Trust;
        }

        return status switch
        {
            HttpStatusCode.Unauthorized =>
                RbpGatewayFailureKind.Authentication,
            HttpStatusCode.Forbidden =>
                RbpGatewayFailureKind.Authorization,
            HttpStatusCode.UpgradeRequired =>
                RbpGatewayFailureKind.Version,
            HttpStatusCode.RequestTimeout or
                HttpStatusCode.ProxyAuthenticationRequired or
                HttpStatusCode.TooManyRequests or
                HttpStatusCode.BadGateway or
                HttpStatusCode.ServiceUnavailable or
                HttpStatusCode.GatewayTimeout =>
                RbpGatewayFailureKind.Network,
            0 => RbpGatewayFailureKind.Network,
            _ => RbpGatewayFailureKind.Protocol,
        };
    }

    internal static RbpRetryAfterDecision GetBoundedRetryAfter(
        IReadOnlyDictionary<string, IEnumerable<string>>? headers,
        DateTimeOffset now)
    {
        if (headers is null ||
            !headers.TryGetValue(
                "Retry-After",
                out IEnumerable<string>? rawValues))
        {
            return RbpRetryAfterDecision.Absent;
        }

        string[] values = rawValues.ToArray();
        if (values.Length != 1 ||
            !RetryConditionHeaderValue.TryParse(
                values[0],
                out RetryConditionHeaderValue? retryAfter))
        {
            return RbpRetryAfterDecision.IgnoredMalformed;
        }

        DateTimeOffset notBefore;
        if (retryAfter.Delta is TimeSpan delta)
        {
            if (delta < TimeSpan.Zero ||
                delta > TimeSpan.FromMinutes(15))
            {
                return RbpRetryAfterDecision.IgnoredOutOfRange;
            }

            notBefore = now + delta;
        }
        else if (retryAfter.Date is DateTimeOffset retryDate)
        {
            if (retryDate > now + TimeSpan.FromMinutes(15))
            {
                return RbpRetryAfterDecision.IgnoredOutOfRange;
            }

            notBefore = retryDate > now ? retryDate : now;
        }
        else
        {
            return RbpRetryAfterDecision.IgnoredMalformed;
        }

        return new RbpRetryAfterDecision(
            notBefore,
            RbpRetryAfterDisposition.Accepted);
    }

    private static bool ContainsAuthenticationFailure(Exception exception)
    {
        for (Exception? current = exception;
             current is not null;
             current = current.InnerException)
        {
            if (current is AuthenticationException)
            {
                return true;
            }
        }

        return false;
    }
}

internal sealed record RbpRetryAfterDecision(
    DateTimeOffset? NotBeforeUtc,
    RbpRetryAfterDisposition Disposition)
{
    internal static RbpRetryAfterDecision Absent { get; } =
        new(null, RbpRetryAfterDisposition.Absent);

    internal static RbpRetryAfterDecision IgnoredMalformed { get; } =
        new(null, RbpRetryAfterDisposition.IgnoredMalformed);

    internal static RbpRetryAfterDecision IgnoredOutOfRange { get; } =
        new(null, RbpRetryAfterDisposition.IgnoredOutOfRange);
}
