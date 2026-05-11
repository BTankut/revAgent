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
    [string]$ProxyUrl = "http://192.168.90.10:6588",
    [string]$ProxyBypass = "<local>",
    [string]$CodexWorkspaceRoot = "C:\Projects",
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
    [switch]$SkipProxySetup,
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
        & $UpdaterPath -ConfigPath $UpdaterConfigPath -AuditOnly -NoNotifyUser
        return
    }

    & $UpdaterPath -ConfigPath $UpdaterConfigPath -NoNotifyUser -AllowManualCodexSetup
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

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    $normalized = $Value.Trim()
    if ($normalized -match '^(https?://\S+?)\s+(\d+)$') {
        $normalized = "$($Matches[1]):$($Matches[2])"
    }
    elseif ($normalized -match '^(\S+)\s+(\d+)$') {
        $normalized = "$($Matches[1]):$($Matches[2])"
    }

    if ($normalized -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
        $normalized = "http://$normalized"
    }

    try {
        $uri = [System.Uri]::new($normalized)
        if ([string]::IsNullOrWhiteSpace($uri.Host)) {
            return $normalized.TrimEnd("/")
        }

        return $uri.AbsoluteUri.TrimEnd("/")
    }
    catch {
        return $normalized.TrimEnd("/")
    }
}

function ConvertTo-RevitMcpWinHttpProxyServer {
    param([string]$Value)

    $normalized = ConvertTo-RevitMcpProxyUrl -Value $Value
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return ""
    }

    try {
        $uri = [System.Uri]::new($normalized)
        if (-not [string]::IsNullOrWhiteSpace($uri.Host)) {
            return ("{0}:{1}" -f $uri.Host, $uri.Port)
        }
    }
    catch {}

    return ($normalized -replace '^[a-zA-Z][a-zA-Z0-9+.-]*://', '').TrimEnd("/")
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
        Write-Warning "WinHTTP proxy needs admin rights. Run the Revit MCP installer as administrator to set it for winget/Windows services."
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
    return (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe")
}

function Resolve-WScriptPath {
    return (Join-Path $env:WINDIR "System32\wscript.exe")
}

function Test-RevitMcpAdministrator {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function Grant-RevitMcpManagedPathAccess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [string]$Label = "managed path",
        [switch]$CreateDirectory,
        [switch]$Recurse
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }

    if (-not (Test-RevitMcpAdministrator)) {
        return
    }

    try {
        if ($CreateDirectory) {
            New-Item -ItemType Directory -Path $Path -Force | Out-Null
        }
        elseif (-not (Test-Path -LiteralPath $Path)) {
            return
        }

        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        if ([string]::IsNullOrWhiteSpace($identity)) {
            return
        }

        $grant = if ($Recurse) { "${identity}:(OI)(CI)M" } else { "${identity}:M" }
        $arguments = @($Path, "/grant", $grant, "/C")
        if ($Recurse) {
            $arguments += "/T"
        }

        Write-Host "Permission repair: $Label"
        & icacls @arguments 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not grant write access to $identity for $Label ($Path). icacls exit code: $LASTEXITCODE"
        }
    }
    catch {
        Write-Warning "Could not grant write access for $Label (${Path}): $($_.Exception.Message)"
    }
}

function Repair-RevitMcpUpdaterPermissions {
    Grant-RevitMcpManagedPathAccess -Path $InstallRoot -Label "Revit MCP install root" -CreateDirectory
    Grant-RevitMcpManagedPathAccess -Path $WorkRoot -Label "updater work root" -CreateDirectory
    Grant-RevitMcpManagedPathAccess -Path $PackageTarget -Label "package target" -CreateDirectory
    Grant-RevitMcpManagedPathAccess -Path $ServerTarget -Label "runtime target" -CreateDirectory
    Grant-RevitMcpManagedPathAccess -Path (Join-Path $InstallRoot "revit-plugin") -Label "Revit addin payload root" -CreateDirectory
    Grant-RevitMcpManagedPathAccess -Path (Join-Path $InstallRoot "commands") -Label "Revit command payload root" -CreateDirectory
    Grant-RevitMcpManagedPathAccess -Path (Join-Path $InstallRoot "codex") -Label "Codex payload root" -CreateDirectory
    Grant-RevitMcpManagedPathAccess -Path (Join-Path $InstallRoot "state") -Label "state root" -CreateDirectory

    foreach ($fileName in @(
            "Run-Revit-MCP-Update-Hidden.vbs",
            "last-update-report.json",
            "installed.json",
            "updater-config.json",
            "update-from-nas.ps1",
            "show-installed-version.ps1",
            "install-updater-task.ps1",
            "Update-Revit-MCP-Now.cmd",
            "Show-Revit-MCP-Version.cmd",
            "auto-update-loop.ps1"
        )) {
        Grant-RevitMcpManagedPathAccess -Path (Join-Path $WorkRoot $fileName) -Label "updater file $fileName"
    }
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

    $launcherDir = Split-Path -Parent $LauncherPath
    if (-not [string]::IsNullOrWhiteSpace($launcherDir)) {
        New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
    }

    $command = Join-WindowsCommandArguments -Arguments (@(
            (Resolve-WindowsPowerShellPath),
            "-STA",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $ScriptPath
        ) + $ScriptArguments)
    $waitText = if ($WaitForExit) { "True" } else { "False" }

    $runLine = [string]::Concat("exitCode = shell.Run(", (ConvertTo-VbsStringLiteral -Value $command), ", 0, ", $waitText, ")")

    @(
        "Option Explicit",
        "Dim shell",
        "Dim exitCode",
        "Set shell = CreateObject(""WScript.Shell"")",
        $runLine,
        "WScript.Quit exitCode"
    ) | Set-Content -LiteralPath $LauncherPath -Encoding ASCII
}

function Get-HiddenUpdaterLauncherPath {
    param([string]$UpdaterConfigPath)

    return Join-Path (Split-Path -Parent $UpdaterConfigPath) "Run-Revit-MCP-Update-Hidden.vbs"
}

function New-HiddenUpdaterScheduledTaskAction {
    param([string]$LauncherPath)

    return New-ScheduledTaskAction -Execute (Resolve-WScriptPath) -Argument ("//B //Nologo `"$LauncherPath`"")
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
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$UpdaterPath`" -ConfigPath `"$UpdaterConfigPath`" -NoNotifyUser -AllowManualCodexSetup",
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

        $oldStartupCommandPath = Join-Path $startupRoot "Revit MCP Auto Update.cmd"
        if (Test-Path -LiteralPath $oldStartupCommandPath -PathType Leaf) {
            Remove-Item -LiteralPath $oldStartupCommandPath -Force
        }

        $startupCommandPath = Join-Path $startupRoot "Revit MCP Auto Update.vbs"
        Write-HiddenPowerShellLauncher `
            -LauncherPath $startupCommandPath `
            -ScriptPath $loopScriptPath `
            -ScriptArguments @("-UpdaterPath", $UpdaterPath, "-ConfigPath", $UpdaterConfigPath, "-IntervalMinutes", [string]$CheckIntervalMinutes)
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
$ProxyUrl = ConvertTo-RevitMcpProxyUrl -Value $ProxyUrl
Initialize-RevitMcpWorkstationProxy -ProxyUrl $ProxyUrl -ProxyBypass $ProxyBypass -Skip:$SkipProxySetup
Ensure-CodexWorkspaceRoot -Path $CodexWorkspaceRoot

$RevitInstallRoot = Resolve-RevitInstallRoot -RequestedRoot $RevitInstallRoot -Version $RevitVersion

New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
Repair-RevitMcpUpdaterPermissions

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
    proxyUrl = $ProxyUrl
    proxyBypass = $ProxyBypass
    codexWorkspaceRoot = $CodexWorkspaceRoot
    legacyServerTargets = $LegacyServerTargets
    reportsRoot = $ReportsRoot
    skipNpmInstall = [bool]$SkipNpmInstall
    skipCodexMcpRegistration = [bool]$SkipCodexMcpRegistration
    skipCodexUserIntegration = [bool]$SkipCodexUserIntegration
    skipProxySetup = [bool]$SkipProxySetup
    checkIntervalMinutes = $CheckIntervalMinutes
    taskName = $TaskName
    notifyUser = $true
    notificationThrottleMinutes = $NotificationThrottleMinutes
    logsRoot = (Join-Path $WorkRoot "logs")
    installLogPath = $script:RevitMcpLogPath
    installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
}
Write-JsonFile -Path $configPath -Value $config
$manualCommandPath = Write-UpdaterCommandFiles -UpdaterPath $localUpdater -UpdaterConfigPath $configPath -UpdaterWorkRoot $WorkRoot -VersionToolPath $localVersionTool -CheckIntervalMinutes $CheckIntervalMinutes
$versionCommandPath = Join-Path $WorkRoot "Show-Revit-MCP-Version.cmd"
Repair-RevitMcpUpdaterPermissions

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
$hiddenLauncherPath = Get-HiddenUpdaterLauncherPath -UpdaterConfigPath $configPath
Write-HiddenPowerShellLauncher -LauncherPath $hiddenLauncherPath -ScriptPath $localUpdater -ScriptArguments @("-ConfigPath", $configPath, "-NotifyUser") -WaitForExit
$action = New-HiddenUpdaterScheduledTaskAction -LauncherPath $hiddenLauncherPath
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
