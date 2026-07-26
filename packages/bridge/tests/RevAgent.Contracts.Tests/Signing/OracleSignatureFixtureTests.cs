using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.Signing;

namespace RevAgent.Contracts.Tests.Signing;

public sealed class OracleSignatureFixtureTests
{
    [Fact]
    public void VerifiesCommittedAndFreshPowerShellOracleFixtures()
    {
        var fixtureDirectories = new List<string>
        {
            Path.Combine(
                FindRepositoryRoot(),
                "packages",
                "bridge",
                "test-fixtures",
                "signing"),
        };
        var freshFixtureDirectory =
            Environment.GetEnvironmentVariable("REVAGENT_SIGNATURE_ORACLE_FIXTURE_DIR");
        if (!string.IsNullOrWhiteSpace(freshFixtureDirectory))
        {
            fixtureDirectories.Add(freshFixtureDirectory);
        }

        foreach (var fixtureDirectory in fixtureDirectories.Distinct(
                     StringComparer.OrdinalIgnoreCase))
        {
            VerifyFixture(fixtureDirectory);
        }
    }

    private static void VerifyFixture(string fixtureDirectory)
    {
        var content = ParsePreservingStrings(
            Path.Combine(fixtureDirectory, "content.json"));
        var envelope = Assert.IsType<JObject>(ParsePreservingStrings(
            Path.Combine(fixtureDirectory, "signature-envelope.json")));
        var unknownKeyEnvelope = Assert.IsType<JObject>(ParsePreservingStrings(
            Path.Combine(
                fixtureDirectory,
                "unknown-key-signature-envelope.json")));
        var wrongFingerprintEnvelope = Assert.IsType<JObject>(ParsePreservingStrings(
            Path.Combine(
                fixtureDirectory,
                "wrong-fingerprint-signature-envelope.json")));
        var trustedDocument = Assert.IsType<JObject>(ParsePreservingStrings(
            Path.Combine(fixtureDirectory, "trusted-public-key.json")));
        var keys = Assert.IsType<JArray>(trustedDocument["keys"])
            .OfType<JObject>()
            .Select(key => new TrustedPublicKey(
                key.Value<string>("keyId")!,
                key.Value<string>("publicKeyXml")!,
                key.Value<string>("publicKeyFingerprint")))
            .ToArray();

        var result = DetachedSignatureVerifier.Verify(
            content,
            envelope,
            TrustedPublicKeyRing.Create(keys),
            DetachedSignaturePolicy.CompatibilityOracle);
        var expectedContent = File.ReadAllText(
            Path.Combine(fixtureDirectory, "canonical-content.txt"),
            Encoding.UTF8);
        var expectedProjection = File.ReadAllText(
            Path.Combine(fixtureDirectory, "canonical-projection.txt"),
            Encoding.UTF8);

        Assert.True(result.Success, $"{fixtureDirectory}: {result.Reason}: {result.Message}");
        Assert.Equal(expectedContent, CanonicalJson.Serialize(content));
        Assert.Equal(
            expectedProjection,
            CanonicalJson.Serialize(DetachedSignatureProjection.Create(envelope)));
        Assert.Equal(
            envelope.Value<string>("contentSha256"),
            CanonicalJson.Sha256Hex(content),
            ignoreCase: true);

        var unknownKey = DetachedSignatureVerifier.Verify(
            content,
            unknownKeyEnvelope,
            TrustedPublicKeyRing.Create(keys),
            DetachedSignaturePolicy.CompatibilityOracle);
        Assert.Equal("unknown_key_id", unknownKey.Reason);

        var wrongFingerprint = DetachedSignatureVerifier.Verify(
            content,
            wrongFingerprintEnvelope,
            TrustedPublicKeyRing.Create(keys),
            DetachedSignaturePolicy.CompatibilityOracle);
        Assert.Equal("wrong_public_key_fingerprint", wrongFingerprint.Reason);

        var publicKeyXml = keys.Single().PublicKeyXml;
        var publicKeyFingerprint = keys.Single().PublicKeyFingerprint;
        var unknownKeyProof = DetachedSignatureVerifier.Verify(
            content,
            unknownKeyEnvelope,
            TrustedPublicKeyRing.Create(
                new[]
                {
                    new TrustedPublicKey(
                        "missing-key",
                        publicKeyXml,
                        publicKeyFingerprint),
                }),
            DetachedSignaturePolicy.CompatibilityOracle);
        Assert.True(
            unknownKeyProof.Success,
            "The PowerShell unknown-key negative must carry a valid re-signed signature.");

        var wrongFingerprintProof = DetachedSignatureVerifier.Verify(
            content,
            wrongFingerprintEnvelope,
            TrustedPublicKeyRing.Create(
                new[]
                {
                    new TrustedPublicKey(
                        keys.Single().KeyId,
                        publicKeyXml,
                        new string('A', 64)),
                }),
            DetachedSignaturePolicy.CompatibilityOracle);
        Assert.True(
            wrongFingerprintProof.Success,
            "The PowerShell wrong-fingerprint negative must carry a valid re-signed signature.");
    }

    private static string FindRepositoryRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "AGENTS.md"))
                && Directory.Exists(Path.Combine(current.FullName, "packages", "protocol")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate the revAgent repository root.");
    }

    private static JToken ParsePreservingStrings(string path)
    {
        using var textReader = File.OpenText(path);
        using var jsonReader = new JsonTextReader(textReader)
        {
            DateParseHandling = DateParseHandling.None,
            FloatParseHandling = FloatParseHandling.Decimal,
        };
        return JToken.ReadFrom(jsonReader);
    }
}
