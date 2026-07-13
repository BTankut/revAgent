<#
.SYNOPSIS
    Protected local trust anchor for launching the revAgent update GUI.
#>

[CmdletBinding()]
param(
    [string]$ChannelManifestPath = "",
    [string]$BootstrapRoot = "",
    [switch]$VerificationOnly,
    [switch]$RuntimePathSmokeTest,
    [switch]$AllowTestRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$systemDirectory = [Environment]::SystemDirectory
$trustedModuleRoots = @(
    (Join-Path $PSHOME "Modules"),
    (Join-Path $systemDirectory "WindowsPowerShell\v1.0\Modules")
) | Where-Object { [IO.Directory]::Exists($_) } | Select-Object -Unique
if (@($trustedModuleRoots).Count -eq 0) { throw "No trusted PowerShell module root was found for local bootstrap." }
$env:PSModulePath = [string]::Join([IO.Path]::PathSeparator, [string[]]$trustedModuleRoots)
foreach ($moduleName in @("Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Security")) {
    $manifest = Join-Path $PSHOME ("Modules\{0}\{0}.psd1" -f $moduleName)
    if (-not [IO.File]::Exists($manifest)) { throw "Required trusted PowerShell module was not found: $manifest" }
    Microsoft.PowerShell.Core\Import-Module -Name $manifest -Force -ErrorAction Stop
}

$programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$canonicalBootstrapRoot = Join-Path $programData "DPE\revAgent\bootstrap"
if ($RuntimePathSmokeTest) {
    $runtimePowerShell = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"
    if (-not [IO.File]::Exists($runtimePowerShell)) { throw "Trusted Windows PowerShell runtime was not found: $runtimePowerShell" }
    [pscustomobject]@{ success = $true; powershellPath = $runtimePowerShell }
    return
}
if ([string]::IsNullOrWhiteSpace($BootstrapRoot)) { $BootstrapRoot = $canonicalBootstrapRoot }
$BootstrapRoot = [IO.Path]::GetFullPath($BootstrapRoot).TrimEnd("\")
if (-not $AllowTestRoot -and -not [string]::Equals($BootstrapRoot, [IO.Path]::GetFullPath($canonicalBootstrapRoot).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Local bootstrap must run from the canonical protected root: $canonicalBootstrapRoot"
}
$expectedEntrypoint = Join-Path $BootstrapRoot "Start-revAgent-Update.ps1"
if (-not [string]::Equals([IO.Path]::GetFullPath($PSCommandPath), [IO.Path]::GetFullPath($expectedEntrypoint), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Local bootstrap entrypoint mismatch. Expected=$expectedEntrypoint Actual=$PSCommandPath"
}

function Test-RevAgentBootstrapPathUnderRoot {
    param([string]$Path, [string]$Root)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd("\")
    return [string]::Equals($fullPath.TrimEnd("\"), $fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + "\", [StringComparison]::OrdinalIgnoreCase)
}

function Assert-RevAgentBootstrapPathSafe {
    param([string]$Path, [string]$Root, [switch]$RequireReadOnly)
    if (-not (Test-RevAgentBootstrapPathUnderRoot -Path $Path -Root $Root)) { throw "Bootstrap path escaped its root: $Path" }
    $cursor = [IO.Path]::GetFullPath($Path)
    while (Test-RevAgentBootstrapPathUnderRoot -Path $cursor -Root $Root) {
        if (-not (Test-Path -LiteralPath $cursor)) { throw "Bootstrap path is missing: $cursor" }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
            throw "Bootstrap path contains a filesystem link: $cursor"
        }
        if ($RequireReadOnly -and -not $item.PSIsContainer) {
            $fsutil = Join-Path ([Environment]::SystemDirectory) "fsutil.exe"
            $linkOutput = @(& $fsutil hardlink list $item.FullName 2>&1)
            if ($LASTEXITCODE -ne 0 -or @($linkOutput | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -ne 1) {
                throw "Protected local bootstrap file must have exactly one hardlink reference: $($item.FullName)"
            }
        }
        if ($RequireReadOnly) {
            $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
            $acl = Get-Acl -LiteralPath $cursor -ErrorAction Stop
            $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
            if (-not $AllowTestRoot -and $ownerSid -notin @("S-1-5-18", "S-1-5-32-544")) { throw "Protected local bootstrap owner must be SYSTEM or Administrators. path=$cursor owner=$ownerSid" }
            if (-not $acl.AreAccessRulesProtected) {
                throw "Protected local bootstrap DACL must be protected from inheritance: $cursor"
            }
            $trustedWriterSids = @("S-1-5-18", "S-1-5-32-544")
            foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
                if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                    $trustedWriterSids -notcontains [string]$rule.IdentityReference.Value -and
                    (($rule.FileSystemRights -band $writeMask) -ne 0)) {
                    throw "Protected local bootstrap grants write-capable access to an untrusted principal. path=$cursor principal=$($rule.IdentityReference.Value) rights=$($rule.FileSystemRights)"
                }
            }
        }
        if ([string]::Equals($cursor.TrimEnd("\"), [IO.Path]::GetFullPath($Root).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }
}

function Assert-RevAgentFileEffectivelyReadOnly {
    param([string]$Path, [string]$Label)
    $probes = @(
        [pscustomobject]@{ mode = [IO.FileMode]::Open; modeName = "FileMode.Open" },
        [pscustomobject]@{ mode = [IO.FileMode]::Append; modeName = "FileMode.Append" }
    )
    foreach ($probe in $probes) {
        $stream = $null
        $accessDenied = $false
        try { $stream = [IO.File]::Open($Path, $probe.mode, [IO.FileAccess]::Write, [IO.FileShare]::Read) }
        catch {
            $exception = $_.Exception
            while ($null -ne $exception) {
                if ($exception -is [UnauthorizedAccessException] -or (([int]$exception.HResult -band 0xFFFF) -eq 5)) {
                    $accessDenied = $true
                    break
                }
                $exception = $exception.InnerException
            }
            if (-not $accessDenied) {
                throw "$Label effective file-write probe failed unexpectedly through $($probe.modeName)/FileAccess.Write: $($_.Exception.Message)"
            }
        }
        finally { if ($null -ne $stream) { $stream.Dispose() } }
        if (-not $accessDenied) {
            throw "$Label is effectively writable through $($probe.modeName)/FileAccess.Write: $Path"
        }
    }
}

function Assert-RevAgentDirectoryEffectivelyReadOnly {
    param([string]$Directory, [string]$Label)
    $probe = Join-Path $Directory (".revagent-bootstrap-probe-{0}.tmp" -f [Guid]::NewGuid().ToString("N"))
    $stream = $null
    try {
        $stream = [IO.File]::Open($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    }
    catch {
        $exception = $_.Exception
        while ($null -ne $exception) {
            if ($exception -is [UnauthorizedAccessException] -or (([int]$exception.HResult -band 0xFFFF) -eq 5)) { return }
            $exception = $exception.InnerException
        }
        throw "$Label effective read-only probe failed unexpectedly: $($_.Exception.Message)"
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    [IO.File]::Delete($probe)
    if (Test-Path -LiteralPath $probe) { throw "$Label writable probe cleanup failed: $probe" }
    throw "$Label is effectively writable; CreateNew succeeded: $Directory"
}

$statePath = Join-Path $BootstrapRoot "bootstrap-state.json"
[void](Assert-RevAgentBootstrapPathSafe -Path $statePath -Root $BootstrapRoot -RequireReadOnly)
Assert-RevAgentDirectoryEffectivelyReadOnly -Directory $BootstrapRoot -Label "Protected local bootstrap"
Assert-RevAgentFileEffectivelyReadOnly -Path $statePath -Label "Protected local bootstrap state"
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
if ([int]$state.schemaVersion -ne 1 -or -not [bool]$state.sourceAuthentication.independentlyAuthenticated -or -not [bool]$state.sourceAuthentication.operatorConfirmed) {
    throw "Local bootstrap state does not prove independently authenticated administrator prestage."
}
if (-not [string]::Equals([IO.Path]::GetFullPath([string]$state.bootstrapRoot).TrimEnd("\"), $BootstrapRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Local bootstrap state root mismatch."
}

foreach ($property in $state.files.PSObject.Properties) {
    $filePath = Join-Path $BootstrapRoot ([string]$property.Value.relativePath)
    [void](Assert-RevAgentBootstrapPathSafe -Path $filePath -Root $BootstrapRoot -RequireReadOnly)
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $filePath).Hash
    if (-not [string]::Equals($actualHash, [string]$property.Value.sha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Protected local bootstrap hash mismatch: $($property.Name)"
    }
    Assert-RevAgentFileEffectivelyReadOnly -Path $filePath -Label "Protected local bootstrap file"
}

$localIntegrityModule = Join-Path $BootstrapRoot ([string]$state.files.distributionIntegrity.relativePath)
$pinnedIntegrityModuleHash = "2360CC209EAAD6AEF26E90F6865427914CDE499F0F6F8838296D5F5381F371B4"
if (-not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $localIntegrityModule).Hash, $pinnedIntegrityModuleHash, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Protected local distribution-integrity verifier does not match the bootstrap pin."
}
$localTrustedKeysPath = Join-Path $BootstrapRoot ([string]$state.files.trustedKeys.relativePath)
$trustedKeyDocument = Get-Content -Raw -LiteralPath $localTrustedKeysPath | ConvertFrom-Json
$trustedKey = $trustedKeyDocument.trustedKeys."revagent-prod-rsa-2026q3"
if ($null -eq $trustedKey) { throw "Protected local trusted-key set does not contain the production release key." }
$normalizedPublicKey = ([string]$trustedKey.publicKeyXml).Trim() -replace "\s+", ""
$sha = [Security.Cryptography.SHA256]::Create()
try { $fingerprint = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedPublicKey)))).Replace("-", "") } finally { $sha.Dispose() }
if ($fingerprint -ne "32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33") { throw "Protected local production release-key fingerprint mismatch." }

if ([string]::IsNullOrWhiteSpace($ChannelManifestPath)) { $ChannelManifestPath = Join-Path ([string]$state.releaseRoot) "channels\stable.json" }
$ChannelManifestPath = [IO.Path]::GetFullPath($ChannelManifestPath)
$channelRoot = Split-Path -Parent $ChannelManifestPath
$releaseRoot = [IO.Path]::GetFullPath((Split-Path -Parent $channelRoot)).TrimEnd("\")
if (-not $AllowTestRoot -and -not [string]::Equals($releaseRoot, "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Protected bootstrap requires the canonical NAS release root; refusing '$releaseRoot'."
}
if (-not [string]::Equals($releaseRoot, [IO.Path]::GetFullPath([string]$state.releaseRoot).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Bootstrap state release root does not match the requested channel."
}
$toolsRoot = Join-Path $releaseRoot "tools"

[void](Assert-RevAgentBootstrapPathSafe -Path $ChannelManifestPath -Root $releaseRoot)
$channel = Get-Content -Raw -LiteralPath $ChannelManifestPath | ConvertFrom-Json
$releaseManifestPath = [string]$channel.manifestPath
if (-not [IO.Path]::IsPathRooted($releaseManifestPath)) { $releaseManifestPath = Join-Path $channelRoot $releaseManifestPath }
$releaseManifestPath = [IO.Path]::GetFullPath($releaseManifestPath)
[void](Assert-RevAgentBootstrapPathSafe -Path $releaseManifestPath -Root $releaseRoot)
$releaseManifest = Get-Content -Raw -LiteralPath $releaseManifestPath | ConvertFrom-Json

$surfaceMap = [ordered]@{
    localBootstrap = @("installer\nas\Start-revAgent-Update.ps1", "Start-revAgent-Update.ps1")
    updaterGui = @("installer\nas\Install-revAgent-Updater-GUI.ps1", "Install-revAgent-Updater-GUI.ps1")
    updater = @("installer\nas\update-from-nas.ps1", "update-from-nas.ps1")
    updaterTaskInstaller = @("installer\nas\install-updater-task.ps1", "install-updater-task.ps1")
    installerLibDistributionIntegrity = @("installer\lib\RevAgent.DistributionIntegrity.psm1", "lib\RevAgent.DistributionIntegrity.psm1")
    installerLibSourceFreeMigration = @("installer\lib\RevAgent.SourceFreeMigration.psm1", "lib\RevAgent.SourceFreeMigration.psm1")
    installerLibLocalBootstrap = @("installer\lib\RevAgent.LocalBootstrap.psm1", "lib\RevAgent.LocalBootstrap.psm1")
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
    installerLibLicense = @("installer\lib\RevAgent.License.psm1", "lib\RevAgent.License.psm1")
}

$localCurrentReleaseBindings = [ordered]@{
    bootstrap = "localBootstrap"
    launcher = "localBootstrapLauncher"
    updaterGui = "updaterGui"
    distributionIntegrity = "installerLibDistributionIntegrity"
    sourceFreeMigration = "installerLibSourceFreeMigration"
}
foreach ($binding in $localCurrentReleaseBindings.GetEnumerator()) {
    $localHash = [string]$state.files.($binding.Key).sha256
    $currentComponent = $releaseManifest.components.($binding.Value)
    if ($null -eq $currentComponent -or -not [string]::Equals($localHash, [string]$currentComponent.sha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "bootstrap_refresh_required: protected local '$($binding.Key)' does not match current signed component '$($binding.Value)'. Administrator/coordinator prestage is required before this release can run."
    }
}

foreach ($path in @($ChannelManifestPath, $releaseManifestPath)) {
    [void](Assert-RevAgentBootstrapPathSafe -Path $path -Root $releaseRoot)
}
foreach ($surface in $surfaceMap.GetEnumerator()) {
    $component = $releaseManifest.components.($surface.Key)
    if ($null -eq $component -or -not [string]::Equals(([string]$component.path).Replace("/", "\"), [string]$surface.Value[0], [StringComparison]::OrdinalIgnoreCase)) {
        throw "Signed release is missing protected bootstrap component '$($surface.Key)'."
    }
    $sourcePath = Join-Path $toolsRoot ([string]$surface.Value[1])
    [void](Assert-RevAgentBootstrapPathSafe -Path $sourcePath -Root $releaseRoot)
    if (-not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash, [string]$component.sha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Signed bootstrap surface hash mismatch: $($surface.Key)"
    }
}
foreach ($directory in @($releaseRoot, $toolsRoot, $channelRoot, (Split-Path -Parent $releaseManifestPath))) {
    Assert-RevAgentDirectoryEffectivelyReadOnly -Directory $directory -Label "Canonical signed release source"
}

$integrityModule = Import-Module $localIntegrityModule -Force -PassThru
$integrityCommand = Get-Command ("{0}\Test-RevAgentReleaseDistributionIntegrity" -f $integrityModule.Name) -ErrorAction Stop
$integrity = & $integrityCommand -ChannelPath $ChannelManifestPath -Channel $channel -ReleaseManifestPath $releaseManifestPath -ReleaseManifest $releaseManifest -TrustedKeys $trustedKeyDocument.trustedKeys -Policy enforce
if (-not [bool]$integrity.success) { throw "Protected bootstrap rejected the signed release: $($integrity.reason). $($integrity.message)" }
foreach ($path in @($ChannelManifestPath, $releaseManifestPath) + @($surfaceMap.GetEnumerator() | ForEach-Object { Join-Path $toolsRoot ([string]$_.Value[1]) })) {
    [void](Assert-RevAgentBootstrapPathSafe -Path $path -Root $releaseRoot)
}

$result = [pscustomobject][ordered]@{
    success = $true
    action = "local-protected-update-bootstrap"
    bootstrapRoot = $BootstrapRoot
    bootstrapStatePath = $statePath
    channelManifestPath = $ChannelManifestPath
    releaseManifestPath = $releaseManifestPath
    verifiedSurfaceCount = $surfaceMap.Count
    sourceAuthentication = $state.sourceAuthentication
    distributionIntegrity = $integrity
}
if ($VerificationOnly) { $result; return }

$guiPath = Join-Path $BootstrapRoot ([string]$state.files.updaterGui.relativePath)
$powershellPath = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"
$arguments = @("-STA", "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $guiPath, "-ChannelManifestPath", $ChannelManifestPath, "-BootstrapStatePath", $statePath)
$psi = [Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $powershellPath
$psi.Arguments = ($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join " "
$psi.UseShellExecute = $true
[Diagnostics.Process]::Start($psi) | Out-Null
$result
