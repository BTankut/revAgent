namespace RevAgent.Bridge;

internal enum WorkerCommandKind
{
    Version,
    Run,
    Doctor,
}

internal sealed record WorkerCommand(
    WorkerCommandKind Kind,
    string? ControlPipeName = null,
    int? ExpectedHostProcessId = null,
    Guid? InstanceId = null,
    string? ConfigurationPath = null,
    bool ReEnroll = false);

internal sealed class WorkerCommandLineException : Exception
{
    internal WorkerCommandLineException(string message)
        : base(message)
    {
    }
}

internal static class WorkerCommandLine
{
    internal const string Usage =
        "Usage: revagent-bridge.exe --version";

    internal static WorkerCommand Parse(IReadOnlyList<string> args)
    {
        ArgumentNullException.ThrowIfNull(args);

        if (args.Count == 1 &&
            string.Equals(args[0], "--version", StringComparison.Ordinal))
        {
            return new WorkerCommand(WorkerCommandKind.Version);
        }

        if (args.Count == 0)
        {
            throw new WorkerCommandLineException("A worker command is required.");
        }

        return args[0] switch
        {
            "__worker" => ParseRun(args),
            "__doctor" => ParseDoctor(args),
            _ => throw new WorkerCommandLineException(
                $"Unknown worker command '{args[0]}'."),
        };
    }

    private static WorkerCommand ParseRun(IReadOnlyList<string> args)
    {
        var options = ParseOptions(args, 1);
        RequireExactOptions(
            options,
            "--control-pipe",
            "--host-pid",
            "--instance-id",
            "--config");

        var pipeName = options["--control-pipe"];
        if (pipeName.Length is < 1 or > 200 ||
            pipeName.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) ||
                  character is '.' or '_' or '-')))
        {
            throw new WorkerCommandLineException(
                "The control pipe name is not a bounded local pipe identifier.");
        }

        if (!int.TryParse(
                options["--host-pid"],
                System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture,
                out var hostProcessId) ||
            hostProcessId <= 0)
        {
            throw new WorkerCommandLineException(
                "The host process id must be a positive integer.");
        }

        if (!Guid.TryParseExact(
                options["--instance-id"],
                "D",
                out var instanceId) ||
            instanceId == Guid.Empty)
        {
            throw new WorkerCommandLineException(
                "The instance id must be a non-empty canonical GUID.");
        }

        return new WorkerCommand(
            WorkerCommandKind.Run,
            pipeName,
            hostProcessId,
            instanceId,
            NormalizeAbsolutePath(options["--config"], "--config"));
    }

    private static WorkerCommand ParseDoctor(IReadOnlyList<string> args)
    {
        var options = ParseOptions(args, 1);
        var reEnroll = false;
        if (options.Remove("--re-enroll", out var reEnrollValue))
        {
            if (!string.Equals(reEnrollValue, "true", StringComparison.Ordinal))
            {
                throw new WorkerCommandLineException(
                    "--re-enroll accepts only the explicit value 'true'.");
            }

            reEnroll = true;
        }

        RequireExactOptions(options, "--config");
        return new WorkerCommand(
            WorkerCommandKind.Doctor,
            ConfigurationPath: NormalizeAbsolutePath(
                options["--config"],
                "--config"),
            ReEnroll: reEnroll);
    }

    private static Dictionary<string, string> ParseOptions(
        IReadOnlyList<string> args,
        int startIndex)
    {
        if ((args.Count - startIndex) % 2 != 0)
        {
            throw new WorkerCommandLineException(
                "Every worker option must have exactly one value.");
        }

        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = startIndex; index < args.Count; index += 2)
        {
            var name = args[index];
            var value = args[index + 1];
            if (!name.StartsWith("--", StringComparison.Ordinal))
            {
                throw new WorkerCommandLineException(
                    "Worker options must use '--name value' syntax.");
            }

            if (string.IsNullOrWhiteSpace(value))
            {
                throw new WorkerCommandLineException(
                    $"Worker option '{name}' requires a non-empty value.");
            }

            if (!options.TryAdd(name, value))
            {
                throw new WorkerCommandLineException(
                    $"Worker option '{name}' was supplied more than once.");
            }
        }

        return options;
    }

    private static void RequireExactOptions(
        IReadOnlyDictionary<string, string> options,
        params string[] expected)
    {
        var expectedSet = new HashSet<string>(
            expected,
            StringComparer.Ordinal);
        var unexpected = options.Keys
            .Where(key => !expectedSet.Contains(key))
            .OrderBy(key => key, StringComparer.Ordinal)
            .ToArray();
        var missing = expected
            .Where(key => !options.ContainsKey(key))
            .OrderBy(key => key, StringComparer.Ordinal)
            .ToArray();

        if (unexpected.Length != 0 || missing.Length != 0)
        {
            throw new WorkerCommandLineException(
                $"Worker option set is invalid. Missing=[{string.Join(",", missing)}]; " +
                $"Unexpected=[{string.Join(",", unexpected)}].");
        }
    }

    private static string NormalizeAbsolutePath(string value, string optionName)
    {
        if (!Path.IsPathFullyQualified(value))
        {
            throw new WorkerCommandLineException(
                $"{optionName} must be an absolute path.");
        }

        try
        {
            return Path.GetFullPath(value);
        }
        catch (Exception exception)
            when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw new WorkerCommandLineException(
                $"{optionName} is not a valid absolute path.");
        }
    }
}
