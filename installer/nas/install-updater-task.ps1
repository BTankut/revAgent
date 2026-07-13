<#
.SYNOPSIS
    Install the workstation updater and register a scheduled update check.

.DESCRIPTION
    Copies update-from-nas.ps1 to a local managed folder, writes updater config,
    and registers a per-user scheduled task. The task reads the NAS release
    target once per day at the configured local time. Revit-loaded payload
    updates are deferred while Revit is open; non-Revit payload updates may
    continue.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ChannelManifestPath,

    [string]$InstallRoot = "",
    [string]$WorkRoot = "",
    [string]$PackageTarget = "",
    [string]$ServerTarget = "",
    [string]$WorkspaceAgentsTarget = "",
    [string]$RevitInstallRoot = "",
    [ValidateSet("2022", "2023", "2024", "2025")]
    [string]$RevitVersion = "2022",
    [string]$ProxyUrl = "http://192.168.90.10:6588",
    [string]$ProxyBypass = "<local>",
    [string]$CodexWorkspaceRoot = "C:\Projects",
    [ValidateSet("", "managed-user-pack", "preserve-local")]
    [string]$CodexInstructionPolicy = "",
    [string]$MachineRole = "",
    [string[]]$LegacyServerTargets = @(),
    [string]$ReportsRoot = "",
    [string]$TaskName = "revAgent Auto Update",
    [string]$DailyAt = "12:00",
    [ValidateRange(5, 1440)]
    [int]$CheckIntervalMinutes = 30,
    [ValidateRange(15, 10080)]
    [int]$NotificationThrottleMinutes = 240,
    [string]$LogPath = "",
    [string]$OperationMethod = "",
    [switch]$SkipNpmInstall,
    [switch]$SkipCodexMcpRegistration,
    [switch]$SkipCodexUserIntegration,
    [switch]$SkipProxySetup,
    [switch]$NoScheduledTask,
    [switch]$RunNow,
    [switch]$ForceUpdate,
    [switch]$RunSourceFreeMigration,
    [switch]$MachinePhaseOnly,
    [switch]$UserPhaseOnly,
    [string]$PhaseResultPath = "",
    [string]$TargetInteractiveUser = "",
    [string]$TargetInteractiveUserSid = "",
    [string]$TargetUserProfileRoot = "",
    [string]$TargetCodexHome = "",
    [switch]$ModulePathSecuritySmokeTest
)

$ErrorActionPreference = "Stop"
$script:RevAgentOsSystemDirectory = [Environment]::SystemDirectory
$script:RevAgentOsProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$script:RevAgentOsProgramFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
$script:RevAgentOsCommonAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$script:RevAgentOsUserProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$script:RevAgentOsAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
$script:RevAgentOsLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)

function Initialize-RevAgentTrustedPowerShellModules {
    # `-NoProfile` still inherits PSModulePath and permits module autoload. Keep
    # only canonical administrator-owned roots before any trust check runs.
    $candidateRoots = [System.Collections.Generic.List[string]]::new()
    [void]$candidateRoots.Add([System.IO.Path]::Combine($PSHOME, 'Modules'))
    [void]$candidateRoots.Add([System.IO.Path]::Combine($script:RevAgentOsSystemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules'))
    foreach ($programFilesRoot in @($script:RevAgentOsProgramFiles, $script:RevAgentOsProgramFilesX86)) {
        if ([string]::IsNullOrWhiteSpace($programFilesRoot)) { continue }
        [void]$candidateRoots.Add([System.IO.Path]::Combine($programFilesRoot, 'WindowsPowerShell', 'Modules'))
        [void]$candidateRoots.Add([System.IO.Path]::Combine($programFilesRoot, 'PowerShell', 'Modules'))
    }

    $trustedRoots = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $candidateRoots) {
        $fullPath = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\')
        if (-not [System.IO.Directory]::Exists($fullPath) -or -not $seen.Add($fullPath)) { continue }
        if (([System.IO.File]::GetAttributes($fullPath) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Trusted PowerShell module root is a reparse point: $fullPath"
        }
        [void]$trustedRoots.Add($fullPath)
    }
    if ($trustedRoots.Count -eq 0) { throw 'No canonical administrator-owned PowerShell module root was found.' }
    $env:PSModulePath = [string]::Join([System.IO.Path]::PathSeparator, $trustedRoots.ToArray())

    foreach ($moduleName in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Archive', 'CimCmdlets')) {
        $manifestPath = [System.IO.Path]::Combine($PSHOME, 'Modules', $moduleName, ($moduleName + '.psd1'))
        if (-not [System.IO.File]::Exists($manifestPath)) { throw "Required built-in PowerShell module manifest was not found: $manifestPath" }
        Microsoft.PowerShell.Core\Import-Module -Name $manifestPath -Force -ErrorAction Stop
    }
    $scheduledTasksManifest = [System.IO.Path]::Combine($script:RevAgentOsSystemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules', 'ScheduledTasks', 'ScheduledTasks.psd1')
    if (-not [System.IO.File]::Exists($scheduledTasksManifest)) { throw "Required ScheduledTasks module manifest was not found: $scheduledTasksManifest" }
    Microsoft.PowerShell.Core\Import-Module -Name $scheduledTasksManifest -Force -ErrorAction Stop
    return $env:PSModulePath
}

$script:RevAgentTrustedPowerShellModulePath = Initialize-RevAgentTrustedPowerShellModules
if ($ModulePathSecuritySmokeTest) {
    $getAclCommand = Microsoft.PowerShell.Core\Get-Command Get-Acl -CommandType Cmdlet -ErrorAction Stop
    $expandArchiveCommand = Microsoft.PowerShell.Core\Get-Command Expand-Archive -CommandType Function -ErrorAction Stop
    [pscustomobject][ordered]@{
        success = $true
        action = 'module-path-security-smoke-test'
        psModulePath = $env:PSModulePath
        getAclModulePath = [string]$getAclCommand.Module.Path
        expandArchiveModulePath = [string]$expandArchiveCommand.Module.Path
    } | ConvertTo-Json -Compress
    return
}

function Assert-InstallEarlyReleaseFile {
    param([string]$Path, [string]$ReleaseRoot, [string[]]$BlockedSids)
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullRoot = [System.IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\")
    if (-not ($fullPath + "\").StartsWith($fullRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) { throw "Pre-import bootstrap path escaped pinned root: $fullPath" }
    $writeMask = [System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    function Assert-InstallEarlyDirectoryEffectivelyReadOnly {
        param([string]$Directory)
        $reportsRoot = Join-Path $fullRoot "reports"
        if (($Directory + "\").StartsWith($reportsRoot.TrimEnd("\") + "\", [System.StringComparison]::OrdinalIgnoreCase)) { return }
        $probePath = Join-Path $Directory (".revagent-sealed-probe-{0}.tmp" -f [Guid]::NewGuid().ToString("N"))
        $stream = $null
        $created = $false
        try {
            $stream = [System.IO.File]::Open($probePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            $created = $true
        }
        catch {
            $probeException = $_.Exception
            $accessDenied = $false
            while ($null -ne $probeException) {
                $errorCode = [int]$probeException.HResult -band 0xFFFF
                if ($probeException -is [System.UnauthorizedAccessException] -or $errorCode -eq 5) { $accessDenied = $true; break }
                $probeException = $probeException.InnerException
            }
            if ($accessDenied) { return }
            throw "Pre-import bootstrap effective writability CreateNew probe failed unexpectedly for '$Directory': $($_.Exception.Message)"
        }
        finally {
            if ($null -ne $stream) { $stream.Dispose() }
        }
        if ($created) {
            try { [System.IO.File]::Delete($probePath) }
            catch { throw "Pre-import bootstrap effective writability probe succeeded but cleanup failed for '$probePath': $($_.Exception.Message)" }
            if (Test-Path -LiteralPath $probePath) { throw "Pre-import bootstrap effective writability probe cleanup did not remove '$probePath'." }
            throw "Pre-import bootstrap path is effectively writable and is not sealed (CreateNew succeeded): $Directory"
        }
    }
    $cursor = $fullPath
    while (($cursor + "\").StartsWith($fullRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
        if (-not (Test-Path -LiteralPath $cursor)) { throw "Pre-import bootstrap path is missing: $cursor" }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) { throw "Pre-import bootstrap path contains a link/reparse component: $cursor" }
        if ($item.PSIsContainer) { Assert-InstallEarlyDirectoryEffectivelyReadOnly -Directory $item.FullName }
        $rules = (Get-Acl -LiteralPath $cursor -ErrorAction Stop).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
        foreach ($rule in $rules) {
            if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and (($rule.FileSystemRights -band $writeMask) -ne 0)) { throw "Pre-import bootstrap path is not sealed read-only. principal=$($rule.IdentityReference.Value) rights=$($rule.FileSystemRights) path=$cursor" }
        }
        if ([string]::Equals($cursor.TrimEnd("\"), $fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }
    return $fullPath
}

function Assert-InstallEarlyReleaseSurface {
    param([string]$ChannelPath, [string]$ReleaseRoot, [string]$ToolsRoot, [string]$InteractiveSid)
    $blockedSids = @("S-1-1-0", "S-1-5-11", "S-1-5-32-545", $InteractiveSid) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $channelFullPath = Assert-InstallEarlyReleaseFile -Path $ChannelPath -ReleaseRoot $ReleaseRoot -BlockedSids $blockedSids
    $channel = Get-Content -Raw -LiteralPath $channelFullPath | ConvertFrom-Json
    $manifestPath = [string]$channel.manifestPath
    if (-not [System.IO.Path]::IsPathRooted($manifestPath)) { $manifestPath = Join-Path (Split-Path -Parent $channelFullPath) $manifestPath }
    $manifestPath = Assert-InstallEarlyReleaseFile -Path $manifestPath -ReleaseRoot $ReleaseRoot -BlockedSids $blockedSids
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $surfaceMap = [ordered]@{
        updaterTaskInstaller = @("installer\nas\install-updater-task.ps1", "install-updater-task.ps1")
        updater = @("installer\nas\update-from-nas.ps1", "update-from-nas.ps1")
        versionStatusTool = @("installer\nas\show-installed-version.ps1", "show-installed-version.ps1")
        sourceFreeMigrationTool = @("installer\nas\migrate-source-free-install.ps1", "migrate-source-free-install.ps1")
        codexUserIntegrationTool = @("installer\nas\Invoke-revAgent-CodexUserIntegration.ps1", "Invoke-revAgent-CodexUserIntegration.ps1")
        installerLibHiddenLauncher = @("installer\lib\RevAgent.HiddenLauncher.psm1", "lib\RevAgent.HiddenLauncher.psm1")
        installerLibScheduledTask = @("installer\lib\RevAgent.ScheduledTask.psm1", "lib\RevAgent.ScheduledTask.psm1")
        installerLibVersions = @("installer\lib\RevAgent.RevitVersions.psm1", "lib\RevAgent.RevitVersions.psm1")
        installerLibPermissions = @("installer\lib\RevAgent.Permissions.psm1", "lib\RevAgent.Permissions.psm1")
        installerLibSecureTemp = @("installer\lib\RevAgent.SecureTemp.psm1", "lib\RevAgent.SecureTemp.psm1")
        installerLibProxy = @("installer\lib\RevAgent.Proxy.psm1", "lib\RevAgent.Proxy.psm1")
        installerLibLogRetention = @("installer\lib\RevAgent.LogRetention.psm1", "lib\RevAgent.LogRetention.psm1")
        installerLibCodexRegistration = @("installer\lib\RevAgent.CodexRegistration.psm1", "lib\RevAgent.CodexRegistration.psm1")
        installerLibReporting = @("installer\lib\RevAgent.Reporting.psm1", "lib\RevAgent.Reporting.psm1")
        installerLibDesktopLauncherCleanup = @("installer\lib\RevAgent.DesktopLauncherCleanup.psm1", "lib\RevAgent.DesktopLauncherCleanup.psm1")
        installerLibDistributionIntegrity = @("installer\lib\RevAgent.DistributionIntegrity.psm1", "lib\RevAgent.DistributionIntegrity.psm1")
    }
    $verifiedSurfaceHashes = [ordered]@{}
    foreach ($surface in $surfaceMap.GetEnumerator()) {
        $component = $manifest.components.($surface.Key)
        $filePath = Assert-InstallEarlyReleaseFile -Path (Join-Path $ToolsRoot ([string]$surface.Value[1])) -ReleaseRoot $ReleaseRoot -BlockedSids $blockedSids
        if ($null -eq $component -or -not [string]::Equals(([string]$component.path).Replace("/", "\"), [string]$surface.Value[0], [System.StringComparison]::OrdinalIgnoreCase)) { throw "Missing or invalid bootstrap manifest component: $($surface.Key)" }
        if (-not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $filePath).Hash, [string]$component.sha256, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Bootstrap pre-import hash mismatch: $($surface.Key)" }
        $verifiedSurfaceHashes[$surface.Key] = [string]$component.sha256
    }
    $keysPath = Assert-InstallEarlyReleaseFile -Path (Join-Path $ToolsRoot "config\release-trusted-keys.json") -ReleaseRoot $ReleaseRoot -BlockedSids $blockedSids
    foreach ($signaturePath in @((Join-Path (Split-Path -Parent $channelFullPath) (([System.IO.Path]::GetFileNameWithoutExtension($channelFullPath)) + ".sig.json")), (Join-Path (Split-Path -Parent $manifestPath) (([System.IO.Path]::GetFileNameWithoutExtension($manifestPath)) + ".sig.json")))) { [void](Assert-InstallEarlyReleaseFile -Path $signaturePath -ReleaseRoot $ReleaseRoot -BlockedSids $blockedSids) }
    $keys = Get-Content -Raw -LiteralPath $keysPath | ConvertFrom-Json
    $normalizedKey = ([string]$keys.trustedKeys."revagent-prod-rsa-2026q3".publicKeyXml).Trim() -replace "\s+", ""
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $fingerprint = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalizedKey)))).Replace("-", "") } finally { $sha.Dispose() }
    if ($fingerprint -ne "32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33") { throw "Pinned release key fingerprint mismatch." }
    $integrityModulePath = Join-Path $ToolsRoot "lib\RevAgent.DistributionIntegrity.psm1"
    $pinnedIntegrityModuleHash = "2360CC209EAAD6AEF26E90F6865427914CDE499F0F6F8838296D5F5381F371B4"
    $actualIntegrityModuleHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $integrityModulePath).Hash
    if (-not [string]::Equals($actualIntegrityModuleHash, $pinnedIntegrityModuleHash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Pinned pre-import integrity verifier hash mismatch. Expected=$pinnedIntegrityModuleHash Actual=$actualIntegrityModuleHash"
    }
    $script:InstallVerifiedTrustedKeysPath = $keysPath
    $script:InstallVerifiedTrustedKeysSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $keysPath).Hash
    $integrityModule = Import-Module $integrityModulePath -Force -PassThru
    $verifyCommand = Get-Command ("{0}\Test-RevAgentReleaseDistributionIntegrity" -f $integrityModule.Name) -ErrorAction Stop
    $verification = & $verifyCommand -ChannelPath $channelFullPath -Channel $channel -ReleaseManifestPath $manifestPath -ReleaseManifest $manifest -TrustedKeys $keys.trustedKeys -Policy enforce
    if (-not [bool]$verification.success) { throw "Signed bootstrap pre-import verification failed: $($verification.reason). $($verification.message)" }
    $script:InstallVerifiedSurfaceHashes = $verifiedSurfaceHashes
}

# Fail closed before sibling-module resolution. This entrypoint has no supported
# mutating legacy mode; the visible GUI must select exactly one privilege phase.
$earlyProcessIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$earlyProcessPrincipal = [System.Security.Principal.WindowsPrincipal]::new($earlyProcessIdentity)
$earlyProcessElevated = $earlyProcessPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
if ($MachinePhaseOnly -and $UserPhaseOnly) { throw "-MachinePhaseOnly and -UserPhaseOnly are mutually exclusive." }
if (-not $MachinePhaseOnly -and -not $UserPhaseOnly) { throw "Legacy updater bootstrap execution is disabled before module import. Start the protected GUI." }
if ($MachinePhaseOnly -and -not $earlyProcessElevated) { throw "-MachinePhaseOnly requires an elevated process before module import." }
if ($UserPhaseOnly -and $earlyProcessElevated) { throw "-UserPhaseOnly must run in the original unelevated interactive-user process before module import." }

if ($MachinePhaseOnly) {
    $channelFullPath = [System.IO.Path]::GetFullPath($ChannelManifestPath)
    $releaseRoot = Split-Path -Parent (Split-Path -Parent $channelFullPath)
    $canonicalReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
    if (-not [string]::Equals(
            [System.IO.Path]::GetFullPath($releaseRoot).TrimEnd("\"),
            [System.IO.Path]::GetFullPath($canonicalReleaseRoot).TrimEnd("\"),
            [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Elevated updater bootstrap requires the canonical revAgent release root: $canonicalReleaseRoot"
    }
    $trustedToolsRoot = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot "tools")).TrimEnd("\")
    $scriptRootFullPath = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd("\")
    if (-not $scriptRootFullPath.StartsWith("\\", [System.StringComparison]::Ordinal) -or
        -not [string]::Equals($scriptRootFullPath, $trustedToolsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Elevated updater bootstrap must run from the canonical read-only release tools root. expected=$trustedToolsRoot actual=$scriptRootFullPath"
    }
    $expectedBootstrapEntrypoint = [System.IO.Path]::GetFullPath((Join-Path $trustedToolsRoot "install-updater-task.ps1"))
    if (-not [string]::Equals([System.IO.Path]::GetFullPath($PSCommandPath), $expectedBootstrapEntrypoint, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Elevated updater bootstrap must run the exact signed canonical entrypoint '$expectedBootstrapEntrypoint'; refusing '$PSCommandPath'."
    }
    Assert-InstallEarlyReleaseSurface -ChannelPath $channelFullPath -ReleaseRoot $releaseRoot -ToolsRoot $trustedToolsRoot -InteractiveSid $TargetInteractiveUserSid
}
$nasLibRoot = @(
    (Join-Path $PSScriptRoot "lib"),
    (Join-Path (Split-Path -Parent $PSScriptRoot) "lib")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($nasLibRoot)) {
    throw "revAgent updater lib folder was not found beside or above: $PSScriptRoot"
}
Import-Module (Join-Path $nasLibRoot "RevAgent.SecureTemp.psm1") -Force
$script:RevAgentSecureMachineTempContext = $null
if ($MachinePhaseOnly) {
    $earlyIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $earlyPrincipal = [Security.Principal.WindowsPrincipal]::new($earlyIdentity)
    if (-not $earlyPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "-MachinePhaseOnly requires an elevated process before module import."
    }
    $script:RevAgentSecureMachineTempContext = Initialize-RevAgentSecureMachineTemp
}
Import-Module (Join-Path $nasLibRoot "RevAgent.HiddenLauncher.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.ScheduledTask.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.RevitVersions.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.Permissions.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.Proxy.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.LogRetention.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.CodexRegistration.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.Reporting.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.DesktopLauncherCleanup.psm1") -Force
Set-RevAgentCurrentProcessUtf8Console | Out-Null

if ($RunSourceFreeMigration) {
    $RunNow = $true
}

$script:RevAgentTranscriptStarted = $false
$script:RevAgentLogPath = ""
$script:PreviousTranscriptActive = $env:REVIT_MCP_TRANSCRIPT_ACTIVE
$script:PreviousLogPath = $env:REVIT_MCP_LOG_PATH
$script:RevAgentRemoteReportsRoot = ""
$script:RevAgentLatestReport = $null
$script:RevAgentOperation = "install"
$script:RevAgentOperationMethod = ""
$script:RevAgentCodexUserIntegrationPhase = $null
$script:RevAgentDesktopLauncherCleanup = [ordered]@{
    enabled = $true
    mode = "not-run"
    matchedCount = 0
    removedCount = 0
    failedCount = 0
    matched = @()
    removed = @()
    failed = @()
}

function Initialize-RevAgentTranscript {
    param(
        [string]$PreferredWorkRoot,
        [string]$RequestedLogPath,
        [string]$Prefix
    )

    if ($MachinePhaseOnly) {
        Remove-Item Env:\REVIT_MCP_TRANSCRIPT_ACTIVE -ErrorAction SilentlyContinue
        Remove-Item Env:\REVIT_MCP_LOG_PATH -ErrorAction SilentlyContinue
    }
    if ($env:REVIT_MCP_TRANSCRIPT_ACTIVE -eq "1") {
        $script:RevAgentLogPath = $env:REVIT_MCP_LOG_PATH
        return
    }

    $path = $RequestedLogPath
    if ([string]::IsNullOrWhiteSpace($path)) {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $logRoot = Join-Path $PreferredWorkRoot $(if ($MachinePhaseOnly) { "machine-logs" } else { "logs" })
        $path = Join-Path $logRoot ("{0}-{1}.log" -f $Prefix, $stamp)
    }

    try {
        $logDir = Split-Path -Parent $path
        if (-not [string]::IsNullOrWhiteSpace($logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
    }
    catch {
        if ($MachinePhaseOnly) {
            throw "Machine-phase transcript directory could not be created under protected machine-logs. Intended path: $path. $($_.Exception.Message)"
        }
        $path = Join-Path $env:TEMP ("revAgent-{0}-{1}.log" -f $Prefix, (Get-Date -Format "yyyyMMdd-HHmmss"))
    }

    try {
        Start-Transcript -Path $path -Append | Out-Null
        $script:RevAgentTranscriptStarted = $true
        $script:RevAgentLogPath = $path
        $env:REVIT_MCP_TRANSCRIPT_ACTIVE = "1"
        $env:REVIT_MCP_LOG_PATH = $path
        Write-Host "Install log     : $path" -ForegroundColor Green
    }
    catch {
        if ($MachinePhaseOnly) {
            throw "Machine-phase transcript could not be started at protected path '$path'. $($_.Exception.Message)"
        }
        $script:RevAgentLogPath = $path
        Write-Warning "Could not start install transcript: $($_.Exception.Message). Intended log path: $path"
    }
}

function Complete-RevAgentTranscript {
    $logPath = $script:RevAgentLogPath
    if ($script:RevAgentTranscriptStarted) {
        try {
            Stop-Transcript | Out-Null
        }
        catch {}
    }

    if ($null -eq $script:PreviousTranscriptActive) {
        Remove-Item Env:\REVIT_MCP_TRANSCRIPT_ACTIVE -ErrorAction SilentlyContinue
    }
    else {
        $env:REVIT_MCP_TRANSCRIPT_ACTIVE = $script:PreviousTranscriptActive
    }

    if ($null -eq $script:PreviousLogPath) {
        Remove-Item Env:\REVIT_MCP_LOG_PATH -ErrorAction SilentlyContinue
    }
    else {
        $env:REVIT_MCP_LOG_PATH = $script:PreviousLogPath
    }

    if (-not [string]::IsNullOrWhiteSpace($logPath)) {
        try {
            Invoke-RevAgentLogRetention -LogsRoot (Split-Path -Parent $logPath) -KeepLast 10 -ActiveLogPath $logPath
        }
        catch {
        }
    }

    if (-not $MachinePhaseOnly -and $script:RevAgentTranscriptStarted -and $null -ne $script:RevAgentLatestReport -and -not [string]::IsNullOrWhiteSpace($script:RevAgentRemoteReportsRoot)) {
        try {
            Publish-RevAgentMachineRunReport `
                -ReportsRoot $script:RevAgentRemoteReportsRoot `
                -Report $script:RevAgentLatestReport `
                -Operation $script:RevAgentOperation `
                -OperationMethod $script:RevAgentOperationMethod `
                -LogPath $logPath `
                -LocalLogAllowedRoot (Split-Path -Parent $logPath) `
                -KeepLastLogs 2 `
                -WriteCompatibilityReport | Out-Null
        }
        catch {
            Write-Warning "Could not publish remote install report/log: $($_.Exception.Message)"
        }
    }
}

function Copy-RevAgentManagedUpdaterToolFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [bool]$Required = $true
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        return
    }

    try {
        Write-RevAgentAtomicBytes -Path $Destination -Bytes ([System.IO.File]::ReadAllBytes([System.IO.Path]::GetFullPath($Source)))
    }
    catch {
        $message = "Could not atomically refresh updater tool '$Destination'. $($_.Exception.Message)"
        if ($Required) { throw $message }
        Write-Warning $message
    }
}

function Write-RevAgentAtomicBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $directory = Split-Path -Parent $fullPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    Assert-InstallPhasePathNoReparse -Path $directory
    if (Test-Path -LiteralPath $fullPath) {
        $existing = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
        $existingLinkType = if ($existing.PSObject.Properties["LinkType"]) { [string]$existing.LinkType } else { "" }
        if (($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($existingLinkType)) {
            throw "Managed atomic destination is a link/reparse file: $fullPath"
        }
        $linkCount = [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($fullPath)
        if ($linkCount -ne 1) { throw "Managed atomic destination is hard-linked (link count $linkCount): $fullPath" }
    }

    $temporaryPath = Join-Path $directory (".{0}.{1}.tmp" -f [System.IO.Path]::GetFileName($fullPath), [guid]::NewGuid().ToString("N"))
    $stream = $null
    try {
        $stream = [System.IO.File]::Open($temporaryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            [System.IO.File]::Replace($temporaryPath, $fullPath, $null, $true)
        }
        else {
            [System.IO.File]::Move($temporaryPath, $fullPath)
        }
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue }
    }
}

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Value
    )

    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $encoding = New-Object System.Text.UTF8Encoding($false)
    Write-RevAgentAtomicBytes -Path $Path -Bytes $encoding.GetBytes(($Value | ConvertTo-Json -Depth 12))
}

function Read-OptionalJsonFile {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Get-JsonPropertyString {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) {
        return ""
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return ""
    }

    return [string]$property.Value
}

function Resolve-CodexInstructionPolicy {
    param(
        [string]$RequestedPolicy,
        [object]$PreviousConfig
    )

    $policy = $RequestedPolicy
    if ([string]::IsNullOrWhiteSpace($policy)) {
        $policy = Get-JsonPropertyString -Object $PreviousConfig -Name "codexInstructionPolicy"
    }
    if ([string]::IsNullOrWhiteSpace($policy) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_CODEX_INSTRUCTION_POLICY)) {
        $policy = [string]$env:REVIT_MCP_CODEX_INSTRUCTION_POLICY
    }
    if ([string]::IsNullOrWhiteSpace($policy)) {
        $policy = "managed-user-pack"
    }

    $normalized = $policy.Trim().ToLowerInvariant()
    if ($normalized -notin @("managed-user-pack", "preserve-local")) {
        throw "Unsupported CodexInstructionPolicy '$policy'. Use managed-user-pack or preserve-local."
    }

    return $normalized
}

function Resolve-MachineRole {
    param(
        [string]$RequestedRole,
        [object]$PreviousConfig
    )

    $role = $RequestedRole
    if ([string]::IsNullOrWhiteSpace($role)) {
        $role = Get-JsonPropertyString -Object $PreviousConfig -Name "machineRole"
    }
    if ([string]::IsNullOrWhiteSpace($role) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_MACHINE_ROLE)) {
        $role = [string]$env:REVIT_MCP_MACHINE_ROLE
    }

    return $role
}

function Get-EffectiveInstallOperationMethod {
    if (-not [string]::IsNullOrWhiteSpace($OperationMethod)) {
        return $OperationMethod
    }
    if ($RunSourceFreeMigration) {
        return "source-free-migration-bootstrap"
    }
    if ($ForceUpdate) {
        return "install-repair"
    }
    return "install"
}

function Get-EffectiveInstallOperation {
    if ($ForceUpdate) {
        return "reinstall"
    }

    return "install"
}

function Set-RevAgentInstallRunReport {
    param(
        [string]$Status,
        [string]$Message
    )

    $channel = Read-OptionalJsonFile -Path $ChannelManifestPath
    $installedState = Read-OptionalJsonFile -Path (Join-Path $WorkRoot "installed.json")
    $targetVersion = if ($channel -and $channel.version) { [string]$channel.version } else { $null }
    $installedVersion = if ($installedState -and $installedState.version) { [string]$installedState.version } else { $null }
    $channelGit = if ($channel) { $channel.git } else { $null }
    $installedComponents = if ($installedState -and $installedState.components) { $installedState.components } else { $null }
    $installedComponentCount = 0
    if ($installedComponents -and $installedComponents.PSObject) {
        $installedComponentCount = @($installedComponents.PSObject.Properties).Count
    }

    $script:RevAgentLatestReport = [ordered]@{
        schemaVersion = 1
        app = "revAgent"
        operation = $script:RevAgentOperation
        operationMethod = $script:RevAgentOperationMethod
        status = $Status
        message = $Message
        codexInstructionPolicy = $CodexInstructionPolicy
        machineRole = $MachineRole
        computerName = $env:COMPUTERNAME
        userName = $env:USERNAME
        atUtc = (Get-Date).ToUniversalTime().ToString("o")
        channel = if ($channel) { $channel.channel } else { $null }
        previousVersion = $installedVersion
        targetVersion = $targetVersion
        installedVersion = $installedVersion
        release = [ordered]@{
            channel = if ($channel) { $channel.channel } else { $null }
            version = $targetVersion
            packageSha256 = if ($channel) { $channel.sha256 } else { $null }
            packagePath = if ($channel) { $channel.packagePath } else { $null }
            manifestPath = if ($channel) { $channel.manifestPath } else { $null }
            publishedAtUtc = if ($channel) { $channel.publishedAtUtc } else { $null }
            commit = if ($channelGit) { $channelGit.commit } else { $null }
            isDirty = if ($channelGit) { $channelGit.isDirty } else { $null }
        }
        localInstall = if ($installedState) {
            [ordered]@{
                version = $installedState.version
                installedAtUtc = $installedState.installedAtUtc
                packageSha256 = $installedState.packageSha256
                packagePath = $installedState.packagePath
                manifestPath = $installedState.manifestPath
                componentCount = $installedComponentCount
                updatePolicy = if ($installedState.updatePolicy) { $installedState.updatePolicy } else { $null }
            }
        }
        else {
            $null
        }
        diagnostics = [ordered]@{
            isFirstInstall = [string]::IsNullOrWhiteSpace($installedVersion)
            revitRunning = $false
            deferredForRevitClose = $false
            revitPayloadChanged = $null
            fastPackageOnlyUpdate = $false
            runSelfContainedInstaller = $true
            codexInstructionPolicy = $CodexInstructionPolicy
            machineRole = $MachineRole
            codexUserIntegration = $script:RevAgentCodexUserIntegrationPhase
            desktopLauncherCleanup = $script:RevAgentDesktopLauncherCleanup
        }
        paths = [ordered]@{
            installRoot = $InstallRoot
            packageTarget = $PackageTarget
            serverTarget = $ServerTarget
            workRoot = $WorkRoot
            revitInstallRoot = $RevitInstallRoot
            channelManifestPath = $ChannelManifestPath
            logPath = $script:RevAgentLogPath
        }
    }
}

function Invoke-InitialUpdateCheck {
    param(
        [string]$UpdaterPath,
        [string]$UpdaterConfigPath,
        [switch]$ForceUpdate,
        [switch]$SourceFreeMigration,
        [string]$OperationMethod = "initial-update",
        [switch]$MachinePhaseOnly,
        [switch]$UserPhaseOnly,
        [string]$PhaseResultPath = ""
    )

    if ($MachinePhaseOnly) {
        & $UpdaterPath -ConfigPath $UpdaterConfigPath -NoNotifyUser -Force:$ForceUpdate -SourceFreeMigration:$SourceFreeMigration -OperationMethod $OperationMethod -MachinePhaseOnly -HostedMachinePhase -PhaseResultPath $PhaseResultPath
        return
    }
    if ($UserPhaseOnly) {
        & $UpdaterPath -ConfigPath $UpdaterConfigPath -NoNotifyUser -OperationMethod $OperationMethod -UserPhaseOnly -PhaseResultPath $PhaseResultPath
        return
    }

    if ($env:REVIT_MCP_AUDIT_ONLY) {
        & $UpdaterPath -ConfigPath $UpdaterConfigPath -AuditOnly -NoNotifyUser -OperationMethod "initial-audit"
        return
    }

    if ($ForceUpdate -and $SourceFreeMigration) {
        & $UpdaterPath -ConfigPath $UpdaterConfigPath -NoNotifyUser -AllowManualCodexSetup -Force -SourceFreeMigration -OperationMethod $OperationMethod
        return
    }

    if ($ForceUpdate) {
        & $UpdaterPath -ConfigPath $UpdaterConfigPath -NoNotifyUser -AllowManualCodexSetup -Force -OperationMethod $OperationMethod
        return
    }

    if ($SourceFreeMigration) {
        & $UpdaterPath -ConfigPath $UpdaterConfigPath -NoNotifyUser -AllowManualCodexSetup -SourceFreeMigration -OperationMethod $OperationMethod
        return
    }

    & $UpdaterPath -ConfigPath $UpdaterConfigPath -NoNotifyUser -AllowManualCodexSetup -OperationMethod $OperationMethod
}

function Test-CurrentProcessElevated {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function ConvertTo-RevAgentProxyUrl {
    param([string]$Value)

    return RevAgent.Proxy\ConvertTo-RevAgentProxyUrl -Value $Value
}

function ConvertTo-RevAgentWinHttpProxyServer {
    param([string]$Value)

    return RevAgent.Proxy\ConvertTo-RevAgentWinHttpProxyServer -Value $Value
}

function Send-RevAgentEnvironmentChanged {
    try {
        if (-not ("RevAgent.EnvironmentChange" -as [type])) {
            Add-Type -Namespace "RevAgent" -Name "EnvironmentChange" -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(
    System.IntPtr hWnd,
    uint Msg,
    System.UIntPtr wParam,
    string lParam,
    uint fuFlags,
    uint uTimeout,
    out System.UIntPtr lpdwResult);
"@
        }

        $result = [System.UIntPtr]::Zero
        [void][RevAgent.EnvironmentChange]::SendMessageTimeout(
            [System.IntPtr]0xffff,
            0x001A,
            [System.UIntPtr]::Zero,
            "Environment",
            0x0002,
            5000,
            [ref]$result)
    }
    catch {
        Write-Warning "Could not broadcast environment variable changes: $($_.Exception.Message)"
    }
}

function Invoke-RevAgentSetupProcess {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 60
    )

    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    $completed = $process.WaitForExit([Math]::Max(30, $TimeoutSeconds) * 1000)
    if (-not $completed) {
        try {
            $process.Kill()
        }
        catch {}
        return 124
    }

    return $process.ExitCode
}

function Resolve-OptionalCommand {
    param(
        [string[]]$Names,
        [string[]]$Candidates = @()
    )

    foreach ($name in $Names) {
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (Test-Path -LiteralPath $expanded -PathType Leaf) {
            return $expanded
        }
    }

    return ""
}

function Add-ProcessPathEntry {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
        return
    }

    $entries = @($env:Path -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($entry in $entries) {
        if ([string]::Equals($entry.TrimEnd('\'), $Path.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
            return
        }
    }

    $env:Path = $Path + ";" + $env:Path
}

function Refresh-DependencyPath {
    foreach ($path in @(
            (Join-Path $script:RevAgentOsProgramFiles "nodejs"),
            (Join-Path $script:RevAgentOsProgramFilesX86 "nodejs"),
            (Join-Path $script:RevAgentOsAppData "npm"),
            (Join-Path $script:RevAgentOsLocalAppData "OpenAI\Codex\bin")
        )) {
        Add-ProcessPathEntry -Path $path
    }
}

function Set-RevAgentProxyEnvironment {
    param(
        [string]$ProxyUrl,
        [string]$NoProxy = "localhost,127.0.0.1,::1",
        [ValidateSet("Auto", "MachineOnly", "UserOnly")]
        [string]$Scope = "Auto"
    )

    if ([string]::IsNullOrWhiteSpace($ProxyUrl)) {
        return
    }

    if ($Scope -eq "Auto") {
        $Scope = if (Test-CurrentProcessElevated) { "MachineOnly" } else { "UserOnly" }
    }
    $targets = if ($Scope -eq "MachineOnly") { @("Process", "Machine") } else { @("Process", "User") }

    $proxyVariables = @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
    $noProxyVariables = @("NO_PROXY", "no_proxy")
    $changedPersistentEnvironment = $false

    foreach ($target in $targets) {
        $targetEnum = [System.Enum]::Parse([System.EnvironmentVariableTarget], $target)
        $targetAlreadyConfigured = $true
        foreach ($key in $proxyVariables) {
            if (-not [string]::Equals([Environment]::GetEnvironmentVariable($key, $targetEnum), $ProxyUrl, [System.StringComparison]::OrdinalIgnoreCase)) {
                $targetAlreadyConfigured = $false
                break
            }
        }
        if ($targetAlreadyConfigured) {
            foreach ($key in $noProxyVariables) {
                if (-not [string]::Equals([Environment]::GetEnvironmentVariable($key, $targetEnum), $NoProxy, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $targetAlreadyConfigured = $false
                    break
                }
            }
        }
        if ($targetAlreadyConfigured) {
            continue
        }

        foreach ($key in $proxyVariables) {
            try {
                [Environment]::SetEnvironmentVariable($key, $ProxyUrl, $targetEnum)
                if ($target -ne "Process") {
                    $changedPersistentEnvironment = $true
                }
            }
            catch {
                Write-Warning "Could not set $target environment variable ${key}: $($_.Exception.Message)"
            }
        }
        foreach ($key in $noProxyVariables) {
            try {
                [Environment]::SetEnvironmentVariable($key, $NoProxy, $targetEnum)
                if ($target -ne "Process") {
                    $changedPersistentEnvironment = $true
                }
            }
            catch {
                Write-Warning "Could not set $target environment variable ${key}: $($_.Exception.Message)"
            }
        }
    }

    if ($changedPersistentEnvironment) {
        Send-RevAgentEnvironmentChanged
        Write-Host "Proxy env       : updated"
    }
    else {
        Write-Host "Proxy env       : ok"
    }
}

function Set-RevAgentWinInetProxy {
    param(
        [string]$ProxyUrl,
        [string]$ProxyBypass
    )

    if ([string]::IsNullOrWhiteSpace($ProxyUrl)) {
        return
    }

    try {
        $internetSettingsPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
        if (-not (Test-Path -Path $internetSettingsPath)) {
            New-Item -Path $internetSettingsPath -Force | Out-Null
        }
        $current = Get-ItemProperty -Path $internetSettingsPath -ErrorAction SilentlyContinue
        $alreadyConfigured = $current -and
            ([int]$current.ProxyEnable -eq 1) -and
            [string]::Equals([string]$current.ProxyServer, $ProxyUrl, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals([string]$current.ProxyOverride, $ProxyBypass, [System.StringComparison]::OrdinalIgnoreCase)
        if ($alreadyConfigured) {
            Write-Host "WinINET proxy   : ok"
            return
        }

        New-ItemProperty -Path $internetSettingsPath -Name "ProxyEnable" -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $internetSettingsPath -Name "ProxyServer" -Value $ProxyUrl -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $internetSettingsPath -Name "ProxyOverride" -Value $ProxyBypass -PropertyType String -Force | Out-Null
        Write-Host "WinINET proxy   : updated"
    }
    catch {
        Write-Warning "Could not set current-user Windows proxy settings: $($_.Exception.Message)"
    }
}

function Test-RevAgentWinHttpProxyMatches {
    param([string]$ProxyUrl)

    $server = ConvertTo-RevAgentWinHttpProxyServer -Value $ProxyUrl
    if ([string]::IsNullOrWhiteSpace($server)) {
        return $true
    }

    try {
        $netshPath = Join-Path $script:RevAgentOsSystemDirectory "netsh.exe"
        if (-not (Test-Path -LiteralPath $netshPath -PathType Leaf)) {
            throw "Trusted netsh.exe was not found: $netshPath"
        }
        $output = (& $netshPath winhttp show proxy 2>$null | Out-String)
        return ($output -match [regex]::Escape($server))
    }
    catch {
        return $false
    }
}

function Set-RevAgentWinHttpProxy {
    param(
        [string]$ProxyUrl,
        [string]$ProxyBypass
    )

    $server = ConvertTo-RevAgentWinHttpProxyServer -Value $ProxyUrl
    if ([string]::IsNullOrWhiteSpace($server)) {
        return
    }

    if (Test-RevAgentWinHttpProxyMatches -ProxyUrl $ProxyUrl) {
        Write-Host "WinHTTP proxy   : ok"
        return
    }

    if (-not (Test-CurrentProcessElevated)) {
        Write-Warning "WinHTTP proxy needs admin rights. Run the revAgent installer as administrator to set it for winget/Windows services."
        return
    }

    $netshPath = Join-Path $script:RevAgentOsSystemDirectory "netsh.exe"
    try {
        $exitCode = Invoke-RevAgentSetupProcess -FilePath $netshPath -Arguments @("winhttp", "set", "proxy", "proxy-server=$server", "bypass-list=$ProxyBypass") -TimeoutSeconds 60
        if ($exitCode -ne 0) {
            Write-Warning "WinHTTP proxy setup failed with exit code $exitCode."
            return
        }

        Write-Host "WinHTTP proxy   : updated"
    }
    catch {
        Write-Warning "Could not set WinHTTP proxy: $($_.Exception.Message)"
    }
}

function Invoke-RevAgentProxyToolCommand {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($FilePath)) {
        return
    }

    try {
        $exitCode = Invoke-RevAgentSetupProcess -FilePath $FilePath -Arguments $Arguments -TimeoutSeconds 60
        if ($exitCode -ne 0) {
            Write-Warning "$Label failed with exit code $exitCode."
        }
    }
    catch {
        Write-Warning "$Label failed: $($_.Exception.Message)"
    }
}

function Get-RevAgentKeyValueFileValue {
    param(
        [string]$Path,
        [string]$Key
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return ""
    }

    $escapedKey = [regex]::Escape($Key)
    foreach ($line in (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#") -or $trimmed.StartsWith(";")) {
            continue
        }
        if ($trimmed -match "^\s*$escapedKey\s*=\s*(.*?)\s*$") {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }

    return ""
}

function Test-RevAgentNpmProxyConfigured {
    param([string]$ProxyUrl)

    $npmrcPath = Join-Path $script:RevAgentOsUserProfile ".npmrc"
    return (
        [string]::Equals((Get-RevAgentKeyValueFileValue -Path $npmrcPath -Key "proxy"), $ProxyUrl, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals((Get-RevAgentKeyValueFileValue -Path $npmrcPath -Key "https-proxy"), $ProxyUrl, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals((Get-RevAgentKeyValueFileValue -Path $npmrcPath -Key "registry"), "https://registry.npmjs.org/", [System.StringComparison]::OrdinalIgnoreCase)
    )
}

function Set-RevAgentNpmProxy {
    param([string]$ProxyUrl)

    if ([string]::IsNullOrWhiteSpace($ProxyUrl)) {
        return
    }

    if (Test-RevAgentNpmProxyConfigured -ProxyUrl $ProxyUrl) {
        Write-Host "npm proxy       : ok"
        return
    }

    Refresh-DependencyPath
    $npmPath = Resolve-OptionalCommand -Names @("npm.cmd", "npm") -Candidates @(
        (Join-Path $script:RevAgentOsProgramFiles "nodejs\npm.cmd"),
        (Join-Path $script:RevAgentOsProgramFilesX86 "nodejs\npm.cmd")
    )
    if ([string]::IsNullOrWhiteSpace($npmPath)) {
        Write-Host "npm proxy       : skipped (npm not found)"
        return
    }

    foreach ($arguments in @(
            @("config", "set", "proxy", $ProxyUrl),
            @("config", "set", "https-proxy", $ProxyUrl),
            @("config", "set", "registry", "https://registry.npmjs.org/")
        )) {
        Invoke-RevAgentProxyToolCommand -FilePath $npmPath -Arguments $arguments -Label "npm proxy config"
    }
    Write-Host "npm proxy       : updated"

    if (Test-CurrentProcessElevated) {
        foreach ($arguments in @(
                @("config", "set", "proxy", $ProxyUrl, "--global"),
                @("config", "set", "https-proxy", $ProxyUrl, "--global"),
                @("config", "set", "registry", "https://registry.npmjs.org/", "--global")
            )) {
            Invoke-RevAgentProxyToolCommand -FilePath $npmPath -Arguments $arguments -Label "global npm proxy config"
        }
    }
}

function Test-RevAgentGitProxyConfigured {
    param(
        [string]$GitPath,
        [string]$ProxyUrl
    )

    if ([string]::IsNullOrWhiteSpace($GitPath)) {
        return $false
    }

    try {
        $httpProxy = (& $GitPath config --global --get http.proxy 2>$null | Out-String).Trim()
        $httpsProxy = (& $GitPath config --global --get https.proxy 2>$null | Out-String).Trim()
        return (
            [string]::Equals($httpProxy, $ProxyUrl, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals($httpsProxy, $ProxyUrl, [System.StringComparison]::OrdinalIgnoreCase)
        )
    }
    catch {
        return $false
    }
}

function Set-RevAgentGitProxy {
    param([string]$ProxyUrl)

    if ([string]::IsNullOrWhiteSpace($ProxyUrl)) {
        return
    }

    $gitPath = Resolve-OptionalCommand -Names @("git.exe", "git") -Candidates @(
        (Join-Path $script:RevAgentOsProgramFiles "Git\cmd\git.exe"),
        (Join-Path $script:RevAgentOsProgramFilesX86 "Git\cmd\git.exe")
    )
    if ([string]::IsNullOrWhiteSpace($gitPath)) {
        Write-Host "Git proxy       : skipped (git not found)"
        return
    }

    if (Test-RevAgentGitProxyConfigured -GitPath $gitPath -ProxyUrl $ProxyUrl) {
        Write-Host "Git proxy       : ok"
        return
    }

    foreach ($arguments in @(
            @("config", "--global", "http.proxy", $ProxyUrl),
            @("config", "--global", "https.proxy", $ProxyUrl)
        )) {
        Invoke-RevAgentProxyToolCommand -FilePath $gitPath -Arguments $arguments -Label "git proxy config"
    }
    Write-Host "Git proxy       : updated"
}

function Initialize-RevAgentWorkstationProxy {
    param(
        [string]$ProxyUrl,
        [string]$ProxyBypass,
        [switch]$Skip
    )

    if ($Skip) {
        Write-Host "Office proxy setup: skipped."
        return
    }

    $normalizedProxyUrl = ConvertTo-RevAgentProxyUrl -Value $ProxyUrl
    if ([string]::IsNullOrWhiteSpace($normalizedProxyUrl)) {
        return
    }

    if ([string]::IsNullOrWhiteSpace($ProxyBypass)) {
        $ProxyBypass = "<local>"
    }

    Write-Host "Office proxy    : $normalizedProxyUrl"
    if (Test-CurrentProcessElevated) {
        # The elevated bootstrap is machine-scoped. It must not touch the
        # credential provider's HKCU/profile or execute npm/git from a
        # user-writable PATH. User proxy integration is performed later by the
        # original unelevated GUI process.
        Set-RevAgentProxyEnvironment -ProxyUrl $normalizedProxyUrl -Scope MachineOnly
        Set-RevAgentWinHttpProxy -ProxyUrl $normalizedProxyUrl -ProxyBypass $ProxyBypass
        Write-Host "User proxy setup: deferred to unelevated phase."
        return
    }

    Set-RevAgentProxyEnvironment -ProxyUrl $normalizedProxyUrl -Scope UserOnly
    Set-RevAgentWinInetProxy -ProxyUrl $normalizedProxyUrl -ProxyBypass $ProxyBypass
    Set-RevAgentNpmProxy -ProxyUrl $normalizedProxyUrl
    Set-RevAgentGitProxy -ProxyUrl $normalizedProxyUrl
}

function Test-InstallPhasePathUnderRoot {
    param([string]$Path, [string]$Root)
    if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
        $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
        return [string]::Equals($fullPath, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
            $fullPath.StartsWith($fullRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Assert-InstallPhasePathNoReparse {
    param([Parameter(Mandatory = $true)][string]$Path)
    $cursor = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $cursor)) { $cursor = Split-Path -Parent $cursor }
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Install phase output path contains a reparse point: $($item.FullName)"
            }
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or [string]::Equals($parent, $cursor, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = $parent
    }
}

function Assert-InstallPhaseOutputPaths {
    if (-not $MachinePhaseOnly -and -not $UserPhaseOnly) { return }
    $expectedLogRoot = Join-Path $WorkRoot $(if ($MachinePhaseOnly) { "machine-logs" } else { "logs" })
    $expectedStateRoot = Join-Path $WorkRoot $(if ($MachinePhaseOnly) { "machine-state" } else { "user-state" })
    foreach ($entry in @(
            [pscustomobject]@{ Name = "LogPath"; Path = $LogPath; Root = $expectedLogRoot },
            [pscustomobject]@{ Name = "PhaseResultPath"; Path = $PhaseResultPath; Root = $expectedStateRoot }
        )) {
        if ([string]::IsNullOrWhiteSpace([string]$entry.Path) -or
            -not (Test-InstallPhasePathUnderRoot -Path ([string]$entry.Path) -Root ([string]$entry.Root))) {
            throw "$($entry.Name) must remain under '$($entry.Root)': $($entry.Path)"
        }
        Assert-InstallPhasePathNoReparse -Path ([string]$entry.Path)
        if (Test-Path -LiteralPath ([string]$entry.Path)) {
            $linkCount = -1
            try {
                if (Test-Path -LiteralPath ([string]$entry.Path) -PathType Leaf) {
                    $linkCount = [System.IO.File]::GetLinkCount([string]$entry.Path)
                }
            }
            catch {}
            throw "Refusing pre-existing install phase output (including hardlink targets): $($entry.Path) linkCount=$linkCount"
        }
    }

    $localStateRoot = Join-Path $WorkRoot $(if ($MachinePhaseOnly) { "machine-state" } else { "user-state" })
    if (-not (Test-Path -LiteralPath $localStateRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $localStateRoot -Force | Out-Null
    }
    Assert-InstallPhasePathNoReparse -Path $localStateRoot
    $localReportPath = Join-Path $localStateRoot "last-install-report.json"
    Write-RevAgentJsonFile -Path $localReportPath -Value $script:RevAgentLatestReport -GuardRoot $localStateRoot
}

function Publish-RevAgentPendingMachineInstallReport {
    param(
        [Parameter(Mandatory = $true)][string]$ReportPath,
        [Parameter(Mandatory = $true)][string]$ReportAllowedRoot,
        [Parameter(Mandatory = $true)][string]$LogAllowedRoot,
        [Parameter(Mandatory = $true)][string]$RemoteReportsRoot,
        [Parameter(Mandatory = $true)][string]$IntegrationStatus,
        [Parameter(Mandatory = $true)][string]$IntegrationMessage,
        [object]$IntegrationDetails = $null
    )

    if ([string]::IsNullOrWhiteSpace($RemoteReportsRoot)) {
        throw "The user phase cannot publish the machine install report because ReportsRoot is empty."
    }
    if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) {
        throw "The machine phase did not leave its local install report: $ReportPath"
    }

    $pendingReport = Read-RevAgentJsonReportFile -Path $ReportPath -AllowedRoot $ReportAllowedRoot
    $diagnostics = [ordered]@{}
    $existingDiagnosticsProperty = $pendingReport.PSObject.Properties["diagnostics"]
    if ($existingDiagnosticsProperty -and $existingDiagnosticsProperty.Value) {
        foreach ($property in $existingDiagnosticsProperty.Value.PSObject.Properties) {
            $diagnostics[$property.Name] = $property.Value
        }
    }
    $integrationSucceeded = [string]::Equals($IntegrationStatus, "completed", [System.StringComparison]::OrdinalIgnoreCase)
    $diagnostics["codexUserIntegration"] = [ordered]@{
        success = $integrationSucceeded
        status = $IntegrationStatus
        message = $IntegrationMessage
        details = $IntegrationDetails
        completedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    $pendingReport | Add-Member -NotePropertyName diagnostics -NotePropertyValue $diagnostics -Force
    if (-not $integrationSucceeded) { $pendingReport | Add-Member -NotePropertyName status -NotePropertyValue "failed" -Force }
    $machineMessage = Get-JsonPropertyString -Object $pendingReport -Name "message"
    $combinedMessage = if ([string]::IsNullOrWhiteSpace($machineMessage)) { $IntegrationMessage } else { "$machineMessage User integration: $IntegrationMessage" }
    $pendingReport | Add-Member -NotePropertyName message -NotePropertyValue $combinedMessage -Force

    $pendingOperation = Get-JsonPropertyString -Object $pendingReport -Name "operation"
    if ([string]::IsNullOrWhiteSpace($pendingOperation)) { $pendingOperation = "install" }
    $pendingMethod = Get-JsonPropertyString -Object $pendingReport -Name "operationMethod"
    $pendingPathsProperty = $pendingReport.PSObject.Properties["paths"]
    $pendingLogPath = if ($pendingPathsProperty -and $pendingPathsProperty.Value) {
        Get-JsonPropertyString -Object $pendingPathsProperty.Value -Name "logPath"
    }
    else { "" }
    $publishArgs = @{
        ReportsRoot = $RemoteReportsRoot
        Report = $pendingReport
        Operation = $pendingOperation
        OperationMethod = $pendingMethod
        KeepLastLogs = 2
        WriteCompatibilityReport = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($pendingLogPath)) {
        $publishArgs["LogPath"] = $pendingLogPath
        $publishArgs["LocalLogAllowedRoot"] = $LogAllowedRoot
    }
    $published = Publish-RevAgentMachineRunReport @publishArgs
    Write-Host "Machine report  : final user-phase outcome published unelevated." -ForegroundColor Green
    return $published
}

function Write-RevAgentInstallUserPhaseResult {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][string]$Message,
        [object]$Details = $null
    )

    if (-not $UserPhaseOnly -or [string]::IsNullOrWhiteSpace($PhaseResultPath)) { return }
    $userStateRoot = Join-Path $WorkRoot "user-state"
    if (-not (Test-InstallPhasePathUnderRoot -Path $PhaseResultPath -Root $userStateRoot)) {
        throw "User-phase result must remain under '$userStateRoot': $PhaseResultPath"
    }
    Assert-InstallPhasePathNoReparse -Path $PhaseResultPath
    Write-RevAgentJsonFile -Path $PhaseResultPath -GuardRoot $userStateRoot -Value ([ordered]@{
            schemaVersion = 1
            app = "revAgent"
            phase = "user"
            status = $Status
            continueUserPhase = $false
            message = $Message
            details = $Details
            atUtc = (Get-Date).ToUniversalTime().ToString("o")
        })
}

function Ensure-CodexWorkspaceRoot {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }

    $fullPath = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path)).TrimEnd("\")
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
        Write-Host "Codex workspace : created $fullPath"
        return
    }

    Write-Host "Codex workspace : $fullPath"
}

function ConvertTo-VbsStringLiteral {
    param([string]$Value)

    return [string]::Concat('"', $Value.Replace('"', '""'), '"')
}

function Join-WindowsCommandArguments {
    param([string[]]$Arguments)

    $parts = [System.Collections.Generic.List[string]]::new()
    foreach ($argument in $Arguments) {
        $value = [string]$argument
        if ($value -match '[\s"]') {
            $parts.Add('"' + ($value -replace '"', '\"') + '"')
        }
        else {
            $parts.Add($value)
        }
    }

    return ($parts.ToArray() -join " ")
}

function Resolve-WindowsPowerShellPath {
    return Resolve-RevAgentWindowsPowerShellPath
}

function Resolve-WScriptPath {
    return Resolve-RevAgentWScriptPath
}

function Repair-RevAgentUpdaterPermissions {
    param([string]$Principal = "")

    $targets = Get-RevAgentManagedPermissionTargets `
        -InstallRoot $InstallRoot `
        -WorkRoot $WorkRoot `
        -PackageTarget $PackageTarget `
        -ServerTarget $ServerTarget `
        -RevitVersion $RevitVersion
    Invoke-RevAgentManagedPermissionRepair -Targets $targets -Principal $Principal
}

function Write-HiddenPowerShellLauncher {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LauncherPath,
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [string[]]$ScriptArguments = @(),
        [switch]$WaitForExit
    )

    Write-RevAgentHiddenPowerShellLauncher `
        -LauncherPath $LauncherPath `
        -ScriptPath $ScriptPath `
        -ScriptArguments $ScriptArguments `
        -WaitForExit:$WaitForExit
}

function Get-HiddenUpdaterLauncherPath {
    param([string]$UpdaterConfigPath)

    return Get-RevAgentHiddenUpdaterLauncherPath -ConfigPath $UpdaterConfigPath
}

function New-HiddenUpdaterScheduledTaskAction {
    param([string]$LauncherPath)

    return New-RevAgentHiddenUpdaterScheduledTaskAction -LauncherPath $LauncherPath
}

function Write-UpdaterCommandFiles {
    param(
        [string]$UpdaterPath,
        [string]$UpdaterConfigPath,
        [string]$UpdaterWorkRoot,
        [string]$VersionToolPath = "",
        [string]$DailyAt = "12:00",
        [int]$CheckIntervalMinutes = 30,
        [switch]$InstallStartupFallback
    )

    $manualCommandPath = Join-Path $UpdaterWorkRoot "Update-revAgent-Now.cmd"
    $manualCommandLines = @(
        "@echo off",
        "%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$UpdaterPath`" -ConfigPath `"$UpdaterConfigPath`" -AuditOnly -NotifyUser -OperationMethod manual-update-audit",
        "echo Machine updates require the unelevated revAgent Updater GUI and its scoped UAC machine phase.",
        "pause"
    )
    $manualCommandLines | Set-Content -LiteralPath $manualCommandPath -Encoding ASCII

    if (-not [string]::IsNullOrWhiteSpace($VersionToolPath)) {
        $versionCommandPath = Join-Path $UpdaterWorkRoot "Show-revAgent-Version.cmd"
        $versionCommandLines = @(
            "@echo off",
            "%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$VersionToolPath`" -ConfigPath `"$UpdaterConfigPath`"",
            "pause"
        )
        $versionCommandLines | Set-Content -LiteralPath $versionCommandPath -Encoding ASCII
    }

    foreach ($legacyCommandName in @("Update-Revit-MCP-Now.cmd", "Show-Revit-MCP-Version.cmd")) {
        $legacyCommandPath = Join-Path $UpdaterWorkRoot $legacyCommandName
        if (Test-Path -LiteralPath $legacyCommandPath -PathType Leaf) {
            Remove-Item -LiteralPath $legacyCommandPath -Force
            Write-Host "Removed legacy updater helper: $legacyCommandPath"
        }
    }
    foreach ($legacyLauncherPath in @(Get-RevAgentLegacyHiddenUpdaterLauncherPaths -ConfigPath $UpdaterConfigPath)) {
        if (Test-Path -LiteralPath $legacyLauncherPath -PathType Leaf) {
            Remove-Item -LiteralPath $legacyLauncherPath -Force
            Write-Host "Removed legacy hidden updater launcher: $legacyLauncherPath"
        }
    }

    if ($InstallStartupFallback) {
        $startupRoot = [Environment]::GetFolderPath("Startup")
        if ([string]::IsNullOrWhiteSpace($startupRoot)) {
            throw "Could not resolve the current user's Startup folder."
        }

        New-Item -ItemType Directory -Path $startupRoot -Force | Out-Null
        $loopScriptPath = Join-Path $UpdaterWorkRoot "auto-update-loop.ps1"
        $loopScriptLines = @(
            "param(",
            "    [Parameter(Mandatory = `$true)]",
            "    [string]`$UpdaterPath,",
            "    [Parameter(Mandatory = `$true)]",
            "    [string]`$ConfigPath,",
            "    [string]`$DailyAt = `"$DailyAt`"",
            ")",
            "",
            "`$ErrorActionPreference = `"Continue`"",
            "function Get-NextRunTime {",
            "    param([string]`$RunAt)",
            "    try {",
            "        `$time = [datetime]::Parse(`$RunAt)",
            "    }",
            "    catch {",
            "        `$time = [datetime]::Parse(`"12:00`")",
            "    }",
            "    `$now = Get-Date",
            "    `$next = Get-Date -Year `$now.Year -Month `$now.Month -Day `$now.Day -Hour `$time.Hour -Minute `$time.Minute -Second 0",
            "    if (`$next -le `$now) { `$next = `$next.AddDays(1) }",
            "    return `$next",
            "}",
            "while (`$true) {",
            "    `$nextRun = Get-NextRunTime -RunAt `$DailyAt",
            "    `$sleepSeconds = [Math]::Max(60, [int][Math]::Ceiling((`$nextRun - (Get-Date)).TotalSeconds))",
            "    Start-Sleep -Seconds `$sleepSeconds",
            "    try {",
            "        & `$UpdaterPath -ConfigPath `$ConfigPath -AuditOnly -NotifyUser -OperationMethod startup-fallback-audit",
            "    }",
            "    catch {",
            "    }",
            "}"
        )
        $loopScriptLines | Set-Content -LiteralPath $loopScriptPath -Encoding ASCII

        foreach ($legacyStartupName in @("Revit MCP Auto Update.cmd", "Revit MCP Auto Update.vbs")) {
            $legacyStartupPath = Join-Path $startupRoot $legacyStartupName
            if (Test-Path -LiteralPath $legacyStartupPath -PathType Leaf) {
                Remove-Item -LiteralPath $legacyStartupPath -Force
            }
        }

        $startupCommandPath = Join-Path $startupRoot "revAgent Auto Update.vbs"
        Write-HiddenPowerShellLauncher `
            -LauncherPath $startupCommandPath `
            -ScriptPath $loopScriptPath `
            -ScriptArguments @("-UpdaterPath", $UpdaterPath, "-ConfigPath", $UpdaterConfigPath, "-DailyAt", [string]$DailyAt)
        Write-Host "Startup fallback: $startupCommandPath" -ForegroundColor Yellow
        Write-Host "Startup fallback schedule: daily at $DailyAt" -ForegroundColor Yellow
    }

    return $manualCommandPath
}

function Register-RevAgentInteractiveUpdateTask {
    param(
        [string]$UpdaterPath,
        [string]$UpdaterConfigPath,
        [string]$VersionToolPath,
        [string]$UpdaterWorkRoot,
        [string]$Name,
        [string]$RunAt,
        [int]$IntervalMinutes
    )

    $hiddenLauncherPath = Get-HiddenUpdaterLauncherPath -UpdaterConfigPath $UpdaterConfigPath
    Write-HiddenPowerShellLauncher -LauncherPath $hiddenLauncherPath -ScriptPath $UpdaterPath -ScriptArguments @("-ConfigPath", $UpdaterConfigPath, "-AuditOnly", "-NotifyUser", "-OperationMethod", "scheduled-update-audit") -WaitForExit
    $action = New-HiddenUpdaterScheduledTaskAction -LauncherPath $hiddenLauncherPath
    $dailyTrigger = New-RevAgentDailyUpdateTrigger -DailyAt $RunAt
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

    try {
        Register-ScheduledTask -TaskName $Name -Action $action -Trigger @($dailyTrigger) -Settings $settings -Principal $principal -Description "Checks the revAgent release target daily at $RunAt. Revit-loaded payload updates are deferred while Revit is open." -Force | Out-Null
        Write-Host "Task registered : $Name" -ForegroundColor Green
        Write-Host "Task schedule   : daily at $RunAt" -ForegroundColor Green
        foreach ($legacyTaskName in @("Revit MCP Auto Update")) {
            if ([string]::Equals($legacyTaskName, $Name, [System.StringComparison]::OrdinalIgnoreCase)) {
                continue
            }
            $legacyTask = Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
            if ($legacyTask) {
                try {
                    Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false -ErrorAction Stop | Out-Null
                    Write-Host "Removed legacy task: $legacyTaskName" -ForegroundColor Yellow
                }
                catch {
                    Write-Warning "Could not remove legacy updater scheduled task '$legacyTaskName': $($_.Exception.Message)"
                }
            }
        }
    }
    catch {
        Write-Warning "Scheduled task could not be registered: $($_.Exception.Message)"
        Write-UpdaterCommandFiles -UpdaterPath $UpdaterPath -UpdaterConfigPath $UpdaterConfigPath -UpdaterWorkRoot $UpdaterWorkRoot -VersionToolPath $VersionToolPath -DailyAt $RunAt -CheckIntervalMinutes $IntervalMinutes -InstallStartupFallback | Out-Null
    }
}

function Resolve-RevitInstallRoot {
    param(
        [string]$RequestedRoot,
        [string]$Version
    )

    return Resolve-RevAgentInstallRoot -RequestedRoot $RequestedRoot -Version $Version
}

$revAgentCanonicalNasRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
$revAgentLegacyNasRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"

function Test-RevAgentNasPathUnder {
    param([string]$ChildPath, [string]$ParentPath)

    if ([string]::IsNullOrWhiteSpace($ChildPath) -or [string]::IsNullOrWhiteSpace($ParentPath)) {
        return $false
    }

    try {
        $child = [System.IO.Path]::GetFullPath($ChildPath).TrimEnd("\")
        $parent = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd("\")
        return [string]::Equals($child, $parent, [System.StringComparison]::OrdinalIgnoreCase) -or
            $child.StartsWith($parent + "\", [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch {
        return $false
    }
}

function Resolve-RevAgentCanonicalNasTransitionPath {
    param([string]$Path)

    if (-not (Test-RevAgentNasPathUnder -ChildPath $Path -ParentPath $revAgentLegacyNasRoot)) {
        return $Path
    }

    $legacyPrefix = [System.IO.Path]::GetFullPath($revAgentLegacyNasRoot).TrimEnd("\") + "\"
    $relativePath = [System.IO.Path]::GetFullPath($Path).Substring($legacyPrefix.Length)
    $candidatePath = Join-Path $revAgentCanonicalNasRoot $relativePath
    if (Test-Path -LiteralPath $candidatePath) {
        return $candidatePath
    }

    return $Path
}

$programDataRoot = $script:RevAgentOsCommonAppData
$legacyInstallRoot = Join-Path $programDataRoot "DPE\RevitMCP"
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $programDataRoot "DPE\revAgent"
}
if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
    $WorkRoot = Join-Path $InstallRoot "updater"
}
if ([string]::IsNullOrWhiteSpace($PackageTarget)) {
    $PackageTarget = Join-Path $InstallRoot "package"
}
if ([string]::IsNullOrWhiteSpace($ServerTarget)) {
    $ServerTarget = Join-Path $InstallRoot "runtime"
}
if ([string]::IsNullOrWhiteSpace($PhaseResultPath)) {
    $phaseStateRoot = if ($MachinePhaseOnly) { "machine-state" } else { "user-state" }
    $PhaseResultPath = Join-Path $WorkRoot (Join-Path $phaseStateRoot ("install-phase-result-{0}.json" -f [guid]::NewGuid().ToString("N")))
}
if ($MachinePhaseOnly) {
    $canonicalInstallRoot = [System.IO.Path]::GetFullPath((Join-Path $script:RevAgentOsCommonAppData 'DPE\revAgent')).TrimEnd('\')
    $canonicalMachinePaths = @(
        [pscustomobject]@{ Name = 'InstallRoot'; Actual = $InstallRoot; Expected = $canonicalInstallRoot },
        [pscustomobject]@{ Name = 'WorkRoot'; Actual = $WorkRoot; Expected = (Join-Path $canonicalInstallRoot 'updater') },
        [pscustomobject]@{ Name = 'PackageTarget'; Actual = $PackageTarget; Expected = (Join-Path $canonicalInstallRoot 'package') },
        [pscustomobject]@{ Name = 'ServerTarget'; Actual = $ServerTarget; Expected = (Join-Path $canonicalInstallRoot 'runtime') },
        [pscustomobject]@{ Name = 'RevitInstallRoot'; Actual = (Resolve-RevitInstallRoot -RequestedRoot $RevitInstallRoot -Version $RevitVersion); Expected = (Join-Path $script:RevAgentOsProgramFiles ("Autodesk\Revit {0}" -f $RevitVersion)) }
    )
    foreach ($entry in $canonicalMachinePaths) {
        if (-not [string]::Equals([System.IO.Path]::GetFullPath([string]$entry.Actual).TrimEnd('\'), [System.IO.Path]::GetFullPath([string]$entry.Expected).TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Machine-only $($entry.Name) must equal the canonical managed path '$($entry.Expected)'; refusing '$($entry.Actual)'."
        }
    }
    $LegacyServerTargets = @()
}
if ([string]::IsNullOrWhiteSpace($LogPath) -and ($MachinePhaseOnly -or $UserPhaseOnly)) {
    $phaseLogRoot = if ($MachinePhaseOnly) { "machine-logs" } else { "logs" }
    $LogPath = Join-Path $WorkRoot (Join-Path $phaseLogRoot ("install-{0}-{1}.log" -f $(if ($MachinePhaseOnly) { "machine" } else { "user" }), [guid]::NewGuid().ToString("N")))
}

if ($MachinePhaseOnly -and $UserPhaseOnly) {
    throw "-MachinePhaseOnly and -UserPhaseOnly are mutually exclusive."
}
$currentProcessElevated = Test-CurrentProcessElevated
if ($MachinePhaseOnly -and -not $currentProcessElevated) {
    throw "-MachinePhaseOnly requires an elevated process."
}
if ($UserPhaseOnly -and $currentProcessElevated) {
    throw "-UserPhaseOnly must run in the original unelevated interactive-user process."
}
if ($currentProcessElevated -and -not $MachinePhaseOnly) {
    throw "Elevated updater bootstrap is restricted to -MachinePhaseOnly. Start the GUI normally so it can resume user integration without elevation."
}
if ($MachinePhaseOnly -and (
        [string]::IsNullOrWhiteSpace($TargetInteractiveUser) -or
        [string]::IsNullOrWhiteSpace($TargetInteractiveUserSid) -or
        [string]::IsNullOrWhiteSpace($TargetUserProfileRoot))) {
    throw "-MachinePhaseOnly requires the original -TargetInteractiveUser, -TargetInteractiveUserSid, and -TargetUserProfileRoot captured before UAC elevation."
}
if ($MachinePhaseOnly) {
    $interactiveBinding = Resolve-RevAgentInteractiveUserBinding `
        -TargetInteractiveUser $TargetInteractiveUser `
        -TargetInteractiveUserSid $TargetInteractiveUserSid `
        -TargetUserProfileRoot $TargetUserProfileRoot
    $TargetInteractiveUser = [string]$interactiveBinding.UserName
    $TargetInteractiveUserSid = [string]$interactiveBinding.Sid
    $TargetUserProfileRoot = [string]$interactiveBinding.ProfileRoot
}
Assert-InstallPhaseOutputPaths
$phaseResultFullPath = [System.IO.Path]::GetFullPath($PhaseResultPath)
$workRootFullPath = [System.IO.Path]::GetFullPath($WorkRoot).TrimEnd("\")
if (-not ($phaseResultFullPath.StartsWith($workRootFullPath + "\", [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "Phase result path must stay under the managed updater work root: $phaseResultFullPath"
}
if ($UserPhaseOnly) {
    $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ((-not [string]::IsNullOrWhiteSpace($TargetInteractiveUserSid)) -and
        (-not [string]::Equals($currentIdentity.User.Value, $TargetInteractiveUserSid, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "User phase identity mismatch. Expected SID $TargetInteractiveUserSid but current SID is $($currentIdentity.User.Value)."
    }
    if ((-not [string]::IsNullOrWhiteSpace($TargetInteractiveUser)) -and
        (-not [string]::Equals($currentIdentity.Name, $TargetInteractiveUser, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "User phase identity mismatch. Expected $TargetInteractiveUser but current identity is $($currentIdentity.Name)."
    }
}

$targetPermissionPrincipal = if (-not [string]::IsNullOrWhiteSpace($TargetInteractiveUserSid)) { "*$TargetInteractiveUserSid" } else { $TargetInteractiveUser }
$script:RevAgentMachineTreeProtected = $false
$reportPublishEvidence = $null
$reportPublishError = ""
try {
if ($MachinePhaseOnly) {
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    [void](Protect-RevAgentManagedExecutionTree -InstallRoot $InstallRoot -InteractivePrincipal $targetPermissionPrincipal)
    $script:RevAgentMachineTreeProtected = $true
    Assert-InstallPhaseOutputPaths
}

$script:RevAgentOperationMethod = Get-EffectiveInstallOperationMethod
$script:RevAgentOperation = Get-EffectiveInstallOperation
Initialize-RevAgentTranscript -PreferredWorkRoot $WorkRoot -RequestedLogPath $LogPath -Prefix "install"
Write-Host "Operation method : $script:RevAgentOperationMethod"
$originalChannelManifestPath = $ChannelManifestPath
$ChannelManifestPath = Resolve-RevAgentCanonicalNasTransitionPath -Path $ChannelManifestPath
$channelMovedToCanonicalNasRoot = -not [string]::Equals($originalChannelManifestPath, $ChannelManifestPath, [System.StringComparison]::OrdinalIgnoreCase)
if ($channelMovedToCanonicalNasRoot) {
    Write-Host "Canonical NAS release root detected; updater config will use: $ChannelManifestPath" -ForegroundColor Green
}
if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
    $channelDir = Split-Path -Parent $ChannelManifestPath
    $releaseRootGuess = Split-Path -Parent $channelDir
    $ReportsRoot = Join-Path $releaseRootGuess "reports"
}
elseif ($channelMovedToCanonicalNasRoot -and (Test-RevAgentNasPathUnder -ChildPath $ReportsRoot -ParentPath $revAgentLegacyNasRoot)) {
    $channelDir = Split-Path -Parent $ChannelManifestPath
    $releaseRootGuess = Split-Path -Parent $channelDir
    $ReportsRoot = Join-Path $releaseRootGuess "reports"
}
if ($MachinePhaseOnly) {
    $ReportsRoot = ""
    Write-Host "Machine reports : local ProgramData handoff only; NAS publication is deferred to the unelevated user phase." -ForegroundColor Green
}
$script:RevAgentRemoteReportsRoot = $ReportsRoot

$ProxyUrl = ConvertTo-RevAgentProxyUrl -Value $ProxyUrl

if ($UserPhaseOnly) {
    $configPath = Join-Path $WorkRoot "updater-config.json"
    $config = Read-OptionalJsonFile -Path $configPath
    if (-not $config) {
        throw "Machine phase did not leave a readable updater config for the user phase: $configPath"
    }
    foreach ($mapping in @(
            @{ Property = "proxyUrl"; Variable = "ProxyUrl" },
            @{ Property = "proxyBypass"; Variable = "ProxyBypass" },
            @{ Property = "codexWorkspaceRoot"; Variable = "CodexWorkspaceRoot" },
            @{ Property = "dailyAt"; Variable = "DailyAt" },
            @{ Property = "taskName"; Variable = "TaskName" }
        )) {
        $value = Get-JsonPropertyString -Object $config -Name $mapping.Property
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            Set-Variable -Name $mapping.Variable -Value $value
        }
    }
    $CodexInstructionPolicy = Resolve-CodexInstructionPolicy -RequestedPolicy $CodexInstructionPolicy -PreviousConfig $config
    $MachineRole = Resolve-MachineRole -RequestedRole $MachineRole -PreviousConfig $config
    Initialize-RevAgentWorkstationProxy -ProxyUrl $ProxyUrl -ProxyBypass $ProxyBypass -Skip:$SkipProxySetup
    Ensure-CodexWorkspaceRoot -Path $CodexWorkspaceRoot

    $localUpdater = Join-Path $WorkRoot "update-from-nas.ps1"
    $localVersionTool = Join-Path $WorkRoot "show-installed-version.ps1"
    if (-not (Test-Path -LiteralPath $localUpdater -PathType Leaf)) {
        throw "Machine phase did not install the local updater: $localUpdater"
    }
    $manualCommandPath = Write-UpdaterCommandFiles -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -UpdaterWorkRoot $WorkRoot -VersionToolPath $localVersionTool -DailyAt $DailyAt -CheckIntervalMinutes $CheckIntervalMinutes
    Invoke-InitialUpdateCheck -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -OperationMethod ("{0}-user-integration" -f $script:RevAgentOperationMethod) -UserPhaseOnly -PhaseResultPath $phaseResultFullPath
    $script:RevAgentCodexUserIntegrationPhase = Read-RevAgentJsonReportFile -Path $phaseResultFullPath -AllowedRoot (Join-Path $WorkRoot "user-state")
    $nestedPhase = Get-JsonPropertyString -Object $script:RevAgentCodexUserIntegrationPhase -Name "phase"
    $nestedStatus = Get-JsonPropertyString -Object $script:RevAgentCodexUserIntegrationPhase -Name "status"
    $nestedSuccessProperty = $script:RevAgentCodexUserIntegrationPhase.PSObject.Properties["success"]
    $nestedContinueProperty = $script:RevAgentCodexUserIntegrationPhase.PSObject.Properties["continueUserPhase"]
    if (-not [string]::Equals($nestedPhase, "user", [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($nestedStatus, "completed", [System.StringComparison]::OrdinalIgnoreCase) -or
        $null -eq $nestedSuccessProperty -or -not [bool]$nestedSuccessProperty.Value -or
        $null -eq $nestedContinueProperty -or [bool]$nestedContinueProperty.Value) {
        throw "Nested updater user integration did not leave a completed terminal attestation. phase=$nestedPhase status=$nestedStatus"
    }

    if (-not $NoScheduledTask) {
        Register-RevAgentInteractiveUpdateTask -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -VersionToolPath $localVersionTool -UpdaterWorkRoot $WorkRoot -Name $TaskName -RunAt $DailyAt -IntervalMinutes $CheckIntervalMinutes
    }
    try {
        $script:RevAgentDesktopLauncherCleanup = Invoke-RevAgentLegacyDesktopLauncherCleanup
    }
    catch {
        Write-Warning "Desktop launcher cleanup failed in user phase: $($_.Exception.Message)"
    }
    Write-Host "User integration : completed as $($currentIdentity.Name)" -ForegroundColor Green
    Write-Host "Run manually     : $manualCommandPath" -ForegroundColor Green
    Set-RevAgentInstallRunReport -Status "completed" -Message ("Unelevated user integration completed by {0}." -f $script:RevAgentOperationMethod)
    $publishedReport = Publish-RevAgentPendingMachineInstallReport `
        -ReportPath (Join-Path $WorkRoot "machine-state\last-install-report.json") `
        -ReportAllowedRoot (Join-Path $WorkRoot "machine-state") `
        -LogAllowedRoot (Join-Path $WorkRoot "machine-logs") `
        -RemoteReportsRoot $ReportsRoot `
        -IntegrationStatus "completed" `
        -IntegrationMessage "Unelevated updater and Codex user integration completed." `
        -IntegrationDetails ([ordered]@{
            updaterUserPhase = $script:RevAgentCodexUserIntegrationPhase
            desktopLauncherCleanup = $script:RevAgentDesktopLauncherCleanup
        })
    $reportPublishEvidence = [ordered]@{
        latestPath = [string]$publishedReport.LatestPath
        operationLatestPath = [string]$publishedReport.OperationLatestPath
        compatibilityPath = [string]$publishedReport.CompatibilityPath
        logPath = [string]$publishedReport.LogPath
    }
    Write-RevAgentInstallUserPhaseResult -Status "completed" -Message "Unelevated updater integration completed and the machine install report was published." -Details ([ordered]@{
            reportPublished = $true
            reportEvidence = $reportPublishEvidence
            codexUserIntegration = $script:RevAgentCodexUserIntegrationPhase
        })
    return
}

Initialize-RevAgentWorkstationProxy -ProxyUrl $ProxyUrl -ProxyBypass $ProxyBypass -Skip:$SkipProxySetup
if (-not $MachinePhaseOnly) {
    Ensure-CodexWorkspaceRoot -Path $CodexWorkspaceRoot
}

$RevitInstallRoot = Resolve-RevitInstallRoot -RequestedRoot $RevitInstallRoot -Version $RevitVersion

New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
Repair-RevAgentUpdaterPermissions

$localUpdater = Join-Path $WorkRoot "update-from-nas.ps1"
$localVersionTool = Join-Path $WorkRoot "show-installed-version.ps1"
$localMigrationTool = Join-Path $WorkRoot "migrate-source-free-install.ps1"
$localCodexUserIntegrationTool = Join-Path $WorkRoot "Invoke-revAgent-CodexUserIntegration.ps1"
$configPath = Join-Path $WorkRoot "updater-config.json"
$previousConfig = Read-OptionalJsonFile -Path $configPath
if (-not $previousConfig) {
    $previousConfig = Read-OptionalJsonFile -Path (Join-Path $legacyInstallRoot "updater\updater-config.json")
}
$CodexInstructionPolicy = Resolve-CodexInstructionPolicy -RequestedPolicy $CodexInstructionPolicy -PreviousConfig $previousConfig
$MachineRole = Resolve-MachineRole -RequestedRole $MachineRole -PreviousConfig $previousConfig
$localLibRoot = Join-Path $WorkRoot "lib"
$localTrustedReleaseKeysPath = Join-Path $WorkRoot "config\release-trusted-keys.json"
$trustedReleaseKeysSource = if ($MachinePhaseOnly) { [string]$script:InstallVerifiedTrustedKeysPath } else { Join-Path $PSScriptRoot "config\release-trusted-keys.json" }
if ([string]::IsNullOrWhiteSpace($trustedReleaseKeysSource) -or -not (Test-Path -LiteralPath $trustedReleaseKeysSource -PathType Leaf)) {
    throw "Canonical release tools key is unavailable; refusing updater repair. Expected source: $trustedReleaseKeysSource"
}
if ($MachinePhaseOnly) {
    $expectedTrustedKeySource = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "config\release-trusted-keys.json"))
    if (-not [string]::Equals([System.IO.Path]::GetFullPath($trustedReleaseKeysSource), $expectedTrustedKeySource, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Elevated updater repair key source must be the verified canonical release tools key: $expectedTrustedKeySource"
    }
    $currentTrustedKeySourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $trustedReleaseKeysSource).Hash
    if (-not [string]::Equals($currentTrustedKeySourceHash, [string]$script:InstallVerifiedTrustedKeysSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Canonical release tools key changed after pre-import verification."
    }
}

Copy-RevAgentManagedUpdaterToolFile -Source (Join-Path $PSScriptRoot "update-from-nas.ps1") -Destination $localUpdater
Copy-RevAgentManagedUpdaterToolFile -Source (Join-Path $PSScriptRoot "show-installed-version.ps1") -Destination $localVersionTool
Copy-RevAgentManagedUpdaterToolFile -Source (Join-Path $PSScriptRoot "migrate-source-free-install.ps1") -Destination $localMigrationTool -Required:([bool]$RunSourceFreeMigration)
Copy-RevAgentManagedUpdaterToolFile -Source (Join-Path $PSScriptRoot "Invoke-revAgent-CodexUserIntegration.ps1") -Destination $localCodexUserIntegrationTool
if (Test-Path -LiteralPath $localLibRoot) {
    Remove-Item -LiteralPath $localLibRoot -Recurse -Force
}
Copy-Item -LiteralPath $nasLibRoot -Destination $localLibRoot -Recurse -Force
[void](Assert-RevAgentManagedTreeLinkSafe -Root $localLibRoot)
Write-RevAgentAtomicBytes -Path $localTrustedReleaseKeysPath -Bytes ([System.IO.File]::ReadAllBytes($trustedReleaseKeysSource))
if (-not [string]::Equals(
        (Get-FileHash -Algorithm SHA256 -LiteralPath $localTrustedReleaseKeysPath).Hash,
        (Get-FileHash -Algorithm SHA256 -LiteralPath $trustedReleaseKeysSource).Hash,
        [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Atomic canonical trusted-key installation did not preserve the verified source hash."
}

$script:RevAgentRemoteReportsRoot = $ReportsRoot

$config = [ordered]@{
    schemaVersion = 1
    app = "revAgent"
    channelManifestPath = $ChannelManifestPath
    installRoot = $InstallRoot
    workRoot = $WorkRoot
    packageTarget = $PackageTarget
    serverTarget = $ServerTarget
    workspaceAgentsTarget = $WorkspaceAgentsTarget
    revitInstallRoot = $RevitInstallRoot
    revitVersion = $RevitVersion
    proxyUrl = $ProxyUrl
    proxyBypass = $ProxyBypass
    codexWorkspaceRoot = $CodexWorkspaceRoot
    codexInstructionPolicy = $CodexInstructionPolicy
    legacyServerTargets = $LegacyServerTargets
    reportsRoot = $ReportsRoot
    skipNpmInstall = [bool]$SkipNpmInstall
    skipCodexMcpRegistration = [bool]$SkipCodexMcpRegistration
    skipCodexUserIntegration = [bool]$SkipCodexUserIntegration
    skipProxySetup = [bool]$SkipProxySetup
    dailyAt = $DailyAt
    checkIntervalMinutes = $CheckIntervalMinutes
    taskName = $TaskName
    notifyUser = $true
    notificationThrottleMinutes = $NotificationThrottleMinutes
    logsRoot = (Join-Path $WorkRoot "logs")
    installLogPath = $script:RevAgentLogPath
    installOperationMethod = $script:RevAgentOperationMethod
    installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
}
if (-not [string]::IsNullOrWhiteSpace($TargetInteractiveUser)) {
    $config["targetInteractiveUser"] = $TargetInteractiveUser
}
if (-not [string]::IsNullOrWhiteSpace($TargetInteractiveUserSid)) {
    $config["targetInteractiveUserSid"] = $TargetInteractiveUserSid
}
if (-not [string]::IsNullOrWhiteSpace($TargetUserProfileRoot)) {
    $config["targetUserProfileRoot"] = [System.IO.Path]::GetFullPath($TargetUserProfileRoot)
}
if (-not [string]::IsNullOrWhiteSpace($TargetCodexHome)) {
    $config["targetCodexHome"] = [System.IO.Path]::GetFullPath($TargetCodexHome)
}
if (-not [string]::IsNullOrWhiteSpace($MachineRole)) {
    $config["machineRole"] = $MachineRole
}
$config["distributionIntegrity"] = [ordered]@{
    policy = "enforce"
    trustedKeysPath = $localTrustedReleaseKeysPath
}
Write-JsonFile -Path $configPath -Value $config
$manualCommandPath = Write-UpdaterCommandFiles -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -UpdaterWorkRoot $WorkRoot -VersionToolPath $localVersionTool -DailyAt $DailyAt -CheckIntervalMinutes $CheckIntervalMinutes
$versionCommandPath = Join-Path $WorkRoot "Show-revAgent-Version.cmd"
Repair-RevAgentUpdaterPermissions
if (-not $MachinePhaseOnly) {
    try {
        $script:RevAgentDesktopLauncherCleanup = Invoke-RevAgentLegacyDesktopLauncherCleanup
        if ([int]$script:RevAgentDesktopLauncherCleanup.removedCount -gt 0) {
            Write-Host ("Desktop launchers: removed {0} legacy revAgent launcher shortcut(s)." -f $script:RevAgentDesktopLauncherCleanup.removedCount) -ForegroundColor Green
        }
        if ([int]$script:RevAgentDesktopLauncherCleanup.failedCount -gt 0) {
            Write-Warning ("Desktop launchers: failed to remove {0} legacy revAgent launcher shortcut(s)." -f $script:RevAgentDesktopLauncherCleanup.failedCount)
        }
    }
    catch {
        Write-Warning "Desktop launcher cleanup failed: $($_.Exception.Message)"
    }
}

if ($MachinePhaseOnly) {
    if ($RunNow) {
        Write-Host ""
        Write-Host "Running elevated machine-only update..."
        $releaseUpdater = Join-Path $PSScriptRoot "update-from-nas.ps1"
        if (-not (Test-Path -LiteralPath $releaseUpdater -PathType Leaf)) {
            throw "Trusted release-source updater was not found beside install-updater-task.ps1: $releaseUpdater"
        }
        $expectedReleaseUpdaterHash = [string]$script:InstallVerifiedSurfaceHashes["updater"]
        $actualReleaseUpdaterHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $releaseUpdater).Hash
        if ([string]::IsNullOrWhiteSpace($expectedReleaseUpdaterHash) -or
            -not [string]::Equals($actualReleaseUpdaterHash, $expectedReleaseUpdaterHash, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Release updater changed after signed bootstrap verification. Expected=$expectedReleaseUpdaterHash Actual=$actualReleaseUpdaterHash"
        }
        Invoke-InitialUpdateCheck -UpdaterPath $releaseUpdater -UpdaterConfigPath $configPath -ForceUpdate:$ForceUpdate -SourceFreeMigration:$RunSourceFreeMigration -OperationMethod ("{0}-machine" -f $script:RevAgentOperationMethod) -MachinePhaseOnly -PhaseResultPath $phaseResultFullPath
    }
    Set-RevAgentInstallRunReport -Status "completed" -Message ("Elevated machine phase completed by {0}; user integration remains pending." -f $script:RevAgentOperationMethod)
    Write-Host "Machine phase    : completed; returning to the unelevated GUI." -ForegroundColor Green
    return
}

if ($NoScheduledTask) {
    Write-Host "Updater installed without scheduled task."
    Write-Host "Run manually: $manualCommandPath"
    Write-Host "Show version: $versionCommandPath"
    if ($RunNow) {
        Write-Host ""
        Write-Host "Running initial update check..."
        Invoke-InitialUpdateCheck -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -ForceUpdate:$ForceUpdate -SourceFreeMigration:$RunSourceFreeMigration -OperationMethod ("{0}-initial-update" -f $script:RevAgentOperationMethod)
    }
    Set-RevAgentInstallRunReport -Status "completed" -Message ("Updater install completed by {0}." -f $script:RevAgentOperationMethod)
    return
}

Register-RevAgentInteractiveUpdateTask -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -VersionToolPath $localVersionTool -UpdaterWorkRoot $WorkRoot -Name $TaskName -RunAt $DailyAt -IntervalMinutes $CheckIntervalMinutes

Write-Host "Updater installed: $localUpdater" -ForegroundColor Green
Write-Host "Config written  : $configPath" -ForegroundColor Green
Write-Host "Run manually    : $manualCommandPath" -ForegroundColor Green
Write-Host "Show version    : $versionCommandPath" -ForegroundColor Green

if ($RunNow) {
    Write-Host ""
    Write-Host "Running initial update check..."
    Invoke-InitialUpdateCheck -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -ForceUpdate:$ForceUpdate -SourceFreeMigration:$RunSourceFreeMigration -OperationMethod ("{0}-initial-update" -f $script:RevAgentOperationMethod)
}
Set-RevAgentInstallRunReport -Status "completed" -Message ("Updater install completed by {0}." -f $script:RevAgentOperationMethod)
}
catch {
    $originalFailure = $_
    $localFailureReportError = ""
    if ($UserPhaseOnly -and $null -eq $script:RevAgentCodexUserIntegrationPhase -and (Test-Path -LiteralPath $phaseResultFullPath -PathType Leaf)) {
        try {
            $script:RevAgentCodexUserIntegrationPhase = Read-RevAgentJsonReportFile -Path $phaseResultFullPath -AllowedRoot (Join-Path $WorkRoot "user-state")
        }
        catch {
            Write-Warning "Could not preserve the nested updater user-integration attestation: $($_.Exception.Message)"
        }
    }
    Write-Host ""
    Write-Host "revAgent updater install failed: $($originalFailure.Exception.Message)" -ForegroundColor Red
    if (-not [string]::IsNullOrWhiteSpace($script:RevAgentLogPath)) {
        Write-Host "Install log: $script:RevAgentLogPath" -ForegroundColor Yellow
    }
    try {
        Set-RevAgentInstallRunReport -Status "failed" -Message $originalFailure.Exception.Message
    }
    catch {
        $localFailureReportError = $_.Exception.Message
        Write-Warning "Could not write the local failed install report: $localFailureReportError"
    }
    if ($UserPhaseOnly) {
        try {
            $failedPublish = Publish-RevAgentPendingMachineInstallReport `
                -ReportPath (Join-Path $WorkRoot "machine-state\last-install-report.json") `
                -ReportAllowedRoot (Join-Path $WorkRoot "machine-state") `
                -LogAllowedRoot (Join-Path $WorkRoot "machine-logs") `
                -RemoteReportsRoot $ReportsRoot `
                -IntegrationStatus "failed" `
                -IntegrationMessage $originalFailure.Exception.Message `
                -IntegrationDetails ([ordered]@{
                    updaterUserPhase = $script:RevAgentCodexUserIntegrationPhase
                    desktopLauncherCleanup = $script:RevAgentDesktopLauncherCleanup
                })
            $reportPublishEvidence = [ordered]@{
                latestPath = [string]$failedPublish.LatestPath
                operationLatestPath = [string]$failedPublish.OperationLatestPath
                compatibilityPath = [string]$failedPublish.CompatibilityPath
                logPath = [string]$failedPublish.LogPath
            }
        }
        catch {
            $reportPublishError = $_.Exception.Message
        }
        $phaseFailureMessage = $originalFailure.Exception.Message
        if (-not [string]::IsNullOrWhiteSpace($localFailureReportError)) {
            $phaseFailureMessage = "$phaseFailureMessage Local install failure report also failed: $localFailureReportError"
        }
        if (-not [string]::IsNullOrWhiteSpace($reportPublishError)) {
            $phaseFailureMessage = "$phaseFailureMessage Machine install report publication also failed: $reportPublishError"
        }
        try {
            Write-RevAgentInstallUserPhaseResult -Status "failed" -Message $phaseFailureMessage -Details ([ordered]@{
                    reportPublished = ($null -ne $reportPublishEvidence)
                    reportEvidence = $reportPublishEvidence
                    reportPublishError = $reportPublishError
                    localFailureReportError = $localFailureReportError
                    codexUserIntegration = $script:RevAgentCodexUserIntegrationPhase
                })
        }
        catch {
            Write-Warning "Could not write the final user-phase failure result: $($_.Exception.Message)"
        }
    }
    throw $originalFailure
}
finally {
    Complete-RevAgentTranscript
    if ($MachinePhaseOnly -and $script:RevAgentMachineTreeProtected) {
        [void](Grant-RevAgentUserStateAccess -WorkRoot $WorkRoot -InteractivePrincipal $targetPermissionPrincipal)
        Write-Host "User-state ACL   : restored after all elevated installer/update traversal completed." -ForegroundColor Green
    }
    if ($null -ne $script:RevAgentSecureMachineTempContext) {
        Complete-RevAgentSecureMachineTemp -Context $script:RevAgentSecureMachineTempContext
    }
}
