<#
.SYNOPSIS
    Inspect or migrate an existing workstation to the source-free revAgent user pack layout.

.DESCRIPTION
    Dry-run mode reports managed source/developer artifacts left by older
    installs without changing the workstation. Standalone commit mode is kept
    only as a fail-closed compatibility surface. Mutating migration must start
    from the protected local GUI so its authenticated snapshot broker can split
    administrator-only machine work from unelevated user integration.
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

$programDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
if ([string]::IsNullOrWhiteSpace($programDataRoot)) { $programDataRoot = "C:\ProgramData" }
$defaultInstallRoot = Join-Path $programDataRoot "DPE\revAgent"
if ($Mode -eq "commit") {
    $protectedLauncher = Join-Path $defaultInstallRoot "bootstrap\Start-revAgent-Update.cmd"
    throw "Standalone source-free migration commit mode is disabled. Mutating migration must run through the protected local GUI and privileged snapshot broker so machine and user work are split safely. Start '$protectedLauncher', then choose Migrate (or Install/Repair when the local updater must be bootstrapped). Use -Mode dryRun here for inventory only."
}

$nasLibRoot = @(
    (Join-Path $PSScriptRoot "lib"),
    (Join-Path (Split-Path -Parent $PSScriptRoot) "lib")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($nasLibRoot)) {
    throw "revAgent migration lib folder was not found beside or above: $PSScriptRoot"
}

Import-Module (Join-Path $nasLibRoot "RevAgent.CodexRegistration.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevAgent.SourceFreeMigration.psm1") -Force
Set-RevAgentCurrentProcessUtf8Console | Out-Null

function Read-RevAgentJsonFileOrNull {
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

function Get-RevAgentConfigValue {
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

function Resolve-RevAgentCodexInstructionPolicy {
    param(
        [string]$RequestedPolicy,
        [object]$Config
    )

    $policy = $RequestedPolicy
    if ([string]::IsNullOrWhiteSpace($policy)) {
        $policy = Get-RevAgentConfigValue -Config $Config -Name "codexInstructionPolicy"
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

function Resolve-RevAgentMachineRole {
    param(
        [string]$RequestedRole,
        [object]$Config
    )

    $role = $RequestedRole
    if ([string]::IsNullOrWhiteSpace($role)) {
        $role = Get-RevAgentConfigValue -Config $Config -Name "machineRole"
    }
    if ([string]::IsNullOrWhiteSpace($role) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_MACHINE_ROLE)) {
        $role = [string]$env:REVIT_MCP_MACHINE_ROLE
    }

    return $role
}

function Set-RevAgentDefaultedPath {
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

function Write-RevAgentMigrationReport {
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

function ConvertTo-RevAgentSafePathSegment {
    param(
        [string]$Value,
        [string]$Fallback = "unknown"
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $Fallback
    }

    $invalidCharacters = [System.IO.Path]::GetInvalidFileNameChars()
    $builder = [System.Text.StringBuilder]::new()
    foreach ($character in $Value.Trim().ToCharArray()) {
        if ([char]::IsControl($character) -or [char]::IsWhiteSpace($character) -or [Array]::IndexOf($invalidCharacters, $character) -ge 0) {
            [void]$builder.Append("_")
            continue
        }

        [void]$builder.Append($character)
    }

    $safe = [System.Text.RegularExpressions.Regex]::Replace($builder.ToString(), "_{2,}", "_").Trim("._-")
    if ([string]::IsNullOrWhiteSpace($safe)) {
        return $Fallback
    }

    return $safe
}

function Copy-RevAgentOrderedMap {
    param([object]$Value)

    $copy = [ordered]@{}
    if ($null -eq $Value) {
        return $copy
    }
    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($key in $Value.Keys) {
            $copy[[string]$key] = $Value[$key]
        }
        return $copy
    }
    foreach ($property in $Value.PSObject.Properties) {
        $copy[$property.Name] = $property.Value
    }
    return $copy
}

function Publish-RevAgentSourceFreeMigrationEvidence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ReportsRoot,

        [Parameter(Mandatory = $true)]
        [object]$Report
    )

    if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
        return $null
    }

    $safeComputer = ConvertTo-RevAgentSafePathSegment -Value $env:COMPUTERNAME -Fallback "unknown-computer"
    $machineRoot = Join-Path (Join-Path $ReportsRoot "machines") $safeComputer
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $latestPath = Join-Path $machineRoot "source-free-migration-latest.json"
    $historyPath = Join-Path $machineRoot ("source-free-migration-{0}.json" -f $stamp)
    $publishedAtUtc = (Get-Date).ToUniversalTime().ToString("o")

    $published = Copy-RevAgentOrderedMap -Value $Report
    $published["computerName"] = $env:COMPUTERNAME
    $published["userName"] = $env:USERNAME
    $published["operation"] = "source-free-migration"
    $published["operationMethod"] = if ([string]::Equals([string]$published["mode"], "dryRun", [System.StringComparison]::OrdinalIgnoreCase)) { "source-free-migration-dry-run" } else { "source-free-migration" }
    $published["publishedAtUtc"] = $publishedAtUtc
    $published["machineReport"] = [ordered]@{
        machineRoot = $machineRoot
        latestPath = $latestPath
        historyPath = $historyPath
        logPath = $null
    }

    Write-RevAgentMigrationReport -Path $historyPath -Value $published
    Write-RevAgentMigrationReport -Path $latestPath -Value $published

    return [pscustomobject][ordered]@{
        MachineRoot = $machineRoot
        LatestPath = $latestPath
        HistoryPath = $historyPath
    }
}

$requestedInstallRoot = $InstallRoot
$requestedWorkRoot = $WorkRoot
$requestedPackageTarget = $PackageTarget
$requestedServerTarget = $ServerTarget
$requestedChannelManifestPath = $ChannelManifestPath
$requestedRevitInstallRoot = $RevitInstallRoot
$requestedReportsRoot = $ReportsRoot
$configInstallRoot = if ([string]::IsNullOrWhiteSpace($requestedInstallRoot)) { $defaultInstallRoot } else { $requestedInstallRoot }
$configWorkRoot = if ([string]::IsNullOrWhiteSpace($requestedWorkRoot)) { Join-Path $configInstallRoot "updater" } else { $requestedWorkRoot }
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $configWorkRoot "updater-config.json"
}

$config = Read-RevAgentJsonFileOrNull -Path $ConfigPath
$InstallRoot = Set-RevAgentDefaultedPath -Current $requestedInstallRoot -ConfigValue (Get-RevAgentConfigValue -Config $config -Name "installRoot") -Fallback $defaultInstallRoot
$WorkRoot = Set-RevAgentDefaultedPath -Current $requestedWorkRoot -ConfigValue (Get-RevAgentConfigValue -Config $config -Name "workRoot") -Fallback (Join-Path $InstallRoot "updater")
$PackageTarget = Set-RevAgentDefaultedPath -Current $requestedPackageTarget -ConfigValue (Get-RevAgentConfigValue -Config $config -Name "packageTarget") -Fallback (Join-Path $InstallRoot "package")
$ServerTarget = Set-RevAgentDefaultedPath -Current $requestedServerTarget -ConfigValue (Get-RevAgentConfigValue -Config $config -Name "serverTarget") -Fallback (Join-Path $InstallRoot "runtime")
$ChannelManifestPath = Set-RevAgentDefaultedPath -Current $requestedChannelManifestPath -ConfigValue (Get-RevAgentConfigValue -Config $config -Name "channelManifestPath") -Fallback ""
$RevitInstallRoot = Set-RevAgentDefaultedPath -Current $requestedRevitInstallRoot -ConfigValue (Get-RevAgentConfigValue -Config $config -Name "revitInstallRoot") -Fallback ""
$ReportsRoot = Set-RevAgentDefaultedPath -Current $requestedReportsRoot -ConfigValue (Get-RevAgentConfigValue -Config $config -Name "reportsRoot") -Fallback ""
$CodexInstructionPolicy = Resolve-RevAgentCodexInstructionPolicy -RequestedPolicy $CodexInstructionPolicy -Config $config
$MachineRole = Resolve-RevAgentMachineRole -RequestedRole $MachineRole -Config $config
$preserveLocalCodexInstructions = [string]::Equals($CodexInstructionPolicy, "preserve-local", [System.StringComparison]::OrdinalIgnoreCase)

if ([string]::IsNullOrWhiteSpace($UserProfileRoot)) {
    $UserProfileRoot = $env:USERPROFILE
}
if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $ReportPath = Join-Path (Join-Path $WorkRoot "reports") ("source-free-migration-{0}.json" -f $stamp)
}

$startedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
$beforeInventory = @(Get-RevAgentSourceFreeArtifactInventory `
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

$afterInventory = @(Get-RevAgentSourceFreeArtifactInventory `
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
    success = $true
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

Write-RevAgentMigrationReport -Path $ReportPath -Value $report
Write-Host "Source-free migration report: $ReportPath"
if (-not [string]::IsNullOrWhiteSpace($ReportsRoot)) {
    try {
        $publishedMigrationEvidence = Publish-RevAgentSourceFreeMigrationEvidence -ReportsRoot $ReportsRoot -Report $report
        if ($null -ne $publishedMigrationEvidence) {
            Write-Host "Source-free migration NAS evidence: $($publishedMigrationEvidence.LatestPath)"
        }
    }
    catch {
        Write-Warning "Could not publish source-free migration evidence to NAS reports: $($_.Exception.Message)"
    }
}

Write-Host ("Source-free migration dry-run found {0} managed source/developer artifact item(s)." -f $beforeInventory.Count)
