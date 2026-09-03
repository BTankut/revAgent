<#
.SYNOPSIS
    EU-20/M6 (P3-T10) cutover uninstaller for the revAgent Bridge: removes
    the E4/P-INST-3 machine wipe-list, structurally preserves the three
    P-SEQ-2 rollback anchors, applies the bounded two-section Codex MCP
    config edit, and emits wipe-report.json. Idempotent re-run;
    -WhatIf/-DryRun performs zero mutations.

.DESCRIPTION
    This script is repo-preparation for EU-20: the true gate (destructive
    lab-machine removal) is NOT exercised here and is not granted. Run only
    against redirected roots in a non-machine-mutating test/dry-run context
    unless you are the operator executing the gated lab session.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ProgramDataRoot = $env:ProgramData,
    [string]$LocalAppDataRoot = $env:LOCALAPPDATA,
    [string]$CodexConfigPath = '',
    [string]$InstallRoot = '',
    [string]$StateRoot = '',
    [string]$MachineReportPath = '',
    [switch]$DryRun,
    [switch]$SkipScheduledTaskRemoval,
    [switch]$SkipServiceRemoval
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Import-Module (Join-Path $PSScriptRoot 'lib\RevAgent.BridgeInstall.psm1') -Force
Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.Reporting.psm1') -Force
Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.CodexRegistration.psm1') -Force

$isDryRun = [bool]$DryRun -or ($WhatIfPreference -eq $true)
$startedAtUtc = (Get-Date).ToUniversalTime()
$steps = [System.Collections.Generic.List[object]]::new()
$reportStatus = 'success'
$reportMessage = 'Uninstall completed.'
$errors = [System.Collections.Generic.List[string]]::new()

function Get-BridgeLayoutArgs {
    $layoutArgs = @{}
    if ($InstallRoot) { $layoutArgs.InstallRoot = $InstallRoot }
    if ($StateRoot) { $layoutArgs.StateRoot = $StateRoot }
    return $layoutArgs
}

$anchors = Get-RevAgentBridgeRollbackAnchors -ProgramDataRoot $ProgramDataRoot
$keepList = Get-RevAgentBridgeKeepList -ProgramDataRoot $ProgramDataRoot
$anchorHashesBefore = Get-RevAgentBridgeAnchorHashes -Anchors $anchors

$uninstallSummary = [ordered]@{
    scheduledTasks   = @()
    legacyTrees       = @()
    codexConfig       = $null
    anchors           = @()
    serviceRemoved    = $false
}

try {
    $bridgeLayoutArgs = Get-BridgeLayoutArgs
    $layout = Get-RevAgentBridgeLayout @bridgeLayoutArgs

    # --- 1. Managed scheduled tasks (named exactly, per E4/P-INST-3) ---
    if (-not $SkipScheduledTaskRemoval) {
        foreach ($taskName in Get-RevAgentBridgeManagedScheduledTaskNames) {
            $taskExists = $false
            try {
                $taskExists = ($null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue))
            }
            catch { $taskExists = $false }

            if (-not $taskExists) {
                $uninstallSummary.scheduledTasks += [pscustomobject][ordered]@{ name = $taskName; found = $false; disposition = 'not_found' }
                continue
            }

            $record = Invoke-RevAgentBridgeGuardedMutation -Target $taskName -MutationAction 'remove_scheduled_task' -DryRun $isDryRun -Steps $steps -Apply {
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
                return 'removed'
            }.GetNewClosure()
            $uninstallSummary.scheduledTasks += [pscustomobject][ordered]@{ name = $taskName; found = $true; disposition = $record.status }
        }
    }

    # --- 2. Windows service (revAgentBridge) ---
    if (-not $SkipServiceRemoval) {
        $serviceExists = $false
        try { $serviceExists = ($null -ne (Get-Service -Name $layout.ServiceName -ErrorAction SilentlyContinue)) } catch { $serviceExists = $false }
        if ($serviceExists) {
            [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.ServiceName -MutationAction 'stop_service' -DryRun $isDryRun -Steps $steps -Apply {
                    Stop-Service -Name $layout.ServiceName -Force -ErrorAction SilentlyContinue
                    return 'stopped'
                })
            $record = Invoke-RevAgentBridgeGuardedMutation -Target $layout.ServiceName -MutationAction 'unregister_service' -DryRun $isDryRun -Steps $steps -Apply {
                if (Test-Path -LiteralPath $layout.HostExecutablePath -PathType Leaf) {
                    $output = & $layout.HostExecutablePath 'uninstall' 2>&1
                    if ($LASTEXITCODE -ne 0) { throw "bridge_host_uninstall_failed: exit=$LASTEXITCODE output=$output" }
                }
                else {
                    & sc.exe delete $layout.ServiceName | Out-Null
                }
                return 'unregistered'
            }
            $uninstallSummary.serviceRemoved = ($record.status -eq 'applied')
        }
    }

    # --- 3. Legacy machine trees, with the P-SEQ-2 anchors structurally excluded ---
    foreach ($target in (Get-RevAgentBridgeLegacyRemovalTargets -ProgramDataRoot $ProgramDataRoot -LocalAppDataRoot $LocalAppDataRoot)) {
        if (-not (Test-Path -LiteralPath $target)) {
            $uninstallSummary.legacyTrees += [pscustomobject][ordered]@{ root = $target; found = $false; items = @() }
            continue
        }

        # No separate dry-run branch here: Invoke-RevAgentBridgeTreeWipePlan
        # routes every per-item removal through Invoke-RevAgentBridgeGuardedMutation
        # (passing this same $steps list), which is the only place DryRun is
        # gated. Under -DryRun this call performs zero deletions and every
        # planned removal comes back as 'would_remove'.
        $plan = Get-RevAgentBridgeTreeWipePlan -Root $target -Anchors $anchors
        $itemResults = Invoke-RevAgentBridgeTreeWipePlan -Plan $plan -DryRun $isDryRun -Steps $steps
        $failed = @($itemResults | Where-Object { $_.disposition -eq 'failed' })
        if (-not $isDryRun -and $failed.Count -gt 0) {
            throw "legacy_tree_wipe_incomplete: $($failed.Count) item(s) under $target could not be removed."
        }
        $uninstallSummary.legacyTrees += [pscustomobject][ordered]@{ root = $target; found = $true; items = $itemResults }
    }

    # --- 4. Bounded Codex config edit: exactly the two managed legacy sections ---
    if ($CodexConfigPath) {
        $codexResult = Remove-RevAgentBridgeManagedCodexSections -ConfigPath $CodexConfigPath -DryRun $isDryRun
        $uninstallSummary.codexConfig = $codexResult
        [void]$steps.Add([pscustomobject][ordered]@{
                target = $CodexConfigPath
                action = 'remove_managed_codex_sections'
                status = if ($isDryRun) { 'skipped_dry_run' } else { 'applied' }
                detail = "sectionsRemoved=$($codexResult.sectionsRemoved -join ',')"
            })
    }

    # --- 5. Anchor preservation proof (hash-before == hash-after) ---
    $anchorHashesAfter = Get-RevAgentBridgeAnchorHashes -Anchors $anchors
    foreach ($anchor in $anchors) {
        $before = $anchorHashesBefore.$anchor
        $after = $anchorHashesAfter.$anchor
        $preserved = ($before -eq $after)
        $uninstallSummary.anchors += [pscustomobject][ordered]@{
            path        = $anchor
            hashBefore   = $before
            hashAfter    = $after
            preserved    = $preserved
        }
        if (-not $preserved) {
            throw "rollback_anchor_changed: $anchor changed during uninstall (before=$before after=$after)."
        }
    }

    $reportMessage = if ($isDryRun) { 'Dry run completed; zero mutations performed.' } else { 'Uninstall completed.' }
}
catch {
    $reportStatus = 'failed'
    $reportMessage = $_.Exception.Message
    [void]$errors.Add($_.Exception.Message)
}

$completedAtUtc = (Get-Date).ToUniversalTime()
$report = New-RevAgentBridgeMachineReport `
    -Action 'uninstall' `
    -DryRun $isDryRun `
    -StartedAtUtc $startedAtUtc `
    -CompletedAtUtc $completedAtUtc `
    -Status $reportStatus `
    -Message $reportMessage `
    -Steps $steps `
    -Uninstall ([pscustomobject]$uninstallSummary) `
    -Errors $errors.ToArray()

try {
    $reportLayoutArgs = Get-BridgeLayoutArgs
    $layoutForReport = Get-RevAgentBridgeLayout @reportLayoutArgs
    $reportsDirectory = if (Test-Path -LiteralPath $layoutForReport.StateRoot) { $layoutForReport.ReportsDirectory } else { $null }
    if ($reportsDirectory) {
        [void](Write-RevAgentBridgeMachineReport -Report $report -ReportsDirectory $reportsDirectory -DryRun $isDryRun)
    }
}
catch {
    [void]$errors.Add("report_persistence_failed: $($_.Exception.Message)")
}

if ($MachineReportPath) {
    $reportJson = ($report | ConvertTo-Json -Depth 10)
    $reportDirectory = Split-Path -Parent $MachineReportPath
    if ($reportDirectory -and -not (Test-Path -LiteralPath $reportDirectory)) {
        [void](New-Item -ItemType Directory -Path $reportDirectory -Force)
    }
    Set-Content -LiteralPath $MachineReportPath -Value $reportJson -Encoding UTF8
}

Write-Output ([pscustomobject]$report)

if ($reportStatus -ne 'success') {
    throw $reportMessage
}
