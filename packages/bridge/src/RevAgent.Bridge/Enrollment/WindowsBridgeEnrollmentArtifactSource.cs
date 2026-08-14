using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Enrollment;

/// <summary>
/// Opens the A2 Windows handoff artifact through a pinned, local-only path.
/// The lease owns one no-follow read/delete handle for its whole lifetime and
/// deletes by setting disposition on that handle, never by deleting a later
/// path occupant. Surfaced failures contain only closed codes.
/// </summary>
internal sealed class WindowsBridgeEnrollmentArtifactSource :
    IBridgeEnrollmentArtifactSource
{
    internal const string ExpectedFileName = "enrollment.json";
    internal const string UnsupportedPlatformError = "artifact_platform_refused";
    internal const string InvalidPathError = "artifact_path_refused";
    internal const string MissingError = "artifact_missing";
    internal const string InvalidFileError = "artifact_file_refused";
    internal const string InvalidAccessError = "artifact_access_refused";
    internal const string ChangedError = "artifact_changed";
    internal const string ReadError = "artifact_read_refused";
    internal const string CleanupUncertainError = "cleanup_uncertain";

    private const uint DeleteAccess = 0x00010000;
    private const uint ReadControl = 0x00020000;
    private const uint FileReadAttributes = 0x00000080;
    private const uint GenericRead = 0x80000000;
    private const uint FileShareRead = 0x00000001;
    private const uint OpenExisting = 3;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint FileAttributeDirectory = 0x00000010;
    private const int ErrorFileNotFound = 2;
    private const int ErrorPathNotFound = 3;
    private const int ErrorHandleEof = 38;
    private const int FileDispositionInfo = 4;

    private readonly IBridgeCredentialFileSystem _fileSystem;
    private readonly Func<SecurityIdentifier> _currentUserResolver;
    private readonly Action<string>? _afterReleaseBeforeDelete;

    internal WindowsBridgeEnrollmentArtifactSource(
        IBridgeCredentialFileSystem? fileSystem = null,
        Func<SecurityIdentifier>? currentUserResolver = null,
        Action<string>? afterReleaseBeforeDelete = null)
    {
        _fileSystem = fileSystem ?? new BridgeCredentialFileSystem();
        _currentUserResolver = currentUserResolver ?? ResolveCurrentUser;
        _afterReleaseBeforeDelete = afterReleaseBeforeDelete;
    }

    public IBridgeEnrollmentArtifactLease Open(string filePath)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw Refused(UnsupportedPlatformError, sourceAbsent: false);
        }

        string fullPath = NormalizeExactArtifactPath(filePath);
        string directoryPath = Path.GetDirectoryName(fullPath) ??
            throw Refused(InvalidPathError, sourceAbsent: false);
        SecurityIdentifier currentUser;
        try
        {
            currentUser = _currentUserResolver();
        }
        catch
        {
            throw Refused(InvalidAccessError, sourceAbsent: false);
        }

        IDisposable? directoryPin = null;
        SafeFileHandle? fileHandle = null;
        FileStream? stream = null;
        try
        {
            BridgePathEntryKind initialKind = _fileSystem.Classify(fullPath);
            if (initialKind == BridgePathEntryKind.Missing)
            {
                throw Refused(MissingError, sourceAbsent: true);
            }

            if (initialKind != BridgePathEntryKind.File)
            {
                throw Refused(InvalidFileError, sourceAbsent: false);
            }

            directoryPin = _fileSystem.PinDirectory(directoryPath);
            if (!HasExactNarrowAccess(
                    new DirectoryInfo(directoryPath),
                    currentUser,
                    isDirectory: true))
            {
                throw Refused(InvalidAccessError, sourceAbsent: false);
            }

            fileHandle = OpenOwnedFile(fullPath);
            PinnedFileState state = ReadState(fileHandle);
            if (!state.IsRegularSingleLink ||
                !HasOnlyDefaultDataStream(fullPath) ||
                _fileSystem.GetFileIdentity(fullPath) != state.Identity)
            {
                throw Refused(InvalidFileError, sourceAbsent: false);
            }

            if (!HasExactNarrowAccess(
                    new FileInfo(fullPath),
                    currentUser,
                    isDirectory: false))
            {
                throw Refused(InvalidAccessError, sourceAbsent: false);
            }

            stream = new FileStream(
                fileHandle,
                FileAccess.Read,
                bufferSize: 16 * 1024,
                isAsync: false);
            fileHandle = null;
            var lease = new Lease(
                fullPath,
                directoryPath,
                state,
                currentUser,
                _fileSystem,
                directoryPin,
                stream,
                _afterReleaseBeforeDelete);
            directoryPin = null;
            stream = null;
            return lease;
        }
        catch (BridgeEnrollmentArtifactSourceException)
        {
            throw;
        }
        catch
        {
            throw Refused(InvalidFileError, sourceAbsent: false);
        }
        finally
        {
            try
            {
                stream?.Dispose();
            }
            catch
            {
                // The caller receives only the closed refusal above.
            }

            try
            {
                fileHandle?.Dispose();
            }
            catch
            {
                // The caller receives only the closed refusal above.
            }

            try
            {
                directoryPin?.Dispose();
            }
            catch
            {
                // The caller receives only the closed refusal above.
            }
        }
    }

    private static SafeFileHandle OpenOwnedFile(string fullPath)
    {
        SafeFileHandle handle = CreateFile(
            fullPath,
            GenericRead | DeleteAccess | ReadControl | FileReadAttributes,
            FileShareRead,
            IntPtr.Zero,
            OpenExisting,
            FileFlagOpenReparsePoint,
            IntPtr.Zero);
        if (!handle.IsInvalid)
        {
            return handle;
        }

        int error = Marshal.GetLastPInvokeError();
        handle.Dispose();
        throw error is ErrorFileNotFound or ErrorPathNotFound
            ? Refused(MissingError, sourceAbsent: true)
            : Refused(InvalidFileError, sourceAbsent: false);
    }

    private static string NormalizeExactArtifactPath(string filePath)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(filePath))
            {
                throw new ArgumentException();
            }

            string fullPath =
                BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(
                    filePath);
            if (!string.Equals(
                    fullPath,
                    filePath,
                    StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(
                    Path.GetFileName(fullPath),
                    ExpectedFileName,
                    StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(Path.GetDirectoryName(fullPath)))
            {
                throw new ArgumentException();
            }

            return fullPath;
        }
        catch
        {
            throw Refused(InvalidPathError, sourceAbsent: false);
        }
    }

    private static SecurityIdentifier ResolveCurrentUser()
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException();
        }

        return WindowsIdentity.GetCurrent().User ??
            throw new InvalidOperationException(
                "The current Windows identity has no user SID.");
    }

    [SupportedOSPlatform("windows")]
    private static bool HasExactNarrowAccess(
        FileSystemInfo value,
        SecurityIdentifier currentUser,
        bool isDirectory)
    {
        try
        {
            FileSystemSecurity security = value switch
            {
                DirectoryInfo directory => directory.GetAccessControl(
                    AccessControlSections.Access |
                    AccessControlSections.Owner),
                FileInfo file => file.GetAccessControl(
                    AccessControlSections.Access |
                    AccessControlSections.Owner),
                _ => throw new ArgumentOutOfRangeException(nameof(value)),
            };
            if (!security.AreAccessRulesProtected ||
                security.GetOwner(typeof(SecurityIdentifier)) is not
                    SecurityIdentifier owner ||
                !owner.Equals(currentUser))
            {
                return false;
            }

            SecurityIdentifier[] expectedPrincipals =
            [
                currentUser,
                new SecurityIdentifier(
                    WellKnownSidType.LocalSystemSid,
                    domainSid: null),
                new SecurityIdentifier(
                    WellKnownSidType.BuiltinAdministratorsSid,
                    domainSid: null),
            ];
            var expected = expectedPrincipals
                .Select(static principal => principal.Value)
                .ToHashSet(StringComparer.Ordinal);
            var rights = new Dictionary<string, FileSystemRights>(
                StringComparer.Ordinal);
            foreach (FileSystemAccessRule rule in security.GetAccessRules(
                         includeExplicit: true,
                         includeInherited: true,
                         typeof(SecurityIdentifier)))
            {
                if (rule.IsInherited ||
                    rule.AccessControlType != AccessControlType.Allow ||
                    rule.IdentityReference is not SecurityIdentifier principal ||
                    !expected.Contains(principal.Value) ||
                    (!isDirectory &&
                     (rule.InheritanceFlags != InheritanceFlags.None ||
                      rule.PropagationFlags != PropagationFlags.None)))
                {
                    return false;
                }

                rights[principal.Value] =
                    rights.GetValueOrDefault(principal.Value) |
                    rule.FileSystemRights;
            }

            return rights.Count == expected.Count &&
                   expected.All(
                       principal => rights.TryGetValue(
                                        principal,
                                        out FileSystemRights actual) &&
                                    (actual & FileSystemRights.FullControl) ==
                                    FileSystemRights.FullControl);
        }
        catch
        {
            return false;
        }
    }

    private static bool HasOnlyDefaultDataStream(string filePath)
    {
        IntPtr search = FindFirstStream(
            filePath,
            StreamInfoLevels.FindStreamInfoStandard,
            out Win32FindStreamData streamData,
            flags: 0);
        if (search == new IntPtr(-1))
        {
            return Marshal.GetLastPInvokeError() == ErrorHandleEof;
        }

        try
        {
            while (true)
            {
                if (!string.Equals(
                        streamData.StreamName,
                        "::$DATA",
                        StringComparison.Ordinal))
                {
                    return false;
                }

                if (FindNextStream(search, out streamData))
                {
                    continue;
                }

                return Marshal.GetLastPInvokeError() == ErrorHandleEof;
            }
        }
        finally
        {
            _ = FindClose(search);
        }
    }

    private static PinnedFileState ReadState(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandle(
                handle,
                out ByHandleFileInformation information))
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        }

        return new PinnedFileState(
            new BridgeFileIdentity(
                information.VolumeSerialNumber,
                ((ulong)information.FileIndexHigh << 32) |
                information.FileIndexLow,
                0,
                information.NumberOfLinks),
            information.FileAttributes,
            ((long)information.FileSizeHigh << 32) |
            information.FileSizeLow);
    }

    private static BridgeEnrollmentArtifactSourceException Refused(
        string errorCode,
        bool sourceAbsent) =>
        new(errorCode, sourceAbsent);

    private readonly record struct PinnedFileState(
        BridgeFileIdentity Identity,
        uint Attributes,
        long Length)
    {
        internal bool IsRegularSingleLink =>
            Identity.LinkCount == 1 &&
            (Attributes & FileAttributeReparsePoint) == 0 &&
            (Attributes & FileAttributeDirectory) == 0;

        internal bool SameObjectAndLength(PinnedFileState other) =>
            Identity == other.Identity &&
            Attributes == other.Attributes &&
            Length == other.Length;
    }

    [SupportedOSPlatform("windows")]
    private sealed class Lease : IBridgeEnrollmentArtifactLease
    {
        private readonly object _gate = new();
        private readonly string _filePath;
        private readonly string _directoryPath;
        private readonly PinnedFileState _initialState;
        private readonly SecurityIdentifier _currentUser;
        private readonly IBridgeCredentialFileSystem _fileSystem;
        private readonly Action<string>? _afterReleaseBeforeDelete;
        private IDisposable? _directoryPin;
        private FileStream? _stream;
        private bool _read;
        private bool _deleteAttempted;
        private bool _sourceAbsent;
        private bool _disposed;

        internal Lease(
            string filePath,
            string directoryPath,
            PinnedFileState initialState,
            SecurityIdentifier currentUser,
            IBridgeCredentialFileSystem fileSystem,
            IDisposable directoryPin,
            FileStream stream,
            Action<string>? afterReleaseBeforeDelete)
        {
            _filePath = filePath;
            _directoryPath = directoryPath;
            _initialState = initialState;
            _currentUser = currentUser;
            _fileSystem = fileSystem;
            _directoryPin = directoryPin;
            _stream = stream;
            _afterReleaseBeforeDelete = afterReleaseBeforeDelete;
        }

        public byte[] ReadBounded(int maximumBytes)
        {
            lock (_gate)
            {
                FileStream stream = RequireActiveStream();
                if (_read || maximumBytes <= 0)
                {
                    throw Refused(ReadError, sourceAbsent: false);
                }

                byte[]? content = null;
                try
                {
                    if (!PathStillNamesOwnedFile() ||
                        !HasOnlyDefaultDataStream(_filePath) ||
                        !HasExactNarrowAccess(
                            new DirectoryInfo(_directoryPath),
                            _currentUser,
                            isDirectory: true) ||
                        !HasExactNarrowAccess(
                            new FileInfo(_filePath),
                            _currentUser,
                            isDirectory: false))
                    {
                        throw Refused(ChangedError, sourceAbsent: false);
                    }

                    PinnedFileState before = ReadState(stream.SafeFileHandle);
                    if (!_initialState.SameObjectAndLength(before) ||
                        before.Length is <= 0 ||
                        before.Length > maximumBytes)
                    {
                        throw Refused(ReadError, sourceAbsent: false);
                    }

                    stream.Position = 0;
                    content = new byte[(int)before.Length];
                    int offset = 0;
                    while (offset < content.Length)
                    {
                        int count = stream.Read(
                            content,
                            offset,
                            content.Length - offset);
                        if (count == 0)
                        {
                            throw Refused(ReadError, sourceAbsent: false);
                        }

                        offset += count;
                    }

                    PinnedFileState after = ReadState(stream.SafeFileHandle);
                    if (!before.SameObjectAndLength(after) ||
                        !PathStillNamesOwnedFile() ||
                        !HasOnlyDefaultDataStream(_filePath) ||
                        !HasExactNarrowAccess(
                            new FileInfo(_filePath),
                            _currentUser,
                            isDirectory: false))
                    {
                        throw Refused(ChangedError, sourceAbsent: false);
                    }

                    _read = true;
                    byte[] result = content;
                    content = null;
                    return result;
                }
                catch (BridgeEnrollmentArtifactSourceException)
                {
                    throw;
                }
                catch
                {
                    throw Refused(ReadError, sourceAbsent: false);
                }
                finally
                {
                    if (content is not null)
                    {
                        CryptographicOperations.ZeroMemory(content);
                    }
                }
            }
        }

        public bool DeleteAndProveAbsent()
        {
            lock (_gate)
            {
                if (_deleteAttempted)
                {
                    if (_sourceAbsent)
                    {
                        return true;
                    }

                    throw Refused(
                        CleanupUncertainError,
                        sourceAbsent: false);
                }

                FileStream stream = RequireActiveStream();
                _deleteAttempted = true;
                try
                {
                    PinnedFileState current = ReadState(stream.SafeFileHandle);
                    if (!_initialState.SameObjectAndLength(current) ||
                        !PathStillNamesOwnedFile() ||
                        !HasOnlyDefaultDataStream(_filePath) ||
                        !HasExactNarrowAccess(
                            new DirectoryInfo(_directoryPath),
                            _currentUser,
                            isDirectory: true) ||
                        !HasExactNarrowAccess(
                            new FileInfo(_filePath),
                            _currentUser,
                            isDirectory: false))
                    {
                        throw Refused(
                            CleanupUncertainError,
                            sourceAbsent: false);
                    }

                    var disposition = new FileDispositionInformation
                    {
                        DeleteFile = true,
                    };
                    if (!SetFileInformationByHandle(
                            stream.SafeFileHandle,
                            FileDispositionInfo,
                            ref disposition,
                            (uint)Marshal.SizeOf<FileDispositionInformation>()))
                    {
                        throw Refused(
                            CleanupUncertainError,
                            sourceAbsent: false);
                    }

                    if (!ReleaseFileHandle())
                    {
                        throw Refused(
                            CleanupUncertainError,
                            sourceAbsent: false);
                    }

                    _afterReleaseBeforeDelete?.Invoke(_filePath);
                    _sourceAbsent =
                        _fileSystem.Classify(_filePath) ==
                        BridgePathEntryKind.Missing;
                    if (!_sourceAbsent)
                    {
                        throw Refused(
                            CleanupUncertainError,
                            sourceAbsent: false);
                    }

                    return true;
                }
                catch (BridgeEnrollmentArtifactSourceException)
                {
                    throw;
                }
                catch
                {
                    throw Refused(
                        CleanupUncertainError,
                        sourceAbsent: false);
                }
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _disposed = true;
                _ = ReleaseFileHandle();
                IDisposable? directoryPin =
                    Interlocked.Exchange(ref _directoryPin, null);
                try
                {
                    directoryPin?.Dispose();
                }
                catch
                {
                    // Dispose is deliberately value-free and non-throwing.
                }
            }
        }

        private FileStream RequireActiveStream()
        {
            if (_disposed || _stream is null)
            {
                throw Refused(ReadError, sourceAbsent: _sourceAbsent);
            }

            return _stream;
        }

        private bool PathStillNamesOwnedFile()
        {
            try
            {
                return _fileSystem.GetFileIdentity(_filePath) ==
                       _initialState.Identity;
            }
            catch
            {
                return false;
            }
        }

        private bool ReleaseFileHandle()
        {
            FileStream? stream = Interlocked.Exchange(ref _stream, null);
            try
            {
                stream?.Dispose();
                return true;
            }
            catch
            {
                return false;
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        internal uint LowDateTime;
        internal uint HighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        internal uint FileAttributes;
        internal FileTime CreationTime;
        internal FileTime LastAccessTime;
        internal FileTime LastWriteTime;
        internal uint VolumeSerialNumber;
        internal uint FileSizeHigh;
        internal uint FileSizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInformation
    {
        [MarshalAs(UnmanagedType.Bool)]
        internal bool DeleteFile;
    }

    private enum StreamInfoLevels
    {
        FindStreamInfoStandard,
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Win32FindStreamData
    {
        internal long StreamSize;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 296)]
        internal string? StreamName;
    }

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateFileW",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation fileInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int fileInformationClass,
        ref FileDispositionInformation fileInformation,
        uint bufferSize);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "FindFirstStreamW",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern IntPtr FindFirstStream(
        string fileName,
        StreamInfoLevels infoLevel,
        out Win32FindStreamData findStreamData,
        uint flags);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "FindNextStreamW",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindNextStream(
        IntPtr findStream,
        out Win32FindStreamData findStreamData);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindClose(IntPtr findFile);
}
