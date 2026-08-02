using System.Collections.ObjectModel;
using System.Globalization;
using System.Net;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.AddinLoopback;

internal enum AddinDiscoverySource
{
    BoundedScan,
    ExplicitEnvironmentOverride,
}

internal enum AddinDiscoveryFailureKind
{
    Unreachable,
    ProbeTimeout,
    ProbeTransportFailure,
    ProbeJsonRpcError,
    UnsupportedContract,
    InvalidProbeResponse,
    InvalidStatusContract,
    TargetAttestationMismatch,
    ProcessAttestationFailure,
    DuplicateProcessIdentity,
}

internal sealed record AddinDiscoveryRejection(
    AddinEndpoint Target,
    AddinDiscoveryFailureKind Kind,
    string Code,
    AddinTransportEvidence? TransportEvidence,
    /// <summary>
    /// Bounded, non-secret failure text. The code alone names the gate that
    /// refused the probe but not the value that made it refuse, which is what
    /// an operator needs on a machine where a live Revit is never discovered.
    /// </summary>
    string? Detail = null);

internal sealed record ProbedAddinSession(
    AddinEndpoint Target,
    string LocalSessionKey,
    AddinStatusSnapshot Status,
    AddinProcessAttestation ProcessAttestation);

internal sealed record AddinDiscoveryEvidence(
    AddinDiscoverySource Source,
    IReadOnlyList<AddinEndpoint> ProbedTargets,
    IReadOnlyList<AddinEndpoint> AcceptedTargets,
    IReadOnlyList<AddinDiscoveryRejection> RejectedTargets);

internal sealed record AddinDiscoveryResult(
    IReadOnlyList<ProbedAddinSession> Sessions,
    AddinDiscoveryEvidence Evidence);

internal sealed class AddinDiscoveryConfigurationException : Exception
{
    internal AddinDiscoveryConfigurationException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    internal string Code { get; }
}

internal sealed class AddinDiscovery
{
    internal const int ScanStartPort = 8080;
    internal const int ScanEndPort = 8085;
    internal const string ScanAddress = "127.0.0.1";
    private static readonly TimeSpan DefaultProbeTimeout =
        TimeSpan.FromSeconds(1);
    private static readonly TimeSpan MaximumProbeTimeout =
        TimeSpan.FromSeconds(30);

    private readonly IAddinTransport _transport;
    private readonly IAddinProcessAttestor _processAttestor;

    internal AddinDiscovery(IAddinTransport transport)
        : this(transport, new WindowsAddinProcessAttestor())
    {
    }

    internal AddinDiscovery(
        IAddinTransport transport,
        IAddinProcessAttestor processAttestor)
    {
        _transport = transport ?? throw new ArgumentNullException(nameof(transport));
        _processAttestor = processAttestor ??
            throw new ArgumentNullException(nameof(processAttestor));
    }

    internal async Task<AddinDiscoveryResult> DiscoverAsync(
        ResolvedBridgeConfiguration configuration,
        TimeSpan? probeTimeout = null,
        CancellationToken cancellationToken = default,
        CancellationToken transportShutdownToken = default)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        TimeSpan timeout = probeTimeout ?? DefaultProbeTimeout;
        if (timeout <= TimeSpan.Zero || timeout > MaximumProbeTimeout)
        {
            throw new ArgumentOutOfRangeException(
                nameof(probeTimeout),
                timeout,
                "The add-in discovery probe timeout must be positive and at most 30 seconds.");
        }

        AddinDiscoverySelection selection =
            AddinDiscoverySelection.FromConfiguration(configuration);
        ThrowIfDiscoveryLifetimeCancelled(
            cancellationToken,
            transportShutdownToken);
        using var probeLifetimeCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken,
                transportShutdownToken);

        var sessions = new List<ProbedAddinSession>();
        var rejections = new List<AddinDiscoveryRejection>();
        var acceptedProcessIdentities = new HashSet<AddinProcessIdentity>();
        foreach (AddinEndpoint target in selection.Targets)
        {
            ThrowIfDiscoveryLifetimeCancelled(
                cancellationToken,
                transportShutdownToken);

            string invocationId = "discovery-" + Guid.NewGuid().ToString("N");
            var call = new AddinCall(
                invocationId,
                "mcp_status",
                new JObject(),
                timeout);

            AddinCallResult result;
            try
            {
                result = await _transport.InvokeAsync(
                    target,
                    call,
                    cancellationToken,
                    probeLifetimeCancellation.Token,
                    _processAttestor).ConfigureAwait(false);
            }
            catch (AddinTransportException exception) when (
                IsDiscoveryAbort(exception))
            {
                ThrowIfDiscoveryLifetimeCancelled(
                    cancellationToken,
                    transportShutdownToken);
                throw;
            }
            catch (AddinTransportException exception)
            {
                ThrowIfDiscoveryLifetimeCancelled(
                    cancellationToken,
                    transportShutdownToken);
                rejections.Add(new AddinDiscoveryRejection(
                    target,
                    ClassifyTransportFailure(exception),
                    exception.Code,
                    exception.Evidence,
                    Bound(
                        (exception.InnerException ?? exception).Message)));
                continue;
            }

            ThrowIfDiscoveryLifetimeCancelled(
                cancellationToken,
                transportShutdownToken);
            if (!result.Response.IsSuccess)
            {
                string errorCode = result.Response.Error == null
                    ? "mcp_status_jsonrpc_error"
                    : "mcp_status_jsonrpc_" +
                      result.Response.Error.Code.ToString(
                          CultureInfo.InvariantCulture);
                rejections.Add(new AddinDiscoveryRejection(
                    target,
                    AddinDiscoveryFailureKind.ProbeJsonRpcError,
                    errorCode,
                    result.Evidence));
                continue;
            }

            AddinStatusSnapshot status;
            try
            {
                status = AddinStatusParser.Parse(result.Response);
            }
            catch (AddinStatusContractException exception)
            {
                ThrowIfDiscoveryLifetimeCancelled(
                    cancellationToken,
                    transportShutdownToken);
                rejections.Add(new AddinDiscoveryRejection(
                    target,
                    exception.Code ==
                        "unsupported_addin_loopback_contract_version"
                            ? AddinDiscoveryFailureKind.UnsupportedContract
                            : AddinDiscoveryFailureKind.InvalidStatusContract,
                    exception.Code,
                    result.Evidence));
                continue;
            }

            ThrowIfDiscoveryLifetimeCancelled(
                cancellationToken,
                transportShutdownToken);
            string? attestationFailure = ValidateTargetAttestation(target, status);
            if (attestationFailure != null)
            {
                rejections.Add(new AddinDiscoveryRejection(
                    target,
                    AddinDiscoveryFailureKind.TargetAttestationMismatch,
                    attestationFailure,
                    result.Evidence));
                continue;
            }

            ThrowIfDiscoveryLifetimeCancelled(
                cancellationToken,
                transportShutdownToken);
            AddinProcessAttestation? processAttestation =
                result.ProcessAttestation;
            if (processAttestation == null ||
                processAttestation.Identity.ProcessId !=
                    status.Revit.ProcessId ||
                processAttestation.Identity.StartTimeFileTimeUtc <= 0 ||
                !string.Equals(
                    processAttestation.RevitVersion,
                    status.Revit.Version,
                    StringComparison.Ordinal))
            {
                rejections.Add(new AddinDiscoveryRejection(
                    target,
                    AddinDiscoveryFailureKind.ProcessAttestationFailure,
                    "addin_process_attestation_invalid",
                    result.Evidence,
                    Bound(
                        "attested pid " +
                        (processAttestation?.Identity.ProcessId.ToString(
                            CultureInfo.InvariantCulture) ?? "none") +
                        " vs status pid " +
                        status.Revit.ProcessId.ToString(
                            CultureInfo.InvariantCulture) +
                        "; attested version '" +
                        (processAttestation?.RevitVersion ?? string.Empty) +
                        "' vs status version '" +
                        status.Revit.Version +
                        "'")));
                continue;
            }

            if (!acceptedProcessIdentities.Add(processAttestation.Identity))
            {
                rejections.Add(new AddinDiscoveryRejection(
                    target,
                    AddinDiscoveryFailureKind.DuplicateProcessIdentity,
                    "duplicate_revit_process_identity",
                    result.Evidence));
                continue;
            }

            sessions.Add(new ProbedAddinSession(
                target,
                processAttestation.Identity.CreateLocalSessionKey(target),
                status,
                processAttestation));
        }

        ThrowIfDiscoveryLifetimeCancelled(
            cancellationToken,
            transportShutdownToken);
        var readOnlySessions =
            new ReadOnlyCollection<ProbedAddinSession>(sessions);
        var acceptedTargets = new ReadOnlyCollection<AddinEndpoint>(
            sessions.Select(session => session.Target).ToList());
        var readOnlyRejections =
            new ReadOnlyCollection<AddinDiscoveryRejection>(rejections);
        return new AddinDiscoveryResult(
            readOnlySessions,
            new AddinDiscoveryEvidence(
                selection.Source,
                selection.Targets,
                acceptedTargets,
                readOnlyRejections));
    }

    private static string Bound(string? value)
    {
        if (value is not { Length: > 0 })
        {
            return string.Empty;
        }

        string single = value.Replace('\r', ' ').Replace('\n', ' ');
        return single.Length <= 240 ? single : single[..240];
    }

    private static void ThrowIfDiscoveryLifetimeCancelled(
        CancellationToken cancellationToken,
        CancellationToken transportShutdownToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        transportShutdownToken.ThrowIfCancellationRequested();
    }

    private static bool IsDiscoveryAbort(AddinTransportException exception)
    {
        return exception.Code == "addin_call_cancelled" ||
               exception.Code == "addin_transport_shutdown";
    }

    private static AddinDiscoveryFailureKind ClassifyTransportFailure(
        AddinTransportException exception)
    {
        if (exception.Code == "addin_connect_failed")
        {
            return AddinDiscoveryFailureKind.Unreachable;
        }

        if (exception.Code == "addin_call_timeout")
        {
            return AddinDiscoveryFailureKind.ProbeTimeout;
        }

        if (exception.InnerException is AddinProcessAttestationException)
        {
            return AddinDiscoveryFailureKind.ProcessAttestationFailure;
        }

        if (exception.Code == "unsupported_result_contract_version")
        {
            return AddinDiscoveryFailureKind.UnsupportedContract;
        }

        if (exception.Code == "addin_response_incomplete" ||
            exception.Code == "addin_transport_io" ||
            exception.Code == "response_frame_too_large")
        {
            return AddinDiscoveryFailureKind.ProbeTransportFailure;
        }

        return AddinDiscoveryFailureKind.InvalidProbeResponse;
    }

    private static string? ValidateTargetAttestation(
        AddinEndpoint target,
        AddinStatusSnapshot status)
    {
        if (status.Service.Port != target.Port)
        {
            return "mcp_status_port_mismatch";
        }

        foreach (string addressText in status.Service.BoundAddresses)
        {
            if (IPAddress.TryParse(addressText, out IPAddress? address) &&
                address.Equals(target.Address))
            {
                return null;
            }
        }

        return "mcp_status_bound_address_mismatch";
    }

    private sealed record AddinDiscoverySelection(
        AddinDiscoverySource Source,
        IReadOnlyList<AddinEndpoint> Targets)
    {
        internal static AddinDiscoverySelection FromConfiguration(
            ResolvedBridgeConfiguration configuration)
        {
            BridgeConfigurationValueSource startSource = RequireSource(
                configuration,
                "addin.scanStartPort");
            BridgeConfigurationValueSource endSource = RequireSource(
                configuration,
                "addin.scanEndPort");

            bool fileScan =
                startSource.Kind == BridgeConfigurationSourceKind.File &&
                endSource.Kind == BridgeConfigurationSourceKind.File;
            if (fileScan)
            {
                if (configuration.Addin.ScanStartPort != ScanStartPort ||
                    configuration.Addin.ScanEndPort != ScanEndPort)
                {
                    throw InvalidConfiguration(
                        "File-configured discovery must use the frozen 8080-8085 range.");
                }

                var targets = new List<AddinEndpoint>(
                    ScanEndPort - ScanStartPort + 1);
                for (int port = ScanStartPort; port <= ScanEndPort; port++)
                {
                    targets.Add(AddinEndpoint.Create(ScanAddress, port));
                }

                return new AddinDiscoverySelection(
                    AddinDiscoverySource.BoundedScan,
                    new ReadOnlyCollection<AddinEndpoint>(targets));
            }

            bool environmentOverride =
                IsExplicitPortSource(startSource) &&
                IsExplicitPortSource(endSource);
            if (environmentOverride)
            {
                if (configuration.Addin.ScanStartPort !=
                    configuration.Addin.ScanEndPort)
                {
                    throw InvalidConfiguration(
                        "The explicit environment override must resolve to one port.");
                }

                return new AddinDiscoverySelection(
                    AddinDiscoverySource.ExplicitEnvironmentOverride,
                    new ReadOnlyCollection<AddinEndpoint>(
                        new[]
                        {
                            AddinEndpoint.Create(
                                ScanAddress,
                                configuration.Addin.ScanStartPort),
                        }));
            }

            throw InvalidConfiguration(
                "Add-in discovery configuration sources are contradictory.");
        }

        private static BridgeConfigurationValueSource RequireSource(
            ResolvedBridgeConfiguration configuration,
            string key)
        {
            if (!configuration.SourceMetadata.Values.TryGetValue(
                    key,
                    out BridgeConfigurationValueSource? source))
            {
                throw InvalidConfiguration(
                    "Add-in discovery configuration source metadata is incomplete.");
            }

            return source;
        }

        private static bool IsExplicitPortSource(
            BridgeConfigurationValueSource source)
        {
            return source.Kind == BridgeConfigurationSourceKind.Environment &&
                   string.Equals(
                       source.Name,
                       BridgeConfigurationLoader.AddinPortEnvironmentVariable,
                       StringComparison.Ordinal);
        }

        private static AddinDiscoveryConfigurationException InvalidConfiguration(
            string message)
        {
            return new AddinDiscoveryConfigurationException(
                "addin_discovery_configuration_invalid",
                message);
        }
    }
}
