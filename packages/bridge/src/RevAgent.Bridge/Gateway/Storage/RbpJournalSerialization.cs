using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Storage;

internal static class RbpJournalSerialization
{
    internal static (string Json, string Digest) CanonicalRegistration(
        JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object)
        {
            throw new ArgumentException(
                "The session registration payload must be a JSON object.",
                nameof(payload));
        }

        RejectResumeTokenProperty(payload);

        string canonical = Rfc8785Json.Canonicalize(payload);
        using JsonDocument material = JsonDocument.Parse(canonical);
        return (canonical, Rfc8785Json.Sha256Digest(material.RootElement));
    }

    internal static IReadOnlyList<string> NormalizeCapabilities(
        IReadOnlyList<string> capabilities)
    {
        ArgumentNullException.ThrowIfNull(capabilities);
        var unique = new SortedSet<string>(StringComparer.Ordinal);
        foreach (string capability in capabilities)
        {
            if (string.IsNullOrWhiteSpace(capability) ||
                capability.Length > 128)
            {
                throw new ArgumentException(
                    "Granted session capabilities must be bounded and " +
                    "non-empty.",
                    nameof(capabilities));
            }

            if (!unique.Add(capability))
            {
                throw new ArgumentException(
                    "Granted session capabilities must be unique.",
                    nameof(capabilities));
            }
        }

        return Array.AsReadOnly(unique.ToArray());
    }

    internal static string SerializeCapabilities(
        IReadOnlyList<string> capabilities)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            foreach (string capability in capabilities)
            {
                writer.WriteStringValue(capability);
            }

            writer.WriteEndArray();
        }

        using JsonDocument material =
            JsonDocument.Parse(stream.ToArray());
        return Rfc8785Json.Canonicalize(material.RootElement);
    }

    internal static IReadOnlyList<string> ParseCapabilities(string json)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                throw Corrupt(
                    "Granted capabilities are not a JSON array.");
            }

            var values = new List<string>();
            foreach (JsonElement item in
                     document.RootElement.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String)
                {
                    throw Corrupt(
                        "Granted capabilities contain a non-string value.");
                }

                values.Add(item.GetString() ?? string.Empty);
            }

            try
            {
                return NormalizeCapabilities(values);
            }
            catch (ArgumentException exception)
            {
                throw Corrupt(
                    "Granted capabilities are not canonical.",
                    exception);
            }
        }
        catch (RbpJournalException)
        {
            throw;
        }
        catch (JsonException exception)
        {
            throw Corrupt(
                "Granted capabilities contain malformed JSON.",
                exception);
        }
    }

    internal static JsonElement ParseRegistration(
        string json,
        string expectedDigest)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            string digest =
                Rfc8785Json.Sha256Digest(document.RootElement);
            if (!string.Equals(
                    digest,
                    expectedDigest,
                    StringComparison.Ordinal))
            {
                throw Corrupt(
                    "The registration payload digest does not match.");
            }

            string canonical =
                Rfc8785Json.Canonicalize(document.RootElement);
            if (!string.Equals(canonical, json, StringComparison.Ordinal))
            {
                throw Corrupt(
                    "The registration payload is not canonical JSON.");
            }

            return document.RootElement.Clone();
        }
        catch (RbpJournalException)
        {
            throw;
        }
        catch (Exception exception)
            when (exception is JsonException or InvalidOperationException)
        {
            throw Corrupt(
                "The registration payload is malformed.",
                exception);
        }
    }

    internal static string SerializeEnvelope(
        RbpDataEnvelopeSnapshot envelope)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteNumber("v", envelope.Version);
            writer.WriteString("type", envelope.Type);
            writer.WriteString("id", envelope.Id);
            writer.WriteString("rsid", envelope.Rsid);
            writer.WriteNumber("seq", envelope.Sequence);
            if (envelope.Acknowledgement is { } acknowledgement)
            {
                writer.WriteNumber("ack", acknowledgement);
            }

            if (envelope.Timestamp is not null)
            {
                writer.WriteString("ts", envelope.Timestamp);
            }

            writer.WritePropertyName("payload");
            envelope.Payload.WriteTo(writer);
            writer.WriteEndObject();
        }

        using JsonDocument material =
            JsonDocument.Parse(stream.ToArray());
        return Rfc8785Json.Canonicalize(material.RootElement);
    }

    internal static RbpDataEnvelopeSnapshot ParseEnvelope(
        string json,
        string expectedDigest)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            Rfc8785Json.EnsureUniqueObjectKeys(root);
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw Corrupt("The retained RBP envelope is not an object.");
            }

            string canonical = Rfc8785Json.Canonicalize(root);
            if (!string.Equals(canonical, json, StringComparison.Ordinal))
            {
                throw Corrupt(
                    "The retained RBP envelope is not canonical JSON.");
            }

            int version = RequiredInt32(root, "v");
            string type = RequiredString(root, "type");
            string id = RequiredString(root, "id");
            string rsid = RequiredString(root, "rsid");
            long sequence = RequiredInt64(root, "seq");
            long? acknowledgement = OptionalInt64(root, "ack");
            string? timestamp = OptionalString(root, "ts");
            if (!root.TryGetProperty("payload", out JsonElement payload))
            {
                throw Corrupt(
                    "The retained RBP envelope has no payload.");
            }

            bool safe =
                version == 1 &&
                sequence >= 1 &&
                sequence <= RbpSequenceReducer.MaximumSafeSequence &&
                (!acknowledgement.HasValue ||
                 (acknowledgement.Value >= 0 &&
                  acknowledgement.Value <=
                  RbpSequenceReducer.MaximumSafeSequence));
            if (!safe)
            {
                throw Corrupt(
                    "The retained RBP envelope has invalid protocol " +
                    "counters.");
            }

            var envelope = new RbpDataEnvelopeSnapshot(
                type,
                id,
                rsid,
                sequence,
                payload.Clone(),
                acknowledgement,
                timestamp,
                version);
            string digest = Rfc8785Json.ImmutableEnvelopeDigest(envelope);
            if (!string.Equals(
                    digest,
                    expectedDigest,
                    StringComparison.Ordinal))
            {
                throw Corrupt(
                    "The retained RBP envelope digest does not match.");
            }

            return envelope;
        }
        catch (RbpJournalException)
        {
            throw;
        }
        catch (Exception exception)
            when (exception is JsonException or InvalidOperationException or
                FormatException or OverflowException)
        {
            throw Corrupt(
                "The retained RBP envelope is malformed.",
                exception);
        }
    }

    internal static string ReasonToWire(RbpSessionUnregisterReason reason) =>
        reason switch
        {
            RbpSessionUnregisterReason.RevitExited => "revit_exited",
            RbpSessionUnregisterReason.BridgeShutdown => "bridge_shutdown",
            RbpSessionUnregisterReason.SessionReplaced =>
                "session_replaced",
            RbpSessionUnregisterReason.OperatorRequested =>
                "operator_requested",
            _ => throw new ArgumentOutOfRangeException(nameof(reason)),
        };

    internal static RbpSessionUnregisterReason ParseReason(string value) =>
        value switch
        {
            "revit_exited" => RbpSessionUnregisterReason.RevitExited,
            "bridge_shutdown" => RbpSessionUnregisterReason.BridgeShutdown,
            "session_replaced" =>
                RbpSessionUnregisterReason.SessionReplaced,
            "operator_requested" =>
                RbpSessionUnregisterReason.OperatorRequested,
            _ => throw Corrupt("The unregister reason is not recognized."),
        };

    internal static RbpUnregisterPhase ParsePhase(string value) =>
        value switch
        {
            "pending" => RbpUnregisterPhase.Pending,
            "confirmed" => RbpUnregisterPhase.Confirmed,
            _ => throw Corrupt("The unregister phase is not recognized."),
        };

    internal static RbpJournalException Corrupt(
        string message,
        Exception? innerException = null) =>
        new(
            RbpJournalErrorCode.IntegrityCheckFailed,
            message,
            innerException);

    private static void RejectResumeTokenProperty(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (JsonProperty property in value.EnumerateObject())
            {
                if (property.NameEquals("resume_token"))
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.SecretProtectionFailed,
                        "A plaintext resume token must not be embedded " +
                        "anywhere in the persisted registration payload.");
                }

                RejectResumeTokenProperty(property.Value);
            }

            return;
        }

        if (value.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (JsonElement item in value.EnumerateArray())
        {
            RejectResumeTokenProperty(item);
        }
    }

    private static int RequiredInt32(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value) ||
            !value.TryGetInt32(out int parsed))
        {
            throw Corrupt($"The retained RBP envelope has invalid '{name}'.");
        }

        return parsed;
    }

    private static long RequiredInt64(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value) ||
            !value.TryGetInt64(out long parsed))
        {
            throw Corrupt($"The retained RBP envelope has invalid '{name}'.");
        }

        return parsed;
    }

    private static long? OptionalInt64(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value))
        {
            return null;
        }

        if (!value.TryGetInt64(out long parsed))
        {
            throw Corrupt($"The retained RBP envelope has invalid '{name}'.");
        }

        return parsed;
    }

    private static string RequiredString(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value) ||
            value.ValueKind != JsonValueKind.String)
        {
            throw Corrupt($"The retained RBP envelope has invalid '{name}'.");
        }

        string parsed = value.GetString() ?? string.Empty;
        if (string.IsNullOrEmpty(parsed))
        {
            throw Corrupt($"The retained RBP envelope has empty '{name}'.");
        }

        return parsed;
    }

    private static string? OptionalString(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value))
        {
            return null;
        }

        if (value.ValueKind != JsonValueKind.String)
        {
            throw Corrupt($"The retained RBP envelope has invalid '{name}'.");
        }

        return value.GetString();
    }
}
