using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed class RbpHelloProfile
{
    // Connection negotiation has its own vocabulary. Add-in capabilities are
    // carried only in per-session registration payloads, never in hello.
    internal const string JournalCapability = "journal_v1";

    internal const string StreamableHttpCapability =
        "transport_streamable_http";

    internal const string ChunkedResultsCapability = "chunked_results";

    internal const string ArtifactResultCapability = "artifact_result_v1";

    /// <summary>
    /// Opt-in authority extension for a fresh, unsequenced route proof on a
    /// resumed connection.  Merely offering this capability never enables the
    /// proof; the current hello_ack must grant it.
    /// </summary>
    internal const string RouteRebindProofCapability =
        "route_rebind_proof_v1";

    internal RbpHelloProfile(
        string bridgeVersion,
        string hostname,
        string operatingSystem,
        IReadOnlyList<string> addinVersions,
        IReadOnlyList<string>? capabilities = null)
    {
        BridgeVersion = RequireText(
            bridgeVersion,
            nameof(bridgeVersion),
            128);
        Hostname = RequireText(hostname, nameof(hostname), 4096);
        OperatingSystem = RequireText(
            operatingSystem,
            nameof(operatingSystem),
            4096);
        AddinVersions = FreezeUnique(
            addinVersions,
            nameof(addinVersions),
            128);
        Capabilities = FreezeConnectionCapabilities(
            capabilities ?? Array.Empty<string>(),
            nameof(capabilities),
            128);
    }

    internal string BridgeVersion { get; }

    internal string Hostname { get; }

    internal string OperatingSystem { get; }

    internal IReadOnlyList<string> AddinVersions { get; }

    internal IReadOnlyList<string> Capabilities { get; }

    internal static RbpHelloProfile Production(
        string bridgeVersion,
        IReadOnlyList<string> addinVersions,
        IReadOnlyList<string>? requestedConnectionCapabilities = null) =>
        new(
            bridgeVersion,
            Environment.MachineName,
            Environment.OSVersion.VersionString,
            addinVersions,
            capabilities: requestedConnectionCapabilities ??
                [JournalCapability, RouteRebindProofCapability]);

    private static IReadOnlyList<string> FreezeConnectionCapabilities(
        IReadOnlyList<string> values,
        string parameterName,
        int maximumLength)
    {
        IReadOnlyList<string> frozen = FreezeUnique(
            values,
            parameterName,
            maximumLength);
        foreach (string capability in frozen)
        {
            if (!IsImplementedConnectionCapability(capability))
            {
                throw new ArgumentException(
                    "RBP hello may declare only implemented connection capabilities.",
                    parameterName);
            }
        }

        return frozen;
    }

    private static bool IsImplementedConnectionCapability(string capability) =>
        capability is JournalCapability or StreamableHttpCapability or
            ChunkedResultsCapability or ArtifactResultCapability or
            RouteRebindProofCapability;

    private static IReadOnlyList<string> FreezeUnique(
        IReadOnlyList<string> values,
        string parameterName,
        int maximumLength)
    {
        ArgumentNullException.ThrowIfNull(values, parameterName);
        var unique = new HashSet<string>(StringComparer.Ordinal);
        var copy = new List<string>(values.Count);
        foreach (string value in values)
        {
            string validated = RequireText(
                value,
                parameterName,
                maximumLength);
            if (!unique.Add(validated))
            {
                throw new ArgumentException(
                    "RBP hello values must be unique.",
                    parameterName);
            }

            copy.Add(validated);
        }

        return new ReadOnlyCollection<string>(copy);
    }

    private static string RequireText(
        string value,
        string parameterName,
        int maximumLength)
    {
        ArgumentNullException.ThrowIfNull(value, parameterName);
        if (value.Length is 0 || value.Length > maximumLength)
        {
            throw new ArgumentOutOfRangeException(
                parameterName,
                $"The value must contain 1 through {maximumLength} characters.");
        }

        return value;
    }
}

internal sealed class RbpHelloFactory
{
    private readonly TimeProvider _timeProvider;
    private readonly RbpUuidV7 _identifiers;

    internal RbpHelloFactory(
        TimeProvider? timeProvider = null,
        IRbpRandomSource? random = null)
    {
        _timeProvider = timeProvider ?? TimeProvider.System;
        _identifiers = new RbpUuidV7(_timeProvider, random);
    }

    internal RbpEnvelope Create(
        RbpDeviceCredential credential,
        RbpHelloProfile profile)
    {
        ArgumentNullException.ThrowIfNull(credential);
        ArgumentNullException.ThrowIfNull(profile);
        var machine = new HelloMachineWire(
            profile.Hostname,
            profile.OperatingSystem,
            credential.MachineFingerprint);
        var payload = new HelloPayloadWire(
            MinimumProtocol: 1,
            MaximumProtocol: 1,
            profile.Capabilities,
            profile.BridgeVersion,
            credential.DeviceId,
            machine,
            profile.AddinVersions);
        JsonElement payloadElement =
            JsonSerializer.SerializeToElement(payload);
        var parsedPayload = new RbpHelloPayload(
            1,
            1,
            profile.Capabilities,
            profile.BridgeVersion,
            credential.DeviceId,
            new RbpMachineHello(
                profile.Hostname,
                profile.OperatingSystem,
                credential.MachineFingerprint),
            profile.AddinVersions);
        return new RbpEnvelope(
            Version: null,
            Type: "hello",
            Id: _identifiers.NewId(),
            Timestamp: FormatTimestamp(_timeProvider.GetUtcNow()),
            Payload: payloadElement,
            Scope: RbpEnvelopeScope.PreNegotiation,
            Rsid: null,
            Sequence: null,
            Acknowledgement: null,
            Hello: parsedPayload,
            HelloAck: null,
            Disposition: RbpEnvelopeDisposition.Known,
            AdditionalProperties:
                RbpEnvelope.FreezeAdditionalProperties(
                    new Dictionary<string, JsonElement>(
                        StringComparer.Ordinal)));
    }

    private static string FormatTimestamp(DateTimeOffset value) =>
        value.UtcDateTime.ToString(
            "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
            CultureInfo.InvariantCulture);

    private sealed record HelloPayloadWire(
        [property: JsonPropertyName("min_protocol")] int MinimumProtocol,
        [property: JsonPropertyName("max_protocol")] int MaximumProtocol,
        [property: JsonPropertyName("capabilities")]
            IReadOnlyList<string> Capabilities,
        [property: JsonPropertyName("bridge_version")] string BridgeVersion,
        [property: JsonPropertyName("device_id")] string DeviceId,
        [property: JsonPropertyName("machine")] HelloMachineWire Machine,
        [property: JsonPropertyName("addin_versions")]
            IReadOnlyList<string> AddinVersions);

    private sealed record HelloMachineWire(
        [property: JsonPropertyName("hostname")] string Hostname,
        [property: JsonPropertyName("os")] string OperatingSystem,
        [property: JsonPropertyName("fingerprint")] string Fingerprint);
}
