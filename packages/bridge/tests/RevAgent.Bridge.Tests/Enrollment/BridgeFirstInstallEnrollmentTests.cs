using System.Net;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class ElevatedWindowsEnrollmentFactAttribute : FactAttribute
{
    public ElevatedWindowsEnrollmentFactAttribute()
    {
        if (!OperatingSystem.IsWindows() ||
            !new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
            Skip = "Requires an elevated disposable Windows fixture for genuine SYSTEM-owned ACL and LocalMachine DPAPI proof.";
    }
}

[SupportedOSPlatform("windows")]
public sealed class BridgeFirstInstallEnrollmentTests
{
    [ElevatedWindowsEnrollmentFact]
    public async Task PreparedSystemOwnedIdentity_ConsumesArtifactAndPersistsWithoutReplacingIdentity()
    {
        string root = Path.Combine(Path.GetTempPath(), "revagent-eu20-first-install-" + Guid.NewGuid().ToString("N"));
        var layout = new BridgeInstallLayout(Path.Combine(root, "install"), Path.Combine(root, "state"));
        string artifact = Path.Combine(layout.CredentialDirectory, "enrollment.json");
        try
        {
            var mutator = BridgeCredentialMutator.CreateProduction(layout);
            string fingerprint;
            using (BridgeMachineIdentity identity = mutator.GetOrCreateMachineIdentity())
                fingerprint = identity.MachineFingerprint;
            using (BridgeMachineIdentity repeated = BridgeCredentialMutator.CreateProduction(layout).GetOrCreateMachineIdentity())
                Assert.Equal(fingerprint, repeated.MachineFingerprint);
            string enrollmentToken = "eu20-first-install-test-token-" + Guid.NewGuid().ToString("N");
            File.WriteAllText(artifact, JsonSerializer.Serialize(new
            {
                contractVersion = BridgeEnrollmentArtifactConsumer.ArtifactContractVersion,
                enrollmentToken,
                expiresAtMs = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds(),
            }));
            new WindowsBridgeCredentialAccessControl().ProtectFile(artifact);
            // Same fixed machine-owned artifact policy as the production
            // first-start worker; no injected ACL or principal resolver.
            var source = WindowsBridgeEnrollmentArtifactSource.CreateFirstInstall();
            var handler = new FirstExchangeHandler(artifact, fingerprint);
            var exchange = new BridgeEnrollmentExchangeClient(new Uri("https://localhost/bridge/v1/enroll"), () => handler);
            var result = await BridgeFirstInstallEnrollment.ConsumeAsync(artifact, source,
                new BridgeEnrollmentCoordinator(mutator, exchange), false, CancellationToken.None);
            Assert.True(result.Ok);
            Assert.True(result.SourceAbsent);
            Assert.Equal(1, handler.Calls);
            Assert.False(File.Exists(artifact));
            using var state = BridgeCredentialReader.CreateProduction(layout).Load();
            Assert.NotNull(state);
            Assert.True(state.IsEnrolled);
            Assert.Equal(fingerprint, state.MachineFingerprint);
            Assert.DoesNotContain(enrollmentToken, JsonSerializer.Serialize(result));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    private sealed class FirstExchangeHandler(string artifact, string fingerprint) : HttpMessageHandler
    {
        internal int Calls { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Assert.False(File.Exists(artifact));
            using JsonDocument payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            Assert.Equal(fingerprint, payload.RootElement.GetProperty("machine_fingerprint").GetString());
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(new
                {
                    device_id = "eu20-device-" + Guid.NewGuid().ToString("N"),
                    device_token = "eu20-issued-device-secret-" + Guid.NewGuid().ToString("N"),
                }), Encoding.UTF8, "application/json"),
            };
        }
    }
}
