using System.Text;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

/// <summary>
/// RES-10 conformance (Section 21 items 13 and 14): the invoke hot path never
/// consults local <c>mcp_status</c>, and only a transport-shaped failure is
/// enriched into the structured <c>revit_busy</c> fault when local evidence
/// shows a competing active Revit task.
/// </summary>
public sealed class RbpDispatcherBusyEnrichmentTests
{
    private const string Rsid = "rs-test";

    [Fact]
    public async Task TheSuccessHotPathNeverConsultsLocalStatus()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var probe = new RecordingBusyProbe("export_sheets");
        var channel = new StubChannel(
            () => Task.FromResult(Completed("""{"ok":true}""")));
        RbpInvocationDispatcher dispatcher =
            Dispatcher(store, channel, probe);

        RbpInvocationAnswer completed = await dispatcher.DispatchAsync(
            ReadRequest("0197a3c2-0000-7000-8000-0000000000f1"),
            CancellationToken.None);

        // Section 9 / RES-10: the bridge MUST NOT issue mcp_status before
        // every invocation. A completed invoke never touches the probe.
        Assert.Equal("result", completed.Type);
        Assert.Equal(0, probe.Calls);

        var guardedChannel = new StubChannel(() => Task.FromResult(
            Completed("""{"detail":"blocked"}""") with
            {
                Kind = RbpAddinOutcomeKind.Guarded,
                GuardedReason = "workset_locked",
            }));
        RbpInvocationAnswer guarded =
            await Dispatcher(store, guardedChannel, probe).DispatchAsync(
                ReadRequest("0197a3c2-0000-7000-8000-0000000000f2"),
                CancellationToken.None);

        // A guarded answer is a result, not a failure path.
        Assert.Equal("result", guarded.Type);
        Assert.Equal(0, probe.Calls);
    }

    [Fact]
    public async Task ATransportFailedReadIsEnrichedToRevitBusy()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var probe = new RecordingBusyProbe("export_sheets");
        var channel = new StubChannel(() => Task.FromResult(
            NotDispatched("addin_unreachable", "connection refused")));

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel, probe).DispatchAsync(
                ReadRequest(),
                CancellationToken.None);

        // Section 21 item 14: after the failure, one local mcp_status
        // consultation enriches the structured fault to revit_busy.
        Assert.Equal(1, probe.Calls);
        Assert.Equal(Rsid, probe.LastRsid);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "revit_busy",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.True(answer.Payload.GetProperty("retryable").GetBoolean());
        Assert.Equal(
            "known",
            answer.Payload.GetProperty("outcome").GetString());
        Assert.Contains(
            "export_sheets",
            answer.Payload.GetProperty("message").GetString(),
            StringComparison.Ordinal);

        // The enriched fault is the durable terminal, not a wire-only remap.
        RbpStoredInvocation? stored = await store.GetInvocationAsync(
            Rsid + "/" + ReadRequest().InvocationId);
        Assert.Equal(RbpInvocationState.Failed, stored!.State);
        Assert.Contains(
            "revit_busy",
            stored.TerminalOutcomeJson,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task ATimedOutReadKeepsRevitTimeoutWhenNoTaskIsActive()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var probe = new RecordingBusyProbe(activeTask: null);
        var channel = new StubChannel(() => Task.FromResult(
            PossiblyDispatched("deadline exceeded") with
            {
                FaultClass = "revit_timeout",
            }));

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel, probe).DispatchAsync(
                ReadRequest(),
                CancellationToken.None);

        // The probe ran but found no competing task, so the transport
        // classification stands: a timed-out read stays retryable
        // revit_timeout under the Section 15 table.
        Assert.Equal(1, probe.Calls);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "revit_timeout",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.True(answer.Payload.GetProperty("retryable").GetBoolean());
        Assert.Equal(
            "known",
            answer.Payload.GetProperty("outcome").GetString());
    }

    [Fact]
    public async Task AProbeFaultLeavesTheOriginalFailureUntouched()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var probe = new RecordingBusyProbe(
            "export_sheets",
            throwOnProbe: true);
        var channel = new StubChannel(() => Task.FromResult(
            NotDispatched("addin_unreachable", "connection refused")));

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel, probe).DispatchAsync(
                ReadRequest(),
                CancellationToken.None);

        // Enrichment is best-effort evidence, never authority.
        Assert.Equal(1, probe.Calls);
        Assert.Equal(
            "addin_unreachable",
            answer.Payload.GetProperty("fault_class").GetString());
    }

    [Fact]
    public async Task AnIndeterminateMutationIsNeverDowngradedByBusyEvidence()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var probe = new RecordingBusyProbe("export_sheets");
        var channel = new StubChannel(
            () => Task.FromResult(PossiblyDispatched("the socket reset")));

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel, probe).DispatchAsync(
                WriteRequest(),
                CancellationToken.None);

        // Section 15: journal_indeterminate replaces every retryable class
        // after the first add-in byte may have been sent. Busy evidence can
        // never reopen a mutation, so the probe is not even consulted.
        Assert.Equal(0, probe.Calls);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "journal_indeterminate",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.False(answer.Payload.GetProperty("retryable").GetBoolean());
    }

    [Fact]
    public async Task AnAddinReportedFailureIsNotBusyEnriched()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var probe = new RecordingBusyProbe("export_sheets");
        var channel = new StubChannel(() => Task.FromResult(
            NotDispatched("revit_api", "the command threw") with
            {
                AddinError = new AddinErrorDetail(-32603, "the command threw"),
                Retryable = false,
            }));

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel, probe).DispatchAsync(
                ReadRequest(),
                CancellationToken.None);

        // The add-in answered; there is nothing for busy diagnosis to
        // distinguish, so the reported class stands untouched.
        Assert.Equal(0, probe.Calls);
        Assert.Equal(
            "revit_api",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.False(answer.Payload.GetProperty("retryable").GetBoolean());
    }

    private static RbpInvocationDispatcher Dispatcher(
        RbpJournalStore store,
        IRbpInvocationChannel channel,
        IRbpRevitBusyProbe probe) =>
        new(store, channel, new RbpInFlightGate(), probe);

    private static async Task<RbpJournalStore> OpenAsync(
        RbpJournalTestDirectory directory)
    {
        RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        return store;
    }

    private static RbpInvokeRequest ReadRequest(
        string invocationId = "0197a3c2-0000-7000-8000-0000000000f3") =>
        Parse(
            $$"""
            {
              "invocation_id": "{{invocationId}}",
              "method": "get_current_view_info",
              "params": {"view":"active"},
              "timeout_ms": 120000,
              "mutating": false,
              "mutation_scope": null,
              "policy": {"class":"auto","decision":"auto","confirmation_id":null},
              "verification": null,
              "recovery_clearances": []
            }
            """);

    private static RbpInvokeRequest WriteRequest(
        string invocationId = "0197a3c2-0000-7000-8000-0000000000f4") =>
        Parse(
            $$"""
            {
              "invocation_id": "{{invocationId}}",
              "method": "create_wall",
              "params": {"length": 3000},
              "timeout_ms": 120000,
              "mutating": true,
              "mutation_scope": {"kind":"document","document_id":"doc-1"},
              "policy": {"class":"confirm","decision":"confirmed","confirmation_id":"c1"},
              "verification": null,
              "recovery_clearances": []
            }
            """);

    private static RbpInvokeRequest Parse(string payloadJson)
    {
        using JsonDocument document = JsonDocument.Parse(payloadJson);
        return RbpInvokeRequest.Parse(Rsid, document.RootElement.Clone());
    }

    private static RbpAddinOutcome Completed(string resultJson)
    {
        using JsonDocument document = JsonDocument.Parse(resultJson);
        byte[] raw = Encoding.UTF8.GetBytes(resultJson);
        return new RbpAddinOutcome(
            RbpAddinOutcomeKind.Completed,
            document.RootElement.Clone(),
            raw,
            RequestBytes: 128,
            ResponseBytes: raw.Length);
    }

    private static RbpAddinOutcome PossiblyDispatched(string message) =>
        new(
            RbpAddinOutcomeKind.PossiblyDispatched,
            default,
            [],
            RequestBytes: 128,
            ResponseBytes: 0,
            Message: message);

    private static RbpAddinOutcome NotDispatched(
        string faultClass,
        string message) =>
        new(
            RbpAddinOutcomeKind.KnownNotDispatched,
            default,
            [],
            RequestBytes: 0,
            ResponseBytes: 0,
            FaultClass: faultClass,
            Message: message);

    private sealed class RecordingBusyProbe(
        string? activeTask,
        bool throwOnProbe = false) : IRbpRevitBusyProbe
    {
        private int _calls;
        private string? _lastRsid;

        internal int Calls => Volatile.Read(ref _calls);

        internal string? LastRsid => Volatile.Read(ref _lastRsid);

        public Task<string?> FindActiveTaskAsync(
            string rsid,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _calls);
            Volatile.Write(ref _lastRsid, rsid);
            if (throwOnProbe)
            {
                throw new InvalidOperationException(
                    "The local status source is unavailable.");
            }

            return Task.FromResult(activeTask);
        }
    }

    private sealed class StubChannel(Func<Task<RbpAddinOutcome>> onInvoke)
        : IRbpInvocationChannel
    {
        public Task<RbpAddinOutcome> InvokeAsync(
            string rsid,
            AddinCall call,
            CancellationToken cancellationToken) =>
            onInvoke();
    }
}
