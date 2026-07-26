using RevAgent.Bridge.AddinLoopback;

namespace RevAgent.Bridge.Tests.AddinLoopback;

public sealed class AddinEndpointTests
{
    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("127.42.7.9")]
    [InlineData("::1")]
    [InlineData("::ffff:127.0.0.1")]
    public void Create_AcceptsOnlyNumericOsLoopbackAddresses(string address)
    {
        var endpoint = AddinEndpoint.Create(address, 8080);

        Assert.Equal(8080, endpoint.Port);
        Assert.True(System.Net.IPAddress.IsLoopback(endpoint.Address));
    }

    [Fact]
    public void Create_NormalizesMappedIpv4LoopbackForIpv4SocketRouting()
    {
        var endpoint = AddinEndpoint.Create("::ffff:127.0.0.1", 8080);

        Assert.Equal(
            System.Net.Sockets.AddressFamily.InterNetwork,
            endpoint.Address.AddressFamily);
        Assert.Equal("127.0.0.1:8080", endpoint.ToString());
    }

    [Theory]
    [InlineData("")]
    [InlineData(" 127.0.0.1")]
    [InlineData("127.0.0.1 ")]
    [InlineData("localhost")]
    [InlineData("0.0.0.0")]
    [InlineData("::")]
    [InlineData("192.168.1.25")]
    [InlineData("203.0.113.10")]
    public void Create_RejectsWildcardHostnameLanAndRemoteTargets(string address)
    {
        var error = Assert.Throws<AddinEndpointException>(
            () => AddinEndpoint.Create(address, 8080));

        Assert.Equal("non_loopback_target", error.Code);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(65536)]
    public void Create_RejectsInvalidPorts(int port)
    {
        var error = Assert.Throws<AddinEndpointException>(
            () => AddinEndpoint.Create("127.0.0.1", port));

        Assert.Equal("invalid_addin_port", error.Code);
    }
}
