<#
.SYNOPSIS
    Local, non-admin smoke tests for installer/updater helper modules.

.DESCRIPTION
    These tests intentionally avoid Revit, NAS access, admin-only writes, and
    scheduled task registration. They validate the pure helper behavior that
    protects the public installer/updater entrypoints.
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
$libRoot = Join-Path $RepoRoot "installer\lib"

Import-Module (Join-Path $libRoot "RevAgent.HiddenLauncher.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.ScheduledTask.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.Permissions.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.ConfigSync.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.Package.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.RevitVersions.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.UpdatePolicy.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.Proxy.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.LogRetention.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.CodexRegistration.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.Reporting.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.License.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.DesktopLauncherCleanup.psm1") -Force

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

    if ($Actual -ne $Expected) {
        throw "$Message Expected '$Expected', got '$Actual'."
    }
}

function Assert-ThrowsLike {
    param(
        [scriptblock]$Action,
        [string]$Pattern,
        [string]$Message
    )

    $threw = $false
    try { & $Action }
    catch {
        $threw = $true
        if ($_.Exception.Message -notmatch $Pattern) {
            throw "$Message Unexpected error: $($_.Exception.Message)"
        }
    }
    if (-not $threw) { throw "$Message Expected an exception matching '$Pattern'." }
}

function Get-ScriptParamNames {
    param([string]$Path)

    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    Assert-Equal $errors.Count 0 "PowerShell parse errors found in $Path."
    return @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
}

function Assert-NoLocalizedRevitPluginSourceText {
    param([string]$Root)

    $sourceFiles = Get-ChildItem -LiteralPath (Join-Path $Root "src\revit-plugin") -Recurse -File |
        Where-Object { $_.FullName -notmatch '\\(bin|obj)\\' -and @(".cs", ".xaml", ".json") -contains $_.Extension }
    $localizedPattern = '[\u4E00-\u9FFF]|[\u3000-\u303F]|[\uFF00-\uFFEF]|[\u00C0-\u00FF]|\uFFFD'
    $offenders = @()

    foreach ($file in $sourceFiles) {
        $content = Get-Content -Raw -LiteralPath $file.FullName
        if ($content -match $localizedPattern) {
            $offenders += $file.FullName.Substring($Root.Length + 1)
        }
    }

    Assert-Equal $offenders.Count 0 ("Revit plugin source must stay English-only. Offending files: " + ($offenders -join ", "))
}

function Assert-InstallerLibModuleRenameContract {
    param([string]$Root)

    $libRoot = Join-Path $Root "installer\lib"
    $moduleNames = @(
        "CodexRegistration",
        "ConfigSync",
        "DistributionIntegrity",
        "HiddenLauncher",
        "License",
        "LogRetention",
        "Package",
        "Permissions",
        "Proxy",
        "Reporting",
        "RevitVersions",
        "ScheduledTask",
        "SourceFreeMigration",
        "UpdatePolicy"
    )

    foreach ($moduleName in $moduleNames) {
        $canonicalName = "RevAgent.$moduleName.psm1"
        $legacyName = "RevitMcp.$moduleName.psm1"
        $canonicalPath = Join-Path $libRoot $canonicalName
        $legacyPath = Join-Path $libRoot $legacyName
        Assert-True (Test-Path -LiteralPath $canonicalPath -PathType Leaf) "Canonical installer lib module is missing: $canonicalName"
        Assert-True (Test-Path -LiteralPath $legacyPath -PathType Leaf) "Legacy compatibility installer lib wrapper is missing: $legacyName"
        $legacyText = Get-Content -Raw -LiteralPath $legacyPath
        Assert-True ($legacyText -match [regex]::Escape($canonicalName)) "Legacy installer lib wrapper must import $canonicalName."
        Assert-True ($legacyText -match 'Compatibility wrapper') "Legacy installer lib wrapper must declare compatibility intent."
    }
}

function Assert-InstallerLibFunctionAliasContract {
    param([string]$Root)

    $libRoot = Join-Path $Root "installer\lib"
    Get-ChildItem -LiteralPath $libRoot -Filter "RevAgent.*.psm1" |
        Sort-Object Name |
        ForEach-Object {
            $module = Import-Module $_.FullName -Force -PassThru
            $legacyFunctions = @($module.ExportedFunctions.Keys | Where-Object { $_ -match "RevitMcp" } | Sort-Object)
            foreach ($legacyFunction in $legacyFunctions) {
                $aliasName = $legacyFunction -replace "RevitMcp", "RevAgent"
                Assert-True ($module.ExportedAliases.ContainsKey($aliasName)) ("Missing revAgent function alias '$aliasName' for '$legacyFunction' in $($_.Name).")
            }
            if ($_.Name -eq "RevAgent.Proxy.psm1") {
                $canonicalFunctions = @($module.ExportedFunctions.Keys | Where-Object { $_ -match "RevAgent" } | Sort-Object)
                foreach ($canonicalFunction in $canonicalFunctions) {
                    $aliasName = $canonicalFunction -replace "RevAgent", "RevitMcp"
                    Assert-True ($module.ExportedAliases.ContainsKey($aliasName)) ("Missing legacy compatibility alias '$aliasName' for '$canonicalFunction' in $($_.Name).")
                }
            }
        }
}

$tempRoot = Join-Path $env:TEMP ("revit-mcp-smoke-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    Write-Host "Test installer lib module rename contract"
    Assert-InstallerLibModuleRenameContract -Root $RepoRoot

    Write-Host "Test installer lib function alias contract"
    Assert-InstallerLibFunctionAliasContract -Root $RepoRoot

    Write-Host "Test split-phase installer report and GUI handoff contract"
    $installTaskPath = Join-Path $RepoRoot "installer\nas\install-updater-task.ps1"
    $installTaskTokens = $null
    $installTaskParseErrors = $null
    $installTaskAst = [System.Management.Automation.Language.Parser]::ParseFile($installTaskPath, [ref]$installTaskTokens, [ref]$installTaskParseErrors)
    Assert-Equal $installTaskParseErrors.Count 0 "PowerShell parse errors found in split-phase installer."
    $installTaskHarnessFunctions = @(
        "Get-RevAgentInstallObjectPropertyValue",
        "Test-RevAgentInstallObjectProperty",
        "New-RevAgentInstallVersionEvidence",
        "New-RevAgentInstallRunDiagnostics",
        "Resolve-RevAgentNestedMachinePhaseOutcome",
        "Assert-RevAgentInstallMachineReportBinding",
        "Read-RevAgentPendingMachineInstallOutcome",
        "ConvertTo-RevAgentInstallUtcTimestamp",
        "Read-RevAgentRecoveredMachineFailureEvidence",
        "Set-RevAgentInstallRunReport",
        "Test-InstallPhasePathUnderRoot",
        "Assert-InstallPhasePathNoReparse",
        "Write-RevAgentAtomicBytes",
        "Assert-InstallPhaseOutputPaths",
        "Write-RevAgentInstallLocalReport",
        "Write-RevAgentInstallPhaseResult",
        "Write-RevAgentInstallMachinePhaseResult",
        "Write-RevAgentInstallUserPhaseResult"
    )
    $installTaskFunctionNodes = @($installTaskAst.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $installTaskHarnessFunctions -contains $node.Name
            }, $true) | Sort-Object { $_.Extent.StartOffset })
    Assert-Equal $installTaskFunctionNodes.Count $installTaskHarnessFunctions.Count "Split-phase installer test harness could not resolve every production function."
    $installTaskFunctionText = ($installTaskFunctionNodes | ForEach-Object { $_.Extent.Text }) -join "`r`n`r`n"
    & {
        param([string]$FunctionText, [string]$HarnessRoot)
        . ([scriptblock]::Create($FunctionText))

        $atomicRoot = Join-Path $HarnessRoot "atomic-write"
        New-Item -ItemType Directory -Path $atomicRoot -Force | Out-Null
        $atomicPath = Join-Path $atomicRoot "updater-config.json"
        $encoding = New-Object System.Text.UTF8Encoding($false)
        $originalBytes = $encoding.GetBytes('{"state":"original"}')
        $replacementBytes = $encoding.GetBytes('{"state":"replacement"}')

        [System.IO.File]::WriteAllBytes($atomicPath, $originalBytes)
        Write-RevAgentAtomicBytes -Path $atomicPath -Bytes $replacementBytes
        Assert-Equal `
            ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($atomicPath))) `
            ([Convert]::ToBase64String($replacementBytes)) `
            "Atomic overwrite did not persist the replacement bytes."

        Write-RevAgentAtomicBytes -Path $atomicPath -Bytes $originalBytes
        Assert-Equal `
            ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($atomicPath))) `
            ([Convert]::ToBase64String($originalBytes)) `
            "Rollback-like atomic rewrite did not restore the original bytes."
        Assert-Equal ([int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($atomicPath)) 1 "Atomic rewrite destination must remain a single-link ordinary file."
        $atomicArtifacts = @(Get-ChildItem -LiteralPath $atomicRoot -Force -File | Where-Object { $_.Name -like ".updater-config.json.*" })
        Assert-Equal $atomicArtifacts.Count 0 "Atomic overwrite left a temporary or backup artifact."

        function Read-OptionalJsonFile {
            param([string]$Path)
            if ([string]::Equals([IO.Path]::GetFullPath($Path), [IO.Path]::GetFullPath($ChannelManifestPath), [StringComparison]::OrdinalIgnoreCase)) {
                return $script:HarnessChannel
            }
            if ([string]::Equals([IO.Path]::GetFullPath($Path), [IO.Path]::GetFullPath((Join-Path $WorkRoot "installed.json")), [StringComparison]::OrdinalIgnoreCase)) {
                return $script:HarnessInstalledState
            }
            return $null
        }

        $MachinePhaseOnly = $true
        $UserPhaseOnly = $false
        $WorkRoot = Join-Path $HarnessRoot "updater"
        $LogPath = Join-Path $WorkRoot "machine-logs\install-machine.log"
        $PhaseResultPath = Join-Path $WorkRoot "machine-state\machine-result.json"
        $ChannelManifestPath = Join-Path $HarnessRoot "stable.json"
        $InstallRoot = $HarnessRoot
        $PackageTarget = Join-Path $HarnessRoot "package"
        $ServerTarget = Join-Path $HarnessRoot "runtime"
        $RevitInstallRoot = Join-Path $HarnessRoot "Revit"
        $CodexInstructionPolicy = "preserve-local"
        $MachineRole = "developer"
        $script:RevAgentLatestReport = $null
        $script:RevAgentOperation = "install"
        $script:RevAgentOperationMethod = "gui-install"
        $script:RevAgentMachineUpdatePhase = $null
        $script:RevAgentNestedMachineRunReport = $null
        $script:RevAgentMachineEvidenceRecoveryError = ""
        $script:RevAgentPendingMachineReportValidated = $false
        $script:RevAgentCodexUserIntegrationPhase = $null
        $script:RevAgentDesktopLauncherCleanup = $null
        $script:InstallExecutionSnapshotState = $null
        $script:RevAgentLogPath = $LogPath
        $script:HarnessChannel = $null
        $script:HarnessInstalledState = $null

        Assert-InstallPhaseOutputPaths
        $machineReportPath = Join-Path $WorkRoot "machine-state\last-install-report.json"
        Assert-True (-not (Test-Path -LiteralPath $machineReportPath)) "Output-path validation must not write a null install report."

        Set-RevAgentInstallRunReport -Status "completed" -Message "machine complete"
        Assert-True (Test-Path -LiteralPath $machineReportPath -PathType Leaf) "Machine install report was not persisted after report population."
        $machineReport = Read-RevAgentJsonReportFile -Path $machineReportPath -AllowedRoot (Join-Path $WorkRoot "machine-state")
        Assert-Equal ([string]$machineReport.status) "completed" "Persisted machine install report status mismatch."

        $snapshotId = "0123456789abcdef0123456789abcdef"
        $packageSha256 = ("A" * 64)
        $releaseSequence = 20260714000101
        $script:InstallExecutionSnapshotState = [pscustomobject]@{
            snapshotId = $snapshotId
            release = [pscustomobject]@{
                version = "2026.07.14.600-new"
                packageSha256 = $packageSha256
                releaseSequence = $releaseSequence
            }
        }
        $script:HarnessChannel = [pscustomobject]@{ channel = "pilot"; version = "2026.07.14.600-new"; sha256 = $packageSha256 }
        $script:HarnessInstalledState = [pscustomobject]@{ version = "2026.07.14.600-new"; packageSha256 = $packageSha256 }
        $script:RevAgentMachineUpdatePhase = [pscustomobject]@{
            phase = "machine"
            status = "completed"
            success = $true
            continueUserPhase = $true
            message = "updated"
        }
        $script:RevAgentNestedMachineRunReport = [pscustomobject]@{
            status = "updated"
            previousVersion = "2026.07.14.599-old"
            targetVersion = "2026.07.14.600-new"
            installedVersion = "2026.07.14.600-new"
            versionTransition = "2026.07.14.599-old -> 2026.07.14.600-new"
            pendingVersionTransition = $null
            diagnostics = [pscustomobject]@{ isFirstInstall = $false; revitRunning = $false; deferredForRevitClose = $false }
        }
        Set-RevAgentInstallRunReport -Status "completed" -Message "machine update complete"
        $updatedMachineReport = Read-RevAgentJsonReportFile -Path $machineReportPath -AllowedRoot (Join-Path $WorkRoot "machine-state")
        Assert-Equal ([string]$updatedMachineReport.previousVersion) "2026.07.14.599-old" "Outer successful report must preserve the nested pre-update version instead of re-reading the new installed state as previous."
        Assert-Equal ([string]$updatedMachineReport.versionTransition) "2026.07.14.599-old -> 2026.07.14.600-new" "Outer successful report must preserve the nested version transition."
        Assert-True (-not [bool]$updatedMachineReport.diagnostics.isFirstInstall) "Outer successful report must preserve nested isFirstInstall truth."
        Assert-Equal ([string]$updatedMachineReport.diagnostics.executionSnapshotId) $snapshotId "Machine report must bind the cross-process handoff to the authenticated execution snapshot."
        Assert-Equal ([long]$updatedMachineReport.diagnostics.executionSnapshotReleaseSequence) $releaseSequence "Machine report must bind the cross-process handoff to the authenticated release sequence."

        Write-RevAgentJsonFile -Path $ChannelManifestPath -GuardRoot $HarnessRoot -Value $script:HarnessChannel
        Write-RevAgentJsonFile -Path (Join-Path $WorkRoot "installed.json") -GuardRoot $WorkRoot -Value $script:HarnessInstalledState
        Assert-ThrowsLike {
            Read-RevAgentPendingMachineInstallOutcome `
                -WorkRoot $WorkRoot `
                -ExpectedOperationMethod "gui-install" `
                -ExpectedComputerName $env:COMPUTERNAME `
                -ExpectedSnapshotId "ffffffffffffffffffffffffffffffff" `
                -ExpectedVersion "2026.07.14.600-new" `
                -ExpectedPackageSha256 $packageSha256 `
                -ExpectedReleaseSequence $releaseSequence | Out-Null
        } "snapshot id mismatch" "Pending machine handoff must reject a report from a different authenticated execution snapshot."
        $crossProcessHarnessPath = Join-Path $HarnessRoot "user-phase-cross-process.ps1"
        $crossProcessHarnessPreamble = @'
param(
    [Parameter(Mandatory = $true)][string]$ReportingModulePath,
    [Parameter(Mandatory = $true)][string]$WorkRootPath,
    [Parameter(Mandatory = $true)][string]$ChannelPath,
    [Parameter(Mandatory = $true)][string]$SnapshotId,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$PackageSha256,
    [Parameter(Mandatory = $true)][long]$ReleaseSequence,
    [Parameter(Mandatory = $true)][string]$OperationMethod,
    [Parameter(Mandatory = $true)][string]$ComputerName
)
$ErrorActionPreference = "Stop"
Import-Module $ReportingModulePath -Force
'@
        $crossProcessHarnessBody = @'
function Read-OptionalJsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

$MachinePhaseOnly = $false
$UserPhaseOnly = $true
$WorkRoot = $WorkRootPath
$ChannelManifestPath = $ChannelPath
$InstallRoot = Split-Path -Parent $WorkRootPath
$PackageTarget = Join-Path $InstallRoot "package"
$ServerTarget = Join-Path $InstallRoot "runtime"
$RevitInstallRoot = Join-Path $InstallRoot "Revit"
$CodexInstructionPolicy = "preserve-local"
$MachineRole = "developer"
$script:RevAgentLatestReport = $null
$script:RevAgentOperation = "install"
$script:RevAgentOperationMethod = $OperationMethod
$script:RevAgentMachineUpdatePhase = $null
$script:RevAgentNestedMachineRunReport = $null
$script:RevAgentMachineEvidenceRecoveryError = ""
$script:RevAgentPendingMachineReportValidated = $false
$script:RevAgentCodexUserIntegrationPhase = [pscustomobject]@{ phase = "user"; status = "completed"; success = $true; continueUserPhase = $false }
$script:RevAgentDesktopLauncherCleanup = [pscustomobject]@{ mode = "commit"; removedCount = 1; failedCount = 0 }
$script:RevAgentLogPath = Join-Path $WorkRoot "logs\install-user.log"
$script:InstallExecutionSnapshotState = [pscustomobject]@{
    snapshotId = $SnapshotId
    release = [pscustomobject]@{ version = $Version; packageSha256 = $PackageSha256; releaseSequence = $ReleaseSequence }
}
$pending = Read-RevAgentPendingMachineInstallOutcome `
    -WorkRoot $WorkRoot `
    -ExpectedOperationMethod $OperationMethod `
    -ExpectedComputerName $ComputerName `
    -ExpectedSnapshotId $SnapshotId `
    -ExpectedVersion $Version `
    -ExpectedPackageSha256 $PackageSha256 `
    -ExpectedReleaseSequence $ReleaseSequence
$script:RevAgentNestedMachineRunReport = $pending.report
$script:RevAgentMachineUpdatePhase = $pending.phase
$script:RevAgentOperation = [string](Get-RevAgentInstallObjectPropertyValue -Object $pending.report -Name "operation")
$script:RevAgentOperationMethod = [string](Get-RevAgentInstallObjectPropertyValue -Object $pending.report -Name "operationMethod")
$script:RevAgentPendingMachineReportValidated = $true
Set-RevAgentInstallRunReport -Status "completed" -Message "cross-process user phase complete"
'@
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($crossProcessHarnessPath, ($crossProcessHarnessPreamble + "`r`n" + $FunctionText + "`r`n" + $crossProcessHarnessBody), $utf8NoBom)
        $currentPowerShellHost = (Get-Process -Id $PID).Path
        $crossProcessOutput = @(& $currentPowerShellHost `
                -NoLogo `
                -NoProfile `
                -NonInteractive `
                -ExecutionPolicy Bypass `
                -File $crossProcessHarnessPath `
                -ReportingModulePath (Join-Path $libRoot "RevAgent.Reporting.psm1") `
                -WorkRootPath $WorkRoot `
                -ChannelPath $ChannelManifestPath `
                -SnapshotId $snapshotId `
                -Version "2026.07.14.600-new" `
                -PackageSha256 $packageSha256 `
                -ReleaseSequence $releaseSequence `
                -OperationMethod "gui-install" `
                -ComputerName $env:COMPUTERNAME 2>&1)
        $crossProcessExitCode = $LASTEXITCODE
        Assert-Equal $crossProcessExitCode 0 ("Cross-process user-phase harness failed: " + ($crossProcessOutput -join "`n"))
        $crossProcessUserReportPath = Join-Path $WorkRoot "user-state\last-install-report.json"
        $crossProcessUserReport = Read-RevAgentJsonReportFile -Path $crossProcessUserReportPath -AllowedRoot (Join-Path $WorkRoot "user-state")
        Assert-Equal ([string]$crossProcessUserReport.operationMethod) "gui-install" "Cross-process user report must preserve the authenticated machine operation method."
        Assert-Equal ([string]$crossProcessUserReport.previousVersion) "2026.07.14.599-old" "Cross-process user report must preserve the machine phase previous-version truth."
        Assert-Equal ([string]$crossProcessUserReport.versionTransition) "2026.07.14.599-old -> 2026.07.14.600-new" "Cross-process user report must preserve the machine phase version transition."
        Assert-Equal ([string]$crossProcessUserReport.diagnostics.executionSnapshotId) $snapshotId "Cross-process user report must preserve authenticated snapshot binding."
        Assert-True ([bool]$crossProcessUserReport.diagnostics.pendingMachineReportValidated) "Cross-process user report must attest successful pending-machine report validation."

        $canonicalFailureCleanup = [pscustomobject]@{ success = $false; actionRequired = $true; failedCount = 1 }
        $failureAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        $failurePhaseResultPath = Join-Path $WorkRoot "machine-state\nested-failure-result.json"
        $nestedFailureReportPath = Join-Path $WorkRoot "machine-state\last-update-report.json"
        $nestedFailurePhase = [ordered]@{
            schemaVersion = 1
            phase = "machine"
            status = "failed"
            success = $false
            continueUserPhase = $false
            message = "source-free cleanup failed"
            createdAtUtc = $failureAtUtc
            details = [ordered]@{ canonicalLegacySurfaceCleanup = $canonicalFailureCleanup }
        }
        $nestedFailureReport = [ordered]@{
            schemaVersion = 1
            app = "revAgent"
            operation = "source-free-migration"
            operationMethod = "gui-install-machine"
            status = "failed"
            message = "source-free cleanup failed"
            computerName = $env:COMPUTERNAME
            atUtc = $failureAtUtc
            previousVersion = "2026.07.14.599-old"
            targetVersion = "2026.07.14.600-new"
            installedVersion = "2026.07.14.599-old"
            release = [ordered]@{ packageSha256 = $packageSha256 }
            diagnostics = [ordered]@{
                sourceFreeMigrationRequired = $true
                sourceFreeMigration = [ordered]@{ success = $false; failureCount = 1 }
                canonicalLegacySurfaceCleanup = $canonicalFailureCleanup
            }
            paths = [ordered]@{ workRoot = $WorkRoot }
        }
        Write-RevAgentJsonFile -Path $failurePhaseResultPath -GuardRoot (Join-Path $WorkRoot "machine-state") -Value $nestedFailurePhase
        $nestedFailureReport["operationMethod"] = "wrong-machine-method"
        Write-RevAgentJsonFile -Path $nestedFailureReportPath -GuardRoot (Join-Path $WorkRoot "machine-state") -Value $nestedFailureReport
        Assert-ThrowsLike {
            Read-RevAgentRecoveredMachineFailureEvidence `
                -PhaseResultPath $failurePhaseResultPath `
                -WorkRoot $WorkRoot `
                -ExpectedNestedOperationMethod "gui-install-machine" `
                -ExpectedComputerName $env:COMPUTERNAME `
                -ExpectedVersion "2026.07.14.600-new" `
                -ExpectedPackageSha256 $packageSha256 | Out-Null
        } "operation method" "Machine failure recovery must reject a stale or foreign operation report."
        $nestedFailureReport["operationMethod"] = "gui-install-machine"
        Write-RevAgentJsonFile -Path $nestedFailureReportPath -GuardRoot (Join-Path $WorkRoot "machine-state") -Value $nestedFailureReport
        $recoveredFailureEvidence = Read-RevAgentRecoveredMachineFailureEvidence `
            -PhaseResultPath $failurePhaseResultPath `
            -WorkRoot $WorkRoot `
            -ExpectedNestedOperationMethod "gui-install-machine" `
            -ExpectedComputerName $env:COMPUTERNAME `
            -ExpectedVersion "2026.07.14.600-new" `
            -ExpectedPackageSha256 $packageSha256
        $script:RevAgentMachineUpdatePhase = $recoveredFailureEvidence.phase
        $script:RevAgentNestedMachineRunReport = $recoveredFailureEvidence.report
        $script:RevAgentMachineEvidenceRecoveryError = ""
        Set-RevAgentInstallRunReport -Status "failed" -Message "outer wrapper preserved nested failure"
        $outerFailureReport = Read-RevAgentJsonReportFile -Path $machineReportPath -AllowedRoot (Join-Path $WorkRoot "machine-state")
        Assert-True ([bool]$outerFailureReport.diagnostics.sourceFreeMigrationRequired) "Outer failed install report must preserve recovered source-free diagnostics."
        Assert-Equal ([int]$outerFailureReport.diagnostics.sourceFreeMigration.failureCount) 1 "Outer failed install report must preserve recovered source-free failure detail."
        Assert-True ([bool]$outerFailureReport.diagnostics.canonicalLegacySurfaceCleanup.actionRequired) "Outer failed install report must preserve recovered canonical cleanup evidence."
        $originalPhaseResultPath = $PhaseResultPath
        $PhaseResultPath = $failurePhaseResultPath
        Write-RevAgentInstallMachinePhaseResult -Status "failed" -Message "outer wrapper preserved nested failure" -ContinueUserPhase $false -Details ([ordered]@{
                updaterMachinePhase = $script:RevAgentMachineUpdatePhase
                updaterMachineRunReport = $script:RevAgentNestedMachineRunReport
                machineEvidenceRecoveryError = $script:RevAgentMachineEvidenceRecoveryError
            })
        $outerFailurePhase = Read-RevAgentJsonReportFile -Path $failurePhaseResultPath -AllowedRoot (Join-Path $WorkRoot "machine-state")
        Assert-True ([bool]$outerFailurePhase.details.updaterMachineRunReport.diagnostics.sourceFreeMigrationRequired) "Outer failure phase result must preserve recovered source-free diagnostics before replacing the nested phase file."
        Assert-True ([bool]$outerFailurePhase.details.updaterMachinePhase.details.canonicalLegacySurfaceCleanup.actionRequired) "Outer failure phase result must preserve recovered canonical cleanup evidence before replacing the nested phase file."
        $PhaseResultPath = $originalPhaseResultPath

        $canonicalCleanupFixture = [pscustomobject]@{ success = $true; actionRequired = $false; removedCount = 2 }
        $script:RevAgentMachineUpdatePhase = [pscustomobject]@{
            phase = "machine"
            status = "blocked"
            success = $false
            continueUserPhase = $false
            message = "Close Revit and retry."
            details = [pscustomobject]@{ canonicalLegacySurfaceCleanup = $canonicalCleanupFixture }
        }
        $script:RevAgentNestedMachineRunReport = [pscustomobject]@{
            status = "deferred-revit-close-required"
            previousVersion = "2026.07.14.599-old"
            targetVersion = "2026.07.14.600-new"
            installedVersion = "2026.07.14.599-old"
            versionTransition = $null
            pendingVersionTransition = "2026.07.14.599-old -> 2026.07.14.600-new"
            diagnostics = [pscustomobject]@{
                isFirstInstall = $false
                revitRunning = $true
                deferredForRevitClose = $true
                revitPayloadChanged = $true
                canonicalLegacySurfaceCleanup = $canonicalCleanupFixture
            }
        }
        $blockedOutcome = Resolve-RevAgentNestedMachinePhaseOutcome -PhaseResult $script:RevAgentMachineUpdatePhase -NestedMachineRunReport $script:RevAgentNestedMachineRunReport
        Assert-True ([bool]$blockedOutcome.accepted -and [bool]$blockedOutcome.blocked -and -not [bool]$blockedOutcome.continueUserPhase) "Nested Revit-close deferral must be an accepted blocked terminal outcome without user continuation."
        Assert-Equal ([string]$blockedOutcome.reportStatus) "deferred-revit-close-required" "Blocked outcome must preserve the nested updater report status."
        Set-RevAgentInstallRunReport -Status ([string]$blockedOutcome.reportStatus) -Message ([string]$blockedOutcome.message)
        $blockedMachineReport = Read-RevAgentJsonReportFile -Path $machineReportPath -AllowedRoot (Join-Path $WorkRoot "machine-state")
        Assert-Equal ([string]$blockedMachineReport.status) "deferred-revit-close-required" "Outer report must retain the safe Revit-close deferral status."
        Assert-True ([bool]$blockedMachineReport.diagnostics.revitRunning -and [bool]$blockedMachineReport.diagnostics.deferredForRevitClose -and [bool]$blockedMachineReport.diagnostics.revitPayloadChanged) "Outer deferred report must preserve nested Revit diagnostics."
        Assert-Equal ([string]$blockedMachineReport.diagnostics.updaterMachinePhase.status) "blocked" "Outer deferred report must retain the nested blocked phase evidence."
        Assert-Equal ([int]$blockedMachineReport.diagnostics.canonicalLegacySurfaceCleanup.removedCount) 2 "Outer deferred report must retain canonical cleanup evidence."
        Write-RevAgentInstallMachinePhaseResult -Status "blocked" -Message ([string]$blockedOutcome.message) -ContinueUserPhase $false -Details ([ordered]@{ updaterMachinePhase = $script:RevAgentMachineUpdatePhase })
        $blockedMachineResult = Read-RevAgentJsonReportFile -Path $PhaseResultPath -AllowedRoot (Join-Path $WorkRoot "machine-state")
        Assert-Equal ([string]$blockedMachineResult.status) "blocked" "Outer machine handoff must preserve blocked status."
        Assert-True (-not [bool]$blockedMachineResult.success -and -not [bool]$blockedMachineResult.continueUserPhase) "Outer blocked handoff must stop the user phase."

        Write-RevAgentJsonFile -Path $PhaseResultPath -GuardRoot (Join-Path $WorkRoot "machine-state") -Value ([ordered]@{
                phase = "machine"
                status = "completed"
                success = $true
                continueUserPhase = $true
                source = "nested-updater"
            })
        Write-RevAgentInstallMachinePhaseResult -Status "completed" -Message "continue user phase" -ContinueUserPhase $true -Details ([ordered]@{ reportPath = $machineReportPath })
        $machineResult = Read-RevAgentJsonReportFile -Path $PhaseResultPath -AllowedRoot (Join-Path $WorkRoot "machine-state")
        Assert-Equal ([string]$machineResult.phase) "machine" "Machine handoff phase mismatch."
        Assert-True ([bool]$machineResult.success) "Machine handoff must report success."
        Assert-True ([bool]$machineResult.continueUserPhase) "Machine handoff must continue the unelevated user phase."
        Assert-True ($null -eq $machineResult.PSObject.Properties["source"]) "Outer installer handoff must atomically replace the nested updater result."

        Write-RevAgentInstallMachinePhaseResult -Status "failed" -Message "machine failed" -ContinueUserPhase $false
        $failedMachineResult = Read-RevAgentJsonReportFile -Path $PhaseResultPath -AllowedRoot (Join-Path $WorkRoot "machine-state")
        Assert-True (-not [bool]$failedMachineResult.success) "Failed machine handoff must not report success."
        Assert-True (-not [bool]$failedMachineResult.continueUserPhase) "Failed machine handoff must block the user phase."

        $MachinePhaseOnly = $false
        $UserPhaseOnly = $true
        $LogPath = Join-Path $WorkRoot "logs\install-user.log"
        $PhaseResultPath = Join-Path $WorkRoot "user-state\user-result.json"
        Assert-InstallPhaseOutputPaths
        Write-RevAgentInstallUserPhaseResult -Status "completed" -Message "user complete"
        $userResult = Read-RevAgentJsonReportFile -Path $PhaseResultPath -AllowedRoot (Join-Path $WorkRoot "user-state")
        Assert-Equal ([string]$userResult.phase) "user" "User handoff phase mismatch."
        Assert-True ([bool]$userResult.success) "User handoff must report success for the GUI terminal state."
        Assert-True (-not [bool]$userResult.continueUserPhase) "User handoff must be terminal."
    } $installTaskFunctionText (Join-Path $tempRoot "split-phase-installer")

    Write-Host "Test direct updater machine-report run binding and second-GUI race guard"
    $updaterPathForBinding = Join-Path $RepoRoot "installer\nas\update-from-nas.ps1"
    $updaterBindingTokens = $null
    $updaterBindingParseErrors = $null
    $updaterBindingAst = [System.Management.Automation.Language.Parser]::ParseFile($updaterPathForBinding, [ref]$updaterBindingTokens, [ref]$updaterBindingParseErrors)
    Assert-Equal $updaterBindingParseErrors.Count 0 "PowerShell parse errors found in updater pending-report binding source."
    $updaterBindingFunctions = @(
        "Test-RevAgentPathUnderRoot",
        "Get-JsonPropertyValue",
        "Assert-RevAgentPendingMachineUpdateBinding",
        "Read-RevAgentPendingMachineUpdateOutcome",
        "Publish-RevAgentPendingMachineUpdateReport"
    )
    $updaterBindingFunctionNodes = @($updaterBindingAst.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $updaterBindingFunctions -contains $node.Name
            }, $true) | Sort-Object { $_.Extent.StartOffset })
    Assert-Equal $updaterBindingFunctionNodes.Count $updaterBindingFunctions.Count "Direct updater binding harness could not resolve every production function."
    $updaterBindingFunctionText = ($updaterBindingFunctionNodes | ForEach-Object { $_.Extent.Text }) -join "`r`n`r`n"
    & {
        param([string]$FunctionText, [string]$CaseRoot)
        . ([scriptblock]::Create($FunctionText))

        $workRoot = Join-Path $CaseRoot "updater"
        $machineStateRoot = Join-Path $workRoot "machine-state"
        New-Item -ItemType Directory -Path $machineStateRoot -Force | Out-Null
        $reportPath = Join-Path $machineStateRoot "last-update-report.json"
        $phaseAPath = Join-Path $machineStateRoot "gui-machine-phase-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
        $phaseBPath = Join-Path $machineStateRoot "gui-machine-phase-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json"
        $snapshotAStatePath = Join-Path $CaseRoot "snapshot-a-state.json"
        $snapshotBStatePath = Join-Path $CaseRoot "snapshot-b-state.json"
        $version = "2026.07.14.601-race"
        $packageSha256 = ("B" * 64)
        $releaseSequence = 20260714000201
        $snapshotAId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        $snapshotBId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        $operationMethod = "gui-update"

        function New-RaceSnapshotState {
            param([string]$SnapshotId)
            return [pscustomobject]@{
                snapshotId = $SnapshotId
                release = [pscustomobject]@{
                    version = $version
                    packageSha256 = $packageSha256
                    releaseSequence = $releaseSequence
                }
            }
        }
        function New-RaceMachinePhase {
            param([string]$SnapshotId, [string]$StatePath)
            return [ordered]@{
                schemaVersion = 1
                phase = "machine"
                status = "completed"
                success = $true
                continueUserPhase = $true
                message = "updated"
                createdAtUtc = [DateTime]::UtcNow.ToString("o")
                executionSnapshot = [ordered]@{
                    snapshotId = $SnapshotId
                    statePath = $StatePath
                    releaseSequence = $releaseSequence
                    targetComponentKey = "updater"
                }
            }
        }
        function New-RaceMachineReport {
            param([string]$SnapshotId, [string]$MachinePhasePath)
            return [ordered]@{
                schemaVersion = 1
                app = "revAgent"
                operation = "update"
                operationMethod = $operationMethod
                status = "updated"
                computerName = $env:COMPUTERNAME
                targetVersion = $version
                installedVersion = $version
                release = [ordered]@{ version = $version; packageSha256 = $packageSha256 }
                localInstall = [ordered]@{ version = $version; packageSha256 = $packageSha256 }
                diagnostics = [ordered]@{
                    executionSnapshotId = $SnapshotId
                    executionSnapshotVersion = $version
                    executionSnapshotPackageSha256 = $packageSha256
                    executionSnapshotReleaseSequence = $releaseSequence
                    machinePhaseResultPath = $MachinePhasePath
                }
                paths = [ordered]@{ workRoot = $workRoot; logPath = "" }
            }
        }

        $snapshotA = New-RaceSnapshotState -SnapshotId $snapshotAId
        Write-RevAgentJsonFile -Path $phaseAPath -GuardRoot $machineStateRoot -Value (New-RaceMachinePhase -SnapshotId $snapshotAId -StatePath $snapshotAStatePath)
        Write-RevAgentJsonFile -Path $reportPath -GuardRoot $machineStateRoot -Value (New-RaceMachineReport -SnapshotId $snapshotAId -MachinePhasePath $phaseAPath)
        $acceptedA = Read-RevAgentPendingMachineUpdateOutcome `
            -ReportPath $reportPath `
            -ReportAllowedRoot $machineStateRoot `
            -MachinePhaseResultPath $phaseAPath `
            -ExpectedSnapshotState $snapshotA `
            -ExpectedSnapshotStatePath $snapshotAStatePath `
            -ExpectedWorkRoot $workRoot `
            -ExpectedOperationMethod $operationMethod `
            -ExpectedComputerName $env:COMPUTERNAME
        Assert-True ([bool]$acceptedA.binding.success) "Direct updater must accept its own exact machine report/snapshot/phase binding."

        # Simulate a second GUI machine phase completing after run A's initial
        # validation and replacing the shared last-update-report.json.
        Write-RevAgentJsonFile -Path $phaseBPath -GuardRoot $machineStateRoot -Value (New-RaceMachinePhase -SnapshotId $snapshotBId -StatePath $snapshotBStatePath)
        Write-RevAgentJsonFile -Path $reportPath -GuardRoot $machineStateRoot -Value (New-RaceMachineReport -SnapshotId $snapshotBId -MachinePhasePath $phaseBPath)
        $script:RacePublishCount = 0
        function Invoke-RacePublish {
            $script:RacePublishCount++
            return [pscustomobject]@{}
        }
        Set-Alias -Name Publish-RevAgentMachineRunReport -Value Invoke-RacePublish -Scope Local -Force
        Assert-ThrowsLike {
            Publish-RevAgentPendingMachineUpdateReport `
                -ReportPath $reportPath `
                -ReportAllowedRoot $machineStateRoot `
                -LogAllowedRoot (Join-Path $workRoot "machine-logs") `
                -RemoteReportsRoot (Join-Path $CaseRoot "reports") `
                -IntegrationStatus "completed" `
                -IntegrationMessage "run A user integration completed" `
                -RequireExactBinding `
                -MachinePhaseResultPath $phaseAPath `
                -ExpectedSnapshotState $snapshotA `
                -ExpectedSnapshotStatePath $snapshotAStatePath `
                -ExpectedWorkRoot $workRoot `
                -ExpectedOperationMethod $operationMethod `
                -ExpectedComputerName $env:COMPUTERNAME | Out-Null
        } "snapshot id mismatch|phase identity mismatch" "Run A must reject run B's shared machine report before NAS publication."
        Assert-Equal $script:RacePublishCount 0 "A foreign second-GUI machine report must not reach the NAS report publisher."
    } $updaterBindingFunctionText (Join-Path $tempRoot "direct-update-report-race")

    Write-Host "Test managed MCP stop uses CIM method invocation"
    $updaterManagedStopAst = @($updaterBindingAst.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -eq "Stop-RevAgentManagedMcpNodeProcesses"
            }, $true))
    Assert-Equal $updaterManagedStopAst.Count 1 "Updater managed MCP stop harness could not resolve the production function."
    & {
        param([string]$FunctionText, [string]$CaseRoot)
        . ([scriptblock]::Create($FunctionText))

        $entrypointPath = Join-Path $CaseRoot "runtime\build\index.js"
        New-Item -ItemType Directory -Path (Split-Path -Parent $entrypointPath) -Force | Out-Null
        [System.IO.File]::WriteAllText($entrypointPath, "// harness")
        $entrypointFullPath = [System.IO.Path]::GetFullPath($entrypointPath)
        $script:mockTerminated = $false
        $script:mockTerminateCalls = 0

        function Get-CimInstance {
            [CmdletBinding()]
            param(
                [string]$ClassName,
                [string]$Filter
            )

            Assert-Equal $ClassName "Win32_Process" "Managed stop must query Win32_Process."
            if ($Filter -eq "Name = 'node.exe'") {
                return ,([pscustomobject]@{
                        ProcessId = 4242
                        ExecutablePath = "C:\Program Files\nodejs\node.exe"
                        CommandLine = "node `"$entrypointFullPath`""
                    })
            }
            if ($Filter -eq "ProcessId = 4242") {
                return [pscustomobject]@{ ProcessId = 4242 }
            }
            throw "Unexpected CIM filter: $Filter"
        }

        function Invoke-CimMethod {
            [CmdletBinding()]
            param(
                [object]$InputObject,
                [string]$MethodName,
                [hashtable]$Arguments
            )

            Assert-Equal $MethodName "Terminate" "Managed stop must terminate through Invoke-CimMethod."
            Assert-True ($Arguments.ContainsKey("Reason") -and $Arguments["Reason"] -eq [uint32]0) "Managed stop must pass a uint32 zero terminate reason."
            $script:mockTerminateCalls++
            $script:mockTerminated = $true
            return [pscustomobject]@{ ReturnValue = 0 }
        }

        function Get-Process {
            [CmdletBinding()]
            param([int]$Id)

            Assert-Equal $Id 4242 "Managed stop must poll the terminated process id."
            if ($script:mockTerminated) { return $null }
            return [pscustomobject]@{ Id = $Id }
        }

        $matches = @(Stop-RevAgentManagedMcpNodeProcesses -EntrypointPaths @($entrypointFullPath) -Reason "smoke test" -TimeoutSeconds 1)
        Assert-Equal $matches.Count 1 "Managed stop must return the matched managed node process."
        Assert-Equal $script:mockTerminateCalls 1 "Managed stop must invoke exactly one CIM termination."
    } $updaterManagedStopAst[0].Extent.Text (Join-Path $tempRoot "managed-stop")

    $guiUpdaterText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Install-revAgent-Updater-GUI.ps1")
    Assert-True ($guiUpdaterText -match '-MachinePhaseResultPath' -and $guiUpdaterText -match 'PendingUserPhaseComponentKey, "updater"') "Direct GUI user handoff must pass the exact protected machine phase identity to the updater."

    Write-Host "Test managed updater tool fail-closed copy contract"
    foreach ($copyContract in @(
            [pscustomobject]@{ Name = "install-task"; Path = (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1") },
            [pscustomobject]@{ Name = "updater"; Path = (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1") },
            [pscustomobject]@{ Name = "self-contained"; Path = (Join-Path $RepoRoot "installer\install-self-contained.ps1") }
        )) {
        $copyTokens = $null
        $copyParseErrors = $null
        $copyAst = [System.Management.Automation.Language.Parser]::ParseFile([string]$copyContract.Path, [ref]$copyTokens, [ref]$copyParseErrors)
        Assert-Equal $copyParseErrors.Count 0 "PowerShell parse errors found in $($copyContract.Name) copy helper source."
        $copyFunctionNode = @($copyAst.FindAll({
                    param($node)
                    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                    $node.Name -eq "Copy-RevAgentManagedUpdaterToolFile"
                }, $true))[0]
        Assert-True ($null -ne $copyFunctionNode) "Could not find the $($copyContract.Name) managed updater copy helper."
        & {
            param([string]$FunctionText, [string]$CaseRoot, [string]$ContractName)
            . ([scriptblock]::Create($FunctionText))

            New-Item -ItemType Directory -Path $CaseRoot -Force | Out-Null
            $missingSource = Join-Path $CaseRoot "missing-source.ps1"
            $requiredDestination = Join-Path $CaseRoot "required-destination.ps1"
            Assert-ThrowsLike {
                Copy-RevAgentManagedUpdaterToolFile -Source $missingSource -Destination $requiredDestination -Required:$true
            } "source is missing" "$ContractName helper must throw when a required managed tool source is missing."

            $staleOptionalDestination = Join-Path $CaseRoot "stale-optional.ps1"
            [System.IO.File]::WriteAllBytes($staleOptionalDestination, [byte[]](1, 2, 3, 4))
            Assert-ThrowsLike {
                Copy-RevAgentManagedUpdaterToolFile -Source $missingSource -Destination $staleOptionalDestination -Required:$false
            } "stale optional destination" "$ContractName helper must throw when an optional source is missing but a stale destination remains."
            Assert-True (Test-Path -LiteralPath $staleOptionalDestination -PathType Leaf) "$ContractName helper must not silently erase an unverified stale optional destination."

            $validSource = Join-Path $CaseRoot "valid-source.ps1"
            $validDestination = Join-Path $CaseRoot "valid-destination.ps1"
            $sourceBytes = [byte[]](0, 1, 2, 3, 13, 10, 255, 128, 64, 32, 16, 8)
            [System.IO.File]::WriteAllBytes($validSource, $sourceBytes)
            [System.IO.File]::WriteAllBytes($validDestination, [byte[]](9, 9, 9))
            Copy-RevAgentManagedUpdaterToolFile -Source $validSource -Destination $validDestination -Required:$true
            $destinationBytes = [System.IO.File]::ReadAllBytes($validDestination)
            Assert-Equal $destinationBytes.Length $sourceBytes.Length "$ContractName helper copied a different byte length."
            Assert-Equal ((Get-FileHash -Algorithm SHA256 -LiteralPath $validDestination).Hash) ((Get-FileHash -Algorithm SHA256 -LiteralPath $validSource).Hash) "$ContractName helper copied bytes with a different SHA256."
        } $copyFunctionNode.Extent.Text (Join-Path $tempRoot ("copy-contract-" + [string]$copyContract.Name)) ([string]$copyContract.Name)
    }

    Write-Host "Test managed updater link/race and transactional directory guards"
    if (-not ("RevAgentInstallerSmoke.MutationHandle" -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace RevAgentInstallerSmoke {
    public static class MutationHandle {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        public static SafeFileHandle Open(string path) { return OpenWithAccess(path, 0x40000000u); }
        public static SafeFileHandle OpenWithAccess(string path, uint access) {
            SafeFileHandle handle = CreateFileW(path, access, 7u, IntPtr.Zero, 3u, 0x02000000u | 0x00200000u, IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error);
            }
            return handle;
        }
    }
}
'@
    }

    $guardConflictRoot = Join-Path $tempRoot "managed-guard-conflict"
    New-Item -ItemType Directory -Path $guardConflictRoot -Force | Out-Null
    $retainedMutationHandle = [RevAgentInstallerSmoke.MutationHandle]::Open($guardConflictRoot)
    try {
        Assert-ThrowsLike {
            $unexpectedGuard = Open-RevAgentManagedMutationGuard -Path $guardConflictRoot
            $unexpectedGuard.Dispose()
        } "mutation-capable filesystem handle|managed mutation identity set" "Mutation guard must reject a retained pre-UAC write/delete-capable directory handle."
    }
    finally {
        $retainedMutationHandle.Dispose()
    }
    $releasedGuard = Open-RevAgentManagedMutationGuard -Path $guardConflictRoot
    $releasedGuard.Dispose()

    $parentBoundaryRoot = Join-Path $tempRoot "managed-parent-boundary"
    $parentBoundaryUpdater = Join-Path $parentBoundaryRoot "updater"
    New-Item -ItemType Directory -Path $parentBoundaryUpdater -Force | Out-Null
    $retainedParentDeleteChildHandle = [RevAgentInstallerSmoke.MutationHandle]::OpenWithAccess($parentBoundaryRoot, 0x00000040)
    try {
        Assert-ThrowsLike {
            $unexpectedParentGuard = Open-RevAgentManagedMutationGuard -Path $parentBoundaryRoot -ProtectedPaths @($parentBoundaryUpdater) -ExactProtectedPaths
            $unexpectedParentGuard.Dispose()
        } "mutation-capable filesystem handle|managed mutation identity set" "Install-root boundary guard must reject a retained FILE_DELETE_CHILD handle that could replace the updater root."
    }
    finally {
        $retainedParentDeleteChildHandle.Dispose()
    }
    $releasedParentGuard = Open-RevAgentManagedMutationGuard -Path $parentBoundaryRoot -ProtectedPaths @($parentBoundaryUpdater) -ExactProtectedPaths
    $releasedParentGuard.Dispose()

    $childConflictPath = Join-Path $guardConflictRoot "managed-child.txt"
    Set-Content -LiteralPath $childConflictPath -Value "managed-child" -Encoding ASCII
    $retainedChildMutationHandle = [RevAgentInstallerSmoke.MutationHandle]::Open($childConflictPath)
    try {
        Assert-ThrowsLike {
            $unexpectedChildGuard = Open-RevAgentManagedMutationGuard -Path $guardConflictRoot -ProtectedPaths @($childConflictPath)
            $unexpectedChildGuard.Dispose()
        } "mutation-capable filesystem handle|managed mutation identity set" "Mutation guard must reject a retained write-capable handle to a protected child file."
    }
    finally {
        $retainedChildMutationHandle.Dispose()
    }
    $childDirectoryPath = Join-Path $guardConflictRoot "managed-child-directory"
    New-Item -ItemType Directory -Path $childDirectoryPath -Force | Out-Null
    $retainedChildDaclHandle = [RevAgentInstallerSmoke.MutationHandle]::OpenWithAccess($childDirectoryPath, 0x00040000)
    try {
        Assert-ThrowsLike {
            $unexpectedDaclGuard = Open-RevAgentManagedMutationGuard -Path $guardConflictRoot -ProtectedPaths @($childDirectoryPath)
            $unexpectedDaclGuard.Dispose()
        } "mutation-capable filesystem handle|managed mutation identity set" "Mutation guard must reject a retained WRITE_DAC handle to a protected child directory."
    }
    finally {
        $retainedChildDaclHandle.Dispose()
    }

    $foreignConflictPath = Join-Path $guardConflictRoot "foreign-process-child.txt"
    Set-Content -LiteralPath $foreignConflictPath -Value "foreign-process-child" -Encoding ASCII
    $foreignSignalPath = Join-Path $tempRoot ("foreign-handle-ready-" + [guid]::NewGuid().ToString("N"))
    $foreignHandleJob = Start-Job -ArgumentList $foreignConflictPath, $foreignSignalPath -ScriptBlock {
        param([string]$ConflictPath, [string]$SignalPath)
        $foreignStream = [System.IO.FileStream]::new(
            $ConflictPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::ReadWrite,
            ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
        try {
            [System.IO.File]::WriteAllText($SignalPath, "ready")
            Start-Sleep -Seconds 30
        }
        finally {
            $foreignStream.Dispose()
        }
    }
    try {
        for ($waitIndex = 0; $waitIndex -lt 100 -and -not (Test-Path -LiteralPath $foreignSignalPath); $waitIndex++) {
            Start-Sleep -Milliseconds 50
        }
        Assert-True (Test-Path -LiteralPath $foreignSignalPath -PathType Leaf) "Foreign retained-handle test process did not become ready."
        Assert-ThrowsLike {
            $unexpectedForeignGuard = Open-RevAgentManagedMutationGuard -Path $guardConflictRoot -ProtectedPaths @($foreignConflictPath) -ExactProtectedPaths
            $unexpectedForeignGuard.Dispose()
        } "Another process already retains a handle|managed mutation identity set" "Mutation guard must reject a foreign same-user process without relying on PROCESS_DUP_HANDLE access."
    }
    finally {
        Stop-Job -Job $foreignHandleJob -ErrorAction SilentlyContinue
        Remove-Job -Job $foreignHandleJob -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $foreignSignalPath -Force -ErrorAction SilentlyContinue
    }

    $linkFixtureRoot = Join-Path $tempRoot "managed-link-guards"
    $linkSourceRoot = Join-Path $linkFixtureRoot "source"
    $linkDestinationRoot = Join-Path $linkFixtureRoot "destination"
    New-Item -ItemType Directory -Path $linkSourceRoot,$linkDestinationRoot -Force | Out-Null
    $linkSource = Join-Path $linkSourceRoot "update.ps1"
    Set-Content -LiteralPath $linkSource -Value "signed-new" -Encoding ASCII
    $externalFile = Join-Path $linkFixtureRoot "external.txt"
    Set-Content -LiteralPath $externalFile -Value "external-original" -Encoding ASCII
    $externalHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $externalFile).Hash
    $externalAttributesBefore = [System.IO.File]::GetAttributes($externalFile)
    $externalSddlBefore = (Get-Acl -LiteralPath $externalFile).Sddl
    $hardlinkDestination = Join-Path $linkDestinationRoot "update.ps1"
    New-Item -ItemType HardLink -Path $hardlinkDestination -Target $externalFile | Out-Null
    Assert-ThrowsLike {
        Install-RevAgentManagedUpdaterFile -Source $linkSource -Destination $hardlinkDestination | Out-Null
    } "hardlink|hard-linked|reparse point|symbolic link" "Managed updater file refresh must fail closed on a preplanted hardlink."
    Assert-Equal ((Get-FileHash -Algorithm SHA256 -LiteralPath $externalFile).Hash) $externalHashBefore "Rejected hardlink refresh changed external bytes."
    Assert-Equal ([System.IO.File]::GetAttributes($externalFile)) $externalAttributesBefore "Rejected hardlink refresh changed external attributes."
    Assert-Equal ((Get-Acl -LiteralPath $externalFile).Sddl) $externalSddlBefore "Rejected hardlink refresh changed external ACL."

    $configSourceRoot = Join-Path $linkFixtureRoot "config-source"
    $configParent = Join-Path $linkFixtureRoot "config-parent"
    $externalConfigRoot = Join-Path $linkFixtureRoot "external-config"
    New-Item -ItemType Directory -Path $configSourceRoot,$configParent,$externalConfigRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $configSourceRoot "current.json") -Value '{"current":true}' -Encoding ASCII
    $externalConfigFile = Join-Path $externalConfigRoot "outside.json"
    Set-Content -LiteralPath $externalConfigFile -Value '{"outside":true}' -Encoding ASCII
    $externalConfigHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $externalConfigFile).Hash
    $externalConfigAttributesBefore = [System.IO.File]::GetAttributes($externalConfigFile)
    $externalConfigSddlBefore = (Get-Acl -LiteralPath $externalConfigFile).Sddl
    $configJunction = Join-Path $configParent "config"
    New-Item -ItemType Junction -Path $configJunction -Target $externalConfigRoot | Out-Null
    Assert-ThrowsLike {
        Sync-RevAgentUpdaterConfigDirectory -SourceRoot $configSourceRoot -DestinationRoot $configJunction | Out-Null
    } "ordinary directory|reparse point|symbolic link" "Config sync must fail closed before following a destination junction."
    Assert-Equal ((Get-FileHash -Algorithm SHA256 -LiteralPath $externalConfigFile).Hash) $externalConfigHashBefore "Rejected config junction changed external bytes."
    Assert-Equal ([System.IO.File]::GetAttributes($externalConfigFile)) $externalConfigAttributesBefore "Rejected config junction changed external attributes."
    Assert-Equal ((Get-Acl -LiteralPath $externalConfigFile).Sddl) $externalConfigSddlBefore "Rejected config junction changed external ACL."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $externalConfigRoot "current.json"))) "Rejected config junction wrote a shipped file outside the managed tree."
    Assert-ThrowsLike {
        Sync-RevAgentUpdaterConfigDirectory -SourceRoot (Join-Path $linkFixtureRoot "missing-config-source") -DestinationRoot (Join-Path $configParent "missing-config-destination") | Out-Null
    } "source is missing" "Config sync must fail closed when the shipped config source is missing."

    [RevAgent.PermissionNativeFileInfo]::RemoveDirectoryLink($configJunction)
    $validConfigDestination = Join-Path $configParent "valid-config"
    New-Item -ItemType Directory -Path $validConfigDestination -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $validConfigDestination "stale.json") -Value "stale" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $validConfigDestination "revagent-license.json") -Value "local-license" -Encoding ASCII
    [void](Sync-RevAgentUpdaterConfigDirectory -SourceRoot $configSourceRoot -DestinationRoot $validConfigDestination)
    Assert-True (Test-Path -LiteralPath (Join-Path $validConfigDestination "current.json") -PathType Leaf) "Config sync did not install shipped config."
    Assert-True (Test-Path -LiteralPath (Join-Path $validConfigDestination "revagent-license.json") -PathType Leaf) "Config sync did not preserve the allowed local license file."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $validConfigDestination "stale.json"))) "Config sync reported success with a stale unmanaged file."

    $lockedTreeSource = Join-Path $linkFixtureRoot "locked-tree-source"
    $lockedTreeDestination = Join-Path $linkFixtureRoot "locked-tree-destination"
    New-Item -ItemType Directory -Path $lockedTreeSource,$lockedTreeDestination -Force | Out-Null
    $lockedSourceFile = Join-Path $lockedTreeSource "locked.txt"
    Set-Content -LiteralPath $lockedSourceFile -Value "new-tree" -Encoding ASCII
    $oldDestinationFile = Join-Path $lockedTreeDestination "old.txt"
    Set-Content -LiteralPath $oldDestinationFile -Value "old-tree" -Encoding ASCII
    $oldDestinationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $oldDestinationFile).Hash
    $lockedStream = [System.IO.File]::Open($lockedSourceFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    try {
        Assert-ThrowsLike {
            Sync-RevAgentManagedUpdaterDirectory -SourceRoot $lockedTreeSource -DestinationRoot $lockedTreeDestination | Out-Null
        } "used by another process|cannot access|being used|başka bir işlem|erişemiyor|GetLinkCount" "Transactional directory sync must fail when a source file cannot be read."
    }
    finally {
        $lockedStream.Dispose()
    }
    Assert-True (Test-Path -LiteralPath $oldDestinationFile -PathType Leaf) "Failed transactional directory sync removed the old destination."
    Assert-Equal ((Get-FileHash -Algorithm SHA256 -LiteralPath $oldDestinationFile).Hash) $oldDestinationHash "Failed transactional directory sync changed the old destination."

    Write-Host "Test hidden VBS launcher"
    $exitScript = Join-Path $tempRoot "exit-7.ps1"
    Set-Content -LiteralPath $exitScript -Value "exit 7" -Encoding ASCII
    $launcher = Join-Path $tempRoot "hidden-launcher.vbs"
    Write-RevAgentHiddenPowerShellLauncher -LauncherPath $launcher -ScriptPath $exitScript -WaitForExit
    $launcherLines = @(Get-Content -LiteralPath $launcher)
    Assert-Equal $launcherLines.Count 1 "Hidden launcher must be a single VBS line."
    Assert-True ($launcherLines[0] -match '^WScript\.Quit CreateObject\("WScript\.Shell"\)\.Run\(') "Hidden launcher must propagate WScript exit code."
    $cscript = Join-Path $env:WINDIR "System32\cscript.exe"
    & $cscript //B //Nologo $launcher
    Assert-Equal $LASTEXITCODE 7 "Hidden launcher did not propagate child PowerShell exit code."

    Write-Host "Test scheduled task action"
    $action = New-RevAgentHiddenUpdaterScheduledTaskAction -LauncherPath $launcher
    $canonicalWscript = Join-Path ([Environment]::SystemDirectory) "wscript.exe"
    Assert-True ([string]::Equals([string]$action.Execute, $canonicalWscript, [System.StringComparison]::OrdinalIgnoreCase)) "Scheduled task action must use the exact System32 wscript.exe."
    Assert-True ([string]$action.Execute -notmatch 'powershell\.exe$') "Scheduled task action must not execute powershell.exe directly."
    Assert-True ([string]$action.Arguments -match [regex]::Escape($launcher)) "Scheduled task action must point at the hidden VBS launcher."
    Assert-True (Test-RevAgentHiddenScheduledTaskActionMatch -CurrentExecute $canonicalWscript -CurrentArguments ([string]$action.Arguments) -DesiredExecute $canonicalWscript -DesiredArguments ([string]$action.Arguments)) "Canonical scheduled-task action must match exactly."
    Assert-True (-not (Test-RevAgentHiddenScheduledTaskActionMatch -CurrentExecute "wscript.exe" -CurrentArguments ([string]$action.Arguments) -DesiredExecute $canonicalWscript -DesiredArguments ([string]$action.Arguments))) "Bare legacy wscript.exe must require repair."
    $dailyTrigger = New-RevAgentDailyUpdateTrigger -DailyAt "12:00"
    $dailyTriggerLocalTime = ([datetime]::Parse([string]$dailyTrigger.StartBoundary)).ToLocalTime().ToString("HH:mm")
    Assert-Equal $dailyTriggerLocalTime "12:00" "Scheduled task trigger must run at noon local time."
    Assert-Equal ([int]$dailyTrigger.DaysInterval) 1 "Scheduled task trigger must be daily."
    Assert-True (-not $dailyTrigger.Repetition) "Scheduled task trigger must not repeat during the day."

    Write-Host "Test permission repair target plan"
    $permissionsText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.Permissions.psm1")
    Assert-True ($permissionsText -match '\$Recurse -or \$CreateDirectory') "Managed directory permission repair must grant inheritable access for future child files."
    $targets = Get-RevAgentManagedPermissionTargets `
        -InstallRoot "C:\ProgramData\DPE\revAgent" `
        -WorkRoot "C:\ProgramData\DPE\revAgent\updater" `
        -PackageTarget "C:\ProgramData\DPE\revAgent\package" `
        -ServerTarget "C:\ProgramData\DPE\revAgent\runtime" `
        -AllUsersAddinRoot "C:\ProgramData\Autodesk\Revit\Addins\2022" `
        -RevitVersion 2022 `
        -IncludeExistingPayloadTrees
    Assert-True (($targets | Where-Object { $_.Path -match 'node_modules|backups' }).Count -eq 0) "Permission repair plan must not target node_modules or backups."
    $updaterLibPermissionTargets = @($targets | Where-Object {
            $leaf = Split-Path -Leaf $_.Path
            ($leaf -eq "lib") -and ([bool]$_.Recurse)
        })
    Assert-True ($updaterLibPermissionTargets.Count -eq 1) "Permission repair plan must recursively cover the local updater lib root."
    $migrationPermissionTargets = @($targets | Where-Object {
            $leaf = Split-Path -Leaf $_.Path
            ($leaf -eq "migrate-source-free-install.ps1") -and ([string]$_.Kind -eq "File")
        })
    Assert-True ($migrationPermissionTargets.Count -eq 1) "Permission repair plan must cover the local migration tool so non-admin updater repair can overwrite it."
    $recursiveLeaves = @($targets | Where-Object { $_.Recurse } | ForEach-Object { Split-Path -Leaf $_.Path })
    foreach ($leaf in $recursiveLeaves) {
        Assert-True ($leaf -in @("lib", "revAgentPlugin", "revit_mcp_plugin", "CommandSet", "runtime", "revAgent")) "Unexpected recursive permission target: $leaf"
    }

    Write-Host "Test Revit payload update policy"
    $changedRunning = Get-RevAgentUpdateDecision -HasReleaseManifest -HasReleaseComponents -RevitPayloadChangeCount 1 -IsRevitRunning
    Assert-True $changedRunning.RequiresRevitClosed "Changed Revit payload must require Revit closed."
    Assert-True $changedRunning.DeferForRevitClose "Changed Revit payload must defer while Revit is running."
    Assert-True (-not $changedRunning.SkipRevitPayloadInstall) "Changed Revit payload must not skip and continue."
    $unchangedRunning = Get-RevAgentUpdateDecision -HasReleaseManifest -HasReleaseComponents -RevitPayloadChangeCount 0 -IsRevitRunning
    Assert-True (-not $unchangedRunning.RequiresRevitClosed) "Unchanged Revit payload must not require Revit closed."
    Assert-True (-not $unchangedRunning.DeferForRevitClose) "Unchanged Revit payload must not defer while Revit is running."
    Assert-True $unchangedRunning.SkipRevitPayloadInstall "Unchanged Revit payload should skip active Revit files and continue."
    $unchangedClosed = Get-RevAgentUpdateDecision -HasReleaseManifest -HasReleaseComponents -RevitPayloadChangeCount 0
    Assert-True $unchangedClosed.SkipRevitPayloadInstall "Unchanged Revit payload should be skipped even when Revit is closed."

    Write-Host "Test package path and layout resolution"
    $packageRoot = Join-Path $tempRoot "package"
    New-Item -ItemType Directory -Path (Join-Path $packageRoot "installer\revit-api-docs-mcp") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $packageRoot "installer\install-self-contained.ps1") -Value "# test" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $packageRoot "installer\revit-api-docs-mcp\package.json") -Value "{}" -Encoding ASCII
    $layout = Resolve-RevAgentPackageLayout -Root $packageRoot
    Assert-Equal $layout.installerRelativePath "installer\install-self-contained.ps1" "Installer layout resolution failed."
    Assert-Equal $layout.docsServerRelativePath "installer\revit-api-docs-mcp" "Docs server layout resolution failed."
    $releasePath = Resolve-RevAgentReleasePath -Path "releases\pkg.zip" -BaseDirectory "\\nas\share\channels"
    Assert-Equal $releasePath "\\nas\share\channels\releases\pkg.zip" "Relative release path resolution failed."

    Write-Host "Test authenticated release ZIP stays pinned from hash through extraction"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archiveFixtureRoot = Join-Path $tempRoot "authenticated-archive"
    $archiveSourceRoot = Join-Path $archiveFixtureRoot "source"
    $archivePath = Join-Path $archiveFixtureRoot "release.zip"
    $archiveReplacementPath = Join-Path $archiveFixtureRoot "replacement.zip"
    $archiveExtractRoot = Join-Path $archiveFixtureRoot "extract"
    New-Item -ItemType Directory -Path $archiveSourceRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $archiveSourceRoot "payload.txt") -Value "signed-original" -Encoding ASCII
    [System.IO.Compression.ZipFile]::CreateFromDirectory($archiveSourceRoot, $archivePath)
    Set-Content -LiteralPath (Join-Path $archiveSourceRoot "payload.txt") -Value "attacker-replacement" -Encoding ASCII
    [System.IO.Compression.ZipFile]::CreateFromDirectory($archiveSourceRoot, $archiveReplacementPath)

    $updateCacheTokens = $null
    $updateCacheErrors = $null
    $updateCacheAst = [System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1"),
        [ref]$updateCacheTokens,
        [ref]$updateCacheErrors)
    Assert-Equal $updateCacheErrors.Count 0 "Updater authenticated-cache helper has parse errors."
    $updateCacheFunction = @($updateCacheAst.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -eq "New-RevAgentAuthenticatedPackageCacheStream"
            }, $true) | Select-Object -First 1)
    Assert-Equal $updateCacheFunction.Count 1 "Updater authenticated-cache helper was not found exactly once."
    . ([scriptblock]::Create($updateCacheFunction[0].Extent.Text))

    $authenticatedCacheRoot = Join-Path $archiveFixtureRoot "cache"
    New-Item -ItemType Directory -Path $authenticatedCacheRoot -Force | Out-Null
    $archiveExternalHardlink = Join-Path $archiveFixtureRoot "external-hardlink.bin"
    Set-Content -LiteralPath $archiveExternalHardlink -Value "external-hardlink-evidence" -Encoding ASCII
    $archiveExternalHardlinkBytes = [System.IO.File]::ReadAllBytes($archiveExternalHardlink)
    $archiveExternalHardlinkAttributes = [System.IO.File]::GetAttributes($archiveExternalHardlink)
    $archiveExternalHardlinkSddl = (Get-Acl -LiteralPath $archiveExternalHardlink).Sddl
    $preplantedCacheHardlink = Join-Path $authenticatedCacheRoot "revit-mcp-skill-deterministic.zip"
    New-Item -ItemType HardLink -Path $preplantedCacheHardlink -Target $archiveExternalHardlink | Out-Null
    Assert-ThrowsLike {
        $unexpectedHardlinkCache = New-RevAgentAuthenticatedPackageCacheStream -SourcePath $archivePath -CacheRoot $authenticatedCacheRoot
        $unexpectedHardlinkCache.Stream.Dispose()
        $unexpectedHardlinkCache.CacheGuard.Dispose()
    } "hard-linked|hardlink" "Authenticated package cache must reject a preplanted cache hardlink before copying bytes."
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][System.IO.File]::ReadAllBytes($archiveExternalHardlink), [byte[]]$archiveExternalHardlinkBytes)) "Rejected cache hardlink changed outside bytes."
    Assert-Equal ([System.IO.File]::GetAttributes($archiveExternalHardlink)) $archiveExternalHardlinkAttributes "Rejected cache hardlink changed outside attributes."
    Assert-Equal ((Get-Acl -LiteralPath $archiveExternalHardlink).Sddl) $archiveExternalHardlinkSddl "Rejected cache hardlink changed outside ACL."
    [System.IO.File]::Delete($preplantedCacheHardlink)

    $archiveExternalJunctionRoot = Join-Path $archiveFixtureRoot "external-junction-target"
    $archiveExternalJunctionFile = Join-Path $archiveExternalJunctionRoot "must-survive.bin"
    New-Item -ItemType Directory -Path $archiveExternalJunctionRoot -Force | Out-Null
    Set-Content -LiteralPath $archiveExternalJunctionFile -Value "external-junction-evidence" -Encoding ASCII
    $archiveExternalJunctionBytes = [System.IO.File]::ReadAllBytes($archiveExternalJunctionFile)
    $archiveExternalJunctionAttributes = [System.IO.File]::GetAttributes($archiveExternalJunctionFile)
    $archiveExternalJunctionSddl = (Get-Acl -LiteralPath $archiveExternalJunctionFile).Sddl
    $preplantedCacheJunction = Join-Path $authenticatedCacheRoot "poisoned-cache-child"
    New-Item -ItemType Junction -Path $preplantedCacheJunction -Target $archiveExternalJunctionRoot | Out-Null
    Assert-ThrowsLike {
        $unexpectedJunctionCache = New-RevAgentAuthenticatedPackageCacheStream -SourcePath $archivePath -CacheRoot $authenticatedCacheRoot
        $unexpectedJunctionCache.Stream.Dispose()
        $unexpectedJunctionCache.CacheGuard.Dispose()
    } "reparse point|link" "Authenticated package cache must reject a junction child before copying bytes."
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][System.IO.File]::ReadAllBytes($archiveExternalJunctionFile), [byte[]]$archiveExternalJunctionBytes)) "Rejected cache junction changed outside bytes."
    Assert-Equal ([System.IO.File]::GetAttributes($archiveExternalJunctionFile)) $archiveExternalJunctionAttributes "Rejected cache junction changed outside attributes."
    Assert-Equal ((Get-Acl -LiteralPath $archiveExternalJunctionFile).Sddl) $archiveExternalJunctionSddl "Rejected cache junction changed outside ACL."
    [System.IO.Directory]::Delete($preplantedCacheJunction, $false)

    $authenticatedCache = New-RevAgentAuthenticatedPackageCacheStream -SourcePath $archivePath -CacheRoot $authenticatedCacheRoot
    $verifiedArchive = $authenticatedCache.Stream
    try {
        $archiveSha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $verifiedArchiveHash = [System.BitConverter]::ToString($archiveSha.ComputeHash($verifiedArchive)).Replace("-", "")
        }
        finally {
            $archiveSha.Dispose()
        }
        Assert-Equal $verifiedArchiveHash (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash "Pinned archive handle hash differs from its exact source bytes."
        Assert-True (-not [string]::Equals([System.IO.Path]::GetFileName([string]$authenticatedCache.Path), "revit-mcp-skill-deterministic.zip", [System.StringComparison]::OrdinalIgnoreCase)) "Authenticated package cache must use an unpredictable CreateNew leaf."
        Assert-Equal ([int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($verifiedArchive.SafeFileHandle)) 1 "Authenticated package cache destination must remain a single-link ordinary file."

        $archiveOverwriteBlocked = $false
        try { [System.IO.File]::Copy($archiveReplacementPath, [string]$authenticatedCache.Path, $true) }
        catch { $archiveOverwriteBlocked = $true }
        Assert-True $archiveOverwriteBlocked "Pinned authenticated archive must reject write replacement after hash verification."
        $archiveDeleteBlocked = $false
        try { [System.IO.File]::Delete([string]$authenticatedCache.Path) }
        catch { $archiveDeleteBlocked = $true }
        Assert-True $archiveDeleteBlocked "Pinned authenticated archive must reject delete/rename replacement after hash verification."

        [void]$verifiedArchive.Seek(0, [System.IO.SeekOrigin]::Begin)
        Expand-RevAgentReleaseArchiveStream -ArchiveStream $verifiedArchive -DestinationPath $archiveExtractRoot
    }
    finally {
        $verifiedArchive.Dispose()
        $authenticatedCache.CacheGuard.Dispose()
    }
    Assert-Equal (Get-Content -Raw -LiteralPath (Join-Path $archiveExtractRoot "payload.txt")).Trim() "signed-original" "Stream extraction must consume the exact verified archive file object."

    Write-Host "Test Revit version matrix"
    $v2022 = Get-RevAgentVersionConfig -Version 2022 -RepoRoot $RepoRoot
    Assert-Equal $v2022.targetFramework "net48" "Revit 2022 target framework changed."
    Assert-RevAgentInstallerPayloadAvailable -Version 2022 -RepoRoot $RepoRoot
    $matrix = Get-RevAgentVersionMatrix -RepoRoot $RepoRoot
    $configuredVersions = @($matrix.versions.PSObject.Properties.Name | Sort-Object)
    Assert-Equal ($configuredVersions -join ",") "2022,2023,2024,2025" "Only Revit 2022-2025 should be modeled in the branch matrix."
    $blocked = $false
    try {
        Assert-RevAgentInstallerPayloadAvailable -Version 2023 -RepoRoot $RepoRoot
    }
    catch {
        $blocked = $true
    }
    Assert-True $blocked "Revit 2023 must remain blocked until real payload artifacts are bundled."
    $portableRoot = Join-Path $tempRoot "portable-tools"
    New-Item -ItemType Directory -Path (Join-Path $portableRoot "lib") -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $libRoot "RevAgent.RevitVersions.psm1") -Destination (Join-Path $portableRoot "lib\RevAgent.RevitVersions.psm1") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "config") -Destination (Join-Path $portableRoot "config") -Recurse -Force
    Import-Module (Join-Path $portableRoot "lib\RevAgent.RevitVersions.psm1") -Force
    $portable2022 = RevAgent.RevitVersions\Get-RevAgentVersionConfig -Version 2022
    Assert-Equal $portable2022.buildConfiguration "Release R22" "Portable updater lib/config version matrix lookup failed."
    Import-Module (Join-Path $libRoot "RevAgent.RevitVersions.psm1") -Force

    Write-Host "Test C# Revit project configurations"
    $legacyRevitConfigPattern = '(?<!\d)(2020|2021)(?!\d)|\bR20\b|\bR21\b'
    foreach ($relativePath in @(
            "src\revit-plugin\revAgentPlugin.sln",
            "src\revit-plugin\revAgentPlugin\revAgentPlugin.csproj",
            "src\revit-plugin\revAgentCommandSet\revAgentCommandSet.csproj"
        )) {
        $projectText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot $relativePath)
        Assert-True ($projectText -notmatch $legacyRevitConfigPattern) "$relativePath still contains legacy Revit 2020/2021 build configuration."
    }

    Write-Host "Test revAgent environment alias contract"
    $connectionManagerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\ConnectionManager.ts")
    $socketClientText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\SocketClient.ts")
    $runtimePackageText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\package.json")
    $revAgentEnvironmentText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\RevAgentEnvironment.cs")
    $applicationText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\Application.cs")
    $pathManagerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Utils\PathManager.cs")
    $socketServiceText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\SocketService.cs")
    $versionInfoText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\McpVersionInfo.cs")
    Assert-True ($connectionManagerText -match 'REVAGENT_HOST' -and $connectionManagerText -match 'REVIT_MCP_HOST') "Runtime connection manager must keep revAgent env names with legacy fallbacks."
    Assert-True ($connectionManagerText -match 'REVAGENT_TARGET' -and $connectionManagerText -match 'REVIT_MCP_TARGET') "Runtime target resolution must support revAgent and legacy target env names."
    Assert-True ($connectionManagerText -match 'REVAGENT_PORTS' -and $connectionManagerText -match 'REVIT_MCP_PORTS') "Runtime port scanning must support revAgent and legacy port-list env names."
    Assert-True ($socketClientText -match 'REVAGENT_FRAMING' -and $socketClientText -match 'REVIT_MCP_FRAMING') "Socket framing override must support revAgent and legacy env names."
    Assert-True ($runtimePackageText -match '"name"\s*:\s*"revagent-runtime"') "Runtime npm package identity must use the canonical revAgent package name."
    Assert-True ($runtimePackageText -match '"revagent-runtime"\s*:\s*"\./build/index\.js"' -and $runtimePackageText -match '"revit-mcp"\s*:\s*"\./build/index\.js"') "Runtime npm bin map must expose canonical revAgent command while retaining the legacy command alias."
    Assert-True ($runtimePackageText -match 'env-alias-test') "Runtime npm test must include the environment alias contract test."
    Assert-True ($revAgentEnvironmentText -match 'class RevAgentEnvironment' -and $revAgentEnvironmentText -match 'Environment\.GetEnvironmentVariable') "Revit add-in must centralize env alias reads."
    Assert-True ($applicationText -match 'REVAGENT_AUTOSTART' -and $applicationText -match 'REVIT_MCP_AUTOSTART') "Revit add-in autostart must support revAgent and legacy env names."
    Assert-True ($applicationText -match 'WriteStartupDiagnostic') "Revit add-in autostart must write startup diagnostics before the socket logger exists."
    Assert-True ($pathManagerText -match 'SpecialFolder\.LocalApplicationData' -and $pathManagerText -match 'Logs\", \"revit-plugin' -and $pathManagerText -notmatch 'Path\.Combine\(appDataDirectory, \"Logs\"\)') "Revit add-in logs must be written to a user-writable profile path, not the protected installed plugin directory."
    Assert-True ($socketServiceText -match 'REVAGENT_MAX_MESSAGE_BYTES' -and $socketServiceText -match 'REVIT_MCP_MAX_MESSAGE_BYTES') "Revit add-in message size override must support revAgent and legacy env names."
    Assert-True ($socketServiceText -match 'REVAGENT_PLUGIN_PORT' -and $socketServiceText -match 'REVAGENT_PORT' -and $socketServiceText -match 'REVIT_MCP_PLUGIN_PORT' -and $socketServiceText -match 'REVIT_MCP_PORT') "Revit add-in port override must support revAgent and legacy env names."
    Assert-True ($versionInfoText -match 'REVAGENT_INSTALLED_STATE' -and $versionInfoText -match 'REVIT_MCP_INSTALLED_STATE') "Revit add-in installed-state override must support revAgent and legacy env names."

    Write-Host "Test dynamic commandset transaction and reference guards"
    $executeCodeHandler = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\ExecuteDynamicCode\ExecuteCodeEventHandler.cs")
    Assert-True ($executeCodeHandler -match 'ContainsManualTransaction') "Dynamic commandset must detect manual transaction snippets."
    Assert-True ($executeCodeHandler -match 'manual_transaction_requires_transactionMode_none') "Manual transaction snippets in auto mode must be classified as guarded safety blocks."
    Assert-True ($executeCodeHandler -match 'JsonProperty\("guarded"\)') "Dynamic execution results must expose guarded for the status UI."
    Assert-True ($executeCodeHandler -match 'GetMetadataReferences') "Dynamic commandset must centralize metadata reference collection."
    Assert-True ($executeCodeHandler -match 'Dictionary<string, Assembly> chosen') "Dynamic commandset must de-duplicate loaded assemblies by simple name."
    Assert-True ($executeCodeHandler -notmatch 'ResultInfo\.Result\s*=\s*JsonConvert\.SerializeObject\(result\)') "Dynamic execution must not double-encode JSON-looking object results."
    Assert-True ($executeCodeHandler -match 'public JToken Result \{ get; set; \}') "Dynamic execution result payload must carry a JSON token/object."
    Assert-True ($executeCodeHandler -match 'CreateSafeResultToken\(result\)') "Dynamic execution result payload must use the safe null/primitive/fallback token helper."
    $liveCommandsetTest = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\test-commandset-live.ps1")
    Assert-True ($liveCommandsetTest -match 'Assert-RevitMcpReady') "Live commandset integration gate must status-check before non-status commands."
    Assert-True ($liveCommandsetTest -match 'transactionMode auto') "Live commandset integration gate must cover transactionMode auto."
    Assert-True ($liveCommandsetTest -match 'transactionMode none') "Live commandset integration gate must cover transactionMode none."
    Assert-True ($liveCommandsetTest -match 'manual_transaction_requires_transactionMode_none') "Live commandset integration gate must assert the manual transaction guard reason."
    Assert-True ($liveCommandsetTest -match 'Newtonsoft\.Json\.JsonConvert') "Live commandset integration gate must cover Newtonsoft dynamic compilation."
    Assert-True ($liveCommandsetTest -match 'find_elements' -and $liveCommandsetTest -match 'needs_scope') "Live commandset integration gate must cover find_elements guarded needs_scope behavior."
    Assert-True ($liveCommandsetTest -match 'Mechanical Equipment' -and $liveCommandsetTest -match 'scanPolicy\.searchBudget') "Live commandset integration gate must cover category-bounded find_elements search policy metadata."
    Assert-True ($liveCommandsetTest -match 'scanStoppedReason' -and $liveCommandsetTest -match 'max_scanned') "Live commandset integration gate must cover bounded find_elements partial metadata."
    Assert-True ($liveCommandsetTest -match 'inspect_sheet_text' -and $liveCommandsetTest -match 'includeViewportTextNotes' -and $liveCommandsetTest -match 'includeViewportTags' -and $liveCommandsetTest -match 'viewportTag') "Live commandset integration gate must cover native sheet viewport text and tag evidence behavior."
    Assert-True ($liveCommandsetTest -match 'count_annotations' -and $liveCommandsetTest -match 'invalid_count_mode_for_sources' -and $liveCommandsetTest -match 'uniqueTag') "Live commandset integration gate must cover native annotation count inventory and tag count validation behavior."
    Assert-True ($liveCommandsetTest -match 'max_elapsed' -and $liveCommandsetTest -match 'max_bytes' -and $liveCommandsetTest -match 'max_schedule_cells') "Live commandset integration gate must cover native sheet annotation budget stop reasons."
    Assert-True ($liveCommandsetTest -match 'inspect_schedules' -and $liveCommandsetTest -match 'maxCells' -and $liveCommandsetTest -match 'lastReadRow' -and $liveCommandsetTest -match 'max_bytes') "Live commandset integration gate must cover native schedule partial and continuation behavior."
    Assert-True ($liveCommandsetTest -match 'schedule empty footer' -and $liveCommandsetTest -match 'rowCount' -and $liveCommandsetTest -match 'columnCount' -and $liveCommandsetTest -match 'readFailed' -and $liveCommandsetTest -match 'Object reference not set') "Live commandset integration gate must verify that missing schedule footer data is returned as a normal empty section."
    Assert-True ($liveCommandsetTest -match 'MTL fan coil' -and $liveCommandsetTest -match 'live broad MTL guard proof') "Live commandset integration gate must cover runtime MEP inference and broad-query guard behavior."
    Assert-True ($liveCommandsetTest -notmatch 'runtime\\build\\tools\\register\.js' -and $liveCommandsetTest -notmatch 'REVAGENT_LIVE_RUNTIME_REGISTER') "Live commandset integration gate must not depend on dev-only runtime register.js files in source-free installs."
    Assert-True ($liveCommandsetTest -match 'clear_selection' -and $liveCommandsetTest -match 'selectionCountAfter') "Live commandset integration gate must cover clear_selection cleanup behavior."
    Assert-True ($liveCommandsetTest -match 'delete_review_view' -and $liveCommandsetTest -match 'delete_confirmation_required' -and $liveCommandsetTest -match 'deleted') "Live commandset integration gate must cover guarded review-view delete dry-run and commit behavior."
    Assert-True ($liveCommandsetTest -match '\[string\]\$SmokeEvidencePath' -and $liveCommandsetTest -match 'live-smoke-latest\.json') "Live commandset integration gate must support writing rollout live-smoke evidence."
    Assert-True ($liveCommandsetTest -match 'stableVersion = \$StableVersion' -and $liveCommandsetTest -match 'stableCommit = \$StableCommit' -and $liveCommandsetTest -match 'passed = \$true') "Live smoke evidence must identify stable version/commit and a passed result."
    Assert-NoLocalizedRevitPluginSourceText -Root $RepoRoot
    $commandSetSourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet") -Recurse -File -Filter *.cs |
        Where-Object { $_.FullName -notmatch '\\(bin|obj)\\' } |
        ForEach-Object { $_.FullName.Substring($RepoRoot.Length + 1).Replace('/', '\') } |
        Sort-Object)
    $expectedCommandSetSourceFiles = @(
        "src\revit-plugin\revAgentCommandSet\Commands\Access\GetCurrentViewElementsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Access\GetCurrentViewInfoCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Access\GetSelectedElementsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\ExecuteDynamicCode\ExecuteCodeCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\ExecuteDynamicCode\ExecuteCodeEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\ExtractSpatialSnapshotCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\ExtractSpatialSnapshotEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\GetSpatialChangeStateCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\GetSpatialChangeStateEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\InspectLevelsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\InspectLevelsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\SpatialCaptureSessionManager.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\SpatialSnapshotContracts.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\SpatialSnapshotHelpers.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ActivateViewCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ActivateViewEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\AnnotationEvidenceHelpers.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ClearSelectionCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ClearSelectionEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\CloseViewCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\CloseViewEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\CountAnnotationsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\CountAnnotationsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\Create3DViewForElementsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\Create3DViewForElementsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\DeleteReviewViewCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\DeleteReviewViewEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ElementDiscoveryHelpers.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ElementFocusHelpers.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\FindElementsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\FindElementsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\FocusElementsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\FocusElementsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\GetUiStateCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\GetUiStateEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSchedulesCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSchedulesEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSheetTextCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSheetTextEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ListOpenViewsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ListOpenViewsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\OpenExistingPlanForElementLevelCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\OpenExistingPlanForElementLevelEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\SectionBoxElementsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\SectionBoxElementsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ViewCommandHelpers.cs",
        "src\revit-plugin\revAgentCommandSet\Extensions\RevitApiCompatibilityExtensions.cs",
        "src\revit-plugin\revAgentCommandSet\Models\Common\ElementInfo.cs",
        "src\revit-plugin\revAgentCommandSet\Models\Common\ViewElementsResult.cs",
        "src\revit-plugin\revAgentCommandSet\Models\Common\ViewInfo.cs",
        "src\revit-plugin\revAgentCommandSet\Services\GetCurrentViewElementsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Services\GetCurrentViewInfoEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Services\GetSelectedElementsEventHandler.cs"
    )
    Assert-Equal ($commandSetSourceFiles -join "|") ($expectedCommandSetSourceFiles -join "|") "revAgentCommandSet must contain the complete production bridge command source surface."

    Write-Host "Test Revit command registry includes the unified bridge command tools"
    Assert-True (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revAgent.addin") -PathType Leaf) "revAgent add-in manifest must be packaged with the product name."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\mcp-servers-for-revit.addin"))) "Legacy mcp-servers-for-revit add-in manifest must not be packaged."
    Assert-True (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revAgentPlugin\revAgentPlugin.dll") -PathType Leaf) "revAgent plugin DLL must be packaged with the product name."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revit_mcp_plugin"))) "Legacy revit_mcp_plugin payload folder must not be packaged."
    Assert-True (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\command-payload\revAgentCommandSet.dll") -PathType Leaf) "revAgent command payload DLL must be packaged with the product name."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\command-payload\RevitMCPCommandSet.dll"))) "Legacy RevitMCPCommandSet command payload DLL must not be packaged."
    $bridgeCommandJson = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revAgentPlugin\Commands\revAgentCommandSet\command.json") | ConvertFrom-Json
    $commandRegistry = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revAgentPlugin\Commands\commandRegistry.json") | ConvertFrom-Json
    $registeredCommandNames = @($commandRegistry.Commands | ForEach-Object { [string]$_.commandName })
    foreach ($name in @($bridgeCommandJson.commands | ForEach-Object { [string]$_.commandName })) {
        Assert-True ($registeredCommandNames -contains $name) "commandRegistry.json is missing Revit bridge command '$name'."
    }
    Assert-True ($registeredCommandNames -contains "extract_spatial_snapshot") "commandRegistry.json must include the read-only Phase 1a spatial extractor."
    Assert-True ($registeredCommandNames -contains "get_spatial_change_state") "commandRegistry.json must include the read-only Phase 1a spatial liveness command."
    Assert-True ($registeredCommandNames -contains "inspect_levels") "commandRegistry.json must include the read-only host/linked Level inspector."
    foreach ($path in @($commandRegistry.Commands | ForEach-Object { [string]$_.assemblyPath })) {
        Assert-Equal $path "revAgentCommandSet\\2022\\revAgentCommandSet.dll" "Bridge command registry must load every command from the revAgent bridge payload folder."
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revAgentPlugin\Commands\RevitMCPCommandSet"))) "Legacy RevitMCPCommandSet payload folder must not be packaged."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revAgentPlugin\Commands\RevitMCPViewCommandSet"))) "Legacy RevitMCPViewCommandSet payload folder must not be packaged."

    Write-Host "Test installer public parameters"
    $installerParams = Get-ScriptParamNames -Path (Join-Path $RepoRoot "installer\install-self-contained.ps1")
    foreach ($name in @(
            "RevitVersion",
            "InstallRoot",
            "ServerTarget",
            "RevitInstallRoot",
            "AllUsersAddinRoot",
            "LegacyServerTargets",
            "WorkspaceAgentsTarget",
            "CodexInstructionPolicy",
            "SkipCodexSkillInstall",
            "SkipCodexUserIntegration",
            "SkipUserProfileCleanup",
            "SkipLegacyCleanup",
            "SkipRevitPayloadInstall",
            "SkipRuntimePayloadInstall",
            "SuppressNextSteps",
            "Uninstall",
            "RemoveAgents"
        )) {
        Assert-True ($installerParams -contains $name) "install-self-contained.ps1 lost public parameter -$name."
    }
    $updaterTaskParams = Get-ScriptParamNames -Path (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
    foreach ($name in @("ChannelManifestPath", "RunNow", "ForceUpdate", "CodexInstructionPolicy", "RunSourceFreeMigration", "MachinePhaseOnly", "UserPhaseOnly", "PhaseResultPath")) {
        Assert-True ($updaterTaskParams -contains $name) "install-updater-task.ps1 lost public parameter -$name."
    }

    Write-Host "Test GUI updater exposes update and restore actions"
    $guiText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Install-revAgent-Updater-GUI.ps1")
    $localBootstrapText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.ps1")
    $localBootstrapModuleText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.LocalBootstrap.psm1")
    $sourceFreeMigrationText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.SourceFreeMigration.psm1")
    $releaseSnapshotText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.ReleaseSnapshot.psm1")
    $permissionsText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.Permissions.psm1")
    $snapshotBrokerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1")
    $stableLauncherText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\revAgent Updater STABLE.cmd")
    $legacyStableLauncherText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Revit MCP Updater STABLE.cmd")
    $localLauncherText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.cmd")
    $bootstrapRefreshText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Refresh-revAgent-LocalBootstrap-STABLE.ps1")
    Assert-True ($stableLauncherText -match '%ProgramData%\\DPE\\revAgent\\bootstrap\\Start-revAgent-Update\.ps1' -and $stableLauncherText -notmatch 'Install-revAgent-Updater-GUI\.ps1' -and $stableLauncherText -match 'Refresh-revAgent-LocalBootstrap-STABLE\.cmd' -and $stableLauncherText -match 'bootstrap install completed' -and $stableLauncherText -match 'call "%REFRESH%"') "Stable launcher must call only the protected local bootstrap, route clean machines through first-install bootstrap, and route stale-bootstrap failures through the signed stable refresh tool."
    Assert-True ($legacyStableLauncherText -match '%ProgramData%\\DPE\\revAgent\\bootstrap\\Start-revAgent-Update\.ps1' -and $legacyStableLauncherText -notmatch 'Install-revAgent-Updater-GUI\.ps1' -and $legacyStableLauncherText -match 'Refresh-revAgent-LocalBootstrap-STABLE\.cmd' -and $legacyStableLauncherText -match 'bootstrap install completed' -and $legacyStableLauncherText -match 'call "%REFRESH%"') "Legacy stable launcher must keep the same clean-install and stale-bootstrap auto-refresh behavior as the revAgent launcher."
    Assert-True ($localLauncherText -match '-VerificationOnly' -and $localLauncherText -match 'RefreshStableIfBound' -and $localLauncherText -match 'Refresh-revAgent-LocalBootstrap-STABLE\.cmd' -and $localLauncherText -match 'bootstrap must be refreshed') "Desktop local launcher must not fail silently when its protected bootstrap is stale; stable-bound launchers must route through bootstrap refresh."
    Assert-True ($bootstrapRefreshText -match 'Get-ProtectedBootstrapState' -and $bootstrapRefreshText -match 'New-CleanInstallBootstrapInput' -and $bootstrapRefreshText -match 'New-RevAgentAuthenticatedReleaseInbox' -and $bootstrapRefreshText -match 'New-RevAgentBootstrapPrestageEvidence\.ps1' -and $bootstrapRefreshText -match 'install-revagent-local-bootstrap\.ps1' -and $bootstrapRefreshText -match 'ConfirmIndependentlyAuthenticatedSource' -and $bootstrapRefreshText -match 'Start-Process -FilePath \$localLauncher') "Bootstrap refresh tool must support clean first-install evidence, verify existing machines through the protected local bootstrap, stage the signed local-bootstrap installer, and relaunch the local protected updater."
    Assert-True ($bootstrapRefreshText -notmatch '\[string\]::Equals\([^\r\n]*(?:StringComparison|System\.StringComparison)' -and $bootstrapRefreshText -notmatch '\.(?:StartsWith|EndsWith)\([^\r\n]*(?:StringComparison|System\.StringComparison)') "Bootstrap refresh must avoid StringComparison overloads because it runs on arbitrary workstation Windows PowerShell hosts."
    Assert-True ($localBootstrapText -match 'bootstrap-state\.json' -and $localBootstrapText -match 'independentlyAuthenticated' -and $localBootstrapText -match 'FileMode\]::CreateNew' -and $localBootstrapText -match 'PSModulePath' -and $localBootstrapText -match 'installerLibPermissions' -and $localBootstrapText -match 'installerLibReleaseSnapshot' -and $localBootstrapText -match 'privilegedSnapshotUpdate') "Local bootstrap must enforce protected state, effective read-only access, the permissions sibling, trusted modules, and signed snapshot-broker mapping."
    Assert-True ($localBootstrapText -match 'localCurrentReleaseBindings' -and $localBootstrapText -match 'bootstrap_refresh_required' -and $localBootstrapText -match 'FileAccess\]::Write' -and $localBootstrapText -match 'fsutil\.exe' -and $localBootstrapText -match 'hardlink list') "Local bootstrap must reject stale trust-anchor files, effective file writes, and hardlinks."
    Assert-True ($localBootstrapText -match '(?s)\$startInfo\.UseShellExecute\s*=\s*\$false.*\$startInfo\.CreateNoWindow\s*=\s*\$true.*\$startInfo\.WorkingDirectory\s*=\s*Split-Path -Parent \$powershellPath' -and $localBootstrapText -notmatch '\$startInfo\.(?:Verb|WindowStyle)\s*=') "Local bootstrap must launch the unelevated GUI directly from the trusted PowerShell working directory without a shell verb or direct-mode WPF window-style override."
    Assert-True ($localBootstrapModuleText -match 'ExpectedSourceHashes' -and $localBootstrapModuleText -match 'PermissionsModulePath' -and $localBootstrapModuleText -match 'permissions\s*=\s*"lib\\RevAgent\.Permissions\.psm1"' -and $localBootstrapModuleText -match 'SetOwner.*S-1-5-32-544' -and $localBootstrapModuleText -match 'CreateSubdirectory' -and $localBootstrapModuleText -match 'Assert-RevAgentBootstrapLinkSafe' -and $localBootstrapModuleText -match 'sourceAuthentication') "Bootstrap prestage must hash-bind and protect the complete permissions-dependent module closure under restrictive ACLs."
    Assert-True ($guiText -match '"permissions"\s*,\s*"sourceFreeMigration"' -and $guiText.IndexOf('foreach ($role in @("updaterGui"') -lt $guiText.IndexOf('Import-Module $localSourceFreeMigrationModule')) "GUI must verify protected permissions evidence before importing SourceFreeMigration."
    Assert-True ($sourceFreeMigrationText -match '(?s)Test-Path -LiteralPath \$permissionsModulePath.*Import-Module \$permissionsModulePath -ErrorAction Stop -PassThru.*permissionsModule\.Path.*RevAgent\.PermissionNativeFileInfo' -and $sourceFreeMigrationText.IndexOf('Test-Path -LiteralPath $permissionsModulePath') -lt $sourceFreeMigrationText.IndexOf('if (-not ("RevAgent.SourceFreeMigrationNative"')) "SourceFreeMigration must always require and import its exact sibling permissions module, even if a same-named type was preloaded."
    Assert-True ($guiText.IndexOf('bootstrap-state.json') -lt $guiText.IndexOf('Import-Module $localSourceFreeMigrationModule')) "GUI must validate protected local bootstrap state before importing SourceFreeMigration."
    Assert-True ($guiText -match 'Install/Repair') "GUI must expose a separate install/repair button."
    Assert-True ($guiText -match '-ForceUpdate') "GUI restore action must force the channel package install."
    Assert-True ($guiText -match '-OperationMethod", \$operationMethod') "GUI operations must pass the visible install/update method to child logs."
    Assert-True ($guiText -match 'UpdateEnabled') "GUI must gate the update button from channel status."
    Assert-True ($guiText -match 'GuiPrivilegedSnapshotBrokerPath' -and $guiText -match 'Assert-GuiProtectedSnapshotBroker' -and $guiText -match 'New-RevAgentAuthenticatedReleaseInbox') "Protected local GUI machine phase must acquire a verified local inbox and elevate only the protected snapshot broker."
    Assert-True ($guiText -match 'ActiveBrokerLogPath' -and $guiText -match 'New-RunLogPath -Phase "broker"' -and $guiText -match '"-BrokerLogPath", \$script:ActiveBrokerLogPath' -and $guiText -match 'Waiting for administrator approval and protected broker startup') "GUI must surface the UAC/broker stage with a dedicated broker log before the machine target log exists."
    Assert-True ($guiText -match 'Read-GuiLogTail' -and $guiText -match '=== Protected broker ===' -and $guiText -match 'Read-GuiLogTail -Path \$script:ActiveBrokerLogPath') "GUI must display broker diagnostics and use them when no machine phase result is produced."
    Assert-True ($guiText -match 'Open Log' -and $guiText -match 'Open-GuiLogSnapshot' -and $guiText -match 'revAgent-gui-log-snapshots' -and $guiText -match 'notepad\.exe' -and $guiText -notmatch 'Start-Process\s+explorer\.exe') "GUI log action must open a temp log snapshot, not a protected updater folder that can retain Explorer handles."
    Assert-True ($permissionsText -match 'DescribeProcess\(processId\)' -and $permissionsText -match 'Close File Explorer windows or tools viewing revAgent install/updater folders') "Foreign retained-handle errors must include actionable process/remediation diagnostics."
    Assert-True ($snapshotBrokerText -match '\[string\]\$BrokerLogPath' -and $snapshotBrokerText -match 'Initialize-RevAgentBrokerLogPath' -and $snapshotBrokerText -match '\^gui-broker-\\d\{8\}-\\d\{6\}-\[a-f0-9\]\{32\}\\\.log\$' -and $snapshotBrokerText -match 'Assert-RevAgentBrokerProtectedPath -Path \$expectedLogRoot' -and $snapshotBrokerText -match 'Machine target exited with code') "Privileged broker must accept only canonical guarded per-run broker logs and record target launch/exit diagnostics."
    Assert-True ($guiText -match '\$psi\.WorkingDirectory\s*=\s*Split-Path -Parent \$powershellPath' -and $snapshotBrokerText -match '\$psi\.WorkingDirectory\s*=\s*Split-Path -Parent \$powershellPath') "GUI and elevated broker child launches must use the canonical PowerShell directory instead of inheriting a user-writable or NAS current directory."
    Assert-True ($guiText -match 'Resolve-GuiSnapshotUserEntrypoint' -and $guiText -match 'executionSnapshot\.statePath' -and $guiText -match 'snapshotChannelPath' -and $guiText -match 'ExecutionSnapshotStatePath') "User phase must re-attest and execute the exact protected local snapshot entrypoint."
    Assert-True ($guiText -match '\$useDirectUpdate = \(\$Operation -eq "update"' -and $guiText -match '\$runSourceFreeMigration') "GUI must reserve direct updater execution for normal updates and explicit source-free migration."
    Assert-True ($guiText -match '\$machineComponentKey = "updater"' -and $guiText -match '"-Target", \$machineComponentKey') "Normal GUI updates must route the signed updater component through the snapshot broker."
    Assert-True ($guiText -match '\$machineArguments \+= @\("-CodexInstructionPolicy", \$codexInstructionPolicy\)' -and $guiText -match '\$userArguments \+= @\("-CodexInstructionPolicy", \$codexInstructionPolicy\)') "GUI machine and user phases must carry the same Codex instruction policy."
    Assert-True ($guiText -notmatch 'needsSourceFreeMigrationBootstrap|needsPrivilegeSplitBootstrap|releaseUpdaterPath') "GUI must not route current operations through stale installed or loose NAS scripts."
    Assert-True ($guiText -match 'Get-PackageDescriptionForGui' -and $guiText -match 'Standard user package' -and $guiText -match 'Developer machine' -and $guiText -match 'Codex instructions: preserve local') "GUI must label standard user packages and preserve-local developer machines distinctly."
    Assert-True ($guiText -match 'DPE\\revAgent' -and $guiText -match 'legacyConfigPath') "GUI must default to the revAgent install root while preserving legacy updater config policy."
    Assert-True ($guiText -match '\$machineComponentKey = "updaterTaskInstaller"') "First install and repair must target the signed updater-task installer through the snapshot broker."
    Assert-True ($guiText -match 'files\.sourceFreeMigration\.relativePath' -and $guiText -match 'Import-Module \$localSourceFreeMigrationModule' -and $guiText -match 'Get-RevAgentSourceFreeArtifactInventory') "GUI must import the protected local migration module and check inventory before install/update actions."
    Assert-True ($guiText -match 'UpdateButtonText = "Migrate"' -and $guiText -match 'SourceFreeMigrationRequired = \$true') "GUI must expose a migration-required state instead of hiding the update path."
    Assert-True ($guiText -match 'Confirm-SourceFreeMigrationForGui' -and $guiText -match 'Continue with source-free migration and update') "GUI must ask before running source-free migration."
    Assert-True ($guiText -match '\$machineArguments \+= "-SourceFreeMigration"') "GUI migration path must run update-from-nas.ps1 machine phase with -SourceFreeMigration."
    Assert-True ($guiText -match '\$form\.Text = "revAgent"') "GUI title must use the revAgent product name."
    Assert-True ($guiText -match 'Your AI agent inside Revit\.') "GUI must show the revAgent product tagline."
    Assert-True ($guiText -match '2026 Baris Tankut') "GUI must show the revAgent copyright footer."
    Assert-True ($guiText -match '\$form\.ShowInTaskbar = \$true') "GUI must be visible in the taskbar."
    Assert-True ($guiText -match '\$form\.MinimizeBox = \$true') "GUI must be minimizable."
    Assert-True ($guiText -match '\$logBox\.Text = \$text') "GUI must stream the live installer log into the terminal area."
    Assert-True ($guiText -match '\$logBox\.AppendText\("Operation completed') "GUI must append completion status without replacing the streamed log."
    Assert-True ($guiText -notmatch 'Operation is running\.\.\.`r`nThis can take a few minutes') "GUI must not replace live terminal output with a generic running message."
    Assert-True ($releaseSnapshotText -match 'DF8F31B60432CC26FD73345CEE143E90B4235BA2DE08779813DAEDBC8563282E' -and $releaseSnapshotText -match 'Signed release package SHA-256 mismatch') "Protected snapshot acquisition must pin the signature verifier and verify the signed package before UAC."
    Assert-True ($releaseSnapshotText -match 'externalDependencies\.nodeMsi' -and $releaseSnapshotText -match 'external\\\$\(\$script:RevAgentNodeMsiName\)' -and $releaseSnapshotText -match 'signedSetSha256\.nodeMsi') "Protected acquisition must bind the Node MSI to the signed versioned release set."
    Assert-True ($releaseSnapshotText -notmatch 'tools\\dependencies\\\{0\}' -and $releaseSnapshotText -match 'nodeMsi = @\(\$source\.nodeMsiPath') "Authenticated inbox acquisition must not trust an ambient shared-tools dependency path."
    Assert-True ($releaseSnapshotText -match 'FileShare\]::Read' -and $releaseSnapshotText -match 'Signed Node\.js MSI sidecar must have exactly one hardlink reference') "Signed Node MSI verification must deny concurrent writes/deletes and reject hardlinked sources."
    Assert-True ($guiText -notmatch 'Trusted release path has a writable ACL and is not sealed|Assert-GuiDirectoryEffectivelyReadOnly|canonicalToolsRoot') "GUI must treat NAS as signed data transport without a sealed-ACL or loose-tools execution dependency."
    Assert-True ($snapshotBrokerText -match 'TargetArgumentsBase64' -and $snapshotBrokerText -match 'New-RevAgentProtectedReleaseSnapshot' -and $snapshotBrokerText -match 'targetRelativePath' -and $snapshotBrokerText -match '''-ExecutionSnapshotStatePath'', \$snapshot\.statePath' -and $snapshotBrokerText -match 'Assert-RevAgentBrokerTargetArguments' -and $snapshotBrokerText -match 'security-control arguments are forbidden') "Broker must decode exact-allowlisted target arguments, reject caller-owned trust parameters, and bind execution to the protected snapshot component/state."
    $integrityModulePath = Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1"
    $gitAttributesText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot ".gitattributes")
    Assert-True ($gitAttributesText -match '(?m)^installer/lib/RevAgent\.DistributionIntegrity\.psm1\s+text\s+eol=lf\s*$') "The byte-pinned DistributionIntegrity module must have an exact LF checkout policy."
    Assert-True (-not ([IO.File]::ReadAllBytes($integrityModulePath) -contains [byte]13)) "The byte-pinned DistributionIntegrity module checkout must contain LF line endings only."
    $actualBootstrapVerifierHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $integrityModulePath).Hash
    Assert-True ($releaseSnapshotText -match ('\$script:RevAgentIntegrityModuleSha256\s*=\s*''{0}''' -f [regex]::Escape($actualBootstrapVerifierHash))) "ReleaseSnapshot must pin the exact current DistributionIntegrity module SHA-256."
    $bootstrapPinFiles = [ordered]@{
        "installer\nas\update-from-nas.ps1" = 2
        "installer\nas\install-updater-task.ps1" = 2
        "installer\nas\Start-revAgent-Update.ps1" = 1
        "scripts\New-RevAgentBootstrapPrestageEvidence.ps1" = 1
    }
    $bootstrapPinCount = 0
    foreach ($entry in $bootstrapPinFiles.GetEnumerator()) {
        $bootstrapText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot $entry.Key)
        $pinMatches = [regex]::Matches($bootstrapText, '\$pinnedIntegrityModuleHash\s*=\s*"(?<hash>[A-Fa-f0-9]{64})"')
        Assert-Equal $pinMatches.Count $entry.Value "Privilege-boundary bootstrap '$($entry.Key)' must expose the expected number of exact-byte verifier pins."
        foreach ($pinMatch in $pinMatches) {
            Assert-Equal $pinMatch.Groups['hash'].Value $actualBootstrapVerifierHash "Every privilege-boundary bootstrap pin must match the exact current DistributionIntegrity module SHA-256."
            $bootstrapPinCount++
        }
    }
    Assert-Equal $bootstrapPinCount 6 "All six privilege-boundary bootstrap pins must be covered by the exact-byte hash assertion."

    Write-Host "Test updater skips unchanged payload surfaces"
$updateText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
Assert-True ($updateText -match 'Get-RevAgentAuthenticatedSnapshotReportsRoot' -and $updateText -match 'acquisitionChannelManifestPath' -and $updateText -match 'channels\\stable\.json') "User-phase reports must derive from the authenticated snapshot acquisition channel, not its local channel path."
Assert-True ($updateText -match 'User-phase ReportsRoot must match the canonical NAS reports root authenticated by the execution snapshot') "Explicit user-phase ReportsRoot must be checked against the authenticated canonical NAS reports root."
Assert-True ($updateText -notmatch '\$userChannelRoot\s*=\s*Split-Path[\s\S]{0,240}\$ReportsRoot\s*=\s*Join-Path\s+\$userReleaseRoot\s+["'']reports["'']') "User-phase reports must never fall back to the execution snapshot-local ChannelManifestPath."
    Assert-True ($updateText -match 'Resolve-RevAgentCanonicalNasTransitionPath' -and $updateText -match 'revAgent-deploy' -and $updateText -match 'revit-mcp-deploy' -and $updateText -match 'Canonical NAS release root detected') "Updater must migrate legacy NAS channel config to the canonical revAgent deploy root when it is available."
    Assert-True ($updateText -match '\$skipRevitPayloadInstall = \[bool\]\$updateDecision\.SkipRevitPayloadInstall') "Updater must skip unchanged Revit payload even when Revit is closed."
    Assert-True ($updateText -match '\$fastPackageOnlyUpdate = \$skipRevitPayloadInstall -and\s+\$skipRuntimePayloadInstall -and\s+\$skipDocsPayloadWork -and\s+\$skipCodexSkillInstallForThisUpdate -and\s+\$skipCodexMcpRegistrationForThisUpdate') "Fast path must require every payload surface to be unchanged."
    Assert-True ($updateText -match '\$runSelfContainedInstaller = \(-not \$fastPackageOnlyUpdate\)') "Any changed payload surface must route through the self-contained installer."
    Assert-True ($updateText -match 'Test-DirectoryPayloadUnchanged -Manifest \$releaseManifest -ComponentKey "runtimePayload"') "Updater must detect unchanged runtime payloads from the release manifest."
    Assert-True ($updateText -match '\$installArgs\["SkipRuntimePayloadInstall"\] = \$true') "Updater must pass runtime skip to the self-contained installer."
    Assert-True ($updateText -match 'ComponentKey "docsServerPayload"') "Updater must detect unchanged docs payloads from the release manifest."
    Assert-True ($updateText -match '\$installArgs\["SkipCodexSkillInstall"\] = \$true') "Updater must skip unchanged Codex skill integration when the existing install is present."
    Assert-True ($updateText -match '\$CodexInstructionPolicy = Resolve-CodexInstructionPolicy' -and $updateText -match 'CodexInstructionPolicy = \$CodexInstructionPolicy') "Updater must resolve Codex instruction policy and pass it to the self-contained installer."
    Assert-True ($updateText -match 'codexInstructionPolicy = \$CodexInstructionPolicy' -and $updateText -match 'codexInstructionCleanupSkipped') "Updater reports and installed state must expose Codex instruction policy behavior."
    Assert-True ($updateText -match '\$installedStateForUserPhase = Get-InstalledState -Path \$statePath' -and $updateText -notmatch 'Read-InstalledState') "Updater user phase must call the canonical installed-state reader."
    Assert-True ($updateText -match 'Codex MCP registration: skipped; runtime/docs entry points unchanged') "Updater must skip MCP registration when runtime/docs entry points are unchanged."
    Assert-True ($updateText -match 'Revit API index: skipped; docs payload unchanged') "Updater must skip docs index rebuild when docs payload is unchanged and the cache exists."
    Assert-True ($updateText -match 'Fast update path : package/updater metadata only; self-contained installer skipped') "Updater must bypass the self-contained installer when all payload surfaces are unchanged."
    Assert-True ($updateText -match '\$localPackageBackupPolicyState = \[ordered\]@' -and $updateText -match 'policy = "disabled"' -and $updateText -match 'Workstation rollback uses signed NAS release archives') "Updater must expose a disabled local package backup policy."
    Assert-True ($updateText -match 'Invoke-RevAgentBackupRootReset -BackupRoot \$backupRoot -CacheRoot \$cacheRoot') "Updater must clear local package backups and stale cached release ZIPs before normal package replacement."
    Assert-True ($updateText -match 'localPackageBackupPolicy = \$localPackageBackupPolicyState') "Updater reports and installed state must expose local package backup policy diagnostics."
    Assert-True ($updateText -notmatch 'Move-Item -LiteralPath \$PackageTarget -Destination \$backupPath') "Updater must not retain local package backup directories on workstations."
    Assert-True ($updateText -notmatch 'Invoke-RevAgentDirectoryRetention -Root \$backupRoot') "Updater must not keep a rolling set of local package backups."
    Assert-True ($updateText -match 'Install-UpdaterToolsFromPackage -SourceRoot \$nasToolsSource -DestinationRoot \$WorkRoot') "Fast update path must still refresh local updater tools."
    Assert-True ($updateText -match 'Invoke-NpmInstallIfNeeded -NodePath \$nodePath -NpmCliPath \$npmCliPath -WorkingDirectory \$docsServerPath -Label "Documentation server" -CacheRoot \$npmDependencyCacheRoot') "Fast and normal updates must restore ABI-compatible docs server node_modules with the validated Node/npm CLI pair."
    Assert-True ($updateText -match 'Documentation server dependencies: skipped by -SkipNpmInstall') "Updater must only skip docs server dependencies when explicitly requested."
    Assert-True ($updateText -notmatch 'Documentation server dependencies: skipped; docs payload unchanged') "Updater must not skip docs server dependencies just because the docs payload is unchanged."
    Assert-True ($updateText -match 'Fast update path failed; falling back to the full repair/install path') "Fast update failures must warn and fall back to the full repair/install path."
    Assert-True ($updateText -match '\$runSelfContainedInstaller = \$true') "Fast update failure must enable the self-contained installer fallback."
    Assert-True ($updateText -match 'fastUpdateFallbackUsed') "Updater reports must record whether the fast path fell back."
    Assert-True ($updateText -match 'function Stop-RevAgentManagedMcpNodeProcesses' -and $updateText -match 'Name = ''node\.exe''' -and $updateText -match 'revit-api-docs-mcp\\build\\index\.js' -and $updateText -match '\$ServerTarget "build\\index\.js"') "Updater must stop only exact managed revAgent MCP node entrypoints before replacing package/runtime payloads."
    Assert-True ($updateText -match 'Invoke-CimMethod -InputObject \$process -MethodName Terminate -Arguments @\{ Reason = \[uint32\]0 \}' -and $updateText -notmatch '\$process\.Terminate\(') "Updater managed MCP stop must invoke the Win32_Process Terminate method through CIM, not through inert CimInstance methods."
    $updateManagedStopIndex = $updateText.IndexOf('Stop-RevAgentManagedMcpNodeProcesses -EntrypointPaths $managedMcpEntrypointsToStop.ToArray()')
    $updatePackageRemoveIndex = $updateText.IndexOf('Remove-Item -LiteralPath $PackageTarget')
    Assert-True ($updateManagedStopIndex -ge 0 -and $updatePackageRemoveIndex -gt $updateManagedStopIndex) "Updater must stop managed MCP node processes before deleting the package target."
    Assert-True ($updateText -match 'Assert-RevAgentPathHasNoReparseComponents -Path \$codexHomeFull' -and $updateText -match 'Assert-RevAgentPathHasNoReparseComponents -Path \$targetPath') "Updater machine-phase Codex AGENTS cleanup must reject reparse Codex home and target paths before elevated hashing or deletion."
    Assert-True ($updateText -match 'operationMethod = \$script:RevAgentOperationMethod') "Updater reports must record the install/update method used."
    Assert-True ($updateText -match 'release = \[ordered\]@') "Updater reports must include release version, commit, and package SHA metadata."
    Assert-True ($updateText -match 'localInstall = if \(\$InstalledState\)') "Updater reports must include a local install state summary."
    Assert-True ($updateText -match 'System\.Collections\.IDictionary' -and $updateText -match '\$Object\.Contains\(\$Name\)') "Updater report JSON helper must read ordered dictionary installed state after successful updates."
    Assert-True ($updateText -match 'diagnostics = \$Diagnostics') "Updater reports must include dashboard-ready update diagnostics."
    Assert-True ($updateText -match 'RevAgent\.DistributionIntegrity\.psm1') "Updater must import the distribution-integrity verifier."
    Assert-True ($updateText -match 'release-trusted-keys\.json') "Updater must look for packaged public release-key config."
    Assert-True ($updateText -match 'RevAgent\.ConfigSync\.psm1' -and $updateText -match 'Sync-RevAgentUpdaterConfigDirectory -SourceRoot \$configSource -DestinationRoot \(Join-Path \$DestinationRoot "config"\) -MutationGuard \$mutationGuard') "Fast updater tool refresh must use the shared guarded config sync helper."
    Assert-True ($updateText -notmatch 'Remove-Item -LiteralPath \$configDestination -Recurse -Force') "Fast updater tool refresh must not delete local config because that removes pinned release keys."
    $configSyncText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.ConfigSync.psm1")
    Assert-True ($configSyncText -match 'Install-RevitMcpManagedUpdaterFile' -and $configSyncText -match 'FileMode\]::CreateNew' -and $configSyncText -match 'File\]::Replace') "Config sync helper must stage ordinary files and replace destinations atomically."
    Assert-True ($configSyncText -match 'PreserveTopLevelNames' -and $configSyncText -match 'release-trusted-keys\.json' -and $configSyncText -match 'license-trusted-keys\.json') "Config sync helper must explicitly preserve known local trust/license config files."
    Assert-True ($configSyncText -match 'Sync-RevitMcpManagedDirectory' -and $configSyncText -match 'Managed directory installation' -and $configSyncText -match 'Assert-RevitMcpManagedTreeManifestEqual') "Config sync helper must use staged directory replacement with exact post-install manifest verification."
    Assert-True ($configSyncText -match 'Managed directory source is missing') "Config sync helper must throw when the shipped config source is missing."
    Assert-True ($updateText -match 'distributionIntegrity = \$script:RevAgentDistributionIntegrity') "Updater reports must include distribution integrity status."
    Assert-True ($updateText -match 'Test-RevAgentReleaseDistributionIntegrity') "Updater must evaluate release signatures through the shared integrity helper."
    Assert-True ($updateText -match 'Test-RevAgentReleaseAppIdentity' -and $updateText -match 'Channel manifest app is not revAgent or revit-mcp-skill') "Updater must accept revAgent and legacy release app identities during rolling app-id migration."
    Assert-True ($updateText -match '\[string\]\$DistributionIntegrityPolicy = ""') "Updater must expose an explicit distribution integrity policy override."
    Assert-True ($updateText -match '\[switch\]\$AllowSignedReleaseRollback') "Updater must require an explicit operator flag for signed rollback bypass."
    Assert-True ($updateText -match 'Get-InstalledHighestAcceptedReleaseSequence') "Updater must persist and reuse the highest accepted signed release sequence."
    Assert-True ($updateText -match '\$policy = if \(\$trustedKeys\.Count -gt 0\) \{ "enforce" \} else \{ "compatibility" \}') "Updater must default to enforce mode when trusted release keys are configured."
    Assert-True ($updateText -match 'Set-DistributionIntegrityBlockedReport' -and $updateText -match 'trusted_keys_missing' -and $updateText -match 'trustedKeysPath = \$TrustedKeysPath') "Updater must report missing pinned release keys as a structured fail-closed distribution-integrity state."
    Assert-True ($updateText -match '\$trustedKeys\.Count -gt 0 -and \[string\]::Equals\(\$policy, "compatibility"') "Updater must report enforce policy whenever trusted release keys make unsigned compatibility impossible."
    Assert-True ($updateText -notmatch '\$trustedKeys\.Count -le \$beforeCount') "Updater must not judge auto-discovered key files empty by cumulative count (C1 regression: collides with configured trustedKeysPath)."
    Assert-True ($updateText -match '\$consumedKeyPaths') "Updater must track already-consumed trusted-key file paths to skip duplicate auto-discovery candidates."
    Assert-True ($updateText -match '\.KeyCount -le 0') "Updater must judge auto-discovered key files empty by that file's own parsed key count."
    $distributionInitIndex = $updateText.IndexOf('Initialize-DistributionIntegrityConfig -Config $config')
    $mainTryBeforeDistributionInitIndex = $updateText.LastIndexOf('try {', $distributionInitIndex)
    $mainCatchAfterDistributionInitIndex = $updateText.IndexOf('catch {', $distributionInitIndex)
    Assert-True ($distributionInitIndex -ge 0 -and $mainTryBeforeDistributionInitIndex -ge 0 -and $mainTryBeforeDistributionInitIndex -lt $distributionInitIndex -and $mainCatchAfterDistributionInitIndex -gt $distributionInitIndex) "Updater must catch distribution-integrity initialization failures and write the normal failure report."
    Assert-True ($updateText -match 'HighestAcceptedReleaseSequence\s*=\s*\$highestAcceptedReleaseSequence') "Updater must pass anti-rollback state into integrity verification."
    Assert-True ($updateText -match 'hasAcceptedSignedRelease' -and $updateText -match 'Test-TruthyJsonValue' -and $updateText -match '\$highest\s*=\s*\[long\]1' -and $updateText -match '\[Math\]::Max\(\s+\$highestAcceptedReleaseSequence') "Updater must consume signed-acceptance state and not lower the stored signed-release high-watermark."
    Assert-True ($updateText -match 'RevAgent\.License\.psm1') "Updater must import the license verifier."
    Assert-True ($updateText -match '\[string\]\$LicensePolicy = ""' -and $updateText -match '\[string\]\$LicensePath = ""' -and $updateText -match '\[string\]\$LicenseSignaturePath = ""') "Updater must expose explicit license verification inputs."
    Assert-True ($updateText -match 'license-trusted-keys\.json') "Updater must look for packaged public license-key config."
    Assert-True ($updateText -match 'Initialize-LicenseConfig -Config \$config') "Updater must initialize license verification before package work."
    Assert-True ($updateText -match 'license = \$script:RevAgentLicense') "Updater reports must include license verification status."
    Assert-True ($updateText.IndexOf('Test-RevAgentReleaseDistributionIntegrity') -lt $updateText.IndexOf('$authenticatedPackageCache = New-RevAgentAuthenticatedPackageCacheStream')) "Updater must verify release integrity before copying the package into the guarded local cache stream."
    $verifiedArchiveHashIndex = $updateText.IndexOf('$sha256.ComputeHash($verifiedPackageStream)')
    $verifiedArchiveExtractIndex = $updateText.IndexOf('Expand-ReleaseArchiveStream -ArchiveStream $verifiedPackageStream')
    Assert-True ($verifiedArchiveHashIndex -ge 0 -and $verifiedArchiveHashIndex -lt $verifiedArchiveExtractIndex) "Updater must hash the retained package stream before extracting that same stream."
    Assert-True ($updateText -match 'New-RevAgentAuthenticatedPackageCacheStream' -and $updateText -match '\[System\.IO\.FileMode\]::CreateNew' -and $updateText -match '\[System\.IO\.FileShare\]::Read' -and $updateText -match '\$verifiedPackageStream\s*=\s*\$authenticatedPackageCache\.Stream' -and $updateText -match '\$authenticatedPackageCache\.CacheGuard\.Dispose\(\)') "Updater must create a unique ordinary cache file under a retained cache-root guard and keep its no-write/no-delete-share stream through extraction."
    Assert-True ($updateText -notmatch 'Copy-Item -LiteralPath \$packagePath -Destination \$cachedPackage' -and $updateText -notmatch 'Get-FileHash -Algorithm SHA256 -LiteralPath \$cachedPackage' -and $updateText -notmatch 'Expand-ReleaseArchive -ZipPath \$cachedPackage') "Updater must not follow a deterministic cache leaf or reopen the cached package path between copy, signature-bound hash verification, and extraction."
    Assert-True ($updateText -match 'elseif \(\$Force\) \{ "reinstall" \}') "Forced updater runs must be reported as reinstall operations."
    Assert-True ($updateText -match 'Publish-RevAgentMachineRunReport') "Updater must publish per-machine NAS reports and logs."
    Assert-True ($updateText -match '\.revagent-npm-dependencies\.json') "Updater payload fingerprints must ignore npm dependency marker files."
    Assert-True ($updateText -notmatch 'Repair-RevAgentScheduledTaskAction -Name \$TaskName') "Normal updates must not run an extra scheduled-task repair before the package installer."
    Assert-True ($updateText -match 'Pinned pre-import integrity verifier hash mismatch' -and $updateText -match 'DF8F31B60432CC26FD73345CEE143E90B4235BA2DE08779813DAEDBC8563282E') "Elevated updater must independently pin its pre-import signature verifier after UAC."
    Assert-True ($updateText -match 'Updater entrypoint does not match the authenticated snapshot component' -and $updateText -match 'GetFullPath\(\$PSCommandPath\).*GetFullPath\(\$componentPath\)') "Elevated updater must bind PSCommandPath to the exact authenticated local snapshot component."
    Assert-True ($updateText.IndexOf('Assert-RevAgentEarlyAuthenticatedSnapshot') -lt $updateText.IndexOf('Import-Module (Join-Path $nasLibRoot "RevAgent.HiddenLauncher.psm1")')) "Elevated updater must verify the protected snapshot state/hashes before importing sibling modules."
    Assert-True ($updateText -match 'authenticated-release-snapshot' -and $updateText -match 'signed_local_snapshot' -and $updateText -match 'Execution snapshot contains a filesystem link') "Elevated updater must reject unauthenticated or linked local snapshot inputs."
    Assert-True ($updateText -match 'Split-phase updater execution requires -ExecutionSnapshotStatePath before sibling-module import') "Elevated updater must require broker-owned snapshot state instead of a sealed NAS ACL claim."
    Assert-True ($updateText -match 'Machine-phase transcript could not be started at protected path' -and $updateText -match 'Remove-Item Env:\\REVIT_MCP_TRANSCRIPT_ACTIVE') "Machine updater must ignore inherited transcript markers and fail closed outside protected machine-logs."
    Assert-True ($updateText -match '\[switch\]\$HostedMachinePhase' -and $updateText -match '\$MachinePhaseOnly -and -not \$HostedMachinePhase') "Direct machine updater runs must ignore inherited transcript markers while hosted same-process runs preserve the validated parent transcript."
    Assert-True ($updateText -match '\$localReportPath = Join-Path \$\(if \(\$MachinePhaseOnly\) \{ \$machineStateRoot \} else \{ \$userStateRoot \}\)' -and $updateText -match 'local ProgramData handoff only' -and $updateText -match 'Publish-RevAgentPendingMachineUpdateReport') "Machine updater reports must stay in protected machine-state and be published only by the unelevated user phase."
    Assert-True ($updateText -match 'Write-RevAgentJsonFile -Path \$LocalReportPath' -and $updateText -match 'Read-RevAgentJsonReportFile -Path \$ReportPath' -and $updateText -match '-not \$MachinePhaseOnly -and \$script:RevAgentTranscriptStarted') "Updater report handoff must use guarded local JSON and block machine-phase remote publication."
    Assert-True ($updateText -notmatch 'New-Item -ItemType Directory -Path \$RemoteReportsRoot' -and $updateText -notmatch 'Write-JsonFile -Path \$remotePath') "Elevated updater code must not directly create or write NAS report paths."
    Assert-True ($updateText -match 'Revit API index: deferred to the unelevated user phase' -and $updateText -match 'docsIndexDeferred = \[bool\]\$docsIndexDeferred') "Machine updater must defer docs index writes to the unelevated user phase."
    Assert-True ($updateText -match '\$retentionLogsRoot = Join-Path \$WorkRoot \$\(if \(\$MachinePhaseOnly\) \{ "machine-logs" \} else \{ "logs" \}\)') "Machine fast-path retention must not touch user-writable logs."
    Assert-True ($updateText -notmatch 'Resolve-CodexDesktopCommand' -and $updateText -notmatch 'OpenAI\\Codex\\bin' -and $updateText -notmatch '&\s*\$codexPath\s+mcp') "Updater must never resolve or execute the mutable LocalAppData Codex CLI mirror."
    Assert-True ($updateText -match 'Codex MCP registration cannot run in the elevated machine phase' -and $updateText -match 'Invoke-InstalledCodexUserIntegration' -and $updateText -notmatch 'Register-CodexMcpServersInConfig') "Updater Codex integration must fail closed in the machine phase and use the authenticated unelevated atomic user-integration contract."
    Assert-True ($updateText -match 'Install-RevAgentProtectedCodexCliFromStore' -and $updateText -match 'protectedCodexCli = \$protectedCodexCliProvision') "Machine phase must provision and record the protected Codex CLI from authenticated Store package bytes."
    $installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
    Assert-True ($installTaskText -match '-MachinePhaseOnly -HostedMachinePhase') "Nested same-process updater runs must preserve only the validated parent machine transcript and defer final ACL handoff to the outer installer."
    Assert-True ($installTaskText -match 'installOperationMethod = \$script:RevAgentOperationMethod') "Updater installer config must record the install/repair method."
    Assert-True ($installTaskText -match 'function Get-EffectiveInstallOperation') "Updater installer must classify install versus reinstall operation type."
    Assert-True ($installTaskText -match 'diagnostics = \[ordered\]@') "Updater installer reports must include dashboard-ready diagnostics."
    Assert-True ($installTaskText -match 'Publish-RevAgentMachineRunReport') "Updater installer must publish per-machine NAS reports and logs."
    Assert-True ($installTaskText -match 'local ProgramData handoff only' -and $installTaskText -match 'Publish-RevAgentPendingMachineInstallReport' -and $installTaskText -match 'Write-RevAgentInstallUserPhaseResult') "Installer machine reports must be handed off locally and final publication evidence must be written by the unelevated user phase."
    Assert-True ($installTaskText -match '-not \$MachinePhaseOnly -and \$script:RevAgentTranscriptStarted' -and $installTaskText -match 'Read-RevAgentJsonReportFile -Path \$ReportPath') "Installer machine phase must not publish remotely and the user phase must re-read the guarded local report."
    Assert-True ($installTaskText -match 'RevAgentCodexUserIntegrationPhase = Read-RevAgentJsonReportFile -Path \$phaseResultFullPath' -and $installTaskText -match 'updaterUserPhase = \$script:RevAgentCodexUserIntegrationPhase' -and $installTaskText -match 'codexUserIntegration = \$script:RevAgentCodexUserIntegrationPhase') "Installer final reports and phase results must preserve the actual nested updater/Codex user-integration attestation before replacing the shared phase-result file."
    Assert-True ($installTaskText -match '-AuditOnly' -and $installTaskText -match '-OperationMethod", "scheduled-update-audit"') "Scheduled updater launcher must be audit-only and tag background audits in logs."
    Assert-True ($installTaskText -match 'trustedKeysPath = \$localTrustedReleaseKeysPath' -and $installTaskText -match 'policy = "enforce"') "Updater installer must pin the local trusted release key path and enforce distribution integrity."
    Assert-True ($installTaskText -notmatch 'previousTrustedReleaseKeysPath' -and $installTaskText -match 'Authenticated snapshot release key is unavailable; refusing updater repair' -and $installTaskText -match 'InstallVerifiedTrustedKeysSha256' -and $installTaskText -match 'InstallExecutionSnapshotState\.trust\.trustedKeysRelativePath') "Updater installer must never copy a trusted-key path from old config and must fail closed on the authenticated snapshot release key."
    Assert-True ($installTaskText -match '-UserPhaseOnly -PhaseResultPath \$phaseResultFullPath -ExecutionSnapshotStatePath \$ExecutionSnapshotStatePath' -and $installTaskText -match '-MachinePhaseOnly -PhaseResultPath \$phaseResultFullPath -ExecutionSnapshotStatePath \$ExecutionSnapshotStatePath' -and $installTaskText -match 'Authenticated snapshot updater changed after pre-import verification') "Nested updater machine/user phases must execute the exact hash-bound snapshot entrypoint with the broker-owned snapshot state."
    Assert-True ($installTaskText -match 'function Assert-UpdaterCommandFilesInstalled' -and $installTaskText -match '\$manualCommandPath = Assert-UpdaterCommandFilesInstalled -UpdaterPath \$localUpdater -UpdaterConfigPath \$configPath -UpdaterWorkRoot \$WorkRoot -VersionToolPath \$localVersionTool') "Unelevated installer user phase must verify machine-written helper command files instead of writing ProgramData."
    $installerHelperWritesAreIdempotent = (
        $installTaskText -match 'Set-RevAgentAsciiContentIfChanged -LiteralPath \$manualCommandPath -Lines \$manualCommandLines' -and
        $installTaskText -match 'Set-RevAgentAsciiContentIfChanged -LiteralPath \$versionCommandPath -Lines \$versionCommandLines'
    )
    $updaterHelperWritesAreIdempotent = (
        $updateText -match 'Set-RevAgentAsciiContentIfChanged -LiteralPath \(Join-Path \$DestinationRoot "Update-revAgent-Now\.cmd"\) -Lines \$manualCommandLines' -and
        $updateText -match 'Set-RevAgentAsciiContentIfChanged -LiteralPath \(Join-Path \$DestinationRoot "Show-revAgent-Version\.cmd"\) -Lines \$versionCommandLines'
    )
    Assert-True ($installerHelperWritesAreIdempotent -and $updaterHelperWritesAreIdempotent) "Split-phase user integration must not rewrite unchanged protected helper commands before Codex/report user work."
    Assert-True ($installTaskText -match 'function Write-RevAgentAtomicBytes' -and $installTaskText -match '\[System\.IO\.File\]::Replace\(\$temporaryPath,\s*\$fullPath,\s*\$backupPath,\s*\$true\)' -and $installTaskText -notmatch '\[System\.IO\.File\]::Replace\([^\r\n]*\$null' -and $installTaskText -match 'PermissionNativeFileInfo\]::GetLinkCount' -and $installTaskText -match 'may have partially displaced the destination; recovery artifacts were preserved' -and $installTaskText -notmatch 'Remove-Item -LiteralPath \$backupPath') "Updater installer config/tool file writes must use PS5-compatible atomic replacement, preserve partial-failure recovery evidence, and retain reparse/hardlink guards."
    Assert-True ($installTaskText -match 'Assert-InstallEarlyAuthenticatedSnapshot' -and $installTaskText.IndexOf('Assert-InstallEarlyAuthenticatedSnapshot') -lt $installTaskText.IndexOf('Import-Module (Join-Path $nasLibRoot "RevAgent.HiddenLauncher.psm1")')) "Elevated installer must reverify protected snapshot state before sibling imports."
    Assert-True ($installTaskText -match 'Split-phase updater installation requires -ExecutionSnapshotStatePath before sibling-module import' -and $installTaskText -match 'Execution snapshot contains a filesystem link') "Elevated installer must require a link-safe authenticated snapshot instead of a sealed NAS source."
    Assert-True ($installTaskText -match 'Installer entrypoint does not match the authenticated snapshot component' -and $installTaskText -match 'GetFullPath\(\$PSCommandPath\).*GetFullPath\(\$componentPath\)') "Elevated installer must bind PSCommandPath to the exact authenticated local snapshot component."
    Assert-True ($installTaskText -match 'updater = "installer\\nas\\update-from-nas\.ps1"' -and $installTaskText -match 'Release updater changed after signed bootstrap verification' -and $installTaskText -match 'InstallVerifiedSurfaceHashes\["updater"\]') "Installer snapshot closure must hash-bind update-from-nas and recheck it immediately before nested execution."
    Assert-True ($installTaskText -match 'Remove-Item Env:\\REVIT_MCP_TRANSCRIPT_ACTIVE' -and $installTaskText -match 'Machine-phase transcript could not be started at protected path') "Elevated installer must ignore inherited transcript markers and fail closed if protected logging cannot start."
    $updaterProtectIndex = $updateText.IndexOf('[void](Protect-RevAgentManagedExecutionTree')
    $updaterFinalGrantIndex = $updateText.IndexOf('[void](Grant-RevAgentUserStateAccess', $updaterProtectIndex)
    $installerProtectIndex = $installTaskText.IndexOf('[void](Protect-RevAgentManagedExecutionTree')
    $installerFinalGrantIndex = $installTaskText.IndexOf('[void](Grant-RevAgentUserStateAccess', $installerProtectIndex)
    Assert-True ($updaterProtectIndex -ge 0 -and $updaterFinalGrantIndex -gt $updateText.LastIndexOf('finally {') -and $installerProtectIndex -ge 0 -and $installerFinalGrantIndex -gt $installTaskText.LastIndexOf('finally {')) "User-writable state ACLs must be restored only in the outermost machine workflow finalization after all elevated traversal."
    $publishText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1")
    Assert-True (
        $publishText -match '\[System\.Array\]::Sort\(\$orderedRelativePaths,\s*\[System\.StringComparer\]::Ordinal\)' -and
        $releaseSnapshotText -match '\[Array\]::Sort\(\$orderedRelativePaths,\s*\[StringComparer\]::Ordinal\)' -and
        $updateText -match '\[System\.Array\]::Sort\(\$orderedRelativePaths,\s*\[System\.StringComparer\]::Ordinal\)'
    ) "Publisher, protected snapshot verifier, and updater must share the ordinal relative-path tree-hash contract across PowerShell engines."
    Assert-True ($publishText -match '\$components\["runtimePayload"\] = Get-DirectoryTreeHash') "Release manifest must include a runtime payload fingerprint."
    Assert-True ($publishText -match '\$components\["docsServerPayload"\] = Get-DirectoryTreeHash') "Release manifest must include a docs payload fingerprint."
    Assert-True ($publishText -match 'foreach \(\$payloadRoot in @\("installer\\revit-plugin", "installer\\command-payload"\)\)') "Release manifest must classify Revit add-in and command payload trees as Revit-close-required."
    Assert-True ($publishText -match 'revitClosedRequiredPaths = @\(\s+"installer\\revit-plugin"\s+"installer\\command-payload"\s+\)') "Release manifest must advertise Revit-close-required payload paths."
    Assert-True ($publishText -match '\.revagent-npm-dependencies\.json') "Release payload fingerprints must ignore npm dependency marker files."
    Assert-True ($publishText -match '\[string\]\$SigningPrivateKeyPath = ""' -and $publishText -match '\[string\]\$SigningKeyId = ""') "Release signing must be optional publish-time input."
    Assert-True ($publishText -match '\[long\]\$ReleaseSequence = 0' -and $publishText -match '\[long\]\$MinimumAcceptedReleaseSequence = 0') "Release publish signing must support signed anti-rollback sequence metadata."
    Assert-True ($publishText -match '\[switch\]\$RequireSigning') "Release publishing must expose an operator-enforced signing requirement."
    Assert-True ($publishText -match '\[string\]\$NodeMsiPath = ""' -and $publishText -match 'Copy-RevAgentPinnedNodeMsiSidecar' -and $publishText -match '(?s)externalDependencies.*nodeMsi') "Signed release publishing must require and manifest-bind a release-owned Node MSI sidecar."
    Assert-True ($publishText -match 'FD8BA3E8262738959CAD50E6F6E71D689EAB7DD09FC7231B51D78ABE7852D4EC' -and $publishText -match '32387072' -and $publishText -match 'CN=OpenJS Foundation') "Production release generation must pin the official Node MSI hash, size, and signer identity."
    Assert-True ($publishText -match '\[string\]\$TrustedReleaseKeysPath = ""' -and $publishText -match 'release-trusted-keys\.json') "Release publishing must optionally copy public trusted release keys to tools config."
    Assert-True ($publishText -match 'Copy-UserPackFile -SourceRelativePath "scripts\\install-revagent-local-bootstrap\.ps1" -DestinationRelativePath "installer\\nas\\install-revagent-local-bootstrap\.ps1"' -and $publishText -match 'Copy-UserPackFile -SourceRelativePath "scripts\\New-RevAgentBootstrapPrestageEvidence\.ps1"' -and $publishText -match 'bootstrapPrestageEvidenceSchema = "installer\\nas\\bootstrap-prestage-evidence\.schema\.json"' -and $publishText -match 'localBootstrapInstaller = "installer\\nas\\install-revagent-local-bootstrap\.ps1"' -and $publishText -match 'localBootstrapLauncher = "installer\\nas\\Start-revAgent-Update\.cmd"' -and $publishText -match 'updaterGui = "installer\\nas\\Install-revAgent-Updater-GUI\.ps1"' -and $publishText -match 'installerLibConfigSync = "installer\\lib\\RevAgent\.ConfigSync\.psm1"' -and $publishText -match 'installerLibDistributionIntegrity = "installer\\lib\\RevAgent\.DistributionIntegrity\.psm1"' -and $publishText -match 'installerLibPermissions = "installer\\lib\\RevAgent\.Permissions\.psm1"') "Signed user pack and release manifest must include the evidence producer/schema, prestage installer, protected local launcher, GUI, and every privilege-boundary library component."
    $nasToolsRefreshText = [regex]::Match($publishText, '(?s)Write-Section "Refresh NAS tools".*?foreach \(\$toolName in @\((.*?)\)\)').Groups[1].Value
    Assert-True (-not [string]::IsNullOrWhiteSpace($nasToolsRefreshText) -and $nasToolsRefreshText -notmatch '\.cmd') "Production NAS tools refresh must not publish any unsigned CMD first-hop alias."
    Assert-True ($publishText -match 'localBootstrap = "installer\\nas\\Start-revAgent-Update\.ps1"' -and $publishText -match 'installerLibLocalBootstrap = "installer\\lib\\RevAgent\.LocalBootstrap\.psm1"') "Signed release manifest must bind the local bootstrap and its protected prestage module."
    $localBootstrapModuleText = Get-Content -Raw -LiteralPath (Join-Path $libRoot "RevAgent.LocalBootstrap.psm1")
    $prestageInstallerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1")
    Assert-True ($localBootstrapModuleText -match 'CommonDesktopDirectory' -and $localBootstrapModuleText -match 'CreateShortcut' -and $localBootstrapModuleText -match 'revAgent Updater\.lnk' -and $localBootstrapModuleText -match 'Start-revAgent-Update\.cmd' -and $prestageInstallerText -match '\[string\]\$DesktopShortcutRoot = ""' -and $prestageInstallerText -match '-DesktopShortcutRoot \$DesktopShortcutRoot') "Local bootstrap installer must create the stable GUI desktop shortcut through the protected local launcher, with a test-only root override."
    Assert-True ($publishText -match '\$manifestMetadataPath' -and $publishText -match '\$zipMetadataPath') "Release publishing must write portable relative channel paths for signed CD artifacts."
    Assert-True ($publishText -match 'Signing private key must be stored outside the repository' -and $publishText -match 'Signing private key must be stored outside NAS tools') "Publish signing must reject private keys stored in shipped or tool roots."
    Assert-True ($publishText -match 'manifest\.sig\.json' -and $publishText -match '\{0\}\.sig\.json' -and $publishText -match 'Test-RevAgentDetachedJsonSignatureFile') "Publish signing must write and verify detached signature files."
    Assert-True ($publishText -notmatch 'kurulum|legacyEntryPoint|legacyInstaller') "Release publishing must not create the removed legacy kurulum package alias."
    $signedCdWorkflowText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot ".github\workflows\signed-source-free-cd.yml")
    Assert-True ($signedCdWorkflowText -notmatch '(?m)^\s+release_root:\s*\$\{\{' -and $signedCdWorkflowText -notmatch 'needs\.build-signed-release\.outputs\.release_root') "Signed CD must never pass a runner-local release root path across the job boundary."
    Assert-True ($signedCdWorkflowText -match 'https://nodejs\.org/dist/v24\.14\.1/node-v24\.14\.1-x64\.msi' -and $signedCdWorkflowText -match 'FD8BA3E8262738959CAD50E6F6E71D689EAB7DD09FC7231B51D78ABE7852D4EC' -and $signedCdWorkflowText -match 'NodeMsiPath = \$env:REVAGENT_NODE_MSI_PATH') "Signed CD must download the exact official pinned Node MSI and pass only the verified local asset path to the producer."
    Assert-Equal ([regex]::Matches($signedCdWorkflowText, 'ref:\s*\$\{\{ github\.sha \}\}').Count) 2 "Both signed CD jobs must check out the immutable workflow event SHA instead of a moving main ref."
    Assert-Equal ([regex]::Matches($signedCdWorkflowText, 'git rev-parse HEAD').Count) 2 "Both signed CD jobs must fail closed unless their checked-out commit exactly equals GITHUB_SHA."
    Assert-True ($signedCdWorkflowText -match 'artifact_id:\s*\$\{\{ steps\.signed-release-artifact\.outputs\.artifact-id \}\}' -and $signedCdWorkflowText -match 'artifact_digest:\s*\$\{\{ steps\.signed-release-artifact\.outputs\.artifact-digest \}\}' -and $signedCdWorkflowText -match 'source_channel_sha256:\s*\$\{\{ steps\.build\.outputs\.source_channel_sha256 \}\}') "Signed CD build job outputs must expose the immutable artifact ID/digest plus the exact signed channel identity, never a runner-local path."
    Assert-True ($signedCdWorkflowText -match '(?s)- name: Upload immutable signed release artifact\s+id: signed-release-artifact\s+if: \$\{\{ github\.event_name == ''workflow_dispatch'' && \(inputs\.publish_to_nas \|\| inputs\.publish_to_pilot\) \}\}\s+uses: actions/upload-artifact@v7' -and $signedCdWorkflowText -match 'if-no-files-found:\s*error' -and $signedCdWorkflowText -match 'retention-days:\s*1' -and $signedCdWorkflowText -match 'overwrite:\s*false' -and $signedCdWorkflowText -match 'include-hidden-files:\s*true') "Only an explicit publish dispatch may upload one immutable, short-lived, complete release artifact; main-push validation stays local and fails on an empty publish tree."
    Assert-True ($signedCdWorkflowText -match '(?s)"X-GitHub-Api-Version" = "2026-03-10"\s+\}\s+\$artifactUri = .*?/actions/artifacts/\$artifactId') "Exact artifact lookup must use the current GitHub.com Actions artifact REST schema that exposes the server digest."
    Assert-True ($signedCdWorkflowText -match 'actions/artifacts/\$artifactId' -and $signedCdWorkflowText -match '\[long\]\$artifact\.id -ne \$artifactId' -and $signedCdWorkflowText -match '\$artifactDigest -notmatch ''\^\[0-9a-f\]\{64\}\$''' -and $signedCdWorkflowText -match '\$artifact\.workflow_run\.id' -and $signedCdWorkflowText -match '\$artifact\.workflow_run\.repository_id' -and $signedCdWorkflowText -match '\$artifact\.workflow_run\.head_repository_id' -and $signedCdWorkflowText -match '\$artifact\.workflow_run\.head_sha' -and $signedCdWorkflowText -match '\$expectedServerDigest = "sha256:\$artifactDigest"' -and $signedCdWorkflowText -match '\$artifact\.digest, \$expectedServerDigest') "Signed CD publish job must require a raw SHA-256 build output, query the exact REST artifact ID, and bind its sha256 digest, repository, run, and commit."
    Assert-True ($signedCdWorkflowText -match 'uses:\s*actions/download-artifact@v8' -and $signedCdWorkflowText -match 'artifact-ids:\s*\$\{\{ needs\.build-signed-release\.outputs\.artifact_id \}\}' -and $signedCdWorkflowText -match 'repository:\s*\$\{\{ github\.repository \}\}' -and $signedCdWorkflowText -match 'run-id:\s*\$\{\{ github\.run_id \}\}' -and $signedCdWorkflowText -match 'digest-mismatch:\s*error') "Signed CD publish job must download only the exact artifact ID for this repository/run and fail on a digest mismatch."
    Assert-True ($signedCdWorkflowText -match 'ExpectedSourceChannelSha256 = \$env:REVAGENT_EXPECTED_SOURCE_CHANNEL_SHA256' -and $signedCdWorkflowText -match 'EXPECTED_SOURCE_CHANNEL_SHA256:\s*\$\{\{ needs\.build-signed-release\.outputs\.source_channel_sha256 \}\}' -and $signedCdWorkflowText -match '\$sourceChannelSha256 -notmatch') "The publisher must receive the build-bound signed channel SHA-256 so a valid but different signed tree cannot be substituted after artifact download."
    Assert-True ($signedCdWorkflowText -match '\$env:RUNNER_TEMP' -and $signedCdWorkflowText -match 'revagent-signed-download-\{0\}-\{1\}-\{2\}' -and $signedCdWorkflowText -match '\$env:GITHUB_RUN_ID, \$env:GITHUB_RUN_ATTEMPT, \$env:GITHUB_JOB' -and $signedCdWorkflowText -match '\$preexisting\.Count -ne 0' -and $signedCdWorkflowText -match 'Artifact landing parent ancestor chain before download' -and $signedCdWorkflowText -match 'Artifact landing leaf and ancestor chain after download' -and $signedCdWorkflowText -match 'Artifact landing leaf and ancestor chain immediately before publisher' -and $signedCdWorkflowText -match 'DriveType\]::Fixed' -and $signedCdWorkflowText -match 'Directory\]::GetParent' -and $signedCdWorkflowText -match 'FileAttributes\]::ReparsePoint' -and $signedCdWorkflowText -match '\$item\.LinkType') "Signed CD artifact extraction must use an absent job-unique local-drive RUNNER_TEMP leaf and scan its full ancestor/leaf chain for reparse links before download, after download, and immediately before publisher entry."
    Assert-True ($signedCdWorkflowText -notmatch 'Remove-Item[^\r\n]*-Recurse') "Signed CD workflow must never recursively clean an artifact or staging pathname."
    $downloadValidationIndex = $signedCdWorkflowText.IndexOf('- name: Validate downloaded signed release landing root')
    $publisherRevalidationIndex = $signedCdWorkflowText.IndexOf('.\scripts\publish-signed-source-free-release-to-nas.ps1', $downloadValidationIndex)
    Assert-True ($downloadValidationIndex -ge 0 -and $publisherRevalidationIndex -gt $downloadValidationIndex) "Signed CD publisher must revalidate the downloaded signed tree only after exact artifact download and landing-root checks."
    $payloadFreshnessText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\test-mcp-build-payload-freshness.ps1")
    $testAllText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\test-all.ps1")
    $packageTestHelpersPath = Join-Path $RepoRoot "scripts\McpPackageTestHelpers.psm1"
    $packageTestHelpersText = Get-Content -Raw -LiteralPath $packageTestHelpersPath
    $packageTestHelpersTokens = $null
    $packageTestHelpersErrors = $null
    $packageTestHelpersAst = [System.Management.Automation.Language.Parser]::ParseFile(
        $packageTestHelpersPath,
        [ref]$packageTestHelpersTokens,
        [ref]$packageTestHelpersErrors
    )
    Assert-Equal $packageTestHelpersErrors.Count 0 "MCP package test helpers must parse without errors."
    $npmCiFunctionAst = $packageTestHelpersAst.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq "Invoke-McpPackageNpmCi"
    }, $true)
    Assert-True ($null -ne $npmCiFunctionAst) "Invoke-McpPackageNpmCi must remain present in the MCP package test helpers."
    $npmCiFunctionText = [string]$npmCiFunctionAst.Extent.Text
    $revitPayloadManifestText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\RevitPayloadManifest.psm1")
    $buildRevitPluginText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\build-revit-plugin.ps1")
    $ciText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\test-ci.ps1")
    $phase1aLiveWrapperText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\test-spatial-phase1a-live.ps1")
    $phase1aLiveHarnessText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\test-spatial-phase1a-live.mjs")
    $phase1bLiveWrapperPath = Join-Path $RepoRoot "scripts\test-spatial-phase1b-live.ps1"
    $phase1bLiveHarnessPath = Join-Path $RepoRoot "scripts\test-spatial-phase1b-live.mjs"
    $phase1bLiveWrapperText = Get-Content -Raw -LiteralPath $phase1bLiveWrapperPath
    $phase1bLiveHarnessText = Get-Content -Raw -LiteralPath $phase1bLiveHarnessPath
    $phase1bAgentEvidenceCliPath = Join-Path $RepoRoot "scripts\spatial-phase1b-agent-evidence.mjs"
    $phase1bAgentEvidenceCollectorPath = Join-Path $RepoRoot "scripts\spatial-phase1b-public-handler-trace.mjs"
    $phase1bAgentEvidenceContractPath = Join-Path $RepoRoot "installer\runtime-mcp-server\scripts\spatial-phase1b-agent-evidence-contract.mjs"
    $phase1bAgentEvidenceRuntimeHashPath = Join-Path $RepoRoot "installer\runtime-mcp-server\scripts\spatial-phase1b-runtime-build-hash.mjs"
    $phase1bAgentEvidenceTestPath = Join-Path $RepoRoot "installer\runtime-mcp-server\scripts\spatial-phase1b-agent-evidence.test.mjs"
    $phase1bAgentEvidenceSchemaPath = Join-Path $RepoRoot "evals\schemas\spatial-phase1b-agent-evidence-v2.schema.json"
    Assert-True (Test-Path -LiteralPath $phase1bAgentEvidenceCliPath -PathType Leaf) "Phase 1b actual-agent evidence CLI is missing."
    Assert-True (Test-Path -LiteralPath $phase1bAgentEvidenceCollectorPath -PathType Leaf) "Phase 1b permanent public-handler collector is missing."
    Assert-True (Test-Path -LiteralPath $phase1bAgentEvidenceContractPath -PathType Leaf) "Phase 1b actual-agent evidence contract is missing."
    Assert-True (Test-Path -LiteralPath $phase1bAgentEvidenceRuntimeHashPath -PathType Leaf) "Phase 1b executed runtime build-tree hash helper is missing."
    Assert-True (Test-Path -LiteralPath $phase1bAgentEvidenceTestPath -PathType Leaf) "Phase 1b actual-agent evidence mutation test is missing."
    Assert-True (Test-Path -LiteralPath $phase1bAgentEvidenceSchemaPath -PathType Leaf) "Phase 1b actual-agent evidence v2 schema is missing."
    $phase1bAgentEvidenceCliText = Get-Content -Raw -LiteralPath $phase1bAgentEvidenceCliPath
    $phase1bAgentEvidenceCollectorText = Get-Content -Raw -LiteralPath $phase1bAgentEvidenceCollectorPath
    $phase1bAgentEvidenceContractText = Get-Content -Raw -LiteralPath $phase1bAgentEvidenceContractPath
    $phase1bAgentEvidenceRuntimeHashText = Get-Content -Raw -LiteralPath $phase1bAgentEvidenceRuntimeHashPath
    $phase1bAgentEvidenceTestText = Get-Content -Raw -LiteralPath $phase1bAgentEvidenceTestPath
    $phase1bAgentEvidenceSchemaText = Get-Content -Raw -LiteralPath $phase1bAgentEvidenceSchemaPath
    $runtimePackageText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\package.json")
    $runtimePackageLockText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\package-lock.json")
    $runtimeReleasePackageText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\release\package.json")
    $runtimeReleasePackageLockText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\release\package-lock.json")
    $buildMcpReleaseText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\build-mcp-release-bundle.mjs")
    $docsPackageText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-api-docs-mcp\package.json")
    $docsPackageLockText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-api-docs-mcp\package-lock.json")
    $docsReleasePackageText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-api-docs-mcp\release\package.json")
    $docsReleasePackageLockText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-api-docs-mcp\release\package-lock.json")
    Assert-True ($payloadFreshnessText -match 'Assert-RevitPayloadManifestFresh') "Payload freshness gate must validate the Revit manifest."
    Assert-True ($payloadFreshnessText -match 'Assert-RevitPayloadNoDebugArtifacts') "Payload freshness gate must reject committed Revit .NET debug artifacts."
    Assert-True ($payloadFreshnessText -match 'New-McpPackageWorkCopy' -and $payloadFreshnessText -match 'Invoke-McpPackageNpmCi' -and $payloadFreshnessText -match 'Get-McpPackageTscPath') "Payload freshness gate must restore and compile MCP packages from isolated temporary work copies."
    Assert-True ($payloadFreshnessText -match 'build-mcp-release-bundle\.mjs' -and $payloadFreshnessText -match 'Release payload for \$PackageRelativePath') "Payload freshness gate must validate hardened MCP release artifacts."
    Assert-True ($revitPayloadManifestText -match 'function Get-RevitPayloadDebugArtifactPaths' -and $revitPayloadManifestText -match 'installer/revit-plugin' -and $revitPayloadManifestText -match 'installer/command-payload') "Revit payload manifest helpers must scan installer Revit payload roots for .NET debug artifacts."
    Assert-True ($revitPayloadManifestText -match '\$repoPrefix = \$repoRootFullName \+ \[System\.IO\.Path\]::DirectorySeparatorChar' -and $revitPayloadManifestText -notmatch '\$RepoRoot\.Length \+ 1') "Revit debug-artifact scanning must use a normalized repository prefix."
    Assert-True ($revitPayloadManifestText -notmatch '\$artifacts \+=') "Revit debug-artifact scanning must not use array += accumulation."
    Assert-True ($buildRevitPluginText -match 'Remove-RevitPayloadDebugArtifacts -RepoRoot \$RepoRoot' -and $buildRevitPluginText -match 'Assert-RevitPayloadNoDebugArtifacts -RepoRoot \$RepoRoot') "Revit payload build refresh must remove and reject stale .NET debug artifacts."
    Assert-True ($packageTestHelpersText -match 'node_modules' -and $packageTestHelpersText -match '\.package-lock\.json' -and $packageTestHelpersText -match 'GetTempPath' -and $packageTestHelpersText -match 'REVIT_MCP_REPO_ROOT') "MCP package test helpers must skip live dependency folders, use temporary work copies, and preserve repo-root context."
    Assert-True ($npmCiFunctionText -match '\$previousNpmIgnoreScripts = \[Environment\]::GetEnvironmentVariable\("npm_config_ignore_scripts", "Process"\)' -and $npmCiFunctionText -match 'try\s*\{' -and $npmCiFunctionText -match '\$env:npm_config_ignore_scripts = "false"' -and $npmCiFunctionText -match 'finally\s*\{' -and $npmCiFunctionText -match 'Remove-Item Env:\\npm_config_ignore_scripts' -and $npmCiFunctionText -match '\$env:npm_config_ignore_scripts = \$previousNpmIgnoreScripts') "MCP package npm ci must enable lifecycle scripts process-locally and restore the caller environment through finally."
    Assert-True ($runtimePackageText -match '"@e965/xlsx"' -and $runtimePackageText -notmatch '"exceljs"') "Runtime Excel ingestion must avoid the deprecated exceljs transitive dependency chain."
    Assert-True ($runtimePackageText -match '"ajv"' -and $runtimePackageText -match '"ajv-formats"' -and $runtimePackageText -match '"schemas"') "Spatial response validation must declare its schema runtime dependencies and package the published schemas."
    Assert-True ($buildMcpReleaseText -match 'schemas.*spatial' -and $buildMcpReleaseText -match 'copyNormalizedJsonTree' -and $buildMcpReleaseText -match 'JSON\.parse\(sourceText\)' -and $buildMcpReleaseText -match 'sourceText\.replace') "Runtime release assembly must validate, normalize, and copy every published spatial schema version."
    $spatialSchemaNamesByVersion = [ordered]@{
        "v0.1" = @("element-ref", "node-ref", "source-revision", "cursor-envelope", "spatial-snapshot", "extraction-page")
        "v0.2" = @("element-ref", "node-ref", "source-revision", "cursor-envelope", "spatial-snapshot", "extraction-page", "work-continuation", "work-cursor-envelope")
        "v0.3" = @("spatial-properties", "profile", "topology-coverage", "fingerprints", "spatial-snapshot", "extraction-page", "work-continuation")
    }
    foreach ($schemaVersion in $spatialSchemaNamesByVersion.Keys) {
        foreach ($schemaName in $spatialSchemaNamesByVersion[$schemaVersion]) {
            Assert-True (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\schemas\spatial\$schemaVersion\$schemaName.schema.json") -PathType Leaf) "Published spatial schema is missing: $schemaVersion/$schemaName."
            Assert-True (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\release\schemas\spatial\$schemaVersion\$schemaName.schema.json") -PathType Leaf) "Runtime release spatial schema is missing: $schemaVersion/$schemaName."
        }
    }
    Assert-True ($runtimePackageText -match '"build:release"' -and $docsPackageText -match '"build:release"') "MCP packages must expose a hardened release bundle build script."
    Assert-True ($runtimeReleasePackageText -notmatch '"(scripts|devDependencies|files)"' -and $docsReleasePackageText -notmatch '"(scripts|devDependencies|files)"') "Release MCP package manifests must be runtime-only."
    Assert-True ($runtimeReleasePackageLockText -notmatch '"dev": true' -and $docsReleasePackageLockText -notmatch '"dev": true') "Release MCP package locks must not include dev dependency entries."
    Assert-True ($docsPackageText -match '"rimraf": "\^6\.') "Docs MCP clean script dependency must use rimraf 6 or newer."
    Assert-True ($runtimePackageLockText -notmatch 'node_modules/(inflight|lodash\.isequal|fstream)' -and $docsPackageLockText -notmatch 'node_modules/(inflight|lodash\.isequal|fstream)') "MCP package locks must not include deprecated npm dependency packages that create CI warning noise."
    Assert-True ($runtimePackageLockText -notmatch '"version": "2\.7\.1"|node_modules/glob":\s*\{\s*"version": "7\.2\.3"' -and $docsPackageLockText -notmatch '"version": "2\.7\.1"|node_modules/glob":\s*\{\s*"version": "10\.5\.0"') "MCP package locks must not include deprecated rimraf/glob versions."
    Assert-True ($payloadFreshnessText -notmatch 'Get-NewestPayloadSourceFile|Assert-RevitPayloadFresh|LastWriteTimeUtc -gt') "Payload freshness gate must not use Revit source/payload mtimes."
    Assert-True ($ciText -match 'Get-McpPackageTscPath' -and $ciText -notmatch 'tsc\.cmd') "CI forced TypeScript checks must resolve the package-local compiler portably."
    Assert-True ($testAllText -match 'New-McpPackageWorkCopy' -and $testAllText -match 'Invoke-McpPackageNpmCi' -and $testAllText -match 'Invoke-McpPackageCommand -PackageName "\$\(\$package\.Name\) npm test"') "Local test-all gate must restore package npm dependencies in an isolated work copy before npm tests and payload freshness."
    Assert-True ($testAllText -match 'test-updater-npm-dependencies\.ps1' -and $ciText -match 'test-updater-npm-dependencies\.ps1') "Local and protected CI gates must run the updater Node ABI/native dependency contract test against an isolated runtime package."
    Assert-True ($phase1aLiveWrapperText -match 'test-spatial-phase1a-live\.mjs' -and $phase1aLiveWrapperText -match '--config') "Phase 1a live wrapper must delegate through the dedicated Node harness."
    Assert-True ($phase1aLiveHarnessText -match 'registerCaptureSpatialSnapshotTool' -and $phase1aLiveHarnessText -match 'captureHandler\(captureArgs\)') "Phase 1a live gate must exercise the built runtime public capture_spatial_snapshot handler."
    Assert-True ($phase1aLiveHarnessText -match 'registerGetRevitMcpStatusTool' -and $phase1aLiveHarnessText -match 'name === "get_revit_mcp_status"' -and $phase1aLiveHarnessText -match 'assertReady\("capture_spatial_snapshot"\)' -and $phase1aLiveHarnessText -match 'get_spatial_change_state') "Phase 1a live gate must use the built public get_revit_mcp_status handler before capture and persisted liveness commands."
    Assert-True ($phase1aLiveHarnessText -match 'probeStoredSpatialSnapshotLiveness' -and $phase1aLiveHarnessText -match 'getSnapshotRecord' -and $phase1aLiveHarnessText -match 'countRTreeEntries' -and $phase1aLiveHarnessText -match 'queryIntersectingAabbs') "Phase 1a live gate must recheck persisted liveness and inspect the committed SQLite/R*Tree state."
    Assert-True ($phase1aLiveHarnessText -match 'nativeUiOccupancy' -and $phase1aLiveHarnessText -match 'preparationPerformance' -and $phase1aLiveHarnessText -match 'preparationContinuationCount' -and $phase1aLiveHarnessText -match 'PREPARATION_PHASE_ORDER' -and $phase1aLiveHarnessText -match 'p95Within2000Ms' -and $phase1aLiveHarnessText -match 'maxWithin5000Ms' -and $phase1aLiveHarnessText -match 'combinedNativeChunkCount' -and $phase1aLiveHarnessText -match 'DEFAULT_CAPTURE_P95_LIMIT_MS = 45_000' -and $phase1aLiveHarnessText -match 'DEFAULT_CAPTURE_MAX_LIMIT_MS = 60_000') "Phase 1a live gate must fail closed on data-page and preparation native UI occupancy plus total capture SLOs."
    Assert-True ($phase1aLiveWrapperText -match '\[switch\]\$TestConcurrentEdit' -and $phase1aLiveHarnessText -match 'runConcurrentEditProbe' -and $phase1aLiveHarnessText -match 'maxRetries: 0' -and $phase1aLiveHarnessText -match 'capture_interrupted_by_change' -and $phase1aLiveHarnessText -match 'getStagingCaptureCount' -and $phase1aLiveHarnessText -match 'snapshotIdentitySetUnchanged') "Phase 1a live gate must prove operator-assisted concurrent-edit interruption without a committed or staged mixed-revision snapshot."
    Assert-True ($phase1aLiveHarnessText -match 'connectorNodeCount > 0' -and $phase1aLiveHarnessText -match 'doublePlacedGroups' -and $phase1aLiveHarnessText -match 'maximumDistinctPlacementCount' -and $phase1aLiveHarnessText -match 'doublePlacedBindingsConsistent' -and $phase1aLiveHarnessText -match 'sharedDocumentSessionAndRevisionBinding' -and $phase1aLiveWrapperText -match 'RequireConnectorEvidence' -and $phase1aLiveWrapperText -match 'RequireDoublePlacedLinkEvidence') "Phase 1a live gate must prove connector extraction plus one shared document-session/revision binding across distinct placements of the same linked document."
    Assert-True ($phase1aLiveHarnessText -match 'gateDAccepted' -and $phase1aLiveHarnessText -match 'process\.exitCode = 2' -and $phase1aLiveHarnessText -match 'concurrentEdit\.passed === true') "Phase 1a live gate must remain pending unless its operator-assisted concurrent-edit gate passes."
    Assert-True ($phase1aLiveHarnessText -match 'database\.mode === "explicit"' -and $phase1aLiveHarnessText -match 'requireRetainedExplicitDatabase: true') "Phase 1a Gate D must require a retained explicit database that can be rechecked after restart."
    Assert-True ($phase1aLiveHarnessText -match 'phase1a-live-capture-evidence-latest\.json' -and $phase1aLiveHarnessText -match 'phase1a-live-recheck-evidence-latest\.json') "Phase 1a capture and restart recheck must preserve separate default evidence artifacts."
    Assert-True ($phase1aLiveWrapperText -match '\[ValidateSet\("stale", "unknown"\)\]\s*\[string\[\]\]\$ExpectedPostEditLiveness' -and $phase1aLiveHarnessText -match '\["stale", "unknown"\]\.includes\(postEditLiveness\.liveness\)') "Phase 1a Gate D must never accept current as a post-edit liveness outcome."
    Assert-True ($phase1aLiveHarnessText -match 'sanitizeEvidence' -and $phase1aLiveHarnessText -match 'snapshotIdSha256' -and $phase1aLiveHarnessText -match 'databasePath must not be a UNC/network path' -and $phase1aLiveHarnessText -match 'evidencePath must stay outside the Git repository' -and $phase1aLiveWrapperText -match 'must stay outside the Git repository') "Phase 1a live gate must keep its database local and emit only sanitized evidence outside the repository."
    Assert-True ($phase1aLiveHarnessText -match 'ALLOWED_LOCAL_DRIVE_TYPES = new Set\(\[2, 3, 6\]\)' -and $phase1aLiveHarnessText -match '\[IO\.DriveInfo\]::new' -and $phase1aLiveHarnessText -match 'assertSpatialLocalFilesystemPath' -and $phase1aLiveHarnessText -match 'prepareDatabase\(config, assertRuntimeLocalFilesystemPath\)' -and $phase1aLiveHarnessText -match 'assertRuntimeLocalFilesystemPath' -and $phase1aLiveWrapperText -match '\[System\.IO\.DriveInfo\]::new' -and $phase1aLiveWrapperText -match '\$driveType -notin @\(2, 3, 6\)') "Phase 1a local artifacts must reuse the runtime guard, reject mapped Network/Unknown/NoRoot drives, and allow only ready Fixed, Removable, or RAM roots before writes."
    Assert-True ($phase1aLiveHarnessText -notmatch 'send_code_to_revit|set_element_parameter|set_schedule_cells|transactionMode|create_3d_view|delete_review_view' -and $phase1aLiveWrapperText -notmatch 'publish-nas-release|update-from-nas|install-self-contained') "Phase 1a live gate must not contain model-write, install, publish, or deploy entrypoints."
    Assert-True ($testAllText -notmatch 'test-spatial-phase1a-live' -and $ciText -notmatch 'test-spatial-phase1a-live') "Phase 1a live Revit gate must remain outside test-all and CI-safe Engineering gates."
    $phase1bLiveWrapperTokens = $null
    $phase1bLiveWrapperErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $phase1bLiveWrapperPath,
        [ref]$phase1bLiveWrapperTokens,
        [ref]$phase1bLiveWrapperErrors
    ) | Out-Null
    Assert-Equal $phase1bLiveWrapperErrors.Count 0 "Phase 1b live wrapper must parse without errors."
    Assert-True ($phase1bLiveWrapperText -match 'test-spatial-phase1b-live\.mjs' -and $phase1bLiveWrapperText -match '--config') "Phase 1b live wrapper must delegate through the dedicated Node harness."
    Assert-True ($phase1bLiveWrapperText -match '\[string\]\$FixturePath' -and $phase1bLiveWrapperText -match '\[string\]\$DatabasePath' -and $phase1bLiveWrapperText -match '\[string\]\$EvidencePath' -and $phase1bLiveWrapperText -match '\[string\]\$GroundTruthManifestPath' -and $phase1bLiveWrapperText -match '\[string\]\$AgentEvalEvidencePath' -and $phase1bLiveWrapperText -match 'FixturePath.*RequireExistingFile' -and $phase1bLiveWrapperText -match 'DatabasePath.*RequireExistingFile' -and $phase1bLiveWrapperText -match 'GroundTruthManifestPath.*RequireExistingFile' -and $phase1bLiveWrapperText -match 'AgentEvalEvidencePath.*RequireExistingFile' -and $phase1bLiveHarnessText -match 'agentEvalEvidencePath' -and $phase1bLiveWrapperText -match 'LevelNames\.Count -eq 0.*LevelIds\.Count -eq 0') "Phase 1b live gate must require explicit level scope plus frozen fixture, retained local database, sanitized output, ground truth, and external agent-eval evidence paths."
    Assert-True ($phase1bLiveWrapperText -match '\[ValidateRange\(20, 100\)\]' -and $phase1bLiveWrapperText -match '\[ValidateRange\(1, 750\)\]' -and $phase1bLiveWrapperText -match '\[ValidateRange\(1, 3000\)\]' -and $phase1bLiveHarnessText -match 'boundedInteger\(parsed\.repeatCount, 20, 20, 100' -and $phase1bLiveHarnessText -match 'warmupExcluded: true') "Phase 1b live performance gate must require a warm-up followed by at least twenty measured samples without relaxable SLOs."
    Assert-True ($phase1bLiveHarnessText -match 'registerGetRevitMcpStatusTool' -and $phase1bLiveHarnessText -match 'registerCaptureSpatialSnapshotTool' -and $phase1bLiveHarnessText -match 'registerQuerySpatialContextTool' -and $phase1bLiveHarnessText -match 'registerCompareSpatialSnapshotsTool' -and $phase1bLiveHarnessText -match 'registerSummarizeSpatialStateTool' -and $phase1bLiveHarnessText -match 'async function invokePublicHandler' -and $phase1bLiveHarnessText -match 'await assertReady\(name\)') "Phase 1b live gate must use built public status, capture, query, diff, and summary handlers with a status preflight before every non-status invocation."
    Assert-True ($phase1bLiveHarnessText -match 'REQUIRED_OPERATION_NAMES' -and $phase1bLiveHarnessText -match 'relation_between' -and $phase1bLiveHarnessText -match 'nearest_elements' -and $phase1bLiveHarnessText -match 'elements_within' -and $phase1bLiveHarnessText -match 'clearance_between' -and $phase1bLiveHarnessText -match 'trace_connectivity' -and $phase1bLiveHarnessText -match 'locate_in_space' -and $phase1bLiveHarnessText -match 'above_below') "Phase 1b live operation gold and performance coverage must include every public deterministic operation class."
    Assert-True ($phase1bLiveHarnessText -match 'summarizeDurations' -and $phase1bLiveHarnessText -match 'p50Ms' -and $phase1bLiveHarnessText -match 'p95Ms' -and $phase1bLiveHarnessText -match 'maxMs' -and $phase1bLiveHarnessText -match 'casePerformance\.p95Ms <= config\.operationLimitMs' -and $phase1bLiveHarnessText -match 'metrics\.p95Ms <= config\.operationLimitMs' -and $phase1bLiveHarnessText -match 'diffPerformance\.p95Ms <= config\.diffLimitMs' -and $phase1bLiveHarnessText -notmatch 'metrics\.maxMs <= config\.operationLimitMs' -and $phase1bLiveHarnessText -notmatch 'diffPerformance\.maxMs <= config\.diffLimitMs') "Phase 1b live evidence must record p50/p95/max and enforce per-case, per-operation, and changed-diff p95 thresholds."
    Assert-True ($phase1bLiveHarnessText -match 'schemaVersion === "0\.3"' -and $phase1bLiveHarnessText -match 'spatialProperties' -and $phase1bLiveHarnessText -match 'insulationThicknessMm' -and $phase1bLiveHarnessText -match 'phase1b-spatial-fingerprint/1\.0' -and $phase1bLiveHarnessText -match '\["placement", "shape", "property", "topology"\]') "Phase 1b live contract inspection must require v0.3 system/profile/insulation and independently versioned fingerprints."
    Assert-True ($phase1bLiveHarnessText -match 'revit_connector_all_refs' -and $phase1bLiveHarnessText -match 'connectedToNodeIds' -and $phase1bLiveHarnessText -match 'reciprocalConnectorPairs' -and $phase1bLiveHarnessText -match 'getSnapshotTopologyCapability' -and $phase1bLiveHarnessText -match 'targetMembershipValidated === true' -and $phase1bLiveHarnessText -match 'unresolvedPeerReferenceCount === 0') "Phase 1b live gate must prove reciprocal native topology and committed-snapshot membership without coordinate inference."
    Assert-True ($phase1bLiveHarnessText -match 'doublePlacementPairs' -and $phase1bLiveHarnessText -match 'left\.linkInstanceUniqueId !== right\.linkInstanceUniqueId' -and $phase1bLiveHarnessText -match 'left\.geometryFingerprint !== right\.geometryFingerprint' -and $phase1bLiveHarnessText -match 'sourceToHostTransform') "Phase 1b live gate must prove placement-aware identities and distinct validated host transforms for one twice-placed link source."
    Assert-True ($phase1bLiveHarnessText -match 'straight_round_to_round' -and $phase1bLiveHarnessText -match 'revitMeasuredExpectedDistanceMm' -and $phase1bLiveHarnessText -match 'error <= 1' -and $phase1bLiveHarnessText -match 'analytic_straight_round_swept_profile' -and $phase1bLiveHarnessText -match 'rectangular_screening_only' -and $phase1bLiveHarnessText -match 'basis === "aabb"' -and $phase1bLiveHarnessText -match 'precisionClass === "candidate"' -and $phase1bLiveHarnessText -match 'verdictCapability === "screening_only"') "Phase 1b live ground truth must enforce <=1 mm straight-round error while rectangular evidence remains AABB candidate/screening-only."
    Assert-True ($phase1bLiveHarnessText -match 'room_hole_exclusion' -and $phase1bLiveHarnessText -match 'coincident_disconnected' -and $phase1bLiveHarnessText -match 'validateFixtureGroundTruthSnapshot' -and $phase1bLiveHarnessText -match 'pointInPolygon2d' -and $phase1bLiveHarnessText -match 'minimumConnectorCenterDeltaMm' -and $phase1bLiveHarnessText -match 'shape === "rectangular"' -and $phase1bLiveHarnessText -match 'expectedSeparationMm === 840' -and $phase1bLiveHarnessText -match 'wrongGoldAnswerCount: \{ containment: 0, direction: 0, topology: 0 \}' -and $phase1bLiveHarnessText -match 'assertExactNormalized') "Phase 1b live operation gold must be structurally bound to the Room hole, coincident-disconnected connectors, rectangular profile, and exact 840 mm round pair."
    Assert-True ($phase1bLiveHarnessText -match 'REQUIRED_FAIL_CLOSED_CLASSES' -and $phase1bLiveHarnessText -match '"partial"' -and $phase1bLiveHarnessText -match '"stale"' -and $phase1bLiveHarnessText -match '"unknown"' -and $phase1bLiveHarnessText -match '"unsupported"' -and $phase1bLiveHarnessText -match '"ambiguous"' -and $phase1bLiveHarnessText -match '"incompatible"' -and $phase1bLiveHarnessText -match 'assertFailClosed' -and $phase1bLiveHarnessText -match '!Object\.hasOwn\(result, "computed"\)') "Phase 1b live gate must exercise every required fail-closed evidence class without deterministic result leakage."
    Assert-True ($phase1bAgentEvidenceContractText -match 'REQUIRED_AGENT_EVAL_GROUPS = Object\.freeze\(\[1, 2, 4, 5, 6\]\)' -and $phase1bLiveHarnessText -match 'AGENT_EVAL_EVIDENCE_SCHEMA' -and $phase1bLiveHarnessText -match 'validateAgentEvalEvidenceFile' -and $phase1bLiveHarnessText -match 'requiredPhase1bAgentEvals' -and $phase1bLiveHarnessText -match 'agentEvalEvidenceSha256' -and $phase1bLiveHarnessText -match 'requiredAgentEvalVariants\.length === 11' -and $phase1bLiveHarnessText -notmatch 'actualAgentRun === true|toolTracePassed === true|forbiddenClaimCheckPassed === true' -and $phase1bAgentEvidenceContractText -match 'codex_desktop_jsonl' -and $phase1bAgentEvidenceContractText -match 'model_provider' -and $phase1bAgentEvidenceContractText -match 'agentRunId' -and $phase1bAgentEvidenceContractText -match 'expectedTurnId' -and $phase1bAgentEvidenceContractText -match 'rawTranscriptSha256' -and $phase1bAgentEvidenceContractText -match 'custom_tool_call_output' -and $phase1bAgentEvidenceContractText -match 'call_id' -and $phase1bAgentEvidenceContractText -match 'completePlatformCallInventory' -and $phase1bAgentEvidenceContractText -match 'forbidden_tool_calls' -and $phase1bAgentEvidenceContractText -match 'computeAgentClaimAudit' -and $phase1bAgentEvidenceContractText -match 'computeTraceSafetyAudit' -and $phase1bAgentEvidenceContractText -match 'computeEntityGroundingAudit' -and $phase1bAgentEvidenceContractText -match 'agent-response-attestation\\.v1' -and $phase1bAgentEvidenceCliText -match 'prepare' -and $phase1bAgentEvidenceCliText -match 'assemble' -and $phase1bAgentEvidenceCliText -match 'validate' -and $phase1bAgentEvidenceCliText -notmatch 'collect-trace' -and $phase1bAgentEvidenceCollectorText -match 'get_revit_mcp_status' -and $phase1bAgentEvidenceCollectorText -match 'REVAGENT_PHASE1B_COLLECTOR_RESULT' -and $phase1bAgentEvidenceTestText -match 'selfDeclared' -and $phase1bAgentEvidenceTestText -match 'legacyArtifacts' -and $phase1bAgentEvidenceTestText -match 'extraCallArtifacts' -and $phase1bAgentEvidenceTestText -match 'semantic false-pass' -and $phase1bAgentEvidenceTestText -match 'computeTraceSafetyAudit' -and $phase1bAgentEvidenceTestText -match 'unboundEntity' -and $phase1bAgentEvidenceSchemaText -match 'platform_call_id_collector_stdout_and_immutable_trace' -and $runtimePackageText -match '"spatial-phase1b-agent-evidence-test"') "Phase 1b Gate D must use platform-call-bound v2 evidence, a permanent collector, complete call inventory, deterministic semantic/trace/entity-grounding checks, and mutation-tested rejection of legacy/self-declared proof."
    Assert-True ($phase1bAgentEvidenceContractText -match 'encrypted_content' -and $phase1bAgentEvidenceContractText -match 'expectedParentThreadId' -and $phase1bAgentEvidenceContractText -match 'snapshotBindings' -and $phase1bAgentEvidenceContractText -match 'runtimeBuildTreeSha256' -and $phase1bAgentEvidenceCollectorText -match 'z\.object\(registered\.schema\)\.strict\(\)' -and $phase1bAgentEvidenceCollectorText -match 'tcp localhost/127\.0\.0\.1 port 8080' -and $phase1bAgentEvidenceCollectorText -match 'resolveSnapshotBindings' -and $phase1bAgentEvidenceRuntimeHashText -match 'filesRecursively' -and $phase1bLiveHarnessText -match 'validateAgentEvalExecutionBinding' -and $phase1bLiveHarnessText -match 'sourceBindingFingerprint') "Phase 1b actual-agent evidence must match real encrypted Codex events, real public Zod schemas, a locked local endpoint, the retained fixture snapshot family, and the full executed runtime build tree."
    Assert-True ($phase1bLiveHarnessText -match 'validateInstalledRevit2022PayloadIdentity' -and $phase1bLiveHarnessText -match 'installedCommandsetSha256' -and $phase1bLiveHarnessText -match 'repoSha256 === installedSha256' -and $phase1bLiveHarnessText -match 'repoCommandsetSizeBytes' -and $phase1bLiveHarnessText -match 'installedCommandsetSizeBytes' -and $phase1bLiveHarnessText -match 'payloadManifestEntrySha256' -and $phase1bLiveHarnessText -match 'Number\(entry\.sizeBytes\) === repoBytes\.length' -and $phase1bLiveHarnessText -match 'installedPluginSha256' -and $phase1bLiveHarnessText -match 'repoPluginSha256 === installedPluginSha256' -and $phase1bLiveHarnessText -match 'repoPluginSizeBytes' -and $phase1bLiveHarnessText -match 'installedPluginSizeBytes' -and $phase1bLiveHarnessText -match 'payloadManifestPluginEntrySha256' -and $phase1bLiveHarnessText -match 'pluginManifestEntryMatch' -and $phase1bLiveHarnessText -match 'addinEntries\.length === 1' -and $phase1bLiveHarnessText -match 'fs\.realpathSync\.native\(declaredAssemblyPath\)' -and $phase1bLiveHarnessText -match 'installedAddinAssemblyPathMatch' -and $phase1bLiveHarnessText -match 'installedAddinLoadsVerifiedPlugin') "Phase 1b live Gate D must prove repository/installed commandset and revAgentPlugin DLL hash/size identities, a unique add-in record with realpath-bound assembly routing, and exact unique payload-manifest entries."
    Assert-True ($phase1bLiveHarnessText -match 'baseSnapshotAlias' -and $phase1bLiveHarnessText -match 'headSnapshotAlias' -and $phase1bLiveHarnessText -match 'resolveSnapshotAliasRecord' -and $phase1bLiveHarnessText -match 'changedRowCount > 0' -and $phase1bLiveHarnessText -match 'changedDiffAliasBinding') "Phase 1b diff performance must use two explicit retained aliases and prove a real changed comparison."
    Assert-True ($phase1bLiveHarnessText -match 'stripVolatileNormalizedFields' -and $phase1bLiveHarnessText -match '\(\?:snapshotId\|revisionFingerprint\|sessionId\)\$' -and $phase1bLiveHarnessText -match 'computed: result\.computed') "Phase 1b gold normalization must recursively remove volatile nested snapshot, revision, and document/tracker session identities while retaining deterministic computed evidence."
    Assert-True ($phase1bLiveHarnessText -match 'ALLOWED_LOCAL_DRIVE_TYPES = new Set\(\[2, 3, 6\]\)' -and $phase1bLiveHarnessText -match '\[IO\.DriveInfo\]::new' -and $phase1bLiveHarnessText -match 'assertSpatialLocalFilesystemPath' -and $phase1bLiveHarnessText -match 'resolveExternalArtifactPath' -and $phase1bLiveHarnessText -match 'realRepoRoot = fs\.realpathSync\.native\(repoRoot\)' -and $phase1bLiveHarnessText -match 'artifactPaths\.every' -and $phase1bLiveHarnessText -match 'dangling symlink or reparse-point path' -and $phase1bLiveHarnessText -match 'Sanitized evidence contained' -and $phase1bLiveHarnessText -match 'const fixtureFileSha256 = sha256Hex\(fs\.readFileSync\(config\.fixturePath\)\)' -and $phase1bLiveHarnessText -match 'fixtureIdentitySha256: fixtureFileSha256' -and $phase1bLiveHarnessText -match 'groundTruthManifestSha256: manifest\.rawSha256' -and $phase1bLiveHarnessText -match 'Frozen fixture SHA-256 does not match' -and $phase1bLiveWrapperText -match '\[System\.IO\.DriveInfo\]::new' -and $phase1bLiveWrapperText -match '\$driveType -notin @\(2, 3, 6\)' -and $phase1bLiveWrapperText -match 'Get-NativePathState' -and $phase1bLiveWrapperText -match 'fs\.realpathSync\.native\(p\)' -and $phase1bLiveWrapperText -match 'Resolve-NativeRealPath' -and $phase1bLiveWrapperText -match '\$requestedState\.entryExists' -and $phase1bLiveWrapperText -match 'Test-PathUnderRoot -Path \$resolved -Root \$RepoRoot') "Phase 1b fixture, database, manifest, agent evidence, and sanitized output must resolve through junction-safe real paths onto guarded local drives outside Git with separate verified provenance hashes."
    Assert-True ($phase1bLiveHarnessText -match 'LOCKED_GATE_D_HOSTS = new Set\(\["localhost", "127\.0\.0\.1"\]\)' -and $phase1bLiveHarnessText -match 'target === "tcp" && LOCKED_GATE_D_HOSTS\.has\(host\) && port === 8080' -and $phase1bLiveHarnessText -match 'function sanitizationSensitiveHostValues' -and $phase1bLiveHarnessText -match 'LOCKED_GATE_D_HOSTS\.has\(text\.toLowerCase\(\)\) \? \[\] : \[text\]' -and $phase1bLiveHarnessText -match '\.\.\.sanitizationSensitiveHostValues\(config\.host\)') "Phase 1b Gate D must accept both locked loopback host spellings without treating them as sensitive evidence while rejecting every non-local endpoint."
    Assert-True ($phase1bLiveHarnessText -notmatch 'send_code_to_revit|sendRevitCommand|set_element_parameter|set_schedule_cells|transactionMode|create_3d_view|delete_review_view' -and $phase1bLiveWrapperText -notmatch 'publish-nas-release|update-from-nas|install-self-contained' -and $testAllText -notmatch 'test-spatial-phase1b-live' -and $ciText -notmatch 'test-spatial-phase1b-live') "Phase 1b live gate must use no raw/model-write/deploy entrypoints and must remain outside CI-safe gates."
    Assert-True ($revitPayloadManifestText -match 'installer\\revit-payload-manifest\.json') "Revit payload manifest path must be centralized."
    Assert-True ($revitPayloadManifestText -match 'gitBlobSha' -and $revitPayloadManifestText -match 'hash-object' -and $revitPayloadManifestText -match '--path=') "Revit source freshness must use Git blob SHAs."
    Assert-True ($revitPayloadManifestText -match 'System\.Management\.Automation\.ErrorRecord') "Revit payload Git helper must filter stderr warning records from successful output."
    Assert-True ($revitPayloadManifestText -match '--untracked-files=all') "Revit payload manifest guard must inspect files inside untracked source folders."
    Assert-True ($revitPayloadManifestText -match 'manifest is empty or invalid JSON' -and $revitPayloadManifestText -match 'ConvertFrom-Json -ErrorAction Stop') "Revit payload manifest guard must report empty or invalid JSON clearly."
    Assert-True ($revitPayloadManifestText -match 'sha256' -and $revitPayloadManifestText -match 'sizeBytes') "Revit payload manifest must fingerprint payload DLL bytes."
    Assert-True ($buildRevitPluginText -match 'Write-RevitPayloadManifest') "Revit payload build must refresh the manifest with payload copies."
    Assert-True ($ciText -match 'test-mcp-build-payload-freshness\.ps1"\) -RepoRoot \$RepoRoot') "CI must run the payload freshness gate."
    Assert-True ($ciText -notmatch 'test-mcp-build-payload-freshness\.ps1"\) -RepoRoot \$RepoRoot -McpOnly') "CI must not skip the Revit manifest freshness gate."
    $packageLibText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.Package.psm1")
    Assert-True ($packageLibText -notmatch 'kurulum') "Package layout resolution must not keep the removed legacy kurulum path."
    Assert-True ($guiText -notmatch 'Guncelle|Surum|Kapat|Kurulum|Kanal|Hazir|Islem|Calisiyor|Baslatilamadi|bulunamadi|hata') "GUI product strings must remain English."
    Assert-True ($guiText -notmatch 'Revit MCP Installer|Revit MCP install and update|Stable Restore|Stable channel|Stable version') "GUI product labels must not expose internal MCP wording or legacy channel wording."

    Write-Host "Test revAgent user-facing MCP naming"
    $codexRegistrationText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.CodexRegistration.psm1")
    $runtimeIndexText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\index.ts")
    $statusToolText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\get_revit_mcp_status.ts")
    $listInstancesToolText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\list_revit_instances.ts")
    $userSkillText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\codex-user\SKILL.md")
    $userAgentsText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\codex-user\AGENTS.md")
    Assert-True ($codexRegistrationText -match '-Name "revAgent"' -and $codexRegistrationText -match '-Name "revAgent-api-docs"') "Codex MCP registration must use revAgent-facing names."
    Assert-True ($codexRegistrationText -match '"revit-mcp", "revit-api-docs"') "Codex MCP registration must remove legacy user-facing names."
    Assert-True ($codexRegistrationText -notmatch 'Set-RevAgentCodexMcpServerConfig[^\r\n]+-Name "revit-mcp"') "Codex MCP registration must not add the legacy runtime name."
    Assert-True ($runtimeIndexText -match 'name:\s*"revAgent"' -and $runtimeIndexText -notmatch 'name:\s*"revit-mcp"') "Runtime MCP server metadata must expose revAgent."
    Assert-True ($statusToolText -notmatch 'Read the Revit MCP task status' -and $statusToolText -match 'Read the revAgent task status') "Status tool description must use revAgent wording."
    Assert-True ($listInstancesToolText -notmatch 'Revit MCP socket instances' -and $listInstancesToolText -match 'revAgent Revit bridge instances') "Instance discovery tool description must use revAgent wording."
    Assert-True ($userSkillText -notmatch 'Revit MCP runtime|Revit MCP review|Revit MCP runtime tools|name: revit-mcp') "User-pack SKILL.md must not expose legacy product wording."
    Assert-True ($userAgentsText -notmatch 'Revit MCP runtime|Revit MCP work|Revit MCP Coordination|revAgent/Revit MCP') "User-pack AGENTS.md must not expose legacy product wording."
    Assert-True ($userSkillText -match 'inspect_levels') "User-pack SKILL.md must route host/linked Level discovery through inspect_levels."
    Assert-True ($userAgentsText -match 'inspect_levels') "User-pack AGENTS.md must route host/linked Level discovery through inspect_levels."

    Write-Host "Test Revit task status window product surface"
    $taskStatusXaml = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\UI\McpTaskStatusWindow.xaml")
    $taskStatusCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\UI\McpTaskStatusWindow.xaml.cs")
    $taskStatusController = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\McpTaskStatusWindowController.cs")
    $taskStatusService = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\McpTaskStatusService.cs")
    $socketServiceCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\SocketService.cs")
    $commandExecutorCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\CommandExecutor.cs")
    $bridgeResultContractCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\BridgeResultContract.cs")
    $applicationCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\Application.cs")
    $metadataCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\RevAgentMetadataCommand.cs")
    Assert-True ($taskStatusXaml -match 'Title="revAgent Status"') "Task status window title must use revAgent."
    Assert-True ($taskStatusXaml -match 'Your AI agent inside Revit\.') "Task status window must show the revAgent product tagline."
    Assert-True ($taskStatusXaml -match '2026 Baris Tankut') "Task status window must show the revAgent copyright footer."
    Assert-True ($taskStatusXaml -match 'www\.revagent\.app') "Task status window must show the official revAgent web address."
    Assert-True ($taskStatusXaml -match 'UpdateStatusText') "Task status window must expose the update state line."
    Assert-True ($taskStatusXaml -match 'Up to date') "Task status window must use user-facing update state wording."
    Assert-True ($taskStatusXaml -match 'WindowStyle="SingleBorderWindow"') "Task status window must expose a normal minimizable window frame."
    Assert-True ($taskStatusXaml -match 'ShowInTaskbar="True"') "Task status window must be visible in the taskbar."
    Assert-True ($taskStatusXaml -notmatch 'Revit MCP|Recent MCP') "Task status window XAML must not expose internal MCP wording."
    Assert-True ($taskStatusCode -notmatch 'Revit MCP is working|Revit MCP task|Revit MCP version') "Task status code must not expose internal MCP wording."
    Assert-True ($taskStatusCode -match 'VersionDisplay') "Task status code must present the installed product version label."
    Assert-True ($taskStatusCode -match 'FormatUpdateStatusLine') "Task status code must present a concise update-state label."
    Assert-True ($applicationCode -match 'ID_EXCMD_REVAGENT_INFO' -and $applicationCode -notmatch 'ID_EXCMD_TOGGLE_REVIT_MCP|ID_EXCMD_MCP_SETTINGS') "Revit ribbon must expose only the revAgent metadata button."
    Assert-True ($metadataCommandCode -match 'FormatMetadataDetails' -and $metadataCommandCode -match 'ProductWebsiteUrl') "Revit metadata button must show the shared revAgent version metadata and web address."
    $versionInfoCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\McpVersionInfo.cs")
    Assert-True ($versionInfoCode -match 'channelManifestPath') "Version info must read the configured channel manifest path."
    Assert-True ($versionInfoCode -match 'publishedAtUtc') "Version info must use release/channel publish timestamps when available."
    Assert-True ($versionInfoCode -match 'Version ') "Version info must label the installed product version clearly."
    Assert-True ($versionInfoCode -match '\(" \+ build \+ "\)"') "Version info must place the build identifier in the Version line."
    Assert-True ($versionInfoCode -match 'Installed on this PC') "Version info must keep local install time in support details only."
    Assert-True ($versionInfoCode -match 'FormatMetadataDetails' -and $versionInfoCode -match 'www\.revagent\.app' -and $versionInfoCode -match 'Copyright \(c\) 2026 Baris Tankut') "Version metadata must include active version, official web address, and copyright details."
    Assert-True ($versionInfoCode -notmatch 'Updated ') "Task status metadata must not expose local install time as the user-facing version."
    Assert-True ($versionInfoCode -match 'Up to date') "Version info must label current release state clearly."
    Assert-True ($versionInfoCode -notmatch 'Stable ') "Version info must not expose legacy channel labels in the product UI."
    Assert-True ($taskStatusController -match 'revAgent Task Status UI') "Task status UI thread should use the product name."
    Assert-True ($taskStatusCode -match 'ShowGuarded') "Task status window must display safety-guarded tasks separately from failures."
    Assert-True ($taskStatusController -match 'ShowGuarded') "Task status controller must route guarded task state to the UI."
    Assert-True ($taskStatusService -match 'GuardTask') "Task status service must support a guarded task state."
    Assert-True ($taskStatusService -match 'MaxRecentTasks = 100') "Task status service must retain enough recent tasks for full-test/debug runs."
    Assert-True ($taskStatusService -match 'JsonProperty\("wrapperAction"' -and $taskStatusService -match 'JsonProperty\("logicalToolName"') "Task status service must preserve wrapper/logical tool metadata in recentTasks."
    Assert-True ($socketServiceCode -match 'ExtractRequestParamText\(request, "wrapperAction"\)' -and $socketServiceCode -match 'ExtractRequestParamText\(request, "logicalToolName", "toolName"\)') "Socket service must forward wrapper/logical tool metadata into task status history."
    Assert-True ($taskStatusCode -match 'MaxHistoryItems = 100') "Task status window must keep enough visible history for full-test/debug runs."
    Assert-True ($taskStatusService -notmatch 'NormalizeErrorMessage|ContainsCjk') "Task status service must not hide localized source text with a sanitizer."
    Assert-True ($socketServiceCode -match 'IsCommandResultGuarded') "Socket service must classify expected safety blocks as guarded tasks."
    Assert-True ($bridgeResultContractCode -match 'public const int ResultContractVersion = 2') "Bridge result contract must expose the normalized payload floor."
    Assert-True ($bridgeResultContractCode -match 'CamelCaseNamingStrategy') "Bridge result contract must centralize native camelCase serialization."
    Assert-True ($bridgeResultContractCode -match 'ProcessDictionaryKeys = false') "Bridge result contract must not rewrite dictionary/domain payload keys."
    Assert-True ($bridgeResultContractCode -match 'obj\["resultContractVersion"\] = ResultContractVersion') "Bridge result payloads must be self-describing."
    Assert-True ($commandExecutorCode -match 'BridgeResultContract\.CreateResultPayload\(result\)') "CommandExecutor success responses must use the bridge result contract helper."
    Assert-True ($socketServiceCode -match 'BridgeResultContract\.CreateResultPayload\(result\)') "SocketService success responses must use the bridge result contract helper."
    Assert-True ($socketServiceCode -match 'BridgeResultContract\.ToCamelCaseToken\(result\)') "SocketService guarded/failure detection must inspect the same camelCase token shape."
    Assert-True ($commandExecutorCode -notmatch 'JToken\.FromObject' -and $socketServiceCode -notmatch 'JToken\.FromObject') "Bridge response/guard/failure paths must not bypass the central camelCase helper."
    Assert-True ($taskStatusCode -match 'Guarded / blocked by safety') "Task status window must describe guarded tasks as a safety block, not a failure."
    Assert-True ($taskStatusCode -match 'return "!"') "Task status history must render guarded tasks with the warning-style exclamation symbol."
    Assert-True ($taskStatusCode -match 'return "\\u2715"') "Failed task history must keep a distinct failure symbol."

    Write-Host "Test Revit view focus visibility guard"
    $focusHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\ElementFocusHelpers.cs")
    $focusHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\FocusElementsEventHandler.cs")
    $openPlanCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\OpenExistingPlanForElementLevelEventHandler.cs")
    $openPlanCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\OpenExistingPlanForElementLevelCommand.cs")
    $openPlanToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\open_existing_plan_for_element_level.ts")
    $smartFocusToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\smart_focus_elements.ts")
    $sendCodeToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\send_code_to_revit.ts")
    $closeViewCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\CloseViewEventHandler.cs")
    $clearSelectionToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\clear_selection.ts")
    $clearSelectionHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\ClearSelectionEventHandler.cs")
    $deleteReviewViewToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\delete_review_view.ts")
    $deleteReviewViewHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\DeleteReviewViewEventHandler.cs")
    $create3dHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\Create3DViewForElementsEventHandler.cs")
    $sectionBoxHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\SectionBoxElementsEventHandler.cs")
    $viewHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\ViewCommandHelpers.cs")
    $discoveryCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\ElementDiscoveryHelpers.cs")
    $findCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\FindElementsCommand.cs")
    $findHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\FindElementsEventHandler.cs")
    $inspectSheetTextCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSheetTextCommand.cs")
    $inspectSheetTextHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSheetTextEventHandler.cs")
    $annotationEvidenceHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\AnnotationEvidenceHelpers.cs")
    $findToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\find_elements.ts")
    $searchPolicyCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\searchPolicy.ts")
    $broadScanResultCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\broadScanResult.ts")
    $inspectElementsToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\inspect_elements.ts")
    $inspectLevelsToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\inspect_levels.ts")
    $inspectLevelsCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\Spatial\InspectLevelsCommand.cs")
    $inspectLevelsHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\Spatial\InspectLevelsEventHandler.cs")
    $showPlan3dToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\show_element_in_plan_and_3d.ts")
    $sessionContextToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\get_revit_session_context.ts")
    $activeViewContextToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\get_active_view_context.ts")
    $instanceListToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\list_revit_instances.ts")
    $viewImageToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\export_revit_view_image.ts")
    $coordinationImageToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\export_revit_coordination_image.ts")
    $create3dToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\create_3d_view_for_elements.ts")
    $statusToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\get_revit_mcp_status.ts")
    $runtimeIdentityCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\runtimeIdentity.ts")
    $toolHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\revitToolHelpers.ts")
    $parameterSchemaToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\inspect_parameter_schema.ts")
    $inspectSheetTextToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\inspect_sheet_text.ts")
    $inspectSchedulesToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\inspect_schedules.ts")
    $reconcileScheduleAdapterCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\reconcile_schedule_adapter.ts")
    $countAnnotationsToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\count_annotations.ts")
    $countAnnotationsHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\CountAnnotationsEventHandler.cs")
    $inspectSchedulesHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSchedulesEventHandler.cs")
    $commandSetRegistryCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\command.json")
    $setParameterToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\set_element_parameter.ts")
    $setScheduleCellsToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\set_schedule_cells.ts")
    $setScheduleCellsByTextToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\set_schedule_cells_by_text.ts")
    $safeCodeGuardsCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\send_code_to_revit_safe_guards.ts")
    $telemetryCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\telemetry.ts")
    $captureSpatialToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\capture_spatial_snapshot.ts")
    $spatialCaptureCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\spatial\spatialCapture.ts")
    $spatialPageCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\spatial\spatialPage.ts")
    $spatialPageSchemaCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\spatial\spatialPageSchema.ts")
    $safeCodeToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\send_code_to_revit_safe.ts")
    $apiDocsIndexCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-api-docs-mcp\src\utils\docIndex.ts")
    Assert-True ($captureSpatialToolCode -match 'extract_spatial_snapshot' -and $captureSpatialToolCode -match 'hasExplicitLevelScope' -and $captureSpatialToolCode -match 'captureSpatialSnapshotAtomic' -and $spatialCaptureCode -match 'invalid_spatial_page_contract') "capture_spatial_snapshot must remain an explicit-level, strict-contract Phase 1a atomic capture orchestrator over the native extractor."
    Assert-True ($spatialPageSchemaCode -match 'extraction-page\.schema\.json' -and $spatialPageSchemaCode -match 'canonicalJson' -and $spatialPageCode -match 'pagePayloadBytes') "Spatial page normalization must validate the published transport schema, recompute canonical hashes, and preserve page-vs-snapshot byte totals."
    Assert-True ($telemetryCode -match 'SPATIAL_EXTRACTION_NAMES' -and $telemetryCode -match 'inspect_levels' -and $telemetryCode -match 'summarizeSpatialExtractionTelemetryParams' -and $telemetryCode -match 'summarizeSpatialExtractionTelemetryResponse' -and $telemetryCode -match 'return null') "Spatial extraction and Level-inventory telemetry must keep the strict no-model-data production-context boundary."
    Assert-True ($focusHelpersCode -match 'new FilteredElementCollector\(document, view\.Id\)') "View visibility helper must use a view-specific collector."
    Assert-True ($focusHelpersCode -match 'ElementIdSetFilter') "View visibility helper must filter directly by target element id instead of materializing all visible ids."
    Assert-True ($focusHelpersCode -match 'elementNotVisibleInTargetView') "View visibility helper must report non-visible target elements."
    Assert-True ($focusHandlerCode -notmatch 'get_BoundingBox\(view\)') "focus_elements must not use a view bounding box as visibility proof."
    Assert-True ($focusHandlerCode -match 'metadataOnlyFastGuard') "focus_elements guarded response must avoid slow verified plan scans."
    Assert-True ($openPlanCode -match 'FindPlanCandidates\(document, uiDocument, levelId, _planNameContains, _preferMechanical, element\)') "open_existing_plan_for_element_level must rank plans with the target element visibility."
    Assert-True ($openPlanCode -match 'FindPlanCandidates\(document, uiDocument, levelId, _planNameContains, _preferMechanical, null\)') "open_existing_plan_for_element_level metadata-first mode must avoid scanning every candidate view."
    Assert-True ($openPlanCode -match 'BuildVerifiedCandidateForPlan') "open_existing_plan_for_element_level metadata-first mode must verify the selected plan before focusing."
    Assert-True ($openPlanCode -match 'VerifyMetadataCandidatesInOrder') "open_existing_plan_for_element_level metadata-first mode must verify ranked candidates in order before fallback."
    Assert-True ($openPlanCode -match '_maxMetadataVerifyCandidates') "open_existing_plan_for_element_level metadata-first verification must use a bounded candidate count."
    Assert-True ($openPlanCode -match 'FallbackUsed') "open_existing_plan_for_element_level must report whether full verified fallback was used."
    Assert-True ($openPlanCode -match '_fallbackToVerified') "open_existing_plan_for_element_level must keep verified fallback available."
    Assert-True ($openPlanCommandCode -match 'planCandidateMode') "open_existing_plan_for_element_level command must parse planCandidateMode."
    Assert-True ($openPlanCommandCode -match 'maxMetadataVerifyCandidates') "open_existing_plan_for_element_level command must parse maxMetadataVerifyCandidates."
    Assert-True ($openPlanToolCode -match 'planCandidateMode: z\.enum\(\["metadataFirst", "verified"\]\)') "open_existing_plan_for_element_level tool must expose metadataFirst/verified plan selection."
    Assert-True ($openPlanToolCode -match 'maxMetadataVerifyCandidates: z\.number\(\)\.int\(\)\.min\(1\)\.max\(25\)') "open_existing_plan_for_element_level tool must expose a bounded metadata verification cap."
    Assert-True ($findToolCode -match 'planCandidateMode: z\.enum\(\["none", "metadata", "verified"\]\)') "find_elements must expose explicit plan candidate modes."
    Assert-True ($findToolCode -match 'searchBudget: z\.enum\(\["fast", "balanced", "deep"\]\)') "find_elements must expose ergonomic searchBudget presets."
    Assert-True ($findToolCode -match 'allowExpensiveSearch') "find_elements must expose explicit expensive-search approval."
    Assert-True ($findToolCode -match 'modelSignals' -and $findToolCode -match 'cheap large-model signals') "find_elements must accept cheap prior model risk signals without collecting heavy counts."
    Assert-True ($findToolCode -match 'buildFindElementsSearchPolicy') "find_elements must infer MEP search scope before calling Revit."
    Assert-True ($findToolCode -match 'allowExpensiveSearch: policy\.allowExpensiveSearch') "find_elements must forward searchBudget=deep as expensive-search approval to the Revit bridge."
    Assert-True ($findToolCode -match 'riskPolicy') "find_elements must return explicit search risk policy metadata."
    Assert-True ($findToolCode -match 'writeSafetyWarning') "find_elements compact output must make discovery-only write risk visible."
    Assert-True ($findToolCode -match 'writeBlockedUntil: "exact_element_and_parameter_schema_preflight"') "find_elements write guidance must block writes until exact element and parameter schema preflight."
    Assert-True ($findToolCode -match 'set_element_parameter_dry_run_with_expected_current_value') "find_elements write guidance must require a guarded set_element_parameter dry-run before commit."
    Assert-True ($findToolCode -match 'broad_or_ambiguous_discovery_result') "find_elements write guidance must flag broad or ambiguous discovery output as unsafe for parameter writes."
    Assert-True ($findToolCode -match 'builtInParameterId') "find_elements write guidance must require stable parameter identity before writes."
    Assert-True ($findCommandCode -match 'planCandidateMode != "none"') "find_elements command must keep plan candidate scans opt-in."
    Assert-True ($findCommandCode -match 'maxElapsedMs' -and $findCommandCode -match 'timeoutMs - 1000') "find_elements command must keep Revit scan budget below socket timeout."
    Assert-True ($findHandlerCode -match 'ElementMulticategoryFilter') "find_elements bridge must use API-level category filters instead of only in-memory category filtering."
    Assert-True ($findHandlerCode -notmatch 'ElementLevelFilter' -and $findHandlerCode -notmatch 'BuildLevelParameterElementFilter' -and $findHandlerCode -notmatch 'ResolveCollectorLevelFilterIds') "find_elements bridge must not use API-level level prefilters that can silently drop MEP elements with fallback level parameters."
    Assert-True ($findHandlerCode -match 'MatchesAdditionalFilters\(searchDocument, element\)' -and $findHandlerCode -match 'ResolveElementLevel') "find_elements bridge must keep level filtering in the in-memory post-filter path."
    Assert-True ($findHandlerCode -match 'if \(_levelIds\.Count > 0 \|\| _levelNames\.Count > 0\)[\s\S]+ResolveElementLevel') "find_elements bridge must resolve levels only when level filters are requested."
    Assert-True ($findHandlerCode -match 'ScannedElementCount' -and $findHandlerCode -match 'Partial' -and $findHandlerCode -match 'ScanStoppedReason') "find_elements bridge must report scan budget and partial-result state."
    Assert-True ($findHandlerCode -match 'No matching elements found\.') "find_elements no-match result must not say matching elements were found."
    Assert-True ($findHandlerCode -match 'No matching elements found\. Narrow or adjust') "find_elements no-match selection hint must not claim there is a top match."
    Assert-True ($findHandlerCode -match 'VerifiedPlanCandidateMaxMatchesWithoutApproval' -and $findHandlerCode -match 'verified plan candidate visibility was downgraded to metadata') "find_elements bridge must downgrade broad verified plan visibility without explicit approval."
    Assert-True ($findHandlerCode -match 'IsExactTargetVerifiedMatchSet' -and $findHandlerCode -match 'exactTargetCount > 0 && matchCount <= exactTargetCount') "find_elements bridge must preserve verified mode for bounded exact element-id/unique-id targets."
    Assert-True ($findHandlerCode -match 'bool planCandidateStopped = false' -and $findHandlerCode -match 'ref planCandidateStopped' -and $findHandlerCode -match 'if \(planCandidateStopped\)') "find_elements bridge must track plan-candidate budget separately from earlier search partial state."
    Assert-True ($findHandlerCode -match 'IsLinkedOnlyHostElementIdSearch') "find_elements bridge must guard linkedOnly exact host element-id lookups."
    Assert-True ($findHandlerCode -match 'SearchLinkedUniqueIds') "find_elements bridge must preserve exact linked uniqueId lookups."
    Assert-True ($findHandlerCode -notmatch 'GetElement\(new ElementId\(id\)\)[\s\S]{0,200}linkDocument') "find_elements bridge must not apply host numeric element ids inside linked documents."
    Assert-True ($findHandlerCode -match 'WorksetTable table = document\.GetWorksetTable\(\)' -and $findHandlerCode -match 'if \(table == null\) return ""') "find_elements bridge must avoid exception-driven workset checks in non-workshared models."
    Assert-True ($searchPolicyCode -match 'preserveQueryWhenFullyStripped' -and $searchPolicyCode -match 'concept: "valve"') "Valve/vana search policy must preserve pure concept queries so fitting fallback cannot match by category alone."
    Assert-True ($discoveryCode -match 'AddValveAccessorySignal' -and $discoveryCode -match 'mepValveAccessoryCategory') "Element discovery must prioritize valve/vana Pipe Accessories category evidence."
    Assert-True ($commandSetRegistryCode -match '"commandName": "clear_selection"' -and $commandSetRegistryCode -match '"commandName": "delete_review_view"') "Commandset registry must expose clear_selection and delete_review_view."
    Assert-True ($clearSelectionToolCode -match 'LIVE_UI_SELECTION_CLEANUP' -and $clearSelectionHandlerCode -match 'SelectionCountBefore' -and $clearSelectionHandlerCode -match 'SetElementIds\(new List<ElementId>\(\)\)') "clear_selection must be a dedicated no-transaction selection cleanup tool."
    Assert-True ($deleteReviewViewToolCode -match 'REVIEW_VIEW_CLEANUP_GUARDED' -and $deleteReviewViewToolCode -match 'confirmDelete' -and $deleteReviewViewHandlerCode -match 'non_review_view_delete_blocked') "delete_review_view must default to guarded review-view cleanup with explicit confirmation."
    Assert-True ($deleteReviewViewHandlerCode -match 'mode=commit' -and $deleteReviewViewHandlerCode -match 'active_view_delete_blocked' -and $deleteReviewViewHandlerCode -match 'open_view_delete_blocked') "delete_review_view must guard active/open views and expose commit guidance."
    Assert-True ($deleteReviewViewHandlerCode -match 'CountPlacedViewports' -and $deleteReviewViewHandlerCode -match 'placed_review_view_delete_blocked') "delete_review_view must block deletion of sheet-placed review views."
    Assert-True ($deleteReviewViewHandlerCode -match 'ViewCommandHelpers\.GetReviewViewSignals') "delete_review_view must use the shared review-view recognition helper."
    Assert-True ($viewHelpersCode -match 'GetReviewViewSignals' -and $viewHelpersCode -match 'NormalizeReviewViewName' -and $viewHelpersCode -match 'revagent_review_view_name') "review-view recognition policy must be centralized and token-aware."
    Assert-True ($viewHelpersCode -match 'StartsWith\(" revagent "' -and $viewHelpersCode -match 'StartsWith\(" revit mcp "' -and $viewHelpersCode -notmatch 'StartsWith\(" dpe visual qa "') "Generic review-view token matching must not allow every DPE Visual QA view; only coordination/export-specific DPE names are cleanup candidates."
    Assert-True ($liveCommandsetTest -match 'revAgent_QA_DELETE_TEST_' -and $liveCommandsetTest -match 'delete_review_view recognizes create_3d_view_for_elements QA names') "Live commandset gate must cover cleanup of create_3d_view_for_elements revAgent_QA_* views."
    Assert-True ($showPlan3dToolCode.Contains('3D - Focus ${label} ${elementId}') -and -not $showPlan3dToolCode.Contains('3D - ${label} ${elementId}')) "show_element_in_plan_and_3d must default wrapper 3D views to cleanup-safe focus names."
    Assert-True ($viewHelpersCode -match 'StartsWith\("3D - Focus "' -and $viewHelpersCode -match 'default_focus_view_name') "delete_review_view must recognize default focus view names from workflow wrappers."
    Assert-True ($liveCommandsetTest -match '3D - Focus Element \$selectionTargetId DELETE_TEST_' -and $liveCommandsetTest -match 'delete_review_view recognizes show_element_in_plan_and_3d focus view names') "Live commandset gate must cover cleanup of show_element_in_plan_and_3d wrapper focus names."
    Assert-True ($searchPolicyCode -match 'riskLevel' -and $searchPolicyCode -match 'recommendedFirstScope' -and $searchPolicyCode -match 'requiresUserControl') "Search policy must expose risk level, first-scope recommendation, and user-control flag."
    Assert-True ($searchPolicyCode -match 'verified_visibility_expensive' -and $searchPolicyCode -match 'verified_visibility_requires_exact_targets_or_approval') "Search policy must require user control for broad verified plan visibility."
    Assert-True ($searchPolicyCode -match 'normalizeWithSourceIndex' -and $searchPolicyCode -match '\(\?<\!\[\\\\p\{L\}\\\\p\{N\}\]\)' -and $searchPolicyCode -match '\(\?!\[\\\\p\{L\}\\\\p\{N\}\]\)') "Search policy concept stripping must use index-aligned normalization and avoid stripping terms inside compact element tags."
    Assert-True ($discoveryCode -match 'ResolveBuiltInCategories') "Element discovery helper must map inferred MEP categories to BuiltInCategory filters."
    Assert-True ($discoveryCode -match 'queryTokens:all') "Element discovery helper must support token-aware matching for mixed queries like MTL fan coil."
    Assert-True ($discoveryCode -match 'verifyVisibility \? element : null') "metadata plan candidates must avoid expensive per-view element visibility checks."
    Assert-True ($discoveryCode -match 'deadlineUtc' -and $discoveryCode -match 'planCandidateBudgetStopped' -and $discoveryCode -match 'max_elapsed') "Verified plan candidate discovery must honor the Revit-side elapsed budget."
    Assert-True ($discoveryCode -match 'document == null \|\| element == null' -and $discoveryCode -match 'return new List<PlanCandidateSummary>\(\)') "Element discovery helpers must guard null documents before resolving levels or finding plan candidates."
    Assert-True ($focusHelpersCode -match 'document == null \|\| element == null \|\| view == null') "Element visibility checks must guard null document, element, and view inputs before collector access."
    Assert-True ($showPlan3dToolCode -match 'responseMode: z\.enum\(\["compact", "full"\]\)') "show_element_in_plan_and_3d must expose compact/full response modes."
    Assert-True ($showPlan3dToolCode -match 'responseMode: "compact"') "show_element_in_plan_and_3d must default successful responses to compact summaries."
    Assert-True ($showPlan3dToolCode -match 'action: "show_element_in_plan_and_3d"' -and $showPlan3dToolCode -match 'state:' -and $showPlan3dToolCode -match 'guarded') "show_element_in_plan_and_3d must expose the shared lowercase minimal response contract."
    Assert-True ($showPlan3dToolCode -match 'function isGuardedResult' -and $showPlan3dToolCode -match 'guarded: isGuardedResult\(planResult\)') "show_element_in_plan_and_3d must propagate guarded plan failures to the top-level contract."
    Assert-True ($showPlan3dToolCode -match 'readCasedField as readField') "show_element_in_plan_and_3d must read normalized bridge result fields case-insensitively."
    Assert-True ($showPlan3dToolCode -notmatch 'planResult\.Success === false') "show_element_in_plan_and_3d must not miss lower-case nested success=false values."
    Assert-True ($showPlan3dToolCode -notmatch 'threeDResult && threeDResult\.Success !== false') "show_element_in_plan_and_3d must compute 3D success from normalized result casing."
    Assert-True ($openPlanToolCode -match 'responseMode: z\.enum\(\["compact", "full"\]\)') "open_existing_plan_for_element_level must expose compact/full response modes."
    Assert-True ($openPlanToolCode -match 'function compactPlanResult') "open_existing_plan_for_element_level must compact successful routine responses."
    Assert-True ($openPlanToolCode -match 'readCasedField as readField') "open_existing_plan_for_element_level must read normalized bridge result fields case-insensitively."
    Assert-True ($openPlanToolCode -notmatch 'Success: payload\.Success') "open_existing_plan_for_element_level compact output must not miss lower-case success values."
    Assert-True ($openPlanToolCode -notmatch 'Element: compactElement\(payload\.ElementInfo\)') "open_existing_plan_for_element_level compact output must not miss lower-case elementInfo values."
    Assert-True ($openPlanToolCode -match 'ResponseMode: "compact"') "open_existing_plan_for_element_level compact response must identify its response mode."
    Assert-True ($openPlanToolCode -notmatch 'trimmedPayload && trimmedPayload\.Success === false') "open_existing_plan_for_element_level compact mode must stay compact for failure responses."
    Assert-True ($showPlan3dToolCode -match 'responseMode: "full"') "show_element_in_plan_and_3d must request the full nested plan result before building its own compact summary."
    Assert-True ($smartFocusToolCode -match 'responseMode: z\.enum\(\["compact", "full"\]\)') "smart_focus_elements must expose compact/full response modes."
    Assert-True ($smartFocusToolCode -match 'responseMode: "compact"') "smart_focus_elements must default successful responses to compact summaries."
    Assert-True ($smartFocusToolCode -match 'action: "smart_focus_elements"' -and $smartFocusToolCode -match 'state:' -and $smartFocusToolCode -match 'guarded') "smart_focus_elements must expose the shared lowercase minimal response contract."
    Assert-True ($smartFocusToolCode -match 'function isGuardedResult' -and $smartFocusToolCode -match 'guarded: isGuardedResult\(planFocus\)') "smart_focus_elements must propagate guarded fallback-plan failures to the top-level contract."
    Assert-True ($smartFocusToolCode -match 'function compactSmartFocusPayload') "smart_focus_elements must build a compact successful payload."
    Assert-True ($smartFocusToolCode -match 'activeOrRequestedViewThen3D') "smart_focus_elements must run the optional 3D step after active/requested focus when create3d=true."
    Assert-True ($smartFocusToolCode -match 'Smart focus optional 3D view after active/requested focus') "smart_focus_elements must name the post-active-focus 3D step clearly."
    Assert-True ($smartFocusToolCode -match 'readCasedField as readField') "smart_focus_elements must read normalized bridge result fields case-insensitively."
    Assert-True ($smartFocusToolCode -notmatch 'planFocus\.Success === false') "smart_focus_elements must not miss lower-case nested plan success=false values."
    Assert-True ($sessionContextToolCode -match 'apiProbeState') "Session context must move tool-probe modifiable state out of the document summary."
    Assert-True ($sessionContextToolCode -match 'documentIsModifiableDuringProbe') "Session context must label probe-time modifiable state clearly."
    Assert-True ($sessionContextToolCode -match 'detailLevel: z\.enum\(\["minimal", "counts", "full"\]\)') "Session context must expose minimal/counts/full detail levels."
    Assert-True ($sessionContextToolCode -match 'detailLevel \|\| "minimal"') "Session context must default to minimal detail for large-model document checks."
    Assert-True ($sessionContextToolCode -match 'linked room/space counts require detailLevel=full') "Session context must keep linked room/space scans explicit."
    Assert-True ($sessionContextToolCode -match 'GetElementCount\(\)' -and $sessionContextToolCode -notmatch 'ToElementIds\(\)\s*\.\s*Count') "Session context counts must use GetElementCount instead of allocating element id lists."
    Assert-True ($sessionContextToolCode -notmatch 'apiProbeState\s*=\s*new\s*\{\s*isModifiable\s*=') "Session context must not expose apiProbeState.isModifiable."
    Assert-True ($activeViewContextToolCode -match 'ScheduleSheetInstance') "Active sheet context must inspect placed schedule instances."
    Assert-True ($activeViewContextToolCode -match 'scheduleSheetInstances') "Active sheet context must expose scheduleSheetInstances."
    Assert-True ($activeViewContextToolCode -match 'includeSheetScheduleInstances') "Active sheet context must allow schedule instance collection to be disabled."
    Assert-True ($instanceListToolCode -match 'documentIsModifiableDuringProbe') "Instance list must label probe-time modifiable state clearly."
    Assert-True ($instanceListToolCode -notmatch 'apiProbeState\s*=\s*new\s*\{\s*isModifiable\s*=') "Instance list must not expose apiProbeState.isModifiable."
    Assert-True ($statusToolCode -match 'runtimeIdentity') "Status output must include runtime identity metadata."
    Assert-True ($statusToolCode -match 'packageJson\?\.name \|\| "revagent-runtime"') "Status runtime identity fallback must use the canonical revAgent runtime package name."
    Assert-True ($statusToolCode -match 'runtimeVersion') "Status output must include the active runtime version."
    Assert-True ($statusToolCode -match 'schemaVersion') "Status output must include the status/schema version."
    Assert-True ($statusToolCode -match 'toolSurfaceVersion') "Status output must include the registered tool surface version."
    Assert-True ($statusToolCode -match 'revit-mcp-runtime-tools\.45') "Runtime tool surface version must be bumped when exported tool behavior/schema changes."
    Assert-True ($statusToolCode -match 'processStartedAtUtc') "Status output must include the runtime process start time."
    Assert-True ($statusToolCode -match 'buildTimestampUtc') "Status output must include build/install timestamp metadata when available."
    Assert-True ($statusToolCode -match 'buildHash') "Status output must include the git build hash when encoded in the installed version."
    Assert-True ($statusToolCode -match 'readJsonFile' -and $runtimeIdentityCode -match 'replace\(/\^\\uFEFF/') "Status identity must tolerate PowerShell-written UTF-8 BOM JSON files through the shared runtime identity helper."
    Assert-True ($statusToolCode -match 'revit-mcp-status\.v3') "Status schema must be bumped when status field names change."
    Assert-True ($statusToolCode -match '\.max\(100\)') "Status tool must allow a longer recent history limit for full-test/debug runs."
    Assert-True ($toolHelpersCode -match 'recentHistoryCount') "Status compact payload must report recent history count instead of a misleading total."
    Assert-True ($toolHelpersCode -match 'recentLimit, 3, 0, 100') "Status compact payload must preserve up to 100 recent tasks when requested."
    Assert-True ($toolHelpersCode -notmatch 'clone\.recentTasksTotal =') "Status compact payload must not emit the legacy recentTasksTotal name."
    Assert-True ($toolHelpersCode -match 'BRIDGE_RESULT_CONTRACT_VERSION = 2') "Runtime formatter must know the normalized bridge result contract version."
    Assert-True ($toolHelpersCode -match 'getResultContractVersion') "Runtime formatter must read bridge capability from each response payload."
    Assert-True ($toolHelpersCode -match 'hasCanonicalBridgeResultContract\(parsed\)') "Runtime formatter must keep canonical bridge payload normalization idempotent."
    Assert-True ($toolHelpersCode -match 'export function readCasedField') "Runtime formatter helpers must expose one shared case-tolerant field reader."
    Assert-True ($toolHelpersCode -match 'normalizeSuccessCasing') "Runtime formatter must normalize response success casing."
    Assert-True ($toolHelpersCode -match '\["Success", "success"\]' -and $toolHelpersCode -match 'delete clone\[pascalName\]') "Runtime formatter must emit canonical lowercase contract fields instead of PascalCase duplicates."
    Assert-True ($toolHelpersCode -match 'key === "PlanCandidates" \|\| key === "planCandidates"') "Plan candidate trimming must handle canonical lower-case bridge payloads."
    Assert-True ($sendCodeToolCode -match 'parseJsonResult') "Raw send_code_to_revit must expose JSON-looking result parsing."
    Assert-True ($sendCodeToolCode -match 'normalizeRevitExecutionResponse\(response,\s*\{\s*parseResultStrings:\s*true\s*\}\)') "Raw send_code_to_revit must request JSON result-string parsing by default."
    Assert-True ($toolHelpersCode -match 'parseJsonLike\(parsed,\s*depth\s*\+\s*1\)') "Runtime formatter must parse double-encoded JSON-looking result strings."
    Assert-True ($sendCodeToolCode -match 'dynamic_snippet_type_declaration_not_supported') "Raw send_code_to_revit must guard C# type declarations before Revit compile time."
    Assert-True ($sendCodeToolCode -match 'Dynamic snippets are inserted inside Execute') "Raw send_code_to_revit guard must explain method-body snippet scope."
    Assert-True ($parameterSchemaToolCode -match 'duplicateDisplayNameWarnings') "Parameter schema inspection must report duplicate display-name warnings for write preflight."
    Assert-True ($parameterSchemaToolCode -match 'write_preflight_warning') "Duplicate parameter display names must be labeled as write-preflight risk."
    Assert-True ($setParameterToolCode -match 'PRODUCTION_PARAMETER_WRITE') "set_element_parameter must identify itself as a production parameter write tool."
    Assert-True ($setParameterToolCode -match 'duplicate_display_name_blocked') "set_element_parameter must block duplicate display-name matches."
    Assert-True ($setParameterToolCode -match 'read_only_parameter_blocked') "set_element_parameter must block read-only parameters."
    Assert-True ($setParameterToolCode -match 'mode: z\.enum\(\["dryRun", "commit"\]\)') "set_element_parameter must expose explicit dryRun/commit modes."
    Assert-True ($setParameterToolCode -match 'operation: z\.enum\(\["set", "clear", "clearVisibleValue"\]\)') "set_element_parameter must expose explicit set, true-clear, and visible-clear operations."
    Assert-True ($setParameterToolCode -match 'ClearValue') "set_element_parameter clear operation must use the Revit ClearValue API when supported."
    Assert-True ($setParameterToolCode -match 'clear_value_not_supported') "set_element_parameter must report unsupported no-value clear attempts explicitly."
    Assert-True ($setParameterToolCode -match 'visible_clear_requires_string_parameter' -and $setParameterToolCode -match 'clear_visible_value_sets_empty_string_and_does_not_restore_revit_has_value_false') "set_element_parameter visible clear must be explicit and must not claim HasValue=false restore."
    Assert-True ($setParameterToolCode -match 'noValueState' -and $setParameterToolCode -match 'visible_empty_has_value' -and $parameterSchemaToolCode -match 'clearability') "Parameter write/preflight tools must distinguish true no-value from visible empty string state."
    Assert-True ($setParameterToolCode -notmatch 'visibleEmptyFallback\s*=\s*"[^"\r\n]*value=\\?"\\?"') "set_element_parameter generated C# strings must not embed unescaped value=\"\" text."
    Assert-True ($setParameterToolCode -match 'dryRunWarnings\.Add\("empty_string_set_does_not_guarantee_revit_has_value_false_use_operation_clear_when_supported"\)') "set_element_parameter dry-runs must warn when an empty string set may leave HasValue=true."
    Assert-True ($setParameterToolCode -match 'transactionMode: mode === "commit" \? "auto" : "none"') "set_element_parameter dry-runs must execute without a transaction and commits must use the wrapper transaction."
    Assert-True ($setParameterToolCode -match 'ExpectedRawAfterSet') "set_element_parameter must calculate the expected readback value before commit."
    Assert-True ($setParameterToolCode -match 'verification') "set_element_parameter must report after-write verification."
    Assert-True ($setParameterToolCode -match 'expectedCurrentRaw') "set_element_parameter must support compare-and-set current-value guards."
    Assert-True ($setParameterToolCode -match 'type_parameter_write_requires_allowTypeParameterWrite') "set_element_parameter must require explicit approval for type parameter writes."
    Assert-True ($viewHelpersCode -match 'ActiveViewChanged') "View operation results must include active-view change state."
    Assert-True ($viewHelpersCode -match 'BeforeView') "View operation results must expose a stable before-view summary."
    Assert-True ($viewHelpersCode -match 'AfterView') "View operation results must expose a stable after-view summary."
    Assert-True ($viewHelpersCode -match 'PopulateViewTransition\(ElementFocusResult') "Element focus results must use the shared before/after active-view transition helper."
    Assert-True ($focusHandlerCode -match 'PopulateViewTransition\(result, _activeViewBefore, result\.ActiveView\)') "focus_elements must populate before/after active-view diagnostics on every response."
    Assert-True ($openPlanCode -match 'PopulateViewTransition\(result, _activeViewBefore, result\.ActiveView\)') "open_existing_plan_for_element_level must populate before/after active-view diagnostics on every response."
    Assert-True ($create3dHandlerCode -match 'PopulateViewTransition\(result, _activeViewBefore, result\.ActiveView\)') "create_3d_view_for_elements must populate before/after active-view diagnostics on every response."
    Assert-True ($sectionBoxHandlerCode -match 'PopulateViewTransition\(result, _activeViewBefore, result\.ActiveView\)') "section_box_elements must populate before/after active-view diagnostics on every response."
    Assert-True ($sectionBoxHandlerCode -match 'SectionBoxState = sectionBoxActive \? "active" : "inactive"') "section_box_elements must report the resulting section-box state."
    Assert-True ($sectionBoxHandlerCode -match 'SectionBoxNote = ElementFocusHelpers\.BuildSectionBoxNote\(true, sectionBoxActive, false\)') "section_box_elements must report the same section-box note semantics as 3D view creation."
    Assert-True ($inspectElementsToolCode -match 'connectorsIncluded = includeConnectors') "inspect_elements must report whether connector counting was requested."
    Assert-True ($inspectElementsToolCode -match 'int\? connectorCount = null') "inspect_elements must leave connectorCount null when connector counting is disabled."
    Assert-True ($inspectElementsToolCode -match 'int\? openConnectorCount = null') "inspect_elements must leave openConnectorCount null when connector counting is disabled."
    Assert-True ($inspectLevelsToolCode -match 'LEVEL_INSPECTION_READ_ONLY' -and $inspectLevelsToolCode -match 'sendRevitCommand\("inspect_levels"') "inspect_levels must be a read-only wrapper over the native inspect_levels command."
    Assert-True ($inspectLevelsToolCode -match 'normalizeBroadScanResult' -and $inspectLevelsToolCode -match 'partial/max_items' -and $inspectLevelsToolCode -match 'partial/read_failed') "inspect_levels must expose shared truncation and unavailable-source partial contracts."
    Assert-True ($inspectLevelsToolCode -match 'unavailableSourceCount\(payload\) > 0' -and $inspectLevelsToolCode -match 'return "read_failed"') "inspect_levels wrapper must normalize unavailable native sources to partial/read_failed even when legacy casing or fields vary."
    Assert-True ($inspectLevelsToolCode -match 'sourceScope' -and $inspectLevelsToolCode -match 'linkInstanceIds' -and $inspectLevelsToolCode -match 'linkInstanceUniqueIds' -and $inspectLevelsToolCode -match 'nameMatchMode' -and $inspectLevelsToolCode -match 'maxResults') "inspect_levels must expose source, exact-link, name-match, and deterministic result-cap controls."
    Assert-True ($inspectLevelsCommandCode -match 'CommandName[\s\S]+inspect_levels' -and $inspectLevelsCommandCode -match 'hostAndLinked' -and $inspectLevelsCommandCode -match 'linkedOnly' -and $inspectLevelsCommandCode -match 'hostOnly') "Native inspect_levels command must parse the complete sourceScope policy."
    Assert-True ($inspectLevelsHandlerCode -match 'OfClass\(typeof\(Level\)\)' -and $inspectLevelsHandlerCode -match 'RevitLinkInstance' -and $inspectLevelsHandlerCode -match 'MatchesLinkSelector') "Native inspect_levels must read host/linked Levels and apply exact link-instance selectors."
    Assert-True ($inspectLevelsHandlerCode -match 'string\.Equals\(name, _request\.NameQuery, StringComparison\.OrdinalIgnoreCase\)' -and $inspectLevelsHandlerCode -match 'IndexOf\(_request\.NameQuery, StringComparison\.OrdinalIgnoreCase\)') "Native inspect_levels must implement exact and contains Level-name matching deterministically."
    Assert-True ($inspectLevelsHandlerCode -match 'SpatialSnapshotHelpers\.GetProjectElevationFeet\(level\)' -and $inspectLevelsHandlerCode -match 'link\.GetTransform\(\)' -and $inspectLevelsHandlerCode -match 'OfPoint\(new XYZ\(0, 0, sourceProjectElevation\)\)' -and $inspectLevelsHandlerCode -match 'revit_link_instance_get_transform_source_origin_project_elevation_point') "Native inspect_levels must use the shared project-elevation resolver and derive linked hostElevationMm from the transformed source-origin point."
    Assert-True ($inspectLevelsHandlerCode -match 'ResolveDocumentIdentity\(sourceDocument\)' -and $inspectLevelsHandlerCode -match 'documentKey' -and $inspectLevelsHandlerCode -match 'documentSessionId' -and $inspectLevelsHandlerCode -match 'linkedSourceLevelSelector') "Native inspect_levels rows must expose source document identity and a copy-ready linked source-level selector."
    Assert-True ($inspectLevelsHandlerCode -match 'OrderBy\(row => row\.SourceSortOrder\)' -and $inspectLevelsHandlerCode -match 'ThenBy\(row => row\.SourceProjectElevationMm\)' -and $inspectLevelsHandlerCode -match 'Take\(_request\.MaxResults\)' -and $inspectLevelsHandlerCode -match 'truncated \? "max_items" : "completed"') "Native inspect_levels must apply maxResults only after deterministic sorting and report canonical max_items partial state."
    Assert-True ($inspectLevelsHandlerCode -match 'UnavailableSourceCount = unavailableSources\.Count' -and $inspectLevelsHandlerCode -match 'hasUnavailableSources \? "read_failed"' -and $inspectLevelsHandlerCode -match 'unloaded or inaccessible' -and $inspectLevelsHandlerCode -match 'Requested linkInstanceId was not found') "Native inspect_levels must mark missing, unloaded, or unreadable selected linked sources as partial/read_failed."
    Assert-True ($commandSetRegistryCode -match '"commandName": "inspect_levels"') "Command payload registry must include native inspect_levels."
    Assert-True ($inspectSheetTextToolCode -match 'SHEET_TEXT_INSPECTION_READ_ONLY') "inspect_sheet_text must identify itself as a read-only sheet text inspection tool."
    Assert-True ($inspectSheetTextToolCode -match 'normalizeBroadScanResult' -and $inspectSheetTextToolCode -match 'buildBroadScanGuardedResult') "inspect_sheet_text must use the shared broad-scan result contract."
    Assert-True ($inspectSheetTextToolCode -match 'maxTextNotesPerSheet') "inspect_sheet_text must bound text-note reads by sheet."
    Assert-True ($inspectSheetTextToolCode -match 'scanScheduleCells') "inspect_sheet_text must keep placed schedule cell scanning explicit."
    Assert-True ($inspectSheetTextToolCode -match 'includeViewportTextNotes' -and $inspectSheetTextToolCode -match 'includeViewportTags' -and $inspectSheetTextToolCode -match 'viewNameQuery') "inspect_sheet_text must expose viewport-linked text-note and tag inspection parameters."
    Assert-True ($inspectSheetTextToolCode -match 'maxTags' -and $inspectSheetTextToolCode -match 'maxViewports') "inspect_sheet_text must expose roadmap tag and viewport scan cap aliases."
    Assert-True ($inspectSheetTextToolCode -match 'maxResponseBytes' -and $inspectSheetTextToolCode -match 'scanStoppedReason=max_bytes') "inspect_sheet_text must expose a native response-size budget."
    Assert-True ($inspectSheetTextToolCode -match 'sendRevitCommand\("inspect_sheet_text"' -and $inspectSheetTextToolCode -notmatch 'executeRevitCode' -and $inspectSheetTextToolCode -notmatch 'buildInspectSheetTextCode') "inspect_sheet_text must call the native commandset path instead of generating dynamic C#."
    Assert-True ($inspectSheetTextToolCode -match 'allowExpensiveSearch' -and $inspectSheetTextToolCode -match 'reason: "needs_scope"') "inspect_sheet_text must guard project-wide broad scans without explicit approval."
    Assert-True ($inspectSheetTextToolCode -match 'generic send_code_to_revit') "inspect_sheet_text must steer agents away from broad custom C# sheet scans."
    Assert-True ($inspectSheetTextToolCode -match 'placed schedule text evidence' -and $inspectSheetTextToolCode -match 'set_schedule_cells_by_text') "inspect_sheet_text must route placed schedule evidence reads before accepted follow-up writes."
    Assert-True ($inspectSheetTextCommandCode -match 'CommandName[\s\S]+inspect_sheet_text' -and $inspectSheetTextCommandCode -match 'maxElapsedMs' -and $inspectSheetTextCommandCode -match 'timeoutMs - 1000') "inspect_sheet_text command must parse native elapsed budget below socket timeout."
    Assert-True ($inspectSheetTextHandlerCode -match 'ShouldGuardNeedsScope' -and $inspectSheetTextHandlerCode -match 'reason' -and $inspectSheetTextHandlerCode -match 'needs_scope') "inspect_sheet_text native handler must own broad-search guard policy."
    Assert-True ($inspectSheetTextHandlerCode -match 'DateTime deadlineUtc' -and $inspectSheetTextHandlerCode -match 'max_elapsed' -and $inspectSheetTextHandlerCode -match 'Partial' -and $inspectSheetTextHandlerCode -match 'ScanStoppedReason') "inspect_sheet_text native handler must enforce elapsed budgets and return partial metadata."
    Assert-True ($inspectSheetTextHandlerCode -match 'MaxResponseBytes' -and $inspectSheetTextHandlerCode -match 'max_bytes' -and $inspectSheetTextHandlerCode -match 'EstimatedResponseBytes') "inspect_sheet_text native handler must stop before oversized bridge responses."
    Assert-True ($inspectSheetTextHandlerCode -match 'AddRecordsIfWithinResponseBudget\(state, record, flat\)' -and $inspectSheetTextHandlerCode -match 'AddRecordsIfWithinResponseBudget\(state, cell, flat\)') "inspect_sheet_text must budget top-level match and inventory clones with their nested records."
    Assert-True ($annotationEvidenceHelpersCode -match 'IDictionary' -and $annotationEvidenceHelpersCode -match 'DictionaryEntry') "inspect_sheet_text response-size estimates must handle generic and non-generic dictionaries."
    Assert-True ($inspectSheetTextHandlerCode -match 'NormalizedTextQuery' -and $inspectSheetTextHandlerCode -match 'ContainsPreNormalized') "inspect_sheet_text must pre-normalize repeated query text before scan loops."
    Assert-True ($annotationEvidenceHelpersCode -match 'EstimateObjectBytes\(object value, AnnotationEvidenceByteEstimateKind kind\)' -and $inspectSheetTextHandlerCode -match 'AnnotationEvidenceByteEstimateKind\.SheetText' -and $inspectSchedulesHandlerCode -match 'AnnotationEvidenceByteEstimateKind\.Schedule') "sheet and schedule scans must share the annotation evidence byte estimator."
    Assert-True ($inspectSheetTextHandlerCode -match 'TableData tableData = schedule\.GetTableData\(\)' -and $inspectSheetTextHandlerCode -match 'Schedule body section data is not available') "inspect_sheet_text schedule cell scans must guard schedules without body section data."
    Assert-True ($inspectSheetTextHandlerCode -match '!hasExplicitIds && candidateCount > _request\.MaxSheets') "inspect_sheet_text must not truncate exact sheetIds with the broad maxSheets cap."
    Assert-True ($inspectSheetTextHandlerCode -match '!requestedIds\.Add\(id\)') "inspect_sheet_text must deduplicate exact sheetIds before Revit sheet lookup."
    Assert-True ($inspectSheetTextHandlerCode -match 'state\.ScannedTextNoteCount >= _request\.MaxTextNotesScanned[\s\S]+new FilteredElementCollector\(document, sheet\.Id\)' -and $inspectSheetTextHandlerCode -match 'state\.ScannedScheduleInstanceCount >= _request\.MaxScheduleInstancesScanned[\s\S]+new FilteredElementCollector\(document, sheet\.Id\)') "inspect_sheet_text must check global caps before expensive sheet collectors."
    Assert-True ($inspectSheetTextHandlerCode -match 'state\.ScannedScheduleCellCount >= _request\.MaxScheduleCellsScanned[\s\S]+BuildScheduleCellScan\(0, 0, true' -and $inspectSheetTextHandlerCode -match '!AddRecordIfWithinResponseBudget\(viewportRecord, state\)') "inspect_sheet_text must budget schedule-cell and viewport metadata scans before expensive work."
    Assert-True ($inspectSheetTextHandlerCode -match 'new FilteredElementCollector\(document, view\.Id\)' -and $inspectSheetTextHandlerCode -match 'viewportTextNote') "inspect_sheet_text native handler must scan viewport-linked view text notes."
    Assert-True ($inspectSheetTextHandlerCode -match 'IndependentTag' -and $inspectSheetTextHandlerCode -match 'TagText' -and $inspectSheetTextHandlerCode -match 'viewportTag') "inspect_sheet_text native handler must scan viewport-linked IndependentTag evidence."
    Assert-True ($inspectSheetTextHandlerCode -match 'IsViewValidForElementIteration' -and $inspectSheetTextHandlerCode -match 'view_not_valid_for_element_iteration' -and $inspectSheetTextHandlerCode -match 'Failed to scan viewport') "inspect_sheet_text native handler must skip viewport views that cannot be iterated instead of failing the full scan."
    Assert-True ($annotationEvidenceHelpersCode -match 'IsAnnotationElementVisibleInViewCrop' -and $annotationEvidenceHelpersCode -match 'GetAnnotationCropShape' -and $annotationEvidenceHelpersCode -match 'VIEWER_ANNOTATION_CROP_ACTIVE') "Viewport tag evidence must use a shared crop/annotation-crop visibility helper."
    Assert-True ($inspectSheetTextHandlerCode -match 'IsAnnotationElementVisibleInViewCrop\(view, tag' -and $countAnnotationsHandlerCode -match 'IsAnnotationElementVisibleInViewCrop\(view, tag') "Viewport tag evidence/count paths must filter tags against the placed view crop before returning rows."
    Assert-True ($inspectSheetTextHandlerCode -notmatch 'viewport_tags_deferred') "inspect_sheet_text must not regress viewport tags to the old deferred contract."
    Assert-True ($inspectSchedulesToolCode -match 'SCHEDULE_INSPECTION_READ_ONLY') "inspect_schedules must identify itself as a read-only schedule inspection tool."
    Assert-True ($inspectSchedulesToolCode -match 'normalizeBroadScanResult' -and $inspectSchedulesToolCode -match 'buildBroadScanGuardedResult') "inspect_schedules must use the shared broad-scan result contract."
    Assert-True ($inspectSchedulesToolCode -match 'sendRevitCommand\("inspect_schedules"') "inspect_schedules must route through the native commandset bridge."
    Assert-True ($commandSetRegistryCode -match '"commandName": "inspect_schedules"') "Command payload registry must include native inspect_schedules."
    Assert-True ($inspectSchedulesToolCode -match 'maxRowsPerSection') "inspect_schedules must bound schedule cell reads by row limit."
    Assert-True ($inspectSchedulesToolCode -match 'maxColumnsPerSection') "inspect_schedules must bound schedule cell reads by column limit."
    Assert-True ($inspectSchedulesToolCode -match 'maxElapsedMs' -and $inspectSchedulesToolCode -match 'maxCells' -and $inspectSchedulesToolCode -match 'maxResponseBytes') "inspect_schedules must expose elapsed, cell, and response-byte budgets."
    Assert-True ($inspectSchedulesToolCode -match 'startRow' -and $inspectSchedulesToolCode -match 'startColumn') "inspect_schedules must expose row/column continuation scope."
    Assert-True ($inspectSchedulesHandlerCode -match 'Stop\("max_elapsed"\)' -and $inspectSchedulesHandlerCode -match 'Stop\("max_cells"\)' -and $inspectSchedulesHandlerCode -match 'Stop\("max_bytes"\)') "Native inspect_schedules handler must own elapsed, cell, and byte stop reasons."
    Assert-True ($inspectSchedulesHandlerCode -match 'lastReadRow' -and $inspectSchedulesHandlerCode -match 'lastReadColumn') "Native inspect_schedules handler must expose schedule continuation position."
    Assert-True ($inspectSchedulesHandlerCode -notmatch 'schedule\.GetTableData\(\)\.GetSectionData') "Native inspect_schedules must not dereference schedule section data before checking for a missing section."
    Assert-True ($inspectSchedulesHandlerCode -match 'TableData tableData = schedule\.GetTableData\(\)' -and $inspectSchedulesHandlerCode -match 'if \(data != null\)' -and $inspectSchedulesHandlerCode -match 'sectionType != SectionType\.Footer') "Native inspect_schedules must treat only a missing footer as a normal empty section while preserving header/body failures."
    Assert-True ($annotationEvidenceHelpersCode -match 'BuildScheduleFieldRecords' -and $annotationEvidenceHelpersCode -match 'GetFieldOrder\(\)' -and $annotationEvidenceHelpersCode -match 'ColumnHeading' -and $annotationEvidenceHelpersCode -match 'GetName\(\)' -and $annotationEvidenceHelpersCode -match 'IsHidden') "Native inspect_schedules records must expose visible ViewSchedule field metadata for column-name mapping."
    Assert-True ($reconcileScheduleAdapterCode -match 'extractNativeFieldHeaderLabels' -and $reconcileScheduleAdapterCode -match 'readNativeResultArray\(schedule, "fields"\)' -and $reconcileScheduleAdapterCode -match 'readNativeResultField\(field, "columnHeading"\)') "Schedule reconciliation adapter must resolve string column mappings from native field metadata when table header cells are only schedule titles."
    Assert-True ($inspectSchedulesToolCode -match 'allowExpensiveSearch' -and $inspectSchedulesToolCode -match 'reason: "needs_scope"') "inspect_schedules must guard broad cell scans without explicit approval."
    Assert-True (($inspectSchedulesToolCode -match 'Cell scan is bounded') -or ($inspectSchedulesHandlerCode -match 'Cell scan is bounded')) "inspect_schedules must warn when broad cell scan is requested."
    Assert-True ($inspectSchedulesToolCode -match 'local TSV conversion' -and $inspectSchedulesToolCode -match 'Do not use raw C# only to dump schedule cells') "inspect_schedules must route schedule cell export/report needs through native reads and local conversion."
    Assert-True ($countAnnotationsToolCode -match 'ANNOTATION_COUNT_READ_ONLY') "count_annotations must identify itself as a read-only annotation count tool."
    Assert-True ($countAnnotationsToolCode -match 'sendRevitCommand\("count_annotations"') "count_annotations must call the native commandset bridge."
    Assert-True ($countAnnotationsToolCode -match 'normalizeBroadScanResult' -and $countAnnotationsToolCode -match 'readNativeResultArray\(payload, "evidenceRows"\)') "count_annotations must normalize native results through casing-robust ingest."
    Assert-True ($countAnnotationsToolCode -match 'invalid_count_mode_for_sources' -and $countAnnotationsToolCode -match 'uniqueTaggedElement') "count_annotations must enforce tag-count source semantics."
    Assert-True ($countAnnotationsToolCode -match 'maxRegexPatternLength' -and $countAnnotationsToolCode -match 'regexTimeoutMs') "count_annotations must expose bounded regex profile controls."
    Assert-True ($countAnnotationsToolCode -match 'viewport_text_notes' -and $countAnnotationsToolCode -match 'viewportTextNote') "count_annotations must expose viewport text-note source aliases and evidence source types."
    Assert-True ($countAnnotationsToolCode -match 'placed_schedule_cells' -and $countAnnotationsToolCode -match 'placed_schedule_cell' -and $countAnnotationsToolCode -match 'schedule_cells' -and $countAnnotationsToolCode -match 'schedule_cell' -and $countAnnotationsToolCode -match 'maxScheduleCellsScanned') "count_annotations must expose placed schedule-cell source aliases and cell scan caps."
    Assert-True ($countAnnotationsToolCode -match 'placedScheduleCell') "count_annotations wrapper must normalize placed schedule-cell evidence source types."
    Assert-True ($countAnnotationsHandlerCode -match 'Failed to scan viewport' -and $countAnnotationsHandlerCode -match 'new FilteredElementCollector\(document, view\.Id\)') "count_annotations viewport annotation scans must isolate per-viewport scan failures instead of failing the full command."
    Assert-True ($countAnnotationsHandlerCode -match 'ScanViewportAnnotations' -and $countAnnotationsHandlerCode -match 'viewportTextNote' -and $countAnnotationsHandlerCode -match 'viewport_text_note') "count_annotations native handler must scan viewport text-note evidence."
    Assert-True ($countAnnotationsHandlerCode -match 'ScanPlacedScheduleCells' -and $countAnnotationsHandlerCode -match 'BuildPlacedScheduleCellEvidenceRow' -and $countAnnotationsHandlerCode -match 'Stop\("max_cells"\)' -and $countAnnotationsHandlerCode -match 'Stop\("max_rows"\)' -and $countAnnotationsHandlerCode -match 'Stop\("max_columns"\)') "count_annotations native handler must scan placed schedule cells with shared evidence helpers and canonical row/column/cell caps."
    Assert-True ($countAnnotationsHandlerCode -match 'Failed to scan text notes on sheet') "count_annotations sheet text-note scans must isolate per-sheet failures with a warning."
    Assert-True ($countAnnotationsHandlerCode -match 'SheetIds\.Distinct\(\)' -and $countAnnotationsHandlerCode -match 'sheet == null \|\| sheet\.IsTemplate') "count_annotations must deduplicate exact sheetIds and skip template sheets before scanning."
    Assert-True ($commandSetRegistryCode -match '"commandName": "count_annotations"') "Command payload registry must include native count_annotations."
    foreach ($reason in @("completed", "max_elapsed", "max_rows", "max_columns", "max_cells", "max_items", "max_bytes", "read_failed", "needs_scope")) {
        Assert-True ($broadScanResultCode -match [regex]::Escape('"' + $reason + '"')) "Shared broad-scan result contract is missing stop reason '$reason'."
    }
    foreach ($field in @("summary", "evidenceRows", "lastReadSection", "lastReadRow", "lastReadColumn", "lastReadSheetId", "lastReadViewId", "lastReadViewportId", "lastReadItemId")) {
        Assert-True ($broadScanResultCode -match [regex]::Escape('"' + $field + '"')) "Shared broad-scan result contract is missing field '$field'."
    }
    Assert-True ($setScheduleCellsToolCode -match 'PRODUCTION_SCHEDULE_CELL_WRITE') "set_schedule_cells must identify itself as a production schedule-cell write tool."
    Assert-True ($setScheduleCellsToolCode -match 'Defaults to dryRun') "set_schedule_cells must default to dry-run behavior."
    Assert-True ($setScheduleCellsToolCode -match 'expectedCurrentText') "set_schedule_cells must support expected current value preflight."
    Assert-True ($setScheduleCellsToolCode -match 'transactionMode: mode === "commit" \? "auto" : "none"') "set_schedule_cells must use auto transactions only for commit mode."
    Assert-True ($setScheduleCellsToolCode -match 'non_writable_standard_body_cell') "set_schedule_cells dry-run must guard non-writable standard schedule body cells before commit."
    Assert-True ($setScheduleCellsToolCode -match 'Schedule cell text writes are not a raw-code reason' -and $setScheduleCellsToolCode -match 'Do not use this for visual schedule formatting') "set_schedule_cells must steer exact schedule text writes away from raw code while excluding formatting workflows."
    Assert-True ($setScheduleCellsToolCode -match 'IsStandardScheduleBodyCellWriteForbidden' -and $setScheduleCellsToolCode -match 'IsKeySchedule') "set_schedule_cells must distinguish standard body cells from writable key schedule/header/footer cells."
    Assert-True ($setScheduleCellsToolCode -match 'bool standardScheduleBodyCellWriteForbidden = IsStandardScheduleBodyCellWriteForbidden\(schedule, sectionType\);') "set_schedule_cells must compute the standard body-cell guard once per schedule section."
    Assert-True ($setScheduleCellsToolCode -match 'if \(!dryRun\)') "set_schedule_cells commit exceptions must escape the snippet so the wrapper transaction can roll back."
    Assert-True ($setScheduleCellsByTextToolCode -match 'PRODUCTION_SCHEDULE_CELL_WRITE_BY_TEXT') "set_schedule_cells_by_text must identify itself as a production schedule row-text write tool."
    Assert-True ($setScheduleCellsByTextToolCode -match 'rowTextQuery') "set_schedule_cells_by_text must require bounded row text matching."
    Assert-True ($setScheduleCellsByTextToolCode -match 'allowMultipleMatches') "set_schedule_cells_by_text must block ambiguous multi-row writes by default."
    Assert-True ($setScheduleCellsByTextToolCode -match 'expectedCurrentText') "set_schedule_cells_by_text must support compare-and-set target cell protection."
    Assert-True ($setScheduleCellsByTextToolCode -match 'transactionMode: mode === "commit" \? "auto" : "none"') "set_schedule_cells_by_text must use auto transactions only for commit mode."
    Assert-True ($setScheduleCellsByTextToolCode -match 'non_writable_standard_body_cell') "set_schedule_cells_by_text dry-run must guard non-writable standard schedule body cells before commit."
    Assert-True ($setScheduleCellsByTextToolCode -match 'IsStandardScheduleBodyCellWriteForbidden' -and $setScheduleCellsByTextToolCode -match 'IsKeySchedule') "set_schedule_cells_by_text must distinguish standard body cells from writable key schedule/header/footer cells."
    Assert-True ($setScheduleCellsByTextToolCode -match 'bool standardScheduleBodyCellWriteForbidden = IsStandardScheduleBodyCellWriteForbidden\(schedule, sectionType\);') "set_schedule_cells_by_text must compute the standard body-cell guard once per schedule."
    Assert-True ($setScheduleCellsByTextToolCode -match 'generic send_code_to_revit') "set_schedule_cells_by_text tool description must steer agents away from raw schedule write snippets."
    Assert-True ($setScheduleCellsByTextToolCode -match 'Schedule cell text writes are not a raw-code reason' -and $setScheduleCellsByTextToolCode -match 'visible row text, item code, equipment tag, or schedule line label') "set_schedule_cells_by_text must steer row-text schedule writes away from raw code."
    Assert-True ($safeCodeGuardsCode -match 'Schedule\.SetCellText') "send_code_to_revit_safe write guards must detect schedule cell text writes."
    $activateViewHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\ActivateViewEventHandler.cs")
    $viewCommandHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\ViewCommandHelpers.cs")
    Assert-True ($activateViewHandlerCode -match 'Changed = true,\s+ActiveViewChanged = true') "activate_view must mark ActiveViewChanged when it successfully changes the active view."
    Assert-True ($viewCommandHelpersCode -match 'public bool\? DryRun' -and $viewCommandHelpersCode -match 'public bool\? Deleted' -and $viewCommandHelpersCode -match 'NullValueHandling = NullValueHandling.Ignore') "Navigation view results must not leak cleanup-only delete_review_view fields."
    Assert-True ($closeViewCode -match 'Changed = closed \|\| activeViewChanged') "close_view must mark Changed when a view is closed or active view changes."
    Assert-True ($viewImageToolCode -match 'enforcePixelSize') "View image export must expose enforcePixelSize."
    Assert-True ($viewImageToolCode -match 'resizeImageToRequestedPixelSize') "View image export must normalize exported image dimensions after Revit export."
    Assert-True ($viewImageToolCode -match 'finalPixelSizeMatchesRequest') "View image export must explicitly report whether the final image dimension matches the request."
    Assert-True ($viewImageToolCode -notmatch 'selectedView is ViewSheet') "View image export must allow DrawingSheet exports."
    Assert-True ($viewImageToolCode -match 'allowTemporaryScheduleSheet') "View image export must expose controlled direct Schedule export through a temporary sheet."
    Assert-True ($viewImageToolCode -match 'ViewSheet\.Create') "View image export must create a temporary sheet for direct Schedule export."
    Assert-True ($viewImageToolCode -match 'ScheduleSheetInstance\.Create') "View image export must place the Schedule on the temporary export sheet."
    Assert-True ($viewImageToolCode -match 'temporaryScheduleSheetDeletedBeforeCommit') "View image export must report whether temporary Schedule sheet cleanup was confirmed."
    Assert-True ($viewImageToolCode -match 'placedOnSheets') "Schedule export output should include sheets that already contain the schedule when available."
    Assert-True ($safeCodeToolCode -match 'formatSafetyBlock') "Safe dynamic execution wrapper must classify expected write rejections as guarded safety blocks."
    Assert-True ($safeCodeToolCode -match 'safe_wrapper_rejected_write_looking_code') "Safe dynamic execution wrapper must expose a stable safety reason for write-looking snippets."
    Assert-True ($telemetryCode -match 'normalizeMachineName') "Telemetry must normalize machine names before building NAS event paths."
    Assert-True ($telemetryCode -match 'REVAGENT_TELEMETRY_CODE_CHARS') "Telemetry must capture bounded code previews for semantic usage analysis."
    Assert-True ($telemetryCode -match 'production\.context') "Telemetry must emit production-context events for dashboard/master-LLM analysis."
    Assert-True ($telemetryCode -match 'REVAGENT_TELEMETRY_CONTEXT_ELEMENTS') "Telemetry must bound production-context element samples."
    Assert-True ($telemetryCode -match 'disciplineHint') "Production context must include a discipline hint for office workload analysis."
    Assert-True ($telemetryCode -match 'rejected write-looking code') "Telemetry must classify safe-wrapper write rejections as guarded outcomes."
    Assert-True ($telemetryCode -match 'revagent\.live\.status\.v1') "Telemetry must write live dashboard status snapshots."
    Assert-True ($telemetryCode -match 'revagent\.live\.activity\.v1') "Telemetry must write live dashboard activity events."
    Assert-True ($telemetryCode -match 'REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT') "Live dashboard writes must have a bounded in-flight limit."
    Assert-True ($telemetryCode -match 'recordLiveActivityStarted') "Live dashboard feed must record started activity."
    Assert-True ($telemetryCode -match 'recordLiveActivityFinished') "Live dashboard feed must record completed/guarded/failed activity."
    Assert-True ($toolHelpersCode -match 'recordLiveActivityStarted') "Revit command helpers must publish live activity starts."
    Assert-True ($toolHelpersCode -match 'recordLiveActivityFinished') "Revit command helpers must publish live activity finishes."
    Assert-True ($apiDocsIndexCode -match 'getMemberNameAliases') "API docs resolver must support common Revit member aliases."
    Assert-True ($apiDocsIndexCode -match 'revit_xml_docs_parameter_indexer_property') "API docs resolver must alias get_Parameter(...) to the Element.Parameter XML docs property."
    Assert-True ($create3dToolCode -match 'LIVE_VIEW_NAVIGATION_PRIMITIVE') "create_3d_view_for_elements must identify itself as the live 3D navigation primitive."
    Assert-True ($showPlan3dToolCode -match 'LIVE_VIEW_WORKFLOW_WRAPPER') "show_element_in_plan_and_3d must identify itself as the live plan+3D workflow wrapper."
    Assert-True ($coordinationImageToolCode -match 'VISUAL_ARTIFACT_EXPORT_ONLY') "Coordination image export must identify itself as an image artifact export tool."
    Assert-True ($coordinationImageToolCode -match 'allowFullViewFallback') "Coordination image export must require explicit full-view fallback when requested element ids are all missing."
    Assert-True ($coordinationImageToolCode -match 'no_requested_elements_found') "Coordination image export must return a stable guard reason when no requested elements are found."
    Assert-True ($coordinationImageToolCode -match 'requestedElementIds\.Count > 0 && targetElements\.Count == 0 && !allowFullViewFallback') "Coordination image export must guard missing requested element ids before full-view export."
    Assert-True ($coordinationImageToolCode -match 'parseElementIds') "Coordination image export must validate supplied elementIds before C# list generation."
    Assert-True ($coordinationImageToolCode -match 'invalid_element_ids') "Coordination image export must guard non-numeric supplied elementIds instead of silently exporting full view evidence."
    Assert-True ($coordinationImageToolCode -match 'Number\.isSafeInteger\(value\)') "Coordination image export must reject unsafe numeric element ids before C# list generation."
    Assert-True ($coordinationImageToolCode -match 'createdViews') "Coordination image export must report created review views for cleanup/audit."
    Assert-True ($coordinationImageToolCode -match 'cleanupAfterExport: z\.boolean') "Coordination image export must expose a user-controlled cleanupAfterExport parameter."
    Assert-True ($coordinationImageToolCode -match 'cleanupAfterExportRequested') "Coordination image export must report whether cleanupAfterExport was requested."
    Assert-True ($coordinationImageToolCode -match 'cleanupAfterExportApplied') "Coordination image export must report cleanup behavior explicitly."
    Assert-True ($coordinationImageToolCode -match 'deletedAfterExport') "Coordination image export must report whether a created review view was deleted after export."
    Assert-True ($coordinationImageToolCode -match 'documentMayRemainModified') "Coordination image export must report that cleanup is not a fully trace-free Revit dirty-flag mode."
    Assert-True ($coordinationImageToolCode -match 'persistentPhysicalElementChanges = false') "Coordination image export must report that it does not change physical MEP elements."
    Assert-True ($coordinationImageToolCode -match 'Do not use this as the primary tool for live view navigation') "Coordination image export must warn against live view navigation use."
    Assert-True ($coordinationImageToolCode -match 'targetVisualStyle') "Coordination image export must expose target visual style profiles."
    Assert-True ($coordinationImageToolCode -match 'resolveAutoTargetVisualStyle') "Coordination image export must resolve auto target visual style explicitly."
    Assert-True ($coordinationImageToolCode -match '(?s)intent === "coordination_overlay".*return "outline_only"') "Coordination image export auto style must not default coordination overlays to high-contrast QA."
    Assert-True ($coordinationImageToolCode -match '(?s)intent === "raw_evidence".*return "raw"') "Coordination image export auto style must keep raw evidence unhighlighted."
    Assert-True ($coordinationImageToolCode -match '(?s)intent === "system_focus".*return "technical_report"') "Coordination image export auto style must map system focus to technical report styling."
    Assert-True ($coordinationImageToolCode -match '(?s)intent === "clash_clearance".*return "technical_report"') "Coordination image export auto style must map clash clearance to technical report styling."
    Assert-True ($coordinationImageToolCode -match 'qa_high_contrast is used only when explicitly requested') "Coordination image export must keep high-contrast QA styling explicit-only."
    Assert-True ($coordinationImageToolCode -match 'isQaHighContrast \? 12 : 1') "Coordination image export must preserve thick QA linework only in high-contrast mode."
    Assert-True ($coordinationImageToolCode -match 'technical_report') "Coordination image export must support a softer technical-report target style."
    Assert-True ($coordinationImageToolCode -match 'outline_only') "Coordination image export must support outline-only target highlighting."
    Assert-True ($coordinationImageToolCode -match '\"raw\"') "Coordination image export must support raw target style with no target override."
    Assert-True ($coordinationImageToolCode -match 'targetOverrideApplied') "Coordination image export must report whether a target override was applied."
    Assert-True ($coordinationImageToolCode -match 'targetOverrideResetCount') "Coordination image export must clear stale target element overrides before applying the requested style."
    Assert-True ($coordinationImageToolCode -match 'isOutlineOnly \? 100 : 85') "Coordination image export must make outline-only target surfaces transparent and report surfaces highly transparent."
    Assert-True ($coordinationImageToolCode -match 'singleElementMarginMm') "Coordination image export must expose a tighter single-element margin."
    Assert-True ($coordinationImageToolCode -match 'preExportPixelSize') "Coordination image export must separate Revit source export resolution from final image size."
    Assert-True ($coordinationImageToolCode -match 'maxAutoPreExportPixelSize') "Coordination image export must cap automatic high-resolution source exports."
    Assert-True ($coordinationImageToolCode -match 'allowFinalUpscale') "Coordination image export must let callers control whether tiny source crops may be enlarged to the final image size."
    Assert-True ($coordinationImageToolCode -match 'width = width') "Coordination image export files must report width."
    Assert-True ($coordinationImageToolCode -match 'height = height') "Coordination image export files must report height."
    Assert-True ($coordinationImageToolCode -match 'resizeImageToRequestedPixelSize') "Coordination image export must normalize exported image dimensions after Revit export."
    Assert-True ($coordinationImageToolCode -match 'SetOrientation\(new ViewOrientation3D') "Coordination image export must frame the 3D camera to the target section box."
    Assert-True ($coordinationImageToolCode -match 'cameraFramedToTargets') "Coordination image export must report whether target camera framing was applied."
    Assert-True ($coordinationImageToolCode -match 'analyzeCoordinationImageQuality') "Coordination image export raster work must be a QA analysis step, not the primary framing mechanism."
    Assert-True ($coordinationImageToolCode -match 'targetMinFillRatio') "Coordination image export must expose a minimum target fill ratio for model-bbox projection crops."
    Assert-True ($coordinationImageToolCode -match 'actualHighlightFillRatio') "Coordination image export must report actual target-highlight fill only as a raster QA metric."
    Assert-True ($coordinationImageToolCode -match 'applySurfaceFill') "Coordination image export must limit surface fill to visual styles that request it."
    Assert-True ($coordinationImageToolCode -match 'surfaceTransparency = isQaHighContrast \? 1') "Coordination image export must preserve opaque QA highlighting only in high-contrast mode."
    Assert-True ($coordinationImageToolCode -match 'g >= 105') "Coordination image export must tolerate anti-aliased green target pixels."
    Assert-True ($coordinationImageToolCode -match 'isTargetYellow') "Coordination image export must detect non-green/yellow Revit target highlight output."
    Assert-True ($coordinationImageToolCode -match 'isTargetHighChroma') "Coordination image export must detect high-chroma Revit target highlight output when exact override colors drift."
    Assert-True ($coordinationImageToolCode -match 'model_bbox_projection') "Coordination image export must use model_bbox_projection as the primary single-target crop basis."
    Assert-True ($coordinationImageToolCode -match 'inverseCropTransform') "Coordination image export must map target model bounding boxes through the Revit view crop transform."
    Assert-True ($coordinationImageToolCode -match 'modelCropBoxApplied') "Coordination image export must report when the Revit 3D view crop box was tightened from model geometry."
    Assert-True ($coordinationImageToolCode -match 'reviewView\.CropBox = tightenedCrop') "Coordination image export must tighten the Revit view crop box before raster export for single-target model crops."
    Assert-True ($coordinationImageToolCode -match 'coordination_model_crop_box_tighten_failed') "Coordination image export must warn if model crop-box tightening fails."
    Assert-True ($coordinationImageToolCode -match 'target_highlight_pixels_not_detected') "Coordination image export must warn, not fail, when highlighted target pixels are not detected."
    Assert-True ($coordinationImageToolCode -match 'target_highlight_pixels_not_detected_visual_style_expected') "Coordination image export must report missing highlight pixels in raw/outline styles as an expected notice."
    Assert-True ($coordinationImageToolCode -match 'notices = notices') "Coordination image export must return notice-level diagnostics separately from warnings."
    Assert-True ($coordinationImageToolCode -match 'croppedToModelProjection') "Coordination image export must report whether model-projection framing was used."
    Assert-True ($coordinationImageToolCode -match 'postProcessedCropApplied') "Coordination image export must explicitly report post-process crop use."
    Assert-True ($coordinationImageToolCode -match 'rasterPostCropApplied') "Coordination image export must explicitly report raster-highlight fallback crop use."
    Assert-True ($coordinationImageToolCode -match 'cropBasis') "Coordination image export must report whether crop came from model projection or highlight pixels."
    Assert-True ($coordinationImageToolCode -match 'estimatedTargetFillRatio') "Coordination image export must expose model-estimated target fill separately from actual highlight fill."
    Assert-True ($coordinationImageToolCode -match '0\.04 / safeFillRatio') "Coordination image export model-bbox crop must use a tight center crop guard when target pixels cannot be measured."
    Assert-True ($coordinationImageToolCode -match 'IgnoreImageCache') "Coordination image export must bypass WPF URI caching so resize uses the cropped image, not the original wide export."
    Assert-True ($coordinationImageToolCode -notmatch 'bbox_center_fallback') "Coordination image export must no longer describe model-bbox projection as a fallback crop."
    Assert-True ($coordinationImageToolCode -match 'highlightCropPaddingPx: z\.number\(\)\.int\(\)\.min\(0\)\.max\(2000\)\.optional\(\)\.default\(24\)') "Coordination image export must use tight default highlight padding so small targets do not stay tiny."
    Assert-True ($coordinationImageToolCode -match 'model_bbox_projection_post_crop') "Coordination image export must keep model-projection post-crop only as a fallback path."
    Assert-True ($coordinationImageToolCode -match 'highlight_pixels_post_crop_fallback') "Coordination image export must keep raster-highlight cropping only as a fallback path."
    Assert-True ($coordinationImageToolCode -match 'projectionDesiredSide') "Coordination image export fallback crops must size model-projection crops from targetMinFillRatio."
    Assert-True ($coordinationImageToolCode -match 'auto_model_bbox_projection_source_resolution') "Coordination image export must automatically raise source export resolution before model-projection crop."
    Assert-True ($coordinationImageToolCode -match 'options\.PixelSize = revitExportPixelSize') "Coordination image export must use the pre-export resolution for Revit ExportImage."
    Assert-True ($coordinationImageToolCode -match 'image_source_crop_below_final_pixel_size') "Coordination image export must warn when a crop source is upscaled to final pixel size."
    Assert-True ($coordinationImageToolCode -match 'target_fill_limited_by_source_resolution') "Coordination image export must warn when it preserves source quality by widening the crop below the requested target fill ratio."
    Assert-True ($coordinationImageToolCode -match 'default\(10000\)') "Coordination image export automatic pre-export resolution must use a conservative default Revit source cap."
    Assert-True ($coordinationImageToolCode -match 'croppedToTargetHighlight') "Coordination image export must report target-highlight crop results."
    Assert-True ($parameterSchemaToolCode -match 'rawBuiltInParameterAlias') "Parameter schema output must keep raw Revit enum aliases as diagnostic data."
    Assert-True ($openPlanCode -match 'FirstOrDefault\(c => c\.ElementVisibleInView == true\)') "open_existing_plan_for_element_level must select only plans containing the element."
    Assert-True ($openPlanCode -match 'TryUseActivePlanWithoutCandidateScan') "open_existing_plan_for_element_level must short-circuit when the active plan already matches the element level."
    Assert-True ($openPlanCode -match 'active plan already matched element level') "open_existing_plan_for_element_level fast path must report the active-plan selection reason."
    Assert-True ($discoveryCode -match 'ElementVisibleInView') "Plan candidates must carry element-in-view diagnostics."
    Assert-True ($focusHelpersCode -match 'FocusWarning') "Focus results must expose active-view mismatch diagnostics."

    Write-Host "Test updater version status distinguishes update from restore"
    $versionStatusRoot = Join-Path $tempRoot "version-status"
    $versionWorkRoot = Join-Path $versionStatusRoot "updater"
    New-Item -ItemType Directory -Path $versionWorkRoot -Force | Out-Null
    $channelPath = Join-Path $versionStatusRoot "stable.json"
    $configPath = Join-Path $versionWorkRoot "updater-config.json"
    Write-RevAgentJsonFile -Path (Join-Path $versionWorkRoot "installed.json") -Value ([ordered]@{
            version = "2026.05.22.localtest-abc"
        })
    Write-RevAgentJsonFile -Path $configPath -Value ([ordered]@{
            installRoot = $versionStatusRoot
            workRoot = $versionWorkRoot
            channelManifestPath = $channelPath
        })
    Write-RevAgentJsonFile -Path $channelPath -Value ([ordered]@{
            app = "revit-mcp-skill"
            channel = "stable"
            version = "2026.05.15.1259-b397869c"
        })
    $versionOutput = & (Join-Path $RepoRoot "installer\nas\show-installed-version.ps1") -ConfigPath $configPath 2>&1 6>&1 | Out-String
    Assert-True ($versionOutput -match 'install/repair available') "Newer local/dev install should be reported as install/repair available against an older release target."
    Assert-True ($versionOutput -match 'revAgent status') "Version status window must use the revAgent product name."
    Assert-True ($versionOutput -notmatch 'Revit MCP version status|Install root|Manual update|Config\s+:|Stable|Channel\s+:|Channel version') "Default version status must not expose internal product, path details, or legacy channel wording."

    Write-RevAgentJsonFile -Path $channelPath -Value ([ordered]@{
            app = "revit-mcp-skill"
            channel = "stable"
            version = "2026.05.23.1000-next"
        })
    $versionOutput = & (Join-Path $RepoRoot "installer\nas\show-installed-version.ps1") -ConfigPath $configPath 2>&1 6>&1 | Out-String
    Assert-True ($versionOutput -match 'update available') "Older install should be reported as update available against a newer release target."

    Write-Host "Test release version identity"
    $publishText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1")
    Assert-True ($publishText -match 'rev-list", "--count", "HEAD"') "Default release version must use a monotonically increasing git build number."
    Assert-True ($publishText -notmatch 'yyyy\.MM\.dd\.HHmm') "Default release version must not use local wall-clock minutes as the version identity."
    Assert-True ($publishText -match 'function Copy-RevAgentUserPack') "Publish must build an allowlisted user pack instead of copying the repo root."
    Assert-True ($publishText -match 'installer\\codex-user\\SKILL\.md') "Publish must use the user orchestration SKILL.md."
    Assert-True ($publishText -match 'Copy-UserPackFile -SourceRelativePath "CHANGELOG\.md"' -and $publishText -match 'changelog = "CHANGELOG\.md"') "User pack must include the changelog and hash it in the release manifest."
    Assert-True ($publishText -match 'update-from-nas\.ps1' -and $publishText -match 'show-installed-version\.ps1' -and $publishText -match 'install-updater-task\.ps1') "User pack must include only workstation updater entrypoints from installer\\nas."
    Assert-True ($publishText -match 'Install-revAgent-Updater-GUI\.ps1' -and $nasToolsRefreshText -notmatch '\.cmd') "NAS tools must publish the signed PowerShell GUI surface without any unsigned CMD launcher alias."
    Assert-True ($publishText -match 'scripts\\publish-desktop-launcher-evidence\.ps1' -and $publishText -match 'toolsRoot "publish-desktop-launcher-evidence\.ps1"') "NAS tools must publish the desktop launcher evidence helper for rollout closure."
    Assert-True ($publishText -match 'scripts\\collect-rollout-evidence\.ps1' -and $publishText -match 'toolsRoot "collect-rollout-evidence\.ps1"') "NAS tools must publish the SSH rollout evidence collector for rollout closure."
    Assert-True ($publishText -match 'scripts\\invoke-live-smoke-over-ssh\.ps1' -and $publishText -match 'toolsRoot "invoke-live-smoke-over-ssh\.ps1"') "NAS tools must publish the SSH live smoke runner for representative Revit tests."
    Assert-True ($publishText -match 'scripts\\test-commandset-live\.ps1' -and $publishText -match 'toolsRoot "test-commandset-live\.ps1"') "NAS tools must publish the live smoke evidence helper for rollout closure."
    Assert-True ($publishText -match 'Copy-UserPackReleaseMcpPackage -SourceRelativePath "installer\\runtime-mcp-server"' -and $publishText -match 'Copy-UserPackReleaseMcpPackage -SourceRelativePath "installer\\revit-api-docs-mcp"') "User pack must use hardened MCP release bundles instead of developer build trees."
    Assert-True ($publishText -match '\$releaseSchemasPath' -and $publishText -match '\$destinationSchemasPath' -and $publishText -match 'missing published spatial schema') "Source-free runtime packaging must copy and verify every published spatial schema version."
    Assert-True ($publishText -match 'Assert-RevAgentUserPackNoSourceLeak -Root \$packageRoot') "Publish must gate the user pack against source/developer artifact leaks."
    Assert-True ($publishText -match '"addons"') "Publish source-leak gate must block admin add-on payloads from the workstation user pack."
    Assert-True ($publishText -match 'Assert-RevAgentUserPackDotNetPayloadHardened -Root \$packageRoot') "Publish must gate the user pack against .NET debug symbol artifacts."
    Assert-True ($publishText -match 'Assert-RevAgentUserPackHardenedJsPayload -Root \$packageRoot') "Publish must gate the user pack against unhardened JavaScript payloads."
    Assert-True ($publishText -match 'runtimeBundle = "installer\\runtime-mcp-server\\build\\index\.js"' -and $publishText -match 'docsServerBundle = "installer\\revit-api-docs-mcp\\build\\index\.js"') "Release manifest must hash hardened JavaScript bundle entrypoints."
    Assert-True ($publishText -match 'Get-RevAgentUserPackPathParts' -and $publishText -match 'Test-RevAgentUserPackIgnoredDependencyPath') "Publish source-leak gate must use path-component dependency exclusions."
    Assert-True ($publishText -notmatch 'Copy-DirectoryFiltered -Source \$RepoRoot -Destination \$packageRoot') "Publish must not stage releases by copying the repo root."
    Assert-True ($publishText -notmatch 'Copy-UserPackDirectory -SourceRelativePath "installer\\nas"') "Versioned user pack must not copy deployment tooling wholesale."
    Assert-True ($publishText -match 'Copy-RevAgentAdminAddonTools' -and $publishText -match 'toolsRoot "addons"') "Publish must copy admin add-ons only into NAS tools\\addons."
    Assert-True ($publishText -notmatch 'src\\revit-plugin\\revAgentPlugin\\revAgentPlugin\.csproj') "Release manifest components must not include developer source project files."
    $stableLauncherText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\revAgent Updater STABLE.cmd")
    Assert-True ($stableLauncherText -match 'revAgent-deploy' -and $stableLauncherText -notmatch 'revit-mcp-deploy' -and $stableLauncherText -notmatch 'LEGACY_ROOT') "Standalone stable launcher must use only the canonical revAgent NAS root after compatibility-root retirement."

    Write-Host "Test initial updater invocation binding"
    $installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
    Assert-True ($installTaskText -match 'Resolve-RevAgentCanonicalNasTransitionPath' -and $installTaskText -match 'revAgent-deploy' -and $installTaskText -match 'revit-mcp-deploy' -and $installTaskText -match 'Canonical NAS release root detected') "Updater installer must persist canonical NAS channel config when the new deploy root is available."
    Assert-True ($installTaskText -match '& \$UpdaterPath -ConfigPath \$UpdaterConfigPath -NoNotifyUser -AllowManualCodexSetup') "Initial update check must pass ConfigPath as a named parameter."
    Assert-True ($installTaskText -notmatch '& \$UpdaterPath @arguments') "Initial update check must not array-splat named parameter strings into a script call."
    Assert-True ($installTaskText -match '\[string\]\$DailyAt = "12:00"') "Updater scheduled-task installer must default to daily noon checks."
    Assert-True ($installTaskText -match '\[string\]\$TaskName = "revAgent Auto Update"') "Updater scheduled task must use the revAgent product name by default."
    Assert-True ($installTaskText -match 'DPE\\revAgent') "Updater scheduled-task installer must default to the revAgent install root."
    Assert-True ($installTaskText -match 'Update-revAgent-Now\.cmd' -and $installTaskText -match 'Show-revAgent-Version\.cmd') "Updater scheduled-task installer must create revAgent-named helper commands."
    Assert-True ($installTaskText -match 'New-RevAgentDailyUpdateTrigger -DailyAt \$RunAt') "Updater scheduled-task installer must use the shared daily trigger helper."
    Assert-True ($installTaskText -notmatch 'New-ScheduledTaskTrigger -AtLogOn') "Updater scheduled task must not run at logon."
    Assert-True ($installTaskText -notmatch 'RepetitionInterval') "Updater scheduled task must not repeat through the day."
    Assert-True ($installTaskText -notmatch 'StartWhenAvailable') "Updater scheduled task must not start immediately for a missed noon trigger during GUI RunNow installs."
    Assert-True ($installTaskText -match 'dailyAt = \$DailyAt') "Updater config must persist the daily check time for future repairs."
    Assert-True ($installTaskText -match 'codexInstructionPolicy = \$CodexInstructionPolicy' -and $installTaskText -match 'Resolve-CodexInstructionPolicy') "Updater config must persist the Codex instruction policy for future repairs."
    Assert-True ($installTaskText -match 'Task schedule\s+: daily at \$RunAt') "Updater install output must report the daily schedule."
    Assert-True ($installTaskText -match '"revAgent Auto Update\.vbs"') "Startup fallback reminder must use the revAgent product name."
    $desktopLauncherCleanupModuleText = Get-Content -Raw -LiteralPath (Join-Path $libRoot "RevAgent.DesktopLauncherCleanup.psm1")
    Assert-True ($desktopLauncherCleanupModuleText -match 'Revit MCP Auto Update\.cmd' -and $desktopLauncherCleanupModuleText -match 'Revit MCP Auto Update\.vbs' -and $installTaskText -match 'Invoke-RevAgentExactLegacyStartupLauncherCleanup') "Shared launcher cleanup module must own the exact legacy reminder names and the updater wrapper must consume it."
    $startupCleanupFunctionNames = @(
        "Get-RevAgentInstallObjectPropertyValue",
        "Remove-RevAgentLegacyStartupLaunchers",
        "Merge-RevAgentLauncherCleanupEvidence",
        "Merge-RevAgentDesktopLauncherCleanupEvidence",
        "Test-RevAgentTextFileLinesEqual",
        "Set-RevAgentAsciiContentIfChanged",
        "Write-UpdaterCommandFiles",
        "Get-HiddenUpdaterLauncherPath",
        "Assert-HiddenUpdaterLauncherInstalled",
        "Register-RevAgentInteractiveUpdateTask"
    )
    $startupCleanupFunctionAsts = @($installTaskAst.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $startupCleanupFunctionNames -contains $node.Name
            }, $true) | Sort-Object { $_.Extent.StartOffset })
    Assert-Equal $startupCleanupFunctionAsts.Count $startupCleanupFunctionNames.Count "Startup-launcher cleanup harness could not resolve every production function."
    $startupCleanupFunctionText = ($startupCleanupFunctionAsts | ForEach-Object { $_.Extent.Text }) -join "`r`n`r`n"
    & {
        param([string]$FunctionText, [string]$HarnessRoot)
        . ([scriptblock]::Create($FunctionText))

        function Get-RevAgentLegacyHiddenUpdaterLauncherPaths { param([string]$ConfigPath) return @() }
        $script:HiddenLauncherWriteCount = 0
        $script:RegisteredTaskAction = $null
        $script:RegisterTaskShouldFail = $false
        $script:ExistingScheduledTask = $null
        function Write-HiddenPowerShellLauncher {
            param(
                [string]$LauncherPath,
                [string]$ScriptPath,
                [string[]]$ScriptArguments = @(),
                [switch]$WaitForExit
            )
            $script:HiddenLauncherWriteCount++
            "launcher" | Set-Content -LiteralPath $LauncherPath -Encoding ASCII
        }
        function New-HiddenUpdaterScheduledTaskAction {
            param([string]$LauncherPath)
            return [pscustomobject]@{ Execute = "wscript.exe"; Argument = "//B //Nologo `"$LauncherPath`"" }
        }
        function New-RevAgentDailyUpdateTrigger { param([string]$DailyAt) return [pscustomobject]@{ DailyAt = $DailyAt } }
        function New-ScheduledTaskSettingsSet {
            param(
                [switch]$AllowStartIfOnBatteries,
                [switch]$DontStopIfGoingOnBatteries
            )
            return [pscustomobject]@{}
        }
        function New-ScheduledTaskPrincipal { param([string]$UserId, [string]$LogonType, [string]$RunLevel) return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel } }
        function Register-ScheduledTask {
            param(
                [string]$TaskName,
                [object]$Action,
                [object[]]$Trigger,
                [object]$Settings,
                [object]$Principal,
                [string]$Description,
                [switch]$Force
            )
            if ($script:RegisterTaskShouldFail) {
                throw "Erisim engellendi."
            }
            $script:RegisteredTaskAction = $Action
        }
        function Get-ScheduledTask {
            [CmdletBinding()]
            param([string]$TaskName)
            if ([string]::Equals($TaskName, "revAgent Auto Update", [System.StringComparison]::OrdinalIgnoreCase) -and
                $null -ne $script:ExistingScheduledTask) {
                return $script:ExistingScheduledTask
            }
            return $null
        }
        function Unregister-ScheduledTask {
            [CmdletBinding()]
            param([string]$TaskName, [switch]$Confirm)
        }
        $script:RevAgentStartupLauncherCleanup = [ordered]@{
            enabled = $true
            mode = "not-run"
            startupRoot = ""
            matchedCount = 0
            removedCount = 0
            failedCount = 0
            matched = @()
            removed = @()
            failed = @()
        }
        $script:RevAgentDesktopLauncherCleanup = [ordered]@{
            enabled = $true
            mode = "not-run"
            matchedCount = 0
            removedCount = 0
            failedCount = 0
            matched = @()
            removed = @()
            failed = @()
        }

        $workRoot = Join-Path $HarnessRoot "startup-cleanup-work"
        New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
        $updaterPath = Join-Path $workRoot "update-from-nas.ps1"
        $configPath = Join-Path $workRoot "updater-config.json"

        $scheduledStartupRoot = Join-Path $HarnessRoot "scheduled-startup"
        New-Item -ItemType Directory -Path $scheduledStartupRoot -Force | Out-Null
        foreach ($legacyName in @("Revit MCP Auto Update.cmd", "Revit MCP Auto Update.vbs")) {
            "legacy" | Set-Content -LiteralPath (Join-Path $scheduledStartupRoot $legacyName) -Encoding ASCII
        }
        "keep" | Set-Content -LiteralPath (Join-Path $scheduledStartupRoot "revAgent Auto Update.vbs") -Encoding ASCII
        "keep" | Set-Content -LiteralPath (Join-Path $scheduledStartupRoot "unrelated.cmd") -Encoding ASCII

        Write-UpdaterCommandFiles -UpdaterPath $updaterPath -UpdaterConfigPath $configPath -UpdaterWorkRoot $workRoot -StartupRoot $scheduledStartupRoot | Out-Null
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $scheduledStartupRoot "Revit MCP Auto Update.cmd"))) "Scheduled-task install path must remove the legacy CMD Startup launcher."
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $scheduledStartupRoot "Revit MCP Auto Update.vbs"))) "Scheduled-task install path must remove the legacy VBS Startup launcher."
        Assert-True (Test-Path -LiteralPath (Join-Path $scheduledStartupRoot "revAgent Auto Update.vbs") -PathType Leaf) "Scheduled-task install path must preserve the current revAgent Startup launcher."
        Assert-True (Test-Path -LiteralPath (Join-Path $scheduledStartupRoot "unrelated.cmd") -PathType Leaf) "Scheduled-task install path must preserve unrelated Startup files."

        foreach ($legacyName in @("Revit MCP Auto Update.cmd", "Revit MCP Auto Update.vbs")) {
            "legacy" | Set-Content -LiteralPath (Join-Path $scheduledStartupRoot $legacyName) -Encoding ASCII
        }
        Write-UpdaterCommandFiles -UpdaterPath $updaterPath -UpdaterConfigPath $configPath -UpdaterWorkRoot $workRoot -StartupRoot $scheduledStartupRoot -SkipStartupCleanup | Out-Null
        Assert-True (Test-Path -LiteralPath (Join-Path $scheduledStartupRoot "Revit MCP Auto Update.cmd") -PathType Leaf) "Machine-only command generation must not traverse or clean the interactive user's Startup folder."
        Assert-True (Test-Path -LiteralPath (Join-Path $scheduledStartupRoot "Revit MCP Auto Update.vbs") -PathType Leaf) "Machine-only command generation must preserve user Startup files for the unelevated phase."

        $hiddenLauncherPath = Join-Path $workRoot "Run-revAgent-Update-Hidden.vbs"
        Set-Content -LiteralPath $hiddenLauncherPath -Value "powershell $updaterPath -ConfigPath $configPath -OperationMethod scheduled-update" -Encoding ASCII
        $script:HiddenLauncherWriteCount = 0
        Register-RevAgentInteractiveUpdateTask -UpdaterPath $updaterPath -UpdaterConfigPath $configPath -VersionToolPath (Join-Path $workRoot "show-installed-version.ps1") -UpdaterWorkRoot $workRoot -Name "revAgent Auto Update" -RunAt "12:00" -IntervalMinutes 30 -UseExistingHiddenLauncher
        Assert-Equal ([int]$script:HiddenLauncherWriteCount) 0 "User-phase task registration must not rewrite the protected hidden updater launcher."
        Assert-True ($null -ne $script:RegisteredTaskAction -and [string]$script:RegisteredTaskAction.Argument -match [regex]::Escape($hiddenLauncherPath)) "User-phase task registration must bind the scheduled task to the machine-written hidden launcher."

        $script:RegisteredTaskAction = $null
        $script:RegisterTaskShouldFail = $true
        $script:ExistingScheduledTask = [pscustomobject]@{
            Actions = @([pscustomobject]@{
                    Execute = "C:\Windows\System32\wscript.exe"
                    Arguments = "//B //Nologo `"$hiddenLauncherPath`""
                })
            Principal = [pscustomobject]@{
                UserId = "Net01"
                LogonType = "Interactive"
                RunLevel = "Limited"
            }
        }
        Register-RevAgentInteractiveUpdateTask -UpdaterPath $updaterPath -UpdaterConfigPath $configPath -VersionToolPath (Join-Path $workRoot "show-installed-version.ps1") -UpdaterWorkRoot $workRoot -Name "revAgent Auto Update" -RunAt "12:00" -IntervalMinutes 30 -UseExistingHiddenLauncher
        Assert-Equal ([int]$script:HiddenLauncherWriteCount) 0 "User-phase registration fallback must still avoid protected hidden updater launcher rewrites."
        Assert-True ($null -eq $script:RegisteredTaskAction) "User-phase registration fallback must preserve a compatible existing scheduled task after access denial."
        $script:RegisterTaskShouldFail = $false
        $script:ExistingScheduledTask = $null

        $fallbackStartupRoot = Join-Path $HarnessRoot "fallback-startup"
        New-Item -ItemType Directory -Path $fallbackStartupRoot -Force | Out-Null
        foreach ($legacyName in @("Revit MCP Auto Update.cmd", "Revit MCP Auto Update.vbs")) {
            "legacy" | Set-Content -LiteralPath (Join-Path $fallbackStartupRoot $legacyName) -Encoding ASCII
        }

        Write-UpdaterCommandFiles -UpdaterPath $updaterPath -UpdaterConfigPath $configPath -UpdaterWorkRoot $workRoot -StartupRoot $fallbackStartupRoot -InstallStartupFallback | Out-Null
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $fallbackStartupRoot "Revit MCP Auto Update.cmd"))) "Fallback install path must remove the legacy CMD Startup launcher."
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $fallbackStartupRoot "Revit MCP Auto Update.vbs"))) "Fallback install path must remove the legacy VBS Startup launcher."
        Assert-True (Test-Path -LiteralPath (Join-Path $fallbackStartupRoot "revAgent Auto Update.vbs") -PathType Leaf) "Fallback install path must create the current revAgent Startup launcher."
        Assert-True (Test-Path -LiteralPath (Join-Path $workRoot "auto-update-loop.ps1") -PathType Leaf) "Fallback install path must preserve the daily audit-loop behavior."

        $duplicateRecord = [pscustomobject]@{ path = "C:\Startup\duplicate.cmd"; name = "duplicate.cmd"; extension = ".cmd" }
        $duplicatePrimary = [pscustomobject]@{ mode = "commit"; matched = @($duplicateRecord); removed = @($duplicateRecord); failed = @() }
        $deduplicatedEvidence = Merge-RevAgentLauncherCleanupEvidence -Primary $duplicatePrimary -Additional $duplicatePrimary
        Assert-Equal ([int]$deduplicatedEvidence.matchedCount) 1 "Launcher evidence merge must deduplicate the same matched path."
        Assert-Equal ([int]$deduplicatedEvidence.removedCount) 1 "Launcher evidence merge must deduplicate the same removed path."

        $failureStartupRoot = Join-Path $HarnessRoot "failure-startup"
        New-Item -ItemType Directory -Path $failureStartupRoot -Force | Out-Null
        $failureCmd = Join-Path $failureStartupRoot "Revit MCP Auto Update.cmd"
        $failureVbs = Join-Path $failureStartupRoot "Revit MCP Auto Update.vbs"
        "legacy" | Set-Content -LiteralPath $failureCmd -Encoding ASCII
        "legacy" | Set-Content -LiteralPath $failureVbs -Encoding ASCII
        $script:RevAgentStartupLauncherCleanup = [ordered]@{ enabled = $true; mode = "not-run"; startupRoot = ""; matchedCount = 0; removedCount = 0; failedCount = 0; matched = @(); removed = @(); failed = @() }
        $script:RevAgentDesktopLauncherCleanup = [ordered]@{ enabled = $true; mode = "not-run"; matchedCount = 0; removedCount = 0; failedCount = 0; matched = @(); removed = @(); failed = @() }
        $failureLock = [System.IO.File]::Open(
            $failureCmd,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read)
        $startupFailureCaught = $false
        try {
            Write-UpdaterCommandFiles -UpdaterPath $updaterPath -UpdaterConfigPath $configPath -UpdaterWorkRoot $workRoot -StartupRoot $failureStartupRoot | Out-Null
        }
        catch {
            $startupFailureCaught = ($_.Exception.Message -match "failed closed")
        }
        finally {
            $failureLock.Dispose()
        }
        Assert-True $startupFailureCaught "Exact Startup cleanup failures must fail the wrapper closed after preserving evidence."
        Assert-True (Test-Path -LiteralPath $failureCmd -PathType Leaf) "Simulated locked Startup launcher must remain for operator remediation."
        Assert-True (-not (Test-Path -LiteralPath $failureVbs -PathType Leaf)) "Per-item cleanup must continue and remove an independent Startup launcher after another item fails."
        Assert-Equal ([int]$script:RevAgentDesktopLauncherCleanup.matchedCount) 2 "Failed-closed launcher attestation must preserve every exact match."
        Assert-Equal ([int]$script:RevAgentDesktopLauncherCleanup.removedCount) 1 "Failed-closed launcher attestation must preserve partial removal evidence."
        Assert-Equal ([int]$script:RevAgentDesktopLauncherCleanup.failedCount) 1 "Failed-closed launcher attestation must preserve the per-item failure."
        Assert-Equal ([string]$script:RevAgentDesktopLauncherCleanup.mode) "failed" "Merged launcher attestation must expose failed mode when any exact cleanup fails."
        Assert-Equal ([int]$script:RevAgentDesktopLauncherCleanup.exactStartupCleanup.failedCount) 1 "Merged launcher attestation must retain exact Startup failure provenance."
    } $startupCleanupFunctionText $tempRoot
    Assert-True ($installTaskText -match 'Removed legacy task: \$legacyTaskName') "Updater install must remove the legacy Revit MCP scheduled task after registering the revAgent task."
    $scheduledTaskModuleText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.ScheduledTask.psm1")
    Assert-True ($scheduledTaskModuleText -match '\[string\]\$Name = "revAgent Auto Update"') "Scheduled-task repair must default to the revAgent task name."
    Assert-True ($scheduledTaskModuleText -match '\[string\[\]\]\$LegacyNames = @\("Revit MCP Auto Update"\)') "Scheduled-task repair must know the legacy Revit MCP task name."
    Assert-True ($scheduledTaskModuleText -match 'Scheduled task migrated to revAgent product name') "Scheduled-task repair must migrate existing installed reminders to the revAgent task name."
    $hiddenLauncherModuleText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.HiddenLauncher.psm1")
    Assert-True ($hiddenLauncherModuleText -match 'Run-revAgent-Update-Hidden\.vbs' -and $scheduledTaskModuleText -match 'Removed legacy hidden updater launcher') "Scheduled-task repair must use and clean revAgent-named hidden launcher files."
    Assert-True ($scheduledTaskModuleText -match 'Set-ScheduledTask -TaskName \$Name -Trigger \$trigger') "Updater repair must replace legacy repeated triggers with the daily trigger."
    Assert-True ($scheduledTaskModuleText -match 'Set-ScheduledTask -TaskName \$Name -Trigger \$trigger -Settings \$settings') "Updater repair must clear legacy StartWhenAvailable settings."
    Assert-True ($scheduledTaskModuleText -match 'Set-ScheduledTask -TaskName \$Name -Trigger \$trigger -Settings \$settings -ErrorAction Stop') "Scheduled-task repair permission errors must be caught as warnings."
    Assert-True ($scheduledTaskModuleText -notmatch 'StartWhenAvailable') "Updater scheduled-task repair must not preserve StartWhenAvailable."

    Write-Host "Test bundled Node MSI path quoting"
    $updaterPath = Join-Path $RepoRoot "installer\nas\update-from-nas.ps1"
    $updaterText = Get-Content -Raw -LiteralPath $updaterPath
    $updaterTokens = $null
    $updaterErrors = $null
    $updaterAst = [System.Management.Automation.Language.Parser]::ParseFile($updaterPath, [ref]$updaterTokens, [ref]$updaterErrors)
    Assert-Equal $updaterErrors.Count 0 "Updater must parse without PowerShell syntax errors."
    $npmInstallFunctionAst = @($updaterAst.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Invoke-NpmInstallIfNeeded"
            }, $true)) | Select-Object -First 1
    Assert-True ($null -ne $npmInstallFunctionAst) "Updater must define Invoke-NpmInstallIfNeeded."
    $npmInstallFunctionText = $npmInstallFunctionAst.Extent.Text
    Assert-True ($updaterText -match '\$msiArgument\s*=') "update-from-nas.ps1 must build a quoted MSI path argument."
    Assert-True ($updaterText -match 'ArgumentList\s+"/i \$msiArgument /qn /norestart"') "Bundled Node.js MSI install must quote the MSI path before calling msiexec."
    Assert-True ($updaterText -notmatch 'ArgumentList\s+@\("/i",\s*\$msiPath,\s*"/qn",\s*"/norestart"\)') "Bundled Node.js MSI install must not pass an unquoted space-containing path to msiexec."
    Assert-True ($updaterText -match 'function Invoke-NpmInstallIfNeeded') "Updater must gate npm install behind a dependency-current check."
    Assert-True ($updaterText -match 'function Test-NpmDependenciesCurrent') "Updater must check node_modules and the dependency fingerprint before npm install."
    Assert-True ($updaterText -match '\.revagent-npm-dependencies\.json') "Updater must persist an npm dependency marker for future skips."
    Assert-True ($updaterText -match 'npm install skipped') "Updater logs must make skipped npm dependency installs visible."
    Assert-True ($updaterText -match 'function Get-NodeRuntimeIdentity' -and $updaterText -match 'process\.versions\.modules' -and $updaterText -match 'process\.versions\.napi' -and $updaterText -match 'process\.platform' -and $updaterText -match 'process\.arch') "Updater cache identity must come from the selected runtime Node ABI, N-API, platform, and architecture."
    Assert-True ($updaterText -match 'runtimeKey' -and $updaterText -match 'cacheKey' -and $updaterText -match 'schemaVersion = 2' -and $updaterText -match 'nodeModuleVersion = \[string\]\$Fingerprint\.nodeModuleVersion' -and $updaterText -match 'platform = \[string\]\$Fingerprint\.platform' -and $updaterText -match 'arch = \[string\]\$Fingerprint\.arch') "Updater dependency marker schema v2 must persist the full runtime identity and shortened combined cache key."
    Assert-True ($updaterText -match 'Get-RevAgentSha256Hex -Text \("\{0\}\|\{1\}"' -and $updaterText -match 'Join-Path \(\[string\]\$Fingerprint\.cacheKey\) "node_modules"' -and $updaterText -match '"\.stg-" \+ \[Guid\]::NewGuid') "Updater dependency cache and staging paths must use MAX_PATH-safe deterministic/short partitions."
    Assert-True ($updaterText -match 'function Test-NpmNativeDependenciesLoad' -and $updaterText -match "new Database\(':memory:'\)" -and $updaterText -match 'Assert-NpmNativeDependenciesLoad') "Updater must load better-sqlite3 and open an in-memory database under the selected runtime Node before accepting dependencies."
    Assert-True ($updaterText -match 'function Remove-InvalidNpmDependencyCache' -and $updaterText -match 'Native dependency validation failed before cache restore' -and $updaterText -match 'Existing cache failed validation before save') "Updater must discard invalid native caches before restore and replace stale cache entries on save."
    Assert-True ($updaterText -match 'function Invoke-NpmWithLifecycleScripts' -and $updaterText -match '\$previousNpmIgnoreScripts = \[Environment\]::GetEnvironmentVariable\("npm_config_ignore_scripts", "Process"\)' -and $updaterText -match '\$env:npm_config_ignore_scripts = "false"' -and $updaterText -match 'finally\s*\{' -and $updaterText -match 'Remove-Item Env:\\npm_config_ignore_scripts') "Updater npm install/rebuild must enable lifecycle scripts process-locally and restore the caller environment through finally."
    $npmResolverCount = @($updaterAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Resolve-NpmCliScript" }, $true)).Count
    Assert-Equal $npmResolverCount 1 "Updater must have one authoritative npm-cli resolver."
    Assert-True ($updaterText -match 'function Get-NpmCliRuntimeStatus' -and $updaterText -match '& \$NodePath \$npmCliPath --version' -and $updaterText -match '\[bool\]\$npmCliStatus\.ready') "Updater readiness must require the selected Node to run the resolved npm-cli.js successfully."
    Assert-True ($updaterText -match 'Invoke-External -FilePath \$NodePath -Arguments \(@\(\$npmCliPath\)') "Updater must run the already-resolved npm-cli.js through the exact Node used for runtime validation and MCP registration."
    Assert-True ($updaterText -match '\$nodeRuntimeStatus = Ensure-UpdateDependencies' -and $updaterText -match '\$nodePath = \[string\]\$nodeRuntimeStatus\.nodePath' -and $updaterText -match '\$npmCliPath = \[string\]\$nodeRuntimeStatus\.npmCliPath') "Updater must carry one validated Node/npm CLI pair through dependency install and MCP registration."
    $npmInstallIndex = $npmInstallFunctionText.IndexOf('Invoke-NpmWithLifecycleScripts -NodePath $NodePath -NpmCliPath $NpmCliPath -Arguments @("install"')
    $nativeAssertIndex = $npmInstallFunctionText.LastIndexOf('Assert-NpmNativeDependenciesLoad -WorkingDirectory $WorkingDirectory -NodePath $NodePath -Label $Label')
    $markerWriteIndex = $npmInstallFunctionText.IndexOf('Write-NpmDependencyMarker -WorkingDirectory $WorkingDirectory -Fingerprint $fingerprint')
    $cacheSaveIndex = $npmInstallFunctionText.IndexOf('Save-NpmDependenciesToCache -WorkingDirectory $WorkingDirectory')
    Assert-True ($npmInstallIndex -ge 0 -and $nativeAssertIndex -gt $npmInstallIndex -and $markerWriteIndex -gt $nativeAssertIndex -and $cacheSaveIndex -gt $markerWriteIndex) "Updater must validate native bindings after install/rebuild and before writing a current marker or cache."
    Assert-True ($npmInstallFunctionText -match 'Invoke-NpmWithLifecycleScripts .* -Arguments @\("rebuild", "better-sqlite3"') "Updater better-sqlite3 repair must use the lifecycle-enabled npm wrapper."
    Assert-True ($updaterText -match '\[string\]\$TaskName = "revAgent Auto Update"') "Updater reminder task name must default to revAgent."
    Assert-True ($updaterText -match 'DPE\\revAgent' -and $updaterText -match 'Legacy install root detected in updater config') "Updater must migrate legacy RevitMCP configs to the revAgent root."
    Assert-True ($updaterText -match 'Then run the revAgent updater again') "Updater missing-dependency guidance must use the revAgent product name."
    Assert-True ($updaterText -notmatch 'Then run the Revit MCP updater again') "Updater reminder/error windows must not ask users to run the Revit MCP updater."
    Assert-True ($updaterText -match 'app = "revAgent"') "Notification throttle state must use the revAgent product name."
    Assert-True ($updaterText -match 'dependencies\\npm') "Updater must use the managed local npm dependency cache."
    Assert-True ($updaterText -match 'Restore-NpmDependenciesFromCache') "Updater must restore matching npm dependencies from cache before installing."
    Assert-True ($updaterText -match 'Remove-StaleNpmDependencyJunction') "Updater must remove stale cached dependency junctions before refreshing."
    Assert-True ($updaterText -match 'Invoke-NpmInstallIfNeeded -NodePath \$nodePath -NpmCliPath \$npmCliPath -WorkingDirectory \$ServerTarget .* -CacheRoot \$npmDependencyCacheRoot') "Runtime npm install must use the validated ABI-aware Node/npm CLI pair."
    Assert-True ($updaterText -match 'Invoke-NpmInstallIfNeeded -NodePath \$nodePath -NpmCliPath \$npmCliPath -WorkingDirectory \$docsServerPath .* -CacheRoot \$npmDependencyCacheRoot') "Docs server npm install must use the validated ABI-aware Node/npm CLI pair."
    Assert-True ($updaterText.IndexOf('Already up to date.') -lt $updaterText.LastIndexOf('Initialize-RevAgentWorkstationProxy -ProxyUrl')) "No-op machine updates must return before machine-phase proxy setup; the separate user phase may still verify Codex integration."
    Assert-True ($updaterText.IndexOf('Already up to date.') -lt $updaterText.IndexOf('Ensure-UpdateDependencies -SkipNpmInstall')) "No-op current updates must return before Node/Codex/npm dependency checks."
    Assert-True ($updaterText.IndexOf('deferred-revit-close-required') -lt $updaterText.IndexOf('Ensure-UpdateDependencies -SkipNpmInstall')) "Revit-close deferrals must return before Node/Codex/npm dependency checks."
    Assert-True ($updaterText -match 'if \(\$runningRevit\)\s*\{\s*Write-Warning "Revit is running, but this update does not change Revit add-in/command files') "Updater must only warn that Revit is running when Revit.exe is actually detected."
    Assert-True ($updaterText -match '\$Status -eq "updated"') "Completed version transition must only be reported for successful updates."
    Assert-True ($updaterText -match 'pendingVersionTransition') "Deferred or available updates must be reported as pending, not completed transitions."
    $statusText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\show-installed-version.ps1")
    Assert-True ($statusText -match 'Pending update') "Status output must label deferred updates as pending updates."

    Write-Host "Test proxy, Codex config, and report helpers"
    Assert-Equal (ConvertTo-RevAgentProxyUrl -Value "192.168.90.10 6588") "http://192.168.90.10:6588" "Proxy URL normalization failed."
    Assert-Equal (ConvertTo-RevAgentWinHttpProxyServer -Value "http://192.168.90.10:6588") "192.168.90.10:6588" "WinHTTP proxy normalization failed."
    Assert-Equal (ConvertTo-RevitMcpProxyUrl -Value "192.168.90.10 6588") "http://192.168.90.10:6588" "Legacy proxy URL alias must remain compatible."
    Assert-Equal (ConvertTo-RevitMcpWinHttpProxyServer -Value "http://192.168.90.10:6588") "192.168.90.10:6588" "Legacy WinHTTP proxy alias must remain compatible."
    $codexConfig = Join-Path $tempRoot "config.toml"
    Set-Content -LiteralPath $codexConfig -Value "model = `"gpt-5.5`"`r`nservice_tier = `"priority`"`r`n`r`n[mcp_servers.revit-mcp]`r`ncommand = `"old-node.exe`"`r`nargs = [`"old-runtime.js`"]`r`n`r`n[mcp_servers.revit-api-docs]`r`ncommand = `"old-node.exe`"`r`nargs = [`"old-docs.js`"]`r`n" -Encoding UTF8
    Register-RevAgentCodexMcpServersInConfig -ConfigPath $codexConfig -NodePath "node.exe" -RuntimeServerPath "runtime\build\index.js" -DocsServerPath "docs\build\index.js" | Out-Null
    $codexText = Get-Content -Raw -LiteralPath $codexConfig
    Assert-True ($codexText -match '(?m)^service_tier\s*=\s*"fast"\s*$') "Codex service_tier must be normalized to the current Codex CLI-supported fast tier."
    Assert-True ($codexText -notmatch '(?m)^service_tier\s*=\s*"priority"\s*$') "Codex service_tier must not keep the obsolete priority value."
    Assert-True ($codexText -match '\[mcp_servers\.revAgent\]') "Codex revAgent MCP section was not written."
    Assert-True ($codexText -match '\[mcp_servers\.revAgent-api-docs\]') "Codex revAgent API docs MCP section was not written."
    Assert-True ($codexText -notmatch '\[mcp_servers\.revit-mcp\]' -and $codexText -notmatch '\[mcp_servers\.revit-api-docs\]') "Legacy Codex MCP section names must be removed from user-facing config."
    Assert-True ($codexText -match '(?m)^\[features\]\s*$') "Codex features section was not written."
    Assert-True ($codexText -match '(?m)^memories\s*=\s*true\s*$') "Codex memories feature was not enabled."
    Assert-True ($codexText -match '(?m)^chronicle\s*=\s*false\s*$') "Codex chronicle feature was not disabled."
    Assert-True ($codexText -match '(?m)^\[memories\]\s*$') "Codex memories section was not written."
    Assert-True ($codexText -match '(?m)^disable_on_external_context\s*=\s*true\s*$') "Codex external-context memory guard was not enabled."
    Assert-True ($codexText -match '(?m)^generate_memories\s*=\s*true\s*$') "Codex memory generation was not enabled."
    Assert-True ($codexText -match '(?m)^use_memories\s*=\s*true\s*$') "Codex memory use was not enabled."
    Register-RevAgentCodexMcpServersInConfig -ConfigPath $codexConfig -NodePath "node.exe" -RuntimeServerPath "runtime\build\index.js" -DocsServerPath "docs\build\index.js" | Out-Null
    $codexTextAfterSecondWrite = Get-Content -Raw -LiteralPath $codexConfig
    Assert-Equal ([regex]::Matches($codexTextAfterSecondWrite, '(?m)^service_tier\s*=\s*"fast"\s*$').Count) 1 "Codex service_tier must not be duplicated."
    Assert-Equal ([regex]::Matches($codexTextAfterSecondWrite, '(?m)^\[features\]\s*$').Count) 1 "Codex features section must not be duplicated."
    Assert-Equal ([regex]::Matches($codexTextAfterSecondWrite, '(?m)^\[memories\]\s*$').Count) 1 "Codex memories section must not be duplicated."
    Assert-Equal ([regex]::Matches($codexTextAfterSecondWrite, '(?m)^memories\s*=\s*true\s*$').Count) 1 "Codex memories feature must not be duplicated."
    $codexProfileConfig = Join-Path $tempRoot "profile-config.toml"
    Set-Content -LiteralPath $codexProfileConfig -Value "[profiles.lite]`r`nservice_tier = `"flex`"`r`n" -Encoding UTF8
    Register-RevAgentCodexMcpServersInConfig -ConfigPath $codexProfileConfig -NodePath "node.exe" -RuntimeServerPath "runtime\build\index.js" -DocsServerPath "docs\build\index.js" | Out-Null
    $codexProfileText = Get-Content -Raw -LiteralPath $codexProfileConfig
    Assert-Equal ([regex]::Matches($codexProfileText, '(?m)^service_tier\s*=\s*"fast"\s*$').Count) 1 "Codex top-level service_tier must be added when only profile service_tier values exist."
    Assert-True ($codexProfileText -match '(?ms)^\[profiles\.lite\]\s*.*?^service_tier\s*=\s*"flex"\s*$') "Codex profile-specific service_tier override must be preserved."
    $codexStaleProfileConfig = Join-Path $tempRoot "stale-profile-config.toml"
    Set-Content -LiteralPath $codexStaleProfileConfig -Value "[profiles.legacy]`r`nservice_tier = `"priority`"`r`n" -Encoding UTF8
    Register-RevAgentCodexMcpServersInConfig -ConfigPath $codexStaleProfileConfig -NodePath "node.exe" -RuntimeServerPath "runtime\build\index.js" -DocsServerPath "docs\build\index.js" | Out-Null
    $codexStaleProfileText = Get-Content -Raw -LiteralPath $codexStaleProfileConfig
    Assert-True ($codexStaleProfileText -notmatch '(?m)^service_tier\s*=\s*"priority"\s*$') "Codex stale profile service_tier=priority must be normalized."
    Assert-True ($codexStaleProfileText -match '(?ms)^\[profiles\.legacy\]\s*.*?^service_tier\s*=\s*"fast"\s*$') "Codex stale profile service_tier must be normalized to fast."
    $profileUserRoot = Join-Path $tempRoot "profile-user"
    $windowsPowerShellProfile = Join-Path $profileUserRoot "Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1"
    New-Item -ItemType Directory -Path (Split-Path -Parent $windowsPowerShellProfile) -Force | Out-Null
    Set-Content -LiteralPath $windowsPowerShellProfile -Value "# existing operator profile`r`n`$x = 1`r`n" -Encoding UTF8
    $utf8Profiles = @(Set-RevAgentPowerShellUtf8ConsoleConfig -UserProfileRoot $profileUserRoot)
    Assert-Equal $utf8Profiles.Count 2 "UTF-8 console config must cover Windows PowerShell and PowerShell 7 profile paths."
    $windowsPowerShellProfileText = Get-Content -Raw -LiteralPath $windowsPowerShellProfile
    $powerShell7ProfileText = Get-Content -Raw -LiteralPath (Join-Path $profileUserRoot "Documents\PowerShell\Microsoft.PowerShell_profile.ps1")
    Assert-True ($windowsPowerShellProfileText -match '# existing operator profile') "UTF-8 console config must preserve existing profile content."
    Assert-True ($windowsPowerShellProfileText -match '\[Console\]::OutputEncoding = \$revAgentUtf8Encoding' -and $windowsPowerShellProfileText -match '(?s)\[Environment\]::SystemDirectory.*chcp\.com.*65001') "Windows PowerShell profile must force UTF-8 console output through the trusted known-folder System32 binary."
    Assert-True ($powerShell7ProfileText -match '\[Console\]::OutputEncoding = \$revAgentUtf8Encoding' -and $powerShell7ProfileText -match 'PYTHONIOENCODING = "utf-8"') "PowerShell 7 profile must force UTF-8 console output."
    [void](Set-RevAgentPowerShellUtf8ConsoleConfig -UserProfileRoot $profileUserRoot)
    $windowsPowerShellProfileTextAfterSecondWrite = Get-Content -Raw -LiteralPath $windowsPowerShellProfile
    Assert-Equal ([regex]::Matches($windowsPowerShellProfileTextAfterSecondWrite, '# BEGIN revAgent UTF-8 console').Count) 1 "UTF-8 profile block must not be duplicated."
    $currentProcessUtf8 = Set-RevAgentCurrentProcessUtf8Console
    Assert-True ([bool]$currentProcessUtf8.success) "Current process UTF-8 setup should succeed."
    Assert-Equal ([Console]::InputEncoding.CodePage) 65001 "Current process input encoding must be UTF-8."
    Assert-Equal ([Console]::OutputEncoding.CodePage) 65001 "Current process output encoding must be UTF-8."
    Assert-Equal ($OutputEncoding.CodePage) 65001 "Current process PowerShell output encoding must be UTF-8."
    Assert-Equal $env:PYTHONUTF8 "1" "Current process must opt Python into UTF-8 mode."
    Assert-Equal $env:PYTHONIOENCODING "utf-8" "Current process must opt Python stdio into UTF-8."
    $codexRegistrationText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.CodexRegistration.psm1")
    Assert-True ($codexRegistrationText -match 'function Set-RevitMcpCurrentProcessUtf8Console' -and $codexRegistrationText -match '"Set-RevAgentCurrentProcessUtf8Console" = "Set-RevitMcpCurrentProcessUtf8Console"' -and $codexRegistrationText -match 'Export-ModuleMember -Alias @\(\$revAgentFunctionAliases\.Keys\)') "Codex registration module must keep the legacy UTF-8 helper and export the revAgent alias."
    $installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
    Assert-True ($installTaskText -match 'Set-RevAgentCurrentProcessUtf8Console') "Updater task installer entrypoint must force UTF-8 output even when launched with -NoProfile."
    Assert-True ($installTaskText -match 'manual-update-audit' -and $installTaskText -match '-AuditOnly -NotifyUser' -and $installTaskText -match 'Machine updates require the protected local revAgent launcher' -and $installTaskText -notmatch 'Machine updates require the unelevated revAgent Updater GUI') "Updater task installer helper validation must match the protected launcher helper text written by the machine phase."
    Assert-True ($installTaskText -match 'function Copy-RevAgentManagedUpdaterToolFile' -and $installTaskText -match '\[bool\]\$Required = \$true' -and $installTaskText -match 'Install-RevAgentManagedUpdaterFile -Source \$Source -Destination \$Destination -Required:\$Required -MutationGuard \$MutationGuard' -and $installTaskText -match 'Sync-RevAgentManagedUpdaterDirectory -SourceRoot \$nasLibRoot' -and $installTaskText -match 'Sync-RevAgentUpdaterConfigDirectory -SourceRoot \$authenticatedConfigSource' -and $installTaskText -match 'Invoke-RevAgentFinalUpdaterSurfaceAttestation' -and $installTaskText -match 'Assert-RevAgentCanonicalManagedInstallBoundary -InstallRoot \$InstallRoot' -and $installTaskText -match 'Open-RevAgentManagedMutationGuard -Path \$InstallRoot -ProtectedPaths @\(\$WorkRoot\) -ExactProtectedPaths' -and $installTaskText -match 'Copy-RevAgentManagedUpdaterToolFile -Source \(Join-Path \$PSScriptRoot "migrate-source-free-install\.ps1"\) -Destination \$localMigrationTool -Required:\$true') "Updater task installer must guard the canonical install-parent boundary, use shared guarded file/tree refresh, and attest before handoff or task registration."
    Assert-True ($installTaskText -match 'Read-RevAgentPendingMachineInstallOutcome' -and $installTaskText -match 'executionSnapshotReleaseSequence' -and $installTaskText -match 'pendingMachineReportValidated' -and $installTaskText -match 'The machine install report was not authenticated for this user-phase process; remote publication was refused') "User-phase installer reporting must consume only the authenticated current machine handoff and refuse unvalidated publication."
    Assert-True ($installTaskText -match 'Read-RevAgentRecoveredMachineFailureEvidence' -and $installTaskText -match 'Could not validate the nested updater machine-failure evidence' -and $installTaskText -match 'updaterMachineRunReport = \$script:RevAgentNestedMachineRunReport' -and $installTaskText -match 'machineEvidenceRecoveryError = \$script:RevAgentMachineEvidenceRecoveryError') "Machine outer catch must preserve validated nested failure diagnostics before replacing its phase result."
    Assert-True ($installTaskText -match 'RevAgent\.DesktopLauncherCleanup\.psm1' -and $installTaskText -match 'Invoke-RevAgentLegacyDesktopLauncherCleanup' -and $installTaskText -match 'desktopLauncherCleanup') "Updater task installer must remove and report legacy revAgent desktop launchers."
    Assert-True ($updaterText -match 'Invoke-InstalledCodexUserIntegration' -and $updaterText -notmatch 'Set-RevAgentCodexMemoryConfig' -and $codexRegistrationText -match 'Set-RevAgentCodexMcpConfigAtomic[\s\S]*Set-RevitMcpTomlScalar -Content \$content -Section ''features'' -Key ''memories''') "Updater must route Codex config and memory settings through the atomic user-integration contract, not a fast/no-op direct writer."
    Assert-True ($updaterText -match 'Set-RevAgentCurrentProcessUtf8Console') "Updater entrypoint must force UTF-8 output even when launched with -NoProfile."
    Assert-True ($updaterText -match 'function Copy-RevAgentManagedUpdaterToolFile' -and $updaterText -match '\[bool\]\$Required = \$true' -and $updaterText -match 'Install-RevAgentManagedUpdaterFile -Source \$Source -Destination \$Destination -Required:\$Required -MutationGuard \$MutationGuard' -and $updaterText -match 'Assert-RevAgentCanonicalManagedInstallBoundary -InstallRoot \$managedInstallRoot' -and $updaterText -match 'Open-RevAgentManagedMutationGuard -Path \$managedInstallRoot -ProtectedPaths @\(\$DestinationRoot\) -ExactProtectedPaths' -and $updaterText -match 'Open-RevAgentManagedMutationGuard -Path \$DestinationRoot' -and $updaterText -match 'Sync-RevAgentManagedUpdaterDirectory -SourceRoot \$libSource' -and $updaterText -match 'Copy-RevAgentManagedUpdaterToolFile -Source \$source -Destination \(Join-Path \$DestinationRoot \$toolName\) -Required:\$true -MutationGuard \$mutationGuard') "Updater fast path must guard the canonical install-parent boundary and use the shared guarded file/tree refresh."
    Assert-True ($updaterText -match 'RevAgent\.DesktopLauncherCleanup\.psm1' -and $updaterText -match 'Invoke-RevAgentLegacyDesktopLauncherCleanup' -and $updaterText -match 'desktopLauncherCleanup') "Updater must remove and report legacy revAgent desktop launchers."
    Assert-True ($updaterText -match 'Remove-CodexProfileBackupArtifacts') "Updater must clean old Codex profile backup artifacts."
    Assert-True ($updaterText -match 'manual-update-audit' -and $updaterText -match '-AuditOnly -NotifyUser' -and $updaterText -match 'Machine updates require the protected local revAgent launcher') "Updater-generated manual helper must be audit-only and route payload changes back to the protected GUI/UAC flow."
    $installerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\install-self-contained.ps1")
    Assert-True ($installerText -match 'machine-only and requires -SkipCodexUserIntegration' -and $installerText -match 'Invoke-revAgent-CodexUserIntegration\.ps1 separately as the original unelevated interactive user') "Self-contained installer must fail closed instead of performing direct user Codex/config/profile writes."
    Assert-True ($installerText -match 'function Assert-RevAgentProtectedInstallerOriginAcl' -and $installerText -match 'function Assert-RevAgentProtectedInstallerOriginFile' -and $installerText -match 'function Import-RevAgentProtectedInstallerModule') "Self-contained installer must validate the protected origin and re-attest every module immediately before import."
    Assert-True ($installerText -match 'CreateRestrictedToken' -and $installerText -match 'FileMode\.CreateNew' -and $installerText -match 'FileMode\.Append' -and $installerText -match 'GetLinkCount' -and $installerText -match 'GetIdentity') "Self-contained protected origin must cover effective create/append, hardlink, and file-identity checks."
    Assert-True ($installerText -match 'New-RevAgentProtectedInstallerSubdirectory' -and $installerText -match 'FileSystemAclExtensions\]::CreateDirectory' -and $installerText -match 'preimport-') "Self-contained origin native helper must compile from an ACL-at-create protected machine temp across PowerShell runtimes."
    Assert-True ($installerText -match 'Set-RevAgentCurrentProcessUtf8Console') "Self-contained installer entrypoint must force UTF-8 output even when launched with -NoProfile."
    Assert-True ($installerText -match 'function Copy-RevAgentManagedUpdaterToolFile' -and $installerText -match '\[bool\]\$Required = \$true' -and $installerText -match 'Install-RevAgentManagedUpdaterFile -Source \$Source -Destination \$Destination -Required:\$Required -MutationGuard \$MutationGuard' -and $installerText -match 'Protect-RevAgentManagedExecutionTree -InstallRoot \$InstallRoot' -and $installerText -match 'Assert-RevAgentCanonicalManagedInstallBoundary -InstallRoot \$managedInstallRoot' -and $installerText -match 'Open-RevAgentManagedMutationGuard -Path \$managedInstallRoot -ProtectedPaths @\(\$DestinationRoot\) -ExactProtectedPaths' -and $installerText -match 'Open-RevAgentManagedMutationGuard -Path \$DestinationRoot' -and $installerText -match 'Sync-RevAgentManagedUpdaterDirectory -SourceRoot \$libSource' -and $installerText -match 'Copy-RevAgentManagedUpdaterToolFile -Source \$source -Destination \(Join-Path \$DestinationRoot \$toolName\) -Required:\$true -MutationGuard \$mutationGuard') "Self-contained installer must protect and guard the canonical install-parent boundary before shared guarded file/tree refresh."
    Assert-True ($installerText -match 'function Stop-RevAgentManagedMcpNodeProcesses' -and $installerText -match 'Name = ''node\.exe''' -and $installerText -match '\$ServerTarget "build\\index\.js"') "Self-contained installer must stop only exact managed runtime MCP node entrypoints before runtime payload replacement."
    Assert-True ($installerText -match 'Invoke-CimMethod -InputObject \$process -MethodName Terminate -Arguments @\{ Reason = \[uint32\]0 \}' -and $installerText -notmatch '\$process\.Terminate\(') "Self-contained installer managed MCP stop must invoke the Win32_Process Terminate method through CIM, not through inert CimInstance methods."
    $installerManagedStopIndex = $installerText.IndexOf('Stop-RevAgentManagedMcpNodeProcesses -EntrypointPaths @((Join-Path $ServerTarget "build\index.js"))')
    $installerCleanupIndex = $installerText.IndexOf('Invoke-RevAgentCleanup -ForUninstall:$Uninstall')
    Assert-True ($installerManagedStopIndex -ge 0 -and $installerCleanupIndex -gt $installerManagedStopIndex) "Self-contained installer must stop managed runtime MCP node processes before runtime cleanup."
    Assert-True ($installerText -match 'RevAgent\.DesktopLauncherCleanup\.psm1' -and $installerText -match 'Invoke-RevAgentLegacyDesktopLauncherCleanup') "Self-contained installer must remove legacy revAgent desktop launchers."
    Assert-True ($installTaskText -notmatch 'legacy Revit MCP launcher shortcut' -and $updaterText -notmatch 'legacy Revit MCP launcher shortcut' -and $installerText -notmatch 'legacy Revit MCP launcher shortcut') "Active installer/updater launcher cleanup messages must use revAgent wording."
    Assert-True ($installerText -match 'Remove-CodexProfileBackupArtifacts') "Installer must clean old Codex profile backup artifacts."
    Assert-True ($installerText -match 'manual-update-audit' -and $installerText -match '-AuditOnly -NotifyUser' -and $installerText -match 'Machine updates require the protected local revAgent launcher') "Installer-generated manual helper must be audit-only and route payload changes back to the protected GUI/UAC flow."
    Assert-True ($installerText -match 'RevAgent\.ConfigSync\.psm1' -and $installerText -match 'Sync-RevAgentUpdaterConfigDirectory -SourceRoot \$configSource -DestinationRoot \(Join-Path \$DestinationRoot "config"\) -MutationGuard \$mutationGuard') "Self-contained installer must use the shared guarded config sync helper."
    Assert-True ($installerText -notmatch 'Remove-Item -LiteralPath \$configDestination -Recurse -Force') "Self-contained installer must not delete local config because that removes pinned release keys."
    Assert-True ($installerText -match 'Copy-RevAgentRuntimeUserPayload') "Installer must copy only the runtime user payload."
    Assert-True ($installerText -match 'Copy-RevAgentDirectoryPayload -Source \(Join-Path \$SourceRoot "schemas"\) -Destination \(Join-Path \$DestinationRoot "schemas"\)') "Installer runtime payload must include every published spatial schema version."
    Assert-True ($installerText -match 'revagent-runtime"\s*,\s*"revit-mcp"') "Installer runtime-directory validation must accept canonical and legacy runtime package identities during rolling updates."
    Assert-True ($installerText -match 'codexUserSourceRoot') "Installer must source Codex orchestration from the user pack."
    Assert-True ($installerText -match 'Resolve-CodexInstructionPolicy' -and $installerText -match 'Codex instructions: preserved local developer instruction surface by policy') "Installer must support preserve-local Codex instruction policy."
    Assert-True ($installerText -match 'Source cleanup\s+: Codex instruction roots skipped by preserve-local policy') "Installer source cleanup must skip Codex instruction roots under preserve-local policy."
    Assert-True ($installerText -match 'if \(-not \$SkipCodexUserIntegration\)' -and $installerText -match '\$managedRoots\.Add\(\$codexSkillTarget\)') "Installer source cleanup must not scan the user Codex skill root when user integration is skipped."
    Assert-True ($installerText -match 'Remove-RevAgentManagedSourceLeakArtifacts') "Installer must clean managed source/developer artifact leaks."
    Assert-True ($installerText -match '\^addons\$') "Installer source cleanup must treat admin add-on folders as non-workstation artifacts."
    Assert-True ($installerText -match 'if \(-not \$SkipRuntimePayloadInstall -and -not \[string\]::IsNullOrWhiteSpace\(\$ServerTarget\)\)' -and $installerText -match 'Test-RevAgentRuntimeDirectory -Path \$ServerTarget') "Installer source cleanup must honor runtime skip and validate ServerTarget before scanning it."
    Assert-True ($installerText -match 'Get-ChildItem -LiteralPath \$root -Recurse -Directory') "Installer source cleanup must recursively scan managed install roots."
    Assert-True ($installerText -match 'Sort-Object \{ \$_.FullName.Length \} -Descending') "Installer source cleanup must remove nested developer directories deepest-first."
    Assert-True ($installerText -match 'Test-RevAgentAllowedManagedDirectory' -and $installerText -match 'installer"\s+-and\s+\$parts\[1\] -ieq "revit-api-docs-mcp"') "Installer source cleanup must preserve allowed docs MCP runtime script directories."
    Assert-True ($installerText -match 'Test-RevAgentIgnoredManagedPath') "Installer source cleanup must use path-component dependency exclusions."
    Assert-True ($installerText -match 'Could not remove managed source/developer artifact directory' -and $installerText -match 'Could not remove managed source/developer artifact file') "Installer source cleanup must warn and continue when cleanup artifacts are locked."
    Assert-True ($installerText -notmatch 'Get-ChildItem -LiteralPath \$repoRoot -Force[\s\S]{0,160}Copy-Item -Destination \$codexMachineSkillTarget') "Installer must not copy the repo root into the Codex skill."
    Assert-True ($installerText -match '\$taskName = "revAgent Auto Update"') "Self-contained installer scheduled-task repair must use the revAgent task name."
    Assert-True ($installerText -match 'DPE\\revAgent' -and $installerText -match 'Remove-LegacyRevitMcpInstallRoot') "Self-contained installer must install under the revAgent root and clean the legacy RevitMCP root."
    Assert-True ($installerText -match 'AllowBroadTarget' -and $installerText -match 'legacy revAgent install root.*-AllowBroadTarget') "Legacy root cleanup must use an explicit broad-target override instead of weakening normal cleanup guards."
    Assert-True ($installerText -notmatch 'Legacy RevitMCP install root cleanup skipped' -and $installerText -notmatch 'legacy RevitMCP install root.*-AllowBroadTarget') "Active legacy-root cleanup logs must use revAgent wording while keeping the RevitMCP path guard."
    Assert-True ($installerText -match 'Update-revAgent-Now\.cmd' -and $installerText -match 'Show-revAgent-Version\.cmd') "Self-contained installer must create revAgent-named updater helper commands."
    Assert-True ($installerText -match 'LegacyNames @\("Revit MCP Auto Update"\)') "Self-contained installer must migrate the legacy Revit MCP task name."
    Assert-True ($installerText -notmatch 'Copy-Item[^\r\n]*AGENTS\.md\.backup-') "Installer must not create AGENTS.md backup files."
    Assert-True ($installerText -notmatch 'Move-Item[^\r\n]*revit-mcp\.backup|codexSkillBackupsRoot') "Installer must not create Codex skill backup directories."
    $dashboardAddonManifest = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\dashboard\addon.json") | ConvertFrom-Json
    $usageAddonManifest = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\usage-intelligence\addon.json") | ConvertFrom-Json
    Assert-Equal $dashboardAddonManifest.installRole "admin" "Dashboard add-on must be admin-scoped."
    Assert-Equal $usageAddonManifest.installRole "admin" "Usage-intelligence add-on must be admin-scoped."
    Assert-Equal ([bool]$dashboardAddonManifest.corePackage) $false "Dashboard add-on must not be part of the core standard user package."
    Assert-Equal ([bool]$usageAddonManifest.corePackage) $false "Usage-intelligence add-on must not be part of the core standard user package."
    $usageSummaryWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\summarize-usage-intelligence.ps1")
    $usagePublishWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\publish-usage-summary.ps1")
    $usageTaskWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-usage-summary-task.ps1")
    $usageLlmReviewPackWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\prepare-llm-review-pack.ps1")
    $usageExportWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\export-codex-session-context.ps1")
    $usageCodexPublishWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\publish-codex-session-context.ps1")
    $usageCodexTaskWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-codex-session-export-task.ps1")
    $usageCorrelationWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\correlate-usage-sessions.ps1")
    $usageAddonInstallerWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-usage-intelligence-addon.ps1")
    Assert-True ($usageSummaryWrapper -match 'addons\\usage-intelligence\\scripts\\summarize-usage-intelligence\.ps1') "Usage summary compatibility wrapper must delegate to the add-on script."
    Assert-True ($usagePublishWrapper -match 'addons\\usage-intelligence\\scripts\\publish-usage-summary\.ps1') "Usage publish compatibility wrapper must delegate to the add-on script."
    Assert-True ($usageTaskWrapper -match 'addons\\usage-intelligence\\scripts\\install-usage-summary-task\.ps1') "Usage task compatibility wrapper must delegate to the add-on script."
    Assert-True ($usageLlmReviewPackWrapper -match 'addons\\usage-intelligence\\scripts\\prepare-llm-review-pack\.ps1') "Usage LLM review pack wrapper must delegate to the add-on script."
    Assert-True ($usageExportWrapper -match 'addons\\usage-intelligence\\scripts\\export-codex-session-context\.ps1') "Usage Codex session export wrapper must delegate to the add-on script."
    Assert-True ($usageCodexPublishWrapper -match 'addons\\usage-intelligence\\scripts\\publish-codex-session-context\.ps1') "Usage Codex session publish wrapper must delegate to the add-on script."
    Assert-True ($usageCodexTaskWrapper -match 'addons\\usage-intelligence\\scripts\\install-codex-session-export-task\.ps1') "Usage Codex session export task wrapper must delegate to the add-on script."
    Assert-True ($usageCorrelationWrapper -match 'addons\\usage-intelligence\\scripts\\correlate-usage-sessions\.ps1') "Usage session correlation wrapper must delegate to the add-on script."
    Assert-Equal $usageAddonManifest.entrypoints.installScript "installer\install-usage-intelligence-addon.ps1" "Usage-intelligence add-on manifest must expose installer entrypoint."
    Assert-Equal $usageAddonManifest.entrypoints.prepareLlmReviewPack "scripts\prepare-llm-review-pack.ps1" "Usage-intelligence add-on manifest must expose LLM review pack preparer."
    Assert-Equal $usageAddonManifest.entrypoints.publishCodexSessionContext "scripts\publish-codex-session-context.ps1" "Usage-intelligence add-on manifest must expose Codex session publisher."
    Assert-Equal $usageAddonManifest.entrypoints.installCodexSessionExportTask "scripts\install-codex-session-export-task.ps1" "Usage-intelligence add-on manifest must expose Codex session export task installer."
    Assert-Equal $usageAddonManifest.entrypoints.exportCodexSessionContext "scripts\export-codex-session-context.ps1" "Usage-intelligence add-on manifest must expose Codex session exporter."
    Assert-Equal $usageAddonManifest.entrypoints.correlateSessions "scripts\correlate-usage-sessions.ps1" "Usage-intelligence add-on manifest must expose session correlator."
    $usageCodexSkills = @($usageAddonManifest.codexSkills)
    Assert-True (@($usageCodexSkills | Where-Object {
                $_.id -eq "revagent-usage-analyst" -and
                $_.source -eq "skills\revagent-usage-analyst" -and
                $_.target -eq "%USERPROFILE%\.codex\skills\revagent-usage-analyst" -and
                $_.installScope -eq "admin-user"
            }).Count -eq 1) "Usage-intelligence add-on manifest must declare the managed usage analyst Codex skill."
    Assert-True ($usageAddonInstallerWrapper -match 'addons\\usage-intelligence\\installer\\install-usage-intelligence-addon\.ps1') "Usage-intelligence add-on installer wrapper must delegate to the add-on installer."
    $report = New-RevAgentUpdateReport -Status "current" -Message "ok" -PreviousVersion "1" -InstalledVersion "1"
    $reportPath = Join-Path $tempRoot "report.json"
    Write-RevAgentJsonFile -Path $reportPath -Value $report
    $reportJson = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
    Assert-Equal $reportJson.app "revAgent" "Report JSON app identity must use revAgent."
    Assert-Equal $reportJson.status "current" "Report JSON status was not written."
    $reportOriginalBytes = [System.IO.File]::ReadAllBytes($reportPath)
    $reportingModule = Get-Module -Name "RevAgent.Reporting" | Select-Object -First 1
    Assert-True ($null -ne $reportingModule) "Reporting module was not loaded for atomic rollback testing."
    & $reportingModule {
        $script:RevAgentTestOriginalReportingPathGuard = ${function:Assert-RevAgentExistingPathNoLink}
        $script:RevAgentTestRejectReportingBackup = $true
        Set-Item -LiteralPath Function:\Assert-RevAgentExistingPathNoLink -Force -Value {
            param(
                [Parameter(Mandatory = $true)][string]$Path,
                [Parameter(Mandatory = $true)][string]$GuardRoot,
                [switch]$RequireLeaf,
                [switch]$RequireLeafSingleLink
            )
            if ($script:RevAgentTestRejectReportingBackup -and $RequireLeafSingleLink -and $Path -like "*.bak") {
                throw "Injected unsafe displaced report backup."
            }
            return & $script:RevAgentTestOriginalReportingPathGuard @PSBoundParameters
        }
    }
    try {
        $replacementReport = New-RevAgentUpdateReport -Status "failed" -Message "must roll back" -PreviousVersion "1" -InstalledVersion "2"
        Assert-ThrowsLike {
            Write-RevAgentJsonFile -Path $reportPath -Value $replacementReport
        } "refused an unsafe displaced destination and restored it" "Reporting atomic rollback must restore the original file after rejecting displaced backup evidence."
    }
    finally {
        & $reportingModule {
            Set-Item -LiteralPath Function:\Assert-RevAgentExistingPathNoLink -Force -Value $script:RevAgentTestOriginalReportingPathGuard
            Remove-Variable -Name RevAgentTestOriginalReportingPathGuard -Scope Script -ErrorAction SilentlyContinue
            Remove-Variable -Name RevAgentTestRejectReportingBackup -Scope Script -ErrorAction SilentlyContinue
        }
    }
    Assert-Equal `
        ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($reportPath))) `
        ([Convert]::ToBase64String($reportOriginalBytes)) `
        "Reporting atomic rollback did not restore the exact original bytes."
    Assert-Equal ([int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($reportPath)) 1 "Restored reporting destination must remain a single-link ordinary file."
    $reportAtomicArtifacts = @(Get-ChildItem -LiteralPath (Split-Path -Parent $reportPath) -Force -File | Where-Object { $_.Name -like ".report.json.*" })
    Assert-Equal $reportAtomicArtifacts.Count 0 "Successful reporting rollback left a temporary, backup, or restore-discard artifact."
    $reportingText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.Reporting.psm1")
    Assert-True ($reportingText -match 'app = "revAgent"' -and $reportingText -notmatch 'app = "revit-mcp-skill"') "Machine report helper must default to the revAgent app identity."
    Assert-True ($reportingText -match '\$operationLatestPath = Join-Path \$machineRoot \("\{0\}-latest\.json" -f \$safeOperation\)' -and $reportingText -match 'Write-RevitMcpJsonFile -Path \$operationLatestPath -Value \$published') "Machine report publishing must emit operation-specific latest files used by dashboard version fallback."
    Assert-True ($reportingText -match 'Remote report publishing is forbidden in an elevated process' -and $reportingText -match 'FileMode\]::CreateNew' -and $reportingText -match 'File\]::Replace' -and $reportingText -match 'GetLinkCount') "Remote reporting must reject elevation and use create-new atomic writes with hardlink checks."
    Assert-True ($reportingText -match '\[System\.IO\.File\]::Replace\(\$backupPath,\s*\$fullPath,\s*\$restoreDiscardPath,\s*\$true\)' -and $reportingText -notmatch '\[System\.IO\.File\]::Replace\([^\r\n]*\$null' -and $reportingText -match 'restoration failed; recovery artifacts were preserved') "Report rollback must use a PS5-compatible non-null same-directory discard path and preserve partial-failure recovery evidence."
    Assert-True ($reportingText -notmatch 'Copy-Item -LiteralPath \$LogPath' -and $reportingText -notmatch 'Set-Content -LiteralPath \$Path') "Remote reporting must not use direct Copy-Item or Set-Content writes."
    $safePathCases = @(
        @{ input = "HAFIZE"; expected = "HAFIZE" },
        @{ input = "MARINA"; expected = "MARINA" },
        @{ input = "HAFİZE"; expected = "HAFİZE" },
        @{ input = "MARİNA"; expected = "MARİNA" },
        @{ input = "office machine/name"; expected = "office_machine_name" }
    )
    foreach ($case in $safePathCases) {
        Assert-Equal (ConvertTo-RevAgentSafePathSegment -Value $case.input -Fallback "fallback") $case.expected "Safe path segment conversion must preserve machine names across Turkish culture-sensitive letters."
    }
    $remoteReportsRoot = Join-Path $tempRoot "reports"
    New-Item -ItemType Directory -Path $remoteReportsRoot -Force | Out-Null
    $localReportSourceRoot = Join-Path $tempRoot "local-report-source"
    New-Item -ItemType Directory -Path $localReportSourceRoot -Force | Out-Null
    $operationLog = Join-Path $localReportSourceRoot "install.log"
    Set-Content -LiteralPath $operationLog -Value "Operation method : gui-install" -Encoding ASCII
    Publish-RevAgentMachineRunReport -ReportsRoot $remoteReportsRoot -Report $report -Operation "install" -OperationMethod "gui-install" -LogPath $operationLog -LocalLogAllowedRoot $localReportSourceRoot -KeepLastLogs 2 -WriteCompatibilityReport | Out-Null
    $safeComputer = ConvertTo-RevAgentSafePathSegment -Value $env:COMPUTERNAME -Fallback "unknown-computer"
    $safeUser = ConvertTo-RevAgentSafePathSegment -Value $env:USERNAME -Fallback "unknown-user"
    $machineLatest = Join-Path $remoteReportsRoot ("machines\{0}\latest.json" -f $safeComputer)
    Assert-True (Test-Path -LiteralPath $machineLatest -PathType Leaf) "Machine latest report must be written under reports\\machines\\<computer>."
    $machineReport = Get-Content -Raw -LiteralPath $machineLatest | ConvertFrom-Json
    Assert-Equal $machineReport.operationMethod "gui-install" "Machine report must record operationMethod."
    Assert-True (Test-Path -LiteralPath (Join-Path $remoteReportsRoot ("machines\{0}\install-latest.json" -f $safeComputer)) -PathType Leaf) "Operation latest report must preserve dashboard fallback semantics."
    Assert-True (Test-Path -LiteralPath (Join-Path $remoteReportsRoot ("{0}_{1}.json" -f $safeComputer, $safeUser)) -PathType Leaf) "Compatibility latest report must preserve the legacy dashboard path."
    $machineLogsRoot = Join-Path $remoteReportsRoot ("machines\{0}\logs" -f $safeComputer)
    Assert-Equal (@(Get-ChildItem -LiteralPath $machineLogsRoot -File -Filter "*.log").Count) 1 "Machine report log must be copied to NAS report storage."

    for ($publishIndex = 1; $publishIndex -le 3; $publishIndex++) {
        Set-Content -LiteralPath $operationLog -Value ("Operation method : gui-install {0}" -f $publishIndex) -Encoding ASCII
        Publish-RevAgentMachineRunReport -ReportsRoot $remoteReportsRoot -Report $report -Operation "install" -OperationMethod "gui-install" -LogPath $operationLog -LocalLogAllowedRoot $localReportSourceRoot -KeepLastLogs 2 -WriteCompatibilityReport | Out-Null
    }
    Assert-Equal (@(Get-ChildItem -LiteralPath $machineLogsRoot -File -Filter "*.log").Count) 2 "Bounded remote retention must keep exactly the latest two safe logs."
    $guardedRead = Read-RevAgentJsonReportFile -Path $machineLatest -AllowedRoot $remoteReportsRoot
    Assert-Equal $guardedRead.operation "install" "Guarded JSON report reads must preserve the published operation."

    $junctionReportsRoot = Join-Path $tempRoot "reports-junction-guard"
    $junctionOutsideRoot = Join-Path $tempRoot "reports-junction-outside"
    New-Item -ItemType Directory -Path $junctionReportsRoot, $junctionOutsideRoot -Force | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $junctionReportsRoot "machines") -Target $junctionOutsideRoot | Out-Null
    Assert-ThrowsLike -Pattern 'link/reparse' -Message "Report publishing must reject a junction below ReportsRoot." -Action {
        Publish-RevAgentMachineRunReport -ReportsRoot $junctionReportsRoot -Report $report -Operation "install" | Out-Null
    }
    Assert-Equal @(Get-ChildItem -LiteralPath $junctionOutsideRoot -Force).Count 0 "Rejected report junctions must not mutate their external target."

    $hardlinkReportsRoot = Join-Path $tempRoot "reports-hardlink-guard"
    $hardlinkMachineRoot = Join-Path $hardlinkReportsRoot ("machines\{0}" -f $safeComputer)
    New-Item -ItemType Directory -Path $hardlinkMachineRoot -Force | Out-Null
    $outsideLatest = Join-Path $tempRoot "outside-latest.json"
    Set-Content -LiteralPath $outsideLatest -Value '{"sentinel":true}' -Encoding ASCII
    New-Item -ItemType HardLink -Path (Join-Path $hardlinkMachineRoot "latest.json") -Target $outsideLatest | Out-Null
    Assert-ThrowsLike -Pattern '(hard-linked|link/reparse)' -Message "Report publishing must reject a hard-linked latest file." -Action {
        Publish-RevAgentMachineRunReport -ReportsRoot $hardlinkReportsRoot -Report $report -Operation "install" | Out-Null
    }
    Assert-True ((Get-Content -Raw -LiteralPath $outsideLatest) -match 'sentinel') "Rejected hard-linked latest files must not mutate the external file."

    $hardlinkLogReportsRoot = Join-Path $tempRoot "reports-hardlink-log-guard"
    $hardlinkLogSourceRoot = Join-Path $tempRoot "local-hardlink-log-source"
    New-Item -ItemType Directory -Path $hardlinkLogReportsRoot, $hardlinkLogSourceRoot -Force | Out-Null
    $outsideLog = Join-Path $tempRoot "outside-log.txt"
    Set-Content -LiteralPath $outsideLog -Value "outside sentinel" -Encoding ASCII
    $hardlinkLog = Join-Path $hardlinkLogSourceRoot "install.log"
    New-Item -ItemType HardLink -Path $hardlinkLog -Target $outsideLog | Out-Null
    Assert-ThrowsLike -Pattern '(hard-linked|link/reparse)' -Message "Report publishing must reject a hard-linked local log source." -Action {
        Publish-RevAgentMachineRunReport -ReportsRoot $hardlinkLogReportsRoot -Report $report -Operation "install" -LogPath $hardlinkLog -LocalLogAllowedRoot $hardlinkLogSourceRoot | Out-Null
    }
    Assert-Equal (Get-Content -Raw -LiteralPath $outsideLog).Trim() "outside sentinel" "Rejected hard-linked log sources must not mutate the external file."

    Write-Host "Test updater log retention"
    $logsRoot = Join-Path $tempRoot "logs-retention"
    New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null
    for ($i = 1; $i -le 15; $i++) {
        $path = Join-Path $logsRoot ("update-{0:00}.log" -f $i)
        Set-Content -LiteralPath $path -Value ("log {0}" -f $i) -Encoding ASCII
        (Get-Item -LiteralPath $path).LastWriteTimeUtc = [datetime]::UtcNow.AddMinutes(-1 * (15 - $i))
    }
    Invoke-RevAgentLogRetention -LogsRoot $logsRoot -KeepLast 10 -ActiveLogPath (Join-Path $logsRoot "update-15.log")
    $remainingLogs = @(Get-ChildItem -LiteralPath $logsRoot -File -Filter "*.log" | Sort-Object Name | Select-Object -ExpandProperty Name)
    Assert-Equal $remainingLogs.Count 10 "Log retention must keep exactly the latest 10 log files."
    Assert-True ($remainingLogs -contains "update-15.log") "Log retention must keep the active/latest log file."
    Assert-True (-not ($remainingLogs -contains "update-01.log")) "Log retention must remove old log files."
    $backupRoot = Join-Path $tempRoot "backup-retention"
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    for ($i = 1; $i -le 6; $i++) {
        $path = Join-Path $backupRoot ("revit-mcp-skill.backup-{0:00}" -f $i)
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        (Get-Item -LiteralPath $path).LastWriteTimeUtc = [datetime]::UtcNow.AddMinutes(-1 * (6 - $i))
    }
    Invoke-RevAgentDirectoryRetention -Root $backupRoot -Filter "revit-mcp-skill.backup-*" -KeepLast 3
    $remainingBackups = @(Get-ChildItem -LiteralPath $backupRoot -Directory -Filter "revit-mcp-skill.backup-*" | Sort-Object Name | Select-Object -ExpandProperty Name)
    Assert-Equal $remainingBackups.Count 3 "Backup retention must keep exactly the latest 3 package backup folders."
    Assert-True ($remainingBackups -contains "revit-mcp-skill.backup-06") "Backup retention must keep the latest package backup folder."
    Assert-True (-not ($remainingBackups -contains "revit-mcp-skill.backup-01")) "Backup retention must remove old package backup folders."

    Write-Host "Test revAgent clean-install transition backup reset"
    $transitionBackupRoot = Join-Path $tempRoot "transition-backups"
    $transitionCacheRoot = Join-Path $tempRoot "transition-cache"
    New-Item -ItemType Directory -Path (Join-Path $transitionBackupRoot "revit-mcp-skill.backup-old\package") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $transitionBackupRoot "manual-backup") -Force | Out-Null
    New-Item -ItemType Directory -Path $transitionCacheRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $transitionBackupRoot "leftover.txt") -Value "old" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $transitionCacheRoot "revit-mcp-skill-old.zip") -Value "zip" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $transitionCacheRoot "keep.txt") -Value "keep" -Encoding ASCII
    $transitionReset = Invoke-RevAgentBackupRootReset -BackupRoot $transitionBackupRoot -CacheRoot $transitionCacheRoot
    Assert-Equal $transitionReset.failedBackupItemCount 0 "Transition backup reset must not fail on temp backup content."
    Assert-Equal $transitionReset.removedBackupItemCount 3 "Transition backup reset must remove all backup root children."
    Assert-Equal @(Get-ChildItem -LiteralPath $transitionBackupRoot -Force).Count 0 "Transition backup root must be empty after reset."
    Assert-Equal @(Get-ChildItem -LiteralPath $transitionCacheRoot -File -Filter "revit-mcp-skill-*.zip").Count 0 "Transition reset must clear stale release cache zips."
    Assert-True (Test-Path -LiteralPath (Join-Path $transitionCacheRoot "keep.txt") -PathType Leaf) "Transition reset must leave unrelated cache files alone."

    $updaterTextForCleanInstall = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
    Assert-True ($updaterTextForCleanInstall -match 'revagent-clean-install-transition\.json') "Updater must persist a one-time revAgent clean-install transition marker."
    Assert-True ($updaterTextForCleanInstall -match 'Test-RevAgentCleanInstallTransitionRequired') "Updater must decide when the revAgent clean-install transition is required."
    Assert-True ($updaterTextForCleanInstall -match 'Invoke-RevAgentBackupRootReset') "Updater must clear package backups through the workstation local-backup policy."
    Assert-True ($updaterTextForCleanInstall -match 'packageBackupSkipped') "Updater state/report diagnostics must expose skipped local package backup behavior."
    Assert-True ($updaterTextForCleanInstall -match 'Remove-Item -LiteralPath \$PackageTarget -Recurse -Force') "Updater must remove the previous managed package directly without retaining a local package backup."

    Write-Host "Installer/updater smoke tests passed." -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
