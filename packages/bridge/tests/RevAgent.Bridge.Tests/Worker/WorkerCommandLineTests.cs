namespace RevAgent.Bridge.Tests.Worker;

public sealed class WorkerCommandLineTests
{
    [Fact]
    public void DiagnosticStateIsExplicitAndDoctorOnly()
    {
        string config = Path.GetFullPath("bridge-config.json");
        string state = Path.GetFullPath("doctor-state");
        WorkerCommand command = WorkerCommandLine.Parse(
            ["__doctor", "--config", config, "--diagnostic-state-root", state]);
        Assert.Equal(state, command.DiagnosticStateRoot);
        Assert.Null(WorkerCommandLine.Parse(
            ["__doctor", "--config", config]).DiagnosticStateRoot);
        foreach (string verb in new[] { "__worker", "__re-enroll-file", "--version", "install", "__attestation-helper" })
        {
            Assert.Throws<WorkerCommandLineException>(() => WorkerCommandLine.Parse(
                [verb, "--config", config, "--diagnostic-state-root", state]));
        }
        Assert.Throws<WorkerCommandLineException>(() => WorkerCommandLine.Parse(
            ["__worker", "--control-pipe", "pipe", "--host-pid", "42",
             "--instance-id", Guid.NewGuid().ToString("D"), "--config", config,
             "--diagnostic-state-root", state]));
        Assert.Throws<WorkerCommandLineException>(() => WorkerCommandLine.Parse(
            ["__re-enroll-file", "--config", config, "--artifact", config,
             "--diagnostic-state-root", state]));
    }

    [Theory]
    [InlineData("")]
    [InlineData("relative")]
    [InlineData("C:\\fixture\\..\\doctor-state")]
    [InlineData("C:\\fixture\\doctor-state.")]
    [InlineData("C:\\fixture\\doctor-state ")]
    [InlineData("C:\\FIXTUR~1\\doctor-state")]
    [InlineData("C:\\fixture\\doctor-state:stream")]
    [InlineData("\\\\server\\share\\doctor-state")]
    [InlineData("\\\\?\\C:\\fixture\\doctor-state")]
    public void DiagnosticStateRejectsNoncanonicalPaths(string state)
    {
        Assert.Throws<WorkerCommandLineException>(() => WorkerCommandLine.Parse(
            ["__doctor", "--config", Path.GetFullPath("bridge-config.json"),
             "--diagnostic-state-root", state]));
    }

    [Fact]
    public void DiagnosticStateRequiresOneValueAndCanonicalConfig()
    {
        string config = Path.GetFullPath("bridge-config.json");
        string state = Path.GetFullPath("doctor-state");
        Assert.Throws<WorkerCommandLineException>(() => WorkerCommandLine.Parse(
            ["__doctor", "--config", config, "--diagnostic-state-root"]));
        Assert.Throws<WorkerCommandLineException>(() => WorkerCommandLine.Parse(
            ["__doctor", "--config", config, "--diagnostic-state-root", state,
             "--diagnostic-state-root", state]));
        Assert.Throws<WorkerCommandLineException>(() => WorkerCommandLine.Parse(
            ["__doctor", "--config", Path.Combine(Path.GetDirectoryName(config)!, ".", "bridge-config.json"),
             "--diagnostic-state-root", state]));
    }

    [Fact]
    public void VersionRequiresExactSingleToken()
    {
        var command = WorkerCommandLine.Parse(["--version"]);

        Assert.Equal(WorkerCommandKind.Version, command.Kind);
        Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(["--version", "extra"]));
    }

    [Fact]
    public void RunParsesTheCompleteHiddenContract()
    {
        var instanceId = Guid.NewGuid();
        var configurationPath = Path.GetFullPath("bridge-config.json");

        var command = WorkerCommandLine.Parse(
        [
            "__worker",
            "--control-pipe",
            "revagent-bridge-control_01",
            "--host-pid",
            "42",
            "--instance-id",
            instanceId.ToString("D"),
            "--config",
            configurationPath,
        ]);

        Assert.Equal(WorkerCommandKind.Run, command.Kind);
        Assert.Equal("revagent-bridge-control_01", command.ControlPipeName);
        Assert.Equal(42, command.ExpectedHostProcessId);
        Assert.Equal(instanceId, command.InstanceId);
        Assert.Equal(configurationPath, command.ConfigurationPath);
    }

    [Theory]
    [InlineData("pipe\\remote")]
    [InlineData("pipe/name")]
    [InlineData("")]
    public void RunRejectsUnsafePipeNames(string pipeName)
    {
        var exception = Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(
            [
                "__worker",
                "--control-pipe",
                pipeName,
                "--host-pid",
                "42",
                "--instance-id",
                Guid.NewGuid().ToString("D"),
                "--config",
                Path.GetFullPath("bridge-config.json"),
            ]));

        Assert.Contains("pipe", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RunRejectsDuplicateMissingAndUnknownOptions()
    {
        var configurationPath = Path.GetFullPath("bridge-config.json");
        var instanceId = Guid.NewGuid().ToString("D");

        Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(
            [
                "__worker",
                "--control-pipe",
                "pipe",
                "--host-pid",
                "42",
                "--host-pid",
                "43",
                "--instance-id",
                instanceId,
                "--config",
                configurationPath,
            ]));
        Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(
            [
                "__worker",
                "--control-pipe",
                "pipe",
                "--host-pid",
                "42",
                "--instance-id",
                instanceId,
            ]));
        Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(
            [
                "__worker",
                "--control-pipe",
                "pipe",
                "--host-pid",
                "42",
                "--instance-id",
                instanceId,
                "--config",
                configurationPath,
                "--worker-path",
                configurationPath,
            ]));
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("1.5")]
    [InlineData("not-a-pid")]
    public void RunRejectsInvalidHostProcessIds(string value)
    {
        Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(
            [
                "__worker",
                "--control-pipe",
                "pipe",
                "--host-pid",
                value,
                "--instance-id",
                Guid.NewGuid().ToString("D"),
                "--config",
                Path.GetFullPath("bridge-config.json"),
            ]));
    }

    [Fact]
    public void RunRejectsNonCanonicalOrEmptyInstanceIds()
    {
        foreach (var value in new[] { Guid.Empty.ToString("D"), Guid.NewGuid().ToString("N"), "bad" })
        {
            Assert.Throws<WorkerCommandLineException>(
                () => WorkerCommandLine.Parse(
                [
                    "__worker",
                    "--control-pipe",
                    "pipe",
                    "--host-pid",
                    "42",
                    "--instance-id",
                    value,
                    "--config",
                    Path.GetFullPath("bridge-config.json"),
                ]));
        }
    }

    [Fact]
    public void DoctorRequiresOnlyAnAbsoluteConfigurationPath()
    {
        var configurationPath = Path.GetFullPath("bridge-config.json");

        var command = WorkerCommandLine.Parse(
            ["__doctor", "--config", configurationPath]);

        Assert.Equal(WorkerCommandKind.Doctor, command.Kind);
        Assert.Equal(configurationPath, command.ConfigurationPath);
        Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(
                ["__doctor", "--config", "relative.json"]));
    }
}
