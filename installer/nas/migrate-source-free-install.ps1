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

Import-Module (Join-Path $nasLibRoot "RevitMcp.SourceFreeMigration.psm1") -Force

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

$programDataRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { "C:\ProgramData" } else { $env:ProgramData }
$requestedInstallRoot = $InstallRoot
$requestedWorkRoot = $WorkRoot
$requestedPackageTarget = $PackageTarget
$requestedServerTarget = $ServerTarget
$requestedChannelManifestPath = $ChannelManifestPath
$requestedRevitInstallRoot = $RevitInstallRoot
$requestedReportsRoot = $ReportsRoot
$defaultInstallRoot = Join-Path $programDataRoot "DPE\RevitMCP"
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
        -SkipBackups:$SkipBackups)

$updateExitCode = $null
$updateError = ""

if ($Mode -eq "commit") {
    if ([string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
        throw "ChannelManifestPath is required for commit mode. Pass it explicitly or provide an updater config."
    }

    $updaterPath = Join-Path $PSScriptRoot "update-from-nas.ps1"
    if (-not (Test-Path -LiteralPath $updaterPath -PathType Leaf)) {
        $updaterPath = Join-Path $WorkRoot "update-from-nas.ps1"
    }
    if (-not (Test-Path -LiteralPath $updaterPath -PathType Leaf)) {
        throw "update-from-nas.ps1 was not found beside the migration tool or under WorkRoot: $WorkRoot"
    }

    $updateArgs = @{
        ConfigPath = $ConfigPath
        ChannelManifestPath = $ChannelManifestPath
        InstallRoot = $InstallRoot
        WorkRoot = $WorkRoot
        PackageTarget = $PackageTarget
        ServerTarget = $ServerTarget
        OperationMethod = "source-free-migration"
        SourceFreeMigration = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($RevitInstallRoot)) {
        $updateArgs["RevitInstallRoot"] = $RevitInstallRoot
    }
    if (-not [string]::IsNullOrWhiteSpace($ReportsRoot)) {
        $updateArgs["ReportsRoot"] = $ReportsRoot
    }
    if ($SkipNpmInstall) {
        $updateArgs["SkipNpmInstall"] = $true
    }
    if ($SkipCodexMcpRegistration) {
        $updateArgs["SkipCodexMcpRegistration"] = $true
    }
    if ($SkipCodexUserIntegration) {
        $updateArgs["SkipCodexUserIntegration"] = $true
    }
    if ($SkipProxySetup) {
        $updateArgs["SkipProxySetup"] = $true
    }
    if ($NoNotifyUser) {
        $updateArgs["NoNotifyUser"] = $true
    }

    try {
        & $updaterPath @updateArgs
        $updateExitCode = $LASTEXITCODE
    }
    catch {
        $updateError = $_.Exception.Message
    }
}

$afterInventory = @(Get-RevitMcpSourceFreeArtifactInventory `
        -InstallRoot $InstallRoot `
        -PackageTarget $PackageTarget `
        -ServerTarget $ServerTarget `
        -UserProfileRoot $UserProfileRoot `
        -SkipBackups:$SkipBackups)

$report = [ordered]@{
    schemaVersion = 1
    tool = "source-free-migration"
    mode = $Mode
    startedAtUtc = $startedAtUtc
    finishedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    success = if ($Mode -eq "dryRun") { $true } else { $afterInventory.Count -eq 0 -and [string]::IsNullOrWhiteSpace($updateError) }
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
