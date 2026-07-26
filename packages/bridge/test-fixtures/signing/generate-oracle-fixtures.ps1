[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = $PSScriptRoot
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

$moduleRelativePath = "installer/lib/RevAgent.DistributionIntegrity.psm1"
$testsRelativePath = "scripts/test-distribution-integrity.ps1"
$modulePath = Join-Path $RepoRoot ($moduleRelativePath -replace "/", "\")
$expectedModuleBlob = "2943f1b642af915d627761bb14ae4364de253ba6"
$actualModuleBlob = (& git -C $RepoRoot hash-object -- $moduleRelativePath).Trim()
$actualTestsBlob = (& git -C $RepoRoot hash-object -- $testsRelativePath).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Could not hash the frozen distribution-integrity oracle."
}
if (-not [string]::Equals($actualModuleBlob, $expectedModuleBlob, [StringComparison]::Ordinal)) {
    throw "Frozen distribution-integrity module bytes do not match the P3-T1 provenance pin."
}

Import-Module $modulePath -Force
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Copy-OrderedEnvelope {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IDictionary]$Source
    )

    $copy = [ordered]@{}
    foreach ($entry in $Source.GetEnumerator()) {
        $copy[[string]$entry.Key] = $entry.Value
    }
    return $copy
}

function Set-ReSignedEnvelopeSignature {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IDictionary]$Envelope,

        [Parameter(Mandatory = $true)]
        [System.Security.Cryptography.RSACryptoServiceProvider]$PrivateKey
    )

    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes(
        (Get-RevitMcpSignaturePayloadCanonicalJson -SignatureEnvelope $Envelope))
    $Envelope["signature"] = [Convert]::ToBase64String(
        $PrivateKey.SignData($payloadBytes, "SHA256"))
}

$content = [ordered]@{
    schemaVersion = 1
    version = "0.1.0"
    releaseSequence = 1
    enabled = $true
    components = @()
    metadata = [ordered]@{
        empty = [ordered]@{}
        escaped = "line`n`t$([char]0x001f)$([char]0x011f)"
    }
}

$cspParameters = [System.Security.Cryptography.CspParameters]::new(24)
$cspParameters.Flags = [System.Security.Cryptography.CspProviderFlags]::CreateEphemeralKey
$rsa = [System.Security.Cryptography.RSACryptoServiceProvider]::new($cspParameters)
try {
    $privateKeyXml = $rsa.ToXmlString($true)
    $publicKeyXml = $rsa.ToXmlString($false)
    $envelope = New-RevitMcpDetachedJsonSignature `
        -Content $content `
        -SignedObject "release-manifest" `
        -KeyId "p3-t1-oracle-key" `
        -PrivateKeyXml $privateKeyXml `
        -App "revAgent" `
        -CreatedAtUtc "2026-07-26T00:00:00.0000000Z"
    $fingerprint = Get-RevitMcpPublicKeyFingerprint -PublicKeyXml $publicKeyXml
    $trustedKeys = @{
        "p3-t1-oracle-key" = [ordered]@{
            keyId = "p3-t1-oracle-key"
            publicKeyXml = $publicKeyXml
            publicKeyFingerprint = $fingerprint
        }
    }
    $verification = Test-RevitMcpDetachedJsonSignature `
        -Content $content `
        -SignatureEnvelope $envelope `
        -TrustedKeys $trustedKeys `
        -AllowedSignedObjects @("release-manifest")
    if (-not [bool]$verification.success) {
        throw "Frozen PowerShell oracle rejected its generated fixture: $($verification.reason)"
    }

    $unknownKeyEnvelope = Copy-OrderedEnvelope -Source $envelope
    $unknownKeyEnvelope["keyId"] = "missing-key"
    Set-ReSignedEnvelopeSignature `
        -Envelope $unknownKeyEnvelope `
        -PrivateKey $rsa

    $wrongFingerprintEnvelope = Copy-OrderedEnvelope -Source $envelope
    $wrongFingerprintEnvelope["publicKeyFingerprint"] =
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    Set-ReSignedEnvelopeSignature `
        -Envelope $wrongFingerprintEnvelope `
        -PrivateKey $rsa

    $unknownKeyVerification = Test-RevitMcpDetachedJsonSignature `
        -Content $content `
        -SignatureEnvelope $unknownKeyEnvelope `
        -TrustedKeys $trustedKeys `
        -AllowedSignedObjects @("release-manifest")
    if ([bool]$unknownKeyVerification.success -or
        -not [string]::Equals(
            [string]$unknownKeyVerification.reason,
            "unknown_key_id",
            [StringComparison]::Ordinal)) {
        throw "Frozen PowerShell oracle did not preserve unknown_key_id precedence."
    }

    $wrongFingerprintVerification = Test-RevitMcpDetachedJsonSignature `
        -Content $content `
        -SignatureEnvelope $wrongFingerprintEnvelope `
        -TrustedKeys $trustedKeys `
        -AllowedSignedObjects @("release-manifest")
    if ([bool]$wrongFingerprintVerification.success -or
        -not [string]::Equals(
            [string]$wrongFingerprintVerification.reason,
            "wrong_public_key_fingerprint",
            [StringComparison]::Ordinal)) {
        throw "Frozen PowerShell oracle did not preserve wrong_public_key_fingerprint precedence."
    }

    $trustedKeyDocument = [ordered]@{
        schemaVersion = 1
        keys = @($trustedKeys["p3-t1-oracle-key"])
    }
    $provenance = [ordered]@{
        schemaVersion = 1
        generatedBy = "Windows PowerShell $($PSVersionTable.PSVersion)"
        modulePath = $moduleRelativePath
        moduleBlob = $actualModuleBlob
        testPath = $testsRelativePath
        testBlob = $actualTestsBlob
        privateKeyPersisted = $false
    }

    [System.IO.File]::WriteAllText(
        (Join-Path $OutputDirectory "content.json"),
        ($content | ConvertTo-Json -Depth 20),
        $utf8)
    [System.IO.File]::WriteAllText(
        (Join-Path $OutputDirectory "signature-envelope.json"),
        ($envelope | ConvertTo-Json -Depth 20),
        $utf8)
    [System.IO.File]::WriteAllText(
        (Join-Path $OutputDirectory "unknown-key-signature-envelope.json"),
        ($unknownKeyEnvelope | ConvertTo-Json -Depth 20),
        $utf8)
    [System.IO.File]::WriteAllText(
        (Join-Path $OutputDirectory "wrong-fingerprint-signature-envelope.json"),
        ($wrongFingerprintEnvelope | ConvertTo-Json -Depth 20),
        $utf8)
    [System.IO.File]::WriteAllText(
        (Join-Path $OutputDirectory "trusted-public-key.json"),
        ($trustedKeyDocument | ConvertTo-Json -Depth 20),
        $utf8)
    [System.IO.File]::WriteAllText(
        (Join-Path $OutputDirectory "canonical-content.txt"),
        (ConvertTo-RevitMcpCanonicalJson -Value $content),
        $utf8)
    [System.IO.File]::WriteAllText(
        (Join-Path $OutputDirectory "canonical-projection.txt"),
        (Get-RevitMcpSignaturePayloadCanonicalJson -SignatureEnvelope $envelope),
        $utf8)
    [System.IO.File]::WriteAllText(
        (Join-Path $OutputDirectory "oracle-provenance.json"),
        ($provenance | ConvertTo-Json -Depth 10),
        $utf8)
}
finally {
    $privateKeyXml = $null
    $rsa.Dispose()
}

Write-Host "Frozen PowerShell signature oracle fixture generated without persisted private key."
