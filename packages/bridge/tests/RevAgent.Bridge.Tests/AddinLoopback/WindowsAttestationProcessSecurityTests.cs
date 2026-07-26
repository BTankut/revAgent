using System.Diagnostics;
using System.Text;
using Microsoft.Win32.SafeHandles;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap;

namespace RevAgent.Bridge.Tests.AddinLoopback;

public sealed class WindowsAttestationProcessSecurityTests
{
    private const string SystemSid = "S-1-5-18";
    private const string StandardUserSid = "S-1-5-21-1-2-3-1001";
    private const string ProgramFilesRoot = @"C:\Program Files";
    private const string VersionsRoot =
        @"C:\Program Files\revAgent\Bridge\versions";
    private const string VersionDirectory =
        @"C:\Program Files\revAgent\Bridge\versions\v1";
    private const string ExecutablePath =
        @"C:\Program Files\revAgent\Bridge\versions\v1\revagent-bridge.exe";

    [Fact]
    public void ResolverDelegatesToCanonicalInstallLayoutAuthority()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var layout = new BridgeInstallLayout(
            @"C:\Program Files\revAgent\Bridge",
            @"C:\ProgramData\revAgent\bridge");
        var authority = new RecordingPathAuthority();
        var resolver = new AttestationHelperExecutableResolver(
            () => ExecutablePath,
            () => VersionDirectory,
            () => layout,
            () => ProgramFilesRoot,
            authority);

        using ResolvedAttestationHelperExecutable resolved =
            resolver.Resolve();

        Assert.Equal(ExecutablePath, authority.ProcessPath);
        Assert.Equal(VersionDirectory, authority.WorkingDirectory);
        Assert.Equal(VersionsRoot, authority.ApprovedVersionsRoot);
        Assert.Equal(ProgramFilesRoot, authority.TrustedProgramFilesRoot);
        Assert.Equal(ExecutablePath, resolved.ExecutablePath);
    }

    [Fact]
    public void PathAuthorityAcceptsCanonicalProtectedVersionExecutable()
    {
        var files = new StubFileTrustInspector();
        var handle = new SafeFileHandle(new IntPtr(1), ownsHandle: false);
        var authority = Authority(
            files,
            DriveType.Fixed,
            handle,
            ExecutablePath);

        using ResolvedAttestationHelperExecutable resolved =
            authority.OpenTrustedExecutable(
                ExecutablePath,
                VersionDirectory,
                VersionsRoot,
                ProgramFilesRoot);

        Assert.Equal(ExecutablePath, resolved.ExecutablePath);
        Assert.Equal(VersionDirectory, resolved.WorkingDirectory);
        Assert.Equal(
            new WindowsFileIdentity(7, 11),
            resolved.Identity);
        Assert.Equal(files.Paths, files.AclReads);
        Assert.False(handle.IsClosed);
    }

    [Theory]
    [InlineData(@"C:\Program Files")]
    [InlineData(@"C:\Program Files\revAgent")]
    [InlineData(@"C:\Program Files\revAgent\Bridge")]
    [InlineData(@"C:\Program Files\revAgent\Bridge\versions")]
    [InlineData(@"C:\Program Files\revAgent\Bridge\versions\v1")]
    [InlineData(ExecutablePath)]
    public void PathAuthorityRejectsReparsePointAnywhereInParentChain(
        string reparsePath)
    {
        var files = new StubFileTrustInspector();
        files.AttributeOverrides[reparsePath] =
            files.GetAttributes(reparsePath) |
            FileAttributes.ReparsePoint;
        var authority = Authority(files);

        Assert.Throws<InvalidOperationException>(
            () => authority.OpenTrustedExecutable(
                ExecutablePath,
                VersionDirectory,
                VersionsRoot,
                ProgramFilesRoot));
    }

    [Fact]
    public void PathAuthorityRejectsNonAdministrativeWriteAcl()
    {
        var files = new StubFileTrustInspector();
        files.AclOverrides[VersionDirectory] =
            new WindowsFileAclEvidence(
                SystemSid,
                true,
                [
                    new WindowsFileAccessRuleEvidence(
                        StandardUserSid,
                        Rights: 0x00000002,
                        IsAllow: true,
                        IsInheritOnly: false),
                ]);
        var authority = Authority(files);

        Assert.Throws<InvalidOperationException>(
            () => authority.OpenTrustedExecutable(
                ExecutablePath,
                VersionDirectory,
                VersionsRoot,
                ProgramFilesRoot));
    }

    [Fact]
    public void PathAuthorityRejectsUntrustedOwner()
    {
        var files = new StubFileTrustInspector();
        files.AclOverrides[ProgramFilesRoot] =
            new WindowsFileAclEvidence(
                StandardUserSid,
                true,
                Array.Empty<WindowsFileAccessRuleEvidence>());
        var authority = Authority(files);

        Assert.Throws<InvalidOperationException>(
            () => authority.OpenTrustedExecutable(
                ExecutablePath,
                VersionDirectory,
                VersionsRoot,
                ProgramFilesRoot));
    }

    [Fact]
    public void PathAuthorityRejectsMissingDacl()
    {
        var files = new StubFileTrustInspector();
        files.AclOverrides[ExecutablePath] =
            new WindowsFileAclEvidence(
                SystemSid,
                false,
                Array.Empty<WindowsFileAccessRuleEvidence>());
        var authority = Authority(files);

        Assert.Throws<InvalidOperationException>(
            () => authority.OpenTrustedExecutable(
                ExecutablePath,
                VersionDirectory,
                VersionsRoot,
                ProgramFilesRoot));
    }

    [Fact]
    public void PathAuthorityRejectsHandleResolvingToDifferentPath()
    {
        var authority = Authority(
            new StubFileTrustInspector(),
            finalPath:
                @"C:\Program Files\revAgent\Bridge\versions\v2\revagent-bridge.exe");

        Assert.Throws<InvalidOperationException>(
            () => authority.OpenTrustedExecutable(
                ExecutablePath,
                VersionDirectory,
                VersionsRoot,
                ProgramFilesRoot));
    }

    [Theory]
    [InlineData(DriveType.Network)]
    [InlineData(DriveType.Removable)]
    [InlineData(DriveType.CDRom)]
    public void PathAuthorityRejectsNonFixedVolume(DriveType driveType)
    {
        var authority = Authority(
            new StubFileTrustInspector(),
            driveType);

        Assert.Throws<InvalidOperationException>(
            () => authority.OpenTrustedExecutable(
                ExecutablePath,
                VersionDirectory,
                VersionsRoot,
                ProgramFilesRoot));
    }

    [Theory]
    [InlineData(@"\\server\share\revagent-bridge.exe")]
    [InlineData(@"\\?\C:\Program Files\revAgent\Bridge\versions\v1\revagent-bridge.exe")]
    [InlineData(@"\\.\C:\Program Files\revAgent\Bridge\versions\v1\revagent-bridge.exe")]
    [InlineData(@"C:\Program Files\revAgent\Bridge\versions\v1\revagent-bridge.exe:evil")]
    public void PathAuthorityRejectsUnapprovedPathForms(string processPath)
    {
        var authority = Authority(new StubFileTrustInspector());

        Assert.Throws<InvalidOperationException>(
            () => authority.OpenTrustedExecutable(
                processPath,
                VersionDirectory,
                VersionsRoot,
                ProgramFilesRoot));
    }

    [Fact]
    public void ReadOnlyPinBlocksExecutableReplacementUntilDisposed()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string directory = Path.Combine(
            Path.GetTempPath(),
            "revagent-attestation-pin-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string executable = Path.Combine(directory, "revagent-bridge.exe");
        string replacement = Path.Combine(directory, "replacement.exe");
        File.WriteAllText(executable, "trusted", Encoding.UTF8);
        File.WriteAllText(replacement, "replacement", Encoding.UTF8);
        try
        {
            var opener = new WindowsReadOnlyFileHandleOpener();
            using (SafeFileHandle pinned = opener.Open(executable))
            {
                Exception? blocked = Record.Exception(
                    () => File.Move(
                        replacement,
                        executable,
                        overwrite: true));
                Assert.True(
                    blocked is IOException or UnauthorizedAccessException,
                    $"Unexpected replacement result: {blocked}");
            }

            File.Move(replacement, executable, overwrite: true);
            Assert.Equal(
                "replacement",
                File.ReadAllText(executable, Encoding.UTF8));
        }
        finally
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }
    }

    [Fact]
    public void ChildImageVerifierAcceptsMatchingPathVolumeAndFileId()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string processPath = Environment.ProcessPath ??
            throw new InvalidOperationException(
                "The test process path is unavailable.");
        var opener = new WindowsReadOnlyFileHandleOpener();
        var identityReader = new WindowsFileIdentityReader();
        SafeFileHandle pinned = opener.Open(processPath);
        WindowsFileHandleEvidence evidence =
            identityReader.Read(pinned);
        using var resolved = new ResolvedAttestationHelperExecutable(
            processPath,
            Path.GetDirectoryName(processPath)!,
            evidence.Identity,
            evidence.FinalPath,
            pinned);
        using Process process = Process.GetCurrentProcess();

        new WindowsAttestationHelperChildImageVerifier(
            opener,
            identityReader).Verify(process, resolved);
    }

    [Fact]
    public void ChildImageVerifierRejectsMismatchedVolumeOrFileId()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string processPath = Environment.ProcessPath ??
            throw new InvalidOperationException(
                "The test process path is unavailable.");
        var opener = new WindowsReadOnlyFileHandleOpener();
        var identityReader = new WindowsFileIdentityReader();
        using SafeFileHandle handle = opener.Open(processPath);
        WindowsFileHandleEvidence actual =
            identityReader.Read(handle);
        using var expected = new ResolvedAttestationHelperExecutable(
            processPath,
            Path.GetDirectoryName(processPath)!,
            actual.Identity with
            {
                FileIndex = actual.Identity.FileIndex + 1,
            },
            actual.FinalPath,
            new NoOpDisposable());
        using Process process = Process.GetCurrentProcess();

        Assert.Throws<InvalidOperationException>(
            () => new WindowsAttestationHelperChildImageVerifier(
                    opener,
                    identityReader)
                .Verify(process, expected));
    }

    [Fact]
    public void ChildEnvironmentIsAllowlistedAndDoesNotInheritSentinel()
    {
        const string sentinel =
            "REVAGENT_ATTESTATION_SECRET_SENTINEL";
        string? previous =
            Environment.GetEnvironmentVariable(sentinel);
        Environment.SetEnvironmentVariable(sentinel, "must-not-leak");
        try
        {
            using ResolvedAttestationHelperExecutable executable =
                FakeResolvedExecutable();

            ProcessStartInfo startInfo =
                SystemAttestationHelperProcessLauncher.CreateStartInfo(
                    executable);

            Assert.False(startInfo.Environment.ContainsKey(sentinel));
            Assert.Equal(
                AttestationHelperProtocol.InternalCommand,
                Assert.Single(startInfo.ArgumentList));
            Assert.All(
                startInfo.Environment.Keys,
                key => Assert.Contains(
                    key,
                    new[]
                    {
                        "SystemRoot",
                        "WINDIR",
                        "TEMP",
                        "TMP",
                        "DOTNET_BUNDLE_EXTRACT_BASE_DIR",
                    },
                    StringComparer.OrdinalIgnoreCase));
        }
        finally
        {
            Environment.SetEnvironmentVariable(sentinel, previous);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task JobObjectTerminationAndCloseKillHelperGrandchildTree(
        bool closeJobHandle)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using Process helper = StartHelperWithGrandchildGate();
        var job = new WindowsAttestationHelperJob();
        Process? grandchild = null;
        try
        {
            Assert.Equal(
                "ready",
                await helper.StandardOutput.ReadLineAsync()
                    .WaitAsync(TimeSpan.FromSeconds(10)));
            job.Assign(helper);
            await helper.StandardInput.WriteLineAsync("spawn");

            string? childProcessIdText =
                await helper.StandardOutput.ReadLineAsync()
                    .WaitAsync(TimeSpan.FromSeconds(10));
            Assert.True(
                int.TryParse(
                    childProcessIdText,
                    out int childProcessId));
            grandchild = Process.GetProcessById(childProcessId);
            Assert.False(helper.HasExited);
            Assert.False(grandchild.HasExited);

            if (closeJobHandle)
            {
                job.Dispose();
            }
            else
            {
                job.Terminate();
            }

            await helper.WaitForExitAsync()
                .WaitAsync(TimeSpan.FromSeconds(5));
            await grandchild.WaitForExitAsync()
                .WaitAsync(TimeSpan.FromSeconds(5));

            Assert.True(helper.HasExited);
            Assert.True(grandchild.HasExited);
        }
        finally
        {
            job.Dispose();
            grandchild?.Dispose();
            TryKillProcessTree(helper);
        }
    }

    private static WindowsAttestationHelperPathAuthority Authority(
        StubFileTrustInspector files,
        DriveType driveType = DriveType.Fixed,
        SafeFileHandle? handle = null,
        string finalPath = ExecutablePath) =>
        new(
            files,
            new StubDriveTypeResolver(driveType),
            new StubHandleOpener(
                handle ??
                new SafeFileHandle(new IntPtr(1), ownsHandle: false)),
            new StubIdentityReader(finalPath));

    private static ResolvedAttestationHelperExecutable
        FakeResolvedExecutable() =>
        new(
            ExecutablePath,
            VersionDirectory,
            new WindowsFileIdentity(7, 11),
            ExecutablePath,
            new NoOpDisposable());

    private static Process StartHelperWithGrandchildGate()
    {
        string powershellPath = Path.Combine(
            Environment.SystemDirectory,
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe");
        Assert.True(File.Exists(powershellPath));
        const string grandchildScript =
            "Start-Sleep -Seconds 300";
        string grandchildEncoded = Convert.ToBase64String(
            Encoding.Unicode.GetBytes(grandchildScript));
        string helperScript =
            $$"""
            $ErrorActionPreference = 'Stop'
            [Console]::Out.WriteLine('ready')
            [Console]::Out.Flush()
            [Console]::In.ReadLine() | Out-Null
            $child = Start-Process `
                -FilePath '{{powershellPath}}' `
                -ArgumentList @(
                    '-NoLogo',
                    '-NoProfile',
                    '-NonInteractive',
                    '-EncodedCommand',
                    '{{grandchildEncoded}}') `
                -WindowStyle Hidden `
                -PassThru
            [Console]::Out.WriteLine($child.Id)
            [Console]::Out.Flush()
            [Console]::In.ReadLine() | Out-Null
            """;
        string encodedHelper = Convert.ToBase64String(
            Encoding.Unicode.GetBytes(helperScript));
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = powershellPath,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            },
            EnableRaisingEvents = true,
        };
        process.StartInfo.ArgumentList.Add("-NoLogo");
        process.StartInfo.ArgumentList.Add("-NoProfile");
        process.StartInfo.ArgumentList.Add("-NonInteractive");
        process.StartInfo.ArgumentList.Add("-EncodedCommand");
        process.StartInfo.ArgumentList.Add(encodedHelper);
        Assert.True(process.Start());
        process.StandardInput.AutoFlush = true;
        return process;
    }

    private static void TryKillProcessTree(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(milliseconds: 2000);
            }
        }
        catch (InvalidOperationException)
        {
        }
    }

    private sealed class StubFileTrustInspector
        : IWindowsFileTrustInspector
    {
        internal StubFileTrustInspector()
        {
            Paths =
            [
                ProgramFilesRoot,
                Path.Combine(ProgramFilesRoot, "revAgent"),
                Path.Combine(ProgramFilesRoot, "revAgent", "Bridge"),
                VersionsRoot,
                VersionDirectory,
                ExecutablePath,
            ];
            foreach (string path in Paths)
            {
                AttributeOverrides[path] =
                    string.Equals(
                        path,
                        ExecutablePath,
                        StringComparison.OrdinalIgnoreCase)
                        ? FileAttributes.Normal
                        : FileAttributes.Directory;
                AclOverrides[path] =
                    new WindowsFileAclEvidence(
                        SystemSid,
                        true,
                        Array.Empty<WindowsFileAccessRuleEvidence>());
            }
        }

        internal IReadOnlyList<string> Paths { get; }

        internal Dictionary<string, FileAttributes> AttributeOverrides
        { get; } =
            new(StringComparer.OrdinalIgnoreCase);

        internal Dictionary<string, WindowsFileAclEvidence> AclOverrides
        { get; } =
            new(StringComparer.OrdinalIgnoreCase);

        internal List<string> AclReads { get; } = new();

        public string GetFullPath(string path) => Path.GetFullPath(path);

        public bool FileExists(string path) =>
            string.Equals(
                path,
                ExecutablePath,
                StringComparison.OrdinalIgnoreCase);

        public FileAttributes GetAttributes(string path) =>
            AttributeOverrides[path];

        public WindowsFileAclEvidence ReadAcl(
            string path,
            bool isDirectory)
        {
            AclReads.Add(path);
            return AclOverrides[path];
        }
    }

    private sealed class RecordingPathAuthority
        : IAttestationHelperPathAuthority
    {
        internal string? ProcessPath { get; private set; }

        internal string? WorkingDirectory { get; private set; }

        internal string? ApprovedVersionsRoot { get; private set; }

        internal string? TrustedProgramFilesRoot { get; private set; }

        public ResolvedAttestationHelperExecutable OpenTrustedExecutable(
            string processPath,
            string workingDirectory,
            string approvedVersionsRoot,
            string trustedProgramFilesRoot)
        {
            ProcessPath = processPath;
            WorkingDirectory = workingDirectory;
            ApprovedVersionsRoot = approvedVersionsRoot;
            TrustedProgramFilesRoot = trustedProgramFilesRoot;
            return FakeResolvedExecutable();
        }
    }

    private sealed class StubDriveTypeResolver
        : IWindowsDriveTypeResolver
    {
        private readonly DriveType _driveType;

        internal StubDriveTypeResolver(DriveType driveType)
        {
            _driveType = driveType;
        }

        public DriveType GetDriveType(string volumeRoot) =>
            _driveType;
    }

    private sealed class StubHandleOpener
        : IWindowsReadOnlyFileHandleOpener
    {
        private readonly SafeFileHandle _handle;

        internal StubHandleOpener(SafeFileHandle handle)
        {
            _handle = handle;
        }

        public SafeFileHandle Open(string path) => _handle;
    }

    private sealed class StubIdentityReader
        : IWindowsFileIdentityReader
    {
        private readonly string _finalPath;

        internal StubIdentityReader(string finalPath)
        {
            _finalPath = finalPath;
        }

        public WindowsFileHandleEvidence Read(SafeFileHandle handle) =>
            new(
                new WindowsFileIdentity(7, 11),
                _finalPath);
    }

    private sealed class NoOpDisposable : IDisposable
    {
        public void Dispose()
        {
        }
    }
}
