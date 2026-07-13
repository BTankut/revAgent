<#
.SYNOPSIS
    Publish a prebuilt signed source-free release root to the production NAS layout.

.DESCRIPTION
    Copies an already signed and validated CD release root to a NAS release
    root without rebuilding or re-signing it. The source release metadata uses
    relative channel paths, so the detached signatures remain valid after the
    release root moves from CD staging to NAS.

    The script copies release files and tools first, validates a candidate
    channel manifest on the NAS root, then updates the stable channel file.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceReleaseRoot,

    [Parameter(Mandatory = $true)]
    [string]$NasReleaseRoot,

    [Parameter(Mandatory = $true)]
    [string]$TrustedKeysPath,

    [ValidateSet("stable")]
    [string]$Channel = "stable",

    [switch]$Force,

    # Authorizes deliberate signed rollback, equal releaseSequence repair
    # republish, and legacy current-stable bootstrap when the existing channel
    # predates releaseSequence. It does not bypass unreadable/invalid metadata.
    [switch]$AllowRollback,

    [switch]$OutputJson,

    [switch]$AllowTestRoot,

    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$SourceReleaseRoot = [System.IO.Path]::GetFullPath($SourceReleaseRoot)
$NasReleaseRoot = [System.IO.Path]::GetFullPath($NasReleaseRoot)
$TrustedKeysPath = [System.IO.Path]::GetFullPath($TrustedKeysPath)

function Get-RevAgentPathPrefix {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
}

function Assert-RevAgentChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = Get-RevAgentPathPrefix -Path $Root
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside the release root. Path '$fullPath' is not under '$Root'."
    }
}

function Invoke-RevAgentFileSystemRetry {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Label,
        [int]$MaxAttempts = 6
    )

    $delayMilliseconds = 250
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            & $Action
            return
        }
        catch {
            if ($attempt -ge $MaxAttempts) {
                throw
            }

            Write-Warning ("{0} failed on attempt {1}/{2}: {3}. Retrying." -f $Label, $attempt, $MaxAttempts, $_.Exception.Message)
            Start-Sleep -Milliseconds $delayMilliseconds
            $delayMilliseconds = [Math]::Min($delayMilliseconds * 2, 5000)
        }
    }
}

function Wait-RevAgentPathAbsent {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $delayMilliseconds = 250
    for ($attempt = 1; $attempt -le 8; $attempt++) {
        if (-not (Test-Path -LiteralPath $Path)) {
            return
        }

        Start-Sleep -Milliseconds $delayMilliseconds
        $delayMilliseconds = [Math]::Min($delayMilliseconds * 2, 5000)
    }

    throw "$Label was still present after removal: $Path"
}

function Remove-RevAgentDirectoryWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Assert-RevAgentChildPath -Path $Path -Root $Root
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    Invoke-RevAgentFileSystemRetry -Label "Remove $Label" -Action {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    }
    Wait-RevAgentPathAbsent -Path $Path -Label $Label
}

function Copy-RevAgentDirectoryExact {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$AllowReplace
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Required source directory was not found: $Source"
    }
    Assert-RevAgentChildPath -Path $Destination -Root $Root

    if (Test-Path -LiteralPath $Destination) {
        if (-not $AllowReplace) {
            throw "Target already exists: $Destination. Pass -Force to replace it."
        }
    }

    $destinationParent = Split-Path -Parent $Destination
    $destinationName = Split-Path -Leaf $Destination
    $stagePath = Join-Path $destinationParent (".{0}.copy-staging-{1}" -f $destinationName, [Guid]::NewGuid().ToString("N"))
    Assert-RevAgentChildPath -Path $stagePath -Root $Root

    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    try {
        Invoke-RevAgentFileSystemRetry -Label "Stage copy $destinationName" -Action {
            if (Test-Path -LiteralPath $stagePath) {
                Remove-Item -LiteralPath $stagePath -Recurse -Force -ErrorAction Stop
            }
            Copy-Item -LiteralPath $Source -Destination $stagePath -Recurse -Force -ErrorAction Stop
        }

        if (Test-Path -LiteralPath $Destination) {
            Remove-RevAgentDirectoryWithRetry -Path $Destination -Root $Root -Label $destinationName
        }

        Invoke-RevAgentFileSystemRetry -Label "Promote staged copy $destinationName" -Action {
            Move-Item -LiteralPath $stagePath -Destination $Destination -Force -ErrorAction Stop
        }
    }
    catch {
        if (Test-Path -LiteralPath $stagePath) {
            Remove-Item -LiteralPath $stagePath -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Backup-RevAgentDirectoryForRollback {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Backup,
        [Parameter(Mandatory = $true)][string]$Root
    )

    Assert-RevAgentChildPath -Path $Source -Root $Root
    Assert-RevAgentChildPath -Path $Backup -Root $Root
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        return $false
    }

    Copy-RevAgentDirectoryExact -Source $Source -Destination $Backup -Root $Root
    return $true
}

function Restore-RevAgentDirectoryFromRollback {
    param(
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Backup,
        [Parameter(Mandatory = $true)][string]$Root,
        [bool]$HadOriginal
    )

    Assert-RevAgentChildPath -Path $Destination -Root $Root
    Assert-RevAgentChildPath -Path $Backup -Root $Root
    if ($HadOriginal) {
        if (-not (Test-Path -LiteralPath $Backup -PathType Container)) {
            throw "Rollback backup was not found: $Backup"
        }
        Copy-RevAgentDirectoryExact -Source $Backup -Destination $Destination -Root $Root -AllowReplace
    }
    else {
        Remove-RevAgentDirectoryWithRetry -Path $Destination -Root $Root -Label (Split-Path -Leaf $Destination)
    }
}

function ConvertTo-RevAgentInt64OrZero {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return [long]0
    }

    $parsed = [long]0
    if ([long]::TryParse([string]$Value, [System.Globalization.NumberStyles]::Integer, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        return $parsed
    }

    return [long]0
}

function Get-RevAgentChannelReleaseSequenceStatus {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject][ordered]@{
            success = $false
            exists = $false
            value = [long]0
            reason = "not_found"
            message = "Channel manifest was not found."
        }
    }

    try {
        $channel = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        return [pscustomobject][ordered]@{
            success = $false
            exists = $true
            value = [long]0
            reason = "read_failed"
            message = $_.Exception.Message
        }
    }

    $sequenceProperty = $channel.PSObject.Properties["releaseSequence"]
    if ($null -eq $sequenceProperty -or $null -eq $sequenceProperty.Value -or [string]::IsNullOrWhiteSpace([string]$sequenceProperty.Value)) {
        return [pscustomobject][ordered]@{
            success = $false
            exists = $true
            value = [long]0
            reason = "missing_release_sequence"
            message = "Channel manifest does not contain releaseSequence."
        }
    }

    $parsed = [long]0
    if (-not [long]::TryParse([string]$sequenceProperty.Value, [System.Globalization.NumberStyles]::Integer, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        return [pscustomobject][ordered]@{
            success = $false
            exists = $true
            value = [long]0
            reason = "invalid_release_sequence"
            message = "Channel manifest releaseSequence is not a valid integer."
        }
    }

    return [pscustomobject][ordered]@{
        success = $true
        exists = $true
        value = $parsed
        reason = "ok"
        message = "Channel manifest releaseSequence was read."
    }
}

if (-not (Test-Path -LiteralPath $SourceReleaseRoot -PathType Container)) {
    throw "Source release root was not found: $SourceReleaseRoot"
}
if (-not (Test-Path -LiteralPath $TrustedKeysPath -PathType Leaf)) {
    throw "Trusted release keys file was not found: $TrustedKeysPath"
}

$sourceReadiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
    -ReleaseRoot $SourceReleaseRoot `
    -TrustedKeysPath $TrustedKeysPath `
    -RepoRoot $RepoRoot
if (-not [bool]$sourceReadiness.success) {
    throw "Source signed release root failed readiness verification."
}

$sourceChannelPath = Join-Path $SourceReleaseRoot "channels\$Channel.json"
$sourceChannelSignaturePath = Join-Path $SourceReleaseRoot "channels\$Channel.sig.json"
if (-not (Test-Path -LiteralPath $sourceChannelPath -PathType Leaf)) {
    throw "Source channel manifest was not found: $sourceChannelPath"
}
if (-not (Test-Path -LiteralPath $sourceChannelSignaturePath -PathType Leaf)) {
    throw "Source channel signature was not found: $sourceChannelSignaturePath"
}

$sourceChannel = Get-Content -Raw -LiteralPath $sourceChannelPath | ConvertFrom-Json
$version = [string]$sourceChannel.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "Source channel manifest does not contain a version."
}
if ([System.IO.Path]::IsPathRooted([string]$sourceChannel.manifestPath) -or [System.IO.Path]::IsPathRooted([string]$sourceChannel.packagePath)) {
    throw "Source channel paths must be relative so the signed release can move to NAS without re-signing."
}

$sourceReleaseDir = Join-Path $SourceReleaseRoot "releases\$version"
$sourceToolsDir = Join-Path $SourceReleaseRoot "tools"
$nasReleaseDir = Join-Path $NasReleaseRoot "releases\$version"
$nasToolsDir = Join-Path $NasReleaseRoot "tools"
$nasChannelsDir = Join-Path $NasReleaseRoot "channels"
$payloadBackupRoot = Join-Path $NasReleaseRoot (".publish-backup-{0}" -f ([Guid]::NewGuid().ToString("N")))
$toolsBackupDir = Join-Path $payloadBackupRoot "tools"
$releaseBackupDir = Join-Path $payloadBackupRoot "release"
$candidateChannelPath = Join-Path $nasChannelsDir ("{0}.candidate.json" -f $Channel)
$candidateSignaturePath = Join-Path $nasChannelsDir ("{0}.candidate.sig.json" -f $Channel)
$stableChannelPath = Join-Path $nasChannelsDir ("{0}.json" -f $Channel)
$stableSignaturePath = Join-Path $nasChannelsDir ("{0}.sig.json" -f $Channel)
foreach ($path in @($candidateChannelPath, $candidateSignaturePath, $stableChannelPath, $stableSignaturePath, $payloadBackupRoot, $toolsBackupDir, $releaseBackupDir)) {
    Assert-RevAgentChildPath -Path $path -Root $NasReleaseRoot
}

$candidateReleaseSequence = ConvertTo-RevAgentInt64OrZero -Value $sourceReadiness.releaseSequence
if ($candidateReleaseSequence -le 0) {
    $candidateSequenceStatus = Get-RevAgentChannelReleaseSequenceStatus -Path $sourceChannelPath
    if ([bool]$candidateSequenceStatus.success) {
        $candidateReleaseSequence = [long]$candidateSequenceStatus.value
    }
}
if ($candidateReleaseSequence -le 0) {
    throw "Refusing to publish because candidate releaseSequence could not be determined as a positive integer. Check '$sourceChannelPath' and readiness output before retrying."
}
$currentStableSequenceStatus = Get-RevAgentChannelReleaseSequenceStatus -Path $stableChannelPath
if ([bool]$currentStableSequenceStatus.exists -and -not [bool]$currentStableSequenceStatus.success) {
    if ($AllowRollback -and [string]::Equals([string]$currentStableSequenceStatus.reason, "missing_release_sequence", [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Warning "Current stable channel has no releaseSequence; treating it as legacy sequence 0 because -AllowRollback was supplied."
    }
    else {
        throw "Refusing to publish because current stable releaseSequence could not be determined from '$stableChannelPath'. Reason: $($currentStableSequenceStatus.reason). $($currentStableSequenceStatus.message)"
    }
}
$currentStableReleaseSequence = if ([bool]$currentStableSequenceStatus.success) { [long]$currentStableSequenceStatus.value } else { [long]0 }
# Equal releaseSequence republish is a protected repair path; require an explicit operator override.
if ($currentStableReleaseSequence -gt 0 -and $candidateReleaseSequence -le $currentStableReleaseSequence -and -not $AllowRollback) {
    throw "Refusing to publish releaseSequence '$candidateReleaseSequence' over current stable '$currentStableReleaseSequence'. Pass -AllowRollback only for deliberate signed rollback or current-sequence repair."
}

$stableChannelBackupPath = Join-Path $nasChannelsDir ("{0}.previous.json" -f $Channel)
$stableSignatureBackupPath = Join-Path $nasChannelsDir ("{0}.previous.sig.json" -f $Channel)
$stableChannelTempPath = Join-Path $nasChannelsDir ("{0}.next.json" -f $Channel)
$stableSignatureTempPath = Join-Path $nasChannelsDir ("{0}.next.sig.json" -f $Channel)
foreach ($path in @($stableChannelBackupPath, $stableSignatureBackupPath, $stableChannelTempPath, $stableSignatureTempPath)) {
    Assert-RevAgentChildPath -Path $path -Root $NasReleaseRoot
}

$hadStableChannel = Test-Path -LiteralPath $stableChannelPath -PathType Leaf
$hadStableSignature = Test-Path -LiteralPath $stableSignaturePath -PathType Leaf
$stableReadiness = $null
$rollbackFailed = $false
$promotionStarted = $false
$payloadCopyStarted = $false
$hadToolsDir = $false
$hadReleaseDir = $false
$releaseAclScriptPath = Join-Path $RepoRoot "scripts\set-nas-release-acl.ps1"
if (-not (Test-Path -LiteralPath $releaseAclScriptPath -PathType Leaf)) {
    throw "NAS release ACL controller was not found: $releaseAclScriptPath"
}
$publisherPrincipal = ""
$releaseAclUnseal = $null
$releaseAclSeal = $null
$releaseAclPreview = $null
$releaseAclResealRequired = $false
try {
    # The release-root owner is the publisher principal. The ACL controller
    # proves that this process's filesystem/SMB session maps to that principal
    # before opening the writable window. Set the finally guard first so even a
    # partial ACL mutation is followed by a fail-closed seal attempt.
    $releaseAclResealRequired = $true
    $releaseAclUnseal = & $releaseAclScriptPath `
        -ReleaseRoot $NasReleaseRoot `
        -Mode Unseal `
        -ConfirmPublisherWrite `
        -AllowTestRoot:$AllowTestRoot
    $publisherPrincipal = [string]$releaseAclUnseal.publisherPrincipal
    if (-not [bool]$releaseAclUnseal.safe -or -not [bool]$releaseAclUnseal.unsealedForPublisherOnly) {
        throw "NAS release ACL unseal verification failed before publish."
    }

    try {
    New-Item -ItemType Directory -Path $NasReleaseRoot -Force | Out-Null
    $hadToolsDir = Backup-RevAgentDirectoryForRollback -Source $nasToolsDir -Backup $toolsBackupDir -Root $NasReleaseRoot
    $hadReleaseDir = Backup-RevAgentDirectoryForRollback -Source $nasReleaseDir -Backup $releaseBackupDir -Root $NasReleaseRoot
    $payloadCopyStarted = $true
    Copy-RevAgentDirectoryExact -Source $sourceReleaseDir -Destination $nasReleaseDir -Root $NasReleaseRoot -AllowReplace:$Force
    Copy-RevAgentDirectoryExact -Source $sourceToolsDir -Destination $nasToolsDir -Root $NasReleaseRoot -AllowReplace:$true

    New-Item -ItemType Directory -Path $nasChannelsDir -Force | Out-Null
    Copy-Item -LiteralPath $sourceChannelPath -Destination $candidateChannelPath -Force
    Copy-Item -LiteralPath $sourceChannelSignaturePath -Destination $candidateSignaturePath -Force

    $candidateReadiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $NasReleaseRoot `
        -ChannelManifestPath $candidateChannelPath `
        -TrustedKeysPath $TrustedKeysPath `
        -ArtifactScanScope activeRelease `
        -RepoRoot $RepoRoot
    if (-not [bool]$candidateReadiness.success) {
        throw "NAS candidate signed release root failed readiness verification."
    }

    Remove-Item -LiteralPath $stableChannelBackupPath, $stableSignatureBackupPath, $stableChannelTempPath, $stableSignatureTempPath -Force -ErrorAction SilentlyContinue
    if ($hadStableChannel) {
        Copy-Item -LiteralPath $stableChannelPath -Destination $stableChannelBackupPath -Force
    }
    if ($hadStableSignature) {
        Copy-Item -LiteralPath $stableSignaturePath -Destination $stableSignatureBackupPath -Force
    }
    Copy-Item -LiteralPath $candidateChannelPath -Destination $stableChannelTempPath -Force
    Copy-Item -LiteralPath $candidateSignaturePath -Destination $stableSignatureTempPath -Force

    # Promote signature before channel: an updater racing between these moves sees a mismatched pair and rejects it.
    $promotionStarted = $true
    Move-Item -LiteralPath $stableSignatureTempPath -Destination $stableSignaturePath -Force
    Move-Item -LiteralPath $stableChannelTempPath -Destination $stableChannelPath -Force

    $stableReadiness = & (Join-Path $RepoRoot "scripts\check-signed-stable-readiness.ps1") `
        -ReleaseRoot $NasReleaseRoot `
        -TrustedKeysPath $TrustedKeysPath `
        -ArtifactScanScope activeRelease `
        -RepoRoot $RepoRoot
    if (-not [bool]$stableReadiness.success) {
        throw "NAS stable signed release root failed readiness verification after publish."
    }
}
catch {
    $publishError = $_
    try {
        if ($promotionStarted) {
            if ($hadStableSignature -and (Test-Path -LiteralPath $stableSignatureBackupPath -PathType Leaf)) {
                Copy-Item -LiteralPath $stableSignatureBackupPath -Destination $stableSignaturePath -Force
            }
            elseif (Test-Path -LiteralPath $stableSignaturePath -PathType Leaf) {
                Remove-Item -LiteralPath $stableSignaturePath -Force
            }
            if ($hadStableChannel -and (Test-Path -LiteralPath $stableChannelBackupPath -PathType Leaf)) {
                Copy-Item -LiteralPath $stableChannelBackupPath -Destination $stableChannelPath -Force
            }
            elseif (Test-Path -LiteralPath $stableChannelPath -PathType Leaf) {
                Remove-Item -LiteralPath $stableChannelPath -Force
            }
        }
        if ($payloadCopyStarted) {
            Restore-RevAgentDirectoryFromRollback -Destination $nasToolsDir -Backup $toolsBackupDir -Root $NasReleaseRoot -HadOriginal $hadToolsDir
            Restore-RevAgentDirectoryFromRollback -Destination $nasReleaseDir -Backup $releaseBackupDir -Root $NasReleaseRoot -HadOriginal $hadReleaseDir
        }
    }
    catch {
        $rollbackFailed = $true
        $rollbackError = $_
        Write-Warning ("NAS stable rollback failed after publish error. Backup files kept for manual recovery: {0}, {1}, {2}" -f $stableChannelBackupPath, $stableSignatureBackupPath, $payloadBackupRoot)
        throw "NAS stable signed release publish failed and rollback also failed. Original error: $($publishError.Exception.Message). Rollback error: $($rollbackError.Exception.Message). Backup files kept for manual recovery."
    }
    throw $publishError
}
finally {
    $cleanupPaths = @($stableChannelTempPath, $stableSignatureTempPath, $candidateChannelPath, $candidateSignaturePath)
    if (-not $rollbackFailed) {
        # Successful publishes remove transient channel backups; versioned
        # release recovery remains available from the NAS releases archive.
        $cleanupPaths += @($stableChannelBackupPath, $stableSignatureBackupPath)
        if (Test-Path -LiteralPath $payloadBackupRoot) {
            Remove-Item -LiteralPath $payloadBackupRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -LiteralPath $cleanupPaths -Force -ErrorAction SilentlyContinue
}
}
finally {
    if ($releaseAclResealRequired -and (Test-Path -LiteralPath $NasReleaseRoot -PathType Container)) {
        $releaseAclSeal = & $releaseAclScriptPath `
            -ReleaseRoot $NasReleaseRoot `
            -Mode Seal `
            -PublisherPrincipal $publisherPrincipal `
            -AllowTestRoot:$AllowTestRoot
        $releaseAclPreview = & $releaseAclScriptPath `
            -ReleaseRoot $NasReleaseRoot `
            -Mode Preview `
            -PublisherPrincipal $publisherPrincipal `
            -AllowTestRoot:$AllowTestRoot
        if (-not [bool]$releaseAclSeal.sealed -or -not [bool]$releaseAclPreview.sealed -or
            -not [bool]$releaseAclSeal.safe -or -not [bool]$releaseAclPreview.safe) {
            throw "NAS release ACL reseal verification failed; protected release paths may still be writable."
        }
    }
}

$result = [pscustomobject][ordered]@{
    success = $true
    action = "signed-source-free-nas-publish"
    sourceReleaseRoot = $SourceReleaseRoot
    nasReleaseRoot = $NasReleaseRoot
    channel = $Channel
    version = $version
    stableChannelPath = $stableChannelPath
    stableSignaturePath = $stableSignaturePath
    releaseDirectory = $nasReleaseDir
    readiness = $stableReadiness
    releaseAcl = [pscustomobject][ordered]@{
        publisherPrincipal = $publisherPrincipal
        unseal = $releaseAclUnseal
        seal = $releaseAclSeal
        preview = $releaseAclPreview
    }
}

if ($OutputJson) {
    $result | ConvertTo-Json -Depth 16
}
else {
    $result
}
