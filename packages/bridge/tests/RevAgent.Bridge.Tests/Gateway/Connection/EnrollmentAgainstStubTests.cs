using System.Net;
using System.Net.WebSockets;
using System.Text;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Enrollment;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Tests.Enrollment;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

/// <summary>
/// RES-30 M3 evidence: the bridge-side enrollment protocol proven green
/// against the launched M1 Gateway stub — single-use intake, device-token
/// exchange, DPAPI-machine persistence, the enrollment-state provider, the
/// handshake over the persisted credential, token single-use conflict, and
/// the corrupt-store re-enrollment repair path.
/// </summary>
[Collection(SocketIntegrationCollection.Name)]
public sealed class EnrollmentAgainstStubTests
{
    private const string FreshEnrollmentToken =
        "enroll-fresh-token-0123456789abcdef0123456789abcdef";
    private const string RotateEnrollmentToken =
        "enroll-rotate-token-0123456789abcdef0123456789abcdef";
    private const string DeniedEnrollmentToken =
        "enroll-denied-token-0123456789abcdef0123456789abcdef";
    private const string IssuedDeviceToken =
        "enrolled-device-token-0123456789abcdef01";
    private const string RotatedDeviceToken =
        "rotated-device-token-0123456789abcdef012";

    [Fact]
    public async Task FreshMachineEnrollsPersistsViaDpapiAndHandshakes()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        using var fixture = EnrollmentStoreFixture.CreateWithDpapiProtector();
        var coordinator = new BridgeEnrollmentCoordinator(
            fixture.Mutator,
            CreateExchangeClient(stub));

        BridgeEnrollmentOutcome outcome;
        using (BridgeEnrollmentToken token =
               BridgeEnrollmentToken.Parse(FreshEnrollmentToken))
        {
            outcome = await coordinator.EnrollAsync(token);
        }

        // Exchange result persisted machine-protected: the DPAPI blob on
        // disk never contains the issued token or its base64 in the clear.
        Assert.Equal("device-enrolled-01", outcome.DeviceId);
        Assert.True(File.Exists(fixture.Layout.DeviceCredentialPath));
        byte[] storedBlob =
            File.ReadAllBytes(fixture.Layout.DeviceCredentialPath);
        Assert.DoesNotContain(
            IssuedDeviceToken,
            Encoding.Latin1.GetString(storedBlob),
            StringComparison.Ordinal);

        // The credential-store provider now reports Ready with the
        // persisted credential.
        var provider = new CredentialStoreEnrollmentStateProvider(
            new BridgeDeviceCredentialProvider(fixture.Reader));
        RbpEnrollmentSnapshot snapshot = await provider.ReadAsync();
        Assert.Equal(RbpEnrollmentStatus.Ready, snapshot.Status);
        Assert.Equal(
            "device-enrolled-01",
            snapshot.Credential!.DeviceId);
        Assert.Equal(
            outcome.MachineFingerprint,
            snapshot.Credential.MachineFingerprint);

        // The handshake proceeds against the stub using the enrolled
        // credential read from the store.
        var client = new RbpGatewayHandshakeClient(
            provider,
            new WssGatewayBinding(
                new ExactCertificateSocketFactory(stub)));
        await using (RbpGatewayHandshake handshake =
                     await client.ConnectAsync(
                         stub.WebSocketUri,
                         Profile()))
        {
            Assert.Equal(1, handshake.Acknowledgement.Protocol);
            Assert.Equal(
                WebSocketState.Open,
                handshake.Connection.State);
        }

        // Single-use: replaying the same enrollment token is refused with
        // the 409 conflict class and the store stays byte-identical.
        using BridgeEnrollmentToken replayed =
            BridgeEnrollmentToken.Parse(FreshEnrollmentToken);
        BridgeCredentialUnavailableException conflict =
            await Assert.ThrowsAsync<BridgeCredentialUnavailableException>(
                () => CreateExchangeClient(stub).ExchangeAsync(
                    replayed,
                    outcome.MachineFingerprint));
        Assert.Equal(
            BridgeCredentialUnavailableErrorCode.EnrollmentTokenReused,
            conflict.ErrorCode);
        Assert.Equal(
            storedBlob,
            File.ReadAllBytes(fixture.Layout.DeviceCredentialPath));
    }

    [Fact]
    public async Task CorruptCredentialReEnrollsRepairsAndHandshakesAgain()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        using var fixture = EnrollmentStoreFixture.CreateWithDpapiProtector();
        var coordinator = new BridgeEnrollmentCoordinator(
            fixture.Mutator,
            CreateExchangeClient(stub));
        using (BridgeEnrollmentToken token =
               BridgeEnrollmentToken.Parse(FreshEnrollmentToken))
        {
            _ = await coordinator.EnrollAsync(token);
        }

        fixture.CorruptDeviceCredential();
        var provider = new CredentialStoreEnrollmentStateProvider(
            new BridgeDeviceCredentialProvider(fixture.Reader));
        RbpEnrollmentSnapshot refused = await provider.ReadAsync();
        Assert.Equal(
            RbpEnrollmentStatus.EnrollmentRequired,
            refused.Status);
        Assert.Equal("enrollment_required", refused.DiagnosticCode);

        using (BridgeEnrollmentToken reEnrollToken =
               BridgeEnrollmentToken.Parse(RotateEnrollmentToken))
        {
            _ = await coordinator.ReEnrollAsync(reEnrollToken);
        }

        Assert.Single(
            Directory.EnumerateFiles(
                fixture.Layout.CredentialDirectory,
                "device-credential.dpapi.quarantine-*"));
        using (BridgeRuntimeCredentialState state = fixture.Reader.Load()!)
        {
            Assert.Equal(
                RotatedDeviceToken,
                state.DeviceCredential!.DeviceToken.Reveal());
        }

        var client = new RbpGatewayHandshakeClient(
            provider,
            new WssGatewayBinding(
                new ExactCertificateSocketFactory(stub)));
        await using RbpGatewayHandshake handshake =
            await client.ConnectAsync(stub.WebSocketUri, Profile());
        Assert.Equal(1, handshake.Acknowledgement.Protocol);
    }

    [Fact]
    public async Task StubRejectionsMapToFailClosedClassesWithoutLeaks()
    {
        await using GatewayStubProcess stub =
            await GatewayStubProcess.StartAsync();
        string fingerprint = "sha256:" + new string('b', 64);

        using BridgeEnrollmentToken denied =
            BridgeEnrollmentToken.Parse(DeniedEnrollmentToken);
        BridgeCredentialUnavailableException deniedFailure =
            await Assert.ThrowsAsync<BridgeCredentialUnavailableException>(
                () => CreateExchangeClient(stub).ExchangeAsync(
                    denied,
                    fingerprint));
        Assert.Equal(
            BridgeCredentialUnavailableErrorCode.EnrollmentDenied,
            deniedFailure.ErrorCode);

        const string unknownToken =
            "enroll-unknown-token-0123456789abcdef0123456789abcd";
        using BridgeEnrollmentToken unknown =
            BridgeEnrollmentToken.Parse(unknownToken);
        BridgeCredentialUnavailableException unknownFailure =
            await Assert.ThrowsAsync<BridgeCredentialUnavailableException>(
                () => CreateExchangeClient(stub).ExchangeAsync(
                    unknown,
                    fingerprint));
        Assert.Equal(
            BridgeCredentialUnavailableErrorCode.EnrollmentTokenRejected,
            unknownFailure.ErrorCode);
        Assert.DoesNotContain(
            unknownToken,
            unknownFailure.ToString(),
            StringComparison.Ordinal);
    }

    private static BridgeEnrollmentExchangeClient CreateExchangeClient(
        GatewayStubProcess stub) =>
        new(
            BridgeEnrollmentExchangeClient.CreateEnrollmentEndpoint(
                stub.WebSocketUri),
            () => new HttpClientHandler
            {
                UseProxy = false,
                ServerCertificateCustomValidationCallback =
                    (_, certificate, _, _) =>
                        stub.TrustsExactCertificate(certificate),
            });

    private static RbpHelloProfile Profile() =>
        new(
            "0.1.0-test",
            "fixture-host",
            "Windows test",
            Array.Empty<string>(),
            capabilities: Array.Empty<string>());

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
