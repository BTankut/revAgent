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

function Get-VersionSortDate {
    param([string]$Version)

    if ([string]::IsNullOrWhiteSpace($Version)) {
        return $null
    }

    if ($Version -match '^(\d{4})\.(\d{2})\.(\d{2})\.(\d{4})') {
        $hourMinute = $Matches[4]
        return [datetime]::new(
            [int]$Matches[1],
            [int]$Matches[2],
            [int]$Matches[3],
            [int]$hourMinute.Substring(0, 2),
            [int]$hourMinute.Substring(2, 2),
            0)
    }

    if ($Version -match '^(\d{4})\.(\d{2})\.(\d{2})') {
        return [datetime]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], 0, 0, 0)
    }

    return $null
}

function Compare-RevitMcpVersion {
    param(
        [string]$Left,
        [string]$Right
    )

    if ([string]::Equals($Left, $Right, [System.StringComparison]::OrdinalIgnoreCase)) {
        return 0
    }

    $leftDate = Get-VersionSortDate -Version $Left
    $rightDate = Get-VersionSortDate -Version $Right
    if ($null -ne $leftDate -and $null -ne $rightDate -and $leftDate -ne $rightDate) {
        return [DateTime]::Compare($leftDate, $rightDate)
    }

    return [System.StringComparer]::OrdinalIgnoreCase.Compare($Left, $Right)
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
$proxyUrl = if ($config -and $config.proxyUrl) { [string]$config.proxyUrl } else { "" }

$installedPath = Join-Path $workRoot "installed.json"
$reportPath = Join-Path $workRoot "last-update-report.json"
$manualUpdatePath = Join-Path $workRoot "Update-Revit-MCP-Now.cmd"

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
        $status = "restore available: {0} -> {1}" -f $installedVersion, $channelVersion
    }
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
if (-not [string]::IsNullOrWhiteSpace($proxyUrl)) {
    Write-Host "Proxy           : $proxyUrl"
}

if ($report) {
    $lastCheckSuffix = if ($reportMatchesCurrentChannel) { "" } else { " (previous channel target: $reportTargetVersion)" }
    Write-Host "Last check      : $($report.status) at $($report.atUtc)$lastCheckSuffix"
    if ($report.versionTransition) {
        Write-Host "Last transition : $($report.versionTransition)"
    }
    if ($report.message) {
        $messageSuffix = if ($reportMatchesCurrentChannel) { "" } else { " (from previous updater run)" }
        Write-Host "Last message    : $($report.message)$messageSuffix"
    }
}
else {
    Write-Host "Last check      : no local report"
}

Write-Host "Install root    : $installRoot"
Write-Host "Config          : $ConfigPath"
Write-Host "Manual update   : $manualUpdatePath"
if ($status -like "update available:*") {
    Write-Host "Next step       : close Revit and run the manual update command above."
}
elseif ($status -like "restore available:*") {
    Write-Host "Next step       : use Stable Restore in the updater GUI if you want to install the channel stable package."
}
Write-Host ""
