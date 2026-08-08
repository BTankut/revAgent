using System.Globalization;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.Tests.AddinLoopback;

[Collection(SocketIntegrationCollection.Name)]
public sealed class AddinDiscoveryTests
{
    private const long TestProcessStartFileTime = 133000000000000000;

    [Fact]
    public async Task DiscoverAsync_FileConfigurationProbesOnlyFrozenRangeInOrder()
    {
        var transport = new RecordingTransport(
            (endpoint, call, _, _) =>
            {
                if (endpoint.Port is 8081 or 8084)
                {
                    return Task.FromResult(
                        Success(
                            call,
                            StatusResult(
                                endpoint.Port,
                                processId: 4000 + endpoint.Port)));
                }

                return Task.FromException<AddinCallResult>(
                    TransportFailure("addin_connect_failed"));
            });

        AddinDiscoveryResult result = await CreateDiscovery(transport)
            .DiscoverAsync(FileConfiguration(8080, 8085));

        Assert.Equal(
            Enumerable.Range(8080, 6),
            transport.Calls.Select(observation => observation.Endpoint.Port));
        Assert.All(
            transport.Calls,
            observation =>
            {
                Assert.Equal("127.0.0.1", observation.Endpoint.Address.ToString());
                Assert.Equal("mcp_status", observation.Method);
                Assert.Empty(observation.Parameters);
            });
        Assert.Equal(
            new[] { 8081, 8084 },
            result.Sessions.Select(session => session.Target.Port));
        Assert.Equal(
            new[]
            {
                SessionKey(8081, 12081),
                SessionKey(8084, 12084),
            },
            result.Sessions.Select(session => session.LocalSessionKey));
        Assert.All(
            result.Sessions,
            session =>
            {
                Assert.Equal(
                    session.Status.Revit.ProcessId,
                    session.ProcessAttestation.Identity.ProcessId);
                Assert.Equal(
                    TrustedImagePath(),
                    session.ProcessAttestation.ImagePath);
            });
        Assert.Equal(AddinDiscoverySource.BoundedScan, result.Evidence.Source);
        Assert.Equal(6, result.Evidence.ProbedTargets.Count);
        Assert.Equal(2, result.Evidence.AcceptedTargets.Count);
        Assert.Equal(4, result.Evidence.RejectedTargets.Count);
        Assert.All(
            result.Evidence.RejectedTargets,
            rejection =>
                Assert.Equal(
                    AddinDiscoveryFailureKind.Unreachable,
                    rejection.Kind));
    }

    [Fact]
    public async Task DiscoverAsync_EnvironmentOverrideProbesExactlyOnePort()
    {
        const int Port = 8181;
        var transport = new RecordingTransport(
            (endpoint, call, _, _) =>
                Task.FromResult(
                    Success(call, StatusResult(endpoint.Port, processId: 991))));

        AddinDiscoveryResult result = await CreateDiscovery(transport)
            .DiscoverAsync(EnvironmentConfiguration(Port));

        Assert.Single(transport.Calls);
        Assert.Equal(Port, transport.Calls[0].Endpoint.Port);
        Assert.Single(result.Sessions);
        Assert.Equal(
            AddinDiscoverySource.ExplicitEnvironmentOverride,
            result.Evidence.Source);
    }

    [Fact]
    public async Task DiscoverAsync_RejectsSecondPortForTheSameRevitProcess()
    {
        const long ProcessId = 991;
        var transport = new RecordingTransport(
            (endpoint, call, _, _) =>
            {
                if (endpoint.Port is 8081 or 8084)
                {
                    return Task.FromResult(
                        Success(
                            call,
                            StatusResult(endpoint.Port, ProcessId)));
                }

                return Task.FromException<AddinCallResult>(
                    TransportFailure("addin_connect_failed"));
            });

        AddinDiscoveryResult result = await CreateDiscovery(transport)
            .DiscoverAsync(FileConfiguration(8080, 8085));

        ProbedAddinSession session = Assert.Single(result.Sessions);
        Assert.Equal(8081, session.Target.Port);
        AddinDiscoveryRejection duplicate = Assert.Single(
            result.Evidence.RejectedTargets,
            rejection =>
                rejection.Kind ==
                AddinDiscoveryFailureKind.DuplicateProcessIdentity);
        Assert.Equal(8084, duplicate.Target.Port);
        Assert.Equal("duplicate_revit_process_identity", duplicate.Code);
    }

    [Fact]
    public async Task DiscoverAsync_SpoofedFirstPeerCannotEliminateAttestedSession()
    {
        const long ProcessId = 991;
        var transport = new RecordingTransport(
            (endpoint, call, _, _) =>
            {
                if (endpoint.Port is 8080 or 8081)
                {
                    return Task.FromResult(
                        Success(
                            call,
                            StatusResult(endpoint.Port, ProcessId)));
                }

                return Task.FromException<AddinCallResult>(
                    TransportFailure("addin_connect_failed"));
            });
        var attestor = new RecordingProcessAttestor(
            (endpoint, status) =>
            {
                if (endpoint.Port == 8080)
                {
                    throw new AddinProcessAttestationException(
                        "addin_listener_process_id_mismatch",
                        "The spoofed peer does not own the reported Revit process.");
                }

                return TrustedAttestation(status);
            });

        AddinDiscoveryResult result = await CreateDiscovery(
            transport,
            attestor).DiscoverAsync(FileConfiguration(8080, 8085));

        ProbedAddinSession session = Assert.Single(result.Sessions);
        Assert.Equal(8081, session.Target.Port);
        AddinDiscoveryRejection spoofed = Assert.Single(
            result.Evidence.RejectedTargets,
            rejection =>
                rejection.Kind ==
                AddinDiscoveryFailureKind.ProcessAttestationFailure);
        Assert.Equal(8080, spoofed.Target.Port);
        Assert.Equal("addin_listener_process_id_mismatch", spoofed.Code);
        Assert.DoesNotContain(
            result.Evidence.RejectedTargets,
            rejection =>
                rejection.Kind ==
                AddinDiscoveryFailureKind.DuplicateProcessIdentity);
    }

    [Fact]
    public async Task DiscoverAsync_AttestationUnavailableRejectsPeerFailClosed()
    {
        const int Port = 8180;
        var transport = new RecordingTransport(
            (endpoint, call, _, _) =>
                Task.FromResult(
                    Success(call, StatusResult(endpoint.Port, processId: 990))));
        var attestor = new RecordingProcessAttestor(
            (_, _) =>
                throw new AddinProcessAttestationException(
                    "addin_process_attestation_unavailable",
                    "Attestation is unavailable."));

        AddinDiscoveryResult result = await CreateDiscovery(
            transport,
            attestor).DiscoverAsync(EnvironmentConfiguration(Port));

        Assert.Empty(result.Sessions);
        AddinDiscoveryRejection rejection =
            Assert.Single(result.Evidence.RejectedTargets);
        Assert.Equal(
            AddinDiscoveryFailureKind.ProcessAttestationFailure,
            rejection.Kind);
        Assert.Equal("addin_process_attestation_unavailable", rejection.Code);
    }

    [Fact]
    public async Task DiscoverAsync_ProcessStartIdentityPreventsPidReuseKeyCollision()
    {
        const int Port = 8186;
        const int ProcessId = 995;
        var transport = new RecordingTransport(
            (endpoint, call, _, _) =>
                Task.FromResult(
                    Success(call, StatusResult(endpoint.Port, ProcessId))));
        var firstAttestor = new RecordingProcessAttestor(
            (_, _) =>
                new AddinProcessAttestation(
                    new AddinProcessIdentity(ProcessId, 133000000000001000),
                    "2026",
                    TrustedImagePath()));
        var secondAttestor = new RecordingProcessAttestor(
            (_, _) =>
                new AddinProcessAttestation(
                    new AddinProcessIdentity(ProcessId, 133000000000002000),
                    "2026",
                    TrustedImagePath()));

        ProbedAddinSession first = Assert.Single(
            (await CreateDiscovery(transport, firstAttestor).DiscoverAsync(
                EnvironmentConfiguration(Port))).Sessions);
        ProbedAddinSession second = Assert.Single(
            (await CreateDiscovery(transport, secondAttestor).DiscoverAsync(
                EnvironmentConfiguration(Port))).Sessions);

        Assert.NotEqual(first.LocalSessionKey, second.LocalSessionKey);
        Assert.EndsWith(":started:133000000000001000", first.LocalSessionKey);
        Assert.EndsWith(":started:133000000000002000", second.LocalSessionKey);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DiscoverAsync_RejectsContradictoryConfigurationBeforeTransport(
        bool mixedSources)
    {
        var transport = new RecordingTransport(
            (_, _, _, _) =>
                throw new InvalidOperationException(
                    "Invalid configuration reached the transport."));
        ResolvedBridgeConfiguration configuration = mixedSources
            ? Configuration(
                8080,
                8085,
                FileSource(),
                EnvironmentSource())
            : FileConfiguration(8080, 8084);

        AddinDiscoveryConfigurationException error =
            await Assert.ThrowsAsync<AddinDiscoveryConfigurationException>(
                () => CreateDiscovery(transport).DiscoverAsync(configuration));

        Assert.Equal("addin_discovery_configuration_invalid", error.Code);
        Assert.Empty(transport.Calls);
    }

    [Theory]
    [InlineData(true, "mcp_status_port_mismatch")]
    [InlineData(false, "mcp_status_bound_address_mismatch")]
    public async Task DiscoverAsync_RejectsContradictoryTargetAttestation(
        bool wrongPort,
        string expectedCode)
    {
        const int Port = 8182;
        var transport = new RecordingTransport(
            (endpoint, call, _, _) =>
            {
                JObject status = StatusResult(
                    endpoint.Port,
                    processId: 992,
                    address: wrongPort ? "127.0.0.1" : "::1");
                if (wrongPort)
                {
                    RequireObject(status, "service")["port"] =
                        endpoint.Port + 1;
                }

                return Task.FromResult(Success(call, status));
            });

        AddinDiscoveryResult result = await CreateDiscovery(transport)
            .DiscoverAsync(EnvironmentConfiguration(Port));

        Assert.Empty(result.Sessions);
        AddinDiscoveryRejection rejection =
            Assert.Single(result.Evidence.RejectedTargets);
        Assert.Equal(
            AddinDiscoveryFailureKind.TargetAttestationMismatch,
            rejection.Kind);
        Assert.Equal(expectedCode, rejection.Code);
    }

    [Theory]
    [InlineData("unsupported", "UnsupportedContract")]
    [InlineData("jsonrpc", "ProbeJsonRpcError")]
    public async Task DiscoverAsync_ClassifiesUnsupportedAndJsonRpcProbeFailures(
        string mode,
        string expectedKind)
    {
        const int Port = 8183;
        var transport = new RecordingTransport(
            (endpoint, call, _, _) =>
            {
                if (mode == "jsonrpc")
                {
                    return Task.FromResult(JsonRpcError(call));
                }

                JObject status = StatusResult(endpoint.Port, processId: 993);
                status["addinLoopbackContractVersion"] = 2;
                return Task.FromResult(Success(call, status));
            });

        AddinDiscoveryResult result = await CreateDiscovery(transport)
            .DiscoverAsync(EnvironmentConfiguration(Port));

        Assert.Empty(result.Sessions);
        Assert.Equal(
            Enum.Parse<AddinDiscoveryFailureKind>(expectedKind),
            Assert.Single(result.Evidence.RejectedTargets).Kind);
    }

    [Fact]
    public async Task DiscoverAsync_PreCancelledLifetimesAbortWithoutTransport()
    {
        var transport = new RecordingTransport(
            (_, _, _, _) =>
                throw new InvalidOperationException(
                    "Cancelled discovery reached the transport."));
        using var cancellation = new CancellationTokenSource();
        using var shutdown = new CancellationTokenSource();
        cancellation.Cancel();
        shutdown.Cancel();
        AddinDiscovery discovery = CreateDiscovery(transport);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => discovery.DiscoverAsync(
                EnvironmentConfiguration(8184),
                cancellationToken: cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => discovery.DiscoverAsync(
                EnvironmentConfiguration(8184),
                transportShutdownToken: shutdown.Token));

        Assert.Empty(transport.Calls);
    }

    [Fact]
    public async Task DiscoverAsync_TransportShutdownFailureAbortsTheScan()
    {
        var transport = new RecordingTransport(
            (_, _, _, _) =>
                Task.FromException<AddinCallResult>(
                    TransportFailure("addin_transport_shutdown")));

        AddinTransportException error =
            await Assert.ThrowsAsync<AddinTransportException>(
                () => CreateDiscovery(transport).DiscoverAsync(
                    FileConfiguration(8080, 8085)));

        Assert.Equal("addin_transport_shutdown", error.Code);
        Assert.Single(transport.Calls);
    }

    [Fact]
    public async Task DiscoverAsync_CallerCancellationAfterProbeIsNotAccepted()
    {
        using var cancellation = new CancellationTokenSource();
        var transport = new RecordingTransport(
            (endpoint, call, _, _) =>
            {
                cancellation.Cancel();
                return Task.FromResult(
                    Success(
                        call,
                        StatusResult(endpoint.Port, processId: 994)));
            });

        OperationCanceledException error =
            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => CreateDiscovery(transport).DiscoverAsync(
                    EnvironmentConfiguration(8185),
                    cancellationToken: cancellation.Token));

        Assert.Equal(cancellation.Token, error.CancellationToken);
        Assert.Single(transport.Calls);
    }

    [Fact]
    public async Task DiscoverAsync_CallerCancellationClosesInFlightProbe()
    {
        using var cancellation = new CancellationTokenSource();
        var requestObserved = new TaskCompletionSource<JObject>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var peerEof = new TaskCompletionSource<int>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedTcpPeer(
            async (stream, cancellationToken) =>
            {
                JObject request = await ScriptedTcpPeer.ReadRequestAsync(
                    stream,
                    cancellationToken);
                requestObserved.SetResult(request);
                var buffer = new byte[1];
                int bytesRead = await stream.ReadAsync(
                    buffer,
                    cancellationToken);
                peerEof.SetResult(bytesRead);
            });

        Task<AddinDiscoveryResult> discoveryTask = CreateDiscovery(
            new AddinTcpTransport(),
            new FixedProcessAttestor(994)).DiscoverAsync(
                EnvironmentConfiguration(peer.Port),
                probeTimeout: SocketIntegrationCollection.CoordinationTimeout,
                cancellationToken: cancellation.Token);
        JObject observedRequest = await requestObserved.Task.WaitAsync(
            SocketIntegrationCollection.CoordinationTimeout);
        Assert.Equal(
            "mcp_status",
            observedRequest["method"]!.Value<string>());

        cancellation.Cancel();

        OperationCanceledException error =
            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => discoveryTask.WaitAsync(
                    SocketIntegrationCollection.CoordinationTimeout));
        Assert.Equal(cancellation.Token, error.CancellationToken);
        Assert.Equal(
            0,
            await peerEof.Task.WaitAsync(
                SocketIntegrationCollection.CoordinationTimeout));
    }

    [Fact]
    public async Task DiscoverAsync_WorkerShutdownClosesInFlightProbe()
    {
        using var shutdown = new CancellationTokenSource();
        var requestObserved = new TaskCompletionSource<JObject>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var peerEof = new TaskCompletionSource<int>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedTcpPeer(
            async (stream, cancellationToken) =>
            {
                JObject request = await ScriptedTcpPeer.ReadRequestAsync(
                    stream,
                    cancellationToken);
                requestObserved.SetResult(request);
                var buffer = new byte[1];
                int bytesRead = await stream.ReadAsync(
                    buffer,
                    cancellationToken);
                peerEof.SetResult(bytesRead);
            });

        Task<AddinDiscoveryResult> discoveryTask = CreateDiscovery(
            new AddinTcpTransport(),
            new FixedProcessAttestor(994)).DiscoverAsync(
                EnvironmentConfiguration(peer.Port),
                probeTimeout: SocketIntegrationCollection.CoordinationTimeout,
                transportShutdownToken: shutdown.Token);
        JObject observedRequest = await requestObserved.Task.WaitAsync(
            SocketIntegrationCollection.CoordinationTimeout);
        Assert.Equal(
            "mcp_status",
            observedRequest["method"]!.Value<string>());

        shutdown.Cancel();

        OperationCanceledException error =
            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => discoveryTask.WaitAsync(
                    SocketIntegrationCollection.CoordinationTimeout));
        Assert.Equal(shutdown.Token, error.CancellationToken);
        Assert.Equal(
            0,
            await peerEof.Task.WaitAsync(
                SocketIntegrationCollection.CoordinationTimeout));
    }

    [Fact]
    public async Task DiscoverAsync_RealTcpProbeUsesFrozenRequestAndAcceptsStatus()
    {
        JObject? observedRequest = null;
        await using var peer = new ScriptedTcpPeer(
            async (stream, cancellationToken) =>
            {
                observedRequest = await ScriptedTcpPeer.ReadRequestAsync(
                    stream,
                    cancellationToken);
                string id = observedRequest["id"]!.Value<string>()!;
                int listenerPort =
                    ((System.Net.IPEndPoint)stream.Socket.LocalEndPoint!).Port;
                byte[] frame = ScriptedTcpPeer.SuccessFrame(
                    id,
                    StatusResult(listenerPort, processId: 994));
                await stream.WriteAsync(frame, cancellationToken);
            });

        AddinDiscoveryResult result = await CreateDiscovery(
            new AddinTcpTransport(),
            new FixedProcessAttestor(994)).DiscoverAsync(
                EnvironmentConfiguration(peer.Port),
                probeTimeout: SocketIntegrationCollection.CoordinationTimeout);

        Assert.NotNull(observedRequest);
        Assert.Equal("mcp_status", observedRequest!["method"]!.Value<string>());
        Assert.Empty(Assert.IsType<JObject>(observedRequest["params"]));
        Assert.Single(result.Sessions);
        Assert.Equal(peer.Port, result.Sessions[0].Target.Port);
    }

    private static AddinDiscovery CreateDiscovery(
        IAddinTransport transport,
        IAddinProcessAttestor? processAttestor = null) =>
        new(
            transport,
            processAttestor ?? new RecordingProcessAttestor(
                (_, status) => TrustedAttestation(status)));

    private static AddinProcessAttestation TrustedAttestation(
        AddinStatusSnapshot status)
    {
        int processId = checked((int)status.Revit.ProcessId);
        return new AddinProcessAttestation(
            new AddinProcessIdentity(
                processId,
                TestProcessStartFileTime + processId),
            status.Revit.Version,
            TrustedImagePath());
    }

    private static string TrustedImagePath() =>
        @"C:\Program Files\Autodesk\Revit 2026\Revit.exe";

    private static string SessionKey(int port, int processId) =>
        "port:" +
        port.ToString(CultureInfo.InvariantCulture) +
        ":pid:" +
        processId.ToString(CultureInfo.InvariantCulture) +
        ":started:" +
        (TestProcessStartFileTime + processId).ToString(
            CultureInfo.InvariantCulture);

    private static ResolvedBridgeConfiguration FileConfiguration(
        int startPort,
        int endPort) =>
        Configuration(
            startPort,
            endPort,
            FileSource(),
            FileSource());

    private static ResolvedBridgeConfiguration EnvironmentConfiguration(
        int port) =>
        Configuration(
            port,
            port,
            EnvironmentSource(),
            EnvironmentSource());

    private static ResolvedBridgeConfiguration Configuration(
        int startPort,
        int endPort,
        BridgeConfigurationValueSource startSource,
        BridgeConfigurationValueSource endSource) =>
        new(
            schemaVersion: 1,
            gatewayUri: new Uri("wss://127.0.0.1:4317/rbp"),
            addin: new BridgeAddinConfiguration(startPort, endPort),
            logging: new BridgeLoggingConfiguration(1024 * 1024, 3),
            sourceMetadata: new BridgeConfigurationSourceMetadata(
                "bridge.config.json",
                new Dictionary<string, BridgeConfigurationValueSource>(
                    StringComparer.Ordinal)
                {
                    ["addin.scanStartPort"] = startSource,
                    ["addin.scanEndPort"] = endSource,
                }));

    private static BridgeConfigurationValueSource FileSource() =>
        new(
            BridgeConfigurationSourceKind.File,
            "bridge.config.json");

    private static BridgeConfigurationValueSource EnvironmentSource() =>
        new(
            BridgeConfigurationSourceKind.Environment,
            BridgeConfigurationLoader.AddinPortEnvironmentVariable);

    private static JObject StatusResult(
        int peerPort,
        long processId,
        string address = "127.0.0.1")
    {
        JObject scenario = LoadProtocolFixture();
        JObject result = (JObject)RequireObject(
            RequireObject(scenario, "response"),
            "result").DeepClone();
        JObject service = RequireObject(result, "service");
        service["port"] = peerPort;
        service["boundAddresses"] = new JArray(address);
        RequireObject(result, "revit")["processId"] = processId;
        return result;
    }

    private static AddinCallResult Success(
        AddinCall call,
        JObject result)
    {
        var envelope = new JObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = call.InvocationId,
            ["result"] = result.DeepClone(),
        };
        AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(
            Encoding.UTF8.GetBytes(envelope.ToString(Formatting.None)),
            call.InvocationId);
        return new AddinCallResult(response, ResponseEvidence());
    }

    private static AddinCallResult JsonRpcError(AddinCall call)
    {
        var envelope = new JObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = call.InvocationId,
            ["error"] = new JObject
            {
                ["code"] = -32601,
                ["message"] = "Method not found",
            },
        };
        AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(
            Encoding.UTF8.GetBytes(envelope.ToString(Formatting.None)),
            call.InvocationId);
        return new AddinCallResult(response, ResponseEvidence());
    }

    private static AddinTransportException TransportFailure(string code) =>
        new(
            code,
            code,
            new AddinTransportEvidence(
                AddinDispatchState.NotStarted,
                RequestPayloadBytes: 0,
                RequestFrameBytes: 0,
                BytesWrittenLowerBound: 0,
                RequestFullyWritten: false,
                ResponseBytesObserved: 0));

    private static AddinTransportEvidence ResponseEvidence() =>
        new(
            AddinDispatchState.ResponseObserved,
            RequestPayloadBytes: 1,
            RequestFrameBytes: 5,
            BytesWrittenLowerBound: 5,
            RequestFullyWritten: true,
            ResponseBytesObserved: 5);

    private static JObject LoadProtocolFixture()
    {
        string path = Path.Combine(
            FindRepositoryRoot(),
            "packages",
            "protocol",
            "fixtures",
            "addin-loopback",
            "v1",
            "mcp-status.positive.json");
        using var textReader = File.OpenText(path);
        using var jsonReader = new JsonTextReader(textReader)
        {
            DateParseHandling = DateParseHandling.None,
            FloatParseHandling = FloatParseHandling.Decimal,
        };
        return JObject.Load(jsonReader);
    }

    private static string FindRepositoryRoot()
    {
        DirectoryInfo? current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current != null)
        {
            if (File.Exists(Path.Combine(current.FullName, "AGENTS.md")) &&
                Directory.Exists(
                    Path.Combine(current.FullName, "packages", "protocol")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate the revAgent repository root.");
    }

    private static JObject RequireObject(JObject parent, string propertyName) =>
        Assert.IsType<JObject>(parent[propertyName]);

    private sealed record ObservedCall(
        AddinEndpoint Endpoint,
        string Method,
        JObject Parameters);

    private sealed class RecordingProcessAttestor : IAddinProcessAttestor
    {
        private readonly Func<
            AddinEndpoint,
            AddinStatusSnapshot,
            AddinProcessAttestation> _handler;
        private AddinEndpoint? _target;
        private AddinStatusSnapshot? _status;

        internal RecordingProcessAttestor(
            Func<
                AddinEndpoint,
                AddinStatusSnapshot,
                AddinProcessAttestation> handler)
        {
            _handler = handler;
        }

        internal void Prepare(
            AddinEndpoint target,
            AddinStatusSnapshot status)
        {
            _target = target;
            _status = status;
        }

        public Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
            AddinConnectedPeer peer,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_target == null || _status == null)
            {
                throw new InvalidOperationException(
                    "The recording attestor was not prepared.");
            }

            return Task.FromResult(_handler(_target, _status));
        }

        public Task VerifyAfterResponseAsync(
            AddinConnectedPeer peer,
            AddinProcessAttestation attestation,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        }
    }

    private sealed class FixedProcessAttestor : IAddinProcessAttestor
    {
        private readonly int _processId;

        internal FixedProcessAttestor(int processId)
        {
            _processId = processId;
        }

        public Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
            AddinConnectedPeer peer,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(
                new AddinProcessAttestation(
                    new AddinProcessIdentity(
                        _processId,
                        TestProcessStartFileTime + _processId),
                    "2026",
                    TrustedImagePath()));
        }

        public Task VerifyAfterResponseAsync(
            AddinConnectedPeer peer,
            AddinProcessAttestation attestation,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        }
    }

    private sealed class RecordingTransport : IAddinTransport
    {
        private readonly Func<
            AddinEndpoint,
            AddinCall,
            CancellationToken,
            CancellationToken,
            Task<AddinCallResult>> _handler;

        internal RecordingTransport(
            Func<
                AddinEndpoint,
                AddinCall,
                CancellationToken,
                CancellationToken,
                Task<AddinCallResult>> handler)
        {
            _handler = handler;
        }

        internal List<ObservedCall> Calls { get; } = new();

        public async Task<AddinCallResult> InvokeAsync(
            AddinEndpoint endpoint,
            AddinCall call,
            CancellationToken preDispatchCancellationToken = default,
            CancellationToken transportShutdownToken = default,
            IAddinProcessAttestor? processAttestor = null)
        {
            Calls.Add(
                new ObservedCall(
                    endpoint,
                    call.Method,
                    call.CopyParameters()));
            AddinCallResult result = await _handler(
                endpoint,
                call,
                preDispatchCancellationToken,
                transportShutdownToken);
            if (processAttestor == null || !result.Response.IsSuccess)
            {
                return result;
            }

            AddinStatusSnapshot status;
            try
            {
                status = AddinStatusParser.Parse(result.Response);
            }
            catch (AddinStatusContractException)
            {
                return result;
            }
            if (processAttestor is RecordingProcessAttestor recording)
            {
                recording.Prepare(endpoint, status);
            }

            var peer = new AddinConnectedPeer(
                new System.Net.IPEndPoint(
                    System.Net.IPAddress.Loopback,
                    50000 + (endpoint.Port % 1000)),
                new System.Net.IPEndPoint(
                    endpoint.Address,
                    endpoint.Port));
            try
            {
                AddinProcessAttestation attestation =
                    await processAttestor.AttestBeforeDispatchAsync(
                        peer,
                        preDispatchCancellationToken);
                await processAttestor.VerifyAfterResponseAsync(
                    peer,
                    attestation,
                    transportShutdownToken);
                return result with
                {
                    ProcessAttestation = attestation,
                };
            }
            catch (AddinProcessAttestationException exception)
            {
                throw new AddinTransportException(
                    exception.Code,
                    exception.Message,
                    new AddinTransportEvidence(
                        AddinDispatchState.NotStarted,
                        RequestPayloadBytes: 1,
                        RequestFrameBytes: 5,
                        BytesWrittenLowerBound: 0,
                        RequestFullyWritten: false,
                        ResponseBytesObserved: 0),
                    exception);
            }
        }
    }
}
