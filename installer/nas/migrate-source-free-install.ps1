<#
.SYNOPSIS
    Inspect or migrate an existing workstation to the source-free revAgent user pack layout.

.DESCRIPTION
    Dry-run mode reports managed source/developer artifacts left by older
    installs without changing the workstation. Commit mode calls the local
    updater in source-free migration mode, forcing a full managed payload
    repair and then verifying that managed package, runtime, Codex skill, and
    updater backup locations no longer contain source/developer artifacts.
#>

[CmdletBinding()]
param(
    [ValidateSet("dryRun", "commit")]
    [string]$Mode = "dryRun",

    [string]$ConfigPath = "",
    [string]$ChannelManifestPath = "",
    [string]$InstallRoot = "",
    [string]$WorkRoot = "",
    [string]$PackageTarget = "",
    [string]$ServerTarget = "",
    [string]$RevitInstallRoot = "",
    [string]$ReportsRoot = "",
    [string]$UserProfileRoot = "",
    [string]$ReportPath = "",
    [ValidateSet("", "managed-user-pack", "preserve-local")]
    [string]$CodexInstructionPolicy = "",
    [string]$MachineRole = "",

    [switch]$SkipBackups,
    [switch]$SkipNpmInstall,
    [switch]$SkipCodexMcpRegistration,
    [switch]$SkipCodexUserIntegration,
    [switch]$SkipProxySetup,
    [switch]$NoNotifyUser
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$nasLibRoot = @(
    (Join-Path $PSScriptRoot "lib"),
    (Join-Path (Split-Path -Parent $PSScriptRoot) "lib")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($nasLibRoot)) {
    throw "revAgent migration lib folder was not found beside or above: $PSScriptRoot"
}

Import-Module (Join-Path $nasLibRoot "RevitMcp.CodexRegistration.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.SourceFreeMigration.psm1") -Force
Set-RevitMcpCurrentProcessUtf8Console | Out-Null

function Read-RevitMcpJsonFileOrNull {
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

function Get-RevitMcpConfigValue {
    param(
        [object]$Config,
        [string]$Name
    )

    if ($null -eq $Config) {
        return ""
    }
    $property = $Config.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return ""
    }

    return [string]$property.Value
}

function Resolve-RevitMcpCodexInstructionPolicy {
    param(
        [string]$RequestedPolicy,
        [object]$Config
    )

    $policy = $RequestedPolicy
    if ([string]::IsNullOrWhiteSpace($policy)) {
        $policy = Get-RevitMcpConfigValue -Config $Config -Name "codexInstructionPolicy"
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

function Resolve-RevitMcpMachineRole {
    param(
        [string]$RequestedRole,
        [object]$Config
    )

    $role = $RequestedRole
    if ([string]::IsNullOrWhiteSpace($role)) {
        $role = Get-RevitMcpConfigValue -Config $Config -Name "machineRole"
    }
    if ([string]::IsNullOrWhiteSpace($role) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_MACHINE_ROLE)) {
        $role = [string]$env:REVIT_MCP_MACHINE_ROLE
    }

    return $role
}

function Set-RevitMcpDefaultedPath {
    param(
        [string]$Current,
        [string]$ConfigValue,
        [string]$Fallback
    )

    if (-not [string]::IsNullOrWhiteSpace($Current)) {
        return $Current
    }
    if (-not [string]::IsNullOrWhiteSpace($ConfigValue)) {
        return $ConfigValue
    }
    return $Fallback
}

function Write-RevitMcpMigrationReport {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    $directory = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Add-RevitMcpChildProcessParameter {
    param(
        [Parameter(Mandatory = $true)][System.Collections.Generic.List[string]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][string]$Value
    )

    [void]$Arguments.Add("-$Name")
    [void]$Arguments.Add([string]$Value)
}

function Add-RevitMcpChildProcessSwitch {
    param(
        [Parameter(Mandatory = $true)][System.Collections.Generic.List[string]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Name,
        [bool]$Enabled
    )

    if ($Enabled) {
        [void]$Arguments.Add("-$Name")
    }
}

function Get-RevitMcpScheduledTaskState {
    param([string]$Name)

    $getTaskCommand = Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue
    if ($null -eq $getTaskCommand) {
        return [ordered]@{
            available = $false
            exists = $false
            state = ""
            error = ""
        }
    }

    try {
        $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $task) {
            return [ordered]@{
                available = $true
                exists = $false
                state = ""
                error = ""
            }
        }

        return [ordered]@{
            available = $true
            exists = $true
            state = [string]$task.State
            error = ""
        }
    }
    catch {
        return [ordered]@{
            available = $true
            exists = $false
            state = ""
            error = $_.Exception.Message
        }
    }
}

function Restore-RevitMcpScheduledTaskDisabledState {
    param(
        [string]$Name,
        [object]$BeforeState
    )

    if ($null -eq $BeforeState -or -not $BeforeState.available -or -not $BeforeState.exists) {
        return [ordered]@{
            attempted = $false
            success = $true
            reason = "task_not_previously_present"
            state = ""
            error = ""
        }
    }

    if (-not [string]::Equals([string]$BeforeState.state, "Disabled", [System.StringComparison]::OrdinalIgnoreCase)) {
        return [ordered]@{
            attempted = $false
            success = $true
            reason = "task_not_previously_disabled"
            state = [string]$BeforeState.state
            error = ""
        }
    }

    $disableTaskCommand = Get-Command Disable-ScheduledTask -ErrorAction SilentlyContinue
    if ($null -eq $disableTaskCommand) {
        return [ordered]@{
            attempted = $true
            success = $false
            reason = "disable_command_unavailable"
            state = [string]$BeforeState.state
            error = "Disable-ScheduledTask is unavailable."
        }
    }

    try {
        Disable-ScheduledTask -TaskName $Name -ErrorAction Stop | Out-Null
        $afterState = Get-RevitMcpScheduledTaskState -Name $Name
        return [ordered]@{
            attempted = $true
            success = [string]::Equals([string]$afterState.state, "Disabled", [System.StringComparison]::OrdinalIgnoreCase)
            reason = "restored_disabled_state"
            state = [string]$afterState.state
            error = [string]$afterState.error
        }
    }
    catch {
        return [ordered]@{
            attempted = $true
            success = $false
            reason = "restore_failed"
            state = [string]$BeforeState.state
            error = $_.Exception.Message
        }
    }
}

$programDataRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { "C:\ProgramData" } else { $env:ProgramData }
$requestedInstallRoot = $InstallRoot
$requestedWorkRoot = $WorkRoot
$requestedPackageTarget = $PackageTarget
$requestedServerTarget = $ServerTarget
$requestedChannelManifestPath = $ChannelManifestPath
$requestedRevitInstallRoot = $RevitInstallRoot
$requestedReportsRoot = $ReportsRoot
$defaultInstallRoot = Join-Path $programDataRoot "DPE\revAgent"
$configInstallRoot = if ([string]::IsNullOrWhiteSpace($requestedInstallRoot)) { $defaultInstallRoot } else { $requestedInstallRoot }
$configWorkRoot = if ([string]::IsNullOrWhiteSpace($requestedWorkRoot)) { Join-Path $configInstallRoot "updater" } else { $requestedWorkRoot }
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $configWorkRoot "updater-config.json"
}

$config = Read-RevitMcpJsonFileOrNull -Path $ConfigPath
$InstallRoot = Set-RevitMcpDefaultedPath -Current $requestedInstallRoot -ConfigValue (Get-RevitMcpConfigValue -Config $config -Name "installRoot") -Fallback $defaultInstallRoot
$WorkRoot = Set-RevitMcpDefaultedPath -Current $requestedWorkRoot -ConfigValue (Get-RevitMcpConfigValue -Config $config -Name "workRoot") -Fallback (Join-Path $InstallRoot "updater")
$PackageTarget = Set-RevitMcpDefaultedPath -Current $requestedPackageTarget -ConfigValue (Get-RevitMcpConfigValue -Config $config -Name "packageTarget") -Fallback (Join-Path $InstallRoot "package")
$ServerTarget = Set-RevitMcpDefaultedPath -Current $requestedServerTarget -ConfigValue (Get-RevitMcpConfigValue -Config $config -Name "serverTarget") -Fallback (Join-Path $InstallRoot "runtime")
$ChannelManifestPath = Set-RevitMcpDefaultedPath -Current $requestedChannelManifestPath -ConfigValue (Get-RevitMcpConfigValue -Config $config -Name "channelManifestPath") -Fallback ""
$RevitInstallRoot = Set-RevitMcpDefaultedPath -Current $requestedRevitInstallRoot -ConfigValue (Get-RevitMcpConfigValue -Config $config -Name "revitInstallRoot") -Fallback ""
$ReportsRoot = Set-RevitMcpDefaultedPath -Current $requestedReportsRoot -ConfigValue (Get-RevitMcpConfigValue -Config $config -Name "reportsRoot") -Fallback ""
$CodexInstructionPolicy = Resolve-RevitMcpCodexInstructionPolicy -RequestedPolicy $CodexInstructionPolicy -Config $config
$MachineRole = Resolve-RevitMcpMachineRole -RequestedRole $MachineRole -Config $config
$preserveLocalCodexInstructions = [string]::Equals($CodexInstructionPolicy, "preserve-local", [System.StringComparison]::OrdinalIgnoreCase)

if ([string]::IsNullOrWhiteSpace($UserProfileRoot)) {
    $UserProfileRoot = $env:USERPROFILE
}
if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $ReportPath = Join-Path (Join-Path $WorkRoot "reports") ("source-free-migration-{0}.json" -f $stamp)
}

$startedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
$beforeInventory = @(Get-RevitMcpSourceFreeArtifactInventory `
        -InstallRoot $InstallRoot `
        -PackageTarget $PackageTarget `
        -ServerTarget $ServerTarget `
        -UserProfileRoot $UserProfileRoot `
        -PreserveLocalCodexInstructions:$preserveLocalCodexInstructions `
        -SkipCodexUserIntegration:$SkipCodexUserIntegration `
        -SkipBackups:$SkipBackups)

$updateExitCode = $null
$updateError = ""
$updaterTaskName = "revAgent Auto Update"
$scheduledTaskBefore = $null
$scheduledTaskRestore = [ordered]@{
    attempted = $false
    success = $true
    reason = "not_commit_mode"
    state = ""
    error = ""
}

if ($Mode -eq "commit") {
    if ([string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
        throw "ChannelManifestPath is required for commit mode. Pass it explicitly or provide an updater config."
    }

    $updaterPath = Join-Path $WorkRoot "update-from-nas.ps1"
    if (-not (Test-Path -LiteralPath $updaterPath -PathType Leaf)) {
        throw "Source-free migration commit mode requires the local trusted updater under WorkRoot: $updaterPath. Run Install/Repair first to bootstrap the local updater."
    }

    $powerShellPath = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
    if ([string]::IsNullOrWhiteSpace($powerShellPath)) {
        $powerShellPath = "powershell.exe"
    }

    $updateArgs = [System.Collections.Generic.List[string]]::new()
    [void]$updateArgs.Add("-NoProfile")
    [void]$updateArgs.Add("-ExecutionPolicy")
    [void]$updateArgs.Add("Bypass")
    [void]$updateArgs.Add("-File")
    [void]$updateArgs.Add($updaterPath)
    Add-RevitMcpChildProcessParameter -Arguments $updateArgs -Name "ConfigPath" -Value $ConfigPath
    Add-RevitMcpChildProcessParameter -Arguments $updateArgs -Name "ChannelManifestPath" -Value $ChannelManifestPath
    Add-RevitMcpChildProcessParameter -Arguments $updateArgs -Name "InstallRoot" -Value $InstallRoot
    Add-RevitMcpChildProcessParameter -Arguments $updateArgs -Name "WorkRoot" -Value $WorkRoot
    Add-RevitMcpChildProcessParameter -Arguments $updateArgs -Name "PackageTarget" -Value $PackageTarget
    Add-RevitMcpChildProcessParameter -Arguments $updateArgs -Name "ServerTarget" -Value $ServerTarget
    Add-RevitMcpChildProcessParameter -Arguments $updateArgs -Name "OperationMethod" -Value "source-free-migration"
    Add-RevitMcpChildProcessParameter -Arguments $updateArgs -Name "CodexInstructionPolicy" -Value $CodexInstructionPolicy
    if (-not [string]::IsNullOrWhiteSpace($MachineRole)) {
        Add-RevitMcpChildProcessParameter -Arguments $updateArgs -Name "MachineRole" -Value $MachineRole
    }
    Add-RevitMcpChildProcessSwitch -Arguments $updateArgs -Name "SourceFreeMigration" -Enabled $true
    if (-not [string]::IsNullOrWhiteSpace($RevitInstallRoot)) {
        Add-RevitMcpChildProcessParameter -Arguments $updateArgs -Name "RevitInstallRoot" -Value $RevitInstallRoot
    }
    if (-not [string]::IsNullOrWhiteSpace($ReportsRoot)) {
        Add-RevitMcpChildProcessParameter -Arguments $updateArgs -Name "ReportsRoot" -Value $ReportsRoot
    }
    Add-RevitMcpChildProcessSwitch -Arguments $updateArgs -Name "SkipNpmInstall" -Enabled $SkipNpmInstall
    Add-RevitMcpChildProcessSwitch -Arguments $updateArgs -Name "SkipCodexMcpRegistration" -Enabled $SkipCodexMcpRegistration
    Add-RevitMcpChildProcessSwitch -Arguments $updateArgs -Name "SkipCodexUserIntegration" -Enabled $SkipCodexUserIntegration
    Add-RevitMcpChildProcessSwitch -Arguments $updateArgs -Name "SkipProxySetup" -Enabled $SkipProxySetup
    Add-RevitMcpChildProcessSwitch -Arguments $updateArgs -Name "NoNotifyUser" -Enabled $NoNotifyUser

    $scheduledTaskBefore = Get-RevitMcpScheduledTaskState -Name $updaterTaskName

    try {
        & $powerShellPath @updateArgs
        $updateExitCode = $LASTEXITCODE
        if ($null -ne $updateExitCode -and $updateExitCode -ne 0) {
            $updateError = "update-from-nas.ps1 exited with code $updateExitCode"
        }
    }
    catch {
        $updateError = $_.Exception.Message
    }
    finally {
        $scheduledTaskRestore = Restore-RevitMcpScheduledTaskDisabledState -Name $updaterTaskName -BeforeState $scheduledTaskBefore
        if (-not $scheduledTaskRestore.success -and [string]::IsNullOrWhiteSpace($updateError)) {
            $updateError = "Failed to restore disabled scheduled task state: $($scheduledTaskRestore.error)"
        }
    }
}

$afterInventory = @(Get-RevitMcpSourceFreeArtifactInventory `
        -InstallRoot $InstallRoot `
        -PackageTarget $PackageTarget `
        -ServerTarget $ServerTarget `
        -UserProfileRoot $UserProfileRoot `
        -PreserveLocalCodexInstructions:$preserveLocalCodexInstructions `
        -SkipCodexUserIntegration:$SkipCodexUserIntegration `
        -SkipBackups:$SkipBackups)

$report = [ordered]@{
    schemaVersion = 1
    tool = "source-free-migration"
    mode = $Mode
    startedAtUtc = $startedAtUtc
    finishedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    success = if ($Mode -eq "dryRun") { $true } else { $afterInventory.Count -eq 0 -and [string]::IsNullOrWhiteSpace($updateError) }
    codexInstructionPolicy = $CodexInstructionPolicy
    codexInstructionCleanupSkipped = [bool]$preserveLocalCodexInstructions
    machineRole = $MachineRole
    paths = [ordered]@{
        configPath = $ConfigPath
        channelManifestPath = $ChannelManifestPath
        installRoot = $InstallRoot
        workRoot = $WorkRoot
        packageTarget = $PackageTarget
        serverTarget = $ServerTarget
        userProfileRoot = $UserProfileRoot
    }
    before = [ordered]@{
        artifactCount = $beforeInventory.Count
        artifacts = @($beforeInventory)
    }
    after = [ordered]@{
        artifactCount = $afterInventory.Count
        artifacts = @($afterInventory)
    }
    updater = [ordered]@{
        exitCode = $updateExitCode
        error = $updateError
    }
    scheduledTask = [ordered]@{
        name = $updaterTaskName
        before = $scheduledTaskBefore
        restore = $scheduledTaskRestore
    }
}

Write-RevitMcpMigrationReport -Path $ReportPath -Value $report
Write-Host "Source-free migration report: $ReportPath"

if ($Mode -eq "dryRun") {
    Write-Host ("Source-free migration dry-run found {0} managed source/developer artifact item(s)." -f $beforeInventory.Count)
    return
}

if (-not [string]::IsNullOrWhiteSpace($updateError)) {
    throw "Source-free migration updater step failed: $updateError. Report: $ReportPath"
}

if ($afterInventory.Count -gt 0) {
    throw "Source-free migration completed but managed source/developer artifacts remain: $($afterInventory.Count). Report: $ReportPath"
}

Write-Host "Source-free migration completed and verified." -ForegroundColor Green
