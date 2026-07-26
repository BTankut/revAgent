using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.Signing;

public static class DetachedSignatureContract
{
    public const int SchemaVersion = 1;
    public const string App = "revAgent";
    public const string LegacyApp = "revit-mcp-skill";
    public const string BridgeManifestSignedObject = "bridge-manifest";
    public const string Algorithm = "RS256";
    public const string Canonicalization = "RFC8785-JCS-SHA256-v1";

    public static readonly IReadOnlyList<string> EnvelopeFields = new[]
    {
        "schemaVersion",
        "app",
        "signedObject",
        "algorithm",
        "keyId",
        "publicKeyFingerprint",
        "canonicalization",
        "contentSha256",
        "createdAtUtc",
        "signature",
    };

    public static readonly IReadOnlyList<string> SignedProjectionFields = new[]
    {
        "schemaVersion",
        "app",
        "signedObject",
        "algorithm",
        "keyId",
        "publicKeyFingerprint",
        "canonicalization",
        "contentSha256",
        "createdAtUtc",
    };
}

public sealed class DetachedSignaturePolicy
{
    private readonly HashSet<string> _acceptedApps;
    private readonly HashSet<string> _allowedSignedObjects;

    public DetachedSignaturePolicy(
        IEnumerable<string> acceptedApps,
        IEnumerable<string> allowedSignedObjects)
    {
        _acceptedApps = new HashSet<string>(
            acceptedApps ?? throw new ArgumentNullException(nameof(acceptedApps)),
            StringComparer.Ordinal);
        _allowedSignedObjects = new HashSet<string>(
            allowedSignedObjects
                ?? throw new ArgumentNullException(nameof(allowedSignedObjects)),
            StringComparer.Ordinal);
        if (_acceptedApps.Count == 0 || _allowedSignedObjects.Count == 0)
        {
            throw new ArgumentException(
                "Signature policy requires at least one app and signed object.");
        }
    }

    public IReadOnlyCollection<string> AcceptedApps => _acceptedApps;

    public IReadOnlyCollection<string> AllowedSignedObjects => _allowedSignedObjects;

    public bool AcceptsApp(string app) => _acceptedApps.Contains(app);

    public bool AllowsSignedObject(string signedObject)
        => _allowedSignedObjects.Contains(signedObject);

    public static DetachedSignaturePolicy BridgeManifest { get; } = new(
        new[] { DetachedSignatureContract.LegacyApp, DetachedSignatureContract.App },
        new[] { DetachedSignatureContract.BridgeManifestSignedObject });

    public static DetachedSignaturePolicy CompatibilityOracle { get; } = new(
        new[] { DetachedSignatureContract.LegacyApp, DetachedSignatureContract.App },
        new[]
        {
            "channel",
            "release-manifest",
            "license-seat",
            DetachedSignatureContract.BridgeManifestSignedObject,
        });
}

public sealed class TrustedPublicKey
{
    public TrustedPublicKey(
        string keyId,
        string publicKeyXml,
        string? publicKeyFingerprint = null)
    {
        KeyId = keyId;
        PublicKeyXml = publicKeyXml;
        PublicKeyFingerprint = publicKeyFingerprint;
    }

    public string KeyId { get; }

    public string PublicKeyXml { get; }

    public string? PublicKeyFingerprint { get; }
}

public sealed class TrustedPublicKeyRing
{
    private readonly IReadOnlyDictionary<string, TrustedPublicKey> _keys;

    private TrustedPublicKeyRing(
        IReadOnlyDictionary<string, TrustedPublicKey> keys)
    {
        _keys = keys;
    }

    public int Count => _keys.Count;

    public static TrustedPublicKeyRing Create(
        IEnumerable<TrustedPublicKey> trustedKeys)
    {
        if (trustedKeys is null)
        {
            throw new ArgumentNullException(nameof(trustedKeys));
        }

        var keys = new Dictionary<string, TrustedPublicKey>(
            StringComparer.OrdinalIgnoreCase);
        foreach (var trustedKey in trustedKeys)
        {
            if (trustedKey is null || string.IsNullOrWhiteSpace(trustedKey.KeyId))
            {
                throw new ArgumentException(
                    "Trusted keys require a non-empty keyId.",
                    nameof(trustedKeys));
            }

            if (keys.ContainsKey(trustedKey.KeyId))
            {
                throw new ArgumentException(
                    $"Trusted keyId is duplicated, including case-only variants: {trustedKey.KeyId}",
                    nameof(trustedKeys));
            }

            keys.Add(trustedKey.KeyId, trustedKey);
        }

        return new TrustedPublicKeyRing(keys);
    }

    public bool TryGet(string keyId, out TrustedPublicKey trustedKey)
    {
        return _keys.TryGetValue(keyId, out trustedKey!);
    }
}

public sealed class SignatureVerificationResult
{
    private SignatureVerificationResult(
        bool success,
        string reason,
        string message,
        string signedObject,
        string keyId,
        string contentSha256)
    {
        Success = success;
        State = success ? "verified" : "rejected";
        Reason = reason;
        Message = message;
        SignedObject = signedObject;
        KeyId = keyId;
        ContentSha256 = contentSha256;
    }

    public bool Success { get; }

    public string State { get; }

    public string Reason { get; }

    public string Message { get; }

    public string SignedObject { get; }

    public string KeyId { get; }

    public string ContentSha256 { get; }

    public string Canonicalization => DetachedSignatureContract.Canonicalization;

    public string Algorithm => DetachedSignatureContract.Algorithm;

    public static SignatureVerificationResult Verified(
        string signedObject,
        string keyId,
        string contentSha256)
    {
        return new SignatureVerificationResult(
            true,
            "ok",
            "Detached JSON signature verified.",
            signedObject,
            keyId,
            contentSha256);
    }

    public static SignatureVerificationResult Rejected(
        string reason,
        string message,
        string signedObject = "",
        string keyId = "",
        string contentSha256 = "")
    {
        return new SignatureVerificationResult(
            false,
            reason,
            message,
            signedObject,
            keyId,
            contentSha256);
    }
}

public static class DetachedSignatureProjection
{
    public static JObject Create(JObject envelope)
    {
        if (envelope is null)
        {
            throw new ArgumentNullException(nameof(envelope));
        }

        var projection = new JObject();
        foreach (var field in DetachedSignatureContract.SignedProjectionFields)
        {
            projection[field] = envelope[field]?.DeepClone()
                ?? throw new InvalidDataException(
                    $"Signature envelope is missing required field '{field}'.");
        }

        return projection;
    }
}
