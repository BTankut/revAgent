using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RevAgent.Bridge.Tests.Gateway.Protocol;

internal static class RbpFixtureReader
{
    private static readonly JsonSerializerOptions CompactJson = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    internal static JsonDocument Load(string fileName)
    {
        string path = Path.Combine(
            FindRepositoryRoot(),
            "packages",
            "protocol",
            "conformance",
            "fixtures",
            fileName);
        return JsonDocument.Parse(File.ReadAllBytes(path));
    }

    internal static byte[] MaterializePositive(JsonElement vector)
    {
        return Encoding.UTF8.GetBytes(
            MaterializePositiveNode(vector).ToJsonString(CompactJson));
    }

    internal static JsonObject CreatePositiveEnvelope(string name)
    {
        using JsonDocument fixture = Load("envelopes.json");
        JsonElement vector = fixture.RootElement
            .GetProperty("positive")
            .EnumerateArray()
            .Single(
                candidate => string.Equals(
                    candidate.GetProperty("name").GetString(),
                    name,
                    StringComparison.Ordinal));
        return MaterializePositiveNode(vector);
    }

    internal static byte[] MaterializeNegative(
        JsonElement fixtureRoot,
        JsonElement vector)
    {
        string baseName =
            vector.GetProperty("base").GetString() ??
            throw new InvalidDataException("Negative vector base is null.");
        JsonElement baseVector = fixtureRoot
            .GetProperty("positive")
            .EnumerateArray()
            .Single(
                candidate => string.Equals(
                    candidate.GetProperty("name").GetString(),
                    baseName,
                    StringComparison.Ordinal));
        JsonObject envelope = MaterializePositiveNode(baseVector);
        ApplyPatch(envelope, vector, "patch");
        ApplyRemove(envelope, vector, "remove");

        JsonObject payload = envelope["payload"]?.AsObject() ??
                             throw new InvalidDataException(
                                 "Materialized payload is missing.");
        ApplyPatch(payload, vector, "payload_patch");
        ApplyRemove(payload, vector, "payload_remove");
        return Encoding.UTF8.GetBytes(envelope.ToJsonString(CompactJson));
    }

    internal static byte[] Serialize(JsonObject value)
    {
        return Encoding.UTF8.GetBytes(value.ToJsonString(CompactJson));
    }

    internal static JsonObject CreateEnvelope(
        string type,
        JsonObject payload,
        bool data,
        string id = "0197a3c2-0000-7000-8000-000000000001")
    {
        var envelope = new JsonObject
        {
            ["v"] = 1,
            ["type"] = type,
            ["id"] = id,
            ["ts"] = "2026-07-22T12:00:00.000Z",
            ["payload"] = payload,
        };
        if (data)
        {
            envelope["rsid"] = "rs_fixture";
            envelope["seq"] = 1;
            envelope["ack"] = 0;
        }

        return envelope;
    }

    internal static string FindRepositoryRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "AGENTS.md")) &&
                Directory.Exists(
                    Path.Combine(
                        current.FullName,
                        "packages",
                        "protocol")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate the revAgent repository root.");
    }

    private static JsonObject MaterializePositiveNode(JsonElement vector)
    {
        string type =
            vector.GetProperty("type").GetString() ??
            throw new InvalidDataException("Positive vector type is null.");
        string scope =
            vector.GetProperty("scope").GetString() ??
            throw new InvalidDataException("Positive vector scope is null.");
        var envelope = new JsonObject
        {
            ["type"] = type,
            ["id"] = "0197a3c2-0000-7000-8000-000000000001",
            ["ts"] = "2026-07-22T12:00:00.000Z",
            ["payload"] = JsonNode.Parse(
                vector.GetProperty("payload").GetRawText()),
        };

        if (!string.Equals(
                scope,
                "pre_negotiation",
                StringComparison.Ordinal))
        {
            envelope["v"] = 1;
        }

        if (string.Equals(scope, "data", StringComparison.Ordinal))
        {
            envelope["rsid"] = "rs_fixture";
            envelope["seq"] = 1;
            envelope["ack"] = 0;
        }

        return envelope;
    }

    private static void ApplyPatch(
        JsonObject target,
        JsonElement vector,
        string propertyName)
    {
        if (!vector.TryGetProperty(propertyName, out JsonElement patch))
        {
            return;
        }

        foreach (JsonProperty property in patch.EnumerateObject())
        {
            target[property.Name] = JsonNode.Parse(
                property.Value.GetRawText());
        }
    }

    private static void ApplyRemove(
        JsonObject target,
        JsonElement vector,
        string propertyName)
    {
        if (!vector.TryGetProperty(propertyName, out JsonElement remove))
        {
            return;
        }

        foreach (JsonElement property in remove.EnumerateArray())
        {
            string name =
                property.GetString() ??
                throw new InvalidDataException(
                    "Remove vector contains null.");
            target.Remove(name);
        }
    }
}
