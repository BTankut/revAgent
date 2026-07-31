using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Enrollment;
using RevAgent.Bridge.Gateway.Connection;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class CredentialStoreEnrollmentStateProviderTests
{
    private const string DeviceToken =
        "provider-adapter-token-0123456789ABCDEFGHIJKLMNOPQRSTUV";

    [Fact]
    public async Task EnrolledStore_YieldsReadySnapshotWithStoredCredential()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();
        string fingerprint = Enroll(fixture, "device-11", DeviceToken);
        CredentialStoreEnrollmentStateProvider provider =
            CreateProvider(fixture);

        RbpEnrollmentSnapshot snapshot = await provider.ReadAsync();

        Assert.Equal(RbpEnrollmentStatus.Ready, snapshot.Status);
        Assert.Equal("ready", snapshot.DiagnosticCode);
        Assert.Equal("device-11", snapshot.Credential!.DeviceId);
        Assert.Equal(fingerprint, snapshot.Credential.MachineFingerprint);
        Assert.Equal(
            "Bearer " + DeviceToken,
            snapshot.Credential.CreateAuthorizationHeader());
        Assert.DoesNotContain(
            DeviceToken,
            snapshot.Credential.ToString(),
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task AbsentStore_RefusesExactlyLikeTheAlwaysRefuseProvider()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();
        CredentialStoreEnrollmentStateProvider provider =
            CreateProvider(fixture);

        RbpEnrollmentSnapshot fromStore = await provider.ReadAsync();
        RbpEnrollmentSnapshot fromAlwaysRefuse =
            await new EnrollmentRequiredStateProvider().ReadAsync();

        Assert.Equal(fromAlwaysRefuse.Status, fromStore.Status);
        Assert.Equal(
            fromAlwaysRefuse.DiagnosticCode,
            fromStore.DiagnosticCode);
        Assert.Equal(
            RbpEnrollmentStatus.EnrollmentRequired,
            fromStore.Status);
        Assert.Equal("enrollment_required", fromStore.DiagnosticCode);
        Assert.Null(fromStore.Credential);
    }

    [Fact]
    public async Task CorruptStore_RefusesWithTheSameEnrollmentRequiredCode()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();
        _ = Enroll(fixture, "device-11", DeviceToken);
        fixture.CorruptDeviceCredential();
        CredentialStoreEnrollmentStateProvider provider =
            CreateProvider(fixture);

        RbpEnrollmentSnapshot snapshot = await provider.ReadAsync();

        Assert.Equal(
            RbpEnrollmentStatus.EnrollmentRequired,
            snapshot.Status);
        Assert.Equal("enrollment_required", snapshot.DiagnosticCode);
        Assert.Null(snapshot.Credential);
    }

    [Fact]
    public async Task UnenrolledHandshake_IsRefusedBeforeAnySocketOpens()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();
        var binding = new RecordingBinding();
        var client = new RbpGatewayHandshakeClient(
            CreateProvider(fixture),
            binding);

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => client.ConnectAsync(
                    new Uri("wss://gateway.revagent.example/bridge/v1"),
                    new RbpHelloProfile(
                        "0.1.0-test",
                        "host",
                        "Windows",
                        Array.Empty<string>())));

        Assert.Equal(
            RbpGatewayFailureKind.EnrollmentRequired,
            exception.Kind);
        Assert.Contains(
            "enrollment_required",
            exception.Message,
            StringComparison.Ordinal);
        Assert.True(exception.RetryPaused);
        Assert.Equal(0, binding.ConnectCount);
    }

    [Fact]
    public void CompositionDefault_IsTheCredentialStoreProvider()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();

        IRbpEnrollmentStateProvider provider =
            WorkerGatewayComposition.CreateEnrollmentStateProvider(
                () => new BridgeDeviceCredentialProvider(fixture.Reader));

        Assert.IsType<CredentialStoreEnrollmentStateProvider>(provider);
    }

    [Fact]
    public async Task UnavailableStoreCapability_FallsBackToAlwaysRefuse()
    {
        IRbpEnrollmentStateProvider provider =
            WorkerGatewayComposition.CreateEnrollmentStateProvider(
                static () => throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.UnsupportedPlatform,
                    "Injected store-capability failure."));

        Assert.IsType<EnrollmentRequiredStateProvider>(provider);
        RbpEnrollmentSnapshot snapshot = await provider.ReadAsync();
        Assert.Equal(
            RbpEnrollmentStatus.EnrollmentRequired,
            snapshot.Status);
        Assert.Equal("enrollment_required", snapshot.DiagnosticCode);
    }

    private static CredentialStoreEnrollmentStateProvider CreateProvider(
        EnrollmentStoreFixture fixture) =>
        new(new BridgeDeviceCredentialProvider(fixture.Reader));

    private static string Enroll(
        EnrollmentStoreFixture fixture,
        string deviceId,
        string deviceToken)
    {
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        using var credential = new BridgeDeviceCredential(
            deviceId,
            new BridgeSecretString(deviceToken),
            DateTimeOffset.Parse("2026-07-30T08:00:00Z"));
        _ = fixture.Mutator.SaveDeviceCredential(
            identity.MachineFingerprint,
            credential);
        return identity.MachineFingerprint;
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
