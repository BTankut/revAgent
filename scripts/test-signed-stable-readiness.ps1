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
    $rsa.ToXmlString($true) | Set-Content -LiteralPath $privateKeyPath -Encoding UTF8
    $publicKeyXml = $rsa.ToXmlString($false)
    $trustedKeys = @{ trustedKeys = @{} }
    $trustedKeys.trustedKeys[$keyId] = [pscustomobject][ordered]@{
        publicKeyXml = $publicKeyXml
        publicKeyFingerprint = Get-RevitMcpPublicKeyFingerprint -PublicKeyXml $publicKeyXml
        algorithm = "RS256"
    }
    $trustedKeysPath = Join-Path $secretRoot "release-trusted-keys.json"
    $trustedKeys | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $trustedKeysPath -Encoding UTF8

    & (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1") `
        -ReleaseRoot $signedRoot `
        -Version $signedVersion `
        -AllowDirty `
        -Force `
        -SigningPrivateKeyPath $privateKeyPath `
        -SigningKeyId $keyId `
        -ReleaseSequence $releaseSequence `
        -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence | Out-Null

    $signedReport = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot
    Assert-True ([bool]$signedReport.success) "Signed release root should be ready for enforce-mode rollout."
    Assert-True ([bool]$signedReport.readyForEnforce) "Signed release root should report readyForEnforce=true."
    Assert-Equal ([long]$signedReport.releaseSequence) ([long]$releaseSequence) "Readiness report should preserve releaseSequence."
    Assert-Equal ([int]$signedReport.trustedKeyCount) 1 "Readiness report should count trusted release keys."

    $signedJson = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -OutputJson
    $signedJsonReport = $signedJson | ConvertFrom-Json
    Assert-True ([bool]$signedJsonReport.success) "JSON readiness output should parse and report success."

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
        -ReportOnly
    Assert-True (-not [bool]$unsignedReport.success) "Unsigned stable release must not be ready for fail-closed enforcement."
    Assert-True (@($unsignedReport.checks | Where-Object { $_.name -eq "channel_signature_present" -and -not $_.success }).Count -eq 1) "Unsigned stable report should identify the missing channel signature."

    $leakedKeyPath = Join-Path $signedRoot "tools\release-signing-private.xml"
    Copy-Item -LiteralPath $privateKeyPath -Destination $leakedKeyPath -Force
    $privateMaterialReport = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $signedRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
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
        -ReportOnly
    Assert-True (-not [bool]$artifactReport.success) "Release root with source artifacts must not be ready."
    Assert-True (@($artifactReport.artifactFindings).Count -gt 0) "Source/developer artifact findings should be reported."
    Assert-True (@($artifactReport.checks | Where-Object { $_.name -eq "no_source_or_developer_artifacts_in_release_root" -and -not $_.success }).Count -eq 1) "Artifact hygiene check should be present and failed."
    Remove-Item -LiteralPath $leakedSourcePath -Force

    $scriptText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1")
    Assert-True ($scriptText -match 'Test-RevitMcpReleaseDistributionIntegrity' -and $scriptText -match '-Policy "enforce"') "Readiness preflight must use the shared enforce-mode verifier."
    Assert-True ($scriptText -match 'no_private_signing_material_in_release_root') "Readiness preflight must include private signing material checks."
    Assert-True ($scriptText -match 'no_source_or_developer_artifacts_in_release_root') "Readiness preflight must include source/developer artifact checks."
}
finally {
    $rsa.Dispose()
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Signed stable readiness tests passed." -ForegroundColor Green
