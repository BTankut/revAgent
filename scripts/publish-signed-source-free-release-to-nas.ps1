<#
.SYNOPSIS
    Publish a prebuilt signed source-free release root to the production NAS layout.

.DESCRIPTION
    Copies an already signed and validated CD release root to a NAS release
    root without rebuilding or re-signing it. The source release metadata uses
    relative channel paths, so the detached signatures remain valid after the
    release root moves from CD staging to NAS.

    The NAS is treated as a writable signed transport, not as an executable
    trust boundary. The script never depends on changing or sealing remote
    DACLs. It proves that the active filesystem session creates objects with
    the release-root owner SID, runs a real create/delete canary, copies release
    files and tools, validates a candidate channel manifest on the NAS root,
    then updates the stable channel file. Workstations establish execution
    trust only after copying the signed surface into a protected local snapshot.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceReleaseRoot,

    [Parameter(Mandatory = $true)]
    [string]$NasReleaseRoot,

    [Parameter(Mandatory = $true)]
    [string]$TrustedKeysPath,

    [string]$ExpectedSourceChannelSha256 = "",

    [ValidateSet("stable", "pilot")]
    [string]$Channel = "stable",

    [switch]$Force,

    # Authorizes deliberate signed rollback and equal releaseSequence repair
    # republish. It never bypasses signature/readiness validation of an existing
    # stable channel.
    [switch]$AllowRollback,

    [switch]$OutputJson,

    [switch]$AllowTestRoot,

    [switch]$IncludeAclTelemetry,

    [Parameter(DontShow = $true)]
    [scriptblock]$TestBeforeStablePromotionHook,

    [Parameter(DontShow = $true)]
    [scriptblock]$TestAfterSourceReadinessHook,

    [Parameter(DontShow = $true)]
    [scriptblock]$TestAfterSourceRoutingReadHook,

    [Parameter(DontShow = $true)]
    [scriptblock]$TestAfterBaselineReadinessHook,

    [Parameter(DontShow = $true)]
    [scriptblock]$TestAfterSignatureWriteHook,

    [Parameter(DontShow = $true)]
    [scriptblock]$TestBeforeNewPairCreateHook,

    [Parameter(DontShow = $true)]
    [scriptblock]$TestBeforePilotImmutableFinalVerificationHook,

    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$SourceReleaseRoot = [System.IO.Path]::GetFullPath($SourceReleaseRoot)
$NasReleaseRoot = [System.IO.Path]::GetFullPath($NasReleaseRoot)
$TrustedKeysPath = [System.IO.Path]::GetFullPath($TrustedKeysPath)
$canonicalProductionReleaseRoot = [System.IO.Path]::GetFullPath("\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy").TrimEnd("\", "/")
$productionSigningKeyId = 'revagent-prod-rsa-2026q3'
$productionSigningFingerprint = '32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33'

if ($AllowTestRoot) {
    $temporaryRootPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
    if ($NasReleaseRoot.StartsWith("\\", [System.StringComparison]::Ordinal) -or
        -not $NasReleaseRoot.StartsWith($temporaryRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "AllowTestRoot is limited to disposable local fixtures below the current TEMP directory."
    }
}
elseif (-not [string]::Equals($NasReleaseRoot.TrimEnd("\", "/"), $canonicalProductionReleaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "NasReleaseRoot must exactly match the canonical production root '$canonicalProductionReleaseRoot'. Pass -AllowTestRoot only for disposable local fixtures."
}
if (($null -ne $TestBeforeStablePromotionHook -or
        $null -ne $TestAfterSourceReadinessHook -or
        $null -ne $TestAfterSourceRoutingReadHook -or
        $null -ne $TestAfterBaselineReadinessHook -or
        $null -ne $TestAfterSignatureWriteHook -or
        $null -ne $TestBeforeNewPairCreateHook -or
        $null -ne $TestBeforePilotImmutableFinalVerificationHook) -and -not $AllowTestRoot) {
    throw "Publisher test hooks are limited to disposable -AllowTestRoot fixtures."
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceChannelSha256) -and $ExpectedSourceChannelSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'ExpectedSourceChannelSha256 must be one exact SHA-256 value.'
}
if (-not $AllowTestRoot -and [string]::IsNullOrWhiteSpace($ExpectedSourceChannelSha256)) {
    throw 'Production publish requires ExpectedSourceChannelSha256 from the exact downloaded workflow artifact handoff.'
}
if (-not ("RevAgent.SignedTransportNativeFileInfo" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public sealed class SignedTransportFileIdentity {
        public uint VolumeSerialNumber { get; set; }
        public ulong FileIndex { get; set; }
        public uint NumberOfLinks { get; set; }
        public uint FileAttributes { get; set; }

        public string StableId {
            get { return VolumeSerialNumber.ToString("X8") + ":" + FileIndex.ToString("X16"); }
        }
    }

    public static class SignedTransportNativeFileInfo {
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
            SafeFileHandle handle,
            out BY_HANDLE_FILE_INFORMATION information);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [StructLayout(LayoutKind.Sequential)]
        private struct UNICODE_STRING {
            public ushort Length;
            public ushort MaximumLength;
            public IntPtr Buffer;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct OBJECT_ATTRIBUTES {
            public int Length;
            public IntPtr RootDirectory;
            public IntPtr ObjectName;
            public uint Attributes;
            public IntPtr SecurityDescriptor;
            public IntPtr SecurityQualityOfService;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_STATUS_BLOCK {
            public IntPtr Status;
            public UIntPtr Information;
        }

        [DllImport("ntdll.dll")]
        private static extern int NtCreateFile(
            out SafeFileHandle fileHandle,
            uint desiredAccess,
            ref OBJECT_ATTRIBUTES objectAttributes,
            out IO_STATUS_BLOCK ioStatusBlock,
            IntPtr allocationSize,
            uint fileAttributes,
            uint shareAccess,
            uint createDisposition,
            uint createOptions,
            IntPtr eaBuffer,
            uint eaLength);

        [DllImport("ntdll.dll")]
        private static extern uint RtlNtStatusToDosError(int status);

        private const uint FILE_READ_ATTRIBUTES = 0x0080;
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint DELETE = 0x00010000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint CREATE_NEW = 1;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint OBJ_CASE_INSENSITIVE = 0x00000040;
        private const uint FILE_CREATE = 2;
        private const uint FILE_DIRECTORY_FILE = 0x00000001;
        private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
        private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;

        private enum FILE_INFO_BY_HANDLE_CLASS {
            FileBasicInfo = 0,
            FileStandardInfo = 1,
            FileNameInfo = 2,
            FileRenameInfo = 3,
            FileDispositionInfo = 4
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_DISPOSITION_INFO {
            [MarshalAs(UnmanagedType.Bool)]
            public bool DeleteFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(
            SafeFileHandle handle,
            FILE_INFO_BY_HANDLE_CLASS fileInformationClass,
            ref FILE_DISPOSITION_INFO fileInformation,
            uint bufferSize);

        public static SafeFileHandle OpenDirectoryNoDelete(string path) {
            SafeFileHandle handle = CreateFileW(
                path,
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Could not open no-delete directory guard: " + path);
            }
            return handle;
        }

        public static SafeFileHandle CreateDirectoryRelativeNoDelete(SafeFileHandle parentHandle, string leafName) {
            if (String.IsNullOrWhiteSpace(leafName) || leafName.IndexOfAny(new[] { '\\', '/', ':' }) >= 0 || leafName == "." || leafName == "..") {
                throw new ArgumentException("Directory leaf name is invalid.", "leafName");
            }
            IntPtr textBuffer = IntPtr.Zero;
            IntPtr unicodeBuffer = IntPtr.Zero;
            try {
                textBuffer = Marshal.StringToHGlobalUni(leafName);
                UNICODE_STRING name = new UNICODE_STRING {
                    Length = checked((ushort)(leafName.Length * 2)),
                    MaximumLength = checked((ushort)((leafName.Length + 1) * 2)),
                    Buffer = textBuffer
                };
                unicodeBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
                Marshal.StructureToPtr(name, unicodeBuffer, false);
                OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES {
                    Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
                    RootDirectory = parentHandle.DangerousGetHandle(),
                    ObjectName = unicodeBuffer,
                    Attributes = OBJ_CASE_INSENSITIVE,
                    SecurityDescriptor = IntPtr.Zero,
                    SecurityQualityOfService = IntPtr.Zero
                };
                IO_STATUS_BLOCK statusBlock;
                SafeFileHandle result;
                int status = NtCreateFile(
                    out result,
                    FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
                    ref attributes,
                    out statusBlock,
                    IntPtr.Zero,
                    0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    FILE_CREATE,
                    FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
                    IntPtr.Zero,
                    0);
                if (status < 0 || result == null || result.IsInvalid) {
                    uint error = RtlNtStatusToDosError(status);
                    if (result != null) { result.Dispose(); }
                    throw new Win32Exception(unchecked((int)error), "Could not atomically create exact destination directory relative to its held parent: " + leafName);
                }
                return result;
            }
            finally {
                if (unicodeBuffer != IntPtr.Zero) { Marshal.FreeHGlobal(unicodeBuffer); }
                if (textBuffer != IntPtr.Zero) { Marshal.FreeHGlobal(textBuffer); }
            }
        }

        public static SafeFileHandle OpenFileNoDeleteReadWrite(string path) {
            SafeFileHandle handle = CreateFileW(
                path,
                GENERIC_READ | GENERIC_WRITE | DELETE,
                FILE_SHARE_READ,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Could not open no-delete file guard: " + path);
            }
            return handle;
        }

        public static SafeFileHandle OpenFileNoDeleteReadOnly(string path) {
            SafeFileHandle handle = CreateFileW(
                path,
                GENERIC_READ,
                FILE_SHARE_READ,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Could not open exact read-only file guard: " + path);
            }
            return handle;
        }

        public static SafeFileHandle CreateNewFileNoDelete(string path) {
            SafeFileHandle handle = CreateFileW(
                path,
                GENERIC_READ | GENERIC_WRITE | DELETE,
                FILE_SHARE_READ,
                IntPtr.Zero,
                CREATE_NEW,
                FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Could not create exact no-delete file: " + path);
            }
            return handle;
        }

        public static void MarkDeleteOnClose(SafeFileHandle handle) {
            FILE_DISPOSITION_INFO information = new FILE_DISPOSITION_INFO { DeleteFile = true };
            if (!SetFileInformationByHandle(
                    handle,
                    FILE_INFO_BY_HANDLE_CLASS.FileDispositionInfo,
                    ref information,
                    (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO)))) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not mark exact file handle for deletion.");
            }
        }

        public static SignedTransportFileIdentity GetIdentity(SafeFileHandle handle) {
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return new SignedTransportFileIdentity {
                VolumeSerialNumber = information.VolumeSerialNumber,
                FileIndex = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow,
                NumberOfLinks = information.NumberOfLinks,
                FileAttributes = information.FileAttributes
            };
        }

        public static uint GetLinkCount(string path) {
            using (var stream = new System.IO.FileStream(
                path,
                System.IO.FileMode.Open,
                System.IO.FileAccess.Read,
                System.IO.FileShare.ReadWrite | System.IO.FileShare.Delete)) {
                BY_HANDLE_FILE_INFORMATION information;
                if (!GetFileInformationByHandle(stream.SafeFileHandle, out information)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return information.NumberOfLinks;
            }
        }
    }
}
'@
}

function Get-RevAgentStreamSha256 {
    param([Parameter(Mandatory = $true)][IO.Stream]$Stream)

    $position = $Stream.Position
    try {
        $Stream.Position = 0
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-', '') }
        finally { $sha.Dispose() }
    }
    finally { $Stream.Position = $position }
}

function Get-RevAgentBytesSha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '') }
    finally { $sha.Dispose() }
}

function Assert-RevAgentExactFileHandleIdentity {
    param(
        [Parameter(Mandatory = $true)][Microsoft.Win32.SafeHandles.SafeFileHandle]$Handle,
        [object]$ExpectedIdentity = $null,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $identity = [RevAgent.SignedTransportNativeFileInfo]::GetIdentity($Handle)
    if (($identity.FileAttributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0 -or $identity.NumberOfLinks -ne 1) {
        throw "$Label exact handle is reparse-backed or has a non-unit hardlink count. links=$($identity.NumberOfLinks)"
    }
    if ($null -ne $ExpectedIdentity -and
        (-not [string]::Equals([string]$identity.StableId, [string]$ExpectedIdentity.StableId, [StringComparison]::Ordinal) -or
            $identity.VolumeSerialNumber -ne $ExpectedIdentity.VolumeSerialNumber -or
            $identity.FileIndex -ne $ExpectedIdentity.FileIndex)) {
        throw "$Label exact handle identity changed during mutation."
    }
    return $identity
}

function Read-RevAgentStreamBytes {
    param(
        [Parameter(Mandatory = $true)][IO.Stream]$Stream,
        [int]$MaxBytes = 8388608
    )

    if ($Stream.Length -lt 0 -or $Stream.Length -gt $MaxBytes) {
        throw "Signed transport metadata exceeds the bounded $MaxBytes-byte policy. size=$($Stream.Length)"
    }
    $position = $Stream.Position
    try {
        $Stream.Position = 0
        $bytes = New-Object byte[] ([int]$Stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $Stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw 'Signed transport metadata ended before its handle-declared length.' }
            $offset += $read
        }
        return ,$bytes
    }
    finally { $Stream.Position = $position }
}

function ConvertFrom-RevAgentUtf8JsonBytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    return $text | ConvertFrom-Json
}

function Set-RevAgentStreamBytesVerified {
    param(
        [Parameter(Mandatory = $true)][IO.FileStream]$Stream,
        [Parameter(Mandatory = $true)][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $identityBefore = Assert-RevAgentExactFileHandleIdentity -Handle $Stream.SafeFileHandle -Label "$Label before write"
    $Stream.Position = 0
    $Stream.SetLength(0)
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
    if ($Stream.Length -ne $Bytes.Length) { throw "$Label same-handle length verification failed." }
    $actualHash = Get-RevAgentStreamSha256 -Stream $Stream
    if (-not [string]::Equals($actualHash, $ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label same-handle SHA-256 verification failed. expected=$ExpectedSha256 actual=$actualHash"
    }
    [void](Assert-RevAgentExactFileHandleIdentity -Handle $Stream.SafeFileHandle -ExpectedIdentity $identityBefore -Label "$Label after write")
    return $actualHash
}

function Restore-RevAgentStreamBytesByStableHandle {
    param(
        [Parameter(Mandatory = $true)][IO.FileStream]$Stream,
        [Parameter(Mandatory = $true)][object]$ExpectedIdentity,
        [Parameter(Mandatory = $true)][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $before = [RevAgent.SignedTransportNativeFileInfo]::GetIdentity($Stream.SafeFileHandle)
    if (($before.FileAttributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not [string]::Equals([string]$before.StableId, [string]$ExpectedIdentity.StableId, [StringComparison]::Ordinal)) {
        throw "$Label cannot restore because the held native identity changed."
    }
    $Stream.Position = 0
    $Stream.SetLength(0)
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
    $actualHash = Get-RevAgentStreamSha256 -Stream $Stream
    $after = [RevAgent.SignedTransportNativeFileInfo]::GetIdentity($Stream.SafeFileHandle)
    if (-not [string]::Equals($actualHash, $ExpectedSha256, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$after.StableId, [string]$ExpectedIdentity.StableId, [StringComparison]::Ordinal)) {
        throw "$Label exact stable-handle rollback verification failed."
    }
    return [pscustomobject][ordered]@{
        restored = $true
        sha256 = $actualHash
        linkCountBefore = [uint32]$before.NumberOfLinks
        linkCountAfter = [uint32]$after.NumberOfLinks
        hardlinkAnomaly = ($before.NumberOfLinks -ne 1 -or $after.NumberOfLinks -ne 1)
    }
}

function Enter-RevAgentDirectoryNoDeleteGuard {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label directory was not found: $Path" }
    $handle = [RevAgent.SignedTransportNativeFileInfo]::OpenDirectoryNoDelete([IO.Path]::GetFullPath($Path))
    try {
        $identity = [RevAgent.SignedTransportNativeFileInfo]::GetIdentity($handle)
        if (($identity.FileAttributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label directory is a reparse point: $Path"
        }
        return [pscustomobject][ordered]@{ path = [IO.Path]::GetFullPath($Path); label = $Label; handle = $handle; identity = $identity }
    }
    catch {
        $handle.Dispose()
        throw
    }
}

function Enter-RevAgentReadOnlyTreeGuard {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Label)

    $fullRoot = [IO.Path]::GetFullPath($Root)
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) { throw "$Label tree was not found: $fullRoot" }
    $guards = [Collections.Generic.List[object]]::new()
    try {
        $directories = @((Get-Item -LiteralPath $fullRoot -Force)) + @(Get-ChildItem -LiteralPath $fullRoot -Directory -Recurse -Force | Sort-Object FullName)
        foreach ($directory in $directories) {
            if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$directory.LinkType)) {
                throw "$Label tree contains a directory link: $($directory.FullName)"
            }
            [void]$guards.Add((Enter-RevAgentDirectoryNoDeleteGuard -Path $directory.FullName -Label $Label))
        }
        foreach ($file in @(Get-ChildItem -LiteralPath $fullRoot -File -Recurse -Force | Sort-Object FullName)) {
            if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$file.LinkType)) {
                throw "$Label tree contains a file link: $($file.FullName)"
            }
            $fileGuard = New-RevAgentGuardedFileStream -Path $file.FullName -ReadOnly
            $stream = $fileGuard.stream
            try {
                [void]$guards.Add([pscustomobject][ordered]@{ path = $file.FullName; label = $Label; stream = $stream; identity = $fileGuard.identity })
                $stream = $null
            }
            finally { if ($null -ne $stream) { $stream.Dispose() } }
        }
        # Emit individual guard objects. Every caller captures with @(...);
        # preserving the whole array as one object would bypass cleanup and
        # make final identity verification see an unsupported nested guard.
        return @($guards.ToArray())
    }
    catch {
        $guardArray = @($guards.ToArray())
        for ($index = $guardArray.Count - 1; $index -ge 0; $index--) {
            $guard = $guardArray[$index]
            if ($guard.PSObject.Properties['stream']) { $guard.stream.Dispose() }
            elseif ($guard.PSObject.Properties['handle']) { $guard.handle.Dispose() }
        }
        throw
    }
}

function Exit-RevAgentGuards {
    param([object[]]$Guards)

    $guardArray = @($Guards)
    for ($index = $guardArray.Count - 1; $index -ge 0; $index--) {
        $guard = $guardArray[$index]
        if ($null -eq $guard) { continue }
        try {
            if ($guard.PSObject.Properties['stream']) { $guard.stream.Dispose() }
            elseif ($guard.PSObject.Properties['handle']) { $guard.handle.Dispose() }
        }
        catch { Write-Warning "Signed transport guard cleanup failed for '$($guard.path)': $($_.Exception.Message)" }
    }
}

function Assert-RevAgentGuardSetIntact {
    param(
        [Parameter(Mandatory = $true)][object[]]$Guards,
        [Parameter(Mandatory = $true)][string]$Label
    )

    foreach ($guard in @($Guards)) {
        if ($null -eq $guard) { continue }
        if ($guard.PSObject.Properties['stream']) {
            [void](Assert-RevAgentExactFileHandleIdentity `
                -Handle $guard.stream.SafeFileHandle `
                -ExpectedIdentity $guard.identity `
                -Label "$Label file '$($guard.path)'")
            continue
        }
        if ($guard.PSObject.Properties['handle']) {
            $currentIdentity = [RevAgent.SignedTransportNativeFileInfo]::GetIdentity($guard.handle)
            if (($currentIdentity.FileAttributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0 -or
                -not [string]::Equals([string]$currentIdentity.StableId, [string]$guard.identity.StableId, [StringComparison]::Ordinal) -or
                $currentIdentity.VolumeSerialNumber -ne $guard.identity.VolumeSerialNumber -or
                $currentIdentity.FileIndex -ne $guard.identity.FileIndex) {
                throw "$Label directory handle identity changed or became reparse-backed: $($guard.path)"
            }
            continue
        }
        throw "$Label contains an unsupported guard object."
    }
    return $true
}

function Assert-RevAgentOwnedTreeIntact {
    param(
        [Parameter(Mandatory = $true)][object]$Tree,
        [Parameter(Mandatory = $true)][string]$Label
    )

    [void](Assert-RevAgentGuardSetIntact -Guards @($Tree.files) -Label $Label)
    [void](Assert-RevAgentGuardSetIntact -Guards @($Tree.directories) -Label $Label)
    [void](Assert-RevAgentGuardSetIntact -Guards @($Tree.supportGuards) -Label $Label)
    return $true
}

function Get-RevAgentOwnedTreeDigest {
    param(
        [Parameter(Mandatory = $true)][object]$Tree,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $root = [IO.Path]::GetFullPath([string]$Tree.destination).TrimEnd('\')
    $prefixLength = $root.Length + 1
    $ownedFiles = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($guard in @($Tree.files)) { $ownedFiles.Add([IO.Path]::GetFullPath([string]$guard.path), $guard) }
    $ownedDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($guard in @($Tree.directories)) {
        $path = [IO.Path]::GetFullPath([string]$guard.path).TrimEnd('\')
        if (-not [string]::Equals($path, $root, [StringComparison]::OrdinalIgnoreCase)) { [void]$ownedDirectories.Add($path) }
    }

    $actualDirectories = @(Get-ChildItem -LiteralPath $root -Directory -Recurse -Force | Sort-Object { $_.FullName.Length }, FullName)
    $actualFiles = @(Get-ChildItem -LiteralPath $root -File -Recurse -Force | Sort-Object FullName)
    if ($actualDirectories.Count -ne $ownedDirectories.Count -or $actualFiles.Count -ne $ownedFiles.Count) {
        throw "$Label path inventory changed while exact handles were held. expectedDirectories=$($ownedDirectories.Count) actualDirectories=$($actualDirectories.Count) expectedFiles=$($ownedFiles.Count) actualFiles=$($actualFiles.Count)"
    }

    $rows = [Collections.Generic.List[string]]::new()
    foreach ($directory in $actualDirectories) {
        $fullPath = [IO.Path]::GetFullPath($directory.FullName).TrimEnd('\')
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not [string]::IsNullOrWhiteSpace([string]$directory.LinkType) -or
            -not $ownedDirectories.Contains($fullPath)) {
            throw "$Label contains an unexpected or linked directory: $fullPath"
        }
        [void]$rows.Add(("D`t{0}" -f $fullPath.Substring($prefixLength).Replace('\', '/')))
    }
    foreach ($file in $actualFiles) {
        $fullPath = [IO.Path]::GetFullPath($file.FullName)
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not [string]::IsNullOrWhiteSpace([string]$file.LinkType) -or
            -not $ownedFiles.ContainsKey($fullPath)) {
            throw "$Label contains an unexpected or linked file: $fullPath"
        }
        $guard = $ownedFiles[$fullPath]
        [void](Assert-RevAgentExactFileHandleIdentity -Handle $guard.stream.SafeFileHandle -ExpectedIdentity $guard.identity -Label "$Label file '$fullPath'")
        $hash = Get-RevAgentStreamSha256 -Stream $guard.stream
        [void]$rows.Add(("F`t{0}`t{1}`t{2}" -f $fullPath.Substring($prefixLength).Replace('\', '/'), [long]$guard.stream.Length, $hash))
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($rows -join "`n"))
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '') }
    finally { $algorithm.Dispose() }
    return [pscustomobject][ordered]@{ exists = $true; fileCount = $actualFiles.Count; directoryCount = $actualDirectories.Count; sha256 = $digest; handleBound = $true }
}

function New-RevAgentOwnedDirectoryGuard {
    param(
        [Parameter(Mandatory = $true)][object]$ParentGuard,
        [Parameter(Mandatory = $true)][string]$LeafName,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    $expectedPath = [IO.Path]::GetFullPath((Join-Path ([string]$ParentGuard.path) $LeafName))
    if (-not [string]::Equals($fullPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label relative directory path binding failed. expected=$expectedPath actual=$fullPath"
    }
    $handle = [RevAgent.SignedTransportNativeFileInfo]::CreateDirectoryRelativeNoDelete($ParentGuard.handle, $LeafName)
    try {
        $identity = [RevAgent.SignedTransportNativeFileInfo]::GetIdentity($handle)
        if (($identity.FileAttributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label created directory resolved as a reparse point: $fullPath"
        }
        return [pscustomobject][ordered]@{ path = $fullPath; label = $Label; handle = $handle; identity = $identity; owned = $true }
    }
    catch {
        try { [RevAgent.SignedTransportNativeFileInfo]::MarkDeleteOnClose($handle) } catch {}
        $handle.Dispose()
        throw
    }
}

function Close-RevAgentOwnedTree {
    param([Parameter(Mandatory = $true)][object]$Tree, [switch]$Delete)

    $errors = [Collections.Generic.List[string]]::new()
    foreach ($file in @($Tree.files)) {
        try {
            [void](Assert-RevAgentExactFileHandleIdentity -Handle $file.stream.SafeFileHandle -ExpectedIdentity $file.identity -Label 'owned tree file cleanup')
            if ($Delete) { [RevAgent.SignedTransportNativeFileInfo]::MarkDeleteOnClose($file.stream.SafeFileHandle) }
        }
        catch { [void]$errors.Add("file disposition failed: $($file.path): $($_.Exception.Message)") }
        finally { try { $file.stream.Dispose() } catch { [void]$errors.Add("file close failed: $($file.path): $($_.Exception.Message)") } }
    }
    $directories = @($Tree.directories | Sort-Object { $_.path.Length } -Descending)
    foreach ($directory in $directories) {
        try {
            $currentIdentity = [RevAgent.SignedTransportNativeFileInfo]::GetIdentity($directory.handle)
            if (($currentIdentity.FileAttributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0 -or
                -not [string]::Equals([string]$currentIdentity.StableId, [string]$directory.identity.StableId, [StringComparison]::Ordinal)) {
                throw 'owned tree directory handle identity changed before cleanup'
            }
            if ($Delete) { [RevAgent.SignedTransportNativeFileInfo]::MarkDeleteOnClose($directory.handle) }
        }
        catch { [void]$errors.Add("directory disposition failed: $($directory.path): $($_.Exception.Message)") }
        finally { try { $directory.handle.Dispose() } catch { [void]$errors.Add("directory close failed: $($directory.path): $($_.Exception.Message)") } }
    }
    Exit-RevAgentGuards -Guards @($Tree.supportGuards)
    if ($errors.Count -gt 0) {
        throw "Exact owned-tree cleanup was incomplete; manual recovery is required. $($errors -join ' | ')"
    }
}

function Copy-RevAgentDirectoryCreateNewGuarded {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd('\')
    $destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
    Assert-RevAgentChildPath -Path $destinationRoot -Root $Root
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw "$Label source was not found: $sourceRoot" }
    if (Test-Path -LiteralPath $destinationRoot) { throw "$Label target already exists: $destinationRoot" }

    $ownedDirectories = [Collections.Generic.List[object]]::new()
    $ownedFiles = [Collections.Generic.List[object]]::new()
    $supportGuards = [Collections.Generic.List[object]]::new()
    $directoryMap = @{}
    $rows = [Collections.Generic.List[string]]::new()
    $fileCount = 0
    $directoryCount = 0
    $result = $null
    try {
        $destinationParent = Split-Path -Parent $destinationRoot
        $rootLeaf = Split-Path -Leaf $destinationRoot
        $destinationParentGuard = Enter-RevAgentDirectoryNoDeleteGuard -Path $destinationParent -Label "$Label parent"
        [void]$supportGuards.Add($destinationParentGuard)
        $rootOwnedGuard = New-RevAgentOwnedDirectoryGuard -ParentGuard $destinationParentGuard -LeafName $rootLeaf -Path $destinationRoot -Label $Label
        [void]$ownedDirectories.Add($rootOwnedGuard)
        $directoryMap[$destinationRoot.ToUpperInvariant()] = $rootOwnedGuard
        foreach ($sourceDirectory in @(Get-ChildItem -LiteralPath $sourceRoot -Directory -Recurse -Force | Sort-Object { $_.FullName.Length }, FullName)) {
            if (($sourceDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$sourceDirectory.LinkType)) {
                throw "$Label source contains a directory link: $($sourceDirectory.FullName)"
            }
            $relative = $sourceDirectory.FullName.Substring($sourceRoot.Length).TrimStart('\')
            $destinationDirectory = [IO.Path]::GetFullPath((Join-Path $destinationRoot $relative))
            $destinationParentPath = [IO.Path]::GetFullPath((Split-Path -Parent $destinationDirectory))
            $parentOwnedGuard = $directoryMap[$destinationParentPath.ToUpperInvariant()]
            if ($null -eq $parentOwnedGuard) { throw "$Label parent directory handle is missing for: $destinationDirectory" }
            $ownedGuard = New-RevAgentOwnedDirectoryGuard -ParentGuard $parentOwnedGuard -LeafName (Split-Path -Leaf $destinationDirectory) -Path $destinationDirectory -Label $Label
            [void]$ownedDirectories.Add($ownedGuard)
            $directoryMap[$destinationDirectory.ToUpperInvariant()] = $ownedGuard
            [void]$rows.Add(("D`t{0}" -f $relative.Replace('\', '/')))
            $directoryCount++
        }
        foreach ($sourceFile in @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force | Sort-Object FullName)) {
            $relative = $sourceFile.FullName.Substring($sourceRoot.Length).TrimStart('\')
            $destinationFile = Join-Path $destinationRoot $relative
            $sourceGuard = New-RevAgentGuardedFileStream -Path $sourceFile.FullName -ReadOnly
            $destinationGuard = $null
            try {
                $destinationGuard = New-RevAgentGuardedFileStream -Path $destinationFile -CreateNew
                $sourceGuard.stream.Position = 0
                $destinationGuard.stream.Position = 0
                $buffer = New-Object byte[] 1048576
                while (($read = $sourceGuard.stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $destinationGuard.stream.Write($buffer, 0, $read)
                }
                $destinationGuard.stream.Flush($true)
                $sourceHash = Get-RevAgentStreamSha256 -Stream $sourceGuard.stream
                $destinationHash = Get-RevAgentStreamSha256 -Stream $destinationGuard.stream
                if ($sourceGuard.stream.Length -ne $destinationGuard.stream.Length -or
                    -not [string]::Equals($sourceHash, $destinationHash, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "$Label handle-bound copy verification failed: $relative"
                }
                [void]$rows.Add(("F`t{0}`t{1}`t{2}" -f $relative.Replace('\', '/'), [long]$destinationGuard.stream.Length, $destinationHash))
                $fileCount++
                [void]$ownedFiles.Add($destinationGuard)
                $destinationGuard = $null
            }
            finally {
                $sourceGuard.stream.Dispose()
                if ($null -ne $destinationGuard) {
                    try { [RevAgent.SignedTransportNativeFileInfo]::MarkDeleteOnClose($destinationGuard.stream.SafeFileHandle) } catch {}
                    $destinationGuard.stream.Dispose()
                }
            }
        }
        $treeBytes = [Text.Encoding]::UTF8.GetBytes(($rows -join "`n"))
        $treeSha = [Security.Cryptography.SHA256]::Create()
        try { $treeHash = ([BitConverter]::ToString($treeSha.ComputeHash($treeBytes))).Replace('-', '') }
        finally { $treeSha.Dispose() }
        $result = [pscustomobject][ordered]@{
            source = $sourceRoot
            destination = $destinationRoot
            fileCount = $fileCount
            directoryCount = $directoryCount
            sha256 = $treeHash
            directories = @($ownedDirectories.ToArray())
            files = @($ownedFiles.ToArray())
            supportGuards = @($supportGuards.ToArray())
            exactCreateNew = $true
            handlesHeld = $true
        }
        return $result
    }
    catch {
        $copyError = $_
        $failedTree = [pscustomobject]@{ directories = @($ownedDirectories.ToArray()); files = @($ownedFiles.ToArray()); supportGuards = @($supportGuards.ToArray()) }
        try { Close-RevAgentOwnedTree -Tree $failedTree -Delete }
        catch { throw "${Label} failed and exact cleanup also failed. original=$($copyError.Exception.Message) cleanup=$($_.Exception.Message)" }
        throw $copyError
    }
}

function New-RevAgentGuardedFileStream {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$CreateNew,
        [switch]$ReadOnly
    )

    if ($CreateNew -and $ReadOnly) { throw 'CreateNew and ReadOnly are mutually exclusive.' }
    $handle = if ($CreateNew) {
        [RevAgent.SignedTransportNativeFileInfo]::CreateNewFileNoDelete([IO.Path]::GetFullPath($Path))
    }
    elseif ($ReadOnly) {
        [RevAgent.SignedTransportNativeFileInfo]::OpenFileNoDeleteReadOnly([IO.Path]::GetFullPath($Path))
    }
    else {
        [RevAgent.SignedTransportNativeFileInfo]::OpenFileNoDeleteReadWrite([IO.Path]::GetFullPath($Path))
    }
    try {
        $access = if ($ReadOnly) { [IO.FileAccess]::Read } else { [IO.FileAccess]::ReadWrite }
        $stream = [IO.FileStream]::new($handle, $access, 4096, $false)
        $identity = [RevAgent.SignedTransportNativeFileInfo]::GetIdentity($stream.SafeFileHandle)
        if (($identity.FileAttributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0 -or $identity.NumberOfLinks -ne 1) {
            throw "Signed channel metadata must be a non-reparse file with exactly one hardlink: $Path"
        }
        return [pscustomobject][ordered]@{ path = [IO.Path]::GetFullPath($Path); stream = $stream; identity = $identity; created = [bool]$CreateNew }
    }
    catch {
        if ($null -ne $stream) { $stream.Dispose() } else { $handle.Dispose() }
        throw
    }
}

function Get-RevAgentStableLauncherBytes {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot)

    $releaseRootFullPath = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\', '/')
    $lines = @(
        '@echo off',
        'setlocal',
        '',
        'set "POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"',
        ('set "RELEASE_ROOT={0}"' -f $releaseRootFullPath),
        'set "BOOTSTRAP=%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1"',
        'set "CHANNEL=%RELEASE_ROOT%\channels\stable.json"',
        'set "REFRESH=%RELEASE_ROOT%\tools\Refresh-revAgent-LocalBootstrap-STABLE.cmd"',
        '',
        'if not exist "%CHANNEL%" (',
        '  echo revAgent stable channel manifest was not found:',
        '  echo %CHANNEL%',
        '  pause',
        '  exit /b 1',
        ')',
        '',
        'if not exist "%BOOTSTRAP%" (',
        '  echo revAgent stable updater needs to install the protected local bootstrap first.',
        '  if not exist "%REFRESH%" (',
        '    echo revAgent stable bootstrap install tool was not found:',
        '    echo %REFRESH%',
        '    pause',
        '    exit /b 1',
        '  )',
        '  call "%REFRESH%"',
        '  if errorlevel 1 (',
        '    echo.',
        '    echo revAgent stable bootstrap install did not complete.',
        '    pause',
        '    exit /b 1',
        '  )',
        '  if not exist "%BOOTSTRAP%" (',
        '    echo.',
        '    echo revAgent stable bootstrap install returned without creating the protected local bootstrap:',
        '    echo %BOOTSTRAP%',
        '    echo If an administrator approval or bootstrap coordinator window is still open, finish it and run this updater again.',
        '    pause',
        '    exit /b 1',
        '  )',
        '  echo.',
        '  echo revAgent stable bootstrap install completed. The updater should open now.',
        '  exit /b 0',
        ')',
        '',
        '"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -ChannelManifestPath "%CHANNEL%" -VerificationOnly >nul 2>nul',
        'if errorlevel 1 (',
        '  echo.',
        '  echo revAgent stable updater needs to refresh the protected local bootstrap for this release.',
        '  if not exist "%REFRESH%" (',
        '    echo revAgent stable bootstrap refresh tool was not found:',
        '    echo %REFRESH%',
        '    pause',
        '    exit /b 1',
        '  )',
        '  call "%REFRESH%"',
        '  if errorlevel 1 (',
        '    echo.',
        '    echo revAgent stable bootstrap refresh did not complete.',
        '    pause',
        '    exit /b 1',
        '  )',
        '  if not exist "%BOOTSTRAP%" (',
        '    echo.',
        '    echo revAgent stable bootstrap refresh returned without creating the protected local bootstrap:',
        '    echo %BOOTSTRAP%',
        '    echo If an administrator approval or bootstrap coordinator window is still open, finish it and run this updater again.',
        '    pause',
        '    exit /b 1',
        '  )',
        '  echo.',
        '  echo revAgent stable bootstrap refresh completed. The updater should open now.',
        '  exit /b 0',
        ')',
        '',
        'start "revAgent Stable" "%POWERSHELL%" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -ChannelManifestPath "%CHANNEL%"',
        'exit /b 0'
    )
    return [Text.Encoding]::ASCII.GetBytes(($lines -join "`r`n") + "`r`n")
}

function Set-RevAgentStableLauncherExact {
    param(
        [Parameter(Mandatory = $true)][string]$ToolsRoot,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot
    )

    $launcherPath = [IO.Path]::GetFullPath((Join-Path $ToolsRoot 'revAgent Updater STABLE.cmd'))
    Assert-RevAgentChildPath -Path $launcherPath -Root $ReleaseRoot
    $launcherBytes = Get-RevAgentStableLauncherBytes -ReleaseRoot $ReleaseRoot
    $launcherSha256 = Get-RevAgentBytesSha256 -Bytes $launcherBytes
    $created = -not (Test-Path -LiteralPath $launcherPath -PathType Leaf)
    $guard = if ($created) {
        New-RevAgentGuardedFileStream -Path $launcherPath -CreateNew
    }
    else {
        New-RevAgentGuardedFileStream -Path $launcherPath
    }
    try {
        $baselineBytes = Read-RevAgentStreamBytes -Stream $guard.stream -MaxBytes 65536
        $baselineSha256 = Get-RevAgentBytesSha256 -Bytes $baselineBytes
        $writtenSha256 = Set-RevAgentStreamBytesVerified `
            -Stream $guard.stream `
            -Bytes $launcherBytes `
            -ExpectedSha256 $launcherSha256 `
            -Label 'stable updater launcher'
        return [pscustomobject][ordered]@{
            path = $launcherPath
            created = $created
            changed = (-not [string]::Equals($baselineSha256, $writtenSha256, [StringComparison]::OrdinalIgnoreCase))
            baselineBytes = $baselineBytes
            baselineSha256 = $baselineSha256
            sha256 = $writtenSha256
            stream = $guard.stream
            identity = $guard.identity
        }
    }
    catch {
        if ($null -ne $guard) {
            try { $guard.stream.Dispose() } catch {}
        }
        throw
    }
}

function Set-RevAgentStableToolFileExact {
    param(
        [Parameter(Mandatory = $true)][string]$ToolsRoot,
        [Parameter(Mandatory = $true)][string]$ToolName,
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot
    )

    $toolPath = [IO.Path]::GetFullPath((Join-Path $ToolsRoot $ToolName))
    Assert-RevAgentChildPath -Path $toolPath -Root $ReleaseRoot
    $sourceFullPath = [IO.Path]::GetFullPath($SourcePath)
    if (-not (Test-Path -LiteralPath $sourceFullPath -PathType Leaf)) {
        throw "Stable bootstrap tool source was not found: $sourceFullPath"
    }
    $toolBytes = [IO.File]::ReadAllBytes($sourceFullPath)
    if ($toolBytes.Length -lt 1 -or $toolBytes.Length -gt 1048576) {
        throw "Stable bootstrap tool size is outside the bounded policy: $sourceFullPath size=$($toolBytes.Length)"
    }
    $toolSha256 = Get-RevAgentBytesSha256 -Bytes $toolBytes
    $created = -not (Test-Path -LiteralPath $toolPath -PathType Leaf)
    $guard = if ($created) {
        New-RevAgentGuardedFileStream -Path $toolPath -CreateNew
    }
    else {
        New-RevAgentGuardedFileStream -Path $toolPath
    }
    try {
        $baselineBytes = Read-RevAgentStreamBytes -Stream $guard.stream -MaxBytes 1048576
        $baselineSha256 = Get-RevAgentBytesSha256 -Bytes $baselineBytes
        $writtenSha256 = Set-RevAgentStreamBytesVerified `
            -Stream $guard.stream `
            -Bytes $toolBytes `
            -ExpectedSha256 $toolSha256 `
            -Label "stable bootstrap tool $ToolName"
        return [pscustomobject][ordered]@{
            path = $toolPath
            toolName = $ToolName
            created = $created
            changed = (-not [string]::Equals($baselineSha256, $writtenSha256, [StringComparison]::OrdinalIgnoreCase))
            baselineBytes = $baselineBytes
            baselineSha256 = $baselineSha256
            sha256 = $writtenSha256
            stream = $guard.stream
            identity = $guard.identity
        }
    }
    catch {
        if ($null -ne $guard) {
            try { $guard.stream.Dispose() } catch {}
        }
        throw
    }
}

function Set-RevAgentStableBootstrapToolsExact {
    param(
        [Parameter(Mandatory = $true)][string]$ToolsRoot,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot
    )

    $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $sourceNasRoot = Join-Path $repoRoot 'installer\nas'
    $updates = [Collections.Generic.List[object]]::new()
    foreach ($toolName in @('Refresh-revAgent-LocalBootstrap-STABLE.cmd', 'Refresh-revAgent-LocalBootstrap-STABLE.ps1', 'Revit MCP Updater STABLE.cmd')) {
        $updates.Add((Set-RevAgentStableToolFileExact `
                    -ToolsRoot $ToolsRoot `
                    -ToolName $toolName `
                    -SourcePath (Join-Path $sourceNasRoot $toolName) `
                    -ReleaseRoot $ReleaseRoot)) | Out-Null
    }
    return @($updates.ToArray())
}

function Enter-RevAgentChannelPairGuard {
    param(
        [Parameter(Mandatory = $true)][string]$ChannelPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [Parameter(Mandatory = $true)][object]$ExpectedIdentity,
        [switch]$ReadOnly
    )

    $channelExists = Test-Path -LiteralPath $ChannelPath -PathType Leaf
    $signatureExists = Test-Path -LiteralPath $SignaturePath -PathType Leaf
    if ($channelExists -ne $signatureExists) { throw 'Destination signed channel is a partial pair; refusing promotion.' }
    if ([bool]$ExpectedIdentity.exists -ne $channelExists) {
        throw "Destination signed channel existence changed after readiness. expected=$([bool]$ExpectedIdentity.exists) actual=$channelExists"
    }

    $channelGuard = $null
    $signatureGuard = $null
    try {
        if ($channelExists) {
            # Deterministic acquisition order avoids two compliant writers
            # deadlocking even when the cooperative lease is bypassed.
            $channelGuard = New-RevAgentGuardedFileStream -Path $ChannelPath -ReadOnly:$ReadOnly
            $signatureGuard = New-RevAgentGuardedFileStream -Path $SignaturePath -ReadOnly:$ReadOnly
        }
        else {
            if ($ReadOnly) { throw 'A read-only signed channel guard cannot create a missing pair.' }
            # Create both exact destination identities before writing either
            # document. CREATE_NEW turns an uncooperative new-pair race into a
            # fail-closed error without replacing the competing writer.
            $signatureGuard = New-RevAgentGuardedFileStream -Path $SignaturePath -CreateNew
            try { $channelGuard = New-RevAgentGuardedFileStream -Path $ChannelPath -CreateNew }
            catch {
                [RevAgent.SignedTransportNativeFileInfo]::MarkDeleteOnClose($signatureGuard.stream.SafeFileHandle)
                throw
            }
        }

        $channelBytes = Read-RevAgentStreamBytes -Stream $channelGuard.stream
        $signatureBytes = Read-RevAgentStreamBytes -Stream $signatureGuard.stream
        $channelHash = Get-RevAgentStreamSha256 -Stream $channelGuard.stream
        $signatureHash = Get-RevAgentStreamSha256 -Stream $signatureGuard.stream
        if ($channelExists) {
            if (-not [string]::Equals($channelHash, [string]$ExpectedIdentity.artifact.channelSha256, [StringComparison]::OrdinalIgnoreCase) -or
                -not [string]::Equals($signatureHash, [string]$ExpectedIdentity.artifact.channelSignatureSha256, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Destination signed channel changed between readiness and exact handle acquisition.'
            }
        }
        return [pscustomobject][ordered]@{
            existed = $channelExists
            channel = $channelGuard
            signature = $signatureGuard
            baselineChannelBytes = $channelBytes
            baselineSignatureBytes = $signatureBytes
            baselineChannelSha256 = $channelHash
            baselineSignatureSha256 = $signatureHash
        }
    }
    catch {
        if ($null -ne $signatureGuard) { $signatureGuard.stream.Dispose() }
        if ($null -ne $channelGuard) { $channelGuard.stream.Dispose() }
        throw
    }
}

function Remove-RevAgentCreatedChannelPairThroughHandles {
    param([Parameter(Mandatory = $true)][object]$PairGuard)

    if ([bool]$PairGuard.existed) { throw 'Handle-bound cleanup is only valid for a newly created channel pair.' }
    [void](Assert-RevAgentExactFileHandleIdentity -Handle $PairGuard.signature.stream.SafeFileHandle -ExpectedIdentity $PairGuard.signature.identity -Label 'created signature cleanup')
    [void](Assert-RevAgentExactFileHandleIdentity -Handle $PairGuard.channel.stream.SafeFileHandle -ExpectedIdentity $PairGuard.channel.identity -Label 'created channel cleanup')
    [RevAgent.SignedTransportNativeFileInfo]::MarkDeleteOnClose($PairGuard.signature.stream.SafeFileHandle)
    [RevAgent.SignedTransportNativeFileInfo]::MarkDeleteOnClose($PairGuard.channel.stream.SafeFileHandle)
}

function Get-RevAgentPathPrefix {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
}

function Assert-RevAgentChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = Get-RevAgentPathPrefix -Path $Root
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside the release root. Path '$fullPath' is not under '$Root'."
    }
}

function Invoke-RevAgentFileSystemRetry {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Label,
        [int]$MaxAttempts = 6
    )

    $delayMilliseconds = 250
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            & $Action
            return
        }
        catch {
            if ($attempt -ge $MaxAttempts) {
                throw
            }

            Write-Warning ("{0} failed on attempt {1}/{2}: {3}. Retrying." -f $Label, $attempt, $MaxAttempts, $_.Exception.Message)
            Start-Sleep -Milliseconds $delayMilliseconds
            $delayMilliseconds = [Math]::Min($delayMilliseconds * 2, 5000)
        }
    }
}

function Wait-RevAgentPathAbsent {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $delayMilliseconds = 250
    for ($attempt = 1; $attempt -le 8; $attempt++) {
        if (-not (Test-Path -LiteralPath $Path)) {
            return
        }

        Start-Sleep -Milliseconds $delayMilliseconds
        $delayMilliseconds = [Math]::Min($delayMilliseconds * 2, 5000)
    }

    throw "$Label was still present after removal: $Path"
}

function Remove-RevAgentDirectoryWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Assert-RevAgentChildPath -Path $Path -Root $Root
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    Invoke-RevAgentFileSystemRetry -Label "Remove $Label" -Action {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    }
    Wait-RevAgentPathAbsent -Path $Path -Label $Label
}

function Copy-RevAgentDirectoryExact {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$AllowReplace
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Required source directory was not found: $Source"
    }
    Assert-RevAgentChildPath -Path $Destination -Root $Root

    if (Test-Path -LiteralPath $Destination) {
        if (-not $AllowReplace) {
            throw "Target already exists: $Destination. Pass -Force to replace it."
        }
    }

    $destinationParent = Split-Path -Parent $Destination
    $destinationName = Split-Path -Leaf $Destination
    $stagePath = Join-Path $destinationParent (".{0}.copy-staging-{1}" -f $destinationName, [Guid]::NewGuid().ToString("N"))
    Assert-RevAgentChildPath -Path $stagePath -Root $Root

    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    try {
        Invoke-RevAgentFileSystemRetry -Label "Stage copy $destinationName" -Action {
            if (Test-Path -LiteralPath $stagePath) {
                Remove-Item -LiteralPath $stagePath -Recurse -Force -ErrorAction Stop
            }
            Copy-Item -LiteralPath $Source -Destination $stagePath -Recurse -Force -ErrorAction Stop
        }

        if (Test-Path -LiteralPath $Destination) {
            Remove-RevAgentDirectoryWithRetry -Path $Destination -Root $Root -Label $destinationName
        }

        Invoke-RevAgentFileSystemRetry -Label "Promote staged copy $destinationName" -Action {
            Move-Item -LiteralPath $stagePath -Destination $Destination -Force -ErrorAction Stop
        }
    }
    catch {
        if (Test-Path -LiteralPath $stagePath) {
            Remove-Item -LiteralPath $stagePath -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Backup-RevAgentDirectoryForRollback {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Backup,
        [Parameter(Mandatory = $true)][string]$Root
    )

    Assert-RevAgentChildPath -Path $Source -Root $Root
    Assert-RevAgentChildPath -Path $Backup -Root $Root
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        return $false
    }

    Copy-RevAgentDirectoryExact -Source $Source -Destination $Backup -Root $Root
    return $true
}

function Restore-RevAgentDirectoryFromRollback {
    param(
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Backup,
        [Parameter(Mandatory = $true)][string]$Root,
        [bool]$HadOriginal
    )

    Assert-RevAgentChildPath -Path $Destination -Root $Root
    Assert-RevAgentChildPath -Path $Backup -Root $Root
    if ($HadOriginal) {
        if (-not (Test-Path -LiteralPath $Backup -PathType Container)) {
            throw "Rollback backup was not found: $Backup"
        }
        Copy-RevAgentDirectoryExact -Source $Backup -Destination $Destination -Root $Root -AllowReplace
    }
    else {
        Remove-RevAgentDirectoryWithRetry -Path $Destination -Root $Root -Label (Split-Path -Leaf $Destination)
    }
}

function ConvertTo-RevAgentInt64OrZero {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return [long]0
    }

    $parsed = [long]0
    if ([long]::TryParse([string]$Value, [System.Globalization.NumberStyles]::Integer, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        return $parsed
    }

    return [long]0
}

function Get-RevAgentChannelReleaseSequenceStatus {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject][ordered]@{
            success = $false
            exists = $false
            value = [long]0
            reason = "not_found"
            message = "Channel manifest was not found."
        }
    }

    try {
        $channel = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        return [pscustomobject][ordered]@{
            success = $false
            exists = $true
            value = [long]0
            reason = "read_failed"
            message = $_.Exception.Message
        }
    }

    $sequenceProperty = $channel.PSObject.Properties["releaseSequence"]
    if ($null -eq $sequenceProperty -or $null -eq $sequenceProperty.Value -or [string]::IsNullOrWhiteSpace([string]$sequenceProperty.Value)) {
        return [pscustomobject][ordered]@{
            success = $false
            exists = $true
            value = [long]0
            reason = "missing_release_sequence"
            message = "Channel manifest does not contain releaseSequence."
        }
    }

    $parsed = [long]0
    if (-not [long]::TryParse([string]$sequenceProperty.Value, [System.Globalization.NumberStyles]::Integer, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        return [pscustomobject][ordered]@{
            success = $false
            exists = $true
            value = [long]0
            reason = "invalid_release_sequence"
            message = "Channel manifest releaseSequence is not a valid integer."
        }
    }

    return [pscustomobject][ordered]@{
        success = $true
        exists = $true
        value = $parsed
        reason = "ok"
        message = "Channel manifest releaseSequence was read."
    }
}

function Assert-RevAgentProductionTrustedKeysDocument {
    param([Parameter(Mandatory = $true)][string]$Path)
    $document = Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
    $properties = @($document.trustedKeys.PSObject.Properties)
    if ($properties.Count -ne 1 -or -not [string]::Equals([string]$properties[0].Name, $productionSigningKeyId, [StringComparison]::Ordinal)) {
        throw "Production trusted-key document must contain exactly one '$productionSigningKeyId' key."
    }
    $key = $properties[0].Value
    $normalizedXml = ([string]$key.publicKeyXml).Trim() -replace '\s+', ''
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $computedFingerprint = ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedXml)))).Replace('-', '') }
    finally { $algorithm.Dispose() }
    if (-not [string]::Equals([string]$key.algorithm, 'RS256', [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$key.publicKeyFingerprint, $productionSigningFingerprint, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($computedFingerprint, $productionSigningFingerprint, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Production trusted-key document does not match the pinned RS256 release key.'
    }
}

function Get-RevAgentSignedArtifactIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [Parameter(Mandatory = $true)][string]$ChannelPath,
        [Parameter(Mandatory = $true)][string]$ChannelSignaturePath
    )
    foreach ($path in @($ChannelPath, $ChannelSignaturePath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Signed release identity file was not found: $path" }
        Assert-RevAgentChildPath -Path $path -Root $ReleaseRoot
    }
    $channelDocument = Get-Content -Raw -LiteralPath $ChannelPath | ConvertFrom-Json
    $channelDirectory = Split-Path -Parent $ChannelPath
    $manifestPath = [IO.Path]::GetFullPath((Join-Path $channelDirectory ([string]$channelDocument.manifestPath)))
    $packagePath = [IO.Path]::GetFullPath((Join-Path $channelDirectory ([string]$channelDocument.packagePath)))
    $manifestSignaturePath = Join-Path (Split-Path -Parent $manifestPath) (([IO.Path]::GetFileNameWithoutExtension($manifestPath)) + '.sig.json')
    foreach ($path in @($manifestPath, $manifestSignaturePath, $packagePath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Signed release identity file was not found: $path" }
        Assert-RevAgentChildPath -Path $path -Root $ReleaseRoot
    }
    return [pscustomobject][ordered]@{
        version = [string]$channelDocument.version
        releaseSequence = [long]$channelDocument.releaseSequence
        channelSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ChannelPath).Hash
        channelSignatureSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ChannelSignaturePath).Hash
        manifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash
        manifestSignatureSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestSignaturePath).Hash
        packageSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash
    }
}

function Assert-RevAgentSignedArtifactIdentityEqual {
    param([Parameter(Mandatory = $true)][object]$Expected, [Parameter(Mandatory = $true)][object]$Actual, [string]$Label = 'signed release')
    foreach ($name in @('version', 'releaseSequence', 'channelSha256', 'channelSignatureSha256', 'manifestSha256', 'manifestSignatureSha256', 'packageSha256')) {
        if (-not [string]::Equals([string]$Expected.$name, [string]$Actual.$name, [StringComparison]::OrdinalIgnoreCase)) {
            throw "$Label identity changed at '$name'. expected=$($Expected.$name) actual=$($Actual.$name)"
        }
    }
}

function Enter-RevAgentNasPublishLease {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot, [Parameter(Mandatory = $true)][string]$PublishId)
    $leasePath = Join-Path $ReleaseRoot '.revagent-publish.lease.json'
    Assert-RevAgentChildPath -Path $leasePath -Root $ReleaseRoot
    $leaseGuard = $null
    try {
        $leaseGuard = New-RevAgentGuardedFileStream -Path $leasePath -CreateNew
        $payload = [ordered]@{ schemaVersion = 1; app = 'revAgent'; purpose = 'cooperative-publisher-lease'; machine = $env:COMPUTERNAME; processId = $PID; acquiredAtUtc = [DateTime]::UtcNow.ToString('o') }
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($payload | ConvertTo-Json -Compress))
        [void](Set-RevAgentStreamBytesVerified -Stream $leaseGuard.stream -Bytes $bytes -ExpectedSha256 (Get-RevAgentBytesSha256 -Bytes $bytes) -Label 'publisher lease')
        return [pscustomobject][ordered]@{ path = $leasePath; stream = $leaseGuard.stream; identity = $leaseGuard.identity; publishId = $PublishId }
    }
    catch {
        $leaseError = $_
        if ($null -ne $leaseGuard) {
            try { [RevAgent.SignedTransportNativeFileInfo]::MarkDeleteOnClose($leaseGuard.stream.SafeFileHandle) } catch {}
            $leaseGuard.stream.Dispose()
        }
        throw "Another NAS publisher may hold the production publish lease. Stale leases require explicit operator recovery; the publisher never removes a pathname it did not create. detail=$($leaseError.Exception.Message)"
    }
}

function Get-RevAgentSignedStableIdentity {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot, [Parameter(Mandatory = $true)][string]$ChannelPath, [Parameter(Mandatory = $true)][string]$SignaturePath)
    $hasChannel = Test-Path -LiteralPath $ChannelPath -PathType Leaf
    $hasSignature = Test-Path -LiteralPath $SignaturePath -PathType Leaf
    if (-not $hasChannel -and -not $hasSignature) { return [pscustomobject][ordered]@{ exists = $false; artifact = $null; readiness = $null } }
    if (-not $hasChannel -or -not $hasSignature) { throw 'Current NAS stable channel is a partial/unsigned pair; refusing publish.' }
    # This helper is used only for an already-active destination channel. The
    # hidden transition allowance is never passed to candidate/source readiness.
    $readiness = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') -ReleaseRoot $ReleaseRoot -ChannelManifestPath $ChannelPath -TrustedKeysPath $TrustedKeysPath -ArtifactScanScope activeRelease -AllowTestSigningIdentity:$AllowTestRoot -AllowLegacyMissingNodeMsi -RepoRoot $RepoRoot
    if (-not [bool]$readiness.success) { throw 'Current NAS stable channel failed signed readiness; refusing publish.' }
    return [pscustomobject][ordered]@{ exists = $true; artifact = (Get-RevAgentSignedArtifactIdentity -ReleaseRoot $ReleaseRoot -ChannelPath $ChannelPath -ChannelSignaturePath $SignaturePath); readiness = $readiness }
}

function Get-RevAgentNasPublishMutexName {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot, [switch]$LocalOnly)

    $canonicalRoot = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\', '/').ToUpperInvariant()
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $rootHash = ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonicalRoot)))).Replace('-', '')
    }
    finally { $algorithm.Dispose() }
    $namespace = if ($LocalOnly) { 'Local' } else { 'Global' }
    return ("{0}\revAgent.NasSignedPublisher.{1}" -f $namespace, $rootHash)
}

function Assert-RevAgentStableIdentityUnchanged {
    param(
        [Parameter(Mandatory = $true)][object]$Expected,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [Parameter(Mandatory = $true)][string]$ChannelPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [string]$Label = 'NAS stable compare-and-swap baseline'
    )

    $actual = Get-RevAgentSignedStableIdentity -ReleaseRoot $ReleaseRoot -ChannelPath $ChannelPath -SignaturePath $SignaturePath
    if ([bool]$Expected.exists -ne [bool]$actual.exists) {
        throw "$Label existence changed. expected=$([bool]$Expected.exists) actual=$([bool]$actual.exists)"
    }
    if ([bool]$Expected.exists) {
        Assert-RevAgentSignedArtifactIdentityEqual -Expected $Expected.artifact -Actual $actual.artifact -Label $Label
    }
    return $actual
}

function Get-RevAgentDeterministicTreeDigest {
    param([Parameter(Mandatory = $true)][string]$Root)

    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) {
        return [pscustomobject][ordered]@{ exists = $false; fileCount = 0; directoryCount = 0; sha256 = '' }
    }
    $prefixLength = $fullRoot.Length + 1
    $rows = [Collections.Generic.List[string]]::new()
    $directoryCount = 0
    foreach ($directory in @(Get-ChildItem -LiteralPath $fullRoot -Directory -Recurse -Force | Sort-Object { $_.FullName.Length }, FullName)) {
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$directory.LinkType)) {
            throw "Digest tree contains a filesystem link: $($directory.FullName)"
        }
        $relative = $directory.FullName.Substring($prefixLength).Replace('\', '/')
        [void]$rows.Add(("D`t{0}" -f $relative))
        $directoryCount++
    }
    $fileCount = 0
    foreach ($file in @(Get-ChildItem -LiteralPath $fullRoot -File -Recurse -Force | Sort-Object FullName)) {
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$file.LinkType)) {
            throw "Digest tree contains a filesystem link: $($file.FullName)"
        }
        $relative = $file.FullName.Substring($prefixLength).Replace('\', '/')
        $hash = ''
        Invoke-RevAgentFileSystemRetry -Label "Hash digest file $relative" -Action {
            $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
            try {
                $sha = [Security.Cryptography.SHA256]::Create()
                try { $script:RevAgentDigestFileHash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
                finally { $sha.Dispose() }
            }
            finally { $stream.Dispose() }
        }
        $hash = [string]$script:RevAgentDigestFileHash
        Remove-Variable -Name RevAgentDigestFileHash -Scope Script -ErrorAction SilentlyContinue
        [void]$rows.Add(("F`t{0}`t{1}`t{2}" -f $relative, [long]$file.Length, $hash))
        $fileCount++
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($rows -join "`n"))
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '') }
    finally { $algorithm.Dispose() }
    return [pscustomobject][ordered]@{ exists = $true; fileCount = $fileCount; directoryCount = $directoryCount; sha256 = $digest }
}

if (-not (Test-Path -LiteralPath $SourceReleaseRoot -PathType Container)) {
    throw "Source release root was not found: $SourceReleaseRoot"
}
if (-not (Test-Path -LiteralPath $TrustedKeysPath -PathType Leaf)) {
    throw "Trusted release keys file was not found: $TrustedKeysPath"
}
if (-not $AllowTestRoot) { Assert-RevAgentProductionTrustedKeysDocument -Path $TrustedKeysPath }

$sourceChannelPath = Join-Path $SourceReleaseRoot "channels\$Channel.json"
$sourceChannelSignaturePath = Join-Path $SourceReleaseRoot "channels\$Channel.sig.json"
$sourceReadiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
    -ReleaseRoot $SourceReleaseRoot `
    -ChannelManifestPath $sourceChannelPath `
    -TrustedKeysPath $TrustedKeysPath `
    -AllowTestSigningIdentity:$AllowTestRoot `
    -RepoRoot $RepoRoot
if (-not [bool]$sourceReadiness.success) {
    throw "Source signed release root failed readiness verification."
}
if ($null -ne $TestAfterSourceReadinessHook) {
    & $TestAfterSourceReadinessHook $SourceReleaseRoot
}

if (-not (Test-Path -LiteralPath $sourceChannelPath -PathType Leaf)) {
    throw "Source channel manifest was not found: $sourceChannelPath"
}
if (-not (Test-Path -LiteralPath $sourceChannelSignaturePath -PathType Leaf)) {
    throw "Source channel signature was not found: $sourceChannelSignaturePath"
}

$sourceChannel = Get-Content -Raw -LiteralPath $sourceChannelPath | ConvertFrom-Json
$version = [string]$sourceChannel.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "Source channel manifest does not contain a version."
}
if ([System.IO.Path]::IsPathRooted([string]$sourceChannel.manifestPath) -or [System.IO.Path]::IsPathRooted([string]$sourceChannel.packagePath)) {
    throw "Source channel paths must be relative so the signed release can move to NAS without re-signing."
}
if (-not [string]::Equals([string]$sourceChannel.channel, $Channel, [StringComparison]::Ordinal)) {
    throw "Source signed channel identity does not match the requested publish channel. requested=$Channel signed=$($sourceChannel.channel)"
}
if ([string]::Equals($Channel, 'pilot', [StringComparison]::Ordinal) -and $version -notmatch '(?i)(?:^|[._-])pilot(?:[._-]|$)') {
    throw "Pilot publish requires a pilot-namespaced version directory: $version"
}
if ([string]::Equals($Channel, 'pilot', [StringComparison]::Ordinal)) {
    $pilotMachines = @($sourceChannel.pilotPolicy.allowedMachineNames | ForEach-Object { ([string]$_).Trim().ToUpperInvariant() } | Sort-Object)
    if ($pilotMachines.Count -eq 0) { throw 'Signed pilot channel does not contain a non-empty pilotPolicy.allowedMachineNames cohort.' }
    if (-not $AllowTestRoot -and
        ($pilotMachines.Count -ne 2 -or $pilotMachines[0] -ne 'DESKTOP-OKNV128' -or $pilotMachines[1] -ne 'NET01')) {
        throw "Production pilot publish is restricted to DESKTOP-OKNV128 and NET01. Signed cohort=$($pilotMachines -join ',')"
    }
}
if ($null -ne $TestAfterSourceRoutingReadHook) {
    & $TestAfterSourceRoutingReadHook $SourceReleaseRoot $sourceChannelPath $sourceChannelSignaturePath
}
$sourceArtifactIdentity = Get-RevAgentSignedArtifactIdentity `
    -ReleaseRoot $SourceReleaseRoot `
    -ChannelPath $sourceChannelPath `
    -ChannelSignaturePath $sourceChannelSignaturePath

$sourceReleaseDir = Join-Path $SourceReleaseRoot "releases\$version"
$sourceToolsDir = Join-Path $SourceReleaseRoot "tools"
$nasReleaseDir = Join-Path $NasReleaseRoot "releases\$version"
$nasToolsDir = Join-Path $NasReleaseRoot "tools"
$nasChannelsDir = Join-Path $NasReleaseRoot "channels"
if ([string]::Equals($Channel, 'pilot', [StringComparison]::Ordinal) -and (Test-Path -LiteralPath $nasReleaseDir)) {
    throw "Pilot release directories are immutable and must be unique; refusing existing target: $nasReleaseDir"
}
$publishId = [Guid]::NewGuid().ToString('N')
$payloadBackupRoot = Join-Path $NasReleaseRoot (".publish-backup-{0}" -f $publishId)
$toolsBackupDir = Join-Path $payloadBackupRoot "tools"
$releaseBackupDir = Join-Path $payloadBackupRoot "release"
$candidateChannelPath = Join-Path $nasChannelsDir ("{0}.candidate.{1}.json" -f $Channel, $publishId)
$candidateSignaturePath = Join-Path $nasChannelsDir ("{0}.candidate.{1}.sig.json" -f $Channel, $publishId)
$stableChannelPath = Join-Path $nasChannelsDir ("{0}.json" -f $Channel)
$stableSignaturePath = Join-Path $nasChannelsDir ("{0}.sig.json" -f $Channel)
foreach ($path in @($candidateChannelPath, $candidateSignaturePath, $stableChannelPath, $stableSignaturePath, $payloadBackupRoot, $toolsBackupDir, $releaseBackupDir)) {
    Assert-RevAgentChildPath -Path $path -Root $NasReleaseRoot
}

$candidateReleaseSequence = ConvertTo-RevAgentInt64OrZero -Value $sourceArtifactIdentity.releaseSequence
$readinessReleaseSequence = ConvertTo-RevAgentInt64OrZero -Value $sourceReadiness.releaseSequence
if ($candidateReleaseSequence -le 0) {
    throw "Refusing to publish because candidate releaseSequence could not be determined as a positive integer. Check '$sourceChannelPath' and readiness output before retrying."
}
if ($readinessReleaseSequence -le 0 -or $candidateReleaseSequence -ne $readinessReleaseSequence) {
    throw "Authenticated source releaseSequence changed after readiness verification. readiness=$readinessReleaseSequence identity=$candidateReleaseSequence"
}

$stableChannelBackupPath = Join-Path $nasChannelsDir ("{0}.previous.{1}.json" -f $Channel, $publishId)
$stableSignatureBackupPath = Join-Path $nasChannelsDir ("{0}.previous.{1}.sig.json" -f $Channel, $publishId)
$stableChannelTempPath = Join-Path $nasChannelsDir ("{0}.next.{1}.json" -f $Channel, $publishId)
$stableSignatureTempPath = Join-Path $nasChannelsDir ("{0}.next.{1}.sig.json" -f $Channel, $publishId)
foreach ($path in @($stableChannelBackupPath, $stableSignatureBackupPath, $stableChannelTempPath, $stableSignatureTempPath)) {
    Assert-RevAgentChildPath -Path $path -Root $NasReleaseRoot
}

$initialStableIdentity = $null
$stableReadiness = $null
$pilotStableBaseline = $null
$pilotStableFinal = $null
$pilotToolsBaseline = $null
$pilotToolsFinal = $null
$pilotStableReleaseBaseline = $null
$pilotStableReleaseFinal = $null
$pilotImmutableHandlesVerified = $false
$pilotDestinationHandlesVerified = $false
$pilotStablePairHandlesVerified = $false
$rollbackFailed = $false
$promotionStarted = $false
$stableBackupCaptured = $false
$payloadCopyStarted = $false
$hadToolsDir = $false
$hadReleaseDir = $false
$publishMutex = $null
$publishMutexAcquired = $false
$publishLease = $null
$publishLockEvidence = $null
$destinationDirectoryGuards = [Collections.Generic.List[object]]::new()
$pilotImmutableTreeGuards = @()
$pilotStablePairGuard = $null
$candidatePairGuard = $null
$channelPairGuard = $null
$channelRollbackPerformed = $false
$channelRollbackEvidence = $null
$createdChannelPairCleanupMarked = $false
$sourceChannelPairGuard = $null
$sourceReleaseTreeGuards = @()
$sourceToolsTreeGuards = @()
$ownedPilotReleaseTree = $null
$ownedStableReleaseTree = $null
$stableToolsBaseline = $null
$stableToolsFinal = $null
$stableLauncherUpdate = $null
$stableLauncherEvidence = $null
$stableBootstrapToolUpdates = @()
$stableBootstrapToolEvidence = @()
$sourceReleaseDigest = $null
$candidateReadiness = $null
$candidateArtifactIdentity = $null
$finalArtifactIdentity = $null
$lockedSourceChannelSha256 = $null
$sourceArtifactBindingVerified = $false

function Get-RevAgentPathOwnerSid {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        $owner = (Get-Acl -LiteralPath $Path -ErrorAction Stop).GetOwner([System.Security.Principal.SecurityIdentifier])
    }
    catch {
        throw "Could not resolve filesystem owner SID for '$Path': $($_.Exception.Message)"
    }
    if ($null -eq $owner -or [string]::IsNullOrWhiteSpace([string]$owner.Value)) {
        throw "Filesystem owner SID is empty for '$Path'."
    }
    return [string]$owner.Value
}

function Assert-RevAgentTransportTreeLinkSafe {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Label,
        [switch]$ExcludeReportsContents
    )

    $fullRoot = [System.IO.Path]::GetFullPath($Root)
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) {
        throw "$Label root was not found: $fullRoot"
    }

    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($fullRoot)
    $reportsRoot = [System.IO.Path]::GetFullPath((Join-Path $fullRoot "reports")).TrimEnd("\", "/")
    $itemCount = 0
    $fileCount = 0
    while ($pending.Count -gt 0) {
        $path = $pending.Pop()
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        $itemCount++
        $linkType = if ($item.PSObject.Properties["LinkType"]) { [string]$item.LinkType } else { "" }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not [string]::IsNullOrWhiteSpace($linkType)) {
            throw "$Label contains an unsafe filesystem link/reparse item: $($item.FullName) ($linkType)"
        }
        if ($item.PSIsContainer) {
            if ($ExcludeReportsContents -and
                [string]::Equals($item.FullName.TrimEnd("\", "/"), $reportsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                continue
            }
            foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) {
                $pending.Push($child.FullName)
            }
            continue
        }

        $fileCount++
        try { $linkCount = [uint32][RevAgent.SignedTransportNativeFileInfo]::GetLinkCount($item.FullName) }
        catch { throw "$Label hardlink inspection failed for '$($item.FullName)': $($_.Exception.Message)" }
        if ($linkCount -ne 1) {
            throw "$Label contains a hard-linked file: $($item.FullName) (linkCount=$linkCount)"
        }
    }

    return [pscustomobject][ordered]@{
        safe = $true
        root = $fullRoot
        itemCount = $itemCount
        fileCount = $fileCount
        reportsContentsExcluded = [bool]$ExcludeReportsContents
    }
}

function Test-RevAgentPublisherWriterCapability {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot)

    $rootOwnerSid = Get-RevAgentPathOwnerSid -Path $ReleaseRoot
    $probePath = Join-Path $ReleaseRoot (".revagent-publisher-session-{0}" -f [Guid]::NewGuid().ToString("N"))
    Assert-RevAgentChildPath -Path $probePath -Root $ReleaseRoot
    $canaryPath = Join-Path $probePath (".revagent-transport-canary-{0}.tmp" -f [Guid]::NewGuid().ToString("N"))
    $created = $false
    $deleted = $false
    $probeOwnerSid = ""
    $stream = $null
    $primaryError = $null
    try {
        New-Item -ItemType Directory -Path $probePath -ErrorAction Stop | Out-Null
        $probeOwnerSid = Get-RevAgentPathOwnerSid -Path $probePath
        if (-not [string]::Equals($probeOwnerSid, $rootOwnerSid, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Publisher writer-capability owner mismatch. releaseRootOwnerSid=$rootOwnerSid createdDirectoryOwnerSid=$probeOwnerSid"
        }
        $stream = [System.IO.File]::Open($canaryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $stream.WriteByte(1)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        $created = Test-Path -LiteralPath $canaryPath -PathType Leaf
        if (-not $created) { throw "Publisher create canary was not visible after CreateNew: $canaryPath" }
        [System.IO.File]::Delete($canaryPath)
        $deleted = -not (Test-Path -LiteralPath $canaryPath)
        if (-not $deleted) { throw "Publisher delete canary was not removed: $canaryPath" }
    }
    catch { $primaryError = $_ }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if (Test-Path -LiteralPath $canaryPath) {
            Remove-Item -LiteralPath $canaryPath -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $probePath) {
            try { Remove-Item -LiteralPath $probePath -Recurse -Force -ErrorAction Stop }
            catch {
                if ($null -eq $primaryError) { $primaryError = $_ }
            }
        }
    }
    if ($null -ne $primaryError) {
        throw "Publisher signed-transport writer-capability preflight failed: $($primaryError.Exception.Message)"
    }

    return [pscustomobject][ordered]@{
        success = $true
        capability = 'create_delete_under_release_root'
        provesIdentity = $false
        releaseRootOwnerSid = $rootOwnerSid
        createdDirectoryOwnerSid = $probeOwnerSid
        ownerSidMatches = [string]::Equals($probeOwnerSid, $rootOwnerSid, [System.StringComparison]::OrdinalIgnoreCase)
        createDeleteCanary = [pscustomobject][ordered]@{
            created = $created
            deleted = $deleted
        }
        cleaned = -not (Test-Path -LiteralPath $probePath)
    }
}

function Get-RevAgentOptionalAclTelemetry {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot)

    if (-not $IncludeAclTelemetry) {
        return [pscustomobject][ordered]@{
            required = $false
            mutationPerformed = $false
            supported = $null
            status = "not_requested_optional"
            reason = "acl_diagnostic_not_requested"
            preview = $null
        }
    }
    $aclScriptPath = Join-Path $RepoRoot "scripts\set-nas-release-acl.ps1"
    if (-not (Test-Path -LiteralPath $aclScriptPath -PathType Leaf)) {
        return [pscustomobject][ordered]@{
            required = $false
            mutationPerformed = $false
            supported = $false
            status = "unsupported"
            reason = "acl_diagnostic_missing"
            preview = $null
        }
    }
    try {
        $preview = & $aclScriptPath -ReleaseRoot $ReleaseRoot -Mode Preview -AllowTestRoot:$AllowTestRoot
        return [pscustomobject][ordered]@{
            required = $false
            mutationPerformed = $false
            supported = $true
            status = "optional_diagnostic_available"
            reason = "ok"
            preview = $preview
        }
    }
    catch {
        return [pscustomobject][ordered]@{
            required = $false
            mutationPerformed = $false
            supported = $false
            status = "unsupported"
            reason = "acl_diagnostic_unavailable"
            error = $_.Exception.Message
            preview = $null
        }
    }
}

$sourceTransportLinkSafety = Assert-RevAgentTransportTreeLinkSafe -Root $SourceReleaseRoot -Label "Source signed release"
if (-not (Test-Path -LiteralPath $NasReleaseRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $NasReleaseRoot -Force -ErrorAction Stop | Out-Null
}
$destinationTransportLinkSafetyBefore = $null
$writerCapability = $null
$destinationTransportLinkSafetyAfterProbe = $null
$destinationTransportLinkSafetyAfter = $null
$publishMutexName = Get-RevAgentNasPublishMutexName -ReleaseRoot $NasReleaseRoot -LocalOnly:$AllowTestRoot
$publishMutex = [Threading.Mutex]::new($false, $publishMutexName)
try {
    try { $publishMutexAcquired = $publishMutex.WaitOne(0, $false) }
    catch [Threading.AbandonedMutexException] { $publishMutexAcquired = $true }
    if (-not $publishMutexAcquired) {
        throw "Another publisher holds the named mutex for this NAS release root."
    }

    $publishLease = Enter-RevAgentNasPublishLease -ReleaseRoot $NasReleaseRoot -PublishId $publishId
    $publishLockEvidence = [pscustomobject][ordered]@{
        publishId = $publishId
        mutexName = $publishMutexName
        mutexAcquired = $true
        leasePath = [string]$publishLease.path
        leaseAcquired = $true
        mutexReleased = $false
        leaseReleased = $false
        released = $false
    }

    $destinationTransportLinkSafetyBefore = Assert-RevAgentTransportTreeLinkSafe -Root $NasReleaseRoot -Label "NAS signed transport before publish" -ExcludeReportsContents
    [void]$destinationDirectoryGuards.Add((Enter-RevAgentDirectoryNoDeleteGuard -Path $NasReleaseRoot -Label 'NAS release root'))
    New-Item -ItemType Directory -Path $nasChannelsDir, (Join-Path $NasReleaseRoot 'releases') -Force | Out-Null
    [void]$destinationDirectoryGuards.Add((Enter-RevAgentDirectoryNoDeleteGuard -Path $nasChannelsDir -Label 'NAS channels root'))
    [void]$destinationDirectoryGuards.Add((Enter-RevAgentDirectoryNoDeleteGuard -Path (Join-Path $NasReleaseRoot 'releases') -Label 'NAS releases root'))

    $sourceChannelPairGuard = Enter-RevAgentChannelPairGuard `
        -ChannelPath $sourceChannelPath `
        -SignaturePath $sourceChannelSignaturePath `
        -ExpectedIdentity ([pscustomobject]@{ exists = $true; artifact = $sourceArtifactIdentity }) `
        -ReadOnly
    $lockedSourceChannelSha256 = Get-RevAgentStreamSha256 -Stream $sourceChannelPairGuard.channel.stream
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceChannelSha256) -and
        -not [string]::Equals($lockedSourceChannelSha256, $ExpectedSourceChannelSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Exact locked source channel SHA-256 does not match the workflow artifact handoff. expected=$ExpectedSourceChannelSha256 actual=$lockedSourceChannelSha256"
    }
    if (-not [string]::Equals($lockedSourceChannelSha256, [string]$sourceChannelPairGuard.baselineChannelSha256, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($lockedSourceChannelSha256, [string]$sourceArtifactIdentity.channelSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Exact locked source channel SHA-256 changed after source authentication.'
    }
    $lockedSourceChannel = ConvertFrom-RevAgentUtf8JsonBytes -Bytes ([byte[]]$sourceChannelPairGuard.baselineChannelBytes)
    foreach ($routingField in @('channel', 'version', 'manifestPath', 'packagePath')) {
        if (-not [string]::Equals([string]$lockedSourceChannel.$routingField, [string]$sourceChannel.$routingField, [StringComparison]::Ordinal)) {
            throw "Locked source routing changed after the preliminary source read. field=$routingField preliminary=$($sourceChannel.$routingField) locked=$($lockedSourceChannel.$routingField)"
        }
    }
    $lockedVersion = [string]$lockedSourceChannel.version
    $lockedSourceReleaseDir = [IO.Path]::GetFullPath((Join-Path $SourceReleaseRoot "releases\$lockedVersion"))
    $lockedNasReleaseDir = [IO.Path]::GetFullPath((Join-Path $NasReleaseRoot "releases\$lockedVersion"))
    if (-not [string]::Equals($lockedSourceReleaseDir, [IO.Path]::GetFullPath($sourceReleaseDir), [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($lockedNasReleaseDir, [IO.Path]::GetFullPath($nasReleaseDir), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Locked source version does not bind the precomputed source/destination release directories.'
    }
    if ([string]::Equals($Channel, 'pilot', [StringComparison]::Ordinal)) {
        $lockedPilotMachines = @($lockedSourceChannel.pilotPolicy.allowedMachineNames | ForEach-Object { ([string]$_).Trim().ToUpperInvariant() } | Sort-Object)
        if ($lockedPilotMachines.Count -ne $pilotMachines.Count) {
            throw 'Locked pilot cohort changed after the preliminary source read.'
        }
        for ($machineIndex = 0; $machineIndex -lt $lockedPilotMachines.Count; $machineIndex++) {
            if (-not [string]::Equals([string]$lockedPilotMachines[$machineIndex], [string]$pilotMachines[$machineIndex], [StringComparison]::Ordinal)) {
                throw 'Locked pilot cohort changed after the preliminary source read.'
            }
        }
        if (-not $AllowTestRoot -and
            ($lockedPilotMachines.Count -ne 2 -or $lockedPilotMachines[0] -ne 'DESKTOP-OKNV128' -or $lockedPilotMachines[1] -ne 'NET01')) {
            throw "Production pilot publish is restricted to DESKTOP-OKNV128 and NET01. Locked signed cohort=$($lockedPilotMachines -join ',')"
        }
        $pilotMachines = $lockedPilotMachines
    }
    $sourceChannel = $lockedSourceChannel
    $sourceArtifactBindingVerified = $true
    $sourceReleaseTreeGuards = @(Enter-RevAgentReadOnlyTreeGuard -Root $sourceReleaseDir -Label 'source versioned release')
    if (-not [string]::Equals($Channel, 'pilot', [StringComparison]::Ordinal)) {
        $sourceToolsTreeGuards = @(Enter-RevAgentReadOnlyTreeGuard -Root $sourceToolsDir -Label 'source shared tools')
    }
    $lockedSourceReadiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $SourceReleaseRoot `
        -ChannelManifestPath $sourceChannelPath `
        -TrustedKeysPath $TrustedKeysPath `
        -AllowTestSigningIdentity:$AllowTestRoot `
        -RepoRoot $RepoRoot
    if (-not [bool]$lockedSourceReadiness.success) {
        throw 'Exact locked source signed set failed readiness verification.'
    }
    $lockedSourceIdentity = Get-RevAgentSignedArtifactIdentity `
        -ReleaseRoot $SourceReleaseRoot `
        -ChannelPath $sourceChannelPath `
        -ChannelSignaturePath $sourceChannelSignaturePath
    Assert-RevAgentSignedArtifactIdentityEqual -Expected $sourceArtifactIdentity -Actual $lockedSourceIdentity -Label 'locked source signed set'
    $sourceReadiness = $lockedSourceReadiness

    if ([string]::Equals($Channel, 'pilot', [StringComparison]::Ordinal)) {
        $canonicalStablePath = Join-Path $nasChannelsDir 'stable.json'
        $canonicalStableSignaturePath = Join-Path $nasChannelsDir 'stable.sig.json'
        $pilotStableBaseline = Get-RevAgentSignedStableIdentity `
            -ReleaseRoot $NasReleaseRoot `
            -ChannelPath $canonicalStablePath `
            -SignaturePath $canonicalStableSignaturePath
        if (-not [bool]$pilotStableBaseline.exists) { throw 'Pilot publish requires an existing authenticated canonical stable baseline.' }
        $pilotStablePairGuard = Enter-RevAgentChannelPairGuard `
            -ChannelPath $canonicalStablePath `
            -SignaturePath $canonicalStableSignaturePath `
            -ExpectedIdentity $pilotStableBaseline `
            -ReadOnly
        $stableChannelDocument = ConvertFrom-RevAgentUtf8JsonBytes -Bytes ([byte[]]$pilotStablePairGuard.baselineChannelBytes)
        $stableManifestPath = [IO.Path]::GetFullPath((Join-Path $nasChannelsDir ([string]$stableChannelDocument.manifestPath)))
        Assert-RevAgentChildPath -Path $stableManifestPath -Root $NasReleaseRoot
        $stableReleaseTreeRoot = Split-Path -Parent $stableManifestPath
        $pilotImmutableTreeGuards = @(
            @(Enter-RevAgentReadOnlyTreeGuard -Root $nasToolsDir -Label 'pilot-protected shared tools')
            @(Enter-RevAgentReadOnlyTreeGuard -Root $stableReleaseTreeRoot -Label 'pilot-protected active stable release')
        )
        $pilotToolsBaseline = Get-RevAgentDeterministicTreeDigest -Root $nasToolsDir
        if (-not [bool]$pilotToolsBaseline.exists) { throw 'Pilot publish requires the existing shared NAS tools tree and may not create or replace it.' }
        $pilotStableReleaseBaseline = Get-RevAgentDeterministicTreeDigest -Root $stableReleaseTreeRoot
        if (-not [bool]$pilotStableReleaseBaseline.exists) { throw 'Pilot publish requires the existing active stable release tree.' }
        [void](Assert-RevAgentStableIdentityUnchanged `
            -Expected $pilotStableBaseline `
            -ReleaseRoot $NasReleaseRoot `
            -ChannelPath $canonicalStablePath `
            -SignaturePath $canonicalStableSignaturePath `
            -Label 'locked canonical stable identity before pilot publish')
    }

    # The signed baseline is read only after both cooperative publisher locks
    # are held. It becomes the compare-and-swap expectation for promotion.
    $initialStableIdentity = Get-RevAgentSignedStableIdentity `
        -ReleaseRoot $NasReleaseRoot `
        -ChannelPath $stableChannelPath `
        -SignaturePath $stableSignaturePath
    if ($null -ne $TestAfterBaselineReadinessHook) {
        & $TestAfterBaselineReadinessHook $stableChannelPath $stableSignaturePath
    }
    if ($null -ne $TestBeforeStablePromotionHook) {
        # Backward-compatible test seam: this now runs before exact destination
        # handles are acquired so a readiness-to-lock swap must be rejected.
        & $TestBeforeStablePromotionHook $stableChannelPath $stableSignaturePath
    }
    $currentStableReleaseSequence = if ([bool]$initialStableIdentity.exists) { [long]$initialStableIdentity.artifact.releaseSequence } else { [long]0 }
    if ([bool]$initialStableIdentity.exists -and $currentStableReleaseSequence -le 0) {
        throw "Refusing to publish because current stable releaseSequence could not be determined as a positive integer from the authenticated baseline."
    }
    # Equal releaseSequence republish is a protected repair path; require an explicit operator override.
    if ($currentStableReleaseSequence -gt 0 -and $candidateReleaseSequence -le $currentStableReleaseSequence -and -not $AllowRollback) {
        throw "Refusing to publish releaseSequence '$candidateReleaseSequence' over current stable '$currentStableReleaseSequence'. Pass -AllowRollback only for deliberate signed rollback or current-sequence repair."
    }

    if (-not [bool]$initialStableIdentity.exists -and $null -ne $TestBeforeNewPairCreateHook) {
        & $TestBeforeNewPairCreateHook $stableChannelPath $stableSignaturePath
    }
    $channelPairGuard = Enter-RevAgentChannelPairGuard `
        -ChannelPath $stableChannelPath `
        -SignaturePath $stableSignaturePath `
        -ExpectedIdentity $initialStableIdentity
    if ([bool]$channelPairGuard.existed) {
        $lockedBaselineDocument = ConvertFrom-RevAgentUtf8JsonBytes -Bytes ([byte[]]$channelPairGuard.baselineChannelBytes)
        $lockedBaselineSequence = ConvertTo-RevAgentInt64OrZero -Value $lockedBaselineDocument.releaseSequence
        if ($lockedBaselineSequence -le 0 -or $lockedBaselineSequence -ne $currentStableReleaseSequence) {
            throw "Locked destination baseline releaseSequence changed after authentication. authenticated=$currentStableReleaseSequence locked=$lockedBaselineSequence"
        }
    }

    $writerCapability = Test-RevAgentPublisherWriterCapability -ReleaseRoot $NasReleaseRoot
    $destinationTransportLinkSafetyAfterProbe = Assert-RevAgentTransportTreeLinkSafe -Root $NasReleaseRoot -Label "NAS signed transport after writer-capability probe" -ExcludeReportsContents

    try {
        if ([string]::Equals($Channel, 'pilot', [StringComparison]::Ordinal)) {
            $sourceReleaseDigest = Get-RevAgentDeterministicTreeDigest -Root $sourceReleaseDir
            $payloadCopyStarted = $true
            $ownedPilotReleaseTree = Copy-RevAgentDirectoryCreateNewGuarded `
                -Source $sourceReleaseDir `
                -Destination $nasReleaseDir `
                -Root $NasReleaseRoot `
                -Label 'pilot versioned release'
            if ($ownedPilotReleaseTree.fileCount -ne $sourceReleaseDigest.fileCount -or
                $ownedPilotReleaseTree.directoryCount -ne $sourceReleaseDigest.directoryCount -or
                -not [string]::Equals([string]$ownedPilotReleaseTree.sha256, [string]$sourceReleaseDigest.sha256, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Handle-bound pilot release tree digest does not match the locked source tree.'
            }
        }
        else {
            if ($AllowTestRoot) {
                # Disposable local fixtures retain the legacy stable payload
                # swap so recovery/race tests can exercise channel semantics.
                $hadToolsDir = Backup-RevAgentDirectoryForRollback -Source $nasToolsDir -Backup $toolsBackupDir -Root $NasReleaseRoot
                $hadReleaseDir = Backup-RevAgentDirectoryForRollback -Source $nasReleaseDir -Backup $releaseBackupDir -Root $NasReleaseRoot
                $payloadCopyStarted = $true
                Copy-RevAgentDirectoryExact -Source $sourceReleaseDir -Destination $nasReleaseDir -Root $NasReleaseRoot -AllowReplace:$Force
                Copy-RevAgentDirectoryExact -Source $sourceToolsDir -Destination $nasToolsDir -Root $NasReleaseRoot -AllowReplace:$true
            }
            else {
                $sourceReleaseDigest = Get-RevAgentDeterministicTreeDigest -Root $sourceReleaseDir
                $stableToolsBaseline = Get-RevAgentDeterministicTreeDigest -Root $nasToolsDir
                if (-not [bool]$stableToolsBaseline.exists) { throw 'Stable publish requires the existing shared NAS tools tree.' }
                if ((Test-Path -LiteralPath $nasReleaseDir) -and -not $Force) {
                    throw "Stable release target already exists: $nasReleaseDir. Pass -Force only for an explicitly reviewed repair."
                }
                if (Test-Path -LiteralPath $nasReleaseDir) {
                    throw 'Production stable repair over an existing release directory is not supported by the handle-bound create-new transaction.'
                }
                $payloadCopyStarted = $true
                $ownedStableReleaseTree = Copy-RevAgentDirectoryCreateNewGuarded `
                    -Source $sourceReleaseDir `
                    -Destination $nasReleaseDir `
                    -Root $NasReleaseRoot `
                    -Label 'stable versioned release'
                if ($ownedStableReleaseTree.fileCount -ne $sourceReleaseDigest.fileCount -or
                    $ownedStableReleaseTree.directoryCount -ne $sourceReleaseDigest.directoryCount -or
                    -not [string]::Equals([string]$ownedStableReleaseTree.sha256, [string]$sourceReleaseDigest.sha256, [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'Handle-bound stable release tree digest does not match the locked source tree.'
                }
                $stableBootstrapToolUpdates = @(Set-RevAgentStableBootstrapToolsExact -ToolsRoot $nasToolsDir -ReleaseRoot $NasReleaseRoot)
                $stableLauncherUpdate = Set-RevAgentStableLauncherExact -ToolsRoot $nasToolsDir -ReleaseRoot $NasReleaseRoot
            }
        }

        $candidatePairGuard = Enter-RevAgentChannelPairGuard `
            -ChannelPath $candidateChannelPath `
            -SignaturePath $candidateSignaturePath `
            -ExpectedIdentity ([pscustomobject]@{ exists = $false; artifact = $null })
        $candidateSignatureHash = Set-RevAgentStreamBytesVerified `
            -Stream $candidatePairGuard.signature.stream `
            -Bytes ([byte[]]$sourceChannelPairGuard.baselineSignatureBytes) `
            -ExpectedSha256 ([string]$sourceArtifactIdentity.channelSignatureSha256) `
            -Label 'candidate channel signature'
        $candidateChannelHash = Set-RevAgentStreamBytesVerified `
            -Stream $candidatePairGuard.channel.stream `
            -Bytes ([byte[]]$sourceChannelPairGuard.baselineChannelBytes) `
            -ExpectedSha256 ([string]$sourceArtifactIdentity.channelSha256) `
            -Label 'candidate channel manifest'
        $candidateArtifactIdentity = $sourceArtifactIdentity
        $candidateReadiness = [pscustomobject][ordered]@{
            success = $true
            state = 'locked-source-verified-and-handle-bound-copy'
            releaseSequence = $candidateReleaseSequence
            sourceReadiness = $lockedSourceReadiness
            releaseTree = if ($null -ne $ownedPilotReleaseTree) { [pscustomobject]@{ fileCount = $ownedPilotReleaseTree.fileCount; sha256 = $ownedPilotReleaseTree.sha256 } } elseif ($null -ne $ownedStableReleaseTree) { [pscustomobject]@{ fileCount = $ownedStableReleaseTree.fileCount; sha256 = $ownedStableReleaseTree.sha256 } } else { $null }
            stableLauncher = if ($null -ne $stableLauncherUpdate) { [pscustomobject]@{ path = $stableLauncherUpdate.path; sha256 = $stableLauncherUpdate.sha256; changed = [bool]$stableLauncherUpdate.changed } } else { $null }
            stableBootstrapTools = @($stableBootstrapToolUpdates | ForEach-Object { [pscustomobject]@{ path = $_.path; sha256 = $_.sha256; changed = [bool]$_.changed } })
            channelSha256 = $candidateChannelHash
            channelSignatureSha256 = $candidateSignatureHash
        }

        $baselineChannelHash = Get-RevAgentStreamSha256 -Stream $channelPairGuard.channel.stream
        $baselineSignatureHash = Get-RevAgentStreamSha256 -Stream $channelPairGuard.signature.stream
        if (-not [string]::Equals($baselineChannelHash, [string]$channelPairGuard.baselineChannelSha256, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($baselineSignatureHash, [string]$channelPairGuard.baselineSignatureSha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Destination channel pair changed before same-handle promotion.'
        }

        # P1: signature=candidate, channel=baseline. Both exact destination
        # identities stay open with FileShare.Read, so an outside writer cannot
        # overwrite, rename, delete, or hardlink-swap either file in the gap.
        $promotionStarted = $true
        [void](Set-RevAgentStreamBytesVerified `
            -Stream $channelPairGuard.signature.stream `
            -Bytes ([byte[]]$sourceChannelPairGuard.baselineSignatureBytes) `
            -ExpectedSha256 ([string]$sourceArtifactIdentity.channelSignatureSha256) `
            -Label 'active channel signature')
        if ($null -ne $TestAfterSignatureWriteHook) {
            & $TestAfterSignatureWriteHook $stableChannelPath $stableSignaturePath
        }
        [void](Assert-RevAgentExactFileHandleIdentity -Handle $channelPairGuard.channel.stream.SafeFileHandle -ExpectedIdentity $channelPairGuard.channel.identity -Label 'intermediate active channel')
        [void](Assert-RevAgentExactFileHandleIdentity -Handle $channelPairGuard.signature.stream.SafeFileHandle -ExpectedIdentity $channelPairGuard.signature.identity -Label 'intermediate active signature')
        if (-not [string]::Equals((Get-RevAgentStreamSha256 -Stream $channelPairGuard.channel.stream), [string]$channelPairGuard.baselineChannelSha256, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals((Get-RevAgentStreamSha256 -Stream $channelPairGuard.signature.stream), [string]$sourceArtifactIdentity.channelSignatureSha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Same-handle channel pair failed the signature-written intermediate CAS state.'
        }

        # P2: signature=candidate, channel=candidate.
        [void](Set-RevAgentStreamBytesVerified `
            -Stream $channelPairGuard.channel.stream `
            -Bytes ([byte[]]$sourceChannelPairGuard.baselineChannelBytes) `
            -ExpectedSha256 ([string]$sourceArtifactIdentity.channelSha256) `
            -Label 'active channel manifest')
        $finalChannelDocument = ConvertFrom-RevAgentUtf8JsonBytes -Bytes ([byte[]](Read-RevAgentStreamBytes -Stream $channelPairGuard.channel.stream))
        [void](Assert-RevAgentExactFileHandleIdentity -Handle $channelPairGuard.channel.stream.SafeFileHandle -ExpectedIdentity $channelPairGuard.channel.identity -Label 'final active channel')
        [void](Assert-RevAgentExactFileHandleIdentity -Handle $channelPairGuard.signature.stream.SafeFileHandle -ExpectedIdentity $channelPairGuard.signature.identity -Label 'final active signature')
        if ((ConvertTo-RevAgentInt64OrZero -Value $finalChannelDocument.releaseSequence) -ne $candidateReleaseSequence -or
            -not [string]::Equals((Get-RevAgentStreamSha256 -Stream $channelPairGuard.channel.stream), [string]$sourceArtifactIdentity.channelSha256, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals((Get-RevAgentStreamSha256 -Stream $channelPairGuard.signature.stream), [string]$sourceArtifactIdentity.channelSignatureSha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Same-handle final channel pair verification failed.'
        }
        $stableReadiness = $candidateReadiness
        $finalArtifactIdentity = $sourceArtifactIdentity
        if ([string]::Equals($Channel, 'pilot', [StringComparison]::Ordinal)) {
            if ($null -ne $TestBeforePilotImmutableFinalVerificationHook) {
                & $TestBeforePilotImmutableFinalVerificationHook $NasReleaseRoot $nasReleaseDir $stableReleaseTreeRoot $nasToolsDir
            }
            [void](Assert-RevAgentExactFileHandleIdentity -Handle $pilotStablePairGuard.channel.stream.SafeFileHandle -ExpectedIdentity $pilotStablePairGuard.channel.identity -Label 'final canonical stable channel')
            [void](Assert-RevAgentExactFileHandleIdentity -Handle $pilotStablePairGuard.signature.stream.SafeFileHandle -ExpectedIdentity $pilotStablePairGuard.signature.identity -Label 'final canonical stable signature')
            if (-not [string]::Equals((Get-RevAgentStreamSha256 -Stream $pilotStablePairGuard.channel.stream), [string]$pilotStablePairGuard.baselineChannelSha256, [StringComparison]::OrdinalIgnoreCase) -or
                -not [string]::Equals((Get-RevAgentStreamSha256 -Stream $pilotStablePairGuard.signature.stream), [string]$pilotStablePairGuard.baselineSignatureSha256, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Canonical stable channel pair changed through its held handles during pilot publish.'
            }
            $pilotStablePairHandlesVerified = $true
            [void](Assert-RevAgentGuardSetIntact -Guards $pilotImmutableTreeGuards -Label 'pilot immutable stable surface')
            $pilotImmutableHandlesVerified = $true
            [void](Assert-RevAgentOwnedTreeIntact -Tree $ownedPilotReleaseTree -Label 'pilot destination release')
            $pilotDestinationHandlesVerified = $true
            $pilotStableFinal = Assert-RevAgentStableIdentityUnchanged `
                -Expected $pilotStableBaseline `
                -ReleaseRoot $NasReleaseRoot `
                -ChannelPath (Join-Path $nasChannelsDir 'stable.json') `
                -SignaturePath (Join-Path $nasChannelsDir 'stable.sig.json') `
                -Label 'canonical stable identity during pilot publish'
            $pilotToolsFinal = Get-RevAgentDeterministicTreeDigest -Root $nasToolsDir
            if (-not [bool]$pilotToolsFinal.exists -or
                $pilotToolsFinal.fileCount -ne $pilotToolsBaseline.fileCount -or
                $pilotToolsFinal.directoryCount -ne $pilotToolsBaseline.directoryCount -or
                -not [string]::Equals([string]$pilotToolsFinal.sha256, [string]$pilotToolsBaseline.sha256, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Pilot publish changed the shared NAS tools tree; refusing the pilot promotion.'
            }
            $pilotStableReleaseFinal = Get-RevAgentDeterministicTreeDigest -Root $stableReleaseTreeRoot
            if (-not [bool]$pilotStableReleaseFinal.exists -or
                $pilotStableReleaseFinal.fileCount -ne $pilotStableReleaseBaseline.fileCount -or
                $pilotStableReleaseFinal.directoryCount -ne $pilotStableReleaseBaseline.directoryCount -or
                -not [string]::Equals([string]$pilotStableReleaseFinal.sha256, [string]$pilotStableReleaseBaseline.sha256, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Pilot publish changed the active stable release tree; refusing the pilot promotion.'
            }
            $pilotReleaseFinal = Get-RevAgentOwnedTreeDigest -Tree $ownedPilotReleaseTree -Label 'pilot destination release'
            if (-not [bool]$pilotReleaseFinal.exists -or
                $pilotReleaseFinal.fileCount -ne $sourceReleaseDigest.fileCount -or
                $pilotReleaseFinal.directoryCount -ne $sourceReleaseDigest.directoryCount -or
                -not [string]::Equals([string]$pilotReleaseFinal.sha256, [string]$sourceReleaseDigest.sha256, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Pilot destination release tree changed before publish completion.'
            }
        }
        elseif ($null -ne $ownedStableReleaseTree) {
            [void](Assert-RevAgentOwnedTreeIntact -Tree $ownedStableReleaseTree -Label 'stable destination release')
            $stableReleaseFinal = Get-RevAgentOwnedTreeDigest -Tree $ownedStableReleaseTree -Label 'stable destination release'
            if (-not [bool]$stableReleaseFinal.exists -or
                $stableReleaseFinal.fileCount -ne $sourceReleaseDigest.fileCount -or
                $stableReleaseFinal.directoryCount -ne $sourceReleaseDigest.directoryCount -or
                -not [string]::Equals([string]$stableReleaseFinal.sha256, [string]$sourceReleaseDigest.sha256, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Stable destination release tree changed before publish completion.'
            }
            if ($null -ne $stableLauncherUpdate) {
                [void](Assert-RevAgentExactFileHandleIdentity -Handle $stableLauncherUpdate.stream.SafeFileHandle -ExpectedIdentity $stableLauncherUpdate.identity -Label 'stable updater launcher final')
                if (-not [string]::Equals((Get-RevAgentStreamSha256 -Stream $stableLauncherUpdate.stream), [string]$stableLauncherUpdate.sha256, [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'Stable updater launcher changed before publish completion.'
                }
                $stableLauncherEvidence = [pscustomobject][ordered]@{
                    path = [string]$stableLauncherUpdate.path
                    sha256 = [string]$stableLauncherUpdate.sha256
                    changed = [bool]$stableLauncherUpdate.changed
                    created = [bool]$stableLauncherUpdate.created
                }
            }
            foreach ($toolUpdate in @($stableBootstrapToolUpdates)) {
                [void](Assert-RevAgentExactFileHandleIdentity -Handle $toolUpdate.stream.SafeFileHandle -ExpectedIdentity $toolUpdate.identity -Label ("stable bootstrap tool final: {0}" -f $toolUpdate.toolName))
                if (-not [string]::Equals((Get-RevAgentStreamSha256 -Stream $toolUpdate.stream), [string]$toolUpdate.sha256, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Stable bootstrap tool changed before publish completion: $($toolUpdate.toolName)"
                }
            }
            $stableBootstrapToolEvidence = @($stableBootstrapToolUpdates | ForEach-Object {
                    [pscustomobject][ordered]@{
                        path = [string]$_.path
                        toolName = [string]$_.toolName
                        sha256 = [string]$_.sha256
                        changed = [bool]$_.changed
                        created = [bool]$_.created
                    }
                })
            $stableToolsFinal = Get-RevAgentDeterministicTreeDigest -Root $nasToolsDir
            if (-not [bool]$stableToolsFinal.exists) { throw 'Stable publish lost the shared NAS tools tree.' }
        }
        $destinationTransportLinkSafetyAfter = Assert-RevAgentTransportTreeLinkSafe -Root $NasReleaseRoot -Label "NAS signed transport after publish" -ExcludeReportsContents
        if ($null -ne $ownedPilotReleaseTree) {
            # Close inside the rollback-protected body. If a final handle
            # invariant fails, the active channel pair is restored before the
            # error can escape this transaction.
            Close-RevAgentOwnedTree -Tree $ownedPilotReleaseTree
            $ownedPilotReleaseTree = $null
        }
        if ($null -ne $ownedStableReleaseTree) {
            Close-RevAgentOwnedTree -Tree $ownedStableReleaseTree
            $ownedStableReleaseTree = $null
        }
        if ($null -ne $stableLauncherUpdate) {
            $stableLauncherUpdate.stream.Dispose()
            $stableLauncherUpdate = $null
        }
        foreach ($toolUpdate in @($stableBootstrapToolUpdates)) {
            $toolUpdate.stream.Dispose()
        }
        $stableBootstrapToolUpdates = @()
    }
    catch {
        $publishError = $_
        try {
            if ($promotionStarted) {
                if ([bool]$channelPairGuard.existed) {
                    $signatureRollback = Restore-RevAgentStreamBytesByStableHandle `
                        -Stream $channelPairGuard.signature.stream `
                        -ExpectedIdentity $channelPairGuard.signature.identity `
                        -Bytes ([byte[]]$channelPairGuard.baselineSignatureBytes) `
                        -ExpectedSha256 ([string]$channelPairGuard.baselineSignatureSha256) `
                        -Label 'active channel signature rollback'
                    $channelRollback = Restore-RevAgentStreamBytesByStableHandle `
                        -Stream $channelPairGuard.channel.stream `
                        -ExpectedIdentity $channelPairGuard.channel.identity `
                        -Bytes ([byte[]]$channelPairGuard.baselineChannelBytes) `
                        -ExpectedSha256 ([string]$channelPairGuard.baselineChannelSha256) `
                        -Label 'active channel manifest rollback'
                    $channelRollbackEvidence = [pscustomobject][ordered]@{ signature = $signatureRollback; channel = $channelRollback }
                    $channelRollbackPerformed = $true
                }
                else {
                    Remove-RevAgentCreatedChannelPairThroughHandles -PairGuard $channelPairGuard
                    $createdChannelPairCleanupMarked = $true
                }
            }
            elseif ($null -ne $channelPairGuard -and -not [bool]$channelPairGuard.existed) {
                Remove-RevAgentCreatedChannelPairThroughHandles -PairGuard $channelPairGuard
                $createdChannelPairCleanupMarked = $true
            }
            if ($payloadCopyStarted) {
                if ($null -ne $ownedPilotReleaseTree) {
                    Close-RevAgentOwnedTree -Tree $ownedPilotReleaseTree -Delete
                    $ownedPilotReleaseTree = $null
                }
                if ($null -ne $ownedStableReleaseTree) {
                    Close-RevAgentOwnedTree -Tree $ownedStableReleaseTree -Delete
                    $ownedStableReleaseTree = $null
                }
                if ($null -ne $stableLauncherUpdate) {
                    if ([bool]$stableLauncherUpdate.created) {
                        [RevAgent.SignedTransportNativeFileInfo]::MarkDeleteOnClose($stableLauncherUpdate.stream.SafeFileHandle)
                    }
                    else {
                        [void](Restore-RevAgentStreamBytesByStableHandle `
                            -Stream $stableLauncherUpdate.stream `
                            -ExpectedIdentity $stableLauncherUpdate.identity `
                            -Bytes ([byte[]]$stableLauncherUpdate.baselineBytes) `
                            -ExpectedSha256 ([string]$stableLauncherUpdate.baselineSha256) `
                            -Label 'stable updater launcher rollback')
                    }
                    $stableLauncherUpdate.stream.Dispose()
                    $stableLauncherUpdate = $null
                }
                foreach ($toolUpdate in @($stableBootstrapToolUpdates)) {
                    if ([bool]$toolUpdate.created) {
                        [RevAgent.SignedTransportNativeFileInfo]::MarkDeleteOnClose($toolUpdate.stream.SafeFileHandle)
                    }
                    else {
                        [void](Restore-RevAgentStreamBytesByStableHandle `
                            -Stream $toolUpdate.stream `
                            -ExpectedIdentity $toolUpdate.identity `
                            -Bytes ([byte[]]$toolUpdate.baselineBytes) `
                            -ExpectedSha256 ([string]$toolUpdate.baselineSha256) `
                            -Label ("stable bootstrap tool rollback: {0}" -f $toolUpdate.toolName))
                    }
                    $toolUpdate.stream.Dispose()
                }
                $stableBootstrapToolUpdates = @()
                if ($AllowTestRoot -and [string]::Equals($Channel, 'stable', [StringComparison]::Ordinal)) {
                    Restore-RevAgentDirectoryFromRollback -Destination $nasToolsDir -Backup $toolsBackupDir -Root $NasReleaseRoot -HadOriginal $hadToolsDir
                    Restore-RevAgentDirectoryFromRollback -Destination $nasReleaseDir -Backup $releaseBackupDir -Root $NasReleaseRoot -HadOriginal $hadReleaseDir
                }
            }
        }
        catch {
            $rollbackFailed = $true
            $rollbackError = $_
            throw "NAS signed channel publish failed and exact-handle rollback/cleanup also failed. Original error: $($publishError.Exception.Message). Rollback error: $($rollbackError.Exception.Message). Manual recovery is required; no pathname-based overwrite was attempted."
        }
        throw $publishError
    }
    finally {
        if ($null -ne $candidatePairGuard) {
            try { Remove-RevAgentCreatedChannelPairThroughHandles -PairGuard $candidatePairGuard }
            catch { if (-not $rollbackFailed) { throw } }
            finally {
                $candidatePairGuard.signature.stream.Dispose()
                $candidatePairGuard.channel.stream.Dispose()
                $candidatePairGuard = $null
            }
        }
        if ($null -ne $channelPairGuard) {
            $channelPairGuard.signature.stream.Dispose()
            $channelPairGuard.channel.stream.Dispose()
            $channelPairGuard = $null
        }
        if ($null -ne $ownedPilotReleaseTree) {
            Close-RevAgentOwnedTree -Tree $ownedPilotReleaseTree
            $ownedPilotReleaseTree = $null
        }
        if ($null -ne $ownedStableReleaseTree) {
            Close-RevAgentOwnedTree -Tree $ownedStableReleaseTree
            $ownedStableReleaseTree = $null
        }
        if ($null -ne $stableLauncherUpdate) {
            $stableLauncherUpdate.stream.Dispose()
            $stableLauncherUpdate = $null
        }
        foreach ($toolUpdate in @($stableBootstrapToolUpdates)) {
            try { $toolUpdate.stream.Dispose() } catch {}
        }
        $stableBootstrapToolUpdates = @()
        if ($AllowTestRoot -and [string]::Equals($Channel, 'stable', [StringComparison]::Ordinal) -and -not $rollbackFailed -and (Test-Path -LiteralPath $payloadBackupRoot)) {
            Remove-Item -LiteralPath $payloadBackupRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
finally {
    if ($null -ne $sourceChannelPairGuard) {
        try { $sourceChannelPairGuard.signature.stream.Dispose(); $sourceChannelPairGuard.channel.stream.Dispose() }
        catch { Write-Warning "Locked source channel cleanup failed: $($_.Exception.Message)" }
    }
    Exit-RevAgentGuards -Guards $sourceToolsTreeGuards
    Exit-RevAgentGuards -Guards $sourceReleaseTreeGuards
    Exit-RevAgentGuards -Guards $pilotImmutableTreeGuards
    if ($null -ne $pilotStablePairGuard) {
        try { $pilotStablePairGuard.signature.stream.Dispose(); $pilotStablePairGuard.channel.stream.Dispose() }
        catch { Write-Warning "Canonical stable pilot guard cleanup failed: $($_.Exception.Message)" }
    }
    Exit-RevAgentGuards -Guards @($destinationDirectoryGuards.ToArray())
    if ($null -ne $publishLease) {
        $leasePath = [string]$publishLease.path
        try {
            [RevAgent.SignedTransportNativeFileInfo]::MarkDeleteOnClose($publishLease.stream.SafeFileHandle)
            $publishLease.stream.Dispose()
            if (Test-Path -LiteralPath $leasePath -PathType Leaf) { throw "Exact lease handle closed but the owned lease path still exists: $leasePath" }
            $publishLockEvidence.leaseReleased = $true
        }
        catch { Write-Warning "NAS publish lease exact-handle cleanup failed: $($_.Exception.Message)" }
    }
    if ($publishMutexAcquired -and $null -ne $publishMutex) {
        try {
            $publishMutex.ReleaseMutex()
            if ($null -ne $publishLockEvidence) { $publishLockEvidence.mutexReleased = $true }
        }
        catch { Write-Warning "NAS publish mutex release failed: $($_.Exception.Message)" }
    }
    if ($null -ne $publishMutex) { $publishMutex.Dispose() }
    if ($null -ne $publishLockEvidence) {
        $publishLockEvidence.released = [bool]$publishLockEvidence.leaseReleased -and [bool]$publishLockEvidence.mutexReleased
    }
}

$aclTelemetry = Get-RevAgentOptionalAclTelemetry -ReleaseRoot $NasReleaseRoot

$result = [pscustomobject][ordered]@{
    success = $true
    action = "signed-source-free-nas-publish"
    transportTrust = "signed_local_snapshot"
    sourceReleaseRoot = $SourceReleaseRoot
    nasReleaseRoot = $NasReleaseRoot
    channel = $Channel
    version = $version
    channelPath = $stableChannelPath
    channelSignaturePath = $stableSignaturePath
    stableChannelPath = $stableChannelPath
    stableSignaturePath = $stableSignaturePath
    releaseDirectory = $nasReleaseDir
    readiness = $stableReadiness
    signedIdentity = [pscustomobject][ordered]@{
        baselineExists = [bool]$initialStableIdentity.exists
        baseline = $initialStableIdentity.artifact
        source = $sourceArtifactIdentity
        candidate = $candidateArtifactIdentity
        final = $finalArtifactIdentity
        sourceArtifactHandoff = [pscustomobject][ordered]@{
            expectedChannelSha256 = $ExpectedSourceChannelSha256
            actualLockedChannelSha256 = $lockedSourceChannelSha256
            verified = [bool]$sourceArtifactBindingVerified
        }
    }
    pilotIsolation = if ([string]::Equals($Channel, 'pilot', [StringComparison]::Ordinal)) {
        [pscustomobject][ordered]@{
            cohort = @($pilotMachines)
            stableUnchanged = $true
            sharedToolsUnchanged = $true
            activeStableReleaseUnchanged = $true
            heldHandleInvariantsVerified = [bool]($pilotStablePairHandlesVerified -and $pilotImmutableHandlesVerified -and $pilotDestinationHandlesVerified)
            stableBefore = $pilotStableBaseline.artifact
            stableAfter = $pilotStableFinal.artifact
            sharedToolsBefore = $pilotToolsBaseline
            sharedToolsAfter = $pilotToolsFinal
            activeStableReleaseBefore = $pilotStableReleaseBaseline
            activeStableReleaseAfter = $pilotStableReleaseFinal
        }
    } else { $null }
    stablePublish = if ([string]::Equals($Channel, 'stable', [StringComparison]::Ordinal)) {
        [pscustomobject][ordered]@{
            releaseTreeCreateNew = -not $AllowTestRoot
            sharedToolsTreeReplaced = [bool]$AllowTestRoot
            stableLauncher = $stableLauncherEvidence
            stableBootstrapTools = @($stableBootstrapToolEvidence)
            sharedToolsBefore = $stableToolsBaseline
            sharedToolsAfter = $stableToolsFinal
        }
    } else { $null }
    transportBoundary = [pscustomobject][ordered]@{
        canonicalRoot = $NasReleaseRoot
        sourceLinkSafety = $sourceTransportLinkSafety
        destinationLinkSafetyBefore = $destinationTransportLinkSafetyBefore
        destinationLinkSafetyAfterProbe = $destinationTransportLinkSafetyAfterProbe
        destinationLinkSafetyAfter = $destinationTransportLinkSafetyAfter
        writerCapability = $writerCapability
        publishLock = $publishLockEvidence
    }
    aclTelemetry = $aclTelemetry
    releaseAcl = [pscustomobject][ordered]@{
        required = $false
        mutationPerformed = $false
        status = [string]$aclTelemetry.status
        supported = [bool]$aclTelemetry.supported
        preview = $aclTelemetry.preview
    }
}

if ($OutputJson) {
    $result | ConvertTo-Json -Depth 16
}
else {
    $result
}
