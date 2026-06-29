<#
.SYNOPSIS
    Install the local-machine scheduled publisher for revAgent usage summaries.

.DESCRIPTION
    This task should be installed on exactly one coordinator workstation. It
    runs publish-usage-summary.ps1 daily, normally after office hours, and
    writes summaries under the NAS reports root.
#>

[CmdletBinding()]
param(
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports",
    [string]$TaskName = "revAgent Usage Summary Publish",
    [string]$DailyAt = "20:30",
    [string]$WorkRoot = "",
    [string]$PublishScriptPath = "",
    [int]$Top = 20,
    [int]$TaskSampleLimit = 40,
    [bool]$IncludeYesterday = $true,
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
$libRootCandidates = @(
    (Join-Path $repoRoot "installer\lib"),
    (Join-Path (Split-Path -Parent $repoRoot) "installer\lib"),
    "C:\ProgramData\DPE\revAgent\package\installer\lib",
    "C:\ProgramData\DPE\revAgent\updater\lib",
    "C:\ProgramData\DPE\RevitMCP\package\installer\lib",
    "C:\ProgramData\DPE\RevitMCP\updater\lib"
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

function Register-UsageSummaryScheduledTask {
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
            -Description "Publishes daily revAgent usage summaries from NAS reports at $DailyAt on the coordinator workstation." `
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
    $candidates = @(
        (Join-Path $PSScriptRoot "publish-usage-summary.ps1"),
        "C:\ProgramData\DPE\revAgent\addons\usage-intelligence\scripts\publish-usage-summary.ps1",
        "C:\ProgramData\DPE\revAgent\package\scripts\publish-usage-summary.ps1",
        "C:\ProgramData\DPE\RevitMCP\package\scripts\publish-usage-summary.ps1"
    )
    $PublishScriptPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

if ([string]::IsNullOrWhiteSpace($PublishScriptPath) -or -not (Test-Path -LiteralPath $PublishScriptPath -PathType Leaf)) {
    throw "Usage summary publisher was not found: $PublishScriptPath"
}

New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null

$configPath = Join-Path $WorkRoot "usage-summary-task-config.json"
$launcherPath = Join-Path $WorkRoot "Run-revAgent-Usage-Summary-Hidden.vbs"
$config = [ordered]@{
    schemaVersion = 1
    app = "revAgent"
    taskName = $TaskName
    dailyAt = $DailyAt
    reportsRoot = $ReportsRoot
    publishScriptPath = $PublishScriptPath
    workRoot = $WorkRoot
    includeYesterday = [bool]$IncludeYesterday
    top = $Top
    taskSampleLimit = $TaskSampleLimit
    installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    installedByComputer = $env:COMPUTERNAME
    installedByUser = $env:USERNAME
}
$config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding UTF8

$scriptArguments = @(
    "-ReportsRoot", $ReportsRoot,
    "-Top", [string]$Top,
    "-TaskSampleLimit", [string]$TaskSampleLimit
)
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

$registrationMethod = Register-UsageSummaryScheduledTask `
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

if ($RunNow) {
    Write-Host "Running summary publisher now..." -ForegroundColor Yellow
    $publishParameters = @{
        ReportsRoot = $ReportsRoot
        Top = $Top
        TaskSampleLimit = $TaskSampleLimit
    }
    if ($IncludeYesterday) {
        $publishParameters["IncludeYesterday"] = $true
    }

    & $PublishScriptPath @publishParameters | Out-Host
}
