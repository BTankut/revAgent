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
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports",
    [string[]]$DateUtc = @((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")),
    [switch]$IncludeYesterday,
    [string]$OutputRoot = "",
    [int]$Top = 20,
    [int]$TaskSampleLimit = 40,
    [switch]$SkipMarkdown
)

$ErrorActionPreference = "Stop"

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

    return @($Rows | Select-Object -First $Limit)
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

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $ReportsRoot "summaries"
}

$summaryScript = Join-Path $PSScriptRoot "summarize-usage-intelligence.ps1"
if (-not (Test-Path -LiteralPath $summaryScript -PathType Leaf)) {
    throw "Summary script not found: $summaryScript"
}

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

    $published += [ordered]@{
        dateUtc = $dateValue
        jsonPath = $dailyJson
        markdownPath = $dailyMarkdown
        eventCount = $summary.source.eventCount
        productionOperationCount = $summary.production.operationCount
        sendCodeCount = $summary.sendCode.count
        guardedCount = $summary.friction.guarded.Count
        failedCount = $summary.friction.failed.Count
        generatedFileCount = $summary.production.generatedFileCount
    }
}

$latest = $published | Sort-Object dateUtc | Select-Object -Last 1
$latestJson = Join-Path $OutputRoot "latest.json"
Copy-UsageSummaryFile -Source $latest.jsonPath -Destination $latestJson

$latestMarkdown = $null
if (-not $SkipMarkdown -and $latest.markdownPath) {
    $latestMarkdown = Join-Path $OutputRoot "latest.md"
    Copy-UsageSummaryFile -Source $latest.markdownPath -Destination $latestMarkdown
}

$publishReport = [ordered]@{
    schemaVersion = "revagent.usage.publish.v1"
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    reportsRoot = $ReportsRoot
    outputRoot = $OutputRoot
    latestDateUtc = $latest.dateUtc
    latestJsonPath = $latestJson
    latestMarkdownPath = $latestMarkdown
    published = $published
}

$publishReportPath = Join-Path $OutputRoot "publish-latest.json"
$publishReport | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $publishReportPath -Encoding UTF8

$publishReport | ConvertTo-Json -Depth 20
