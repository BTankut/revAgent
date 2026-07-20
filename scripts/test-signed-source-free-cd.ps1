<#
.SYNOPSIS
    CI-safe tests for the signed source-free CD producer and NAS publish wrapper.
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

function Assert-ThrowsLike {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Message
    )

    $caught = $null
    try { & $Action }
    catch { $caught = $_ }
    if ($null -eq $caught -or [string]$caught.Exception.Message -notmatch $Pattern) {
        throw "$Message Actual: $(if ($null -eq $caught) { '<no error>' } else { $caught.Exception.Message })"
    }
}

# Minimal workflow reader for this repository's simple GitHub Actions shape:
# top-level jobs, two-space job indentation, and single-line job `if:` values.
function Get-WorkflowJobIfCondition {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$JobName
    )

    $insideJobs = $false
    $insideTargetJob = $false
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*(#.*)?$') {
            continue
        }

        if (-not $insideJobs) {
            if ($line -match '^jobs:\s*$') {
                $insideJobs = $true
            }
            continue
        }

        if ($line -match '^(?<indent>\s*)(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.*)$') {
            $indent = $Matches.indent.Length
            $key = $Matches.key
            $value = $Matches.value.Trim()

            if ($indent -eq 0) {
                break
            }
            if ($indent -eq 2) {
                $insideTargetJob = [string]::Equals($key, $JobName, [System.StringComparison]::Ordinal)
                continue
            }
            if ($insideTargetJob -and $indent -eq 4 -and [string]::Equals($key, "if", [System.StringComparison]::Ordinal)) {
                return $value
            }
        }
    }

    return $null
}

function ConvertTo-GithubWorkflowIfExpression {
    param([AllowNull()][string]$Expression)

    if ([string]::IsNullOrWhiteSpace($Expression)) {
        return ""
    }

    $trimmed = $Expression.Trim()
    $match = [regex]::Match($trimmed, '^\$\{\{\s*(?<expr>.*?)\s*\}\}$')
    if ($match.Success) {
        $trimmed = $match.Groups["expr"].Value
    }

    return (($trimmed -replace '\s+', ' ').Trim())
}

function New-TestRsaProvider {
    $cspParameters = [System.Security.Cryptography.CspParameters]::new(24)
    $cspParameters.Flags = [System.Security.Cryptography.CspProviderFlags]::CreateEphemeralKey
    return [System.Security.Cryptography.RSACryptoServiceProvider]::new(2048, $cspParameters)
}

function Get-Sha256ForBytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace('-', '') }
    finally { $sha256.Dispose() }
}

function Get-TestTreeDigest {
    param([Parameter(Mandatory = $true)][string]$Root)

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $rows = [System.Collections.Generic.List[string]]::new()
    foreach ($item in @(Get-ChildItem -LiteralPath $rootFull -Recurse -Force | Sort-Object { $_.FullName.Substring($rootFull.Length).Replace('\', '/') })) {
        $relative = $item.FullName.Substring($rootFull.Length).TrimStart('\', '/').Replace('\', '/')
        if ($item.PSIsContainer) {
            [void]$rows.Add("D|$relative")
        }
        else {
            [void]$rows.Add(("F|{0}|{1}|{2}" -f $relative, [long]$item.Length, (Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash))
        }
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($rows -join "`n"))
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '') }
    finally { $sha.Dispose() }
    return [pscustomobject]@{ itemCount = $rows.Count; sha256 = $digest }
}

function New-TestFunctionHarness {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string[]]$FunctionNames,
        [Parameter(Mandatory = $true)][string]$ParameterDeclaration,
        [Parameter(Mandatory = $true)][string]$Body
    )

    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw "Could not parse validator source '$Path': $($errors[0].Message)" }
    $definitions = [Collections.Generic.List[string]]::new()
    foreach ($functionName in $FunctionNames) {
        $matches = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and [string]::Equals($node.Name, $functionName, [StringComparison]::Ordinal) }, $true))
        if ($matches.Count -ne 1) { throw "Validator harness expected one function '$functionName' in '$Path'; found $($matches.Count)." }
        [void]$definitions.Add($matches[0].Extent.Text)
    }
    return [ScriptBlock]::Create($ParameterDeclaration + "`r`n" + ($definitions.ToArray() -join "`r`n`r`n") + "`r`n" + $Body)
}

Write-Host "Test signed source-free CD producer and NAS publish wrapper"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-signed-source-free-cd-test-" + [Guid]::NewGuid().ToString("N"))
$releaseRoot = Join-Path $tempRoot "release-root"
$nasRoot = Join-Path $tempRoot "revAgent-deploy"
$secretRoot = Join-Path $tempRoot "secrets"
$version = "2026.06.23.1-cd-test"
$keyId = "test-cd-key"
$releaseSequence = 3001
$minimumAcceptedReleaseSequence = 3000
$rsa = New-TestRsaProvider
$futureRsa = $null
$thirdRsa = $null

try {
    New-Item -ItemType Directory -Path $secretRoot -Force | Out-Null
    $privateKeyPath = Join-Path $secretRoot "release-signing-private.xml"
    $rsa.ToXmlString($true) | Set-Content -LiteralPath $privateKeyPath -Encoding UTF8
    $publicKeyXml = $rsa.ToXmlString($false)
    $trustedKeys = [ordered]@{
        schemaVersion = 1
        app = 'revAgent'
        generatedAtUtc = '2026-07-20T00:00:00.0000000Z'
        trustedKeys = [ordered]@{}
    }
    $trustedKeys.trustedKeys[$keyId] = [pscustomobject][ordered]@{
        publicKeyXml = $publicKeyXml
        publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
        algorithm = "RS256"
        purpose = 'release-signing'
    }
    $trustedKeysPath = Join-Path $secretRoot "release-trusted-keys.json"
    $trustedKeys | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $trustedKeysPath -Encoding UTF8

    Write-Host 'Test production two-key rotation-window validators'
    $futureRsa = New-TestRsaProvider
    $thirdRsa = New-TestRsaProvider
    $q3TestRecord = [ordered]@{
        publicKeyXml = $publicKeyXml
        publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
        algorithm = 'RS256'
    }
    $futurePublicXml = $futureRsa.ToXmlString($false)
    $futureTestRecord = [ordered]@{
        publicKeyXml = $futurePublicXml
        publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $futurePublicXml
        algorithm = 'RS256'
    }
    $thirdPublicXml = $thirdRsa.ToXmlString($false)
    $thirdTestRecord = [ordered]@{
        publicKeyXml = $thirdPublicXml
        publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $thirdPublicXml
        algorithm = 'RS256'
    }
    $rotationPath = Join-Path $secretRoot 'rotation-q3-q4.json'
    [ordered]@{ trustedKeys = [ordered]@{ 'revagent-prod-rsa-2026q3' = $q3TestRecord; 'revagent-prod-rsa-2026q4' = $futureTestRecord } } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $rotationPath -Encoding UTF8

    $legacyPublisherHarness = New-TestFunctionHarness `
        -Path (Join-Path $RepoRoot 'installer\nas\publish-nas-release.ps1') `
        -FunctionNames @('Get-RevAgentTrustedKeyJsonPropertyName', 'Get-RevAgentTrustedKeyJsonChildren', 'Assert-RevAgentTrustedKeyJsonTree', 'Read-RevAgentTrustedKeysEvidence') `
        -ParameterDeclaration 'param([string]$Path, [string]$PinnedFingerprint)' `
        -Body @'
$script:RevAgentProductionSigningKeyId = 'revagent-prod-rsa-2026q3'
$script:RevAgentProductionSigningFingerprint = $PinnedFingerprint
[void](Read-RevAgentTrustedKeysEvidence -Path $Path)
'@
    $cdProducerHarness = New-TestFunctionHarness `
        -Path (Join-Path $RepoRoot 'scripts\invoke-signed-source-free-cd.ps1') `
        -FunctionNames @('Assert-RevAgentCdProductionTrustedKeysDocument') `
        -ParameterDeclaration 'param([string]$Path, [string]$PinnedFingerprint, [string]$RepoRoot)' `
        -Body @'
$productionSigningKeyId = 'revagent-prod-rsa-2026q3'
$productionSigningFingerprint = $PinnedFingerprint
$integrity = Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1') -Force -PassThru
[void](Assert-RevAgentCdProductionTrustedKeysDocument -Path $Path -IntegrityModule $integrity)
'@
    $nasPublisherTestRepo = Join-Path $tempRoot 'rotation-nas-publisher-repo'
    $nasPublisherTestModuleRoot = Join-Path $nasPublisherTestRepo 'installer\lib'
    [void][IO.Directory]::CreateDirectory($nasPublisherTestModuleRoot)
    $bootstrapTrustSourcePath = Join-Path $RepoRoot 'installer\lib\RevAgent.BootstrapTrust.psm1'
    $bootstrapTrustTestSource = Get-Content -Raw -LiteralPath $bootstrapTrustSourcePath
    $productionPin = '32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33'
    Assert-Equal ([regex]::Matches($bootstrapTrustTestSource, [regex]::Escape($productionPin)).Count) 1 'Bootstrap-trust validator production fingerprint pin multiplicity drifted.'
    $bootstrapTrustTestSource = $bootstrapTrustTestSource.Replace($productionPin, [string]$q3TestRecord.publicKeyFingerprint)
    [IO.File]::WriteAllText((Join-Path $nasPublisherTestModuleRoot 'RevAgent.BootstrapTrust.psm1'), $bootstrapTrustTestSource, [Text.UTF8Encoding]::new($false))
    $nasPublisherHarness = New-TestFunctionHarness `
        -Path (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') `
        -FunctionNames @('Assert-RevAgentProductionTrustedKeysDocument') `
        -ParameterDeclaration 'param([string]$Path, [string]$PinnedFingerprint, [string]$RepoRoot)' `
        -Body @'
$productionSigningKeyId = 'revagent-prod-rsa-2026q3'
$productionSigningFingerprint = $PinnedFingerprint
Assert-RevAgentProductionTrustedKeysDocument -Path $Path
'@
    & $legacyPublisherHarness $rotationPath ([string]$q3TestRecord.publicKeyFingerprint)
    & $cdProducerHarness $rotationPath ([string]$q3TestRecord.publicKeyFingerprint) $RepoRoot
    & $nasPublisherHarness $rotationPath ([string]$q3TestRecord.publicKeyFingerprint) $nasPublisherTestRepo

    $metadataQ3Path = Join-Path $secretRoot 'rotation-q3-canonical-public-metadata.json'
    $metadataQ3Record = [ordered]@{
        publicKeyXml = $q3TestRecord.publicKeyXml
        publicKeyFingerprint = $q3TestRecord.publicKeyFingerprint
        algorithm = 'RS256'
        purpose = 'release-signing'
    }
    [ordered]@{
        schemaVersion = 1
        app = 'revit-mcp-skill'
        generatedAtUtc = '2026-06-23T12:34:03.0000000Z'
        trustedKeys = [ordered]@{ 'revagent-prod-rsa-2026q3' = $metadataQ3Record }
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $metadataQ3Path -Encoding UTF8
    & $legacyPublisherHarness $metadataQ3Path ([string]$q3TestRecord.publicKeyFingerprint)
    & $cdProducerHarness $metadataQ3Path ([string]$q3TestRecord.publicKeyFingerprint) $RepoRoot
    & $nasPublisherHarness $metadataQ3Path ([string]$q3TestRecord.publicKeyFingerprint) $nasPublisherTestRepo

    $duplicateKeyJson = ([ordered]@{ trustedKeys = [ordered]@{ 'revagent-prod-rsa-2026q3' = $q3TestRecord } } | ConvertTo-Json -Depth 8 -Compress)
    $duplicateKeyJson = [regex]::Replace($duplicateKeyJson, '"algorithm":"RS256"', '"algorithm":"RS256","algorithm":"RS256"', 1)

    $invalidRotationDocuments = @(
        [pscustomobject]@{
            name = 'more than two production keys'
            path = Join-Path $secretRoot 'rotation-too-many.json'
            value = [ordered]@{ trustedKeys = [ordered]@{ 'revagent-prod-rsa-2026q3' = $q3TestRecord; 'revagent-prod-rsa-2026q4' = $futureTestRecord; 'revagent-prod-rsa-2027q1' = $thirdTestRecord } }
            pattern = 'one key or a two-key rotation window|one or two public keys|at most one transition key'
        },
        [pscustomobject]@{
            name = 'missing q3 production key'
            path = Join-Path $secretRoot 'rotation-q3-missing.json'
            value = [ordered]@{ trustedKeys = [ordered]@{ 'revagent-prod-rsa-2026q4' = $futureTestRecord } }
            pattern = 'must contain.*revagent-prod-rsa-2026q3|missing.*revagent-prod-rsa-2026q3'
        },
        [pscustomobject]@{
            name = 'private key field'
            path = Join-Path $secretRoot 'rotation-private-field.json'
            value = [ordered]@{ trustedKeys = [ordered]@{ 'revagent-prod-rsa-2026q3' = [ordered]@{ publicKeyXml=$q3TestRecord.publicKeyXml; publicKeyFingerprint=$q3TestRecord.publicKeyFingerprint; algorithm='RS256'; d='private' } } }
            pattern = 'forbidden private|properties must exactly match|non-public or unknown property'
        },
        [pscustomobject]@{
            name = 'older transition key'
            path = Join-Path $secretRoot 'rotation-older-transition.json'
            value = [ordered]@{ trustedKeys = [ordered]@{ 'revagent-prod-rsa-2026q3' = $q3TestRecord; 'revagent-prod-rsa-2026q2' = $futureTestRecord } }
            pattern = 'rotation key must be later|transition key must be (?:strictly )?later'
        },
        [pscustomobject]@{
            name = 'duplicate decoded property'
            path = Join-Path $secretRoot 'rotation-duplicate-property.json'
            raw = $duplicateKeyJson
            pattern = 'duplicate decoded (?:JSON )?property|empty or duplicate decoded property'
        },
        [pscustomobject]@{
            name = 'non-literal-Z public metadata timestamp'
            path = Join-Path $secretRoot 'rotation-metadata-offset.json'
            value = [ordered]@{
                schemaVersion = 1
                app = 'revAgent'
                generatedAtUtc = '2026-06-23T12:34:03+00:00'
                trustedKeys = [ordered]@{ 'revagent-prod-rsa-2026q3' = $metadataQ3Record }
            }
            pattern = 'public metadata|trusted-key metadata|generatedAtUtc|ISO UTC'
        },
        [pscustomobject]@{
            name = 'lowercase-z public metadata timestamp'
            path = Join-Path $secretRoot 'rotation-metadata-lowercase-z.json'
            value = [ordered]@{
                schemaVersion = 1
                app = 'revAgent'
                generatedAtUtc = '2026-06-23T12:34:03z'
                trustedKeys = [ordered]@{ 'revagent-prod-rsa-2026q3' = $metadataQ3Record }
            }
            pattern = 'public metadata|trusted-key metadata|generatedAtUtc|ISO UTC'
        }
    )
    foreach ($invalid in $invalidRotationDocuments) {
        if ($null -ne $invalid.PSObject.Properties['raw']) {
            [IO.File]::WriteAllText([string]$invalid.path, [string]$invalid.raw, [Text.UTF8Encoding]::new($false))
        }
        else {
            $invalid.value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $invalid.path -Encoding UTF8
        }
        Assert-ThrowsLike -Action { & $legacyPublisherHarness $invalid.path ([string]$q3TestRecord.publicKeyFingerprint) } -Pattern $invalid.pattern -Message "Legacy publisher accepted $($invalid.name)."
        Assert-ThrowsLike -Action { & $cdProducerHarness $invalid.path ([string]$q3TestRecord.publicKeyFingerprint) $RepoRoot } -Pattern $invalid.pattern -Message "Signed-CD producer accepted $($invalid.name)."
        Assert-ThrowsLike -Action { & $nasPublisherHarness $invalid.path ([string]$q3TestRecord.publicKeyFingerprint) $nasPublisherTestRepo } -Pattern $invalid.pattern -Message "NAS publisher accepted $($invalid.name)."
    }

    Write-Host "Test deterministic IT-only supervised prestage kit artifact"
    $prestageKitBuilder = Join-Path $RepoRoot 'scripts\New-RevAgentBootstrapPrestageKit.ps1'
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory (Join-Path $tempRoot 'prestage-kit-production-pin-rejection') `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot | Out-Null
    } -Pattern 'requires revagent-prod-rsa-2026q3|pinned RS256 identity' -Message 'Production prestage kit accepted a test signing-key identity.'

    $prestageKitRootA = Join-Path $tempRoot 'prestage-kit-a'
    $prestageKitRootB = Join-Path $tempRoot 'prestage-kit-b'
    $prestageKitPoisonRoot = Join-Path $tempRoot 'prestage-kit-poison-modules'
    $prestageKitPoisonModule = Join-Path $prestageKitPoisonRoot 'Microsoft.PowerShell.Utility'
    $prestageKitPoisonMarker = Join-Path $tempRoot 'prestage-kit-poison-loaded.txt'
    New-Item -ItemType Directory -Path $prestageKitPoisonModule | Out-Null
    $prestageKitPoisonMarkerLiteral = $prestageKitPoisonMarker.Replace("'", "''")
    [IO.File]::WriteAllText((Join-Path $prestageKitPoisonModule 'Microsoft.PowerShell.Utility.psm1'), "[IO.File]::WriteAllText('$prestageKitPoisonMarkerLiteral','loaded'); function Get-FileHash { throw 'poisoned' }", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $prestageKitPoisonModule 'Microsoft.PowerShell.Utility.psd1'), "@{ RootModule='Microsoft.PowerShell.Utility.psm1'; ModuleVersion='99.0.0'; FunctionsToExport=@('Get-FileHash') }", [Text.UTF8Encoding]::new($false))
    $prestageKitOriginalModulePath = $env:PSModulePath
    try {
        $env:PSModulePath = $prestageKitPoisonRoot + [IO.Path]::PathSeparator + $prestageKitOriginalModulePath
        $prestageKitA = & $prestageKitBuilder `
            -OutputDirectory $prestageKitRootA `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys
        $env:PSModulePath = $prestageKitPoisonRoot + [IO.Path]::PathSeparator + $prestageKitOriginalModulePath
        $prestageKitB = & $prestageKitBuilder `
            -OutputDirectory $prestageKitRootB `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys
    }
    finally { $env:PSModulePath = $prestageKitOriginalModulePath }
    Assert-True (-not (Test-Path -LiteralPath $prestageKitPoisonMarker)) 'Supervised prestage kit builder loaded a user-controlled module from inherited PSModulePath.'
    Assert-True ([bool]$prestageKitA.success -and [bool]$prestageKitB.success -and [int]$prestageKitA.entryCount -eq 5 -and [int]$prestageKitB.entryCount -eq 5) 'Supervised prestage kit producer did not emit the exact five-file contract.'
    Assert-Equal ([string]$prestageKitA.sha256) ([string]$prestageKitB.sha256) 'Supervised prestage kit ZIP is not deterministic for identical source bytes.'
    Assert-True ((Get-Content -Raw -LiteralPath $prestageKitA.checksumPath) -match ('(?i)^' + [regex]::Escape([string]$prestageKitA.sha256) + ' \*revAgent-supervised-prestage-kit\.zip')) 'Supervised prestage kit checksum sidecar does not bind the exact ZIP name and SHA-256.'

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $prestageKitArchive = [IO.Compression.ZipFile]::OpenRead([string]$prestageKitA.zipPath)
    try {
        $prestageKitNames = @($prestageKitArchive.Entries | ForEach-Object { $_.FullName } | Sort-Object)
        $expectedPrestageKitNames = @(
            'IT-Prestage-revAgent.cmd',
            'config/release-trusted-keys.json',
            'installer/lib/RevAgent.DistributionIntegrity.psm1',
            'scripts/Invoke-RevAgentSupervisedPrestage.ps1',
            'scripts/New-RevAgentBootstrapPrestageEvidence.ps1'
        ) | Sort-Object
        Assert-True ($prestageKitNames.Count -eq 5 -and @((Compare-Object $expectedPrestageKitNames $prestageKitNames -SyncWindow 0)).Count -eq 0) 'Supervised prestage kit ZIP contains files outside its exact public allowlist.'
        $prestageKitEntryBytes = @{}
        foreach ($entryName in $expectedPrestageKitNames) {
            $entry = @($prestageKitArchive.Entries | Where-Object { [string]::Equals($_.FullName, $entryName, [StringComparison]::Ordinal) })
            Assert-Equal $entry.Count 1 "Supervised prestage kit ZIP entry multiplicity drifted for $entryName."
            $entryStream = $entry[0].Open()
            $memory = [IO.MemoryStream]::new()
            try { $entryStream.CopyTo($memory); $prestageKitEntryBytes[$entryName] = $memory.ToArray() }
            finally { $memory.Dispose(); $entryStream.Dispose() }
        }
        $sealedWrapperText = ([Text.UTF8Encoding]::new($false, $true)).GetString([byte[]]$prestageKitEntryBytes['IT-Prestage-revAgent.cmd'])
        Assert-True ($sealedWrapperText -notmatch '__REVAGENT_[A-Z0-9_]+__') 'Supervised prestage kit ZIP contains an unsealed CMD placeholder.'
        $sealedPinMap = [ordered]@{
            REVAGENT_PRESTAGE_DRIVER_SHA256 = 'scripts/Invoke-RevAgentSupervisedPrestage.ps1'
            REVAGENT_PRESTAGE_EVIDENCE_SHA256 = 'scripts/New-RevAgentBootstrapPrestageEvidence.ps1'
            REVAGENT_PRESTAGE_INTEGRITY_SHA256 = 'installer/lib/RevAgent.DistributionIntegrity.psm1'
            REVAGENT_PRESTAGE_TRUSTED_KEYS_SHA256 = 'config/release-trusted-keys.json'
        }
        foreach ($sealedPin in $sealedPinMap.GetEnumerator()) {
            $expectedPin = Get-Sha256ForBytes ([byte[]]$prestageKitEntryBytes[[string]$sealedPin.Value])
            Assert-True ($sealedWrapperText -match ('(?m)^set "{0}={1}"\r?$' -f [regex]::Escape([string]$sealedPin.Key), [regex]::Escape($expectedPin))) "Supervised prestage wrapper does not pin exact ZIP bytes for $($sealedPin.Value)."
        }
        $originalTrustedKeyBytes = [IO.File]::ReadAllBytes($trustedKeysPath)
        $packagedTrustedKeyBytes = [byte[]]$prestageKitEntryBytes['config/release-trusted-keys.json']
        Assert-True ($originalTrustedKeyBytes.Length -eq $packagedTrustedKeyBytes.Length -and
            [string]::Equals((Get-Sha256ForBytes $originalTrustedKeyBytes), (Get-Sha256ForBytes $packagedTrustedKeyBytes), [StringComparison]::Ordinal)) 'Supervised prestage kit must preserve the exact validated trusted-key JSON bytes.'
    }
    finally { $prestageKitArchive.Dispose() }

    $privateTrustedKeysPath = Join-Path $secretRoot 'release-trusted-keys-private-material.json'
    $privateKeyXml = $rsa.ToXmlString($true)
    @{
        trustedKeys = @{
            $keyId = [ordered]@{
                publicKeyXml = $privateKeyXml
                publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $privateKeyXml
                algorithm = 'RS256'
            }
        }
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $privateTrustedKeysPath -Encoding UTF8
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory (Join-Path $tempRoot 'prestage-kit-private-material-rejection') `
            -TrustedKeysPath $privateTrustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys | Out-Null
    } -Pattern 'private or unexpected RSA parameters|forbidden private/secret material|forbidden (?:raw JSON contains )?private RSA XML material|forbidden decoded private RSA XML material' -Message 'Supervised prestage kit accepted private RSA material disguised as a trusted-key document.'

    $extraTopLevelTrustedKeysPath = Join-Path $secretRoot 'release-trusted-keys-extra-top-level.json'
    [ordered]@{
        trustedKeys = $trustedKeys.trustedKeys
        metadata = 'not part of the public schema'
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $extraTopLevelTrustedKeysPath -Encoding UTF8
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory (Join-Path $tempRoot 'prestage-kit-extra-top-level-rejection') `
            -TrustedKeysPath $extraTopLevelTrustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys | Out-Null
    } -Pattern 'properties must be trustedKeys alone|exact public metadata allowlist' -Message 'Supervised prestage kit accepted a trusted-key top-level property outside the exact allowlist.'

    $extraRecordTrustedKeysPath = Join-Path $secretRoot 'release-trusted-keys-extra-record-property.json'
    [ordered]@{
        trustedKeys = [ordered]@{
            $keyId = [ordered]@{
                publicKeyXml = $publicKeyXml
                publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
                algorithm = 'RS256'
                comment = 'not part of the public schema'
            }
        }
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $extraRecordTrustedKeysPath -Encoding UTF8
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory (Join-Path $tempRoot 'prestage-kit-extra-record-rejection') `
            -TrustedKeysPath $extraRecordTrustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys | Out-Null
    } -Pattern 'entry properties must match the public allowlist' -Message 'Supervised prestage kit accepted a trusted-key record property outside the exact allowlist.'

    foreach ($privateJwkField in @('d', 'p', 'q', 'dp', 'dq', 'qi')) {
        $privateJwkTrustedKeysPath = Join-Path $secretRoot ("release-trusted-keys-private-jwk-$privateJwkField.json")
        $privateJwkRecord = [ordered]@{
            publicKeyXml = $publicKeyXml
            publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
            algorithm = 'RS256'
        }
        $privateJwkRecord[$privateJwkField] = 'private-jwk-material'
        [ordered]@{
            trustedKeys = [ordered]@{ $keyId = $privateJwkRecord }
        } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $privateJwkTrustedKeysPath -Encoding UTF8
        Assert-ThrowsLike -Action {
            & $prestageKitBuilder `
                -OutputDirectory (Join-Path $tempRoot ("prestage-kit-private-jwk-$privateJwkField-rejection")) `
                -TrustedKeysPath $privateJwkTrustedKeysPath `
                -RepoRoot $RepoRoot `
                -AllowTestTrustedKeys | Out-Null
        } -Pattern 'raw JSON contains a forbidden private JWK' -Message "Supervised prestage kit accepted private JWK field '$privateJwkField' in raw trusted-key JSON."
    }

    $validTrustedKeyMapJson = $trustedKeys.trustedKeys | ConvertTo-Json -Depth 8 -Compress
    $duplicateTrustedKeysPath = Join-Path $secretRoot 'release-trusted-keys-duplicate-escaped-decoy.json'
    $duplicateTrustedKeysJson = '{"trustedKeys":{"decoy":{"\u0064":"private-decoy"}},"trustedKeys":' + $validTrustedKeyMapJson + '}'
    [IO.File]::WriteAllText($duplicateTrustedKeysPath, $duplicateTrustedKeysJson, [Text.UTF8Encoding]::new($false))
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory (Join-Path $tempRoot 'prestage-kit-duplicate-trusted-keys-rejection') `
            -TrustedKeysPath $duplicateTrustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys | Out-Null
    } -Pattern 'duplicate decoded property name.*trustedKeys' -Message 'Supervised prestage kit accepted duplicate trustedKeys after PS5 JSON normalization discarded the escaped private decoy.'

    $publicKeyJson = $publicKeyXml | ConvertTo-Json -Compress
    $publicKeyFingerprintJson = (Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml) | ConvertTo-Json -Compress
    $duplicateEscapedRecordPath = Join-Path $secretRoot 'release-trusted-keys-duplicate-escaped-record-name.json'
    $duplicateEscapedRecordJson = '{"trustedKeys":{"' + $keyId + '":{"algorithm":"RS256","\u0061lgorithm":"RS256","publicKeyXml":' + $publicKeyJson + ',"publicKeyFingerprint":' + $publicKeyFingerprintJson + '}}}'
    [IO.File]::WriteAllText($duplicateEscapedRecordPath, $duplicateEscapedRecordJson, [Text.UTF8Encoding]::new($false))
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory (Join-Path $tempRoot 'prestage-kit-duplicate-escaped-record-rejection') `
            -TrustedKeysPath $duplicateEscapedRecordPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys | Out-Null
    } -Pattern 'duplicate decoded property name.*algorithm' -Message 'Supervised prestage kit accepted duplicate key-record names after JSON escape decoding.'

    $escapedPrivateJwkNames = [ordered]@{
        d = '\u0064'
        p = '\u0070'
        q = '\u0071'
        dp = '\u0064\u0070'
        dq = '\u0064\u0071'
        qi = '\u0071\u0069'
    }
    foreach ($escapedPrivateJwk in $escapedPrivateJwkNames.GetEnumerator()) {
        $escapedPrivateJwkPath = Join-Path $secretRoot ("release-trusted-keys-escaped-private-jwk-$($escapedPrivateJwk.Key).json")
        $escapedPrivateJwkJson = '{"trustedKeys":{"' + $keyId + '":{"publicKeyXml":' + $publicKeyJson + ',"publicKeyFingerprint":' + $publicKeyFingerprintJson + ',"algorithm":"RS256","' + [string]$escapedPrivateJwk.Value + '":"private-jwk-material"}}}'
        [IO.File]::WriteAllText($escapedPrivateJwkPath, $escapedPrivateJwkJson, [Text.UTF8Encoding]::new($false))
        Assert-ThrowsLike -Action {
            & $prestageKitBuilder `
                -OutputDirectory (Join-Path $tempRoot ("prestage-kit-escaped-private-jwk-$($escapedPrivateJwk.Key)-rejection")) `
                -TrustedKeysPath $escapedPrivateJwkPath `
                -RepoRoot $RepoRoot `
                -AllowTestTrustedKeys | Out-Null
        } -Pattern ('forbidden decoded private JWK.*' + [regex]::Escape([string]$escapedPrivateJwk.Key)) -Message "Supervised prestage kit accepted escaped private JWK field '$($escapedPrivateJwk.Key)'."
    }

    $escapedPemTrustedKeysPath = Join-Path $secretRoot 'release-trusted-keys-escaped-private-pem.json'
    $escapedPemValue = '\u002d\u002d\u002d\u002d\u002dBEGIN PRIVATE KEY\u002d\u002d\u002d\u002d\u002dAAECAwQ='
    $escapedPemJson = '{"trustedKeys":{"' + $keyId + '":{"publicKeyXml":' + $publicKeyJson + ',"publicKeyFingerprint":' + $publicKeyFingerprintJson + ',"algorithm":"RS256","comment":"' + $escapedPemValue + '"}}}'
    [IO.File]::WriteAllText($escapedPemTrustedKeysPath, $escapedPemJson, [Text.UTF8Encoding]::new($false))
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory (Join-Path $tempRoot 'prestage-kit-escaped-private-pem-rejection') `
            -TrustedKeysPath $escapedPemTrustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys | Out-Null
    } -Pattern 'forbidden decoded PEM private-key material' -Message 'Supervised prestage kit accepted escaped PEM private-key material under an innocent property.'

    $escapedPrivateXmlPath = Join-Path $secretRoot 'release-trusted-keys-escaped-private-rsa-xml.json'
    $escapedPrivateXmlJson = '{"trustedKeys":{"' + $keyId + '":{"publicKeyXml":"\u003cRSAKeyValue\u003e\u003cD\u003eAAECAwQ=\u003c/D\u003e\u003c/RSAKeyValue\u003e","publicKeyFingerprint":' + $publicKeyFingerprintJson + ',"algorithm":"RS256"}}}'
    [IO.File]::WriteAllText($escapedPrivateXmlPath, $escapedPrivateXmlJson, [Text.UTF8Encoding]::new($false))
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory (Join-Path $tempRoot 'prestage-kit-escaped-private-rsa-xml-rejection') `
            -TrustedKeysPath $escapedPrivateXmlPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys | Out-Null
    } -Pattern 'forbidden decoded private RSA XML material' -Message 'Supervised prestage kit accepted escaped private RSA XML material.'

    $privatePemTrustedKeysPath = Join-Path $secretRoot 'release-trusted-keys-private-pem.json'
    [ordered]@{
        trustedKeys = [ordered]@{
            $keyId = [ordered]@{
                publicKeyXml = '-----BEGIN PRIVATE KEY-----AAECAwQ=-----END PRIVATE KEY-----'
                publicKeyFingerprint = ('A' * 64)
                algorithm = 'RS256'
            }
        }
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $privatePemTrustedKeysPath -Encoding UTF8
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory (Join-Path $tempRoot 'prestage-kit-private-pem-rejection') `
            -TrustedKeysPath $privatePemTrustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys | Out-Null
    } -Pattern 'raw JSON contains forbidden PEM private-key material' -Message 'Supervised prestage kit accepted PEM private-key material in an allowed JSON property.'

    $innocentPemTrustedKeysPath = Join-Path $secretRoot 'release-trusted-keys-innocent-field-private-pem.json'
    [ordered]@{
        trustedKeys = [ordered]@{
            $keyId = [ordered]@{
                publicKeyXml = $publicKeyXml
                publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
                algorithm = 'RS256'
                comment = '-----BEGIN RSA PRIVATE KEY-----AAECAwQ=-----END RSA PRIVATE KEY-----'
            }
        }
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $innocentPemTrustedKeysPath -Encoding UTF8
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory (Join-Path $tempRoot 'prestage-kit-innocent-field-private-pem-rejection') `
            -TrustedKeysPath $innocentPemTrustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys | Out-Null
    } -Pattern 'raw JSON contains forbidden PEM private-key material' -Message 'Supervised prestage kit accepted PEM private-key material hidden under an innocent extra property.'

    $hardlinkedTrustedKeysPath = Join-Path $secretRoot 'release-trusted-keys-hardlinked.json'
    Copy-Item -LiteralPath $trustedKeysPath -Destination $hardlinkedTrustedKeysPath
    New-Item -ItemType HardLink -Path (Join-Path $secretRoot 'release-trusted-keys-hardlinked-alias.json') -Target $hardlinkedTrustedKeysPath | Out-Null
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory (Join-Path $tempRoot 'prestage-kit-hardlink-rejection') `
            -TrustedKeysPath $hardlinkedTrustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys | Out-Null
    } -Pattern 'exactly one hardlink reference|filesystem link/reparse component' -Message 'Supervised prestage kit accepted a multiply linked trusted-key source.'

    $junctionOutputTarget = Join-Path $tempRoot 'prestage-kit-junction-target'
    $junctionOutputParent = Join-Path $tempRoot 'prestage-kit-junction-parent'
    New-Item -ItemType Directory -Path $junctionOutputTarget | Out-Null
    New-Item -ItemType Junction -Path $junctionOutputParent -Target $junctionOutputTarget | Out-Null
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory (Join-Path $junctionOutputParent 'kit') `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys | Out-Null
    } -Pattern 'filesystem link/reparse component' -Message 'Supervised prestage kit accepted a reparse-point output ancestor.'

    $preexistingPrestageKitRoot = Join-Path $tempRoot 'preexisting-prestage-kit-root'
    New-Item -ItemType Directory -Path $preexistingPrestageKitRoot | Out-Null
    Assert-ThrowsLike -Action {
        & $prestageKitBuilder `
            -OutputDirectory $preexistingPrestageKitRoot `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestTrustedKeys | Out-Null
    } -Pattern 'already exists|refusing replacement' -Message 'Supervised prestage kit reused a preexisting output root.'

    $nodeMsiPath = Join-Path $tempRoot 'node-v24.14.1-x64.msi'
    $nodeMsiBytes = [Text.Encoding]::UTF8.GetBytes('revAgent signed-CD test-only Node.js MSI fixture; never use outside disposable TEMP roots.')
    [IO.File]::WriteAllBytes($nodeMsiPath, $nodeMsiBytes)
    $nodeMsiSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeMsiPath).Hash
    $nodeMsiSizeBytes = [long](Get-Item -LiteralPath $nodeMsiPath).Length
    $nodeMsiRelativePath = 'external\node-v24.14.1-x64.msi'
    $preexistingReleaseRoot = Join-Path $tempRoot 'preexisting-release-root'
    New-Item -ItemType Directory -Path $preexistingReleaseRoot -Force | Out-Null
    Assert-ThrowsLike -Action {
        & (Join-Path $RepoRoot "scripts\invoke-signed-source-free-cd.ps1") `
            -ReleaseRoot $preexistingReleaseRoot `
            -TrustedKeysPath $trustedKeysPath `
            -NodeMsiPath $nodeMsiPath `
            -SigningPrivateKeyPath $privateKeyPath `
            -SigningKeyId $keyId `
            -Version '2026.06.23.preexisting-cd-test' `
            -ReleaseSequence 2999 `
            -SkipEngineeringGates `
            -AllowDirty `
            -AllowNonMain `
            -Force `
            -RepoRoot $RepoRoot | Out-Null
    } -Pattern 'staging leaf already exists|refusing cleanup or reuse' -Message 'CD producer reused a preexisting staging root.'

    $buildResult = & (Join-Path $RepoRoot "scripts\invoke-signed-source-free-cd.ps1") `
        -ReleaseRoot $releaseRoot `
        -TrustedKeysPath $trustedKeysPath `
        -NodeMsiPath $nodeMsiPath `
        -SigningPrivateKeyPath $privateKeyPath `
        -SigningKeyId $keyId `
        -Version $version `
        -ReleaseSequence $releaseSequence `
        -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence `
        -SkipEngineeringGates `
        -AllowDirty `
        -AllowNonMain `
        -Force `
        -RepoRoot $RepoRoot
    Assert-True ([bool]$buildResult.success) "CD producer should return success."
    Assert-Equal ([string]$buildResult.version) $version "CD producer should report the produced version."

    $unsignedBuildFailed = $false
    try {
        & (Join-Path $RepoRoot "scripts\invoke-signed-source-free-cd.ps1") `
            -ReleaseRoot (Join-Path $tempRoot "unsigned-release-root") `
            -TrustedKeysPath $trustedKeysPath `
            -NodeMsiPath $nodeMsiPath `
            -SigningKeyId $keyId `
            -Version "2026.06.23.unsigned-cd-test" `
            -SkipEngineeringGates `
            -AllowDirty `
            -AllowNonMain `
            -Force `
            -RepoRoot $RepoRoot | Out-Null
    }
    catch {
        $unsignedBuildFailed = $_.Exception.Message -match "SigningPrivateKeyPath is required"
    }
    Assert-True $unsignedBuildFailed "CD producer must behaviorally reject unsigned builds instead of relying on source-text grep."

    $sourceChannelPath = Join-Path $releaseRoot "channels\stable.json"
    $sourceChannelSignaturePath = Join-Path $releaseRoot "channels\stable.sig.json"
    $sourceManifestPath = Join-Path $releaseRoot "releases\$version\manifest.json"
    $sourceChannel = Get-Content -Raw -LiteralPath $sourceChannelPath | ConvertFrom-Json
    $sourceManifest = Get-Content -Raw -LiteralPath $sourceManifestPath | ConvertFrom-Json
    Assert-Equal ([string]$sourceChannel.app) "revAgent" "CD producer default channel app identity should be revAgent."
    Assert-Equal ([string]$sourceManifest.app) "revAgent" "CD producer default release manifest app identity should be revAgent."
    Assert-True ([string]$sourceChannel.packagePath -match "revAgent-") "CD producer default package path should use the revAgent base name."
    Assert-True (-not [System.IO.Path]::IsPathRooted([string]$sourceChannel.packagePath)) "CD channel packagePath must be relative."
    Assert-True (-not [System.IO.Path]::IsPathRooted([string]$sourceChannel.manifestPath)) "CD channel manifestPath must be relative."
    Assert-Equal ([string]$sourceChannel.packagePath) ([string]$sourceManifest.package.path) "CD channel and manifest package paths must match."
    Assert-Equal ([int]$sourceManifest.externalDependencies.nodeMsi.schemaVersion) 1 'Signed Node.js MSI metadata schema must be version 1.'
    Assert-Equal ([string]$sourceManifest.externalDependencies.nodeMsi.relativePath) $nodeMsiRelativePath 'Signed Node.js MSI metadata must use the exact release-owned sidecar path.'
    Assert-Equal ([string]$sourceManifest.externalDependencies.nodeMsi.sha256) $nodeMsiSha256 'Signed Node.js MSI metadata hash must bind the test fixture.'
    Assert-Equal ([long]$sourceManifest.externalDependencies.nodeMsi.sizeBytes) $nodeMsiSizeBytes 'Signed Node.js MSI metadata size must bind the test fixture.'
    Assert-Equal ([string]$sourceManifest.externalDependencies.nodeMsi.signerSubject) 'TEST-ONLY' 'Test-signed Node.js MSI metadata must expose its test-only signer identity.'
    Assert-Equal ([string]$sourceManifest.externalDependencies.nodeMsi.authenticodeStatus) 'TestBypass' 'Test-signed Node.js MSI metadata must expose its test-only Authenticode bypass.'
    $sourceNodeMsiSidecar = Join-Path (Split-Path -Parent $sourceManifestPath) $nodeMsiRelativePath
    Assert-True (Test-Path -LiteralPath $sourceNodeMsiSidecar -PathType Leaf) 'Signed release must contain its release-owned Node.js MSI sidecar.'
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceNodeMsiSidecar).Hash $nodeMsiSha256 'Release-owned Node.js MSI sidecar hash must match signed metadata.'
    Assert-Equal ([long](Get-Item -LiteralPath $sourceNodeMsiSidecar).Length) $nodeMsiSizeBytes 'Release-owned Node.js MSI sidecar size must match signed metadata.'
    $toolsTrustedKeysPath = Join-Path $releaseRoot "tools\config\release-trusted-keys.json"
    Assert-True (Test-Path -LiteralPath $toolsTrustedKeysPath -PathType Leaf) "CD release root should carry public trusted keys in tools config."
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($toolsTrustedKeysPath), [byte[]][IO.File]::ReadAllBytes($trustedKeysPath))) 'CD tools config did not preserve exact trusted-key bytes.'
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\dashboard\installer\install-dashboard-addon.ps1") -PathType Leaf) "CD release root should carry dashboard admin add-on tools."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\usage-intelligence\installer\install-usage-intelligence-addon.ps1") -PathType Leaf) "CD release root should carry usage-intelligence admin add-on tools."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\usage-intelligence\skills\revagent-usage-analyst\SKILL.md") -PathType Leaf) "CD release root should carry the usage-intelligence analyst skill."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\publish-desktop-launcher-evidence.ps1") -PathType Leaf) "CD release root should carry the desktop launcher evidence helper."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\collect-rollout-evidence.ps1") -PathType Leaf) "CD release root should carry the SSH rollout evidence collector."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\invoke-live-smoke-over-ssh.ps1") -PathType Leaf) "CD release root should carry the SSH live smoke runner."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\test-commandset-live.ps1") -PathType Leaf) "CD release root should carry the live smoke evidence helper."
    Assert-Equal @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot "tools") -Recurse -File -Filter "*.cmd").Count 0 "CD production tools tree must not publish unsigned CMD first-hop aliases."

    $sourceZipPath = Join-Path $releaseRoot "releases\$version\revAgent-$version.zip"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $sourceArchive = [IO.Compression.ZipFile]::OpenRead($sourceZipPath)
    try {
        foreach ($entryName in @(
                "installer/nas/install-revagent-local-bootstrap.ps1",
                "installer/nas/New-RevAgentBootstrapPrestageEvidence.ps1",
                "installer/nas/bootstrap-prestage-evidence.schema.json",
                "installer/nas/bootstrap-prestage-evidence.example.json",
                "installer/nas/Start-revAgent-Update.cmd",
                "installer/nas/Start-revAgent-Update.ps1",
                "installer/nas/Invoke-RevAgent-BootstrapTrustBroker.ps1",
                "installer/lib/RevAgent.LocalBootstrap.psm1",
                "installer/lib/RevAgent.BootstrapTrust.psm1",
                "config/release-trusted-keys.json",
                "installer/lib/RevAgent.Permissions.psm1"
            )) {
            Assert-Equal @($sourceArchive.Entries | Where-Object { [string]::Equals($_.FullName.Replace("\", "/"), $entryName, [StringComparison]::OrdinalIgnoreCase) }).Count 1 "Signed user pack entry '$entryName' must exist exactly once."
        }
        $packageTrustedKeyEntries = @($sourceArchive.Entries | Where-Object { [string]::Equals($_.FullName.Replace("\", "/"), 'config/release-trusted-keys.json', [StringComparison]::OrdinalIgnoreCase) })
        $packageTrustedKeyStream = $packageTrustedKeyEntries[0].Open()
        $packageTrustedKeyMemory = [IO.MemoryStream]::new()
        try { $packageTrustedKeyStream.CopyTo($packageTrustedKeyMemory) }
        finally { $packageTrustedKeyStream.Dispose() }
        Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]]$packageTrustedKeyMemory.ToArray(), [byte[]][IO.File]::ReadAllBytes($trustedKeysPath))) 'Signed package did not embed the exact externally supplied trusted-key bytes.'
        $packageTrustedKeyMemory.Dispose()
        Assert-Equal @($sourceArchive.Entries | Where-Object { $_.FullName -match '(?i)\.msi$' }).Count 0 'The external Node.js MSI must not be embedded in the source-free ZIP.'
    }
    finally { $sourceArchive.Dispose() }

    $sourceNodeMsiBytes = [IO.File]::ReadAllBytes($sourceNodeMsiSidecar)
    try {
        Remove-Item -LiteralPath $sourceNodeMsiSidecar -Force
        $missingNodeMsiReadiness = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $releaseRoot `
            -ChannelManifestPath $sourceChannelPath `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestSigningIdentity `
            -ReportOnly
        Assert-True (-not [bool]$missingNodeMsiReadiness.success) 'Signed readiness accepted a missing release-owned Node.js MSI sidecar.'
        Assert-True (@($missingNodeMsiReadiness.checks | Where-Object { $_.name -eq 'node_msi_file_present' -and -not [bool]$_.success }).Count -gt 0) 'Missing Node.js MSI readiness did not report node_msi_file_present.'
    }
    finally { [IO.File]::WriteAllBytes($sourceNodeMsiSidecar, $sourceNodeMsiBytes) }

    $tamperedNodeMsiBytes = New-Object byte[] ($sourceNodeMsiBytes.Length + 1)
    [Array]::Copy($sourceNodeMsiBytes, $tamperedNodeMsiBytes, $sourceNodeMsiBytes.Length)
    $tamperedNodeMsiBytes[$tamperedNodeMsiBytes.Length - 1] = 0x7F
    try {
        [IO.File]::WriteAllBytes($sourceNodeMsiSidecar, $tamperedNodeMsiBytes)
        $tamperedNodeMsiReadiness = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $releaseRoot `
            -ChannelManifestPath $sourceChannelPath `
            -TrustedKeysPath $trustedKeysPath `
            -RepoRoot $RepoRoot `
            -AllowTestSigningIdentity `
            -ReportOnly
        Assert-True (-not [bool]$tamperedNodeMsiReadiness.success) 'Signed readiness accepted a tampered release-owned Node.js MSI sidecar.'
        Assert-True (@($tamperedNodeMsiReadiness.checks | Where-Object { $_.name -in @('node_msi_size_matches_signed_metadata', 'node_msi_sha256_matches_signed_metadata') -and -not [bool]$_.success }).Count -gt 0) 'Tampered Node.js MSI readiness did not report a signed size/hash mismatch.'
    }
    finally { [IO.File]::WriteAllBytes($sourceNodeMsiSidecar, $sourceNodeMsiBytes) }
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceNodeMsiSidecar).Hash $nodeMsiSha256 'Node.js MSI sidecar fixture was not restored after fail-closed readiness tests.'

    foreach ($componentKey in @("localBootstrapInstaller", "bootstrapPrestageEvidenceTool", "bootstrapPrestageEvidenceSchema", "bootstrapPrestageEvidenceExample", "localBootstrapLauncher", "localBootstrap", "installerLibLocalBootstrap", "installerLibBootstrapTrust", "bootstrapTrustBroker", "releaseTrustedKeys", "installerLibPermissions")) {
        Assert-True ($null -ne $sourceManifest.components.$componentKey -and -not [string]::IsNullOrWhiteSpace([string]$sourceManifest.components.$componentKey.sha256)) "Signed manifest is missing bootstrap component '$componentKey'."
    }
    $evidencePath = Join-Path $tempRoot "bootstrap-prestage-evidence.json"
    $evidenceResult = & (Join-Path $RepoRoot "scripts\New-RevAgentBootstrapPrestageEvidence.ps1") `
        -ReleaseRoot $releaseRoot `
        -TrustedKeysPath $trustedKeysPath `
        -OutputPath $evidencePath `
        -RepoRoot $RepoRoot `
        -AllowTestRoot
    Assert-True ([bool]$evidenceResult.success -and [bool]$evidenceResult.signatureVerified) "Production evidence producer did not verify the signed release fixture."
    $evidenceDocument = Get-Content -Raw -LiteralPath $evidencePath | ConvertFrom-Json
    Assert-Equal ([string]$evidenceDocument.localBootstrapInstallerScript) ([string]$sourceManifest.components.localBootstrapInstaller.sha256) "Evidence producer did not bind its own signed prestage installer."
    Assert-Equal ([string]$evidenceDocument.sources.launcher) ([string]$sourceManifest.components.localBootstrapLauncher.sha256) "Evidence producer did not bind the protected local launcher."
    Assert-Equal ([string]$evidenceDocument.sources.permissions) ([string]$sourceManifest.components.installerLibPermissions.sha256) "Evidence producer did not bind the protected permissions sibling."
    Assert-Equal ([string]$evidenceDocument.sources.bootstrapTrust) ([string]$sourceManifest.components.installerLibBootstrapTrust.sha256) "Evidence producer did not bind the bootstrap trust module."
    Assert-Equal ([string]$evidenceDocument.sources.bootstrapTrustBroker) ([string]$sourceManifest.components.bootstrapTrustBroker.sha256) "Evidence producer did not bind the bootstrap trust broker."
    Assert-Equal ([string]$evidenceDocument.sources.trustedKeys) ([string]$sourceManifest.components.releaseTrustedKeys.sha256) "Evidence producer did not bind packaged trusted-key bytes."

    $machineEvidencePath = Join-Path $tempRoot 'bootstrap-prestage-evidence-machine-broker.json'
    $machineEvidenceResult = & (Join-Path $RepoRoot 'scripts\New-RevAgentBootstrapPrestageEvidence.ps1') `
        -ReleaseRoot $releaseRoot `
        -TrustedKeysPath $trustedKeysPath `
        -OutputPath $machineEvidencePath `
        -RepoRoot $RepoRoot `
        -AllowTestRoot `
        -MachineTrustBroker `
        -TestAdministratorState elevated `
        -TestProducerSid 'S-1-5-18'
    $machineEvidence = Get-Content -Raw -LiteralPath $machineEvidencePath | ConvertFrom-Json
    Assert-True ([bool]$machineEvidenceResult.success -and [string]$machineEvidence.producerMode -eq 'machine-trust-broker' -and -not [bool]$machineEvidence.supervisedAdminPrestage -and [string]$machineEvidence.generatedBySid -eq 'S-1-5-18') 'Machine trust broker evidence did not preserve its LocalSystem-only producer contract.'

    $reformattedTrustedKeysPath = Join-Path $secretRoot 'release-trusted-keys-reformatted.json'
    [IO.File]::WriteAllText($reformattedTrustedKeysPath, ($trustedKeys | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
    Assert-ThrowsLike -Action {
        & (Join-Path $RepoRoot 'scripts\New-RevAgentBootstrapPrestageEvidence.ps1') `
            -ReleaseRoot $releaseRoot `
            -TrustedKeysPath $reformattedTrustedKeysPath `
            -OutputPath (Join-Path $tempRoot 'bootstrap-prestage-evidence-key-byte-drift.json') `
            -RepoRoot $RepoRoot `
            -AllowTestRoot | Out-Null
    } -Pattern 'trusted-key bytes differ' -Message 'Evidence producer accepted a semantically equivalent external trusted-key file whose bytes did not match the signed package.'

    Write-Host "Test bootstrap evidence verifier executes the exact pinned bytes after pathname swap"
    $evidenceSwapRepo = Join-Path $tempRoot "bootstrap-evidence-verifier-swap-repo"
    $evidenceSwapModuleDirectory = Join-Path $evidenceSwapRepo "installer\lib"
    New-Item -ItemType Directory -Path $evidenceSwapModuleDirectory -Force | Out-Null
    $evidenceSwapModulePath = Join-Path $evidenceSwapModuleDirectory "RevAgent.DistributionIntegrity.psm1"
    Copy-Item -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1") -Destination $evidenceSwapModulePath
    $evidenceSwapMarker = Join-Path $tempRoot "bootstrap-evidence-malicious-module-executed.txt"
    $escapedEvidenceSwapMarker = $evidenceSwapMarker.Replace("'", "''")
    $maliciousEvidenceModule = @"
Set-Content -LiteralPath '$escapedEvidenceSwapMarker' -Value 'executed'
function Test-RevAgentReleaseDistributionIntegrity { [pscustomobject]@{ success = `$true; releaseSequence = 1; highestAcceptedReleaseSequence = 1; minimumAcceptedReleaseSequence = 1 } }
Export-ModuleMember -Function Test-RevAgentReleaseDistributionIntegrity
"@
    $evidenceSwapHook = {
        param($verifiedModulePath)
        Move-Item -LiteralPath $verifiedModulePath -Destination ($verifiedModulePath + ".verified") -Force
        [IO.File]::WriteAllText($verifiedModulePath, $maliciousEvidenceModule, [Text.UTF8Encoding]::new($false))
    }.GetNewClosure()
    $evidenceSwapPath = Join-Path $tempRoot "bootstrap-prestage-evidence-verifier-swap.json"
    $evidenceSwapResult = & (Join-Path $RepoRoot "scripts\New-RevAgentBootstrapPrestageEvidence.ps1") `
        -ReleaseRoot $releaseRoot `
        -TrustedKeysPath $trustedKeysPath `
        -OutputPath $evidenceSwapPath `
        -RepoRoot $evidenceSwapRepo `
        -AllowTestRoot `
        -IntegrityModuleBytesVerifiedHook $evidenceSwapHook
    Assert-True ([bool]$evidenceSwapResult.success -and [bool]$evidenceSwapResult.signatureVerified) "Evidence producer did not continue from the exact verified module bytes after the path was swapped."
    Assert-True (Test-Path -LiteralPath ($evidenceSwapModulePath + ".verified") -PathType Leaf) "Verifier pathname swap fixture did not run."
    Assert-True (-not (Test-Path -LiteralPath $evidenceSwapMarker)) "Evidence producer executed the replacement verifier from the swapped pathname."

    $sourceChannelBytesBeforeSequenceSwap = [IO.File]::ReadAllBytes($sourceChannelPath)
    $sourceSequenceSwapHook = {
        param($sourceRoot)
        $hookChannelPath = Join-Path $sourceRoot 'channels\stable.json'
        $hookChannel = Get-Content -Raw -LiteralPath $hookChannelPath | ConvertFrom-Json
        $hookChannel.releaseSequence = [long]$hookChannel.releaseSequence + 1
        $hookChannel | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $hookChannelPath -Encoding UTF8
    }
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1") `
                -SourceReleaseRoot $releaseRoot `
                -NasReleaseRoot $nasRoot `
                -TrustedKeysPath $trustedKeysPath `
                -Force `
                -RepoRoot $RepoRoot `
                -AllowTestRoot `
                -TestAfterSourceReadinessHook $sourceSequenceSwapHook | Out-Null
        } -Pattern "source releaseSequence changed after readiness" -Message "NAS publisher did not bind its anti-rollback sequence to the post-readiness source identity."
    }
    finally { [IO.File]::WriteAllBytes($sourceChannelPath, $sourceChannelBytesBeforeSequenceSwap) }
    Write-Host '  source sequence swap rejection: PASS'

    $routeSwapOriginalChannelBytes = [IO.File]::ReadAllBytes($sourceChannelPath)
    $routeSwapOriginalSignatureBytes = [IO.File]::ReadAllBytes($sourceChannelSignaturePath)
    $routeSwapDocument = Get-Content -Raw -LiteralPath $sourceChannelPath | ConvertFrom-Json
    $routeSwapDocument.version = '2026.06.23.route-swap-cd-test'
    $routeSwapBytes = [Text.UTF8Encoding]::new($false).GetBytes(($routeSwapDocument | ConvertTo-Json -Depth 16))
    $routeSwapFirstHook = {
        param($sourceRoot)
        [IO.File]::WriteAllBytes((Join-Path $sourceRoot 'channels\stable.json'), $routeSwapBytes)
    }.GetNewClosure()
    $routeSwapSecondHook = {
        param($sourceRoot, $channelPath, $signaturePath)
        [IO.File]::WriteAllBytes($channelPath, $routeSwapOriginalChannelBytes)
        [IO.File]::WriteAllBytes($signaturePath, $routeSwapOriginalSignatureBytes)
    }.GetNewClosure()
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') `
                -SourceReleaseRoot $releaseRoot `
                -NasReleaseRoot $nasRoot `
                -TrustedKeysPath $trustedKeysPath `
                -Force `
                -RepoRoot $RepoRoot `
                -AllowTestRoot `
                -TestAfterSourceReadinessHook $routeSwapFirstHook `
                -TestAfterSourceRoutingReadHook $routeSwapSecondHook | Out-Null
        } -Pattern 'Locked source routing changed|does not bind the precomputed' -Message 'Publisher accepted a valid A -> transient B routing read -> locked A source double-swap.'
    }
    finally {
        [IO.File]::WriteAllBytes($sourceChannelPath, $routeSwapOriginalChannelBytes)
        [IO.File]::WriteAllBytes($sourceChannelSignaturePath, $routeSwapOriginalSignatureBytes)
    }
    Write-Host '  locked source routing double-swap rejection: PASS'

    $legacyReleaseDir = Join-Path $nasRoot "releases\2026.05.01.legacy"
    New-Item -ItemType Directory -Path $legacyReleaseDir -Force | Out-Null
    "export const legacy = true;" | Set-Content -LiteralPath (Join-Path $legacyReleaseDir "legacy-source.ts") -Encoding UTF8
    $nasRootAclBeforePublish = (Get-Acl -LiteralPath $nasRoot).Sddl

    Assert-ThrowsLike -Action {
        & (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1") `
            -SourceReleaseRoot $releaseRoot `
            -NasReleaseRoot (Join-Path $RepoRoot "not-a-temp-publish-root") `
            -TrustedKeysPath $trustedKeysPath `
            -Force `
            -RepoRoot $RepoRoot `
            -AllowTestRoot | Out-Null
    } -Pattern "AllowTestRoot is limited" -Message "NAS publisher accepted a non-canonical/non-TEMP destination."

    Write-Host '  initial stable publish...'
    $publishResult = & (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1") `
        -SourceReleaseRoot $releaseRoot `
        -NasReleaseRoot $nasRoot `
        -TrustedKeysPath $trustedKeysPath `
        -Force `
        -RepoRoot $RepoRoot `
        -AllowTestRoot `
        -TestUseProductionPublishedSurface
    Assert-True ([bool]$publishResult.success) "NAS publish wrapper should return success."
    Assert-Equal ([string]$publishResult.version) $version "NAS publish wrapper should report the published version."
    Assert-Equal ([string]$publishResult.transportTrust) "signed_local_snapshot" "NAS publish must report the signed local snapshot transport boundary."
    Assert-True ([bool]$publishResult.transportBoundary.writerCapability.ownerSidMatches) "NAS publisher capability probe directory owner did not match the release-root owner SID."
    Assert-True ([bool]$publishResult.transportBoundary.writerCapability.createDeleteCanary.created -and [bool]$publishResult.transportBoundary.writerCapability.createDeleteCanary.deleted -and [bool]$publishResult.transportBoundary.writerCapability.cleaned) "NAS publish must carry cleaned create/delete writer-capability canary evidence."
    Assert-True (-not [bool]$publishResult.transportBoundary.writerCapability.provesIdentity) "NAS writer-capability evidence must not be described as publisher identity proof."
    Assert-True ([bool]$publishResult.transportBoundary.publishLock.mutexAcquired -and [bool]$publishResult.transportBoundary.publishLock.leaseAcquired -and [bool]$publishResult.transportBoundary.publishLock.released) "NAS publish must report acquired and cleanly released publisher locks."
    Assert-Equal ([string]$publishResult.signedIdentity.candidate.channelSha256) ([string]$publishResult.signedIdentity.source.channelSha256) "NAS candidate identity must equal the authenticated source identity."
    Assert-Equal ([string]$publishResult.signedIdentity.final.packageSha256) ([string]$publishResult.signedIdentity.source.packageSha256) "NAS final stable identity must equal the authenticated source identity."
    Assert-True ([bool]$publishResult.transportBoundary.sourceLinkSafety.safe -and [bool]$publishResult.transportBoundary.destinationLinkSafetyAfter.safe) "NAS publish must report fail-closed source/destination link safety evidence."
    Assert-True (-not [bool]$publishResult.releaseAcl.required -and -not [bool]$publishResult.releaseAcl.mutationPerformed) "NAS publish must not require or perform DACL mutation."
    Assert-Equal ([string]$publishResult.aclTelemetry.status) "not_requested_optional" "NAS publish must leave ACL telemetry opt-in by default."
    Assert-Equal (Get-Acl -LiteralPath $nasRoot).Sddl $nasRootAclBeforePublish "NAS publisher changed the release-root DACL even though ACL mutation is optional."
    Assert-True ([bool]$publishResult.stablePublish.exactPublishedSurface) 'AllowTestRoot production-surface mode did not exercise exact-managed stable publication.'
    Assert-True ([bool]$publishResult.stablePublish.publishedSurfaceReadiness.success) 'Publisher did not return successful final published-surface readiness evidence.'
    Assert-Equal ([string]$publishResult.stablePublish.publishedSurfaceReadiness.mode) 'transactional-exact-handles' 'Publisher published-surface evidence must come from the rollback-capable exact-handle transaction.'
    Assert-Equal ([int]$publishResult.stablePublish.publishedSurfaceReadiness.managedFileCount) 13 'Publisher transaction must verify all 13 exact-managed stable surface files.'

    Assert-True (Test-Path -LiteralPath (Join-Path $nasRoot "channels\stable.json") -PathType Leaf) "NAS stable channel should exist after publish."
    Assert-True (Test-Path -LiteralPath (Join-Path $nasRoot "channels\stable.sig.json") -PathType Leaf) "NAS stable channel signature should exist after publish."
    $remainingCandidateArtifacts = @(Get-ChildItem -LiteralPath (Join-Path $nasRoot "channels") -File -Filter "stable.candidate.*.json")
    Assert-Equal $remainingCandidateArtifacts.Count 0 "NAS per-publish candidate channel and signature artifacts should be removed after publish."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $nasRoot ".revagent-publish.lease.json") -PathType Leaf)) "NAS publish lease should be removed after a successful publish."

    $nasStableChannelPath = Join-Path $nasRoot "channels\stable.json"
    $nasStableSignaturePath = Join-Path $nasRoot "channels\stable.sig.json"
    $stableChannelHashBeforeLockTests = (Get-FileHash -Algorithm SHA256 -LiteralPath $nasStableChannelPath).Hash
    $stableSignatureHashBeforeLockTests = (Get-FileHash -Algorithm SHA256 -LiteralPath $nasStableSignaturePath).Hash
    $leaseFixturePath = Join-Path $nasRoot ".revagent-publish.lease.json"
    '{"schemaVersion":1,"app":"revAgent","publishId":"active-fixture"}' | Set-Content -LiteralPath $leaseFixturePath -Encoding UTF8
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1") `
                -SourceReleaseRoot $releaseRoot `
                -NasReleaseRoot $nasRoot `
                -TrustedKeysPath $trustedKeysPath `
                -Force `
                -AllowRollback `
                -RepoRoot $RepoRoot `
                -AllowTestRoot | Out-Null
        } -Pattern "Another NAS publisher (holds|may hold)|production publish lease" -Message "NAS publisher ignored an existing publish lease."
    }
    finally { Remove-Item -LiteralPath $leaseFixturePath -Force -ErrorAction SilentlyContinue }
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $nasStableChannelPath).Hash $stableChannelHashBeforeLockTests "Lease rejection changed stable channel metadata."
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $nasStableSignaturePath).Hash $stableSignatureHashBeforeLockTests "Lease rejection changed stable signature metadata."

    $casHook = {
        param($channelPath, $signaturePath)
        $tampered = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json
        $tampered.version = 'concurrent-writer-fixture'
        $tampered | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $channelPath -Encoding UTF8
    }
    $stableChannelBytesBeforeCasFixture = [IO.File]::ReadAllBytes($nasStableChannelPath)
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1") `
                -SourceReleaseRoot $releaseRoot `
                -NasReleaseRoot $nasRoot `
                -TrustedKeysPath $trustedKeysPath `
                -Force `
                -AllowRollback `
                -RepoRoot $RepoRoot `
                -AllowTestRoot `
                -TestBeforeStablePromotionHook $casHook | Out-Null
        } -Pattern "readiness|compare-and-swap|identity changed" -Message "NAS publisher promoted over a stable channel changed after baseline authentication."
        $externalStableAfterCasReject = Get-Content -Raw -LiteralPath $nasStableChannelPath | ConvertFrom-Json
        Assert-Equal ([string]$externalStableAfterCasReject.version) 'concurrent-writer-fixture' "CAS rejection overwrote the external stable change even though publisher promotion had not started."
        Assert-True (-not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $nasStableChannelPath).Hash, $stableChannelHashBeforeLockTests, [StringComparison]::OrdinalIgnoreCase)) "CAS fixture did not change stable channel metadata."
        Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $nasStableSignaturePath).Hash $stableSignatureHashBeforeLockTests "CAS rejection changed stable signature metadata before publisher promotion."
    }
    finally { [IO.File]::WriteAllBytes($nasStableChannelPath, $stableChannelBytesBeforeCasFixture) }
    Assert-True (-not (Test-Path -LiteralPath $leaseFixturePath -PathType Leaf)) "NAS publish lease should be removed after CAS rejection."
    Assert-Equal @(Get-ChildItem -LiteralPath (Join-Path $nasRoot "channels") -File | Where-Object { $_.Name -match '^stable\.(candidate|next|previous)\.' }).Count 0 "CAS rejection should clean all per-publish channel artifacts after verified rollback."
    Assert-True (Test-Path -LiteralPath (Join-Path $nasRoot "tools\addons\dashboard\installer\install-dashboard-addon.ps1") -PathType Leaf) "NAS publish should carry dashboard admin add-on tools."
    Assert-True (Test-Path -LiteralPath (Join-Path $nasRoot "tools\addons\usage-intelligence\installer\install-usage-intelligence-addon.ps1") -PathType Leaf) "NAS publish should carry usage-intelligence admin add-on tools."
    Assert-True (Test-Path -LiteralPath (Join-Path $nasRoot "tools\addons\usage-intelligence\skills\revagent-usage-analyst\SKILL.md") -PathType Leaf) "NAS publish should carry the usage-intelligence analyst skill."
    Assert-True (Test-Path -LiteralPath (Join-Path $nasRoot "tools\publish-desktop-launcher-evidence.ps1") -PathType Leaf) "NAS publish should carry the desktop launcher evidence helper."
    Assert-True (Test-Path -LiteralPath (Join-Path $nasRoot "tools\collect-rollout-evidence.ps1") -PathType Leaf) "NAS publish should carry the SSH rollout evidence collector."
    Assert-True (Test-Path -LiteralPath (Join-Path $nasRoot "tools\invoke-live-smoke-over-ssh.ps1") -PathType Leaf) "NAS publish should carry the SSH live smoke runner."
    Assert-True (Test-Path -LiteralPath (Join-Path $nasRoot "tools\test-commandset-live.ps1") -PathType Leaf) "NAS publish should carry the live smoke evidence helper."
    $legacyLauncherNames = @(
        'Install-revAgent-Updater-GUI.cmd',
        'Install-Revit-MCP-Updater-GUI.cmd',
        'Install-revAgent-Updater.cmd',
        'Install-Revit-MCP-Updater.cmd'
    )
    $expectedManagedCommandPaths = @(
        'tools\revAgent Updater STABLE.cmd',
        'tools\Revit MCP Updater STABLE.cmd',
        'tools\Refresh-revAgent-LocalBootstrap-STABLE.cmd'
    ) + @($legacyLauncherNames | ForEach-Object { "tools\$_" }) + @($legacyLauncherNames)
    $nasRootPrefix = $nasRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $actualManagedCommandPaths = @(
        @(Get-ChildItem -LiteralPath $nasRoot -File -Filter '*.cmd') +
        @(Get-ChildItem -LiteralPath (Join-Path $nasRoot 'tools') -Recurse -File -Filter '*.cmd') |
            ForEach-Object { $_.FullName.Substring($nasRootPrefix.Length) } |
            Sort-Object
    )
    Assert-Equal $actualManagedCommandPaths.Count $expectedManagedCommandPaths.Count 'Published NAS surface exposed an unexpected number of CMD entry points.'
    Assert-Equal @($actualManagedCommandPaths | Where-Object { $_ -notin $expectedManagedCommandPaths }).Count 0 'Published NAS surface exposed an unmanaged CMD entry point.'
    Assert-Equal @($expectedManagedCommandPaths | Where-Object { $_ -notin $actualManagedCommandPaths }).Count 0 'Published NAS surface omitted a required managed CMD entry point.'

    $stableTemplateBytes = [IO.File]::ReadAllBytes((Join-Path $RepoRoot 'installer\nas\revAgent Updater STABLE.cmd'))
    $stableTemplateText = [Text.Encoding]::ASCII.GetString($stableTemplateBytes)
    $expectedFixtureLauncherBytes = [Text.Encoding]::ASCII.GetBytes($stableTemplateText.Replace(
            'set "RELEASE_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"',
            ('set "RELEASE_ROOT={0}"' -f $nasRoot.TrimEnd('\', '/'))))
    foreach ($stableLauncherName in @('revAgent Updater STABLE.cmd', 'Revit MCP Updater STABLE.cmd')) {
        $publishedLauncherBytes = [IO.File]::ReadAllBytes((Join-Path (Join-Path $nasRoot 'tools') $stableLauncherName))
        Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]]$publishedLauncherBytes, [byte[]]$expectedFixtureLauncherBytes)) "Published $stableLauncherName bytes drifted from the repo STABLE template after fixture-root substitution."
    }
    foreach ($legacyLauncherName in $legacyLauncherNames) {
        $sourceLegacyBytes = [IO.File]::ReadAllBytes((Join-Path (Join-Path $RepoRoot 'installer\nas') $legacyLauncherName))
        foreach ($publishedLegacyPath in @((Join-Path (Join-Path $nasRoot 'tools') $legacyLauncherName), (Join-Path $nasRoot $legacyLauncherName))) {
            Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($publishedLegacyPath), [byte[]]$sourceLegacyBytes)) "Published legacy launcher stub drifted from its exact repo source: $publishedLegacyPath"
        }
    }
    $publishedTrustedKeysPath = Join-Path $nasRoot 'tools\config\release-trusted-keys.json'
    Assert-True (Test-Path -LiteralPath $publishedTrustedKeysPath -PathType Leaf) 'Stable publisher did not publish release-trusted-keys.json.'
    Assert-Equal (Get-FileHash -LiteralPath $publishedTrustedKeysPath -Algorithm SHA256).Hash (Get-FileHash -LiteralPath $trustedKeysPath -Algorithm SHA256).Hash 'Published trusted keys did not match the verified publisher input.'

    $publisherJunction = Join-Path $nasRoot "tools\unsafe-publisher-junction"
    New-Item -ItemType Junction -Path $publisherJunction -Target $secretRoot | Out-Null
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1") `
                -SourceReleaseRoot $releaseRoot `
                -NasReleaseRoot $nasRoot `
                -TrustedKeysPath $trustedKeysPath `
                -Force `
                -AllowRollback `
                -RepoRoot $RepoRoot `
                -AllowTestRoot | Out-Null
        } -Pattern "unsafe filesystem link/reparse" -Message "NAS publisher accepted a reparse-point transport fixture."
    }
    finally { if (Test-Path -LiteralPath $publisherJunction) { [IO.Directory]::Delete($publisherJunction, $false) } }

    $publisherHardlink = Join-Path $nasRoot "tools\unsafe-publisher-hardlink.txt"
    New-Item -ItemType HardLink -Path $publisherHardlink -Target $privateKeyPath | Out-Null
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1") `
                -SourceReleaseRoot $releaseRoot `
                -NasReleaseRoot $nasRoot `
                -TrustedKeysPath $trustedKeysPath `
                -Force `
                -AllowRollback `
                -RepoRoot $RepoRoot `
                -AllowTestRoot | Out-Null
        } -Pattern "hard-linked file|unsafe filesystem link/reparse" -Message "NAS publisher accepted a hard-linked transport fixture."
    }
    finally { if (Test-Path -LiteralPath $publisherHardlink) { Remove-Item -LiteralPath $publisherHardlink -Force } }

    $nasReadiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $nasRoot `
        -TrustedKeysPath $trustedKeysPath `
        -ArtifactScanScope activeRelease `
        -RequirePublishedSurface `
        -AllowTestSigningIdentity `
        -RepoRoot $RepoRoot
    Assert-True ([bool]$nasReadiness.success) "Published NAS root should pass signed stable readiness."
    Assert-Equal ([string]$nasReadiness.artifactScanScope) "activeRelease" "NAS publish readiness should use the active release artifact scan scope."
    Assert-True ([bool]$nasReadiness.publishedSurface.required -and [bool]$nasReadiness.publishedSurface.success) 'Published NAS readiness did not verify the exact user-clickable surface.'

    $publishedTrustedKeysBytes = [IO.File]::ReadAllBytes($publishedTrustedKeysPath)
    try {
        Remove-Item -LiteralPath $publishedTrustedKeysPath -Force
        $missingPublishedKeysReadiness = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $nasRoot `
            -TrustedKeysPath $trustedKeysPath `
            -ArtifactScanScope activeRelease `
            -RequirePublishedSurface `
            -AllowTestSigningIdentity `
            -RepoRoot $RepoRoot `
            -ReportOnly
        Assert-True (-not [bool]$missingPublishedKeysReadiness.success) 'Published-surface readiness accepted missing NAS trusted keys.'
        Assert-True (@($missingPublishedKeysReadiness.checks | Where-Object { $_.name -eq 'published_surface_tools_config_release_trusted_keys_json_present' -and -not [bool]$_.success }).Count -eq 1) 'Missing NAS trusted keys did not fail the dedicated published-surface presence check.'
    }
    finally { [IO.File]::WriteAllBytes($publishedTrustedKeysPath, $publishedTrustedKeysBytes) }

    try {
        [IO.File]::WriteAllText($publishedTrustedKeysPath, '{"trustedKeys":', [Text.UTF8Encoding]::new($false))
        $brokenPublishedKeysReadiness = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $nasRoot `
            -TrustedKeysPath $trustedKeysPath `
            -ArtifactScanScope activeRelease `
            -RequirePublishedSurface `
            -AllowTestSigningIdentity `
            -RepoRoot $RepoRoot `
            -ReportOnly
        Assert-True (-not [bool]$brokenPublishedKeysReadiness.success) 'Published-surface readiness accepted malformed NAS trusted keys.'
        Assert-True (@($brokenPublishedKeysReadiness.checks | Where-Object { $_.name -in @('published_surface_tools_config_release_trusted_keys_json_sha256', 'published_surface_trusted_key_identity') -and -not [bool]$_.success }).Count -eq 2) 'Malformed NAS trusted keys did not fail both exact-hash and identity checks.'
    }
    finally { [IO.File]::WriteAllBytes($publishedTrustedKeysPath, $publishedTrustedKeysBytes) }

    Write-Host 'Test exact two-machine pilot isolation and rollback guards'
    $pilotReleaseRoot = Join-Path $tempRoot 'pilot-release-root'
    $pilotVersion = '2026.06.23.pilot.1-cd-test'
    $pilotSequence = 4001
    $pilotBuild = & (Join-Path $RepoRoot 'scripts\invoke-signed-source-free-cd.ps1') `
        -ReleaseRoot $pilotReleaseRoot `
        -TrustedKeysPath $trustedKeysPath `
        -NodeMsiPath $nodeMsiPath `
        -SigningPrivateKeyPath $privateKeyPath `
        -SigningKeyId $keyId `
        -Version $pilotVersion `
        -ReleaseSequence $pilotSequence `
        -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence `
        -Channel pilot `
        -PilotAllowedMachineNames @('NET01', 'TESTPILOT01') `
        -SkipEngineeringGates `
        -AllowDirty `
        -AllowNonMain `
        -Force `
        -RepoRoot $RepoRoot
    Assert-True ([bool]$pilotBuild.success -and [string]$pilotBuild.channel -eq 'pilot') 'Pilot CD fixture did not build successfully.'
    $pilotManifestPath = Join-Path $pilotReleaseRoot "releases\$pilotVersion\manifest.json"
    $pilotManifest = Get-Content -Raw -LiteralPath $pilotManifestPath | ConvertFrom-Json
    $pilotNodeMsiSidecar = Join-Path (Split-Path -Parent $pilotManifestPath) $nodeMsiRelativePath
    Assert-Equal ([string]$pilotManifest.externalDependencies.nodeMsi.relativePath) $nodeMsiRelativePath 'Pilot manifest must bind the exact release-owned Node.js MSI sidecar.'
    Assert-Equal ([string]$pilotManifest.externalDependencies.nodeMsi.sha256) $nodeMsiSha256 'Pilot manifest must bind the test Node.js MSI hash.'
    Assert-Equal ([long]$pilotManifest.externalDependencies.nodeMsi.sizeBytes) $nodeMsiSizeBytes 'Pilot manifest must bind the test Node.js MSI size.'
    Assert-Equal ([string]$pilotManifest.externalDependencies.nodeMsi.signerSubject) 'TEST-ONLY' 'Pilot manifest must expose the test-only MSI signer identity.'
    Assert-Equal ([string]$pilotManifest.externalDependencies.nodeMsi.authenticodeStatus) 'TestBypass' 'Pilot manifest must expose the test-only MSI signature status.'
    Assert-True (Test-Path -LiteralPath $pilotNodeMsiSidecar -PathType Leaf) 'Pilot source release is missing its release-owned Node.js MSI sidecar.'
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $pilotNodeMsiSidecar).Hash $nodeMsiSha256 'Pilot source release Node.js MSI sidecar hash does not match its signed metadata.'

    foreach ($postPilotReadinessTarget in @(
            [pscustomobject]@{ label = 'source stable'; root = $releaseRoot },
            [pscustomobject]@{ label = 'published stable'; root = $nasRoot }
        )) {
        $postPilotReadiness = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
            -ReleaseRoot $postPilotReadinessTarget.root `
            -TrustedKeysPath $trustedKeysPath `
            -ArtifactScanScope activeRelease `
            -AllowTestSigningIdentity `
            -RepoRoot $RepoRoot `
            -ReportOnly
        Assert-True ([bool]$postPilotReadiness.success) ("Post-pilot {0} readiness failed: {1}" -f $postPilotReadinessTarget.label, ($postPilotReadiness.integrity | ConvertTo-Json -Depth 8 -Compress))
    }

    $nasSharedNodeDependency = Join-Path $nasRoot 'tools\dependencies\node-v24.14.1-x64.msi'
    $nasSharedDependenciesRoot = Split-Path -Parent $nasSharedNodeDependency
    if (Test-Path -LiteralPath $nasSharedDependenciesRoot) {
        Remove-Item -LiteralPath $nasSharedDependenciesRoot -Recurse -Force
    }
    Assert-True (-not (Test-Path -LiteralPath $nasSharedNodeDependency)) 'Pilot isolation fixture must start without a NAS shared-tools Node.js MSI dependency.'

    $stableChannelBytes = [IO.File]::ReadAllBytes($nasStableChannelPath)
    $stableSignatureBytes = [IO.File]::ReadAllBytes($nasStableSignaturePath)
    $stableReleaseRoot = Join-Path $nasRoot "releases\$version"
    $stableReleaseDigest = Get-TestTreeDigest -Root $stableReleaseRoot
    $stableToolsDigest = Get-TestTreeDigest -Root (Join-Path $nasRoot 'tools')
    $pilotNasReleaseRoot = Join-Path $nasRoot "releases\$pilotVersion"
    $pilotChannelPath = Join-Path $nasRoot 'channels\pilot.json'
    $pilotSignaturePath = Join-Path $nasRoot 'channels\pilot.sig.json'

    $substitutedValidArtifactHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $pilotReleaseRoot 'channels\pilot.json')).Hash
    Assert-ThrowsLike -Action {
        & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') `
            -SourceReleaseRoot $releaseRoot `
            -NasReleaseRoot $nasRoot `
            -TrustedKeysPath $trustedKeysPath `
            -Channel stable `
            -ExpectedSourceChannelSha256 $substitutedValidArtifactHash `
            -Force `
            -AllowRollback `
            -RepoRoot $RepoRoot `
            -AllowTestRoot | Out-Null
    } -Pattern 'workflow artifact handoff' -Message 'Publisher accepted a valid signed source that did not match the exact workflow artifact handoff hash.'
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($nasStableChannelPath), [byte[]]$stableChannelBytes) -and [Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($nasStableSignaturePath), [byte[]]$stableSignatureBytes)) 'Artifact-handoff substitution rejection mutated the active channel pair.'
    Write-Host '  artifact handoff substitution: PASS'

    $authorizationProbe = [pscustomobject]@{ called = $false }
    $authorizationHook = { param($machine, $allowed); $authorizationProbe.called = $true }.GetNewClosure()
    $unauthorizedEvidencePath = Join-Path $tempRoot 'unauthorized-pilot-evidence.json'
    Assert-ThrowsLike -Action {
        & (Join-Path $RepoRoot 'scripts\New-RevAgentBootstrapPrestageEvidence.ps1') `
            -ReleaseRoot $pilotReleaseRoot `
            -TrustedKeysPath $trustedKeysPath `
            -OutputPath $unauthorizedEvidencePath `
            -Channel pilot `
            -RepoRoot $RepoRoot `
            -AllowTestRoot `
            -TestMachineName 'OUTSIDER01' `
            -TestAfterPilotAuthorizationHook $authorizationHook | Out-Null
    } -Pattern 'pilot_machine_not_allowed' -Message 'Signed pilot prestage accepted an unauthorized machine.'
    Assert-True (-not $authorizationProbe.called -and -not (Test-Path -LiteralPath $unauthorizedEvidencePath)) 'Unauthorized pilot prestage wrote evidence or crossed its authorization hook.'
    Write-Host '  unauthorized prestage: PASS'

    $snapshotModule = Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.ReleaseSnapshot.psm1') -Force -PassThru
    $newInboxCommand = Get-Command ("{0}\New-RevAgentAuthenticatedReleaseInbox" -f $snapshotModule.Name) -ErrorAction Stop
    $newSnapshotCommand = Get-Command ("{0}\New-RevAgentProtectedReleaseSnapshot" -f $snapshotModule.Name) -ErrorAction Stop
    $assertSnapshotCommand = Get-Command ("{0}\Assert-RevAgentProtectedReleaseSnapshot" -f $snapshotModule.Name) -ErrorAction Stop
    if ($PSVersionTable.PSEdition -eq 'Core' -and $null -ne ('Newtonsoft.Json.JsonConvert' -as [type])) {
        $snapshotFallbackEvidence = & $snapshotModule {
            $script:RevAgentSnapshotJsonSupportsDateKind = $false
            $script:RevAgentSnapshotJsonRequiresNewtonsoft = $true
            try {
                $parsed = ConvertFrom-RevAgentSnapshotJsonPreservingStrings -Json '{"createdAtUtc":"2026-07-20T00:00:00.0000000Z"}'
                $collisionRejected = $false
                try { [void](ConvertFrom-RevAgentSnapshotJsonPreservingStrings -Json '{"app":"revAgent","App":"evil"}') }
                catch { $collisionRejected = [string]$_.Exception.Message -match 'case-insensitive duplicate JSON property' }
                return [pscustomobject]@{ parsed = $parsed; collisionRejected = $collisionRejected }
            }
            finally {
                $script:RevAgentSnapshotJsonSupportsDateKind = $null
                $script:RevAgentSnapshotJsonRequiresNewtonsoft = $null
            }
        }
        Assert-True ($snapshotFallbackEvidence.parsed.createdAtUtc -is [string] -and [string]$snapshotFallbackEvidence.parsed.createdAtUtc -ceq '2026-07-20T00:00:00.0000000Z') 'Release snapshot older-Core fallback did not preserve the exact ISO JSON string.'
        Assert-True ([bool]$snapshotFallbackEvidence.collisionRejected) 'Release snapshot older-Core fallback collapsed a case-insensitive JSON property collision.'
    }
    $pilotInboxRoot = Join-Path $tempRoot 'pilot-inbox'
    New-Item -ItemType Directory -Path $pilotInboxRoot -Force | Out-Null
    $inboxProbe = [pscustomobject]@{ called = $false }
    $inboxHook = { param($path, $source); $inboxProbe.called = $true }.GetNewClosure()
    $nodeMsiHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $pilotNodeMsiSidecar).Hash
    $invalidSnapshotTrustPath = Join-Path $secretRoot 'snapshot-trust-metadata-offset.json'
    [ordered]@{
        schemaVersion = 1
        app = 'revAgent'
        generatedAtUtc = '2026-07-20T00:00:00+00:00'
        trustedKeys = $trustedKeys.trustedKeys
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $invalidSnapshotTrustPath -Encoding UTF8
    Assert-ThrowsLike -Action {
        & $newInboxCommand -ReleaseRoot $pilotReleaseRoot -Channel pilot -TrustedKeysPath $invalidSnapshotTrustPath -IntegrityModulePath (Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1') -InboxRoot $pilotInboxRoot -ExpectedNodeMsiSha256 $nodeMsiHash -AllowTestRoot -TestMachineName 'TESTPILOT01' | Out-Null
    } -Pattern 'Protected trust metadata.*ISO UTC generatedAtUtc' -Message 'Authenticated inbox acquisition accepted a non-literal-Z protected trust timestamp.'
    Assert-True (@(Get-ChildItem -LiteralPath $pilotInboxRoot -Force).Count -eq 0) 'Rejected protected trust metadata created an authenticated inbox child.'
    Assert-ThrowsLike -Action {
        & $newInboxCommand -ReleaseRoot $pilotReleaseRoot -Channel pilot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath (Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1') -InboxRoot $pilotInboxRoot -ExpectedNodeMsiSha256 $nodeMsiHash -AllowTestRoot -TestMachineName 'OUTSIDER01' -TestBeforeInboxChildCreateHook $inboxHook | Out-Null
    } -Pattern 'pilot_machine_not_allowed' -Message 'Authenticated inbox acquisition accepted an unauthorized pilot machine.'
    Assert-True (-not $inboxProbe.called -and @(Get-ChildItem -LiteralPath $pilotInboxRoot -Force).Count -eq 0) 'Unauthorized pilot inbox acquisition created a child or crossed its child-creation hook.'
    Write-Host '  unauthorized inbox: PASS'
    $authorizedInbox = & $newInboxCommand -ReleaseRoot $pilotReleaseRoot -Channel pilot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath (Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1') -InboxRoot $pilotInboxRoot -ExpectedNodeMsiSha256 $nodeMsiHash -AllowTestRoot -TestMachineName 'TESTPILOT01'
    $snapshotProbe = [pscustomobject]@{ called = $false }
    $snapshotHook = { param($guard); $snapshotProbe.called = $true }.GetNewClosure()
    Assert-ThrowsLike -Action {
        & $newSnapshotCommand -InboxPath $authorizedInbox.inboxRoot -Channel pilot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath (Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1') -SnapshotParent (Join-Path $tempRoot 'unauthorized-pilot-snapshots') -ExpectedNodeMsiSha256 $nodeMsiHash -AllowTestRoot -TestMachineName 'OUTSIDER01' -SnapshotParentLockedHook $snapshotHook | Out-Null
    } -Pattern 'pilot_machine_not_allowed' -Message 'Protected snapshot creation accepted an unauthorized pilot machine.'
    Assert-True (-not $snapshotProbe.called -and -not (Test-Path -LiteralPath (Join-Path $tempRoot 'unauthorized-pilot-snapshots'))) 'Unauthorized pilot snapshot crossed its parent/child creation boundary.'
    Write-Host '  unauthorized snapshot: PASS'

    Write-Host 'Test signed pilot snapshot directory components across PowerShell engines'
    $authorizedSnapshot = & $newSnapshotCommand `
        -InboxPath $authorizedInbox.inboxRoot `
        -Channel pilot `
        -TrustedKeysPath $trustedKeysPath `
        -IntegrityModulePath (Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1') `
        -SnapshotParent (Join-Path $tempRoot 'authorized-pilot-snapshots-current') `
        -ExpectedNodeMsiSha256 $nodeMsiHash `
        -AllowTestRoot `
        -TestMachineName 'TESTPILOT01'
    Assert-True ([bool]$authorizedSnapshot.success) 'Current PowerShell engine could not create an authorized signed pilot snapshot.'
    foreach ($componentName in @('runtimePayload', 'docsServerPayload')) {
        $componentState = $authorizedSnapshot.state.components.PSObject.Properties[$componentName].Value
        Assert-True ($null -ne $componentState) "Authorized snapshot is missing '$componentName' component state."
        Assert-True (Test-Path -LiteralPath (Join-Path $authorizedSnapshot.snapshotRoot ([string]$componentState.snapshotRelativePath)) -PathType Container) "Authorized snapshot did not extract '$componentName'."
    }
    Assert-True ([bool](& $assertSnapshotCommand -SnapshotRoot $authorizedSnapshot.snapshotRoot -AllowTestRoot)) 'Current-engine authorized snapshot failed protected-root reattestation.'

    $windowsPowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Assert-True (Test-Path -LiteralPath $windowsPowerShellPath -PathType Leaf) 'Windows PowerShell 5.1 is required for the signed snapshot cross-engine regression.'
    $childArguments = [ordered]@{
        snapshotModulePath = (Join-Path $RepoRoot 'installer\lib\RevAgent.ReleaseSnapshot.psm1')
        integrityModulePath = (Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1')
        inboxPath = [string]$authorizedInbox.inboxRoot
        trustedKeysPath = $trustedKeysPath
        snapshotParent = (Join-Path $tempRoot 'authorized-pilot-snapshots-ps5')
        expectedNodeMsiSha256 = $nodeMsiHash
    }
    $childArgumentsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($childArguments | ConvertTo-Json -Compress)))
    $childScript = @"
`$ErrorActionPreference = 'Stop'
`$argumentsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$childArgumentsBase64'))
`$arguments = `$argumentsJson | ConvertFrom-Json -ErrorAction Stop
Import-Module `$arguments.integrityModulePath -Force -WarningAction SilentlyContinue
Import-Module `$arguments.snapshotModulePath -Force -WarningAction SilentlyContinue
`$snapshot = New-RevAgentProtectedReleaseSnapshot -InboxPath `$arguments.inboxPath -Channel pilot -TrustedKeysPath `$arguments.trustedKeysPath -IntegrityModulePath `$arguments.integrityModulePath -SnapshotParent `$arguments.snapshotParent -ExpectedNodeMsiSha256 `$arguments.expectedNodeMsiSha256 -AllowTestRoot -TestMachineName 'TESTPILOT01'
foreach (`$componentName in @('runtimePayload', 'docsServerPayload')) {
    `$component = `$snapshot.state.components.PSObject.Properties[`$componentName].Value
    if (`$null -eq `$component) { throw "Windows PowerShell snapshot is missing '`$componentName' component state." }
    if (-not (Test-Path -LiteralPath (Join-Path `$snapshot.snapshotRoot ([string]`$component.snapshotRelativePath)) -PathType Container)) { throw "Windows PowerShell snapshot did not extract '`$componentName'." }
}
if (-not (Assert-RevAgentProtectedReleaseSnapshot -SnapshotRoot `$snapshot.snapshotRoot -AllowTestRoot)) { throw 'Windows PowerShell snapshot reattestation failed.' }
`$result = [pscustomobject]@{ engineVersion = `$PSVersionTable.PSVersion.ToString(); success = [bool]`$snapshot.success; snapshotRoot = [string]`$snapshot.snapshotRoot }
[Console]::Out.WriteLine('REVAGENT_RESULT=' + (`$result | ConvertTo-Json -Compress))
"@
    $encodedChildScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
    $childOutput = & $windowsPowerShellPath -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedChildScript 2>&1
    $childExitCode = $LASTEXITCODE
    $childText = $childOutput -join [Environment]::NewLine
    Assert-Equal ([int]$childExitCode) 0 "Windows PowerShell signed snapshot consumer failed. output=$childText"
    $childMatch = [regex]::Match($childText, 'REVAGENT_RESULT=(\{[^\r\n]+\})')
    Assert-True $childMatch.Success "Windows PowerShell signed snapshot consumer did not return its result marker. output=$childText"
    $childResult = $childMatch.Groups[1].Value | ConvertFrom-Json
    Assert-Equal ([int]([Version]$childResult.engineVersion).Major) 5 'Signed snapshot cross-engine consumer did not use Windows PowerShell 5.1.'
    Assert-True ([bool]$childResult.success) 'Windows PowerShell 5.1 could not consume the pwsh-produced signed pilot tree hashes.'
    Write-Host '  pwsh producer -> Windows PowerShell 5.1 snapshot consumer: PASS'

    $stableRollbackAlias = Join-Path $tempRoot 'stable-signature-hardlink-alias.json'
    $stableRollbackHook = {
        param($channelPath, $signaturePath)
        New-Item -ItemType HardLink -Path $stableRollbackAlias -Target $signaturePath | Out-Null
        throw 'injected signature rollback fixture'
    }.GetNewClosure()
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') -SourceReleaseRoot $releaseRoot -NasReleaseRoot $nasRoot -TrustedKeysPath $trustedKeysPath -Channel stable -Force -AllowRollback -RepoRoot $RepoRoot -AllowTestRoot -TestUseProductionPublishedSurface -TestAfterSignatureWriteHook $stableRollbackHook | Out-Null
        } -Pattern 'injected signature rollback fixture' -Message 'Same-handle rollback fixture did not fail at the injected boundary.'
    }
    finally { if (Test-Path -LiteralPath $stableRollbackAlias) { Remove-Item -LiteralPath $stableRollbackAlias -Force } }
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($nasStableChannelPath), [byte[]]$stableChannelBytes) -and [Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($nasStableSignaturePath), [byte[]]$stableSignatureBytes)) 'Stable same-handle rollback did not restore exact baseline bytes after a hardlink anomaly.'
    $stableToolsAfterPublishedSurfaceRollback = Get-TestTreeDigest -Root (Join-Path $nasRoot 'tools')
    Assert-True ($stableToolsAfterPublishedSurfaceRollback.itemCount -eq $stableToolsDigest.itemCount -and $stableToolsAfterPublishedSurfaceRollback.sha256 -eq $stableToolsDigest.sha256) 'Stable exact-managed published surface was not restored after a post-write failure.'
    Write-Host '  same-handle hardlink rollback: PASS'

    $independentRollbackStepsSeen = [Collections.Generic.List[string]]::new()
    $independentRollbackPrimaryHook = {
        param($channelPath, $signaturePath)
        throw 'injected independent rollback primary failure'
    }
    $independentRollbackStepHook = {
        param($stepName)
        $independentRollbackStepsSeen.Add([string]$stepName) | Out-Null
        if ([string]::Equals([string]$stepName, 'stable bootstrap tool rollback: config\release-trusted-keys.json', [StringComparison]::Ordinal)) {
            throw 'injected independent rollback step failure'
        }
    }.GetNewClosure()
    Assert-ThrowsLike -Action {
        & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') `
            -SourceReleaseRoot $releaseRoot `
            -NasReleaseRoot $nasRoot `
            -TrustedKeysPath $trustedKeysPath `
            -Channel stable `
            -Force `
            -AllowRollback `
            -RepoRoot $RepoRoot `
            -AllowTestRoot `
            -TestUseProductionPublishedSurface `
            -TestAfterSignatureWriteHook $independentRollbackPrimaryHook `
            -TestBeforeRollbackStepHook $independentRollbackStepHook | Out-Null
    } -Pattern '(?s)injected independent rollback primary failure.*injected independent rollback step failure' -Message 'Independent rollback fixture did not aggregate the original publish error and injected rollback-step error.'

    $rollbackStepNames = @($independentRollbackStepsSeen.ToArray())
    foreach ($requiredRollbackStep in @(
            'active channel signature rollback',
            'active channel manifest rollback',
            'stable updater launcher rollback',
            'legacy stable updater launcher rollback',
            'test fixture tools directory rollback',
            'test fixture release directory rollback'
        )) {
        Assert-True ($rollbackStepNames -contains $requiredRollbackStep) "Independent rollback skipped '$requiredRollbackStep' after another step failed."
    }
    $publishedToolRollbackSteps = @($rollbackStepNames | Where-Object { $_ -like 'stable bootstrap tool rollback:*' })
    Assert-Equal ([int]$publishedToolRollbackSteps.Count) 11 'Independent rollback did not attempt all 11 exact-managed bootstrap tool surfaces.'
    Assert-True ($publishedToolRollbackSteps -contains 'stable bootstrap tool rollback: Install-Revit-MCP-Updater.cmd') 'Independent rollback stopped before the final exact-managed compatibility surface.'
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($nasStableChannelPath), [byte[]]$stableChannelBytes) -and [Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($nasStableSignaturePath), [byte[]]$stableSignatureBytes)) 'Independent rollback aggregation did not restore the exact stable channel-pair baseline.'
    $stableToolsAfterIndependentRollback = Get-TestTreeDigest -Root (Join-Path $nasRoot 'tools')
    Assert-True ($stableToolsAfterIndependentRollback.itemCount -eq $stableToolsDigest.itemCount -and $stableToolsAfterIndependentRollback.sha256 -eq $stableToolsDigest.sha256) 'Independent rollback aggregation did not restore the stable tools baseline.'
    $stableReleaseAfterIndependentRollback = Get-TestTreeDigest -Root $stableReleaseRoot
    Assert-True ($stableReleaseAfterIndependentRollback.itemCount -eq $stableReleaseDigest.itemCount -and $stableReleaseAfterIndependentRollback.sha256 -eq $stableReleaseDigest.sha256) 'Independent rollback aggregation did not restore the stable release baseline.'
    Write-Host '  independent rollback aggregation: PASS'

    $newPairRaceBytes = [Text.Encoding]::UTF8.GetBytes('{"external":"new-pair-race"}')
    $newPairRaceHook = { param($channelPath, $signaturePath); [IO.File]::WriteAllBytes($signaturePath, $newPairRaceBytes) }.GetNewClosure()
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') -SourceReleaseRoot $pilotReleaseRoot -NasReleaseRoot $nasRoot -TrustedKeysPath $trustedKeysPath -Channel pilot -Force -RepoRoot $RepoRoot -AllowTestRoot -TestBeforeNewPairCreateHook $newPairRaceHook | Out-Null
        } -Pattern 'partial pair|partially present|existence changed|exactly one' -Message 'Pilot publisher overwrote an externally created new-pair race file.'
        Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($pilotSignaturePath), [byte[]]$newPairRaceBytes)) 'Pilot publisher removed or changed the externally raced signature path.'
    }
    finally { if (Test-Path -LiteralPath $pilotSignaturePath) { Remove-Item -LiteralPath $pilotSignaturePath -Force } }
    Write-Host '  new-pair race: PASS'

    $stableChildPath = Join-Path $stableReleaseRoot 'external-child-race.txt'
    $stableChildHook = { param($root, $pilotDir, $stableDir, $toolsDir); [IO.File]::WriteAllText($stableChildPath, 'external', [Text.UTF8Encoding]::new($false)) }.GetNewClosure()
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') -SourceReleaseRoot $pilotReleaseRoot -NasReleaseRoot $nasRoot -TrustedKeysPath $trustedKeysPath -Channel pilot -Force -RepoRoot $RepoRoot -AllowTestRoot -TestBeforePilotImmutableFinalVerificationHook $stableChildHook | Out-Null
        } -Pattern 'active stable release tree|immutable stable surface|changed' -Message 'Pilot publisher accepted an injected child in the active stable release tree.'
    }
    finally { if (Test-Path -LiteralPath $stableChildPath) { Remove-Item -LiteralPath $stableChildPath -Force } }
    Write-Host '  stable release child race: PASS'

    foreach ($hardlinkCase in @('stable-pair', 'tools')) {
        $hardlinkAlias = Join-Path $tempRoot ("pilot-{0}-hardlink-alias" -f $hardlinkCase)
        $hardlinkTarget = if ($hardlinkCase -eq 'stable-pair') { $nasStableChannelPath } else { (Get-ChildItem -LiteralPath (Join-Path $nasRoot 'tools') -File -Recurse | Select-Object -First 1).FullName }
        $hardlinkHook = { param($root, $pilotDir, $stableDir, $toolsDir); New-Item -ItemType HardLink -Path $hardlinkAlias -Target $hardlinkTarget | Out-Null }.GetNewClosure()
        try {
            Assert-ThrowsLike -Action {
                & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') -SourceReleaseRoot $pilotReleaseRoot -NasReleaseRoot $nasRoot -TrustedKeysPath $trustedKeysPath -Channel pilot -Force -RepoRoot $RepoRoot -AllowTestRoot -TestBeforePilotImmutableFinalVerificationHook $hardlinkHook | Out-Null
            } -Pattern 'hardlink|non-unit|immutable stable surface|exact handle' -Message "Pilot publisher accepted the $hardlinkCase hardlink mutation."
        }
        finally { if (Test-Path -LiteralPath $hardlinkAlias) { Remove-Item -LiteralPath $hardlinkAlias -Force } }
        Write-Host "  $hardlinkCase hardlink: PASS"
    }

    $ownedAlias = Join-Path $tempRoot 'pilot-owned-tree-hardlink-alias'
    $ownedTreeHook = {
        param($root, $pilotDir, $stableDir, $toolsDir)
        $target = (Get-ChildItem -LiteralPath $pilotDir -File -Recurse | Select-Object -First 1).FullName
        New-Item -ItemType HardLink -Path $ownedAlias -Target $target | Out-Null
    }.GetNewClosure()
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') -SourceReleaseRoot $pilotReleaseRoot -NasReleaseRoot $nasRoot -TrustedKeysPath $trustedKeysPath -Channel pilot -Force -RepoRoot $RepoRoot -AllowTestRoot -TestBeforePilotImmutableFinalVerificationHook $ownedTreeHook | Out-Null
        } -Pattern 'hardlink|non-unit|rollback/cleanup also failed|manual recovery' -Message 'Pilot destination hardlink did not fail inside the rollback-protected transaction.'
    }
    finally {
        if (Test-Path -LiteralPath $ownedAlias) { Remove-Item -LiteralPath $ownedAlias -Force }
        if (Test-Path -LiteralPath $pilotNasReleaseRoot) { Remove-Item -LiteralPath $pilotNasReleaseRoot -Recurse -Force }
    }
    Assert-True (-not (Test-Path -LiteralPath $pilotChannelPath) -and -not (Test-Path -LiteralPath $pilotSignaturePath)) 'Pilot channel pair survived a failed owned-tree invariant after rollback.'
    Write-Host '  owned pilot tree hardlink rollback: PASS'

    Write-Host '  legacy sidecar-less pilot baseline transition...'
    $legacyPilotVersion = '2026.06.23.pilot.0-legacy-cd-test'
    $legacyPilotSequence = [long]($pilotSequence - 1)
    $legacyPilotNasReleaseRoot = Join-Path $nasRoot "releases\$legacyPilotVersion"
    $pilotSourceReleaseRoot = Join-Path $pilotReleaseRoot "releases\$pilotVersion"
    Copy-Item -LiteralPath $pilotSourceReleaseRoot -Destination $legacyPilotNasReleaseRoot -Recurse

    $legacyPilotPackageName = "revAgent-$legacyPilotVersion.zip"
    $legacyPilotOriginalPackages = @(Get-ChildItem -LiteralPath $legacyPilotNasReleaseRoot -File -Filter '*.zip')
    Assert-Equal $legacyPilotOriginalPackages.Count 1 'Legacy pilot fixture must contain exactly one release ZIP.'
    $legacyPilotOriginalPackage = $legacyPilotOriginalPackages[0]
    Move-Item -LiteralPath $legacyPilotOriginalPackage.FullName -Destination (Join-Path $legacyPilotNasReleaseRoot $legacyPilotPackageName)
    $legacyPilotExternalRoot = Join-Path $legacyPilotNasReleaseRoot 'external'
    if (Test-Path -LiteralPath $legacyPilotExternalRoot) { Remove-Item -LiteralPath $legacyPilotExternalRoot -Recurse -Force }

    $legacyPilotManifestPath = Join-Path $legacyPilotNasReleaseRoot 'manifest.json'
    $legacyPilotManifestSignaturePath = Join-Path $legacyPilotNasReleaseRoot 'manifest.sig.json'
    $legacyPilotManifest = Get-Content -Raw -LiteralPath $legacyPilotManifestPath -Encoding UTF8 | ConvertFrom-Json
    if ($legacyPilotManifest.publishedAtUtc -is [DateTime]) {
        $legacyPilotManifest.publishedAtUtc = ([DateTime]$legacyPilotManifest.publishedAtUtc).ToUniversalTime().ToString('o')
    }
    $legacyPilotManifest.version = $legacyPilotVersion
    $legacyPilotManifest.releaseSequence = $legacyPilotSequence
    $legacyPilotManifest.package.fileName = $legacyPilotPackageName
    $legacyPilotManifest.package.path = "..\releases\$legacyPilotVersion\$legacyPilotPackageName"
    [void]$legacyPilotManifest.PSObject.Properties.Remove('externalDependencies')
    $legacyPilotManifest | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $legacyPilotManifestPath -Encoding UTF8
    $legacyPilotManifestSignature = New-RevAgentDetachedJsonSignature -Content $legacyPilotManifest -SignedObject 'release-manifest' -KeyId $keyId -PrivateKeyXml ($rsa.ToXmlString($true)) -App 'revAgent'
    $legacyPilotManifestSignature | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $legacyPilotManifestSignaturePath -Encoding UTF8

    $legacyPilotChannel = Get-Content -Raw -LiteralPath (Join-Path $pilotReleaseRoot 'channels\pilot.json') -Encoding UTF8 | ConvertFrom-Json
    if ($legacyPilotChannel.publishedAtUtc -is [DateTime]) {
        $legacyPilotChannel.publishedAtUtc = ([DateTime]$legacyPilotChannel.publishedAtUtc).ToUniversalTime().ToString('o')
    }
    $legacyPilotChannel.version = $legacyPilotVersion
    $legacyPilotChannel.releaseSequence = $legacyPilotSequence
    $legacyPilotChannel.manifestPath = "..\releases\$legacyPilotVersion\manifest.json"
    $legacyPilotChannel.packagePath = "..\releases\$legacyPilotVersion\$legacyPilotPackageName"
    $legacyPilotChannel | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $pilotChannelPath -Encoding UTF8
    $legacyPilotChannelSignature = New-RevAgentDetachedJsonSignature -Content $legacyPilotChannel -SignedObject 'channel' -KeyId $keyId -PrivateKeyXml ($rsa.ToXmlString($true)) -App 'revAgent'
    $legacyPilotChannelSignature | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $pilotSignaturePath -Encoding UTF8

    $legacyPilotReadiness = & (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1') `
        -ReleaseRoot $nasRoot `
        -ChannelManifestPath $pilotChannelPath `
        -TrustedKeysPath $trustedKeysPath `
        -ArtifactScanScope activeRelease `
        -AllowTestSigningIdentity `
        -AllowLegacyMissingNodeMsi `
        -RepoRoot $RepoRoot
    Assert-True ([bool]$legacyPilotReadiness.success -and [bool]$legacyPilotReadiness.nodeMsi.legacyBaselineAccepted) 'Exact active sidecar-less pilot baseline did not pass the bounded transition readiness allowance.'

    $legacyPilotChannelBytes = [IO.File]::ReadAllBytes($pilotChannelPath)
    $legacyPilotSignatureBytes = [IO.File]::ReadAllBytes($pilotSignaturePath)
    $legacyPilotManifestBytes = [IO.File]::ReadAllBytes($legacyPilotManifestPath)
    $legacyPilotTreeDigest = Get-TestTreeDigest -Root $legacyPilotNasReleaseRoot

    $pilotNodeMsiBytes = [IO.File]::ReadAllBytes($pilotNodeMsiSidecar)
    Remove-Item -LiteralPath $pilotNodeMsiSidecar -Force
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') -SourceReleaseRoot $pilotReleaseRoot -NasReleaseRoot $nasRoot -TrustedKeysPath $trustedKeysPath -Channel pilot -Force -RepoRoot $RepoRoot -AllowTestRoot | Out-Null
        } -Pattern 'readiness|Node.js MSI|sidecar|external dependency' -Message 'Pilot publisher accepted a new candidate with its signed Node.js MSI sidecar missing.'
    }
    finally { [IO.File]::WriteAllBytes($pilotNodeMsiSidecar, $pilotNodeMsiBytes) }

    [IO.File]::AppendAllText($pilotNodeMsiSidecar, 'TAMPERED')
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') -SourceReleaseRoot $pilotReleaseRoot -NasReleaseRoot $nasRoot -TrustedKeysPath $trustedKeysPath -Channel pilot -Force -RepoRoot $RepoRoot -AllowTestRoot | Out-Null
        } -Pattern 'readiness|Node.js MSI|hash|signed metadata' -Message 'Pilot publisher accepted a new candidate with a tampered Node.js MSI sidecar.'
    }
    finally { [IO.File]::WriteAllBytes($pilotNodeMsiSidecar, $pilotNodeMsiBytes) }

    $tamperedLegacyManifest = Get-Content -Raw -LiteralPath $legacyPilotManifestPath -Encoding UTF8 | ConvertFrom-Json
    $tamperedLegacyManifest.version = 'tampered-legacy-pilot-baseline'
    $tamperedLegacyManifest | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $legacyPilotManifestPath -Encoding UTF8
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') -SourceReleaseRoot $pilotReleaseRoot -NasReleaseRoot $nasRoot -TrustedKeysPath $trustedKeysPath -Channel pilot -Force -RepoRoot $RepoRoot -AllowTestRoot | Out-Null
        } -Pattern 'readiness|integrity|signature' -Message 'Pilot publisher let the legacy baseline allowance bypass a tampered release manifest.'
    }
    finally { [IO.File]::WriteAllBytes($legacyPilotManifestPath, $legacyPilotManifestBytes) }

    $legacyPilotTreeAfterRejects = Get-TestTreeDigest -Root $legacyPilotNasReleaseRoot
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($pilotChannelPath), [byte[]]$legacyPilotChannelBytes) -and [Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($pilotSignaturePath), [byte[]]$legacyPilotSignatureBytes)) 'Rejected candidate/baseline tamper test changed the active legacy pilot pair.'
    Assert-True ($legacyPilotTreeAfterRejects.itemCount -eq $legacyPilotTreeDigest.itemCount -and $legacyPilotTreeAfterRejects.sha256 -eq $legacyPilotTreeDigest.sha256) 'Rejected candidate/baseline tamper test changed the legacy pilot release tree.'

    Write-Host '  final successful pilot publish...'
    $pilotPublishResult = & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') -SourceReleaseRoot $pilotReleaseRoot -NasReleaseRoot $nasRoot -TrustedKeysPath $trustedKeysPath -Channel pilot -Force -RepoRoot $RepoRoot -AllowTestRoot
    Assert-True ([bool]$pilotPublishResult.success -and [bool]$pilotPublishResult.pilotIsolation.stableUnchanged -and [bool]$pilotPublishResult.pilotIsolation.sharedToolsUnchanged -and [bool]$pilotPublishResult.pilotIsolation.activeStableReleaseUnchanged -and [bool]$pilotPublishResult.pilotIsolation.heldHandleInvariantsVerified) 'Successful pilot publish did not return complete stable/tools/handle isolation evidence.'
    $stableReleaseAfterPilot = Get-TestTreeDigest -Root $stableReleaseRoot
    $stableToolsAfterPilot = Get-TestTreeDigest -Root (Join-Path $nasRoot 'tools')
    Assert-True ($stableReleaseAfterPilot.itemCount -eq $stableReleaseDigest.itemCount -and $stableReleaseAfterPilot.sha256 -eq $stableReleaseDigest.sha256 -and $stableToolsAfterPilot.itemCount -eq $stableToolsDigest.itemCount -and $stableToolsAfterPilot.sha256 -eq $stableToolsDigest.sha256) 'Successful pilot publish changed the canonical stable release or shared tools tree.'
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($nasStableChannelPath), [byte[]]$stableChannelBytes) -and [Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($nasStableSignaturePath), [byte[]]$stableSignatureBytes)) 'Successful pilot publish changed canonical stable channel bytes.'
    Assert-True (-not (Test-Path -LiteralPath $nasSharedNodeDependency)) 'Pilot publish created the forbidden Node.js MSI dependency under NAS shared tools.'
    $pilotNasNodeMsiSidecar = Join-Path $pilotNasReleaseRoot $nodeMsiRelativePath
    Assert-True (Test-Path -LiteralPath $pilotNasNodeMsiSidecar -PathType Leaf) 'Pilot NAS release is missing its release-owned Node.js MSI sidecar.'
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $pilotNasNodeMsiSidecar).Hash $nodeMsiSha256 'Pilot NAS release Node.js MSI sidecar hash does not match signed metadata.'
    Assert-Equal ([long](Get-Item -LiteralPath $pilotNasNodeMsiSidecar).Length) $nodeMsiSizeBytes 'Pilot NAS release Node.js MSI sidecar size does not match signed metadata.'
    $publishedPilotChannel = Get-Content -Raw -LiteralPath $pilotChannelPath | ConvertFrom-Json
    Assert-Equal ([string]$publishedPilotChannel.version) $pilotVersion 'Legacy pilot transition did not activate the new sidecar-bearing pilot version.'
    Assert-Equal ([long]$publishedPilotChannel.releaseSequence) ([long]$pilotSequence) 'Legacy pilot transition did not advance the active pilot release sequence.'
    $legacyPilotTreeAfterPublish = Get-TestTreeDigest -Root $legacyPilotNasReleaseRoot
    Assert-True ($legacyPilotTreeAfterPublish.itemCount -eq $legacyPilotTreeDigest.itemCount -and $legacyPilotTreeAfterPublish.sha256 -eq $legacyPilotTreeDigest.sha256) 'Successful replacement pilot publish mutated the immutable legacy pilot release tree.'

    $stableChannelBytesBeforeTamper = [IO.File]::ReadAllBytes($nasStableChannelPath)
    $legacyStableChannel = Get-Content -Raw -LiteralPath $nasStableChannelPath | ConvertFrom-Json
    $legacyStableChannel.PSObject.Properties.Remove("releaseSequence")
    $legacyStableChannel | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $nasStableChannelPath -Encoding UTF8
    try {
        Assert-ThrowsLike -Action {
            & (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1") `
                -SourceReleaseRoot $releaseRoot `
                -NasReleaseRoot $nasRoot `
                -TrustedKeysPath $trustedKeysPath `
                -Force `
                -AllowRollback `
                -RepoRoot $RepoRoot `
                -AllowTestRoot | Out-Null
        } -Pattern "readiness failed|failed signed readiness" -Message "AllowRollback bypassed authentication of a tampered legacy-like stable channel."
    }
    finally { [IO.File]::WriteAllBytes($nasStableChannelPath, $stableChannelBytesBeforeTamper) }

    $fullRootReadiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $nasRoot `
        -TrustedKeysPath $trustedKeysPath `
        -AllowTestSigningIdentity `
        -RepoRoot $RepoRoot `
        -ReportOnly
    Assert-True (-not [bool]$fullRootReadiness.success) "Full root readiness should still report legacy source artifacts."

    $workflowPath = Join-Path $RepoRoot ".github\workflows\signed-source-free-cd.yml"
    $workflowText = Get-Content -Raw -LiteralPath $workflowPath
    Assert-True ($workflowText -match 'revagent-release-signing') "CD workflow should use a protected signing environment."
    Assert-True ($workflowText -match 'revagent-production-publish') "CD workflow should use a separate protected publish environment."
    Assert-True ($workflowText -match 'RUNNER_WORKSPACE' -and $workflowText -match 'RUNNER_TEMP' -and $workflowText -match 'artifact-id' -and $workflowText -match 'artifact-digest') "CD workflow should use an identity/digest-bound artifact handoff between isolated jobs."
    Assert-True ($workflowText -match 'actions/upload-artifact@v7' -and $workflowText -match 'actions/download-artifact@v8' -and $workflowText -match 'artifact-ids:') "CD workflow should transfer only the exact uploaded artifact id into the publish job."
    Assert-True ($workflowText -match 'push:\s*\r?\n\s*branches:\s*\r?\n\s*-\s*main') "CD workflow should run automatically after main is updated."
    Assert-True ($workflowText -match 'publish_to_nas' -and $workflowText -match 'publish_to_pilot') "CD workflow should keep stable and pilot NAS publish as mutually exclusive explicit manual inputs."
    Assert-True ($workflowText -match 'allow_rollback' -and $workflowText -match 'REVAGENT_CD_ALLOW_ROLLBACK' -and $workflowText -match '\$publishArgs\["AllowRollback"\] = \$true') "CD workflow must expose explicit manual rollback/legacy bootstrap publish input."
    Assert-True ($workflowText -match 'release_identity' -and $workflowText -match "default: 'revAgent'" -and $workflowText -match "revit-mcp-skill" -and $workflowText -match "REVAGENT_CD_RELEASE_IDENTITY") "CD workflow must default to revAgent release identity while keeping an explicit legacy recovery option."
    Assert-True ($workflowText -match 'ReleaseAppId = \$releaseIdentity' -and $workflowText -match 'ReleasePackageBaseName = \$releaseIdentity') "CD workflow must pass the selected release identity to both app id and package base name producers."
    Assert-True ($workflowText -notmatch 'REVAGENT_NAS_COMPAT_RELEASE_ROOTS' -and $workflowText -match 'Publishing signed release to NAS root: \$nasReleaseRoot' -and $workflowText -notmatch 'foreach \(\$nasReleaseRoot in \$releaseRoots\)') "CD workflow must publish production stable only to the canonical NAS root after compatibility-root retirement."
    $rawPublishJobCondition = Get-WorkflowJobIfCondition -Path $workflowPath -JobName "publish-to-nas"
    Assert-True (-not [string]::IsNullOrWhiteSpace($rawPublishJobCondition)) "CD workflow parser must find the publish-to-nas job if condition."
    $publishJobCondition = ConvertTo-GithubWorkflowIfExpression -Expression $rawPublishJobCondition
    Assert-Equal $publishJobCondition "github.event_name == 'workflow_dispatch' && (inputs.publish_to_nas || inputs.publish_to_pilot)" "CD workflow must not auto-publish either signed channel on every push to main."
    Assert-True ($workflowText -match 'REVAGENT_CD_VERSION' -and $workflowText -match 'REVAGENT_CD_RELEASE_SEQUENCE') "CD workflow should route optional manual inputs through push-safe environment variables."
    Assert-True ($workflowText -match 'https://nodejs\.org/dist/v24\.14\.1/node-v24\.14\.1-x64\.msi' -and $workflowText -match 'FD8BA3E8262738959CAD50E6F6E71D689EAB7DD09FC7231B51D78ABE7852D4EC' -and $workflowText -match '32387072') 'CD workflow must download and pin the exact official Node.js MSI hash and size.'
    Assert-True ($workflowText -match 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US' -and $workflowText -match 'Get-AuthenticodeSignature' -and $workflowText -match 'SignatureStatus\]::Valid') 'CD workflow must validate the exact OpenJS Authenticode identity.'
    Assert-True ($workflowText -match 'REVAGENT_NODE_MSI_PATH' -and $workflowText -match 'NodeMsiPath = \$env:REVAGENT_NODE_MSI_PATH') 'CD workflow must pass only its verified Node.js MSI path into the producer.'
    Assert-True ($workflowText -match 'Build IT-only supervised prestage kit' -and $workflowText -match 'New-RevAgentBootstrapPrestageKit\.ps1' -and $workflowText -match 'revagent-supervised-prestage-kit-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}' -and $workflowText -match 'kit_sha256') 'CD workflow must build, identify, and upload the supervised prestage kit as a separate artifact.'
    Assert-True ($workflowText -match '(?s)Upload short-lived IT supervised prestage kit.*?if:\s*\$\{\{ github\.event_name == ''workflow_dispatch'' \}\}.*?retention-days:\s*1.*?compression-level:\s*0.*?overwrite:\s*false' -and $workflowText -match '\$kitRoot = Join-Path \$env:RUNNER_TEMP' -and $workflowText -match 'REVAGENT_PRESTAGE_KIT_ROOT=\$kitRoot') 'Supervised prestage kit artifact must be explicit-dispatch-only, short-lived, immutable, and rooted outside the signed release tree.'
    Assert-True ($workflowText -notmatch 'prestage_kit_artifact_(id|digest)' -and $workflowText -notmatch 'needs\.build-signed-release\.outputs\.prestage') 'Supervised prestage kit identity must not be linked into the signed-release publish job.'

    $producerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\invoke-signed-source-free-cd.ps1")
    $publisherText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1")
    $readinessText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts\check-signed-stable-readiness.ps1')
    $legacyPublisherText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1")
    $bootstrapEvidenceText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\New-RevAgentBootstrapPrestageEvidence.ps1")
    $prestageKitBuilderText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts\New-RevAgentBootstrapPrestageKit.ps1')
    $releaseSnapshotText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'installer\lib\RevAgent.ReleaseSnapshot.psm1')
    $retiredPromoterText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\promote-nas-release.ps1")
    $claudeWorkflowText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot ".github\workflows\claude-review.yml")
    $stableLauncherSourceText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'installer\nas\revAgent Updater STABLE.cmd')
    $stableRefreshCmdSourceText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'installer\nas\Refresh-revAgent-LocalBootstrap-STABLE.cmd')
    $productionSigningKeyId = 'revagent-prod-rsa-2026q3'
    $productionSigningFingerprint = '32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33'
    Assert-True ($producerText -match 'test-ci\.ps1' -and $producerText -match 'RequireSigning') "CD producer should run engineering gates and require signing."
    Assert-True ($producerText -match '(?s)\$sourceStream\.Length\s+-lt\s+1.*?\$sourceStream\.Length\s+-gt\s+65536.*?New-Object byte\[\]' -and $producerText -notmatch '\[IO\.File\]::ReadAllBytes\(\$Path\)') 'CD producer must enforce the trusted-key size bound before allocating its byte snapshot.'
    Assert-True ($publisherText -match '(?s)\$trustedKeysStream\.Length\s+-lt\s+1.*?\$trustedKeysStream\.Length\s+-gt\s+65536.*?New-Object byte\[\].*?\$validation\s*=\s*&\s*\$validator\s+-Bytes\s+\$trustedKeysBytes' -and $publisherText -notmatch '\[IO\.File\]::ReadAllBytes\(\$Path\)') 'NAS publisher must enforce the trusted-key size bound before allocating and validating its byte snapshot.'
    Assert-True ($releaseSnapshotText -match '(?s)\$trustedKeysStream\.Length\s+-lt\s+1.*?\$trustedKeysStream\.Length\s+-gt\s+65536.*?New-Object byte\[\]' -and $releaseSnapshotText -notmatch '\[IO\.File\]::ReadAllBytes\(\$TrustedKeysPath\)') 'Release snapshot trust validation must enforce the trusted-key size bound before allocating its byte snapshot.'
    Assert-True ($releaseSnapshotText -match '\$trustedKeysSha256\s*=\s*Get-RevAgentSnapshotSha256Bytes\s+-Bytes\s+\$trustedKeysBytes' -and $releaseSnapshotText -match 'trustedKeysSha256\s*=\s*\$trustedKeysSha256' -and $releaseSnapshotText -notmatch 'trustedKeysSha256\s*=\s*Get-RevAgentSnapshotFileSha256\s+-Path\s+\$TrustedKeysPath') 'Release snapshot must bind its returned trusted-key SHA to the exact held byte snapshot that was parsed and validated, without reopening the pathname.'
    Assert-True ($prestageKitBuilderText -match "'IT-Prestage-revAgent\.cmd'" -and $prestageKitBuilderText -match "'scripts/Invoke-RevAgentSupervisedPrestage\.ps1'" -and $prestageKitBuilderText -match "'scripts/New-RevAgentBootstrapPrestageEvidence\.ps1'" -and $prestageKitBuilderText -match "'installer/lib/RevAgent\.DistributionIntegrity\.psm1'" -and $prestageKitBuilderText -match "'config/release-trusted-keys\.json'" -and $prestageKitBuilderText -match 'FileMode\]::CreateNew' -and $prestageKitBuilderText -match '1980, 1, 1' -and $prestageKitBuilderText -match 'GetLinkCount' -and $prestageKitBuilderText -match 'RUNNER_TEMP' -and $prestageKitBuilderText -notmatch 'RUNNER_WORKSPACE' -and $prestageKitBuilderText -notmatch 'SigningPrivateKeyPath') 'Supervised prestage kit builder must enforce its deterministic exact public allowlist, TEMP-only output, no-link policy, and no-private-key input.'
    foreach ($forbiddenKitSurfaceName in @(
        'IT-Prestage-revAgent.cmd',
        'Invoke-RevAgentSupervisedPrestage.ps1',
        'New-RevAgentBootstrapPrestageKit.ps1',
        'revAgent-supervised-prestage-kit'
    )) {
        foreach ($releasePublisherSurface in @($producerText, $publisherText, $legacyPublisherText)) {
            Assert-True ($releasePublisherSurface -notmatch [regex]::Escape($forbiddenKitSurfaceName)) "IT-only supervised prestage kit surface leaked into a signed-release/NAS publisher allowlist: $forbiddenKitSurfaceName"
        }
    }
    Assert-True ($producerText -match 'NodeMsiPath is required for production signed source-free CD' -and $producerText -match '\$publishArgs\["NodeMsiPath"\] = \$nodeMsiFullPath') 'CD producer must require and forward one explicit Node.js MSI asset in production.'
    foreach ($productionPinSurface in @($producerText, $publisherText, $legacyPublisherText, $bootstrapEvidenceText)) {
        Assert-True ($productionPinSurface -match [regex]::Escape($productionSigningKeyId) -and $productionPinSurface -match [regex]::Escape($productionSigningFingerprint)) "Every production signing/prestage surface must pin the exact production key id and fingerprint."
    }
    foreach ($rotationAwareSurface in @($producerText, $legacyPublisherText, $bootstrapEvidenceText)) {
        Assert-True ($rotationAwareSurface -match 'Count\s+-gt\s+2' -and $rotationAwareSurface -match '(?:rotation|transition) key must be (?:strictly )?later') 'Production producer, package publisher, and prestage evidence must permit only q3 plus one later rotation key.'
    }
    Assert-True ($publisherText -match 'Assert-RevAgentBootstrapTrustedKeySet' -and $publisherText -match 'bounded two-key transition contract') 'NAS publisher must delegate production rotation validation to the bootstrap-trust two-key contract.'
    Assert-True ($producerText -match 'CdStagingNative' -and $producerText -match 'CreateDirectoryRelativeNoDelete' -and $producerText -match 'StagingRootGuard' -and $legacyPublisherText -match 'Assert-RevAgentAtomicStagingGuard') "CD generation must atomically create and hold one exact local staging leaf and reject unguarded production generation."
    Assert-True ($publisherText -match '\[ValidateSet\("stable", "pilot"\)\]' -and $publisherText -match 'DESKTOP-OKNV128' -and $publisherText -match 'NET01' -and $publisherText -match 'stable versioned release' -and $publisherText -match 'Set-RevAgentStableLauncherExact' -and $publisherText -match 'Set-RevAgentStableBootstrapToolsExact' -and $publisherText -match 'TestUseProductionPublishedSurface' -and $publisherText -match 'transactional-exact-handles') "Production stable publish must use handle-bound create-new release copy, exact-manage the complete published surface transactionally, expose a bounded production-path fixture mode, and keep the pilot cohort restricted."
    Assert-True ($publisherText -match 'config\\release-trusted-keys\.json' -and $publisherText -match 'Install-revAgent-Updater-GUI\.cmd' -and $publisherText -match 'Install-Revit-MCP-Updater-GUI\.cmd' -and $publisherText -match 'Install-revAgent-Updater\.cmd' -and $publisherText -match 'Install-Revit-MCP-Updater\.cmd') 'Stable publisher must exact-manage verified trusted keys and all four legacy compatibility stubs in tools and the NAS root.'
    Assert-True ($readinessText -match 'required-canonical-production' -and $publisherText -match '\$stableSurfaceRepairBaseline\s*=\s*\[string\]::Equals\(\$Channel, ''stable''' -and $publisherText -match '-SkipPublishedSurface:\$stableSurfaceRepairBaseline') 'Canonical readiness must auto-require the published surface, with a narrowly scoped publisher exception only for the authenticated stable baseline being repaired.'
    Assert-True ($stableLauncherSourceText -match 'if not exist "%BOOTSTRAP%"' -and $stableLauncherSourceText -match 'VerificationOnly >nul 2>nul' -and ([regex]::Matches($stableLauncherSourceText, [regex]::Escape('call "%REFRESH%"'))).Count -eq 2 -and $stableLauncherSourceText -match 'if "%REVAGENT_FAILURE_CODE%"=="84" goto stable_signing_trust_unavailable' -and $stableLauncherSourceText -match 'IT-prestaged revAgent machine trust core is missing or unhealthy') "Production stable launcher template must route missing and stale bootstraps through the broker refresh boundary, preserve exact exit 84 IT-prestage guidance, and allow only an already-current verified bootstrap to reach normal GUI launch."
    Assert-True ($stableLauncherSourceText -match [regex]::Escape('setlocal EnableExtensions EnableDelayedExpansion') -and ([regex]::Matches($stableLauncherSourceText, [regex]::Escape('set "REFRESH_EXIT=!ERRORLEVEL!"'))).Count -eq 2 -and ([regex]::Matches($stableLauncherSourceText, [regex]::Escape('exit /b !REFRESH_EXIT!'))).Count -eq 2) 'Published STABLE launcher template must preserve refresh exit codes safely across both parenthesized call paths.'
    foreach ($publishedExitCode in @(80, 81, 84)) {
        Assert-True ($stableLauncherSourceText -match [regex]::Escape(('if "%REVAGENT_FAILURE_CODE%"=="{0}"' -f $publishedExitCode)) -and $stableRefreshCmdSourceText -match [regex]::Escape(('if "%REFRESH_EXIT%"=="{0}"' -f $publishedExitCode))) "Published launcher surface lost exact exit-code $publishedExitCode routing."
    }
    Assert-True ($stableLauncherSourceText -notmatch 'REVAGENT_FAILURE_CODE%"=="(?:79|82)"' -and $stableRefreshCmdSourceText -notmatch 'REFRESH_EXIT%"=="(?:79|82)"') 'Broker-only refresh transport must not retain unreachable UAC-decline/LUA exit routing.'
    Assert-True ($publisherText -match 'Get-RevAgentNasPublishMutexName' -and $publisherText -match '\.WaitOne\(0, \$false\)' -and $publisherText -match 'Enter-RevAgentNasPublishLease' -and $publisherText -match 'ReleaseMutex' -and $publisherText -match 'publishLease\.stream\.Dispose') "NAS publisher must hold and release both its named mutex and NAS lease."
    Assert-True ($publisherText -match 'Get-RevAgentSignedStableIdentity' -and $publisherText -match 'AllowLegacyMissingNodeMsi' -and ([regex]::Matches($publisherText, 'AllowLegacyMissingNodeMsi').Count -eq 1) -and $publisherText -match 'never passed to candidate/source readiness') 'Only an already-active signed destination channel baseline may use the transitional missing-sidecar readiness allowance.'
    Assert-True ($publisherText -match '\$candidateReleaseSequence\s*=\s*ConvertTo-RevAgentInt64OrZero -Value \$sourceArtifactIdentity\.releaseSequence' -and $publisherText -match '\$candidateReleaseSequence -ne \$readinessReleaseSequence') "NAS publisher anti-rollback guard must bind readiness releaseSequence to the post-readiness signed source identity."
    Assert-True ($publisherText -match '\[switch\]\$AllowRollback' -and $publisherText -match 'currentStableReleaseSequence' -and $publisherText -match 'current-sequence repair') "NAS publisher must block signed stable releaseSequence rollback or equal-sequence repair unless explicitly allowed."
    Assert-True ($publisherText -match 'candidate releaseSequence could not be determined as a positive integer') "NAS publisher must report an unreadable candidate releaseSequence separately from rollback protection."
    Assert-True ($publisherText -match 'current stable releaseSequence could not be determined') "NAS publisher must fail closed when the existing stable releaseSequence is unreadable."
    Assert-True ($publisherText -match 'never bypasses signature/readiness validation' -and $publisherText -match 'current stable releaseSequence could not be determined as a positive integer from the authenticated baseline') "NAS publisher must not let AllowRollback bypass authenticated stable-baseline validation."
    Assert-True ($publisherText -match 'CreateDirectoryRelativeNoDelete' -and $publisherText -match 'Copy-RevAgentDirectoryCreateNewGuarded' -and $publisherText -match 'Assert-RevAgentOwnedTreeIntact' -and $publisherText -match 'Restore-RevAgentStreamBytesByStableHandle') "Pilot payload/channel mutation must use handle-bound create-new copy, final invariants, and stable-handle rollback."
    Assert-True ($publisherText -match '\$null -ne \$TestAfterSourceRoutingReadHook[\s\S]{0,300}-not \$AllowTestRoot' -and $publisherText -match 'Locked source routing changed after the preliminary source read' -and $publisherText -match 'Locked source version does not bind the precomputed source/destination release directories') "Source routing double-swap hook must be test-root-only and locked channel bytes must bind every precomputed release route."
    Assert-True ($publisherText -match 'pilotStableReleaseBaseline' -and $publisherText -match 'pilotStableReleaseFinal' -and $publisherText -match 'activeStableReleaseUnchanged' -and $publisherText -match 'heldHandleInvariantsVerified') "Pilot publish must prove canonical stable pair, tools, and active stable release immutability."
    Assert-True ($publisherText -match 'transportTrust = "signed_local_snapshot"' -and $publisherText -match 'writerCapability\s*=\s*\$writerCapability' -and $publisherText -match 'provesIdentity\s*=\s*\$false' -and $publisherText -match 'ownerSidMatches' -and $publisherText -match 'createDeleteCanary') "NAS publisher must expose writer capability without claiming that the transport probe proves publisher identity."
    Assert-True ($publisherText -match 'function Assert-RevAgentTransportTreeLinkSafe' -and $publisherText -match 'hard-linked file' -and $publisherText -match 'unsafe filesystem link/reparse') "NAS publisher must fail closed on transport reparse links and hardlinks."
    Assert-True ($publisherText -notmatch 'Mode\s+Unseal' -and $publisherText -notmatch 'Mode\s+Seal' -and $publisherText -notmatch 'ConfirmPublisherWrite') "NAS publisher must not mutate DACLs as part of signed transport publication."
    Assert-True ($publisherText -match '\[switch\]\$IncludeAclTelemetry' -and $publisherText -match 'not_requested_optional' -and $publisherText -match 'Mode Preview' -and $publisherText -match 'acl_diagnostic_unavailable' -and $publisherText -match 'mutationPerformed = \$false') "NAS publisher must keep ACL inspection opt-in and non-mutating."
    Assert-True ($retiredPromoterText -match 'Unsigned direct channel promotion is disabled' -and $retiredPromoterText -notmatch 'Set-Content|Write-JsonFile|WriteAllText') "Retired direct promoter must contain no unsigned channel writer dead code."
    Assert-True ($claudeWorkflowText -match 'github\.event\.pull_request\.draft == false' -and $claudeWorkflowText -match 'github\.event\.pull_request\.head\.repo\.full_name == github\.repository') "Claude review workflow must visibly skip draft and fork PRs instead of silently consuming review quota or no-oping."
}
finally {
    $rsa.Dispose()
    if ($null -ne $futureRsa) { $futureRsa.Dispose() }
    if ($null -ne $thirdRsa) { $thirdRsa.Dispose() }
    if ($env:REVAGENT_KEEP_SIGNED_CD_TEST_TEMP -eq '1') {
        Write-Warning "Keeping signed CD test fixture for diagnosis: $tempRoot"
    }
    elseif (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Signed source-free CD tests passed." -ForegroundColor Green
