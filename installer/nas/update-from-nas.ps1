<#
.SYNOPSIS
    Update a workstation from a NAS-hosted revAgent channel manifest.

.DESCRIPTION
    Reads channels\stable.json from the NAS, compares it with the local
    installed state, verifies the package hash, replaces the managed local
    package copy, runs the self-contained installer, refreshes npm dependencies,
    and writes a machine report.
#>

[CmdletBinding()]
param(
    [string]$ConfigPath = "",
    [string]$ChannelManifestPath = "",
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
    [string[]]$LegacyServerTargets = @(),
    [string]$ReportsRoot = "",
    [ValidateSet("", "compatibility", "enforce")]
    [string]$DistributionIntegrityPolicy = "",
    [ValidateSet("", "managed-user-pack", "preserve-local")]
    [string]$CodexInstructionPolicy = "",
    [string]$MachineRole = "",
    [switch]$AllowSignedReleaseRollback,
    [ValidateSet("", "disabled", "audit", "enforce")]
    [string]$LicensePolicy = "",
    [string]$LicensePath = "",
    [string]$LicenseSignaturePath = "",
    [switch]$Force,
    [switch]$SourceFreeMigration,
    [switch]$AuditOnly,
    [switch]$SkipNpmInstall,
    [switch]$SkipCodexMcpRegistration,
    [switch]$SkipCodexUserIntegration,
    [switch]$SkipProxySetup,
    [switch]$AllowManualCodexSetup,
    [string]$CodexWorkspaceRoot = "C:\Projects",
    [string]$TaskName = "revAgent Auto Update",
    [string]$LogPath = "",
    [string]$OperationMethod = "",
    [switch]$NotifyUser,
    [switch]$NoNotifyUser,
    [ValidateRange(15, 10080)]
    [int]$NotificationThrottleMinutes = 240,
    [switch]$AllowReplaceGitPackageTarget,
    [switch]$MachinePhaseOnly,
    [switch]$UserPhaseOnly,
    [string]$PhaseResultPath = "",
    [string]$ExecutionSnapshotStatePath = "",
    [string]$TargetInteractiveUser = "",
    [string]$TargetInteractiveUserSid = "",
    [string]$TargetUserProfileRoot = "",
    [string]$TargetCodexHome = "",
    [switch]$HostedMachinePhase,
    [switch]$ModulePathSecuritySmokeTest
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$script:RevAgentOsSystemDirectory = [Environment]::SystemDirectory
$script:RevAgentOsWindowsDirectory = [System.IO.Directory]::GetParent($script:RevAgentOsSystemDirectory).FullName
$script:RevAgentOsProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$script:RevAgentOsProgramFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
$script:RevAgentOsCommonAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$script:RevAgentOsUserProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$script:RevAgentOsAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
$script:RevAgentOsLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$script:RevAgentPreImportIntegrityModule = $null
$script:RevAgentExecutionSnapshotState = $null
$script:RevAgentExecutionSnapshotTrustedKeysPath = ""
$script:RevAgentAcquisitionChannelManifestPath = ""

function Initialize-RevAgentTrustedPowerShellModules {
    # `-NoProfile` does not disable module autoload. Remove user-writable module
    # roots before any security-sensitive command (Get-Acl, signature checks,
    # archive expansion, CIM, or ScheduledTasks) can trigger discovery.
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

function Assert-RevAgentEarlyReleaseFile {
    param([string]$Path, [string]$ReleaseRoot, [string[]]$BlockedSids)
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullRoot = [System.IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\")
    if (-not ($fullPath + "\").StartsWith($fullRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Pre-import release path escaped pinned root: $fullPath"
    }
    $writeMask = [System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    function Assert-RevAgentEarlyDirectoryEffectivelyReadOnly {
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
            throw "Pre-import release effective writability CreateNew probe failed unexpectedly for '$Directory': $($_.Exception.Message)"
        }
        finally {
            if ($null -ne $stream) { $stream.Dispose() }
        }
        if ($created) {
            try { [System.IO.File]::Delete($probePath) }
            catch { throw "Pre-import release effective writability probe succeeded but cleanup failed for '$probePath': $($_.Exception.Message)" }
            if (Test-Path -LiteralPath $probePath) { throw "Pre-import release effective writability probe cleanup did not remove '$probePath'." }
            throw "Pre-import release path is effectively writable and is not sealed (CreateNew succeeded): $Directory"
        }
    }
    $cursor = $fullPath
    while (($cursor + "\").StartsWith($fullRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
        if (-not (Test-Path -LiteralPath $cursor)) { throw "Pre-import release path is missing: $cursor" }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
            throw "Pre-import release path contains a link/reparse component: $cursor"
        }
        if ($item.PSIsContainer) { Assert-RevAgentEarlyDirectoryEffectivelyReadOnly -Directory $item.FullName }
        $acl = Get-Acl -LiteralPath $cursor -ErrorAction Stop
        $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
        foreach ($rule in $rules) {
            if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
                (($rule.FileSystemRights -band $writeMask) -ne 0)) {
                throw "Pre-import release path is not sealed read-only. principal=$($rule.IdentityReference.Value) rights=$($rule.FileSystemRights) path=$cursor"
            }
        }
        if ([string]::Equals($cursor.TrimEnd("\"), $fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }
    return $fullPath
}

function Assert-RevAgentEarlyReleaseSurface {
    param([string]$ChannelPath, [string]$ReleaseRoot, [string]$ToolsRoot, [string]$InteractiveSid)
    $blockedSids = @("S-1-1-0", "S-1-5-11", "S-1-5-32-545", $InteractiveSid) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $channelFullPath = Assert-RevAgentEarlyReleaseFile -Path $ChannelPath -ReleaseRoot $ReleaseRoot -BlockedSids $blockedSids
    $channel = Get-Content -Raw -LiteralPath $channelFullPath | ConvertFrom-Json
    $manifestPath = [string]$channel.manifestPath
    if (-not [System.IO.Path]::IsPathRooted($manifestPath)) { $manifestPath = Join-Path (Split-Path -Parent $channelFullPath) $manifestPath }
    $manifestPath = Assert-RevAgentEarlyReleaseFile -Path $manifestPath -ReleaseRoot $ReleaseRoot -BlockedSids $blockedSids
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $surfaceMap = [ordered]@{
        updater = @("installer\nas\update-from-nas.ps1", "update-from-nas.ps1")
        installerLibHiddenLauncher = @("installer\lib\RevAgent.HiddenLauncher.psm1", "lib\RevAgent.HiddenLauncher.psm1")
        installerLibScheduledTask = @("installer\lib\RevAgent.ScheduledTask.psm1", "lib\RevAgent.ScheduledTask.psm1")
        installerLibVersions = @("installer\lib\RevAgent.RevitVersions.psm1", "lib\RevAgent.RevitVersions.psm1")
        installerLibPackage = @("installer\lib\RevAgent.Package.psm1", "lib\RevAgent.Package.psm1")
        installerLibUpdatePolicy = @("installer\lib\RevAgent.UpdatePolicy.psm1", "lib\RevAgent.UpdatePolicy.psm1")
        installerLibProxy = @("installer\lib\RevAgent.Proxy.psm1", "lib\RevAgent.Proxy.psm1")
        installerLibLogRetention = @("installer\lib\RevAgent.LogRetention.psm1", "lib\RevAgent.LogRetention.psm1")
        installerLibPermissions = @("installer\lib\RevAgent.Permissions.psm1", "lib\RevAgent.Permissions.psm1")
        installerLibSecureTemp = @("installer\lib\RevAgent.SecureTemp.psm1", "lib\RevAgent.SecureTemp.psm1")
        installerLibCodexRegistration = @("installer\lib\RevAgent.CodexRegistration.psm1", "lib\RevAgent.CodexRegistration.psm1")
        installerLibConfigSync = @("installer\lib\RevAgent.ConfigSync.psm1", "lib\RevAgent.ConfigSync.psm1")
        installerLibReporting = @("installer\lib\RevAgent.Reporting.psm1", "lib\RevAgent.Reporting.psm1")
        installerLibDesktopLauncherCleanup = @("installer\lib\RevAgent.DesktopLauncherCleanup.psm1", "lib\RevAgent.DesktopLauncherCleanup.psm1")
        installerLibDistributionIntegrity = @("installer\lib\RevAgent.DistributionIntegrity.psm1", "lib\RevAgent.DistributionIntegrity.psm1")
        installerLibLicense = @("installer\lib\RevAgent.License.psm1", "lib\RevAgent.License.psm1")
        installerLibSourceFreeMigration = @("installer\lib\RevAgent.SourceFreeMigration.psm1", "lib\RevAgent.SourceFreeMigration.psm1")
    }
    foreach ($surface in $surfaceMap.GetEnumerator()) {
        $component = $manifest.components.($surface.Key)
        $filePath = Assert-RevAgentEarlyReleaseFile -Path (Join-Path $ToolsRoot ([string]$surface.Value[1])) -ReleaseRoot $ReleaseRoot -BlockedSids $blockedSids
        if ($null -eq $component -or -not [string]::Equals(([string]$component.path).Replace("/", "\"), [string]$surface.Value[0], [System.StringComparison]::OrdinalIgnoreCase)) { throw "Missing or invalid pre-import manifest component: $($surface.Key)" }
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $filePath).Hash
        if (-not [string]::Equals($hash, [string]$component.sha256, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Pre-import hash mismatch: $($surface.Key)" }
    }
    $keysPath = Assert-RevAgentEarlyReleaseFile -Path (Join-Path $ToolsRoot "config\release-trusted-keys.json") -ReleaseRoot $ReleaseRoot -BlockedSids $blockedSids
    foreach ($signaturePath in @(
            (Join-Path (Split-Path -Parent $channelFullPath) (([System.IO.Path]::GetFileNameWithoutExtension($channelFullPath)) + ".sig.json")),
            (Join-Path (Split-Path -Parent $manifestPath) (([System.IO.Path]::GetFileNameWithoutExtension($manifestPath)) + ".sig.json")))) {
        [void](Assert-RevAgentEarlyReleaseFile -Path $signaturePath -ReleaseRoot $ReleaseRoot -BlockedSids $blockedSids)
    }
    $keys = Get-Content -Raw -LiteralPath $keysPath | ConvertFrom-Json
    $key = $keys.trustedKeys."revagent-prod-rsa-2026q3"
    $normalizedKey = ([string]$key.publicKeyXml).Trim() -replace "\s+", ""
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $fingerprint = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalizedKey)))).Replace("-", "") } finally { $sha.Dispose() }
    if ($fingerprint -ne "32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33") { throw "Pinned release key fingerprint mismatch." }
    $integrityModulePath = Join-Path $ToolsRoot "lib\RevAgent.DistributionIntegrity.psm1"
    $pinnedIntegrityModuleHash = "A5DE45341FD8E55CA44EB99EA6B2DC19A18098A62DEBC770B7EF7499D16D2F1D"
    $actualIntegrityModuleHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $integrityModulePath).Hash
    if (-not [string]::Equals($actualIntegrityModuleHash, $pinnedIntegrityModuleHash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Pinned pre-import integrity verifier hash mismatch. Expected=$pinnedIntegrityModuleHash Actual=$actualIntegrityModuleHash"
    }
    $script:RevAgentPreImportIntegrityModule = Import-Module $integrityModulePath -Force -PassThru
    $verifyCommand = Get-Command ("{0}\Test-RevAgentReleaseDistributionIntegrity" -f $script:RevAgentPreImportIntegrityModule.Name) -ErrorAction Stop
    $verification = & $verifyCommand -ChannelPath $channelFullPath -Channel $channel -ReleaseManifestPath $manifestPath -ReleaseManifest $manifest -TrustedKeys $keys.trustedKeys -Policy enforce
    if (-not [bool]$verification.success) { throw "Signed pre-import release verification failed: $($verification.reason). $($verification.message)" }
}

function Assert-RevAgentEarlySnapshotPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$SnapshotRoot,
        [switch]$RequireLeaf
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullRoot = [System.IO.Path]::GetFullPath($SnapshotRoot).TrimEnd("\")
    if (-not [string]::Equals($fullPath.TrimEnd("\"), $fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $fullPath.StartsWith($fullRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Execution snapshot path escaped its protected root: $fullPath"
    }

    $writeMask = [System.Security.AccessControl.FileSystemRights]::WriteData -bor
        [System.Security.AccessControl.FileSystemRights]::AppendData -bor
        [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    $trustedWriterSids = @("S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464")
    $cursor = $fullPath
    while (-not [string]::IsNullOrWhiteSpace($cursor) -and $cursor.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        if (-not (Test-Path -LiteralPath $cursor)) { throw "Execution snapshot path is missing: $cursor" }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
            throw "Execution snapshot contains a filesystem link: $cursor"
        }
        $acl = Get-Acl -LiteralPath $cursor -ErrorAction Stop
        $ownerSid = [string]$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        if ($trustedWriterSids -notcontains $ownerSid) { throw "Execution snapshot owner is not trusted. path=$cursor owner=$ownerSid" }
        if (-not $acl.AreAccessRulesProtected) { throw "Execution snapshot DACL must be protected from inheritance: $cursor" }
        foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
            $sid = [string]$rule.IdentityReference.Value
            if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
                $trustedWriterSids -notcontains $sid -and (($rule.FileSystemRights -band $writeMask) -ne 0)) {
                throw "Execution snapshot grants write access to an untrusted principal. path=$cursor principal=$sid rights=$($rule.FileSystemRights)"
            }
        }
        if (-not $item.PSIsContainer) {
            $fsutilPath = Join-Path ([Environment]::SystemDirectory) "fsutil.exe"
            $links = @(& $fsutilPath hardlink list $item.FullName 2>&1 | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
            if ($LASTEXITCODE -ne 0 -or $links.Count -ne 1) { throw "Execution snapshot file must have exactly one hardlink reference: $($item.FullName)" }
        }
        if ([string]::Equals($cursor.TrimEnd("\"), $fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }
    if ($RequireLeaf -and -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "Execution snapshot file is missing: $fullPath" }
    return $fullPath
}

function Assert-RevAgentEarlyAuthenticatedSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$StatePath,
        [Parameter(Mandatory = $true)][string]$EntrypointComponent,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$RequiredComponents
    )

    $canonicalSnapshotsRoot = [System.IO.Path]::GetFullPath((Join-Path $script:RevAgentOsCommonAppData "DPE\revAgent\execution-snapshots")).TrimEnd("\")
    $stateFullPath = [System.IO.Path]::GetFullPath($StatePath)
    $snapshotRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $stateFullPath)).TrimEnd("\")
    if (-not $snapshotRoot.StartsWith($canonicalSnapshotsRoot + "\", [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals((Split-Path -Parent $snapshotRoot).TrimEnd("\"), $canonicalSnapshotsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Execution snapshot must be one exact child of '$canonicalSnapshotsRoot': $snapshotRoot"
    }
    $expectedStatePath = Join-Path $snapshotRoot "snapshot-state.json"
    if (-not [string]::Equals($stateFullPath, [System.IO.Path]::GetFullPath($expectedStatePath), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "ExecutionSnapshotStatePath must be the exact protected snapshot state file: $expectedStatePath"
    }
    [void](Assert-RevAgentEarlySnapshotPath -Path $stateFullPath -SnapshotRoot $snapshotRoot -RequireLeaf)
    $stateFile = Get-Item -LiteralPath $stateFullPath -Force -ErrorAction Stop
    if ($stateFile.Length -le 0 -or $stateFile.Length -gt 8388608) { throw "Execution snapshot state size is outside the bounded policy: $($stateFile.Length)" }
    $state = Get-Content -Raw -LiteralPath $stateFullPath | ConvertFrom-Json
    if ([int]$state.schemaVersion -ne 1 -or
        -not [string]::Equals([string]$state.app, "revAgent", [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$state.stateType, "authenticated-release-snapshot", [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$state.transportTrust, "signed_local_snapshot", [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([System.IO.Path]::GetFullPath([string]$state.snapshotRoot).TrimEnd("\"), $snapshotRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]$state.snapshotId -notmatch '^[a-f0-9]{32}$' -or [long]$state.release.releaseSequence -le 0 -or
        -not [bool]$state.trust.signaturesVerified) {
        throw "Execution snapshot state contract is invalid or unauthenticated: $stateFullPath"
    }
    $snapshotChannel = [string]$state.release.channel
    if ($snapshotChannel -notin @('stable', 'pilot') -or
        -not [string]::Equals([string]$state.release.channelManifestRelativePath, "channels\$snapshotChannel.json", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Execution snapshot channel binding is invalid: $snapshotChannel"
    }
    $snapshotChannelPath = Assert-RevAgentEarlySnapshotPath -Path (Join-Path $snapshotRoot ([string]$state.release.channelManifestRelativePath)) -SnapshotRoot $snapshotRoot -RequireLeaf
    if ([string]$state.release.channelManifestSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or
        -not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $snapshotChannelPath).Hash, [string]$state.release.channelManifestSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Execution snapshot channel manifest hash binding is invalid."
    }
    $expectedAcquisitionPath = [System.IO.Path]::GetFullPath("\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\channels\$snapshotChannel.json")
    if (-not [string]::Equals([System.IO.Path]::GetFullPath([string]$state.acquisitionChannelManifestPath), $expectedAcquisitionPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Execution snapshot acquisition channel is not the exact canonical state-bound path. expected=$expectedAcquisitionPath actual=$($state.acquisitionChannelManifestPath)"
    }

    foreach ($entry in $RequiredComponents.GetEnumerator()) {
        $component = $state.components.($entry.Key)
        if ($null -eq $component -or
            -not [string]::Equals(([string]$component.path).Replace("/", "\"), [string]$entry.Value, [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]$component.sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
            throw "Execution snapshot is missing required manifest component '$($entry.Key)'."
        }
        $expectedRelativePath = Join-Path "payload" ([string]$entry.Value)
        if (-not [string]::Equals(([string]$component.snapshotRelativePath).Replace("/", "\"), $expectedRelativePath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Execution snapshot component path mismatch for '$($entry.Key)'."
        }
        $componentPath = Assert-RevAgentEarlySnapshotPath -Path (Join-Path $snapshotRoot $expectedRelativePath) -SnapshotRoot $snapshotRoot -RequireLeaf
        if (-not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $componentPath).Hash, [string]$component.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Execution snapshot component hash mismatch: $($entry.Key)"
        }
        if ([string]::Equals([string]$entry.Key, $EntrypointComponent, [System.StringComparison]::Ordinal) -and
            -not [string]::Equals([System.IO.Path]::GetFullPath($PSCommandPath), [System.IO.Path]::GetFullPath($componentPath), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Updater entrypoint does not match the authenticated snapshot component '$EntrypointComponent'. Expected=$componentPath Actual=$PSCommandPath"
        }
    }

    $trustedKeysPath = Assert-RevAgentEarlySnapshotPath -Path (Join-Path $snapshotRoot ([string]$state.trust.trustedKeysRelativePath)) -SnapshotRoot $snapshotRoot -RequireLeaf
    $verifierPath = Assert-RevAgentEarlySnapshotPath -Path (Join-Path $snapshotRoot ([string]$state.trust.verifierRelativePath)) -SnapshotRoot $snapshotRoot -RequireLeaf
    foreach ($trustFile in @(
            [pscustomobject]@{ Path = $trustedKeysPath; Hash = [string]$state.trust.trustedKeysSha256; Label = "trusted keys" },
            [pscustomobject]@{ Path = $verifierPath; Hash = [string]$state.trust.verifierSha256; Label = "integrity verifier" })) {
        if ([string]$trustFile.Hash -notmatch '^[A-Fa-f0-9]{64}$' -or
            -not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $trustFile.Path).Hash, [string]$trustFile.Hash, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Execution snapshot $($trustFile.Label) hash mismatch."
        }
    }
    $productionKeyId = "revagent-prod-rsa-2026q3"
    $productionKeyFingerprint = "32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33"
    $trustedKeyDocument = Get-Content -Raw -LiteralPath $trustedKeysPath | ConvertFrom-Json
    $trustedKeyProperties = @($trustedKeyDocument.trustedKeys.PSObject.Properties)
    if ($trustedKeyProperties.Count -ne 1 -or
        -not [string]::Equals([string]$trustedKeyProperties[0].Name, $productionKeyId, [System.StringComparison]::Ordinal)) {
        throw "Execution snapshot trust document must contain exactly '$productionKeyId' and no additional signing keys."
    }
    $productionKey = $trustedKeyProperties[0].Value
    if (-not [string]::Equals([string]$productionKey.algorithm, "RS256", [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$productionKey.publicKeyFingerprint, $productionKeyFingerprint, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$state.trust.productionKeyFingerprint, $productionKeyFingerprint, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Execution snapshot production release-key metadata does not match the pinned RS256 key."
    }
    $normalizedProductionKey = ([string]$productionKey.publicKeyXml).Trim() -replace "\s+", ""
    $productionKeySha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $actualProductionFingerprint = ([System.BitConverter]::ToString($productionKeySha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalizedProductionKey)))).Replace("-", "")
    }
    finally { $productionKeySha.Dispose() }
    if (-not [string]::Equals($actualProductionFingerprint, $productionKeyFingerprint, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Execution snapshot production release-key fingerprint mismatch."
    }
    $pinnedIntegrityModuleHash = "A5DE45341FD8E55CA44EB99EA6B2DC19A18098A62DEBC770B7EF7499D16D2F1D"
    if (-not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $verifierPath).Hash, $pinnedIntegrityModuleHash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Pinned snapshot integrity verifier hash mismatch. Expected=$pinnedIntegrityModuleHash"
    }
    $script:RevAgentExecutionSnapshotTrustedKeysPath = $trustedKeysPath
    $script:RevAgentPreImportIntegrityModule = Import-Module $verifierPath -Force -PassThru
    return $state
}

# Reject unsafe privilege/legacy modes before resolving or importing any sibling
# module. Otherwise an elevated invocation of a user-writable copy could execute
# attacker-controlled module code before the later phase guard runs.
$earlyProcessIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$earlyProcessPrincipal = [System.Security.Principal.WindowsPrincipal]::new($earlyProcessIdentity)
$earlyProcessElevated = $earlyProcessPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
if ($MachinePhaseOnly -and $UserPhaseOnly) { throw "-MachinePhaseOnly and -UserPhaseOnly are mutually exclusive." }
if ($MachinePhaseOnly -and -not $earlyProcessElevated) { throw "-MachinePhaseOnly requires an elevated process before module import." }
if ($UserPhaseOnly -and $earlyProcessElevated) { throw "-UserPhaseOnly must run in the original unelevated interactive-user process before module import." }
if ($earlyProcessElevated -and -not $MachinePhaseOnly) { throw "Elevated updater execution is restricted to -MachinePhaseOnly before module import." }
if (-not $MachinePhaseOnly -and -not $UserPhaseOnly -and -not $AuditOnly) {
    throw "Mutating legacy updater execution is disabled before module import. Start the protected GUI so work is split into machine and user phases."
}

# Split phases import code only from one broker-created authenticated local
# snapshot. The NAS channel is data acquisition, never an execution origin.
if ($MachinePhaseOnly -or $UserPhaseOnly) {
    if ([string]::IsNullOrWhiteSpace($ExecutionSnapshotStatePath)) {
        throw "Split-phase updater execution requires -ExecutionSnapshotStatePath before sibling-module import."
    }
    $requiredSnapshotComponents = [ordered]@{
        updater = "installer\nas\update-from-nas.ps1"
        installerLibHiddenLauncher = "installer\lib\RevAgent.HiddenLauncher.psm1"
        installerLibScheduledTask = "installer\lib\RevAgent.ScheduledTask.psm1"
        installerLibVersions = "installer\lib\RevAgent.RevitVersions.psm1"
        installerLibPackage = "installer\lib\RevAgent.Package.psm1"
        installerLibUpdatePolicy = "installer\lib\RevAgent.UpdatePolicy.psm1"
        installerLibProxy = "installer\lib\RevAgent.Proxy.psm1"
        installerLibLogRetention = "installer\lib\RevAgent.LogRetention.psm1"
        installerLibPermissions = "installer\lib\RevAgent.Permissions.psm1"
        installerLibSecureTemp = "installer\lib\RevAgent.SecureTemp.psm1"
        installerLibCodexRegistration = "installer\lib\RevAgent.CodexRegistration.psm1"
        installerLibConfigSync = "installer\lib\RevAgent.ConfigSync.psm1"
        installerLibReporting = "installer\lib\RevAgent.Reporting.psm1"
        installerLibDesktopLauncherCleanup = "installer\lib\RevAgent.DesktopLauncherCleanup.psm1"
        installerLibDistributionIntegrity = "installer\lib\RevAgent.DistributionIntegrity.psm1"
        installerLibLicense = "installer\lib\RevAgent.License.psm1"
        installerLibSourceFreeMigration = "installer\lib\RevAgent.SourceFreeMigration.psm1"
    }
    $script:RevAgentExecutionSnapshotState = Assert-RevAgentEarlyAuthenticatedSnapshot `
        -StatePath $ExecutionSnapshotStatePath `
        -EntrypointComponent "updater" `
        -RequiredComponents $requiredSnapshotComponents
    $script:RevAgentAcquisitionChannelManifestPath = [System.IO.Path]::GetFullPath([string]$script:RevAgentExecutionSnapshotState.acquisitionChannelManifestPath)
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
Import-Module (Join-Path $nasLibRoot "RevAgent.Package.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.UpdatePolicy.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.Proxy.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.LogRetention.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.Permissions.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.CodexRegistration.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.ConfigSync.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.Reporting.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.DesktopLauncherCleanup.psm1") -Force
$script:RevAgentDistributionIntegrityModule = if ($MachinePhaseOnly -or $UserPhaseOnly) {
    $script:RevAgentPreImportIntegrityModule
}
else {
    Import-Module (Join-Path $nasLibRoot "RevAgent.DistributionIntegrity.psm1") -Force -PassThru
}
Import-Module (Join-Path $nasLibRoot "RevAgent.License.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.SourceFreeMigration.psm1") -Force
Set-RevAgentCurrentProcessUtf8Console | Out-Null

$updaterVersion = "0.1.0"
$script:RevAgentTranscriptStarted = $false
$script:RevAgentLogPath = ""
$script:PreviousTranscriptActive = $env:REVIT_MCP_TRANSCRIPT_ACTIVE
$script:PreviousLogPath = $env:REVIT_MCP_LOG_PATH
$script:RevAgentExecutionPhase = if ($MachinePhaseOnly) { "machine" } elseif ($UserPhaseOnly) { "user" } else { "legacy" }
$script:RevAgentProxyUrl = ""
$script:RevAgentProxyBypass = "<local>"
$script:RevAgentRemoteReportsRoot = ""
$script:RevAgentLatestReport = $null
$script:RevAgentDistributionIntegrityPolicy = "compatibility"
$script:RevAgentTrustedReleaseKeys = @{}
$script:RevAgentTrustedReleaseKeySources = @()
$script:RevAgentDistributionIntegrity = [ordered]@{
    success = $false
    state = "not-evaluated"
    reason = "not_evaluated"
    message = "Distribution integrity has not been evaluated yet."
    policy = $script:RevAgentDistributionIntegrityPolicy
    trustedKeyCount = 0
}
$script:RevAgentLicensePolicy = "disabled"
$script:RevAgentTrustedLicenseKeys = @{}
$script:RevAgentTrustedLicenseKeySources = @()
$script:RevAgentLicense = [ordered]@{
    success = $true
    valid = $false
    state = "disabled"
    reason = "disabled"
    message = "License verification is disabled."
    policy = $script:RevAgentLicensePolicy
}
$script:RevAgentOperation = if ($AuditOnly) { "audit" } elseif ($SourceFreeMigration) { "source-free-migration" } elseif ($Force) { "reinstall" } else { "update" }
$script:RevAgentOperationMethod = if (-not [string]::IsNullOrWhiteSpace($OperationMethod)) {
    $OperationMethod
}
elseif ($AuditOnly) {
    "audit"
}
elseif ($SourceFreeMigration) {
    "source-free-migration"
}
elseif ($Force) {
    "force-update"
}
else {
    "update"
}

function Initialize-RevAgentTranscript {
    param(
        [string]$PreferredWorkRoot,
        [string]$RequestedLogPath,
        [string]$Prefix
    )

    if ($MachinePhaseOnly -and -not $HostedMachinePhase) {
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
        Write-Host "Update log      : $path" -ForegroundColor Green
    }
    catch {
        if ($MachinePhaseOnly) {
            throw "Machine-phase transcript could not be started at protected path '$path'. $($_.Exception.Message)"
        }
        $script:RevAgentLogPath = $path
        Write-Warning "Could not start update transcript: $($_.Exception.Message). Intended log path: $path"
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
            Write-Warning "Could not publish remote update report/log: $($_.Exception.Message)"
        }
    }
}

function Import-UpdaterConfig {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Config file was not found: $Path"
    }

    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Resolve-ReleasePath {
    param(
        [string]$Path,
        [string]$BaseDirectory
    )

    return Resolve-RevAgentReleasePath -Path $Path -BaseDirectory $BaseDirectory
}

function Resolve-PackageLayout {
    param(
        [string]$Root,
        [object]$ReleaseManifest = $null
    )

    return Resolve-RevAgentPackageLayout -Root $Root -ReleaseManifest $ReleaseManifest
}

function Expand-ReleaseArchive {
    param(
        [string]$ZipPath,
        [string]$DestinationPath
    )

    Expand-RevAgentReleaseArchive -ZipPath $ZipPath -DestinationPath $DestinationPath
}

function Assert-ManagedDirectoryTarget {
    param(
        [string]$Path,
        [string[]]$ExpectedLeafNames
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
    $leaf = Split-Path -Leaf $fullPath
    $leafOk = $false
    foreach ($expectedLeaf in $ExpectedLeafNames) {
        if ([string]::Equals($leaf, $expectedLeaf, [System.StringComparison]::OrdinalIgnoreCase)) {
            $leafOk = $true
            break
        }
    }
    if (-not $leafOk) {
        throw "Refusing to replace managed package target because the leaf folder is not one of '$($ExpectedLeafNames -join ", ")': $fullPath"
    }

    $blocked = @(
        [System.IO.Path]::GetPathRoot($fullPath).TrimEnd("\"),
        [System.IO.Path]::GetFullPath($script:RevAgentOsUserProfile).TrimEnd("\"),
        [System.IO.Path]::GetFullPath($script:RevAgentOsAppData).TrimEnd("\"),
        [System.IO.Path]::GetFullPath($script:RevAgentOsLocalAppData).TrimEnd("\")
    )

    foreach ($candidate in $blocked) {
        if ([string]::Equals($fullPath, $candidate, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to replace broad directory target: $fullPath"
        }
    }

    return $fullPath
}

function Resolve-RequiredCommand {
    param(
        [string]$Name,
        [string[]]$Candidates = @(),
        [string]$InstallHint = ""
    )

    $elevationGuardAvailable = $null -ne (Get-Command Test-CurrentProcessElevated -CommandType Function -ErrorAction SilentlyContinue)
    $guardElevated = $elevationGuardAvailable -and (Test-CurrentProcessElevated)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source)) {
        if (-not $guardElevated) { return $command.Source }
        try {
            return Assert-RevAgentElevatedPathTrusted -Path $command.Source -RequireSignature:([System.IO.Path]::GetExtension([string]$command.Source) -ieq ".exe")
        }
        catch {
            if (-not (Test-CurrentProcessElevated)) { throw }
            Write-Warning "Ignoring untrusted elevated command candidate '$($command.Source)': $($_.Exception.Message)"
        }
    }

    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (Test-Path -LiteralPath $expanded -PathType Leaf) {
            if (-not $guardElevated) { return $expanded }
            try {
                return Assert-RevAgentElevatedPathTrusted -Path $expanded -RequireSignature:([System.IO.Path]::GetExtension($expanded) -ieq ".exe")
            }
            catch {
                if (-not (Test-CurrentProcessElevated)) { throw }
                Write-Warning "Ignoring untrusted elevated command candidate '$expanded': $($_.Exception.Message)"
            }
        }
    }

    $message = "Required command '$Name' was not found."
    if ($Candidates.Count -gt 0) {
        $message += " Checked: " + (($Candidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "; ")
    }
    if (-not [string]::IsNullOrWhiteSpace($InstallHint)) {
        $message += " $InstallHint"
    }
    $message += " Then run the revAgent updater again."
    throw $message
}

function Resolve-OptionalCommand {
    param(
        [string[]]$Names,
        [string[]]$Candidates = @()
    )

    $elevationGuardAvailable = $null -ne (Get-Command Test-CurrentProcessElevated -CommandType Function -ErrorAction SilentlyContinue)
    $guardElevated = $elevationGuardAvailable -and (Test-CurrentProcessElevated)
    foreach ($name in $Names) {
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source)) {
            if (-not $guardElevated) { return $command.Source }
            try {
                return Assert-RevAgentElevatedPathTrusted -Path $command.Source -RequireSignature:([System.IO.Path]::GetExtension([string]$command.Source) -ieq ".exe")
            }
            catch {
                if (-not (Test-CurrentProcessElevated)) { throw }
                Write-Warning "Ignoring untrusted elevated command candidate '$($command.Source)': $($_.Exception.Message)"
            }
        }
    }

    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (Test-Path -LiteralPath $expanded -PathType Leaf) {
            if (-not $guardElevated) { return $expanded }
            try {
                return Assert-RevAgentElevatedPathTrusted -Path $expanded -RequireSignature:([System.IO.Path]::GetExtension($expanded) -ieq ".exe")
            }
            catch {
                if (-not (Test-CurrentProcessElevated)) { throw }
                Write-Warning "Ignoring untrusted elevated command candidate '$expanded': $($_.Exception.Message)"
            }
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
    $candidatePaths = @(
        (Join-Path $script:RevAgentOsProgramFiles "nodejs"),
        (Join-Path $script:RevAgentOsProgramFilesX86 "nodejs")
    )
    if (-not (Test-CurrentProcessElevated)) {
        $candidatePaths += @(
            (Join-Path $script:RevAgentOsAppData "npm")
        )
    }

    foreach ($path in $candidatePaths) {
        Add-ProcessPathEntry -Path $path
    }
}

function Get-DependencySearchRoots {
    if ($MachinePhaseOnly) {
        $nodeMsiState = $script:RevAgentExecutionSnapshotState.externalDependencies.nodeMsi
        if ($null -eq $nodeMsiState -or [string]::IsNullOrWhiteSpace([string]$nodeMsiState.snapshotRelativePath)) {
            throw "Machine-only dependency resolution requires authenticated snapshot Node.js MSI evidence."
        }
        $snapshotRoot = [System.IO.Path]::GetFullPath([string]$script:RevAgentExecutionSnapshotState.snapshotRoot)
        $canonicalMsiPath = Assert-RevAgentEarlySnapshotPath -Path (Join-Path $snapshotRoot ([string]$nodeMsiState.snapshotRelativePath)) -SnapshotRoot $snapshotRoot -RequireLeaf
        $canonicalDependencyRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $canonicalMsiPath))
        $expectedDependencyRoot = [System.IO.Path]::GetFullPath((Join-Path $snapshotRoot "payload\installer\nas\dependencies"))
        if (-not [string]::Equals($canonicalDependencyRoot.TrimEnd("\"), $expectedDependencyRoot.TrimEnd("\"), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Machine-only dependency root is not the authenticated snapshot payload dependency root. Expected=$expectedDependencyRoot Actual=$canonicalDependencyRoot"
        }
        return @($canonicalDependencyRoot)
    }

    $roots = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
            $env:REVIT_MCP_DEPENDENCIES_ROOT,
            (Join-Path $PSScriptRoot "dependencies"),
            (Join-Path $WorkRoot "dependencies"),
            (Join-Path $PackageTarget "installer\nas\dependencies")
        )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $roots.Add($candidate)
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
        try {
            $channelDir = Split-Path -Parent $ChannelManifestPath
            $releaseRoot = Split-Path -Parent $channelDir
            $roots.Add((Join-Path $releaseRoot "tools\dependencies"))
        }
        catch {}
    }

    return @($roots.ToArray() | Select-Object -Unique)
}

function Resolve-DependencyFile {
    param([string]$FileName)

    foreach ($root in Get-DependencySearchRoots) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $candidate = Join-Path $root $FileName
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    return ""
}

function Invoke-ProcessWithTimeout {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 240
    )

    $FilePath = Assert-RevAgentElevatedPathTrusted -Path $FilePath -RequireSignature
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

function Test-RevAgentPathUnderRoot {
    param(
        [string]$Path,
        [string]$Root
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($Root)) {
        return $false
    }

    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
        $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
        return [string]::Equals($fullPath, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
            $fullPath.StartsWith($fullRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch {
        return $false
    }
}

function Assert-RevAgentPathHasNoReparseComponents {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $cursor = $fullPath
    if (-not (Test-Path -LiteralPath $cursor)) {
        $cursor = Split-Path -Parent $cursor
    }

    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing elevated access through a reparse-point path component: $($item.FullName)"
            }
        }

        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or
            [string]::Equals($parent, $cursor, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $cursor = $parent
    }

    return $fullPath
}

function Assert-RevAgentPathNotUserWritable {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$TrustedRoot
    )

    $untrustedSidValues = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($sidValue in @(
            "S-1-1-0",       # Everyone
            "S-1-5-11",      # Authenticated Users
            "S-1-5-32-545",  # BUILTIN\Users
            $TargetInteractiveUserSid,
            [string]([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
        )) {
        if (-not [string]::IsNullOrWhiteSpace($sidValue)) {
            [void]$untrustedSidValues.Add($sidValue)
        }
    }

    # Do not use the composite Write/Modify/FullControl values here because
    # they include Synchronize, which is also present on read-only rules.
    $writeMask = [System.Security.AccessControl.FileSystemRights]::WriteData -bor
        [System.Security.AccessControl.FileSystemRights]::AppendData -bor
        [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    $fullTrustedRoot = [System.IO.Path]::GetFullPath($TrustedRoot).TrimEnd("\")
    $cursor = [System.IO.Path]::GetFullPath($Path)
    while (-not [string]::IsNullOrWhiteSpace($cursor) -and
        (Test-RevAgentPathUnderRoot -Path $cursor -Root $fullTrustedRoot)) {
        $acl = Get-Acl -LiteralPath $cursor -ErrorAction Stop
        $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
        if ($null -ne $ownerSid -and $untrustedSidValues.Contains([string]$ownerSid.Value)) {
            throw "Refusing elevated use of a path owned by an unprivileged/user principal: $cursor (owner=$($ownerSid.Value))"
        }
        $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
        foreach ($rule in $rules) {
            if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
                continue
            }
            if ($untrustedSidValues.Contains([string]$rule.IdentityReference.Value) -and
                (($rule.FileSystemRights -band $writeMask) -ne 0)) {
                throw "Refusing elevated use of a user-writable path: $cursor (principal=$($rule.IdentityReference.Value), rights=$($rule.FileSystemRights))"
            }
        }

        if ([string]::Equals($cursor.TrimEnd("\"), $fullTrustedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or
            [string]::Equals($parent, $cursor, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $cursor = $parent
    }
}

function Assert-RevAgentElevatedPathTrusted {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$RequireSignature
    )

    $fullPath = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path))
    if (-not (Test-CurrentProcessElevated)) {
        return $fullPath
    }

    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Elevated execution target was not found: $fullPath"
    }

    $blockedRoots = @($script:RevAgentOsUserProfile, $script:RevAgentOsAppData, $script:RevAgentOsLocalAppData, $env:TEMP, $env:TMP) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    foreach ($blockedRoot in $blockedRoots) {
        if (Test-RevAgentPathUnderRoot -Path $fullPath -Root $blockedRoot) {
            throw "Refusing to use a user-writable path while elevated: $fullPath"
        }
    }

    $trustedRoots = @($script:RevAgentOsWindowsDirectory, $script:RevAgentOsProgramFiles, $script:RevAgentOsProgramFilesX86) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $underTrustedRoot = $false
    $matchedTrustedRoot = ""
    foreach ($trustedRoot in $trustedRoots) {
        if (Test-RevAgentPathUnderRoot -Path $fullPath -Root $trustedRoot) {
            $underTrustedRoot = $true
            $matchedTrustedRoot = $trustedRoot
            break
        }
    }
    if (-not $underTrustedRoot) {
        throw "Refusing elevated execution outside Windows or Program Files: $fullPath"
    }

    [void](Assert-RevAgentPathHasNoReparseComponents -Path $fullPath)
    Assert-RevAgentPathNotUserWritable -Path $fullPath -TrustedRoot $matchedTrustedRoot
    if ($RequireSignature) {
        $signature = Get-AuthenticodeSignature -LiteralPath $fullPath
        if ($null -eq $signature -or $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
            throw "Refusing unsigned or invalid elevated executable: $fullPath (signature=$($signature.Status))"
        }
    }

    return $fullPath
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
    throw "Elevated updater execution is restricted to -MachinePhaseOnly. Start the GUI normally so it can split machine and user phases."
}
if (-not $MachinePhaseOnly -and -not $UserPhaseOnly -and -not $AuditOnly) {
    throw "Mutating legacy updater execution is disabled. Start the protected GUI so update work is split into -MachinePhaseOnly and -UserPhaseOnly. Scheduled/background execution is audit-only."
}
if ($MachinePhaseOnly) {
    $SkipCodexMcpRegistration = $true
    $SkipCodexUserIntegration = $true
    $AllowManualCodexSetup = $false
    $WorkspaceAgentsTarget = ""
    $NotifyUser = $false
    $NoNotifyUser = $true
    Write-Host "Privilege phase  : elevated machine-only (user Codex/profile integration disabled)" -ForegroundColor Yellow
}
elseif ($UserPhaseOnly) {
    Write-Host "Privilege phase  : unelevated interactive-user integration" -ForegroundColor Green
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

function Set-RevAgentProxyEnvironment {
    param(
        [string]$ProxyUrl,
        [string]$NoProxy = "localhost,127.0.0.1,::1"
    )

    if ([string]::IsNullOrWhiteSpace($ProxyUrl)) {
        return
    }

    $elevated = Test-CurrentProcessElevated
    $targets = if ($elevated) { @("Process", "Machine") } else { @("Process", "User") }
    if ($elevated) {
        Write-Host "Proxy env       : machine-only phase; current-user environment is not modified."
    }

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
        $netshPath = Assert-RevAgentElevatedPathTrusted -Path (Join-Path $script:RevAgentOsSystemDirectory "netsh.exe") -RequireSignature
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
        $exitCode = Invoke-ProcessWithTimeout -FilePath $netshPath -Arguments @("winhttp", "set", "proxy", "proxy-server=$server", "bypass-list=$ProxyBypass") -TimeoutSeconds 60
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
        $exitCode = Invoke-ProcessWithTimeout -FilePath $FilePath -Arguments $Arguments -TimeoutSeconds 60
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

    if (Test-CurrentProcessElevated) {
        Write-Host "npm proxy       : deferred to unelevated user phase."
        return
    }

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

    if (Test-CurrentProcessElevated) {
        Write-Host "Git proxy       : deferred to unelevated user phase."
        return
    }

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

    $script:RevAgentProxyUrl = $normalizedProxyUrl
    $script:RevAgentProxyBypass = $ProxyBypass

    Write-Host "Office proxy    : $normalizedProxyUrl"
    Set-RevAgentProxyEnvironment -ProxyUrl $normalizedProxyUrl
    if (Test-CurrentProcessElevated) {
        Set-RevAgentWinHttpProxy -ProxyUrl $normalizedProxyUrl -ProxyBypass $ProxyBypass
        Write-Host "User proxy      : deferred to unelevated user phase."
    }
    else {
        Set-RevAgentWinInetProxy -ProxyUrl $normalizedProxyUrl -ProxyBypass $ProxyBypass
        Set-RevAgentNpmProxy -ProxyUrl $normalizedProxyUrl
        Set-RevAgentGitProxy -ProxyUrl $normalizedProxyUrl
    }
}

function Assert-PathUnderRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
    if (-not ($fullPath + "\").StartsWith($fullRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside managed dependency root. Path=$fullPath Root=$fullRoot"
    }

    return $fullPath
}

function Get-NodeMajorVersion {
    param([string]$NodePath)

    if ([string]::IsNullOrWhiteSpace($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        return -1
    }

    try {
        $guardElevated = ($null -ne (Get-Command Test-CurrentProcessElevated -CommandType Function -ErrorAction SilentlyContinue)) -and (Test-CurrentProcessElevated)
        if ($guardElevated) { $NodePath = Assert-RevAgentElevatedPathTrusted -Path $NodePath -RequireSignature }
        $versionText = (& $NodePath --version 2>$null | Out-String).Trim()
        if ($versionText -match '^v?(\d+)') {
            return [int]$Matches[1]
        }
    }
    catch {}

    return -1
}

function Get-RevAgentSha256Hex {
    param([string]$Text)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$Text)
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "")
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-NodeRuntimeIdentity {
    param([string]$NodePath)

    if ([string]::IsNullOrWhiteSpace($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        return $null
    }

    try {
        $guardElevated = ($null -ne (Get-Command Test-CurrentProcessElevated -CommandType Function -ErrorAction SilentlyContinue)) -and (Test-CurrentProcessElevated)
        if ($guardElevated) { $NodePath = Assert-RevAgentElevatedPathTrusted -Path $NodePath -RequireSignature }
        $identityJson = (& $NodePath -p 'JSON.stringify({nodeVersion:process.version,nodeModuleVersion:String(process.versions.modules),napiVersion:String(process.versions.napi),platform:process.platform,arch:process.arch})' 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($identityJson)) {
            return $null
        }

        $identity = $identityJson | ConvertFrom-Json
        $nodeModuleVersion = [string]$identity.nodeModuleVersion
        $platform = [string]$identity.platform
        $arch = [string]$identity.arch
        if ([string]::IsNullOrWhiteSpace($nodeModuleVersion) -or
            [string]::IsNullOrWhiteSpace($platform) -or
            [string]::IsNullOrWhiteSpace($arch)) {
            return $null
        }

        $napiVersion = [string]$identity.napiVersion
        if ([string]::IsNullOrWhiteSpace($napiVersion)) {
            $napiVersion = "none"
        }
        $runtimeKey = ("modules-{0}-napi-{1}-{2}-{3}" -f $nodeModuleVersion, $napiVersion, $platform, $arch) -replace '[^A-Za-z0-9._-]', '_'

        return [pscustomobject][ordered]@{
            nodePath = [System.IO.Path]::GetFullPath($NodePath)
            nodeVersion = [string]$identity.nodeVersion
            nodeModuleVersion = $nodeModuleVersion
            napiVersion = $napiVersion
            platform = $platform
            arch = $arch
            runtimeKey = $runtimeKey
        }
    }
    catch {
        return $null
    }
}

function Resolve-NpmCliScript {
    param(
        [string]$NpmPath,
        [string]$NodePath
    )

    foreach ($candidate in @(
            (Join-Path (Split-Path -Parent $NpmPath) "node_modules\npm\bin\npm-cli.js"),
            (Join-Path (Split-Path -Parent $NodePath) "node_modules\npm\bin\npm-cli.js")
        )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }

    throw "npm-cli.js was not found beside the selected npm or Node runtime. npm=$NpmPath node=$NodePath"
}

function Get-NpmCliRuntimeStatus {
    param(
        [string]$NodePath,
        [string]$NpmPath
    )

    $npmCliPath = ""
    $npmVersion = ""
    $errorMessage = ""
    try {
        $guardElevated = ($null -ne (Get-Command Test-CurrentProcessElevated -CommandType Function -ErrorAction SilentlyContinue)) -and (Test-CurrentProcessElevated)
        if ($guardElevated) { $NodePath = Assert-RevAgentElevatedPathTrusted -Path $NodePath -RequireSignature }
        $npmCliPath = Resolve-NpmCliScript -NpmPath $NpmPath -NodePath $NodePath
        if ($guardElevated) {
            [void](Assert-RevAgentPathHasNoReparseComponents -Path $npmCliPath)
            if (-not (Test-RevAgentPathUnderRoot -Path $npmCliPath -Root (Split-Path -Parent $NodePath))) {
                throw "Refusing npm CLI outside the trusted Node installation while elevated: $npmCliPath"
            }
            Assert-RevAgentPathNotUserWritable -Path $npmCliPath -TrustedRoot (Split-Path -Parent $NodePath)
        }
        $versionOutput = @(& $NodePath $npmCliPath --version 2>&1)
        $versionExitCode = $LASTEXITCODE
        $npmVersion = ($versionOutput | Out-String).Trim()
        if ($versionExitCode -ne 0) {
            $errorMessage = "Selected Node could not run npm-cli.js (exit $versionExitCode)."
        }
        elseif ([string]::IsNullOrWhiteSpace($npmVersion)) {
            $errorMessage = "Selected Node returned an empty npm-cli.js version."
        }
    }
    catch {
        $errorMessage = $_.Exception.Message
    }

    return [pscustomobject][ordered]@{
        nodePath = $NodePath
        npmPath = $NpmPath
        npmCliPath = $npmCliPath
        npmVersion = $npmVersion
        ready = (-not [string]::IsNullOrWhiteSpace($npmCliPath) -and -not [string]::IsNullOrWhiteSpace($npmVersion) -and [string]::IsNullOrWhiteSpace($errorMessage))
        error = $errorMessage
    }
}

function Get-NodeRuntimeStatus {
    $nodeCandidates = @(
        (Join-Path $script:RevAgentOsProgramFiles "nodejs\node.exe"),
        (Join-Path $script:RevAgentOsProgramFilesX86 "nodejs\node.exe")
    )
    $npmCandidates = @(
        (Join-Path $script:RevAgentOsProgramFiles "nodejs\npm.cmd"),
        (Join-Path $script:RevAgentOsProgramFilesX86 "nodejs\npm.cmd")
    )

    $nodePath = Resolve-OptionalCommand -Names @("node.exe", "node") -Candidates $nodeCandidates
    $npmPath = Resolve-OptionalCommand -Names @("npm.cmd", "npm") -Candidates $npmCandidates
    $major = Get-NodeMajorVersion -NodePath $nodePath
    $identity = Get-NodeRuntimeIdentity -NodePath $nodePath
    $npmCliStatus = Get-NpmCliRuntimeStatus -NodePath $nodePath -NpmPath $npmPath

    return [pscustomobject][ordered]@{
        nodePath = $nodePath
        npmPath = $npmPath
        npmCliPath = [string]$npmCliStatus.npmCliPath
        npmVersion = [string]$npmCliStatus.npmVersion
        npmError = [string]$npmCliStatus.error
        major = $major
        identity = $identity
        ready = (-not [string]::IsNullOrWhiteSpace($nodePath) -and -not [string]::IsNullOrWhiteSpace($npmPath) -and $major -ge 20 -and $null -ne $identity -and [bool]$npmCliStatus.ready)
    }
}

function Install-NodeFromWinget {
    if (Test-CurrentProcessElevated) {
        Write-Host "winget Node.js install skipped in elevated machine phase; user-profile WindowsApps shims are not trusted."
        return $false
    }

    $wingetPath = Resolve-OptionalCommand -Names @("winget.exe", "winget") -Candidates @(
        (Join-Path $script:RevAgentOsLocalAppData "Microsoft\WindowsApps\winget.exe")
    )
    if ([string]::IsNullOrWhiteSpace($wingetPath)) {
        Write-Warning "winget was not found; bundled Node.js MSI will be used if needed."
        return $false
    }

    Write-Host "Installing Node.js from internet with winget..."
    $exitCode = Invoke-ProcessWithTimeout -FilePath $wingetPath -Arguments @("install", "--id", "OpenJS.NodeJS.LTS", "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity") -TimeoutSeconds 300
    if ($exitCode -eq 0) {
        Refresh-DependencyPath
        return $true
    }

    Write-Warning "winget Node.js install failed with exit code $exitCode; bundled MSI will be tried."
    return $false
}

function Install-NodeFromBundledMsi {
    $msiPath = Resolve-DependencyFile -FileName "node-v24.14.1-x64.msi"
    if ([string]::IsNullOrWhiteSpace($msiPath)) {
        throw "Bundled Node.js installer was not found under NAS tools dependencies or local package dependencies."
    }

    if ($MachinePhaseOnly) {
        $nodeMsiState = $script:RevAgentExecutionSnapshotState.externalDependencies.nodeMsi
        if ($null -eq $nodeMsiState -or [string]::IsNullOrWhiteSpace([string]$nodeMsiState.snapshotRelativePath)) {
            throw "Authenticated execution snapshot does not contain the bundled Node.js MSI evidence."
        }
        $snapshotRoot = [System.IO.Path]::GetFullPath([string]$script:RevAgentExecutionSnapshotState.snapshotRoot)
        $canonicalMsiPath = Assert-RevAgentEarlySnapshotPath -Path (Join-Path $snapshotRoot ([string]$nodeMsiState.snapshotRelativePath)) -SnapshotRoot $snapshotRoot -RequireLeaf
        if (-not [string]::Equals([System.IO.Path]::GetFullPath($msiPath), [System.IO.Path]::GetFullPath($canonicalMsiPath), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing bundled Node.js MSI outside the authenticated local snapshot: $msiPath"
        }
        $expectedMsiSha256 = "FD8BA3E8262738959CAD50E6F6E71D689EAB7DD09FC7231B51D78ABE7852D4EC"
        if (-not [string]::Equals([string]$nodeMsiState.sha256, $expectedMsiSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Execution snapshot Node.js MSI evidence does not match the pinned SHA-256."
        }
        $actualMsiSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $msiPath).Hash
        if (-not [string]::Equals($actualMsiSha256, $expectedMsiSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Bundled Node.js MSI hash mismatch. Expected=$expectedMsiSha256 Actual=$actualMsiSha256"
        }
    }

    $msiSignature = Get-AuthenticodeSignature -LiteralPath $msiPath
    if ($null -eq $msiSignature -or $msiSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Bundled Node.js MSI has no valid Authenticode signature: $msiPath (signature=$($msiSignature.Status))"
    }
    $expectedSignerSubject = "CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US"
    if ($MachinePhaseOnly -and
        -not [string]::Equals([string]$msiSignature.SignerCertificate.Subject, $expectedSignerSubject, [System.StringComparison]::Ordinal)) {
        throw "Bundled Node.js MSI signer mismatch. Expected='$expectedSignerSubject' Actual='$($msiSignature.SignerCertificate.Subject)'"
    }

    $msiexecPath = Assert-RevAgentElevatedPathTrusted -Path (Join-Path $script:RevAgentOsSystemDirectory "msiexec.exe") -RequireSignature
    Write-Host "Installing Node.js from bundled MSI: $msiPath"
    $msiArgument = '"' + $msiPath.Replace('"', '\"') + '"'
    $process = Start-Process -FilePath $msiexecPath -ArgumentList "/i $msiArgument /qn /norestart" -Wait -PassThru
    if (@(0, 3010) -notcontains $process.ExitCode) {
        throw "Bundled Node.js MSI install failed with exit code $($process.ExitCode): $msiPath"
    }

    Refresh-DependencyPath
}

function Ensure-NodeRuntime {
    Refresh-DependencyPath
    $status = Get-NodeRuntimeStatus
    if ($status.ready) {
        Set-RevAgentNpmProxy -ProxyUrl $script:RevAgentProxyUrl
        return $status
    }

    $currentLabel = if ($status.major -gt 0) { "major version $($status.major)" } else { "not found" }
    Write-Host "Node.js/npm is not ready ($currentLabel). Trying automatic install."

    $installedFromInternet = Install-NodeFromWinget
    $status = Get-NodeRuntimeStatus
    if (-not $status.ready) {
        if (-not $installedFromInternet) {
            Write-Host "Falling back to bundled Node.js installer."
        }
        else {
            Write-Warning "Internet install completed but Node.js/npm is still not ready; falling back to bundled MSI."
        }
        Install-NodeFromBundledMsi
        $status = Get-NodeRuntimeStatus
    }

    if (-not $status.ready) {
        throw "Node.js/npm could not be prepared automatically. Expected Node.js 20 or newer and npm.cmd."
    }

    Write-Host "Node.js ready: $($status.nodePath)"
    Write-Host "npm ready    : $($status.npmPath)"
    Write-Host "npm CLI      : $($status.npmCliPath) ($($status.npmVersion))"
    Set-RevAgentNpmProxy -ProxyUrl $script:RevAgentProxyUrl
    return $status
}

function Get-CodexDesktopAppxPackage {
    try {
        return Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue |
            Sort-Object Version -Descending |
            Select-Object -First 1
    }
    catch {
        return $null
    }
}

function Test-CodexDesktopAvailable {
    return $null -ne (Get-CodexDesktopAppxPackage)
}

function New-CodexDesktopShortcut {
    $package = Get-CodexDesktopAppxPackage
    if (-not $package) {
        return
    }

    try {
        $programsRoot = [Environment]::GetFolderPath("Programs")
        if ([string]::IsNullOrWhiteSpace($programsRoot)) {
            return
        }

        $shortcutDir = Join-Path $programsRoot "DPE"
        New-Item -ItemType Directory -Path $shortcutDir -Force | Out-Null
        $shortcutPath = Join-Path $shortcutDir "ChatGPT.lnk"
        $appId = "$($package.PackageFamilyName)!App"
        $iconPath = Join-Path $package.InstallLocation "app\ChatGPT.exe"
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = Join-Path $script:RevAgentOsWindowsDirectory "explorer.exe"
        $shortcut.Arguments = "shell:AppsFolder\$appId"
        $shortcut.WorkingDirectory = $package.InstallLocation
        if (Test-Path -LiteralPath $iconPath -PathType Leaf) {
            $shortcut.IconLocation = "$iconPath,0"
        }
        $shortcut.Save()
        Write-Host "ChatGPT desktop shortcut: $shortcutPath"
    }
    catch {
        Write-Warning "Could not create ChatGPT desktop shortcut: $($_.Exception.Message)"
    }
}

function Remove-ObsoleteCodexManagedPayloads {
    $dependenciesRoot = Join-Path $InstallRoot "dependencies"
    foreach ($name in @("codex_app", "codex_command_payload")) {
        $target = Join-Path $dependenciesRoot $name
        if (-not (Test-Path -LiteralPath $target)) {
            continue
        }

        try {
            $safeTarget = Assert-PathUnderRoot -Path $target -Root $dependenciesRoot
            Remove-Item -LiteralPath $safeTarget -Recurse -Force
            Write-Host "Removed obsolete Codex managed payload: $safeTarget"
        }
        catch {
            Write-Warning "Could not remove obsolete Codex managed payload '$target': $($_.Exception.Message)"
        }
    }
}

function Ensure-CodexWorkspaceRoot {
    if ([string]::IsNullOrWhiteSpace($CodexWorkspaceRoot)) {
        return
    }

    $path = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($CodexWorkspaceRoot)).TrimEnd("\")
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        Write-Host "Codex workspace  : created $path"
        return
    }

    Write-Host "Codex workspace  : $path"
}

function Show-ManualCodexSetupPrompt {
    param([string]$Reason)

    Ensure-CodexWorkspaceRoot
    $message = @"
$Reason

Proxy ve internet ayarlari hazir.
Codex calisma klasoru hazir: $CodexWorkspaceRoot

Lutfen simdi ChatGPT masaustu uygulamasini (Codex dahil) manuel kurun/acin, oturum ve abonelik islemini tamamlayin, gerekirse calisma klasoru olarak $CodexWorkspaceRoot secin.

Codex hazir olduktan sonra devam etmek icin OK tusuna basin.
"@

    Write-Host "Manual Codex setup required."
    Write-Host $Reason
    Write-Host "Codex workspace  : $CodexWorkspaceRoot"

    try {
        Add-Type -AssemblyName System.Windows.Forms
        $result = [System.Windows.Forms.MessageBox]::Show(
            $message,
            "revAgent - ChatGPT",
            [System.Windows.Forms.MessageBoxButtons]::OKCancel,
            [System.Windows.Forms.MessageBoxIcon]::Information)
        return ($result -eq [System.Windows.Forms.DialogResult]::OK)
    }
    catch {
        Write-Warning "Could not show Codex setup prompt: $($_.Exception.Message)"
        return $false
    }
}

function Ensure-CodexDesktop {
    Remove-ObsoleteCodexManagedPayloads
    Ensure-CodexWorkspaceRoot

    if (Test-CodexDesktopAvailable) {
        New-CodexDesktopShortcut
        return
    }

    if ($AllowManualCodexSetup) {
        $reason = "Bu Windows kullanicisi icin ChatGPT masaustu uygulamasi (Codex dahil) kurulu degil."
        if (Show-ManualCodexSetupPrompt -Reason $reason) {
            Refresh-DependencyPath
            if (Test-CodexDesktopAvailable) {
                New-CodexDesktopShortcut
                return
            }
        }
    }

    throw "ChatGPT masaustu uygulamasi (Codex dahil) bu Windows kullanicisi icin kurulu degil. Proxy ayarlari ve Codex calisma klasoru hazir. ChatGPT'yi manuel kurup oturum acin, sonra installer/updater'i tekrar calistirin."
}

function Ensure-UpdateDependencies {
    param(
        [switch]$SkipNpmInstall,
        [switch]$SkipCodexMcpRegistration
    )

    $needsNodeRuntime = (-not $SkipNpmInstall) -or (-not $SkipCodexMcpRegistration)
    $nodeStatus = $null
    if ($needsNodeRuntime) {
        $nodeStatus = Ensure-NodeRuntime
    }

    if (-not $SkipCodexMcpRegistration) {
        [void](Ensure-CodexDesktop)
    }

    return $nodeStatus
}

function Get-NpmDependencyFingerprint {
    param(
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [object]$RuntimeIdentity
    )

    $fingerprintPath = ""
    $fingerprintSha256 = ""
    foreach ($relativePath in @("package-lock.json", "npm-shrinkwrap.json", "package.json")) {
        $candidate = Join-Path $WorkingDirectory $relativePath
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $fingerprintPath = $relativePath
            $fingerprintSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash
            break
        }
    }

    foreach ($requiredField in @("nodeModuleVersion", "platform", "arch", "runtimeKey")) {
        if ([string]::IsNullOrWhiteSpace([string]$RuntimeIdentity.$requiredField)) {
            throw "Node runtime identity is missing required field '$requiredField'."
        }
    }

    $cacheKey = if ([string]::IsNullOrWhiteSpace($fingerprintSha256)) {
        ""
    }
    else {
        (Get-RevAgentSha256Hex -Text ("{0}|{1}" -f $fingerprintSha256, [string]$RuntimeIdentity.runtimeKey)).ToLowerInvariant()
    }

    return [pscustomobject][ordered]@{
        path = $fingerprintPath
        sha256 = $fingerprintSha256
        nodePath = [string]$RuntimeIdentity.nodePath
        nodeVersion = [string]$RuntimeIdentity.nodeVersion
        nodeModuleVersion = [string]$RuntimeIdentity.nodeModuleVersion
        napiVersion = [string]$RuntimeIdentity.napiVersion
        platform = [string]$RuntimeIdentity.platform
        arch = [string]$RuntimeIdentity.arch
        runtimeKey = [string]$RuntimeIdentity.runtimeKey
        cacheKey = $cacheKey
    }
}

function Get-NpmDependencyMarkerPath {
    param([string]$WorkingDirectory)

    return Join-Path $WorkingDirectory ".revagent-npm-dependencies.json"
}

function Get-NpmPackageCacheName {
    param([string]$WorkingDirectory)

    $packageJsonPath = Join-Path $WorkingDirectory "package.json"
    $name = ""
    if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
        try {
            $packageJson = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json
            $name = [string]$packageJson.name
        }
        catch {
            $name = ""
        }
    }

    if ([string]::IsNullOrWhiteSpace($name)) {
        $name = Split-Path -Leaf $WorkingDirectory
    }

    $safeName = ($name -replace '[^A-Za-z0-9._-]', '_').Trim("_")
    if ([string]::IsNullOrWhiteSpace($safeName)) {
        return "package"
    }

    return $safeName
}

function Get-NpmDependencyCacheNodeModulesPath {
    param(
        [string]$CacheRoot,
        [string]$WorkingDirectory,
        [object]$Fingerprint
    )

    if ([string]::IsNullOrWhiteSpace($CacheRoot) -or
        [string]::IsNullOrWhiteSpace([string]$Fingerprint.sha256) -or
        [string]::IsNullOrWhiteSpace([string]$Fingerprint.cacheKey)) {
        return ""
    }

    $packageName = Get-NpmPackageCacheName -WorkingDirectory $WorkingDirectory
    return Join-Path $CacheRoot (Join-Path $packageName (Join-Path ([string]$Fingerprint.cacheKey) "node_modules"))
}

function Test-NpmPackageDeclaresDependency {
    param(
        [string]$WorkingDirectory,
        [string]$DependencyName
    )

    $packageJsonPath = Join-Path $WorkingDirectory "package.json"
    if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
        return $false
    }

    try {
        $packageJson = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json
        foreach ($sectionName in @("dependencies", "optionalDependencies")) {
            $section = $packageJson.$sectionName
            if ($null -eq $section) { continue }
            foreach ($property in $section.PSObject.Properties) {
                if ([string]::Equals([string]$property.Name, $DependencyName, [System.StringComparison]::OrdinalIgnoreCase)) {
                    return $true
                }
            }
        }
    }
    catch {
        return $false
    }

    return $false
}

function Test-NpmNativeDependenciesLoad {
    param(
        [string]$WorkingDirectory,
        [string]$NodePath,
        [string]$NodeModulesPath = "",
        [string]$Label = "Package",
        [switch]$Quiet
    )

    if (-not (Test-NpmPackageDeclaresDependency -WorkingDirectory $WorkingDirectory -DependencyName "better-sqlite3")) {
        return $true
    }

    if ([string]::IsNullOrWhiteSpace($NodeModulesPath)) {
        $NodeModulesPath = Join-Path $WorkingDirectory "node_modules"
    }
    $dependencyPath = Join-Path $NodeModulesPath "better-sqlite3"
    if (-not (Test-Path -LiteralPath $dependencyPath -PathType Container)) {
        if (-not $Quiet) {
            Write-Warning "$Label native dependency validation failed: better-sqlite3 is not installed under $NodeModulesPath."
        }
        return $false
    }

    $validationScript = @'
const Database = require(process.argv[1]);
const database = new Database(':memory:');
database.prepare('SELECT 1 AS ok').get();
database.close();
'@
    try {
        $guardElevated = ($null -ne (Get-Command Test-CurrentProcessElevated -CommandType Function -ErrorAction SilentlyContinue)) -and (Test-CurrentProcessElevated)
        if ($guardElevated) { $NodePath = Assert-RevAgentElevatedPathTrusted -Path $NodePath -RequireSignature }
        $validationOutput = @(& $NodePath -e $validationScript $dependencyPath 2>&1)
        $validationExitCode = $LASTEXITCODE
        if ($validationExitCode -eq 0) {
            return $true
        }

        if (-not $Quiet) {
            $detail = ($validationOutput | Out-String).Trim()
            if ($detail.Length -gt 600) {
                $detail = $detail.Substring(0, 600) + "...[truncated]"
            }
            Write-Warning "$Label native dependency validation failed under '$NodePath' (exit $validationExitCode). $detail"
        }
        return $false
    }
    catch {
        if (-not $Quiet) {
            Write-Warning "$Label native dependency validation failed under '$NodePath'. $($_.Exception.Message)"
        }
        return $false
    }
}

function Assert-NpmNativeDependenciesLoad {
    param(
        [string]$WorkingDirectory,
        [string]$NodePath,
        [string]$NodeModulesPath = "",
        [string]$Label = "Package"
    )

    if (-not (Test-NpmNativeDependenciesLoad -WorkingDirectory $WorkingDirectory -NodePath $NodePath -NodeModulesPath $NodeModulesPath -Label $Label)) {
        throw "$Label native dependencies are not loadable with the selected runtime Node: $NodePath"
    }
}

function Test-NpmDependenciesCurrent {
    param(
        [string]$WorkingDirectory,
        [object]$Fingerprint,
        [string]$NodePath,
        [string]$Label = "Package"
    )

    $nodeModulesPath = Join-Path $WorkingDirectory "node_modules"
    if (-not (Test-Path -LiteralPath $nodeModulesPath -PathType Container)) {
        return $false
    }

    $markerPath = Get-NpmDependencyMarkerPath -WorkingDirectory $WorkingDirectory
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        return $false
    }

    try {
        $marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
        $markerMatches = [int]$marker.schemaVersion -ge 2 -and
            [string]::Equals([string]$marker.fingerprintPath, [string]$Fingerprint.path, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals([string]$marker.fingerprintSha256, [string]$Fingerprint.sha256, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals([string]$marker.nodeModuleVersion, [string]$Fingerprint.nodeModuleVersion, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals([string]$marker.napiVersion, [string]$Fingerprint.napiVersion, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals([string]$marker.platform, [string]$Fingerprint.platform, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals([string]$marker.arch, [string]$Fingerprint.arch, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals([string]$marker.runtimeKey, [string]$Fingerprint.runtimeKey, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals([string]$marker.cacheKey, [string]$Fingerprint.cacheKey, [System.StringComparison]::OrdinalIgnoreCase) -and
            [bool]$marker.omitDev
        if (-not $markerMatches) {
            return $false
        }

        return Test-NpmNativeDependenciesLoad -WorkingDirectory $WorkingDirectory -NodePath $NodePath -Label $Label
    }
    catch {
        return $false
    }
}

function Remove-NpmNodeModulesPath {
    param([string]$WorkingDirectory)

    $nodeModulesPath = Join-Path $WorkingDirectory "node_modules"
    $item = Get-Item -LiteralPath $nodeModulesPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) {
        return
    }

    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        [System.IO.Directory]::Delete($nodeModulesPath, $false)
        return
    }

    Remove-Item -LiteralPath $nodeModulesPath -Recurse -Force
}

function Remove-InvalidNpmDependencyCache {
    param(
        [string]$CacheRoot,
        [string]$CacheNodeModulesPath,
        [string]$Reason
    )

    if ([string]::IsNullOrWhiteSpace($CacheNodeModulesPath)) {
        return
    }

    $cacheEntryRoot = Split-Path -Parent $CacheNodeModulesPath
    $safeCacheEntryRoot = Assert-PathUnderRoot -Path $cacheEntryRoot -Root $CacheRoot
    if ($null -eq (Get-Item -LiteralPath $safeCacheEntryRoot -Force -ErrorAction SilentlyContinue)) {
        return
    }
    Write-Warning "Discarding invalid npm dependency cache '$safeCacheEntryRoot'. $Reason"
    Remove-Item -LiteralPath $safeCacheEntryRoot -Recurse -Force
}

function New-NpmDependencyJunction {
    param(
        [string]$Path,
        [string]$Target
    )

    New-Item -ItemType Junction -Path $Path -Target $Target -Force | Out-Null
}

function Restore-NpmDependenciesFromCache {
    param(
        [string]$WorkingDirectory,
        [object]$Fingerprint,
        [string]$CacheRoot,
        [string]$NodePath,
        [string]$Label = "Package"
    )

    $nodeModulesPath = Join-Path $WorkingDirectory "node_modules"
    if (Test-Path -LiteralPath $nodeModulesPath -PathType Container) {
        return $false
    }

    $cacheNodeModulesPath = Get-NpmDependencyCacheNodeModulesPath -CacheRoot $CacheRoot -WorkingDirectory $WorkingDirectory -Fingerprint $Fingerprint
    if ([string]::IsNullOrWhiteSpace($cacheNodeModulesPath)) {
        return $false
    }

    if (-not (Test-Path -LiteralPath $cacheNodeModulesPath -PathType Container)) {
        Remove-InvalidNpmDependencyCache -CacheRoot $CacheRoot -CacheNodeModulesPath $cacheNodeModulesPath -Reason "Cache entry does not contain a node_modules directory."
        return $false
    }

    if (-not (Test-NpmNativeDependenciesLoad -WorkingDirectory $WorkingDirectory -NodePath $NodePath -NodeModulesPath $cacheNodeModulesPath -Label "$Label cache")) {
        Remove-InvalidNpmDependencyCache -CacheRoot $CacheRoot -CacheNodeModulesPath $cacheNodeModulesPath -Reason "Native dependency validation failed before cache restore."
        return $false
    }

    $markerPath = Get-NpmDependencyMarkerPath -WorkingDirectory $WorkingDirectory
    Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
    try {
        New-NpmDependencyJunction -Path $nodeModulesPath -Target $cacheNodeModulesPath
    }
    catch {
        Write-Warning "Could not link cached npm dependencies; copying instead. $($_.Exception.Message)"
        Remove-NpmNodeModulesPath -WorkingDirectory $WorkingDirectory
        try {
            Copy-Item -LiteralPath $cacheNodeModulesPath -Destination $nodeModulesPath -Recurse -Force
        }
        catch {
            Remove-NpmNodeModulesPath -WorkingDirectory $WorkingDirectory
            throw
        }
    }

    if (-not (Test-NpmNativeDependenciesLoad -WorkingDirectory $WorkingDirectory -NodePath $NodePath -Label "$Label restored cache")) {
        Remove-NpmNodeModulesPath -WorkingDirectory $WorkingDirectory
        Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
        Remove-InvalidNpmDependencyCache -CacheRoot $CacheRoot -CacheNodeModulesPath $cacheNodeModulesPath -Reason "Native dependency validation failed after cache restore."
        return $false
    }

    try {
        Write-NpmDependencyMarker -WorkingDirectory $WorkingDirectory -Fingerprint $Fingerprint
    }
    catch {
        Remove-NpmNodeModulesPath -WorkingDirectory $WorkingDirectory
        Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
        throw "Could not write the npm dependency marker after validated cache restore. $($_.Exception.Message)"
    }

    return $true
}

function Remove-StaleNpmDependencyJunction {
    param([string]$WorkingDirectory)

    $nodeModulesPath = Join-Path $WorkingDirectory "node_modules"
    $item = Get-Item -LiteralPath $nodeModulesPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) {
        return
    }

    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        return
    }

    [System.IO.Directory]::Delete($nodeModulesPath, $false)
}

function Write-NpmDependencyMarker {
    param(
        [string]$WorkingDirectory,
        [object]$Fingerprint
    )

    $marker = [ordered]@{
        schemaVersion = 2
        app = "revAgent"
        fingerprintPath = [string]$Fingerprint.path
        fingerprintSha256 = [string]$Fingerprint.sha256
        nodePath = [string]$Fingerprint.nodePath
        nodeVersion = [string]$Fingerprint.nodeVersion
        nodeModuleVersion = [string]$Fingerprint.nodeModuleVersion
        napiVersion = [string]$Fingerprint.napiVersion
        platform = [string]$Fingerprint.platform
        arch = [string]$Fingerprint.arch
        runtimeKey = [string]$Fingerprint.runtimeKey
        cacheKey = [string]$Fingerprint.cacheKey
        omitDev = $true
        installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    $markerPath = Get-NpmDependencyMarkerPath -WorkingDirectory $WorkingDirectory
    $marker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $markerPath -Encoding UTF8
}

function Save-NpmDependenciesToCache {
    param(
        [string]$WorkingDirectory,
        [object]$Fingerprint,
        [string]$CacheRoot,
        [string]$NodePath,
        [string]$Label = "Package"
    )

    $nodeModulesPath = Join-Path $WorkingDirectory "node_modules"
    if (-not (Test-Path -LiteralPath $nodeModulesPath -PathType Container)) {
        return
    }

    $cacheNodeModulesPath = Get-NpmDependencyCacheNodeModulesPath -CacheRoot $CacheRoot -WorkingDirectory $WorkingDirectory -Fingerprint $Fingerprint
    if ([string]::IsNullOrWhiteSpace($cacheNodeModulesPath)) {
        return
    }

    if (Test-Path -LiteralPath $cacheNodeModulesPath -PathType Container) {
        if (Test-NpmNativeDependenciesLoad -WorkingDirectory $WorkingDirectory -NodePath $NodePath -NodeModulesPath $cacheNodeModulesPath -Label "$Label cache" -Quiet) {
            return
        }
        Remove-InvalidNpmDependencyCache -CacheRoot $CacheRoot -CacheNodeModulesPath $cacheNodeModulesPath -Reason "Existing cache failed validation before save."
    }
    else {
        Remove-InvalidNpmDependencyCache -CacheRoot $CacheRoot -CacheNodeModulesPath $cacheNodeModulesPath -Reason "Existing cache entry does not contain a node_modules directory."
    }

    $cacheEntryRoot = Split-Path -Parent $cacheNodeModulesPath
    $cacheEntryParent = Split-Path -Parent $cacheEntryRoot
    New-Item -ItemType Directory -Path $cacheEntryParent -Force | Out-Null
    $stagingRoot = Join-Path $cacheEntryParent (".stg-" + [Guid]::NewGuid().ToString("N").Substring(0, 12))
    try {
        New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
        Copy-Item -LiteralPath $nodeModulesPath -Destination $stagingRoot -Recurse -Force
        $stagedNodeModulesPath = Join-Path $stagingRoot "node_modules"
        Assert-NpmNativeDependenciesLoad -WorkingDirectory $WorkingDirectory -NodePath $NodePath -NodeModulesPath $stagedNodeModulesPath -Label "$Label staged cache"
        Move-Item -LiteralPath $stagingRoot -Destination $cacheEntryRoot
    }
    finally {
        if (Test-Path -LiteralPath $stagingRoot) {
            Remove-Item -LiteralPath $stagingRoot -Recurse -Force
        }
    }
}

function Invoke-NpmWithLifecycleScripts {
    param(
        [string]$NodePath,
        [string]$NpmCliPath,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )

    if ([string]::IsNullOrWhiteSpace($NpmCliPath) -or -not (Test-Path -LiteralPath $NpmCliPath -PathType Leaf)) {
        throw "The resolved npm-cli.js path is missing: $NpmCliPath"
    }
    $previousNpmIgnoreScripts = [Environment]::GetEnvironmentVariable("npm_config_ignore_scripts", "Process")
    try {
        $env:npm_config_ignore_scripts = "false"
        Invoke-External -FilePath $NodePath -Arguments (@($npmCliPath) + @($Arguments)) -WorkingDirectory $WorkingDirectory
    }
    finally {
        if ($null -eq $previousNpmIgnoreScripts) {
            Remove-Item Env:\npm_config_ignore_scripts -ErrorAction SilentlyContinue
        }
        else {
            $env:npm_config_ignore_scripts = $previousNpmIgnoreScripts
        }
    }
}

function Invoke-NpmInstallIfNeeded {
    param(
        [string]$NodePath,
        [string]$NpmCliPath,
        [string]$WorkingDirectory,
        [string]$Label,
        [string]$CacheRoot
    )

    $runtimeIdentity = Get-NodeRuntimeIdentity -NodePath $NodePath
    if ($null -eq $runtimeIdentity) {
        throw "Could not determine the selected runtime Node ABI/platform/architecture: $NodePath"
    }

    $fingerprint = Get-NpmDependencyFingerprint -WorkingDirectory $WorkingDirectory -RuntimeIdentity $runtimeIdentity
    if ([string]::IsNullOrWhiteSpace([string]$fingerprint.sha256)) {
        Write-Host "$Label dependencies: package manifest not found; running npm install."
        Invoke-NpmWithLifecycleScripts -NodePath $NodePath -NpmCliPath $NpmCliPath -Arguments @("install", "--omit=dev", "--no-audit", "--no-fund") -WorkingDirectory $WorkingDirectory
        Assert-NpmNativeDependenciesLoad -WorkingDirectory $WorkingDirectory -NodePath $NodePath -Label $Label
        return
    }

    if (Test-NpmDependenciesCurrent -WorkingDirectory $WorkingDirectory -Fingerprint $fingerprint -NodePath $NodePath -Label $Label) {
        Write-Host "$Label dependencies: current; npm install skipped."
        return
    }

    Remove-StaleNpmDependencyJunction -WorkingDirectory $WorkingDirectory

    if (Restore-NpmDependenciesFromCache -WorkingDirectory $WorkingDirectory -Fingerprint $fingerprint -CacheRoot $CacheRoot -NodePath $NodePath -Label $Label) {
        Write-Host "$Label dependencies: restored from local cache; npm install skipped."
        return
    }

    Write-Host "$Label dependencies: installing or refreshing."
    Invoke-NpmWithLifecycleScripts -NodePath $NodePath -NpmCliPath $NpmCliPath -Arguments @("install", "--omit=dev", "--no-audit", "--no-fund") -WorkingDirectory $WorkingDirectory
    if (-not (Test-NpmNativeDependenciesLoad -WorkingDirectory $WorkingDirectory -NodePath $NodePath -Label $Label -Quiet) -and
        (Test-NpmPackageDeclaresDependency -WorkingDirectory $WorkingDirectory -DependencyName "better-sqlite3")) {
        Write-Warning "$Label better-sqlite3 binding is missing or incompatible after npm install; rebuilding with the selected runtime Node."
        Invoke-NpmWithLifecycleScripts -NodePath $NodePath -NpmCliPath $NpmCliPath -Arguments @("rebuild", "better-sqlite3", "--no-audit", "--no-fund") -WorkingDirectory $WorkingDirectory
    }
    Assert-NpmNativeDependenciesLoad -WorkingDirectory $WorkingDirectory -NodePath $NodePath -Label $Label
    Write-NpmDependencyMarker -WorkingDirectory $WorkingDirectory -Fingerprint $fingerprint
    Save-NpmDependenciesToCache -WorkingDirectory $WorkingDirectory -Fingerprint $fingerprint -CacheRoot $CacheRoot -NodePath $NodePath -Label $Label
}

function Invoke-NpmInstallMachinePhaseClean {
    param(
        [string]$NodePath,
        [string]$NpmCliPath,
        [string]$WorkingDirectory,
        [string]$Label
    )

    if (-not $MachinePhaseOnly -or -not (Test-CurrentProcessElevated)) {
        throw "Machine-phase clean npm provisioning requires elevated -MachinePhaseOnly."
    }
    $workingFullPath = [System.IO.Path]::GetFullPath($WorkingDirectory)
    if (-not (Test-RevAgentPathUnderRoot -Path $workingFullPath -Root $InstallRoot)) {
        throw "Refusing machine-phase npm provisioning outside InstallRoot: $workingFullPath"
    }
    [void](Assert-RevAgentPathHasNoReparseComponents -Path $workingFullPath)
    $lockPath = Join-Path $workingFullPath "package-lock.json"
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        throw "$Label machine-phase npm provisioning requires package-lock.json: $lockPath"
    }

    # Existing dependency trees and markers were writable before the ACL
    # lockdown and must never be probed or reused by an elevated process.
    Remove-NpmNodeModulesPath -WorkingDirectory $workingFullPath
    Remove-Item -LiteralPath (Get-NpmDependencyMarkerPath -WorkingDirectory $workingFullPath) -Force -ErrorAction SilentlyContinue
    Invoke-NpmWithLifecycleScripts `
        -NodePath $NodePath `
        -NpmCliPath $NpmCliPath `
        -Arguments @("ci", "--omit=dev", "--no-audit", "--no-fund") `
        -WorkingDirectory $workingFullPath
    Assert-NpmNativeDependenciesLoad -WorkingDirectory $workingFullPath -NodePath $NodePath -Label $Label

    $runtimeIdentity = Get-NodeRuntimeIdentity -NodePath $NodePath
    if ($null -eq $runtimeIdentity) {
        throw "Could not determine Node identity after clean $Label dependency provisioning."
    }
    $fingerprint = Get-NpmDependencyFingerprint -WorkingDirectory $workingFullPath -RuntimeIdentity $runtimeIdentity
    Write-NpmDependencyMarker -WorkingDirectory $workingFullPath -Fingerprint $fingerprint
    Write-Host "$Label dependencies: clean lockfile-backed npm ci completed in machine-only phase." -ForegroundColor Green
}

function Resolve-NpmCommand {
    return Resolve-RequiredCommand -Name "npm.cmd" -Candidates @(
        (Join-Path $script:RevAgentOsProgramFiles "nodejs\npm.cmd"),
        (Join-Path $script:RevAgentOsProgramFilesX86 "nodejs\npm.cmd")
    )
}

function ConvertTo-TomlString {
    param([string]$Value)

    if ($null -eq $Value) {
        return "''"
    }

    if ($Value -notmatch "'") {
        return "'" + $Value + "'"
    }

    $escaped = $Value.Replace("\", "\\").Replace('"', '\"')
    $escaped = $escaped -replace "`r", "\r" -replace "`n", "\n"
    return '"' + $escaped + '"'
}

function New-CodexMcpServerTomlBlock {
    param(
        [string]$Name,
        [string]$Command,
        [string[]]$McpArgs
    )

    $argText = (@($McpArgs) | ForEach-Object { ConvertTo-TomlString -Value $_ }) -join ", "
    return @(
        "[mcp_servers.$Name]",
        ("command = {0}" -f (ConvertTo-TomlString -Value $Command)),
        ("args = [{0}]" -f $argText),
        ""
    ) -join "`r`n"
}

function Set-CodexMcpServerConfig {
    param(
        [string]$Name,
        [string]$Command,
        [string[]]$McpArgs
    )

    $configRoot = Join-Path $script:RevAgentOsUserProfile ".codex"
    New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
    $configPath = Join-Path $configRoot "config.toml"
    $content = ""
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $content = Get-Content -Raw -LiteralPath $configPath
    }

    $block = New-CodexMcpServerTomlBlock -Name $Name -Command $Command -McpArgs $McpArgs
    $pattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($Name))\]\r?\n.*?(?=^\[|\z)"
    if ($content -match $pattern) {
        $content = [regex]::Replace($content, $pattern, $block)
    }
    else {
        if (-not [string]::IsNullOrWhiteSpace($content) -and -not $content.EndsWith("`n")) {
            $content += "`r`n"
        }
        if (-not [string]::IsNullOrWhiteSpace($content)) {
            $content += "`r`n"
        }
        $content += $block
    }

    Set-Content -LiteralPath $configPath -Value $content -Encoding UTF8
    return $configPath
}

function Remove-CodexMcpServerConfig {
    param(
        [string]$Name
    )

    $configRoot = Join-Path $script:RevAgentOsUserProfile ".codex"
    $configPath = Join-Path $configRoot "config.toml"
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        return $configPath
    }

    $content = Get-Content -Raw -LiteralPath $configPath
    $pattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($Name))\]\r?\n.*?(?=^\[|\z)"
    $updated = [regex]::Replace($content, $pattern, "")
    $updated = [regex]::Replace($updated, '(\r?\n){3,}', "`r`n`r`n").TrimEnd() + "`r`n"
    if ($updated -ne $content) {
        Set-Content -LiteralPath $configPath -Value $updated -Encoding UTF8
    }
    return $configPath
}

function Register-CodexMcpServersInConfig {
    param(
        [string]$NodePath,
        [string]$RuntimeServerPath,
        [string]$DocsServerPath
    )

    foreach ($legacyName in @("revit-mcp", "revit-api-docs")) {
        [void](Remove-CodexMcpServerConfig -Name $legacyName)
    }

    $configPath = Set-CodexMcpServerConfig -Name "revAgent" -Command $NodePath -McpArgs @($RuntimeServerPath)
    [void](Set-CodexMcpServerConfig -Name "revAgent-api-docs" -Command $NodePath -McpArgs @($DocsServerPath))
    [void](Set-RevAgentCodexMemoryConfig -ConfigPath $configPath)
    Write-Host "Codex MCP config : $configPath"
}

function Set-CodexMemoryConfig {
    $configRoot = Join-Path $script:RevAgentOsUserProfile ".codex"
    $configPath = Join-Path $configRoot "config.toml"
    [void](Set-RevAgentCodexMemoryConfig -ConfigPath $configPath)
    Write-Host "Codex memory config: enabled"
    return $configPath
}

function Remove-CodexProfileBackupArtifacts {
    if ($SkipCodexUserIntegration) {
        return
    }

    $codexRoot = Join-Path $script:RevAgentOsUserProfile ".codex"
    if (-not (Test-Path -LiteralPath $codexRoot -PathType Container)) {
        return
    }

    $removed = 0
    foreach ($pattern in @("AGENTS.md.backup-*", "config.toml.backup-*")) {
        Get-ChildItem -LiteralPath $codexRoot -File -Filter $pattern -ErrorAction SilentlyContinue |
            ForEach-Object {
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
                $removed++
            }
    }

    $codexSkillsRoot = Join-Path $codexRoot "skills"
    if (Test-Path -LiteralPath $codexSkillsRoot -PathType Container) {
        Get-ChildItem -LiteralPath $codexSkillsRoot -Directory -Filter "revit-mcp.backup-*" -ErrorAction SilentlyContinue |
            ForEach-Object {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
                $removed++
            }
    }

    $legacySkillBackupsRoot = Join-Path $codexRoot "skill-backups"
    if (Test-Path -LiteralPath $legacySkillBackupsRoot -PathType Container) {
        Remove-Item -LiteralPath $legacySkillBackupsRoot -Recurse -Force -ErrorAction Stop
        $removed++
    }

    if ($removed -gt 0) {
        Write-Host ("Codex cleanup   : removed {0} old backup artifact(s)" -f $removed) -ForegroundColor Green
    }
}

function Resolve-RevitInstallRoot {
    param(
        [string]$RequestedRoot,
        [string]$Version
    )

    return Resolve-RevAgentInstallRoot -RequestedRoot $RequestedRoot -Version $Version
}

function Invoke-External {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )

    $FilePath = Assert-RevAgentElevatedPathTrusted -Path $FilePath -RequireSignature
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$FilePath failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function Get-InstalledState {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        Write-Warning "Installed state is not valid JSON and will be ignored: $Path"
        return $null
    }
}

function New-RevAgentProtectedMachineFileSecurity {
    $security = [Security.AccessControl.FileSecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($entry in @(
            [pscustomobject]@{ Sid = 'S-1-5-18'; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
            [pscustomobject]@{ Sid = 'S-1-5-32-544'; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
            [pscustomobject]@{ Sid = 'S-1-5-32-545'; Rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
        )) {
        [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new([string]$entry.Sid),
                [Security.AccessControl.FileSystemRights]$entry.Rights,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    return $security
}

function Write-RevAgentProtectedMachineBytesCreateNew {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not (Test-RevAgentPathUnderRoot -Path $fullPath -Root $InstallRoot)) {
        throw "Protected machine file must remain below InstallRoot: $fullPath"
    }
    [void](Assert-RevAgentPathHasNoReparseComponents -Path $fullPath)
    $parent = Split-Path -Parent $fullPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw "Protected machine file parent was not found: $parent" }
    $stream = $null
    try {
        $stream = [IO.FileStream]::new(
            $fullPath,
            [IO.FileMode]::CreateNew,
            [Security.AccessControl.FileSystemRights]::Write,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough,
            (New-RevAgentProtectedMachineFileSecurity))
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
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

    if ($MachinePhaseOnly -and (Test-RevAgentPathUnderRoot -Path $Path -Root $InstallRoot)) {
        $fullPath = [IO.Path]::GetFullPath($Path)
        $tempPath = Join-Path $dir ('.revagent-machine-json-{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 12))
        try {
            Write-RevAgentProtectedMachineBytesCreateNew -Path $tempPath -Bytes $bytes
            Move-Item -LiteralPath $tempPath -Destination $fullPath -Force -ErrorAction Stop
        }
        finally {
            if (Test-Path -LiteralPath $tempPath -PathType Leaf) { [IO.File]::Delete($tempPath) }
        }
        return
    }

    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Set-RevAgentPersistentUpdaterChannel {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Config,
        [Parameter(Mandatory = $true)][string]$PersistentChannelManifestPath
    )

    if (-not $MachinePhaseOnly) { return $null }
    if ($null -eq $script:RevAgentExecutionSnapshotState) {
        throw 'Machine-phase channel persistence requires an authenticated execution snapshot.'
    }
    $fullConfigPath = [System.IO.Path]::GetFullPath($Path)
    $previousExists = Test-Path -LiteralPath $fullConfigPath -PathType Leaf
    $previousBytes = if ($previousExists) { [System.IO.File]::ReadAllBytes($fullConfigPath) } else { [byte[]]@() }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $previousSha256 = if ($previousExists) { ([BitConverter]::ToString($sha.ComputeHash($previousBytes))).Replace('-', '') } else { '' } }
    finally { $sha.Dispose() }
    $fullPersistentPath = [System.IO.Path]::GetFullPath($PersistentChannelManifestPath)
    $mutation = [pscustomobject][ordered]@{
        path = $fullConfigPath
        previousExists = $previousExists
        previousBytes = $previousBytes
        previousSha256 = $previousSha256
        persistedChannelManifestPath = $fullPersistentPath
    }
    if ($Config.PSObject.Properties['channelManifestPath']) {
        $Config.channelManifestPath = $fullPersistentPath
    }
    else {
        $Config | Add-Member -MemberType NoteProperty -Name channelManifestPath -Value $fullPersistentPath
    }
    try {
        Write-JsonFile -Path $fullConfigPath -Value $Config
        $persisted = Import-UpdaterConfig -Path $fullConfigPath
        if (-not [string]::Equals([System.IO.Path]::GetFullPath([string]$persisted.channelManifestPath), $fullPersistentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Persistent updater channel verification failed after atomic config write.'
        }
    }
    catch {
        $persistError = $_
        Restore-RevAgentPersistentUpdaterChannel -Mutation $mutation
        throw $persistError
    }
    return $mutation
}

function Restore-RevAgentPersistentUpdaterChannel {
    param([Parameter(Mandatory = $true)][object]$Mutation)

    $path = [System.IO.Path]::GetFullPath([string]$Mutation.path)
    if ([bool]$Mutation.previousExists) {
        $directory = Split-Path -Parent $path
        $tempPath = Join-Path $directory ('.revagent-channel-rollback-{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
        try {
            Write-RevAgentProtectedMachineBytesCreateNew -Path $tempPath -Bytes ([byte[]]$Mutation.previousBytes)
            Move-Item -LiteralPath $tempPath -Destination $path -Force -ErrorAction Stop
        }
        finally { if (Test-Path -LiteralPath $tempPath -PathType Leaf) { [IO.File]::Delete($tempPath) } }
        $restoredBytes = [IO.File]::ReadAllBytes($path)
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $restoredSha256 = ([BitConverter]::ToString($sha.ComputeHash($restoredBytes))).Replace('-', '') }
        finally { $sha.Dispose() }
        if ($restoredBytes.Length -ne ([byte[]]$Mutation.previousBytes).Length -or
            -not [string]::Equals($restoredSha256, [string]$Mutation.previousSha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Updater config rollback did not restore the exact previous bytes.'
        }
    }
    elseif (Test-Path -LiteralPath $path -PathType Leaf) {
        [IO.File]::Delete($path)
        if (Test-Path -LiteralPath $path) { throw 'Updater config rollback did not restore prior absence.' }
    }
}

function Test-RevAgentCleanInstallTransitionRequired {
    param(
        [string]$MarkerPath,
        [string]$BackupRoot,
        [string]$PackageTarget,
        [switch]$AuditOnly
    )

    if ($AuditOnly) {
        return $false
    }
    if (-not [string]::IsNullOrWhiteSpace($MarkerPath) -and
        (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
        return $false
    }

    $hasExistingPackage = -not [string]::IsNullOrWhiteSpace($PackageTarget) -and
        (Test-Path -LiteralPath $PackageTarget -PathType Container)
    $hasExistingBackups = $false
    if (-not [string]::IsNullOrWhiteSpace($BackupRoot) -and
        (Test-Path -LiteralPath $BackupRoot -PathType Container)) {
        $hasExistingBackups = @(Get-ChildItem -LiteralPath $BackupRoot -Force -ErrorAction SilentlyContinue).Count -gt 0
    }

    return ($hasExistingPackage -or $hasExistingBackups)
}

function Get-VersionLabel {
    param([string]$Version)

    if ([string]::IsNullOrWhiteSpace($Version)) {
        return "not installed"
    }

    return $Version
}

function Get-JsonPropertyValue {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) {
        return $null
    }

    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
        return $Object[$Name]
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($property) {
        return $property.Value
    }

    return $null
}

function Resolve-CodexInstructionPolicy {
    param(
        [string]$RequestedPolicy,
        [object]$Config
    )

    $policy = $RequestedPolicy
    if ([string]::IsNullOrWhiteSpace($policy)) {
        $configuredPolicy = Get-JsonPropertyValue -Object $Config -Name "codexInstructionPolicy"
        if ($null -ne $configuredPolicy) {
            $policy = [string]$configuredPolicy
        }
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
        [object]$Config
    )

    $role = $RequestedRole
    if ([string]::IsNullOrWhiteSpace($role)) {
        $configuredRole = Get-JsonPropertyValue -Object $Config -Name "machineRole"
        if ($null -ne $configuredRole) {
            $role = [string]$configuredRole
        }
    }
    if ([string]::IsNullOrWhiteSpace($role) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_MACHINE_ROLE)) {
        $role = [string]$env:REVIT_MCP_MACHINE_ROLE
    }

    return $role
}

function Get-UpdaterDistributionIntegrityCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$Required
    )

    function Resolve-UpdaterDistributionIntegrityAliasCommand {
        param(
            [AllowNull()][object]$Command,
            [AllowNull()][object]$Module
        )

        $current = $Command
        for ($i = 0; $i -lt 4; $i++) {
            if ($null -eq $current -or $current.CommandType -ne [System.Management.Automation.CommandTypes]::Alias) {
                return $current
            }

            $definition = [string]$current.Definition
            if ([string]::IsNullOrWhiteSpace($definition)) {
                return $current
            }

            $resolved = $null
            if ($Module -and $Module.ExportedFunctions -and $Module.ExportedFunctions.ContainsKey($definition)) {
                $resolved = $Module.ExportedFunctions[$definition]
            }
            if (-not $resolved -and -not [string]::IsNullOrWhiteSpace($current.ModuleName)) {
                $resolved = Get-Command ("{0}\{1}" -f $current.ModuleName, $definition) -ErrorAction SilentlyContinue
            }
            if (-not $resolved -and $Module -and -not [string]::IsNullOrWhiteSpace($Module.Name)) {
                $resolved = Get-Command ("{0}\{1}" -f $Module.Name, $definition) -ErrorAction SilentlyContinue
            }
            if (-not $resolved) {
                $resolved = Get-Command $definition -ErrorAction SilentlyContinue
            }
            if (-not $resolved) {
                return $current
            }

            $current = $resolved
        }

        return $current
    }

    $command = $null
    $module = @($script:RevAgentDistributionIntegrityModule | Select-Object -First 1)
    if ($module) {
        if ($module.ExportedFunctions -and $module.ExportedFunctions.ContainsKey($Name)) {
            $command = $module.ExportedFunctions[$Name]
        }
        elseif ($module.ExportedCommands -and $module.ExportedCommands.ContainsKey($Name)) {
            $command = $module.ExportedCommands[$Name]
        }
    }

    if (-not $command) {
        $command = Get-Command ("RevAgent.DistributionIntegrity\{0}" -f $Name) -ErrorAction SilentlyContinue
    }
    if (-not $command) {
        $command = Get-Command $Name -ErrorAction SilentlyContinue
    }
    $command = Resolve-UpdaterDistributionIntegrityAliasCommand -Command $command -Module $module
    if (-not $command -and $Required) {
        throw "Distribution integrity helper '$Name' was not loaded from RevAgent.DistributionIntegrity.psm1."
    }

    return $command
}

function Add-TrustedReleaseKeys {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Target,
        [AllowNull()][object]$Source
    )

    $convertCommand = Get-UpdaterDistributionIntegrityCommand -Name "ConvertTo-RevAgentTrustedKeyMap" -Required
    $sourceMap = & $convertCommand -TrustedKeys $Source
    foreach ($key in $sourceMap.Keys) {
        $Target[[string]$key] = $sourceMap[$key]
    }

    return $sourceMap.Count
}

function Resolve-UpdaterConfigRelativePath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }

    if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
        $configDir = Split-Path -Parent $ConfigPath
        if (-not [string]::IsNullOrWhiteSpace($configDir)) {
            return [System.IO.Path]::GetFullPath((Join-Path $configDir $Path))
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($WorkRoot)) {
        return [System.IO.Path]::GetFullPath((Join-Path $WorkRoot $Path))
    }

    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Path))
}

function Get-UpdaterDetachedSignaturePath {
    param([Parameter(Mandatory = $true)][string]$ContentPath)

    $command = Get-UpdaterDistributionIntegrityCommand -Name "Get-RevAgentDetachedSignaturePath"
    if ($command) {
        return & $command -ContentPath $ContentPath
    }

    $directory = Split-Path -Parent $ContentPath
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($ContentPath)
    return Join-Path $directory ("{0}.sig.json" -f $baseName)
}

function Add-TrustedReleaseKeysFromFile {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Target,
        [string]$Path,
        [switch]$Required
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    $fullPath = Resolve-UpdaterConfigRelativePath -Path $Path
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        if ($Required) {
            throw "Configured release trusted-key file was not found: $fullPath"
        }
        return $null
    }

    $document = Get-Content -Raw -LiteralPath $fullPath | ConvertFrom-Json
    $trustedKeys = Get-JsonPropertyValue -Object $document -Name "trustedKeys"
    if ($null -eq $trustedKeys) {
        $trustedKeys = $document
    }

    $keyCount = Add-TrustedReleaseKeys -Target $Target -Source $trustedKeys
    return [pscustomobject]@{ Path = $fullPath; KeyCount = [int]$keyCount }
}

function Set-DistributionIntegrityBlockedReport {
    param(
        [string]$Policy,
        [hashtable]$TrustedKeys,
        [System.Collections.Generic.List[string]]$Sources,
        [string]$Reason,
        [string]$Message,
        [string]$TrustedKeysPath = ""
    )

    $effectivePolicy = if ([string]::IsNullOrWhiteSpace($Policy)) { "enforce" } else { $Policy }
    $script:RevAgentDistributionIntegrityPolicy = $effectivePolicy
    $script:RevAgentTrustedReleaseKeys = $TrustedKeys
    $script:RevAgentTrustedReleaseKeySources = @($Sources.ToArray())
    $script:RevAgentDistributionIntegrity = [ordered]@{
        success = $false
        state = "blocked"
        reason = $Reason
        message = $Message
        policy = $effectivePolicy
        trustedKeyCount = $TrustedKeys.Count
        trustedKeySources = @($script:RevAgentTrustedReleaseKeySources)
        trustedKeysPath = $TrustedKeysPath
    }
}

function Initialize-DistributionIntegrityConfig {
    param([AllowNull()][object]$Config)

    $policy = ""
    $trustedKeys = @{}
    $sources = [System.Collections.Generic.List[string]]::new()
    $consumedKeyPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $integrityConfig = if ($Config) { Get-JsonPropertyValue -Object $Config -Name "distributionIntegrity" } else { $null }

    if ($integrityConfig) {
        $configuredPolicy = [string](Get-JsonPropertyValue -Object $integrityConfig -Name "policy")
        if (-not [string]::IsNullOrWhiteSpace($configuredPolicy)) {
            if ($configuredPolicy -notin @("compatibility", "enforce")) {
                throw "Unsupported distribution integrity policy '$configuredPolicy'."
            }
            $policy = $configuredPolicy
        }

        $directTrustedKeys = Get-JsonPropertyValue -Object $integrityConfig -Name "trustedKeys"
        if ($null -ne $directTrustedKeys) {
            $added = Add-TrustedReleaseKeys -Target $trustedKeys -Source $directTrustedKeys
            if ($added -gt 0) {
                [void]$sources.Add("updater-config")
            }
        }

        $trustedKeysPath = [string](Get-JsonPropertyValue -Object $integrityConfig -Name "trustedKeysPath")
        if (-not [string]::IsNullOrWhiteSpace($trustedKeysPath)) {
            try {
                $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $trustedKeysPath -Required
            }
            catch {
                $resolvedTrustedKeysPath = Resolve-UpdaterConfigRelativePath -Path $trustedKeysPath
                $message = "Trusted release keys are configured but could not be loaded from '$resolvedTrustedKeysPath'. Run Install/Repair after restoring release-trusted-keys.json."
                Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_missing" -Message $message -TrustedKeysPath $resolvedTrustedKeysPath
                throw $message
            }
            if ($loaded) {
                [void]$sources.Add($loaded.Path)
                [void]$consumedKeyPaths.Add($loaded.Path)
            }
        }

        $trustedKeyPaths = Get-JsonPropertyValue -Object $integrityConfig -Name "trustedKeyPaths"
        foreach ($path in @($trustedKeyPaths)) {
            if ([string]::IsNullOrWhiteSpace([string]$path)) {
                continue
            }
            try {
                $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path ([string]$path) -Required
            }
            catch {
                $resolvedTrustedKeysPath = Resolve-UpdaterConfigRelativePath -Path ([string]$path)
                $message = "Trusted release keys are configured but could not be loaded from '$resolvedTrustedKeysPath'. Run Install/Repair after restoring release-trusted-keys.json."
                Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_missing" -Message $message -TrustedKeysPath $resolvedTrustedKeysPath
                throw $message
            }
            if ($loaded) {
                [void]$sources.Add($loaded.Path)
                [void]$consumedKeyPaths.Add($loaded.Path)
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($DistributionIntegrityPolicy)) {
        $policy = $DistributionIntegrityPolicy
    }

    foreach ($candidate in @(
            $script:RevAgentExecutionSnapshotTrustedKeysPath,
            (Join-Path $WorkRoot "config\release-trusted-keys.json"),
            (Join-Path $PSScriptRoot "config\release-trusted-keys.json"),
            (Join-Path (Split-Path -Parent $PSScriptRoot) "config\release-trusted-keys.json")
        )) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        $candidateFullPath = [System.IO.Path]::GetFullPath($candidate)
        if ($consumedKeyPaths.Contains($candidateFullPath)) {
            continue
        }
        try {
            $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $candidate -Required
        }
        catch {
            $message = "Auto-discovered trusted release keys could not be loaded from '$candidate'. Run Install/Repair after restoring release-trusted-keys.json."
            Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_invalid" -Message $message -TrustedKeysPath $candidate
            throw $message
        }
        if ($null -eq $loaded -or $loaded.KeyCount -le 0) {
            $message = "Auto-discovered trusted release keys file '$candidate' did not contain any trusted keys. Run Install/Repair after restoring release-trusted-keys.json."
            Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_empty" -Message $message -TrustedKeysPath $candidate
            throw $message
        }
        [void]$consumedKeyPaths.Add($candidateFullPath)
        [void]$consumedKeyPaths.Add($loaded.Path)
        [void]$sources.Add($loaded.Path)
    }

    if ([string]::IsNullOrWhiteSpace($policy)) {
        $policy = if ($trustedKeys.Count -gt 0) { "enforce" } else { "compatibility" }
    }
    elseif ($trustedKeys.Count -gt 0 -and [string]::Equals($policy, "compatibility", [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Warning "DistributionIntegrityPolicy compatibility was escalated to enforce because trusted release keys are configured."
        $policy = "enforce"
    }

    $script:RevAgentDistributionIntegrityPolicy = $policy
    $script:RevAgentTrustedReleaseKeys = $trustedKeys
    $script:RevAgentTrustedReleaseKeySources = @($sources.ToArray())
    $script:RevAgentDistributionIntegrity = [ordered]@{
        success = $true
        state = "configured"
        reason = "configured"
        message = "Distribution integrity policy loaded."
        policy = $policy
        trustedKeyCount = $trustedKeys.Count
        trustedKeySources = @($script:RevAgentTrustedReleaseKeySources)
    }
}

function ConvertTo-Int64OrZero {
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

function Test-TruthyJsonValue {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) {
        return $false
    }
    if ($Value -is [bool]) {
        return [bool]$Value
    }

    $text = [string]$Value
    return [string]::Equals($text, "true", [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($text, "1", [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($text, "yes", [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-InstalledHighestAcceptedReleaseSequence {
    param([AllowNull()][object]$InstalledState)

    if ($null -eq $InstalledState) {
        return [long]0
    }

    $highest = ConvertTo-Int64OrZero -Value (Get-JsonPropertyValue -Object $InstalledState -Name "highestAcceptedReleaseSequence")
    $topLevelSequence = ConvertTo-Int64OrZero -Value (Get-JsonPropertyValue -Object $InstalledState -Name "releaseSequence")
    $highest = [Math]::Max($highest, $topLevelSequence)
    $hasAcceptedSignedRelease = Test-TruthyJsonValue -Value (Get-JsonPropertyValue -Object $InstalledState -Name "hasAcceptedSignedRelease")
    $integrity = Get-JsonPropertyValue -Object $InstalledState -Name "distributionIntegrity"
    if ($integrity) {
        $highest = [Math]::Max($highest, (ConvertTo-Int64OrZero -Value (Get-JsonPropertyValue -Object $integrity -Name "highestAcceptedReleaseSequence")))
        $highest = [Math]::Max($highest, (ConvertTo-Int64OrZero -Value (Get-JsonPropertyValue -Object $integrity -Name "releaseSequence")))
        $integrityState = [string](Get-JsonPropertyValue -Object $integrity -Name "state")
        if ([string]::Equals($integrityState, "verified", [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($integrityState, "rollback-allowed", [System.StringComparison]::OrdinalIgnoreCase)) {
            $hasAcceptedSignedRelease = $true
        }
    }
    if ($hasAcceptedSignedRelease -and $highest -lt 1) {
        $highest = [long]1
    }

    return [long]$highest
}

function Initialize-LicenseConfig {
    param([AllowNull()][object]$Config)

    $policy = "disabled"
    $trustedKeys = @{}
    $sources = [System.Collections.Generic.List[string]]::new()
    $configuredLicensePath = $LicensePath
    $configuredSignaturePath = $LicenseSignaturePath
    $licenseConfig = if ($Config) { Get-JsonPropertyValue -Object $Config -Name "license" } else { $null }

    if ($licenseConfig) {
        $configuredPolicy = [string](Get-JsonPropertyValue -Object $licenseConfig -Name "policy")
        if (-not [string]::IsNullOrWhiteSpace($configuredPolicy)) {
            if ($configuredPolicy -notin @("disabled", "audit", "enforce")) {
                throw "Unsupported license policy '$configuredPolicy'."
            }
            $policy = $configuredPolicy
        }

        $directTrustedKeys = Get-JsonPropertyValue -Object $licenseConfig -Name "trustedKeys"
        if ($null -ne $directTrustedKeys) {
            $added = Add-TrustedReleaseKeys -Target $trustedKeys -Source $directTrustedKeys
            if ($added -gt 0) {
                [void]$sources.Add("updater-config")
            }
        }

        $trustedKeysPath = [string](Get-JsonPropertyValue -Object $licenseConfig -Name "trustedKeysPath")
        if (-not [string]::IsNullOrWhiteSpace($trustedKeysPath)) {
            $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $trustedKeysPath -Required
            if ($loaded) {
                [void]$sources.Add($loaded.Path)
            }
        }

        if ([string]::IsNullOrWhiteSpace($configuredLicensePath)) {
            $configuredLicensePath = [string](Get-JsonPropertyValue -Object $licenseConfig -Name "licensePath")
        }
        if ([string]::IsNullOrWhiteSpace($configuredSignaturePath)) {
            $configuredSignaturePath = [string](Get-JsonPropertyValue -Object $licenseConfig -Name "signaturePath")
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($LicensePolicy)) {
        $policy = $LicensePolicy
    }

    foreach ($candidate in @(
            (Join-Path $WorkRoot "config\license-trusted-keys.json"),
            (Join-Path $PSScriptRoot "config\license-trusted-keys.json"),
            (Join-Path (Split-Path -Parent $PSScriptRoot) "config\license-trusted-keys.json")
        )) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $candidate
        if ($loaded) {
            [void]$sources.Add($loaded.Path)
        }
    }

    if ([string]::IsNullOrWhiteSpace($configuredLicensePath)) {
        foreach ($candidate in @(
                (Join-Path $InstallRoot "license\revagent-license.json"),
                (Join-Path $WorkRoot "license\revagent-license.json"),
                (Join-Path $WorkRoot "config\revagent-license.json")
            )) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $configuredLicensePath = $candidate
                break
            }
        }
        if ([string]::IsNullOrWhiteSpace($configuredLicensePath)) {
            $configuredLicensePath = Join-Path $InstallRoot "license\revagent-license.json"
        }
    }
    else {
        $configuredLicensePath = Resolve-UpdaterConfigRelativePath -Path $configuredLicensePath
    }

    if ([string]::IsNullOrWhiteSpace($configuredSignaturePath)) {
        $configuredSignaturePath = Get-UpdaterDetachedSignaturePath -ContentPath $configuredLicensePath
    }
    else {
        $configuredSignaturePath = Resolve-UpdaterConfigRelativePath -Path $configuredSignaturePath
    }

    $script:RevAgentLicensePolicy = $policy
    $script:RevAgentTrustedLicenseKeys = $trustedKeys
    $script:RevAgentTrustedLicenseKeySources = @($sources.ToArray())
    $script:RevAgentLicense = Test-RevAgentLicenseSeatFile `
        -LicensePath $configuredLicensePath `
        -SignaturePath $configuredSignaturePath `
        -TrustedKeys $trustedKeys `
        -Policy $policy

    $script:RevAgentLicense | Add-Member -NotePropertyName "trustedKeyCount" -NotePropertyValue $trustedKeys.Count -Force
    $script:RevAgentLicense | Add-Member -NotePropertyName "trustedKeySources" -NotePropertyValue @($script:RevAgentTrustedLicenseKeySources) -Force
}

function Get-ComponentByKey {
    param(
        [object]$Manifest,
        [string]$Key
    )

    $components = Get-JsonPropertyValue -Object $Manifest -Name "components"
    if ($null -eq $components) {
        return $null
    }

    return Get-JsonPropertyValue -Object $components -Name $Key
}

function Get-ComponentSha256 {
    param([object]$Component)

    $sha = Get-JsonPropertyValue -Object $Component -Name "sha256"
    if ($null -eq $sha) {
        return ""
    }

    return [string]$sha
}

function Get-ComponentPath {
    param([object]$Component)

    $path = Get-JsonPropertyValue -Object $Component -Name "path"
    if ($null -eq $path) {
        return ""
    }

    return [string]$path
}

function Get-RelativeFileSha256OrNull {
    param(
        [string]$Root,
        [string]$RelativePath
    )

    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($RelativePath)) {
        return ""
    }

    $candidate = Join-Path $Root $RelativePath
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash
    }

    return ""
}

function Get-DirectoryTreeSha256OrNull {
    param(
        [string]$Root,
        [string]$RelativePath,
        [string[]]$ExcludeDirectoryNames = @("node_modules", ".git"),
        [string[]]$ExcludeFileNames = @(".revagent-npm-dependencies.json", ".npm-deps.sha256")
    )

    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($RelativePath)) {
        return ""
    }

    $path = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        return ""
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

    $files = Get-ChildItem -LiteralPath $path -Recurse -File -Force |
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
        Sort-Object FullName

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($path.Length).TrimStart("\", "/").Replace("\", "/")
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
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

    return ([System.BitConverter]::ToString($digest) -replace "-", "")
}

function Test-DirectoryPayloadUnchanged {
    param(
        [object]$Manifest,
        [string]$ComponentKey,
        [string]$PackageTarget
    )

    $component = Get-ComponentByKey -Manifest $Manifest -Key $ComponentKey
    $targetSha = Get-ComponentSha256 -Component $component
    $relativePath = Get-ComponentPath -Component $component
    if ([string]::IsNullOrWhiteSpace($targetSha) -or [string]::IsNullOrWhiteSpace($relativePath)) {
        return $false
    }

    $installedSha = Get-DirectoryTreeSha256OrNull -Root $PackageTarget -RelativePath $relativePath
    return (-not [string]::IsNullOrWhiteSpace($installedSha)) -and
        [string]::Equals($installedSha, $targetSha, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-ManifestComponentUnchanged {
    param(
        [object]$TargetManifest,
        [object]$InstalledManifest,
        [string]$ComponentKey,
        [string]$PackageTarget
    )

    $targetComponent = Get-ComponentByKey -Manifest $TargetManifest -Key $ComponentKey
    $targetSha = Get-ComponentSha256 -Component $targetComponent
    if ([string]::IsNullOrWhiteSpace($targetSha)) {
        return $false
    }

    $installedSha = Get-InstalledComponentSha256 -Key $ComponentKey -TargetComponent $targetComponent -InstalledManifest $InstalledManifest -PackageTarget $PackageTarget
    return (-not [string]::IsNullOrWhiteSpace($installedSha)) -and
        [string]::Equals($installedSha, $targetSha, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-CodexSkillInstallPresent {
    param(
        [string]$InstallRoot,
        [switch]$SkipUserIntegration
    )

    $machineSkillPath = Join-Path $InstallRoot "codex\skills\revAgent"
    if (-not (Test-Path -LiteralPath (Join-Path $machineSkillPath "SKILL.md") -PathType Leaf)) {
        return $false
    }

    if (-not $SkipUserIntegration) {
        $userSkillPath = Join-Path $script:RevAgentOsUserProfile ".codex\skills\revAgent"
        if (-not (Test-Path -LiteralPath $userSkillPath)) {
            return $false
        }
    }

    return $true
}

function Get-InstalledReleaseManifest {
    param(
        [object]$InstalledState,
        [string]$PackageTarget
    )

    if ($InstalledState) {
        $stateComponents = Get-JsonPropertyValue -Object $InstalledState -Name "components"
        if ($stateComponents) {
            return [pscustomobject][ordered]@{
                components = $stateComponents
                updatePolicy = Get-JsonPropertyValue -Object $InstalledState -Name "updatePolicy"
            }
        }

        $manifestPath = [string](Get-JsonPropertyValue -Object $InstalledState -Name "manifestPath")
        if (-not [string]::IsNullOrWhiteSpace($manifestPath) -and (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            try {
                return Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
            }
            catch {
                Write-Warning "Installed release manifest is not valid JSON and will be ignored: $manifestPath"
            }
        }
    }

    $localReleaseInfoPath = Join-Path $PackageTarget "release-info.json"
    if (Test-Path -LiteralPath $localReleaseInfoPath -PathType Leaf) {
        try {
            $localReleaseInfo = Get-Content -Raw -LiteralPath $localReleaseInfoPath | ConvertFrom-Json
            $localComponents = Get-JsonPropertyValue -Object $localReleaseInfo -Name "components"
            if ($localComponents) {
                return [pscustomobject][ordered]@{
                    components = $localComponents
                    updatePolicy = Get-JsonPropertyValue -Object $localReleaseInfo -Name "updatePolicy"
                }
            }
        }
        catch {}
    }

    return $null
}

function Get-InstalledComponentSha256 {
    param(
        [string]$Key,
        [object]$TargetComponent,
        [object]$InstalledManifest,
        [string]$PackageTarget
    )

    $installedComponent = Get-ComponentByKey -Manifest $InstalledManifest -Key $Key
    $installedSha = Get-ComponentSha256 -Component $installedComponent
    if (-not [string]::IsNullOrWhiteSpace($installedSha)) {
        return $installedSha
    }

    $relativePath = Get-ComponentPath -Component $TargetComponent
    $installedSha = Get-RelativeFileSha256OrNull -Root $PackageTarget -RelativePath $relativePath
    if (-not [string]::IsNullOrWhiteSpace($installedSha)) {
        return $installedSha
    }

    return ""
}

function Get-ActualRevitPayloadPathMapping {
    param(
        [string]$RelativePath,
        [string]$InstallRoot,
        [string]$RevitVersion
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        return [pscustomobject][ordered]@{
            isMapped = $false
            shouldCompare = $false
            paths = @()
        }
    }

    $normalizedPath = $RelativePath.Replace("/", "\")

    if ([string]::Equals($normalizedPath, "installer\revit-plugin\revAgent.addin", [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($normalizedPath, "installer\revit-plugin\mcp-servers-for-revit.addin", [System.StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{
            isMapped = $true
            shouldCompare = $false
            paths = @()
        }
    }

    $paths = [System.Collections.Generic.List[string]]::new()
    $pluginPrefix = "installer\revit-plugin\revAgentPlugin\"
    if ($normalizedPath.StartsWith($pluginPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $suffix = $normalizedPath.Substring($pluginPrefix.Length)
        [void]$paths.Add((Join-Path $InstallRoot ("revit-plugin\revAgentPlugin\" + $suffix)))
        return [pscustomobject][ordered]@{
            isMapped = $true
            shouldCompare = $true
            paths = @($paths.ToArray())
        }
    }

    $commandPayloadPrefix = "installer\command-payload\"
    if ($normalizedPath.StartsWith($commandPayloadPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $suffix = $normalizedPath.Substring($commandPayloadPrefix.Length)
        $runtimePrefix = "runtime\$RevitVersion\"
        if ($suffix.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            $runtimeSuffix = $suffix.Substring($runtimePrefix.Length)
            [void]$paths.Add((Join-Path $InstallRoot ("commands\CommandSet\$RevitVersion\" + $runtimeSuffix)))
            [void]$paths.Add((Join-Path $InstallRoot ("revit-plugin\revAgentPlugin\Commands\revAgentCommandSet\$RevitVersion\" + $runtimeSuffix)))
        }
        else {
            [void]$paths.Add((Join-Path $InstallRoot ("commands\CommandSet\$RevitVersion\" + $suffix)))
            [void]$paths.Add((Join-Path $InstallRoot ("commands\CommandSet\" + $suffix)))
            [void]$paths.Add((Join-Path $InstallRoot ("revit-plugin\revAgentPlugin\Commands\revAgentCommandSet\$RevitVersion\" + $suffix)))
            [void]$paths.Add((Join-Path $InstallRoot ("revit-plugin\revAgentPlugin\Commands\revAgentCommandSet\" + $suffix)))
        }

        return [pscustomobject][ordered]@{
            isMapped = $true
            shouldCompare = $true
            paths = @($paths.ToArray())
        }
    }

    return [pscustomobject][ordered]@{
        isMapped = $false
        shouldCompare = $false
        paths = @()
    }
}

function Test-RevitPayloadComponentPath {
    param([string]$RelativePath)

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        return $false
    }

    foreach ($prefix in @(
            "installer\revit-plugin\",
            "installer\command-payload\"
        )) {
        if ($RelativePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

function Get-RevitClosedRequiredKeys {
    param([object]$Manifest)

    $keys = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $policy = Get-JsonPropertyValue -Object $Manifest -Name "updatePolicy"
    $configuredKeys = Get-JsonPropertyValue -Object $policy -Name "revitClosedRequiredComponentKeys"
    foreach ($key in @($configuredKeys)) {
        if ([string]::IsNullOrWhiteSpace([string]$key)) { continue }
        if ($seen.Add([string]$key)) {
            [void]$keys.Add([string]$key)
        }
    }

    if ($keys.Count -eq 0) {
        $components = Get-JsonPropertyValue -Object $Manifest -Name "components"
        if ($components) {
            foreach ($property in $components.PSObject.Properties) {
                $componentPath = Get-ComponentPath -Component $property.Value
                if ((Test-RevitPayloadComponentPath -RelativePath $componentPath) -and $seen.Add($property.Name)) {
                    [void]$keys.Add($property.Name)
                }
            }
        }
    }

    foreach ($fallbackKey in @(
            "revitPlugin",
            "commandSet",
            "revitAddinManifest",
            "revitPluginNewtonsoft",
            "revitPluginSdk",
            "revitCommandRegistry",
            "revitCommandSet",
            "revitCommandSetConfig"
        )) {
        if ($seen.Add($fallbackKey)) {
            [void]$keys.Add($fallbackKey)
        }
    }

    return $keys.ToArray()
}

function Get-RevitPayloadChanges {
    param(
        [object]$TargetManifest,
        [object]$InstalledManifest,
        [string]$PackageTarget,
        [string]$InstallRoot,
        [string]$RevitVersion
    )

    $changes = [System.Collections.Generic.List[object]]::new()
    if ($null -eq $TargetManifest) {
        return $changes.ToArray()
    }

    foreach ($key in Get-RevitClosedRequiredKeys -Manifest $TargetManifest) {
        $targetComponent = Get-ComponentByKey -Manifest $TargetManifest -Key $key
        if ($null -eq $targetComponent) {
            continue
        }

        $targetSha = Get-ComponentSha256 -Component $targetComponent
        if ([string]::IsNullOrWhiteSpace($targetSha)) {
            continue
        }

        $componentPath = Get-ComponentPath -Component $targetComponent
        $actualMapping = Get-ActualRevitPayloadPathMapping -RelativePath $componentPath -InstallRoot $InstallRoot -RevitVersion $RevitVersion
        if ($actualMapping.isMapped) {
            if (-not $actualMapping.shouldCompare) {
                continue
            }

            $mismatchedPaths = [System.Collections.Generic.List[string]]::new()
            foreach ($actualPath in @($actualMapping.paths)) {
                $actualSha = ""
                if (Test-Path -LiteralPath $actualPath -PathType Leaf) {
                    $actualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $actualPath).Hash
                }

                if (-not [string]::Equals($actualSha, $targetSha, [System.StringComparison]::OrdinalIgnoreCase)) {
                    [void]$mismatchedPaths.Add($actualPath)
                }
            }

            if ($mismatchedPaths.Count -eq 0) {
                continue
            }

            [void]$changes.Add([pscustomobject][ordered]@{
                    key = $key
                    path = $componentPath
                    oldSha = "actual mismatch: " + ($mismatchedPaths.ToArray() -join "; ")
                    newSha = $targetSha
                })
            continue
        }

        $installedSha = Get-InstalledComponentSha256 -Key $key -TargetComponent $targetComponent -InstalledManifest $InstalledManifest -PackageTarget $PackageTarget
        if ([string]::Equals($installedSha, $targetSha, [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }

        [void]$changes.Add([pscustomobject][ordered]@{
                key = $key
                path = $componentPath
                oldSha = $installedSha
                newSha = $targetSha
            })
    }

    return $changes.ToArray()
}

function Write-UpdateReport {
    param(
        [string]$Status,
        [string]$Message,
        [object]$Channel,
        [object]$InstalledState,
        [object]$Diagnostics = $null,
        [string]$PreviousVersion = "",
        [string]$InstalledVersion = "",
        [string]$LocalReportPath,
        [string]$RemoteReportsRoot
    )

    $targetReportVersion = if ($Channel) { [string]$Channel.version } else { $null }
    $previousReportVersion = if (-not [string]::IsNullOrWhiteSpace($PreviousVersion)) {
        $PreviousVersion
    }
    elseif ($InstalledState) {
        [string]$InstalledState.version
    }
    else {
        $null
    }
    $installedReportVersion = if (-not [string]::IsNullOrWhiteSpace($InstalledVersion)) {
        $InstalledVersion
    }
    elseif ($InstalledState) {
        [string]$InstalledState.version
    }
    else {
        $null
    }
    $transition = if ($targetReportVersion -and $Status -eq "updated") {
        "{0} -> {1}" -f (Get-VersionLabel $previousReportVersion), $targetReportVersion
    }
    else {
        $null
    }
    $pendingTransition = if ($targetReportVersion -and ($Status -eq "update-available" -or $Status -eq "deferred-revit-close-required")) {
        "{0} -> {1}" -f (Get-VersionLabel $previousReportVersion), $targetReportVersion
    }
    else {
        $null
    }
    $channelGit = if ($Channel) { Get-JsonPropertyValue -Object $Channel -Name "git" } else { $null }
    $installedComponents = if ($InstalledState) { Get-JsonPropertyValue -Object $InstalledState -Name "components" } else { $null }
    $installedComponentCount = 0
    if ($installedComponents -and $installedComponents.PSObject) {
        $installedComponentCount = @($installedComponents.PSObject.Properties).Count
    }
    $installedUpdatePolicy = if ($InstalledState) { Get-JsonPropertyValue -Object $InstalledState -Name "updatePolicy" } else { $null }

    $report = [ordered]@{
        schemaVersion = 1
        app = "revAgent"
        updaterVersion = $updaterVersion
        operation = $script:RevAgentOperation
        operationMethod = $script:RevAgentOperationMethod
        status = $Status
        message = $Message
        distributionIntegrity = $script:RevAgentDistributionIntegrity
        license = $script:RevAgentLicense
        computerName = $env:COMPUTERNAME
        userName = $env:USERNAME
        atUtc = (Get-Date).ToUniversalTime().ToString("o")
        channel = if ($Channel) { $Channel.channel } else { $null }
        previousVersion = $previousReportVersion
        targetVersion = $targetReportVersion
        installedVersion = $installedReportVersion
        versionTransition = $transition
        pendingVersionTransition = $pendingTransition
        release = [ordered]@{
            channel = if ($Channel) { $Channel.channel } else { $null }
            version = $targetReportVersion
            packageSha256 = if ($Channel) { Get-JsonPropertyValue -Object $Channel -Name "sha256" } else { $null }
            packagePath = if ($Channel) { Get-JsonPropertyValue -Object $Channel -Name "packagePath" } else { $null }
            manifestPath = if ($Channel) { Get-JsonPropertyValue -Object $Channel -Name "manifestPath" } else { $null }
            publishedAtUtc = if ($Channel) { Get-JsonPropertyValue -Object $Channel -Name "publishedAtUtc" } else { $null }
            commit = if ($channelGit) { Get-JsonPropertyValue -Object $channelGit -Name "commit" } else { $null }
            isDirty = if ($channelGit) { Get-JsonPropertyValue -Object $channelGit -Name "isDirty" } else { $null }
        }
        localInstall = if ($InstalledState) {
            [ordered]@{
                version = Get-JsonPropertyValue -Object $InstalledState -Name "version"
                installedAtUtc = Get-JsonPropertyValue -Object $InstalledState -Name "installedAtUtc"
                packageSha256 = Get-JsonPropertyValue -Object $InstalledState -Name "packageSha256"
                packagePath = Get-JsonPropertyValue -Object $InstalledState -Name "packagePath"
                manifestPath = Get-JsonPropertyValue -Object $InstalledState -Name "manifestPath"
                componentCount = $installedComponentCount
                updatePolicy = $installedUpdatePolicy
            }
        }
        else {
            $null
        }
        diagnostics = $Diagnostics
        paths = [ordered]@{
            installRoot = $InstallRoot
            packageTarget = $PackageTarget
            serverTarget = $ServerTarget
            workRoot = $WorkRoot
            revitInstallRoot = $RevitInstallRoot
            channelManifestPath = if (-not [string]::IsNullOrWhiteSpace([string]$script:RevAgentAcquisitionChannelManifestPath)) { [string]$script:RevAgentAcquisitionChannelManifestPath } else { $ChannelManifestPath }
            logPath = $script:RevAgentLogPath
        }
    }

    $localReportRoot = Split-Path -Parent $LocalReportPath
    Write-RevAgentJsonFile -Path $LocalReportPath -Value $report -GuardRoot $localReportRoot
    $script:RevAgentLatestReport = $report
    $script:RevAgentRemoteReportsRoot = if ($MachinePhaseOnly) { "" } else { $RemoteReportsRoot }
}

function Publish-RevAgentPendingMachineUpdateReport {
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
        throw "The user phase cannot publish the machine report because ReportsRoot is empty."
    }
    if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) {
        throw "The machine phase did not leave its local update report: $ReportPath"
    }

    $pendingReport = Read-RevAgentJsonReportFile -Path $ReportPath -AllowedRoot $ReportAllowedRoot
    $diagnostics = [ordered]@{}
    $existingDiagnostics = Get-JsonPropertyValue -Object $pendingReport -Name "diagnostics"
    if ($existingDiagnostics) {
        foreach ($property in $existingDiagnostics.PSObject.Properties) {
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
    if (-not $integrationSucceeded) {
        $pendingReport | Add-Member -NotePropertyName status -NotePropertyValue "failed" -Force
    }
    $machineMessage = [string](Get-JsonPropertyValue -Object $pendingReport -Name "message")
    $combinedMessage = if ([string]::IsNullOrWhiteSpace($machineMessage)) { $IntegrationMessage } else { "$machineMessage User integration: $IntegrationMessage" }
    $pendingReport | Add-Member -NotePropertyName message -NotePropertyValue $combinedMessage -Force

    $pendingOperation = [string](Get-JsonPropertyValue -Object $pendingReport -Name "operation")
    if ([string]::IsNullOrWhiteSpace($pendingOperation)) { $pendingOperation = "update" }
    $pendingMethod = [string](Get-JsonPropertyValue -Object $pendingReport -Name "operationMethod")
    $pendingPaths = Get-JsonPropertyValue -Object $pendingReport -Name "paths"
    $pendingLogPath = if ($pendingPaths) { [string](Get-JsonPropertyValue -Object $pendingPaths -Name "logPath") } else { "" }
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
    Write-Host "Machine report   : final user-phase outcome published unelevated." -ForegroundColor Green
    return $published
}

function New-CurrentUpdateDiagnostics {
    $running = @($runningRevit)
    return [ordered]@{
        distributionIntegrity = $script:RevAgentDistributionIntegrity
        license = $script:RevAgentLicense
        allowSignedReleaseRollback = [bool]$AllowSignedReleaseRollback
        codexInstructionPolicy = $CodexInstructionPolicy
        codexInstructionCleanupSkipped = [bool]($SourceFreeMigration -and $preserveLocalCodexInstructions)
        machineRole = $MachineRole
        isFirstInstall = [bool]$isFirstInstall
        revitRunning = ($running.Count -gt 0)
        deferredForRevitClose = if ($runningDecision) { [bool]$runningDecision.DeferForRevitClose } else { $false }
        revitPayloadChanged = [bool]$requiresRevitClosed
        revitPayloadSkipped = [bool]$skipRevitPayloadInstall
        runtimePayloadSkipped = [bool]$skipRuntimePayloadInstall
        docsPayloadWorkSkipped = [bool]$skipDocsPayloadWork
        codexSkillInstallSkipped = [bool]$skipCodexSkillInstallForThisUpdate
        codexMcpRegistrationSkipped = [bool]$skipCodexMcpRegistrationForThisUpdate
        fastPackageOnlyUpdate = [bool]$fastPackageOnlyUpdate
        runSelfContainedInstaller = [bool]$runSelfContainedInstaller
        fastUpdateFallbackUsed = [bool]$fastUpdateFallbackUsed
        fastUpdateFallbackMessage = $fastUpdateFallbackMessage
        revitPayloadChangedComponents = @($revitPayloadChanges | ForEach-Object { [string]$_.key })
        localPackageBackupPolicy = $localPackageBackupPolicyState
        desktopLauncherCleanup = $desktopLauncherCleanupState
        revAgentCleanInstallTransition = $revAgentCleanInstallTransitionState
    }
}

function Get-NotificationState {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Test-ShouldNotifyUser {
    param(
        [string]$StatePath,
        [string]$Key,
        [int]$ThrottleMinutes
    )

    if (-not $NotifyUser) {
        return $false
    }

    $state = Get-NotificationState -Path $StatePath
    if ($null -eq $state) {
        return $true
    }

    $lastKey = [string](Get-JsonPropertyValue -Object $state -Name "key")
    $lastAtUtc = [string](Get-JsonPropertyValue -Object $state -Name "lastAtUtc")
    if (-not [string]::Equals($lastKey, $Key, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    if ([string]::IsNullOrWhiteSpace($lastAtUtc)) {
        return $true
    }

    try {
        $lastAt = [datetime]::Parse($lastAtUtc).ToUniversalTime()
        return (((Get-Date).ToUniversalTime() - $lastAt).TotalMinutes -ge $ThrottleMinutes)
    }
    catch {
        return $true
    }
}

function Show-UserNotification {
    param(
        [string]$Title,
        [string]$Message,
        [string]$Key,
        [string]$Icon = "Information"
    )

    $statePath = Join-Path $WorkRoot "user-state\notification-state.json"
    if (-not (Test-ShouldNotifyUser -StatePath $statePath -Key $Key -ThrottleMinutes $NotificationThrottleMinutes)) {
        return
    }

    $state = [ordered]@{
        schemaVersion = 1
        app = "revAgent"
        key = $Key
        title = $Title
        message = $Message
        lastAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    Write-JsonFile -Path $statePath -Value $state

    try {
        Add-Type -AssemblyName System.Windows.Forms
        $messageBoxIcon = [System.Windows.Forms.MessageBoxIcon]::Information
        if ([string]::Equals($Icon, "Warning", [System.StringComparison]::OrdinalIgnoreCase)) {
            $messageBoxIcon = [System.Windows.Forms.MessageBoxIcon]::Warning
        }
        elseif ([string]::Equals($Icon, "Error", [System.StringComparison]::OrdinalIgnoreCase)) {
            $messageBoxIcon = [System.Windows.Forms.MessageBoxIcon]::Error
        }

        [System.Windows.Forms.MessageBox]::Show(
            $Message,
            $Title,
            [System.Windows.Forms.MessageBoxButtons]::OK,
            $messageBoxIcon) | Out-Null
    }
    catch {
        Write-Warning "Could not show user notification: $($_.Exception.Message)"
    }
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

function Repair-RevAgentScheduledTaskAction {
    param(
        [string]$Name,
        [string[]]$LegacyNames = @("Revit MCP Auto Update"),
        [string]$UpdaterPath,
        [string]$UpdaterConfigPath,
        [string]$DailyAt = "12:00"
    )

    if ([string]::IsNullOrWhiteSpace($UpdaterConfigPath) -or
        [string]::IsNullOrWhiteSpace($UpdaterPath) -or
        -not (Test-Path -LiteralPath $UpdaterConfigPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $UpdaterPath -PathType Leaf)) {
        return
    }

    Repair-RevAgentHiddenScheduledTaskAction -Name $Name -LegacyNames $LegacyNames -UpdaterPath $UpdaterPath -UpdaterConfigPath $UpdaterConfigPath -DailyAt $DailyAt
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
        Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
        return
    }
    catch {
        $copyError = $_.Exception.Message
        if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
            if ($Required) {
                throw
            }
            Write-Warning "Could not refresh optional updater tool '$Destination'. Copy error: $copyError"
            return
        }
        try {
            Remove-Item -LiteralPath $Destination -Force -ErrorAction Stop
            Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
            Write-Warning "Replaced updater tool after removing stale destination ACL: $Destination"
        }
        catch {
            $message = "Could not refresh updater tool '$Destination'. Initial copy error: $copyError; replace error: $($_.Exception.Message)"
            if ($Required) {
                throw $message
            }
            Write-Warning $message
        }
    }
}

function Install-UpdaterToolsFromPackage {
    param(
        [string]$SourceRoot,
        [string]$DestinationRoot,
        [string]$ConfigPath
    )

    if ([string]::IsNullOrWhiteSpace($SourceRoot) -or
        -not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
        return
    }

    New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
    foreach ($toolName in @("update-from-nas.ps1", "show-installed-version.ps1", "install-updater-task.ps1", "migrate-source-free-install.ps1", "Invoke-revAgent-CodexUserIntegration.ps1")) {
        $source = Join-Path $SourceRoot $toolName
        Copy-RevAgentManagedUpdaterToolFile -Source $source -Destination (Join-Path $DestinationRoot $toolName) -Required:($toolName -ne "migrate-source-free-install.ps1")
    }
    $libSource = Join-Path (Split-Path -Parent $SourceRoot) "lib"
    if (Test-Path -LiteralPath $libSource -PathType Container) {
        $libDestination = Join-Path $DestinationRoot "lib"
        if (Test-Path -LiteralPath $libDestination) {
            Remove-Item -LiteralPath $libDestination -Recurse -Force
        }
        Copy-Item -LiteralPath $libSource -Destination $libDestination -Recurse -Force
    }
    $configSource = Join-Path (Split-Path -Parent $SourceRoot) "config"
    if (-not (Test-Path -LiteralPath $configSource -PathType Container)) {
        $configSource = Join-Path (Split-Path -Parent (Split-Path -Parent $SourceRoot)) "config"
    }
    Sync-RevAgentUpdaterConfigDirectory -SourceRoot $configSource -DestinationRoot (Join-Path $DestinationRoot "config")

    $updaterPath = Join-Path $DestinationRoot "update-from-nas.ps1"
    $versionToolPath = Join-Path $DestinationRoot "show-installed-version.ps1"
    if (Test-Path -LiteralPath $updaterPath -PathType Leaf) {
        @(
            "@echo off",
            "%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$updaterPath`" -ConfigPath `"$ConfigPath`" -AuditOnly -NotifyUser -OperationMethod manual-update-audit",
            "echo Machine updates require the protected local revAgent launcher and its scoped UAC machine phase.",
            "pause"
        ) | Set-Content -LiteralPath (Join-Path $DestinationRoot "Update-revAgent-Now.cmd") -Encoding ASCII
    }
    if (Test-Path -LiteralPath $versionToolPath -PathType Leaf) {
        @(
            "@echo off",
            "%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$versionToolPath`" -ConfigPath `"$ConfigPath`"",
            "pause"
        ) | Set-Content -LiteralPath (Join-Path $DestinationRoot "Show-revAgent-Version.cmd") -Encoding ASCII
    }
    foreach ($legacyCommandName in @("Update-Revit-MCP-Now.cmd", "Show-Revit-MCP-Version.cmd")) {
        $legacyCommandPath = Join-Path $DestinationRoot $legacyCommandName
        if (Test-Path -LiteralPath $legacyCommandPath -PathType Leaf) {
            Remove-Item -LiteralPath $legacyCommandPath -Force
            Write-Host "Removed legacy updater helper: $legacyCommandPath"
        }
    }
    foreach ($legacyLauncherPath in @(Get-RevAgentLegacyHiddenUpdaterLauncherPaths -ConfigPath $ConfigPath)) {
        if (Test-Path -LiteralPath $legacyLauncherPath -PathType Leaf) {
            Remove-Item -LiteralPath $legacyLauncherPath -Force
            Write-Host "Removed legacy hidden updater launcher: $legacyLauncherPath"
        }
    }

    Write-Host "Updater tools refreshed: $DestinationRoot"
}

$explicitInstallRoot = $PSBoundParameters.ContainsKey("InstallRoot")
$explicitConfigPath = $PSBoundParameters.ContainsKey("ConfigPath")
$explicitWorkRoot = $PSBoundParameters.ContainsKey("WorkRoot")
$explicitPackageTarget = $PSBoundParameters.ContainsKey("PackageTarget")
$explicitServerTarget = $PSBoundParameters.ContainsKey("ServerTarget")
$explicitLogPath = $PSBoundParameters.ContainsKey("LogPath")

$config = Import-UpdaterConfig -Path $ConfigPath
$taskDailyAt = "12:00"
if ($config) {
    if ([string]::IsNullOrWhiteSpace($ChannelManifestPath) -and $config.channelManifestPath) { $ChannelManifestPath = [string]$config.channelManifestPath }
    if ($config.installRoot) { $InstallRoot = [string]$config.installRoot }
    if ($config.workRoot) { $WorkRoot = [string]$config.workRoot }
    if ($config.packageTarget) { $PackageTarget = [string]$config.packageTarget }
    if ($config.serverTarget) { $ServerTarget = [string]$config.serverTarget }
    if ($config.workspaceAgentsTarget) { $WorkspaceAgentsTarget = [string]$config.workspaceAgentsTarget }
    if ($config.revitInstallRoot) { $RevitInstallRoot = [string]$config.revitInstallRoot }
    if ($config.revitVersion) { $RevitVersion = [string]$config.revitVersion }
    if ($config.proxyUrl) { $ProxyUrl = [string]$config.proxyUrl }
    if ($config.proxyBypass) { $ProxyBypass = [string]$config.proxyBypass }
    if ($config.codexWorkspaceRoot) { $CodexWorkspaceRoot = [string]$config.codexWorkspaceRoot }
    if ($config.taskName) { $TaskName = [string]$config.taskName }
    if ([string]::Equals($TaskName, "Revit MCP Auto Update", [System.StringComparison]::OrdinalIgnoreCase)) {
        $TaskName = "revAgent Auto Update"
    }
    if ($config.dailyAt) { $taskDailyAt = [string]$config.dailyAt }
    if ($config.legacyServerTargets) { $LegacyServerTargets = @($config.legacyServerTargets) }
    if ($config.reportsRoot) { $ReportsRoot = [string]$config.reportsRoot }
    if ($config.skipNpmInstall) { $SkipNpmInstall = $true }
    if ($config.skipCodexMcpRegistration) { $SkipCodexMcpRegistration = $true }
    if ($config.skipCodexUserIntegration) { $SkipCodexUserIntegration = $true }
    if ($config.skipProxySetup) { $SkipProxySetup = $true }
    if ([string]::IsNullOrWhiteSpace($TargetInteractiveUser) -and $config.targetInteractiveUser) { $TargetInteractiveUser = [string]$config.targetInteractiveUser }
    if ([string]::IsNullOrWhiteSpace($TargetInteractiveUserSid) -and $config.targetInteractiveUserSid) { $TargetInteractiveUserSid = [string]$config.targetInteractiveUserSid }
    if ([string]::IsNullOrWhiteSpace($TargetUserProfileRoot) -and $config.targetUserProfileRoot) { $TargetUserProfileRoot = [string]$config.targetUserProfileRoot }
    if ([string]::IsNullOrWhiteSpace($TargetCodexHome) -and $config.targetCodexHome) { $TargetCodexHome = [string]$config.targetCodexHome }
    if ($config.notifyUser -and -not $NoNotifyUser) { $NotifyUser = $true }
    if ($config.notificationThrottleMinutes) { $NotificationThrottleMinutes = [int]$config.notificationThrottleMinutes }
    if ([string]::IsNullOrWhiteSpace($LogPath) -and $config.updateLogPath) { $LogPath = [string]$config.updateLogPath }
}

$CodexInstructionPolicy = Resolve-CodexInstructionPolicy -RequestedPolicy $CodexInstructionPolicy -Config $config
$MachineRole = Resolve-MachineRole -RequestedRole $MachineRole -Config $config
$preserveLocalCodexInstructions = [string]::Equals($CodexInstructionPolicy, "preserve-local", [System.StringComparison]::OrdinalIgnoreCase)

if ($MachinePhaseOnly) {
    $SkipCodexMcpRegistration = $true
    $SkipCodexUserIntegration = $true
    $WorkspaceAgentsTarget = ""
    if ([string]::IsNullOrWhiteSpace($TargetInteractiveUser) -or
        [string]::IsNullOrWhiteSpace($TargetInteractiveUserSid) -or
        [string]::IsNullOrWhiteSpace($TargetUserProfileRoot)) {
        throw "-MachinePhaseOnly requires the original interactive user name, SID, and profile root captured before UAC elevation."
    }
    $interactiveBinding = Resolve-RevAgentInteractiveUserBinding `
        -TargetInteractiveUser $TargetInteractiveUser `
        -TargetInteractiveUserSid $TargetInteractiveUserSid `
        -TargetUserProfileRoot $TargetUserProfileRoot
    $TargetInteractiveUser = [string]$interactiveBinding.UserName
    $TargetInteractiveUserSid = [string]$interactiveBinding.Sid
    $TargetUserProfileRoot = [string]$interactiveBinding.ProfileRoot
}
elseif ($UserPhaseOnly) {
    $SkipCodexMcpRegistration = $false
    $SkipCodexUserIntegration = $false
    $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $currentSid = [string]$currentIdentity.User.Value
    if (-not [string]::IsNullOrWhiteSpace($TargetInteractiveUserSid) -and
        -not [string]::Equals($currentSid, $TargetInteractiveUserSid, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "User phase identity mismatch. Expected SID $TargetInteractiveUserSid but current SID is $currentSid."
    }
    if (-not [string]::IsNullOrWhiteSpace($TargetUserProfileRoot) -and
        -not [string]::Equals(
            [System.IO.Path]::GetFullPath($script:RevAgentOsUserProfile).TrimEnd("\"),
            [System.IO.Path]::GetFullPath($TargetUserProfileRoot).TrimEnd("\"),
            [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "User phase profile mismatch. Expected '$TargetUserProfileRoot' but current profile is '$script:RevAgentOsUserProfile'."
    }
}

if ($NoNotifyUser) {
    $NotifyUser = $false
}

if ([string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
    throw "ChannelManifestPath is required. Pass it directly or through -ConfigPath."
}

$programDataRoot = $script:RevAgentOsCommonAppData
$defaultInstallRoot = Join-Path $programDataRoot "DPE\revAgent"
$legacyInstallRoot = Join-Path $programDataRoot "DPE\RevitMCP"
function Test-RevAgentSamePath {
    param([string]$Left, [string]$Right)

    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        return $false
    }
    try {
        return [string]::Equals([System.IO.Path]::GetFullPath($Left).TrimEnd("\"), [System.IO.Path]::GetFullPath($Right).TrimEnd("\"), [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch {
        return $false
    }
}
function Test-RevAgentPathUnder {
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

function Assert-RevAgentMachinePhasePaths {
    if (-not $MachinePhaseOnly) {
        return
    }

    $programDataFull = [System.IO.Path]::GetFullPath($programDataRoot).TrimEnd("\")
    foreach ($pathEntry in @(
            [pscustomobject]@{ Name = "InstallRoot"; Path = $InstallRoot; Root = $programDataFull },
            [pscustomobject]@{ Name = "WorkRoot"; Path = $WorkRoot; Root = $InstallRoot },
            [pscustomobject]@{ Name = "PackageTarget"; Path = $PackageTarget; Root = $InstallRoot },
            [pscustomobject]@{ Name = "ServerTarget"; Path = $ServerTarget; Root = $InstallRoot },
            [pscustomobject]@{ Name = "ConfigPath"; Path = $ConfigPath; Root = $WorkRoot },
            [pscustomobject]@{ Name = "LogPath"; Path = $LogPath; Root = $WorkRoot },
            [pscustomobject]@{ Name = "PhaseResultPath"; Path = $PhaseResultPath; Root = $WorkRoot }
        )) {
        if ([string]::IsNullOrWhiteSpace([string]$pathEntry.Path)) {
            continue
        }
        if (-not (Test-RevAgentPathUnderRoot -Path ([string]$pathEntry.Path) -Root ([string]$pathEntry.Root))) {
            throw "Machine-only phase path '$($pathEntry.Name)' must remain under '$($pathEntry.Root)': $($pathEntry.Path)"
        }
        [void](Assert-RevAgentPathHasNoReparseComponents -Path ([string]$pathEntry.Path))
    }

    if (-not [string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
        throw "Machine-only phase cannot write WorkspaceAgentsTarget. User integration must run unelevated."
    }
    $machineLogRoot = Join-Path $WorkRoot "machine-logs"
    $machineStateRoot = Join-Path $WorkRoot "machine-state"
    $effectiveMachineLogPath = if (-not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_TRANSCRIPT_ACTIVE) -and
        -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_LOG_PATH)) { $env:REVIT_MCP_LOG_PATH } else { $LogPath }
    if (-not [string]::IsNullOrWhiteSpace($effectiveMachineLogPath) -and
        -not (Test-RevAgentPathUnderRoot -Path $effectiveMachineLogPath -Root $machineLogRoot)) {
        throw "Machine-only LogPath must remain under protected machine-logs: $effectiveMachineLogPath"
    }
    if (-not [string]::IsNullOrWhiteSpace($effectiveMachineLogPath)) {
        [void](Assert-RevAgentPathHasNoReparseComponents -Path $effectiveMachineLogPath)
    }
    if (-not [string]::IsNullOrWhiteSpace($PhaseResultPath) -and
        -not (Test-RevAgentPathUnderRoot -Path $PhaseResultPath -Root $machineStateRoot)) {
        throw "Machine-only PhaseResultPath must remain under protected machine-state: $PhaseResultPath"
    }
    $newMachineFiles = @($PhaseResultPath)
    if ([string]::IsNullOrWhiteSpace($env:REVIT_MCP_TRANSCRIPT_ACTIVE)) {
        $newMachineFiles += $effectiveMachineLogPath
    }
    foreach ($newMachineFile in $newMachineFiles) {
        if (-not [string]::IsNullOrWhiteSpace($newMachineFile) -and (Test-Path -LiteralPath $newMachineFile)) {
            throw "Machine-only output path must be a new file; refusing pre-existing path: $newMachineFile"
        }
    }
}

function Assert-RevAgentUserPhasePaths {
    if (-not $UserPhaseOnly) { return }
    $effectiveUserLogPath = if (-not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_TRANSCRIPT_ACTIVE) -and
        -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_LOG_PATH)) { $env:REVIT_MCP_LOG_PATH } else { $LogPath }
    if (-not [string]::IsNullOrWhiteSpace($effectiveUserLogPath) -and
        -not (Test-RevAgentPathUnderRoot -Path $effectiveUserLogPath -Root (Join-Path $WorkRoot "logs"))) {
        throw "User-phase LogPath must remain under WorkRoot\logs: $effectiveUserLogPath"
    }
    if (-not [string]::IsNullOrWhiteSpace($PhaseResultPath) -and
        -not (Test-RevAgentPathUnderRoot -Path $PhaseResultPath -Root (Join-Path $WorkRoot "user-state"))) {
        throw "User-phase PhaseResultPath must remain under WorkRoot\user-state: $PhaseResultPath"
    }
}

function Write-RevAgentPhaseResult {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][bool]$ContinueUserPhase,
        [string]$Message = "",
        [object]$Details = $null
    )

    if ([string]::IsNullOrWhiteSpace($PhaseResultPath)) {
        return
    }
    if (-not (Test-RevAgentPathUnderRoot -Path $PhaseResultPath -Root $WorkRoot)) {
        throw "Phase result path must remain under WorkRoot: $PhaseResultPath"
    }

    $fullResultPath = [System.IO.Path]::GetFullPath($PhaseResultPath)
    [void](Assert-RevAgentPathHasNoReparseComponents -Path $fullResultPath)
    $resultDirectory = Split-Path -Parent $fullResultPath
    New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
    [void](Assert-RevAgentPathHasNoReparseComponents -Path $resultDirectory)

    $payload = [ordered]@{
        schemaVersion = 1
        phase = $script:RevAgentExecutionPhase
        status = $Status
        continueUserPhase = $ContinueUserPhase
        success = ($Status -in @("completed", "current"))
        message = $Message
        createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        processElevated = (Test-CurrentProcessElevated)
        interactiveUser = $TargetInteractiveUser
        interactiveUserSid = $TargetInteractiveUserSid
        details = $Details
    }
    $json = $payload | ConvertTo-Json -Depth 20
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $bytes = $encoding.GetBytes($json)
    if ($MachinePhaseOnly) {
        Write-RevAgentProtectedMachineBytesCreateNew -Path $fullResultPath -Bytes $bytes
    }
    else {
        $stream = $null
        try {
            $stream = [System.IO.File]::Open($fullResultPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally {
            if ($null -ne $stream) { $stream.Dispose() }
        }
    }
}

$revAgentCanonicalNasRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
$revAgentLegacyNasRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"

function Get-RevAgentAuthenticatedSnapshotReportsRoot {
    if ($null -eq $script:RevAgentExecutionSnapshotState -or
        $null -eq $script:RevAgentExecutionSnapshotState.PSObject.Properties["acquisitionChannelManifestPath"] -or
        [string]::IsNullOrWhiteSpace([string]$script:RevAgentExecutionSnapshotState.acquisitionChannelManifestPath)) {
        throw "User-phase report routing requires acquisitionChannelManifestPath from the authenticated execution snapshot state."
    }

    $snapshotChannel = [string]$script:RevAgentExecutionSnapshotState.release.channel
    if ($snapshotChannel -notin @('stable', 'pilot')) {
        throw "Authenticated snapshot channel is not allowed for report routing: $snapshotChannel"
    }
    $acquisitionChannelPath = [System.IO.Path]::GetFullPath([string]$script:RevAgentExecutionSnapshotState.acquisitionChannelManifestPath)
    $expectedChannelPath = [System.IO.Path]::GetFullPath((Join-Path $revAgentCanonicalNasRoot "channels\$snapshotChannel.json"))
    if (-not [string]::Equals($acquisitionChannelPath, $expectedChannelPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Authenticated snapshot acquisition channel must be the exact canonical state-bound channel. Expected=$expectedChannelPath Actual=$acquisitionChannelPath"
    }
    return [System.IO.Path]::GetFullPath((Join-Path $revAgentCanonicalNasRoot "reports"))
}

function Resolve-RevAgentCanonicalNasTransitionPath {
    param([string]$Path)

    if (-not (Test-RevAgentPathUnder -ChildPath $Path -ParentPath $revAgentLegacyNasRoot)) {
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

$originalChannelManifestPath = $ChannelManifestPath
$ChannelManifestPath = Resolve-RevAgentCanonicalNasTransitionPath -Path $ChannelManifestPath
$channelMovedToCanonicalNasRoot = -not [string]::Equals($originalChannelManifestPath, $ChannelManifestPath, [System.StringComparison]::OrdinalIgnoreCase)
if ($channelMovedToCanonicalNasRoot) {
    Write-Host "Canonical NAS release root detected; updater config will use: $ChannelManifestPath"
}
if ($channelMovedToCanonicalNasRoot -and (Test-RevAgentPathUnder -ChildPath $ReportsRoot -ParentPath $revAgentLegacyNasRoot)) {
    $channelDirForReports = Split-Path -Parent $ChannelManifestPath
    $releaseRootForReports = Split-Path -Parent $channelDirForReports
    $ReportsRoot = Join-Path $releaseRootForReports "reports"
}
if ($MachinePhaseOnly) {
    $ReportsRoot = ""
    $script:RevAgentRemoteReportsRoot = ""
    Write-Host "Machine reports  : local ProgramData handoff only; NAS publication is deferred to the unelevated user phase." -ForegroundColor Green
}
elseif ($UserPhaseOnly -and [string]::IsNullOrWhiteSpace($ReportsRoot)) {
    # ChannelManifestPath is intentionally snapshot-local for both split
    # phases. Remote evidence must route from the authenticated acquisition
    # origin recorded by the broker, never from the execution snapshot tree.
    $ReportsRoot = Get-RevAgentAuthenticatedSnapshotReportsRoot
    $script:RevAgentRemoteReportsRoot = $ReportsRoot
}
elseif ($UserPhaseOnly) {
    $expectedSnapshotReportsRoot = Get-RevAgentAuthenticatedSnapshotReportsRoot
    if (-not [string]::Equals(
            [System.IO.Path]::GetFullPath($ReportsRoot).TrimEnd("\"),
            $expectedSnapshotReportsRoot.TrimEnd("\"),
            [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "User-phase ReportsRoot must match the canonical NAS reports root authenticated by the execution snapshot. Expected=$expectedSnapshotReportsRoot Actual=$ReportsRoot"
    }
    $ReportsRoot = $expectedSnapshotReportsRoot
    $script:RevAgentRemoteReportsRoot = $ReportsRoot
}

if ((-not $explicitInstallRoot) -and (Test-RevAgentSamePath -Left $InstallRoot -Right $legacyInstallRoot)) {
    Write-Host "Legacy install root detected in updater config; migrating to revAgent root: $defaultInstallRoot"
    if (-not ($LegacyServerTargets | Where-Object { Test-RevAgentSamePath -Left $_ -Right (Join-Path $legacyInstallRoot "runtime") })) {
        $LegacyServerTargets += (Join-Path $legacyInstallRoot "runtime")
    }
    $InstallRoot = $defaultInstallRoot
    if ((-not $explicitWorkRoot) -and (Test-RevAgentPathUnder -ChildPath $WorkRoot -ParentPath $legacyInstallRoot)) { $WorkRoot = "" }
    if ((-not $explicitPackageTarget) -and (Test-RevAgentPathUnder -ChildPath $PackageTarget -ParentPath $legacyInstallRoot)) { $PackageTarget = "" }
    if ((-not $explicitServerTarget) -and (Test-RevAgentPathUnder -ChildPath $ServerTarget -ParentPath $legacyInstallRoot)) { $ServerTarget = "" }
    if ((-not $explicitLogPath) -and (Test-RevAgentPathUnder -ChildPath $LogPath -ParentPath $legacyInstallRoot)) { $LogPath = "" }
}
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = $defaultInstallRoot
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
if ([string]::IsNullOrWhiteSpace($ConfigPath) -or
    ((Test-RevAgentPathUnder -ChildPath $ConfigPath -ParentPath $legacyInstallRoot) -and (Test-RevAgentPathUnder -ChildPath $WorkRoot -ParentPath $InstallRoot))) {
    if ($explicitConfigPath -and (Test-RevAgentPathUnder -ChildPath $ConfigPath -ParentPath $legacyInstallRoot)) {
        Write-Host "Legacy updater config path detected; migrated updater commands will use the revAgent config path."
    }
    $ConfigPath = Join-Path $WorkRoot "updater-config.json"
}

$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$WorkRoot = [System.IO.Path]::GetFullPath($WorkRoot)
$PackageTarget = Assert-ManagedDirectoryTarget -Path $PackageTarget -ExpectedLeafNames @("package", "revit-mcp-skill")
$ServerTarget = [System.IO.Path]::GetFullPath($ServerTarget)
$RevitInstallRoot = Resolve-RevitInstallRoot -RequestedRoot $RevitInstallRoot -Version $RevitVersion
if ($MachinePhaseOnly) {
    $canonicalInstallRoot = [System.IO.Path]::GetFullPath((Join-Path $script:RevAgentOsCommonAppData 'DPE\revAgent')).TrimEnd('\')
    $canonicalMachinePaths = @(
        [pscustomobject]@{ Name = 'InstallRoot'; Actual = $InstallRoot; Expected = $canonicalInstallRoot },
        [pscustomobject]@{ Name = 'WorkRoot'; Actual = $WorkRoot; Expected = (Join-Path $canonicalInstallRoot 'updater') },
        [pscustomobject]@{ Name = 'PackageTarget'; Actual = $PackageTarget; Expected = (Join-Path $canonicalInstallRoot 'package') },
        [pscustomobject]@{ Name = 'ServerTarget'; Actual = $ServerTarget; Expected = (Join-Path $canonicalInstallRoot 'runtime') },
        [pscustomobject]@{ Name = 'ConfigPath'; Actual = $ConfigPath; Expected = (Join-Path $canonicalInstallRoot 'updater\updater-config.json') },
        [pscustomobject]@{ Name = 'RevitInstallRoot'; Actual = $RevitInstallRoot; Expected = (Join-Path $script:RevAgentOsProgramFiles ("Autodesk\Revit {0}" -f $RevitVersion)) }
    )
    foreach ($entry in $canonicalMachinePaths) {
        if (-not [string]::Equals([System.IO.Path]::GetFullPath([string]$entry.Actual).TrimEnd('\'), [System.IO.Path]::GetFullPath([string]$entry.Expected).TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Machine-only $($entry.Name) must equal the canonical managed path '$($entry.Expected)'; refusing '$($entry.Actual)'."
        }
    }
    $LegacyServerTargets = @()
}
if ($MachinePhaseOnly -and -not $HostedMachinePhase) {
    # A transcript is process-local. Inherited markers can only suppress the
    # protected machine transcript and therefore are never trusted.
    Remove-Item Env:\REVIT_MCP_TRANSCRIPT_ACTIVE -ErrorAction SilentlyContinue
    Remove-Item Env:\REVIT_MCP_LOG_PATH -ErrorAction SilentlyContinue
}
Assert-RevAgentMachinePhasePaths
Assert-RevAgentUserPhasePaths
$script:RevAgentMachineTreeProtected = $false
$script:RevAgentUserStateGrantCompleted = $false
$interactivePrincipal = ""
trap {
    $originalFailure = $_
    if ($MachinePhaseOnly -and -not $HostedMachinePhase -and $script:RevAgentMachineTreeProtected -and -not $script:RevAgentUserStateGrantCompleted) {
        try {
            [void](Grant-RevAgentUserStateAccess -WorkRoot $WorkRoot -InteractivePrincipal $interactivePrincipal)
            $script:RevAgentUserStateGrantCompleted = $true
        }
        catch {
            throw "Machine phase failed and final user-state access restoration also failed. original=$($originalFailure.Exception.Message) restore=$($_.Exception.Message)"
        }
    }
    throw $originalFailure
}
if ($MachinePhaseOnly) {
    $interactivePrincipal = "*$TargetInteractiveUserSid"
    [void](Protect-RevAgentManagedExecutionTree -InstallRoot $InstallRoot -InteractivePrincipal $interactivePrincipal)
    $script:RevAgentMachineTreeProtected = $true
    Assert-RevAgentMachinePhasePaths
    Write-Host "Machine ACL      : execution tree protected; user-state access remains closed until final handoff." -ForegroundColor Green
}
Initialize-RevAgentTranscript -PreferredWorkRoot $WorkRoot -RequestedLogPath $LogPath -Prefix "update"
$statePath = Join-Path $WorkRoot "installed.json"
$userStateRoot = Join-Path $WorkRoot "user-state"
$machineStateRoot = Join-Path $WorkRoot "machine-state"
$localReportPath = Join-Path $(if ($MachinePhaseOnly) { $machineStateRoot } else { $userStateRoot }) "last-update-report.json"
$machineReportPath = Join-Path $machineStateRoot "last-update-report.json"
if ($MachinePhaseOnly -and -not (Test-Path -LiteralPath $machineStateRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $machineStateRoot -Force | Out-Null
    [void](Assert-RevAgentPathHasNoReparseComponents -Path $machineStateRoot)
}
$cacheRoot = Join-Path $WorkRoot "cache"
$stagingRoot = Join-Path $WorkRoot "staging"
$backupRoot = Join-Path $WorkRoot "backups"
$docsIndexDeferred = $false
$revAgentCleanInstallTransitionMarkerPath = Join-Path $WorkRoot "revagent-clean-install-transition.json"
$revAgentCleanInstallTransitionRequired = $false
$localPackageBackupPolicyState = [ordered]@{
    enabled = $true
    policy = "disabled"
    reason = "Workstation rollback uses signed NAS release archives; local package backups are not retained."
    backupRoot = $backupRoot
    cacheRoot = $cacheRoot
    packageBackupSkipped = $true
    packageRemovedWithoutBackup = $false
    cleanupAtUtc = ""
    removedBackupItemCount = 0
    failedBackupItemCount = 0
    removedCacheItemCount = 0
    failedCacheItemCount = 0
}
$desktopLauncherCleanupState = [ordered]@{
    enabled = $true
    mode = "not-run"
    matchedCount = 0
    removedCount = 0
    failedCount = 0
    matched = @()
    removed = @()
    failed = @()
}
$revAgentCleanInstallTransitionState = [ordered]@{
    enabled = $false
    required = $false
    markerPath = $revAgentCleanInstallTransitionMarkerPath
    backupRoot = $backupRoot
    cacheRoot = $cacheRoot
    packageBackupSkipped = $false
    packageRemovedWithoutBackup = $false
    removedBackupItemCount = 0
    failedBackupItemCount = 0
    removedCacheItemCount = 0
    failedCacheItemCount = 0
}

try {
    if ($MachinePhaseOnly) {
        $desktopLauncherCleanupState.mode = "deferred-to-user-phase"
        Write-Host "Desktop launchers: user-profile cleanup deferred to unelevated user phase."
    }
    elseif ($AuditOnly) {
        $desktopLauncherCleanupState.mode = "skipped-audit-only"
    }
    else {
        $desktopLauncherCleanupState = Invoke-RevAgentLegacyDesktopLauncherCleanup
    }
    if ([int]$desktopLauncherCleanupState.removedCount -gt 0) {
        Write-Host ("Desktop launchers: removed {0} legacy revAgent launcher shortcut(s)." -f $desktopLauncherCleanupState.removedCount) -ForegroundColor Green
    }
    if ([int]$desktopLauncherCleanupState.failedCount -gt 0) {
        Write-Warning ("Desktop launchers: failed to remove {0} legacy revAgent launcher shortcut(s)." -f $desktopLauncherCleanupState.failedCount)
    }
}
catch {
    $desktopLauncherCleanupState = [ordered]@{
        enabled = $true
        mode = "failed"
        matchedCount = 0
        removedCount = 0
        failedCount = 1
        matched = @()
        removed = @()
        failed = @([ordered]@{ path = ""; name = ""; extension = ""; error = $_.Exception.Message })
    }
    Write-Warning "Desktop launcher cleanup failed: $($_.Exception.Message)"
}
if (-not $MachinePhaseOnly) {
    New-Item -ItemType Directory -Path $userStateRoot -Force | Out-Null
}
if (-not $UserPhaseOnly -and -not $AuditOnly) {
    New-Item -ItemType Directory -Path $cacheRoot, $stagingRoot, $backupRoot -Force | Out-Null
}

$taskUpdaterPath = Join-Path $WorkRoot "update-from-nas.ps1"
if (-not (Test-Path -LiteralPath $taskUpdaterPath -PathType Leaf)) {
    $taskUpdaterPath = $PSCommandPath
}

if ($UserPhaseOnly) {
    $integrationResult = $null
    $reportPublishEvidence = $null
    $reportPublishError = ""
    try {
        Initialize-RevAgentWorkstationProxy -ProxyUrl $ProxyUrl -ProxyBypass $ProxyBypass -Skip:$SkipProxySetup
        $docsServerPath = Join-Path $PackageTarget "installer\revit-api-docs-mcp"
        $docsCachePath = Join-Path $InstallRoot ("state\revit-api-docs\cache\revit-api-docs-{0}.json" -f $RevitVersion)
        $installedStateForUserPhase = Read-InstalledState -Path $statePath
        $deferredDocsIndex = $false
        $installedAtUtc = [datetime]::MinValue
        if ($installedStateForUserPhase) {
            $deferredDocsIndex = [bool](Get-JsonPropertyValue -Object $installedStateForUserPhase -Name "docsIndexDeferred")
            [void][datetime]::TryParse([string](Get-JsonPropertyValue -Object $installedStateForUserPhase -Name "installedAtUtc"), [ref]$installedAtUtc)
        }
        $docsIndexNeedsRefresh = $deferredDocsIndex -and (
            -not (Test-Path -LiteralPath $docsCachePath -PathType Leaf) -or
            (Get-Item -LiteralPath $docsCachePath -Force -ErrorAction SilentlyContinue).LastWriteTimeUtc -lt $installedAtUtc.ToUniversalTime())
        if ($docsIndexNeedsRefresh) {
            $docsIndexScript = Join-Path $docsServerPath "scripts\build-index.ps1"
            if (-not (Test-Path -LiteralPath $docsIndexScript -PathType Leaf)) {
                throw "Deferred Revit API index build script is missing: $docsIndexScript"
            }
            $userPowerShellPath = Resolve-RequiredCommand -Name "powershell" -Candidates @(
                (Join-Path $script:RevAgentOsSystemDirectory "WindowsPowerShell\v1.0\powershell.exe")
            )
            Invoke-External -FilePath $userPowerShellPath -Arguments @(
                "-ExecutionPolicy", "Bypass",
                "-File", $docsIndexScript,
                "-RevitRoot", $RevitInstallRoot,
                "-OutputPath", $docsCachePath
            ) -WorkingDirectory $docsServerPath
            Write-Host "Revit API index: deferred machine work completed unelevated before Codex MCP integration." -ForegroundColor Green
        }
        elseif ($deferredDocsIndex) {
            Write-Host "Revit API index: deferred marker satisfied by a current unelevated cache." -ForegroundColor Green
        }
        Ensure-CodexDesktop

        $userIntegrationScript = Join-Path $PackageTarget "installer\nas\Invoke-revAgent-CodexUserIntegration.ps1"
        if (-not (Test-Path -LiteralPath $userIntegrationScript -PathType Leaf)) {
            $userIntegrationScript = Join-Path $PSScriptRoot "Invoke-revAgent-CodexUserIntegration.ps1"
        }
        if (-not (Test-Path -LiteralPath $userIntegrationScript -PathType Leaf)) {
            throw "Unelevated Codex user-integration entrypoint was not found in the installed package or updater tools."
        }

        $targetProfile = if ([string]::IsNullOrWhiteSpace($TargetUserProfileRoot)) { $script:RevAgentOsUserProfile } else { $TargetUserProfileRoot }
        $targetSid = if ([string]::IsNullOrWhiteSpace($TargetInteractiveUserSid)) {
            [string]([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
        }
        else {
            $TargetInteractiveUserSid
        }
        $integrationArgs = @{
            InstallRoot = $InstallRoot
            CodexInstructionPolicy = $CodexInstructionPolicy
            TargetUserProfileRoot = $targetProfile
            TargetUserSid = $targetSid
            RuntimeServerPath = (Join-Path $ServerTarget "build\index.js")
            DocsServerPath = (Join-Path $docsServerPath "build\index.js")
            SkillSourcePath = (Join-Path $InstallRoot "codex\skills\revAgent")
            AgentsSourcePath = (Join-Path $InstallRoot "codex\AGENTS.md")
            PassThru = $true
        }
        if (-not [string]::IsNullOrWhiteSpace($TargetCodexHome)) {
            $integrationArgs["CodexHome"] = $TargetCodexHome
        }

        $integrationOutput = @(& $userIntegrationScript @integrationArgs)
        $integrationResult = $integrationOutput | Where-Object {
            $null -ne $_ -and $null -ne $_.PSObject.Properties["success"]
        } | Select-Object -Last 1
        if ($null -eq $integrationResult -or -not [bool]$integrationResult.success) {
            throw "Codex user integration did not return a successful attestation result."
        }

        $publishedReport = Publish-RevAgentPendingMachineUpdateReport `
            -ReportPath $machineReportPath `
            -ReportAllowedRoot $machineStateRoot `
            -LogAllowedRoot (Join-Path $WorkRoot "machine-logs") `
            -RemoteReportsRoot $ReportsRoot `
            -IntegrationStatus "completed" `
            -IntegrationMessage "Unelevated Codex user integration completed and was attested." `
            -IntegrationDetails $integrationResult
        $reportPublishEvidence = [ordered]@{
            latestPath = [string]$publishedReport.LatestPath
            operationLatestPath = [string]$publishedReport.OperationLatestPath
            compatibilityPath = [string]$publishedReport.CompatibilityPath
            logPath = [string]$publishedReport.LogPath
        }
        Write-RevAgentPhaseResult -Status "completed" -ContinueUserPhase:$false -Message "Unelevated Codex user integration completed and the machine report was published." -Details ([ordered]@{
                integration = $integrationResult
                reportPublished = $true
                reportEvidence = $reportPublishEvidence
            })
        Write-Host "User integration : completed and attested." -ForegroundColor Green
    }
    catch {
        $phaseMessage = $_.Exception.Message
        try {
            $failedPublish = Publish-RevAgentPendingMachineUpdateReport `
                -ReportPath $machineReportPath `
                -ReportAllowedRoot $machineStateRoot `
                -LogAllowedRoot (Join-Path $WorkRoot "machine-logs") `
                -RemoteReportsRoot $ReportsRoot `
                -IntegrationStatus "failed" `
                -IntegrationMessage $phaseMessage `
                -IntegrationDetails $integrationResult
            $reportPublishEvidence = [ordered]@{
                latestPath = [string]$failedPublish.LatestPath
                operationLatestPath = [string]$failedPublish.OperationLatestPath
                compatibilityPath = [string]$failedPublish.CompatibilityPath
                logPath = [string]$failedPublish.LogPath
            }
        }
        catch {
            $reportPublishError = $_.Exception.Message
            $phaseMessage = "$phaseMessage Machine report publication also failed: $reportPublishError"
        }
        try {
            Write-RevAgentPhaseResult -Status "failed" -ContinueUserPhase:$false -Message $phaseMessage -Details ([ordered]@{
                    integration = $integrationResult
                    reportPublished = ($null -ne $reportPublishEvidence)
                    reportEvidence = $reportPublishEvidence
                    reportPublishError = $reportPublishError
                })
        }
        catch {
            Write-Warning "Could not write user-phase result: $($_.Exception.Message)"
        }
        Write-Host "revAgent user integration failed: $phaseMessage" -ForegroundColor Red
        throw
    }
    finally {
        Complete-RevAgentTranscript
    }
    return
}

$channelDir = Split-Path -Parent $ChannelManifestPath
if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
    $releaseRootGuess = Split-Path -Parent $channelDir
    $ReportsRoot = Join-Path $releaseRootGuess "reports"
}
$script:RevAgentRemoteReportsRoot = $ReportsRoot
$installedState = $null
$highestAcceptedReleaseSequence = [long]0
$channel = $null
$persistentUpdaterChannelMutation = $null
$protectedCodexCliProvision = $null

try {
    Initialize-DistributionIntegrityConfig -Config $config
    Initialize-LicenseConfig -Config $config

    $installedState = Get-InstalledState -Path $statePath
    $highestAcceptedReleaseSequence = Get-InstalledHighestAcceptedReleaseSequence -InstalledState $installedState

    if ($SourceFreeMigration -and $AuditOnly) {
        throw "-SourceFreeMigration cannot be combined with -AuditOnly. Use migrate-source-free-install.ps1 -Mode dryRun for inventory-only checks."
    }

    if (-not [bool]$script:RevAgentLicense.success) {
        throw "License verification rejected this run: $($script:RevAgentLicense.reason). $($script:RevAgentLicense.message)"
    }

    if (-not (Test-Path -LiteralPath $ChannelManifestPath)) {
        throw "Channel manifest was not found: $ChannelManifestPath"
    }

    $channel = Get-Content -Raw -LiteralPath $ChannelManifestPath | ConvertFrom-Json
    $appIdentityCommand = Get-UpdaterDistributionIntegrityCommand -Name "Test-RevAgentReleaseAppIdentity" -Required
    if (-not (& $appIdentityCommand -App ([string]$channel.app))) {
        throw "Channel manifest app is not revAgent or revit-mcp-skill: $ChannelManifestPath"
    }
    if ([string]::IsNullOrWhiteSpace($channel.version)) {
        throw "Channel manifest does not contain a version: $ChannelManifestPath"
    }

    $targetVersion = [string]$channel.version
    $targetSha = [string]$channel.sha256
    $packagePath = Resolve-ReleasePath -Path ([string]$channel.packagePath) -BaseDirectory $channelDir
    $releaseManifest = $null
    $releaseManifestPath = Resolve-ReleasePath -Path ([string]$channel.manifestPath) -BaseDirectory $channelDir
    if (-not [string]::IsNullOrWhiteSpace($releaseManifestPath) -and (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf)) {
        $releaseManifest = Get-Content -Raw -LiteralPath $releaseManifestPath | ConvertFrom-Json
    }

    $distributionIntegrityCommand = Get-UpdaterDistributionIntegrityCommand -Name "Test-RevAgentReleaseDistributionIntegrity" -Required

    $distributionIntegrityArgs = @{
        ChannelPath = $ChannelManifestPath
        Channel = $channel
        ReleaseManifestPath = $releaseManifestPath
        ReleaseManifest = $releaseManifest
        TrustedKeys = $script:RevAgentTrustedReleaseKeys
        Policy = $script:RevAgentDistributionIntegrityPolicy
        HighestAcceptedReleaseSequence = $highestAcceptedReleaseSequence
        AllowRollback = $AllowSignedReleaseRollback
    }
    $script:RevAgentDistributionIntegrity = & $distributionIntegrityCommand @distributionIntegrityArgs
    if (-not [bool]$script:RevAgentDistributionIntegrity.success) {
        throw "Distribution integrity check rejected this release: $($script:RevAgentDistributionIntegrity.reason). $($script:RevAgentDistributionIntegrity.message)"
    }
    if ($script:RevAgentDistributionIntegrity.state -eq "legacy-compatible") {
        Write-Warning "Distribution integrity: unsigned legacy release accepted in compatibility mode."
    }
    else {
        Write-Host ("Distribution integrity: {0} ({1})" -f $script:RevAgentDistributionIntegrity.state, $script:RevAgentDistributionIntegrity.reason) -ForegroundColor Green
    }

    $authenticatedChannel = [string]$channel.channel
    if ($authenticatedChannel -notin @('stable', 'pilot')) {
        throw "Authenticated release channel is not allowed: $authenticatedChannel"
    }
    $pilotPolicy = if ($channel.PSObject.Properties['pilotPolicy']) { $channel.pilotPolicy } else { $null }
    if ($authenticatedChannel -eq 'pilot') {
        if ($null -eq $pilotPolicy -or [int]$pilotPolicy.schemaVersion -ne 1) {
            throw 'Authenticated pilot release requires pilotPolicy schemaVersion 1.'
        }
        $machineName = [Environment]::MachineName.Trim().ToUpperInvariant()
        $allowedMachines = @($pilotPolicy.allowedMachineNames | ForEach-Object { ([string]$_).Trim().ToUpperInvariant() })
        if ($allowedMachines.Count -eq 0 -or $allowedMachines -notcontains $machineName) {
            throw "pilot_machine_not_allowed: authenticated pilot release does not authorize this computer: $machineName"
        }
    }
    elseif ($null -ne $pilotPolicy) {
        throw 'Authenticated stable release must not contain pilotPolicy.'
    }

    if ([string]::IsNullOrWhiteSpace($packagePath)) {
        throw "Channel manifest does not contain packagePath: $ChannelManifestPath"
    }
    if (-not (Test-Path -LiteralPath $packagePath)) {
        throw "Package was not found: $packagePath"
    }

    $installedVersion = if ($installedState) { [string]$installedState.version } else { "" }
    $installedSha = if ($installedState) { [string]$installedState.packageSha256 } else { "" }
    $installedVersionLabel = Get-VersionLabel $installedVersion
    $isFirstInstall = [string]::IsNullOrWhiteSpace($installedVersion)
    $revAgentCleanInstallTransitionRequired = Test-RevAgentCleanInstallTransitionRequired `
        -MarkerPath $revAgentCleanInstallTransitionMarkerPath `
        -BackupRoot $backupRoot `
        -PackageTarget $PackageTarget `
        -AuditOnly:$AuditOnly
    if ($revAgentCleanInstallTransitionRequired) {
        $revAgentCleanInstallTransitionState.enabled = $true
        $revAgentCleanInstallTransitionState.required = $true
        $revAgentCleanInstallTransitionState.packageBackupSkipped = $true
    }
    if (-not $AuditOnly) {
        $localPackageBackupPolicyCleanup = Invoke-RevAgentBackupRootReset -BackupRoot $backupRoot -CacheRoot $cacheRoot
        $localPackageBackupPolicyState.cleanupAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        $localPackageBackupPolicyState.removedBackupItemCount = [int]$localPackageBackupPolicyCleanup.removedBackupItemCount
        $localPackageBackupPolicyState.failedBackupItemCount = [int]$localPackageBackupPolicyCleanup.failedBackupItemCount
        $localPackageBackupPolicyState.removedCacheItemCount = [int]$localPackageBackupPolicyCleanup.removedCacheItemCount
        $localPackageBackupPolicyState.failedCacheItemCount = [int]$localPackageBackupPolicyCleanup.failedCacheItemCount
        if ($revAgentCleanInstallTransitionRequired) {
            $revAgentCleanInstallTransitionState.removedBackupItemCount = [int]$localPackageBackupPolicyCleanup.removedBackupItemCount
            $revAgentCleanInstallTransitionState.failedBackupItemCount = [int]$localPackageBackupPolicyCleanup.failedBackupItemCount
            $revAgentCleanInstallTransitionState.removedCacheItemCount = [int]$localPackageBackupPolicyCleanup.removedCacheItemCount
            $revAgentCleanInstallTransitionState.failedCacheItemCount = [int]$localPackageBackupPolicyCleanup.failedCacheItemCount
        }
        if ([int]$localPackageBackupPolicyCleanup.failedBackupItemCount -gt 0 -or
            [int]$localPackageBackupPolicyCleanup.failedCacheItemCount -gt 0) {
            throw "Local package backup/cache cleanup failed. Workstation rollback must use signed NAS release archives, not local package backups."
        }
        if ([int]$localPackageBackupPolicyCleanup.removedBackupItemCount -gt 0 -or
            [int]$localPackageBackupPolicyCleanup.removedCacheItemCount -gt 0) {
            Write-Host ("Local package backups: disabled; removed {0} backup item(s) and {1} cached release ZIP(s)." -f $localPackageBackupPolicyCleanup.removedBackupItemCount, $localPackageBackupPolicyCleanup.removedCacheItemCount) -ForegroundColor Green
        }
    }
    $script:RevAgentOperation = if ($AuditOnly) { "audit" } elseif ($SourceFreeMigration) { "source-free-migration" } elseif ($isFirstInstall) { "install" } elseif ($Force) { "reinstall" } else { "update" }
    if ([string]::IsNullOrWhiteSpace($OperationMethod)) {
        $script:RevAgentOperationMethod = if ($AuditOnly) {
            "audit"
        }
        elseif ($SourceFreeMigration) {
            "source-free-migration"
        }
        elseif ($Force) {
            "force-update"
        }
        elseif ($isFirstInstall) {
            "install"
        }
        elseif ($NotifyUser) {
            "scheduled-update"
        }
        else {
            "update"
        }
    }

    Write-Host "Channel version  : $targetVersion"
    Write-Host "Installed version: $installedVersionLabel"
    Write-Host "Version change   : $installedVersionLabel -> $targetVersion"
    Write-Host "Operation method : $script:RevAgentOperationMethod"
    Write-Host "Package          : $packagePath"
    if ($revAgentCleanInstallTransitionRequired) {
        Write-Host "revAgent transition: clean install mode; local package backups are disabled and rollback uses signed NAS release archives." -ForegroundColor Yellow
    }

    $installedManifest = Get-InstalledReleaseManifest -InstalledState $installedState -PackageTarget $PackageTarget
    $revitPayloadChanges = @(Get-RevitPayloadChanges -TargetManifest $releaseManifest -InstalledManifest $installedManifest -PackageTarget $PackageTarget -InstallRoot $InstallRoot -RevitVersion $RevitVersion)
    $effectiveRevitPayloadChangeCount = if ($SourceFreeMigration -or $revAgentCleanInstallTransitionRequired) {
        [Math]::Max(1, $revitPayloadChanges.Count)
    }
    else {
        $revitPayloadChanges.Count
    }
    $releaseComponents = Get-JsonPropertyValue -Object $releaseManifest -Name "components"
    $updateDecision = Get-RevAgentUpdateDecision `
        -IsFirstInstall:$isFirstInstall `
        -HasReleaseManifest:($null -ne $releaseManifest) `
        -HasReleaseComponents:($null -ne $releaseComponents) `
        -RevitPayloadChangeCount $effectiveRevitPayloadChangeCount
    $requiresRevitClosed = [bool]$updateDecision.RequiresRevitClosed
    $skipRevitPayloadInstall = $false
    $skipRuntimePayloadInstall = $false
    $skipDocsPayloadWork = $false
    $skipCodexSkillInstallForThisUpdate = $false
    $skipCodexMcpRegistrationForThisUpdate = $false
    if ($preserveLocalCodexInstructions) {
        $skipCodexSkillInstallForThisUpdate = $true
        Write-Host "Codex instructions: preserved local developer instruction surface by policy." -ForegroundColor Yellow
    }
    $revitChangeLabels = @($revitPayloadChanges | ForEach-Object {
            if (-not [string]::IsNullOrWhiteSpace([string]$_.path)) {
                [string]$_.path
            }
            else {
                [string]$_.key
            }
        })
    if ($SourceFreeMigration -and $revitChangeLabels.Count -eq 0) {
        $revitChangeLabels = @("source-free migration full Revit payload repair")
    }
    $isPackageCurrent = ($installedVersion -eq $targetVersion -and $installedSha -eq $targetSha)

    if (-not $SourceFreeMigration) {
        $sourceFreeGuardArtifacts = @(Get-RevAgentSourceFreeArtifactInventory `
                -InstallRoot $InstallRoot `
                -PackageTarget $PackageTarget `
                -ServerTarget $ServerTarget `
                -PreserveLocalCodexInstructions:$preserveLocalCodexInstructions `
                -SkipCodexUserIntegration:$SkipCodexUserIntegration)
        if ($sourceFreeGuardArtifacts.Count -gt 0) {
            $sampleArtifacts = @($sourceFreeGuardArtifacts |
                    Select-Object -First 20 |
                    ForEach-Object {
                        [ordered]@{
                            rootLabel = [string]$_.rootLabel
                            rootKind = [string]$_.rootKind
                            kind = [string]$_.kind
                            reason = [string]$_.reason
                            relativePath = [string]$_.relativePath
                            path = [string]$_.path
                        }
                    })
            $message = "Source-free migration is required before normal update. Found $($sourceFreeGuardArtifacts.Count) managed source/developer artifact item(s). Run migrate-source-free-install.ps1 -Mode dryRun first, review the report, then run -Mode commit."
            Write-Warning $message
            Write-UpdateReport `
                -Status "source-free-migration-required" `
                -Message $message `
                -Channel $channel `
                -InstalledState $installedState `
                -Diagnostics ([ordered]@{
                    codexInstructionPolicy = $CodexInstructionPolicy
                    codexInstructionCleanupSkipped = [bool]$preserveLocalCodexInstructions
                    sourceFreeMigrationRequired = $true
                    sourceFreeMigrationArtifactCount = $sourceFreeGuardArtifacts.Count
                    sourceFreeMigrationSampleArtifacts = $sampleArtifacts
                    migrationDryRunCommand = "migrate-source-free-install.ps1 -Mode dryRun"
                    migrationCommitCommand = "migrate-source-free-install.ps1 -Mode commit"
                }) `
                -PreviousVersion $installedVersion `
                -InstalledVersion $installedVersion `
                -LocalReportPath $localReportPath `
                -RemoteReportsRoot $ReportsRoot
            Show-UserNotification -Title "revAgent migration required" -Message $message -Key ("source-free-migration-required|{0}" -f $targetVersion) -Icon "Warning"
            Write-RevAgentPhaseResult -Status "blocked" -ContinueUserPhase:$false -Message $message
            return
        }
    }

    if ((-not $AuditOnly) -and (-not $SkipCodexUserIntegration)) {
        Remove-CodexProfileBackupArtifacts
        [void](Set-CodexMemoryConfig)
    }

    if (-not $MachinePhaseOnly -and -not $Force -and -not $SourceFreeMigration -and -not $revAgentCleanInstallTransitionRequired -and $isPackageCurrent -and -not $requiresRevitClosed) {
        $message = "Already up to date."
        Write-Host $message -ForegroundColor Green
        Write-UpdateReport -Status "current" -Message $message -Channel $channel -InstalledState $installedState -Diagnostics (New-CurrentUpdateDiagnostics) -PreviousVersion $installedVersion -InstalledVersion $installedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        Write-RevAgentPhaseResult -Status "current" -ContinueUserPhase:$true -Message $message
        return
    }
    elseif ($isPackageCurrent -and $revitPayloadChanges.Count -gt 0) {
        Write-Warning "Package version is current, but installed Revit add-in/command files do not match the package. A Revit payload repair is required."
    }

    if ($AuditOnly) {
        $message = if ($isPackageCurrent -and $revitPayloadChanges.Count -gt 0) {
            "Revit payload repair required for current version: $targetVersion"
        }
        else {
            "Update available: $installedVersionLabel -> $targetVersion"
        }
        Write-Host $message -ForegroundColor Yellow
        Write-UpdateReport -Status "update-available" -Message $message -Channel $channel -InstalledState $installedState -Diagnostics (New-CurrentUpdateDiagnostics) -PreviousVersion $installedVersion -InstalledVersion $installedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        Show-UserNotification -Title "revAgent update available" -Message $message -Key ("update-available|{0}" -f $targetVersion) -Icon "Information"
        Write-RevAgentPhaseResult -Status "audit" -ContinueUserPhase:$false -Message $message
        return
    }

    if ($requiresRevitClosed) {
        $revitPayloadReason = if ($isFirstInstall) { "first install" } else { "changed or unknown" }
        Write-Host "Revit payload    : $revitPayloadReason; Revit must be closed before applying this update." -ForegroundColor Yellow
        if ($revitChangeLabels.Count -gt 0) {
            Write-Host ("Changed Revit files: {0}" -f (($revitChangeLabels | Select-Object -First 8) -join "; "))
            if ($revitChangeLabels.Count -gt 8) {
                Write-Host ("Changed Revit files: +{0} more" -f ($revitChangeLabels.Count - 8))
            }
        }
    }
    else {
        $skipRevitPayloadInstall = [bool]$updateDecision.SkipRevitPayloadInstall
        Write-Host "Revit payload    : unchanged; existing Revit files will be left untouched." -ForegroundColor Green
    }
    if ($SourceFreeMigration) {
        $skipRevitPayloadInstall = $false
        if ($preserveLocalCodexInstructions) {
            Write-Host "Source migration : full managed Revit/runtime repair forced; Codex instructions preserved by policy." -ForegroundColor Yellow
        }
        else {
            Write-Host "Source migration : full managed Revit/runtime/Codex payload repair forced." -ForegroundColor Yellow
        }
    }
    elseif ($revAgentCleanInstallTransitionRequired) {
        $skipRevitPayloadInstall = $false
        $skipRuntimePayloadInstall = $false
        $skipDocsPayloadWork = $false
        if (-not $preserveLocalCodexInstructions) {
            $skipCodexSkillInstallForThisUpdate = $false
        }
        $skipCodexMcpRegistrationForThisUpdate = $false
        if ($preserveLocalCodexInstructions) {
            Write-Host "revAgent transition: full managed Revit/runtime repair forced; Codex instructions preserved by policy." -ForegroundColor Yellow
        }
        else {
            Write-Host "revAgent transition: full managed Revit/runtime/Codex payload repair forced." -ForegroundColor Yellow
        }
    }

    $runningRevit = Get-Process -Name "Revit" -ErrorAction SilentlyContinue
    $runningDecision = Get-RevAgentUpdateDecision `
        -IsFirstInstall:$isFirstInstall `
        -HasReleaseManifest:($null -ne $releaseManifest) `
        -HasReleaseComponents:($null -ne $releaseComponents) `
        -RevitPayloadChangeCount $effectiveRevitPayloadChangeCount `
        -IsRevitRunning:($null -ne $runningRevit)
    if ($runningDecision.DeferForRevitClose) {
        $message = "Update requires Revit to be closed because Revit add-in/command files changed. Save and synchronize your model, close Revit, then run the updater again."
        if ($revitChangeLabels.Count -gt 0) {
            $message += " Changed files: " + (($revitChangeLabels | Select-Object -First 6) -join "; ")
            if ($revitChangeLabels.Count -gt 6) {
                $message += ("; +{0} more" -f ($revitChangeLabels.Count - 6))
            }
        }
        Write-Warning $message
        Write-UpdateReport -Status "deferred-revit-close-required" -Message $message -Channel $channel -InstalledState $installedState -Diagnostics (New-CurrentUpdateDiagnostics) -PreviousVersion $installedVersion -InstalledVersion $installedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        Show-UserNotification -Title "revAgent update requires Revit to close" -Message $message -Key ("deferred-revit-close-required|{0}" -f $targetVersion) -Icon "Warning"
        Write-RevAgentPhaseResult -Status "blocked" -ContinueUserPhase:$false -Message $message
        return
    }
    elseif ($runningDecision.SkipRevitPayloadInstall) {
        $skipRevitPayloadInstall = [bool]$runningDecision.SkipRevitPayloadInstall
        if ($runningRevit) {
            Write-Warning "Revit is running, but this update does not change Revit add-in/command files. Non-Revit files will be updated without touching the active Revit payload."
        }
    }

    Initialize-RevAgentWorkstationProxy -ProxyUrl $ProxyUrl -ProxyBypass $ProxyBypass -Skip:$SkipProxySetup
    $nodeRuntimeStatus = Ensure-UpdateDependencies -SkipNpmInstall:$SkipNpmInstall -SkipCodexMcpRegistration:$SkipCodexMcpRegistration

    if ((Test-Path -LiteralPath (Join-Path $PackageTarget ".git")) -and -not $AllowReplaceGitPackageTarget) {
        throw "PackageTarget is a git working tree. Refusing to replace it without -AllowReplaceGitPackageTarget: $PackageTarget"
    }

    $cachedPackage = Join-Path $cacheRoot ("revit-mcp-skill-{0}.zip" -f $targetVersion)
    Copy-Item -LiteralPath $packagePath -Destination $cachedPackage -Force

    $actualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $cachedPackage).Hash
    if (-not [string]::IsNullOrWhiteSpace($targetSha) -and $actualSha -ne $targetSha) {
        throw "Package hash mismatch. Expected $targetSha but got $actualSha"
    }

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $extractRoot = Join-Path $stagingRoot ("extract-" + $targetVersion + "-" + $stamp)
    Expand-ReleaseArchive -ZipPath $cachedPackage -DestinationPath $extractRoot

    $packageLayout = Resolve-PackageLayout -Root $extractRoot -ReleaseManifest $releaseManifest

    if ($SourceFreeMigration) {
        if ($preserveLocalCodexInstructions) {
            Write-Host "Source migration : runtime, docs, and MCP registration refresh forced; Codex instructions preserved by policy." -ForegroundColor Yellow
        }
        else {
            Write-Host "Source migration : runtime, docs, Codex skill, and MCP registration refresh forced." -ForegroundColor Yellow
        }
    }
    elseif ($revAgentCleanInstallTransitionRequired) {
        if ($preserveLocalCodexInstructions) {
            Write-Host "revAgent transition: runtime, docs, and MCP registration refresh forced; Codex instructions preserved by policy." -ForegroundColor Yellow
        }
        else {
            Write-Host "revAgent transition: runtime, docs, Codex skill, and MCP registration refresh forced." -ForegroundColor Yellow
        }
    }
    else {
        if (Test-DirectoryPayloadUnchanged -Manifest $releaseManifest -ComponentKey "runtimePayload" -PackageTarget $PackageTarget) {
            $skipRuntimePayloadInstall = $true
            Write-Host "Runtime payload  : unchanged; existing runtime files will be left untouched." -ForegroundColor Green
        }
        if (Test-DirectoryPayloadUnchanged -Manifest $releaseManifest -ComponentKey "docsServerPayload" -PackageTarget $PackageTarget) {
            $skipDocsPayloadWork = $true
            Write-Host "Docs payload     : unchanged; docs dependency/index refresh will be skipped." -ForegroundColor Green
        }
        if ((Test-ManifestComponentUnchanged -TargetManifest $releaseManifest -InstalledManifest $installedManifest -ComponentKey "skill" -PackageTarget $PackageTarget) -and
            (Test-ManifestComponentUnchanged -TargetManifest $releaseManifest -InstalledManifest $installedManifest -ComponentKey "agents" -PackageTarget $PackageTarget) -and
            (Test-CodexSkillInstallPresent -InstallRoot $InstallRoot -SkipUserIntegration:$SkipCodexUserIntegration)) {
            $skipCodexSkillInstallForThisUpdate = $true
            Write-Host "Codex skill      : unchanged; existing skill integration will be left untouched." -ForegroundColor Green
        }
        if ($skipRuntimePayloadInstall -and $skipDocsPayloadWork) {
            $skipCodexMcpRegistrationForThisUpdate = $true
            Write-Host "Codex MCP config : unchanged entry points; registration refresh will be skipped." -ForegroundColor Green
        }
    }

    if ($MachinePhaseOnly) {
        # Installed execution/dependency surfaces were writable before the ACL
        # lockdown. Rehydrate them from the freshly hash-verified release.
        $skipRuntimePayloadInstall = $false
        $skipDocsPayloadWork = $false
        $skipCodexMcpRegistrationForThisUpdate = $true
        if (-not $preserveLocalCodexInstructions) {
            $skipCodexSkillInstallForThisUpdate = $false
        }
        Write-Host "Machine repair   : runtime/docs sources forced from verified release payload." -ForegroundColor Yellow
    }

    $sourceFreeMigrationPreCleanup = $null
    $sourceFreeMigrationPostCleanup = $null
    if ($SourceFreeMigration) {
        $sourceFreeMigrationPreCleanup = Invoke-RevAgentSourceFreeArtifactCleanup `
            -InstallRoot $InstallRoot `
            -PackageTarget $PackageTarget `
            -ServerTarget $ServerTarget `
            -UserProfileRoot $(if ([string]::IsNullOrWhiteSpace($TargetUserProfileRoot)) { $script:RevAgentOsUserProfile } else { $TargetUserProfileRoot }) `
            -PreserveLocalCodexInstructions:$preserveLocalCodexInstructions `
            -SkipCodexUserIntegration:$SkipCodexUserIntegration `
            -Commit
        Write-Host ("Source cleanup  : removed {0} pre-install source/developer artifact item(s); {1} failed." -f $sourceFreeMigrationPreCleanup.removedCount, $sourceFreeMigrationPreCleanup.failedCount) -ForegroundColor Yellow
        if ([int]$sourceFreeMigrationPreCleanup.failedCount -gt 0) {
            throw "Source-free migration cleanup failed before package replacement. Failed items: $($sourceFreeMigrationPreCleanup.failedCount)"
        }
    }

    if (Test-Path -LiteralPath $PackageTarget) {
        Remove-Item -LiteralPath $PackageTarget -Recurse -Force -ErrorAction Stop
        $localPackageBackupPolicyState.packageRemovedWithoutBackup = $true
        if ($revAgentCleanInstallTransitionRequired) {
            $revAgentCleanInstallTransitionState.packageRemovedWithoutBackup = $true
        }
        Write-Host "Local package backups: removed existing managed package without creating a local backup." -ForegroundColor Yellow
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $PackageTarget) -Force | Out-Null
    Move-Item -LiteralPath $extractRoot -Destination $PackageTarget

    $installer = Join-Path $PackageTarget $packageLayout.installerRelativePath
    $docsServerPath = Join-Path $PackageTarget $packageLayout.docsServerRelativePath
    $docsCachePath = Join-Path $InstallRoot ("state\revit-api-docs\cache\revit-api-docs-{0}.json" -f $RevitVersion)
    if ($MachinePhaseOnly -and -not ($skipDocsPayloadWork -and (Test-Path -LiteralPath $docsCachePath -PathType Leaf))) {
        $docsIndexDeferred = $true
        if ($SkipNpmInstall) {
            Write-Host "Revit API index: deferred to the unelevated user phase; elevated writes to InstallRoot\state are prohibited." -ForegroundColor Yellow
        }
    }
    $npmDependencyCacheRoot = Join-Path $InstallRoot "dependencies\npm"
    $fastPackageOnlyUpdate = $skipRevitPayloadInstall -and
        $skipRuntimePayloadInstall -and
        $skipDocsPayloadWork -and
        $skipCodexSkillInstallForThisUpdate -and
        $skipCodexMcpRegistrationForThisUpdate
    $fastUpdateFallbackUsed = $false
    $fastUpdateFallbackMessage = ""
    $runSelfContainedInstaller = (-not $fastPackageOnlyUpdate)

    if ($fastPackageOnlyUpdate) {
        try {
            Write-Host "Fast update path : package/updater metadata only; self-contained installer skipped." -ForegroundColor Green
            $nasToolsSource = Join-Path (Split-Path -Parent $installer) "nas"
            Install-UpdaterToolsFromPackage -SourceRoot $nasToolsSource -DestinationRoot $WorkRoot -ConfigPath $ConfigPath
            $retentionLogsRoot = Join-Path $WorkRoot $(if ($MachinePhaseOnly) { "machine-logs" } else { "logs" })
            Invoke-RevAgentLogRetention -LogsRoot $retentionLogsRoot -KeepLast 10 -ActiveLogPath $env:REVIT_MCP_LOG_PATH
            if ($SkipNpmInstall) {
                Write-Host "Runtime dependencies: skipped by -SkipNpmInstall."
                Write-Host "Documentation server dependencies: skipped by -SkipNpmInstall."
            }
            else {
                $nodePath = [string]$nodeRuntimeStatus.nodePath
                $npmCliPath = [string]$nodeRuntimeStatus.npmCliPath
                if ($MachinePhaseOnly) {
                    Invoke-NpmInstallMachinePhaseClean -NodePath $nodePath -NpmCliPath $npmCliPath -WorkingDirectory $ServerTarget -Label "Runtime"
                    Invoke-NpmInstallMachinePhaseClean -NodePath $nodePath -NpmCliPath $npmCliPath -WorkingDirectory $docsServerPath -Label "Documentation server"
                }
                else {
                    Invoke-NpmInstallIfNeeded -NodePath $nodePath -NpmCliPath $npmCliPath -WorkingDirectory $ServerTarget -Label "Runtime" -CacheRoot $npmDependencyCacheRoot
                    Invoke-NpmInstallIfNeeded -NodePath $nodePath -NpmCliPath $npmCliPath -WorkingDirectory $docsServerPath -Label "Documentation server" -CacheRoot $npmDependencyCacheRoot
                }
            }
            Write-Host "Revit API index: skipped; docs payload unchanged."
            Write-Host "Codex MCP registration: skipped; runtime/docs entry points unchanged."
        }
        catch {
            $fastUpdateFallbackUsed = $true
            $fastUpdateFallbackMessage = $_.Exception.Message
            $runSelfContainedInstaller = $true
            Write-Warning "Fast update path failed; falling back to the full repair/install path. $fastUpdateFallbackMessage"
        }
    }
    if ($runSelfContainedInstaller) {
        $installArgs = @{
            RevitVersion = $RevitVersion
            InstallRoot = $InstallRoot
            ServerTarget = $ServerTarget
            RevitInstallRoot = $RevitInstallRoot
            CodexInstructionPolicy = $CodexInstructionPolicy
        }
        if (-not [string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
            $installArgs["WorkspaceAgentsTarget"] = $WorkspaceAgentsTarget
        }
        if (-not $MachinePhaseOnly -and $LegacyServerTargets.Count -gt 0) {
            $installArgs["LegacyServerTargets"] = $LegacyServerTargets
        }
        if ($SkipCodexUserIntegration) {
            $installArgs["SkipCodexUserIntegration"] = $true
        }
        if ($MachinePhaseOnly) {
            $installerCommand = Get-Command -Name $installer -CommandType ExternalScript -ErrorAction Stop
            if ($null -eq $installerCommand.Parameters["SkipUserProfileCleanup"]) {
                throw "Installed self-contained installer does not support the secure machine-only boundary (-SkipUserProfileCleanup)."
            }
            $installArgs["SkipUserProfileCleanup"] = $true
            $installArgs["SkipLegacyCleanup"] = $true
        }
        if ($skipCodexSkillInstallForThisUpdate) {
            $installArgs["SkipCodexSkillInstall"] = $true
        }
        $installArgs["SuppressNextSteps"] = $true
        if ($skipRevitPayloadInstall) {
            $installArgs["SkipRevitPayloadInstall"] = $true
        }
        if ($skipRuntimePayloadInstall) {
            $installArgs["SkipRuntimePayloadInstall"] = $true
        }

        & $installer @installArgs

        if (-not $SkipNpmInstall) {
            $nodePath = [string]$nodeRuntimeStatus.nodePath
            $npmCliPath = [string]$nodeRuntimeStatus.npmCliPath
            $powershellPath = Resolve-RequiredCommand -Name "powershell" -Candidates @(
                (Join-Path $script:RevAgentOsSystemDirectory "WindowsPowerShell\v1.0\powershell.exe")
            )

            if ($skipRuntimePayloadInstall) {
                Write-Host "Runtime payload unchanged; validating installed dependencies against the selected Node runtime."
            }
            if ($MachinePhaseOnly) {
                Invoke-NpmInstallMachinePhaseClean -NodePath $nodePath -NpmCliPath $npmCliPath -WorkingDirectory $ServerTarget -Label "Runtime"
            }
            else {
                Invoke-NpmInstallIfNeeded -NodePath $nodePath -NpmCliPath $npmCliPath -WorkingDirectory $ServerTarget -Label "Runtime" -CacheRoot $npmDependencyCacheRoot
            }

            if ($MachinePhaseOnly) {
                Invoke-NpmInstallMachinePhaseClean -NodePath $nodePath -NpmCliPath $npmCliPath -WorkingDirectory $docsServerPath -Label "Documentation server"
            }
            else {
                Invoke-NpmInstallIfNeeded -NodePath $nodePath -NpmCliPath $npmCliPath -WorkingDirectory $docsServerPath -Label "Documentation server" -CacheRoot $npmDependencyCacheRoot
            }
            if ($MachinePhaseOnly) {
                if ($skipDocsPayloadWork -and (Test-Path -LiteralPath $docsCachePath -PathType Leaf)) {
                    Write-Host "Revit API index: skipped; docs payload unchanged."
                }
                else {
                    $docsIndexDeferred = $true
                    Write-Host "Revit API index: deferred to the unelevated user phase before Codex MCP integration; elevated writes to InstallRoot\state are prohibited." -ForegroundColor Yellow
                }
            }
            elseif ($skipDocsPayloadWork -and (Test-Path -LiteralPath $docsCachePath -PathType Leaf)) {
                Write-Host "Revit API index: skipped; docs payload unchanged."
            }
            else {
                Invoke-External -FilePath $powershellPath -Arguments @(
                    "-ExecutionPolicy", "Bypass",
                    "-File", (Join-Path $docsServerPath "scripts\build-index.ps1"),
                    "-RevitRoot", $RevitInstallRoot,
                    "-OutputPath", $docsCachePath
                ) -WorkingDirectory $docsServerPath
            }
        }

        if ((-not $SkipCodexMcpRegistration) -and $skipCodexMcpRegistrationForThisUpdate) {
            Write-Host "Codex MCP registration: skipped; runtime/docs entry points unchanged."
        }
        elseif (-not $SkipCodexMcpRegistration) {
            if ($MachinePhaseOnly) {
                throw "Codex MCP registration cannot run in the elevated machine phase; it must be completed by the authenticated unelevated user-integration phase."
            }
            Ensure-CodexDesktop
            $nodePath = [string]$nodeRuntimeStatus.nodePath
            $runtimeServerPath = Join-Path $ServerTarget "build\index.js"
            $docsServerEntryPath = Join-Path $docsServerPath "build\index.js"
            Write-Host "Codex MCP registration: updating the authenticated user's config.toml without executing a mutable LocalAppData CLI mirror."
            Register-CodexMcpServersInConfig -NodePath $nodePath -RuntimeServerPath $runtimeServerPath -DocsServerPath $docsServerEntryPath
        }
    }

    if ($SourceFreeMigration) {
        $sourceFreeMigrationPostCleanup = Invoke-RevAgentSourceFreeArtifactCleanup `
            -InstallRoot $InstallRoot `
            -PackageTarget $PackageTarget `
            -ServerTarget $ServerTarget `
            -UserProfileRoot $(if ([string]::IsNullOrWhiteSpace($TargetUserProfileRoot)) { $script:RevAgentOsUserProfile } else { $TargetUserProfileRoot }) `
            -PreserveLocalCodexInstructions:$preserveLocalCodexInstructions `
            -SkipCodexUserIntegration:$SkipCodexUserIntegration `
            -Commit
        Write-Host ("Source verify   : remaining managed source/developer artifact item(s): {0}; cleanup failures: {1}" -f $sourceFreeMigrationPostCleanup.remainingCount, $sourceFreeMigrationPostCleanup.failedCount) -ForegroundColor Yellow
        if ([int]$sourceFreeMigrationPostCleanup.failedCount -gt 0 -or [int]$sourceFreeMigrationPostCleanup.remainingCount -gt 0) {
            throw "Source-free migration verification failed. Remaining: $($sourceFreeMigrationPostCleanup.remainingCount); failed cleanup: $($sourceFreeMigrationPostCleanup.failedCount)"
        }
    }

    $sourceFreeMigrationState = if ($SourceFreeMigration) {
        [ordered]@{
            enabled = $true
            codexInstructionPolicy = $CodexInstructionPolicy
            codexInstructionCleanupSkipped = [bool]$preserveLocalCodexInstructions
            preCleanupArtifactCount = if ($sourceFreeMigrationPreCleanup) { [int]$sourceFreeMigrationPreCleanup.artifactCount } else { 0 }
            preCleanupRemovedCount = if ($sourceFreeMigrationPreCleanup) { [int]$sourceFreeMigrationPreCleanup.removedCount } else { 0 }
            preCleanupFailedCount = if ($sourceFreeMigrationPreCleanup) { [int]$sourceFreeMigrationPreCleanup.failedCount } else { 0 }
            postCleanupArtifactCount = if ($sourceFreeMigrationPostCleanup) { [int]$sourceFreeMigrationPostCleanup.artifactCount } else { 0 }
            postCleanupRemovedCount = if ($sourceFreeMigrationPostCleanup) { [int]$sourceFreeMigrationPostCleanup.removedCount } else { 0 }
            postCleanupFailedCount = if ($sourceFreeMigrationPostCleanup) { [int]$sourceFreeMigrationPostCleanup.failedCount } else { 0 }
            postCleanupRemainingCount = if ($sourceFreeMigrationPostCleanup) { [int]$sourceFreeMigrationPostCleanup.remainingCount } else { 0 }
        }
    }
    else {
        $null
    }

    if ($MachinePhaseOnly) {
        # Provision from the authenticated Store package into the protected
        # machine tree before any successful state/report is committed. The
        # protected CodexRegistration module copies WindowsApps bytes without
        # executing them and fails closed for a missing/foreign target SID.
        $protectedCodexCliProvision = Install-RevAgentProtectedCodexCliFromStore `
            -InstallRoot $InstallRoot `
            -TargetUserSid $TargetInteractiveUserSid
    }

    $integrityReleaseSequence = ConvertTo-Int64OrZero -Value $script:RevAgentDistributionIntegrity.releaseSequence
    $integrityMinimumAcceptedReleaseSequence = ConvertTo-Int64OrZero -Value $script:RevAgentDistributionIntegrity.minimumAcceptedReleaseSequence
    $integrityHighestAcceptedReleaseSequence = [Math]::Max(
        $highestAcceptedReleaseSequence,
        (ConvertTo-Int64OrZero -Value $script:RevAgentDistributionIntegrity.highestAcceptedReleaseSequence))
    $hasAcceptedSignedRelease = $integrityHighestAcceptedReleaseSequence -gt 0 -or
        [string]::Equals([string]$script:RevAgentDistributionIntegrity.state, "verified", [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals([string]$script:RevAgentDistributionIntegrity.state, "rollback-allowed", [System.StringComparison]::OrdinalIgnoreCase)

    if ($revAgentCleanInstallTransitionRequired) {
        $revAgentCleanInstallTransitionState.appliedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        $revAgentCleanInstallTransitionState.previousVersion = $installedVersion
        $revAgentCleanInstallTransitionState.installedVersion = $targetVersion
        $revAgentCleanInstallTransitionState.packageTarget = $PackageTarget
    }

    $newState = [ordered]@{
        schemaVersion = 1
        app = "revAgent"
        version = $targetVersion
        channel = $channel.channel
        installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        packageSha256 = $actualSha
        packagePath = $packagePath
        manifestPath = $channel.manifestPath
        components = if ($releaseManifest) { $releaseManifest.components } else { $null }
        updatePolicy = if ($releaseManifest) { $releaseManifest.updatePolicy } else { $null }
        revitPayloadChanged = [bool]$requiresRevitClosed
        revitPayloadSkipped = [bool]$skipRevitPayloadInstall
        runtimePayloadSkipped = [bool]$skipRuntimePayloadInstall
        docsPayloadWorkSkipped = [bool]$skipDocsPayloadWork
        docsIndexDeferred = [bool]$docsIndexDeferred
        codexSkillInstallSkipped = [bool]$skipCodexSkillInstallForThisUpdate
        codexMcpRegistrationSkipped = [bool]$skipCodexMcpRegistrationForThisUpdate
        fastPackageOnlyUpdate = [bool]$fastPackageOnlyUpdate
        fastUpdateFallbackUsed = [bool]$fastUpdateFallbackUsed
        fastUpdateFallbackMessage = $fastUpdateFallbackMessage
        revitPayloadChangedComponents = @($revitPayloadChanges | ForEach-Object { [string]$_.key })
        distributionIntegrity = $script:RevAgentDistributionIntegrity
        releaseSequence = $integrityReleaseSequence
        minimumAcceptedReleaseSequence = $integrityMinimumAcceptedReleaseSequence
        highestAcceptedReleaseSequence = $integrityHighestAcceptedReleaseSequence
        hasAcceptedSignedRelease = [bool]$hasAcceptedSignedRelease
        signedReleaseRollbackAllowed = [bool]$script:RevAgentDistributionIntegrity.rollbackAllowed
        license = $script:RevAgentLicense
        sourceFreeMigration = $sourceFreeMigrationState
        localPackageBackupPolicy = $localPackageBackupPolicyState
        revAgentCleanInstallTransition = $revAgentCleanInstallTransitionState
        updaterVersion = $updaterVersion
        codexInstructionPolicy = $CodexInstructionPolicy
        protectedCodexCli = $protectedCodexCliProvision
        machineRole = $MachineRole
        skipCodexUserIntegration = [bool]$SkipCodexUserIntegration
        paths = [ordered]@{
            installRoot = $InstallRoot
            packageTarget = $PackageTarget
            serverTarget = $ServerTarget
            workRoot = $WorkRoot
            revitInstallRoot = $RevitInstallRoot
            channelManifestPath = if (-not [string]::IsNullOrWhiteSpace([string]$script:RevAgentAcquisitionChannelManifestPath)) { [string]$script:RevAgentAcquisitionChannelManifestPath } else { $ChannelManifestPath }
        }
    }
    $updateMessage = "Updated: $installedVersionLabel -> $targetVersion."
    if ($fastUpdateFallbackUsed) {
        $updateMessage += " Fast update path failed; full repair/install path completed."
    }
    Write-JsonFile -Path $statePath -Value $newState
    if ($revAgentCleanInstallTransitionRequired) {
        Write-JsonFile -Path $revAgentCleanInstallTransitionMarkerPath -Value $revAgentCleanInstallTransitionState
    }
    Write-UpdateReport -Status "updated" -Message $updateMessage -Channel $channel -InstalledState $newState -Diagnostics (New-CurrentUpdateDiagnostics) -PreviousVersion $installedVersion -InstalledVersion $targetVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
    Write-Host $updateMessage -ForegroundColor Green
    if ($MachinePhaseOnly) {
        $persistentUpdaterConfig = $config
        if ($null -eq $persistentUpdaterConfig) { $persistentUpdaterConfig = Import-UpdaterConfig -Path $ConfigPath }
        if ($null -eq $persistentUpdaterConfig) { throw "Updater config file was not loaded: $ConfigPath" }
        $persistentUpdaterChannelMutation = Set-RevAgentPersistentUpdaterChannel `
            -Path $ConfigPath `
            -Config $persistentUpdaterConfig `
            -PersistentChannelManifestPath ([string]$script:RevAgentExecutionSnapshotState.acquisitionChannelManifestPath)
        $config = $persistentUpdaterConfig
    }
    Show-UserNotification -Title "revAgent updated" -Message ($updateMessage + "`r`n`r`nInstalled version: " + $targetVersion) -Key ("updated|{0}" -f $targetVersion) -Icon "Information"
    Write-RevAgentPhaseResult -Status "completed" -ContinueUserPhase:$true -Message $updateMessage -Details ([ordered]@{
        previousVersion = $installedVersion
        installedVersion = $targetVersion
        packageSha256 = $actualSha
    })
}
catch {
    $message = $_.Exception.Message
    if ($null -ne $persistentUpdaterChannelMutation) {
        try {
            Restore-RevAgentPersistentUpdaterChannel -Mutation $persistentUpdaterChannelMutation
            $persistentUpdaterChannelMutation = $null
        }
        catch {
            $message = "$message Updater channel config rollback failed: $($_.Exception.Message)"
        }
    }
    $failedVersion = if ($installedState) { [string]$installedState.version } else { "" }
    Write-UpdateReport -Status "failed" -Message $message -Channel $channel -InstalledState $installedState -Diagnostics (New-CurrentUpdateDiagnostics) -PreviousVersion $failedVersion -InstalledVersion $failedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
    Write-Host ""
    Write-Host "revAgent update failed: $message" -ForegroundColor Red
    if (-not [string]::IsNullOrWhiteSpace($script:RevAgentLogPath)) {
        Write-Host "Update log: $script:RevAgentLogPath" -ForegroundColor Yellow
    }
    try {
        Write-RevAgentPhaseResult -Status "failed" -ContinueUserPhase:$false -Message $message
    }
    catch {
        Write-Warning "Could not write machine-phase result: $($_.Exception.Message)"
    }
    throw
}
finally {
    Complete-RevAgentTranscript
    if ($MachinePhaseOnly -and -not $HostedMachinePhase -and $script:RevAgentMachineTreeProtected -and -not $script:RevAgentUserStateGrantCompleted) {
        [void](Grant-RevAgentUserStateAccess -WorkRoot $WorkRoot -InteractivePrincipal $interactivePrincipal)
        $script:RevAgentUserStateGrantCompleted = $true
        Write-Host "User-state ACL   : restored after elevated traversal completed." -ForegroundColor Green
    }
    if ($null -ne $script:RevAgentSecureMachineTempContext) {
        Complete-RevAgentSecureMachineTemp -Context $script:RevAgentSecureMachineTempContext
    }
}
