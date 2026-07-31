using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Enrollment;

/// <summary>
/// The outcome of a completed enrollment or re-enrollment: only
/// non-secret identifiers ever leave the coordinator.
/// </summary>
internal sealed record BridgeEnrollmentOutcome(
    string DeviceId,
    string MachineFingerprint);

/// <summary>
/// Drives the RES-30 bridge-side enrollment flows over the existing
/// storage capabilities. Fresh enrollment consumes a single-use token,
/// exchanges it for a device token, and persists through
/// <see cref="IBridgeCredentialMutator.SaveDeviceCredential"/>.
/// Re-enrollment drives
/// <see cref="IBridgeCredentialMutator.RepairDeviceCredentialForReenrollment"/>,
/// which quarantines a corrupt device credential before the fresh exchange
/// result is written. Every failure leaves the store untouched or repaired
/// — never half-enrolled.
/// </summary>
internal sealed class BridgeEnrollmentCoordinator
{
    private readonly IBridgeCredentialMutator _mutator;
    private readonly IBridgeEnrollmentExchangeClient _exchangeClient;
    private readonly TimeProvider _timeProvider;

    internal BridgeEnrollmentCoordinator(
        IBridgeCredentialMutator mutator,
        IBridgeEnrollmentExchangeClient exchangeClient,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(mutator);
        ArgumentNullException.ThrowIfNull(exchangeClient);
        _mutator = mutator;
        _exchangeClient = exchangeClient;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    internal Task<BridgeEnrollmentOutcome> EnrollAsync(
        BridgeEnrollmentToken enrollmentToken,
        CancellationToken cancellationToken = default) =>
        RunAsync(
            enrollmentToken,
            static (mutator, fingerprint, credential) =>
                mutator.SaveDeviceCredential(fingerprint, credential),
            cancellationToken);

    internal Task<BridgeEnrollmentOutcome> ReEnrollAsync(
        BridgeEnrollmentToken enrollmentToken,
        CancellationToken cancellationToken = default) =>
        RunAsync(
            enrollmentToken,
            static (mutator, fingerprint, credential) =>
                mutator.RepairDeviceCredentialForReenrollment(
                    fingerprint,
                    credential),
            cancellationToken);

    private async Task<BridgeEnrollmentOutcome> RunAsync(
        BridgeEnrollmentToken enrollmentToken,
        Action<IBridgeCredentialMutator, string, BridgeDeviceCredential>
            persist,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(enrollmentToken);
        string machineFingerprint;
        using (BridgeMachineIdentity identity =
               _mutator.GetOrCreateMachineIdentity())
        {
            machineFingerprint = identity.MachineFingerprint;
        }

        using BridgeIssuedDeviceCredential issued =
            await _exchangeClient.ExchangeAsync(
                    enrollmentToken,
                    machineFingerprint,
                    cancellationToken)
                .ConfigureAwait(false);
        using var credential = new BridgeDeviceCredential(
            issued.DeviceId,
            issued.DeviceToken.Clone(),
            _timeProvider.GetUtcNow());
        persist(_mutator, machineFingerprint, credential);
        return new BridgeEnrollmentOutcome(
            issued.DeviceId,
            machineFingerprint);
    }
}
