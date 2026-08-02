using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.PowerCutHarness;

/// <summary>
/// The whole executable: hand the arguments to the power-cut child sequence
/// and let the parent test terminate this process at the requested kill
/// point. Nothing else may run here, because anything that runs after the
/// journal is open changes what the abrupt death leaves on disk.
/// </summary>
internal static class Program
{
    private static int Main(string[] args) =>
        RbpJournalPowerCutChild.Run(args);
}
