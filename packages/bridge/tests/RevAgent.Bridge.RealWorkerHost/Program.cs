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
    private const int MaxRecoveryCarrierObservations = 64;
    private const int MaxRecoveryCarrierObservationBytes = 16 * 1024;

    public static async Task<int> Main(string[] args)
    {
        try
        {
            Options options = Options.Parse(args);
            var recoveryObservations = new RecoveryCarrierObservationRing(
                MaxRecoveryCarrierObservations,
                MaxRecoveryCarrierObservationBytes);
            var reconnectObservations = new ReconnectObservationRing(
                MaxRecoveryCarrierObservations,
                MaxRecoveryCarrierObservationBytes);
            var postWriteFault = options.TestC39D0PostWriteFault
                ? new OneShotPostWriteRecoveryFault()
                : null;
            Func<CancellationToken, Task>? postWriteFaultCallback =
                postWriteFault is null ? null : postWriteFault.InvokeAsync;
            await using WorkerGatewayRuntime runtime = Compose(options,
                recoveryObservations, reconnectObservations,
                postWriteFaultCallback);
            using var cancellation = new CancellationTokenSource();
            Task run = runtime.RunAsync(cancellation.Token);
            await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new
            {
                ready = true,
                component = "bridge_worker",
                contract = "wp12-real-worker-host/v1",
                controlVersion = 1,
                maxControlLineBytes = MaxControlLineBytes,
                actions = new[] { "read_recovery_observations", "poll_document_context", "shutdown" },
                c39Profile = options.TestC39D0PostWriteFault
                    ? "d0_postwrite_once" : "none",
                pid = Environment.ProcessId,
                bindings = new[] { options.Binding },
                state_root_redacted = true,
                program_data_touched = false,
                dpapi_used = false,
                external_endpoint = false,
            })).ConfigureAwait(false);

            while (true)
            {
                string? command = await Console.In.ReadLineAsync()
                    .ConfigureAwait(false);
                if (command is null || Encoding.UTF8.GetByteCount(command) >
                    MaxControlLineBytes)
                    throw new InvalidOperationException(
                        "test host control is missing or exceeds its fixed bound");
                using JsonDocument control = JsonDocument.Parse(command);
                JsonElement root = control.RootElement;
                if (root.ValueKind != JsonValueKind.Object ||
                    !root.TryGetProperty("controlVersion", out JsonElement version) ||
                    version.GetInt32() != 1 ||
                    !root.TryGetProperty("id", out JsonElement id) ||
                    id.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(id.GetString()) ||
                    !root.TryGetProperty("action", out JsonElement action) ||
                    action.ValueKind != JsonValueKind.String)
                    throw new InvalidOperationException(
                        "test host control is invalid");
                if (action.GetString() == "read_recovery_observations" &&
                    root.EnumerateObject().Count() == 3)
                {
                    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new
                    {
                        controlVersion = 1, id = id.GetString(), ok = true,
                        result = new {
                            observations = recoveryObservations.Snapshot(),
                            reconnectWatchObservations = reconnectObservations.Snapshot(),
                        },
                    })).ConfigureAwait(false);
                    continue;
                }
                if (action.GetString() == "poll_document_context" &&
                    root.EnumerateObject().Count() == 3)
                {
                    IReadOnlyList<string> rsids = runtime.Coordinator
                        .GetSnapshot().ActiveRsids;
                    Task<RbpImmediatePollOutcome>? poll = rsids.Count == 1
                        ? runtime.Coordinator.RequestImmediateDocumentContextPollAsync(rsids[0])
                        : null;
                    if (poll is null)
                        throw new InvalidOperationException(
                            "current attested D2 document-context watch is unavailable");
                    RbpImmediatePollOutcome outcome = await poll.WaitAsync(
                        TimeSpan.FromSeconds(10)).ConfigureAwait(false);
                    string state = outcome switch
                    {
                        RbpImmediatePollOutcome.Emitted => "emitted",
                        RbpImmediatePollOutcome.NoSend => "no_send",
                        RbpImmediatePollOutcome.Cancelled => "cancelled",
                        RbpImmediatePollOutcome.Fault => "fault",
                        _ => throw new InvalidOperationException("invalid immediate poll outcome"),
                    };
                    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new
                    {
                        controlVersion = 1, id = id.GetString(), ok = true,
                        result = new { state },
                    })).ConfigureAwait(false);
                    continue;
                }
                if (action.GetString() != "shutdown" ||
                    root.EnumerateObject().Count() != 3)
                    throw new InvalidOperationException(
                        "test host control action is not allowed");
                await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new
                {
                    controlVersion = 1, id = id.GetString(), ok = true,
                    result = new { stopping = true },
                })).ConfigureAwait(false);
                break;
            }
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

    private static WorkerGatewayRuntime Compose(
        Options options,
        IRbpRecoveryCarrierObservationSink recoveryCarrierObservationSink,
        IRbpReconnectObservationSink reconnectObservationSink,
        Func<CancellationToken, Task>? afterRecoveryCarrierWriteBeforeAck)
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
            // The D0 observation policy is inseparable from the fixed C39
            // post-write profile. C38 and ordinary real-worker launches stay
            // on the sealed Never policy.
            var omittedOriginObservation = options.TestC39D0PostWriteFault
                ? RbpConformanceOmittedOriginObservation.CreateFixtureOneShot(
                    fixtureAttestor.ReadLiveFixtureAttestation)
                : RbpConformanceOmittedOriginObservation.Never;
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
                    CarrierProducer: carrier,
                    OmittedOriginObservation: omittedOriginObservation,
                    RecoveryCarrierObservationSink:
                        recoveryCarrierObservationSink,
                    ReconnectObservationSink: reconnectObservationSink,
                    AfterRecoveryCarrierWriteBeforeAck:
                        afterRecoveryCarrierWriteBeforeAck));
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
        //
        // A payload-bearing observation is only safe to admit when the watcher
        // already supplied its canonical context digest.  This host is a
        // diagnostic sink, so it must neither re-canonicalize a payload nor
        // manufacture a correlate when that proof is absent.
        bool hasPayloadHash = observation.PayloadHash is not null;
        bool hasContextDigest = observation.ContextDigest is not null;
        bool hasSourceRevision = observation.SourceRevision is not null;
        bool hasCacheIncarnationDigest = observation.CacheIncarnationDigest is not null;
        if (!IsDiagnosticSha256(observation.RsidHash) ||
            hasPayloadHash != hasContextDigest ||
            hasSourceRevision != hasCacheIncarnationDigest ||
            (hasPayloadHash &&
             (!IsDiagnosticSha256(observation.PayloadHash) ||
              !IsBareLowercaseSha256(observation.ContextDigest))) ||
            (hasSourceRevision &&
             (observation.SourceRevision <= 0 ||
              !IsDiagnosticSha256(observation.CacheIncarnationDigest))))
        {
            return ValueTask.CompletedTask;
        }

        WriteObservation(new
        {
            contractVersion = observation.ContractVersion,
            @event = observation.Event,
            timestamp = DateTimeOffset.UtcNow.ToString("O"),
            stage = observation.Stage,
            outcome = observation.Outcome,
            rsidHash = observation.RsidHash,
            payloadHash = observation.PayloadHash,
            contextDigest = observation.ContextDigest,
            sequence = observation.Sequence,
            sourceRevision = observation.SourceRevision,
            cacheIncarnationDigest = observation.CacheIncarnationDigest,
        });
        return ValueTask.CompletedTask;
    }

    private static bool IsBareLowercaseSha256(string? value)
    {
        if (value is null || value.Length != 64)
            return false;

        foreach (char character in value)
        {
            if ((character < '0' || character > '9') &&
                (character < 'a' || character > 'f'))
                return false;
        }

        return true;
    }

    private static bool IsDiagnosticSha256(string? value) =>
        value is not null &&
        value.StartsWith("sha256:", StringComparison.Ordinal) &&
        IsBareLowercaseSha256(value["sha256:".Length..]);

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

    /// <summary>
    /// Test-host-only bounded diagnostic retention.  It is intentionally not
    /// reachable from production composition, configuration, or MCP.
    /// </summary>
    private sealed class RecoveryCarrierObservationRing :
        IRbpRecoveryCarrierObservationSink
    {
        private readonly object _gate = new();
        private readonly Queue<RbpRecoveryCarrierObservation> _rows = new();
        private readonly int _maxRows;
        private readonly int _maxBytes;
        private int _bytes;

        internal RecoveryCarrierObservationRing(int maxRows, int maxBytes)
        {
            _maxRows = maxRows;
            _maxBytes = maxBytes;
        }

        public void Observe(RbpRecoveryCarrierObservation observation)
        {
            try
            {
                string phase = RbpRecoveryCarrierObservation.PhaseLabel(
                    observation.Phase);
                if (!IsDiagnosticSha256(observation.HashedRecoveryId) ||
                    !IsDiagnosticSha256(observation.OuterDigest) ||
                    observation.Sequence < 1 || observation.Ordinal < 1 ||
                    phase is not ("materialized" or "write" or
                        "restart_resend" or "ack")) return;
                int size = Encoding.UTF8.GetByteCount(phase) +
                    Encoding.UTF8.GetByteCount(observation.HashedRecoveryId) +
                    Encoding.UTF8.GetByteCount(observation.OuterDigest) + 32;
                if (size > _maxBytes) return;
                lock (_gate)
                {
                    while (_rows.Count > 0 &&
                        (_rows.Count >= _maxRows || _bytes + size > _maxBytes))
                    {
                        RbpRecoveryCarrierObservation removed = _rows.Dequeue();
                        _bytes -= RowBytes(removed);
                    }
                    if (_rows.Count >= _maxRows || _bytes + size > _maxBytes)
                        return;
                    _rows.Enqueue(observation);
                    _bytes += size;
                }
            }
            catch
            {
                // An observer cannot affect carrier send/ack behavior.
            }
        }

        internal object[] Snapshot()
        {
            lock (_gate)
            {
                return _rows.Select(row => new
                {
                    phase = RbpRecoveryCarrierObservation.PhaseLabel(row.Phase),
                    hashedRecoveryId = row.HashedRecoveryId,
                    sequence = row.Sequence,
                    outerDigest = row.OuterDigest,
                    ordinal = row.Ordinal,
                }).Cast<object>().ToArray();
            }
        }

        private static int RowBytes(RbpRecoveryCarrierObservation row) =>
            Encoding.UTF8.GetByteCount(
                RbpRecoveryCarrierObservation.PhaseLabel(row.Phase)) +
            Encoding.UTF8.GetByteCount(row.HashedRecoveryId) +
            Encoding.UTF8.GetByteCount(row.OuterDigest) + 32;
    }

    private sealed class ReconnectObservationRing : IRbpReconnectObservationSink
    {
        private readonly object _gate = new();
        private readonly Queue<RbpReconnectObservation> _rows = new();
        private readonly int _maxRows;
        private readonly int _maxBytes;
        private int _bytes;

        internal ReconnectObservationRing(int maxRows, int maxBytes)
        {
            _maxRows = maxRows;
            _maxBytes = maxBytes;
        }

        public void Observe(RbpReconnectObservation observation)
        {
            try
            {
                if (observation.Generation < 1 || observation.Ordinal < 1 ||
                    !IsDiagnosticSha256(observation.RsidHash) ||
                    !IsDiagnosticSha256(observation.SessionBindingDigest) ||
                    !IsDiagnosticSha256(observation.ConnectionDigest)) return;
                int bytes = 3 * ("sha256:".Length + 64) + 32;
                lock (_gate)
                {
                    while (_rows.Count > 0 &&
                        (_rows.Count >= _maxRows || _bytes + bytes > _maxBytes))
                    {
                        _rows.Dequeue();
                        _bytes -= 3 * ("sha256:".Length + 64) + 32;
                    }
                    if (_rows.Count >= _maxRows || _bytes + bytes > _maxBytes)
                        return;
                    _rows.Enqueue(observation);
                    _bytes += bytes;
                }
            }
            catch { }
        }

        internal object[] Snapshot()
        {
            lock (_gate)
            {
                return _rows.Select(row => new {
                    phase = row.Phase == RbpReconnectObservationPhase.ResumeAcknowledgementApplied
                        ? "resume_ack_applied" : "watcher_started",
                    generation = row.Generation,
                    ordinal = row.Ordinal,
                    rsidHash = row.RsidHash,
                    sessionBindingDigest = row.SessionBindingDigest,
                    connectionDigest = row.ConnectionDigest,
                }).Cast<object>().ToArray();
            }
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

        internal AddinProcessAttestation ReadLiveFixtureAttestation()
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

    /// <summary>Fixed test-host launch profile: one close after one carrier write.</summary>
    private sealed class OneShotPostWriteRecoveryFault
    {
        private int _used;

        internal Task InvokeAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (Interlocked.Exchange(ref _used, 1) == 0)
            {
                throw new RbpGatewayTransportException(
                    RbpGatewayFailureKind.Network,
                    "Test-only C39 post-write recovery cycle close.");
            }
            return Task.CompletedTask;
        }
    }

    private sealed record Options(Uri GatewayUri, int AddinPort, int FixtureProcessId, string InstallRoot, string StateRoot, string DeviceId, string DeviceToken, string Fingerprint, string CertificateSha256, string Binding, int TestHeartbeatIntervalMilliseconds, bool TestC39D0PostWriteFault)
    {
        public static Options Parse(IReadOnlyList<string> args)
        {
            if (args.Count is not (22 or 24)) throw new ArgumentException("real worker host requires fixed --key value pairs");
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
            bool testC39D0PostWriteFault = values.Remove("--test-c39-profile", out string? profile);
            if (testC39D0PostWriteFault && !string.Equals(profile, "d0_postwrite_once", StringComparison.Ordinal)) throw new ArgumentException("invalid C39 test profile");
            Options result = new(endpoint, port, fixturePid, Required("--install-root"), Required("--state-root"), Required("--device-id"), Required("--device-token"), Required("--fingerprint"), Required("--certificate-sha256"), binding, testHeartbeatIntervalMilliseconds, testC39D0PostWriteFault);
            if (values.Count != 0 || !result.Fingerprint.StartsWith("sha256:", StringComparison.Ordinal) || result.CertificateSha256.Length != 64) throw new ArgumentException("invalid test identity or certificate pin");
            return result;
        }
    }
}
