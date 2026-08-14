using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;

namespace RevAgent.M4.ClientBearerBroker;

internal readonly record struct FileIdentity(
    uint VolumeSerialNumber,
    uint FileIndexHigh,
    uint FileIndexLow,
    uint NumberOfLinks,
    uint FileAttributes)
{
    internal bool SameObject(FileIdentity other) =>
        VolumeSerialNumber == other.VolumeSerialNumber &&
        FileIndexHigh == other.FileIndexHigh &&
        FileIndexLow == other.FileIndexLow;
}

internal sealed class ProtectedStore
{
    private const uint InvalidFileAttributes = 0xffffffff;
    private const uint FileReadAttributes = 0x00000080;
    private const uint ReadControl = 0x00020000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const int MaximumRootCharacters = 4096;
    private const int MaximumCiphertextBytes = 65536;

    internal string DestinationPath(string root) =>
        Path.Combine(root, BrokerContracts.StoreFileName);

    internal bool ValidateSelfHash(string expected)
    {
        try
        {
            var processPath = Environment.ProcessPath;
            if (string.IsNullOrEmpty(processPath) ||
                !Path.IsPathFullyQualified(processPath) ||
                !TryReadPathIdentity(processPath, out var before) ||
                before.NumberOfLinks != 1 ||
                IsReparsePoint(before.FileAttributes))
            {
                return false;
            }

            using var stream = new FileStream(
                processPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                81920,
                FileOptions.SequentialScan);
            var opened = ReadIdentity(stream.SafeFileHandle);
            if (!before.SameObject(opened) || opened.NumberOfLinks != 1)
            {
                return false;
            }

            var digest = SHA256.HashData(stream);
            var actual = Convert.ToHexString(digest).ToLowerInvariant();
            CryptographicOperations.ZeroMemory(digest);
            var after = ReadIdentity(stream.SafeFileHandle);
            return before.SameObject(after) &&
                after.NumberOfLinks == 1 &&
                string.Equals(actual, expected, StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    internal void Write(string root, ReadOnlySpan<byte> ciphertext)
    {
        if (ciphertext.IsEmpty || ciphertext.Length > MaximumCiphertextBytes ||
            !TryValidateProtectedRoot(root, out var rootIdentity))
        {
            throw new BrokerRefusalException("invalid_protected_root");
        }

        var destination = DestinationPath(root);
        if (!TryProvePathAbsent(destination))
        {
            throw new BrokerRefusalException("destination_exists");
        }

        FileIdentity? ownedIdentity = null;
        var retain = false;
        try
        {
            var security = CreateNarrowFileSecurity();
            using (var stream = FileSystemAclExtensions.Create(
                new FileInfo(destination),
                FileMode.CreateNew,
                FileSystemRights.WriteData | FileSystemRights.ReadPermissions,
                FileShare.None,
                4096,
                FileOptions.WriteThrough,
                security))
            {
                ownedIdentity = ReadIdentity(stream.SafeFileHandle);
                EnsureNarrowFileIdentity(ownedIdentity.Value);
                stream.Write(ciphertext);
                stream.Flush(flushToDisk: true);
                var afterWrite = ReadIdentity(stream.SafeFileHandle);
                if (!ownedIdentity.Value.SameObject(afterWrite))
                {
                    throw new BrokerRefusalException("destination_changed");
                }
            }

            if (!TryReadPathIdentity(destination, out var afterClose) ||
                !ownedIdentity.Value.SameObject(afterClose) ||
                !IsNarrowFileIdentity(afterClose) ||
                !TryValidateNarrowAcl(new FileInfo(destination)) ||
                !TryValidateProtectedRootUnchanged(root, rootIdentity))
            {
                throw new BrokerRefusalException("destination_changed");
            }

            retain = true;
        }
        finally
        {
            if (!retain && ownedIdentity.HasValue)
            {
                if (!DeleteOwnedFile(destination, ownedIdentity.Value))
                {
                    throw new BrokerRefusalException("cleanup_uncertain");
                }
            }
        }
    }

    internal byte[] Read(string root)
    {
        if (!TryValidateProtectedRoot(root, out var rootIdentity))
        {
            throw new BrokerRefusalException("invalid_protected_root");
        }

        var destination = DestinationPath(root);
        if (!TryReadPathIdentity(destination, out var before) ||
            !IsNarrowFileIdentity(before) ||
            !TryValidateNarrowAcl(new FileInfo(destination)))
        {
            throw new BrokerRefusalException("secure_store_refused");
        }

        using var stream = new FileStream(
            destination,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            4096,
            FileOptions.SequentialScan);
        var opened = ReadIdentity(stream.SafeFileHandle);
        if (!before.SameObject(opened) || opened.NumberOfLinks != 1 ||
            stream.Length is < 1 or > MaximumCiphertextBytes)
        {
            throw new BrokerRefusalException("secure_store_refused");
        }

        var bytes = new byte[checked((int)stream.Length)];
        stream.ReadExactly(bytes);
        var after = ReadIdentity(stream.SafeFileHandle);
        if (!opened.SameObject(after) || after.NumberOfLinks != 1 ||
            !TryValidateProtectedRootUnchanged(root, rootIdentity))
        {
            CryptographicOperations.ZeroMemory(bytes);
            throw new BrokerRefusalException("secure_store_refused");
        }
        return bytes;
    }

    internal bool ProbeAbsent(string root)
    {
        if (!TryValidateProtectedRoot(root, out var identity))
        {
            return false;
        }
        return TryProvePathAbsent(DestinationPath(root)) &&
            TryValidateProtectedRootUnchanged(root, identity);
    }

    internal bool Cleanup(string root)
    {
        if (!TryValidateProtectedRoot(root, out var rootIdentity))
        {
            return false;
        }

        var destination = DestinationPath(root);
        if (TryProvePathAbsent(destination))
        {
            return TryValidateProtectedRootUnchanged(root, rootIdentity);
        }
        if (!TryReadPathIdentity(destination, out var owned) ||
            !IsNarrowFileIdentity(owned) ||
            !TryValidateNarrowAcl(new FileInfo(destination)))
        {
            return false;
        }

        File.Delete(destination);
        return TryProvePathAbsent(destination) &&
            TryValidateProtectedRootUnchanged(root, rootIdentity);
    }

    internal static DirectorySecurity CreateNarrowDirectorySecurity()
    {
        var current = CurrentSid();
        var security = new DirectorySecurity();
        security.SetOwner(current);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in AllowedSids(current))
        {
            security.AddAccessRule(new FileSystemAccessRule(
                sid,
                FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow));
        }
        return security;
    }

    private static FileSecurity CreateNarrowFileSecurity()
    {
        var current = CurrentSid();
        var security = new FileSecurity();
        security.SetOwner(current);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in AllowedSids(current))
        {
            security.AddAccessRule(new FileSystemAccessRule(
                sid,
                FileSystemRights.FullControl,
                AccessControlType.Allow));
        }
        return security;
    }

    private static bool TryValidateProtectedRoot(string root, out FileIdentity identity)
    {
        identity = default;
        try
        {
            if (string.IsNullOrWhiteSpace(root) || root.Length > MaximumRootCharacters ||
                root.IndexOf('\0') >= 0 || !Path.IsPathFullyQualified(root))
            {
                return false;
            }

            var canonical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
            var supplied = Path.TrimEndingDirectorySeparator(root);
            if (!string.Equals(canonical, supplied, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(canonical, Path.TrimEndingDirectorySeparator(Path.GetPathRoot(canonical)!), StringComparison.OrdinalIgnoreCase) ||
                !Directory.Exists(canonical))
            {
                return false;
            }

            for (DirectoryInfo? cursor = new(canonical); cursor is not null; cursor = cursor.Parent)
            {
                if ((cursor.Attributes & FileAttributes.ReparsePoint) != 0)
                {
                    return false;
                }
            }

            return TryReadPathIdentity(canonical, out identity) &&
                !IsReparsePoint(identity.FileAttributes) &&
                TryValidateNarrowAcl(new DirectoryInfo(canonical));
        }
        catch
        {
            return false;
        }
    }

    private static bool TryValidateProtectedRootUnchanged(string root, FileIdentity initial) =>
        TryValidateProtectedRoot(root, out var current) && initial.SameObject(current);

    private static bool TryValidateNarrowAcl(FileSystemInfo value)
    {
        try
        {
            FileSystemSecurity security = value switch
            {
                DirectoryInfo directory => FileSystemAclExtensions.GetAccessControl(directory),
                FileInfo file => FileSystemAclExtensions.GetAccessControl(file),
                _ => throw new InvalidOperationException(),
            };
            if (!security.AreAccessRulesProtected ||
                security.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner)
            {
                return false;
            }

            var current = CurrentSid();
            if (!owner.Equals(current))
            {
                return false;
            }
            var allowed = AllowedSids(current).Select(static sid => sid.Value)
                .ToHashSet(StringComparer.Ordinal);
            var currentCanWrite = false;
            foreach (FileSystemAccessRule rule in security.GetAccessRules(
                includeExplicit: true,
                includeInherited: true,
                typeof(SecurityIdentifier)))
            {
                if (rule.IsInherited || rule.AccessControlType != AccessControlType.Allow ||
                    rule.IdentityReference is not SecurityIdentifier sid ||
                    !allowed.Contains(sid.Value))
                {
                    return false;
                }
                if (sid.Equals(current) &&
                    (rule.FileSystemRights & (FileSystemRights.WriteData | FileSystemRights.CreateFiles)) != 0)
                {
                    currentCanWrite = true;
                }
            }
            return currentCanWrite;
        }
        catch
        {
            return false;
        }
    }

    private static SecurityIdentifier CurrentSid() =>
        WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException();

    private static SecurityIdentifier[] AllowedSids(SecurityIdentifier current) =>
    [
        current,
        new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
        new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
    ];

    private static void EnsureNarrowFileIdentity(FileIdentity identity)
    {
        if (!IsNarrowFileIdentity(identity))
        {
            throw new BrokerRefusalException("destination_identity_refused");
        }
    }

    internal static bool IsNarrowFileIdentity(FileIdentity identity) =>
        identity.NumberOfLinks == 1 && !IsReparsePoint(identity.FileAttributes);

    private static bool DeleteOwnedFile(string path, FileIdentity owned)
    {
        try
        {
            if (TryProvePathAbsent(path))
            {
                return true;
            }
            if (TryReadPathIdentity(path, out var current) && owned.SameObject(current) &&
                IsNarrowFileIdentity(current))
            {
                File.Delete(path);
                return TryProvePathAbsent(path);
            }
        }
        catch
        {
            // Callers report only the fixed cleanup-uncertain sentinel.
        }
        return false;
    }

    private static bool TryReadPathIdentity(string path, out FileIdentity identity)
    {
        identity = default;
        using var handle = CreateFileW(
            path,
            FileReadAttributes | ReadControl,
            FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            return false;
        }
        identity = ReadIdentity(handle);
        return true;
    }

    private static FileIdentity ReadIdentity(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandle(handle, out var information))
        {
            throw new InvalidOperationException();
        }
        return new FileIdentity(
            information.VolumeSerialNumber,
            information.FileIndexHigh,
            information.FileIndexLow,
            information.NumberOfLinks,
            information.FileAttributes);
    }

    private static bool TryProvePathAbsent(string path)
    {
        var attributes = GetFileAttributesW(path);
        if (attributes != InvalidFileAttributes)
        {
            return false;
        }
        return Marshal.GetLastPInvokeError() is 2 or 3;
    }

    private static bool IsReparsePoint(uint attributes) =>
        (attributes & (uint)FileAttributes.ReparsePoint) != 0;

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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string path);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);
}
