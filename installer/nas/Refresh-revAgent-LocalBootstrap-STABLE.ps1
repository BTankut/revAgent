<#
.SYNOPSIS
    One-click stable protected-bootstrap refresh for existing revAgent workstations.
#>

[CmdletBinding()]
param(
    [string]$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy",
    [ValidateSet("stable")][string]$Channel = "stable",
    [switch]$ElevatedApply,
    [string]$SourceRoot = "",
    [string]$EvidenceSource = "",
    [string]$ExpectedEvidenceSha256 = "",
    [string]$ExpectedInstallerSha256 = "",
    [string]$TrustedKeysSource = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Initialize-TrustedPowerShellModules {
    $systemDirectory = [Environment]::SystemDirectory
    $trustedModuleRoots = @(
        (Join-Path $PSHOME "Modules"),
        (Join-Path $systemDirectory "WindowsPowerShell\v1.0\Modules")
    ) | Where-Object { [IO.Directory]::Exists($_) } | Select-Object -Unique
    if (@($trustedModuleRoots).Count -eq 0) { throw "No trusted PowerShell module root was found for bootstrap refresh." }
    $env:PSModulePath = [string]::Join([IO.Path]::PathSeparator, [string[]]$trustedModuleRoots)
    foreach ($moduleName in @("Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Security", "Microsoft.PowerShell.Archive")) {
        $manifest = Join-Path $PSHOME ("Modules\{0}\{0}.psd1" -f $moduleName)
        if (-not [IO.File]::Exists($manifest)) { throw "Required trusted PowerShell module was not found: $manifest" }
        Microsoft.PowerShell.Core\Import-Module -Name $manifest -Force -ErrorAction Stop
    }
}

Initialize-TrustedPowerShellModules

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Test-RevAgentStringEquals {
    param(
        [AllowNull()][string]$Left,
        [AllowNull()][string]$Right,
        [switch]$IgnoreCase
    )

    if ($null -eq $Left -or $null -eq $Right) {
        return ($null -eq $Left -and $null -eq $Right)
    }
    if ($IgnoreCase) {
        return $Left.ToUpperInvariant() -eq $Right.ToUpperInvariant()
    }
    return $Left -ceq $Right
}

function Test-RevAgentStringStartsWith {
    param(
        [AllowNull()][string]$Value,
        [AllowNull()][string]$Prefix,
        [switch]$IgnoreCase
    )

    if ($null -eq $Value -or $null -eq $Prefix) { return $false }
    if ($Prefix.Length -eq 0) { return $true }
    if ($Value.Length -lt $Prefix.Length) { return $false }
    return Test-RevAgentStringEquals -Left ($Value.Substring(0, $Prefix.Length)) -Right $Prefix -IgnoreCase:([bool]$IgnoreCase)
}

function Quote-Arg {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Join-CommandLine {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    return ($Arguments | ForEach-Object {
            $value = [string]$_
            if ($value -match '[\s"]') { Quote-Arg $value } else { $value }
        }) -join ' '
}

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Set-AdminOnlyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $acl = if ($item.PSIsContainer) {
        [Security.AccessControl.DirectorySecurity]::new()
    }
    else {
        [Security.AccessControl.FileSecurity]::new()
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $inheritance = if ($item.PSIsContainer) {
            [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        }
        else {
            [Security.AccessControl.InheritanceFlags]::None
        }
        [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new($sid),
                [Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    if ('System.IO.FileSystemAclExtensions' -as [type]) {
        if ($item.PSIsContainer) {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item, [Security.AccessControl.DirectorySecurity]$acl)
        }
        else {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]$item, [Security.AccessControl.FileSecurity]$acl)
        }
    }
    elseif ($item.PSIsContainer) {
        ([IO.DirectoryInfo]$item).SetAccessControl([Security.AccessControl.DirectorySecurity]$acl)
    }
    else {
        ([IO.FileInfo]$item).SetAccessControl([Security.AccessControl.FileSecurity]$acl)
    }
}

function Get-ProtectedBootstrapState {
    $programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    $bootstrapRoot = [IO.Path]::GetFullPath((Join-Path $programData 'DPE\revAgent\bootstrap')).TrimEnd('\')
    $statePath = Join-Path $bootstrapRoot 'bootstrap-state.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw "Protected local bootstrap state was not found: $statePath"
    }
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ([int]$state.schemaVersion -ne 1 -or -not [bool]$state.sourceAuthentication.independentlyAuthenticated) {
        throw "Protected local bootstrap state does not prove an independently authenticated prestage."
    }
    foreach ($role in @('distributionIntegrity', 'releaseSnapshot', 'trustedKeys')) {
        $evidence = $state.files.$role
        if ($null -eq $evidence -or [string]::IsNullOrWhiteSpace([string]$evidence.relativePath) -or [string]::IsNullOrWhiteSpace([string]$evidence.sha256)) {
            throw "Protected local bootstrap state is missing required file evidence: $role"
        }
        $path = Join-Path $bootstrapRoot ([string]$evidence.relativePath)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Protected local bootstrap file was not found: $path" }
        if (-not (Test-RevAgentStringEquals -Left (Get-Sha256Hex -Path $path) -Right ([string]$evidence.sha256) -IgnoreCase)) {
            throw "Protected local bootstrap file hash mismatch: $role"
        }
    }
    return [pscustomobject]@{ root = $bootstrapRoot; statePath = $statePath; state = $state }
}

function Start-ElevatedApply {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$EvidenceSource,
        [Parameter(Mandatory = $true)][string]$EvidenceSha256,
        [Parameter(Mandatory = $true)][string]$InstallerSha256,
        [Parameter(Mandatory = $true)][string]$TrustedKeysSource
    )

    $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $args = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $PSCommandPath,
        '-ElevatedApply',
        '-ReleaseRoot', $ReleaseRoot,
        '-Channel', $Channel,
        '-SourceRoot', $SourceRoot,
        '-EvidenceSource', $EvidenceSource,
        '-ExpectedEvidenceSha256', $EvidenceSha256,
        '-ExpectedInstallerSha256', $InstallerSha256,
        '-TrustedKeysSource', $TrustedKeysSource
    )
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $powershell
    $psi.Arguments = Join-CommandLine -Arguments $args
    $psi.WorkingDirectory = Split-Path -Parent $powershell
    $psi.UseShellExecute = $true
    $psi.Verb = 'runas'
    $process = [Diagnostics.Process]::Start($psi)
    $process.WaitForExit()
    $exitCode = [int]$process.ExitCode
    $process.Dispose()
    if ($exitCode -ne 0) { throw "Elevated bootstrap refresh exited with code $exitCode." }
}

function Resolve-ReleaseRootChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BaseDirectory
    )

    $releaseRootFullPath = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
    $resolved = if ([IO.Path]::IsPathRooted($Path)) {
        [IO.Path]::GetFullPath($Path)
    }
    else {
        [IO.Path]::GetFullPath((Join-Path $BaseDirectory $Path))
    }
    $resolvedTrimmed = $resolved.TrimEnd('\')
    if (-not (Test-RevAgentStringEquals -Left $resolvedTrimmed -Right $releaseRootFullPath -IgnoreCase) -and
        -not (Test-RevAgentStringStartsWith -Value $resolvedTrimmed -Prefix ($releaseRootFullPath + '\') -IgnoreCase)) {
        throw "Signed release path escaped ReleaseRoot: $resolved"
    }
    return $resolved
}

function New-CleanInstallBootstrapInput {
    $channelPath = Join-Path (Join-Path $ReleaseRoot 'channels') "$Channel.json"
    $trustedKeys = Join-Path (Join-Path $ReleaseRoot 'tools\config') 'release-trusted-keys.json'
    if (-not (Test-Path -LiteralPath $channelPath -PathType Leaf)) {
        throw "Signed stable channel manifest was not found: $channelPath"
    }
    if (-not (Test-Path -LiteralPath $trustedKeys -PathType Leaf)) {
        throw "Trusted release keys were not found: $trustedKeys"
    }

    $channel = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json
    if (-not (Test-RevAgentStringEquals -Left ([string]$channel.channel) -Right $Channel)) {
        throw "Signed channel identity mismatch. requested=$Channel actual=$($channel.channel)"
    }
    $channelDirectory = Split-Path -Parent $channelPath
    $packagePath = Resolve-ReleaseRootChildPath -Path ([string]$channel.packagePath) -BaseDirectory $channelDirectory
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        throw "Signed release package was not found: $packagePath"
    }
    if ([string]::IsNullOrWhiteSpace([string]$channel.sha256)) {
        throw "Signed stable channel does not contain a package SHA-256."
    }
    $actualPackageSha256 = Get-Sha256Hex -Path $packagePath
    if (-not (Test-RevAgentStringEquals -Left $actualPackageSha256 -Right ([string]$channel.sha256) -IgnoreCase)) {
        throw "Signed release package changed before bootstrap evidence production."
    }

    $sourceRoot = Join-Path $env:TEMP ("revagent-bootstrap-install-source-" + [Guid]::NewGuid().ToString('N'))
    $evidencePath = Join-Path $env:TEMP ("revagent-bootstrap-install-evidence-" + [Guid]::NewGuid().ToString('N') + ".json")
    New-Item -ItemType Directory -Path $sourceRoot -Force | Out-Null
    Expand-Archive -LiteralPath $packagePath -DestinationPath $sourceRoot -Force
    if (-not (Test-RevAgentStringEquals -Left (Get-Sha256Hex -Path $packagePath) -Right $actualPackageSha256 -IgnoreCase)) {
        throw "Signed release package changed during extraction."
    }

    $evidenceTool = Join-Path $sourceRoot 'installer\nas\New-RevAgentBootstrapPrestageEvidence.ps1'
    if (-not (Test-Path -LiteralPath $evidenceTool -PathType Leaf)) {
        throw "Signed release package does not contain the bootstrap evidence producer: $evidenceTool"
    }

    Write-Host "Preparing authenticated first-install bootstrap evidence..."
    $evidenceResult = & $evidenceTool `
        -ReleaseRoot $ReleaseRoot `
        -TrustedKeysPath $trustedKeys `
        -OutputPath $evidencePath `
        -RepoRoot $sourceRoot `
        -Channel $Channel
    $evidence = Get-Content -Raw -LiteralPath $evidencePath | ConvertFrom-Json
    if (-not [bool]$evidence.release.signatureVerified -or
        -not (Test-RevAgentStringEquals -Left ([string]$evidence.release.channel) -Right $Channel)) {
        throw "Bootstrap first-install evidence does not prove a signed stable release."
    }
    if ([string]::IsNullOrWhiteSpace([string]$evidence.localBootstrapInstallerScript)) {
        throw "Bootstrap first-install evidence is missing the local bootstrap installer hash."
    }

    return [pscustomobject][ordered]@{
        SourceRoot = $sourceRoot
        EvidenceSource = $evidencePath
        EvidenceSha256 = [string]$evidenceResult.outputSha256
        InstallerSha256 = [string]$evidence.localBootstrapInstallerScript
        TrustedKeysSource = $trustedKeys
    }
}

if ($ElevatedApply) {
    if (-not (Test-IsAdmin)) { throw "Elevated bootstrap refresh requires administrator permission." }
    foreach ($required in @($SourceRoot, $EvidenceSource, $ExpectedEvidenceSha256, $ExpectedInstallerSha256, $TrustedKeysSource)) {
        if ([string]::IsNullOrWhiteSpace($required)) { throw "Elevated bootstrap refresh is missing a required authenticated input." }
    }
    if ((Get-Sha256Hex -Path $EvidenceSource) -ne $ExpectedEvidenceSha256) { throw "Bootstrap refresh evidence changed before elevation." }
    $installerSource = Join-Path $SourceRoot 'installer\nas\install-revagent-local-bootstrap.ps1'
    if ((Get-Sha256Hex -Path $installerSource) -ne $ExpectedInstallerSha256) { throw "Bootstrap refresh installer changed before elevation." }

    $programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    $productRoot = Join-Path $programData 'DPE\revAgent'
    $prestageRoot = Join-Path $productRoot 'prestage'
    New-Item -ItemType Directory -Path $prestageRoot -Force | Out-Null
    Set-AdminOnlyAcl -Path $prestageRoot

    $stagedEvidence = Join-Path $prestageRoot 'bootstrap-prestage-evidence.json'
    $stagedInstaller = Join-Path $prestageRoot 'install-revagent-local-bootstrap.ps1'
    $stagedTrustedKeys = Join-Path $prestageRoot 'release-trusted-keys.json'
    foreach ($target in @($stagedEvidence, $stagedInstaller, $stagedTrustedKeys)) {
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    }
    Copy-Item -LiteralPath $EvidenceSource -Destination $stagedEvidence -Force
    Copy-Item -LiteralPath $installerSource -Destination $stagedInstaller -Force
    Copy-Item -LiteralPath $TrustedKeysSource -Destination $stagedTrustedKeys -Force
    foreach ($target in @($stagedEvidence, $stagedInstaller, $stagedTrustedKeys)) { Set-AdminOnlyAcl -Path $target }

    & $stagedInstaller `
        -RepoRoot $SourceRoot `
        -ReleaseRoot $ReleaseRoot `
        -TrustedKeysPath $stagedTrustedKeys `
        -ExpectedHashesPath $stagedEvidence `
        -ConfirmIndependentlyAuthenticatedSource | Out-Host
    exit 0
}

if (Test-IsAdmin) {
    throw "Start this refresh normally, not as administrator. It will request administrator permission for the protected refresh phase."
}

$programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$bootstrapStatePath = Join-Path $programData 'DPE\revAgent\bootstrap\bootstrap-state.json'
if (-not (Test-Path -LiteralPath $bootstrapStatePath -PathType Leaf)) {
    Write-Host "No protected local bootstrap was found. Preparing first-time revAgent bootstrap..."
    $cleanInstall = New-CleanInstallBootstrapInput
    Write-Host "Requesting administrator approval to install the protected local bootstrap..."
    Start-ElevatedApply `
        -SourceRoot ([string]$cleanInstall.SourceRoot) `
        -EvidenceSource ([string]$cleanInstall.EvidenceSource) `
        -EvidenceSha256 ([string]$cleanInstall.EvidenceSha256) `
        -InstallerSha256 ([string]$cleanInstall.InstallerSha256) `
        -TrustedKeysSource ([string]$cleanInstall.TrustedKeysSource)

    Write-Host "Protected local bootstrap installed. Starting revAgent updater..."
    $localLauncher = Join-Path $programData 'DPE\revAgent\bootstrap\Start-revAgent-Update.cmd'
    Start-Process -FilePath $localLauncher -WorkingDirectory (Split-Path -Parent $localLauncher) | Out-Null
    exit 0
}

$bootstrap = Get-ProtectedBootstrapState
$trustedKeys = Join-Path $bootstrap.root ([string]$bootstrap.state.files.trustedKeys.relativePath)
$integrity = Join-Path $bootstrap.root ([string]$bootstrap.state.files.distributionIntegrity.relativePath)
$snapshotModulePath = Join-Path $bootstrap.root ([string]$bootstrap.state.files.releaseSnapshot.relativePath)

$releaseSnapshotModule = Import-Module $snapshotModulePath -Force -PassThru
$newInboxCommand = Get-Command ("{0}\New-RevAgentAuthenticatedReleaseInbox" -f $releaseSnapshotModule.Name) -ErrorAction Stop
$highestAcceptedReleaseSequence = [long]0
foreach ($value in @($bootstrap.state.release.releaseSequence, $bootstrap.state.release.highestAcceptedReleaseSequence)) {
    $candidate = [long]0
    if ($null -ne $value -and [long]::TryParse([string]$value, [ref]$candidate)) {
        $highestAcceptedReleaseSequence = [Math]::Max($highestAcceptedReleaseSequence, $candidate)
    }
}

Write-Host "Verifying signed revAgent stable release..."
$inbox = & $newInboxCommand `
    -ReleaseRoot $ReleaseRoot `
    -Channel $Channel `
    -TrustedKeysPath $trustedKeys `
    -IntegrityModulePath $integrity `
    -HighestAcceptedReleaseSequence $highestAcceptedReleaseSequence
if ($null -eq $inbox -or [string]::IsNullOrWhiteSpace([string]$inbox.inboxRoot)) {
    throw "Signed release inbox acquisition did not return an authenticated local inbox."
}

$packagePath = [IO.Path]::GetFullPath((Join-Path ([string]$inbox.inboxRoot) ([string]$inbox.release.packageRelativePath)))
$sourceRoot = Join-Path $env:TEMP ("revagent-bootstrap-refresh-source-" + [Guid]::NewGuid().ToString('N'))
$evidencePath = Join-Path $env:TEMP ("revagent-bootstrap-refresh-evidence-" + [Guid]::NewGuid().ToString('N') + ".json")
New-Item -ItemType Directory -Path $sourceRoot -Force | Out-Null
Expand-Archive -LiteralPath $packagePath -DestinationPath $sourceRoot -Force

Write-Host "Preparing authenticated bootstrap refresh evidence..."
$evidenceResult = & (Join-Path $sourceRoot 'installer\nas\New-RevAgentBootstrapPrestageEvidence.ps1') `
    -ReleaseRoot $ReleaseRoot `
    -TrustedKeysPath $trustedKeys `
    -OutputPath $evidencePath `
    -RepoRoot $sourceRoot `
    -Channel stable
$evidence = Get-Content -Raw -LiteralPath $evidencePath | ConvertFrom-Json
if (-not [bool]$evidence.release.signatureVerified -or -not (Test-RevAgentStringEquals -Left ([string]$evidence.release.channel) -Right 'stable')) {
    throw "Bootstrap refresh evidence does not prove a signed stable release."
}

Write-Host "Requesting administrator approval to refresh the protected local bootstrap..."
Start-ElevatedApply `
    -SourceRoot $sourceRoot `
    -EvidenceSource $evidencePath `
    -EvidenceSha256 ([string]$evidenceResult.outputSha256) `
    -InstallerSha256 ([string]$evidence.localBootstrapInstallerScript) `
    -TrustedKeysSource $trustedKeys

Write-Host "Protected local bootstrap refreshed. Starting revAgent updater..."
$localLauncher = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'DPE\revAgent\bootstrap\Start-revAgent-Update.cmd'
Start-Process -FilePath $localLauncher -WorkingDirectory (Split-Path -Parent $localLauncher) | Out-Null
