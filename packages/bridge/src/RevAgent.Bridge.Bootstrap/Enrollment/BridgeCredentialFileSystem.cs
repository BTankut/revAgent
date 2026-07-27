using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal enum BridgePathEntryKind
{
    Missing,
    File,
    Directory,
}

internal readonly record struct BridgeFileIdentity(
    ulong VolumeSerialNumber,
    ulong FileIdLow,
    ulong FileIdHigh,
    uint LinkCount);

internal readonly record struct BridgeProtectedFileRead(
    byte[] Content,
    BridgeFileIdentity Identity);

internal interface IBridgeFilePin : IDisposable
{
    BridgeFileIdentity Identity { get; }
}

internal interface IBridgeCredentialFileSystem
{
    BridgePathEntryKind Classify(string path);

    IDisposable PinDirectory(string directoryPath);

    IBridgeFilePin PinFile(string filePath);

    BridgeFileIdentity GetFileIdentity(string filePath);

    BridgeProtectedFileRead ReadBoundedFile(
        string filePath,
        int maximumBytes);
}

internal sealed class BridgeCredentialFileSystem :
    IBridgeCredentialFileSystem
{
    private const uint FileReadAttributes = 0x00000080;
    private const uint ReadControl = 0x00020000;
    private const uint GenericRead = 0x80000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint InvalidFileAttributes = 0xFFFFFFFF;
    private const int ErrorFileNotFound = 2;
    private const int ErrorPathNotFound = 3;
    private const int ErrorHandleEof = 38;

    public BridgePathEntryKind Classify(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        string fullPath =
            BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(path);
        if (!OperatingSystem.IsWindows())
        {
            return ClassifyPortable(fullPath);
        }

        uint attributes = GetFileAttributes(fullPath);
        if (attributes == InvalidFileAttributes)
        {
            int error = Marshal.GetLastPInvokeError();
            if (error is ErrorFileNotFound or ErrorPathNotFound)
            {
                return ClassifyMissingWindowsPath(fullPath);
            }

            throw new IOException(
                "The bridge credential path could not be classified.",
                new Win32Exception(error));
        }

        bool isDirectory =
            (attributes & (uint)FileAttributes.Directory) != 0;
        using WindowsPinnedPath pinned = OpenPinnedPath(
            fullPath,
            isDirectory,
            GenericReadRequested: false);
        return isDirectory
            ? BridgePathEntryKind.Directory
            : BridgePathEntryKind.File;
    }

    private static BridgePathEntryKind ClassifyMissingWindowsPath(
        string fullPath)
    {
        string? existingAncestor = Path.GetDirectoryName(fullPath);
        while (existingAncestor is not null)
        {
            uint ancestorAttributes =
                GetFileAttributes(existingAncestor);
            if (ancestorAttributes != InvalidFileAttributes)
            {
                if ((ancestorAttributes &
                     (uint)FileAttributes.Directory) == 0)
                {
                    throw new InvalidDataException(
                        "A bridge credential ancestor is not a directory.");
                }

                break;
            }

            int ancestorError = Marshal.GetLastPInvokeError();
            if (ancestorError is not ErrorFileNotFound and
                not ErrorPathNotFound)
            {
                throw new IOException(
                    "A bridge credential ancestor could not be classified.",
                    new Win32Exception(ancestorError));
            }

            existingAncestor = Path.GetDirectoryName(existingAncestor);
        }

        if (existingAncestor is null)
        {
            throw new InvalidDataException(
                "The bridge credential path has no existing ancestor.");
        }

        using WindowsPinnedPath pinnedAncestor = OpenPinnedPath(
            existingAncestor,
            finalIsDirectory: true,
            GenericReadRequested: false);
        uint secondAttributes = GetFileAttributes(fullPath);
        if (secondAttributes == InvalidFileAttributes)
        {
            int secondError = Marshal.GetLastPInvokeError();
            if (secondError is ErrorFileNotFound or ErrorPathNotFound)
            {
                return BridgePathEntryKind.Missing;
            }

            throw new IOException(
                "The bridge credential path could not be reclassified.",
                new Win32Exception(secondError));
        }

        bool isDirectory =
            (secondAttributes & (uint)FileAttributes.Directory) != 0;
        using WindowsPinnedPath pinnedPath = OpenPinnedPath(
            fullPath,
            isDirectory,
            GenericReadRequested: false);
        return isDirectory
            ? BridgePathEntryKind.Directory
            : BridgePathEntryKind.File;
    }

    public IDisposable PinDirectory(string directoryPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directoryPath);
        string fullPath =
            BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(
                directoryPath);
        if (!OperatingSystem.IsWindows())
        {
            return new PortableDirectoryPin(fullPath);
        }

        return OpenPinnedPath(
            fullPath,
            finalIsDirectory: true,
            GenericReadRequested: false);
    }

    public BridgeFileIdentity GetFileIdentity(string filePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        string fullPath =
            BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(filePath);
        if (!OperatingSystem.IsWindows())
        {
            return GetPortableIdentity(fullPath);
        }

        using WindowsPinnedPath pinned = OpenPinnedPath(
            fullPath,
            finalIsDirectory: false,
            GenericReadRequested: false);
        return GetIdentity(pinned.FinalHandle);
    }

    public IBridgeFilePin PinFile(string filePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        string fullPath =
            BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(filePath);
        if (!OperatingSystem.IsWindows())
        {
            return new PortableFilePin(fullPath);
        }

        return OpenPinnedPath(
            fullPath,
            finalIsDirectory: false,
            GenericReadRequested: false);
    }

    public BridgeProtectedFileRead ReadBoundedFile(
        string filePath,
        int maximumBytes)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        if (maximumBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        }

        string fullPath =
            BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(filePath);
        if (!OperatingSystem.IsWindows())
        {
            return ReadBoundedPortable(fullPath, maximumBytes);
        }

        using WindowsPinnedPath pinned = OpenPinnedPath(
            fullPath,
            finalIsDirectory: false,
            GenericReadRequested: true);
        BridgeFileIdentity identity = GetIdentity(pinned.FinalHandle);
        using var stream = new FileStream(
            pinned.ReleaseFinalHandle(),
            FileAccess.Read,
            bufferSize: 16 * 1024,
            isAsync: false);
        byte[] content = ReadExactlyBounded(stream, maximumBytes);
        return new BridgeProtectedFileRead(content, identity);
    }

    private static byte[] ReadExactlyBounded(
        FileStream stream,
        int maximumBytes)
    {
        long length = stream.Length;
        if (length is <= 0 || length > maximumBytes)
        {
            throw new InvalidDataException(
                "The protected bridge credential file has an invalid size.");
        }

        var content = new byte[(int)length];
        int offset = 0;
        while (offset < content.Length)
        {
            int read = stream.Read(content, offset, content.Length - offset);
            if (read == 0)
            {
                throw new EndOfStreamException(
                    "The protected bridge credential file changed while read.");
            }

            offset += read;
        }

        if (stream.ReadByte() != -1)
        {
            throw new InvalidDataException(
                "The protected bridge credential exceeded its bounded size.");
        }

        return content;
    }

    private static BridgePathEntryKind ClassifyPortable(string fullPath)
    {
        try
        {
            FileAttributes attributes = File.GetAttributes(fullPath);
            RejectReparse(attributes);
            return (attributes & FileAttributes.Directory) != 0
                ? BridgePathEntryKind.Directory
                : BridgePathEntryKind.File;
        }
        catch (FileNotFoundException)
        {
            return BridgePathEntryKind.Missing;
        }
        catch (DirectoryNotFoundException)
        {
            return BridgePathEntryKind.Missing;
        }
    }

    private static BridgeProtectedFileRead ReadBoundedPortable(
        string fullPath,
        int maximumBytes)
    {
        VerifyPortableAncestors(fullPath);
        using var stream = new FileStream(
            fullPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 16 * 1024,
            FileOptions.SequentialScan);
        byte[] content = ReadExactlyBounded(stream, maximumBytes);
        return new BridgeProtectedFileRead(
            content,
            GetPortableIdentity(fullPath));
    }

    private static BridgeFileIdentity GetPortableIdentity(string fullPath)
    {
        VerifyPortableAncestors(fullPath);
        var info = new FileInfo(fullPath);
        if (!info.Exists)
        {
            throw new FileNotFoundException(
                "The bridge credential file does not exist.",
                fullPath);
        }

        unchecked
        {
            return new BridgeFileIdentity(
                0,
                (ulong)info.CreationTimeUtc.Ticks,
                (ulong)info.LastWriteTimeUtc.Ticks,
                1);
        }
    }

    private static void VerifyPortableAncestors(string path)
    {
        string fullPath =
            BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(path);
        string root = Path.GetPathRoot(fullPath) ??
            throw new InvalidDataException(
                "The bridge credential path has no filesystem root.");
        string current = root;
        RejectReparse(File.GetAttributes(current));
        foreach (string segment in fullPath[root.Length..].Split(
                     [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
                     StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, segment);
            BridgePathEntryKind kind = ClassifyPortable(current);
            if (kind == BridgePathEntryKind.Missing)
            {
                throw new FileNotFoundException(
                    "A bridge credential path component is missing.",
                    current);
            }
        }
    }

    private static void RejectReparse(FileAttributes attributes)
    {
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException(
                "The bridge credential path crosses a reparse point.");
        }
    }

    private static WindowsPinnedPath OpenPinnedPath(
        string path,
        bool finalIsDirectory,
        bool GenericReadRequested)
    {
        string fullPath =
            BridgeCredentialPathPolicy.NormalizeLocalFileSystemPath(path);
        string root = Path.GetPathRoot(fullPath) ??
            throw new InvalidDataException(
                "The bridge credential path has no filesystem root.");
        var handles = new List<SafeFileHandle>();
        try
        {
            handles.Add(OpenNoFollow(root, isDirectory: true, genericRead: false));
            string current = root;
            string[] segments = fullPath[root.Length..].Split(
                [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
                StringSplitOptions.RemoveEmptyEntries);
            for (int index = 0; index < segments.Length; index++)
            {
                current = Path.Combine(current, segments[index]);
                bool isFinal = index == segments.Length - 1;
                handles.Add(
                    OpenNoFollow(
                        current,
                        isFinal ? finalIsDirectory : true,
                        genericRead: isFinal && GenericReadRequested));
            }

            if (segments.Length == 0 && !finalIsDirectory)
            {
                throw new InvalidDataException(
                    "A filesystem root cannot be a bridge credential file.");
            }

            return new WindowsPinnedPath(handles);
        }
        catch
        {
            foreach (SafeFileHandle handle in handles)
            {
                handle.Dispose();
            }

            throw;
        }
    }

    private static SafeFileHandle OpenNoFollow(
        string path,
        bool isDirectory,
        bool genericRead)
    {
        uint desiredAccess = FileReadAttributes | ReadControl;
        if (genericRead)
        {
            desiredAccess |= GenericRead;
        }

        SafeFileHandle handle = CreateFile(
            path,
            desiredAccess,
            FileShareRead,
            IntPtr.Zero,
            OpenExisting,
            FileFlagOpenReparsePoint |
            (isDirectory ? FileFlagBackupSemantics : 0),
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            throw new IOException(
                "A bridge credential path handle could not be opened.",
                new Win32Exception(error));
        }

        if (!GetFileInformationByHandle(handle, out ByHandleFileInformation info))
        {
            int error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            throw new IOException(
                "A bridge credential path handle could not be inspected.",
                new Win32Exception(error));
        }

        if ((info.FileAttributes & FileAttributeReparsePoint) != 0)
        {
            handle.Dispose();
            throw new InvalidDataException(
                "The bridge credential path crosses a reparse point.");
        }

        bool actualDirectory =
            (info.FileAttributes & (uint)FileAttributes.Directory) != 0;
        if (actualDirectory != isDirectory)
        {
            handle.Dispose();
            throw new InvalidDataException(
                "A bridge credential path component has an unexpected type.");
        }

        if (!isDirectory && info.NumberOfLinks != 1)
        {
            handle.Dispose();
            throw new InvalidDataException(
                "A bridge credential file must not have hard links.");
        }

        if (!isDirectory)
        {
            try
            {
                VerifyNoAlternateDataStreamsWindows(path);
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }

        return handle;
    }

    private static void VerifyNoAlternateDataStreamsWindows(string filePath)
    {
        IntPtr search = FindFirstStream(
            filePath,
            StreamInfoLevels.FindStreamInfoStandard,
            out Win32FindStreamData streamData,
            flags: 0);
        if (search == new IntPtr(-1))
        {
            int error = Marshal.GetLastPInvokeError();
            if (error == ErrorHandleEof)
            {
                return;
            }

            throw new IOException(
                "The bridge credential named-stream inventory could not be " +
                "read.",
                new Win32Exception(error));
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
                    throw new InvalidDataException(
                        "A bridge credential file must not contain alternate " +
                        "data streams.");
                }

                if (FindNextStream(search, out streamData))
                {
                    continue;
                }

                int error = Marshal.GetLastPInvokeError();
                if (error != ErrorHandleEof)
                {
                    throw new IOException(
                        "The bridge credential named-stream inventory changed " +
                        "while it was read.",
                        new Win32Exception(error));
                }

                return;
            }
        }
        finally
        {
            _ = FindClose(search);
        }
    }

    private static BridgeFileIdentity GetIdentity(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandle(handle, out ByHandleFileInformation info))
        {
            throw new IOException(
                "The bridge credential file identity could not be inspected.",
                new Win32Exception(Marshal.GetLastPInvokeError()));
        }

        return new BridgeFileIdentity(
            info.VolumeSerialNumber,
            ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow,
            0,
            info.NumberOfLinks);
    }

    private sealed class PortableDirectoryPin : IDisposable
    {
        private readonly string _path;
        private readonly FileAttributes _attributes;

        internal PortableDirectoryPin(string path)
        {
            _path = path;
            VerifyPortableAncestors(path);
            _attributes = File.GetAttributes(path);
            if ((_attributes & FileAttributes.Directory) == 0)
            {
                throw new InvalidDataException(
                    "The bridge credential directory is not a directory.");
            }
        }

        public void Dispose()
        {
            FileAttributes current = File.GetAttributes(_path);
            RejectReparse(current);
            if ((current & FileAttributes.Directory) == 0)
            {
                throw new InvalidDataException(
                    "The pinned bridge credential directory changed type.");
            }
        }
    }

    private sealed class PortableFilePin : IBridgeFilePin
    {
        private readonly string _path;

        internal PortableFilePin(string path)
        {
            _path = path;
            Identity = GetPortableIdentity(path);
        }

        public BridgeFileIdentity Identity { get; }

        public void Dispose()
        {
            if (GetPortableIdentity(_path) != Identity)
            {
                throw new InvalidDataException(
                    "The pinned bridge credential file identity changed.");
            }
        }
    }

    private sealed class WindowsPinnedPath : IBridgeFilePin
    {
        private readonly List<SafeFileHandle> _handles;
        private bool _finalReleased;

        internal WindowsPinnedPath(List<SafeFileHandle> handles)
        {
            _handles = handles;
        }

        internal SafeFileHandle FinalHandle =>
            _handles.Count > 0
                ? _handles[^1]
                : throw new InvalidOperationException(
                    "The pinned bridge path has no final handle.");

        public BridgeFileIdentity Identity => GetIdentity(FinalHandle);

        internal SafeFileHandle ReleaseFinalHandle()
        {
            if (_finalReleased)
            {
                throw new InvalidOperationException(
                    "The final bridge path handle was already released.");
            }

            _finalReleased = true;
            SafeFileHandle handle = _handles[^1];
            _handles.RemoveAt(_handles.Count - 1);
            return handle;
        }

        public void Dispose()
        {
            foreach (SafeFileHandle handle in _handles)
            {
                handle.Dispose();
            }

            _handles.Clear();
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

    [DllImport(
        "kernel32.dll",
        EntryPoint = "GetFileAttributesW",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern uint GetFileAttributes(string fileName);

    [DllImport(
        "kernel32.dll",
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation fileInformation);

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
