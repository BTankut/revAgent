using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class BridgeCredentialModelsTests
{
    [Fact]
    public void RandomSeedV1_DerivesPinnedSha256Fingerprint()
    {
        byte[] seed = Enumerable.Range(0, 32)
            .Select(value => (byte)value)
            .ToArray();

        using var identity = new BridgeMachineIdentity(seed);

        Assert.Equal(
            "bridge_random_seed_v1",
            identity.FingerprintPolicy);
        Assert.Equal(
            "sha256:630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd",
            identity.MachineFingerprint);
    }

    [Fact]
    public void MachineIdentity_DefensivelyCopiesSeed()
    {
        var seed = Enumerable.Repeat((byte)0x42, 32).ToArray();
        using var identity = new BridgeMachineIdentity(seed);
        string fingerprint = identity.MachineFingerprint;

        Array.Fill(seed, (byte)0);
        byte[] copy = identity.CopySeed();
        Array.Fill(copy, (byte)0xFF);

        Assert.Equal(fingerprint, identity.MachineFingerprint);
        Assert.All(identity.CopySeed(), value => Assert.Equal(0x42, value));
    }

    [Fact]
    public void CredentialStrings_RedactDeviceToken()
    {
        const string token =
            "device-token-that-must-never-appear-in-diagnostics-000000000000";
        var credential = new BridgeDeviceCredential(
            "device-7",
            new BridgeSecretString(token),
            DateTimeOffset.Parse("2026-07-26T10:15:00Z"));
        var state = new BridgeRuntimeCredentialState(
            "sha256:" + new string('0', 64),
            credential);

        Assert.DoesNotContain(token, credential.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain(token, state.ToString(), StringComparison.Ordinal);
        Assert.Equal("[redacted]", credential.DeviceToken.ToString());
    }

    [Fact]
    public void MachineIdentity_DisposeRemovesSeedCapability()
    {
        var identity = new BridgeMachineIdentity(new byte[32]);

        identity.Dispose();

        Assert.Throws<ObjectDisposedException>(() => identity.CopySeed());
    }

    [Fact]
    public void DeviceToken_RejectsShortOpaqueValue()
    {
        Assert.Throws<ArgumentException>(
            () => new BridgeSecretString("too-short"));
    }
}
