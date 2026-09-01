using System.Security.Cryptography;
using System.Text.Json;
using System.Buffers;
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

    private readonly RbpArtifactSpoolFileSystem _spool;
    private readonly RbpJournalStore _journal;
    private readonly Dictionary<string, RbpCarrierFence> _fences =
        new(StringComparer.Ordinal);

    private RbpArtifactCarrierProducer(
        RbpArtifactSpoolFileSystem spool, RbpJournalStore journal)
    {
        _spool = spool;
        _journal = journal;
    }

    internal static RbpArtifactCarrierProducer CreateProduction(
        string stateRoot,
        RbpJournalStore journal)
    {
        ArgumentException.ThrowIfNullOrEmpty(stateRoot);
        ArgumentNullException.ThrowIfNull(journal);
        return new RbpArtifactCarrierProducer(
            RbpArtifactSpoolFileSystem.OpenForStateRoot(stateRoot), journal);
    }

    internal static RbpArtifactCarrierProducer CreateForTesting(
        IRelativeSpoolNative spool, RbpJournalStore journal) =>
        new(RbpArtifactSpoolFileSystem.ForTesting(spool), journal);

    internal static IReadOnlyList<string> ConnectionCapabilities { get; } =
        Array.AsReadOnly(new[]
        {
            RbpHelloProfile.JournalCapability,
            RbpHelloProfile.ChunkedResultsCapability,
            RbpHelloProfile.ArtifactResultCapability,
            RbpHelloProfile.RouteRebindProofCapability,
        });

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
        string carrierKey = SafeSegment(invocationId);
        _spool.EnsureCarrier(carrierKey);

        if (!artifactOutput)
        {
            return PrepareChunkedResult(carrierKey, invocationId, rsid,
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
            _spool.WriteImmutable(carrierKey, artifactId + ".bin", input.Bytes, input.Digest);
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

        WriteManifest(carrierKey, invocationId, rsid, descriptors,
            descriptors.Select(value => value.ArtifactId + ".bin").Append("terminal.ack.json"));
        return new RbpCarrierEmission(
            ReplaceTerminal(invocationBody, descriptors, references),
            chunks.AsReadOnly(),
            carrierKey);
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

    private RbpCarrierEmission PrepareChunkedResult(
        string carrierKey,
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
        _spool.WriteImmutable(carrierKey, "result.bin", bytes, digest);
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

        WriteManifest(carrierKey, invocationId, rsid, Array.Empty<RbpArtifactDescriptor>(),
            new[] { "result.bin", "terminal.ack.json" });
        return new RbpCarrierEmission(
            ReplaceChunkedResultTerminal(
                invocationBody, totalChunks, bytes.Length, digest),
            chunks.AsReadOnly(),
            carrierKey);
    }

    private static IReadOnlyList<RbpArtifactInput> ParseInputs(JsonElement files)
    {
        if (files.ValueKind != JsonValueKind.Array ||
            files.GetArrayLength() is < 1 or > MaximumArtifacts)
        {
            throw new RbpArtifactCarrierException(
                "Artifact output must contain 1 through 16 files.");
        }

        var wires = new List<RbpArtifactWireInput>(files.GetArrayLength());
        int expectedIndex = 0;
        long declaredAggregate = 0;
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

            if (!file.TryGetProperty("sizeBytes", out JsonElement size) ||
                !size.TryGetInt32(out int declaredSize) ||
                declaredSize < 0 || declaredSize > MaximumCombinedBytes)
            {
                throw new RbpArtifactCarrierException("Artifact size is malformed.");
            }

            string base64 = RequireMemberString(file, "contentBase64",
                MaximumBase64Length(MaximumCombinedBytes));
            int decodedLength = GetDecodedLength(base64);
            if (decodedLength != declaredSize)
            {
                throw new RbpArtifactCarrierException(
                    "Artifact size or base64 length verification failed.");
            }

            checked { declaredAggregate += decodedLength; }
            if (declaredAggregate > MaximumCombinedBytes)
            {
                throw new RbpArtifactCarrierException(
                    "Artifact output exceeds the 32 MiB carrier limit.");
            }

            wires.Add(new RbpArtifactWireInput(
                fileName, contentType, base64, decodedLength, declaredDigest));
            expectedIndex++;
        }

        var values = new List<RbpArtifactInput>(wires.Count);
        long decodedAggregate = 0;
        foreach (RbpArtifactWireInput wire in wires)
        {
            byte[] bytes = DecodeBase64Bounded(wire.ContentBase64, wire.DecodedLength);
            checked { decodedAggregate += bytes.Length; }
            if (decodedAggregate > MaximumCombinedBytes ||
                !string.Equals(Digest(bytes), wire.Digest, StringComparison.Ordinal))
            {
                CryptographicOperations.ZeroMemory(bytes);
                throw new RbpArtifactCarrierException(
                    "Artifact size or digest verification failed.");
            }

            values.Add(new RbpArtifactInput(
                wire.FileName, wire.ContentType, bytes, wire.Digest));
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

    internal static JsonElement ReplaceChunkedResultTerminal(
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

    private void WriteManifest(
        string carrierKey, string invocationId, string rsid,
        IReadOnlyList<RbpArtifactDescriptor> descriptors,
        IEnumerable<string> declaredFiles)
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
            spoolFiles = declaredFiles.Append("manifest.json")
                .OrderBy(value => value, StringComparer.Ordinal),
        });
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(text);
        _spool.WriteImmutable(carrierKey, "manifest.json", bytes, Digest(bytes));
    }

    /// <summary>
    /// Cleanup is deliberately tied to a terminal sequence already durable in
    /// the outbox. It is never called by the send path: a dropped socket must
    /// retain both spool evidence and the immutable journal frames.
    /// </summary>
    internal void RecordTerminalQueued(
        string carrierKey, string rsid, long terminalSequence)
    {
        ValidateCarrierKey(carrierKey);
        _spool.EnsureCarrier(carrierKey);
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
        {
            rsid,
            terminalSequence,
            createdAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }));
        if (_spool.TryReadAllPinned(carrierKey, "terminal.ack.json", MaximumCombinedBytes, out byte[]? existing) &&
            existing is not null)
        {
            if (!TryReadTerminalFence(
                    existing,
                    out string? existingRsid,
                    out long existingSequence) ||
                !string.Equals(existingRsid, rsid, StringComparison.Ordinal) ||
                existingSequence != terminalSequence)
            {
                throw new RbpArtifactCarrierException(
                    "Carrier terminal cleanup fence conflicts with existing evidence.");
            }

            _fences[carrierKey] = new RbpCarrierFence(rsid, terminalSequence);
            return;
        }

        _spool.WriteImmutable(carrierKey, "terminal.ack.json", bytes, Digest(bytes));
        _fences[carrierKey] = new RbpCarrierFence(rsid, terminalSequence);
    }

    internal void ApplyDurableAcknowledgements(
        IReadOnlyList<RbpSessionAcknowledgement> acknowledgements)
    {
        ArgumentNullException.ThrowIfNull(acknowledgements);
        foreach ((string carrierKey, RbpCarrierFence fence) in _fences.ToArray())
        {
            long acknowledged = acknowledgements
                .Where(value => string.Equals(value.Rsid, fence.Rsid, StringComparison.Ordinal))
                .Select(value => value.Sequence)
                .DefaultIfEmpty(-1)
                .Max();
            if (acknowledged >= fence.TerminalSequence)
            {
                DeleteCarrierByDeclaredManifest(carrierKey);
                _fences.Remove(carrierKey);
            }
        }
    }

    /// <summary>
    /// Restores only journal-declared fences after worker startup or a
    /// connection-cycle boundary. Only unacknowledged plans own spool fences;
    /// acknowledged plans remain journal replay evidence after their bytes
    /// have been released.
    /// </summary>
    internal async Task<RbpCarrierRecovery> RehydrateFencesAsync(
        CancellationToken cancellationToken)
    {
        RbpCarrierRecovery recovery = await _journal
            .LoadCarrierRecoveryAsync(cancellationToken)
            .ConfigureAwait(false);
        foreach (RbpCarrierFenceRecord pending in recovery.PendingFences)
        {
            _fences[pending.CarrierKey] = new RbpCarrierFence(
                pending.Rsid,
                pending.TerminalSequence);
        }
        return recovery;
    }

    /// <summary>Journal recovery supplies only fenced, already-released keys.
    /// There is no spool discovery path and no timestamp-based directory scan.</summary>
    internal void SweepExpired(IReadOnlyList<RbpReleasedCarrier> releasedCarriers)
    {
        ArgumentNullException.ThrowIfNull(releasedCarriers);
        foreach (RbpReleasedCarrier released in releasedCarriers)
        {
            string carrierKey = released.CarrierKey;
            ValidateCarrierKey(carrierKey);
            bool tracked = _fences.TryGetValue(carrierKey, out RbpCarrierFence? trackedFence);
            if (!_spool.TryReadAllPinned(carrierKey, "terminal.ack.json", MaximumCombinedBytes,
                    out byte[]? fenceBytes) || fenceBytes is null)
            {
                // A repeated release after this producer already deleted the
                // exact spool is harmless. An in-memory fence means bytes
                // were expected, so a missing or unreadable fence still
                // fails closed rather than disguising tampering as idempotency.
                if (!tracked)
                {
                    continue;
                }
                throw new RbpArtifactCarrierException("carrier_spool_release_fence_refused");
            }
            if (!TryReadTerminalFence(fenceBytes, out string? rsid, out long sequence) ||
                !string.Equals(rsid, released.Rsid, StringComparison.Ordinal) ||
                sequence != released.TerminalSequence ||
                (tracked && (!string.Equals(trackedFence!.Rsid, released.Rsid,
                    StringComparison.Ordinal) ||
                    trackedFence.TerminalSequence != released.TerminalSequence)))
            {
                throw new RbpArtifactCarrierException("carrier_spool_release_fence_refused");
            }
            DeleteCarrierByDeclaredManifest(carrierKey);
            _fences.Remove(carrierKey);
        }
    }

    private void DeleteCarrierByDeclaredManifest(string carrierKey)
    {
        byte[] bytes = _spool.ReadAllPinned(carrierKey, "manifest.json", MaximumCombinedBytes);
        if (!TryReadDeclaredInventory(bytes, out IReadOnlyList<string>? inventory) || inventory is null)
        {
            throw new RbpArtifactCarrierException("carrier_spool_inventory_refused");
        }
        _spool.DeleteCarrier(carrierKey, inventory);
    }

    private static bool TryReadTerminalFence(
        byte[] bytes, out string? rsid, out long sequence)
    {
        rsid = null;
        sequence = -1;
        try
        {
            using JsonDocument document = JsonDocument.Parse(bytes);
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

    private static bool TryReadDeclaredInventory(byte[] bytes, out IReadOnlyList<string>? inventory)
    {
        inventory = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(bytes);
            if (!document.RootElement.TryGetProperty("spoolFiles", out JsonElement files) ||
                files.ValueKind != JsonValueKind.Array)
            {
                return false;
            }
            string[] values = files.EnumerateArray()
                .Where(value => value.ValueKind == JsonValueKind.String)
                .Select(value => value.GetString())
                .Where(value => value is not null && value.Length is > 0 and <= 255 &&
                    value is not "." and not ".." && value.IndexOfAny(['/', '\\', ':', '\0']) < 0)
                .Cast<string>()
                .ToArray();
            if (values.Length != files.GetArrayLength() || values.Length == 0 ||
                !values.Contains("manifest.json", StringComparer.Ordinal) ||
                !values.Contains("terminal.ack.json", StringComparer.Ordinal) ||
                values.Distinct(StringComparer.Ordinal).Count() != values.Length)
            {
                return false;
            }
            inventory = values;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static void ValidateCarrierKey(string carrierKey)
    {
        if (carrierKey.Length != 64 || carrierKey.Any(value => !Uri.IsHexDigit(value)))
            throw new RbpArtifactCarrierException("Carrier spool identity is malformed.");
    }

    private static string StableArtifactId(string invocationId, int index, string digest)
    {
        byte[] material = System.Text.Encoding.UTF8.GetBytes(
            invocationId + "\n" + index.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\n" + digest);
        return "artifact-" + Convert.ToHexString(SHA256.HashData(material)).ToLowerInvariant()[..32];
    }

    private static string SafeSegment(string value) =>
        Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    internal static string Digest(byte[] value) =>
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

    private sealed record RbpArtifactWireInput(
        string FileName, string ContentType, string ContentBase64,
        int DecodedLength, string Digest);

    private static int MaximumBase64Length(int decodedLength) => checked(
        ((decodedLength + 2) / 3) * 4);

    private static int GetDecodedLength(string value)
    {
        if (value.Length == 0 || value.Length % 4 != 0)
        {
            throw new RbpArtifactCarrierException("Artifact content is not base64.");
        }

        int padding = value[^1] == '=' ? (value[^2] == '=' ? 2 : 1) : 0;
        try
        {
            return checked((value.Length / 4 * 3) - padding);
        }
        catch (OverflowException exception)
        {
            throw new RbpArtifactCarrierException("Artifact content is too large.", exception);
        }
    }

    private static byte[] DecodeBase64Bounded(string value, int expectedLength)
    {
        byte[] rented = ArrayPool<byte>.Shared.Rent(expectedLength);
        try
        {
            if (!Convert.TryFromBase64Chars(value, rented, out int written) ||
                written != expectedLength)
            {
                throw new RbpArtifactCarrierException("Artifact content is not base64.");
            }

            return rented.AsSpan(0, written).ToArray();
        }
        catch (RbpArtifactCarrierException)
        {
            throw;
        }
        catch (Exception exception) when (exception is FormatException or ArgumentException)
        {
            throw new RbpArtifactCarrierException("Artifact content is not base64.", exception);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(rented);
            ArrayPool<byte>.Shared.Return(rented);
        }
    }
}

internal sealed record RbpCarrierEmission(
    JsonElement TerminalPayload,
    IReadOnlyList<RbpInvocationAnswer> Prefixes,
    string CarrierKey);

internal sealed record RbpArtifactDescriptor(
    string ArtifactId, int ArtifactIndex, string FileName, string ContentType,
    int TotalChunks, int TotalSize, string Digest);

internal sealed record RbpArtifactReference(string ArtifactId, int ArtifactIndex);

/// <summary>Exact durable-release identity supplied by the journal.  A spool
/// sweep cannot invent this selector and never enumerates the filesystem.</summary>
internal sealed record RbpReleasedCarrier(
    string CarrierKey,
    string Rsid,
    long TerminalSequence,
    string ReleaseToken = "");

internal sealed record RbpCarrierFence(string Rsid, long TerminalSequence);

internal sealed class RbpArtifactCarrierException : Exception
{
    internal RbpArtifactCarrierException(string message, Exception? inner = null)
        : base(message, inner) { }
}
