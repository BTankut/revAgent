using RevAgent.Bridge.Gateway.Connection;

namespace RevAgent.Bridge.Enrollment;

/// <summary>
/// The production <see cref="IRbpEnrollmentStateProvider"/>: reads the
/// DPAPI-backed credential store through the reader-only capability. An
/// enrolled store yields <see cref="RbpEnrollmentSnapshot.Ready"/> with the
/// device credential; an absent or corrupt store yields the exact same
/// <c>enrollment_required</c> refusal the always-refuse provider emits, so
/// the handshake fail-closed path is byte-identical to the unenrolled
/// bridge of today.
/// </summary>
internal sealed class CredentialStoreEnrollmentStateProvider :
    IRbpEnrollmentStateProvider
{
    private readonly IBridgeDeviceCredentialProvider _credentials;

    internal CredentialStoreEnrollmentStateProvider(
        IBridgeDeviceCredentialProvider credentials)
    {
        ArgumentNullException.ThrowIfNull(credentials);
        _credentials = credentials;
    }

    public ValueTask<RbpEnrollmentSnapshot> ReadAsync(
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        BridgeGatewayCredential credential;
        try
        {
            credential = _credentials.GetRequired();
        }
        catch (BridgeCredentialUnavailableException)
        {
            // Absent and corrupt stores collapse into the identical
            // refusal the hard-coded EnrollmentRequiredStateProvider
            // produces: no detail may soften the fail-closed posture.
            return ValueTask.FromResult(
                RbpEnrollmentSnapshot.NotReady(
                    RbpEnrollmentStatus.EnrollmentRequired,
                    "enrollment_required"));
        }

        using (credential)
        {
            return ValueTask.FromResult(
                RbpEnrollmentSnapshot.Ready(
                    new RbpDeviceCredential(
                        credential.DeviceId,
                        credential.DeviceToken.Reveal(),
                        credential.MachineFingerprint)));
        }
    }
}
