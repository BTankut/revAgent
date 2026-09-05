using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Enrollment;

/// <summary>First-start enrollment, before the worker connects to the Gateway.
/// Reuses protected artifact deletion and the genuine credential coordinator;
/// no token is copied into process arguments, logs, or environment.</summary>
internal static class BridgeFirstInstallEnrollment
{
    internal static Task<BridgeEnrollmentArtifactConsumerResult> ConsumeAsync(
        string artifactPath,
        IBridgeEnrollmentArtifactSource source,
        BridgeEnrollmentCoordinator coordinator,
        bool ambiguousSecretSource,
        CancellationToken cancellationToken)
    {
        var consumer = new BridgeEnrollmentArtifactConsumer(source,
            async (token, cancellation) =>
            {
                _ = await coordinator.EnrollPreparedIdentityAsync(token, cancellation)
                    .ConfigureAwait(false);
            });
        return ambiguousSecretSource
            ? consumer.RefuseAmbiguousSecretSourceAsync(artifactPath, cancellationToken)
            : consumer.ConsumeAsync(artifactPath, cancellationToken);
    }

    internal static Task<BridgeEnrollmentArtifactConsumerResult> ConsumeProductionAsync(
        BridgeInstallLayout layout,
        Uri gatewayUri,
        CancellationToken cancellationToken) =>
        ConsumeAsync(
            Path.Combine(layout.CredentialDirectory, WindowsBridgeEnrollmentArtifactSource.ExpectedFileName),
            WindowsBridgeEnrollmentArtifactSource.CreateFirstInstall(),
            new BridgeEnrollmentCoordinator(
                BridgeCredentialMutator.CreateProduction(layout),
                new BridgeEnrollmentExchangeClient(
                    BridgeEnrollmentExchangeClient.CreateEnrollmentEndpoint(gatewayUri))),
            !string.IsNullOrEmpty(Environment.GetEnvironmentVariable(
                BridgeEnrollmentDoctor.EnrollmentTokenEnvironmentVariable)),
            cancellationToken);
}
