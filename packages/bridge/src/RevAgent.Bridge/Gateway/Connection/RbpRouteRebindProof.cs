using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Connection;

/// <summary>
/// Constructs the sole unsequenced document-route authority admitted by the
/// WP-12 amendment.  This type deliberately has no journal or outbox
/// dependency: a proof must be obtained again after every connection change.
/// </summary>
internal static partial class RbpRouteRebindProof
{
    private const string CheckpointDomain =
        "revagent/c39-route-authority-checkpoint/v1\0";
    private const string ConnectionDomain =
        "revagent/c39-route-authority-connection/v1\0";
    private static readonly Regex UuidV7Pattern = new(
        "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    internal static RbpRouteRebindProofResult Create(
        string rsid,
        string connectionId,
        RbpFreshDocumentContext fresh,
        RbpUuidV7 identifiers)
    {
        ArgumentException.ThrowIfNullOrEmpty(connectionId);
        ArgumentNullException.ThrowIfNull(fresh);
        ArgumentNullException.ThrowIfNull(identifiers);
        if (!UuidV7Pattern.IsMatch(connectionId))
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.InvalidControlPayload,
                "hello_ack connection_id is not a lowercase UUIDv7.");
        }

        string proofId = identifiers.NewId();
        if (!UuidV7Pattern.IsMatch(proofId))
        {
            throw new InvalidOperationException(
                "The RBP UUIDv7 generator returned an invalid proof id.");
        }

        string contextDigest = RbpDocumentContextObservation
            .MakeContextDigest(fresh.Context);
        JsonElement payload = JsonSerializer.SerializeToElement(
            new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["version"] = 1,
                ["connection_id"] = connectionId,
                ["proof_id"] = proofId,
                ["context"] = fresh.Context,
                ["context_digest"] = contextDigest,
                ["freshness"] = new Dictionary<string, object?>(
                    StringComparer.Ordinal)
                {
                    ["source_revision"] = fresh.Freshness.SourceRevision,
                    ["cache_incarnation_digest"] =
                        fresh.Freshness.CacheIncarnationDigest,
                },
            });
        return new RbpRouteRebindProofResult(
            payload,
            MakeAuthorityCheckpoint(payload, rsid));
    }

    internal static string MakeAuthorityCheckpoint(JsonElement proof, string rsid)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);
        JsonElement freshness = proof.GetProperty("freshness");
        JsonElement checkpoint = JsonSerializer.SerializeToElement(
            new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["rsid"] = rsid,
                ["connection_id"] = proof.GetProperty("connection_id").GetString(),
                ["proof_id"] = proof.GetProperty("proof_id").GetString(),
                ["context_digest"] = proof.GetProperty("context_digest").GetString(),
                ["freshness"] = new Dictionary<string, object?>
                {
                    ["source_revision"] = freshness.GetProperty("source_revision").GetInt64(),
                    ["cache_incarnation_digest"] = freshness.GetProperty("cache_incarnation_digest").GetString(),
                },
            });
        return MakeDigest(CheckpointDomain, checkpoint);
    }

    internal static string MakeConnectionDigest(string rsid, string connectionId)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);
        ArgumentException.ThrowIfNullOrEmpty(connectionId);
        JsonElement value = JsonSerializer.SerializeToElement(
            new Dictionary<string, object?>
            {
                ["rsid"] = rsid,
                ["connection_id"] = connectionId,
            });
        return MakeDigest(ConnectionDomain, value);
    }

    private static string MakeDigest(string domainText, JsonElement value)
    {
        byte[] domain = new UTF8Encoding(false, true).GetBytes(domainText);
        byte[] canonical = new UTF8Encoding(false, true).GetBytes(
            Rfc8785Json.Canonicalize(value));
        byte[] input = new byte[domain.Length + canonical.Length];
        Buffer.BlockCopy(domain, 0, input, 0, domain.Length);
        Buffer.BlockCopy(canonical, 0, input, domain.Length, canonical.Length);
        return "sha256:" + Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant();
    }
}

internal sealed record RbpRouteRebindProofResult(
    JsonElement Payload,
    string AuthorityCheckpoint);
