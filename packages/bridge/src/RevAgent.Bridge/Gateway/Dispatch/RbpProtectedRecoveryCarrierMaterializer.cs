using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;
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
    private readonly Func<CancellationToken, Task>? _beforeFinalAuthorityCheck;

    /// <summary>Internal deterministic race seam; null in production composition.</summary>
    public Func<CancellationToken, Task>? TestBeforePostSnapshotRecheck { get; init; }

    internal RbpProtectedRecoveryCarrierMaterializer(
        RbpJournalStore journal,
        Func<CancellationToken, Task>? beforeFinalAuthorityCheck = null)
    {
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        _beforeFinalAuthorityCheck = beforeFinalAuthorityCheck;
    }

    internal async Task<RbpRecoveryCarrierMaterializedFrame?> MaterializeCurrentAsync(
        string recoveryInvocationId,
        string rsid,
        CancellationToken cancellationToken)
    {
        using RbpRecoveryCarrierMaterializationSnapshot? snapshot = await _journal
            .ReadRecoveryCarrierMaterializationSnapshotAsync(recoveryInvocationId, rsid, cancellationToken)
            .ConfigureAwait(false);
        if (snapshot is null) return null;
        RbpRecoveryCarrierReservation reservation = snapshot.Reservation;
        if (reservation.Phase != RbpRecoveryCarrierPhase.SendStarted ||
            reservation.ChunkSize is <= 0 or > RbpArtifactCarrierProducer.MaximumChunkBytes ||
            reservation.ChunkIndex < 0 || reservation.ChunkIndex >= reservation.ChunkCount ||
            reservation.RawPayloadVersion != RbpRecoveryPayloadEnvelope.Version ||
            reservation.PlanVersion != 1 || reservation.CurrentReservedSequence < 1 ||
            reservation.AcknowledgementCursor != reservation.CurrentReservedSequence - 1 ||
            reservation.ExpiresAtMilliseconds <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() ||
            reservation.PlaintextLength is <= 0 or > RbpArtifactCarrierProducer.MaximumCombinedBytes ||
            !string.Equals(reservation.HeaderJcs,
                "{\"content_encoding\":\"base64\",\"content_type\":\"application/json\",\"v\":1}",
                StringComparison.Ordinal))
        {
            return null;
        }

        byte[] raw = snapshot.Raw.TakeRawResponseBytes();
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
            try
            {
                Func<CancellationToken, Task>? interlock =
                    TestBeforePostSnapshotRecheck ?? _beforeFinalAuthorityCheck;
                if (interlock is not null)
                {
                    await interlock(cancellationToken)
                        .ConfigureAwait(false);
                }
                RbpRecoveryCarrierMaterializationSnapshot? fresh = await _journal
                    .ReadRecoveryCarrierMaterializationSnapshotAsync(recoveryInvocationId, rsid, cancellationToken)
                    .ConfigureAwait(false);
                using (fresh)
                {
                    if (fresh is null || fresh.Reservation.PlanVersion != reservation.PlanVersion ||
                        fresh.Reservation.CurrentReservedSequence != reservation.CurrentReservedSequence ||
                        !string.Equals(fresh.Reservation.CanonicalEnvelopeDigest,
                            RbpRecoveryCarrierCommitment.Compute(fresh.Reservation,
                                fresh.Reservation.CurrentReservedSequence + 1), StringComparison.Ordinal)) return null;
                }
                RbpInvocationAnswer answer = RbpInvocationAnswer.Partial(Chunk(reservation, chunk));
                return new RbpRecoveryCarrierMaterializedFrame(answer,
                    reservation.CurrentReservedSequence, reservation.PlanVersion,
                    Rfc8785Json.Sha256Digest(answer.Payload));
            }
            finally { CryptographicOperations.ZeroMemory(chunk); }
        }
        finally { CryptographicOperations.ZeroMemory(raw); }
    }

    /// <summary>
    /// Materializes the v9 terminal from its typed durable plan.  Unlike the
    /// partial carrier path this never reads the protected payload, base64, or
    /// recovery source; it only revalidates the terminal commitment twice.
    /// </summary>
    internal async Task<RbpRecoveryTerminalMaterializedFrame?>
        MaterializeTerminalAsync(
            RbpRecoveryTerminalPlan candidate,
            CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        RbpRecoveryTerminalPlan? plan = await _journal
            .ReadRecoveryTerminalPlanForMaterializationAsync(
                candidate.RecoveryInvocationId, candidate.Rsid,
                candidate.PlanVersion, candidate.FinalSequence,
                candidate.PayloadCommitment, cancellationToken)
            .ConfigureAwait(false);
        if (plan is null) return null;

        Func<CancellationToken, Task>? interlock =
            TestBeforePostSnapshotRecheck ?? _beforeFinalAuthorityCheck;
        if (interlock is not null)
        {
            await interlock(cancellationToken).ConfigureAwait(false);
        }

        RbpRecoveryTerminalPlan? fresh = await _journal
            .ReadRecoveryTerminalPlanForMaterializationAsync(
                plan.RecoveryInvocationId, plan.Rsid, plan.PlanVersion,
                plan.FinalSequence, plan.PayloadCommitment, cancellationToken)
            .ConfigureAwait(false);
        if (fresh is null ||
            !string.Equals(fresh.PayloadCommitment, plan.PayloadCommitment,
                StringComparison.Ordinal) ||
            !string.Equals(fresh.TerminalDigest, plan.TerminalDigest,
                StringComparison.Ordinal)) return null;

        RbpInvocationAnswer answer = RbpInvocationPayloads
            .RecoveryTerminalDraft(fresh);
        return new RbpRecoveryTerminalMaterializedFrame(
            answer, fresh.FinalSequence, fresh.PlanVersion,
            fresh.PayloadCommitment, fresh.TerminalDigest);
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

/// <summary>Internal epoch-tagged draft; C1c must revalidate before any socket write.</summary>
internal sealed record RbpRecoveryCarrierMaterializedFrame(
    RbpInvocationAnswer Answer, long ReservedSequence, int PlanVersion,
    string PayloadDigest);

/// <summary>Typed v9 terminal draft; no raw recovery bytes cross this seam.</summary>
internal sealed record RbpRecoveryTerminalMaterializedFrame(
    RbpInvocationAnswer Answer, long ReservedSequence, int PlanVersion,
    string PayloadCommitment, string PayloadDigest);
