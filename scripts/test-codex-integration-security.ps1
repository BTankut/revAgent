<#
.SYNOPSIS
    Deterministic, non-admin security and compatibility tests for Codex integration.

.DESCRIPTION
    Exercises the exported RevAgent.CodexRegistration contract with disposable
    user roots and fake processes. It also pins the P0 machine/user phase split
    so a future updater change cannot silently reintroduce elevated user-root
    execution or writes.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
$inheritedPsModulePath = [Environment]::GetEnvironmentVariable("PSModulePath", "Process")

function Resolve-RevAgentTestTrustedArchiveManifest {
    param(
        [Parameter(Mandatory = $true)][string]$PsHomeModulesRoot,
        [Parameter(Mandatory = $true)][string[]]$ProgramFilesModuleRoots
    )

    $searchedPaths = [System.Collections.Generic.List[string]]::new()
    $psHomeManifest = [IO.Path]::Combine($PsHomeModulesRoot, 'Microsoft.PowerShell.Archive', 'Microsoft.PowerShell.Archive.psd1')
    [void]$searchedPaths.Add($psHomeManifest)
    if ([IO.File]::Exists($psHomeManifest)) { return [IO.Path]::GetFullPath($psHomeManifest) }

    foreach ($moduleRoot in @($ProgramFilesModuleRoots | Select-Object -Unique)) {
        if ([string]::IsNullOrWhiteSpace($moduleRoot)) { continue }
        $fullModuleRoot = [IO.Path]::GetFullPath($moduleRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $archiveRoot = [IO.Path]::Combine($fullModuleRoot, 'Microsoft.PowerShell.Archive')
        $directManifest = [IO.Path]::Combine($archiveRoot, 'Microsoft.PowerShell.Archive.psd1')
        [void]$searchedPaths.Add($directManifest)
        if (-not [IO.Directory]::Exists($fullModuleRoot)) { continue }
        if (([IO.File]::GetAttributes($fullModuleRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Trusted PowerShell module root is a reparse point: $fullModuleRoot" }
        if (-not [IO.Directory]::Exists($archiveRoot)) { continue }
        if (([IO.File]::GetAttributes($archiveRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Trusted PowerShell Archive module root is a reparse point: $archiveRoot" }
        if ([IO.File]::Exists($directManifest)) { return $directManifest }

        $versionedManifests = [System.Collections.Generic.List[object]]::new()
        foreach ($versionDirectory in [IO.Directory]::EnumerateDirectories($archiveRoot)) {
            if (([IO.File]::GetAttributes($versionDirectory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Trusted PowerShell Archive version directory is a reparse point: $versionDirectory" }
            $parsedVersion = $null
            if (-not [version]::TryParse([IO.Path]::GetFileName($versionDirectory), [ref]$parsedVersion)) { continue }
            $manifest = [IO.Path]::Combine($versionDirectory, 'Microsoft.PowerShell.Archive.psd1')
            [void]$searchedPaths.Add($manifest)
            if ([IO.File]::Exists($manifest)) { [void]$versionedManifests.Add([pscustomobject]@{ Version = $parsedVersion; Path = $manifest }) }
        }
        $selected = @($versionedManifests | Sort-Object Version -Descending | Select-Object -First 1)
        if ($selected.Count -eq 1) { return [string]$selected[0].Path }
    }

    throw "Required built-in PowerShell Archive module manifest was not found. Searched paths: $([string]::Join('; ', $searchedPaths.ToArray()))"
}

function Initialize-RevAgentTestTrustedPowerShellModules {
    # A self-hosted runner launched from PowerShell 7 can pass its module roots
    # to a later Windows PowerShell 5.1 step. Sanitize before any cmdlet
    # autoload so PS5 never selects an incompatible PS7 built-in manifest.
    $systemDirectory = [Environment]::SystemDirectory
    $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
    $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    $candidateRoots = [System.Collections.Generic.List[string]]::new()
    $archiveProgramFilesRoots = [System.Collections.Generic.List[string]]::new()
    [void]$candidateRoots.Add([IO.Path]::Combine($PSHOME, 'Modules'))
    [void]$candidateRoots.Add([IO.Path]::Combine($systemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules'))
    foreach ($programFilesRoot in @($programFiles, $programFilesX86)) {
        if ([string]::IsNullOrWhiteSpace($programFilesRoot)) { continue }
        $windowsPowerShellRoot = [IO.Path]::Combine($programFilesRoot, 'WindowsPowerShell', 'Modules')
        [void]$candidateRoots.Add($windowsPowerShellRoot)
        [void]$archiveProgramFilesRoots.Add($windowsPowerShellRoot)
        [void]$candidateRoots.Add([IO.Path]::Combine($programFilesRoot, 'PowerShell', 'Modules'))
    }

    $trustedRoots = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $candidateRoots) {
        $fullPath = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
        if (-not [IO.Directory]::Exists($fullPath) -or -not $seen.Add($fullPath)) { continue }
        if (([IO.File]::GetAttributes($fullPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Trusted PowerShell module root is a reparse point: $fullPath"
        }
        [void]$trustedRoots.Add($fullPath)
    }
    if ($trustedRoots.Count -eq 0) { throw 'No canonical administrator-owned PowerShell module root was found.' }
    $env:PSModulePath = [string]::Join([IO.Path]::PathSeparator, $trustedRoots.ToArray())

    foreach ($moduleName in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security', 'CimCmdlets')) {
        $manifestPath = [IO.Path]::Combine($PSHOME, 'Modules', $moduleName, ($moduleName + '.psd1'))
        if (-not [IO.File]::Exists($manifestPath)) { throw "Required built-in PowerShell module manifest was not found: $manifestPath" }
        Microsoft.PowerShell.Core\Import-Module -Name $manifestPath -Force -ErrorAction Stop
    }
    $archiveManifestPath = Resolve-RevAgentTestTrustedArchiveManifest -PsHomeModulesRoot ([IO.Path]::Combine($PSHOME, 'Modules')) -ProgramFilesModuleRoots $archiveProgramFilesRoots.ToArray()
    Microsoft.PowerShell.Core\Import-Module -Name $archiveManifestPath -Force -ErrorAction Stop
    return $env:PSModulePath
}

$trustedPsModulePath = Initialize-RevAgentTestTrustedPowerShellModules

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$modulePath = Join-Path $RepoRoot "installer\lib\RevAgent.CodexRegistration.psm1"
$permissionsModulePath = Join-Path $RepoRoot "installer\lib\RevAgent.Permissions.psm1"
$scheduledTaskModulePath = Join-Path $RepoRoot "installer\lib\RevAgent.ScheduledTask.psm1"
Import-Module $modulePath -Force
Import-Module $permissionsModulePath -Force
Import-Module $scheduledTaskModulePath -Force
$codexRegistrationModule = Get-Module | Where-Object { $_.Path -and [string]::Equals($_.Path, $modulePath, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param([object]$Actual, [object]$Expected, [string]$Message)
    if ($Actual -ne $Expected) { throw "$Message Expected '$Expected', got '$Actual'." }
}

function Assert-ThrowsLike {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $caught = $null
    try { & $Action }
    catch { $caught = $_ }
    if ($null -eq $caught) { throw "$Message Expected an exception." }
    if (-not ([string]$caught.Exception.Message -match $Pattern)) {
        throw "$Message Unexpected exception: $($caught.Exception.Message)"
    }
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

if (Test-RevAgentProcessElevated) {
    throw "This security suite must run unelevated so it exercises the real user-integration boundary."
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("revagent-codex-security-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
$previousCodexHome = [Environment]::GetEnvironmentVariable("CODEX_HOME", "Process")
$previousPath = $env:PATH
$previousPsModulePath = $trustedPsModulePath
$profileListFixtureRoot = "Registry::HKEY_CURRENT_USER\Software\revAgent\Tests\InteractiveIdentity-$([Guid]::NewGuid().ToString('N'))"

try {
    Write-Host "Test CODEX_HOME explicit, environment, and default resolution"
    $profileRoot = Join-Path $tempRoot "profile"
    New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null
    Remove-Item Env:\CODEX_HOME -ErrorAction SilentlyContinue
    $defaultHome = Resolve-RevAgentCodexHome -UserProfileRoot $profileRoot
    Assert-Equal $defaultHome.source "default" "Default CODEX_HOME source is incorrect."
    Assert-Equal $defaultHome.path (Join-Path $profileRoot ".codex") "Default CODEX_HOME path is incorrect."

    $environmentPath = Join-Path $profileRoot "codex-from-env"
    $env:CODEX_HOME = $environmentPath
    $environmentHome = Resolve-RevAgentCodexHome -UserProfileRoot $profileRoot
    Assert-Equal $environmentHome.source "environment" "Environment CODEX_HOME was not honored."
    Assert-Equal $environmentHome.path $environmentPath "Environment CODEX_HOME path is incorrect."

    $explicitPath = Join-Path $profileRoot "codex-explicit"
    $explicitHome = Resolve-RevAgentCodexHome -UserProfileRoot $profileRoot -CodexHome $explicitPath
    Assert-Equal $explicitHome.source "explicit" "Explicit CODEX_HOME must override the environment."
    Assert-Equal $explicitHome.path $explicitPath "Explicit CODEX_HOME path is incorrect."
    Remove-Item Env:\CODEX_HOME -ErrorAction SilentlyContinue

    Write-Host "Test copied signed Node and unsigned Codex candidates are rejected without execution"
    $programFilesNode = Join-Path $env:ProgramFiles "nodejs\node.exe"
    Assert-True (Test-Path -LiteralPath $programFilesNode -PathType Leaf) "CI requires the repository's Program Files Node runtime."
    $copiedNode = Join-Path $profileRoot "AppData\Local\malicious\node.exe"
    New-Item -ItemType Directory -Path (Split-Path -Parent $copiedNode) -Force | Out-Null
    Copy-Item -LiteralPath $programFilesNode -Destination $copiedNode -Force
    $nodeResolution = Resolve-RevAgentNodeRuntime -ExplicitPath $copiedNode
    $copiedCandidate = @($nodeResolution.candidates | Where-Object { [string]::Equals($_.path, $copiedNode, [StringComparison]::OrdinalIgnoreCase) }) | Select-Object -First 1
    Assert-True ($null -ne $copiedCandidate) "Copied signed Node fixture was not audited."
    Assert-True (-not [bool]$copiedCandidate.systemManaged -and -not [bool]$copiedCandidate.ready) "A signed Node copy under a user root must never be executable/ready."
    Assert-Equal $copiedCandidate.versionProbeExitCode -1 "User-root Node must not receive a version execution probe."
    Assert-Equal $copiedCandidate.capabilityProbeExitCode -1 "User-root Node must not receive a capability execution probe."
    Assert-True ([bool]$nodeResolution.selected.systemManaged) "The selected Node runtime must be system managed."
    Assert-True ([bool]$nodeResolution.selected.exactCanonical -and [bool]$nodeResolution.selected.originAttested -and [bool]$nodeResolution.selected.protectedPath) "The selected Node runtime must carry exact canonical origin and protected-path attestations."
    Assert-Equal $nodeResolution.selected.linkCount 1 "The selected Node runtime must not be hard-linked."
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$nodeResolution.selected.fileIdentity) -and $nodeResolution.selected.sha256 -match '^[0-9A-F]{64}$') "The selected Node runtime is missing stable identity/hash evidence."
    Assert-Equal $nodeResolution.selected.signerSubject "CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US" "Node signer must match the exact pinned OpenJS subject."
    $tamperedNodeAttestation = $nodeResolution.selected | Select-Object *
    $tamperedNodeAttestation.sha256 = ('0' * 64)
    Assert-ThrowsLike -Action {
        & $codexRegistrationModule { param($Candidate) Assert-RevAgentNodeExecutableUnchanged -Candidate $Candidate | Out-Null } $tamperedNodeAttestation
    } -Pattern "identity/protection changed after attestation" -Message "Node must be identity/hash re-attested before later handshake process starts."
    $canonicalInstallRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'DPE\revAgent'
    Assert-ThrowsLike -Action {
        & $codexRegistrationModule {
            param($FixturePath, $InstallRoot)
            Get-RevAgentProtectedMachineFileAttestation -Path $FixturePath -InstallRoot $InstallRoot | Out-Null
        } $copiedNode $canonicalInstallRoot
    } -Pattern "outside its trusted root" -Message "MCP execution evidence must reject entrypoints outside InstallRoot."

    $isolatedLocalAppData = Join-Path $tempRoot "isolated-localappdata"
    New-Item -ItemType Directory -Path $isolatedLocalAppData -Force | Out-Null
    $unsignedMarker = Join-Path $tempRoot "unsigned-cli-executed.txt"
    $unsignedCli = Join-Path $isolatedLocalAppData "malicious-codex.cmd"
    Write-Utf8NoBom -Path $unsignedCli -Content "@echo off`r`necho executed>`"$unsignedMarker`"`r`necho codex-cli 999`r`n"
    $env:PATH = (Join-Path $env:WINDIR "System32")
    $installedUnifiedPackages = @(Appx\Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue)
    $expectedUnsignedFailure = if ($installedUnifiedPackages.Count -gt 0) { 'No Codex CLI candidate passed origin' } else { 'No OpenAI\.Codex Store package is installed' }
    $isolatedUnsignedInstallRoot = Join-Path $tempRoot "isolated-install-root-without-protected-codex"
    Assert-ThrowsLike -Action {
        Resolve-RevAgentCodexCli -ExplicitPath $unsignedCli -CodexHome $defaultHome.path -InstallRoot $isolatedUnsignedInstallRoot -LocalAppData $isolatedLocalAppData | Out-Null
    } -Pattern $expectedUnsignedFailure -Message "Unsigned Codex CLI or a package-present attestation failure must fail closed without a user-writable fallback."
    Assert-True (-not (Test-Path -LiteralPath $unsignedMarker)) "Unsigned Codex CLI fixture was executed."
    $env:PATH = $previousPath

    $cmdProbeFixture = Join-Path $tempRoot "argument-probe.cmd"
    Write-Utf8NoBom -Path $cmdProbeFixture -Content "@echo off`r`necho %~1^|%~2`r`n"
    $codexRegistrationModule = Get-Module | Where-Object { $_.Path -and [string]::Equals($_.Path, $modulePath, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    $cmdProbe = & $codexRegistrationModule {
        param($FixturePath)
        Invoke-RevAgentProcessProbe -FilePath $FixturePath -Arguments @('alpha beta', 'gamma')
    } $cmdProbeFixture
    Assert-Equal $cmdProbe.exitCode 0 "CMD capability probe wrapper failed."
    Assert-Equal $cmdProbe.stdout "alpha beta|gamma" "CMD capability probe wrapper corrupted arguments."

    Write-Host "Test native suspended probe uses the executable directory, not inherited repo/user CWD"
    $cwdProbe = & $codexRegistrationModule {
        param($NodePath)
        Invoke-RevAgentProcessProbe -FilePath $NodePath -Arguments @('-e', 'process.stdout.write(process.cwd())')
    } $programFilesNode
    Assert-Equal $cwdProbe.exitCode 0 "Protected Node CWD probe failed."
    Assert-True ([string]::Equals([IO.Path]::GetFullPath($cwdProbe.stdout), [IO.Path]::GetFullPath((Split-Path -Parent $programFilesNode)), [StringComparison]::OrdinalIgnoreCase)) "Probe inherited a user-writable/repository CWD instead of the exact executable directory."

    Write-Host "Test bounded probe cleanup unlinks reparse/hardlink children without target traversal"
    $cleanupExternalTarget = Join-Path $tempRoot 'probe-cleanup-external-target'
    New-Item -ItemType Directory -Path $cleanupExternalTarget -Force | Out-Null
    $cleanupExternalSentinel = Join-Path $cleanupExternalTarget 'sentinel.txt'
    Write-Utf8NoBom -Path $cleanupExternalSentinel -Content 'must-survive'
    $cleanupExternalHardlinkTarget = Join-Path $tempRoot 'probe-cleanup-hardlink-target.txt'
    Write-Utf8NoBom -Path $cleanupExternalHardlinkTarget -Content 'hardlink-target-must-survive'
    $probeCleanupRoot = Join-Path $profileRoot 'probe-cleanup-root'
    New-Item -ItemType Directory -Path $probeCleanupRoot -Force | Out-Null
    $probeCleanupGuard = & $codexRegistrationModule {
        param($Path, $AllowedRoot)
        Open-RevAgentSafeUserProbeRootGuard -Path $Path -AllowedRoot $AllowedRoot
    } $probeCleanupRoot $profileRoot
    New-Item -ItemType Directory -Path (Join-Path $probeCleanupRoot 'nested') -Force | Out-Null
    Write-Utf8NoBom -Path (Join-Path $probeCleanupRoot 'nested\owned.txt') -Content 'owned'
    New-Item -ItemType Junction -Path (Join-Path $probeCleanupRoot 'external-junction') -Target $cleanupExternalTarget | Out-Null
    New-Item -ItemType HardLink -Path (Join-Path $probeCleanupRoot 'external-hardlink.txt') -Target $cleanupExternalHardlinkTarget | Out-Null
    & $codexRegistrationModule {
        param($Guard)
        Close-RevAgentSafeUserProbeRootGuard -Guard $Guard -Remove
    } $probeCleanupGuard
    Assert-True (-not (Test-Path -LiteralPath $probeCleanupRoot)) "Bounded probe cleanup left its exact root behind."
    Assert-Equal (Get-Content -Raw -LiteralPath $cleanupExternalSentinel) 'must-survive' "Probe cleanup traversed a child junction target."
    Assert-Equal (Get-Content -Raw -LiteralPath $cleanupExternalHardlinkTarget) 'hardlink-target-must-survive' "Probe cleanup modified a hardlink target instead of unlinking its owned entry."
    $probeRootJunction = Join-Path $profileRoot 'probe-root-junction'
    New-Item -ItemType Junction -Path $probeRootJunction -Target $cleanupExternalTarget | Out-Null
    Assert-ThrowsLike -Action {
        & $codexRegistrationModule {
            param($Path, $AllowedRoot)
            Open-RevAgentSafeUserProbeRootGuard -Path $Path -AllowedRoot $AllowedRoot | Out-Null
        } $probeRootJunction $profileRoot
    } -Pattern 'reparse point|reparse-point' -Message 'Probe root guard must reject a root junction before execution.'
    [IO.Directory]::Delete($probeRootJunction, $false)

    Write-Host "Test probe timeout kills the complete job before executable guards are released"
    $probeLockEvidence = Join-Path $tempRoot 'probe-lock-evidence.txt'
    $probeOrphanMarker = Join-Path $tempRoot 'probe-orphan-survived.txt'
    $probeChildPidPath = Join-Path $tempRoot 'probe-child.pid'
    $probeTreeFixture = Join-Path $tempRoot 'probe-tree-fixture.js'
    $probeTreeText = @'
const fs = require("fs");
const { spawn } = require("child_process");
const lockEvidence = process.argv[2];
const orphanMarker = process.argv[3];
const childPidPath = process.argv[4];
try {
  fs.renameSync(process.execPath, process.execPath + ".swapped");
  fs.renameSync(process.execPath + ".swapped", process.execPath);
  fs.writeFileSync(lockEvidence, "rename-succeeded");
} catch (error) {
  fs.writeFileSync(lockEvidence, "rename-blocked");
}
const payload = `const fs=require("fs");setTimeout(()=>fs.writeFileSync(${JSON.stringify(orphanMarker)},"survived"),1800);setInterval(()=>{},1000);`;
const child = spawn(process.execPath, ["-e", payload], { stdio: "ignore" });
fs.writeFileSync(childPidPath, String(child.pid));
setInterval(() => {}, 1000);
'@
    Write-Utf8NoBom -Path $probeTreeFixture -Content $probeTreeText
    $copiedNodeIdentity = & $codexRegistrationModule { param($Path) Get-RevAgentFileIdentity -Path $Path } $copiedNode
    $copiedNodeSha256 = Get-RevAgentFileSha256 -Path $copiedNode
    $probeTimeout = & $codexRegistrationModule {
        param($NodePath, $AllowedRoot, $Identity, $Sha256, $Fixture, $LockEvidence, $OrphanMarker, $ChildPidPath)
        Invoke-RevAgentIdentityLockedProcessProbe -Path $NodePath -AllowedRoot $AllowedRoot `
            -ExpectedFileIdentity $Identity -ExpectedSha256 $Sha256 -ExpectedSignerSubject $script:RevAgentOpenJsSignerSubject `
            -Arguments @($Fixture, $LockEvidence, $OrphanMarker, $ChildPidPath) -TimeoutSeconds 1
    } $copiedNode $profileRoot $copiedNodeIdentity $copiedNodeSha256 $probeTreeFixture $probeLockEvidence $probeOrphanMarker $probeChildPidPath
    Assert-True ([bool]$probeTimeout.timedOut -and [bool]$probeTimeout.processTreeTerminated) "Timed-out probe did not confirm complete job termination before returning."
    Assert-Equal (Get-Content -Raw -LiteralPath $probeLockEvidence) 'rename-blocked' "The executable pathname guard was not held while the process ran."
    $probeChildPid = [int](Get-Content -Raw -LiteralPath $probeChildPidPath)
    Start-Sleep -Milliseconds 2200
    Assert-True (-not (Test-Path -LiteralPath $probeOrphanMarker)) "A timed-out probe child survived the kill-on-close job."
    Assert-True ($null -eq (Get-Process -Id $probeChildPid -ErrorAction SilentlyContinue)) "A timed-out probe child process remained alive after guard release."
    $copiedNodeHeld = $copiedNode + '.post-cleanup'
    Move-Item -LiteralPath $copiedNode -Destination $copiedNodeHeld -ErrorAction Stop
    Move-Item -LiteralPath $copiedNodeHeld -Destination $copiedNode -ErrorAction Stop

    Write-Host "Test immediate child cannot escape before job assignment when parent exits with an error"
    $earlyChildMarker = Join-Path $tempRoot 'early-child-escaped.txt'
    $earlyChildPidPath = Join-Path $tempRoot 'early-child.pid'
    $earlyChildFixture = Join-Path $tempRoot 'early-child-fixture.js'
    $earlyChildText = @'
const fs = require("fs");
const { spawn } = require("child_process");
const marker = process.argv[2];
const pidPath = process.argv[3];
const payload = `const fs=require("fs");setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},"escaped"),700);setInterval(()=>{},1000);`;
const child = spawn(process.execPath, ["-e", payload], { stdio: "ignore" });
fs.writeFileSync(pidPath, String(child.pid));
process.exit(23);
'@
    Write-Utf8NoBom -Path $earlyChildFixture -Content $earlyChildText
    $earlyChildResult = & $codexRegistrationModule {
        param($NodePath, $Fixture, $Marker, $PidPath)
        Invoke-RevAgentProcessProbe -FilePath $NodePath -Arguments @($Fixture, $Marker, $PidPath) -TimeoutSeconds 5
    } $programFilesNode $earlyChildFixture $earlyChildMarker $earlyChildPidPath
    Assert-Equal $earlyChildResult.exitCode 23 "Immediate-child fixture did not preserve the parent's error exit code."
    Assert-True ([bool]$earlyChildResult.processTreeTerminated) "Immediate-child error path did not drain the assigned process job."
    Assert-True (Test-Path -LiteralPath $earlyChildPidPath -PathType Leaf) "Immediate-child fixture did not publish its child PID."
    $earlyChildPid = [int](Get-Content -Raw -LiteralPath $earlyChildPidPath)
    Start-Sleep -Milliseconds 1100
    Assert-True (-not (Test-Path -LiteralPath $earlyChildMarker)) "A child escaped during the pre-assignment Process.Start race."
    Assert-True ($null -eq (Get-Process -Id $earlyChildPid -ErrorAction SilentlyContinue)) "Immediate child remained alive after the error path released its guards."

    Write-Host "Test semantic-newest Codex selection is independent of origin score and path order"
    $semanticSelection = & $codexRegistrationModule {
        $rows = @(
            [pscustomobject]@{ ready = $true; versionMajor = 0; versionMinor = 130; versionPatch = 0; versionIsPrerelease = $true; versionPrerelease = 'alpha.5'; versionPrereleaseNumber = 5; explicitOverride = $false; score = 999; path = 'A:\older\codex.exe' },
            [pscustomobject]@{ ready = $true; versionMajor = 0; versionMinor = 144; versionPatch = 0; versionIsPrerelease = $true; versionPrerelease = 'alpha.4'; versionPrereleaseNumber = 4; explicitOverride = $false; score = 1; path = 'Z:\newer\codex.exe' }
        )
        return (Select-RevAgentCodexCandidate -Candidates $rows)[0]
    }
    Assert-Equal $semanticSelection.path 'Z:\newer\codex.exe' "Codex selection silently preferred score/path over the newest semantic version."
    $prereleaseSelection = & $codexRegistrationModule {
        $rows = @(
            [pscustomobject]@{ ready = $true; versionMajor = 1; versionMinor = 0; versionPatch = 0; versionPrerelease = 'alpha.999'; explicitOverride = $false; score = 999; path = 'A:\alpha\codex.exe' },
            [pscustomobject]@{ ready = $true; versionMajor = 1; versionMinor = 0; versionPatch = 0; versionPrerelease = 'beta.1'; explicitOverride = $false; score = 1; path = 'Z:\beta\codex.exe' }
        )
        return (Select-RevAgentCodexCandidate -Candidates $rows)[0]
    }
    Assert-Equal $prereleaseSelection.path 'Z:\beta\codex.exe' "Codex selection did not apply semantic prerelease precedence."

    Write-Host "Test unified ChatGPT package CLI layout uses an exact non-recursive allowlist"
    $fixtureWindowsApps = Join-Path $tempRoot 'fixture-WindowsApps'
    $fixturePackageFullName = 'OpenAI.Codex_26.707.6957.0_x64__2p2nqsd0c76g0'
    $fixtureInstallLocation = Join-Path $fixtureWindowsApps $fixturePackageFullName
    $fixturePackageCli = Join-Path $fixtureInstallLocation 'app\resources\codex.exe'
    $fixtureNestedCli = Join-Path $fixtureInstallLocation 'app\resources\nested\codex.exe'
    Write-Utf8NoBom -Path $fixturePackageCli -Content 'supported package CLI layout fixture'
    Write-Utf8NoBom -Path $fixtureNestedCli -Content 'must never be discovered recursively'
    $fixturePackage = [pscustomobject][ordered]@{
        Name = 'OpenAI.Codex'; Version = [version]'26.707.6957.0'; PackageFullName = $fixturePackageFullName
        PackageFamilyName = 'OpenAI.Codex_2p2nqsd0c76g0'; Publisher = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'
        PublisherId = '2p2nqsd0c76g0'; SignatureKind = 'Store'; Status = 'Ok'; Architecture = 'X64'
        InstallLocation = $fixtureInstallLocation; IsFramework = $false; IsResourcePackage = $false
    }
    $fixtureLayout = & $codexRegistrationModule {
        param($Package, $WindowsAppsRoot)
        Resolve-RevAgentUnifiedCodexPackageCliLayout -Package $Package -WindowsAppsRoot $WindowsAppsRoot
    } $fixturePackage $fixtureWindowsApps
    Assert-True ([bool]$fixtureLayout.success) "The supported app\\resources\\codex.exe package layout was not resolved."
    Assert-Equal $fixtureLayout.layoutId 'chatgpt-unified-app-resources-v1' "The unified package layout id drifted."
    Assert-Equal $fixtureLayout.relativePath 'app\resources\codex.exe' "The unified package-relative CLI path drifted."
    Assert-Equal $fixtureLayout.packageCliPath $fixturePackageCli "The package resolver did not return the exact allowlisted CLI path."
    $fixtureHeldCli = $fixturePackageCli + '.held'
    Move-Item -LiteralPath $fixturePackageCli -Destination $fixtureHeldCli
    try {
        $recursiveOnlyLayout = & $codexRegistrationModule {
            param($Package, $WindowsAppsRoot)
            Resolve-RevAgentUnifiedCodexPackageCliLayout -Package $Package -WindowsAppsRoot $WindowsAppsRoot
        } $fixturePackage $fixtureWindowsApps
        Assert-True (-not [bool]$recursiveOnlyLayout.success) "A nested codex.exe escaped the exact package-relative layout allowlist."
        Assert-Equal $recursiveOnlyLayout.reason 'package_cli_missing' "A nested package CLI failed for the wrong reason."
    }
    finally {
        Move-Item -LiteralPath $fixtureHeldCli -Destination $fixturePackageCli
    }

    Write-Host "Test AppX query error and confirmed absence both fail closed before fallback execution"
    $appxQueryFailure = & $codexRegistrationModule {
        param($LocalAppData)
        Get-RevAgentActiveUnifiedCodexCliAttestation -LocalAppData $LocalAppData -PackageQuery { throw 'injected Get-AppxPackage failure' }
    } $isolatedLocalAppData
    Assert-True (-not [bool]$appxQueryFailure.querySucceeded -and -not [bool]$appxQueryFailure.absenceConfirmed) "Injected Get-AppxPackage failure was misclassified as package absence."
    Assert-True ($appxQueryFailure.reason -match 'attestation_error: injected Get-AppxPackage failure') "Injected Get-AppxPackage failure did not preserve fail-closed evidence."
    Assert-ThrowsLike -Action {
        & $codexRegistrationModule {
            param($CodexHome, $LocalAppData)
            Resolve-RevAgentCodexCli -CodexHome $CodexHome -LocalAppData $LocalAppData -PackageQuery { throw 'injected Get-AppxPackage failure' } | Out-Null
        } $defaultHome.path $isolatedLocalAppData
    } -Pattern 'Store package query failed closed.*injected Get-AppxPackage failure' -Message "An AppX query error must never become Store absence or authorize standalone/PATH execution."
    $appxConfirmedAbsence = & $codexRegistrationModule {
        param($LocalAppData)
        Get-RevAgentActiveUnifiedCodexCliAttestation -LocalAppData $LocalAppData -PackageQuery { @() }
    } $isolatedLocalAppData
    Assert-True ([bool]$appxConfirmedAbsence.querySucceeded -and [bool]$appxConfirmedAbsence.absenceConfirmed -and -not [bool]$appxConfirmedAbsence.available) "An explicit successful zero-package query did not produce confirmed absence."
    Assert-ThrowsLike -Action {
        & $codexRegistrationModule {
            param($CodexHome, $LocalAppData)
            Resolve-RevAgentCodexCli -CodexHome $CodexHome -LocalAppData $LocalAppData -PackageQuery { @() } | Out-Null
        } $defaultHome.path $isolatedLocalAppData
    } -Pattern 'No OpenAI\.Codex Store package is installed.*standalone/PATH Codex execution is disabled' -Message "Confirmed Store absence must require the Store package instead of executing user-writable fallback state."
    $multiplePackageFailure = & $codexRegistrationModule {
        param($LocalAppData, $Package)
        Get-RevAgentActiveUnifiedCodexCliAttestation -LocalAppData $LocalAppData -PackageQuery { @($Package, $Package) }
    } $isolatedLocalAppData $fixturePackage
    Assert-True ([bool]$multiplePackageFailure.querySucceeded -and [int]$multiplePackageFailure.packageCount -eq 2 -and -not [bool]$multiplePackageFailure.success) "Multiple active Store packages did not fail closed."
    Assert-Equal $multiplePackageFailure.reason 'multiple_active_store_packages_fail_closed' "Multiple active Store packages failed for the wrong reason."

    Write-Host "Test Store-absent standalone policy is disabled without an authenticated receipt"
    $standalonePolicy = & $codexRegistrationModule {
        $attestation = [pscustomobject]@{ safe = $true; openAiSigned = $true; linkCount = 1; fileIdentity = 'fixture-id'; sha256 = ('A' * 64) }
        $standalone = [pscustomobject]@{ success = $true; packageLayoutAttested = $true; codexFileIdentity = 'fixture-id'; codexSha256 = ('A' * 64) }
        [pscustomobject]@{
            packageAbsentExact = Get-RevAgentCodexOriginTrustDecision -ActiveUnifiedAvailable $false -ActiveBundleMatch $false -StandaloneMatch $true -Attestation $attestation -StandaloneAttestation $standalone
            packagePresentExact = Get-RevAgentCodexOriginTrustDecision -ActiveUnifiedAvailable $true -ActiveBundleMatch $false -StandaloneMatch $true -Attestation $attestation -StandaloneAttestation $standalone
            packageAbsentLegacy = Get-RevAgentCodexOriginTrustDecision -ActiveUnifiedAvailable $false -ActiveBundleMatch $false -StandaloneMatch $false -Attestation $attestation -StandaloneAttestation $standalone
        }
    }
    Assert-Equal $standalonePolicy.packageAbsentExact.origin 'unattested' "A forged exact standalone layout received an executable origin."
    Assert-True (-not [bool]$standalonePolicy.packageAbsentExact.trusted -and -not [bool]$standalonePolicy.packageAbsentExact.packageBound) "A user-authored standalone layout was treated as an authenticated package receipt."
    Assert-True (-not [bool]$standalonePolicy.packagePresentExact.trusted) "Standalone fallback remained trusted while the Store package was present."
    Assert-True (-not [bool]$standalonePolicy.packageAbsentLegacy.trusted) "A non-exact/legacy standalone path escaped the package-absent allowlist."

    Write-Host "Test active Store package attestation and user-writable mirror diagnostics"
    $activeUnified = & $codexRegistrationModule { Get-RevAgentActiveUnifiedCodexCliAttestation }
    if ($installedUnifiedPackages.Count -gt 0 -and -not $activeUnified.success) {
        throw "Installed OpenAI.Codex package attestation failed and must never be skipped. reason=$($activeUnified.reason) package=$($activeUnified.packageFullName)"
    }
    if ($installedUnifiedPackages.Count -gt 0) {
        Assert-True ([bool]$activeUnified.packageIdentityAttested -and [bool]$activeUnified.manifestIdentityAttested -and [bool]$activeUnified.blockMapAttested) "The installed unified package lacks signed identity/manifest/block-map evidence."
        Assert-Equal $activeUnified.packageFamilyName 'OpenAI.Codex_2p2nqsd0c76g0' "The installed package family is not pinned."
        Assert-Equal $activeUnified.packagePublisher 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B' "The installed Store package publisher is not pinned."
        Assert-Equal $activeUnified.packageSignatureKind 'Store' "The installed unified package is not Store-signed."
        Assert-Equal $activeUnified.packageSignatureStatus 'Valid' "The installed package signature is not valid."
        Assert-Equal $activeUnified.packageCliRelativePath 'app\resources\codex.exe' "The live package CLI is not at the supported exact relative path."
        Assert-Equal $activeUnified.packageCliPath (Join-Path $activeUnified.installLocation $activeUnified.packageCliRelativePath) "The live package CLI path is not bound to the active package root."
        Assert-True ([bool]$activeUnified.packageCliProtected -and [int]$activeUnified.packageCliLinkCount -ge 1) "The package CLI is writable/unprotected or lacks a valid file identity."
        Assert-True ($activeUnified.packageCliSha256 -match '^[0-9A-F]{64}$' -and [int]$activeUnified.blockMapBlockCount -gt 0) "The package CLI is missing full signed block-map/SHA-256 evidence."
        Assert-True ([bool]$activeUnified.localMirrorDiagnosticOnly) "LocalAppData mirror state became an executable origin instead of diagnostic evidence."
        if (-not [string]::IsNullOrWhiteSpace([string]$activeUnified.userCliPath)) {
            Assert-True ($activeUnified.userCliPath -match '(?i)\\OpenAI\\Codex\\bin\\[0-9a-f]{16}\\codex\.exe$') "The diagnostic user mirror is not the exact hash-qualified unified bundle path."
        }

        Write-Host "Test hash-matching LocalAppData mirror plus app-local dbghelp.dll remains diagnostic-only"
        $maliciousMirrorRoot = Join-Path $isolatedLocalAppData 'OpenAI\Codex\bin\deadbeefdeadbeef'
        New-Item -ItemType Directory -Path $maliciousMirrorRoot -Force | Out-Null
        $maliciousMirrorCli = Join-Path $maliciousMirrorRoot 'codex.exe'
        $maliciousMirrorDll = Join-Path $maliciousMirrorRoot 'dbghelp.dll'
        $maliciousMirrorMarker = Join-Path $tempRoot 'malicious-mirror-executed.txt'
        Copy-Item -LiteralPath $activeUnified.packageCliPath -Destination $maliciousMirrorCli -Force
        Write-Utf8NoBom -Path $maliciousMirrorDll -Content ('invalid app-local DLL fixture; marker=' + $maliciousMirrorMarker)
        $mirrorDiagnostic = & $codexRegistrationModule {
            param($LocalAppData)
            Get-RevAgentActiveUnifiedCodexCliAttestation -LocalAppData $LocalAppData
        } $isolatedLocalAppData
        $maliciousMirrorRow = @($mirrorDiagnostic.candidates | Where-Object { [string]::Equals([string]$_.path, $maliciousMirrorCli, [StringComparison]::OrdinalIgnoreCase) }) | Select-Object -First 1
        Assert-True ($null -ne $maliciousMirrorRow -and [bool]$maliciousMirrorRow.hashMatchesActivePackage -and [bool]$maliciousMirrorRow.diagnosticOnly -and -not [bool]$maliciousMirrorRow.matches) "A hash-matching mirror with app-local DLL state was not confined to diagnostics."
        $maliciousMirrorResolution = $null
        try {
            $maliciousMirrorResolution = Resolve-RevAgentCodexCli -ExplicitPath $maliciousMirrorCli -CodexHome $defaultHome.path -InstallRoot $canonicalInstallRoot -LocalAppData $isolatedLocalAppData
        }
        catch {
            Assert-True ($_.Exception.Message -match 'No Codex CLI candidate passed origin') "Malicious mirror resolution failed for an unexpected reason: $($_.Exception.Message)"
        }
        if ($null -ne $maliciousMirrorResolution) {
            Assert-Equal $maliciousMirrorResolution.selected.origin 'protected-active-store-copy' "A malicious explicit mirror displaced the protected Store copy."
            Assert-True (-not [string]::Equals([string]$maliciousMirrorResolution.selected.path, $maliciousMirrorCli, [StringComparison]::OrdinalIgnoreCase)) "The malicious mirror became the selected executable."
        }
        Assert-True (-not (Test-Path -LiteralPath $maliciousMirrorMarker)) "The LocalAppData mirror/app-local DLL fixture was executed."

        Write-Host "Test copied signed Store CLI plus forged standalone manifest/helpers remains non-executable"
        $standaloneFixtureRoot = Join-Path $tempRoot 'official-standalone-fixture'
        $standaloneLocalAppData = Join-Path $standaloneFixtureRoot 'LocalAppData'
        $standaloneCodexHome = Join-Path $standaloneFixtureRoot 'CodexHome'
        $standaloneRoot = Join-Path $standaloneCodexHome 'packages\standalone'
        $standaloneReleases = Join-Path $standaloneRoot 'releases'
        $nativeArchitecture = if (-not [string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) { [string]$env:PROCESSOR_ARCHITEW6432 } else { [string]$env:PROCESSOR_ARCHITECTURE }
        $standaloneTarget = if ($nativeArchitecture -match '^(?i:ARM64)$') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
        $standaloneVersion = '0.144.3'
        $standaloneRelease = Join-Path $standaloneReleases ($standaloneVersion + '-' + $standaloneTarget)
        foreach ($directory in @(
            (Join-Path $standaloneRelease 'bin'), (Join-Path $standaloneRelease 'codex-path'),
            (Join-Path $standaloneRelease 'codex-resources'), (Join-Path $standaloneLocalAppData 'Programs\OpenAI\Codex')
        )) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
        $standaloneCodexPath = Join-Path $standaloneRelease 'bin\codex.exe'
        Copy-Item -LiteralPath $activeUnified.packageCliPath -Destination $standaloneCodexPath
        foreach ($relativePath in @(
            'bin\codex-code-mode-host.exe', 'codex-path\rg.exe',
            'codex-resources\codex-command-runner.exe', 'codex-resources\codex-windows-sandbox-setup.exe'
        )) { Write-Utf8NoBom -Path (Join-Path $standaloneRelease $relativePath) -Content ('fixture ' + $relativePath) }
        $standaloneManifestPath = Join-Path $standaloneRelease 'codex-package.json'
        [IO.File]::WriteAllText($standaloneManifestPath, ([ordered]@{
            layoutVersion = 1; version = $standaloneVersion; target = $standaloneTarget; variant = 'codex'
            entrypoint = 'bin/codex.exe'; resourcesDir = 'codex-resources'; pathDir = 'codex-path'
        } | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
        $standaloneCurrent = Join-Path $standaloneRoot 'current'
        $standaloneVisibleBin = Join-Path $standaloneLocalAppData 'Programs\OpenAI\Codex\bin'
        New-Item -ItemType Junction -Path $standaloneCurrent -Target $standaloneRelease | Out-Null
        New-Item -ItemType Junction -Path $standaloneVisibleBin -Target (Join-Path $standaloneCurrent 'bin') | Out-Null
        $standaloneAttestation = & $codexRegistrationModule {
            param($CodexHome, $LocalAppData)
            Get-RevAgentOfficialStandaloneCodexAttestation -CodexHome $CodexHome -LocalAppData $LocalAppData
        } $standaloneCodexHome $standaloneLocalAppData
        Assert-True ([bool]$standaloneAttestation.available -and -not [bool]$standaloneAttestation.success -and -not [bool]$standaloneAttestation.authenticatedReceiptAttested) "A copied signed Store CLI and forged standalone package escaped the receipt requirement."
        Assert-Equal $standaloneAttestation.reason 'standalone_disabled_no_authenticated_receipt' "Forged standalone state failed closed for the wrong reason."
        Assert-Equal $standaloneAttestation.visibleBinPath $standaloneVisibleBin "Custom or legacy visible-bin discovery replaced the exact official default."
        Assert-ThrowsLike -Action {
            & $codexRegistrationModule {
                param($CodexPath, $ReleasePath)
                $forged = [pscustomobject]@{
                    path = $CodexPath; origin = 'official-standalone-user-package'; originAttested = $true; trusted = $true
                    packageBound = $true; attestationRoot = $ReleasePath; linkCount = 1; fileIdentity = 'forged'; sha256 = ('A' * 64)
                }
                Open-RevAgentCodexExecutableLaunchGuard -Candidate $forged | Out-Null
            } $standaloneCodexPath $standaloneRelease
        } -Pattern 'origin is not executable|standalone Codex execution is disabled' -Message "A caller-forged standalone candidate must be rejected before process launch."

        $copiedSignedCodex = Join-Path $tempRoot 'copied-signed-codex.exe'
        Copy-Item -LiteralPath $activeUnified.packageCliPath -Destination $copiedSignedCodex -Force
        $copiedCodexAttestation = & $codexRegistrationModule {
            param($Path, $Root)
            $attestation = Get-RevAgentCodexExecutableAttestation -Path $Path -AllowedRoot $Root
            [pscustomobject]@{
                attestation = $attestation
                decision = Get-RevAgentCodexOriginTrustDecision -ActiveUnifiedAvailable $true -ActiveBundleMatch $false -StandaloneMatch $false `
                    -Attestation $attestation -StandaloneAttestation $null -ActivePackageCliSha256 $attestation.sha256
            }
        } $copiedSignedCodex $tempRoot
        Assert-True ([bool]$copiedCodexAttestation.attestation.openAiSigned) "Copied Store CLI fixture lost its valid OpenAI signer evidence."
        Assert-Equal $copiedCodexAttestation.decision.origin 'unattested' "A copied signed Codex executable received an executable origin."
        Assert-True (-not [bool]$copiedCodexAttestation.decision.trusted) "A copied signed Codex executable escaped protected-origin attestation."

        Write-Host "Test protected Store-copy trust decision requires both exact package hash and protected path"
        $protectedPositive = & $codexRegistrationModule {
            param($Sha256)
            $attestation = [pscustomobject]@{ safe = $true; openAiSigned = $true; linkCount = 1; sha256 = $Sha256 }
            [pscustomobject]@{
                exact = Get-RevAgentCodexOriginTrustDecision -ActiveUnifiedAvailable $true -ActiveBundleMatch $false -StandaloneMatch $false `
                    -Attestation $attestation -StandaloneAttestation $null -ActivePackageCliSha256 $Sha256 -ProtectedStoreMatch $true -ProtectedPathAttested $true
                unprotected = Get-RevAgentCodexOriginTrustDecision -ActiveUnifiedAvailable $true -ActiveBundleMatch $false -StandaloneMatch $false `
                    -Attestation $attestation -StandaloneAttestation $null -ActivePackageCliSha256 $Sha256 -ProtectedStoreMatch $true -ProtectedPathAttested $false
            }
        } $activeUnified.packageCliSha256
        Assert-Equal $protectedPositive.exact.origin 'protected-active-store-copy' "Exact protected Store-copy fixture lost its origin."
        Assert-True ([bool]$protectedPositive.exact.trusted -and [bool]$protectedPositive.exact.packageBound -and [bool]$protectedPositive.exact.protectedPath) "Exact protected Store-copy fixture did not become executable."
        Assert-True (-not [bool]$protectedPositive.unprotected.trusted) "An otherwise exact Store copy became executable without protected-path evidence."

        Write-Host "Test protected Store receipt is bound to the exact target user SID"
        $receiptSidBinding = & $codexRegistrationModule {
            param($ActivePackage, $TargetSid)
            $receipt = [pscustomobject]@{
                schemaVersion = 1; origin = 'OpenAI.Codex-Store-package'; targetUserSid = $TargetSid
                packageFullName = [string]$ActivePackage.packageFullName; packageVersion = [string]$ActivePackage.packageVersion
                packageFamilyName = [string]$ActivePackage.packageFamilyName
                packageCliRelativePath = [string]$ActivePackage.packageCliRelativePath; packageCliSha256 = [string]$ActivePackage.packageCliSha256
            }
            [pscustomobject]@{
                exact = Test-RevAgentProtectedCodexReceiptBinding -Receipt $receipt -ActivePackageAttestation $ActivePackage -TargetUserSid $TargetSid
                mismatch = Test-RevAgentProtectedCodexReceiptBinding -Receipt $receipt -ActivePackageAttestation $ActivePackage -TargetUserSid 'S-1-5-21-111111111-222222222-333333333-4444'
            }
        } $activeUnified ([string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
        Assert-True ([bool]$receiptSidBinding.exact -and -not [bool]$receiptSidBinding.mismatch) "Protected Store receipt accepted a different UAC/target user SID."

        $liveProtected = & $codexRegistrationModule {
            param($InstallRoot, $ActivePackage, $TargetUserSid)
            Get-RevAgentProtectedCodexCliAttestation -InstallRoot $InstallRoot -ActivePackageAttestation $ActivePackage -TargetUserSid $TargetUserSid
        } $canonicalInstallRoot $activeUnified ([string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
        if ($liveProtected.success) {
            $protectedResolution = Resolve-RevAgentCodexCli -ExplicitPath $copiedSignedCodex -CodexHome $defaultHome.path -InstallRoot $canonicalInstallRoot
            Assert-Equal $protectedResolution.selected.path $liveProtected.path "Resolver did not select the exact protected Store copy."
            Assert-Equal $protectedResolution.selected.origin 'protected-active-store-copy' "The selected protected executable lost its active-package origin."
            Assert-True ([bool]$protectedResolution.selected.packageBound -and [bool]$protectedResolution.selected.originAttested -and [bool]$protectedResolution.selected.protectedPath) "The selected protected executable is not independently bound to the active Store package."
            Assert-True ($protectedResolution.reasoningEffortCompatibility.probeMode -eq 'isolated-disposable-root-config' -and [bool]$protectedResolution.reasoningEffortCompatibility.guardedExecutable) "Protected Codex CLI did not produce guarded isolated Ultra capability evidence."
            Assert-Equal $protectedResolution.reasoningEffortCompatibility.cliSha256 $protectedResolution.selected.sha256 "Ultra capability evidence was not bound to the selected protected CLI hash."
            Assert-True ([bool]$protectedResolution.selected.actualConfigCapabilityJsonValid) "Protected Codex CLI did not pass the actual-config capability probe."
            $tamperedCliAttestation = $protectedResolution.selected | Select-Object *
            $tamperedCliAttestation.sha256 = ('0' * 64)
            Assert-ThrowsLike -Action {
                Test-RevAgentCodexMcpReadback -CodexCliPath $tamperedCliAttestation.path -CodexHome $defaultHome.path -NodePath $programFilesNode -RuntimeServerPath 'runtime.js' -DocsServerPath 'docs.js' -CodexCliCandidate $tamperedCliAttestation | Out-Null
            } -Pattern "identity changed after attestation" -Message "Final Codex MCP readback must re-attest the protected Store copy before process start."
        }
        else {
            Write-Host "SKIP live protected Store-copy execution: machine phase has not materialized this Store version yet."
        }
    }
    else {
        Write-Host "SKIP live unified Codex package probe: OpenAI.Codex is not installed on this runner."
    }

    Write-Host "Test config lock, expected hash, atomic replace, hardlink, and junction guards"
    $configHome = Join-Path $profileRoot "config-home"
    New-Item -ItemType Directory -Path $configHome -Force | Out-Null
    $configPath = Join-Path $configHome "config.toml"
    $fixtureCliSha256 = ('A' * 64)
    $supportsUltraCompatibility = [pscustomobject][ordered]@{
        schemaVersion = 1; probeMode = 'isolated-disposable-root-config'; guardedExecutable = $true
        cliSha256 = $fixtureCliSha256; decision = 'preserve_supported_ultra'; compatible = $true
        ultra = [pscustomobject][ordered]@{
            effort = 'ultra'; attempted = $true; accepted = $true; exitCode = 0; jsonValid = $true; unsupportedUltra = $false; rejectionClass = 'accepted'
            isolatedCodexHome = $true; rootOnlyConfig = $true; diagnostic = ''
        }
        xhigh = [pscustomobject][ordered]@{
            effort = 'xhigh'; attempted = $false; accepted = $false; exitCode = -1; jsonValid = $false; rejectionClass = 'not_required'
            isolatedCodexHome = $true; rootOnlyConfig = $true; diagnostic = ''
        }
    }
    $rejectsUltraCompatibility = [pscustomobject][ordered]@{
        schemaVersion = 1; probeMode = 'isolated-disposable-root-config'; guardedExecutable = $true
        cliSha256 = $fixtureCliSha256; decision = 'normalize_ultra_to_xhigh'; compatible = $true
        ultra = [pscustomobject][ordered]@{
            effort = 'ultra'; attempted = $true; accepted = $false; exitCode = 1; jsonValid = $false; unsupportedUltra = $true; rejectionClass = 'unsupported_or_unknown_ultra'
            isolatedCodexHome = $true; rootOnlyConfig = $true; diagnostic = 'unknown variant ultra, expected one of low, medium, high, xhigh'
        }
        xhigh = [pscustomobject][ordered]@{
            effort = 'xhigh'; attempted = $true; accepted = $true; exitCode = 0; jsonValid = $true; rejectionClass = 'accepted'
            isolatedCodexHome = $true; rootOnlyConfig = $true; diagnostic = ''
        }
    }
    $unclassifiedUltraCompatibility = [pscustomobject][ordered]@{
        schemaVersion = 1; probeMode = 'isolated-disposable-root-config'; guardedExecutable = $true
        cliSha256 = $fixtureCliSha256; decision = 'fail_closed'; compatible = $false
        ultra = [pscustomobject][ordered]@{
            effort = 'ultra'; attempted = $true; accepted = $false; exitCode = 1; jsonValid = $false; unsupportedUltra = $false; rejectionClass = 'unclassified_rejection'
            isolatedCodexHome = $true; rootOnlyConfig = $true; diagnostic = 'unrelated process failure'
        }
        xhigh = [pscustomobject][ordered]@{
            effort = 'xhigh'; attempted = $false; accepted = $false; exitCode = -1; jsonValid = $false; rejectionClass = 'not_required'
            isolatedCodexHome = $true; rootOnlyConfig = $true; diagnostic = ''
        }
    }
    $legacyReasoningConfig = @'
model = "gpt-5.5"
model_reasoning_effort = "ultra" # legacy unified-app value
unrelated_root = "preserve-me"

[profiles.operator]
model_reasoning_effort = "ultra"
keep = "untouched"
'@ -replace "`n", "`r`n"
    Write-Utf8NoBom -Path $configPath -Content ($legacyReasoningConfig + "`r`n")
    $expectedHash = Get-RevAgentFileSha256 -Path $configPath
    $atomic = Set-RevAgentCodexMcpConfigAtomic -CodexHome $configHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath "C:\Program Files\revAgent\runtime.js" -DocsServerPath "C:\Program Files\revAgent\docs.js" -ExpectedSha256 $expectedHash `
        -ReasoningEffortCompatibility $supportsUltraCompatibility -ExpectedCodexCliSha256 $fixtureCliSha256
    Assert-True ([bool]$atomic.atomicReplace) "Config update did not attest atomic replacement."
    Assert-True ($atomic.afterSha256 -ne $atomic.beforeSha256) "Config hash did not change after registration."
    $normalizedConfigText = Get-Content -Raw -LiteralPath $configPath
    Assert-True ($normalizedConfigText -match '\[mcp_servers\.revAgent\]') "Atomic config output is missing revAgent."
    Assert-True ($normalizedConfigText -match '(?m)^model_reasoning_effort\s*=\s*"ultra"\s*# legacy unified-app value\s*$') "A CLI that accepts Ultra must preserve the root Ultra value and its inline content."
    Assert-True ($normalizedConfigText -match '(?ms)^\[profiles\.operator\].*?^model_reasoning_effort\s*=\s*"ultra"\s*$') "Profile-local reasoning effort must remain operator-owned and unchanged."
    Assert-True ($normalizedConfigText -match '(?m)^unrelated_root\s*=\s*"preserve-me"\s*$' -and $normalizedConfigText -match '(?m)^keep\s*=\s*"untouched"\s*$') "Reasoning-effort normalization modified unrelated config content."
    Assert-True (-not [bool]$atomic.modelReasoningEffortNormalization.changed) "A CLI that supports Ultra must not normalize it."
    Assert-Equal $atomic.modelReasoningEffortNormalization.replacementCount 0 "Supported Ultra unexpectedly reported a normalization."
    Assert-Equal $atomic.modelReasoningEffortNormalization.scope 'root' "Config result reported the wrong normalization scope."
    Assert-Equal $atomic.modelReasoningEffortNormalization.from 'ultra' "Config result reported the wrong source reasoning effort."
    Assert-Equal $atomic.modelReasoningEffortNormalization.to 'ultra' "Config result must attest that supported Ultra was preserved."
    Assert-Equal $atomic.modelReasoningEffortCompatibility.action 'preserved_supported_ultra' "Config result did not attest the supports-Ultra action."
    Assert-Equal $atomic.modelReasoningEffortCompatibility.capabilityCliSha256 $fixtureCliSha256 "Config result lost the selected CLI capability binding."

    $rejectsUltraHome = Join-Path $profileRoot 'rejects-ultra-home'
    New-Item -ItemType Directory -Path $rejectsUltraHome -Force | Out-Null
    $rejectsUltraPath = Join-Path $rejectsUltraHome 'config.toml'
    Write-Utf8NoBom -Path $rejectsUltraPath -Content ($legacyReasoningConfig + "`r`n")
    $rejectsUltraAtomic = Set-RevAgentCodexMcpConfigAtomic -CodexHome $rejectsUltraHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath 'runtime.js' -DocsServerPath 'docs.js' `
        -ExpectedSha256 (Get-RevAgentFileSha256 $rejectsUltraPath) -ReasoningEffortCompatibility $rejectsUltraCompatibility -ExpectedCodexCliSha256 $fixtureCliSha256
    $rejectsUltraText = Get-Content -Raw -LiteralPath $rejectsUltraPath
    Assert-True ($rejectsUltraText -match '(?m)^model_reasoning_effort\s*=\s*"xhigh"\s*# legacy unified-app value\s*$') "An explicit unsupported-Ultra probe plus accepted-xhigh probe did not conditionally migrate root Ultra."
    Assert-True ($rejectsUltraText -match '(?ms)^\[profiles\.operator\].*?^model_reasoning_effort\s*=\s*"ultra"\s*$') "Conditional root migration modified a profile-local Ultra value."
    Assert-True ([bool]$rejectsUltraAtomic.modelReasoningEffortNormalization.changed -and $rejectsUltraAtomic.modelReasoningEffortNormalization.replacementCount -eq 1) "Conditional Ultra migration was not attested."
    Assert-Equal $rejectsUltraAtomic.modelReasoningEffortCompatibility.action 'normalized_unsupported_ultra_to_xhigh' "Conditional Ultra migration reported the wrong action."

    $unknownUltraHome = Join-Path $profileRoot 'unknown-ultra-home'
    New-Item -ItemType Directory -Path $unknownUltraHome -Force | Out-Null
    $unknownUltraPath = Join-Path $unknownUltraHome 'config.toml'
    Write-Utf8NoBom -Path $unknownUltraPath -Content ($legacyReasoningConfig + "`r`n")
    $unknownUltraBefore = Get-Content -Raw -LiteralPath $unknownUltraPath
    Assert-ThrowsLike -Action {
        Set-RevAgentCodexMcpConfigAtomic -CodexHome $unknownUltraHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath 'runtime.js' -DocsServerPath 'docs.js' `
            -ExpectedSha256 (Get-RevAgentFileSha256 $unknownUltraPath) -ReasoningEffortCompatibility $unclassifiedUltraCompatibility -ExpectedCodexCliSha256 $fixtureCliSha256 | Out-Null
    } -Pattern 'did not provide safe evidence to preserve or conditionally normalize root Ultra' -Message 'An unclassified Ultra probe failure must fail closed.'
    Assert-Equal (Get-Content -Raw -LiteralPath $unknownUltraPath) $unknownUltraBefore "Fail-closed Ultra classification modified config.toml."

    Write-Host 'Test active Store package/receipt change after commit restores original config under lock'
    $activationRaceHome = Join-Path $profileRoot 'activation-race-home'
    New-Item -ItemType Directory -Path $activationRaceHome -Force | Out-Null
    $activationRacePath = Join-Path $activationRaceHome 'config.toml'
    Write-Utf8NoBom -Path $activationRacePath -Content ($legacyReasoningConfig + "`r`n")
    $activationRaceOriginal = Get-Content -Raw -LiteralPath $activationRacePath
    $activationRaceOriginalHash = Get-RevAgentFileSha256 -Path $activationRacePath
    $activationRaceState = [pscustomobject]@{ preCommitBindingChecks = 0; postCommitBindingChecks = 0 }
    $activationRacePreCommit = {
        $activationRaceState.preCommitBindingChecks++
    }.GetNewClosure()
    $activationRacePostCommit = {
        $activationRaceState.postCommitBindingChecks++
        throw 'Codex CLI is no longer bound to the same active signed OpenAI.Codex package'
    }.GetNewClosure()
    Assert-ThrowsLike -Action {
        Set-RevAgentCodexMcpConfigAtomic -CodexHome $activationRaceHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath 'runtime.js' -DocsServerPath 'docs.js' `
            -ExpectedSha256 $activationRaceOriginalHash -ReasoningEffortCompatibility $rejectsUltraCompatibility -ExpectedCodexCliSha256 $fixtureCliSha256 `
            -BeforeAtomicCommit $activationRacePreCommit -AfterAtomicCommitValidation $activationRacePostCommit | Out-Null
    } -Pattern 'Post-commit selected-CLI validation failed; original config bytes/hash were restored under lock' -Message 'A Store activation/receipt race after commit must roll back the staged config.'
    Assert-Equal $activationRaceState.preCommitBindingChecks 1 "Activation-race fixture did not run the immediate pre-commit binding check."
    Assert-Equal $activationRaceState.postCommitBindingChecks 1 "Activation-race fixture did not run the post-commit binding/probe check before backup cleanup."
    Assert-Equal (Get-Content -Raw -LiteralPath $activationRacePath) $activationRaceOriginal "Store activation race did not restore the original config bytes."
    Assert-Equal (Get-RevAgentFileSha256 -Path $activationRacePath) $activationRaceOriginalHash "Store activation race did not restore the original config hash."
    Assert-Equal @(Get-ChildItem -LiteralPath $activationRaceHome -Force | Where-Object { $_.Name -match '^\.config\.toml\.revagent-.*\.(tmp|bak|discard)$' }).Count 0 "Store activation rollback left a staged config/backup artifact."

    Write-Host 'Test existing-config rollback restores a writer arriving after rollback precheck'
    $existingRollbackRaceHome = Join-Path $profileRoot 'existing-rollback-writer-race-home'
    New-Item -ItemType Directory -Path $existingRollbackRaceHome -Force | Out-Null
    $existingRollbackRacePath = Join-Path $existingRollbackRaceHome 'config.toml'
    Write-Utf8NoBom -Path $existingRollbackRacePath -Content ($legacyReasoningConfig + "`r`n")
    $existingRollbackOriginal = Get-Content -Raw -LiteralPath $existingRollbackRacePath
    $existingRollbackOriginalHash = Get-RevAgentFileSha256 -Path $existingRollbackRacePath
    $existingRollbackWriterText = "model = `"writer-wins`"`r`n# arrived after rollback precheck`r`n"
    $existingRollbackWriterHook = {
        param($DestinationPath)
        $replacement = $DestinationPath + '.writer-replacement'
        $displaced = $DestinationPath + '.writer-displaced'
        [IO.File]::WriteAllText($replacement, $existingRollbackWriterText, [Text.UTF8Encoding]::new($false))
        [IO.File]::Replace($replacement, $DestinationPath, $displaced, $true)
        Remove-Item -LiteralPath $displaced -Force
    }.GetNewClosure()
    Assert-ThrowsLike -Action {
        Set-RevAgentCodexMcpConfigAtomic -CodexHome $existingRollbackRaceHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath 'runtime.js' -DocsServerPath 'docs.js' `
            -ExpectedSha256 $existingRollbackOriginalHash -ReasoningEffortCompatibility $rejectsUltraCompatibility -ExpectedCodexCliSha256 $fixtureCliSha256 `
            -AfterAtomicCommitValidation $activationRacePostCommit -BeforePostCommitRollback $existingRollbackWriterHook | Out-Null
    } -Pattern 'a concurrent writer was restored exactly and the original config was preserved' -Message 'Existing-config rollback must restore a writer that lands after rollback precheck.'
    Assert-Equal (Get-Content -Raw -LiteralPath $existingRollbackRacePath) $existingRollbackWriterText "Existing-config rollback overwrote the concurrent writer."
    $existingRollbackBackups = @(Get-ChildItem -LiteralPath $existingRollbackRaceHome -Force -File | Where-Object { $_.Name -match '^\.config\.toml\.revagent-.*\.bak$' })
    Assert-Equal $existingRollbackBackups.Count 1 "Existing-config writer race did not preserve exactly one original backup."
    Assert-Equal (Get-Content -Raw -LiteralPath $existingRollbackBackups[0].FullName) $existingRollbackOriginal "Existing-config writer race backup lost the original bytes."
    Assert-Equal (Get-RevAgentFileSha256 -Path $existingRollbackBackups[0].FullName) $existingRollbackOriginalHash "Existing-config writer race backup lost the original hash."
    Remove-Item -LiteralPath $existingRollbackBackups[0].FullName -Force

    Write-Host 'Test missing-config rollback atomically preserves a competing writer'
    $missingRollbackRaceHome = Join-Path $profileRoot 'missing-rollback-writer-race-home'
    New-Item -ItemType Directory -Path $missingRollbackRaceHome -Force | Out-Null
    $missingRollbackRacePath = Join-Path $missingRollbackRaceHome 'config.toml'
    $missingRollbackWriterText = "model = `"writer-created`"`r`n# original config was missing`r`n"
    $missingRollbackWriterHook = {
        param($DestinationPath)
        $replacement = $DestinationPath + '.writer-replacement'
        $displaced = $DestinationPath + '.writer-displaced'
        [IO.File]::WriteAllText($replacement, $missingRollbackWriterText, [Text.UTF8Encoding]::new($false))
        [IO.File]::Replace($replacement, $DestinationPath, $displaced, $true)
        Remove-Item -LiteralPath $displaced -Force
    }.GetNewClosure()
    Assert-ThrowsLike -Action {
        Set-RevAgentCodexMcpConfigAtomic -CodexHome $missingRollbackRaceHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath 'runtime.js' -DocsServerPath 'docs.js' `
            -ExpectedSha256 'MISSING' -AfterAtomicCommitValidation $activationRacePostCommit -BeforePostCommitRollback $missingRollbackWriterHook | Out-Null
    } -Pattern 'a competing writer replaced the staged config and its exact bytes/identity were restored instead of deleted' -Message 'Missing-config rollback must atomically preserve a writer replacing the staged config.'
    Assert-Equal (Get-Content -Raw -LiteralPath $missingRollbackRacePath) $missingRollbackWriterText "Missing-config rollback deleted or altered the competing writer."
    Assert-Equal @(Get-ChildItem -LiteralPath $missingRollbackRaceHome -Force | Where-Object { $_.Name -match '^\.config\.toml\.revagent-.*\.(tmp|bak|discard|missing-rollback)$|\.writer-(replacement|displaced)$' }).Count 0 "Missing-config writer rollback left an unexpected displacement artifact."

    $capabilityClassifiers = & $codexRegistrationModule {
        [pscustomobject]@{
            unsupported = Test-RevAgentCodexUltraUnsupportedDiagnostic -Text 'unknown variant `ultra`, expected one of low, high, xhigh'
            unrelated = Test-RevAgentCodexUltraUnsupportedDiagnostic -Text 'network timeout while config contained ultra'
            noRoot = Resolve-RevAgentCodexRootReasoningEffortCompatibility -Content "model_reasoning_effort = `"high`"`r`n[profiles.keep]`r`nmodel_reasoning_effort = `"ultra`"`r`n"
        }
    }
    Assert-True ([bool]$capabilityClassifiers.unsupported -and -not [bool]$capabilityClassifiers.unrelated) "Ultra rejection classifier did not distinguish an explicit variant rejection from an unrelated failure."
    Assert-Equal $capabilityClassifiers.noRoot.action 'no_root_ultra' "A profile-only Ultra value must not require a CLI compatibility migration."
    Assert-Equal $capabilityClassifiers.noRoot.content "model_reasoning_effort = `"high`"`r`n[profiles.keep]`r`nmodel_reasoning_effort = `"ultra`"`r`n" "Non-root Ultra compatibility handling did not preserve content byte-for-byte."
    Assert-Equal @(Get-ChildItem -LiteralPath $configHome -Force | Where-Object { $_.Name -match '^\.config\.toml\.revagent-.*\.(tmp|bak)$' }).Count 0 "Atomic config update left staging artifacts."

    $staleHash = Get-RevAgentFileSha256 -Path $configPath
    Add-Content -LiteralPath $configPath -Value "# concurrent writer"
    $concurrentText = Get-Content -Raw -LiteralPath $configPath
    Assert-ThrowsLike -Action {
        Set-RevAgentCodexMcpConfigAtomic -CodexHome $configHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath "runtime.js" -DocsServerPath "docs.js" -ExpectedSha256 $staleHash | Out-Null
    } -Pattern "config changed after it was inspected" -Message "Expected-hash mismatch must fail closed."
    Assert-Equal (Get-Content -Raw -LiteralPath $configPath) $concurrentText "Expected-hash failure modified config.toml."

    $chatGptWriterText = "model = `"gpt-5.5`"`r`n# ChatGPT concurrent write`r`n"
    $chatGptWriterHook = {
        param($DestinationPath)
        [IO.File]::WriteAllText($DestinationPath, $chatGptWriterText, [Text.UTF8Encoding]::new($false))
    }.GetNewClosure()
    $preCommitHash = Get-RevAgentFileSha256 -Path $configPath
    Assert-ThrowsLike -Action {
        Set-RevAgentCodexMcpConfigAtomic -CodexHome $configHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath "runtime.js" -DocsServerPath "docs.js" -ExpectedSha256 $preCommitHash `
            -ReasoningEffortCompatibility $supportsUltraCompatibility -ExpectedCodexCliSha256 $fixtureCliSha256 -BeforeDestinationCommit $chatGptWriterHook | Out-Null
    } -Pattern "destination changed before atomic replace" -Message "A non-cooperating content write after initial read must win and fail CAS."
    Assert-Equal (Get-Content -Raw -LiteralPath $configPath) $chatGptWriterText "CAS failure lost the concurrent ChatGPT content write."

    $sameBytes = [IO.File]::ReadAllBytes($configPath)
    $identitySwapHook = {
        param($DestinationPath)
        $replacementPath = $DestinationPath + ".chatgpt-replacement"
        $replacementBackup = $DestinationPath + ".chatgpt-backup"
        [IO.File]::WriteAllBytes($replacementPath, $sameBytes)
        [IO.File]::Replace($replacementPath, $DestinationPath, $replacementBackup, $true)
        Remove-Item -LiteralPath $replacementBackup -Force
    }.GetNewClosure()
    $sameHashBeforeIdentitySwap = Get-RevAgentFileSha256 -Path $configPath
    Assert-ThrowsLike -Action {
        Set-RevAgentCodexMcpConfigAtomic -CodexHome $configHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath "runtime.js" -DocsServerPath "docs.js" -ExpectedSha256 $sameHashBeforeIdentitySwap -BeforeDestinationCommit $identitySwapHook | Out-Null
    } -Pattern "destination changed before atomic replace.*expectedIdentity" -Message "A same-content destination replacement must fail file-identity CAS."
    Assert-Equal (Get-RevAgentFileSha256 -Path $configPath) $sameHashBeforeIdentitySwap "Identity CAS failure changed concurrent destination content."
    Assert-Equal @(Get-ChildItem -LiteralPath $configHome -Force | Where-Object { $_.Name -match '^\.config\.toml\.revagent-.*\.(tmp|bak|discard)$|\.chatgpt-(replacement|backup)$' }).Count 0 "CAS failure left staging artifacts."

    Write-Host "Test config recovery failure preserves the displaced writer backup"
    $recoveryWriterText = "model = `"gpt-5.5`"`r`n# writer at final ReplaceFile boundary`r`n"
    $recoveryWriterHook = {
        param($DestinationPath)
        [IO.File]::WriteAllText($DestinationPath, $recoveryWriterText, [Text.UTF8Encoding]::new($false))
    }.GetNewClosure()
    $recoveryLockHolder = [pscustomobject]@{ Stream = $null }
    $recoveryFailureHook = {
        param($DestinationPath)
        $recoveryLockHolder.Stream = [IO.File]::Open($DestinationPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    }.GetNewClosure()
    $recoveryFailure = $null
    try {
        $recoveryExpectedHash = Get-RevAgentFileSha256 -Path $configPath
        Set-RevAgentCodexMcpConfigAtomic -CodexHome $configHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath "runtime.js" -DocsServerPath "docs.js" -ExpectedSha256 $recoveryExpectedHash -BeforeAtomicCommit $recoveryWriterHook -BeforeRecoveryCommit $recoveryFailureHook | Out-Null
    }
    catch { $recoveryFailure = $_ }
    finally {
        if ($null -ne $recoveryLockHolder.Stream) { $recoveryLockHolder.Stream.Dispose(); $recoveryLockHolder.Stream = $null }
    }
    Assert-True ($null -ne $recoveryFailure -and [string]$recoveryFailure.Exception.Message -match 'recovery failed; displaced writer data was preserved') "Forced config recovery failure did not fail closed with preserved-backup evidence."
    $preservedRecoveryBackups = @(Get-ChildItem -LiteralPath $configHome -Force -File | Where-Object { $_.Name -match '^\.config\.toml\.revagent-.*\.bak$' })
    Assert-Equal $preservedRecoveryBackups.Count 1 "Forced config recovery failure did not retain exactly one recovery backup."
    Assert-Equal ([IO.File]::ReadAllText($preservedRecoveryBackups[0].FullName)) $recoveryWriterText "Preserved config recovery backup lost the displaced writer content."
    $recoveryDiscard = Join-Path $configHome ('.config-recovery-test-' + [Guid]::NewGuid().ToString('N') + '.discard')
    [IO.File]::Replace($preservedRecoveryBackups[0].FullName, $configPath, $recoveryDiscard, $true)
    Remove-Item -LiteralPath $recoveryDiscard -Force
    Assert-Equal ([IO.File]::ReadAllText($configPath)) $recoveryWriterText "Recovery fixture cleanup did not restore the preserved writer content."

    $lockPath = Join-Path $configHome ".revagent-config.lock"
    $heldLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $currentHash = Get-RevAgentFileSha256 -Path $configPath
        Assert-ThrowsLike -Action {
            Set-RevAgentCodexMcpConfigAtomic -CodexHome $configHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath "runtime.js" -DocsServerPath "docs.js" -ExpectedSha256 $currentHash -LockTimeoutSeconds 1 | Out-Null
        } -Pattern "Timed out waiting for the Codex config lock|being used by another process" -Message "Held config lock must block mutation."
    }
    finally { $heldLock.Dispose() }

    $hardlinkHome = Join-Path $profileRoot "hardlink-home"
    New-Item -ItemType Directory -Path $hardlinkHome -Force | Out-Null
    $hardlinkSource = Join-Path $tempRoot "external-config.toml"
    Write-Utf8NoBom -Path $hardlinkSource -Content "external = true`r`n"
    $hardlinkConfig = Join-Path $hardlinkHome "config.toml"
    New-Item -ItemType HardLink -Path $hardlinkConfig -Target $hardlinkSource | Out-Null
    $hardlinkSourceBefore = Get-Content -Raw -LiteralPath $hardlinkSource
    Assert-ThrowsLike -Action {
        Set-RevAgentCodexMcpConfigAtomic -CodexHome $hardlinkHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath "runtime.js" -DocsServerPath "docs.js" -ExpectedSha256 (Get-RevAgentFileSha256 $hardlinkConfig) | Out-Null
    } -Pattern "hard-link count" -Message "Hard-linked config.toml must be rejected."
    Assert-Equal (Get-Content -Raw -LiteralPath $hardlinkSource) $hardlinkSourceBefore "Hardlink guard failure modified the external file."

    $junctionTarget = Join-Path $tempRoot "junction-target"
    $junctionPath = Join-Path $profileRoot "junction-home"
    New-Item -ItemType Directory -Path $junctionTarget -Force | Out-Null
    New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget | Out-Null
    Assert-ThrowsLike -Action {
        Assert-RevAgentSafeUserPath -Path (Join-Path $junctionPath "config.toml") -AllowedRoot $profileRoot -LeafKind File -AllowMissing | Out-Null
    } -Pattern "reparse point" -Message "Parent junction must be rejected before any user-root write."

    Write-Host "Test canonical skill migration, duplicate cleanup, conflicts, marker tamper, and preserve-local attestation"
    $skillSource = Join-Path $tempRoot "skill-source"
    Write-Utf8NoBom -Path (Join-Path $skillSource "SKILL.md") -Content "# revAgent fixture`r`n"
    Write-Utf8NoBom -Path (Join-Path $skillSource "references\contract.md") -Content "fixture contract`r`n"
    $skillProfile = Join-Path $tempRoot "skill-profile"
    New-Item -ItemType Directory -Path $skillProfile -Force | Out-Null
    $firstSkill = Sync-RevAgentCodexSkill -UserProfileRoot $skillProfile -SourcePath $skillSource -Policy managed-user-pack -GuardRoot $skillProfile
    Assert-True ([bool]$firstSkill.present -and [bool]$firstSkill.loaded -and [bool]$firstSkill.safe) "Canonical .agents skill was not installed and attested."
    Assert-Equal $firstSkill.path (Join-Path $skillProfile ".agents\skills\revAgent") "Canonical skill path is incorrect."

    Write-Host "Test skill tree content/identity CAS and final-displacement race recovery"
    $skillContentRaceProfile = Join-Path $tempRoot "skill-content-race-profile"
    New-Item -ItemType Directory -Path $skillContentRaceProfile -Force | Out-Null
    $skillContentRaceFirst = Sync-RevAgentCodexSkill -UserProfileRoot $skillContentRaceProfile -SourcePath $skillSource -Policy managed-user-pack -GuardRoot $skillContentRaceProfile
    $skillContentRaceText = "# concurrent operator skill content`r`n"
    $skillContentRaceHook = {
        param($DestinationPath)
        [IO.File]::WriteAllText((Join-Path $DestinationPath 'SKILL.md'), $skillContentRaceText, [Text.UTF8Encoding]::new($false))
    }.GetNewClosure()
    Assert-ThrowsLike -Action {
        Sync-RevAgentCodexSkill -UserProfileRoot $skillContentRaceProfile -SourcePath $skillSource -Policy managed-user-pack -GuardRoot $skillContentRaceProfile -BeforeDestinationCommit $skillContentRaceHook | Out-Null
    } -Pattern "skill destination changed before atomic directory replace" -Message "A skill content write after initial validation must win and fail tree CAS."
    Assert-Equal (Get-Content -Raw -LiteralPath (Join-Path $skillContentRaceFirst.path 'SKILL.md')) $skillContentRaceText "Skill tree CAS failure lost concurrent operator content."

    $skillIdentityRaceProfile = Join-Path $tempRoot "skill-identity-race-profile"
    New-Item -ItemType Directory -Path $skillIdentityRaceProfile -Force | Out-Null
    $skillIdentityRaceFirst = Sync-RevAgentCodexSkill -UserProfileRoot $skillIdentityRaceProfile -SourcePath $skillSource -Policy managed-user-pack -GuardRoot $skillIdentityRaceProfile
    $skillIdentityRaceHook = {
        param($DestinationPath)
        $replacementPath = $DestinationPath + '.replacement'
        $oldPath = $DestinationPath + '.old'
        Copy-Item -LiteralPath $DestinationPath -Destination $replacementPath -Recurse -ErrorAction Stop
        [IO.Directory]::Move($DestinationPath, $oldPath)
        [IO.Directory]::Move($replacementPath, $DestinationPath)
        Remove-Item -LiteralPath $oldPath -Recurse -Force -ErrorAction Stop
    }
    Assert-ThrowsLike -Action {
        Sync-RevAgentCodexSkill -UserProfileRoot $skillIdentityRaceProfile -SourcePath $skillSource -Policy managed-user-pack -GuardRoot $skillIdentityRaceProfile -BeforeDestinationCommit $skillIdentityRaceHook | Out-Null
    } -Pattern "skill destination changed before atomic directory replace.*expectedMarkerIdentity" -Message "A same-content skill-directory swap must fail marker/SKILL identity CAS."
    Assert-Equal (Get-RevAgentDirectoryTreeSha256 -Path $skillIdentityRaceFirst.path) (Get-RevAgentDirectoryTreeSha256 -Path $skillSource) "Skill identity CAS failure changed the replacement payload."

    $skillAtomicRaceProfile = Join-Path $tempRoot "skill-atomic-race-profile"
    New-Item -ItemType Directory -Path $skillAtomicRaceProfile -Force | Out-Null
    $skillAtomicRaceFirst = Sync-RevAgentCodexSkill -UserProfileRoot $skillAtomicRaceProfile -SourcePath $skillSource -Policy managed-user-pack -GuardRoot $skillAtomicRaceProfile
    $skillAtomicRaceText = "# writer landed at final directory boundary`r`n"
    $skillAtomicRaceHook = {
        param($DestinationPath)
        [IO.File]::WriteAllText((Join-Path $DestinationPath 'SKILL.md'), $skillAtomicRaceText, [Text.UTF8Encoding]::new($false))
    }.GetNewClosure()
    Assert-ThrowsLike -Action {
        Sync-RevAgentCodexSkill -UserProfileRoot $skillAtomicRaceProfile -SourcePath $skillSource -Policy managed-user-pack -GuardRoot $skillAtomicRaceProfile -BeforeAtomicCommit $skillAtomicRaceHook | Out-Null
    } -Pattern "skill destination changed during atomic directory replace" -Message "A skill writer at the final rename boundary must be displaced, detected, and restored."
    Assert-Equal (Get-Content -Raw -LiteralPath (Join-Path $skillAtomicRaceFirst.path 'SKILL.md')) $skillAtomicRaceText "Final skill-directory race recovery did not restore writer content."
    Assert-Equal @(Get-ChildItem -LiteralPath (Split-Path -Parent $skillAtomicRaceFirst.path) -Force | Where-Object { $_.Name -match '^\.revAgent-(staging|backup)-' }).Count 0 "Skill CAS fixtures left staging/backup directories."

    $managedLegacy = Join-Path $skillProfile ".codex\skills\revAgent"
    New-Item -ItemType Directory -Path (Split-Path -Parent $managedLegacy) -Force | Out-Null
    Copy-Item -LiteralPath $firstSkill.path -Destination $managedLegacy -Recurse -Force
    $migratedSkill = Sync-RevAgentCodexSkill -UserProfileRoot $skillProfile -SourcePath $skillSource -Policy managed-user-pack -GuardRoot $skillProfile
    Assert-True (-not (Test-Path -LiteralPath $managedLegacy)) "Verified managed legacy skill duplicate was not removed."
    Assert-True (@($migratedSkill.removedManagedLegacyPaths) -contains $managedLegacy) "Managed legacy cleanup was not reported."

    $conflictingLegacy = Join-Path $skillProfile ".codex\skills\revit-mcp"
    Write-Utf8NoBom -Path (Join-Path $conflictingLegacy "SKILL.md") -Content "# operator-owned legacy skill`r`n"
    $conflictResult = Sync-RevAgentCodexSkill -UserProfileRoot $skillProfile -SourcePath $skillSource -Policy managed-user-pack -GuardRoot $skillProfile
    Assert-True (Test-Path -LiteralPath (Join-Path $conflictingLegacy "SKILL.md") -PathType Leaf) "Conflicting legacy skill was deleted."
    Assert-True (@($conflictResult.legacyConflicts) -contains $conflictingLegacy) "Conflicting legacy skill was not reported."

    $canonicalSkill = Join-Path $skillProfile ".agents\skills\revAgent"
    Write-Utf8NoBom -Path (Join-Path $canonicalSkill "SKILL.md") -Content "# tampered payload`r`n"
    $sourceHash = Get-RevAgentDirectoryTreeSha256 -Path $skillSource
    Write-Utf8NoBom -Path (Join-Path $canonicalSkill ".revagent-managed.json") -Content (([ordered]@{ managedBy = "revAgent"; schemaVersion = 1; payloadSha256 = $sourceHash } | ConvertTo-Json -Compress))
    Assert-ThrowsLike -Action {
        Sync-RevAgentCodexSkill -UserProfileRoot $skillProfile -SourcePath $skillSource -Policy managed-user-pack -GuardRoot $skillProfile | Out-Null
    } -Pattern "not a verified revAgent-managed payload" -Message "Tampered skill payload/marker must fail closed."

    $preserveProfile = Join-Path $tempRoot "preserve-profile"
    New-Item -ItemType Directory -Path $preserveProfile -Force | Out-Null
    $preserveAbsent = Sync-RevAgentCodexSkill -UserProfileRoot $preserveProfile -SourcePath $skillSource -Policy preserve-local -GuardRoot $preserveProfile
    Assert-True (-not [bool]$preserveAbsent.present -and -not [bool]$preserveAbsent.loaded) "preserve-local absent attestation is incorrect."
    Assert-Equal $preserveAbsent.hash "MISSING" "preserve-local absent hash is incorrect."
    $preserveSkill = Join-Path $preserveProfile ".agents\skills\revAgent"
    Write-Utf8NoBom -Path (Join-Path $preserveSkill "SKILL.md") -Content "# developer-owned skill`r`n"
    $preserveBefore = Get-RevAgentDirectoryTreeSha256 -Path $preserveSkill
    $preservePresent = Sync-RevAgentCodexSkill -UserProfileRoot $preserveProfile -SourcePath $skillSource -Policy preserve-local -GuardRoot $preserveProfile
    Assert-True ([bool]$preservePresent.present -and [bool]$preservePresent.loaded -and [bool]$preservePresent.safe) "preserve-local present attestation is incorrect."
    Assert-Equal $preservePresent.path $preserveSkill "preserve-local reported the wrong skill path."
    Assert-Equal $preservePresent.hash $preserveBefore "preserve-local reported the wrong skill hash."
    Assert-Equal (Get-RevAgentDirectoryTreeSha256 -Path $preserveSkill) $preserveBefore "preserve-local changed the developer skill."

    Write-Host "Test AGENTS hardlink de-linking and managed-marker safety"
    $agentsHome = Join-Path $profileRoot "agents-home"
    New-Item -ItemType Directory -Path $agentsHome -Force | Out-Null
    $agentsSource = Join-Path $tempRoot "trusted-AGENTS.md"
    Write-Utf8NoBom -Path $agentsSource -Content "# trusted revAgent instructions`r`n"
    $agentsTarget = Join-Path $agentsHome "AGENTS.md"
    New-Item -ItemType HardLink -Path $agentsTarget -Target $agentsSource | Out-Null
    $agentsResult = Sync-RevAgentCodexAgents -CodexHome $agentsHome -GuardRoot $profileRoot -SourcePath $agentsSource -Policy managed-user-pack
    Assert-True ([bool]$agentsResult.present -and [bool]$agentsResult.loaded -and [bool]$agentsResult.safe) "Managed AGENTS hardlink was not safely replaced."
    Add-Content -LiteralPath $agentsTarget -Value "# local post-install edit"
    Assert-True ((Get-Content -Raw -LiteralPath $agentsSource) -notmatch "post-install") "AGENTS replacement remained hard-linked to its trusted source."

    Remove-Item -LiteralPath $agentsTarget -Force
    Write-Utf8NoBom -Path $agentsTarget -Content "# operator-owned instructions`r`n"
    $agentsMarker = Join-Path $agentsHome "AGENTS.md.revagent-managed.json"
    Write-Utf8NoBom -Path $agentsMarker -Content (([ordered]@{ managedBy = "revAgent"; schemaVersion = 1; payloadSha256 = (Get-RevAgentFileSha256 $agentsSource) } | ConvertTo-Json -Compress))
    Assert-ThrowsLike -Action {
        Sync-RevAgentCodexAgents -CodexHome $agentsHome -GuardRoot $profileRoot -SourcePath $agentsSource -Policy managed-user-pack | Out-Null
    } -Pattern "not a verified revAgent-managed file" -Message "Forged AGENTS marker must not authorize replacement."
    Assert-True ((Get-Content -Raw -LiteralPath $agentsTarget) -match "operator-owned") "AGENTS marker rejection modified operator content."

    Write-Host "Test AGENTS target/marker content, identity, and final-displacement races"
    $agentsContentRaceHome = Join-Path $profileRoot "agents-content-race-home"
    New-Item -ItemType Directory -Path $agentsContentRaceHome -Force | Out-Null
    Sync-RevAgentCodexAgents -CodexHome $agentsContentRaceHome -GuardRoot $profileRoot -SourcePath $agentsSource -Policy managed-user-pack | Out-Null
    $agentsContentRaceTarget = Join-Path $agentsContentRaceHome 'AGENTS.md'
    $agentsContentRaceText = "# concurrent ChatGPT/operator AGENTS write`r`n"
    $agentsContentRaceHook = {
        param($DestinationPath)
        [IO.File]::WriteAllText($DestinationPath, $agentsContentRaceText, [Text.UTF8Encoding]::new($false))
    }.GetNewClosure()
    Assert-ThrowsLike -Action {
        Sync-RevAgentCodexAgents -CodexHome $agentsContentRaceHome -GuardRoot $profileRoot -SourcePath $agentsSource -Policy managed-user-pack -BeforeDestinationCommit $agentsContentRaceHook | Out-Null
    } -Pattern "AGENTS destination or marker changed before atomic replace" -Message "A concurrent AGENTS content write must win and fail CAS."
    Assert-Equal (Get-Content -Raw -LiteralPath $agentsContentRaceTarget) $agentsContentRaceText "AGENTS content CAS failure lost the concurrent write."

    $agentsIdentityRaceHome = Join-Path $profileRoot "agents-identity-race-home"
    New-Item -ItemType Directory -Path $agentsIdentityRaceHome -Force | Out-Null
    Sync-RevAgentCodexAgents -CodexHome $agentsIdentityRaceHome -GuardRoot $profileRoot -SourcePath $agentsSource -Policy managed-user-pack | Out-Null
    $agentsIdentityRaceTarget = Join-Path $agentsIdentityRaceHome 'AGENTS.md'
    $agentsIdentityRaceBytes = [IO.File]::ReadAllBytes($agentsIdentityRaceTarget)
    $agentsIdentityRaceHook = {
        param($DestinationPath)
        $replacementPath = $DestinationPath + '.replacement'
        $replacementBackup = $DestinationPath + '.backup'
        [IO.File]::WriteAllBytes($replacementPath, $agentsIdentityRaceBytes)
        [IO.File]::Replace($replacementPath, $DestinationPath, $replacementBackup, $true)
        Remove-Item -LiteralPath $replacementBackup -Force -ErrorAction Stop
    }.GetNewClosure()
    Assert-ThrowsLike -Action {
        Sync-RevAgentCodexAgents -CodexHome $agentsIdentityRaceHome -GuardRoot $profileRoot -SourcePath $agentsSource -Policy managed-user-pack -BeforeDestinationCommit $agentsIdentityRaceHook | Out-Null
    } -Pattern "AGENTS destination or marker changed before atomic replace.*expectedTargetIdentity" -Message "A same-content AGENTS replacement must fail file-identity CAS."
    Assert-Equal (Get-RevAgentFileSha256 -Path $agentsIdentityRaceTarget) (Get-RevAgentFileSha256 -Path $agentsSource) "AGENTS identity CAS failure changed replacement content."

    $agentsAtomicRaceHome = Join-Path $profileRoot "agents-atomic-race-home"
    New-Item -ItemType Directory -Path $agentsAtomicRaceHome -Force | Out-Null
    Sync-RevAgentCodexAgents -CodexHome $agentsAtomicRaceHome -GuardRoot $profileRoot -SourcePath $agentsSource -Policy managed-user-pack | Out-Null
    $agentsAtomicRaceTarget = Join-Path $agentsAtomicRaceHome 'AGENTS.md'
    $agentsAtomicRaceText = "# writer landed at final AGENTS boundary`r`n"
    $agentsAtomicRaceHook = {
        param($DestinationPath)
        [IO.File]::WriteAllText($DestinationPath, $agentsAtomicRaceText, [Text.UTF8Encoding]::new($false))
    }.GetNewClosure()
    Assert-ThrowsLike -Action {
        Sync-RevAgentCodexAgents -CodexHome $agentsAtomicRaceHome -GuardRoot $profileRoot -SourcePath $agentsSource -Policy managed-user-pack -BeforeAtomicCommit $agentsAtomicRaceHook | Out-Null
    } -Pattern "destination changed during atomic replace" -Message "An AGENTS writer at the final ReplaceFile boundary must be displaced, detected, and restored."
    Assert-Equal (Get-Content -Raw -LiteralPath $agentsAtomicRaceTarget) $agentsAtomicRaceText "Final AGENTS race recovery did not restore writer content."

    $agentsMarkerRaceHome = Join-Path $profileRoot "agents-marker-race-home"
    New-Item -ItemType Directory -Path $agentsMarkerRaceHome -Force | Out-Null
    Sync-RevAgentCodexAgents -CodexHome $agentsMarkerRaceHome -GuardRoot $profileRoot -SourcePath $agentsSource -Policy managed-user-pack | Out-Null
    $agentsMarkerRaceTarget = Join-Path $agentsMarkerRaceHome 'AGENTS.md'
    $agentsMarkerRaceMarker = Join-Path $agentsMarkerRaceHome 'AGENTS.md.revagent-managed.json'
    $agentsMarkerRaceTargetBefore = [IO.File]::ReadAllText($agentsMarkerRaceTarget)
    $agentsMarkerRaceText = '{"managedBy":"operator","note":"concurrent marker"}'
    $agentsMarkerRaceHook = {
        param($DestinationPath, $MarkerPath)
        [IO.File]::WriteAllText($MarkerPath, $agentsMarkerRaceText, [Text.UTF8Encoding]::new($false))
    }.GetNewClosure()
    Assert-ThrowsLike -Action {
        Sync-RevAgentCodexAgents -CodexHome $agentsMarkerRaceHome -GuardRoot $profileRoot -SourcePath $agentsSource -Policy managed-user-pack -BeforeAtomicCommit $agentsMarkerRaceHook | Out-Null
    } -Pattern "target or marker changed between the paired atomic commits" -Message "A marker writer after paired revalidation must win while the AGENTS target rolls back."
    Assert-Equal ([IO.File]::ReadAllText($agentsMarkerRaceTarget)) $agentsMarkerRaceTargetBefore "Marker race did not roll the revAgent AGENTS target back."
    Assert-Equal ([IO.File]::ReadAllText($agentsMarkerRaceMarker)) $agentsMarkerRaceText "Marker race recovery lost the concurrent marker content."
    foreach ($raceHome in @($agentsContentRaceHome, $agentsIdentityRaceHome, $agentsAtomicRaceHome, $agentsMarkerRaceHome)) {
        Assert-Equal @(Get-ChildItem -LiteralPath $raceHome -Force | Where-Object { $_.Name -match '^\.AGENTS\.md\.(revagent|marker)-.*\.(tmp|bak)(\.discard-.*|\.rollback-.*)?$|\.(replacement|backup)$' }).Count 0 "AGENTS CAS fixture left staging/backup artifacts in $raceHome."
    }

    Write-Host "Test managed instruction attestations gate overall success while preserve-local remains advisory"
    $goodInstruction = [pscustomobject]@{ present = $true; loaded = $true; safe = $true }
    $missingInstruction = [pscustomobject]@{ present = $false; loaded = $false; safe = $false }
    $managedInstructionSuccess = & $codexRegistrationModule {
        param($Skill, $Agents)
        Test-RevAgentCodexInstructionPolicySatisfied -Policy managed-user-pack -Skill $Skill -Agents $Agents
    } $goodInstruction $goodInstruction
    $managedInstructionFailure = & $codexRegistrationModule {
        param($Skill, $Agents)
        Test-RevAgentCodexInstructionPolicySatisfied -Policy managed-user-pack -Skill $Skill -Agents $Agents
    } $goodInstruction $missingInstruction
    $preserveInstructionSuccess = & $codexRegistrationModule {
        param($Skill, $Agents)
        Test-RevAgentCodexInstructionPolicySatisfied -Policy preserve-local -Skill $Skill -Agents $Agents
    } $missingInstruction $missingInstruction
    Assert-True ([bool]$managedInstructionSuccess -and -not [bool]$managedInstructionFailure) "managed-user-pack did not require loaded/safe skill and AGENTS attestations."
    Assert-True ([bool]$preserveInstructionSuccess) "preserve-local incorrectly made absent local instruction artifacts fatal."

    Write-Host "Test different UAC identity fails closed"
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $differentSid = if ($currentSid -eq "S-1-5-18") { "S-1-5-19" } else { "S-1-5-18" }
    Assert-ThrowsLike -Action {
        Resolve-RevAgentInteractiveUser -TargetUserSid $differentSid -TargetUserProfileRoot $profileRoot | Out-Null
    } -Pattern "does not match the target user SID" -Message "Different UAC/target identity must fail closed."
    Assert-ThrowsLike -Action {
        Resolve-RevAgentInteractiveUser -TargetUserSid $currentSid -TargetUserProfileRoot $profileRoot | Out-Null
    } -Pattern "ProfileList binding" -Message "The current SID must not be rebound to a caller-selected profile directory."
    Assert-ThrowsLike -Action {
        Resolve-RevAgentInteractiveUser -TargetUserSid $currentSid -TargetUserProfileRoot '%SystemDrive%\Users\BT' | Out-Null
    } -Pattern "token-free" -Message "Caller-supplied profile paths must not expand environment tokens."
    $savedSystemDriveForCodex = $env:SystemDrive
    try {
        $env:SystemDrive = 'Z:'
        $profileTokenProbe = & $codexRegistrationModule { Resolve-RevAgentProfileListPath -ProfileImagePath '%SystemDrive%\Users\fixture' }
        $canonicalSystemDriveForCodex = [IO.Path]::GetPathRoot([Environment]::SystemDirectory).TrimEnd('\')
        Assert-Equal $profileTokenProbe (Join-Path $canonicalSystemDriveForCodex 'Users\fixture') "ProfileList normalization trusted a poisoned SystemDrive environment variable."
    }
    finally { $env:SystemDrive = $savedSystemDriveForCodex }

    Write-Host "Test ChatGPT/Codex open and closed uptake states"
    $closedState = Get-RevAgentCodexAppProcessState -ProcessNames @()
    Assert-True (-not [bool]$closedState.running -and -not [bool]$closedState.uptakeRequiresNewTask) "Closed ChatGPT state is incorrect."
    $chatGptState = Get-RevAgentCodexAppProcessState -ProcessNames @("Unrelated", "ChatGPT")
    Assert-True ([bool]$chatGptState.running -and [bool]$chatGptState.unifiedChatGptDetected -and [bool]$chatGptState.uptakeRequiresNewTask) "Unified ChatGPT open state is incorrect."
    $legacyCodexState = Get-RevAgentCodexAppProcessState -ProcessNames @("Codex")
    Assert-True ([bool]$legacyCodexState.running -and -not [bool]$legacyCodexState.unifiedChatGptDetected) "Legacy Codex process state is incorrect."

    Write-Host "Test fake codex mcp get --json readback"
    $fakeCli = Join-Path $tempRoot 'fake-codex.cmd'
    $fakeCliScript = Join-Path $tempRoot 'fake-codex.js'
    $runtimePath = Join-Path $tempRoot "runtime-server.js"
    $docsPath = Join-Path $tempRoot "docs-server.js"
    $fakeCliSource = @'
const name = process.argv[4];
const entry = name === "revAgent" ? process.env.REVAGENT_FIXTURE_RUNTIME : process.env.REVAGENT_FIXTURE_DOCS;
process.stdout.write(JSON.stringify({enabled:true,transport:{type:"stdio",command:process.env.REVAGENT_FIXTURE_NODE,args:[entry]}}));
'@
    Write-Utf8NoBom -Path $fakeCliScript -Content $fakeCliSource
    Write-Utf8NoBom -Path $fakeCli -Content ('@echo off' + "`r`n" + '"' + $programFilesNode + '" "%~dp0fake-codex.js" %*' + "`r`n")
    $env:REVAGENT_FIXTURE_NODE = $programFilesNode
    $env:REVAGENT_FIXTURE_RUNTIME = $runtimePath
    $env:REVAGENT_FIXTURE_DOCS = $docsPath
    try {
        $readback = Test-RevAgentCodexMcpReadback -CodexCliPath $fakeCli -CodexHome $defaultHome.path -NodePath $programFilesNode -RuntimeServerPath $runtimePath -DocsServerPath $docsPath
    }
    finally {
        Remove-Item Env:\REVAGENT_FIXTURE_NODE, Env:\REVAGENT_FIXTURE_RUNTIME, Env:\REVAGENT_FIXTURE_DOCS -ErrorAction SilentlyContinue
    }
    Assert-True ([bool]$readback.success) ("Fake codex mcp get --json readback failed: " + (($readback.servers | ConvertTo-Json -Depth 8 -Compress)))
    Assert-Equal @($readback.servers).Count 2 "MCP readback did not verify both servers."

    Write-Host "Test fake MCP initialize and tools/list handshake through Program Files Node"
    $fakeMcp = Join-Path $tempRoot "fake-mcp-server.js"
    $fakeMcpText = @'
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"revAgent-fixture",version:"1.0.0"}}}) + "\n");
  } else if (request.method === "tools/list") {
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result:{tools:[{name:"fixture_tool",description:"fixture",inputSchema:{type:"object"}}]}}) + "\n");
  }
});
'@
    Write-Utf8NoBom -Path $fakeMcp -Content $fakeMcpText
    $handshake = Test-RevAgentMcpStdioHandshake -NodePath $programFilesNode -ServerPath $fakeMcp -TimeoutSeconds 10 -ExpectedServerNames @('revAgent-fixture') -ExpectedToolNames @('fixture_tool')
    Assert-True ([bool]$handshake.success -and [bool]$handshake.initializeSuccess -and [bool]$handshake.toolsListSuccess) ("Fake MCP handshake failed: " + ($handshake | ConvertTo-Json -Compress -Depth 8))
    Assert-Equal $handshake.toolCount 1 "Fake MCP tools/list response was not observed."
    Assert-Equal $handshake.serverName "revAgent-fixture" "Fake MCP initialize server identity is incorrect."
    Assert-Equal @($handshake.missingExpectedTools).Count 0 "Expected MCP tool inventory was not verified."

    Write-Host "Test MCP handshake timeout kills proxy, server, and grandchild before returning"
    $handshakeOrphanMarker = Join-Path $tempRoot 'handshake-orphan-survived.txt'
    $handshakeChildPidPath = Join-Path $tempRoot 'handshake-child.pid'
    $timeoutMcp = Join-Path $tempRoot 'timeout-mcp-server.js'
    $timeoutMcpText = @'
const fs = require("fs");
const { spawn } = require("child_process");
const readline = require("readline");
const marker = process.env.REVAGENT_HANDSHAKE_ORPHAN_MARKER;
const pidPath = process.env.REVAGENT_HANDSHAKE_CHILD_PID;
let spawned = false;
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", () => {
  if (spawned) return;
  spawned = true;
  const payload = `const fs=require("fs");setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},"survived"),1800);setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", payload], { stdio: "ignore" });
  fs.writeFileSync(pidPath, String(child.pid));
});
setInterval(() => {}, 1000);
'@
    Write-Utf8NoBom -Path $timeoutMcp -Content $timeoutMcpText
    $env:REVAGENT_HANDSHAKE_ORPHAN_MARKER = $handshakeOrphanMarker
    $env:REVAGENT_HANDSHAKE_CHILD_PID = $handshakeChildPidPath
    try {
        $timeoutHandshake = Test-RevAgentMcpStdioHandshake -NodePath $programFilesNode -ServerPath $timeoutMcp -TimeoutSeconds 1 -ExpectedServerNames @('never-responds')
    }
    finally {
        Remove-Item Env:\REVAGENT_HANDSHAKE_ORPHAN_MARKER, Env:\REVAGENT_HANDSHAKE_CHILD_PID -ErrorAction SilentlyContinue
    }
    Assert-True (-not [bool]$timeoutHandshake.success -and $timeoutHandshake.error -match 'timed out') "Timed-out MCP handshake did not fail closed with timeout evidence."
    $handshakeChildPid = [int](Get-Content -Raw -LiteralPath $handshakeChildPidPath)
    Start-Sleep -Milliseconds 2200
    Assert-True (-not (Test-Path -LiteralPath $handshakeOrphanMarker)) "An MCP handshake grandchild survived the proxy/server job cleanup."
    Assert-True ($null -eq (Get-Process -Id $handshakeChildPid -ErrorAction SilentlyContinue)) "An MCP handshake grandchild remained alive after the function returned."

    Write-Host "Test strict MCP handshake rejects malformed identity, protocol, and inventory responses"
    $strictMcpFixture = @'
const path = require("path");
const mode = path.basename(__filename, ".js").replace(/^strict-/, "");
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    let response = {jsonrpc:"2.0",id:request.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"revAgent-fixture",version:"1.0.0"}}};
    if (mode === "empty-initialize") response.result = {};
    if (mode === "wrong-jsonrpc") response.jsonrpc = "1.0";
    if (mode === "wrong-initialize-id") response.id = "1";
    if (mode === "wrong-protocol") response.result.protocolVersion = "2024-11-05";
    if (mode === "missing-server-info") delete response.result.serverInfo;
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (request.method === "tools/list") {
    let response = {jsonrpc:"2.0",id:request.id,result:{tools:[{name:"fixture_tool",description:"fixture",inputSchema:{type:"object"}}]}};
    if (mode === "wrong-tools-id") response.id = "2";
    if (mode === "missing-tools") response.result = {};
    if (mode === "empty-tools") response.result.tools = [];
    if (mode === "tools-not-array") response.result.tools = {name:"fixture_tool"};
    if (mode === "missing-expected-tool") response.result.tools = [{name:"different_tool",description:"fixture",inputSchema:{type:"object"}}];
    process.stdout.write(JSON.stringify(response) + "\n");
  }
});
'@
    foreach ($mode in @('empty-initialize', 'wrong-jsonrpc', 'wrong-initialize-id', 'wrong-protocol', 'missing-server-info', 'wrong-tools-id', 'missing-tools', 'empty-tools', 'tools-not-array', 'missing-expected-tool')) {
        $strictFixturePath = Join-Path $tempRoot ("strict-$mode.js")
        Write-Utf8NoBom -Path $strictFixturePath -Content $strictMcpFixture
        $strictResult = Test-RevAgentMcpStdioHandshake -NodePath $programFilesNode -ServerPath $strictFixturePath -TimeoutSeconds 10 -ExpectedServerNames @('revAgent-fixture') -ExpectedToolNames @('fixture_tool')
        Assert-True (-not [bool]$strictResult.success) "Strict MCP handshake accepted malformed mode '$mode'."
        Assert-True (-not [string]::IsNullOrWhiteSpace([string]$strictResult.error)) "Strict MCP rejection for '$mode' did not preserve evidence."
    }

    Write-Host "Test machine execution-tree hardlink and reparse fixtures"
    $managedTree = Join-Path $tempRoot "managed-machine-tree"
    $outsideFile = Join-Path $tempRoot "outside-machine-target.txt"
    New-Item -ItemType Directory -Path $managedTree -Force | Out-Null
    Write-Utf8NoBom -Path (Join-Path $managedTree "regular.txt") -Content "regular"
    [void](Assert-RevAgentManagedTreeLinkSafe -Root $managedTree)
    Write-Utf8NoBom -Path $outsideFile -Content "outside"
    $machineHardlink = Join-Path $managedTree "planted-hardlink.txt"
    New-Item -ItemType HardLink -Path $machineHardlink -Target $outsideFile | Out-Null
    Assert-ThrowsLike -Action {
        Assert-RevAgentManagedTreeLinkSafe -Root $managedTree | Out-Null
    } -Pattern "hard-linked file" -Message "Managed machine tree must reject a planted hardlink before ACL reset or elevated writes."
    Remove-Item -LiteralPath $machineHardlink -Force
    $outsideDirectory = Join-Path $tempRoot "outside-machine-directory"
    New-Item -ItemType Directory -Path $outsideDirectory -Force | Out-Null
    Write-Utf8NoBom -Path (Join-Path $outsideDirectory "target-must-survive.txt") -Content "survive"
    $machineJunction = Join-Path $managedTree "planted-junction"
    New-Item -ItemType Junction -Path $machineJunction -Target $outsideDirectory | Out-Null
    Assert-ThrowsLike -Action {
        Assert-RevAgentManagedTreeLinkSafe -Root $managedTree | Out-Null
    } -Pattern "reparse point" -Message "Managed machine tree must reject a planted junction before recursive ACL work."
    [RevAgent.PermissionNativeFileInfo]::RemoveDirectoryLink($machineJunction)
    Assert-True (-not (Test-Path -LiteralPath $machineJunction)) "Managed junction unlink left the reparse leaf in place."
    Assert-True (Test-Path -LiteralPath (Join-Path $outsideDirectory "target-must-survive.txt") -PathType Leaf) "Managed junction unlink traversed into and damaged its target."

    Write-Host "Test elevated interactive identity binding and spoof rejection"
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $currentProfileKey = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($currentIdentity.User.Value)"
    $canonicalSystemDrive = [IO.Path]::GetPathRoot([Environment]::SystemDirectory).TrimEnd('\')
    $currentProfileValue = [string](Get-ItemProperty -LiteralPath $currentProfileKey -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath
    $currentProfile = [regex]::Replace($currentProfileValue, '(?i)%SystemDrive%', $canonicalSystemDrive)
    Assert-True ($currentProfile -notmatch '%[^%]+%') "Current ProfileList fixture contains an unsupported environment token."
    $currentBinding = Resolve-RevAgentInteractiveUserBinding `
        -TargetInteractiveUser $currentIdentity.Name `
        -TargetInteractiveUserSid $currentIdentity.User.Value `
        -TargetUserProfileRoot $currentProfile
    Assert-Equal $currentBinding.Sid $currentIdentity.User.Value "Production SID-to-NTAccount/ProfileList binding changed the current SID."
    Assert-Equal $currentBinding.UserName $currentIdentity.Name "Production SID-to-NTAccount binding changed the current account."

    $fixtureSid = "S-1-5-21-111111111-222222222-333333333-1001"
    $differentFixtureSid = "S-1-5-21-111111111-222222222-333333333-1002"
    $fixtureAccount = "REVAGENT-TEST\fixture-user"
    $fixtureProfile = Join-Path $tempRoot "fixture-profile"
    $differentProfile = Join-Path $tempRoot "different-profile"
    New-Item -ItemType Directory -Path $fixtureProfile, $differentProfile -Force | Out-Null
    $fixtureProfileKey = Join-Path $profileListFixtureRoot $fixtureSid
    New-Item -Path $fixtureProfileKey -Force | Out-Null
    Assert-True ($fixtureProfile.StartsWith($canonicalSystemDrive + '\', [StringComparison]::OrdinalIgnoreCase)) "Disposable profile fixture must be on the canonical Windows system drive."
    $fixtureProfileToken = '%SystemDrive%' + $fixtureProfile.Substring($canonicalSystemDrive.Length)
    New-ItemProperty -LiteralPath $fixtureProfileKey -Name ProfileImagePath -Value $fixtureProfileToken -PropertyType String -Force | Out-Null
    $fixtureAccountLookup = {
        param([string]$Sid)
        [pscustomobject]@{ AccountName = $fixtureAccount; SidType = 'User' }
    }.GetNewClosure()
    $fixtureBinding = Resolve-RevAgentInteractiveUserBinding `
        -TargetInteractiveUser $fixtureAccount `
        -TargetInteractiveUserSid $fixtureSid `
        -TargetUserProfileRoot $fixtureProfile `
        -ProfileListRegistryRoot $profileListFixtureRoot `
        -AccountLookupOverride $fixtureAccountLookup
    Assert-Equal $fixtureBinding.Sid $fixtureSid "Disposable identity fixture changed the bound SID."
    Assert-Equal $fixtureBinding.ProfileRoot ([IO.Path]::GetFullPath($fixtureProfile)) "Disposable identity fixture changed the ProfileList path."
    $savedSystemDrive = $env:SystemDrive
    try {
        $env:SystemDrive = 'Z:'
        $poisonedSystemDriveBinding = Resolve-RevAgentInteractiveUserBinding -TargetInteractiveUser $fixtureAccount -TargetInteractiveUserSid $fixtureSid -TargetUserProfileRoot $fixtureProfile -ProfileListRegistryRoot $profileListFixtureRoot -AccountLookupOverride $fixtureAccountLookup
        Assert-Equal $poisonedSystemDriveBinding.ProfileRoot ([IO.Path]::GetFullPath($fixtureProfile)) "Poisoned SystemDrive redirected ProfileImagePath normalization."
    }
    finally {
        $env:SystemDrive = $savedSystemDrive
    }
    Assert-ThrowsLike -Action {
        Resolve-RevAgentInteractiveUserBinding -TargetInteractiveUser $fixtureAccount -TargetInteractiveUserSid $fixtureSid -TargetUserProfileRoot $fixtureProfileToken -ProfileListRegistryRoot $profileListFixtureRoot -AccountLookupOverride $fixtureAccountLookup | Out-Null
    } -Pattern "absolute path captured|environment tokens" -Message "TargetUserProfileRoot must already be an absolute pre-UAC capture."
    Set-ItemProperty -LiteralPath $fixtureProfileKey -Name ProfileImagePath -Value '%USERPROFILE%\fixture-profile' -Force
    Assert-ThrowsLike -Action {
        Resolve-RevAgentInteractiveUserBinding -TargetInteractiveUser $fixtureAccount -TargetInteractiveUserSid $fixtureSid -TargetUserProfileRoot $fixtureProfile -ProfileListRegistryRoot $profileListFixtureRoot -AccountLookupOverride $fixtureAccountLookup | Out-Null
    } -Pattern "unsupported environment token" -Message "ProfileList must reject every environment token except SystemDrive."
    Set-ItemProperty -LiteralPath $fixtureProfileKey -Name ProfileImagePath -Value $fixtureProfileToken -Force
    Assert-ThrowsLike -Action {
        Resolve-RevAgentInteractiveUserBinding -TargetInteractiveUser "REVAGENT-TEST\different-user" -TargetInteractiveUserSid $fixtureSid -TargetUserProfileRoot $fixtureProfile -ProfileListRegistryRoot $profileListFixtureRoot -AccountLookupOverride $fixtureAccountLookup | Out-Null
    } -Pattern "account mismatch" -Message "A spoofed interactive account name must fail closed."
    Assert-ThrowsLike -Action {
        Resolve-RevAgentInteractiveUserBinding -TargetInteractiveUser $fixtureAccount -TargetInteractiveUserSid $fixtureSid -TargetUserProfileRoot $differentProfile -ProfileListRegistryRoot $profileListFixtureRoot -AccountLookupOverride $fixtureAccountLookup | Out-Null
    } -Pattern "profile mismatch" -Message "A spoofed interactive profile path must fail closed."
    Assert-ThrowsLike -Action {
        Resolve-RevAgentInteractiveUserBinding -TargetInteractiveUser $fixtureAccount -TargetInteractiveUserSid $differentFixtureSid -TargetUserProfileRoot $fixtureProfile -ProfileListRegistryRoot $profileListFixtureRoot -AccountLookupOverride $fixtureAccountLookup | Out-Null
    } -Pattern "ProfileList binding" -Message "A different unbound SID must fail closed."
    $groupLookup = { param([string]$Sid) [pscustomobject]@{ AccountName = $fixtureAccount; SidType = 'Group' } }.GetNewClosure()
    Assert-ThrowsLike -Action {
        Resolve-RevAgentInteractiveUserBinding -TargetInteractiveUser $fixtureAccount -TargetInteractiveUserSid $fixtureSid -TargetUserProfileRoot $fixtureProfile -ProfileListRegistryRoot $profileListFixtureRoot -AccountLookupOverride $groupLookup | Out-Null
    } -Pattern "non-user account type" -Message "A group SID must fail closed even when a profile fixture is planted."
    Assert-ThrowsLike -Action {
        Resolve-RevAgentInteractiveUserBinding -TargetInteractiveUser "Everyone" -TargetInteractiveUserSid "S-1-1-0" -TargetUserProfileRoot $fixtureProfile -ProfileListRegistryRoot $profileListFixtureRoot -AccountLookupOverride $fixtureAccountLookup | Out-Null
    } -Pattern "broad|well-known" -Message "A broad/well-known SID must fail closed."

    Write-Host "Test scheduled-task action requires exact canonical wscript host"
    $canonicalWscript = Join-Path ([Environment]::SystemDirectory) "wscript.exe"
    $fixtureArguments = "//B //Nologo `"C:\ProgramData\DPE\revAgent\updater\Run-revAgent-Update-Hidden.vbs`""
    Assert-True (Test-RevAgentHiddenScheduledTaskActionMatch -CurrentExecute $canonicalWscript -CurrentArguments $fixtureArguments -DesiredExecute $canonicalWscript -DesiredArguments $fixtureArguments) "Canonical System32 wscript action must remain current."
    Assert-True (-not (Test-RevAgentHiddenScheduledTaskActionMatch -CurrentExecute "wscript.exe" -CurrentArguments $fixtureArguments -DesiredExecute $canonicalWscript -DesiredArguments $fixtureArguments)) "Bare wscript.exe must require scheduled-task repair."
    Assert-True (-not (Test-RevAgentHiddenScheduledTaskActionMatch -CurrentExecute (Join-Path $tempRoot "wscript.exe") -CurrentArguments $fixtureArguments -DesiredExecute $canonicalWscript -DesiredArguments $fixtureArguments)) "Non-System32 wscript path must require scheduled-task repair."

    Write-Host "Test poisoned PSModulePath cannot shadow built-in trust/archive commands"
    $poisonModuleRoot = Join-Path $tempRoot "poison-modules"
    $poisonMarker = Join-Path $tempRoot "poison-module-loaded.txt"
    foreach ($fixture in @(
            [pscustomobject]@{ Name = "Microsoft.PowerShell.Security"; Function = "Get-Acl" },
            [pscustomobject]@{ Name = "Microsoft.PowerShell.Archive"; Function = "Expand-Archive" }
        )) {
        $fixtureRoot = Join-Path $poisonModuleRoot $fixture.Name
        $fixtureModulePath = Join-Path $fixtureRoot ($fixture.Name + ".psm1")
        $fixtureManifestPath = Join-Path $fixtureRoot ($fixture.Name + ".psd1")
        $moduleText = @"
[System.IO.File]::AppendAllText(`$env:REVAGENT_POISON_MODULE_MARKER, '$($fixture.Name)' + [Environment]::NewLine)
function $($fixture.Function) {
    [System.IO.File]::AppendAllText(`$env:REVAGENT_POISON_MODULE_MARKER, '$($fixture.Function)' + [Environment]::NewLine)
    throw 'poison module executed'
}
Export-ModuleMember -Function '$($fixture.Function)'
"@
        $manifestText = @"
@{
    RootModule = '$($fixture.Name).psm1'
    ModuleVersion = '1.0.0'
    GUID = '$([Guid]::NewGuid())'
    FunctionsToExport = @('$($fixture.Function)')
    CmdletsToExport = @()
    VariablesToExport = @()
    AliasesToExport = @()
}
"@
        Write-Utf8NoBom -Path $fixtureModulePath -Content $moduleText
        Write-Utf8NoBom -Path $fixtureManifestPath -Content $manifestText
    }

    $hostExecutable = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $poisonControl = Join-Path $tempRoot "poison-control.ps1"
    Write-Utf8NoBom -Path $poisonControl -Content @'
Import-Module Microsoft.PowerShell.Security -Force -ErrorAction Stop
Import-Module Microsoft.PowerShell.Archive -Force -ErrorAction Stop
'@
    $env:PSModulePath = $poisonModuleRoot + [IO.Path]::PathSeparator + $previousPsModulePath
    $env:REVAGENT_POISON_MODULE_MARKER = $poisonMarker
    & $hostExecutable -NoProfile -ExecutionPolicy Bypass -File $poisonControl | Out-Null
    Assert-Equal $LASTEXITCODE 0 "Poisoned-module control process failed."
    $poisonControlText = Get-Content -Raw -LiteralPath $poisonMarker
    Assert-True ($poisonControlText -match 'Microsoft\.PowerShell\.Security' -and $poisonControlText -match 'Microsoft\.PowerShell\.Archive') "Poisoned PSModulePath fixture did not prove both fake modules were discoverable."
    Remove-Item -LiteralPath $poisonMarker -Force

    $modulePathCases = @(
        [pscustomobject]@{ Name = "GUI"; Path = (Join-Path $RepoRoot "installer\nas\Install-revAgent-Updater-GUI.ps1"); Extra = @() },
        [pscustomobject]@{ Name = "updater"; Path = (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1"); Extra = @() },
        [pscustomobject]@{ Name = "updater task installer"; Path = (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1"); Extra = @("-ChannelManifestPath", (Join-Path $tempRoot "unused-channel.json")) },
        [pscustomobject]@{ Name = "self-contained installer"; Path = (Join-Path $RepoRoot "installer\install-self-contained.ps1"); Extra = @() },
        [pscustomobject]@{ Name = "Codex user integration"; Path = (Join-Path $RepoRoot "installer\nas\Invoke-revAgent-CodexUserIntegration.ps1"); Extra = @() }
    )
    $expectedSecurityManifest = [IO.Path]::Combine($PSHOME, "Modules", "Microsoft.PowerShell.Security", "Microsoft.PowerShell.Security.psd1")
    $archiveProgramFilesRoots = @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { [IO.Path]::Combine($_, 'WindowsPowerShell', 'Modules') }
    $expectedArchiveManifest = Resolve-RevAgentTestTrustedArchiveManifest -PsHomeModulesRoot ([IO.Path]::Combine($PSHOME, 'Modules')) -ProgramFilesModuleRoots $archiveProgramFilesRoots
    $allowedArchiveModuleRoots = @((@([IO.Path]::Combine($PSHOME, 'Modules')) + @($archiveProgramFilesRoots)) | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') + '\' })
    foreach ($case in $modulePathCases) {
        $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $case.Path, "-ModulePathSecuritySmokeTest") + @($case.Extra)
        $output = @(& $hostExecutable @arguments 2>&1 | ForEach-Object { [string]$_ })
        Assert-Equal $LASTEXITCODE 0 "$($case.Name) module-path security smoke process failed. Output: $($output -join ' | ')"
        $jsonLine = @($output | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1)
        Assert-Equal $jsonLine.Count 1 "$($case.Name) did not return one module-path security result. Output: $($output -join ' | ')"
        $probe = $jsonLine[0] | ConvertFrom-Json
        Assert-True ([bool]$probe.success) "$($case.Name) module-path security probe did not succeed."
        Assert-True (([string]$probe.psModulePath).IndexOf($poisonModuleRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) "$($case.Name) retained the user-writable poison module root."
        Assert-True ([string]::Equals([IO.Path]::GetFullPath([string]$probe.getAclModulePath), [IO.Path]::GetFullPath($expectedSecurityManifest), [StringComparison]::OrdinalIgnoreCase)) "$($case.Name) did not bind Get-Acl to the exact PSHOME manifest."
        $actualArchiveManifest = [IO.Path]::GetFullPath([string]$probe.expandArchiveModulePath)
        Assert-True ([string]::Equals($actualArchiveManifest, [IO.Path]::GetFullPath($expectedArchiveManifest), [StringComparison]::OrdinalIgnoreCase)) "$($case.Name) did not bind Expand-Archive to the deterministic trusted Archive manifest."
        Assert-True (@($allowedArchiveModuleRoots | Where-Object { $actualArchiveManifest.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -eq 1) "$($case.Name) bound Expand-Archive outside trusted WindowsPowerShell module roots."
        Assert-True (-not (Test-Path -LiteralPath $poisonMarker)) "$($case.Name) loaded or executed a fake module from poisoned PSModulePath."
    }

    Write-Host "Test Program Files Archive fallback resolver"
    $archiveFallbackRoot = Join-Path $tempRoot 'archive-program-files-fixture'
    $archiveFallbackModuleRoot = Join-Path $archiveFallbackRoot 'WindowsPowerShell\Modules'
    $archiveFallbackPackageRoot = Join-Path $archiveFallbackModuleRoot 'Microsoft.PowerShell.Archive'
    $olderArchiveManifest = Join-Path $archiveFallbackPackageRoot '1.0.1.0\Microsoft.PowerShell.Archive.psd1'
    $newerArchiveManifest = Join-Path $archiveFallbackPackageRoot '9.2.0\Microsoft.PowerShell.Archive.psd1'
    New-Item -ItemType Directory -Path (Split-Path -Parent $olderArchiveManifest) -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $newerArchiveManifest) -Force | Out-Null
    Write-Utf8NoBom -Path $olderArchiveManifest -Content '@{}'
    Write-Utf8NoBom -Path $newerArchiveManifest -Content '@{}'
    $archiveReparseModuleRoot = Join-Path $archiveFallbackRoot 'reparse-fixture\WindowsPowerShell\Modules'
    $archiveReparseTarget = Join-Path $archiveFallbackRoot 'reparse-target'
    $archiveReparseDirectManifest = Join-Path $archiveReparseTarget 'Microsoft.PowerShell.Archive.psd1'
    New-Item -ItemType Directory -Path $archiveReparseModuleRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $archiveReparseTarget -Force | Out-Null
    Write-Utf8NoBom -Path $archiveReparseDirectManifest -Content '@{}'
    New-Item -ItemType Junction -Path (Join-Path $archiveReparseModuleRoot 'Microsoft.PowerShell.Archive') -Target $archiveReparseTarget | Out-Null
    $archiveResolverCases = @($modulePathCases + [pscustomobject]@{ Name = 'bootstrap refresh'; Path = (Join-Path $RepoRoot 'installer\nas\Refresh-revAgent-LocalBootstrap-STABLE.ps1') })
    foreach ($case in $archiveResolverCases) {
        $resolverTokens = $null
        $resolverErrors = $null
        $resolverAst = [Management.Automation.Language.Parser]::ParseFile([string]$case.Path, [ref]$resolverTokens, [ref]$resolverErrors)
        Assert-Equal @($resolverErrors).Count 0 "$($case.Name) Archive resolver source did not parse."
        $resolverFunction = @($resolverAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-RevAgentTrustedArchiveManifest' }, $true))
        Assert-Equal $resolverFunction.Count 1 "$($case.Name) must define exactly one trusted Archive resolver."
        $resolverModule = New-Module -ScriptBlock ([scriptblock]::Create($resolverFunction[0].Extent.Text))
        try {
            $resolvedFallback = & $resolverModule { Resolve-RevAgentTrustedArchiveManifest -PsHomeModulesRoot $args[0] -ProgramFilesModuleRoots @($args[1]) } (Join-Path $tempRoot 'missing-pshome\Modules') $archiveFallbackModuleRoot
            Assert-True ([string]::Equals([IO.Path]::GetFullPath([string]$resolvedFallback), [IO.Path]::GetFullPath($newerArchiveManifest), [StringComparison]::OrdinalIgnoreCase)) "$($case.Name) did not select the highest versioned Program Files Archive manifest."
            Assert-ThrowsLike -Action {
                & $resolverModule { Resolve-RevAgentTrustedArchiveManifest -PsHomeModulesRoot $args[0] -ProgramFilesModuleRoots @($args[1]) } (Join-Path $tempRoot 'missing-pshome\Modules') $archiveReparseModuleRoot | Out-Null
            } -Pattern 'Archive module root is a reparse point' -Message "$($case.Name) accepted a direct Program Files Archive manifest through a reparse root."
        }
        finally {
            Remove-Module $resolverModule -Force -ErrorAction SilentlyContinue
        }
    }
    $env:PSModulePath = $previousPsModulePath
    Remove-Item Env:\REVAGENT_POISON_MODULE_MARKER -ErrorAction SilentlyContinue

    Write-Host "Test static P0 machine/user privilege boundary"
    $guiText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Install-revAgent-Updater-GUI.ps1")
    $updaterText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
    $installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
    $scheduledText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.ScheduledTask.psm1")
    $selfContainedText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\install-self-contained.ps1")
    $codexUserIntegrationText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Invoke-revAgent-CodexUserIntegration.ps1")
    $snapshotBrokerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1")
    $permissionsText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.Permissions.psm1")
    $codexRegistrationText = Get-Content -Raw -LiteralPath $modulePath
    $workspaceSkillPath = Join-Path $RepoRoot ".agents\skills\revAgent\SKILL.md"

    Assert-True ($guiText -match 'function Assert-GuiProtectedSnapshotBroker' -and $guiText -match 'New-RevAgentAuthenticatedReleaseInbox' -and $guiText -match 'TargetArgumentsBase64' -and $guiText -match 'Start-GuiPhaseProcess -ScriptPath \$brokerPath') "GUI must elevate only the protected local snapshot broker after signed inbox acquisition."
    Assert-True ($guiText -match '\$psi\.Verb\s*=\s*"runas"' -and $guiText -match '"-Target", \$machineComponentKey' -and $guiText -match '"-UserPhaseOnly"') "GUI must elevate only the broker-owned machine phase and resume a separate user phase."
    Assert-True ($guiText -match '"-BrokerLogPath", \$script:ActiveBrokerLogPath' -and $snapshotBrokerText -match '\[string\]\$BrokerLogPath' -and $snapshotBrokerText -match 'BrokerLogPath is outside the canonical per-run broker log pattern' -and $snapshotBrokerText -match 'Write-RevAgentBrokerLog') "GUI/broker diagnostics must stay inside the canonical machine-log boundary and never rely on unbounded elevated stdout."
    Assert-True ($guiText -match 'PendingUserPhaseComponentKey' -and $guiText -match 'Resolve-GuiSnapshotUserEntrypoint -PhaseResult \$phaseResult' -and $guiText -match 'ExecutionSnapshotStatePath' -and $guiText -match 'authenticated local snapshot') "GUI must re-attest and resume the protected local snapshot user entrypoint from the original unelevated process."
    $guiInboxCleanupIndex = $guiText.LastIndexOf('Remove-GuiAuthenticatedInbox -Path $script:ActiveInboxRoot')
    $guiSnapshotUserResumeIndex = $guiText.IndexOf('Resolve-GuiSnapshotUserEntrypoint -PhaseResult $phaseResult')
    Assert-True ($guiText -match 'function Remove-GuiAuthenticatedInbox' -and $guiText -match '\^\[a-f0-9\]\{32\}\$' -and $guiInboxCleanupIndex -ge 0 -and $guiSnapshotUserResumeIndex -gt $guiInboxCleanupIndex) "GUI must consume and safely remove the exact authenticated user inbox before resuming from the protected machine snapshot."
    $guiEarlyElevationGuardIndex = $guiText.IndexOf('The revAgent updater GUI refuses elevated execution before local bootstrap module import')
    $guiEarlyOriginGuardIndex = $guiText.IndexOf('Updater GUI must run from the protected local bootstrap before module import')
    $guiLocalModuleImportIndex = $guiText.IndexOf('Import-Module $localSourceFreeMigrationModule -Force')
    Assert-True ($guiEarlyElevationGuardIndex -ge 0 -and $guiEarlyOriginGuardIndex -ge 0 -and $guiLocalModuleImportIndex -ge 0 -and $guiEarlyElevationGuardIndex -lt $guiLocalModuleImportIndex -and $guiEarlyOriginGuardIndex -lt $guiLocalModuleImportIndex) "GUI must reject elevation/canonical-origin mismatch before importing any bootstrap-selected module."

    Assert-True ($updaterText -match 'if \(\$currentProcessElevated -and -not \$MachinePhaseOnly\)' -and $updaterText -match 'Elevated updater execution is restricted to -MachinePhaseOnly') "Updater must reject elevated legacy/user-mode execution."
    $updaterEarlyGuardIndex = $updaterText.IndexOf('Mutating legacy updater execution is disabled before module import')
    $updaterFirstProductImportIndex = $updaterText.IndexOf('Import-Module (Join-Path $nasLibRoot "RevAgent.SecureTemp.psm1")')
    Assert-True ($updaterEarlyGuardIndex -ge 0 -and $updaterFirstProductImportIndex -ge 0 -and $updaterEarlyGuardIndex -lt $updaterFirstProductImportIndex) "Updater must reject unsafe elevation/legacy modes before any sibling module import."
    $installEarlyGuardIndex = $installTaskText.IndexOf('Legacy updater bootstrap execution is disabled before module import')
    $installFirstProductImportIndex = $installTaskText.IndexOf('Import-Module (Join-Path $nasLibRoot "RevAgent.SecureTemp.psm1")')
    Assert-True ($installEarlyGuardIndex -ge 0 -and $installFirstProductImportIndex -ge 0 -and $installEarlyGuardIndex -lt $installFirstProductImportIndex) "Updater bootstrap must require exactly one privilege phase before any sibling module import."
    Assert-True ($updaterText -match 'function Assert-RevAgentElevatedPathTrusted' -and $updaterText -match 'RevAgentOsLocalAppData' -and $updaterText -match 'RevAgentOsAppData' -and $updaterText -match 'Refusing to use a user-writable path while elevated') "Elevated updater must reject LocalAppData/AppData/user-root executables resolved from canonical known folders."
    Assert-True ($updaterText -match 'function Assert-RevAgentMachinePhasePaths' -and $updaterText -match 'Assert-RevAgentMachinePhasePaths') "Machine updater must validate all privileged path inputs before work."
    Assert-True ($updaterText -match 'Resolve-RevAgentInteractiveUserBinding' -and $installTaskText -match 'Resolve-RevAgentInteractiveUserBinding') "Both elevated machine entrypoints must rebind SID/account/profile through the trusted identity resolver."
    $protectedCodexProvisionIndex = $updaterText.IndexOf('Install-RevAgentProtectedCodexCliFromStore')
    $managedAgentsCleanupIndex = $updaterText.IndexOf('Invoke-RevAgentManagedCodexAgentsMachineCleanup')
    $installedStateCommitIndex = $updaterText.IndexOf('$newState = [ordered]@{', $protectedCodexProvisionIndex)
    Assert-True ($protectedCodexProvisionIndex -ge 0 -and $installedStateCommitIndex -gt $protectedCodexProvisionIndex -and $updaterText -match '-TargetUserSid \$TargetInteractiveUserSid' -and $updaterText -match 'protectedCodexCli = \$protectedCodexCliProvision') "Machine phase must materialize the target user's Store CLI into protected ProgramData before committing successful installed state/report evidence."
    Assert-True ($managedAgentsCleanupIndex -ge 0 -and $managedAgentsCleanupIndex -lt $protectedCodexProvisionIndex -and $updaterText -match 'target-not-current-managed-source' -and $updaterText -match 'Remove-Item -LiteralPath \$targetPath -Force -ErrorAction Stop' -and $updaterText -match '-InstructionPolicy \$CodexInstructionPolicy' -and $updaterText -match 'managedCodexAgentsMachineCleanup = \$managedCodexAgentsMachineCleanup') "Machine phase must hash-guard cleanup of legacy admin-owned managed CODEX_HOME/AGENTS.md before the unelevated user integration rewrites it."

    Assert-True ($scheduledText -match '"-AuditOnly"' -and $scheduledText -match 'scheduled-update-audit') "Scheduled task must be audit-only."
    Assert-True ($scheduledText -notmatch '"-MachinePhaseOnly"') "Scheduled task module must not silently run the elevated machine phase."
    Assert-True ($scheduledText -match 'Test-RevitMcpHiddenScheduledTaskActionMatch' -and $scheduledText -notmatch '\$currentExecute,\s*"wscript\.exe"') "Scheduled task repair must not accept a PATH-resolved bare wscript.exe action."
    Assert-True ($selfContainedText -match '\[switch\]\$SkipUserProfileCleanup' -and $selfContainedText -match 'Elevated self-contained install requires -SkipUserProfileCleanup, -SkipLegacyCleanup') "Self-contained installer must expose and enforce SkipUserProfileCleanup/SkipLegacyCleanup at the machine boundary."
    $machineOnlyGuardIndex = $selfContainedText.IndexOf('machine-only and requires -SkipCodexUserIntegration')
    $codexModuleImportIndex = $selfContainedText.IndexOf('Import-RevAgentProtectedInstallerModule -Path (Join-Path $installerLibRoot "RevAgent.CodexRegistration.psm1")')
    Assert-True ($machineOnlyGuardIndex -ge 0 -and $codexModuleImportIndex -ge 0 -and $machineOnlyGuardIndex -lt $codexModuleImportIndex) "Self-contained installer must fail closed before importing product modules when direct user integration was not disabled."
    $selfContainedOriginGuardIndex = $selfContainedText.IndexOf('Elevated self-contained installation must run from the protected installed package')
    Assert-True ($selfContainedOriginGuardIndex -ge 0 -and $selfContainedOriginGuardIndex -lt $codexModuleImportIndex -and $selfContainedText -match 'Protected installer origin grants write-capable access') "Self-contained installer must reject user-writable/repo elevation before sibling imports."
    Assert-True ($selfContainedText -match 'owner must be SYSTEM or Administrators' -and $selfContainedText -match 'root DACL must be protected' -and $selfContainedText -match 'foreign principal') "Self-contained origin must enforce owner, protected-root DACL, and every foreign write ACE."
    Assert-True ($selfContainedText -match 'GetLinkCount' -and $selfContainedText -match 'GetIdentity' -and $selfContainedText -match 'exactly one hardlink reference' -and $selfContainedText -match 'changed identity or content before import') "Self-contained origin must bind each imported file to one stable filesystem identity/content instance."
    Assert-True ($selfContainedText -match 'CreateRestrictedToken' -and $selfContainedText -match 'FileMode\.CreateNew' -and $selfContainedText -match 'FileMode\.Append' -and $selfContainedText -match 'CreateNew succeeded' -and $selfContainedText -match 'effectively append-writable') "Self-contained origin must run effective restricted-token CreateNew and append probes."
    Assert-True ($selfContainedText -match 'function New-RevAgentProtectedInstallerSubdirectory' -and $selfContainedText -match 'FileSystemAclExtensions\]::CreateDirectory' -and $selfContainedText -match 'No ACL-at-create directory API is available') "Self-contained native validation must compile only from an ACL-at-create protected machine temp on PS7 and PS5.1."
    foreach ($protectedModuleName in @('RevAgent.SecureTemp.psm1', 'RevAgent.HiddenLauncher.psm1', 'RevAgent.ScheduledTask.psm1', 'RevAgent.RevitVersions.psm1', 'RevAgent.Permissions.psm1', 'RevAgent.LogRetention.psm1', 'RevAgent.CodexRegistration.psm1', 'RevAgent.ConfigSync.psm1', 'RevAgent.DesktopLauncherCleanup.psm1')) {
        Assert-True ($selfContainedText -match [regex]::Escape('Import-RevAgentProtectedInstallerModule -Path (Join-Path $installerLibRoot "' + $protectedModuleName + '")')) "Self-contained installer bypassed protected import for $protectedModuleName."
    }
    $codexUserEarlyGuardIndex = $codexUserIntegrationText.IndexOf('Codex user integration must run unelevated before sibling module import')
    $codexUserProductImportIndex = $codexUserIntegrationText.IndexOf('Import-Module $modulePath[0] -Force')
    Assert-True ($codexUserEarlyGuardIndex -ge 0 -and $codexUserProductImportIndex -ge 0 -and $codexUserEarlyGuardIndex -lt $codexUserProductImportIndex) "Codex user entrypoint must reject elevation before resolving/importing its sibling product module."
    Assert-True ($permissionsText -match 'function Protect-RevitMcpManagedExecutionTree' -and $permissionsText -match 'function Grant-RevitMcpUserStateAccess') "Permissions module must separate protected machine execution trees from user state."
    Assert-True ($permissionsText -match 'Join-Path \$WorkRoot "user-state"' -and $permissionsText -match 'Join-Path \$WorkRoot "logs"') "User write ACLs must be limited to logs/user-state."
    Assert-True ($permissionsText -match 'SetAccessRuleProtection\(\$true, \$false\)' -and $permissionsText -match 'S-1-5-32-545' -and $permissionsText -match 'ReadAndExecute') "Protected machine tree must replace its DACL with the SYSTEM/Admin/Users-RX allowlist."
    Assert-True ($permissionsText -match 'runtime\\node_modules' -and $permissionsText -match 'RemoveDirectoryLink' -and $permissionsText -match 'Set-Acl -LiteralPath \$child\.FullName -AclObject \$security' -and $permissionsText -match 'Set-Acl -LiteralPath \$child\.FullName -AclObject \$fileSecurity') "ACL migration must safely unlink exact prior-version npm junctions and lock directories/files top-down."
    $immutableDiscoveryIndex = $permissionsText.IndexOf("foreach (`$leaf in @('bootstrap', 'execution-snapshots', 'broker-state'))")
    $rootAclMutationIndex = $permissionsText.IndexOf('Set-Acl -LiteralPath $root -AclObject $security')
    Assert-True ($immutableDiscoveryIndex -ge 0 -and $rootAclMutationIndex -gt $immutableDiscoveryIndex -and $permissionsText -match 'function Assert-RevitMcpImmutableSecurityTree' -and $permissionsText -match 'immutableSecurityRoots\.Contains' -and $permissionsText -match 'foreach \(\$immutableRoot in \$immutableSecurityRoots\)') "Permission repair must attest immutable bootstrap/snapshot/broker-state roots before mutation, exclude them from recursive DACL reset, and re-attest them afterward."
    $brokerSecureTempIndex = $snapshotBrokerText.IndexOf('$secureBrokerTemp = New-RevAgentBrokerSecureTemp')
    $brokerSnapshotImportIndex = $snapshotBrokerText.IndexOf('Import-Module $snapshotModulePath -Force')
    $brokerLedgerIndex = $snapshotBrokerText.LastIndexOf('Write-RevAgentBrokerHighWaterLedger')
    $brokerLaunchIndex = $snapshotBrokerText.IndexOf('$process.Start()')
    Assert-True ($snapshotBrokerText -match 'Global\\DPE\.revAgent\.PrivilegedSnapshotBroker' -and $snapshotBrokerText -match 'Invoke-RevAgentBrokerSnapshotRetention' -and $snapshotBrokerText -match '\[IO\.File\]::Replace\(\$tempPath, \$Path, \$backupPath' -and $brokerSecureTempIndex -ge 0 -and $brokerSnapshotImportIndex -gt $brokerSecureTempIndex -and $brokerLedgerIndex -ge 0 -and $brokerLaunchIndex -gt $brokerLedgerIndex) "Privileged broker must serialize executions, compile only in protected Windows TEMP, persist anti-rollback high-water state before launch, and retain snapshots with a bounded policy."
    Assert-True ($permissionsText -notmatch '(?m)^\s*&\s+icacls(?:\.exe)?\b' -and $permissionsText -match 'Join-Path \(\[Environment\]::SystemDirectory\) "icacls\.exe"') "Elevated permission work must invoke only the trusted known-folder System32 icacls path."
    Assert-True ($codexRegistrationText -match 'OpenAI OpCo, LLC' -and $codexRegistrationText -match 'CN=OpenJS Foundation' -and $codexRegistrationText -notmatch 'trustedVendor') "CLI and Node runtime selection must pin exact OpenAI/OpenJS signer subjects."
    Assert-True ($codexRegistrationText -match '\[System\.Security\.Cryptography\.SHA256\]::Create\(\)' -and $codexRegistrationText -match '\[System\.IO\.File\]::Open\(\$Path,\s*\[System\.IO\.FileMode\]::Open' -and $codexRegistrationText -notmatch '(?m)^\s*return\s+\(Get-FileHash') "Codex integration hashing must use a handle-bound .NET SHA-256 stream instead of depending on PowerShell cmdlet autoload."
    Assert-True ($codexRegistrationText -match 'querySucceeded' -and $codexRegistrationText -match 'absenceConfirmed' -and $codexRegistrationText -match 'Store package query failed closed' -and $codexRegistrationText -match 'standalone_disabled_no_authenticated_receipt' -and $codexRegistrationText -match 'no authenticated installed-package receipt/hash chain exists') "Codex discovery must distinguish AppX failure from confirmed absence and keep unauthenticated Windows standalone execution disabled."
    Assert-True ($codexRegistrationText -match 'Test-RevAgentAppxBlockMapFileContent' -and $codexRegistrationText -match 'all_signed_blocks_match' -and $codexRegistrationText -match 'localMirrorDiagnosticOnly' -and $codexRegistrationText -match 'diagnosticOnly = \$true') "Store CLI identity must verify every signed AppxBlockMap block while LocalAppData mirrors remain diagnostics only."
    Assert-True ($codexRegistrationText -match 'function Install-RevAgentProtectedCodexCliFromStore' -and $codexRegistrationText -match 'sourceExecuted = \$false' -and $codexRegistrationText -match "'protected-active-store-copy'" -and $codexRegistrationText -match '-RequireProtectedPath') "Machine phase must materialize, and user phase must execute, only the exact protected ProgramData copy bound to the active Store package."
    $isolatedUltraProbeIndex = $codexRegistrationText.IndexOf('$reasoningEffortCompatibility = Get-RevAgentCodexReasoningEffortCompatibility -Candidate $selectedCandidate -LocalAppData $localRoot')
    $deferredActualProbeIndex = $codexRegistrationText.IndexOf('Resolve-RevAgentCodexCli -ExplicitPath $CodexCliPath -CodexHome $codexHomeInfo.path -InstallRoot $InstallRoot -TargetUserSid $user.sid -DeferActualConfigProbe')
    $preCommitBindingValidatorIndex = $codexRegistrationText.IndexOf('$preCommitCliBindingValidation = {', $deferredActualProbeIndex)
    $postCommitValidatorIndex = $codexRegistrationText.IndexOf('$postCommitActualConfigValidation = {', $preCommitBindingValidatorIndex)
    $atomicConfigIndex = $codexRegistrationText.IndexOf('$config = Set-RevAgentCodexMcpConfigAtomic', $deferredActualProbeIndex)
    $actualCapabilityEvidenceIndex = $codexRegistrationText.IndexOf('$actualCapability = $config.postCommitValidation', $atomicConfigIndex)
    $finalReadbackIndex = $codexRegistrationText.IndexOf('$readback = Test-RevAgentCodexMcpReadback', $actualCapabilityEvidenceIndex)
    $configReplaceIndex = $codexRegistrationText.IndexOf('[IO.File]::Replace($tempPath, $configPath, $backupPath, $true)')
    $insideLockValidationIndex = $codexRegistrationText.IndexOf('$postCommitValidation = & $AfterAtomicCommitValidation', $configReplaceIndex)
    $backupCleanupIndex = $codexRegistrationText.IndexOf('Remove-Item -LiteralPath $backupPath -Force -ErrorAction Stop', $insideLockValidationIndex)
    Assert-True ($codexRegistrationText -match 'function Invoke-RevAgentCodexReasoningEffortCapabilityProbe' -and $codexRegistrationText -match 'Invoke-RevAgentGuardedCodexProcessProbe -Candidate \$Candidate' -and $codexRegistrationText -match 'preserve_supported_ultra' -and $codexRegistrationText -match 'normalize_ultra_to_xhigh' -and $codexRegistrationText -match 'modelReasoningEffortCompatibility' -and $isolatedUltraProbeIndex -ge 0 -and $deferredActualProbeIndex -gt $isolatedUltraProbeIndex -and $preCommitBindingValidatorIndex -gt $deferredActualProbeIndex -and $postCommitValidatorIndex -gt $preCommitBindingValidatorIndex -and $atomicConfigIndex -gt $postCommitValidatorIndex -and $actualCapabilityEvidenceIndex -gt $atomicConfigIndex -and $finalReadbackIndex -gt $actualCapabilityEvidenceIndex) "User integration must probe Ultra with the same protected CLI, preserve it when supported, conditionally migrate only an explicit rejection with accepted xhigh, then consume actual-config evidence from the locked CAS without fallback."
    Assert-True ($codexRegistrationText -match '-BeforeAtomicCommit \$preCommitCliBindingValidation -AfterAtomicCommitValidation \$postCommitActualConfigValidation' -and $configReplaceIndex -ge 0 -and $insideLockValidationIndex -gt $configReplaceIndex -and $backupCleanupIndex -gt $insideLockValidationIndex -and $codexRegistrationText -match 'original config bytes/hash were restored under lock') "Config CAS must rebind the exact active package immediately before mutation and retain the original backup until the guarded post-commit actual-config probe succeeds or rolls back."
    Assert-True ($codexRegistrationText -match 'Assert-RevAgentCodexExecutableUnchanged' -and $codexRegistrationText -match 'Invoke-RevAgentGuardedCodexProcessProbe' -and $codexRegistrationText -match 'Test-RevAgentJsonText' -and $codexRegistrationText -match 'Export-ModuleMember -Function .*Assert-RevAgentCodexExecutableUnchanged.*Invoke-RevAgentGuardedCodexProcessProbe.*Test-RevAgentJsonText') "Config CAS callback dependencies must remain exported for the unelevated user-integration entrypoint."
    Assert-True ($updaterText -match 'function Invoke-InstalledCodexUserIntegration' -and $updaterText -match 'RevAgentCodexUserIntegrationResult' -and $updaterText -notmatch 'Register-CodexMcpServersInConfig' -and $updaterText -notmatch 'Set-CodexMcpServerConfig' -and $updaterText -notmatch 'Set-CodexMemoryConfig') "Updater must not keep a direct config.toml writer; every Codex config mutation must flow through the atomic user-integration contract."
    Assert-True ($codexRegistrationText -match '\[IO\.File\]::Move\(\$configPath, \$missingRollbackDiscard\)' -and $codexRegistrationText -match '\[IO\.File\]::Replace\(\$rollbackDiscard, \$configPath, \$backupPath, \$true\)' -and $codexRegistrationText -match 'competing writer replaced the staged config' -and $codexRegistrationText -match 'concurrent writer was restored exactly') "Both missing/existing config rollback branches must atomically displace and restore concurrent writers instead of deleting or overwriting them after a pathname precheck."
    Assert-True ($codexRegistrationText -match 'function Open-RevAgentSafeUserProbeRootGuard' -and $codexRegistrationText -match 'function Clear-RevAgentSafeUserProbeDirectory' -and $codexRegistrationText -match 'function Close-RevAgentSafeUserProbeRootGuard' -and $codexRegistrationText -match 'Codex probe cleanup failed closed; user config must remain unchanged' -and $codexRegistrationText -notmatch 'Remove-Item\s+-LiteralPath\s+\$probeHome\s+-Recurse') "Disposable Codex probe homes must hold an exact root identity guard and use bounded leaf-first, non-traversing cleanup that fails before config mutation."
    Assert-True ($codexRegistrationText -match 'OpenDirectoryReadLock' -and $codexRegistrationText -match 'function Open-RevAgentExecutableLaunchGuard' -and $codexRegistrationText -match 'function Invoke-RevAgentGuardedCodexProcessProbe' -and $codexRegistrationText -match 'Invoke-RevAgentGuardedCodexProcessProbe -Candidate \$CodexCliCandidate' -and $codexRegistrationText -match '-NodeCandidate \$node\.selected -ServerAttestation \$server\.attestation') "Codex probes/readback and the final Node/server handshake must hold executable and directory-chain launch guards through process creation."
    $nativeCreateIndex = $codexRegistrationText.IndexOf('CreateProcessW(CREATE_SUSPENDED) failed')
    $nativeAssignIndex = $codexRegistrationText.IndexOf('AssignProcessToJobObject before resume failed')
    $nativeResumeIndex = $codexRegistrationText.IndexOf('ResumeThread failed')
    Assert-True ($codexRegistrationText -match 'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE' -and $codexRegistrationText -match 'function Stop-RevAgentGuardedProcessTree' -and $nativeCreateIndex -ge 0 -and $nativeAssignIndex -gt $nativeCreateIndex -and $nativeResumeIndex -gt $nativeAssignIndex -and $codexRegistrationText -match 'process job is confirmed empty') "Codex/Node probes and handshakes must create suspended, assign before resume, then drain their full process job before releasing guards."
    Assert-True ($codexRegistrationText -match '\$workingDirectory = Split-Path -Parent \$fullActualFile' -and $codexRegistrationText -match '\$nodeWorkingDirectory = Split-Path -Parent \$fullNodePath' -and $codexRegistrationText -match 'CreateAssigned\(\$job, \$fullActualFile, \$argumentLine, \$workingDirectory' -and $codexRegistrationText -match 'CreateAssigned\(\$job, \$fullNodePath, \$nodeArgumentLine, \$nodeWorkingDirectory') "Every protected Codex/Node launch must use the exact executable directory instead of inherited user-writable CWD."
    Assert-True ($codexRegistrationText -match "'canonical-program-files-node'" -and $codexRegistrationText -match 'Get-RevAgentProtectedPathChainAttestation' -and $codexRegistrationText -match 'Assert-RevAgentNodeExecutableUnchanged' -and $codexRegistrationText -notmatch 'Get-Command node\.exe,node') "Node execution must use only the exact protected canonical Program Files runtime with repeated identity checks."
    Assert-True ($codexRegistrationText -match 'Get-RevAgentMcpServerEntrypointAttestations' -and $codexRegistrationText -match "'runtimeBundle'" -and $codexRegistrationText -match "'docsServerBundle'" -and $codexRegistrationText -match 'Assert-RevAgentProtectedMachineFileUnchanged') "MCP server execution must bind protected entrypoints to installed release component evidence."
    Assert-True ($codexRegistrationText -match '-CodexCliCandidate \$cli\.selected' -and $codexRegistrationText -match '\$success = \$instructionPolicySatisfied -and \$readback\.success') "Final integration success must re-attest the Codex CLI and require managed instruction attestations."
    $elevatedSurfaceText = @($updaterText, $installTaskText, $selfContainedText, $permissionsText, $codexRegistrationText) -join "`n"
    Assert-True ($elevatedSurfaceText -notmatch '(?m)^\s*&\s+(?:netsh(?:\.exe)?|chcp\.com|icacls(?:\.exe)?)\b') "Elevated-capable surfaces must not resolve system executables through PATH/current-directory search."
    Assert-True ($installTaskText -match 'Join-Path \$script:RevAgentOsSystemDirectory "netsh\.exe"' -and $codexRegistrationText -match 'Join-Path \(\[Environment\]::SystemDirectory\) ''chcp\.com''') "netsh/chcp calls must use exact known-folder Windows System32 paths."
    foreach ($entrypointText in @($guiText, $updaterText, $installTaskText, $selfContainedText, $codexUserIntegrationText)) {
        Assert-True ($entrypointText -match 'PSModulePath' -and $entrypointText -match 'Microsoft\.PowerShell\.Security' -and $entrypointText -match 'Microsoft\.PowerShell\.Archive' -and $entrypointText -match '\$moduleName \+ ''\.psd1''') "Every privileged/user integration entrypoint must sanitize PSModulePath and import exact built-in manifests."
    }
    Assert-True (Test-Path -LiteralPath $workspaceSkillPath -PathType Leaf) "Developer workspace must expose revAgent through the canonical .agents/skills discovery path."
    $workspaceSkillText = Get-Content -Raw -LiteralPath $workspaceSkillPath
    Assert-True ($workspaceSkillText -match '(?m)^name:\s*revAgent\s*$' -and $workspaceSkillText -match '\.\.\/\.\.\/\.\.\/SKILL\.md') "Developer workspace skill must identify revAgent and route to the authoritative root skill."
}
finally {
    $env:PATH = $previousPath
    $env:PSModulePath = $inheritedPsModulePath
    Remove-Item Env:\REVAGENT_POISON_MODULE_MARKER -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $profileListFixtureRoot) { Remove-Item -LiteralPath $profileListFixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if ($null -eq $previousCodexHome) { Remove-Item Env:\CODEX_HOME -ErrorAction SilentlyContinue }
    else { $env:CODEX_HOME = $previousCodexHome }
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host "Codex integration security and compatibility tests passed." -ForegroundColor Green
