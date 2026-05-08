<#
.SYNOPSIS
    Install the workstation updater and register a scheduled update check.

.DESCRIPTION
    Copies update-from-nas.ps1 to a local managed folder, writes updater config,
    and registers a per-user scheduled task. The task reads the NAS channel
    manifest and only updates when Revit is closed.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ChannelManifestPath,

    [string]$WorkRoot = "C:\Projects\revit-mcp-install",
    [string]$PackageTarget = "C:\Projects\revit-mcp-skill",
    [string]$ServerTarget = "C:\Projects\revit-mcp",
    [string]$WorkspaceAgentsTarget = "",
    [ValidateSet("2022")]
    [string]$RevitVersion = "2022",
    [string[]]$LegacyServerTargets = @(),
    [string]$ReportsRoot = "",
    [string]$TaskName = "Revit MCP Auto Update",
    [string]$DailyAt = "09:00",
    [switch]$SkipNpmInstall,
    [switch]$SkipCodexMcpRegistration,
    [switch]$NoScheduledTask
)

$ErrorActionPreference = "Stop"

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Value
    )

    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null

$localUpdater = Join-Path $WorkRoot "update-from-nas.ps1"
$configPath = Join-Path $WorkRoot "updater-config.json"
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "update-from-nas.ps1") -Destination $localUpdater -Force

if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
    $channelDir = Split-Path -Parent $ChannelManifestPath
    $releaseRootGuess = Split-Path -Parent $channelDir
    $ReportsRoot = Join-Path $releaseRootGuess "reports"
}

$config = [ordered]@{
    schemaVersion = 1
    app = "revit-mcp-skill"
    channelManifestPath = $ChannelManifestPath
    workRoot = $WorkRoot
    packageTarget = $PackageTarget
    serverTarget = $ServerTarget
    workspaceAgentsTarget = $WorkspaceAgentsTarget
    revitVersion = $RevitVersion
    legacyServerTargets = $LegacyServerTargets
    reportsRoot = $ReportsRoot
    skipNpmInstall = [bool]$SkipNpmInstall
    skipCodexMcpRegistration = [bool]$SkipCodexMcpRegistration
    installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
}
Write-JsonFile -Path $configPath -Value $config

if ($NoScheduledTask) {
    Write-Host "Updater installed without scheduled task."
    Write-Host "Run manually: powershell -ExecutionPolicy Bypass -File `"$localUpdater`" -ConfigPath `"$configPath`""
    return
}

$time = [datetime]::Parse($DailyAt)
$actionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$localUpdater`" -ConfigPath `"$configPath`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn),
    (New-ScheduledTaskTrigger -Daily -At $time)
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel LeastPrivilege

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description "Checks the NAS Revit MCP channel and updates this workstation when Revit is closed." -Force | Out-Null

Write-Host "Updater installed: $localUpdater" -ForegroundColor Green
Write-Host "Config written  : $configPath" -ForegroundColor Green
Write-Host "Task registered : $TaskName" -ForegroundColor Green
Write-Host "Run now         : powershell -ExecutionPolicy Bypass -File `"$localUpdater`" -ConfigPath `"$configPath`""
