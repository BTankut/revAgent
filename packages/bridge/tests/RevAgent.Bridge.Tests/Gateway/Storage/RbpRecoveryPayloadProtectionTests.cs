using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

public sealed class RbpRecoveryPayloadProtectionTests
{
    [Fact]
    public async Task ExactOwnerOriginAndRawDigestAreRequiredAndTamperIsOpaque()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        var identity = new RbpInvocationIdentity(
            "rs-test", "0197a3c2-0000-7000-8000-0000000000a1", "get_current_view_info",
            false, null, "sha256:" + new string('a', 64), "{\"decision\":\"allow\"}", "[]");
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        byte[] raw = Encoding.UTF8.GetBytes("{\"jsonrpc\":\"2.0\",\"result\":{\"x\":1}}");
        string digest = "sha256:" + Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
        using JsonDocument outcome = JsonDocument.Parse("{\"outcome\":\"completed\"}");
        _ = await store.PersistInvocationTerminalAsync(identity.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed, outcome.RootElement.Clone(), digest,
                RecoveryPayload: new RbpRecoveryPayload(digest, raw)));

        RbpRecoveredPayload? found = await store.GetCorrelatedRecoveryPayloadAsync(
            identity.Rsid, identity.InvocationId, digest);
        Assert.NotNull(found);
        using (found!)
        {
            Assert.Equal(raw, found.RawResponseBytes.ToArray());
        }
        Assert.True(found.RawResponseBytes.IsEmpty);
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(
            identity.Rsid, identity.InvocationId, "sha256:" + new string('b', 64)));
    }

    [Fact]
    public void EnvelopeRejectsNonUtf8AndWrongIdentityWithoutPayloadDetail()
    {
        byte[] bytes = Encoding.UTF8.GetBytes("{\"ok\":true}");
        string digest = "sha256:" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        byte[] envelope = RbpRecoveryPayloadEnvelope.Create(
            "rs-test", "0197a3c2-0000-7000-8000-0000000000a1",
            "rs-test/0197a3c2-0000-7000-8000-0000000000a1", digest,
            10, 20, bytes);
        Assert.Throws<CryptographicException>(() => RbpRecoveryPayloadEnvelope.Read(
            "rs-other", "0197a3c2-0000-7000-8000-0000000000a1",
            "rs-test/0197a3c2-0000-7000-8000-0000000000a1", digest,
            10, 20, envelope));
    }

    [Fact]
    public async Task ProtectionFailureKeepsTerminalButCreatesNoRecoveryRow()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new RejectingRecoveryPayloadProtector());
        _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        RbpInvocationIdentity identity = await PrepareExecutingAsync(store,
            "0197a3c2-0000-7000-8000-0000000000b1");
        byte[] raw = JsonBytes(64);
        string digest = Digest(raw);
        using JsonDocument outcome = JsonDocument.Parse("{\"outcome\":\"completed\"}");
        _ = await store.PersistInvocationTerminalAsync(identity.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed, outcome.RootElement.Clone(), digest,
                RecoveryPayload: new RbpRecoveryPayload(digest, raw)));

        Assert.Equal(RbpInvocationState.Completed,
            (await store.GetInvocationAsync(identity.IdempotencyKey))!.State);
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(
            identity.Rsid, identity.InvocationId, digest));
    }

    [Fact]
    public async Task AggregateCapIsTransactionalNoEvictionAndConcurrentTerminalizationIsBounded()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        RbpInvocationIdentity first = await PrepareExecutingAsync(store,
            "0197a3c2-0000-7000-8000-0000000000c1");
        RbpInvocationIdentity second = await PrepareExecutingAsync(store,
            "0197a3c2-0000-7000-8000-0000000000c2");
        byte[] raw = JsonBytes((RbpRecoveryPayloadEnvelope.MaxBytes / 2) + 1);
        string digest = Digest(raw);
        await Task.WhenAll(
            CompleteAsync(store, first, digest, raw),
            CompleteAsync(store, second, digest, raw));

        RbpRecoveredPayload? firstRecovered = await store.GetCorrelatedRecoveryPayloadAsync(
            first.Rsid, first.InvocationId, digest);
        RbpRecoveredPayload? secondRecovered = await store.GetCorrelatedRecoveryPayloadAsync(
            second.Rsid, second.InvocationId, digest);
        Assert.True((firstRecovered is null) ^ (secondRecovered is null));
        Assert.Equal(RbpInvocationState.Completed,
            (await store.GetInvocationAsync(first.IdempotencyKey))!.State);
        Assert.Equal(RbpInvocationState.Completed,
            (await store.GetInvocationAsync(second.IdempotencyKey))!.State);
    }

    [Fact]
    public async Task PerRecordCapKeepsTerminalAndRefusesOnlyRecoveryMaterial()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        RbpInvocationIdentity identity = await PrepareExecutingAsync(store,
            "0197a3c2-0000-7000-8000-0000000000c3");
        byte[] raw = JsonBytes(RbpRecoveryPayloadEnvelope.MaxBytes + 1);
        string digest = Digest(raw);
        await CompleteAsync(store, identity, digest, raw);
        Assert.Equal(RbpInvocationState.Completed,
            (await store.GetInvocationAsync(identity.IdempotencyKey))!.State);
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(
            identity.Rsid, identity.InvocationId, digest));
    }

    [Fact]
    public async Task MetadataTamperIsOpaqueAndDoesNotExposeRawPayload()
    {
        using var directory = new RbpJournalTestDirectory();
        RbpInvocationIdentity identity;
        string digest;
        await using (RbpJournalStore store = RbpJournalStore.Open(
                         directory.JournalPath, new TestResumeTokenProtector(),
                         RbpJournalTestData.Options(), new TestRecoveryPayloadProtector()))
        {
            _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
            identity = await PrepareExecutingAsync(store,
                "0197a3c2-0000-7000-8000-0000000000d1");
            byte[] raw = Encoding.UTF8.GetBytes("{\"raw_secret\":\"never-log\"}");
            digest = Digest(raw);
            await CompleteAsync(store, identity, digest, raw);
        }
        using (var connection = new SqliteConnection($"Data Source={directory.JournalPath}"))
        {
            connection.Open();
            using SqliteCommand mutate = connection.CreateCommand();
            mutate.CommandText = "UPDATE rbp_recovery_payloads SET created_at_ms=created_at_ms+1;";
            _ = mutate.ExecuteNonQuery();
        }
        await using RbpJournalStore reopened = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(),
            RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        Assert.Null(await reopened.GetCorrelatedRecoveryPayloadAsync(
            identity.Rsid, identity.InvocationId, digest));
        Assert.DoesNotContain("never-log", new RbpRecoveryPayload(digest, Encoding.UTF8.GetBytes("{\"raw_secret\":\"never-log\"}")).ToString());
    }

    [Fact]
    public async Task JournalFaultRollsBackTerminalAndRecoveryChildTogether()
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new ArmedJournalFaultInjector();
        await using (RbpJournalStore store = RbpJournalStore.Open(
                         directory.JournalPath, new TestResumeTokenProtector(),
                         RbpJournalTestData.Options(faults), new TestRecoveryPayloadProtector()))
        {
            _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
            RbpInvocationIdentity identity = await PrepareExecutingAsync(store,
                "0197a3c2-0000-7000-8000-0000000000d2");
            byte[] raw = JsonBytes(64);
            string digest = Digest(raw);
            using JsonDocument outcome = JsonDocument.Parse("{\"outcome\":\"completed\"}");
            faults.Arm(RbpJournalFaultPoint.BeforeCommit);
            await Assert.ThrowsAsync<IOException>(() => store.PersistInvocationTerminalAsync(
                identity.IdempotencyKey,
                new RbpInvocationTerminal(RbpInvocationState.Completed, outcome.RootElement.Clone(), digest,
                    RecoveryPayload: new RbpRecoveryPayload(digest, raw))));
            Assert.Equal(RbpInvocationState.Executing,
                (await store.GetInvocationAsync(identity.IdempotencyKey))!.State);
            Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(
                identity.Rsid, identity.InvocationId, digest));
        }
    }

    [Fact]
    public async Task AuthenticatedExpiryDeniesImmediatelyAndLegacyOrTamperedRowsAreEquallyOpaque()
    {
        using var directory = new RbpJournalTestDirectory();
        long start = RbpJournalTestData.Now.ToUnixTimeMilliseconds();
        RbpInvocationIdentity identity;
        string digest;
        await using (RbpJournalStore store = RbpJournalStore.Open(
                         directory.JournalPath, new TestResumeTokenProtector(),
                         RbpJournalTestData.Options(nowMilliseconds: () => start),
                         new TestRecoveryPayloadProtector()))
        {
            _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
            identity = await PrepareExecutingAsync(store, "0197a3c2-0000-7000-8000-0000000000e1");
            byte[] raw = Encoding.UTF8.GetBytes("{\"noncanonical\":  true}");
            digest = Digest(raw);
            await CompleteAsync(store, identity, digest, raw);
        }
        await using (RbpJournalStore expired = RbpJournalStore.Open(
                         directory.JournalPath, new TestResumeTokenProtector(),
                         RbpJournalTestData.Options(nowMilliseconds: () => start + (long)TimeSpan.FromDays(15).TotalMilliseconds),
                         new TestRecoveryPayloadProtector()))
        {
            Assert.Null(await expired.GetCorrelatedRecoveryPayloadAsync(identity.Rsid, identity.InvocationId, digest));
        }
        using (var connection = new SqliteConnection($"Data Source={directory.JournalPath}"))
        {
            connection.Open();
            using SqliteCommand tamper = connection.CreateCommand();
            tamper.CommandText = "UPDATE rbp_recovery_payloads SET protected_envelope=X'00';";
            _ = tamper.ExecuteNonQuery();
        }
        await using RbpJournalStore tampered = RbpJournalStore.Open(
            directory.JournalPath, new TestResumeTokenProtector(), RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        Assert.Null(await tampered.GetCorrelatedRecoveryPayloadAsync(identity.Rsid, identity.InvocationId, digest));
    }

    [Fact]
    public async Task LegacyTerminalWithoutChildAndMissingOriginHaveSameOpaqueUnavailableAnswer()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(directory.JournalPath,
            new TestResumeTokenProtector(), RbpJournalTestData.Options(), new TestRecoveryPayloadProtector());
        _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        RbpInvocationIdentity identity = await PrepareExecutingAsync(store, "0197a3c2-0000-7000-8000-0000000000e2");
        byte[] raw = Encoding.UTF8.GetBytes("{\"legacy\":true}");
        string digest = Digest(raw);
        using JsonDocument body = JsonDocument.Parse("{\"outcome\":\"completed\"}");
        _ = await store.PersistInvocationTerminalAsync(identity.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed, body.RootElement.Clone(), digest));
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(identity.Rsid, identity.InvocationId, digest));
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(identity.Rsid,
            "0197a3c2-0000-7000-8000-0000000000e3", digest));
    }

    private static async Task<RbpInvocationIdentity> PrepareExecutingAsync(
        RbpJournalStore store,
        string invocationId)
    {
        var identity = new RbpInvocationIdentity(
            "rs-test", invocationId, "get_current_view_info", false, null,
            "sha256:" + new string('a', 64), "{\"decision\":\"allow\"}", "[]");
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        return identity;
    }

    private static async Task CompleteAsync(
        RbpJournalStore store, RbpInvocationIdentity identity, string digest, byte[] raw)
    {
        using JsonDocument outcome = JsonDocument.Parse("{\"outcome\":\"completed\"}");
        _ = await store.PersistInvocationTerminalAsync(identity.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed, outcome.RootElement.Clone(), digest,
                RecoveryPayload: new RbpRecoveryPayload(digest, raw)));
    }

    private static byte[] JsonBytes(int length)
    {
        byte[] bytes = new byte[length];
        bytes[0] = (byte)'\"';
        Array.Fill(bytes, (byte)' ', 1, length - 2);
        bytes[^1] = (byte)'\"';
        return bytes;
    }

    private static string Digest(byte[] bytes) => "sha256:" +
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
