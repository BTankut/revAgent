using System.Text;
using System.Text.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

/// <summary>
/// Frozen Section 10.3 result-emission conformance closed by the worker
/// composition audit: replay keeps the REQUIRED verification
/// <c>result_digest</c>, a guarded answer always carries a usable
/// <c>guarded_reason</c>, a late real outcome is preserved in the journal and
/// replays as Section 6.2.1 recovery evidence (Section 21 item 17), and the
/// Section 15 error mapping vectors for method-not-found, invalid params,
/// add-in exception, guarded result, and failure-shaped result
/// (Section 21 item 18).
/// </summary>
public sealed class RbpResultEmissionConformanceTests
{
    private const string Rsid = "rs-test";
    private const string LateDigest =
        "sha256:" +
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task AReplayedVerificationReadKeepsItsRequiredResultDigest()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        byte[] raw = Encoding.UTF8.GetBytes(
            """{"jsonrpc":"2.0","id":"x","result":{"ok":true}}""");
        var channel = new StubChannel(
            () => Task.FromResult(Completed("""{"ok":true}""", raw)));
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);

        RbpInvocationAnswer first = await dispatcher.DispatchAsync(
            ReadRequest(verification: """{"hold_id":"vh:1"}"""),
            CancellationToken.None);
        string digest =
            first.Payload.GetProperty("result_digest").GetString()!;

        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(
            ReadRequest(verification: """{"hold_id":"vh:1"}"""),
            CancellationToken.None);

        // Section 10.3: the digest exists so a later
        // recovery_clearances[].evidence_digest can be checked independently
        // by both peers. Rule 1 reissues the stored body verbatim apart from
        // the replay flags, so the digest must survive redelivery.
        Assert.Equal(1, channel.Calls);
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());
        Assert.Equal(
            digest,
            replay.Payload.GetProperty("result_digest").GetString());
        Assert.False(
            replay.Payload.GetProperty("payload_omitted").GetBoolean());
        Assert.True(replay.Payload.TryGetProperty("result", out _));
    }

    [Fact]
    public async Task AReplayWithoutVerificationStillCarriesNoDigest()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(
            () => Task.FromResult(Completed("""{"ok":true}""")));
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);

        RbpInvocationAnswer first = await dispatcher.DispatchAsync(
            ReadRequest(),
            CancellationToken.None);
        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(
            ReadRequest(),
            CancellationToken.None);

        Assert.False(first.Payload.TryGetProperty("result_digest", out _));
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());
        Assert.False(replay.Payload.TryGetProperty("result_digest", out _));
    }

    [Fact]
    public async Task C39D_AttestedFixtureOriginIsSuppressedThenReplayedOnceWithoutResultBytes()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory, protectRecovery: true);
        var attestation = new AddinProcessAttestation(
            new AddinProcessIdentity(481, 638400000000000000), "2025",
            "addin-loopback-fixture/test-only");
        var observation = RbpConformanceOmittedOriginObservation
            .CreateFixtureOneShot(() => attestation);
        byte[] raw = Encoding.UTF8.GetBytes(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"result\":{\"fixture\":true}}");
        var channel = new StubChannel(() => Task.FromResult(
            Completed("{\"fixture\":true}", raw) with
            {
                ProcessAttestation = attestation,
            }));
        RbpInvocationDispatcher dispatcher = new(
            store, channel, new RbpInFlightGate(),
            omittedOriginObservation: observation);
        RbpInvokeRequest request = FixtureRequest();

        await Assert.ThrowsAsync<RbpConformanceOriginSuppressedException>(
            () => dispatcher.DispatchAsync(request, CancellationToken.None));
        RbpStoredInvocation? stored = await store.GetInvocationAsync(
            request.ToIdentity().IdempotencyKey);
        Assert.Equal(RbpInvocationState.Completed, stored!.State);
        Assert.Contains("\"result\"", stored.TerminalOutcomeJson!);
        Assert.Contains("\"payload_omitted\":false", stored.TerminalOutcomeJson!);

        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(
            request, CancellationToken.None);
        Assert.Equal(1, channel.Calls);
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());
        Assert.True(replay.Payload.GetProperty("payload_omitted").GetBoolean());
        Assert.False(replay.Payload.TryGetProperty("result", out _));
        Assert.NotNull(replay.OmittedOriginReplay);
        Assert.False(observation.TryConsumeDurableAcknowledgement(Rsid, 1));
        Assert.True(observation.TryBindReplay(
            replay.OmittedOriginReplay!, 7,
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        Assert.False(observation.TryConsumeDurableAcknowledgement("foreign", 7));
        Assert.False(observation.TryConsumeDurableAcknowledgement(Rsid, 6));
        Assert.True(observation.TryConsumeDurableAcknowledgement(Rsid, 7));

        RbpInvocationAnswer ordinary = await dispatcher.DispatchAsync(
            request, CancellationToken.None);
        Assert.True(ordinary.Payload.TryGetProperty("result", out _));
        Assert.False(ordinary.Payload.GetProperty("payload_omitted").GetBoolean());
    }

    [Fact]
    public async Task AGuardWithoutAUsableReasonFallsBackToUnspecifiedGuarded()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(() => Task.FromResult(
            Completed("""{"detail":"blocked"}""") with
            {
                Kind = RbpAddinOutcomeKind.Guarded,
                GuardedReason = null,
            }));

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                ReadRequest(),
                CancellationToken.None);

        // Section 10.3 makes guarded_reason REQUIRED exactly when the status
        // is guarded; a guard with no usable code uses the frozen fallback.
        Assert.Equal("result", answer.Type);
        Assert.Equal(
            "guarded",
            answer.Payload.GetProperty("status").GetString());
        Assert.Equal(
            "unspecified_guarded",
            answer.Payload.GetProperty("guarded_reason").GetString());
    }

    [Fact]
    public async Task ALateRealOutcomeIsPreservedAndReplaysAsRecoveryEvidence()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(
            () => Task.FromResult(PossiblyDispatched("the socket reset")));
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);

        // The Gateway abandons the delivery: the uncertain mutation becomes
        // journal_indeterminate with an installed Section 6.2.1 hold.
        RbpInvocationAnswer abandoned = await dispatcher.DispatchAsync(
            WriteRequest(),
            CancellationToken.None);
        string holdId = abandoned.Payload
            .GetProperty("verification_hold_id")
            .GetString()!;

        // The real add-in outcome becomes known later. Section 16: it is
        // journaled and never erased by the abandonment.
        string key = WriteRequest().ToIdentity().IdempotencyKey;
        _ = await store.PersistInvocationTerminalAsync(
            key,
            new RbpInvocationTerminal(
                RbpInvocationState.Completed,
                Json("""{"late":true}"""),
                LateDigest));

        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(
            WriteRequest(),
            CancellationToken.None);

        // Section 10.3: replayed, verification_hold_id, and result_digest are
        // all REQUIRED alongside late_after_indeterminate:true, and the answer
        // is recovery evidence, not a second user-visible execution.
        Assert.Equal(1, channel.Calls);
        Assert.Equal("result", replay.Type);
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());
        Assert.True(
            replay.Payload
                .GetProperty("late_after_indeterminate")
                .GetBoolean());
        Assert.Equal(
            holdId,
            replay.Payload
                .GetProperty("verification_hold_id")
                .GetString());
        Assert.Equal(
            LateDigest,
            replay.Payload.GetProperty("result_digest").GetString());

        // The row stays indeterminate and the hold is not cleared by replay.
        RbpStoredInvocation? stored = await store.GetInvocationAsync(key);
        Assert.Equal(RbpInvocationState.Indeterminate, stored!.State);
        Assert.Equal("""{"late":true}""", stored.LateTerminalOutcomeJson);
        RbpVerificationHold? hold = await store.FindConflictingHoldAsync(
            Rsid,
            stored.Identity.MutationScopeJcs!);
        Assert.NotNull(hold);
        Assert.NotEqual(RbpHoldState.Cleared, hold!.State);
    }

    [Theory]
    [InlineData(-32601, "unsupported")]
    [InlineData(-32602, "parameter")]
    [InlineData(-32600, "parameter")]
    [InlineData(-32700, "parameter")]
    [InlineData(-32603, "revit_api")]
    [InlineData(40001, "revit_api")]
    public void AddinErrorCodesMapOntoTheFrozenFaultClasses(
        int code,
        string expected) =>
        Assert.Equal(
            expected,
            RbpRoutedInvocationChannel.MapAddinErrorFaultClass(code));

    [Fact]
    public void TransportDeadlineExpiryMapsToRevitTimeout()
    {
        var timeout = new AddinTransportException(
            "addin_call_timeout",
            "The add-in call exceeded its deadline.",
            NotStartedEvidence());

        Assert.Equal(
            "revit_timeout",
            RbpRoutedInvocationChannel.MapTransportFailureFaultClass(
                timeout,
                possiblyDispatched: true));
        Assert.Equal(
            "revit_timeout",
            RbpRoutedInvocationChannel.MapTransportFailureFaultClass(
                timeout,
                possiblyDispatched: false));
        Assert.Null(
            RbpRoutedInvocationChannel.MapTransportFailureFaultClass(
                new IOException("reset"),
                possiblyDispatched: true));
        Assert.Equal(
            "addin_unreachable",
            RbpRoutedInvocationChannel.MapTransportFailureFaultClass(
                new IOException("refused"),
                possiblyDispatched: false));
    }

    [Theory]
    [InlineData(
        """{"status":"guarded","guardedReason":"workset_locked"}""",
        true,
        "workset_locked")]
    [InlineData(
        """{"guarded":true,"reason":"element_pinned"}""",
        true,
        "element_pinned")]
    [InlineData(
        """{"guarded":true,"guarded_reason":"view_locked"}""",
        true,
        "view_locked")]
    [InlineData(
        """{"guarded":true,"reason":"Not A Stable Code!"}""",
        true,
        "unspecified_guarded")]
    [InlineData("""{"guarded":true}""", true, "unspecified_guarded")]
    [InlineData("""{"status":"completed","ok":true}""", false, null)]
    public void GuardSignalsReduceToStableReasonCodes(
        string body,
        bool expectedGuarded,
        string? expectedReason)
    {
        (bool guarded, string? reason) =
            RbpRoutedInvocationChannel.ReadGuard(JObject.Parse(body));

        Assert.Equal(expectedGuarded, guarded);
        Assert.Equal(expectedReason, reason);
    }

    [Fact]
    public async Task AMethodNotFoundAnswerTerminalizesAsUnsupported()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(() => Task.FromResult(
            AddinReportedError(
                "unsupported",
                -32601,
                "method not found")));

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                ReadRequest(),
                CancellationToken.None);

        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "unsupported",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.False(answer.Payload.GetProperty("retryable").GetBoolean());
        Assert.Equal(
            "known",
            answer.Payload.GetProperty("outcome").GetString());
        Assert.Equal(
            -32601,
            answer.Payload
                .GetProperty("addin_error")
                .GetProperty("code")
                .GetInt32());
    }

    [Fact]
    public async Task AFailureShapedAddinAnswerTerminalizesAsRevitApi()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(() => Task.FromResult(
            AddinReportedError(
                RbpRoutedInvocationChannel.MapAddinErrorFaultClass(40001),
                40001,
                "failure-shaped add-in result")));

        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                ReadRequest(),
                CancellationToken.None);

        // The add-in executed and answered with a failure-shaped result, so
        // the outcome is a known revit_api failure and never retried by the
        // bridge on the orchestrator's behalf.
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "revit_api",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.False(answer.Payload.GetProperty("retryable").GetBoolean());
        RbpStoredInvocation? stored = await store.GetInvocationAsync(
            Rsid + "/" + ReadRequest().InvocationId);
        Assert.Equal(RbpInvocationState.Failed, stored!.State);
    }

    private static RbpInvocationDispatcher Dispatcher(
        RbpJournalStore store,
        IRbpInvocationChannel channel) =>
        new(store, channel, new RbpInFlightGate());

    private static async Task<RbpJournalStore> OpenAsync(
        RbpJournalTestDirectory directory,
        bool protectRecovery = false)
    {
        RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(),
            protectRecovery ? new TestRecoveryPayloadProtector() : null);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        return store;
    }

    private static RbpInvokeRequest ReadRequest(
        string invocationId = "0197a3c2-0000-7000-8000-0000000000e1",
        string verification = "null") =>
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
              "verification": {{verification}},
              "recovery_clearances": []
            }
            """);

    private static RbpInvokeRequest WriteRequest(
        string invocationId = "0197a3c2-0000-7000-8000-0000000000e2") =>
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

    private static RbpInvokeRequest FixtureRequest() =>
        Parse(
            """
            {
              "invocation_id":"0197a3c2-0000-7000-8000-0000000000f1",
              "method":"fixture_multi_file_output",
              "params":{"scenario":"valid_multifile","fileCount":1,"bytesPerFile":1048577},
              "timeout_ms":120000,
              "mutating":false,
              "mutation_scope":null,
              "policy":{"class":"auto","decision":"auto","confirmation_id":null},
              "verification":null,
              "recovery_clearances":[]
            }
            """);

    private static RbpInvokeRequest Parse(string payloadJson)
    {
        using JsonDocument document = JsonDocument.Parse(payloadJson);
        return RbpInvokeRequest.Parse(Rsid, document.RootElement.Clone());
    }

    private static RbpAddinOutcome Completed(
        string resultJson,
        byte[]? raw = null)
    {
        using JsonDocument document = JsonDocument.Parse(resultJson);
        raw ??= Encoding.UTF8.GetBytes(resultJson);
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

    private static RbpAddinOutcome AddinReportedError(
        string faultClass,
        int code,
        string message) =>
        new(
            RbpAddinOutcomeKind.KnownNotDispatched,
            default,
            [],
            RequestBytes: 128,
            ResponseBytes: 64,
            FaultClass: faultClass,
            Message: message,
            AddinError: new AddinErrorDetail(code, message),
            Retryable: false);

    private static JsonElement Json(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static AddinTransportEvidence NotStartedEvidence() =>
        new(
            AddinDispatchState.NotStarted,
            RequestPayloadBytes: 0,
            RequestFrameBytes: 0,
            BytesWrittenLowerBound: 0,
            RequestFullyWritten: false,
            ResponseBytesObserved: 0);

    private sealed class StubChannel(Func<Task<RbpAddinOutcome>> onInvoke)
        : IRbpInvocationChannel
    {
        private int _calls;

        internal int Calls => Volatile.Read(ref _calls);

        public Task<RbpAddinOutcome> InvokeAsync(
            string rsid,
            AddinCall call,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _calls);
            return onInvoke();
        }
    }
}
