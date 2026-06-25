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
    [ValidateSet("", "compatibility", "enforce")]
    [string]$DistributionIntegrityPolicy = "",
    [ValidateSet("", "managed-user-pack", "preserve-local")]
    [string]$CodexInstructionPolicy = "",
    [string]$MachineRole = "",
    [switch]$AllowSignedReleaseRollback,
    [ValidateSet("", "disabled", "audit", "enforce")]
    [string]$LicensePolicy = "",
    [string]$LicensePath = "",
    [string]$LicenseSignaturePath = "",
    [switch]$Force,
    [switch]$SourceFreeMigration,
    [switch]$AuditOnly,
    [switch]$SkipNpmInstall,
    [switch]$SkipCodexMcpRegistration,
    [switch]$SkipCodexUserIntegration,
    [switch]$SkipProxySetup,
    [switch]$AllowManualCodexSetup,
    [string]$CodexWorkspaceRoot = "C:\Projects",
    [string]$TaskName = "revAgent Auto Update",
    [string]$LogPath = "",
    [string]$OperationMethod = "",
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
    throw "revAgent updater lib folder was not found beside or above: $PSScriptRoot"
}
Import-Module (Join-Path $nasLibRoot "RevitMcp.HiddenLauncher.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.ScheduledTask.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.RevitVersions.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.Package.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.UpdatePolicy.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.Proxy.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.LogRetention.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.CodexRegistration.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.ConfigSync.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.Reporting.psm1") -Force
$script:RevitMcpDistributionIntegrityModule = Import-Module (Join-Path $nasLibRoot "RevitMcp.DistributionIntegrity.psm1") -Force -PassThru
Import-Module (Join-Path $nasLibRoot "RevitMcp.License.psm1") -Force
Import-Module (Join-Path $nasLibRoot "RevitMcp.SourceFreeMigration.psm1") -Force
Set-RevitMcpCurrentProcessUtf8Console | Out-Null

$updaterVersion = "0.1.0"
$script:RevitMcpTranscriptStarted = $false
$script:RevitMcpLogPath = ""
$script:PreviousTranscriptActive = $env:REVIT_MCP_TRANSCRIPT_ACTIVE
$script:PreviousLogPath = $env:REVIT_MCP_LOG_PATH
$script:RevitMcpProxyUrl = ""
$script:RevitMcpProxyBypass = "<local>"
$script:RevitMcpRemoteReportsRoot = ""
$script:RevitMcpLatestReport = $null
$script:RevitMcpDistributionIntegrityPolicy = "compatibility"
$script:RevitMcpTrustedReleaseKeys = @{}
$script:RevitMcpTrustedReleaseKeySources = @()
$script:RevitMcpDistributionIntegrity = [ordered]@{
    success = $false
    state = "not-evaluated"
    reason = "not_evaluated"
    message = "Distribution integrity has not been evaluated yet."
    policy = $script:RevitMcpDistributionIntegrityPolicy
    trustedKeyCount = 0
}
$script:RevitMcpLicensePolicy = "disabled"
$script:RevitMcpTrustedLicenseKeys = @{}
$script:RevitMcpTrustedLicenseKeySources = @()
$script:RevitMcpLicense = [ordered]@{
    success = $true
    valid = $false
    state = "disabled"
    reason = "disabled"
    message = "License verification is disabled."
    policy = $script:RevitMcpLicensePolicy
}
$script:RevitMcpOperation = if ($AuditOnly) { "audit" } elseif ($SourceFreeMigration) { "source-free-migration" } elseif ($Force) { "reinstall" } else { "update" }
$script:RevitMcpOperationMethod = if (-not [string]::IsNullOrWhiteSpace($OperationMethod)) {
    $OperationMethod
}
elseif ($AuditOnly) {
    "audit"
}
elseif ($SourceFreeMigration) {
    "source-free-migration"
}
elseif ($Force) {
    "force-update"
}
else {
    "update"
}

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
            Write-Warning "Could not publish remote update report/log: $($_.Exception.Message)"
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
    $message += " Then run the revAgent updater again."
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

function Get-NpmDependencyFingerprint {
    param([string]$WorkingDirectory)

    foreach ($relativePath in @("package-lock.json", "npm-shrinkwrap.json", "package.json")) {
        $candidate = Join-Path $WorkingDirectory $relativePath
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [pscustomobject][ordered]@{
                path = $relativePath
                sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash
            }
        }
    }

    return [pscustomobject][ordered]@{
        path = ""
        sha256 = ""
    }
}

function Get-NpmDependencyMarkerPath {
    param([string]$WorkingDirectory)

    return Join-Path $WorkingDirectory ".revagent-npm-dependencies.json"
}

function Get-NpmPackageCacheName {
    param([string]$WorkingDirectory)

    $packageJsonPath = Join-Path $WorkingDirectory "package.json"
    $name = ""
    if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
        try {
            $packageJson = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json
            $name = [string]$packageJson.name
        }
        catch {
            $name = ""
        }
    }

    if ([string]::IsNullOrWhiteSpace($name)) {
        $name = Split-Path -Leaf $WorkingDirectory
    }

    $safeName = ($name -replace '[^A-Za-z0-9._-]', '_').Trim("_")
    if ([string]::IsNullOrWhiteSpace($safeName)) {
        return "package"
    }

    return $safeName
}

function Get-NpmDependencyCacheNodeModulesPath {
    param(
        [string]$CacheRoot,
        [string]$WorkingDirectory,
        [object]$Fingerprint
    )

    if ([string]::IsNullOrWhiteSpace($CacheRoot) -or [string]::IsNullOrWhiteSpace([string]$Fingerprint.sha256)) {
        return ""
    }

    $packageName = Get-NpmPackageCacheName -WorkingDirectory $WorkingDirectory
    return Join-Path $CacheRoot (Join-Path $packageName (Join-Path ([string]$Fingerprint.sha256) "node_modules"))
}

function Test-NpmDependenciesCurrent {
    param(
        [string]$WorkingDirectory,
        [object]$Fingerprint
    )

    $nodeModulesPath = Join-Path $WorkingDirectory "node_modules"
    if (-not (Test-Path -LiteralPath $nodeModulesPath -PathType Container)) {
        return $false
    }

    $markerPath = Get-NpmDependencyMarkerPath -WorkingDirectory $WorkingDirectory
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        return $false
    }

    try {
        $marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
        return [string]::Equals([string]$marker.fingerprintPath, [string]$Fingerprint.path, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals([string]$marker.fingerprintSha256, [string]$Fingerprint.sha256, [System.StringComparison]::OrdinalIgnoreCase) -and
            [bool]$marker.omitDev
    }
    catch {
        return $false
    }
}

function Restore-NpmDependenciesFromCache {
    param(
        [string]$WorkingDirectory,
        [object]$Fingerprint,
        [string]$CacheRoot
    )

    $nodeModulesPath = Join-Path $WorkingDirectory "node_modules"
    if (Test-Path -LiteralPath $nodeModulesPath -PathType Container) {
        return $false
    }

    $cacheNodeModulesPath = Get-NpmDependencyCacheNodeModulesPath -CacheRoot $CacheRoot -WorkingDirectory $WorkingDirectory -Fingerprint $Fingerprint
    if ([string]::IsNullOrWhiteSpace($cacheNodeModulesPath) -or -not (Test-Path -LiteralPath $cacheNodeModulesPath -PathType Container)) {
        return $false
    }

    try {
        New-Item -ItemType Junction -Path $nodeModulesPath -Target $cacheNodeModulesPath -Force | Out-Null
        Write-NpmDependencyMarker -WorkingDirectory $WorkingDirectory -Fingerprint $Fingerprint
        return $true
    }
    catch {
        Write-Warning "Could not link cached npm dependencies; copying instead. $($_.Exception.Message)"
        Copy-Item -LiteralPath $cacheNodeModulesPath -Destination $nodeModulesPath -Recurse -Force
        Write-NpmDependencyMarker -WorkingDirectory $WorkingDirectory -Fingerprint $Fingerprint
        return $true
    }
}

function Remove-StaleNpmDependencyJunction {
    param([string]$WorkingDirectory)

    $nodeModulesPath = Join-Path $WorkingDirectory "node_modules"
    if (-not (Test-Path -LiteralPath $nodeModulesPath -PathType Container)) {
        return
    }

    $item = Get-Item -LiteralPath $nodeModulesPath -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        return
    }

    Remove-Item -LiteralPath $nodeModulesPath -Force
}

function Write-NpmDependencyMarker {
    param(
        [string]$WorkingDirectory,
        [object]$Fingerprint
    )

    $marker = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        fingerprintPath = [string]$Fingerprint.path
        fingerprintSha256 = [string]$Fingerprint.sha256
        omitDev = $true
        installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    $markerPath = Get-NpmDependencyMarkerPath -WorkingDirectory $WorkingDirectory
    $marker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $markerPath -Encoding UTF8
}

function Save-NpmDependenciesToCache {
    param(
        [string]$WorkingDirectory,
        [object]$Fingerprint,
        [string]$CacheRoot
    )

    $nodeModulesPath = Join-Path $WorkingDirectory "node_modules"
    if (-not (Test-Path -LiteralPath $nodeModulesPath -PathType Container)) {
        return
    }

    $cacheNodeModulesPath = Get-NpmDependencyCacheNodeModulesPath -CacheRoot $CacheRoot -WorkingDirectory $WorkingDirectory -Fingerprint $Fingerprint
    if ([string]::IsNullOrWhiteSpace($cacheNodeModulesPath) -or (Test-Path -LiteralPath $cacheNodeModulesPath -PathType Container)) {
        return
    }

    $cachePackageRoot = Split-Path -Parent $cacheNodeModulesPath
    New-Item -ItemType Directory -Path $cachePackageRoot -Force | Out-Null
    Copy-Item -LiteralPath $nodeModulesPath -Destination $cachePackageRoot -Recurse -Force
}

function Invoke-NpmInstallIfNeeded {
    param(
        [string]$NpmPath,
        [string]$WorkingDirectory,
        [string]$Label,
        [string]$CacheRoot
    )

    $fingerprint = Get-NpmDependencyFingerprint -WorkingDirectory $WorkingDirectory
    if ([string]::IsNullOrWhiteSpace([string]$fingerprint.sha256)) {
        Write-Host "$Label dependencies: package manifest not found; running npm install."
        Invoke-External -FilePath $NpmPath -Arguments @("install", "--omit=dev", "--no-audit", "--no-fund") -WorkingDirectory $WorkingDirectory
        return
    }

    if (Test-NpmDependenciesCurrent -WorkingDirectory $WorkingDirectory -Fingerprint $fingerprint) {
        Write-Host "$Label dependencies: current; npm install skipped."
        return
    }

    Remove-StaleNpmDependencyJunction -WorkingDirectory $WorkingDirectory

    if (Restore-NpmDependenciesFromCache -WorkingDirectory $WorkingDirectory -Fingerprint $fingerprint -CacheRoot $CacheRoot) {
        Write-Host "$Label dependencies: restored from local cache; npm install skipped."
        return
    }

    Write-Host "$Label dependencies: installing or refreshing."
    Invoke-External -FilePath $NpmPath -Arguments @("install", "--omit=dev", "--no-audit", "--no-fund") -WorkingDirectory $WorkingDirectory
    Write-NpmDependencyMarker -WorkingDirectory $WorkingDirectory -Fingerprint $fingerprint
    Save-NpmDependenciesToCache -WorkingDirectory $WorkingDirectory -Fingerprint $fingerprint -CacheRoot $CacheRoot
}

function Resolve-NpmCommand {
    return Resolve-RequiredCommand -Name "npm.cmd" -Candidates @(
        (Join-Path ${env:ProgramFiles} "nodejs\npm.cmd"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\npm.cmd")
    )
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
    [void](Set-RevitMcpCodexMemoryConfig -ConfigPath $configPath)
    Write-Host "Codex MCP config : $configPath"
}

function Set-CodexMemoryConfig {
    $configRoot = Join-Path $env:USERPROFILE ".codex"
    $configPath = Join-Path $configRoot "config.toml"
    [void](Set-RevitMcpCodexMemoryConfig -ConfigPath $configPath)
    Write-Host "Codex memory config: enabled"
    return $configPath
}

function Remove-CodexProfileBackupArtifacts {
    if ($SkipCodexUserIntegration) {
        return
    }

    $codexRoot = Join-Path $env:USERPROFILE ".codex"
    if (-not (Test-Path -LiteralPath $codexRoot -PathType Container)) {
        return
    }

    $removed = 0
    foreach ($pattern in @("AGENTS.md.backup-*", "config.toml.backup-*")) {
        Get-ChildItem -LiteralPath $codexRoot -File -Filter $pattern -ErrorAction SilentlyContinue |
            ForEach-Object {
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
                $removed++
            }
    }

    $codexSkillsRoot = Join-Path $codexRoot "skills"
    if (Test-Path -LiteralPath $codexSkillsRoot -PathType Container) {
        Get-ChildItem -LiteralPath $codexSkillsRoot -Directory -Filter "revit-mcp.backup-*" -ErrorAction SilentlyContinue |
            ForEach-Object {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
                $removed++
            }
    }

    $legacySkillBackupsRoot = Join-Path $codexRoot "skill-backups"
    if (Test-Path -LiteralPath $legacySkillBackupsRoot -PathType Container) {
        Remove-Item -LiteralPath $legacySkillBackupsRoot -Recurse -Force -ErrorAction Stop
        $removed++
    }

    if ($removed -gt 0) {
        Write-Host ("Codex cleanup   : removed {0} old backup artifact(s)" -f $removed) -ForegroundColor Green
    }
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

    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
        return $Object[$Name]
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($property) {
        return $property.Value
    }

    return $null
}

function Resolve-CodexInstructionPolicy {
    param(
        [string]$RequestedPolicy,
        [object]$Config
    )

    $policy = $RequestedPolicy
    if ([string]::IsNullOrWhiteSpace($policy)) {
        $configuredPolicy = Get-JsonPropertyValue -Object $Config -Name "codexInstructionPolicy"
        if ($null -ne $configuredPolicy) {
            $policy = [string]$configuredPolicy
        }
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
        [object]$Config
    )

    $role = $RequestedRole
    if ([string]::IsNullOrWhiteSpace($role)) {
        $configuredRole = Get-JsonPropertyValue -Object $Config -Name "machineRole"
        if ($null -ne $configuredRole) {
            $role = [string]$configuredRole
        }
    }
    if ([string]::IsNullOrWhiteSpace($role) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_MACHINE_ROLE)) {
        $role = [string]$env:REVIT_MCP_MACHINE_ROLE
    }

    return $role
}

function Get-UpdaterDistributionIntegrityCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$Required
    )

    $command = $null
    $module = @($script:RevitMcpDistributionIntegrityModule | Select-Object -First 1)
    if ($module) {
        if ($module.ExportedFunctions -and $module.ExportedFunctions.ContainsKey($Name)) {
            $command = $module.ExportedFunctions[$Name]
        }
        elseif ($module.ExportedCommands -and $module.ExportedCommands.ContainsKey($Name)) {
            $command = $module.ExportedCommands[$Name]
        }
    }

    if (-not $command) {
        $command = Get-Command ("RevitMcp.DistributionIntegrity\{0}" -f $Name) -ErrorAction SilentlyContinue
    }
    if (-not $command) {
        $command = Get-Command $Name -ErrorAction SilentlyContinue
    }
    if (-not $command -and $Required) {
        throw "Distribution integrity helper '$Name' was not loaded from RevitMcp.DistributionIntegrity.psm1."
    }

    return $command
}

function Add-TrustedReleaseKeys {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Target,
        [AllowNull()][object]$Source
    )

    $convertCommand = Get-UpdaterDistributionIntegrityCommand -Name "ConvertTo-RevitMcpTrustedKeyMap" -Required
    $sourceMap = & $convertCommand -TrustedKeys $Source
    foreach ($key in $sourceMap.Keys) {
        $Target[[string]$key] = $sourceMap[$key]
    }

    return $sourceMap.Count
}

function Resolve-UpdaterConfigRelativePath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }

    if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
        $configDir = Split-Path -Parent $ConfigPath
        if (-not [string]::IsNullOrWhiteSpace($configDir)) {
            return [System.IO.Path]::GetFullPath((Join-Path $configDir $Path))
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($WorkRoot)) {
        return [System.IO.Path]::GetFullPath((Join-Path $WorkRoot $Path))
    }

    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Path))
}

function Get-UpdaterDetachedSignaturePath {
    param([Parameter(Mandatory = $true)][string]$ContentPath)

    $command = Get-UpdaterDistributionIntegrityCommand -Name "Get-RevitMcpDetachedSignaturePath"
    if ($command) {
        return & $command -ContentPath $ContentPath
    }

    $directory = Split-Path -Parent $ContentPath
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($ContentPath)
    return Join-Path $directory ("{0}.sig.json" -f $baseName)
}

function Add-TrustedReleaseKeysFromFile {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Target,
        [string]$Path,
        [switch]$Required
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    $fullPath = Resolve-UpdaterConfigRelativePath -Path $Path
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        if ($Required) {
            throw "Configured release trusted-key file was not found: $fullPath"
        }
        return $null
    }

    $document = Get-Content -Raw -LiteralPath $fullPath | ConvertFrom-Json
    $trustedKeys = Get-JsonPropertyValue -Object $document -Name "trustedKeys"
    if ($null -eq $trustedKeys) {
        $trustedKeys = $document
    }

    $keyCount = Add-TrustedReleaseKeys -Target $Target -Source $trustedKeys
    return [pscustomobject]@{ Path = $fullPath; KeyCount = [int]$keyCount }
}

function Set-DistributionIntegrityBlockedReport {
    param(
        [string]$Policy,
        [hashtable]$TrustedKeys,
        [System.Collections.Generic.List[string]]$Sources,
        [string]$Reason,
        [string]$Message,
        [string]$TrustedKeysPath = ""
    )

    $effectivePolicy = if ([string]::IsNullOrWhiteSpace($Policy)) { "enforce" } else { $Policy }
    $script:RevitMcpDistributionIntegrityPolicy = $effectivePolicy
    $script:RevitMcpTrustedReleaseKeys = $TrustedKeys
    $script:RevitMcpTrustedReleaseKeySources = @($Sources.ToArray())
    $script:RevitMcpDistributionIntegrity = [ordered]@{
        success = $false
        state = "blocked"
        reason = $Reason
        message = $Message
        policy = $effectivePolicy
        trustedKeyCount = $TrustedKeys.Count
        trustedKeySources = @($script:RevitMcpTrustedReleaseKeySources)
        trustedKeysPath = $TrustedKeysPath
    }
}

function Initialize-DistributionIntegrityConfig {
    param([AllowNull()][object]$Config)

    $policy = ""
    $trustedKeys = @{}
    $sources = [System.Collections.Generic.List[string]]::new()
    $consumedKeyPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $integrityConfig = if ($Config) { Get-JsonPropertyValue -Object $Config -Name "distributionIntegrity" } else { $null }

    if ($integrityConfig) {
        $configuredPolicy = [string](Get-JsonPropertyValue -Object $integrityConfig -Name "policy")
        if (-not [string]::IsNullOrWhiteSpace($configuredPolicy)) {
            if ($configuredPolicy -notin @("compatibility", "enforce")) {
                throw "Unsupported distribution integrity policy '$configuredPolicy'."
            }
            $policy = $configuredPolicy
        }

        $directTrustedKeys = Get-JsonPropertyValue -Object $integrityConfig -Name "trustedKeys"
        if ($null -ne $directTrustedKeys) {
            $added = Add-TrustedReleaseKeys -Target $trustedKeys -Source $directTrustedKeys
            if ($added -gt 0) {
                [void]$sources.Add("updater-config")
            }
        }

        $trustedKeysPath = [string](Get-JsonPropertyValue -Object $integrityConfig -Name "trustedKeysPath")
        if (-not [string]::IsNullOrWhiteSpace($trustedKeysPath)) {
            try {
                $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $trustedKeysPath -Required
            }
            catch {
                $resolvedTrustedKeysPath = Resolve-UpdaterConfigRelativePath -Path $trustedKeysPath
                $message = "Trusted release keys are configured but could not be loaded from '$resolvedTrustedKeysPath'. Run Install/Repair after restoring release-trusted-keys.json."
                Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_missing" -Message $message -TrustedKeysPath $resolvedTrustedKeysPath
                throw $message
            }
            if ($loaded) {
                [void]$sources.Add($loaded.Path)
                [void]$consumedKeyPaths.Add($loaded.Path)
            }
        }

        $trustedKeyPaths = Get-JsonPropertyValue -Object $integrityConfig -Name "trustedKeyPaths"
        foreach ($path in @($trustedKeyPaths)) {
            if ([string]::IsNullOrWhiteSpace([string]$path)) {
                continue
            }
            try {
                $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path ([string]$path) -Required
            }
            catch {
                $resolvedTrustedKeysPath = Resolve-UpdaterConfigRelativePath -Path ([string]$path)
                $message = "Trusted release keys are configured but could not be loaded from '$resolvedTrustedKeysPath'. Run Install/Repair after restoring release-trusted-keys.json."
                Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_missing" -Message $message -TrustedKeysPath $resolvedTrustedKeysPath
                throw $message
            }
            if ($loaded) {
                [void]$sources.Add($loaded.Path)
                [void]$consumedKeyPaths.Add($loaded.Path)
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($DistributionIntegrityPolicy)) {
        $policy = $DistributionIntegrityPolicy
    }

    foreach ($candidate in @(
            (Join-Path $WorkRoot "config\release-trusted-keys.json"),
            (Join-Path $PSScriptRoot "config\release-trusted-keys.json"),
            (Join-Path (Split-Path -Parent $PSScriptRoot) "config\release-trusted-keys.json")
        )) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        $candidateFullPath = [System.IO.Path]::GetFullPath($candidate)
        if ($consumedKeyPaths.Contains($candidateFullPath)) {
            continue
        }
        try {
            $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $candidate -Required
        }
        catch {
            $message = "Auto-discovered trusted release keys could not be loaded from '$candidate'. Run Install/Repair after restoring release-trusted-keys.json."
            Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_invalid" -Message $message -TrustedKeysPath $candidate
            throw $message
        }
        if ($null -eq $loaded -or $loaded.KeyCount -le 0) {
            $message = "Auto-discovered trusted release keys file '$candidate' did not contain any trusted keys. Run Install/Repair after restoring release-trusted-keys.json."
            Set-DistributionIntegrityBlockedReport -Policy $policy -TrustedKeys $trustedKeys -Sources $sources -Reason "trusted_keys_empty" -Message $message -TrustedKeysPath $candidate
            throw $message
        }
        [void]$consumedKeyPaths.Add($candidateFullPath)
        [void]$consumedKeyPaths.Add($loaded.Path)
        [void]$sources.Add($loaded.Path)
    }

    if ([string]::IsNullOrWhiteSpace($policy)) {
        $policy = if ($trustedKeys.Count -gt 0) { "enforce" } else { "compatibility" }
    }
    elseif ($trustedKeys.Count -gt 0 -and [string]::Equals($policy, "compatibility", [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Warning "DistributionIntegrityPolicy compatibility was escalated to enforce because trusted release keys are configured."
        $policy = "enforce"
    }

    $script:RevitMcpDistributionIntegrityPolicy = $policy
    $script:RevitMcpTrustedReleaseKeys = $trustedKeys
    $script:RevitMcpTrustedReleaseKeySources = @($sources.ToArray())
    $script:RevitMcpDistributionIntegrity = [ordered]@{
        success = $true
        state = "configured"
        reason = "configured"
        message = "Distribution integrity policy loaded."
        policy = $policy
        trustedKeyCount = $trustedKeys.Count
        trustedKeySources = @($script:RevitMcpTrustedReleaseKeySources)
    }
}

function ConvertTo-Int64OrZero {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return [long]0
    }

    $parsed = [long]0
    if ([long]::TryParse([string]$Value, [System.Globalization.NumberStyles]::Integer, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        return $parsed
    }

    return [long]0
}

function Test-TruthyJsonValue {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) {
        return $false
    }
    if ($Value -is [bool]) {
        return [bool]$Value
    }

    $text = [string]$Value
    return [string]::Equals($text, "true", [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($text, "1", [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($text, "yes", [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-InstalledHighestAcceptedReleaseSequence {
    param([AllowNull()][object]$InstalledState)

    if ($null -eq $InstalledState) {
        return [long]0
    }

    $highest = ConvertTo-Int64OrZero -Value (Get-JsonPropertyValue -Object $InstalledState -Name "highestAcceptedReleaseSequence")
    $topLevelSequence = ConvertTo-Int64OrZero -Value (Get-JsonPropertyValue -Object $InstalledState -Name "releaseSequence")
    $highest = [Math]::Max($highest, $topLevelSequence)
    $hasAcceptedSignedRelease = Test-TruthyJsonValue -Value (Get-JsonPropertyValue -Object $InstalledState -Name "hasAcceptedSignedRelease")
    $integrity = Get-JsonPropertyValue -Object $InstalledState -Name "distributionIntegrity"
    if ($integrity) {
        $highest = [Math]::Max($highest, (ConvertTo-Int64OrZero -Value (Get-JsonPropertyValue -Object $integrity -Name "highestAcceptedReleaseSequence")))
        $highest = [Math]::Max($highest, (ConvertTo-Int64OrZero -Value (Get-JsonPropertyValue -Object $integrity -Name "releaseSequence")))
        $integrityState = [string](Get-JsonPropertyValue -Object $integrity -Name "state")
        if ([string]::Equals($integrityState, "verified", [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($integrityState, "rollback-allowed", [System.StringComparison]::OrdinalIgnoreCase)) {
            $hasAcceptedSignedRelease = $true
        }
    }
    if ($hasAcceptedSignedRelease -and $highest -lt 1) {
        $highest = [long]1
    }

    return [long]$highest
}

function Initialize-LicenseConfig {
    param([AllowNull()][object]$Config)

    $policy = "disabled"
    $trustedKeys = @{}
    $sources = [System.Collections.Generic.List[string]]::new()
    $configuredLicensePath = $LicensePath
    $configuredSignaturePath = $LicenseSignaturePath
    $licenseConfig = if ($Config) { Get-JsonPropertyValue -Object $Config -Name "license" } else { $null }

    if ($licenseConfig) {
        $configuredPolicy = [string](Get-JsonPropertyValue -Object $licenseConfig -Name "policy")
        if (-not [string]::IsNullOrWhiteSpace($configuredPolicy)) {
            if ($configuredPolicy -notin @("disabled", "audit", "enforce")) {
                throw "Unsupported license policy '$configuredPolicy'."
            }
            $policy = $configuredPolicy
        }

        $directTrustedKeys = Get-JsonPropertyValue -Object $licenseConfig -Name "trustedKeys"
        if ($null -ne $directTrustedKeys) {
            $added = Add-TrustedReleaseKeys -Target $trustedKeys -Source $directTrustedKeys
            if ($added -gt 0) {
                [void]$sources.Add("updater-config")
            }
        }

        $trustedKeysPath = [string](Get-JsonPropertyValue -Object $licenseConfig -Name "trustedKeysPath")
        if (-not [string]::IsNullOrWhiteSpace($trustedKeysPath)) {
            $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $trustedKeysPath -Required
            if ($loaded) {
                [void]$sources.Add($loaded.Path)
            }
        }

        if ([string]::IsNullOrWhiteSpace($configuredLicensePath)) {
            $configuredLicensePath = [string](Get-JsonPropertyValue -Object $licenseConfig -Name "licensePath")
        }
        if ([string]::IsNullOrWhiteSpace($configuredSignaturePath)) {
            $configuredSignaturePath = [string](Get-JsonPropertyValue -Object $licenseConfig -Name "signaturePath")
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($LicensePolicy)) {
        $policy = $LicensePolicy
    }

    foreach ($candidate in @(
            (Join-Path $WorkRoot "config\license-trusted-keys.json"),
            (Join-Path $PSScriptRoot "config\license-trusted-keys.json"),
            (Join-Path (Split-Path -Parent $PSScriptRoot) "config\license-trusted-keys.json")
        )) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        $loaded = Add-TrustedReleaseKeysFromFile -Target $trustedKeys -Path $candidate
        if ($loaded) {
            [void]$sources.Add($loaded.Path)
        }
    }

    if ([string]::IsNullOrWhiteSpace($configuredLicensePath)) {
        foreach ($candidate in @(
                (Join-Path $InstallRoot "license\revagent-license.json"),
                (Join-Path $WorkRoot "license\revagent-license.json"),
                (Join-Path $WorkRoot "config\revagent-license.json")
            )) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $configuredLicensePath = $candidate
                break
            }
        }
        if ([string]::IsNullOrWhiteSpace($configuredLicensePath)) {
            $configuredLicensePath = Join-Path $InstallRoot "license\revagent-license.json"
        }
    }
    else {
        $configuredLicensePath = Resolve-UpdaterConfigRelativePath -Path $configuredLicensePath
    }

    if ([string]::IsNullOrWhiteSpace($configuredSignaturePath)) {
        $configuredSignaturePath = Get-UpdaterDetachedSignaturePath -ContentPath $configuredLicensePath
    }
    else {
        $configuredSignaturePath = Resolve-UpdaterConfigRelativePath -Path $configuredSignaturePath
    }

    $script:RevitMcpLicensePolicy = $policy
    $script:RevitMcpTrustedLicenseKeys = $trustedKeys
    $script:RevitMcpTrustedLicenseKeySources = @($sources.ToArray())
    $script:RevitMcpLicense = Test-RevitMcpLicenseSeatFile `
        -LicensePath $configuredLicensePath `
        -SignaturePath $configuredSignaturePath `
        -TrustedKeys $trustedKeys `
        -Policy $policy

    $script:RevitMcpLicense | Add-Member -NotePropertyName "trustedKeyCount" -NotePropertyValue $trustedKeys.Count -Force
    $script:RevitMcpLicense | Add-Member -NotePropertyName "trustedKeySources" -NotePropertyValue @($script:RevitMcpTrustedLicenseKeySources) -Force
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

function Get-DirectoryTreeSha256OrNull {
    param(
        [string]$Root,
        [string]$RelativePath,
        [string[]]$ExcludeDirectoryNames = @("node_modules", ".git"),
        [string[]]$ExcludeFileNames = @(".revagent-npm-dependencies.json", ".npm-deps.sha256")
    )

    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($RelativePath)) {
        return ""
    }

    $path = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        return ""
    }

    $excluded = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $ExcludeDirectoryNames) {
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            [void]$excluded.Add($name)
        }
    }
    $excludedFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $ExcludeFileNames) {
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            [void]$excludedFiles.Add($name)
        }
    }

    $files = Get-ChildItem -LiteralPath $path -Recurse -File -Force |
        Where-Object {
            if ($excludedFiles.Contains($_.Name)) {
                return $false
            }

            $relative = $_.FullName.Substring($path.Length).TrimStart("\", "/")
            $parts = $relative -split '[\\/]'
            foreach ($part in $parts) {
                if ($excluded.Contains($part)) {
                    return $false
                }
            }
            return $true
        } |
        Sort-Object FullName

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($path.Length).TrimStart("\", "/").Replace("\", "/")
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
        [void]$lines.Add(("{0}|{1}|{2}" -f $relative, $file.Length, $hash))
    }

    $payload = [System.Text.Encoding]::UTF8.GetBytes(($lines.ToArray() -join "`n"))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash($payload)
    }
    finally {
        $sha.Dispose()
    }

    return ([System.BitConverter]::ToString($digest) -replace "-", "")
}

function Test-DirectoryPayloadUnchanged {
    param(
        [object]$Manifest,
        [string]$ComponentKey,
        [string]$PackageTarget
    )

    $component = Get-ComponentByKey -Manifest $Manifest -Key $ComponentKey
    $targetSha = Get-ComponentSha256 -Component $component
    $relativePath = Get-ComponentPath -Component $component
    if ([string]::IsNullOrWhiteSpace($targetSha) -or [string]::IsNullOrWhiteSpace($relativePath)) {
        return $false
    }

    $installedSha = Get-DirectoryTreeSha256OrNull -Root $PackageTarget -RelativePath $relativePath
    return (-not [string]::IsNullOrWhiteSpace($installedSha)) -and
        [string]::Equals($installedSha, $targetSha, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-ManifestComponentUnchanged {
    param(
        [object]$TargetManifest,
        [object]$InstalledManifest,
        [string]$ComponentKey,
        [string]$PackageTarget
    )

    $targetComponent = Get-ComponentByKey -Manifest $TargetManifest -Key $ComponentKey
    $targetSha = Get-ComponentSha256 -Component $targetComponent
    if ([string]::IsNullOrWhiteSpace($targetSha)) {
        return $false
    }

    $installedSha = Get-InstalledComponentSha256 -Key $ComponentKey -TargetComponent $targetComponent -InstalledManifest $InstalledManifest -PackageTarget $PackageTarget
    return (-not [string]::IsNullOrWhiteSpace($installedSha)) -and
        [string]::Equals($installedSha, $targetSha, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-CodexSkillInstallPresent {
    param(
        [string]$InstallRoot,
        [switch]$SkipUserIntegration
    )

    $machineSkillPath = Join-Path $InstallRoot "codex\skills\revit-mcp"
    if (-not (Test-Path -LiteralPath (Join-Path $machineSkillPath "SKILL.md") -PathType Leaf)) {
        return $false
    }

    if (-not $SkipUserIntegration) {
        $userSkillPath = Join-Path $env:USERPROFILE ".codex\skills\revit-mcp"
        if (-not (Test-Path -LiteralPath $userSkillPath)) {
            return $false
        }
    }

    return $true
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
            "installer\command-payload\"
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
        [object]$Diagnostics = $null,
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
    $transition = if ($targetReportVersion -and $Status -eq "updated") {
        "{0} -> {1}" -f (Get-VersionLabel $previousReportVersion), $targetReportVersion
    }
    else {
        $null
    }
    $pendingTransition = if ($targetReportVersion -and ($Status -eq "update-available" -or $Status -eq "deferred-revit-close-required")) {
        "{0} -> {1}" -f (Get-VersionLabel $previousReportVersion), $targetReportVersion
    }
    else {
        $null
    }
    $channelGit = if ($Channel) { Get-JsonPropertyValue -Object $Channel -Name "git" } else { $null }
    $installedComponents = if ($InstalledState) { Get-JsonPropertyValue -Object $InstalledState -Name "components" } else { $null }
    $installedComponentCount = 0
    if ($installedComponents -and $installedComponents.PSObject) {
        $installedComponentCount = @($installedComponents.PSObject.Properties).Count
    }
    $installedUpdatePolicy = if ($InstalledState) { Get-JsonPropertyValue -Object $InstalledState -Name "updatePolicy" } else { $null }

    $report = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        updaterVersion = $updaterVersion
        operation = $script:RevitMcpOperation
        operationMethod = $script:RevitMcpOperationMethod
        status = $Status
        message = $Message
        distributionIntegrity = $script:RevitMcpDistributionIntegrity
        license = $script:RevitMcpLicense
        computerName = $env:COMPUTERNAME
        userName = $env:USERNAME
        atUtc = (Get-Date).ToUniversalTime().ToString("o")
        channel = if ($Channel) { $Channel.channel } else { $null }
        previousVersion = $previousReportVersion
        targetVersion = $targetReportVersion
        installedVersion = $installedReportVersion
        versionTransition = $transition
        pendingVersionTransition = $pendingTransition
        release = [ordered]@{
            channel = if ($Channel) { $Channel.channel } else { $null }
            version = $targetReportVersion
            packageSha256 = if ($Channel) { Get-JsonPropertyValue -Object $Channel -Name "sha256" } else { $null }
            packagePath = if ($Channel) { Get-JsonPropertyValue -Object $Channel -Name "packagePath" } else { $null }
            manifestPath = if ($Channel) { Get-JsonPropertyValue -Object $Channel -Name "manifestPath" } else { $null }
            publishedAtUtc = if ($Channel) { Get-JsonPropertyValue -Object $Channel -Name "publishedAtUtc" } else { $null }
            commit = if ($channelGit) { Get-JsonPropertyValue -Object $channelGit -Name "commit" } else { $null }
            isDirty = if ($channelGit) { Get-JsonPropertyValue -Object $channelGit -Name "isDirty" } else { $null }
        }
        localInstall = if ($InstalledState) {
            [ordered]@{
                version = Get-JsonPropertyValue -Object $InstalledState -Name "version"
                installedAtUtc = Get-JsonPropertyValue -Object $InstalledState -Name "installedAtUtc"
                packageSha256 = Get-JsonPropertyValue -Object $InstalledState -Name "packageSha256"
                packagePath = Get-JsonPropertyValue -Object $InstalledState -Name "packagePath"
                manifestPath = Get-JsonPropertyValue -Object $InstalledState -Name "manifestPath"
                componentCount = $installedComponentCount
                updatePolicy = $installedUpdatePolicy
            }
        }
        else {
            $null
        }
        diagnostics = $Diagnostics
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
    $script:RevitMcpLatestReport = $report
    $script:RevitMcpRemoteReportsRoot = $RemoteReportsRoot

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

function New-CurrentUpdateDiagnostics {
    $running = @($runningRevit)
    return [ordered]@{
        distributionIntegrity = $script:RevitMcpDistributionIntegrity
        license = $script:RevitMcpLicense
        allowSignedReleaseRollback = [bool]$AllowSignedReleaseRollback
        codexInstructionPolicy = $CodexInstructionPolicy
        codexInstructionCleanupSkipped = [bool]($SourceFreeMigration -and $preserveLocalCodexInstructions)
        machineRole = $MachineRole
        isFirstInstall = [bool]$isFirstInstall
        revitRunning = ($running.Count -gt 0)
        deferredForRevitClose = if ($runningDecision) { [bool]$runningDecision.DeferForRevitClose } else { $false }
        revitPayloadChanged = [bool]$requiresRevitClosed
        revitPayloadSkipped = [bool]$skipRevitPayloadInstall
        runtimePayloadSkipped = [bool]$skipRuntimePayloadInstall
        docsPayloadWorkSkipped = [bool]$skipDocsPayloadWork
        codexSkillInstallSkipped = [bool]$skipCodexSkillInstallForThisUpdate
        codexMcpRegistrationSkipped = [bool]$skipCodexMcpRegistrationForThisUpdate
        fastPackageOnlyUpdate = [bool]$fastPackageOnlyUpdate
        runSelfContainedInstaller = [bool]$runSelfContainedInstaller
        fastUpdateFallbackUsed = [bool]$fastUpdateFallbackUsed
        fastUpdateFallbackMessage = $fastUpdateFallbackMessage
        revitPayloadChangedComponents = @($revitPayloadChanges | ForEach-Object { [string]$_.key })
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
        app = "revAgent"
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
        [string[]]$LegacyNames = @("Revit MCP Auto Update"),
        [string]$UpdaterPath,
        [string]$UpdaterConfigPath,
        [string]$DailyAt = "12:00"
    )

    if ([string]::IsNullOrWhiteSpace($UpdaterConfigPath) -or
        [string]::IsNullOrWhiteSpace($UpdaterPath) -or
        -not (Test-Path -LiteralPath $UpdaterConfigPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $UpdaterPath -PathType Leaf)) {
        return
    }

    Repair-RevitMcpHiddenScheduledTaskAction -Name $Name -LegacyNames $LegacyNames -UpdaterPath $UpdaterPath -UpdaterConfigPath $UpdaterConfigPath -DailyAt $DailyAt
}

function Install-UpdaterToolsFromPackage {
    param(
        [string]$SourceRoot,
        [string]$DestinationRoot,
        [string]$ConfigPath
    )

    if ([string]::IsNullOrWhiteSpace($SourceRoot) -or
        -not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
        return
    }

    New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
    foreach ($toolName in @("update-from-nas.ps1", "show-installed-version.ps1", "install-updater-task.ps1", "migrate-source-free-install.ps1")) {
        $source = Join-Path $SourceRoot $toolName
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $DestinationRoot $toolName) -Force
        }
    }
    $libSource = Join-Path (Split-Path -Parent $SourceRoot) "lib"
    if (Test-Path -LiteralPath $libSource -PathType Container) {
        $libDestination = Join-Path $DestinationRoot "lib"
        if (Test-Path -LiteralPath $libDestination) {
            Remove-Item -LiteralPath $libDestination -Recurse -Force
        }
        Copy-Item -LiteralPath $libSource -Destination $libDestination -Recurse -Force
    }
    $configSource = Join-Path (Split-Path -Parent $SourceRoot) "config"
    if (-not (Test-Path -LiteralPath $configSource -PathType Container)) {
        $configSource = Join-Path (Split-Path -Parent (Split-Path -Parent $SourceRoot)) "config"
    }
    Sync-RevitMcpUpdaterConfigDirectory -SourceRoot $configSource -DestinationRoot (Join-Path $DestinationRoot "config")

    $updaterPath = Join-Path $DestinationRoot "update-from-nas.ps1"
    $versionToolPath = Join-Path $DestinationRoot "show-installed-version.ps1"
    if (Test-Path -LiteralPath $updaterPath -PathType Leaf) {
        @(
            "@echo off",
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$updaterPath`" -ConfigPath `"$ConfigPath`" -NoNotifyUser -AllowManualCodexSetup -OperationMethod manual-update",
            "pause"
        ) | Set-Content -LiteralPath (Join-Path $DestinationRoot "Update-Revit-MCP-Now.cmd") -Encoding ASCII
    }
    if (Test-Path -LiteralPath $versionToolPath -PathType Leaf) {
        @(
            "@echo off",
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$versionToolPath`" -ConfigPath `"$ConfigPath`"",
            "pause"
        ) | Set-Content -LiteralPath (Join-Path $DestinationRoot "Show-Revit-MCP-Version.cmd") -Encoding ASCII
    }

    Write-Host "Updater tools refreshed: $DestinationRoot"
}

$config = Import-UpdaterConfig -Path $ConfigPath
$taskDailyAt = "12:00"
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
    if ([string]::Equals($TaskName, "Revit MCP Auto Update", [System.StringComparison]::OrdinalIgnoreCase)) {
        $TaskName = "revAgent Auto Update"
    }
    if ($config.dailyAt) { $taskDailyAt = [string]$config.dailyAt }
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

$CodexInstructionPolicy = Resolve-CodexInstructionPolicy -RequestedPolicy $CodexInstructionPolicy -Config $config
$MachineRole = Resolve-MachineRole -RequestedRole $MachineRole -Config $config
$preserveLocalCodexInstructions = [string]::Equals($CodexInstructionPolicy, "preserve-local", [System.StringComparison]::OrdinalIgnoreCase)

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
Invoke-RevitMcpDirectoryRetention -Root $backupRoot -Filter "revit-mcp-skill.backup-*" -KeepLast 3

$taskUpdaterPath = Join-Path $WorkRoot "update-from-nas.ps1"
if (-not (Test-Path -LiteralPath $taskUpdaterPath -PathType Leaf)) {
    $taskUpdaterPath = $PSCommandPath
}

$channelDir = Split-Path -Parent $ChannelManifestPath
if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
    $releaseRootGuess = Split-Path -Parent $channelDir
    $ReportsRoot = Join-Path $releaseRootGuess "reports"
}
$script:RevitMcpRemoteReportsRoot = $ReportsRoot
$installedState = $null
$highestAcceptedReleaseSequence = [long]0
$channel = $null

try {
    Initialize-DistributionIntegrityConfig -Config $config
    Initialize-LicenseConfig -Config $config

    $installedState = Get-InstalledState -Path $statePath
    $highestAcceptedReleaseSequence = Get-InstalledHighestAcceptedReleaseSequence -InstalledState $installedState

    if ($SourceFreeMigration -and $AuditOnly) {
        throw "-SourceFreeMigration cannot be combined with -AuditOnly. Use migrate-source-free-install.ps1 -Mode dryRun for inventory-only checks."
    }

    if (-not [bool]$script:RevitMcpLicense.success) {
        throw "License verification rejected this run: $($script:RevitMcpLicense.reason). $($script:RevitMcpLicense.message)"
    }

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

    $distributionIntegrityCommand = Get-UpdaterDistributionIntegrityCommand -Name "Test-RevitMcpReleaseDistributionIntegrity" -Required

    $distributionIntegrityArgs = @{
        ChannelPath = $ChannelManifestPath
        Channel = $channel
        ReleaseManifestPath = $releaseManifestPath
        ReleaseManifest = $releaseManifest
        TrustedKeys = $script:RevitMcpTrustedReleaseKeys
        Policy = $script:RevitMcpDistributionIntegrityPolicy
        HighestAcceptedReleaseSequence = $highestAcceptedReleaseSequence
        AllowRollback = $AllowSignedReleaseRollback
    }
    $script:RevitMcpDistributionIntegrity = & $distributionIntegrityCommand @distributionIntegrityArgs
    if (-not [bool]$script:RevitMcpDistributionIntegrity.success) {
        throw "Distribution integrity check rejected this release: $($script:RevitMcpDistributionIntegrity.reason). $($script:RevitMcpDistributionIntegrity.message)"
    }
    if ($script:RevitMcpDistributionIntegrity.state -eq "legacy-compatible") {
        Write-Warning "Distribution integrity: unsigned legacy release accepted in compatibility mode."
    }
    else {
        Write-Host ("Distribution integrity: {0} ({1})" -f $script:RevitMcpDistributionIntegrity.state, $script:RevitMcpDistributionIntegrity.reason) -ForegroundColor Green
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
    $script:RevitMcpOperation = if ($AuditOnly) { "audit" } elseif ($SourceFreeMigration) { "source-free-migration" } elseif ($isFirstInstall) { "install" } elseif ($Force) { "reinstall" } else { "update" }
    if ([string]::IsNullOrWhiteSpace($OperationMethod)) {
        $script:RevitMcpOperationMethod = if ($AuditOnly) {
            "audit"
        }
        elseif ($SourceFreeMigration) {
            "source-free-migration"
        }
        elseif ($Force) {
            "force-update"
        }
        elseif ($isFirstInstall) {
            "install"
        }
        elseif ($NotifyUser) {
            "scheduled-update"
        }
        else {
            "update"
        }
    }

    Write-Host "Channel version  : $targetVersion"
    Write-Host "Installed version: $installedVersionLabel"
    Write-Host "Version change   : $installedVersionLabel -> $targetVersion"
    Write-Host "Operation method : $script:RevitMcpOperationMethod"
    Write-Host "Package          : $packagePath"

    $installedManifest = Get-InstalledReleaseManifest -InstalledState $installedState -PackageTarget $PackageTarget
    $revitPayloadChanges = @(Get-RevitPayloadChanges -TargetManifest $releaseManifest -InstalledManifest $installedManifest -PackageTarget $PackageTarget -InstallRoot $InstallRoot -RevitVersion $RevitVersion)
    $effectiveRevitPayloadChangeCount = if ($SourceFreeMigration) {
        [Math]::Max(1, $revitPayloadChanges.Count)
    }
    else {
        $revitPayloadChanges.Count
    }
    $releaseComponents = Get-JsonPropertyValue -Object $releaseManifest -Name "components"
    $updateDecision = Get-RevitMcpUpdateDecision `
        -IsFirstInstall:$isFirstInstall `
        -HasReleaseManifest:($null -ne $releaseManifest) `
        -HasReleaseComponents:($null -ne $releaseComponents) `
        -RevitPayloadChangeCount $effectiveRevitPayloadChangeCount
    $requiresRevitClosed = [bool]$updateDecision.RequiresRevitClosed
    $skipRevitPayloadInstall = $false
    $skipRuntimePayloadInstall = $false
    $skipDocsPayloadWork = $false
    $skipCodexSkillInstallForThisUpdate = $false
    $skipCodexMcpRegistrationForThisUpdate = $false
    if ($preserveLocalCodexInstructions) {
        $skipCodexSkillInstallForThisUpdate = $true
        Write-Host "Codex instructions: preserved local developer instruction surface by policy." -ForegroundColor Yellow
    }
    $revitChangeLabels = @($revitPayloadChanges | ForEach-Object {
            if (-not [string]::IsNullOrWhiteSpace([string]$_.path)) {
                [string]$_.path
            }
            else {
                [string]$_.key
            }
        })
    if ($SourceFreeMigration -and $revitChangeLabels.Count -eq 0) {
        $revitChangeLabels = @("source-free migration full Revit payload repair")
    }
    $isPackageCurrent = ($installedVersion -eq $targetVersion -and $installedSha -eq $targetSha)

    if (-not $SourceFreeMigration) {
        $sourceFreeGuardArtifacts = @(Get-RevitMcpSourceFreeArtifactInventory `
                -InstallRoot $InstallRoot `
                -PackageTarget $PackageTarget `
                -ServerTarget $ServerTarget `
                -PreserveLocalCodexInstructions:$preserveLocalCodexInstructions `
                -SkipCodexUserIntegration:$SkipCodexUserIntegration)
        if ($sourceFreeGuardArtifacts.Count -gt 0) {
            $sampleArtifacts = @($sourceFreeGuardArtifacts |
                    Select-Object -First 20 |
                    ForEach-Object {
                        [ordered]@{
                            rootLabel = [string]$_.rootLabel
                            rootKind = [string]$_.rootKind
                            kind = [string]$_.kind
                            reason = [string]$_.reason
                            relativePath = [string]$_.relativePath
                            path = [string]$_.path
                        }
                    })
            $message = "Source-free migration is required before normal update. Found $($sourceFreeGuardArtifacts.Count) managed source/developer artifact item(s). Run migrate-source-free-install.ps1 -Mode dryRun first, review the report, then run -Mode commit."
            Write-Warning $message
            Write-UpdateReport `
                -Status "source-free-migration-required" `
                -Message $message `
                -Channel $channel `
                -InstalledState $installedState `
                -Diagnostics ([ordered]@{
                    codexInstructionPolicy = $CodexInstructionPolicy
                    codexInstructionCleanupSkipped = [bool]$preserveLocalCodexInstructions
                    sourceFreeMigrationRequired = $true
                    sourceFreeMigrationArtifactCount = $sourceFreeGuardArtifacts.Count
                    sourceFreeMigrationSampleArtifacts = $sampleArtifacts
                    migrationDryRunCommand = "migrate-source-free-install.ps1 -Mode dryRun"
                    migrationCommitCommand = "migrate-source-free-install.ps1 -Mode commit"
                }) `
                -PreviousVersion $installedVersion `
                -InstalledVersion $installedVersion `
                -LocalReportPath $localReportPath `
                -RemoteReportsRoot $ReportsRoot
            Show-UserNotification -Title "revAgent migration required" -Message $message -Key ("source-free-migration-required|{0}" -f $targetVersion) -Icon "Warning"
            return
        }
    }

    if ((-not $AuditOnly) -and (-not $SkipCodexUserIntegration)) {
        Remove-CodexProfileBackupArtifacts
        [void](Set-CodexMemoryConfig)
    }

    if (-not $Force -and -not $SourceFreeMigration -and $isPackageCurrent -and -not $requiresRevitClosed) {
        $message = "Already up to date."
        Write-Host $message -ForegroundColor Green
        Write-UpdateReport -Status "current" -Message $message -Channel $channel -InstalledState $installedState -Diagnostics (New-CurrentUpdateDiagnostics) -PreviousVersion $installedVersion -InstalledVersion $installedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
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
        Write-UpdateReport -Status "update-available" -Message $message -Channel $channel -InstalledState $installedState -Diagnostics (New-CurrentUpdateDiagnostics) -PreviousVersion $installedVersion -InstalledVersion $installedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
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
        $skipRevitPayloadInstall = [bool]$updateDecision.SkipRevitPayloadInstall
        Write-Host "Revit payload    : unchanged; existing Revit files will be left untouched." -ForegroundColor Green
    }
    if ($SourceFreeMigration) {
        $skipRevitPayloadInstall = $false
        if ($preserveLocalCodexInstructions) {
            Write-Host "Source migration : full managed Revit/runtime repair forced; Codex instructions preserved by policy." -ForegroundColor Yellow
        }
        else {
            Write-Host "Source migration : full managed Revit/runtime/Codex payload repair forced." -ForegroundColor Yellow
        }
    }

    $runningRevit = Get-Process -Name "Revit" -ErrorAction SilentlyContinue
    $runningDecision = Get-RevitMcpUpdateDecision `
        -IsFirstInstall:$isFirstInstall `
        -HasReleaseManifest:($null -ne $releaseManifest) `
        -HasReleaseComponents:($null -ne $releaseComponents) `
        -RevitPayloadChangeCount $effectiveRevitPayloadChangeCount `
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
        Write-UpdateReport -Status "deferred-revit-close-required" -Message $message -Channel $channel -InstalledState $installedState -Diagnostics (New-CurrentUpdateDiagnostics) -PreviousVersion $installedVersion -InstalledVersion $installedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        Show-UserNotification -Title "revAgent update requires Revit to close" -Message $message -Key ("deferred-revit-close-required|{0}" -f $targetVersion) -Icon "Warning"
        return
    }
    elseif ($runningDecision.SkipRevitPayloadInstall) {
        $skipRevitPayloadInstall = [bool]$runningDecision.SkipRevitPayloadInstall
        if ($runningRevit) {
            Write-Warning "Revit is running, but this update does not change Revit add-in/command files. Non-Revit files will be updated without touching the active Revit payload."
        }
    }

    Initialize-RevitMcpWorkstationProxy -ProxyUrl $ProxyUrl -ProxyBypass $ProxyBypass -Skip:$SkipProxySetup
    Ensure-UpdateDependencies -SkipNpmInstall:$SkipNpmInstall -SkipCodexMcpRegistration:$SkipCodexMcpRegistration

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

    if ($SourceFreeMigration) {
        if ($preserveLocalCodexInstructions) {
            Write-Host "Source migration : runtime, docs, and MCP registration refresh forced; Codex instructions preserved by policy." -ForegroundColor Yellow
        }
        else {
            Write-Host "Source migration : runtime, docs, Codex skill, and MCP registration refresh forced." -ForegroundColor Yellow
        }
    }
    else {
        if (Test-DirectoryPayloadUnchanged -Manifest $releaseManifest -ComponentKey "runtimePayload" -PackageTarget $PackageTarget) {
            $skipRuntimePayloadInstall = $true
            Write-Host "Runtime payload  : unchanged; existing runtime files will be left untouched." -ForegroundColor Green
        }
        if (Test-DirectoryPayloadUnchanged -Manifest $releaseManifest -ComponentKey "docsServerPayload" -PackageTarget $PackageTarget) {
            $skipDocsPayloadWork = $true
            Write-Host "Docs payload     : unchanged; docs dependency/index refresh will be skipped." -ForegroundColor Green
        }
        if ((Test-ManifestComponentUnchanged -TargetManifest $releaseManifest -InstalledManifest $installedManifest -ComponentKey "skill" -PackageTarget $PackageTarget) -and
            (Test-ManifestComponentUnchanged -TargetManifest $releaseManifest -InstalledManifest $installedManifest -ComponentKey "agents" -PackageTarget $PackageTarget) -and
            (Test-CodexSkillInstallPresent -InstallRoot $InstallRoot -SkipUserIntegration:$SkipCodexUserIntegration)) {
            $skipCodexSkillInstallForThisUpdate = $true
            Write-Host "Codex skill      : unchanged; existing skill integration will be left untouched." -ForegroundColor Green
        }
        if ($skipRuntimePayloadInstall -and $skipDocsPayloadWork) {
            $skipCodexMcpRegistrationForThisUpdate = $true
            Write-Host "Codex MCP config : unchanged entry points; registration refresh will be skipped." -ForegroundColor Green
        }
    }

    $sourceFreeMigrationPreCleanup = $null
    $sourceFreeMigrationPostCleanup = $null
    if ($SourceFreeMigration) {
        $sourceFreeMigrationPreCleanup = Invoke-RevitMcpSourceFreeArtifactCleanup `
            -InstallRoot $InstallRoot `
            -PackageTarget $PackageTarget `
            -ServerTarget $ServerTarget `
            -UserProfileRoot $env:USERPROFILE `
            -PreserveLocalCodexInstructions:$preserveLocalCodexInstructions `
            -SkipCodexUserIntegration:$SkipCodexUserIntegration `
            -Commit
        Write-Host ("Source cleanup  : removed {0} pre-install source/developer artifact item(s); {1} failed." -f $sourceFreeMigrationPreCleanup.removedCount, $sourceFreeMigrationPreCleanup.failedCount) -ForegroundColor Yellow
        if ([int]$sourceFreeMigrationPreCleanup.failedCount -gt 0) {
            throw "Source-free migration cleanup failed before package replacement. Failed items: $($sourceFreeMigrationPreCleanup.failedCount)"
        }
    }

    if (Test-Path -LiteralPath $PackageTarget) {
        $backupPath = Join-Path $backupRoot ("revit-mcp-skill.backup-" + $stamp)
        Move-Item -LiteralPath $PackageTarget -Destination $backupPath
        Invoke-RevitMcpDirectoryRetention -Root $backupRoot -Filter "revit-mcp-skill.backup-*" -KeepLast 3
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $PackageTarget) -Force | Out-Null
    Move-Item -LiteralPath $extractRoot -Destination $PackageTarget

    $installer = Join-Path $PackageTarget $packageLayout.installerRelativePath
    $docsServerPath = Join-Path $PackageTarget $packageLayout.docsServerRelativePath
    $npmDependencyCacheRoot = Join-Path $InstallRoot "dependencies\npm"
    $fastPackageOnlyUpdate = $skipRevitPayloadInstall -and
        $skipRuntimePayloadInstall -and
        $skipDocsPayloadWork -and
        $skipCodexSkillInstallForThisUpdate -and
        $skipCodexMcpRegistrationForThisUpdate
    $fastUpdateFallbackUsed = $false
    $fastUpdateFallbackMessage = ""
    $runSelfContainedInstaller = (-not $fastPackageOnlyUpdate)

    if ($fastPackageOnlyUpdate) {
        try {
            Write-Host "Fast update path : package/updater metadata only; self-contained installer skipped." -ForegroundColor Green
            $nasToolsSource = Join-Path (Split-Path -Parent $installer) "nas"
            Install-UpdaterToolsFromPackage -SourceRoot $nasToolsSource -DestinationRoot $WorkRoot -ConfigPath $ConfigPath
            Invoke-RevitMcpLogRetention -LogsRoot (Join-Path $WorkRoot "logs") -KeepLast 10 -ActiveLogPath $env:REVIT_MCP_LOG_PATH
            Write-Host "Runtime dependencies: skipped; runtime payload unchanged."
            if ($SkipNpmInstall) {
                Write-Host "Documentation server dependencies: skipped by -SkipNpmInstall."
            }
            else {
                $npmPath = Resolve-NpmCommand
                Invoke-NpmInstallIfNeeded -NpmPath $npmPath -WorkingDirectory $docsServerPath -Label "Documentation server" -CacheRoot $npmDependencyCacheRoot
            }
            Write-Host "Revit API index: skipped; docs payload unchanged."
            Write-Host "Codex MCP registration: skipped; runtime/docs entry points unchanged."
        }
        catch {
            $fastUpdateFallbackUsed = $true
            $fastUpdateFallbackMessage = $_.Exception.Message
            $runSelfContainedInstaller = $true
            Write-Warning "Fast update path failed; falling back to the full repair/install path. $fastUpdateFallbackMessage"
        }
    }
    if ($runSelfContainedInstaller) {
        $installArgs = @{
            RevitVersion = $RevitVersion
            InstallRoot = $InstallRoot
            ServerTarget = $ServerTarget
            RevitInstallRoot = $RevitInstallRoot
            CodexInstructionPolicy = $CodexInstructionPolicy
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
        if ($skipCodexSkillInstallForThisUpdate) {
            $installArgs["SkipCodexSkillInstall"] = $true
        }
        $installArgs["SuppressNextSteps"] = $true
        if ($skipRevitPayloadInstall) {
            $installArgs["SkipRevitPayloadInstall"] = $true
        }
        if ($skipRuntimePayloadInstall) {
            $installArgs["SkipRuntimePayloadInstall"] = $true
        }

        & $installer @installArgs

        if (-not $SkipNpmInstall) {
            $npmPath = Resolve-NpmCommand
            $powershellPath = Resolve-RequiredCommand -Name "powershell" -Candidates @(
                (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe")
            )

            if ($skipRuntimePayloadInstall) {
                Write-Host "Runtime dependencies: skipped; runtime payload unchanged."
            }
            else {
                Invoke-NpmInstallIfNeeded -NpmPath $npmPath -WorkingDirectory $ServerTarget -Label "Runtime" -CacheRoot $npmDependencyCacheRoot
            }

            $docsCachePath = Join-Path $InstallRoot ("state\revit-api-docs\cache\revit-api-docs-{0}.json" -f $RevitVersion)
            Invoke-NpmInstallIfNeeded -NpmPath $npmPath -WorkingDirectory $docsServerPath -Label "Documentation server" -CacheRoot $npmDependencyCacheRoot
            if ($skipDocsPayloadWork -and (Test-Path -LiteralPath $docsCachePath -PathType Leaf)) {
                Write-Host "Revit API index: skipped; docs payload unchanged."
            }
            else {
                Invoke-External -FilePath $powershellPath -Arguments @(
                    "-ExecutionPolicy", "Bypass",
                    "-File", (Join-Path $docsServerPath "scripts\build-index.ps1"),
                    "-RevitRoot", $RevitInstallRoot,
                    "-OutputPath", $docsCachePath
                ) -WorkingDirectory $docsServerPath
            }
        }

        if ((-not $SkipCodexMcpRegistration) -and $skipCodexMcpRegistrationForThisUpdate) {
            Write-Host "Codex MCP registration: skipped; runtime/docs entry points unchanged."
        }
        elseif (-not $SkipCodexMcpRegistration) {
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
    }

    if ($SourceFreeMigration) {
        $sourceFreeMigrationPostCleanup = Invoke-RevitMcpSourceFreeArtifactCleanup `
            -InstallRoot $InstallRoot `
            -PackageTarget $PackageTarget `
            -ServerTarget $ServerTarget `
            -UserProfileRoot $env:USERPROFILE `
            -PreserveLocalCodexInstructions:$preserveLocalCodexInstructions `
            -SkipCodexUserIntegration:$SkipCodexUserIntegration `
            -Commit
        Write-Host ("Source verify   : remaining managed source/developer artifact item(s): {0}; cleanup failures: {1}" -f $sourceFreeMigrationPostCleanup.remainingCount, $sourceFreeMigrationPostCleanup.failedCount) -ForegroundColor Yellow
        if ([int]$sourceFreeMigrationPostCleanup.failedCount -gt 0 -or [int]$sourceFreeMigrationPostCleanup.remainingCount -gt 0) {
            throw "Source-free migration verification failed. Remaining: $($sourceFreeMigrationPostCleanup.remainingCount); failed cleanup: $($sourceFreeMigrationPostCleanup.failedCount)"
        }
    }

    $sourceFreeMigrationState = if ($SourceFreeMigration) {
        [ordered]@{
            enabled = $true
            codexInstructionPolicy = $CodexInstructionPolicy
            codexInstructionCleanupSkipped = [bool]$preserveLocalCodexInstructions
            preCleanupArtifactCount = if ($sourceFreeMigrationPreCleanup) { [int]$sourceFreeMigrationPreCleanup.artifactCount } else { 0 }
            preCleanupRemovedCount = if ($sourceFreeMigrationPreCleanup) { [int]$sourceFreeMigrationPreCleanup.removedCount } else { 0 }
            preCleanupFailedCount = if ($sourceFreeMigrationPreCleanup) { [int]$sourceFreeMigrationPreCleanup.failedCount } else { 0 }
            postCleanupArtifactCount = if ($sourceFreeMigrationPostCleanup) { [int]$sourceFreeMigrationPostCleanup.artifactCount } else { 0 }
            postCleanupRemovedCount = if ($sourceFreeMigrationPostCleanup) { [int]$sourceFreeMigrationPostCleanup.removedCount } else { 0 }
            postCleanupFailedCount = if ($sourceFreeMigrationPostCleanup) { [int]$sourceFreeMigrationPostCleanup.failedCount } else { 0 }
            postCleanupRemainingCount = if ($sourceFreeMigrationPostCleanup) { [int]$sourceFreeMigrationPostCleanup.remainingCount } else { 0 }
        }
    }
    else {
        $null
    }

    $integrityReleaseSequence = ConvertTo-Int64OrZero -Value $script:RevitMcpDistributionIntegrity.releaseSequence
    $integrityMinimumAcceptedReleaseSequence = ConvertTo-Int64OrZero -Value $script:RevitMcpDistributionIntegrity.minimumAcceptedReleaseSequence
    $integrityHighestAcceptedReleaseSequence = [Math]::Max(
        $highestAcceptedReleaseSequence,
        (ConvertTo-Int64OrZero -Value $script:RevitMcpDistributionIntegrity.highestAcceptedReleaseSequence))
    $hasAcceptedSignedRelease = $integrityHighestAcceptedReleaseSequence -gt 0 -or
        [string]::Equals([string]$script:RevitMcpDistributionIntegrity.state, "verified", [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals([string]$script:RevitMcpDistributionIntegrity.state, "rollback-allowed", [System.StringComparison]::OrdinalIgnoreCase)

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
        runtimePayloadSkipped = [bool]$skipRuntimePayloadInstall
        docsPayloadWorkSkipped = [bool]$skipDocsPayloadWork
        codexSkillInstallSkipped = [bool]$skipCodexSkillInstallForThisUpdate
        codexMcpRegistrationSkipped = [bool]$skipCodexMcpRegistrationForThisUpdate
        fastPackageOnlyUpdate = [bool]$fastPackageOnlyUpdate
        fastUpdateFallbackUsed = [bool]$fastUpdateFallbackUsed
        fastUpdateFallbackMessage = $fastUpdateFallbackMessage
        revitPayloadChangedComponents = @($revitPayloadChanges | ForEach-Object { [string]$_.key })
        distributionIntegrity = $script:RevitMcpDistributionIntegrity
        releaseSequence = $integrityReleaseSequence
        minimumAcceptedReleaseSequence = $integrityMinimumAcceptedReleaseSequence
        highestAcceptedReleaseSequence = $integrityHighestAcceptedReleaseSequence
        hasAcceptedSignedRelease = [bool]$hasAcceptedSignedRelease
        signedReleaseRollbackAllowed = [bool]$script:RevitMcpDistributionIntegrity.rollbackAllowed
        license = $script:RevitMcpLicense
        sourceFreeMigration = $sourceFreeMigrationState
        updaterVersion = $updaterVersion
        codexInstructionPolicy = $CodexInstructionPolicy
        machineRole = $MachineRole
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
    if ($fastUpdateFallbackUsed) {
        $updateMessage += " Fast update path failed; full repair/install path completed."
    }
    Write-JsonFile -Path $statePath -Value $newState
    Write-UpdateReport -Status "updated" -Message $updateMessage -Channel $channel -InstalledState $newState -Diagnostics (New-CurrentUpdateDiagnostics) -PreviousVersion $installedVersion -InstalledVersion $targetVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
    Write-Host $updateMessage -ForegroundColor Green
    Show-UserNotification -Title "revAgent updated" -Message ($updateMessage + "`r`n`r`nInstalled version: " + $targetVersion) -Key ("updated|{0}" -f $targetVersion) -Icon "Information"
}
catch {
    $message = $_.Exception.Message
    $failedVersion = if ($installedState) { [string]$installedState.version } else { "" }
    Write-UpdateReport -Status "failed" -Message $message -Channel $channel -InstalledState $installedState -Diagnostics (New-CurrentUpdateDiagnostics) -PreviousVersion $failedVersion -InstalledVersion $failedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
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
