using System.Diagnostics;
using System.Net;
using System.Text;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap.Configuration;

namespace RevAgent.Bridge.Tests.FixtureIntegration;

/// <summary>
/// Substitutes the Windows OS-level process attestation evidence for the
/// launched fixture process.
/// </summary>
/// <remarks>
/// Attestation binds the listener to an Authenticode-signed Revit image under
/// Program Files, which a Node fixture cannot satisfy by construction. Only
/// that OS evidence is substituted here: the identity is still the real
/// process id of the launched fixture, keyed by the connected server port, so
/// a probe or invocation that reached the wrong session fails.
/// </remarks>
internal sealed class FixtureProcessAttestor : IAddinProcessAttestor
{
    internal const string FixtureRevitVersion = "2025";

    private const long FixtureProcessStartFileTime = 133_000_000_000_000_000L;

    private readonly Dictionary<int, FixtureRegistration> _byPort = new();

    internal FixtureProcessAttestor(
        params AddinLoopbackFixtureProcess[] fixtures)
    {
        ArgumentNullException.ThrowIfNull(fixtures);
        foreach (AddinLoopbackFixtureProcess fixture in fixtures)
        {
            Register(fixture);
        }
    }

    internal void Register(AddinLoopbackFixtureProcess fixture)
    {
        ArgumentNullException.ThrowIfNull(fixture);
        _byPort[fixture.Port] = new FixtureRegistration(
            fixture,
            new AddinProcessAttestation(
                new AddinProcessIdentity(
                    fixture.ProcessId,
                    FixtureProcessStartFileTime + fixture.ProcessId),
                FixtureRevitVersion,
                TrustedImagePath));
    }

    internal static string TrustedImagePath =>
        @"C:\Program Files\Autodesk\Revit 2025\Revit.exe";

    public Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
        AddinConnectedPeer peer,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(peer);
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(Resolve(peer));
    }

    public Task VerifyAfterResponseAsync(
        AddinConnectedPeer peer,
        AddinProcessAttestation attestation,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(peer);
        cancellationToken.ThrowIfCancellationRequested();
        _ = Resolve(peer);
        return Task.CompletedTask;
    }

    private AddinProcessAttestation Resolve(AddinConnectedPeer peer)
    {
        if (!_byPort.TryGetValue(
                peer.ServerEndPoint.Port,
                out FixtureRegistration? registration) ||
            !registration.Fixture.IsActive)
        {
            throw new AddinProcessAttestationException(
                "addin_process_attestation_invalid",
                "The connected loopback endpoint is not an active registered fixture.");
        }

        return registration.Attestation;
    }

    private sealed record FixtureRegistration(
        AddinLoopbackFixtureProcess Fixture,
        AddinProcessAttestation Attestation);
}

/// <summary>
/// Serializes the frozen 8080-8085 fixture window across independent testhost
/// processes on one Windows runner account.
/// </summary>
/// <remarks>
/// xUnit collections serialize only inside one testhost. Five self-hosted
/// runner services can therefore execute this collection in separate
/// processes on the same workstation. The exclusive file handle is released
/// by the OS after either normal disposal or a process crash; the stable file
/// itself may safely remain for the next owner.
/// </remarks>
internal sealed class AddinLoopbackFrozenPortLease : IAsyncDisposable
{
    private static readonly TimeSpan AcquireTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMilliseconds(100);

    private readonly FileStream _stream;

    private AddinLoopbackFrozenPortLease(FileStream stream)
    {
        _stream = stream;
    }

    internal static async Task<AddinLoopbackFrozenPortLease> AcquireAsync()
    {
        string path = Path.Combine(
            Path.GetTempPath(),
            "revagent-addin-loopback-ports-8080-8085.lock");
        var stopwatch = Stopwatch.StartNew();
        IOException? lastFailure = null;

        while (stopwatch.Elapsed < AcquireTimeout)
        {
            FileStream? stream = null;
            try
            {
                stream = new FileStream(
                    path,
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize: 256,
                    FileOptions.Asynchronous);
                byte[] owner = Encoding.UTF8.GetBytes(
                    Environment.ProcessId.ToString(
                        System.Globalization.CultureInfo.InvariantCulture));
                stream.SetLength(0);
                await stream.WriteAsync(owner).ConfigureAwait(false);
                await stream.FlushAsync().ConfigureAwait(false);
                return new AddinLoopbackFrozenPortLease(stream);
            }
            catch (IOException exception)
            {
                stream?.Dispose();
                lastFailure = exception;
                await Task.Delay(RetryDelay).ConfigureAwait(false);
            }
            catch
            {
                stream?.Dispose();
                throw;
            }
        }

        throw new TimeoutException(
            "Timed out acquiring the host-wide add-in loopback fixture port lease.",
            lastFailure);
    }

    public ValueTask DisposeAsync() => _stream.DisposeAsync();
}

/// <summary>
/// The real <c>AddinTcpTransport</c> with only the Windows attestation
/// evidence source replaced by the launched-fixture attestor.
/// </summary>
/// <remarks>
/// The session router constructs its own
/// <c>ExpectedAddinProcessAttestor(new WindowsAddinProcessAttestor(), ...)</c>
/// internally. This wrapper preserves that pinning wrapper — and therefore the
/// router's identity-mismatch behaviour — while swapping the inner OS evidence
/// collector. Every frame, timeout, cancellation, and evidence decision stays
/// in the production transport.
/// </remarks>
internal sealed class FixtureAttestationTransport : IAddinTransport
{
    private readonly AddinTcpTransport _inner = new();
    private readonly FixtureProcessAttestor _attestor;

    internal FixtureAttestationTransport(FixtureProcessAttestor attestor)
    {
        _attestor = attestor ?? throw new ArgumentNullException(nameof(attestor));
    }

    public Task<AddinCallResult> InvokeAsync(
        AddinEndpoint endpoint,
        AddinCall call,
        CancellationToken preDispatchCancellationToken = default,
        CancellationToken transportShutdownToken = default,
        IAddinProcessAttestor? processAttestor = null)
    {
        IAddinProcessAttestor? effective = processAttestor switch
        {
            null => null,
            ExpectedAddinProcessAttestor expected =>
                new ExpectedAddinProcessAttestor(_attestor, expected.Expected),
            _ => _attestor,
        };

        return _inner.InvokeAsync(
            endpoint,
            call,
            preDispatchCancellationToken,
            transportShutdownToken,
            effective);
    }
}

/// <summary>
/// Bridge configuration shapes for the two discovery sources P3-T3 allows.
/// </summary>
internal static class FixtureBridgeConfiguration
{
    internal static ResolvedBridgeConfiguration BoundedScan() =>
        Create(
            AddinDiscovery.ScanStartPort,
            AddinDiscovery.ScanEndPort,
            FileSource(),
            FileSource());

    internal static ResolvedBridgeConfiguration ExplicitPortOverride(int port) =>
        Create(port, port, EnvironmentSource(), EnvironmentSource());

    internal static ResolvedBridgeConfiguration Create(
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

    internal static BridgeConfigurationValueSource FileSource() =>
        new(BridgeConfigurationSourceKind.File, "bridge.config.json");

    internal static BridgeConfigurationValueSource EnvironmentSource() =>
        new(
            BridgeConfigurationSourceKind.Environment,
            BridgeConfigurationLoader.AddinPortEnvironmentVariable);
}

/// <summary>
/// Loopback endpoint literals the bridge must refuse before any JSON-RPC byte
/// is written.
/// </summary>
internal static class RejectedEndpointOverrides
{
    internal static IReadOnlyList<(string Literal, string Kind)> All { get; } =
        new[]
        {
            ("0.0.0.0", "IPv4 wildcard"),
            ("::", "IPv6 wildcard"),
            ("192.168.10.42", "RFC1918 LAN"),
            ("10.0.0.5", "RFC1918 LAN"),
            ("172.16.0.9", "RFC1918 LAN"),
            ("169.254.10.10", "link-local LAN"),
            ("203.0.113.5", "remote unicast"),
            ("2001:db8::1", "remote IPv6"),
            ("::ffff:203.0.113.5", "IPv4-mapped remote"),
            ("localhost", "non-numeric host"),
            ("127.0.0.1 ", "padded literal"),
        };

    internal static IPAddress AcceptedLoopback => IPAddress.Loopback;
}
