<#
.SYNOPSIS
    Show the installed Revit MCP version and the NAS channel version.
#>

[CmdletBinding()]
param(
    [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"

function Read-JsonFile {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        Write-Warning "Could not read JSON file: $Path"
        return $null
    }
}

function Get-VersionLabel {
    param([string]$Version)

    if ([string]::IsNullOrWhiteSpace($Version)) {
        return "not installed"
    }

    return $Version
}

$programDataRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { "C:\ProgramData" } else { $env:ProgramData }
$defaultInstallRoot = Join-Path $programDataRoot "DPE\RevitMCP"
$defaultWorkRoot = Join-Path $defaultInstallRoot "updater"
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $defaultWorkRoot "updater-config.json"
}

$config = Read-JsonFile -Path $ConfigPath
$installRoot = if ($config -and $config.installRoot) { [string]$config.installRoot } else { $defaultInstallRoot }
$workRoot = if ($config -and $config.workRoot) { [string]$config.workRoot } else { Join-Path $installRoot "updater" }
$channelManifestPath = if ($config -and $config.channelManifestPath) { [string]$config.channelManifestPath } else { "" }

$installedPath = Join-Path $workRoot "installed.json"
$reportPath = Join-Path $workRoot "last-update-report.json"
$manualUpdatePath = Join-Path $workRoot "Update-Revit-MCP-Now.cmd"

$installed = Read-JsonFile -Path $installedPath
$report = Read-JsonFile -Path $reportPath
$channel = Read-JsonFile -Path $channelManifestPath

$installedVersion = if ($installed -and $installed.version) { [string]$installed.version } else { "" }
$channelVersion = if ($channel -and $channel.version) { [string]$channel.version } else { "" }
$channelName = if ($channel -and $channel.channel) { [string]$channel.channel } else { "" }

if ([string]::IsNullOrWhiteSpace($installedVersion)) {
    $status = "not installed"
}
elseif (-not [string]::IsNullOrWhiteSpace($channelVersion) -and $installedVersion -eq $channelVersion) {
    $status = "current"
}
elseif (-not [string]::IsNullOrWhiteSpace($channelVersion)) {
    $status = "update available: {0} -> {1}" -f $installedVersion, $channelVersion
}
else {
    $status = "installed; channel could not be checked"
}

Write-Host ""
Write-Host "Revit MCP version status" -ForegroundColor Cyan
Write-Host "Computer        : $env:COMPUTERNAME"
Write-Host "User            : $env:USERNAME"
Write-Host "Installed       : $(Get-VersionLabel $installedVersion)"
Write-Host "Channel         : $(if ($channelName) { $channelName } else { 'unknown' })"
Write-Host "Channel version : $(Get-VersionLabel $channelVersion)"
Write-Host "Status          : $status"

if ($report) {
    Write-Host "Last check      : $($report.status) at $($report.atUtc)"
    if ($report.versionTransition) {
        Write-Host "Last transition : $($report.versionTransition)"
    }
    if ($report.message) {
        Write-Host "Last message    : $($report.message)"
    }
}
else {
    Write-Host "Last check      : no local report"
}

Write-Host "Install root    : $installRoot"
Write-Host "Config          : $ConfigPath"
Write-Host "Manual update   : $manualUpdatePath"
Write-Host ""
