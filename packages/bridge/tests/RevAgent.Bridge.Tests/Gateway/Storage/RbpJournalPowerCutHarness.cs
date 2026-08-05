using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

/// <summary>
/// The exact kill points a power cut must survive. Each mode names the last
/// durable fact the child process reaches before it is terminated without a
/// dispose, a close, a rollback, or a checkpoint.
/// </summary>
internal static class RbpJournalPowerCutMode
{
    /// <summary><c>received</c> committed; <c>executing</c> never written.</summary>
    internal const string ReceivedCommitted = "received-committed";

    /// <summary><c>executing</c> committed; no terminal outcome written.</summary>
    internal const string ExecutingCommitted = "executing-committed";

    /// <summary>
    /// Inside <c>BEGIN IMMEDIATE</c> for a fresh invocation admission: every
    /// row of that transaction is written and none of it is committed.
    /// </summary>
    internal const string MidInvocationTransaction = "mid-invocation-transaction";

    /// <summary>
    /// Inside <c>BEGIN IMMEDIATE</c> for a batch coordination-row install:
    /// the coordination row and every ordered step row are written and none
    /// of it is committed.
    /// </summary>
    internal const string MidBatchTransaction = "mid-batch-transaction";

    /// <summary>
    /// The terminal outcome is committed and the caller has not yet been
    /// handed the result, so the RBP answer was never sent.
    /// </summary>
    internal const string TerminalCommitted = "terminal-committed";
}

/// <summary>
/// The frozen identities the killed child writes and the parent then asserts
/// on the recovered database. Both processes read them from here so a
/// recovered row can be compared field by field, not merely counted.
/// </summary>
internal static class RbpJournalPowerCutData
{
    internal const string Rsid = "rs-test";

    internal const string ReadInvocationId =
        "0197a3c2-0000-7000-8000-0000000000d1";

    internal const string WriteInvocationId =
        "0197a3c2-0000-7000-8000-0000000000d2";

    internal const string BatchId =
        "0197a3c2-0000-7000-8000-0000000000d3";

    internal const string BatchWriteStepId =
        "0197a3c2-0000-7000-8000-0000000000d4";

    internal const string BatchReadStepId =
        "0197a3c2-0000-7000-8000-0000000000d5";

    internal const string DocumentScopeJcs =
        """{"document_id":"doc-1","kind":"document"}""";

    internal const string ParamsDigest =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    internal const string TerminalOutcomeJson = """{"ok":true}""";

    internal static string ReadKey =>
        Rsid + "/" + ReadInvocationId;

    internal static string WriteKey =>
        Rsid + "/" + WriteInvocationId;

    internal static string BatchKey =>
        Rsid + "/" + BatchId;

    internal static RbpInvocationIdentity ReadIdentity() =>
        new(
            Rsid,
            ReadInvocationId,
            "get_current_view_info",
            Mutating: false,
            MutationScopeJcs: null,
            ParamsDigest: ParamsDigest,
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");

    internal static RbpInvocationIdentity WriteIdentity() =>
        new(
            Rsid,
            WriteInvocationId,
            "create_wall",
            Mutating: true,
            MutationScopeJcs: DocumentScopeJcs,
            ParamsDigest: ParamsDigest,
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");

    internal static RbpBatchIdentity BatchIdentity() =>
        RbpBatchTestData.Batch(
            atomic: false,
            BatchId,
            new[]
            {
                RbpBatchTestData.WriteStep(
                    BatchWriteStepId,
                    DocumentScopeJcs),
                RbpBatchTestData.ReadStep(BatchReadStepId),
            });

    internal static RbpInvocationTerminal CompletedTerminal()
    {
        JsonElement outcome =
            RbpJournalTestData.Json(TerminalOutcomeJson);
        return new RbpInvocationTerminal(
            RbpInvocationState.Completed,
            outcome,
            Rfc8785Json.Sha256Digest(outcome));
    }

    internal static string CanonicalTerminalOutcomeJson() =>
        Rfc8785Json.Canonicalize(
            RbpJournalTestData.Json(TerminalOutcomeJson));

    internal static string TerminalResultDigest() =>
        Rfc8785Json.Sha256Digest(
            RbpJournalTestData.Json(TerminalOutcomeJson));

    internal static RbpJournalOpenOptions ChildOptions(
        IRbpJournalFaultInjector faultInjector) =>
        new(
            BusyTimeoutMilliseconds: 5_000,
            NowMilliseconds: () =>
                RbpJournalTestData.Now.ToUnixTimeMilliseconds(),
            FaultInjector: faultInjector);
}

/// <summary>
/// What the child reported at the instant it was frozen at its kill point.
/// The durability profile is carried across so the parent proves the killed
/// process really was running the production WAL/<c>synchronous=FULL</c>
/// profile rather than a weaker one.
/// </summary>
internal sealed record RbpJournalPowerCutReadiness(
    string Mode,
    string JournalMode,
    int Synchronous,
    int ProcessId);

/// <summary>
/// Spawns the out-of-process journal writer, waits for it to reach an exact
/// durability boundary, and then terminates it with
/// <see cref="Process.Kill(bool)"/> — no dispose, no close, no rollback, no
/// WAL checkpoint. This is what the in-process
/// <c>ArmedJournalFaultInjector</c> suites cannot do: they always end with an
/// orderly <c>await using</c> dispose, whose
/// <c>PRAGMA wal_checkpoint(TRUNCATE)</c> hands the next open a database that
/// never needs WAL recovery.
/// </summary>
internal static class RbpJournalPowerCutProcess
{
    private static readonly TimeSpan ReadyTimeout = TimeSpan.FromSeconds(20);

    private static readonly TimeSpan ExitTimeout = TimeSpan.FromSeconds(10);

    internal static async Task<RbpJournalPowerCutReadiness> KillAtAsync(
        string mode,
        string journalPath)
    {
        string harness = ResolveHarnessExecutable();
        var startInfo = new ProcessStartInfo
        {
            FileName = harness,
            WorkingDirectory = Path.GetDirectoryName(harness)!,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add(mode);
        startInfo.ArgumentList.Add(journalPath);

        using var process = new Process { StartInfo = startInfo };
        if (!process.Start())
        {
            throw new InvalidOperationException(
                "The RBP journal power-cut child did not start.");
        }

        Task<string> errorText = process.StandardError.ReadToEndAsync();
        try
        {
            using var timeout = new CancellationTokenSource(ReadyTimeout);
            string? line;
            try
            {
                line = await process.StandardOutput
                    .ReadLineAsync(timeout.Token)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
                when (timeout.IsCancellationRequested)
            {
                throw new TimeoutException(
                    "The RBP journal power-cut child never reached the " +
                    mode +
                    " kill point.");
            }

            if (line is null)
            {
                throw new InvalidOperationException(
                    "The RBP journal power-cut child exited before the " +
                    mode +
                    " kill point: " +
                    await ReadErrorAsync(errorText).ConfigureAwait(false));
            }

            RbpJournalPowerCutReadiness readiness = Parse(line);
            if (!string.Equals(readiness.Mode, mode, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "The RBP journal power-cut child reported the wrong " +
                    "kill point.");
            }

            if (readiness.ProcessId != process.Id)
            {
                throw new InvalidOperationException(
                    "The RBP journal power-cut child reported a process " +
                    "identity other than the launched harness.");
            }

            if (process.HasExited)
            {
                throw new InvalidOperationException(
                    "The RBP journal power-cut child exited on its own, so " +
                    "the kill was not abrupt.");
            }

            // The abrupt death: no dispose, no SQLite close, no rollback of
            // the open transaction, no WAL checkpoint.
            process.Kill(entireProcessTree: true);
            using var exitTimeout = new CancellationTokenSource(ExitTimeout);
            await process.WaitForExitAsync(exitTimeout.Token)
                .ConfigureAwait(false);
            return readiness;
        }
        catch
        {
            TryKill(process);
            throw;
        }
    }

    private static async Task<string> ReadErrorAsync(Task<string> errorText)
    {
        Task completed = await Task.WhenAny(
                errorText,
                Task.Delay(ExitTimeout))
            .ConfigureAwait(false);
        return ReferenceEquals(completed, errorText)
            ? await errorText.ConfigureAwait(false)
            : "<no diagnostics>";
    }

    private static RbpJournalPowerCutReadiness Parse(string line)
    {
        using JsonDocument document = JsonDocument.Parse(line);
        JsonElement root = document.RootElement;
        if (!string.Equals(
                root.GetProperty("event").GetString(),
                "armed",
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "The RBP journal power-cut child emitted an unknown record.");
        }

        return new RbpJournalPowerCutReadiness(
            root.GetProperty("mode").GetString() ?? string.Empty,
            root.GetProperty("journal_mode").GetString() ?? string.Empty,
            root.GetProperty("synchronous").GetInt32(),
            root.GetProperty("pid").GetInt32());
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                _ = process.WaitForExit((int)ExitTimeout.TotalMilliseconds);
            }
        }
        catch (InvalidOperationException)
        {
            // The child was never started or has already been reaped.
        }
    }

    private static string ResolveHarnessExecutable()
    {
        string fileName = OperatingSystem.IsWindows()
            ? "RevAgent.Bridge.PowerCutHarness.exe"
            : "RevAgent.Bridge.PowerCutHarness";
        string bridgeRoot = FindBridgeRoot();
        var candidates = new List<string>();
        foreach (string configuration in ProbeConfigurations())
        {
            candidates.Add(
                Path.Combine(
                    bridgeRoot,
                    "tests",
                    "RevAgent.Bridge.PowerCutHarness",
                    "bin",
                    configuration,
                    "net8.0",
                    fileName));
        }

        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new InvalidOperationException(
            "The RBP journal power-cut harness executable was not found. " +
            "Build packages/bridge/RevAgent.Bridge.sln before running this " +
            "suite. Probed: " +
            string.Join("; ", candidates));
    }

    private static IEnumerable<string> ProbeConfigurations()
    {
        var seen = new List<string>();
        DirectoryInfo? tfm = new(AppContext.BaseDirectory);
        string? current = tfm.Parent?.Name;
        if (!string.IsNullOrEmpty(current))
        {
            seen.Add(current);
        }

        foreach (string fallback in new[] { "Release", "Debug" })
        {
            if (!seen.Contains(fallback, StringComparer.Ordinal))
            {
                seen.Add(fallback);
            }
        }

        return seen;
    }

    private static string FindBridgeRoot()
    {
        foreach (string start in new[]
                 {
                     AppContext.BaseDirectory,
                     Directory.GetCurrentDirectory(),
                 })
        {
            var directory = new DirectoryInfo(start);
            while (directory is not null)
            {
                if (File.Exists(
                        Path.Combine(
                            directory.FullName,
                            "RevAgent.Bridge.sln")))
                {
                    return directory.FullName;
                }

                directory = directory.Parent;
            }
        }

        throw new InvalidOperationException(
            "The bridge solution root could not be located for the RBP " +
            "journal power-cut harness.");
    }
}

/// <summary>
/// File-set evidence around the kill. Before recovery the write-ahead log
/// must still carry frames, which is what proves the reopen genuinely
/// performs WAL recovery; after an orderly close of the recovered store the
/// log and its shared-memory index must be gone again.
/// </summary>
internal static class RbpJournalPowerCutFiles
{
    internal static void AssertWalRecoveryPending(string journalPath)
    {
        Assert.True(
            File.Exists(journalPath),
            "The killed child left no RBP journal database.");
        string wal = journalPath + "-wal";
        Assert.True(
            File.Exists(wal),
            "The killed child left no write-ahead log to recover.");
        Assert.True(
            new FileInfo(wal).Length > 0,
            "The killed child left an empty write-ahead log, so no WAL " +
            "recovery would be exercised.");
    }

    internal static void AssertRecoveredFileSetIsSane(string journalPath)
    {
        string wal = journalPath + "-wal";
        string sharedMemory = journalPath + "-shm";
        string observed = Describe(journalPath);
        Assert.True(File.Exists(journalPath), observed);
        Assert.True(
            !File.Exists(wal) || new FileInfo(wal).Length == 0,
            "A recovered and orderly-closed RBP journal must not retain " +
            "write-ahead log frames: " +
            observed);
        Assert.False(
            File.Exists(sharedMemory),
            "A recovered and orderly-closed RBP journal must not retain a " +
            "WAL shared-memory index: " +
            observed);
        Assert.True(
            File.Exists(journalPath + ".writer.lock"),
            "The reopened store must have retaken the writer lease: " +
            observed);
    }

    private static string Describe(string journalPath)
    {
        string directory = Path.GetDirectoryName(journalPath)!;
        var names = new List<string>();
        foreach (string path in Directory.GetFiles(directory))
        {
            names.Add(
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"{Path.GetFileName(path)}={new FileInfo(path).Length}"));
        }

        names.Sort(StringComparer.Ordinal);
        return string.Join(", ", names);
    }
}
