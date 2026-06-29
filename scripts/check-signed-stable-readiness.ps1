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
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
Import-Module (Join-Path $RepoRoot "installer\lib\RevitMcp.DistributionIntegrity.psm1") -Force

function Read-RevitMcpJsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    return Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
}

function Resolve-RevitMcpReleasePath {
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

function Add-RevitMcpReadinessCheck {
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

function Read-RevitMcpTrustedKeys {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Trusted release key file was not found: $Path"
    }

    $document = Read-RevitMcpJsonFile -Path $Path
    $property = $document.PSObject.Properties["trustedKeys"]
    if ($property) {
        return $property.Value
    }
    return $document
}

function Find-RevitMcpPrivateSigningMaterial {
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

function New-RevitMcpReleaseArtifactFinding {
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

function Get-RevitMcpForbiddenReleaseArtifactReason {
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

    $blockedDirectoryNames = @(".git", ".github", ".githooks", ".tmp", "src", "docs", "evals", "references", "dashboard", "addons")
    $directoryParts = @()
    if ($parts.Count -gt 1) {
        $directoryParts = @($parts[0..($parts.Count - 2)])
    }
    foreach ($part in $directoryParts) {
        if ($part -in $blockedDirectoryNames) {
            return "developer_directory_artifact"
        }
    }

    if ($InsideUserPackage -and $parts.Count -gt 1 -and [string]::Equals([string]$parts[0], "scripts", [System.StringComparison]::OrdinalIgnoreCase)) {
        return "root_scripts_directory_in_user_package"
    }

    return ""
}

function Test-RevitMcpPathUnderRoot {
    param(
        [string]$Path,
        [string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/")
    $rootFullPath = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    return [string]::Equals($fullPath, $rootFullPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($rootFullPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Find-RevitMcpReleaseArtifactFindings {
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
            if ([string]::IsNullOrWhiteSpace($scanPath) -or -not (Test-RevitMcpPathUnderRoot -Path $scanPath -Root $rootFullName)) {
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
        $reason = Get-RevitMcpForbiddenReleaseArtifactReason -RelativePath $relative
        if (-not [string]::IsNullOrWhiteSpace($reason)) {
            $findings.Add([object](New-RevitMcpReleaseArtifactFinding -Path $relative -Reason $reason)) | Out-Null
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
                    $entryReason = Get-RevitMcpForbiddenReleaseArtifactReason -RelativePath $entryPath -InsideUserPackage
                    if (-not [string]::IsNullOrWhiteSpace($entryReason)) {
                        $findings.Add([object](New-RevitMcpReleaseArtifactFinding -Path ("{0}!{1}" -f $relative, $entryPath) -Reason $entryReason -Container $relative)) | Out-Null
                    }
                }
            }
            finally {
                $archive.Dispose()
            }
        }
        catch {
            $findings.Add([object](New-RevitMcpReleaseArtifactFinding -Path $relative -Reason "zip_read_failed")) | Out-Null
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

$checks = [System.Collections.Generic.List[object]]::new()

Add-RevitMcpReadinessCheck -Checks $checks -Name "channel_manifest_present" -Success (Test-Path -LiteralPath $ChannelManifestPath -PathType Leaf) -Message "Stable channel manifest must exist." -Path $ChannelManifestPath
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

$channel = Read-RevitMcpJsonFile -Path $ChannelManifestPath
$releaseManifestPath = Resolve-RevitMcpReleasePath -Path ([string]$channel.manifestPath) -BaseDirectory $channelDir
$packagePath = Resolve-RevitMcpReleasePath -Path ([string]$channel.packagePath) -BaseDirectory $channelDir
$channelSignaturePath = Get-RevitMcpDetachedSignaturePath -ContentPath $ChannelManifestPath
$releaseManifestSignaturePath = if ([string]::IsNullOrWhiteSpace($releaseManifestPath)) { "" } else { Get-RevitMcpDetachedSignaturePath -ContentPath $releaseManifestPath }

Add-RevitMcpReadinessCheck -Checks $checks -Name "release_manifest_present" -Success (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf) -Message "Release manifest must exist." -Path $releaseManifestPath
Add-RevitMcpReadinessCheck -Checks $checks -Name "channel_signature_present" -Success (Test-Path -LiteralPath $channelSignaturePath -PathType Leaf) -Message "Stable channel detached signature must exist." -Path $channelSignaturePath
Add-RevitMcpReadinessCheck -Checks $checks -Name "release_manifest_signature_present" -Success (Test-Path -LiteralPath $releaseManifestSignaturePath -PathType Leaf) -Message "Release manifest detached signature must exist." -Path $releaseManifestSignaturePath
Add-RevitMcpReadinessCheck -Checks $checks -Name "package_present" -Success (Test-Path -LiteralPath $packagePath -PathType Leaf) -Message "Release ZIP must exist." -Path $packagePath

$trustedKeys = Read-RevitMcpTrustedKeys -Path $TrustedKeysPath
$trustedKeyMap = ConvertTo-RevitMcpTrustedKeyMap -TrustedKeys $trustedKeys
Add-RevitMcpReadinessCheck -Checks $checks -Name "trusted_release_keys_present" -Success ($trustedKeyMap.Count -gt 0) -Message "At least one trusted public release key must be supplied." -Path $TrustedKeysPath

$releaseManifest = $null
if (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf) {
    $releaseManifest = Read-RevitMcpJsonFile -Path $releaseManifestPath
}

$integrity = Test-RevitMcpReleaseDistributionIntegrity `
    -ChannelPath $ChannelManifestPath `
    -Channel $channel `
    -ReleaseManifestPath $releaseManifestPath `
    -ReleaseManifest $releaseManifest `
    -TrustedKeys $trustedKeyMap `
    -Policy "enforce" `
    -HighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence `
    -AllowRollback:$AllowRollback
Add-RevitMcpReadinessCheck -Checks $checks -Name "enforce_mode_signature_verification" -Success ([bool]$integrity.success) -Reason ([string]$integrity.reason) -Message ([string]$integrity.message)

$releaseSequenceOk = $false
try {
    $releaseSequenceOk = ([long]$channel.releaseSequence -gt 0 -and [long]$releaseManifest.releaseSequence -eq [long]$channel.releaseSequence)
}
catch {
    $releaseSequenceOk = $false
}
Add-RevitMcpReadinessCheck -Checks $checks -Name "positive_release_sequence" -Success $releaseSequenceOk -Message "Signed stable rollout requires matching positive releaseSequence in channel and release manifest."

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
Add-RevitMcpReadinessCheck -Checks $checks -Name "package_sha256_matches_signed_metadata" -Success $packageHashOk -Message "Release ZIP SHA256 must match channel.sha256 and manifest.package.sha256." -Path $packagePath

$privateMaterial = @(Find-RevitMcpPrivateSigningMaterial -Root $ReleaseRoot)
Add-RevitMcpReadinessCheck -Checks $checks -Name "no_private_signing_material_in_release_root" -Success ($privateMaterial.Count -eq 0) -Reason $(if ($privateMaterial.Count -eq 0) { "" } else { "private_signing_material_detected" }) -Message "Release root must not contain private signing material." -Path $ReleaseRoot

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
$artifactFindings = @(Find-RevitMcpReleaseArtifactFindings -Root $ReleaseRoot -ScanPaths $artifactScanPaths)
$artifactCheckPath = if ($artifactScanPaths.Count -gt 0) { ($artifactScanPaths -join ";") } else { $ReleaseRoot }
Add-RevitMcpReadinessCheck -Checks $checks -Name "no_source_or_developer_artifacts_in_release_root" -Success ($artifactFindings.Count -eq 0) -Reason $(if ($artifactFindings.Count -eq 0) { "" } else { "source_or_developer_artifacts_detected" }) -Message "Release root and release ZIP must not contain source, source maps, debug symbols, developer manifests, private key names, or license secret names." -Path $artifactCheckPath

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
