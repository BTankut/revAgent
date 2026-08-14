using RevAgent.Bridge.Enrollment;

namespace RevAgent.Bridge.Tests.Worker;

public sealed class WorkerEnrollmentArtifactCommandLineTests
{
    private static readonly string ConfigPath =
        Path.GetFullPath(Path.Combine(Path.GetTempPath(), "bridge-config.json"));
    private static readonly string ArtifactPath =
        Path.GetFullPath(Path.Combine(Path.GetTempPath(), "enrollment.json"));

    [Fact]
    public void ExactInternalCommand_ParsesTwoPathOptions()
    {
        WorkerCommand command = WorkerCommandLine.Parse(
            [
                "__re-enroll-file",
                "--config", ConfigPath,
                "--artifact", ArtifactPath,
            ]);

        Assert.Equal(WorkerCommandKind.ReEnrollFile, command.Kind);
        Assert.Equal(ConfigPath, command.ConfigurationPath);
        Assert.Equal(ArtifactPath, command.EnrollmentArtifactPath);
        Assert.False(command.ReEnroll);
    }

    [Theory]
    [InlineData("--extra", "value")]
    [InlineData("--re-enroll", "true")]
    public void ExtraOptions_AreRejected(string name, string value)
    {
        Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(
                [
                    "__re-enroll-file",
                    "--config", ConfigPath,
                    "--artifact", ArtifactPath,
                    name, value,
                ]));
    }

    [Fact]
    public void MissingArtifact_IsRejected()
    {
        Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(
                ["__re-enroll-file", "--config", ConfigPath]));
    }

    [Fact]
    public void NonCanonicalArtifactPath_IsRejected()
    {
        string nonCanonical = Path.Combine(
            Path.GetDirectoryName(ArtifactPath)!,
            ".",
            "enrollment.json");

        Assert.Throws<WorkerCommandLineException>(
            () => WorkerCommandLine.Parse(
                [
                    "__re-enroll-file",
                    "--config", ConfigPath,
                    "--artifact", nonCanonical,
                ]));
    }

    [Fact]
    public void LegacyDoctorCommand_RemainsUnchanged()
    {
        WorkerCommand command = WorkerCommandLine.Parse(
            ["__doctor", "--config", ConfigPath, "--re-enroll", "true"]);

        Assert.Equal(WorkerCommandKind.Doctor, command.Kind);
        Assert.True(command.ReEnroll);
        Assert.Null(command.EnrollmentArtifactPath);
    }

    [Fact]
    public async Task HardDeadline_ReturnsCleanupUncertainWithoutWaitingForAnIgnoringTask()
    {
        var never = new TaskCompletionSource<
            BridgeEnrollmentArtifactConsumerResult>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var started = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);

        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        BridgeEnrollmentArtifactConsumerResult result =
            await Program.RunBoundedEnrollmentArtifactCommandAsync(
                _ =>
                {
                    started.SetResult();
                    return never.Task;
                },
                commandTimeout: TimeSpan.FromMilliseconds(100),
                cancellationLead: TimeSpan.FromMilliseconds(50));
        stopwatch.Stop();

        await started.Task;
        Assert.Equal("cleanup_uncertain", result.Error);
        Assert.Equal(79, result.ExitCode);
        Assert.False(result.SourceAbsent);
        Assert.InRange(
            stopwatch.Elapsed,
            TimeSpan.Zero,
            TimeSpan.FromSeconds(2));
    }
}
