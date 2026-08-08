namespace RevAgent.Bridge.Tests;

/// <summary>
/// Serializes the real TCP/TLS/WSS/CONNECT integration family inside one
/// testhost without disabling parallel execution for the rest of the Bridge
/// suite.
/// </summary>
/// <remarks>
/// Five runner processes may still execute this collection concurrently. That
/// bounded host-level fan-out is intentional: it preserves runner throughput
/// while reducing the former per-process cross-class fan-out to one. The
/// frozen 8080-8085 fixture surface keeps its narrower cross-process lease.
/// </remarks>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class SocketIntegrationCollection
{
    public const string Name = "SocketIntegration";

    internal static readonly TimeSpan CoordinationTimeout =
        TimeSpan.FromSeconds(20);
}
