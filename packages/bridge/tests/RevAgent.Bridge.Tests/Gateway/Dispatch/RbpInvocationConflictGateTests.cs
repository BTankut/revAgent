using System.Text;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

/// <summary>
/// Frozen O1 Section 6.2.1 conformance for the ordinary invoke path, where an
/// <c>invoke</c> carries an empty or absent <c>recovery_clearances</c> array.
/// </summary>
/// <remarks>
/// <para>
/// Spec ~480-485: "Before minting or dispatching <b>every</b> new mutating
/// invocation or batch, the Gateway MUST query its durable conflict index.
/// Before writing the first add-in byte, the bridge MUST perform the same
/// check against its durable local index. An active conflict returns the
/// original hold's <c>journal_indeterminate</c> error without add-in contact
/// even when <c>invocation_id</c> or <c>batch_id</c> is fresh. Redelivery of
/// an origin key and a correlated read-only verification are the only
/// operations exempt from this block."
/// </para>
/// <para>
/// The clearance-carrying envelope has its own suite; these tests pin the path
/// that carries no clearance, which is the one an ordinary Gateway retry takes
/// and the one where a missing gate would let a second write reach a Revit
/// model whose first write's effect is still unknown.
/// </para>
/// </remarks>
public sealed class RbpInvocationConflictGateTests
{
    private const string Rsid = "rs-test";
    private const string WriteMethod = "create_wall";
    private const string ReadMethod = "get_element_parameter";
    private const string DocumentOneScope =
        """{"document_id":"doc-1","kind":"document"}""";
    private const string DocumentTwoScope =
        """{"document_id":"doc-2","kind":"document"}""";
    private const string SessionScope = """{"kind":"session"}""";

    private const string OriginInvocationId =
        "0197a3c2-0000-7000-8000-0000000000b2";
    private const string FreshInvocationId =
        "0197a3c2-0000-7000-8000-0000000000f4";
    private const string SecondFreshInvocationId =
        "0197a3c2-0000-7000-8000-0000000000f5";
    private const string VerificationInvocationId =
        "0197a3c2-0000-7000-8000-0000000000e1";
    private const string ResolutionId =
        "0197a3c2-0000-7000-8000-000000000101";
    private const string AuditId =
        "0197a3c2-0000-7000-8000-000000000102";

    private static readonly string EvidenceDigest =
        "sha256:" + new string('d', 64);

    /// <summary>
    /// The defect this suite exists for: with no gate on the ordinary path a
    /// fresh <c>invocation_id</c> is enough to walk straight past an active
    /// hold and write to the model again.
    /// </summary>
    [Fact]
    public async Task AFreshMutationOnAHeldScopeIsRefusedWithTheOriginalHold()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        string holdId = await InstallActiveHoldAsync(store, DocumentOneScope);

        var channel = new CountingChannel();
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                WriteRequest(FreshInvocationId, DocumentOneScope),
                CancellationToken.None);

        // "without add-in contact even when invocation_id ... is fresh".
        Assert.Equal(0, channel.Calls);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "journal_indeterminate",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(
            FreshInvocationId,
            answer.Payload.GetProperty("invocation_id").GetString());
        Assert.False(answer.Payload.GetProperty("retryable").GetBoolean());
        Assert.True(
            answer.Payload.GetProperty("verification_required").GetBoolean());
        Assert.False(answer.Payload.GetProperty("replayed").GetBoolean());

        // "returns *the original hold's* journal_indeterminate error": the
        // correlation id is the one already installed, not a new one minted
        // for this delivery.
        Assert.Equal(
            holdId,
            answer.Payload.GetProperty("verification_hold_id").GetString());

        // Nothing was written: no journal row for the fresh key, no second
        // hold, and the original hold is still active with its frozen origin.
        Assert.Null(
            await store.GetInvocationAsync(Rsid + "/" + FreshInvocationId));
        Assert.Null(
            await store.GetHoldAsync(
                Rsid,
                DeriveHoldId(
                    DocumentOneScope,
                    Rsid + "/" + FreshInvocationId)));
        RbpVerificationHold hold = (await store.GetHoldAsync(Rsid, holdId))!;
        Assert.Equal(RbpHoldState.Active, hold.State);
        Assert.Equal(
            new[] { Rsid + "/" + OriginInvocationId },
            hold.OrderedOriginIdempotencyKeys);
    }

    /// <summary>
    /// First frozen exemption: "Redelivery of an origin key".
    /// </summary>
    [Fact]
    public async Task RedeliveryOfTheOriginKeyKeepsTheSection122Rules()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);

        // Left `executing`, the state a crash between Section 12.1 steps 2
        // and 3 produces. The next delivery of this key is rule 4 and the one
        // after it is rule 1 — both while the hold rule 4 installs is active.
        RbpInvokeRequest origin =
            WriteRequest(OriginInvocationId, DocumentOneScope);
        _ = await store.AdmitInvocationAsync(origin.ToIdentity());
        await store.MarkInvocationExecutingAsync(
            origin.ToIdentity().IdempotencyKey);

        var channel = new CountingChannel();
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);
        RbpInvocationAnswer refused = await dispatcher.DispatchAsync(
            origin,
            CancellationToken.None);
        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(
            origin,
            CancellationToken.None);

        Assert.Equal(0, channel.Calls);
        string holdId = DeriveHoldId(
            DocumentOneScope,
            Rsid + "/" + OriginInvocationId);

        // Rule 4 unchanged: the refusal installs the scope hold and answers
        // with it, under the origin's own id.
        Assert.Equal("error", refused.Type);
        Assert.Equal(
            "journal_indeterminate",
            refused.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(
            holdId,
            refused.Payload.GetProperty("verification_hold_id").GetString());
        Assert.False(refused.Payload.GetProperty("replayed").GetBoolean());

        // Rule 1 unchanged: the second redelivery replays the durable row
        // with `replayed:true`, which only the Section 12.2 rules produce —
        // the Section 6.2.1 block always answers `replayed:false`. So the
        // redelivery reached the rules, not the block.
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());
        Assert.Equal(
            CanonicalWithoutReplayedFlag(refused.Payload),
            CanonicalWithoutReplayedFlag(replay.Payload));

        RbpStoredInvocation stored =
            (await store.GetInvocationAsync(
                Rsid + "/" + OriginInvocationId))!;
        Assert.Equal(RbpInvocationState.Indeterminate, stored.State);
        Assert.Equal(holdId, stored.VerificationHoldId);
    }

    /// <summary>
    /// Second frozen exemption: "a correlated read-only verification". Spec
    /// ~487 makes it "an ordinary <c>mutating:false</c> <c>invoke</c>" with a
    /// server-authored correlation block, and the hold it resolves must not
    /// block it.
    /// </summary>
    [Fact]
    public async Task ACorrelatedReadOnlyVerificationIsAdmitted()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        string holdId = await InstallActiveHoldAsync(store, DocumentOneScope);

        var channel = new CountingChannel();
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                VerificationReadRequest(holdId),
                CancellationToken.None);

        Assert.Equal("result", answer.Type);
        Assert.Equal(1, channel.Calls);
        Assert.Equal(
            "completed",
            answer.Payload.GetProperty("status").GetString());
        Assert.Equal(
            RbpInvocationState.Completed,
            (await store.GetInvocationAsync(
                Rsid + "/" + VerificationInvocationId))!.State);

        // "A successful read is evidence, not clearance": the hold keeps
        // blocking its scope.
        Assert.Equal(
            RbpHoldState.Active,
            (await store.GetHoldAsync(Rsid, holdId))!.State);
    }

    /// <summary>
    /// The block is per conflicting scope, not per session: a document hold
    /// conflicts with "the same document scope and any session scope" only.
    /// </summary>
    [Fact]
    public async Task ANonConflictingDocumentScopeIsUnaffected()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        string holdId = await InstallActiveHoldAsync(store, DocumentOneScope);

        var channel = new CountingChannel();
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);
        RbpInvocationAnswer proceeds = await dispatcher.DispatchAsync(
            WriteRequest(FreshInvocationId, DocumentTwoScope),
            CancellationToken.None);
        RbpInvocationAnswer blocked = await dispatcher.DispatchAsync(
            WriteRequest(SecondFreshInvocationId, DocumentOneScope),
            CancellationToken.None);

        // Document B proceeds and is durably terminal.
        Assert.Equal("result", proceeds.Type);
        Assert.Equal(1, channel.Calls);
        Assert.Equal(
            RbpInvocationState.Completed,
            (await store.GetInvocationAsync(
                Rsid + "/" + FreshInvocationId))!.State);

        // Document A, held, is still refused — and the add-in call count did
        // not move.
        Assert.Equal("error", blocked.Type);
        Assert.Equal(1, channel.Calls);
        Assert.Equal(
            holdId,
            blocked.Payload.GetProperty("verification_hold_id").GetString());
    }

    /// <summary>
    /// The frozen subsumption rule: "A session scope conflicts with every
    /// mutation scope under that <c>rsid</c>".
    /// </summary>
    [Fact]
    public async Task ASessionScopeHoldBlocksEveryDocumentScope()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        string holdId = await InstallActiveHoldAsync(store, SessionScope);

        var channel = new CountingChannel();
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);
        RbpInvocationAnswer first = await dispatcher.DispatchAsync(
            WriteRequest(FreshInvocationId, DocumentOneScope),
            CancellationToken.None);
        RbpInvocationAnswer second = await dispatcher.DispatchAsync(
            WriteRequest(SecondFreshInvocationId, DocumentTwoScope),
            CancellationToken.None);

        Assert.Equal(0, channel.Calls);
        foreach (RbpInvocationAnswer answer in new[] { first, second })
        {
            Assert.Equal("error", answer.Type);
            Assert.Equal(
                "journal_indeterminate",
                answer.Payload.GetProperty("fault_class").GetString());
            Assert.Equal(
                holdId,
                answer.Payload.GetProperty("verification_hold_id").GetString());

            // The answer carries the original hold's scope, not the scope the
            // blocked delivery asked for.
            Assert.Equal(
                SessionScope,
                Rfc8785Json.Canonicalize(
                    answer.Payload.GetProperty("mutation_scope")));
        }

        Assert.Null(
            await store.GetInvocationAsync(Rsid + "/" + FreshInvocationId));
        Assert.Null(
            await store.GetInvocationAsync(
                Rsid + "/" + SecondFreshInvocationId));
    }

    /// <summary>
    /// The gate must not swallow the one envelope Section 6.2.1 permits: a
    /// clearance that legitimately clears the hold still admits and
    /// dispatches.
    /// </summary>
    [Fact]
    public async Task AClearanceThatClearsTheHoldAdmitsAndDispatches()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        string holdId = await InstallActiveHoldAsync(store, DocumentOneScope);
        _ = await store.RecordHoldVerificationEvidenceAsync(
            Rsid,
            new RbpHoldVerificationEvidence(
                holdId,
                VerificationInvocationId,
                EvidenceDigest,
                Conclusive: true));

        var channel = new CountingChannel();
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                WriteRequest(
                    FreshInvocationId,
                    DocumentOneScope,
                    ClearanceArray(holdId)),
                CancellationToken.None);

        Assert.Equal("result", answer.Type);
        Assert.Equal(1, channel.Calls);
        Assert.Equal(
            RbpHoldState.Cleared,
            (await store.GetHoldAsync(Rsid, holdId))!.State);
        Assert.Equal(
            RbpInvocationState.Completed,
            (await store.GetInvocationAsync(
                Rsid + "/" + FreshInvocationId))!.State);
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
    /// Leaves one active hold on the supplied scope through the only route
    /// that installs one for a single invocation: a possibly dispatched
    /// mutation whose redelivery Section 12.2 rule 4 refuses.
    /// </summary>
    private static async Task<string> InstallActiveHoldAsync(
        RbpJournalStore store,
        string scopeJcs)
    {
        RbpInvocationIdentity origin =
            WriteRequest(OriginInvocationId, scopeJcs).ToIdentity();
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        RbpInvocationAdmissionResult refused =
            await store.AdmitInvocationAsync(origin);
        Assert.Equal(
            RbpInvocationAdmission.RefuseIndeterminate,
            refused.Admission);
        return refused.VerificationHoldId!;
    }

    private static string DeriveHoldId(
        string scopeJcs,
        params string[] orderedOriginIdempotencyKeys)
    {
        using JsonDocument scope = JsonDocument.Parse(scopeJcs);
        return Rfc8785Json.MakeVerificationHoldId(
            Rsid,
            scope.RootElement,
            orderedOriginIdempotencyKeys);
    }

    private static string CanonicalWithoutReplayedFlag(JsonElement payload)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (JsonProperty property in payload.EnumerateObject())
            {
                if (!property.NameEquals("replayed"))
                {
                    property.WriteTo(writer);
                }
            }

            writer.WriteEndObject();
        }

        using JsonDocument document = JsonDocument.Parse(buffer.ToArray());
        return Rfc8785Json.Canonicalize(document.RootElement);
    }

    private static string ClearanceArray(string holdId) =>
        $$"""
        [
          {
            "hold_id": "{{holdId}}",
            "mutation_scope": {"kind":"document","document_id":"doc-1"},
            "resolution_id": "{{ResolutionId}}",
            "basis": "verification_read",
            "verification_invocation_id": "{{VerificationInvocationId}}",
            "evidence_digest": "{{EvidenceDigest}}",
            "decision": "postcondition_verified",
            "audit_id": "{{AuditId}}"
          }
        ]
        """;

    private static RbpInvokeRequest WriteRequest(
        string invocationId,
        string mutationScopeJcs,
        string clearances = "[]")
    {
        string payload =
            $$"""
            {
              "invocation_id": "{{invocationId}}",
              "method": "{{WriteMethod}}",
              "params": {"length": 3000},
              "timeout_ms": 120000,
              "mutating": true,
              "mutation_scope": {{mutationScopeJcs}},
              "policy": {"class":"confirm","decision":"confirmed","confirmation_id":"c1"},
              "verification": null,
              "recovery_clearances": {{clearances}}
            }
            """;
        return Parse(payload);
    }

    /// <summary>
    /// The frozen Section 6.2.1 verification read: an ordinary
    /// <c>mutating:false</c> invoke carrying the server-authored correlation
    /// block for the hold it is meant to resolve.
    /// </summary>
    private static RbpInvokeRequest VerificationReadRequest(string holdId)
    {
        string payload =
            $$"""
            {
              "invocation_id": "{{VerificationInvocationId}}",
              "method": "{{ReadMethod}}",
              "params": {"element_id": 42},
              "timeout_ms": 30000,
              "mutating": false,
              "mutation_scope": null,
              "policy": {"class":"read","decision":"allow"},
              "verification": {
                "hold_id": "{{holdId}}",
                "mutation_scope": {"kind":"document","document_id":"doc-1"},
                "purpose": "resolve_indeterminate"
              },
              "recovery_clearances": []
            }
            """;
        return Parse(payload);
    }

    private static RbpInvokeRequest Parse(string payload)
    {
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
