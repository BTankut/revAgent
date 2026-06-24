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
Import-Module (Join-Path $RepoRoot "installer\lib\RevitMcp.DistributionIntegrity.psm1") -Force

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

Write-Host "Test signed source-free CD producer and NAS publish wrapper"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-signed-source-free-cd-test-" + [Guid]::NewGuid().ToString("N"))
$releaseRoot = Join-Path $tempRoot "release-root"
$nasRoot = Join-Path $tempRoot "nas-root"
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
        publicKeyFingerprint = Get-RevitMcpPublicKeyFingerprint -PublicKeyXml $publicKeyXml
        algorithm = "RS256"
    }
    $trustedKeysPath = Join-Path $secretRoot "release-trusted-keys.json"
    $trustedKeys | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $trustedKeysPath -Encoding UTF8

    $buildResult = & (Join-Path $RepoRoot "scripts\invoke-signed-source-free-cd.ps1") `
        -ReleaseRoot $releaseRoot `
        -TrustedKeysPath $trustedKeysPath `
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

    $sourceChannelPath = Join-Path $releaseRoot "channels\stable.json"
    $sourceManifestPath = Join-Path $releaseRoot "releases\$version\manifest.json"
    $sourceChannel = Get-Content -Raw -LiteralPath $sourceChannelPath | ConvertFrom-Json
    $sourceManifest = Get-Content -Raw -LiteralPath $sourceManifestPath | ConvertFrom-Json
    Assert-True (-not [System.IO.Path]::IsPathRooted([string]$sourceChannel.packagePath)) "CD channel packagePath must be relative."
    Assert-True (-not [System.IO.Path]::IsPathRooted([string]$sourceChannel.manifestPath)) "CD channel manifestPath must be relative."
    Assert-Equal ([string]$sourceChannel.packagePath) ([string]$sourceManifest.package.path) "CD channel and manifest package paths must match."
    Assert-True (Test-Path -LiteralPath (Join-Path $releaseRoot "tools\config\release-trusted-keys.json") -PathType Leaf) "CD release root should carry public trusted keys in tools config."

    $legacyReleaseDir = Join-Path $nasRoot "releases\2026.05.01.legacy"
    New-Item -ItemType Directory -Path $legacyReleaseDir -Force | Out-Null
    "export const legacy = true;" | Set-Content -LiteralPath (Join-Path $legacyReleaseDir "legacy-source.ts") -Encoding UTF8

    $publishResult = & (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1") `
        -SourceReleaseRoot $releaseRoot `
        -NasReleaseRoot $nasRoot `
        -TrustedKeysPath $trustedKeysPath `
        -Force `
        -RepoRoot $RepoRoot
    Assert-True ([bool]$publishResult.success) "NAS publish wrapper should return success."
    Assert-Equal ([string]$publishResult.version) $version "NAS publish wrapper should report the published version."

    Assert-True (Test-Path -LiteralPath (Join-Path $nasRoot "channels\stable.json") -PathType Leaf) "NAS stable channel should exist after publish."
    Assert-True (Test-Path -LiteralPath (Join-Path $nasRoot "channels\stable.sig.json") -PathType Leaf) "NAS stable channel signature should exist after publish."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $nasRoot "channels\stable.candidate.json"))) "NAS candidate channel should be removed after publish."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $nasRoot "channels\stable.candidate.sig.json"))) "NAS candidate channel signature should be removed after publish."

    $nasReadiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $nasRoot `
        -TrustedKeysPath $trustedKeysPath `
        -ArtifactScanScope activeRelease `
        -RepoRoot $RepoRoot
    Assert-True ([bool]$nasReadiness.success) "Published NAS root should pass signed stable readiness."
    Assert-Equal ([string]$nasReadiness.artifactScanScope) "activeRelease" "NAS publish readiness should use the active release artifact scan scope."

    $nasStableChannelPath = Join-Path $nasRoot "channels\stable.json"
    $legacyStableChannel = Get-Content -Raw -LiteralPath $nasStableChannelPath | ConvertFrom-Json
    $legacyStableChannel.PSObject.Properties.Remove("releaseSequence")
    $legacyStableChannel | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $nasStableChannelPath -Encoding UTF8
    $legacyRepairPublishResult = & (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1") `
        -SourceReleaseRoot $releaseRoot `
        -NasReleaseRoot $nasRoot `
        -TrustedKeysPath $trustedKeysPath `
        -Force `
        -AllowRollback `
        -RepoRoot $RepoRoot
    Assert-True ([bool]$legacyRepairPublishResult.success) "NAS publisher should allow explicit -AllowRollback bootstrap over a legacy stable channel missing releaseSequence."
    $legacyRepairStableChannel = Get-Content -Raw -LiteralPath $nasStableChannelPath | ConvertFrom-Json
    Assert-Equal ([long]$legacyRepairStableChannel.releaseSequence) ([long]$releaseSequence) "Legacy stable repair publish should restore the signed releaseSequence."

    $fullRootReadiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $nasRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $RepoRoot `
        -ReportOnly
    Assert-True (-not [bool]$fullRootReadiness.success) "Full root readiness should still report legacy source artifacts."

    $workflowPath = Join-Path $RepoRoot ".github\workflows\signed-source-free-cd.yml"
    $workflowText = Get-Content -Raw -LiteralPath $workflowPath
    Assert-True ($workflowText -match 'revagent-release-signing') "CD workflow should use a protected signing environment."
    Assert-True ($workflowText -match 'revagent-production-publish') "CD workflow should use a separate protected publish environment."
    Assert-True ($workflowText -match 'RUNNER_WORKSPACE' -and $workflowText -match '_revagent_signed_cd' -and $workflowText -match 'release_root') "CD workflow should preserve the signed release root through local self-hosted runner staging."
    Assert-True ($workflowText -notmatch 'actions/upload-artifact' -and $workflowText -notmatch 'actions/download-artifact') "CD workflow should not depend on GitHub artifact storage quota for source-free release handoff."
    Assert-True ($workflowText -match 'push:\s*\r?\n\s*branches:\s*\r?\n\s*-\s*main') "CD workflow should run automatically after main is updated."
    Assert-True ($workflowText -match 'publish_to_nas') "CD workflow should keep NAS publish as an explicit manual dispatch input."
    Assert-True ($workflowText -match 'allow_rollback' -and $workflowText -match 'REVAGENT_CD_ALLOW_ROLLBACK' -and $workflowText -match '\$publishArgs\["AllowRollback"\] = \$true') "CD workflow must expose explicit manual rollback/legacy bootstrap publish input."
    $rawPublishJobCondition = Get-WorkflowJobIfCondition -Path $workflowPath -JobName "publish-to-nas"
    Assert-True (-not [string]::IsNullOrWhiteSpace($rawPublishJobCondition)) "CD workflow parser must find the publish-to-nas job if condition."
    $publishJobCondition = ConvertTo-GithubWorkflowIfExpression -Expression $rawPublishJobCondition
    Assert-Equal $publishJobCondition "github.event_name == 'workflow_dispatch' && inputs.publish_to_nas" "CD workflow must not auto-publish production NAS stable on every push to main."
    Assert-True ($workflowText -match 'REVAGENT_CD_VERSION' -and $workflowText -match 'REVAGENT_CD_RELEASE_SEQUENCE') "CD workflow should route optional manual inputs through push-safe environment variables."

    $producerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\invoke-signed-source-free-cd.ps1")
    $publisherText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1")
    Assert-True ($producerText -match 'test-ci\.ps1' -and $producerText -match 'RequireSigning') "CD producer should run engineering gates and require signing."
    Assert-True ($publisherText -match 'candidate\.json' -and $publisherText -match 'check-signed-stable-readiness\.ps1') "NAS publisher should validate a candidate channel before stable promotion."
    Assert-True ($publisherText -match '\[switch\]\$AllowRollback' -and $publisherText -match 'currentStableReleaseSequence' -and $publisherText -match 'current-sequence repair') "NAS publisher must block signed stable releaseSequence rollback or equal-sequence repair unless explicitly allowed."
    Assert-True ($publisherText -match 'candidate releaseSequence could not be determined as a positive integer') "NAS publisher must report an unreadable candidate releaseSequence separately from rollback protection."
    Assert-True ($publisherText -match 'current stable releaseSequence could not be determined') "NAS publisher must fail closed when the existing stable releaseSequence is unreadable."
    Assert-True ($publisherText -match 'missing_release_sequence' -and $publisherText -match 'legacy sequence 0 because -AllowRollback was supplied') "NAS publisher must make legacy current-stable bootstrap an explicit -AllowRollback path."
    Assert-True ($publisherText -match '\$cleanupPaths = @\(\$stableChannelTempPath, \$stableSignatureTempPath, \$candidateChannelPath, \$candidateSignaturePath\)') "NAS publisher must clean candidate channel artifacts even when stable promotion rolls back."
    Assert-True ($publisherText -match 'previous\.json' -and $publisherText -match 'previous\.sig\.json' -and $publisherText -match 'promotionStarted' -and $publisherText -match 'NAS stable signed release root failed readiness' -and $publisherText -match 'rollbackFailed' -and $publisherText -match 'Backup files kept') "NAS publisher must keep rollback files while promoting stable channel metadata and preserve them when rollback fails."
}
finally {
    $rsa.Dispose()
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Signed source-free CD tests passed." -ForegroundColor Green
