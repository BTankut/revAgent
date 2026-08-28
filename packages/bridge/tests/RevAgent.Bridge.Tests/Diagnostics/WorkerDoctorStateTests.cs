using System.Security.AccessControl;
using System.Security.Principal;
using System.Diagnostics;
using System.Runtime.InteropServices;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Diagnostics;
using RevAgent.Bridge.Enrollment;

namespace RevAgent.Bridge.Tests.Diagnostics;

public sealed class WorkerDoctorStateTests
{
    [Fact]
    public void EmptyFixtureUsesRealReaderWithoutProtectionOrMutation()
    {
        if (!OperatingSystem.IsWindows()) { return; }
        using var fixture = new DoctorFixture();
        using WorkerDoctorState lease = WorkerDoctorState.Open(fixture.Command, fixture.Environment);
        Assert.IsType<BridgeCredentialReader>(lease.CreateReader());
        var report = BridgeEnrollmentDoctor.CreateStateReport(lease.CreateReader);
        Assert.False(report.Enrolled);
        Assert.False(report.ReEnrollAttempted);
        Assert.Null(report.ReEnrollSucceeded);
        Assert.Null(report.Error);
        Assert.Equal(0, lease.Protector.ProtectCalls);
        Assert.Equal(0, lease.Protector.UnprotectCalls);
        lease.VerifyEmpty();
    }

    [Fact]
    public void ProtectorAlwaysRefusesEvenDummyBytes()
    {
        var protector = new WorkerDoctorState.DiagnosticProtector();
        Assert.Throws<WorkerDoctorStateException>(() => protector.Protect([1, 2, 3]));
        Assert.Throws<WorkerDoctorStateException>(() => protector.Unprotect([1, 2, 3]));
        Assert.Equal(1, protector.ProtectCalls);
        Assert.Equal(1, protector.UnprotectCalls);
    }

    [Theory]
    [InlineData("missing-state")]
    [InlineData("missing-config")]
    [InlineData("missing-credentials")]
    [InlineData("extra-state")]
    [InlineData("credential")]
    [InlineData("residue")]
    public void MissingOrNonemptyStateFailsClosed(string scenario)
    {
        if (!OperatingSystem.IsWindows()) { return; }
        using var fixture = new DoctorFixture();
        switch (scenario)
        {
            case "missing-state": Directory.Delete(fixture.State, true); break;
            case "missing-config": File.Delete(fixture.Config); break;
            case "missing-credentials": Directory.Delete(fixture.Credentials); break;
            case "extra-state": File.WriteAllText(Path.Combine(fixture.State, "journal.db"), "dummy"); break;
            case "credential": File.WriteAllText(Path.Combine(fixture.Credentials, "device-credential.dpapi"), "dummy"); break;
            case "residue": File.WriteAllText(Path.Combine(fixture.Credentials, "machine-identity.dpapi.revagent-write.tmp"), "dummy"); break;
        }
        Assert.Equal("diagnostic_state_invalid", Assert.Throws<WorkerDoctorStateException>(
            () => WorkerDoctorState.Open(fixture.Command, fixture.Environment)).Message);
    }

    [Fact]
    public void PinsPreventStateAndConfigReplacementAndInsertionIsRejected()
    {
        if (!OperatingSystem.IsWindows()) { return; }
        using var fixture = new DoctorFixture();
        using WorkerDoctorState lease = WorkerDoctorState.Open(fixture.Command, fixture.Environment);
        Assert.Throws<IOException>(() => Directory.Move(fixture.State, fixture.State + "-moved"));
        Assert.Throws<IOException>(() => File.Move(fixture.Config, fixture.Config + "-moved"));
        Assert.Throws<IOException>(() => File.WriteAllText(fixture.Config, "replaced"));
        File.WriteAllText(Path.Combine(fixture.Credentials, "device-credential.dpapi"), "dummy-only");
        Assert.Throws<WorkerDoctorStateException>(() => lease.CreateReader().Load());
        Assert.Throws<WorkerDoctorStateException>(lease.VerifyEmpty);
        Assert.Equal(0, lease.Protector.UnprotectCalls);
    }

    [Fact]
    public void CanonicalSurrogateOverlapAndPoisonedTempAreRejected()
    {
        if (!OperatingSystem.IsWindows()) { return; }
        using var fixture = new DoctorFixture();
        foreach (string forbidden in new[] { fixture.State, fixture.Root, fixture.Credentials })
        {
            Assert.Throws<WorkerDoctorStateException>(() => WorkerDoctorState.Open(
                fixture.Command, fixture.Environment with { ForbiddenRoots = [forbidden] }));
        }
        Assert.Throws<WorkerDoctorStateException>(() => WorkerDoctorState.Open(
            fixture.Command, fixture.Environment with { ForbiddenRoots = [fixture.Environment.TempRoot] }));
        Assert.Throws<WorkerDoctorStateException>(() => WorkerDoctorState.Open(
            fixture.Command, fixture.Environment with { TempRoot = fixture.State }));
    }

    [Fact]
    public void RejectsMappedDriveAndUnsupportedAliasesBeforeOpeningPaths()
    {
        if (!OperatingSystem.IsWindows()) { return; }
        Assert.Throws<WorkerCommandLineException>(() => WorkerDoctorState.ValidateArgument(
            "Z:\\fixture\\doctor-state", _ => DriveType.Network));
        foreach (string path in new[] { "C:\\", "C:/fixture/doctor-state", "C:\\fixture\\doctor-state\\", "C:\\fixture\\NUL", "C:\\fixture\\a?b" })
        {
            Assert.Throws<WorkerCommandLineException>(() => WorkerDoctorState.ValidateArgument(path));
        }
    }

    [Theory]
    [InlineData("config")]
    [InlineData("state")]
    [InlineData("credentials")]
    [InlineData("parent")]
    public void ReparseSurrogatesFailClosed(string target)
    {
        if (!OperatingSystem.IsWindows()) { return; }
        using var fixture = new DoctorFixture();
        string path = target switch
        {
            "config" => fixture.Config,
            "state" => fixture.State,
            "credentials" => fixture.Credentials,
            _ => fixture.Root,
        };
        var fileSystem = new FaultingDoctorFileSystem(path);
        Assert.Throws<WorkerDoctorStateException>(() => WorkerDoctorState.Open(
            fixture.Command, fixture.Environment, fileSystem));
        Assert.True(fileSystem.Refused);
    }

    [Theory]
    [InlineData("state")]
    [InlineData("credentials")]
    [InlineData("parent")]
    public void ActualJunctionCannotRedirectTheFixture(string target)
    {
        if (!OperatingSystem.IsWindows()) { return; }
        using var fixture = new DoctorFixture();
        using var destination = new DoctorFixture();
        string path = target switch { "state" => fixture.State, "credentials" => fixture.Credentials, _ => fixture.Root };
        string destinationPath = target switch { "state" => destination.State, "credentials" => destination.Credentials, _ => destination.Root };
        Directory.Delete(path, true);
        CreateJunction(path, destinationPath);
        try
        {
            Assert.Throws<WorkerDoctorStateException>(() => WorkerDoctorState.Open(fixture.Command, fixture.Environment));
        }
        finally { Directory.Delete(path); }
        Assert.Empty(Directory.EnumerateFileSystemEntries(destination.Credentials));
    }

    [Fact]
    public void ConfigHardLinkAndAlternateStreamAreRejected()
    {
        if (!OperatingSystem.IsWindows()) { return; }
        using var fixture = new DoctorFixture();
        string link = Path.Combine(fixture.Root, "dummy-config-link");
        Assert.True(CreateHardLink(link, fixture.Config, IntPtr.Zero));
        Assert.Throws<WorkerDoctorStateException>(() => WorkerDoctorState.Open(fixture.Command, fixture.Environment));
        File.Delete(link);
        File.WriteAllText(fixture.Config + ":dummy-stream", "dummy");
        Assert.Throws<WorkerDoctorStateException>(() => WorkerDoctorState.Open(fixture.Command, fixture.Environment));
    }

    [Fact]
    public void ConfigSwapBetweenMetadataAndDataPinFailsIdentityReadback()
    {
        if (!OperatingSystem.IsWindows()) { return; }
        using var fixture = new DoctorFixture();
        var fileSystem = new SwappingDoctorFileSystem(fixture.Config);
        Assert.Throws<WorkerDoctorStateException>(() => WorkerDoctorState.Open(fixture.Command, fixture.Environment, fileSystem));
        Assert.True(fileSystem.Swapped);
    }

    [Fact]
    public void OwnedFixtureAclRejectsUntrustedWriteAndUnrelatedOwner()
    {
        if (!OperatingSystem.IsWindows()) { return; }
        using var fixture = new DoctorFixture();
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        var descriptor = new DirectorySecurity();
        descriptor.SetOwner(new SecurityIdentifier(WellKnownSidType.WorldSid, null));
        Assert.Throws<WorkerDoctorStateException>(() =>
        {
            if (OperatingSystem.IsWindows()) { WorkerDoctorState.VerifyOwnership(descriptor, identity.User!, identity.Owner!); }
        });
        descriptor.SetOwner(identity.User!);
        descriptor.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.WorldSid, null),
            FileSystemRights.Write, AccessControlType.Allow));
        Assert.Throws<WorkerDoctorStateException>(() =>
        {
            if (OperatingSystem.IsWindows()) { WorkerDoctorState.VerifyOwnership(descriptor, identity.User!, identity.Owner!); }
        });
        var acl = new DirectoryInfo(fixture.State).GetAccessControl();
        acl.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.WorldSid, null),
            FileSystemRights.Write, AccessControlType.Allow));
        new DirectoryInfo(fixture.State).SetAccessControl(acl);
        Assert.Throws<WorkerDoctorStateException>(() => WorkerDoctorState.Open(fixture.Command, fixture.Environment));
    }

    private static void CreateJunction(string path, string target)
    {
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (string argument in new[] { "/d", "/v:off", "/c", "mklink", "/J", path, target })
        {
            start.ArgumentList.Add(argument);
        }
        using Process process = Process.Start(start)!;
        if (!process.WaitForExit(10_000))
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail("Owned junction fixture creation timed out.");
        }
        Assert.Equal(0, process.ExitCode);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(string fileName, string existingFileName, IntPtr securityAttributes);
}

internal sealed class DoctorFixture : IDisposable
{
    internal DoctorFixture()
    {
        Root = Path.Combine(Path.GetTempPath(), "revagent-bridge-service-" + Guid.NewGuid().ToString("N"));
        Config = Path.Combine(Root, "bridge-config.json");
        State = Path.Combine(Root, "doctor-state");
        Credentials = Path.Combine(State, "credentials");
        if (OperatingSystem.IsWindows())
        {
            using WindowsIdentity identity = WindowsIdentity.GetCurrent();
            var security = new DirectorySecurity();
            security.SetOwner(identity.User!);
            security.SetAccessRuleProtection(true, false);
            foreach (SecurityIdentifier sid in new[] { identity.User!,
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null) })
            {
                security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                    PropagationFlags.None, AccessControlType.Allow));
            }
            security.CreateDirectory(Root);
        }
        else { Directory.CreateDirectory(Root); }
        Directory.CreateDirectory(Credentials);
        File.WriteAllText(Config, """
            {"schemaVersion":1,"gateway":{"uri":"wss://localhost:1/bridge/v1"},
             "addin":{"scanStartPort":8080,"scanEndPort":8085},"logging":{"maxFileBytes":65536,"retainedFileCount":3}}
            """);
        Environment = new WorkerDoctorStateEnvironment(
            Path.TrimEndingDirectorySeparator(Path.GetTempPath()), Root,
            [Path.Combine(Path.GetTempPath(), "forbidden-doctor-surrogate-" + Guid.NewGuid().ToString("N"))]);
    }

    internal string Root { get; }
    internal string Config { get; }
    internal string State { get; }
    internal string Credentials { get; }
    internal WorkerDoctorStateEnvironment Environment { get; }
    internal WorkerCommand Command => new(WorkerCommandKind.Doctor,
        ConfigurationPath: Config, DiagnosticStateRoot: State);

    public void Dispose()
    {
        if (Directory.Exists(Root)) { Directory.Delete(Root, true); }
    }
}

internal sealed class FaultingDoctorFileSystem(string faultPath) : IBridgeCredentialFileSystem
{
    private readonly BridgeCredentialFileSystem _real = new();
    internal bool Refused { get; private set; }
    private void Check(string path)
    {
        if (path == faultPath)
        {
            Refused = true;
            throw new IOException("injected reparse/access-denied/swap");
        }
    }
    public BridgePathEntryKind Classify(string path) { Check(path); return _real.Classify(path); }
    public IDisposable PinDirectory(string path) { Check(path); return _real.PinDirectory(path); }
    public IBridgeFilePin PinFile(string path) { Check(path); return _real.PinFile(path); }
    public BridgeFileIdentity GetFileIdentity(string path) { Check(path); return _real.GetFileIdentity(path); }
    public BridgeProtectedFileRead ReadBoundedFile(string path, int maximumBytes) { Check(path); return _real.ReadBoundedFile(path, maximumBytes); }
}

internal sealed class SwappingDoctorFileSystem(string config) : IBridgeCredentialFileSystem
{
    private readonly BridgeCredentialFileSystem _real = new();
    internal bool Swapped { get; private set; }
    public BridgePathEntryKind Classify(string path) => _real.Classify(path);
    public IDisposable PinDirectory(string path) => _real.PinDirectory(path);
    public IBridgeFilePin PinFile(string path)
    {
        IBridgeFilePin pin = _real.PinFile(path);
        if (path == config)
        {
            File.Move(config, config + "-old");
            File.WriteAllText(config, "replacement-dummy");
            Swapped = true;
        }
        return pin;
    }
    public BridgeFileIdentity GetFileIdentity(string path) => _real.GetFileIdentity(path);
    public BridgeProtectedFileRead ReadBoundedFile(string path, int maximumBytes) => _real.ReadBoundedFile(path, maximumBytes);
}
