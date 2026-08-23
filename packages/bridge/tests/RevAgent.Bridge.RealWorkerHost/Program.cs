using System.Diagnostics;
using System.Net;
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
            var fixtureAttestor = new FixtureAddinProcessAttestor(
                options.FixtureProcessId,
                options.AddinPort);
            var router = new AddinSessionRouter(transport, fixtureAttestor);
            var claims = new RbpCredentialClaimBinding(enrollment);
            var catalog = new WorkerAddinSessionCatalog(
                new AddinDiscovery(
                    transport,
                    fixtureAttestor),
                router,
                Configuration(options),
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
                    claims,
                    capabilities,
                    new PinnedHttpFactory(options.CertificateSha256),
                    onSseReceiveObservation: ObserveSseReceive);
            var profile = new RbpHelloProfile(
                "wp12-real-worker-host", "localhost", "test-only", Array.Empty<string>(), capabilities.ToArray());
            RbpConnectionCoordinator coordinator = WorkerGatewayComposition.CreateCoordinator(
                new WorkerGatewayServices(cycle, journal, catalog,
                    new RbpConnectionCoordinatorOptions(options.GatewayUri, profile, CredentialClaimInvalidator: claims, SessionRouteBindingAuthority: catalog),
                    new WorkerAddinDispatchSurface(router, catalog),
                    // The Gateway hello_ack remains the frozen 15 s RBP/1
                    // value. This test-host-only clock shortens only the
                    // locally scheduled wait so the real worker can prove a
                    // subsequent heartbeat_ack without changing production
                    // wire semantics.
                    Clock: new TestHeartbeatClock(options.TestHeartbeatIntervalMilliseconds),
                    OnConnectionFailureObservation: ObserveConnectionFailure,
                    OnLifecycleTimeoutObservation: ObserveLifecycleTimeout,
                    OnDocumentContextObservation: ObserveDocumentContext,
                    CarrierProducer: carrier));
            return new WorkerGatewayRuntime(coordinator, catalog, journal, carrierProducer: carrier);
        }
        catch
        {
            journal.DisposeAsync().AsTask().GetAwaiter().GetResult();
            throw;
        }
    }

    /// <summary>
    /// The real-process harness consumes stderr as failure evidence. Keep this
    /// boundary closed: it records lifecycle classification only, never the
    /// gateway URI, machine paths, credential values, or exception text.
    /// </summary>
    private static ValueTask ObserveConnectionFailure(
        RbpConnectionFailureObservation observation)
    {
        try
        {
            string binding = observation.Binding switch
            {
                RbpOpeningBinding.Wss => "wss",
                RbpOpeningBinding.HttpSse => "streamable_http_sse",
                _ => "unknown",
            };
            Console.Error.WriteLine(JsonSerializer.Serialize(new
            {
                contractVersion = "revagent.wp12-real-worker-observation/v1",
                @event = "bridge.connection_failure_observation",
                timestamp = DateTimeOffset.UtcNow.ToString("O"),
                binding,
                state = "retry_paused",
                reason = "authorization_refusal",
            }));
        }
        catch
        {
            // Diagnostic emission must not own the coordinator retry state.
        }
        return ValueTask.CompletedTask;
    }

    private static ValueTask ObserveLifecycleTimeout(
        RbpLifecycleTimeoutObservation observation)
    {
        WriteObservation(new
        {
            contractVersion = observation.ContractVersion,
            @event = observation.Event,
            timestamp = DateTimeOffset.UtcNow.ToString("O"),
            binding = observation.Binding,
            lifecycleControl = observation.LifecycleControl,
            state = observation.State,
            reason = observation.Reason,
        });
        return ValueTask.CompletedTask;
    }

    private static ValueTask ObserveDocumentContext(
        RbpDocumentContextObservation observation)
    {
        // This is intentionally a projection rather than an object dump.
        // Keep the real-process transcript value-free even if the observation
        // record grows in a production caller.
        WriteObservation(new
        {
            contractVersion = observation.ContractVersion,
            @event = observation.Event,
            timestamp = DateTimeOffset.UtcNow.ToString("O"),
            stage = observation.Stage,
            outcome = observation.Outcome,
            rsidHash = observation.RsidHash,
            payloadHash = observation.PayloadHash,
            sequence = observation.Sequence,
        });
        return ValueTask.CompletedTask;
    }

    private static void ObserveSseReceive(RbpSseReceiveObservation observation) =>
        WriteObservation(new
        {
            contractVersion = observation.ContractVersion,
            @event = observation.Event,
            timestamp = DateTimeOffset.UtcNow.ToString("O"),
            stage = observation.Stage,
            methodKind = observation.MethodKind,
            outcome = observation.Outcome,
        });

    private static void WriteObservation(object observation)
    {
        try
        {
            Console.Error.WriteLine(JsonSerializer.Serialize(observation));
        }
        catch
        {
            // Test-harness stderr is non-authoritative.
        }
    }

    private static ResolvedBridgeConfiguration Configuration(Options options) => new(
        1, options.GatewayUri, new BridgeAddinConfiguration(options.AddinPort, options.AddinPort),
        new BridgeLoggingConfiguration(1_048_576, 2),
        new BridgeConfigurationSourceMetadata("wp12-test-only", new Dictionary<string, BridgeConfigurationValueSource>
        {
            ["addin.scanStartPort"] = new(
                BridgeConfigurationSourceKind.Environment,
                BridgeConfigurationLoader.AddinPortEnvironmentVariable),
            ["addin.scanEndPort"] = new(
                BridgeConfigurationSourceKind.Environment,
                BridgeConfigurationLoader.AddinPortEnvironmentVariable),
        }));

    /// <summary>
    /// TEST-HOST-ONLY attestation for the separately supervised Node fixture.
    /// It deliberately does not relax production Windows attestation: the
    /// fixture PID is supplied by the parent after its strict READY record and
    /// the connected server endpoint must be that exact IPv4 loopback port.
    /// The observed process start time makes PID reuse fail closed between the
    /// pre-dispatch and post-response checks.
    /// </summary>
    private sealed class FixtureAddinProcessAttestor : IAddinProcessAttestor
    {
        private const string FixtureRevitVersion = "2025";
        private const string FixtureImagePath = "addin-loopback-fixture/test-only";
        private readonly int _fixtureProcessId;
        private readonly int _fixturePort;

        internal FixtureAddinProcessAttestor(int fixtureProcessId, int fixturePort)
        {
            if (fixtureProcessId <= 0) throw new ArgumentOutOfRangeException(nameof(fixtureProcessId));
            if (fixturePort is < 1 or > 65535) throw new ArgumentOutOfRangeException(nameof(fixturePort));
            _fixtureProcessId = fixtureProcessId;
            _fixturePort = fixturePort;
        }

        public Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
            AddinConnectedPeer peer,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            EnsureExactFixtureEndpoint(peer);
            return Task.FromResult(ReadLiveFixtureAttestation());
        }

        public Task VerifyAfterResponseAsync(
            AddinConnectedPeer peer,
            AddinProcessAttestation attestation,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            EnsureExactFixtureEndpoint(peer);
            AddinProcessAttestation live = ReadLiveFixtureAttestation();
            if (attestation == null || attestation.Identity != live.Identity ||
                !string.Equals(attestation.RevitVersion, FixtureRevitVersion, StringComparison.Ordinal) ||
                !string.Equals(attestation.ImagePath, FixtureImagePath, StringComparison.Ordinal))
            {
                throw Failure("addin_fixture_process_identity_changed", "The test fixture process identity changed during the loopback call.");
            }

            return Task.CompletedTask;
        }

        private void EnsureExactFixtureEndpoint(AddinConnectedPeer peer)
        {
            ArgumentNullException.ThrowIfNull(peer);
            if (!peer.ServerEndPoint.Address.Equals(IPAddress.Loopback) ||
                peer.ServerEndPoint.Port != _fixturePort ||
                !IPAddress.IsLoopback(peer.ClientEndPoint.Address))
            {
                throw Failure("addin_fixture_endpoint_mismatch", "The test fixture connection was not the exact IPv4 loopback endpoint declared at READY.");
            }
        }

        private AddinProcessAttestation ReadLiveFixtureAttestation()
        {
            try
            {
                using Process process = Process.GetProcessById(_fixtureProcessId);
                process.Refresh();
                if (process.HasExited)
                {
                    throw Failure("addin_fixture_process_exited", "The declared test fixture process has exited.");
                }

                long startTime = process.StartTime.ToUniversalTime().ToFileTimeUtc();
                if (startTime <= 0)
                {
                    throw Failure("addin_fixture_process_identity_invalid", "The declared test fixture process has no stable start identity.");
                }

                return new AddinProcessAttestation(
                    new AddinProcessIdentity(_fixtureProcessId, startTime),
                    FixtureRevitVersion,
                    FixtureImagePath);
            }
            catch (AddinProcessAttestationException)
            {
                throw;
            }
            catch (ArgumentException exception)
            {
                throw Failure("addin_fixture_process_unavailable", "The declared test fixture process is unavailable.", exception);
            }
            catch (InvalidOperationException exception)
            {
                throw Failure("addin_fixture_process_unavailable", "The declared test fixture process is unavailable.", exception);
            }
        }

        private static AddinProcessAttestationException Failure(string code, string message, Exception? inner = null) =>
            new(code, message, inner);
    }

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

    /// <summary>
    /// Test-host-only scheduler clock. It recognizes only the frozen RBP/1
    /// heartbeat delay; all other coordinator waits retain their production
    /// durations. It never changes a received protocol acknowledgement.
    /// </summary>
    private sealed class TestHeartbeatClock : IRbpCoordinatorClock
    {
        private static readonly TimeSpan FrozenHeartbeatInterval = TimeSpan.FromSeconds(15);
        private readonly TimeSpan _testHeartbeatInterval;

        internal TestHeartbeatClock(int testHeartbeatIntervalMilliseconds)
        {
            _testHeartbeatInterval = TimeSpan.FromMilliseconds(testHeartbeatIntervalMilliseconds);
        }

        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

        public long MonotonicMilliseconds =>
            checked((long)Math.Floor(Stopwatch.GetTimestamp() * 1000d / Stopwatch.Frequency));

        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken = default) =>
            Task.Delay(delay == FrozenHeartbeatInterval ? _testHeartbeatInterval : delay, cancellationToken);
    }

    private sealed record Options(Uri GatewayUri, int AddinPort, int FixtureProcessId, string InstallRoot, string StateRoot, string DeviceId, string DeviceToken, string Fingerprint, string CertificateSha256, string Binding, int TestHeartbeatIntervalMilliseconds)
    {
        public static Options Parse(IReadOnlyList<string> args)
        {
            if (args.Count != 22) throw new ArgumentException("real worker host requires exactly eleven --key value pairs");
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
            if (!int.TryParse(Required("--fixture-pid"), out int fixturePid) || fixturePid <= 0) throw new ArgumentException("invalid fixture pid");
            if (!int.TryParse(Required("--test-heartbeat-interval-ms"), out int testHeartbeatIntervalMilliseconds) || testHeartbeatIntervalMilliseconds is < 250 or > 5_000) throw new ArgumentException("test heartbeat interval must be between 250 and 5000 milliseconds");
            Options result = new(endpoint, port, fixturePid, Required("--install-root"), Required("--state-root"), Required("--device-id"), Required("--device-token"), Required("--fingerprint"), Required("--certificate-sha256"), binding, testHeartbeatIntervalMilliseconds);
            if (values.Count != 0 || !result.Fingerprint.StartsWith("sha256:", StringComparison.Ordinal) || result.CertificateSha256.Length != 64) throw new ArgumentException("invalid test identity or certificate pin");
            return result;
        }
    }
}
