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
$previousPsModulePath = $env:PSModulePath
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
    Assert-ThrowsLike -Action {
        Resolve-RevAgentCodexCli -ExplicitPath $unsignedCli -CodexHome $defaultHome.path -LocalAppData $isolatedLocalAppData | Out-Null
    } -Pattern "No Codex CLI candidate passed" -Message "Unsigned Codex CLI must fail closed."
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

    Write-Host "Test active unified Codex bundle attestation rejects a copied signed executable"
    $activeUnified = & $codexRegistrationModule { Get-RevAgentActiveUnifiedCodexCliAttestation }
    if ($activeUnified.success) {
        $copiedSignedCodex = Join-Path $tempRoot 'copied-signed-codex.exe'
        Copy-Item -LiteralPath $activeUnified.userCliPath -Destination $copiedSignedCodex -Force
        $copiedCodexResolution = Resolve-RevAgentCodexCli -ExplicitPath $copiedSignedCodex -CodexHome $defaultHome.path
        $copiedCodexCandidate = @($copiedCodexResolution.candidates | Where-Object { [string]::Equals($_.path, $copiedSignedCodex, [StringComparison]::OrdinalIgnoreCase) }) | Select-Object -First 1
        Assert-True ($null -ne $copiedCodexCandidate) "Copied signed Codex fixture was not audited."
        Assert-True (-not [bool]$copiedCodexCandidate.originAttested -and -not [bool]$copiedCodexCandidate.ready) "A copied signed Codex executable escaped active-package origin attestation."
        Assert-Equal $copiedCodexCandidate.versionProbeExitCode -1 "Copied signed Codex executable must not receive a version probe."
        Assert-Equal $copiedCodexCandidate.capabilityProbeExitCode -1 "Copied signed Codex executable must not receive a capability probe."
        Assert-Equal $copiedCodexResolution.selected.path $activeUnified.userCliPath "Active unified bundle metadata did not bind the selected Codex executable."
        Assert-True ([bool]$copiedCodexResolution.selected.actualConfigCapabilityJsonValid) "Selected newest Codex CLI did not pass the actual-config capability probe."
        $tamperedCliAttestation = $copiedCodexResolution.selected | Select-Object *
        $tamperedCliAttestation.sha256 = ('0' * 64)
        Assert-ThrowsLike -Action {
            Test-RevAgentCodexMcpReadback -CodexCliPath $tamperedCliAttestation.path -CodexHome $defaultHome.path -NodePath $programFilesNode -RuntimeServerPath 'runtime.js' -DocsServerPath 'docs.js' -CodexCliCandidate $tamperedCliAttestation | Out-Null
        } -Pattern "identity changed after attestation" -Message "Final Codex MCP readback must re-attest the selected user-bundle executable before process start."
    }
    else {
        Write-Host ("SKIP copied signed Codex fixture: " + $activeUnified.reason)
    }

    Write-Host "Test config lock, expected hash, atomic replace, hardlink, and junction guards"
    $configHome = Join-Path $profileRoot "config-home"
    New-Item -ItemType Directory -Path $configHome -Force | Out-Null
    $configPath = Join-Path $configHome "config.toml"
    Write-Utf8NoBom -Path $configPath -Content "model = \"gpt-5.5\"`r`n"
    $expectedHash = Get-RevAgentFileSha256 -Path $configPath
    $atomic = Set-RevAgentCodexMcpConfigAtomic -CodexHome $configHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath "C:\Program Files\revAgent\runtime.js" -DocsServerPath "C:\Program Files\revAgent\docs.js" -ExpectedSha256 $expectedHash
    Assert-True ([bool]$atomic.atomicReplace) "Config update did not attest atomic replacement."
    Assert-True ($atomic.afterSha256 -ne $atomic.beforeSha256) "Config hash did not change after registration."
    Assert-True ((Get-Content -Raw -LiteralPath $configPath) -match '\[mcp_servers\.revAgent\]') "Atomic config output is missing revAgent."
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
        Set-RevAgentCodexMcpConfigAtomic -CodexHome $configHome -GuardRoot $profileRoot -NodePath $programFilesNode -RuntimeServerPath "runtime.js" -DocsServerPath "docs.js" -ExpectedSha256 $preCommitHash -BeforeDestinationCommit $chatGptWriterHook | Out-Null
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
    $fakeCli = $programFilesNode
    $runtimePath = Join-Path $tempRoot "runtime-server.js"
    $docsPath = Join-Path $tempRoot "docs-server.js"
    $fakeMcpCommand = Join-Path $tempRoot "mcp"
    $fakeCliSource = @'
const name = process.argv[3];
const entry = name === "revAgent" ? process.env.REVAGENT_FIXTURE_RUNTIME : process.env.REVAGENT_FIXTURE_DOCS;
process.stdout.write(JSON.stringify({enabled:true,transport:{type:"stdio",command:process.env.REVAGENT_FIXTURE_NODE,args:[entry]}}));
'@
    Write-Utf8NoBom -Path $fakeMcpCommand -Content $fakeCliSource
    $env:REVAGENT_FIXTURE_NODE = $programFilesNode
    $env:REVAGENT_FIXTURE_RUNTIME = $runtimePath
    $env:REVAGENT_FIXTURE_DOCS = $docsPath
    $previousCurrentDirectory = [Environment]::CurrentDirectory
    [Environment]::CurrentDirectory = $tempRoot
    try {
        $readback = Test-RevAgentCodexMcpReadback -CodexCliPath $fakeCli -CodexHome $defaultHome.path -NodePath $programFilesNode -RuntimeServerPath $runtimePath -DocsServerPath $docsPath
    }
    finally {
        [Environment]::CurrentDirectory = $previousCurrentDirectory
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
    $expectedArchiveManifest = [IO.Path]::Combine($PSHOME, "Modules", "Microsoft.PowerShell.Archive", "Microsoft.PowerShell.Archive.psd1")
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
        Assert-True ([string]::Equals([IO.Path]::GetFullPath([string]$probe.expandArchiveModulePath), [IO.Path]::GetFullPath($expectedArchiveManifest), [StringComparison]::OrdinalIgnoreCase)) "$($case.Name) did not bind Expand-Archive to the exact PSHOME manifest."
        Assert-True (-not (Test-Path -LiteralPath $poisonMarker)) "$($case.Name) loaded or executed a fake module from poisoned PSModulePath."
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
    $permissionsText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.Permissions.psm1")
    $codexRegistrationText = Get-Content -Raw -LiteralPath $modulePath
    $workspaceSkillPath = Join-Path $RepoRoot ".agents\skills\revAgent\SKILL.md"

    Assert-True ($guiText -match 'function Assert-GuiTrustedMachineScript' -and $guiText -match 'releaseManifest\.components\.\(\$surface\.Key\)' -and $guiText -match 'Pre-import surface hash mismatch' -and $guiText -match 'Pre-UAC signed release verification failed') "GUI must bind elevated execution to hash-verified signed canonical release surfaces."
    Assert-True ($guiText -match '\$psi\.Verb\s*=\s*"runas"' -and $guiText -match '"-MachinePhaseOnly"' -and $guiText -match '"-UserPhaseOnly"') "GUI must elevate only the machine phase and resume a separate user phase."
    Assert-True ($guiText -match 'PendingUserPhaseFilePath' -and $guiText -match 'PendingUserPhaseComponentKey' -and $guiText -match 'Assert-GuiTrustedMachineScript -MachineScriptPath \$script:PendingUserPhaseFilePath' -and $guiText -match 'refreshed unelevated user-phase script') "GUI must re-attest and resume a signed canonical user-phase script from the original unelevated process."
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
    Assert-True ($permissionsText -notmatch '(?m)^\s*&\s+icacls(?:\.exe)?\b' -and $permissionsText -match 'Join-Path \(\[Environment\]::SystemDirectory\) "icacls\.exe"') "Elevated permission work must invoke only the trusted known-folder System32 icacls path."
    Assert-True ($codexRegistrationText -match 'OpenAI OpCo, LLC' -and $codexRegistrationText -match 'CN=OpenJS Foundation' -and $codexRegistrationText -notmatch 'trustedVendor') "CLI and Node runtime selection must pin exact OpenAI/OpenJS signer subjects."
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
    $env:PSModulePath = $previousPsModulePath
    Remove-Item Env:\REVAGENT_POISON_MODULE_MARKER -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $profileListFixtureRoot) { Remove-Item -LiteralPath $profileListFixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if ($null -eq $previousCodexHome) { Remove-Item Env:\CODEX_HOME -ErrorAction SilentlyContinue }
    else { $env:CODEX_HOME = $previousCodexHome }
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host "Codex integration security and compatibility tests passed." -ForegroundColor Green
