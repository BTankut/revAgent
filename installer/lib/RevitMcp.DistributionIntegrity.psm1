Set-StrictMode -Version Latest

$script:RevitMcpCanonicalizationId = "RFC8785-JCS-SHA256-v1"
$script:RevitMcpSignatureAlgorithm = "RS256"

function ConvertTo-RevitMcpJsonString {
    param([Parameter(Mandatory = $true)][string]$Value)

    $builder = [System.Text.StringBuilder]::new()
    foreach ($character in $Value.ToCharArray()) {
        $code = [int][char]$character
        switch ($code) {
            8 { [void]$builder.Append('\b'); break }
            9 { [void]$builder.Append('\t'); break }
            10 { [void]$builder.Append('\n'); break }
            12 { [void]$builder.Append('\f'); break }
            13 { [void]$builder.Append('\r'); break }
            34 { [void]$builder.Append('\"'); break }
            92 { [void]$builder.Append('\\'); break }
            default {
                if ($code -lt 0x20) {
                    [void]$builder.Append('\u')
                    [void]$builder.Append($code.ToString("x4", [System.Globalization.CultureInfo]::InvariantCulture))
                }
                else {
                    [void]$builder.Append($character)
                }
            }
        }
    }

    return '"' + $builder.ToString() + '"'
}

function Get-RevitMcpObjectPropertyNames {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) {
        return @()
    }

    if ($Value -is [System.Collections.IDictionary]) {
        $names = [System.Collections.Generic.List[string]]::new()
        $seenNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        foreach ($key in $Value.Keys) {
            if ($null -eq $key -or -not ($key -is [string])) {
                $keyType = if ($null -eq $key) { "<null>" } else { $key.GetType().FullName }
                throw "Canonical JSON dictionary keys must be strings. Found key type: $keyType."
            }

            $name = [string]$key
            if (-not $seenNames.Add($name)) {
                throw "Canonical JSON dictionary contains duplicate key: $name"
            }
            [void]$names.Add($name)
        }
        return @($names.ToArray())
    }

    $propertyNames = [System.Collections.Generic.List[string]]::new()
    $seenPropertyNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($property in $Value.PSObject.Properties) {
        if ($property.MemberType -notin @("NoteProperty", "Property")) {
            continue
        }

        $propertyName = [string]$property.Name
        if (-not $seenPropertyNames.Add($propertyName)) {
            throw "Canonical JSON object contains duplicate property: $propertyName"
        }
        [void]$propertyNames.Add($propertyName)
    }

    return @($propertyNames.ToArray())
}

function Get-RevitMcpPsObjectProperty {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Name
    )

    foreach ($property in $Value.PSObject.Properties) {
        if ($property.MemberType -notin @("NoteProperty", "Property")) {
            continue
        }
        if ([string]::Equals([string]$property.Name, $Name, [System.StringComparison]::Ordinal)) {
            return $property
        }
    }

    return $null
}

function Get-RevitMcpObjectPropertyValue {
    param(
        [AllowNull()][object]$Value,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Value) {
        return $null
    }

    if ($Value -is [System.Collections.IDictionary]) {
        if ($Value.Contains($Name)) {
            return ,$Value[$Name]
        }
        return $null
    }

    $property = Get-RevitMcpPsObjectProperty -Value $Value -Name $Name
    if ($property) {
        return ,$property.Value
    }

    return $null
}

function Test-RevitMcpCanonicalInteger {
    param([AllowNull()][object]$Value)

    return $Value -is [byte] -or
        $Value -is [sbyte] -or
        $Value -is [int16] -or
        $Value -is [uint16] -or
        $Value -is [int] -or
        $Value -is [uint32] -or
        $Value -is [long] -or
        $Value -is [uint64]
}

function ConvertTo-RevitMcpCanonicalJson {
    [CmdletBinding()]
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) {
        return "null"
    }

    if ($Value -is [bool]) {
        if ($Value) {
            return "true"
        }
        return "false"
    }

    if (Test-RevitMcpCanonicalInteger -Value $Value) {
        return ([System.IFormattable]$Value).ToString($null, [System.Globalization.CultureInfo]::InvariantCulture)
    }

    if ($Value -is [single] -or $Value -is [double] -or $Value -is [decimal]) {
        throw "Canonical JSON currently supports integers only; floating-point and decimal numbers are rejected for signing determinism."
    }

    if ($Value -is [char] -or $Value -is [string]) {
        return ConvertTo-RevitMcpJsonString -Value ([string]$Value)
    }

    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [System.Collections.IDictionary])) {
        $items = [System.Collections.Generic.List[string]]::new()
        foreach ($item in $Value) {
            [void]$items.Add((ConvertTo-RevitMcpCanonicalJson -Value $item))
        }
        return "[" + (($items.ToArray()) -join ",") + "]"
    }

    # Empty dictionaries and PSCustomObject instances are valid canonical JSON objects.
    $isJsonObject = $Value -is [System.Collections.IDictionary] -or $Value -is [System.Management.Automation.PSCustomObject]
    if (-not $isJsonObject) {
        throw "Unsupported value type for canonical JSON: $($Value.GetType().FullName)"
    }

    $propertyNames = @(Get-RevitMcpObjectPropertyNames -Value $Value)
    [string[]]$sortedNames = @($propertyNames)
    [Array]::Sort($sortedNames, [System.StringComparer]::Ordinal)

    $parts = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $sortedNames) {
        $propertyValue = Get-RevitMcpObjectPropertyValue -Value $Value -Name $name
        [void]$parts.Add(("{0}:{1}" -f (ConvertTo-RevitMcpJsonString -Value $name), (ConvertTo-RevitMcpCanonicalJson -Value $propertyValue)))
    }

    return "{" + (($parts.ToArray()) -join ",") + "}"
}

function Get-RevitMcpCanonicalJsonBytes {
    [CmdletBinding()]
    param([AllowNull()][object]$Value)

    $json = ConvertTo-RevitMcpCanonicalJson -Value $Value
    return ,[System.Text.Encoding]::UTF8.GetBytes($json)
}

function ConvertTo-RevitMcpSha256Hex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash($Bytes)
        return ([System.BitConverter]::ToString($digest) -replace "-", "").ToUpperInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-RevitMcpCanonicalJsonSha256 {
    [CmdletBinding()]
    param([AllowNull()][object]$Value)

    return ConvertTo-RevitMcpSha256Hex -Bytes (Get-RevitMcpCanonicalJsonBytes -Value $Value)
}

function Get-RevitMcpPublicKeyFingerprint {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$PublicKeyXml)

    if ([string]::IsNullOrWhiteSpace($PublicKeyXml)) {
        throw "PublicKeyXml cannot be empty."
    }

    $normalizedPublicKeyXml = $PublicKeyXml.Trim() -replace "\s+", ""
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($normalizedPublicKeyXml)
    return ConvertTo-RevitMcpSha256Hex -Bytes $bytes
}

function New-RevitMcpRsaCryptoServiceProvider {
    $cspParameters = [System.Security.Cryptography.CspParameters]::new(24)
    $cspParameters.Flags = [System.Security.Cryptography.CspProviderFlags]::CreateEphemeralKey
    return [System.Security.Cryptography.RSACryptoServiceProvider]::new($cspParameters)
}

function New-RevitMcpDistributionIntegrityResult {
    param(
        [bool]$Success,
        [string]$Reason,
        [string]$Message,
        [string]$SignedObject = "",
        [string]$KeyId = "",
        [string]$ContentSha256 = ""
    )

    $state = if ($Success) { "verified" } else { "rejected" }
    return [pscustomobject][ordered]@{
        success = $Success
        state = $state
        reason = $Reason
        message = $Message
        signedObject = $SignedObject
        keyId = $KeyId
        contentSha256 = $ContentSha256
        canonicalization = $script:RevitMcpCanonicalizationId
        algorithm = $script:RevitMcpSignatureAlgorithm
    }
}

function Invoke-RevitMcpDistributionIntegrityFailure {
    param(
        [string]$Reason,
        [string]$Message,
        [string]$SignedObject = "",
        [string]$KeyId = "",
        [string]$ContentSha256 = "",
        [switch]$ThrowOnFailure
    )

    if ($ThrowOnFailure) {
        throw "${Reason}: $Message"
    }

    return New-RevitMcpDistributionIntegrityResult `
        -Success $false `
        -Reason $Reason `
        -Message $Message `
        -SignedObject $SignedObject `
        -KeyId $KeyId `
        -ContentSha256 $ContentSha256
}

function Get-RevitMcpRequiredSignatureValue {
    param(
        [Parameter(Mandatory = $true)][object]$SignatureEnvelope,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $value = Get-RevitMcpObjectPropertyValue -Value $SignatureEnvelope -Name $Name
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) {
        throw "Signature envelope is missing required field '$Name'."
    }

    return $value
}

function Get-RevitMcpSignaturePayloadObject {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$SignatureEnvelope)

    return [ordered]@{
        schemaVersion = [int](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "schemaVersion")
        app = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "app")
        signedObject = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "signedObject")
        algorithm = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "algorithm")
        keyId = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "keyId")
        publicKeyFingerprint = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "publicKeyFingerprint")
        canonicalization = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "canonicalization")
        contentSha256 = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "contentSha256")
        createdAtUtc = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "createdAtUtc")
    }
}

function Get-RevitMcpSignaturePayloadCanonicalJson {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$SignatureEnvelope)

    return ConvertTo-RevitMcpCanonicalJson -Value (Get-RevitMcpSignaturePayloadObject -SignatureEnvelope $SignatureEnvelope)
}

function New-RevitMcpJsonScanContext {
    param([Parameter(Mandatory = $true)][string]$Kind)

    if ($Kind -eq "object") {
        return [pscustomobject][ordered]@{
            kind = "object"
            state = "keyOrEnd"
            keys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        }
    }

    return [pscustomobject][ordered]@{
        kind = "array"
        state = "valueOrEnd"
        keys = $null
    }
}

function Set-RevitMcpJsonValueConsumed {
    param([Parameter(Mandatory = $true)][System.Collections.Generic.Stack[object]]$Stack)

    if ($Stack.Count -eq 0) {
        return
    }

    $context = $Stack.Peek()
    if ($context.kind -eq "object" -and $context.state -eq "value") {
        $context.state = "commaOrEnd"
    }
    elseif ($context.kind -eq "array" -and $context.state -in @("valueOrEnd", "value")) {
        $context.state = "commaOrEnd"
    }
}

function Read-RevitMcpJsonStringToken {
    param(
        [Parameter(Mandatory = $true)][string]$Json,
        [Parameter(Mandatory = $true)][ref]$Index
    )

    $builder = [System.Text.StringBuilder]::new()
    $length = $Json.Length
    $i = $Index.Value + 1

    while ($i -lt $length) {
        $character = $Json[$i]
        if ($character -eq '"') {
            $Index.Value = $i
            return $builder.ToString()
        }

        if ($character -eq '\') {
            $i++
            if ($i -ge $length) {
                throw "Invalid JSON string escape."
            }

            $escaped = $Json[$i]
            switch ($escaped) {
                '"' { [void]$builder.Append('"'); break }
                '\' { [void]$builder.Append('\'); break }
                '/' { [void]$builder.Append('/'); break }
                'b' { [void]$builder.Append([char]8); break }
                'f' { [void]$builder.Append([char]12); break }
                'n' { [void]$builder.Append([char]10); break }
                'r' { [void]$builder.Append([char]13); break }
                't' { [void]$builder.Append([char]9); break }
                'u' {
                    if ($i + 4 -ge $length) {
                        throw "Invalid JSON unicode escape."
                    }
                    $hex = $Json.Substring($i + 1, 4)
                    if ($hex -notmatch '^[0-9a-fA-F]{4}$') {
                        throw "Invalid JSON unicode escape."
                    }
                    [void]$builder.Append([char]([Convert]::ToInt32($hex, 16)))
                    $i += 4
                    break
                }
                default {
                    throw "Invalid JSON string escape."
                }
            }

            $i++
            continue
        }

        [void]$builder.Append($character)
        $i++
    }

    throw "Unterminated JSON string."
}

function Find-RevitMcpDuplicateJsonObjectKey {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Json)

    $stack = [System.Collections.Generic.Stack[object]]::new()
    $length = $Json.Length

    for ($i = 0; $i -lt $length; $i++) {
        $character = $Json[$i]
        if ([char]::IsWhiteSpace($character)) {
            continue
        }

        switch ($character) {
            '"' {
                $indexRef = [ref]$i
                $text = Read-RevitMcpJsonStringToken -Json $Json -Index $indexRef
                $i = $indexRef.Value

                if ($stack.Count -gt 0) {
                    $context = $stack.Peek()
                    if ($context.kind -eq "object" -and $context.state -eq "keyOrEnd") {
                        if (-not $context.keys.Add($text)) {
                            return [pscustomobject][ordered]@{ found = $true; key = $text }
                        }
                        $context.state = "colon"
                    }
                    else {
                        Set-RevitMcpJsonValueConsumed -Stack $stack
                    }
                }
                continue
            }
            '{' {
                $stack.Push((New-RevitMcpJsonScanContext -Kind "object"))
                continue
            }
            '[' {
                $stack.Push((New-RevitMcpJsonScanContext -Kind "array"))
                continue
            }
            '}' {
                if ($stack.Count -gt 0 -and $stack.Peek().kind -eq "object") {
                    [void]$stack.Pop()
                    Set-RevitMcpJsonValueConsumed -Stack $stack
                }
                continue
            }
            ']' {
                if ($stack.Count -gt 0 -and $stack.Peek().kind -eq "array") {
                    [void]$stack.Pop()
                    Set-RevitMcpJsonValueConsumed -Stack $stack
                }
                continue
            }
            ':' {
                if ($stack.Count -gt 0) {
                    $context = $stack.Peek()
                    if ($context.kind -eq "object" -and $context.state -eq "colon") {
                        $context.state = "value"
                    }
                }
                continue
            }
            ',' {
                if ($stack.Count -gt 0) {
                    $context = $stack.Peek()
                    if ($context.state -eq "commaOrEnd") {
                        if ($context.kind -eq "object") {
                            $context.state = "keyOrEnd"
                        }
                        else {
                            $context.state = "value"
                        }
                    }
                }
                continue
            }
            default {
                while ($i + 1 -lt $length) {
                    $next = $Json[$i + 1]
                    if ([char]::IsWhiteSpace($next) -or $next -eq ',' -or $next -eq ']' -or $next -eq '}') {
                        break
                    }
                    $i++
                }
                Set-RevitMcpJsonValueConsumed -Stack $stack
            }
        }
    }

    return [pscustomobject][ordered]@{ found = $false; key = "" }
}

function ConvertFrom-RevitMcpJsonPreservingStrings {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Json)

    $convertFromJsonCommand = Get-Command ConvertFrom-Json
    if ($convertFromJsonCommand.Parameters.ContainsKey("DateKind")) {
        return $Json | ConvertFrom-Json -DateKind String
    }

    return $Json | ConvertFrom-Json
}

function Test-RevitMcpSignatureEnvelopeShape {
    param(
        [Parameter(Mandatory = $true)][object]$SignatureEnvelope,
        [string[]]$AllowedSignedObjects = @("channel", "release-manifest"),
        [switch]$ThrowOnFailure
    )

    $expectedFields = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($field in @("schemaVersion", "app", "signedObject", "algorithm", "keyId", "publicKeyFingerprint", "canonicalization", "contentSha256", "createdAtUtc", "signature")) {
        [void]$expectedFields.Add($field)
    }

    foreach ($field in Get-RevitMcpObjectPropertyNames -Value $SignatureEnvelope) {
        if (-not $expectedFields.Contains($field)) {
            return Invoke-RevitMcpDistributionIntegrityFailure -Reason "unexpected_signature_field" -Message "Signature envelope contains unsigned field '$field'." -ThrowOnFailure:$ThrowOnFailure
        }
    }

    try {
        $schemaVersion = [int](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "schemaVersion")
        $app = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "app")
        $signedObject = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "signedObject")
        $algorithm = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "algorithm")
        $canonicalization = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "canonicalization")
        [void](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "keyId")
        [void](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "publicKeyFingerprint")
        [void](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "contentSha256")
        [void](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "createdAtUtc")
        [void](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "signature")
    }
    catch {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "invalid_signature_envelope" -Message $_.Exception.Message -ThrowOnFailure:$ThrowOnFailure
    }

    if ($schemaVersion -ne 1) {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "unsupported_signature_schema" -Message "Unsupported signature envelope schemaVersion '$schemaVersion'." -ThrowOnFailure:$ThrowOnFailure
    }
    if ($app -ne "revit-mcp-skill") {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "invalid_signature_app" -Message "Signature envelope app is '$app', expected 'revit-mcp-skill'." -SignedObject $signedObject -ThrowOnFailure:$ThrowOnFailure
    }
    if ($algorithm -ne $script:RevitMcpSignatureAlgorithm) {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "unsupported_signature_algorithm" -Message "Unsupported signature algorithm '$algorithm'." -SignedObject $signedObject -ThrowOnFailure:$ThrowOnFailure
    }
    if ($canonicalization -ne $script:RevitMcpCanonicalizationId) {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "unsupported_canonicalization" -Message "Unsupported canonicalization '$canonicalization'." -SignedObject $signedObject -ThrowOnFailure:$ThrowOnFailure
    }
    $allowedSignedObjectSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($allowedSignedObject in $AllowedSignedObjects) {
        [void]$allowedSignedObjectSet.Add($allowedSignedObject)
    }
    if (-not $allowedSignedObjectSet.Contains($signedObject)) {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "unsupported_signed_object" -Message "Unsupported signedObject '$signedObject'." -SignedObject $signedObject -ThrowOnFailure:$ThrowOnFailure
    }

    return New-RevitMcpDistributionIntegrityResult -Success $true -Reason "ok" -Message "Signature envelope shape is valid." -SignedObject $signedObject
}

function Test-RevitMcpDetachedJsonSignature {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Content,
        [Parameter(Mandatory = $true)][object]$SignatureEnvelope,
        [Parameter(Mandatory = $true)][hashtable]$TrustedKeys,
        [string[]]$AllowedSignedObjects = @("channel", "release-manifest"),
        [switch]$ThrowOnFailure
    )

    $shape = Test-RevitMcpSignatureEnvelopeShape -SignatureEnvelope $SignatureEnvelope -AllowedSignedObjects $AllowedSignedObjects -ThrowOnFailure:$ThrowOnFailure
    if (-not $shape.success) {
        return $shape
    }

    $signedObject = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "signedObject")
    $keyId = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "keyId")
    $expectedContentSha256 = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "contentSha256")
    $actualContentSha256 = Get-RevitMcpCanonicalJsonSha256 -Value $Content
    if (-not [string]::Equals($actualContentSha256, $expectedContentSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
        return Invoke-RevitMcpDistributionIntegrityFailure `
            -Reason "content_hash_mismatch" `
            -Message "Canonical content hash does not match the detached signature envelope." `
            -SignedObject $signedObject `
            -KeyId $keyId `
            -ContentSha256 $actualContentSha256 `
            -ThrowOnFailure:$ThrowOnFailure
    }

    if ($null -eq $TrustedKeys -or -not $TrustedKeys.ContainsKey($keyId)) {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "unknown_key_id" -Message "Trusted public key was not found for keyId '$keyId'." -SignedObject $signedObject -KeyId $keyId -ContentSha256 $actualContentSha256 -ThrowOnFailure:$ThrowOnFailure
    }

    $trustedKey = $TrustedKeys[$keyId]
    $publicKeyXml = [string](Get-RevitMcpObjectPropertyValue -Value $trustedKey -Name "publicKeyXml")
    if ([string]::IsNullOrWhiteSpace($publicKeyXml)) {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "invalid_trusted_key" -Message "Trusted key '$keyId' does not include publicKeyXml." -SignedObject $signedObject -KeyId $keyId -ContentSha256 $actualContentSha256 -ThrowOnFailure:$ThrowOnFailure
    }

    $trustedFingerprint = [string](Get-RevitMcpObjectPropertyValue -Value $trustedKey -Name "publicKeyFingerprint")
    if ([string]::IsNullOrWhiteSpace($trustedFingerprint)) {
        $trustedFingerprint = Get-RevitMcpPublicKeyFingerprint -PublicKeyXml $publicKeyXml
    }
    $envelopeFingerprint = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "publicKeyFingerprint")
    if (-not [string]::Equals($trustedFingerprint, $envelopeFingerprint, [System.StringComparison]::OrdinalIgnoreCase)) {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "wrong_public_key_fingerprint" -Message "Signature envelope fingerprint does not match trusted key '$keyId'." -SignedObject $signedObject -KeyId $keyId -ContentSha256 $actualContentSha256 -ThrowOnFailure:$ThrowOnFailure
    }

    $signature = [string](Get-RevitMcpRequiredSignatureValue -SignatureEnvelope $SignatureEnvelope -Name "signature")
    try {
        $signatureBytes = [Convert]::FromBase64String($signature)
    }
    catch {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "invalid_signature_encoding" -Message "Signature is not valid base64." -SignedObject $signedObject -KeyId $keyId -ContentSha256 $actualContentSha256 -ThrowOnFailure:$ThrowOnFailure
    }

    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes((Get-RevitMcpSignaturePayloadCanonicalJson -SignatureEnvelope $SignatureEnvelope))
    $rsa = New-RevitMcpRsaCryptoServiceProvider
    try {
        $rsa.FromXmlString($publicKeyXml)
        $verified = $rsa.VerifyData($payloadBytes, "SHA256", $signatureBytes)
    }
    catch {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "signature_verification_error" -Message $_.Exception.Message -SignedObject $signedObject -KeyId $keyId -ContentSha256 $actualContentSha256 -ThrowOnFailure:$ThrowOnFailure
    }
    finally {
        $rsa.Dispose()
    }

    if (-not $verified) {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "signature_verification_failed" -Message "Detached signature did not verify." -SignedObject $signedObject -KeyId $keyId -ContentSha256 $actualContentSha256 -ThrowOnFailure:$ThrowOnFailure
    }

    return New-RevitMcpDistributionIntegrityResult -Success $true -Reason "ok" -Message "Detached JSON signature verified." -SignedObject $signedObject -KeyId $keyId -ContentSha256 $actualContentSha256
}

function Test-RevitMcpDetachedJsonSignatureFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ContentPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [Parameter(Mandatory = $true)][hashtable]$TrustedKeys,
        [string[]]$AllowedSignedObjects = @("channel", "release-manifest"),
        [switch]$ThrowOnFailure
    )

    if (-not (Test-Path -LiteralPath $ContentPath -PathType Leaf)) {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "content_file_missing" -Message "Signed content file was not found: $ContentPath" -ThrowOnFailure:$ThrowOnFailure
    }
    if (-not (Test-Path -LiteralPath $SignaturePath -PathType Leaf)) {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "signature_file_missing" -Message "Signature envelope file was not found: $SignaturePath" -ThrowOnFailure:$ThrowOnFailure
    }

    try {
        $contentJson = Get-Content -Raw -LiteralPath $ContentPath -Encoding UTF8
        $signatureJson = Get-Content -Raw -LiteralPath $SignaturePath -Encoding UTF8
        $contentDuplicate = Find-RevitMcpDuplicateJsonObjectKey -Json $contentJson
        if ($contentDuplicate.found) {
            return Invoke-RevitMcpDistributionIntegrityFailure -Reason "duplicate_json_key" -Message "Signed content JSON contains duplicate object key '$($contentDuplicate.key)'." -ThrowOnFailure:$ThrowOnFailure
        }
        $signatureDuplicate = Find-RevitMcpDuplicateJsonObjectKey -Json $signatureJson
        if ($signatureDuplicate.found) {
            return Invoke-RevitMcpDistributionIntegrityFailure -Reason "duplicate_json_key" -Message "Signature envelope JSON contains duplicate object key '$($signatureDuplicate.key)'." -ThrowOnFailure:$ThrowOnFailure
        }
        $content = ConvertFrom-RevitMcpJsonPreservingStrings -Json $contentJson
        $signatureEnvelope = ConvertFrom-RevitMcpJsonPreservingStrings -Json $signatureJson
    }
    catch {
        return Invoke-RevitMcpDistributionIntegrityFailure -Reason "invalid_json_file" -Message $_.Exception.Message -ThrowOnFailure:$ThrowOnFailure
    }

    return Test-RevitMcpDetachedJsonSignature `
        -Content $content `
        -SignatureEnvelope $signatureEnvelope `
        -TrustedKeys $TrustedKeys `
        -AllowedSignedObjects $AllowedSignedObjects `
        -ThrowOnFailure:$ThrowOnFailure
}

Export-ModuleMember -Function `
    ConvertTo-RevitMcpCanonicalJson, `
    Get-RevitMcpCanonicalJsonBytes, `
    Get-RevitMcpCanonicalJsonSha256, `
    Get-RevitMcpPublicKeyFingerprint, `
    Get-RevitMcpSignaturePayloadCanonicalJson, `
    Test-RevitMcpDetachedJsonSignature, `
    Test-RevitMcpDetachedJsonSignatureFile
