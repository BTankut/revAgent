using System.Text;
using System.Text.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Contracts.Rbp;

namespace RevAgent.Bridge.Gateway.Connection;

/// <summary>
/// Emits one <c>doc_context_update</c> payload for a session. Returns
/// <see langword="true"/> only when the update is durably queued for the
/// Gateway, so the watcher may retire the emitted snapshot.
/// </summary>
internal delegate Task<bool> RbpDocContextEmit(
    JsonElement payload,
    CancellationToken cancellationToken);

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
    private readonly IRbpCoordinatorClock _clock;
    private readonly TimeSpan _pollTimeout;
    private readonly Dictionary<string, EmittedContext> _emitted =
        new(StringComparer.Ordinal);
    private readonly Dictionary<string, WatchLoop> _loops =
        new(StringComparer.Ordinal);

    internal RbpDocContextWatcher(
        IRbpInvocationChannel channel,
        IRbpCoordinatorClock? clock = null,
        TimeSpan? pollTimeout = null)
    {
        _channel = channel ??
            throw new ArgumentNullException(nameof(channel));
        _clock = clock ?? SystemRbpCoordinatorClock.Instance;
        if (pollTimeout is { } timeout && timeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(pollTimeout));
        }

        _pollTimeout = pollTimeout ?? DefaultPollTimeout;
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
        started?.Start(
            RunWatchAsync(rsid, emitAsync, started.Token));
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
        CancellationToken token)
    {
        try
        {
            while (true)
            {
                token.ThrowIfCancellationRequested();
                await PollOnceAsync(rsid, emitAsync, token)
                    .ConfigureAwait(false);
                await _clock.DelayAsync(PollInterval, token)
                    .ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            // The session or connection cycle ended; a watcher stop is
            // never a connection fault.
        }
    }

    private async Task PollOnceAsync(
        string rsid,
        RbpDocContextEmit emitAsync,
        CancellationToken token)
    {
        AddinDocumentContextSnapshot? snapshot;
        try
        {
            snapshot = await ReadSnapshotAsync(rsid, token)
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
            return;
        }

        if (snapshot is null ||
            snapshot.CacheState != DocumentContextCacheState.Ready)
        {
            // A warming/unavailable cache carries no documents (A.3); it is
            // cache status, not document context, so nothing is emitted and
            // the last ready context is not clobbered.
            return;
        }

        lock (_sync)
        {
            if (_emitted.TryGetValue(rsid, out EmittedContext? current) &&
                current.Revision == snapshot.Revision)
            {
                // The add-in revision is the primary change signal: an
                // unchanged revision proves an unchanged normalized
                // snapshot without re-serializing it.
                return;
            }
        }

        string normalized =
            DocumentContextMapper.NormalizeForComparison(snapshot);
        lock (_sync)
        {
            if (_emitted.TryGetValue(rsid, out EmittedContext? current) &&
                string.Equals(
                    current.Normalized,
                    normalized,
                    StringComparison.Ordinal))
            {
                // Revision moved but the normalized payload is identical;
                // Section 14 sends doc_context_update only when the
                // normalized snapshot differs.
                _emitted[rsid] = new EmittedContext(
                    snapshot.Revision,
                    normalized);
                return;
            }
        }

        JsonElement payload;
        using (JsonDocument document = JsonDocument.Parse(normalized))
        {
            payload = document.RootElement.Clone();
        }

        bool emitted;
        try
        {
            emitted = await emitAsync(payload, token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception)
        {
            // The update was not durably queued; keep the previous emitted
            // state so the change is retried at the next tick.
            return;
        }

        if (emitted)
        {
            lock (_sync)
            {
                _emitted[rsid] = new EmittedContext(
                    snapshot.Revision,
                    normalized);
            }
        }
    }

    private async Task<AddinDocumentContextSnapshot?> ReadSnapshotAsync(
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
                return null;
            }

            AddinDocumentContextResponse response =
                AddinDocumentContextParser.ParseResponse(
                    Encoding.UTF8.GetString(outcome.RawResponsePayload));
            return string.Equals(
                    response.RequestId,
                    call.InvocationId,
                    StringComparison.Ordinal)
                ? response.Context
                : null;
        }
        finally
        {
            // The cached read is effect-free, so the session's single-flight
            // gate reopens as soon as the answer is in hand; there is no
            // durable decision to wait for.
            outcome.Lease?.ReleaseAfterDurableDecision();
        }
    }

    private sealed record EmittedContext(long Revision, string Normalized);

    private sealed class WatchLoop
    {
        private readonly CancellationTokenSource _cancellation;
        private Task _loop = Task.CompletedTask;

        internal WatchLoop(CancellationTokenSource cancellation)
        {
            _cancellation = cancellation;
        }

        internal CancellationToken Token => _cancellation.Token;

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
            }
            catch (ObjectDisposedException)
            {
                // Already stopped.
            }

            _ = _loop.ContinueWith(
                _ => _cancellation.Dispose(),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
    }
}
