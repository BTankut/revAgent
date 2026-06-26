<#
.SYNOPSIS
    Install the workstation updater and register a scheduled update check.

.DESCRIPTION
    Copies update-from-nas.ps1 to a local managed folder, writes updater config,
    and registers a per-user scheduled task. The task reads the NAS release
    target once per day at the configured local time. Revit-loaded payload
    updates are deferred while Revit is open; non-Revit payload updates may
    continue.
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
    [ValidateSet("2022", "2023", "2024", "2025")]
    [string]$RevitVersion = "2022",
    [string]$ProxyUrl = "http://192.168.90.10:6588",
    [string]$ProxyBypass = "<local>",
    [string]$CodexWorkspaceRoot = "C:\Projects",
    [ValidateSet("", "managed-user-pack", "preserve-local")]
    [string]$CodexInstructionPolicy = "",
    [string]$MachineRole = "",
    [string[]]$LegacyServerTargets = @(),
    [string]$ReportsRoot = "",
    [string]$TaskName = "revAgent Auto Update",
    [string]$DailyAt = "12:00",
    [ValidateRange(5, 1440)]
    [int]$CheckIntervalMinutes = 30,
    [ValidateRange(15, 10080)]
    [int]$NotificationThrottleMinutes = 240,
    [string]$LogPath = "",
    [string]$OperationMethod = "",
    [switch]$SkipNpmInstall,
    [switch]$SkipCodexMcpRegistration,
    [switch]$SkipCodexUserIntegration,
    [switch]$SkipProxySetup,
    [switch]$NoScheduledTask,
    [switch]$RunNow,
    [switch]$ForceUpdate,
    [switch]$RunSourceFreeMigration
)

$ErrorActionPreference = "Stop"
$nasLibRoot = @(
    (Join-Path $PSScriptRoot "lib"),
    (Join-Path (Split-Path -Parent $PSScriptRoot) "lib")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($nasLibRoot)) {
    throw "revAgent updater lib folder was not found beside or above: $PSScriptRoot"
}
Import-Module (Join-Path $nasLibRoot "RevitMcp.HiddenLauncher.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.ScheduledTask.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.RevitVersions.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.Permissions.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.Proxy.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.LogRetention.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.CodexRegistration.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.Reporting.psm1") -Force
Set-RevitMcpCurrentProcessUtf8Console | Out-Null

if ($RunSourceFreeMigration) {
    $RunNow = $true
}

$script:RevitMcpTranscriptStarted = $false
$script:RevitMcpLogPath = ""
$script:PreviousTranscriptActive = $env:REVIT_MCP_TRANSCRIPT_ACTIVE
$script:PreviousLogPath = $env:REVIT_MCP_LOG_PATH
$script:RevitMcpRemoteReportsRoot = ""
$script:RevitMcpLatestReport = $null
$script:RevitMcpOperation = "install"
$script:RevitMcpOperationMethod = ""

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
    $logPath = $script:RevitMcpLogPath
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

    if (-not [string]::IsNullOrWhiteSpace($logPath)) {
        try {
            Invoke-RevitMcpLogRetention -LogsRoot (Split-Path -Parent $logPath) -KeepLast 10 -ActiveLogPath $logPath
        }
        catch {
        }
    }

    if ($script:RevitMcpTranscriptStarted -and $null -ne $script:RevitMcpLatestReport -and -not [string]::IsNullOrWhiteSpace($script:RevitMcpRemoteReportsRoot)) {
        try {
            Publish-RevitMcpMachineRunReport `
                -ReportsRoot $script:RevitMcpRemoteReportsRoot `
                -Report $script:RevitMcpLatestReport `
                -Operation $script:RevitMcpOperation `
                -OperationMethod $script:RevitMcpOperationMethod `
                -LogPath $logPath `
                -KeepLastLogs 2 `
                -WriteCompatibilityReport | Out-Null
        }
        catch {
            Write-Warning "Could not publish remote install report/log: $($_.Exception.Message)"
        }
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

function Read-OptionalJsonFile {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Get-JsonPropertyString {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) {
        return ""
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return ""
    }

    return [string]$property.Value
}

function Resolve-CodexInstructionPolicy {
    param(
        [string]$RequestedPolicy,
        [object]$PreviousConfig
    )

    $policy = $RequestedPolicy
    if ([string]::IsNullOrWhiteSpace($policy)) {
        $policy = Get-JsonPropertyString -Object $PreviousConfig -Name "codexInstructionPolicy"
    }
    if ([string]::IsNullOrWhiteSpace($policy) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_CODEX_INSTRUCTION_POLICY)) {
        $policy = [string]$env:REVIT_MCP_CODEX_INSTRUCTION_POLICY
    }
    if ([string]::IsNullOrWhiteSpace($policy)) {
        $policy = "managed-user-pack"
    }

    $normalized = $policy.Trim().ToLowerInvariant()
    if ($normalized -notin @("managed-user-pack", "preserve-local")) {
        throw "Unsupported CodexInstructionPolicy '$policy'. Use managed-user-pack or preserve-local."
    }

    return $normalized
}

function Resolve-MachineRole {
    param(
        [string]$RequestedRole,
        [object]$PreviousConfig
    )

    $role = $RequestedRole
    if ([string]::IsNullOrWhiteSpace($role)) {
        $role = Get-JsonPropertyString -Object $PreviousConfig -Name "machineRole"
    }
    if ([string]::IsNullOrWhiteSpace($role) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_MACHINE_ROLE)) {
        $role = [string]$env:REVIT_MCP_MACHINE_ROLE
    }

    return $role
}

function Get-EffectiveInstallOperationMethod {
    if (-not [string]::IsNullOrWhiteSpace($OperationMethod)) {
        return $OperationMethod
    }
    if ($RunSourceFreeMigration) {
        return "source-free-migration-bootstrap"
    }
    if ($ForceUpdate) {
        return "install-repair"
    }
    return "install"
}

function Get-EffectiveInstallOperation {
    if ($ForceUpdate) {
        return "reinstall"
    }

    return "install"
}

function Set-RevitMcpInstallRunReport {
    param(
        [string]$Status,
        [string]$Message
    )

    $channel = Read-OptionalJsonFile -Path $ChannelManifestPath
    $installedState = Read-OptionalJsonFile -Path (Join-Path $WorkRoot "installed.json")
    $targetVersion = if ($channel -and $channel.version) { [string]$channel.version } else { $null }
    $installedVersion = if ($installedState -and $installedState.version) { [string]$installedState.version } else { $null }
    $channelGit = if ($channel) { $channel.git } else { $null }
    $installedComponents = if ($installedState -and $installedState.components) { $installedState.components } else { $null }
    $installedComponentCount = 0
    if ($installedComponents -and $installedComponents.PSObject) {
        $installedComponentCount = @($installedComponents.PSObject.Properties).Count
    }

    $script:RevitMcpLatestReport = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        operation = $script:RevitMcpOperation
        operationMethod = $script:RevitMcpOperationMethod
        status = $Status
        message = $Message
        codexInstructionPolicy = $CodexInstructionPolicy
        machineRole = $MachineRole
        computerName = $env:COMPUTERNAME
        userName = $env:USERNAME
        atUtc = (Get-Date).ToUniversalTime().ToString("o")
        channel = if ($channel) { $channel.channel } else { $null }
        previousVersion = $installedVersion
        targetVersion = $targetVersion
        installedVersion = $installedVersion
        release = [ordered]@{
            channel = if ($channel) { $channel.channel } else { $null }
            version = $targetVersion
            packageSha256 = if ($channel) { $channel.sha256 } else { $null }
            packagePath = if ($channel) { $channel.packagePath } else { $null }
            manifestPath = if ($channel) { $channel.manifestPath } else { $null }
            publishedAtUtc = if ($channel) { $channel.publishedAtUtc } else { $null }
            commit = if ($channelGit) { $channelGit.commit } else { $null }
            isDirty = if ($channelGit) { $channelGit.isDirty } else { $null }
        }
        localInstall = if ($installedState) {
            [ordered]@{
                version = $installedState.version
                installedAtUtc = $installedState.installedAtUtc
                packageSha256 = $installedState.packageSha256
                packagePath = $installedState.packagePath
                manifestPath = $installedState.manifestPath
                componentCount = $installedComponentCount
                updatePolicy = if ($installedState.updatePolicy) { $installedState.updatePolicy } else { $null }
            }
        }
        else {
            $null
        }
        diagnostics = [ordered]@{
            isFirstInstall = [string]::IsNullOrWhiteSpace($installedVersion)
            revitRunning = $false
            deferredForRevitClose = $false
            revitPayloadChanged = $null
            fastPackageOnlyUpdate = $false
            runSelfContainedInstaller = $true
            codexInstructionPolicy = $CodexInstructionPolicy
            machineRole = $MachineRole
        }
        paths = [ordered]@{
            installRoot = $InstallRoot
            packageTarget = $PackageTarget
            serverTarget = $ServerTarget
            workRoot = $WorkRoot
            revitInstallRoot = $RevitInstallRoot
            channelManifestPath = $ChannelManifestPath
            logPath = $script:RevitMcpLogPath
        }
    }
}

function Invoke-InitialUpdateCheck {
    param(
        [string]$UpdaterPath,
        [string]$UpdaterConfigPath,
        [switch]$ForceUpdate,
        [switch]$SourceFreeMigration,
        [string]$OperationMethod = "initial-update"
    )

    if ($env:REVIT_MCP_AUDIT_ONLY) {
        & $UpdaterPath -ConfigPath $UpdaterConfigPath -AuditOnly -NoNotifyUser -OperationMethod "initial-audit"
        return
    }

    if ($ForceUpdate -and $SourceFreeMigration) {
        & $UpdaterPath -ConfigPath $UpdaterConfigPath -NoNotifyUser -AllowManualCodexSetup -Force -SourceFreeMigration -OperationMethod $OperationMethod
        return
    }

    if ($ForceUpdate) {
        & $UpdaterPath -ConfigPath $UpdaterConfigPath -NoNotifyUser -AllowManualCodexSetup -Force -OperationMethod $OperationMethod
        return
    }

    if ($SourceFreeMigration) {
        & $UpdaterPath -ConfigPath $UpdaterConfigPath -NoNotifyUser -AllowManualCodexSetup -SourceFreeMigration -OperationMethod $OperationMethod
        return
    }

    & $UpdaterPath -ConfigPath $UpdaterConfigPath -NoNotifyUser -AllowManualCodexSetup -OperationMethod $OperationMethod
}

function Test-CurrentProcessElevated {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function ConvertTo-RevitMcpProxyUrl {
    param([string]$Value)

    return RevitMcp.Proxy\ConvertTo-RevitMcpProxyUrl -Value $Value
}

function ConvertTo-RevitMcpWinHttpProxyServer {
    param([string]$Value)

    return RevitMcp.Proxy\ConvertTo-RevitMcpWinHttpProxyServer -Value $Value
}

function Send-RevitMcpEnvironmentChanged {
    try {
        if (-not ("RevitMcp.EnvironmentChange" -as [type])) {
            Add-Type -Namespace "RevitMcp" -Name "EnvironmentChange" -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(
    System.IntPtr hWnd,
    uint Msg,
    System.UIntPtr wParam,
    string lParam,
    uint fuFlags,
    uint uTimeout,
    out System.UIntPtr lpdwResult);
"@
        }

        $result = [System.UIntPtr]::Zero
        [void][RevitMcp.EnvironmentChange]::SendMessageTimeout(
            [System.IntPtr]0xffff,
            0x001A,
            [System.UIntPtr]::Zero,
            "Environment",
            0x0002,
            5000,
            [ref]$result)
    }
    catch {
        Write-Warning "Could not broadcast environment variable changes: $($_.Exception.Message)"
    }
}

function Invoke-RevitMcpSetupProcess {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 60
    )

    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    $completed = $process.WaitForExit([Math]::Max(30, $TimeoutSeconds) * 1000)
    if (-not $completed) {
        try {
            $process.Kill()
        }
        catch {}
        return 124
    }

    return $process.ExitCode
}

function Resolve-OptionalCommand {
    param(
        [string[]]$Names,
        [string[]]$Candidates = @()
    )

    foreach ($name in $Names) {
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (Test-Path -LiteralPath $expanded -PathType Leaf) {
            return $expanded
        }
    }

    return ""
}

function Add-ProcessPathEntry {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
        return
    }

    $entries = @($env:Path -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($entry in $entries) {
        if ([string]::Equals($entry.TrimEnd('\'), $Path.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
            return
        }
    }

    $env:Path = $Path + ";" + $env:Path
}

function Refresh-DependencyPath {
    foreach ($path in @(
            (Join-Path ${env:ProgramFiles} "nodejs"),
            (Join-Path ${env:ProgramFiles(x86)} "nodejs"),
            (Join-Path $env:APPDATA "npm"),
            (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin")
        )) {
        Add-ProcessPathEntry -Path $path
    }
}

function Set-RevitMcpProxyEnvironment {
    param(
        [string]$ProxyUrl,
        [string]$NoProxy = "localhost,127.0.0.1,::1"
    )

    if ([string]::IsNullOrWhiteSpace($ProxyUrl)) {
        return
    }

    $elevated = Test-CurrentProcessElevated
    $targets = @("Process", "User")
    if ($elevated) {
        $targets += "Machine"
    }

    $proxyVariables = @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
    $noProxyVariables = @("NO_PROXY", "no_proxy")
    $changedPersistentEnvironment = $false

    foreach ($target in $targets) {
        $targetEnum = [System.Enum]::Parse([System.EnvironmentVariableTarget], $target)
        $targetAlreadyConfigured = $true
        foreach ($key in $proxyVariables) {
            if (-not [string]::Equals([Environment]::GetEnvironmentVariable($key, $targetEnum), $ProxyUrl, [System.StringComparison]::OrdinalIgnoreCase)) {
                $targetAlreadyConfigured = $false
                break
            }
        }
        if ($targetAlreadyConfigured) {
            foreach ($key in $noProxyVariables) {
                if (-not [string]::Equals([Environment]::GetEnvironmentVariable($key, $targetEnum), $NoProxy, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $targetAlreadyConfigured = $false
                    break
                }
            }
        }
        if ($targetAlreadyConfigured) {
            continue
        }

        foreach ($key in $proxyVariables) {
            try {
                [Environment]::SetEnvironmentVariable($key, $ProxyUrl, $targetEnum)
                if ($target -ne "Process") {
                    $changedPersistentEnvironment = $true
                }
            }
            catch {
                Write-Warning "Could not set $target environment variable ${key}: $($_.Exception.Message)"
            }
        }
        foreach ($key in $noProxyVariables) {
            try {
                [Environment]::SetEnvironmentVariable($key, $NoProxy, $targetEnum)
                if ($target -ne "Process") {
                    $changedPersistentEnvironment = $true
                }
            }
            catch {
                Write-Warning "Could not set $target environment variable ${key}: $($_.Exception.Message)"
            }
        }
    }

    if ($changedPersistentEnvironment) {
        Send-RevitMcpEnvironmentChanged
        Write-Host "Proxy env       : updated"
    }
    else {
        Write-Host "Proxy env       : ok"
    }
}

function Set-RevitMcpWinInetProxy {
    param(
        [string]$ProxyUrl,
        [string]$ProxyBypass
    )

    if ([string]::IsNullOrWhiteSpace($ProxyUrl)) {
        return
    }

    try {
        $internetSettingsPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
        if (-not (Test-Path -Path $internetSettingsPath)) {
            New-Item -Path $internetSettingsPath -Force | Out-Null
        }
        $current = Get-ItemProperty -Path $internetSettingsPath -ErrorAction SilentlyContinue
        $alreadyConfigured = $current -and
            ([int]$current.ProxyEnable -eq 1) -and
            [string]::Equals([string]$current.ProxyServer, $ProxyUrl, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals([string]$current.ProxyOverride, $ProxyBypass, [System.StringComparison]::OrdinalIgnoreCase)
        if ($alreadyConfigured) {
            Write-Host "WinINET proxy   : ok"
            return
        }

        New-ItemProperty -Path $internetSettingsPath -Name "ProxyEnable" -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $internetSettingsPath -Name "ProxyServer" -Value $ProxyUrl -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $internetSettingsPath -Name "ProxyOverride" -Value $ProxyBypass -PropertyType String -Force | Out-Null
        Write-Host "WinINET proxy   : updated"
    }
    catch {
        Write-Warning "Could not set current-user Windows proxy settings: $($_.Exception.Message)"
    }
}

function Test-RevitMcpWinHttpProxyMatches {
    param([string]$ProxyUrl)

    $server = ConvertTo-RevitMcpWinHttpProxyServer -Value $ProxyUrl
    if ([string]::IsNullOrWhiteSpace($server)) {
        return $true
    }

    try {
        $output = (& netsh winhttp show proxy 2>$null | Out-String)
        return ($output -match [regex]::Escape($server))
    }
    catch {
        return $false
    }
}

function Set-RevitMcpWinHttpProxy {
    param(
        [string]$ProxyUrl,
        [string]$ProxyBypass
    )

    $server = ConvertTo-RevitMcpWinHttpProxyServer -Value $ProxyUrl
    if ([string]::IsNullOrWhiteSpace($server)) {
        return
    }

    if (Test-RevitMcpWinHttpProxyMatches -ProxyUrl $ProxyUrl) {
        Write-Host "WinHTTP proxy   : ok"
        return
    }

    if (-not (Test-CurrentProcessElevated)) {
        Write-Warning "WinHTTP proxy needs admin rights. Run the revAgent installer as administrator to set it for winget/Windows services."
        return
    }

    $netshPath = Join-Path $env:WINDIR "System32\netsh.exe"
    try {
        $exitCode = Invoke-RevitMcpSetupProcess -FilePath $netshPath -Arguments @("winhttp", "set", "proxy", "proxy-server=$server", "bypass-list=$ProxyBypass") -TimeoutSeconds 60
        if ($exitCode -ne 0) {
            Write-Warning "WinHTTP proxy setup failed with exit code $exitCode."
            return
        }

        Write-Host "WinHTTP proxy   : updated"
    }
    catch {
        Write-Warning "Could not set WinHTTP proxy: $($_.Exception.Message)"
    }
}

function Invoke-RevitMcpProxyToolCommand {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($FilePath)) {
        return
    }

    try {
        $exitCode = Invoke-RevitMcpSetupProcess -FilePath $FilePath -Arguments $Arguments -TimeoutSeconds 60
        if ($exitCode -ne 0) {
            Write-Warning "$Label failed with exit code $exitCode."
        }
    }
    catch {
        Write-Warning "$Label failed: $($_.Exception.Message)"
    }
}

function Get-RevitMcpKeyValueFileValue {
    param(
        [string]$Path,
        [string]$Key
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return ""
    }

    $escapedKey = [regex]::Escape($Key)
    foreach ($line in (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#") -or $trimmed.StartsWith(";")) {
            continue
        }
        if ($trimmed -match "^\s*$escapedKey\s*=\s*(.*?)\s*$") {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }

    return ""
}

function Test-RevitMcpNpmProxyConfigured {
    param([string]$ProxyUrl)

    $npmrcPath = Join-Path $env:USERPROFILE ".npmrc"
    return (
        [string]::Equals((Get-RevitMcpKeyValueFileValue -Path $npmrcPath -Key "proxy"), $ProxyUrl, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals((Get-RevitMcpKeyValueFileValue -Path $npmrcPath -Key "https-proxy"), $ProxyUrl, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals((Get-RevitMcpKeyValueFileValue -Path $npmrcPath -Key "registry"), "https://registry.npmjs.org/", [System.StringComparison]::OrdinalIgnoreCase)
    )
}

function Set-RevitMcpNpmProxy {
    param([string]$ProxyUrl)

    if ([string]::IsNullOrWhiteSpace($ProxyUrl)) {
        return
    }

    if (Test-RevitMcpNpmProxyConfigured -ProxyUrl $ProxyUrl) {
        Write-Host "npm proxy       : ok"
        return
    }

    Refresh-DependencyPath
    $npmPath = Resolve-OptionalCommand -Names @("npm.cmd", "npm") -Candidates @(
        (Join-Path ${env:ProgramFiles} "nodejs\npm.cmd"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\npm.cmd")
    )
    if ([string]::IsNullOrWhiteSpace($npmPath)) {
        Write-Host "npm proxy       : skipped (npm not found)"
        return
    }

    foreach ($arguments in @(
            @("config", "set", "proxy", $ProxyUrl),
            @("config", "set", "https-proxy", $ProxyUrl),
            @("config", "set", "registry", "https://registry.npmjs.org/")
        )) {
        Invoke-RevitMcpProxyToolCommand -FilePath $npmPath -Arguments $arguments -Label "npm proxy config"
    }
    Write-Host "npm proxy       : updated"

    if (Test-CurrentProcessElevated) {
        foreach ($arguments in @(
                @("config", "set", "proxy", $ProxyUrl, "--global"),
                @("config", "set", "https-proxy", $ProxyUrl, "--global"),
                @("config", "set", "registry", "https://registry.npmjs.org/", "--global")
            )) {
            Invoke-RevitMcpProxyToolCommand -FilePath $npmPath -Arguments $arguments -Label "global npm proxy config"
        }
    }
}

function Test-RevitMcpGitProxyConfigured {
    param(
        [string]$GitPath,
        [string]$ProxyUrl
    )

    if ([string]::IsNullOrWhiteSpace($GitPath)) {
        return $false
    }

    try {
        $httpProxy = (& $GitPath config --global --get http.proxy 2>$null | Out-String).Trim()
        $httpsProxy = (& $GitPath config --global --get https.proxy 2>$null | Out-String).Trim()
        return (
            [string]::Equals($httpProxy, $ProxyUrl, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals($httpsProxy, $ProxyUrl, [System.StringComparison]::OrdinalIgnoreCase)
        )
    }
    catch {
        return $false
    }
}

function Set-RevitMcpGitProxy {
    param([string]$ProxyUrl)

    if ([string]::IsNullOrWhiteSpace($ProxyUrl)) {
        return
    }

    $gitPath = Resolve-OptionalCommand -Names @("git.exe", "git") -Candidates @(
        (Join-Path ${env:ProgramFiles} "Git\cmd\git.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Git\cmd\git.exe")
    )
    if ([string]::IsNullOrWhiteSpace($gitPath)) {
        Write-Host "Git proxy       : skipped (git not found)"
        return
    }

    if (Test-RevitMcpGitProxyConfigured -GitPath $gitPath -ProxyUrl $ProxyUrl) {
        Write-Host "Git proxy       : ok"
        return
    }

    foreach ($arguments in @(
            @("config", "--global", "http.proxy", $ProxyUrl),
            @("config", "--global", "https.proxy", $ProxyUrl)
        )) {
        Invoke-RevitMcpProxyToolCommand -FilePath $gitPath -Arguments $arguments -Label "git proxy config"
    }
    Write-Host "Git proxy       : updated"
}

function Initialize-RevitMcpWorkstationProxy {
    param(
        [string]$ProxyUrl,
        [string]$ProxyBypass,
        [switch]$Skip
    )

    if ($Skip) {
        Write-Host "Office proxy setup: skipped."
        return
    }

    $normalizedProxyUrl = ConvertTo-RevitMcpProxyUrl -Value $ProxyUrl
    if ([string]::IsNullOrWhiteSpace($normalizedProxyUrl)) {
        return
    }

    if ([string]::IsNullOrWhiteSpace($ProxyBypass)) {
        $ProxyBypass = "<local>"
    }

    Write-Host "Office proxy    : $normalizedProxyUrl"
    Set-RevitMcpProxyEnvironment -ProxyUrl $normalizedProxyUrl
    Set-RevitMcpWinInetProxy -ProxyUrl $normalizedProxyUrl -ProxyBypass $ProxyBypass
    Set-RevitMcpWinHttpProxy -ProxyUrl $normalizedProxyUrl -ProxyBypass $ProxyBypass
    Set-RevitMcpNpmProxy -ProxyUrl $normalizedProxyUrl
    Set-RevitMcpGitProxy -ProxyUrl $normalizedProxyUrl
}

function Ensure-CodexWorkspaceRoot {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }

    $fullPath = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path)).TrimEnd("\")
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
        Write-Host "Codex workspace : created $fullPath"
        return
    }

    Write-Host "Codex workspace : $fullPath"
}

function ConvertTo-VbsStringLiteral {
    param([string]$Value)

    return [string]::Concat('"', $Value.Replace('"', '""'), '"')
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

function Resolve-WindowsPowerShellPath {
    return Resolve-RevitMcpWindowsPowerShellPath
}

function Resolve-WScriptPath {
    return Resolve-RevitMcpWScriptPath
}

function Repair-RevitMcpUpdaterPermissions {
    $targets = Get-RevitMcpManagedPermissionTargets `
        -InstallRoot $InstallRoot `
        -WorkRoot $WorkRoot `
        -PackageTarget $PackageTarget `
        -ServerTarget $ServerTarget `
        -RevitVersion $RevitVersion
    Invoke-RevitMcpManagedPermissionRepair -Targets $targets
}

function Write-HiddenPowerShellLauncher {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LauncherPath,
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [string[]]$ScriptArguments = @(),
        [switch]$WaitForExit
    )

    Write-RevitMcpHiddenPowerShellLauncher `
        -LauncherPath $LauncherPath `
        -ScriptPath $ScriptPath `
        -ScriptArguments $ScriptArguments `
        -WaitForExit:$WaitForExit
}

function Get-HiddenUpdaterLauncherPath {
    param([string]$UpdaterConfigPath)

    return Get-RevitMcpHiddenUpdaterLauncherPath -ConfigPath $UpdaterConfigPath
}

function New-HiddenUpdaterScheduledTaskAction {
    param([string]$LauncherPath)

    return New-RevitMcpHiddenUpdaterScheduledTaskAction -LauncherPath $LauncherPath
}

function Write-UpdaterCommandFiles {
    param(
        [string]$UpdaterPath,
        [string]$UpdaterConfigPath,
        [string]$UpdaterWorkRoot,
        [string]$VersionToolPath = "",
        [string]$DailyAt = "12:00",
        [int]$CheckIntervalMinutes = 30,
        [switch]$InstallStartupFallback
    )

    $manualCommandPath = Join-Path $UpdaterWorkRoot "Update-Revit-MCP-Now.cmd"
    $manualCommandLines = @(
        "@echo off",
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$UpdaterPath`" -ConfigPath `"$UpdaterConfigPath`" -NoNotifyUser -AllowManualCodexSetup -OperationMethod manual-update",
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
            "    [string]`$DailyAt = `"$DailyAt`"",
            ")",
            "",
            "`$ErrorActionPreference = `"Continue`"",
            "function Get-NextRunTime {",
            "    param([string]`$RunAt)",
            "    try {",
            "        `$time = [datetime]::Parse(`$RunAt)",
            "    }",
            "    catch {",
            "        `$time = [datetime]::Parse(`"12:00`")",
            "    }",
            "    `$now = Get-Date",
            "    `$next = Get-Date -Year `$now.Year -Month `$now.Month -Day `$now.Day -Hour `$time.Hour -Minute `$time.Minute -Second 0",
            "    if (`$next -le `$now) { `$next = `$next.AddDays(1) }",
            "    return `$next",
            "}",
            "while (`$true) {",
            "    `$nextRun = Get-NextRunTime -RunAt `$DailyAt",
            "    `$sleepSeconds = [Math]::Max(60, [int][Math]::Ceiling((`$nextRun - (Get-Date)).TotalSeconds))",
            "    Start-Sleep -Seconds `$sleepSeconds",
            "    try {",
            "        & `$UpdaterPath -ConfigPath `$ConfigPath -NotifyUser -OperationMethod startup-fallback-update",
            "    }",
            "    catch {",
            "    }",
            "}"
        )
        $loopScriptLines | Set-Content -LiteralPath $loopScriptPath -Encoding ASCII

        foreach ($legacyStartupName in @("Revit MCP Auto Update.cmd", "Revit MCP Auto Update.vbs")) {
            $legacyStartupPath = Join-Path $startupRoot $legacyStartupName
            if (Test-Path -LiteralPath $legacyStartupPath -PathType Leaf) {
                Remove-Item -LiteralPath $legacyStartupPath -Force
            }
        }

        $startupCommandPath = Join-Path $startupRoot "revAgent Auto Update.vbs"
        Write-HiddenPowerShellLauncher `
            -LauncherPath $startupCommandPath `
            -ScriptPath $loopScriptPath `
            -ScriptArguments @("-UpdaterPath", $UpdaterPath, "-ConfigPath", $UpdaterConfigPath, "-DailyAt", [string]$DailyAt)
        Write-Host "Startup fallback: $startupCommandPath" -ForegroundColor Yellow
        Write-Host "Startup fallback schedule: daily at $DailyAt" -ForegroundColor Yellow
    }

    return $manualCommandPath
}

function Resolve-RevitInstallRoot {
    param(
        [string]$RequestedRoot,
        [string]$Version
    )

    return Resolve-RevitMcpInstallRoot -RequestedRoot $RequestedRoot -Version $Version
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

$script:RevitMcpOperationMethod = Get-EffectiveInstallOperationMethod
$script:RevitMcpOperation = Get-EffectiveInstallOperation
Initialize-RevitMcpTranscript -PreferredWorkRoot $WorkRoot -RequestedLogPath $LogPath -Prefix "install"
Write-Host "Operation method : $script:RevitMcpOperationMethod"
if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
    $channelDir = Split-Path -Parent $ChannelManifestPath
    $releaseRootGuess = Split-Path -Parent $channelDir
    $ReportsRoot = Join-Path $releaseRootGuess "reports"
}
$script:RevitMcpRemoteReportsRoot = $ReportsRoot

try {
$ProxyUrl = ConvertTo-RevitMcpProxyUrl -Value $ProxyUrl
Initialize-RevitMcpWorkstationProxy -ProxyUrl $ProxyUrl -ProxyBypass $ProxyBypass -Skip:$SkipProxySetup
Ensure-CodexWorkspaceRoot -Path $CodexWorkspaceRoot

$RevitInstallRoot = Resolve-RevitInstallRoot -RequestedRoot $RevitInstallRoot -Version $RevitVersion

New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
Repair-RevitMcpUpdaterPermissions

$localUpdater = Join-Path $WorkRoot "update-from-nas.ps1"
$localVersionTool = Join-Path $WorkRoot "show-installed-version.ps1"
$localMigrationTool = Join-Path $WorkRoot "migrate-source-free-install.ps1"
$configPath = Join-Path $WorkRoot "updater-config.json"
$previousConfig = Read-OptionalJsonFile -Path $configPath
$CodexInstructionPolicy = Resolve-CodexInstructionPolicy -RequestedPolicy $CodexInstructionPolicy -PreviousConfig $previousConfig
$MachineRole = Resolve-MachineRole -RequestedRole $MachineRole -PreviousConfig $previousConfig
$previousDistributionIntegrity = if ($previousConfig -and $previousConfig.distributionIntegrity) { $previousConfig.distributionIntegrity } else { $null }
$previousTrustedReleaseKeysPath = if ($previousDistributionIntegrity -and $previousDistributionIntegrity.trustedKeysPath) { [string]$previousDistributionIntegrity.trustedKeysPath } else { "" }
$previousReleaseIntegrityPinned = $false
if ($previousDistributionIntegrity) {
    $previousReleaseIntegrityPinned = [string]::Equals([string]$previousDistributionIntegrity.policy, "enforce", [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::IsNullOrWhiteSpace($previousTrustedReleaseKeysPath)
}
$preservedTrustedReleaseKeysPath = ""
$localLibRoot = Join-Path $WorkRoot "lib"
$localTrustedReleaseKeysPath = Join-Path $WorkRoot "config\release-trusted-keys.json"
$trustedReleaseKeysMissingAfterRepair = $false
try {
    if ($previousReleaseIntegrityPinned -and -not [string]::IsNullOrWhiteSpace($previousTrustedReleaseKeysPath) -and (Test-Path -LiteralPath $previousTrustedReleaseKeysPath -PathType Leaf)) {
        $preservedTrustedReleaseKeysPath = Join-Path $WorkRoot "release-trusted-keys.previous.json"
        Copy-Item -LiteralPath $previousTrustedReleaseKeysPath -Destination $preservedTrustedReleaseKeysPath -Force
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "update-from-nas.ps1") -Destination $localUpdater -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "show-installed-version.ps1") -Destination $localVersionTool -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "migrate-source-free-install.ps1") -Destination $localMigrationTool -Force
    if (Test-Path -LiteralPath $localLibRoot) {
        Remove-Item -LiteralPath $localLibRoot -Recurse -Force
    }
    Copy-Item -LiteralPath $nasLibRoot -Destination $localLibRoot -Recurse -Force
    $nasConfigRoot = @(
        (Join-Path $PSScriptRoot "config"),
        (Join-Path (Split-Path -Parent (Split-Path -Parent $nasLibRoot)) "config")
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
    if (-not [string]::IsNullOrWhiteSpace($nasConfigRoot)) {
        $localConfigRoot = Join-Path $WorkRoot "config"
        if (Test-Path -LiteralPath $localConfigRoot) {
            Remove-Item -LiteralPath $localConfigRoot -Recurse -Force
        }
        Copy-Item -LiteralPath $nasConfigRoot -Destination $localConfigRoot -Recurse -Force
    }
    if (-not (Test-Path -LiteralPath $localTrustedReleaseKeysPath -PathType Leaf)) {
        if (-not [string]::IsNullOrWhiteSpace($preservedTrustedReleaseKeysPath) -and (Test-Path -LiteralPath $preservedTrustedReleaseKeysPath -PathType Leaf)) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $localTrustedReleaseKeysPath) -Force | Out-Null
            Copy-Item -LiteralPath $preservedTrustedReleaseKeysPath -Destination $localTrustedReleaseKeysPath -Force
            Write-Warning "NAS tools did not provide release-trusted-keys.json; preserved previously pinned local trusted release keys."
        }
        elseif ($previousReleaseIntegrityPinned) {
            $trustedReleaseKeysMissingAfterRepair = $true
            Write-Warning "Trusted release keys were previously pinned, but NAS tools did not provide release-trusted-keys.json and no previous local key file could be preserved. Distribution integrity config remains pinned and fail-closed until keys are restored."
        }
    }
}
finally {
    if (-not [string]::IsNullOrWhiteSpace($preservedTrustedReleaseKeysPath)) {
        if ($previousReleaseIntegrityPinned -and -not (Test-Path -LiteralPath $localTrustedReleaseKeysPath -PathType Leaf) -and (Test-Path -LiteralPath $preservedTrustedReleaseKeysPath -PathType Leaf)) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $localTrustedReleaseKeysPath) -Force | Out-Null
            Copy-Item -LiteralPath $preservedTrustedReleaseKeysPath -Destination $localTrustedReleaseKeysPath -Force
            Write-Warning "Restored previously pinned local trusted release keys after updater repair did not leave a trusted key file."
        }
        Remove-Item -LiteralPath $preservedTrustedReleaseKeysPath -Force -ErrorAction SilentlyContinue
    }
}

$script:RevitMcpRemoteReportsRoot = $ReportsRoot

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
    proxyUrl = $ProxyUrl
    proxyBypass = $ProxyBypass
    codexWorkspaceRoot = $CodexWorkspaceRoot
    codexInstructionPolicy = $CodexInstructionPolicy
    legacyServerTargets = $LegacyServerTargets
    reportsRoot = $ReportsRoot
    skipNpmInstall = [bool]$SkipNpmInstall
    skipCodexMcpRegistration = [bool]$SkipCodexMcpRegistration
    skipCodexUserIntegration = [bool]$SkipCodexUserIntegration
    skipProxySetup = [bool]$SkipProxySetup
    dailyAt = $DailyAt
    checkIntervalMinutes = $CheckIntervalMinutes
    taskName = $TaskName
    notifyUser = $true
    notificationThrottleMinutes = $NotificationThrottleMinutes
    logsRoot = (Join-Path $WorkRoot "logs")
    installLogPath = $script:RevitMcpLogPath
    installOperationMethod = $script:RevitMcpOperationMethod
    installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
}
if (-not [string]::IsNullOrWhiteSpace($MachineRole)) {
    $config["machineRole"] = $MachineRole
}
if ((Test-Path -LiteralPath $localTrustedReleaseKeysPath -PathType Leaf) -or $previousReleaseIntegrityPinned) {
    $config["distributionIntegrity"] = [ordered]@{
        policy = "enforce"
        trustedKeysPath = $localTrustedReleaseKeysPath
    }
    if ($trustedReleaseKeysMissingAfterRepair -and -not (Test-Path -LiteralPath $localTrustedReleaseKeysPath -PathType Leaf)) {
        $config["distributionIntegrity"]["trustedKeysMissing"] = $true
        $config["distributionIntegrity"]["message"] = "Trusted release keys were previously pinned but could not be restored. The updater remains fail-closed until release-trusted-keys.json is restored by Install/Repair."
    }
}
Write-JsonFile -Path $configPath -Value $config
$manualCommandPath = Write-UpdaterCommandFiles -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -UpdaterWorkRoot $WorkRoot -VersionToolPath $localVersionTool -DailyAt $DailyAt -CheckIntervalMinutes $CheckIntervalMinutes
$versionCommandPath = Join-Path $WorkRoot "Show-Revit-MCP-Version.cmd"
Repair-RevitMcpUpdaterPermissions

if ($NoScheduledTask) {
    Write-Host "Updater installed without scheduled task."
    Write-Host "Run manually: $manualCommandPath"
    Write-Host "Show version: $versionCommandPath"
    if ($RunNow) {
        Write-Host ""
        Write-Host "Running initial update check..."
        Invoke-InitialUpdateCheck -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -ForceUpdate:$ForceUpdate -SourceFreeMigration:$RunSourceFreeMigration -OperationMethod ("{0}-initial-update" -f $script:RevitMcpOperationMethod)
    }
    Set-RevitMcpInstallRunReport -Status "completed" -Message ("Updater install completed by {0}." -f $script:RevitMcpOperationMethod)
    return
}

$hiddenLauncherPath = Get-HiddenUpdaterLauncherPath -UpdaterConfigPath $configPath
Write-HiddenPowerShellLauncher -LauncherPath $hiddenLauncherPath -ScriptPath $localUpdater -ScriptArguments @("-ConfigPath", $configPath, "-NotifyUser", "-OperationMethod", "scheduled-update") -WaitForExit
$action = New-HiddenUpdaterScheduledTaskAction -LauncherPath $hiddenLauncherPath
$dailyTrigger = New-RevitMcpDailyUpdateTrigger -DailyAt $DailyAt
$triggers = @($dailyTrigger)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description "Checks the revAgent release target daily at $DailyAt. Revit-loaded payload updates are deferred while Revit is open." -Force | Out-Null
    Write-Host "Task registered : $TaskName" -ForegroundColor Green
    Write-Host "Task schedule   : daily at $DailyAt" -ForegroundColor Green
    foreach ($legacyTaskName in @("Revit MCP Auto Update")) {
        if ([string]::Equals($legacyTaskName, $TaskName, [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $legacyTask = Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
        if ($legacyTask) {
            try {
                Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false -ErrorAction Stop | Out-Null
                Write-Host "Removed legacy task: $legacyTaskName" -ForegroundColor Yellow
            }
            catch {
                Write-Warning "Could not remove legacy updater scheduled task '$legacyTaskName': $($_.Exception.Message)"
            }
        }
    }
}
catch {
    Write-Warning "Scheduled task could not be registered: $($_.Exception.Message)"
    Write-UpdaterCommandFiles -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -UpdaterWorkRoot $WorkRoot -VersionToolPath $localVersionTool -DailyAt $DailyAt -CheckIntervalMinutes $CheckIntervalMinutes -InstallStartupFallback | Out-Null
}

Write-Host "Updater installed: $localUpdater" -ForegroundColor Green
Write-Host "Config written  : $configPath" -ForegroundColor Green
Write-Host "Run manually    : $manualCommandPath" -ForegroundColor Green
Write-Host "Show version    : $versionCommandPath" -ForegroundColor Green

if ($RunNow) {
    Write-Host ""
    Write-Host "Running initial update check..."
    Invoke-InitialUpdateCheck -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -ForceUpdate:$ForceUpdate -SourceFreeMigration:$RunSourceFreeMigration -OperationMethod ("{0}-initial-update" -f $script:RevitMcpOperationMethod)
}
Set-RevitMcpInstallRunReport -Status "completed" -Message ("Updater install completed by {0}." -f $script:RevitMcpOperationMethod)
}
catch {
    Write-Host ""
    Write-Host "revAgent updater install failed: $($_.Exception.Message)" -ForegroundColor Red
    if (-not [string]::IsNullOrWhiteSpace($script:RevitMcpLogPath)) {
        Write-Host "Install log: $script:RevitMcpLogPath" -ForegroundColor Yellow
    }
    Set-RevitMcpInstallRunReport -Status "failed" -Message $_.Exception.Message
    throw
}
finally {
    Complete-RevitMcpTranscript
}
