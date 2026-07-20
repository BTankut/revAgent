<#
.SYNOPSIS
    Build the short-lived IT-only supervised bootstrap prestage kit.

.DESCRIPTION
    Produces one deterministic ZIP containing only the five public/runtime
    files needed for the E1 administrator workflow. The ZIP is a CD artifact;
    it is deliberately independent of the signed release root and NAS tools
    publisher surfaces.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
    [string]$RepoRoot = "",
    [Parameter(DontShow = $true)][switch]$AllowTestTrustedKeys,
    [Parameter(DontShow = $true)][switch]$EnableSealedStageTestMode,
    [switch]$OutputJson
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ("$($ExecutionContext.SessionState.LanguageMode)" -ne 'FullLanguage') {
    throw "Supervised prestage kit build requires FullLanguage PowerShell. actual=$($ExecutionContext.SessionState.LanguageMode)"
}
$trustedModuleRoots = [Collections.Generic.List[string]]::new()
foreach ($candidateRoot in @(
    [IO.Path]::Combine($PSHOME, 'Modules'),
    [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules')
)) {
    if ([IO.Directory]::Exists($candidateRoot) -and -not $trustedModuleRoots.Contains($candidateRoot)) {
        [void]$trustedModuleRoots.Add($candidateRoot)
    }
}
$env:PSModulePath = [string]::Join([IO.Path]::PathSeparator, [string[]]$trustedModuleRoots)
foreach ($moduleName in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    $manifest = [IO.Path]::Combine($PSHOME, 'Modules', $moduleName, ($moduleName + '.psd1'))
    if (-not [IO.File]::Exists($manifest)) { throw "Required trusted PowerShell module was not found: $manifest" }
    Microsoft.PowerShell.Core\Import-Module -Name $manifest -Force -ErrorAction Stop
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot).TrimEnd("\")
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd("\")
$TrustedKeysPath = [IO.Path]::GetFullPath($TrustedKeysPath)
$outputParent = Split-Path -Parent $OutputDirectory

if (-not ('RevAgent.PrestageKitNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public static class PrestageKitNative {
        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME { public uint Low; public uint High; }
        [StructLayout(LayoutKind.Sequential)]
        private struct INFO {
            public uint Attributes; public FILETIME Creation; public FILETIME Access; public FILETIME Write;
            public uint Volume; public uint SizeHigh; public uint SizeLow; public uint NumberOfLinks;
            public uint IndexHigh; public uint IndexLow;
        }
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out INFO info);
        public static uint GetLinkCount(SafeFileHandle handle) {
            INFO info;
            if (handle == null || handle.IsInvalid || !GetFileInformationByHandle(handle, out info)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Prestage kit source link-count inspection failed.");
            }
            return info.NumberOfLinks;
        }
    }
}
'@
}

function Test-RevAgentKitPathUnderRoot {
    param([string]$Path, [string]$Root)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd("\")
    return [string]::Equals($fullPath.TrimEnd("\"), $fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + "\", [StringComparison]::OrdinalIgnoreCase)
}

function Assert-RevAgentKitOrdinaryPathChain {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$StopRoot)

    $cursor = [IO.Path]::GetFullPath($Path)
    # Preserve a drive root as `C:\`; passing the drive-relative `C:` form
    # back through GetFullPath would silently rebase it onto the current path.
    $stop = [IO.Path]::GetFullPath($StopRoot)
    if (-not (Test-RevAgentKitPathUnderRoot -Path $cursor -Root $stop)) {
        throw "Prestage kit path escaped its expected root: $Path"
    }
    while ($true) {
        if (-not (Test-Path -LiteralPath $cursor)) { throw "Prestage kit path is missing: $cursor" }
        $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
            throw "Prestage kit path contains a filesystem link/reparse component: $cursor"
        }
        if ([string]::Equals($cursor.TrimEnd("\"), $stop.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) { break }
        $parentInfo = [IO.Directory]::GetParent($cursor)
        $parent = if ($null -eq $parentInfo) { '' } else { $parentInfo.FullName }
        if ([string]::IsNullOrWhiteSpace($parent) -or [string]::Equals($parent, $cursor, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Prestage kit path escaped its expected root: $Path"
        }
        if (-not (Test-RevAgentKitPathUnderRoot -Path $parent -Root $stop)) {
            throw "Prestage kit path escaped its expected root: $Path"
        }
        $cursor = $parent
    }
}

function Read-RevAgentKitSourceBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [ValidateRange(1, 4194304)][int]$MaxBytes = 1048576
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not (Test-RevAgentKitPathUnderRoot -Path $fullPath -Root $AllowedRoot)) {
        throw "Prestage kit source escaped its allowed root: $fullPath"
    }
    Assert-RevAgentKitOrdinaryPathChain -Path $fullPath -StopRoot $AllowedRoot

    $stream = $null
    try {
        # FileShare.Read denies write/delete/rename through every hardlink while
        # the exact source bytes are acquired and hashed.
        $stream = [IO.File]::Open($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $linkCount = [RevAgent.PrestageKitNative]::GetLinkCount($stream.SafeFileHandle)
        if ($linkCount -ne 1) { throw "Prestage kit source must have exactly one hardlink reference. path=$fullPath linkCount=$linkCount" }
        if ($stream.Length -lt 1 -or $stream.Length -gt $MaxBytes) {
            throw "Prestage kit source size is outside the bounded 1..$MaxBytes policy: $fullPath"
        }
        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw "Prestage kit source ended before its declared length: $fullPath" }
            $offset += $read
        }
        if ($stream.ReadByte() -ne -1) { throw "Prestage kit source grew while it was being read: $fullPath" }

        $sha = [Security.Cryptography.SHA256]::Create()
        try { $sha256 = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "") }
        finally { $sha.Dispose() }
        return [pscustomobject][ordered]@{ Path = $fullPath; Bytes = $bytes; Sha256 = $sha256 }
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Get-RevAgentJsonMappedPropertyName {
    param([Parameter(Mandatory = $true)][Xml.XmlElement]$Element)

    if ([string]::Equals($Element.LocalName, 'item', [StringComparison]::Ordinal) -and $Element.HasAttribute('item')) {
        return [string]$Element.GetAttribute('item')
    }
    return [string]$Element.LocalName
}

function Get-RevAgentJsonMappedElementChildren {
    param([Parameter(Mandatory = $true)][Xml.XmlElement]$Element)

    return @($Element.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element })
}

function Assert-RevAgentJsonTokenTree {
    param(
        [Parameter(Mandatory = $true)][Xml.XmlElement]$Element,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $jsonType = [string]$Element.GetAttribute('type')
    if ([string]::Equals($jsonType, 'object', [StringComparison]::Ordinal)) {
        $children = @(Get-RevAgentJsonMappedElementChildren -Element $Element)
        $seenNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($child in $children) {
            $propertyName = Get-RevAgentJsonMappedPropertyName -Element $child
            if ([string]::IsNullOrWhiteSpace($propertyName)) {
                throw "Prestage kit trusted-key JSON contains an empty decoded property name at $Context."
            }
            if (-not $seenNames.Add($propertyName)) {
                throw "Prestage kit trusted-key JSON contains a duplicate decoded property name at ${Context}: $propertyName"
            }
            if ($propertyName -match '^(?i:d|p|q|dp|dq|qi|oth|k|privatekey|privatekeypem|secret|password|credential)$') {
                throw "Prestage kit trusted-key JSON contains a forbidden decoded private JWK or secret-bearing property: $propertyName"
            }
        }
        foreach ($child in $children) {
            $propertyName = Get-RevAgentJsonMappedPropertyName -Element $child
            Assert-RevAgentJsonTokenTree -Element $child -Context ($Context + '.' + $propertyName)
        }
        return
    }
    if ([string]::Equals($jsonType, 'array', [StringComparison]::Ordinal)) {
        $index = 0
        foreach ($child in @(Get-RevAgentJsonMappedElementChildren -Element $Element)) {
            Assert-RevAgentJsonTokenTree -Element $child -Context ("$Context[$index]")
            $index++
        }
        return
    }
    if ([string]::Equals($jsonType, 'string', [StringComparison]::Ordinal)) {
        $decodedValue = [string]$Element.InnerText
        if ($decodedValue -match '(?i)-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----') {
            throw "Prestage kit trusted-key JSON contains forbidden decoded PEM private-key material at $Context."
        }
        if ($decodedValue -match '(?i)<\s*(?:D|P|Q|DP|DQ|InverseQ)\s*>') {
            throw "Prestage kit trusted-key JSON contains forbidden decoded private RSA XML material at $Context."
        }
    }
}

function Read-RevAgentStrictTrustedKeyJsonTokens {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    Microsoft.PowerShell.Utility\Add-Type -AssemblyName System.Runtime.Serialization -ErrorAction Stop
    $jsonBytes = $Bytes
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
        $jsonBytes = New-Object byte[] ($Bytes.Length - 3)
        [Array]::Copy($Bytes, 3, $jsonBytes, 0, $jsonBytes.Length)
    }
    $reader = $null
    try {
        $reader = [Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader(
            $jsonBytes,
            [Xml.XmlDictionaryReaderQuotas]::Max)
        $xml = [Xml.XmlDocument]::new()
        $xml.XmlResolver = $null
        $xml.Load($reader)
    }
    catch {
        throw "Prestage kit trusted-key bytes are not strict JSON: $($_.Exception.Message)"
    }
    finally { if ($null -ne $reader) { $reader.Dispose() } }

    $root = $xml.DocumentElement
    if ($null -eq $root -or
        -not [string]::Equals([string]$root.LocalName, 'root', [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$root.GetAttribute('type'), 'object', [StringComparison]::Ordinal)) {
        throw 'Prestage kit trusted-key document must be one JSON object.'
    }
    Assert-RevAgentJsonTokenTree -Element $root -Context '$'

    $topLevelChildren = @(Get-RevAgentJsonMappedElementChildren -Element $root)
    $topLevelNames = @($topLevelChildren | ForEach-Object { Get-RevAgentJsonMappedPropertyName -Element $_ })
    $allowedTopLevelNames = @('schemaVersion', 'app', 'generatedAtUtc', 'trustedKeys')
    $trustedKeysNodes = @($topLevelChildren | Where-Object { [string]::Equals((Get-RevAgentJsonMappedPropertyName -Element $_), 'trustedKeys', [StringComparison]::Ordinal) })
    if ($trustedKeysNodes.Count -ne 1 -or
        -not [string]::Equals([string]$trustedKeysNodes[0].GetAttribute('type'), 'object', [StringComparison]::Ordinal) -or
        @($topLevelNames | Where-Object { $allowedTopLevelNames -cnotcontains $_ }).Count -ne 0 -or
        $topLevelChildren.Count -notin @(1, 4)) {
        throw 'Prestage kit trusted-key token properties must be trustedKeys alone or the exact public metadata allowlist (schemaVersion, app, generatedAtUtc, trustedKeys).'
    }
    if ($topLevelChildren.Count -eq 4) {
        foreach ($metadata in @(@('schemaVersion', 'number'), @('app', 'string'), @('generatedAtUtc', 'string'))) {
            $metadataNode = @($topLevelChildren | Where-Object { [string]::Equals((Get-RevAgentJsonMappedPropertyName -Element $_), [string]$metadata[0], [StringComparison]::Ordinal) })
            if ($metadataNode.Count -ne 1 -or -not [string]::Equals([string]$metadataNode[0].GetAttribute('type'), [string]$metadata[1], [StringComparison]::Ordinal)) {
                throw "Prestage kit trusted-key token metadata is incomplete or mistyped: $($metadata[0])"
            }
        }
    }
    $keyNodes = @(Get-RevAgentJsonMappedElementChildren -Element $trustedKeysNodes[0])
    if ($keyNodes.Count -lt 1) { throw 'Prestage kit trusted-key token document contains no public keys.' }
    $requiredRecordProperties = @('algorithm', 'publicKeyFingerprint', 'publicKeyXml')
    $allowedRecordProperties = @('algorithm', 'publicKeyFingerprint', 'publicKeyXml', 'purpose')
    foreach ($keyNode in $keyNodes) {
        $keyId = Get-RevAgentJsonMappedPropertyName -Element $keyNode
        if ($keyId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or
            -not [string]::Equals([string]$keyNode.GetAttribute('type'), 'object', [StringComparison]::Ordinal)) {
            throw "Prestage kit trusted-key token entry is not a valid public-key object: $keyId"
        }
        $recordNodes = @(Get-RevAgentJsonMappedElementChildren -Element $keyNode)
        $recordNames = @($recordNodes | ForEach-Object { Get-RevAgentJsonMappedPropertyName -Element $_ })
        if ($recordNodes.Count -notin @(3, 4) -or
            @($recordNames | Where-Object { $allowedRecordProperties -cnotcontains $_ }).Count -ne 0 -or
            @($requiredRecordProperties | Where-Object { $recordNames -cnotcontains $_ }).Count -ne 0 -or
            ($recordNodes.Count -eq 4 -and $recordNames -cnotcontains 'purpose')) {
            throw "Prestage kit trusted-key token entry properties must match the public allowlist (algorithm, publicKeyFingerprint, publicKeyXml, optional purpose): $keyId"
        }
        foreach ($recordNode in $recordNodes) {
            if (-not [string]::Equals([string]$recordNode.GetAttribute('type'), 'string', [StringComparison]::Ordinal)) {
                throw "Prestage kit trusted-key token public fields must all be strings: $keyId"
            }
        }
    }
    return $xml
}

function Assert-RevAgentPublicTrustedKeys {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes, [switch]$AllowTestIdentity)

    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $text = $strictUtf8.GetString($Bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }

    # Reject secret-bearing encodings before JSON normalization can discard
    # duplicate keys, escapes, or the original byte representation. Accepted
    # files are still packaged byte-for-byte after this strict public-only
    # validation succeeds.
    if ($text -match '(?i)"(?:d|p|q|dp|dq|qi|oth|k|privatekey|privatekeypem|secret|password|credential)"\s*:') {
        throw "Prestage kit trusted-key raw JSON contains a forbidden private JWK or secret-bearing property."
    }
    if ($text -match '(?i)-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----') {
        throw "Prestage kit trusted-key raw JSON contains forbidden PEM private-key material."
    }
    if ($text -match '(?i)<\s*(?:D|P|Q|DP|DQ|InverseQ)\s*>') {
        throw "Prestage kit trusted-key raw JSON contains forbidden private RSA XML material."
    }

    $tokenDocument = Read-RevAgentStrictTrustedKeyJsonTokens -Bytes $Bytes
    $document = $text | ConvertFrom-Json

    if ($document -isnot [pscustomobject]) {
        throw "Prestage kit trusted-key document must be one JSON object."
    }
    $topLevelProperties = @($document.PSObject.Properties)
    $topLevelPropertyNames = @($topLevelProperties | ForEach-Object { [string]$_.Name })
    $allowedTopLevelProperties = @('schemaVersion', 'app', 'generatedAtUtc', 'trustedKeys')
    if ($topLevelProperties.Count -notin @(1, 4) -or
        @($topLevelPropertyNames | Where-Object { $allowedTopLevelProperties -cnotcontains $_ }).Count -ne 0 -or
        $topLevelPropertyNames -cnotcontains 'trustedKeys') {
        throw "Prestage kit trusted-key document properties must be trustedKeys alone or the exact public metadata allowlist."
    }
    if ($topLevelProperties.Count -eq 4) {
        foreach ($metadataName in @('schemaVersion', 'app', 'generatedAtUtc')) {
            if ($topLevelPropertyNames -cnotcontains $metadataName) { throw "Prestage kit trusted-key metadata is incomplete: $metadataName" }
        }
        $tokenRoot = $tokenDocument.DocumentElement
        $generatedAtUtcNodes = @(Get-RevAgentJsonMappedElementChildren -Element $tokenRoot | Where-Object {
                [string]::Equals((Get-RevAgentJsonMappedPropertyName -Element $_), 'generatedAtUtc', [StringComparison]::Ordinal)
            })
        $generatedAtUtcText = if ($generatedAtUtcNodes.Count -eq 1) { [string]$generatedAtUtcNodes[0].InnerText } else { $null }
        $generatedAt = [DateTime]::MinValue
        if ([int]$document.schemaVersion -ne 1 -or
            [string]$document.app -notin @('revAgent', 'revit-mcp-skill') -or
            [string]$generatedAtUtcText -cnotmatch 'Z$' -or
            -not [DateTime]::TryParse([string]$generatedAtUtcText, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$generatedAt) -or
            $generatedAt.Kind -ne [DateTimeKind]::Utc -or
            $generatedAt -gt [DateTime]::UtcNow.AddMinutes(5)) {
            throw 'Prestage kit trusted-key public metadata is invalid.'
        }
    }
    if ($document.trustedKeys -isnot [pscustomobject]) {
        throw "Prestage kit trusted-key document has no trustedKeys object."
    }

    $keyProperties = @($document.trustedKeys.PSObject.Properties)
    if ($keyProperties.Count -lt 1) { throw "Prestage kit trusted-key document contains no public keys." }
    $fingerprints = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($keyProperty in $keyProperties) {
        if ([string]$keyProperty.Name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
            throw "Prestage kit trusted-key id is outside the public key-id policy: $($keyProperty.Name)"
        }
        $key = $keyProperty.Value
        if ($key -isnot [pscustomobject]) {
            throw "Prestage kit trusted-key entry must be one public-key object: $($keyProperty.Name)"
        }
        $recordProperties = @($key.PSObject.Properties)
        $requiredRecordProperties = @('algorithm', 'publicKeyFingerprint', 'publicKeyXml')
        $allowedRecordProperties = @('algorithm', 'publicKeyFingerprint', 'publicKeyXml', 'purpose')
        if ($recordProperties.Count -notin @(3, 4) -or
            @($recordProperties | Where-Object { $allowedRecordProperties -cnotcontains [string]$_.Name }).Count -ne 0 -or
            @($requiredRecordProperties | Where-Object { @($recordProperties.Name) -cnotcontains $_ }).Count -ne 0 -or
            ($recordProperties.Count -eq 4 -and @($recordProperties.Name) -cnotcontains 'purpose')) {
            throw "Prestage kit trusted-key entry properties must match the public allowlist (algorithm, publicKeyFingerprint, publicKeyXml, optional purpose): $($keyProperty.Name)"
        }
        if ($key.algorithm -isnot [string] -or
            $key.publicKeyXml -isnot [string] -or
            $key.publicKeyFingerprint -isnot [string]) {
            throw "Prestage kit trusted-key entry public fields must all be strings: $($keyProperty.Name)"
        }
        if ($recordProperties.Count -eq 4 -and (-not ($key.purpose -is [string]) -or -not [string]::Equals([string]$key.purpose, 'release-signing', [StringComparison]::Ordinal))) {
            throw "Prestage kit trusted-key purpose must be release-signing: $($keyProperty.Name)"
        }
        if (-not [string]::Equals([string]$key.algorithm, 'RS256', [StringComparison]::Ordinal) -or
            [string]::IsNullOrWhiteSpace([string]$key.publicKeyXml) -or
            [string]$key.publicKeyFingerprint -notmatch '^[A-Fa-f0-9]{64}$') {
            throw "Prestage kit trusted-key entry is not a complete RS256 public-key record: $($keyProperty.Name)"
        }

        $settings = [Xml.XmlReaderSettings]::new()
        $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
        $settings.XmlResolver = $null
        $stringReader = [IO.StringReader]::new([string]$key.publicKeyXml)
        $xmlReader = $null
        try {
            $xmlReader = [Xml.XmlReader]::Create($stringReader, $settings)
            $xml = [Xml.XmlDocument]::new()
            $xml.XmlResolver = $null
            $xml.Load($xmlReader)
        }
        finally {
            if ($null -ne $xmlReader) { $xmlReader.Dispose() }
            $stringReader.Dispose()
        }
        if ($null -eq $xml.DocumentElement -or -not [string]::Equals($xml.DocumentElement.Name, 'RSAKeyValue', [StringComparison]::Ordinal)) {
            throw "Prestage kit trusted-key XML is not an RSAKeyValue document: $($keyProperty.Name)"
        }
        $elementNames = @($xml.DocumentElement.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element } | ForEach-Object { $_.Name })
        if ($elementNames.Count -ne 2 -or @((Compare-Object @('Exponent', 'Modulus') @($elementNames | Sort-Object) -SyncWindow 0)).Count -ne 0) {
            throw "Prestage kit trusted-key XML contains private or unexpected RSA parameters: $($keyProperty.Name)"
        }
        foreach ($requiredElement in @('Modulus', 'Exponent')) {
            $node = $xml.DocumentElement.SelectSingleNode($requiredElement)
            if ($null -eq $node -or [string]::IsNullOrWhiteSpace([string]$node.InnerText)) {
                throw "Prestage kit trusted-key XML is missing $requiredElement for $($keyProperty.Name)."
            }
            try { [void][Convert]::FromBase64String(([string]$node.InnerText).Trim()) }
            catch { throw "Prestage kit trusted-key XML contains invalid $requiredElement base64 for $($keyProperty.Name)." }
        }

        $normalizedPublicKey = ([string]$key.publicKeyXml).Trim() -replace '\s+', ''
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actualFingerprint = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedPublicKey)))).Replace('-', '') }
        finally { $sha.Dispose() }
        if (-not [string]::Equals($actualFingerprint, [string]$key.publicKeyFingerprint, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Prestage kit trusted-key fingerprint does not match the exact publicKeyXml bytes: $($keyProperty.Name)"
        }
        if (-not $fingerprints.Add($actualFingerprint)) { throw "Prestage kit trusted-key document contains a duplicate public-key fingerprint: $($keyProperty.Name)" }
    }

    if (-not $AllowTestIdentity) {
        if ($keyProperties.Count -gt 2 -or
            @($keyProperties | Where-Object { [string]::Equals([string]$_.Name, 'revagent-prod-rsa-2026q3', [StringComparison]::Ordinal) }).Count -ne 1) {
            throw "Production prestage kit requires revagent-prod-rsa-2026q3 and permits at most one future rotation key."
        }
        $key = $document.trustedKeys.'revagent-prod-rsa-2026q3'
        if (-not [string]::Equals([string]$key.algorithm, 'RS256', [StringComparison]::Ordinal) -or
            -not [string]::Equals([string]$key.publicKeyFingerprint, '32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Production prestage kit trusted-key metadata does not match the pinned RS256 identity."
        }
        if ($keyProperties.Count -eq 2) {
            $futureId = [string](@($keyProperties | Where-Object { -not [string]::Equals([string]$_.Name, 'revagent-prod-rsa-2026q3', [StringComparison]::Ordinal) })[0].Name)
            $match = [regex]::Match($futureId, '^revagent-prod-rsa-(?<year>[0-9]{4})q(?<quarter>[1-4])$')
            $futureOrdinal = if ($match.Success) { ([int]$match.Groups['year'].Value * 4) + [int]$match.Groups['quarter'].Value } else { 0 }
            if (-not $match.Success -or $futureOrdinal -le ((2026 * 4) + 3)) {
                throw "The optional production prestage rotation key must be later than revagent-prod-rsa-2026q3: $futureId"
            }
        }
    }
    return $document
}

if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) { throw "Repository root was not found: $RepoRoot" }
Assert-RevAgentKitOrdinaryPathChain -Path $RepoRoot -StopRoot ([IO.Path]::GetPathRoot($RepoRoot))
if (-not (Test-Path -LiteralPath $TrustedKeysPath -PathType Leaf)) { throw "Trusted release keys were not found: $TrustedKeysPath" }
if ($TrustedKeysPath.StartsWith('\\', [StringComparison]::Ordinal)) { throw "Prestage kit trusted keys must come from a local IT-controlled path, not NAS transport." }
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) { throw "Prestage kit output parent must already exist: $outputParent" }
if (Test-Path -LiteralPath $OutputDirectory) { throw "Prestage kit output directory already exists; refusing replacement: $OutputDirectory" }
Assert-RevAgentKitOrdinaryPathChain -Path $outputParent -StopRoot ([IO.Path]::GetPathRoot($outputParent))

$allowedOutputPrefixes = [Collections.Generic.List[string]]::new()
[void]$allowedOutputPrefixes.Add(([IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\") + "\"))
if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    [void]$allowedOutputPrefixes.Add(([IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd("\") + "\"))
}
if (@($allowedOutputPrefixes | Where-Object { $OutputDirectory.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -eq 0) {
    throw "Prestage kit output must be below the process TEMP root or RUNNER_TEMP."
}
if (Test-RevAgentKitPathUnderRoot -Path $OutputDirectory -Root $RepoRoot) {
    throw "Prestage kit output must remain outside the repository and signed-release build roots."
}
if ($EnableSealedStageTestMode -and -not $AllowTestTrustedKeys) {
    throw "EnableSealedStageTestMode is available only with AllowTestTrustedKeys in disposable TEMP fixtures."
}

$trustedKeysEvidence = Read-RevAgentKitSourceBytes `
    -Path $TrustedKeysPath `
    -AllowedRoot ([IO.Path]::GetPathRoot($TrustedKeysPath)) `
    -MaxBytes 1048576
[void](Assert-RevAgentPublicTrustedKeys -Bytes ([byte[]]$trustedKeysEvidence.Bytes) -AllowTestIdentity:$AllowTestTrustedKeys)

$sourceMap = [ordered]@{
    'IT-Prestage-revAgent.cmd' = Join-Path $RepoRoot 'scripts\IT-Prestage-revAgent.cmd'
    'scripts/Invoke-RevAgentSupervisedPrestage.ps1' = Join-Path $RepoRoot 'scripts\Invoke-RevAgentSupervisedPrestage.ps1'
    'scripts/New-RevAgentBootstrapPrestageEvidence.ps1' = Join-Path $RepoRoot 'scripts\New-RevAgentBootstrapPrestageEvidence.ps1'
    'installer/lib/RevAgent.DistributionIntegrity.psm1' = Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1'
    'config/release-trusted-keys.json' = $TrustedKeysPath
}
$sourceEvidence = [ordered]@{}
foreach ($entry in $sourceMap.GetEnumerator()) {
    if ([string]::Equals([string]$entry.Key, 'IT-Prestage-revAgent.cmd', [StringComparison]::Ordinal)) {
        continue
    }
    elseif ([string]::Equals([string]$entry.Key, 'config/release-trusted-keys.json', [StringComparison]::Ordinal)) {
        # Reuse the same exclusive, bounded byte acquisition that was parsed,
        # fingerprinted, and pinned above. Never reopen the protected key file.
        $sourceEvidence[$entry.Key] = $trustedKeysEvidence
    }
    else {
        $sourceEvidence[$entry.Key] = Read-RevAgentKitSourceBytes -Path ([string]$entry.Value) -AllowedRoot $RepoRoot
    }
}

# Seal the four elevated runtime inputs into the CMD bytes. The external CD
# artifact digest authenticates this wrapper; once launched, the captured
# pins ensure the elevated staging process never executes mutable source-kit
# path bytes.
$wrapperTemplatePath = [string]$sourceMap['IT-Prestage-revAgent.cmd']
$wrapperTemplateEvidence = Read-RevAgentKitSourceBytes -Path $wrapperTemplatePath -AllowedRoot $RepoRoot
$strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
$wrapperText = $strictUtf8.GetString([byte[]]$wrapperTemplateEvidence.Bytes)
$wrapperPins = [ordered]@{
    '__REVAGENT_DRIVER_SHA256__' = [string]$sourceEvidence['scripts/Invoke-RevAgentSupervisedPrestage.ps1'].Sha256
    '__REVAGENT_EVIDENCE_SHA256__' = [string]$sourceEvidence['scripts/New-RevAgentBootstrapPrestageEvidence.ps1'].Sha256
    '__REVAGENT_INTEGRITY_SHA256__' = [string]$sourceEvidence['installer/lib/RevAgent.DistributionIntegrity.psm1'].Sha256
    '__REVAGENT_TRUSTED_KEYS_SHA256__' = [string]$sourceEvidence['config/release-trusted-keys.json'].Sha256
}
foreach ($pin in $wrapperPins.GetEnumerator()) {
    if ([regex]::Matches($wrapperText, [regex]::Escape([string]$pin.Key)).Count -ne 1) {
        throw "Supervised prestage CMD template must contain exactly one sealing placeholder: $($pin.Key)"
    }
    if ([string]$pin.Value -notmatch '^[A-F0-9]{64}$') {
        throw "Supervised prestage CMD sealing source hash is invalid: $($pin.Key)"
    }
    $wrapperText = $wrapperText.Replace([string]$pin.Key, [string]$pin.Value)
}
if ($EnableSealedStageTestMode) {
    $encodedMatch = [regex]::Match($wrapperText, '(?m)^set "REVAGENT_PRESTAGE_STAGE_ENCODED=(?<encoded>[A-Za-z0-9+/=]+)"\r?$')
    if (-not $encodedMatch.Success) { throw 'Supervised prestage CMD test fixture could not locate the fixed encoded bootstrap.' }
    $encodedCommand = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encodedMatch.Groups['encoded'].Value))
    $productionInvocationSuffix = '-ExpectedTrustedKeysSha256 $env:REVAGENT_PRESTAGE_TRUSTED_KEYS_SHA256 -Channel stable'
    if ([regex]::Matches($encodedCommand, [regex]::Escape($productionInvocationSuffix)).Count -ne 1) {
        throw 'Supervised prestage CMD test fixture could not bind the sealed-stage invocation.'
    }
    $testInvocationSuffix = $productionInvocationSuffix + ' -SealedStageTestConfigPath $env:REVAGENT_PRESTAGE_TEST_CONFIG -ExpectedSealedStageTestConfigSha256 $env:REVAGENT_PRESTAGE_TEST_CONFIG_SHA256'
    $encodedCommand = $encodedCommand.Replace($productionInvocationSuffix, $testInvocationSuffix)
    $testEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($encodedCommand))
    $wrapperText = $wrapperText.Substring(0, $encodedMatch.Groups['encoded'].Index) + $testEncoded + $wrapperText.Substring($encodedMatch.Groups['encoded'].Index + $encodedMatch.Groups['encoded'].Length)
}
if ($wrapperText -match '__REVAGENT_[A-Z0-9_]+__') {
    throw 'Supervised prestage CMD template contains an unrecognized or unsealed placeholder.'
}
$wrapperBytes = $strictUtf8.GetBytes($wrapperText)
$wrapperSha = [Security.Cryptography.SHA256]::Create()
try { $wrapperSha256 = ([BitConverter]::ToString($wrapperSha.ComputeHash($wrapperBytes))).Replace('-', '') }
finally { $wrapperSha.Dispose() }
$sourceEvidence['IT-Prestage-revAgent.cmd'] = [pscustomobject][ordered]@{
    Path = $wrapperTemplatePath
    Bytes = $wrapperBytes
    Sha256 = $wrapperSha256
}

[void][IO.Directory]::CreateDirectory($OutputDirectory)
Assert-RevAgentKitOrdinaryPathChain -Path $OutputDirectory -StopRoot $OutputDirectory
$zipPath = Join-Path $OutputDirectory 'revAgent-supervised-prestage-kit.zip'
$checksumPath = Join-Path $OutputDirectory 'revAgent-supervised-prestage-kit.sha256'

Add-Type -AssemblyName System.IO.Compression
$zipStream = $null
$archive = $null
try {
    $zipStream = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $archive = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Create, $true)
    foreach ($entryName in @($sourceMap.Keys | Sort-Object)) {
        $zipEntry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
        $zipEntry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $zipEntry.ExternalAttributes = 0
        $entryStream = $zipEntry.Open()
        try {
            $bytes = [byte[]]$sourceEvidence[$entryName].Bytes
            $entryStream.Write($bytes, 0, $bytes.Length)
        }
        finally { $entryStream.Dispose() }
    }
}
finally {
    if ($null -ne $archive) { $archive.Dispose() }
    if ($null -ne $zipStream) { $zipStream.Dispose() }
}

$zipSha256 = (Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash
$checksumBytes = [Text.UTF8Encoding]::new($false).GetBytes(($zipSha256.ToLowerInvariant() + ' *' + (Split-Path -Leaf $zipPath) + "`n"))
$checksumStream = $null
try {
    $checksumStream = [IO.File]::Open($checksumPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $checksumStream.Write($checksumBytes, 0, $checksumBytes.Length)
    $checksumStream.Flush($true)
}
finally { if ($null -ne $checksumStream) { $checksumStream.Dispose() } }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$verificationArchive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $actualNames = @($verificationArchive.Entries | ForEach-Object { $_.FullName } | Sort-Object)
    $expectedNames = @($sourceMap.Keys | Sort-Object)
    if ($actualNames.Count -ne $expectedNames.Count -or @((Compare-Object $expectedNames $actualNames -SyncWindow 0)).Count -ne 0) {
        throw "Prestage kit ZIP does not contain the exact five-file allowlist."
    }
    foreach ($entryName in $expectedNames) {
        $zipEntries = @($verificationArchive.Entries | Where-Object { [string]::Equals($_.FullName, $entryName, [StringComparison]::Ordinal) })
        if ($zipEntries.Count -ne 1) { throw "Prestage kit ZIP entry multiplicity mismatch: $entryName" }
        $entryStream = $zipEntries[0].Open()
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $entrySha256 = ([BitConverter]::ToString($sha.ComputeHash($entryStream))).Replace("-", "") }
        finally { $sha.Dispose(); $entryStream.Dispose() }
        if (-not [string]::Equals($entrySha256, [string]$sourceEvidence[$entryName].Sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Prestage kit ZIP entry hash mismatch: $entryName"
        }
    }
}
finally { $verificationArchive.Dispose() }

$result = [pscustomobject][ordered]@{
    success = $true
    action = 'supervised-prestage-kit-build'
    outputDirectory = $OutputDirectory
    zipPath = $zipPath
    checksumPath = $checksumPath
    sha256 = $zipSha256
    entryCount = $sourceMap.Count
    entries = @($sourceMap.Keys | Sort-Object)
}
if ($OutputJson) { $result | ConvertTo-Json -Depth 6 }
else { $result }
