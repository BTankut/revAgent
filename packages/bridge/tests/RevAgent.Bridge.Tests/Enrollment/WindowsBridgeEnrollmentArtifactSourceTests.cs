using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using RevAgent.Bridge.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

[SupportedOSPlatform("windows")]
public sealed class WindowsBridgeEnrollmentArtifactSourceTests
{
    private static readonly byte[] ArtifactBytes =
        Encoding.UTF8.GetBytes(
            "{\"contractVersion\":\"revagent.m4-enrollment-artifact/v1\"," +
            "\"enrollmentToken\":\"SYNTHETIC-ENROLLMENT-TOKEN-DO-NOT-LOG-0001\"," +
            "\"expiresAtMs\":1786000000000}\n");

    [Fact]
    public void ProtectedArtifact_ReadsOnceThenDeletesWithPositiveAbsence()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        TestFixture fixture = CreateProtectedFixture();
        byte[]? actual = null;
        try
        {
            var source = new WindowsBridgeEnrollmentArtifactSource();
            using IBridgeEnrollmentArtifactLease lease =
                source.Open(fixture.ArtifactPath);

            actual = lease.ReadBounded(8 * 1024);

            Assert.Equal(ArtifactBytes, actual);
            Assert.True(File.Exists(fixture.ArtifactPath));
            Assert.True(lease.DeleteAndProveAbsent());
            Assert.False(File.Exists(fixture.ArtifactPath));
            Assert.True(lease.DeleteAndProveAbsent());
        }
        finally
        {
            if (actual is not null)
            {
                CryptographicOperations.ZeroMemory(actual);
            }

            DeleteTestRoot(fixture.RootPath);
        }
    }

    [Fact]
    public void FirstInstallFactory_PinsMachineOwnershipInsteadOfTheCurrentCaller()
    {
        if (!OperatingSystem.IsWindows()) return;
        TestFixture fixture = CreateProtectedFixture();
        try
        {
            var source = WindowsBridgeEnrollmentArtifactSource.CreateFirstInstall();
            if (WindowsIdentity.GetCurrent().IsSystem)
            {
                using var lease = source.Open(fixture.ArtifactPath);
                Assert.True(lease.DeleteAndProveAbsent());
            }
            else
            {
                var error = Assert.Throws<BridgeEnrollmentArtifactSourceException>(() => source.Open(fixture.ArtifactPath));
                Assert.Equal(WindowsBridgeEnrollmentArtifactSource.InvalidAccessError, error.ErrorCode);
                Assert.True(File.Exists(fixture.ArtifactPath));
            }
        }
        finally { DeleteTestRoot(fixture.RootPath); }
    }

    [Fact]
    public void BroadFileAcl_IsRefusedWithoutLeakingPathOrContent()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        TestFixture fixture = CreateProtectedFixture();
        try
        {
            FileSecurity security = new FileInfo(fixture.ArtifactPath)
                .GetAccessControl(
                    AccessControlSections.Access |
                    AccessControlSections.Owner);
            security.AddAccessRule(
                new FileSystemAccessRule(
                    new SecurityIdentifier(
                        WellKnownSidType.WorldSid,
                        domainSid: null),
                    FileSystemRights.ReadData,
                    AccessControlType.Allow));
            new FileInfo(fixture.ArtifactPath).SetAccessControl(security);

            BridgeEnrollmentArtifactSourceException exception =
                Assert.Throws<BridgeEnrollmentArtifactSourceException>(
                    () => new WindowsBridgeEnrollmentArtifactSource()
                        .Open(fixture.ArtifactPath));

            Assert.Equal(
                WindowsBridgeEnrollmentArtifactSource.InvalidAccessError,
                exception.ErrorCode);
            Assert.False(exception.SourceAbsent);
            Assert.DoesNotContain(
                fixture.ArtifactPath,
                exception.ToString(),
                StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(
                "SYNTHETIC-ENROLLMENT",
                exception.ToString(),
                StringComparison.Ordinal);
        }
        finally
        {
            DeleteTestRoot(fixture.RootPath);
        }
    }

    [Fact]
    public void InheritedFileAcl_IsRefused()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string rootPath = NewTestRoot();
        string artifactPath = Path.Combine(
            rootPath,
            WindowsBridgeEnrollmentArtifactSource.ExpectedFileName);
        try
        {
            _ = Directory.CreateDirectory(rootPath);
            ApplyDirectoryPolicy(rootPath);
            File.WriteAllBytes(artifactPath, ArtifactBytes);
            Assert.False(
                new FileInfo(artifactPath)
                    .GetAccessControl(AccessControlSections.Access)
                    .AreAccessRulesProtected);

            BridgeEnrollmentArtifactSourceException exception =
                Assert.Throws<BridgeEnrollmentArtifactSourceException>(
                    () => new WindowsBridgeEnrollmentArtifactSource()
                        .Open(artifactPath));

            Assert.Equal(
                WindowsBridgeEnrollmentArtifactSource.InvalidAccessError,
                exception.ErrorCode);
        }
        finally
        {
            DeleteTestRoot(rootPath);
        }
    }

    [Fact]
    public void ReparseAncestor_IsRefused()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string rootPath = NewTestRoot();
        string targetPath = Path.Combine(rootPath, "target");
        string linkPath = Path.Combine(rootPath, "redirect");
        string artifactPath = Path.Combine(
            targetPath,
            WindowsBridgeEnrollmentArtifactSource.ExpectedFileName);
        try
        {
            _ = Directory.CreateDirectory(rootPath);
            _ = Directory.CreateDirectory(targetPath);
            ApplyDirectoryPolicy(targetPath);
            File.WriteAllBytes(artifactPath, ArtifactBytes);
            ApplyFilePolicy(artifactPath);
            CreateDirectoryJunction(linkPath, targetPath);
            string linkedArtifactPath = Path.Combine(
                linkPath,
                WindowsBridgeEnrollmentArtifactSource.ExpectedFileName);

            BridgeEnrollmentArtifactSourceException exception =
                Assert.Throws<BridgeEnrollmentArtifactSourceException>(
                    () => new WindowsBridgeEnrollmentArtifactSource()
                        .Open(linkedArtifactPath));

            Assert.Equal(
                WindowsBridgeEnrollmentArtifactSource.InvalidFileError,
                exception.ErrorCode);
            Assert.True(File.Exists(artifactPath));
        }
        finally
        {
            if (Directory.Exists(linkPath))
            {
                Directory.Delete(linkPath);
            }

            DeleteTestRoot(rootPath);
        }
    }

    [Fact]
    public void HardLinkedArtifact_IsRefused()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        TestFixture fixture = CreateProtectedFixture();
        string linkPath = Path.Combine(fixture.RootPath, "artifact-copy.json");
        try
        {
            if (!CreateHardLink(linkPath, fixture.ArtifactPath, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            }

            BridgeEnrollmentArtifactSourceException exception =
                Assert.Throws<BridgeEnrollmentArtifactSourceException>(
                    () => new WindowsBridgeEnrollmentArtifactSource()
                        .Open(fixture.ArtifactPath));

            Assert.Equal(
                WindowsBridgeEnrollmentArtifactSource.InvalidFileError,
                exception.ErrorCode);
            Assert.True(File.Exists(fixture.ArtifactPath));
            Assert.True(File.Exists(linkPath));
        }
        finally
        {
            DeleteTestRoot(fixture.RootPath);
        }
    }

    [Fact]
    public void AlternateDataStream_IsRefused()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        TestFixture fixture = CreateProtectedFixture();
        try
        {
            File.WriteAllText(
                fixture.ArtifactPath + ":synthetic-canary",
                "SYNTHETIC-ADS");

            BridgeEnrollmentArtifactSourceException exception =
                Assert.Throws<BridgeEnrollmentArtifactSourceException>(
                    () => new WindowsBridgeEnrollmentArtifactSource()
                        .Open(fixture.ArtifactPath));

            Assert.Equal(
                WindowsBridgeEnrollmentArtifactSource.InvalidFileError,
                exception.ErrorCode);
            Assert.True(File.Exists(fixture.ArtifactPath));
        }
        finally
        {
            DeleteTestRoot(fixture.RootPath);
        }
    }

    [Fact]
    public void AlternateDataStreamWriteAfterOpen_IsBlockedByPinnedHandle()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        TestFixture fixture = CreateProtectedFixture();
        try
        {
            var source = new WindowsBridgeEnrollmentArtifactSource();
            using IBridgeEnrollmentArtifactLease lease =
                source.Open(fixture.ArtifactPath);
            Assert.Throws<IOException>(
                () => File.WriteAllText(
                    fixture.ArtifactPath + ":synthetic-after-open",
                    "SYNTHETIC-ADS-AFTER-OPEN"));

            byte[] read = lease.ReadBounded(8 * 1024);
            try
            {
                Assert.Equal(ArtifactBytes, read);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(read);
            }

            Assert.True(lease.DeleteAndProveAbsent());
            Assert.False(File.Exists(fixture.ArtifactPath));
        }
        finally
        {
            DeleteTestRoot(fixture.RootPath);
        }
    }

    [Fact]
    public void AlternateDataStreamWriteAfterRead_IsBlockedBeforeDisposition()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        TestFixture fixture = CreateProtectedFixture();
        byte[]? read = null;
        try
        {
            var source = new WindowsBridgeEnrollmentArtifactSource();
            using IBridgeEnrollmentArtifactLease lease =
                source.Open(fixture.ArtifactPath);
            read = lease.ReadBounded(8 * 1024);
            Assert.Throws<IOException>(
                () => File.WriteAllText(
                    fixture.ArtifactPath + ":synthetic-after-read",
                    "SYNTHETIC-ADS-AFTER-READ"));

            Assert.True(lease.DeleteAndProveAbsent());
            Assert.False(File.Exists(fixture.ArtifactPath));
        }
        finally
        {
            if (read is not null)
            {
                CryptographicOperations.ZeroMemory(read);
            }

            DeleteTestRoot(fixture.RootPath);
        }
    }

    [Fact]
    public void ForeignReplacementAfterPinRelease_IsPreserved()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        TestFixture fixture = CreateProtectedFixture();
        string replacementPath = Path.Combine(
            fixture.RootPath,
            "replacement.json");
        byte[] replacement = "SYNTHETIC-FOREIGN-REPLACEMENT"u8.ToArray();
        byte[]? read = null;
        try
        {
            File.WriteAllBytes(replacementPath, replacement);
            ApplyFilePolicy(replacementPath);
            var source = new WindowsBridgeEnrollmentArtifactSource(
                afterReleaseBeforeDelete: path =>
                {
                    File.Delete(path);
                    File.Move(replacementPath, path);
                });
            using IBridgeEnrollmentArtifactLease lease =
                source.Open(fixture.ArtifactPath);
            read = lease.ReadBounded(8 * 1024);

            BridgeEnrollmentArtifactSourceException exception =
                Assert.Throws<BridgeEnrollmentArtifactSourceException>(
                    () => lease.DeleteAndProveAbsent());

            Assert.Equal(
                WindowsBridgeEnrollmentArtifactSource.CleanupUncertainError,
                exception.ErrorCode);
            Assert.False(exception.SourceAbsent);
            Assert.Equal(
                replacement,
                File.ReadAllBytes(fixture.ArtifactPath));
        }
        finally
        {
            if (read is not null)
            {
                CryptographicOperations.ZeroMemory(read);
            }

            CryptographicOperations.ZeroMemory(replacement);
            DeleteTestRoot(fixture.RootPath);
        }
    }

    [Fact]
    public void MissingArtifact_IsReportedAbsentWithoutPathDisclosure()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string rootPath = NewTestRoot();
        string artifactPath = Path.Combine(
            rootPath,
            WindowsBridgeEnrollmentArtifactSource.ExpectedFileName);

        BridgeEnrollmentArtifactSourceException exception =
            Assert.Throws<BridgeEnrollmentArtifactSourceException>(
                () => new WindowsBridgeEnrollmentArtifactSource()
                    .Open(artifactPath));

        Assert.Equal(
            WindowsBridgeEnrollmentArtifactSource.MissingError,
            exception.ErrorCode);
        Assert.True(exception.SourceAbsent);
        Assert.DoesNotContain(
            artifactPath,
            exception.ToString(),
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void DirectoryAtArtifactPath_IsRefusedAsNonFile()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string rootPath = NewTestRoot();
        string artifactPath = Path.Combine(
            rootPath,
            WindowsBridgeEnrollmentArtifactSource.ExpectedFileName);
        try
        {
            _ = Directory.CreateDirectory(artifactPath);

            BridgeEnrollmentArtifactSourceException exception =
                Assert.Throws<BridgeEnrollmentArtifactSourceException>(
                    () => new WindowsBridgeEnrollmentArtifactSource()
                        .Open(artifactPath));

            Assert.Equal(
                WindowsBridgeEnrollmentArtifactSource.InvalidFileError,
                exception.ErrorCode);
            Assert.False(exception.SourceAbsent);
        }
        finally
        {
            DeleteTestRoot(rootPath);
        }
    }

    [Theory]
    [InlineData("wrong-name.json")]
    [InlineData("ENROLLMENT.JSON")]
    public void NonContractLeaf_IsRefused(string leafName)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string path = Path.Combine(NewTestRoot(), leafName);

        BridgeEnrollmentArtifactSourceException exception =
            Assert.Throws<BridgeEnrollmentArtifactSourceException>(
                () => new WindowsBridgeEnrollmentArtifactSource().Open(path));

        Assert.Equal(
            WindowsBridgeEnrollmentArtifactSource.InvalidPathError,
            exception.ErrorCode);
        Assert.DoesNotContain(
            path,
            exception.ToString(),
            StringComparison.OrdinalIgnoreCase);
    }

    private static TestFixture CreateProtectedFixture()
    {
        string rootPath = NewTestRoot();
        string artifactPath = Path.Combine(
            rootPath,
            WindowsBridgeEnrollmentArtifactSource.ExpectedFileName);
        _ = Directory.CreateDirectory(rootPath);
        ApplyDirectoryPolicy(rootPath);
        File.WriteAllBytes(artifactPath, ArtifactBytes);
        ApplyFilePolicy(artifactPath);
        return new TestFixture(rootPath, artifactPath);
    }

    private static void ApplyDirectoryPolicy(string path)
    {
        SecurityIdentifier current = CurrentUser();
        var security = new DirectorySecurity();
        security.SetOwner(current);
        security.SetAccessRuleProtection(
            isProtected: true,
            preserveInheritance: false);
        foreach (SecurityIdentifier principal in AllowedPrincipals(current))
        {
            security.AddAccessRule(
                new FileSystemAccessRule(
                    principal,
                    FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit |
                    InheritanceFlags.ObjectInherit,
                    PropagationFlags.None,
                    AccessControlType.Allow));
        }

        new DirectoryInfo(path).SetAccessControl(security);
    }

    private static void ApplyFilePolicy(string path)
    {
        SecurityIdentifier current = CurrentUser();
        var security = new FileSecurity();
        security.SetOwner(current);
        security.SetAccessRuleProtection(
            isProtected: true,
            preserveInheritance: false);
        foreach (SecurityIdentifier principal in AllowedPrincipals(current))
        {
            security.AddAccessRule(
                new FileSystemAccessRule(
                    principal,
                    FileSystemRights.FullControl,
                    InheritanceFlags.None,
                    PropagationFlags.None,
                    AccessControlType.Allow));
        }

        new FileInfo(path).SetAccessControl(security);
    }

    private static SecurityIdentifier CurrentUser() =>
        WindowsIdentity.GetCurrent().User ??
        throw new InvalidOperationException(
            "The test Windows identity has no user SID.");

    private static IEnumerable<SecurityIdentifier> AllowedPrincipals(
        SecurityIdentifier current) =>
    [
        current,
        new SecurityIdentifier(
            WellKnownSidType.LocalSystemSid,
            domainSid: null),
        new SecurityIdentifier(
            WellKnownSidType.BuiltinAdministratorsSid,
            domainSid: null),
    ];

    private static string NewTestRoot() =>
        Path.Combine(
            Path.GetTempPath(),
            "revagent-enrollment-artifact-source-tests-" +
            Guid.NewGuid().ToString("N"));

    private static void CreateDirectoryJunction(
        string linkPath,
        string targetPath)
    {
        string commandInterpreter = Path.Combine(
            Environment.SystemDirectory,
            "cmd.exe");
        var startInfo = new ProcessStartInfo
        {
            FileName = commandInterpreter,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (string argument in new[]
                 {
                     "/d",
                     "/v:off",
                     "/c",
                     "mklink",
                     "/J",
                     Path.GetFullPath(linkPath),
                     Path.GetFullPath(targetPath),
                 })
        {
            startInfo.ArgumentList.Add(argument);
        }

        using Process process = Process.Start(startInfo) ??
            throw new InvalidOperationException(
                "The junction fixture process did not start.");
        if (!process.WaitForExit(10_000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            throw new TimeoutException(
                "The junction fixture process did not finish.");
        }

        Assert.Equal(0, process.ExitCode);
    }

    private static void DeleteTestRoot(string rootPath)
    {
        for (int attempt = 0; attempt < 20; attempt++)
        {
            if (!Directory.Exists(rootPath))
            {
                return;
            }

            try
            {
                Directory.Delete(rootPath, recursive: true);
                return;
            }
            catch (Exception exception) when (
                attempt < 19 &&
                exception is IOException or UnauthorizedAccessException)
            {
                Thread.Sleep(25);
            }
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(
        string fileName,
        string existingFileName,
        IntPtr securityAttributes);

    private sealed record TestFixture(
        string RootPath,
        string ArtifactPath);
}
