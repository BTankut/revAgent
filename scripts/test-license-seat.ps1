<#
.SYNOPSIS
    Deterministic tests for revAgent signed license-seat verification.

.DESCRIPTION
    Uses an ephemeral RSA key and temporary files. It does not use production
    license keys, NAS paths, machine secrets, or user data.
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

Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.License.psm1") -Force
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

function Write-TestLicensePair {
    param(
        [Parameter(Mandatory = $true)][object]$License,
        [Parameter(Mandatory = $true)][System.Security.Cryptography.RSACryptoServiceProvider]$PrivateKey,
        [Parameter(Mandatory = $true)][string]$KeyId,
        [Parameter(Mandatory = $true)][string]$LicensePath,
        [Parameter(Mandatory = $true)][string]$SignaturePath
    )

    $License | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $LicensePath -Encoding UTF8
    $signature = New-RevAgentDetachedJsonSignature `
        -Content $License `
        -SignedObject "license-seat" `
        -KeyId $KeyId `
        -PrivateKeyXml ($PrivateKey.ToXmlString($true)) `
        -CreatedAtUtc "2026-06-22T00:00:00.0000000Z"
    $signature | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $SignaturePath -Encoding UTF8
}

Write-Host "Test signed license-seat verification"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-license-test-" + [Guid]::NewGuid().ToString("N"))
$keyId = "license-test-rsa-2026"
$rsa = New-TestRsaProvider

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $publicKeyXml = $rsa.ToXmlString($false)
    $trustedKeys = @{
        $keyId = [pscustomobject][ordered]@{
            publicKeyXml = $publicKeyXml
            publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
            algorithm = "RS256"
        }
    }

    $licensePath = Join-Path $tempRoot "revagent-license.json"
    $signaturePath = Join-Path $tempRoot "revagent-license.sig.json"
    $license = [ordered]@{
        schemaVersion = 1
        app = "revAgent"
        product = "revAgent"
        licenseId = "LIC-TEST-001"
        seatId = "SEAT-TEST-001"
        subject = "DPE test seat"
        issuedAtUtc = "2026-06-22T00:00:00.0000000Z"
        notBeforeUtc = "2026-01-01T00:00:00.0000000Z"
        expiresAtUtc = "2027-01-01T00:00:00.0000000Z"
    }
    Write-TestLicensePair -License $license -PrivateKey $rsa -KeyId $keyId -LicensePath $licensePath -SignaturePath $signaturePath

    $disabled = Test-RevAgentLicenseSeatFile -TrustedKeys $trustedKeys -Policy "disabled"
    Assert-True $disabled.success "Disabled license policy should not block."
    Assert-Equal $disabled.state "disabled" "Disabled license policy should be reported."

    $valid = Test-RevAgentLicenseSeatFile `
        -LicensePath $licensePath `
        -SignaturePath $signaturePath `
        -TrustedKeys $trustedKeys `
        -Policy "enforce" `
        -UtcNow ([datetimeoffset]"2026-06-22T12:00:00Z")
    Assert-True $valid.success "Valid signed license should pass enforce mode."
    Assert-True $valid.valid "Valid signed license should be marked valid."
    Assert-Equal $valid.licenseId "LIC-TEST-001" "License id should be reported."
    Assert-Equal $valid.seatId "SEAT-TEST-001" "Seat id should be reported."

    $expired = Test-RevAgentLicenseSeatFile `
        -LicensePath $licensePath `
        -SignaturePath $signaturePath `
        -TrustedKeys $trustedKeys `
        -Policy "enforce" `
        -UtcNow ([datetimeoffset]"2028-01-01T00:00:00Z")
    Assert-True (-not $expired.success) "Expired license should block enforce mode."
    Assert-Equal $expired.reason "license_expired" "Expired license should have a stable reason."

    $expiredAudit = Test-RevAgentLicenseSeatFile `
        -LicensePath $licensePath `
        -SignaturePath $signaturePath `
        -TrustedKeys $trustedKeys `
        -Policy "audit" `
        -UtcNow ([datetimeoffset]"2028-01-01T00:00:00Z")
    Assert-True $expiredAudit.success "Expired license should not block audit mode."
    Assert-True (-not $expiredAudit.valid) "Expired audit license should not be marked valid."
    Assert-Equal $expiredAudit.state "audit-failed" "Expired audit license should be reported as audit-failed."

    $tampered = [ordered]@{}
    foreach ($key in $license.Keys) {
        $tampered[$key] = $license[$key]
    }
    $tampered["seatId"] = "SEAT-TAMPERED"
    $tampered | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $licensePath -Encoding UTF8
    $tamperedResult = Test-RevAgentLicenseSeatFile `
        -LicensePath $licensePath `
        -SignaturePath $signaturePath `
        -TrustedKeys $trustedKeys `
        -Policy "enforce" `
        -UtcNow ([datetimeoffset]"2026-06-22T12:00:00Z")
    Assert-True (-not $tamperedResult.success) "Tampered license content should be rejected."
    Assert-Equal $tamperedResult.reason "content_hash_mismatch" "Tampered license should fail content hash verification."

    Remove-Item -LiteralPath $licensePath, $signaturePath -Force
    $missing = Test-RevAgentLicenseSeatFile `
        -LicensePath $licensePath `
        -SignaturePath $signaturePath `
        -TrustedKeys $trustedKeys `
        -Policy "enforce"
    Assert-True (-not $missing.success) "Missing license should block enforce mode."
    Assert-Equal $missing.reason "license_file_missing" "Missing license should have a stable reason."
}
finally {
    $rsa.Dispose()
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "License-seat tests passed." -ForegroundColor Green
