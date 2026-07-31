using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class BridgeEnrollmentCoordinatorTests
{
    private const string EnrollmentTokenValue =
        "coordinator-enroll-token-0123456789ABCDEFGHIJKLMNOPQRST";
    private const string FirstIssuedToken =
        "first-issued-device-token-0123456789ABCDEFGHIJKLMNOPQRS";
    private const string RotatedIssuedToken =
        "rotated-issued-device-token-0123456789ABCDEFGHIJKLMNOPQ";

    [Fact]
    public async Task EnrollAsync_ExchangesWithMachineFingerprintAndPersists()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();
        var exchange = new FakeExchangeClient("device-51", FirstIssuedToken);
        var coordinator = new BridgeEnrollmentCoordinator(
            fixture.Mutator,
            exchange);
        using BridgeEnrollmentToken token =
            BridgeEnrollmentToken.Parse(EnrollmentTokenValue);

        BridgeEnrollmentOutcome outcome =
            await coordinator.EnrollAsync(token);

        using BridgeRuntimeCredentialState state = fixture.Reader.Load()!;
        Assert.Equal("device-51", outcome.DeviceId);
        Assert.Equal(state.MachineFingerprint, outcome.MachineFingerprint);
        Assert.Equal(
            state.MachineFingerprint,
            exchange.LastMachineFingerprint);
        Assert.True(state.IsEnrolled);
        Assert.Equal("device-51", state.DeviceCredential!.DeviceId);
        Assert.Equal(
            FirstIssuedToken,
            state.DeviceCredential.DeviceToken.Reveal());
        Assert.True(token.IsConsumed);
    }

    [Fact]
    public async Task FailedExchange_LeavesTheStoreWithoutAnyCredential()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();
        var coordinator = new BridgeEnrollmentCoordinator(
            fixture.Mutator,
            new FakeExchangeClient(
                new BridgeCredentialUnavailableException(
                    BridgeCredentialUnavailableErrorCode
                        .EnrollmentTokenReused,
                    "Injected single-use conflict.")));
        using BridgeEnrollmentToken token =
            BridgeEnrollmentToken.Parse(EnrollmentTokenValue);

        BridgeCredentialUnavailableException exception =
            await Assert.ThrowsAsync<BridgeCredentialUnavailableException>(
                () => coordinator.EnrollAsync(token));

        Assert.Equal(
            BridgeCredentialUnavailableErrorCode.EnrollmentTokenReused,
            exception.ErrorCode);
        Assert.False(File.Exists(fixture.Layout.DeviceCredentialPath));
        using BridgeRuntimeCredentialState state = fixture.Reader.Load()!;
        Assert.False(state.IsEnrolled);
    }

    [Fact]
    public async Task ReEnrollAsync_RepairsACorruptCredentialAndReExchanges()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();
        var firstExchange = new FakeExchangeClient(
            "device-51",
            FirstIssuedToken);
        using (BridgeEnrollmentToken firstToken =
               BridgeEnrollmentToken.Parse(EnrollmentTokenValue))
        {
            _ = await new BridgeEnrollmentCoordinator(
                    fixture.Mutator,
                    firstExchange)
                .EnrollAsync(firstToken);
        }

        fixture.CorruptDeviceCredential();
        Assert.Throws<BridgeCredentialStoreException>(
            () => fixture.Reader.Load());

        var coordinator = new BridgeEnrollmentCoordinator(
            fixture.Mutator,
            new FakeExchangeClient("device-51", RotatedIssuedToken));
        using BridgeEnrollmentToken reEnrollToken =
            BridgeEnrollmentToken.Parse(
                "coordinator-reenroll-token-0123456789ABCDEFGHIJKLMNOPQ");

        BridgeEnrollmentOutcome outcome =
            await coordinator.ReEnrollAsync(reEnrollToken);

        using BridgeRuntimeCredentialState state = fixture.Reader.Load()!;
        Assert.Equal("device-51", outcome.DeviceId);
        Assert.True(state.IsEnrolled);
        Assert.Equal(
            RotatedIssuedToken,
            state.DeviceCredential!.DeviceToken.Reveal());
        Assert.Single(
            Directory.EnumerateFiles(
                fixture.Layout.CredentialDirectory,
                "device-credential.dpapi.quarantine-*"));
    }

    private sealed class FakeExchangeClient :
        IBridgeEnrollmentExchangeClient
    {
        private readonly string? _deviceId;
        private readonly string? _deviceToken;
        private readonly BridgeCredentialUnavailableException? _exception;

        internal FakeExchangeClient(string deviceId, string deviceToken)
        {
            _deviceId = deviceId;
            _deviceToken = deviceToken;
        }

        internal FakeExchangeClient(
            BridgeCredentialUnavailableException exception)
        {
            _exception = exception;
        }

        internal string? LastMachineFingerprint { get; private set; }

        public Task<BridgeIssuedDeviceCredential> ExchangeAsync(
            BridgeEnrollmentToken enrollmentToken,
            string machineFingerprint,
            CancellationToken cancellationToken = default)
        {
            _ = enrollmentToken.ConsumeForExchange();
            LastMachineFingerprint = machineFingerprint;
            if (_exception is not null)
            {
                throw _exception;
            }

            return Task.FromResult(
                new BridgeIssuedDeviceCredential(
                    _deviceId!,
                    new BridgeSecretString(_deviceToken!)));
        }
    }
}
