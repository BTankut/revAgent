<#
.SYNOPSIS
    Produce signed-release-derived bootstrap prestage hash evidence.

.DESCRIPTION
    This coordinator-side producer verifies the signed channel and release
    manifest before deriving the exact hashes consumed by the elevated canonical
    prestage installer. The elevated consumer never derives or rewrites this
    evidence. Run this script before copying the evidence and installer into the
    administrator-only ProgramData prestage directory. Normal coordinator use
    remains unelevated. The explicit SupervisedAdminPrestage mode is reserved
    for the IT-operated, single-principal supervised prestage driver.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [ValidateSet("stable", "pilot")][string]$Channel = "stable",
    [string]$RepoRoot = "",
    [switch]$AllowTestRoot,
    [switch]$SupervisedAdminPrestage,
    [switch]$MachineTrustBroker,
    [Parameter(DontShow = $true)][scriptblock]$IntegrityModuleBytesVerifiedHook,
    [Parameter(DontShow = $true)][scriptblock]$TrustedKeysBytesVerifiedHook,
    [Parameter(DontShow = $true)][string]$TestMachineName = "",
    [Parameter(DontShow = $true)][scriptblock]$TestAfterPilotAuthorizationHook,
    [Parameter(DontShow = $true)][ValidateSet("", "elevated", "standard")][string]$TestAdministratorState = "",
    [Parameter(DontShow = $true)][string]$TestProducerSid = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$systemDirectory = [Environment]::SystemDirectory
$trustedModuleRoots = [Collections.Generic.List[string]]::new()
foreach ($candidateModuleRoot in @(
    [IO.Path]::Combine($PSHOME, "Modules"),
    [IO.Path]::Combine($systemDirectory, "WindowsPowerShell", "v1.0", "Modules")
)) {
    if ([IO.Directory]::Exists($candidateModuleRoot) -and -not $trustedModuleRoots.Contains($candidateModuleRoot)) {
        [void]$trustedModuleRoots.Add($candidateModuleRoot)
    }
}
$env:PSModulePath = [string]::Join([IO.Path]::PathSeparator, $trustedModuleRoots.ToArray())
foreach ($moduleName in @("Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Security")) {
    $manifest = [IO.Path]::Combine($PSHOME, "Modules", $moduleName, ($moduleName + ".psd1"))
    if (-not [IO.File]::Exists($manifest)) { throw "Required trusted PowerShell module was not found: $manifest" }
    Microsoft.PowerShell.Core\Import-Module -Name $manifest -Force -ErrorAction Stop
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot).TrimEnd("\")
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\")
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$TrustedKeysPath = [IO.Path]::GetFullPath($TrustedKeysPath)
$canonicalReleaseRoot = [IO.Path]::GetFullPath("\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy").TrimEnd("\")

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$producerSid = [string]$identity.User.Value
if ($SupervisedAdminPrestage -and $MachineTrustBroker) {
    throw "SupervisedAdminPrestage and MachineTrustBroker are mutually exclusive producer modes."
}
if (-not [string]::IsNullOrWhiteSpace($TestAdministratorState) -and -not $AllowTestRoot) {
    throw "TestAdministratorState is available only with -AllowTestRoot."
}
if ($AllowTestRoot) {
    # Preserve the existing fixture behavior when no explicit token state is
    # requested. Tests can still exercise both production policy branches.
    $isAdministrator = if ([string]::Equals($TestAdministratorState, "elevated", [StringComparison]::Ordinal)) {
        $true
    }
    elseif ([string]::Equals($TestAdministratorState, "standard", [StringComparison]::Ordinal)) {
        $false
    }
    else {
        [bool]($SupervisedAdminPrestage -or $MachineTrustBroker)
    }
}
if (-not [string]::IsNullOrWhiteSpace($TestProducerSid)) {
    if (-not $AllowTestRoot) { throw "TestProducerSid is available only with -AllowTestRoot." }
    if ($TestProducerSid -notmatch '^S-[0-9]+(?:-[0-9]+)+$') { throw "TestProducerSid must be a valid SID string." }
    $producerSid = $TestProducerSid
}
if ($SupervisedAdminPrestage -and -not $isAdministrator) {
    throw "Supervised administrator prestage evidence requires an elevated Windows PowerShell process."
}
if ($MachineTrustBroker -and (-not $isAdministrator -or -not [string]::Equals($producerSid, 'S-1-5-18', [StringComparison]::Ordinal))) {
    throw "Machine trust broker evidence must be produced by elevated LocalSystem (S-1-5-18)."
}
if (-not $SupervisedAdminPrestage -and -not $MachineTrustBroker -and $isAdministrator) {
    throw "Bootstrap prestage evidence must be produced before elevation in the normal coordinator process."
}
if (-not $AllowTestRoot -and -not [string]::Equals($ReleaseRoot, $canonicalReleaseRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Production evidence requires the canonical signed release root '$canonicalReleaseRoot'."
}
if ($AllowTestRoot) {
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\") + "\"
    if (-not ($ReleaseRoot + "\").StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "AllowTestRoot is limited to disposable release fixtures below TEMP."
    }
}
if (($null -ne $IntegrityModuleBytesVerifiedHook -or $null -ne $TrustedKeysBytesVerifiedHook -or -not [string]::IsNullOrWhiteSpace($TestMachineName) -or $null -ne $TestAfterPilotAuthorizationHook -or -not [string]::IsNullOrWhiteSpace($TestAdministratorState) -or -not [string]::IsNullOrWhiteSpace($TestProducerSid)) -and -not $AllowTestRoot) {
    throw "Evidence producer test seams are available only with -AllowTestRoot."
}

function Test-RevAgentEvidencePathUnderRoot {
    param([string]$Path, [string]$Root)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd("\")
    return [string]::Equals($fullPath.TrimEnd("\"), $fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + "\", [StringComparison]::OrdinalIgnoreCase)
}

function Assert-RevAgentEvidencePathNoLinks {
    param([string]$Path, [string]$StopRoot)
    $cursor = [IO.Path]::GetFullPath($Path)
    while (Test-RevAgentEvidencePathUnderRoot -Path $cursor -Root $StopRoot) {
        if (-not (Test-Path -LiteralPath $cursor)) { throw "Signed evidence source path is missing: $cursor" }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        $linkType = if ($item.PSObject.Properties["LinkType"]) { [string]$item.LinkType } else { "" }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) {
            throw "Signed evidence source contains a filesystem link/reparse component: $cursor"
        }
        if ([string]::Equals($cursor.TrimEnd("\"), [IO.Path]::GetFullPath($StopRoot).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }
}

function Resolve-RevAgentEvidenceReleasePath {
    param([string]$Path, [string]$BaseDirectory)
    $resolved = if ([IO.Path]::IsPathRooted($Path)) { [IO.Path]::GetFullPath($Path) } else { [IO.Path]::GetFullPath((Join-Path $BaseDirectory $Path)) }
    if (-not (Test-RevAgentEvidencePathUnderRoot -Path $resolved -Root $ReleaseRoot)) { throw "Signed release path escaped ReleaseRoot: $resolved" }
    Assert-RevAgentEvidencePathNoLinks -Path $resolved -StopRoot $ReleaseRoot
    return $resolved
}

function Read-RevAgentPinnedModuleBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [int]$MaxBytes = 4194304
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not (Test-RevAgentEvidencePathUnderRoot -Path $fullPath -Root $RepoRoot)) {
        throw "Coordinator integrity verifier escaped the repository root: $fullPath"
    }
    Assert-RevAgentEvidencePathNoLinks -Path $fullPath -StopRoot $RepoRoot

    $stream = $null
    try {
        # FileShare.Read deliberately denies concurrent writes, deletion, rename,
        # and hardlink mutation while the exact bytes are acquired.
        $stream = [IO.File]::Open($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($stream.Length -lt 1 -or $stream.Length -gt $MaxBytes) {
            throw "Coordinator integrity verifier size is outside the bounded 1..$MaxBytes byte policy. path=$fullPath size=$($stream.Length)"
        }

        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw "Coordinator integrity verifier ended before its declared length: $fullPath" }
            $offset += $read
        }
        if ($stream.ReadByte() -ne -1) { throw "Coordinator integrity verifier grew while it was being read: $fullPath" }

        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actualSha256 = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "") }
        finally { $sha.Dispose() }
        if (-not [string]::Equals($actualSha256, $ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Coordinator integrity verifier hash did not match the production pin."
        }
        return ,$bytes
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Import-RevAgentPinnedModuleBytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $moduleText = $strictUtf8.GetString($Bytes)
    if ($moduleText.Length -gt 0 -and $moduleText[0] -eq [char]0xFEFF) { $moduleText = $moduleText.Substring(1) }
    $moduleName = "RevAgent.DistributionIntegrity.Pinned.{0}" -f [Guid]::NewGuid().ToString("N")
    $module = New-Module -Name $moduleName -ScriptBlock ([ScriptBlock]::Create($moduleText))
    Import-Module $module -Force
    return $module
}

function Read-RevAgentEvidenceBoundedBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$StopRoot,
        [int]$MaxBytes = 65536
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    Assert-RevAgentEvidencePathNoLinks -Path $fullPath -StopRoot $StopRoot
    $stream = $null
    try {
        # Parse and hash only this acquired byte snapshot. FileShare.Read denies
        # concurrent write, delete, and rename while acquisition is in flight.
        $stream = [IO.File]::Open($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($stream.Length -lt 1 -or $stream.Length -gt $MaxBytes) {
            throw "Evidence input size is outside the bounded 1..$MaxBytes byte policy. path=$fullPath size=$($stream.Length)"
        }
        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw "Evidence input ended before its declared length: $fullPath" }
            $offset += $read
        }
        if ($stream.ReadByte() -ne -1) { throw "Evidence input grew while it was being read: $fullPath" }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $sha256 = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '') }
        finally { $sha.Dispose() }
        return [pscustomobject][ordered]@{ Bytes = $bytes; Sha256 = $sha256 }
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-RevAgentEvidenceJsonPropertyName {
    param([Parameter(Mandatory = $true)][Xml.XmlElement]$Element)
    if ([string]::Equals($Element.LocalName, 'item', [StringComparison]::Ordinal) -and $Element.HasAttribute('item')) {
        return [string]$Element.GetAttribute('item')
    }
    return [string]$Element.LocalName
}

function Get-RevAgentEvidenceJsonChildren {
    param([Parameter(Mandatory = $true)][Xml.XmlElement]$Element)
    return @($Element.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element })
}

function Assert-RevAgentEvidenceJsonTree {
    param([Parameter(Mandatory = $true)][Xml.XmlElement]$Element, [Parameter(Mandatory = $true)][string]$Context)

    $jsonType = [string]$Element.GetAttribute('type')
    if ([string]::Equals($jsonType, 'object', [StringComparison]::Ordinal)) {
        $children = @(Get-RevAgentEvidenceJsonChildren -Element $Element)
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($child in $children) {
            $name = Get-RevAgentEvidenceJsonPropertyName -Element $child
            if ([string]::IsNullOrWhiteSpace($name) -or -not $seen.Add($name)) {
                throw "Trusted-key JSON contains an empty or duplicate decoded property at ${Context}: $name"
            }
            if ($name -match '^(?i:d|p|q|dp|dq|qi|oth|k|privatekey|privatekeypem|secret|password|credential)$') {
                throw "Trusted-key JSON contains a forbidden private or secret-bearing property: $name"
            }
        }
        foreach ($child in $children) {
            $name = Get-RevAgentEvidenceJsonPropertyName -Element $child
            Assert-RevAgentEvidenceJsonTree -Element $child -Context ($Context + '.' + $name)
        }
    }
    elseif ([string]::Equals($jsonType, 'array', [StringComparison]::Ordinal)) {
        $index = 0
        foreach ($child in @(Get-RevAgentEvidenceJsonChildren -Element $Element)) {
            Assert-RevAgentEvidenceJsonTree -Element $child -Context ("$Context[$index]")
            $index++
        }
    }
    elseif ([string]::Equals($jsonType, 'string', [StringComparison]::Ordinal)) {
        $value = [string]$Element.InnerText
        if ($value -match '(?i)-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----' -or
            $value -match '(?i)<\s*(?:D|P|Q|DP|DQ|InverseQ)\s*>') {
            throw "Trusted-key JSON contains decoded private-key material at $Context."
        }
    }
}

function Assert-RevAgentEvidenceTrustedKeys {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes, [switch]$AllowTestIdentity)

    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $text = $strictUtf8.GetString($Bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    if ($text -match '(?i)"(?:d|p|q|dp|dq|qi|oth|k|privatekey|privatekeypem|secret|password|credential)"\s*:' -or
        $text -match '(?i)-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----' -or
        $text -match '(?i)<\s*(?:D|P|Q|DP|DQ|InverseQ)\s*>') {
        throw 'Trusted-key document contains forbidden private or secret-bearing material.'
    }

    Microsoft.PowerShell.Utility\Add-Type -AssemblyName System.Runtime.Serialization -ErrorAction Stop
    $jsonBytes = $Bytes
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
        $jsonBytes = New-Object byte[] ($Bytes.Length - 3)
        [Array]::Copy($Bytes, 3, $jsonBytes, 0, $jsonBytes.Length)
    }
    $reader = $null
    try {
        $reader = [Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader($jsonBytes, [Xml.XmlDictionaryReaderQuotas]::Max)
        $xml = [Xml.XmlDocument]::new()
        $xml.XmlResolver = $null
        $xml.Load($reader)
    }
    catch { throw "Trusted-key bytes are not strict JSON: $($_.Exception.Message)" }
    finally { if ($null -ne $reader) { $reader.Dispose() } }

    $root = $xml.DocumentElement
    if ($null -eq $root -or -not [string]::Equals([string]$root.LocalName, 'root', [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$root.GetAttribute('type'), 'object', [StringComparison]::Ordinal)) {
        throw 'Trusted-key document must be one JSON object.'
    }
    Assert-RevAgentEvidenceJsonTree -Element $root -Context '$'
    $top = @(Get-RevAgentEvidenceJsonChildren -Element $root)
    $topNames = @($top | ForEach-Object { Get-RevAgentEvidenceJsonPropertyName -Element $_ })
    $allowedTopNames = @('schemaVersion', 'app', 'generatedAtUtc', 'trustedKeys')
    $trustedKeysNodes = @($top | Where-Object { [string]::Equals((Get-RevAgentEvidenceJsonPropertyName -Element $_), 'trustedKeys', [StringComparison]::Ordinal) })
    if ($trustedKeysNodes.Count -ne 1 -or -not [string]::Equals([string]$trustedKeysNodes[0].GetAttribute('type'), 'object', [StringComparison]::Ordinal) -or
        @($topNames | Where-Object { $allowedTopNames -cnotcontains $_ }).Count -ne 0 -or $top.Count -notin @(1, 4)) {
        throw 'Trusted-key document properties must be trustedKeys alone or the exact public metadata allowlist.'
    }
    $generatedAtUtcText = $null
    if ($top.Count -eq 4) {
        foreach ($metadata in @(@('schemaVersion', 'number'), @('app', 'string'), @('generatedAtUtc', 'string'))) {
            $metadataNode = @($top | Where-Object { [string]::Equals((Get-RevAgentEvidenceJsonPropertyName -Element $_), [string]$metadata[0], [StringComparison]::Ordinal) })
            if ($metadataNode.Count -ne 1 -or -not [string]::Equals([string]$metadataNode[0].GetAttribute('type'), [string]$metadata[1], [StringComparison]::Ordinal)) {
                throw "Trusted-key metadata is incomplete or mistyped: $($metadata[0])"
            }
            if ([string]::Equals([string]$metadata[0], 'generatedAtUtc', [StringComparison]::Ordinal)) {
                $generatedAtUtcText = [string]$metadataNode[0].InnerText
            }
        }
    }
    $keyNodes = @(Get-RevAgentEvidenceJsonChildren -Element $trustedKeysNodes[0])
    if ($keyNodes.Count -lt 1 -or $keyNodes.Count -gt 2) {
        throw 'Trusted-key document must contain one key or a two-key rotation window.'
    }
    $requiredFields = @('algorithm', 'publicKeyFingerprint', 'publicKeyXml')
    $allowedFields = @('algorithm', 'publicKeyFingerprint', 'publicKeyXml', 'purpose')
    foreach ($keyNode in $keyNodes) {
        $keyId = Get-RevAgentEvidenceJsonPropertyName -Element $keyNode
        $fields = @(Get-RevAgentEvidenceJsonChildren -Element $keyNode)
        $fieldNames = @($fields | ForEach-Object { Get-RevAgentEvidenceJsonPropertyName -Element $_ })
        if ($keyId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or
            -not [string]::Equals([string]$keyNode.GetAttribute('type'), 'object', [StringComparison]::Ordinal) -or
            $fields.Count -notin @(3, 4) -or @($fieldNames | Where-Object { $allowedFields -cnotcontains $_ }).Count -ne 0 -or
            @($requiredFields | Where-Object { $fieldNames -cnotcontains $_ }).Count -ne 0 -or
            ($fields.Count -eq 4 -and $fieldNames -cnotcontains 'purpose') -or
            @($fields | Where-Object { -not [string]::Equals([string]$_.GetAttribute('type'), 'string', [StringComparison]::Ordinal) }).Count -ne 0) {
            throw "Trusted-key entry must be an exact public RS256 record: $keyId"
        }
    }

    $document = $text | ConvertFrom-Json
    $topProperties = @($document.PSObject.Properties)
    $topPropertyNames = @($topProperties | ForEach-Object { [string]$_.Name })
    if ($topProperties.Count -notin @(1, 4) -or @($topPropertyNames | Where-Object { $allowedTopNames -cnotcontains $_ }).Count -ne 0 -or
        $topPropertyNames -cnotcontains 'trustedKeys') {
        throw 'Trusted-key document properties must be trustedKeys alone or the exact public metadata allowlist.'
    }
    if ($topProperties.Count -eq 4) {
        foreach ($metadataName in @('schemaVersion', 'app', 'generatedAtUtc')) {
            if ($topPropertyNames -cnotcontains $metadataName) { throw "Trusted-key metadata is incomplete: $metadataName" }
        }
        $generatedAt = [DateTime]::MinValue
        if ([int]$document.schemaVersion -ne 1 -or
            [string]$document.app -notin @('revAgent', 'revit-mcp-skill') -or
            [string]$generatedAtUtcText -cnotmatch 'Z$' -or
            -not [DateTime]::TryParse([string]$generatedAtUtcText, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$generatedAt) -or
            $generatedAt.Kind -ne [DateTimeKind]::Utc -or
            $generatedAt -gt [DateTime]::UtcNow.AddMinutes(5)) {
            throw 'Trusted-key public metadata is invalid.'
        }
    }
    $properties = @($document.trustedKeys.PSObject.Properties)
    $fingerprints = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($property in $properties) {
        $key = $property.Value
        if (-not [string]::Equals([string]$key.algorithm, 'RS256', [StringComparison]::Ordinal) -or
            [string]$key.publicKeyFingerprint -notmatch '^[A-Fa-f0-9]{64}$') {
            throw "Trusted-key entry is not a complete RS256 public-key record: $($property.Name)"
        }
        if ($key.PSObject.Properties['purpose'] -and -not [string]::Equals([string]$key.purpose, 'release-signing', [StringComparison]::Ordinal)) {
            throw "Trusted-key purpose must be release-signing: $($property.Name)"
        }
        $settings = [Xml.XmlReaderSettings]::new()
        $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
        $settings.XmlResolver = $null
        $stringReader = [IO.StringReader]::new([string]$key.publicKeyXml)
        $xmlReader = $null
        try {
            $xmlReader = [Xml.XmlReader]::Create($stringReader, $settings)
            $publicXml = [Xml.XmlDocument]::new()
            $publicXml.XmlResolver = $null
            $publicXml.Load($xmlReader)
        }
        finally {
            if ($null -ne $xmlReader) { $xmlReader.Dispose() }
            $stringReader.Dispose()
        }
        $elementNames = @($publicXml.DocumentElement.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element } | ForEach-Object { $_.Name })
        if ($null -eq $publicXml.DocumentElement -or -not [string]::Equals($publicXml.DocumentElement.Name, 'RSAKeyValue', [StringComparison]::Ordinal) -or
            $elementNames.Count -ne 2 -or @((Compare-Object @('Exponent', 'Modulus') @($elementNames | Sort-Object) -SyncWindow 0)).Count -ne 0) {
            throw "Trusted-key XML contains private or unexpected RSA parameters: $($property.Name)"
        }
        foreach ($name in @('Modulus', 'Exponent')) {
            $node = $publicXml.DocumentElement.SelectSingleNode($name)
            if ($null -eq $node -or [string]::IsNullOrWhiteSpace([string]$node.InnerText)) { throw "Trusted-key XML is missing $name for $($property.Name)." }
            try { [void][Convert]::FromBase64String(([string]$node.InnerText).Trim()) }
            catch { throw "Trusted-key XML contains invalid $name base64 for $($property.Name)." }
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actualFingerprint = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes((([string]$key.publicKeyXml).Trim() -replace '\s+', ''))))).Replace('-', '') }
        finally { $sha.Dispose() }
        if (-not [string]::Equals($actualFingerprint, [string]$key.publicKeyFingerprint, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Trusted-key fingerprint does not match publicKeyXml: $($property.Name)"
        }
        if (-not $fingerprints.Add($actualFingerprint)) { throw "Trusted-key document contains a duplicate public-key fingerprint: $($property.Name)" }
    }

    if (-not $AllowTestIdentity) {
        $productionId = 'revagent-prod-rsa-2026q3'
        $productionProperties = @($properties | Where-Object { [string]::Equals([string]$_.Name, $productionId, [StringComparison]::Ordinal) })
        if ($productionProperties.Count -ne 1) { throw "Production trusted-key document must contain '$productionId'." }
        if (-not [string]::Equals([string]$productionProperties[0].Value.publicKeyFingerprint, '32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Production trusted-key document does not match the pinned RS256 release key.'
        }
        if ($properties.Count -eq 2) {
            $futureId = [string](@($properties | Where-Object { -not [string]::Equals([string]$_.Name, $productionId, [StringComparison]::Ordinal) })[0].Name)
            $match = [regex]::Match($futureId, '^revagent-prod-rsa-(?<year>[0-9]{4})q(?<quarter>[1-4])$')
            $futureOrdinal = if ($match.Success) { ([int]$match.Groups['year'].Value * 4) + [int]$match.Groups['quarter'].Value } else { 0 }
            if (-not $match.Success -or $futureOrdinal -le ((2026 * 4) + 3)) {
                throw "The optional production rotation key must be later than revagent-prod-rsa-2026q3: $futureId"
            }
        }
    }
    return $document
}

if (Test-RevAgentEvidencePathUnderRoot -Path $OutputPath -Root $ReleaseRoot) { throw "Evidence output must not be written into the signed release root." }
if (Test-Path -LiteralPath $OutputPath) { throw "Evidence output already exists; refusing replacement: $OutputPath" }
$outputParent = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) { throw "Evidence output parent must already exist: $outputParent" }
if (-not (Test-Path -LiteralPath $TrustedKeysPath -PathType Leaf)) { throw "Trusted key document was not found: $TrustedKeysPath" }

$integrityModulePath = Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1"
$pinnedIntegrityModuleHash = "C4B005D4333BD973C595D7590809D7BDA663807AF47A69ACDDF0E3955000D3E6"
$integrityModuleBytes = Read-RevAgentPinnedModuleBytes -Path $integrityModulePath -ExpectedSha256 $pinnedIntegrityModuleHash
if ($null -ne $IntegrityModuleBytesVerifiedHook) { & $IntegrityModuleBytesVerifiedHook $integrityModulePath }
$trustedKeysStopRoot = if (Test-RevAgentEvidencePathUnderRoot -Path $TrustedKeysPath -Root $RepoRoot) {
    $RepoRoot
}
elseif (Test-RevAgentEvidencePathUnderRoot -Path $TrustedKeysPath -Root $ReleaseRoot) {
    $ReleaseRoot
}
else {
    [IO.Path]::GetPathRoot($TrustedKeysPath)
}
$trustedKeysEvidence = Read-RevAgentEvidenceBoundedBytes -Path $TrustedKeysPath -StopRoot $trustedKeysStopRoot
$trustedKeys = Assert-RevAgentEvidenceTrustedKeys -Bytes ([byte[]]$trustedKeysEvidence.Bytes) -AllowTestIdentity:$AllowTestRoot
if ($null -ne $TrustedKeysBytesVerifiedHook) { & $TrustedKeysBytesVerifiedHook $TrustedKeysPath ([string]$trustedKeysEvidence.Sha256) }

$channelPath = Resolve-RevAgentEvidenceReleasePath -Path (Join-Path "channels" ($Channel + ".json")) -BaseDirectory $ReleaseRoot
$channelDocument = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json
if (-not [string]::Equals([string]$channelDocument.channel, $Channel, [StringComparison]::Ordinal)) {
    throw "Signed channel identity does not match the selected prestage channel. requested=$Channel signed=$($channelDocument.channel)"
}
$channelDirectory = Split-Path -Parent $channelPath
$manifestPath = Resolve-RevAgentEvidenceReleasePath -Path ([string]$channelDocument.manifestPath) -BaseDirectory $channelDirectory
$manifestDocument = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$packagePath = Resolve-RevAgentEvidenceReleasePath -Path ([string]$channelDocument.packagePath) -BaseDirectory $channelDirectory

$integrityModule = Import-RevAgentPinnedModuleBytes -Bytes $integrityModuleBytes
try {
    $integrityCommand = Get-Command ("{0}\Test-RevAgentReleaseDistributionIntegrity" -f $integrityModule.Name) -ErrorAction Stop
    $integrity = & $integrityCommand -ChannelPath $channelPath -Channel $channelDocument -ReleaseManifestPath $manifestPath -ReleaseManifest $manifestDocument -TrustedKeys $trustedKeys.trustedKeys -Policy enforce
}
finally {
    Remove-Module $integrityModule -Force -ErrorAction SilentlyContinue
}
if (-not [bool]$integrity.success) { throw "Signed release verification failed before evidence generation: $($integrity.reason). $($integrity.message)" }
if ([long]$integrity.releaseSequence -le 0 -or
    [long]$integrity.highestAcceptedReleaseSequence -lt [long]$integrity.releaseSequence -or
    [long]$integrity.minimumAcceptedReleaseSequence -gt [long]$integrity.releaseSequence) {
    throw 'Signed release sequence evidence is invalid for bootstrap prestage.'
}
$pilotPolicy = if ($channelDocument.PSObject.Properties['pilotPolicy']) { $channelDocument.pilotPolicy } else { $null }
if ($Channel -eq 'pilot') {
    if ($null -eq $pilotPolicy -or [int]$pilotPolicy.schemaVersion -ne 1) {
        throw 'Pilot release metadata requires pilotPolicy schemaVersion 1.'
    }
    $allowedMachines = @($pilotPolicy.allowedMachineNames | ForEach-Object { ([string]$_).Trim().ToUpperInvariant() })
    $machineName = if ([string]::IsNullOrWhiteSpace($TestMachineName)) { [Environment]::MachineName.Trim().ToUpperInvariant() } else { $TestMachineName.Trim().ToUpperInvariant() }
    if ($allowedMachines.Count -eq 0 -or $allowedMachines -notcontains $machineName) {
        throw "pilot_machine_not_allowed: signed pilot prestage policy does not authorize this coordinator computer: $machineName"
    }
    if ($null -ne $TestAfterPilotAuthorizationHook) { & $TestAfterPilotAuthorizationHook $machineName $allowedMachines }
}
elseif ($null -ne $pilotPolicy) { throw 'Stable release metadata must not contain pilotPolicy.' }

$componentMap = [ordered]@{
    localBootstrapInstallerScript = @("localBootstrapInstaller", "installer\nas\install-revagent-local-bootstrap.ps1")
    localBootstrapInstallerModule = @("installerLibLocalBootstrap", "installer\lib\RevAgent.LocalBootstrap.psm1")
    bootstrap = @("localBootstrap", "installer\nas\Start-revAgent-Update.ps1")
    launcher = @("localBootstrapLauncher", "installer\nas\Start-revAgent-Update.cmd")
    updaterGui = @("updaterGui", "installer\nas\Install-revAgent-Updater-GUI.ps1")
    distributionIntegrity = @("installerLibDistributionIntegrity", "installer\lib\RevAgent.DistributionIntegrity.psm1")
    permissions = @("installerLibPermissions", "installer\lib\RevAgent.Permissions.psm1")
    sourceFreeMigration = @("installerLibSourceFreeMigration", "installer\lib\RevAgent.SourceFreeMigration.psm1")
    releaseSnapshot = @("installerLibReleaseSnapshot", "installer\lib\RevAgent.ReleaseSnapshot.psm1")
    privilegedSnapshotUpdate = @("privilegedSnapshotUpdate", "installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1")
    bootstrapTrust = @("installerLibBootstrapTrust", "installer\lib\RevAgent.BootstrapTrust.psm1")
    bootstrapTrustBroker = @("bootstrapTrustBroker", "installer\nas\Invoke-RevAgent-BootstrapTrustBroker.ps1")
    trustedKeys = @("releaseTrustedKeys", "config\release-trusted-keys.json")
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($packagePath)
$componentHashes = [ordered]@{}
try {
    foreach ($entry in $componentMap.GetEnumerator()) {
        $componentKey = [string]$entry.Value[0]
        $expectedPath = [string]$entry.Value[1]
        $component = $manifestDocument.components.$componentKey
        if ($null -eq $component -or -not [string]::Equals(([string]$component.path).Replace("/", "\"), $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Signed manifest component '$componentKey' is missing or has an unexpected path."
        }
        $zipPath = $expectedPath.Replace("\", "/")
        $zipEntries = @($archive.Entries | Where-Object { [string]::Equals($_.FullName.Replace("\", "/"), $zipPath, [StringComparison]::OrdinalIgnoreCase) })
        if ($zipEntries.Count -ne 1) { throw "Signed package must contain exactly one '$zipPath' entry; found $($zipEntries.Count)." }
        if ([long]$zipEntries[0].Length -lt 1 -or [long]$zipEntries[0].Length -gt 33554432) { throw "Signed package entry size is outside the evidence policy: $zipPath" }
        $entryStream = $zipEntries[0].Open()
        $entryHash = [Security.Cryptography.SHA256]::Create()
        try {
            if ([string]::Equals([string]$entry.Key, 'trustedKeys', [StringComparison]::Ordinal)) {
                if ([long]$zipEntries[0].Length -ne [long]$trustedKeysEvidence.Bytes.Length) {
                    throw 'Signed package trusted-key bytes differ from the independently acquired trusted-key document.'
                }
                $entryBytes = New-Object byte[] ([int]$zipEntries[0].Length)
                $offset = 0
                while ($offset -lt $entryBytes.Length) {
                    $read = $entryStream.Read($entryBytes, $offset, $entryBytes.Length - $offset)
                    if ($read -le 0) { throw 'Signed package trusted-key entry ended before its declared length.' }
                    $offset += $read
                }
                if (-not [Linq.Enumerable]::SequenceEqual([byte[]]$entryBytes, [byte[]]$trustedKeysEvidence.Bytes)) {
                    throw 'Signed package trusted-key bytes differ from the independently acquired trusted-key document.'
                }
                $actualHash = ([BitConverter]::ToString($entryHash.ComputeHash($entryBytes))).Replace("-", "")
            }
            else {
                $actualHash = ([BitConverter]::ToString($entryHash.ComputeHash($entryStream))).Replace("-", "")
            }
        }
        finally { $entryHash.Dispose(); $entryStream.Dispose() }
        if (-not [string]::Equals($actualHash, [string]$component.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Signed package entry hash mismatch for '$componentKey'."
        }
        $componentHashes[$entry.Key] = [string]$component.sha256
    }
}
finally { $archive.Dispose() }

$evidence = [ordered]@{
    schemaVersion = 1
    app = "revAgent"
    evidenceType = "bootstrap-prestage"
    producerMode = if ($MachineTrustBroker) { "machine-trust-broker" } elseif ($SupervisedAdminPrestage) { "supervised-admin-prestage" } else { "unelevated-coordinator" }
    supervisedAdminPrestage = [bool]$SupervisedAdminPrestage
    generatedAtUtc = [DateTime]::UtcNow.ToString("o")
    generatedBySid = $producerSid
    release = [ordered]@{
        root = $ReleaseRoot
        channel = [string]$channelDocument.channel
        version = [string]$channelDocument.version
        releaseSequence = [long]$integrity.releaseSequence
        minimumAcceptedReleaseSequence = [long]$integrity.minimumAcceptedReleaseSequence
        highestAcceptedReleaseSequence = [long]$integrity.highestAcceptedReleaseSequence
        channelManifestSha256 = (Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $channelPath).Hash
        releaseManifestSha256 = (Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash
        packageSha256 = (Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash
        signatureVerified = $true
        pilotPolicy = $pilotPolicy
    }
    localBootstrapInstallerScript = [string]$componentHashes.localBootstrapInstallerScript
    localBootstrapInstallerModule = [string]$componentHashes.localBootstrapInstallerModule
    sources = [ordered]@{
        bootstrap = [string]$componentHashes.bootstrap
        launcher = [string]$componentHashes.launcher
        updaterGui = [string]$componentHashes.updaterGui
        distributionIntegrity = [string]$componentHashes.distributionIntegrity
        permissions = [string]$componentHashes.permissions
        sourceFreeMigration = [string]$componentHashes.sourceFreeMigration
        releaseSnapshot = [string]$componentHashes.releaseSnapshot
        privilegedSnapshotUpdate = [string]$componentHashes.privilegedSnapshotUpdate
        bootstrapTrust = [string]$componentHashes.bootstrapTrust
        bootstrapTrustBroker = [string]$componentHashes.bootstrapTrustBroker
        trustedKeys = [string]$componentHashes.trustedKeys
    }
}
$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($evidence | ConvertTo-Json -Depth 10))
$stream = $null
try {
    $stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
}
finally { if ($null -ne $stream) { $stream.Dispose() } }

[pscustomobject][ordered]@{
    success = $true
    action = "bootstrap-prestage-evidence"
    outputPath = $OutputPath
    outputSha256 = (Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash
    version = [string]$channelDocument.version
    signatureVerified = $true
    producerMode = if ($MachineTrustBroker) { "machine-trust-broker" } elseif ($SupervisedAdminPrestage) { "supervised-admin-prestage" } else { "unelevated-coordinator" }
    supervisedAdminPrestage = [bool]$SupervisedAdminPrestage
}
