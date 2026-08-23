using System.Security.Cryptography;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// Converts the add-in loopback fixture's value-only multi-file response into
/// the Section 13 wire carrier.  The spool is deliberately below the bridge
/// state root and is an evidence cache, not a second delivery authority: the
/// RBP journal/outbox remains the authority for every emitted frame.
/// </summary>
internal sealed class RbpArtifactCarrierProducer
{
    internal const int MaximumChunkBytes = 1024 * 1024;
    internal const int MaximumCombinedBytes = 32 * 1024 * 1024;
    internal const int MaximumArtifacts = 16;
    internal static readonly TimeSpan DefaultSpoolExpiry = TimeSpan.FromDays(7);

    private readonly string _root;
    private readonly RbpJournalStore _journal;

    private RbpArtifactCarrierProducer(string root, RbpJournalStore journal)
    {
        _root = root;
        _journal = journal;
    }

    internal static RbpArtifactCarrierProducer CreateProduction(
        string stateRoot,
        RbpJournalStore journal)
    {
        ArgumentException.ThrowIfNullOrEmpty(stateRoot);
        ArgumentNullException.ThrowIfNull(journal);
        string root = Path.GetFullPath(Path.Combine(stateRoot, "artifact-spool"));
        EnsureSafeDirectory(root);
        var producer = new RbpArtifactCarrierProducer(root, journal);
        producer.SweepExpired(DateTimeOffset.UtcNow);
        return producer;
    }

    internal static IReadOnlyList<string> ConnectionCapabilities { get; } =
        Array.AsReadOnly(new[] { "journal_v1", "chunked_results", "artifact_result_v1" });

    internal async Task<RbpCarrierEmission?> TryPrepareAsync(
        string rsid,
        JsonElement invocationBody,
        JsonElement addinResult,
        IReadOnlyList<string> grantedConnectionCapabilities,
        CancellationToken cancellationToken)
    {
        await Task.CompletedTask.ConfigureAwait(false);
        if (addinResult.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        bool artifactOutput = addinResult.TryGetProperty(
            "files", out JsonElement files);
        byte[] resultBytes = artifactOutput
            ? Array.Empty<byte>()
            : System.Text.Encoding.UTF8.GetBytes(
                Rfc8785Json.Canonicalize(addinResult));
        if (!artifactOutput && resultBytes.Length <= MaximumChunkBytes)
        {
            return null;
        }

        if (!grantedConnectionCapabilities.Contains(
                "chunked_results", StringComparer.Ordinal) ||
            (artifactOutput && !grantedConnectionCapabilities.Contains(
                "artifact_result_v1", StringComparer.Ordinal)))
        {
            throw new RbpArtifactCarrierException(
                "Artifact output is unavailable until both carrier " +
                "capabilities are granted for this session.");
        }

        string invocationId = RequireString(invocationBody, "invocation_id", 128);
        string invocationRoot = Path.Combine(_root, SafeSegment(invocationId));
        EnsureSafeDirectory(invocationRoot);

        if (!artifactOutput)
        {
            return PrepareChunkedResult(invocationRoot, invocationId, rsid,
                invocationBody, resultBytes);
        }

        IReadOnlyList<RbpArtifactInput> inputs = ParseInputs(files);

        var chunks = new List<RbpInvocationAnswer>();
        var descriptors = new List<RbpArtifactDescriptor>();
        var references = new List<RbpArtifactReference>();
        long combined = 0;
        for (int index = 0; index < inputs.Count; index++)
        {
            RbpArtifactInput input = inputs[index];
            checked { combined += input.Bytes.Length; }
            if (combined > MaximumCombinedBytes)
            {
                throw new RbpArtifactCarrierException(
                    "Artifact output exceeds the 32 MiB carrier limit.");
            }

            string artifactId = StableArtifactId(invocationId, index, input.Digest);
            string artifactPath = Path.Combine(invocationRoot, artifactId + ".bin");
            WriteImmutable(artifactPath, input.Bytes, input.Digest);
            int totalChunks = checked((input.Bytes.Length + MaximumChunkBytes - 1) /
                                     MaximumChunkBytes);
            for (int chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++)
            {
                int offset = checked(chunkIndex * MaximumChunkBytes);
                int length = Math.Min(MaximumChunkBytes, input.Bytes.Length - offset);
                byte[] bytes = input.Bytes.AsSpan(offset, length).ToArray();
                chunks.Add(RbpInvocationAnswer.Partial(
                    ChunkPayload(
                        invocationId,
                        artifactId,
                        index,
                        chunkIndex,
                        input.ContentType,
                        bytes)));
            }

            descriptors.Add(new RbpArtifactDescriptor(
                artifactId,
                index,
                input.FileName,
                input.ContentType,
                totalChunks,
                input.Bytes.Length,
                input.Digest));
            references.Add(new RbpArtifactReference(artifactId, index));
        }

        WriteManifest(invocationRoot, invocationId, rsid, descriptors);
        return new RbpCarrierEmission(
            ReplaceTerminal(invocationBody, descriptors, references),
            chunks.AsReadOnly(),
            SafeSegment(invocationId));
    }

    internal Task<RbpCarrierEmission?> TryPrepareAsync(
        string rsid,
        JsonElement invocationBody,
        JsonElement addinResult,
        CancellationToken cancellationToken) =>
        TryPrepareAsync(
            rsid,
            invocationBody,
            addinResult,
            ConnectionCapabilities,
            cancellationToken);

    private static RbpCarrierEmission PrepareChunkedResult(
        string invocationRoot,
        string invocationId,
        string rsid,
        JsonElement invocationBody,
        byte[] bytes)
    {
        if (bytes.Length > MaximumCombinedBytes)
        {
            throw new RbpArtifactCarrierException(
                "Chunked result exceeds the 32 MiB carrier limit.");
        }

        string digest = Digest(bytes);
        WriteImmutable(Path.Combine(invocationRoot, "result.bin"), bytes, digest);
        int totalChunks = checked((bytes.Length + MaximumChunkBytes - 1) /
                                 MaximumChunkBytes);
        var chunks = new List<RbpInvocationAnswer>(totalChunks);
        for (int index = 0; index < totalChunks; index++)
        {
            int offset = checked(index * MaximumChunkBytes);
            int length = Math.Min(MaximumChunkBytes, bytes.Length - offset);
            chunks.Add(RbpInvocationAnswer.Partial(ResultChunkPayload(
                invocationId,
                index,
                bytes.AsSpan(offset, length).ToArray())));
        }

        WriteManifest(invocationRoot, invocationId, rsid,
            Array.Empty<RbpArtifactDescriptor>());
        return new RbpCarrierEmission(
            ReplaceChunkedResultTerminal(
                invocationBody, totalChunks, bytes.Length, digest),
            chunks.AsReadOnly(),
            SafeSegment(invocationId));
    }

    private static IReadOnlyList<RbpArtifactInput> ParseInputs(JsonElement files)
    {
        if (files.ValueKind != JsonValueKind.Array ||
            files.GetArrayLength() is < 1 or > MaximumArtifacts)
        {
            throw new RbpArtifactCarrierException(
                "Artifact output must contain 1 through 16 files.");
        }

        var values = new List<RbpArtifactInput>(files.GetArrayLength());
        int expectedIndex = 0;
        foreach (JsonElement file in files.EnumerateArray())
        {
            if (file.ValueKind != JsonValueKind.Object ||
                file.TryGetProperty("path", out _) ||
                !file.TryGetProperty("artifactIndex", out JsonElement index) ||
                index.ValueKind != JsonValueKind.Number ||
                !index.TryGetInt32(out int actualIndex) || actualIndex != expectedIndex)
            {
                throw new RbpArtifactCarrierException(
                    "Artifact members must be deterministic, path-free, and " +
                    "zero-based contiguous.");
            }

            string fileName = RequireMemberString(file, "fileName", 255);
            if (Path.GetFileName(fileName) != fileName ||
                fileName is "." or ".." || fileName.IndexOfAny(['/', '\\']) >= 0)
            {
                throw new RbpArtifactCarrierException(
                    "Artifact file names must be bare, non-traversal names.");
            }

            string contentType = RequireMemberString(file, "contentType", 255);
            string declaredDigest = RequireMemberString(file, "sha256", 71);
            if (!RbpJournalSerialization.IsSha256Digest(declaredDigest))
            {
                throw new RbpArtifactCarrierException("Artifact digest is malformed.");
            }

            string base64 = RequireMemberString(file, "contentBase64", MaximumCombinedBytes * 2);
            byte[] bytes;
            try { bytes = Convert.FromBase64String(base64); }
            catch (FormatException exception)
            {
                throw new RbpArtifactCarrierException("Artifact content is not base64.", exception);
            }

            if (!file.TryGetProperty("sizeBytes", out JsonElement size) ||
                !size.TryGetInt32(out int declaredSize) ||
                declaredSize < 0 || declaredSize != bytes.Length ||
                bytes.Length > MaximumCombinedBytes ||
                !string.Equals(Digest(bytes), declaredDigest, StringComparison.Ordinal))
            {
                throw new RbpArtifactCarrierException(
                    "Artifact size or digest verification failed.");
            }

            values.Add(new RbpArtifactInput(fileName, contentType, bytes, declaredDigest));
            expectedIndex++;
        }

        return values.AsReadOnly();
    }

    private static JsonElement ChunkPayload(
        string invocationId, string artifactId, int artifactIndex, int chunkIndex,
        string contentType, byte[] bytes)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("kind", "chunk");
            writer.WriteString("invocation_id", invocationId);
            writer.WriteString("stream_id", "artifact:" + artifactId);
            writer.WriteString("artifact_id", artifactId);
            writer.WriteNumber("artifact_index", artifactIndex);
            writer.WriteNumber("chunk_index", chunkIndex);
            writer.WriteString("encoding", "base64");
            writer.WriteString("content_type", contentType);
            writer.WriteString("data", Convert.ToBase64String(bytes));
            writer.WriteEndObject();
        }

        using JsonDocument document = JsonDocument.Parse(buffer.ToArray());
        return document.RootElement.Clone();
    }

    private static JsonElement ResultChunkPayload(
        string invocationId, int chunkIndex, byte[] bytes)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("kind", "chunk");
            writer.WriteString("invocation_id", invocationId);
            writer.WriteString("stream_id", "result");
            writer.WriteNumber("chunk_index", chunkIndex);
            writer.WriteString("encoding", "base64");
            writer.WriteString("content_type", "application/json");
            writer.WriteString("data", Convert.ToBase64String(bytes));
            writer.WriteEndObject();
        }

        using JsonDocument document = JsonDocument.Parse(buffer.ToArray());
        return document.RootElement.Clone();
    }

    private static JsonElement ReplaceTerminal(
        JsonElement body,
        IReadOnlyList<RbpArtifactDescriptor> descriptors,
        IReadOnlyList<RbpArtifactReference> references)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (JsonProperty property in body.EnumerateObject())
            {
                if (property.NameEquals("result") || property.NameEquals("chunked") ||
                    property.NameEquals("artifacts"))
                {
                    continue;
                }

                property.WriteTo(writer);
            }

            writer.WriteBoolean("chunked", true);
            writer.WritePropertyName("result");
            writer.WriteStartObject();
            writer.WriteStartArray("artifacts");
            foreach (RbpArtifactReference reference in references)
            {
                writer.WriteStartObject();
                writer.WriteString("artifact_id", reference.ArtifactId);
                writer.WriteNumber("artifact_index", reference.ArtifactIndex);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
            writer.WriteStartArray("artifacts");
            foreach (RbpArtifactDescriptor descriptor in descriptors)
            {
                writer.WriteStartObject();
                writer.WriteString("artifact_id", descriptor.ArtifactId);
                writer.WriteNumber("artifact_index", descriptor.ArtifactIndex);
                writer.WriteString("stream_id", "artifact:" + descriptor.ArtifactId);
                writer.WriteString("filename", descriptor.FileName);
                writer.WriteString("content_type", descriptor.ContentType);
                writer.WriteNumber("total_chunks", descriptor.TotalChunks);
                writer.WriteNumber("total_size", descriptor.TotalSize);
                writer.WriteString("sha256", descriptor.Digest);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        using JsonDocument document = JsonDocument.Parse(buffer.ToArray());
        return document.RootElement.Clone();
    }

    private static JsonElement ReplaceChunkedResultTerminal(
        JsonElement body, int totalChunks, int totalSize, string digest)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (JsonProperty property in body.EnumerateObject())
            {
                if (property.NameEquals("result") || property.NameEquals("chunked") ||
                    property.NameEquals("stream_id") || property.NameEquals("content_type") ||
                    property.NameEquals("total_chunks") || property.NameEquals("total_size") ||
                    property.NameEquals("sha256"))
                {
                    continue;
                }

                property.WriteTo(writer);
            }

            writer.WriteBoolean("chunked", true);
            writer.WriteString("stream_id", "result");
            writer.WriteString("content_type", "application/json");
            writer.WriteNumber("total_chunks", totalChunks);
            writer.WriteNumber("total_size", totalSize);
            writer.WriteString("sha256", digest);
            writer.WriteEndObject();
        }

        using JsonDocument document = JsonDocument.Parse(buffer.ToArray());
        return document.RootElement.Clone();
    }

    private static void WriteManifest(
        string root, string invocationId, string rsid,
        IReadOnlyList<RbpArtifactDescriptor> descriptors)
    {
        string text = JsonSerializer.Serialize(new
        {
            invocationId,
            rsid,
            artifacts = descriptors.Select(value => new
            {
                value.ArtifactId,
                value.ArtifactIndex,
                value.FileName,
                value.ContentType,
                value.TotalChunks,
                value.TotalSize,
                value.Digest,
            }),
        });
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(text);
        WriteImmutable(Path.Combine(root, "manifest.json"), bytes, Digest(bytes));
    }

    /// <summary>
    /// Cleanup is deliberately tied to a terminal sequence already durable in
    /// the outbox. It is never called by the send path: a dropped socket must
    /// retain both spool evidence and the immutable journal frames.
    /// </summary>
    internal void RecordTerminalQueued(
        string carrierKey, string rsid, long terminalSequence)
    {
        string root = CarrierDirectory(carrierKey);
        EnsureSafeDirectory(root);
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
        {
            rsid,
            terminalSequence,
            createdAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }));
        string path = Path.Combine(root, "terminal.ack.json");
        if (File.Exists(path))
        {
            if (!TryReadTerminalFence(
                    path,
                    out string? existingRsid,
                    out long existingSequence) ||
                !string.Equals(existingRsid, rsid, StringComparison.Ordinal) ||
                existingSequence != terminalSequence)
            {
                throw new RbpArtifactCarrierException(
                    "Carrier terminal cleanup fence conflicts with existing evidence.");
            }

            return;
        }

        WriteImmutable(path, bytes, Digest(bytes));
    }

    internal void ApplyDurableAcknowledgements(
        IReadOnlyList<RbpSessionAcknowledgement> acknowledgements)
    {
        ArgumentNullException.ThrowIfNull(acknowledgements);
        foreach (string marker in Directory.EnumerateFiles(
                     _root, "terminal.ack.json", SearchOption.AllDirectories))
        {
            if (!TryReadTerminalFence(marker, out string? rsid, out long sequence))
            {
                continue;
            }

            long acknowledged = acknowledgements
                .Where(value => string.Equals(value.Rsid, rsid, StringComparison.Ordinal))
                .Select(value => value.Sequence)
                .DefaultIfEmpty(-1)
                .Max();
            if (acknowledged >= sequence)
            {
                DeleteCarrierDirectory(Path.GetDirectoryName(marker)!);
            }
        }
    }

    internal void SweepExpired(DateTimeOffset now)
    {
        foreach (string marker in Directory.EnumerateFiles(
                     _root, "terminal.ack.json", SearchOption.AllDirectories))
        {
            if (File.GetLastWriteTimeUtc(marker) <=
                now.UtcDateTime.Subtract(DefaultSpoolExpiry))
            {
                DeleteCarrierDirectory(Path.GetDirectoryName(marker)!);
            }
        }
    }

    private string CarrierDirectory(string carrierKey)
    {
        string directory = Path.GetFullPath(Path.Combine(_root, carrierKey));
        if (!directory.StartsWith(_root + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase) ||
            carrierKey.Length != 64 ||
            carrierKey.Any(value => !Uri.IsHexDigit(value)))
        {
            throw new RbpArtifactCarrierException("Carrier spool identity is malformed.");
        }

        return directory;
    }

    private static bool TryReadTerminalFence(
        string marker, out string? rsid, out long sequence)
    {
        rsid = null;
        sequence = -1;
        try
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(marker));
            JsonElement root = document.RootElement;
            if (!root.TryGetProperty("rsid", out JsonElement rsidElement) ||
                rsidElement.GetString() is not { Length: > 0 } parsed ||
                !root.TryGetProperty("terminalSequence", out JsonElement sequenceElement) ||
                !sequenceElement.TryGetInt64(out sequence) || sequence < 1)
            {
                return false;
            }

            rsid = parsed;
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static void DeleteCarrierDirectory(string directory)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
        {
            throw new RbpArtifactCarrierException(
                "Carrier cleanup refused a reparse-point directory.");
        }

        Directory.Delete(directory, recursive: true);
    }

    private static void WriteImmutable(string path, byte[] bytes, string digest)
    {
        if (File.Exists(path))
        {
            byte[] existing = File.ReadAllBytes(path);
            if (!CryptographicOperations.FixedTimeEquals(existing, bytes))
            {
                throw new RbpArtifactCarrierException(
                    "Artifact spool has conflicting immutable content.");
            }

            return;
        }

        using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write,
                   FileShare.None, 4096, FileOptions.WriteThrough))
        {
            file.Write(bytes);
            file.Flush(flushToDisk: true);
        }

        if (!string.Equals(Digest(File.ReadAllBytes(path)), digest, StringComparison.Ordinal))
        {
            throw new RbpArtifactCarrierException("Artifact spool verification failed.");
        }
    }

    private static void EnsureSafeDirectory(string path)
    {
        string full = Path.GetFullPath(path);
        string? cursor = full;
        while (cursor is not null && Directory.Exists(cursor))
        {
            if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
            {
                throw new RbpArtifactCarrierException(
                    "Artifact spool cannot use a reparse-point directory.");
            }

            cursor = Path.GetDirectoryName(cursor);
        }

        Directory.CreateDirectory(full);
        if ((File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0)
        {
            throw new RbpArtifactCarrierException(
                "Artifact spool cannot use a reparse-point directory.");
        }
    }

    private static string StableArtifactId(string invocationId, int index, string digest)
    {
        byte[] material = System.Text.Encoding.UTF8.GetBytes(
            invocationId + "\n" + index.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\n" + digest);
        return "artifact-" + Convert.ToHexString(SHA256.HashData(material)).ToLowerInvariant()[..32];
    }

    private static string SafeSegment(string value) =>
        Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static string Digest(byte[] value) =>
        "sha256:" + Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();

    private static string RequireString(JsonElement value, string name, int maximum) =>
        RequireMemberString(value, name, maximum);

    private static string RequireMemberString(JsonElement value, string name, int maximum)
    {
        if (!value.TryGetProperty(name, out JsonElement member) ||
            member.ValueKind != JsonValueKind.String ||
            member.GetString() is not { Length: > 0 } text || text.Length > maximum)
        {
            throw new RbpArtifactCarrierException($"Artifact {name} is malformed.");
        }

        return text;
    }

    private sealed record RbpArtifactInput(
        string FileName, string ContentType, byte[] Bytes, string Digest);
}

internal sealed record RbpCarrierEmission(
    JsonElement TerminalPayload,
    IReadOnlyList<RbpInvocationAnswer> Prefixes,
    string CarrierKey);

internal sealed record RbpArtifactDescriptor(
    string ArtifactId, int ArtifactIndex, string FileName, string ContentType,
    int TotalChunks, int TotalSize, string Digest);

internal sealed record RbpArtifactReference(string ArtifactId, int ArtifactIndex);

internal sealed class RbpArtifactCarrierException : Exception
{
    internal RbpArtifactCarrierException(string message, Exception? inner = null)
        : base(message, inner) { }
}
