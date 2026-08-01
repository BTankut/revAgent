using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Tests.Gateway.Connection;

namespace RevAgent.Bridge.Tests.Harness;

/// <summary>
/// The deterministic clock seam the P3-T13 scenarios drive instead of sleeping.
/// </summary>
/// <remarks>
/// Every coordinator timer — the heartbeat interval, the lifecycle-control
/// deadline, the full-jitter backoff, and the wake-gap detector — runs through
/// <see cref="IRbpCoordinatorClock"/>. Owning it here is what lets the
/// sleep/wake scenario simulate a 70-second suspend in microseconds of wall
/// clock, and what keeps every scenario well inside the 30-second budget.
/// </remarks>
internal sealed class HarnessClock : IRbpCoordinatorClock
{
    private readonly object _sync = new();
    private readonly List<ScheduledDelay> _delays = new();
    private DateTimeOffset _utcNow =
        DateTimeOffset.Parse(
            "2026-07-30T09:00:00.000Z",
            System.Globalization.CultureInfo.InvariantCulture);
    private long _monotonicMilliseconds;

    public DateTimeOffset UtcNow
    {
        get
        {
            lock (_sync)
            {
                return _utcNow;
            }
        }
    }

    public long MonotonicMilliseconds
    {
        get
        {
            lock (_sync)
            {
                return _monotonicMilliseconds;
            }
        }
    }

    public Task DelayAsync(
        TimeSpan delay,
        CancellationToken cancellationToken = default)
    {
        if (delay <= TimeSpan.Zero)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        }

        lock (_sync)
        {
            var completion = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously);
            _delays.Add(
                new ScheduledDelay(
                    checked(
                        _monotonicMilliseconds +
                        (long)Math.Ceiling(delay.TotalMilliseconds)),
                    completion));
            if (cancellationToken.CanBeCanceled)
            {
                _ = cancellationToken.Register(
                    () => completion.TrySetCanceled(cancellationToken));
            }

            return completion.Task;
        }
    }

    internal void Advance(TimeSpan amount)
    {
        TaskCompletionSource[] ready;
        lock (_sync)
        {
            long milliseconds =
                checked((long)Math.Round(amount.TotalMilliseconds));
            _monotonicMilliseconds =
                checked(_monotonicMilliseconds + milliseconds);
            _utcNow = _utcNow.AddMilliseconds(milliseconds);
            ready = _delays
                .Where(item => item.DueMilliseconds <= _monotonicMilliseconds)
                .Select(item => item.Completion)
                .ToArray();
            _delays.RemoveAll(
                item => item.DueMilliseconds <= _monotonicMilliseconds);
        }

        foreach (TaskCompletionSource completion in ready)
        {
            completion.TrySetResult();
        }
    }

    internal bool HasPendingDelayDueIn(TimeSpan delay)
    {
        lock (_sync)
        {
            long due = checked(
                _monotonicMilliseconds +
                (long)Math.Ceiling(delay.TotalMilliseconds));
            return _delays.Any(item =>
                item.DueMilliseconds == due &&
                !item.Completion.Task.IsCompleted);
        }
    }

    private sealed record ScheduledDelay(
        long DueMilliseconds,
        TaskCompletionSource Completion);
}

/// <summary>
/// Deterministic backoff, non-colliding identifiers.
/// </summary>
/// <remarks>
/// <see cref="NextUnitInterval"/> returns zero so full-jitter reconnect waits
/// resolve immediately and no scenario has to advance the clock just to
/// reconnect. <see cref="Fill"/> stays genuinely random because the coordinator
/// mints UUIDv7 envelope ids from these bytes plus a frozen clock reading; a
/// zero fill would make every outbound envelope on a stopped clock share one id.
/// </remarks>
internal sealed class HarnessRandomSource : IRbpRandomSource
{
    public void Fill(Span<byte> destination) =>
        RandomNumberGenerator.Fill(destination);

    public double NextUnitInterval() => 0;
}

/// <summary>
/// What the scripted add-in does when the dispatcher reaches it.
/// </summary>
internal enum HarnessAddinBehavior
{
    /// <summary>Answers normally; Section 12.1 records a terminal.</summary>
    Complete,

    /// <summary>
    /// Fails after the first byte may have reached Revit. Section 15 promotes a
    /// mutation on this path to <c>journal_indeterminate</c>.
    /// </summary>
    /// <remarks>
    /// No scenario drives this yet, and the reason is a finding rather than an
    /// omission: the bridge mints <c>verification_hold_id</c> from
    /// <c>RandomNumberGenerator</c> (<c>RbpJournalStore.Invocations.cs</c>,
    /// <c>InstallOrExtendHold</c>), while O1 Section 6.2.1 fixes it as
    /// <c>"vh:" + SHA-256(JCS({mutation_scope, origin_idempotency_keys,
    /// rsid}))</c>. The O1 stub enforces that derivation, so a real
    /// <c>journal_indeterminate</c> frame is refused as "hold id is not
    /// derivable from active work" and the link is closed. Encoding that as an
    /// expectation would freeze the defect; the behaviour is left uncovered
    /// until the bridge adopts the frozen derivation.
    /// </remarks>
    PossiblyDispatched,

    /// <summary>Provably wrote nothing, so the outcome stays known.</summary>
    KnownNotDispatched,
}

/// <summary>
/// The add-in stand-in for the fault harness. It is the execution counter the
/// whole P3-T5 acceptance list is stated in terms of: "terminal replay has one
/// add-in execution", "unknown mutations have zero re-executions".
/// </summary>
/// <remarks>
/// It deliberately ignores the dispatch cancellation token. A real add-in call
/// cannot be recalled once the bytes are on the wire, and the frozen durability
/// ordering depends on that: the dispatcher persists the terminal under
/// <c>CancellationToken.None</c> precisely so a link kill cannot erase what
/// Revit already did. Honouring cancellation here would test a bridge that does
/// not exist.
/// </remarks>
internal sealed class HarnessAddinChannel : IRbpInvocationChannel
{
    private readonly ConcurrentDictionary<string, int> _executions =
        new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<string> _order = new();
    private readonly object _sync = new();
    private TaskCompletionSource? _gate;
    private TaskCompletionSource _entered =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _total;

    internal HarnessAddinBehavior Behavior { get; set; } =
        HarnessAddinBehavior.Complete;

    /// <summary>Total add-in executions across every invocation id.</summary>
    internal int TotalExecutions => Volatile.Read(ref _total);

    /// <summary>Execution order, oldest first.</summary>
    internal IReadOnlyList<string> ExecutionOrder => _order.ToArray();

    internal int ExecutionsOf(string invocationId) =>
        _executions.TryGetValue(invocationId, out int count) ? count : 0;

    /// <summary>
    /// Parks the next add-in call so a fault can be injected while an
    /// invocation is provably mid-flight rather than "probably" mid-flight.
    /// </summary>
    internal Task ArmGate()
    {
        lock (_sync)
        {
            _gate = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously);
            _entered = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously);
            return _entered.Task;
        }
    }

    internal void ReleaseGate()
    {
        TaskCompletionSource? gate;
        lock (_sync)
        {
            gate = _gate;
            _gate = null;
        }

        gate?.TrySetResult();
    }

    public async Task<RbpAddinOutcome> InvokeAsync(
        string rsid,
        AddinCall call,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(call);
        _ = rsid;
        _ = cancellationToken;
        _ = _executions.AddOrUpdate(call.InvocationId, 1, (_, count) => count + 1);
        _order.Enqueue(call.InvocationId);
        _ = Interlocked.Increment(ref _total);

        Task? gate;
        TaskCompletionSource entered;
        lock (_sync)
        {
            gate = _gate?.Task;
            entered = _entered;
        }

        entered.TrySetResult();
        if (gate is not null)
        {
            await gate.ConfigureAwait(false);
        }

        return Behavior switch
        {
            HarnessAddinBehavior.Complete => Completed(call.InvocationId),
            HarnessAddinBehavior.KnownNotDispatched => new RbpAddinOutcome(
                RbpAddinOutcomeKind.KnownNotDispatched,
                default,
                Array.Empty<byte>(),
                RequestBytes: 0,
                ResponseBytes: 0,
                FaultClass: "addin_unreachable",
                Message: "The scripted add-in refused before the first byte."),
            _ => new RbpAddinOutcome(
                RbpAddinOutcomeKind.PossiblyDispatched,
                default,
                Array.Empty<byte>(),
                RequestBytes: 1,
                ResponseBytes: 0,
                FaultClass: "environment",
                Message:
                    "The scripted add-in link failed after the request may " +
                    "have been written."),
        };
    }

    private static RbpAddinOutcome Completed(string invocationId)
    {
        byte[] raw = Encoding.UTF8.GetBytes(
            "{\"jsonrpc\":\"2.0\",\"id\":\"" +
            invocationId +
            "\",\"result\":{\"ok\":true}}");
        using JsonDocument document = JsonDocument.Parse("""{"ok":true}""");
        return new RbpAddinOutcome(
            RbpAddinOutcomeKind.Completed,
            document.RootElement.Clone(),
            raw,
            RequestBytes: 32,
            ResponseBytes: raw.Length);
    }
}

/// <summary>
/// A mutable local-session catalog. Removing the entry is how the harness
/// simulates Revit exiting mid-session.
/// </summary>
internal sealed class HarnessSessionCatalog : IRbpLocalSessionCatalog
{
    private readonly object _sync = new();
    private RbpLocalSessionSnapshot[] _sessions;

    internal HarnessSessionCatalog(params RbpLocalSessionSnapshot[] sessions)
    {
        _sessions = sessions;
    }

    public Task<IReadOnlyList<RbpLocalSessionSnapshot>> ReadAsync(
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_sync)
        {
            return Task.FromResult<IReadOnlyList<RbpLocalSessionSnapshot>>(
                Array.AsReadOnly(_sessions.ToArray()));
        }
    }

    internal void Replace(params RbpLocalSessionSnapshot[] sessions)
    {
        lock (_sync)
        {
            _sessions = sessions;
        }
    }
}

/// <summary>The already-enrolled device the launched stub's token table knows.</summary>
internal sealed class HarnessEnrollmentProvider : IRbpEnrollmentStateProvider
{
    private readonly RbpEnrollmentSnapshot _snapshot;

    internal HarnessEnrollmentProvider(RbpDeviceCredential credential)
    {
        _snapshot = RbpEnrollmentSnapshot.Ready(credential);
    }

    public ValueTask<RbpEnrollmentSnapshot> ReadAsync(
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(_snapshot);
    }
}

/// <summary>
/// Trusts exactly the launched stub's ephemeral loopback certificate and
/// nothing else, so the harness never widens TLS trust to run.
/// </summary>
internal sealed class HarnessSocketFactory : IRbpClientWebSocketFactory
{
    private readonly GatewayStubProcess _stub;

    internal HarnessSocketFactory(GatewayStubProcess stub)
    {
        _stub = stub;
    }

    public ClientWebSocket Create()
    {
        var socket = new ClientWebSocket();
        socket.Options.Proxy = new WebProxy();
        socket.Options.RemoteCertificateValidationCallback =
            (_, certificate, _, _) => _stub.TrustsExactCertificate(certificate);
        return socket;
    }
}
