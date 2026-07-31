using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Protocol;

/// <summary>
/// Frozen Section 21 item 30 golden vectors for the Section 11 canonical
/// <c>batch_digest</c>. The canonical vector and its digest are copied
/// verbatim from the frozen spec example (~835-868), which anchors the RFC
/// 8785 engine; every changed-element vector (step omission, reorder,
/// changed policy, scope, clearance, atomic flag, timeout, params digest)
/// pins a digest that must never equal its base, because on redelivery any
/// changed element is a terminal <c>protocol</c> fault (~1102-1105), while
/// harmless property reordering is not a mismatch (~1104-1105).
/// </summary>
public sealed class RbpBatchDigestGoldenVectorTests
{
    private const string SpecCanonicalDigest =
        "sha256:c0d85d9f7b43d4ad4c9091b3213574c6fd9accf1250ffa4c45260925618fae41";

    [Fact]
    public void CanonicalVectorReproducesTheFrozenSpecDigest()
    {
        using JsonDocument fixture = LoadFixture();
        JsonElement payload =
            FindVector(fixture, "canonical").GetProperty("payload");

        string digest = Rfc8785Json.MakeBatchDigest(
            RbpBatchDigestInput.Parse(payload));

        Assert.Equal(SpecCanonicalDigest, digest);
        Assert.Equal(
            SpecCanonicalDigest,
            payload.GetProperty("batch_digest").GetString());

        // Spec ~875-878: the explicit on-wire step params_digest is the
        // Section 12.1 digest of the present functional params.
        JsonElement step = payload.GetProperty("steps")[0];
        Assert.Equal(
            step.GetProperty("params_digest").GetString(),
            Rfc8785Json.MakeParametersDigest(step.GetProperty("params")));
    }

    [Fact]
    public void EveryVectorMatchesItsPinnedExpectation()
    {
        using JsonDocument fixture = LoadFixture();
        IReadOnlyDictionary<string, string> digests =
            ComputeAcceptedDigests(fixture);

        foreach (JsonElement vector in Vectors(fixture))
        {
            string name = vector.GetProperty("name").GetString()!;
            JsonElement expect = vector.GetProperty("expect");
            if (expect.TryGetProperty("rejected", out JsonElement rejected))
            {
                Assert.True(rejected.GetBoolean());
                Assert.ThrowsAny<RbpFrameException>(
                    () => _ = RbpBatchDigestInput.Parse(
                        vector.GetProperty("payload")));
                continue;
            }

            Assert.Equal(
                expect.GetProperty("digest").GetString(),
                digests[name]);
            if (expect.TryGetProperty("equals", out JsonElement equals))
            {
                Assert.Equal(digests[equals.GetString()!], digests[name]);
            }

            if (expect.TryGetProperty(
                    "differs_from",
                    out JsonElement differs))
            {
                Assert.NotEqual(
                    digests[differs.GetString()!],
                    digests[name]);
            }
        }
    }

    [Fact]
    public void EveryChangedElementProducesItsOwnDistinctDigest()
    {
        using JsonDocument fixture = LoadFixture();
        IReadOnlyDictionary<string, string> digests =
            ComputeAcceptedDigests(fixture);

        // property-reorder and step-omitted intentionally collide with the
        // canonical single-step material; every other vector is a distinct
        // semantic and must carry a distinct digest.
        var equivalents = new HashSet<string>(StringComparer.Ordinal)
        {
            "property-reorder",
            "step-omitted",
        };
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach ((string name, string digest) in digests)
        {
            if (equivalents.Contains(name))
            {
                Assert.Equal(digests["canonical"], digest);
                continue;
            }

            Assert.True(
                seen.Add(digest),
                $"Vector '{name}' collided with another semantic digest.");
        }
    }

    private static IReadOnlyDictionary<string, string>
        ComputeAcceptedDigests(JsonDocument fixture)
    {
        var digests = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (JsonElement vector in Vectors(fixture))
        {
            if (vector.GetProperty("expect").TryGetProperty(
                    "rejected",
                    out _))
            {
                continue;
            }

            digests[vector.GetProperty("name").GetString()!] =
                Rfc8785Json.MakeBatchDigest(
                    RbpBatchDigestInput.Parse(
                        vector.GetProperty("payload")));
        }

        return digests;
    }

    private static JsonElement.ArrayEnumerator Vectors(
        JsonDocument fixture) =>
        fixture.RootElement.GetProperty("vectors").EnumerateArray();

    private static JsonElement FindVector(JsonDocument fixture, string name)
    {
        foreach (JsonElement vector in Vectors(fixture))
        {
            if (string.Equals(
                    vector.GetProperty("name").GetString(),
                    name,
                    StringComparison.Ordinal))
            {
                return vector;
            }
        }

        throw new InvalidDataException(
            $"The batch digest fixture has no vector named '{name}'.");
    }

    private static JsonDocument LoadFixture()
    {
        string path = Path.Combine(
            RbpFixtureReader.FindRepositoryRoot(),
            "packages",
            "bridge",
            "test-fixtures",
            "batch",
            "batch-digest-vectors.json");
        return JsonDocument.Parse(File.ReadAllBytes(path));
    }
}
