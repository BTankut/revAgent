<#
.SYNOPSIS
    Prepare a bounded revAgent usage evidence pack for LLM review.

.DESCRIPTION
    Reads deterministic daily usage summaries, Codex session contexts, and
    session-correlation evidence from the NAS reports tree. It writes a compact
    machine-readable pack plus an optional prompt handoff for a Codex/LLM
    analyst. This script does not produce the final product report; it prepares
    clean evidence for the LLM to interpret.
#>

[CmdletBinding()]
param(
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports",
    [string[]]$DateUtc = @((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")),
    [string]$StartDateUtc = "",
    [switch]$IncludeYesterday,
    [int]$DaysBack = 0,
    [string]$InputDailyRoot = "",
    [string]$OutputRoot = "",
    [string]$OutputPath = "",
    [string]$MarkdownOutputPath = "",
    [int]$Top = 20,
    [int]$TaskSampleLimit = 40,
    [int]$CorrelationWindowMinutes = 45,
    [int]$MaxSessions = 80,
    [int]$MaxIntentChars = 1000,
    [switch]$UseExistingInputs,
    [switch]$SkipMarkdown
)

$ErrorActionPreference = "Stop"
$dateUtcWasExplicit = $PSBoundParameters.ContainsKey("DateUtc")

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

function ConvertTo-UtcDate {
    param(
        [string]$Value,
        [string]$ParameterName = "DateUtc"
    )

    try {
        return ([datetime]::ParseExact(
            $Value,
            "yyyy-MM-dd",
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AssumeUniversal
        )).ToUniversalTime().Date
    }
    catch {
        throw "$ParameterName must use yyyy-MM-dd, got '$Value'."
    }
}

function Add-UtcDateString {
    param(
        [System.Collections.Generic.List[string]]$List,
        [string]$Value
    )

    $normalized = ConvertTo-UtcDateString -Value $Value
    if (-not $List.Contains($normalized)) {
        [void]$List.Add($normalized)
    }
}

function ConvertTo-BoundedText {
    param(
        [object]$Value,
        [int]$Limit
    )

    if ($null -eq $Value) {
        return ""
    }

    $text = ([string]$Value).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        return ""
    }

    $text = ($text -replace '\s+', ' ').Trim()
    if ($Limit -gt 0 -and $text.Length -gt $Limit) {
        return $text.Substring(0, $Limit) + "..."
    }

    return $text
}

function Get-PropertyValue {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) {
        return $property.Value
    }
    return $null
}

function Read-JsonOrNull {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    try {
        return Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        Write-Warning "Could not read JSON '$Path': $($_.Exception.Message)"
        return $null
    }
}

function Select-Rows {
    param(
        [object]$Rows,
        [int]$Limit = 10
    )

    if ($null -eq $Rows) {
        return @()
    }
    return @($Rows | Where-Object { $null -ne $_ } | Select-Object -First $Limit)
}

function Add-Count {
    param(
        [hashtable]$Map,
        [string]$Key,
        [int]$Count = 1
    )

    if ([string]::IsNullOrWhiteSpace($Key) -or $Count -le 0) {
        return
    }
    if (-not $Map.ContainsKey($Key)) {
        $Map[$Key] = 0
    }
    $Map[$Key] += $Count
}

function Add-CountRows {
    param(
        [hashtable]$Map,
        [object]$Rows
    )

    foreach ($row in @($Rows)) {
        $name = [string](Get-PropertyValue -Object $row -Name "name")
        $count = Get-PropertyValue -Object $row -Name "count"
        if ($null -eq $count) {
            $count = 1
        }
        Add-Count -Map $Map -Key $name -Count ([int]$count)
    }
}

function Convert-CountMapToRows {
    param(
        [hashtable]$Map,
        [int]$Limit = 20
    )

    return @($Map.GetEnumerator() |
        Sort-Object @{ Expression = { $_.Value }; Descending = $true }, Name |
        Select-Object -First $Limit |
        ForEach-Object {
            [ordered]@{
                name = [string]$_.Key
                count = [int]$_.Value
            }
        })
}

function Join-NonEmptyText {
    param(
        [object]$Items,
        [int]$Limit = 3
    )

    return @(@($Items) |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
        Select-Object -First $Limit |
        ForEach-Object { ConvertTo-BoundedText -Value $_ -Limit $MaxIntentChars })
}

function Convert-DateList {
    $dateList = [System.Collections.Generic.List[string]]::new()
    $todayUtc = (Get-Date).ToUniversalTime().Date

    if (-not $dateUtcWasExplicit -and -not [string]::IsNullOrWhiteSpace($StartDateUtc)) {
        $startDate = ConvertTo-UtcDate -Value $StartDateUtc -ParameterName "StartDateUtc"
        if ($startDate -gt $todayUtc) {
            throw "StartDateUtc cannot be in the future: $StartDateUtc."
        }

        for ($cursor = $startDate; $cursor -le $todayUtc; $cursor = $cursor.AddDays(1)) {
            Add-UtcDateString -List $dateList -Value $cursor.ToString("yyyy-MM-dd")
        }
    }
    else {
        foreach ($dateValue in $DateUtc) {
            Add-UtcDateString -List $dateList -Value $dateValue
        }
    }
    if ($IncludeYesterday) {
        Add-UtcDateString -List $dateList -Value (Get-Date).ToUniversalTime().AddDays(-1).ToString("yyyy-MM-dd")
    }
    if ($DaysBack -gt 0) {
        for ($offset = 0; $offset -lt $DaysBack; $offset++) {
            Add-UtcDateString -List $dateList -Value (Get-Date).ToUniversalTime().AddDays(-1 * $offset).ToString("yyyy-MM-dd")
        }
    }

    return @($dateList.ToArray() | Sort-Object -Unique)
}

function Get-RangeLabel {
    param([string[]]$Dates)

    if ($Dates.Count -eq 1) {
        return $Dates[0]
    }
    return "{0}_to_{1}" -f $Dates[0], $Dates[$Dates.Count - 1]
}

function New-PackMarkdown {
    param([object]$Pack)

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("# revAgent LLM Review Pack")
    $lines.Add("")
    $lines.Add("This file is not the final report. It is a bounded handoff for a Codex/LLM analyst.")
    $lines.Add("")
    $lines.Add("## Suggested user prompt")
    $lines.Add("")
    $lines.Add("> Merhaba, usage-intelligence add-on'unu kullanarak revAgent ile son iki gunde kullanicilar neler yapmis bir gorelim. Once on ozet raporu ver; sonra detayli konusuruz.")
    $lines.Add("")
    $lines.Add("## Pack")
    $lines.Add("")
    $lines.Add("- Schema: $($Pack.schemaVersion)")
    $lines.Add("- Date range UTC: $($Pack.dateRange.startUtc) -> $($Pack.dateRange.endUtc)")
    $lines.Add("- JSON pack: $($Pack.output.jsonPath)")
    $lines.Add("- Reports root: $($Pack.reportsRoot)")
    $lines.Add("- Daily summaries: $($Pack.overview.dailySummaryCount)")
    $lines.Add("- Codex session contexts: $($Pack.overview.codexSessionContextCount)")
    $lines.Add("- Session correlations: $($Pack.overview.sessionCorrelationCount)")
    $lines.Add("- revAgent events: $($Pack.overview.revAgentEventCount)")
    $lines.Add("- Review signals: $($Pack.overview.reviewSignalCount)")
    $lines.Add("- Daily send_code count: $($Pack.overview.dailySendCodeCount)")
    $lines.Add("- Correlated dynamic-code count: $($Pack.overview.correlatedDynamicCodeCount)")
    $lines.Add("")
    $lines.Add("## LLM job")
    $lines.Add("")
    foreach ($item in @($Pack.llmInstructions.analysisQuestions)) {
        $lines.Add("- $item")
    }
    $lines.Add("")
    $lines.Add("## Source files")
    $lines.Add("")
    foreach ($source in @($Pack.sourceFiles | Select-Object -First 40)) {
        $lines.Add("- $($source.kind): $($source.path)")
    }

    return ($lines -join [Environment]::NewLine) + [Environment]::NewLine
}

$dates = @(Convert-DateList)
if ($dates.Count -eq 0) {
    throw "No dates were requested for the LLM review pack."
}

$rangeLabel = Get-RangeLabel -Dates $dates
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path (Join-Path $ReportsRoot "llm-review-packs") $rangeLabel
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $OutputRoot "review-pack.json"
}
if (-not $SkipMarkdown -and [string]::IsNullOrWhiteSpace($MarkdownOutputPath)) {
    $MarkdownOutputPath = Join-Path $OutputRoot "review-pack-prompt.md"
}

$summaryScript = Join-Path $PSScriptRoot "summarize-usage-intelligence.ps1"
$correlationScript = Join-Path $PSScriptRoot "correlate-usage-sessions.ps1"
if (-not (Test-Path -LiteralPath $summaryScript -PathType Leaf)) {
    throw "Summary script not found: $summaryScript"
}
if (-not (Test-Path -LiteralPath $correlationScript -PathType Leaf)) {
    throw "Session correlation script not found: $correlationScript"
}

if ([string]::IsNullOrWhiteSpace($InputDailyRoot)) {
    $dailyRoot = Join-Path (Join-Path $ReportsRoot "summaries") "daily"
}
else {
    $dailyRoot = [System.IO.Path]::GetFullPath($InputDailyRoot)
}
$sourceFiles = [System.Collections.Generic.List[object]]::new()
$dailyEvidence = [System.Collections.Generic.List[object]]::new()
$sessionEvidence = [System.Collections.Generic.List[object]]::new()
$reviewSignals = [System.Collections.Generic.List[object]]::new()

$totalEvents = 0
$totalOperations = 0
$totalGeneratedFiles = 0
$totalCodexContexts = 0
$totalCorrelations = 0
$totalCorrelationsWithEvents = 0
$dailySendCodeCount = 0
$correlatedDynamicCodeCount = 0
$dailySendCodeClassificationCounts = @{}
$dailySendCodeClassificationSubtypeCounts = @{}
$dailyUnclassifiedWriteReviewBucketCounts = @{}
$correlatedSendCodeClassificationCounts = @{}
$correlatedSendCodeClassificationSubtypeCounts = @{}
$correlatedUnclassifiedWriteReviewBucketCounts = @{}
$correlationCountingPolicies = [System.Collections.Generic.List[object]]::new()
$machineNames = @{}
$userNames = @{}
$projectNames = @{}

foreach ($dateValue in $dates) {
    $summaryPath = Join-Path $dailyRoot ("{0}.json" -f $dateValue)
    $correlationPath = Join-Path $dailyRoot ("{0}.session-correlations.json" -f $dateValue)

    if (-not $UseExistingInputs) {
        & $summaryScript `
            -ReportsRoot $ReportsRoot `
            -DateUtc $dateValue `
            -OutputPath $summaryPath `
            -Top $Top `
            -TaskSampleLimit $TaskSampleLimit | Out-Null

        & $correlationScript `
            -ReportsRoot $ReportsRoot `
            -DateUtc $dateValue `
            -OutputPath $correlationPath `
            -TimeWindowMinutes $CorrelationWindowMinutes `
            -Top $Top `
            -SkipMarkdown | Out-Null
    }

    $summary = Read-JsonOrNull -Path $summaryPath
    $correlation = Read-JsonOrNull -Path $correlationPath

    [void]$sourceFiles.Add([ordered]@{ kind = "daily_summary"; dateUtc = $dateValue; path = $summaryPath; exists = [bool]($null -ne $summary) })
    [void]$sourceFiles.Add([ordered]@{ kind = "session_correlation"; dateUtc = $dateValue; path = $correlationPath; exists = [bool]($null -ne $correlation) })

    if ($summary) {
        $totalEvents += [int]$summary.source.eventCount
        $totalOperations += [int]$summary.production.operationCount
        $totalGeneratedFiles += [int]$summary.production.generatedFileCount
        $summarySendCode = Get-PropertyValue -Object $summary -Name "sendCode"
        if ($summarySendCode) {
            $dailySendCodeCount += [int](Get-PropertyValue -Object $summarySendCode -Name "count")
            Add-CountRows -Map $dailySendCodeClassificationCounts -Rows (Get-PropertyValue -Object $summarySendCode -Name "classificationCounts")
            Add-CountRows -Map $dailySendCodeClassificationSubtypeCounts -Rows (Get-PropertyValue -Object $summarySendCode -Name "classificationSubtypes")
            Add-CountRows -Map $dailyUnclassifiedWriteReviewBucketCounts -Rows (Get-PropertyValue -Object $summarySendCode -Name "unclassifiedWriteReviewBuckets")
        }

        foreach ($row in @($summary.production.byMachineUser)) {
            $key = [string]$row.name
            if (-not [string]::IsNullOrWhiteSpace($key)) { $userNames[$key] = $true }
        }
        foreach ($row in @($summary.production.byProject)) {
            $key = [string]$row.name
            if (-not [string]::IsNullOrWhiteSpace($key)) { $projectNames[$key] = $true }
        }
        $totals = Get-PropertyValue -Object $summary -Name "totals"
        $machineRows = Get-PropertyValue -Object $totals -Name "byMachine"
        if ($null -eq $machineRows) {
            $machineRows = Get-PropertyValue -Object $summary -Name "byMachine"
        }
        foreach ($row in @($machineRows)) {
            $key = [string]$row.name
            if (-not [string]::IsNullOrWhiteSpace($key)) { $machineNames[$key] = $true }
        }

        [void]$dailyEvidence.Add([ordered]@{
                dateUtc = $dateValue
                summaryPath = $summaryPath
                eventCount = [int]$summary.source.eventCount
                productionOperationCount = [int]$summary.production.operationCount
                generatedFileCount = [int]$summary.production.generatedFileCount
                topTools = @(Select-Rows -Rows $summary.toolUsage -Limit 12)
                topProjects = @(Select-Rows -Rows $summary.production.byProject -Limit 12)
                topMachineUsers = @(Select-Rows -Rows $summary.production.byMachineUser -Limit 12)
                topLevels = @(Select-Rows -Rows $summary.production.byLevel -Limit 12)
                topCategories = @(Select-Rows -Rows $summary.production.byCategory -Limit 12)
                guardedSamples = @(Select-Rows -Rows $summary.friction.guarded -Limit 8)
                failedSamples = @(Select-Rows -Rows $summary.friction.failed -Limit 8)
                slowSamples = @(Select-Rows -Rows $summary.friction.slow -Limit 8)
                sendCode = [ordered]@{
                    count = [int](Get-PropertyValue -Object $summarySendCode -Name "count")
                    rawCount = [int](Get-PropertyValue -Object $summarySendCode -Name "rawCount")
                    safeCount = [int](Get-PropertyValue -Object $summarySendCode -Name "safeCount")
                    manualTransactionCount = [int](Get-PropertyValue -Object $summarySendCode -Name "manualTransactionCount")
                    classificationCounts = @(Select-Rows -Rows (Get-PropertyValue -Object $summarySendCode -Name "classificationCounts") -Limit 10)
                    classificationSubtypes = @(Select-Rows -Rows (Get-PropertyValue -Object $summarySendCode -Name "classificationSubtypes") -Limit 10)
                    unclassifiedWriteReviewBuckets = @(Select-Rows -Rows (Get-PropertyValue -Object $summarySendCode -Name "unclassifiedWriteReviewBuckets") -Limit 10)
                    classificationPolicy = Get-PropertyValue -Object $summarySendCode -Name "classificationPolicy"
                }
                promotionCandidates = @(Select-Rows -Rows $summary.promotionCandidates -Limit 8)
                nativeToolCandidates = @(Select-Rows -Rows $summary.nativeToolCandidates -Limit 8)
                hotfixCandidates = @(Select-Rows -Rows $summary.hotfixCandidates -Limit 8)
                reconciliationCandidates = @(Select-Rows -Rows $summary.reconciliationCandidates -Limit 8)
                annotationInventoryCandidates = @(Select-Rows -Rows $summary.annotationInventoryCandidates -Limit 8)
            })
    }

    if ($correlation) {
        $totalCodexContexts += [int]$correlation.source.codexContextFileCount
        $totalCorrelations += [int]$correlation.summary.correlationCount
        $totalCorrelationsWithEvents += [int]$correlation.summary.correlationsWithRevAgentEvents
        $correlatedDynamicCodeCount += [int](Get-PropertyValue -Object $correlation.summary -Name "correlatedDynamicCodeCount")
        $correlationCountingPolicy = Get-PropertyValue -Object $correlation.summary -Name "countingPolicy"
        if ($correlationCountingPolicy) {
            [void]$correlationCountingPolicies.Add([ordered]@{
                    dateUtc = $dateValue
                    policy = $correlationCountingPolicy
                })
        }

        $contextRoot = [string]$correlation.source.codexContextRoot
        $eventRoot = [string]$correlation.source.revAgentEventRoot
        [void]$sourceFiles.Add([ordered]@{ kind = "codex_context_root"; dateUtc = $dateValue; path = $contextRoot; exists = (Test-Path -LiteralPath $contextRoot -PathType Container) })
        [void]$sourceFiles.Add([ordered]@{ kind = "revagent_event_root"; dateUtc = $dateValue; path = $eventRoot; exists = (Test-Path -LiteralPath $eventRoot -PathType Container) })

        foreach ($signal in @($correlation.productSignals)) {
            [void]$reviewSignals.Add([ordered]@{
                    dateUtc = $dateValue
                    codexSessionId = $signal.codexSessionId
                    machineName = $signal.machineName
                    userName = $signal.userName
                    signal = $signal.signal
                    evidence = $signal.evidence
                    suggestedAction = $signal.suggestedAction
                    classificationCounts = @(Select-Rows -Rows (Get-PropertyValue -Object $signal -Name "classificationCounts") -Limit 10)
                    classificationSubtypes = @(Select-Rows -Rows (Get-PropertyValue -Object $signal -Name "classificationSubtypes") -Limit 10)
                    unclassifiedWriteReviewBuckets = @(Select-Rows -Rows (Get-PropertyValue -Object $signal -Name "unclassifiedWriteReviewBuckets") -Limit 10)
                })
        }

        foreach ($item in @($correlation.correlations)) {
            $itemSendCode = Get-PropertyValue -Object $item -Name "sendCode"
            if ($itemSendCode) {
                Add-CountRows -Map $correlatedSendCodeClassificationCounts -Rows (Get-PropertyValue -Object $itemSendCode -Name "classificationCounts")
                Add-CountRows -Map $correlatedSendCodeClassificationSubtypeCounts -Rows (Get-PropertyValue -Object $itemSendCode -Name "classificationSubtypes")
                Add-CountRows -Map $correlatedUnclassifiedWriteReviewBucketCounts -Rows (Get-PropertyValue -Object $itemSendCode -Name "unclassifiedWriteReviewBuckets")
            }
        }

        foreach ($item in @($correlation.correlations | Select-Object -First $MaxSessions)) {
            $intent = Join-NonEmptyText -Items $item.userIntent -Limit 5
            $outcome = Join-NonEmptyText -Items $item.assistantOutcome -Limit 3
            $itemSendCode = Get-PropertyValue -Object $item -Name "sendCode"
            [void]$sessionEvidence.Add([ordered]@{
                    dateUtc = $dateValue
                    codexSessionId = $item.codexSessionId
                    threadId = $item.threadId
                    threadTitle = $item.threadTitle
                    machineName = $item.machineName
                    userName = $item.userName
                    timeWindow = $item.timeWindow
                    workspaceMatch = $item.workspaceMatch
                    userIntent = @($intent)
                    assistantOutcome = @($outcome)
                    codex = $item.codex
                    revAgent = $item.revAgent
                    outcome = $item.outcome
                    sendCode = $itemSendCode
                    friction = @($item.friction)
                    reviewSignals = @($item.productSignals)
                    source = [ordered]@{
                        sessionCorrelationPath = $correlationPath
                    }
                })
        }
    }
}

$pack = [ordered]@{
    schemaVersion = "revagent.usage.llmReviewPack.v1"
    packKind = "llm_input_not_final_report"
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    reportsRoot = $ReportsRoot
    dateRange = [ordered]@{
        startUtc = $dates[0]
        endUtc = $dates[$dates.Count - 1]
        datesUtc = @($dates)
    }
    output = [ordered]@{
        jsonPath = $OutputPath
        markdownPromptPath = if ($SkipMarkdown) { $null } else { $MarkdownOutputPath }
    }
    llmInstructions = [ordered]@{
        purpose = "Use this bounded evidence pack to prepare a semantic revAgent usage report. Do not treat deterministic counters as the final report."
        language = "Turkish-first unless the user asks otherwise."
        analysisQuestions = @(
            "Which users worked on which projects, dates, and approximate time windows?",
            "Which levels, views, sheets, schedules, or work areas created friction?",
            "What did users ask Codex to do, and how well did revAgent satisfy those intents?",
            "Where did revAgent understand the user well, and where did user wording, tool routing, or guard behavior create friction?",
            "Which users may need targeted training, and what should that training cover?",
            "Which revAgent tools, prompts, guards, or native capabilities should be improved next?",
            "Which findings are strong evidence, and which require follow-up inspection of source files?"
        )
        interpretationRules = @(
            "Bounded Codex context is not a full transcript.",
            "Guarded revAgent operations can be correct safety behavior, not necessarily failures.",
            "Partial results usually mean bounded scan budgets or scope pressure; inspect follow-up turns before calling them failures.",
            "Use daily summary send_code counts for factual volume.",
            "Session correlation windows may overlap. Do not sum session dynamic-code counts as daily totals; use them only as intent-linked evidence.",
            "Repeated send_code becomes native-tool work only when classification is capability_gap; routing_miss, tool_tuning_gap, policy_gap, and accepted_escape_hatch need different follow-up.",
            "unclassified_write_pattern review buckets are manual triage evidence only; do not treat them as native-tool candidates until a human confirms the actual mutation or missing capability.",
            "Use source paths in this pack when a claim needs deeper verification.",
            "Ask follow-up questions when management decisions require more detail than the bounded pack contains."
        )
    }
    overview = [ordered]@{
        dailySummaryCount = @($dailyEvidence.ToArray()).Count
        codexSessionContextCount = $totalCodexContexts
        sessionCorrelationCount = $totalCorrelations
        correlationsWithRevAgentEvents = $totalCorrelationsWithEvents
        revAgentEventCount = $totalEvents
        productionOperationCount = $totalOperations
        generatedFileCount = $totalGeneratedFiles
        reviewSignalCount = $reviewSignals.Count
        dailySendCodeCount = $dailySendCodeCount
        correlatedDynamicCodeCount = $correlatedDynamicCodeCount
        dailySendCodeClassificationCounts = @(Convert-CountMapToRows -Map $dailySendCodeClassificationCounts -Limit 20)
        dailySendCodeClassificationSubtypes = @(Convert-CountMapToRows -Map $dailySendCodeClassificationSubtypeCounts -Limit 20)
        dailyUnclassifiedWriteReviewBuckets = @(Convert-CountMapToRows -Map $dailyUnclassifiedWriteReviewBucketCounts -Limit 20)
        correlatedSendCodeClassificationCounts = @(Convert-CountMapToRows -Map $correlatedSendCodeClassificationCounts -Limit 20)
        correlatedSendCodeClassificationSubtypes = @(Convert-CountMapToRows -Map $correlatedSendCodeClassificationSubtypeCounts -Limit 20)
        correlatedUnclassifiedWriteReviewBuckets = @(Convert-CountMapToRows -Map $correlatedUnclassifiedWriteReviewBucketCounts -Limit 20)
        countingPolicy = [ordered]@{
            dailySummariesAreFactualCounts = $true
            sessionWindowsMayOverlap = $true
            note = "Do not sum session correlation operation or dynamic-code counts as daily totals; use session correlation as intent-linked evidence."
        }
        correlationCountingPolicies = @($correlationCountingPolicies.ToArray())
        machineCount = $machineNames.Keys.Count
        machineUserCount = $userNames.Keys.Count
        projectCount = $projectNames.Keys.Count
    }
    sourceFiles = @($sourceFiles.ToArray())
    dailyEvidence = @($dailyEvidence.ToArray())
    sessionEvidence = @($sessionEvidence.ToArray())
    reviewSignals = @($reviewSignals.ToArray())
}

$outputDir = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}
$pack | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

if (-not $SkipMarkdown -and -not [string]::IsNullOrWhiteSpace($MarkdownOutputPath)) {
    $markdownDir = Split-Path -Parent $MarkdownOutputPath
    if (-not [string]::IsNullOrWhiteSpace($markdownDir)) {
        New-Item -ItemType Directory -Path $markdownDir -Force | Out-Null
    }
    New-PackMarkdown -Pack $pack | Set-Content -LiteralPath $MarkdownOutputPath -Encoding UTF8
}

$pack | ConvertTo-Json -Depth 40
