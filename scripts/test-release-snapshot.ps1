[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Assert-Equal { param($Actual, $Expected, [string]$Message) if ($Actual -ne $Expected) { throw "$Message Expected='$Expected' Actual='$Actual'" } }
function Write-Utf8Json { param([string]$Path, [object]$Value) [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false)) }

$integrityModulePath = Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1'
$snapshotModulePath = Join-Path $RepoRoot 'installer\lib\RevAgent.ReleaseSnapshot.psm1'
Import-Module $integrityModulePath -Force
Import-Module $snapshotModulePath -Force

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('revagent-release-snapshot-test-' + [Guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $tempRoot 'release'
$payloadRoot = Join-Path $tempRoot 'payload'
$inboxRoot = Join-Path $tempRoot 'inbox'
$snapshotParent = Join-Path $tempRoot 'snapshots'
$snapshotParentReplay = Join-Path $tempRoot 'snapshots-replay'
$snapshotParentRace = Join-Path $tempRoot 'snapshots-race'
$snapshotParentUnsafe = Join-Path $tempRoot 'snapshots-unsafe'
$snapshotParentMetadataSwap = Join-Path $tempRoot 'snapshots-metadata-swap'
$extractRoot = Join-Path $tempRoot 'extract'
New-Item -ItemType Directory -Path $releaseRoot, $payloadRoot, $inboxRoot, $extractRoot -Force | Out-Null

$rsa = [Security.Cryptography.RSACryptoServiceProvider]::new(2048)
try {
    $keyId = 'test-release-snapshot'
    $publicKeyXml = $rsa.ToXmlString($false)
    $fingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
    $trustedKeys = [ordered]@{ trustedKeys = [ordered]@{ $keyId = [ordered]@{ publicKeyXml = $publicKeyXml; publicKeyFingerprint = $fingerprint; algorithm = 'RS256' } } }
    $trustedKeysPath = Join-Path $tempRoot 'release-trusted-keys.json'
    Write-Utf8Json -Path $trustedKeysPath -Value $trustedKeys

    $updaterRelative = 'installer\nas\update-from-nas.ps1'
    $installerRelative = 'installer\nas\install-updater-task.ps1'
    foreach ($relative in @($updaterRelative, $installerRelative)) {
        $path = Join-Path $payloadRoot $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
        [IO.File]::WriteAllText($path, "[pscustomobject]@{ success = `$true; path = '$relative' }", [Text.UTF8Encoding]::new($false))
    }
    $version = '2099.01.01.1-test'
    $releaseDirectory = Join-Path $releaseRoot "releases\$version"
    New-Item -ItemType Directory -Path $releaseDirectory, (Join-Path $releaseRoot 'channels'), (Join-Path $releaseRoot 'tools\dependencies') -Force | Out-Null
    $packageName = "revAgent-$version.zip"
    $packagePath = Join-Path $releaseDirectory $packageName
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($payloadRoot, $packagePath, [IO.Compression.CompressionLevel]::Optimal, $false)
    $packageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash
    $packageSize = (Get-Item -LiteralPath $packagePath).Length
    $components = [ordered]@{
        updater = [ordered]@{ path = $updaterRelative; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $payloadRoot $updaterRelative)).Hash; sizeBytes = (Get-Item -LiteralPath (Join-Path $payloadRoot $updaterRelative)).Length }
        updaterTaskInstaller = [ordered]@{ path = $installerRelative; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $payloadRoot $installerRelative)).Hash; sizeBytes = (Get-Item -LiteralPath (Join-Path $payloadRoot $installerRelative)).Length }
    }
    $manifest = [ordered]@{
        schemaVersion = 1; app = 'revAgent'; version = $version; channel = 'stable'; releaseSequence = 10; minimumAcceptedReleaseSequence = 1
        package = [ordered]@{ fileName = $packageName; path = "..\releases\$version\$packageName"; sha256 = $packageHash; sizeBytes = $packageSize }
        components = $components
    }
    $channel = [ordered]@{
        schemaVersion = 1; app = 'revAgent'; channel = 'stable'; version = $version; releaseSequence = 10; minimumAcceptedReleaseSequence = 1
        manifestPath = "..\releases\$version\manifest.json"; packagePath = "..\releases\$version\$packageName"; sha256 = $packageHash
    }
    $manifestPath = Join-Path $releaseDirectory 'manifest.json'
    $channelPath = Join-Path $releaseRoot 'channels\stable.json'
    Write-Utf8Json -Path $manifestPath -Value $manifest
    Write-Utf8Json -Path $channelPath -Value $channel
    Write-Utf8Json -Path (Join-Path $releaseDirectory 'manifest.sig.json') -Value (New-RevAgentDetachedJsonSignature -Content $manifest -SignedObject 'release-manifest' -KeyId $keyId -PrivateKeyXml ($rsa.ToXmlString($true)) -App 'revAgent')
    Write-Utf8Json -Path (Join-Path $releaseRoot 'channels\stable.sig.json') -Value (New-RevAgentDetachedJsonSignature -Content $channel -SignedObject 'channel' -KeyId $keyId -PrivateKeyXml ($rsa.ToXmlString($true)) -App 'revAgent')

    $nodeMsiPath = Join-Path $releaseRoot 'tools\dependencies\node-v24.14.1-x64.msi'
    [IO.File]::WriteAllBytes($nodeMsiPath, [Text.Encoding]::UTF8.GetBytes('TEST NODE MSI BYTES'))
    $nodeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeMsiPath).Hash

    Write-Host 'Test signed object/path binding and pre-parse channel locks'
    $substitutedChannel = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json
    $substitutedChannel.version = '2099.01.01.substituted'
    $bindingResult = Test-RevAgentReleaseDistributionIntegrity `
        -ChannelPath $channelPath `
        -Channel $substitutedChannel `
        -ReleaseManifestPath $manifestPath `
        -ReleaseManifest $manifest `
        -TrustedKeys $trustedKeys.trustedKeys `
        -Policy enforce
    Assert-True (-not [bool]$bindingResult.success) 'Verified file paths must not authorize substituted caller metadata.'
    Assert-Equal ([string]$bindingResult.reason) 'signed_object_binding_mismatch' 'Signed object/path binding rejection reason mismatch.'

    $lockProbe = [pscustomobject]@{ writeBlocked = $false }
    $lockHook = {
        param($lockedChannelPath, $lockedSignaturePath)
        $stream = $null
        try { $stream = [IO.File]::Open($lockedChannelPath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None) }
        catch [IO.IOException] { $lockProbe.writeBlocked = $true }
        finally { if ($null -ne $stream) { $stream.Dispose() } }
    }.GetNewClosure()
    [void](Get-RevAgentVerifiedReleaseSet -ReleaseRoot $releaseRoot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath $integrityModulePath -AllowTestRoot -SignedSetLockedHook $lockHook)
    Assert-True ([bool]$lockProbe.writeBlocked) 'Channel bytes must be deny-write locked before they are parsed.'

    Write-Host 'Test handle-bound authenticated inbox and protected snapshot promotion'
    $inboxOne = New-RevAgentAuthenticatedReleaseInbox -ReleaseRoot $releaseRoot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath $integrityModulePath -InboxRoot $inboxRoot -ExpectedNodeMsiSha256 $nodeHash -AllowTestRoot
    $inboxTwo = New-RevAgentAuthenticatedReleaseInbox -ReleaseRoot $releaseRoot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath $integrityModulePath -InboxRoot $inboxRoot -ExpectedNodeMsiSha256 $nodeHash -AllowTestRoot
    $inboxThree = New-RevAgentAuthenticatedReleaseInbox -ReleaseRoot $releaseRoot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath $integrityModulePath -InboxRoot $inboxRoot -ExpectedNodeMsiSha256 $nodeHash -AllowTestRoot
    [IO.File]::WriteAllBytes($packagePath, [Text.Encoding]::UTF8.GetBytes('MUTATED TRANSPORT AFTER INBOX'))
    $snapshot = New-RevAgentProtectedReleaseSnapshot -InboxPath $inboxOne.inboxRoot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath $integrityModulePath -SnapshotParent $snapshotParent -ExpectedNodeMsiSha256 $nodeHash -AllowTestRoot
    Assert-True $snapshot.success 'Protected release snapshot should succeed from an authenticated local inbox after transport mutation.'
    Assert-Equal $snapshot.state.transportTrust 'signed_local_snapshot' 'Snapshot transport trust mismatch.'
    Assert-Equal ([long]$snapshot.state.release.releaseSequence) ([long]10) 'Snapshot release sequence mismatch.'
    Assert-True (Test-Path -LiteralPath (Join-Path $snapshot.snapshotRoot 'payload\installer\nas\update-from-nas.ps1') -PathType Leaf) 'Snapshot updater entrypoint was not extracted.'
    Assert-True (Test-Path -LiteralPath (Join-Path $snapshot.snapshotRoot 'payload\installer\nas\dependencies\node-v24.14.1-x64.msi') -PathType Leaf) 'Pinned Node MSI was not copied into the snapshot payload.'
    Assert-True (Assert-RevAgentProtectedReleaseSnapshot -SnapshotRoot $snapshot.snapshotRoot -AllowTestRoot) 'Snapshot ACL/link/hardlink reattestation should pass.'
    Assert-True (Assert-RevAgentProtectedSnapshotParent -Path $snapshotParent -AllowTestRoot) 'Snapshot parent owner/DACL/path attestation should pass.'

    Write-Host 'Test snapshot parent ACL and no-delete-share race guards'
    New-Item -ItemType Directory -Path $snapshotParentUnsafe -Force | Out-Null
    $unsafeParentAcl = [Security.AccessControl.DirectorySecurity]::new()
    $unsafeParentAcl.SetAccessRuleProtection($true, $false)
    $unsafeParentAcl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
    foreach ($entry in @(
            [pscustomobject]@{ Sid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
            [pscustomobject]@{ Sid = 'S-1-1-0'; Rights = [Security.AccessControl.FileSystemRights]::Modify }
        )) {
        [void]$unsafeParentAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new([string]$entry.Sid),
                [Security.AccessControl.FileSystemRights]$entry.Rights,
                ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    $unsafeParentInfo = [IO.DirectoryInfo](Get-Item -LiteralPath $snapshotParentUnsafe -Force)
    if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl($unsafeParentInfo, $unsafeParentAcl) }
    else { $unsafeParentInfo.SetAccessControl($unsafeParentAcl) }
    $unsafeParentRejected = $false
    try { [void](New-RevAgentProtectedReleaseSnapshot -InboxPath $inboxOne.inboxRoot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath $integrityModulePath -SnapshotParent $snapshotParentUnsafe -ExpectedNodeMsiSha256 $nodeHash -AllowTestRoot) }
    catch { $unsafeParentRejected = $_.Exception.Message -match 'snapshot parent grants write/delete/ACL capability' }
    Assert-True $unsafeParentRejected 'A preplanted user-writable execution-snapshots parent was accepted.'
    Assert-True (@(Get-ChildItem -LiteralPath $snapshotParentUnsafe -Force).Count -eq 0) 'Unsafe snapshot-parent rejection occurred after a staging child was written.'

    $raceProbe = [pscustomobject]@{ renameBlocked = $false; identity = '' }
    $raceHook = {
        param($guard)
        $raceProbe.identity = [string]$guard.Identity
        $movedPath = ([string]$guard.Path) + '-moved'
        try {
            Move-Item -LiteralPath ([string]$guard.Path) -Destination $movedPath -ErrorAction Stop
            Move-Item -LiteralPath $movedPath -Destination ([string]$guard.Path) -ErrorAction Stop
        }
        catch { $raceProbe.renameBlocked = $true }
    }.GetNewClosure()
    $raceSnapshot = New-RevAgentProtectedReleaseSnapshot -InboxPath $inboxOne.inboxRoot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath $integrityModulePath -SnapshotParent $snapshotParentRace -ExpectedNodeMsiSha256 $nodeHash -AllowTestRoot -SnapshotParentLockedHook $raceHook
    Assert-True ([bool]$raceProbe.renameBlocked -and -not [string]::IsNullOrWhiteSpace([string]$raceProbe.identity)) 'Snapshot-parent no-FILE_SHARE_DELETE handle did not block a deterministic rename/swap attempt.'
    Assert-True ((Test-Path -LiteralPath $raceSnapshot.snapshotRoot -PathType Container) -and (Assert-RevAgentProtectedSnapshotParent -Path $snapshotParentRace -AllowTestRoot)) 'Snapshot parent identity/ACL did not survive the guarded race fixture.'

    Write-Host 'Test verified inbox metadata cannot be swapped before snapshot copy'
    $metadataSwapHook = {
        param($verifiedSet)
        [IO.File]::WriteAllText([string]$verifiedSet.channelPath, '{"schemaVersion":1,"app":"revAgent","channel":"stable","version":"swapped"}', [Text.UTF8Encoding]::new($false))
    }
    $metadataSwapRejected = $false
    try { [void](New-RevAgentProtectedReleaseSnapshot -InboxPath $inboxThree.inboxRoot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath $integrityModulePath -SnapshotParent $snapshotParentMetadataSwap -ExpectedNodeMsiSha256 $nodeHash -AllowTestRoot -VerifiedInboxReleasedHook $metadataSwapHook) }
    catch { $metadataSwapRejected = $_.Exception.Message -match 'Snapshot source hash mismatch' }
    Assert-True $metadataSwapRejected 'Verified user-writable inbox metadata was copied after a post-verification pathname swap.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $snapshotParentMetadataSwap ([string]$inboxThree.inboxId)))) 'Metadata-swap rejection promoted a final snapshot.'

    Write-Host 'Test inbox mutation and signed replay fail closed'
    $inboxTwoState = Get-Content -Raw -LiteralPath (Join-Path $inboxTwo.inboxRoot 'inbox-state.json') | ConvertFrom-Json
    [IO.File]::WriteAllBytes((Join-Path $inboxTwo.inboxRoot $inboxTwoState.release.packageRelativePath), [Text.Encoding]::UTF8.GetBytes('TAMPERED INBOX PACKAGE'))
    $tamperRejected = $false
    try { [void](New-RevAgentProtectedReleaseSnapshot -InboxPath $inboxTwo.inboxRoot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath $integrityModulePath -SnapshotParent (Join-Path $tempRoot 'snapshots-tamper') -ExpectedNodeMsiSha256 $nodeHash -AllowTestRoot) }
    catch { $tamperRejected = $_.Exception.Message -match 'package SHA-256 mismatch|hash mismatch' }
    Assert-True $tamperRejected 'Broker-side verification must reject a package changed after pre-UAC acquisition.'
    $replayRejected = $false
    try { [void](New-RevAgentProtectedReleaseSnapshot -InboxPath $inboxOne.inboxRoot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath $integrityModulePath -SnapshotParent $snapshotParentReplay -HighestAcceptedReleaseSequence 11 -ExpectedNodeMsiSha256 $nodeHash -AllowTestRoot) }
    catch { $replayRejected = $_.Exception.Message -match 'signed_release_replay|older than highest accepted' }
    Assert-True $replayRejected 'Protected snapshot must reject a signed release below the local high-water mark.'

    Write-Host 'Test secure ZIP extraction rejects traversal and duplicate names'
    foreach ($case in @('traversal', 'duplicate')) {
        $zipPath = Join-Path $tempRoot "$case.zip"
        $zipStream = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $archive = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Create, $false)
        try {
            $names = if ($case -eq 'traversal') { @('..\escape.txt') } else { @('same.txt', 'SAME.TXT') }
            foreach ($name in $names) {
                $entry = $archive.CreateEntry($name)
                $writer = [IO.StreamWriter]::new($entry.Open())
                try { $writer.Write('x') } finally { $writer.Dispose() }
            }
        }
        finally { $archive.Dispose() }
        $rejected = $false
        try { Expand-RevAgentSnapshotArchiveSecure -ZipPath $zipPath -DestinationPath (Join-Path $extractRoot $case) }
        catch { $rejected = $_.Exception.Message -match 'Unsafe archive|Duplicate/case-colliding' }
        Assert-True $rejected "Secure extraction must reject $case archive entries."
    }

    Write-Host 'Test foreign snapshot writer is detected'
    $rootAcl = Get-Acl -LiteralPath $snapshot.snapshotRoot
    [void]$rootAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
            [Security.AccessControl.FileSystemRights]::Modify,
            [Security.AccessControl.InheritanceFlags]::None,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow))
    $daclOnly = [Security.AccessControl.DirectorySecurity]::new()
    $daclOnly.SetSecurityDescriptorSddlForm(
        $rootAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access),
        [Security.AccessControl.AccessControlSections]::Access)
    $snapshotRootInfo = [IO.DirectoryInfo](Get-Item -LiteralPath $snapshot.snapshotRoot -Force)
    if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl($snapshotRootInfo, $daclOnly) }
    else { $snapshotRootInfo.SetAccessControl($daclOnly) }
    $foreignWriterRejected = $false
    try { [void](Assert-RevAgentProtectedReleaseSnapshot -SnapshotRoot $snapshot.snapshotRoot -AllowTestRoot) }
    catch { $foreignWriterRejected = $_.Exception.Message -match 'untrusted principal' }
    Assert-True $foreignWriterRejected 'Snapshot reattestation must reject a foreign write-capable ACE.'

    Write-Host 'Release snapshot security tests passed.' -ForegroundColor Green
}
finally {
    $rsa.Dispose()
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
