using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Diagnostics;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class BridgeEnrollmentDoctorTests
{
    private const string EnrollmentTokenValue =
        "doctor-reenroll-token-0123456789ABCDEFGHIJKLMNOPQRSTUVW";
    private const string IssuedDeviceToken =
        "doctor-issued-device-token-0123456789ABCDEFGHIJKLMNOPQR";

    [Fact]
    public void StateReport_ShowsUnenrolledWithPolicyAndNoSecrets()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();

        BridgeDoctorEnrollmentReport report =
            BridgeEnrollmentDoctor.CreateStateReport(() => fixture.Reader);

        Assert.False(report.Enrolled);
        Assert.Equal("bridge_random_seed_v1", report.FingerprintPolicy);
        Assert.False(report.ReEnrollAttempted);
        Assert.Null(report.ReEnrollSucceeded);
        Assert.Null(report.Error);
    }

    [Fact]
    public void StateReport_SurfacesStoreFailuresAsBoundedCodes()
    {
        BridgeDoctorEnrollmentReport report =
            BridgeEnrollmentDoctor.CreateStateReport(
                static () => throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.UnsupportedPlatform,
                    "Injected store failure."));

        Assert.False(report.Enrolled);
        Assert.Equal("store_unsupported_platform", report.Error);
    }

    [Fact]
    public async Task ReEnroll_WithoutTokenFailsClosedWithoutTouchingStore()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();

        BridgeDoctorEnrollmentReport report =
            await BridgeEnrollmentDoctor.RunReEnrollAsync(
                () => fixture.Reader,
                () => throw new InvalidOperationException(
                    "The coordinator must not run without a token."),
                enrollmentTokenValue: null);

        Assert.True(report.ReEnrollAttempted);
        Assert.False(report.ReEnrollSucceeded);
        Assert.Equal("enrollment_token_missing", report.Error);
        Assert.False(report.Enrolled);
        Assert.False(Directory.Exists(fixture.Layout.CredentialDirectory));
    }

    [Fact]
    public async Task ReEnroll_WithMalformedTokenReportsInvalidToken()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();

        BridgeDoctorEnrollmentReport report =
            await BridgeEnrollmentDoctor.RunReEnrollAsync(
                () => fixture.Reader,
                () => throw new InvalidOperationException(
                    "The coordinator must not run for an invalid token."),
                "short token");

        Assert.True(report.ReEnrollAttempted);
        Assert.False(report.ReEnrollSucceeded);
        Assert.Equal("enrollment_token_invalid", report.Error);
    }

    [Fact]
    public async Task ReEnroll_DrivesTheCoordinatorAndReportsEnrolled()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();
        SeedEnrolledStore(fixture);
        fixture.CorruptDeviceCredential();

        BridgeDoctorEnrollmentReport report =
            await BridgeEnrollmentDoctor.RunReEnrollAsync(
                () => fixture.Reader,
                () => new BridgeEnrollmentCoordinator(
                    fixture.Mutator,
                    new StaticExchangeClient(
                        "device-61",
                        IssuedDeviceToken)),
                EnrollmentTokenValue);

        Assert.True(report.ReEnrollAttempted);
        Assert.True(report.ReEnrollSucceeded);
        Assert.True(report.Enrolled);
        Assert.Null(report.Error);
        Assert.Equal("bridge_random_seed_v1", report.FingerprintPolicy);
    }

    [Fact]
    public async Task ReEnroll_ExchangeRejectionsBecomeBoundedCodes()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();

        BridgeDoctorEnrollmentReport report =
            await BridgeEnrollmentDoctor.RunReEnrollAsync(
                () => fixture.Reader,
                () => new BridgeEnrollmentCoordinator(
                    fixture.Mutator,
                    new StaticExchangeClient(
                        new BridgeCredentialUnavailableException(
                            BridgeCredentialUnavailableErrorCode
                                .EnrollmentTokenReused,
                            "Injected reuse conflict containing " +
                            EnrollmentTokenValue + "."))),
                EnrollmentTokenValue);

        Assert.True(report.ReEnrollAttempted);
        Assert.False(report.ReEnrollSucceeded);
        Assert.Equal("enrollment_token_reused", report.Error);
        Assert.False(report.Enrolled);
    }

    [Fact]
    public async Task DoctorReportJson_CarriesEnrollmentSectionWithoutSecrets()
    {
        using var fixture = EnrollmentStoreFixture.CreateWithXorProtector();
        SeedEnrolledStore(fixture);
        BridgeDoctorEnrollmentReport enrollment =
            await BridgeEnrollmentDoctor.RunReEnrollAsync(
                () => fixture.Reader,
                () => new BridgeEnrollmentCoordinator(
                    fixture.Mutator,
                    new StaticExchangeClient(
                        "device-61",
                        IssuedDeviceToken)),
                EnrollmentTokenValue);
        var report = new BridgeDoctorReport(
            BridgeDoctor.ReportSchemaVersion,
            Success: true,
            Configuration: null!,
            Gateway: null!,
            Addin: null!,
            enrollment);

        string json = JsonSerializer.Serialize(report);
        using JsonDocument document = JsonDocument.Parse(json);

        JsonElement section =
            document.RootElement.GetProperty("enrollment");
        Assert.True(section.GetProperty("enrolled").GetBoolean());
        Assert.Equal(
            "bridge_random_seed_v1",
            section.GetProperty("fingerprintPolicy").GetString());
        Assert.True(section.GetProperty("reEnrollAttempted").GetBoolean());
        Assert.True(section.GetProperty("reEnrollSucceeded").GetBoolean());
        Assert.DoesNotContain(
            EnrollmentTokenValue,
            json,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            IssuedDeviceToken,
            json,
            StringComparison.Ordinal);
    }

    private static void SeedEnrolledStore(EnrollmentStoreFixture fixture)
    {
        using BridgeMachineIdentity identity =
            fixture.Mutator.GetOrCreateMachineIdentity();
        using var credential = new BridgeDeviceCredential(
            "device-61",
            new BridgeSecretString(
                "seeded-device-token-0123456789ABCDEFGHIJKLMNOPQRSTUV"),
            DateTimeOffset.Parse("2026-07-30T08:00:00Z"));
        _ = fixture.Mutator.SaveDeviceCredential(
            identity.MachineFingerprint,
            credential);
    }

    private sealed class StaticExchangeClient :
        IBridgeEnrollmentExchangeClient
    {
        private readonly string? _deviceId;
        private readonly string? _deviceToken;
        private readonly BridgeCredentialUnavailableException? _exception;

        internal StaticExchangeClient(string deviceId, string deviceToken)
        {
            _deviceId = deviceId;
            _deviceToken = deviceToken;
        }

        internal StaticExchangeClient(
            BridgeCredentialUnavailableException exception)
        {
            _exception = exception;
        }

        public Task<BridgeIssuedDeviceCredential> ExchangeAsync(
            BridgeEnrollmentToken enrollmentToken,
            string machineFingerprint,
            CancellationToken cancellationToken = default)
        {
            _ = enrollmentToken.ConsumeForExchange();
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
