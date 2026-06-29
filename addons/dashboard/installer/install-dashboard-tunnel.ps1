<#
.SYNOPSIS
    Install or migrate the admin-only revAgent dashboard Cloudflare tunnel.
#>

[CmdletBinding()]
param(
    [string]$InstallRoot = "",
    [string]$LegacyTunnelRoot = "C:\ProgramData\DPE\RevitMCP\cloudflared",
    [string]$CloudflaredExe = "",
    [string]$ConfigPath = "",
    [string]$CredentialsPath = "",
    [string]$DashboardHealthUrl = "http://127.0.0.1:8765/api/health",
    [string]$PublicHealthUrl = "",
    [string]$TaskName = "revAgent Dashboard Tunnel",
    [switch]$SkipScheduledTasks,
    [switch]$RunNow,
    [switch]$NoHealthCheck,
    [switch]$StopLegacyOnSuccess,
    [switch]$RemoveLegacyOnSuccess
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

function Assert-LegacyTunnelRootIsNarrow {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/")
    $leaf = Split-Path -Leaf $fullPath
    if ($leaf -ine "cloudflared" -or $fullPath -notmatch '\\DPE\\RevitMCP\\') {
        throw "Legacy tunnel cleanup root is not narrow enough: $fullPath"
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

function Resolve-CloudflaredExe {
    if (-not [string]::IsNullOrWhiteSpace($CloudflaredExe)) {
        if (-not (Test-Path -LiteralPath $CloudflaredExe -PathType Leaf)) {
            throw "cloudflared.exe was not found: $CloudflaredExe"
        }
        return [System.IO.Path]::GetFullPath($CloudflaredExe)
    }

    $legacyCandidate = Join-Path $LegacyTunnelRoot "cloudflared.exe"
    if (Test-Path -LiteralPath $legacyCandidate -PathType Leaf) {
        return [System.IO.Path]::GetFullPath($legacyCandidate)
    }

    $command = Get-Command "cloudflared.exe" -ErrorAction SilentlyContinue
    if ($command) {
        return [System.IO.Path]::GetFullPath($command.Source)
    }

    throw "cloudflared.exe was not found. Pass -CloudflaredExe or place it under the legacy tunnel root."
}

function Resolve-TunnelConfigPath {
    if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
        if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
            throw "Dashboard tunnel config was not found: $ConfigPath"
        }
        return [System.IO.Path]::GetFullPath($ConfigPath)
    }

    foreach ($name in @("config.yml", "config.yaml")) {
        $candidate = Join-Path $LegacyTunnelRoot $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }

    throw "Dashboard tunnel config was not found. Pass -ConfigPath or keep config.yml/config.yaml under the legacy tunnel root."
}

function Get-YamlScalarValue {
    param(
        [string]$Line,
        [string]$Key
    )

    $escapedKey = [regex]::Escape($Key)
    if ($Line -match "^\s*$escapedKey\s*:\s*(.+)\s*$") {
        $value = $Matches[1].Trim()
        if ($value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            return $value.Substring(1, $value.Length - 2)
        }
        return $value
    }

    return $null
}

function ConvertTo-YamlSingleQuotedScalar {
    param([AllowNull()][string]$Value)

    return [string]::Concat("'", ([string]$Value).Replace("'", "''"), "'")
}

function Resolve-PathRelativeTo {
    param(
        [string]$Path,
        [string]$BaseDirectory
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $BaseDirectory $Path))
}

function Resolve-TunnelCredentialsPath {
    param(
        [AllowNull()][AllowEmptyString()][string]$CredentialValue,
        [Parameter(Mandatory = $true)][string]$SourceConfigDirectory,
        [AllowNull()][AllowEmptyString()][string]$ExplicitCredentialsPath,
        [AllowNull()][AllowEmptyString()][string]$TunnelId
    )

    $candidates = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($ExplicitCredentialsPath)) {
        $candidates.Add((Resolve-PathRelativeTo -Path $ExplicitCredentialsPath -BaseDirectory (Get-Location).Path))
    }

    if (-not [string]::IsNullOrWhiteSpace($CredentialValue)) {
        $resolvedCredentialValue = Resolve-PathRelativeTo -Path $CredentialValue -BaseDirectory $SourceConfigDirectory
        $candidates.Add($resolvedCredentialValue)

        $credentialFileName = Split-Path -Leaf $CredentialValue
        if (-not [string]::IsNullOrWhiteSpace($credentialFileName)) {
            $candidates.Add((Join-Path $SourceConfigDirectory $credentialFileName))
            if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
                $candidates.Add((Join-Path (Join-Path $env:USERPROFILE ".cloudflared") $credentialFileName))
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($TunnelId) -and -not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $candidates.Add((Join-Path (Join-Path $env:USERPROFILE ".cloudflared") "$TunnelId.json"))
    }

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }
        try {
            $fullCandidate = [System.IO.Path]::GetFullPath($candidate)
            if (Test-Path -LiteralPath $fullCandidate -PathType Leaf) {
                return $fullCandidate
            }
        }
        catch {
            continue
        }
    }

    return ""
}

function Write-RewrittenTunnelConfig {
    param(
        [Parameter(Mandatory = $true)][string]$SourceConfigPath,
        [Parameter(Mandatory = $true)][string]$DestinationConfigPath,
        [Parameter(Mandatory = $true)][string]$ConfigRoot,
        [Parameter(Mandatory = $true)][string]$LogRoot,
        [AllowNull()][AllowEmptyString()][string]$ExplicitCredentialsPath
    )

    $sourceConfigDirectory = Split-Path -Parent $SourceConfigPath
    $lines = @(Get-Content -LiteralPath $SourceConfigPath -Encoding UTF8)
    $tunnelId = ""
    foreach ($line in $lines) {
        $tunnelValue = Get-YamlScalarValue -Line $line -Key "tunnel"
        if (-not [string]::IsNullOrWhiteSpace($tunnelValue)) {
            $tunnelId = $tunnelValue
            break
        }
    }

    $rewritten = [System.Collections.Generic.List[string]]::new()
    $logfileSeen = $false
    $credentialsSeen = $false
    $credentialCopied = $false
    $credentialFileName = ""
    $warnings = [System.Collections.Generic.List[string]]::new()
    $desiredLogPath = Join-Path $LogRoot "cloudflared.log"

    foreach ($line in $lines) {
        $credentialsValue = Get-YamlScalarValue -Line $line -Key "credentials-file"
        if ($null -ne $credentialsValue) {
            $credentialsSeen = $true
            $sourceCredentialsPath = Resolve-TunnelCredentialsPath `
                -CredentialValue $credentialsValue `
                -SourceConfigDirectory $sourceConfigDirectory `
                -ExplicitCredentialsPath $ExplicitCredentialsPath `
                -TunnelId $tunnelId

            if (-not [string]::IsNullOrWhiteSpace($sourceCredentialsPath) -and (Test-Path -LiteralPath $sourceCredentialsPath -PathType Leaf)) {
                $credentialFileName = Split-Path -Leaf $sourceCredentialsPath
                $destinationCredentialsPath = Join-Path $ConfigRoot $credentialFileName
                if (-not (Test-SamePath -Left $sourceCredentialsPath -Right $destinationCredentialsPath)) {
                    Copy-Item -LiteralPath $sourceCredentialsPath -Destination $destinationCredentialsPath -Force
                }
                $credentialCopied = $true
                $rewritten.Add(("credentials-file: {0}" -f (ConvertTo-YamlSingleQuotedScalar -Value $destinationCredentialsPath)))
            }
            else {
                $warnings.Add("Credential file referenced by dashboard tunnel config was not found; original credentials-file path was preserved.")
                $rewritten.Add($line)
            }
            continue
        }

        if ($null -ne (Get-YamlScalarValue -Line $line -Key "logfile")) {
            $logfileSeen = $true
            $rewritten.Add(("logfile: {0}" -f (ConvertTo-YamlSingleQuotedScalar -Value $desiredLogPath)))
            continue
        }

        $rewritten.Add($line)
    }

    if (-not $credentialsSeen -and -not [string]::IsNullOrWhiteSpace($ExplicitCredentialsPath)) {
        $sourceCredentialsPath = Resolve-TunnelCredentialsPath `
            -CredentialValue "" `
            -SourceConfigDirectory $sourceConfigDirectory `
            -ExplicitCredentialsPath $ExplicitCredentialsPath `
            -TunnelId $tunnelId
        if (-not [string]::IsNullOrWhiteSpace($sourceCredentialsPath) -and (Test-Path -LiteralPath $sourceCredentialsPath -PathType Leaf)) {
            $credentialFileName = Split-Path -Leaf $sourceCredentialsPath
            $destinationCredentialsPath = Join-Path $ConfigRoot $credentialFileName
            if (-not (Test-SamePath -Left $sourceCredentialsPath -Right $destinationCredentialsPath)) {
                Copy-Item -LiteralPath $sourceCredentialsPath -Destination $destinationCredentialsPath -Force
            }
            $credentialCopied = $true
            $rewritten.Add(("credentials-file: {0}" -f (ConvertTo-YamlSingleQuotedScalar -Value $destinationCredentialsPath)))
        }
        else {
            $warnings.Add("Explicit dashboard tunnel credential file was not found.")
        }
    }

    if (-not $logfileSeen) {
        $rewritten.Add(("logfile: {0}" -f (ConvertTo-YamlSingleQuotedScalar -Value $desiredLogPath)))
    }

    Set-Content -LiteralPath $DestinationConfigPath -Value $rewritten.ToArray() -Encoding UTF8

    return [ordered]@{
        credentialsCopied = $credentialCopied
        credentialFileName = $credentialFileName
        logfilePath = $desiredLogPath
        warnings = $warnings.ToArray()
    }
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

function Invoke-SchtasksCreateLogonTask {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$LauncherPath,
        [Parameter(Mandatory = $true)][string]$PrimaryErrorMessage
    )

    $wscriptPath = Join-Path $env:WINDIR "System32\wscript.exe"
    $taskRun = Join-WindowsCommandArguments -Arguments @($wscriptPath, "//B", "//Nologo", $LauncherPath)
    $output = & schtasks.exe /Create /TN $TaskName /SC ONLOGON /TR $taskRun /F 2>&1
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

    $wscriptPath = Join-Path $env:WINDIR "System32\wscript.exe"
    $taskRun = Join-WindowsCommandArguments -Arguments @($wscriptPath, "//B", "//Nologo", $LauncherPath)
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    New-Item -Path $runKey -Force | Out-Null
    Set-ItemProperty -Path $runKey -Name $TaskName -Value $taskRun -Force
    return "HKCU Run"
}

function Register-LogonStartup {
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
            -Description "Starts the local revAgent dashboard Cloudflare tunnel on the coordinator machine." `
            -Force `
            -ErrorAction Stop | Out-Null
        return "Register-ScheduledTask"
    }
    catch {
        $primaryErrorMessage = $_.Exception.Message
        try {
            return Invoke-SchtasksCreateLogonTask `
                -TaskName $TaskName `
                -LauncherPath $LauncherPath `
                -PrimaryErrorMessage $primaryErrorMessage
        }
        catch {
            return Register-HkcuRunStartup -TaskName $TaskName -LauncherPath $LauncherPath
        }
    }
}

function Start-RegisteredScheduledTask {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$LauncherPath,
        [Parameter(Mandatory = $true)][string]$RegistrationMethod
    )

    if ([string]::Equals($RegistrationMethod, "HKCU Run", [System.StringComparison]::OrdinalIgnoreCase)) {
        $wscriptPath = Join-Path $env:WINDIR "System32\wscript.exe"
        Start-Process -FilePath $wscriptPath -ArgumentList @("//B", "//Nologo", $LauncherPath) -WindowStyle Hidden
        return
    }

    try {
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        return
    }
    catch {
        $output = & schtasks.exe /Run /TN $TaskName 2>&1
        if ($LASTEXITCODE -ne 0) {
            $outputText = (($output | ForEach-Object { [string]$_ }) -join " ").Trim()
            throw "Could not start scheduled task '$TaskName'. Start-ScheduledTask error: $($_.Exception.Message). schtasks.exe error: $outputText"
        }
    }
}

function Register-TunnelScheduledTask {
    param(
        [Parameter(Mandatory = $true)][string]$ResolvedCloudflaredExe,
        [Parameter(Mandatory = $true)][string]$ResolvedConfigPath
    )

    $startScript = Join-Path $InstallRoot "installer\start-dashboard-tunnel.ps1"
    $launcherPath = Join-Path $InstallRoot "Run-revAgent-Dashboard-Tunnel-Hidden.vbs"
    Write-HiddenPowerShellLauncher `
        -LauncherPath $launcherPath `
        -ScriptPath $startScript `
        -ScriptArguments @("-AddonRoot", $InstallRoot, "-CloudflaredExe", $ResolvedCloudflaredExe, "-ConfigPath", $ResolvedConfigPath)

    $wscriptPath = Join-Path $env:WINDIR "System32\wscript.exe"
    $action = New-ScheduledTaskAction -Execute $wscriptPath -Argument ("//B //Nologo `"$launcherPath`"")
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

    $registrationMethod = Register-LogonStartup `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -LauncherPath $launcherPath

    if ($RunNow) {
        Start-RegisteredScheduledTask -TaskName $TaskName -LauncherPath $launcherPath -RegistrationMethod $registrationMethod
    }

    return $registrationMethod
}

function Test-HttpHealth {
    param(
        [string]$Uri,
        [int]$TimeoutSeconds = 20
    )

    if ([string]::IsNullOrWhiteSpace($Uri)) {
        return $null
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 4
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                return $true
            }
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Test-CloudflaredProcessFromPath {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedExePath,
        [int]$TimeoutSeconds = 20
    )

    $expected = [System.IO.Path]::GetFullPath($ExpectedExePath)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $matches = @(Get-CimInstance Win32_Process -Filter "name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and [string]::Equals(
                    [System.IO.Path]::GetFullPath($_.ExecutablePath),
                    $expected,
                    [System.StringComparison]::OrdinalIgnoreCase)
            })
        if ($matches.Count -gt 0) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Stop-LegacyCloudflaredProcesses {
    param([Parameter(Mandatory = $true)][string]$LegacyRoot)

    $stopped = 0
    $legacyRootFull = [System.IO.Path]::GetFullPath($LegacyRoot).TrimEnd("\", "/")
    $processes = @(Get-CimInstance Win32_Process -Filter "name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ExecutablePath -and [System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
                $legacyRootFull + "\",
                [System.StringComparison]::OrdinalIgnoreCase)
        })
    foreach ($process in $processes) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        $stopped++
    }

    return $stopped
}

function Disable-LegacyTunnelScheduledTasks {
    param([Parameter(Mandatory = $true)][string]$LegacyRoot)

    $disabled = 0
    $legacyRootEscaped = [regex]::Escape([System.IO.Path]::GetFullPath($LegacyRoot).TrimEnd("\", "/"))
    foreach ($task in @(Get-ScheduledTask -ErrorAction SilentlyContinue)) {
        $actionText = ($task.Actions | ForEach-Object { "{0} {1}" -f $_.Execute, $_.Arguments }) -join " "
        $looksLegacyTunnel = $task.TaskName -match 'Revit\s*MCP.*Dashboard.*Tunnel|RevitMCP.*Dashboard.*Tunnel' -or
            $actionText -match $legacyRootEscaped
        if ($looksLegacyTunnel -and $task.TaskName -ne $TaskName) {
            Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue | Out-Null
            $disabled++
        }
    }

    return $disabled
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Resolve-DefaultInstallRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$LegacyTunnelRoot = Assert-LegacyTunnelRootIsNarrow -Path $LegacyTunnelRoot

$tunnelRoot = Assert-PathUnderRoot -Path (Join-Path $InstallRoot "tunnel") -Root $InstallRoot
$binRoot = Assert-PathUnderRoot -Path (Join-Path $tunnelRoot "bin") -Root $InstallRoot
$configRoot = Assert-PathUnderRoot -Path (Join-Path $tunnelRoot "config") -Root $InstallRoot
$logRoot = Assert-PathUnderRoot -Path (Join-Path $tunnelRoot "logs") -Root $InstallRoot

New-Item -ItemType Directory -Path $binRoot, $configRoot, $logRoot -Force | Out-Null

$sourceCloudflaredExe = Resolve-CloudflaredExe
$sourceConfigPath = Resolve-TunnelConfigPath
$installedCloudflaredExe = Join-Path $binRoot "cloudflared.exe"
$installedConfigPath = Join-Path $configRoot "config.yml"

if (-not (Test-SamePath -Left $sourceCloudflaredExe -Right $installedCloudflaredExe)) {
    Copy-Item -LiteralPath $sourceCloudflaredExe -Destination $installedCloudflaredExe -Force
}

$configRewrite = Write-RewrittenTunnelConfig `
    -SourceConfigPath $sourceConfigPath `
    -DestinationConfigPath $installedConfigPath `
    -ConfigRoot $configRoot `
    -LogRoot $logRoot `
    -ExplicitCredentialsPath $CredentialsPath

$scheduledTaskRegistrationMethod = ""
if (-not $SkipScheduledTasks) {
    $scheduledTaskRegistrationMethod = Register-TunnelScheduledTask -ResolvedCloudflaredExe $installedCloudflaredExe -ResolvedConfigPath $installedConfigPath
}

$healthChecked = $false
$dashboardHealthy = $null
$tunnelProcessHealthy = $null
$publicHealthy = $null
$healthy = $null
if ($RunNow -and -not $NoHealthCheck) {
    $healthChecked = $true
    $dashboardHealthy = Test-HttpHealth -Uri $DashboardHealthUrl
    $tunnelProcessHealthy = Test-CloudflaredProcessFromPath -ExpectedExePath $installedCloudflaredExe
    $publicHealthy = Test-HttpHealth -Uri $PublicHealthUrl
    $healthy = ($dashboardHealthy -eq $true) -and ($tunnelProcessHealthy -eq $true) -and ($publicHealthy -ne $false)
    if (-not $healthy) {
        throw "Dashboard tunnel was installed, but the new add-on tunnel did not pass health checks. Legacy tunnel files were not changed."
    }
}

$legacyProcessesStopped = 0
$legacyTasksDisabled = 0
if ($StopLegacyOnSuccess) {
    if ($healthy -ne $true) {
        throw "StopLegacyOnSuccess requires RunNow with successful health checks."
    }
    $legacyProcessesStopped = Stop-LegacyCloudflaredProcesses -LegacyRoot $LegacyTunnelRoot
    $legacyTasksDisabled = Disable-LegacyTunnelScheduledTasks -LegacyRoot $LegacyTunnelRoot
}

$legacyRemoved = $false
if ($RemoveLegacyOnSuccess) {
    if ($healthy -ne $true) {
        throw "RemoveLegacyOnSuccess requires RunNow with successful health checks."
    }
    if (Test-Path -LiteralPath $LegacyTunnelRoot) {
        Remove-Item -LiteralPath $LegacyTunnelRoot -Recurse -Force
        $legacyRemoved = $true
    }
}

$result = [ordered]@{
    schemaVersion = "revagent.dashboard.tunnel.install.v1"
    installed = $true
    installRoot = $InstallRoot
    tunnelRoot = $tunnelRoot
    cloudflaredExe = $installedCloudflaredExe
    configPath = $installedConfigPath
    taskName = if ($SkipScheduledTasks) { "" } else { $TaskName }
    scheduledTaskInstalled = (-not [bool]$SkipScheduledTasks) -and (-not [string]::Equals($scheduledTaskRegistrationMethod, "HKCU Run", [System.StringComparison]::OrdinalIgnoreCase))
    startupRegistered = -not [bool]$SkipScheduledTasks
    startupRegistrationMethod = $scheduledTaskRegistrationMethod
    scheduledTaskRegistrationMethod = $scheduledTaskRegistrationMethod
    runNow = [bool]$RunNow
    healthChecked = $healthChecked
    healthy = $healthy
    dashboardHealthy = $dashboardHealthy
    tunnelProcessHealthy = $tunnelProcessHealthy
    publicHealthy = $publicHealthy
    credentialsCopied = [bool]$configRewrite.credentialsCopied
    credentialFileName = $configRewrite.credentialFileName
    logfilePath = $configRewrite.logfilePath
    warnings = $configRewrite.warnings
    legacyTunnelRoot = $LegacyTunnelRoot
    legacyProcessesStopped = $legacyProcessesStopped
    legacyTasksDisabled = $legacyTasksDisabled
    legacyRemoved = $legacyRemoved
}

$result | ConvertTo-Json -Depth 8
