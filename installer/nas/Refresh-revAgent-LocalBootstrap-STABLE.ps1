<#
.SYNOPSIS
    Refresh the protected local bootstrap through the IT-prestaged fixed
    machine-trust broker, or fail closed when that trust core is unhealthy.
#>

[CmdletBinding()]
param(
    [string]$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy",
    [ValidateSet("stable")][string]$Channel = "stable"
)

if ("$($ExecutionContext.SessionState.LanguageMode)" -ne 'FullLanguage') {
    Write-Host "revAgent updater cannot run: PowerShell is in $($ExecutionContext.SessionState.LanguageMode) mode."
    Write-Host "This is typically caused by Smart App Control or a WDAC/AppLocker policy on this machine."
    Write-Host "Ask IT to exempt/sign the revAgent deployment scripts or disable Smart App Control, then retry."
    exit 78
}

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:RevAgentExitCoordinatorAlreadyRunning = 80
$script:RevAgentExitCoordinatorTimeout = 81
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

# Production initializes only trusted PowerShell modules before it loads and
# attests the protected machine trust core used by the active E2 broker flow.

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

function Get-RevAgentProgramDataRoot {
    return [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
}

function Get-RevAgentBootstrapExitMessage {
    param([int]$ExitCode)

    switch ($ExitCode) {
        80 { return "A revAgent bootstrap trust broker request is already running. Wait for it to finish, then run this updater again." }
        81 { return "The revAgent bootstrap trust broker is still running. Wait for it to finish, then run this updater again." }
        84 { return "Automatic revAgent protected bootstrap install or refresh requires the IT-prestaged machine trust core. Ask the DPE revAgent administrator to run the revAgent IT prestage kit on this machine, then run this updater again." }
        default { return "" }
    }
}

function Get-RevAgentBootstrapTempRoot {
    return [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
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

function Get-RevAgentLocalAppDataRoot {
    return [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
}

function Get-RevAgentBootstrapTrustClientContext {
    $programDataRoot = [IO.Path]::GetFullPath((Get-RevAgentProgramDataRoot)).TrimEnd('\')
    $trustRoot = Join-Path $programDataRoot 'DPE\revAgent\trust'
    $modulePath = Join-Path $trustRoot 'RevAgent.BootstrapTrust.psm1'
    if (-not [IO.File]::Exists($modulePath)) { return $null }

    try {
        $module = Microsoft.PowerShell.Core\Import-Module -Name $modulePath -Force -PassThru -ErrorAction Stop
        $commands = [ordered]@{}
        foreach ($name in @(
                'Test-RevAgentBootstrapTrustHealth',
                'New-RevAgentBootstrapTrustRequest',
                'Start-RevAgentBootstrapTrustBrokerTask',
                'Wait-RevAgentBootstrapTrustResult',
                'Remove-RevAgentBootstrapTrustClientArtifacts'
            )) {
            $commands[$name] = Get-Command ("{0}\{1}" -f $module.Name, $name) -ErrorAction Stop
        }

        $health = & $commands['Test-RevAgentBootstrapTrustHealth']
        if ($null -eq $health -or
            $null -eq $health.PSObject.Properties['healthy'] -or
            -not [bool]$health.healthy) {
            $reason = if ($null -ne $health -and $null -ne $health.PSObject.Properties['reason']) { [string]$health.reason } else { 'health_check_failed' }
            Write-Warning "The IT-prestaged revAgent machine trust core is not healthy: $reason"
            return $null
        }
        if ($null -eq $health.PSObject.Properties['layout'] -or $null -eq $health.layout) {
            Write-Warning 'The IT-prestaged revAgent machine trust core health result has no canonical layout.'
            return $null
        }

        return [pscustomobject][ordered]@{
            module = $module
            commands = $commands
            health = $health
            layout = $health.layout
        }
    }
    catch {
        Write-Warning "The IT-prestaged revAgent machine trust core could not be loaded or verified: $($_.Exception.Message)"
        return $null
    }
}

function New-RevAgentBootstrapAuthenticatedInbox {
    param([Parameter(Mandatory = $true)][object]$TrustContext)

    $layout = $TrustContext.layout
    foreach ($propertyName in @('trustRoot', 'releaseSnapshotModulePath', 'distributionIntegrityModulePath', 'trustedKeysPath')) {
        if ($null -eq $layout.PSObject.Properties[$propertyName] -or [string]::IsNullOrWhiteSpace([string]$layout.$propertyName)) {
            throw "Bootstrap trust health is missing the protected $propertyName path."
        }
    }
    $trustRoot = [IO.Path]::GetFullPath([string]$layout.trustRoot).TrimEnd('\')
    foreach ($pathValue in @($layout.releaseSnapshotModulePath, $layout.distributionIntegrityModulePath, $layout.trustedKeysPath)) {
        $fullPath = [IO.Path]::GetFullPath([string]$pathValue)
        if (-not (Test-RevAgentStringStartsWith -Value $fullPath -Prefix ($trustRoot + '\') -IgnoreCase)) {
            throw "Bootstrap trust health returned a protected dependency outside its trust root: $fullPath"
        }
    }

    $snapshotModule = Microsoft.PowerShell.Core\Import-Module -Name ([string]$layout.releaseSnapshotModulePath) -Force -PassThru -ErrorAction Stop
    $newInboxCommand = Get-Command ("{0}\New-RevAgentAuthenticatedReleaseInbox" -f $snapshotModule.Name) -ErrorAction Stop
    $inbox = & $newInboxCommand `
        -ReleaseRoot $ReleaseRoot `
        -Channel $Channel `
        -TrustedKeysPath ([string]$layout.trustedKeysPath) `
        -IntegrityModulePath ([string]$layout.distributionIntegrityModulePath)
    if ($null -eq $inbox -or
        [string]$inbox.inboxId -notmatch '^[0-9a-f]{32}$' -or
        [string]::IsNullOrWhiteSpace([string]$inbox.inboxRoot)) {
        throw 'Authenticated stable release acquisition did not return one complete local inbox.'
    }
    return $inbox
}

function Remove-RevAgentBootstrapAuthenticatedInbox {
    param([AllowNull()][object]$Inbox)

    if ($null -eq $Inbox -or
        $null -eq $Inbox.PSObject.Properties['inboxId'] -or
        $null -eq $Inbox.PSObject.Properties['inboxRoot']) { return }
    $inboxId = [string]$Inbox.inboxId
    if ($inboxId -notmatch '^[0-9a-f]{32}$') { throw 'Refusing cleanup for an invalid authenticated release inbox id.' }

    $allowedRoot = [IO.Path]::GetFullPath((Join-Path (Get-RevAgentLocalAppDataRoot) 'DPE\revAgent\release-inbox')).TrimEnd('\')
    $expectedPath = [IO.Path]::GetFullPath((Join-Path $allowedRoot $inboxId)).TrimEnd('\')
    $inboxPath = [IO.Path]::GetFullPath([string]$Inbox.inboxRoot).TrimEnd('\')
    if (-not (Test-RevAgentStringEquals -Left $inboxPath -Right $expectedPath -IgnoreCase)) {
        throw "Refusing authenticated release inbox cleanup outside its exact user-local path: $inboxPath"
    }
    if (-not [IO.Directory]::Exists($inboxPath)) { return }

    $cleanupState = [pscustomobject]@{
        itemCount = 0
        maxItems = 100000
        maxDepth = 64
        maxPassesPerDirectory = 32
    }
    Clear-RevAgentBootstrapTemporaryDirectoryNoFollow `
        -Path $inboxPath `
        -CleanupRoot $inboxPath `
        -State $cleanupState
    if ([IO.Directory]::Exists($inboxPath)) { [IO.Directory]::Delete($inboxPath, $false) }
    if ([IO.Directory]::Exists($inboxPath)) { throw "Authenticated release inbox cleanup was incomplete: $inboxPath" }
}

function Start-RevAgentPostRefreshLauncher {
    $bootstrapRoot = Join-Path (Get-RevAgentProgramDataRoot) 'DPE\revAgent\bootstrap'
    $bootstrapScript = Join-Path $bootstrapRoot 'Start-revAgent-Update.ps1'
    $bootstrapState = Join-Path $bootstrapRoot 'bootstrap-state.json'
    $launcherPath = Join-Path $bootstrapRoot 'Start-revAgent-Update.cmd'
    foreach ($requiredPath in @($bootstrapScript, $bootstrapState, $launcherPath)) {
        if (-not [IO.File]::Exists($requiredPath)) {
            throw "The revAgent bootstrap trust broker reported success without installing a required protected bootstrap file: $requiredPath"
        }
    }

    $systemDirectory = [Environment]::SystemDirectory
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = Join-Path $systemDirectory 'cmd.exe'
    $startInfo.Arguments = '/d /s /c ""{0}" --post-refresh"' -f $launcherPath
    $startInfo.WorkingDirectory = $systemDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) { throw 'The protected revAgent post-refresh launcher did not start.' }
    try {
        $process.WaitForExit()
        return [int]$process.ExitCode
    }
    finally { $process.Dispose() }
}

function Get-RevAgentBootstrapTrustMutexName {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { return 'Local\revAgentBootstrapTrustRefresh-' + [string]$identity.User.Value }
    finally { $identity.Dispose() }
}

function Invoke-RevAgentBootstrapRefreshMain {
    Initialize-TrustedPowerShellModules

    $trustContext = Get-RevAgentBootstrapTrustClientContext
    if ($null -eq $trustContext) {
        Write-Host (Get-RevAgentBootstrapExitMessage -ExitCode $script:RevAgentExitBootstrapTrustRequired)
        return $script:RevAgentExitBootstrapTrustRequired
    }

    $refreshMutex = $null
    $mutexAcquired = $false
    $inbox = $null
    $request = $null
    try {
        $refreshMutex = [Threading.Mutex]::new($false, (Get-RevAgentBootstrapTrustMutexName))
        try { $mutexAcquired = $refreshMutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $mutexAcquired = $true }
        if (-not $mutexAcquired) {
            Write-Host (Get-RevAgentBootstrapExitMessage -ExitCode $script:RevAgentExitCoordinatorAlreadyRunning)
            return $script:RevAgentExitCoordinatorAlreadyRunning
        }

        $inbox = New-RevAgentBootstrapAuthenticatedInbox -TrustContext $trustContext
        $request = & $trustContext.commands['New-RevAgentBootstrapTrustRequest'] -InboxId ([string]$inbox.inboxId)
        if ($null -eq $request -or
            [string]$request.inboxId -ne [string]$inbox.inboxId -or
            [string]$request.nonce -notmatch '^[0-9a-f]{32}$') {
            throw 'The revAgent bootstrap trust core did not create an exact nonce-bound request for the authenticated inbox.'
        }

        [void](& $trustContext.commands['Start-RevAgentBootstrapTrustBrokerTask'])
        $waitResult = & $trustContext.commands['Wait-RevAgentBootstrapTrustResult'] -Request $request -TimeoutSeconds 600
        if ($null -eq $waitResult -or
            $null -eq $waitResult.PSObject.Properties['completed'] -or
            $null -eq $waitResult.PSObject.Properties['timedOut'] -or
            $null -eq $waitResult.PSObject.Properties['exitCode']) {
            throw 'The revAgent bootstrap trust broker returned an incomplete protected result.'
        }
        if ([bool]$waitResult.timedOut -or -not [bool]$waitResult.completed) {
            Write-Host (Get-RevAgentBootstrapExitMessage -ExitCode $script:RevAgentExitCoordinatorTimeout)
            return $script:RevAgentExitCoordinatorTimeout
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$waitResult.message)) { Write-Host ([string]$waitResult.message) }
        if ([int]$waitResult.exitCode -ne 0) { return [int]$waitResult.exitCode }

        return [int](Start-RevAgentPostRefreshLauncher)
    }
    finally {
        if ($null -ne $request) {
            try { & $trustContext.commands['Remove-RevAgentBootstrapTrustClientArtifacts'] -Request $request }
            catch { Write-Warning "Bootstrap trust request cleanup was deferred: $($_.Exception.Message)" }
        }
        if ($null -ne $inbox) {
            try { Remove-RevAgentBootstrapAuthenticatedInbox -Inbox $inbox }
            catch { Write-Warning "Authenticated release inbox cleanup was deferred: $($_.Exception.Message)" }
        }
        try { Remove-StaleRevAgentBootstrapTemporaryItems }
        catch { }
        if ($mutexAcquired -and $null -ne $refreshMutex) {
            try { $refreshMutex.ReleaseMutex() }
            catch { }
        }
        if ($null -ne $refreshMutex) { $refreshMutex.Dispose() }
    }
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

if ($null -ne $mainFailure) {
    Write-Error -Message ([string]$mainFailure.Exception.Message) -ErrorAction Continue
}
exit $mainExitCode
