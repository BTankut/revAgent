<#
.SYNOPSIS
    Verify optional publish-path detached signature generation.

.DESCRIPTION
    This test runs publish-nas-release.ps1 against a temporary release root with
    an ephemeral RSA private key. It does not publish to NAS, does not use a
    production signing key, and cleans up all temporary signing material.
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

Write-Host "Test publish-path detached signing"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-publish-signing-test-" + [Guid]::NewGuid().ToString("N"))
$releaseRoot = Join-Path $tempRoot "release-root"
$secretRoot = Join-Path $tempRoot "secrets"
$version = "2026.06.22.1-signing-test"
$keyId = "test-rsa-2026"
$releaseSequence = 1001
$minimumAcceptedReleaseSequence = 1000
$rsa = New-TestRsaProvider

try {
    New-Item -ItemType Directory -Path $secretRoot -Force | Out-Null
    $privateKeyPath = Join-Path $secretRoot "release-signing-private.xml"
    $privateKeyXml = $rsa.ToXmlString($true)
    $privateKeyXml | Set-Content -LiteralPath $privateKeyPath -Encoding UTF8
    $publicKeyXml = $rsa.ToXmlString($false)
    $trustedKeys = @{}
    $trustedKeys[$keyId] = [pscustomobject][ordered]@{
        publicKeyXml = $publicKeyXml
        publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
        algorithm = "RS256"
    }
    $trustedKeysPath = Join-Path $secretRoot "release-trusted-keys.json"
    @{ trustedKeys = $trustedKeys } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $trustedKeysPath -Encoding UTF8

    $publishOutput = & (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1") `
        -ReleaseRoot $releaseRoot `
        -Version $version `
        -AllowDirty `
        -Force `
        -SigningPrivateKeyPath $privateKeyPath `
        -SigningKeyId $keyId `
        -ReleaseSequence $releaseSequence `
        -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence `
        -TrustedReleaseKeysPath $trustedKeysPath 6>&1 | Out-String

    Assert-True ($publishOutput -match "Release signing: enabled for keyId '$keyId'") "Publish output should report signing by keyId only."
    Assert-True ($publishOutput -match "Release sequence: $releaseSequence") "Publish output should report the signed release sequence."
    Assert-True (-not ($publishOutput -match [regex]::Escape($privateKeyPath))) "Publish output must not leak the private signing key path."

    $manifestPath = Join-Path $releaseRoot (Join-Path "releases" (Join-Path $version "manifest.json"))
    $manifestSignaturePath = Join-Path $releaseRoot (Join-Path "releases" (Join-Path $version "manifest.sig.json"))
    $channelPath = Join-Path $releaseRoot "channels\stable.json"
    $channelSignaturePath = Join-Path $releaseRoot "channels\stable.sig.json"

    foreach ($path in @($manifestPath, $manifestSignaturePath, $channelPath, $channelSignaturePath)) {
        Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Expected publish artifact was not written: $path"
    }

    $manifestVerification = Test-RevAgentDetachedJsonSignatureFile `
        -ContentPath $manifestPath `
        -SignaturePath $manifestSignaturePath `
        -TrustedKeys $trustedKeys `
        -AllowedSignedObjects @("release-manifest")
    Assert-True $manifestVerification.success "Published release manifest signature should verify."
    Assert-Equal $manifestVerification.signedObject "release-manifest" "Manifest signature should use the release-manifest signedObject."

    $channelVerification = Test-RevAgentDetachedJsonSignatureFile `
        -ContentPath $channelPath `
        -SignaturePath $channelSignaturePath `
        -TrustedKeys $trustedKeys `
        -AllowedSignedObjects @("channel")
    Assert-True $channelVerification.success "Published channel signature should verify."
    Assert-Equal $channelVerification.signedObject "channel" "Channel signature should use the channel signedObject."

    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $channel = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json
    $manifestSignature = Get-Content -Raw -LiteralPath $manifestSignaturePath | ConvertFrom-Json
    $channelSignature = Get-Content -Raw -LiteralPath $channelSignaturePath | ConvertFrom-Json
    Assert-Equal ([string]$manifest.app) "revit-mcp-skill" "Default publish must keep the legacy release app id for rolling updater compatibility."
    Assert-Equal ([string]$channel.app) "revit-mcp-skill" "Default channel publish must keep the legacy release app id for rolling updater compatibility."
    Assert-Equal ([string]$manifestSignature.app) "revit-mcp-skill" "Default manifest signature envelope must keep the legacy release app id."
    Assert-Equal ([string]$channelSignature.app) "revit-mcp-skill" "Default channel signature envelope must keep the legacy release app id."
    Assert-Equal ([string]$manifest.package.fileName) ("revit-mcp-skill-{0}.zip" -f $version) "Default publish must keep the legacy ZIP filename for rolling updater compatibility."
    Assert-True ([string]$manifest.package.path -match "revit-mcp-skill-") "Default release manifest package path must keep the legacy ZIP base name."
    Assert-True ([string]$channel.packagePath -match "revit-mcp-skill-") "Default channel package path must keep the legacy ZIP base name."
    Assert-True (-not [System.IO.Path]::IsPathRooted([string]$channel.manifestPath)) "Published channel manifestPath should be relative so signed artifacts can move from CD staging to NAS."
    Assert-True (-not [System.IO.Path]::IsPathRooted([string]$channel.packagePath)) "Published channel packagePath should be relative so signed artifacts can move from CD staging to NAS."
    Assert-Equal ([string]$channel.packagePath) ([string]$manifest.package.path) "Channel and manifest package paths should stay byte-identical for signature consistency."
    Assert-Equal ([long]$manifest.releaseSequence) ([long]$releaseSequence) "Published manifest must include the signed release sequence."
    Assert-Equal ([long]$channel.releaseSequence) ([long]$releaseSequence) "Published channel must include the signed release sequence."
    Assert-Equal ([long]$manifest.minimumAcceptedReleaseSequence) ([long]$minimumAcceptedReleaseSequence) "Published manifest must include the minimum accepted release sequence."
    Assert-Equal ([long]$channel.minimumAcceptedReleaseSequence) ([long]$minimumAcceptedReleaseSequence) "Published channel must include the minimum accepted release sequence."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\config\release-trusted-keys.json") -PathType Leaf) "Public trusted release keys should be copied to NAS tools config when supplied."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\dashboard\installer\install-dashboard-addon.ps1") -PathType Leaf) "Dashboard admin add-on installer should be published under tools\\addons."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\dashboard\installer\install-dashboard-tunnel.ps1") -PathType Leaf) "Dashboard tunnel installer should be published under tools\\addons."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\usage-intelligence\installer\install-usage-intelligence-addon.ps1") -PathType Leaf) "Usage-intelligence admin add-on installer should be published under tools\\addons."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\dashboard\tests") -PathType Container)) "Dashboard add-on tests must not be published to tools\\addons."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\usage-intelligence\tests") -PathType Container)) "Usage-intelligence add-on tests must not be published to tools\\addons."

    $aggregateVerification = Test-RevAgentReleaseDistributionIntegrity `
        -ChannelPath $channelPath `
        -Channel $channel `
        -ReleaseManifestPath $manifestPath `
        -ReleaseManifest $manifest `
        -TrustedKeys $trustedKeys `
        -Policy "enforce"
    Assert-True $aggregateVerification.success "Published signed release aggregate should pass enforce-mode verification."
    Assert-Equal $aggregateVerification.releaseSequence ([long]$releaseSequence) "Aggregate verification must preserve releaseSequence."

    Write-Host "Test explicit revAgent release app and package identity publish"
    $revAgentReleaseRoot = Join-Path $tempRoot "release-root-revagent"
    $revAgentVersion = "2026.06.22.2-revagent-app-test"
    $revAgentReleaseSequence = 1002
    [void](& (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1") `
            -ReleaseRoot $revAgentReleaseRoot `
            -Version $revAgentVersion `
            -AllowDirty `
            -Force `
            -SigningPrivateKeyPath $privateKeyPath `
            -SigningKeyId $keyId `
            -ReleaseSequence $revAgentReleaseSequence `
            -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence `
            -TrustedReleaseKeysPath $trustedKeysPath `
            -ReleaseAppId "revAgent" `
            -ReleasePackageBaseName "revAgent" 6>&1 | Out-String)

    $revAgentManifestPath = Join-Path $revAgentReleaseRoot (Join-Path "releases" (Join-Path $revAgentVersion "manifest.json"))
    $revAgentManifestSignaturePath = Join-Path $revAgentReleaseRoot (Join-Path "releases" (Join-Path $revAgentVersion "manifest.sig.json"))
    $revAgentChannelPath = Join-Path $revAgentReleaseRoot "channels\stable.json"
    $revAgentChannelSignaturePath = Join-Path $revAgentReleaseRoot "channels\stable.sig.json"
    $revAgentManifest = Get-Content -Raw -LiteralPath $revAgentManifestPath | ConvertFrom-Json
    $revAgentChannel = Get-Content -Raw -LiteralPath $revAgentChannelPath | ConvertFrom-Json
    $revAgentManifestSignature = Get-Content -Raw -LiteralPath $revAgentManifestSignaturePath | ConvertFrom-Json
    $revAgentChannelSignature = Get-Content -Raw -LiteralPath $revAgentChannelSignaturePath | ConvertFrom-Json
    Assert-Equal ([string]$revAgentManifest.app) "revAgent" "Explicit revAgent release app id must be written to the release manifest."
    Assert-Equal ([string]$revAgentChannel.app) "revAgent" "Explicit revAgent release app id must be written to the channel manifest."
    Assert-Equal ([string]$revAgentManifestSignature.app) "revAgent" "Explicit revAgent release app id must be written to the manifest signature envelope."
    Assert-Equal ([string]$revAgentChannelSignature.app) "revAgent" "Explicit revAgent release app id must be written to the channel signature envelope."
    Assert-Equal ([string]$revAgentManifest.package.fileName) ("revAgent-{0}.zip" -f $revAgentVersion) "Explicit revAgent package base name must be written to the release manifest."
    Assert-True ([string]$revAgentManifest.package.path -match "revAgent-") "Explicit revAgent package base name must be written to the manifest package path."
    Assert-True ([string]$revAgentChannel.packagePath -match "revAgent-") "Explicit revAgent package base name must be written to the channel package path."
    Assert-True (Test-Path -LiteralPath (Join-Path $revAgentReleaseRoot (Join-Path "releases" (Join-Path $revAgentVersion ("revAgent-{0}.zip" -f $revAgentVersion)))) -PathType Leaf) "Explicit revAgent package ZIP should be created with the revAgent base name."
    $revAgentAggregateVerification = Test-RevAgentReleaseDistributionIntegrity `
        -ChannelPath $revAgentChannelPath `
        -Channel $revAgentChannel `
        -ReleaseManifestPath $revAgentManifestPath `
        -ReleaseManifest $revAgentManifest `
        -TrustedKeys $trustedKeys `
        -Policy "enforce"
    Assert-True $revAgentAggregateVerification.success "Explicit revAgent release app id should pass enforce-mode verification."
    Assert-Equal $revAgentAggregateVerification.releaseSequence ([long]$revAgentReleaseSequence) "revAgent app id aggregate verification must preserve releaseSequence."

    $releaseFiles = Get-ChildItem -LiteralPath $releaseRoot -Recurse -File
    Assert-True (-not @($releaseFiles | Where-Object { $_.Name -eq "release-signing-private.xml" }).Count) "Private signing key must not be copied into release artifacts."
}
finally {
    $rsa.Dispose()
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Publish signing tests passed." -ForegroundColor Green
