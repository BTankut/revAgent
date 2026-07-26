using RevAgent.Bridge.Bootstrap.Control;

namespace RevAgent.Bridge.Tests.Control;

public sealed class NamedPipeControlTests
{
    [Fact]
    public async Task RealPipeAttestsBothProcessesAndCarriesLifecycle()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        Guid instanceId = Guid.NewGuid();
        await using HostControlServer server = HostControlServer.Create(instanceId);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        Task<ControlConnection> accept = server
            .AcceptAsync(Environment.ProcessId, timeout.Token)
            .AsTask();
        Task<ControlConnection> connect = WorkerControlClient
            .ConnectAsync(
                server.PipeName,
                Environment.ProcessId,
                instanceId,
                timeout.Token)
            .AsTask();

        await using ControlConnection host = await accept;
        await using ControlConnection worker = await connect;

        await worker.SendAsync(
            new WorkerReady(
                ControlProtocol.Version,
                instanceId,
                Environment.ProcessId,
                "test-version"),
            timeout.Token);
        WorkerReady ready = Assert.IsType<WorkerReady>(
            await host.ReceiveAsync(timeout.Token));
        Assert.Equal(Environment.ProcessId, ready.WorkerPid);

        await host.SendAsync(
            new StopWorker(
                ControlProtocol.Version,
                instanceId,
                "scm_stop",
                DateTimeOffset.UtcNow.AddSeconds(8).ToUnixTimeMilliseconds()),
            timeout.Token);
        Assert.IsType<StopWorker>(
            await worker.ReceiveAsync(timeout.Token));

        await worker.SendAsync(
            new WorkerStopping(
                ControlProtocol.Version,
                instanceId,
                Environment.ProcessId),
            timeout.Token);
        WorkerStopping stopping = Assert.IsType<WorkerStopping>(
            await host.ReceiveAsync(timeout.Token));
        Assert.Equal(Environment.ProcessId, stopping.WorkerPid);
    }

    [Fact]
    public async Task ServerRejectsDifferentConnectedClientPidExpectation()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        Guid instanceId = Guid.NewGuid();
        await using HostControlServer server = HostControlServer.Create(instanceId);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        Task<ControlConnection> accept = server
            .AcceptAsync(Environment.ProcessId + 1, timeout.Token)
            .AsTask();
        await using ControlConnection client = await WorkerControlClient.ConnectAsync(
            server.PipeName,
            Environment.ProcessId,
            instanceId,
            timeout.Token);

        ControlProtocolException error =
            await Assert.ThrowsAsync<ControlProtocolException>(
                async () => await accept);

        Assert.Equal("control_worker_pid_mismatch", error.Code);
    }
}
