<#
.SYNOPSIS
    Produce unelevated, signed-release-derived bootstrap prestage hash evidence.

.DESCRIPTION
    This coordinator-side producer verifies the signed channel and release
    manifest before deriving the exact hashes consumed by the elevated canonical
    prestage installer. The elevated consumer never derives or rewrites this
    evidence. Run this script before copying the evidence and installer into the
    administrator-only ProgramData prestage directory.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [string]$Channel = "stable",
    [string]$RepoRoot = "",
    [switch]$AllowTestRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot).TrimEnd("\")
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\")
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$TrustedKeysPath = [IO.Path]::GetFullPath($TrustedKeysPath)
$canonicalReleaseRoot = [IO.Path]::GetFullPath("\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy").TrimEnd("\")

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $AllowTestRoot -and $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Bootstrap prestage evidence must be produced before elevation in the normal coordinator process."
}
if (-not $AllowTestRoot -and -not [string]::Equals($ReleaseRoot, $canonicalReleaseRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Production evidence requires the canonical signed release root '$canonicalReleaseRoot'."
}
if ($AllowTestRoot) {
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\") + "\"
    if (-not ($ReleaseRoot + "\").StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "AllowTestRoot is limited to disposable release fixtures below TEMP."
    }
}

function Test-RevAgentEvidencePathUnderRoot {
    param([string]$Path, [string]$Root)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd("\")
    return [string]::Equals($fullPath.TrimEnd("\"), $fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + "\", [StringComparison]::OrdinalIgnoreCase)
}

function Assert-RevAgentEvidencePathNoLinks {
    param([string]$Path, [string]$StopRoot)
    $cursor = [IO.Path]::GetFullPath($Path)
    while (Test-RevAgentEvidencePathUnderRoot -Path $cursor -Root $StopRoot) {
        if (-not (Test-Path -LiteralPath $cursor)) { throw "Signed evidence source path is missing: $cursor" }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        $linkType = if ($item.PSObject.Properties["LinkType"]) { [string]$item.LinkType } else { "" }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) {
            throw "Signed evidence source contains a filesystem link/reparse component: $cursor"
        }
        if ([string]::Equals($cursor.TrimEnd("\"), [IO.Path]::GetFullPath($StopRoot).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }
}

function Resolve-RevAgentEvidenceReleasePath {
    param([string]$Path, [string]$BaseDirectory)
    $resolved = if ([IO.Path]::IsPathRooted($Path)) { [IO.Path]::GetFullPath($Path) } else { [IO.Path]::GetFullPath((Join-Path $BaseDirectory $Path)) }
    if (-not (Test-RevAgentEvidencePathUnderRoot -Path $resolved -Root $ReleaseRoot)) { throw "Signed release path escaped ReleaseRoot: $resolved" }
    Assert-RevAgentEvidencePathNoLinks -Path $resolved -StopRoot $ReleaseRoot
    return $resolved
}

if (Test-RevAgentEvidencePathUnderRoot -Path $OutputPath -Root $ReleaseRoot) { throw "Evidence output must not be written into the signed release root." }
if (Test-Path -LiteralPath $OutputPath) { throw "Evidence output already exists; refusing replacement: $OutputPath" }
$outputParent = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) { throw "Evidence output parent must already exist: $outputParent" }
if (-not (Test-Path -LiteralPath $TrustedKeysPath -PathType Leaf)) { throw "Trusted key document was not found: $TrustedKeysPath" }

$integrityModulePath = Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1"
$pinnedIntegrityModuleHash = "2360CC209EAAD6AEF26E90F6865427914CDE499F0F6F8838296D5F5381F371B4"
if (-not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $integrityModulePath).Hash, $pinnedIntegrityModuleHash, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Coordinator integrity verifier hash did not match the production pin."
}
$trustedKeys = Get-Content -Raw -LiteralPath $TrustedKeysPath | ConvertFrom-Json
if (-not $AllowTestRoot) {
    $productionKey = $trustedKeys.trustedKeys."revagent-prod-rsa-2026q3"
    if ($null -eq $productionKey) { throw "Trusted key document does not contain the production signing key." }
    $normalizedPublicKey = ([string]$productionKey.publicKeyXml).Trim() -replace "\s+", ""
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $fingerprint = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedPublicKey)))).Replace("-", "") }
    finally { $sha.Dispose() }
    if ($fingerprint -ne "32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33") { throw "Production release-key fingerprint mismatch." }
}

$channelPath = Resolve-RevAgentEvidenceReleasePath -Path (Join-Path "channels" ($Channel + ".json")) -BaseDirectory $ReleaseRoot
$channelDocument = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json
$channelDirectory = Split-Path -Parent $channelPath
$manifestPath = Resolve-RevAgentEvidenceReleasePath -Path ([string]$channelDocument.manifestPath) -BaseDirectory $channelDirectory
$manifestDocument = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$packagePath = Resolve-RevAgentEvidenceReleasePath -Path ([string]$channelDocument.packagePath) -BaseDirectory $channelDirectory

$integrityModule = Import-Module $integrityModulePath -Force -PassThru
$integrityCommand = Get-Command ("{0}\Test-RevAgentReleaseDistributionIntegrity" -f $integrityModule.Name) -ErrorAction Stop
$integrity = & $integrityCommand -ChannelPath $channelPath -Channel $channelDocument -ReleaseManifestPath $manifestPath -ReleaseManifest $manifestDocument -TrustedKeys $trustedKeys.trustedKeys -Policy enforce
if (-not [bool]$integrity.success) { throw "Signed release verification failed before evidence generation: $($integrity.reason). $($integrity.message)" }

$componentMap = [ordered]@{
    localBootstrapInstallerScript = @("localBootstrapInstaller", "installer\nas\install-revagent-local-bootstrap.ps1")
    localBootstrapInstallerModule = @("installerLibLocalBootstrap", "installer\lib\RevAgent.LocalBootstrap.psm1")
    bootstrap = @("localBootstrap", "installer\nas\Start-revAgent-Update.ps1")
    launcher = @("localBootstrapLauncher", "installer\nas\Start-revAgent-Update.cmd")
    updaterGui = @("updaterGui", "installer\nas\Install-revAgent-Updater-GUI.ps1")
    distributionIntegrity = @("installerLibDistributionIntegrity", "installer\lib\RevAgent.DistributionIntegrity.psm1")
    sourceFreeMigration = @("installerLibSourceFreeMigration", "installer\lib\RevAgent.SourceFreeMigration.psm1")
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($packagePath)
$componentHashes = [ordered]@{}
try {
    foreach ($entry in $componentMap.GetEnumerator()) {
        $componentKey = [string]$entry.Value[0]
        $expectedPath = [string]$entry.Value[1]
        $component = $manifestDocument.components.$componentKey
        if ($null -eq $component -or -not [string]::Equals(([string]$component.path).Replace("/", "\"), $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Signed manifest component '$componentKey' is missing or has an unexpected path."
        }
        $zipPath = $expectedPath.Replace("\", "/")
        $zipEntries = @($archive.Entries | Where-Object { [string]::Equals($_.FullName.Replace("\", "/"), $zipPath, [StringComparison]::OrdinalIgnoreCase) })
        if ($zipEntries.Count -ne 1) { throw "Signed package must contain exactly one '$zipPath' entry; found $($zipEntries.Count)." }
        if ([long]$zipEntries[0].Length -lt 1 -or [long]$zipEntries[0].Length -gt 33554432) { throw "Signed package entry size is outside the evidence policy: $zipPath" }
        $entryStream = $zipEntries[0].Open()
        $entryHash = [Security.Cryptography.SHA256]::Create()
        try { $actualHash = ([BitConverter]::ToString($entryHash.ComputeHash($entryStream))).Replace("-", "") }
        finally { $entryHash.Dispose(); $entryStream.Dispose() }
        if (-not [string]::Equals($actualHash, [string]$component.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Signed package entry hash mismatch for '$componentKey'."
        }
        $componentHashes[$entry.Key] = [string]$component.sha256
    }
}
finally { $archive.Dispose() }

$evidence = [ordered]@{
    schemaVersion = 1
    app = "revAgent"
    evidenceType = "bootstrap-prestage"
    generatedAtUtc = [DateTime]::UtcNow.ToString("o")
    generatedBySid = [string]$identity.User.Value
    release = [ordered]@{
        root = $ReleaseRoot
        channel = [string]$channelDocument.channel
        version = [string]$channelDocument.version
        channelManifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $channelPath).Hash
        releaseManifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash
        packageSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash
        signatureVerified = $true
    }
    localBootstrapInstallerScript = [string]$componentHashes.localBootstrapInstallerScript
    localBootstrapInstallerModule = [string]$componentHashes.localBootstrapInstallerModule
    sources = [ordered]@{
        bootstrap = [string]$componentHashes.bootstrap
        launcher = [string]$componentHashes.launcher
        updaterGui = [string]$componentHashes.updaterGui
        distributionIntegrity = [string]$componentHashes.distributionIntegrity
        sourceFreeMigration = [string]$componentHashes.sourceFreeMigration
        trustedKeys = (Get-FileHash -Algorithm SHA256 -LiteralPath $TrustedKeysPath).Hash
    }
}
$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($evidence | ConvertTo-Json -Depth 10))
$stream = $null
try {
    $stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
}
finally { if ($null -ne $stream) { $stream.Dispose() } }

[pscustomobject][ordered]@{
    success = $true
    action = "bootstrap-prestage-evidence"
    outputPath = $OutputPath
    outputSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash
    version = [string]$channelDocument.version
    signatureVerified = $true
}
