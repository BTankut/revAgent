using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

internal sealed class RbpJournalTestDirectory : IDisposable
{
    internal RbpJournalTestDirectory()
    {
        Path = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(),
            "revagent-rbp-journal-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path);
    }

    internal string Path { get; }

    internal string JournalPath =>
        System.IO.Path.Combine(Path, "journal.db");

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(Path))
            {
                Directory.Delete(Path, recursive: true);
            }
        }
        catch (IOException)
        {
            // A failed test should retain its SQLite evidence for diagnosis.
        }
        catch (UnauthorizedAccessException)
        {
            // A failed test should retain its SQLite evidence for diagnosis.
        }
    }
}

internal sealed class TestResumeTokenProtector :
    IRbpResumeTokenProtector
{
    private const byte Mask = 0xA7;

    public RbpProtectedResumeToken Protect(string plaintextToken)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(plaintextToken);
        for (int index = 0; index < bytes.Length; index++)
        {
            bytes[index] ^= Mask;
        }

        return new RbpProtectedResumeToken("test-xor-v1", bytes);
    }

    public string Unprotect(RbpProtectedResumeToken protectedToken)
    {
        if (!string.Equals(
                protectedToken.ProtectionScheme,
                "test-xor-v1",
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Unexpected test protection scheme.");
        }

        byte[] bytes = protectedToken.CopyCiphertext();
        for (int index = 0; index < bytes.Length; index++)
        {
            bytes[index] ^= Mask;
        }

        return Encoding.UTF8.GetString(bytes);
    }
}

internal sealed class RejectingResumeTokenProtector :
    IRbpResumeTokenProtector
{
    public RbpProtectedResumeToken Protect(string plaintextToken) =>
        throw new InvalidOperationException("protection unavailable");

    public string Unprotect(RbpProtectedResumeToken protectedToken) =>
        throw new InvalidOperationException("unprotection unavailable");
}

internal sealed class TestRecoveryPayloadProtector : IRbpRecoveryPayloadProtector
{
    private const byte Mask = 0x5C;

    public RbpProtectedRecoveryPayload Protect(ReadOnlySpan<byte> plaintext)
    {
        byte[] bytes = plaintext.ToArray();
        for (int index = 0; index < bytes.Length; index++) bytes[index] ^= Mask;
        return new RbpProtectedRecoveryPayload("test-recovery-v7", bytes);
    }

    public byte[] Unprotect(RbpProtectedRecoveryPayload protectedPayload)
    {
        if (!string.Equals(protectedPayload.ProtectionScheme, "test-recovery-v7", StringComparison.Ordinal))
            throw new InvalidOperationException("Unexpected recovery scheme.");
        byte[] bytes = protectedPayload.CopyCiphertext();
        for (int index = 0; index < bytes.Length; index++) bytes[index] ^= Mask;
        return bytes;
    }
}

internal sealed class RejectingRecoveryPayloadProtector : IRbpRecoveryPayloadProtector
{
    public RbpProtectedRecoveryPayload Protect(ReadOnlySpan<byte> plaintext) =>
        throw new System.Security.Cryptography.CryptographicException("unavailable");

    public byte[] Unprotect(RbpProtectedRecoveryPayload protectedPayload) =>
        throw new System.Security.Cryptography.CryptographicException("unavailable");
}

internal sealed class TestRollbackBackupSeam : IRbpJournalRollbackBackupSeam
{
    internal int PublishCount { get; private set; }
    public bool RequiresProtectedAcl => false;
    public void CreateTemporary(string path) => File.WriteAllBytes(path, []);
    public void ProtectTemporary(string path) { }
    public void CopyConsistently(SqliteConnection source, string temporaryPath)
    {
        using var target = new SqliteConnection($"Data Source={temporaryPath};Pooling=False");
        target.Open();
        source.BackupDatabase(target);
    }
    public void PublishNoOverwrite(string temporaryPath, string backupPath)
    {
        PublishCount++;
        File.Move(temporaryPath, backupPath, overwrite: false);
    }
    public void CleanupTemporary(string temporaryPath)
    {
        if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
    }
}

internal sealed class ArmedJournalFaultInjector :
    IRbpJournalFaultInjector
{
    private RbpJournalFaultPoint? _armed;

    internal void Arm(RbpJournalFaultPoint point)
    {
        _armed = point;
    }

    public void Hit(RbpJournalFaultPoint point)
    {
        if (_armed != point)
        {
            return;
        }

        _armed = null;
        throw new IOException($"Injected journal fault at {point}.");
    }
}

/// <summary>Deterministically faults one exact write phase without changing production code.</summary>
internal sealed class OrdinalJournalFaultInjector : IRbpJournalFaultInjector
{
    private readonly RbpJournalFaultPoint _point;
    private int _remaining;

    internal OrdinalJournalFaultInjector(RbpJournalFaultPoint point, int occurrence)
    {
        _point = point;
        _remaining = occurrence;
    }

    public void Hit(RbpJournalFaultPoint point)
    {
        if (point != _point || Interlocked.Decrement(ref _remaining) != 0) return;
        throw new IOException($"Injected journal fault at {point}.");
    }
}

internal static class RbpJournalTestData
{
    internal static readonly DateTimeOffset Now =
        DateTimeOffset.Parse(
            "2026-07-26T10:00:00.000Z",
            System.Globalization.CultureInfo.InvariantCulture);

    internal static RbpJournalOpenOptions Options(
        IRbpJournalFaultInjector? faultInjector = null,
        IReadOnlyList<RbpJournalMigration>? migrations = null,
        Func<long>? nowMilliseconds = null,
        int busyTimeoutMilliseconds = 5_000) =>
        new(
            BusyTimeoutMilliseconds: busyTimeoutMilliseconds,
            NowMilliseconds:
                nowMilliseconds ??
                (() => Now.ToUnixTimeMilliseconds()),
            FaultInjector: faultInjector,
            AdditionalMigrations: migrations);

    internal static RbpSessionRegistration Registration(
        string rsid = "rs-test",
        string localSessionKey = "port:8080:pid:1234",
        string resumeToken = "opaque-resume-token",
        int expiresInHours = 24)
    {
        return new RbpSessionRegistration(
            rsid,
            localSessionKey,
            Json(
                $$"""
                {
                  "local_session_key":"{{localSessionKey}}",
                  "machine":{"hostname":"WS01"},
                  "revit":{"version":"2024","pid":1234}
                }
                """),
            resumeToken,
            Now.AddHours(expiresInHours),
            new[] { "batch_atomic", "doc_context_cached_v1" });
    }

    internal static RbpDataEnvelopeSnapshot Inbound(
        string rsid,
        long sequence,
        string id,
        int value,
        long? acknowledgement = null)
    {
        return new RbpDataEnvelopeSnapshot(
            "invoke",
            id,
            rsid,
            sequence,
            Json($$"""{"value":{{value}}}"""),
            acknowledgement,
            "2026-07-26T10:00:01.000Z");
    }

    internal static RbpOutboundDataDraft Outbound(
        string id,
        int value,
        long? acknowledgement = null)
    {
        return new RbpOutboundDataDraft(
            "result",
            id,
            Json($$"""{"value":{{value}}}"""),
            acknowledgement,
            "2026-07-26T10:00:02.000Z");
    }

    internal static string JournalRecordDigest(string json) =>
        Rfc8785Json.Sha256Digest(Json(json));

    internal static JsonElement Json(string value)
    {
        using JsonDocument document = JsonDocument.Parse(value);
        return document.RootElement.Clone();
    }
}
