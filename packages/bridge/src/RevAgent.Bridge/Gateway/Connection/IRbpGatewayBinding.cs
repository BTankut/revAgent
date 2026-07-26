namespace RevAgent.Bridge.Gateway.Connection;

internal sealed record RbpGatewayConnectRequest(
    Uri Endpoint,
    RbpDeviceCredential Credential,
    IReadOnlyList<int> SupportedProtocols);

internal interface IRbpGatewayBinding
{
    Task<RbpGatewayConnection> ConnectAsync(
        RbpGatewayConnectRequest request,
        CancellationToken cancellationToken = default);
}
