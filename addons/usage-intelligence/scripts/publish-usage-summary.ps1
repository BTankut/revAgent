<#
.SYNOPSIS
    Publish daily revAgent usage summaries under the NAS reports tree.

.DESCRIPTION
    Wraps summarize-usage-intelligence.ps1 and writes stable output files:

      reports\summaries\daily\YYYY-MM-DD.json
      reports\summaries\daily\YYYY-MM-DD.md
      reports\summaries\latest.json
      reports\summaries\latest.md

    The JSON output is the durable dashboard/master-LLM input. The Markdown
    output is a small human-readable glance for support/debug use.
#>

[CmdletBinding()]
param(
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports",
    [string[]]$DateUtc = @((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")),
    [switch]$IncludeYesterday,
    [string]$OutputRoot = "",
    [string]$LockPath = "",
    [string]$LogsRoot = "",
    [int]$StaleLockMinutes = 120,
    [int]$KeepLastLogs = 30,
    [int]$Top = 20,
    [int]$TaskSampleLimit = 40,
    [int]$CorrelationWindowMinutes = 45,
    [switch]$SkipCorrelation,
    [switch]$SkipMarkdown
)

$ErrorActionPreference = "Stop"
$script:UsageSummaryLogPath = $null
$script:UsageSummaryLockPath = $null
$script:UsageSummaryLockAcquired = $false

function ConvertTo-UtcDateString {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "DateUtc contains an empty date."
    }

    try {
        return ([datetime]::ParseExact(
            $Value,
            "yyyy-MM-dd",
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AssumeUniversal
        ).ToUniversalTime().ToString("yyyy-MM-dd"))
    }
    catch {
        throw "DateUtc must use yyyy-MM-dd, got '$Value'."
    }
}

function Get-ValueOrZero {
    param([object]$Value)

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return 0
    }

    return $Value
}

function Select-TopRows {
    param(
        [object]$Rows,
        [int]$Limit = 5
    )

    if ($null -eq $Rows) {
        return @()
    }

    return @($Rows |
        Where-Object { $null -ne $_ } |
        Select-Object -First $Limit)
}

function Test-UsageSummaryTableRow {
    param([object]$Row)

    if ($null -eq $Row) {
        return $false
    }

    $properties = @($Row.PSObject.Properties)
    if ($properties.Count -eq 0) {
        return $false
    }

    $nameProperty = $Row.PSObject.Properties["name"]
    $countProperty = $Row.PSObject.Properties["count"]
    if ($nameProperty -or $countProperty) {
        $name = if ($nameProperty) { [string]$nameProperty.Value } else { "" }
        $count = if ($countProperty) { Get-ValueOrZero $countProperty.Value } else { 0 }
        if ([string]::IsNullOrWhiteSpace($name) -and [string]$count -eq "0") {
            return $false
        }
    }

    return $true
}

function Add-TableSection {
    param(
        [System.Collections.Generic.List[string]]$Lines,
        [string]$Title,
        [object[]]$Rows,
        [string]$EmptyText = "No data."
    )

    $Lines.Add("")
    $Lines.Add("## $Title")

    $Rows = @($Rows | Where-Object { Test-UsageSummaryTableRow -Row $_ })

    if (-not $Rows -or $Rows.Count -eq 0) {
        $Lines.Add("")
        $Lines.Add($EmptyText)
        return
    }

    $Lines.Add("")
    $Lines.Add("| Name | Count | Success | Guarded | Failed | Avg ms | Max ms |")
    $Lines.Add("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    foreach ($row in $Rows) {
        $name = ([string]$row.name).Replace("|", "\|")
        $count = Get-ValueOrZero $row.count
        $success = Get-ValueOrZero $row.successCount
        $guarded = Get-ValueOrZero $row.guardedCount
        $failed = Get-ValueOrZero $row.failedCount
        $average = Get-ValueOrZero $row.averageDurationMs
        $max = Get-ValueOrZero $row.maxDurationMs
        $Lines.Add("| $name | $count | $success | $guarded | $failed | $average | $max |")
    }
}

function New-UsageSummaryMarkdown {
    param([object]$Summary)

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("# revAgent Usage Summary")
    $lines.Add("")
    $lines.Add("- Date UTC: $($Summary.dateUtc)")
    $lines.Add("- Generated UTC: $($Summary.generatedAtUtc)")
    $lines.Add("- Reports root: $($Summary.reportsRoot)")
    $lines.Add("- Machine reports: $($Summary.source.machineReportCount)")
    $lines.Add("- Event files: $($Summary.source.eventFileCount)")
    $lines.Add("- Events: $($Summary.source.eventCount)")
    $lines.Add("- Sessions: $($Summary.totals.sessionCount)")
    $lines.Add("- Production operations: $($Summary.production.operationCount)")
    $lines.Add("- Send code calls: $($Summary.sendCode.count)")
    $lines.Add("- Guarded samples: $($Summary.friction.guarded.Count)")
    $lines.Add("- Failed samples: $($Summary.friction.failed.Count)")
    $lines.Add("- Generated files: $($Summary.production.generatedFileCount)")

    Add-TableSection -Lines $lines -Title "Top Tools" -Rows (Select-TopRows $Summary.toolUsage 10)
    Add-TableSection -Lines $lines -Title "Top Projects" -Rows (Select-TopRows $Summary.production.byProject 10)
    Add-TableSection -Lines $lines -Title "Top Machine Users" -Rows (Select-TopRows $Summary.production.byMachineUser 10)

    $lines.Add("")
    $lines.Add("## Guarded Operations")
    if ($Summary.friction.guarded.Count -eq 0) {
        $lines.Add("")
        $lines.Add("No guarded operations.")
    }
    else {
        $lines.Add("")
        foreach ($item in (Select-TopRows $Summary.friction.guarded 10)) {
            $lines.Add("- $($item.timestampUtc) | $($item.machineName)\$($item.userName) | $($item.tool) | $($item.taskName)")
        }
    }

    $lines.Add("")
    $lines.Add("## Failed Operations")
    if ($Summary.friction.failed.Count -eq 0) {
        $lines.Add("")
        $lines.Add("No failed operations.")
    }
    else {
        $lines.Add("")
        foreach ($item in (Select-TopRows $Summary.friction.failed 10)) {
            $detail = [string]$item.errorMessage
            if ([string]::IsNullOrWhiteSpace($detail)) {
                $detail = [string]$item.state
            }
            if ([string]::IsNullOrWhiteSpace($detail)) {
                $lines.Add("- $($item.timestampUtc) | $($item.machineName)\$($item.userName) | $($item.tool) | $($item.taskName)")
            }
            else {
                $lines.Add("- $($item.timestampUtc) | $($item.machineName)\$($item.userName) | $($item.tool) | $($item.taskName) | $detail")
            }
        }
    }

    $lines.Add("")
    $lines.Add("## Slow Operations")
    if ($Summary.friction.slow.Count -eq 0) {
        $lines.Add("")
        $lines.Add("No operation samples.")
    }
    else {
        $lines.Add("")
        foreach ($item in (Select-TopRows $Summary.friction.slow 10)) {
            $lines.Add("- $($item.durationMs) ms | $($item.machineName)\$($item.userName) | $($item.tool) | $($item.taskName)")
        }
    }

    return ($lines -join [Environment]::NewLine) + [Environment]::NewLine
}

function Copy-UsageSummaryFile {
    param(
        [string]$Source,
        [string]$Destination
    )

    $destinationDir = Split-Path -Parent $Destination
    if (-not [string]::IsNullOrWhiteSpace($destinationDir)) {
        New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Write-UsageSummaryLog {
    param([string]$Message)

    $line = "{0} {1}" -f (Get-Date).ToUniversalTime().ToString("o"), $Message
    if (-not [string]::IsNullOrWhiteSpace($script:UsageSummaryLogPath)) {
        Add-Content -LiteralPath $script:UsageSummaryLogPath -Value $line -Encoding UTF8
    }
}

function Invoke-UsageSummaryLogRetention {
    param(
        [string]$Root,
        [int]$KeepLast = 30
    )

    if ($KeepLast -lt 1 -or [string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) {
        return
    }

    $logs = @(Get-ChildItem -LiteralPath $Root -File -Filter "*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc, Name -Descending)
    if ($logs.Count -le $KeepLast) {
        return
    }

    $logs | Select-Object -Skip $KeepLast | ForEach-Object {
        try {
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
        }
        catch {
            Write-Warning "Could not remove old usage summary log '$($_.FullName)': $($_.Exception.Message)"
        }
    }
}

function Initialize-UsageSummaryLog {
    param([string]$Root)

    if ([string]::IsNullOrWhiteSpace($Root)) {
        return
    }

    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $script:UsageSummaryLogPath = Join-Path $Root ("usage-summary-{0}.log" -f $stamp)
    Set-Content -LiteralPath $script:UsageSummaryLogPath -Value "" -Encoding UTF8
    Invoke-UsageSummaryLogRetention -Root $Root -KeepLast $KeepLastLogs
}

function Acquire-UsageSummaryLock {
    param(
        [string]$Path,
        [int]$StaleMinutes = 120
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }

    $lockDir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($lockDir)) {
        New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
    }

    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $lock = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
        if ($lock -and $lock.LastWriteTimeUtc -lt (Get-Date).ToUniversalTime().AddMinutes(-1 * [Math]::Max(1, $StaleMinutes))) {
            Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
            Write-UsageSummaryLog "Removed stale lock: $Path"
        }
    }

    $payload = [ordered]@{
        schemaVersion = "revagent.usage.publish.lock.v1"
        pid = $PID
        computerName = $env:COMPUTERNAME
        userName = $env:USERNAME
        startedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json -Depth 6

    $stream = $null
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $stream.Write($bytes, 0, $bytes.Length)
        $script:UsageSummaryLockPath = $Path
        $script:UsageSummaryLockAcquired = $true
        Write-UsageSummaryLog "Acquired lock: $Path"
    }
    catch {
        throw "Usage summary publish is already running or lock could not be acquired: $Path"
    }
    finally {
        if ($stream) {
            $stream.Dispose()
        }
    }
}

function Release-UsageSummaryLock {
    if (-not $script:UsageSummaryLockAcquired -or [string]::IsNullOrWhiteSpace($script:UsageSummaryLockPath)) {
        return
    }

    try {
        Remove-Item -LiteralPath $script:UsageSummaryLockPath -Force -ErrorAction Stop
        Write-UsageSummaryLog "Released lock: $script:UsageSummaryLockPath"
    }
    catch {
        Write-Warning "Could not release usage summary lock '$script:UsageSummaryLockPath': $($_.Exception.Message)"
    }
    finally {
        $script:UsageSummaryLockAcquired = $false
    }
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $ReportsRoot "summaries"
}
if ([string]::IsNullOrWhiteSpace($LockPath)) {
    $LockPath = Join-Path $OutputRoot "publish.lock"
}
if ([string]::IsNullOrWhiteSpace($LogsRoot)) {
    $LogsRoot = Join-Path $OutputRoot "logs"
}

$summaryScript = Join-Path $PSScriptRoot "summarize-usage-intelligence.ps1"
if (-not (Test-Path -LiteralPath $summaryScript -PathType Leaf)) {
    throw "Summary script not found: $summaryScript"
}
$correlationScript = Join-Path $PSScriptRoot "correlate-usage-sessions.ps1"
if (-not $SkipCorrelation -and -not (Test-Path -LiteralPath $correlationScript -PathType Leaf)) {
    throw "Session correlation script not found: $correlationScript"
}

Initialize-UsageSummaryLog -Root $LogsRoot
Acquire-UsageSummaryLock -Path $LockPath -StaleMinutes $StaleLockMinutes

try {
    Write-UsageSummaryLog "Publishing usage summaries from reports root: $ReportsRoot"

    $dateList = New-Object System.Collections.Generic.List[string]
    foreach ($dateValue in $DateUtc) {
        $dateList.Add((ConvertTo-UtcDateString $dateValue))
    }
    if ($IncludeYesterday) {
        $dateList.Add((Get-Date).ToUniversalTime().AddDays(-1).ToString("yyyy-MM-dd"))
    }

    $dateList = @($dateList | Sort-Object -Unique)
    if ($dateList.Count -eq 0) {
        throw "No summary dates were requested."
    }

    $dailyRoot = Join-Path $OutputRoot "daily"
    New-Item -ItemType Directory -Path $dailyRoot -Force | Out-Null

    $published = @()
    foreach ($dateValue in $dateList) {
        Write-UsageSummaryLog "Summarizing date: $dateValue"
        $dailyJson = Join-Path $dailyRoot ("{0}.json" -f $dateValue)
        & $summaryScript `
            -ReportsRoot $ReportsRoot `
            -DateUtc $dateValue `
            -OutputPath $dailyJson `
            -Top $Top `
            -TaskSampleLimit $TaskSampleLimit

        $summary = Get-Content -Raw -LiteralPath $dailyJson | ConvertFrom-Json
        $dailyMarkdown = $null
        if (-not $SkipMarkdown) {
            $dailyMarkdown = Join-Path $dailyRoot ("{0}.md" -f $dateValue)
            New-UsageSummaryMarkdown -Summary $summary | Set-Content -LiteralPath $dailyMarkdown -Encoding UTF8
        }

        $dailyCorrelationJson = $null
        $dailyProductInsights = $null
        $correlation = $null
        if (-not $SkipCorrelation) {
            Write-UsageSummaryLog "Correlating Codex sessions for date: $dateValue"
            $dailyCorrelationJson = Join-Path $dailyRoot ("{0}.session-correlations.json" -f $dateValue)
            if (-not $SkipMarkdown) {
                $dailyProductInsights = Join-Path $dailyRoot ("{0}.product-insights.md" -f $dateValue)
            }
            $correlationOutput = & $correlationScript `
                -ReportsRoot $ReportsRoot `
                -DateUtc $dateValue `
                -OutputPath $dailyCorrelationJson `
                -MarkdownOutputPath $dailyProductInsights `
                -TimeWindowMinutes $CorrelationWindowMinutes `
                -Top $Top
            $correlation = Get-Content -Raw -Encoding UTF8 -LiteralPath $dailyCorrelationJson | ConvertFrom-Json
        }

        $published += [ordered]@{
            dateUtc = $dateValue
            jsonPath = $dailyJson
            markdownPath = $dailyMarkdown
            sessionCorrelationJsonPath = $dailyCorrelationJson
            productInsightsPath = $dailyProductInsights
            eventCount = $summary.source.eventCount
            productionOperationCount = $summary.production.operationCount
            sendCodeCount = $summary.sendCode.count
            guardedCount = $summary.friction.guarded.Count
            failedCount = $summary.friction.failed.Count
            generatedFileCount = $summary.production.generatedFileCount
            codexSessionContextCount = if ($correlation) { $correlation.source.codexContextFileCount } else { 0 }
            sessionCorrelationCount = if ($correlation) { $correlation.summary.correlationCount } else { 0 }
            productSignalCount = if ($correlation) { $correlation.summary.productSignalCount } else { 0 }
        }
    }

    $latest = @($published |
        Sort-Object { [string]$_["dateUtc"] } |
        Select-Object -Last 1)[0]
    $latestJson = Join-Path $OutputRoot "latest.json"
    Copy-UsageSummaryFile -Source ([string]$latest["jsonPath"]) -Destination $latestJson

    $latestMarkdown = $null
    if (-not $SkipMarkdown -and $latest["markdownPath"]) {
        $latestMarkdown = Join-Path $OutputRoot "latest.md"
        Copy-UsageSummaryFile -Source ([string]$latest["markdownPath"]) -Destination $latestMarkdown
    }

    $publishReport = [ordered]@{
        schemaVersion = "revagent.usage.publish.v1"
        generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        reportsRoot = $ReportsRoot
        outputRoot = $OutputRoot
        latestDateUtc = $latest["dateUtc"]
        latestJsonPath = $latestJson
        latestMarkdownPath = $latestMarkdown
        publishReportPath = (Join-Path $OutputRoot "publish-latest.json")
        logPath = $script:UsageSummaryLogPath
        lockPath = $LockPath
        published = $published
    }

    $publishReportPath = $publishReport.publishReportPath
    $publishReport | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $publishReportPath -Encoding UTF8
    Write-UsageSummaryLog "Publish complete. Latest JSON: $latestJson"

    $publishReport | ConvertTo-Json -Depth 20
}
finally {
    Release-UsageSummaryLock
}
