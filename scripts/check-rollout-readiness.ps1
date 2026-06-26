<#
.SYNOPSIS
    Read NAS release and machine reports to summarize office rollout readiness.

.DESCRIPTION
    This is a read-only audit helper. It does not update workstations, run
    migration, connect over SSH, or write to NAS unless -OutputPath is provided.
    It combines the stable channel manifest, per-machine install/update
    reports, optional source-free migration reports, copied operation logs, and
    live heartbeat files into a compact action list.
#>

[CmdletBinding()]
param(
    [string]$ReleaseRoot = "",

    [string]$ReportsRoot = "",

    [string[]]$ExpectedMachines = @(),

    [string[]]$OutOfScopeMachines = @(),

    [int]$StaleSeconds = 60,

    [int]$OfflineSeconds = 300,

    [string]$OutputPath = "",

    [switch]$OutputJson
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$defaultReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"

if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    if (-not [string]::IsNullOrWhiteSpace($env:REVAGENT_RELEASE_ROOT)) {
        $ReleaseRoot = $env:REVAGENT_RELEASE_ROOT
    }
    else {
        $ReleaseRoot = $defaultReleaseRoot
    }
}
if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
    if (-not [string]::IsNullOrWhiteSpace($env:REVAGENT_REPORTS_ROOT)) {
        $ReportsRoot = $env:REVAGENT_REPORTS_ROOT
    }
    else {
        $ReportsRoot = Join-Path $ReleaseRoot "reports"
    }
}

function Normalize-RevAgentMachineName {
    param([string]$Value)

    return ([string]$Value).Trim().ToUpperInvariant()
}

function Expand-RevAgentMachineNames {
    param([string[]]$Values)

    $expanded = [System.Collections.Generic.List[string]]::new()
    foreach ($value in $Values) {
        if ([string]::IsNullOrWhiteSpace($value)) {
            continue
        }
        foreach ($part in ([string]$value -split '[,;]')) {
            $normalized = Normalize-RevAgentMachineName -Value $part
            if (-not [string]::IsNullOrWhiteSpace($normalized)) {
                [void]$expanded.Add($normalized)
            }
        }
    }
    return @($expanded.ToArray())
}

function Get-RevAgentValue {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) {
        return $null
    }
    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
        return $Object[$Name]
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Get-RevAgentNestedValue {
    param(
        [object]$Object,
        [string[]]$Path
    )

    $current = $Object
    foreach ($part in $Path) {
        $current = Get-RevAgentValue -Object $current -Name $part
        if ($null -eq $current) {
            return $null
        }
    }
    return $current
}

function Read-RevAgentJsonFile {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        return [pscustomobject][ordered]@{
            readError = $_.Exception.Message
            path = $Path
        }
    }
}

function ConvertTo-RevAgentInt {
    param(
        [object]$Value,
        [int]$Fallback = 0
    )

    if ($null -eq $Value) {
        return $Fallback
    }
    $text = [string]$Value
    $parsed = 0
    if ([int]::TryParse($text, [ref]$parsed)) {
        return $parsed
    }
    return $Fallback
}

function ConvertTo-RevAgentBool {
    param(
        [object]$Value,
        [bool]$Fallback = $false
    )

    if ($null -eq $Value) {
        return $Fallback
    }
    if ($Value -is [bool]) {
        return [bool]$Value
    }
    $text = ([string]$Value).Trim()
    if ([string]::Equals($text, "true", [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    if ([string]::Equals($text, "false", [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    return $Fallback
}

function ConvertTo-RevAgentUtcMs {
    param([object]$Value)

    if ($null -eq $Value) {
        return $null
    }
    $date = [datetime]::MinValue
    if ([datetime]::TryParse([string]$Value, [ref]$date)) {
        return [int64]($date.ToUniversalTime() - [datetime]"1970-01-01T00:00:00Z").TotalMilliseconds
    }
    return $null
}

function Get-RevAgentInstalledVersion {
    param([object]$Report)

    $paths = @(
        , @("installedVersion"),
        , @("localInstall", "version"),
        , @("installedState", "version")
    )
    foreach ($path in $paths) {
        $value = Get-RevAgentNestedValue -Object $Report -Path $path
        if (-not [string]::IsNullOrWhiteSpace([string]$value)) {
            return [string]$value
        }
    }
    return ""
}

function Get-RevAgentTargetVersion {
    param([object]$Report)

    $paths = @(
        , @("targetVersion"),
        , @("release", "version"),
        , @("channel", "version")
    )
    foreach ($path in $paths) {
        $value = Get-RevAgentNestedValue -Object $Report -Path $path
        if (-not [string]::IsNullOrWhiteSpace([string]$value)) {
            return [string]$value
        }
    }
    return ""
}

function Get-RevAgentReportTimestampMs {
    param([object]$Report)

    $paths = @(
        , @("atUtc"),
        , @("reportedAtUtc"),
        , @("publishedAtUtc"),
        , @("machineReport", "publishedAtUtc"),
        , @("finishedAtUtc"),
        , @("startedAtUtc")
    )
    foreach ($path in $paths) {
        $value = Get-RevAgentNestedValue -Object $Report -Path $path
        $ms = ConvertTo-RevAgentUtcMs -Value $value
        if ($null -ne $ms) {
            return $ms
        }
    }
    return [int64]0
}

function Test-RevAgentSuccessfulVersionReport {
    param([object]$Report)

    $successStatuses = @("completed", "current", "installed", "reinstalled", "repaired", "success", "succeeded", "updated")
    $status = ([string](Get-RevAgentValue -Object $Report -Name "status")).ToLowerInvariant()
    return (-not [string]::IsNullOrWhiteSpace((Get-RevAgentInstalledVersion -Report $Report)) -and $successStatuses -contains $status)
}

function Select-RevAgentVersionReport {
    param(
        [object]$PrimaryReport,
        [object[]]$CandidateReports
    )

    if (-not [string]::IsNullOrWhiteSpace((Get-RevAgentInstalledVersion -Report $PrimaryReport))) {
        return $PrimaryReport
    }

    $matches = @($CandidateReports | Where-Object { Test-RevAgentSuccessfulVersionReport -Report $_ } |
        Sort-Object @{ Expression = { Get-RevAgentReportTimestampMs -Report $_ }; Descending = $true })
    if ($matches.Count -gt 0) {
        return $matches[0]
    }
    return $PrimaryReport
}

function Get-RevAgentLogEvidence {
    param(
        [object]$Report,
        [string]$MachineRoot
    )

    $candidatePaths = [System.Collections.Generic.List[string]]::new()
    $reportLogPath = [string](Get-RevAgentNestedValue -Object $Report -Path @("machineReport", "logPath"))
    if (-not [string]::IsNullOrWhiteSpace($reportLogPath)) {
        [void]$candidatePaths.Add($reportLogPath)
    }
    $topLogPath = [string](Get-RevAgentValue -Object $Report -Name "logPath")
    if (-not [string]::IsNullOrWhiteSpace($topLogPath)) {
        [void]$candidatePaths.Add($topLogPath)
    }

    $logsRoot = Join-Path $MachineRoot "logs"
    if (Test-Path -LiteralPath $logsRoot -PathType Container) {
        Get-ChildItem -LiteralPath $logsRoot -File -Filter "*.log" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 3 |
            ForEach-Object { [void]$candidatePaths.Add($_.FullName) }
    }

    foreach ($path in @($candidatePaths.ToArray() | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            continue
        }
        try {
            $content = Get-Content -Raw -LiteralPath $path -Encoding UTF8
            $match = [regex]::Match($content, 'Source verify\s*:\s*remaining managed source/developer artifact item\(s\):\s*(\d+);\s*cleanup failures:\s*(\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if ($match.Success) {
                return [pscustomobject][ordered]@{
                    source = "log"
                    path = $path
                    remainingCount = [int]$match.Groups[1].Value
                    failedCount = [int]$match.Groups[2].Value
                }
            }
        }
        catch {
            return [pscustomobject][ordered]@{
                source = "log"
                path = $path
                readError = $_.Exception.Message
                remainingCount = $null
                failedCount = $null
            }
        }
    }

    return $null
}

function Get-RevAgentSourceFreeEvidenceFromReport {
    param(
        [object]$Report,
        [string]$SourceName
    )

    if ($null -eq $Report) {
        return $null
    }

    $diagnostics = Get-RevAgentNestedValue -Object $Report -Path @("diagnostics", "sourceFreeMigration")
    if ($null -ne $diagnostics) {
        $enabled = ConvertTo-RevAgentBool -Value (Get-RevAgentValue -Object $diagnostics -Name "enabled")
        $remaining = ConvertTo-RevAgentInt -Value (Get-RevAgentValue -Object $diagnostics -Name "postCleanupRemainingCount") -Fallback -1
        $failed = ConvertTo-RevAgentInt -Value (Get-RevAgentValue -Object $diagnostics -Name "postCleanupFailedCount") -Fallback -1
        if ($enabled -or $remaining -ge 0 -or $failed -ge 0) {
            return [pscustomobject][ordered]@{
                source = $SourceName
                shape = "update-diagnostics"
                verified = ($remaining -eq 0 -and $failed -eq 0)
                failed = ($remaining -gt 0 -or $failed -gt 0)
                remainingCount = $remaining
                failedCount = $failed
            }
        }
    }

    $tool = [string](Get-RevAgentValue -Object $Report -Name "tool")
    $afterCountValue = Get-RevAgentNestedValue -Object $Report -Path @("after", "artifactCount")
    if ([string]::Equals($tool, "source-free-migration", [System.StringComparison]::OrdinalIgnoreCase) -or $null -ne $afterCountValue) {
        $afterCount = ConvertTo-RevAgentInt -Value $afterCountValue -Fallback -1
        $success = ConvertTo-RevAgentBool -Value (Get-RevAgentValue -Object $Report -Name "success")
        if ($afterCount -ge 0) {
            return [pscustomobject][ordered]@{
                source = $SourceName
                shape = "migration-report"
                verified = ($success -and $afterCount -eq 0)
                failed = (-not $success -or $afterCount -gt 0)
                remainingCount = $afterCount
                failedCount = 0
            }
        }
    }

    return $null
}

function Resolve-RevAgentSourceFreeEvidence {
    param(
        [object[]]$Reports,
        [string]$MachineRoot
    )

    foreach ($entry in $Reports) {
        $evidence = Get-RevAgentSourceFreeEvidenceFromReport -Report $entry.Report -SourceName $entry.Name
        if ($null -ne $evidence) {
            return $evidence
        }
    }

    foreach ($entry in $Reports) {
        $logEvidence = Get-RevAgentLogEvidence -Report $entry.Report -MachineRoot $MachineRoot
        if ($null -ne $logEvidence -and $null -ne $logEvidence.remainingCount -and $null -ne $logEvidence.failedCount) {
            return [pscustomobject][ordered]@{
                source = "log:$($entry.Name)"
                shape = "log-source-verify"
                verified = ([int]$logEvidence.remainingCount -eq 0 -and [int]$logEvidence.failedCount -eq 0)
                failed = ([int]$logEvidence.remainingCount -gt 0 -or [int]$logEvidence.failedCount -gt 0)
                remainingCount = [int]$logEvidence.remainingCount
                failedCount = [int]$logEvidence.failedCount
                path = $logEvidence.path
            }
        }
    }

    return $null
}

function Get-RevAgentConnectionState {
    param(
        [object]$LiveStatus,
        [datetime]$NowUtc
    )

    $heartbeat = Get-RevAgentValue -Object $LiveStatus -Name "lastHeartbeatUtc"
    $heartbeatMs = ConvertTo-RevAgentUtcMs -Value $heartbeat
    if ($null -eq $heartbeatMs) {
        return "offline"
    }
    $nowMs = [int64]($NowUtc - [datetime]"1970-01-01T00:00:00Z").TotalMilliseconds
    $ageSeconds = [math]::Max(0, [math]::Round(($nowMs - $heartbeatMs) / 1000))
    if ($ageSeconds -le $StaleSeconds) {
        return "online"
    }
    if ($ageSeconds -le $OfflineSeconds) {
        return "stale"
    }
    return "offline"
}

function Get-RevAgentHeartbeatAgeSeconds {
    param(
        [object]$LiveStatus,
        [datetime]$NowUtc
    )

    $heartbeat = Get-RevAgentValue -Object $LiveStatus -Name "lastHeartbeatUtc"
    $heartbeatMs = ConvertTo-RevAgentUtcMs -Value $heartbeat
    if ($null -eq $heartbeatMs) {
        return $null
    }
    $nowMs = [int64]($NowUtc - [datetime]"1970-01-01T00:00:00Z").TotalMilliseconds
    return [int][math]::Max(0, [math]::Round(($nowMs - $heartbeatMs) / 1000))
}

function Get-RevAgentAction {
    param(
        [string]$VersionState,
        [string]$SourceFreeState,
        [string]$UpdateState,
        [bool]$Excluded
    )

    if ($Excluded) {
        return "excluded"
    }
    if ($UpdateState -eq "failed") {
        return "inspect_failed_update_log"
    }
    if ($UpdateState -eq "pendingRestart") {
        return "close_revit_and_rerun_update"
    }
    if ($VersionState -eq "outdated") {
        return "run_stable_update"
    }
    if ($VersionState -eq "unknown") {
        return "collect_install_report_or_update"
    }
    if ($SourceFreeState -eq "failed") {
        return "rerun_source_free_migration"
    }
    if ($SourceFreeState -eq "needsEvidence") {
        return "run_source_free_dry_run_inventory"
    }
    return "none"
}

function Select-RevAgentFirstText {
    param([object[]]$Values)

    foreach ($value in $Values) {
        if (-not [string]::IsNullOrWhiteSpace([string]$value)) {
            return [string]$value
        }
    }
    return ""
}

$stable = Read-RevAgentJsonFile -Path (Join-Path (Join-Path $ReleaseRoot "channels") "stable.json")
$stableVersion = [string](Get-RevAgentValue -Object $stable -Name "version")
$stableCommit = Select-RevAgentFirstText -Values @(
    (Get-RevAgentValue -Object $stable -Name "commit"),
    (Get-RevAgentNestedValue -Object $stable -Path @("git", "commit")))
$stablePackageSha256 = [string](Get-RevAgentValue -Object $stable -Name "sha256")
$stableReleaseSequence = Get-RevAgentValue -Object $stable -Name "releaseSequence"
$machinesRoot = Join-Path $ReportsRoot "machines"
$liveRoot = Join-Path (Join-Path $ReportsRoot "live") "machines"
$nowUtc = (Get-Date).ToUniversalTime()

$machineNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($name in (Expand-RevAgentMachineNames -Values $ExpectedMachines)) {
    [void]$machineNames.Add($name)
}
foreach ($root in @($machinesRoot, $liveRoot)) {
    if (Test-Path -LiteralPath $root -PathType Container) {
        Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            ForEach-Object {
                $normalized = Normalize-RevAgentMachineName -Value $_.Name
                if (-not [string]::IsNullOrWhiteSpace($normalized)) {
                    [void]$machineNames.Add($normalized)
                }
            }
    }
}

$outOfScope = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($name in (Expand-RevAgentMachineNames -Values $OutOfScopeMachines)) {
    [void]$outOfScope.Add($name)
}

$machines = foreach ($machineName in @($machineNames | Sort-Object)) {
    $machineRoot = Join-Path $machinesRoot $machineName
    $latest = Read-RevAgentJsonFile -Path (Join-Path $machineRoot "latest.json")
    $updateLatest = Read-RevAgentJsonFile -Path (Join-Path $machineRoot "update-latest.json")
    $installLatest = Read-RevAgentJsonFile -Path (Join-Path $machineRoot "install-latest.json")
    $reinstallLatest = Read-RevAgentJsonFile -Path (Join-Path $machineRoot "reinstall-latest.json")
    $migrationLatest = Read-RevAgentJsonFile -Path (Join-Path $machineRoot "source-free-migration-latest.json")
    $liveStatus = Read-RevAgentJsonFile -Path (Join-Path $liveRoot (Join-Path $machineName "status.json"))

    $candidateReports = @($updateLatest, $reinstallLatest, $installLatest, $migrationLatest) | Where-Object { $null -ne $_ }
    $versionReport = Select-RevAgentVersionReport -PrimaryReport $latest -CandidateReports $candidateReports
    $installedVersion = Get-RevAgentInstalledVersion -Report $versionReport
    $reportedTargetVersion = Get-RevAgentTargetVersion -Report $versionReport
    $targetVersion = if (-not [string]::IsNullOrWhiteSpace($stableVersion)) { $stableVersion } else { $reportedTargetVersion }
    $excluded = $outOfScope.Contains($machineName)

    $versionState = if ($excluded) {
        "excluded"
    }
    elseif ([string]::IsNullOrWhiteSpace($installedVersion) -or [string]::IsNullOrWhiteSpace($targetVersion)) {
        "unknown"
    }
    elseif ([string]::Equals($installedVersion, $targetVersion, [System.StringComparison]::OrdinalIgnoreCase)) {
        "upToDate"
    }
    else {
        "outdated"
    }

    $reportStatus = ([string](Get-RevAgentValue -Object $latest -Name "status")).ToLowerInvariant()
    $deferred = ConvertTo-RevAgentBool -Value (Get-RevAgentNestedValue -Object $latest -Path @("diagnostics", "deferredForRevitClose"))
    $updateState = if ($reportStatus -eq "failed") {
        "failed"
    }
    elseif ($deferred) {
        "pendingRestart"
    }
    else {
        "ok"
    }

    $reportEntries = @(
        [pscustomobject]@{ Name = "latest"; Report = $latest },
        [pscustomobject]@{ Name = "update-latest"; Report = $updateLatest },
        [pscustomobject]@{ Name = "install-latest"; Report = $installLatest },
        [pscustomobject]@{ Name = "reinstall-latest"; Report = $reinstallLatest },
        [pscustomobject]@{ Name = "source-free-migration-latest"; Report = $migrationLatest }
    ) | Where-Object { $null -ne $_.Report }
    $sourceEvidence = Resolve-RevAgentSourceFreeEvidence -Reports $reportEntries -MachineRoot $machineRoot
    $sourceFreeState = if ($excluded) {
        "excluded"
    }
    elseif ($null -eq $sourceEvidence) {
        "needsEvidence"
    }
    elseif (ConvertTo-RevAgentBool -Value (Get-RevAgentValue -Object $sourceEvidence -Name "verified")) {
        "verified"
    }
    else {
        "failed"
    }

    $connectionState = if ($excluded) { "excluded" } else { Get-RevAgentConnectionState -LiveStatus $liveStatus -NowUtc $nowUtc }
    $action = Get-RevAgentAction -VersionState $versionState -SourceFreeState $sourceFreeState -UpdateState $updateState -Excluded:$excluded

    [pscustomobject][ordered]@{
        machine = $machineName
        userName = Select-RevAgentFirstText -Values @(
            (Get-RevAgentValue -Object $versionReport -Name "userName"),
            (Get-RevAgentValue -Object $liveStatus -Name "userName"))
        excluded = $excluded
        installedVersion = $installedVersion
        targetVersion = $targetVersion
        stableVersion = $stableVersion
        versionState = $versionState
        updateState = if ($excluded) { "excluded" } else { $updateState }
        sourceFreeState = $sourceFreeState
        sourceFreeEvidence = $sourceEvidence
        connectionState = $connectionState
        heartbeatAgeSeconds = if ($excluded) { $null } else { Get-RevAgentHeartbeatAgeSeconds -LiveStatus $liveStatus -NowUtc $nowUtc }
        reportStatus = [string](Get-RevAgentValue -Object $latest -Name "status")
        operation = [string](Get-RevAgentValue -Object $latest -Name "operation")
        operationMethod = [string](Get-RevAgentValue -Object $latest -Name "operationMethod")
        reportAtUtc = Select-RevAgentFirstText -Values @(
            (Get-RevAgentValue -Object $latest -Name "publishedAtUtc"),
            (Get-RevAgentValue -Object $latest -Name "reportedAtUtc"),
            (Get-RevAgentValue -Object $latest -Name "atUtc"))
        logPath = Select-RevAgentFirstText -Values @(
            (Get-RevAgentNestedValue -Object $latest -Path @("machineReport", "logPath")),
            (Get-RevAgentValue -Object $latest -Name "logPath"))
        action = $action
    }
}

$inScopeMachines = @($machines | Where-Object { -not $_.excluded })
$actionRequiredMachines = @($inScopeMachines | Where-Object { $_.action -ne "none" })
$summary = [pscustomobject][ordered]@{
    schemaVersion = "revagent.rollout.readiness.v1"
    generatedAtUtc = $nowUtc.ToString("o")
    releaseRoot = $ReleaseRoot
    reportsRoot = $ReportsRoot
    stable = [ordered]@{
        version = $stableVersion
        commit = $stableCommit
        packageSha256 = $stablePackageSha256
        releaseSequence = $stableReleaseSequence
        readError = [string](Get-RevAgentValue -Object $stable -Name "readError")
    }
    machineCount = @($machines).Count
    inScopeMachineCount = @($inScopeMachines).Count
    excludedMachineCount = @($machines | Where-Object { $_.excluded }).Count
    upToDateCount = @($inScopeMachines | Where-Object { $_.versionState -eq "upToDate" }).Count
    outdatedCount = @($inScopeMachines | Where-Object { $_.versionState -eq "outdated" }).Count
    unknownVersionCount = @($inScopeMachines | Where-Object { $_.versionState -eq "unknown" }).Count
    sourceFreeVerifiedCount = @($inScopeMachines | Where-Object { $_.sourceFreeState -eq "verified" }).Count
    sourceFreeNeedsEvidenceCount = @($inScopeMachines | Where-Object { $_.sourceFreeState -eq "needsEvidence" }).Count
    sourceFreeFailedCount = @($inScopeMachines | Where-Object { $_.sourceFreeState -eq "failed" }).Count
    updateFailedCount = @($inScopeMachines | Where-Object { $_.updateState -eq "failed" }).Count
    pendingRestartCount = @($inScopeMachines | Where-Object { $_.updateState -eq "pendingRestart" }).Count
    onlineCount = @($inScopeMachines | Where-Object { $_.connectionState -eq "online" }).Count
    staleCount = @($inScopeMachines | Where-Object { $_.connectionState -eq "stale" }).Count
    offlineCount = @($inScopeMachines | Where-Object { $_.connectionState -eq "offline" }).Count
    actionRequiredCount = @($actionRequiredMachines).Count
    ready = (@($actionRequiredMachines).Count -eq 0 -and @($inScopeMachines).Count -gt 0)
}

$result = [pscustomobject][ordered]@{
    schemaVersion = "revagent.rollout.readiness.v1"
    generatedAtUtc = $nowUtc.ToString("o")
    summary = $summary
    machines = @($machines)
    actions = @($actionRequiredMachines | Select-Object machine, userName, installedVersion, targetVersion, versionState, updateState, sourceFreeState, connectionState, action, logPath)
}

if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    $directory = Split-Path -Parent $OutputPath
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
}

if ($OutputJson) {
    $result | ConvertTo-Json -Depth 20
    return
}

Write-Host ("Stable: {0} ({1})" -f ($(if ($stableVersion) { $stableVersion } else { "unknown" })), ($(if ($stableCommit) { $stableCommit } else { "commit unknown" })))
Write-Host ("Machines: {0} in scope, {1} excluded, {2} action required" -f $summary.inScopeMachineCount, $summary.excludedMachineCount, $summary.actionRequiredCount)
Write-Host ("Source-free: {0} verified, {1} needs evidence, {2} failed" -f $summary.sourceFreeVerifiedCount, $summary.sourceFreeNeedsEvidenceCount, $summary.sourceFreeFailedCount)
$machines |
    Select-Object machine, userName, installedVersion, versionState, updateState, sourceFreeState, connectionState, action |
    Format-Table -AutoSize

if ($summary.actionRequiredCount -gt 0) {
    Write-Host "Action required:" -ForegroundColor Yellow
    $result.actions | Format-Table -AutoSize
}
else {
    Write-Host "Rollout readiness has no in-scope action items." -ForegroundColor Green
}
