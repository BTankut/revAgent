using System.Diagnostics;
using System.Globalization;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevAgent.Bridge.Tests.FixtureIntegration;

/// <summary>
/// One observation record emitted by the O1-T3 add-in loopback fixture.
/// </summary>
internal sealed record FixtureObservation(
    long Sequence,
    string? RequestId,
    string? Method,
    string Phase,
    long? ExecutionOrdinal,
    long? PayloadBytes,
    string? Detail);

/// <summary>
/// A fully paged <c>snapshot_evidence</c> result from the fixture.
/// </summary>
internal sealed record FixtureEvidence(
    string FixtureContract,
    IReadOnlyList<FixtureObservation> Observations,
    IReadOnlyDictionary<string, long> ExecutionCounts,
    IReadOnlyDictionary<string, long> MethodExecutionCounts,
    long OpenSocketCount,
    bool Crashed)
{
    internal long MethodExecutionCount(string method) =>
        MethodExecutionCounts.TryGetValue(method, out long count) ? count : 0;

    internal long ExecutionCount(string requestId) =>
        ExecutionCounts.TryGetValue(requestId, out long count) ? count : 0;

    internal IReadOnlyList<FixtureObservation> ObservationsFor(string requestId) =>
        Observations
            .Where(observation => string.Equals(
                observation.RequestId,
                requestId,
                StringComparison.Ordinal))
            .ToList();
}

/// <summary>
/// Raised when the fixture could not bind the requested loopback port, so the
/// caller may try the next candidate inside the frozen scan window.
/// </summary>
internal sealed class FixtureBindUnavailableException : Exception
{
    internal FixtureBindUnavailableException(string message)
        : base(message)
    {
    }
}

/// <summary>
/// Launches the O1-T3-owned add-in loopback fixture
/// (<c>packages/addin-loopback-fixture</c>) as a real Node process and drives
/// its strict JSON Lines control channel.
/// </summary>
/// <remarks>
/// <para>
/// The M3 evidence record requires the Bridge TCP client to consume the
/// O1-T3-owned fixture rather than a divergent M3 fixture, so this helper
/// launches the exact published CLI entrypoint with the same discipline the
/// M1 <c>packages/rbp-conformance</c> lane uses: numeric loopback host, one
/// readiness JSON record on stdout, correlated JSON Lines control records, and
/// a graceful <c>shutdown</c> before any kill escalation.
/// </para>
/// <para>
/// The single-flight build gate mirrors the Gateway stub process helper. It
/// deliberately runs
/// the fixture package's own declared <c>build:self</c> command (the workspace
/// TypeScript compiler against the package tsconfig) instead of a second
/// <c>npm run build --workspace</c>: the Gateway stub already owns the only
/// npm build gate in this assembly, and two concurrent npm workspace builds in
/// one repository root collide.
/// </para>
/// </remarks>
internal sealed class AddinLoopbackFixtureProcess : IAsyncDisposable
{
    internal const string FixtureContract = "addin-loopback/v1";
    internal const int ControlVersion = 1;

    private static readonly SemaphoreSlim BuildGate = new(1, 1);
    private static string? _builtRepositoryRoot;

    private readonly Process _process;
    private readonly StringBuilder _standardError;
    private readonly SemaphoreSlim _controlGate = new(1, 1);
    private long _controlSequence;
    private bool _controlClosed;
    private bool _disposed;

    private AddinLoopbackFixtureProcess(
        Process process,
        StringBuilder standardError,
        string host,
        int port)
    {
        _process = process;
        _standardError = standardError;
        Host = host;
        Port = port;
    }

    internal string Host { get; }

    internal int Port { get; }

    /// <summary>
    /// The Node process id. The fixture reports exactly this value as
    /// <c>mcp_status.result.revit.processId</c>.
    /// </summary>
    internal int ProcessId => _process.Id;

    internal static async Task<AddinLoopbackFixtureProcess> StartAsync(
        int port = 0)
    {
        string repositoryRoot = FindRepositoryRoot();
        await EnsureFixtureBuiltAsync(repositoryRoot).ConfigureAwait(false);

        var startInfo = new ProcessStartInfo
        {
            FileName = OperatingSystem.IsWindows() ? "node.exe" : "node",
            WorkingDirectory = repositoryRoot,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add(FixtureEntrypoint(repositoryRoot));
        startInfo.ArgumentList.Add("--host");
        startInfo.ArgumentList.Add("127.0.0.1");
        startInfo.ArgumentList.Add("--port");
        startInfo.ArgumentList.Add(port.ToString(CultureInfo.InvariantCulture));

        var process = new Process { StartInfo = startInfo };
        var standardError = new StringBuilder();
        try
        {
            if (!process.Start())
            {
                throw new InvalidOperationException(
                    "The add-in loopback fixture process did not start.");
            }

            DrainStandardError(process, standardError);

            using var timeout = new CancellationTokenSource(
                TimeSpan.FromSeconds(20));
            string? readinessLine = await process.StandardOutput
                .ReadLineAsync(timeout.Token)
                .ConfigureAwait(false);
            if (readinessLine is null)
            {
                await WaitForExitAsync(process).ConfigureAwait(false);
                string error = standardError.ToString();
                if (IsRetryableBindFailure(error))
                {
                    throw new FixtureBindUnavailableException(
                        "The add-in loopback fixture could not bind port " +
                        port.ToString(CultureInfo.InvariantCulture) +
                        ": " +
                        error.Trim());
                }

                throw new InvalidOperationException(
                    "The add-in loopback fixture emitted no readiness record: " +
                    error);
            }

            JObject readiness = ParseJsonObject(
                readinessLine,
                "add-in loopback fixture readiness record");
            RequireReadiness(readiness);
            var host = readiness.Value<string>("host") ??
                throw new InvalidOperationException(
                    "The fixture readiness record omitted host.");
            int boundPort = readiness.Value<int?>("port") ??
                throw new InvalidOperationException(
                    "The fixture readiness record omitted port.");
            if (port != 0 && boundPort != port)
            {
                throw new InvalidOperationException(
                    "The fixture bound an unexpected loopback port.");
            }

            return new AddinLoopbackFixtureProcess(
                process,
                standardError,
                host,
                boundPort);
        }
        catch
        {
            StopProcess(process);
            process.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Starts one fixture on the first candidate port that is still free,
    /// skipping ports another local process already owns.
    /// </summary>
    internal static async Task<AddinLoopbackFixtureProcess>
        StartOnFirstFreePortAsync(IEnumerable<int> candidatePorts)
    {
        ArgumentNullException.ThrowIfNull(candidatePorts);
        var attempted = new List<string>();
        foreach (int candidate in candidatePorts)
        {
            try
            {
                return await StartAsync(candidate).ConfigureAwait(false);
            }
            catch (FixtureBindUnavailableException exception)
            {
                attempted.Add(exception.Message);
            }
        }

        throw new InvalidOperationException(
            "No candidate loopback port in the frozen scan window was free: " +
            string.Join("; ", attempted));
    }

    internal async Task<FixtureEvidence> SnapshotEvidenceAsync()
    {
        var observations = new List<FixtureObservation>();
        var executionCounts = new Dictionary<string, long>(StringComparer.Ordinal);
        var methodCounts = new Dictionary<string, long>(StringComparer.Ordinal);
        string? fixtureContract = null;
        long openSocketCount = 0;
        var crashed = false;

        JObject? fields = null;
        for (var page = 0; page < 64; page++)
        {
            JObject result = await SendControlAsync(
                "snapshot_evidence",
                fields).ConfigureAwait(false);
            fixtureContract ??= result.Value<string>("fixtureContract");
            openSocketCount = result.Value<long?>("openSocketCount") ?? 0;
            crashed = result.Value<bool?>("crashed") ?? false;
            AppendObservations(result, observations);
            AppendCounts(result, "executionCounts", "requestId", executionCounts);
            AppendCounts(result, "methodExecutionCounts", "method", methodCounts);

            if (result.Value<bool?>("complete") == true)
            {
                return new FixtureEvidence(
                    fixtureContract ?? string.Empty,
                    observations,
                    executionCounts,
                    methodCounts,
                    openSocketCount,
                    crashed);
            }

            var snapshotId = result.Value<string>("snapshotId") ??
                throw new InvalidOperationException(
                    "The fixture evidence continuation omitted snapshotId.");
            var cursor = result["nextCursor"] as JObject ??
                throw new InvalidOperationException(
                    "The fixture evidence continuation omitted nextCursor.");
            fields = new JObject
            {
                ["snapshotId"] = snapshotId,
                ["cursor"] = cursor.DeepClone(),
            };
        }

        throw new InvalidOperationException(
            "The fixture evidence snapshot did not terminate within 64 pages.");
    }

    internal async Task<JObject> SendControlAsync(
        string action,
        JObject? fields = null)
    {
        ArgumentNullException.ThrowIfNull(action);
        await _controlGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_controlClosed)
            {
                throw new InvalidOperationException(
                    "The add-in loopback fixture control channel is closed.");
            }

            _controlSequence++;
            string correlationId = "m3-control-" +
                _controlSequence.ToString(CultureInfo.InvariantCulture);
            var record = new JObject
            {
                ["controlVersion"] = ControlVersion,
                ["id"] = correlationId,
                ["action"] = action,
            };
            if (fields != null)
            {
                foreach (JProperty property in fields.Properties())
                {
                    record[property.Name] = property.Value.DeepClone();
                }
            }

            await _process.StandardInput
                .WriteAsync(record.ToString(Formatting.None) + "\n")
                .ConfigureAwait(false);
            await _process.StandardInput.FlushAsync().ConfigureAwait(false);

            using var timeout = new CancellationTokenSource(
                TimeSpan.FromSeconds(30));
            string? line = await _process.StandardOutput
                .ReadLineAsync(timeout.Token)
                .ConfigureAwait(false);
            if (line is null)
            {
                throw new InvalidOperationException(
                    "The add-in loopback fixture closed stdout during control " +
                    action + ": " + _standardError);
            }

            JObject response = ParseJsonObject(
                line,
                "add-in loopback fixture control response");
            if (response.Value<int?>("controlVersion") != ControlVersion ||
                !string.Equals(
                    response.Value<string>("id"),
                    correlationId,
                    StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "The fixture emitted an uncorrelated control response.");
            }

            if (response.Value<bool?>("ok") != true)
            {
                throw new InvalidOperationException(
                    "The fixture rejected control " + action + ": " +
                    (response["error"]?.ToString(Formatting.None) ??
                        "<no error>"));
            }

            return response["result"] as JObject ??
                throw new InvalidOperationException(
                    "The fixture control result was not an object.");
        }
        finally
        {
            _controlGate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        try
        {
            if (!_controlClosed && !_process.HasExited)
            {
                await SendControlAsync("shutdown").ConfigureAwait(false);
                _controlClosed = true;
                await WaitForExitAsync(_process).ConfigureAwait(false);
            }
        }
        catch (Exception exception) when (
            exception is InvalidOperationException or
                OperationCanceledException or
                IOException or
                ObjectDisposedException)
        {
            // The fixture is torn down unconditionally below.
        }

        StopProcess(_process);
        _process.Dispose();
        _controlGate.Dispose();
    }

    /// <summary>
    /// Runs the fixture CLI with deliberately unsafe bind arguments and
    /// returns the combined diagnostic text after the process exits.
    /// </summary>
    internal static async Task<(int ExitCode, string Diagnostics)>
        RunRejectedBindAsync(params string[] arguments)
    {
        ArgumentNullException.ThrowIfNull(arguments);
        string repositoryRoot = FindRepositoryRoot();
        await EnsureFixtureBuiltAsync(repositoryRoot).ConfigureAwait(false);

        var startInfo = new ProcessStartInfo
        {
            FileName = OperatingSystem.IsWindows() ? "node.exe" : "node",
            WorkingDirectory = repositoryRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add(FixtureEntrypoint(repositoryRoot));
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = startInfo };
        if (!process.Start())
        {
            throw new InvalidOperationException(
                "The add-in loopback fixture bind probe did not start.");
        }

        Task<string> output = process.StandardOutput.ReadToEndAsync();
        Task<string> error = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(
            TimeSpan.FromSeconds(20));
        try
        {
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            StopProcess(process);
            throw new TimeoutException(
                "The add-in loopback fixture bind probe did not exit.");
        }

        string standardOutput = await output.ConfigureAwait(false);
        string standardError = await error.ConfigureAwait(false);
        return (process.ExitCode, standardOutput + standardError);
    }

    private static void AppendObservations(
        JObject page,
        List<FixtureObservation> observations)
    {
        var entries = page["observations"] as JArray ??
            throw new InvalidOperationException(
                "The fixture evidence page omitted observations.");
        foreach (JToken entry in entries)
        {
            var observation = entry as JObject ??
                throw new InvalidOperationException(
                    "A fixture observation was not an object.");
            observations.Add(new FixtureObservation(
                observation.Value<long?>("sequence") ?? -1,
                observation.Value<string>("requestId"),
                observation.Value<string>("method"),
                observation.Value<string>("phase") ?? string.Empty,
                observation.Value<long?>("executionOrdinal"),
                observation.Value<long?>("payloadBytes"),
                observation.Value<string>("detail")));
        }
    }

    private static void AppendCounts(
        JObject page,
        string arrayName,
        string keyName,
        Dictionary<string, long> counts)
    {
        var entries = page[arrayName] as JArray ??
            throw new InvalidOperationException(
                "The fixture evidence page omitted " + arrayName + ".");
        foreach (JToken entry in entries)
        {
            var record = entry as JObject ??
                throw new InvalidOperationException(
                    "A fixture " + arrayName + " entry was not an object.");
            var key = record.Value<string>(keyName) ??
                throw new InvalidOperationException(
                    "A fixture " + arrayName + " entry omitted " + keyName + ".");
            counts[key] = record.Value<long?>("count") ?? 0;
        }
    }

    private static void RequireReadiness(JObject readiness)
    {
        if (readiness.Value<bool?>("ready") != true ||
            !string.Equals(
                readiness.Value<string>("contract"),
                FixtureContract,
                StringComparison.Ordinal) ||
            readiness.Value<int?>("controlVersion") != ControlVersion)
        {
            throw new InvalidOperationException(
                "The add-in loopback fixture returned an invalid readiness record.");
        }

        var actions = readiness["actions"] as JArray ??
            throw new InvalidOperationException(
                "The fixture readiness record omitted actions.");
        foreach (string required in new[] { "snapshot_evidence", "shutdown" })
        {
            if (!actions.Any(action => string.Equals(
                    action.Value<string>(),
                    required,
                    StringComparison.Ordinal)))
            {
                throw new InvalidOperationException(
                    "The fixture did not advertise the " + required +
                    " control action.");
            }
        }
    }

    private static JObject ParseJsonObject(string line, string label)
    {
        using var textReader = new StringReader(line);
        using var jsonReader = new JsonTextReader(textReader)
        {
            DateParseHandling = DateParseHandling.None,
            FloatParseHandling = FloatParseHandling.Decimal,
        };
        try
        {
            return JObject.Load(jsonReader);
        }
        catch (JsonException exception)
        {
            throw new InvalidOperationException(
                "The " + label + " was not a JSON object: " + line,
                exception);
        }
    }

    private static bool IsRetryableBindFailure(string diagnostics)
    {
        foreach (string marker in new[]
                 {
                     "EADDRINUSE",
                     "EACCES",
                     "WSAEACCES",
                     "EADDRNOTAVAIL",
                     "address already in use",
                 })
        {
            if (diagnostics.Contains(marker, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static void DrainStandardError(
        Process process,
        StringBuilder standardError)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                string text = await process.StandardError
                    .ReadToEndAsync()
                    .ConfigureAwait(false);
                lock (standardError)
                {
                    standardError.Append(text);
                }
            }
            catch (Exception exception) when (
                exception is IOException or ObjectDisposedException)
            {
                // The fixture exited; diagnostics are best effort.
            }
        });
    }

    private static async Task WaitForExitAsync(Process process)
    {
        using var timeout = new CancellationTokenSource(
            TimeSpan.FromSeconds(10));
        try
        {
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            // The caller escalates to a kill.
        }
    }

    private static async Task EnsureFixtureBuiltAsync(string repositoryRoot)
    {
        await BuildGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (string.Equals(
                    _builtRepositoryRoot,
                    repositoryRoot,
                    StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            string packageRoot = Path.Combine(
                repositoryRoot,
                "packages",
                "addin-loopback-fixture");
            var startInfo = new ProcessStartInfo
            {
                FileName = OperatingSystem.IsWindows() ? "node.exe" : "node",
                WorkingDirectory = packageRoot,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add(Path.Combine(
                repositoryRoot,
                "node_modules",
                "typescript",
                "lib",
                "tsc.js"));
            startInfo.ArgumentList.Add("-p");
            startInfo.ArgumentList.Add(
                Path.Combine(packageRoot, "tsconfig.json"));

            using var process = new Process { StartInfo = startInfo };
            if (!process.Start())
            {
                throw new InvalidOperationException(
                    "The add-in loopback fixture build did not start.");
            }

            Task<string> output = process.StandardOutput.ReadToEndAsync();
            Task<string> error = process.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(
                TimeSpan.FromSeconds(120));
            try
            {
                await process.WaitForExitAsync(timeout.Token)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
                when (timeout.IsCancellationRequested)
            {
                StopProcess(process);
                throw new TimeoutException(
                    "The unchanged add-in loopback fixture build exceeded 120 seconds.");
            }

            string standardOutput = await output.ConfigureAwait(false);
            string standardError = await error.ConfigureAwait(false);
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    "The unchanged add-in loopback fixture failed to build: " +
                    standardOutput +
                    standardError);
            }

            if (!File.Exists(FixtureEntrypoint(repositoryRoot)))
            {
                throw new InvalidOperationException(
                    "The add-in loopback fixture build produced no CLI entrypoint.");
            }

            _builtRepositoryRoot = repositoryRoot;
        }
        finally
        {
            BuildGate.Release();
        }
    }

    private static string FixtureEntrypoint(string repositoryRoot) =>
        Path.Combine(
            repositoryRoot,
            "packages",
            "addin-loopback-fixture",
            "dist",
            "cli.js");

    internal static string FindRepositoryRoot()
    {
        foreach (string start in new[]
                 {
                     Directory.GetCurrentDirectory(),
                     AppContext.BaseDirectory,
                 })
        {
            var directory = new DirectoryInfo(start);
            while (directory is not null)
            {
                if (File.Exists(
                        Path.Combine(
                            directory.FullName,
                            "packages",
                            "addin-loopback-fixture",
                            "package.json")) &&
                    File.Exists(
                        Path.Combine(
                            directory.FullName,
                            "packages",
                            "bridge",
                            "RevAgent.Bridge.sln")))
                {
                    return directory.FullName;
                }

                directory = directory.Parent;
            }
        }

        throw new InvalidOperationException(
            "The repository root could not be located for the add-in loopback fixture.");
    }

    private static void StopProcess(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5_000);
            }
        }
        catch (InvalidOperationException)
        {
        }
    }
}
