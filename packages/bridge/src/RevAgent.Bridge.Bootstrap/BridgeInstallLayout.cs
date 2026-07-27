namespace RevAgent.Bridge.Bootstrap;

internal sealed record BridgeInstallLayout(string InstallRoot, string StateRoot)
{
    internal const string ServiceName = "revAgentBridge";
    internal const string ServiceDisplayName = "revAgent Bridge";
    internal const string ServiceAccount = @"NT SERVICE\revAgentBridge";
    internal const string EventSourceName = "revAgent Bridge";
    internal const string HostExecutableName = "revagent-bridge-host.exe";
    internal const string WorkerExecutableName = "revagent-bridge.exe";

    internal static BridgeInstallLayout Canonical { get; } = new(
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "revAgent",
            "Bridge"),
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "revAgent",
            "bridge"));

    internal string HostExecutablePath =>
        Path.Combine(InstallRoot, HostExecutableName);

    internal string VersionsRoot =>
        Path.Combine(InstallRoot, "versions");

    internal string CurrentWorkerDirectory =>
        Path.Combine(VersionsRoot, "current");

    internal string WorkerExecutablePath =>
        Path.Combine(CurrentWorkerDirectory, WorkerExecutableName);

    internal string ConfigurationPath =>
        Path.Combine(StateRoot, "bridge-config.json");

    internal string HostLogDirectory =>
        Path.Combine(StateRoot, "logs", "host");

    internal string WorkerLogDirectory =>
        Path.Combine(StateRoot, "logs", "worker");

    internal string JournalPath =>
        Path.Combine(StateRoot, "journal.db");

    internal string BundleExtractionRoot =>
        Path.Combine(StateRoot, "bundle-extract");
}
