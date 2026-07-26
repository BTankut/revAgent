using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent.Bridge.AddinLoopback;

internal readonly record struct WindowsFileIdentity(
    uint VolumeSerialNumber,
    ulong FileIndex);

internal sealed record WindowsFileHandleEvidence(
    WindowsFileIdentity Identity,
    string FinalPath);

internal sealed class ResolvedAttestationHelperExecutable : IDisposable
{
    private IDisposable? _pathPin;

    internal ResolvedAttestationHelperExecutable(
        string executablePath,
        string workingDirectory,
        WindowsFileIdentity identity,
        string finalPath,
        IDisposable pathPin)
    {
        ExecutablePath = executablePath ??
            throw new ArgumentNullException(nameof(executablePath));
        WorkingDirectory = workingDirectory ??
            throw new ArgumentNullException(nameof(workingDirectory));
        Identity = identity;
        FinalPath = finalPath ??
            throw new ArgumentNullException(nameof(finalPath));
        _pathPin = pathPin ??
            throw new ArgumentNullException(nameof(pathPin));
    }

    internal string ExecutablePath { get; }

    internal string WorkingDirectory { get; }

    internal WindowsFileIdentity Identity { get; }

    internal string FinalPath { get; }

    public void Dispose()
    {
        Interlocked.Exchange(ref _pathPin, null)?.Dispose();
    }
}

internal interface IAttestationHelperPathAuthority
{
    ResolvedAttestationHelperExecutable OpenTrustedExecutable(
        string processPath,
        string workingDirectory,
        string approvedVersionsRoot,
        string trustedProgramFilesRoot);
}

internal interface IWindowsDriveTypeResolver
{
    DriveType GetDriveType(string volumeRoot);
}

internal interface IWindowsReadOnlyFileHandleOpener
{
    SafeFileHandle Open(string path);
}

internal interface IWindowsFileIdentityReader
{
    WindowsFileHandleEvidence Read(SafeFileHandle handle);
}

internal sealed class WindowsDriveTypeResolver : IWindowsDriveTypeResolver
{
    public DriveType GetDriveType(string volumeRoot) =>
        new DriveInfo(volumeRoot).DriveType;
}

internal sealed class WindowsReadOnlyFileHandleOpener
    : IWindowsReadOnlyFileHandleOpener
{
    public SafeFileHandle Open(string path) =>
        File.OpenHandle(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            FileOptions.None);
}

internal sealed class WindowsFileIdentityReader
    : IWindowsFileIdentityReader
{
    private const int MaximumFinalPathCharacters = 32768;

    public WindowsFileHandleEvidence Read(SafeFileHandle handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        if (handle.IsInvalid || handle.IsClosed)
        {
            throw new InvalidOperationException(
                "The trusted executable handle is unavailable.");
        }

        if (!GetFileInformationByHandle(handle, out ByHandleFileInformation info))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var buffer = new char[MaximumFinalPathCharacters];
        uint length = GetFinalPathNameByHandle(
            handle,
            buffer,
            checked((uint)buffer.Length),
            flags: 0);
        if (length == 0)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        if (length >= buffer.Length)
        {
            throw new PathTooLongException(
                "The trusted executable final path exceeds its bound.");
        }

        string finalPath = NormalizeFinalPath(
            new string(buffer, 0, checked((int)length)));
        ulong fileIndex =
            ((ulong)info.FileIndexHigh << 32) |
            info.FileIndexLow;
        return new WindowsFileHandleEvidence(
            new WindowsFileIdentity(
                info.VolumeSerialNumber,
                fileIndex),
            Path.GetFullPath(finalPath));
    }

    private static string NormalizeFinalPath(string path)
    {
        const string uncPrefix = @"\\?\UNC\";
        const string extendedPrefix = @"\\?\";
        if (path.StartsWith(
                uncPrefix,
                StringComparison.OrdinalIgnoreCase))
        {
            return @"\\" + path[uncPrefix.Length..];
        }

        return path.StartsWith(
            extendedPrefix,
            StringComparison.OrdinalIgnoreCase)
            ? path[extendedPrefix.Length..]
            : path;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        internal uint FileAttributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        internal uint VolumeSerialNumber;
        internal uint FileSizeHigh;
        internal uint FileSizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation information);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "GetFinalPathNameByHandleW",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle file,
        [Out] char[] path,
        uint pathCharacters,
        uint flags);
}

internal sealed class WindowsAttestationHelperPathAuthority
    : IAttestationHelperPathAuthority
{
    private const uint GenericAll = 0x10000000;
    private const uint GenericWrite = 0x40000000;
    private const uint DangerousFileSystemRights =
        GenericAll |
        GenericWrite |
        0x00000002 | // FILE_WRITE_DATA
        0x00000004 | // FILE_APPEND_DATA
        0x00000010 | // FILE_WRITE_EA
        0x00000100 | // FILE_WRITE_ATTRIBUTES
        0x00000040 | // FILE_DELETE_CHILD
        0x00010000 | // DELETE
        0x00040000 | // WRITE_DAC
        0x00080000;  // WRITE_OWNER

    private static readonly HashSet<string> TrustedOwnerSids =
        new(StringComparer.Ordinal)
        {
            "S-1-5-18",
            "S-1-5-32-544",
            "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
        };

    private readonly IWindowsFileTrustInspector _fileInspector;
    private readonly IWindowsDriveTypeResolver _driveTypeResolver;
    private readonly IWindowsReadOnlyFileHandleOpener _handleOpener;
    private readonly IWindowsFileIdentityReader _identityReader;

    internal WindowsAttestationHelperPathAuthority()
        : this(
            new WindowsFileTrustInspector(),
            new WindowsDriveTypeResolver(),
            new WindowsReadOnlyFileHandleOpener(),
            new WindowsFileIdentityReader())
    {
    }

    internal WindowsAttestationHelperPathAuthority(
        IWindowsFileTrustInspector fileInspector,
        IWindowsDriveTypeResolver driveTypeResolver,
        IWindowsReadOnlyFileHandleOpener handleOpener,
        IWindowsFileIdentityReader identityReader)
    {
        _fileInspector = fileInspector ??
            throw new ArgumentNullException(nameof(fileInspector));
        _driveTypeResolver = driveTypeResolver ??
            throw new ArgumentNullException(nameof(driveTypeResolver));
        _handleOpener = handleOpener ??
            throw new ArgumentNullException(nameof(handleOpener));
        _identityReader = identityReader ??
            throw new ArgumentNullException(nameof(identityReader));
    }

    public ResolvedAttestationHelperExecutable OpenTrustedExecutable(
        string processPath,
        string workingDirectory,
        string approvedVersionsRoot,
        string trustedProgramFilesRoot)
    {
        string executable = CanonicalizeLocalPath(processPath);
        string working = Path.TrimEndingDirectorySeparator(
            CanonicalizeLocalPath(workingDirectory));
        string versionsRoot = Path.TrimEndingDirectorySeparator(
            CanonicalizeLocalPath(approvedVersionsRoot));
        string programFilesRoot = Path.TrimEndingDirectorySeparator(
            CanonicalizeLocalPath(trustedProgramFilesRoot));

        EnsureFixedLocalVolume(
            executable,
            versionsRoot,
            programFilesRoot);
        if (!string.Equals(
                Path.GetFileName(executable),
                "revagent-bridge.exe",
                StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(
                Path.GetDirectoryName(executable),
                working,
                StringComparison.OrdinalIgnoreCase) ||
            !IsStrictDescendant(executable, versionsRoot) ||
            !IsStrictDescendant(versionsRoot, programFilesRoot) ||
            !IsSingleVersionDirectory(working, versionsRoot) ||
            !_fileInspector.FileExists(executable))
        {
            throw new InvalidOperationException(
                "The attestation helper is outside the approved Bridge version layout.");
        }

        VerifyPathChain(executable, programFilesRoot);
        SafeFileHandle? pinnedHandle = null;
        try
        {
            pinnedHandle = _handleOpener.Open(executable);
            WindowsFileHandleEvidence evidence =
                _identityReader.Read(pinnedHandle);
            if (!PathEquals(evidence.FinalPath, executable))
            {
                throw new InvalidOperationException(
                    "The attestation helper handle resolved to a different path.");
            }

            var resolved = new ResolvedAttestationHelperExecutable(
                executable,
                working,
                evidence.Identity,
                evidence.FinalPath,
                pinnedHandle);
            pinnedHandle = null;
            return resolved;
        }
        finally
        {
            pinnedHandle?.Dispose();
        }
    }

    private static string CanonicalizeLocalPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) ||
            !Path.IsPathFullyQualified(path) ||
            path.StartsWith(@"\\", StringComparison.Ordinal) ||
            path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith(@"\\.\", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "The attestation helper path must be a normal local absolute path.");
        }

        string canonical = Path.GetFullPath(path);
        string? root = Path.GetPathRoot(canonical);
        if (string.IsNullOrWhiteSpace(root) ||
            canonical[root.Length..].Contains(':'))
        {
            throw new InvalidOperationException(
                "The attestation helper path must not use a device path or alternate data stream.");
        }

        return canonical;
    }

    private void EnsureFixedLocalVolume(
        string executable,
        string versionsRoot,
        string programFilesRoot)
    {
        string executableRoot = Path.GetPathRoot(executable)!;
        string versionsVolumeRoot = Path.GetPathRoot(versionsRoot)!;
        string programFilesVolumeRoot =
            Path.GetPathRoot(programFilesRoot)!;
        if (!string.Equals(
                executableRoot,
                versionsVolumeRoot,
                StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(
                executableRoot,
                programFilesVolumeRoot,
                StringComparison.OrdinalIgnoreCase) ||
            _driveTypeResolver.GetDriveType(executableRoot) !=
                DriveType.Fixed)
        {
            throw new InvalidOperationException(
                "The attestation helper must be on the approved fixed local volume.");
        }
    }

    private void VerifyPathChain(
        string executable,
        string trustedRoot)
    {
        var paths = new Stack<string>();
        paths.Push(executable);
        DirectoryInfo? directory = new FileInfo(executable).Directory;
        while (directory != null)
        {
            paths.Push(directory.FullName);
            if (PathEquals(directory.FullName, trustedRoot))
            {
                break;
            }

            directory = directory.Parent;
        }

        if (directory == null)
        {
            throw new InvalidOperationException(
                "The attestation helper path does not reach its trusted root.");
        }

        foreach (string path in paths)
        {
            FileAttributes attributes = _fileInspector.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException(
                    "The attestation helper path must not traverse a reparse point.");
            }

            VerifyAcl(
                _fileInspector.ReadAcl(
                    path,
                    (attributes & FileAttributes.Directory) != 0));
        }
    }

    private static void VerifyAcl(WindowsFileAclEvidence evidence)
    {
        if (!TrustedOwnerSids.Contains(evidence.OwnerSid) ||
            !evidence.DiscretionaryAclPresent)
        {
            throw new InvalidOperationException(
                "The attestation helper path owner or DACL is untrusted.");
        }

        foreach (WindowsFileAccessRuleEvidence rule in evidence.AccessRules)
        {
            if (!rule.IsAllow ||
                TrustedOwnerSids.Contains(rule.Sid) ||
                (string.Equals(
                     rule.Sid,
                     "S-1-3-0",
                     StringComparison.Ordinal) &&
                 rule.IsInheritOnly))
            {
                continue;
            }

            if ((rule.Rights & DangerousFileSystemRights) != 0)
            {
                throw new InvalidOperationException(
                    "A non-administrative principal can modify the attestation helper path.");
            }
        }
    }

    private static bool IsSingleVersionDirectory(
        string workingDirectory,
        string versionsRoot)
    {
        string relative = Path.GetRelativePath(
            versionsRoot,
            workingDirectory);
        return !string.IsNullOrWhiteSpace(relative) &&
            !string.Equals(relative, ".", StringComparison.Ordinal) &&
            !Path.IsPathFullyQualified(relative) &&
            !relative.Equals("..", StringComparison.Ordinal) &&
            !relative.StartsWith(
                $"..{Path.DirectorySeparatorChar}",
                StringComparison.Ordinal) &&
            !relative.Contains(Path.DirectorySeparatorChar) &&
            !relative.Contains(Path.AltDirectorySeparatorChar);
    }

    private static bool IsStrictDescendant(
        string candidate,
        string root)
    {
        string relative = Path.GetRelativePath(root, candidate);
        return !string.Equals(relative, ".", StringComparison.Ordinal) &&
            !Path.IsPathFullyQualified(relative) &&
            !relative.Equals("..", StringComparison.Ordinal) &&
            !relative.StartsWith(
                $"..{Path.DirectorySeparatorChar}",
                StringComparison.Ordinal) &&
            !relative.StartsWith(
                $"..{Path.AltDirectorySeparatorChar}",
                StringComparison.Ordinal);
    }

    internal static bool PathEquals(string left, string right) =>
        string.Equals(
            Path.GetFullPath(left),
            Path.GetFullPath(right),
            StringComparison.OrdinalIgnoreCase);
}

internal interface IAttestationHelperChildImageVerifier
{
    void Verify(
        Process process,
        ResolvedAttestationHelperExecutable expected);
}

internal sealed class WindowsAttestationHelperChildImageVerifier
    : IAttestationHelperChildImageVerifier
{
    private const int MaximumImagePathCharacters = 32768;
    private readonly IWindowsReadOnlyFileHandleOpener _handleOpener;
    private readonly IWindowsFileIdentityReader _identityReader;

    internal WindowsAttestationHelperChildImageVerifier()
        : this(
            new WindowsReadOnlyFileHandleOpener(),
            new WindowsFileIdentityReader())
    {
    }

    internal WindowsAttestationHelperChildImageVerifier(
        IWindowsReadOnlyFileHandleOpener handleOpener,
        IWindowsFileIdentityReader identityReader)
    {
        _handleOpener = handleOpener ??
            throw new ArgumentNullException(nameof(handleOpener));
        _identityReader = identityReader ??
            throw new ArgumentNullException(nameof(identityReader));
    }

    public void Verify(
        Process process,
        ResolvedAttestationHelperExecutable expected)
    {
        ArgumentNullException.ThrowIfNull(process);
        ArgumentNullException.ThrowIfNull(expected);
        if (process.HasExited)
        {
            throw new InvalidOperationException(
                "The attestation helper exited before image verification.");
        }

        var imagePath = new char[MaximumImagePathCharacters];
        uint imagePathLength = checked((uint)imagePath.Length);
        if (!QueryFullProcessImageName(
                process.SafeHandle,
                flags: 0,
                imagePath,
                ref imagePathLength) ||
            imagePathLength == 0 ||
            imagePathLength >= imagePath.Length)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        string childImagePath = Path.GetFullPath(
            new string(
                imagePath,
                0,
                checked((int)imagePathLength)));
        if (!WindowsAttestationHelperPathAuthority.PathEquals(
                childImagePath,
                expected.ExecutablePath))
        {
            throw new InvalidOperationException(
                "The attestation helper child image path does not match the approved executable.");
        }

        using SafeFileHandle childImageHandle =
            _handleOpener.Open(childImagePath);
        WindowsFileHandleEvidence actual =
            _identityReader.Read(childImageHandle);
        if (actual.Identity != expected.Identity ||
            !WindowsAttestationHelperPathAuthority.PathEquals(
                actual.FinalPath,
                expected.FinalPath) ||
            process.HasExited)
        {
            throw new InvalidOperationException(
                "The attestation helper child image identity changed during launch.");
        }
    }

    [DllImport(
        "kernel32.dll",
        EntryPoint = "QueryFullProcessImageNameW",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(
        SafeProcessHandle process,
        uint flags,
        [Out] char[] executableName,
        ref uint size);
}

internal interface IAttestationHelperJob : IDisposable
{
    void Assign(Process process);

    void Terminate();
}

internal interface IAttestationHelperJobFactory
{
    IAttestationHelperJob Create();
}

internal sealed class WindowsAttestationHelperJobFactory
    : IAttestationHelperJobFactory
{
    public IAttestationHelperJob Create() =>
        new WindowsAttestationHelperJob();
}

internal sealed class WindowsAttestationHelperJob
    : IAttestationHelperJob
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private readonly SafeJobHandle _handle;

    internal WindowsAttestationHelperJob()
    {
        _handle = CreateJobObject(IntPtr.Zero, null);
        if (_handle.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var information = new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation
            {
                LimitFlags = JobObjectLimitKillOnJobClose,
            },
        };
        int length = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
        IntPtr pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(
                    _handle,
                    JobObjectExtendedLimitInformationClass,
                    pointer,
                    checked((uint)length)))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        catch
        {
            _handle.Dispose();
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public void Assign(Process process)
    {
        ArgumentNullException.ThrowIfNull(process);
        if (!AssignProcessToJobObject(_handle, process.SafeHandle))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public void Terminate()
    {
        if (!TerminateJobObject(_handle, exitCode: 1))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public void Dispose()
    {
        _handle.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        internal JobObjectBasicLimitInformation BasicLimitInformation;
        internal IoCounters IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    private sealed class SafeJobHandle
        : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeJobHandle()
            : base(ownsHandle: true)
        {
        }

        protected override bool ReleaseHandle() =>
            CloseHandle(handle);
    }

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateJobObjectW",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern SafeJobHandle CreateJobObject(
        IntPtr jobAttributes,
        string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        SafeJobHandle job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(
        SafeJobHandle job,
        SafeProcessHandle process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(
        SafeJobHandle job,
        uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
