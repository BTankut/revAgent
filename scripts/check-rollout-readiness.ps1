<#
.SYNOPSIS
    Read NAS release and machine reports to summarize office rollout readiness.

.DESCRIPTION
    This is a read-only audit helper. It does not update workstations, run
    migration, connect over SSH, or write to NAS unless -OutputPath is provided.
    It combines the stable channel manifest, per-machine install/update
    reports, optional source-free migration reports, copied operation logs, and
    live heartbeat files into a compact action list. Use -ConfigPath to read a
    local or NAS-side JSON file with releaseRoot, reportsRoot,
    expectedMachines, outOfScopeMachines, and liveSmokeEvidence entries.
#>

[CmdletBinding()]
param(
    [string]$ReleaseRoot = "",

    [string]$ReportsRoot = "",

    [string]$ConfigPath = "",

    [string]$ExpectedMachines = "",

    [string]$OutOfScopeMachines = "",

    [int]$StaleSeconds = 60,

    [int]$OfflineSeconds = 300,

    [datetime]$NowUtc = [datetime]::MinValue,

    [string]$OutputPath = "",

    [switch]$OutputJson
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$defaultCanonicalReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
$defaultLegacyReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"
$config = $null

if ([string]::IsNullOrWhiteSpace($ConfigPath) -and -not [string]::IsNullOrWhiteSpace($env:REVAGENT_ROLLOUT_READINESS_CONFIG)) {
    $ConfigPath = $env:REVAGENT_ROLLOUT_READINESS_CONFIG
}
if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "Rollout readiness config file was not found: $ConfigPath"
    }
    $config = Get-Content -Raw -LiteralPath $ConfigPath -Encoding UTF8 | ConvertFrom-Json
    $ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
}

function Normalize-RevAgentMachineName {
    param([string]$Value)

    return ([string]$Value).Trim().ToUpperInvariant()
}

function Expand-RevAgentMachineNames {
    param([object[]]$Values)

    $expanded = [System.Collections.Generic.List[string]]::new()
    foreach ($value in $Values) {
        if ($null -eq $value) {
            continue
        }

        $rawValue = ""
        if ($value -is [string]) {
            $rawValue = [string]$value
        }
        elseif ($value -is [System.Collections.IDictionary]) {
            foreach ($nameKey in @("name", "machine", "machineName", "computerName")) {
                if ($value.Contains($nameKey) -and -not [string]::IsNullOrWhiteSpace([string]$value[$nameKey])) {
                    $rawValue = [string]$value[$nameKey]
                    break
                }
            }
        }
        else {
            foreach ($nameKey in @("name", "machine", "machineName", "computerName")) {
                $property = $value.PSObject.Properties[$nameKey]
                if ($null -ne $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
                    $rawValue = [string]$property.Value
                    break
                }
            }
            if ([string]::IsNullOrWhiteSpace($rawValue)) {
                $rawValue = [string]$value
            }
        }

        if ([string]::IsNullOrWhiteSpace($rawValue)) {
            continue
        }

        foreach ($part in ($rawValue -split '[,;]')) {
            $normalized = Normalize-RevAgentMachineName -Value $part
            if (-not [string]::IsNullOrWhiteSpace($normalized)) {
                [void]$expanded.Add($normalized)
            }
        }
    }
    return @($expanded.ToArray())
}

function Get-RevAgentObjectText {
    param(
        [object]$Object,
        [string[]]$Names
    )

    if ($null -eq $Object) {
        return ""
    }
    foreach ($name in $Names) {
        $value = $null
        if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($name)) {
            $value = $Object[$name]
        }
        else {
            $property = $Object.PSObject.Properties[$name]
            if ($null -ne $property) {
                $value = $property.Value
            }
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$value)) {
            return [string]$value
        }
    }
    return ""
}

function Get-RevAgentOutOfScopeReasonMap {
    param([object[]]$Values)

    $map = @{}
    foreach ($value in $Values) {
        if ($null -eq $value) {
            continue
        }

        $names = @(Expand-RevAgentMachineNames -Values @($value))
        if ($names.Count -eq 0) {
            continue
        }

        $reason = ""
        if ($value -isnot [string]) {
            $reason = Get-RevAgentObjectText -Object $value -Names @("reason", "note", "status")
        }

        foreach ($name in $names) {
            if (-not $map.ContainsKey($name) -or [string]::IsNullOrWhiteSpace([string]$map[$name])) {
                $map[$name] = $reason
            }
        }
    }
    return $map
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
    $offset = [datetimeoffset]::MinValue
    $utcParseStyles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
    if ([datetimeoffset]::TryParse(
            [string]$Value,
            [System.Globalization.CultureInfo]::InvariantCulture,
            $utcParseStyles,
            [ref]$offset)) {
        return [int64]($offset.UtcDateTime - [datetime]"1970-01-01T00:00:00Z").TotalMilliseconds
    }

    $date = [datetime]::MinValue
    if ([datetime]::TryParse(
            [string]$Value,
            [System.Globalization.CultureInfo]::InvariantCulture,
            $utcParseStyles,
            [ref]$date)) {
        return [int64]($date.ToUniversalTime() - [datetime]"1970-01-01T00:00:00Z").TotalMilliseconds
    }
    return $null
}

function Get-RevAgentInstalledVersion {
    param([object]$Report)

    $paths = @(
        @("installedVersion"),
        @("localInstall", "version"),
        @("installedState", "version")
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
        @("targetVersion"),
        @("release", "version"),
        @("channel", "version")
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
        @("atUtc"),
        @("reportedAtUtc"),
        @("publishedAtUtc"),
        @("machineReport", "publishedAtUtc"),
        @("finishedAtUtc"),
        @("startedAtUtc")
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

function Test-RevAgentCommitMatch {
    param(
        [string]$EvidenceCommit,
        [string]$StableCommit
    )

    if ([string]::IsNullOrWhiteSpace($EvidenceCommit) -or [string]::IsNullOrWhiteSpace($StableCommit)) {
        return $false
    }
    $evidence = $EvidenceCommit.Trim()
    $stable = $StableCommit.Trim()
    return ($stable.StartsWith($evidence, [System.StringComparison]::OrdinalIgnoreCase) -or
        $evidence.StartsWith($stable, [System.StringComparison]::OrdinalIgnoreCase))
}

function Test-RevAgentSmokePassed {
    param([object]$Evidence)

    $passed = Get-RevAgentValue -Object $Evidence -Name "passed"
    if ($null -ne $passed) {
        return ConvertTo-RevAgentBool -Value $passed
    }
    $success = Get-RevAgentValue -Object $Evidence -Name "success"
    if ($null -ne $success) {
        return ConvertTo-RevAgentBool -Value $success
    }
    $status = ([string](Get-RevAgentValue -Object $Evidence -Name "status")).Trim()
    return (@("completed", "ok", "pass", "passed", "success", "succeeded") -contains $status.ToLowerInvariant())
}

function Get-RevAgentSmokeTimestampMs {
    param([object]$Evidence)

    foreach ($path in @(
            @("atUtc"),
            @("completedAtUtc"),
            @("finishedAtUtc"),
            @("reportedAtUtc"),
            @("generatedAtUtc"),
            @("createdAtUtc"))) {
        $value = Get-RevAgentNestedValue -Object $Evidence -Path $path
        $ms = ConvertTo-RevAgentUtcMs -Value $value
        if ($null -ne $ms) {
            return $ms
        }
    }
    return [int64]0
}

function Read-RevAgentSmokeEvidenceFile {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @()
    }

    $json = Read-RevAgentJsonFile -Path $Path
    if ($null -eq $json -or $null -ne (Get-RevAgentValue -Object $json -Name "readError")) {
        return @()
    }

    $items = @()
    if ($json -is [array]) {
        $items += @($json)
    }
    else {
        $evidence = Get-RevAgentValue -Object $json -Name "evidence"
        if ($null -ne $evidence) {
            $items += @($evidence)
        }
        else {
            $items += $json
        }
    }

    foreach ($item in $items) {
        if ($null -eq $item) {
            continue
        }
        [pscustomobject][ordered]@{
            source = $Path
            evidence = $item
        }
    }
}

function Resolve-RevAgentLiveSmokeEvidence {
    param(
        [object]$Config,
        [string]$ReportsRoot,
        [string]$StableVersion,
        [string]$StableCommit
    )

    $entries = [System.Collections.Generic.List[object]]::new()

    if ($null -ne $Config) {
        foreach ($item in @(Get-RevAgentValue -Object $Config -Name "liveSmokeEvidence")) {
            if ($null -ne $item) {
                [void]$entries.Add([pscustomobject][ordered]@{ source = "config:liveSmokeEvidence"; evidence = $item })
            }
        }
        foreach ($item in @(Get-RevAgentValue -Object $Config -Name "smokeEvidence")) {
            if ($null -ne $item) {
                [void]$entries.Add([pscustomobject][ordered]@{ source = "config:smokeEvidence"; evidence = $item })
            }
        }
    }

    $paths = [System.Collections.Generic.List[string]]::new()
    if ($null -ne $Config) {
        foreach ($path in @(Get-RevAgentValue -Object $Config -Name "liveSmokeEvidencePath")) {
            if (-not [string]::IsNullOrWhiteSpace([string]$path)) {
                [void]$paths.Add([string]$path)
            }
        }
        foreach ($path in @(Get-RevAgentValue -Object $Config -Name "liveSmokeEvidencePaths")) {
            if (-not [string]::IsNullOrWhiteSpace([string]$path)) {
                [void]$paths.Add([string]$path)
            }
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($ReportsRoot)) {
        [void]$paths.Add((Join-Path (Join-Path $ReportsRoot "rollout") "live-smoke-latest.json"))
    }

    foreach ($path in @($paths.ToArray() | Select-Object -Unique)) {
        foreach ($entry in @(Read-RevAgentSmokeEvidenceFile -Path $path)) {
            [void]$entries.Add($entry)
        }
    }

    $normalized = foreach ($entry in @($entries.ToArray())) {
        $evidence = $entry.evidence
        $version = Select-RevAgentFirstText -Values @(
            (Get-RevAgentValue -Object $evidence -Name "stableVersion"),
            (Get-RevAgentValue -Object $evidence -Name "releaseVersion"),
            (Get-RevAgentValue -Object $evidence -Name "installedVersion"),
            (Get-RevAgentValue -Object $evidence -Name "version"))
        $commit = Select-RevAgentFirstText -Values @(
            (Get-RevAgentValue -Object $evidence -Name "stableCommit"),
            (Get-RevAgentValue -Object $evidence -Name "releaseCommit"),
            (Get-RevAgentValue -Object $evidence -Name "commit"))
        $machine = Select-RevAgentFirstText -Values @(
            (Get-RevAgentValue -Object $evidence -Name "machine"),
            (Get-RevAgentValue -Object $evidence -Name "machineName"),
            (Get-RevAgentValue -Object $evidence -Name "computerName"))
        $passed = Test-RevAgentSmokePassed -Evidence $evidence
        $versionMatches = (-not [string]::IsNullOrWhiteSpace($StableVersion) -and
            [string]::Equals($version, $StableVersion, [System.StringComparison]::OrdinalIgnoreCase))
        $commitMatches = Test-RevAgentCommitMatch -EvidenceCommit $commit -StableCommit $StableCommit

        [pscustomobject][ordered]@{
            source = [string]$entry.source
            machine = $machine
            passed = $passed
            version = $version
            commit = $commit
            versionMatchesStable = $versionMatches
            commitMatchesStable = $commitMatches
            atUtc = Select-RevAgentFirstText -Values @(
                (Get-RevAgentValue -Object $evidence -Name "atUtc"),
                (Get-RevAgentValue -Object $evidence -Name "completedAtUtc"),
                (Get-RevAgentValue -Object $evidence -Name "finishedAtUtc"),
                (Get-RevAgentValue -Object $evidence -Name "reportedAtUtc"),
                (Get-RevAgentValue -Object $evidence -Name "generatedAtUtc"))
            timestampMs = Get-RevAgentSmokeTimestampMs -Evidence $evidence
            revitVersion = [string](Get-RevAgentValue -Object $evidence -Name "revitVersion")
            model = Select-RevAgentFirstText -Values @(
                (Get-RevAgentValue -Object $evidence -Name "model"),
                (Get-RevAgentValue -Object $evidence -Name "modelName"))
            note = Select-RevAgentFirstText -Values @(
                (Get-RevAgentValue -Object $evidence -Name "note"),
                (Get-RevAgentValue -Object $evidence -Name "notes"))
        }
    }

    $all = @($normalized | Sort-Object @{ Expression = { $_.timestampMs }; Descending = $true })
    $verified = @($all | Where-Object { $_.passed -and ($_.versionMatchesStable -or $_.commitMatchesStable) } | Select-Object -First 1)
    if ($verified.Count -gt 0) {
        return [pscustomobject][ordered]@{
            state = "verified"
            action = "none"
            reason = ""
            evidenceCount = $all.Count
            latest = $verified[0]
        }
    }

    $passed = @($all | Where-Object { $_.passed } | Select-Object -First 1)
    if ($all.Count -eq 0) {
        return [pscustomobject][ordered]@{
            state = "missing"
            action = "collect_live_revit_smoke"
            reason = "No live Revit smoke evidence was found for the current stable."
            evidenceCount = 0
            latest = $null
        }
    }
    if ($passed.Count -eq 0) {
        return [pscustomobject][ordered]@{
            state = "failed"
            action = "inspect_live_revit_smoke_failure"
            reason = "Live Revit smoke evidence exists, but none of the records passed."
            evidenceCount = $all.Count
            latest = $all[0]
        }
    }

    $latestPassed = $passed[0]
    if ([string]::IsNullOrWhiteSpace($latestPassed.version) -and [string]::IsNullOrWhiteSpace($latestPassed.commit)) {
        return [pscustomobject][ordered]@{
            state = "incomplete"
            action = "record_live_revit_smoke_version_or_commit"
            reason = "Live Revit smoke evidence passed but does not identify the stable version or commit."
            evidenceCount = $all.Count
            latest = $latestPassed
        }
    }

    return [pscustomobject][ordered]@{
        state = "stale"
        action = "rerun_live_revit_smoke_on_current_stable"
        reason = "Live Revit smoke evidence does not match the current stable version or commit."
        evidenceCount = $all.Count
        latest = $latestPassed
    }
}

if ($null -ne $config) {
    if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
        $ReleaseRoot = [string](Get-RevAgentValue -Object $config -Name "releaseRoot")
    }
    if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
        $ReportsRoot = [string](Get-RevAgentValue -Object $config -Name "reportsRoot")
    }
}
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    if (-not [string]::IsNullOrWhiteSpace($env:REVAGENT_RELEASE_ROOT)) {
        $ReleaseRoot = $env:REVAGENT_RELEASE_ROOT
    }
    elseif (Test-Path -LiteralPath (Join-Path $defaultCanonicalReleaseRoot "channels\stable.json") -PathType Leaf) {
        $ReleaseRoot = $defaultCanonicalReleaseRoot
    }
    else {
        $ReleaseRoot = $defaultLegacyReleaseRoot
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

$stable = Read-RevAgentJsonFile -Path (Join-Path (Join-Path $ReleaseRoot "channels") "stable.json")
$stableVersion = [string](Get-RevAgentValue -Object $stable -Name "version")
$stableCommit = Select-RevAgentFirstText -Values @(
    (Get-RevAgentValue -Object $stable -Name "commit"),
    (Get-RevAgentNestedValue -Object $stable -Path @("git", "commit")))
$stablePackageSha256 = [string](Get-RevAgentValue -Object $stable -Name "sha256")
$stableReleaseSequence = Get-RevAgentValue -Object $stable -Name "releaseSequence"
$machinesRoot = Join-Path $ReportsRoot "machines"
$liveRoot = Join-Path (Join-Path $ReportsRoot "live") "machines"
$nowUtc = if ($NowUtc -eq [datetime]::MinValue) { (Get-Date).ToUniversalTime() } else { $NowUtc.ToUniversalTime() }

$expectedMachineInputs = @()
$outOfScopeMachineInputs = @()
if ($null -ne $config) {
    $expectedMachineInputs += @(Get-RevAgentValue -Object $config -Name "expectedMachines")
    $outOfScopeMachineInputs += @(Get-RevAgentValue -Object $config -Name "outOfScopeMachines")
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedMachines)) {
    $expectedMachineInputs += $ExpectedMachines
}
if (-not [string]::IsNullOrWhiteSpace($OutOfScopeMachines)) {
    $outOfScopeMachineInputs += $OutOfScopeMachines
}

$machineNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($name in (Expand-RevAgentMachineNames -Values $expectedMachineInputs)) {
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
$outOfScopeReasons = Get-RevAgentOutOfScopeReasonMap -Values $outOfScopeMachineInputs
foreach ($name in @($outOfScopeReasons.Keys)) {
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
    $exclusionReason = if ($excluded -and $outOfScopeReasons.ContainsKey($machineName)) { [string]$outOfScopeReasons[$machineName] } else { "" }

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
        exclusionReason = $exclusionReason
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
$liveSmoke = Resolve-RevAgentLiveSmokeEvidence -Config $config -ReportsRoot $ReportsRoot -StableVersion $stableVersion -StableCommit $stableCommit
$rolloutActions = @()
if ([string](Get-RevAgentValue -Object $liveSmoke -Name "action") -ne "none") {
    $rolloutActions += [pscustomobject][ordered]@{
        scope = "rollout"
        machine = ""
        userName = ""
        installedVersion = ""
        targetVersion = $stableVersion
        versionState = ""
        updateState = ""
        sourceFreeState = ""
        connectionState = ""
        action = [string](Get-RevAgentValue -Object $liveSmoke -Name "action")
        reason = [string](Get-RevAgentValue -Object $liveSmoke -Name "reason")
        logPath = ""
    }
}
$machineActions = @($actionRequiredMachines | Select-Object `
        @{ Name = "scope"; Expression = { "machine" } },
        machine,
        userName,
        installedVersion,
        targetVersion,
        versionState,
        updateState,
        sourceFreeState,
        connectionState,
        action,
        @{ Name = "reason"; Expression = { "" } },
        logPath)
$allActions = @($machineActions + $rolloutActions)
$summary = [pscustomobject][ordered]@{
    schemaVersion = "revagent.rollout.readiness.v1"
    generatedAtUtc = $nowUtc.ToString("o")
    configPath = $ConfigPath
    releaseRoot = $ReleaseRoot
    reportsRoot = $ReportsRoot
    stable = [ordered]@{
        version = $stableVersion
        commit = $stableCommit
        packageSha256 = $stablePackageSha256
        releaseSequence = $stableReleaseSequence
        readError = [string](Get-RevAgentValue -Object $stable -Name "readError")
    }
    liveSmoke = $liveSmoke
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
    machineActionRequiredCount = @($actionRequiredMachines).Count
    rolloutActionRequiredCount = @($rolloutActions).Count
    actionRequiredCount = @($allActions).Count
    ready = (@($allActions).Count -eq 0 -and @($inScopeMachines).Count -gt 0)
}

$result = [pscustomobject][ordered]@{
    schemaVersion = "revagent.rollout.readiness.v1"
    generatedAtUtc = $nowUtc.ToString("o")
    summary = $summary
    machines = @($machines)
    actions = @($allActions)
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
Write-Host ("Machines: {0} in scope, {1} excluded, {2} machine action(s), {3} rollout action(s)" -f $summary.inScopeMachineCount, $summary.excludedMachineCount, $summary.machineActionRequiredCount, $summary.rolloutActionRequiredCount)
Write-Host ("Source-free: {0} verified, {1} needs evidence, {2} failed" -f $summary.sourceFreeVerifiedCount, $summary.sourceFreeNeedsEvidenceCount, $summary.sourceFreeFailedCount)
Write-Host ("Live smoke: {0}" -f $summary.liveSmoke.state)
$machines |
    Select-Object machine, userName, installedVersion, versionState, updateState, sourceFreeState, connectionState, action, exclusionReason |
    Format-Table -AutoSize

if ($summary.actionRequiredCount -gt 0) {
    Write-Host "Action required:" -ForegroundColor Yellow
    $result.actions | Format-Table -AutoSize
}
else {
    Write-Host "Rollout readiness has no in-scope action items." -ForegroundColor Green
}
