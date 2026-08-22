using System.Globalization;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

/// <summary>
/// The out-of-process half of the power-cut suite. It opens the real journal
/// through the production <c>RbpJournalStore.Open</c> path, performs one
/// exact write sequence, announces that it has reached the requested kill
/// point, and then parks forever so the parent can terminate it with
/// <c>Process.Kill(entireProcessTree: true)</c>. Nothing here disposes the
/// store, closes the SQLite connection, rolls back the open transaction, or
/// checkpoints the write-ahead log: whatever the parent finds on disk is
/// exactly what an unplanned power cut would have left.
///
/// This type is public only because the killable child must live in a real
/// executable; the xunit test project is built as a library with no entry
/// point, so it cannot spawn itself. The thin
/// <c>RevAgent.Bridge.PowerCutHarness</c> executable calls
/// <see cref="Run(string[])"/> and does nothing else, which keeps the write
/// sequence in the same assembly — and next to the same frozen test data — as
/// the assertions that verify it.
/// </summary>
public static class RbpJournalPowerCutChild
{
    private const int UsageExitCode = 64;

    private const int FailureExitCode = 70;

    private static readonly TimeSpan SelfDestructDelay =
        TimeSpan.FromMinutes(2);

    /// <summary>
    /// Runs one kill-point sequence. The call never returns normally: on
    /// success the process parks at its kill point until the parent
    /// terminates it.
    /// </summary>
    public static int Run(string[] args)
    {
        ArgumentNullException.ThrowIfNull(args);
        if (args.Length != 2)
        {
            Console.Error.WriteLine(
                "usage: RevAgent.Bridge.PowerCutHarness <mode> <journal-path>");
            Console.Error.Flush();
            return UsageExitCode;
        }

        StartSelfDestructWatchdog();
        try
        {
            RunAsync(args[0], args[1]).GetAwaiter().GetResult();
            Console.Error.WriteLine(
                "The power-cut child returned without parking at a kill " +
                "point.");
            Console.Error.Flush();
            return FailureExitCode;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception.ToString());
            Console.Error.Flush();
            return FailureExitCode;
        }
    }

    private static async Task RunAsync(string mode, string journalPath)
    {
        var suspender = new SuspendingFaultInjector(mode);

        // The production open path, including its durability profile
        // verification, quick checks, and writer lease.
        RbpJournalStore store = RbpJournalStore.Open(
            journalPath,
            new TestResumeTokenProtector(),
            RbpJournalPowerCutData.ChildOptions(suspender));
        suspender.Profile = store.DurabilityProfile;
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());

        switch (mode)
        {
            case RbpJournalPowerCutMode.ReceivedCommitted:
                _ = await store.AdmitInvocationAsync(
                    RbpJournalPowerCutData.ReadIdentity());
                _ = await store.AdmitInvocationAsync(
                    RbpJournalPowerCutData.WriteIdentity());
                Park(mode, store.DurabilityProfile);
                return;

            case RbpJournalPowerCutMode.ExecutingCommitted:
                _ = await store.AdmitInvocationAsync(
                    RbpJournalPowerCutData.WriteIdentity());
                await store.MarkInvocationExecutingAsync(
                    RbpJournalPowerCutData.WriteKey);
                Park(mode, store.DurabilityProfile);
                return;

            case RbpJournalPowerCutMode.MidInvocationTransaction:
                // Durable prior state the power cut must not damage.
                _ = await store.AdmitInvocationAsync(
                    RbpJournalPowerCutData.ReadIdentity());
                suspender.Arm(RbpJournalFaultPoint.BeforeCommit);
                _ = await store.AdmitInvocationAsync(
                    RbpJournalPowerCutData.WriteIdentity());
                return;

            case RbpJournalPowerCutMode.MidBatchTransaction:
                _ = await store.AdmitInvocationAsync(
                    RbpJournalPowerCutData.ReadIdentity());
                suspender.Arm(RbpJournalFaultPoint.BeforeCommit);
                _ = await store.AdmitBatchAsync(
                    RbpJournalPowerCutData.BatchIdentity(),
                    Array.Empty<RbpRecoveryClearance>());
                return;

            case RbpJournalPowerCutMode.TerminalCommitted:
                _ = await store.AdmitInvocationAsync(
                    RbpJournalPowerCutData.WriteIdentity());
                await store.MarkInvocationExecutingAsync(
                    RbpJournalPowerCutData.WriteKey);
                suspender.Arm(
                    RbpJournalFaultPoint.AfterCommitBeforeReturn);
                _ = await store.PersistInvocationTerminalAsync(
                    RbpJournalPowerCutData.WriteKey,
                    RbpJournalPowerCutData.CompletedTerminal());
                return;

            case RbpJournalPowerCutMode.V3IndeterminateBeforeCommit:
            case RbpJournalPowerCutMode.V3IndeterminateAfterCommit:
                _ = await store.EnsureOutcomeV3ForSessionAsync(
                    RbpJournalPowerCutData.Rsid);
                _ = await store.AdmitInvocationOutcomeV3Async(
                    RbpJournalPowerCutData.WriteIdentity(),
                    Array.Empty<RbpRecoveryClearance>(),
                    RbpTransactionMode.Native);
                await store.MarkInvocationExecutingOutcomeV3Async(
                    RbpJournalPowerCutData.WriteKey,
                    RbpTransactionMode.Native);
                suspender.Arm(
                    mode ==
                        RbpJournalPowerCutMode.V3IndeterminateBeforeCommit
                        ? RbpJournalFaultPoint.BeforeCommit
                        : RbpJournalFaultPoint.AfterCommitBeforeReturn);
                _ = await store.PersistInvocationOutcomeV3Async(
                    RbpJournalPowerCutData.WriteKey,
                    new RbpInvocationTerminal(
                        RbpInvocationState.Indeterminate,
                        Outcome: default,
                        ResultDigest: null),
                    RbpJournalPowerCutData.UncertainWriteEvidence(),
                    error: true);
                return;

            default:
                throw new ArgumentOutOfRangeException(
                    nameof(mode),
                    mode,
                    "Unknown power-cut kill point.");
        }
    }

    private static void Park(
        string mode,
        RbpJournalDurabilityProfile profile)
    {
        string readiness =
            "{\"event\":\"armed\",\"mode\":\"" + mode +
            "\",\"journal_mode\":\"" + profile.JournalMode +
            "\",\"synchronous\":" +
            profile.Synchronous.ToString(CultureInfo.InvariantCulture) +
            ",\"pid\":" +
            Environment.ProcessId.ToString(CultureInfo.InvariantCulture) +
            "}";
        Console.Out.WriteLine(readiness);
        Console.Out.Flush();

        // Hold everything the kill point established — including an open
        // BEGIN IMMEDIATE transaction, when that is the kill point — until
        // the parent terminates this process.
        Thread.Sleep(Timeout.Infinite);
        Environment.Exit(FailureExitCode);
    }

    private static void StartSelfDestructWatchdog()
    {
        var watchdog = new Thread(
            () =>
            {
                Thread.Sleep(SelfDestructDelay);
                Environment.Exit(FailureExitCode);
            })
        {
            IsBackground = true,
            Name = "rbp-power-cut-self-destruct",
        };
        watchdog.Start();
    }

    /// <summary>
    /// Freezes the writing thread at a frozen journal fault point instead of
    /// throwing. At <c>BeforeCommit</c> that leaves a real
    /// <c>BEGIN IMMEDIATE</c> transaction open with all of its writes staged
    /// and none of them committed; at <c>AfterCommitBeforeReturn</c> it
    /// leaves a committed transaction whose result never reached the caller.
    /// </summary>
    private sealed class SuspendingFaultInjector : IRbpJournalFaultInjector
    {
        private readonly string _mode;
        private RbpJournalFaultPoint? _armed;

        internal SuspendingFaultInjector(string mode)
        {
            _mode = mode;
        }

        internal RbpJournalDurabilityProfile? Profile { get; set; }

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
            Park(
                _mode,
                Profile ??
                throw new InvalidOperationException(
                    "The power-cut child has no durability profile."));
        }
    }
}
