<#
.SYNOPSIS
    Correlate bounded Codex session context with revAgent telemetry.

.DESCRIPTION
    Reads NAS-hosted Codex session context JSON and revAgent telemetry NDJSON
    for one UTC day, then writes a deterministic intent/action/outcome evidence
    packet for product analysis.
#>

[CmdletBinding()]
param(
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports",
    [string]$DateUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd"),
    [string]$OutputPath = "",
    [string]$MarkdownOutputPath = "",
    [int]$TimeWindowMinutes = 45,
    [int]$Top = 50,
    [switch]$SkipMarkdown
)

$ErrorActionPreference = "Stop"

function Get-ReportValue {
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
    if ($property) {
        return $property.Value
    }

    return $null
}

function Get-NestedReportValue {
    param(
        [object]$Object,
        [string[]]$Path
    )

    $current = $Object
    foreach ($part in $Path) {
        $current = Get-ReportValue -Object $current -Name $part
        if ($null -eq $current) {
            return $null
        }
    }

    return $current
}

function ConvertTo-UtcDate {
    param([string]$Value)

    try {
        return ([datetime]::ParseExact(
            $Value,
            "yyyy-MM-dd",
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AssumeUniversal
        )).ToUniversalTime()
    }
    catch {
        throw "DateUtc must use yyyy-MM-dd, got '$Value'."
    }
}

function ConvertTo-UtcDateTimeOrNull {
    param([object]$Value)

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return $null
    }

    try {
        return ([datetime]::Parse(
            [string]$Value,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AssumeUniversal
        )).ToUniversalTime()
    }
    catch {
        return $null
    }
}

function Get-BooleanOrNull {
    param([object]$Value)

    if ($null -eq $Value) {
        return $null
    }
    if ($Value -is [bool]) {
        return [bool]$Value
    }
    $text = [string]$Value
    if ($text -match '^(true|1|yes)$') { return $true }
    if ($text -match '^(false|0|no)$') { return $false }
    return $null
}

function Add-Count {
    param(
        [hashtable]$Map,
        [string]$Key,
        [int]$Increment = 1
    )

    if ([string]::IsNullOrWhiteSpace($Key)) {
        return
    }
    if (-not $Map.ContainsKey($Key)) {
        $Map[$Key] = 0
    }
    $Map[$Key] += $Increment
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

function Read-JsonFileOrNull {
    param([string]$Path)

    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return $null
        }
        return Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        Write-Warning "Could not read JSON '$Path': $($_.Exception.Message)"
        return $null
    }
}

function Read-JsonLines {
    param([string]$Path)

    $items = [System.Collections.Generic.List[object]]::new()
    $badLines = 0
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [ordered]@{ events = @(); badLineCount = 0 }
    }

    foreach ($line in [System.IO.File]::ReadLines($Path, [System.Text.Encoding]::UTF8)) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        try {
            [void]$items.Add(($line | ConvertFrom-Json))
        }
        catch {
            $badLines++
        }
    }

    return [ordered]@{ events = @($items.ToArray()); badLineCount = $badLines }
}

function Get-EventTimestamp {
    param([object]$Event)

    return ConvertTo-UtcDateTimeOrNull (Get-ReportValue -Object $Event -Name "timestampUtc")
}

function Get-EventMachineName {
    param([object]$Event)
    return [string](Get-ReportValue -Object $Event -Name "machineName")
}

function Get-EventUserName {
    param([object]$Event)
    return [string](Get-ReportValue -Object $Event -Name "userName")
}

function Get-EventToolName {
    param([object]$Event)

    $eventType = [string](Get-ReportValue -Object $Event -Name "eventType")
    if ($eventType -eq "mcp.tool") {
        return [string](Get-ReportValue -Object $Event -Name "toolName")
    }
    if ($eventType -eq "revit.command") {
        $toolName = [string](Get-ReportValue -Object $Event -Name "logicalToolName")
        if ([string]::IsNullOrWhiteSpace($toolName)) {
            $toolName = [string](Get-ReportValue -Object $Event -Name "commandName")
        }
        return $toolName
    }

    $related = Get-ReportValue -Object $Event -Name "related"
    $toolName = [string](Get-ReportValue -Object $related -Name "toolName")
    if ([string]::IsNullOrWhiteSpace($toolName)) {
        $toolName = [string](Get-ReportValue -Object $related -Name "logicalToolName")
    }
    if ([string]::IsNullOrWhiteSpace($toolName)) {
        $toolName = [string](Get-ReportValue -Object $related -Name "commandName")
    }
    return $toolName
}

function Get-EventOperation {
    param([object]$Event)

    if ([string](Get-ReportValue -Object $Event -Name "eventType") -eq "production.context") {
        return Get-ReportValue -Object $Event -Name "operation"
    }
    return Get-ReportValue -Object $Event -Name "result"
}

function Test-EventGuarded {
    param([object]$Event)

    $operation = Get-EventOperation -Event $Event
    return (
        (Get-BooleanOrNull (Get-ReportValue -Object $operation -Name "guarded")) -eq $true -or
        ([string](Get-ReportValue -Object $operation -Name "state")) -eq "guarded"
    )
}

function Test-EventFailed {
    param([object]$Event)

    $operation = Get-EventOperation -Event $Event
    $success = Get-BooleanOrNull (Get-ReportValue -Object $operation -Name "success")
    return ($success -eq $false -and (Test-EventGuarded -Event $Event) -ne $true)
}

function Test-EventPartial {
    param([object]$Event)

    $search = Get-ReportValue -Object $Event -Name "search"
    $response = Get-ReportValue -Object $Event -Name "response"
    return (
        (Get-BooleanOrNull (Get-ReportValue -Object $search -Name "partial")) -eq $true -or
        (Get-BooleanOrNull (Get-ReportValue -Object $response -Name "partial")) -eq $true
    )
}

function Get-EventProject {
    param([object]$Event)

    return [string](Get-NestedReportValue -Object $Event -Path @("project", "documentTitle"))
}

function Get-EventWorkspacePath {
    param([object]$Event)

    return [string](Get-NestedReportValue -Object $Event -Path @("project", "documentPath"))
}

function Get-WorkspaceMatch {
    param(
        [object]$Context,
        [object[]]$Events
    )

    $workspace = Get-ReportValue -Object $Context -Name "workspace"
    $contextNames = @((Get-ReportValue -Object $workspace -Name "names") | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    $contextPaths = @((Get-ReportValue -Object $workspace -Name "paths") | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if ($contextNames.Count -eq 0 -and $contextPaths.Count -eq 0) {
        return [ordered]@{ matched = $false; reason = "no_codex_workspace_hint" }
    }

    foreach ($event in $Events) {
        $project = Get-EventProject -Event $event
        $path = Get-EventWorkspacePath -Event $event
        foreach ($name in $contextNames) {
            if ((-not [string]::IsNullOrWhiteSpace($project) -and $project.IndexOf([string]$name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -or
                (-not [string]::IsNullOrWhiteSpace($path) -and $path.IndexOf([string]$name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
                return [ordered]@{ matched = $true; reason = "workspace_name_matches_project_context"; value = $name }
            }
        }
        foreach ($contextPath in $contextPaths) {
            $leaf = ""
            try {
                $leaf = [System.IO.Path]::GetFileName(([string]$contextPath).TrimEnd("\", "/"))
            }
            catch {
            }
            if (-not [string]::IsNullOrWhiteSpace($leaf) -and -not [string]::IsNullOrWhiteSpace($path) -and
                $path.IndexOf($leaf, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                return [ordered]@{ matched = $true; reason = "workspace_path_leaf_matches_project_path"; value = $leaf }
            }
        }
    }

    return [ordered]@{ matched = $false; reason = "no_workspace_project_match" }
}

function Select-ContextText {
    param(
        [object]$Items,
        [int]$Limit = 3
    )

    return @(@($Items) |
        Where-Object { $null -ne $_ -and -not [string]::IsNullOrWhiteSpace([string]$_.text) } |
        Select-Object -First $Limit |
        ForEach-Object { [string]$_.text })
}

function New-CorrelationMarkdown {
    param([object]$Report)

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("# revAgent Session Correlation Product Insights")
    $lines.Add("")
    $lines.Add("- Date UTC: $($Report.dateUtc)")
    $lines.Add("- Generated UTC: $($Report.generatedAtUtc)")
    $lines.Add("- Codex context files: $($Report.source.codexContextFileCount)")
    $lines.Add("- revAgent event files: $($Report.source.revAgentEventFileCount)")
    $lines.Add("- Correlations: $($Report.summary.correlationCount)")
    $lines.Add("- Correlations with revAgent events: $($Report.summary.correlationsWithRevAgentEvents)")
    $lines.Add("- Product signals: $($Report.summary.productSignalCount)")
    $lines.Add("")
    $lines.Add("## Correlations")

    if (@($Report.correlations).Count -eq 0) {
        $lines.Add("")
        $lines.Add("No Codex session contexts were available for this day.")
    }
    else {
        foreach ($item in @($Report.correlations | Select-Object -First $Top)) {
            $intent = @($item.userIntent | Select-Object -First 1)
            $intentText = if ($intent.Count -gt 0) { [string]$intent[0] } else { "(no bounded user request)" }
            $lines.Add("")
            $lines.Add("### $($item.machineName)\$($item.userName) $($item.codexSessionId)")
            $lines.Add("")
            $lines.Add("- Time: $($item.timeWindow.startedAtUtc) -> $($item.timeWindow.endedAtUtc)")
            $lines.Add("- User intent: $intentText")
            $lines.Add("- Codex tool calls: $($item.codex.toolCallCount)")
            $lines.Add("- revAgent operations: $($item.revAgent.operationCount)")
            $lines.Add("- Outcome: success=$($item.outcome.successCount), guarded=$($item.outcome.guardedCount), failed=$($item.outcome.failedCount), partial=$($item.outcome.partialCount)")
            if (@($item.productSignals).Count -gt 0) {
                foreach ($signal in @($item.productSignals)) {
                    $lines.Add("- Product signal: $($signal.signal) | $($signal.suggestedAction)")
                }
            }
        }
    }

    return ($lines -join [Environment]::NewLine) + [Environment]::NewLine
}

$date = ConvertTo-UtcDate -Value $DateUtc
$year = $date.ToString("yyyy")
$month = $date.ToString("MM")
$day = $date.ToString("dd")

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path (Join-Path $ReportsRoot "summaries\daily") ("{0}.session-correlations.json" -f $date.ToString("yyyy-MM-dd"))
}
if (-not $SkipMarkdown -and [string]::IsNullOrWhiteSpace($MarkdownOutputPath)) {
    $MarkdownOutputPath = Join-Path (Join-Path $ReportsRoot "summaries\daily") ("{0}.product-insights.md" -f $date.ToString("yyyy-MM-dd"))
}

$contextRoot = Join-Path (Join-Path (Join-Path (Join-Path $ReportsRoot "codex-sessions") $year) $month) $day
$eventRoot = Join-Path (Join-Path (Join-Path (Join-Path $ReportsRoot "events") $year) $month) $day

$contextFiles = @()
if (Test-Path -LiteralPath $contextRoot -PathType Container) {
    $contextFiles = @(Get-ChildItem -LiteralPath $contextRoot -Recurse -File -Filter "*.context.json" -ErrorAction SilentlyContinue)
}

$eventFiles = @()
if (Test-Path -LiteralPath $eventRoot -PathType Container) {
    $eventFiles = @(Get-ChildItem -LiteralPath $eventRoot -Recurse -File -Filter "*.ndjson" -ErrorAction SilentlyContinue)
}

$contexts = @($contextFiles | ForEach-Object { Read-JsonFileOrNull -Path $_.FullName } | Where-Object { $null -ne $_ })
$events = [System.Collections.Generic.List[object]]::new()
$badEventLineCount = 0
foreach ($eventFile in $eventFiles) {
    $read = Read-JsonLines -Path $eventFile.FullName
    $badEventLineCount += [int]$read.badLineCount
    foreach ($event in @($read.events)) {
        [void]$events.Add($event)
    }
}

$correlations = [System.Collections.Generic.List[object]]::new()
$allProductSignals = [System.Collections.Generic.List[object]]::new()
$windowMinutes = [Math]::Max(1, $TimeWindowMinutes)

foreach ($context in $contexts) {
    $machineName = [string](Get-ReportValue -Object $context -Name "machineName")
    $userName = [string](Get-ReportValue -Object $context -Name "userName")
    $startedAt = ConvertTo-UtcDateTimeOrNull (Get-ReportValue -Object $context -Name "startedAtUtc")
    $endedAt = ConvertTo-UtcDateTimeOrNull (Get-ReportValue -Object $context -Name "endedAtUtc")
    if ($null -eq $startedAt) { $startedAt = $date }
    if ($null -eq $endedAt) { $endedAt = $startedAt }
    $windowStart = $startedAt.AddMinutes(-1 * $windowMinutes)
    $windowEnd = $endedAt.AddMinutes($windowMinutes)

    $matchedEvents = @($events.ToArray() | Where-Object {
            $eventTime = Get-EventTimestamp -Event $_
            if ($null -eq $eventTime -or $eventTime -lt $windowStart -or $eventTime -gt $windowEnd) {
                return $false
            }
            $eventMachine = Get-EventMachineName -Event $_
            $eventUser = Get-EventUserName -Event $_
            if (-not [string]::IsNullOrWhiteSpace($machineName) -and
                -not [string]::Equals($machineName, $eventMachine, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $false
            }
            if (-not [string]::IsNullOrWhiteSpace($userName) -and
                -not [string]::Equals($userName, $eventUser, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $false
            }
            return $true
        })

    $codexToolMap = @{}
    foreach ($tool in @((Get-ReportValue -Object $context -Name "toolUsage"))) {
        Add-Count -Map $codexToolMap -Key ([string](Get-ReportValue -Object $tool -Name "name")) -Increment ([int](Get-ReportValue -Object $tool -Name "count"))
    }

    $revAgentToolMap = @{}
    $projectMap = @{}
    $successCount = 0
    $guardedCount = 0
    $failedCount = 0
    $partialCount = 0
    $sendCodeCount = 0
    foreach ($event in $matchedEvents) {
        $toolName = Get-EventToolName -Event $event
        Add-Count -Map $revAgentToolMap -Key $toolName
        Add-Count -Map $projectMap -Key (Get-EventProject -Event $event)
        if ($toolName -eq "send_code_to_revit" -or $toolName -eq "send_code_to_revit_safe") {
            $sendCodeCount++
        }
        if (Test-EventGuarded -Event $event) {
            $guardedCount++
        }
        elseif (Test-EventFailed -Event $event) {
            $failedCount++
        }
        else {
            $operation = Get-EventOperation -Event $event
            if ((Get-BooleanOrNull (Get-ReportValue -Object $operation -Name "success")) -eq $true) {
                $successCount++
            }
        }
        if (Test-EventPartial -Event $event) {
            $partialCount++
        }
    }

    $userIntent = Select-ContextText -Items (Get-ReportValue -Object $context -Name "userRequests") -Limit 5
    $assistantOutcome = Select-ContextText -Items (Get-ReportValue -Object $context -Name "assistantOutcomes") -Limit 5
    $productSignals = [System.Collections.Generic.List[object]]::new()
    $friction = [System.Collections.Generic.List[object]]::new()

    if ($matchedEvents.Count -eq 0) {
        [void]$friction.Add([ordered]@{ signal = "no_matching_revagent_events"; detail = "No revAgent telemetry matched this Codex session time window." })
        [void]$productSignals.Add([ordered]@{
                signal = "missing_telemetry_correlation"
                evidence = "Codex session had no matching revAgent telemetry events."
                suggestedAction = "verify exporter time window, machine/user identity, or revAgent telemetry availability"
            })
    }
    if (@($userIntent).Count -gt 1) {
        [void]$friction.Add([ordered]@{ signal = "multi_turn_user_request"; detail = "The user asked more than once in the same bounded session context." })
    }
    if ($guardedCount -gt 0) {
        [void]$friction.Add([ordered]@{ signal = "guarded_revagent_operation"; detail = "$guardedCount guarded operation(s) matched this session." })
        [void]$productSignals.Add([ordered]@{
                signal = "guarded_workflow_friction"
                evidence = "$guardedCount guarded revAgent operation(s) matched the user's request window."
                suggestedAction = "review whether the guard needs better preflight, explanation, or a dedicated safe tool"
            })
    }
    if ($failedCount -gt 0) {
        [void]$friction.Add([ordered]@{ signal = "failed_revagent_operation"; detail = "$failedCount failed operation(s) matched this session." })
        [void]$productSignals.Add([ordered]@{
                signal = "failed_workflow_friction"
                evidence = "$failedCount failed revAgent operation(s) matched the user's request window."
                suggestedAction = "review error class and add hotfix, docs, or stronger tool guard"
            })
    }
    if ($partialCount -gt 0) {
        [void]$friction.Add([ordered]@{ signal = "partial_revagent_result"; detail = "$partialCount partial result(s) matched this session." })
        [void]$productSignals.Add([ordered]@{
                signal = "partial_result_friction"
                evidence = "$partialCount partial revAgent result(s) matched the user's request window."
                suggestedAction = "review scan budgets, scope prompts, and partial-result follow-up UX"
            })
    }
    if ($sendCodeCount -gt 0) {
        [void]$productSignals.Add([ordered]@{
                signal = "dynamic_code_usage"
                evidence = "$sendCodeCount send_code operation(s) matched the user's request window."
                suggestedAction = "review repeated dynamic-code task for possible native revAgent tool promotion"
            })
    }

    $workspaceMatch = Get-WorkspaceMatch -Context $context -Events $matchedEvents
    $correlation = [ordered]@{
        codexSessionId = Get-ReportValue -Object $context -Name "codexSessionId"
        threadId = Get-ReportValue -Object $context -Name "threadId"
        machineName = $machineName
        userName = $userName
        timeWindow = [ordered]@{
            startedAtUtc = $startedAt.ToString("o")
            endedAtUtc = $endedAt.ToString("o")
            matchedFromUtc = $windowStart.ToString("o")
            matchedToUtc = $windowEnd.ToString("o")
            windowMinutes = $windowMinutes
        }
        workspaceMatch = $workspaceMatch
        userIntent = @($userIntent)
        assistantOutcome = @($assistantOutcome)
        codex = [ordered]@{
            userRequestCount = @((Get-ReportValue -Object $context -Name "userRequests")).Count
            assistantOutcomeCount = @((Get-ReportValue -Object $context -Name "assistantOutcomes")).Count
            toolCallCount = @((Get-ReportValue -Object $context -Name "toolCalls")).Count
            toolUsage = @(Convert-CountMapToRows -Map $codexToolMap -Limit 20)
        }
        revAgent = [ordered]@{
            operationCount = $matchedEvents.Count
            toolUsage = @(Convert-CountMapToRows -Map $revAgentToolMap -Limit 20)
            projects = @(Convert-CountMapToRows -Map $projectMap -Limit 10)
        }
        outcome = [ordered]@{
            successCount = $successCount
            guardedCount = $guardedCount
            failedCount = $failedCount
            partialCount = $partialCount
            dynamicCodeCount = $sendCodeCount
        }
        friction = @($friction.ToArray())
        productSignals = @($productSignals.ToArray())
    }

    foreach ($signal in @($productSignals.ToArray())) {
        [void]$allProductSignals.Add([ordered]@{
                codexSessionId = $correlation.codexSessionId
                machineName = $machineName
                userName = $userName
                signal = $signal.signal
                evidence = $signal.evidence
                suggestedAction = $signal.suggestedAction
            })
    }

    [void]$correlations.Add($correlation)
}

$correlationsWithEvents = @($correlations.ToArray() | Where-Object { $_.revAgent.operationCount -gt 0 }).Count
$report = [ordered]@{
    schemaVersion = "revagent.usage.sessionCorrelation.v1"
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    dateUtc = $date.ToString("yyyy-MM-dd")
    reportsRoot = $ReportsRoot
    source = [ordered]@{
        codexContextRoot = $contextRoot
        codexContextFileCount = $contextFiles.Count
        revAgentEventRoot = $eventRoot
        revAgentEventFileCount = $eventFiles.Count
        revAgentEventCount = $events.Count
        badEventLineCount = $badEventLineCount
    }
    summary = [ordered]@{
        correlationCount = $correlations.Count
        correlationsWithRevAgentEvents = $correlationsWithEvents
        productSignalCount = $allProductSignals.Count
        timeWindowMinutes = $windowMinutes
    }
    correlations = @($correlations.ToArray())
    productSignals = @($allProductSignals.ToArray())
}

$outputDir = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}
$report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

if (-not $SkipMarkdown -and -not [string]::IsNullOrWhiteSpace($MarkdownOutputPath)) {
    $markdownDir = Split-Path -Parent $MarkdownOutputPath
    if (-not [string]::IsNullOrWhiteSpace($markdownDir)) {
        New-Item -ItemType Directory -Path $markdownDir -Force | Out-Null
    }
    New-CorrelationMarkdown -Report $report | Set-Content -LiteralPath $MarkdownOutputPath -Encoding UTF8
}

$report | ConvertTo-Json -Depth 30
