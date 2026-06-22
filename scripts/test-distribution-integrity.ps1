<#
.SYNOPSIS
    Deterministic tests for revAgent distribution-integrity helpers.

.DESCRIPTION
    This test generates an ephemeral RSA key in memory and verifies canonical
    JSON hashing plus detached signature validation. It does not use NAS
    shares, private release keys, updater state, or production signing paths.
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

    if ($Actual -ne $Expected) {
        throw "$Message Expected '$Expected', got '$Actual'."
    }
}

function Copy-OrderedMap {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Value)

    $copy = [ordered]@{}
    foreach ($key in $Value.Keys) {
        $copy[$key] = $Value[$key]
    }
    return $copy
}

function New-TestSignatureEnvelope {
    param(
        [Parameter(Mandatory = $true)][object]$Content,
        [Parameter(Mandatory = $true)][System.Security.Cryptography.RSACryptoServiceProvider]$PrivateKey,
        [Parameter(Mandatory = $true)][string]$PublicKeyFingerprint,
        [string]$SignedObject = "channel",
        [string]$KeyId = "test-rsa-2026"
    )

    $envelope = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        signedObject = $SignedObject
        algorithm = "RS256"
        keyId = $KeyId
        publicKeyFingerprint = $PublicKeyFingerprint
        canonicalization = "RFC8785-JCS-SHA256-v1"
        contentSha256 = Get-RevitMcpCanonicalJsonSha256 -Value $Content
        createdAtUtc = "2026-06-22T00:00:00.0000000Z"
        signature = ""
    }

    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes((Get-RevitMcpSignaturePayloadCanonicalJson -SignatureEnvelope $envelope))
    $signatureBytes = $PrivateKey.SignData($payloadBytes, "SHA256")
    $envelope["signature"] = [Convert]::ToBase64String($signatureBytes)
    return $envelope
}

function Get-TamperedBase64Signature {
    param([Parameter(Mandatory = $true)][string]$Signature)

    $bytes = [Convert]::FromBase64String($Signature)
    $bytes[0] = $bytes[0] -bxor 0x40
    return [Convert]::ToBase64String($bytes)
}

function New-TestRsaProvider {
    $cspParameters = [System.Security.Cryptography.CspParameters]::new(24)
    return [System.Security.Cryptography.RSACryptoServiceProvider]::new(2048, $cspParameters)
}

Write-Host "Test canonical JSON output"
$canonicalInput = [ordered]@{
    b = $true
    emptyArray = @()
    emptyObject = [ordered]@{}
    nested = [ordered]@{
        beta = @(3, $null, "x")
        alpha = "z"
    }
    path = "tools/lib"
    singleArray = @("x")
    windows = "C:\Temp\file"
    a = 1
}
$canonicalJson = ConvertTo-RevitMcpCanonicalJson -Value $canonicalInput
Assert-Equal $canonicalJson '{"a":1,"b":true,"emptyArray":[],"emptyObject":{},"nested":{"alpha":"z","beta":[3,null,"x"]},"path":"tools/lib","singleArray":["x"],"windows":"C:\\Temp\\file"}' "Canonical JSON must sort object keys ordinally, preserve array shape, preserve forward slashes, escape backslashes, and remove insignificant whitespace."
Assert-Equal (Get-RevitMcpCanonicalJsonSha256 -Value $canonicalInput).Length 64 "Canonical SHA256 must be a hex digest."

Write-Host "Test canonical JSON rejects unsupported numeric ambiguity"
$rejectedFloat = $false
try {
    [void](ConvertTo-RevitMcpCanonicalJson -Value ([ordered]@{ value = 1.25 }))
}
catch {
    $rejectedFloat = ($_.Exception.Message -match "integers only")
}
Assert-True $rejectedFloat "Canonical signing JSON must reject floating-point input until full JCS number handling is implemented."

Write-Host "Test detached channel signature verification"
$rsa = New-TestRsaProvider
try {
    $publicKeyXml = $rsa.ToXmlString($false)
    $publicKeyFingerprint = Get-RevitMcpPublicKeyFingerprint -PublicKeyXml $publicKeyXml
    $trustedKeys = @{
        "test-rsa-2026" = [pscustomobject][ordered]@{
            publicKeyXml = $publicKeyXml
            publicKeyFingerprint = $publicKeyFingerprint
            algorithm = "RS256"
        }
    }
    $channel = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        channel = "stable"
        version = "2026.06.22.1-test"
        manifestPath = "releases\2026.06.22.1-test\manifest.json"
        packagePath = "releases\2026.06.22.1-test\revit-mcp-skill-2026.06.22.1-test.zip"
        sha256 = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"
        releaseSequence = 1001
        publishedAtUtc = "2026-06-22T00:00:00.0000000Z"
    }
    $envelope = New-TestSignatureEnvelope -Content $channel -PrivateKey $rsa -PublicKeyFingerprint $publicKeyFingerprint
    $valid = Test-RevitMcpDetachedJsonSignature -Content $channel -SignatureEnvelope $envelope -TrustedKeys $trustedKeys
    Assert-True $valid.success "Valid detached channel signature should verify."
    Assert-Equal $valid.signedObject "channel" "Valid signature result should preserve signedObject."

    Write-Host "Test detached release-manifest signature verification"
    $manifest = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        version = "2026.06.22.1-test"
        channel = "stable"
        package = [ordered]@{
            fileName = "revit-mcp-skill-2026.06.22.1-test.zip"
            path = "releases\2026.06.22.1-test\revit-mcp-skill-2026.06.22.1-test.zip"
            sha256 = $channel.sha256
            sizeBytes = 4096
        }
    }
    $manifestEnvelope = New-TestSignatureEnvelope -Content $manifest -PrivateKey $rsa -PublicKeyFingerprint $publicKeyFingerprint -SignedObject "release-manifest"
    $validManifest = Test-RevitMcpDetachedJsonSignature -Content $manifest -SignatureEnvelope $manifestEnvelope -TrustedKeys $trustedKeys
    Assert-True $validManifest.success "Valid detached release-manifest signature should verify."
    Assert-Equal $validManifest.signedObject "release-manifest" "Manifest signature result should preserve signedObject."

    Write-Host "Test detached signature file verification"
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-integrity-test-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        $channelPath = Join-Path $tempRoot "stable.json"
        $signaturePath = Join-Path $tempRoot "stable.sig.json"
        $channel | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $channelPath -Encoding UTF8
        $envelope | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $signaturePath -Encoding UTF8
        $validFile = Test-RevitMcpDetachedJsonSignatureFile -ContentPath $channelPath -SignaturePath $signaturePath -TrustedKeys $trustedKeys
        Assert-True $validFile.success "File-based detached signature verification should pass for signed fixture files."
    }
    finally {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }

    Write-Host "Test tampered content rejection"
    $tamperedChannel = Copy-OrderedMap -Value $channel
    $tamperedChannel["version"] = "2026.06.22.2-tampered"
    $tamperedContent = Test-RevitMcpDetachedJsonSignature -Content $tamperedChannel -SignatureEnvelope $envelope -TrustedKeys $trustedKeys
    Assert-True (-not $tamperedContent.success) "Tampered content must be rejected."
    Assert-Equal $tamperedContent.reason "content_hash_mismatch" "Tampered content should fail at content hash verification."

    Write-Host "Test tampered envelope metadata rejection"
    $tamperedEnvelope = Copy-OrderedMap -Value $envelope
    $tamperedEnvelope["createdAtUtc"] = "2026-06-23T00:00:00.0000000Z"
    $tamperedMetadata = Test-RevitMcpDetachedJsonSignature -Content $channel -SignatureEnvelope $tamperedEnvelope -TrustedKeys $trustedKeys
    Assert-True (-not $tamperedMetadata.success) "Tampered envelope metadata must be rejected."
    Assert-Equal $tamperedMetadata.reason "signature_verification_failed" "Tampered signed envelope metadata should fail signature verification."

    Write-Host "Test bad signature rejection"
    $badSignatureEnvelope = Copy-OrderedMap -Value $envelope
    $badSignatureEnvelope["signature"] = Get-TamperedBase64Signature -Signature ([string]$envelope["signature"])
    $badSignature = Test-RevitMcpDetachedJsonSignature -Content $channel -SignatureEnvelope $badSignatureEnvelope -TrustedKeys $trustedKeys
    Assert-True (-not $badSignature.success) "Bad signature bytes must be rejected."
    Assert-Equal $badSignature.reason "signature_verification_failed" "Bad signature bytes should fail signature verification."

    Write-Host "Test unknown key rejection"
    $unknownKeyEnvelope = Copy-OrderedMap -Value $envelope
    $unknownKeyEnvelope["keyId"] = "missing-key"
    $unknownKeyEnvelope["signature"] = [Convert]::ToBase64String($rsa.SignData([System.Text.Encoding]::UTF8.GetBytes((Get-RevitMcpSignaturePayloadCanonicalJson -SignatureEnvelope $unknownKeyEnvelope)), "SHA256"))
    $unknownKey = Test-RevitMcpDetachedJsonSignature -Content $channel -SignatureEnvelope $unknownKeyEnvelope -TrustedKeys $trustedKeys
    Assert-True (-not $unknownKey.success) "Unknown key id must be rejected."
    Assert-Equal $unknownKey.reason "unknown_key_id" "Unknown key id should fail before signature verification."

    Write-Host "Test wrong public key fingerprint rejection"
    $wrongFingerprintEnvelope = Copy-OrderedMap -Value $envelope
    $wrongFingerprintEnvelope["publicKeyFingerprint"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    $wrongFingerprintEnvelope["signature"] = [Convert]::ToBase64String($rsa.SignData([System.Text.Encoding]::UTF8.GetBytes((Get-RevitMcpSignaturePayloadCanonicalJson -SignatureEnvelope $wrongFingerprintEnvelope)), "SHA256"))
    $wrongFingerprint = Test-RevitMcpDetachedJsonSignature -Content $channel -SignatureEnvelope $wrongFingerprintEnvelope -TrustedKeys $trustedKeys
    Assert-True (-not $wrongFingerprint.success) "Wrong public key fingerprint must be rejected."
    Assert-Equal $wrongFingerprint.reason "wrong_public_key_fingerprint" "Wrong public key fingerprint should fail explicitly."

    Write-Host "Test unexpected unsigned envelope fields are rejected"
    $extraFieldEnvelope = Copy-OrderedMap -Value $envelope
    $extraFieldEnvelope["unsignedNote"] = "not covered"
    $extraField = Test-RevitMcpDetachedJsonSignature -Content $channel -SignatureEnvelope $extraFieldEnvelope -TrustedKeys $trustedKeys
    Assert-True (-not $extraField.success) "Unexpected signature envelope fields must be rejected."
    Assert-Equal $extraField.reason "unexpected_signature_field" "Unexpected signature envelope fields should have a stable reason."
}
finally {
    $rsa.Dispose()
}

Write-Host "Distribution integrity tests passed." -ForegroundColor Green
