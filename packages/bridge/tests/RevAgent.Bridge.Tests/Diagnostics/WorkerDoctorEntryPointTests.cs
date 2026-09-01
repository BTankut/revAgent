using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Bootstrap.Diagnostics;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Diagnostics;

namespace RevAgent.Bridge.Tests.Diagnostics;

public sealed class WorkerDoctorEntryPointTests
{
    [Fact]
    public async Task IsolatedEntryUsesRealScopedReaderNeverCanonicalOrReEnrollment()
    {
        if (!OperatingSystem.IsWindows()) { return; }
        using var fixture = new DoctorFixture();
        int isolated = 0, config = 0, probes = 0;
        var dependencies = Dependencies(fixture) with
        {
            OpenIsolatedState = command => { isolated++; return WorkerDoctorState.Open(command, fixture.Environment); },
            LoadConfiguration = path => { config++; return LoadConfiguration(path); },
            RunProbes = configuration => { probes++; return FakeProbes(configuration); },
        };
        BridgeDoctorReport report = await Program.CreateDoctorReportAsync(fixture.Command, dependencies);
        Assert.Equal(1, isolated);
        Assert.Equal(1, config);
        Assert.Equal(1, probes);
        Assert.Equal("isolated_diagnostic", report.StateScope);
        Assert.False(report.Enrollment!.Enrolled);
        Assert.Null(report.Enrollment.Error);
        string json = JsonSerializer.Serialize(report);
        Assert.Contains("\"stateScope\":\"isolated_diagnostic\"", json);
        Assert.DoesNotContain(fixture.Root, json);
        Assert.DoesNotContain("doctor-state", json);
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Credentials));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("nonempty")]
    [InlineData("access-denied")]
    [InlineData("reader-failure")]
    [InlineData("store-error")]
    [InlineData("insert-after-open")]
    [InlineData("unexpected-enrolled")]
    public async Task IsolatedFailureNeverFallsBackOrLoadsConfigOrProbes(string failure)
    {
        if (!OperatingSystem.IsWindows()) { return; }
        using var fixture = new DoctorFixture();
        int canonical = 0, reEnroll = 0;
        var dependencies = Dependencies(fixture) with
        {
            CreateCanonicalReader = () => { canonical++; throw new InvalidOperationException("canonical forbidden"); },
            ReEnroll = _ => { reEnroll++; throw new InvalidOperationException("mutator/exchange forbidden"); },
            LoadConfiguration = _ => throw new InvalidOperationException("config must not be loaded"),
            RunProbes = _ => throw new InvalidOperationException("must not probe"),
        };
        switch (failure)
        {
            case "unexpected-enrolled":
                dependencies = dependencies with { CreateIsolatedReader = _ => new EnrolledReader() }; break;
            case "missing": Directory.Delete(fixture.Credentials); break;
            case "nonempty": File.WriteAllText(Path.Combine(fixture.State, "unexpected"), "dummy"); break;
            case "access-denied":
                dependencies = dependencies with { OpenIsolatedState = _ => throw new UnauthorizedAccessException("private-path") }; break;
            case "reader-failure":
                dependencies = dependencies with { CreateIsolatedReader = _ => throw new IOException("private-path") }; break;
            case "store-error":
                dependencies = dependencies with
                {
                    CreateIsolatedReader = _ => throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.ReadFailure, "private-path")
                }; break;
            case "insert-after-open":
                dependencies = dependencies with
                {
                    CreateIsolatedReader = lease =>
                {
                    File.WriteAllText(Path.Combine(fixture.Credentials, "device-credential.dpapi"), "dummy");
                    return lease.CreateReader();
                }
                }; break;
        }
        var error = await Assert.ThrowsAsync<WorkerDoctorStateException>(
            () => Program.CreateDoctorReportAsync(fixture.Command, dependencies));
        Assert.Equal("diagnostic_state_invalid", error.Message);
        Assert.Equal(0, canonical);
        Assert.Equal(0, reEnroll);
    }

    [Theory]
    [InlineData((int)WorkerCommandKind.Doctor, true)]
    [InlineData((int)WorkerCommandKind.Run, false)]
    [InlineData((int)WorkerCommandKind.ReEnrollFile, false)]
    [InlineData((int)WorkerCommandKind.Version, false)]
    public async Task ManualInvalidCommandFailsBeforeAnyDependency(int kind, bool reEnroll)
    {
        using var fixture = new DoctorFixture();
        var dependencies = Dependencies(fixture) with
        {
            OpenIsolatedState = _ => throw new InvalidOperationException("must not open state"),
            LoadConfiguration = _ => throw new InvalidOperationException("must not load config"),
        };
        await Assert.ThrowsAsync<WorkerCommandLineException>(() => Program.CreateDoctorReportAsync(
            fixture.Command with { Kind = (WorkerCommandKind)kind, ReEnroll = reEnroll }, dependencies));
    }

    [Fact]
    public async Task OrdinaryDefaultRemainsLazyAndMarkerIsOmittedUsingOnlyFakeCanonicalReader()
    {
        using var fixture = new DoctorFixture();
        int canonical = 0;
        var dependencies = Dependencies(fixture) with
        {
            OpenIsolatedState = _ => throw new InvalidOperationException("must not open isolated state"),
            CreateCanonicalReader = () => { canonical++; return new EmptyReader(); },
        };
        Assert.Equal(0, canonical);
        var report = await Program.CreateDoctorReportAsync(
            fixture.Command with { DiagnosticStateRoot = null }, dependencies);
        Assert.Equal(1, canonical);
        Assert.Null(report.StateScope);
        Assert.DoesNotContain("stateScope", JsonSerializer.Serialize(report));
    }

    private static WorkerDoctorDependencies Dependencies(DoctorFixture fixture) => new(
        () => throw new InvalidOperationException("canonical factory forbidden"),
        command => WorkerDoctorState.Open(command, fixture.Environment),
        lease => lease.CreateReader(), LoadConfiguration, FakeProbes,
        _ => throw new InvalidOperationException("mutator/exchange forbidden"));

    private static ResolvedBridgeConfiguration LoadConfiguration(string path) =>
        BridgeConfigurationLoader.Load(path, new Dictionary<string, string?>());

    private static Task<BridgeDoctorReport> FakeProbes(ResolvedBridgeConfiguration config) =>
        Task.FromResult(new BridgeDoctorReport(BridgeDoctor.ReportSchemaVersion, true, config.ToRedactedReport(),
            new BridgeDoctorGatewayReport("127.0.0.1", 1, true, ["127.0.0.1"], true, false, null),
            new BridgeDoctorAddinReport(1, 1, [1], [new(1, true, null)], 0, false)));

    private sealed class EmptyReader : IBridgeCredentialReader
    {
        public BridgeRuntimeCredentialState? Load() => null;
    }

    private sealed class EnrolledReader : IBridgeCredentialReader
    {
        public BridgeRuntimeCredentialState Load() => new("dummy-fingerprint",
            new BridgeDeviceCredential("dummy-device", new BridgeSecretString("dummy-token"), DateTimeOffset.UnixEpoch));
    }
}
