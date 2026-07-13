<#
.SYNOPSIS
    Simple GUI for installing or updating the revAgent standard user package.
#>

[CmdletBinding()]
param(
    [string]$ChannelManifestPath = "",
    [string]$InstallRoot = "",
    [string]$BootstrapStatePath = "",
    [switch]$SmokeTest,
    [switch]$ModulePathSecuritySmokeTest
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$osSystemDirectory = [Environment]::SystemDirectory
$osProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$osProgramFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)

function Initialize-GuiTrustedPowerShellModules {
    # The RunAs child inherits this process environment. Sanitize it here and
    # require each child entrypoint to repeat the same bootstrap independently.
    $candidateRoots = [System.Collections.Generic.List[string]]::new()
    [void]$candidateRoots.Add([System.IO.Path]::Combine($PSHOME, 'Modules'))
    [void]$candidateRoots.Add([System.IO.Path]::Combine($osSystemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules'))
    foreach ($programFilesRoot in @($osProgramFiles, $osProgramFilesX86)) {
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
    $scheduledTasksManifest = [System.IO.Path]::Combine($osSystemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules', 'ScheduledTasks', 'ScheduledTasks.psd1')
    if (-not [System.IO.File]::Exists($scheduledTasksManifest)) { throw "Required ScheduledTasks module manifest was not found: $scheduledTasksManifest" }
    Microsoft.PowerShell.Core\Import-Module -Name $scheduledTasksManifest -Force -ErrorAction Stop
    return $env:PSModulePath
}

$script:RevAgentTrustedPowerShellModulePath = Initialize-GuiTrustedPowerShellModules
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

# Refuse an elevated or copied GUI before reading bootstrap-selected paths or
# importing any local product module. The supported launcher always starts the
# GUI as the original unelevated user from the protected ProgramData bootstrap;
# only the later machine child crosses UAC.
$earlyGuiIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$earlyGuiPrincipal = [System.Security.Principal.WindowsPrincipal]::new($earlyGuiIdentity)
if ($earlyGuiPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "The revAgent updater GUI refuses elevated execution before local bootstrap module import. Start revAgent Updater STABLE.cmd normally."
}
if (-not $SmokeTest) {
    $earlyGuiProgramData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    if ([string]::IsNullOrWhiteSpace($earlyGuiProgramData)) { throw "Windows CommonApplicationData could not be resolved before GUI module import." }
    $earlyCanonicalGuiPath = [System.IO.Path]::GetFullPath((Join-Path $earlyGuiProgramData "DPE\revAgent\bootstrap\Install-revAgent-Updater-GUI.ps1"))
    $earlyActualGuiPath = [System.IO.Path]::GetFullPath($PSCommandPath)
    if (-not [string]::Equals($earlyActualGuiPath, $earlyCanonicalGuiPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Updater GUI must run from the protected local bootstrap before module import. expected=$earlyCanonicalGuiPath actual=$earlyActualGuiPath"
    }
}

$powershellPath = Join-Path $osSystemDirectory "WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) {
    throw "Canonical Windows PowerShell host was not found: $powershellPath"
}
$powershellSignature = Get-AuthenticodeSignature -LiteralPath $powershellPath
$expectedPowerShellSigner = "CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"
if ($powershellSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    -not [string]::Equals([string]$powershellSignature.SignerCertificate.Subject, $expectedPowerShellSigner, [System.StringComparison]::Ordinal)) {
    throw "Canonical Windows PowerShell host signature is not trusted: $powershellPath"
}
if ([string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
    if ($SmokeTest) { $ChannelManifestPath = Join-Path (Split-Path -Parent $scriptDir) "channels\stable.json" }
    else { throw "The protected local GUI requires an explicit signed ChannelManifestPath from Start-revAgent-Update.ps1." }
}
$channelDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($ChannelManifestPath))
$releaseRoot = if ($SmokeTest) { Split-Path -Parent $scriptDir } else { [IO.Path]::GetFullPath((Split-Path -Parent $channelDirectory)).TrimEnd("\") }
$releaseToolsRoot = if ($SmokeTest) { $scriptDir } else { Join-Path $releaseRoot "tools" }
$installerPath = Join-Path $releaseToolsRoot "install-updater-task.ps1"

$programDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
if ([string]::IsNullOrWhiteSpace($programDataRoot)) { throw "Windows CommonApplicationData could not be resolved." }
$canonicalInstallRoot = Join-Path $programDataRoot "DPE\revAgent"
$legacyInstallRoot = Join-Path $programDataRoot "DPE\RevitMCP"
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = $canonicalInstallRoot
}
elseif (-not [string]::Equals([System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\'), [System.IO.Path]::GetFullPath($canonicalInstallRoot).TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "InstallRoot must be the canonical revAgent machine root: $canonicalInstallRoot"
}
$InstallRoot = [System.IO.Path]::GetFullPath($canonicalInstallRoot)

$workRoot = Join-Path $InstallRoot "updater"
$packageTarget = Join-Path $InstallRoot "package"
$serverTarget = Join-Path $InstallRoot "runtime"
$configPath = Join-Path $workRoot "updater-config.json"
$legacyConfigPath = Join-Path $legacyInstallRoot "updater\updater-config.json"
$localVersionTool = Join-Path $workRoot "show-installed-version.ps1"
$nasLibRoot = Join-Path $releaseToolsRoot "lib"
if ([string]::IsNullOrWhiteSpace($nasLibRoot)) {
    throw "revAgent updater lib folder was not found beside or above: $scriptDir"
}
if (-not $SmokeTest) {
    if ([string]::IsNullOrWhiteSpace($BootstrapStatePath)) { throw "Protected local GUI requires BootstrapStatePath." }
    $expectedBootstrapStatePath = Join-Path $scriptDir "bootstrap-state.json"
    if (-not [string]::Equals([IO.Path]::GetFullPath($BootstrapStatePath), [IO.Path]::GetFullPath($expectedBootstrapStatePath), [StringComparison]::OrdinalIgnoreCase)) {
        throw "BootstrapStatePath must be the protected state beside the local GUI: $expectedBootstrapStatePath"
    }
    $script:GuiBootstrapState = Get-Content -Raw -LiteralPath $BootstrapStatePath | ConvertFrom-Json
    if (-not [bool]$script:GuiBootstrapState.sourceAuthentication.independentlyAuthenticated -or -not [bool]$script:GuiBootstrapState.sourceAuthentication.operatorConfirmed) {
        throw "Local GUI bootstrap state does not prove independently authenticated prestage."
    }
    foreach ($role in @("updaterGui", "sourceFreeMigration")) {
        $evidence = $script:GuiBootstrapState.files.$role
        $localPath = Join-Path $scriptDir ([string]$evidence.relativePath)
        if (-not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $localPath).Hash, [string]$evidence.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Protected local GUI bootstrap hash mismatch: $role"
        }
    }
    $localSourceFreeMigrationModule = Join-Path $scriptDir ([string]$script:GuiBootstrapState.files.sourceFreeMigration.relativePath)
    Import-Module $localSourceFreeMigrationModule -Force
}
$script:ActiveProcess = $null
$script:ActiveLogPath = ""
$script:LastLogLength = -1
$script:ActivePhase = ""
$script:ActivePhaseResultPath = ""
$script:PendingUserPhaseFilePath = ""
$script:PendingUserPhaseComponentKey = ""
$script:PendingUserPhaseArguments = @()
$script:PendingUserPhaseResultPath = ""
$script:PendingUserLogPath = ""

function Resolve-GuiProfileListImagePath {
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

$interactiveIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$interactiveUserName = [string]$interactiveIdentity.Name
$interactiveUserSid = [string]$interactiveIdentity.User.Value
$interactiveProfileRegistryPath = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$interactiveUserSid"
$interactiveProfileRegistryValue = (Get-ItemProperty -LiteralPath $interactiveProfileRegistryPath -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath
$interactiveUserProfileRoot = Resolve-GuiProfileListImagePath -ProfileImagePath ([string]$interactiveProfileRegistryValue)
if (-not (Test-Path -LiteralPath $interactiveUserProfileRoot -PathType Container)) {
    throw "Interactive user profile from ProfileList was not found: SID=$interactiveUserSid path=$interactiveUserProfileRoot"
}
$interactiveCodexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) { "" } else { [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:CODEX_HOME)) }
$productTagline = "Your AI agent inside Revit."
$productFooter = "revAgent  |  " + [char]0x00A9 + " 2026 Baris Tankut  |  All rights reserved."

function Join-CommandLine {
    param([string[]]$Arguments)

    $escaped = foreach ($argument in $Arguments) {
        if ($null -eq $argument) {
            '""'
        }
        elseif ($argument -match '[\s"]') {
            '"' + ($argument -replace '"', '\"') + '"'
        }
        else {
            $argument
        }
    }

    return ($escaped -join " ")
}

function New-RunLogPath {
    param([ValidateSet("machine", "user")][string]$Phase = "machine")

    $logsRoot = Join-Path $workRoot $(if ($Phase -eq "machine") { "machine-logs" } else { "logs" })
    # On first install the unelevated GUI may not yet have permission to create
    # ProgramData\DPE\revAgent. Each phase creates its own managed log directory;
    # machine logs stay read-only to the interactive user, user logs are writable.
    return (Join-Path $logsRoot ("gui-{0}-{1}-{2}.log" -f $Phase, (Get-Date -Format "yyyyMMdd-HHmmss"), [guid]::NewGuid().ToString("N")))
}

function Test-IsAdministrator {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function Read-JsonFile {
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

function Read-GuiUpdaterConfig {
    $config = Read-JsonFile -Path $configPath
    if ($config) {
        return $config
    }
    return Read-JsonFile -Path $legacyConfigPath
}

function Test-LocalUpdaterSupportsSourceFreeMigration {
    param([string]$UpdaterPath)

    if ([string]::IsNullOrWhiteSpace($UpdaterPath) -or -not (Test-Path -LiteralPath $UpdaterPath -PathType Leaf)) {
        return $false
    }

    $updaterRoot = Split-Path -Parent $UpdaterPath
    $migrationTool = Join-Path $updaterRoot "migrate-source-free-install.ps1"
    $migrationLib = Join-Path $updaterRoot "lib\RevAgent.SourceFreeMigration.psm1"
    if (-not (Test-Path -LiteralPath $migrationTool -PathType Leaf) -or -not (Test-Path -LiteralPath $migrationLib -PathType Leaf)) {
        return $false
    }

    try {
        $updaterText = Get-Content -Raw -LiteralPath $UpdaterPath
        return ($updaterText -match 'SourceFreeMigration')
    }
    catch {
        return $false
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

function Get-CodexInstructionPolicyForGui {
    $config = Read-GuiUpdaterConfig
    $policy = Get-JsonPropertyString -Object $config -Name "codexInstructionPolicy"
    if ([string]::IsNullOrWhiteSpace($policy) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_CODEX_INSTRUCTION_POLICY)) {
        $policy = [string]$env:REVIT_MCP_CODEX_INSTRUCTION_POLICY
    }
    if ([string]::IsNullOrWhiteSpace($policy)) {
        $policy = "managed-user-pack"
    }

    $normalized = $policy.Trim().ToLowerInvariant()
    if ($normalized -notin @("managed-user-pack", "preserve-local")) {
        return "managed-user-pack"
    }

    return $normalized
}

function Get-MachineRoleForGui {
    $config = Read-GuiUpdaterConfig
    $role = Get-JsonPropertyString -Object $config -Name "machineRole"
    if ([string]::IsNullOrWhiteSpace($role) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_MACHINE_ROLE)) {
        $role = [string]$env:REVIT_MCP_MACHINE_ROLE
    }

    return $role
}

function Get-PackageDescriptionForGui {
    $policy = Get-CodexInstructionPolicyForGui
    $role = Get-MachineRoleForGui
    if ([string]::Equals($policy, "preserve-local", [System.StringComparison]::OrdinalIgnoreCase)) {
        $roleLabel = if ([string]::IsNullOrWhiteSpace($role)) { "developer" } else { $role.Trim() }
        return "Release track: managed`r`nDeveloper machine ($roleLabel)`r`nCodex instructions: preserve local"
    }

    return "Release track: managed`r`nStandard user package"
}

function Get-SourceFreeMigrationArtifactsForGui {
    $preserveLocalCodexInstructions = [string]::Equals((Get-CodexInstructionPolicyForGui), "preserve-local", [System.StringComparison]::OrdinalIgnoreCase)
    return @(Get-RevAgentSourceFreeArtifactInventory `
            -InstallRoot $InstallRoot `
            -PackageTarget $packageTarget `
            -ServerTarget $serverTarget `
            -PreserveLocalCodexInstructions:$preserveLocalCodexInstructions)
}

function Confirm-SourceFreeMigrationForGui {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Artifacts
    )

    $sample = @($Artifacts |
            Select-Object -First 6 |
            ForEach-Object { "- {0}: {1}" -f [string]$_.rootLabel, [string]$_.relativePath })
    $sampleText = if ($sample.Count -gt 0) { "`r`n`r`nExamples:`r`n" + ($sample -join "`r`n") } else { "" }
    $message = "Source-free migration is required before install/update.`r`n`r`nFound $($Artifacts.Count) managed source/developer artifact item(s). revAgent can run the one-time migration update now. After it succeeds, this machine will use the normal stable update path and migration will not run again while the inventory stays clean.`r`n`r`nContinue with source-free migration and update?$sampleText"

    $statusLabel.Text = "Migration required."
    $logBox.Text = $message + "`r`n"
    $choice = [System.Windows.Forms.MessageBox]::Show(
        $message,
        "revAgent source-free migration required",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning)
    return ($choice -eq [System.Windows.Forms.DialogResult]::Yes)
}

function Get-VersionNumericParts {
    param([string]$Version)

    if ([string]::IsNullOrWhiteSpace($Version)) {
        return $null
    }

    $baseVersion = ($Version -split '-', 2)[0]
    $parts = @()
    foreach ($part in ($baseVersion -split '\.')) {
        if ($part -notmatch '^\d+$') {
            break
        }
        $parts += [int64]$part
    }

    if ($parts.Count -eq 0) {
        return $null
    }

    return $parts
}

function Compare-RevAgentVersion {
    param(
        [string]$Left,
        [string]$Right
    )

    if ([string]::Equals($Left, $Right, [System.StringComparison]::OrdinalIgnoreCase)) {
        return 0
    }

    $leftParts = @(Get-VersionNumericParts -Version $Left)
    $rightParts = @(Get-VersionNumericParts -Version $Right)
    if ($leftParts.Count -gt 0 -and $rightParts.Count -gt 0) {
        $max = [Math]::Max($leftParts.Count, $rightParts.Count)
        for ($i = 0; $i -lt $max; $i++) {
            $leftValue = if ($i -lt $leftParts.Count) { $leftParts[$i] } else { -1 }
            $rightValue = if ($i -lt $rightParts.Count) { $rightParts[$i] } else { -1 }
            if ($leftValue -ne $rightValue) {
                return [Math]::Sign($leftValue - $rightValue)
            }
        }
    }

    return [System.StringComparer]::OrdinalIgnoreCase.Compare($Left, $Right)
}

function Get-ChannelStatus {
    $installed = Read-JsonFile -Path (Join-Path $workRoot "installed.json")
    if (-not $installed) {
        $installed = Read-JsonFile -Path (Join-Path $legacyInstallRoot "updater\installed.json")
    }
    $channel = Read-JsonFile -Path $ChannelManifestPath
    $installedVersion = if ($installed -and $installed.version) { [string]$installed.version } else { "" }
    $channelVersion = if ($channel -and $channel.version) { [string]$channel.version } else { "" }

    if ($null -eq $channel -or [string]::IsNullOrWhiteSpace($channelVersion)) {
        return [pscustomobject]@{
            Code = "channel-missing"
            InstalledVersion = $installedVersion
            ChannelVersion = $channelVersion
            UpdateEnabled = $false
            RestoreEnabled = $false
            UpdateButtonText = "Update"
            SourceFreeMigrationRequired = $false
            SourceFreeMigrationArtifactCount = 0
            StatusText = "Release manifest could not be read."
        }
    }

    $sourceFreeArtifacts = @(Get-SourceFreeMigrationArtifactsForGui)
    if ($sourceFreeArtifacts.Count -gt 0) {
        return [pscustomobject]@{
            Code = "source-free-migration-required"
            InstalledVersion = $installedVersion
            ChannelVersion = $channelVersion
            UpdateEnabled = $true
            RestoreEnabled = $false
            UpdateButtonText = "Migrate"
            SourceFreeMigrationRequired = $true
            SourceFreeMigrationArtifactCount = $sourceFreeArtifacts.Count
            StatusText = "Source-free migration required before update: $($sourceFreeArtifacts.Count) managed source/developer artifact item(s)."
        }
    }

    if ([string]::IsNullOrWhiteSpace($installedVersion)) {
        return [pscustomobject]@{
            Code = "not-installed"
            InstalledVersion = $installedVersion
            ChannelVersion = $channelVersion
            UpdateEnabled = $true
            RestoreEnabled = $false
            UpdateButtonText = "Install"
            SourceFreeMigrationRequired = $false
            SourceFreeMigrationArtifactCount = 0
            StatusText = "Not installed. Release can be installed: $channelVersion"
        }
    }

    if ([string]::Equals($installedVersion, $channelVersion, [System.StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{
            Code = "current"
            InstalledVersion = $installedVersion
            ChannelVersion = $channelVersion
            UpdateEnabled = $false
            RestoreEnabled = $true
            UpdateButtonText = "Update"
            SourceFreeMigrationRequired = $false
            SourceFreeMigrationArtifactCount = 0
            StatusText = "Current: $installedVersion. Install/repair is available."
        }
    }

    $comparison = Compare-RevAgentVersion -Left $installedVersion -Right $channelVersion
    if ($comparison -lt 0) {
        return [pscustomobject]@{
            Code = "update-available"
            InstalledVersion = $installedVersion
            ChannelVersion = $channelVersion
            UpdateEnabled = $true
            RestoreEnabled = $true
            UpdateButtonText = "Update"
            SourceFreeMigrationRequired = $false
            SourceFreeMigrationArtifactCount = 0
            StatusText = "Update available: $installedVersion -> $channelVersion"
        }
    }

    return [pscustomobject]@{
        Code = "restore-available"
        InstalledVersion = $installedVersion
        ChannelVersion = $channelVersion
        UpdateEnabled = $false
        RestoreEnabled = $true
        UpdateButtonText = "Update"
        SourceFreeMigrationRequired = $false
        SourceFreeMigrationArtifactCount = 0
        StatusText = "Installed version differs from or is newer than the release target. Install/repair is available: $installedVersion -> $channelVersion"
    }
}

if ($SmokeTest) {
    if (-not (Test-Path -LiteralPath $installerPath)) {
        throw "Installer script was not found: $installerPath"
    }
    if (-not (Test-Path -LiteralPath $ChannelManifestPath)) {
        throw "Channel manifest was not found: $ChannelManifestPath"
    }

    Write-Host "GUI smoke test OK"
    Write-Host "Installer: $installerPath"
    Write-Host "Channel  : $ChannelManifestPath"
    Write-Host "Install  : $InstallRoot"
    return
}

if (Test-IsAdministrator) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "For security, the revAgent updater GUI must run as the normal interactive user.`r`n`r`nClose this elevated window and start revAgent Updater STABLE.cmd normally. The GUI will request administrator permission only for the machine update phase.",
        "revAgent",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    throw "The revAgent updater GUI refuses to run elevated."
}

function Test-GuiPathUnderRoot {
    param([string]$Path, [string]$Root)

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

function Assert-GuiTrustedPathComponents {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$GuardRoot
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullGuardRoot = [System.IO.Path]::GetFullPath($GuardRoot).TrimEnd("\")
    if (-not (Test-GuiPathUnderRoot -Path $fullPath -Root $fullGuardRoot)) {
        throw "Trusted release path escaped its canonical root. Path=$fullPath Root=$fullGuardRoot"
    }

    $cursor = $fullPath
    while (-not [string]::IsNullOrWhiteSpace($cursor) -and
        (Test-GuiPathUnderRoot -Path $cursor -Root $fullGuardRoot)) {
        if (-not (Test-Path -LiteralPath $cursor)) {
            throw "Trusted release path component does not exist: $cursor"
        }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Trusted release path contains a reparse point: $($item.FullName)"
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
            throw "Trusted release path contains a filesystem link: $($item.FullName) ($($item.LinkType))"
        }
        if ([string]::Equals($cursor.TrimEnd("\"), $fullGuardRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
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

function Assert-GuiDirectoryEffectivelyReadOnly {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$GuardRoot
    )

    $reportsRoot = Join-Path $GuardRoot "reports"
    if (Test-GuiPathUnderRoot -Path $Directory -Root $reportsRoot) { return }
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
        throw "Trusted release effective writability CreateNew probe failed unexpectedly for '$Directory': $($_.Exception.Message)"
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
    if ($created) {
        try { [System.IO.File]::Delete($probePath) }
        catch { throw "Trusted release effective writability probe succeeded but cleanup failed for '$probePath': $($_.Exception.Message)" }
        if (Test-Path -LiteralPath $probePath) { throw "Trusted release effective writability probe cleanup did not remove '$probePath'." }
        throw "Trusted release path is effectively writable and is not sealed (CreateNew succeeded): $Directory"
    }
}

function Assert-GuiTrustedPathAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$GuardRoot
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullGuardRoot = [System.IO.Path]::GetFullPath($GuardRoot).TrimEnd("\")
    $currentSid = [string]([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    $blockedSids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($sid in @($currentSid, "S-1-1-0", "S-1-5-11", "S-1-5-32-545")) {
        if (-not [string]::IsNullOrWhiteSpace($sid)) { [void]$blockedSids.Add($sid) }
    }
    $writeMask = [System.Security.AccessControl.FileSystemRights]::WriteData -bor
        [System.Security.AccessControl.FileSystemRights]::AppendData -bor
        [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership

    $cursor = $fullPath
    while (-not [string]::IsNullOrWhiteSpace($cursor) -and
        (Test-GuiPathUnderRoot -Path $cursor -Root $fullGuardRoot)) {
        $cursorItem = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if ($cursorItem.PSIsContainer) { Assert-GuiDirectoryEffectivelyReadOnly -Directory $cursorItem.FullName -GuardRoot $fullGuardRoot }
        $acl = Get-Acl -LiteralPath $cursor -ErrorAction Stop
        $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
        if ($null -ne $ownerSid -and [string]::Equals([string]$ownerSid.Value, $currentSid, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Trusted release path is owned by the interactive user: $cursor"
        }
        $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
        foreach ($rule in $rules) {
            if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
                (($rule.FileSystemRights -band $writeMask) -ne 0)) {
                throw "Trusted release path has a writable ACL and is not sealed: $cursor (principal=$($rule.IdentityReference.Value), rights=$($rule.FileSystemRights))"
            }
        }
        if ([string]::Equals($cursor.TrimEnd("\"), $fullGuardRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
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

function Assert-GuiTrustedMachineScript {
    param(
        [Parameter(Mandatory = $true)][string]$MachineScriptPath,
        [Parameter(Mandatory = $true)][ValidateSet("updater", "updaterTaskInstaller")][string]$ComponentKey
    )

    $channelFullPath = [System.IO.Path]::GetFullPath($ChannelManifestPath)
    $channelDirectory = Split-Path -Parent $channelFullPath
    $releaseRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $channelDirectory)).TrimEnd("\")
    $pinnedReleaseRoot = [System.IO.Path]::GetFullPath("\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy").TrimEnd("\")
    if (-not [string]::Equals($releaseRoot, $pinnedReleaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Elevated update source must use the pinned revAgent release root '$pinnedReleaseRoot'; refusing '$releaseRoot'."
    }
    $canonicalChannelRoot = Join-Path $releaseRoot "channels"
    $canonicalToolsRoot = Join-Path $releaseRoot "tools"
    $canonicalReleasesRoot = Join-Path $releaseRoot "releases"
    if (-not [string]::Equals([System.IO.Path]::GetFullPath($channelDirectory).TrimEnd("\"), [System.IO.Path]::GetFullPath($canonicalChannelRoot).TrimEnd("\"), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Channel manifest is not under the canonical release channels root: $channelFullPath"
    }
    $canonicalGuiPath = [System.IO.Path]::GetFullPath((Join-Path $InstallRoot "bootstrap\Install-revAgent-Updater-GUI.ps1"))
    if (-not [string]::Equals([System.IO.Path]::GetFullPath($PSCommandPath), $canonicalGuiPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Updater GUI must run from the protected local bootstrap root: $canonicalGuiPath"
    }

    $expectedLeaf = if ($ComponentKey -eq "updater") { "update-from-nas.ps1" } else { "install-updater-task.ps1" }
    $canonicalMachineScript = [System.IO.Path]::GetFullPath((Join-Path $canonicalToolsRoot $expectedLeaf))
    $machineScriptFullPath = [System.IO.Path]::GetFullPath($MachineScriptPath)
    if (-not [string]::Equals($machineScriptFullPath, $canonicalMachineScript, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Elevated machine script must be the canonical release tool '$canonicalMachineScript'; refusing '$machineScriptFullPath'."
    }

    $channel = Get-Content -Raw -LiteralPath $channelFullPath | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$channel.manifestPath)) {
        throw "Channel manifest does not reference a release manifest: $channelFullPath"
    }
    $releaseManifestPath = [string]$channel.manifestPath
    if (-not [System.IO.Path]::IsPathRooted($releaseManifestPath)) {
        $releaseManifestPath = Join-Path $channelDirectory $releaseManifestPath
    }
    $releaseManifestPath = [System.IO.Path]::GetFullPath($releaseManifestPath)
    if (-not (Test-GuiPathUnderRoot -Path $releaseManifestPath -Root $canonicalReleasesRoot)) {
        throw "Release manifest escaped the canonical releases root: $releaseManifestPath"
    }

    foreach ($trustedPath in @($channelFullPath, $releaseManifestPath, $machineScriptFullPath)) {
        [void](Assert-GuiTrustedPathComponents -Path $trustedPath -GuardRoot $releaseRoot)
        Assert-GuiTrustedPathAcl -Path $trustedPath -GuardRoot $releaseRoot
    }

    $releaseManifest = Get-Content -Raw -LiteralPath $releaseManifestPath | ConvertFrom-Json
    $surfaceMap = [ordered]@{
        updaterGui = @("installer\nas\Install-revAgent-Updater-GUI.ps1", "Install-revAgent-Updater-GUI.ps1")
        installerLibDistributionIntegrity = @("installer\lib\RevAgent.DistributionIntegrity.psm1", "lib\RevAgent.DistributionIntegrity.psm1")
    }
    if ($ComponentKey -eq "updater") {
        $surfaceMap["updater"] = @("installer\nas\update-from-nas.ps1", "update-from-nas.ps1")
        foreach ($entry in ([ordered]@{
                installerLibHiddenLauncher = "RevAgent.HiddenLauncher.psm1"
                installerLibScheduledTask = "RevAgent.ScheduledTask.psm1"
                installerLibVersions = "RevAgent.RevitVersions.psm1"
                installerLibPackage = "RevAgent.Package.psm1"
                installerLibUpdatePolicy = "RevAgent.UpdatePolicy.psm1"
                installerLibProxy = "RevAgent.Proxy.psm1"
                installerLibLogRetention = "RevAgent.LogRetention.psm1"
                installerLibPermissions = "RevAgent.Permissions.psm1"
                installerLibSecureTemp = "RevAgent.SecureTemp.psm1"
                installerLibCodexRegistration = "RevAgent.CodexRegistration.psm1"
                installerLibConfigSync = "RevAgent.ConfigSync.psm1"
                installerLibReporting = "RevAgent.Reporting.psm1"
                installerLibDesktopLauncherCleanup = "RevAgent.DesktopLauncherCleanup.psm1"
                installerLibLicense = "RevAgent.License.psm1"
                installerLibSourceFreeMigration = "RevAgent.SourceFreeMigration.psm1"
            }).GetEnumerator()) {
            $surfaceMap[$entry.Key] = @(("installer\lib\{0}" -f $entry.Value), ("lib\{0}" -f $entry.Value))
        }
    }
    else {
        $surfaceMap["updaterTaskInstaller"] = @("installer\nas\install-updater-task.ps1", "install-updater-task.ps1")
        # install-updater-task later invokes this top-level script elevated.
        # Bind it now as part of the same pre-UAC closure; its internal UAC-side
        # checks are defense in depth, not permission to run an unbound script.
        $surfaceMap["updater"] = @("installer\nas\update-from-nas.ps1", "update-from-nas.ps1")
        foreach ($entry in ([ordered]@{
                installerLibHiddenLauncher = "RevAgent.HiddenLauncher.psm1"
                installerLibScheduledTask = "RevAgent.ScheduledTask.psm1"
                installerLibVersions = "RevAgent.RevitVersions.psm1"
                installerLibPermissions = "RevAgent.Permissions.psm1"
                installerLibSecureTemp = "RevAgent.SecureTemp.psm1"
                installerLibProxy = "RevAgent.Proxy.psm1"
                installerLibLogRetention = "RevAgent.LogRetention.psm1"
                installerLibCodexRegistration = "RevAgent.CodexRegistration.psm1"
                installerLibReporting = "RevAgent.Reporting.psm1"
                installerLibDesktopLauncherCleanup = "RevAgent.DesktopLauncherCleanup.psm1"
            }).GetEnumerator()) {
            $surfaceMap[$entry.Key] = @(("installer\lib\{0}" -f $entry.Value), ("lib\{0}" -f $entry.Value))
        }
    }

    foreach ($surface in $surfaceMap.GetEnumerator()) {
        $component = $releaseManifest.components.($surface.Key)
        $expectedPackagePath = [string]$surface.Value[0]
        $toolPath = [System.IO.Path]::GetFullPath((Join-Path $canonicalToolsRoot ([string]$surface.Value[1])))
        if ($null -eq $component -or [string]::IsNullOrWhiteSpace([string]$component.sha256)) {
            throw "Release manifest is missing pre-import component '$($surface.Key)'."
        }
        if (-not [string]::Equals(([string]$component.path).Replace("/", "\"), $expectedPackagePath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Release manifest component '$($surface.Key)' path mismatch: $($component.path)"
        }
        [void](Assert-GuiTrustedPathComponents -Path $toolPath -GuardRoot $releaseRoot)
        Assert-GuiTrustedPathAcl -Path $toolPath -GuardRoot $releaseRoot
        $actualSurfaceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $toolPath).Hash
        if (-not [string]::Equals($actualSurfaceHash, [string]$component.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Pre-import surface hash mismatch. Component=$($surface.Key) Expected=$($component.sha256) Actual=$actualSurfaceHash"
        }
    }

    $trustedKeysPath = Join-Path $canonicalToolsRoot "config\release-trusted-keys.json"
    $channelSignaturePath = Join-Path $channelDirectory (([System.IO.Path]::GetFileNameWithoutExtension($channelFullPath)) + ".sig.json")
    $manifestSignaturePath = Join-Path (Split-Path -Parent $releaseManifestPath) (([System.IO.Path]::GetFileNameWithoutExtension($releaseManifestPath)) + ".sig.json")
    foreach ($signedInput in @($trustedKeysPath, $channelSignaturePath, $manifestSignaturePath)) {
        [void](Assert-GuiTrustedPathComponents -Path $signedInput -GuardRoot $releaseRoot)
        Assert-GuiTrustedPathAcl -Path $signedInput -GuardRoot $releaseRoot
    }
    $trustedKeyDocument = Get-Content -Raw -LiteralPath $trustedKeysPath | ConvertFrom-Json
    $trustedKey = $trustedKeyDocument.trustedKeys."revagent-prod-rsa-2026q3"
    $normalizedPublicKey = ([string]$trustedKey.publicKeyXml).Trim() -replace "\s+", ""
    $publicKeyBytes = [System.Text.Encoding]::UTF8.GetBytes($normalizedPublicKey)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try { $actualFingerprint = ([System.BitConverter]::ToString($sha256.ComputeHash($publicKeyBytes))).Replace("-", "") } finally { $sha256.Dispose() }
    $pinnedFingerprint = "32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33"
    if (-not [string]::Equals($actualFingerprint, $pinnedFingerprint, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Trusted release key fingerprint mismatch. Expected=$pinnedFingerprint Actual=$actualFingerprint"
    }

    $integrityModulePath = Join-Path $canonicalToolsRoot "lib\RevAgent.DistributionIntegrity.psm1"
    $pinnedIntegrityModuleHash = "2360CC209EAAD6AEF26E90F6865427914CDE499F0F6F8838296D5F5381F371B4"
    $actualIntegrityModuleHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $integrityModulePath).Hash
    if (-not [string]::Equals($actualIntegrityModuleHash, $pinnedIntegrityModuleHash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Pinned pre-UAC integrity verifier hash mismatch. Expected=$pinnedIntegrityModuleHash Actual=$actualIntegrityModuleHash"
    }
    $integrityModule = Import-Module $integrityModulePath -Force -PassThru
    $integrityCommand = Get-Command ("{0}\Test-RevAgentReleaseDistributionIntegrity" -f $integrityModule.Name) -ErrorAction Stop
    $integrity = & $integrityCommand `
        -ChannelPath $channelFullPath `
        -Channel $channel `
        -ReleaseManifestPath $releaseManifestPath `
        -ReleaseManifest $releaseManifest `
        -TrustedKeys $trustedKeyDocument.trustedKeys `
        -Policy "enforce"
    if (-not [bool]$integrity.success) {
        throw "Pre-UAC signed release verification failed: $($integrity.reason). $($integrity.message)"
    }

    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $machineScriptFullPath).Hash
    Write-Host "Trusted machine surface: $machineScriptFullPath ($ComponentKey $actualHash; signed release verified)"
    return $machineScriptFullPath
}

function Test-LocalUpdaterSupportsSplitPrivilege {
    param([string]$UpdaterPath)

    if ([string]::IsNullOrWhiteSpace($UpdaterPath) -or -not (Test-Path -LiteralPath $UpdaterPath -PathType Leaf)) {
        return $false
    }
    try {
        $updaterText = Get-Content -Raw -LiteralPath $UpdaterPath
        return ($updaterText -match '\$MachinePhaseOnly' -and $updaterText -match '\$UserPhaseOnly' -and $updaterText -match '\$PhaseResultPath')
    }
    catch {
        return $false
    }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "revAgent"
$form.ShowInTaskbar = $true
$form.MinimizeBox = $true
$form.MaximizeBox = $true
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::Sizable
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(820, 560)
$form.MinimumSize = New-Object System.Drawing.Size(700, 460)

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = "Fill"
$root.ColumnCount = 1
$root.RowCount = 7
$root.Padding = New-Object System.Windows.Forms.Padding(12)
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$form.Controls.Add($root)

$title = New-Object System.Windows.Forms.Label
$title.Text = "revAgent install and update"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$root.Controls.Add($title, 0, 0)

$tagline = New-Object System.Windows.Forms.Label
$tagline.Text = $productTagline
$tagline.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$tagline.ForeColor = [System.Drawing.Color]::FromArgb(80, 80, 80)
$tagline.AutoSize = $true
$tagline.Margin = New-Object System.Windows.Forms.Padding(0, 2, 0, 8)
$root.Controls.Add($tagline, 0, 1)

$details = New-Object System.Windows.Forms.Label
$details.Text = Get-PackageDescriptionForGui
$details.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$details.AutoSize = $true
$details.Margin = New-Object System.Windows.Forms.Padding(0, 8, 0, 8)
$root.Controls.Add($details, 0, 2)

$statusPanel = New-Object System.Windows.Forms.TableLayoutPanel
$statusPanel.Dock = "Top"
$statusPanel.AutoSize = $true
$statusPanel.AutoSizeMode = "GrowAndShrink"
$statusPanel.ColumnCount = 2
$statusPanel.RowCount = 1
$statusPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$statusPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 170))) | Out-Null
$statusPanel.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.Controls.Add($statusPanel, 0, 3)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Ready."
$statusLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$statusLabel.AutoSize = $true
$statusPanel.Controls.Add($statusLabel, 0, 0)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Dock = "None"
$progress.Style = "Blocks"
$progress.Width = 160
$progress.Height = 10
$progress.Margin = New-Object System.Windows.Forms.Padding(0, 5, 0, 0)
$progress.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right
$statusPanel.Controls.Add($progress, 1, 0)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Dock = "Fill"
$logBox.Multiline = $true
$logBox.ScrollBars = "Both"
$logBox.WordWrap = $false
$logBox.ReadOnly = $true
$logBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$root.Controls.Add($logBox, 0, 4)

$buttonPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonPanel.Dock = "Fill"
$buttonPanel.FlowDirection = "LeftToRight"
$buttonPanel.AutoSize = $true
$buttonPanel.Margin = New-Object System.Windows.Forms.Padding(0, 10, 0, 0)
$root.Controls.Add($buttonPanel, 0, 5)

$runButton = New-Object System.Windows.Forms.Button
$runButton.Text = "Install/Update"
$runButton.Width = 110
$runButton.Height = 32
$buttonPanel.Controls.Add($runButton)

$restoreButton = New-Object System.Windows.Forms.Button
$restoreButton.Text = "Install/Repair"
$restoreButton.Width = 120
$restoreButton.Height = 32
$buttonPanel.Controls.Add($restoreButton)

$versionButton = New-Object System.Windows.Forms.Button
$versionButton.Text = "Version Check"
$versionButton.Width = 120
$versionButton.Height = 32
$buttonPanel.Controls.Add($versionButton)

$openLogsButton = New-Object System.Windows.Forms.Button
$openLogsButton.Text = "Log Folder"
$openLogsButton.Width = 110
$openLogsButton.Height = 32
$buttonPanel.Controls.Add($openLogsButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = "Close"
$closeButton.Width = 90
$closeButton.Height = 32
$buttonPanel.Controls.Add($closeButton)

$footer = New-Object System.Windows.Forms.Label
$footer.Text = $productFooter
$footer.Font = New-Object System.Drawing.Font("Segoe UI", 8)
$footer.ForeColor = [System.Drawing.Color]::FromArgb(100, 100, 100)
$footer.AutoSize = $true
$footer.Margin = New-Object System.Windows.Forms.Padding(0, 10, 0, 0)
$root.Controls.Add($footer, 0, 6)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700

function Set-ButtonsEnabled {
    param([bool]$Enabled)
    if (-not $Enabled) {
        $runButton.Enabled = $false
        $restoreButton.Enabled = $false
        $versionButton.Enabled = $false
        $closeButton.Enabled = $false
        return
    }

    $status = Get-ChannelStatus
    $runButton.Text = $status.UpdateButtonText
    $runButton.Enabled = [bool]$status.UpdateEnabled
    $restoreButton.Enabled = [bool]$status.RestoreEnabled
    $versionButton.Enabled = $true
    $closeButton.Enabled = $true
    $statusLabel.Text = [string]$status.StatusText
}

function Add-InteractiveContextArguments {
    param([string[]]$Arguments)

    $result = @($Arguments)
    foreach ($entry in @(
            [pscustomobject]@{ Name = "TargetInteractiveUser"; Value = $interactiveUserName },
            [pscustomobject]@{ Name = "TargetInteractiveUserSid"; Value = $interactiveUserSid },
            [pscustomobject]@{ Name = "TargetUserProfileRoot"; Value = $interactiveUserProfileRoot },
            [pscustomobject]@{ Name = "TargetCodexHome"; Value = $interactiveCodexHome }
        )) {
        if (-not [string]::IsNullOrWhiteSpace([string]$entry.Value)) {
            $result += @("-$($entry.Name)", [string]$entry.Value)
        }
    }
    return $result
}

function New-GuiPhaseResultPath {
    param([ValidateSet("machine", "user")][string]$Phase)

    $stateRoot = Join-Path $workRoot $(if ($Phase -eq "machine") { "machine-state" } else { "user-state" })
    $runId = [guid]::NewGuid().ToString("N")
    return Join-Path $stateRoot ("gui-{0}-phase-{1}.json" -f $Phase, $runId)
}

function Read-GuiPhaseResult {
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

function Start-GuiPhaseProcess {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$Elevated
    )

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        throw "Phase script was not found: $ScriptPath"
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $powershellPath
    $psi.Arguments = Join-CommandLine -Arguments $Arguments
    if ($Elevated) {
        $psi.UseShellExecute = $true
        $psi.Verb = "runas"
        $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    }
    else {
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    [void]$process.Start()
    return $process
}

function Start-InstallerOperation {
    param([ValidateSet("update", "restore")] [string]$Operation)

    if (-not (Test-Path -LiteralPath $installerPath)) {
        [System.Windows.Forms.MessageBox]::Show("Installer was not found.", "revAgent") | Out-Null
        return
    }
    if (-not (Test-Path -LiteralPath $ChannelManifestPath)) {
        [System.Windows.Forms.MessageBox]::Show("Release manifest was not found.", "revAgent") | Out-Null
        return
    }

    $localUpdaterPath = Join-Path $workRoot "update-from-nas.ps1"
    $hasLocalUpdater = Test-Path -LiteralPath $localUpdaterPath -PathType Leaf
    $releaseUpdaterPath = Join-Path $releaseToolsRoot "update-from-nas.ps1"
    if (-not (Test-Path -LiteralPath $releaseUpdaterPath -PathType Leaf)) {
        [System.Windows.Forms.MessageBox]::Show("The trusted release updater was not found beside the GUI. Elevated execution of the user-writable local updater is refused.", "revAgent") | Out-Null
        Set-ButtonsEnabled -Enabled $true
        return
    }
    $directUpdaterPath = $releaseUpdaterPath
    $status = Get-ChannelStatus
    $sourceFreeArtifacts = @(Get-SourceFreeMigrationArtifactsForGui)
    $runSourceFreeMigration = ($sourceFreeArtifacts.Count -gt 0)
    $localUpdaterSupportsSourceFreeMigration = Test-LocalUpdaterSupportsSourceFreeMigration -UpdaterPath $localUpdaterPath
    $needsSourceFreeMigrationBootstrap = ($runSourceFreeMigration -and -not $localUpdaterSupportsSourceFreeMigration)
    $localUpdaterSupportsSplitPrivilege = Test-LocalUpdaterSupportsSplitPrivilege -UpdaterPath $localUpdaterPath
    $needsPrivilegeSplitBootstrap = ($hasLocalUpdater -and -not $localUpdaterSupportsSplitPrivilege)
    if ($runSourceFreeMigration) {
        if (-not (Confirm-SourceFreeMigrationForGui -Artifacts $sourceFreeArtifacts)) {
            Set-ButtonsEnabled -Enabled $true
            return
        }
        $Operation = "update"
    }

    if ($Operation -eq "update" -and -not [bool]$status.UpdateEnabled) {
        [System.Windows.Forms.MessageBox]::Show("No update is available.`r`n`r`n$($status.StatusText)", "revAgent") | Out-Null
        Set-ButtonsEnabled -Enabled $true
        return
    }

    if ($Operation -eq "update" -and -not [string]::IsNullOrWhiteSpace($status.InstalledVersion) -and -not $hasLocalUpdater) {
        [System.Windows.Forms.MessageBox]::Show("This workstation has an installed revAgent package, but the local trusted updater was not found. Use Install/Repair to restore the local updater before normal updates.", "revAgent") | Out-Null
        Set-ButtonsEnabled -Enabled $true
        return
    }

    if ($Operation -eq "restore") {
        $message = "Install/Repair installs the release target package with force.`r`n`r`nInstalled: $($status.InstalledVersion)`r`nRelease: $($status.ChannelVersion)`r`n`r`nContinue?"
        $choice = [System.Windows.Forms.MessageBox]::Show(
            $message,
            "revAgent Install/Repair",
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning)
        if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
            return
        }
    }

    $script:ActiveLogPath = New-RunLogPath -Phase "machine"
    $userLogPath = New-RunLogPath -Phase "user"
    $script:LastLogLength = -1
    $codexInstructionPolicy = Get-CodexInstructionPolicyForGui
    $machineRole = Get-MachineRoleForGui
    $operationMethod = if ($runSourceFreeMigration) {
        if ($needsSourceFreeMigrationBootstrap) { "source-free-migration-bootstrap" } else { "source-free-migration" }
    }
    elseif ($needsPrivilegeSplitBootstrap) {
        "privilege-split-bootstrap"
    }
    elseif ($Operation -eq "restore") {
        if ([string]::IsNullOrWhiteSpace($status.InstalledVersion)) { "gui-install" } else { "gui-install-repair" }
    }
    elseif ([string]::IsNullOrWhiteSpace($status.InstalledVersion)) {
        "gui-install"
    }
    else {
        "gui-update"
    }
    $operationLabel = if ($operationMethod -eq "source-free-migration") { "Source-free migration" } elseif ($operationMethod -eq "gui-install-repair") { "Install/repair" } elseif ($operationMethod -eq "gui-install") { "Install" } else { "Update" }
    $logBox.Text = "$operationLabel starting...`r`n"
    $statusLabel.Text = "Running."
    $progress.Style = "Marquee"
    Set-ButtonsEnabled -Enabled $false

    $useDirectUpdate = ($Operation -eq "update" -and
        (-not [string]::IsNullOrWhiteSpace($status.InstalledVersion) -or $runSourceFreeMigration)) -and
        $hasLocalUpdater -and
        -not $needsSourceFreeMigrationBootstrap -and
        -not $needsPrivilegeSplitBootstrap

    $machinePhaseResultPath = New-GuiPhaseResultPath -Phase "machine"
    $userPhaseResultPath = New-GuiPhaseResultPath -Phase "user"

    if ($useDirectUpdate) {
        $machineArguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $directUpdaterPath,
            "-ChannelManifestPath", $ChannelManifestPath,
            "-InstallRoot", $InstallRoot,
            "-WorkRoot", $workRoot,
            "-PackageTarget", $packageTarget,
            "-ServerTarget", $serverTarget,
            "-NoNotifyUser",
            "-OperationMethod", $operationMethod,
            "-LogPath", $script:ActiveLogPath,
            "-MachinePhaseOnly",
            "-PhaseResultPath", $machinePhaseResultPath
        )
        $userArguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $releaseUpdaterPath,
            "-ChannelManifestPath", $ChannelManifestPath,
            "-InstallRoot", $InstallRoot,
            "-WorkRoot", $workRoot,
            "-PackageTarget", $packageTarget,
            "-ServerTarget", $serverTarget,
            "-NoNotifyUser",
            "-AllowManualCodexSetup",
            "-OperationMethod", $operationMethod,
            "-LogPath", $userLogPath,
            "-UserPhaseOnly",
            "-PhaseResultPath", $userPhaseResultPath
        )
        $machineScriptPath = $directUpdaterPath
        $userScriptPath = $releaseUpdaterPath
        $machineComponentKey = "updater"
        $userComponentKey = "updater"
    }
    else {
        $machineArguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $installerPath,
            "-ChannelManifestPath", $ChannelManifestPath,
            "-InstallRoot", $InstallRoot,
            "-WorkRoot", $workRoot,
            "-PackageTarget", $packageTarget,
            "-ServerTarget", $serverTarget,
            "-RunNow",
            "-OperationMethod", $operationMethod,
            "-LogPath", $script:ActiveLogPath,
            "-MachinePhaseOnly",
            "-PhaseResultPath", $machinePhaseResultPath
        )
        $userArguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $installerPath,
            "-ChannelManifestPath", $ChannelManifestPath,
            "-InstallRoot", $InstallRoot,
            "-WorkRoot", $workRoot,
            "-PackageTarget", $packageTarget,
            "-ServerTarget", $serverTarget,
            "-OperationMethod", $operationMethod,
            "-LogPath", $userLogPath,
            "-UserPhaseOnly",
            "-PhaseResultPath", $userPhaseResultPath
        )
        $machineScriptPath = $installerPath
        $userScriptPath = $installerPath
        $machineComponentKey = "updaterTaskInstaller"
        $userComponentKey = "updaterTaskInstaller"
    }
    $machineArguments += @("-CodexInstructionPolicy", $codexInstructionPolicy)
    $userArguments += @("-CodexInstructionPolicy", $codexInstructionPolicy)
    if (-not [string]::IsNullOrWhiteSpace($machineRole)) {
        $machineArguments += @("-MachineRole", $machineRole)
        $userArguments += @("-MachineRole", $machineRole)
    }
    if ($Operation -eq "restore") {
        $machineArguments += "-ForceUpdate"
    }
    if ($needsSourceFreeMigrationBootstrap) {
        $machineArguments += "-RunSourceFreeMigration"
    }
    elseif ($runSourceFreeMigration) {
        $machineArguments += "-SourceFreeMigration"
    }
    $machineArguments = Add-InteractiveContextArguments -Arguments $machineArguments
    $userArguments = Add-InteractiveContextArguments -Arguments $userArguments

    try {
        $machineScriptPath = Assert-GuiTrustedMachineScript -MachineScriptPath $machineScriptPath -ComponentKey $machineComponentKey
        $script:ActiveProcess = Start-GuiPhaseProcess -ScriptPath $machineScriptPath -Arguments $machineArguments -Elevated
        $script:ActivePhase = "machine"
        $script:ActivePhaseResultPath = $machinePhaseResultPath
        $script:PendingUserPhaseFilePath = $userScriptPath
        $script:PendingUserPhaseComponentKey = $userComponentKey
        $script:PendingUserPhaseArguments = @($userArguments)
        $script:PendingUserPhaseResultPath = $userPhaseResultPath
        $script:PendingUserLogPath = $userLogPath
        $statusLabel.Text = "Machine update running with administrator permission."
        $timer.Start()
    }
    catch {
        $progress.Style = "Blocks"
        Set-ButtonsEnabled -Enabled $true
        $statusLabel.Text = "Could not start."
        [System.Windows.Forms.MessageBox]::Show(
            "The administrator-only machine update could not be started.`r`n$($_.Exception.Message)",
            "revAgent",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    }
}

function Read-LogFileText {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return ""
    }

    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $reader = New-Object System.IO.StreamReader($stream)
            try {
                return $reader.ReadToEnd()
            }
            finally {
                $reader.Dispose()
            }
        }
        finally {
            $stream.Dispose()
        }
    }
    catch {
        return ""
    }
}

function Refresh-LogBox {
    if ([string]::IsNullOrWhiteSpace($script:ActiveLogPath)) {
        return
    }

    $text = Read-LogFileText -Path $script:ActiveLogPath
    if ($text.Length -eq 0) {
        return
    }

    if ($text.Length -gt 250000) {
        $text = $text.Substring($text.Length - 250000)
    }

    if ($text.Length -ne $script:LastLogLength) {
        $script:LastLogLength = $text.Length
        $logBox.Text = $text
        $logBox.SelectionStart = $logBox.TextLength
        $logBox.ScrollToCaret()
    }
}

$timer.Add_Tick({
    Refresh-LogBox

    if ($null -ne $script:ActiveProcess -and $script:ActiveProcess.HasExited) {
        $timer.Stop()
        Refresh-LogBox
        $exitCode = $script:ActiveProcess.ExitCode
        $completedPhase = $script:ActivePhase
        $phaseResult = Read-GuiPhaseResult -Path $script:ActivePhaseResultPath
        $script:ActiveProcess.Dispose()
        $script:ActiveProcess = $null

        if ($completedPhase -eq "machine" -and
            $exitCode -eq 0 -and
            $null -ne $phaseResult -and
            [bool]$phaseResult.continueUserPhase) {
            try {
                if (-not (Test-Path -LiteralPath $script:PendingUserPhaseFilePath -PathType Leaf)) {
                    throw "The refreshed unelevated user-phase script was not found: $($script:PendingUserPhaseFilePath)"
                }
                $verifiedUserPhasePath = Assert-GuiTrustedMachineScript -MachineScriptPath $script:PendingUserPhaseFilePath -ComponentKey $script:PendingUserPhaseComponentKey
                $script:ActiveProcess = Start-GuiPhaseProcess `
                    -ScriptPath $verifiedUserPhasePath `
                    -Arguments $script:PendingUserPhaseArguments
                $script:ActivePhase = "user"
                $script:ActivePhaseResultPath = $script:PendingUserPhaseResultPath
                $script:ActiveLogPath = $script:PendingUserLogPath
                $script:LastLogLength = -1
                $statusLabel.Text = "Machine update completed; user Codex integration is running unelevated."
                if (-not $logBox.Text.EndsWith("`r`n")) {
                    $logBox.AppendText("`r`n")
                }
                $logBox.AppendText("Machine phase completed. Starting unelevated user integration...`r`n")
                $timer.Start()
                return
            }
            catch {
                $exitCode = 1
                $phaseResult = $null
                if (-not $logBox.Text.EndsWith("`r`n")) {
                    $logBox.AppendText("`r`n")
                }
                $logBox.AppendText("Could not start unelevated user integration: $($_.Exception.Message)`r`n")
            }
        }

        $progress.Style = "Blocks"
        Set-ButtonsEnabled -Enabled $true

        $phaseSucceeded = ($exitCode -eq 0 -and
            $null -ne $phaseResult -and
            [bool]$phaseResult.success)
        if ($completedPhase -eq "user" -and $phaseSucceeded) {
            $statusLabel.Text = "Operation completed."
            if (-not $logBox.Text.EndsWith("`r`n")) {
                $logBox.AppendText("`r`n")
            }
            $logBox.AppendText("Operation completed.`r`n")
            [System.Windows.Forms.MessageBox]::Show(
                "Operation completed.",
                "revAgent",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
        }
        else {
            $resultMessage = if ($null -ne $phaseResult -and -not [string]::IsNullOrWhiteSpace([string]$phaseResult.message)) {
                [string]$phaseResult.message
            }
            elseif ($exitCode -eq 0) {
                "The phase did not produce a valid completion result."
            }
            else {
                "The phase exited with code $exitCode."
            }
            $statusLabel.Text = if ($null -ne $phaseResult -and [string]$phaseResult.status -eq "blocked") { "Operation deferred." } else { "An error occurred." }
            if (-not $logBox.Text.EndsWith("`r`n")) {
                $logBox.AppendText("`r`n")
            }
            $logBox.AppendText("Install/update did not complete: $resultMessage`r`nUse Log Folder for diagnostic details.`r`n")
            [System.Windows.Forms.MessageBox]::Show(
                "Install/update did not complete.`r`n`r`n$resultMessage`r`n`r`nOpen the log folder for details.",
                "revAgent",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                $(if ($null -ne $phaseResult -and [string]$phaseResult.status -eq "blocked") { [System.Windows.Forms.MessageBoxIcon]::Warning } else { [System.Windows.Forms.MessageBoxIcon]::Error })) | Out-Null
        }
    }
})

$runButton.Add_Click({
    Start-InstallerOperation -Operation "update"
})

$restoreButton.Add_Click({
    Start-InstallerOperation -Operation "restore"
})

$versionButton.Add_Click({
    if (-not (Test-Path -LiteralPath $localVersionTool)) {
        $logBox.Text = "Version check tool is not installed yet.`r`nRun Install/Update first."
        return
    }

    try {
        $output = & $powershellPath -NoProfile -ExecutionPolicy Bypass -File $localVersionTool -ConfigPath $configPath 2>&1 | Out-String
        $logBox.Text = $output
        $statusLabel.Text = "Version check completed."
    }
    catch {
        $logBox.Text = "Version check failed:`r`n$($_.Exception.Message)"
        $statusLabel.Text = "Version check failed."
    }
})

$openLogsButton.Add_Click({
    if (-not (Test-Path -LiteralPath $workRoot)) {
        [System.Windows.Forms.MessageBox]::Show("The revAgent updater folder does not exist yet.", "revAgent") | Out-Null
        return
    }
    Start-Process explorer.exe $workRoot
})

$closeButton.Add_Click({
    if ($null -ne $script:ActiveProcess -and -not $script:ActiveProcess.HasExited) {
        [System.Windows.Forms.MessageBox]::Show(
            "An operation is still running. Do not close before it finishes.",
            "revAgent",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
        return
    }
    $form.Close()
})

$form.Add_FormClosing({
    if ($null -ne $script:ActiveProcess -and -not $script:ActiveProcess.HasExited) {
        $_.Cancel = $true
        [System.Windows.Forms.MessageBox]::Show(
            "An operation is still running. Do not close before it finishes.",
            "revAgent",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    }
})

Set-ButtonsEnabled -Enabled $true

[void][System.Windows.Forms.Application]::Run($form)
