<#
.SYNOPSIS
    CI-safe tests for signed stable readiness preflight.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1") -Force

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Equal {
    param(
        [object]$Actual,
        [object]$Expected,
        [string]$Message
    )

    if (-not [object]::Equals($Actual, $Expected)) {
        throw "$Message Expected '$Expected', got '$Actual'."
    }
}

function New-TestRsaProvider {
    $cspParameters = [System.Security.Cryptography.CspParameters]::new(24)
    $cspParameters.Flags = [System.Security.Cryptography.CspProviderFlags]::CreateEphemeralKey
    return [System.Security.Cryptography.RSACryptoServiceProvider]::new(2048, $cspParameters)
}

function Set-TestPublishedStableSurface {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [Parameter(Mandatory = $true)][string]$TrustedKeysPath
    )

    $toolsRoot = Join-Path $ReleaseRoot 'tools'
    $configRoot = Join-Path $toolsRoot 'config'
    New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
    $templateBytes = [IO.File]::ReadAllBytes((Join-Path $RepoRoot 'installer\nas\revAgent Updater STABLE.cmd'))
    $templateText = [Text.Encoding]::ASCII.GetString($templateBytes)
    $launcherBytes = [Text.Encoding]::ASCII.GetBytes($templateText.Replace(
            'set "RELEASE_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"',
            ('set "RELEASE_ROOT={0}"' -f ([IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\', '/')))))
    foreach ($launcherName in @('revAgent Updater STABLE.cmd', 'Revit MCP Updater STABLE.cmd')) {
        [IO.File]::WriteAllBytes((Join-Path $toolsRoot $launcherName), $launcherBytes)
    }
    foreach ($toolName in @('Refresh-revAgent-LocalBootstrap-STABLE.cmd', 'Refresh-revAgent-LocalBootstrap-STABLE.ps1')) {
        Copy-Item -LiteralPath (Join-Path (Join-Path $RepoRoot 'installer\nas') $toolName) -Destination (Join-Path $toolsRoot $toolName) -Force
    }
    Copy-Item -LiteralPath $TrustedKeysPath -Destination (Join-Path $configRoot 'release-trusted-keys.json') -Force
    foreach ($legacyLauncherName in @(
            'Install-revAgent-Updater-GUI.cmd',
            'Install-Revit-MCP-Updater-GUI.cmd',
            'Install-revAgent-Updater.cmd',
            'Install-Revit-MCP-Updater.cmd'
        )) {
        $sourcePath = Join-Path (Join-Path $RepoRoot 'installer\nas') $legacyLauncherName
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $toolsRoot $legacyLauncherName) -Force
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $ReleaseRoot $legacyLauncherName) -Force
    }
}

Write-Host "Test signed stable readiness preflight"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-signed-stable-readiness-test-" + [Guid]::NewGuid().ToString("N"))
$signedRoot = Join-Path $tempRoot "signed-release-root"
$unsignedRoot = Join-Path $tempRoot "unsigned-release-root"
$secretRoot = Join-Path $tempRoot "secrets"
$keyId = "test-readiness-key"
$signedVersion = "2026.06.23.1-readiness-signed"
$unsignedVersion = "2026.06.23.1-readiness-unsigned"
$releaseSequence = 2001
$minimumAcceptedReleaseSequence = 2000
$rsa = New-TestRsaProvider

try {
    New-Item -ItemType Directory -Path $secretRoot -Force | Out-Null
    $privateKeyPath = Join-Path $secretRoot "release-signing-private.xml"
    $privateKeyXml = $rsa.ToXmlString($true)
    $privateKeyXml | Set-Content -LiteralPath $privateKeyPath -Encoding UTF8
    $publicKeyXml = $rsa.ToXmlString($false)
    $trustedKeys = [ordered]@{
        schemaVersion = 1
        app = 'revAgent'
        generatedAtUtc = '2026-07-20T00:00:00Z'
        trustedKeys = @{}
    }
    $trustedKeys.trustedKeys[$keyId] = [pscustomobject][ordered]@{
        publicKeyXml = $publicKeyXml
        publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
        algorithm = "RS256"
    }
    $trustedKeysPath = Join-Path $secretRoot "release-trusted-keys.json"
    $trustedKeys | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $trustedKeysPath -Encoding UTF8
    $nodeMsiSourcePath = Join-Path $secretRoot "node-v24.14.1-x64.msi"
    [System.IO.File]::WriteAllBytes($nodeMsiSourcePath, [System.Text.Encoding]::UTF8.GetBytes("TEST NODE MSI SIDECAR"))

    & (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1") `
        -ReleaseRoot $signedRoot `
        -Version $signedVersion `
        -AllowDirty `
        -Force `
        -SigningPrivateKeyPath $privateKeyPath `
        -SigningKeyId $keyId `
        -TrustedReleaseKeysPath $trustedKeysPath `
        -AllowTestSigningIdentity `
        -NodeMsiPath $nodeMsiSourcePath `
        -ReleaseSequence $releaseSequence `
        -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence | Out-Null

    $signedReport = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity
    Assert-True ([bool]$signedReport.success) "Signed release root should be ready for enforce-mode rollout."
    Assert-True ([bool]$signedReport.readyForEnforce) "Signed release root should report readyForEnforce=true."
    Assert-Equal ([long]$signedReport.releaseSequence) ([long]$releaseSequence) "Readiness report should preserve releaseSequence."
    Assert-Equal ([int]$signedReport.trustedKeyCount) 1 "Readiness report should count trusted release keys."
    Assert-Equal ([string]$signedReport.nodeMsi.relativePath) "external\node-v24.14.1-x64.msi" "Readiness must preserve the exact signed Node MSI relative path."
    Assert-True (Test-Path -LiteralPath ([string]$signedReport.nodeMsi.path) -PathType Leaf) "Readiness must resolve the signed Node MSI to the versioned release sidecar."
    Assert-Equal ([string]$signedReport.nodeMsi.actualSha256) ([string]$signedReport.nodeMsi.signedSha256) "Readiness must bind the actual Node MSI hash to signed metadata."
    Assert-Equal ([long]$signedReport.nodeMsi.actualSizeBytes) ([long]$signedReport.nodeMsi.signedSizeBytes) "Readiness must bind the actual Node MSI size to signed metadata."
    Assert-Equal ([string]$signedReport.nodeMsi.authenticodeStatus) "TestBypass" "Disposable test-signing readiness should report its bounded Authenticode bypass."
    Assert-True (@($signedReport.checks | Where-Object { $_.name -like "node_msi_*" -and -not $_.success }).Count -eq 0) "A valid signed test Node MSI sidecar should pass every Node MSI readiness check."
    Assert-True ([bool]$signedReport.trustedKeyValidation.success) 'Readiness must validate the closed public trusted-key document contract.'
    Assert-True ([bool]$signedReport.packageTrustedKeys.success -and [bool]$signedReport.packageTrustedKeys.exactBytesMatch) 'Readiness must bind packaged trusted-key bytes to signed metadata and the publisher input.'
    Assert-Equal ([string]$signedReport.packageTrustedKeys.packageSha256) ([string]$signedReport.packageTrustedKeys.publisherInputSha256) 'Packaged trusted-key SHA-256 must equal the verified publisher input.'
    Assert-True (-not [bool]$signedReport.machineTrust.inspected -and [bool]$signedReport.machineTrust.reportOnly) 'Local machine trust health must remain opt-in and non-gating.'

    $emptyMachineTrustRoot = Join-Path $tempRoot 'empty-programdata'
    New-Item -ItemType Directory -Path $emptyMachineTrustRoot -Force | Out-Null
    $missingMachineTrustReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -InspectLocalBootstrapTrust `
        -BootstrapTrustProgramDataRoot $emptyMachineTrustRoot `
        -BootstrapTrustTaskProvider { param($Layout) return $null }
    Assert-True ([bool]$missingMachineTrustReport.success) 'Read-only local machine-trust reporting must not change signed-release readiness.'
    Assert-True ([bool]$missingMachineTrustReport.machineTrust.inspected -and -not [bool]$missingMachineTrustReport.machineTrust.healthy -and [bool]$missingMachineTrustReport.machineTrust.reportOnly) 'Readiness must report a missing local trust core/task without installing or gating the signed release.'

    $reformattedTrustedKeysPath = Join-Path $secretRoot 'release-trusted-keys-reformatted.json'
    [IO.File]::WriteAllText($reformattedTrustedKeysPath, ($trustedKeys | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
    $reformattedKeyReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $reformattedTrustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -ReportOnly
    Assert-True (-not [bool]$reformattedKeyReport.success) 'Readiness accepted semantically equivalent but byte-distinct external trusted keys against the signed package.'
    Assert-True (@($reformattedKeyReport.checks | Where-Object { $_.name -eq 'package_trusted_keys_exact_identity' -and -not [bool]$_.success }).Count -eq 1) 'Readiness did not surface the packaged/external trusted-key byte-identity failure.'

    Assert-Equal @(Get-ChildItem -LiteralPath $signedRoot -Recurse -File -Filter '*.cmd').Count 0 'Source release fixture must remain free of unsigned CMD first-hop entry points.'
    $unpublishedSurfaceReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -ArtifactScanScope activeRelease `
        -RequirePublishedSurface `
        -ReportOnly
    Assert-True (-not [bool]$unpublishedSurfaceReport.success) 'Published-surface readiness accepted a source-only release root.'
    Assert-True (@($unpublishedSurfaceReport.checks | Where-Object { $_.name -like 'published_surface_*_present' -and -not [bool]$_.success }).Count -gt 0) 'Source-only readiness did not identify missing published entry points.'

    Set-TestPublishedStableSurface -ReleaseRoot $signedRoot -TrustedKeysPath $trustedKeysPath
    $publishedSurfaceReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -ArtifactScanScope activeRelease `
        -RequirePublishedSurface
    Assert-True ([bool]$publishedSurfaceReport.success -and [bool]$publishedSurfaceReport.publishedSurface.success) 'Exact managed published surface should pass readiness.'
    Assert-Equal @($publishedSurfaceReport.publishedSurface.managedFiles).Count 13 'Published-surface readiness must verify four STABLE files, trusted keys, and four legacy stubs in both tools and the NAS root.'
    Assert-True (@($publishedSurfaceReport.publishedSurface.managedFiles | Where-Object { -not [bool]$_.sha256Matches }).Count -eq 0) 'Published-surface readiness left an exact managed file hash unmatched.'
    Assert-True (@($publishedSurfaceReport.publishedSurface.managedFiles | Where-Object { -not [bool]$_.safe -or [uint32]$_.linkCount -ne 1 -or [string]::IsNullOrWhiteSpace([string]$_.identity) }).Count -eq 0) 'Published-surface readiness did not prove every managed leaf through an exact single-link held-handle identity.'

    $publishedTrustedKeysRelativePath = 'tools\config\release-trusted-keys.json'
    $publishedTrustedKeysPath = Join-Path $signedRoot $publishedTrustedKeysRelativePath
    $publishedConfigPath = Split-Path -Parent $publishedTrustedKeysPath
    $junctionTarget = Join-Path $tempRoot 'published-config-junction-target'
    $tempRootPrefix = [IO.Path]::GetFullPath($tempRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    foreach ($movePath in @($publishedConfigPath, $junctionTarget)) {
        if (-not [IO.Path]::GetFullPath($movePath).StartsWith($tempRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Junction fixture move path escaped its disposable temp root: $movePath"
        }
    }
    [IO.Directory]::Move($publishedConfigPath, $junctionTarget)
    try {
        New-Item -ItemType Junction -Path $publishedConfigPath -Target $junctionTarget -ErrorAction Stop | Out-Null
        $junctionReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $signedRoot `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestSigningIdentity `
            -ArtifactScanScope activeRelease `
            -RequirePublishedSurface `
            -ReportOnly
        $junctionEvidence = @($junctionReport.publishedSurface.managedFiles | Where-Object { [string]::Equals([string]$_.relativePath, $publishedTrustedKeysRelativePath, [StringComparison]::OrdinalIgnoreCase) })[0]
        Assert-True (-not [bool]$junctionReport.success) 'Published-surface readiness accepted a managed leaf reached through a junction.'
        Assert-True ($null -ne $junctionEvidence -and -not [bool]$junctionEvidence.safe -and [string]$junctionEvidence.reason -eq 'published_surface_reparse_path') 'Managed junction fixture did not fail with the no-reparse reason.'
    }
    finally {
        if (Test-Path -LiteralPath $publishedConfigPath) {
            $publishedConfigItem = Get-Item -LiteralPath $publishedConfigPath -Force
            if (($publishedConfigItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                [IO.Directory]::Delete($publishedConfigPath)
            }
        }
        if (-not (Test-Path -LiteralPath $publishedConfigPath -PathType Container)) {
            [IO.Directory]::Move($junctionTarget, $publishedConfigPath)
        }
    }

    $hardlinkRelativePath = 'Install-revAgent-Updater.cmd'
    $hardlinkTargetPath = Join-Path $signedRoot $hardlinkRelativePath
    $hardlinkAliasPath = Join-Path $tempRoot 'managed-published-leaf-hardlink-alias.cmd'
    try {
        New-Item -ItemType HardLink -Path $hardlinkAliasPath -Target $hardlinkTargetPath -ErrorAction Stop | Out-Null
        $hardlinkReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $signedRoot `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestSigningIdentity `
            -ArtifactScanScope activeRelease `
            -RequirePublishedSurface `
            -ReportOnly
        $hardlinkEvidence = @($hardlinkReport.publishedSurface.managedFiles | Where-Object { [string]::Equals([string]$_.relativePath, $hardlinkRelativePath, [StringComparison]::OrdinalIgnoreCase) })[0]
        Assert-True (-not [bool]$hardlinkReport.success) 'Published-surface readiness accepted a multiply-linked managed leaf.'
        Assert-True ($null -ne $hardlinkEvidence -and -not [bool]$hardlinkEvidence.safe -and [string]$hardlinkEvidence.reason -eq 'published_surface_hardlink' -and [uint32]$hardlinkEvidence.linkCount -eq 2) 'Managed hardlink fixture did not fail the exact single-link policy with the observed link count.'
    }
    finally {
        Remove-Item -LiteralPath $hardlinkAliasPath -Force -ErrorAction SilentlyContinue
    }

    $raceRelativePath = 'tools\Refresh-revAgent-LocalBootstrap-STABLE.cmd'
    $raceTargetPath = Join-Path $signedRoot $raceRelativePath
    $raceOriginalBytes = [IO.File]::ReadAllBytes($raceTargetPath)
    $raceReplacementPath = Join-Path $tempRoot 'managed-published-leaf-race-replacement.cmd'
    $raceBackupPath = Join-Path $tempRoot 'managed-published-leaf-race-backup.cmd'
    [IO.File]::WriteAllText($raceReplacementPath, 'RACE REPLACEMENT', [Text.Encoding]::ASCII)
    $raceState = [pscustomobject]@{ attempted = $false; blocked = $false; error = '' }
    $raceHook = {
        param([string]$Path, [string]$RelativePath)
        if ([string]::Equals($RelativePath, $raceRelativePath, [StringComparison]::OrdinalIgnoreCase)) {
            $raceState.attempted = $true
            try {
                [IO.File]::Replace($raceReplacementPath, $Path, $raceBackupPath)
            }
            catch {
                $raceState.blocked = $true
                $raceState.error = $_.Exception.Message
            }
        }
    }.GetNewClosure()
    try {
        $raceReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $signedRoot `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestSigningIdentity `
            -ArtifactScanScope activeRelease `
            -RequirePublishedSurface `
            -ManagedPublishedLeafAfterOpenTestHook $raceHook
        Assert-True ([bool]$raceState.attempted) 'Managed pathname-race fixture did not execute after the exact leaf handle opened.'
        Assert-True ([bool]$raceState.blocked) "Managed pathname replacement was not blocked while the exact leaf handle was held. $($raceState.error)"
        Assert-True ([bool]$raceReport.success) 'A blocked pathname-replacement attempt changed readiness evidence.'
        Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($raceTargetPath), [byte[]]$raceOriginalBytes)) 'Blocked pathname replacement changed the managed target bytes.'
    }
    finally {
        [IO.File]::WriteAllBytes($raceTargetPath, $raceOriginalBytes)
        Remove-Item -LiteralPath $raceReplacementPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $raceBackupPath -Force -ErrorAction SilentlyContinue
    }

    $publishedRefreshPath = Join-Path $signedRoot 'tools\Refresh-revAgent-LocalBootstrap-STABLE.cmd'
    $publishedRefreshBytes = [IO.File]::ReadAllBytes($publishedRefreshPath)
    try {
        [IO.File]::AppendAllText($publishedRefreshPath, 'TAMPERED', [Text.Encoding]::ASCII)
        $tamperedPublishedToolReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $signedRoot `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestSigningIdentity `
            -ArtifactScanScope activeRelease `
            -RequirePublishedSurface `
            -ReportOnly
        Assert-True (-not [bool]$tamperedPublishedToolReport.success) 'Published-surface readiness accepted a tampered refresh launcher.'
        Assert-True (@($tamperedPublishedToolReport.checks | Where-Object { $_.name -eq 'published_surface_tools_refresh_revagent_localbootstrap_stable_cmd_sha256' -and -not [bool]$_.success }).Count -eq 1) 'Tampered refresh launcher did not fail its exact published hash check.'
    }
    finally { [IO.File]::WriteAllBytes($publishedRefreshPath, $publishedRefreshBytes) }

    $unexpectedCommandPath = Join-Path $signedRoot 'tools\Unexpected Legacy Entry.cmd'
    try {
        [IO.File]::WriteAllText($unexpectedCommandPath, '@echo off', [Text.Encoding]::ASCII)
        $unexpectedCommandReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $signedRoot `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestSigningIdentity `
            -ArtifactScanScope activeRelease `
            -RequirePublishedSurface `
            -ReportOnly
        Assert-True (-not [bool]$unexpectedCommandReport.success) 'Published-surface readiness accepted an unmanaged CMD entry point.'
        Assert-True (@($unexpectedCommandReport.checks | Where-Object { $_.name -eq 'published_surface_no_unmanaged_cmd_entry_points' -and -not [bool]$_.success }).Count -eq 1) 'Unmanaged CMD entry point did not fail the exact managed-list check.'
    }
    finally { Remove-Item -LiteralPath $unexpectedCommandPath -Force -ErrorAction SilentlyContinue }

    $signedJson = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -OutputJson
    $signedJsonReport = $signedJson | ConvertFrom-Json
    Assert-True ([bool]$signedJsonReport.success) "JSON readiness output should parse and report success."

    $signedReleaseDirectory = Join-Path $signedRoot "releases\$signedVersion"
    $signedNodeMsiPath = Join-Path $signedReleaseDirectory "external\node-v24.14.1-x64.msi"
    $signedNodeMsiBytes = [System.IO.File]::ReadAllBytes($signedNodeMsiPath)

    Remove-Item -LiteralPath $signedNodeMsiPath -Force
    $missingNodeMsiReport = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -ReportOnly
    Assert-True (-not [bool]$missingNodeMsiReport.success) "A signed release with a missing Node MSI sidecar must fail readiness."
    Assert-True (@($missingNodeMsiReport.checks | Where-Object { $_.name -eq "node_msi_file_present" -and -not $_.success }).Count -eq 1) "Missing Node MSI readiness must identify the absent sidecar."
    [System.IO.File]::WriteAllBytes($signedNodeMsiPath, $signedNodeMsiBytes)

    [System.IO.File]::AppendAllText($signedNodeMsiPath, "TAMPERED")
    $tamperedNodeMsiReport = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -ReportOnly
    Assert-True (-not [bool]$tamperedNodeMsiReport.success) "A signed release with a tampered Node MSI sidecar must fail readiness."
    Assert-True (@($tamperedNodeMsiReport.checks | Where-Object { $_.name -eq "node_msi_sha256_matches_signed_metadata" -and -not $_.success }).Count -eq 1) "Tampered Node MSI readiness must identify the signed hash mismatch."
    [System.IO.File]::WriteAllBytes($signedNodeMsiPath, $signedNodeMsiBytes)

    $signedManifestPath = Join-Path $signedReleaseDirectory "manifest.json"
    $signedManifestSignaturePath = Join-Path $signedReleaseDirectory "manifest.sig.json"
    $signedStableChannelPath = Join-Path $signedRoot 'channels\stable.json'
    $signedManifestBytes = [System.IO.File]::ReadAllBytes($signedManifestPath)
    $signedManifestSignatureBytes = [System.IO.File]::ReadAllBytes($signedManifestSignaturePath)
    $pathEscapeManifest = Get-Content -Raw -LiteralPath $signedManifestPath -Encoding UTF8 | ConvertFrom-Json
    if ($pathEscapeManifest.publishedAtUtc -is [DateTime]) {
        $pathEscapeManifest.publishedAtUtc = ([DateTime]$pathEscapeManifest.publishedAtUtc).ToUniversalTime().ToString("o")
    }
    $pathEscapeManifest.externalDependencies.nodeMsi.relativePath = "external\..\node-v24.14.1-x64.msi"
    $pathEscapeManifest | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $signedManifestPath -Encoding UTF8
    $pathEscapeSignature = New-RevAgentDetachedJsonSignature `
        -Content $pathEscapeManifest `
        -SignedObject "release-manifest" `
        -KeyId $keyId `
        -PrivateKeyXml $privateKeyXml `
        -App "revAgent"
    $pathEscapeSignature | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $signedManifestSignaturePath -Encoding UTF8
    $pathEscapeReport = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -ReportOnly
    Assert-True (-not [bool]$pathEscapeReport.success) "A validly signed Node MSI path traversal must fail readiness."
    Assert-True (@($pathEscapeReport.checks | Where-Object { $_.name -eq "node_msi_relative_path" -and -not $_.success }).Count -eq 1) "Path traversal readiness must identify the invalid signed relative path."
    [System.IO.File]::WriteAllBytes($signedManifestPath, $signedManifestBytes)
    [System.IO.File]::WriteAllBytes($signedManifestSignaturePath, $signedManifestSignatureBytes)

    $legacyBaselineManifest = Get-Content -Raw -LiteralPath $signedManifestPath -Encoding UTF8 | ConvertFrom-Json
    if ($legacyBaselineManifest.publishedAtUtc -is [DateTime]) {
        $legacyBaselineManifest.publishedAtUtc = ([DateTime]$legacyBaselineManifest.publishedAtUtc).ToUniversalTime().ToString('o')
    }
    [void]$legacyBaselineManifest.PSObject.Properties.Remove('externalDependencies')
    $legacyBaselineManifest | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $signedManifestPath -Encoding UTF8
    $legacyBaselineSignature = New-RevAgentDetachedJsonSignature `
        -Content $legacyBaselineManifest `
        -SignedObject 'release-manifest' `
        -KeyId $keyId `
        -PrivateKeyXml $privateKeyXml `
        -App 'revAgent'
    $legacyBaselineSignature | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $signedManifestSignaturePath -Encoding UTF8
    Remove-Item -LiteralPath $signedNodeMsiPath -Force
    try {
        $strictLegacyBaselineReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $signedRoot `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestSigningIdentity `
            -ArtifactScanScope activeRelease `
            -ReportOnly
        Assert-True (-not [bool]$strictLegacyBaselineReport.success) 'Strict readiness accepted a newly supplied release without the signed Node MSI contract.'

        $legacyBaselineReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $signedRoot `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestSigningIdentity `
            -AllowLegacyMissingNodeMsi `
            -ArtifactScanScope activeRelease
        Assert-True ([bool]$legacyBaselineReport.success -and [bool]$legacyBaselineReport.nodeMsi.legacyBaselineAccepted) 'Existing signed stable baseline transition did not accept the exact missing-sidecar legacy state.'
        Assert-True (@($legacyBaselineReport.checks | Where-Object { $_.name -like 'node_msi_*' -and -not $_.success }).Count -eq 0) 'Legacy stable baseline transition left a Node MSI readiness check failed.'

        $pilotPolicy = [pscustomobject][ordered]@{
            schemaVersion = 1
            allowedMachineNames = @('DESKTOP-OKNV128', 'NET01')
        }
        $legacyPilotManifest = Get-Content -Raw -LiteralPath $signedManifestPath -Encoding UTF8 | ConvertFrom-Json
        if ($legacyPilotManifest.publishedAtUtc -is [DateTime]) {
            $legacyPilotManifest.publishedAtUtc = ([DateTime]$legacyPilotManifest.publishedAtUtc).ToUniversalTime().ToString('o')
        }
        $legacyPilotManifest.channel = 'pilot'
        $legacyPilotManifest | Add-Member -NotePropertyName pilotPolicy -NotePropertyValue $pilotPolicy -Force
        $legacyPilotManifest | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $signedManifestPath -Encoding UTF8
        $legacyPilotManifestSignature = New-RevAgentDetachedJsonSignature `
            -Content $legacyPilotManifest `
            -SignedObject 'release-manifest' `
            -KeyId $keyId `
            -PrivateKeyXml $privateKeyXml `
            -App 'revAgent'
        $legacyPilotManifestSignature | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $signedManifestSignaturePath -Encoding UTF8

        $legacyPilotChannel = Get-Content -Raw -LiteralPath $signedStableChannelPath -Encoding UTF8 | ConvertFrom-Json
        if ($legacyPilotChannel.publishedAtUtc -is [DateTime]) {
            $legacyPilotChannel.publishedAtUtc = ([DateTime]$legacyPilotChannel.publishedAtUtc).ToUniversalTime().ToString('o')
        }
        $legacyPilotChannel.channel = 'pilot'
        $legacyPilotChannel | Add-Member -NotePropertyName pilotPolicy -NotePropertyValue $pilotPolicy -Force
        $legacyPilotChannelPath = Join-Path $signedRoot 'channels\pilot.json'
        $legacyPilotChannelSignaturePath = Join-Path $signedRoot 'channels\pilot.sig.json'
        $legacyPilotChannel | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $legacyPilotChannelPath -Encoding UTF8
        $legacyPilotChannelSignature = New-RevAgentDetachedJsonSignature `
            -Content $legacyPilotChannel `
            -SignedObject 'channel' `
            -KeyId $keyId `
            -PrivateKeyXml $privateKeyXml `
            -App 'revAgent'
        $legacyPilotChannelSignature | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $legacyPilotChannelSignaturePath -Encoding UTF8

        $strictLegacyPilotReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $signedRoot `
            -ChannelManifestPath $legacyPilotChannelPath `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestSigningIdentity `
            -ArtifactScanScope activeRelease `
            -ReportOnly
        Assert-True (-not [bool]$strictLegacyPilotReport.success) 'Strict readiness accepted a sidecar-less signed pilot candidate.'

        $legacyPilotReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $signedRoot `
            -ChannelManifestPath $legacyPilotChannelPath `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestSigningIdentity `
            -AllowLegacyMissingNodeMsi `
            -ArtifactScanScope activeRelease
        Assert-True ([bool]$legacyPilotReport.success -and [bool]$legacyPilotReport.nodeMsi.legacyBaselineAccepted) 'Existing signed pilot baseline transition did not accept the exact canonical active-channel state.'

        $nonCanonicalPilotPath = Join-Path $signedRoot 'channels\pilot-candidate.json'
        $nonCanonicalPilotSignaturePath = Join-Path $signedRoot 'channels\pilot-candidate.sig.json'
        Copy-Item -LiteralPath $legacyPilotChannelPath -Destination $nonCanonicalPilotPath -Force
        Copy-Item -LiteralPath $legacyPilotChannelSignaturePath -Destination $nonCanonicalPilotSignaturePath -Force
        $nonCanonicalRejected = $false
        try {
            & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
                -ReleaseRoot $signedRoot `
                -ChannelManifestPath $nonCanonicalPilotPath `
                -TrustedKeysPath $trustedKeysPath `
                -RepoRoot $RepoRoot `
                -AllowTestSigningIdentity `
                -AllowLegacyMissingNodeMsi `
                -ArtifactScanScope activeRelease | Out-Null
        }
        catch { $nonCanonicalRejected = $_.Exception.Message -match 'exact existing signed stable/pilot active-channel baseline' }
        Assert-True $nonCanonicalRejected 'Legacy pilot allowance accepted a noncanonical candidate channel path.'

        $releaseRootScopeRejected = $false
        try {
            & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
                -ReleaseRoot $signedRoot `
                -ChannelManifestPath $legacyPilotChannelPath `
                -TrustedKeysPath $trustedKeysPath `
                -RepoRoot $RepoRoot `
                -AllowTestSigningIdentity `
                -AllowLegacyMissingNodeMsi `
                -ArtifactScanScope releaseRoot | Out-Null
        }
        catch { $releaseRootScopeRejected = $_.Exception.Message -match 'exact existing signed stable/pilot active-channel baseline' }
        Assert-True $releaseRootScopeRejected 'Legacy pilot allowance accepted a releaseRoot scan instead of the exact active release.'

        $tamperedLegacyPilotManifest = Get-Content -Raw -LiteralPath $signedManifestPath -Encoding UTF8 | ConvertFrom-Json
        $tamperedLegacyPilotManifest.version = 'tampered-legacy-pilot'
        $tamperedLegacyPilotManifest | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $signedManifestPath -Encoding UTF8
        $tamperedLegacyPilotReport = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $signedRoot `
            -ChannelManifestPath $legacyPilotChannelPath `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestSigningIdentity `
            -AllowLegacyMissingNodeMsi `
            -ArtifactScanScope activeRelease `
            -ReportOnly
        Assert-True (-not [bool]$tamperedLegacyPilotReport.success) 'Legacy pilot allowance bypassed signed manifest integrity.'
    }
    finally {
        [System.IO.File]::WriteAllBytes($signedManifestPath, $signedManifestBytes)
        [System.IO.File]::WriteAllBytes($signedManifestSignaturePath, $signedManifestSignatureBytes)
        [System.IO.File]::WriteAllBytes($signedNodeMsiPath, $signedNodeMsiBytes)
        foreach ($temporaryPilotPath in @(
                (Join-Path $signedRoot 'channels\pilot.json'),
                (Join-Path $signedRoot 'channels\pilot.sig.json'),
                (Join-Path $signedRoot 'channels\pilot-candidate.json'),
                (Join-Path $signedRoot 'channels\pilot-candidate.sig.json')
            )) {
            if (Test-Path -LiteralPath $temporaryPilotPath) { Remove-Item -LiteralPath $temporaryPilotPath -Force }
        }
    }

    & (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1") `
        -ReleaseRoot $unsignedRoot `
        -Version $unsignedVersion `
        -AllowDirty `
        -Force `
        -ReleaseSequence $releaseSequence `
        -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence | Out-Null
    $unsignedReport = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $unsignedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -ReportOnly
    Assert-True (-not [bool]$unsignedReport.success) "Unsigned stable release must not be ready for fail-closed enforcement."
    Assert-True (@($unsignedReport.checks | Where-Object { $_.name -eq "channel_signature_present" -and -not $_.success }).Count -eq 1) "Unsigned stable report should identify the missing channel signature."

    $leakedKeyPath = Join-Path $signedRoot "tools\release-signing-private.xml"
    Copy-Item -LiteralPath $privateKeyPath -Destination $leakedKeyPath -Force
    $privateMaterialReport = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -ReportOnly
    Assert-True (-not [bool]$privateMaterialReport.success) "Release root with private signing material must not be ready."
    Assert-True (@($privateMaterialReport.privateMaterialFindings).Count -gt 0) "Private signing material finding should be reported."
    Remove-Item -LiteralPath $leakedKeyPath -Force

    $leakedSourcePath = Join-Path $signedRoot (Join-Path "releases" (Join-Path $signedVersion "leaked-source.ts"))
    "export const leaked = true;" | Set-Content -LiteralPath $leakedSourcePath -Encoding UTF8
    $artifactReport = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -ReportOnly
    Assert-True (-not [bool]$artifactReport.success) "Release root with source artifacts must not be ready."
    Assert-True (@($artifactReport.artifactFindings).Count -gt 0) "Source/developer artifact findings should be reported."
    Assert-True (@($artifactReport.checks | Where-Object { $_.name -eq "no_source_or_developer_artifacts_in_release_root" -and -not $_.success }).Count -eq 1) "Artifact hygiene check should be present and failed."
    Remove-Item -LiteralPath $leakedSourcePath -Force

    $legacyReleaseDir = Join-Path $signedRoot "releases\2026.05.01.legacy"
    New-Item -ItemType Directory -Path $legacyReleaseDir -Force | Out-Null
    $legacySourcePath = Join-Path $legacyReleaseDir "legacy-source.ts"
    "export const legacy = true;" | Set-Content -LiteralPath $legacySourcePath -Encoding UTF8
    $fullRootArtifactReport = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -ReportOnly
    Assert-True (-not [bool]$fullRootArtifactReport.success) "Full release-root scan should still report historical source artifacts."

    $activeReleaseReport = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -AllowTestSigningIdentity `
        -ArtifactScanScope activeRelease
    Assert-True ([bool]$activeReleaseReport.success) "Active release scan should ignore historical legacy release artifacts."
    Assert-Equal ([string]$activeReleaseReport.artifactScanScope) "activeRelease" "Readiness report should identify active release artifact scan scope."
    Remove-Item -LiteralPath $legacyReleaseDir -Recurse -Force

    $scriptText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1")
    Assert-True ($scriptText -match 'Test-RevAgentReleaseDistributionIntegrity' -and $scriptText -match '-Policy "enforce"') "Readiness preflight must use the shared enforce-mode verifier."
    Assert-True ($scriptText -match 'no_private_signing_material_in_release_root') "Readiness preflight must include private signing material checks."
    Assert-True ($scriptText -match 'no_source_or_developer_artifacts_in_release_root') "Readiness preflight must include source/developer artifact checks."
    Assert-True ($scriptText -match 'node_msi_signed_metadata_present' -and $scriptText -match 'node_msi_sha256_matches_signed_metadata' -and $scriptText -match 'node_msi_authenticode_valid') "Readiness preflight must enforce the signed Node MSI sidecar contract."
    Assert-True ($scriptText -match '\[switch\]\$RequirePublishedSurface' -and $scriptText -match '\$canonicalPublishedSurface' -and $scriptText -match '\$publishedSurfaceRequired\s*=\s*\[bool\]\$RequirePublishedSurface\s*-or\s*\(\$canonicalPublishedSurface' -and $scriptText -match 'published_surface_trusted_key_identity' -and $scriptText -match 'published_surface_no_unmanaged_cmd_entry_points') 'Readiness preflight must auto-require the exact published surface on the canonical production root while preserving explicit fixture coverage.'
    Assert-True ($scriptText -match 'SkipPublishedSurface is limited to the authenticated existing-channel baseline repair path') 'Published-surface bypass must remain limited to the internal authenticated stable-baseline repair path.'
    Assert-True ($scriptText -match 'ReadinessManagedLeafGuard' -and $scriptText -match 'FILE_FLAG_OPEN_REPARSE_POINT' -and $scriptText -match 'managed_leaf_hardlink' -and $scriptText -match 'ManagedPublishedLeafAfterOpenTestHook') 'Published managed leaves must use the no-reparse exact single-link held-handle verifier with deterministic race coverage.'
}
finally {
    $rsa.Dispose()
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Signed stable readiness tests passed." -ForegroundColor Green
