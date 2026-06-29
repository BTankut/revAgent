<#
.SYNOPSIS
    Install the admin-only revAgent usage-intelligence add-on.
#>

[CmdletBinding()]
param(
    [string]$SourceRoot = "",
    [string]$InstallRoot = "",
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports",
    [string]$TaskName = "revAgent Usage Summary Publish",
    [string]$DailyAt = "20:30",
    [string]$WorkRoot = "",
    [int]$Top = 20,
    [int]$TaskSampleLimit = 40,
    [bool]$IncludeYesterday = $true,
    [switch]$SkipScheduledTasks,
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"

function Resolve-DefaultInstallRoot {
    $programDataRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) {
        "C:\ProgramData"
    }
    else {
        $env:ProgramData
    }

    return Join-Path $programDataRoot "DPE\revAgent\addons\usage-intelligence"
}

function Assert-PathUnderRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    if (-not ($fullPath.StartsWith($fullRoot + "\", [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($fullPath, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "Path is outside the usage-intelligence add-on root: $fullPath"
    }

    return $fullPath
}

function Test-SamePath {
    param(
        [string]$Left,
        [string]$Right
    )

    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        return $false
    }

    return [string]::Equals(
        [System.IO.Path]::GetFullPath($Left).TrimEnd("\", "/"),
        [System.IO.Path]::GetFullPath($Right).TrimEnd("\", "/"),
        [System.StringComparison]::OrdinalIgnoreCase)
}

function Copy-DirectoryPayload {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Usage-intelligence add-on source directory was not found: $Source"
    }

    $safeDestination = Assert-PathUnderRoot -Path $Destination -Root $InstallRoot
    if (Test-SamePath -Left $Source -Right $safeDestination) {
        return
    }

    if (Test-Path -LiteralPath $safeDestination -PathType Container) {
        Remove-Item -LiteralPath $safeDestination -Recurse -Force
    }
    New-Item -ItemType Directory -Path $safeDestination -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $safeDestination -Recurse -Force
    }
}

function Copy-FilePayload {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Usage-intelligence add-on source file was not found: $Source"
    }

    $safeDestination = Assert-PathUnderRoot -Path $Destination -Root $InstallRoot
    if (Test-SamePath -Left $Source -Right $safeDestination) {
        return
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $safeDestination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $safeDestination -Force
}

function Write-UsageIntelligenceConfig {
    param([Parameter(Mandatory = $true)][string]$Path)

    $config = [ordered]@{
        schemaVersion = "revagent.usage-intelligence.addon.config.v1"
        reportsRoot = $ReportsRoot
        taskName = $TaskName
        dailyAt = $DailyAt
        workRoot = $WorkRoot
        includeYesterday = [bool]$IncludeYesterday
        top = $Top
        taskSampleLimit = $TaskSampleLimit
        updatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Install-UsageSummaryTask {
    $taskInstaller = Join-Path $InstallRoot "scripts\install-usage-summary-task.ps1"
    if (-not (Test-Path -LiteralPath $taskInstaller -PathType Leaf)) {
        throw "Usage summary task installer was not found after add-on payload install: $taskInstaller"
    }

    $parameters = @{
        ReportsRoot = $ReportsRoot
        TaskName = $TaskName
        DailyAt = $DailyAt
        WorkRoot = $WorkRoot
        PublishScriptPath = (Join-Path $InstallRoot "scripts\publish-usage-summary.ps1")
        Top = $Top
        TaskSampleLimit = $TaskSampleLimit
        IncludeYesterday = [bool]$IncludeYesterday
    }
    if ($RunNow) {
        $parameters.RunNow = $true
    }

    & $taskInstaller @parameters | Out-Host
}

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Resolve-DefaultInstallRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
    $WorkRoot = Join-Path $InstallRoot "state"
}
$WorkRoot = [System.IO.Path]::GetFullPath($WorkRoot)

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
Copy-DirectoryPayload -Source (Join-Path $SourceRoot "scripts") -Destination (Join-Path $InstallRoot "scripts") -InstallRoot $InstallRoot
Copy-DirectoryPayload -Source (Join-Path $SourceRoot "installer") -Destination (Join-Path $InstallRoot "installer") -InstallRoot $InstallRoot
Copy-FilePayload -Source (Join-Path $SourceRoot "addon.json") -Destination (Join-Path $InstallRoot "addon.json") -InstallRoot $InstallRoot

$configPath = Join-Path $InstallRoot "config\usage-intelligence.json"
Write-UsageIntelligenceConfig -Path $configPath

if (-not $SkipScheduledTasks) {
    Install-UsageSummaryTask
}

$result = [ordered]@{
    schemaVersion = "revagent.usage-intelligence.addon.install.v1"
    installed = $true
    installRoot = $InstallRoot
    configPath = $configPath
    workRoot = $WorkRoot
    taskName = if ($SkipScheduledTasks) { "" } else { $TaskName }
    scheduledTaskInstalled = -not [bool]$SkipScheduledTasks
    runNow = [bool]$RunNow
}

$result | ConvertTo-Json -Depth 8
