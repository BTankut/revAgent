using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// Test-host-only proof that a C39 omitted-payload observation started with one
/// genuine fixture response.  Production composition has only <see cref="Never"/>.
/// The marker is process memory, intentionally: a restart is a safe ordinary
/// replay rather than an admission shortcut.
/// </summary>
internal sealed class RbpConformanceOmittedOriginObservation
{
    internal static RbpConformanceOmittedOriginObservation Never { get; } =
        new(null);

    private const string FixtureMethod = "fixture_multi_file_output";
    private const string FixtureImage = "addin-loopback-fixture/test-only";
    private const string FixtureRevitVersion = "2025";
    private readonly Func<AddinProcessAttestation?>? _readCurrentAttestation;
    private readonly object _sync = new();
    private Marker? _marker;
    private long _markerVersion;
    private AbortedReplay? _lastAbort;

    private enum MarkerState
    {
        Armed,
        BoundUnexposed,
        Exposed,
        Consumed,
    }

    private RbpConformanceOmittedOriginObservation(
        Func<AddinProcessAttestation?>? readCurrentAttestation) =>
        _readCurrentAttestation = readCurrentAttestation;

    internal static RbpConformanceOmittedOriginObservation CreateFixtureOneShot(
        Func<AddinProcessAttestation?> readCurrentAttestation)
    {
        ArgumentNullException.ThrowIfNull(readCurrentAttestation);
        return new RbpConformanceOmittedOriginObservation(readCurrentAttestation);
    }

    internal bool TryArm(
        RbpInvokeRequest request,
        RbpInvocationIdentity identity,
        RbpAddinOutcome outcome,
        string resultDigest)
    {
        if (_readCurrentAttestation is null || !IsFixtureRequest(request) ||
            outcome.Kind != RbpAddinOutcomeKind.Completed ||
            !MatchesCurrent(outcome.ProcessAttestation) ||
            !RbpJournalSerialization.IsSha256Digest(resultDigest))
        {
            return false;
        }

        lock (_sync)
        {
            // One genuine origin per test host. A second otherwise-valid call
            // stays an ordinary terminal; no selector can broaden this seam.
            if (_marker is not null) return false;
            _marker = new Marker(
                checked(++_markerVersion),
                _markerVersion,
                identity.Rsid,
                identity.IdempotencyKey,
                identity.InvocationId,
                resultDigest,
                outcome.ProcessAttestation!);
            _lastAbort = null;
            return true;
        }
    }

    internal async Task<RbpConformanceOmittedOriginReplay?>
        TryPrepareReplayAsync(
            RbpInvokeRequest request,
            RbpStoredInvocation stored,
            RbpJournalStore journal,
            CancellationToken cancellationToken)
    {
        if (_readCurrentAttestation is null || !IsFixtureRequest(request) ||
            stored.State != RbpInvocationState.Completed ||
            stored.ResultDigest is not { Length: > 0 } digest)
        {
            return null;
        }

        Marker? marker;
        lock (_sync)
        {
            marker = _marker;
            if (marker is null || marker.State != MarkerState.Armed ||
                !string.Equals(marker.Rsid, stored.Identity.Rsid, StringComparison.Ordinal) ||
                !string.Equals(marker.IdempotencyKey, stored.Identity.IdempotencyKey, StringComparison.Ordinal) ||
                !string.Equals(marker.OriginInvocationId, stored.Identity.InvocationId, StringComparison.Ordinal) ||
                !string.Equals(marker.ResultDigest, digest, StringComparison.Ordinal) ||
                !MatchesCurrent(marker.Attestation))
            {
                return null;
            }
        }

        // The internal typed read is the proof that the unmodified terminal
        // has its matching encrypted v7 source. The bytes never leave here.
        using RbpRecoveredPayload? raw = await journal
            .GetCorrelatedRecoveryPayloadAsync(
                marker.Rsid, marker.OriginInvocationId, marker.ResultDigest,
                cancellationToken)
            .ConfigureAwait(false);
        if (raw is null || !string.Equals(raw.ResultDigest, marker.ResultDigest,
                StringComparison.Ordinal) || raw.RawResponseBytes.IsEmpty)
        {
            return null;
        }

        return new RbpConformanceOmittedOriginReplay(
            marker.ReservationGeneration,
            marker.Rsid, marker.IdempotencyKey, marker.OriginInvocationId,
            marker.ResultDigest);
    }

    internal bool TryBindReplay(
        RbpConformanceOmittedOriginReplay replay,
        long attemptGeneration,
        long sequence,
        string outerDigest)
    {
        if (!RbpJournalSerialization.IsSha256Digest(outerDigest) ||
            attemptGeneration < 1 || sequence < 1)
            return false;
        lock (_sync)
        {
            if (_marker is not { State: MarkerState.Armed } marker ||
                !Same(marker, replay)) return false;
            _marker = marker with
            {
                Version = checked(++_markerVersion),
                State = MarkerState.BoundUnexposed,
                AttemptGeneration = attemptGeneration,
                Sequence = sequence,
                OuterDigest = outerDigest,
            };
            return true;
        }
    }

    // Retained for the unchanged conformance consumer. Production coordinator
    // binding always supplies its exact connection-attempt generation.
    internal bool TryBindReplay(
        RbpConformanceOmittedOriginReplay replay,
        long sequence,
        string outerDigest) =>
        TryBindReplay(replay, 1, sequence, outerDigest);

    internal bool TryExposeReplay(
        RbpConformanceOmittedOriginReplay replay,
        long attemptGeneration,
        long sequence,
        string outerDigest)
    {
        lock (_sync)
        {
            if (_marker is not { } marker ||
                !Same(marker, replay) ||
                marker.AttemptGeneration != attemptGeneration ||
                marker.Sequence != sequence ||
                !string.Equals(marker.OuterDigest, outerDigest,
                    StringComparison.Ordinal))
                return false;
            // A synchronous peer ACK may consume the exact bound marker after
            // send start but before this continuation exposes it. Consumed is
            // stronger proof than Exposed, so preserve the terminal state and
            // treat the exact tuple as idempotent success.
            if (marker.State == MarkerState.Consumed) return true;
            if (marker.State != MarkerState.BoundUnexposed) return false;
            _marker = marker with
            {
                Version = checked(++_markerVersion),
                State = MarkerState.Exposed,
            };
            return true;
        }
    }

    internal bool AbortBoundReplay(
        RbpConformanceOmittedOriginReplay replay,
        long attemptGeneration,
        long sequence,
        string outerDigest)
    {
        lock (_sync)
        {
            if (_lastAbort is { } prior && prior.Matches(
                    replay, attemptGeneration, sequence, outerDigest))
                return true;
            if (_marker is not
                { State: MarkerState.BoundUnexposed } marker ||
                !Same(marker, replay) ||
                marker.AttemptGeneration != attemptGeneration ||
                marker.Sequence != sequence ||
                !string.Equals(marker.OuterDigest, outerDigest,
                    StringComparison.Ordinal))
                return false;
            _lastAbort = new AbortedReplay(
                replay, attemptGeneration, sequence, outerDigest);
            long nextReservation = checked(++_markerVersion);
            _marker = marker with
            {
                ReservationGeneration = nextReservation,
                Version = nextReservation,
                State = MarkerState.Armed,
                AttemptGeneration = 0,
                Sequence = 0,
                OuterDigest = null,
            };
            return true;
        }
    }

    internal bool TryConsumeDurableAcknowledgement(string rsid, long sequence)
    {
        lock (_sync)
        {
            if (_marker is not
                { State: MarkerState.BoundUnexposed or MarkerState.Exposed }
                    marker ||
                !string.Equals(marker.Rsid, rsid, StringComparison.Ordinal) ||
                marker.Sequence != sequence || marker.OuterDigest is null)
            {
                return false;
            }
            _marker = marker with
            {
                Version = checked(++_markerVersion),
                State = MarkerState.Consumed,
            };
            return true;
        }
    }

    internal bool IsArmedExactReplay(string rsid, JsonElement payload)
    {
        if (_readCurrentAttestation is null) return false;
        try
        {
            RbpInvokeRequest request = RbpInvokeRequest.Parse(rsid, payload);
            RbpInvocationIdentity identity = request.ToIdentity();
            lock (_sync)
            {
                return _marker is { State: MarkerState.Armed } marker &&
                    IsFixtureRequest(request) &&
                    string.Equals(marker.Rsid, identity.Rsid, StringComparison.Ordinal) &&
                    string.Equals(marker.IdempotencyKey, identity.IdempotencyKey, StringComparison.Ordinal) &&
                    string.Equals(marker.OriginInvocationId, identity.InvocationId, StringComparison.Ordinal);
            }
        }
        catch { return false; }
    }

    private bool MatchesCurrent(AddinProcessAttestation? attestation)
    {
        if (attestation is null || !IsFixtureAttestation(attestation)) return false;
        try
        {
            AddinProcessAttestation? current = _readCurrentAttestation?.Invoke();
            return current is not null && current.Identity == attestation.Identity &&
                string.Equals(current.ImagePath, attestation.ImagePath, StringComparison.Ordinal) &&
                string.Equals(current.RevitVersion, attestation.RevitVersion, StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsFixtureAttestation(AddinProcessAttestation value) =>
        value.Identity.ProcessId > 0 && value.Identity.StartTimeFileTimeUtc > 0 &&
        string.Equals(value.ImagePath, FixtureImage, StringComparison.Ordinal) &&
        string.Equals(value.RevitVersion, FixtureRevitVersion, StringComparison.Ordinal);

    private static bool IsFixtureRequest(RbpInvokeRequest request)
    {
        if (request.Mutating || !string.Equals(request.Method, FixtureMethod,
                StringComparison.Ordinal) || request.Parameters.ValueKind != JsonValueKind.Object)
        {
            return false;
        }
        // The fixed conformance provenance marker. It deliberately admits no
        // extensible control property, config, environment, or CLI selector.
        return request.Parameters.TryGetProperty("scenario", out JsonElement scenario) &&
            scenario.ValueKind == JsonValueKind.String &&
            string.Equals(scenario.GetString(), "valid_multifile", StringComparison.Ordinal) &&
            request.Parameters.TryGetProperty("fileCount", out JsonElement count) &&
            count.ValueKind == JsonValueKind.Number && count.TryGetInt32(out int files) &&
            files is >= 1 and <= 16 &&
            request.Parameters.TryGetProperty("bytesPerFile", out JsonElement bytes) &&
            bytes.ValueKind == JsonValueKind.Number && bytes.TryGetInt32(out int size) &&
            size > 0;
    }

    private static bool Same(Marker marker, RbpConformanceOmittedOriginReplay replay) =>
        marker.ReservationGeneration == replay.MarkerVersion &&
        string.Equals(marker.Rsid, replay.Rsid, StringComparison.Ordinal) &&
        string.Equals(marker.IdempotencyKey, replay.IdempotencyKey, StringComparison.Ordinal) &&
        string.Equals(marker.OriginInvocationId, replay.OriginInvocationId, StringComparison.Ordinal) &&
        string.Equals(marker.ResultDigest, replay.ResultDigest, StringComparison.Ordinal);

    private sealed record Marker(
        long ReservationGeneration,
        long Version,
        string Rsid, string IdempotencyKey,
        string OriginInvocationId, string ResultDigest,
        AddinProcessAttestation Attestation,
        MarkerState State = MarkerState.Armed,
        long AttemptGeneration = 0,
        long Sequence = 0, string? OuterDigest = null);

    private sealed record AbortedReplay(
        RbpConformanceOmittedOriginReplay Replay,
        long AttemptGeneration,
        long Sequence,
        string OuterDigest)
    {
        internal bool Matches(
            RbpConformanceOmittedOriginReplay replay,
            long attemptGeneration,
            long sequence,
            string outerDigest) =>
            Replay == replay && AttemptGeneration == attemptGeneration &&
            Sequence == sequence &&
            string.Equals(OuterDigest, outerDigest, StringComparison.Ordinal);
    }
}

internal sealed record RbpConformanceOmittedOriginReplay(
    long MarkerVersion, string Rsid, string IdempotencyKey, string OriginInvocationId,
    string ResultDigest);

internal sealed class RbpConformanceOriginSuppressedException : Exception
{
    internal RbpConformanceOriginSuppressedException() : base("C39 fixture origin terminal suppressed after durable commit.") { }
}
