<#
.SYNOPSIS
    Install the admin-only revAgent usage-intelligence add-on.
#>

[CmdletBinding()]
param(
    [string]$SourceRoot = "",
    [string]$InstallRoot = "",
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports",
    [string]$TaskName = "revAgent Usage Summary Publish",
    [string]$DailyAt = "20:30",
    [string]$WorkRoot = "",
    [int]$Top = 20,
    [int]$TaskSampleLimit = 40,
    [int]$CorrelationWindowMinutes = 45,
    [bool]$IncludeYesterday = $true,
    [string]$CodexSkillsRoot = "",
    [switch]$SkipCorrelation,
    [switch]$SkipCodexSkillInstall,
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

function Resolve-DefaultCodexSkillsRoot {
    $userProfileRoot = if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    }
    else {
        $env:USERPROFILE
    }

    if ([string]::IsNullOrWhiteSpace($userProfileRoot)) {
        throw "Could not resolve the current user's profile path for Codex skill installation."
    }

    return Join-Path $userProfileRoot ".codex\skills"
}

function Resolve-FileSystemPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    $first = @($resolved)[0]
    if ($first.Provider -and $first.Provider.Name -eq "FileSystem" -and -not [string]::IsNullOrWhiteSpace($first.ProviderPath)) {
        return $first.ProviderPath
    }

    return $first.Path
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

function Install-CodexSkillPayload {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$CodexSkillsRoot,
        [Parameter(Mandatory = $true)][string]$SkillName
    )

    if ($SkillName -notmatch '^[A-Za-z0-9._-]+$') {
        throw "Unsafe Codex skill name: $SkillName"
    }

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Usage-intelligence Codex skill source directory was not found: $Source"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Source "SKILL.md") -PathType Leaf)) {
        throw "Usage-intelligence Codex skill is missing SKILL.md: $Source"
    }

    New-Item -ItemType Directory -Path $CodexSkillsRoot -Force | Out-Null
    $skillTarget = Assert-PathUnderRoot -Path (Join-Path $CodexSkillsRoot $SkillName) -Root $CodexSkillsRoot
    if (Test-SamePath -Left $Source -Right $skillTarget) {
        return $skillTarget
    }

    if (Test-Path -LiteralPath $skillTarget -PathType Container) {
        Remove-Item -LiteralPath $skillTarget -Recurse -Force
    }
    New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $skillTarget $item.Name) -Recurse -Force
    }

    return $skillTarget
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
        correlationWindowMinutes = $CorrelationWindowMinutes
        skipCorrelation = [bool]$SkipCorrelation
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
        CorrelationWindowMinutes = $CorrelationWindowMinutes
        IncludeYesterday = [bool]$IncludeYesterday
    }
    if ($SkipCorrelation) {
        $parameters.SkipCorrelation = $true
    }
    if ($RunNow) {
        $parameters.RunNow = $true
    }

    & $taskInstaller @parameters | Out-Host
}

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = Resolve-FileSystemPath -Path (Join-Path $PSScriptRoot "..")
}
else {
    $SourceRoot = Resolve-FileSystemPath -Path $SourceRoot
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

if ([string]::IsNullOrWhiteSpace($CodexSkillsRoot)) {
    $CodexSkillsRoot = Resolve-DefaultCodexSkillsRoot
}
$CodexSkillsRoot = [System.IO.Path]::GetFullPath($CodexSkillsRoot)

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
Copy-DirectoryPayload -Source (Join-Path $SourceRoot "scripts") -Destination (Join-Path $InstallRoot "scripts") -InstallRoot $InstallRoot
Copy-DirectoryPayload -Source (Join-Path $SourceRoot "installer") -Destination (Join-Path $InstallRoot "installer") -InstallRoot $InstallRoot
Copy-DirectoryPayload -Source (Join-Path $SourceRoot "skills") -Destination (Join-Path $InstallRoot "skills") -InstallRoot $InstallRoot
Copy-FilePayload -Source (Join-Path $SourceRoot "addon.json") -Destination (Join-Path $InstallRoot "addon.json") -InstallRoot $InstallRoot

$configPath = Join-Path $InstallRoot "config\usage-intelligence.json"
Write-UsageIntelligenceConfig -Path $configPath

$codexSkillName = "revagent-usage-analyst"
$codexSkillPath = ""
$codexSkillInstalled = $false
if (-not $SkipCodexSkillInstall) {
    $codexSkillPath = Install-CodexSkillPayload `
        -Source (Join-Path $InstallRoot "skills\$codexSkillName") `
        -CodexSkillsRoot $CodexSkillsRoot `
        -SkillName $codexSkillName
    $codexSkillInstalled = $true
}

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
    codexSkillName = $codexSkillName
    codexSkillsRoot = $CodexSkillsRoot
    codexSkillPath = $codexSkillPath
    codexSkillInstalled = [bool]$codexSkillInstalled
    codexSkillInstallSkipped = [bool]$SkipCodexSkillInstall
    runNow = [bool]$RunNow
    skipCorrelation = [bool]$SkipCorrelation
}

$result | ConvertTo-Json -Depth 8
