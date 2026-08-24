using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed class RbpPrimaryFallbackConnectionCycleFactoryTests
{
    [Fact]
    public async Task RetryableOpeningFailureUsesProvisionedFallbackOnce()
    {
        var primary = new ThrowingFactory(
            Failure(
                RbpGatewayFailureKind.Network,
                fallbackEligible: true));
        var fallback = new RecordingFactory(
            RbpConnectionBindingKind.StreamableHttpSse);
        var factory = new RbpPrimaryFallbackConnectionCycleFactory(
            primary,
            fallback,
            new[] { RbpTransportCapabilities.StreamableHttp });

        IRbpConnectionCycle cycle = await factory.OpenAsync(
            Endpoint(),
            Profile(declareFallback: true));

        Assert.Same(fallback.Cycle, cycle);
        Assert.Equal(1, primary.OpenCount);
        Assert.Equal(1, fallback.OpenCount);
        Assert.Equal(
            Uri.UriSchemeHttps,
            fallback.LastEndpoint!.Scheme);
    }

    [Theory]
    [InlineData((int)RbpGatewayFailureKind.Authentication, true, true, true)]
    [InlineData((int)RbpGatewayFailureKind.Authorization, true, true, true)]
    [InlineData((int)RbpGatewayFailureKind.Version, true, true, true)]
    [InlineData((int)RbpGatewayFailureKind.Trust, true, true, true)]
    [InlineData((int)RbpGatewayFailureKind.Protocol, true, true, true)]
    [InlineData((int)RbpGatewayFailureKind.Network, false, true, true)]
    [InlineData((int)RbpGatewayFailureKind.Network, true, false, true)]
    [InlineData((int)RbpGatewayFailureKind.Network, true, true, false)]
    public async Task FallbackRequiresEveryFrozenAuthority(
        int kind,
        bool openingEligible,
        bool provisioned,
        bool declared)
    {
        RbpGatewayTransportException expected =
            Failure((RbpGatewayFailureKind)kind, openingEligible);
        var primary = new ThrowingFactory(expected);
        var fallback = new RecordingFactory(
            RbpConnectionBindingKind.StreamableHttpSse);
        var factory = new RbpPrimaryFallbackConnectionCycleFactory(
            primary,
            fallback,
            provisioned
                ? new[] { RbpTransportCapabilities.StreamableHttp }
                : Array.Empty<string>());

        RbpGatewayTransportException actual =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => factory.OpenAsync(
                    Endpoint(),
                    Profile(declared)));

        Assert.Same(expected, actual);
        Assert.Equal(1, primary.OpenCount);
        Assert.Equal(0, fallback.OpenCount);
    }

    [Fact]
    public async Task AnOpenedPrimaryNeverSwitchesInPlace()
    {
        var primary = new RecordingFactory();
        var fallback = new RecordingFactory(
            RbpConnectionBindingKind.StreamableHttpSse);
        var factory = new RbpPrimaryFallbackConnectionCycleFactory(
            primary,
            fallback,
            new[] { RbpTransportCapabilities.StreamableHttp });

        IRbpConnectionCycle cycle = await factory.OpenAsync(
            Endpoint(),
            Profile(declareFallback: true));

        Assert.Same(primary.Cycle, cycle);
        Assert.Equal(1, primary.OpenCount);
        Assert.Equal(0, fallback.OpenCount);
    }

    [Fact]
    public async Task FailedFallbackPreservesPrimaryRetryAfterFloor()
    {
        DateTimeOffset primaryFloor =
            DateTimeOffset.UtcNow.AddSeconds(30);
        var primaryFailure = new RbpGatewayTransportException(
            RbpGatewayFailureKind.Network,
            "primary",
            fallbackEligible: true,
            retryNotBeforeUtc: primaryFloor,
            retryAfterDisposition:
                RbpRetryAfterDisposition.Accepted);
        var fallbackFailure = new RbpGatewayTransportException(
            RbpGatewayFailureKind.Network,
            "fallback");
        var factory = new RbpPrimaryFallbackConnectionCycleFactory(
            new ThrowingFactory(primaryFailure),
            new ThrowingFactory(
                fallbackFailure,
                RbpConnectionBindingKind.StreamableHttpSse),
            new[] { RbpTransportCapabilities.StreamableHttp });

        RbpGatewayTransportException actual =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => factory.OpenAsync(
                    Endpoint(),
                    Profile(declareFallback: true)));

        Assert.Equal(primaryFloor, actual.RetryNotBeforeUtc);
        Assert.Equal(
            RbpRetryAfterDisposition.Accepted,
            actual.RetryAfterDisposition);
        Assert.False(actual.FallbackEligible);
    }

    [Fact]
    public async Task FailedFallbackPreservesIgnoredRetryAfterAudit()
    {
        var primaryFailure = new RbpGatewayTransportException(
            RbpGatewayFailureKind.Network,
            "primary",
            fallbackEligible: true,
            retryAfterDisposition:
                RbpRetryAfterDisposition.IgnoredOutOfRange);
        var factory = new RbpPrimaryFallbackConnectionCycleFactory(
            new ThrowingFactory(primaryFailure),
            new ThrowingFactory(
                new RbpGatewayTransportException(
                    RbpGatewayFailureKind.Network,
                    "fallback"),
                RbpConnectionBindingKind.StreamableHttpSse),
            new[] { RbpTransportCapabilities.StreamableHttp });

        RbpGatewayTransportException actual =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => factory.OpenAsync(
                    Endpoint(),
                    Profile(declareFallback: true)));

        Assert.Equal(
            RbpRetryAfterDisposition.IgnoredOutOfRange,
            actual.RetryAfterDisposition);
        Assert.Null(actual.RetryNotBeforeUtc);
    }

    [Fact]
    public void CompositionDefaultsToWssOnlyWhenTheFlagIsUnset()
    {
        Assert.IsType<WssRbpConnectionCycleFactory>(
            WorkerGatewayComposition.CreateConnectionCycleFactory(
                new EnrollmentRequiredStateProvider()));
        Assert.IsType<WssRbpConnectionCycleFactory>(
            WorkerGatewayComposition.CreateConnectionCycleFactory(
                new EnrollmentRequiredStateProvider(),
                Array.Empty<string>()));
    }

    [Fact]
    public void CompositionWrapsWssWithTheFallbackOnlyWhenProvisioned()
    {
        Assert.IsType<RbpPrimaryFallbackConnectionCycleFactory>(
            WorkerGatewayComposition.CreateConnectionCycleFactory(
                new EnrollmentRequiredStateProvider(),
                new[] { RbpTransportCapabilities.StreamableHttp }));
    }

    private static RbpGatewayTransportException Failure(
        RbpGatewayFailureKind kind,
        bool fallbackEligible) =>
        new(
            kind,
            "test",
            fallbackEligible: fallbackEligible);

    private static Uri Endpoint() =>
        new("wss://gateway.revagent.example/bridge/v1");

    private static RbpHelloProfile Profile(bool declareFallback) =>
        new(
            "0.1.0-test",
            "host",
            "Windows",
            Array.Empty<string>(),
            declareFallback
                ? new[] { RbpTransportCapabilities.StreamableHttp }
                : Array.Empty<string>());

    private sealed class ThrowingFactory : IRbpConnectionCycleFactory
    {
        private readonly Exception _exception;
        private readonly RbpConnectionBindingKind _bindingKind;

        internal ThrowingFactory(
            Exception exception,
            RbpConnectionBindingKind bindingKind =
                RbpConnectionBindingKind.Wss)
        {
            _exception = exception;
            _bindingKind = bindingKind;
        }

        internal int OpenCount { get; private set; }

        public RbpConnectionBindingKind BindingKind => _bindingKind;

        public Task<IRbpConnectionCycle> OpenAsync(
            Uri endpoint,
            RbpHelloProfile profile,
            CancellationToken cancellationToken = default)
        {
            _ = endpoint;
            _ = profile;
            cancellationToken.ThrowIfCancellationRequested();
            OpenCount++;
            return Task.FromException<IRbpConnectionCycle>(_exception);
        }
    }

    private sealed class RecordingFactory : IRbpConnectionCycleFactory
    {
        private readonly RbpConnectionBindingKind _bindingKind;

        internal RecordingFactory(
            RbpConnectionBindingKind bindingKind =
                RbpConnectionBindingKind.Wss)
        {
            _bindingKind = bindingKind;
        }

        internal RecordingCycle Cycle { get; } = new();

        internal int OpenCount { get; private set; }

        internal Uri? LastEndpoint { get; private set; }

        public RbpConnectionBindingKind BindingKind => _bindingKind;

        public Task<IRbpConnectionCycle> OpenAsync(
            Uri endpoint,
            RbpHelloProfile profile,
            CancellationToken cancellationToken = default)
        {
            LastEndpoint = endpoint;
            _ = profile;
            cancellationToken.ThrowIfCancellationRequested();
            OpenCount++;
            return Task.FromResult<IRbpConnectionCycle>(Cycle);
        }
    }

    private sealed class RecordingCycle : IRbpConnectionCycle
    {
        public RbpHelloAckPayload Acknowledgement { get; } =
            new(
                1,
                "conn",
                Array.Empty<string>(),
                15_000,
                new RbpHelloLimits(1, 1, 1),
                new RbpHelloManifest(
                    "0.1.0-test",
                    "/bridge/update/manifest"));

        public Task SendAsync(
            RbpEnvelope envelope,
            CancellationToken cancellationToken = default) =>
            Task.CompletedTask;

        public Task<RbpEnvelope> ReceiveAsync(
            CancellationToken cancellationToken = default) =>
            Task.FromException<RbpEnvelope>(
                new InvalidOperationException("Not used."));

        public Task CloseAsync(
            CancellationToken cancellationToken = default) =>
            Task.CompletedTask;

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
