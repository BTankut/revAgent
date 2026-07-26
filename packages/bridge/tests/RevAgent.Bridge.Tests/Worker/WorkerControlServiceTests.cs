using Microsoft.Extensions.Hosting;
using RevAgent.Bridge.Bootstrap.Control;
using RevAgent.Bridge.Bootstrap.Logging;

namespace RevAgent.Bridge.Tests.Worker;

public sealed class WorkerControlServiceTests
{
    [Fact]
    public async Task ReadyThenStopProducesOneStoppingMessage()
    {
        var instanceId = Guid.NewGuid();
        var session = new FakeSession(
            new StopWorker(
                ControlProtocol.Version,
                instanceId,
                "service_stop",
                DateTimeOffset.UtcNow.AddSeconds(8).ToUnixTimeMilliseconds()));
        var lifetime = new FakeLifetime(started: true);
        var service = CreateService(instanceId, session, lifetime);

        await service.StartAsync(CancellationToken.None);
        await WaitUntilAsync(() => lifetime.StopRequested);
        await service.StopAsync(CancellationToken.None);

        Assert.Collection(
            session.Sent,
            message => Assert.IsType<WorkerReady>(message),
            message => Assert.IsType<WorkerStopping>(message));
    }

    [Fact]
    public async Task PipeEofStopsTheWorkerWithoutInventingAStoppingReply()
    {
        var instanceId = Guid.NewGuid();
        var session = new FakeSession(message: null);
        var lifetime = new FakeLifetime(started: true);
        var service = CreateService(instanceId, session, lifetime);

        await service.StartAsync(CancellationToken.None);
        await WaitUntilAsync(() => lifetime.StopRequested);
        await service.StopAsync(CancellationToken.None);

        Assert.Single(session.Sent);
        Assert.IsType<WorkerReady>(session.Sent[0]);
    }

    [Fact]
    public async Task UnexpectedMessageFailsTheWorkerAndRequestsShutdown()
    {
        var instanceId = Guid.NewGuid();
        var session = new FakeSession(
            new WorkerReady(
                ControlProtocol.Version,
                instanceId,
                Environment.ProcessId,
                "unexpected"));
        var lifetime = new FakeLifetime(started: true);
        var exitState = new WorkerExitState();
        var service = CreateService(instanceId, session, lifetime, exitState);

        await service.StartAsync(CancellationToken.None);
        await WaitUntilAsync(() => lifetime.StopRequested);
        await service.StopAsync(CancellationToken.None);

        Assert.Equal(1, exitState.ExitCode);
    }

    [Fact]
    public async Task ReadyWaitsForApplicationStarted()
    {
        var instanceId = Guid.NewGuid();
        var session = new FakeSession(message: null);
        var lifetime = new FakeLifetime(started: false);
        var service = CreateService(instanceId, session, lifetime);

        await service.StartAsync(CancellationToken.None);
        await Task.Delay(50);
        Assert.Empty(session.Sent);

        lifetime.SignalStarted();
        await WaitUntilAsync(() => lifetime.StopRequested);
        await service.StopAsync(CancellationToken.None);

        Assert.IsType<WorkerReady>(Assert.Single(session.Sent));
    }

    private static WorkerControlService CreateService(
        Guid instanceId,
        FakeSession session,
        FakeLifetime lifetime,
        WorkerExitState? exitState = null)
    {
        var options = new WorkerRuntimeOptions(
            "test-pipe",
            Environment.ProcessId,
            instanceId,
            Path.GetFullPath("bridge-config.json"));
        return new WorkerControlService(
            options,
            new FakeSessionFactory(session),
            lifetime,
            new NullLog(),
            exitState ?? new WorkerExitState());
    }

    private static async Task WaitUntilAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!predicate())
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private sealed class FakeSessionFactory : IWorkerControlSessionFactory
    {
        private readonly IWorkerControlSession _session;

        internal FakeSessionFactory(IWorkerControlSession session)
        {
            _session = session;
        }

        public ValueTask<IWorkerControlSession> ConnectAsync(
            WorkerRuntimeOptions options,
            CancellationToken cancellationToken)
        {
            _ = options;
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(_session);
        }
    }

    private sealed class FakeSession : IWorkerControlSession
    {
        private readonly ControlMessage? _message;

        internal FakeSession(ControlMessage? message)
        {
            _message = message;
        }

        internal List<ControlMessage> Sent { get; } = [];

        public ValueTask SendAsync(
            ControlMessage message,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Sent.Add(message);
            return ValueTask.CompletedTask;
        }

        public ValueTask<ControlMessage?> ReceiveAsync(
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(_message);
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class FakeLifetime : IHostApplicationLifetime
    {
        private readonly CancellationTokenSource _started = new();
        private readonly CancellationTokenSource _stopping = new();
        private readonly CancellationTokenSource _stopped = new();

        internal FakeLifetime(bool started)
        {
            if (started)
            {
                _started.Cancel();
            }
        }

        public CancellationToken ApplicationStarted => _started.Token;

        public CancellationToken ApplicationStopping => _stopping.Token;

        public CancellationToken ApplicationStopped => _stopped.Token;

        internal bool StopRequested => _stopping.IsCancellationRequested;

        internal void SignalStarted() => _started.Cancel();

        public void StopApplication()
        {
            _stopping.Cancel();
            _stopped.Cancel();
        }
    }

    private sealed class NullLog : IBridgeLog
    {
        public ValueTask WriteAsync(
            string level,
            string eventId,
            string category,
            string message,
            Exception? exception = null,
            CancellationToken cancellationToken = default)
        {
            _ = level;
            _ = eventId;
            _ = category;
            _ = message;
            _ = exception;
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
