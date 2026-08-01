using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json.Serialization;
using RevAgent.Bridge.Bootstrap.Configuration;

namespace RevAgent.Bridge.Bootstrap.Diagnostics;

internal sealed record BridgeDoctorOptions(
    TimeSpan GatewayProbeTimeout,
    TimeSpan AddinPortProbeTimeout,
    TimeSpan OverallTimeout)
{
    internal static BridgeDoctorOptions Default { get; } = new(
        GatewayProbeTimeout: TimeSpan.FromSeconds(3),
        AddinPortProbeTimeout: TimeSpan.FromMilliseconds(250),
        OverallTimeout: TimeSpan.FromSeconds(10));
}

internal sealed record BridgeDoctorReport(
    [property: JsonPropertyName("schemaVersion")] string SchemaVersion,
    [property: JsonPropertyName("success")] bool Success,
    [property: JsonPropertyName("configuration")] RedactedBridgeConfigurationReport Configuration,
    [property: JsonPropertyName("gateway")] BridgeDoctorGatewayReport Gateway,
    [property: JsonPropertyName("addin")] BridgeDoctorAddinReport Addin,
    [property: JsonPropertyName("enrollment")] BridgeDoctorEnrollmentReport? Enrollment = null);

/// <summary>
/// The RES-30 doctor enrollment section: enrolled-or-not plus the
/// machine-fingerprint policy name and bounded diagnostic codes. It never
/// carries the device token, the enrollment token, or any other secret.
/// </summary>
internal sealed record BridgeDoctorEnrollmentReport(
    [property: JsonPropertyName("enrolled")] bool Enrolled,
    [property: JsonPropertyName("fingerprintPolicy")] string FingerprintPolicy,
    [property: JsonPropertyName("reEnrollAttempted")] bool ReEnrollAttempted,
    [property: JsonPropertyName("reEnrollSucceeded")] bool? ReEnrollSucceeded,
    [property: JsonPropertyName("error")] string? Error);

internal sealed record BridgeDoctorGatewayReport(
    [property: JsonPropertyName("host")] string Host,
    [property: JsonPropertyName("port")] int Port,
    [property: JsonPropertyName("dnsResolved")] bool DnsResolved,
    [property: JsonPropertyName("resolvedAddresses")] IReadOnlyList<string> ResolvedAddresses,
    [property: JsonPropertyName("tcpReachable")] bool TcpReachable,
    [property: JsonPropertyName("rbpAuthenticated")] bool RbpAuthenticated,
    [property: JsonPropertyName("error")] string? Error);

internal sealed record BridgeDoctorAddinReport(
    [property: JsonPropertyName("scanStartPort")] int ScanStartPort,
    [property: JsonPropertyName("scanEndPort")] int ScanEndPort,
    [property: JsonPropertyName("reachablePorts")] IReadOnlyList<int> ReachablePorts,
    [property: JsonPropertyName("probes")] IReadOnlyList<BridgeDoctorAddinPortProbe> Probes,
    [property: JsonPropertyName("bytesSent")] int BytesSent,
    [property: JsonPropertyName("shapeVerified")] bool ShapeVerified);

internal sealed record BridgeDoctorAddinPortProbe(
    [property: JsonPropertyName("port")] int Port,
    [property: JsonPropertyName("tcpReachable")] bool TcpReachable,
    [property: JsonPropertyName("error")] string? Error);

internal static class BridgeDoctor
{
    internal const string ReportSchemaVersion = "revagent-bridge-doctor/v1";

    private static readonly TimeSpan MaximumGatewayProbeTimeout =
        TimeSpan.FromSeconds(10);
    private static readonly TimeSpan MaximumAddinPortProbeTimeout =
        TimeSpan.FromSeconds(2);
    private static readonly TimeSpan MaximumOverallTimeout =
        TimeSpan.FromSeconds(30);

    internal static Task<BridgeDoctorReport> RunAsync(
        ResolvedBridgeConfiguration configuration,
        CancellationToken cancellationToken = default) =>
        RunAsync(configuration, BridgeDoctorOptions.Default, cancellationToken);

    internal static async Task<BridgeDoctorReport> RunAsync(
        ResolvedBridgeConfiguration configuration,
        BridgeDoctorOptions options,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(options);
        ValidateOptions(options);

        cancellationToken.ThrowIfCancellationRequested();
        using var overallCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken);
        overallCancellation.CancelAfter(options.OverallTimeout);

        var gateway = await ProbeGatewayAsync(
            configuration.GatewayUri,
            options.GatewayProbeTimeout,
            overallCancellation.Token,
            cancellationToken).ConfigureAwait(false);

        var addin = await ProbeAddinAsync(
            configuration.Addin,
            options.AddinPortProbeTimeout,
            overallCancellation.Token,
            cancellationToken).ConfigureAwait(false);

        return new BridgeDoctorReport(
            ReportSchemaVersion,
            Success: true,
            configuration.ToRedactedReport(),
            gateway,
            addin);
    }

    private static async Task<BridgeDoctorGatewayReport> ProbeGatewayAsync(
        Uri gatewayUri,
        TimeSpan timeout,
        CancellationToken overallCancellationToken,
        CancellationToken callerCancellationToken)
    {
        var host = gatewayUri.DnsSafeHost;
        var port = gatewayUri.Port;
        var addresses = Array.Empty<IPAddress>();

        using var probeCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            overallCancellationToken);
        probeCancellation.CancelAfter(timeout);

        try
        {
            addresses = await Dns.GetHostAddressesAsync(
                host,
                probeCancellation.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!callerCancellationToken.IsCancellationRequested)
        {
            return GatewayFailure(
                host,
                port,
                dnsResolved: false,
                Array.Empty<string>(),
                "gateway_dns_timeout");
        }
        catch (SocketException)
        {
            return GatewayFailure(
                host,
                port,
                dnsResolved: false,
                Array.Empty<string>(),
                "gateway_dns_failed");
        }

        callerCancellationToken.ThrowIfCancellationRequested();

        var orderedAddresses = addresses
            .Distinct()
            .OrderBy(address => address.ToString(), StringComparer.Ordinal)
            .ToArray();
        var addressStrings = orderedAddresses
            .Select(address => address.ToString())
            .ToArray();

        if (orderedAddresses.Length == 0)
        {
            return GatewayFailure(
                host,
                port,
                dnsResolved: false,
                addressStrings,
                "gateway_dns_no_addresses");
        }

        var lastError = "gateway_tcp_unreachable";
        foreach (var address in orderedAddresses)
        {
            try
            {
                await ConnectWithoutPayloadAsync(
                    address,
                    port,
                    probeCancellation.Token).ConfigureAwait(false);

                return new BridgeDoctorGatewayReport(
                    host,
                    port,
                    DnsResolved: true,
                    addressStrings,
                    TcpReachable: true,
                    RbpAuthenticated: false,
                    Error: null);
            }
            catch (OperationCanceledException) when (
                !callerCancellationToken.IsCancellationRequested)
            {
                lastError = "gateway_tcp_timeout";
                break;
            }
            catch (SocketException)
            {
                lastError = "gateway_tcp_unreachable";
            }
        }

        callerCancellationToken.ThrowIfCancellationRequested();
        return GatewayFailure(
            host,
            port,
            dnsResolved: true,
            addressStrings,
            lastError);
    }

    private static async Task<BridgeDoctorAddinReport> ProbeAddinAsync(
        BridgeAddinConfiguration addin,
        TimeSpan portTimeout,
        CancellationToken overallCancellationToken,
        CancellationToken callerCancellationToken)
    {
        var probes = new List<BridgeDoctorAddinPortProbe>();
        var reachablePorts = new List<int>();

        for (var port = addin.ScanStartPort; port <= addin.ScanEndPort; port++)
        {
            callerCancellationToken.ThrowIfCancellationRequested();

            if (overallCancellationToken.IsCancellationRequested)
            {
                probes.Add(new BridgeDoctorAddinPortProbe(
                    port,
                    TcpReachable: false,
                    Error: "addin_probe_budget_exhausted"));
                continue;
            }

            using var portCancellation = CancellationTokenSource.CreateLinkedTokenSource(
                overallCancellationToken);
            portCancellation.CancelAfter(portTimeout);

            try
            {
                await ConnectWithoutPayloadAsync(
                    IPAddress.Loopback,
                    port,
                    portCancellation.Token).ConfigureAwait(false);
                reachablePorts.Add(port);
                probes.Add(new BridgeDoctorAddinPortProbe(
                    port,
                    TcpReachable: true,
                    Error: null));
            }
            catch (OperationCanceledException) when (
                !callerCancellationToken.IsCancellationRequested)
            {
                probes.Add(new BridgeDoctorAddinPortProbe(
                    port,
                    TcpReachable: false,
                    Error: "addin_tcp_timeout"));
            }
            catch (SocketException)
            {
                probes.Add(new BridgeDoctorAddinPortProbe(
                    port,
                    TcpReachable: false,
                    Error: "addin_tcp_unreachable"));
            }
        }

        callerCancellationToken.ThrowIfCancellationRequested();
        return new BridgeDoctorAddinReport(
            addin.ScanStartPort,
            addin.ScanEndPort,
            reachablePorts,
            probes,
            BytesSent: 0,
            ShapeVerified: false);
    }

    private static async Task ConnectWithoutPayloadAsync(
        IPAddress address,
        int port,
        CancellationToken cancellationToken)
    {
        using var client = new TcpClient(address.AddressFamily);
        await client.ConnectAsync(address, port, cancellationToken).ConfigureAwait(false);
    }

    private static BridgeDoctorGatewayReport GatewayFailure(
        string host,
        int port,
        bool dnsResolved,
        IReadOnlyList<string> addresses,
        string error) =>
        new(
            host,
            port,
            dnsResolved,
            addresses,
            TcpReachable: false,
            RbpAuthenticated: false,
            error);

    private static void ValidateOptions(BridgeDoctorOptions options)
    {
        ValidateTimeout(
            options.GatewayProbeTimeout,
            MaximumGatewayProbeTimeout,
            nameof(options.GatewayProbeTimeout));
        ValidateTimeout(
            options.AddinPortProbeTimeout,
            MaximumAddinPortProbeTimeout,
            nameof(options.AddinPortProbeTimeout));
        ValidateTimeout(
            options.OverallTimeout,
            MaximumOverallTimeout,
            nameof(options.OverallTimeout));
    }

    private static void ValidateTimeout(
        TimeSpan value,
        TimeSpan maximum,
        string parameterName)
    {
        if (value <= TimeSpan.Zero || value > maximum)
        {
            throw new ArgumentOutOfRangeException(
                parameterName,
                $"The timeout must be greater than zero and no more than {maximum}.");
        }
    }
}
