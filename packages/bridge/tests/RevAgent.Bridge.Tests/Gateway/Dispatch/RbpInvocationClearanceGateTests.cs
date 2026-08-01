using System.Text;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

/// <summary>
/// Frozen O1 Section 6.2.1 conformance for the invoke path: a Gateway-authored
/// <c>recovery_clearances</c> envelope reaches the clearance-gated admission,
/// where the bridge "MUST match the clearance to its active hold and durable
/// evidence, then atomically mark the hold <c>cleared</c> with acceptance of
/// the new invocation before any add-in byte", while an invoke that carries no
/// clearance keeps the ordinary Section 12.2 admission.
/// </summary>
public sealed class RbpInvocationClearanceGateTests
{
    private const string Rsid = "rs-test";
    private const string WriteMethod = "create_wall";
    private const string DocumentScope =
        """{"document_id":"doc-1","kind":"document"}""";
    private const string OriginInvocationId =
        "0197a3c2-0000-7000-8000-0000000000b2";
    private const string FreshInvocationId =
        "0197a3c2-0000-7000-8000-0000000000f4";
    private const string VerificationId =
        "0197a3c2-0000-7000-8000-0000000000e1";
    private const string ResolutionId =
        "0197a3c2-0000-7000-8000-000000000101";
    private const string AuditId =
        "0197a3c2-0000-7000-8000-000000000102";

    private static readonly string EvidenceDigest =
        "sha256:" + new string('d', 64);

    [Fact]
    public async Task AnInvokeCarryingClearancesClearsItsHoldAndDispatches()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        string holdId = await InstallEvidencedHoldAsync(store);

        var channel = new CountingChannel();
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                WriteRequest(clearances: ClearanceArray(holdId)),
                CancellationToken.None);

        // Only the clearance-gated admission can move a hold to `cleared`;
        // the ordinary admission never touches the hold relation, so this
        // state proves the invoke went through the gated path.
        Assert.Equal("result", answer.Type);
        Assert.Equal(1, channel.Calls);
        RbpVerificationHold? hold = await store.GetHoldAsync(Rsid, holdId);
        Assert.Equal(RbpHoldState.Cleared, hold!.State);
        Assert.Equal(ResolutionId, hold.ResolutionId);
        Assert.Equal(AuditId, hold.AuditId);
    }

    [Fact]
    public async Task AClearanceThatMatchesNoHoldIsTerminalWithoutAddinBytes()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        string holdId = await InstallEvidencedHoldAsync(store);

        var channel = new CountingChannel();
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                WriteRequest(
                    clearances: ClearanceArray("vh:" + new string('a', 64))),
                CancellationToken.None);

        // With the gate unwired this clearance would simply be ignored and
        // the mutation would reach the add-in.
        Assert.Equal(0, channel.Calls);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "protocol",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.False(answer.Payload.GetProperty("retryable").GetBoolean());
        Assert.Equal(
            RbpHoldState.EvidenceRecorded,
            (await store.GetHoldAsync(Rsid, holdId))!.State);
        Assert.Null(
            await store.GetInvocationAsync(Rsid + "/" + FreshInvocationId));
    }

    [Fact]
    public async Task AMalformedClearanceEntryFailsClosedAtTheBoundary()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        _ = await InstallEvidencedHoldAsync(store);

        var channel = new CountingChannel();
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                WriteRequest(
                    clearances:
                        """[{"hold_id":"not-a-hold-id"}]"""),
                CancellationToken.None);

        Assert.Equal(0, channel.Calls);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "protocol",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.Null(
            await store.GetInvocationAsync(Rsid + "/" + FreshInvocationId));
    }

    [Fact]
    public async Task AnEmptyClearanceArrayKeepsTheOrdinaryAdmission()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        string holdId = await InstallEvidencedHoldAsync(store);

        var channel = new CountingChannel();
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                WriteRequest(),
                CancellationToken.None);

        // Unchanged Section 12.2 behaviour: the envelope carries no
        // clearance, so it is admitted exactly as before and the hold is
        // left untouched.
        Assert.Equal("result", answer.Type);
        Assert.Equal(1, channel.Calls);
        Assert.Equal(
            RbpHoldState.EvidenceRecorded,
            (await store.GetHoldAsync(Rsid, holdId))!.State);
    }

    private static RbpInvocationDispatcher Dispatcher(
        RbpJournalStore store,
        IRbpInvocationChannel channel) =>
        new(store, channel, new RbpInFlightGate());

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

    /// <summary>
    /// Leaves one active hold on <c>doc-1</c> with durable conclusive
    /// verification evidence, which is the only state a
    /// <c>verification_read</c> clearance may be accepted from.
    /// </summary>
    private static async Task<string> InstallEvidencedHoldAsync(
        RbpJournalStore store)
    {
        var origin = new RbpInvocationIdentity(
            Rsid,
            OriginInvocationId,
            WriteMethod,
            Mutating: true,
            MutationScopeJcs: DocumentScope,
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        RbpInvocationAdmissionResult refused =
            await store.AdmitInvocationAsync(origin);
        string holdId = refused.VerificationHoldId!;
        _ = await store.RecordHoldVerificationEvidenceAsync(
            Rsid,
            new RbpHoldVerificationEvidence(
                holdId,
                VerificationId,
                EvidenceDigest,
                Conclusive: true));
        return holdId;
    }

    private static string ClearanceArray(string holdId) =>
        $$"""
        [
          {
            "hold_id": "{{holdId}}",
            "mutation_scope": {"kind":"document","document_id":"doc-1"},
            "resolution_id": "{{ResolutionId}}",
            "basis": "verification_read",
            "verification_invocation_id": "{{VerificationId}}",
            "evidence_digest": "{{EvidenceDigest}}",
            "decision": "postcondition_verified",
            "audit_id": "{{AuditId}}"
          }
        ]
        """;

    private static RbpInvokeRequest WriteRequest(string clearances = "[]")
    {
        string payload =
            $$"""
            {
              "invocation_id": "{{FreshInvocationId}}",
              "method": "{{WriteMethod}}",
              "params": {"length": 3000},
              "timeout_ms": 120000,
              "mutating": true,
              "mutation_scope": {"kind":"document","document_id":"doc-1"},
              "policy": {"class":"confirm","decision":"confirmed","confirmation_id":"c1"},
              "verification": null,
              "recovery_clearances": {{clearances}}
            }
            """;
        using JsonDocument document = JsonDocument.Parse(payload);
        return RbpInvokeRequest.Parse(Rsid, document.RootElement.Clone());
    }

    private sealed class CountingChannel : IRbpInvocationChannel
    {
        private int _calls;

        internal int Calls => Volatile.Read(ref _calls);

        public Task<RbpAddinOutcome> InvokeAsync(
            string rsid,
            AddinCall call,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _calls);
            byte[] raw = Encoding.UTF8.GetBytes("""{"ok":true}""");
            using JsonDocument document = JsonDocument.Parse(raw);
            return Task.FromResult(
                new RbpAddinOutcome(
                    RbpAddinOutcomeKind.Completed,
                    document.RootElement.Clone(),
                    raw,
                    RequestBytes: 128,
                    ResponseBytes: raw.Length));
        }
    }
}
