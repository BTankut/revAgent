using System.Net;
using System.Security.Authentication;

namespace RevAgent.Bridge.Gateway.Connection;

internal interface IRbpHttpClientFactory
{
    HttpClient Create();
}

internal sealed class SystemProxyRbpHttpClientFactory :
    IRbpHttpClientFactory
{
    public HttpClient Create()
    {
        SocketsHttpHandler handler = CreateHandler();
        return new HttpClient(handler, disposeHandler: true)
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
    }

    internal static SocketsHttpHandler CreateHandler() =>
        new()
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
            Proxy = null,
            UseCookies = false,
            UseProxy = true,
        };
}

internal static class RbpHttpBindingProtocol
{
    private const int MaximumConnectionIdLength = 4096;

    internal static Uri CreateConnectionUri(Uri endpoint) =>
        BuildUri(endpoint, "/bridge/v1/http/connections");

    internal static Uri EventsUri(Uri endpoint, string connectionId) =>
        BuildConnectionUri(endpoint, connectionId, "events");

    internal static Uri MessagesUri(Uri endpoint, string connectionId) =>
        BuildConnectionUri(endpoint, connectionId, "messages");

    internal static void ApplyAuthenticatedHeaders(
        HttpRequestMessage request,
        RbpDeviceCredential credential)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(credential);
        request.Headers.TryAddWithoutValidation(
            "Authorization",
            credential.CreateAuthorizationHeader());
    }

    internal static void ApplyHttpVersion(HttpRequestMessage request)
    {
        ArgumentNullException.ThrowIfNull(request);
        request.Version = HttpVersion.Version20;
        request.VersionPolicy =
            HttpVersionPolicy.RequestVersionOrLower;
    }

    internal static string ReadConnectionId(
        HttpResponseMessage response)
    {
        ArgumentNullException.ThrowIfNull(response);
        if (!response.Headers.TryGetValues(
                "RBP-Connection-Id",
                out IEnumerable<string>? values))
        {
            throw Protocol(
                "The fallback create response omitted RBP-Connection-Id.");
        }

        string[] copy = values.ToArray();
        if (copy.Length != 1 ||
            !IsValidConnectionId(copy[0]))
        {
            throw Protocol(
                "The fallback create response returned an invalid " +
                "RBP-Connection-Id.");
        }

        return copy[0];
    }

    internal static RbpGatewayTransportException StatusFailure(
        HttpResponseMessage response,
        bool connectionAlreadyCreated,
        DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(response);
        HttpStatusCode status = response.StatusCode;
        RbpGatewayFailureKind kind =
            connectionAlreadyCreated &&
            status is HttpStatusCode.NotFound or HttpStatusCode.Gone
                ? RbpGatewayFailureKind.RemoteClosed
                : WssGatewayBinding.ClassifyOpeningFailure(
                    status,
                    trustFailure: false);
        RbpRetryAfterDecision retryAfter =
            kind == RbpGatewayFailureKind.Network
                ? WssGatewayBinding.GetBoundedRetryAfter(
                    response.Headers.ToDictionary(
                        pair => pair.Key,
                        pair => pair.Value,
                        StringComparer.OrdinalIgnoreCase),
                    now)
                : RbpRetryAfterDecision.Absent;
        string message = kind switch
        {
            RbpGatewayFailureKind.Authentication =>
                "The Gateway rejected the fallback device credential.",
            RbpGatewayFailureKind.Authorization =>
                "The Gateway rejected fallback device or seat authority.",
            RbpGatewayFailureKind.Version =>
                "The Gateway rejected the fallback RBP protocol version.",
            RbpGatewayFailureKind.RemoteClosed =>
                "The fallback connection id is unknown or expired.",
            RbpGatewayFailureKind.Network =>
                "The fallback HTTP request received a retryable " +
                "environment response.",
            _ =>
                "The fallback HTTP request returned an unexpected status.",
        };
        return new RbpGatewayTransportException(
            kind,
            message,
            statusCode: (int)status,
            retryNotBeforeUtc: retryAfter.NotBeforeUtc,
            retryAfterDisposition: retryAfter.Disposition);
    }

    internal static RbpGatewayTransportException RequestFailure(
        string message,
        Exception exception,
        bool durableAcceptanceUnknown = false)
    {
        ArgumentNullException.ThrowIfNull(exception);
        RbpGatewayFailureKind kind =
            ContainsTlsFailure(exception)
                ? RbpGatewayFailureKind.Trust
                : RbpGatewayFailureKind.Network;
        string suffix = durableAcceptanceUnknown
            ? " Durable acceptance is unknown; the connection must resume."
            : string.Empty;
        return new RbpGatewayTransportException(
            kind,
            message + suffix,
            innerException: exception);
    }

    internal static async Task<byte[]> ReadBoundedContentAsync(
        HttpContent content,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(content);
        if (maximumBytes < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        }

        if (content.Headers.ContentLength is long declaredLength &&
            declaredLength > maximumBytes)
        {
            throw Protocol(
                "The fallback HTTP response exceeds the frozen RBP limit.");
        }

        try
        {
            await using Stream source =
                await content.ReadAsStreamAsync(cancellationToken)
                    .ConfigureAwait(false);
            using var destination = new MemoryStream();
            byte[] buffer = new byte[16 * 1024];
            while (true)
            {
                int read = await source.ReadAsync(
                        buffer.AsMemory(),
                        cancellationToken)
                    .ConfigureAwait(false);
                if (read == 0)
                {
                    return destination.ToArray();
                }

                if (destination.Length + read > maximumBytes)
                {
                    throw Protocol(
                        "The fallback HTTP response exceeds the frozen " +
                        "RBP limit.");
                }

                destination.Write(buffer, 0, read);
            }
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (RbpGatewayTransportException)
        {
            throw;
        }
        catch (Exception exception)
            when (exception is HttpRequestException or IOException)
        {
            throw RequestFailure(
                "The fallback HTTP response body ended unexpectedly.",
                exception);
        }
    }

    internal static RbpGatewayTransportException Protocol(
        string message,
        Exception? innerException = null) =>
        new(
            RbpGatewayFailureKind.Protocol,
            message,
            innerException: innerException);

    private static Uri BuildConnectionUri(
        Uri endpoint,
        string connectionId,
        string leaf)
    {
        if (!IsValidConnectionId(connectionId))
        {
            throw new ArgumentException(
                "The fallback connection id is invalid.",
                nameof(connectionId));
        }

        return BuildUri(
            endpoint,
            "/bridge/v1/http/connections/" +
            Uri.EscapeDataString(connectionId) +
            "/" +
            leaf);
    }

    private static Uri BuildUri(Uri endpoint, string path)
    {
        ValidateEndpoint(endpoint);
        var builder = new UriBuilder(
            Uri.UriSchemeHttps,
            endpoint.DnsSafeHost,
            endpoint.IsDefaultPort ? -1 : endpoint.Port,
            path);
        return builder.Uri;
    }

    private static void ValidateEndpoint(Uri endpoint)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
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
                "The fallback endpoint must derive from the exact " +
                "wss://dns-name/bridge/v1 authority.",
                nameof(endpoint));
        }
    }

    private static bool IsValidConnectionId(string value)
    {
        if (string.IsNullOrEmpty(value) ||
            value.Length > MaximumConnectionIdLength ||
            !string.Equals(value, value.Trim(), StringComparison.Ordinal))
        {
            return false;
        }

        return value.All(character =>
            !char.IsControl(character) &&
            !char.IsSurrogate(character));
    }

    private static bool ContainsTlsFailure(Exception exception)
    {
        for (Exception? current = exception;
             current is not null;
             current = current.InnerException)
        {
            if (current is AuthenticationException ||
                current is HttpRequestException
                {
                    HttpRequestError:
                        HttpRequestError.SecureConnectionError,
                })
            {
                return true;
            }
        }

        return false;
    }
}
