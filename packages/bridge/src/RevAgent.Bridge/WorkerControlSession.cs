using RevAgent.Bridge.Bootstrap.Control;

namespace RevAgent.Bridge;

internal interface IWorkerControlSession : IAsyncDisposable
{
    internal ValueTask SendAsync(
        ControlMessage message,
        CancellationToken cancellationToken);

    internal ValueTask<ControlMessage?> ReceiveAsync(
        CancellationToken cancellationToken);
}

internal interface IWorkerControlSessionFactory
{
    internal ValueTask<IWorkerControlSession> ConnectAsync(
        WorkerRuntimeOptions options,
        CancellationToken cancellationToken);
}

internal sealed class NamedPipeWorkerControlSessionFactory :
    IWorkerControlSessionFactory
{
    public async ValueTask<IWorkerControlSession> ConnectAsync(
        WorkerRuntimeOptions options,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(options);
        ControlConnection connection = await WorkerControlClient.ConnectAsync(
            options.ControlPipeName,
            options.ExpectedHostProcessId,
            options.InstanceId,
            cancellationToken).ConfigureAwait(false);
        return new NamedPipeWorkerControlSession(connection);
    }

    private sealed class NamedPipeWorkerControlSession :
        IWorkerControlSession
    {
        private readonly ControlConnection _connection;

        internal NamedPipeWorkerControlSession(ControlConnection connection)
        {
            _connection = connection;
        }

        public ValueTask SendAsync(
            ControlMessage message,
            CancellationToken cancellationToken) =>
            _connection.SendAsync(message, cancellationToken);

        public ValueTask<ControlMessage?> ReceiveAsync(
            CancellationToken cancellationToken) =>
            _connection.ReceiveAsync(cancellationToken);

        public ValueTask DisposeAsync() => _connection.DisposeAsync();
    }
}
