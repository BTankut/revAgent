<#
.SYNOPSIS
    Install the workstation-side Codex session context exporter task.

.DESCRIPTION
    This task runs on production workstations that use Codex with revAgent. It
    exports bounded Codex session context to the NAS reports tree so the
    coordinator usage summary can correlate user intent with revAgent telemetry.
#>

[CmdletBinding()]
param(
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports",
    [string]$TaskName = "revAgent Codex Session Context Export",
    [string]$DailyAt = "20:15",
    [string]$WorkRoot = "",
    [string]$PublishScriptPath = "",
    [string]$SessionRoot = "",
    [int]$MaxTextChars = 600,
    [int]$MaxUserRequests = 12,
    [int]$MaxAssistantOutcomes = 8,
    [int]$MaxToolCalls = 80,
    [bool]$IncludeYesterday = $false,
    [string]$StartDateUtc = "2026-06-29",
    [int]$LookbackDays = 0,
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"

function Resolve-RevAgentRepositoryRoot {
    $cursor = [System.IO.DirectoryInfo](Get-Item -LiteralPath $PSScriptRoot)
    while ($cursor) {
        if (Test-Path -LiteralPath (Join-Path $cursor.FullName "installer\lib") -PathType Container) {
            return $cursor.FullName
        }
        $cursor = $cursor.Parent
    }
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$repoRoot = Resolve-RevAgentRepositoryRoot
$canonicalLibRootCandidates = @(
    (Join-Path $repoRoot "installer\lib"),
    (Join-Path (Split-Path -Parent $repoRoot) "installer\lib"),
    "C:\ProgramData\DPE\revAgent\package\installer\lib",
    "C:\ProgramData\DPE\revAgent\updater\lib"
)
$legacyCompatibilityLibRootCandidates = @(
    "C:\ProgramData\DPE\RevitMCP\package\installer\lib",
    "C:\ProgramData\DPE\RevitMCP\updater\lib"
)
$libRootCandidates = @(
    $canonicalLibRootCandidates + $legacyCompatibilityLibRootCandidates
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }

$libRoot = $libRootCandidates | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($libRoot)) {
    throw "revAgent installer library folder was not found."
}

Import-Module (Join-Path $libRoot "RevAgent.HiddenLauncher.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.ScheduledTask.psm1") -Force

function Invoke-SchtasksCreateDailyTask {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$LauncherPath,
        [Parameter(Mandatory = $true)][string]$DailyAt,
        [Parameter(Mandatory = $true)][string]$PrimaryErrorMessage
    )

    $wscriptPath = Resolve-RevAgentWScriptPath
    $taskRun = Join-RevAgentWindowsCommandArguments -Arguments @($wscriptPath, "//B", "//Nologo", $LauncherPath)
    $startTime = ([datetime]::Parse($DailyAt)).ToString("HH:mm", [System.Globalization.CultureInfo]::InvariantCulture)
    $output = & schtasks.exe /Create /TN $TaskName /SC DAILY /ST $startTime /TR $taskRun /F 2>&1
    if ($LASTEXITCODE -ne 0) {
        $outputText = (($output | ForEach-Object { [string]$_ }) -join " ").Trim()
        throw "Could not register scheduled task '$TaskName'. Register-ScheduledTask error: $PrimaryErrorMessage. schtasks.exe error: $outputText"
    }

    return "schtasks.exe"
}

function Register-HkcuRunStartup {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$LauncherPath
    )

    $wscriptPath = Resolve-RevAgentWScriptPath
    $taskRun = Join-RevAgentWindowsCommandArguments -Arguments @($wscriptPath, "//B", "//Nologo", $LauncherPath)
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    if (-not (Test-Path -LiteralPath $runKey)) {
        New-Item -Path $runKey -Force | Out-Null
    }
    Set-ItemProperty -Path $runKey -Name $TaskName -Value $taskRun -Force
    return "HKCU Run"
}

function Register-CodexSessionExportScheduledTask {
    param(
        [Parameter(Mandatory = $true)]$Action,
        [Parameter(Mandatory = $true)]$Trigger,
        [Parameter(Mandatory = $true)]$Settings,
        [Parameter(Mandatory = $true)]$Principal,
        [Parameter(Mandatory = $true)][string]$LauncherPath
    )

    try {
        Register-ScheduledTask `
            -TaskName $TaskName `
            -Action $Action `
            -Trigger @($Trigger) `
            -Settings $Settings `
            -Principal $Principal `
            -Description "Exports bounded local Codex session context for revAgent usage correlation at $DailyAt." `
            -Force `
            -ErrorAction Stop | Out-Null
        return "Register-ScheduledTask"
    }
    catch {
        $primaryErrorMessage = $_.Exception.Message
        try {
            return Invoke-SchtasksCreateDailyTask `
                -TaskName $TaskName `
                -LauncherPath $LauncherPath `
                -DailyAt $DailyAt `
                -PrimaryErrorMessage $primaryErrorMessage
        }
        catch {
            return Register-HkcuRunStartup -TaskName $TaskName -LauncherPath $LauncherPath
        }
    }
}

if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
    $programDataRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { "C:\ProgramData" } else { $env:ProgramData }
    $WorkRoot = Join-Path $programDataRoot "DPE\revAgent\addons\usage-intelligence\state"
}

if ([string]::IsNullOrWhiteSpace($PublishScriptPath)) {
    $PublishScriptPath = @(
        (Join-Path $PSScriptRoot "publish-codex-session-context.ps1"),
        "C:\ProgramData\DPE\revAgent\addons\usage-intelligence\scripts\publish-codex-session-context.ps1"
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

if ([string]::IsNullOrWhiteSpace($PublishScriptPath) -or -not (Test-Path -LiteralPath $PublishScriptPath -PathType Leaf)) {
    throw "Codex session context publisher was not found: $PublishScriptPath"
}

New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null

$configPath = Join-Path $WorkRoot "codex-session-export-task-config.json"
$reportPath = Join-Path $WorkRoot "codex-session-export-latest.json"
$launcherPath = Join-Path $WorkRoot "Run-revAgent-Codex-Session-Export-Hidden.vbs"
$machineName = $env:COMPUTERNAME
$userName = $env:USERNAME

$config = [ordered]@{
    schemaVersion = 1
    app = "revAgent"
    taskName = $TaskName
    dailyAt = $DailyAt
    reportsRoot = $ReportsRoot
    publishScriptPath = $PublishScriptPath
    workRoot = $WorkRoot
    reportPath = $reportPath
    sessionRoot = $SessionRoot
    includeYesterday = [bool]$IncludeYesterday
    startDateUtc = $StartDateUtc
    lookbackDays = $LookbackDays
    maxTextChars = $MaxTextChars
    maxUserRequests = $MaxUserRequests
    maxAssistantOutcomes = $MaxAssistantOutcomes
    maxToolCalls = $MaxToolCalls
    installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    installedByComputer = $machineName
    installedByUser = $userName
}
$config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding UTF8

$scriptArguments = @(
    "-ReportsRoot", $ReportsRoot,
    "-ReportPath", $reportPath,
    "-MachineName", $machineName,
    "-UserName", $userName,
    "-MaxTextChars", [string]$MaxTextChars,
    "-MaxUserRequests", [string]$MaxUserRequests,
    "-MaxAssistantOutcomes", [string]$MaxAssistantOutcomes,
    "-MaxToolCalls", [string]$MaxToolCalls,
    "-StartDateUtc", $StartDateUtc,
    "-LookbackDays", [string]$LookbackDays
)
if (-not [string]::IsNullOrWhiteSpace($SessionRoot)) {
    $scriptArguments += @("-SessionRoot", $SessionRoot)
}
if ($IncludeYesterday) {
    $scriptArguments += "-IncludeYesterday"
}

Write-RevAgentHiddenPowerShellLauncher `
    -LauncherPath $launcherPath `
    -ScriptPath $PublishScriptPath `
    -ScriptArguments $scriptArguments `
    -WaitForExit

$action = New-RevAgentHiddenUpdaterScheduledTaskAction -LauncherPath $launcherPath
$trigger = New-RevAgentDailyUpdateTrigger -DailyAt $DailyAt
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

$registrationMethod = Register-CodexSessionExportScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -LauncherPath $launcherPath

Write-Host "Task registered : $TaskName" -ForegroundColor Green
if ([string]::Equals($registrationMethod, "HKCU Run", [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "Task schedule   : user logon startup fallback" -ForegroundColor Yellow
}
else {
    Write-Host "Task schedule   : daily at $DailyAt" -ForegroundColor Green
}
Write-Host "Task method     : $registrationMethod" -ForegroundColor Green
Write-Host "Launcher        : $launcherPath" -ForegroundColor Green
Write-Host "Config          : $configPath" -ForegroundColor Green
Write-Host "Latest report   : $reportPath" -ForegroundColor Green

if ($RunNow) {
    Write-Host "Running Codex session context publisher now..." -ForegroundColor Yellow
    $publishParameters = @{
        ReportsRoot = $ReportsRoot
        ReportPath = $reportPath
        MachineName = $machineName
        UserName = $userName
        MaxTextChars = $MaxTextChars
        MaxUserRequests = $MaxUserRequests
        MaxAssistantOutcomes = $MaxAssistantOutcomes
        MaxToolCalls = $MaxToolCalls
        StartDateUtc = $StartDateUtc
        LookbackDays = $LookbackDays
    }
    if (-not [string]::IsNullOrWhiteSpace($SessionRoot)) {
        $publishParameters["SessionRoot"] = $SessionRoot
    }
    if ($IncludeYesterday) {
        $publishParameters["IncludeYesterday"] = $true
    }

    & $PublishScriptPath @publishParameters | Out-Host
}
