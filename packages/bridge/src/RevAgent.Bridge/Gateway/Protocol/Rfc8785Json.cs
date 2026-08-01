using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Org.Webpki.JsonCanonicalizer;

namespace RevAgent.Bridge.Gateway.Protocol;

internal static class Rfc8785Json
{
    private const string DigestPrefix = "sha256:";
    private const string VerificationHoldPrefix = "vh:";
    private static readonly UTF8Encoding StrictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);

    internal static string Canonicalize(JsonElement value)
    {
        EnsureUniqueObjectKeys(value);

        // jsoncanonicalizer accepts an object or array at the root. Wrapping one
        // value in an array preserves the exact RFC 8785 serialization of that
        // value between the first and final bracket, including scalar values.
        string wrapped = "[" + value.GetRawText() + "]";
        var canonicalizer = new JsonCanonicalizer(wrapped);
        string canonical = canonicalizer.GetEncodedString();
        if (canonical.Length < 2 ||
            canonical[0] != '[' ||
            canonical[^1] != ']')
        {
            throw new InvalidOperationException(
                "RFC 8785 canonicalizer returned an invalid wrapper.");
        }

        return canonical[1..^1];
    }

    internal static string Sha256Digest(JsonElement value)
    {
        byte[] bytes = StrictUtf8.GetBytes(Canonicalize(value));
        return DigestPrefix +
               Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    internal static string MakeParametersDigest(JsonElement parameters)
    {
        return Sha256Digest(parameters);
    }

    internal static string MakeBatchDigest(RbpBatchDigestInput batch)
    {
        ArgumentNullException.ThrowIfNull(batch);
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteBoolean("atomic", batch.Atomic);
            writer.WriteString("batch_id", batch.BatchId);
            writer.WritePropertyName("recovery_clearances");
            writer.WriteStartArray();
            foreach (JsonElement clearance in batch.RecoveryClearances)
            {
                clearance.WriteTo(writer);
            }

            writer.WriteEndArray();
            writer.WritePropertyName("steps");
            writer.WriteStartArray();
            foreach (RbpBatchDigestStep step in batch.Steps)
            {
                writer.WriteStartObject();
                writer.WriteString("invocation_id", step.InvocationId);
                writer.WriteString("method", step.Method);
                writer.WriteBoolean("mutating", step.Mutating);
                writer.WritePropertyName("mutation_scope");
                step.MutationScope.WriteTo(writer);
                writer.WriteString(
                    "params_digest",
                    step.ParametersDigest);
                writer.WritePropertyName("policy");
                writer.WriteStartObject();
                writer.WriteString("class", step.Policy.PolicyClass);
                if (step.Policy.ConfirmationId is null)
                {
                    writer.WriteNull("confirmation_id");
                }
                else
                {
                    writer.WriteString(
                        "confirmation_id",
                        step.Policy.ConfirmationId);
                }

                writer.WriteString("decision", step.Policy.Decision);
                writer.WriteEndObject();
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteNumber(
                "timeout_ms",
                batch.TimeoutMilliseconds);
            writer.WriteEndObject();
        }

        using JsonDocument material = JsonDocument.Parse(stream.ToArray());
        return Sha256Digest(material.RootElement);
    }

    /// <summary>
    /// The frozen Section 6.2.1 mutation-recovery hold correlation id
    /// (spec ~469-480).
    /// </summary>
    /// <remarks>
    /// <para>The frozen material and derivation are, verbatim:</para>
    /// <code>
    /// hold_material = {"mutation_scope":&lt;scope&gt;,"origin_idempotency_keys":[&lt;ordered keys&gt;],"rsid":&lt;rsid&gt;}
    /// verification_hold_id = "vh:" + lowercase_hex(SHA-256(UTF-8-without-BOM(RFC8785-JCS(hold_material))))
    /// </code>
    /// <para>
    /// The same RFC 8785 engine and the same strict UTF-8 encoder that
    /// produce <c>params_digest</c> and <c>batch_digest</c> produce this
    /// value, so the two peers derive one identical id from one identical
    /// material. Array order is significant: the origin list is the frozen
    /// input order of the possibly executed mutating keys in that scope, and
    /// a permuted list is a different hold.
    /// </para>
    /// </remarks>
    internal static string MakeVerificationHoldId(
        string rsid,
        JsonElement mutationScope,
        IReadOnlyList<string> orderedOriginIdempotencyKeys)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);
        ArgumentNullException.ThrowIfNull(orderedOriginIdempotencyKeys);
        if (orderedOriginIdempotencyKeys.Count == 0)
        {
            throw new ArgumentException(
                "A verification hold requires at least one origin " +
                "idempotency key.",
                nameof(orderedOriginIdempotencyKeys));
        }

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("mutation_scope");
            mutationScope.WriteTo(writer);
            writer.WritePropertyName("origin_idempotency_keys");
            writer.WriteStartArray();
            foreach (string key in orderedOriginIdempotencyKeys)
            {
                ArgumentException.ThrowIfNullOrEmpty(
                    key,
                    nameof(orderedOriginIdempotencyKeys));
                writer.WriteStringValue(key);
            }

            writer.WriteEndArray();
            writer.WriteString("rsid", rsid);
            writer.WriteEndObject();
        }

        using JsonDocument material = JsonDocument.Parse(stream.ToArray());
        return VerificationHoldPrefix +
               Sha256Digest(material.RootElement)[DigestPrefix.Length..];
    }

    internal static string ImmutableEnvelopeDigest(
        RbpDataEnvelopeSnapshot envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("id", envelope.Id);
            writer.WritePropertyName("payload");
            envelope.Payload.WriteTo(writer);
            writer.WriteString("rsid", envelope.Rsid);
            writer.WriteNumber("seq", envelope.Sequence);
            writer.WriteString("type", envelope.Type);
            writer.WriteNumber("v", envelope.Version);
            writer.WriteEndObject();
        }

        using JsonDocument material = JsonDocument.Parse(stream.ToArray());
        return Sha256Digest(material.RootElement);
    }

    internal static void EnsureUniqueObjectKeys(JsonElement value)
    {
        RejectDuplicateKeys(value, path: string.Empty);
    }

    private static void RejectDuplicateKeys(JsonElement value, string path)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in value.EnumerateObject())
            {
                string propertyName;
                try
                {
                    propertyName = property.Name;
                }
                catch (InvalidOperationException exception)
                {
                    throw InvalidUnicode(path, exception);
                }

                EnsureWellFormedUtf16(propertyName, path);
                string propertyPath =
                    path + "/" + EscapeJsonPointer(propertyName);
                if (!names.Add(propertyName))
                {
                    throw new RbpFrameException(
                        RbpFrameErrorCode.DuplicateKey,
                        $"Duplicate JSON object key '{propertyName}' is " +
                        "not allowed in canonical JSON.",
                        propertyPath);
                }

                RejectDuplicateKeys(property.Value, propertyPath);
            }

            return;
        }

        if (value.ValueKind == JsonValueKind.String)
        {
            string text;
            try
            {
                text = value.GetString() ?? string.Empty;
            }
            catch (InvalidOperationException exception)
            {
                throw InvalidUnicode(path, exception);
            }

            EnsureWellFormedUtf16(text, path);
            return;
        }

        if (value.ValueKind == JsonValueKind.Number)
        {
            if (!value.TryGetDouble(out double number) ||
                !double.IsFinite(number))
            {
                throw new RbpFrameException(
                    RbpFrameErrorCode.InvalidEnvelope,
                    "RFC 8785 JSON numbers must be finite IEEE 754 values.",
                    string.IsNullOrEmpty(path) ? "/" : path);
            }

            return;
        }

        if (value.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        int index = 0;
        foreach (JsonElement item in value.EnumerateArray())
        {
            RejectDuplicateKeys(item, path + "/" + index);
            index++;
        }
    }

    private static void EnsureWellFormedUtf16(string value, string path)
    {
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (char.IsHighSurrogate(character))
            {
                if (index + 1 < value.Length &&
                    char.IsLowSurrogate(value[index + 1]))
                {
                    index++;
                    continue;
                }

                throw InvalidUnicode(path);
            }

            if (char.IsLowSurrogate(character))
            {
                throw InvalidUnicode(path);
            }
        }
    }

    private static RbpFrameException InvalidUnicode(
        string path,
        Exception? innerException = null)
    {
        return new RbpFrameException(
            RbpFrameErrorCode.InvalidEnvelope,
            "RFC 8785 JSON strings must not contain unpaired UTF-16 " +
            "surrogates.",
            string.IsNullOrEmpty(path) ? "/" : path,
            innerException: innerException);
    }

    private static string EscapeJsonPointer(string value)
    {
        return value
            .Replace("~", "~0", StringComparison.Ordinal)
            .Replace("/", "~1", StringComparison.Ordinal);
    }
}
