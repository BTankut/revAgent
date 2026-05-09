<#
.SYNOPSIS
    Install the workstation updater and register a scheduled update check.

.DESCRIPTION
    Copies update-from-nas.ps1 to a local managed folder, writes updater config,
    and registers a per-user scheduled task. The task reads the NAS channel
    manifest at logon and on a repeated interval. Revit-loaded payload updates
    are deferred while Revit is open; non-Revit payload updates may continue.
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
    [ValidateRange(5, 1440)]
    [int]$CheckIntervalMinutes = 30,
    [ValidateRange(15, 10080)]
    [int]$NotificationThrottleMinutes = 240,
    [string]$LogPath = "",
    [switch]$SkipNpmInstall,
    [switch]$SkipCodexMcpRegistration,
    [switch]$SkipCodexUserIntegration,
    [switch]$NoScheduledTask,
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"
$script:RevitMcpTranscriptStarted = $false
$script:RevitMcpLogPath = ""
$script:PreviousTranscriptActive = $env:REVIT_MCP_TRANSCRIPT_ACTIVE
$script:PreviousLogPath = $env:REVIT_MCP_LOG_PATH

function Initialize-RevitMcpTranscript {
    param(
        [string]$PreferredWorkRoot,
        [string]$RequestedLogPath,
        [string]$Prefix
    )

    if ($env:REVIT_MCP_TRANSCRIPT_ACTIVE -eq "1") {
        $script:RevitMcpLogPath = $env:REVIT_MCP_LOG_PATH
        return
    }

    $path = $RequestedLogPath
    if ([string]::IsNullOrWhiteSpace($path)) {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $logRoot = Join-Path $PreferredWorkRoot "logs"
        $path = Join-Path $logRoot ("{0}-{1}.log" -f $Prefix, $stamp)
    }

    try {
        $logDir = Split-Path -Parent $path
        if (-not [string]::IsNullOrWhiteSpace($logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
    }
    catch {
        $path = Join-Path $env:TEMP ("revit-mcp-{0}-{1}.log" -f $Prefix, (Get-Date -Format "yyyyMMdd-HHmmss"))
    }

    try {
        Start-Transcript -Path $path -Append | Out-Null
        $script:RevitMcpTranscriptStarted = $true
        $script:RevitMcpLogPath = $path
        $env:REVIT_MCP_TRANSCRIPT_ACTIVE = "1"
        $env:REVIT_MCP_LOG_PATH = $path
        Write-Host "Install log     : $path" -ForegroundColor Green
    }
    catch {
        $script:RevitMcpLogPath = $path
        Write-Warning "Could not start install transcript: $($_.Exception.Message). Intended log path: $path"
    }
}

function Complete-RevitMcpTranscript {
    if ($script:RevitMcpTranscriptStarted) {
        try {
            Stop-Transcript | Out-Null
        }
        catch {}
    }

    if ($null -eq $script:PreviousTranscriptActive) {
        Remove-Item Env:\REVIT_MCP_TRANSCRIPT_ACTIVE -ErrorAction SilentlyContinue
    }
    else {
        $env:REVIT_MCP_TRANSCRIPT_ACTIVE = $script:PreviousTranscriptActive
    }

    if ($null -eq $script:PreviousLogPath) {
        Remove-Item Env:\REVIT_MCP_LOG_PATH -ErrorAction SilentlyContinue
    }
    else {
        $env:REVIT_MCP_LOG_PATH = $script:PreviousLogPath
    }
}

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

function Write-UpdaterCommandFiles {
    param(
        [string]$UpdaterPath,
        [string]$UpdaterConfigPath,
        [string]$UpdaterWorkRoot,
        [string]$VersionToolPath = "",
        [int]$CheckIntervalMinutes = 30,
        [switch]$InstallStartupFallback
    )

    $manualCommandPath = Join-Path $UpdaterWorkRoot "Update-Revit-MCP-Now.cmd"
    $manualCommandLines = @(
        "@echo off",
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$UpdaterPath`" -ConfigPath `"$UpdaterConfigPath`"",
        "pause"
    )
    $manualCommandLines | Set-Content -LiteralPath $manualCommandPath -Encoding ASCII

    if (-not [string]::IsNullOrWhiteSpace($VersionToolPath)) {
        $versionCommandPath = Join-Path $UpdaterWorkRoot "Show-Revit-MCP-Version.cmd"
        $versionCommandLines = @(
            "@echo off",
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$VersionToolPath`" -ConfigPath `"$UpdaterConfigPath`"",
            "pause"
        )
        $versionCommandLines | Set-Content -LiteralPath $versionCommandPath -Encoding ASCII
    }

    if ($InstallStartupFallback) {
        $startupRoot = [Environment]::GetFolderPath("Startup")
        if ([string]::IsNullOrWhiteSpace($startupRoot)) {
            throw "Could not resolve the current user's Startup folder."
        }

        New-Item -ItemType Directory -Path $startupRoot -Force | Out-Null
        $loopScriptPath = Join-Path $UpdaterWorkRoot "auto-update-loop.ps1"
        $loopScriptLines = @(
            "param(",
            "    [Parameter(Mandatory = `$true)]",
            "    [string]`$UpdaterPath,",
            "    [Parameter(Mandatory = `$true)]",
            "    [string]`$ConfigPath,",
            "    [int]`$IntervalMinutes = $CheckIntervalMinutes",
            ")",
            "",
            "`$ErrorActionPreference = `"Continue`"",
            "`$intervalSeconds = [Math]::Max(300, `$IntervalMinutes * 60)",
            "while (`$true) {",
            "    try {",
            "        & `$UpdaterPath -ConfigPath `$ConfigPath -NotifyUser",
            "    }",
            "    catch {",
            "    }",
            "    Start-Sleep -Seconds `$intervalSeconds",
            "}"
        )
        $loopScriptLines | Set-Content -LiteralPath $loopScriptPath -Encoding ASCII

        $startupCommandPath = Join-Path $startupRoot "Revit MCP Auto Update.cmd"
        $startupCommandLines = @(
            "@echo off",
            "powershell.exe -STA -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$loopScriptPath`" -UpdaterPath `"$UpdaterPath`" -ConfigPath `"$UpdaterConfigPath`" -IntervalMinutes $CheckIntervalMinutes"
        )
        $startupCommandLines | Set-Content -LiteralPath $startupCommandPath -Encoding ASCII
        Write-Host "Startup fallback: $startupCommandPath" -ForegroundColor Yellow
        Write-Host "Startup fallback interval: every $CheckIntervalMinutes minutes" -ForegroundColor Yellow
    }

    return $manualCommandPath
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

Initialize-RevitMcpTranscript -PreferredWorkRoot $WorkRoot -RequestedLogPath $LogPath -Prefix "install"

try {
$RevitInstallRoot = Resolve-RevitInstallRoot -RequestedRoot $RevitInstallRoot -Version $RevitVersion

New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null

$localUpdater = Join-Path $WorkRoot "update-from-nas.ps1"
$localVersionTool = Join-Path $WorkRoot "show-installed-version.ps1"
$configPath = Join-Path $WorkRoot "updater-config.json"
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "update-from-nas.ps1") -Destination $localUpdater -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "show-installed-version.ps1") -Destination $localVersionTool -Force

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
    checkIntervalMinutes = $CheckIntervalMinutes
    notifyUser = $true
    notificationThrottleMinutes = $NotificationThrottleMinutes
    logsRoot = (Join-Path $WorkRoot "logs")
    installLogPath = $script:RevitMcpLogPath
    installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
}
Write-JsonFile -Path $configPath -Value $config
$manualCommandPath = Write-UpdaterCommandFiles -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -UpdaterWorkRoot $WorkRoot -VersionToolPath $localVersionTool -CheckIntervalMinutes $CheckIntervalMinutes
$versionCommandPath = Join-Path $WorkRoot "Show-Revit-MCP-Version.cmd"

if ($NoScheduledTask) {
    Write-Host "Updater installed without scheduled task."
    Write-Host "Run manually: $manualCommandPath"
    Write-Host "Show version: $versionCommandPath"
    if ($RunNow) {
        Write-Host ""
        Write-Host "Running initial update check..."
        Invoke-InitialUpdateCheck -UpdaterPath $localUpdater -UpdaterConfigPath $configPath
    }
    return
}

$time = [datetime]::Parse($DailyAt)
$actionArgs = "-STA -NoProfile -ExecutionPolicy Bypass -File `"$localUpdater`" -ConfigPath `"$configPath`" -NotifyUser"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At $time
$repetitionTemplate = New-ScheduledTaskTrigger -Once -At $time -RepetitionInterval (New-TimeSpan -Minutes $CheckIntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 1)
$dailyTrigger.Repetition = $repetitionTemplate.Repetition
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn),
    $dailyTrigger
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description "Checks the NAS Revit MCP channel at logon and every $CheckIntervalMinutes minutes. Revit-loaded payload updates are deferred while Revit is open." -Force | Out-Null
    Write-Host "Task registered : $TaskName" -ForegroundColor Green
    Write-Host "Task interval   : every $CheckIntervalMinutes minutes" -ForegroundColor Green
}
catch {
    Write-Warning "Scheduled task could not be registered: $($_.Exception.Message)"
    Write-UpdaterCommandFiles -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -UpdaterWorkRoot $WorkRoot -VersionToolPath $localVersionTool -CheckIntervalMinutes $CheckIntervalMinutes -InstallStartupFallback | Out-Null
}

Write-Host "Updater installed: $localUpdater" -ForegroundColor Green
Write-Host "Config written  : $configPath" -ForegroundColor Green
Write-Host "Run manually    : $manualCommandPath" -ForegroundColor Green
Write-Host "Show version    : $versionCommandPath" -ForegroundColor Green

if ($RunNow) {
    Write-Host ""
    Write-Host "Running initial update check..."
    Invoke-InitialUpdateCheck -UpdaterPath $localUpdater -UpdaterConfigPath $configPath
}
}
catch {
    Write-Host ""
    Write-Host "Revit MCP updater install failed: $($_.Exception.Message)" -ForegroundColor Red
    if (-not [string]::IsNullOrWhiteSpace($script:RevitMcpLogPath)) {
        Write-Host "Install log: $script:RevitMcpLogPath" -ForegroundColor Yellow
    }
    throw
}
finally {
    Complete-RevitMcpTranscript
}
