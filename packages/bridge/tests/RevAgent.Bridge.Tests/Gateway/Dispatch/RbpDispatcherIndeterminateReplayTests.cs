using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

/// <summary>
/// Frozen O1 conformance for the Section 12.2 rule 1 replay of an
/// indeterminate mutation: a reconnect redelivery must answer the complete
/// Section 15 <c>journal_indeterminate</c> error body — not the abbreviated
/// durable evidence row — flagged <c>replayed:true</c> and otherwise identical
/// to the first delivery.
/// </summary>
public sealed class RbpDispatcherIndeterminateReplayTests
{
    private const string WriteMethod = "create_wall";
    private const string Rsid = "rs-test";
    private const string ScopeJson =
        """{"kind":"document","document_id":"doc-1"}""";

    [Fact]
    public async Task RedeliveryOfAnIndeterminateMutationCarriesTheFullBody()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(
            () => Task.FromResult(PossiblyDispatched("the socket reset")));
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);

        // Drive the mutation to its indeterminate terminal, then redeliver
        // the same frame — the reconnect path the journal replays from.
        RbpInvocationAnswer first = await dispatcher.DispatchAsync(
            WriteRequest(),
            CancellationToken.None);
        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(
            WriteRequest(),
            CancellationToken.None);

        // The add-in is not called again for the replay.
        Assert.Equal(1, channel.Calls);
        Assert.Equal("error", first.Type);
        Assert.Equal("error", replay.Type);

        // The full frozen Section 15 field set, not the stored evidence body.
        Assert.Equal(
            WriteRequest().InvocationId,
            replay.Payload.GetProperty("invocation_id").GetString());
        Assert.Equal(
            "journal_indeterminate",
            replay.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(
            "indeterminate",
            replay.Payload.GetProperty("outcome").GetString());
        Assert.False(replay.Payload.GetProperty("retryable").GetBoolean());
        Assert.True(
            replay.Payload.GetProperty("verification_required").GetBoolean());
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());
        Assert.False(
            replay.Payload
                .GetProperty("late_after_indeterminate")
                .GetBoolean());
        Assert.NotEmpty(
            replay.Payload.GetProperty("message").GetString() ?? string.Empty);

        // The hold is the one the first delivery installed, from the row.
        RbpStoredInvocation? stored = await store.GetInvocationAsync(
            WriteRequest().ToIdentity().IdempotencyKey);
        Assert.Equal(RbpInvocationState.Indeterminate, stored!.State);
        string? holdId =
            replay.Payload.GetProperty("verification_hold_id").GetString();
        Assert.StartsWith("vh:", holdId);
        Assert.Equal(stored.VerificationHoldId, holdId);
        Assert.Equal(
            first.Payload.GetProperty("verification_hold_id").GetString(),
            holdId);

        // The scope is the durable mutation scope of the identity.
        Assert.Equal(
            Canonical(ScopeJson),
            Rfc8785Json.Canonicalize(
                replay.Payload.GetProperty("mutation_scope")));

        // Section 15 forbids a result digest on this class.
        Assert.False(replay.Payload.TryGetProperty("result_digest", out _));
    }

    [Fact]
    public async Task AnIndeterminateReplayEqualsTheFirstDeliveryModuloReplayed()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);

        // Leave the row in `executing`, the state a crash between Section
        // 12.1 steps 2 and 3 produces; the next delivery classifies it
        // indeterminate (rule 4) and the one after that replays (rule 1).
        RbpInvokeRequest write = WriteRequest();
        _ = await store.AdmitInvocationAsync(write.ToIdentity());
        await store.MarkInvocationExecutingAsync(
            write.ToIdentity().IdempotencyKey);

        var channel = new StubChannel(
            () => Task.FromResult(PossiblyDispatched("never reached")));
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);

        RbpInvocationAnswer first = await dispatcher.DispatchAsync(
            write,
            CancellationToken.None);
        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(
            write,
            CancellationToken.None);

        Assert.Equal(0, channel.Calls);
        Assert.Equal("error", first.Type);
        Assert.Equal("error", replay.Type);
        Assert.False(first.Payload.GetProperty("replayed").GetBoolean());
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());

        // Byte-for-byte the same canonical body once the per-delivery replay
        // flag is set aside: same id, class, outcome, hold, scope, message.
        Assert.Equal(
            CanonicalWithoutReplayedFlag(first.Payload),
            CanonicalWithoutReplayedFlag(replay.Payload));
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

    private static RbpInvokeRequest WriteRequest(
        string invocationId = "0197a3c2-0000-7000-8000-0000000000c3") =>
        Parse(
            $$"""
            {
              "invocation_id": "{{invocationId}}",
              "method": "{{WriteMethod}}",
              "params": {"length": 3000},
              "timeout_ms": 120000,
              "mutating": true,
              "mutation_scope": {{ScopeJson}},
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

    private static RbpAddinOutcome PossiblyDispatched(string message) =>
        new(
            RbpAddinOutcomeKind.PossiblyDispatched,
            default,
            [],
            RequestBytes: 128,
            ResponseBytes: 0,
            Message: message);

    private static string Canonical(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        return Rfc8785Json.Canonicalize(document.RootElement);
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
