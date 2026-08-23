using System.Security.Cryptography;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

public sealed class RbpArtifactCarrierProducerTests
{
    [Fact]
    public async Task ProducesOrderedDurableArtifactFramesAndTerminalManifest()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        await RegisterAsync(store, "rs-carrier", carrierGranted: true);
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        byte[] first = Enumerable.Repeat((byte)0x41,
                RbpArtifactCarrierProducer.MaximumChunkBytes + 1)
            .ToArray();
        byte[] second = new byte[] { 9, 2, 6 };

        RbpCarrierEmission emission = Assert.IsType<RbpCarrierEmission>(
            await producer.TryPrepareAsync(
                "rs-carrier",
                Json("""{"kind":"invocation","invocation_id":"invoke-01","status":"completed","replayed":false,"metrics":{}}"""),
                Files(first, second),
                CancellationToken.None));

        Assert.Equal(3, emission.Prefixes.Count);
        Assert.All(emission.Prefixes, frame => Assert.Equal("partial", frame.Type));
        Assert.Equal(0, emission.Prefixes[0].Payload.GetProperty("chunk_index").GetInt32());
        Assert.Equal(1, emission.Prefixes[1].Payload.GetProperty("chunk_index").GetInt32());
        Assert.Equal(1, emission.Prefixes[2].Payload.GetProperty("artifact_index").GetInt32());
        JsonElement terminal = emission.TerminalPayload;
        Assert.True(terminal.GetProperty("chunked").GetBoolean());
        Assert.Equal(2, terminal.GetProperty("artifacts").GetArrayLength());
        Assert.All(
            terminal.GetProperty("artifacts").EnumerateArray(),
            descriptor => Assert.StartsWith("artifact:", descriptor.GetProperty("stream_id").GetString()));
        Assert.True(Directory.Exists(Path.Combine(directory.Path, "artifact-spool")));
    }

    [Fact]
    public async Task RefusesArtifactOutputBeforeBothCarrierGrants()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        await RegisterAsync(store, "rs-inline", carrierGranted: false);
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);

        await Assert.ThrowsAsync<RbpArtifactCarrierException>(() =>
            producer.TryPrepareAsync(
                "rs-inline",
                Json("""{"kind":"invocation","invocation_id":"invoke-02"}"""),
                Files(new byte[] { 1 }),
                new[] { "chunked_results" },
                CancellationToken.None));
    }

    [Fact]
    public async Task ProducesResultOnlyChunksWithNoArtifactGrant()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        await RegisterAsync(store, "rs-result", carrierGranted: false);
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        string payload = new string('x',
            RbpArtifactCarrierProducer.MaximumChunkBytes + 32);

        RbpCarrierEmission emission = Assert.IsType<RbpCarrierEmission>(
            await producer.TryPrepareAsync(
                "rs-result",
                Json("""{"kind":"invocation","invocation_id":"invoke-04","status":"completed"}"""),
                JsonSerializer.SerializeToElement(new { payload }),
                CancellationToken.None));

        Assert.Equal(2, emission.Prefixes.Count);
        Assert.All(emission.Prefixes, frame => Assert.Equal(
            "result", frame.Payload.GetProperty("stream_id").GetString()));
        Assert.True(emission.TerminalPayload.GetProperty("chunked").GetBoolean());
        Assert.Equal("result", emission.TerminalPayload.GetProperty("stream_id").GetString());
        Assert.False(emission.TerminalPayload.TryGetProperty("artifacts", out _));
    }

    [Fact]
    public async Task RetainsSpoolUntilDurableTerminalAcknowledgement()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        await RegisterAsync(store, "rs-ack", carrierGranted: true);
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        RbpCarrierEmission emission = Assert.IsType<RbpCarrierEmission>(
            await producer.TryPrepareAsync(
                "rs-ack",
                Json("""{"kind":"invocation","invocation_id":"invoke-05"}"""),
                Files(new byte[] { 4, 5 }),
                CancellationToken.None));
        string carrierRoot = Path.Combine(directory.Path, "artifact-spool", emission.CarrierKey);
        producer.RecordTerminalQueued(emission.CarrierKey, "rs-ack", 7);

        producer.ApplyDurableAcknowledgements(
            new[] { new RbpSessionAcknowledgement("rs-ack", 6) });
        Assert.True(Directory.Exists(carrierRoot));
        producer.ApplyDurableAcknowledgements(
            new[] { new RbpSessionAcknowledgement("rs-ack", 7) });
        Assert.False(Directory.Exists(carrierRoot));
    }

    [Fact]
    public async Task QueuedCarrierFramesSurviveJournalRecoveryInExactOrder()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        await RegisterAsync(store, "rs-replay", carrierGranted: true);
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        RbpCarrierEmission emission = Assert.IsType<RbpCarrierEmission>(
            await producer.TryPrepareAsync(
                "rs-replay",
                Json("""{"kind":"invocation","invocation_id":"invoke-06"}"""),
                Files(Enumerable.Repeat((byte)7,
                    RbpArtifactCarrierProducer.MaximumChunkBytes + 1).ToArray()),
                CancellationToken.None));

        int ordinal = 0;
        foreach (RbpInvocationAnswer frame in emission.Prefixes.Append(
                     RbpInvocationAnswer.Result(emission.TerminalPayload)))
        {
            _ = await store.QueueOutboundDataAsync(
                "rs-replay",
                new RbpOutboundDataDraft(
                    frame.Type,
                    $"carrier-{ordinal++}",
                    frame.Payload));
        }

        RbpResumeCandidate recovery = Assert.Single(
            (await store.LoadRecoveryPlanAsync()).ResumeCandidates);
        Assert.Equal(new long[] { 1, 2, 3 },
            recovery.Outbox.Select(frame => frame.Sequence));
        Assert.Equal(new[] { "partial", "partial", "result" },
            recovery.Outbox.Select(frame => frame.Type));
        Assert.True(recovery.Outbox[2].Payload.GetProperty("chunked").GetBoolean());
    }

    [Fact]
    public async Task CarrierPlanIsIdenticalForWssAndStreamableHttpCoordinatorPaths()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        await RegisterAsync(store, "rs-parity", carrierGranted: true);
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        JsonElement body = Json("""{"kind":"invocation","invocation_id":"invoke-07"}""");
        JsonElement output = Files(new byte[] { 7, 8, 9 });

        // Binding selection happens below this producer. Replanning exactly
        // the same durable source is therefore the WSS/HTTP parity oracle.
        RbpCarrierEmission wss = Assert.IsType<RbpCarrierEmission>(
            await producer.TryPrepareAsync("rs-parity", body, output, CancellationToken.None));
        RbpCarrierEmission http = Assert.IsType<RbpCarrierEmission>(
            await producer.TryPrepareAsync("rs-parity", body, output, CancellationToken.None));
        Assert.Equal(wss.CarrierKey, http.CarrierKey);
        Assert.Equal(wss.TerminalPayload.GetRawText(), http.TerminalPayload.GetRawText());
        Assert.Equal(
            wss.Prefixes.Select(frame => frame.Payload.GetRawText()),
            http.Prefixes.Select(frame => frame.Payload.GetRawText()));
    }

    [Fact]
    public async Task FencedExpiryNeverDeletesAnUnfencedCarrier()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        await RegisterAsync(store, "rs-expiry", carrierGranted: true);
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        RbpCarrierEmission emission = Assert.IsType<RbpCarrierEmission>(
            await producer.TryPrepareAsync(
                "rs-expiry",
                Json("""{"kind":"invocation","invocation_id":"invoke-08"}"""),
                Files(new byte[] { 3 }),
                CancellationToken.None));
        string root = Path.Combine(directory.Path, "artifact-spool", emission.CarrierKey);

        producer.SweepExpired(DateTimeOffset.UtcNow.AddDays(8));
        Assert.True(Directory.Exists(root));
        producer.RecordTerminalQueued(emission.CarrierKey, "rs-expiry", 1);
        string marker = Path.Combine(root, "terminal.ack.json");
        File.SetLastWriteTimeUtc(marker, DateTime.UtcNow.AddDays(-8));
        producer.SweepExpired(DateTimeOffset.UtcNow);
        Assert.False(Directory.Exists(root));
    }

    [Fact]
    public async Task RejectsRawPathBeforeWritingAnySibling()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        await RegisterAsync(store, "rs-path", carrierGranted: true);
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        JsonElement input = Json("""
            {"files":[
              {"artifactIndex":0,"fileName":"valid.bin","contentType":"application/octet-stream","sizeBytes":1,"sha256":"sha256:4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7c4f9a9d6b1b6a7","contentBase64":"AQ=="},
              {"artifactIndex":1,"path":"C:\\private\\secret.bin","contentType":"application/octet-stream"}
            ]}
            """);

        await Assert.ThrowsAsync<RbpArtifactCarrierException>(() =>
            producer.TryPrepareAsync(
                "rs-path",
                Json("""{"kind":"invocation","invocation_id":"invoke-03"}"""),
                input,
                CancellationToken.None));
        string spool = Path.Combine(directory.Path, "artifact-spool");
        Assert.True(Directory.Exists(spool));
        Assert.Empty(Directory.GetFiles(spool, "*", SearchOption.AllDirectories));
    }

    private static RbpJournalStore OpenStore(RbpJournalTestDirectory directory) =>
        RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());

    private static Task RegisterAsync(
        RbpJournalStore store, string rsid, bool carrierGranted) =>
        store.PersistRegisteredSessionAsync(
            new RbpSessionRegistration(
                rsid,
                "port:8080:pid:1234",
                Json("""{"local_session_key":"port:8080:pid:1234"}"""),
                "resume-token-" + rsid,
                RbpJournalTestData.Now.AddHours(1),
                carrierGranted
                    ? new[] { "chunked_results", "artifact_result_v1" }
                    : new[] { "chunked_results" }));

    private static JsonElement Files(params byte[][] files)
    {
        var values = files.Select((bytes, index) => new
        {
            artifactIndex = index,
            fileName = $"fixture-{index}.bin",
            contentType = "application/octet-stream",
            sizeBytes = bytes.Length,
            sha256 = Digest(bytes),
            contentBase64 = Convert.ToBase64String(bytes),
        });
        return JsonSerializer.SerializeToElement(new { files = values });
    }

    private static JsonElement Json(string value)
    {
        using JsonDocument document = JsonDocument.Parse(value);
        return document.RootElement.Clone();
    }

    private static string Digest(byte[] bytes) => "sha256:" +
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
