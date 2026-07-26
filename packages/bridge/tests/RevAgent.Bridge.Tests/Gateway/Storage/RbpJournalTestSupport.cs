using System.Text;
using System.Text.Json;
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

internal static class RbpJournalTestData
{
    internal static readonly DateTimeOffset Now =
        DateTimeOffset.Parse(
            "2026-07-26T10:00:00.000Z",
            System.Globalization.CultureInfo.InvariantCulture);

    internal static RbpJournalOpenOptions Options(
        ArmedJournalFaultInjector? faultInjector = null,
        IReadOnlyList<RbpJournalMigration>? migrations = null,
        Func<long>? nowMilliseconds = null) =>
        new(
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

    internal static JsonElement Json(string value)
    {
        using JsonDocument document = JsonDocument.Parse(value);
        return document.RootElement.Clone();
    }
}
