Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This module is test-only. Positive assurance starts in the dedicated clean
# PowerShell 7 host. It does not claim to resist arbitrary equal-trust hostile
# code that is allowed to execute in this process after authority handoff; that
# stronger requirement needs a separately isolated broker.
$reservedFixtureTypeNames = @(
    'RevAgent.TestFixtures.RevAgentTestFixtureAuthority',
    'RevAgent.TestFixtures.RevAgentTestFixtureOwnership',
    'RevAgent.TestFixtures.RevAgentGuiStartupFailureLogLease',
    'RevAgent.TestFixtures.RevAgentDesktopLauncherDiscoveryLease',
    'RevAgent.TestFixtures.RevAgentLauncherFileBatchLease',
    'RevAgent.TestFixtures.RevAgentPinnedLauncherFileLease'
)
$reservedCollision = @([AppDomain]::CurrentDomain.GetAssemblies() | ForEach-Object {
        $assembly = $_
        foreach ($name in $reservedFixtureTypeNames) {
            $assembly.GetType($name, $false, $false)
        }
    } | Where-Object { $null -ne $_ })
if ($reservedCollision.Count -ne 0) { throw 'fixture_authority_type_preloaded' }

$script:RevAgentFixtureNamespace = 'RevAgent.TestFixtures.Run_' + [Guid]::NewGuid().ToString('N')
$typeDefinition = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace __REVAGENT_FIXTURE_NAMESPACE__
{
    internal enum FixturePurpose { GuiStartupFailureLog = 1, DesktopLauncherDiscovery = 2 }

    internal sealed class FileIdentity
    {
        internal readonly ulong Volume;
        internal readonly byte[] Id;
        internal readonly string DosPath;
        internal readonly string GuidPath;
        internal readonly uint Links;
        internal FileIdentity(ulong volume, byte[] id, string dos, string guid, uint links)
        {
            Volume = volume; Id = id; DosPath = dos; GuidPath = guid; Links = links;
        }
        internal bool Same(FileIdentity other)
        {
            return other != null && Volume == other.Volume && Id.SequenceEqual(other.Id) &&
                String.Equals(DosPath, other.DosPath, StringComparison.OrdinalIgnoreCase) &&
                String.Equals(GuidPath, other.GuidPath, StringComparison.OrdinalIgnoreCase) && Links == other.Links;
        }
    }

    internal sealed class PinnedObject : IDisposable
    {
        internal SafeFileHandle Handle;
        internal readonly FileIdentity Identity;
        internal readonly bool Directory;
        internal PinnedObject(SafeFileHandle handle, FileIdentity identity, bool directory)
        {
            Handle = handle; Identity = identity; Directory = directory;
        }
        public void Dispose()
        {
            if (Handle != null) { Handle.Dispose(); Handle = null; }
        }
    }

    internal static class NativeFixture
    {
        internal const uint GENERIC_READ = 0x80000000;
        internal const uint GENERIC_WRITE = 0x40000000;
        internal const uint FILE_SHARE_READ = 1;
        internal const uint FILE_SHARE_WRITE = 2;
        internal const uint OPEN_EXISTING = 3;
        internal const uint CREATE_NEW = 1;
        internal const uint FILE_ATTRIBUTE_NORMAL = 0x80;
        internal const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        internal const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        internal const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
        internal const int ERROR_FILE_NOT_FOUND = 2;
        internal const int ERROR_PATH_NOT_FOUND = 3;
        internal const int SE_FILE_OBJECT = 1;
        internal const uint OWNER_SECURITY_INFORMATION = 0x00000001;
        internal const uint DACL_SECURITY_INFORMATION = 0x00000004;

        [StructLayout(LayoutKind.Sequential)] internal struct FILE_ID_128 { [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] internal byte[] Identifier; }
        [StructLayout(LayoutKind.Sequential)] internal struct FILE_ID_INFO { internal ulong VolumeSerialNumber; internal FILE_ID_128 FileId; }
        [StructLayout(LayoutKind.Sequential)] internal struct FILE_ATTRIBUTE_TAG_INFO { internal uint FileAttributes; internal uint ReparseTag; }
        [StructLayout(LayoutKind.Sequential)] internal struct FILE_STANDARD_INFO { internal long AllocationSize; internal long EndOfFile; internal uint NumberOfLinks; [MarshalAs(UnmanagedType.U1)] internal bool DeletePending; [MarshalAs(UnmanagedType.U1)] internal bool Directory; }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, IntPtr info, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool GetVolumePathNameW(string fileName, StringBuilder volumePath, uint length);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool GetVolumeNameForVolumeMountPointW(string mountPoint, StringBuilder volumeName, uint length);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern uint QueryDosDeviceW(string deviceName, StringBuilder target, int max);
        [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool DuplicateHandle(IntPtr sourceProcess, SafeFileHandle source, IntPtr targetProcess, out SafeFileHandle target, uint access, bool inherit, uint options);
        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern uint GetSecurityInfo(
            SafeFileHandle handle,
            int objectType,
            uint securityInfo,
            out IntPtr owner,
            out IntPtr group,
            out IntPtr dacl,
            out IntPtr sacl,
            out IntPtr securityDescriptor);
        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern uint GetSecurityDescriptorLength(IntPtr securityDescriptor);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr LocalFree(IntPtr value);

        internal static SafeFileHandle DuplicateForStream(SafeFileHandle source)
        {
            SafeFileHandle duplicate;
            IntPtr process = GetCurrentProcess();
            if (!DuplicateHandle(process, source, process, out duplicate, 0, false, 2)) throw new IOException("fixture_handle_duplicate_failed", Marshal.GetLastWin32Error());
            return duplicate;
        }

        internal static int CurrentPid()
        {
            PropertyInfo p = typeof(Environment).GetProperty("ProcessId", BindingFlags.Public | BindingFlags.Static);
            if (p != null) return (int)p.GetValue(null, null);
            using (Process process = Process.GetCurrentProcess()) return process.Id;
        }

        internal static string CanonicalInput(string input, bool requireDirectory)
        {
            if (String.IsNullOrWhiteSpace(input)) throw new InvalidOperationException("fixture_path_invalid");
            if (input.StartsWith("\\\\", StringComparison.Ordinal) || input.StartsWith("\\\\?\\", StringComparison.Ordinal) ||
                input.StartsWith("\\\\.\\", StringComparison.Ordinal) || input.IndexOf("GLOBALROOT", StringComparison.OrdinalIgnoreCase) >= 0)
                throw new InvalidOperationException("fixture_path_namespace_refused");
            if (!Path.IsPathRooted(input) || input.Length < 4 || input[1] != ':' || (input.IndexOf(':', 2) >= 0))
                throw new InvalidOperationException("fixture_path_alias_refused");
            string full = Path.GetFullPath(input).TrimEnd('\\');
            if (full.Length <= 3 || full.EndsWith(" ", StringComparison.Ordinal) || full.EndsWith(".", StringComparison.Ordinal))
                throw new InvalidOperationException("fixture_path_noncanonical");
            if (!String.Equals(full, input.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("fixture_path_noncanonical");
            AssertDriveNotAlias(full);
            return full;
        }

        internal static void AssertDriveNotAlias(string path)
        {
            string drive = Path.GetPathRoot(path).Substring(0, 2);
            StringBuilder target = new StringBuilder(32768);
            uint result = QueryDosDeviceW(drive, target, target.Capacity);
            if (result == 0) throw new InvalidOperationException("fixture_drive_identity_unknown");
            string[] mappings = target.ToString().Split(new char[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
            if (mappings.Length != 1 || mappings[0].StartsWith("\\??\\", StringComparison.OrdinalIgnoreCase) ||
                mappings[0].StartsWith("\\DosDevices\\", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("fixture_dos_alias_refused");
            StringBuilder mount = new StringBuilder(32768);
            if (!GetVolumePathNameW(path, mount, (uint)mount.Capacity)) throw new InvalidOperationException("fixture_volume_path_unknown");
            if (!String.Equals(mount.ToString().TrimEnd('\\'), Path.GetPathRoot(path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("fixture_volume_mount_alias_refused");
            StringBuilder volume = new StringBuilder(32768);
            if (!GetVolumeNameForVolumeMountPointW(mount.ToString(), volume, (uint)volume.Capacity) || !volume.ToString().StartsWith("\\\\?\\Volume{", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("fixture_volume_identity_unknown");
        }

        internal static PinnedObject TryOpenObject(string path, bool optional)
        {
            SafeFileHandle h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            if (h.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error(); h.Dispose();
                if (optional && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)) return null;
                throw new IOException("fixture_native_open_failed", error);
            }
            try
            {
                FILE_ATTRIBUTE_TAG_INFO tag = ReadStruct<FILE_ATTRIBUTE_TAG_INFO>(h, 9);
                if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || tag.ReparseTag != 0)
                    throw new InvalidOperationException("fixture_reparse_refused");
                FILE_STANDARD_INFO standard = ReadStruct<FILE_STANDARD_INFO>(h, 1);
                FileIdentity id = Identity(h);
                if (!standard.Directory && id.Links != 1)
                    throw new InvalidOperationException("fixture_hardlink_refused");
                VerifyPathIdentity(path, h, id);
                ValidateHandleAcl(h, id);
                VerifyPathIdentity(path, h, id);
                return new PinnedObject(h, id, standard.Directory);
            }
            catch { h.Dispose(); throw; }
        }

        internal static SafeFileHandle OpenDirectory(string path)
        {
            PinnedObject pinned = TryOpenObject(path, false);
            if (!pinned.Directory) { pinned.Dispose(); throw new InvalidOperationException("fixture_object_type_mismatch"); }
            SafeFileHandle handle = pinned.Handle; pinned.Handle = null; pinned.Dispose(); return handle;
        }

        internal static SafeFileHandle TryOpenDirectory(string path)
        {
            PinnedObject pinned = TryOpenObject(path, true);
            if (pinned == null) return null;
            if (!pinned.Directory) { pinned.Dispose(); throw new InvalidOperationException("fixture_object_type_mismatch"); }
            SafeFileHandle handle = pinned.Handle; pinned.Handle = null; pinned.Dispose(); return handle;
        }

        internal static SafeFileHandle OpenReadFile(string path)
        {
            PinnedObject pinned = TryOpenObject(path, false);
            if (pinned.Directory) { pinned.Dispose(); throw new InvalidOperationException("fixture_object_type_mismatch"); }
            SafeFileHandle handle = pinned.Handle; pinned.Handle = null; pinned.Dispose(); return handle;
        }

        internal static SafeFileHandle OpenWritableFile(string path)
        {
            SafeFileHandle h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            if (h.IsInvalid) {
                int openError = Marshal.GetLastWin32Error(); h.Dispose();
                if (openError != ERROR_FILE_NOT_FOUND && openError != ERROR_PATH_NOT_FOUND)
                    throw new IOException("fixture_file_open_failed", openError);
                h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, IntPtr.Zero, CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            }
            if (h.IsInvalid) throw new IOException("fixture_file_create_failed", Marshal.GetLastWin32Error());
            try { ValidateNoReparse(h, false); FileIdentity id = Identity(h); if (id.Links != 1) throw new InvalidOperationException("fixture_hardlink_refused"); VerifyPathIdentity(path, h, id); ValidateHandleAcl(h, id); VerifyPathIdentity(path, h, id); return h; }
            catch { h.Dispose(); throw; }
        }

        internal static SafeFileHandle CreateNewExclusiveFile(string path)
        {
            SafeFileHandle h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, IntPtr.Zero, CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            if (h.IsInvalid) throw new IOException("fixture_file_create_new_failed", Marshal.GetLastWin32Error());
            try { ValidateNoReparse(h, false); FileIdentity id = Identity(h); if (id.Links != 1) throw new InvalidOperationException("fixture_hardlink_refused"); VerifyPathIdentity(path, h, id); ValidateHandleAcl(h, id); VerifyPathIdentity(path, h, id); return h; }
            catch { h.Dispose(); throw; }
        }

        internal static void ValidateNoReparse(SafeFileHandle h, bool directory)
        {
            FILE_ATTRIBUTE_TAG_INFO info = ReadStruct<FILE_ATTRIBUTE_TAG_INFO>(h, 9);
            if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || info.ReparseTag != 0)
                throw new InvalidOperationException("fixture_reparse_refused");
            FILE_STANDARD_INFO standard = ReadStruct<FILE_STANDARD_INFO>(h, 1);
            if (standard.Directory != directory) throw new InvalidOperationException("fixture_object_type_mismatch");
        }

        internal static T ReadStruct<T>(SafeFileHandle h, int infoClass) where T : struct
        {
            int size = Marshal.SizeOf(typeof(T)); IntPtr p = Marshal.AllocHGlobal(size);
            try {
                if (!GetFileInformationByHandleEx(h, infoClass, p, (uint)size)) throw new IOException("fixture_identity_read_failed", Marshal.GetLastWin32Error());
                return (T)Marshal.PtrToStructure(p, typeof(T));
            } finally { Marshal.FreeHGlobal(p); }
        }

        internal static FileIdentity Identity(SafeFileHandle h)
        {
            FILE_ID_INFO id = ReadStruct<FILE_ID_INFO>(h, 18);
            FILE_STANDARD_INFO standard = ReadStruct<FILE_STANDARD_INFO>(h, 1);
            string dos = FinalPath(h, 0);
            string guid = FinalPath(h, 1);
            return new FileIdentity(id.VolumeSerialNumber, id.FileId.Identifier, dos, guid, standard.NumberOfLinks);
        }

        internal static string FinalPath(SafeFileHandle h, uint flags)
        {
            StringBuilder value = new StringBuilder(32768);
            uint n = GetFinalPathNameByHandleW(h, value, (uint)value.Capacity, flags);
            if (n == 0 || n >= value.Capacity) throw new IOException("fixture_final_path_failed", Marshal.GetLastWin32Error());
            string path = value.ToString();
            if (path.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) return "\\\\" + path.Substring(8).TrimEnd('\\');
            if (path.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase)) return path.Substring(4).TrimEnd('\\');
            return path.TrimEnd('\\');
        }

        internal static void VerifyPathIdentity(string expectedPath, SafeFileHandle h, FileIdentity expected)
        {
            if (h == null || h.IsInvalid || h.IsClosed) throw new InvalidOperationException("fixture_handle_invalid");
            FileIdentity now = Identity(h);
            if (!expected.Same(now)) throw new InvalidOperationException("fixture_identity_drift");
            if (!String.Equals(expectedPath.TrimEnd('\\'), now.DosPath, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("fixture_final_path_mismatch");
        }

        internal static bool IsWithin(string child, string root)
        {
            return child.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
        }

        internal static void ValidateHandleAcl(SafeFileHandle handle, FileIdentity expectedIdentity)
        {
            if (handle == null || handle.IsInvalid || handle.IsClosed)
                throw new InvalidOperationException("fixture_handle_invalid");
            FileIdentity before = Identity(handle);
            if (!expectedIdentity.Same(before)) throw new InvalidOperationException("fixture_identity_drift");
            IntPtr owner, group, dacl, sacl, descriptor;
            uint status = GetSecurityInfo(handle, SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                out owner, out group, out dacl, out sacl, out descriptor);
            if (status != 0 || descriptor == IntPtr.Zero)
                throw new IOException("fixture_handle_acl_read_failed", unchecked((int)status));
            try
            {
                uint length = GetSecurityDescriptorLength(descriptor);
                if (length == 0 || length > 1024 * 1024)
                    throw new InvalidOperationException("fixture_acl_descriptor_uncertain");
                byte[] bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, (int)length);
                RawSecurityDescriptor security = new RawSecurityDescriptor(bytes, 0);
                WindowsIdentity identity = WindowsIdentity.GetCurrent();
                SecurityIdentifier me = identity.User;
                if (security.Owner == null || !security.Owner.Equals(me))
                    throw new InvalidOperationException("fixture_owner_untrusted");
                if ((security.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 || security.DiscretionaryAcl == null)
                    throw new InvalidOperationException("fixture_acl_untrusted");
                SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
                SecurityIdentifier admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
                const int writeMask = unchecked((int)0x500D0156);
                bool inheritedSeen = false;
                foreach (GenericAce generic in security.DiscretionaryAcl)
                {
                    if ((generic.AceFlags & AceFlags.Inherited) != 0) inheritedSeen = true;
                    else if (inheritedSeen) throw new InvalidOperationException("fixture_acl_noncanonical");
                    QualifiedAce ace = generic as QualifiedAce;
                    KnownAce known = generic as KnownAce;
                    if (ace == null || known == null || ace.SecurityIdentifier == null)
                        throw new InvalidOperationException("fixture_acl_unknown");
                    if (ace.AceQualifier == AceQualifier.AccessDenied)
                        throw new InvalidOperationException("fixture_acl_deny_uncertain");
                    if (ace.AceQualifier != AceQualifier.AccessAllowed)
                        throw new InvalidOperationException("fixture_acl_unknown");
                    bool writeCapable = (known.AccessMask & writeMask) != 0;
                    if (writeCapable && !ace.SecurityIdentifier.Equals(me) &&
                        !ace.SecurityIdentifier.Equals(system) &&
                        !ace.SecurityIdentifier.Equals(admins))
                        throw new InvalidOperationException("fixture_acl_untrusted");
                }
            }
            finally { LocalFree(descriptor); }
            FileIdentity after = Identity(handle);
            if (!expectedIdentity.Same(after)) throw new InvalidOperationException("fixture_identity_drift");
        }

        internal static string RequireTempChild(string input)
        {
            string root = CanonicalInput(input, true);
            string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\');
            if (!IsWithin(root, temp)) throw new InvalidOperationException("fixture_root_not_owned_temp_child");
            return root;
        }
    }

    public sealed class RevAgentPinnedLauncherFileLease : IDisposable
    {
        private SafeFileHandle handle; private readonly FileIdentity identity; private readonly string path; private RevAgentTestFixtureAuthority owner; private int disposed;
        internal RevAgentPinnedLauncherFileLease(RevAgentTestFixtureAuthority authority, string candidate, ulong rootVolume)
        {
            owner = authority;
            path = NativeFixture.CanonicalInput(candidate, false);
            handle = NativeFixture.OpenReadFile(path); identity = NativeFixture.Identity(handle);
            if (identity.Volume != rootVolume) { Dispose(); throw new InvalidOperationException("fixture_volume_mismatch"); }
            NativeFixture.VerifyPathIdentity(path, handle, identity);
        }
        internal RevAgentPinnedLauncherFileLease(RevAgentTestFixtureAuthority authority, string candidate, ulong rootVolume, PinnedObject pinned)
        {
            owner = authority;
            path = NativeFixture.CanonicalInput(candidate, false);
            if (pinned == null || pinned.Directory) throw new InvalidOperationException("fixture_object_type_mismatch");
            handle = pinned.Handle; pinned.Handle = null; pinned.Dispose(); identity = NativeFixture.Identity(handle);
            if (identity.Volume != rootVolume) { Dispose(); throw new InvalidOperationException("fixture_volume_mismatch"); }
            NativeFixture.VerifyPathIdentity(path, handle, identity);
        }
        public string FullName { get { Ensure(); return path; } }
        public string Name { get { Ensure(); return Path.GetFileName(path); } }
        public string Extension { get { Ensure(); return Path.GetExtension(path); } }
        internal FileIdentity PinnedIdentity { get { Ensure(); return identity; } }
        public byte[] ReadAllBytes() { return ReadBytesPreservingHandle(); }
        public string ReadAllText() { return Encoding.UTF8.GetString(ReadBytesPreservingHandle()); }
        private byte[] ReadBytesPreservingHandle()
        {
            try {
                Ensure(); NativeFixture.VerifyPathIdentity(path, handle, identity);
                byte[] bytes;
                using (FileStream stream = new FileStream(NativeFixture.DuplicateForStream(handle), FileAccess.Read, 65536, false)) {
                    stream.Position = 0;
                    bytes = new byte[stream.Length]; int at = 0; while (at < bytes.Length) { int n = stream.Read(bytes, at, bytes.Length - at); if (n == 0) break; at += n; }
                }
                NativeFixture.VerifyPathIdentity(path, handle, identity); return bytes;
            } catch { if (owner != null) owner.PoisonFromLease(); throw; }
        }
        public void VerifyIdentity() { try { Ensure(); NativeFixture.VerifyPathIdentity(path, handle, identity); } catch { if (owner != null) owner.PoisonFromLease(); throw; } }
        private void Ensure() { if (disposed != 0 || handle == null || handle.IsInvalid || handle.IsClosed) throw new ObjectDisposedException("launcher_file_lease"); }
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0 && handle != null) { handle.Dispose(); handle = null; owner = null; } }
    }

    public sealed class RevAgentLauncherFileBatchLease : IDisposable
    {
        private RevAgentTestFixtureAuthority owner;
        private RevAgentPinnedLauncherFileLease[] files;
        private int disposed;
        internal RevAgentLauncherFileBatchLease(RevAgentTestFixtureAuthority authority, IEnumerable<RevAgentPinnedLauncherFileLease> values)
        {
            owner = authority ?? throw new ArgumentNullException("authority");
            files = (values ?? throw new ArgumentNullException("values")).ToArray();
            owner.RegisterLease(this);
        }
        public RevAgentPinnedLauncherFileLease[] Files
        {
            get { Ensure(); return files.ToArray(); }
        }
        public int Count { get { Ensure(); return files.Length; } }
        private void Ensure()
        {
            if (disposed != 0 || owner == null) throw new ObjectDisposedException("launcher_file_batch");
            owner.AssertCreator();
        }
        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0) return;
            RevAgentTestFixtureAuthority authority = owner; owner = null;
            RevAgentPinnedLauncherFileLease[] owned = files ?? new RevAgentPinnedLauncherFileLease[0];
            files = new RevAgentPinnedLauncherFileLease[0];
            foreach (RevAgentPinnedLauncherFileLease file in owned) file.Dispose();
            if (authority != null) authority.ReleaseLease(this);
        }
    }

    public sealed class RevAgentGuiStartupFailureLogLease : IDisposable
    {
        private RevAgentTestFixtureAuthority owner; private int disposed;
        internal RevAgentGuiStartupFailureLogLease(RevAgentTestFixtureAuthority authority) { owner = authority; }
        public string WriteStartupFailureLog(string[] lines)
        {
            Ensure(); return owner.WriteGuiLog(lines);
        }
        private void Ensure() { if (disposed != 0 || owner == null) throw new ObjectDisposedException("gui_fixture_lease"); owner.AssertCreator(); }
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0 && owner != null) { RevAgentTestFixtureAuthority a = owner; owner = null; a.DisposeFromLease(); } }
    }

    public sealed class RevAgentDesktopLauncherDiscoveryLease : IDisposable
    {
        private RevAgentTestFixtureAuthority owner; private int disposed;
        internal RevAgentDesktopLauncherDiscoveryLease(RevAgentTestFixtureAuthority authority) { owner = authority; }
        public string ReportsRoot { get { Ensure(); return owner.ReportsRootDiagnostic; } }
        public string DiscoveryRoot { get { Ensure(); return owner.DiscoveryRootDiagnostic; } }
        public string[] GetDefaultLauncherDirectories() { Ensure(); return owner.GetDefaultLauncherDirectories(); }
        public RevAgentLauncherFileBatchLease OpenLauncherFiles(string[] paths, bool recursive, string[] extensions) { Ensure(); return owner.OpenLauncherFiles(paths, recursive, extensions); }
        public string ReadReport(string relativePath) { Ensure(); return owner.ReadReport(relativePath); }
        public void WriteReport(string relativePath, string json) { Ensure(); owner.WriteReport(relativePath, json); }
        private void Ensure() { if (disposed != 0 || owner == null) throw new ObjectDisposedException("desktop_fixture_lease"); owner.AssertCreator(); }
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0 && owner != null) { RevAgentTestFixtureAuthority a = owner; owner = null; a.DisposeFromLease(); } }
    }

    internal static class OwnershipState
    {
        internal static readonly object Nonce = new object();
    }

    public sealed class RevAgentTestFixtureOwnership
    {
        private readonly object nonce;
        private RevAgentTestFixtureOwnership(Type authorityType, object moduleInfo, string modulePath, string moduleSha256)
        {
            if (authorityType == null || moduleInfo == null || authorityType.Assembly != typeof(RevAgentTestFixtureOwnership).Assembly) throw new InvalidOperationException("fixture_ownership_type_mismatch");
            AuthorityType = authorityType; ModuleInfo = moduleInfo; ModulePath = modulePath; ModuleSha256 = moduleSha256;
            ImplementationAssembly = authorityType.Assembly; ModuleVersionId = authorityType.Module.ModuleVersionId;
            ImplementationModule = authorityType.Module; AssemblyIsDynamic = authorityType.Assembly.IsDynamic;
            nonce = OwnershipState.Nonce;
        }
        public Type AuthorityType { get; private set; }
        public Assembly ImplementationAssembly { get; private set; }
        public Module ImplementationModule { get; private set; }
        public bool AssemblyIsDynamic { get; private set; }
        public Guid ModuleVersionId { get; private set; }
        public object ModuleInfo { get; private set; }
        public string ModulePath { get; private set; }
        public string ModuleSha256 { get; private set; }
        public static RevAgentTestFixtureOwnership Create(Type authorityType, object moduleInfo, string modulePath, string moduleSha256) { return new RevAgentTestFixtureOwnership(authorityType, moduleInfo, modulePath, moduleSha256); }
        public bool OwnsAuthority(RevAgentTestFixtureAuthority value, object moduleInfo, object hostProvenance, string expectedPurpose)
        {
            return value != null && Object.ReferenceEquals(value.GetType(), AuthorityType) &&
                Object.ReferenceEquals(ModuleInfo, moduleInfo) && value.OwnsNonce(nonce) &&
                value.MatchesProvenance(moduleInfo, hostProvenance, expectedPurpose);
        }
    }

    public sealed class RevAgentTestFixtureAuthority : IDisposable
    {
        private static readonly ConditionalWeakTable<RevAgentTestFixtureAuthority, object> Issued = new ConditionalWeakTable<RevAgentTestFixtureAuthority, object>();
        private readonly FixturePurpose purpose; private readonly int creatorPid; private readonly string rootPath;
        private readonly object moduleInfo, hostProvenance;
        private readonly string guiLogPath; private readonly string discoveryPath; private readonly string reportsPath; private readonly string collisionLogName;
        private readonly object ownershipNonce = OwnershipState.Nonce;
        private SafeFileHandle rootHandle, markerHandle, firstHandle, secondHandle; private readonly FileIdentity rootIdentity, markerIdentity, firstIdentity, secondIdentity;
        private readonly List<SafeFileHandle> retainedDirectories = new List<SafeFileHandle>(); private readonly Dictionary<string, string> retainedIds = new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly object leaseSync = new object(); private readonly List<IDisposable> issuedLeases = new List<IDisposable>();
        private int state; // 0 issued, 1 consumed, 2 disposed/poisoned

        private RevAgentTestFixtureAuthority(FixturePurpose p, object liveModuleInfo, object provenance, string root, string first, string second, string forcedGuiLogName)
        {
            if (liveModuleInfo == null || provenance == null) throw new InvalidOperationException("fixture_authority_provenance_refused");
            purpose = p; moduleInfo = liveModuleInfo; hostProvenance = provenance; creatorPid = NativeFixture.CurrentPid(); rootPath = NativeFixture.RequireTempChild(root);
            try {
            rootHandle = NativeFixture.OpenDirectory(rootPath); rootIdentity = NativeFixture.Identity(rootHandle); NativeFixture.VerifyPathIdentity(rootPath, rootHandle, rootIdentity);
            if (p == FixturePurpose.GuiStartupFailureLog) {
                if (!String.IsNullOrEmpty(forcedGuiLogName) && (Path.GetFileName(forcedGuiLogName) != forcedGuiLogName || !forcedGuiLogName.StartsWith("gui-startup-", StringComparison.Ordinal) || !forcedGuiLogName.EndsWith(".log", StringComparison.OrdinalIgnoreCase)))
                    throw new InvalidOperationException("fixture_gui_log_name_refused");
                collisionLogName = forcedGuiLogName;
                guiLogPath = RequireDescendantDirectory(first); firstHandle = NativeFixture.OpenDirectory(guiLogPath); firstIdentity = ValidateChild(guiLogPath, firstHandle);
            } else {
                discoveryPath = RequireDescendantDirectory(first); reportsPath = RequireDescendantDirectory(second);
                firstHandle = NativeFixture.OpenDirectory(discoveryPath); firstIdentity = ValidateChild(discoveryPath, firstHandle);
                secondHandle = NativeFixture.OpenDirectory(reportsPath); secondIdentity = ValidateChild(reportsPath, secondHandle);
            }
            string markerPath = Path.Combine(rootPath, ".revagent-test-fixture-owner");
            markerHandle = NativeFixture.CreateNewExclusiveFile(markerPath); markerIdentity = NativeFixture.Identity(markerHandle);
            using (FileStream marker = new FileStream(NativeFixture.DuplicateForStream(markerHandle), FileAccess.ReadWrite, 1, false)) { if (marker.Length != 0) throw new InvalidOperationException("fixture_marker_not_empty"); }
            NativeFixture.VerifyPathIdentity(markerPath, markerHandle, markerIdentity);
            Issued.Add(this, new object()); state = 0;
            }
            catch { DisposeHandles(); throw; }
        }

        public static RevAgentTestFixtureAuthority IssueGui(object moduleInfo, object hostProvenance, string root, string logDirectory, string forcedGuiLogName) { return new RevAgentTestFixtureAuthority(FixturePurpose.GuiStartupFailureLog, moduleInfo, hostProvenance, root, logDirectory, null, forcedGuiLogName); }
        public static RevAgentTestFixtureAuthority IssueDesktop(object moduleInfo, object hostProvenance, string root, string discoveryRoot, string reportsRoot) { return new RevAgentTestFixtureAuthority(FixturePurpose.DesktopLauncherDiscovery, moduleInfo, hostProvenance, root, discoveryRoot, reportsRoot, null); }
        internal bool OwnsNonce(object value) { return Object.ReferenceEquals(ownershipNonce, value); }
        internal bool MatchesProvenance(object liveModuleInfo, object provenance, string expectedPurpose)
        {
            return Object.ReferenceEquals(moduleInfo, liveModuleInfo) && Object.ReferenceEquals(hostProvenance, provenance) &&
                ((purpose == FixturePurpose.GuiStartupFailureLog && String.Equals(expectedPurpose, "GuiStartupFailureLog", StringComparison.Ordinal)) ||
                 (purpose == FixturePurpose.DesktopLauncherDiscovery && String.Equals(expectedPurpose, "DesktopLauncherDiscovery", StringComparison.Ordinal)));
        }
        public bool ValidateConsumerBinding(object liveModuleInfo, object provenance, string expectedPurpose)
        {
            return OwnsNonce(OwnershipState.Nonce) && MatchesProvenance(liveModuleInfo, provenance, expectedPurpose);
        }
        internal void RegisterLease(IDisposable lease)
        {
            if (lease == null) throw new ArgumentNullException("lease");
            lock (leaseSync) { if (state == 2) throw new ObjectDisposedException("fixture_authority"); issuedLeases.Add(lease); }
        }
        internal void ReleaseLease(IDisposable lease) { lock (leaseSync) issuedLeases.Remove(lease); }
        private string RequireDescendantDirectory(string path) { string full = NativeFixture.CanonicalInput(path, true); if (!NativeFixture.IsWithin(full, rootPath)) throw new InvalidOperationException("fixture_target_outside_root"); return full; }
        private FileIdentity ValidateChild(string path, SafeFileHandle handle) { FileIdentity id = NativeFixture.Identity(handle); if (id.Volume != rootIdentity.Volume) throw new InvalidOperationException("fixture_volume_mismatch"); NativeFixture.VerifyPathIdentity(path, handle, id); return id; }
        internal void AssertCreator() { if (NativeFixture.CurrentPid() != creatorPid || Volatile.Read(ref state) != 1) { Poison(); throw new InvalidOperationException("fixture_authority_process_or_state_refused"); } }
        private void Consume(FixturePurpose expected)
        {
            object marker; if (!Issued.TryGetValue(this, out marker) || Interlocked.CompareExchange(ref state, 1, 0) != 0) { Poison(); throw new InvalidOperationException("fixture_authority_reuse_refused"); }
            if (NativeFixture.CurrentPid() != creatorPid || purpose != expected) { Poison(); throw new InvalidOperationException("fixture_authority_purpose_or_process_refused"); }
            try { VerifyAll(); } catch { Poison(); throw; }
        }
        public RevAgentGuiStartupFailureLogLease ConsumeGuiStartupFailureLog() { Consume(FixturePurpose.GuiStartupFailureLog); RevAgentGuiStartupFailureLogLease lease = new RevAgentGuiStartupFailureLogLease(this); RegisterLease(lease); return lease; }
        public RevAgentDesktopLauncherDiscoveryLease ConsumeDesktopLauncherDiscovery() { Consume(FixturePurpose.DesktopLauncherDiscovery); RevAgentDesktopLauncherDiscoveryLease lease = new RevAgentDesktopLauncherDiscoveryLease(this); RegisterLease(lease); return lease; }
        private void VerifyAll()
        {
            NativeFixture.VerifyPathIdentity(rootPath, rootHandle, rootIdentity); NativeFixture.VerifyPathIdentity(Path.Combine(rootPath, ".revagent-test-fixture-owner"), markerHandle, markerIdentity);
            if (purpose == FixturePurpose.GuiStartupFailureLog) NativeFixture.VerifyPathIdentity(guiLogPath, firstHandle, firstIdentity);
            else { NativeFixture.VerifyPathIdentity(discoveryPath, firstHandle, firstIdentity); NativeFixture.VerifyPathIdentity(reportsPath, secondHandle, secondIdentity); }
        }

        internal string ReportsRootDiagnostic { get { AssertCreator(); return reportsPath; } }
        internal string DiscoveryRootDiagnostic { get { AssertCreator(); return discoveryPath; } }
        private string IdentityKey(FileIdentity id) { return id.Volume.ToString("X16") + ":" + BitConverter.ToString(id.Id); }
        private SafeFileHandle PinDirectory(string candidate, bool required)
        {
            string full = NativeFixture.CanonicalInput(candidate, false);
            if (!NativeFixture.IsWithin(full, discoveryPath) && !NativeFixture.IsWithin(full, reportsPath) && !String.Equals(full, discoveryPath, StringComparison.OrdinalIgnoreCase) && !String.Equals(full, reportsPath, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("fixture_descendant_outside_authority");
            SafeFileHandle h = NativeFixture.TryOpenDirectory(full);
            if (h == null) { if (required) throw new DirectoryNotFoundException("fixture_descendant_missing"); return null; }
            FileIdentity id = ValidateChild(full, h); string key = IdentityKey(id);
            string prior;
            if (retainedIds.TryGetValue(key, out prior)) {
                h.Dispose();
                if (!String.Equals(prior, full, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("fixture_duplicate_fileid_refused");
                return null;
            }
            retainedIds.Add(key, full);
            retainedDirectories.Add(h); return h;
        }
        private void AddIfDirectory(List<string> result, string path) { SafeFileHandle h = PinDirectory(path, false); if (h != null) result.Add(path); }
        internal string[] GetDefaultLauncherDirectories()
        {
            AssertCreator(); VerifyAll(); List<string> result = new List<string>();
            AddIfDirectory(result, Path.Combine(discoveryPath, "known-folders", "DesktopDirectory"));
            AddIfDirectory(result, Path.Combine(discoveryPath, "known-folders", "CommonDesktopDirectory"));
            string current = Path.Combine(discoveryPath, "current-profile"); SafeFileHandle currentPin = PinDirectory(current, false);
            if (currentPin != null) {
            AddIfDirectory(result, Path.Combine(current, "Desktop"));
            foreach (string one in Directory.EnumerateDirectories(current, "OneDrive*", SearchOption.TopDirectoryOnly)) { PinDirectory(one, true); AddIfDirectory(result, Path.Combine(one, "Desktop")); }
            }
            string profiles = Path.Combine(discoveryPath, "profiles"); SafeFileHandle profilesPin = PinDirectory(profiles, false);
            if (profilesPin != null) foreach (string profile in Directory.EnumerateDirectories(profiles, "*", SearchOption.TopDirectoryOnly)) {
                PinDirectory(profile, true); AddIfDirectory(result, Path.Combine(profile, "Desktop"));
                foreach (string one in Directory.EnumerateDirectories(profile, "OneDrive*", SearchOption.TopDirectoryOnly)) { PinDirectory(one, true); AddIfDirectory(result, Path.Combine(one, "Desktop")); }
            }
            VerifyAll(); return result.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }
        internal RevAgentLauncherFileBatchLease OpenLauncherFiles(string[] paths, bool recursive, string[] extensions)
        {
            AssertCreator(); VerifyAll(); List<RevAgentPinnedLauncherFileLease> files = new List<RevAgentPinnedLauncherFileLease>(); HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try {
                foreach (string candidate in paths ?? new string[0]) {
                    string full = NativeFixture.CanonicalInput(candidate, false);
                    if (!NativeFixture.IsWithin(full, discoveryPath) && !String.Equals(full, discoveryPath, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("fixture_launcher_path_outside_discovery");
                    PinnedObject candidatePin = NativeFixture.TryOpenObject(full, true);
                    if (candidatePin == null) continue;
                    if (!candidatePin.Directory) { AddLauncher(full, extensions, seen, files, candidatePin); continue; }
                    candidatePin.Dispose(); PinDirectory(full, true);
                    if (recursive) {
                        Queue<string> pending = new Queue<string>(); pending.Enqueue(full);
                        while (pending.Count != 0) {
                            string current = pending.Dequeue();
                            foreach (string directory in Directory.EnumerateDirectories(current, "*", SearchOption.TopDirectoryOnly)) { PinDirectory(directory, true); pending.Enqueue(directory); }
                            foreach (string file in Directory.EnumerateFiles(current, "*", SearchOption.TopDirectoryOnly)) AddLauncher(file, extensions, seen, files);
                        }
                    } else {
                        foreach (string file in Directory.EnumerateFiles(full, "*", SearchOption.TopDirectoryOnly)) AddLauncher(file, extensions, seen, files);
                    }
                }
                VerifyAll(); return new RevAgentLauncherFileBatchLease(this,
                    files.OrderBy(delegate(RevAgentPinnedLauncherFileLease f) { return f.FullName; }, StringComparer.OrdinalIgnoreCase));
            } catch { foreach (IDisposable f in files) f.Dispose(); Poison(); throw; }
        }
        private void AddLauncher(string path, string[] extensions, HashSet<string> seen, List<RevAgentPinnedLauncherFileLease> files, PinnedObject alreadyPinned = null)
        {
            string extension = Path.GetExtension(path).ToLowerInvariant();
            if (!extensions.Contains(extension, StringComparer.OrdinalIgnoreCase) || !seen.Add(path)) { if (alreadyPinned != null) alreadyPinned.Dispose(); return; }
            RevAgentPinnedLauncherFileLease file = alreadyPinned == null
                ? new RevAgentPinnedLauncherFileLease(this, path, rootIdentity.Volume)
                : new RevAgentPinnedLauncherFileLease(this, path, rootIdentity.Volume, alreadyPinned);
            string key = IdentityKey(file.PinnedIdentity);
            string prior;
            if (retainedIds.TryGetValue(key, out prior) && !String.Equals(prior, path, StringComparison.OrdinalIgnoreCase)) { file.Dispose(); throw new InvalidOperationException("fixture_duplicate_fileid_refused"); }
            if (prior == null) retainedIds.Add(key, path);
            files.Add(file);
        }
        private string ReportsRelative(string relative)
        {
            if (String.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative) || relative.IndexOf(':') >= 0) throw new InvalidOperationException("fixture_report_relative_path_refused");
            string full = Path.GetFullPath(Path.Combine(reportsPath, relative)); if (!NativeFixture.IsWithin(full, reportsPath)) throw new InvalidOperationException("fixture_report_outside_root"); return full;
        }
        private void EnsurePinnedParents(string fullPath)
        {
            string relative = fullPath.Substring(reportsPath.Length).TrimStart('\\'); string cursor = reportsPath; string[] parts = relative.Split('\\');
            for (int i = 0; i < parts.Length - 1; i++) {
                cursor = Path.Combine(cursor, parts[i]);
                SafeFileHandle existing = NativeFixture.TryOpenDirectory(cursor);
                if (existing != null) existing.Dispose(); else Directory.CreateDirectory(cursor);
                PinDirectory(cursor, true);
            }
        }
        internal string ReadReport(string relative)
        {
            AssertCreator(); string full = ReportsRelative(relative); PinnedObject pinned = NativeFixture.TryOpenObject(full, true);
            if (pinned == null) return null;
            if (pinned.Directory) { pinned.Dispose(); Poison(); throw new InvalidOperationException("fixture_report_identity_refused"); }
            RevAgentPinnedLauncherFileLease file = new RevAgentPinnedLauncherFileLease(this, full, rootIdentity.Volume, pinned);
            try { return file.ReadAllText(); } finally { file.Dispose(); }
        }
        internal void WriteReport(string relative, string json)
        {
            AssertCreator(); VerifyAll(); string full = ReportsRelative(relative); EnsurePinnedParents(full); SafeFileHandle h = NativeFixture.OpenWritableFile(full); FileIdentity id = NativeFixture.Identity(h);
            try {
                if (id.Volume != rootIdentity.Volume || id.Links != 1) throw new InvalidOperationException("fixture_report_identity_refused");
                NativeFixture.VerifyPathIdentity(full, h, id); byte[] bytes = new UTF8Encoding(true).GetBytes(json + Environment.NewLine);
                using (FileStream stream = new FileStream(NativeFixture.DuplicateForStream(h), FileAccess.ReadWrite, 65536, false)) { stream.Position = 0; stream.SetLength(0); stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                NativeFixture.VerifyPathIdentity(full, h, id);
                using (FileStream verify = new FileStream(NativeFixture.DuplicateForStream(h), FileAccess.Read, 65536, false)) { verify.Position = 0; byte[] read = new byte[bytes.Length]; int at = 0; while (at < read.Length) { int n = verify.Read(read, at, read.Length - at); if (n == 0) break; at += n; } if (!bytes.SequenceEqual(read)) throw new IOException("fixture_report_readback_mismatch"); }
                NativeFixture.VerifyPathIdentity(full, h, id);
            } catch { Poison(); throw; } finally { h.Dispose(); }
        }
        internal string WriteGuiLog(string[] lines)
        {
            AssertCreator(); VerifyAll(); string name = String.IsNullOrEmpty(collisionLogName) ? "gui-startup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + "-" + Guid.NewGuid().ToString("N") + ".log" : collisionLogName; string full = Path.Combine(guiLogPath, name);
            SafeFileHandle h = NativeFixture.CreateNewExclusiveFile(full); FileIdentity id = NativeFixture.Identity(h);
            try {
                byte[] bytes = new UTF8Encoding(false).GetBytes(String.Join(Environment.NewLine, lines) + Environment.NewLine);
                using (FileStream stream = new FileStream(NativeFixture.DuplicateForStream(h), FileAccess.ReadWrite, 65536, false)) { stream.Position = 0; stream.Write(bytes, 0, bytes.Length); stream.Flush(true); if (stream.Length != bytes.Length) throw new IOException("fixture_gui_log_length_mismatch"); }
                NativeFixture.VerifyPathIdentity(full, h, id);
                using (FileStream verify = new FileStream(NativeFixture.DuplicateForStream(h), FileAccess.Read, 65536, false)) { verify.Position = 0; byte[] read = new byte[bytes.Length]; int at = 0; while (at < read.Length) { int n = verify.Read(read, at, read.Length - at); if (n == 0) break; at += n; } if (!bytes.SequenceEqual(read)) throw new IOException("fixture_gui_log_readback_mismatch"); }
                NativeFixture.VerifyPathIdentity(full, h, id); return full;
            } catch { Poison(); throw; } finally { h.Dispose(); }
        }
        private void Poison() { Interlocked.Exchange(ref state, 2); DisposeHandles(); }
        internal void PoisonFromLease() { Poison(); }
        internal void DisposeFromLease() { Interlocked.Exchange(ref state, 2); DisposeHandles(); }
        public void Dispose() { Interlocked.Exchange(ref state, 2); DisposeHandles(); }
        private void DisposeHandles()
        {
            IDisposable[] leases;
            lock (leaseSync) { leases = issuedLeases.ToArray(); issuedLeases.Clear(); }
            foreach (IDisposable lease in leases) try { lease.Dispose(); } catch { }
            foreach (SafeFileHandle h in retainedDirectories) if (h != null) h.Dispose(); retainedDirectories.Clear();
            if (secondHandle != null) { secondHandle.Dispose(); secondHandle = null; } if (firstHandle != null) { firstHandle.Dispose(); firstHandle = null; }
            if (markerHandle != null) { markerHandle.Dispose(); markerHandle = null; } if (rootHandle != null) { rootHandle.Dispose(); rootHandle = null; }
        }
    }
}
'@
$typeDefinition = $typeDefinition.Replace('__REVAGENT_FIXTURE_NAMESPACE__', $script:RevAgentFixtureNamespace)
Add-Type -TypeDefinition $typeDefinition -Language CSharp -ErrorAction Stop
$authorityTypes = @([AppDomain]::CurrentDomain.GetAssemblies() | ForEach-Object {
        $_.GetType(($script:RevAgentFixtureNamespace + '.RevAgentTestFixtureAuthority'), $false, $false)
    } | Where-Object { $null -ne $_ })
$ownershipTypes = @([AppDomain]::CurrentDomain.GetAssemblies() | ForEach-Object {
        $_.GetType(($script:RevAgentFixtureNamespace + '.RevAgentTestFixtureOwnership'), $false, $false)
    } | Where-Object { $null -ne $_ })
if ($authorityTypes.Count -ne 1 -or $ownershipTypes.Count -ne 1) { throw 'fixture_authority_compile_identity_refused' }
$script:RevAgentFixtureAuthorityType = [type]$authorityTypes[0]
$ownershipType = [type]$ownershipTypes[0]
$modulePath = [IO.Path]::GetFullPath($PSCommandPath)
$moduleSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $modulePath).Hash.ToLowerInvariant()
$liveModuleInfo = $ExecutionContext.SessionState.Module
if ($null -eq $liveModuleInfo) { throw 'fixture_authority_module_identity_refused' }
$ownershipArguments = [object[]]@([type]$script:RevAgentFixtureAuthorityType, [object]$liveModuleInfo, [string]$modulePath, [string]$moduleSha256)
$script:RevAgentFixtureOwnership = $ownershipType.GetMethod('Create').Invoke($null, $ownershipArguments)

function New-RevAgentGuiLogFixtureAuthority {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FixtureRoot,
        [Parameter(Mandatory = $true)][string]$LogDirectory,
        [Parameter(Mandatory = $true)][object]$ModuleInfo,
        [Parameter(Mandatory = $true)][object]$HostProvenance,
        [Parameter(DontShow = $true)][string]$CollisionLogNameForTest = ''
    )
    if (-not [object]::ReferenceEquals($ModuleInfo, $liveModuleInfo)) { throw 'fixture_authority_module_identity_refused' }
    return $script:RevAgentFixtureAuthorityType.GetMethod('IssueGui').Invoke($null, @($ModuleInfo, $HostProvenance, $FixtureRoot, $LogDirectory, $CollisionLogNameForTest))
}

function New-RevAgentDesktopDiscoveryFixtureAuthority {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FixtureRoot,
        [Parameter(Mandatory = $true)][string]$DiscoveryRoot,
        [Parameter(Mandatory = $true)][string]$ReportsRoot,
        [Parameter(Mandatory = $true)][object]$ModuleInfo,
        [Parameter(Mandatory = $true)][object]$HostProvenance
    )
    if (-not [object]::ReferenceEquals($ModuleInfo, $liveModuleInfo)) { throw 'fixture_authority_module_identity_refused' }
    return $script:RevAgentFixtureAuthorityType.GetMethod('IssueDesktop').Invoke($null, @($ModuleInfo, $HostProvenance, $FixtureRoot, $DiscoveryRoot, $ReportsRoot))
}

Export-ModuleMember -Function New-RevAgentGuiLogFixtureAuthority, New-RevAgentDesktopDiscoveryFixtureAuthority
