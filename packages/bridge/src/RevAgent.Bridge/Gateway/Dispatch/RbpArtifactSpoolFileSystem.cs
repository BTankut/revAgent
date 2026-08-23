using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>Capability-only spool interface.  Caller input is always one opaque
/// segment; implementations never discover children by path enumeration.</summary>
internal interface IRelativeSpoolNative : IDisposable
{
    void EnsureCarrier(string carrierKey);
    void WriteImmutable(string carrierKey, string fileName, ReadOnlySpan<byte> bytes, string digest);
    byte[] ReadAllPinned(string carrierKey, string fileName, int maximumBytes);
    bool TryReadAllPinned(string carrierKey, string fileName, int maximumBytes, out byte[]? bytes);
    void DeleteCarrier(string carrierKey, IReadOnlyList<string> declaredFileNames);
}

internal sealed class RbpArtifactSpoolFileSystem : IDisposable
{
    private readonly IRelativeSpoolNative _native;
    private RbpArtifactSpoolFileSystem(IRelativeSpoolNative native) => _native = native;

    internal static RbpArtifactSpoolFileSystem Open(string root)
    {
        if (!OperatingSystem.IsWindows()) throw Refused("carrier_spool_platform_refused");
        try
        {
            // Bootstrap only: every carrier child is subsequently rooted at
            // the SafeFileHandle held by WindowsRelativeSpoolNative.
            Directory.CreateDirectory(Path.GetFullPath(root));
            return new(new WindowsRelativeSpoolNative(root));
        }
        catch (RbpArtifactCarrierException) { throw; }
        catch { throw Refused("carrier_spool_root_refused"); }
    }

    internal static RbpArtifactSpoolFileSystem ForTesting(IRelativeSpoolNative native) =>
        new(native ?? throw new ArgumentNullException(nameof(native)));
    internal void EnsureCarrier(string key) => _native.EnsureCarrier(key);
    internal void WriteImmutable(string key, string name, ReadOnlySpan<byte> bytes, string digest) => _native.WriteImmutable(key, name, bytes, digest);
    internal byte[] ReadAllPinned(string key, string name, int maximumBytes) => _native.ReadAllPinned(key, name, maximumBytes);
    internal bool TryReadAllPinned(string key, string name, int maximumBytes, out byte[]? bytes) => _native.TryReadAllPinned(key, name, maximumBytes, out bytes);
    internal void DeleteCarrier(string key, IReadOnlyList<string> inventory) => _native.DeleteCarrier(key, inventory);
    public void Dispose() => _native.Dispose();
    private static RbpArtifactCarrierException Refused(string code) => new(code);
}

/// <summary>NT root-handle implementation. NtCreateFile receives RootDirectory
/// for every carrier and leaf, defeating parent junction/path replacement.</summary>
internal sealed class WindowsRelativeSpoolNative : IRelativeSpoolNative
{
    private const uint GenericRead = 0x80000000, GenericWrite = 0x40000000, DeleteAccess = 0x00010000, ReadControl = 0x00020000, Synchronize = 0x00100000, FileReadAttributes = 0x80;
    private const uint FileShareRead = 1, FileShareDelete = 4, FileOpen = 1, FileCreate = 2, FileOpenIf = 3;
    private const uint FileDirectoryFile = 1, FileNonDirectoryFile = 0x40, FileSynchronousIoNonAlert = 0x20, FileOpenReparsePoint = 0x00200000, ObjCaseInsensitive = 0x40;
    private const uint FileAttributeReparsePoint = 0x400, FileAttributeDirectory = 0x10;
    private const int FileDispositionInformationClass = 4;
    private readonly SafeFileHandle _root;

    internal WindowsRelativeSpoolNative(string root)
    {
        _root = CreateFile(root, ReadControl | FileReadAttributes | DeleteAccess | Synchronize, FileShareRead | FileShareDelete, IntPtr.Zero, 3, 0x02000000 | FileOpenReparsePoint, IntPtr.Zero);
        if (_root.IsInvalid) { _root.Dispose(); throw Refused("carrier_spool_root_refused"); }
        VerifyDirectory(_root);
    }

    public void EnsureCarrier(string carrierKey)
    {
        ValidateSegment(carrierKey);
        using SafeFileHandle carrier = OpenRelative(_root, carrierKey, ReadControl | FileReadAttributes, FileOpenIf, DirectoryOptions);
        VerifyDirectory(carrier);
    }

    public void WriteImmutable(string carrierKey, string fileName, ReadOnlySpan<byte> bytes, string digest)
    {
        ValidateSegment(carrierKey); ValidateSegment(fileName); EnsureCarrier(carrierKey);
        try
        {
            using SafeFileHandle carrier = OpenCarrier(carrierKey);
            using SafeFileHandle file = OpenRelative(carrier, fileName, GenericRead | GenericWrite | DeleteAccess | ReadControl | FileReadAttributes, FileCreate, FileOptions);
            VerifyFile(file, RbpArtifactCarrierProducer.MaximumCombinedBytes);
            using var stream = new FileStream(file, FileAccess.Write, 16 * 1024, isAsync: false);
            stream.Write(bytes); stream.Flush(flushToDisk: true);
            VerifyFile(stream.SafeFileHandle, RbpArtifactCarrierProducer.MaximumCombinedBytes, bytes.Length);
        }
        catch (IOException)
        {
            VerifyImmutableExisting(carrierKey, fileName, bytes, digest);
        }
        catch (RbpArtifactCarrierException) { throw; }
        catch { throw Refused("carrier_spool_write_refused"); }
    }

    public byte[] ReadAllPinned(string carrierKey, string fileName, int maximumBytes)
    {
        ValidateSegment(carrierKey); ValidateSegment(fileName);
        try
        {
            using SafeFileHandle carrier = OpenCarrier(carrierKey);
            using SafeFileHandle file = OpenRelative(carrier, fileName, GenericRead | ReadControl | FileReadAttributes, FileOpen, FileOptions);
            FileState before = VerifyFile(file, maximumBytes);
            using var stream = new FileStream(file, FileAccess.Read, 16 * 1024, isAsync: false);
            byte[] bytes = new byte[checked((int)before.Length)];
            int offset = 0;
            while (offset < bytes.Length) { int read = stream.Read(bytes, offset, bytes.Length - offset); if (read == 0) throw Refused("carrier_spool_read_refused"); offset += read; }
            if (!before.Equals(VerifyFile(stream.SafeFileHandle, maximumBytes))) throw Refused("carrier_spool_changed_refused");
            return bytes;
        }
        catch (RbpArtifactCarrierException) { throw; }
        catch { throw Refused("carrier_spool_read_refused"); }
    }

    public bool TryReadAllPinned(string key, string name, int maximumBytes, out byte[]? bytes)
    {
        try { bytes = ReadAllPinned(key, name, maximumBytes); return true; }
        catch (RbpArtifactCarrierException) { bytes = null; return false; }
    }

    public void DeleteCarrier(string carrierKey, IReadOnlyList<string> declaredFileNames)
    {
        ValidateSegment(carrierKey);
        if (declaredFileNames is null || declaredFileNames.Count == 0 || declaredFileNames.Distinct(StringComparer.Ordinal).Count() != declaredFileNames.Count) throw Refused("carrier_spool_inventory_refused");
        try
        {
            using SafeFileHandle carrier = OpenCarrier(carrierKey);
            foreach (string name in declaredFileNames)
            {
                ValidateSegment(name);
                using SafeFileHandle file = OpenRelative(carrier, name, DeleteAccess | ReadControl | FileReadAttributes, FileOpen, FileOptions);
                _ = VerifyFile(file, RbpArtifactCarrierProducer.MaximumCombinedBytes);
                SetDeleteDisposition(file);
            }
            // No enumeration: any undeclared residue causes this opened,
            // root-relative directory disposition to refuse.
            SetDeleteDisposition(carrier);
        }
        catch (RbpArtifactCarrierException) { throw; }
        catch { throw Refused("carrier_spool_cleanup_refused"); }
    }

    public void Dispose() => _root.Dispose();
    private SafeFileHandle OpenCarrier(string key) { SafeFileHandle carrier = OpenRelative(_root, key, ReadControl | FileReadAttributes | DeleteAccess, FileOpen, DirectoryOptions); VerifyDirectory(carrier); return carrier; }
    private void VerifyImmutableExisting(string key, string name, ReadOnlySpan<byte> expected, string digest)
    {
        byte[] actual = ReadAllPinned(key, name, RbpArtifactCarrierProducer.MaximumCombinedBytes);
        if (!string.Equals(RbpArtifactCarrierProducer.Digest(actual), digest, StringComparison.Ordinal) || !System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(actual, expected)) throw Refused("carrier_spool_conflict_refused");
    }

    private static uint DirectoryOptions => FileDirectoryFile | FileSynchronousIoNonAlert | FileOpenReparsePoint;
    private static uint FileOptions => FileNonDirectoryFile | FileSynchronousIoNonAlert | FileOpenReparsePoint;
    private static SafeFileHandle OpenRelative(SafeFileHandle root, string name, uint access, uint disposition, uint options)
    {
        ValidateSegment(name); IntPtr value = IntPtr.Zero, unicodeMemory = IntPtr.Zero;
        try
        {
            value = Marshal.StringToHGlobalUni(name);
            var unicode = new UnicodeString { Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)((name.Length + 1) * 2)), Buffer = value };
            unicodeMemory = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>()); Marshal.StructureToPtr(unicode, unicodeMemory, false);
            var attributes = new ObjectAttributes { Length = Marshal.SizeOf<ObjectAttributes>(), RootDirectory = root.DangerousGetHandle(), ObjectName = unicodeMemory, Attributes = ObjCaseInsensitive };
            long allocation = 0; int status = NtCreateFile(out SafeFileHandle handle, access | Synchronize, ref attributes, out _, ref allocation, 0x80, FileShareRead | FileShareDelete, disposition, options, IntPtr.Zero, 0);
            if (status < 0 || handle.IsInvalid) { handle?.Dispose(); throw new IOException("spool relative open failed", new Win32Exception(status)); }
            return handle;
        }
        finally { if (unicodeMemory != IntPtr.Zero) Marshal.FreeHGlobal(unicodeMemory); if (value != IntPtr.Zero) Marshal.FreeHGlobal(value); }
    }

    private static void SetDeleteDisposition(SafeFileHandle handle) { var disposition = new FileDispositionInformation { DeleteFile = true }; if (!SetFileInformationByHandle(handle, FileDispositionInformationClass, ref disposition, (uint)Marshal.SizeOf<FileDispositionInformation>())) throw Refused("carrier_spool_cleanup_refused"); }
    private static FileState VerifyDirectory(SafeFileHandle handle) { FileState state = ReadState(handle); if (!state.IsDirectory || state.IsReparsePoint) throw Refused("carrier_spool_path_refused"); return state; }
    private static FileState VerifyFile(SafeFileHandle handle, int maximum, int? expected = null) { FileState state = ReadState(handle); if (state.IsDirectory || state.IsReparsePoint || state.Length < 0 || state.Length > maximum || (expected.HasValue && state.Length != expected.Value)) throw Refused("carrier_spool_file_refused"); return state; }
    private static FileState ReadState(SafeFileHandle handle) { if (!GetFileInformationByHandle(handle, out ByHandleFileInformation info)) throw Refused("carrier_spool_handle_refused"); return new(info.FileAttributes, ((long)info.FileSizeHigh << 32) | info.FileSizeLow, ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow); }
    private static void ValidateSegment(string value) { if (string.IsNullOrWhiteSpace(value) || value is "." or ".." || value.Length > 255 || value.IndexOfAny(['/', '\\', ':', '\0']) >= 0) throw Refused("carrier_spool_segment_refused"); }
    private static RbpArtifactCarrierException Refused(string code) => new(code);
    private readonly record struct FileState(uint Attributes, long Length, ulong Identity) { internal bool IsReparsePoint => (Attributes & FileAttributeReparsePoint) != 0; internal bool IsDirectory => (Attributes & FileAttributeDirectory) != 0; }
    [StructLayout(LayoutKind.Sequential)] private struct UnicodeString { internal ushort Length; internal ushort MaximumLength; internal IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] private struct ObjectAttributes { internal int Length; internal IntPtr RootDirectory; internal IntPtr ObjectName; internal uint Attributes; internal IntPtr SecurityDescriptor; internal IntPtr SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)] private struct IoStatusBlock { internal IntPtr Status; internal IntPtr Information; }
    [StructLayout(LayoutKind.Sequential)] private struct FileTime { internal uint Low; internal uint High; }
    [StructLayout(LayoutKind.Sequential)] private struct ByHandleFileInformation { internal uint FileAttributes; internal FileTime CreationTime; internal FileTime LastAccessTime; internal FileTime LastWriteTime; internal uint VolumeSerialNumber; internal uint FileSizeHigh; internal uint FileSizeLow; internal uint NumberOfLinks; internal uint FileIndexHigh; internal uint FileIndexLow; }
    [StructLayout(LayoutKind.Sequential)] private struct FileDispositionInformation { [MarshalAs(UnmanagedType.Bool)] internal bool DeleteFile; }
    [DllImport("ntdll.dll")] private static extern int NtCreateFile(out SafeFileHandle fileHandle, uint desiredAccess, ref ObjectAttributes objectAttributes, out IoStatusBlock ioStatusBlock, ref long allocationSize, uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
    [DllImport("kernel32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation fileInformation);
    [DllImport("kernel32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetFileInformationByHandle(SafeFileHandle file, int fileInformationClass, ref FileDispositionInformation fileInformation, uint bufferSize);
}
