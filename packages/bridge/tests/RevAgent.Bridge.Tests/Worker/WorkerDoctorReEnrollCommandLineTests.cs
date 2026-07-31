namespace RevAgent.Bridge.Tests.Worker;

public sealed class WorkerDoctorReEnrollCommandLineTests
{
    private static readonly string ConfigPath =
        Path.Combine(Path.GetTempPath(), "bridge-config.json");

    [Fact]
    public void DoctorWithoutFlag_ParsesWithReEnrollDisabled()
    {
        WorkerCommand command = WorkerCommandLine.Parse(
            ["__doctor", "--config", ConfigPath]);

        Assert.Equal(WorkerCommandKind.Doctor, command.Kind);
        Assert.False(command.ReEnroll);
    }

    [Fact]
    public void DoctorWithExplicitTrueFlag_ParsesWithReEnrollEnabled()
    {
        WorkerCommand command = WorkerCommandLine.Parse(
            ["__doctor", "--config", ConfigPath, "--re-enroll", "true"]);

        Assert.Equal(WorkerCommandKind.Doctor, command.Kind);
        Assert.True(command.ReEnroll);
        Assert.Equal(
            Path.GetFullPath(ConfigPath),
            command.ConfigurationPath);
    }

    [Theory]
    [InlineData("false")]
    [InlineData("True")]
    [InlineData("1")]
    [InlineData("yes")]
    public void NonCanonicalReEnrollValues_AreRejected(string value)
    {
        Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(
                ["__doctor", "--config", ConfigPath, "--re-enroll", value]));
    }

    [Fact]
    public void ReEnrollFlagWithoutValue_IsRejected()
    {
        Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(
                ["__doctor", "--config", ConfigPath, "--re-enroll"]));
    }

    [Fact]
    public void ReEnrollFlag_IsNotAcceptedOnTheRunCommand()
    {
        Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(
                [
                    "__worker",
                    "--control-pipe", "pipe-name",
                    "--host-pid", "1234",
                    "--instance-id", Guid.NewGuid().ToString("D"),
                    "--config", ConfigPath,
                    "--re-enroll", "true",
                ]));
    }
}
