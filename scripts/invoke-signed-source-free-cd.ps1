<#
.SYNOPSIS
    Build and validate a signed source-free revAgent release root for CD.

.DESCRIPTION
    This script is the GitHub Actions CD producer entrypoint. It runs the
    CI-safe engineering gates, calls the existing source-free NAS publisher
    against a staging release root, requires detached release signatures, and
    runs the signed-stable readiness preflight before the artifact is staged
    for optional NAS publish.

    It does not publish to production NAS by itself.
#>

[CmdletBinding()]
param(
    [string]$ReleaseRoot = "",
    [string]$TrustedKeysPath = "",
    [string]$SigningPrivateKeyPath = "",
    [string]$SigningKeyId = "",
    [string]$Version = "",
    [long]$ReleaseSequence = 0,
    [long]$MinimumAcceptedReleaseSequence = 0,
    [ValidateSet("revit-mcp-skill", "revAgent")]
    [string]$ReleaseAppId = "revit-mcp-skill",
    [ValidateSet("revit-mcp-skill", "revAgent")]
    [string]$ReleasePackageBaseName = "revit-mcp-skill",
    [ValidateSet("stable")]
    [string]$Channel = "stable",
    [switch]$SkipEngineeringGates,
    [switch]$AllowDirty,
    [switch]$AllowNonMain,
    [switch]$Force,
    [switch]$OutputJson,
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

function Get-RevAgentCdGitValue {
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

if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-signed-release-root-" + [Guid]::NewGuid().ToString("N"))
}
$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)

if ([string]::IsNullOrWhiteSpace($SigningPrivateKeyPath)) {
    throw "SigningPrivateKeyPath is required for signed source-free CD."
}
if ([string]::IsNullOrWhiteSpace($SigningKeyId)) {
    throw "SigningKeyId is required for signed source-free CD."
}
if ([string]::IsNullOrWhiteSpace($TrustedKeysPath)) {
    throw "TrustedKeysPath is required for signed source-free CD readiness verification."
}

$trustedKeysFullPath = [System.IO.Path]::GetFullPath($TrustedKeysPath)
if (-not (Test-Path -LiteralPath $trustedKeysFullPath -PathType Leaf)) {
    throw "Trusted release keys file was not found: $trustedKeysFullPath"
}

$refName = [string]$env:GITHUB_REF_NAME
$branch = Get-RevAgentCdGitValue -Repository $RepoRoot -Arguments @("branch", "--show-current") -Fallback ""
$effectiveBranch = if (-not [string]::IsNullOrWhiteSpace($refName)) { $refName } else { $branch }
if (-not $AllowNonMain -and -not [string]::Equals($effectiveBranch, "main", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Signed source-free CD must run from main. Current ref/branch: '$effectiveBranch'. Pass -AllowNonMain only for local dry-run validation."
}

$dirtyStatus = Get-RevAgentCdGitValue -Repository $RepoRoot -Arguments @("status", "--porcelain") -Fallback ""
$isDirty = -not [string]::IsNullOrWhiteSpace($dirtyStatus)
if ($isDirty -and -not $AllowDirty) {
    throw "Signed source-free CD requires a clean tree. Commit first or pass -AllowDirty for an explicit non-production test artifact."
}

if (-not $SkipEngineeringGates) {
    & (Join-Path $RepoRoot "scripts\test-ci.ps1") -RepoRoot $RepoRoot
}

$publishArgs = @{
    ReleaseRoot = $ReleaseRoot
    Channel = $Channel
    RepoRoot = $RepoRoot
    SigningPrivateKeyPath = $SigningPrivateKeyPath
    SigningKeyId = $SigningKeyId
    ReleaseSequence = $ReleaseSequence
    MinimumAcceptedReleaseSequence = $MinimumAcceptedReleaseSequence
    ReleaseAppId = $ReleaseAppId
    ReleasePackageBaseName = $ReleasePackageBaseName
    TrustedReleaseKeysPath = $trustedKeysFullPath
    RequireSigning = $true
}
if (-not [string]::IsNullOrWhiteSpace($Version)) {
    $publishArgs["Version"] = $Version
}
if ($AllowDirty) {
    $publishArgs["AllowDirty"] = $true
}
if ($Force) {
    $publishArgs["Force"] = $true
}

& (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1") @publishArgs

$readiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
    -ReleaseRoot $ReleaseRoot `
    -TrustedKeysPath $trustedKeysFullPath `
    -RepoRoot $RepoRoot

$channelPath = Join-Path $ReleaseRoot "channels\$Channel.json"
$channelDocument = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json

$result = [pscustomobject][ordered]@{
    success = [bool]$readiness.success
    action = "signed-source-free-cd-build"
    releaseRoot = $ReleaseRoot
    channel = $Channel
    app = [string]$channelDocument.app
    version = [string]$channelDocument.version
    releaseSequence = if ($channelDocument.PSObject.Properties["releaseSequence"]) { [long]$channelDocument.releaseSequence } else { [long]0 }
    trustedKeysPath = $trustedKeysFullPath
    readiness = $readiness
}

if ($OutputJson) {
    $result | ConvertTo-Json -Depth 16
}
else {
    $result
}
