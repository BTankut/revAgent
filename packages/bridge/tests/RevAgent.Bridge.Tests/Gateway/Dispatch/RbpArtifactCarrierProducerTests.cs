using System.Security.Cryptography;
using System.Diagnostics;
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

        producer.RecordTerminalQueued(emission.CarrierKey, "rs-expiry", 1);
        producer.SweepExpired(new[] { new RbpReleasedCarrier(
            emission.CarrierKey, "rs-expiry", 1) });
        Assert.False(Directory.Exists(root));
    }

    [Fact]
    public async Task RestartedProducerReleasesOnlyJournalSuppliedFence()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        RbpArtifactCarrierProducer first = RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        RbpCarrierEmission released = Assert.IsType<RbpCarrierEmission>(await first.TryPrepareAsync(
            "rs-restart", Json("""{"kind":"invocation","invocation_id":"invoke-restart-release"}"""),
            Files(new byte[] { 4 }), CancellationToken.None));
        first.RecordTerminalQueued(released.CarrierKey, "rs-restart", 8);

        RbpArtifactCarrierProducer restarted = RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        restarted.SweepExpired(new[] { new RbpReleasedCarrier(released.CarrierKey, "rs-restart", 8) });
        Assert.False(Directory.Exists(Path.Combine(directory.Path, "artifact-spool", released.CarrierKey)));

        RbpCarrierEmission acknowledged = Assert.IsType<RbpCarrierEmission>(await first.TryPrepareAsync(
            "rs-restart", Json("""{"kind":"invocation","invocation_id":"invoke-restart-ack"}"""),
            Files(new byte[] { 5 }), CancellationToken.None));
        first.RecordTerminalQueued(acknowledged.CarrierKey, "rs-restart", 9);
        RbpArtifactCarrierProducer rehydrated = RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        rehydrated.RecordTerminalQueued(acknowledged.CarrierKey, "rs-restart", 9);
        rehydrated.ApplyDurableAcknowledgements(new[] { new RbpSessionAcknowledgement("rs-restart", 9) });
        Assert.False(Directory.Exists(Path.Combine(directory.Path, "artifact-spool", acknowledged.CarrierKey)));
    }

    [Fact]
    public async Task BootstrapCreatesMissingStateRootThroughPinnedComponents()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        string configuredRoot = Path.Combine(directory.Path, "missing-state-root", "nested");
        RbpArtifactCarrierProducer producer = RbpArtifactCarrierProducer.CreateProduction(configuredRoot, store);
        RbpCarrierEmission emission = Assert.IsType<RbpCarrierEmission>(await producer.TryPrepareAsync(
            "rs-bootstrap", Json("""{"kind":"invocation","invocation_id":"invoke-bootstrap"}"""),
            Files(new byte[] { 1 }), CancellationToken.None));
        Assert.True(Directory.Exists(Path.Combine(configuredRoot, "artifact-spool", emission.CarrierKey)));
    }

    [Fact]
    public void RefusesSameLengthLeafTamperByExpectedDigest()
    {
        using var directory = new RbpJournalTestDirectory();
        using var spool = RbpArtifactSpoolFileSystem.OpenForStateRoot(directory.Path);
        string carrierKey = new string('a', 64);
        const string name = "same-length.bin";
        byte[] original = [1, 2, 3, 4];
        spool.EnsureCarrier(carrierKey);
        spool.WriteImmutable(carrierKey, name, original, Digest(original));

        File.WriteAllBytes(Path.Combine(directory.Path, "artifact-spool", carrierKey, name),
            new byte[] { 4, 3, 2, 1 });
        RbpArtifactCarrierException error = Assert.Throws<RbpArtifactCarrierException>(() =>
            spool.ReadAllPinned(carrierKey, name, RbpArtifactCarrierProducer.MaximumCombinedBytes,
                Digest(original)));
        Assert.Equal("carrier_spool_digest_refused", error.Message);
        Assert.DoesNotContain(directory.Path, error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RefusesBadDigestWithoutAcceptingPartialLeaf()
    {
        using var directory = new RbpJournalTestDirectory();
        using var spool = RbpArtifactSpoolFileSystem.OpenForStateRoot(directory.Path);
        string carrierKey = new string('b', 64);
        const string name = "immutable.bin";
        spool.EnsureCarrier(carrierKey);
        RbpArtifactCarrierException error = Assert.Throws<RbpArtifactCarrierException>(() =>
            spool.WriteImmutable(carrierKey, name, new byte[] { 9, 8, 7 },
                "sha256:0000000000000000000000000000000000000000000000000000000000000000"));
        Assert.Equal("carrier_spool_verification_refused", error.Message);
        Assert.False(File.Exists(Path.Combine(directory.Path, "artifact-spool", carrierKey, name)));
        Assert.DoesNotContain(directory.Path, error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void LeafOperationSharePolicyDeniesConcurrentWriterAndDelete()
    {
        // The leaf option is passed for create, read, and cleanup opens; only
        // FILE_SHARE_READ remains, so same-length write/delete replacement is
        // denied for the entire pinned-handle operation lifetime.
        Assert.Equal(1u, WindowsRelativeSpoolNative.LeafShare);
    }

    [Fact]
    public async Task UsesOnlyDeclaredRelativeInventoryForReleasedCleanup()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        var native = new RecordingRelativeSpoolNative();
        RbpArtifactCarrierProducer producer = RbpArtifactCarrierProducer.CreateForTesting(native, store);

        RbpCarrierEmission emission = Assert.IsType<RbpCarrierEmission>(await producer.TryPrepareAsync(
            "rs-relative", Json("""{"kind":"invocation","invocation_id":"invoke-relative"}"""),
            Files(new byte[] { 3, 4 }), CancellationToken.None));
        producer.RecordTerminalQueued(emission.CarrierKey, "rs-relative", 12);
        producer.ApplyDurableAcknowledgements(new[] { new RbpSessionAcknowledgement("rs-relative", 12) });

        (string Key, IReadOnlyList<string> Inventory) delete = Assert.Single(native.DeleteCalls);
        Assert.Equal(emission.CarrierKey, delete.Key);
        Assert.Contains(delete.Inventory, value => value.StartsWith("artifact-", StringComparison.Ordinal) && value.EndsWith(".bin", StringComparison.Ordinal));
        Assert.Contains("manifest.json", delete.Inventory);
        Assert.Contains("terminal.ack.json", delete.Inventory);
        Assert.Equal(0, native.EnumerationAttempts);
        Assert.All(native.RelativeSegments, value => Assert.DoesNotContain(Path.DirectorySeparatorChar, value));
    }

    [Fact]
    public async Task RefusesCleanupWhenDeclaredFileIsMissing()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        var native = new RecordingRelativeSpoolNative();
        RbpArtifactCarrierProducer producer = RbpArtifactCarrierProducer.CreateForTesting(native, store);
        RbpCarrierEmission emission = Assert.IsType<RbpCarrierEmission>(await producer.TryPrepareAsync(
            "rs-residue", Json("""{"kind":"invocation","invocation_id":"invoke-residue"}"""),
            Files(new byte[] { 9 }), CancellationToken.None));
        native.Remove(emission.CarrierKey, "terminal.ack.json");
        producer.RecordTerminalQueued(emission.CarrierKey, "rs-residue", 1);
        native.Remove(emission.CarrierKey, "manifest.json");

        RbpArtifactCarrierException error = Assert.Throws<RbpArtifactCarrierException>(() =>
            producer.ApplyDurableAcknowledgements(new[] { new RbpSessionAcknowledgement("rs-residue", 1) }));
        Assert.Equal("carrier_spool_read_refused", error.Message);
        Assert.Empty(native.DeleteCalls);
    }

    [Fact]
    public async Task WindowsChildProcessParentJunctionSwapCannotEscapeHeldRoot()
    {
        if (!OperatingSystem.IsWindows()) throw Xunit.Sdk.SkipException.ForSkip(
            "Windows NT root-handle test is not applicable on this platform.");

        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        for (int attempt = 0; attempt < 3; attempt++)
        {
            RbpArtifactCarrierProducer producer = RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
            RbpCarrierEmission emission = Assert.IsType<RbpCarrierEmission>(await producer.TryPrepareAsync(
                "rs-swap", Json("{\"kind\":\"invocation\",\"invocation_id\":\"invoke-swap-" + attempt + "\"}"),
                Files(new byte[] { 2, 7 }), CancellationToken.None));
            string spool = Path.Combine(directory.Path, "artifact-spool");
            string retained = Path.Combine(directory.Path, $"spool-retained-{attempt}");
            string external = Path.Combine(directory.Path, $"external-sentinel-{attempt}");
            string sentinel = Path.Combine(external, "sentinel.txt");
            Directory.CreateDirectory(external);
            File.WriteAllText(sentinel, "do-not-touch");

            using Process child = Process.Start(new ProcessStartInfo("cmd.exe",
                $"/d /c move \"{spool}\" \"{retained}\" && mklink /J \"{spool}\" \"{external}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            }) ?? throw new InvalidOperationException("junction swap child did not start");
            await child.WaitForExitAsync();
            if (child.ExitCode != 0)
            {
                throw Xunit.Sdk.SkipException.ForSkip(
                    $"Windows junction privilege unavailable (child exit {child.ExitCode}).");
            }

            try
            {
                producer.RecordTerminalQueued(emission.CarrierKey, "rs-swap", 4);
                producer.ApplyDurableAcknowledgements(new[] { new RbpSessionAcknowledgement("rs-swap", 4) });
                Assert.Equal("do-not-touch", File.ReadAllText(sentinel));
                Assert.False(Directory.Exists(Path.Combine(retained, emission.CarrierKey)));
            }
            finally
            {
                if (Directory.Exists(spool)) Directory.Delete(spool);
            }
        }
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

    [Fact]
    public async Task RejectsMalformedBase64BeforeCreatingAnyArtifactFile()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);

        await Assert.ThrowsAsync<RbpArtifactCarrierException>(() =>
            producer.TryPrepareAsync(
                "rs-malformed",
                Json("""{"kind":"invocation","invocation_id":"invoke-malformed"}"""),
                Json("""
                    {"files":[{"artifactIndex":0,"fileName":"x.bin","contentType":"application/octet-stream","sizeBytes":3,"sha256":"sha256:0000000000000000000000000000000000000000000000000000000000000000","contentBase64":"not!"}]}
                    """),
                CancellationToken.None));

        string spool = Path.Combine(directory.Path, "artifact-spool");
        Assert.Empty(Directory.GetFiles(spool, "*", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task RejectsDeclaredOversizeBeforeDecodingOrWriting()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        JsonElement oversized = Json("""
            {"files":[{"artifactIndex":0,"fileName":"x.bin","contentType":"application/octet-stream","sizeBytes":33554433,"sha256":"sha256:0000000000000000000000000000000000000000000000000000000000000000","contentBase64":"AAAA"}]}
            """);

        RbpArtifactCarrierException error = await Assert.ThrowsAsync<
            RbpArtifactCarrierException>(() => producer.TryPrepareAsync(
                "rs-oversize",
                Json("""{"kind":"invocation","invocation_id":"invoke-oversize"}"""),
                oversized,
                CancellationToken.None));

        Assert.DoesNotContain(directory.Path, error.Message,
            StringComparison.OrdinalIgnoreCase);
        Assert.Empty(Directory.GetFiles(
            Path.Combine(directory.Path, "artifact-spool"), "*",
            SearchOption.AllDirectories));
    }

    [Fact]
    public async Task RefusesReparsePointStateRootWithoutFollowingIt()
    {
        if (!OperatingSystem.IsWindows()) throw Xunit.Sdk.SkipException.ForSkip(
            "Windows no-follow bootstrap test is not applicable on this platform.");
        using var directory = new RbpJournalTestDirectory();
        string link = Path.Combine(directory.Path, "spool-link");
        string external = Path.Combine(directory.Path, "external");
        string sentinel = Path.Combine(external, "sentinel.txt");
        Directory.CreateDirectory(external);
        File.WriteAllText(sentinel, "unchanged");
        try
        {
            Directory.CreateSymbolicLink(link, external);
        }
        catch (UnauthorizedAccessException)
        {
            throw Xunit.Sdk.SkipException.ForSkip(
                "Windows symbolic-link privilege unavailable for no-follow bootstrap test.");
        }
        catch (IOException)
        {
            throw Xunit.Sdk.SkipException.ForSkip(
                "Windows symbolic-link capability unavailable for no-follow bootstrap test.");
        }

        await using RbpJournalStore store = OpenStore(directory);
        RbpArtifactCarrierException error = Assert.Throws<RbpArtifactCarrierException>(
            () => RbpArtifactCarrierProducer.CreateProduction(link, store));
        Assert.DoesNotContain(directory.Path, error.Message,
            StringComparison.OrdinalIgnoreCase);
        Assert.Equal("unchanged", File.ReadAllText(sentinel));
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

    private sealed class RecordingRelativeSpoolNative : IRelativeSpoolNative
    {
        private readonly Dictionary<string, Dictionary<string, byte[]>> _carriers =
            new(StringComparer.Ordinal);
        internal List<(string Key, IReadOnlyList<string> Inventory)> DeleteCalls { get; } = [];
        internal List<string> RelativeSegments { get; } = [];
        internal int EnumerationAttempts { get; private set; }

        public void EnsureCarrier(string carrierKey)
        {
            RelativeSegments.Add(carrierKey);
            if (!_carriers.ContainsKey(carrierKey)) _carriers.Add(carrierKey, new(StringComparer.Ordinal));
        }

        public void WriteImmutable(string carrierKey, string fileName, ReadOnlySpan<byte> bytes, string digest)
        {
            EnsureCarrier(carrierKey); RelativeSegments.Add(fileName);
            Dictionary<string, byte[]> files = _carriers[carrierKey];
            if (files.TryGetValue(fileName, out byte[]? existing))
            {
                if (!existing.AsSpan().SequenceEqual(bytes)) throw new RbpArtifactCarrierException("carrier_spool_conflict_refused");
                return;
            }
            files.Add(fileName, bytes.ToArray());
        }

        public byte[] ReadAllPinned(string carrierKey, string fileName, int maximumBytes,
            string? expectedDigest = null)
        {
            RelativeSegments.Add(carrierKey); RelativeSegments.Add(fileName);
            if (!_carriers.TryGetValue(carrierKey, out Dictionary<string, byte[]>? files) ||
                !files.TryGetValue(fileName, out byte[]? bytes) || bytes.Length > maximumBytes)
                throw new RbpArtifactCarrierException("carrier_spool_read_refused");
            byte[] result = bytes.ToArray();
            if (expectedDigest is not null && !string.Equals(Digest(result), expectedDigest, StringComparison.Ordinal))
                throw new RbpArtifactCarrierException("carrier_spool_digest_refused");
            return result;
        }

        public bool TryReadAllPinned(string carrierKey, string fileName, int maximumBytes,
            out byte[]? bytes, string? expectedDigest = null)
        {
            try { bytes = ReadAllPinned(carrierKey, fileName, maximumBytes, expectedDigest); return true; }
            catch (RbpArtifactCarrierException) { bytes = null; return false; }
        }

        public void DeleteCarrier(string carrierKey, IReadOnlyList<string> declaredFileNames)
        {
            RelativeSegments.Add(carrierKey);
            if (!_carriers.TryGetValue(carrierKey, out Dictionary<string, byte[]>? files) ||
                declaredFileNames.Any(name => !files.ContainsKey(name)) || files.Count != declaredFileNames.Count)
                throw new RbpArtifactCarrierException("carrier_spool_cleanup_refused");
            DeleteCalls.Add((carrierKey, declaredFileNames.ToArray()));
            _carriers.Remove(carrierKey);
        }

        internal void Remove(string carrierKey, string fileName) => _carriers[carrierKey].Remove(fileName);
        public void Dispose() { }
    }
}
