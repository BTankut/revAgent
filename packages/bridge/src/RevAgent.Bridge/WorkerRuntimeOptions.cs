namespace RevAgent.Bridge;

internal sealed record WorkerRuntimeOptions(
    string ControlPipeName,
    int ExpectedHostProcessId,
    Guid InstanceId,
    string ConfigurationPath);

internal sealed class WorkerExitState
{
    private int _exitCode;

    internal int ExitCode => Volatile.Read(ref _exitCode);

    internal void Fail() => Interlocked.Exchange(ref _exitCode, 1);
}
