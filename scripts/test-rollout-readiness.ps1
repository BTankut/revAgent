<#
.SYNOPSIS
    CI-safe tests for the read-only rollout readiness audit.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

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
        $Actual,
        $Expected,
        [string]$Message
    )

    if ($Actual -ne $Expected) {
        throw ("{0} Expected '{1}', got '{2}'." -f $Message, $Expected, $Actual)
    }
}

function Write-TestJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    $directory = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-TestMachine {
    param(
        [object]$Result,
        [string]$Name
    )

    $machine = @($Result.machines | Where-Object { $_.machine -eq $Name }) | Select-Object -First 1
    if ($null -eq $machine) {
        throw "Machine '$Name' was not found in readiness result."
    }
    return $machine
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-rollout-readiness-test-" + [Guid]::NewGuid().ToString("N"))
$releaseRoot = Join-Path $tempRoot "release"
$legacyReleaseRoot = Join-Path $tempRoot "revit-mcp-deploy"
$reportsRoot = Join-Path $releaseRoot "reports"
$canonicalChannelManifestPath = Join-Path $releaseRoot "channels\stable.json"
$legacyChannelManifestPath = Join-Path $legacyReleaseRoot "channels\stable.json"
$stableVersion = "2026.06.25.404-ef535ad3"
$stableCommit = "ef535ad3eddb682d1da6b42de2aad5bc75ba8187"
$nowUtc = ([datetime]"2026-06-26T13:00:00Z").ToUniversalTime()

try {
    Write-TestJson -Path $canonicalChannelManifestPath -Value ([ordered]@{
            version = $stableVersion
            git = [ordered]@{
                commit = $stableCommit
            }
            sha256 = "ABC123"
            releaseSequence = 20260625193529
        })

    $net01Root = Join-Path $reportsRoot "machines\NET01"
    Write-TestJson -Path (Join-Path $net01Root "latest.json") -Value ([ordered]@{
            computerName = "NET01"
            userName = "Net01"
            status = "completed"
            installedVersion = $stableVersion
            targetVersion = $stableVersion
            publishedAtUtc = $nowUtc.ToString("o")
            diagnostics = [ordered]@{
                sourceFreeMigration = [ordered]@{
                    enabled = $true
                    postCleanupRemainingCount = 0
                    postCleanupFailedCount = 0
                }
            }
            paths = [ordered]@{
                channelManifestPath = $canonicalChannelManifestPath
            }
        })
    Write-TestJson -Path (Join-Path $reportsRoot "live\machines\NET01\status.json") -Value ([ordered]@{
            schemaVersion = "revagent.live.status.v1"
            machineName = "NET01"
            userName = "Net01"
            lastHeartbeatUtc = $nowUtc.ToString("o")
        })

    $eminRoot = Join-Path $reportsRoot "machines\EMIN"
    $eminLog = Join-Path $eminRoot "logs\emin-update.log"
    New-Item -ItemType Directory -Path (Split-Path -Parent $eminLog) -Force | Out-Null
    "Source verify   : remaining managed source/developer artifact item(s): 0; cleanup failures: 0" |
        Set-Content -LiteralPath $eminLog -Encoding UTF8
    Write-TestJson -Path (Join-Path $eminRoot "latest.json") -Value ([ordered]@{
            computerName = "EMIN"
            userName = "User21"
            status = "failed"
            targetVersion = $stableVersion
            publishedAtUtc = $nowUtc.ToString("o")
            machineReport = [ordered]@{
                logPath = $eminLog
            }
            paths = [ordered]@{
                channelManifestPath = $canonicalChannelManifestPath
            }
        })
    Write-TestJson -Path (Join-Path $eminRoot "install-latest.json") -Value ([ordered]@{
            computerName = "EMIN"
            userName = "User21"
            status = "repaired"
            localInstall = [ordered]@{
                version = $stableVersion
            }
            release = [ordered]@{
                version = $stableVersion
            }
            publishedAtUtc = $nowUtc.AddMinutes(-5).ToString("o")
            machineReport = [ordered]@{
                logPath = $eminLog
            }
            paths = [ordered]@{
                channelManifestPath = $canonicalChannelManifestPath
            }
        })

    $yasarRoot = Join-Path $reportsRoot "machines\YASAR"
    Write-TestJson -Path (Join-Path $yasarRoot "latest.json") -Value ([ordered]@{
            computerName = "YASAR"
            userName = "User32"
            status = "completed"
            installedVersion = "2026.06.25.403-old"
            targetVersion = $stableVersion
            publishedAtUtc = $nowUtc.ToString("o")
            paths = [ordered]@{
                channelManifestPath = $canonicalChannelManifestPath
            }
        })

    $legacyRoot = Join-Path $reportsRoot "machines\LEGACY"
    Write-TestJson -Path (Join-Path $legacyRoot "latest.json") -Value ([ordered]@{
            computerName = "LEGACY"
            userName = "User00"
            status = "completed"
            installedVersion = $stableVersion
            targetVersion = $stableVersion
            publishedAtUtc = $nowUtc.ToString("o")
            paths = [ordered]@{
                channelManifestPath = $legacyChannelManifestPath
            }
        })
    Write-TestJson -Path (Join-Path $legacyRoot "source-free-migration-latest.json") -Value ([ordered]@{
            tool = "source-free-migration"
            mode = "dryRun"
            success = $true
            after = [ordered]@{
                artifactCount = 0
            }
        })

    $configPath = Join-Path $tempRoot "rollout-readiness.json"
    Write-TestJson -Path $configPath -Value ([ordered]@{
            releaseRoot = $releaseRoot
            reportsRoot = $reportsRoot
            compatibilityReleaseRoots = @($legacyReleaseRoot)
            expectedMachines = @("NET01", "EMIN", "YASAR", "LEGACY", "WS3", "OLD")
            outOfScopeMachines = @(
                [ordered]@{
                    name = "OLD"
                    reason = "Retired pilot workstation."
                }
            )
            liveSmokeEvidence = @(
                [ordered]@{
                    machine = "NET01"
                    passed = $true
                    stableVersion = $stableVersion
                    stableCommit = $stableCommit
                    revitVersion = "2022"
                    model = "RME_basic_sample_project.rvt"
                    completedAtUtc = $nowUtc.AddMinutes(-2).ToString("o")
                    note = "Fixture live Revit smoke evidence."
                }
            )
            desktopLauncherEvidence = @(
                [ordered]@{
                    passed = $true
                    checkedMachineCount = 5
                    legacyLauncherCount = 0
                    legacyRootReferenceCount = 0
                    completedAtUtc = $nowUtc.AddMinutes(-1).ToString("o")
                    note = "Fixture desktop launcher evidence."
                }
            )
        })

    $result = & (Join-Path $RepoRoot "scripts\check-rollout-readiness.ps1") `
        -ConfigPath $configPath `
        -NowUtc $nowUtc `
        -OutputJson | ConvertFrom-Json

    Assert-Equal $result.summary.configPath $configPath "Config path mismatch."
    Assert-Equal $result.summary.stable.version $stableVersion "Stable version mismatch."
    Assert-Equal $result.summary.stable.commit $stableCommit "Stable commit mismatch."
    Assert-Equal $result.summary.stable.packageSha256 "ABC123" "Stable package hash mismatch."
    Assert-Equal ([int]$result.summary.inScopeMachineCount) 5 "In-scope machine count mismatch."
    Assert-Equal ([int]$result.summary.excludedMachineCount) 1 "Excluded machine count mismatch."
    Assert-Equal ([int]$result.summary.upToDateCount) 3 "Up-to-date count mismatch."
    Assert-Equal ([int]$result.summary.outdatedCount) 1 "Outdated count mismatch."
    Assert-Equal ([int]$result.summary.unknownVersionCount) 1 "Unknown version count mismatch."
    Assert-Equal ([int]$result.summary.sourceFreeVerifiedCount) 3 "Source-free verified count mismatch."
    Assert-Equal ([int]$result.summary.sourceFreeNeedsEvidenceCount) 2 "Source-free evidence count mismatch."
    Assert-Equal ([int]$result.summary.updateFailedCount) 1 "Update failed count mismatch."
    Assert-Equal $result.summary.liveSmoke.state "verified" "Live smoke state mismatch."
    Assert-Equal $result.summary.liveSmoke.latest.machine "NET01" "Live smoke machine mismatch."
    Assert-Equal $result.summary.desktopLauncher.state "verified" "Desktop launcher evidence state mismatch."
    Assert-Equal ([int]$result.summary.desktopLauncher.latest.legacyLauncherCount) 0 "Desktop launcher legacy count mismatch."
    Assert-Equal ([int]$result.summary.canonicalChannelRootCount) 3 "Canonical channel root count mismatch."
    Assert-Equal ([int]$result.summary.legacyChannelRootCount) 1 "Legacy channel root count mismatch."
    Assert-Equal ([int]$result.summary.unknownChannelRootCount) 1 "Unknown channel root count mismatch."
    Assert-True (-not [bool]$result.summary.compatibilityRootRetirementReady) "Compatibility root should not be retirement-ready with legacy or unknown machine evidence."
    Assert-Equal ([int]$result.summary.actionRequiredCount) 4 "Action count mismatch."
    Assert-True (-not [bool]$result.summary.ready) "Fixture should not be fully ready."

    $net01 = Get-TestMachine -Result $result -Name "NET01"
    Assert-Equal $net01.versionState "upToDate" "NET01 version state mismatch."
    Assert-Equal $net01.sourceFreeState "verified" "NET01 source-free state mismatch."
    Assert-Equal $net01.channelRootState "canonical" "NET01 channel root state mismatch."
    Assert-Equal $net01.channelManifestPath $canonicalChannelManifestPath "NET01 channel path mismatch."
    Assert-Equal $net01.connectionState "online" "NET01 live state mismatch."
    Assert-Equal $net01.action "none" "NET01 action mismatch."

    $emin = Get-TestMachine -Result $result -Name "EMIN"
    Assert-Equal $emin.installedVersion $stableVersion "EMIN should use successful install fallback for version."
    Assert-Equal $emin.updateState "failed" "EMIN update state mismatch."
    Assert-Equal $emin.sourceFreeState "verified" "EMIN source-free log evidence mismatch."
    Assert-Equal $emin.channelRootState "canonical" "EMIN channel root state mismatch."
    Assert-Equal $emin.action "inspect_failed_update_log" "EMIN action mismatch."

    $yasar = Get-TestMachine -Result $result -Name "YASAR"
    Assert-Equal $yasar.versionState "outdated" "YASAR version state mismatch."
    Assert-Equal $yasar.channelRootState "canonical" "YASAR channel root state mismatch."
    Assert-Equal $yasar.action "run_stable_update" "YASAR action mismatch."

    $legacy = Get-TestMachine -Result $result -Name "LEGACY"
    Assert-Equal $legacy.versionState "upToDate" "LEGACY version state mismatch."
    Assert-Equal $legacy.sourceFreeState "verified" "LEGACY source-free state mismatch."
    Assert-Equal $legacy.channelRootState "legacy" "LEGACY channel root state mismatch."
    Assert-Equal $legacy.action "rerun_update_from_canonical_release_root" "LEGACY action mismatch."

    $ws3 = Get-TestMachine -Result $result -Name "WS3"
    Assert-Equal $ws3.versionState "unknown" "WS3 version state mismatch."
    Assert-Equal $ws3.channelRootState "unknown" "WS3 channel root state mismatch."
    Assert-Equal $ws3.action "collect_install_report_or_update" "WS3 action mismatch."

    $old = Get-TestMachine -Result $result -Name "OLD"
    Assert-True ([bool]$old.excluded) "OLD should be excluded."
    Assert-Equal $old.exclusionReason "Retired pilot workstation." "OLD exclusion reason mismatch."
    Assert-Equal $old.action "excluded" "OLD action mismatch."

    $missingSmokeConfigPath = Join-Path $tempRoot "rollout-readiness-no-smoke.json"
    Write-TestJson -Path $missingSmokeConfigPath -Value ([ordered]@{
            releaseRoot = $releaseRoot
            reportsRoot = $reportsRoot
            compatibilityReleaseRoots = @($legacyReleaseRoot)
            expectedMachines = @("NET01", "EMIN", "YASAR", "LEGACY", "WS3", "OLD")
            outOfScopeMachines = @(
                [ordered]@{
                    name = "OLD"
                    reason = "Retired pilot workstation."
                }
            )
            desktopLauncherEvidence = @(
                [ordered]@{
                    passed = $true
                    checkedMachineCount = 5
                    legacyLauncherCount = 0
                    legacyRootReferenceCount = 0
                    completedAtUtc = $nowUtc.AddMinutes(-1).ToString("o")
                    note = "Fixture desktop launcher evidence."
                }
            )
        })

    $missingSmokeResult = & (Join-Path $RepoRoot "scripts\check-rollout-readiness.ps1") `
        -ConfigPath $missingSmokeConfigPath `
        -NowUtc $nowUtc `
        -OutputJson | ConvertFrom-Json
    Assert-Equal $missingSmokeResult.summary.liveSmoke.state "missing" "Missing live smoke state mismatch."
    Assert-Equal ([int]$missingSmokeResult.summary.actionRequiredCount) 5 "Missing smoke should add one rollout action."
    $smokeAction = @($missingSmokeResult.actions | Where-Object { $_.scope -eq "rollout" }) | Select-Object -First 1
    Assert-Equal $smokeAction.action "collect_live_revit_smoke" "Missing smoke action mismatch."

    $missingLauncherConfigPath = Join-Path $tempRoot "rollout-readiness-no-launcher-evidence.json"
    Write-TestJson -Path $missingLauncherConfigPath -Value ([ordered]@{
            releaseRoot = $releaseRoot
            reportsRoot = $reportsRoot
            compatibilityReleaseRoots = @($legacyReleaseRoot)
            expectedMachines = @("NET01", "EMIN", "YASAR", "LEGACY", "WS3", "OLD")
            outOfScopeMachines = @(
                [ordered]@{
                    name = "OLD"
                    reason = "Retired pilot workstation."
                }
            )
            liveSmokeEvidence = @(
                [ordered]@{
                    machine = "NET01"
                    passed = $true
                    stableVersion = $stableVersion
                    stableCommit = $stableCommit
                    revitVersion = "2022"
                    model = "RME_basic_sample_project.rvt"
                    completedAtUtc = $nowUtc.AddMinutes(-2).ToString("o")
                    note = "Fixture live Revit smoke evidence."
                }
            )
        })

    $missingLauncherResult = & (Join-Path $RepoRoot "scripts\check-rollout-readiness.ps1") `
        -ConfigPath $missingLauncherConfigPath `
        -NowUtc $nowUtc `
        -OutputJson | ConvertFrom-Json
    Assert-Equal $missingLauncherResult.summary.desktopLauncher.state "missing" "Missing desktop launcher state mismatch."
    Assert-Equal ([int]$missingLauncherResult.summary.actionRequiredCount) 5 "Missing desktop launcher evidence should add one rollout action."
    $launcherAction = @($missingLauncherResult.actions | Where-Object { $_.action -eq "collect_desktop_launcher_evidence" }) | Select-Object -First 1
    Assert-True ($null -ne $launcherAction) "Missing desktop launcher evidence action was not reported."

    $closureOutputPath = Join-Path $tempRoot "closure\rollout-readiness-final.json"
    $closureResult = & (Join-Path $RepoRoot "scripts\invoke-rollout-closure-audit.ps1") `
        -ConfigPath $configPath `
        -OutputPath $closureOutputPath `
        -NowUtc $nowUtc `
        -OutputJson | ConvertFrom-Json
    Assert-True (Test-Path -LiteralPath $closureOutputPath -PathType Leaf) "Closure audit output file was not written."
    Assert-Equal $closureResult.summary.liveSmoke.state "verified" "Closure audit live smoke state mismatch."
    Assert-Equal ([int]$closureResult.summary.actionRequiredCount) 4 "Closure audit action count mismatch."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Rollout readiness audit tests passed." -ForegroundColor Green
