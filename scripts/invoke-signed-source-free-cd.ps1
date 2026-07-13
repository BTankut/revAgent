<#
.SYNOPSIS
    Build and validate a signed source-free revAgent release root for CD.

.DESCRIPTION
    This script is the GitHub Actions CD producer entrypoint. It runs the
    CI-safe engineering gates, calls the existing source-free NAS publisher
    against a staging release root, requires detached release signatures, and
    runs the signed-stable readiness preflight before the artifact is staged
    for optional NAS publish.

    It does not publish to production NAS by itself.
#>

[CmdletBinding()]
param(
    [string]$ReleaseRoot = "",
    [string]$TrustedKeysPath = "",
    [string]$SigningPrivateKeyPath = "",
    [string]$SigningKeyId = "",
    [string]$Version = "",
    [long]$ReleaseSequence = 0,
    [long]$MinimumAcceptedReleaseSequence = 0,
    [ValidateSet("revit-mcp-skill", "revAgent")]
    [string]$ReleaseAppId = "revAgent",
    [ValidateSet("revit-mcp-skill", "revAgent")]
    [string]$ReleasePackageBaseName = "revAgent",
    [ValidateSet("stable", "pilot")]
    [string]$Channel = "stable",
    [string[]]$PilotAllowedMachineNames = @(),
    [switch]$SkipEngineeringGates,
    [switch]$AllowDirty,
    [switch]$AllowNonMain,
    [switch]$Force,
    [switch]$OutputJson,
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
$productionSigningKeyId = 'revagent-prod-rsa-2026q3'
$productionSigningFingerprint = '32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

function Get-RevAgentCdGitValue {
    param(
        [string]$Repository,
        [string[]]$Arguments,
        [string]$Fallback = ""
    )

    try {
        $value = & git -C $Repository @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) {
            return $Fallback
        }
        return (($value | Out-String).Trim())
    }
    catch {
        return $Fallback
    }
}

if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-signed-release-root-" + [Guid]::NewGuid().ToString("N"))
}
$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
$stagingPrefixes = [Collections.Generic.List[string]]::new()
[void]$stagingPrefixes.Add(([IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'))
if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_WORKSPACE)) {
    [void]$stagingPrefixes.Add(([IO.Path]::GetFullPath($env:RUNNER_WORKSPACE).TrimEnd('\') + '\'))
}

function Assert-RevAgentCdLocalStagingRoot {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string[]]$AllowedPrefixes)
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith('\\', [StringComparison]::Ordinal)) { throw 'UNC staging roots are forbidden.' }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($fullPath))
    if (-not $drive.IsReady -or $drive.DriveType -notin @([IO.DriveType]::Fixed, [IO.DriveType]::Removable, [IO.DriveType]::Ram)) {
        throw "Staging root must use a ready local fixed/removable/RAM drive; drive type is $($drive.DriveType)."
    }
    $underAllowedPrefix = @($AllowedPrefixes | Where-Object {
            $prefix = [IO.Path]::GetFullPath($_).TrimEnd('\')
            [string]::Equals($fullPath.TrimEnd('\'), $prefix, [StringComparison]::OrdinalIgnoreCase) -or
                $fullPath.StartsWith($prefix + '\', [StringComparison]::OrdinalIgnoreCase)
        }).Count -gt 0
    if (-not $underAllowedPrefix) { throw 'Staging root is outside TEMP and RUNNER_WORKSPACE.' }
    $cursor = $fullPath
    while (-not (Test-Path -LiteralPath $cursor)) {
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or [string]::Equals($parent, $cursor, [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = $parent
    }
    while (-not [string]::IsNullOrWhiteSpace($cursor) -and (Test-Path -LiteralPath $cursor)) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
            throw "Staging root ancestor chain contains a reparse/link path: $cursor"
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or [string]::Equals($parent, $cursor, [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = $parent
    }
    return $fullPath
}
$ReleaseRoot = Assert-RevAgentCdLocalStagingRoot -Path $ReleaseRoot -AllowedPrefixes @($stagingPrefixes.ToArray())

if (-not ('RevAgent.CdStagingNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public sealed class CdStagingIdentity {
        public uint VolumeSerialNumber { get; set; }
        public ulong FileIndex { get; set; }
        public uint NumberOfLinks { get; set; }
        public uint FileAttributes { get; set; }
        public string StableId { get { return VolumeSerialNumber.ToString("X8") + ":" + FileIndex.ToString("X16"); } }
    }

    public static class CdStagingNative {
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
        [StructLayout(LayoutKind.Sequential)] private struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
        [StructLayout(LayoutKind.Sequential)] private struct OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
        [StructLayout(LayoutKind.Sequential)] private struct IO_STATUS_BLOCK { public IntPtr Status; public UIntPtr Information; }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);
        [DllImport("ntdll.dll")]
        private static extern int NtCreateFile(out SafeFileHandle fileHandle, uint desiredAccess, ref OBJECT_ATTRIBUTES objectAttributes, out IO_STATUS_BLOCK ioStatusBlock, IntPtr allocationSize, uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
        [DllImport("ntdll.dll")]
        private static extern uint RtlNtStatusToDosError(int status);

        private const uint FILE_READ_ATTRIBUTES = 0x0080;
        private const uint DELETE = 0x00010000;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint OBJ_CASE_INSENSITIVE = 0x00000040;
        private const uint FILE_CREATE = 2;
        private const uint FILE_DIRECTORY_FILE = 0x00000001;
        private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
        private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;

        public static SafeFileHandle OpenDirectoryNoDelete(string path) {
            SafeFileHandle handle = CreateFileW(path, FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error, "Could not open exact staging parent: " + path); }
            return handle;
        }

        public static SafeFileHandle CreateDirectoryRelativeNoDelete(SafeFileHandle parentHandle, string leafName) {
            if (String.IsNullOrWhiteSpace(leafName) || leafName.IndexOfAny(new[] { '\\', '/', ':' }) >= 0 || leafName == "." || leafName == "..") throw new ArgumentException("Staging leaf name is invalid.", "leafName");
            IntPtr textBuffer = IntPtr.Zero;
            IntPtr unicodeBuffer = IntPtr.Zero;
            try {
                textBuffer = Marshal.StringToHGlobalUni(leafName);
                UNICODE_STRING name = new UNICODE_STRING { Length = checked((ushort)(leafName.Length * 2)), MaximumLength = checked((ushort)((leafName.Length + 1) * 2)), Buffer = textBuffer };
                unicodeBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
                Marshal.StructureToPtr(name, unicodeBuffer, false);
                OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES { Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)), RootDirectory = parentHandle.DangerousGetHandle(), ObjectName = unicodeBuffer, Attributes = OBJ_CASE_INSENSITIVE, SecurityDescriptor = IntPtr.Zero, SecurityQualityOfService = IntPtr.Zero };
                IO_STATUS_BLOCK statusBlock;
                SafeFileHandle result;
                int status = NtCreateFile(out result, FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE, ref attributes, out statusBlock, IntPtr.Zero, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_CREATE, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, IntPtr.Zero, 0);
                if (status < 0 || result == null || result.IsInvalid) { uint error = RtlNtStatusToDosError(status); if (result != null) result.Dispose(); throw new Win32Exception(unchecked((int)error), "Could not atomically create exact staging leaf: " + leafName); }
                return result;
            }
            finally {
                if (unicodeBuffer != IntPtr.Zero) Marshal.FreeHGlobal(unicodeBuffer);
                if (textBuffer != IntPtr.Zero) Marshal.FreeHGlobal(textBuffer);
            }
        }

        public static CdStagingIdentity GetIdentity(SafeFileHandle handle) {
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new CdStagingIdentity { VolumeSerialNumber = information.VolumeSerialNumber, FileIndex = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow, NumberOfLinks = information.NumberOfLinks, FileAttributes = information.FileAttributes };
        }
    }
}
'@
}

function New-RevAgentCdStagingGuard {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (Test-Path -LiteralPath $fullPath) { throw "Signed staging leaf already exists; refusing cleanup or reuse: $fullPath" }
    $parentPath = [IO.Path]::GetFullPath((Split-Path -Parent $fullPath)).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $parentPath -PathType Container)) {
        throw "Signed staging root must be one direct new leaf below an existing local parent: $parentPath"
    }
    $leafName = Split-Path -Leaf $fullPath
    $parentHandle = [RevAgent.CdStagingNative]::OpenDirectoryNoDelete($parentPath)
    $rootHandle = $null
    try {
        $parentIdentity = [RevAgent.CdStagingNative]::GetIdentity($parentHandle)
        if (($parentIdentity.FileAttributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Signed staging parent is reparse-backed: $parentPath" }
        $rootHandle = [RevAgent.CdStagingNative]::CreateDirectoryRelativeNoDelete($parentHandle, $leafName)
        $rootIdentity = [RevAgent.CdStagingNative]::GetIdentity($rootHandle)
        if (($rootIdentity.FileAttributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Atomically created staging root is reparse-backed: $fullPath" }
        $pathItem = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
        if (-not $pathItem.PSIsContainer -or ($pathItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$pathItem.LinkType)) {
            throw "Atomically created staging path is not an exact ordinary directory: $fullPath"
        }
        return [pscustomobject][ordered]@{
            contractVersion = 1
            producer = 'invoke-signed-source-free-cd'
            path = $fullPath
            parentPath = $parentPath
            rootHandle = $rootHandle
            rootIdentity = $rootIdentity
            parentHandle = $parentHandle
            parentIdentity = $parentIdentity
        }
    }
    catch {
        if ($null -ne $rootHandle) { $rootHandle.Dispose() }
        $parentHandle.Dispose()
        throw
    }
}

if ([string]::IsNullOrWhiteSpace($SigningPrivateKeyPath)) {
    throw "SigningPrivateKeyPath is required for signed source-free CD."
}
if ([string]::IsNullOrWhiteSpace($SigningKeyId)) {
    throw "SigningKeyId is required for signed source-free CD."
}
if ([string]::IsNullOrWhiteSpace($TrustedKeysPath)) {
    throw "TrustedKeysPath is required for signed source-free CD readiness verification."
}

$trustedKeysFullPath = [System.IO.Path]::GetFullPath($TrustedKeysPath)
if (-not (Test-Path -LiteralPath $trustedKeysFullPath -PathType Leaf)) {
    throw "Trusted release keys file was not found: $trustedKeysFullPath"
}
$testSigningIdentity = [bool]($AllowDirty -or $AllowNonMain)
if (-not $testSigningIdentity) {
    if (-not [string]::Equals($SigningKeyId, $productionSigningKeyId, [StringComparison]::Ordinal)) {
        throw "Production signed source-free CD requires signing key '$productionSigningKeyId'."
    }
    Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1') -Force
    $trustedDocument = Get-Content -Raw -LiteralPath $trustedKeysFullPath -Encoding UTF8 | ConvertFrom-Json
    $trustedProperties = @($trustedDocument.trustedKeys.PSObject.Properties)
    if ($trustedProperties.Count -ne 1 -or -not [string]::Equals([string]$trustedProperties[0].Name, $productionSigningKeyId, [StringComparison]::Ordinal)) {
        throw "Production trusted-key document must contain exactly one '$productionSigningKeyId' key."
    }
    $trustedKey = $trustedProperties[0].Value
    $computedFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml ([string]$trustedKey.publicKeyXml)
    if (-not [string]::Equals([string]$trustedKey.algorithm, 'RS256', [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$trustedKey.publicKeyFingerprint, $productionSigningFingerprint, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($computedFingerprint, $productionSigningFingerprint, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Production trusted-key document does not match the pinned RS256 release key.'
    }
}

$refName = [string]$env:GITHUB_REF_NAME
$branch = Get-RevAgentCdGitValue -Repository $RepoRoot -Arguments @("branch", "--show-current") -Fallback ""
$effectiveBranch = if (-not [string]::IsNullOrWhiteSpace($refName)) { $refName } else { $branch }
if (-not $AllowNonMain -and -not [string]::Equals($effectiveBranch, "main", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Signed source-free CD must run from main. Current ref/branch: '$effectiveBranch'. Pass -AllowNonMain only for local dry-run validation."
}

$dirtyStatus = Get-RevAgentCdGitValue -Repository $RepoRoot -Arguments @("status", "--porcelain") -Fallback ""
$isDirty = -not [string]::IsNullOrWhiteSpace($dirtyStatus)
if ($isDirty -and -not $AllowDirty) {
    throw "Signed source-free CD requires a clean tree. Commit first or pass -AllowDirty for an explicit non-production test artifact."
}

if (-not $SkipEngineeringGates) {
    & (Join-Path $RepoRoot "scripts\test-ci.ps1") -RepoRoot $RepoRoot
}

$stagingGuard = New-RevAgentCdStagingGuard -Path $ReleaseRoot
try {
$publishArgs = @{
    ReleaseRoot = $ReleaseRoot
    Channel = $Channel
    RepoRoot = $RepoRoot
    SigningPrivateKeyPath = $SigningPrivateKeyPath
    SigningKeyId = $SigningKeyId
    ReleaseSequence = $ReleaseSequence
    MinimumAcceptedReleaseSequence = $MinimumAcceptedReleaseSequence
    ReleaseAppId = $ReleaseAppId
    ReleasePackageBaseName = $ReleasePackageBaseName
    TrustedReleaseKeysPath = $trustedKeysFullPath
    RequireSigning = $true
    PilotAllowedMachineNames = @($PilotAllowedMachineNames)
    StagingRootGuard = $stagingGuard
}
if (-not [string]::IsNullOrWhiteSpace($Version)) {
    $publishArgs["Version"] = $Version
}
if ($AllowDirty) {
    $publishArgs["AllowDirty"] = $true
}
if ($testSigningIdentity) {
    $publishArgs["AllowTestSigningIdentity"] = $true
}
if ($Force) {
    $publishArgs["Force"] = $true
}

& (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1") @publishArgs

$readiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
    -ReleaseRoot $ReleaseRoot `
    -ChannelManifestPath (Join-Path $ReleaseRoot "channels\$Channel.json") `
    -TrustedKeysPath $trustedKeysFullPath `
    -RepoRoot $RepoRoot

$channelPath = Join-Path $ReleaseRoot "channels\$Channel.json"
$channelDocument = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json

$result = [pscustomobject][ordered]@{
    success = [bool]$readiness.success
    action = "signed-source-free-cd-build"
    releaseRoot = $ReleaseRoot
    channel = $Channel
    app = [string]$channelDocument.app
    version = [string]$channelDocument.version
    releaseSequence = if ($channelDocument.PSObject.Properties["releaseSequence"]) { [long]$channelDocument.releaseSequence } else { [long]0 }
    trustedKeysPath = $trustedKeysFullPath
    readiness = $readiness
}

if ($OutputJson) {
    $result | ConvertTo-Json -Depth 16
}
else {
    $result
}
}
finally {
    if ($null -ne $stagingGuard) {
        try { $stagingGuard.rootHandle.Dispose() } finally { $stagingGuard.parentHandle.Dispose() }
    }
}
