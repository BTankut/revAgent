Set-StrictMode -Version Latest

if (-not ("RevAgent.PermissionNativeFileInfo" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public static class PermissionNativeFileInfo {
        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle hFile,
            out BY_HANDLE_FILE_INFORMATION fileInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool RemoveDirectoryW(string pathName);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("ntdll.dll")]
        private static extern int NtQuerySystemInformation(
            int systemInformationClass,
            IntPtr systemInformation,
            int systemInformationLength,
            out int returnLength);

        [DllImport("ntdll.dll")]
        private static extern int NtQueryInformationFile(
            SafeFileHandle fileHandle,
            out IO_STATUS_BLOCK ioStatusBlock,
            IntPtr fileInformation,
            uint bufferSize,
            int fileInformationClass);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DuplicateHandle(
            IntPtr sourceProcessHandle,
            IntPtr sourceHandle,
            IntPtr targetProcessHandle,
            out SafeFileHandle targetHandle,
            uint desiredAccess,
            bool inheritHandle,
            uint options);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetFileType(SafeFileHandle handle);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetSecurityDescriptorOwner(
            IntPtr securityDescriptor,
            out IntPtr owner,
            out bool ownerDefaulted);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetSecurityDescriptorDacl(
            IntPtr securityDescriptor,
            out bool daclPresent,
            out IntPtr dacl,
            out bool daclDefaulted);

        [DllImport("advapi32.dll")]
        private static extern uint SetSecurityInfo(
            SafeFileHandle handle,
            int objectType,
            uint securityInformation,
            IntPtr owner,
            IntPtr group,
            IntPtr dacl,
            IntPtr sacl);

        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint FileShareDelete = 0x00000004;
        private const uint FileListDirectory = 0x00000001;
        private const uint ReadControl = 0x00020000;
        private const uint WriteDac = 0x00040000;
        private const uint WriteOwner = 0x00080000;
        private const uint OpenExisting = 3;
        private const uint FileFlagOpenReparsePoint = 0x00200000;
        private const uint FileFlagBackupSemantics = 0x02000000;
        private const int SeFileObject = 1;
        private const uint OwnerSecurityInformation = 0x00000001;
        private const uint DaclSecurityInformation = 0x00000004;
        private const uint ProtectedDaclSecurityInformation = 0x80000000;
        private const int SystemExtendedHandleInformation = 64;
        private const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
        private const int FileProcessIdsUsingFileInformation = 47;
        private const uint DuplicateSameAccess = 0x00000002;
        private const uint FileTypeDisk = 0x00000001;
        private const uint MutationAccessMask = 0x00000002 | 0x00000004 | 0x00000010 | 0x00000040 | 0x00000100 |
            0x00010000 | 0x00040000 | 0x00080000 | 0x10000000 | 0x40000000;

        [StructLayout(LayoutKind.Sequential)]
        private struct SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX {
            public IntPtr Object;
            public IntPtr UniqueProcessId;
            public IntPtr HandleValue;
            public uint GrantedAccess;
            public ushort CreatorBackTraceIndex;
            public ushort ObjectTypeIndex;
            public uint HandleAttributes;
            public uint Reserved;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_STATUS_BLOCK {
            public IntPtr Status;
            public UIntPtr Information;
        }

        private static string ToExtendedPath(string path) {
            if (String.IsNullOrWhiteSpace(path)) {
                throw new ArgumentException("Filesystem path is empty.", "path");
            }
            if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) {
                return path;
            }
            string fullPath = System.IO.Path.GetFullPath(path);
            if (fullPath.StartsWith(@"\\", StringComparison.Ordinal)) {
                return @"\\?\UNC\" + fullPath.Substring(2);
            }
            return @"\\?\" + fullPath;
        }

        private static System.Collections.Generic.HashSet<long> GetProcessIdsUsingFile(SafeFileHandle handle) {
            int bufferLength = 4096;
            IntPtr buffer = IntPtr.Zero;
            try {
                while (true) {
                    buffer = Marshal.AllocHGlobal(bufferLength);
                    IO_STATUS_BLOCK ioStatus;
                    int status = NtQueryInformationFile(
                        handle,
                        out ioStatus,
                        buffer,
                        (uint)bufferLength,
                        FileProcessIdsUsingFileInformation);
                    if (status == 0) {
                        break;
                    }
                    Marshal.FreeHGlobal(buffer);
                    buffer = IntPtr.Zero;
                    if (status != StatusInfoLengthMismatch &&
                        status != unchecked((int)0x80000005) &&
                        status != unchecked((int)0xC0000023)) {
                        throw new InvalidOperationException(
                            "Could not inventory processes retaining the protected filesystem identity. NTSTATUS=0x" +
                            status.ToString("X8"));
                    }
                    bufferLength *= 2;
                    if (bufferLength > 16 * 1024 * 1024) {
                        throw new InvalidOperationException("Filesystem process-id inventory exceeded the safety limit.");
                    }
                }

                uint count = unchecked((uint)Marshal.ReadInt32(buffer));
                int processListOffset = IntPtr.Size;
                long requiredLength = processListOffset + ((long)count * IntPtr.Size);
                if (requiredLength > bufferLength) {
                    throw new InvalidOperationException("Filesystem process-id inventory returned an invalid process count.");
                }
                System.Collections.Generic.HashSet<long> processIds =
                    new System.Collections.Generic.HashSet<long>();
                for (uint index = 0; index < count; index++) {
                    IntPtr processId = Marshal.ReadIntPtr(buffer, processListOffset + ((int)index * IntPtr.Size));
                    processIds.Add(processId.ToInt64());
                }
                return processIds;
            }
            finally {
                if (buffer != IntPtr.Zero) {
                    Marshal.FreeHGlobal(buffer);
                }
            }
        }

        public static SafeFileHandle OpenNoDelete(string path, bool directory) {
            uint flags = FileFlagOpenReparsePoint;
            if (directory) {
                flags |= FileFlagBackupSemantics;
            }
            SafeFileHandle handle = CreateFileW(
                ToExtendedPath(path),
                ReadControl | WriteDac | WriteOwner,
                FileShareRead | FileShareWrite,
                IntPtr.Zero,
                OpenExisting,
                flags,
                IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new System.ComponentModel.Win32Exception(error, "Could not lock the filesystem item against delete/rename: " + path);
            }
            return handle;
        }

        public static SafeFileHandle OpenNoMutation(string path, bool directory) {
            uint flags = FileFlagOpenReparsePoint;
            if (directory) {
                flags |= FileFlagBackupSemantics;
            }
            // FILE_LIST_DIRECTORY makes root-directory data access participate
            // in Windows share accounting. DELETE sharing stays denied to pin
            // the root identity, while WRITE sharing remains enabled because
            // the trusted installer must replace children under this handle.
            // Share modes do not cover every metadata right or retained child
            // handle, so callers also run AssertNoMutationHandles over the exact
            // protected identity set before mutation.
            SafeFileHandle handle = CreateFileW(
                ToExtendedPath(path),
                ReadControl | FileListDirectory,
                FileShareRead | FileShareWrite,
                IntPtr.Zero,
                OpenExisting,
                flags,
                IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new System.ComponentModel.Win32Exception(error, "Could not lock the managed filesystem item against retained write/delete handles: " + path);
            }
            return handle;
        }

        public static SafeFileHandle OpenAclMutationBarrier(string path, bool directory) {
            uint flags = FileFlagOpenReparsePoint;
            if (directory) {
                flags |= FileFlagBackupSemantics;
            }
            // This is the short-lived pre-ACL barrier. Denying both WRITE and
            // DELETE sharing rejects an already-open data mutation handle and
            // prevents a new one while the protected owner/DACL is applied.
            // Metadata-only rights such as WRITE_DAC are covered by the exact
            // system-handle inventory before this handle is used to mutate ACLs.
            SafeFileHandle handle = CreateFileW(
                ToExtendedPath(path),
                ReadControl | WriteDac | WriteOwner | FileListDirectory,
                FileShareRead,
                IntPtr.Zero,
                OpenExisting,
                flags,
                IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new System.ComponentModel.Win32Exception(error, "Could not acquire the canonical Revit add-in ACL mutation barrier: " + path);
            }
            return handle;
        }

        public static string GetIdentity(SafeFileHandle handle) {
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            return info.VolumeSerialNumber.ToString("X8") + ":" + info.FileIndexHigh.ToString("X8") + info.FileIndexLow.ToString("X8");
        }

        public static string GetIdentity(string path, bool directory) {
            uint flags = FileFlagOpenReparsePoint;
            if (directory) {
                flags |= FileFlagBackupSemantics;
            }
            using (SafeFileHandle handle = CreateFileW(
                ToExtendedPath(path),
                ReadControl,
                FileShareRead | FileShareWrite | FileShareDelete,
                IntPtr.Zero,
                OpenExisting,
                flags,
                IntPtr.Zero)) {
                if (handle.IsInvalid) {
                    int error = Marshal.GetLastWin32Error();
                    throw new System.ComponentModel.Win32Exception(error, "Could not read managed filesystem identity (Win32 error " + error + "): " + path);
                }
                return GetIdentity(handle);
            }
        }

        public static void AssertNoMutationHandles(SafeFileHandle protectedDirectoryHandle) {
            AssertNoMutationHandles(
                protectedDirectoryHandle,
                new string[] { GetIdentity(protectedDirectoryHandle) },
                new SafeFileHandle[] { protectedDirectoryHandle });
        }

        public static void AssertNoMutationHandles(SafeFileHandle protectedDirectoryHandle, string[] protectedIdentities) {
            if (protectedDirectoryHandle == null || protectedDirectoryHandle.IsClosed || protectedDirectoryHandle.IsInvalid) {
                throw new ArgumentException("Protected directory handle is closed or invalid.", "protectedDirectoryHandle");
            }
            string rootIdentity = GetIdentity(protectedDirectoryHandle);
            if (protectedIdentities == null || protectedIdentities.Length == 0) {
                throw new ArgumentException("Protected filesystem identity set is empty.", "protectedIdentities");
            }
            foreach (string identity in protectedIdentities) {
                if (!String.Equals(identity, rootIdentity, StringComparison.Ordinal)) {
                    throw new InvalidOperationException(
                        "Every protected filesystem identity must be represented by a retained SafeFileHandle. " +
                        "Use the AssertNoMutationHandles overload that accepts protected handles.");
                }
            }
            AssertNoMutationHandles(
                protectedDirectoryHandle,
                new string[] { rootIdentity },
                new SafeFileHandle[] { protectedDirectoryHandle });
        }

        public static void AssertNoMutationHandles(
            SafeFileHandle protectedDirectoryHandle,
            string[] protectedIdentities,
            SafeFileHandle[] protectedHandles) {
            if (protectedDirectoryHandle == null || protectedDirectoryHandle.IsClosed || protectedDirectoryHandle.IsInvalid) {
                throw new ArgumentException("Protected directory handle is closed or invalid.", "protectedDirectoryHandle");
            }
            if (protectedIdentities == null || protectedIdentities.Length == 0) {
                throw new ArgumentException("Protected filesystem identity set is empty.", "protectedIdentities");
            }
            if (protectedHandles == null || protectedHandles.Length == 0) {
                throw new ArgumentException("Protected filesystem handle set is empty.", "protectedHandles");
            }
            System.Collections.Generic.HashSet<string> protectedIdentitySet =
                new System.Collections.Generic.HashSet<string>(protectedIdentities, StringComparer.Ordinal);
            protectedIdentitySet.Add(GetIdentity(protectedDirectoryHandle));

            System.Collections.Generic.Dictionary<long, string> protectedHandleIdentityByValue =
                new System.Collections.Generic.Dictionary<long, string>();
            System.Collections.Generic.HashSet<string> pinnedIdentitySet =
                new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);
            foreach (SafeFileHandle protectedHandle in protectedHandles) {
                if (protectedHandle == null || protectedHandle.IsClosed || protectedHandle.IsInvalid) {
                    throw new ArgumentException("A protected filesystem handle is closed or invalid.", "protectedHandles");
                }
                long handleValue = protectedHandle.DangerousGetHandle().ToInt64();
                string identity = GetIdentity(protectedHandle);
                string existingIdentity;
                if (protectedHandleIdentityByValue.TryGetValue(handleValue, out existingIdentity) &&
                    !String.Equals(existingIdentity, identity, StringComparison.Ordinal)) {
                    throw new InvalidOperationException("A protected filesystem handle value changed identity during attestation.");
                }
                protectedHandleIdentityByValue[handleValue] = identity;
                pinnedIdentitySet.Add(identity);
            }
            if (!pinnedIdentitySet.SetEquals(protectedIdentitySet)) {
                throw new InvalidOperationException(
                    "Every protected filesystem identity must remain pinned by an exact SafeFileHandle during handle attestation.");
            }

            long currentProcessId = System.Diagnostics.Process.GetCurrentProcess().Id;
            foreach (SafeFileHandle protectedHandle in protectedHandles) {
                foreach (long processId in GetProcessIdsUsingFile(protectedHandle)) {
                    if (processId != currentProcessId) {
                        // FileProcessIdsUsingFileInformation is evaluated by the
                        // filesystem for the exact retained handle. It does not
                        // require PROCESS_DUP_HANDLE access to the other process,
                        // so a same-user process cannot hide a pre-UAC handle by
                        // denying process-handle duplication. Read-only foreign
                        // holders are rejected conservatively because their exact
                        // granted access cannot be proven without weakening this gate.
                        throw new InvalidOperationException(
                            "Another process already retains a handle to the managed mutation identity set. " +
                            DescribeProcess(processId) +
                            ". Close File Explorer windows or tools viewing revAgent install/updater folders, then retry.");
                    }
                }
            }

            IntPtr buffer = IntPtr.Zero;
            int bufferLength = 1024 * 1024;
            try {
                while (true) {
                    buffer = Marshal.AllocHGlobal(bufferLength);
                    int requiredLength;
                    int status = NtQuerySystemInformation(SystemExtendedHandleInformation, buffer, bufferLength, out requiredLength);
                    if (status == 0) {
                        break;
                    }
                    Marshal.FreeHGlobal(buffer);
                    buffer = IntPtr.Zero;
                    if (status != StatusInfoLengthMismatch) {
                        throw new InvalidOperationException("System handle inventory failed with NTSTATUS 0x" + status.ToString("X8") + ".");
                    }
                    bufferLength = Math.Max(bufferLength * 2, requiredLength + (64 * 1024));
                    if (bufferLength > 256 * 1024 * 1024) {
                        throw new InvalidOperationException("System handle inventory exceeded the safety limit.");
                    }
                }

                long handleCount = Marshal.ReadIntPtr(buffer).ToInt64();
                if (handleCount < 0 || handleCount > 16000000) {
                    throw new InvalidOperationException("System handle inventory returned an invalid handle count.");
                }
                int entrySize = Marshal.SizeOf(typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
                long entryOffset = IntPtr.Size * 2L;
                ushort protectedFileObjectType = 0;
                System.Collections.Generic.HashSet<long> protectedHandleValuesFound =
                    new System.Collections.Generic.HashSet<long>();
                for (long index = 0; index < handleCount; index++) {
                    IntPtr entryAddress = new IntPtr(buffer.ToInt64() + entryOffset + (index * entrySize));
                    SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX entry = (SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX)Marshal.PtrToStructure(entryAddress, typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
                    if (entry.UniqueProcessId.ToInt64() == currentProcessId &&
                        protectedHandleIdentityByValue.ContainsKey(entry.HandleValue.ToInt64())) {
                        if (protectedFileObjectType == 0) {
                            protectedFileObjectType = entry.ObjectTypeIndex;
                        }
                        else if (protectedFileObjectType != entry.ObjectTypeIndex) {
                            throw new InvalidOperationException("Protected handles did not resolve to one filesystem object type.");
                        }
                        protectedHandleValuesFound.Add(entry.HandleValue.ToInt64());
                    }
                }
                if (protectedFileObjectType == 0 || protectedHandleValuesFound.Count != protectedHandleIdentityByValue.Count) {
                    throw new InvalidOperationException("One or more retained protected handles were not found in the system handle inventory.");
                }

                IntPtr currentProcessHandle = GetCurrentProcess();
                for (long index = 0; index < handleCount; index++) {
                    IntPtr entryAddress = new IntPtr(buffer.ToInt64() + entryOffset + (index * entrySize));
                    SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX entry = (SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX)Marshal.PtrToStructure(entryAddress, typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
                    long processId = entry.UniqueProcessId.ToInt64();
                    long handleValue = entry.HandleValue.ToInt64();
                    if (processId != currentProcessId ||
                        entry.ObjectTypeIndex != protectedFileObjectType ||
                        (entry.GrantedAccess & MutationAccessMask) == 0 ||
                        protectedHandleIdentityByValue.ContainsKey(handleValue)) {
                        continue;
                    }

                    SafeFileHandle duplicate = null;
                    try {
                        if (!DuplicateHandle(
                            currentProcessHandle,
                            entry.HandleValue,
                            currentProcessHandle,
                            out duplicate,
                            0,
                            false,
                            DuplicateSameAccess) || duplicate == null || duplicate.IsInvalid) {
                            // A current-process handle that vanished between the
                            // snapshot and duplication no longer represents a
                            // retained mutation capability. No foreign process is
                            // skipped here; those were rejected above without
                            // opening their process handles.
                            if (duplicate != null) { duplicate.Dispose(); duplicate = null; }
                            continue;
                        }
                        if (GetFileType(duplicate) != FileTypeDisk) {
                            continue;
                        }
                        string candidateIdentity;
                        try {
                            candidateIdentity = GetIdentity(duplicate);
                        }
                        catch {
                            continue;
                        }
                        if (protectedIdentitySet.Contains(candidateIdentity)) {
                            throw new InvalidOperationException(
                                "A mutation-capable filesystem handle is already open for the managed mutation identity set. " +
                                "pid=" + processId + " handle=0x" + handleValue.ToString("X") +
                                " access=0x" + entry.GrantedAccess.ToString("X8"));
                        }
                    }
                    finally {
                        if (duplicate != null) { duplicate.Dispose(); }
                    }
                }
            }
            finally {
                if (buffer != IntPtr.Zero) {
                    Marshal.FreeHGlobal(buffer);
                }
            }
        }

        private static string DescribeProcess(long processId) {
            string fallback = "pid=" + processId;
            if (processId <= 0 || processId > Int32.MaxValue) {
                return fallback;
            }

            try {
                using (System.Diagnostics.Process process = System.Diagnostics.Process.GetProcessById((int)processId)) {
                    string name = process.ProcessName;
                    string path = "";
                    try {
                        if (process.MainModule != null) {
                            path = process.MainModule.FileName;
                        }
                    }
                    catch {
                        path = "";
                    }

                    if (!String.IsNullOrWhiteSpace(name) && !String.IsNullOrWhiteSpace(path)) {
                        return fallback + " name=" + name + " path=" + path;
                    }
                    if (!String.IsNullOrWhiteSpace(name)) {
                        return fallback + " name=" + name;
                    }
                }
            }
            catch {
            }

            return fallback;
        }

        public static void ApplyOwnerAndProtectedDacl(SafeFileHandle handle, byte[] securityDescriptor) {
            if (securityDescriptor == null || securityDescriptor.Length == 0) {
                throw new ArgumentException("Security descriptor is empty.", "securityDescriptor");
            }
            GCHandle pinned = GCHandle.Alloc(securityDescriptor, GCHandleType.Pinned);
            try {
                IntPtr descriptor = pinned.AddrOfPinnedObject();
                IntPtr owner;
                bool ownerDefaulted;
                if (!GetSecurityDescriptorOwner(descriptor, out owner, out ownerDefaulted) || owner == IntPtr.Zero) {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Security descriptor owner could not be read.");
                }
                bool daclPresent;
                IntPtr dacl;
                bool daclDefaulted;
                if (!GetSecurityDescriptorDacl(descriptor, out daclPresent, out dacl, out daclDefaulted) || !daclPresent || dacl == IntPtr.Zero) {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Security descriptor DACL could not be read.");
                }
                uint result = SetSecurityInfo(
                    handle,
                    SeFileObject,
                    OwnerSecurityInformation | DaclSecurityInformation | ProtectedDaclSecurityInformation,
                    owner,
                    IntPtr.Zero,
                    dacl,
                    IntPtr.Zero);
                if (result != 0) {
                    throw new System.ComponentModel.Win32Exception((int)result, "Owner/protected DACL application failed.");
                }
            }
            finally {
                pinned.Free();
            }
        }

        public static uint GetAttributes(SafeFileHandle handle) {
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            return info.FileAttributes;
        }

        public static uint GetLinkCount(SafeFileHandle handle) {
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            return info.NumberOfLinks;
        }

        public static uint GetLinkCount(string path) {
            using (var stream = new System.IO.FileStream(
                path,
                System.IO.FileMode.Open,
                System.IO.FileAccess.Read,
                System.IO.FileShare.ReadWrite | System.IO.FileShare.Delete)) {
                BY_HANDLE_FILE_INFORMATION info;
                if (!GetFileInformationByHandle(stream.SafeFileHandle, out info)) {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                return info.NumberOfLinks;
            }
        }

        public static void RemoveDirectoryLink(string path) {
            if (!RemoveDirectoryW(ToExtendedPath(path))) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
        }
    }
}
"@
}

if (-not ("RevAgent.AccountNativeInfo" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace RevAgent {
    public sealed class AccountLookupResult {
        public string AccountName { get; set; }
        public string Name { get; set; }
        public string Domain { get; set; }
        public int SidType { get; set; }
    }

    public static class AccountNativeInfo {
        private const int ErrorInsufficientBuffer = 122;

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool LookupAccountSid(
            string systemName,
            byte[] sid,
            StringBuilder name,
            ref uint nameLength,
            StringBuilder domainName,
            ref uint domainNameLength,
            out int sidType);

        public static AccountLookupResult Lookup(string sidValue) {
            SecurityIdentifier sid = new SecurityIdentifier(sidValue);
            byte[] binarySid = new byte[sid.BinaryLength];
            sid.GetBinaryForm(binarySid, 0);

            uint nameLength = 0;
            uint domainLength = 0;
            int sidType;
            LookupAccountSid(null, binarySid, null, ref nameLength, null, ref domainLength, out sidType);
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorInsufficientBuffer) {
                throw new Win32Exception(error, "LookupAccountSid size probe failed.");
            }

            StringBuilder name = new StringBuilder((int)Math.Max(1, nameLength));
            StringBuilder domain = new StringBuilder((int)Math.Max(1, domainLength));
            if (!LookupAccountSid(null, binarySid, name, ref nameLength, domain, ref domainLength, out sidType)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "LookupAccountSid failed.");
            }

            string accountName = domain.Length == 0 ? name.ToString() : domain + "\\" + name;
            return new AccountLookupResult {
                AccountName = accountName,
                Name = name.ToString(),
                Domain = domain.ToString(),
                SidType = sidType
            };
        }
    }
}
"@
}

function Test-RevitMcpAdministrator {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function Get-RevitMcpCanonicalAddinSurfacePaths {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AddinRoot,
        [Parameter(Mandatory = $true)]
        [ValidateSet("2022", "2023", "2024", "2025")]
        [string]$RevitVersion
    )

    $commonApplicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    if ([string]::IsNullOrWhiteSpace($commonApplicationData)) {
        throw "Canonical CommonApplicationData known folder could not be resolved."
    }
    $commonApplicationData = [System.IO.Path]::GetFullPath($commonApplicationData).TrimEnd('\')
    $autodeskRoot = Join-Path $commonApplicationData "Autodesk"
    $revitRoot = Join-Path $autodeskRoot "Revit"
    $addinsParent = Join-Path $revitRoot "Addins"
    $expectedAddinRoot = Join-Path $addinsParent $RevitVersion
    $actualAddinRoot = [System.IO.Path]::GetFullPath($AddinRoot).TrimEnd('\')
    if (-not [string]::Equals($actualAddinRoot, $expectedAddinRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Revit add-in ACL protection accepts only the canonical ProgramData year root '$expectedAddinRoot'; refusing '$actualAddinRoot'."
    }

    return [pscustomobject][ordered]@{
        CommonApplicationData = $commonApplicationData
        AutodeskRoot = $autodeskRoot
        RevitRoot = $revitRoot
        AddinsParent = $addinsParent
        AddinRoot = $expectedAddinRoot
        ManifestPath = Join-Path $expectedAddinRoot "revAgent.addin"
    }
}

function Assert-RevitMcpAddinPathComponentSafe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [ValidateSet("Directory", "File")]
        [string]$Kind = "Directory",
        [switch]$AllowMissing
    )

    $item = $null
    try {
        $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    }
    catch {
        if ($AllowMissing -and
            -not [System.IO.Directory]::Exists($Path) -and
            -not [System.IO.File]::Exists($Path)) {
            return $null
        }
        throw "Canonical Revit add-in path component could not be inspected safely: $Path. $($_.Exception.Message)"
    }

    $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not [string]::IsNullOrWhiteSpace($linkType)) {
        throw "Canonical Revit add-in path contains a reparse point or filesystem link: $($item.FullName) ($linkType)"
    }
    if ($Kind -eq "Directory" -and -not $item.PSIsContainer) {
        throw "Canonical Revit add-in directory component is not a directory: $($item.FullName)"
    }
    if ($Kind -eq "File" -and $item.PSIsContainer) {
        throw "Canonical Revit add-in manifest is not a file: $($item.FullName)"
    }
    return $item
}

function Assert-RevitMcpCanonicalAddinAncestorBoundary {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Paths
    )

    $trustedOwnerSids = @(
        'S-1-5-18',
        'S-1-5-32-544',
        'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
    )
    $replacementMask = [int64]([Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership)

    foreach ($path in @($Paths.CommonApplicationData, $Paths.AutodeskRoot, $Paths.RevitRoot)) {
        [void](Assert-RevitMcpAddinPathComponentSafe -Path ([string]$path) -Kind Directory)
        $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $path -ErrorAction Stop
        $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($trustedOwnerSids -notcontains $ownerSid) {
            throw "Canonical Revit add-in ancestor has an untrusted owner. path=$path owner=$ownerSid"
        }
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) {
                continue
            }
            $sid = [string]$rule.IdentityReference.Value
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $trustedOwnerSids -notcontains $sid -and
                (([int64]$rule.FileSystemRights -band $replacementMask) -ne 0)) {
                throw "Canonical Revit add-in ancestor permits an untrusted principal to replace or retake the protected child boundary. path=$path principal=$sid rights=$($rule.FileSystemRights)"
            }
        }
    }
}

function New-RevitMcpProtectedAddinAcl {
    param(
        [ValidateSet("Directory", "File")]
        [string]$Kind
    )

    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $usersSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    if ($Kind -eq 'Directory') {
        $security = [System.Security.AccessControl.DirectorySecurity]::new()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        $propagation = [System.Security.AccessControl.PropagationFlags]::None
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner($administratorsSid)
        $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow))
        $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($administratorsSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow))
        $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($usersSid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance, $propagation, $allow))
        return $security
    }

    $security = [System.Security.AccessControl.FileSecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($administratorsSid)
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $allow))
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($administratorsSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $allow))
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($usersSid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $allow))
    return $security
}

function Assert-RevitMcpProtectedAddinAcl {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Acl,
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [ValidateSet("Directory", "File")]
        [string]$Kind
    )

    $administratorsSid = 'S-1-5-32-544'
    $expectedRights = @{
        'S-1-5-18' = [int64][Security.AccessControl.FileSystemRights]::FullControl
        'S-1-5-32-544' = [int64][Security.AccessControl.FileSystemRights]::FullControl
        'S-1-5-32-545' = [int64]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
    }
    $ownerSid = [string]$Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (-not [string]::Equals($ownerSid, $administratorsSid, [System.StringComparison]::Ordinal)) {
        throw "Protected Revit add-in ACL owner mismatch. path=$Path owner=$ownerSid"
    }
    if (-not $Acl.AreAccessRulesProtected) {
        throw "Protected Revit add-in ACL must not inherit a writable vendor/ProgramData DACL: $Path"
    }

    $rules = @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 3) {
        throw "Protected Revit add-in ACL must contain exactly the SYSTEM/Admins/Users rules. path=$Path ruleCount=$($rules.Count)"
    }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($rule in $rules) {
        $sid = [string]$rule.IdentityReference.Value
        if ($rule.IsInherited -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            -not $expectedRights.ContainsKey($sid) -or
            -not $seen.Add($sid)) {
            throw "Protected Revit add-in ACL contains an unexpected, inherited, denied, or duplicate rule. path=$Path principal=$sid"
        }
        if ([int64]$rule.FileSystemRights -ne [int64]$expectedRights[$sid]) {
            throw "Protected Revit add-in ACL rights mismatch. path=$Path principal=$sid rights=$($rule.FileSystemRights)"
        }
        if ($Kind -eq 'Directory') {
            $expectedInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [Security.AccessControl.InheritanceFlags]::ObjectInherit
            if ($rule.InheritanceFlags -ne $expectedInheritance -or
                $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
                throw "Protected Revit add-in directory rule has unexpected inheritance flags. path=$Path principal=$sid"
            }
        }
        elseif ($rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
            throw "Protected Revit add-in manifest rule must not inherit to another object. path=$Path principal=$sid"
        }
    }
    return $Path
}

function New-RevitMcpDirectoryWithAcl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [System.Security.AccessControl.DirectorySecurity]$Acl
    )

    if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $Path) {
        return
    }
    $directoryInfo = [System.IO.DirectoryInfo]::new($Path)
    $createWithAcl = $directoryInfo.GetType().GetMethod('Create', [type[]]@([System.Security.AccessControl.DirectorySecurity]))
    if ($null -ne $createWithAcl) {
        [void]$createWithAcl.Invoke($directoryInfo, [object[]]@($Acl))
        return
    }

    $extensionsType = 'System.IO.FileSystemAclExtensions' -as [type]
    if ($null -eq $extensionsType) {
        throw "No atomic DirectorySecurity creation API is available for the protected Revit add-in root."
    }
    $createDirectory = $extensionsType.GetMethod(
        'CreateDirectory',
        [Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Static,
        $null,
        [type[]]@([System.Security.AccessControl.DirectorySecurity], [string]),
        $null)
    if ($null -eq $createDirectory) {
        throw "The FileSystemAclExtensions atomic directory creation API was not found."
    }
    [void]$createDirectory.Invoke($null, [object[]]@($Acl, $Path))
}

function Open-RevitMcpAddinNoDeleteHandle {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [ValidateSet("Directory", "File")]
        [string]$Kind
    )

    [void](Assert-RevitMcpAddinPathComponentSafe -Path $Path -Kind $Kind)
    $handle = [RevAgent.PermissionNativeFileInfo]::OpenNoDelete($Path, ($Kind -eq 'Directory'))
    try {
        $attributes = [System.IO.FileAttributes][RevAgent.PermissionNativeFileInfo]::GetAttributes($handle)
        if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Protected Revit add-in item became a reparse point before ACL lockdown: $Path"
        }
        $isDirectory = (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0)
        if (($Kind -eq 'Directory') -ne $isDirectory) {
            throw "Protected Revit add-in item type changed before ACL lockdown: $Path"
        }
        return $handle
    }
    catch {
        $handle.Dispose()
        throw
    }
}

function New-RevitMcpCanonicalAddinMutationGuardContext {
    param([Parameter(Mandatory = $true)][object]$Paths)

    return [pscustomobject][ordered]@{
        AddinsParent = [string]$Paths.AddinsParent
        AddinRoot = [string]$Paths.AddinRoot
        ManifestPath = [string]$Paths.ManifestPath
        ParentGuard = $null
        RootGuard = $null
        ManifestGuard = $null
        Disposed = $false
    }
}

function Close-RevitMcpCanonicalAddinMutationGuard {
    [CmdletBinding()]
    param([AllowNull()][object]$Context)

    if ($null -eq $Context) { return }
    foreach ($propertyName in @('ManifestGuard', 'RootGuard', 'ParentGuard')) {
        $property = $Context.PSObject.Properties[$propertyName]
        if ($null -eq $property -or $null -eq $property.Value) { continue }
        try { $property.Value.Dispose() }
        finally { $property.Value = $null }
    }
    if ($null -ne $Context.PSObject.Properties['Disposed']) {
        $Context.Disposed = $true
    }
}

function Assert-RevitMcpCanonicalAddinGuardContextMatches {
    param(
        [Parameter(Mandatory = $true)][object]$Context,
        [Parameter(Mandatory = $true)][object]$Paths
    )

    if ([bool]$Context.Disposed) {
        throw 'Canonical Revit add-in mutation guard is already disposed.'
    }
    foreach ($propertyName in @('AddinsParent', 'AddinRoot', 'ManifestPath')) {
        if (-not [string]::Equals(
                [System.IO.Path]::GetFullPath([string]$Context.$propertyName).TrimEnd('\'),
                [System.IO.Path]::GetFullPath([string]$Paths.$propertyName).TrimEnd('\'),
                [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Canonical Revit add-in mutation guard path mismatch: $propertyName"
        }
    }
}

function Open-RevitMcpCanonicalAddinHeldGuard {
    param(
        [Parameter(Mandatory = $true)][object]$Context,
        [Parameter(Mandatory = $true)][ValidateSet('ParentGuard', 'RootGuard', 'ManifestGuard')][string]$PropertyName,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][ValidateSet('Directory', 'File')][string]$Kind
    )

    $existing = $Context.PSObject.Properties[$PropertyName].Value
    if ($null -ne $existing) {
        if ($existing.IsClosed -or $existing.IsInvalid) {
            throw "Canonical Revit add-in held guard is closed or invalid: $Path"
        }
        return $existing
    }
    [void](Assert-RevitMcpAddinPathComponentSafe -Path $Path -Kind $Kind)
    $handle = [RevAgent.PermissionNativeFileInfo]::OpenNoMutation($Path, ($Kind -eq 'Directory'))
    try {
        $attributes = [System.IO.FileAttributes][RevAgent.PermissionNativeFileInfo]::GetAttributes($handle)
        if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) -ne ($Kind -eq 'Directory')) {
            throw "Canonical Revit add-in held guard opened an unexpected item type or reparse point: $Path"
        }
        if ($Kind -eq 'File' -and [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($handle) -ne 1) {
            throw "Refusing a hard-linked revAgent add-in manifest: $Path"
        }
        $handleIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($handle)
        $pathIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($Path, ($Kind -eq 'Directory'))
        if (-not [string]::Equals($handleIdentity, $pathIdentity, [System.StringComparison]::Ordinal)) {
            throw "Canonical Revit add-in item changed identity while its held guard was opened: $Path"
        }
        $Context.PSObject.Properties[$PropertyName].Value = $handle
        return $handle
    }
    catch {
        $handle.Dispose()
        throw
    }
}

function Assert-RevitMcpCanonicalAddinMutationGuard {
    param(
        [Parameter(Mandatory = $true)][object]$Context,
        [Parameter(Mandatory = $true)][object]$Paths
    )

    Assert-RevitMcpCanonicalAddinGuardContextMatches -Context $Context -Paths $Paths
    if ($null -eq $Context.ParentGuard -or $Context.ParentGuard.IsClosed -or $Context.ParentGuard.IsInvalid) {
        throw 'Canonical Revit add-in parent guard is unavailable.'
    }
    $identities = [System.Collections.Generic.List[string]]::new()
    $protectedHandles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
    foreach ($entry in @(
            [pscustomobject]@{ Handle = $Context.ParentGuard; Path = $Paths.AddinsParent; Directory = $true },
            [pscustomobject]@{ Handle = $Context.RootGuard; Path = $Paths.AddinRoot; Directory = $true },
            [pscustomobject]@{ Handle = $Context.ManifestGuard; Path = $Paths.ManifestPath; Directory = $false }
        )) {
        if ($null -eq $entry.Handle) { continue }
        if ($entry.Handle.IsClosed -or $entry.Handle.IsInvalid) {
            throw "Canonical Revit add-in held guard is closed or invalid: $($entry.Path)"
        }
        $handleIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($entry.Handle)
        $pathIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity([string]$entry.Path, [bool]$entry.Directory)
        if (-not [string]::Equals($handleIdentity, $pathIdentity, [System.StringComparison]::Ordinal)) {
            throw "Canonical Revit add-in held guard no longer matches its exact path identity: $($entry.Path)"
        }
        [void]$identities.Add($handleIdentity)
        [void]$protectedHandles.Add($entry.Handle)
    }
    [RevAgent.PermissionNativeFileInfo]::AssertNoMutationHandles(
        $Context.ParentGuard,
        [string[]]$identities.ToArray(),
        [Microsoft.Win32.SafeHandles.SafeFileHandle[]]$protectedHandles.ToArray())
}

function Protect-RevitMcpCanonicalAddinItem {
    param(
        [Parameter(Mandatory = $true)][object]$Context,
        [Parameter(Mandatory = $true)][object]$Paths,
        [Parameter(Mandatory = $true)][ValidateSet('ParentGuard', 'RootGuard', 'ManifestGuard')][string]$GuardProperty,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][ValidateSet('Directory', 'File')][string]$Kind,
        [Parameter(Mandatory = $true)][object]$Acl
    )

    [void](Assert-RevitMcpAddinPathComponentSafe -Path $Path -Kind $Kind)
    $barrier = [RevAgent.PermissionNativeFileInfo]::OpenAclMutationBarrier($Path, ($Kind -eq 'Directory'))
    try {
        $attributes = [System.IO.FileAttributes][RevAgent.PermissionNativeFileInfo]::GetAttributes($barrier)
        if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) -ne ($Kind -eq 'Directory')) {
            throw "Canonical Revit add-in ACL barrier opened an unexpected item type or reparse point: $Path"
        }
        if ($Kind -eq 'File' -and [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($barrier) -ne 1) {
            throw "Refusing to protect a hard-linked revAgent add-in manifest: $Path"
        }
        $identity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($barrier)
        [RevAgent.PermissionNativeFileInfo]::AssertNoMutationHandles($barrier, [string[]]@($identity))
        [RevAgent.PermissionNativeFileInfo]::ApplyOwnerAndProtectedDacl($barrier, $Acl.GetSecurityDescriptorBinaryForm())
        if (-not [string]::Equals(
                $identity,
                [RevAgent.PermissionNativeFileInfo]::GetIdentity($Path, ($Kind -eq 'Directory')),
                [System.StringComparison]::Ordinal)) {
            throw "Canonical Revit add-in item changed identity during ACL protection: $Path"
        }
    }
    finally {
        $barrier.Dispose()
    }
    [void](Open-RevitMcpCanonicalAddinHeldGuard -Context $Context -PropertyName $GuardProperty -Path $Path -Kind $Kind)
    Assert-RevitMcpCanonicalAddinMutationGuard -Context $Context -Paths $Paths
    [void](Assert-RevitMcpProtectedAddinAcl -Acl (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path -ErrorAction Stop) -Path $Path -Kind $Kind)
}

function Protect-RevitMcpCanonicalAddinSurface {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$AddinRoot,
        [Parameter(Mandatory = $true)]
        [ValidateSet("2022", "2023", "2024", "2025")]
        [string]$RevitVersion,
        [switch]$CreateMissing,
        [switch]$ProtectManifest,
        [switch]$ProtectManifestIfPresent,
        [AllowNull()][object]$MutationGuardContext,
        [switch]$RetainMutationGuard
    )

    if (-not (Test-RevitMcpAdministrator)) {
        throw "Protecting the canonical Revit add-in ACL boundary requires administrator rights."
    }
    if ($ProtectManifest -and $ProtectManifestIfPresent) {
        throw "ProtectManifest and ProtectManifestIfPresent are mutually exclusive."
    }
    $paths = Get-RevitMcpCanonicalAddinSurfacePaths -AddinRoot $AddinRoot -RevitVersion $RevitVersion
    Assert-RevitMcpCanonicalAddinAncestorBoundary -Paths $paths
    $directoryAcl = New-RevitMcpProtectedAddinAcl -Kind Directory
    $fileAcl = New-RevitMcpProtectedAddinAcl -Kind File

    if (-not (Microsoft.PowerShell.Management\Test-Path -LiteralPath $paths.AddinsParent)) {
        if (-not $CreateMissing) {
            if ($ProtectManifest) { throw "Canonical Revit Addins parent is missing: $($paths.AddinsParent)" }
            return [pscustomobject][ordered]@{ protected = $false; reason = 'addins_parent_missing'; addinsParent = $paths.AddinsParent; addinRoot = $paths.AddinRoot }
        }
        New-RevitMcpDirectoryWithAcl -Path $paths.AddinsParent -Acl $directoryAcl
    }

    $contextCreatedHere = ($null -eq $MutationGuardContext)
    if ($contextCreatedHere) {
        $MutationGuardContext = New-RevitMcpCanonicalAddinMutationGuardContext -Paths $paths
    }
    else {
        Assert-RevitMcpCanonicalAddinGuardContextMatches -Context $MutationGuardContext -Paths $paths
    }
    $completed = $false
    try {
        Protect-RevitMcpCanonicalAddinItem -Context $MutationGuardContext -Paths $paths -GuardProperty ParentGuard -Path $paths.AddinsParent -Kind Directory -Acl $directoryAcl

        if (-not (Microsoft.PowerShell.Management\Test-Path -LiteralPath $paths.AddinRoot)) {
            if (-not $CreateMissing) {
                if ($ProtectManifest) { throw "Canonical Revit year add-in root is missing: $($paths.AddinRoot)" }
                return [pscustomobject][ordered]@{ protected = $true; reason = 'year_root_missing'; addinsParent = $paths.AddinsParent; addinRoot = $paths.AddinRoot }
            }
            New-RevitMcpDirectoryWithAcl -Path $paths.AddinRoot -Acl $directoryAcl
        }

        Protect-RevitMcpCanonicalAddinItem -Context $MutationGuardContext -Paths $paths -GuardProperty RootGuard -Path $paths.AddinRoot -Kind Directory -Acl $directoryAcl

        $protectManifestNow = [bool]$ProtectManifest
        if ($ProtectManifestIfPresent) {
            $manifestItem = Assert-RevitMcpAddinPathComponentSafe -Path $paths.ManifestPath -Kind File -AllowMissing
            $protectManifestNow = ($null -ne $manifestItem)
        }
        elseif (-not $ProtectManifest -and (Microsoft.PowerShell.Management\Test-Path -LiteralPath $paths.ManifestPath)) {
            # Even a full payload repair must seal and retain an existing exact
            # manifest identity before it is rewritten. This prevents a
            # pre-UAC write handle from surviving the directory DACL repair.
            $protectManifestNow = $true
        }
        if ($protectManifestNow) {
            Protect-RevitMcpCanonicalAddinItem -Context $MutationGuardContext -Paths $paths -GuardProperty ManifestGuard -Path $paths.ManifestPath -Kind File -Acl $fileAcl
        }

        Assert-RevitMcpCanonicalAddinMutationGuard -Context $MutationGuardContext -Paths $paths
        Assert-RevitMcpCanonicalAddinAncestorBoundary -Paths $paths
        [void](Assert-RevitMcpProtectedAddinAcl -Acl (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $paths.AddinsParent -ErrorAction Stop) -Path $paths.AddinsParent -Kind Directory)
        [void](Assert-RevitMcpProtectedAddinAcl -Acl (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $paths.AddinRoot -ErrorAction Stop) -Path $paths.AddinRoot -Kind Directory)
        if ($protectManifestNow) {
            [void](Assert-RevitMcpProtectedAddinAcl -Acl (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $paths.ManifestPath -ErrorAction Stop) -Path $paths.ManifestPath -Kind File)
        }
        $completed = $true
        return [pscustomobject][ordered]@{
            protected = $true
            addinsParent = $paths.AddinsParent
            addinRoot = $paths.AddinRoot
            manifestPath = if ($protectManifestNow) { $paths.ManifestPath } else { $null }
            manifestProtected = [bool]$protectManifestNow
            mutationGuardContext = if ($RetainMutationGuard) { $MutationGuardContext } else { $null }
        }
    }
    finally {
        if (($contextCreatedHere -and -not $completed) -or ($completed -and -not $RetainMutationGuard)) {
            Close-RevitMcpCanonicalAddinMutationGuard -Context $MutationGuardContext
        }
    }
}

function New-RevitMcpPermissionTarget {
    param(
        [string]$Path,
        [string]$Label,
        [ValidateSet("Directory", "File")]
        [string]$Kind = "Directory",
        [switch]$CreateDirectory,
        [switch]$Recurse
    )

    return [pscustomobject]@{
        Path = $Path
        Label = $Label
        Kind = $Kind
        CreateDirectory = [bool]$CreateDirectory
        Recurse = [bool]$Recurse
    }
}

function Get-RevitMcpManagedPermissionTargets {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,
        [Parameter(Mandatory = $true)]
        [string]$WorkRoot,
        [Parameter(Mandatory = $true)]
        [string]$PackageTarget,
        [Parameter(Mandatory = $true)]
        [string]$ServerTarget,
        [string]$AllUsersAddinRoot = "",
        [string]$RevitVersion = "2022",
        [switch]$IncludeExistingPayloadTrees
    )

    $targets = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in @(
            @{ Path = $InstallRoot; Label = "revAgent install root" },
            @{ Path = $WorkRoot; Label = "updater work root" },
            @{ Path = $PackageTarget; Label = "package target" },
            @{ Path = $ServerTarget; Label = "runtime target" },
            @{ Path = (Join-Path $InstallRoot "revit-plugin"); Label = "Revit addin payload root" },
            @{ Path = (Join-Path $InstallRoot "commands"); Label = "Revit command payload root" },
            @{ Path = (Join-Path $InstallRoot "codex"); Label = "Codex payload root" },
            @{ Path = (Join-Path $InstallRoot "state"); Label = "state root" },
            @{ Path = (Join-Path $WorkRoot "logs"); Label = "updater logs root" },
            @{ Path = (Join-Path $WorkRoot "cache"); Label = "updater cache root" },
            @{ Path = (Join-Path $WorkRoot "staging"); Label = "updater staging root" },
            @{ Path = (Join-Path $WorkRoot "reports"); Label = "updater reports root" },
            @{ Path = (Join-Path $WorkRoot "config"); Label = "updater config root" }
        )) {
        $targets.Add((New-RevitMcpPermissionTarget -Path $entry.Path -Label $entry.Label -CreateDirectory))
    }
    $targets.Add((New-RevitMcpPermissionTarget -Path (Join-Path $WorkRoot "lib") -Label "updater lib root" -CreateDirectory -Recurse))

    # The shared Autodesk Addins surface is intentionally excluded from the
    # generic grant-based repair plan. It is protected and attested through
    # Protect-RevitMcpCanonicalAddinSurface, which validates the exact
    # ProgramData path and replaces unsafe inherited/user-write ACLs.

    foreach ($fileName in @(
            "Run-revAgent-Update-Hidden.vbs",
            "last-update-report.json",
            "installed.json",
            "updater-config.json",
            "update-from-nas.ps1",
            "show-installed-version.ps1",
            "install-updater-task.ps1",
            "migrate-source-free-install.ps1",
            "Invoke-revAgent-CodexUserIntegration.ps1",
            "Update-revAgent-Now.cmd",
            "Show-revAgent-Version.cmd",
            "auto-update-loop.ps1",
            "config\release-trusted-keys.json"
        )) {
        $targets.Add((New-RevitMcpPermissionTarget -Path (Join-Path $WorkRoot $fileName) -Label "updater file $fileName" -Kind File))
    }

    if ($IncludeExistingPayloadTrees) {
        foreach ($entry in @(
                @{ Path = (Join-Path $InstallRoot "revit-plugin\revAgentPlugin"); Label = "existing Revit addin payload" },
                @{ Path = (Join-Path $InstallRoot "revit-plugin\revit_mcp_plugin"); Label = "legacy Revit addin payload" },
                @{ Path = (Join-Path $InstallRoot "commands\CommandSet"); Label = "existing Revit command payload" },
                @{ Path = $ServerTarget; Label = "existing runtime payload" },
                @{ Path = (Join-Path $InstallRoot "codex\skills\revAgent"); Label = "existing Codex skill payload" }
            )) {
            $targets.Add((New-RevitMcpPermissionTarget -Path $entry.Path -Label $entry.Label -Recurse))
        }
    }

    return $targets.ToArray()
}

function Grant-RevitMcpManagedPathAccess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [string]$Label = "managed path",
        [string]$Principal = "",
        [switch]$CreateDirectory,
        [switch]$Recurse
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }
    if (-not (Test-RevitMcpAdministrator)) {
        return
    }

    try {
        if ($CreateDirectory) {
            New-Item -ItemType Directory -Path $Path -Force | Out-Null
        }
        elseif (-not (Test-Path -LiteralPath $Path)) {
            return
        }

        $identity = $Principal
        if ([string]::IsNullOrWhiteSpace($identity)) {
            # Machine payload trees are administrator-owned. Never infer the
            # split-token interactive account here, because that would make
            # updater scripts/modules executable by an elevated process while
            # still writable by the unelevated user.
            $identity = "*S-1-5-32-544"
        }
        if ([string]::IsNullOrWhiteSpace($identity)) {
            return
        }

        $grant = if ($Recurse -or $CreateDirectory) { "${identity}:(OI)(CI)M" } else { "${identity}:M" }
        $arguments = @($Path, "/grant", $grant, "/C")
        if ($Recurse) {
            $arguments += "/T"
        }

        $icacls = Join-Path ([Environment]::SystemDirectory) "icacls.exe"
        if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) {
            throw "icacls.exe was not found at the trusted Windows path: $icacls"
        }
        Write-Host "Permission repair: $Label"
        & $icacls @arguments 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not grant write access to $identity for $Label ($Path). icacls exit code: $LASTEXITCODE"
        }
    }
    catch {
        Write-Warning "Could not grant write access for $Label (${Path}): $($_.Exception.Message)"
    }
}

function Resolve-RevitMcpProfileListImagePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProfileImagePath
    )

    if ([string]::IsNullOrWhiteSpace($ProfileImagePath)) {
        throw "ProfileImagePath is empty."
    }
    $systemDrive = [System.IO.Path]::GetPathRoot([Environment]::SystemDirectory).TrimEnd('\')
    if ([string]::IsNullOrWhiteSpace($systemDrive)) {
        throw "Canonical Windows system drive could not be resolved from SystemDirectory."
    }
    $expanded = [regex]::Replace($ProfileImagePath.Trim(), '(?i)%SystemDrive%', $systemDrive)
    if ($expanded -match '%[^%]+%') {
        throw "ProfileImagePath contains an unsupported environment token: $ProfileImagePath"
    }
    if (-not [System.IO.Path]::IsPathRooted($expanded)) {
        throw "ProfileImagePath must resolve to an absolute path: $ProfileImagePath"
    }
    return [System.IO.Path]::GetFullPath($expanded).TrimEnd('\')
}

function Resolve-RevitMcpInteractiveUserBinding {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetInteractiveUser,
        [Parameter(Mandatory = $true)]
        [string]$TargetInteractiveUserSid,
        [Parameter(Mandatory = $true)]
        [string]$TargetUserProfileRoot,
        [string]$ProfileListRegistryRoot = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList',
        [scriptblock]$AccountLookupOverride = $null
    )

    foreach ($required in @(
            @{ Name = 'TargetInteractiveUser'; Value = $TargetInteractiveUser },
            @{ Name = 'TargetInteractiveUserSid'; Value = $TargetInteractiveUserSid },
            @{ Name = 'TargetUserProfileRoot'; Value = $TargetUserProfileRoot }
        )) {
        if ([string]::IsNullOrWhiteSpace([string]$required.Value)) {
            throw "$($required.Name) is required for the elevated interactive-user binding."
        }
    }

    try {
        $sid = [System.Security.Principal.SecurityIdentifier]::new($TargetInteractiveUserSid.Trim())
    }
    catch {
        throw "TargetInteractiveUserSid is not a valid Windows SID: $TargetInteractiveUserSid"
    }
    if (-not $sid.IsAccountSid()) {
        throw "TargetInteractiveUserSid must be an account SID, not a broad or service identity: $($sid.Value)"
    }

    $isWellKnown = $false
    foreach ($wellKnownType in [Enum]::GetValues([System.Security.Principal.WellKnownSidType])) {
        try {
            if ($sid.IsWellKnown($wellKnownType)) {
                $isWellKnown = $true
                break
            }
        }
        catch {
            # Some framework versions expose sentinel enum values that cannot
            # be passed to IsWellKnown. They do not describe a concrete SID.
        }
    }
    if ($isWellKnown) {
        throw "TargetInteractiveUserSid must not be a well-known or broad identity: $($sid.Value)"
    }

    $account = if ($null -ne $AccountLookupOverride) {
        & $AccountLookupOverride $sid.Value
    }
    else {
        $translated = $sid.Translate([System.Security.Principal.NTAccount]).Value
        $native = [RevAgent.AccountNativeInfo]::Lookup($sid.Value)
        if ([int]$native.SidType -ne 1) {
            throw "TargetInteractiveUserSid resolves to a non-user account type ($($native.SidType)): $($sid.Value)"
        }
        if (-not [string]::Equals([string]$translated, [string]$native.AccountName, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "TargetInteractiveUserSid account resolution was inconsistent. NTAccount='$translated' native='$($native.AccountName)'."
        }
        [pscustomobject]@{
            AccountName = [string]$translated
            SidType = 'User'
        }
    }
    if ($null -eq $account -or [string]::IsNullOrWhiteSpace([string]$account.AccountName)) {
        throw "TargetInteractiveUserSid could not be resolved to an NTAccount user: $($sid.Value)"
    }
    $sidType = [string]$account.SidType
    if (-not ([string]::Equals($sidType, 'User', [System.StringComparison]::OrdinalIgnoreCase) -or $sidType -eq '1')) {
        throw "TargetInteractiveUserSid resolves to a non-user account type ($sidType): $($sid.Value)"
    }
    $resolvedAccount = [string]$account.AccountName
    if (-not [string]::Equals($resolvedAccount, $TargetInteractiveUser.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Interactive user account mismatch. SID $($sid.Value) resolves to '$resolvedAccount', not '$TargetInteractiveUser'."
    }

    $profileKey = Join-Path $ProfileListRegistryRoot $sid.Value
    try {
        $profileValue = (Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath
    }
    catch {
        throw "Interactive user SID has no readable ProfileList binding: SID=$($sid.Value) key=$profileKey"
    }
    if ([string]::IsNullOrWhiteSpace([string]$profileValue)) {
        throw "Interactive user ProfileList binding has an empty ProfileImagePath: SID=$($sid.Value)"
    }
    $resolvedProfile = Resolve-RevitMcpProfileListImagePath -ProfileImagePath ([string]$profileValue)
    if ($TargetUserProfileRoot -match '%[^%]+%') {
        throw "TargetUserProfileRoot must be the absolute path captured before elevation and must not contain environment tokens: $TargetUserProfileRoot"
    }
    if (-not [System.IO.Path]::IsPathRooted($TargetUserProfileRoot)) {
        throw "TargetUserProfileRoot must be the absolute path captured before elevation: $TargetUserProfileRoot"
    }
    $expectedProfile = [System.IO.Path]::GetFullPath($TargetUserProfileRoot).TrimEnd('\')
    if (-not [string]::Equals($resolvedProfile, $expectedProfile, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Interactive user profile mismatch. ProfileList resolves SID $($sid.Value) to '$resolvedProfile', not '$expectedProfile'."
    }
    if (-not (Test-Path -LiteralPath $resolvedProfile -PathType Container)) {
        throw "Interactive user ProfileList directory was not found: SID=$($sid.Value) path=$resolvedProfile"
    }

    return [pscustomobject][ordered]@{
        UserName = $resolvedAccount
        Sid = $sid.Value
        ProfileRoot = $resolvedProfile
        SidType = 'User'
        ProfileListKey = $profileKey
    }
}

function Assert-RevitMcpManagedTreeLinkSafe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
    if (-not (Test-Path -LiteralPath $fullRoot)) {
        return $fullRoot
    }

    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($fullRoot)
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing managed execution tree containing a reparse point: $($item.FullName)"
        }
        if (-not $item.PSIsContainer) {
            $linkCount = [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($item.FullName)
            if ($linkCount -ne 1) {
                throw "Refusing managed execution tree containing a hard-linked file (link count $linkCount): $($item.FullName)"
            }
            continue
        }

        foreach ($childPath in [System.IO.Directory]::EnumerateFileSystemEntries($item.FullName)) {
            $child = Get-Item -LiteralPath $childPath -Force -ErrorAction Stop
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing managed execution tree containing a reparse point: $($child.FullName)"
            }
            if ($child.PSIsContainer) {
                $pending.Push($child.FullName)
            }
            else {
                $linkCount = [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($child.FullName)
                if ($linkCount -ne 1) {
                    throw "Refusing managed execution tree containing a hard-linked file (link count $linkCount): $($child.FullName)"
                }
            }
        }
    }
    return $fullRoot
}

function Open-RevitMcpManagedMutationGuard {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [string[]]$ProtectedPaths = @(),
        [switch]$ExactProtectedPaths
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw "Managed mutation guard directory was not found: $fullPath"
    }

    [void](Assert-RevitMcpManagedTreeLinkSafe -Root $fullPath)
    $handle = $null
    $childHandles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
    try {
        $handle = [RevAgent.PermissionNativeFileInfo]::OpenNoMutation($fullPath, $true)
        $attributes = [System.IO.FileAttributes][RevAgent.PermissionNativeFileInfo]::GetAttributes($handle)
        if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0 -or
            ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Managed mutation guard target is not an ordinary directory: $fullPath"
        }

        # Reattest after acquiring the root share guard, then bind the lexical
        # path and every mutation-target child to exact filesystem identities.
        # Windows directory share flags do not account for all metadata rights
        # or retained child handles; the native handle inventory below closes
        # that gap before any updater file is refreshed.
        [void](Assert-RevitMcpManagedTreeLinkSafe -Root $fullPath)
        $handleIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($handle)
        $pathIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($fullPath, $true)
        if (-not [string]::Equals($handleIdentity, $pathIdentity, [System.StringComparison]::Ordinal)) {
            throw "Managed mutation guard path identity changed while it was being locked: $fullPath"
        }

        $identityByPath = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        $identityByPath[$fullPath] = $handleIdentity
        $targets = if (@($ProtectedPaths).Count -gt 0) { @($ProtectedPaths) } else { @($fullPath) }
        foreach ($target in $targets) {
            if ([string]::IsNullOrWhiteSpace([string]$target)) { continue }
            $targetPath = if ([System.IO.Path]::IsPathRooted([string]$target)) {
                [System.IO.Path]::GetFullPath([string]$target).TrimEnd("\")
            }
            else {
                [System.IO.Path]::GetFullPath((Join-Path $fullPath ([string]$target))).TrimEnd("\")
            }
            if (-not [string]::Equals($targetPath, $fullPath, [System.StringComparison]::OrdinalIgnoreCase) -and
                -not $targetPath.StartsWith($fullPath + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Managed mutation protected path escaped its guard root: $targetPath"
            }
            if (-not (Test-Path -LiteralPath $targetPath)) { continue }
            $pending = [System.Collections.Generic.Stack[string]]::new()
            $pending.Push($targetPath)
            while ($pending.Count -gt 0) {
                $candidatePath = $pending.Pop()
                $candidate = Microsoft.PowerShell.Management\Get-Item -LiteralPath $candidatePath -Force -ErrorAction Stop
                if (($candidate.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                    -not [string]::IsNullOrWhiteSpace([string]$candidate.LinkType)) {
                    throw "Managed mutation protected path contains a link/reparse item: $($candidate.FullName)"
                }
                if (-not $candidate.PSIsContainer) {
                    $linkCount = [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($candidate.FullName)
                    if ($linkCount -ne 1) {
                        throw "Managed mutation protected path contains a hard-linked file (link count $linkCount): $($candidate.FullName)"
                    }
                }
                if (-not $identityByPath.ContainsKey($candidate.FullName)) {
                    $candidateHandle = $null
                    try {
                        $candidateHandle = [RevAgent.PermissionNativeFileInfo]::OpenNoMutation($candidate.FullName, [bool]$candidate.PSIsContainer)
                        $candidateAttributes = [System.IO.FileAttributes][RevAgent.PermissionNativeFileInfo]::GetAttributes($candidateHandle)
                        if (($candidateAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                            (($candidateAttributes -band [System.IO.FileAttributes]::Directory) -ne 0) -ne [bool]$candidate.PSIsContainer) {
                            throw "Managed mutation protected path changed type or became a reparse point while it was being pinned: $($candidate.FullName)"
                        }
                        if (-not $candidate.PSIsContainer -and [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($candidateHandle) -ne 1) {
                            throw "Managed mutation protected path became hard-linked while it was being pinned: $($candidate.FullName)"
                        }
                        $candidateIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($candidateHandle)
                        $candidatePathIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($candidate.FullName, [bool]$candidate.PSIsContainer)
                        if (-not [string]::Equals($candidateIdentity, $candidatePathIdentity, [System.StringComparison]::Ordinal)) {
                            throw "Managed mutation protected path changed identity while it was being pinned: $($candidate.FullName)"
                        }
                        $identityByPath[$candidate.FullName] = $candidateIdentity
                        [void]$childHandles.Add($candidateHandle)
                        $candidateHandle = $null
                    }
                    finally {
                        if ($null -ne $candidateHandle) { $candidateHandle.Dispose() }
                    }
                }
                if ($candidate.PSIsContainer -and -not $ExactProtectedPaths) {
                    foreach ($childPath in [System.IO.Directory]::EnumerateFileSystemEntries($candidate.FullName)) {
                        $pending.Push($childPath)
                    }
                }
            }
        }
        $allProtectedHandles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
        [void]$allProtectedHandles.Add($handle)
        foreach ($childHandle in $childHandles) { [void]$allProtectedHandles.Add($childHandle) }
        [RevAgent.PermissionNativeFileInfo]::AssertNoMutationHandles(
            $handle,
            [string[]]@($identityByPath.Values),
            [Microsoft.Win32.SafeHandles.SafeFileHandle[]]$allProtectedHandles.ToArray())

        # The protected ACL prevents new untrusted handles after the inventory.
        # Re-read every bound identity to detect a close-and-swap race that
        # happened while the system handle snapshot was evaluated.
        [void](Assert-RevitMcpManagedTreeLinkSafe -Root $fullPath)
        foreach ($boundPath in @($identityByPath.Keys)) {
            if (-not (Test-Path -LiteralPath $boundPath)) {
                throw "Managed mutation protected path disappeared during handle attestation: $boundPath"
            }
            $boundItem = Microsoft.PowerShell.Management\Get-Item -LiteralPath $boundPath -Force -ErrorAction Stop
            $currentIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($boundItem.FullName, [bool]$boundItem.PSIsContainer)
            if (-not [string]::Equals($currentIdentity, [string]$identityByPath[$boundPath], [System.StringComparison]::Ordinal)) {
                throw "Managed mutation protected path identity changed during handle attestation: $boundPath"
            }
        }
        return $handle
    }
    catch {
        if ($null -ne $handle) { $handle.Dispose() }
        throw
    }
    finally {
        foreach ($childHandle in $childHandles) {
            if ($null -ne $childHandle) { $childHandle.Dispose() }
        }
    }
}

function Assert-RevitMcpCanonicalManagedInstallBoundary {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$InstallRoot)

    $commonApplicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    if ([string]::IsNullOrWhiteSpace($commonApplicationData)) {
        throw "Canonical CommonApplicationData known folder could not be resolved."
    }
    $expectedRoot = [System.IO.Path]::GetFullPath((Join-Path $commonApplicationData "DPE\revAgent")).TrimEnd("\")
    $actualRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\")
    if (-not [string]::Equals($actualRoot, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Managed install mutation accepts only the canonical protected root '$expectedRoot'; refusing '$actualRoot'."
    }
    $dpeRoot = Split-Path -Parent $expectedRoot
    $trustedOwnerSids = @("S-1-5-18", "S-1-5-32-544")
    $mutationMask = [int64]([Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership)
    $ancestorReplacementMask = [int64]([Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership)
    foreach ($boundaryPath in @($dpeRoot, $actualRoot)) {
        if (-not (Test-Path -LiteralPath $boundaryPath -PathType Container)) {
            throw "Canonical managed install boundary is missing: $boundaryPath"
        }
        $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $boundaryPath -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
            throw "Canonical managed install boundary must not be a link/reparse directory: $boundaryPath"
        }
        $acl = Get-Acl -LiteralPath $boundaryPath -ErrorAction Stop
        $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($ownerSid -notin $trustedOwnerSids) {
            throw "Canonical managed install boundary has an untrusted owner. path=$boundaryPath owner=$ownerSid"
        }
        $isInstallRoot = [string]::Equals($boundaryPath, $actualRoot, [System.StringComparison]::OrdinalIgnoreCase)
        if ($isInstallRoot -and -not $acl.AreAccessRulesProtected) {
            throw "Canonical managed install boundary DACL is not protected: $boundaryPath"
        }
        $effectiveMutationMask = if ($isInstallRoot) { $mutationMask } else { $ancestorReplacementMask }
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            $sid = [string]$rule.IdentityReference.Value
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $trustedOwnerSids -notcontains $sid -and
                (([int64]$rule.FileSystemRights -band $effectiveMutationMask) -ne 0)) {
                throw "Canonical managed install boundary grants mutation-capable access to an untrusted principal. path=$boundaryPath principal=$sid rights=$($rule.FileSystemRights)"
            }
        }
    }
    return [pscustomobject][ordered]@{ InstallRoot = $actualRoot; ParentBoundary = $dpeRoot }
}

function Assert-RevitMcpImmutableSecurityTree {
    param([Parameter(Mandatory = $true)][string]$Root)
    $fullRoot = Assert-RevitMcpManagedTreeLinkSafe -Root $Root
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) { throw "Immutable revAgent security root was not found: $fullRoot" }
    $trustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($item in @((Get-Item -LiteralPath $fullRoot -Force)) + @(Get-ChildItem -LiteralPath $fullRoot -Recurse -Force -ErrorAction Stop)) {
        $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
        $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin $trustedOwners) { throw "Immutable revAgent security item has an untrusted owner. path=$($item.FullName) owner=$owner" }
        if (-not $acl.AreAccessRulesProtected) { throw "Immutable revAgent security item must keep a protected DACL: $($item.FullName)" }
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            $sid = [string]$rule.IdentityReference.Value
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $sid -notin $trustedOwners -and (($rule.FileSystemRights -band $writeMask) -ne 0)) {
                throw "Immutable revAgent security item grants write/delete/ACL capability to an untrusted principal. path=$($item.FullName) principal=$sid"
            }
        }
    }
    return $fullRoot
}

function Protect-RevitMcpManagedExecutionTree {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,
        [string]$InteractivePrincipal = "",
        [string[]]$ManagedReparsePaths = @()
    )

    if (-not (Test-RevitMcpAdministrator)) {
        throw "Protecting the revAgent machine execution tree requires administrator rights."
    }

    $root = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\")
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
    }

    $icacls = Join-Path ([Environment]::SystemDirectory) "icacls.exe"
    if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) {
        throw "icacls.exe was not found: $icacls"
    }

    # Replace, rather than subtract from, the root DACL. This removes writable
    # Everyone, Authenticated Users, custom-group, CREATOR OWNER, and stale
    # interactive-user ACEs that an allowlist of known principals would miss.
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $usersSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($administratorsSid)
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow))
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($administratorsSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow))
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($usersSid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance, $propagation, $allow))
    $fileSecurity = [System.Security.AccessControl.FileSecurity]::new()
    $fileSecurity.SetAccessRuleProtection($true, $false)
    $fileSecurity.SetOwner($administratorsSid)
    $fileSecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $allow))
    $fileSecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($administratorsSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $allow))
    $fileSecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($usersSid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $allow))

    $immutableSecurityRoots = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($leaf in @('bootstrap', 'execution-snapshots', 'broker-state')) {
        $candidate = Join-Path $root $leaf
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            [void](Assert-RevitMcpImmutableSecurityTree -Root $candidate)
            [void]$immutableSecurityRoots.Add([System.IO.Path]::GetFullPath($candidate).TrimEnd('\'))
        }
    }

    # Prior releases intentionally created these two cache-backed node_modules
    # junctions. Unlink only those exact leaves without following their target;
    # all other reparse points remain a hard failure.
    $allowedManagedReparse = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in @(
            (Join-Path $root 'runtime\node_modules'),
            (Join-Path $root 'package\installer\revit-api-docs-mcp\node_modules'),
            (Join-Path $root 'revit-mcp-skill\installer\revit-api-docs-mcp\node_modules')
        ) + @($ManagedReparsePaths)) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            [void]$allowedManagedReparse.Add([System.IO.Path]::GetFullPath($candidate).TrimEnd('\'))
        }
    }

    # Lock directory creation/deletion top-down before any recursive icacls
    # call. Once each parent is protected, a user cannot race a new junction or
    # hardlink into a directory that has already been inspected.
    $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing managed execution root that is a reparse point: $root"
    }
    Set-Acl -LiteralPath $root -AclObject $security -ErrorAction Stop
    $pendingDirectories = [System.Collections.Generic.Stack[string]]::new()
    $pendingDirectories.Push($root)
    while ($pendingDirectories.Count -gt 0) {
        $directory = $pendingDirectories.Pop()
        foreach ($childPath in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $child = Get-Item -LiteralPath $childPath -Force -ErrorAction Stop
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                $fullChild = [System.IO.Path]::GetFullPath($child.FullName).TrimEnd('\')
                $linkType = if ($child.PSObject.Properties['LinkType']) { [string]$child.LinkType } else { '' }
                if ($child.PSIsContainer -and $linkType -eq 'Junction' -and $allowedManagedReparse.Contains($fullChild)) {
                    [RevAgent.PermissionNativeFileInfo]::RemoveDirectoryLink($fullChild)
                    if (Test-Path -LiteralPath $fullChild) {
                        throw "Managed npm junction could not be unlinked safely: $fullChild"
                    }
                    Write-Host "Removed prior-version managed npm junction before ACL lockdown: $fullChild" -ForegroundColor Yellow
                    continue
                }
                throw "Refusing managed execution tree containing a reparse point: $($child.FullName)"
            }
            if ($child.PSIsContainer) {
                if ($immutableSecurityRoots.Contains([System.IO.Path]::GetFullPath($child.FullName).TrimEnd('\'))) {
                    [void](Assert-RevitMcpImmutableSecurityTree -Root $child.FullName)
                    continue
                }
                Set-Acl -LiteralPath $child.FullName -AclObject $security -ErrorAction Stop
                $pendingDirectories.Push($child.FullName)
            }
            else {
                $linkCount = [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($child.FullName)
                if ($linkCount -ne 1) {
                    throw "Refusing managed execution tree containing a hard-linked file (link count $linkCount): $($child.FullName)"
                }
                Set-Acl -LiteralPath $child.FullName -AclObject $fileSecurity -ErrorAction Stop
            }
        }
    }

    # Directory topology is now locked. Reject every remaining reparse point
    # and any pre-existing hardlink before recursive owner/ACL normalization.
    [void](Assert-RevitMcpManagedTreeLinkSafe -Root $root)

    & $icacls $root "/setowner" "*S-1-5-32-544" "/T" "/C" "/Q" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to secure revAgent execution-tree ownership (icacls exit $LASTEXITCODE): $root"
    }

    # Normalize descendants to inherit only the protected root ACL. Do not
    # reset the root itself, which would re-import ProgramData's create/write
    # ACE for BUILTIN\Users.
    foreach ($child in @(Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue)) {
        if ($child.PSIsContainer -and $immutableSecurityRoots.Contains([System.IO.Path]::GetFullPath($child.FullName).TrimEnd('\'))) {
            [void](Assert-RevitMcpImmutableSecurityTree -Root $child.FullName)
            continue
        }
        & $icacls $child.FullName "/reset" "/T" "/C" "/Q" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to normalize revAgent descendant ACLs (icacls exit $LASTEXITCODE): $($child.FullName)"
        }
    }

    [void](Assert-RevitMcpManagedTreeLinkSafe -Root $root)
    foreach ($immutableRoot in $immutableSecurityRoots) { [void](Assert-RevitMcpImmutableSecurityTree -Root $immutableRoot) }

    return $root
}

function Grant-RevitMcpUserStateAccess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkRoot,
        [string]$InstallRoot = "",
        [Parameter(Mandatory = $true)]
        [string]$InteractivePrincipal
    )

    if (-not (Test-RevitMcpAdministrator)) {
        throw "Granting revAgent user-state access requires administrator rights."
    }
    if ([string]::IsNullOrWhiteSpace($InteractivePrincipal)) {
        throw "InteractivePrincipal is required for the revAgent user-state ACL."
    }

    if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
        $InstallRoot = Split-Path -Parent ([System.IO.Path]::GetFullPath($WorkRoot))
    }
    $roots = @(
        (Join-Path $WorkRoot "logs"),
        (Join-Path $WorkRoot "user-state"),
        (Join-Path $InstallRoot "state"),
        (Join-Path $InstallRoot "addons\usage-intelligence\state"),
        (Join-Path $InstallRoot "addons\dashboard\state")
    )
    foreach ($root in $roots) {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Grant-RevitMcpManagedPathAccess -Path $root -Label "revAgent user-writable state" -Principal $InteractivePrincipal -CreateDirectory -Recurse
    }
    return $roots
}

function Invoke-RevitMcpManagedPermissionRepair {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Targets,
        [string]$Principal = ""
    )

    foreach ($target in $Targets) {
        Grant-RevitMcpManagedPathAccess `
            -Path ([string]$target.Path) `
            -Label ([string]$target.Label) `
            -Principal $Principal `
            -CreateDirectory:([bool]$target.CreateDirectory) `
            -Recurse:([bool]$target.Recurse)
    }
}

$revAgentFunctionAliases = @{
    "Resolve-RevAgentInteractiveUserBinding" = "Resolve-RevitMcpInteractiveUserBinding"
    "Get-RevAgentManagedPermissionTargets" = "Get-RevitMcpManagedPermissionTargets"
    "Grant-RevAgentManagedPathAccess" = "Grant-RevitMcpManagedPathAccess"
    "Invoke-RevAgentManagedPermissionRepair" = "Invoke-RevitMcpManagedPermissionRepair"
    "New-RevAgentPermissionTarget" = "New-RevitMcpPermissionTarget"
    "Protect-RevAgentManagedExecutionTree" = "Protect-RevitMcpManagedExecutionTree"
    "Protect-RevAgentCanonicalAddinSurface" = "Protect-RevitMcpCanonicalAddinSurface"
    "Close-RevAgentCanonicalAddinMutationGuard" = "Close-RevitMcpCanonicalAddinMutationGuard"
    "Grant-RevAgentUserStateAccess" = "Grant-RevitMcpUserStateAccess"
    "Assert-RevAgentManagedTreeLinkSafe" = "Assert-RevitMcpManagedTreeLinkSafe"
    "Open-RevAgentManagedMutationGuard" = "Open-RevitMcpManagedMutationGuard"
    "Assert-RevAgentCanonicalManagedInstallBoundary" = "Assert-RevitMcpCanonicalManagedInstallBoundary"
    "Test-RevAgentAdministrator" = "Test-RevitMcpAdministrator"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) {
    Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value
}

Export-ModuleMember -Function `
    Test-RevitMcpAdministrator, `
    Resolve-RevitMcpInteractiveUserBinding, `
    Assert-RevitMcpManagedTreeLinkSafe, `
    Open-RevitMcpManagedMutationGuard, `
    Assert-RevitMcpCanonicalManagedInstallBoundary, `
    New-RevitMcpPermissionTarget, `
    Get-RevitMcpManagedPermissionTargets, `
    Grant-RevitMcpManagedPathAccess, `
    Invoke-RevitMcpManagedPermissionRepair, `
    Protect-RevitMcpCanonicalAddinSurface, `
    Close-RevitMcpCanonicalAddinMutationGuard, `
    Protect-RevitMcpManagedExecutionTree, `
    Grant-RevitMcpUserStateAccess
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)
