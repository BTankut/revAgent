using System.Net.Http;
using System.Net.Security;
using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Enrollment;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Runtime;

namespace RevAgent.Bridge.RealWorkerHost;

/// <summary>
/// Test-only process host for WP-12.  It owns no protocol controls: the only
/// stdin operation is shutdown.  The data plane is the exact C# coordinator,
/// journal, add-in loopback router and carrier producer compiled from
/// RevAgent.Bridge; protocol traffic is consequently between that worker and
/// the production TypeScript Gateway, never bridge-simulator.
/// </summary>
internal static class Program
{
    private const string TestProtectionScheme = "wp12-test-only/v1";
    private const int MaxControlLineBytes = 65_536;

    public static async Task<int> Main(string[] args)
    {
        try
        {
            Options options = Options.Parse(args);
            await using WorkerGatewayRuntime runtime = Compose(options);
            using var cancellation = new CancellationTokenSource();
            Task run = runtime.RunAsync(cancellation.Token);
            await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new
            {
                ready = true,
                component = "bridge_worker",
                contract = "wp12-real-worker-host/v1",
                controlVersion = 1,
                maxControlLineBytes = MaxControlLineBytes,
                actions = new[] { "shutdown" },
                pid = Environment.ProcessId,
                bindings = new[] { options.Binding },
                state_root_redacted = true,
                program_data_touched = false,
                dpapi_used = false,
                external_endpoint = false,
            })).ConfigureAwait(false);

            string? command = await Console.In.ReadLineAsync().ConfigureAwait(false);
            if (command is null || Encoding.UTF8.GetByteCount(command) > MaxControlLineBytes)
                throw new InvalidOperationException("test host control is missing or exceeds its fixed bound");
            using JsonDocument control = JsonDocument.Parse(command);
            JsonElement root = control.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("controlVersion", out JsonElement version) || version.GetInt32() != 1 ||
                !root.TryGetProperty("id", out JsonElement id) || id.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(id.GetString()) ||
                !root.TryGetProperty("action", out JsonElement action) || action.GetString() != "shutdown")
                throw new InvalidOperationException("test host accepts only schema-valid shutdown control");
            await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { controlVersion = 1, id = id.GetString(), ok = true, result = new { stopping = true } })).ConfigureAwait(false);
            cancellation.Cancel();
            try { await run.ConfigureAwait(false); }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
            return 0;
        }
        catch (Exception exception)
        {
            await Console.Error.WriteLineAsync($"real-worker-host: {exception.Message}").ConfigureAwait(false);
            return 70;
        }
    }

    private static WorkerGatewayRuntime Compose(Options options)
    {
        var layout = new BridgeInstallLayout(options.InstallRoot, options.StateRoot);
        Directory.CreateDirectory(layout.StateRoot);
        var enrollment = new StaticEnrollment(options.DeviceId, options.DeviceToken, options.Fingerprint);
        RbpJournalStore journal = WorkerGatewayComposition.OpenJournal(layout, new TestResumeProtector());
        try
        {
            var transport = new AddinTcpTransport();
            var router = new AddinSessionRouter(transport);
            var claims = new RbpCredentialClaimBinding(enrollment);
            var catalog = new WorkerAddinSessionCatalog(
                new AddinDiscovery(transport), router, Configuration(options),
                () => new StaticCredentialProvider(options.DeviceId, options.DeviceToken, options.Fingerprint),
                async (rsid, token) => (await journal.GetStoredSessionAsync(rsid, token).ConfigureAwait(false))?.LocalSessionKey,
                "wp12-real-worker-host", hostname: "localhost", credentialClaims: claims);
            RbpArtifactCarrierProducer? carrier = null;
            try { carrier = RbpArtifactCarrierProducer.CreateProduction(layout.StateRoot, journal); }
            catch (RbpArtifactCarrierException) { }
            IReadOnlyCollection<string> capabilities = new[]
            {
                RbpHelloProfile.JournalCapability,
                RbpHelloProfile.StreamableHttpCapability,
                RbpHelloProfile.ChunkedResultsCapability,
                RbpHelloProfile.ArtifactResultCapability,
            };
            IRbpConnectionCycleFactory wss = new WssRbpConnectionCycleFactory(
                new RbpGatewayHandshakeClient(claims, new WssGatewayBinding(new PinnedSocketFactory(options.CertificateSha256))));
            IRbpConnectionCycleFactory cycle = options.Binding == "wss"
                ? wss
                : new StreamableHttpRbpConnectionCycleFactory(
                    claims, capabilities, new PinnedHttpFactory(options.CertificateSha256));
            var profile = new RbpHelloProfile(
                "wp12-real-worker-host", "localhost", "test-only", Array.Empty<string>(), capabilities.ToArray());
            RbpConnectionCoordinator coordinator = WorkerGatewayComposition.CreateCoordinator(
                new WorkerGatewayServices(cycle, journal, catalog,
                    new RbpConnectionCoordinatorOptions(options.GatewayUri, profile, CredentialClaimInvalidator: claims),
                    new WorkerAddinDispatchSurface(router, catalog), CarrierProducer: carrier));
            return new WorkerGatewayRuntime(coordinator, catalog, journal, carrierProducer: carrier);
        }
        catch
        {
            journal.DisposeAsync().AsTask().GetAwaiter().GetResult();
            throw;
        }
    }

    private static ResolvedBridgeConfiguration Configuration(Options options) => new(
        1, options.GatewayUri, new BridgeAddinConfiguration(options.AddinPort, options.AddinPort),
        new BridgeLoggingConfiguration(1_048_576, 2),
        new BridgeConfigurationSourceMetadata("wp12-test-only", new Dictionary<string, BridgeConfigurationValueSource>
        {
            ["addin.scanStartPort"] = new(BridgeConfigurationSourceKind.Environment, "WP12_TEST"),
            ["addin.scanEndPort"] = new(BridgeConfigurationSourceKind.Environment, "WP12_TEST"),
        }));

    private sealed class StaticEnrollment(string deviceId, string token, string fingerprint) : IRbpEnrollmentStateProvider
    {
        public ValueTask<RbpEnrollmentSnapshot> ReadAsync(CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(RbpEnrollmentSnapshot.Ready(new RbpDeviceCredential(deviceId, token, fingerprint)));
        }
    }

    private sealed class StaticCredentialProvider(string deviceId, string token, string fingerprint) : IBridgeDeviceCredentialProvider
    {
        public BridgeGatewayCredential GetRequired() => new(deviceId, new BridgeSecretString(token), fingerprint);
    }

    private sealed class TestResumeProtector : IRbpResumeTokenProtector
    {
        public RbpProtectedResumeToken Protect(string plaintextToken) => new(TestProtectionScheme, Encoding.UTF8.GetBytes(plaintextToken));
        public string Unprotect(RbpProtectedResumeToken protectedToken) =>
            protectedToken.ProtectionScheme == TestProtectionScheme
                ? Encoding.UTF8.GetString(protectedToken.Ciphertext.Span)
                : throw new InvalidOperationException("unexpected test token protection scheme");
    }

    private sealed class PinnedSocketFactory(string expectedSha256) : IRbpClientWebSocketFactory
    {
        public ClientWebSocket Create()
        {
            var socket = new ClientWebSocket();
            socket.Options.RemoteCertificateValidationCallback = (_, certificate, _, errors) =>
                errors == SslPolicyErrors.None || CertificateMatches(certificate, expectedSha256);
            return socket;
        }
    }

    private sealed class PinnedHttpFactory(string expectedSha256) : IRbpHttpClientFactory
    {
        public HttpClient Create()
        {
            var handler = new SocketsHttpHandler
            {
                UseProxy = false,
                SslOptions = new System.Net.Security.SslClientAuthenticationOptions
                {
                    RemoteCertificateValidationCallback = (_, certificate, _, _) => CertificateMatches(certificate, expectedSha256),
                },
            };
            return new HttpClient(handler, disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };
        }
    }

    private static bool CertificateMatches(X509Certificate? certificate, string expected)
    {
        if (certificate is null) return false;
        string actual = Convert.ToHexString(SHA256.HashData(certificate.GetRawCertData())).ToLowerInvariant();
        return string.Equals(actual, expected, StringComparison.Ordinal);
    }

    private sealed record Options(Uri GatewayUri, int AddinPort, string InstallRoot, string StateRoot, string DeviceId, string DeviceToken, string Fingerprint, string CertificateSha256, string Binding)
    {
        public static Options Parse(IReadOnlyList<string> args)
        {
            if (args.Count != 18) throw new ArgumentException("real worker host requires exactly nine --key value pairs");
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int index = 0; index < args.Count; index += 2)
            {
                if (!args[index].StartsWith("--", StringComparison.Ordinal) || !values.TryAdd(args[index], args[index + 1])) throw new ArgumentException("invalid real worker host arguments");
            }
            string Required(string key) => values.Remove(key, out string? value) && !string.IsNullOrWhiteSpace(value) ? value : throw new ArgumentException($"missing {key}");
            string binding = Required("--binding");
            if (binding is not ("wss" or "streamable_http_sse")) throw new ArgumentException("invalid binding");
            Uri endpoint = new(Required("--gateway-uri"), UriKind.Absolute);
            string expectedScheme = binding == "wss" ? "wss" : "https";
            if (endpoint.Scheme != expectedScheme || endpoint.Host != "localhost") throw new ArgumentException("test host permits only pinned localhost Gateway endpoints for its selected binding");
            if (!int.TryParse(Required("--addin-port"), out int port) || port is < 1 or > 65535) throw new ArgumentException("invalid addin port");
            Options result = new(endpoint, port, Required("--install-root"), Required("--state-root"), Required("--device-id"), Required("--device-token"), Required("--fingerprint"), Required("--certificate-sha256"), binding);
            if (values.Count != 0 || !result.Fingerprint.StartsWith("sha256:", StringComparison.Ordinal) || result.CertificateSha256.Length != 64) throw new ArgumentException("invalid test identity or certificate pin");
            return result;
        }
    }
}
