<#
.SYNOPSIS
    Update a workstation from a NAS-hosted Revit MCP channel manifest.

.DESCRIPTION
    Reads channels\stable.json from the NAS, compares it with the local
    installed state, verifies the package hash, replaces the managed local
    package copy, runs the self-contained installer, refreshes npm dependencies,
    and writes a machine report.
#>

[CmdletBinding()]
param(
    [string]$ConfigPath = "",
    [string]$ChannelManifestPath = "",
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
    [string[]]$LegacyServerTargets = @(),
    [string]$ReportsRoot = "",
    [switch]$Force,
    [switch]$AuditOnly,
    [switch]$SkipNpmInstall,
    [switch]$SkipCodexMcpRegistration,
    [switch]$SkipCodexUserIntegration,
    [switch]$SkipProxySetup,
    [switch]$AllowManualCodexSetup,
    [string]$CodexWorkspaceRoot = "C:\Projects",
    [string]$TaskName = "Revit MCP Auto Update",
    [string]$LogPath = "",
    [switch]$NotifyUser,
    [switch]$NoNotifyUser,
    [ValidateRange(15, 10080)]
    [int]$NotificationThrottleMinutes = 240,
    [switch]$AllowReplaceGitPackageTarget
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$nasLibRoot = @(
    (Join-Path $PSScriptRoot "lib"),
    (Join-Path (Split-Path -Parent $PSScriptRoot) "lib")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($nasLibRoot)) {
    throw "Revit MCP updater lib folder was not found beside or above: $PSScriptRoot"
}
Import-Module (Join-Path $nasLibRoot "RevitMcp.HiddenLauncher.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.ScheduledTask.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.RevitVersions.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.Package.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.UpdatePolicy.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.Proxy.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.LogRetention.psm1") -Force

$updaterVersion = "0.1.0"
$script:RevitMcpTranscriptStarted = $false
$script:RevitMcpLogPath = ""
$script:PreviousTranscriptActive = $env:REVIT_MCP_TRANSCRIPT_ACTIVE
$script:PreviousLogPath = $env:REVIT_MCP_LOG_PATH
$script:RevitMcpProxyUrl = ""
$script:RevitMcpProxyBypass = "<local>"

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
        Write-Host "Update log      : $path" -ForegroundColor Green
    }
    catch {
        $script:RevitMcpLogPath = $path
        Write-Warning "Could not start update transcript: $($_.Exception.Message). Intended log path: $path"
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
}

function Import-UpdaterConfig {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Config file was not found: $Path"
    }

    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Resolve-ReleasePath {
    param(
        [string]$Path,
        [string]$BaseDirectory
    )

    return Resolve-RevitMcpReleasePath -Path $Path -BaseDirectory $BaseDirectory
}

function Resolve-PackageLayout {
    param(
        [string]$Root,
        [object]$ReleaseManifest = $null
    )

    return Resolve-RevitMcpPackageLayout -Root $Root -ReleaseManifest $ReleaseManifest
}

function Expand-ReleaseArchive {
    param(
        [string]$ZipPath,
        [string]$DestinationPath
    )

    Expand-RevitMcpReleaseArchive -ZipPath $ZipPath -DestinationPath $DestinationPath
}

function Assert-ManagedDirectoryTarget {
    param(
        [string]$Path,
        [string[]]$ExpectedLeafNames
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
    $leaf = Split-Path -Leaf $fullPath
    $leafOk = $false
    foreach ($expectedLeaf in $ExpectedLeafNames) {
        if ([string]::Equals($leaf, $expectedLeaf, [System.StringComparison]::OrdinalIgnoreCase)) {
            $leafOk = $true
            break
        }
    }
    if (-not $leafOk) {
        throw "Refusing to replace managed package target because the leaf folder is not one of '$($ExpectedLeafNames -join ", ")': $fullPath"
    }

    $blocked = @(
        [System.IO.Path]::GetPathRoot($fullPath).TrimEnd("\"),
        [System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd("\"),
        [System.IO.Path]::GetFullPath($env:APPDATA).TrimEnd("\"),
        [System.IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd("\")
    )

    foreach ($candidate in $blocked) {
        if ([string]::Equals($fullPath, $candidate, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to replace broad directory target: $fullPath"
        }
    }

    return $fullPath
}

function Resolve-RequiredCommand {
    param(
        [string]$Name,
        [string[]]$Candidates = @(),
        [string]$InstallHint = ""
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (Test-Path -LiteralPath $expanded -PathType Leaf) {
            return $expanded
        }
    }

    $message = "Required command '$Name' was not found."
    if ($Candidates.Count -gt 0) {
        $message += " Checked: " + (($Candidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "; ")
    }
    if (-not [string]::IsNullOrWhiteSpace($InstallHint)) {
        $message += " $InstallHint"
    }
    $message += " Then run the Revit MCP updater again."
    throw $message
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

function Get-DependencySearchRoots {
    $roots = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
            $env:REVIT_MCP_DEPENDENCIES_ROOT,
            (Join-Path $PSScriptRoot "dependencies"),
            (Join-Path $WorkRoot "dependencies"),
            (Join-Path $PackageTarget "installer\nas\dependencies")
        )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $roots.Add($candidate)
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
        try {
            $channelDir = Split-Path -Parent $ChannelManifestPath
            $releaseRoot = Split-Path -Parent $channelDir
            $roots.Add((Join-Path $releaseRoot "tools\dependencies"))
        }
        catch {}
    }

    return @($roots.ToArray() | Select-Object -Unique)
}

function Resolve-DependencyFile {
    param([string]$FileName)

    foreach ($root in Get-DependencySearchRoots) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $candidate = Join-Path $root $FileName
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    return ""
}

function Invoke-ProcessWithTimeout {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 240
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
        $exitCode = Invoke-ProcessWithTimeout -FilePath $netshPath -Arguments @("winhttp", "set", "proxy", "proxy-server=$server", "bypass-list=$ProxyBypass") -TimeoutSeconds 60
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
        $exitCode = Invoke-ProcessWithTimeout -FilePath $FilePath -Arguments $Arguments -TimeoutSeconds 60
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

    $script:RevitMcpProxyUrl = $normalizedProxyUrl
    $script:RevitMcpProxyBypass = $ProxyBypass

    Write-Host "Office proxy    : $normalizedProxyUrl"
    Set-RevitMcpProxyEnvironment -ProxyUrl $normalizedProxyUrl
    Set-RevitMcpWinInetProxy -ProxyUrl $normalizedProxyUrl -ProxyBypass $ProxyBypass
    Set-RevitMcpWinHttpProxy -ProxyUrl $normalizedProxyUrl -ProxyBypass $ProxyBypass
    Set-RevitMcpNpmProxy -ProxyUrl $normalizedProxyUrl
    Set-RevitMcpGitProxy -ProxyUrl $normalizedProxyUrl
}

function Assert-PathUnderRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
    if (-not ($fullPath + "\").StartsWith($fullRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside managed dependency root. Path=$fullPath Root=$fullRoot"
    }

    return $fullPath
}

function Get-NodeMajorVersion {
    param([string]$NodePath)

    if ([string]::IsNullOrWhiteSpace($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        return -1
    }

    try {
        $versionText = (& $NodePath --version 2>$null | Out-String).Trim()
        if ($versionText -match '^v?(\d+)') {
            return [int]$Matches[1]
        }
    }
    catch {}

    return -1
}

function Get-NodeRuntimeStatus {
    $nodeCandidates = @(
        (Join-Path ${env:ProgramFiles} "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
    )
    $npmCandidates = @(
        (Join-Path ${env:ProgramFiles} "nodejs\npm.cmd"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\npm.cmd")
    )

    $nodePath = Resolve-OptionalCommand -Names @("node.exe", "node") -Candidates $nodeCandidates
    $npmPath = Resolve-OptionalCommand -Names @("npm.cmd", "npm") -Candidates $npmCandidates
    $major = Get-NodeMajorVersion -NodePath $nodePath

    return [pscustomobject][ordered]@{
        nodePath = $nodePath
        npmPath = $npmPath
        major = $major
        ready = (-not [string]::IsNullOrWhiteSpace($nodePath) -and -not [string]::IsNullOrWhiteSpace($npmPath) -and $major -ge 20)
    }
}

function Install-NodeFromWinget {
    $wingetPath = Resolve-OptionalCommand -Names @("winget.exe", "winget") -Candidates @(
        (Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\winget.exe")
    )
    if ([string]::IsNullOrWhiteSpace($wingetPath)) {
        Write-Warning "winget was not found; bundled Node.js MSI will be used if needed."
        return $false
    }

    Write-Host "Installing Node.js from internet with winget..."
    $exitCode = Invoke-ProcessWithTimeout -FilePath $wingetPath -Arguments @("install", "--id", "OpenJS.NodeJS.LTS", "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity") -TimeoutSeconds 300
    if ($exitCode -eq 0) {
        Refresh-DependencyPath
        return $true
    }

    Write-Warning "winget Node.js install failed with exit code $exitCode; bundled MSI will be tried."
    return $false
}

function Install-NodeFromBundledMsi {
    $msiPath = Resolve-DependencyFile -FileName "node-v24.14.1-x64.msi"
    if ([string]::IsNullOrWhiteSpace($msiPath)) {
        throw "Bundled Node.js installer was not found under NAS tools dependencies or local package dependencies."
    }

    $msiexecPath = Join-Path $env:WINDIR "System32\msiexec.exe"
    Write-Host "Installing Node.js from bundled MSI: $msiPath"
    $msiArgument = '"' + $msiPath.Replace('"', '\"') + '"'
    $process = Start-Process -FilePath $msiexecPath -ArgumentList "/i $msiArgument /qn /norestart" -Wait -PassThru
    if (@(0, 3010) -notcontains $process.ExitCode) {
        throw "Bundled Node.js MSI install failed with exit code $($process.ExitCode): $msiPath"
    }

    Refresh-DependencyPath
}

function Ensure-NodeRuntime {
    Refresh-DependencyPath
    $status = Get-NodeRuntimeStatus
    if ($status.ready) {
        Set-RevitMcpNpmProxy -ProxyUrl $script:RevitMcpProxyUrl
        return $status
    }

    $currentLabel = if ($status.major -gt 0) { "major version $($status.major)" } else { "not found" }
    Write-Host "Node.js/npm is not ready ($currentLabel). Trying automatic install."

    $installedFromInternet = Install-NodeFromWinget
    $status = Get-NodeRuntimeStatus
    if (-not $status.ready) {
        if (-not $installedFromInternet) {
            Write-Host "Falling back to bundled Node.js installer."
        }
        else {
            Write-Warning "Internet install completed but Node.js/npm is still not ready; falling back to bundled MSI."
        }
        Install-NodeFromBundledMsi
        $status = Get-NodeRuntimeStatus
    }

    if (-not $status.ready) {
        throw "Node.js/npm could not be prepared automatically. Expected Node.js 20 or newer and npm.cmd."
    }

    Write-Host "Node.js ready: $($status.nodePath)"
    Write-Host "npm ready    : $($status.npmPath)"
    Set-RevitMcpNpmProxy -ProxyUrl $script:RevitMcpProxyUrl
    return $status
}

function Get-CodexDesktopAppxPackage {
    try {
        return Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue |
            Sort-Object Version -Descending |
            Select-Object -First 1
    }
    catch {
        return $null
    }
}

function Resolve-CodexDesktopCommand {
    Refresh-DependencyPath
    foreach ($candidate in @(
            (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\codex.exe")
        )) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (Test-Path -LiteralPath $expanded -PathType Leaf) {
            return $expanded
        }
    }

    return ""
}

function Test-CodexDesktopAvailable {
    return $null -ne (Get-CodexDesktopAppxPackage)
}

function New-CodexDesktopShortcut {
    $package = Get-CodexDesktopAppxPackage
    if (-not $package) {
        return
    }

    try {
        $programsRoot = [Environment]::GetFolderPath("Programs")
        if ([string]::IsNullOrWhiteSpace($programsRoot)) {
            return
        }

        $shortcutDir = Join-Path $programsRoot "DPE"
        New-Item -ItemType Directory -Path $shortcutDir -Force | Out-Null
        $shortcutPath = Join-Path $shortcutDir "Codex.lnk"
        $appId = "$($package.PackageFamilyName)!App"
        $iconPath = Join-Path $package.InstallLocation "app\Codex.exe"
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = Join-Path $env:WINDIR "explorer.exe"
        $shortcut.Arguments = "shell:AppsFolder\$appId"
        $shortcut.WorkingDirectory = $package.InstallLocation
        if (Test-Path -LiteralPath $iconPath -PathType Leaf) {
            $shortcut.IconLocation = "$iconPath,0"
        }
        $shortcut.Save()
        Write-Host "Codex Desktop shortcut: $shortcutPath"
    }
    catch {
        Write-Warning "Could not create Codex Desktop shortcut: $($_.Exception.Message)"
    }
}

function Remove-ObsoleteCodexManagedPayloads {
    $dependenciesRoot = Join-Path $InstallRoot "dependencies"
    foreach ($name in @("codex_app", "codex_command_payload")) {
        $target = Join-Path $dependenciesRoot $name
        if (-not (Test-Path -LiteralPath $target)) {
            continue
        }

        try {
            $safeTarget = Assert-PathUnderRoot -Path $target -Root $dependenciesRoot
            Remove-Item -LiteralPath $safeTarget -Recurse -Force
            Write-Host "Removed obsolete Codex managed payload: $safeTarget"
        }
        catch {
            Write-Warning "Could not remove obsolete Codex managed payload '$target': $($_.Exception.Message)"
        }
    }
}

function Ensure-CodexWorkspaceRoot {
    if ([string]::IsNullOrWhiteSpace($CodexWorkspaceRoot)) {
        return
    }

    $path = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($CodexWorkspaceRoot)).TrimEnd("\")
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        Write-Host "Codex workspace  : created $path"
        return
    }

    Write-Host "Codex workspace  : $path"
}

function Show-ManualCodexSetupPrompt {
    param([string]$Reason)

    Ensure-CodexWorkspaceRoot
    $message = @"
$Reason

Proxy ve internet ayarlari hazir.
Codex calisma klasoru hazir: $CodexWorkspaceRoot

Lutfen simdi Codex Desktop'u manuel kurun/acin, oturum ve abonelik islemini tamamlayin, gerekirse calisma klasoru olarak $CodexWorkspaceRoot secin.

Codex hazir olduktan sonra devam etmek icin OK tusuna basin.
"@

    Write-Host "Manual Codex setup required."
    Write-Host $Reason
    Write-Host "Codex workspace  : $CodexWorkspaceRoot"

    try {
        Add-Type -AssemblyName System.Windows.Forms
        $result = [System.Windows.Forms.MessageBox]::Show(
            $message,
            "revAgent - Codex Desktop",
            [System.Windows.Forms.MessageBoxButtons]::OKCancel,
            [System.Windows.Forms.MessageBoxIcon]::Information)
        return ($result -eq [System.Windows.Forms.DialogResult]::OK)
    }
    catch {
        Write-Warning "Could not show Codex setup prompt: $($_.Exception.Message)"
        return $false
    }
}

function Ensure-CodexDesktop {
    Remove-ObsoleteCodexManagedPayloads
    Ensure-CodexWorkspaceRoot

    if (Test-CodexDesktopAvailable) {
        New-CodexDesktopShortcut
        return
    }

    if ($AllowManualCodexSetup) {
        $reason = "Bu Windows kullanicisi icin Codex Desktop kurulu degil."
        if (Show-ManualCodexSetupPrompt -Reason $reason) {
            Refresh-DependencyPath
            if (Test-CodexDesktopAvailable) {
                New-CodexDesktopShortcut
                return
            }
        }
    }

    throw "Codex Desktop bu Windows kullanicisi icin kurulu degil. Proxy ayarlari ve Codex calisma klasoru hazir. Codex Desktop'u manuel kurup oturum acin, sonra installer/updater'i tekrar calistirin."
}

function Ensure-UpdateDependencies {
    param(
        [switch]$SkipNpmInstall,
        [switch]$SkipCodexMcpRegistration
    )

    $needsNodeRuntime = (-not $SkipNpmInstall) -or (-not $SkipCodexMcpRegistration)
    $nodeStatus = $null
    if ($needsNodeRuntime) {
        $nodeStatus = Ensure-NodeRuntime
    }

    if (-not $SkipCodexMcpRegistration) {
        Ensure-CodexDesktop
    }
}

function ConvertTo-TomlString {
    param([string]$Value)

    if ($null -eq $Value) {
        return "''"
    }

    if ($Value -notmatch "'") {
        return "'" + $Value + "'"
    }

    $escaped = $Value.Replace("\", "\\").Replace('"', '\"')
    $escaped = $escaped -replace "`r", "\r" -replace "`n", "\n"
    return '"' + $escaped + '"'
}

function New-CodexMcpServerTomlBlock {
    param(
        [string]$Name,
        [string]$Command,
        [string[]]$McpArgs
    )

    $argText = (@($McpArgs) | ForEach-Object { ConvertTo-TomlString -Value $_ }) -join ", "
    return @(
        "[mcp_servers.$Name]",
        ("command = {0}" -f (ConvertTo-TomlString -Value $Command)),
        ("args = [{0}]" -f $argText),
        ""
    ) -join "`r`n"
}

function Set-CodexMcpServerConfig {
    param(
        [string]$Name,
        [string]$Command,
        [string[]]$McpArgs
    )

    $configRoot = Join-Path $env:USERPROFILE ".codex"
    New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
    $configPath = Join-Path $configRoot "config.toml"
    $content = ""
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $content = Get-Content -Raw -LiteralPath $configPath
    }

    $block = New-CodexMcpServerTomlBlock -Name $Name -Command $Command -McpArgs $McpArgs
    $pattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($Name))\]\r?\n.*?(?=^\[|\z)"
    if ($content -match $pattern) {
        $content = [regex]::Replace($content, $pattern, $block)
    }
    else {
        if (-not [string]::IsNullOrWhiteSpace($content) -and -not $content.EndsWith("`n")) {
            $content += "`r`n"
        }
        if (-not [string]::IsNullOrWhiteSpace($content)) {
            $content += "`r`n"
        }
        $content += $block
    }

    Set-Content -LiteralPath $configPath -Value $content -Encoding UTF8
    return $configPath
}

function Register-CodexMcpServersInConfig {
    param(
        [string]$NodePath,
        [string]$RuntimeServerPath,
        [string]$DocsServerPath
    )

    $configPath = Set-CodexMcpServerConfig -Name "revit-mcp" -Command $NodePath -McpArgs @($RuntimeServerPath)
    [void](Set-CodexMcpServerConfig -Name "revit-api-docs" -Command $NodePath -McpArgs @($DocsServerPath))
    Write-Host "Codex MCP config : $configPath"
}

function Resolve-RevitInstallRoot {
    param(
        [string]$RequestedRoot,
        [string]$Version
    )

    return Resolve-RevitMcpInstallRoot -RequestedRoot $RequestedRoot -Version $Version
}

function Invoke-External {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$FilePath failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function Get-InstalledState {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        Write-Warning "Installed state is not valid JSON and will be ignored: $Path"
        return $null
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

function Get-VersionLabel {
    param([string]$Version)

    if ([string]::IsNullOrWhiteSpace($Version)) {
        return "not installed"
    }

    return $Version
}

function Get-JsonPropertyValue {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) {
        return $null
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($property) {
        return $property.Value
    }

    return $null
}

function Get-ComponentByKey {
    param(
        [object]$Manifest,
        [string]$Key
    )

    $components = Get-JsonPropertyValue -Object $Manifest -Name "components"
    if ($null -eq $components) {
        return $null
    }

    return Get-JsonPropertyValue -Object $components -Name $Key
}

function Get-ComponentSha256 {
    param([object]$Component)

    $sha = Get-JsonPropertyValue -Object $Component -Name "sha256"
    if ($null -eq $sha) {
        return ""
    }

    return [string]$sha
}

function Get-ComponentPath {
    param([object]$Component)

    $path = Get-JsonPropertyValue -Object $Component -Name "path"
    if ($null -eq $path) {
        return ""
    }

    return [string]$path
}

function Get-RelativeFileSha256OrNull {
    param(
        [string]$Root,
        [string]$RelativePath
    )

    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($RelativePath)) {
        return ""
    }

    $candidate = Join-Path $Root $RelativePath
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash
    }

    return ""
}

function Get-InstalledReleaseManifest {
    param(
        [object]$InstalledState,
        [string]$PackageTarget
    )

    if ($InstalledState) {
        $stateComponents = Get-JsonPropertyValue -Object $InstalledState -Name "components"
        if ($stateComponents) {
            return [pscustomobject][ordered]@{
                components = $stateComponents
                updatePolicy = Get-JsonPropertyValue -Object $InstalledState -Name "updatePolicy"
            }
        }

        $manifestPath = [string](Get-JsonPropertyValue -Object $InstalledState -Name "manifestPath")
        if (-not [string]::IsNullOrWhiteSpace($manifestPath) -and (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            try {
                return Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
            }
            catch {
                Write-Warning "Installed release manifest is not valid JSON and will be ignored: $manifestPath"
            }
        }
    }

    $localReleaseInfoPath = Join-Path $PackageTarget "release-info.json"
    if (Test-Path -LiteralPath $localReleaseInfoPath -PathType Leaf) {
        try {
            $localReleaseInfo = Get-Content -Raw -LiteralPath $localReleaseInfoPath | ConvertFrom-Json
            $localComponents = Get-JsonPropertyValue -Object $localReleaseInfo -Name "components"
            if ($localComponents) {
                return [pscustomobject][ordered]@{
                    components = $localComponents
                    updatePolicy = Get-JsonPropertyValue -Object $localReleaseInfo -Name "updatePolicy"
                }
            }
        }
        catch {}
    }

    return $null
}

function Get-InstalledComponentSha256 {
    param(
        [string]$Key,
        [object]$TargetComponent,
        [object]$InstalledManifest,
        [string]$PackageTarget
    )

    $installedComponent = Get-ComponentByKey -Manifest $InstalledManifest -Key $Key
    $installedSha = Get-ComponentSha256 -Component $installedComponent
    if (-not [string]::IsNullOrWhiteSpace($installedSha)) {
        return $installedSha
    }

    $relativePath = Get-ComponentPath -Component $TargetComponent
    $installedSha = Get-RelativeFileSha256OrNull -Root $PackageTarget -RelativePath $relativePath
    if (-not [string]::IsNullOrWhiteSpace($installedSha)) {
        return $installedSha
    }

    if ($relativePath.StartsWith("installer\", [System.StringComparison]::OrdinalIgnoreCase)) {
        $legacyRelativePath = "kurulum\" + $relativePath.Substring("installer\".Length)
        return Get-RelativeFileSha256OrNull -Root $PackageTarget -RelativePath $legacyRelativePath
    }

    if ($relativePath.StartsWith("kurulum\", [System.StringComparison]::OrdinalIgnoreCase)) {
        $canonicalRelativePath = "installer\" + $relativePath.Substring("kurulum\".Length)
        return Get-RelativeFileSha256OrNull -Root $PackageTarget -RelativePath $canonicalRelativePath
    }

    return ""
}

function Get-ActualRevitPayloadPathMapping {
    param(
        [string]$RelativePath,
        [string]$InstallRoot,
        [string]$RevitVersion
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        return [pscustomobject][ordered]@{
            isMapped = $false
            shouldCompare = $false
            paths = @()
        }
    }

    $normalizedPath = $RelativePath.Replace("/", "\")
    if ($normalizedPath.StartsWith("kurulum\", [System.StringComparison]::OrdinalIgnoreCase)) {
        $normalizedPath = "installer\" + $normalizedPath.Substring("kurulum\".Length)
    }

    if ([string]::Equals($normalizedPath, "installer\revit-plugin\mcp-servers-for-revit.addin", [System.StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{
            isMapped = $true
            shouldCompare = $false
            paths = @()
        }
    }

    $paths = [System.Collections.Generic.List[string]]::new()
    $pluginPrefix = "installer\revit-plugin\revit_mcp_plugin\"
    if ($normalizedPath.StartsWith($pluginPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $suffix = $normalizedPath.Substring($pluginPrefix.Length)
        [void]$paths.Add((Join-Path $InstallRoot ("revit-plugin\revit_mcp_plugin\" + $suffix)))
        return [pscustomobject][ordered]@{
            isMapped = $true
            shouldCompare = $true
            paths = @($paths.ToArray())
        }
    }

    $commandPayloadPrefix = "installer\command-payload\"
    if ($normalizedPath.StartsWith($commandPayloadPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $suffix = $normalizedPath.Substring($commandPayloadPrefix.Length)
        $runtimePrefix = "runtime\$RevitVersion\"
        if ($suffix.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            $runtimeSuffix = $suffix.Substring($runtimePrefix.Length)
            [void]$paths.Add((Join-Path $InstallRoot ("commands\CommandSet\$RevitVersion\" + $runtimeSuffix)))
            [void]$paths.Add((Join-Path $InstallRoot ("revit-plugin\revit_mcp_plugin\Commands\RevitMCPCommandSet\$RevitVersion\" + $runtimeSuffix)))
        }
        else {
            [void]$paths.Add((Join-Path $InstallRoot ("commands\CommandSet\$RevitVersion\" + $suffix)))
            [void]$paths.Add((Join-Path $InstallRoot ("commands\CommandSet\" + $suffix)))
            [void]$paths.Add((Join-Path $InstallRoot ("revit-plugin\revit_mcp_plugin\Commands\RevitMCPCommandSet\$RevitVersion\" + $suffix)))
            [void]$paths.Add((Join-Path $InstallRoot ("revit-plugin\revit_mcp_plugin\Commands\RevitMCPCommandSet\" + $suffix)))
        }

        return [pscustomobject][ordered]@{
            isMapped = $true
            shouldCompare = $true
            paths = @($paths.ToArray())
        }
    }

    return [pscustomobject][ordered]@{
        isMapped = $false
        shouldCompare = $false
        paths = @()
    }
}

function Test-RevitPayloadComponentPath {
    param([string]$RelativePath)

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        return $false
    }

    foreach ($prefix in @(
            "installer\revit-plugin\",
            "installer\command-payload\",
            "kurulum\revit-plugin\",
            "kurulum\command-payload\"
        )) {
        if ($RelativePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

function Get-RevitClosedRequiredKeys {
    param([object]$Manifest)

    $keys = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $policy = Get-JsonPropertyValue -Object $Manifest -Name "updatePolicy"
    $configuredKeys = Get-JsonPropertyValue -Object $policy -Name "revitClosedRequiredComponentKeys"
    foreach ($key in @($configuredKeys)) {
        if ([string]::IsNullOrWhiteSpace([string]$key)) { continue }
        if ($seen.Add([string]$key)) {
            [void]$keys.Add([string]$key)
        }
    }

    if ($keys.Count -eq 0) {
        $components = Get-JsonPropertyValue -Object $Manifest -Name "components"
        if ($components) {
            foreach ($property in $components.PSObject.Properties) {
                $componentPath = Get-ComponentPath -Component $property.Value
                if ((Test-RevitPayloadComponentPath -RelativePath $componentPath) -and $seen.Add($property.Name)) {
                    [void]$keys.Add($property.Name)
                }
            }
        }
    }

    foreach ($fallbackKey in @(
            "revitPlugin",
            "commandSet",
            "revitAddinManifest",
            "revitPluginNewtonsoft",
            "revitPluginSdk",
            "revitCommandRegistry",
            "revitCommandSet",
            "revitCommandSetConfig"
        )) {
        if ($seen.Add($fallbackKey)) {
            [void]$keys.Add($fallbackKey)
        }
    }

    return $keys.ToArray()
}

function Get-RevitPayloadChanges {
    param(
        [object]$TargetManifest,
        [object]$InstalledManifest,
        [string]$PackageTarget,
        [string]$InstallRoot,
        [string]$RevitVersion
    )

    $changes = [System.Collections.Generic.List[object]]::new()
    if ($null -eq $TargetManifest) {
        return $changes.ToArray()
    }

    foreach ($key in Get-RevitClosedRequiredKeys -Manifest $TargetManifest) {
        $targetComponent = Get-ComponentByKey -Manifest $TargetManifest -Key $key
        if ($null -eq $targetComponent) {
            continue
        }

        $targetSha = Get-ComponentSha256 -Component $targetComponent
        if ([string]::IsNullOrWhiteSpace($targetSha)) {
            continue
        }

        $componentPath = Get-ComponentPath -Component $targetComponent
        $actualMapping = Get-ActualRevitPayloadPathMapping -RelativePath $componentPath -InstallRoot $InstallRoot -RevitVersion $RevitVersion
        if ($actualMapping.isMapped) {
            if (-not $actualMapping.shouldCompare) {
                continue
            }

            $mismatchedPaths = [System.Collections.Generic.List[string]]::new()
            foreach ($actualPath in @($actualMapping.paths)) {
                $actualSha = ""
                if (Test-Path -LiteralPath $actualPath -PathType Leaf) {
                    $actualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $actualPath).Hash
                }

                if (-not [string]::Equals($actualSha, $targetSha, [System.StringComparison]::OrdinalIgnoreCase)) {
                    [void]$mismatchedPaths.Add($actualPath)
                }
            }

            if ($mismatchedPaths.Count -eq 0) {
                continue
            }

            [void]$changes.Add([pscustomobject][ordered]@{
                    key = $key
                    path = $componentPath
                    oldSha = "actual mismatch: " + ($mismatchedPaths.ToArray() -join "; ")
                    newSha = $targetSha
                })
            continue
        }

        $installedSha = Get-InstalledComponentSha256 -Key $key -TargetComponent $targetComponent -InstalledManifest $InstalledManifest -PackageTarget $PackageTarget
        if ([string]::Equals($installedSha, $targetSha, [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }

        [void]$changes.Add([pscustomobject][ordered]@{
                key = $key
                path = $componentPath
                oldSha = $installedSha
                newSha = $targetSha
            })
    }

    return $changes.ToArray()
}

function Write-UpdateReport {
    param(
        [string]$Status,
        [string]$Message,
        [object]$Channel,
        [object]$InstalledState,
        [string]$PreviousVersion = "",
        [string]$InstalledVersion = "",
        [string]$LocalReportPath,
        [string]$RemoteReportsRoot
    )

    $targetReportVersion = if ($Channel) { [string]$Channel.version } else { $null }
    $previousReportVersion = if (-not [string]::IsNullOrWhiteSpace($PreviousVersion)) {
        $PreviousVersion
    }
    elseif ($InstalledState) {
        [string]$InstalledState.version
    }
    else {
        $null
    }
    $installedReportVersion = if (-not [string]::IsNullOrWhiteSpace($InstalledVersion)) {
        $InstalledVersion
    }
    elseif ($InstalledState) {
        [string]$InstalledState.version
    }
    else {
        $null
    }
    $transition = if ($targetReportVersion) {
        "{0} -> {1}" -f (Get-VersionLabel $previousReportVersion), $targetReportVersion
    }
    else {
        $null
    }

    $report = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        updaterVersion = $updaterVersion
        status = $Status
        message = $Message
        computerName = $env:COMPUTERNAME
        userName = $env:USERNAME
        atUtc = (Get-Date).ToUniversalTime().ToString("o")
        channel = if ($Channel) { $Channel.channel } else { $null }
        previousVersion = $previousReportVersion
        targetVersion = $targetReportVersion
        installedVersion = $installedReportVersion
        versionTransition = $transition
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

    Write-JsonFile -Path $LocalReportPath -Value $report

    if (-not [string]::IsNullOrWhiteSpace($RemoteReportsRoot)) {
        try {
            New-Item -ItemType Directory -Path $RemoteReportsRoot -Force | Out-Null
            $safeUser = ($env:USERNAME -replace '[\\/:*?"<>|]', "_")
            $safeComputer = ($env:COMPUTERNAME -replace '[\\/:*?"<>|]', "_")
            $remotePath = Join-Path $RemoteReportsRoot ("{0}_{1}.json" -f $safeComputer, $safeUser)
            Write-JsonFile -Path $remotePath -Value $report
        }
        catch {
            Write-Warning "Could not write remote report: $($_.Exception.Message)"
        }
    }
}

function Get-NotificationState {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Test-ShouldNotifyUser {
    param(
        [string]$StatePath,
        [string]$Key,
        [int]$ThrottleMinutes
    )

    if (-not $NotifyUser) {
        return $false
    }

    $state = Get-NotificationState -Path $StatePath
    if ($null -eq $state) {
        return $true
    }

    $lastKey = [string](Get-JsonPropertyValue -Object $state -Name "key")
    $lastAtUtc = [string](Get-JsonPropertyValue -Object $state -Name "lastAtUtc")
    if (-not [string]::Equals($lastKey, $Key, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    if ([string]::IsNullOrWhiteSpace($lastAtUtc)) {
        return $true
    }

    try {
        $lastAt = [datetime]::Parse($lastAtUtc).ToUniversalTime()
        return (((Get-Date).ToUniversalTime() - $lastAt).TotalMinutes -ge $ThrottleMinutes)
    }
    catch {
        return $true
    }
}

function Show-UserNotification {
    param(
        [string]$Title,
        [string]$Message,
        [string]$Key,
        [string]$Icon = "Information"
    )

    $statePath = Join-Path $WorkRoot "notification-state.json"
    if (-not (Test-ShouldNotifyUser -StatePath $statePath -Key $Key -ThrottleMinutes $NotificationThrottleMinutes)) {
        return
    }

    $state = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        key = $Key
        title = $Title
        message = $Message
        lastAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    Write-JsonFile -Path $statePath -Value $state

    try {
        Add-Type -AssemblyName System.Windows.Forms
        $messageBoxIcon = [System.Windows.Forms.MessageBoxIcon]::Information
        if ([string]::Equals($Icon, "Warning", [System.StringComparison]::OrdinalIgnoreCase)) {
            $messageBoxIcon = [System.Windows.Forms.MessageBoxIcon]::Warning
        }
        elseif ([string]::Equals($Icon, "Error", [System.StringComparison]::OrdinalIgnoreCase)) {
            $messageBoxIcon = [System.Windows.Forms.MessageBoxIcon]::Error
        }

        [System.Windows.Forms.MessageBox]::Show(
            $Message,
            $Title,
            [System.Windows.Forms.MessageBoxButtons]::OK,
            $messageBoxIcon) | Out-Null
    }
    catch {
        Write-Warning "Could not show user notification: $($_.Exception.Message)"
    }
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

function Repair-RevitMcpScheduledTaskAction {
    param(
        [string]$Name,
        [string]$UpdaterPath,
        [string]$UpdaterConfigPath
    )

    Repair-RevitMcpHiddenScheduledTaskAction -Name $Name -UpdaterPath $UpdaterPath -UpdaterConfigPath $UpdaterConfigPath
}

$config = Import-UpdaterConfig -Path $ConfigPath
if ($config) {
    if ([string]::IsNullOrWhiteSpace($ChannelManifestPath) -and $config.channelManifestPath) { $ChannelManifestPath = [string]$config.channelManifestPath }
    if ($config.installRoot) { $InstallRoot = [string]$config.installRoot }
    if ($config.workRoot) { $WorkRoot = [string]$config.workRoot }
    if ($config.packageTarget) { $PackageTarget = [string]$config.packageTarget }
    if ($config.serverTarget) { $ServerTarget = [string]$config.serverTarget }
    if ($config.workspaceAgentsTarget) { $WorkspaceAgentsTarget = [string]$config.workspaceAgentsTarget }
    if ($config.revitInstallRoot) { $RevitInstallRoot = [string]$config.revitInstallRoot }
    if ($config.revitVersion) { $RevitVersion = [string]$config.revitVersion }
    if ($config.proxyUrl) { $ProxyUrl = [string]$config.proxyUrl }
    if ($config.proxyBypass) { $ProxyBypass = [string]$config.proxyBypass }
    if ($config.codexWorkspaceRoot) { $CodexWorkspaceRoot = [string]$config.codexWorkspaceRoot }
    if ($config.taskName) { $TaskName = [string]$config.taskName }
    if ($config.legacyServerTargets) { $LegacyServerTargets = @($config.legacyServerTargets) }
    if ($config.reportsRoot) { $ReportsRoot = [string]$config.reportsRoot }
    if ($config.skipNpmInstall) { $SkipNpmInstall = $true }
    if ($config.skipCodexMcpRegistration) { $SkipCodexMcpRegistration = $true }
    if ($config.skipCodexUserIntegration) { $SkipCodexUserIntegration = $true }
    if ($config.skipProxySetup) { $SkipProxySetup = $true }
    if ($config.notifyUser -and -not $NoNotifyUser) { $NotifyUser = $true }
    if ($config.notificationThrottleMinutes) { $NotificationThrottleMinutes = [int]$config.notificationThrottleMinutes }
    if ([string]::IsNullOrWhiteSpace($LogPath) -and $config.updateLogPath) { $LogPath = [string]$config.updateLogPath }
}

if ($NoNotifyUser) {
    $NotifyUser = $false
}

if ([string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
    throw "ChannelManifestPath is required. Pass it directly or through -ConfigPath."
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

Initialize-RevitMcpTranscript -PreferredWorkRoot $WorkRoot -RequestedLogPath $LogPath -Prefix "update"

$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$WorkRoot = [System.IO.Path]::GetFullPath($WorkRoot)
$PackageTarget = Assert-ManagedDirectoryTarget -Path $PackageTarget -ExpectedLeafNames @("package", "revit-mcp-skill")
$ServerTarget = [System.IO.Path]::GetFullPath($ServerTarget)
$RevitInstallRoot = Resolve-RevitInstallRoot -RequestedRoot $RevitInstallRoot -Version $RevitVersion
$statePath = Join-Path $WorkRoot "installed.json"
$localReportPath = Join-Path $WorkRoot "last-update-report.json"
$cacheRoot = Join-Path $WorkRoot "cache"
$stagingRoot = Join-Path $WorkRoot "staging"
$backupRoot = Join-Path $WorkRoot "backups"
New-Item -ItemType Directory -Path $cacheRoot, $stagingRoot, $backupRoot -Force | Out-Null

Initialize-RevitMcpWorkstationProxy -ProxyUrl $ProxyUrl -ProxyBypass $ProxyBypass -Skip:$SkipProxySetup

$taskUpdaterPath = Join-Path $WorkRoot "update-from-nas.ps1"
if (-not (Test-Path -LiteralPath $taskUpdaterPath -PathType Leaf)) {
    $taskUpdaterPath = $PSCommandPath
}
Repair-RevitMcpScheduledTaskAction -Name $TaskName -UpdaterPath $taskUpdaterPath -UpdaterConfigPath $ConfigPath

$channelDir = Split-Path -Parent $ChannelManifestPath
if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
    $releaseRootGuess = Split-Path -Parent $channelDir
    $ReportsRoot = Join-Path $releaseRootGuess "reports"
}

$installedState = Get-InstalledState -Path $statePath
$channel = $null

try {
    if (-not (Test-Path -LiteralPath $ChannelManifestPath)) {
        throw "Channel manifest was not found: $ChannelManifestPath"
    }

    $channel = Get-Content -Raw -LiteralPath $ChannelManifestPath | ConvertFrom-Json
    if ($channel.app -ne "revit-mcp-skill") {
        throw "Channel manifest app is not revit-mcp-skill: $ChannelManifestPath"
    }
    if ([string]::IsNullOrWhiteSpace($channel.version)) {
        throw "Channel manifest does not contain a version: $ChannelManifestPath"
    }

    $targetVersion = [string]$channel.version
    $targetSha = [string]$channel.sha256
    $packagePath = Resolve-ReleasePath -Path ([string]$channel.packagePath) -BaseDirectory $channelDir
    $releaseManifest = $null
    $releaseManifestPath = Resolve-ReleasePath -Path ([string]$channel.manifestPath) -BaseDirectory $channelDir
    if (-not [string]::IsNullOrWhiteSpace($releaseManifestPath) -and (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf)) {
        $releaseManifest = Get-Content -Raw -LiteralPath $releaseManifestPath | ConvertFrom-Json
    }

    if ([string]::IsNullOrWhiteSpace($packagePath)) {
        throw "Channel manifest does not contain packagePath: $ChannelManifestPath"
    }
    if (-not (Test-Path -LiteralPath $packagePath)) {
        throw "Package was not found: $packagePath"
    }

    $installedVersion = if ($installedState) { [string]$installedState.version } else { "" }
    $installedSha = if ($installedState) { [string]$installedState.packageSha256 } else { "" }
    $installedVersionLabel = Get-VersionLabel $installedVersion
    $isFirstInstall = [string]::IsNullOrWhiteSpace($installedVersion)

    Write-Host "Channel version  : $targetVersion"
    Write-Host "Installed version: $installedVersionLabel"
    Write-Host "Version change   : $installedVersionLabel -> $targetVersion"
    Write-Host "Package          : $packagePath"

    $installedManifest = Get-InstalledReleaseManifest -InstalledState $installedState -PackageTarget $PackageTarget
    $revitPayloadChanges = @(Get-RevitPayloadChanges -TargetManifest $releaseManifest -InstalledManifest $installedManifest -PackageTarget $PackageTarget -InstallRoot $InstallRoot -RevitVersion $RevitVersion)
    $releaseComponents = Get-JsonPropertyValue -Object $releaseManifest -Name "components"
    $updateDecision = Get-RevitMcpUpdateDecision `
        -IsFirstInstall:$isFirstInstall `
        -HasReleaseManifest:($null -ne $releaseManifest) `
        -HasReleaseComponents:($null -ne $releaseComponents) `
        -RevitPayloadChangeCount $revitPayloadChanges.Count
    $requiresRevitClosed = [bool]$updateDecision.RequiresRevitClosed
    $skipRevitPayloadInstall = $false
    $revitChangeLabels = @($revitPayloadChanges | ForEach-Object {
            if (-not [string]::IsNullOrWhiteSpace([string]$_.path)) {
                [string]$_.path
            }
            else {
                [string]$_.key
            }
        })
    $isPackageCurrent = ($installedVersion -eq $targetVersion -and $installedSha -eq $targetSha)

    Ensure-UpdateDependencies -SkipNpmInstall:$SkipNpmInstall -SkipCodexMcpRegistration:$SkipCodexMcpRegistration

    if (-not $Force -and $isPackageCurrent -and -not $requiresRevitClosed) {
        $message = "Already up to date."
        Write-Host $message -ForegroundColor Green
        Write-UpdateReport -Status "current" -Message $message -Channel $channel -InstalledState $installedState -PreviousVersion $installedVersion -InstalledVersion $installedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        return
    }
    elseif ($isPackageCurrent -and $revitPayloadChanges.Count -gt 0) {
        Write-Warning "Package version is current, but installed Revit add-in/command files do not match the package. A Revit payload repair is required."
    }

    if ($AuditOnly) {
        $message = if ($isPackageCurrent -and $revitPayloadChanges.Count -gt 0) {
            "Revit payload repair required for current version: $targetVersion"
        }
        else {
            "Update available: $installedVersionLabel -> $targetVersion"
        }
        Write-Host $message -ForegroundColor Yellow
        Write-UpdateReport -Status "update-available" -Message $message -Channel $channel -InstalledState $installedState -PreviousVersion $installedVersion -InstalledVersion $installedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        Show-UserNotification -Title "revAgent update available" -Message $message -Key ("update-available|{0}" -f $targetVersion) -Icon "Information"
        return
    }

    if ($requiresRevitClosed) {
        $revitPayloadReason = if ($isFirstInstall) { "first install" } else { "changed or unknown" }
        Write-Host "Revit payload    : $revitPayloadReason; Revit must be closed before applying this update." -ForegroundColor Yellow
        if ($revitChangeLabels.Count -gt 0) {
            Write-Host ("Changed Revit files: {0}" -f (($revitChangeLabels | Select-Object -First 8) -join "; "))
            if ($revitChangeLabels.Count -gt 8) {
                Write-Host ("Changed Revit files: +{0} more" -f ($revitChangeLabels.Count - 8))
            }
        }
    }
    else {
        Write-Host "Revit payload    : unchanged; Revit can stay open." -ForegroundColor Green
    }

    $runningRevit = Get-Process -Name "Revit" -ErrorAction SilentlyContinue
    $runningDecision = Get-RevitMcpUpdateDecision `
        -IsFirstInstall:$isFirstInstall `
        -HasReleaseManifest:($null -ne $releaseManifest) `
        -HasReleaseComponents:($null -ne $releaseComponents) `
        -RevitPayloadChangeCount $revitPayloadChanges.Count `
        -IsRevitRunning:($null -ne $runningRevit)
    if ($runningDecision.DeferForRevitClose) {
        $message = "Update requires Revit to be closed because Revit add-in/command files changed. Save and synchronize your model, close Revit, then run the updater again."
        if ($revitChangeLabels.Count -gt 0) {
            $message += " Changed files: " + (($revitChangeLabels | Select-Object -First 6) -join "; ")
            if ($revitChangeLabels.Count -gt 6) {
                $message += ("; +{0} more" -f ($revitChangeLabels.Count - 6))
            }
        }
        Write-Warning $message
        Write-UpdateReport -Status "deferred-revit-close-required" -Message $message -Channel $channel -InstalledState $installedState -PreviousVersion $installedVersion -InstalledVersion $installedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        Show-UserNotification -Title "revAgent update requires Revit to close" -Message $message -Key ("deferred-revit-close-required|{0}" -f $targetVersion) -Icon "Warning"
        return
    }
    elseif ($runningDecision.SkipRevitPayloadInstall) {
        $skipRevitPayloadInstall = [bool]$runningDecision.SkipRevitPayloadInstall
        Write-Warning "Revit is running, but this update does not change Revit add-in/command files. Non-Revit files will be updated without touching the active Revit payload."
    }

    if ((Test-Path -LiteralPath (Join-Path $PackageTarget ".git")) -and -not $AllowReplaceGitPackageTarget) {
        throw "PackageTarget is a git working tree. Refusing to replace it without -AllowReplaceGitPackageTarget: $PackageTarget"
    }

    $cachedPackage = Join-Path $cacheRoot ("revit-mcp-skill-{0}.zip" -f $targetVersion)
    Copy-Item -LiteralPath $packagePath -Destination $cachedPackage -Force

    $actualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $cachedPackage).Hash
    if (-not [string]::IsNullOrWhiteSpace($targetSha) -and $actualSha -ne $targetSha) {
        throw "Package hash mismatch. Expected $targetSha but got $actualSha"
    }

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $extractRoot = Join-Path $stagingRoot ("extract-" + $targetVersion + "-" + $stamp)
    Expand-ReleaseArchive -ZipPath $cachedPackage -DestinationPath $extractRoot

    $packageLayout = Resolve-PackageLayout -Root $extractRoot -ReleaseManifest $releaseManifest

    if (Test-Path -LiteralPath $PackageTarget) {
        $backupPath = Join-Path $backupRoot ("revit-mcp-skill.backup-" + $stamp)
        Move-Item -LiteralPath $PackageTarget -Destination $backupPath
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $PackageTarget) -Force | Out-Null
    Move-Item -LiteralPath $extractRoot -Destination $PackageTarget

    $installer = Join-Path $PackageTarget $packageLayout.installerRelativePath
    $docsServerPath = Join-Path $PackageTarget $packageLayout.docsServerRelativePath
    $installArgs = @{
        RevitVersion = $RevitVersion
        InstallRoot = $InstallRoot
        ServerTarget = $ServerTarget
        RevitInstallRoot = $RevitInstallRoot
    }
    if (-not [string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
        $installArgs["WorkspaceAgentsTarget"] = $WorkspaceAgentsTarget
    }
    if ($LegacyServerTargets.Count -gt 0) {
        $installArgs["LegacyServerTargets"] = $LegacyServerTargets
    }
    if ($SkipCodexUserIntegration) {
        $installArgs["SkipCodexUserIntegration"] = $true
    }
    $installArgs["SuppressNextSteps"] = $true
    if ($skipRevitPayloadInstall) {
        $installArgs["SkipRevitPayloadInstall"] = $true
    }

    & $installer @installArgs

    if (-not $SkipNpmInstall) {
        $npmPath = Resolve-RequiredCommand -Name "npm.cmd" -Candidates @(
            (Join-Path ${env:ProgramFiles} "nodejs\npm.cmd"),
            (Join-Path ${env:ProgramFiles(x86)} "nodejs\npm.cmd")
        )
        $powershellPath = Resolve-RequiredCommand -Name "powershell" -Candidates @(
            (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe")
        )

        Invoke-External -FilePath $npmPath -Arguments @("install", "--omit=dev", "--no-audit", "--no-fund") -WorkingDirectory $ServerTarget

        Invoke-External -FilePath $npmPath -Arguments @("install", "--omit=dev", "--no-audit", "--no-fund") -WorkingDirectory $docsServerPath

        $docsCachePath = Join-Path $InstallRoot ("state\revit-api-docs\cache\revit-api-docs-{0}.json" -f $RevitVersion)
        Invoke-External -FilePath $powershellPath -Arguments @(
            "-ExecutionPolicy", "Bypass",
            "-File", (Join-Path $docsServerPath "scripts\build-index.ps1"),
            "-RevitRoot", $RevitInstallRoot,
            "-OutputPath", $docsCachePath
        ) -WorkingDirectory $docsServerPath
    }

    if (-not $SkipCodexMcpRegistration) {
        Ensure-CodexDesktop
        $nodePath = Resolve-RequiredCommand -Name "node.exe" -Candidates @(
            (Join-Path ${env:ProgramFiles} "nodejs\node.exe"),
            (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
        )
        $runtimeServerPath = Join-Path $ServerTarget "build\index.js"
        $docsServerEntryPath = Join-Path $docsServerPath "build\index.js"
        $registeredWithCommand = $false
        $codexPath = Resolve-CodexDesktopCommand
        if (-not [string]::IsNullOrWhiteSpace($codexPath)) {
            try {
                try {
                    & $codexPath mcp remove revit-mcp 2>$null | Out-Null
                }
                catch {}
                try {
                    & $codexPath mcp remove revit-api-docs 2>$null | Out-Null
                }
                catch {}

                Invoke-External -FilePath $codexPath -Arguments @("mcp", "add", "revit-mcp", "--", $nodePath, $runtimeServerPath) -WorkingDirectory $WorkRoot
                Invoke-External -FilePath $codexPath -Arguments @("mcp", "add", "revit-api-docs", "--", $nodePath, $docsServerEntryPath) -WorkingDirectory $WorkRoot
                $registeredWithCommand = $true
            }
            catch {
                Write-Warning "Codex MCP command registration failed; updating config.toml directly. $($_.Exception.Message)"
            }
        }

        if (-not $registeredWithCommand) {
            Write-Host "Codex MCP command was not found; updating config.toml directly."
            Register-CodexMcpServersInConfig -NodePath $nodePath -RuntimeServerPath $runtimeServerPath -DocsServerPath $docsServerEntryPath
        }
    }

    $newState = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        version = $targetVersion
        channel = $channel.channel
        installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        packageSha256 = $actualSha
        packagePath = $packagePath
        manifestPath = $channel.manifestPath
        components = if ($releaseManifest) { $releaseManifest.components } else { $null }
        updatePolicy = if ($releaseManifest) { $releaseManifest.updatePolicy } else { $null }
        revitPayloadChanged = [bool]$requiresRevitClosed
        revitPayloadSkipped = [bool]$skipRevitPayloadInstall
        revitPayloadChangedComponents = @($revitPayloadChanges | ForEach-Object { [string]$_.key })
        updaterVersion = $updaterVersion
        skipCodexUserIntegration = [bool]$SkipCodexUserIntegration
        paths = [ordered]@{
            installRoot = $InstallRoot
            packageTarget = $PackageTarget
            serverTarget = $ServerTarget
            workRoot = $WorkRoot
            revitInstallRoot = $RevitInstallRoot
            channelManifestPath = $ChannelManifestPath
        }
    }
    $updateMessage = "Updated: $installedVersionLabel -> $targetVersion."
    Write-JsonFile -Path $statePath -Value $newState
    Write-UpdateReport -Status "updated" -Message $updateMessage -Channel $channel -InstalledState $newState -PreviousVersion $installedVersion -InstalledVersion $targetVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
    Write-Host $updateMessage -ForegroundColor Green
    Show-UserNotification -Title "revAgent updated" -Message ($updateMessage + "`r`n`r`nInstalled version: " + $targetVersion) -Key ("updated|{0}" -f $targetVersion) -Icon "Information"
}
catch {
    $message = $_.Exception.Message
    $failedVersion = if ($installedState) { [string]$installedState.version } else { "" }
    Write-UpdateReport -Status "failed" -Message $message -Channel $channel -InstalledState $installedState -PreviousVersion $failedVersion -InstalledVersion $failedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
    Write-Host ""
    Write-Host "revAgent update failed: $message" -ForegroundColor Red
    if (-not [string]::IsNullOrWhiteSpace($script:RevitMcpLogPath)) {
        Write-Host "Update log: $script:RevitMcpLogPath" -ForegroundColor Yellow
    }
    throw
}
finally {
    Complete-RevitMcpTranscript
}
