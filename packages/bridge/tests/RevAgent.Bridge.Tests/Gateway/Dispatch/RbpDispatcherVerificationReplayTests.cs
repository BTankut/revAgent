using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

/// <summary>
/// Frozen O1 Section 10.3 conformance for the Section 12.2 rule 1 replay of a
/// terminal read: <c>result_digest</c> is REQUIRED, while the full
/// <c>result</c> is retained, for a terminal read carrying a non-null Section
/// 6.2.1 <c>verification</c> correlation, so a redelivery must reissue the
/// stored digest rather than strip it as a per-delivery replay flag. A read
/// with no verification correlation never stored one and must stay unaffected.
/// </summary>
public sealed class RbpDispatcherVerificationReplayTests
{
    private const string Rsid = "rs-test";
    private const string ReadMethod = "get_current_view_info";

    [Fact]
    public async Task AReplayedVerificationReadKeepsItsRequiredResultDigest()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await RbpCorrelatedVerificationFlowTests
            .OpenForRoute(directory, fixture);
        RbpInvocationDispatcher dispatcher = Dispatcher(store, fixture.Channel);
        RbpInvocationAnswer mutation = await dispatcher.DispatchAsync(
            RbpApplicationErrorSafetyTests.Request(mutating: true),
            CancellationToken.None);
        string holdId = mutation.Payload.GetProperty("verification_hold_id").GetString()!;
        fixture.Transport.SetResponse("{\"ok\":true}");
        RbpInvokeRequest request = RbpCorrelatedVerificationFlowTests.VerificationRequest(
            "0197a3c2-0000-7000-8000-0000000000e1",
            holdId);

        RbpInvocationAnswer first = await
            RbpCorrelatedVerificationFlowTests.DispatchVerificationAsync(
                dispatcher, fixture, request);
        string exactRawDigest = "sha256:" + Convert.ToHexString(
            SHA256.HashData(fixture.Transport.LastBytes)).ToLowerInvariant();
        int callsAfterFirstDelivery = fixture.Transport.Calls;
        RbpInvocationAnswer replay = await
            RbpCorrelatedVerificationFlowTests.DispatchVerificationAsync(
                dispatcher, fixture, request);

        // The add-in is not called again for the replay.
        Assert.Equal(2, callsAfterFirstDelivery);
        Assert.Equal(callsAfterFirstDelivery, fixture.Transport.Calls);
        Assert.Equal("result", first.Type);
        Assert.Equal("result", replay.Type);
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());

        // Section 10.3: the digest exists so a later
        // recovery_clearances[].evidence_digest can be checked independently
        // by both peers. Redelivery must therefore answer with the same
        // digest the journal row holds, not with none.
        RbpStoredInvocation? stored = await store.GetInvocationAsync(
            request.ToIdentity().IdempotencyKey);
        Assert.Equal(RbpInvocationState.Completed, stored!.State);
        Assert.Equal(exactRawDigest, stored.ResultDigest);
        Assert.Equal(
            stored.ResultDigest,
            first.Payload.GetProperty("result_digest").GetString());
        Assert.Equal(
            stored.ResultDigest,
            replay.Payload.GetProperty("result_digest").GetString());

        // The full result is retained alongside the digest: the journal keeps
        // every terminal payload, so a replay never omits it.
        Assert.False(
            replay.Payload.GetProperty("payload_omitted").GetBoolean());
        Assert.Equal(
            Rfc8785Json.Canonicalize(first.Payload.GetProperty("result")),
            Rfc8785Json.Canonicalize(replay.Payload.GetProperty("result")));
    }

    [Fact]
    public async Task AReplayedReadWithoutVerificationStillCarriesNoDigest()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await OpenAsync(directory);
        var channel = new StubChannel(
            () => Task.FromResult(Completed("""{"ok":true}""")));
        RbpInvocationDispatcher dispatcher = Dispatcher(store, channel);

        RbpInvocationAnswer first = await dispatcher.DispatchAsync(
            PlainReadRequest(),
            CancellationToken.None);
        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(
            PlainReadRequest(),
            CancellationToken.None);

        // No verification correlation, so Section 10.3 never made the digest
        // REQUIRED and first delivery emitted none. The replay must not
        // invent one from the journal's evidence column.
        Assert.Equal(1, channel.Calls);
        Assert.False(first.Payload.TryGetProperty("result_digest", out _));
        Assert.True(replay.Payload.GetProperty("replayed").GetBoolean());
        Assert.False(replay.Payload.TryGetProperty("result_digest", out _));
        Assert.True(replay.Payload.TryGetProperty("result", out _));
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

    private static RbpInvokeRequest PlainReadRequest() =>
        ReadRequest("0197a3c2-0000-7000-8000-0000000000e2", "null");

    private static RbpInvokeRequest ReadRequest(
        string invocationId,
        string verification) =>
        Parse(
            $$"""
            {
              "invocation_id": "{{invocationId}}",
              "method": "{{ReadMethod}}",
              "params": {"view":"active"},
              "timeout_ms": 120000,
              "mutating": false,
              "mutation_scope": null,
              "policy": {"class":"auto","decision":"auto","confirmation_id":null},
              "verification": {{verification}},
              "recovery_clearances": []
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
