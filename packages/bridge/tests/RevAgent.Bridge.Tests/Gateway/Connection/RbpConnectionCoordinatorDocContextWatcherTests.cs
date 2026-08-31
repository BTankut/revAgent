using System.Collections.Concurrent;
using System.Reflection;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Runtime;
using RevAgent.Bridge.Tests.Gateway.Protocol;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed partial class RbpConnectionCoordinatorTests
{
    [Fact]
    public void RouteAuthorityCheckpointAndConnectionDigestMatchIndependentVectors()
    {
        using JsonDocument proof = JsonDocument.Parse("""
            {"version":1,"connection_id":"019f9add-7a83-7d11-a6a9-d2f8108c0098","proof_id":"019f9add-7a83-7d12-a6a9-d2f8108c0099","context":{},"context_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","freshness":{"source_revision":7,"cache_incarnation_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}
            """);
        const string rsid = "rs-vector";
        Assert.Equal(
            "sha256:ab4e0489142f3c9021386003710993e264559db902e85909105e6a5866c65518",
            RbpRouteRebindProof.MakeAuthorityCheckpoint(proof.RootElement, rsid));
        Assert.Equal(
            "sha256:9449ea3d182b5308a70be5bdd5266d31c6d586d68500299915a1158022fbb6c6",
            RbpRouteRebindProof.MakeConnectionDigest(
                rsid, "019f9add-7a83-7d11-a6a9-d2f8108c0098"));
        Assert.NotEqual(
            RbpRouteRebindProof.MakeConnectionDigest(
                "rs-other", "019f9add-7a83-7d11-a6a9-d2f8108c0098"),
            RbpRouteRebindProof.MakeConnectionDigest(
                rsid, "019f9add-7a83-7d11-a6a9-d2f8108c0098"));
        Assert.NotEqual(
            RbpRouteRebindProof.MakeAuthorityCheckpoint(proof.RootElement, rsid),
            RbpRouteRebindProof.MakeAuthorityCheckpoint(proof.RootElement,
                "rs-other"));
        using JsonDocument wrongConnection = JsonDocument.Parse("""
            {"version":1,"connection_id":"019f9add-7a83-7d11-a6a9-d2f8108c0097","proof_id":"019f9add-7a83-7d12-a6a9-d2f8108c0099","context":{},"context_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","freshness":{"source_revision":7,"cache_incarnation_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}
            """);
        Assert.NotEqual(
            RbpRouteRebindProof.MakeAuthorityCheckpoint(proof.RootElement, rsid),
            RbpRouteRebindProof.MakeAuthorityCheckpoint(
                wrongConnection.RootElement, rsid));
    }

    [Fact]
    public async Task FreshResumeProofReadBypassesWatcherEmissionStateAndRequiresFreshnessPair()
    {
        var channel = new ScriptedDocContextChannel();
        channel.SetSnapshot(
            revision: 7,
            title: "Project A",
            incarnation:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        var reader = new ScriptedFreshResumeProofReader();
        reader.SetSnapshot(
            revision: 7,
            incarnation:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        var watcher = new RbpDocContextWatcher(
            channel, freshResumeProofReader: reader);

        RbpFreshDocumentContext? first = await watcher
            .ReadFreshResumeProofContextAsync("rs-8091", CancellationToken.None);
        RbpFreshDocumentContext? second = await watcher
            .ReadFreshResumeProofContextAsync("rs-8091", CancellationToken.None);

        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.Equal(2, reader.CallCount);
        Assert.Equal(0, channel.CallCount);
        Assert.Equal(7, first!.Freshness.SourceRevision);
        Assert.Equal(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            first.Freshness.CacheIncarnationDigest);
        Assert.Equal(
            first.Context.GetRawText(),
            second!.Context.GetRawText());
        Assert.True(channel.AllLeasesReleased);

        reader.SetSnapshot(
            revision: 0,
            incarnation:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        Assert.Null(await watcher.ReadFreshResumeProofContextAsync(
            "rs-8091", CancellationToken.None));
    }

    [Fact]
    public async Task FreshResumeProofHasOnlyCanonicalRouteAuthorityFields()
    {
        var channel = new ScriptedDocContextChannel();
        channel.SetSnapshot(
            revision: 9,
            title: "Project A",
            incarnation:
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
        var reader = new ScriptedFreshResumeProofReader();
        reader.SetSnapshot(9,
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
        var watcher = new RbpDocContextWatcher(
            channel, freshResumeProofReader: reader);
        RbpFreshDocumentContext fresh = (await watcher
            .ReadFreshResumeProofContextAsync("rs-8091", CancellationToken.None))!;

        RbpRouteRebindProofResult result = RbpRouteRebindProof.Create(
            "rs-8091",
            "019f9add-7a83-7d11-a6a9-d2f8108c0098",
            fresh,
            new RbpUuidV7());
        JsonElement proof = result.Payload;

        Assert.Equal(1, proof.GetProperty("version").GetInt32());
        Assert.Equal(
            "019f9add-7a83-7d11-a6a9-d2f8108c0098",
            proof.GetProperty("connection_id").GetString());
        Assert.Matches(
            "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            proof.GetProperty("proof_id").GetString()!);
        Assert.Equal(
            RbpDocumentContextObservation.MakeContextDigest(
                fresh.Context),
            proof.GetProperty("context_digest").GetString());
        Assert.Equal(9, proof.GetProperty("freshness")
            .GetProperty("source_revision").GetInt64());
        Assert.False(proof.TryGetProperty("principal", out _));
        Assert.False(proof.TryGetProperty("rsid", out _));
    }

    [Fact]
    public void DocumentContextDigestVectorsMatchPinnedRfc8785Canonicalization()
    {
        using JsonDocument fixture = LoadDocumentContextDigestFixture();
        int count = 0;
        foreach (JsonElement vector in fixture.RootElement
                     .GetProperty("accepted")
                     .EnumerateArray())
        {
            JsonElement payload = vector.GetProperty("payload");
            string digest = RbpDocumentContextObservation.MakeContextDigest(
                payload);

            Assert.Equal(
                vector.GetProperty("canonical").GetString(),
                Rfc8785Json.Canonicalize(payload));
            Assert.Equal(
                vector.GetProperty("contextDigest").GetString(),
                digest);
            Assert.Matches("^[0-9a-f]{64}$", digest);
            Assert.NotEqual(
                vector.GetProperty("wrongDomainDigest").GetString(),
                digest);
            count++;
        }

        Assert.Equal(4, count);
    }

    [Fact]
    public void DocumentContextDigestRejectionsOmitTheDiagnosticObservation()
    {
        using JsonDocument fixture = LoadDocumentContextDigestFixture();
        int count = 0;
        foreach (JsonElement vector in fixture.RootElement
                     .GetProperty("rejected")
                     .EnumerateArray())
        {
            string raw = vector.GetProperty("raw").GetString() ??
                         throw new InvalidDataException(
                             "Digest rejection vector is missing raw JSON.");
            try
            {
                using JsonDocument payload = JsonDocument.Parse(raw);
                Assert.False(RbpDocumentContextObservation.TryCreate(
                    "snapshot",
                    "ready",
                    "rs-sensitive",
                    payload.RootElement,
                    sequence: 1,
                    out RbpDocumentContextObservation? observation));
                Assert.Null(observation);
            }
            catch (JsonException)
            {
                // Malformed JSON cannot produce a JsonElement, therefore it
                // cannot produce a document-context diagnostic observation.
            }

            count++;
        }

        Assert.Equal(3, count);
    }

    [Fact]
    public void DocumentContextDigestIsStableButObservationsRemainDistinctAndValueFree()
    {
        const string sensitiveTitle = "Confidential MEP Model";
        const string sensitiveDocumentId = "doc-secret-017";
        using JsonDocument payload = JsonDocument.Parse(
            $$"""
              {
                "title":"{{sensitiveTitle}}",
                "document_id":"{{sensitiveDocumentId}}",
                "revision":7
              }
              """);

        Assert.True(RbpDocumentContextObservation.TryCreate(
            "snapshot",
            "ready",
            "rs-sensitive",
            payload.RootElement,
            sequence: 7,
            out RbpDocumentContextObservation? first));
        Assert.True(RbpDocumentContextObservation.TryCreate(
            "queue",
            "not_queued",
            "rs-sensitive",
            payload.RootElement,
            sequence: 8,
            out RbpDocumentContextObservation? second));

        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.Equal(first.ContextDigest, second.ContextDigest);
        Assert.NotEqual(first, second);
        Assert.Matches("^[0-9a-f]{64}$", first.ContextDigest!);

        string transcript = JsonSerializer.Serialize(new[] { first, second });
        Assert.DoesNotContain(sensitiveTitle, transcript, StringComparison.Ordinal);
        Assert.DoesNotContain(
            sensitiveDocumentId,
            transcript,
            StringComparison.Ordinal);
        Assert.DoesNotContain("rs-sensitive", transcript, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CoordinatorPayloadObservationsFailClosedWithoutChangingWireOrAuthState()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8091, 1011));
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);
        await EventuallyAsync(() => harness.Observations.Count > 0);

        int wireBefore = harness.SentDocContextUpdates().Length;
        int callsBefore = harness.Channel.CallCount;
        int observationsBefore = harness.Observations.Count;
        using JsonDocument duplicate = JsonDocument.Parse(
            "{\"outer\":{\"same\":1,\"same\":2}}");

        foreach ((string Stage, string Outcome) in new[]
                 {
                     ("queue", "durably_queued"),
                     ("send", "sent"),
                     ("failure", "send_deferred"),
                 })
        {
            InvokeCoordinatorObservation(
                harness.Coordinator,
                Stage,
                Outcome,
                duplicate.RootElement,
                sequence: 41);
        }

        await Task.Delay(30);
        Assert.Equal(observationsBefore, harness.Observations.Count);
        Assert.Equal(wireBefore, harness.SentDocContextUpdates().Length);
        Assert.Equal(callsBefore, harness.Channel.CallCount);

        using JsonDocument valid = JsonDocument.Parse("{\"z\":2,\"a\":1}");
        InvokeCoordinatorObservation(
            harness.Coordinator,
            "queue",
            "durably_queued",
            valid.RootElement,
            sequence: 42,
            sourceRevision: 42,
            cacheIncarnationDigest:
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
        await EventuallyAsync(() => harness.Observations.Any(
            observation => observation.Stage == "queue" &&
                observation.Outcome == "durably_queued" &&
                observation.Sequence == 42));

        RbpDocumentContextObservation observed = harness.Observations.Single(
            observation => observation.Stage == "queue" &&
                observation.Outcome == "durably_queued" &&
                observation.Sequence == 42);
        Assert.Equal(
            RbpDocumentContextObservation.MakeContextDigest(valid.RootElement),
            observed.ContextDigest);
        Assert.NotNull(observed.ContextDigest);
        Assert.Equal(42, observed.SourceRevision);
        Assert.Equal(
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            observed.CacheIncarnationDigest);
        Assert.Equal(wireBefore, harness.SentDocContextUpdates().Length);
        Assert.Equal(callsBefore, harness.Channel.CallCount);
    }

    [Fact]
    public async Task WatcherCoordinatorLifecycleKeepsOneValidatedPairAndWireMetadataFree()
    {
        const string incarnation =
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8095, 1015),
            initialIncarnation: incarnation);
        await EventuallyAsync(() => harness.SentDocContextUpdates().Length == 1);
        await EventuallyAsync(() => harness.Observations.Any(
            observation => observation.Stage == "send" && observation.Outcome == "sent"));

        RbpEnvelope wire = Assert.Single(harness.SentDocContextUpdates());
        Assert.False(wire.Payload.TryGetProperty("cache_incarnation_digest", out _));
        Assert.DoesNotContain("cache_incarnation", wire.Payload.GetRawText(), StringComparison.Ordinal);

        RbpDocumentContextObservation[] lifecycle = harness.Observations
            .Where(observation =>
                (observation.Stage == "snapshot" && observation.Outcome == "ready") ||
                (observation.Stage == "queue" && observation.Outcome == "durably_queued") ||
                (observation.Stage == "send" && observation.Outcome == "sent"))
            .ToArray();
        Assert.Contains(lifecycle, observation =>
            observation.Stage == "snapshot" && observation.Sequence is null &&
            observation.SourceRevision == 1 &&
            observation.CacheIncarnationDigest == incarnation);
        Assert.Contains(lifecycle, observation =>
            observation.Stage == "queue" && observation.Sequence == wire.Sequence &&
            observation.SourceRevision == 1 &&
            observation.CacheIncarnationDigest == incarnation);
        Assert.Contains(lifecycle, observation =>
            observation.Stage == "send" && observation.Sequence == wire.Sequence &&
            observation.SourceRevision == 1 &&
            observation.CacheIncarnationDigest == incarnation);
    }

    [Fact]
    public async Task ConcurrentCoordinatorLifecyclePairsRemainSequenceBoundAndMalformedPairsAreSuppressed()
    {
        const string firstDigest =
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const string secondDigest =
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8096, 1016));
        await EventuallyAsync(() => harness.SentDocContextUpdates().Length == 1);
        int before = harness.Observations.Count;
        using JsonDocument first = JsonDocument.Parse("{\"item\":\"first\"}");
        using JsonDocument second = JsonDocument.Parse("{\"item\":\"second\"}");

        await Task.WhenAll(
            Task.Run(() => InvokeCoordinatorObservation(
                harness.Coordinator, "queue", "durably_queued", first.RootElement,
                51, 5, firstDigest)),
            Task.Run(() => InvokeCoordinatorObservation(
                harness.Coordinator, "failure", "send_deferred", first.RootElement,
                51, 5, firstDigest)),
            Task.Run(() => InvokeCoordinatorObservation(
                harness.Coordinator, "queue", "durably_queued", second.RootElement,
                52, 6, secondDigest)),
            Task.Run(() => InvokeCoordinatorObservation(
                harness.Coordinator, "send", "sent", second.RootElement,
                52, 6, secondDigest)),
            Task.Run(() => InvokeCoordinatorObservation(
                harness.Coordinator, "send", "sent", first.RootElement,
                53, 0, firstDigest)));

        await EventuallyAsync(() => harness.Observations.Count >= before + 4);
        RbpDocumentContextObservation[] observations = harness.Observations
            .Where(observation => observation.Sequence is 51 or 52 or 53)
            .ToArray();
        Assert.Contains(observations, observation => observation.Sequence == 51 &&
            observation.Stage == "failure" && observation.SourceRevision == 5 &&
            observation.CacheIncarnationDigest == firstDigest);
        Assert.Contains(observations, observation => observation.Sequence == 52 &&
            observation.Stage == "send" && observation.SourceRevision == 6 &&
            observation.CacheIncarnationDigest == secondDigest);
        Assert.DoesNotContain(observations, observation => observation.Sequence == 53);
    }

    [Fact]
    public async Task RegistrationTriggersImmediatePollAndEmitsUpdate()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8080, 1000));

        await EventuallyAsync(() => harness.Channel.CallCount == 1);
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);

        RbpEnvelope update =
            Assert.Single(harness.SentDocContextUpdates());
        Assert.Equal("doc_context_update", update.Type);
        Assert.Equal(RbpEnvelopeScope.Data, update.Scope);
        Assert.Equal("rs-8080", update.Rsid);
        Assert.Equal(1, update.Sequence);
        Assert.False(update.Payload.TryGetProperty("contextDigest", out _));
        JsonElement document = Assert.Single(
            update.Payload.GetProperty("documents").EnumerateArray());
        Assert.Equal(
            "doc-1",
            document.GetProperty("document_id").GetString());
        Assert.Equal(
            "Project A",
            document.GetProperty("title").GetString());
        Assert.Equal(
            JsonValueKind.Null,
            document.GetProperty("path_digest").ValueKind);
        Assert.Equal(
            "doc-1",
            update.Payload.GetProperty("active_document").GetString());
        Assert.Equal(
            "Level 2 HVAC",
            update.Payload
                .GetProperty("active_view")
                .GetProperty("name")
                .GetString());
        Assert.Equal(
            "mech",
            update.Payload.GetProperty("discipline_hint").GetString());
        Assert.True(harness.Channel.AllLeasesReleased);
    }

    [Fact]
    public async Task UnchangedSnapshotStaysSilentAtTheNextTick()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8081, 1001));
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);

        await AdvanceDocumentContextPollAsync(harness);
        await EventuallyAsync(() => harness.Channel.CallCount >= 2);
        await Task.Delay(30);

        Assert.Single(harness.SentDocContextUpdates());
    }

    [Fact]
    public async Task ProductionRevisionOnlyChurnWithAbsentIncarnationStaysSilent()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8093, 1013));
        await EventuallyAsync(() => harness.SentDocContextUpdates().Length == 1);

        harness.Channel.SetSnapshot(revision: 2, title: "Project A");
        await AdvanceDocumentContextPollAsync(harness);
        await EventuallyAsync(() => harness.Channel.CallCount >= 2);
        await Task.Delay(30);

        Assert.Single(harness.SentDocContextUpdates());
    }

    [Fact]
    public async Task SameFixtureIncarnationRevisionOnlyChurnStaysSilent()
    {
        const string incarnation =
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8094, 1014));
        await EventuallyAsync(() => harness.SentDocContextUpdates().Length == 1);

        harness.Channel.SetSnapshot(revision: 2, title: "Project A", incarnation);
        await AdvanceDocumentContextPollAsync(harness);
        await EventuallyAsync(() => harness.SentDocContextUpdates().Length == 2);

        harness.Channel.SetSnapshot(revision: 3, title: "Project A", incarnation);
        await AdvanceDocumentContextPollAsync(harness);
        await EventuallyAsync(() => harness.Channel.CallCount >= 3);
        await Task.Delay(30);

        Assert.Equal(2, harness.SentDocContextUpdates().Length);
    }

    [Fact]
    public async Task ChangedSnapshotEmitsExactlyOneUpdate()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8082, 1002));
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);

        harness.Channel.SetSnapshot(revision: 2, title: "Project B");
        await AdvanceDocumentContextPollAsync(harness);

        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 2);
        RbpEnvelope second = harness.SentDocContextUpdates()[1];
        Assert.Equal(2, second.Sequence);
        Assert.Equal(
            "Project B",
            Assert.Single(
                    second.Payload.GetProperty("documents").EnumerateArray())
                .GetProperty("title")
                .GetString());
    }

    [Fact]
    public async Task ChangedFixtureIncarnationWithSameRevisionAndPayloadEmitsFreshMetadataFreeUpdate()
    {
        const string incarnation =
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8092, 1021));
        await EventuallyAsync(() => harness.SentDocContextUpdates().Length == 1);
        RbpEnvelope first = harness.SentDocContextUpdates()[0];

        harness.Channel.SetSnapshot(revision: 1, title: "Project A", incarnation);
        await AdvanceDocumentContextPollAsync(harness);
        await EventuallyAsync(() => harness.SentDocContextUpdates().Length == 2);

        RbpEnvelope second = harness.SentDocContextUpdates()[1];
        Assert.Equal(first.Payload.GetRawText(), second.Payload.GetRawText());
        Assert.False(second.Payload.TryGetProperty("cache_incarnation_digest", out _));
        Assert.DoesNotContain("cache_incarnation", second.Payload.GetRawText(), StringComparison.Ordinal);
        Assert.Contains(harness.Observations, observation =>
            observation.Stage == "snapshot" &&
            observation.Outcome == "ready" &&
            observation.SourceRevision == 1 &&
            observation.CacheIncarnationDigest == incarnation);

        // Same process/cache incarnation on the next poll stays deduped.
        await AdvanceDocumentContextPollAsync(harness);
        await EventuallyAsync(() => harness.Channel.CallCount >= 3);
        await Task.Delay(30);
        Assert.Equal(2, harness.SentDocContextUpdates().Length);
    }

    [Fact]
    public async Task ResumeTriggersAnImmediatePollWithoutATick()
    {
        RbpLocalSessionSnapshot local = DocContextLocalSession(8083, 1003);
        await using var harness = await DocContextHarness.StartAsync(
            local,
            seedAsync: async store =>
                _ = await store.PersistRegisteredSessionAsync(
                    Registration(local, "rs-8083")));

        await EventuallyAsync(() => harness.Channel.CallCount == 1);
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);
        Assert.Contains(
            harness.Cycle.Sent,
            envelope => envelope.Type == "session_resume");
        Assert.DoesNotContain(
            harness.Cycle.Sent,
            envelope => envelope.Type == "session_register");
        Assert.Equal("rs-8083", harness.SentDocContextUpdates()[0].Rsid);
    }

    [Fact]
    public async Task CapabilityAbsentSessionIsNeverPolled()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(
                8084,
                1004,
                advertisesCachedContext: false));
        await EventuallyAsync(
            () => harness.Cycle.Sent.Any(
                envelope => envelope.Type == "session_register"));
        await EventuallyAsync(
            () => harness.Clock.HasOutstandingDelayDueIn(
                TimeSpan.FromSeconds(15)));

        harness.Clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            () => harness.Cycle.Sent.Any(
                envelope => envelope.Type == "heartbeat"));
        harness.Clock.Advance(TimeSpan.FromSeconds(15));
        await Task.Delay(30);

        Assert.Equal(0, harness.Channel.CallCount);
        Assert.Empty(harness.SentDocContextUpdates());
    }

    [Fact]
    public async Task AddinFailureEmitsNothingAndRetriesAtTheNextTick()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8085, 1005),
            failFirstPoll: true);

        await EventuallyAsync(() => harness.Channel.CallCount == 1);
        await Task.Delay(30);
        Assert.Equal(1, harness.Channel.CallCount);
        Assert.Empty(harness.SentDocContextUpdates());

        harness.Clock.Advance(TimeSpan.FromSeconds(15));

        await EventuallyAsync(() => harness.Channel.CallCount == 2);
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);
    }

    [Fact]
    public async Task RouteFailureIsObservedSeparatelyFromSnapshotNotReady()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8089, 1009),
            failFirstRoute: true);

        await EventuallyAsync(() => harness.Channel.CallCount == 1);
        await EventuallyAsync(() => harness.Observations.Any(
            observation => observation.Stage == "failure" &&
                observation.Outcome == "route_failure"));
        Assert.DoesNotContain(
            harness.Observations,
            observation => observation.Stage == "snapshot" &&
                observation.Outcome == "not_ready");
        Assert.Empty(harness.SentDocContextUpdates());
    }

    [Fact]
    public async Task SessionEndStopsTheWatcherCleanly()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8086, 1006));
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);

        harness.Catalog.Replace();
        harness.Clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            () => harness.Cycle.Sent.Any(
                envelope => envelope.Type == "session_unregister"));
        int settled = harness.Channel.CallCount;

        harness.Clock.Advance(TimeSpan.FromSeconds(15));
        harness.Clock.Advance(TimeSpan.FromSeconds(15));
        await Task.Delay(50);

        Assert.Equal(settled, harness.Channel.CallCount);
        Assert.Single(harness.SentDocContextUpdates());
    }

    [Fact]
    public async Task ImmediatePollAdmittedBeforeStopSettlesWithoutLateWireOrDiagnostic()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8088, 1008));
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);
        await EventuallyAsync(() => harness.Observations.Count > 0);
        int sentBefore = harness.SentDocContextUpdates().Length;
        int observationsBefore = harness.Observations.Count;
        ScriptedDocContextChannel.BlockingPoll blocked =
            harness.Channel.BlockNextPoll();
        harness.Channel.SetSnapshot(revision: 2, title: "Project stopped");

        Task? stop = null;
        try
        {
            harness.Clock.Advance(TimeSpan.FromSeconds(15));
            await blocked.Entered.WaitAsync(TimeSpan.FromSeconds(2));
            stop = harness.StopAsync();
            await Task.Delay(20);
            Assert.False(stop.IsCompleted);
        }
        finally
        {
            blocked.Release();
        }
        Assert.NotNull(stop);
        await stop.WaitAsync(TimeSpan.FromSeconds(2));
        await Task.Delay(20);

        Assert.Equal(sentBefore, harness.SentDocContextUpdates().Length);
        Assert.Equal(observationsBefore, harness.Observations.Count);
        Assert.True(harness.Channel.AllLeasesReleased);
    }

    [Fact]
    public async Task ReplacementWaitsForExactOldLoopBeforeFirstCandidatePoll()
    {
        var clock = new ManualCoordinatorClock();
        var channel = new ScriptedDocContextChannel();
        ScriptedDocContextChannel.BlockingPoll blocked =
            channel.BlockNextPoll();
        var watcher = new RbpDocContextWatcher(channel, clock);
        using var cycle = new CancellationTokenSource();
        const string rsid = "rs-watcher-replace";
        RbpDocContextEmit emit = (_, _, _) => Task.FromResult(false);

        watcher.BeginWatch(
            rsid, DocContextLocalSession(8100, 1100), emit, cycle.Token);
        try
        {
            await blocked.Entered.WaitAsync(TimeSpan.FromSeconds(2));
            RbpDocContextWatcher.PreparedWatch prepared = watcher.PrepareWatch(
                rsid,
                DocContextLocalSession(8101, 1101),
                emit,
                cycle.Token,
                attemptGeneration: 2);
            RbpDocContextWatcher.WatchCommitReceipt receipt =
                Assert.IsType<RbpDocContextWatcher.WatchCommitReceipt>(
                    prepared.Commit());
            Assert.True(receipt.TryReserveStart());
            receipt.Launch();

            await Task.Delay(20);
            Assert.Equal(1, channel.CallCount);
            blocked.Release();
            await EventuallyAsync(() => channel.CallCount == 2);
            Assert.True(watcher.IsWatching(rsid));
        }
        finally
        {
            blocked.Release();
            watcher.EndWatch(rsid);
            cycle.Cancel();
        }
    }

    [Fact]
    public async Task ReplacementAbortBeforeLaunchStartsNoCandidatePoll()
    {
        var clock = new ManualCoordinatorClock();
        var channel = new ScriptedDocContextChannel();
        ScriptedDocContextChannel.BlockingPoll blocked =
            channel.BlockNextPoll();
        var watcher = new RbpDocContextWatcher(channel, clock);
        using var cycle = new CancellationTokenSource();
        const string rsid = "rs-watcher-abort";
        RbpDocContextEmit emit = (_, _, _) => Task.FromResult(false);
        watcher.BeginWatch(
            rsid, DocContextLocalSession(8102, 1102), emit, cycle.Token);
        Task? aborted = null;
        try
        {
            await blocked.Entered.WaitAsync(TimeSpan.FromSeconds(2));
            RbpDocContextWatcher.PreparedWatch prepared = watcher.PrepareWatch(
                rsid,
                DocContextLocalSession(8103, 1103),
                emit,
                cycle.Token,
                attemptGeneration: 3);
            RbpDocContextWatcher.WatchCommitReceipt receipt =
                Assert.IsType<RbpDocContextWatcher.WatchCommitReceipt>(
                    prepared.Commit());
            Assert.True(receipt.TryReserveStart());
            aborted = receipt.Abort();
            blocked.Release();
            await aborted.WaitAsync(TimeSpan.FromSeconds(2));

            Assert.Equal(1, channel.CallCount);
            Assert.False(watcher.IsWatching(rsid));
        }
        finally
        {
            blocked.Release();
            if (aborted is not null)
            {
                try { await aborted.WaitAsync(TimeSpan.FromSeconds(2)); }
                catch { }
            }
            watcher.EndWatch(rsid);
            cycle.Cancel();
        }
    }

    [Fact]
    public async Task EmergencyBeforeWatcherCommitLeavesNoRegistryCallbackOrStart()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var channel = new ScriptedDocContextChannel();
        var observations = new ConcurrentQueue<RbpDocumentContextObservation>();
        var watcher = new RbpDocContextWatcher(
            channel,
            clock,
            onObservation: observation =>
            {
                observations.Enqueue(observation);
                return ValueTask.CompletedTask;
            });
        var cycle = new FakeConnectionCycle(_ => null);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(),
            clock,
            docContextWatcher: watcher);
        object context = CreateWatcherTestContext(
            coordinator, cycle, attemptStopState: 4, out Type contextType);
        try
        {
            InvokeStartDocContextWatch(
                coordinator,
                contextType,
                context,
                "rs-watch-emergency",
                DocContextLocalSession(8110, 1110));

            await Task.Delay(20);
            Assert.False(watcher.IsWatching("rs-watch-emergency"));
            Assert.Equal(0, channel.CallCount);
            Assert.Empty(observations);
        }
        finally
        {
            DisposeWatcherTestContext(coordinator, contextType, context);
            watcher.EndWatch("rs-watch-emergency");
        }
    }

    [Fact]
    public async Task WatcherStartCallbackCanReenterEmergencyAbortWithoutPoll()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var channel = new ScriptedDocContextChannel();
        object? context = null;
        Type? contextType = null;
        var reentered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var watcher = new RbpDocContextWatcher(
            channel,
            clock,
            onObservation: observation =>
            {
                if (observation.Stage == "probe" &&
                    observation.Outcome == "started" &&
                    context is not null && contextType is not null)
                {
                    RequiredContextMethod(
                            contextType, "AbortPreparedWatches")
                        .Invoke(context, null);
                    reentered.TrySetResult();
                }
                return ValueTask.CompletedTask;
            });
        var cycle = new FakeConnectionCycle(_ => null);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(),
            clock,
            docContextWatcher: watcher);
        context = CreateWatcherTestContext(
            coordinator, cycle, attemptStopState: 2, out contextType);
        try
        {
            InvokeStartDocContextWatch(
                coordinator,
                contextType,
                context,
                "rs-watch-reentrant",
                DocContextLocalSession(8111, 1111));
            await reentered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            await Task.Delay(20);

            Assert.False(watcher.IsWatching("rs-watch-reentrant"));
            Assert.Equal(0, channel.CallCount);
        }
        finally
        {
            DisposeWatcherTestContext(coordinator, contextType, context);
            watcher.EndWatch("rs-watch-reentrant");
        }
    }

    [Fact]
    public void StalePreparedWatcherVersionFailsWithoutMutationOrCallback()
    {
        var channel = new ScriptedDocContextChannel();
        var observations = new ConcurrentQueue<RbpDocumentContextObservation>();
        var watcher = new RbpDocContextWatcher(
            channel,
            onObservation: observation =>
            {
                observations.Enqueue(observation);
                return ValueTask.CompletedTask;
            });
        using var cycle = new CancellationTokenSource();
        RbpDocContextWatcher.PreparedWatch prepared = watcher.PrepareWatch(
            "rs-watch-stale",
            DocContextLocalSession(8112, 1112),
            (_, _, _) => Task.FromResult(false),
            cycle.Token,
            attemptGeneration: 1);

        watcher.EndWatch("rs-unrelated-version-change");
        Assert.Null(prepared.Commit());
        Assert.False(watcher.IsWatching("rs-watch-stale"));
        Assert.Equal(0, channel.CallCount);
        Assert.Empty(observations);
    }

    [Fact]
    public async Task WatchReservationIsSinglePerRsidAndEveryAbortReleasesIt()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var cycle = new FakeConnectionCycle(_ => null);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(),
            clock);
        object context = CreateWatcherTestContext(
            coordinator, cycle, attemptStopState: 2, out Type contextType);
        MethodInfo reserve = RequiredContextMethod(
            contextType, "TryReservePreparedWatch");
        MethodInfo abort = RequiredContextMethod(
            contextType, "AbortPreparedWatchReservation");
        try
        {
            Assert.True((bool)reserve.Invoke(
                context, new object[] { "rs-watch-bounded" })!);
            Assert.False((bool)reserve.Invoke(
                context, new object[] { "rs-watch-bounded" })!);
            Assert.Equal(1, WatchReservationCount(contextType, context));
            abort.Invoke(context, new object[] { "rs-watch-bounded" });
            Assert.Equal(0, WatchReservationCount(contextType, context));
            Assert.True((bool)reserve.Invoke(
                context, new object[] { "rs-watch-bounded" })!);
            abort.Invoke(context, new object[] { "rs-watch-bounded" });
            Assert.Equal(0, WatchReservationCount(contextType, context));
        }
        finally
        {
            abort.Invoke(context, new object[] { "rs-watch-bounded" });
            DisposeWatcherTestContext(coordinator, contextType, context);
        }
    }

    [Fact]
    public async Task WatcherRoutesOnlyTheCachedDocumentContextMethod()
    {
        await using var harness = await DocContextHarness.StartAsync(
            DocContextLocalSession(8087, 1007));
        await EventuallyAsync(
            () => harness.SentDocContextUpdates().Length == 1);
        harness.Channel.SetSnapshot(revision: 2, title: "Project C");
        await AdvanceDocumentContextPollAsync(harness);
        await EventuallyAsync(() => harness.Channel.CallCount >= 2);

        string[] methods = harness.Channel.Methods;
        Assert.NotEmpty(methods);
        Assert.All(
            methods,
            method => Assert.Equal("get_document_context", method));
        Assert.DoesNotContain("get_current_view_info", methods);
        Assert.DoesNotContain("list_open_views", methods);
    }

    private static async Task AdvanceDocumentContextPollAsync(
        DocContextHarness harness)
    {
        await EventuallyAsync(() =>
            harness.Clock.OutstandingDelayCountDueIn(
                TimeSpan.FromSeconds(15)) >= 2);
        harness.Clock.Advance(TimeSpan.FromSeconds(15));
    }

    private static RbpLocalSessionSnapshot DocContextLocalSession(
        int port,
        int processId,
        bool advertisesCachedContext = true)
    {
        string capabilities = advertisesCachedContext
            ? "\"doc_context_cached_v1\""
            : string.Empty;
        string localKey = $"port:{port}:pid:{processId}:started:100";
        return new RbpLocalSessionSnapshot(
            localKey,
            Json(
                $$"""
                {
                  "local_session_key":"{{localKey}}",
                  "user_hint":{"name":"BT"},
                  "machine":{
                    "hostname":"WS01",
                    "fingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                  },
                  "revit":{
                    "version":"2024",
                    "build":"24.1",
                    "pid":{{processId}}
                  },
                  "addin_version":"2026.07.26.0",
                  "result_contract_version":2,
                  "session_capabilities":[{{capabilities}}],
                  "bridge_version":"0.1.0",
                  "documents":[],
                  "port":{{port}}
                }
                """),
            port,
            Json("""{"active_task":null,"addin_reachable":true}"""));
    }

    private static JsonDocument LoadDocumentContextDigestFixture()
    {
        string path = Path.Combine(
            RbpFixtureReader.FindRepositoryRoot(),
            "packages",
            "bridge",
            "tests",
            "RevAgent.Bridge.Tests",
            "Gateway",
            "Connection",
            "Fixtures",
            "doc-context-digest.json");
        return JsonDocument.Parse(File.ReadAllBytes(path));
    }

    private static void InvokeCoordinatorObservation(
        RbpConnectionCoordinator coordinator,
        string stage,
        string outcome,
        JsonElement payload,
        long sequence,
        long? sourceRevision = null,
        string? cacheIncarnationDigest = null)
    {
        MethodInfo method = typeof(RbpConnectionCoordinator).GetMethod(
            "ObserveDocumentContext",
            BindingFlags.Instance | BindingFlags.NonPublic) ??
            throw new MissingMethodException(
                nameof(RbpConnectionCoordinator),
                "ObserveDocumentContext");
        _ = method.Invoke(
            coordinator,
            new object?[]
            {
                stage,
                outcome,
                "rs-8091",
                payload,
                sequence,
                sourceRevision is { } revision && cacheIncarnationDigest is { } digest
                    ? new RbpDocumentContextDiagnosticPair(revision, digest)
                    : null,
            });
    }

    private static object CreateWatcherTestContext(
        RbpConnectionCoordinator coordinator,
        IRbpConnectionCycle cycle,
        int attemptStopState,
        out Type contextType)
    {
        contextType = typeof(RbpConnectionCoordinator).GetNestedType(
            "ConnectionCycleContext", BindingFlags.NonPublic) ??
            throw new MissingMemberException("ConnectionCycleContext");
        ConstructorInfo constructor = Assert.Single(
            contextType.GetConstructors(
                BindingFlags.Instance | BindingFlags.NonPublic));
        object context = constructor.Invoke(new object[]
        {
            coordinator,
            cycle,
            1L,
            Array.Empty<string>(),
            CancellationToken.None,
        });
        typeof(RbpConnectionCoordinator).GetField(
                "_active", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(coordinator, context);
        typeof(RbpConnectionCoordinator).GetField(
                "_connectionGeneration",
                BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(coordinator, 1L);
        typeof(RbpConnectionCoordinator).GetField(
                "_attemptStopState",
                BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(coordinator, attemptStopState);
        return context;
    }

    private static void DisposeWatcherTestContext(
        RbpConnectionCoordinator coordinator,
        Type contextType,
        object context)
    {
        typeof(RbpConnectionCoordinator).GetField(
                "_active", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(coordinator, null);
        RequiredContextMethod(contextType, "AbortPreparedWatches")
            .Invoke(context, null);
        contextType.GetMethod(
                "Dispose",
                BindingFlags.Instance | BindingFlags.Public |
                BindingFlags.NonPublic)!
            .Invoke(context, null);
    }

    private static void InvokeStartDocContextWatch(
        RbpConnectionCoordinator coordinator,
        Type contextType,
        object context,
        string rsid,
        RbpLocalSessionSnapshot local)
    {
        MethodInfo method = typeof(RbpConnectionCoordinator).GetMethod(
            "StartDocContextWatch",
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null,
            types: new[]
            {
                contextType,
                typeof(string),
                typeof(RbpLocalSessionSnapshot),
            },
            modifiers: null) ??
            throw new MissingMethodException("StartDocContextWatch");
        method.Invoke(coordinator, new object[] { context, rsid, local });
    }

    private static int WatchReservationCount(Type contextType, object context)
    {
        object reservations = contextType.GetField(
                                  "_watchReservations",
                                  BindingFlags.Instance |
                                  BindingFlags.NonPublic)?.GetValue(context) ??
                              throw new MissingFieldException(
                                  "_watchReservations");
        return (int)(reservations.GetType().GetProperty("Count")?
                         .GetValue(reservations) ??
                     throw new MissingMemberException(
                         "Watch reservation count"));
    }

    /// <summary>
    /// A scripted stand-in for the routed add-in invocation channel. It
    /// records every routed method name so the tests can prove the frozen
    /// Section 14 prohibition: only <c>get_document_context</c> is ever
    /// dispatched, never a <c>get_current_view_info</c> plus
    /// <c>list_open_views</c> composition.
    /// </summary>
    private sealed class ScriptedDocContextChannel : IRbpInvocationChannel
    {
        private readonly ConcurrentQueue<string> _methods = new();
        private readonly ConcurrentQueue<RecordingLease> _leases = new();
        private int _callCount;
        private int _failNextPolls;
        private int _failNextRoutes;
        private BlockingPoll? _nextBlockingPoll;
        private long _revision = 1;
        private string _title = "Project A";
        private string? _incarnation;

        internal int CallCount => Volatile.Read(ref _callCount);

        internal string[] Methods => _methods.ToArray();

        internal bool AllLeasesReleased =>
            _leases.All(lease => lease.Released);

        internal void FailNextPoll() =>
            Interlocked.Increment(ref _failNextPolls);

        internal void FailNextRoute() =>
            Interlocked.Increment(ref _failNextRoutes);

        internal BlockingPoll BlockNextPoll()
        {
            var block = new BlockingPoll();
            if (Interlocked.CompareExchange(
                    ref _nextBlockingPoll, block, comparand: null) is not null)
                throw new InvalidOperationException(
                    "A scripted document-context poll is already blocked.");
            return block;
        }

        internal void SetSnapshot(long revision, string title, string? incarnation = null)
        {
            lock (_methods)
            {
                _revision = revision;
                _title = title;
                _incarnation = incarnation;
            }
        }

        public Task<RbpAddinOutcome> InvokeAsync(
            string rsid,
            AddinCall call,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _methods.Enqueue(call.Method);
            Interlocked.Increment(ref _callCount);
            if (Interlocked.CompareExchange(ref _failNextRoutes, 0, 0) > 0)
            {
                Interlocked.Decrement(ref _failNextRoutes);
                return Task.FromResult(
                    new RbpAddinOutcome(
                        RbpAddinOutcomeKind.KnownNotDispatched,
                        default,
                        Array.Empty<byte>(),
                        RequestBytes: 0,
                        ResponseBytes: 0,
                        FaultClass: "addin_unreachable",
                        Message: "routed session unavailable",
                        RouteFailure: true));
            }

            if (Interlocked.CompareExchange(ref _failNextPolls, 0, 0) > 0)
            {
                Interlocked.Decrement(ref _failNextPolls);
                return Task.FromResult(
                    new RbpAddinOutcome(
                        RbpAddinOutcomeKind.KnownNotDispatched,
                        default,
                        Array.Empty<byte>(),
                        RequestBytes: 0,
                        ResponseBytes: 0,
                        FaultClass: "addin_unreachable",
                        Message: "The scripted add-in session is offline."));
            }

            long revision;
            string title;
            string? incarnation;
            lock (_methods)
            {
                revision = _revision;
                title = _title;
                incarnation = _incarnation;
            }

            var lease = new RecordingLease();
            _leases.Enqueue(lease);
            RbpAddinOutcome outcome =
                DocContextOutcome(call, revision, title, incarnation, lease);
            BlockingPoll? blocked = Interlocked.Exchange(
                ref _nextBlockingPoll, null);
            if (blocked is null) return Task.FromResult(outcome);
            return blocked.CompleteAsync(outcome);
        }

        private static RbpAddinOutcome DocContextOutcome(
            AddinCall call,
            long revision,
            string title,
            string? incarnation,
            IRbpDispatchLease lease)
        {
            string incarnationProperty = incarnation == null
                ? string.Empty
                : ",\"cache_incarnation_digest\":\"" + incarnation + "\"";
            string result =
                $$"""
                {
                  "resultContractVersion":2,
                  "documentContextContractVersion":1,
                  "capturedAtUtc":"2026-07-26T10:00:00.000Z",
                  "revision":{{revision}},
                  "cacheState":"ready",
                  "unavailableReason":null,
                  "documents":[
                    {
                      "documentId":"doc-1",
                      "title":"{{title}}",
                      "pathDigest":null,
                      "isWorkshared":false,
                      "isActive":true
                    }
                  ],
                  "activeDocumentId":"doc-1",
                  "activeView":{
                    "documentId":"doc-1",
                    "id":"123",
                    "name":"Level 2 HVAC",
                    "type":"FloorPlan",
                    "level":"Level 2"
                  },
                  "disciplineHint":"mech"{{incarnationProperty}}
                }
                """;
            byte[] raw = Encoding.UTF8.GetBytes(
                $$"""
                {"jsonrpc":"2.0","id":"{{call.InvocationId}}","result":{{result}}}
                """.Trim());
            using JsonDocument document = JsonDocument.Parse(result);
            return new RbpAddinOutcome(
                RbpAddinOutcomeKind.Completed,
                document.RootElement.Clone(),
                raw,
                RequestBytes: 64,
                ResponseBytes: raw.Length,
                Lease: lease);
        }

        private sealed class RecordingLease : IRbpDispatchLease
        {
            private int _released;

            internal bool Released => Volatile.Read(ref _released) != 0;

            public void ReleaseAfterDurableDecision() =>
                Interlocked.Exchange(ref _released, 1);
        }

        internal sealed class BlockingPoll
        {
            private readonly TaskCompletionSource _entered = new(
                TaskCreationOptions.RunContinuationsAsynchronously);
            private readonly TaskCompletionSource _release = new(
                TaskCreationOptions.RunContinuationsAsynchronously);

            internal Task Entered => _entered.Task;
            internal void Release() => _release.TrySetResult();

            internal async Task<RbpAddinOutcome> CompleteAsync(
                RbpAddinOutcome outcome)
            {
                _entered.TrySetResult();
                await _release.Task.ConfigureAwait(false);
                return outcome;
            }
        }
    }

    private sealed class DocContextHarness : IAsyncDisposable
    {
        private readonly RbpJournalTestDirectory _directory;
        private readonly RbpJournalStore _store;
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _run;
        private int _stopped;

        private DocContextHarness(
            RbpJournalTestDirectory directory,
            RbpJournalStore store,
            ManualCoordinatorClock clock,
            MutableSessionCatalog catalog,
            FakeConnectionCycle cycle,
            ScriptedDocContextChannel channel,
            ConcurrentQueue<RbpDocumentContextObservation> observations,
            RbpConnectionCoordinator coordinator)
        {
            _directory = directory;
            _store = store;
            Clock = clock;
            Catalog = catalog;
            Cycle = cycle;
            Channel = channel;
            Observations = observations;
            Coordinator = coordinator;
            _run = coordinator.RunAsync(_stop.Token);
        }

        internal ManualCoordinatorClock Clock { get; }

        internal MutableSessionCatalog Catalog { get; }

        internal FakeConnectionCycle Cycle { get; }

        internal ScriptedDocContextChannel Channel { get; }

        internal ConcurrentQueue<RbpDocumentContextObservation> Observations { get; }

        internal RbpConnectionCoordinator Coordinator { get; }

        internal RbpEnvelope[] SentDocContextUpdates() =>
            Cycle.Sent
                .Where(envelope => envelope.Type == "doc_context_update")
                .ToArray();

        internal async Task StopAsync()
        {
            if (Interlocked.Exchange(ref _stopped, 1) == 0)
            {
                Task<RbpCoordinatorTeardownResult> teardown =
                    Coordinator.RequestStopTeardown();
                _stop.Cancel();
                _ = await teardown.ConfigureAwait(false);
            }
            await _run.ConfigureAwait(false);
        }

        internal static async Task<DocContextHarness> StartAsync(
            RbpLocalSessionSnapshot local,
            bool failFirstPoll = false,
            bool failFirstRoute = false,
            Func<RbpJournalStore, Task>? seedAsync = null,
            string? initialIncarnation = null)
        {
            var directory = new RbpJournalTestDirectory();
            var clock = new ManualCoordinatorClock();
            RbpJournalStore store = OpenStore(directory, clock);
            if (seedAsync is not null)
            {
                await seedAsync(store);
            }

            var channel = new ScriptedDocContextChannel();
            if (initialIncarnation is not null)
            {
                channel.SetSnapshot(1, "Project A", initialIncarnation);
            }
            if (failFirstPoll)
            {
                channel.FailNextPoll();
            }
            if (failFirstRoute)
            {
                channel.FailNextRoute();
            }

            var responder = new ScriptedGatewayResponder(clock);
            var cycle = new FakeConnectionCycle(responder.Respond);
            var catalog = new MutableSessionCatalog(local);
            var observations = new ConcurrentQueue<RbpDocumentContextObservation>();
            var watcher = new RbpDocContextWatcher(
                channel,
                clock,
                onObservation: observation =>
                {
                    observations.Enqueue(observation);
                    return ValueTask.CompletedTask;
                });
            var coordinator = new RbpConnectionCoordinator(
                new FakeConnectionCycleFactory(cycle),
                store,
                catalog,
                new RbpConnectionCoordinatorOptions(
                    new Uri("wss://gateway.revagent.app/bridge/v1"),
                    new RbpHelloProfile(
                        "0.1.0",
                        "WS01",
                        "Windows 11",
                        new[] { "2026.07.26.0" })),
                new StubInvocationDispatcher(),
                inboundJournal: null,
                clock,
                new FixedRandomSource(0),
                watcher,
                onDocumentContextObservation: observation =>
                {
                    observations.Enqueue(observation);
                    return ValueTask.CompletedTask;
                });
            return new DocContextHarness(
                directory,
                store,
                clock,
                catalog,
                cycle,
                channel,
                observations,
                coordinator);
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                await StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
            }
            catch (TimeoutException)
            {
            }
            catch (OperationCanceledException)
            {
            }

            _stop.Dispose();
            await _store.DisposeAsync();
            _directory.Dispose();
        }
    }

    /// <summary>Test-only fresh-reader seam; it has no routed-channel fallback.</summary>
    private sealed class ScriptedFreshResumeProofReader :
        IRbpFreshResumeProofContextReader
    {
        private RbpFreshDocumentContext? _current;

        internal int CallCount { get; private set; }

        internal ScriptedFreshResumeProofReader() => SetSnapshot(
            1,
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

        internal void SetSnapshot(long revision, string incarnation)
        {
            if (!RbpDocumentContextDiagnosticPair.TryCreate(
                    revision, incarnation,
                    out RbpDocumentContextDiagnosticPair? freshness))
            {
                _current = null;
                return;
            }

            using JsonDocument document = JsonDocument.Parse("""
                {"documents":[],"active_document":null,"active_view":null}
                """);
            _current = new RbpFreshDocumentContext(
                document.RootElement.Clone(), freshness!);
        }

        public Task<RbpFreshDocumentContext?> ReadAsync(
            string rsid,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Assert.False(string.IsNullOrEmpty(rsid));
            CallCount++;
            return Task.FromResult(_current);
        }
    }
}
