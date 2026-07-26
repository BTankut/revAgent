using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class BridgeDeviceCredentialProviderTests
{
    private const string DeviceToken =
        "provider-device-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    [Fact]
    public void MissingCredential_FailsClosedThroughReaderOnlyCapability()
    {
        var reader = new StubReader(state: null);
        var provider = new BridgeDeviceCredentialProvider(reader);

        BridgeCredentialUnavailableException exception =
            Assert.Throws<BridgeCredentialUnavailableException>(
                () => provider.GetRequired());

        Assert.Equal(
            BridgeCredentialUnavailableErrorCode.NotEnrolled,
            exception.ErrorCode);
        Assert.Equal(1, reader.LoadCalls);
        Assert.Single(
            typeof(BridgeDeviceCredentialProvider)
                .GetConstructors(
                    System.Reflection.BindingFlags.Instance |
                    System.Reflection.BindingFlags.NonPublic),
            constructor =>
                constructor.GetParameters().Length == 1 &&
                constructor.GetParameters()[0].ParameterType ==
                typeof(IBridgeCredentialReader));
    }

    [Fact]
    public void StoreFailure_FailsClosedWithoutLeakingDetails()
    {
        var reader = new StubReader(
            new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.ProtectionFailure,
                "Injected protected-store failure.",
                new InvalidOperationException(
                    "Sensitive inner failure containing " +
                    DeviceToken + ".")));
        var provider = new BridgeDeviceCredentialProvider(reader);

        BridgeCredentialUnavailableException exception =
            Assert.Throws<BridgeCredentialUnavailableException>(
                () => provider.GetRequired());

        Assert.Equal(
            BridgeCredentialUnavailableErrorCode.StoreUnavailable,
            exception.ErrorCode);
        Assert.Equal(
            BridgeCredentialStoreErrorCode.ProtectionFailure,
            exception.StoreErrorCode);
        Assert.Null(exception.InnerException);
        Assert.DoesNotContain(
            DeviceToken,
            exception.ToString(),
            StringComparison.Ordinal);
    }

    [Fact]
    public void EnrolledState_ReturnsAuthenticationMaterial()
    {
        var state = new BridgeRuntimeCredentialState(
            "sha256:" + new string('a', 64),
            new BridgeDeviceCredential(
                "device-9",
                new BridgeSecretString(DeviceToken),
                DateTimeOffset.Parse("2026-07-26T10:15:00Z")));
        var provider = new BridgeDeviceCredentialProvider(
            new StubReader(state));

        BridgeGatewayCredential credential = provider.GetRequired();

        Assert.Equal("device-9", credential.DeviceId);
        Assert.Equal(DeviceToken, credential.DeviceToken.Reveal());
        Assert.Equal(
            state.MachineFingerprint,
            credential.MachineFingerprint);
        Assert.DoesNotContain(
            DeviceToken,
            credential.ToString(),
            StringComparison.Ordinal);
    }

    private sealed class StubReader : IBridgeCredentialReader
    {
        private readonly BridgeRuntimeCredentialState? _state;
        private readonly BridgeCredentialStoreException? _exception;

        internal StubReader(BridgeRuntimeCredentialState? state)
        {
            _state = state;
        }

        internal StubReader(BridgeCredentialStoreException exception)
        {
            _exception = exception;
        }

        internal int LoadCalls { get; private set; }

        public BridgeRuntimeCredentialState? Load()
        {
            LoadCalls++;
            if (_exception is not null)
            {
                throw _exception;
            }

            return _state;
        }
    }
}
