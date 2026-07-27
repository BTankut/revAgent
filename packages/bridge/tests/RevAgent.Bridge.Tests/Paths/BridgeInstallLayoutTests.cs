using RevAgent.Bridge.Bootstrap;

namespace RevAgent.Bridge.Tests.Paths;

public sealed class BridgeInstallLayoutTests
{
    [Fact]
    public void CustomLayout_UsesStableHostAndVersionedCurrentWorkerPaths()
    {
        var installRoot = Path.Combine("C:", "Program Files", "revAgent", "Bridge");
        var stateRoot = Path.Combine("C:", "ProgramData", "revAgent", "bridge");
        var layout = new BridgeInstallLayout(installRoot, stateRoot);

        Assert.Equal(
            Path.Combine(installRoot, BridgeInstallLayout.HostExecutableName),
            layout.HostExecutablePath);
        Assert.Equal(
            Path.Combine(installRoot, "versions"),
            layout.VersionsRoot);
        Assert.Equal(
            Path.Combine(installRoot, "versions", "current"),
            layout.CurrentWorkerDirectory);
        Assert.Equal(
            Path.Combine(
                installRoot,
                "versions",
                "current",
                BridgeInstallLayout.WorkerExecutableName),
            layout.WorkerExecutablePath);
    }

    [Fact]
    public void MutableStatePaths_StayUnderStateRootWithSeparateLogDirectories()
    {
        var installRoot = Path.Combine("C:", "Program Files", "revAgent", "Bridge");
        var stateRoot = Path.Combine("C:", "ProgramData", "revAgent", "bridge");
        var layout = new BridgeInstallLayout(installRoot, stateRoot);

        Assert.Equal(
            Path.Combine(stateRoot, "bridge-config.json"),
            layout.ConfigurationPath);
        Assert.Equal(
            Path.Combine(stateRoot, "logs", "host"),
            layout.HostLogDirectory);
        Assert.Equal(
            Path.Combine(stateRoot, "logs", "worker"),
            layout.WorkerLogDirectory);
        Assert.NotEqual(layout.HostLogDirectory, layout.WorkerLogDirectory);
        Assert.Equal(
            Path.Combine(stateRoot, "journal.db"),
            layout.JournalPath);
        Assert.Equal(
            Path.Combine(stateRoot, "bundle-extract"),
            layout.BundleExtractionRoot);
    }

    [Fact]
    public void CanonicalLayout_UsesDisjointProgramFilesAndProgramDataRoots()
    {
        var layout = BridgeInstallLayout.Canonical;

        Assert.StartsWith(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            layout.InstallRoot,
            StringComparison.OrdinalIgnoreCase);
        Assert.StartsWith(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            layout.StateRoot,
            StringComparison.OrdinalIgnoreCase);
        Assert.False(
            layout.StateRoot.StartsWith(
                layout.InstallRoot,
                StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ServiceIdentity_IsPinned()
    {
        Assert.Equal("revAgentBridge", BridgeInstallLayout.ServiceName);
        Assert.Equal("revAgent Bridge", BridgeInstallLayout.ServiceDisplayName);
        Assert.Equal(
            @"NT SERVICE\revAgentBridge",
            BridgeInstallLayout.ServiceAccount);
        Assert.Equal("revAgent Bridge", BridgeInstallLayout.EventSourceName);
    }
}
