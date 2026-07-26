using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed class RbpCoordinatorPrimitiveTests
{
    [Fact]
    public void MissingInboundJournalFailsClosed()
    {
        RbpCoordinatorException exception =
            Assert.Throws<RbpCoordinatorException>(
                () => FailClosedRbpInboundDataJournal.Instance.Journal(
                    null!,
                    null!));

        Assert.Equal(
            RbpCoordinatorErrorCode.InboundJournalUnavailable,
            exception.ErrorCode);
    }

    [Fact]
    public void CoordinatorOptionsUseFrozenLifecycleDefaults()
    {
        var options = new RbpConnectionCoordinatorOptions(
            new Uri("wss://gateway.revagent.example/bridge/v1"),
            new RbpHelloProfile(
                "0.1.0-test",
                "host",
                "Windows",
                Array.Empty<string>()));

        Assert.Equal(
            TimeSpan.FromSeconds(10),
            options.EffectiveHeartbeatAcknowledgementTimeout);
        Assert.Equal(
            TimeSpan.FromMilliseconds(
                RbpConnectionReducer
                    .HeartbeatDisconnectedAfterMilliseconds),
            options.EffectiveWakeGapThreshold);
        Assert.Equal(
            TimeSpan.FromSeconds(2),
            options.EffectiveCloseTimeout);
    }

    [Fact]
    public void WssCycleFactoryRequiresHandshakeClient()
    {
        Assert.Throws<ArgumentNullException>(
            () => new WssRbpConnectionCycleFactory(null!));
    }
}
