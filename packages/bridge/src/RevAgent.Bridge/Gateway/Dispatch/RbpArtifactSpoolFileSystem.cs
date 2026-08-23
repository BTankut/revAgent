using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// Windows-only, handle-anchored spool access.  Path checks are advisory only;
/// the final object is always opened with OPEN_REPARSE_POINT and verified from
/// its handle before it is read, written, or removed.
/// </summary>
internal sealed class RbpArtifactSpoolFileSystem
{
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint DeleteAccess = 0x00010000;
    private const uint ReadControl = 0x00020000;
    private const uint FileReadAttributes = 0x00000080;
    private const uint FileShareRead = 0x00000001;
    private const uint CreateNew = 1;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint FileAttributeDirectory = 0x00000010;
    private const int FileDispositionInfo = 4;

    private readonly string _root;

    private RbpArtifactSpoolFileSystem(string root)
    {
        _root = root;
    }

    internal static RbpArtifactSpoolFileSystem Open(string root)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw Refused("carrier_spool_platform_refused");
        }

        try
        {
            string full = Path.GetFullPath(root);
            EnsureDirectoryTree(full);
            using SafeFileHandle handle = OpenDirectory(full);
            string final = FinalPath(handle);
            return new RbpArtifactSpoolFileSystem(final);
        }
        catch (RbpArtifactCarrierException)
        {
            throw;
        }
        catch
        {
            throw Refused("carrier_spool_root_refused");
        }
    }

    internal string Root => _root;

    internal void EnsureDirectory(string path)
    {
        try
        {
            string full = RequireUnderRoot(path);
            EnsureDirectoryTree(full);
            using SafeFileHandle handle = OpenDirectory(full);
            VerifyUnderRoot(handle);
        }
        catch (RbpArtifactCarrierException)
        {
            throw;
        }
        catch
        {
            throw Refused("carrier_spool_directory_refused");
        }
    }

    internal void WriteImmutable(string path, ReadOnlySpan<byte> bytes, string digest)
    {
        string full = RequireUnderRoot(path);
        try
        {
            string? parent = Path.GetDirectoryName(full);
            if (parent is null)
            {
                throw Refused("carrier_spool_path_refused");
            }

            EnsureDirectory(parent);
            SafeFileHandle handle = OpenFile(full, CreateNew);
            try
            {
                VerifyUnderRoot(handle);
                using var stream = new FileStream(handle, FileAccess.Write, 16 * 1024,
                    isAsync: false);
                handle = null!;
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            finally
            {
                handle?.Dispose();
            }
        }
        catch (IOException)
        {
            if (TryReadAllPinned(full, RbpArtifactCarrierProducer.MaximumCombinedBytes,
                    out _))
            {
                VerifyImmutableExisting(full, bytes);
                return;
            }

            throw Refused("carrier_spool_write_refused");
        }
        catch (RbpArtifactCarrierException)
        {
            throw;
        }
        catch
        {
            throw Refused("carrier_spool_write_refused");
        }

        try
        {
            byte[] existing = ReadAllPinned(full, RbpArtifactCarrierProducer.MaximumCombinedBytes);
            if (!string.Equals(RbpArtifactCarrierProducer.Digest(existing), digest,
                    StringComparison.Ordinal))
            {
                throw Refused("carrier_spool_verification_refused");
            }
        }
        catch (RbpArtifactCarrierException)
        {
            throw;
        }
        catch
        {
            throw Refused("carrier_spool_verification_refused");
        }
    }

    internal byte[] ReadAllPinned(string path, int maximumBytes)
    {
        string full = RequireUnderRoot(path);
        try
        {
            using SafeFileHandle handle = OpenFile(full, OpenExisting);
            VerifyUnderRoot(handle);
            FileState state = ReadState(handle);
            if (state.IsDirectory || state.IsReparsePoint || state.Length < 0 ||
                state.Length > maximumBytes)
            {
                throw Refused("carrier_spool_file_refused");
            }

            using var stream = new FileStream(handle, FileAccess.Read, 16 * 1024,
                isAsync: false);
            byte[] output = new byte[checked((int)state.Length)];
            int offset = 0;
            while (offset < output.Length)
            {
                int read = stream.Read(output, offset, output.Length - offset);
                if (read == 0)
                {
                    throw Refused("carrier_spool_read_refused");
                }

                offset += read;
            }

            if (!state.Equals(ReadState(stream.SafeFileHandle)))
            {
                throw Refused("carrier_spool_changed_refused");
            }

            return output;
        }
        catch (RbpArtifactCarrierException)
        {
            throw;
        }
        catch
        {
            throw Refused("carrier_spool_read_refused");
        }
    }

    internal bool TryReadAllPinned(string path, int maximumBytes, out byte[]? bytes)
    {
        try
        {
            bytes = ReadAllPinned(path, maximumBytes);
            return true;
        }
        catch (RbpArtifactCarrierException)
        {
            bytes = null;
            return false;
        }
    }

    internal bool TryGetLastWriteTimeUtcPinned(string path, out DateTime value)
    {
        value = default;
        string full;
        try
        {
            full = RequireUnderRoot(path);
            using SafeFileHandle handle = OpenFile(full, OpenExisting);
            VerifyUnderRoot(handle);
            if (ReadState(handle).IsDirectory)
            {
                return false;
            }

            if (!GetFileTime(handle, out _, out _, out FileTime writeTime))
            {
                return false;
            }

            long ticks = ((long)writeTime.High << 32) | writeTime.Low;
            value = DateTime.FromFileTimeUtc(ticks);
            return true;
        }
        catch
        {
            return false;
        }
    }

    internal void DeleteCarrierDirectory(string directory)
    {
        string full = RequireUnderRoot(directory);
        try
        {
            using SafeFileHandle handle = OpenDirectory(full);
            VerifyUnderRoot(handle);
            // Revalidate immediately before namespace deletion.  Individual
            // files are only ever removed through handles below.
            DeleteFilesByPinnedHandle(full);
            using SafeFileHandle finalDirectory = OpenDirectory(full);
            VerifyUnderRoot(finalDirectory);
            Directory.Delete(full, recursive: false);
        }
        catch (DirectoryNotFoundException)
        {
            return;
        }
        catch (RbpArtifactCarrierException)
        {
            throw;
        }
        catch
        {
            throw Refused("carrier_spool_cleanup_refused");
        }
    }

    private void DeleteFilesByPinnedHandle(string directory)
    {
        foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
        {
            if (Directory.Exists(entry))
            {
                using SafeFileHandle childDirectory = OpenDirectory(entry);
                VerifyUnderRoot(childDirectory);
                DeleteFilesByPinnedHandle(entry);
                using SafeFileHandle finalChild = OpenDirectory(entry);
                VerifyUnderRoot(finalChild);
                Directory.Delete(entry, recursive: false);
                continue;
            }

            using SafeFileHandle file = OpenFile(entry, OpenExisting);
            VerifyUnderRoot(file);
            FileState state = ReadState(file);
            if (state.IsDirectory || state.IsReparsePoint)
            {
                throw Refused("carrier_spool_cleanup_refused");
            }

            var disposition = new FileDispositionInformation { DeleteFile = true };
            if (!SetFileInformationByHandle(file, FileDispositionInfo, ref disposition,
                    (uint)Marshal.SizeOf<FileDispositionInformation>()))
            {
                throw Refused("carrier_spool_cleanup_refused");
            }
        }
    }

    private void VerifyImmutableExisting(string path, ReadOnlySpan<byte> expected)
    {
        byte[] actual = ReadAllPinned(path, RbpArtifactCarrierProducer.MaximumCombinedBytes);
        if (!System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(actual, expected))
        {
            throw Refused("carrier_spool_conflict_refused");
        }
    }

    private string RequireUnderRoot(string path)
    {
        string full;
        try { full = Path.GetFullPath(path); }
        catch { throw Refused("carrier_spool_path_refused"); }
        if (!IsUnderRoot(full, _root))
        {
            throw Refused("carrier_spool_path_refused");
        }

        return full;
    }

    private void VerifyUnderRoot(SafeFileHandle handle)
    {
        FileState state = ReadState(handle);
        if (state.IsReparsePoint || !IsUnderRoot(FinalPath(handle), _root))
        {
            throw Refused("carrier_spool_path_refused");
        }
    }

    private static bool IsUnderRoot(string value, string root) =>
        string.Equals(value, root, StringComparison.OrdinalIgnoreCase) ||
        value.StartsWith(root + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase);

    private static void EnsureDirectoryTree(string full)
    {
        string root = Path.GetPathRoot(full) ?? throw new IOException();
        string cursor = root;
        foreach (string segment in full[root.Length..].Split(
                     [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
                     StringSplitOptions.RemoveEmptyEntries))
        {
            cursor = Path.Combine(cursor, segment);
            if (!Directory.Exists(cursor))
            {
                Directory.CreateDirectory(cursor);
            }

            using SafeFileHandle handle = OpenDirectory(cursor);
            _ = FinalPath(handle);
        }
    }

    private static SafeFileHandle OpenDirectory(string path) => Open(path,
        ReadControl | FileReadAttributes,
        OpenExisting, FileFlagBackupSemantics | FileFlagOpenReparsePoint, true);

    private static SafeFileHandle OpenFile(string path, uint disposition) => Open(path,
        GenericRead | GenericWrite | DeleteAccess | ReadControl | FileReadAttributes,
        disposition, FileFlagOpenReparsePoint, false);

    private static SafeFileHandle Open(string path, uint desiredAccess, uint disposition,
        uint flags, bool expectedDirectory)
    {
        SafeFileHandle handle = CreateFile(path, desiredAccess, FileShareRead, IntPtr.Zero,
            disposition, flags, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            throw new IOException("spool handle open failed", new Win32Exception(error));
        }

        FileState state = ReadState(handle);
        if (state.IsReparsePoint || state.IsDirectory != expectedDirectory)
        {
            handle.Dispose();
            throw Refused("carrier_spool_path_refused");
        }

        return handle;
    }

    private static string FinalPath(SafeFileHandle handle)
    {
        var buffer = new char[32768];
        uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Length, 0);
        if (length == 0 || length >= buffer.Length)
        {
            throw new IOException("spool final path unavailable");
        }

        const string uncPrefix = "\\\\?\\UNC\\";
        const string devicePrefix = "\\\\?\\";
        string value = new string(buffer, 0, checked((int)length));
        if (value.StartsWith(uncPrefix, StringComparison.OrdinalIgnoreCase))
        {
            return "\\\\" + value[uncPrefix.Length..];
        }

        return value.StartsWith(devicePrefix, StringComparison.Ordinal)
            ? value[devicePrefix.Length..]
            : value;
    }

    private static FileState ReadState(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandle(handle, out ByHandleFileInformation info))
        {
            throw new IOException("spool handle inspection failed");
        }

        return new FileState(
            info.FileAttributes,
            ((long)info.FileSizeHigh << 32) | info.FileSizeLow,
            ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow);
    }

    private static RbpArtifactCarrierException Refused(string code) =>
        new(code);

    private readonly record struct FileState(uint Attributes, long Length, ulong Identity)
    {
        internal bool IsReparsePoint => (Attributes & FileAttributeReparsePoint) != 0;
        internal bool IsDirectory => (Attributes & FileAttributeDirectory) != 0;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { internal uint Low; internal uint High; }

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
        [MarshalAs(UnmanagedType.Bool)] internal bool DeleteFile;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string fileName, uint desiredAccess,
        uint shareMode, IntPtr securityAttributes, uint creationDisposition,
        uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file,
        out ByHandleFileInformation fileInformation);

    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle file,
        [Out] char[] path, uint length, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file,
        int fileInformationClass, ref FileDispositionInformation fileInformation,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileTime(SafeFileHandle file,
        out FileTime creationTime, out FileTime accessTime, out FileTime writeTime);
}
