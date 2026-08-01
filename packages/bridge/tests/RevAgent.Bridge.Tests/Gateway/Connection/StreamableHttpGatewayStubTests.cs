using System.Net;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed class StreamableHttpGatewayStubTests
{
    [Fact]
    public async Task RealTlsGatewayStubWorksThroughConnectProxy()
    {
        await using StreamableHttpGatewayStubProcess stub =
            await StreamableHttpGatewayStubProcess.StartAsync();
        await using var proxy =
            new ConnectProxyFixture(stub.HttpConnectionUri.Port);
        var clients =
            new ExactGatewayCertificateHttpClientFactory(
                stub,
                new WebProxy(proxy.Uri));
        var factory = new StreamableHttpRbpConnectionCycleFactory(
            new FixedEnrollmentProvider(
                StreamableHttpRbpConnectionCycleTests.Credential()),
            new[] { RbpTransportCapabilities.StreamableHttp },
            clients);

        await using IRbpConnectionCycle cycle =
            await factory.OpenAsync(
                stub.WebSocketUri,
                StreamableHttpRbpConnectionCycleTests.Profile());
        await cycle.SendAsync(
            StreamableHttpRbpConnectionCycleTests.Heartbeat());
        RbpEnvelope response = await cycle.ReceiveAsync();

        Assert.Equal("heartbeat_ack", response.Type);
        Assert.Contains(
            RbpTransportCapabilities.StreamableHttp,
            cycle.Acknowledgement.GrantedCapabilities);
        Assert.True(proxy.ConnectAuthorities.Count >= 2);
        Assert.All(
            proxy.ConnectAuthorities,
            authority => Assert.EndsWith(
                ":" + stub.HttpConnectionUri.Port,
                authority,
                StringComparison.Ordinal));
    }
}
