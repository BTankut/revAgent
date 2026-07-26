namespace RevAgent.Bridge.Host.Platform;

internal enum ServiceRuntimeState
{
    Unknown,
    Stopped,
    StartPending,
    StopPending,
    Running,
}

internal sealed record ServiceDefinition(
    string Name,
    string DisplayName,
    string Description,
    string BinaryPathName,
    string AccountName,
    bool Automatic,
    bool DelayedAutomatic,
    bool OwnProcess,
    bool NormalErrorControl);

internal sealed record ServiceSnapshot(
    string Name,
    string DisplayName,
    string Description,
    string BinaryPathName,
    string AccountName,
    bool Automatic,
    bool DelayedAutomatic,
    bool OwnProcess,
    bool NormalErrorControl,
    ServiceRuntimeState State);

internal interface IServiceControlManager
{
    ValueTask<ServiceSnapshot?> QueryAsync(
        string serviceName,
        CancellationToken cancellationToken);

    ValueTask CreateAsync(
        ServiceDefinition definition,
        CancellationToken cancellationToken);

    ValueTask StartAsync(
        string serviceName,
        TimeSpan timeout,
        CancellationToken cancellationToken);

    ValueTask StopAsync(
        string serviceName,
        TimeSpan timeout,
        CancellationToken cancellationToken);

    ValueTask DeleteAsync(
        string serviceName,
        CancellationToken cancellationToken);
}
