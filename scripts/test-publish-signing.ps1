<#
.SYNOPSIS
    Verify optional publish-path detached signature generation.

.DESCRIPTION
    This test runs publish-nas-release.ps1 against a temporary release root with
    an ephemeral RSA private key. It does not publish to NAS, does not use a
    production signing key, and cleans up all temporary signing material.
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

function New-TestRsaProvider {
    $cspParameters = [System.Security.Cryptography.CspParameters]::new(24)
    $cspParameters.Flags = [System.Security.Cryptography.CspProviderFlags]::CreateEphemeralKey
    return [System.Security.Cryptography.RSACryptoServiceProvider]::new(2048, $cspParameters)
}

Write-Host "Test publish-path detached signing"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-publish-signing-test-" + [Guid]::NewGuid().ToString("N"))
$releaseRoot = Join-Path $tempRoot "release-root"
$secretRoot = Join-Path $tempRoot "secrets"
$version = "2026.06.22.1-signing-test"
$keyId = "test-rsa-2026"
$releaseSequence = 1001
$minimumAcceptedReleaseSequence = 1000
$rsa = New-TestRsaProvider

try {
    New-Item -ItemType Directory -Path $secretRoot -Force | Out-Null
    $privateKeyPath = Join-Path $secretRoot "release-signing-private.xml"
    $privateKeyXml = $rsa.ToXmlString($true)
    $privateKeyXml | Set-Content -LiteralPath $privateKeyPath -Encoding UTF8
    $publicKeyXml = $rsa.ToXmlString($false)
    $trustedKeys = @{}
    $trustedKeys[$keyId] = [pscustomobject][ordered]@{
        publicKeyXml = $publicKeyXml
        publicKeyFingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
        algorithm = "RS256"
    }
    $trustedKeysPath = Join-Path $secretRoot "release-trusted-keys.json"
    @{ trustedKeys = $trustedKeys } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $trustedKeysPath -Encoding UTF8
    $nodeMsiPath = Join-Path $tempRoot 'node-v24.14.1-x64.msi'
    [IO.File]::WriteAllBytes($nodeMsiPath, [Text.Encoding]::UTF8.GetBytes('revAgent test-only Node MSI fixture'))
    $nodeMsiHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeMsiPath).Hash
    $nodeMsiSize = (Get-Item -LiteralPath $nodeMsiPath).Length

    $publishOutput = & (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1") `
        -ReleaseRoot $releaseRoot `
        -Version $version `
        -AllowDirty `
        -Force `
        -SigningPrivateKeyPath $privateKeyPath `
        -SigningKeyId $keyId `
        -AllowTestSigningIdentity `
        -ReleaseSequence $releaseSequence `
        -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence `
        -NodeMsiPath $nodeMsiPath `
        -TrustedReleaseKeysPath $trustedKeysPath 6>&1 | Out-String

    Assert-True ($publishOutput -match "Release signing: enabled for keyId '$keyId'") "Publish output should report signing by keyId only."
    Assert-True ($publishOutput -match "Release sequence: $releaseSequence") "Publish output should report the signed release sequence."
    Assert-True (-not ($publishOutput -match [regex]::Escape($privateKeyPath))) "Publish output must not leak the private signing key path."

    $manifestPath = Join-Path $releaseRoot (Join-Path "releases" (Join-Path $version "manifest.json"))
    $manifestSignaturePath = Join-Path $releaseRoot (Join-Path "releases" (Join-Path $version "manifest.sig.json"))
    $channelPath = Join-Path $releaseRoot "channels\stable.json"
    $channelSignaturePath = Join-Path $releaseRoot "channels\stable.sig.json"

    foreach ($path in @($manifestPath, $manifestSignaturePath, $channelPath, $channelSignaturePath)) {
        Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Expected publish artifact was not written: $path"
    }

    $manifestVerification = Test-RevAgentDetachedJsonSignatureFile `
        -ContentPath $manifestPath `
        -SignaturePath $manifestSignaturePath `
        -TrustedKeys $trustedKeys `
        -AllowedSignedObjects @("release-manifest")
    Assert-True $manifestVerification.success "Published release manifest signature should verify."
    Assert-Equal $manifestVerification.signedObject "release-manifest" "Manifest signature should use the release-manifest signedObject."

    $channelVerification = Test-RevAgentDetachedJsonSignatureFile `
        -ContentPath $channelPath `
        -SignaturePath $channelSignaturePath `
        -TrustedKeys $trustedKeys `
        -AllowedSignedObjects @("channel")
    Assert-True $channelVerification.success "Published channel signature should verify."
    Assert-Equal $channelVerification.signedObject "channel" "Channel signature should use the channel signedObject."

    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $channel = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json
    $manifestSignature = Get-Content -Raw -LiteralPath $manifestSignaturePath | ConvertFrom-Json
    $channelSignature = Get-Content -Raw -LiteralPath $channelSignaturePath | ConvertFrom-Json
    Assert-Equal ([string]$manifest.app) "revAgent" "Default publish must use the revAgent release app id after the compatibility switch."
    Assert-Equal ([string]$channel.app) "revAgent" "Default channel publish must use the revAgent release app id after the compatibility switch."
    Assert-Equal ([string]$manifestSignature.app) "revAgent" "Default manifest signature envelope must use the revAgent release app id."
    Assert-Equal ([string]$channelSignature.app) "revAgent" "Default channel signature envelope must use the revAgent release app id."
    Assert-Equal ([string]$manifest.package.fileName) ("revAgent-{0}.zip" -f $version) "Default publish must use the revAgent ZIP filename after the compatibility switch."
    Assert-True ([string]$manifest.package.path -match "revAgent-") "Default release manifest package path must use the revAgent ZIP base name."
    Assert-True ([string]$channel.packagePath -match "revAgent-") "Default channel package path must use the revAgent ZIP base name."
    Assert-True (-not [System.IO.Path]::IsPathRooted([string]$channel.manifestPath)) "Published channel manifestPath should be relative so signed artifacts can move from CD staging to NAS."
    Assert-True (-not [System.IO.Path]::IsPathRooted([string]$channel.packagePath)) "Published channel packagePath should be relative so signed artifacts can move from CD staging to NAS."
    Assert-Equal ([string]$channel.packagePath) ([string]$manifest.package.path) "Channel and manifest package paths should stay byte-identical for signature consistency."
    Assert-Equal ([long]$manifest.releaseSequence) ([long]$releaseSequence) "Published manifest must include the signed release sequence."
    Assert-Equal ([long]$channel.releaseSequence) ([long]$releaseSequence) "Published channel must include the signed release sequence."
    Assert-Equal ([long]$manifest.minimumAcceptedReleaseSequence) ([long]$minimumAcceptedReleaseSequence) "Published manifest must include the minimum accepted release sequence."
    Assert-Equal ([long]$channel.minimumAcceptedReleaseSequence) ([long]$minimumAcceptedReleaseSequence) "Published channel must include the minimum accepted release sequence."
    Assert-Equal ([string]$manifest.externalDependencies.nodeMsi.relativePath) 'external\node-v24.14.1-x64.msi' 'Signed manifest must bind the versioned Node MSI sidecar path.'
    Assert-Equal ([string]$manifest.externalDependencies.nodeMsi.sha256) $nodeMsiHash 'Signed manifest must bind the test Node MSI SHA-256.'
    Assert-Equal ([long]$manifest.externalDependencies.nodeMsi.sizeBytes) ([long]$nodeMsiSize) 'Signed manifest must bind the test Node MSI size.'
    Assert-Equal ([string]$manifest.externalDependencies.nodeMsi.signerSubject) 'TEST-ONLY' 'Test signing must mark Node MSI signer evidence as test-only.'
    Assert-Equal ([string]$manifest.externalDependencies.nodeMsi.authenticodeStatus) 'TestBypass' 'Test signing must mark Node MSI Authenticode evidence as bypassed.'
    $releaseNodeMsiPath = Join-Path (Split-Path -Parent $manifestPath) ([string]$manifest.externalDependencies.nodeMsi.relativePath)
    Assert-True (Test-Path -LiteralPath $releaseNodeMsiPath -PathType Leaf) 'Versioned release-owned Node MSI sidecar was not published.'
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $releaseNodeMsiPath).Hash $nodeMsiHash 'Versioned Node MSI sidecar hash must match the signed manifest.'
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\config\release-trusted-keys.json") -PathType Leaf) "Public trusted release keys should be copied to NAS tools config when supplied."
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $releaseRoot 'tools\dependencies\node-v24.14.1-x64.msi')).Hash $nodeMsiHash 'Legacy stable-compatibility tools copy must derive from the same authenticated sidecar.'
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\dashboard\installer\install-dashboard-addon.ps1") -PathType Leaf) "Dashboard admin add-on installer should be published under tools\\addons."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\dashboard\installer\install-dashboard-tunnel.ps1") -PathType Leaf) "Dashboard tunnel installer should be published under tools\\addons."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\usage-intelligence\installer\install-usage-intelligence-addon.ps1") -PathType Leaf) "Usage-intelligence admin add-on installer should be published under tools\\addons."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\usage-intelligence\skills\revagent-usage-analyst\SKILL.md") -PathType Leaf) "Usage-intelligence analyst skill should be published under tools\\addons."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\dashboard\tests") -PathType Container)) "Dashboard add-on tests must not be published to tools\\addons."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\addons\usage-intelligence\tests") -PathType Container)) "Usage-intelligence add-on tests must not be published to tools\\addons."

    $aggregateVerification = Test-RevAgentReleaseDistributionIntegrity `
        -ChannelPath $channelPath `
        -Channel $channel `
        -ReleaseManifestPath $manifestPath `
        -ReleaseManifest $manifest `
        -TrustedKeys $trustedKeys `
        -Policy "enforce"
    Assert-True $aggregateVerification.success "Published signed release aggregate should pass enforce-mode verification."
    Assert-Equal $aggregateVerification.releaseSequence ([long]$releaseSequence) "Aggregate verification must preserve releaseSequence."

    Write-Host 'Test repeated signed generation reuses only an exact shared compatibility MSI'
    $toolsNodeMsiPath = Join-Path $releaseRoot 'tools\dependencies\node-v24.14.1-x64.msi'
    $toolsNodeMsiBytes = [IO.File]::ReadAllBytes($toolsNodeMsiPath)
    $toolsNodeMsiLastWriteTicks = (Get-Item -LiteralPath $toolsNodeMsiPath).LastWriteTimeUtc.Ticks
    $repeatVersion = '2026.06.22.1-repeat-signing-test'
    $repeatSequence = [long]($releaseSequence + 1)
    [void](& (Join-Path $RepoRoot 'installer\nas\publish-nas-release.ps1') `
            -ReleaseRoot $releaseRoot `
            -Version $repeatVersion `
            -AllowDirty `
            -Force `
            -SigningPrivateKeyPath $privateKeyPath `
            -SigningKeyId $keyId `
            -AllowTestSigningIdentity `
            -ReleaseSequence $repeatSequence `
            -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence `
            -NodeMsiPath $nodeMsiPath `
            -TrustedReleaseKeysPath $trustedKeysPath 6>&1 | Out-String)
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $toolsNodeMsiPath).Hash $nodeMsiHash 'Repeated signed generation changed the shared compatibility MSI hash.'
    Assert-Equal (Get-Item -LiteralPath $toolsNodeMsiPath).LastWriteTimeUtc.Ticks $toolsNodeMsiLastWriteTicks 'Repeated signed generation rewrote an already-identical shared compatibility MSI.'
    $repeatChannel = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json
    Assert-Equal ([string]$repeatChannel.version) $repeatVersion 'Repeated signed generation did not advance the channel after exact MSI reuse.'

    $mismatchedBytes = [Text.Encoding]::UTF8.GetBytes('MISMATCHED EXISTING NODE MSI MUST SURVIVE FAILURE')
    [IO.File]::WriteAllBytes($toolsNodeMsiPath, $mismatchedBytes)
    try {
        Assert-ThrowsLike -Action {
            [void](& (Join-Path $RepoRoot 'installer\nas\publish-nas-release.ps1') `
                    -ReleaseRoot $releaseRoot `
                    -Version '2026.06.22.1-mismatch-signing-test' `
                    -AllowDirty `
                    -Force `
                    -SigningPrivateKeyPath $privateKeyPath `
                    -SigningKeyId $keyId `
                    -AllowTestSigningIdentity `
                    -ReleaseSequence ([long]($repeatSequence + 1)) `
                    -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence `
                    -NodeMsiPath $nodeMsiPath `
                    -TrustedReleaseKeysPath $trustedKeysPath 6>&1 | Out-String)
        } -Pattern 'failed exact identity verification' -Message 'Repeated signed generation accepted a mismatched existing shared compatibility MSI.'
        Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($toolsNodeMsiPath), [byte[]]$mismatchedBytes)) 'Failed shared MSI reuse deleted or replaced the mismatched existing file.'
    }
    finally { [IO.File]::WriteAllBytes($toolsNodeMsiPath, $toolsNodeMsiBytes) }

    Write-Host 'Test failed create-new cleanup stays bound to the exact open file handle'
    $cleanupRaceRoot = Join-Path $tempRoot 'release-root-cleanup-race'
    $cleanupProbe = [pscustomobject]@{
        afterCreateCalled = $false
        beforeCleanupCalled = $false
        swapBlocked = $false
        replacementWritten = $false
        path = ''
    }
    $cleanupHook = {
        param([string]$phase, [string]$path)
        if ([string]::Equals($phase, 'after_create', [StringComparison]::Ordinal)) {
            $cleanupProbe.afterCreateCalled = $true
            $cleanupProbe.path = $path
            throw 'injected_node_msi_created_failure'
        }
        if ([string]::Equals($phase, 'before_cleanup', [StringComparison]::Ordinal)) {
            $cleanupProbe.beforeCleanupCalled = $true
            try {
                Remove-Item -LiteralPath $path -Force -ErrorAction Stop
                [IO.File]::WriteAllBytes($path, [Text.Encoding]::UTF8.GetBytes('FOREIGN PATHNAME REPLACEMENT'))
                $cleanupProbe.replacementWritten = $true
            }
            catch { $cleanupProbe.swapBlocked = $true }
        }
    }.GetNewClosure()
    Assert-ThrowsLike -Action {
        [void](& (Join-Path $RepoRoot 'installer\nas\publish-nas-release.ps1') `
                -ReleaseRoot $cleanupRaceRoot `
                -Version '2026.06.22.1-cleanup-race-test' `
                -AllowDirty `
                -Force `
                -SigningPrivateKeyPath $privateKeyPath `
                -SigningKeyId $keyId `
                -AllowTestSigningIdentity `
                -ReleaseSequence 1004 `
                -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence `
                -NodeMsiPath $nodeMsiPath `
                -TrustedReleaseKeysPath $trustedKeysPath `
                -TestNodeMsiCreatedFailureCleanupHook $cleanupHook 6>&1 | Out-String)
    } -Pattern 'injected_node_msi_created_failure' -Message 'Injected create-new failure did not propagate after exact-handle cleanup.'
    Assert-True ([bool]$cleanupProbe.afterCreateCalled -and [bool]$cleanupProbe.beforeCleanupCalled) 'Exact-handle cleanup regression did not cross both test seams.'
    Assert-True ([bool]$cleanupProbe.swapBlocked -and -not [bool]$cleanupProbe.replacementWritten) 'A pathname replacement succeeded while the exact created sidecar handle was held.'
    Assert-True (-not (Test-Path -LiteralPath ([string]$cleanupProbe.path))) 'Exact-handle delete-on-close did not remove the failed create-new sidecar.'

    $officialNodeMsiPath = Join-Path $RepoRoot 'installer\nas\dependencies\node-v24.14.1-x64.msi'
    if (Test-Path -LiteralPath $officialNodeMsiPath -PathType Leaf) {
        Write-Host 'Test real OpenJS MSI production Authenticode path with create-new handle held'
        $productionProbeRoot = Join-Path $tempRoot 'release-root-production-msi-probe'
        [void](& (Join-Path $RepoRoot 'installer\nas\publish-nas-release.ps1') `
                -ReleaseRoot $productionProbeRoot `
                -Version '2026.06.22.1-production-msi-probe' `
                -AllowDirty `
                -Force `
                -NoChannelUpdate `
                -NodeMsiPath $officialNodeMsiPath 6>&1 | Out-String)
        $productionProbeSidecar = Join-Path $productionProbeRoot 'releases\2026.06.22.1-production-msi-probe\external\node-v24.14.1-x64.msi'
        Assert-True (Test-Path -LiteralPath $productionProbeSidecar -PathType Leaf) 'Real production MSI probe did not create the versioned sidecar.'
        Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $productionProbeSidecar).Hash 'FD8BA3E8262738959CAD50E6F6E71D689EAB7DD09FC7231B51D78ABE7852D4EC' 'Real production MSI probe sidecar hash mismatch.'
    }
    else { Write-Host 'SKIP real OpenJS MSI production-path probe: ignored local MSI is not present.' }

    Write-Host "Test explicit legacy release app and package identity publish"
    $legacyReleaseRoot = Join-Path $tempRoot "release-root-legacy"
    $legacyVersion = "2026.06.22.2-legacy-app-test"
    $legacyReleaseSequence = 1002
    [void](& (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1") `
            -ReleaseRoot $legacyReleaseRoot `
            -Version $legacyVersion `
            -AllowDirty `
            -Force `
            -SigningPrivateKeyPath $privateKeyPath `
            -SigningKeyId $keyId `
            -AllowTestSigningIdentity `
            -ReleaseSequence $legacyReleaseSequence `
             -MinimumAcceptedReleaseSequence $minimumAcceptedReleaseSequence `
            -NodeMsiPath $nodeMsiPath `
            -TrustedReleaseKeysPath $trustedKeysPath `
            -ReleaseAppId "revit-mcp-skill" `
            -ReleasePackageBaseName "revit-mcp-skill" 6>&1 | Out-String)

    $legacyManifestPath = Join-Path $legacyReleaseRoot (Join-Path "releases" (Join-Path $legacyVersion "manifest.json"))
    $legacyManifestSignaturePath = Join-Path $legacyReleaseRoot (Join-Path "releases" (Join-Path $legacyVersion "manifest.sig.json"))
    $legacyChannelPath = Join-Path $legacyReleaseRoot "channels\stable.json"
    $legacyChannelSignaturePath = Join-Path $legacyReleaseRoot "channels\stable.sig.json"
    $legacyManifest = Get-Content -Raw -LiteralPath $legacyManifestPath | ConvertFrom-Json
    $legacyChannel = Get-Content -Raw -LiteralPath $legacyChannelPath | ConvertFrom-Json
    $legacyManifestSignature = Get-Content -Raw -LiteralPath $legacyManifestSignaturePath | ConvertFrom-Json
    $legacyChannelSignature = Get-Content -Raw -LiteralPath $legacyChannelSignaturePath | ConvertFrom-Json
    Assert-Equal ([string]$legacyManifest.app) "revit-mcp-skill" "Explicit legacy release app id must be written to the release manifest."
    Assert-Equal ([string]$legacyChannel.app) "revit-mcp-skill" "Explicit legacy release app id must be written to the channel manifest."
    Assert-Equal ([string]$legacyManifestSignature.app) "revit-mcp-skill" "Explicit legacy release app id must be written to the manifest signature envelope."
    Assert-Equal ([string]$legacyChannelSignature.app) "revit-mcp-skill" "Explicit legacy release app id must be written to the channel signature envelope."
    Assert-Equal ([string]$legacyManifest.package.fileName) ("revit-mcp-skill-{0}.zip" -f $legacyVersion) "Explicit legacy package base name must be written to the release manifest."
    Assert-True ([string]$legacyManifest.package.path -match "revit-mcp-skill-") "Explicit legacy package base name must be written to the manifest package path."
    Assert-True ([string]$legacyChannel.packagePath -match "revit-mcp-skill-") "Explicit legacy package base name must be written to the channel package path."
    Assert-True (Test-Path -LiteralPath (Join-Path $legacyReleaseRoot (Join-Path "releases" (Join-Path $legacyVersion ("revit-mcp-skill-{0}.zip" -f $legacyVersion)))) -PathType Leaf) "Explicit legacy package ZIP should be created with the legacy base name."
    $legacyAggregateVerification = Test-RevAgentReleaseDistributionIntegrity `
        -ChannelPath $legacyChannelPath `
        -Channel $legacyChannel `
        -ReleaseManifestPath $legacyManifestPath `
        -ReleaseManifest $legacyManifest `
        -TrustedKeys $trustedKeys `
        -Policy "enforce"
    Assert-True $legacyAggregateVerification.success "Explicit legacy release app id should pass enforce-mode verification."
    Assert-Equal $legacyAggregateVerification.releaseSequence ([long]$legacyReleaseSequence) "Legacy app id aggregate verification must preserve releaseSequence."

    $releaseFiles = Get-ChildItem -LiteralPath $releaseRoot -Recurse -File
    Assert-True (-not @($releaseFiles | Where-Object { $_.Name -eq "release-signing-private.xml" }).Count) "Private signing key must not be copied into release artifacts."
}
finally {
    $rsa.Dispose()
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Publish signing tests passed." -ForegroundColor Green
