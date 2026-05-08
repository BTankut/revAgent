<#
.SYNOPSIS
    Promote an existing NAS release to a channel without rebuilding the package.

.DESCRIPTION
    Use this after a beta package is tested. It reads releases\<Version>\manifest.json
    and updates channels\stable.json, channels\beta.json, or channels\dev.json.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [ValidateSet("stable", "beta", "dev")]
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

$channelManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $channelPath -Encoding UTF8
Write-Host "Promoted $Version to $Channel" -ForegroundColor Green
Write-Host "Updated channel: $channelPath"
