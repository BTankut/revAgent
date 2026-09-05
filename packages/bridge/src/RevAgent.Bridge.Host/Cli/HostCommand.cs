namespace RevAgent.Bridge.Host.Cli;

internal enum HostCommandKind
{
    Service,
    Install,
    Uninstall,
    RunConsole,
    Doctor,
    PrepareEnrollment,
    Version,
}

internal enum HostExitCode
{
    Success = 0,
    Unexpected = 1,
    Usage = 2,
    DoctorFailed = 3,
    ServiceControl = 4,
    WorkerLifecycle = 5,
}

internal sealed record HostCommand(
    HostCommandKind Kind,
    bool ReEnroll = false);

internal sealed record HostCommandParseResult(
    HostCommand? Command,
    string? Error)
{
    internal bool Success => Command is not null;
}

internal static class HostCommandParser
{
    internal const string Usage =
        "usage: revagent-bridge-host.exe install | uninstall | " +
        "run --console | doctor [--re-enroll] | prepare-enrollment | --version";

    internal static HostCommandParseResult Parse(
        IReadOnlyList<string> args,
        bool isWindowsService)
    {
        ArgumentNullException.ThrowIfNull(args);
        if (args.Count == 0)
        {
            return isWindowsService
                ? new HostCommandParseResult(
                    new HostCommand(HostCommandKind.Service),
                    null)
                : new HostCommandParseResult(
                    null,
                    "Argumentless mode is accepted only when launched by Windows SCM.");
        }

        if (args.Count == 1)
        {
            HostCommandKind? kind = args[0] switch
            {
                "install" => HostCommandKind.Install,
                "uninstall" => HostCommandKind.Uninstall,
                "doctor" => HostCommandKind.Doctor,
                "prepare-enrollment" => HostCommandKind.PrepareEnrollment,
                "--version" => HostCommandKind.Version,
                _ => null,
            };
            return kind is null
                ? new HostCommandParseResult(
                    null,
                    $"Unknown command '{args[0]}'.")
                : new HostCommandParseResult(
                    new HostCommand(kind.Value),
                    null);
        }

        if (args.Count == 2 &&
            string.Equals(args[0], "run", StringComparison.Ordinal) &&
            string.Equals(args[1], "--console", StringComparison.Ordinal))
        {
            return new HostCommandParseResult(
                new HostCommand(HostCommandKind.RunConsole),
                null);
        }

        if (args.Count == 2 &&
            string.Equals(args[0], "doctor", StringComparison.Ordinal) &&
            string.Equals(args[1], "--re-enroll", StringComparison.Ordinal))
        {
            return new HostCommandParseResult(
                new HostCommand(HostCommandKind.Doctor, ReEnroll: true),
                null);
        }

        return new HostCommandParseResult(
            null,
            "Invalid revAgent Bridge host command line.");
    }
}
