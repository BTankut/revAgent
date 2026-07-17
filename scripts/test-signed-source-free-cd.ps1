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

try {
    New-Item -ItemType Directory -Path $secretRoot -Force | Out-Null
    $privateKeyPath = Join-Path $secretRoot "release-signing-private.xml"
    $rsa.ToXmlString($true) | Set-Content -LiteralPath $privateKeyPath -Encoding UTF8
    $publicKeyXml = $rsa.ToXmlString($false)
    $trustedKeys = @{ trustedKeys = @{} }
    $trustedKeys.trustedKeys[$keyId] = [pscustomobject][ordered]@{
        publicKeyXml = $publicKeyXml
        publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
        algorithm = "RS256"
    }
    $trustedKeysPath = Join-Path $secretRoot "release-trusted-keys.json"
    $trustedKeys | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $trustedKeysPath -Encoding UTF8
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
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\config\release-trusted-keys.json") -PathType Leaf) "CD release root should carry public trusted keys in tools config."
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
                "installer/lib/RevAgent.LocalBootstrap.psm1",
                "installer/lib/RevAgent.Permissions.psm1"
            )) {
            Assert-Equal @($sourceArchive.Entries | Where-Object { [string]::Equals($_.FullName.Replace("\", "/"), $entryName, [StringComparison]::OrdinalIgnoreCase) }).Count 1 "Signed user pack entry '$entryName' must exist exactly once."
        }
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

    foreach ($componentKey in @("localBootstrapInstaller", "bootstrapPrestageEvidenceTool", "bootstrapPrestageEvidenceSchema", "bootstrapPrestageEvidenceExample", "localBootstrapLauncher", "localBootstrap", "installerLibLocalBootstrap", "installerLibPermissions")) {
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
        -AllowTestRoot
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
    Assert-Equal @(Get-ChildItem -LiteralPath (Join-Path $nasRoot "tools") -Recurse -File -Filter "*.cmd").Count 0 "NAS publish must not restore unsigned CMD aliases into production tools."

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
        -AllowTestSigningIdentity `
        -RepoRoot $RepoRoot
    Assert-True ([bool]$nasReadiness.success) "Published NAS root should pass signed stable readiness."
    Assert-Equal ([string]$nasReadiness.artifactScanScope) "activeRelease" "NAS publish readiness should use the active release artifact scan scope."

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
    $pilotInboxRoot = Join-Path $tempRoot 'pilot-inbox'
    New-Item -ItemType Directory -Path $pilotInboxRoot -Force | Out-Null
    $inboxProbe = [pscustomobject]@{ called = $false }
    $inboxHook = { param($path, $source); $inboxProbe.called = $true }.GetNewClosure()
    $nodeMsiHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $pilotNodeMsiSidecar).Hash
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
            & (Join-Path $RepoRoot 'scripts\publish-signed-source-free-release-to-nas.ps1') -SourceReleaseRoot $releaseRoot -NasReleaseRoot $nasRoot -TrustedKeysPath $trustedKeysPath -Channel stable -Force -AllowRollback -RepoRoot $RepoRoot -AllowTestRoot -TestAfterSignatureWriteHook $stableRollbackHook | Out-Null
        } -Pattern 'injected signature rollback fixture' -Message 'Same-handle rollback fixture did not fail at the injected boundary.'
    }
    finally { if (Test-Path -LiteralPath $stableRollbackAlias) { Remove-Item -LiteralPath $stableRollbackAlias -Force } }
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($nasStableChannelPath), [byte[]]$stableChannelBytes) -and [Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($nasStableSignaturePath), [byte[]]$stableSignatureBytes)) 'Stable same-handle rollback did not restore exact baseline bytes after a hardlink anomaly.'
    Write-Host '  same-handle hardlink rollback: PASS'

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

    $producerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\invoke-signed-source-free-cd.ps1")
    $publisherText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1")
    $legacyPublisherText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1")
    $bootstrapEvidenceText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\New-RevAgentBootstrapPrestageEvidence.ps1")
    $retiredPromoterText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\promote-nas-release.ps1")
    $claudeWorkflowText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot ".github\workflows\claude-review.yml")
    $productionSigningKeyId = 'revagent-prod-rsa-2026q3'
    $productionSigningFingerprint = '32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33'
    Assert-True ($producerText -match 'test-ci\.ps1' -and $producerText -match 'RequireSigning') "CD producer should run engineering gates and require signing."
    Assert-True ($producerText -match 'NodeMsiPath is required for production signed source-free CD' -and $producerText -match '\$publishArgs\["NodeMsiPath"\] = \$nodeMsiFullPath') 'CD producer must require and forward one explicit Node.js MSI asset in production.'
    foreach ($productionPinSurface in @($producerText, $publisherText, $legacyPublisherText, $bootstrapEvidenceText)) {
        Assert-True ($productionPinSurface -match [regex]::Escape($productionSigningKeyId) -and $productionPinSurface -match [regex]::Escape($productionSigningFingerprint)) "Every production signing/prestage surface must pin the exact production key id and fingerprint."
    }
    Assert-True ($producerText -match 'trustedProperties\.Count -ne 1' -and $publisherText -match 'properties\.Count -ne 1' -and $legacyPublisherText -match 'properties\.Count -ne 1' -and $bootstrapEvidenceText -match 'trustedKeyProperties\.Count -ne 1') "Production producer, publishers, and prestage evidence must reject multi-key trusted-key documents."
    Assert-True ($producerText -match 'CdStagingNative' -and $producerText -match 'CreateDirectoryRelativeNoDelete' -and $producerText -match 'StagingRootGuard' -and $legacyPublisherText -match 'Assert-RevAgentAtomicStagingGuard') "CD generation must atomically create and hold one exact local staging leaf and reject unguarded production generation."
    Assert-True ($publisherText -match '\[ValidateSet\("stable", "pilot"\)\]' -and $publisherText -match 'DESKTOP-OKNV128' -and $publisherText -match 'NET01' -and $publisherText -match 'stable versioned release' -and $publisherText -match 'Set-RevAgentStableLauncherExact' -and $publisherText -match 'sharedToolsTreeReplaced = \[bool\]\$AllowTestRoot') "Production stable publish must use handle-bound create-new release copy, repair only the stable launcher through an exact handle, and keep the pilot cohort restricted."
    Assert-True ($publisherText -match 'Refresh-revAgent-LocalBootstrap-STABLE\.cmd' -and $publisherText -match 'VerificationOnly >nul 2>nul' -and $publisherText -match 'call "%REFRESH%"' -and $publisherText -match 'stable bootstrap refresh completed') "Production stable launcher template must auto-refresh stale protected local bootstraps instead of failing silently or requiring a separate manual refresh."
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
    if ($env:REVAGENT_KEEP_SIGNED_CD_TEST_TEMP -eq '1') {
        Write-Warning "Keeping signed CD test fixture for diagnosis: $tempRoot"
    }
    elseif (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Signed source-free CD tests passed." -ForegroundColor Green
