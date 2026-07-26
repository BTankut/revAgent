using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.Signing;

public static class DetachedSignatureVerifier
{
    private static readonly HashSet<string> ExpectedFields = new(
        DetachedSignatureContract.EnvelopeFields,
        StringComparer.Ordinal);

    public static SignatureVerificationResult Verify(
        JToken content,
        JObject envelope,
        TrustedPublicKeyRing trustedKeys,
        DetachedSignaturePolicy policy)
    {
        if (content is null)
        {
            throw new ArgumentNullException(nameof(content));
        }

        if (envelope is null)
        {
            throw new ArgumentNullException(nameof(envelope));
        }

        if (trustedKeys is null)
        {
            throw new ArgumentNullException(nameof(trustedKeys));
        }

        if (policy is null)
        {
            throw new ArgumentNullException(nameof(policy));
        }

        foreach (var property in envelope.Properties())
        {
            if (!ExpectedFields.Contains(property.Name))
            {
                return SignatureVerificationResult.Rejected(
                    "unexpected_signature_field",
                    $"Signature envelope contains unsigned field '{property.Name}'.");
            }
        }

        if (!TryReadEnvelope(
                envelope,
                out var schemaVersion,
                out var app,
                out var signedObject,
                out var algorithm,
                out var keyId,
                out var publicKeyFingerprint,
                out var canonicalization,
                out var contentSha256,
                out _,
                out var signature,
                out var invalidMessage))
        {
            return SignatureVerificationResult.Rejected(
                "invalid_signature_envelope",
                invalidMessage);
        }

        if (schemaVersion != DetachedSignatureContract.SchemaVersion)
        {
            return SignatureVerificationResult.Rejected(
                "unsupported_signature_schema",
                $"Unsupported signature envelope schemaVersion '{schemaVersion}'.");
        }

        if (!policy.AcceptsApp(app))
        {
            return SignatureVerificationResult.Rejected(
                "invalid_signature_app",
                $"Signature envelope app is '{app}'.",
                signedObject);
        }

        if (!string.Equals(
                algorithm,
                DetachedSignatureContract.Algorithm,
                StringComparison.Ordinal))
        {
            return SignatureVerificationResult.Rejected(
                "unsupported_signature_algorithm",
                $"Unsupported signature algorithm '{algorithm}'.",
                signedObject);
        }

        if (!string.Equals(
                canonicalization,
                DetachedSignatureContract.Canonicalization,
                StringComparison.Ordinal))
        {
            return SignatureVerificationResult.Rejected(
                "unsupported_canonicalization",
                $"Unsupported canonicalization '{canonicalization}'.",
                signedObject);
        }

        if (!policy.AllowsSignedObject(signedObject))
        {
            return SignatureVerificationResult.Rejected(
                "unsupported_signed_object",
                $"Unsupported signedObject '{signedObject}'.",
                signedObject);
        }

        var actualContentSha256 = CanonicalJson.Sha256Hex(content);
        if (!string.Equals(
                actualContentSha256,
                contentSha256,
                StringComparison.OrdinalIgnoreCase))
        {
            return SignatureVerificationResult.Rejected(
                "content_hash_mismatch",
                "Canonical content hash does not match the detached signature envelope.",
                signedObject,
                keyId,
                actualContentSha256);
        }

        if (!trustedKeys.TryGet(keyId, out var trustedKey))
        {
            return SignatureVerificationResult.Rejected(
                "unknown_key_id",
                $"Trusted public key was not found for keyId '{keyId}'.",
                signedObject,
                keyId,
                actualContentSha256);
        }

        if (string.IsNullOrWhiteSpace(trustedKey.PublicKeyXml))
        {
            return SignatureVerificationResult.Rejected(
                "invalid_trusted_key",
                $"Trusted key '{keyId}' does not include publicKeyXml.",
                signedObject,
                keyId,
                actualContentSha256);
        }

        string trustedFingerprint;
        try
        {
            trustedFingerprint = string.IsNullOrWhiteSpace(
                trustedKey.PublicKeyFingerprint)
                ? RsaXmlPublicKey.ComputeFingerprint(trustedKey.PublicKeyXml)
                : trustedKey.PublicKeyFingerprint!;
        }
        catch (Exception exception)
        {
            return SignatureVerificationResult.Rejected(
                "invalid_trusted_key",
                exception.Message,
                signedObject,
                keyId,
                actualContentSha256);
        }

        if (!string.Equals(
                trustedFingerprint,
                publicKeyFingerprint,
                StringComparison.OrdinalIgnoreCase))
        {
            return SignatureVerificationResult.Rejected(
                "wrong_public_key_fingerprint",
                $"Signature envelope fingerprint does not match trusted key '{keyId}'.",
                signedObject,
                keyId,
                actualContentSha256);
        }

        byte[] signatureBytes;
        try
        {
            signatureBytes = Convert.FromBase64String(signature);
        }
        catch (FormatException)
        {
            return SignatureVerificationResult.Rejected(
                "invalid_signature_encoding",
                "Signature is not valid base64.",
                signedObject,
                keyId,
                actualContentSha256);
        }

        bool verified;
        try
        {
            var parameters = RsaXmlPublicKey.Parse(trustedKey.PublicKeyXml);
            using var rsa = RSA.Create();
            rsa.ImportParameters(parameters);
            var payloadBytes = Encoding.UTF8.GetBytes(
                CanonicalJson.Serialize(DetachedSignatureProjection.Create(envelope)));
            verified = rsa.VerifyData(
                payloadBytes,
                signatureBytes,
                HashAlgorithmName.SHA256,
                RSASignaturePadding.Pkcs1);
        }
        catch (Exception exception)
        {
            return SignatureVerificationResult.Rejected(
                "signature_verification_error",
                exception.Message,
                signedObject,
                keyId,
                actualContentSha256);
        }

        if (!verified)
        {
            return SignatureVerificationResult.Rejected(
                "signature_verification_failed",
                "Detached signature did not verify.",
                signedObject,
                keyId,
                actualContentSha256);
        }

        return SignatureVerificationResult.Verified(
            signedObject,
            keyId,
            actualContentSha256);
    }

    private static bool TryReadEnvelope(
        JObject envelope,
        out int schemaVersion,
        out string app,
        out string signedObject,
        out string algorithm,
        out string keyId,
        out string publicKeyFingerprint,
        out string canonicalization,
        out string contentSha256,
        out string createdAtUtc,
        out string signature,
        out string invalidMessage)
    {
        schemaVersion = 0;
        app = string.Empty;
        signedObject = string.Empty;
        algorithm = string.Empty;
        keyId = string.Empty;
        publicKeyFingerprint = string.Empty;
        canonicalization = string.Empty;
        contentSha256 = string.Empty;
        createdAtUtc = string.Empty;
        signature = string.Empty;
        invalidMessage = string.Empty;

        if (envelope.Properties().Count() != ExpectedFields.Count)
        {
            invalidMessage = "Signature envelope must contain exactly ten fields.";
            return false;
        }

        var schemaToken = envelope["schemaVersion"];
        if (schemaToken?.Type != JTokenType.Integer
            || !int.TryParse(
                schemaToken.ToString(),
                NumberStyles.AllowLeadingSign,
                CultureInfo.InvariantCulture,
                out schemaVersion))
        {
            invalidMessage =
                "Signature envelope field 'schemaVersion' must be an integer.";
            return false;
        }

        return TryReadRequiredString(envelope, "app", out app, out invalidMessage)
            && TryReadRequiredString(
                envelope,
                "signedObject",
                out signedObject,
                out invalidMessage)
            && TryReadRequiredString(
                envelope,
                "algorithm",
                out algorithm,
                out invalidMessage)
            && TryReadRequiredString(
                envelope,
                "keyId",
                out keyId,
                out invalidMessage)
            && TryReadRequiredString(
                envelope,
                "publicKeyFingerprint",
                out publicKeyFingerprint,
                out invalidMessage)
            && TryReadRequiredString(
                envelope,
                "canonicalization",
                out canonicalization,
                out invalidMessage)
            && TryReadRequiredString(
                envelope,
                "contentSha256",
                out contentSha256,
                out invalidMessage)
            && TryReadRequiredString(
                envelope,
                "createdAtUtc",
                out createdAtUtc,
                out invalidMessage)
            && TryReadRequiredString(
                envelope,
                "signature",
                out signature,
                out invalidMessage);
    }

    private static bool TryReadRequiredString(
        JObject envelope,
        string name,
        out string value,
        out string invalidMessage)
    {
        var token = envelope[name];
        value = token?.Type == JTokenType.String
            ? token.Value<string>() ?? string.Empty
            : string.Empty;
        if (string.IsNullOrWhiteSpace(value))
        {
            invalidMessage =
                $"Signature envelope is missing required field '{name}'.";
            return false;
        }

        invalidMessage = string.Empty;
        return true;
    }
}
