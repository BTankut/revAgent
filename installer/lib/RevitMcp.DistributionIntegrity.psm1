Set-StrictMode -Version Latest

$script:RevitMcpCanonicalizationId = "RFC8785-JCS-SHA256-v1"
$script:RevitMcpSignatureAlgorithm = "RS256"

function ConvertTo-RevitMcpJsonString {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

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
    param([AllowNull()][AllowEmptyString()][object]$Value)

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
    param([AllowNull()][AllowEmptyString()][object]$Value)

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
    param([AllowNull()][AllowEmptyString()][object]$Value)

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

function Get-RevitMcpPublicKeyXmlFromPrivateKeyXml {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$PrivateKeyXml)

    if ([string]::IsNullOrWhiteSpace($PrivateKeyXml)) {
        throw "PrivateKeyXml cannot be empty."
    }

    $rsa = New-RevitMcpRsaCryptoServiceProvider
    try {
        $rsa.FromXmlString($PrivateKeyXml)
        return $rsa.ToXmlString($false)
    }
    finally {
        $rsa.Dispose()
    }
}

function New-RevitMcpDetachedJsonSignature {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Content,
        [Parameter(Mandatory = $true)][string]$SignedObject,
        [Parameter(Mandatory = $true)][string]$KeyId,
        [Parameter(Mandatory = $true)][string]$PrivateKeyXml,
        [string]$CreatedAtUtc = ""
    )

    if ([string]::IsNullOrWhiteSpace($SignedObject)) {
        throw "SignedObject cannot be empty."
    }
    if ([string]::IsNullOrWhiteSpace($KeyId)) {
        throw "KeyId cannot be empty."
    }
    if ([string]::IsNullOrWhiteSpace($CreatedAtUtc)) {
        $CreatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    $allowedSignedObjects = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($allowedSignedObject in @("channel", "release-manifest", "license-seat")) {
        [void]$allowedSignedObjects.Add($allowedSignedObject)
    }
    if (-not $allowedSignedObjects.Contains($SignedObject)) {
        throw "Unsupported signedObject '$SignedObject'."
    }

    $publicKeyXml = Get-RevitMcpPublicKeyXmlFromPrivateKeyXml -PrivateKeyXml $PrivateKeyXml
    $envelope = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        signedObject = $SignedObject
        algorithm = $script:RevitMcpSignatureAlgorithm
        keyId = $KeyId
        publicKeyFingerprint = Get-RevitMcpPublicKeyFingerprint -PublicKeyXml $publicKeyXml
        canonicalization = $script:RevitMcpCanonicalizationId
        contentSha256 = Get-RevitMcpCanonicalJsonSha256 -Value $Content
        createdAtUtc = $CreatedAtUtc
        signature = ""
    }

    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes((Get-RevitMcpSignaturePayloadCanonicalJson -SignatureEnvelope $envelope))
    $rsa = New-RevitMcpRsaCryptoServiceProvider
    try {
        $rsa.FromXmlString($PrivateKeyXml)
        $signatureBytes = $rsa.SignData($payloadBytes, "SHA256")
        $envelope["signature"] = [Convert]::ToBase64String($signatureBytes)
    }
    finally {
        $rsa.Dispose()
    }

    [void](Test-RevitMcpSignatureEnvelopeShape -SignatureEnvelope $envelope -AllowedSignedObjects @("channel", "release-manifest", "license-seat") -ThrowOnFailure)
    return $envelope
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

function ConvertTo-RevitMcpTrustedKeyMap {
    param([AllowNull()][object]$TrustedKeys)

    $map = @{}
    if ($null -eq $TrustedKeys) {
        return $map
    }

    if ($TrustedKeys -is [System.Collections.IDictionary]) {
        foreach ($key in $TrustedKeys.Keys) {
            if ($null -eq $key -or [string]::IsNullOrWhiteSpace([string]$key)) {
                continue
            }
            $map[[string]$key] = $TrustedKeys[$key]
        }
        return $map
    }

    if ($TrustedKeys -is [System.Collections.IEnumerable] -and -not ($TrustedKeys -is [string])) {
        foreach ($entry in $TrustedKeys) {
            if ($null -eq $entry) {
                continue
            }
            $keyId = [string](Get-RevitMcpObjectPropertyValue -Value $entry -Name "keyId")
            if (-not [string]::IsNullOrWhiteSpace($keyId)) {
                $map[$keyId] = $entry
            }
        }
        if ($map.Count -gt 0) {
            return $map
        }
    }

    foreach ($property in $TrustedKeys.PSObject.Properties) {
        if ($property.MemberType -notin @("NoteProperty", "Property")) {
            continue
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$property.Name)) {
            $map[[string]$property.Name] = $property.Value
        }
    }

    return $map
}

function Get-RevitMcpDetachedSignaturePath {
    param([Parameter(Mandatory = $true)][string]$ContentPath)

    $directory = Split-Path -Parent $ContentPath
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($ContentPath)
    return Join-Path $directory ("{0}.sig.json" -f $baseName)
}

function New-RevitMcpDetachedJsonSignatureCompatibilityResult {
    param(
        [bool]$Success,
        [string]$State,
        [string]$Reason,
        [string]$Message,
        [string]$SignedObject,
        [string]$ContentPath,
        [string]$SignaturePath,
        [bool]$SignaturePresent,
        [string]$Policy,
        [int]$TrustedKeyCount = 0,
        [string]$KeyId = "",
        [string]$ContentSha256 = "",
        [string]$Canonicalization = $script:RevitMcpCanonicalizationId,
        [string]$Algorithm = $script:RevitMcpSignatureAlgorithm
    )

    return [pscustomobject][ordered]@{
        success = $Success
        state = $State
        reason = $Reason
        message = $Message
        signedObject = $SignedObject
        contentPath = $ContentPath
        signaturePath = $SignaturePath
        signaturePresent = $SignaturePresent
        policy = $Policy
        trustedKeyCount = $TrustedKeyCount
        keyId = $KeyId
        contentSha256 = $ContentSha256
        canonicalization = $Canonicalization
        algorithm = $Algorithm
    }
}

function Test-RevitMcpDetachedJsonSignatureCompatibilityFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ContentPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [Parameter(Mandatory = $true)][object]$TrustedKeys,
        [Parameter(Mandatory = $true)][string]$SignedObject,
        [ValidateSet("compatibility", "enforce")]
        [string]$Policy = "compatibility"
    )

    $trustedKeyMap = ConvertTo-RevitMcpTrustedKeyMap -TrustedKeys $TrustedKeys
    if (-not (Test-Path -LiteralPath $SignaturePath -PathType Leaf)) {
        if ($Policy -eq "compatibility") {
            return New-RevitMcpDetachedJsonSignatureCompatibilityResult `
                -Success $true `
                -State "legacy-compatible" `
                -Reason "unsigned_legacy_release" `
                -Message "Detached signature is absent; unsigned legacy release is accepted in compatibility mode." `
                -SignedObject $SignedObject `
                -ContentPath $ContentPath `
                -SignaturePath $SignaturePath `
                -SignaturePresent $false `
                -Policy $Policy `
                -TrustedKeyCount $trustedKeyMap.Count
        }

        return New-RevitMcpDetachedJsonSignatureCompatibilityResult `
            -Success $false `
            -State "rejected" `
            -Reason "signature_required" `
            -Message "Detached signature is required by release integrity policy." `
            -SignedObject $SignedObject `
            -ContentPath $ContentPath `
            -SignaturePath $SignaturePath `
            -SignaturePresent $false `
            -Policy $Policy `
            -TrustedKeyCount $trustedKeyMap.Count
    }

    $result = Test-RevitMcpDetachedJsonSignatureFile `
        -ContentPath $ContentPath `
        -SignaturePath $SignaturePath `
        -TrustedKeys $trustedKeyMap `
        -AllowedSignedObjects @($SignedObject)

    return New-RevitMcpDetachedJsonSignatureCompatibilityResult `
        -Success ([bool]$result.success) `
        -State $(if ($result.success) { "verified" } else { "rejected" }) `
        -Reason ([string]$result.reason) `
        -Message ([string]$result.message) `
        -SignedObject $SignedObject `
        -ContentPath $ContentPath `
        -SignaturePath $SignaturePath `
        -SignaturePresent $true `
        -Policy $Policy `
        -TrustedKeyCount $trustedKeyMap.Count `
        -KeyId ([string]$result.keyId) `
        -ContentSha256 ([string]$result.contentSha256) `
        -Canonicalization ([string]$result.canonicalization) `
        -Algorithm ([string]$result.algorithm)
}

function Test-RevitMcpReleaseManifestChannelConsistency {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Channel,
        [Parameter(Mandatory = $true)][object]$ReleaseManifest
    )

    $issues = [System.Collections.Generic.List[string]]::new()
    $manifestApp = [string](Get-RevitMcpObjectPropertyValue -Value $ReleaseManifest -Name "app")
    if (-not [string]::IsNullOrWhiteSpace($manifestApp) -and $manifestApp -ne "revit-mcp-skill") {
        [void]$issues.Add("release manifest app is '$manifestApp'")
    }

    $channelVersion = [string](Get-RevitMcpObjectPropertyValue -Value $Channel -Name "version")
    $manifestVersion = [string](Get-RevitMcpObjectPropertyValue -Value $ReleaseManifest -Name "version")
    if (-not [string]::Equals($channelVersion, $manifestVersion, [System.StringComparison]::Ordinal)) {
        [void]$issues.Add("version mismatch '$channelVersion' != '$manifestVersion'")
    }

    $channelName = [string](Get-RevitMcpObjectPropertyValue -Value $Channel -Name "channel")
    $manifestChannel = [string](Get-RevitMcpObjectPropertyValue -Value $ReleaseManifest -Name "channel")
    if (-not [string]::IsNullOrWhiteSpace($manifestChannel) -and -not [string]::Equals($channelName, $manifestChannel, [System.StringComparison]::Ordinal)) {
        [void]$issues.Add("channel mismatch '$channelName' != '$manifestChannel'")
    }

    $manifestPackage = Get-RevitMcpObjectPropertyValue -Value $ReleaseManifest -Name "package"
    $channelSha = [string](Get-RevitMcpObjectPropertyValue -Value $Channel -Name "sha256")
    $manifestSha = [string](Get-RevitMcpObjectPropertyValue -Value $manifestPackage -Name "sha256")
    if (-not [string]::IsNullOrWhiteSpace($manifestSha) -and -not [string]::Equals($channelSha, $manifestSha, [System.StringComparison]::OrdinalIgnoreCase)) {
        [void]$issues.Add("package SHA mismatch")
    }

    $channelPackagePath = [string](Get-RevitMcpObjectPropertyValue -Value $Channel -Name "packagePath")
    $manifestPackagePath = [string](Get-RevitMcpObjectPropertyValue -Value $manifestPackage -Name "path")
    if (-not [string]::IsNullOrWhiteSpace($manifestPackagePath) -and -not [string]::Equals($channelPackagePath, $manifestPackagePath, [System.StringComparison]::OrdinalIgnoreCase)) {
        [void]$issues.Add("package path mismatch")
    }

    $channelReleaseSequence = [string](Get-RevitMcpObjectPropertyValue -Value $Channel -Name "releaseSequence")
    $manifestReleaseSequence = [string](Get-RevitMcpObjectPropertyValue -Value $ReleaseManifest -Name "releaseSequence")
    if (-not [string]::IsNullOrWhiteSpace($channelReleaseSequence) -and
        -not [string]::IsNullOrWhiteSpace($manifestReleaseSequence) -and
        -not [string]::Equals($channelReleaseSequence, $manifestReleaseSequence, [System.StringComparison]::Ordinal)) {
        [void]$issues.Add("release sequence mismatch '$channelReleaseSequence' != '$manifestReleaseSequence'")
    }

    $channelMinimumSequence = [string](Get-RevitMcpObjectPropertyValue -Value $Channel -Name "minimumAcceptedReleaseSequence")
    $manifestMinimumSequence = [string](Get-RevitMcpObjectPropertyValue -Value $ReleaseManifest -Name "minimumAcceptedReleaseSequence")
    if (-not [string]::IsNullOrWhiteSpace($channelMinimumSequence) -and
        -not [string]::IsNullOrWhiteSpace($manifestMinimumSequence) -and
        -not [string]::Equals($channelMinimumSequence, $manifestMinimumSequence, [System.StringComparison]::Ordinal)) {
        [void]$issues.Add("minimum accepted release sequence mismatch '$channelMinimumSequence' != '$manifestMinimumSequence'")
    }

    if ($issues.Count -gt 0) {
        return [pscustomobject][ordered]@{
            success = $false
            state = "rejected"
            reason = "channel_manifest_mismatch"
            message = "Signed channel and release manifest metadata do not agree: $($issues.ToArray() -join '; ')."
        }
    }

    return [pscustomobject][ordered]@{
        success = $true
        state = "verified"
        reason = "ok"
        message = "Signed channel and release manifest metadata are consistent."
    }
}

function Get-RevitMcpInt64Claim {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $raw = Get-RevitMcpObjectPropertyValue -Value $Value -Name $Name
    if ($null -eq $raw -or [string]::IsNullOrWhiteSpace([string]$raw)) {
        return [pscustomobject][ordered]@{
            hasValue = $false
            value = [long]0
            reason = "missing"
        }
    }

    $parsed = [long]0
    if (-not [long]::TryParse([string]$raw, [System.Globalization.NumberStyles]::Integer, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        return [pscustomobject][ordered]@{
            hasValue = $false
            value = [long]0
            reason = "invalid"
            raw = [string]$raw
        }
    }

    return [pscustomobject][ordered]@{
        hasValue = $true
        value = $parsed
        reason = "ok"
        raw = [string]$raw
    }
}

function New-RevitMcpReleaseSequenceResult {
    param(
        [bool]$Success,
        [string]$State,
        [string]$Reason,
        [string]$Message,
        [long]$ReleaseSequence = 0,
        [long]$MinimumAcceptedReleaseSequence = 0,
        [long]$PreviousHighestAcceptedReleaseSequence = 0,
        [long]$HighestAcceptedReleaseSequence = 0,
        [bool]$RollbackAllowed = $false
    )

    return [pscustomobject][ordered]@{
        success = $Success
        state = $State
        reason = $Reason
        message = $Message
        releaseSequence = $ReleaseSequence
        minimumAcceptedReleaseSequence = $MinimumAcceptedReleaseSequence
        previousHighestAcceptedReleaseSequence = $PreviousHighestAcceptedReleaseSequence
        highestAcceptedReleaseSequence = $HighestAcceptedReleaseSequence
        rollbackAllowed = $RollbackAllowed
    }
}

function Test-RevitMcpSignedReleaseSequence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Channel,
        [Parameter(Mandatory = $true)][object]$ReleaseManifest,
        [long]$HighestAcceptedReleaseSequence = 0,
        [switch]$AllowRollback
    )

    $channelSequence = Get-RevitMcpInt64Claim -Value $Channel -Name "releaseSequence"
    $manifestSequence = Get-RevitMcpInt64Claim -Value $ReleaseManifest -Name "releaseSequence"
    if (-not [bool]$channelSequence.hasValue -or -not [bool]$manifestSequence.hasValue) {
        return New-RevitMcpReleaseSequenceResult `
            -Success $false `
            -State "rejected" `
            -Reason "missing_release_sequence" `
            -Message "Signed releases must include releaseSequence in both channel and release manifest." `
            -PreviousHighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence
    }

    if ($channelSequence.value -le 0 -or $manifestSequence.value -le 0) {
        return New-RevitMcpReleaseSequenceResult `
            -Success $false `
            -State "rejected" `
            -Reason "invalid_release_sequence" `
            -Message "Signed releaseSequence values must be positive integers." `
            -PreviousHighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence
    }

    if ($channelSequence.value -ne $manifestSequence.value) {
        return New-RevitMcpReleaseSequenceResult `
            -Success $false `
            -State "rejected" `
            -Reason "release_sequence_mismatch" `
            -Message "Signed channel and release manifest releaseSequence values do not match." `
            -ReleaseSequence $channelSequence.value `
            -PreviousHighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence
    }

    $releaseSequence = [long]$channelSequence.value
    $channelMinimum = Get-RevitMcpInt64Claim -Value $Channel -Name "minimumAcceptedReleaseSequence"
    $manifestMinimum = Get-RevitMcpInt64Claim -Value $ReleaseManifest -Name "minimumAcceptedReleaseSequence"
    $minimumAcceptedReleaseSequence = [long]0
    if ([bool]$channelMinimum.hasValue -or [bool]$manifestMinimum.hasValue) {
        if (-not [bool]$channelMinimum.hasValue -or -not [bool]$manifestMinimum.hasValue) {
            return New-RevitMcpReleaseSequenceResult `
                -Success $false `
                -State "rejected" `
                -Reason "minimum_sequence_mismatch" `
                -Message "minimumAcceptedReleaseSequence must be present in both channel and release manifest when used." `
                -ReleaseSequence $releaseSequence `
                -PreviousHighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence
        }
        if ($channelMinimum.value -ne $manifestMinimum.value) {
            return New-RevitMcpReleaseSequenceResult `
                -Success $false `
                -State "rejected" `
                -Reason "minimum_sequence_mismatch" `
                -Message "Signed channel and release manifest minimumAcceptedReleaseSequence values do not match." `
                -ReleaseSequence $releaseSequence `
                -PreviousHighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence
        }
        if ($channelMinimum.value -lt 0 -or $manifestMinimum.value -lt 0) {
            return New-RevitMcpReleaseSequenceResult `
                -Success $false `
                -State "rejected" `
                -Reason "invalid_minimum_sequence" `
                -Message "minimumAcceptedReleaseSequence must be zero or a positive integer." `
                -ReleaseSequence $releaseSequence `
                -PreviousHighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence
        }
        $minimumAcceptedReleaseSequence = [long]$channelMinimum.value
    }

    if ($minimumAcceptedReleaseSequence -gt $releaseSequence) {
        return New-RevitMcpReleaseSequenceResult `
            -Success $false `
            -State "rejected" `
            -Reason "minimum_sequence_exceeds_release_sequence" `
            -Message "minimumAcceptedReleaseSequence cannot be greater than releaseSequence." `
            -ReleaseSequence $releaseSequence `
            -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence `
            -PreviousHighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence
    }

    if ($releaseSequence -lt $HighestAcceptedReleaseSequence -and -not $AllowRollback) {
        return New-RevitMcpReleaseSequenceResult `
            -Success $false `
            -State "rejected" `
            -Reason "signed_release_replay" `
            -Message "Signed releaseSequence '$releaseSequence' is older than highest accepted '$HighestAcceptedReleaseSequence'." `
            -ReleaseSequence $releaseSequence `
            -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence `
            -PreviousHighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence `
            -HighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence
    }

    $nextHighest = [Math]::Max([Math]::Max($HighestAcceptedReleaseSequence, $releaseSequence), $minimumAcceptedReleaseSequence)
    return New-RevitMcpReleaseSequenceResult `
        -Success $true `
        -State $(if ($releaseSequence -lt $HighestAcceptedReleaseSequence) { "rollback-allowed" } else { "verified" }) `
        -Reason "ok" `
        -Message $(if ($releaseSequence -lt $HighestAcceptedReleaseSequence) { "Explicit rollback flag allowed this older signed release." } else { "Signed release sequence is accepted." }) `
        -ReleaseSequence $releaseSequence `
        -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence `
        -PreviousHighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence `
        -HighestAcceptedReleaseSequence $nextHighest `
        -RollbackAllowed:($releaseSequence -lt $HighestAcceptedReleaseSequence)
}

function New-RevitMcpReleaseDistributionIntegrityAggregate {
    param(
        [bool]$Success,
        [string]$State,
        [string]$Reason,
        [string]$Message,
        [string]$Policy,
        [int]$TrustedKeyCount,
        [object]$ChannelSignature,
        [object]$ReleaseManifestSignature,
        [object]$Consistency,
        [object]$ReleaseSequence = $null
    )

    $releaseSequenceValue = if ($ReleaseSequence) { [long]$ReleaseSequence.releaseSequence } else { [long]0 }
    $minimumAcceptedReleaseSequence = if ($ReleaseSequence) { [long]$ReleaseSequence.minimumAcceptedReleaseSequence } else { [long]0 }
    $highestAcceptedReleaseSequence = if ($ReleaseSequence) { [long]$ReleaseSequence.highestAcceptedReleaseSequence } else { [long]0 }
    $rollbackAllowed = if ($ReleaseSequence) { [bool]$ReleaseSequence.rollbackAllowed } else { $false }

    return [pscustomobject][ordered]@{
        success = $Success
        state = $State
        reason = $Reason
        message = $Message
        policy = $Policy
        trustedKeyCount = $TrustedKeyCount
        channelSignature = $ChannelSignature
        releaseManifestSignature = $ReleaseManifestSignature
        consistency = $Consistency
        releaseSequence = $releaseSequenceValue
        minimumAcceptedReleaseSequence = $minimumAcceptedReleaseSequence
        highestAcceptedReleaseSequence = $highestAcceptedReleaseSequence
        rollbackAllowed = $rollbackAllowed
        releaseSequenceCheck = $ReleaseSequence
    }
}

function Test-RevitMcpReleaseDistributionIntegrity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ChannelPath,
        [Parameter(Mandatory = $true)][object]$Channel,
        [string]$ReleaseManifestPath = "",
        [AllowNull()][object]$ReleaseManifest = $null,
        [Parameter(Mandatory = $true)][object]$TrustedKeys,
        [ValidateSet("compatibility", "enforce")]
        [string]$Policy = "compatibility",
        [long]$HighestAcceptedReleaseSequence = 0,
        [switch]$AllowRollback
    )

    $trustedKeyMap = ConvertTo-RevitMcpTrustedKeyMap -TrustedKeys $TrustedKeys
    $channelSignaturePath = Get-RevitMcpDetachedSignaturePath -ContentPath $ChannelPath
    $channelSignature = Test-RevitMcpDetachedJsonSignatureCompatibilityFile `
        -ContentPath $ChannelPath `
        -SignaturePath $channelSignaturePath `
        -TrustedKeys $trustedKeyMap `
        -SignedObject "channel" `
        -Policy $Policy

    $releaseManifestSignature = $null
    if ([string]::IsNullOrWhiteSpace($ReleaseManifestPath)) {
        $releaseManifestSignature = New-RevitMcpDetachedJsonSignatureCompatibilityResult `
            -Success ($Policy -eq "compatibility") `
            -State $(if ($Policy -eq "compatibility") { "legacy-compatible" } else { "rejected" }) `
            -Reason $(if ($Policy -eq "compatibility") { "release_manifest_not_declared" } else { "release_manifest_required" }) `
            -Message $(if ($Policy -eq "compatibility") { "Release manifest is absent; unsigned legacy release is accepted in compatibility mode." } else { "Release manifest is required by release integrity policy." }) `
            -SignedObject "release-manifest" `
            -ContentPath "" `
            -SignaturePath "" `
            -SignaturePresent $false `
            -Policy $Policy `
            -TrustedKeyCount $trustedKeyMap.Count
    }
    else {
        $releaseManifestSignaturePath = Get-RevitMcpDetachedSignaturePath -ContentPath $ReleaseManifestPath
        $releaseManifestSignature = Test-RevitMcpDetachedJsonSignatureCompatibilityFile `
            -ContentPath $ReleaseManifestPath `
            -SignaturePath $releaseManifestSignaturePath `
            -TrustedKeys $trustedKeyMap `
            -SignedObject "release-manifest" `
            -Policy $Policy
    }

    $unsignedLegacyConsistency = [pscustomobject][ordered]@{
        success = $true
        state = "skipped"
        reason = "unsigned_legacy_release"
        message = "Release manifest consistency is not enforced for unsigned legacy releases in compatibility mode."
    }
    $unsignedRejectedConsistency = [pscustomobject][ordered]@{
        success = $false
        state = "rejected"
        reason = "unsigned_release_rejected"
        message = "Release manifest consistency was not evaluated because the unsigned release was rejected by integrity policy."
    }
    $consistency = $unsignedLegacyConsistency

    $anySignaturePresent = [bool]$channelSignature.signaturePresent -or [bool]$releaseManifestSignature.signaturePresent
    if (-not $anySignaturePresent) {
        if ($HighestAcceptedReleaseSequence -gt 0) {
            return New-RevitMcpReleaseDistributionIntegrityAggregate `
                -Success $false `
                -State "rejected" `
                -Reason "unsigned_release_after_signed_acceptance" `
                -Message "Unsigned legacy releases are rejected after a signed release has been accepted on this workstation." `
                -Policy $Policy `
                -TrustedKeyCount $trustedKeyMap.Count `
                -ChannelSignature $channelSignature `
                -ReleaseManifestSignature $releaseManifestSignature `
                -Consistency $unsignedRejectedConsistency
        }

        if ($trustedKeyMap.Count -gt 0) {
            return New-RevitMcpReleaseDistributionIntegrityAggregate `
                -Success $false `
                -State "rejected" `
                -Reason "signature_required" `
                -Message "Trusted release keys are configured; unsigned releases are rejected even in compatibility mode." `
                -Policy $Policy `
                -TrustedKeyCount $trustedKeyMap.Count `
                -ChannelSignature $channelSignature `
                -ReleaseManifestSignature $releaseManifestSignature `
                -Consistency $unsignedRejectedConsistency
        }

        if ($Policy -eq "compatibility") {
            return New-RevitMcpReleaseDistributionIntegrityAggregate `
                -Success $true `
                -State "legacy-compatible" `
                -Reason "unsigned_legacy_release" `
                -Message "Unsigned legacy release accepted in compatibility mode." `
                -Policy $Policy `
                -TrustedKeyCount $trustedKeyMap.Count `
                -ChannelSignature $channelSignature `
                -ReleaseManifestSignature $releaseManifestSignature `
                -Consistency $consistency
        }

        return New-RevitMcpReleaseDistributionIntegrityAggregate `
            -Success $false `
            -State "rejected" `
            -Reason "signature_required" `
            -Message "Signed channel and release manifest are required by release integrity policy." `
            -Policy $Policy `
            -TrustedKeyCount $trustedKeyMap.Count `
            -ChannelSignature $channelSignature `
            -ReleaseManifestSignature $releaseManifestSignature `
            -Consistency $unsignedRejectedConsistency
    }

    if (-not [bool]$channelSignature.signaturePresent -or -not [bool]$releaseManifestSignature.signaturePresent) {
        return New-RevitMcpReleaseDistributionIntegrityAggregate `
            -Success $false `
            -State "rejected" `
            -Reason "partial_signature_set" `
            -Message "Signed releases must include both channel and release-manifest detached signatures." `
            -Policy $Policy `
            -TrustedKeyCount $trustedKeyMap.Count `
            -ChannelSignature $channelSignature `
            -ReleaseManifestSignature $releaseManifestSignature `
            -Consistency $unsignedRejectedConsistency
    }

    if (-not [bool]$channelSignature.success) {
        return New-RevitMcpReleaseDistributionIntegrityAggregate `
            -Success $false `
            -State "rejected" `
            -Reason "channel_signature_failed" `
            -Message ([string]$channelSignature.message) `
            -Policy $Policy `
            -TrustedKeyCount $trustedKeyMap.Count `
            -ChannelSignature $channelSignature `
            -ReleaseManifestSignature $releaseManifestSignature `
            -Consistency $consistency
    }

    if (-not [bool]$releaseManifestSignature.success) {
        return New-RevitMcpReleaseDistributionIntegrityAggregate `
            -Success $false `
            -State "rejected" `
            -Reason "release_manifest_signature_failed" `
            -Message ([string]$releaseManifestSignature.message) `
            -Policy $Policy `
            -TrustedKeyCount $trustedKeyMap.Count `
            -ChannelSignature $channelSignature `
            -ReleaseManifestSignature $releaseManifestSignature `
            -Consistency $consistency
    }

    if ($null -eq $ReleaseManifest) {
        return New-RevitMcpReleaseDistributionIntegrityAggregate `
            -Success $false `
            -State "rejected" `
            -Reason "release_manifest_missing" `
            -Message "Signed release manifest JSON could not be loaded." `
            -Policy $Policy `
            -TrustedKeyCount $trustedKeyMap.Count `
            -ChannelSignature $channelSignature `
            -ReleaseManifestSignature $releaseManifestSignature `
            -Consistency $consistency
    }

    $consistency = Test-RevitMcpReleaseManifestChannelConsistency -Channel $Channel -ReleaseManifest $ReleaseManifest
    if (-not [bool]$consistency.success) {
        return New-RevitMcpReleaseDistributionIntegrityAggregate `
            -Success $false `
            -State "rejected" `
            -Reason ([string]$consistency.reason) `
            -Message ([string]$consistency.message) `
            -Policy $Policy `
            -TrustedKeyCount $trustedKeyMap.Count `
            -ChannelSignature $channelSignature `
            -ReleaseManifestSignature $releaseManifestSignature `
            -Consistency $consistency
    }

    $releaseSequence = Test-RevitMcpSignedReleaseSequence `
        -Channel $Channel `
        -ReleaseManifest $ReleaseManifest `
        -HighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence `
        -AllowRollback:$AllowRollback
    if (-not [bool]$releaseSequence.success) {
        return New-RevitMcpReleaseDistributionIntegrityAggregate `
            -Success $false `
            -State "rejected" `
            -Reason ([string]$releaseSequence.reason) `
            -Message ([string]$releaseSequence.message) `
            -Policy $Policy `
            -TrustedKeyCount $trustedKeyMap.Count `
            -ChannelSignature $channelSignature `
            -ReleaseManifestSignature $releaseManifestSignature `
            -Consistency $consistency `
            -ReleaseSequence $releaseSequence
    }

    return New-RevitMcpReleaseDistributionIntegrityAggregate `
        -Success $true `
        -State $(if ($releaseSequence.rollbackAllowed) { "rollback-allowed" } else { "verified" }) `
        -Reason "ok" `
        -Message $(if ($releaseSequence.rollbackAllowed) { "Channel and release-manifest detached signatures verified with explicit rollback allowance." } else { "Channel and release-manifest detached signatures verified." }) `
        -Policy $Policy `
        -TrustedKeyCount $trustedKeyMap.Count `
        -ChannelSignature $channelSignature `
        -ReleaseManifestSignature $releaseManifestSignature `
        -Consistency $consistency `
        -ReleaseSequence $releaseSequence
}

Export-ModuleMember -Function `
    ConvertTo-RevitMcpCanonicalJson, `
    Get-RevitMcpCanonicalJsonBytes, `
    Get-RevitMcpCanonicalJsonSha256, `
    Get-RevitMcpPublicKeyFingerprint, `
    Get-RevitMcpPublicKeyXmlFromPrivateKeyXml, `
    New-RevitMcpDetachedJsonSignature, `
    Get-RevitMcpSignaturePayloadCanonicalJson, `
    Test-RevitMcpDetachedJsonSignature, `
    Test-RevitMcpDetachedJsonSignatureFile, `
    ConvertTo-RevitMcpTrustedKeyMap, `
    Get-RevitMcpDetachedSignaturePath, `
    Test-RevitMcpDetachedJsonSignatureCompatibilityFile, `
    Test-RevitMcpReleaseManifestChannelConsistency, `
    Test-RevitMcpSignedReleaseSequence, `
    Test-RevitMcpReleaseDistributionIntegrity
