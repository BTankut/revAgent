using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
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

internal sealed class AttestationHelperLaunchCleanupException
    : Exception
{
    internal AttestationHelperLaunchCleanupException(
        Exception launchFailure,
        IReadOnlyList<Exception> cleanupFailures)
        : base(
            "The attestation helper launch failed and cleanup could not be verified.",
            new AggregateException(
                new[] { launchFailure }
                    .Concat(cleanupFailures)))
    {
        ArgumentNullException.ThrowIfNull(launchFailure);
        ArgumentNullException.ThrowIfNull(cleanupFailures);
        if (cleanupFailures.Count == 0)
        {
            throw new ArgumentException(
                "At least one cleanup failure is required.",
                nameof(cleanupFailures));
        }
    }
}

internal interface IAttestationHelperNativeProcessFactory
{
    IAttestationHelperNativeProcess StartSuspended(
        ProcessStartInfo startInfo,
        IAttestationHelperJob job);
}

internal interface IAttestationHelperNativeProcess : IDisposable
{
    Process Process { get; }

    Stream StandardInput { get; }

    Stream StandardOutput { get; }

    Stream StandardError { get; }

    bool HasExited { get; }

    int ExitCode { get; }

    void Resume();

    bool WaitForExit(TimeSpan timeout);

    Task WaitForExitAsync();
}

internal sealed class WindowsAttestationHelperNativeProcessFactory
    : IAttestationHelperNativeProcessFactory
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitTimeout = 0x00000102;
    private const uint WaitFailed = 0xFFFFFFFF;
    private static readonly nuint ProcThreadAttributeHandleList = 0x00020002;
    private static readonly nuint ProcThreadAttributeJobList = 0x0002000D;

    public IAttestationHelperNativeProcess StartSuspended(
        ProcessStartInfo startInfo,
        IAttestationHelperJob job)
    {
        ArgumentNullException.ThrowIfNull(startInfo);
        ArgumentNullException.ThrowIfNull(job);
        ValidateStartInfo(startInfo);

        AnonymousPipeServerStream? standardInput = null;
        AnonymousPipeServerStream? standardOutput = null;
        AnonymousPipeServerStream? standardError = null;
        SafeFileHandle? processHandle = null;
        SafeFileHandle? threadHandle = null;
        Process? process = null;
        bool childCreated = false;
        try
        {
            standardInput = new AnonymousPipeServerStream(
                PipeDirection.Out,
                HandleInheritability.Inheritable);
            standardOutput = new AnonymousPipeServerStream(
                PipeDirection.In,
                HandleInheritability.Inheritable);
            standardError = new AnonymousPipeServerStream(
                PipeDirection.In,
                HandleInheritability.Inheritable);
            IntPtr childStandardInput =
                ParsePipeHandle(standardInput.GetClientHandleAsString());
            IntPtr childStandardOutput =
                ParsePipeHandle(standardOutput.GetClientHandleAsString());
            IntPtr childStandardError =
                ParsePipeHandle(standardError.GetClientHandleAsString());
            using var attributes = new ProcessThreadAttributeList(
                [
                    childStandardInput,
                    childStandardOutput,
                    childStandardError,
                ],
                job.NativeHandle);
            var startupInfo = new StartupInfoEx
            {
                StartupInfo = new StartupInfo
                {
                    Size = checked((uint)Marshal.SizeOf<StartupInfoEx>()),
                    Flags = StartfUseStdHandles,
                    StandardInput = childStandardInput,
                    StandardOutput = childStandardOutput,
                    StandardError = childStandardError,
                },
                AttributeList = attributes.Pointer,
            };
            using var environment =
                new UnicodeEnvironmentBlock(startInfo.Environment);
            var commandLine = new StringBuilder(
                BuildCommandLine(startInfo));
            if (!CreateProcess(
                    startInfo.FileName,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    inheritHandles: true,
                    CreateSuspended |
                    CreateUnicodeEnvironment |
                    ExtendedStartupInfoPresent |
                    CreateNoWindow,
                    environment.Pointer,
                    startInfo.WorkingDirectory,
                    ref startupInfo,
                    out ProcessInformation information))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            childCreated = true;
            processHandle = new SafeFileHandle(
                information.Process,
                ownsHandle: true);
            threadHandle = new SafeFileHandle(
                information.Thread,
                ownsHandle: true);
            standardInput.DisposeLocalCopyOfClientHandle();
            standardOutput.DisposeLocalCopyOfClientHandle();
            standardError.DisposeLocalCopyOfClientHandle();

            process = Process.GetProcessById(
                checked((int)information.ProcessId));
            _ = process.SafeHandle;
            var result = new SystemAttestationHelperNativeProcess(
                process,
                standardInput,
                standardOutput,
                standardError,
                threadHandle);
            process = null;
            standardInput = null;
            standardOutput = null;
            standardError = null;
            threadHandle = null;
            return result;
        }
        catch (Exception launchFailure)
        {
            if (childCreated)
            {
                IReadOnlyList<Exception> cleanupFailures =
                    CleanupCreatedProcess(
                        job,
                        processHandle);
                if (cleanupFailures.Count != 0)
                {
                    throw new AttestationHelperLaunchCleanupException(
                        launchFailure,
                        cleanupFailures);
                }
            }

            throw;
        }
        finally
        {
            process?.Dispose();
            processHandle?.Dispose();
            threadHandle?.Dispose();
            standardInput?.Dispose();
            standardOutput?.Dispose();
            standardError?.Dispose();
        }
    }

    private static IReadOnlyList<Exception> CleanupCreatedProcess(
        IAttestationHelperJob job,
        SafeFileHandle? processHandle)
    {
        var failures = new List<Exception>();
        try
        {
            job.Terminate();
        }
        catch (Exception exception)
        {
            failures.Add(exception);
        }

        if (processHandle == null ||
            processHandle.IsInvalid ||
            processHandle.IsClosed)
        {
            failures.Add(
                new InvalidOperationException(
                    "The suspended helper process handle is unavailable."));
        }
        else
        {
            uint waitResult = WaitForSingleObject(
                processHandle,
                milliseconds: 2000);
            if (waitResult == WaitTimeout)
            {
                failures.Add(
                    new TimeoutException(
                        "The suspended helper process did not terminate."));
            }
            else if (waitResult == WaitFailed)
            {
                failures.Add(
                    new Win32Exception(Marshal.GetLastWin32Error()));
            }
            else if (waitResult != WaitObject0)
            {
                failures.Add(
                    new InvalidOperationException(
                        "The suspended helper process returned an unexpected wait result."));
            }
        }

        try
        {
            job.VerifyEmpty(TimeSpan.FromSeconds(2));
        }
        catch (Exception exception)
        {
            failures.Add(exception);
        }

        return failures;
    }

    private static void ValidateStartInfo(ProcessStartInfo startInfo)
    {
        if (startInfo.UseShellExecute ||
            !startInfo.RedirectStandardInput ||
            !startInfo.RedirectStandardOutput ||
            !startInfo.RedirectStandardError ||
            string.IsNullOrWhiteSpace(startInfo.FileName) ||
            !Path.IsPathFullyQualified(startInfo.FileName) ||
            string.IsNullOrWhiteSpace(startInfo.WorkingDirectory) ||
            !Path.IsPathFullyQualified(startInfo.WorkingDirectory) ||
            !string.IsNullOrEmpty(startInfo.Arguments))
        {
            throw new InvalidOperationException(
                "The native attestation helper start contract is invalid.");
        }
    }

    private static IntPtr ParsePipeHandle(string value)
    {
        if (!long.TryParse(
                value,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out long handleValue) ||
            handleValue == 0)
        {
            throw new InvalidOperationException(
                "The attestation helper pipe handle is invalid.");
        }

        return new IntPtr(handleValue);
    }

    private static string BuildCommandLine(
        ProcessStartInfo startInfo)
    {
        var commandLine = new StringBuilder(
            QuoteCommandLineArgument(startInfo.FileName));
        foreach (string argument in startInfo.ArgumentList)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteCommandLineArgument(argument));
        }

        return commandLine.ToString();
    }

    private static string QuoteCommandLineArgument(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (value.Length != 0 &&
            !value.Any(character =>
                char.IsWhiteSpace(character) ||
                character == '"'))
        {
            return value;
        }

        var quoted = new StringBuilder(value.Length + 2);
        quoted.Append('"');
        int backslashCount = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashCount++;
                continue;
            }

            if (character == '"')
            {
                quoted.Append('\\', backslashCount * 2 + 1);
                quoted.Append('"');
                backslashCount = 0;
                continue;
            }

            quoted.Append('\\', backslashCount);
            quoted.Append(character);
            backslashCount = 0;
        }

        quoted.Append('\\', backslashCount * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private sealed class UnicodeEnvironmentBlock : IDisposable
    {
        private IntPtr _pointer;

        internal UnicodeEnvironmentBlock(
            IDictionary<string, string?> environment)
        {
            ArgumentNullException.ThrowIfNull(environment);
            var entries = new List<string>();
            foreach ((string key, string? value) in environment
                         .OrderBy(
                             pair => pair.Key,
                             StringComparer.OrdinalIgnoreCase))
            {
                if (string.IsNullOrWhiteSpace(key) ||
                    key.Contains('=') ||
                    key.Contains('\0') ||
                    value == null ||
                    value.Contains('\0'))
                {
                    throw new InvalidOperationException(
                        "The attestation helper environment is invalid.");
                }

                entries.Add($"{key}={value}");
            }

            string block = string.Join('\0', entries) + "\0\0";
            _pointer = Marshal.StringToHGlobalUni(block);
        }

        internal IntPtr Pointer => _pointer;

        public void Dispose()
        {
            IntPtr pointer = Interlocked.Exchange(
                ref _pointer,
                IntPtr.Zero);
            if (pointer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(pointer);
            }
        }
    }

    private sealed class ProcessThreadAttributeList : IDisposable
    {
        private IntPtr _pointer;
        private IntPtr _handleList;
        private IntPtr _jobList;
        private bool _initialized;

        internal ProcessThreadAttributeList(
            IReadOnlyList<IntPtr> inheritedHandles,
            IntPtr jobHandle)
        {
            if (inheritedHandles.Count == 0 ||
                inheritedHandles.Any(handle => handle == IntPtr.Zero) ||
                jobHandle == IntPtr.Zero)
            {
                throw new ArgumentException(
                    "The process attribute handles are incomplete.");
            }

            nuint bytes = 0;
            _ = InitializeProcThreadAttributeList(
                IntPtr.Zero,
                attributeCount: 2,
                flags: 0,
                ref bytes);
            if (bytes == 0)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            _pointer = Marshal.AllocHGlobal(checked((nint)bytes));
            try
            {
                if (!InitializeProcThreadAttributeList(
                        _pointer,
                        attributeCount: 2,
                        flags: 0,
                        ref bytes))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }

                _initialized = true;
                _handleList = Marshal.AllocHGlobal(
                    inheritedHandles.Count * IntPtr.Size);
                for (int index = 0;
                     index < inheritedHandles.Count;
                     index++)
                {
                    Marshal.WriteIntPtr(
                        _handleList,
                        index * IntPtr.Size,
                        inheritedHandles[index]);
                }

                if (!UpdateProcThreadAttribute(
                        _pointer,
                        flags: 0,
                        ProcThreadAttributeHandleList,
                        _handleList,
                        checked((nuint)(
                            inheritedHandles.Count *
                            IntPtr.Size)),
                        IntPtr.Zero,
                        IntPtr.Zero))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }

                _jobList = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(_jobList, jobHandle);
                if (!UpdateProcThreadAttribute(
                        _pointer,
                        flags: 0,
                        ProcThreadAttributeJobList,
                        _jobList,
                        checked((nuint)IntPtr.Size),
                        IntPtr.Zero,
                        IntPtr.Zero))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        internal IntPtr Pointer => _pointer;

        public void Dispose()
        {
            IntPtr pointer = Interlocked.Exchange(
                ref _pointer,
                IntPtr.Zero);
            if (pointer != IntPtr.Zero)
            {
                if (_initialized)
                {
                    DeleteProcThreadAttributeList(pointer);
                    _initialized = false;
                }

                Marshal.FreeHGlobal(pointer);
            }

            IntPtr handleList = Interlocked.Exchange(
                ref _handleList,
                IntPtr.Zero);
            if (handleList != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(handleList);
            }

            IntPtr jobList = Interlocked.Exchange(
                ref _jobList,
                IntPtr.Zero);
            if (jobList != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(jobList);
            }
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        internal uint Size;
        internal string? Reserved;
        internal string? Desktop;
        internal string? Title;
        internal uint X;
        internal uint Y;
        internal uint XSize;
        internal uint YSize;
        internal uint XCountChars;
        internal uint YCountChars;
        internal uint FillAttribute;
        internal uint Flags;
        internal short ShowWindow;
        internal short Reserved2;
        internal IntPtr Reserved2Pointer;
        internal IntPtr StandardInput;
        internal IntPtr StandardOutput;
        internal IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        internal StartupInfo StartupInfo;
        internal IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal IntPtr Process;
        internal IntPtr Thread;
        internal uint ProcessId;
        internal uint ThreadId;
    }

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateProcessW",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        uint flags,
        ref nuint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        nuint attribute,
        IntPtr value,
        nuint size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(
        IntPtr attributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(
        SafeFileHandle handle,
        uint milliseconds);
}

internal sealed class SystemAttestationHelperNativeProcess
    : IAttestationHelperNativeProcess
{
    private readonly SafeFileHandle _primaryThread;
    private int _resumed;
    private int _disposed;

    internal SystemAttestationHelperNativeProcess(
        Process process,
        Stream standardInput,
        Stream standardOutput,
        Stream standardError,
        SafeFileHandle primaryThread)
    {
        Process = process ??
            throw new ArgumentNullException(nameof(process));
        StandardInput = standardInput ??
            throw new ArgumentNullException(nameof(standardInput));
        StandardOutput = standardOutput ??
            throw new ArgumentNullException(nameof(standardOutput));
        StandardError = standardError ??
            throw new ArgumentNullException(nameof(standardError));
        _primaryThread = primaryThread ??
            throw new ArgumentNullException(nameof(primaryThread));
    }

    public Process Process { get; }

    public Stream StandardInput { get; }

    public Stream StandardOutput { get; }

    public Stream StandardError { get; }

    public bool HasExited => Process.HasExited;

    public int ExitCode => Process.ExitCode;

    public void Resume()
    {
        if (Interlocked.Exchange(ref _resumed, 1) != 0)
        {
            throw new InvalidOperationException(
                "The attestation helper primary thread was already resumed.");
        }

        uint previousSuspendCount = ResumeThread(_primaryThread);
        if (previousSuspendCount == uint.MaxValue)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        _primaryThread.Dispose();
    }

    public bool WaitForExit(TimeSpan timeout)
    {
        if (timeout <= TimeSpan.Zero ||
            timeout.TotalMilliseconds > int.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout));
        }

        return Process.WaitForExit(
            checked((int)Math.Ceiling(timeout.TotalMilliseconds)));
    }

    public Task WaitForExitAsync() =>
        Process.WaitForExitAsync(CancellationToken.None);

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _primaryThread.Dispose();
        StandardInput.Dispose();
        StandardOutput.Dispose();
        StandardError.Dispose();
        Process.Dispose();
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(
        SafeFileHandle thread);
}

internal interface IAttestationHelperJob : IDisposable
{
    IntPtr NativeHandle { get; }

    bool IsEmpty { get; }

    void Assign(Process process);

    void Terminate();

    void VerifyEmpty(TimeSpan timeout);
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
    private const int JobObjectBasicAccountingInformationClass = 1;
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

    public IntPtr NativeHandle => _handle.DangerousGetHandle();

    public bool IsEmpty => ReadActiveProcessCount() == 0;

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

    public void VerifyEmpty(TimeSpan timeout)
    {
        if (timeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout));
        }

        Stopwatch stopwatch = Stopwatch.StartNew();
        while (ReadActiveProcessCount() != 0)
        {
            if (stopwatch.Elapsed >= timeout)
            {
                throw new TimeoutException(
                    "The attestation helper Job Object did not become empty.");
            }

            Thread.Sleep(millisecondsTimeout: 10);
        }
    }

    public void Dispose()
    {
        _handle.Dispose();
    }

    private uint ReadActiveProcessCount()
    {
        int length = Marshal.SizeOf<JobObjectBasicAccountingInformation>();
        IntPtr pointer = Marshal.AllocHGlobal(length);
        try
        {
            if (!QueryInformationJobObject(
                    _handle,
                    JobObjectBasicAccountingInformationClass,
                    pointer,
                    checked((uint)length),
                    out _))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            return Marshal.PtrToStructure<
                JobObjectBasicAccountingInformation>(pointer)
                .ActiveProcesses;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
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

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicAccountingInformation
    {
        internal long TotalUserTime;
        internal long TotalKernelTime;
        internal long ThisPeriodTotalUserTime;
        internal long ThisPeriodTotalKernelTime;
        internal uint TotalPageFaultCount;
        internal uint TotalProcesses;
        internal uint ActiveProcesses;
        internal uint TotalTerminatedProcesses;
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
    private static extern bool QueryInformationJobObject(
        SafeJobHandle job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnLength);

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
