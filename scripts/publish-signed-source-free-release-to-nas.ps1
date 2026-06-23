<#
.SYNOPSIS
    Publish a prebuilt signed source-free release root to the production NAS layout.

.DESCRIPTION
    Copies an already signed and validated CD release root to a NAS release
    root without rebuilding or re-signing it. The source release metadata uses
    relative channel paths, so the detached signatures remain valid after the
    release root moves from CD staging to NAS.

    The script copies release files and tools first, validates a candidate
    channel manifest on the NAS root, then updates the stable channel file.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceReleaseRoot,

    [Parameter(Mandatory = $true)]
    [string]$NasReleaseRoot,

    [Parameter(Mandatory = $true)]
    [string]$TrustedKeysPath,

    [ValidateSet("stable")]
    [string]$Channel = "stable",

    [switch]$Force,

    [switch]$OutputJson,

    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$SourceReleaseRoot = [System.IO.Path]::GetFullPath($SourceReleaseRoot)
$NasReleaseRoot = [System.IO.Path]::GetFullPath($NasReleaseRoot)
$TrustedKeysPath = [System.IO.Path]::GetFullPath($TrustedKeysPath)

function Get-RevitMcpPathPrefix {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
}

function Assert-RevitMcpChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = Get-RevitMcpPathPrefix -Path $Root
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside the release root. Path '$fullPath' is not under '$Root'."
    }
}

function Copy-RevitMcpDirectoryExact {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$AllowReplace
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Required source directory was not found: $Source"
    }
    Assert-RevitMcpChildPath -Path $Destination -Root $Root

    if (Test-Path -LiteralPath $Destination) {
        if (-not $AllowReplace) {
            throw "Target already exists: $Destination. Pass -Force to replace it."
        }
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

if (-not (Test-Path -LiteralPath $SourceReleaseRoot -PathType Container)) {
    throw "Source release root was not found: $SourceReleaseRoot"
}
if (-not (Test-Path -LiteralPath $TrustedKeysPath -PathType Leaf)) {
    throw "Trusted release keys file was not found: $TrustedKeysPath"
}

$sourceReadiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
    -ReleaseRoot $SourceReleaseRoot `
    -TrustedKeysPath $TrustedKeysPath `
    -RepoRoot $RepoRoot
if (-not [bool]$sourceReadiness.success) {
    throw "Source signed release root failed readiness verification."
}

$sourceChannelPath = Join-Path $SourceReleaseRoot "channels\$Channel.json"
$sourceChannelSignaturePath = Join-Path $SourceReleaseRoot "channels\$Channel.sig.json"
if (-not (Test-Path -LiteralPath $sourceChannelPath -PathType Leaf)) {
    throw "Source channel manifest was not found: $sourceChannelPath"
}
if (-not (Test-Path -LiteralPath $sourceChannelSignaturePath -PathType Leaf)) {
    throw "Source channel signature was not found: $sourceChannelSignaturePath"
}

$sourceChannel = Get-Content -Raw -LiteralPath $sourceChannelPath | ConvertFrom-Json
$version = [string]$sourceChannel.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "Source channel manifest does not contain a version."
}
if ([System.IO.Path]::IsPathRooted([string]$sourceChannel.manifestPath) -or [System.IO.Path]::IsPathRooted([string]$sourceChannel.packagePath)) {
    throw "Source channel paths must be relative so the signed release can move to NAS without re-signing."
}

$sourceReleaseDir = Join-Path $SourceReleaseRoot "releases\$version"
$sourceToolsDir = Join-Path $SourceReleaseRoot "tools"
$nasReleaseDir = Join-Path $NasReleaseRoot "releases\$version"
$nasToolsDir = Join-Path $NasReleaseRoot "tools"
$nasChannelsDir = Join-Path $NasReleaseRoot "channels"

New-Item -ItemType Directory -Path $NasReleaseRoot -Force | Out-Null
Copy-RevitMcpDirectoryExact -Source $sourceReleaseDir -Destination $nasReleaseDir -Root $NasReleaseRoot -AllowReplace:$Force
Copy-RevitMcpDirectoryExact -Source $sourceToolsDir -Destination $nasToolsDir -Root $NasReleaseRoot -AllowReplace:$true

New-Item -ItemType Directory -Path $nasChannelsDir -Force | Out-Null
$candidateChannelPath = Join-Path $nasChannelsDir ("{0}.candidate.json" -f $Channel)
$candidateSignaturePath = Join-Path $nasChannelsDir ("{0}.candidate.sig.json" -f $Channel)
$stableChannelPath = Join-Path $nasChannelsDir ("{0}.json" -f $Channel)
$stableSignaturePath = Join-Path $nasChannelsDir ("{0}.sig.json" -f $Channel)
foreach ($path in @($candidateChannelPath, $candidateSignaturePath, $stableChannelPath, $stableSignaturePath)) {
    Assert-RevitMcpChildPath -Path $path -Root $NasReleaseRoot
}

Copy-Item -LiteralPath $sourceChannelPath -Destination $candidateChannelPath -Force
Copy-Item -LiteralPath $sourceChannelSignaturePath -Destination $candidateSignaturePath -Force

$candidateReadiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
    -ReleaseRoot $NasReleaseRoot `
    -ChannelManifestPath $candidateChannelPath `
    -TrustedKeysPath $TrustedKeysPath `
    -ArtifactScanScope activeRelease `
    -RepoRoot $RepoRoot
if (-not [bool]$candidateReadiness.success) {
    throw "NAS candidate signed release root failed readiness verification."
}

Copy-Item -LiteralPath $candidateSignaturePath -Destination $stableSignaturePath -Force
Copy-Item -LiteralPath $candidateChannelPath -Destination $stableChannelPath -Force

$stableReadiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
    -ReleaseRoot $NasReleaseRoot `
    -TrustedKeysPath $TrustedKeysPath `
    -ArtifactScanScope activeRelease `
    -RepoRoot $RepoRoot
if (-not [bool]$stableReadiness.success) {
    throw "NAS stable signed release root failed readiness verification after publish."
}

Remove-Item -LiteralPath $candidateChannelPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $candidateSignaturePath -Force -ErrorAction SilentlyContinue

$result = [pscustomobject][ordered]@{
    success = $true
    action = "signed-source-free-nas-publish"
    sourceReleaseRoot = $SourceReleaseRoot
    nasReleaseRoot = $NasReleaseRoot
    channel = $Channel
    version = $version
    stableChannelPath = $stableChannelPath
    stableSignaturePath = $stableSignaturePath
    releaseDirectory = $nasReleaseDir
    readiness = $stableReadiness
}

if ($OutputJson) {
    $result | ConvertTo-Json -Depth 16
}
else {
    $result
}
