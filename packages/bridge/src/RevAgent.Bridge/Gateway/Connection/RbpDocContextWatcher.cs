using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Runtime;
using RevAgent.Contracts.Rbp;

namespace RevAgent.Bridge.Gateway.Connection;

/// <summary>
/// Emits one <c>doc_context_update</c> payload for a session. Returns
/// <see langword="true"/> only when the update is durably queued for the
/// Gateway, so the watcher may retire the emitted snapshot.
/// </summary>
internal delegate Task<bool> RbpDocContextEmit(
    JsonElement payload,
    RbpDocumentContextDiagnosticPair? diagnosticPair,
    CancellationToken cancellationToken);

internal enum RbpImmediatePollOutcome { Emitted, NoSend, Cancelled, Fault }

/// <summary>
/// A newly-read, proof-admissible cached document context.  This is confined
/// to one connection cycle: it is neither an RBP data envelope nor journal
/// state and therefore cannot consume a data sequence or survive a restart.
/// </summary>
internal sealed record RbpFreshDocumentContext(
    JsonElement Context,
    RbpDocumentContextDiagnosticPair Freshness);

/// <summary>
/// Local-only, value-free correlation carried from one validated add-in
/// snapshot through its queue/send lifecycle. It is never an RBP payload,
/// envelope, or journal field.
/// </summary>
internal sealed record RbpDocumentContextDiagnosticPair(
    long SourceRevision,
    string CacheIncarnationDigest)
{
    internal static bool TryCreate(
        long? sourceRevision,
        string? cacheIncarnationDigest,
        out RbpDocumentContextDiagnosticPair? pair)
    {
        if (sourceRevision is null || sourceRevision <= 0 ||
            cacheIncarnationDigest is null ||
            cacheIncarnationDigest.Length != "sha256:".Length + 64 ||
            !cacheIncarnationDigest.StartsWith("sha256:", StringComparison.Ordinal))
        {
            pair = null;
            return false;
        }

        foreach (char character in cacheIncarnationDigest.AsSpan("sha256:".Length))
        {
            if ((character < '0' || character > '9') &&
                (character < 'a' || character > 'f'))
            {
                pair = null;
                return false;
            }
        }

        pair = new RbpDocumentContextDiagnosticPair(
            sourceRevision.Value,
            cacheIncarnationDigest);
        return true;
    }
}

/// <summary>
/// Value-free WP-12 diagnostic seam. It deliberately carries only fixed
/// classifications, a sequence and SHA-256 identities; document titles,
/// paths, payloads, RSIDs and exception text never leave the coordinator.
/// </summary>
internal sealed record RbpDocumentContextObservation(
    string ContractVersion,
    string Event,
    string Stage,
    string Outcome,
    string RsidHash,
    string? PayloadHash,
    string? ContextDigest,
    long? Sequence,
    long? SourceRevision,
    string? CacheIncarnationDigest)
{
    internal const string CurrentContractVersion =
        "revagent.rbp-document-context-observation/v1";
    private const string ContextDigestDomain =
        "revagent:doc-context-payload:v1\n";
    private static readonly UTF8Encoding StrictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);

    internal static RbpDocumentContextObservation Create(
        string stage,
        string outcome,
        string rsid,
        JsonElement? payload = null,
        long? sequence = null,
        long? sourceRevision = null,
        string? cacheIncarnationDigest = null)
        => new(
            CurrentContractVersion,
            "bridge.document_context_observation",
            stage,
            outcome,
            Hash(rsid),
            payload is { } value ? Hash(value.GetRawText()) : null,
            payload is { } context ? TryMakeContextDigest(context) : null,
            sequence,
            RbpDocumentContextDiagnosticPair.TryCreate(
                sourceRevision, cacheIncarnationDigest, out _)
                ? sourceRevision
                : null,
            RbpDocumentContextDiagnosticPair.TryCreate(
                sourceRevision, cacheIncarnationDigest, out _)
                ? cacheIncarnationDigest
                : null);

    /// <summary>
    /// Creates an observation only when the document-context payload can be
    /// proven canonical. A diagnostic failure must never disclose a raw
    /// document payload or weaken delivery of the unchanged RBP payload.
    /// </summary>
    internal static bool TryCreate(
        string stage,
        string outcome,
        string rsid,
        JsonElement? payload,
        long? sequence,
        out RbpDocumentContextObservation? observation,
        long? sourceRevision = null,
        string? cacheIncarnationDigest = null,
        bool requireDiagnosticPair = false)
    {
        if (payload is not { } value)
        {
            observation = Create(stage, outcome, rsid, sequence: sequence);
            return true;
        }

        try
        {
            bool hasPair = RbpDocumentContextDiagnosticPair.TryCreate(
                sourceRevision,
                cacheIncarnationDigest,
                out RbpDocumentContextDiagnosticPair? pair);
            if (requireDiagnosticPair && !hasPair)
            {
                observation = null;
                return false;
            }
            observation = new RbpDocumentContextObservation(
                CurrentContractVersion,
                "bridge.document_context_observation",
                stage,
                outcome,
                Hash(rsid),
                Hash(value.GetRawText()),
                MakeContextDigest(value),
                sequence,
                hasPair ? pair!.SourceRevision : null,
                hasPair ? pair!.CacheIncarnationDigest : null);
            return true;
        }
        catch
        {
            // Duplicate keys, non-finite values, malformed Unicode, or a
            // canonicalizer failure have no safe diagnostic representation.
            observation = null;
            return false;
        }
    }

    /// <summary>
    /// Derives the diagnostic-only correlate for a document-context payload
    /// using the pinned RFC 8785 canonicalizer. The result is bare lowercase
    /// SHA-256 hexadecimal and is never added to the RBP wire payload.
    /// </summary>
    internal static string MakeContextDigest(JsonElement payload)
    {
        byte[] domain = StrictUtf8.GetBytes(ContextDigestDomain);
        byte[] canonical = StrictUtf8.GetBytes(
            Rfc8785Json.Canonicalize(payload));
        byte[] material = new byte[domain.Length + canonical.Length];
        Buffer.BlockCopy(domain, 0, material, 0, domain.Length);
        Buffer.BlockCopy(canonical, 0, material, domain.Length, canonical.Length);
        return Convert.ToHexString(SHA256.HashData(material)).ToLowerInvariant();
    }

    private static string? TryMakeContextDigest(JsonElement payload)
    {
        try
        {
            return MakeContextDigest(payload);
        }
        catch
        {
            return null;
        }
    }

    private static string Hash(string value) =>
        "sha256:" + Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(value)))
            .ToLowerInvariant();

}

/// <summary>
/// The Section 14 standing document-context watcher (P3-T7, RES-3).
/// </summary>
/// <remarks>
/// <para>
/// Per bound session it polls the add-in's <em>cached</em>
/// <c>get_document_context</c> command every 15 seconds, and immediately on
/// session register and resume. Activation is capability-gated: a session
/// that does not advertise <c>doc_context_cached_v1</c> is never polled, and
/// the watcher MUST NOT compose a substitute from
/// <c>get_current_view_info</c> plus <c>list_open_views</c> (O1 Sections 14
/// and A.3).
/// </para>
/// <para>
/// A <c>doc_context_update</c> is emitted only when the normalized snapshot
/// differs from the last emitted one. The add-in's monotonically increasing
/// <c>revision</c> is the primary change signal; the normalized RBP payload
/// diff is the authority, so cache timestamps, revision churn, and
/// unavailable details never produce spurious updates. An add-in failure
/// emits nothing and is retried at the next 15-second tick — never in a
/// tight loop.
/// </para>
/// </remarks>
internal sealed class RbpDocContextWatcher
{
    internal const string CapabilityName = "doc_context_cached_v1";

    internal const string CachedContextMethod = "get_document_context";

    /// <summary>The frozen RES-3 poll cadence.</summary>
    internal static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(15);

    private static readonly TimeSpan DefaultPollTimeout =
        TimeSpan.FromSeconds(10);

    private readonly object _sync = new();
    private readonly IRbpInvocationChannel _channel;
    private readonly IRbpFreshResumeProofContextReader? _freshResumeProofReader;
    private readonly IRbpCoordinatorClock _clock;
    private readonly TimeSpan _pollTimeout;
    private readonly Func<RbpDocumentContextObservation, ValueTask>?
        _onObservation;
    private readonly Dictionary<string, EmittedContext> _emitted =
        new(StringComparer.Ordinal);
    private readonly Dictionary<string, WatchLoop> _loops =
        new(StringComparer.Ordinal);

    internal RbpDocContextWatcher(
        IRbpInvocationChannel channel,
        IRbpCoordinatorClock? clock = null,
        TimeSpan? pollTimeout = null,
        IRbpFreshResumeProofContextReader? freshResumeProofReader = null,
        Func<RbpDocumentContextObservation, ValueTask>?
            onObservation = null)
    {
        _channel = channel ??
            throw new ArgumentNullException(nameof(channel));
        _freshResumeProofReader = freshResumeProofReader;
        _clock = clock ?? SystemRbpCoordinatorClock.Instance;
        if (pollTimeout is { } timeout && timeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(pollTimeout));
        }

        _pollTimeout = pollTimeout ?? DefaultPollTimeout;
        _onObservation = onObservation;
    }

    /// <summary>
    /// Reads the frozen capability gate from the session's own
    /// <c>session_register</c> payload: the watcher runs only when this
    /// add-in session advertised <c>doc_context_cached_v1</c> from a
    /// successful probe.
    /// </summary>
    internal static bool AdvertisesCachedDocumentContext(
        RbpLocalSessionSnapshot local)
    {
        ArgumentNullException.ThrowIfNull(local);
        if (local.RegistrationPayload.ValueKind != JsonValueKind.Object ||
            !local.RegistrationPayload.TryGetProperty(
                "session_capabilities",
                out JsonElement capabilities) ||
            capabilities.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        foreach (JsonElement capability in capabilities.EnumerateArray())
        {
            if (capability.ValueKind == JsonValueKind.String &&
                string.Equals(
                    capability.GetString(),
                    CapabilityName,
                    StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Starts (or restarts, after a resume on a new connection cycle) the
    /// per-session watch loop. The first poll happens immediately; the loop
    /// then ticks at <see cref="PollInterval"/> until the session ends or
    /// the owning cycle token cancels.
    /// </summary>
    internal void BeginWatch(
        string rsid,
        RbpLocalSessionSnapshot local,
        RbpDocContextEmit emitAsync,
        CancellationToken cycleToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);
        ArgumentNullException.ThrowIfNull(local);
        ArgumentNullException.ThrowIfNull(emitAsync);

        WatchLoop? replaced;
        WatchLoop? started = null;
        lock (_sync)
        {
            _ = _loops.Remove(rsid, out replaced);
            if (AdvertisesCachedDocumentContext(local))
            {
                started = new WatchLoop(
                    CancellationTokenSource.CreateLinkedTokenSource(
                        cycleToken));
                _loops.Add(rsid, started);
            }
        }

        replaced?.Stop();
        Observe(RbpDocumentContextObservation.Create(
            "probe", started is null ? "capability_absent" : "started", rsid));
        started?.Start(
            RunWatchAsync(rsid, emitAsync, started, started.Token));
    }

    /// <summary>Read-only lifecycle probe for coordinator observation only.</summary>
    internal bool IsWatching(string rsid)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);
        lock (_sync)
        {
            return _loops.ContainsKey(rsid);
        }
    }

    /// <summary>Signals at most one extra cached-context poll for this watch.</summary>
    internal Task<RbpImmediatePollOutcome>? RequestImmediatePollAsync(string rsid)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);
        lock (_sync)
        {
            if (!_loops.TryGetValue(rsid, out WatchLoop? loop)) return null;
            return loop.Request();
        }
    }

    /// <summary>
    /// Performs an unconditional, bounded cached-context read for the
    /// capability-gated session-resume route proof.  Unlike the standing
    /// watcher this intentionally never observes or updates <c>_emitted</c>:
    /// an unchanged prior snapshot is not fresh route evidence after a new
    /// hello_ack.
    /// </summary>
    internal async Task<RbpFreshDocumentContext?>
        ReadFreshResumeProofContextAsync(
            string rsid,
            CancellationToken token)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);
        // Pre-resume authority is deliberately a different, least-authority
        // path from the standing routed watcher.  No route fallback is safe:
        // an absent route before matching resume_ack must remain absent.
        return _freshResumeProofReader is null
            ? null
            : await _freshResumeProofReader.ReadAsync(rsid, token)
                .ConfigureAwait(false);
    }

    /// <summary>
    /// Cleanly stops the session's watch loop and forgets its emitted
    /// snapshot. Used when the session ends (unregister/replaced/exited);
    /// a mere connection loss keeps the emitted state so a resume does not
    /// re-send unchanged context.
    /// </summary>
    internal void EndWatch(string rsid)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);
        WatchLoop? loop;
        lock (_sync)
        {
            _ = _loops.Remove(rsid, out loop);
            _ = _emitted.Remove(rsid);
        }

        loop?.Stop();
    }

    private async Task RunWatchAsync(
        string rsid,
        RbpDocContextEmit emitAsync,
        WatchLoop loop,
        CancellationToken token)
    {
        try
        {
            Task signalled = loop.WaitForSignalAsync(token);
            await PollOnceAsync(rsid, emitAsync, token).ConfigureAwait(false);
            while (true)
            {
                token.ThrowIfCancellationRequested();
                Task cadence = _clock.DelayAsync(PollInterval, token);
                _ = await Task.WhenAny(cadence, signalled).ConfigureAwait(false);
                // A simultaneous cadence/signal must consume the signal now;
                // otherwise its waiter could remain pending until next cadence.
                if (signalled.IsCompleted)
                {
                    await SettleSignalPollAsync(rsid, emitAsync, loop, token)
                        .ConfigureAwait(false);
                    signalled = loop.WaitForSignalAsync(token);
                    continue;
                }
                await PollOnceAsync(rsid, emitAsync, token).ConfigureAwait(false);
                // Keep the original signal task across cadence iterations. A
                // request racing the cadence poll wins here, not 15 seconds later.
                if (signalled.IsCompleted)
                {
                    await SettleSignalPollAsync(rsid, emitAsync, loop, token)
                        .ConfigureAwait(false);
                    signalled = loop.WaitForSignalAsync(token);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // The session or connection cycle ended; a watcher stop is
            // never a connection fault.
        }
        finally
        {
            loop.CancelPending();
        }
    }

    private async Task SettleSignalPollAsync(string rsid,
        RbpDocContextEmit emitAsync, WatchLoop loop, CancellationToken token)
    {
        TaskCompletionSource<RbpImmediatePollOutcome>? waiter = loop.TakeRequest();
        try { waiter?.TrySetResult(await PollOnceAsync(rsid, emitAsync, token).ConfigureAwait(false) ? RbpImmediatePollOutcome.Emitted : RbpImmediatePollOutcome.NoSend); }
        catch (OperationCanceledException) { waiter?.TrySetResult(RbpImmediatePollOutcome.Cancelled); throw; }
        catch { waiter?.TrySetResult(RbpImmediatePollOutcome.Fault); }
    }

    private async Task<bool> PollOnceAsync(
        string rsid,
        RbpDocContextEmit emitAsync,
        CancellationToken token)
    {
        SnapshotRead snapshotRead;
        try
        {
            snapshotRead = await ReadSnapshotAsync(rsid, token)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception)
        {
            // Add-in or transport failure: no emission, and the bounded
            // retry is the next 15-second tick rather than a hot loop.
            Observe(RbpDocumentContextObservation.Create(
                "failure", "snapshot_failed", rsid));
            return false;
        }

        if (snapshotRead.RouteFailure)
        {
            // Route authority loss is distinct from an add-in cache state.
            // The observation is value-free; in particular it exposes no
            // local key, handle generation, route detail or add-in error.
            Observe(RbpDocumentContextObservation.Create(
                "failure", "route_failure", rsid));
            return false;
        }

        AddinDocumentContextSnapshot? snapshot = snapshotRead.Snapshot;
        if (snapshot is null ||
            snapshot.CacheState != DocumentContextCacheState.Ready)
        {
            // A warming/unavailable cache carries no documents (A.3); it is
            // cache status, not document context, so nothing is emitted and
            // the last ready context is not clobbered.
            Observe(RbpDocumentContextObservation.Create(
                "snapshot", "not_ready", rsid));
            return false;
        }

        string normalized =
            DocumentContextMapper.NormalizeForComparison(snapshot);
        lock (_sync)
        {
            if (_emitted.TryGetValue(rsid, out EmittedContext? current) &&
                string.Equals(
                    current.Normalized,
                    normalized,
                    StringComparison.Ordinal) &&
                string.Equals(
                    current.CacheIncarnationDigest,
                    snapshot.CacheIncarnationDigest,
                    StringComparison.Ordinal))
            {
                // Revision is a cache freshness signal, not a delivery
                // identity. Retain it atomically for the accepted unchanged
                // snapshot, so production and same-incarnation revision churn
                // remain silent on later polls/reconnects.
                _emitted[rsid] = new EmittedContext(
                    snapshot.Revision,
                    normalized,
                    snapshot.CacheIncarnationDigest);
                return false;
            }
        }

        JsonElement payload;
        using (JsonDocument document = JsonDocument.Parse(normalized))
        {
            payload = document.RootElement.Clone();
        }
        ObservePayload("snapshot", "ready", rsid, payload, snapshot);

        bool emitted;
        try
        {
            RbpDocumentContextDiagnosticPair? pair =
                RbpDocumentContextDiagnosticPair.TryCreate(
                    snapshot.Revision,
                    snapshot.CacheIncarnationDigest,
                    out RbpDocumentContextDiagnosticPair? validatedPair)
                    ? validatedPair
                    : null;
            emitted = await emitAsync(payload, pair, token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception)
        {
            // The update was not durably queued; keep the previous emitted
            // state so the change is retried at the next tick.
            ObservePayload("failure", "queue_failed", rsid, payload, snapshot);
            return false;
        }

        if (emitted)
        {
            lock (_sync)
            {
                _emitted[rsid] = new EmittedContext(
                    snapshot.Revision,
                    normalized,
                    snapshot.CacheIncarnationDigest);
            }
        }
        else
        {
            ObservePayload("queue", "not_queued", rsid, payload, snapshot);
        }
        return emitted;
    }

    private void ObservePayload(
        string stage,
        string outcome,
        string rsid,
        JsonElement payload,
        AddinDocumentContextSnapshot? snapshot = null)
    {
        if (RbpDocumentContextObservation.TryCreate(
                stage,
                outcome,
                rsid,
                payload,
                sequence: null,
                out RbpDocumentContextObservation? observation,
                sourceRevision: snapshot?.Revision,
                cacheIncarnationDigest: snapshot?.CacheIncarnationDigest,
                requireDiagnosticPair: true) &&
            observation is not null)
        {
            Observe(observation);
        }
    }

    private void Observe(RbpDocumentContextObservation observation)
    {
        if (_onObservation is null)
        {
            return;
        }

        try
        {
            _ = _onObservation(observation).AsTask().ContinueWith(
                completed => _ = completed.Exception,
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted |
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
        catch
        {
            // Diagnostics never own document-context delivery.
        }
    }

    private async Task<SnapshotRead> ReadSnapshotAsync(
        string rsid,
        CancellationToken token)
    {
        // The one and only method this watcher may route is the add-in's
        // cached get_document_context; O1 Section 14 prohibits composing a
        // substitute from get_current_view_info plus list_open_views.
        var call = new AddinCall(
            "doc-context-" + Guid.NewGuid().ToString("N"),
            CachedContextMethod,
            new JObject(),
            _pollTimeout);
        RbpAddinOutcome outcome = await _channel
            .InvokeAsync(rsid, call, token)
            .ConfigureAwait(false);
        try
        {
            if (outcome.Kind != RbpAddinOutcomeKind.Completed)
            {
                return new SnapshotRead(null, outcome.RouteFailure);
            }

            AddinDocumentContextResponse response =
                AddinDocumentContextParser.ParseResponse(
                    Encoding.UTF8.GetString(outcome.RawResponsePayload));
            return new SnapshotRead(
                string.Equals(
                    response.RequestId,
                    call.InvocationId,
                    StringComparison.Ordinal)
                    ? response.Context
                    : null,
                RouteFailure: false);
        }
        finally
        {
            // The cached read is effect-free, so the session's single-flight
            // gate reopens as soon as the answer is in hand; there is no
            // durable decision to wait for.
            outcome.Lease?.ReleaseAfterDurableDecision();
        }
    }

    private sealed record SnapshotRead(
        AddinDocumentContextSnapshot? Snapshot,
        bool RouteFailure);

    private sealed record EmittedContext(
        long Revision,
        string Normalized,
        string? CacheIncarnationDigest);

    private sealed class WatchLoop
    {
        private readonly object _sync = new();
        private readonly CancellationTokenSource _cancellation;
        private readonly SemaphoreSlim _signal = new(0, 1);
        private TaskCompletionSource<RbpImmediatePollOutcome>? _waiter;
        private Task _loop = Task.CompletedTask;

        internal WatchLoop(CancellationTokenSource cancellation)
        {
            _cancellation = cancellation;
        }

        internal CancellationToken Token => _cancellation.Token;

        internal bool Signal()
        {
            if (_cancellation.IsCancellationRequested || _signal.CurrentCount != 0)
                return false;
            try { _signal.Release(); return true; }
            catch (SemaphoreFullException) { return false; }
        }

        internal Task<RbpImmediatePollOutcome> Request()
        {
            lock (_sync)
            {
                if (_cancellation.IsCancellationRequested)
                    return Task.FromResult(RbpImmediatePollOutcome.Cancelled);
                _waiter ??= new(TaskCreationOptions.RunContinuationsAsynchronously);
                _ = Signal();
                return _waiter.Task;
            }
        }

        internal TaskCompletionSource<RbpImmediatePollOutcome>? TakeRequest()
        {
            lock (_sync)
            {
                TaskCompletionSource<RbpImmediatePollOutcome>? result = _waiter;
                _waiter = null;
                return result;
            }
        }

        internal void CancelPending()
        {
            lock (_sync)
            {
                _waiter?.TrySetResult(RbpImmediatePollOutcome.Cancelled);
                _waiter = null;
            }
        }

        internal Task WaitForSignalAsync(CancellationToken token) =>
            _signal.WaitAsync(token);

        internal void Start(Task loop)
        {
            _loop = loop;
            _ = loop.ContinueWith(
                completed => _ = completed.Exception,
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted |
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }

        internal void Stop()
        {
            try
            {
                _cancellation.Cancel();
                CancelPending();
            }
            catch (ObjectDisposedException)
            {
                // Already stopped.
            }

            _ = _loop.ContinueWith(
                _ => { _signal.Dispose(); _cancellation.Dispose(); },
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
    }
}
