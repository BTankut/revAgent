<#
.SYNOPSIS
    Show the installed revAgent version and the available release version.
#>

[CmdletBinding()]
param(
    [string]$ConfigPath = "",
    [switch]$Technical
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

function Compare-RevitMcpVersion {
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

$programDataRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { "C:\ProgramData" } else { $env:ProgramData }
$defaultInstallRoot = Join-Path $programDataRoot "DPE\revAgent"
$legacyInstallRoot = Join-Path $programDataRoot "DPE\RevitMCP"
$defaultWorkRoot = Join-Path $defaultInstallRoot "updater"
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $defaultWorkRoot "updater-config.json"
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        $legacyConfigPath = Join-Path $legacyInstallRoot "updater\updater-config.json"
        if (Test-Path -LiteralPath $legacyConfigPath -PathType Leaf) {
            $ConfigPath = $legacyConfigPath
        }
    }
}

$config = Read-JsonFile -Path $ConfigPath
$installRoot = if ($config -and $config.installRoot) { [string]$config.installRoot } else { $defaultInstallRoot }
$workRoot = if ($config -and $config.workRoot) { [string]$config.workRoot } else { Join-Path $installRoot "updater" }
$channelManifestPath = if ($config -and $config.channelManifestPath) { [string]$config.channelManifestPath } else { "" }
$proxyUrl = if ($config -and $config.proxyUrl) { [string]$config.proxyUrl } else { "" }

$installedPath = Join-Path $workRoot "installed.json"
$reportPath = Join-Path $workRoot "last-update-report.json"
$manualUpdatePath = Join-Path $workRoot "Update-revAgent-Now.cmd"

$installed = Read-JsonFile -Path $installedPath
$report = Read-JsonFile -Path $reportPath
$channel = Read-JsonFile -Path $channelManifestPath

$installedVersion = if ($installed -and $installed.version) { [string]$installed.version } else { "" }
$channelVersion = if ($channel -and $channel.version) { [string]$channel.version } else { "" }
$channelName = if ($channel -and $channel.channel) { [string]$channel.channel } else { "" }
$reportTargetVersion = if ($report -and $report.targetVersion) { [string]$report.targetVersion } else { "" }
$reportMatchesCurrentChannel = [string]::IsNullOrWhiteSpace($reportTargetVersion) -or [string]::IsNullOrWhiteSpace($channelVersion) -or $reportTargetVersion -eq $channelVersion

if ([string]::IsNullOrWhiteSpace($installedVersion)) {
    $status = "not installed"
}
elseif (-not [string]::IsNullOrWhiteSpace($channelVersion) -and $installedVersion -eq $channelVersion) {
    $status = "current"
}
elseif (-not [string]::IsNullOrWhiteSpace($channelVersion)) {
    $comparison = Compare-RevitMcpVersion -Left $installedVersion -Right $channelVersion
    if ($comparison -lt 0) {
        $status = "update available: {0} -> {1}" -f $installedVersion, $channelVersion
    }
    else {
        $status = "install/repair available: {0} -> {1}" -f $installedVersion, $channelVersion
    }
}
else {
    $status = "installed; channel could not be checked"
}

Write-Host ""
Write-Host "revAgent status" -ForegroundColor Cyan
Write-Host "Computer        : $env:COMPUTERNAME"
Write-Host "User            : $env:USERNAME"
Write-Host "Installed       : $(Get-VersionLabel $installedVersion)"
Write-Host "Available       : $(Get-VersionLabel $channelVersion)"
Write-Host "Status          : $status"
if (-not [string]::IsNullOrWhiteSpace($proxyUrl)) {
    Write-Host "Proxy           : $proxyUrl"
}

if ($report) {
    $lastCheckSuffix = if ($reportMatchesCurrentChannel) { "" } else { " (previous release target: $reportTargetVersion)" }
    Write-Host "Last check      : $($report.status) at $($report.atUtc)$lastCheckSuffix"
    if ($report.versionTransition) {
        Write-Host "Last transition : $($report.versionTransition)"
    }
    if ($report.pendingVersionTransition) {
        Write-Host "Pending update  : $($report.pendingVersionTransition)"
    }
    if ($report.message) {
        $messageSuffix = if ($reportMatchesCurrentChannel) { "" } else { " (from previous updater run)" }
        Write-Host "Last message    : $($report.message)$messageSuffix"
    }
}
else {
    Write-Host "Last check      : no local report"
}

if ($Technical) {
    Write-Host "Install root    : $installRoot"
    Write-Host "Config          : $ConfigPath"
    Write-Host "Manual update   : $manualUpdatePath"
}
if ($status -like "update available:*") {
    Write-Host "Next step       : close Revit and run Update."
}
elseif ($status -like "install/repair available:*") {
    Write-Host "Next step       : use Install/Repair if you want to install the available release."
}
Write-Host ""
