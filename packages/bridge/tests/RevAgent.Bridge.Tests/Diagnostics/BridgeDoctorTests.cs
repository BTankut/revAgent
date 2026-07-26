using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Bootstrap.Diagnostics;

namespace RevAgent.Bridge.Tests.Diagnostics;

public sealed class BridgeDoctorTests
{
    [Fact]
    public async Task RunAsync_ReachableEndpoints_ReportsTcpOnlyEvidence()
    {
        using var gatewayListener = StartListener();
        using var addinListener = StartListener();
        var gatewayAccept = gatewayListener.AcceptTcpClientAsync();
        var addinAccept = addinListener.AcceptTcpClientAsync();
        var configuration = CreateConfiguration(
            GetPort(gatewayListener),
            GetPort(addinListener),
            GetPort(addinListener));

        var report = await BridgeDoctor.RunAsync(
            configuration,
            FastOptions());

        using var gatewayClient = await gatewayAccept.WaitAsync(TimeSpan.FromSeconds(2));
        using var addinClient = await addinAccept.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(BridgeDoctor.ReportSchemaVersion, report.SchemaVersion);
        Assert.True(report.Success);
        Assert.True(report.Gateway.DnsResolved);
        Assert.True(report.Gateway.TcpReachable);
        Assert.False(report.Gateway.RbpAuthenticated);
        Assert.Equal(
            new[] { GetPort(addinListener) },
            report.Addin.ReachablePorts);
        Assert.Equal(0, report.Addin.BytesSent);
        Assert.False(report.Addin.ShapeVerified);
        Assert.True(Assert.Single(report.Addin.Probes).TcpReachable);
    }

    [Fact]
    public async Task RunAsync_AddinProbeConnectsToLoopbackAndSendsNoBytes()
    {
        using var gatewayListener = StartListener();
        using var addinListener = StartListener();
        var gatewayAccept = gatewayListener.AcceptTcpClientAsync();
        var addinAccept = addinListener.AcceptTcpClientAsync();
        var configuration = CreateConfiguration(
            GetPort(gatewayListener),
            GetPort(addinListener),
            GetPort(addinListener));

        var report = await BridgeDoctor.RunAsync(
            configuration,
            FastOptions());

        using var gatewayClient = await gatewayAccept.WaitAsync(TimeSpan.FromSeconds(2));
        using var addinClient = await addinAccept.WaitAsync(TimeSpan.FromSeconds(2));
        var received = new byte[1];
        var bytesRead = await addinClient.GetStream()
            .ReadAsync(received)
            .AsTask()
            .WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(0, bytesRead);
        Assert.Equal(0, report.Addin.BytesSent);
        Assert.False(report.Addin.ShapeVerified);
    }

    [Fact]
    public async Task RunAsync_UnreachableEndpoints_RemainsSuccessfulDiagnosticReport()
    {
        var gatewayPort = ReserveThenReleasePort();
        var addinPort = ReserveThenReleasePort();
        var configuration = CreateConfiguration(
            gatewayPort,
            addinPort,
            addinPort);

        var report = await BridgeDoctor.RunAsync(
            configuration,
            FastOptions());

        Assert.True(report.Success);
        Assert.True(report.Gateway.DnsResolved);
        Assert.False(report.Gateway.TcpReachable);
        Assert.False(report.Gateway.RbpAuthenticated);
        Assert.Empty(report.Addin.ReachablePorts);
        Assert.False(Assert.Single(report.Addin.Probes).TcpReachable);
        Assert.False(report.Addin.ShapeVerified);
    }

    [Fact]
    public async Task RunAsync_DnsFailure_IsBoundedAndReportedWithoutEndpointClaims()
    {
        var configuration = CreateConfiguration(
            gatewayPort: 443,
            scanStartPort: ReserveThenReleasePort(),
            scanEndPort: ReserveThenReleasePort(),
            gatewayHost: $"missing-{Guid.NewGuid():N}.invalid");
        var options = new BridgeDoctorOptions(
            GatewayProbeTimeout: TimeSpan.FromMilliseconds(200),
            AddinPortProbeTimeout: TimeSpan.FromMilliseconds(50),
            OverallTimeout: TimeSpan.FromMilliseconds(500));
        var stopwatch = Stopwatch.StartNew();

        var report = await BridgeDoctor.RunAsync(configuration, options);

        stopwatch.Stop();
        Assert.True(report.Success);
        Assert.False(report.Gateway.DnsResolved);
        Assert.False(report.Gateway.TcpReachable);
        Assert.False(report.Gateway.RbpAuthenticated);
        Assert.StartsWith("gateway_dns_", report.Gateway.Error);
        Assert.True(
            stopwatch.Elapsed < TimeSpan.FromSeconds(2),
            $"Doctor exceeded its bounded probe budget: {stopwatch.Elapsed}.");
    }

    [Fact]
    public async Task RunAsync_ScansEveryConfiguredPortWithinBound()
    {
        using var gatewayListener = StartListener();
        using var addinListener = StartListener();
        var gatewayAccept = gatewayListener.AcceptTcpClientAsync();
        var addinAccept = addinListener.AcceptTcpClientAsync();
        var reachablePort = GetPort(addinListener);
        var startPort = reachablePort - 1;
        if (startPort < 1)
        {
            startPort = reachablePort;
        }

        var endPort = reachablePort + 1;
        if (endPort > 65535)
        {
            endPort = reachablePort;
        }

        var configuration = CreateConfiguration(
            GetPort(gatewayListener),
            startPort,
            endPort);

        var report = await BridgeDoctor.RunAsync(
            configuration,
            FastOptions());

        using var gatewayClient = await gatewayAccept.WaitAsync(TimeSpan.FromSeconds(2));
        using var addinClient = await addinAccept.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(endPort - startPort + 1, report.Addin.Probes.Count);
        Assert.Contains(reachablePort, report.Addin.ReachablePorts);
        Assert.All(
            report.Addin.Probes,
            probe => Assert.InRange(probe.Port, startPort, endPort));
    }

    [Fact]
    public async Task RunAsync_PreCancelledCallerToken_IsPropagated()
    {
        var configuration = CreateConfiguration(
            gatewayPort: 443,
            scanStartPort: 8080,
            scanEndPort: 8080);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => BridgeDoctor.RunAsync(
                configuration,
                cancellation.Token));
    }

    [Theory]
    [InlineData("gateway")]
    [InlineData("addin")]
    [InlineData("overall")]
    public async Task RunAsync_UnboundedOrNonPositiveOption_IsRejected(string option)
    {
        var configuration = CreateConfiguration(
            gatewayPort: 443,
            scanStartPort: 8080,
            scanEndPort: 8080);
        var options = option switch
        {
            "gateway" => new BridgeDoctorOptions(
                TimeSpan.FromSeconds(11),
                TimeSpan.FromMilliseconds(50),
                TimeSpan.FromSeconds(1)),
            "addin" => new BridgeDoctorOptions(
                TimeSpan.FromMilliseconds(50),
                TimeSpan.Zero,
                TimeSpan.FromSeconds(1)),
            _ => new BridgeDoctorOptions(
                TimeSpan.FromMilliseconds(50),
                TimeSpan.FromMilliseconds(50),
                TimeSpan.FromSeconds(31)),
        };

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(
            () => BridgeDoctor.RunAsync(configuration, options));
    }

    [Fact]
    public async Task Report_SerializesGateContractWithExactPropertyNames()
    {
        var configuration = CreateConfiguration(
            gatewayPort: ReserveThenReleasePort(),
            scanStartPort: ReserveThenReleasePort(),
            scanEndPort: ReserveThenReleasePort());

        var report = await BridgeDoctor.RunAsync(
            configuration,
            FastOptions());
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(report));

        Assert.Equal(
            "revagent-bridge-doctor/v1",
            document.RootElement.GetProperty("schemaVersion").GetString());
        Assert.True(document.RootElement.GetProperty("success").GetBoolean());
        Assert.False(
            document.RootElement
                .GetProperty("gateway")
                .GetProperty("rbpAuthenticated")
                .GetBoolean());
        Assert.False(
            document.RootElement
                .GetProperty("addin")
                .GetProperty("shapeVerified")
                .GetBoolean());
        Assert.Equal(
            0,
            document.RootElement
                .GetProperty("addin")
                .GetProperty("bytesSent")
                .GetInt32());
    }

    private static BridgeDoctorOptions FastOptions() =>
        new(
            GatewayProbeTimeout: TimeSpan.FromSeconds(2),
            AddinPortProbeTimeout: TimeSpan.FromMilliseconds(200),
            OverallTimeout: TimeSpan.FromSeconds(3));

    private static ResolvedBridgeConfiguration CreateConfiguration(
        int gatewayPort,
        int scanStartPort,
        int scanEndPort,
        string gatewayHost = "localhost")
    {
        var sources = new Dictionary<string, BridgeConfigurationValueSource>(
            StringComparer.Ordinal)
        {
            ["schemaVersion"] = FileSource(),
            ["gateway.uri"] = FileSource(),
            ["addin.scanStartPort"] = FileSource(),
            ["addin.scanEndPort"] = FileSource(),
            ["logging.maxFileBytes"] = FileSource(),
            ["logging.retainedFileCount"] = FileSource(),
        };

        return new ResolvedBridgeConfiguration(
            schemaVersion: 1,
            new Uri($"wss://{gatewayHost}:{gatewayPort}/bridge/v1"),
            new BridgeAddinConfiguration(scanStartPort, scanEndPort),
            new BridgeLoggingConfiguration(1024 * 1024, 3),
            new BridgeConfigurationSourceMetadata(
                System.IO.Path.Combine(
                    System.IO.Path.GetTempPath(),
                    "bridge-config.json"),
                sources));
    }

    private static BridgeConfigurationValueSource FileSource() =>
        new(BridgeConfigurationSourceKind.File, "bridge-config.json");

    private static TcpListener StartListener()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return listener;
    }

    private static int ReserveThenReleasePort()
    {
        using var listener = StartListener();
        return GetPort(listener);
    }

    private static int GetPort(TcpListener listener) =>
        ((IPEndPoint)listener.LocalEndpoint).Port;
}
