using RevAgent.Bridge.Gateway.Connection;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed class RbpGatewayHandshakeClientTests
{
    [Fact]
    public async Task EnrollmentRequiredFailsBeforeCreatingAnySocket()
    {
        var binding = new RecordingBinding();
        var client = new RbpGatewayHandshakeClient(
            new EnrollmentRequiredStateProvider(),
            binding);

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => client.ConnectAsync(
                    new Uri(
                        "wss://gateway.revagent.example/bridge/v1"),
                    new RbpHelloProfile(
                        "0.1.0-test",
                        "host",
                        "Windows",
                        Array.Empty<string>())));

        Assert.Equal(
            RbpGatewayFailureKind.EnrollmentRequired,
            exception.Kind);
        Assert.True(exception.RetryPaused);
        Assert.Equal(0, binding.ConnectCount);
    }

    private sealed class RecordingBinding : IRbpGatewayBinding
    {
        internal int ConnectCount { get; private set; }

        public Task<RbpGatewayConnection> ConnectAsync(
            RbpGatewayConnectRequest request,
            CancellationToken cancellationToken = default)
        {
            ConnectCount++;
            throw new InvalidOperationException(
                "The binding must not be reached without enrollment.");
        }
    }
}
