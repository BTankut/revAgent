<#
.SYNOPSIS
    Update a workstation from a NAS-hosted Revit MCP channel manifest.

.DESCRIPTION
    Reads channels\stable.json or channels\beta.json from the NAS, compares it
    with the local installed state, verifies the package hash, replaces the
    managed local package copy, runs the self-contained installer, refreshes npm
    dependencies, and writes a machine report.
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
    [ValidateSet("2022")]
    [string]$RevitVersion = "2022",
    [string[]]$LegacyServerTargets = @(),
    [string]$ReportsRoot = "",
    [switch]$Force,
    [switch]$AuditOnly,
    [switch]$SkipNpmInstall,
    [switch]$SkipCodexMcpRegistration,
    [switch]$SkipCodexUserIntegration,
    [switch]$AllowReplaceGitPackageTarget
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$updaterVersion = "0.1.0"

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

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    if ([System.IO.Path]::IsPathRooted($expanded)) {
        return $expanded
    }

    return Join-Path $BaseDirectory $expanded
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
        [string[]]$Candidates = @()
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

    throw "Required command '$Name' was not found. Install it or add it to PATH, then run the updater again."
}

function Resolve-RevitInstallRoot {
    param(
        [string]$RequestedRoot,
        [string]$Version
    )

    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
            $RequestedRoot,
            $env:REVIT_INSTALL_ROOT,
            (Join-Path ${env:ProgramFiles} "Autodesk\Revit $Version"),
            (Join-Path ${env:ProgramFiles} "Autodesk\Revit$Version"),
            (Join-Path ${env:ProgramFiles(x86)} "Autodesk\Revit $Version")
        )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $candidates.Add($candidate)
        }
    }
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
                        $candidates.Add($value)
                    }
                }
            }
        }
        catch {}
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $full = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($candidate)).TrimEnd("\")
        if (-not $seen.Add($full)) { continue }
        if ((Test-Path -LiteralPath $full -PathType Container) -and
            (Test-Path -LiteralPath (Join-Path $full "Revit.exe")) -and
            (Test-Path -LiteralPath (Join-Path $full "RevitAPI.dll"))) {
            return $full
        }
    }

    throw "Revit $Version install directory could not be found. Checked: $($seen.ToArray() -join '; ')"
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

function Write-UpdateReport {
    param(
        [string]$Status,
        [string]$Message,
        [object]$Channel,
        [object]$InstalledState,
        [string]$LocalReportPath,
        [string]$RemoteReportsRoot
    )

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
        targetVersion = if ($Channel) { $Channel.version } else { $null }
        installedVersion = if ($InstalledState) { $InstalledState.version } else { $null }
        paths = [ordered]@{
            installRoot = $InstallRoot
            packageTarget = $PackageTarget
            serverTarget = $ServerTarget
            workRoot = $WorkRoot
            revitInstallRoot = $RevitInstallRoot
            channelManifestPath = $ChannelManifestPath
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
    if ($config.legacyServerTargets) { $LegacyServerTargets = @($config.legacyServerTargets) }
    if ($config.reportsRoot) { $ReportsRoot = [string]$config.reportsRoot }
    if ($config.skipNpmInstall) { $SkipNpmInstall = $true }
    if ($config.skipCodexMcpRegistration) { $SkipCodexMcpRegistration = $true }
    if ($config.skipCodexUserIntegration) { $SkipCodexUserIntegration = $true }
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
if ([string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
    $WorkspaceAgentsTarget = Join-Path $InstallRoot "codex\AGENTS.md"
}

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

    if ([string]::IsNullOrWhiteSpace($packagePath)) {
        throw "Channel manifest does not contain packagePath: $ChannelManifestPath"
    }
    if (-not (Test-Path -LiteralPath $packagePath)) {
        throw "Package was not found: $packagePath"
    }

    $installedVersion = if ($installedState) { [string]$installedState.version } else { "" }
    $installedSha = if ($installedState) { [string]$installedState.packageSha256 } else { "" }

    Write-Host "Channel version  : $targetVersion"
    Write-Host "Installed version: $installedVersion"
    Write-Host "Package          : $packagePath"

    if (-not $Force -and $installedVersion -eq $targetVersion -and $installedSha -eq $targetSha) {
        $message = "Already up to date."
        Write-Host $message -ForegroundColor Green
        Write-UpdateReport -Status "current" -Message $message -Channel $channel -InstalledState $installedState -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        return
    }

    if ($AuditOnly) {
        $message = "Update available: $installedVersion -> $targetVersion"
        Write-Host $message -ForegroundColor Yellow
        Write-UpdateReport -Status "update-available" -Message $message -Channel $channel -InstalledState $installedState -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        return
    }

    $runningRevit = Get-Process -Name "Revit" -ErrorAction SilentlyContinue
    if ($runningRevit) {
        $message = "Revit is running; update deferred."
        Write-Warning $message
        Write-UpdateReport -Status "deferred-revit-running" -Message $message -Channel $channel -InstalledState $installedState -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        return
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
    if (Test-Path -LiteralPath $extractRoot) {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
    Expand-Archive -LiteralPath $cachedPackage -DestinationPath $extractRoot -Force

    if (-not (Test-Path -LiteralPath (Join-Path $extractRoot "kurulum\install-self-contained.ps1"))) {
        throw "Extracted package does not look like revit-mcp-skill: $extractRoot"
    }

    if (Test-Path -LiteralPath $PackageTarget) {
        $backupPath = Join-Path $backupRoot ("revit-mcp-skill.backup-" + $stamp)
        Move-Item -LiteralPath $PackageTarget -Destination $backupPath
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $PackageTarget) -Force | Out-Null
    Move-Item -LiteralPath $extractRoot -Destination $PackageTarget

    $installer = Join-Path $PackageTarget "kurulum\install-self-contained.ps1"
    $installArgs = @(
        "-RevitVersion", $RevitVersion,
        "-InstallRoot", $InstallRoot,
        "-ServerTarget", $ServerTarget,
        "-RevitInstallRoot", $RevitInstallRoot
    )
    if (-not [string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
        $installArgs += @("-WorkspaceAgentsTarget", $WorkspaceAgentsTarget)
    }
    if ($LegacyServerTargets.Count -gt 0) {
        $installArgs += "-LegacyServerTargets"
        $installArgs += $LegacyServerTargets
    }
    if ($SkipCodexUserIntegration) {
        $installArgs += "-SkipCodexUserIntegration"
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

        Invoke-External -FilePath $npmPath -Arguments @("install", "--omit=dev") -WorkingDirectory $ServerTarget

        $docsServerPath = Join-Path $PackageTarget "kurulum\revit-api-docs-mcp"
        Invoke-External -FilePath $npmPath -Arguments @("install", "--omit=dev") -WorkingDirectory $docsServerPath

        $docsCachePath = Join-Path $InstallRoot ("state\revit-api-docs\cache\revit-api-docs-{0}.json" -f $RevitVersion)
        Invoke-External -FilePath $powershellPath -Arguments @(
            "-ExecutionPolicy", "Bypass",
            "-File", (Join-Path $docsServerPath "scripts\build-index.ps1"),
            "-RevitRoot", $RevitInstallRoot,
            "-OutputPath", $docsCachePath
        ) -WorkingDirectory $docsServerPath
    }

    if (-not $SkipCodexMcpRegistration) {
        $codexPath = Resolve-RequiredCommand -Name "codex.cmd" -Candidates @(
            (Join-Path $env:APPDATA "npm\codex.cmd")
        )
        $nodePath = Resolve-RequiredCommand -Name "node.exe" -Candidates @(
            (Join-Path ${env:ProgramFiles} "nodejs\node.exe"),
            (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
        )
        $docsServerPath = Join-Path $PackageTarget "kurulum\revit-api-docs-mcp"
        try {
            & $codexPath mcp remove revit-mcp 2>$null | Out-Null
        }
        catch {}
        try {
            & $codexPath mcp remove revit-api-docs 2>$null | Out-Null
        }
        catch {}

        Invoke-External -FilePath $codexPath -Arguments @("mcp", "add", "revit-mcp", "--", $nodePath, (Join-Path $ServerTarget "build\index.js")) -WorkingDirectory $WorkRoot
        Invoke-External -FilePath $codexPath -Arguments @("mcp", "add", "revit-api-docs", "--", $nodePath, (Join-Path $docsServerPath "build\index.js")) -WorkingDirectory $WorkRoot
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
    Write-JsonFile -Path $statePath -Value $newState
    Write-UpdateReport -Status "updated" -Message "Updated to $targetVersion." -Channel $channel -InstalledState $newState -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
    Write-Host "Updated to $targetVersion." -ForegroundColor Green
}
catch {
    $message = $_.Exception.Message
    Write-Error $message
    Write-UpdateReport -Status "failed" -Message $message -Channel $channel -InstalledState $installedState -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
    throw
}
