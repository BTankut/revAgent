<#
.SYNOPSIS
    Publish the current self-contained Revit MCP package to a NAS release root.

.DESCRIPTION
    Creates a versioned ZIP package, writes a release manifest, and optionally
    updates the channels\stable.json channel manifest.

    Commit/push does not deploy anything by itself. This script is the explicit
    "publish this version" step.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [ValidateSet("stable")]
    [string]$Channel = "stable",

    [string]$Version = "",

    [string]$RepoRoot = "",

    [switch]$AllowDirty,

    [switch]$Force,

    [switch]$NoChannelUpdate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptRoot)) {
    $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $scriptRoot "..\..")).Path
}

function Write-Section {
    param([string]$Message)
    Write-Host ""
    Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Get-GitValue {
    param(
        [string]$Repository,
        [string[]]$Arguments,
        [string]$Fallback = ""
    )

    try {
        $value = & git -C $Repository @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) {
            return $Fallback
        }
        return (($value | Out-String).Trim())
    }
    catch {
        return $Fallback
    }
}

function Assert-SafeVersion {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Version cannot be empty."
    }

    if ($Value -notmatch '^[A-Za-z0-9._-]+$') {
        throw "Version may only contain letters, numbers, dot, underscore, and dash: $Value"
    }
}

function Copy-DirectoryFiltered {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    $excludedDirectoryNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @(".git", ".vs", ".idea", ".vscode", "node_modules", "__pycache__", "bin", "obj", "packages", "dependencies")) {
        [void]$excludedDirectoryNames.Add($name)
    }

    $excludedFilePatterns = @("*.user", "*.suo", "*.tmp", "*.log")

    function Copy-OneDirectory {
        param(
            [string]$From,
            [string]$To
        )

        New-Item -ItemType Directory -Path $To -Force | Out-Null

        Get-ChildItem -LiteralPath $From -Force | ForEach-Object {
            if ($_.PSIsContainer) {
                if ($excludedDirectoryNames.Contains($_.Name)) {
                    return
                }

                Copy-OneDirectory -From $_.FullName -To (Join-Path $To $_.Name)
                return
            }

            foreach ($pattern in $excludedFilePatterns) {
                if ($_.Name -like $pattern) {
                    return
                }
            }

            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $To $_.Name) -Force
        }
    }

    Copy-OneDirectory -From $Source -To $Destination
}

function Get-RelativeFileHash {
    param(
        [string]$Root,
        [string]$RelativePath
    )

    $path = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $path)) {
        return $null
    }

    $item = Get-Item -LiteralPath $path
    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $path

    return [ordered]@{
        path = $RelativePath
        sha256 = $hash.Hash
        sizeBytes = $item.Length
    }
}

function Get-DirectoryTreeHash {
    param(
        [string]$Root,
        [string]$RelativePath,
        [string[]]$ExcludeDirectoryNames = @("node_modules", ".git"),
        [string[]]$ExcludeFileNames = @(".revagent-npm-dependencies.json", ".npm-deps.sha256")
    )

    $path = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        return $null
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

    return [ordered]@{
        path = $RelativePath
        sha256 = ([System.BitConverter]::ToString($digest) -replace "-", "")
        fileCount = $lines.Count
    }
}

function ConvertTo-ComponentKey {
    param(
        [string]$Prefix,
        [string]$RelativePath
    )

    $normalized = ($RelativePath -replace '[\\/]+', '_' -replace '[^A-Za-z0-9_]+', '_').Trim("_")
    return "{0}{1}" -f $Prefix, $normalized
}

function Add-LegacyPackageCompatibility {
    param([string]$PackageRoot)

    $canonicalInstallerRoot = Join-Path $PackageRoot "installer"
    $legacyInstallerRoot = Join-Path $PackageRoot "kurulum"
    if (-not (Test-Path -LiteralPath $canonicalInstallerRoot -PathType Container)) {
        throw "Canonical installer folder was not staged: $canonicalInstallerRoot"
    }
    if (Test-Path -LiteralPath $legacyInstallerRoot) {
        Remove-Item -LiteralPath $legacyInstallerRoot -Recurse -Force
    }

    Copy-DirectoryFiltered -Source $canonicalInstallerRoot -Destination $legacyInstallerRoot
    Write-Host "Added legacy package alias: kurulum -> installer" -ForegroundColor Yellow
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [int]$Depth = 8
    )

    $Value | ConvertTo-Json -Depth $Depth | Set-Content -LiteralPath $Path -Encoding UTF8
}

Write-Section "Validate repository"
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "SKILL.md"))) {
    throw "SKILL.md was not found under RepoRoot: $RepoRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\install-self-contained.ps1"))) {
    throw "Installer was not found under RepoRoot: $RepoRoot"
}

$commit = Get-GitValue -Repository $RepoRoot -Arguments @("rev-parse", "HEAD") -Fallback "unknown"
$shortCommit = if ($commit -ne "unknown" -and $commit.Length -ge 8) { $commit.Substring(0, 8) } else { "nogit" }
$commitCount = Get-GitValue -Repository $RepoRoot -Arguments @("rev-list", "--count", "HEAD") -Fallback "0"
if ($commitCount -notmatch '^\d+$') {
    $commitCount = "0"
}
$branch = Get-GitValue -Repository $RepoRoot -Arguments @("branch", "--show-current") -Fallback "unknown"
$dirtyStatus = Get-GitValue -Repository $RepoRoot -Arguments @("status", "--porcelain") -Fallback ""
$isDirty = -not [string]::IsNullOrWhiteSpace($dirtyStatus)

if ($isDirty -and -not $AllowDirty) {
    throw "Working tree has uncommitted changes. Commit first or pass -AllowDirty for a deliberate test package."
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = "{0}.{1}-{2}" -f (Get-Date -Format "yyyy.MM.dd"), $commitCount, $shortCommit
}
Assert-SafeVersion -Value $Version

Write-Host "Repo    : $RepoRoot"
Write-Host "Branch  : $branch"
Write-Host "Commit  : $commit"
Write-Host "Dirty   : $isDirty"
Write-Host "Version : $Version"
Write-Host "Channel : $Channel"

Write-Section "Prepare release folders"
if (-not $ReleaseRoot.StartsWith("\\")) {
    Write-Warning "ReleaseRoot is not a UNC path. For office deployment, prefer a path that every workstation can read, e.g. \\dpe-nas\...\revit-mcp-deploy"
}

$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
$releasesRoot = Join-Path $ReleaseRoot "releases"
$channelsRoot = Join-Path $ReleaseRoot "channels"
$toolsRoot = Join-Path $ReleaseRoot "tools"
$releaseDir = Join-Path $releasesRoot $Version

if (Test-Path -LiteralPath $releaseDir) {
    if (-not $Force) {
        throw "Release already exists: $releaseDir. Pass -Force to replace it."
    }
    Remove-Item -LiteralPath $releaseDir -Recurse -Force
}

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
New-Item -ItemType Directory -Path $channelsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null

$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revit-mcp-release-" + $Version + "-" + [Guid]::NewGuid().ToString("N"))
$packageRoot = Join-Path $stageRoot "package"
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

try {
    Write-Section "Stage package"
    Copy-DirectoryFiltered -Source $RepoRoot -Destination $packageRoot
    Add-LegacyPackageCompatibility -PackageRoot $packageRoot

    $releaseInfo = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        version = $Version
        channel = $Channel
        git = [ordered]@{
            branch = $branch
            commit = $commit
            isDirty = $isDirty
        }
        publishedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    $releaseInfo | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $packageRoot "release-info.json") -Encoding UTF8

    Write-Section "Create ZIP"
    $zipPath = Join-Path $releaseDir ("revit-mcp-skill-{0}.zip" -f $Version)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($packageRoot, $zipPath)

    $zipItem = Get-Item -LiteralPath $zipPath
    $zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash

    $componentPaths = [ordered]@{
        skill = "SKILL.md"
        agents = "AGENTS.md"
        changelog = "CHANGELOG.md"
        repositoryStructure = "docs\REPOSITORY_STRUCTURE.md"
        monorepoMigration = "docs\MONOREPO_MIGRATION.md"
        revitPluginSourceReadme = "src\revit-plugin\README.md"
        revitPluginSourceProject = "src\revit-plugin\revit-mcp-plugin\revit-mcp-plugin.csproj"
        revitVersionMatrix = "config\revit-versions.json"
        revitPluginBuildScript = "scripts\build-revit-plugin.ps1"
        installerLibHiddenLauncher = "installer\lib\RevitMcp.HiddenLauncher.psm1"
        installerLibScheduledTask = "installer\lib\RevitMcp.ScheduledTask.psm1"
        installerLibVersions = "installer\lib\RevitMcp.RevitVersions.psm1"
        installerLibPackage = "installer\lib\RevitMcp.Package.psm1"
        installerLibPermissions = "installer\lib\RevitMcp.Permissions.psm1"
        installerLibUpdatePolicy = "installer\lib\RevitMcp.UpdatePolicy.psm1"
        installerLibProxy = "installer\lib\RevitMcp.Proxy.psm1"
        installerLibLogRetention = "installer\lib\RevitMcp.LogRetention.psm1"
        installerLibCodexRegistration = "installer\lib\RevitMcp.CodexRegistration.psm1"
        installerLibReporting = "installer\lib\RevitMcp.Reporting.psm1"
        installer = "installer\install-self-contained.ps1"
        revitPlugin = "installer\revit-plugin\revit_mcp_plugin\RevitMCPPlugin.dll"
        commandSet = "installer\command-payload\RevitMCPCommandSet.dll"
        runtimePackageLock = "installer\runtime-mcp-server\package-lock.json"
        docsPackageLock = "installer\revit-api-docs-mcp\package-lock.json"
        legacyInstaller = "kurulum\install-self-contained.ps1"
    }

    $revitClosedRequiredComponentKeys = [System.Collections.Generic.List[string]]::new()
    $revitPayloadRelativePaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($key in @("revitPlugin", "commandSet")) {
        if ($componentPaths.Contains($key)) {
            [void]$revitClosedRequiredComponentKeys.Add($key)
            [void]$revitPayloadRelativePaths.Add([string]$componentPaths[$key])
        }
    }

    foreach ($payloadRoot in @("installer\revit-plugin", "installer\command-payload")) {
        $fullPayloadRoot = Join-Path $packageRoot $payloadRoot
        if (-not (Test-Path -LiteralPath $fullPayloadRoot -PathType Container)) {
            continue
        }

        Get-ChildItem -LiteralPath $fullPayloadRoot -Recurse -File |
            Sort-Object FullName |
            ForEach-Object {
                $relativePath = $_.FullName.Substring($packageRoot.Length + 1)
                if ($revitPayloadRelativePaths.Contains($relativePath)) {
                    return
                }

                $key = ConvertTo-ComponentKey -Prefix "revitPayload_" -RelativePath $relativePath
                $componentPaths[$key] = $relativePath
                [void]$revitPayloadRelativePaths.Add($relativePath)
                [void]$revitClosedRequiredComponentKeys.Add($key)
            }
    }

    $components = [ordered]@{}
    foreach ($entry in $componentPaths.GetEnumerator()) {
        $components[$entry.Key] = Get-RelativeFileHash -Root $packageRoot -RelativePath $entry.Value
    }
    $components["runtimePayload"] = Get-DirectoryTreeHash -Root $packageRoot -RelativePath "installer\runtime-mcp-server"
    $components["docsServerPayload"] = Get-DirectoryTreeHash -Root $packageRoot -RelativePath "installer\revit-api-docs-mcp"

    Write-Section "Write manifests"
    $manifestPath = Join-Path $releaseDir "manifest.json"
    $manifest = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        version = $Version
        channel = $Channel
        publishedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        git = [ordered]@{
            branch = $branch
            commit = $commit
            isDirty = $isDirty
        }
        package = [ordered]@{
            fileName = (Split-Path -Leaf $zipPath)
            path = $zipPath
            sha256 = $zipHash
            sizeBytes = $zipItem.Length
        }
        installer = [ordered]@{
            entryPoint = "installer\install-self-contained.ps1"
            docsServerPath = "installer\revit-api-docs-mcp"
            legacyEntryPoint = "kurulum\install-self-contained.ps1"
            updaterMinimumVersion = "0.1.0"
        }
        updatePolicy = [ordered]@{
            revitClosedRequiredComponentKeys = @($revitClosedRequiredComponentKeys)
            revitClosedRequiredPaths = @(
                "installer\revit-plugin"
                "installer\command-payload"
            )
            revitCloseBehavior = "defer-user-save-sync"
        }
        components = $components
    }
    $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    if (-not $NoChannelUpdate) {
        $channelPath = Join-Path $channelsRoot ("{0}.json" -f $Channel)
        $channelManifest = [ordered]@{
            schemaVersion = 1
            app = "revit-mcp-skill"
            channel = $Channel
            version = $Version
            publishedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
            manifestPath = $manifestPath
            packagePath = $zipPath
            sha256 = $zipHash
            git = [ordered]@{
                branch = $branch
                commit = $commit
                isDirty = $isDirty
            }
        }
        Write-JsonFile -Value $channelManifest -Path $channelPath -Depth 8
        Write-Host "Updated release manifest: $channelPath" -ForegroundColor Green
    }

    Write-Section "Refresh NAS tools"
    foreach ($toolName in @("Install-Revit-MCP-Updater.cmd", "Install-Revit-MCP-Updater-GUI.cmd", "Install-Revit-MCP-Updater-GUI.ps1", "Revit MCP Updater STABLE.cmd", "update-from-nas.ps1", "show-installed-version.ps1", "install-updater-task.ps1", "promote-nas-release.ps1", "README.md")) {
        Copy-Item -LiteralPath (Join-Path $scriptRoot $toolName) -Destination (Join-Path $toolsRoot $toolName) -Force
    }
    $libSource = Join-Path (Split-Path -Parent $scriptRoot) "lib"
    if (Test-Path -LiteralPath $libSource -PathType Container) {
        $libTarget = Join-Path $toolsRoot "lib"
        if (Test-Path -LiteralPath $libTarget) {
            Remove-Item -LiteralPath $libTarget -Recurse -Force
        }
        Copy-DirectoryFiltered -Source $libSource -Destination $libTarget
        Write-Host "Tools lib path: $libTarget" -ForegroundColor Green
    }
    $configSource = Join-Path $RepoRoot "config"
    if (Test-Path -LiteralPath $configSource -PathType Container) {
        $configTarget = Join-Path $toolsRoot "config"
        if (Test-Path -LiteralPath $configTarget) {
            Remove-Item -LiteralPath $configTarget -Recurse -Force
        }
        Copy-DirectoryFiltered -Source $configSource -Destination $configTarget
        Write-Host "Tools config path: $configTarget" -ForegroundColor Green
    }
    $dependenciesSource = Join-Path $scriptRoot "dependencies"
    if (Test-Path -LiteralPath $dependenciesSource -PathType Container) {
        $dependenciesTarget = Join-Path $toolsRoot "dependencies"
        if (Test-Path -LiteralPath $dependenciesTarget) {
            Remove-Item -LiteralPath $dependenciesTarget -Recurse -Force
        }
        Copy-DirectoryFiltered -Source $dependenciesSource -Destination $dependenciesTarget
        Write-Host "Dependencies path: $dependenciesTarget" -ForegroundColor Green
    }
    Write-Host "Tools path: $toolsRoot" -ForegroundColor Green

    Write-Host "Release package: $zipPath" -ForegroundColor Green
    Write-Host "Release manifest: $manifestPath" -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}
