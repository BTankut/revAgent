using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Buffers;
using Microsoft.AspNetCore.Http;

namespace RevAgent.M4.ClientBearerBroker;

internal sealed class BrokerProxy
{
    private static readonly Uri Upstream = new(BrokerContracts.UpstreamUrl);
    private static readonly HashSet<string> AllowedRequestHeaders =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "Accept",
            "Content-Type",
            "MCP-Protocol-Version",
            "MCP-Session-Id",
            "Last-Event-ID",
        };
    private static readonly HashSet<string> AllowedResponseHeaders =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "Content-Type",
            "MCP-Session-Id",
            "Cache-Control",
            "Retry-After",
        };
    private static readonly byte[] RefusalBody =
        Encoding.UTF8.GetBytes("{\"ok\":false,\"code\":\"caller_refused\"}\n");
    private static readonly byte[] UpstreamFailureBody =
        Encoding.UTF8.GetBytes("{\"ok\":false,\"code\":\"upstream_unavailable\"}\n");

    private readonly HttpMessageInvoker _upstream;
    private readonly ICallerAuthorizer _authorizer;
    private readonly Func<byte[]> _bearerLoader;

    internal BrokerProxy(
        HttpMessageInvoker upstream,
        ICallerAuthorizer authorizer,
        Func<byte[]> bearerLoader)
    {
        _upstream = upstream;
        _authorizer = authorizer;
        _bearerLoader = bearerLoader;
    }

    internal async Task HandleAsync(HttpContext context)
    {
        if (!HttpMethods.IsGet(context.Request.Method) &&
            !HttpMethods.IsPost(context.Request.Method) &&
            !HttpMethods.IsDelete(context.Request.Method))
        {
            context.Response.StatusCode = StatusCodes.Status405MethodNotAllowed;
            return;
        }

        CallerAuthorizationLease? lease = null;
        byte[]? bearer = null;
        try
        {
            lease = await _authorizer.AuthorizeAsync(context, context.RequestAborted)
                .ConfigureAwait(false);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(
                context.RequestAborted,
                lease.Revocation);

            bearer = _bearerLoader();
            SecretHandoffCommand.ValidateBearer(bearer);
            using var request = BuildRequest(context, bearer);
            using var response = await _upstream.SendAsync(request, linked.Token)
                .ConfigureAwait(false);

            context.Response.StatusCode = (int)response.StatusCode;
            CopyResponseHeaders(response, context.Response);
            if (response.Content is not null)
            {
                await using var stream = await response.Content.ReadAsStreamAsync(linked.Token)
                    .ConfigureAwait(false);
                await CopyStreamingAsync(stream, context.Response.Body, linked.Token)
                    .ConfigureAwait(false);
            }
            await lease.VerifyAfterAsync(linked.Token).ConfigureAwait(false);
        }
        catch (BrokerRefusalException)
        {
            if (context.Response.HasStarted)
            {
                context.Abort();
                return;
            }
            await WriteFixedErrorAsync(
                context,
                StatusCodes.Status403Forbidden,
                RefusalBody).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            if (context.Response.HasStarted)
            {
                context.Abort();
                return;
            }
            await WriteFixedErrorAsync(
                context,
                StatusCodes.Status504GatewayTimeout,
                UpstreamFailureBody).ConfigureAwait(false);
        }
        catch
        {
            if (context.Response.HasStarted)
            {
                context.Abort();
                return;
            }
            await WriteFixedErrorAsync(
                context,
                StatusCodes.Status502BadGateway,
                UpstreamFailureBody).ConfigureAwait(false);
        }
        finally
        {
            if (bearer is not null)
            {
                CryptographicOperations.ZeroMemory(bearer);
            }
            if (lease is not null)
            {
                await lease.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

    private static HttpRequestMessage BuildRequest(
        HttpContext context,
        ReadOnlySpan<byte> bearer)
    {
        var request = new HttpRequestMessage(
            new HttpMethod(context.Request.Method),
            Upstream);
        if (HttpMethods.IsPost(context.Request.Method))
        {
            request.Content = new StreamContent(context.Request.Body);
        }

        foreach (var header in context.Request.Headers)
        {
            if (!AllowedRequestHeaders.Contains(header.Key))
            {
                continue;
            }
            if (string.Equals(header.Key, "Content-Type", StringComparison.OrdinalIgnoreCase))
            {
                request.Content?.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
            }
            else
            {
                request.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
            }
        }

        // Client Authorization, cookies, proxy headers, forwarding headers,
        // Host, connection options and every other unlisted header are dropped.
        var bearerText = Encoding.ASCII.GetString(bearer);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearerText);
        return request;
    }

    private static void CopyResponseHeaders(HttpResponseMessage source, HttpResponse destination)
    {
        foreach (var header in source.Headers)
        {
            if (AllowedResponseHeaders.Contains(header.Key))
            {
                destination.Headers[header.Key] = header.Value.ToArray();
            }
        }
        if (source.Content is not null)
        {
            foreach (var header in source.Content.Headers)
            {
                if (AllowedResponseHeaders.Contains(header.Key))
                {
                    destination.Headers[header.Key] = header.Value.ToArray();
                }
            }
        }
        destination.Headers.Remove("transfer-encoding");
    }

    private static async Task WriteFixedErrorAsync(
        HttpContext context,
        int statusCode,
        byte[] body)
    {
        context.Response.Clear();
        context.Response.StatusCode = statusCode;
        context.Response.ContentType = "application/json";
        context.Response.ContentLength = body.Length;
        await context.Response.Body.WriteAsync(body, CancellationToken.None)
            .ConfigureAwait(false);
    }

    private static async Task CopyStreamingAsync(
        Stream source,
        Stream destination,
        CancellationToken cancellationToken)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(16 * 1024);
        try
        {
            while (true)
            {
                var read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    return;
                }
                await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken)
                    .ConfigureAwait(false);
                await destination.FlushAsync(cancellationToken).ConfigureAwait(false);
                CryptographicOperations.ZeroMemory(buffer.AsSpan(0, read));
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(buffer);
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }
}
