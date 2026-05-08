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

    [string]$InstallRoot = "",
    [string]$WorkRoot = "",
    [string]$PackageTarget = "",
    [string]$ServerTarget = "",
    [string]$WorkspaceAgentsTarget = "",
    [string]$RevitInstallRoot = "",
    [ValidateSet("2022")]
    [string]$RevitVersion = "2022",
    [string[]]$LegacyServerTargets = @(),
    [string]$ReportsRoot = "",
    [string]$TaskName = "Revit MCP Auto Update",
    [string]$DailyAt = "09:00",
    [switch]$SkipNpmInstall,
    [switch]$SkipCodexMcpRegistration,
    [switch]$SkipCodexUserIntegration,
    [switch]$NoScheduledTask,
    [switch]$RunNow
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

function Invoke-InitialUpdateCheck {
    param(
        [string]$UpdaterPath,
        [string]$UpdaterConfigPath
    )

    if ($env:REVIT_MCP_AUDIT_ONLY) {
        & $UpdaterPath -ConfigPath $UpdaterConfigPath -AuditOnly
        return
    }

    & $UpdaterPath -ConfigPath $UpdaterConfigPath
}

function Resolve-RevitInstallRoot {
    param(
        [string]$RequestedRoot,
        [string]$Version
    )

    $candidates = @(
        $RequestedRoot,
        $env:REVIT_INSTALL_ROOT,
        (Join-Path ${env:ProgramFiles} "Autodesk\Revit $Version"),
        (Join-Path ${env:ProgramFiles} "Autodesk\Revit$Version"),
        (Join-Path ${env:ProgramFiles(x86)} "Autodesk\Revit $Version")
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    $registryCandidates = [System.Collections.Generic.List[string]]::new()
    foreach ($registryRoot in @(
            "HKLM:\SOFTWARE\Autodesk\Revit\$Version",
            "HKLM:\SOFTWARE\Autodesk\Revit\Autodesk Revit $Version",
            "HKLM:\SOFTWARE\WOW6432Node\Autodesk\Revit\$Version",
            "HKLM:\SOFTWARE\WOW6432Node\Autodesk\Revit\Autodesk Revit $Version"
        )) {
        if (-not (Test-Path -LiteralPath $registryRoot)) { continue }
        try {
            $item = Get-ItemProperty -LiteralPath $registryRoot -ErrorAction Stop
            foreach ($name in @("InstallationLocation", "InstallLocation", "InstallDir", "ProductInstallPath")) {
                if ($item.PSObject.Properties.Name -contains $name) {
                    $value = [string]$item.$name
                    if (-not [string]::IsNullOrWhiteSpace($value)) {
                        $registryCandidates.Add($value)
                    }
                }
            }
        }
        catch {}
    }
    $candidates += $registryCandidates.ToArray()

    foreach ($candidate in $candidates) {
        $full = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($candidate)).TrimEnd("\")
        if ((Test-Path -LiteralPath $full -PathType Container) -and
            (Test-Path -LiteralPath (Join-Path $full "Revit.exe")) -and
            (Test-Path -LiteralPath (Join-Path $full "RevitAPI.dll"))) {
            Write-Host "Revit $Version found: $full"
            return $full
        }
    }

    throw "Revit $Version install directory could not be found. Checked: $($candidates -join '; ')"
}

$programDataRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { "C:\ProgramData" } else { $env:ProgramData }
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $programDataRoot "DPE\RevitMCP"
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
if ([string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
    $WorkspaceAgentsTarget = Join-Path $InstallRoot "codex\AGENTS.md"
}
$RevitInstallRoot = Resolve-RevitInstallRoot -RequestedRoot $RevitInstallRoot -Version $RevitVersion

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
    installRoot = $InstallRoot
    workRoot = $WorkRoot
    packageTarget = $PackageTarget
    serverTarget = $ServerTarget
    workspaceAgentsTarget = $WorkspaceAgentsTarget
    revitInstallRoot = $RevitInstallRoot
    revitVersion = $RevitVersion
    legacyServerTargets = $LegacyServerTargets
    reportsRoot = $ReportsRoot
    skipNpmInstall = [bool]$SkipNpmInstall
    skipCodexMcpRegistration = [bool]$SkipCodexMcpRegistration
    skipCodexUserIntegration = [bool]$SkipCodexUserIntegration
    installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
}
Write-JsonFile -Path $configPath -Value $config

if ($NoScheduledTask) {
    Write-Host "Updater installed without scheduled task."
    Write-Host "Run manually: powershell -ExecutionPolicy Bypass -File `"$localUpdater`" -ConfigPath `"$configPath`""
    if ($RunNow) {
        Write-Host ""
        Write-Host "Running initial update check..."
        Invoke-InitialUpdateCheck -UpdaterPath $localUpdater -UpdaterConfigPath $configPath
    }
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

if ($RunNow) {
    Write-Host ""
    Write-Host "Running initial update check..."
    Invoke-InitialUpdateCheck -UpdaterPath $localUpdater -UpdaterConfigPath $configPath
}
