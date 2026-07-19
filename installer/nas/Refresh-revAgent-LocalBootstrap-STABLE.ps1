<#
.SYNOPSIS
    Fail-closed stable bootstrap trust gate requiring supervised manual prestage when no independent signing trust anchor exists.
#>

[CmdletBinding()]
param(
    [string]$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy",
    [ValidateSet("stable")][string]$Channel = "stable",
    [switch]$ElevatedApply,
    [string]$SourceRoot = "",
    [string]$EvidenceSource = "",
    [string]$ExpectedEvidenceSha256 = "",
    [string]$ExpectedInstallerSha256 = "",
    [string]$ExpectedRefreshScriptSha256 = "",
    [string]$TrustedKeysSource = "",
    [switch]$CoordinatorRelaunchedFromAdmin,
    [string]$CoordinatorNonce = "",
    [string]$CoordinatorResultPath = ""
)

if ("$($ExecutionContext.SessionState.LanguageMode)" -ne 'FullLanguage') {
    Write-Host "revAgent updater cannot run: PowerShell is in $($ExecutionContext.SessionState.LanguageMode) mode."
    Write-Host "This is typically caused by Smart App Control or a WDAC/AppLocker policy on this machine."
    Write-Host "Ask IT to exempt/sign the revAgent deployment scripts or disable Smart App Control, then retry."
    exit 78
}

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:RevAgentExitUacDeclined = 79
$script:RevAgentExitCoordinatorAlreadyRunning = 80
$script:RevAgentExitCoordinatorTimeout = 81
$script:RevAgentExitUacDisabled = 82
$script:RevAgentExitBootstrapTrustRequired = 84

function Resolve-RevAgentTrustedArchiveManifest {
    param(
        [Parameter(Mandatory = $true)][string]$PsHomeModulesRoot,
        [Parameter(Mandatory = $true)][string[]]$ProgramFilesModuleRoots
    )

    $searchedPaths = [System.Collections.Generic.List[string]]::new()
    $psHomeManifest = [IO.Path]::Combine($PsHomeModulesRoot, 'Microsoft.PowerShell.Archive', 'Microsoft.PowerShell.Archive.psd1')
    [void]$searchedPaths.Add($psHomeManifest)
    if ([IO.File]::Exists($psHomeManifest)) { return [IO.Path]::GetFullPath($psHomeManifest) }

    $seenRoots = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($moduleRoot in $ProgramFilesModuleRoots) {
        if ([string]::IsNullOrWhiteSpace($moduleRoot)) { continue }
        $fullModuleRoot = [IO.Path]::GetFullPath($moduleRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        if (-not $seenRoots.Add($fullModuleRoot)) { continue }
        $archiveRoot = [IO.Path]::Combine($fullModuleRoot, 'Microsoft.PowerShell.Archive')
        $directManifest = [IO.Path]::Combine($archiveRoot, 'Microsoft.PowerShell.Archive.psd1')
        [void]$searchedPaths.Add($directManifest)
        if (-not [IO.Directory]::Exists($fullModuleRoot)) { continue }
        if (([IO.File]::GetAttributes($fullModuleRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Trusted PowerShell module root is a reparse point: $fullModuleRoot" }
        if (-not [IO.Directory]::Exists($archiveRoot)) { continue }
        if (([IO.File]::GetAttributes($archiveRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Trusted PowerShell Archive module root is a reparse point: $archiveRoot" }
        if ([IO.File]::Exists($directManifest)) { return $directManifest }

        $versionedManifests = [System.Collections.Generic.List[object]]::new()
        foreach ($versionDirectory in [IO.Directory]::EnumerateDirectories($archiveRoot)) {
            if (([IO.File]::GetAttributes($versionDirectory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Trusted PowerShell Archive version directory is a reparse point: $versionDirectory" }
            $parsedVersion = $null
            if (-not [version]::TryParse([IO.Path]::GetFileName($versionDirectory), [ref]$parsedVersion)) { continue }
            $manifest = [IO.Path]::Combine($versionDirectory, 'Microsoft.PowerShell.Archive.psd1')
            [void]$searchedPaths.Add($manifest)
            if ([IO.File]::Exists($manifest)) { [void]$versionedManifests.Add([pscustomobject]@{ Version = $parsedVersion; Path = $manifest }) }
        }
        $selected = @($versionedManifests | Sort-Object Version -Descending | Select-Object -First 1)
        if ($selected.Count -eq 1) { return [string]$selected[0].Path }
    }

    throw "Required trusted PowerShell Archive module was not found. Searched paths: $([string]::Join('; ', $searchedPaths.ToArray()))"
}

function Initialize-TrustedPowerShellModules {
    $systemDirectory = [Environment]::SystemDirectory
    $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
    $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    $candidateRoots = [System.Collections.Generic.List[string]]::new()
    $archiveProgramFilesRoots = [System.Collections.Generic.List[string]]::new()
    [void]$candidateRoots.Add([IO.Path]::Combine($PSHOME, 'Modules'))
    [void]$candidateRoots.Add([IO.Path]::Combine($systemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules'))
    foreach ($programFilesRoot in @($programFiles, $programFilesX86)) {
        if ([string]::IsNullOrWhiteSpace($programFilesRoot)) { continue }
        $windowsPowerShellRoot = [IO.Path]::Combine($programFilesRoot, 'WindowsPowerShell', 'Modules')
        [void]$candidateRoots.Add($windowsPowerShellRoot)
        [void]$archiveProgramFilesRoots.Add($windowsPowerShellRoot)
    }

    $trustedModuleRoots = [System.Collections.Generic.List[string]]::new()
    $seenRoots = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidateRoot in $candidateRoots) {
        $fullRoot = [IO.Path]::GetFullPath($candidateRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        if (-not [IO.Directory]::Exists($fullRoot) -or -not $seenRoots.Add($fullRoot)) { continue }
        if (([IO.File]::GetAttributes($fullRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Trusted PowerShell module root is a reparse point: $fullRoot" }
        [void]$trustedModuleRoots.Add($fullRoot)
    }
    if ($trustedModuleRoots.Count -eq 0) { throw "No trusted PowerShell module root was found for bootstrap refresh." }
    $env:PSModulePath = [string]::Join([IO.Path]::PathSeparator, $trustedModuleRoots.ToArray())
    foreach ($moduleName in @("Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Security")) {
        $manifest = Join-Path $PSHOME ("Modules\{0}\{0}.psd1" -f $moduleName)
        if (-not [IO.File]::Exists($manifest)) { throw "Required trusted PowerShell module was not found: $manifest" }
        Microsoft.PowerShell.Core\Import-Module -Name $manifest -Force -ErrorAction Stop
    }
    $archiveManifest = Resolve-RevAgentTrustedArchiveManifest -PsHomeModulesRoot ([IO.Path]::Combine($PSHOME, 'Modules')) -ProgramFilesModuleRoots $archiveProgramFilesRoots.ToArray()
    Microsoft.PowerShell.Core\Import-Module -Name $archiveManifest -Force -ErrorAction Stop
}

# Production remains fail-closed before any optional module import. The helpers
# below stay dormant until an independently trusted broker can activate them.

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Test-RevAgentStringEquals {
    param(
        [AllowNull()][string]$Left,
        [AllowNull()][string]$Right,
        [switch]$IgnoreCase
    )

    if ($null -eq $Left -or $null -eq $Right) {
        return ($null -eq $Left -and $null -eq $Right)
    }
    if ($IgnoreCase) {
        return $Left.ToUpperInvariant() -eq $Right.ToUpperInvariant()
    }
    return $Left -ceq $Right
}

function Test-RevAgentStringStartsWith {
    param(
        [AllowNull()][string]$Value,
        [AllowNull()][string]$Prefix,
        [switch]$IgnoreCase
    )

    if ($null -eq $Value -or $null -eq $Prefix) { return $false }
    if ($Prefix.Length -eq 0) { return $true }
    if ($Value.Length -lt $Prefix.Length) { return $false }
    return Test-RevAgentStringEquals -Left ($Value.Substring(0, $Prefix.Length)) -Right $Prefix -IgnoreCase:([bool]$IgnoreCase)
}

function Quote-Arg {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Join-CommandLine {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    return ($Arguments | ForEach-Object {
            $value = [string]$_
            if ($value -match '[\s"]') { Quote-Arg $value } else { $value }
        }) -join ' '
}

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-RevAgentProgramDataRoot {
    return [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
}

function Get-RevAgentBootstrapExitMessage {
    param([int]$ExitCode)

    switch ($ExitCode) {
        79 { return "Administrator approval was declined. Run this updater again when an administrator is available." }
        80 { return "A revAgent bootstrap coordinator is already running. Finish the coordinator/UAC window, then run this updater again." }
        81 { return "The revAgent bootstrap coordinator is still running. Finish the coordinator/UAC window, then run this updater again." }
        82 { return "This machine has UAC disabled or Windows could not provide the standard (non-elevated) user context required by the revAgent first install. Re-enable UAC, then run this updater again, or contact the DPE revAgent administrator for supervised manual bootstrap prestage." }
        84 { return "Automatic revAgent protected bootstrap install or refresh is disabled because this deployment has no Authenticode or IT-managed trust anchor. Contact the DPE revAgent administrator to complete the supervised manual high-assurance prestage, then run this updater again." }
        default { return "" }
    }
}

function Test-RevAgentUacDeclinedException {
    param([Parameter(Mandatory = $true)][Exception]$Exception)

    $current = $Exception
    while ($null -ne $current) {
        if ($current -is [ComponentModel.Win32Exception] -and [int]$current.NativeErrorCode -eq 1223) {
            return $true
        }
        $current = $current.InnerException
    }
    return $false
}

function Start-RevAgentElevatedProcess {
    param([Parameter(Mandatory = $true)][Diagnostics.ProcessStartInfo]$StartInfo)
    return [Diagnostics.Process]::Start($StartInfo)
}

function Get-RevAgentTokenElevationType {
    if (-not ('RevAgentBootstrap.TokenInspector' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace RevAgentBootstrap
{
    public static class TokenInspector
    {
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(
            IntPtr tokenHandle,
            int tokenInformationClass,
            out int tokenInformation,
            int tokenInformationLength,
            out int returnLength);

        public static int GetElevationType(IntPtr tokenHandle)
        {
            int elevationType;
            int returnLength;
            if (!GetTokenInformation(tokenHandle, 18, out elevationType, sizeof(int), out returnLength))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return elevationType;
        }
    }
}
'@
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        switch ([int][RevAgentBootstrap.TokenInspector]::GetElevationType($identity.Token)) {
            1 { return 'Default' }
            2 { return 'Full' }
            3 { return 'Limited' }
            default { return 'Unknown' }
        }
    }
    finally {
        $identity.Dispose()
    }
}

function Get-RevAgentDeElevationCapability {
    $policyPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    $policy = Get-ItemProperty -LiteralPath $policyPath -Name EnableLUA -ErrorAction Stop
    $enableLua = [int]$policy.EnableLUA
    if ($enableLua -eq 0) {
        return [pscustomobject][ordered]@{
            canDeElevate = $false
            reason = 'uac_disabled'
            enableLUA = $enableLua
            tokenElevationType = ''
        }
    }

    $tokenElevationType = Get-RevAgentTokenElevationType
    if (-not (Test-RevAgentStringEquals -Left $tokenElevationType -Right 'Full' -IgnoreCase)) {
        return [pscustomobject][ordered]@{
            canDeElevate = $false
            reason = if (Test-RevAgentStringEquals -Left $tokenElevationType -Right 'Default' -IgnoreCase) {
                'token_elevation_type_default'
            }
            else {
                'split_token_unavailable'
            }
            enableLUA = $enableLua
            tokenElevationType = $tokenElevationType
        }
    }

    return [pscustomobject][ordered]@{
        canDeElevate = $true
        reason = 'split_token_available'
        enableLUA = $enableLua
        tokenElevationType = $tokenElevationType
    }
}

function Write-RevAgentDeElevationFailure {
    param([Parameter(Mandatory = $true)][object]$Capability)

    if (Test-RevAgentStringEquals -Left ([string]$Capability.reason) -Right 'uac_disabled') {
        Write-Host "This machine runs with UAC disabled (EnableLUA=0); the revAgent first install requires a standard (non-elevated) user context."
        Write-Host "Re-enable UAC, then run this updater again, or contact the DPE revAgent administrator for supervised manual bootstrap prestage."
        return
    }

    Write-Host "This administrator session cannot be de-elevated to the standard user context required by the revAgent first install."
    Write-Host "The Windows token elevation type is '$([string]$Capability.tokenElevationType)'. Start from a standard user session or contact the DPE revAgent administrator for supervised manual bootstrap prestage."
}

function Get-RevAgentBootstrapTempRoot {
    return [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
}

function Get-RevAgentRunningRefreshScriptPath {
    return $PSCommandPath
}

function Get-RevAgentBootstrapTemporaryPathInfo {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$TempRoot = (Get-RevAgentBootstrapTempRoot)
    )

    $root = [IO.Path]::GetFullPath($TempRoot).TrimEnd('\')
    $fullPath = [IO.Path]::GetFullPath($Path)
    $parent = [IO.Path]::GetDirectoryName($fullPath).TrimEnd('\')
    if (-not (Test-RevAgentStringEquals -Left $parent -Right $root -IgnoreCase)) { return $null }

    $name = [IO.Path]::GetFileName($fullPath)
    $mode = ''
    $attemptId = ''
    $kind = ''
    if ($name -match '^revagent-bootstrap-(install|refresh)-source-([0-9a-f]{32})$') {
        $mode = [string]$Matches[1]
        $attemptId = [string]$Matches[2]
        $kind = 'source'
    }
    elseif ($name -match '^revagent-bootstrap-(install|refresh)-source-([0-9a-f]{32})\.lock$') {
        $mode = [string]$Matches[1]
        $attemptId = [string]$Matches[2]
        $kind = 'lock'
    }
    elseif ($name -match '^revagent-bootstrap-(install|refresh)-evidence-([0-9a-f]{32})\.json$') {
        $mode = [string]$Matches[1]
        $attemptId = [string]$Matches[2]
        $kind = 'evidence'
    }
    elseif ($name -match '^revagent-bootstrap-trusted-keys-([0-9a-f]{32})\.json$') {
        $mode = 'install'
        $attemptId = [string]$Matches[1]
        $kind = 'trustedKeys'
    }
    elseif ($name -match '^revagent-bootstrap-elevated-script-([0-9a-f]{32})\.ps1$') {
        $mode = 'elevated'
        $attemptId = [string]$Matches[1]
        $kind = 'elevatedScript'
    }
    elseif ($name -match '^revagent-bootstrap-coordinator-result-([0-9a-f]{32})\.json$') {
        $mode = 'coordinator'
        $attemptId = [string]$Matches[1]
        $kind = 'coordinatorResult'
    }
    else {
        return $null
    }

    return [pscustomobject][ordered]@{
        path = $fullPath
        name = $name
        mode = $mode
        attemptId = $attemptId
        kind = $kind
        lockPath = if ($mode -in @('install', 'refresh')) {
            Join-Path $root ("revagent-bootstrap-{0}-source-{1}.lock" -f $mode, $attemptId)
        }
        else { '' }
    }
}

function Open-RevAgentBootstrapTemporaryDirectoryGuard {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not ('RevAgentBootstrap.TemporaryDirectoryGuard' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgentBootstrap
{
    public sealed class TemporaryDirectoryGuard : IDisposable
    {
        private const uint FILE_READ_ATTRIBUTES = 0x0080;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            public uint Low;
            public uint High;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
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

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            FileShare shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle handle,
            out BY_HANDLE_FILE_INFORMATION information);

        private TemporaryDirectoryGuard(SafeFileHandle handle, BY_HANDLE_FILE_INFORMATION information)
        {
            Handle = handle;
            Attributes = information.FileAttributes;
            Identity = String.Format(
                "{0:X8}:{1:X8}{2:X8}",
                information.VolumeSerialNumber,
                information.FileIndexHigh,
                information.FileIndexLow);
        }

        public SafeFileHandle Handle { get; private set; }
        public uint Attributes { get; private set; }
        public string Identity { get; private set; }
        public bool IsDirectory { get { return (Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0; } }
        public bool IsReparsePoint { get { return (Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0; } }

        public static TemporaryDirectoryGuard Open(string path)
        {
            SafeFileHandle handle = CreateFileW(
                path,
                FILE_READ_ATTRIBUTES,
                FileShare.Read | FileShare.Write,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Could not open no-follow TEMP directory guard: " + path);
            }

            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Could not inspect no-follow TEMP directory guard: " + path);
            }
            return new TemporaryDirectoryGuard(handle, information);
        }

        public void Dispose()
        {
            if (Handle != null) { Handle.Dispose(); }
        }
    }
}
'@
    }

    return [RevAgentBootstrap.TemporaryDirectoryGuard]::Open([IO.Path]::GetFullPath($Path))
}

function Clear-RevAgentBootstrapTemporaryDirectoryNoFollow {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$CleanupRoot,
        [Parameter(Mandatory = $true)][object]$State,
        [ValidateRange(0, 64)][int]$Depth = 0
    )

    if ($Depth -gt [int]$State.maxDepth) { throw "Bootstrap TEMP cleanup exceeded its maximum depth: $Path" }
    $root = [IO.Path]::GetFullPath($CleanupRoot).TrimEnd('\')
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not (Test-RevAgentStringEquals -Left $fullPath -Right $root -IgnoreCase) -and
        -not (Test-RevAgentStringStartsWith -Value $fullPath -Prefix ($root + '\') -IgnoreCase)) {
        throw "Bootstrap TEMP cleanup escaped its exact root. path=$fullPath root=$root"
    }

    $guard = Open-RevAgentBootstrapTemporaryDirectoryGuard -Path $fullPath
    $unlinkReparsePoint = $false
    try {
        if ([bool]$guard.IsReparsePoint) {
            $unlinkReparsePoint = $true
        }
        elseif (-not [bool]$guard.IsDirectory) {
            throw "Bootstrap TEMP cleanup expected a directory: $fullPath"
        }
        else {
            $passCount = 0
            while ($true) {
                $passCount++
                if ($passCount -gt [int]$State.maxPassesPerDirectory) {
                    throw "Bootstrap TEMP cleanup exceeded its bounded enumeration passes: $fullPath"
                }

                $identityCheck = Open-RevAgentBootstrapTemporaryDirectoryGuard -Path $fullPath
                try {
                    if ([bool]$identityCheck.IsReparsePoint -or
                        -not (Test-RevAgentStringEquals -Left ([string]$identityCheck.Identity) -Right ([string]$guard.Identity))) {
                        throw "Bootstrap TEMP directory identity changed during cleanup: $fullPath"
                    }
                }
                finally { $identityCheck.Dispose() }

                $children = @([IO.Directory]::EnumerateFileSystemEntries($fullPath))
                if ($children.Count -eq 0) { break }
                foreach ($childPathValue in $children) {
                    $State.itemCount = [int]$State.itemCount + 1
                    if ([int]$State.itemCount -gt [int]$State.maxItems) {
                        throw "Bootstrap TEMP cleanup exceeded its bounded item count: $root"
                    }
                    $childPath = [IO.Path]::GetFullPath([string]$childPathValue)
                    if (-not (Test-RevAgentStringStartsWith -Value $childPath -Prefix ($root + '\') -IgnoreCase)) {
                        throw "Bootstrap TEMP cleanup encountered an out-of-root child: $childPath"
                    }

                    $attributes = [IO.File]::GetAttributes($childPath)
                    $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
                    $isReparsePoint = ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
                    if ($isDirectory) {
                        if ($isReparsePoint) {
                            [IO.Directory]::Delete($childPath, $false)
                        }
                        else {
                            Clear-RevAgentBootstrapTemporaryDirectoryNoFollow `
                                -Path $childPath `
                                -CleanupRoot $root `
                                -State $State `
                                -Depth ($Depth + 1)
                            if ([IO.Directory]::Exists($childPath)) {
                                [IO.Directory]::Delete($childPath, $false)
                            }
                        }
                    }
                    else {
                        [IO.File]::Delete($childPath)
                    }
                }
            }
        }
    }
    finally { $guard.Dispose() }

    if ($unlinkReparsePoint -and [IO.Directory]::Exists($fullPath)) {
        [IO.Directory]::Delete($fullPath, $false)
    }
}

function Remove-RevAgentBootstrapTemporaryPath {
    param(
        [AllowEmptyString()][string]$Path,
        [string]$TempRoot = (Get-RevAgentBootstrapTempRoot)
    )

    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    try {
        $pathInfo = Get-RevAgentBootstrapTemporaryPathInfo -Path $Path -TempRoot $TempRoot
        if ($null -eq $pathInfo -or -not (Test-Path -LiteralPath $pathInfo.path)) { return }
        $item = Get-Item -LiteralPath $pathInfo.path -Force -ErrorAction Stop
        if ($item.PSIsContainer) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                [IO.Directory]::Delete([string]$pathInfo.path, $false)
                return
            }
            $cleanupState = [pscustomobject]@{
                itemCount = 0
                maxItems = 100000
                maxDepth = 64
                maxPassesPerDirectory = 32
            }
            Clear-RevAgentBootstrapTemporaryDirectoryNoFollow `
                -Path $pathInfo.path `
                -CleanupRoot $pathInfo.path `
                -State $cleanupState
            if ([IO.Directory]::Exists([string]$pathInfo.path)) {
                [IO.Directory]::Delete([string]$pathInfo.path, $false)
            }
        }
        else {
            [IO.File]::Delete([string]$pathInfo.path)
        }
    }
    catch {
        # Temporary cleanup is deliberately best-effort. Never replace the
        # updater's real result with a cleanup-only failure.
    }
}

function Remove-RevAgentBootstrapTemporaryInput {
    param(
        [AllowNull()][object]$InputObject,
        [string]$TempRoot = (Get-RevAgentBootstrapTempRoot)
    )

    if ($null -eq $InputObject) { return }
    $lockProperty = $InputObject.PSObject.Properties['CleanupLock']
    if ($null -ne $lockProperty -and $null -ne $lockProperty.Value) {
        try { $lockProperty.Value.Dispose() }
        catch { }
    }
    foreach ($propertyName in @('SourceRoot', 'EvidenceSource', 'TrustedKeysSource', 'CleanupLockPath')) {
        $property = $InputObject.PSObject.Properties[$propertyName]
        if ($null -ne $property) {
            Remove-RevAgentBootstrapTemporaryPath -Path ([string]$property.Value) -TempRoot $TempRoot
        }
    }
}

function Remove-StaleRevAgentBootstrapTemporaryItems {
    param(
        [string]$TempRoot = (Get-RevAgentBootstrapTempRoot),
        [ValidateRange(1, 8760)][int]$MinimumAgeHours = 24
    )

    $cleanupMutex = $null
    $mutexAcquired = $false
    try {
        $root = [IO.Path]::GetFullPath($TempRoot).TrimEnd('\')
        if (-not [IO.Directory]::Exists($root)) { return }
        if (([IO.File]::GetAttributes($root) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return }

        $cleanupMutex = [Threading.Mutex]::new($false, 'Local\revAgentBootstrapTempCleanup')
        try { $mutexAcquired = $cleanupMutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $mutexAcquired = $true }
        if (-not $mutexAcquired) { return }

        $cutoffUtc = [DateTime]::UtcNow.AddHours(-$MinimumAgeHours)
        $candidates = @(Get-ChildItem -LiteralPath $root -Filter 'revagent-bootstrap-*' -Force -ErrorAction SilentlyContinue |
                Sort-Object @{ Expression = { if ($_.PSIsContainer) { 0 } elseif ($_.Name -like '*.lock') { 2 } else { 1 } } }, Name)
        foreach ($candidate in $candidates) {
            try {
                $pathInfo = Get-RevAgentBootstrapTemporaryPathInfo -Path $candidate.FullName -TempRoot $root
                if ($null -eq $pathInfo -or $pathInfo.kind -eq 'coordinatorResult') { continue }
                if (($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                if ($candidate.CreationTimeUtc -gt $cutoffUtc -or $candidate.LastWriteTimeUtc -gt $cutoffUtc) { continue }

                $lockProbe = $null
                if (-not [string]::IsNullOrWhiteSpace([string]$pathInfo.lockPath) -and [IO.File]::Exists([string]$pathInfo.lockPath)) {
                    try {
                        $lockProbe = [IO.File]::Open([string]$pathInfo.lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
                    }
                    catch { continue }
                    finally {
                        if ($null -ne $lockProbe) { $lockProbe.Dispose() }
                    }
                }

                $current = Get-Item -LiteralPath $candidate.FullName -Force -ErrorAction Stop
                if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                if ($current.CreationTimeUtc -gt $cutoffUtc -or $current.LastWriteTimeUtc -gt $cutoffUtc) { continue }
                Remove-RevAgentBootstrapTemporaryPath -Path $current.FullName -TempRoot $root
            }
            catch {
                # Opportunistic stale cleanup is intentionally silent.
            }
        }
    }
    catch {
        # Opportunistic stale cleanup is intentionally silent.
    }
    finally {
        if ($mutexAcquired -and $null -ne $cleanupMutex) {
            try { $cleanupMutex.ReleaseMutex() }
            catch { }
        }
        if ($null -ne $cleanupMutex) { $cleanupMutex.Dispose() }
    }
}

function Write-RevAgentCoordinatorResultMarker {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Nonce,
        [Parameter(Mandatory = $true)][int]$ExitCode,
        [AllowEmptyString()][string]$Message = ''
    )

    if ($Nonce -notmatch '^[0-9a-f]{32}$') { throw "Invalid revAgent bootstrap coordinator nonce." }
    $pathInfo = Get-RevAgentBootstrapTemporaryPathInfo -Path $Path
    if ($null -eq $pathInfo -or $pathInfo.kind -ne 'coordinatorResult' -or
        -not (Test-RevAgentStringEquals -Left ([string]$pathInfo.attemptId) -Right $Nonce -IgnoreCase)) {
        throw "Invalid revAgent bootstrap coordinator result path."
    }

    $state = if ($ExitCode -eq 0) { 'succeeded' } else { 'failed' }
    $document = [ordered]@{
        schemaVersion = 1
        nonce = $Nonce
        completedUtc = [DateTime]::UtcNow.ToString('o')
        state = $state
        exitCode = $ExitCode
        message = $Message
    }
    $json = $document | ConvertTo-Json -Depth 4
    $temporaryPath = $pathInfo.path + '.tmp-' + [Guid]::NewGuid().ToString('N')
    try {
        [IO.File]::WriteAllText($temporaryPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temporaryPath, [string]$pathInfo.path)
    }
    finally {
        if ([IO.File]::Exists($temporaryPath)) {
            try { [IO.File]::Delete($temporaryPath) }
            catch { }
        }
    }
}

function Read-RevAgentCoordinatorResultMarker {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Nonce
    )

    try {
        $pathInfo = Get-RevAgentBootstrapTemporaryPathInfo -Path $Path
        if ($null -eq $pathInfo -or $pathInfo.kind -ne 'coordinatorResult' -or
            -not (Test-RevAgentStringEquals -Left ([string]$pathInfo.attemptId) -Right $Nonce -IgnoreCase) -or
            -not [IO.File]::Exists([string]$pathInfo.path)) {
            return $null
        }
        $marker = Get-Content -Raw -LiteralPath $pathInfo.path -ErrorAction Stop | ConvertFrom-Json
        if ([int]$marker.schemaVersion -ne 1 -or
            -not (Test-RevAgentStringEquals -Left ([string]$marker.nonce) -Right $Nonce) -or
            [string]$marker.state -notin @('succeeded', 'failed')) {
            return $null
        }
        return $marker
    }
    catch {
        return $null
    }
}

function Find-RevAgentActiveCoordinatorTask {
    param([AllowNull()][object[]]$Tasks)

    foreach ($task in @($Tasks)) {
        $state = [string]$task.State
        if ($state -in @('Running', 'Queued')) { return $task }
    }
    return $null
}

function Wait-RevAgentBootstrapCoordinator {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$ResultPath,
        [Parameter(Mandatory = $true)][string]$Nonce,
        [Parameter(Mandatory = $true)][string]$BootstrapPath,
        [ValidateRange(0, 3600)][int]$TimeoutSeconds = 600,
        [ValidateRange(1, 10000)][int]$PollIntervalMilliseconds = 1000
    )

    $timer = [Diagnostics.Stopwatch]::StartNew()
    $completedWithoutMarkerAt = $null
    $previousResultMismatch = ''
    try {
        while ($true) {
            $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
            $state = if ($null -ne $task) { [string]$task.State } else { '' }
            $lastTaskResult = $null
            $hasRun = $false
            if ($null -ne $taskInfo) {
                if ($null -ne $taskInfo.PSObject.Properties['LastTaskResult']) {
                    $lastTaskResult = [long]$taskInfo.LastTaskResult
                }
                if ($null -ne $taskInfo.PSObject.Properties['LastRunTime'] -and $null -ne $taskInfo.LastRunTime) {
                    $hasRun = ([DateTime]$taskInfo.LastRunTime).Year -ge 2000
                }
            }
            $marker = Read-RevAgentCoordinatorResultMarker -Path $ResultPath -Nonce $Nonce
            $taskStillActive = $state -in @('Running', 'Queued')

            if ($null -ne $marker -and -not $taskStillActive -and $hasRun -and $null -ne $lastTaskResult) {
                $markerExitCode = [int]$marker.exitCode
                if ([long]$markerExitCode -ne [long]$lastTaskResult) {
                    $mismatchSignature = "$markerExitCode|$lastTaskResult|$state"
                    if (Test-RevAgentStringEquals -Left $previousResultMismatch -Right $mismatchSignature) {
                        return [pscustomobject][ordered]@{
                            completed = $true
                            timedOut = $false
                            exitCode = 1
                            taskState = $state
                            lastTaskResult = $lastTaskResult
                            message = "The revAgent bootstrap coordinator result marker did not match LastTaskResult. marker=$markerExitCode task=$lastTaskResult"
                        }
                    }
                    $previousResultMismatch = $mismatchSignature
                }
                else {
                    $previousResultMismatch = ''
                    if ($markerExitCode -eq 0 -and -not [IO.File]::Exists($BootstrapPath)) {
                        return [pscustomobject][ordered]@{
                            completed = $true
                            timedOut = $false
                            exitCode = 1
                            taskState = $state
                            lastTaskResult = $lastTaskResult
                            message = "The revAgent bootstrap coordinator reported success without creating the protected local bootstrap: $BootstrapPath"
                        }
                    }
                    return [pscustomobject][ordered]@{
                        completed = $true
                        timedOut = $false
                        exitCode = $markerExitCode
                        taskState = $state
                        lastTaskResult = $lastTaskResult
                        message = [string]$marker.message
                    }
                }
            }

            if (-not $taskStillActive -and $hasRun -and $null -ne $lastTaskResult -and $null -eq $marker) {
                if ($null -eq $completedWithoutMarkerAt) { $completedWithoutMarkerAt = $timer.Elapsed }
                if (($timer.Elapsed - $completedWithoutMarkerAt).TotalSeconds -ge 2) {
                    return [pscustomobject][ordered]@{
                        completed = $true
                        timedOut = $false
                        exitCode = 1
                        taskState = $state
                        lastTaskResult = $lastTaskResult
                        message = "The revAgent bootstrap coordinator ended without its nonce-bound result marker. LastTaskResult=$lastTaskResult"
                    }
                }
            }
            else {
                $completedWithoutMarkerAt = $null
            }

            if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                return [pscustomobject][ordered]@{
                    completed = $false
                    timedOut = $true
                    exitCode = $script:RevAgentExitCoordinatorTimeout
                    taskState = $state
                    lastTaskResult = $lastTaskResult
                    message = (Get-RevAgentBootstrapExitMessage -ExitCode $script:RevAgentExitCoordinatorTimeout)
                }
            }
            Start-Sleep -Milliseconds $PollIntervalMilliseconds
        }
    }
    finally {
        $timer.Stop()
    }
}

function Set-AdminOnlyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $acl = if ($item.PSIsContainer) {
        [Security.AccessControl.DirectorySecurity]::new()
    }
    else {
        [Security.AccessControl.FileSecurity]::new()
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $inheritance = if ($item.PSIsContainer) {
            [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        }
        else {
            [Security.AccessControl.InheritanceFlags]::None
        }
        [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new($sid),
                [Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    if ('System.IO.FileSystemAclExtensions' -as [type]) {
        if ($item.PSIsContainer) {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item, [Security.AccessControl.DirectorySecurity]$acl)
        }
        else {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]$item, [Security.AccessControl.FileSecurity]$acl)
        }
    }
    elseif ($item.PSIsContainer) {
        ([IO.DirectoryInfo]$item).SetAccessControl([Security.AccessControl.DirectorySecurity]$acl)
    }
    else {
        ([IO.FileInfo]$item).SetAccessControl([Security.AccessControl.FileSecurity]$acl)
    }
}

function Get-ProtectedBootstrapState {
    $programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    $bootstrapRoot = [IO.Path]::GetFullPath((Join-Path $programData 'DPE\revAgent\bootstrap')).TrimEnd('\')
    $statePath = Join-Path $bootstrapRoot 'bootstrap-state.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw "Protected local bootstrap state was not found: $statePath"
    }
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ([int]$state.schemaVersion -ne 1 -or -not [bool]$state.sourceAuthentication.independentlyAuthenticated) {
        throw "Protected local bootstrap state does not prove an independently authenticated prestage."
    }
    foreach ($role in @('distributionIntegrity', 'releaseSnapshot', 'trustedKeys')) {
        $evidence = $state.files.$role
        if ($null -eq $evidence -or [string]::IsNullOrWhiteSpace([string]$evidence.relativePath) -or [string]::IsNullOrWhiteSpace([string]$evidence.sha256)) {
            throw "Protected local bootstrap state is missing required file evidence: $role"
        }
        $path = Join-Path $bootstrapRoot ([string]$evidence.relativePath)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Protected local bootstrap file was not found: $path" }
        if (-not (Test-RevAgentStringEquals -Left (Get-Sha256Hex -Path $path) -Right ([string]$evidence.sha256) -IgnoreCase)) {
            throw "Protected local bootstrap file hash mismatch: $role"
        }
    }
    return [pscustomobject]@{ root = $bootstrapRoot; statePath = $statePath; state = $state }
}

function New-RevAgentElevatedRefreshVerifierEncodedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string[]]$ScriptArguments
    )

    $resolvedScriptPath = [IO.Path]::GetFullPath($ScriptPath)
    if (Test-RevAgentStringStartsWith -Value $resolvedScriptPath -Prefix '\\') {
        throw "The elevated revAgent bootstrap verifier refused a UNC script path: $resolvedScriptPath"
    }
    if ($ExpectedSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
        throw "The elevated revAgent bootstrap verifier requires a valid script SHA-256."
    }
    $childArguments = Join-CommandLine -Arguments (@(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $resolvedScriptPath
        ) + $ScriptArguments)
    $payloadJson = [pscustomobject][ordered]@{
        scriptPath = $resolvedScriptPath
        expectedSha256 = $ExpectedSha256.ToUpperInvariant()
        childArguments = $childArguments
    } | ConvertTo-Json -Compress
    $payloadBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payloadJson))
    $verifier = @'
$ErrorActionPreference = 'Stop'
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__REVAGENT_PAYLOAD_BASE64__'))
$payload = $payloadJson | ConvertFrom-Json
$scriptPath = [IO.Path]::GetFullPath([string]$payload.scriptPath)
$expectedSha256 = [string]$payload.expectedSha256
$exitCode = 1
$guard = $null
$child = $null
try {
    if (($scriptPath.Length -ge 2 -and $scriptPath[0] -eq '\' -and $scriptPath[1] -eq '\') -or
        $expectedSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
        throw 'The elevated revAgent bootstrap verifier rejected its staged script identity.'
    }
    $guard = [IO.File]::Open($scriptPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $actualSha256 = [BitConverter]::ToString($sha256.ComputeHash($guard)).Replace('-', '')
    }
    finally { $sha256.Dispose() }
    if ($actualSha256 -cne $expectedSha256.ToUpperInvariant()) {
        throw 'The elevated revAgent bootstrap refresh script changed before administrator execution.'
    }

    $powershell = Join-Path $PSHOME 'powershell.exe'
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $powershell
    $startInfo.Arguments = [string]$payload.childArguments
    $startInfo.WorkingDirectory = Split-Path -Parent $powershell
    $startInfo.UseShellExecute = $false
    $child = [Diagnostics.Process]::Start($startInfo)
    if ($null -eq $child) { throw 'The verified elevated revAgent bootstrap child did not start.' }
    $child.WaitForExit()
    $exitCode = [int]$child.ExitCode
}
catch {
    try { [Console]::Error.WriteLine('revAgent elevated bootstrap verifier failed: ' + $_.Exception.Message) } catch { }
}
finally {
    if ($null -ne $child) { $child.Dispose() }
    if ($null -ne $guard) { $guard.Dispose() }
}
exit $exitCode
'@.Replace('__REVAGENT_PAYLOAD_BASE64__', $payloadBase64)
    return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($verifier))
}

function Start-ElevatedApply {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$EvidenceSource,
        [Parameter(Mandatory = $true)][string]$EvidenceSha256,
        [Parameter(Mandatory = $true)][string]$InstallerSha256,
        [Parameter(Mandatory = $true)][string]$TrustedKeysSource
    )

    if (Test-IsAdmin) {
        Write-Host "Administrator session detected. Applying the protected local bootstrap without a second UAC prompt..."
        Invoke-AuthenticatedBootstrapApply `
            -SourceRoot $SourceRoot `
            -EvidenceSource $EvidenceSource `
            -ExpectedEvidenceSha256 $EvidenceSha256 `
            -ExpectedInstallerSha256 $InstallerSha256 `
            -TrustedKeysSource $TrustedKeysSource
        return 0
    }

    $tempRoot = [IO.Path]::GetFullPath((Get-RevAgentBootstrapTempRoot)).TrimEnd('\')
    if ((Test-RevAgentStringStartsWith -Value $tempRoot -Prefix '\\') -or
        -not [IO.Directory]::Exists($tempRoot) -or
        (([IO.File]::GetAttributes($tempRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "The elevated revAgent bootstrap script requires a local, non-reparse temporary root: $tempRoot"
    }
    $runningRefreshScriptPath = Get-RevAgentRunningRefreshScriptPath
    if ([string]::IsNullOrWhiteSpace($runningRefreshScriptPath) -or -not [IO.File]::Exists($runningRefreshScriptPath)) {
        throw "The running revAgent bootstrap refresh script could not be resolved for local elevation staging."
    }

    $stagedRefreshScript = Join-Path $tempRoot ("revagent-bootstrap-elevated-script-{0}.ps1" -f [Guid]::NewGuid().ToString('N'))
    $process = $null
    try {
        [IO.File]::Copy([IO.Path]::GetFullPath($runningRefreshScriptPath), $stagedRefreshScript, $false)
        $refreshScriptSha256 = Get-Sha256Hex -Path $stagedRefreshScript
        $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
        $scriptArguments = @(
            '-ElevatedApply',
            '-ReleaseRoot', $ReleaseRoot,
            '-Channel', $Channel,
            '-SourceRoot', $SourceRoot,
            '-EvidenceSource', $EvidenceSource,
            '-ExpectedEvidenceSha256', $EvidenceSha256,
            '-ExpectedInstallerSha256', $InstallerSha256,
            '-ExpectedRefreshScriptSha256', $refreshScriptSha256,
            '-TrustedKeysSource', $TrustedKeysSource
        )
        $encodedVerifier = New-RevAgentElevatedRefreshVerifierEncodedCommand `
            -ScriptPath $stagedRefreshScript `
            -ExpectedSha256 $refreshScriptSha256 `
            -ScriptArguments $scriptArguments
        $args = @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-EncodedCommand', $encodedVerifier
        )
        $psi = [Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $powershell
        $psi.Arguments = Join-CommandLine -Arguments $args
        $psi.WorkingDirectory = Split-Path -Parent $powershell
        $psi.UseShellExecute = $true
        $psi.Verb = 'runas'
        try {
            $process = Start-RevAgentElevatedProcess -StartInfo $psi
        }
        catch {
            if (Test-RevAgentUacDeclinedException -Exception $_.Exception) {
                Write-Host (Get-RevAgentBootstrapExitMessage -ExitCode $script:RevAgentExitUacDeclined)
                return $script:RevAgentExitUacDeclined
            }
            throw
        }
        if ($null -eq $process) { throw "Administrator approval did not start the elevated bootstrap process." }
        $process.WaitForExit()
        $exitCode = [int]$process.ExitCode
    }
    finally {
        if ($null -ne $process) { $process.Dispose() }
        Remove-RevAgentBootstrapTemporaryPath -Path $stagedRefreshScript -TempRoot $tempRoot
    }
    if ($exitCode -ne 0) { throw "Elevated bootstrap refresh exited with code $exitCode." }
    return 0
}

function Assert-RevAgentElevatedRefreshScript {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [string]$ScriptPath = $PSCommandPath
    )

    if ([string]::IsNullOrWhiteSpace($ScriptPath)) {
        throw "Elevated revAgent bootstrap refresh could not resolve its local script path."
    }
    $resolvedScriptPath = [IO.Path]::GetFullPath($ScriptPath)
    if (Test-RevAgentStringStartsWith -Value $resolvedScriptPath -Prefix '\\') {
        throw "Elevated revAgent bootstrap refresh refused a UNC script path: $resolvedScriptPath"
    }
    if ($ExpectedSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
        throw "Elevated revAgent bootstrap refresh is missing a valid expected script SHA-256."
    }
    if (-not [IO.File]::Exists($resolvedScriptPath)) {
        throw "Elevated revAgent bootstrap refresh script was not found: $resolvedScriptPath"
    }
    if (-not (Test-RevAgentStringEquals -Left (Get-Sha256Hex -Path $resolvedScriptPath) -Right $ExpectedSha256 -IgnoreCase)) {
        throw "Elevated revAgent bootstrap refresh script changed before administrator execution."
    }
}

function Resolve-ReleaseRootChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BaseDirectory
    )

    $releaseRootFullPath = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
    $resolved = if ([IO.Path]::IsPathRooted($Path)) {
        [IO.Path]::GetFullPath($Path)
    }
    else {
        [IO.Path]::GetFullPath((Join-Path $BaseDirectory $Path))
    }
    $resolvedTrimmed = $resolved.TrimEnd('\')
    if (-not (Test-RevAgentStringEquals -Left $resolvedTrimmed -Right $releaseRootFullPath -IgnoreCase) -and
        -not (Test-RevAgentStringStartsWith -Value $resolvedTrimmed -Prefix ($releaseRootFullPath + '\') -IgnoreCase)) {
        throw "Signed release path escaped ReleaseRoot: $resolved"
    }
    return $resolved
}

function New-CleanInstallBootstrapInput {
    $channelPath = Join-Path (Join-Path $ReleaseRoot 'channels') "$Channel.json"
    $trustedKeys = Join-Path (Join-Path $ReleaseRoot 'tools\config') 'release-trusted-keys.json'
    if (-not (Test-Path -LiteralPath $channelPath -PathType Leaf)) {
        throw "Signed stable channel manifest was not found: $channelPath"
    }
    if (-not (Test-Path -LiteralPath $trustedKeys -PathType Leaf)) {
        throw "Trusted release keys were not found: $trustedKeys"
    }

    $channelManifest = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json
    if (-not (Test-RevAgentStringEquals -Left ([string]$channelManifest.channel) -Right $Channel)) {
        throw "Signed channel identity mismatch. requested=$Channel actual=$($channelManifest.channel)"
    }
    $channelDirectory = Split-Path -Parent $channelPath
    $packagePath = Resolve-ReleaseRootChildPath -Path ([string]$channelManifest.packagePath) -BaseDirectory $channelDirectory
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        throw "Signed release package was not found: $packagePath"
    }
    if ([string]::IsNullOrWhiteSpace([string]$channelManifest.sha256)) {
        throw "Signed stable channel does not contain a package SHA-256."
    }
    $actualPackageSha256 = Get-Sha256Hex -Path $packagePath
    if (-not (Test-RevAgentStringEquals -Left $actualPackageSha256 -Right ([string]$channelManifest.sha256) -IgnoreCase)) {
        throw "Signed release package changed before bootstrap evidence production."
    }

    $tempRoot = Get-RevAgentBootstrapTempRoot
    $attemptId = [Guid]::NewGuid().ToString('N')
    $trustedKeysLocal = Join-Path $tempRoot ("revagent-bootstrap-trusted-keys-$attemptId.json")
    $temporaryInput = [pscustomobject][ordered]@{
        SourceRoot = Join-Path $tempRoot ("revagent-bootstrap-install-source-$attemptId")
        EvidenceSource = Join-Path $tempRoot ("revagent-bootstrap-install-evidence-$attemptId.json")
        EvidenceSha256 = ''
        InstallerSha256 = ''
        TrustedKeysSource = $trustedKeysLocal
        CleanupLockPath = Join-Path $tempRoot ("revagent-bootstrap-install-source-$attemptId.lock")
        CleanupLock = $null
    }
    $completed = $false
    try {
        New-Item -ItemType Directory -Path $temporaryInput.SourceRoot -ErrorAction Stop | Out-Null
        $temporaryInput.CleanupLock = [IO.File]::Open(
            [string]$temporaryInput.CleanupLockPath,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None)
        Expand-Archive -LiteralPath $packagePath -DestinationPath $temporaryInput.SourceRoot -Force
        if (-not (Test-RevAgentStringEquals -Left (Get-Sha256Hex -Path $packagePath) -Right $actualPackageSha256 -IgnoreCase)) {
            throw "Signed release package changed during extraction."
        }

        $evidenceTool = Join-Path $temporaryInput.SourceRoot 'installer\nas\New-RevAgentBootstrapPrestageEvidence.ps1'
        if (-not (Test-Path -LiteralPath $evidenceTool -PathType Leaf)) {
            throw "Signed release package does not contain the bootstrap evidence producer: $evidenceTool"
        }

        Write-Host "Preparing authenticated first-install bootstrap evidence..."
        $evidenceResult = & $evidenceTool `
            -ReleaseRoot $ReleaseRoot `
            -TrustedKeysPath $trustedKeys `
            -OutputPath $temporaryInput.EvidenceSource `
            -RepoRoot $temporaryInput.SourceRoot `
            -Channel $Channel
        $evidence = Get-Content -Raw -LiteralPath $temporaryInput.EvidenceSource | ConvertFrom-Json
        if (-not [bool]$evidence.release.signatureVerified -or
            -not (Test-RevAgentStringEquals -Left ([string]$evidence.release.channel) -Right $Channel)) {
            throw "Bootstrap first-install evidence does not prove a signed stable release."
        }
        if ([string]::IsNullOrWhiteSpace([string]$evidence.localBootstrapInstallerScript)) {
            throw "Bootstrap first-install evidence is missing the local bootstrap installer hash."
        }
        if ([string]::IsNullOrWhiteSpace([string]$evidence.sources.trustedKeys)) {
            throw "Bootstrap first-install evidence is missing the trusted keys hash."
        }
        Copy-Item -LiteralPath $trustedKeys -Destination $temporaryInput.TrustedKeysSource -Force
        if (-not (Test-RevAgentStringEquals -Left (Get-Sha256Hex -Path $temporaryInput.TrustedKeysSource) -Right ([string]$evidence.sources.trustedKeys) -IgnoreCase)) {
            throw "Trusted release keys changed before bootstrap elevation."
        }

        $temporaryInput.EvidenceSha256 = [string]$evidenceResult.outputSha256
        $temporaryInput.InstallerSha256 = [string]$evidence.localBootstrapInstallerScript
        $completed = $true
        return $temporaryInput
    }
    finally {
        if (-not $completed) {
            Remove-RevAgentBootstrapTemporaryInput -InputObject $temporaryInput -TempRoot $tempRoot
        }
    }
}

function Start-LimitedCoordinatorFromAdministrator {
    $capability = Get-RevAgentDeElevationCapability
    if (-not [bool]$capability.canDeElevate) {
        Write-RevAgentDeElevationFailure -Capability $capability
        return $script:RevAgentExitUacDisabled
    }
    if ($CoordinatorRelaunchedFromAdmin) {
        Write-Host "The revAgent bootstrap coordinator is still elevated after Windows was asked to run it with a limited token."
        Write-Host "Start the updater from a standard user session or contact the DPE revAgent administrator for supervised manual bootstrap prestage."
        return $script:RevAgentExitUacDisabled
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $currentUser = $identity.Name
        $currentUserSid = $identity.User.Value
    }
    finally { $identity.Dispose() }

    $registrationMutex = $null
    $mutexAcquired = $false
    $taskName = ''
    $taskRegistered = $false
    $waitResult = $null
    $coordinatorResultPath = ''
    try {
        $registrationMutex = [Threading.Mutex]::new($false, "Local\revAgentBootstrapCoordinator-$currentUserSid")
        try { $mutexAcquired = $registrationMutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $mutexAcquired = $true }
        if (-not $mutexAcquired) {
            Write-Host (Get-RevAgentBootstrapExitMessage -ExitCode $script:RevAgentExitCoordinatorAlreadyRunning)
            return $script:RevAgentExitCoordinatorAlreadyRunning
        }

        Microsoft.PowerShell.Core\Import-Module -Name ScheduledTasks -ErrorAction Stop
        $existingTasks = @(Get-ScheduledTask -TaskName 'revAgent Bootstrap Coordinator *' -ErrorAction SilentlyContinue)
        $activeTask = Find-RevAgentActiveCoordinatorTask -Tasks $existingTasks
        if ($null -ne $activeTask) {
            Write-Host (Get-RevAgentBootstrapExitMessage -ExitCode $script:RevAgentExitCoordinatorAlreadyRunning)
            Write-Host "Active task: $([string]$activeTask.TaskName) (state=$([string]$activeTask.State))"
            return $script:RevAgentExitCoordinatorAlreadyRunning
        }
        foreach ($oldTask in $existingTasks) {
            try {
                Unregister-ScheduledTask -TaskName ([string]$oldTask.TaskName) -Confirm:$false -ErrorAction Stop | Out-Null
            }
            catch {
                Write-Warning "Could not remove old revAgent bootstrap coordinator task '$($oldTask.TaskName)': $($_.Exception.Message)"
            }
        }

        $coordinatorNonce = [Guid]::NewGuid().ToString('N')
        $coordinatorResultPath = Join-Path (Get-RevAgentBootstrapTempRoot) "revagent-bootstrap-coordinator-result-$coordinatorNonce.json"
        $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
        $arguments = Join-CommandLine -Arguments @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $PSCommandPath,
            '-ReleaseRoot', $ReleaseRoot,
            '-Channel', $Channel,
            '-CoordinatorRelaunchedFromAdmin',
            '-CoordinatorNonce', $coordinatorNonce,
            '-CoordinatorResultPath', $coordinatorResultPath
        )
        $taskName = "revAgent Bootstrap Coordinator $coordinatorNonce"
        $action = New-ScheduledTaskAction `
            -Execute $powershell `
            -Argument $arguments `
            -WorkingDirectory (Split-Path -Parent $powershell)
        $triggerAt = (Get-Date).AddYears(10)
        $trigger = New-ScheduledTaskTrigger -Once -At $triggerAt
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
        $principal = New-ScheduledTaskPrincipal `
            -UserId $currentUser `
            -LogonType Interactive `
            -RunLevel Limited

        Register-ScheduledTask `
            -TaskName $taskName `
            -Action $action `
            -Trigger $trigger `
            -Settings $settings `
            -Principal $principal `
            -Description "Runs the revAgent stable bootstrap coordinator at normal user privilege when the STABLE updater was started elevated." `
            -Force | Out-Null
        $taskRegistered = $true
        Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

        Write-Host "Administrator session detected. Started the revAgent stable bootstrap coordinator as a normal limited interactive task."
        Write-Host "The coordinator will verify the signed release before requesting administrator approval for the protected bootstrap phase."
        Write-Host "Waiting up to 10 minutes for the coordinator and its administrator approval window..."

        $programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
        $bootstrapPath = Join-Path $programData 'DPE\revAgent\bootstrap\Start-revAgent-Update.ps1'
        $waitResult = Wait-RevAgentBootstrapCoordinator `
            -TaskName $taskName `
            -ResultPath $coordinatorResultPath `
            -Nonce $coordinatorNonce `
            -BootstrapPath $bootstrapPath `
            -TimeoutSeconds 600

        if (-not [string]::IsNullOrWhiteSpace([string]$waitResult.message)) {
            Write-Host ([string]$waitResult.message)
        }
        return [int]$waitResult.exitCode
    }
    catch {
        throw "Administrator-launched revAgent stable bootstrap could not run a normal limited coordinator for '$currentUser': $($_.Exception.Message)"
    }
    finally {
        if ($taskRegistered -and $null -ne $waitResult -and [bool]$waitResult.completed) {
            try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop | Out-Null }
            catch { Write-Warning "Could not remove completed revAgent bootstrap coordinator task '$taskName': $($_.Exception.Message)" }
            Remove-RevAgentBootstrapTemporaryPath -Path $coordinatorResultPath
        }
        if ($mutexAcquired -and $null -ne $registrationMutex) {
            try { $registrationMutex.ReleaseMutex() }
            catch { }
        }
        if ($null -ne $registrationMutex) { $registrationMutex.Dispose() }
    }
}

function Invoke-AuthenticatedBootstrapApply {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$EvidenceSource,
        [Parameter(Mandatory = $true)][string]$ExpectedEvidenceSha256,
        [Parameter(Mandatory = $true)][string]$ExpectedInstallerSha256,
        [Parameter(Mandatory = $true)][string]$TrustedKeysSource
    )

    if (-not (Test-IsAdmin)) { throw "Elevated bootstrap refresh requires administrator permission." }
    foreach ($required in @($SourceRoot, $EvidenceSource, $ExpectedEvidenceSha256, $ExpectedInstallerSha256, $TrustedKeysSource)) {
        if ([string]::IsNullOrWhiteSpace($required)) { throw "Elevated bootstrap refresh is missing a required authenticated input." }
    }
    if ((Get-Sha256Hex -Path $EvidenceSource) -ne $ExpectedEvidenceSha256) { throw "Bootstrap refresh evidence changed before elevation." }
    $evidenceDocument = Get-Content -Raw -LiteralPath $EvidenceSource | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$evidenceDocument.sources.trustedKeys)) {
        throw "Bootstrap refresh evidence is missing the trusted keys hash."
    }
    if (-not (Test-RevAgentStringEquals -Left (Get-Sha256Hex -Path $TrustedKeysSource) -Right ([string]$evidenceDocument.sources.trustedKeys) -IgnoreCase)) {
        throw "Bootstrap refresh trusted keys changed before elevation."
    }
    $installerSource = Join-Path $SourceRoot 'installer\nas\install-revagent-local-bootstrap.ps1'
    if ((Get-Sha256Hex -Path $installerSource) -ne $ExpectedInstallerSha256) { throw "Bootstrap refresh installer changed before elevation." }

    $programData = Get-RevAgentProgramDataRoot
    $dpeRoot = Join-Path $programData 'DPE'
    $productRoot = Join-Path $dpeRoot 'revAgent'
    $prestageRoot = Join-Path $productRoot 'prestage'
    New-Item -ItemType Directory -Path $dpeRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $productRoot -Force | Out-Null
    Set-AdminOnlyAcl -Path $productRoot
    New-Item -ItemType Directory -Path $prestageRoot -Force | Out-Null
    Set-AdminOnlyAcl -Path $prestageRoot

    $stagedEvidence = Join-Path $prestageRoot 'bootstrap-prestage-evidence.json'
    $stagedInstaller = Join-Path $prestageRoot 'install-revagent-local-bootstrap.ps1'
    $stagedTrustedKeys = Join-Path $prestageRoot 'release-trusted-keys.json'
    foreach ($target in @($stagedEvidence, $stagedInstaller, $stagedTrustedKeys)) {
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    }
    Copy-Item -LiteralPath $EvidenceSource -Destination $stagedEvidence -Force
    Copy-Item -LiteralPath $installerSource -Destination $stagedInstaller -Force
    Copy-Item -LiteralPath $TrustedKeysSource -Destination $stagedTrustedKeys -Force
    foreach ($target in @($stagedEvidence, $stagedInstaller, $stagedTrustedKeys)) { Set-AdminOnlyAcl -Path $target }

    & $stagedInstaller `
        -RepoRoot $SourceRoot `
        -ReleaseRoot $ReleaseRoot `
        -TrustedKeysPath $stagedTrustedKeys `
        -ExpectedHashesPath $stagedEvidence `
        -ConfirmIndependentlyAuthenticatedSource | Out-Host
}

function Invoke-RevAgentBootstrapRefreshMain {
    Write-Host (Get-RevAgentBootstrapExitMessage -ExitCode $script:RevAgentExitBootstrapTrustRequired)
    return $script:RevAgentExitBootstrapTrustRequired
}

$mainExitCode = 1
$mainFailure = $null
try {
    $mainExitCode = [int](Invoke-RevAgentBootstrapRefreshMain)
}
catch {
    $mainFailure = $_
    $mainExitCode = 1
}
finally {
    if ($CoordinatorRelaunchedFromAdmin -and
        -not [string]::IsNullOrWhiteSpace($CoordinatorNonce) -and
        -not [string]::IsNullOrWhiteSpace($CoordinatorResultPath)) {
        $coordinatorMessage = if ($null -ne $mainFailure) {
            [string]$mainFailure.Exception.Message
        }
        else {
            Get-RevAgentBootstrapExitMessage -ExitCode $mainExitCode
        }
        try {
            Write-RevAgentCoordinatorResultMarker `
                -Path $CoordinatorResultPath `
                -Nonce $CoordinatorNonce `
                -ExitCode $mainExitCode `
                -Message $coordinatorMessage
        }
        catch {
            Write-Warning "Could not write the revAgent bootstrap coordinator result marker: $($_.Exception.Message)"
        }
    }
}

if ($null -ne $mainFailure) {
    Write-Error -Message ([string]$mainFailure.Exception.Message) -ErrorAction Continue
}
exit $mainExitCode
