<#
.SYNOPSIS
    Promote an existing NAS release to a channel without rebuilding the package.

.DESCRIPTION
    Reads releases\<Version>\manifest.json and updates channels\stable.json or
    channels\dev.json.

    The former beta channel is retired. When stable is promoted, channels\beta.json
    is kept as a compatibility mirror so older workstations that still point at
    beta.json continue to receive the stable release.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [ValidateSet("stable", "dev")]
    [string]$Channel = "stable"
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^[A-Za-z0-9._-]+$') {
    throw "Version may only contain letters, numbers, dot, underscore, and dash: $Version"
}

$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
$manifestPath = Join-Path $ReleaseRoot ("releases\{0}\manifest.json" -f $Version)
$channelsRoot = Join-Path $ReleaseRoot "channels"
$channelPath = Join-Path $channelsRoot ("{0}.json" -f $Channel)

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Release manifest was not found: $manifestPath"
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.app -ne "revit-mcp-skill") {
    throw "Manifest app is not revit-mcp-skill: $manifestPath"
}
if ($manifest.version -ne $Version) {
    throw "Manifest version does not match requested version. Manifest=$($manifest.version), requested=$Version"
}

New-Item -ItemType Directory -Path $channelsRoot -Force | Out-Null

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

function Copy-OrderedDictionary {
    param([Parameter(Mandatory = $true)]$Source)

    $copy = [ordered]@{}
    foreach ($key in $Source.Keys) {
        $copy[$key] = $Source[$key]
    }
    return $copy
}

function Sync-RetiredBetaChannel {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ChannelsRoot,
        [Parameter(Mandatory = $true)]
        $StableChannelManifest
    )

    $legacyBetaPath = Join-Path $ChannelsRoot "beta.json"
    $legacyBetaManifest = Copy-OrderedDictionary -Source $StableChannelManifest
    $legacyBetaManifest["legacyChannel"] = "beta"
    $legacyBetaManifest["compatibility"] = "retired-beta-alias"

    Write-JsonFile -Value $legacyBetaManifest -Path $legacyBetaPath -Depth 8
    Write-Host "Synced retired beta channel to stable: $legacyBetaPath" -ForegroundColor Yellow
}

$channelManifest = [ordered]@{
    schemaVersion = 1
    app = "revit-mcp-skill"
    channel = $Channel
    version = $Version
    publishedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    manifestPath = $manifestPath
    packagePath = [string]$manifest.package.path
    sha256 = [string]$manifest.package.sha256
    git = $manifest.git
}

Write-JsonFile -Value $channelManifest -Path $channelPath -Depth 8
Write-Host "Promoted $Version to $Channel" -ForegroundColor Green
Write-Host "Updated channel: $channelPath"

if ($Channel -eq "stable") {
    Sync-RetiredBetaChannel -ChannelsRoot $channelsRoot -StableChannelManifest $channelManifest
}
