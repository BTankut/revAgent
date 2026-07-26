using System.Diagnostics;
using System.Text;

namespace RevAgent.Bridge.Host.Hosting;

internal sealed record WorkerStartRequest(
    string ExecutablePath,
    string WorkingDirectory,
    IReadOnlyList<string> Arguments,
    IReadOnlyDictionary<string, string> Environment,
    int MaxDiagnosticBytes);

internal sealed record WorkerOneShotRequest(
    string ExecutablePath,
    string WorkingDirectory,
    IReadOnlyList<string> Arguments,
    IReadOnlyDictionary<string, string> Environment,
    int MaxOutputBytes);

internal sealed record WorkerCommandResult(
    int ExitCode,
    string StandardOutput,
    string StandardError,
    bool StandardOutputTruncated,
    bool StandardErrorTruncated);

internal sealed record WorkerProcessDiagnostics(
    string StandardOutput,
    string StandardError,
    bool StandardOutputTruncated,
    bool StandardErrorTruncated);

internal interface IWorkerProcessLauncher
{
    IWorkerProcess Start(WorkerStartRequest request);

    ValueTask<WorkerCommandResult> RunOneShotAsync(
        WorkerOneShotRequest request,
        TimeSpan timeout,
        CancellationToken cancellationToken);
}

internal interface IWorkerProcess : IDisposable
{
    int Id { get; }

    Task<int> WaitForExitAsync(CancellationToken cancellationToken);

    ValueTask<WorkerProcessDiagnostics> GetDiagnosticsAsync();

    void KillTree();
}

internal sealed class SystemWorkerProcessLauncher : IWorkerProcessLauncher
{
    public IWorkerProcess Start(WorkerStartRequest request)
    {
        ValidateRequest(
            request.ExecutablePath,
            request.WorkingDirectory,
            request.MaxDiagnosticBytes);

        Process process = StartProcess(
            request.ExecutablePath,
            request.WorkingDirectory,
            request.Arguments,
            request.Environment);
        return new SystemWorkerProcess(process, request.MaxDiagnosticBytes);
    }

    public async ValueTask<WorkerCommandResult> RunOneShotAsync(
        WorkerOneShotRequest request,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        ValidateRequest(
            request.ExecutablePath,
            request.WorkingDirectory,
            request.MaxOutputBytes);
        if (timeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout));
        }

        using Process process = StartProcess(
            request.ExecutablePath,
            request.WorkingDirectory,
            request.Arguments,
            request.Environment);
        Task<BoundedOutput> stdout = ReadBoundedAsync(
            process.StandardOutput.BaseStream,
            request.MaxOutputBytes);
        Task<BoundedOutput> stderr = ReadBoundedAsync(
            process.StandardError.BaseStream,
            request.MaxOutputBytes);

        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken);
        timeoutSource.CancelAfter(timeout);
        try
        {
            await process.WaitForExitAsync(timeoutSource.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (
            !cancellationToken.IsCancellationRequested)
        {
            TryKillTree(process);
            await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
            throw new TimeoutException(
                $"Worker command exceeded its {timeout.TotalSeconds:0.###} second timeout.");
        }
        catch
        {
            TryKillTree(process);
            throw;
        }

        BoundedOutput stdoutResult = await stdout.ConfigureAwait(false);
        BoundedOutput stderrResult = await stderr.ConfigureAwait(false);
        return new WorkerCommandResult(
            process.ExitCode,
            stdoutResult.Text,
            stderrResult.Text,
            stdoutResult.Truncated,
            stderrResult.Truncated);
    }

    private static Process StartProcess(
        string executablePath,
        string workingDirectory,
        IReadOnlyList<string> arguments,
        IReadOnlyDictionary<string, string> environment)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executablePath,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false,
        };

        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        foreach ((string name, string value) in environment)
        {
            startInfo.Environment[name] = value;
        }

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };
        try
        {
            if (!process.Start())
            {
                throw new InvalidOperationException(
                    $"Failed to start worker executable '{executablePath}'.");
            }

            return process;
        }
        catch
        {
            process.Dispose();
            throw;
        }
    }

    private static void ValidateRequest(
        string executablePath,
        string workingDirectory,
        int maxOutputBytes)
    {
        if (!Path.IsPathFullyQualified(executablePath) ||
            !File.Exists(executablePath))
        {
            throw new InvalidOperationException(
                $"Worker executable is missing or not absolute: '{executablePath}'.");
        }

        if (!Path.IsPathFullyQualified(workingDirectory) ||
            !Directory.Exists(workingDirectory))
        {
            throw new InvalidOperationException(
                $"Worker working directory is missing or not absolute: '{workingDirectory}'.");
        }

        if (maxOutputBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxOutputBytes));
        }
    }

    private static async Task<BoundedOutput> ReadBoundedAsync(
        Stream stream,
        int maxBytes)
    {
        var retained = new MemoryStream(Math.Min(maxBytes, 8192));
        var buffer = new byte[4096];
        bool truncated = false;
        while (true)
        {
            int read = await stream.ReadAsync(buffer).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            int available = maxBytes - checked((int)retained.Length);
            int toRetain = Math.Min(available, read);
            if (toRetain > 0)
            {
                retained.Write(buffer, 0, toRetain);
            }

            if (toRetain != read)
            {
                truncated = true;
            }
        }

        return new BoundedOutput(
            Encoding.UTF8.GetString(retained.GetBuffer(), 0, checked((int)retained.Length)),
            truncated);
    }

    private static void TryKillTree(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException)
        {
            // The process exited between the state check and Kill.
        }
    }

    private sealed record BoundedOutput(string Text, bool Truncated);
}

internal sealed class SystemWorkerProcess : IWorkerProcess
{
    private readonly Process _process;
    private readonly Task<SystemWorkerProcessLauncherBoundedOutput> _stdout;
    private readonly Task<SystemWorkerProcessLauncherBoundedOutput> _stderr;
    private int _disposed;

    internal SystemWorkerProcess(Process process, int maxDiagnosticBytes)
    {
        _process = process;
        _stdout = ReadBoundedAsync(process.StandardOutput.BaseStream, maxDiagnosticBytes);
        _stderr = ReadBoundedAsync(process.StandardError.BaseStream, maxDiagnosticBytes);
    }

    public int Id => _process.Id;

    public async Task<int> WaitForExitAsync(CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        await _process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        return _process.ExitCode;
    }

    public async ValueTask<WorkerProcessDiagnostics> GetDiagnosticsAsync()
    {
        SystemWorkerProcessLauncherBoundedOutput stdout =
            await _stdout.ConfigureAwait(false);
        SystemWorkerProcessLauncherBoundedOutput stderr =
            await _stderr.ConfigureAwait(false);
        return new WorkerProcessDiagnostics(
            stdout.Text,
            stderr.Text,
            stdout.Truncated,
            stderr.Truncated);
    }

    public void KillTree()
    {
        ThrowIfDisposed();
        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException)
        {
            // The process exited between the state check and Kill.
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _process.Dispose();
        }
    }

    private static async Task<SystemWorkerProcessLauncherBoundedOutput> ReadBoundedAsync(
        Stream stream,
        int maxBytes)
    {
        var retained = new MemoryStream(Math.Min(maxBytes, 8192));
        var buffer = new byte[4096];
        bool truncated = false;
        while (true)
        {
            int read = await stream.ReadAsync(buffer).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            int available = maxBytes - checked((int)retained.Length);
            int toRetain = Math.Min(available, read);
            if (toRetain > 0)
            {
                retained.Write(buffer, 0, toRetain);
            }

            if (toRetain != read)
            {
                truncated = true;
            }
        }

        return new SystemWorkerProcessLauncherBoundedOutput(
            Encoding.UTF8.GetString(retained.GetBuffer(), 0, checked((int)retained.Length)),
            truncated);
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(
            Volatile.Read(ref _disposed) != 0,
            this);
    }

    private sealed record SystemWorkerProcessLauncherBoundedOutput(
        string Text,
        bool Truncated);
}
