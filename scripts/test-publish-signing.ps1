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

Import-Module (Join-Path $RepoRoot "installer\lib\RevitMcp.DistributionIntegrity.psm1") -Force

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
        publicKeyFingerprint = Get-RevitMcpPublicKeyFingerprint -PublicKeyXml $publicKeyXml
        algorithm = "RS256"
    }

    $publishOutput = & (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1") `
        -ReleaseRoot $releaseRoot `
        -Version $version `
        -AllowDirty `
        -Force `
        -SigningPrivateKeyPath $privateKeyPath `
        -SigningKeyId $keyId `
        -ReleaseSequence $releaseSequence `
        -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence 6>&1 | Out-String

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

    $manifestVerification = Test-RevitMcpDetachedJsonSignatureFile `
        -ContentPath $manifestPath `
        -SignaturePath $manifestSignaturePath `
        -TrustedKeys $trustedKeys `
        -AllowedSignedObjects @("release-manifest")
    Assert-True $manifestVerification.success "Published release manifest signature should verify."
    Assert-Equal $manifestVerification.signedObject "release-manifest" "Manifest signature should use the release-manifest signedObject."

    $channelVerification = Test-RevitMcpDetachedJsonSignatureFile `
        -ContentPath $channelPath `
        -SignaturePath $channelSignaturePath `
        -TrustedKeys $trustedKeys `
        -AllowedSignedObjects @("channel")
    Assert-True $channelVerification.success "Published channel signature should verify."
    Assert-Equal $channelVerification.signedObject "channel" "Channel signature should use the channel signedObject."

    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $channel = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json
    Assert-Equal ([long]$manifest.releaseSequence) ([long]$releaseSequence) "Published manifest must include the signed release sequence."
    Assert-Equal ([long]$channel.releaseSequence) ([long]$releaseSequence) "Published channel must include the signed release sequence."
    Assert-Equal ([long]$manifest.minimumAcceptedReleaseSequence) ([long]$minimumAcceptedReleaseSequence) "Published manifest must include the minimum accepted release sequence."
    Assert-Equal ([long]$channel.minimumAcceptedReleaseSequence) ([long]$minimumAcceptedReleaseSequence) "Published channel must include the minimum accepted release sequence."

    $aggregateVerification = Test-RevitMcpReleaseDistributionIntegrity `
        -ChannelPath $channelPath `
        -Channel $channel `
        -ReleaseManifestPath $manifestPath `
        -ReleaseManifest $manifest `
        -TrustedKeys $trustedKeys `
        -Policy "enforce"
    Assert-True $aggregateVerification.success "Published signed release aggregate should pass enforce-mode verification."
    Assert-Equal $aggregateVerification.releaseSequence ([long]$releaseSequence) "Aggregate verification must preserve releaseSequence."

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
