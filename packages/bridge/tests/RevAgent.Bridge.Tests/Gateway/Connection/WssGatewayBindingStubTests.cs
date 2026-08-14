using System.Net;
using System.Net.WebSockets;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

[Collection(SocketIntegrationCollection.Name)]
public sealed class WssGatewayBindingStubTests
{
    [Fact]
    public async Task RealTlsStubAcceptsAuthenticatedHelloWithEmptyCapabilities()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        var binding = new WssGatewayBinding(
            new ExactCertificateSocketFactory(stub));
        var client = new RbpGatewayHandshakeClient(
            new FixedEnrollmentProvider(Credential("test-device-token")),
            binding);

        await using RbpGatewayHandshake handshake =
            await client.ConnectAsync(
                stub.WebSocketUri,
                Profile());

        Assert.Equal(1, handshake.Acknowledgement.Protocol);
        Assert.Empty(handshake.Acknowledgement.GrantedCapabilities);
        Assert.Equal(15_000, handshake.Acknowledgement
            .HeartbeatIntervalMilliseconds);
        Assert.Equal(
            RbpConnectionPhase.Steady,
            handshake.Lifecycle.Phase);
        Assert.Equal(
            WebSocketState.Open,
            handshake.Connection.State);
    }

    [Fact]
    public async Task PostHelloAuthorizationRefusalCarriesOnlyHelloCorrelation()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        const string syntheticDevice = "SYNTHETIC-REVOKED-DEVICE";
        var binding = new WssGatewayBinding(
            new ExactCertificateSocketFactory(stub));
        var client = new RbpGatewayHandshakeClient(
            new FixedEnrollmentProvider(
                new RbpDeviceCredential(
                    syntheticDevice,
                    "test-device-token",
                    $"sha256:{new string('0', 64)}")),
            binding);

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => client.ConnectAsync(stub.WebSocketUri, Profile()));

        Assert.Equal(RbpGatewayFailureKind.Authorization, exception.Kind);
        Assert.Equal(4403, exception.CloseCode);
        Assert.NotNull(exception.OpeningContext);
        Assert.Equal(
            RbpOpeningBinding.Wss,
            exception.OpeningContext.Binding);
        Assert.True(Guid.TryParse(exception.OpeningContext.CorrelationId, out _));
        Assert.DoesNotContain(
            syntheticDevice,
            exception.OpeningContext.CorrelationId,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task StubRejectsBadCredentialWithoutLeakingIt()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        const string rejectedToken = "wrong-token-must-not-appear";
        var binding = new WssGatewayBinding(
            new ExactCertificateSocketFactory(stub));

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => binding.ConnectAsync(
                    new RbpGatewayConnectRequest(
                        stub.WebSocketUri,
                        Credential(rejectedToken),
                        new[] { 1 })));

        Assert.Equal(
            RbpGatewayFailureKind.Authentication,
            exception.Kind);
        Assert.Equal(401, exception.StatusCode);
        Assert.DoesNotContain(
            rejectedToken,
            exception.ToString(),
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task StubUpgrade426IsVersionPaused()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        await stub.EnqueueOpeningFaultAsync(426);
        var binding = new WssGatewayBinding(
            new ExactCertificateSocketFactory(stub));

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => binding.ConnectAsync(
                    new RbpGatewayConnectRequest(
                        stub.WebSocketUri,
                        Credential("test-device-token"),
                        new[] { 1 })));

        Assert.Equal(RbpGatewayFailureKind.Version, exception.Kind);
        Assert.Equal(426, exception.StatusCode);
        Assert.True(exception.RetryPaused);
    }

    [Fact]
    public async Task Stub429IsRetryableAndCarriesBoundedRetryAfter()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        await stub.EnqueueOpeningFaultAsync(429, retryAfter: "7");
        var binding = new WssGatewayBinding(
            new ExactCertificateSocketFactory(stub));

        DateTimeOffset before = DateTimeOffset.UtcNow;
        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => binding.ConnectAsync(
                    new RbpGatewayConnectRequest(
                        stub.WebSocketUri,
                        Credential("test-device-token"),
                        new[] { 1 })));
        DateTimeOffset after = DateTimeOffset.UtcNow;

        Assert.Equal(RbpGatewayFailureKind.Network, exception.Kind);
        Assert.Equal(429, exception.StatusCode);
        Assert.Equal(
            RbpRetryAfterDisposition.Accepted,
            exception.RetryAfterDisposition);
        Assert.InRange(
            exception.RetryNotBeforeUtc!.Value,
            before.AddSeconds(7),
            after.AddSeconds(7));
        Assert.False(exception.RetryPaused);
    }

    [Theory]
    [InlineData(4400, (int)RbpGatewayFailureKind.Protocol)]
    [InlineData(4401, (int)RbpGatewayFailureKind.Authentication)]
    [InlineData(4403, (int)RbpGatewayFailureKind.Authorization)]
    [InlineData(4426, (int)RbpGatewayFailureKind.Version)]
    [InlineData(1002, (int)RbpGatewayFailureKind.Protocol)]
    [InlineData(1009, (int)RbpGatewayFailureKind.Protocol)]
    [InlineData(1000, (int)RbpGatewayFailureKind.RemoteClosed)]
    [InlineData(1011, (int)RbpGatewayFailureKind.RemoteClosed)]
    public void CloseCodesMapToFrozenRetryClasses(
        int closeCode,
        int expected)
    {
        Assert.Equal(
            (RbpGatewayFailureKind)expected,
            RbpGatewayConnection.ClassifyCloseCode(closeCode));
    }

    [Fact]
    public void VersionCloseReasonParsesOnlyTheFrozenShape()
    {
        RbpVersionWindow? window =
            RbpGatewayConnection.ParseVersionWindow(
                """
                {"min_protocol":2,"max_protocol":3,"manifest_url":"/bridge/update/manifest"}
                """);

        Assert.Equal(2, window!.MinimumProtocol);
        Assert.Equal(3, window.MaximumProtocol);
        Assert.Equal(
            "/bridge/update/manifest",
            window.ManifestUrl);
        Assert.Null(
            RbpGatewayConnection.ParseVersionWindow(
                """
                {
                  "min_protocol": 2,
                  "max_protocol": 3,
                  "manifest_url": "/bridge/update/manifest",
                  "extra": true
                }
                """));
        Assert.Null(
            RbpGatewayConnection.ParseVersionWindow(
                """
                {"min_protocol":2,"max_protocol":3,"manifest_url":"https://evil.invalid/manifest"}
                """));
    }

    [Theory]
    [InlineData("wss://127.0.0.1/bridge/v1")]
    [InlineData("wss://[::1]/bridge/v1")]
    [InlineData("wss://localhost./bridge/v1")]
    public async Task NonDnsEndpointIsRejectedBeforeOpening(
        string endpoint)
    {
        var binding = new WssGatewayBinding();

        ArgumentException exception =
            await Assert.ThrowsAsync<ArgumentException>(
                () => binding.ConnectAsync(
                    new RbpGatewayConnectRequest(
                        new Uri(endpoint),
                        Credential("test-device-token"),
                        new[] { 1 })));

        Assert.Contains("DNS", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RetryAfterParserRejectsAmbiguousAndOverlongValues()
    {
        DateTimeOffset now =
            new(2026, 7, 25, 12, 0, 0, TimeSpan.Zero);
        RbpRetryAfterDecision ambiguous =
            WssGatewayBinding.GetBoundedRetryAfter(
                new Dictionary<string, IEnumerable<string>>
                {
                    ["Retry-After"] = new[] { "7", "8" },
                },
                now);
        RbpRetryAfterDecision overlong =
            WssGatewayBinding.GetBoundedRetryAfter(
                new Dictionary<string, IEnumerable<string>>
                {
                    ["Retry-After"] = new[] { "901" },
                },
                now);

        Assert.Equal(
            RbpRetryAfterDisposition.IgnoredMalformed,
            ambiguous.Disposition);
        Assert.Equal(
            RbpRetryAfterDisposition.IgnoredOutOfRange,
            overlong.Disposition);
        Assert.Null(ambiguous.NotBeforeUtc);
        Assert.Null(overlong.NotBeforeUtc);
    }

    [Fact]
    public void PastRetryAfterDateBecomesImmediateNotBefore()
    {
        DateTimeOffset now =
            new(2026, 7, 25, 12, 0, 0, TimeSpan.Zero);
        RbpRetryAfterDecision decision =
            WssGatewayBinding.GetBoundedRetryAfter(
                new Dictionary<string, IEnumerable<string>>
                {
                    ["Retry-After"] = new[]
                    {
                        "Sat, 25 Jul 2026 11:59:00 GMT",
                    },
                },
                now);

        Assert.Equal(
            RbpRetryAfterDisposition.Accepted,
            decision.Disposition);
        Assert.Equal(now, decision.NotBeforeUtc);
    }

    [Theory]
    [InlineData(200)]
    [InlineData(302)]
    [InlineData(500)]
    public void UnexpectedHttpResponsesFailClosedAsProtocol(
        int statusCode)
    {
        Assert.Equal(
            RbpGatewayFailureKind.Protocol,
            WssGatewayBinding.ClassifyOpeningFailure(
                (HttpStatusCode)statusCode,
                trustFailure: false));
    }

    [Fact]
    public async Task SystemTrustRefusesTheSelfSignedStubCertificate()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        var binding = new WssGatewayBinding();

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => binding.ConnectAsync(
                    new RbpGatewayConnectRequest(
                        stub.WebSocketUri,
                        Credential("test-device-token"),
                        new[] { 1 })));

        Assert.Equal(RbpGatewayFailureKind.Trust, exception.Kind);
        Assert.True(exception.RetryPaused);
    }

    private static RbpDeviceCredential Credential(string token) =>
        new(
            "device-01",
            token,
            $"sha256:{new string('0', 64)}");

    private static RbpHelloProfile Profile() =>
        new(
            "0.1.0-test",
            "fixture-host",
            "Windows test",
            Array.Empty<string>(),
            capabilities: Array.Empty<string>());

    private sealed class FixedEnrollmentProvider :
        IRbpEnrollmentStateProvider
    {
        private readonly RbpEnrollmentSnapshot _snapshot;

        internal FixedEnrollmentProvider(RbpDeviceCredential credential)
        {
            _snapshot = RbpEnrollmentSnapshot.Ready(credential);
        }

        public ValueTask<RbpEnrollmentSnapshot> ReadAsync(
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(_snapshot);
        }
    }

    private sealed class ExactCertificateSocketFactory :
        IRbpClientWebSocketFactory
    {
        private readonly GatewayStubProcess _stub;

        internal ExactCertificateSocketFactory(GatewayStubProcess stub)
        {
            _stub = stub;
        }

        public ClientWebSocket Create()
        {
            var socket = new ClientWebSocket();
            socket.Options.Proxy = new WebProxy();
            socket.Options.RemoteCertificateValidationCallback =
                (_, certificate, _, _) =>
                    _stub.TrustsExactCertificate(certificate);
            return socket;
        }
    }
}
