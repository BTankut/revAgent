Set-StrictMode -Version Latest

$distributionIntegrityModule = Join-Path $PSScriptRoot "RevAgent.DistributionIntegrity.psm1"
if (-not (Test-Path -LiteralPath $distributionIntegrityModule -PathType Leaf)) {
    throw "Distribution integrity helper module was not found beside RevAgent.License.psm1."
}
Import-Module $distributionIntegrityModule -Force

function Get-RevitMcpLicensePropertyValue {
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }

    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) {
            return $Object[$Name]
        }
        return $null
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($property) {
        return $property.Value
    }

    return $null
}

function New-RevitMcpLicenseResult {
    param(
        [bool]$Success,
        [bool]$Valid,
        [string]$State,
        [string]$Reason,
        [string]$Message,
        [string]$Policy,
        [string]$LicensePath = "",
        [string]$SignaturePath = "",
        [string]$LicenseId = "",
        [string]$SeatId = "",
        [string]$Subject = "",
        [string]$ExpiresAtUtc = "",
        [object]$Signature = $null
    )

    return [pscustomobject][ordered]@{
        success = $Success
        valid = $Valid
        state = $State
        reason = $Reason
        message = $Message
        policy = $Policy
        licensePath = $LicensePath
        signaturePath = $SignaturePath
        licenseId = $LicenseId
        seatId = $SeatId
        subject = $Subject
        expiresAtUtc = $ExpiresAtUtc
        signature = $Signature
    }
}

function Resolve-RevitMcpLicenseFailure {
    param(
        [string]$Policy,
        [string]$Reason,
        [string]$Message,
        [string]$LicensePath = "",
        [string]$SignaturePath = "",
        [object]$Signature = $null
    )

    if ($Policy -eq "enforce") {
        return New-RevitMcpLicenseResult `
            -Success $false `
            -Valid $false `
            -State "rejected" `
            -Reason $Reason `
            -Message $Message `
            -Policy $Policy `
            -LicensePath $LicensePath `
            -SignaturePath $SignaturePath `
            -Signature $Signature
    }

    return New-RevitMcpLicenseResult `
        -Success $true `
        -Valid $false `
        -State "audit-failed" `
        -Reason $Reason `
        -Message $Message `
        -Policy $Policy `
        -LicensePath $LicensePath `
        -SignaturePath $SignaturePath `
        -Signature $Signature
}

function ConvertTo-RevitMcpLicenseUtc {
    param(
        [AllowNull()][object]$Value,
        [string]$Name
    )

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return $null
    }

    try {
        return ([datetimeoffset]::Parse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal)).ToUniversalTime()
    }
    catch {
        throw "License field '$Name' is not a valid UTC timestamp."
    }
}

function Test-RevitMcpLicenseSeatFile {
    [CmdletBinding()]
    param(
        [string]$LicensePath = "",
        [string]$SignaturePath = "",
        [Parameter(Mandatory = $true)][object]$TrustedKeys,
        [ValidateSet("disabled", "audit", "enforce")]
        [string]$Policy = "disabled",
        [datetimeoffset]$UtcNow = ([datetimeoffset]::UtcNow),
        [string]$ExpectedProduct = "revAgent"
    )

    if ($Policy -eq "disabled") {
        return New-RevitMcpLicenseResult `
            -Success $true `
            -Valid $false `
            -State "disabled" `
            -Reason "disabled" `
            -Message "License verification is disabled." `
            -Policy $Policy `
            -LicensePath $LicensePath `
            -SignaturePath $SignaturePath
    }

    if ([string]::IsNullOrWhiteSpace($LicensePath) -or -not (Test-Path -LiteralPath $LicensePath -PathType Leaf)) {
        return Resolve-RevitMcpLicenseFailure `
            -Policy $Policy `
            -Reason "license_file_missing" `
            -Message "License file was not found." `
            -LicensePath $LicensePath `
            -SignaturePath $SignaturePath
    }
    if ([string]::IsNullOrWhiteSpace($SignaturePath) -or -not (Test-Path -LiteralPath $SignaturePath -PathType Leaf)) {
        return Resolve-RevitMcpLicenseFailure `
            -Policy $Policy `
            -Reason "license_signature_missing" `
            -Message "License signature file was not found." `
            -LicensePath $LicensePath `
            -SignaturePath $SignaturePath
    }

    $trustedKeyMap = ConvertTo-RevitMcpTrustedKeyMap -TrustedKeys $TrustedKeys
    $signature = Test-RevitMcpDetachedJsonSignatureFile `
        -ContentPath $LicensePath `
        -SignaturePath $SignaturePath `
        -TrustedKeys $trustedKeyMap `
        -AllowedSignedObjects @("license-seat")
    if (-not [bool]$signature.success) {
        return Resolve-RevitMcpLicenseFailure `
            -Policy $Policy `
            -Reason ([string]$signature.reason) `
            -Message ([string]$signature.message) `
            -LicensePath $LicensePath `
            -SignaturePath $SignaturePath `
            -Signature $signature
    }

    try {
        $license = Get-Content -Raw -LiteralPath $LicensePath -Encoding UTF8 | ConvertFrom-Json
        $schemaVersion = [int](Get-RevitMcpLicensePropertyValue -Object $license -Name "schemaVersion")
        $app = [string](Get-RevitMcpLicensePropertyValue -Object $license -Name "app")
        $product = [string](Get-RevitMcpLicensePropertyValue -Object $license -Name "product")
        $licenseId = [string](Get-RevitMcpLicensePropertyValue -Object $license -Name "licenseId")
        $seatId = [string](Get-RevitMcpLicensePropertyValue -Object $license -Name "seatId")
        $subject = [string](Get-RevitMcpLicensePropertyValue -Object $license -Name "subject")
        $notBeforeAt = ConvertTo-RevitMcpLicenseUtc -Value (Get-RevitMcpLicensePropertyValue -Object $license -Name "notBeforeUtc") -Name "notBeforeUtc"
        $expiresAt = ConvertTo-RevitMcpLicenseUtc -Value (Get-RevitMcpLicensePropertyValue -Object $license -Name "expiresAtUtc") -Name "expiresAtUtc"
    }
    catch {
        return Resolve-RevitMcpLicenseFailure `
            -Policy $Policy `
            -Reason "invalid_license_json" `
            -Message $_.Exception.Message `
            -LicensePath $LicensePath `
            -SignaturePath $SignaturePath `
            -Signature $signature
    }

    if ($schemaVersion -ne 1) {
        return Resolve-RevitMcpLicenseFailure -Policy $Policy -Reason "unsupported_license_schema" -Message "Unsupported license schemaVersion '$schemaVersion'." -LicensePath $LicensePath -SignaturePath $SignaturePath -Signature $signature
    }
    if ($app -ne "revAgent") {
        return Resolve-RevitMcpLicenseFailure -Policy $Policy -Reason "invalid_license_app" -Message "License app is '$app', expected 'revAgent'." -LicensePath $LicensePath -SignaturePath $SignaturePath -Signature $signature
    }
    if ($product -ne $ExpectedProduct) {
        return Resolve-RevitMcpLicenseFailure -Policy $Policy -Reason "invalid_license_product" -Message "License product is '$product', expected '$ExpectedProduct'." -LicensePath $LicensePath -SignaturePath $SignaturePath -Signature $signature
    }
    if ([string]::IsNullOrWhiteSpace($licenseId) -or [string]::IsNullOrWhiteSpace($seatId)) {
        return Resolve-RevitMcpLicenseFailure -Policy $Policy -Reason "missing_license_identity" -Message "License must include licenseId and seatId." -LicensePath $LicensePath -SignaturePath $SignaturePath -Signature $signature
    }
    if ($notBeforeAt -and $UtcNow -lt $notBeforeAt) {
        return Resolve-RevitMcpLicenseFailure -Policy $Policy -Reason "license_not_yet_valid" -Message "License is not valid before $($notBeforeAt.ToString("o"))." -LicensePath $LicensePath -SignaturePath $SignaturePath -Signature $signature
    }
    if ($expiresAt -and $UtcNow -gt $expiresAt) {
        return Resolve-RevitMcpLicenseFailure -Policy $Policy -Reason "license_expired" -Message "License expired at $($expiresAt.ToString("o"))." -LicensePath $LicensePath -SignaturePath $SignaturePath -Signature $signature
    }

    return New-RevitMcpLicenseResult `
        -Success $true `
        -Valid $true `
        -State "verified" `
        -Reason "ok" `
        -Message "License seat signature and claims verified." `
        -Policy $Policy `
        -LicensePath $LicensePath `
        -SignaturePath $SignaturePath `
        -LicenseId $licenseId `
        -SeatId $seatId `
        -Subject $subject `
        -ExpiresAtUtc $(if ($expiresAt) { $expiresAt.ToString("o") } else { "" }) `
        -Signature $signature
}

$revAgentFunctionAliases = @{
    "Test-RevAgentLicenseSeatFile" = "Test-RevitMcpLicenseSeatFile"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) {
    Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value
}

Export-ModuleMember -Function `
    Test-RevitMcpLicenseSeatFile
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)
