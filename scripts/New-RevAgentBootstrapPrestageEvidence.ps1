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
    [Parameter(DontShow = $true)][scriptblock]$IntegrityModuleBytesVerifiedHook,
    [Parameter(DontShow = $true)][scriptblock]$TrustedKeysBytesVerifiedHook,
    [Parameter(DontShow = $true)][string]$TestMachineName = "",
    [Parameter(DontShow = $true)][scriptblock]$TestAfterPilotAuthorizationHook,
    [Parameter(DontShow = $true)][ValidateSet("", "elevated", "standard")][string]$TestAdministratorState = ""
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
        [bool]$SupervisedAdminPrestage
    }
}
if ($SupervisedAdminPrestage -and -not $isAdministrator) {
    throw "Supervised administrator prestage evidence requires an elevated Windows PowerShell process."
}
if (-not $SupervisedAdminPrestage -and $isAdministrator) {
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
if (($null -ne $IntegrityModuleBytesVerifiedHook -or $null -ne $TrustedKeysBytesVerifiedHook -or -not [string]::IsNullOrWhiteSpace($TestMachineName) -or $null -ne $TestAfterPilotAuthorizationHook -or -not [string]::IsNullOrWhiteSpace($TestAdministratorState)) -and -not $AllowTestRoot) {
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

if (Test-RevAgentEvidencePathUnderRoot -Path $OutputPath -Root $ReleaseRoot) { throw "Evidence output must not be written into the signed release root." }
if (Test-Path -LiteralPath $OutputPath) { throw "Evidence output already exists; refusing replacement: $OutputPath" }
$outputParent = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) { throw "Evidence output parent must already exist: $outputParent" }
if (-not (Test-Path -LiteralPath $TrustedKeysPath -PathType Leaf)) { throw "Trusted key document was not found: $TrustedKeysPath" }

$integrityModulePath = Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1"
$pinnedIntegrityModuleHash = "DF8F31B60432CC26FD73345CEE143E90B4235BA2DE08779813DAEDBC8563282E"
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
$strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
$trustedKeysText = $strictUtf8.GetString([byte[]]$trustedKeysEvidence.Bytes)
if ($trustedKeysText.Length -gt 0 -and $trustedKeysText[0] -eq [char]0xFEFF) { $trustedKeysText = $trustedKeysText.Substring(1) }
$trustedKeys = $trustedKeysText | ConvertFrom-Json
if ($null -ne $TrustedKeysBytesVerifiedHook) { & $TrustedKeysBytesVerifiedHook $TrustedKeysPath ([string]$trustedKeysEvidence.Sha256) }
if (-not $AllowTestRoot) {
    $productionKeyId = "revagent-prod-rsa-2026q3"
    $trustedKeyProperties = @($trustedKeys.trustedKeys.PSObject.Properties)
    if ($trustedKeyProperties.Count -ne 1 -or
        -not [string]::Equals([string]$trustedKeyProperties[0].Name, $productionKeyId, [StringComparison]::Ordinal)) {
        throw "Production trusted-key document must contain exactly the pinned key '$productionKeyId' and no additional signing keys."
    }
    $productionKey = $trustedKeys.trustedKeys."revagent-prod-rsa-2026q3"
    if ($null -eq $productionKey) { throw "Trusted key document does not contain the production signing key." }
    if (-not [string]::Equals([string]$productionKey.algorithm, "RS256", [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$productionKey.publicKeyFingerprint, "32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Production release-key metadata does not match the pinned RS256 key."
    }
    $normalizedPublicKey = ([string]$productionKey.publicKeyXml).Trim() -replace "\s+", ""
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $fingerprint = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedPublicKey)))).Replace("-", "") }
    finally { $sha.Dispose() }
    if ($fingerprint -ne "32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33") { throw "Production release-key fingerprint mismatch." }
}

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
        try { $actualHash = ([BitConverter]::ToString($entryHash.ComputeHash($entryStream))).Replace("-", "") }
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
    producerMode = if ($SupervisedAdminPrestage) { "supervised-admin-prestage" } else { "unelevated-coordinator" }
    supervisedAdminPrestage = [bool]$SupervisedAdminPrestage
    generatedAtUtc = [DateTime]::UtcNow.ToString("o")
    generatedBySid = [string]$identity.User.Value
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
        trustedKeys = [string]$trustedKeysEvidence.Sha256
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
    producerMode = if ($SupervisedAdminPrestage) { "supervised-admin-prestage" } else { "unelevated-coordinator" }
    supervisedAdminPrestage = [bool]$SupervisedAdminPrestage
}
