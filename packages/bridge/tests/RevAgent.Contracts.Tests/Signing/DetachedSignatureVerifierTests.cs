using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.Signing;

namespace RevAgent.Contracts.Tests.Signing;

public sealed class DetachedSignatureVerifierTests
{
    [Fact]
    public void VerifiesBridgeManifestAndOmitsSignatureFromSignedProjection()
    {
        using var rsa = RSA.Create(2048);
        var content = SignatureTestData.Content();
        var envelope = SignatureTestData.CreateEnvelope(rsa, content);
        var originalSignature = envelope.Value<string>("signature");
        var ring = SignatureTestData.Ring(rsa);

        var result = DetachedSignatureVerifier.Verify(
            content,
            envelope,
            ring,
            DetachedSignaturePolicy.BridgeManifest);
        envelope["signature"] = Convert.ToBase64String(new byte[] { 1, 2, 3 });
        var firstProjection = CanonicalJson.Serialize(
            DetachedSignatureProjection.Create(envelope));
        envelope["signature"] = originalSignature;
        var secondProjection = CanonicalJson.Serialize(
            DetachedSignatureProjection.Create(envelope));

        Assert.True(result.Success);
        Assert.Equal("verified", result.State);
        Assert.Equal("ok", result.Reason);
        Assert.Equal(firstProjection, secondProjection);
        Assert.DoesNotContain("\"signature\"", firstProjection, StringComparison.Ordinal);
    }

    [Fact]
    public void ResolvesTrustedKeyIdsCaseInsensitively()
    {
        using var rsa = RSA.Create(2048);
        var content = SignatureTestData.Content();
        var envelope = SignatureTestData.CreateEnvelope(rsa, content);
        var key = SignatureTestData.TrustedKey(rsa, keyId: "TEST-KEY");
        var ring = TrustedPublicKeyRing.Create(new[] { key });

        var result = DetachedSignatureVerifier.Verify(
            content,
            envelope,
            ring,
            DetachedSignaturePolicy.BridgeManifest);

        Assert.True(result.Success);
    }

    [Fact]
    public void RejectsCaseOnlyDuplicateTrustedKeyIds()
    {
        using var rsa = RSA.Create(2048);
        var first = SignatureTestData.TrustedKey(rsa, keyId: "key");
        var second = SignatureTestData.TrustedKey(rsa, keyId: "KEY");

        Assert.Throws<ArgumentException>(
            () => TrustedPublicKeyRing.Create(new[] { first, second }));
    }

    [Theory]
    [InlineData("unexpected_signature_field")]
    [InlineData("invalid_signature_envelope")]
    [InlineData("unsupported_signature_schema")]
    [InlineData("invalid_signature_app")]
    [InlineData("unsupported_signature_algorithm")]
    [InlineData("unsupported_canonicalization")]
    [InlineData("unsupported_signed_object")]
    [InlineData("content_hash_mismatch")]
    [InlineData("unknown_key_id")]
    [InlineData("invalid_trusted_key")]
    [InlineData("wrong_public_key_fingerprint")]
    [InlineData("invalid_signature_encoding")]
    [InlineData("signature_verification_error")]
    [InlineData("signature_verification_failed")]
    public void PreservesFrozenFailureReasonsInVerificationOrder(string reason)
    {
        using var rsa = RSA.Create(2048);
        var content = SignatureTestData.Content();
        var envelope = SignatureTestData.CreateEnvelope(rsa, content);
        var ring = SignatureTestData.Ring(rsa);

        switch (reason)
        {
            case "unexpected_signature_field":
                envelope["unsigned"] = true;
                break;
            case "invalid_signature_envelope":
                envelope.Remove("keyId");
                break;
            case "unsupported_signature_schema":
                envelope["schemaVersion"] = 2;
                break;
            case "invalid_signature_app":
                envelope["app"] = "other";
                break;
            case "unsupported_signature_algorithm":
                envelope["algorithm"] = "PS256";
                break;
            case "unsupported_canonicalization":
                envelope["canonicalization"] = "other";
                break;
            case "unsupported_signed_object":
                envelope["signedObject"] = "release-manifest";
                break;
            case "content_hash_mismatch":
                envelope["contentSha256"] = new string('0', 64);
                break;
            case "unknown_key_id":
                envelope["keyId"] = "missing";
                break;
            case "invalid_trusted_key":
                ring = TrustedPublicKeyRing.Create(
                    new[] { new TrustedPublicKey("test-key", " ") });
                break;
            case "wrong_public_key_fingerprint":
                envelope["publicKeyFingerprint"] = new string('0', 64);
                break;
            case "invalid_signature_encoding":
                envelope["signature"] = "not-base64";
                break;
            case "signature_verification_error":
                const string InvalidXml =
                    "<RSAKeyValue><Modulus>AQ==</Modulus><Exponent>AQAB</Exponent><P>AQ==</P></RSAKeyValue>";
                envelope["publicKeyFingerprint"] =
                    RsaXmlPublicKey.ComputeFingerprint(InvalidXml);
                ring = TrustedPublicKeyRing.Create(
                    new[] { new TrustedPublicKey("test-key", InvalidXml) });
                break;
            case "signature_verification_failed":
                var signature = Convert.FromBase64String(
                    envelope.Value<string>("signature")!);
                signature[0] ^= 0x01;
                envelope["signature"] = Convert.ToBase64String(signature);
                break;
            default:
                throw new InvalidOperationException(reason);
        }

        var result = DetachedSignatureVerifier.Verify(
            content,
            envelope,
            ring,
            DetachedSignaturePolicy.BridgeManifest);

        Assert.False(result.Success);
        Assert.Equal("rejected", result.State);
        Assert.Equal(reason, result.Reason);
    }

    [Fact]
    public void CompatibilityPolicyAcceptsFrozenLegacyApp()
    {
        using var rsa = RSA.Create(2048);
        var content = SignatureTestData.Content();
        var envelope = SignatureTestData.CreateEnvelope(
            rsa,
            content,
            app: DetachedSignatureContract.LegacyApp,
            signedObject: "release-manifest");
        var result = DetachedSignatureVerifier.Verify(
            content,
            envelope,
            SignatureTestData.Ring(rsa),
            DetachedSignaturePolicy.CompatibilityOracle);

        Assert.True(result.Success);
    }

    [Fact]
    public void BridgeManifestPolicyAcceptsBothFrozenAppIdentities()
    {
        using var rsa = RSA.Create(2048);
        var content = SignatureTestData.Content();
        var envelope = SignatureTestData.CreateEnvelope(
            rsa,
            content,
            app: DetachedSignatureContract.LegacyApp);

        var result = DetachedSignatureVerifier.Verify(
            content,
            envelope,
            SignatureTestData.Ring(rsa),
            DetachedSignaturePolicy.BridgeManifest);

        Assert.True(result.Success);
    }

    [Fact]
    public void NegativeSchemaVersionReachesUnsupportedSchemaReason()
    {
        using var rsa = RSA.Create(2048);
        var content = SignatureTestData.Content();
        var envelope = SignatureTestData.CreateEnvelope(rsa, content);
        envelope["schemaVersion"] = -1;

        var result = DetachedSignatureVerifier.Verify(
            content,
            envelope,
            SignatureTestData.Ring(rsa),
            DetachedSignaturePolicy.BridgeManifest);

        Assert.Equal("unsupported_signature_schema", result.Reason);
    }

    [Fact]
    public void EarlierFailuresWinWhenSeveralEnvelopeChecksWouldFail()
    {
        using var rsa = RSA.Create(2048);
        var content = SignatureTestData.Content();
        var validEnvelope = SignatureTestData.CreateEnvelope(rsa, content);
        var validRing = SignatureTestData.Ring(rsa);

        var unexpected = (JObject)validEnvelope.DeepClone();
        unexpected["unsigned"] = true;
        unexpected.Remove("signature");
        AssertReason(
            "unexpected_signature_field",
            content,
            unexpected,
            validRing);

        var invalidShape = (JObject)validEnvelope.DeepClone();
        invalidShape["schemaVersion"] = 2;
        invalidShape.Remove("signature");
        AssertReason(
            "invalid_signature_envelope",
            content,
            invalidShape,
            validRing);

        var invalidSchema = (JObject)validEnvelope.DeepClone();
        invalidSchema["schemaVersion"] = 2;
        invalidSchema["app"] = "other";
        AssertReason(
            "unsupported_signature_schema",
            content,
            invalidSchema,
            validRing);

        var invalidApp = (JObject)validEnvelope.DeepClone();
        invalidApp["app"] = "other";
        invalidApp["algorithm"] = "PS256";
        AssertReason(
            "invalid_signature_app",
            content,
            invalidApp,
            validRing);

        var invalidAlgorithm = (JObject)validEnvelope.DeepClone();
        invalidAlgorithm["algorithm"] = "PS256";
        invalidAlgorithm["canonicalization"] = "other";
        AssertReason(
            "unsupported_signature_algorithm",
            content,
            invalidAlgorithm,
            validRing);

        var invalidCanonicalization = (JObject)validEnvelope.DeepClone();
        invalidCanonicalization["canonicalization"] = "other";
        invalidCanonicalization["signedObject"] = "other";
        AssertReason(
            "unsupported_canonicalization",
            content,
            invalidCanonicalization,
            validRing);

        var invalidSignedObject = (JObject)validEnvelope.DeepClone();
        invalidSignedObject["signedObject"] = "other";
        invalidSignedObject["contentSha256"] = new string('0', 64);
        AssertReason(
            "unsupported_signed_object",
            content,
            invalidSignedObject,
            validRing);

        var invalidHash = (JObject)validEnvelope.DeepClone();
        invalidHash["contentSha256"] = new string('0', 64);
        invalidHash["keyId"] = "missing";
        AssertReason(
            "content_hash_mismatch",
            content,
            invalidHash,
            validRing);

        var unknownKey = (JObject)validEnvelope.DeepClone();
        unknownKey["keyId"] = "missing";
        unknownKey["publicKeyFingerprint"] = new string('0', 64);
        AssertReason(
            "unknown_key_id",
            content,
            unknownKey,
            validRing);

        var invalidTrustedKey = (JObject)validEnvelope.DeepClone();
        invalidTrustedKey["publicKeyFingerprint"] = new string('0', 64);
        var invalidRing = TrustedPublicKeyRing.Create(
            new[] { new TrustedPublicKey("test-key", " ") });
        AssertReason(
            "invalid_trusted_key",
            content,
            invalidTrustedKey,
            invalidRing);

        var wrongFingerprint = (JObject)validEnvelope.DeepClone();
        wrongFingerprint["publicKeyFingerprint"] = new string('0', 64);
        wrongFingerprint["signature"] = "not-base64";
        AssertReason(
            "wrong_public_key_fingerprint",
            content,
            wrongFingerprint,
            validRing);

        const string InvalidXml =
            "<RSAKeyValue><Modulus>AQ==</Modulus><Exponent>AQAB</Exponent><P>AQ==</P></RSAKeyValue>";
        var invalidEncoding = (JObject)validEnvelope.DeepClone();
        invalidEncoding["publicKeyFingerprint"] =
            RsaXmlPublicKey.ComputeFingerprint(InvalidXml);
        invalidEncoding["signature"] = "not-base64";
        var malformedKeyRing = TrustedPublicKeyRing.Create(
            new[] { new TrustedPublicKey("test-key", InvalidXml) });
        AssertReason(
            "invalid_signature_encoding",
            content,
            invalidEncoding,
            malformedKeyRing);
    }

    private static void AssertReason(
        string expectedReason,
        JToken content,
        JObject envelope,
        TrustedPublicKeyRing ring)
    {
        var result = DetachedSignatureVerifier.Verify(
            content,
            envelope,
            ring,
            DetachedSignaturePolicy.BridgeManifest);

        Assert.False(result.Success);
        Assert.Equal(expectedReason, result.Reason);
    }
}

internal static class SignatureTestData
{
    public static JObject Content()
    {
        return new JObject
        {
            ["schemaVersion"] = 1,
            ["version"] = "0.1.0",
            ["releaseSequence"] = 1,
            ["components"] = new JArray(),
        };
    }

    public static JObject CreateEnvelope(
        RSA rsa,
        JToken content,
        string app = DetachedSignatureContract.App,
        string signedObject = DetachedSignatureContract.BridgeManifestSignedObject)
    {
        var publicXml = ToPublicXml(rsa);
        var envelope = new JObject
        {
            ["schemaVersion"] = DetachedSignatureContract.SchemaVersion,
            ["app"] = app,
            ["signedObject"] = signedObject,
            ["algorithm"] = DetachedSignatureContract.Algorithm,
            ["keyId"] = "test-key",
            ["publicKeyFingerprint"] =
                RsaXmlPublicKey.ComputeFingerprint(publicXml),
            ["canonicalization"] = DetachedSignatureContract.Canonicalization,
            ["contentSha256"] = CanonicalJson.Sha256Hex(content),
            ["createdAtUtc"] = "2026-07-26T00:00:00.0000000Z",
            ["signature"] = string.Empty,
        };
        var payload = Encoding.UTF8.GetBytes(
            CanonicalJson.Serialize(DetachedSignatureProjection.Create(envelope)));
        envelope["signature"] = Convert.ToBase64String(
            rsa.SignData(
                payload,
                HashAlgorithmName.SHA256,
                RSASignaturePadding.Pkcs1));
        return envelope;
    }

    public static TrustedPublicKeyRing Ring(RSA rsa)
    {
        return TrustedPublicKeyRing.Create(new[] { TrustedKey(rsa) });
    }

    public static TrustedPublicKey TrustedKey(
        RSA rsa,
        string keyId = "test-key")
    {
        var xml = ToPublicXml(rsa);
        return new TrustedPublicKey(
            keyId,
            xml,
            RsaXmlPublicKey.ComputeFingerprint(xml));
    }

    public static string ToPublicXml(RSA rsa)
    {
        var parameters = rsa.ExportParameters(includePrivateParameters: false);
        return "<RSAKeyValue><Modulus>"
            + Convert.ToBase64String(parameters.Modulus!)
            + "</Modulus><Exponent>"
            + Convert.ToBase64String(parameters.Exponent!)
            + "</Exponent></RSAKeyValue>";
    }
}
