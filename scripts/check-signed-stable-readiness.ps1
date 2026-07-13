<#
.SYNOPSIS
    Check whether a revAgent stable channel is ready for signed fail-closed rollout.

.DESCRIPTION
    This preflight is read-only. It verifies the stable channel and release
    manifest with the existing distribution-integrity helper in enforce mode,
    checks package hash consistency, requires positive releaseSequence metadata,
    and scans the release root for obvious private signing material.

    It does not publish to NAS, generate keys, modify updater config, or enable
    enforcement.
#>

[CmdletBinding()]
param(
    [string]$ReleaseRoot = "",
    [string]$ChannelManifestPath = "",
    [string]$TrustedKeysPath = "",
    [long]$HighestAcceptedReleaseSequence = 0,
    [switch]$AllowRollback,
    [switch]$ReportOnly,
    [switch]$OutputJson,
    [ValidateSet("releaseRoot", "activeRelease")]
    [string]$ArtifactScanScope = "releaseRoot",
    [Parameter(DontShow = $true)]
    [switch]$AllowTestSigningIdentity,
    [Parameter(DontShow = $true)]
    [switch]$AllowLegacyMissingNodeMsi,
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$integrityModule = Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1") -Force -PassThru
$integrityCommand = $integrityModule.ExportedCommands['Test-RevAgentReleaseDistributionIntegrity']
if ($null -eq $integrityCommand) {
    throw 'Pinned distribution-integrity module did not export Test-RevAgentReleaseDistributionIntegrity.'
}
$publicKeyFingerprintCommand = $integrityModule.ExportedCommands['Get-RevAgentPublicKeyFingerprint']
if ($null -eq $publicKeyFingerprintCommand) {
    throw 'Pinned distribution-integrity module did not export Get-RevAgentPublicKeyFingerprint.'
}

$productionSigningKeyId = 'revagent-prod-rsa-2026q3'
$productionSigningFingerprint = '32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33'
$nodeMsiRelativePath = 'external\node-v24.14.1-x64.msi'
$nodeMsiSha256 = 'FD8BA3E8262738959CAD50E6F6E71D689EAB7DD09FC7231B51D78ABE7852D4EC'
$nodeMsiSizeBytes = [long]32387072
$nodeMsiSignerSubject = 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'

function Read-RevAgentJsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    return Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
}

function Resolve-RevAgentReleasePath {
    param(
        [string]$Path,
        [string]$BaseDirectory
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $BaseDirectory $Path))
}

function Add-RevAgentReadinessCheck {
    param(
        [System.Collections.Generic.List[object]]$Checks,
        [string]$Name,
        [bool]$Success,
        [string]$Message,
        [string]$Path = "",
        [string]$Reason = ""
    )

    $Checks.Add([pscustomobject][ordered]@{
            name = $Name
            success = $Success
            reason = $Reason
            message = $Message
            path = $Path
        }) | Out-Null
}

function Read-RevAgentTrustedKeys {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Trusted release key file was not found: $Path"
    }

    $document = Read-RevAgentJsonFile -Path $Path
    $property = $document.PSObject.Properties["trustedKeys"]
    if ($property) {
        return $property.Value
    }
    return $document
}

function Find-RevAgentPrivateSigningMaterial {
    param([string]$Root)

    if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) {
        return @()
    }

    $findings = [System.Collections.Generic.List[object]]::new()
    $namePattern = '(?i)(private.*key|signing.*private|release.*private|\.pfx$|\.p12$|\.pem$|\.key$)'
    $textExtensions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($extension in @(".json", ".xml", ".pem", ".key", ".txt", ".md", ".ps1", ".psm1", ".cmd", ".vbs", ".config")) {
        [void]$textExtensions.Add($extension)
    }

    Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
        if ($_.Name -match $namePattern) {
            $findings.Add([object]([pscustomobject][ordered]@{
                    path = $_.FullName
                    reason = "suspicious_private_key_filename"
                })) | Out-Null
            return
        }

        if (-not $textExtensions.Contains($_.Extension)) {
            return
        }

        try {
            $content = Get-Content -Raw -LiteralPath $_.FullName -Encoding UTF8 -ErrorAction Stop
            if ($content -match '-----BEGIN [A-Z ]*PRIVATE KEY-----' -or
                ($content -match '<RSAKeyValue>' -and $content -match '<P>' -and $content -match '<Q>' -and $content -match '<D>')) {
                $findings.Add([object]([pscustomobject][ordered]@{
                        path = $_.FullName
                        reason = "private_key_content"
                    })) | Out-Null
            }
        }
        catch {
            return
        }
    }

    return @($findings.ToArray())
}

function New-RevAgentReleaseArtifactFinding {
    param(
        [string]$Path,
        [string]$Reason,
        [string]$Container = ""
    )

    return [pscustomobject][ordered]@{
        path = $Path
        reason = $Reason
        container = $Container
    }
}

function Get-RevAgentForbiddenReleaseArtifactReason {
    param(
        [string]$RelativePath,
        [switch]$InsideUserPackage
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        return ""
    }

    $normalized = $RelativePath.Replace("/", "\").TrimStart("\")
    $parts = @($normalized -split '[\\/]+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($parts.Count -eq 0) {
        return ""
    }

    $leaf = [string]$parts[$parts.Count - 1]
    $extension = [System.IO.Path]::GetExtension($leaf).ToLowerInvariant()
    if ($extension -in @(".cs", ".csproj", ".sln", ".ts", ".tsx", ".pdb", ".mdb", ".map")) {
        return "source_or_debug_artifact"
    }

    if ($leaf -match '(?i)(private.*key|signing.*private|release.*private|license.*private|seat.*secret|license.*secret|\.pfx$|\.p12$|\.pem$|\.key$)') {
        return "secret_or_private_key_artifact_name"
    }

    if ($leaf -match '(?i)(^tsconfig(\..*)?\.json$|^\.eslintrc|^eslint\.config\.|^vite\.config\.|^vitest\.config\.|^rollup\.config\.|^webpack\.config\.|^jest\.config\.|^revit-payload-manifest\.json$)') {
        return "developer_manifest_artifact"
    }

    if ($leaf -match '(?i)(\.test\.js$|\.guard-test\.js$)') {
        return "developer_test_artifact"
    }

    if ($InsideUserPackage -and $leaf -in @("publish-nas-release.ps1", "promote-nas-release.ps1")) {
        return "developer_publish_tool_in_user_package"
    }

    $isAdminAddonToolsPath = $parts.Count -ge 2 -and
        [string]::Equals([string]$parts[0], "tools", [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$parts[1], "addons", [System.StringComparison]::OrdinalIgnoreCase)

    $blockedDirectoryNames = @(".git", ".github", ".githooks", ".tmp", "src", "docs", "evals", "references", "dashboard", "addons")
    $directoryParts = @()
    if ($parts.Count -gt 1) {
        $directoryParts = @($parts[0..($parts.Count - 2)])
    }
    foreach ($part in $directoryParts) {
        $allowedAdminAddonPart = $isAdminAddonToolsPath -and (
            [string]::Equals($part, "addons", [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($part, "dashboard", [System.StringComparison]::OrdinalIgnoreCase)
        )
        if ($part -in $blockedDirectoryNames -and -not $allowedAdminAddonPart) {
            return "developer_directory_artifact"
        }
    }

    if ($InsideUserPackage -and $parts.Count -gt 1 -and [string]::Equals([string]$parts[0], "scripts", [System.StringComparison]::OrdinalIgnoreCase)) {
        return "root_scripts_directory_in_user_package"
    }

    return ""
}

function Test-RevAgentPathUnderRoot {
    param(
        [string]$Path,
        [string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/")
    $rootFullPath = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    return [string]::Equals($fullPath, $rootFullPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($rootFullPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Find-RevAgentReleaseArtifactFindings {
    param(
        [string]$Root,
        [string[]]$ScanPaths = @()
    )

    if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) {
        return @()
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $rootFullName = (Get-Item -LiteralPath $Root).FullName.TrimEnd("\", "/")
    $rootPrefix = $rootFullName + [System.IO.Path]::DirectorySeparatorChar
    $findings = [System.Collections.Generic.List[object]]::new()
    $filesToScan = [System.Collections.Generic.List[object]]::new()

    if ($ScanPaths -and $ScanPaths.Count -gt 0) {
        foreach ($scanPath in $ScanPaths) {
            if ([string]::IsNullOrWhiteSpace($scanPath) -or -not (Test-RevAgentPathUnderRoot -Path $scanPath -Root $rootFullName)) {
                continue
            }
            if (Test-Path -LiteralPath $scanPath -PathType Container) {
                Get-ChildItem -LiteralPath $scanPath -Recurse -File -Force | ForEach-Object {
                    $filesToScan.Add([object]$_) | Out-Null
                }
            }
            elseif (Test-Path -LiteralPath $scanPath -PathType Leaf) {
                $filesToScan.Add([object](Get-Item -LiteralPath $scanPath)) | Out-Null
            }
        }
    }
    else {
        Get-ChildItem -LiteralPath $rootFullName -Recurse -File -Force | ForEach-Object {
            $filesToScan.Add([object]$_) | Out-Null
        }
    }

    $filesToScan.ToArray() | ForEach-Object {
        $relative = $_.FullName.Substring($rootPrefix.Length).Replace("/", "\")
        $reason = Get-RevAgentForbiddenReleaseArtifactReason -RelativePath $relative
        if (-not [string]::IsNullOrWhiteSpace($reason)) {
            $findings.Add([object](New-RevAgentReleaseArtifactFinding -Path $relative -Reason $reason)) | Out-Null
        }

        if (-not [string]::Equals($_.Extension, ".zip", [System.StringComparison]::OrdinalIgnoreCase)) {
            return
        }

        try {
            $archive = [System.IO.Compression.ZipFile]::OpenRead($_.FullName)
            try {
                foreach ($entry in $archive.Entries) {
                    if ([string]::IsNullOrWhiteSpace($entry.Name)) {
                        continue
                    }

                    $entryPath = $entry.FullName.Replace("/", "\")
                    $entryReason = Get-RevAgentForbiddenReleaseArtifactReason -RelativePath $entryPath -InsideUserPackage
                    if (-not [string]::IsNullOrWhiteSpace($entryReason)) {
                        $findings.Add([object](New-RevAgentReleaseArtifactFinding -Path ("{0}!{1}" -f $relative, $entryPath) -Reason $entryReason -Container $relative)) | Out-Null
                    }
                }
            }
            finally {
                $archive.Dispose()
            }
        }
        catch {
            $findings.Add([object](New-RevAgentReleaseArtifactFinding -Path $relative -Reason "zip_read_failed")) | Out-Null
        }
    }

    return @($findings.ToArray())
}

if ([string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
    if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
        throw "Pass -ReleaseRoot or -ChannelManifestPath."
    }
    $ChannelManifestPath = Join-Path $ReleaseRoot "channels\stable.json"
}

$ChannelManifestPath = [System.IO.Path]::GetFullPath($ChannelManifestPath)
$channelDir = Split-Path -Parent $ChannelManifestPath
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Split-Path -Parent $channelDir
}
$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)

if ($AllowTestSigningIdentity) {
    $temporaryRootPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
    if ($ReleaseRoot.StartsWith("\\", [System.StringComparison]::Ordinal) -or
        -not $ReleaseRoot.StartsWith($temporaryRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'AllowTestSigningIdentity is limited to disposable local release roots below TEMP.'
    }
}

$checks = [System.Collections.Generic.List[object]]::new()

Add-RevAgentReadinessCheck -Checks $checks -Name "channel_manifest_present" -Success (Test-Path -LiteralPath $ChannelManifestPath -PathType Leaf) -Message "Stable channel manifest must exist." -Path $ChannelManifestPath
if (-not (Test-Path -LiteralPath $ChannelManifestPath -PathType Leaf)) {
    $report = [pscustomobject][ordered]@{
        success = $false
        readyForEnforce = $false
        reason = "channel_manifest_missing"
        releaseRoot = $ReleaseRoot
        channelManifestPath = $ChannelManifestPath
        checks = @($checks.ToArray())
    }
    if ($OutputJson) { $report | ConvertTo-Json -Depth 12 } else { $report }
    if (-not $ReportOnly) { throw "Signed stable readiness failed: channel manifest was not found." }
    return
}

$channel = Read-RevAgentJsonFile -Path $ChannelManifestPath
$releaseManifestPath = Resolve-RevAgentReleasePath -Path ([string]$channel.manifestPath) -BaseDirectory $channelDir
$packagePath = Resolve-RevAgentReleasePath -Path ([string]$channel.packagePath) -BaseDirectory $channelDir
$channelSignaturePath = Get-RevAgentDetachedSignaturePath -ContentPath $ChannelManifestPath
$releaseManifestSignaturePath = if ([string]::IsNullOrWhiteSpace($releaseManifestPath)) { "" } else { Get-RevAgentDetachedSignaturePath -ContentPath $releaseManifestPath }

Add-RevAgentReadinessCheck -Checks $checks -Name "release_manifest_present" -Success (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf) -Message "Release manifest must exist." -Path $releaseManifestPath
Add-RevAgentReadinessCheck -Checks $checks -Name "channel_signature_present" -Success (Test-Path -LiteralPath $channelSignaturePath -PathType Leaf) -Message "Stable channel detached signature must exist." -Path $channelSignaturePath
Add-RevAgentReadinessCheck -Checks $checks -Name "release_manifest_signature_present" -Success (Test-Path -LiteralPath $releaseManifestSignaturePath -PathType Leaf) -Message "Release manifest detached signature must exist." -Path $releaseManifestSignaturePath
Add-RevAgentReadinessCheck -Checks $checks -Name "package_present" -Success (Test-Path -LiteralPath $packagePath -PathType Leaf) -Message "Release ZIP must exist." -Path $packagePath

$trustedKeys = Read-RevAgentTrustedKeys -Path $TrustedKeysPath
$trustedKeyMap = ConvertTo-RevAgentTrustedKeyMap -TrustedKeys $trustedKeys
Add-RevAgentReadinessCheck -Checks $checks -Name "trusted_release_keys_present" -Success ($trustedKeyMap.Count -gt 0) -Message "At least one trusted public release key must be supplied." -Path $TrustedKeysPath

if ($AllowTestSigningIdentity) {
    $productionIdentityPresent = $trustedKeyMap.ContainsKey($productionSigningKeyId)
    foreach ($trustedKey in @($trustedKeyMap.Values)) {
        if ($productionIdentityPresent -or $null -eq $trustedKey) { continue }
        try {
            $computedFingerprint = & $publicKeyFingerprintCommand -PublicKeyXml ([string]$trustedKey.publicKeyXml)
            if ([string]::Equals([string]$computedFingerprint, $productionSigningFingerprint, [System.StringComparison]::OrdinalIgnoreCase)) {
                $productionIdentityPresent = $true
            }
        }
        catch {
            # Signature verification below remains authoritative for malformed
            # test keys. This branch only prevents the production key from ever
            # entering the test-only external-dependency path.
        }
    }
    if ($productionIdentityPresent) {
        throw 'AllowTestSigningIdentity cannot be used with the production signing identity.'
    }
}

$releaseManifest = $null
if (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf) {
    $releaseManifest = Read-RevAgentJsonFile -Path $releaseManifestPath
}

$integrity = & $integrityCommand `
    -ChannelPath $ChannelManifestPath `
    -Channel $channel `
    -ReleaseManifestPath $releaseManifestPath `
    -ReleaseManifest $releaseManifest `
    -TrustedKeys $trustedKeyMap `
    -Policy "enforce" `
    -HighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence `
    -AllowRollback:$AllowRollback
Add-RevAgentReadinessCheck -Checks $checks -Name "enforce_mode_signature_verification" -Success ([bool]$integrity.success) -Reason ([string]$integrity.reason) -Message ([string]$integrity.message)

$releaseSequenceOk = $false
try {
    $releaseSequenceOk = ([long]$channel.releaseSequence -gt 0 -and [long]$releaseManifest.releaseSequence -eq [long]$channel.releaseSequence)
}
catch {
    $releaseSequenceOk = $false
}
Add-RevAgentReadinessCheck -Checks $checks -Name "positive_release_sequence" -Success $releaseSequenceOk -Message "Signed stable rollout requires matching positive releaseSequence in channel and release manifest."

$packageHashOk = $false
if (Test-Path -LiteralPath $packagePath -PathType Leaf) {
    $actualHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash
    $channelHash = [string]$channel.sha256
    $manifestHash = ""
    if ($releaseManifest -and $releaseManifest.package) {
        $manifestHash = [string]$releaseManifest.package.sha256
    }
    $packageHashOk = [string]::Equals($actualHash, $channelHash, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($actualHash, $manifestHash, [System.StringComparison]::OrdinalIgnoreCase)
}
Add-RevAgentReadinessCheck -Checks $checks -Name "package_sha256_matches_signed_metadata" -Success $packageHashOk -Message "Release ZIP SHA256 must match channel.sha256 and manifest.package.sha256." -Path $packagePath

$nodeMsiMetadata = $null
if ($null -ne $releaseManifest -and $releaseManifest.PSObject.Properties['externalDependencies']) {
    $externalDependencies = $releaseManifest.externalDependencies
    if ($null -ne $externalDependencies -and $externalDependencies.PSObject.Properties['nodeMsi']) {
        $nodeMsiMetadata = $externalDependencies.nodeMsi
    }
}
$nodeMsiMetadataPresent = $null -ne $nodeMsiMetadata
$legacyNodeMsiChannel = ([string]$channel.channel).Trim().ToLowerInvariant()
$legacyNodeMsiChannelAllowed = $legacyNodeMsiChannel -in @('stable', 'pilot')
$legacyNodeMsiCanonicalChannelPath = if ($legacyNodeMsiChannelAllowed) {
    [System.IO.Path]::GetFullPath((Join-Path $ReleaseRoot ("channels\{0}.json" -f $legacyNodeMsiChannel)))
}
else { '' }
$legacyNodeMsiActiveBaselineContext =
    [string]::Equals($ArtifactScanScope, 'activeRelease', [System.StringComparison]::Ordinal) -and
    $legacyNodeMsiChannelAllowed -and
    [string]::Equals($ChannelManifestPath, $legacyNodeMsiCanonicalChannelPath, [System.StringComparison]::OrdinalIgnoreCase)
if ($AllowLegacyMissingNodeMsi -and -not $legacyNodeMsiActiveBaselineContext) {
    throw 'AllowLegacyMissingNodeMsi is limited to an exact existing signed stable/pilot active-channel baseline.'
}
$legacyNodeMsiBaselineAccepted = $AllowLegacyMissingNodeMsi -and $legacyNodeMsiActiveBaselineContext -and -not $nodeMsiMetadataPresent
$legacyNodeReason = if ($legacyNodeMsiBaselineAccepted) { 'legacy_signed_active_channel_baseline_without_node_sidecar' } else { '' }
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_signed_metadata_present" -Success ($nodeMsiMetadataPresent -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiMetadataPresent) { "" } else { "node_msi_metadata_missing" }) -Message "New signed releases must contain externalDependencies.nodeMsi; only an exact already-active signed stable/pilot baseline may omit it during transition."

$nodeMsiSchemaOk = $false
$nodeMsiRelativePathValue = ""
$nodeMsiSha256Value = ""
$nodeMsiSizeValue = [long]0
$nodeMsiSizeParsed = $false
$nodeMsiSignerValue = ""
$nodeMsiSignedAuthenticodeStatus = ""
if ($nodeMsiMetadataPresent) {
    try { $nodeMsiSchemaOk = [int]$nodeMsiMetadata.schemaVersion -eq 1 } catch { $nodeMsiSchemaOk = $false }
    $nodeMsiRelativePathValue = [string]$nodeMsiMetadata.relativePath
    $nodeMsiSha256Value = ([string]$nodeMsiMetadata.sha256).Trim().ToUpperInvariant()
    $nodeMsiSizeParsed = [long]::TryParse([string]$nodeMsiMetadata.sizeBytes, [ref]$nodeMsiSizeValue)
    $nodeMsiSignerValue = [string]$nodeMsiMetadata.signerSubject
    $nodeMsiSignedAuthenticodeStatus = [string]$nodeMsiMetadata.authenticodeStatus
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_schema_version" -Success ($nodeMsiSchemaOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiSchemaOk) { "" } else { "node_msi_schema_invalid" }) -Message "externalDependencies.nodeMsi.schemaVersion must equal 1."

$nodeMsiRelativeSyntaxOk = $nodeMsiMetadataPresent -and
    -not [string]::IsNullOrWhiteSpace($nodeMsiRelativePathValue) -and
    -not [System.IO.Path]::IsPathRooted($nodeMsiRelativePathValue) -and
    $nodeMsiRelativePathValue.IndexOf(':') -lt 0 -and
    $nodeMsiRelativePathValue -notmatch '(^|[\\/])\.\.?([\\/]|$)' -and
    [string]::Equals($nodeMsiRelativePathValue, $nodeMsiRelativePath, [System.StringComparison]::Ordinal)
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_relative_path" -Success ($nodeMsiRelativeSyntaxOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiRelativeSyntaxOk) { "" } else { "node_msi_relative_path_invalid" }) -Message "Node.js MSI relativePath must be the exact release-owned relative path '$nodeMsiRelativePath'."

$nodeMsiShaMetadataOk = if ($AllowTestSigningIdentity) {
    $nodeMsiSha256Value -match '^[A-F0-9]{64}$'
}
else {
    [string]::Equals($nodeMsiSha256Value, $nodeMsiSha256, [System.StringComparison]::Ordinal)
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_sha256_metadata" -Success ($nodeMsiShaMetadataOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiShaMetadataOk) { "" } else { "node_msi_sha256_metadata_invalid" }) -Message $(if ($AllowTestSigningIdentity) { "Test Node.js MSI metadata must contain one SHA-256 value." } else { "Production Node.js MSI metadata must contain the pinned SHA-256." })

$nodeMsiSizeMetadataOk = if ($AllowTestSigningIdentity) {
    $nodeMsiSizeParsed -and $nodeMsiSizeValue -gt 0 -and $nodeMsiSizeValue -le 268435456
}
else {
    $nodeMsiSizeParsed -and $nodeMsiSizeValue -eq $nodeMsiSizeBytes
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_size_metadata" -Success ($nodeMsiSizeMetadataOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiSizeMetadataOk) { "" } else { "node_msi_size_metadata_invalid" }) -Message $(if ($AllowTestSigningIdentity) { "Test Node.js MSI metadata must contain one bounded positive size." } else { "Production Node.js MSI metadata must contain the pinned sizeBytes value." })

$nodeMsiSignerMetadataOk = if ($AllowTestSigningIdentity) {
    -not [string]::IsNullOrWhiteSpace($nodeMsiSignerValue)
}
else {
    [string]::Equals($nodeMsiSignerValue, $nodeMsiSignerSubject, [System.StringComparison]::Ordinal)
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_signer_metadata" -Success ($nodeMsiSignerMetadataOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiSignerMetadataOk) { "" } else { "node_msi_signer_metadata_invalid" }) -Message $(if ($AllowTestSigningIdentity) { "Test Node.js MSI metadata must identify its fixture signer." } else { "Production Node.js MSI metadata must identify the pinned OpenJS signer subject." })

$nodeMsiAuthenticodeMetadataOk = if ($AllowTestSigningIdentity) {
    [string]::Equals($nodeMsiSignedAuthenticodeStatus, 'TestBypass', [System.StringComparison]::Ordinal)
}
else {
    [string]::Equals($nodeMsiSignedAuthenticodeStatus, 'Valid', [System.StringComparison]::Ordinal)
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_authenticode_metadata" -Success ($nodeMsiAuthenticodeMetadataOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiAuthenticodeMetadataOk) { "" } else { "node_msi_authenticode_metadata_invalid" }) -Message $(if ($AllowTestSigningIdentity) { "Test Node.js MSI metadata must explicitly state TestBypass." } else { "Production Node.js MSI metadata must explicitly state Valid Authenticode status." })

$releaseDirectory = if ([string]::IsNullOrWhiteSpace($releaseManifestPath)) { "" } else { [System.IO.Path]::GetFullPath((Split-Path -Parent $releaseManifestPath)) }
$releaseVersion = [string]$channel.version
$expectedReleaseDirectory = ""
$releaseDirectoryOk = $false
if (-not [string]::IsNullOrWhiteSpace($releaseVersion) -and
    $releaseVersion.IndexOfAny([char[]]@('\', '/', ':')) -lt 0) {
    try {
        $expectedReleaseDirectory = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $ReleaseRoot 'releases') $releaseVersion))
        $releaseDirectoryOk = -not [string]::IsNullOrWhiteSpace($releaseDirectory) -and
            (Test-RevAgentPathUnderRoot -Path $releaseDirectory -Root $ReleaseRoot) -and
            [string]::Equals($releaseDirectory, $expectedReleaseDirectory, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch { $releaseDirectoryOk = $false }
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_release_directory" -Success $releaseDirectoryOk -Reason $(if ($releaseDirectoryOk) { "" } else { "node_msi_release_directory_invalid" }) -Message "The signed manifest and Node.js MSI must be rooted in the exact versioned release directory." -Path $releaseDirectory

$nodeMsiPath = ""
$nodeMsiPathOk = $false
if ($releaseDirectoryOk -and $nodeMsiRelativeSyntaxOk) {
    try {
        $nodeMsiPath = [System.IO.Path]::GetFullPath((Join-Path $releaseDirectory $nodeMsiRelativePathValue))
        $expectedNodeMsiPath = [System.IO.Path]::GetFullPath((Join-Path $expectedReleaseDirectory $nodeMsiRelativePath))
        $nodeMsiPathOk = (Test-RevAgentPathUnderRoot -Path $nodeMsiPath -Root $releaseDirectory) -and
            [string]::Equals($nodeMsiPath, $expectedNodeMsiPath, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch { $nodeMsiPathOk = $false }
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_release_path_binding" -Success ($nodeMsiPathOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiPathOk) { "" } else { "node_msi_release_path_binding_invalid" }) -Message "Node.js MSI metadata must resolve to the exact release-owned dependency path." -Path $nodeMsiPath

$nodeMsiFilePresent = $nodeMsiPathOk -and (Test-Path -LiteralPath $nodeMsiPath -PathType Leaf)
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_file_present" -Success ($nodeMsiFilePresent -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiFilePresent) { "" } else { "node_msi_file_missing" }) -Message "The signed Node.js MSI dependency must exist for every new release." -Path $nodeMsiPath

$nodeMsiActualSize = [long]0
$nodeMsiActualSha256 = ""
$nodeMsiActualSizeOk = $false
$nodeMsiActualSha256Ok = $false
$nodeMsiAuthenticodeStatus = "NotChecked"
$nodeMsiActualSignerSubject = ""
$nodeMsiAuthenticodeOk = $false
$nodeMsiAuthenticodeSignerOk = $false
if ($nodeMsiFilePresent) {
    try {
        $nodeMsiActualSize = [long](Get-Item -LiteralPath $nodeMsiPath -Force -ErrorAction Stop).Length
        $nodeMsiActualSizeOk = $nodeMsiSizeMetadataOk -and $nodeMsiActualSize -eq $nodeMsiSizeValue
        $nodeMsiActualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeMsiPath -ErrorAction Stop).Hash.ToUpperInvariant()
        $nodeMsiActualSha256Ok = $nodeMsiShaMetadataOk -and [string]::Equals($nodeMsiActualSha256, $nodeMsiSha256Value, [System.StringComparison]::Ordinal)
        if ($AllowTestSigningIdentity) {
            $nodeMsiAuthenticodeStatus = "TestBypass"
            $nodeMsiActualSignerSubject = $nodeMsiSignerValue
            $nodeMsiAuthenticodeOk = $true
            $nodeMsiAuthenticodeSignerOk = $nodeMsiSignerMetadataOk
        }
        else {
            $nodeMsiSignature = Get-AuthenticodeSignature -LiteralPath $nodeMsiPath
            $nodeMsiAuthenticodeStatus = if ($null -eq $nodeMsiSignature) { "Unavailable" } else { [string]$nodeMsiSignature.Status }
            $nodeMsiActualSignerSubject = if ($null -eq $nodeMsiSignature -or $null -eq $nodeMsiSignature.SignerCertificate) { "" } else { [string]$nodeMsiSignature.SignerCertificate.Subject }
            $nodeMsiAuthenticodeOk = $null -ne $nodeMsiSignature -and $nodeMsiSignature.Status -eq [System.Management.Automation.SignatureStatus]::Valid
            $nodeMsiAuthenticodeSignerOk = $nodeMsiAuthenticodeOk -and [string]::Equals($nodeMsiActualSignerSubject, $nodeMsiSignerSubject, [System.StringComparison]::Ordinal)
        }
    }
    catch {
        $nodeMsiAuthenticodeStatus = "ReadFailed"
    }
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_size_matches_signed_metadata" -Success ($nodeMsiActualSizeOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiActualSizeOk) { "" } else { "node_msi_size_mismatch" }) -Message "Node.js MSI size must match the signed manifest metadata." -Path $nodeMsiPath
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_sha256_matches_signed_metadata" -Success ($nodeMsiActualSha256Ok -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiActualSha256Ok) { "" } else { "node_msi_sha256_mismatch" }) -Message "Node.js MSI SHA-256 must match the signed manifest metadata." -Path $nodeMsiPath
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_authenticode_valid" -Success ($nodeMsiAuthenticodeOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiAuthenticodeOk) { $(if ($AllowTestSigningIdentity) { "test_signing_identity_bypass" } else { "" }) } else { "node_msi_authenticode_invalid" }) -Message $(if ($AllowTestSigningIdentity) { "Authenticode verification is bypassed only for a disposable TEMP test-signing fixture." } else { "Production Node.js MSI must have a valid Authenticode signature." }) -Path $nodeMsiPath
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_authenticode_signer" -Success ($nodeMsiAuthenticodeSignerOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiAuthenticodeSignerOk) { $(if ($AllowTestSigningIdentity) { "test_signing_identity_bypass" } else { "" }) } else { "node_msi_authenticode_signer_mismatch" }) -Message $(if ($AllowTestSigningIdentity) { "Test fixture signer metadata is accepted only for a disposable TEMP test-signing fixture." } else { "Production Node.js MSI Authenticode signer must be the pinned OpenJS subject." }) -Path $nodeMsiPath

$nodeMsiReadiness = [pscustomobject][ordered]@{
    testSigningIdentity = [bool]$AllowTestSigningIdentity
    legacyBaselineAccepted = [bool]$legacyNodeMsiBaselineAccepted
    relativePath = $nodeMsiRelativePathValue
    path = $nodeMsiPath
    signedSha256 = $nodeMsiSha256Value
    actualSha256 = $nodeMsiActualSha256
    signedSizeBytes = $nodeMsiSizeValue
    actualSizeBytes = $nodeMsiActualSize
    signedSignerSubject = $nodeMsiSignerValue
    signedAuthenticodeStatus = $nodeMsiSignedAuthenticodeStatus
    actualSignerSubject = $nodeMsiActualSignerSubject
    authenticodeStatus = $nodeMsiAuthenticodeStatus
}

$privateMaterial = @(Find-RevAgentPrivateSigningMaterial -Root $ReleaseRoot)
Add-RevAgentReadinessCheck -Checks $checks -Name "no_private_signing_material_in_release_root" -Success ($privateMaterial.Count -eq 0) -Reason $(if ($privateMaterial.Count -eq 0) { "" } else { "private_signing_material_detected" }) -Message "Release root must not contain private signing material." -Path $ReleaseRoot

$artifactScanPaths = @()
if ([string]::Equals($ArtifactScanScope, "activeRelease", [System.StringComparison]::OrdinalIgnoreCase)) {
    if (-not [string]::IsNullOrWhiteSpace($releaseManifestPath) -and (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf)) {
        $artifactScanPaths += (Split-Path -Parent $releaseManifestPath)
    }
    $toolsPath = Join-Path $ReleaseRoot "tools"
    if (Test-Path -LiteralPath $toolsPath -PathType Container) {
        $artifactScanPaths += $toolsPath
    }
}
$artifactFindings = @(Find-RevAgentReleaseArtifactFindings -Root $ReleaseRoot -ScanPaths $artifactScanPaths)
$artifactCheckPath = if ($artifactScanPaths.Count -gt 0) { ($artifactScanPaths -join ";") } else { $ReleaseRoot }
Add-RevAgentReadinessCheck -Checks $checks -Name "no_source_or_developer_artifacts_in_release_root" -Success ($artifactFindings.Count -eq 0) -Reason $(if ($artifactFindings.Count -eq 0) { "" } else { "source_or_developer_artifacts_detected" }) -Message "Release root and release ZIP must not contain source, source maps, debug symbols, developer manifests, private key names, or license secret names." -Path $artifactCheckPath

$failedChecks = @($checks.ToArray() | Where-Object { -not [bool]$_.success })
$ready = $failedChecks.Count -eq 0
$report = [pscustomobject][ordered]@{
    success = $ready
    readyForEnforce = $ready
    reason = if ($ready) { "ready" } else { "readiness_checks_failed" }
    releaseRoot = $ReleaseRoot
    channelManifestPath = $ChannelManifestPath
    releaseManifestPath = $releaseManifestPath
    packagePath = $packagePath
    trustedKeysPath = $TrustedKeysPath
    trustedKeyCount = $trustedKeyMap.Count
    releaseSequence = if ($channel.PSObject.Properties["releaseSequence"]) { [long]$channel.releaseSequence } else { 0 }
    minimumAcceptedReleaseSequence = if ($channel.PSObject.Properties["minimumAcceptedReleaseSequence"]) { [long]$channel.minimumAcceptedReleaseSequence } else { 0 }
    integrity = $integrity
    nodeMsi = $nodeMsiReadiness
    privateMaterialFindings = $privateMaterial
    artifactScanScope = $ArtifactScanScope
    artifactScanPaths = @($artifactScanPaths)
    artifactFindings = $artifactFindings
    checks = @($checks.ToArray())
}

if ($OutputJson) {
    $report | ConvertTo-Json -Depth 16
}
else {
    $report
}

if (-not $ready -and -not $ReportOnly) {
    $failedNames = ($failedChecks | ForEach-Object { $_.name }) -join ", "
    throw "Signed stable readiness failed: $failedNames"
}
