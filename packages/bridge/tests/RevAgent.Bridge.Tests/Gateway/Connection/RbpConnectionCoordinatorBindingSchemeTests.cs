using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed partial class RbpConnectionCoordinatorTests
{
    [Fact]
    public async Task SelectedWssAndHttpsBindingsAcceptOnlyTheirOwnSchemes()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot local = LocalSession(8170, 8170);

        RbpConnectionCoordinator wss = CreateCoordinator(
            new FakeConnectionCycleFactory(),
            store,
            local,
            clock,
            new Uri("wss://gateway.revagent.example/bridge/v1"),
            new RbpHelloProfile(
                "0.1.0-test",
                "host",
                "Windows",
                Array.Empty<string>()));
        Assert.NotNull(wss.GetSnapshot());

        var httpFactory = new StreamableHttpRbpConnectionCycleFactory(
            new FixedEnrollmentProvider(
                StreamableHttpRbpConnectionCycleTests.Credential()),
            new[] { RbpTransportCapabilities.StreamableHttp });
        RbpConnectionCoordinator http = CreateCoordinator(
            httpFactory,
            store,
            local,
            clock,
            new Uri("https://gateway.revagent.example/bridge/v1"),
            StreamableHttpRbpConnectionCycleTests.Profile());
        Assert.NotNull(http.GetSnapshot());
    }

    [Theory]
    [InlineData("https://gateway.revagent.example/bridge/v1")]
    [InlineData("ws://gateway.revagent.example/bridge/v1")]
    [InlineData("http://gateway.revagent.example/bridge/v1")]
    [InlineData("file:///bridge/v1")]
    public async Task WssFactoryRejectsMismatchAndUnsafeEndpointSchemes(
        string endpoint)
    {
        await AssertSchemeRejectedAsync(
            new FakeConnectionCycleFactory(),
            new Uri(endpoint),
            new RbpHelloProfile(
                "0.1.0-test",
                "host",
                "Windows",
                Array.Empty<string>()));
    }

    [Theory]
    [InlineData("wss://gateway.revagent.example/bridge/v1")]
    [InlineData("ws://gateway.revagent.example/bridge/v1")]
    [InlineData("http://gateway.revagent.example/bridge/v1")]
    [InlineData("file:///bridge/v1")]
    public async Task HttpSseFactoryRejectsMismatchAndUnsafeEndpointSchemes(
        string endpoint)
    {
        await AssertSchemeRejectedAsync(
            new StreamableHttpRbpConnectionCycleFactory(
                new FixedEnrollmentProvider(
                    StreamableHttpRbpConnectionCycleTests.Credential()),
                new[] { RbpTransportCapabilities.StreamableHttp }),
            new Uri(endpoint),
            StreamableHttpRbpConnectionCycleTests.Profile());
    }

    private static async Task AssertSchemeRejectedAsync(
        IRbpConnectionCycleFactory factory,
        Uri endpoint,
        RbpHelloProfile profile)
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot local = LocalSession(8171, 8171);

        Assert.Throws<ArgumentException>(
            () => CreateCoordinator(factory, store, local, clock, endpoint, profile));
    }

    private static RbpConnectionCoordinator CreateCoordinator(
        IRbpConnectionCycleFactory factory,
        RbpJournalStore store,
        RbpLocalSessionSnapshot local,
        ManualCoordinatorClock clock,
        Uri endpoint,
        RbpHelloProfile profile) =>
        new(
            factory,
            store,
            new MutableSessionCatalog(local),
            new RbpConnectionCoordinatorOptions(endpoint, profile),
            new StubInvocationDispatcher(),
            inboundJournal: null,
            clock,
            new FixedRandomSource(0));
}
