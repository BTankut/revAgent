using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Enrollment;

internal enum BridgeCredentialUnavailableErrorCode
{
    NotEnrolled,
    StoreUnavailable,
}

internal sealed class BridgeCredentialUnavailableException : Exception
{
    internal BridgeCredentialUnavailableException(
        BridgeCredentialUnavailableErrorCode errorCode,
        string message,
        BridgeCredentialStoreErrorCode? storeErrorCode = null)
        : base(message)
    {
        ErrorCode = errorCode;
        StoreErrorCode = storeErrorCode;
    }

    internal BridgeCredentialUnavailableErrorCode ErrorCode { get; }

    internal BridgeCredentialStoreErrorCode? StoreErrorCode { get; }
}

internal sealed class BridgeGatewayCredential : IDisposable
{
    internal BridgeGatewayCredential(
        string deviceId,
        BridgeSecretString deviceToken,
        string machineFingerprint)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(deviceId);
        ArgumentNullException.ThrowIfNull(deviceToken);
        ArgumentException.ThrowIfNullOrWhiteSpace(machineFingerprint);

        DeviceId = deviceId;
        DeviceToken = deviceToken;
        MachineFingerprint = machineFingerprint;
    }

    internal string DeviceId { get; }

    internal BridgeSecretString DeviceToken { get; }

    internal string MachineFingerprint { get; }

    public void Dispose() => DeviceToken.Dispose();

    public override string ToString() =>
        $"BridgeGatewayCredential {{ DeviceId = {DeviceId}, " +
        $"DeviceToken = [redacted], " +
        $"MachineFingerprint = {MachineFingerprint} }}";
}

internal interface IBridgeDeviceCredentialProvider
{
    BridgeGatewayCredential GetRequired();
}

internal sealed class BridgeDeviceCredentialProvider :
    IBridgeDeviceCredentialProvider
{
    private readonly IBridgeCredentialReader _reader;

    internal BridgeDeviceCredentialProvider(IBridgeCredentialReader reader)
    {
        ArgumentNullException.ThrowIfNull(reader);
        _reader = reader;
    }

    internal static BridgeDeviceCredentialProvider CreateProduction(
        BridgeInstallLayout layout) =>
        new(BridgeCredentialReader.CreateProduction(layout));

    public BridgeGatewayCredential GetRequired()
    {
        BridgeRuntimeCredentialState? loadedState;
        try
        {
            loadedState = _reader.Load();
        }
        catch (BridgeCredentialStoreException exception)
        {
            throw new BridgeCredentialUnavailableException(
                BridgeCredentialUnavailableErrorCode.StoreUnavailable,
                "The bridge device credential is unavailable. Gateway " +
                "authentication is blocked until the local credential store " +
                "is repaired or enrollment is completed.",
                exception.ErrorCode);
        }

        using BridgeRuntimeCredentialState? state = loadedState;
        BridgeDeviceCredential credential =
            state?.DeviceCredential ??
            throw new BridgeCredentialUnavailableException(
                BridgeCredentialUnavailableErrorCode.NotEnrolled,
                "The bridge has no enrolled device credential. Gateway " +
                "authentication is blocked.");
        BridgeSecretString token = credential.DeviceToken.Clone();
        try
        {
            var gatewayCredential = new BridgeGatewayCredential(
                credential.DeviceId,
                token,
                state.MachineFingerprint);
            token = null!;
            return gatewayCredential;
        }
        finally
        {
            token?.Dispose();
        }
    }
}
