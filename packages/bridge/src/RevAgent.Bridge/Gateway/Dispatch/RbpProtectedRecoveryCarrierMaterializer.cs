using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// C39's source-backed, one-frame materializer. It has no filesystem, spool,
/// outbox, or persistence dependency: only the authenticated protected source
/// row is decrypted, re-hashed, framed, and zeroed for the current cursor.
/// </summary>
internal sealed class RbpProtectedRecoveryCarrierMaterializer
{
    private readonly RbpJournalStore _journal;

    internal RbpProtectedRecoveryCarrierMaterializer(RbpJournalStore journal) =>
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));

    internal async Task<RbpInvocationAnswer?> MaterializeCurrentAsync(
        RbpRecoveryCarrierReservation reservation,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(reservation);
        if (reservation.Phase is RbpRecoveryCarrierPhase.Completed or
            RbpRecoveryCarrierPhase.Tombstoned ||
            reservation.ChunkSize is <= 0 or > RbpArtifactCarrierProducer.MaximumChunkBytes ||
            reservation.ChunkIndex < 0 || reservation.ChunkIndex >= reservation.ChunkCount ||
            reservation.PlaintextLength is <= 0 or > RbpArtifactCarrierProducer.MaximumCombinedBytes ||
            !string.Equals(reservation.HeaderJcs,
                "{\"content_encoding\":\"base64\",\"content_type\":\"application/json\",\"v\":1}",
                StringComparison.Ordinal))
        {
            return null;
        }

        using RbpRecoveredPayload? lease = await _journal
            .GetCorrelatedRecoveryPayloadAsync(reservation.Rsid,
                reservation.OriginInvocationId, reservation.ResultDigest,
                cancellationToken).ConfigureAwait(false);
        if (lease is null) return null;
        byte[] raw = lease.TakeRawResponseBytes();
        try
        {
            string digest = "sha256:" + Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
            if (raw.Length != reservation.PlaintextLength ||
                !string.Equals(digest, reservation.ResultDigest, StringComparison.Ordinal)) return null;
            try
            {
                _ = new UTF8Encoding(false, true).GetString(raw);
                using JsonDocument document = JsonDocument.Parse(raw);
            }
            catch (Exception) { return null; }
            int offset = checked(reservation.ChunkIndex * reservation.ChunkSize);
            int length = Math.Min(reservation.ChunkSize, raw.Length - offset);
            if (length <= 0 || length > RbpArtifactCarrierProducer.MaximumChunkBytes) return null;
            byte[] chunk = raw.AsSpan(offset, length).ToArray();
            try { return RbpInvocationAnswer.Partial(Chunk(reservation, chunk)); }
            finally { CryptographicOperations.ZeroMemory(chunk); }
        }
        finally { CryptographicOperations.ZeroMemory(raw); }
    }

    private static JsonElement Chunk(RbpRecoveryCarrierReservation reservation, byte[] bytes)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject(); writer.WriteString("kind", "chunk");
            writer.WriteString("invocation_id", reservation.RecoveryInvocationId);
            writer.WriteString("stream_id", "result"); writer.WriteNumber("chunk_index", reservation.ChunkIndex);
            writer.WriteString("encoding", "base64"); writer.WriteString("content_type", "application/json");
            writer.WriteString("data", Convert.ToBase64String(bytes)); writer.WriteEndObject();
        }
        using JsonDocument document = JsonDocument.Parse(buffer.ToArray());
        return document.RootElement.Clone();
    }
}
