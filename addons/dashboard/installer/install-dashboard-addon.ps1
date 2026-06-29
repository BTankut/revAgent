<#
.SYNOPSIS
    Install the admin-only revAgent dashboard add-on.
#>

[CmdletBinding()]
param(
    [string]$SourceRoot = "",
    [string]$InstallRoot = "",
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports",
    [string]$ReleaseRoot = "",
    [string]$HostName = "127.0.0.1",
    [int]$Port = 8765,
    [int]$StaleSeconds = 60,
    [int]$OfflineSeconds = 300,
    [string]$TaskName = "revAgent Dashboard Server",
    [switch]$SkipScheduledTasks,
    [switch]$RunNow,
    [switch]$NoHealthCheck
)

$ErrorActionPreference = "Stop"

function ConvertTo-VbsStringLiteral {
    param([AllowNull()][string]$Value)

    return [string]::Concat('"', ([string]$Value).Replace('"', '""'), '"')
}

function Join-WindowsCommandArguments {
    param([string[]]$Arguments)

    $parts = [System.Collections.Generic.List[string]]::new()
    foreach ($argument in $Arguments) {
        $value = [string]$argument
        if ($value -match '[\s"]') {
            $parts.Add('"' + ($value -replace '"', '\"') + '"')
        }
        else {
            $parts.Add($value)
        }
    }

    return ($parts.ToArray() -join " ")
}

function Resolve-DefaultInstallRoot {
    $programDataRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) {
        "C:\ProgramData"
    }
    else {
        $env:ProgramData
    }

    return Join-Path $programDataRoot "DPE\revAgent\addons\dashboard"
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
        throw "Path is outside the dashboard add-on root: $fullPath"
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
        throw "Dashboard add-on source directory was not found: $Source"
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
        throw "Dashboard add-on source file was not found: $Source"
    }

    $safeDestination = Assert-PathUnderRoot -Path $Destination -Root $InstallRoot
    if (Test-SamePath -Left $Source -Right $safeDestination) {
        return
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $safeDestination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $safeDestination -Force
}

function Write-DashboardConfig {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    $resolvedReleaseRoot = if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
        Split-Path -Parent $ReportsRoot
    }
    else {
        $ReleaseRoot
    }

    $config = [ordered]@{
        schemaVersion = "revagent.dashboard.addon.config.v1"
        reportsRoot = $ReportsRoot
        releaseRoot = $resolvedReleaseRoot
        hostName = $HostName
        port = $Port
        staleSeconds = $StaleSeconds
        offlineSeconds = $OfflineSeconds
        updatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Write-HiddenPowerShellLauncher {
    param(
        [Parameter(Mandatory = $true)][string]$LauncherPath,
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ScriptArguments = @()
    )

    New-Item -ItemType Directory -Path (Split-Path -Parent $LauncherPath) -Force | Out-Null
    $powerShellPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    $command = Join-WindowsCommandArguments -Arguments (@(
            $powerShellPath,
            "-STA",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $ScriptPath
        ) + $ScriptArguments)
    $line = [string]::Concat(
        "WScript.Quit CreateObject(""WScript.Shell"").Run(",
        (ConvertTo-VbsStringLiteral -Value $command),
        ", 0, False)")
    Set-Content -LiteralPath $LauncherPath -Value $line -Encoding ASCII -NoNewline
}

function Register-DashboardScheduledTask {
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )

    $startScript = Join-Path $InstallRoot "installer\start-dashboard.ps1"
    $launcherPath = Join-Path $InstallRoot "Run-revAgent-Dashboard-Server-Hidden.vbs"
    Write-HiddenPowerShellLauncher -LauncherPath $launcherPath -ScriptPath $startScript -ScriptArguments @("-ConfigPath", $ConfigPath)

    $wscriptPath = Join-Path $env:WINDIR "System32\wscript.exe"
    $action = New-ScheduledTaskAction -Execute $wscriptPath -Argument ("//B //Nologo `"$launcherPath`"")
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger @($trigger) `
        -Settings $settings `
        -Principal $principal `
        -Description "Starts the local read-only revAgent dashboard server for the coordinator machine." `
        -Force | Out-Null

    if ($RunNow) {
        Start-ScheduledTask -TaskName $TaskName
    }
}

function Test-DashboardHealth {
    param(
        [int]$TimeoutSeconds = 20
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $uri = "http://$HostName`:$Port/api/health"
    do {
        try {
            $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) {
                $body = $response.Content | ConvertFrom-Json
                if ($body.ok -eq $true) {
                    return $true
                }
            }
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    } while ((Get-Date) -lt $deadline)

    return $false
}

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Resolve-DefaultInstallRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
Copy-DirectoryPayload -Source (Join-Path $SourceRoot "server") -Destination (Join-Path $InstallRoot "server") -InstallRoot $InstallRoot
Copy-DirectoryPayload -Source (Join-Path $SourceRoot "public") -Destination (Join-Path $InstallRoot "public") -InstallRoot $InstallRoot
Copy-DirectoryPayload -Source (Join-Path $SourceRoot "installer") -Destination (Join-Path $InstallRoot "installer") -InstallRoot $InstallRoot
Copy-FilePayload -Source (Join-Path $SourceRoot "addon.json") -Destination (Join-Path $InstallRoot "addon.json") -InstallRoot $InstallRoot

$configPath = Join-Path $InstallRoot "config\dashboard.json"
Write-DashboardConfig -Path $configPath

if (-not $SkipScheduledTasks) {
    Register-DashboardScheduledTask -ConfigPath $configPath
}

$healthChecked = $false
$healthy = $null
if ($RunNow -and -not $NoHealthCheck) {
    $healthChecked = $true
    $healthy = Test-DashboardHealth
    if (-not $healthy) {
        throw "Dashboard add-on was installed, but local health check did not become healthy at http://$HostName`:$Port/api/health."
    }
}

$result = [ordered]@{
    schemaVersion = "revagent.dashboard.addon.install.v1"
    installed = $true
    installRoot = $InstallRoot
    configPath = $configPath
    taskName = if ($SkipScheduledTasks) { "" } else { $TaskName }
    scheduledTaskInstalled = -not [bool]$SkipScheduledTasks
    runNow = [bool]$RunNow
    healthChecked = $healthChecked
    healthy = $healthy
}

$result | ConvertTo-Json -Depth 8
