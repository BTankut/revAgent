using System.Text.Json;
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
    private static readonly Regex UuidV7Pattern = new(
        "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    internal static JsonElement Create(
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
        return JsonSerializer.SerializeToElement(
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
    }
}
