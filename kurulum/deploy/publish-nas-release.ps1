<#
.SYNOPSIS
    Publish the current self-contained Revit MCP package to a NAS release root.

.DESCRIPTION
    Creates a versioned ZIP package, writes a release manifest, and optionally
    updates a channel manifest such as channels\stable.json or channels\beta.json.

    Commit/push does not deploy anything by itself. This script is the explicit
    "publish this version" step.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [ValidateSet("stable", "beta", "dev")]
    [string]$Channel = "beta",

    [string]$Version = "",

    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,

    [switch]$AllowDirty,

    [switch]$Force,

    [switch]$NoChannelUpdate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

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
    foreach ($name in @(".git", ".vs", ".idea", ".vscode", "node_modules", "__pycache__")) {
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

Write-Section "Validate repository"
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "SKILL.md"))) {
    throw "SKILL.md was not found under RepoRoot: $RepoRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "kurulum\install-self-contained.ps1"))) {
    throw "Installer was not found under RepoRoot: $RepoRoot"
}

$commit = Get-GitValue -Repository $RepoRoot -Arguments @("rev-parse", "HEAD") -Fallback "unknown"
$shortCommit = if ($commit -ne "unknown" -and $commit.Length -ge 8) { $commit.Substring(0, 8) } else { "nogit" }
$branch = Get-GitValue -Repository $RepoRoot -Arguments @("branch", "--show-current") -Fallback "unknown"
$dirtyStatus = Get-GitValue -Repository $RepoRoot -Arguments @("status", "--porcelain") -Fallback ""
$isDirty = -not [string]::IsNullOrWhiteSpace($dirtyStatus)

if ($isDirty -and -not $AllowDirty) {
    throw "Working tree has uncommitted changes. Commit first or pass -AllowDirty for a deliberate test package."
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = "{0}-{1}" -f (Get-Date -Format "yyyy.MM.dd.HHmm"), $shortCommit
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
        installer = "kurulum\install-self-contained.ps1"
        revitPlugin = "kurulum\revit-plugin\revit_mcp_plugin\RevitMCPPlugin.dll"
        commandSet = "kurulum\Custom_DLL\RevitMCPCommandSet.dll"
        runtimePackageLock = "kurulum\mcp-server\package-lock.json"
        docsPackageLock = "kurulum\revit-api-docs-mcp\package-lock.json"
    }

    $components = [ordered]@{}
    foreach ($entry in $componentPaths.GetEnumerator()) {
        $components[$entry.Key] = Get-RelativeFileHash -Root $packageRoot -RelativePath $entry.Value
    }

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
            entryPoint = "kurulum\install-self-contained.ps1"
            updaterMinimumVersion = "0.1.0"
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
        $channelManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $channelPath -Encoding UTF8
        Write-Host "Updated channel: $channelPath" -ForegroundColor Green
    }

    Write-Section "Refresh NAS tools"
    foreach ($toolName in @("Install-Revit-MCP-Updater.cmd", "update-from-nas.ps1", "install-updater-task.ps1", "promote-nas-release.ps1", "README.md")) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $toolName) -Destination (Join-Path $toolsRoot $toolName) -Force
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
