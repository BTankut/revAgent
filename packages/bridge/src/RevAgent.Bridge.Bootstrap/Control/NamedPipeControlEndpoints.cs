using System.IO.Pipes;
using System.Security.Cryptography;

namespace RevAgent.Bridge.Bootstrap.Control;

internal sealed class HostControlServer : IAsyncDisposable
{
    private readonly NamedPipeServerStream _pipe;
    private readonly Guid _instanceId;
    private int _acceptStarted;
    private int _disposed;

    private HostControlServer(
        NamedPipeServerStream pipe,
        string pipeName,
        Guid instanceId)
    {
        _pipe = pipe;
        PipeName = pipeName;
        _instanceId = instanceId;
    }

    internal string PipeName { get; }

    internal static HostControlServer Create(Guid instanceId)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "The production host/worker control pipe is Windows-only.");
        }

        string suffix = Convert.ToHexString(RandomNumberGenerator.GetBytes(16))
            .ToLowerInvariant();
        string pipeName =
            $"{ControlProtocol.PipeNamePrefix}{instanceId:N}.{suffix}";
        var pipe = new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly,
            inBufferSize: 4096,
            outBufferSize: 4096);

        return new HostControlServer(pipe, pipeName, instanceId);
    }

    internal async ValueTask<ControlConnection> AcceptAsync(
        int expectedWorkerPid,
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        if (expectedWorkerPid <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(expectedWorkerPid));
        }

        if (Interlocked.Exchange(ref _acceptStarted, 1) != 0)
        {
            throw new InvalidOperationException(
                "This control server accepts exactly one worker connection.");
        }

        await _pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
        int actualWorkerPid = NamedPipePeerProcess.GetClientProcessId(_pipe.SafePipeHandle);
        if (actualWorkerPid != expectedWorkerPid)
        {
            throw new ControlProtocolException(
                "control_worker_pid_mismatch",
                $"Connected pipe client PID {actualWorkerPid} does not match " +
                $"launched worker PID {expectedWorkerPid}.");
        }

        return new ControlConnection(_pipe, _instanceId);
    }

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _pipe.Dispose();
        }

        return ValueTask.CompletedTask;
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(
            Volatile.Read(ref _disposed) != 0,
            this);
    }
}

internal static class WorkerControlClient
{
    internal static async ValueTask<ControlConnection> ConnectAsync(
        string pipeName,
        int expectedHostPid,
        Guid instanceId,
        CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "The production host/worker control pipe is Windows-only.");
        }

        ValidatePipeName(pipeName);
        if (expectedHostPid <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(expectedHostPid));
        }

        var pipe = new NamedPipeClientStream(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try
        {
            await pipe.ConnectAsync(cancellationToken).ConfigureAwait(false);
            int actualHostPid = NamedPipePeerProcess.GetServerProcessId(pipe.SafePipeHandle);
            if (actualHostPid != expectedHostPid)
            {
                throw new ControlProtocolException(
                    "control_host_pid_mismatch",
                    $"Connected pipe server PID {actualHostPid} does not match " +
                    $"expected host PID {expectedHostPid}.");
            }

            return new ControlConnection(pipe, instanceId);
        }
        catch
        {
            await pipe.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private static void ValidatePipeName(string pipeName)
    {
        if (string.IsNullOrWhiteSpace(pipeName) ||
            pipeName.Length > 240 ||
            !pipeName.StartsWith(
                ControlProtocol.PipeNamePrefix,
                StringComparison.Ordinal) ||
            pipeName.IndexOfAny(['\\', '/', '\0']) >= 0)
        {
            throw new ArgumentException(
                "Control pipe name is missing or invalid.",
                nameof(pipeName));
        }
    }
}
