<#
.SYNOPSIS
    Publish the current self-contained revAgent package to a NAS release root.

.DESCRIPTION
    Creates a versioned ZIP package, writes a release manifest, and optionally
    updates the channels\stable.json channel manifest.

    Commit/push does not deploy anything by itself. This script is the explicit
    "publish this version" step.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [ValidateSet("stable", "pilot")]
    [string]$Channel = "stable",

    [string[]]$PilotAllowedMachineNames = @(),

    [string]$Version = "",

    [string]$RepoRoot = "",

    [switch]$AllowDirty,

    [switch]$Force,

    # Authorizes deliberate signed rollback, equal releaseSequence repair,
    # and first signed bootstrap over a legacy stable channel that predates
    # releaseSequence. It does not bypass unreadable or invalid metadata.
    [switch]$AllowRollback,

    [string]$SigningPrivateKeyPath = "",

    [string]$SigningKeyId = "",

    [long]$ReleaseSequence = 0,

    [long]$MinimumAcceptedReleaseSequence = 0,

    [ValidateSet("revit-mcp-skill", "revAgent")]
    [string]$ReleaseAppId = "revAgent",

    [ValidateSet("revit-mcp-skill", "revAgent")]
    [string]$ReleasePackageBaseName = "revAgent",

    [switch]$RequireSigning,

    [string]$TrustedReleaseKeysPath = "",

    [switch]$AllowTestSigningIdentity,

    [switch]$NoChannelUpdate,

    [string]$NodeMsiPath = "",

    [Parameter(DontShow = $true)]
    [object]$StagingRootGuard = $null,

    [Parameter(DontShow = $true)]
    [scriptblock]$TestNodeMsiCreatedFailureCleanupHook = $null
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$script:RevAgentProductionSigningKeyId = 'revagent-prod-rsa-2026q3'
$script:RevAgentProductionSigningFingerprint = '32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33'
$script:RevAgentNodeMsiName = 'node-v24.14.1-x64.msi'
$script:RevAgentNodeMsiSha256 = 'FD8BA3E8262738959CAD50E6F6E71D689EAB7DD09FC7231B51D78ABE7852D4EC'
$script:RevAgentNodeMsiSizeBytes = [long]32387072
$script:RevAgentNodeMsiSignerSubject = 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'
if ($null -ne $TestNodeMsiCreatedFailureCleanupHook -and -not $AllowTestSigningIdentity) {
    throw 'TestNodeMsiCreatedFailureCleanupHook is limited to disposable test-signing roots.'
}

if (-not ('RevAgent.ReleaseAssetNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public static class ReleaseAssetNative {
        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME { public uint Low; public uint High; }

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION {
            public uint FileAttributes;
            public FILETIME CreationTime;
            public FILETIME LastAccessTime;
            public FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_DISPOSITION_INFO {
            [MarshalAs(UnmanagedType.Bool)]
            public bool DeleteFile;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(
            SafeFileHandle handle,
            int fileInformationClass,
            ref FILE_DISPOSITION_INFO fileInformation,
            uint bufferSize);

        private static BY_HANDLE_FILE_INFORMATION Read(SafeFileHandle handle) {
            if (handle == null || handle.IsInvalid) throw new ArgumentException("A valid file handle is required.");
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return information;
        }

        public static uint GetLinkCount(SafeFileHandle handle) { return Read(handle).NumberOfLinks; }
        public static uint GetAttributes(SafeFileHandle handle) { return Read(handle).FileAttributes; }

        public static FileStream CreateNewDeleteCapableStream(string path) {
            const uint GenericRead = 0x80000000;
            const uint GenericWrite = 0x40000000;
            const uint DeleteAccess = 0x00010000;
            const uint FileShareRead = 0x00000001;
            const uint CreateNew = 1;
            const uint FileAttributeNormal = 0x00000080;
            SafeFileHandle handle = CreateFile(
                path,
                GenericRead | GenericWrite | DeleteAccess,
                FileShareRead,
                IntPtr.Zero,
                CreateNew,
                FileAttributeNormal,
                IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Failed to create an exact delete-capable release asset.");
            }
            try {
                return new FileStream(handle, FileAccess.ReadWrite);
            }
            catch {
                handle.Dispose();
                throw;
            }
        }

        public static void MarkDeleteOnClose(SafeFileHandle handle) {
            if (handle == null || handle.IsInvalid) throw new ArgumentException("A valid file handle is required.");
            FILE_DISPOSITION_INFO information = new FILE_DISPOSITION_INFO { DeleteFile = true };
            if (!SetFileInformationByHandle(handle, 4, ref information, (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO)))) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to mark the exact release asset for delete-on-close.");
            }
        }
    }
}
'@
}

function Assert-RevAgentOrdinaryReleaseAssetPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Required release asset was not found: $fullPath"
    }
    $cursor = $fullPath
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) {
                throw "Release asset path contains a filesystem link/reparse component: $cursor"
            }
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or [string]::Equals($parent, $cursor, [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = $parent
    }
    return $fullPath
}

function Get-RevAgentLockedStreamSha256 {
    param([Parameter(Mandatory = $true)][IO.FileStream]$Stream)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    $originalPosition = $Stream.Position
    try {
        $Stream.Position = 0
        $buffer = New-Object byte[] 1048576
        while (($read = $Stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            [void]$algorithm.TransformBlock($buffer, 0, $read, $null, 0)
        }
        [void]$algorithm.TransformFinalBlock((New-Object byte[] 0), 0, 0)
        return ([BitConverter]::ToString($algorithm.Hash)).Replace('-', '')
    }
    finally {
        $Stream.Position = $originalPosition
        $algorithm.Dispose()
    }
}

function Copy-RevAgentPinnedNodeMsiSidecar {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [switch]$AllowTestIdentity,
        [switch]$AllowExistingIdentical
    )

    $sourceFullPath = Assert-RevAgentOrdinaryReleaseAssetPath -Path $SourcePath
    $destinationFullPath = [IO.Path]::GetFullPath($DestinationPath)
    $destinationParent = Split-Path -Parent $destinationFullPath
    if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) { throw "Release asset destination parent was not found: $destinationParent" }
    $destinationExists = Test-Path -LiteralPath $destinationFullPath
    if ($destinationExists -and -not (Test-Path -LiteralPath $destinationFullPath -PathType Leaf)) {
        throw "Release asset destination exists but is not a file: $destinationFullPath"
    }
    if ($destinationExists -and -not $AllowExistingIdentical) { throw "Release asset destination already exists: $destinationFullPath" }
    $reuseExisting = $destinationExists -and $AllowExistingIdentical

    $source = $null
    $destinationGuard = $null
    $algorithm = $null
    $completed = $false
    $destinationCreated = $false
    $operationError = $null
    $cleanupError = $null
    try {
        # Deny concurrent write/delete for the complete read/hash/copy window.
        $source = [IO.FileStream]::new($sourceFullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($source.Length -lt 1 -or $source.Length -gt 268435456) {
            throw "Node.js MSI size is outside the bounded release-asset policy. path=$sourceFullPath size=$($source.Length)"
        }
        if (-not $AllowTestIdentity -and $source.Length -ne $script:RevAgentNodeMsiSizeBytes) {
            throw "Node.js MSI size mismatch. expected=$($script:RevAgentNodeMsiSizeBytes) actual=$($source.Length)"
        }
        $sourceLinkCount = [uint32][RevAgent.ReleaseAssetNative]::GetLinkCount($source.SafeFileHandle)
        if ($sourceLinkCount -ne 1) { throw "Node.js MSI source must have exactly one hardlink reference. path=$sourceFullPath linkCount=$sourceLinkCount" }
        if (([RevAgent.ReleaseAssetNative]::GetAttributes($source.SafeFileHandle) -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Node.js MSI source is reparse-backed: $sourceFullPath"
        }
        [void](Assert-RevAgentOrdinaryReleaseAssetPath -Path $sourceFullPath)
        [long]$total = $source.Length
        $sha256 = Get-RevAgentLockedStreamSha256 -Stream $source
        if (-not $AllowTestIdentity -and -not [string]::Equals($sha256, $script:RevAgentNodeMsiSha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Node.js MSI SHA-256 mismatch. expected=$($script:RevAgentNodeMsiSha256) actual=$sha256"
        }
        $signature = $null
        if (-not $AllowTestIdentity) {
            # Verify Authenticode while the exact source is held deny-write/delete.
            # A create-new destination remains DELETE-capable and open until its
            # identity is proven, so pathname-based signature readers must not
            # compete with that handle. Exact destination hash/size equality
            # transfers this embedded-signature evidence byte-for-byte.
            $signature = Get-AuthenticodeSignature -LiteralPath $sourceFullPath
            if ($null -eq $signature -or $signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
                throw "Node.js MSI source Authenticode signature is not valid: $sourceFullPath"
            }
            if (-not [string]::Equals([string]$signature.SignerCertificate.Subject, $script:RevAgentNodeMsiSignerSubject, [StringComparison]::Ordinal)) {
                throw "Node.js MSI source signer mismatch. expected='$($script:RevAgentNodeMsiSignerSubject)' actual='$($signature.SignerCertificate.Subject)'"
            }
        }

        if ($reuseExisting) {
            [void](Assert-RevAgentOrdinaryReleaseAssetPath -Path $destinationFullPath)
            $destinationGuard = [IO.FileStream]::new($destinationFullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        }
        else {
            $destinationGuard = [RevAgent.ReleaseAssetNative]::CreateNewDeleteCapableStream($destinationFullPath)
            $destinationCreated = $true
            if ($null -ne $TestNodeMsiCreatedFailureCleanupHook) {
                & $TestNodeMsiCreatedFailureCleanupHook 'after_create' $destinationFullPath
            }
            $algorithm = [Security.Cryptography.SHA256]::Create()
            $buffer = New-Object byte[] 1048576
            [long]$copied = 0
            $source.Position = 0
            while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $copied += $read
                if ($copied -gt 268435456) { throw "Node.js MSI exceeded its byte bound while copying: $sourceFullPath" }
                [void]$algorithm.TransformBlock($buffer, 0, $read, $null, 0)
                $destinationGuard.Write($buffer, 0, $read)
            }
            [void]$algorithm.TransformFinalBlock((New-Object byte[] 0), 0, 0)
            $destinationGuard.Flush($true)
            $copySha256 = ([BitConverter]::ToString($algorithm.Hash)).Replace('-', '')
            if ($copied -ne $total -or -not [string]::Equals($copySha256, $sha256, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Node.js MSI copy did not preserve the locked source identity: $sourceFullPath"
            }
        }
        $destinationLinkCount = [uint32][RevAgent.ReleaseAssetNative]::GetLinkCount($destinationGuard.SafeFileHandle)
        if ($destinationLinkCount -ne 1) { throw "Release-owned Node.js MSI must have exactly one hardlink reference: $destinationFullPath" }
        if (([RevAgent.ReleaseAssetNative]::GetAttributes($destinationGuard.SafeFileHandle) -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Release-owned Node.js MSI is reparse-backed: $destinationFullPath"
        }
        [void](Assert-RevAgentOrdinaryReleaseAssetPath -Path $destinationFullPath)
        $destinationHash = Get-RevAgentLockedStreamSha256 -Stream $destinationGuard
        if (-not [string]::Equals($destinationHash, $sha256, [StringComparison]::OrdinalIgnoreCase) -or $destinationGuard.Length -ne $total) {
            throw "Release-owned Node.js MSI failed exact identity verification: $destinationFullPath"
        }

        if (-not $AllowTestIdentity -and $reuseExisting) {
            $existingSignature = Get-AuthenticodeSignature -LiteralPath $destinationFullPath
            if ($null -eq $existingSignature -or $existingSignature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
                throw "Existing Node.js MSI Authenticode signature is not valid: $destinationFullPath"
            }
            if (-not [string]::Equals([string]$existingSignature.SignerCertificate.Subject, $script:RevAgentNodeMsiSignerSubject, [StringComparison]::Ordinal)) {
                throw "Existing Node.js MSI signer mismatch. expected='$($script:RevAgentNodeMsiSignerSubject)' actual='$($existingSignature.SignerCertificate.Subject)'"
            }
            $signature = $existingSignature
        }
        $completed = $true
        return [pscustomobject][ordered]@{
            sourcePath = $sourceFullPath
            destinationPath = $destinationFullPath
            relativePath = "external\$($script:RevAgentNodeMsiName)"
            sha256 = $sha256
            sizeBytes = $total
            signerSubject = if ($null -ne $signature) { [string]$signature.SignerCertificate.Subject } else { 'TEST-ONLY' }
            authenticodeStatus = if ($null -ne $signature) { [string]$signature.Status } else { 'TestBypass' }
            sourceLinkCount = $sourceLinkCount
            destinationLinkCount = $destinationLinkCount
            reusedExisting = [bool]$reuseExisting
        }
    }
    catch { $operationError = $_ }
    finally {
        if ($destinationCreated -and -not $completed -and $null -ne $destinationGuard) {
            if ($null -ne $TestNodeMsiCreatedFailureCleanupHook) {
                try { & $TestNodeMsiCreatedFailureCleanupHook 'before_cleanup' $destinationFullPath }
                catch { $cleanupError = $_ }
            }
            try { [RevAgent.ReleaseAssetNative]::MarkDeleteOnClose($destinationGuard.SafeFileHandle) }
            catch {
                if ($null -eq $cleanupError) { $cleanupError = $_ }
                else {
                    $cleanupError = [Management.Automation.ErrorRecord]::new(
                        [InvalidOperationException]::new("Test cleanup hook and exact-handle delete-on-close both failed. hook=$($cleanupError.Exception.Message) delete=$($_.Exception.Message)"),
                        'node_msi_exact_handle_cleanup_failed',
                        [Management.Automation.ErrorCategory]::WriteError,
                        $destinationFullPath)
                }
            }
        }
        if ($null -ne $destinationGuard) {
            try { $destinationGuard.Dispose() }
            catch { if ($null -eq $cleanupError) { $cleanupError = $_ } }
        }
        if ($null -ne $algorithm) { $algorithm.Dispose() }
        if ($null -ne $source) { $source.Dispose() }
    }
    if ($null -ne $cleanupError) {
        $operationMessage = if ($null -ne $operationError) { $operationError.Exception.Message } else { '<none>' }
        throw "Node.js MSI operation failed and exact-handle cleanup was incomplete. operation=$operationMessage cleanup=$($cleanupError.Exception.Message)"
    }
    if ($null -ne $operationError) { throw $operationError }
}

function Assert-RevAgentLocalStagingRoot {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string[]]$AllowedPrefixes)

    $fullPath = [IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith('\\', [StringComparison]::Ordinal)) { throw 'UNC staging roots are forbidden.' }
    $pathRoot = [IO.Path]::GetPathRoot($fullPath)
    $drive = [IO.DriveInfo]::new($pathRoot)
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

function Assert-RevAgentAtomicStagingGuard {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [object]$Guard,
        [switch]$Required
    )

    if ($null -eq $Guard) {
        if ($Required) {
            throw 'Production signed release generation requires the handle-bound staging guard from invoke-signed-source-free-cd.ps1; direct production generation is disabled.'
        }
        return $null
    }
    if (-not ('RevAgent.CdStagingNative' -as [type])) {
        throw 'The supplied staging guard cannot be authenticated in this process.'
    }
    foreach ($propertyName in @('contractVersion', 'producer', 'path', 'parentPath', 'rootHandle', 'rootIdentity', 'parentHandle', 'parentIdentity')) {
        if ($null -eq $Guard.PSObject.Properties[$propertyName]) { throw "The supplied staging guard is missing '$propertyName'." }
    }
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($Guard.contractVersion -ne 1 -or
        -not [string]::Equals([string]$Guard.producer, 'invoke-signed-source-free-cd', [StringComparison]::Ordinal) -or
        -not [string]::Equals([IO.Path]::GetFullPath([string]$Guard.path).TrimEnd('\'), $fullPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([IO.Path]::GetFullPath([string]$Guard.parentPath).TrimEnd('\'), [IO.Path]::GetFullPath((Split-Path -Parent $fullPath)).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The supplied staging guard is not bound to this exact direct-child release root.'
    }
    if ($Guard.rootHandle.IsInvalid -or $Guard.rootHandle.IsClosed -or $Guard.parentHandle.IsInvalid -or $Guard.parentHandle.IsClosed) {
        throw 'The supplied staging guard handles are not live.'
    }
    $rootIdentity = [RevAgent.CdStagingNative]::GetIdentity($Guard.rootHandle)
    $parentIdentity = [RevAgent.CdStagingNative]::GetIdentity($Guard.parentHandle)
    if (($rootIdentity.FileAttributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ($parentIdentity.FileAttributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not [string]::Equals([string]$rootIdentity.StableId, [string]$Guard.rootIdentity.StableId, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$parentIdentity.StableId, [string]$Guard.parentIdentity.StableId, [StringComparison]::Ordinal)) {
        throw 'The supplied staging guard handle identity changed or is reparse-backed.'
    }
    $pathItem = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if (-not $pathItem.PSIsContainer -or ($pathItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$pathItem.LinkType)) {
        throw 'The supplied staging guard path is not an ordinary directory.'
    }
    return [pscustomobject][ordered]@{
        path = $fullPath
        rootStableId = [string]$rootIdentity.StableId
        parentStableId = [string]$parentIdentity.StableId
        handlesLive = $true
    }
}

$scriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptRoot)) {
    $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $scriptRoot "..\..")).Path
}

function Write-Section {
    param([string]$Message)
    Write-Host ""
    Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Get-GitValue {
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

function Assert-SafeVersion {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Version cannot be empty."
    }

    if ($Value -notmatch '^[A-Za-z0-9._-]+$') {
        throw "Version may only contain letters, numbers, dot, underscore, and dash: $Value"
    }
}

function Get-DefaultReleaseSequence {
    return [long]((Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss", [System.Globalization.CultureInfo]::InvariantCulture))
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

function Copy-DirectoryFiltered {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    $excludedDirectoryNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @(".git", ".vs", ".idea", ".vscode", "node_modules", "__pycache__", "bin", "obj", "packages", "dependencies")) {
        [void]$excludedDirectoryNames.Add($name)
    }

    $excludedFilePatterns = @("*.user", "*.suo", "*.tmp", "*.log")

    function Copy-OneDirectory {
        param(
            [string]$From,
            [string]$To
        )

        New-Item -ItemType Directory -Path $To -Force | Out-Null

        Get-ChildItem -LiteralPath $From -Force | ForEach-Object {
            if ($_.PSIsContainer) {
                if ($excludedDirectoryNames.Contains($_.Name)) {
                    return
                }

                Copy-OneDirectory -From $_.FullName -To (Join-Path $To $_.Name)
                return
            }

            foreach ($pattern in $excludedFilePatterns) {
                if ($_.Name -like $pattern) {
                    return
                }
            }

            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $To $_.Name) -Force
        }
    }

    Copy-OneDirectory -From $Source -To $Destination
}

function Copy-UserPackFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRelativePath,
        [string]$DestinationRelativePath = ""
    )

    if ([string]::IsNullOrWhiteSpace($DestinationRelativePath)) {
        $DestinationRelativePath = $SourceRelativePath
    }

    $sourcePath = Join-Path $RepoRoot $SourceRelativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required user-pack file was not found: $SourceRelativePath"
    }

    $destinationPath = Join-Path $packageRoot $DestinationRelativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
}

function Copy-UserPackDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRelativePath,
        [string]$DestinationRelativePath = "",
        [string[]]$ExcludeDirectoryNames = @(),
        [string[]]$ExcludeFilePatterns = @()
    )

    if ([string]::IsNullOrWhiteSpace($DestinationRelativePath)) {
        $DestinationRelativePath = $SourceRelativePath
    }

    $sourcePath = Join-Path $RepoRoot $SourceRelativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        throw "Required user-pack directory was not found: $SourceRelativePath"
    }

    $destinationPath = Join-Path $packageRoot $DestinationRelativePath
    if (Test-Path -LiteralPath $destinationPath) {
        Remove-Item -LiteralPath $destinationPath -Recurse -Force
    }

    $excludedDirs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $ExcludeDirectoryNames) {
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            [void]$excludedDirs.Add($name)
        }
    }

    function Copy-OneUserPackDirectory {
        param(
            [string]$From,
            [string]$To
        )

        New-Item -ItemType Directory -Path $To -Force | Out-Null

        Get-ChildItem -LiteralPath $From -Force | ForEach-Object {
            if ($_.PSIsContainer) {
                if ($excludedDirs.Contains($_.Name)) {
                    return
                }

                Copy-OneUserPackDirectory -From $_.FullName -To (Join-Path $To $_.Name)
                return
            }

            foreach ($pattern in $ExcludeFilePatterns) {
                if ($_.Name -like $pattern) {
                    return
                }
            }

            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $To $_.Name) -Force
        }
    }

    Copy-OneUserPackDirectory -From $sourcePath -To $destinationPath
}

function Copy-UserPackReleaseMcpPackage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRelativePath,
        [string]$DestinationRelativePath = ""
    )

    if ([string]::IsNullOrWhiteSpace($DestinationRelativePath)) {
        $DestinationRelativePath = $SourceRelativePath
    }

    $sourcePath = Join-Path $RepoRoot $SourceRelativePath
    $destinationPath = Join-Path $packageRoot $DestinationRelativePath
    $releasePath = Join-Path $sourcePath "release"
    $bundlePath = Join-Path $releasePath "index.js"
    $runtimePackageJson = Join-Path $releasePath "package.json"
    $runtimePackageLock = Join-Path $releasePath "package-lock.json"

    foreach ($requiredPath in @($bundlePath, $runtimePackageJson, $runtimePackageLock)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Required hardened MCP release artifact was not found: $requiredPath. Run npm run build:release in $SourceRelativePath."
        }
    }

    New-Item -ItemType Directory -Path (Join-Path $destinationPath "build") -Force | Out-Null
    Copy-Item -LiteralPath $bundlePath -Destination (Join-Path $destinationPath "build\index.js") -Force
    Copy-Item -LiteralPath $runtimePackageJson -Destination (Join-Path $destinationPath "package.json") -Force
    Copy-Item -LiteralPath $runtimePackageLock -Destination (Join-Path $destinationPath "package-lock.json") -Force

    $releaseSchemasPath = Join-Path $releasePath "schemas"
    if (Test-Path -LiteralPath $releaseSchemasPath -PathType Container) {
        $destinationSchemasPath = Join-Path $destinationPath "schemas"
        if (Test-Path -LiteralPath $destinationSchemasPath) {
            throw "Unexpected stale MCP schema destination: $destinationSchemasPath"
        }
        New-Item -ItemType Directory -Path $destinationSchemasPath -Force | Out-Null
        Get-ChildItem -LiteralPath $releaseSchemasPath -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $destinationSchemasPath -Recurse -Force
        }
    }
}

function Assert-RevAgentUserPackNoSourceLeak {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    function Get-RevAgentUserPackPathParts {
        param([string]$RelativePath)

        if ([string]::IsNullOrWhiteSpace($RelativePath)) {
            return @()
        }

        return @($RelativePath -split '[\\/]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }

    function Test-RevAgentUserPackIgnoredDependencyPath {
        param([string]$RelativePath)

        foreach ($part in Get-RevAgentUserPackPathParts -RelativePath $RelativePath) {
            if ($part -ieq "node_modules" -or $part -ieq "dependencies") {
                return $true
            }
        }

        return $false
    }

    $blocked = [System.Collections.Generic.List[string]]::new()
    $blockedDirectoryNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @(".git", ".github", ".githooks", ".tmp", "src", "docs", "evals", "references", "dashboard", "addons")) {
        [void]$blockedDirectoryNames.Add($name)
    }

    Get-ChildItem -LiteralPath $Root -Recurse -Directory -Force |
        ForEach-Object {
            $relative = $_.FullName.Substring($Root.Length).TrimStart("\", "/").Replace("/", "\")
            $parts = Get-RevAgentUserPackPathParts -RelativePath $relative
            if (Test-RevAgentUserPackIgnoredDependencyPath -RelativePath $relative) {
                return
            }
            if ($blockedDirectoryNames.Contains($_.Name) -or ($parts.Count -eq 1 -and $_.Name -eq "scripts")) {
                $blocked.Add($relative)
            }
        }

    Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
        ForEach-Object {
            $relative = $_.FullName.Substring($Root.Length).TrimStart("\", "/").Replace("/", "\")
            if (Test-RevAgentUserPackIgnoredDependencyPath -RelativePath $relative) {
                return
            }
            if ($_.Extension -in @(".cs", ".csproj", ".sln", ".ts", ".tsx", ".pdb", ".map")) {
                $blocked.Add($relative)
                return
            }
            if ($_.Name -like "*.test.js" -or $_.Name -like "*.guard-test.js") {
                $blocked.Add($relative)
                return
            }
            if ($_.Name -in @("publish-nas-release.ps1", "promote-nas-release.ps1")) {
                $blocked.Add($relative)
            }
        }

    if ($blocked.Count -gt 0) {
        $preview = @($blocked.ToArray() | Sort-Object | Select-Object -First 40)
        throw "User pack contains source/developer artifacts: $($preview -join ', ')"
    }
}

function Assert-RevAgentUserPackDotNetPayloadHardened {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $rootFullName = (Get-Item -LiteralPath $Root).FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $rootPrefix = $rootFullName + [System.IO.Path]::DirectorySeparatorChar
    $debugExtensions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($extension in @(".pdb", ".mdb")) {
        [void]$debugExtensions.Add($extension)
    }

    $debugArtifacts = @(Get-ChildItem -LiteralPath $rootFullName -Recurse -File -Force |
        Where-Object { $debugExtensions.Contains($_.Extension) } |
        ForEach-Object {
            if (-not $_.FullName.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "File '$($_.FullName)' is not under expected user pack root '$rootFullName'."
            }
            $_.FullName.Substring($rootPrefix.Length).Replace("/", "\")
        } |
        Sort-Object)

    if ($debugArtifacts.Count -gt 0) {
        $preview = @($debugArtifacts | Select-Object -First 40)
        throw "User pack .NET payload is not hardened; debug artifacts found: $($preview -join ', ')"
    }
}

function Test-JsonProperty {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Object,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return ($null -ne $Object) -and ($null -ne $Object.PSObject.Properties[$Name])
}

function Assert-RevAgentUserPackHardenedJsPayload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $issues = [System.Collections.Generic.List[string]]::new()

    foreach ($relativePackageRoot in @("installer\runtime-mcp-server", "installer\revit-api-docs-mcp")) {
        $packageRootPath = Join-Path $Root $relativePackageRoot
        $buildRoot = Join-Path $packageRootPath "build"
        if (-not (Test-Path -LiteralPath $buildRoot -PathType Container)) {
            $issues.Add("$relativePackageRoot missing build directory")
            continue
        }

        $buildRootAbs = (Get-Item -LiteralPath $buildRoot).FullName
        $buildFiles = @(Get-ChildItem -LiteralPath $buildRootAbs -Recurse -File -Force |
            ForEach-Object { $_.FullName.Substring($buildRootAbs.Length).TrimStart([char]"\", [char]"/").Replace("/", "\") } |
            Sort-Object)
        if (($buildFiles.Count -ne 1) -or ($buildFiles[0] -ne "index.js")) {
            $issues.Add("$relativePackageRoot build must contain only bundled index.js")
        }

        $bundlePath = Join-Path $buildRoot "index.js"
        if (Test-Path -LiteralPath $bundlePath -PathType Leaf) {
            $bundleText = Get-Content -Raw -LiteralPath $bundlePath
            if ($bundleText -match 'sourceMappingURL') {
                $issues.Add("$relativePackageRoot bundle must not include source map references")
            }
        }

        $packageJsonPath = Join-Path $packageRootPath "package.json"
        if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
            $issues.Add("$relativePackageRoot missing runtime package.json")
        }
        else {
            try {
                $packageJson = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json
            }
            catch {
                $issues.Add("$relativePackageRoot package.json is invalid JSON: $($_.Exception.Message)")
                $packageJson = $null
            }

            if ($null -eq $packageJson) {
                $issues.Add("$relativePackageRoot package.json is empty or invalid")
            }
            else {
                foreach ($blockedProperty in @("scripts", "devDependencies", "files")) {
                    if (Test-JsonProperty -Object $packageJson -Name $blockedProperty) {
                        $issues.Add("$relativePackageRoot package.json must not include $blockedProperty")
                    }
                }
            }
        }

        $packageLockPath = Join-Path $packageRootPath "package-lock.json"
        if (-not (Test-Path -LiteralPath $packageLockPath -PathType Leaf)) {
            $issues.Add("$relativePackageRoot missing runtime package-lock.json")
        }
        else {
            $packageLockText = Get-Content -Raw -LiteralPath $packageLockPath
            if ($packageLockText -match '"devDependencies"\s*:') {
                $issues.Add("$relativePackageRoot package-lock must not include devDependencies")
            }
            if ($packageLockText -match '"dev"\s*:\s*true') {
                $issues.Add("$relativePackageRoot package-lock must not include dev dependency entries")
            }
        }

        if ($relativePackageRoot -eq "installer\runtime-mcp-server") {
            $spatialSchemaNamesByVersion = @{
                "v0.1" = @("element-ref", "node-ref", "source-revision", "cursor-envelope", "spatial-snapshot", "extraction-page")
                "v0.2" = @("element-ref", "node-ref", "source-revision", "cursor-envelope", "spatial-snapshot", "extraction-page", "work-cursor-envelope", "work-continuation")
            }
            foreach ($schemaVersion in @("v0.1", "v0.2")) {
                foreach ($schemaName in $spatialSchemaNamesByVersion[$schemaVersion]) {
                    $schemaPath = Join-Path $packageRootPath "schemas\spatial\$schemaVersion\$schemaName.schema.json"
                    if (-not (Test-Path -LiteralPath $schemaPath -PathType Leaf)) {
                        $issues.Add("$relativePackageRoot missing published spatial schema $schemaVersion/$schemaName")
                    }
                }
            }
        }
    }

    if ($issues.Count -gt 0) {
        throw "User pack JavaScript payload is not hardened: $($issues.ToArray() -join '; ')"
    }
}

function Copy-RevAgentUserPack {
    Copy-UserPackFile -SourceRelativePath "installer\codex-user\SKILL.md" -DestinationRelativePath "SKILL.md"
    Copy-UserPackFile -SourceRelativePath "installer\codex-user\AGENTS.md" -DestinationRelativePath "AGENTS.md"
    Copy-UserPackDirectory -SourceRelativePath "installer\codex-user" -DestinationRelativePath "installer\codex-user"

    Copy-UserPackFile -SourceRelativePath "CHANGELOG.md"
    Copy-UserPackFile -SourceRelativePath "config\revit-versions.json"

    Copy-UserPackFile -SourceRelativePath "installer\install-self-contained.ps1"
    Copy-UserPackFile -SourceRelativePath "scripts\install-revagent-local-bootstrap.ps1" -DestinationRelativePath "installer\nas\install-revagent-local-bootstrap.ps1"
    Copy-UserPackFile -SourceRelativePath "scripts\New-RevAgentBootstrapPrestageEvidence.ps1" -DestinationRelativePath "installer\nas\New-RevAgentBootstrapPrestageEvidence.ps1"
    Copy-UserPackFile -SourceRelativePath "config\bootstrap-prestage-evidence.schema.json" -DestinationRelativePath "installer\nas\bootstrap-prestage-evidence.schema.json"
    Copy-UserPackFile -SourceRelativePath "config\bootstrap-prestage-evidence.example.json" -DestinationRelativePath "installer\nas\bootstrap-prestage-evidence.example.json"
    Copy-UserPackDirectory -SourceRelativePath "installer\lib"
    foreach ($nasTool in @("Start-revAgent-Update.ps1", "Start-revAgent-Update.cmd", "Install-revAgent-Updater-GUI.ps1", "Invoke-revAgent-PrivilegedSnapshotUpdate.ps1", "update-from-nas.ps1", "show-installed-version.ps1", "install-updater-task.ps1", "migrate-source-free-install.ps1", "Invoke-revAgent-CodexUserIntegration.ps1")) {
        Copy-UserPackFile -SourceRelativePath (Join-Path "installer\nas" $nasTool)
    }

    Copy-UserPackDirectory -SourceRelativePath "installer\revit-plugin" -ExcludeFilePatterns @("*.pdb", "*.map")
    Copy-UserPackDirectory -SourceRelativePath "installer\command-payload" -ExcludeFilePatterns @("*.pdb", "*.map")

    Copy-UserPackReleaseMcpPackage -SourceRelativePath "installer\runtime-mcp-server"

    Copy-UserPackReleaseMcpPackage -SourceRelativePath "installer\revit-api-docs-mcp"
    Copy-UserPackFile -SourceRelativePath "installer\revit-api-docs-mcp\scripts\build-index.ps1"
}

function Copy-RevAgentAdminAddonPayload {
    param(
        [Parameter(Mandatory = $true)][string]$AddonId,
        [Parameter(Mandatory = $true)][string[]]$DirectoryNames
    )

    $addonSource = Join-Path $RepoRoot (Join-Path "addons" $AddonId)
    if (-not (Test-Path -LiteralPath $addonSource -PathType Container)) {
        throw "Admin add-on source directory was not found: $addonSource"
    }

    $addonsTargetRoot = Join-Path $toolsRoot "addons"
    $addonTarget = Join-Path $addonsTargetRoot $AddonId
    if (Test-Path -LiteralPath $addonTarget) {
        Remove-Item -LiteralPath $addonTarget -Recurse -Force
    }
    New-Item -ItemType Directory -Path $addonTarget -Force | Out-Null

    Copy-Item -LiteralPath (Join-Path $addonSource "addon.json") -Destination (Join-Path $addonTarget "addon.json") -Force
    foreach ($directoryName in $DirectoryNames) {
        $sourceDirectory = Join-Path $addonSource $directoryName
        if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
            throw "Required admin add-on directory was not found: $sourceDirectory"
        }

        Copy-DirectoryFiltered -Source $sourceDirectory -Destination (Join-Path $addonTarget $directoryName)
    }
}

function Copy-RevAgentAdminAddonTools {
    $addonsTargetRoot = Join-Path $toolsRoot "addons"
    if (Test-Path -LiteralPath $addonsTargetRoot) {
        Remove-Item -LiteralPath $addonsTargetRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $addonsTargetRoot -Force | Out-Null

    Copy-RevAgentAdminAddonPayload -AddonId "dashboard" -DirectoryNames @("installer", "server", "public")
    Copy-RevAgentAdminAddonPayload -AddonId "usage-intelligence" -DirectoryNames @("installer", "scripts", "skills")
    Write-Host "Admin add-ons path: $addonsTargetRoot" -ForegroundColor Green
}

function Get-RelativeFileHash {
    param(
        [string]$Root,
        [string]$RelativePath
    )

    $path = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $path)) {
        return $null
    }

    $item = Get-Item -LiteralPath $path
    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $path

    return [ordered]@{
        path = $RelativePath
        sha256 = $hash.Hash
        sizeBytes = $item.Length
    }
}

function Get-DirectoryTreeHash {
    param(
        [string]$Root,
        [string]$RelativePath,
        [string[]]$ExcludeDirectoryNames = @("node_modules", ".git"),
        [string[]]$ExcludeFileNames = @(".revagent-npm-dependencies.json", ".npm-deps.sha256")
    )

    $path = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        return $null
    }

    $excluded = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $ExcludeDirectoryNames) {
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            [void]$excluded.Add($name)
        }
    }
    $excludedFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $ExcludeFileNames) {
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            [void]$excludedFiles.Add($name)
        }
    }

    $relativePaths = [System.Collections.Generic.List[string]]::new()
    Get-ChildItem -LiteralPath $path -Recurse -File -Force |
        Where-Object {
            if ($excludedFiles.Contains($_.Name)) {
                return $false
            }

            $relative = $_.FullName.Substring($path.Length).TrimStart("\", "/")
            $parts = $relative -split '[\\/]'
            foreach ($part in $parts) {
                if ($excluded.Contains($part)) {
                    return $false
                }
            }
            return $true
        } |
        ForEach-Object {
            [void]$relativePaths.Add($_.FullName.Substring($path.Length).TrimStart("\", "/").Replace("\", "/"))
        }

    # This digest is signed by pwsh in CD and consumed by Windows PowerShell 5.1.
    # Sort-Object uses runtime/culture collation, so keep the wire contract ordinal.
    $orderedRelativePaths = $relativePaths.ToArray()
    [System.Array]::Sort($orderedRelativePaths, [System.StringComparer]::Ordinal)

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($relative in $orderedRelativePaths) {
        $relativeOnDisk = $relative.Replace([char]"/", [System.IO.Path]::DirectorySeparatorChar)
        $filePath = Join-Path $path $relativeOnDisk
        $file = Get-Item -LiteralPath $filePath -Force
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $filePath).Hash
        [void]$lines.Add(("{0}|{1}|{2}" -f $relative, $file.Length, $hash))
    }

    $payload = [System.Text.Encoding]::UTF8.GetBytes(($lines.ToArray() -join "`n"))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash($payload)
    }
    finally {
        $sha.Dispose()
    }

    return [ordered]@{
        path = $RelativePath
        sha256 = ([System.BitConverter]::ToString($digest) -replace "-", "")
        fileCount = $lines.Count
    }
}

function ConvertTo-ComponentKey {
    param(
        [string]$Prefix,
        [string]$RelativePath
    )

    $normalized = ($RelativePath -replace '[\\/]+', '_' -replace '[^A-Za-z0-9_]+', '_').Trim("_")
    return "{0}{1}" -f $Prefix, $normalized
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [int]$Depth = 8
    )

    $Value | ConvertTo-Json -Depth $Depth | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-RevAgentPathPrefix {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/")
    return $fullPath + [System.IO.Path]::DirectorySeparatorChar
}

function Test-RevAgentPathUnderRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = Get-RevAgentPathPrefix -Path $Root
    return $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function New-RevAgentPublishSigningContext {
    param(
        [string]$PrivateKeyPath,
        [string]$KeyId,
        [string]$RepositoryRoot,
        [string]$NasToolsRoot,
        [switch]$AllowTestIdentity
    )

    $hasPrivateKeyPath = -not [string]::IsNullOrWhiteSpace($PrivateKeyPath)
    $hasKeyId = -not [string]::IsNullOrWhiteSpace($KeyId)
    if (-not $hasPrivateKeyPath -and -not $hasKeyId) {
        return $null
    }
    if (-not $hasPrivateKeyPath -or -not $hasKeyId) {
        throw "Release signing requires both -SigningPrivateKeyPath and -SigningKeyId."
    }

    $distributionIntegrityModule = Join-Path $RepositoryRoot "installer\lib\RevAgent.DistributionIntegrity.psm1"
    if (-not (Test-Path -LiteralPath $distributionIntegrityModule -PathType Leaf)) {
        throw "Distribution integrity helper module was not found."
    }

    $privateKeyFullPath = [System.IO.Path]::GetFullPath($PrivateKeyPath)
    if (Test-RevAgentPathUnderRoot -Path $privateKeyFullPath -Root $RepositoryRoot) {
        throw "Signing private key must be stored outside the repository."
    }
    if (Test-RevAgentPathUnderRoot -Path $privateKeyFullPath -Root $NasToolsRoot) {
        throw "Signing private key must be stored outside NAS tools."
    }
    if (-not (Test-Path -LiteralPath $privateKeyFullPath -PathType Leaf)) {
        throw "Signing private key file was not found."
    }

    Import-Module $distributionIntegrityModule -Force
    $privateKeyXml = Get-Content -Raw -LiteralPath $privateKeyFullPath -Encoding UTF8
    $publicKeyXml = Get-RevAgentPublicKeyXmlFromPrivateKeyXml -PrivateKeyXml $privateKeyXml
    $publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
    if (-not $AllowTestIdentity -and
        (-not [string]::Equals($KeyId, $script:RevAgentProductionSigningKeyId, [StringComparison]::Ordinal) -or
            -not [string]::Equals($publicKeyFingerprint, $script:RevAgentProductionSigningFingerprint, [StringComparison]::OrdinalIgnoreCase))) {
        throw "Production signing identity must be '$($script:RevAgentProductionSigningKeyId)' with fingerprint '$($script:RevAgentProductionSigningFingerprint)'."
    }

    $trustedKeys = @{}
    $trustedKeys[$KeyId] = [pscustomobject][ordered]@{
        publicKeyXml = $publicKeyXml
        publicKeyFingerprint = $publicKeyFingerprint
        algorithm = "RS256"
    }

    return [pscustomobject][ordered]@{
        keyId = $KeyId
        privateKeyXml = $privateKeyXml
        publicKeyFingerprint = $publicKeyFingerprint
        trustedKeys = $trustedKeys
    }
}

function Get-RevAgentPilotAllowedMachineNames {
    param([string[]]$Names)

    $normalized = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @($Names)) {
        $value = ([string]$name).Trim().ToUpperInvariant()
        if ([string]::IsNullOrWhiteSpace($value) -or $value -cnotmatch '^[A-Z0-9][A-Z0-9-]{0,62}$') {
            throw "Pilot machine names must be non-empty Windows computer names containing only A-Z, 0-9, and dash: '$name'"
        }
        if (-not $seen.Add($value)) { throw "Pilot machine allowlist contains a duplicate: $value" }
        [void]$normalized.Add($value)
    }
    return @($normalized.ToArray() | Sort-Object)
}

function Assert-RevAgentProductionTrustedKeysDocument {
    param([Parameter(Mandatory = $true)][string]$Path)
    $document = Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
    $properties = @($document.trustedKeys.PSObject.Properties)
    if ($properties.Count -ne 1 -or -not [string]::Equals([string]$properties[0].Name, $script:RevAgentProductionSigningKeyId, [StringComparison]::Ordinal)) {
        throw "Production trusted-key document must contain exactly one '$($script:RevAgentProductionSigningKeyId)' key."
    }
    $key = $properties[0].Value
    $computedFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml ([string]$key.publicKeyXml)
    if (-not [string]::Equals([string]$key.algorithm, 'RS256', [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$key.publicKeyFingerprint, $script:RevAgentProductionSigningFingerprint, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($computedFingerprint, $script:RevAgentProductionSigningFingerprint, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Production trusted-key document does not match the pinned RS256 release key.'
    }
}

function Write-RevAgentDetachedSignatureFile {
    param(
        [Parameter(Mandatory = $true)][object]$Content,
        [Parameter(Mandatory = $true)][string]$ContentPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [Parameter(Mandatory = $true)][string]$SignedObject,
        [Parameter(Mandatory = $true)][object]$SigningContext,
        [Parameter(Mandatory = $true)][string]$ReleaseAppId
    )

    $signatureEnvelope = New-RevAgentDetachedJsonSignature `
        -Content $Content `
        -SignedObject $SignedObject `
        -App $ReleaseAppId `
        -KeyId ([string]$SigningContext.keyId) `
        -PrivateKeyXml ([string]$SigningContext.privateKeyXml)
    Write-JsonFile -Value $signatureEnvelope -Path $SignaturePath -Depth 8

    $verification = Test-RevAgentDetachedJsonSignatureFile `
        -ContentPath $ContentPath `
        -SignaturePath $SignaturePath `
        -TrustedKeys ([hashtable]$SigningContext.trustedKeys) `
        -AllowedSignedObjects @($SignedObject)
    if (-not $verification.success) {
        throw "Detached signature verification failed after writing $SignedObject signature: $($verification.reason)"
    }
}

Write-Section "Validate repository"
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "SKILL.md"))) {
    throw "SKILL.md was not found under RepoRoot: $RepoRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\install-self-contained.ps1"))) {
    throw "Installer was not found under RepoRoot: $RepoRoot"
}

$commit = Get-GitValue -Repository $RepoRoot -Arguments @("rev-parse", "HEAD") -Fallback "unknown"
$shortCommit = if ($commit -ne "unknown" -and $commit.Length -ge 8) { $commit.Substring(0, 8) } else { "nogit" }
$commitCount = Get-GitValue -Repository $RepoRoot -Arguments @("rev-list", "--count", "HEAD") -Fallback "0"
if ($commitCount -notmatch '^\d+$') {
    $commitCount = "0"
}
$branch = Get-GitValue -Repository $RepoRoot -Arguments @("branch", "--show-current") -Fallback "unknown"
$dirtyStatus = Get-GitValue -Repository $RepoRoot -Arguments @("status", "--porcelain") -Fallback ""
$isDirty = -not [string]::IsNullOrWhiteSpace($dirtyStatus)

if ($isDirty -and -not $AllowDirty) {
    throw "Working tree has uncommitted changes. Commit first or pass -AllowDirty for a deliberate test package."
}

$pilotAllowedMachines = @(Get-RevAgentPilotAllowedMachineNames -Names $PilotAllowedMachineNames)
if ([string]::Equals($Channel, "pilot", [StringComparison]::Ordinal)) {
    if ($pilotAllowedMachines.Count -eq 0) {
        throw "Signed pilot releases require at least one -PilotAllowedMachineNames entry."
    }
}
elseif ($pilotAllowedMachines.Count -gt 0) {
    throw "PilotAllowedMachineNames is valid only when -Channel pilot is selected."
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = "{0}.{1}-{2}" -f (Get-Date -Format "yyyy.MM.dd"), $commitCount, $shortCommit
    if ([string]::Equals($Channel, "pilot", [StringComparison]::Ordinal)) { $Version += "-pilot" }
}
elseif ([string]::Equals($Channel, "pilot", [StringComparison]::Ordinal) -and $Version -notmatch '(?i)(?:^|[._-])pilot(?:[._-]|$)') {
    throw "Explicit pilot versions must contain a distinct 'pilot' segment so a later stable publish cannot reuse the same release directory: $Version"
}
Assert-SafeVersion -Value $Version

Write-Host "Repo    : $RepoRoot"
Write-Host "Branch  : $branch"
Write-Host "Commit  : $commit"
Write-Host "Dirty   : $isDirty"
Write-Host "Version : $Version"
Write-Host "Channel : $Channel"

Write-Section "Release preflight"
$payloadFreshnessScript = Join-Path $RepoRoot "scripts\test-mcp-build-payload-freshness.ps1"
if (-not (Test-Path -LiteralPath $payloadFreshnessScript -PathType Leaf)) {
    throw "Payload freshness preflight was not found: $payloadFreshnessScript"
}
& $payloadFreshnessScript -RepoRoot $RepoRoot
if ($LASTEXITCODE -ne 0) {
    throw "Payload freshness preflight failed."
}

Write-Section "Prepare release folders"
$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
$testReleasePrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$allowedStagingPrefixes = [Collections.Generic.List[string]]::new()
[void]$allowedStagingPrefixes.Add($testReleasePrefix)
if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_WORKSPACE)) {
    [void]$allowedStagingPrefixes.Add(([IO.Path]::GetFullPath($env:RUNNER_WORKSPACE).TrimEnd('\') + '\'))
}
$ReleaseRoot = Assert-RevAgentLocalStagingRoot -Path $ReleaseRoot -AllowedPrefixes @($allowedStagingPrefixes.ToArray())
$atomicStagingEvidence = Assert-RevAgentAtomicStagingGuard `
    -Path $ReleaseRoot `
    -Guard $StagingRootGuard `
    -Required:($RequireSigning -and -not $AllowTestSigningIdentity)
if ($AllowTestSigningIdentity -and
    -not $ReleaseRoot.StartsWith($testReleasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'AllowTestSigningIdentity is limited to disposable local release roots below TEMP.'
}
$releasesRoot = Join-Path $ReleaseRoot "releases"
$channelsRoot = Join-Path $ReleaseRoot "channels"
$toolsRoot = Join-Path $ReleaseRoot "tools"
$releaseDir = Join-Path $releasesRoot $Version
$signingContext = New-RevAgentPublishSigningContext `
    -PrivateKeyPath $SigningPrivateKeyPath `
    -KeyId $SigningKeyId `
    -RepositoryRoot $RepoRoot `
    -NasToolsRoot $toolsRoot `
    -AllowTestIdentity:$AllowTestSigningIdentity
if ($RequireSigning -and -not $signingContext) {
    throw "Release signing is required for this publish. Provide -SigningPrivateKeyPath and -SigningKeyId."
}
if ($signingContext -and -not $AllowTestSigningIdentity) {
    if ([string]::IsNullOrWhiteSpace($TrustedReleaseKeysPath)) { throw 'Production signed publish requires the pinned trusted-key document.' }
    $productionTrustedKeysPath = [IO.Path]::GetFullPath($TrustedReleaseKeysPath)
    if (-not (Test-Path -LiteralPath $productionTrustedKeysPath -PathType Leaf)) { throw "Trusted release keys file was not found: $productionTrustedKeysPath" }
    Assert-RevAgentProductionTrustedKeysDocument -Path $productionTrustedKeysPath
}
if ($ReleaseSequence -lt 0) {
    throw "ReleaseSequence must be zero or a positive integer."
}
if ($MinimumAcceptedReleaseSequence -lt 0) {
    throw "MinimumAcceptedReleaseSequence must be zero or a positive integer."
}
if ($MinimumAcceptedReleaseSequence -gt 0 -and $ReleaseSequence -le 0 -and -not $signingContext) {
    throw "MinimumAcceptedReleaseSequence requires a positive ReleaseSequence."
}
if ($signingContext) {
    if ($ReleaseSequence -eq 0) {
        $ReleaseSequence = Get-DefaultReleaseSequence
    }
    Write-Host "Release signing: enabled for keyId '$SigningKeyId'" -ForegroundColor Green
    Write-Host "Release sequence: $ReleaseSequence" -ForegroundColor Green
}
if ($MinimumAcceptedReleaseSequence -gt $ReleaseSequence) {
    throw "MinimumAcceptedReleaseSequence cannot be greater than ReleaseSequence."
}

$channelPath = Join-Path $channelsRoot ("{0}.json" -f $Channel)
if (-not $NoChannelUpdate) {
    $currentStableSequenceStatus = Get-RevAgentChannelReleaseSequenceStatus -Path $channelPath
    if ([bool]$currentStableSequenceStatus.exists -and -not [bool]$currentStableSequenceStatus.success) {
        if ($AllowRollback -and [string]::Equals([string]$currentStableSequenceStatus.reason, "missing_release_sequence", [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-Warning "Current stable channel has no releaseSequence; treating it as legacy sequence 0 because -AllowRollback was supplied."
        }
        else {
            throw "Refusing to publish because current stable releaseSequence could not be determined from '$channelPath'. Reason: $($currentStableSequenceStatus.reason). $($currentStableSequenceStatus.message)"
        }
    }
    $currentStableReleaseSequence = if ([bool]$currentStableSequenceStatus.success) { [long]$currentStableSequenceStatus.value } else { [long]0 }
    if ($currentStableReleaseSequence -gt 0 -and $ReleaseSequence -le $currentStableReleaseSequence -and -not $AllowRollback) {
        throw "Refusing to publish releaseSequence '$ReleaseSequence' over current stable '$currentStableReleaseSequence'. Pass -AllowRollback only for deliberate signed rollback or current-sequence repair."
    }
}

if (Test-Path -LiteralPath $releaseDir) {
    if (-not $Force) {
        throw "Release already exists: $releaseDir. Pass -Force to replace it."
    }
    Remove-Item -LiteralPath $releaseDir -Recurse -Force
}

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
New-Item -ItemType Directory -Path $channelsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null

$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revit-mcp-release-" + $Version + "-" + [Guid]::NewGuid().ToString("N"))
$packageRoot = Join-Path $stageRoot "package"
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

try {
    $nodeMsiEvidence = $null
    if ($RequireSigning -or $null -ne $signingContext -or -not [string]::IsNullOrWhiteSpace($NodeMsiPath)) {
        if ([string]::IsNullOrWhiteSpace($NodeMsiPath)) {
            throw 'Signed release generation requires -NodeMsiPath so the pinned Node.js installer can be bound into the signed versioned release.'
        }
        Write-Section "Stage signed external dependencies"
        $externalReleaseRoot = Join-Path $releaseDir 'external'
        New-Item -ItemType Directory -Path $externalReleaseRoot -Force | Out-Null
        $nodeMsiEvidence = Copy-RevAgentPinnedNodeMsiSidecar `
            -SourcePath $NodeMsiPath `
            -DestinationPath (Join-Path $externalReleaseRoot $script:RevAgentNodeMsiName) `
            -AllowTestIdentity:$AllowTestSigningIdentity
        Write-Host "Node.js MSI sidecar: $($nodeMsiEvidence.destinationPath)" -ForegroundColor Green

        # Keep the legacy tools dependency in the local CD artifact for a future
        # separately approved stable publish. Pilot publication copies only the
        # versioned release tree and therefore leaves NAS shared tools immutable.
        $dependenciesTarget = Join-Path $toolsRoot 'dependencies'
        New-Item -ItemType Directory -Path $dependenciesTarget -Force | Out-Null
        [void](Copy-RevAgentPinnedNodeMsiSidecar `
                -SourcePath $nodeMsiEvidence.destinationPath `
                -DestinationPath (Join-Path $dependenciesTarget $script:RevAgentNodeMsiName) `
                -AllowTestIdentity:$AllowTestSigningIdentity `
                -AllowExistingIdentical)
    }

    Write-Section "Stage package"
    Copy-RevAgentUserPack
    Assert-RevAgentUserPackNoSourceLeak -Root $packageRoot
    Assert-RevAgentUserPackDotNetPayloadHardened -Root $packageRoot
    Assert-RevAgentUserPackHardenedJsPayload -Root $packageRoot

    $releaseInfo = [ordered]@{
        schemaVersion = 1
        app = $ReleaseAppId
        version = $Version
        channel = $Channel
        git = [ordered]@{
            branch = $branch
            commit = $commit
            isDirty = $isDirty
        }
        publishedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    $releaseInfo | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $packageRoot "release-info.json") -Encoding UTF8

    Write-Section "Create ZIP"
    $zipPath = Join-Path $releaseDir ("{0}-{1}.zip" -f $ReleasePackageBaseName, $Version)
    $releaseRelativeDir = Join-Path "releases" $Version
    $manifestMetadataPath = (Join-Path ".." (Join-Path $releaseRelativeDir "manifest.json")).Replace("/", "\")
    $zipMetadataPath = (Join-Path ".." (Join-Path $releaseRelativeDir ("{0}-{1}.zip" -f $ReleasePackageBaseName, $Version))).Replace("/", "\")
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($packageRoot, $zipPath)

    $zipItem = Get-Item -LiteralPath $zipPath
    $zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash

    $componentPaths = [ordered]@{
        skill = "SKILL.md"
        agents = "AGENTS.md"
        changelog = "CHANGELOG.md"
        revitVersionMatrix = "config\revit-versions.json"
        installerLibHiddenLauncher = "installer\lib\RevAgent.HiddenLauncher.psm1"
        installerLibScheduledTask = "installer\lib\RevAgent.ScheduledTask.psm1"
        installerLibVersions = "installer\lib\RevAgent.RevitVersions.psm1"
        installerLibPackage = "installer\lib\RevAgent.Package.psm1"
        installerLibPermissions = "installer\lib\RevAgent.Permissions.psm1"
        installerLibSecureTemp = "installer\lib\RevAgent.SecureTemp.psm1"
        installerLibUpdatePolicy = "installer\lib\RevAgent.UpdatePolicy.psm1"
        installerLibProxy = "installer\lib\RevAgent.Proxy.psm1"
        installerLibLogRetention = "installer\lib\RevAgent.LogRetention.psm1"
        installerLibCodexRegistration = "installer\lib\RevAgent.CodexRegistration.psm1"
        installerLibConfigSync = "installer\lib\RevAgent.ConfigSync.psm1"
        installerLibDesktopLauncherCleanup = "installer\lib\RevAgent.DesktopLauncherCleanup.psm1"
        installerLibDistributionIntegrity = "installer\lib\RevAgent.DistributionIntegrity.psm1"
        installerLibLicense = "installer\lib\RevAgent.License.psm1"
        installerLibReporting = "installer\lib\RevAgent.Reporting.psm1"
        installerLibSourceFreeMigration = "installer\lib\RevAgent.SourceFreeMigration.psm1"
        installerLibLocalBootstrap = "installer\lib\RevAgent.LocalBootstrap.psm1"
        installerLibReleaseSnapshot = "installer\lib\RevAgent.ReleaseSnapshot.psm1"
        installer = "installer\install-self-contained.ps1"
        localBootstrapInstaller = "installer\nas\install-revagent-local-bootstrap.ps1"
        bootstrapPrestageEvidenceTool = "installer\nas\New-RevAgentBootstrapPrestageEvidence.ps1"
        bootstrapPrestageEvidenceSchema = "installer\nas\bootstrap-prestage-evidence.schema.json"
        bootstrapPrestageEvidenceExample = "installer\nas\bootstrap-prestage-evidence.example.json"
        localBootstrap = "installer\nas\Start-revAgent-Update.ps1"
        localBootstrapLauncher = "installer\nas\Start-revAgent-Update.cmd"
        updater = "installer\nas\update-from-nas.ps1"
        updaterGui = "installer\nas\Install-revAgent-Updater-GUI.ps1"
        privilegedSnapshotUpdate = "installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1"
        versionStatusTool = "installer\nas\show-installed-version.ps1"
        updaterTaskInstaller = "installer\nas\install-updater-task.ps1"
        sourceFreeMigrationTool = "installer\nas\migrate-source-free-install.ps1"
        codexUserIntegrationTool = "installer\nas\Invoke-revAgent-CodexUserIntegration.ps1"
        revitPlugin = "installer\revit-plugin\revAgentPlugin\revAgentPlugin.dll"
        commandSet = "installer\command-payload\revAgentCommandSet.dll"
        runtimeBundle = "installer\runtime-mcp-server\build\index.js"
        runtimePackageJson = "installer\runtime-mcp-server\package.json"
        runtimePackageLock = "installer\runtime-mcp-server\package-lock.json"
        docsServerBundle = "installer\revit-api-docs-mcp\build\index.js"
        docsPackageJson = "installer\revit-api-docs-mcp\package.json"
        docsPackageLock = "installer\revit-api-docs-mcp\package-lock.json"
    }

    $revitClosedRequiredComponentKeys = [System.Collections.Generic.List[string]]::new()
    $revitPayloadRelativePaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($key in @("revitPlugin", "commandSet")) {
        if ($componentPaths.Contains($key)) {
            [void]$revitClosedRequiredComponentKeys.Add($key)
            [void]$revitPayloadRelativePaths.Add([string]$componentPaths[$key])
        }
    }

    foreach ($payloadRoot in @("installer\revit-plugin", "installer\command-payload")) {
        $fullPayloadRoot = Join-Path $packageRoot $payloadRoot
        if (-not (Test-Path -LiteralPath $fullPayloadRoot -PathType Container)) {
            continue
        }

        Get-ChildItem -LiteralPath $fullPayloadRoot -Recurse -File |
            Sort-Object FullName |
            ForEach-Object {
                $relativePath = $_.FullName.Substring($packageRoot.Length + 1)
                if ($revitPayloadRelativePaths.Contains($relativePath)) {
                    return
                }

                $key = ConvertTo-ComponentKey -Prefix "revitPayload_" -RelativePath $relativePath
                $componentPaths[$key] = $relativePath
                [void]$revitPayloadRelativePaths.Add($relativePath)
                [void]$revitClosedRequiredComponentKeys.Add($key)
            }
    }

    $components = [ordered]@{}
    foreach ($entry in $componentPaths.GetEnumerator()) {
        $components[$entry.Key] = Get-RelativeFileHash -Root $packageRoot -RelativePath $entry.Value
    }
    $components["runtimePayload"] = Get-DirectoryTreeHash -Root $packageRoot -RelativePath "installer\runtime-mcp-server"
    $components["docsServerPayload"] = Get-DirectoryTreeHash -Root $packageRoot -RelativePath "installer\revit-api-docs-mcp"

    Write-Section "Write manifests"
    $manifestPath = Join-Path $releaseDir "manifest.json"
    $manifest = [ordered]@{
        schemaVersion = 1
        app = $ReleaseAppId
        version = $Version
        channel = $Channel
        publishedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        git = [ordered]@{
            branch = $branch
            commit = $commit
            isDirty = $isDirty
        }
        package = [ordered]@{
            fileName = (Split-Path -Leaf $zipPath)
            path = $zipMetadataPath
            sha256 = $zipHash
            sizeBytes = $zipItem.Length
        }
        installer = [ordered]@{
            entryPoint = "installer\install-self-contained.ps1"
            docsServerPath = "installer\revit-api-docs-mcp"
            sourceFreeMigrationTool = "installer\nas\migrate-source-free-install.ps1"
            codexUserIntegrationTool = "installer\nas\Invoke-revAgent-CodexUserIntegration.ps1"
            updaterMinimumVersion = "0.1.0"
        }
        updatePolicy = [ordered]@{
            revitClosedRequiredComponentKeys = @($revitClosedRequiredComponentKeys)
            revitClosedRequiredPaths = @(
                "installer\revit-plugin"
                "installer\command-payload"
            )
            revitCloseBehavior = "defer-user-save-sync"
        }
        components = $components
    }
    if ($null -ne $nodeMsiEvidence) {
        $manifest['externalDependencies'] = [ordered]@{
            nodeMsi = [ordered]@{
                schemaVersion = 1
                relativePath = [string]$nodeMsiEvidence.relativePath
                sha256 = [string]$nodeMsiEvidence.sha256
                sizeBytes = [long]$nodeMsiEvidence.sizeBytes
                signerSubject = [string]$nodeMsiEvidence.signerSubject
                authenticodeStatus = [string]$nodeMsiEvidence.authenticodeStatus
            }
        }
    }
    if ($ReleaseSequence -gt 0) {
        $manifest["releaseSequence"] = $ReleaseSequence
    }
    if ($MinimumAcceptedReleaseSequence -gt 0) {
        $manifest["minimumAcceptedReleaseSequence"] = $MinimumAcceptedReleaseSequence
    }
    if ([string]::Equals($Channel, "pilot", [StringComparison]::Ordinal)) {
        $manifest["pilotPolicy"] = [ordered]@{
            schemaVersion = 1
            allowedMachineNames = @($pilotAllowedMachines)
        }
    }
    $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    if ($signingContext) {
        $manifestSignaturePath = Join-Path $releaseDir "manifest.sig.json"
        Write-RevAgentDetachedSignatureFile `
            -Content $manifest `
            -ContentPath $manifestPath `
            -SignaturePath $manifestSignaturePath `
            -SignedObject "release-manifest" `
            -SigningContext $signingContext `
            -ReleaseAppId $ReleaseAppId
        Write-Host "Release manifest signature: $manifestSignaturePath" -ForegroundColor Green
    }

    if (-not $NoChannelUpdate) {
        $channelManifest = [ordered]@{
            schemaVersion = 1
            app = $ReleaseAppId
            channel = $Channel
            version = $Version
            publishedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
            manifestPath = $manifestMetadataPath
            packagePath = $zipMetadataPath
            sha256 = $zipHash
            git = [ordered]@{
                branch = $branch
                commit = $commit
                isDirty = $isDirty
            }
        }
        if ($ReleaseSequence -gt 0) {
            $channelManifest["releaseSequence"] = $ReleaseSequence
        }
        if ($MinimumAcceptedReleaseSequence -gt 0) {
            $channelManifest["minimumAcceptedReleaseSequence"] = $MinimumAcceptedReleaseSequence
        }
        if ([string]::Equals($Channel, "pilot", [StringComparison]::Ordinal)) {
            $channelManifest["pilotPolicy"] = [ordered]@{
                schemaVersion = 1
                allowedMachineNames = @($pilotAllowedMachines)
            }
        }
        Write-JsonFile -Value $channelManifest -Path $channelPath -Depth 8
        if ($signingContext) {
            $channelSignaturePath = Join-Path $channelsRoot ("{0}.sig.json" -f $Channel)
            Write-RevAgentDetachedSignatureFile `
                -Content $channelManifest `
                -ContentPath $channelPath `
                -SignaturePath $channelSignaturePath `
                -SignedObject "channel" `
                -SigningContext $signingContext `
                -ReleaseAppId $ReleaseAppId
            Write-Host "Channel signature: $channelSignaturePath" -ForegroundColor Green
        }
        Write-Host "Updated release manifest: $channelPath" -ForegroundColor Green
    }

    Write-Section "Refresh NAS tools"
    foreach ($toolName in @("Start-revAgent-Update.ps1", "Install-revAgent-Updater-GUI.ps1", "Install-Revit-MCP-Updater-GUI.ps1", "update-from-nas.ps1", "show-installed-version.ps1", "install-updater-task.ps1", "migrate-source-free-install.ps1", "Invoke-revAgent-CodexUserIntegration.ps1", "README.md")) {
        Copy-Item -LiteralPath (Join-Path $scriptRoot $toolName) -Destination (Join-Path $toolsRoot $toolName) -Force
    }
    Copy-Item -LiteralPath (Join-Path $RepoRoot "scripts\publish-desktop-launcher-evidence.ps1") -Destination (Join-Path $toolsRoot "publish-desktop-launcher-evidence.ps1") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "scripts\collect-rollout-evidence.ps1") -Destination (Join-Path $toolsRoot "collect-rollout-evidence.ps1") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "scripts\invoke-live-smoke-over-ssh.ps1") -Destination (Join-Path $toolsRoot "invoke-live-smoke-over-ssh.ps1") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "scripts\test-commandset-live.ps1") -Destination (Join-Path $toolsRoot "test-commandset-live.ps1") -Force
    $libSource = Join-Path (Split-Path -Parent $scriptRoot) "lib"
    if (Test-Path -LiteralPath $libSource -PathType Container) {
        $libTarget = Join-Path $toolsRoot "lib"
        if (Test-Path -LiteralPath $libTarget) {
            Remove-Item -LiteralPath $libTarget -Recurse -Force
        }
        Copy-DirectoryFiltered -Source $libSource -Destination $libTarget
        Write-Host "Tools lib path: $libTarget" -ForegroundColor Green
    }
    $configSource = Join-Path $RepoRoot "config"
    if (Test-Path -LiteralPath $configSource -PathType Container) {
        $configTarget = Join-Path $toolsRoot "config"
        if (Test-Path -LiteralPath $configTarget) {
            Remove-Item -LiteralPath $configTarget -Recurse -Force
        }
        Copy-DirectoryFiltered -Source $configSource -Destination $configTarget
        Write-Host "Tools config path: $configTarget" -ForegroundColor Green
    }
    elseif (-not [string]::IsNullOrWhiteSpace($TrustedReleaseKeysPath)) {
        $configTarget = Join-Path $toolsRoot "config"
        New-Item -ItemType Directory -Path $configTarget -Force | Out-Null
    }
    if (-not [string]::IsNullOrWhiteSpace($TrustedReleaseKeysPath)) {
        $trustedReleaseKeysFullPath = [System.IO.Path]::GetFullPath($TrustedReleaseKeysPath)
        if (-not (Test-Path -LiteralPath $trustedReleaseKeysFullPath -PathType Leaf)) {
            throw "Trusted release keys file was not found: $trustedReleaseKeysFullPath"
        }
        $trustedReleaseKeysTarget = Join-Path (Join-Path $toolsRoot "config") "release-trusted-keys.json"
        New-Item -ItemType Directory -Path (Split-Path -Parent $trustedReleaseKeysTarget) -Force | Out-Null
        Copy-Item -LiteralPath $trustedReleaseKeysFullPath -Destination $trustedReleaseKeysTarget -Force
        Write-Host "Trusted release keys: $trustedReleaseKeysTarget" -ForegroundColor Green
    }
    if ($null -ne $nodeMsiEvidence) {
        Write-Host "Dependencies path: $(Join-Path $toolsRoot 'dependencies')" -ForegroundColor Green
    }
    Copy-RevAgentAdminAddonTools
    foreach ($legacyCmd in @(Get-ChildItem -LiteralPath $toolsRoot -File -Filter "*.cmd" -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $legacyCmd.FullName -Force -ErrorAction Stop
    }
    $remainingToolCmds = @(Get-ChildItem -LiteralPath $toolsRoot -Recurse -File -Filter "*.cmd" -ErrorAction Stop)
    if ($remainingToolCmds.Count -gt 0) {
        throw "Production NAS tools tree must not contain CMD launchers: $(@($remainingToolCmds | Select-Object -ExpandProperty FullName) -join '; ')"
    }
    Write-Host "Tools path: $toolsRoot" -ForegroundColor Green

    Write-Host "Release package: $zipPath" -ForegroundColor Green
    Write-Host "Release manifest: $manifestPath" -ForegroundColor Green
    if ($null -ne $StagingRootGuard) {
        $atomicStagingEvidence = Assert-RevAgentAtomicStagingGuard -Path $ReleaseRoot -Guard $StagingRootGuard -Required
        Write-Host "Staging root guard: $($atomicStagingEvidence.rootStableId)" -ForegroundColor Green
    }
}
finally {
    if (Test-Path -LiteralPath $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}
