using System.Text.Json;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Connection;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Harness;

/// <summary>
/// The P3-T13 fault-injection scenario driver: one launched O1 Gateway stub,
/// one real <see cref="RbpConnectionCoordinator"/> over real WSS, one real
/// SQLite invocation journal, and one scripted add-in that counts executions.
/// </summary>
/// <remarks>
/// <para>
/// Nothing between the Gateway wire and the journal is a double. The only
/// substitutions are the two seams a fault harness must own: the add-in (there
/// is no Revit on a CI runner) and the clock (so a 70-second machine suspend
/// costs microseconds and every scenario stays unattended and bounded).
/// </para>
/// <para>
/// Faults are injected through the stub's frozen <c>/__rbp_test/control</c>
/// route only. The harness never reaches into coordinator internals to
/// manufacture a failure, because a fault the real transport cannot produce
/// would prove nothing about the real transport.
/// </para>
/// </remarks>
internal sealed class RbpFaultScenarioHarness : IAsyncDisposable
{
    private const string DeviceToken = "test-device-token";
    private const string DeviceId = "device-01";
    internal const string DocumentId = "doc-01";

    private readonly GatewayStubProcess _stub;
    private readonly RbpJournalTestDirectory _directory;
    private readonly CancellationTokenSource _stop = new();
    private readonly RbpJournalStore _journal;
    private readonly Task _run;
    private int _identifierCounter;
    private bool _disposed;

    private RbpFaultScenarioHarness(
        GatewayStubProcess stub,
        RbpJournalTestDirectory directory,
        GatewayFaultControl control,
        RbpJournalStore journal,
        HarnessClock clock,
        HarnessAddinChannel addin,
        HarnessSessionCatalog catalog,
        RbpConnectionCoordinator coordinator)
    {
        _stub = stub;
        _directory = directory;
        _journal = journal;
        Control = control;
        Clock = clock;
        Addin = addin;
        Catalog = catalog;
        Coordinator = coordinator;
        _run = coordinator.RunAsync(_stop.Token);
    }

    internal GatewayFaultControl Control { get; }

    internal HarnessClock Clock { get; }

    internal HarnessAddinChannel Addin { get; }

    internal HarnessSessionCatalog Catalog { get; }

    internal RbpConnectionCoordinator Coordinator { get; }

    internal RbpJournalStore Journal => _journal;

    /// <summary>The single bound session, once the Gateway has registered it.</summary>
    internal string Rsid { get; private set; } = string.Empty;

    /// <summary>
    /// Launches the stub, connects a real coordinator to it, and returns once
    /// exactly one session is registered on both peers.
    /// </summary>
    internal static async Task<RbpFaultScenarioHarness> StartAsync()
    {
        GatewayStubProcess stub = await GatewayStubProcess.StartAsync()
            .ConfigureAwait(false);
        RbpJournalTestDirectory? directory = null;
        GatewayFaultControl? control = null;
        RbpJournalStore? journal = null;
        try
        {
            directory = new RbpJournalTestDirectory();
            control = new GatewayFaultControl(stub);
            var clock = new HarnessClock();
            journal = RbpJournalStore.Open(
                directory.JournalPath,
                new TestResumeTokenProtector(),
                new RbpJournalOpenOptions(
                    NowMilliseconds:
                        () => clock.UtcNow.ToUnixTimeMilliseconds()));
            var addin = new HarnessAddinChannel();
            var catalog = new HarnessSessionCatalog(LocalSession());
            var coordinator = new RbpConnectionCoordinator(
                new WssRbpConnectionCycleFactory(
                    new RbpGatewayHandshakeClient(
                        new HarnessEnrollmentProvider(
                            new RbpDeviceCredential(
                                DeviceId,
                                DeviceToken,
                                MachineFingerprint)),
                        new WssGatewayBinding(new HarnessSocketFactory(stub)))),
                journal,
                catalog,
                new RbpConnectionCoordinatorOptions(
                    stub.WebSocketUri,
                    Profile()),
                new RbpInvocationDispatcher(
                    journal,
                    addin,
                    new RbpInFlightGate()),
                RbpInvocationJournalHandoff.Instance,
                clock,
                new HarnessRandomSource());
            var harness = new RbpFaultScenarioHarness(
                stub,
                directory,
                control,
                journal,
                clock,
                addin,
                catalog,
                coordinator);
            await harness.WaitForSingleBoundSessionAsync().ConfigureAwait(false);
            return harness;
        }
        catch
        {
            journal?.DisposeAsync().AsTask().GetAwaiter().GetResult();
            control?.Dispose();
            directory?.Dispose();
            await stub.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>The stub's id for the one open transport connection.</summary>
    internal async Task<string> ConnectionIdAsync()
    {
        using GatewayStubView view = await Control.SnapshotAsync()
            .ConfigureAwait(false);
        IReadOnlyList<string> connections = view.ConnectionIds;
        Assert.Single(connections);
        return connections[0];
    }

    /// <summary>
    /// Waits until the bridge and the Gateway agree on exactly one live
    /// session, and records its rsid.
    /// </summary>
    internal async Task WaitForSingleBoundSessionAsync()
    {
        await EventuallyAsync(
                () => Coordinator.GetSnapshot().ActiveRsids.Count == 1,
                "the coordinator did not bind exactly one session")
            .ConfigureAwait(false);
        Rsid = Coordinator.GetSnapshot().ActiveRsids[0];
        await EventuallyAsync(
                async () =>
                {
                    using GatewayStubView view = await Control.SnapshotAsync()
                        .ConfigureAwait(false);
                    return view.LiveRsids.Count == 1 &&
                           string.Equals(
                               view.LiveRsids[0],
                               Rsid,
                               StringComparison.Ordinal);
                },
                "the Gateway did not converge on exactly one live session")
            .ConfigureAwait(false);
    }

    /// <summary>Waits for the coordinator to reach the given generation.</summary>
    internal Task WaitForConnectionGenerationAsync(long generation) =>
        EventuallyAsync(
            () => Coordinator.GetSnapshot().ConnectionGeneration >= generation,
            $"the coordinator did not reach connection generation {generation}");

    /// <summary>Reads the durable Section 12 row for one invocation.</summary>
    internal Task<RbpStoredInvocation?> ReadJournalAsync(string invocationId) =>
        _journal.GetInvocationAsync(Rsid + "/" + invocationId);

    /// <summary>
    /// Waits for the Gateway to accept a terminal for one correlation id and
    /// returns the classification it recorded.
    /// </summary>
    internal async Task<string> WaitForGatewayTerminalAsync(
        string correlationId)
    {
        string? classification = null;
        await EventuallyAsync(
                async () =>
                {
                    using GatewayStubView view = await Control.SnapshotAsync()
                        .ConfigureAwait(false);
                    classification = view.HasSession(Rsid)
                        ? view.TerminalClassification(Rsid, correlationId)
                        : null;
                    return classification is not null;
                },
                $"the Gateway never accepted a terminal for {correlationId}")
            .ConfigureAwait(false);
        return classification!;
    }

    /// <summary>A fresh UUIDv7-shaped identifier, stable per harness instance.</summary>
    internal string NewInvocationId()
    {
        int index = Interlocked.Increment(ref _identifierCounter);
        return $"019f9add-7a83-7d11-a6a9-d2f8108c{index:0000}";
    }

    /// <summary>A frozen Section 10.2 non-mutating <c>invoke</c> payload.</summary>
    internal static JsonElement ReadInvoke(string invocationId) =>
        Json(
            $$"""
            {
              "invocation_id":"{{invocationId}}",
              "method":"get_current_view_info",
              "params":{"detail":"summary"},
              "mutating":false,
              "mutation_scope":null,
              "policy":{
                "class":"auto",
                "decision":"auto",
                "confirmation_id":null
              },
              "timeout_ms":5000,
              "verification":null,
              "recovery_clearances":[]
            }
            """);

    /// <summary>
    /// A frozen Section 10.2 mutating <c>invoke</c> payload scoped to one
    /// registered document.
    /// </summary>
    internal static JsonElement MutatingInvoke(
        string invocationId,
        string confirmationId,
        string documentId = DocumentId) =>
        Json(
            $$"""
            {
              "invocation_id":"{{invocationId}}",
              "method":"create_wall",
              "params":{"length":1200},
              "mutating":true,
              "mutation_scope":{
                "kind":"document",
                "document_id":"{{documentId}}"
              },
              "policy":{
                "class":"confirm",
                "decision":"confirmed",
                "confirmation_id":"{{confirmationId}}"
              },
              "timeout_ms":5000,
              "verification":null,
              "recovery_clearances":[]
            }
            """);

    /// <summary>
    /// Polls a deterministic condition. Nothing here waits on wall-clock
    /// duration: the poll exists only because the coordinator's work is
    /// genuinely concurrent, and every scenario is far inside the budget.
    /// </summary>
    /// <remarks>
    /// The interval is deliberately not tighter. A fault harness runs beside
    /// the loopback-transport tests, and a tighter spin buys no determinism
    /// while it does starve them; 25 ms across 600 attempts still leaves a
    /// 15-second ceiling per wait, half the per-scenario budget.
    /// </remarks>
    internal static async Task EventuallyAsync(
        Func<bool> predicate,
        string because,
        int attempts = 600)
    {
        await EventuallyAsync(
                () => Task.FromResult(predicate()),
                because,
                attempts)
            .ConfigureAwait(false);
    }

    internal static async Task EventuallyAsync(
        Func<Task<bool>> predicate,
        string because,
        int attempts = 600)
    {
        for (int attempt = 0; attempt < attempts; attempt++)
        {
            if (await predicate().ConfigureAwait(false))
            {
                return;
            }

            await Task.Delay(25).ConfigureAwait(false);
        }

        Assert.Fail($"Fault scenario timed out: {because}.");
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        Addin.ReleaseGate();
        _stop.Cancel();
        try
        {
            await _run.WaitAsync(TimeSpan.FromSeconds(15)).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (TimeoutException)
        {
        }

        _stop.Dispose();
        await _journal.DisposeAsync().ConfigureAwait(false);
        Control.Dispose();
        await _stub.DisposeAsync().ConfigureAwait(false);
        _directory.Dispose();
    }

    private static string MachineFingerprint => "sha256:" + new string('0', 64);

    private static RbpHelloProfile Profile() =>
        new(
            "0.1.0-harness",
            "WS-HARNESS",
            "Windows 11",
            new[] { "2026.07.26.0" },
            capabilities: Array.Empty<string>());

    private static RbpLocalSessionSnapshot LocalSession(
        int port = 8080,
        int processId = 4242)
    {
        string localKey = $"port:{port}:pid:{processId}:started:100";
        return new RbpLocalSessionSnapshot(
            localKey,
            Json(
                $$"""
                {
                  "local_session_key":"{{localKey}}",
                  "user_hint":{"name":"Harness"},
                  "machine":{
                    "hostname":"WS-HARNESS",
                    "fingerprint":"{{MachineFingerprint}}"
                  },
                  "revit":{"version":"2024","build":"24.1","pid":{{processId}}},
                  "addin_version":"2026.07.26.0",
                  "result_contract_version":2,
                  "session_capabilities":[],
                  "bridge_version":"0.1.0-harness",
                  "documents":[
                    {
                      "document_id":"{{DocumentId}}",
                      "title":"Harness",
                      "path_digest":"sha256:{{new string('1', 64)}}",
                      "is_workshared":false,
                      "is_active":true
                    }
                  ],
                  "port":{{port}}
                }
                """),
            port,
            Json("""{"active_task":null,"addin_reachable":true}"""));
    }

    private static JsonElement Json(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
