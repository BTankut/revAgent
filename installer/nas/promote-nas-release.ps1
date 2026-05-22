<#
.SYNOPSIS
    Point the stable NAS channel at an existing release without rebuilding the package.

.DESCRIPTION
    Reads releases\<Version>\manifest.json and updates channels\stable.json.
    Use this for rollback or repair when the release package already exists.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [ValidateSet("stable")]
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
Write-Host "Set release target to $Version" -ForegroundColor Green
Write-Host "Updated release manifest: $channelPath"
