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
        [string]$App = "revit-mcp-skill",
        [string]$KeyId = "test-rsa-2026"
    )

    $envelope = [ordered]@{
        schemaVersion = 1
        app = $App
        signedObject = $SignedObject
        algorithm = "RS256"
        keyId = $KeyId
        publicKeyFingerprint = $PublicKeyFingerprint
        canonicalization = "RFC8785-JCS-SHA256-v1"
        contentSha256 = Get-RevAgentCanonicalJsonSha256 -Value $Content
        createdAtUtc = "2026-06-22T00:00:00.0000000Z"
        signature = ""
    }

    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes((Get-RevAgentSignaturePayloadCanonicalJson -SignatureEnvelope $envelope))
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
    $cspParameters.Flags = [System.Security.Cryptography.CspProviderFlags]::CreateEphemeralKey
    return [System.Security.Cryptography.RSACryptoServiceProvider]::new(2048, $cspParameters)
}

Write-Host "Test canonical JSON output"
$canonicalInput = [ordered]@{
    b = $true
    emptyArray = @()
    emptyCustomObject = ([pscustomobject][ordered]@{})
    emptyObject = [ordered]@{}
    nested = [ordered]@{
        beta = @(3, $null, "x")
        alpha = "z"
    }
    nullValue = $null
    path = "tools/lib"
    singleArray = @("x")
    singleNullArray = @($null)
    emptyString = ""
    windows = "C:\Temp\file"
    a = 1
}
$canonicalJson = ConvertTo-RevAgentCanonicalJson -Value $canonicalInput
Assert-Equal $canonicalJson '{"a":1,"b":true,"emptyArray":[],"emptyCustomObject":{},"emptyObject":{},"emptyString":"","nested":{"alpha":"z","beta":[3,null,"x"]},"nullValue":null,"path":"tools/lib","singleArray":["x"],"singleNullArray":[null],"windows":"C:\\Temp\\file"}' "Canonical JSON must sort object keys ordinally, preserve array shape, preserve empty objects, preserve empty strings, preserve nulls, preserve forward slashes, escape backslashes, and remove insignificant whitespace."
Assert-Equal (Get-RevAgentCanonicalJsonSha256 -Value $canonicalInput).Length 64 "Canonical SHA256 must be a hex digest."

Write-Host "Test canonical JSON rejects non-string dictionary keys"
$nonStringKeyDictionary = [System.Collections.Specialized.OrderedDictionary]::new()
$nonStringKeyDictionary.Add(1, "one")
$rejectedNonStringKey = $false
try {
    [void](ConvertTo-RevAgentCanonicalJson -Value $nonStringKeyDictionary)
}
catch {
    $rejectedNonStringKey = ($_.Exception.Message -match "dictionary keys must be strings")
}
Assert-True $rejectedNonStringKey "Canonical JSON must reject non-string dictionary keys instead of serializing a silent null."

Write-Host "Test canonical JSON rejects unsupported numeric ambiguity"
$rejectedFloat = $false
try {
    [void](ConvertTo-RevAgentCanonicalJson -Value ([ordered]@{ value = 1.25 }))
}
catch {
    $rejectedFloat = ($_.Exception.Message -match "integers only")
}
Assert-True $rejectedFloat "Canonical signing JSON must reject floating-point input until full JCS number handling is implemented."

Write-Host "Test detached channel signature verification"
$rsa = New-TestRsaProvider
try {
    $publicKeyXml = $rsa.ToXmlString($false)
    $publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
    $publicKeyXmlLf = $publicKeyXml -replace '><', ">`n  <"
    $publicKeyXmlCrLf = $publicKeyXmlLf -replace "`n", "`r`n"
    Assert-Equal (Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXmlLf) $publicKeyFingerprint "Public key fingerprints must be stable across XML formatting whitespace."
    Assert-Equal (Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXmlCrLf) $publicKeyFingerprint "Public key fingerprints must be stable across LF and CRLF line endings."
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
        minimumAcceptedReleaseSequence = 1000
        publishedAtUtc = "2026-06-22T00:00:00.0000000Z"
    }
    $envelope = New-TestSignatureEnvelope -Content $channel -PrivateKey $rsa -PublicKeyFingerprint $publicKeyFingerprint
    $valid = Test-RevAgentDetachedJsonSignature -Content $channel -SignatureEnvelope $envelope -TrustedKeys $trustedKeys
    Assert-True $valid.success "Valid detached channel signature should verify."
    Assert-Equal $valid.signedObject "channel" "Valid signature result should preserve signedObject."

    Write-Host "Test detached signature helper generation"
    $generatedEnvelope = New-RevAgentDetachedJsonSignature -Content $channel -SignedObject "channel" -KeyId "test-rsa-2026" -PrivateKeyXml ($rsa.ToXmlString($true)) -CreatedAtUtc "2026-06-22T00:00:00.0000000Z"
    $generatedValid = Test-RevAgentDetachedJsonSignature -Content $channel -SignatureEnvelope $generatedEnvelope -TrustedKeys $trustedKeys
    Assert-True $generatedValid.success "Generated detached channel signature should verify."
    Assert-Equal $generatedEnvelope.contentSha256 (Get-RevAgentCanonicalJsonSha256 -Value $channel) "Generated signature envelope must bind the canonical content hash."

    Write-Host "Test release app identity compatibility"
    Assert-True (Test-RevAgentReleaseAppIdentity -App "revit-mcp-skill") "Legacy release app identity should remain accepted during rolling updates."
    Assert-True (Test-RevAgentReleaseAppIdentity -App "revAgent") "revAgent release app identity should be accepted before producers emit it."
    Assert-True (-not (Test-RevAgentReleaseAppIdentity -App "other-app")) "Unknown release app identity must remain rejected."

    Write-Host "Test signedObject allowlist is case-sensitive"
    $wrongCaseSignedObjectEnvelope = Copy-OrderedMap -Value $envelope
    $wrongCaseSignedObjectEnvelope["signedObject"] = "Channel"
    $wrongCaseSignedObject = Test-RevAgentDetachedJsonSignature -Content $channel -SignatureEnvelope $wrongCaseSignedObjectEnvelope -TrustedKeys $trustedKeys -AllowedSignedObjects @("channel")
    Assert-True (-not $wrongCaseSignedObject.success) "Different-case signedObject values must be rejected."
    Assert-Equal $wrongCaseSignedObject.reason "unsupported_signed_object" "Different-case signedObject should fail the allowlist check."

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
        releaseSequence = 1001
        minimumAcceptedReleaseSequence = 1000
    }
    $manifestEnvelope = New-TestSignatureEnvelope -Content $manifest -PrivateKey $rsa -PublicKeyFingerprint $publicKeyFingerprint -SignedObject "release-manifest"
    $validManifest = Test-RevAgentDetachedJsonSignature -Content $manifest -SignatureEnvelope $manifestEnvelope -TrustedKeys $trustedKeys
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
        $validFile = Test-RevAgentDetachedJsonSignatureFile -ContentPath $channelPath -SignaturePath $signaturePath -TrustedKeys $trustedKeys
        Assert-True $validFile.success "File-based detached signature verification should pass for signed fixture files."

        Write-Host "Test updater compatibility aggregate accepts valid signed release"
        $manifestPath = Join-Path $tempRoot "manifest.json"
        $manifestSignaturePath = Join-Path $tempRoot "manifest.sig.json"
        $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
        $manifestEnvelope | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestSignaturePath -Encoding UTF8
        $jsonTrustedKeys = (($trustedKeys | ConvertTo-Json -Depth 8) | ConvertFrom-Json)
        $validAggregate = Test-RevAgentReleaseDistributionIntegrity `
            -ChannelPath $channelPath `
            -Channel $channel `
            -ReleaseManifestPath $manifestPath `
            -ReleaseManifest $manifest `
            -TrustedKeys $jsonTrustedKeys `
            -Policy "compatibility"
        Assert-True $validAggregate.success "Valid signed release should pass the updater compatibility aggregate."
        Assert-Equal $validAggregate.state "verified" "Valid signed release aggregate should be verified."
        Assert-Equal $validAggregate.releaseSequence ([long]1001) "Valid signed release aggregate should report releaseSequence."
        Assert-Equal $validAggregate.highestAcceptedReleaseSequence ([long]1001) "Valid signed release aggregate should advance highest accepted sequence."

        Write-Host "Test updater aggregate binds runtime-converted ISO dates to exact signed JSON"
        $runtimeParsedChannel = Get-Content -Raw -LiteralPath $channelPath -Encoding UTF8 | ConvertFrom-Json
        $runtimeParsedManifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
        $runtimeParsedAggregate = Test-RevAgentReleaseDistributionIntegrity `
            -ChannelPath $channelPath `
            -Channel $runtimeParsedChannel `
            -ReleaseManifestPath $manifestPath `
            -ReleaseManifest $runtimeParsedManifest `
            -TrustedKeys $jsonTrustedKeys `
            -Policy "compatibility"
        if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey("DateKind")) {
            Assert-True ($runtimeParsedChannel.publishedAtUtc -is [datetime]) "The regression fixture must exercise PowerShell's default ISO date materialization."
        }
        Assert-True $runtimeParsedAggregate.success "Runtime-converted ISO date values must bind to the exact verified signed JSON content."

        Write-Host "Test updater aggregate accepts revAgent app identity"
        $revAgentChannel = Copy-OrderedMap -Value $channel
        $revAgentChannel["app"] = "revAgent"
        $revAgentManifest = Copy-OrderedMap -Value $manifest
        $revAgentManifest["app"] = "revAgent"
        $revAgentChannelPath = Join-Path $tempRoot "stable-revagent.json"
        $revAgentSignaturePath = Join-Path $tempRoot "stable-revagent.sig.json"
        $revAgentManifestPath = Join-Path $tempRoot "manifest-revagent.json"
        $revAgentManifestSignaturePath = Join-Path $tempRoot "manifest-revagent.sig.json"
        $revAgentEnvelope = New-TestSignatureEnvelope -Content $revAgentChannel -PrivateKey $rsa -PublicKeyFingerprint $publicKeyFingerprint -App "revAgent"
        $revAgentManifestEnvelope = New-TestSignatureEnvelope -Content $revAgentManifest -PrivateKey $rsa -PublicKeyFingerprint $publicKeyFingerprint -SignedObject "release-manifest" -App "revAgent"
        $revAgentChannel | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $revAgentChannelPath -Encoding UTF8
        $revAgentEnvelope | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $revAgentSignaturePath -Encoding UTF8
        $revAgentManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $revAgentManifestPath -Encoding UTF8
        $revAgentManifestEnvelope | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $revAgentManifestSignaturePath -Encoding UTF8
        $revAgentAggregate = Test-RevAgentReleaseDistributionIntegrity `
            -ChannelPath $revAgentChannelPath `
            -Channel $revAgentChannel `
            -ReleaseManifestPath $revAgentManifestPath `
            -ReleaseManifest $revAgentManifest `
            -TrustedKeys $jsonTrustedKeys `
            -Policy "compatibility"
        Assert-True $revAgentAggregate.success "revAgent app identity should pass signed release distribution integrity."
        Assert-Equal $revAgentAggregate.state "verified" "revAgent app identity aggregate should be verified."

        Write-Host "Test updater aggregate blocks older signed release replay"
        $replayAggregate = Test-RevAgentReleaseDistributionIntegrity `
            -ChannelPath $channelPath `
            -Channel $channel `
            -ReleaseManifestPath $manifestPath `
            -ReleaseManifest $manifest `
            -TrustedKeys $trustedKeys `
            -Policy "compatibility" `
            -HighestAcceptedReleaseSequence 1002
        Assert-True (-not $replayAggregate.success) "Older signed release sequence must be rejected without rollback allowance."
        Assert-Equal $replayAggregate.reason "signed_release_replay" "Older signed release sequence should fail with signed_release_replay."

        Write-Host "Test updater aggregate allows explicit signed rollback"
        $rollbackAggregate = Test-RevAgentReleaseDistributionIntegrity `
            -ChannelPath $channelPath `
            -Channel $channel `
            -ReleaseManifestPath $manifestPath `
            -ReleaseManifest $manifest `
            -TrustedKeys $trustedKeys `
            -Policy "compatibility" `
            -HighestAcceptedReleaseSequence 1002 `
            -AllowRollback
        Assert-True $rollbackAggregate.success "Explicit rollback flag should allow an older signed release sequence."
        Assert-Equal $rollbackAggregate.state "rollback-allowed" "Explicit signed rollback should be visible in aggregate state."
        Assert-True $rollbackAggregate.rollbackAllowed "Explicit signed rollback should be reported."

        Write-Host "Test updater compatibility aggregate rejects stripped signatures when trusted keys exist"
        Remove-Item -LiteralPath $signaturePath, $manifestSignaturePath -Force
        $strippedSignedAggregate = Test-RevAgentReleaseDistributionIntegrity `
            -ChannelPath $channelPath `
            -Channel $channel `
            -ReleaseManifestPath $manifestPath `
            -ReleaseManifest $manifest `
            -TrustedKeys $trustedKeys `
            -Policy "compatibility"
        Assert-True (-not $strippedSignedAggregate.success) "Trusted-key compatibility mode must reject releases with stripped signatures."
        Assert-Equal $strippedSignedAggregate.reason "signature_required" "Trusted-key stripped signature rejection should use signature_required."
        Assert-Equal $strippedSignedAggregate.consistency.reason "unsigned_release_rejected" "Trusted-key stripped signature rejection should not report legacy-compatible consistency."

        Write-Host "Test updater compatibility aggregate rejects unsigned release after signed acceptance"
        $unsignedAfterSignedAggregate = Test-RevAgentReleaseDistributionIntegrity `
            -ChannelPath $channelPath `
            -Channel $channel `
            -ReleaseManifestPath $manifestPath `
            -ReleaseManifest $manifest `
            -TrustedKeys @{} `
            -Policy "compatibility" `
            -HighestAcceptedReleaseSequence 1001
        Assert-True (-not $unsignedAfterSignedAggregate.success) "Unsigned releases must be rejected once a signed release sequence has been accepted."
        Assert-Equal $unsignedAfterSignedAggregate.reason "unsigned_release_after_signed_acceptance" "Unsigned-after-signed rejection should use a stable reason."
        Assert-Equal $unsignedAfterSignedAggregate.consistency.reason "unsigned_release_rejected" "Unsigned-after-signed rejection should not report legacy-compatible consistency."
        Assert-Equal $unsignedAfterSignedAggregate.highestAcceptedReleaseSequence ([long]1001) "Unsigned-after-signed rejection should preserve the accepted signed sequence watermark."

        Write-Host "Test updater compatibility aggregate accepts keys-free unsigned legacy release"
        $unsignedAggregate = Test-RevAgentReleaseDistributionIntegrity `
            -ChannelPath $channelPath `
            -Channel $channel `
            -ReleaseManifestPath $manifestPath `
            -ReleaseManifest $manifest `
            -TrustedKeys @{} `
            -Policy "compatibility"
        Assert-True $unsignedAggregate.success "Unsigned release should pass only in keys-free compatibility mode."
        Assert-Equal $unsignedAggregate.state "legacy-compatible" "Unsigned release must be reported as legacy-compatible."
        Assert-Equal $unsignedAggregate.consistency.reason "unsigned_legacy_release" "Accepted legacy unsigned release should keep legacy consistency metadata."

        Write-Host "Test updater compatibility aggregate rejects partial signature set"
        $envelope | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $signaturePath -Encoding UTF8
        $partialAggregate = Test-RevAgentReleaseDistributionIntegrity `
            -ChannelPath $channelPath `
            -Channel $channel `
            -ReleaseManifestPath $manifestPath `
            -ReleaseManifest $manifest `
            -TrustedKeys $trustedKeys `
            -Policy "compatibility"
        Assert-True (-not $partialAggregate.success) "Partially signed release must be rejected."
        Assert-Equal $partialAggregate.reason "partial_signature_set" "Partially signed release should fail with a stable reason."
        Assert-Equal $partialAggregate.consistency.reason "unsigned_release_rejected" "Partially signed release should not report legacy-compatible consistency."

        Write-Host "Test updater enforce aggregate rejects unsigned release"
        Remove-Item -LiteralPath $signaturePath -Force
        $enforcedUnsignedAggregate = Test-RevAgentReleaseDistributionIntegrity `
            -ChannelPath $channelPath `
            -Channel $channel `
            -ReleaseManifestPath $manifestPath `
            -ReleaseManifest $manifest `
            -TrustedKeys $trustedKeys `
            -Policy "enforce"
        Assert-True (-not $enforcedUnsignedAggregate.success) "Unsigned release must be rejected when enforcement is enabled."
        Assert-Equal $enforcedUnsignedAggregate.reason "signature_required" "Unsigned enforced release should fail with signature_required."

        Write-Host "Test updater aggregate rejects signed channel/manifest mismatch"
        $mismatchedManifest = Copy-OrderedMap -Value $manifest
        $mismatchedPackage = Copy-OrderedMap -Value $manifest["package"]
        $mismatchedPackage["sha256"] = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
        $mismatchedManifest["package"] = $mismatchedPackage
        $mismatchedManifestEnvelope = New-TestSignatureEnvelope -Content $mismatchedManifest -PrivateKey $rsa -PublicKeyFingerprint $publicKeyFingerprint -SignedObject "release-manifest"
        $channel | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $channelPath -Encoding UTF8
        $envelope | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $signaturePath -Encoding UTF8
        $mismatchedManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
        $mismatchedManifestEnvelope | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestSignaturePath -Encoding UTF8
        $mismatchAggregate = Test-RevAgentReleaseDistributionIntegrity `
            -ChannelPath $channelPath `
            -Channel $channel `
            -ReleaseManifestPath $manifestPath `
            -ReleaseManifest $mismatchedManifest `
            -TrustedKeys $trustedKeys `
            -Policy "compatibility"
        Assert-True (-not $mismatchAggregate.success) "Signed release with channel/manifest metadata mismatch must be rejected."
        Assert-Equal $mismatchAggregate.reason "channel_manifest_mismatch" "Signed channel/manifest mismatch should have a stable reason."

        Write-Host "Test duplicate JSON keys are rejected before file verification"
        $duplicateContentPath = Join-Path $tempRoot "duplicate-content.json"
        $duplicateSignaturePath = Join-Path $tempRoot "duplicate-content.sig.json"
        '{"schemaVersion":1,"schemaVersion":2}' | Set-Content -LiteralPath $duplicateContentPath -Encoding UTF8
        $envelope | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $duplicateSignaturePath -Encoding UTF8
        $duplicateContent = Test-RevAgentDetachedJsonSignatureFile -ContentPath $duplicateContentPath -SignaturePath $duplicateSignaturePath -TrustedKeys $trustedKeys
        Assert-True (-not $duplicateContent.success) "Duplicate keys in signed content JSON must be rejected before ConvertFrom-Json can collapse them."
        Assert-Equal $duplicateContent.reason "duplicate_json_key" "Duplicate signed content keys should have a stable reason."

        $duplicateEnvelopePath = Join-Path $tempRoot "duplicate-envelope.sig.json"
        $channel | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $channelPath -Encoding UTF8
        '{"schemaVersion":1,"schemaVersion":2}' | Set-Content -LiteralPath $duplicateEnvelopePath -Encoding UTF8
        $duplicateEnvelope = Test-RevAgentDetachedJsonSignatureFile -ContentPath $channelPath -SignaturePath $duplicateEnvelopePath -TrustedKeys $trustedKeys
        Assert-True (-not $duplicateEnvelope.success) "Duplicate keys in signature envelope JSON must be rejected before ConvertFrom-Json can collapse them."
        Assert-Equal $duplicateEnvelope.reason "duplicate_json_key" "Duplicate signature envelope keys should have a stable reason."
    }
    finally {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }

    Write-Host "Test tampered content rejection"
    $tamperedChannel = Copy-OrderedMap -Value $channel
    $tamperedChannel["version"] = "2026.06.22.2-tampered"
    $tamperedContent = Test-RevAgentDetachedJsonSignature -Content $tamperedChannel -SignatureEnvelope $envelope -TrustedKeys $trustedKeys
    Assert-True (-not $tamperedContent.success) "Tampered content must be rejected."
    Assert-Equal $tamperedContent.reason "content_hash_mismatch" "Tampered content should fail at content hash verification."

    Write-Host "Test tampered envelope metadata rejection"
    $tamperedEnvelope = Copy-OrderedMap -Value $envelope
    $tamperedEnvelope["createdAtUtc"] = "2026-06-23T00:00:00.0000000Z"
    $tamperedMetadata = Test-RevAgentDetachedJsonSignature -Content $channel -SignatureEnvelope $tamperedEnvelope -TrustedKeys $trustedKeys
    Assert-True (-not $tamperedMetadata.success) "Tampered envelope metadata must be rejected."
    Assert-Equal $tamperedMetadata.reason "signature_verification_failed" "Tampered signed envelope metadata should fail signature verification."

    Write-Host "Test bad signature rejection"
    $badSignatureEnvelope = Copy-OrderedMap -Value $envelope
    $badSignatureEnvelope["signature"] = Get-TamperedBase64Signature -Signature ([string]$envelope["signature"])
    $badSignature = Test-RevAgentDetachedJsonSignature -Content $channel -SignatureEnvelope $badSignatureEnvelope -TrustedKeys $trustedKeys
    Assert-True (-not $badSignature.success) "Bad signature bytes must be rejected."
    Assert-Equal $badSignature.reason "signature_verification_failed" "Bad signature bytes should fail signature verification."

    Write-Host "Test unknown key rejection"
    $unknownKeyEnvelope = Copy-OrderedMap -Value $envelope
    $unknownKeyEnvelope["keyId"] = "missing-key"
    $unknownKeyEnvelope["signature"] = [Convert]::ToBase64String($rsa.SignData([System.Text.Encoding]::UTF8.GetBytes((Get-RevAgentSignaturePayloadCanonicalJson -SignatureEnvelope $unknownKeyEnvelope)), "SHA256"))
    $unknownKey = Test-RevAgentDetachedJsonSignature -Content $channel -SignatureEnvelope $unknownKeyEnvelope -TrustedKeys $trustedKeys
    Assert-True (-not $unknownKey.success) "Unknown key id must be rejected."
    Assert-Equal $unknownKey.reason "unknown_key_id" "Unknown key id should fail before signature verification."

    Write-Host "Test wrong public key fingerprint rejection"
    $wrongFingerprintEnvelope = Copy-OrderedMap -Value $envelope
    $wrongFingerprintEnvelope["publicKeyFingerprint"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    $wrongFingerprintEnvelope["signature"] = [Convert]::ToBase64String($rsa.SignData([System.Text.Encoding]::UTF8.GetBytes((Get-RevAgentSignaturePayloadCanonicalJson -SignatureEnvelope $wrongFingerprintEnvelope)), "SHA256"))
    $wrongFingerprint = Test-RevAgentDetachedJsonSignature -Content $channel -SignatureEnvelope $wrongFingerprintEnvelope -TrustedKeys $trustedKeys
    Assert-True (-not $wrongFingerprint.success) "Wrong public key fingerprint must be rejected."
    Assert-Equal $wrongFingerprint.reason "wrong_public_key_fingerprint" "Wrong public key fingerprint should fail explicitly."

    Write-Host "Test unexpected unsigned envelope fields are rejected"
    $extraFieldEnvelope = Copy-OrderedMap -Value $envelope
    $extraFieldEnvelope["unsignedNote"] = "not covered"
    $extraField = Test-RevAgentDetachedJsonSignature -Content $channel -SignatureEnvelope $extraFieldEnvelope -TrustedKeys $trustedKeys
    Assert-True (-not $extraField.success) "Unexpected signature envelope fields must be rejected."
    Assert-Equal $extraField.reason "unexpected_signature_field" "Unexpected signature envelope fields should have a stable reason."
}
finally {
    $rsa.Dispose()
}

Write-Host "Distribution integrity tests passed." -ForegroundColor Green
