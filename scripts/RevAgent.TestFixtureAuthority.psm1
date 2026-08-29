Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This module is test-only.  Production entry points never import it.  The
# native implementation intentionally lives in one assembly so consumers can
# require one exact runtime type rather than accepting shape-compatible objects.
if (-not ('RevAgent.TestFixtures.RevAgentTestFixtureAuthority' -as [type])) {
    Add-Type -TypeDefinition @'
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

namespace RevAgent.TestFixtures
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
            if (requireDirectory && !Directory.Exists(full)) throw new DirectoryNotFoundException("fixture_directory_missing");
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

        internal static SafeFileHandle OpenDirectory(string path)
        {
            SafeFileHandle h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            if (h.IsInvalid) throw new IOException("fixture_directory_open_failed", Marshal.GetLastWin32Error());
            try { ValidateNoReparse(h, true); return h; } catch { h.Dispose(); throw; }
        }

        internal static SafeFileHandle OpenReadFile(string path)
        {
            SafeFileHandle h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            if (h.IsInvalid) throw new IOException("fixture_file_open_failed", Marshal.GetLastWin32Error());
            try { ValidateNoReparse(h, false); FileIdentity id = Identity(h); if (id.Links != 1) throw new InvalidOperationException("fixture_hardlink_refused"); return h; }
            catch { h.Dispose(); throw; }
        }

        internal static SafeFileHandle OpenWritableFile(string path)
        {
            SafeFileHandle h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            if (h.IsInvalid) {
                h.Dispose();
                h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, IntPtr.Zero, CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            }
            if (h.IsInvalid) throw new IOException("fixture_file_create_failed", Marshal.GetLastWin32Error());
            try { ValidateNoReparse(h, false); FileIdentity id = Identity(h); if (id.Links != 1) throw new InvalidOperationException("fixture_hardlink_refused"); return h; }
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

        internal static void ValidateOwnerAcl(string root)
        {
            WindowsIdentity identity = WindowsIdentity.GetCurrent();
            SecurityIdentifier me = identity.User;
            DirectorySecurity acl = new DirectoryInfo(root).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
            SecurityIdentifier owner = (SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));
            if (!owner.Equals(me)) throw new InvalidOperationException("fixture_owner_untrusted");
            SecurityIdentifier[] broad = new SecurityIdentifier[] {
                new SecurityIdentifier(WellKnownSidType.WorldSid, null),
                new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
                new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
                new SecurityIdentifier(WellKnownSidType.BuiltinGuestsSid, null)
            };
            FileSystemRights write = FileSystemRights.Write | FileSystemRights.Modify | FileSystemRights.FullControl | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles;
            foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
                SecurityIdentifier sid = (SecurityIdentifier)rule.IdentityReference;
                if (rule.AccessControlType == AccessControlType.Allow && broad.Any(delegate(SecurityIdentifier b) { return b.Equals(sid); }) && (rule.FileSystemRights & write) != 0)
                    throw new InvalidOperationException("fixture_acl_untrusted");
            }
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
        private SafeFileHandle handle; private readonly FileIdentity identity; private readonly string path; private int disposed;
        internal RevAgentPinnedLauncherFileLease(string candidate, ulong rootVolume)
        {
            path = NativeFixture.CanonicalInput(candidate, false);
            handle = NativeFixture.OpenReadFile(path); identity = NativeFixture.Identity(handle);
            if (identity.Volume != rootVolume) { Dispose(); throw new InvalidOperationException("fixture_volume_mismatch"); }
            NativeFixture.VerifyPathIdentity(path, handle, identity);
        }
        public string FullName { get { Ensure(); return path; } }
        public string Name { get { Ensure(); return Path.GetFileName(path); } }
        public string Extension { get { Ensure(); return Path.GetExtension(path); } }
        public byte[] ReadAllBytes() { return ReadBytesPreservingHandle(); }
        public string ReadAllText() { return Encoding.UTF8.GetString(ReadBytesPreservingHandle()); }
        private byte[] ReadBytesPreservingHandle()
        {
            Ensure(); NativeFixture.VerifyPathIdentity(path, handle, identity);
            byte[] bytes;
            using (FileStream stream = new FileStream(NativeFixture.DuplicateForStream(handle), FileAccess.Read, 65536, false)) {
                stream.Position = 0;
                bytes = new byte[stream.Length]; int at = 0; while (at < bytes.Length) { int n = stream.Read(bytes, at, bytes.Length - at); if (n == 0) break; at += n; }
            }
            NativeFixture.VerifyPathIdentity(path, handle, identity); return bytes;
        }
        public void VerifyIdentity() { Ensure(); NativeFixture.VerifyPathIdentity(path, handle, identity); }
        private void Ensure() { if (disposed != 0 || handle == null || handle.IsInvalid || handle.IsClosed) throw new ObjectDisposedException("launcher_file_lease"); }
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0 && handle != null) { handle.Dispose(); handle = null; } }
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
        public RevAgentPinnedLauncherFileLease[] OpenLauncherFiles(string[] paths, bool recursive, string[] extensions) { Ensure(); return owner.OpenLauncherFiles(paths, recursive, extensions); }
        public string ReadReport(string relativePath) { Ensure(); return owner.ReadReport(relativePath); }
        public void WriteReport(string relativePath, string json) { Ensure(); owner.WriteReport(relativePath, json); }
        private void Ensure() { if (disposed != 0 || owner == null) throw new ObjectDisposedException("desktop_fixture_lease"); owner.AssertCreator(); }
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0 && owner != null) { RevAgentTestFixtureAuthority a = owner; owner = null; a.DisposeFromLease(); } }
    }

    public sealed class RevAgentTestFixtureAuthority : IDisposable
    {
        private static readonly ConditionalWeakTable<RevAgentTestFixtureAuthority, object> Issued = new ConditionalWeakTable<RevAgentTestFixtureAuthority, object>();
        private readonly FixturePurpose purpose; private readonly int creatorPid; private readonly string rootPath;
        private readonly string guiLogPath; private readonly string discoveryPath; private readonly string reportsPath;
        private SafeFileHandle rootHandle, markerHandle, firstHandle, secondHandle; private readonly FileIdentity rootIdentity, markerIdentity, firstIdentity, secondIdentity;
        private readonly List<SafeFileHandle> retainedDirectories = new List<SafeFileHandle>(); private readonly Dictionary<string, string> retainedIds = new Dictionary<string, string>(StringComparer.Ordinal);
        private int state; // 0 issued, 1 consumed, 2 disposed/poisoned

        private RevAgentTestFixtureAuthority(FixturePurpose p, string root, string first, string second)
        {
            purpose = p; creatorPid = NativeFixture.CurrentPid(); rootPath = NativeFixture.RequireTempChild(root);
            try {
            NativeFixture.ValidateOwnerAcl(rootPath);
            rootHandle = NativeFixture.OpenDirectory(rootPath); rootIdentity = NativeFixture.Identity(rootHandle); NativeFixture.VerifyPathIdentity(rootPath, rootHandle, rootIdentity);
            string markerPath = Path.Combine(rootPath, ".revagent-test-fixture-owner");
            markerHandle = NativeFixture.OpenWritableFile(markerPath); markerIdentity = NativeFixture.Identity(markerHandle);
            using (FileStream marker = new FileStream(NativeFixture.DuplicateForStream(markerHandle), FileAccess.ReadWrite, 1, false)) { if (marker.Length != 0) throw new InvalidOperationException("fixture_marker_not_empty"); }
            NativeFixture.VerifyPathIdentity(markerPath, markerHandle, markerIdentity);
            if (p == FixturePurpose.GuiStartupFailureLog) {
                guiLogPath = RequireDescendantDirectory(first); firstHandle = NativeFixture.OpenDirectory(guiLogPath); firstIdentity = ValidateChild(guiLogPath, firstHandle);
            } else {
                discoveryPath = RequireDescendantDirectory(first); reportsPath = RequireDescendantDirectory(second);
                firstHandle = NativeFixture.OpenDirectory(discoveryPath); firstIdentity = ValidateChild(discoveryPath, firstHandle);
                secondHandle = NativeFixture.OpenDirectory(reportsPath); secondIdentity = ValidateChild(reportsPath, secondHandle);
            }
            Issued.Add(this, new object()); state = 0;
            }
            catch { DisposeHandles(); throw; }
        }

        public static RevAgentTestFixtureAuthority IssueGui(string root, string logDirectory) { return new RevAgentTestFixtureAuthority(FixturePurpose.GuiStartupFailureLog, root, logDirectory, null); }
        public static RevAgentTestFixtureAuthority IssueDesktop(string root, string discoveryRoot, string reportsRoot) { return new RevAgentTestFixtureAuthority(FixturePurpose.DesktopLauncherDiscovery, root, discoveryRoot, reportsRoot); }
        private string RequireDescendantDirectory(string path) { string full = NativeFixture.CanonicalInput(path, true); if (!NativeFixture.IsWithin(full, rootPath)) throw new InvalidOperationException("fixture_target_outside_root"); return full; }
        private FileIdentity ValidateChild(string path, SafeFileHandle handle) { FileIdentity id = NativeFixture.Identity(handle); if (id.Volume != rootIdentity.Volume) throw new InvalidOperationException("fixture_volume_mismatch"); NativeFixture.VerifyPathIdentity(path, handle, id); return id; }
        internal void AssertCreator() { if (NativeFixture.CurrentPid() != creatorPid || Volatile.Read(ref state) != 1) { Poison(); throw new InvalidOperationException("fixture_authority_process_or_state_refused"); } }
        private void Consume(FixturePurpose expected)
        {
            object marker; if (!Issued.TryGetValue(this, out marker) || Interlocked.CompareExchange(ref state, 1, 0) != 0) { Poison(); throw new InvalidOperationException("fixture_authority_reuse_refused"); }
            if (NativeFixture.CurrentPid() != creatorPid || purpose != expected) { Poison(); throw new InvalidOperationException("fixture_authority_purpose_or_process_refused"); }
            try { VerifyAll(); } catch { Poison(); throw; }
        }
        public RevAgentGuiStartupFailureLogLease ConsumeGuiStartupFailureLog() { Consume(FixturePurpose.GuiStartupFailureLog); return new RevAgentGuiStartupFailureLogLease(this); }
        public RevAgentDesktopLauncherDiscoveryLease ConsumeDesktopLauncherDiscovery() { Consume(FixturePurpose.DesktopLauncherDiscovery); return new RevAgentDesktopLauncherDiscoveryLease(this); }
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
            if (!Directory.Exists(full)) { if (required) throw new DirectoryNotFoundException("fixture_descendant_missing"); return null; }
            SafeFileHandle h = NativeFixture.OpenDirectory(full); FileIdentity id = ValidateChild(full, h); string key = IdentityKey(id);
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
            string current = Path.Combine(discoveryPath, "current-profile"); PinDirectory(current, false);
            AddIfDirectory(result, Path.Combine(current, "Desktop"));
            if (Directory.Exists(current)) foreach (string one in Directory.EnumerateDirectories(current, "OneDrive*", SearchOption.TopDirectoryOnly)) { PinDirectory(one, true); AddIfDirectory(result, Path.Combine(one, "Desktop")); }
            string profiles = Path.Combine(discoveryPath, "profiles"); PinDirectory(profiles, false);
            if (Directory.Exists(profiles)) foreach (string profile in Directory.EnumerateDirectories(profiles, "*", SearchOption.TopDirectoryOnly)) {
                PinDirectory(profile, true); AddIfDirectory(result, Path.Combine(profile, "Desktop"));
                foreach (string one in Directory.EnumerateDirectories(profile, "OneDrive*", SearchOption.TopDirectoryOnly)) { PinDirectory(one, true); AddIfDirectory(result, Path.Combine(one, "Desktop")); }
            }
            VerifyAll(); return result.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }
        internal RevAgentPinnedLauncherFileLease[] OpenLauncherFiles(string[] paths, bool recursive, string[] extensions)
        {
            AssertCreator(); VerifyAll(); List<RevAgentPinnedLauncherFileLease> files = new List<RevAgentPinnedLauncherFileLease>(); HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try {
                foreach (string candidate in paths ?? new string[0]) {
                    string full = NativeFixture.CanonicalInput(candidate, false);
                    if (!NativeFixture.IsWithin(full, discoveryPath) && !String.Equals(full, discoveryPath, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("fixture_launcher_path_outside_discovery");
                    if (File.Exists(full)) { AddLauncher(full, extensions, seen, files); continue; }
                    if (!Directory.Exists(full)) continue;
                    PinDirectory(full, true);
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
                VerifyAll(); return files.OrderBy(delegate(RevAgentPinnedLauncherFileLease f) { return f.FullName; }, StringComparer.OrdinalIgnoreCase).ToArray();
            } catch { foreach (IDisposable f in files) f.Dispose(); Poison(); throw; }
        }
        private void AddLauncher(string path, string[] extensions, HashSet<string> seen, List<RevAgentPinnedLauncherFileLease> files)
        {
            string extension = Path.GetExtension(path).ToLowerInvariant(); if (!extensions.Contains(extension, StringComparer.OrdinalIgnoreCase) || !seen.Add(path)) return;
            RevAgentPinnedLauncherFileLease file = new RevAgentPinnedLauncherFileLease(path, rootIdentity.Volume); string key;
            using (SafeFileHandle duplicate = NativeFixture.OpenReadFile(path)) { key = IdentityKey(NativeFixture.Identity(duplicate)); }
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
            for (int i = 0; i < parts.Length - 1; i++) { cursor = Path.Combine(cursor, parts[i]); if (!Directory.Exists(cursor)) Directory.CreateDirectory(cursor); PinDirectory(cursor, true); }
        }
        internal string ReadReport(string relative)
        {
            AssertCreator(); string full = ReportsRelative(relative); RevAgentPinnedLauncherFileLease file = new RevAgentPinnedLauncherFileLease(full, rootIdentity.Volume);
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
            AssertCreator(); VerifyAll(); string name = "gui-startup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + "-" + Guid.NewGuid().ToString("N") + ".log"; string full = Path.Combine(guiLogPath, name);
            SafeFileHandle h = NativeFixture.OpenWritableFile(full); FileIdentity id = NativeFixture.Identity(h);
            try {
                byte[] bytes = new UTF8Encoding(false).GetBytes(String.Join(Environment.NewLine, lines) + Environment.NewLine);
                using (FileStream stream = new FileStream(NativeFixture.DuplicateForStream(h), FileAccess.ReadWrite, 65536, false)) { stream.Position = 0; stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                NativeFixture.VerifyPathIdentity(full, h, id); return full;
            } catch { Poison(); throw; } finally { h.Dispose(); }
        }
        private void Poison() { Interlocked.Exchange(ref state, 2); DisposeHandles(); }
        internal void DisposeFromLease() { Interlocked.Exchange(ref state, 2); DisposeHandles(); }
        public void Dispose() { Interlocked.Exchange(ref state, 2); DisposeHandles(); }
        private void DisposeHandles()
        {
            foreach (SafeFileHandle h in retainedDirectories) if (h != null) h.Dispose(); retainedDirectories.Clear();
            if (secondHandle != null) { secondHandle.Dispose(); secondHandle = null; } if (firstHandle != null) { firstHandle.Dispose(); firstHandle = null; }
            if (markerHandle != null) { markerHandle.Dispose(); markerHandle = null; } if (rootHandle != null) { rootHandle.Dispose(); rootHandle = null; }
        }
    }
}
'@ -Language CSharp -ErrorAction Stop
}

function New-RevAgentGuiLogFixtureAuthority {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FixtureRoot,
        [Parameter(Mandatory = $true)][string]$LogDirectory
    )
    return [RevAgent.TestFixtures.RevAgentTestFixtureAuthority]::IssueGui($FixtureRoot, $LogDirectory)
}

function New-RevAgentDesktopDiscoveryFixtureAuthority {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FixtureRoot,
        [Parameter(Mandatory = $true)][string]$DiscoveryRoot,
        [Parameter(Mandatory = $true)][string]$ReportsRoot
    )
    return [RevAgent.TestFixtures.RevAgentTestFixtureAuthority]::IssueDesktop($FixtureRoot, $DiscoveryRoot, $ReportsRoot)
}

Export-ModuleMember -Function New-RevAgentGuiLogFixtureAuthority, New-RevAgentDesktopDiscoveryFixtureAuthority
