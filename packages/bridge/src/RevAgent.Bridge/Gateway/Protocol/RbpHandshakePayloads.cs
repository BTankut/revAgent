namespace RevAgent.Bridge.Gateway.Protocol;

internal sealed record RbpMachineHello(
    string Hostname,
    string OperatingSystem,
    string? Fingerprint);

internal sealed record RbpHelloPayload(
    int MinimumProtocol,
    int MaximumProtocol,
    IReadOnlyList<string> Capabilities,
    string BridgeVersion,
    string DeviceId,
    RbpMachineHello Machine,
    IReadOnlyList<string> AddinVersions);

internal sealed record RbpHelloLimits(
    int MaximumParametersBytes,
    int MaximumResultBytes,
    int MaximumPartialBytes);

internal sealed record RbpHelloManifest(
    string LatestBridgeVersion,
    string ManifestUrl);

internal sealed record RbpHelloAckPayload(
    int Protocol,
    string ConnectionId,
    IReadOnlyList<string> GrantedCapabilities,
    int HeartbeatIntervalMilliseconds,
    RbpHelloLimits Limits,
    RbpHelloManifest Manifest);
