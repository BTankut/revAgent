using System.Net;
using System.Net.Security;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace RevAgent.M4.ClientBearerBroker;

internal static class BrokerHost
{
    internal static async Task<int> RunAsync(
        Invocation invocation,
        SecretHandoffCommand secretCommand)
    {
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions
        {
            Args = Array.Empty<string>(),
        });
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.AddServerHeader = false;
            options.Limits.MaxRequestBodySize = 4 * 1024 * 1024;
            options.Listen(IPAddress.Loopback, invocation.ListenPort, listen =>
            {
                listen.Protocols = HttpProtocols.Http1;
            });
        });

        using var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            UseProxy = false,
            Credentials = null,
            DefaultProxyCredentials = null,
            PreAuthenticate = false,
            AutomaticDecompression = DecompressionMethods.None,
            ConnectTimeout = TimeSpan.FromSeconds(10),
            SslOptions = new SslClientAuthenticationOptions
            {
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                CertificateRevocationCheckMode = X509RevocationMode.Online,
            },
        };
        using var upstream = new HttpMessageInvoker(handler, disposeHandler: false);
        var proxy = new BrokerProxy(
            upstream,
            new WindowsCallerAuthorizer(new CallerIdentityExpectation(
                invocation.ExpectedClientSid,
                invocation.ExpectedClientAccount,
                invocation.ExpectedClientImageSha256,
                invocation.ExpectedClientSignerThumbprint,
                invocation.ExpectedClientPackageFullName)),
            () => secretCommand.LoadBearer(invocation.Root));
        await using var app = builder.Build();
        app.MapMethods("/mcp", new[] { "GET", "POST", "DELETE" }, proxy.HandleAsync);
        app.MapFallback(static context =>
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return Task.CompletedTask;
        });
        await app.StartAsync().ConfigureAwait(false);
        ValueFreeOutput.Write(new
        {
            ok = true,
            action = "serve_m4_client_bearer_broker",
            contractVersion = BrokerContracts.BrokerVersion,
            listener = $"http://127.0.0.1:{invocation.ListenPort}/mcp",
            upstream = BrokerContracts.UpstreamUrl,
            callerPolicy = "packaged_codex_native_reverse_tuple_v1",
        });
        await ((IHost)app).WaitForShutdownAsync().ConfigureAwait(false);
        return 0;
    }
}
