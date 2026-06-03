<#
.SYNOPSIS
    Summarize revAgent machine reports and runtime telemetry for one UTC day.

.DESCRIPTION
    Reads the NAS reports root produced by the updater/runtime telemetry layer:

      reports\machines\<machine>\latest.json
      reports\events\YYYY\MM\DD\<machine>\<sessionId>.ndjson

    The output is compact JSON intended for dashboards and later LLM analysis.
    The script is read-only unless -OutputPath is supplied.
#>

[CmdletBinding()]
param(
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports",
    [string]$DateUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd"),
    [string]$OutputPath = "",
    [int]$Top = 20,
    [int]$TaskSampleLimit = 40
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

function ConvertTo-StringArray {
    param([object]$Value)

    if ($null -eq $Value) {
        return @()
    }

    if ($Value -is [string]) {
        if ([string]::IsNullOrWhiteSpace($Value)) {
            return @()
        }
        return @($Value)
    }

    if ($Value -is [System.Collections.IEnumerable]) {
        return @($Value | ForEach-Object {
            if ($null -ne $_ -and -not [string]::IsNullOrWhiteSpace([string]$_)) {
                [string]$_
            }
        })
    }

    return @([string]$Value)
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
    if ($text -match '^(true|1|yes)$') {
        return $true
    }
    if ($text -match '^(false|0|no)$') {
        return $false
    }

    return $null
}

function Get-IntOrNull {
    param([object]$Value)

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return $null
    }

    $number = 0
    if ([int]::TryParse([string]$Value, [ref]$number)) {
        return $number
    }

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

function Add-Metric {
    param(
        [hashtable]$Map,
        [string]$Key,
        [object]$Success,
        [object]$Guarded,
        [object]$DurationMs
    )

    if ([string]::IsNullOrWhiteSpace($Key)) {
        return
    }

    if (-not $Map.ContainsKey($Key)) {
        $Map[$Key] = [ordered]@{
            name = $Key
            count = 0
            successCount = 0
            guardedCount = 0
            failedCount = 0
            durationCount = 0
            totalDurationMs = 0
            maxDurationMs = 0
        }
    }

    $entry = $Map[$Key]
    $entry.count++

    $successValue = Get-BooleanOrNull $Success
    $guardedValue = Get-BooleanOrNull $Guarded
    if ($successValue -eq $true) {
        $entry.successCount++
    }
    elseif ($successValue -eq $false) {
        if ($guardedValue -eq $true) {
            $entry.guardedCount++
        }
        else {
            $entry.failedCount++
        }
    }
    elseif ($guardedValue -eq $true) {
        $entry.guardedCount++
    }

    $durationValue = Get-IntOrNull $DurationMs
    if ($null -ne $durationValue) {
        $entry.durationCount++
        $entry.totalDurationMs += $durationValue
        if ($durationValue -gt $entry.maxDurationMs) {
            $entry.maxDurationMs = $durationValue
        }
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

function Convert-MetricMapToRows {
    param(
        [hashtable]$Map,
        [int]$Limit = 20
    )

    return @($Map.Values |
        Sort-Object @{ Expression = { $_.count }; Descending = $true }, name |
        Select-Object -First $Limit |
        ForEach-Object {
            $average = if ($_.durationCount -gt 0) {
                [Math]::Round(([double]$_.totalDurationMs / [double]$_.durationCount), 1)
            }
            else {
                $null
            }

            [ordered]@{
                name = $_.name
                count = $_.count
                successCount = $_.successCount
                guardedCount = $_.guardedCount
                failedCount = $_.failedCount
                averageDurationMs = $average
                maxDurationMs = $_.maxDurationMs
            }
    })
}

function Get-DynamicPromotionRepeatThreshold {
    $fallback = 2
    try {
        $rulesPath = Join-Path (Join-Path $PSScriptRoot "..") "config\dynamic-tool-promotion-rules.json"
        if (-not (Test-Path -LiteralPath $rulesPath -PathType Leaf)) {
            return $fallback
        }
        $rules = Get-Content -Raw -LiteralPath $rulesPath | ConvertFrom-Json
        $threshold = Get-IntOrNull (Get-ReportValue -Object $rules -Name "repeatThreshold")
        if ($null -eq $threshold -or $threshold -lt 2) {
            return $fallback
        }
        return $threshold
    }
    catch {
        return $fallback
    }
}

function Get-DynamicPromotionRegistry {
    try {
        $registryPath = Join-Path (Join-Path $PSScriptRoot "..") "config\dynamic-tool-promotion-registry.json"
        if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
            return $null
        }
        return Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Resolve-DynamicPromotionRegistryMatch {
    param(
        [string[]]$Reasons,
        [object]$Registry
    )

    $defaultAction = "review_for_native_runtime_tool"
    if ($null -ne $Registry) {
        $configuredDefault = [string](Get-ReportValue -Object $Registry -Name "defaultCandidateAction")
        if (-not [string]::IsNullOrWhiteSpace($configuredDefault)) {
            $defaultAction = $configuredDefault
        }
    }

    $reasonSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($reason in @($Reasons)) {
        if (-not [string]::IsNullOrWhiteSpace($reason)) {
            [void]$reasonSet.Add($reason)
        }
    }

    $matches = [System.Collections.Generic.List[object]]::new()
    if ($null -ne $Registry) {
        foreach ($entry in @($Registry.entries)) {
            $matchReasons = @(ConvertTo-StringArray (Get-ReportValue -Object $entry -Name "matchReasons"))
            $matchedReasons = @($matchReasons | Where-Object { $reasonSet.Contains([string]$_) })
            if ($matchedReasons.Count -eq 0) {
                continue
            }

            [void]$matches.Add([ordered]@{
                id = [string](Get-ReportValue -Object $entry -Name "id")
                state = [string](Get-ReportValue -Object $entry -Name "state")
                candidateAction = [string](Get-ReportValue -Object $entry -Name "candidateAction")
                matchedReasons = @($matchedReasons)
            })
        }
    }

    $action = $defaultAction
    $firstAction = @($matches | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.candidateAction) } | Select-Object -First 1)
    if ($firstAction.Count -gt 0) {
        $action = [string]$firstAction[0].candidateAction
    }

    return [ordered]@{
        candidateAction = $action
        registryMatches = @($matches)
    }
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

function Add-UniqueString {
    param(
        [System.Collections.Generic.List[string]]$List,
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return
    }
    if (-not $List.Contains($Value)) {
        [void]$List.Add($Value)
    }
}

function Get-CodeWritePatterns {
    param([object]$Code)

    $patterns = [System.Collections.Generic.List[string]]::new()
    foreach ($pattern in ConvertTo-StringArray (Get-ReportValue -Object $Code -Name "writePatterns")) {
        Add-UniqueString -List $patterns -Value $pattern
    }

    $preview = [string](Get-ReportValue -Object $Code -Name "preview")
    if ($preview -match '(?i)\.\s*SetCellText\s*\(') {
        Add-UniqueString -List $patterns -Value "Schedule.SetCellText"
    }
    if ($preview -match '(?i)\.\s*(InsertRow|RemoveRow|InsertColumn|RemoveColumn|SetCellStyle|SetMergedCell)\s*\(') {
        Add-UniqueString -List $patterns -Value "Schedule table edit"
    }

    return $patterns.ToArray()
}

function Get-SummaryContextText {
    param(
        [object]$Operation,
        [object]$Related,
        [object]$View,
        [object]$Elements
    )

    $activeView = Get-ReportValue -Object $View -Name "active"
    $parts = @(
        [string](Get-ReportValue -Object $Operation -Name "taskName"),
        [string](Get-ReportValue -Object $Operation -Name "query"),
        [string](Get-ReportValue -Object $Operation -Name "action"),
        [string](Get-ReportValue -Object $Related -Name "toolName"),
        [string](Get-ReportValue -Object $Related -Name "commandName"),
        [string](Get-ReportValue -Object $Related -Name "logicalToolName"),
        [string](Get-ReportValue -Object $activeView -Name "name")
    )
    $categories = ConvertTo-StringArray (Get-ReportValue -Object $Elements -Name "categories")
    return @($parts + $categories | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) -join " "
}

function Get-InferredDiscipline {
    param(
        [string]$Current,
        [string]$ContextText
    )

    if (-not [string]::IsNullOrWhiteSpace($Current)) {
        return $Current
    }

    $text = [string]$ContextText
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }

    if ($text -match '\bM\d{2,}[A-Za-z]?\b') { return "mechanical_hvac" }
    if ($text -match '\bP\d{2,}[A-Za-z]?\b') { return "mechanical_piping" }
    if ($text -match '\bE\d{2,}[A-Za-z]?\b') { return "electrical" }
    if ($text -match '\bS\d{2,}[A-Za-z]?\b') { return "structural" }
    if ($text -match '\bA\d{2,}[A-Za-z]?\b') { return "architectural" }
    if ($text -match '(duct|air terminal|mechanical equipment|diffuser|damper|hvac|fan coil|ahu|havaland|mekanik)') { return "mechanical_hvac" }
    if ($text -match '(pipe|plumbing|sanitary|domestic|hydronic|sprinkler|fire|piping|boru|yangın|yangin|temiz su|pis su)') { return "mechanical_piping" }
    if ($text -match '(electrical|cable|lighting|elektrik)') { return "electrical" }
    if ($text -match '(structural|beam|column|framing|statik|kiris|kolon)') { return "structural" }
    if ($text -match '(wall|door|window|room|space|architect|mimari)') { return "architectural" }
    if ($text -match '(schedule|sheet|drawing|revision|pafta|metraj|mahal listesi)') { return "schedule_documentation" }
    return $null
}

function Get-InferredLevelName {
    param(
        [string]$Current,
        [string]$ContextText
    )

    if (-not [string]::IsNullOrWhiteSpace($Current)) {
        return $Current
    }

    $text = [string]$ContextText
    if ($text -match '\b(?:level|lvl|l)\s*[-_ ]?(\d{1,2})\b') {
        return "Level {0:D2}" -f [int]$Matches[1]
    }
    if ($text -match '\b(?:kat|floor)\s*[-_ ]?(\d{1,2})\b') {
        return "Level {0:D2}" -f [int]$Matches[1]
    }
    if ($text -match '\b(?:basement|bodrum|b)\s*[-_ ]?(\d{1,2})\b') {
        return "Basement {0:D2}" -f [int]$Matches[1]
    }

    return $null
}

function Get-EventToolName {
    param([object]$Event)

    $eventType = [string](Get-ReportValue -Object $Event -Name "eventType")
    if ($eventType -eq "mcp.tool") {
        return Get-ReportValue -Object $Event -Name "toolName"
    }
    if ($eventType -eq "revit.command") {
        $toolName = Get-ReportValue -Object $Event -Name "commandName"
        if ([string]::IsNullOrWhiteSpace($toolName)) {
            $toolName = Get-ReportValue -Object $Event -Name "logicalToolName"
        }
        return $toolName
    }

    $related = Get-ReportValue -Object $Event -Name "related"
    $toolName = Get-ReportValue -Object $related -Name "toolName"
    if ([string]::IsNullOrWhiteSpace($toolName)) {
        $toolName = Get-ReportValue -Object $related -Name "commandName"
    }
    if ([string]::IsNullOrWhiteSpace($toolName)) {
        $toolName = Get-ReportValue -Object $related -Name "logicalToolName"
    }
    return $toolName
}

function Get-EventOperationObject {
    param([object]$Event)

    if ((Get-ReportValue -Object $Event -Name "eventType") -eq "production.context") {
        return Get-ReportValue -Object $Event -Name "operation"
    }

    return Get-ReportValue -Object $Event -Name "result"
}

function Get-EventDurationMs {
    param([object]$Event)

    if ((Get-ReportValue -Object $Event -Name "eventType") -eq "production.context") {
        return Get-NestedReportValue -Object $Event -Path @("operation", "durationMs")
    }

    return Get-ReportValue -Object $Event -Name "durationMs"
}

function Get-EventTimestampOrNull {
    param([object]$Event)

    $timestamp = [string](Get-ReportValue -Object $Event -Name "timestampUtc")
    if ([string]::IsNullOrWhiteSpace($timestamp)) {
        return $null
    }

    try {
        return ([datetime]::Parse(
            $timestamp,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AssumeUniversal
        )).ToUniversalTime()
    }
    catch {
        return $null
    }
}

function Test-EventGuarded {
    param([object]$Event)

    $operation = Get-EventOperationObject -Event $Event
    return (
        (Get-BooleanOrNull (Get-ReportValue -Object $operation -Name "guarded")) -eq $true -or
        ([string](Get-ReportValue -Object $operation -Name "state")) -eq "guarded"
    )
}

function Test-EventFailed {
    param([object]$Event)

    $operation = Get-EventOperationObject -Event $Event
    return (
        (Get-BooleanOrNull (Get-ReportValue -Object $operation -Name "success")) -eq $false -and
        (Test-EventGuarded -Event $Event) -ne $true
    )
}

function New-RawOperationBrief {
    param([object]$Event)

    $operation = Get-EventOperationObject -Event $Event
    $eventType = [string](Get-ReportValue -Object $Event -Name "eventType")

    [ordered]@{
        timestampUtc = Get-ReportValue -Object $Event -Name "timestampUtc"
        machineName = Get-ReportValue -Object $Event -Name "machineName"
        userName = Get-ReportValue -Object $Event -Name "userName"
        sessionId = Get-ReportValue -Object $Event -Name "sessionId"
        runId = Get-ReportValue -Object $Event -Name "eventId"
        tool = Get-EventToolName -Event $Event
        sourceEventType = $eventType
        taskName = Get-ReportValue -Object $Event -Name "taskName"
        project = $null
        view = $null
        level = $null
        room = $null
        discipline = $null
        durationMs = Get-EventDurationMs -Event $Event
        success = Get-ReportValue -Object $operation -Name "success"
        guarded = Get-ReportValue -Object $operation -Name "guarded"
        state = Get-ReportValue -Object $operation -Name "state"
        errorMessage = Get-ReportValue -Object $operation -Name "errorMessage"
        search = $null
    }
}

function New-OperationBrief {
    param([object]$Event)

    if ((Get-ReportValue -Object $Event -Name "eventType") -ne "production.context") {
        return New-RawOperationBrief -Event $Event
    }

    $operation = Get-ReportValue -Object $Event -Name "operation"
    $related = Get-ReportValue -Object $Event -Name "related"
    $project = Get-ReportValue -Object $Event -Name "project"
    $view = Get-ReportValue -Object $Event -Name "view"
    $location = Get-ReportValue -Object $Event -Name "location"
    $elements = Get-ReportValue -Object $Event -Name "elements"
    $search = Get-ReportValue -Object $Event -Name "search"
    $activeView = Get-ReportValue -Object $view -Name "active"
    $contextText = Get-SummaryContextText -Operation $operation -Related $related -View $view -Elements $elements
    $levelName = Get-InferredLevelName -Current ([string](Get-ReportValue -Object $location -Name "levelName")) -ContextText $contextText
    $disciplineName = Get-InferredDiscipline -Current ([string](Get-ReportValue -Object $elements -Name "disciplineHint")) -ContextText $contextText

    $toolName = Get-ReportValue -Object $related -Name "toolName"
    if ([string]::IsNullOrWhiteSpace($toolName)) {
        $toolName = Get-ReportValue -Object $related -Name "commandName"
    }
    if ([string]::IsNullOrWhiteSpace($toolName)) {
        $toolName = Get-ReportValue -Object $related -Name "logicalToolName"
    }

    [ordered]@{
        timestampUtc = Get-ReportValue -Object $Event -Name "timestampUtc"
        machineName = Get-ReportValue -Object $Event -Name "machineName"
        userName = Get-ReportValue -Object $Event -Name "userName"
        sessionId = Get-ReportValue -Object $Event -Name "sessionId"
        runId = Get-ReportValue -Object $Event -Name "runId"
        tool = $toolName
        sourceEventType = Get-ReportValue -Object $related -Name "sourceEventType"
        taskName = Get-ReportValue -Object $operation -Name "taskName"
        project = Get-ReportValue -Object $project -Name "documentTitle"
        view = Get-ReportValue -Object $activeView -Name "name"
        level = $levelName
        room = Get-ReportValue -Object $location -Name "roomName"
        discipline = $disciplineName
        durationMs = Get-ReportValue -Object $operation -Name "durationMs"
        success = Get-ReportValue -Object $operation -Name "success"
        guarded = Get-ReportValue -Object $operation -Name "guarded"
        state = Get-ReportValue -Object $operation -Name "state"
        errorMessage = Get-ReportValue -Object $operation -Name "errorMessage"
        search = if ($null -ne $search) {
            [ordered]@{
                searchBudget = Get-ReportValue -Object $search -Name "searchBudget"
                linkScope = Get-ReportValue -Object $search -Name "linkScope"
                planCandidateMode = Get-ReportValue -Object $search -Name "planCandidateMode"
                allowExpensiveSearch = Get-ReportValue -Object $search -Name "allowExpensiveSearch"
                scannedElementCount = Get-ReportValue -Object $search -Name "scannedElementCount"
                partial = Get-ReportValue -Object $search -Name "partial"
                scanStoppedReason = Get-ReportValue -Object $search -Name "scanStoppedReason"
                needsScope = Get-ReportValue -Object $search -Name "needsScope"
            }
        } else {
            $null
        }
    }
}

function Select-ProductionContextEvents {
    param([object[]]$Events)

    $buckets = @{}
    foreach ($event in $Events) {
        if ((Get-ReportValue -Object $event -Name "eventType") -ne "production.context") {
            continue
        }

        $runId = [string](Get-ReportValue -Object $event -Name "runId")
        $eventId = [string](Get-ReportValue -Object $event -Name "eventId")
        $key = if (-not [string]::IsNullOrWhiteSpace($runId)) { $runId } else { $eventId }
        if ([string]::IsNullOrWhiteSpace($key)) {
            $key = [string](Get-ReportValue -Object $event -Name "timestampUtc")
        }

        $sourceEventType = [string](Get-NestedReportValue -Object $event -Path @("related", "sourceEventType"))
        $priority = if ($sourceEventType -eq "mcp.tool") { 2 } else { 1 }
        if (-not $buckets.ContainsKey($key) -or $priority -ge $buckets[$key].priority) {
            $buckets[$key] = [ordered]@{
                priority = $priority
                event = $event
            }
        }
    }

    return @($buckets.Values |
        ForEach-Object { $_.event } |
        Sort-Object @{ Expression = { [string](Get-ReportValue -Object $_ -Name "timestampUtc") } })
}

function Test-ProductionContextCoversRawEvent {
    param(
        [object]$RawEvent,
        [object]$ProductionEvent
    )

    $rawEventType = [string](Get-ReportValue -Object $RawEvent -Name "eventType")
    if ($rawEventType -ne "mcp.tool" -and $rawEventType -ne "revit.command") {
        return $false
    }

    $related = Get-ReportValue -Object $ProductionEvent -Name "related"
    $sourceEventType = [string](Get-ReportValue -Object $related -Name "sourceEventType")
    if ($sourceEventType -ne $rawEventType) {
        return $false
    }

    $rawSession = [string](Get-ReportValue -Object $RawEvent -Name "sessionId")
    $productionSession = [string](Get-ReportValue -Object $ProductionEvent -Name "sessionId")
    if (-not [string]::IsNullOrWhiteSpace($rawSession) -and
        -not [string]::IsNullOrWhiteSpace($productionSession) -and
        $rawSession -ne $productionSession) {
        return $false
    }

    $rawTool = [string](Get-EventToolName -Event $RawEvent)
    $productionTool = [string](Get-EventToolName -Event $ProductionEvent)
    if (-not [string]::IsNullOrWhiteSpace($rawTool) -and
        -not [string]::IsNullOrWhiteSpace($productionTool) -and
        $rawTool -ne $productionTool) {
        return $false
    }

    $rawTaskName = [string](Get-ReportValue -Object $RawEvent -Name "taskName")
    $productionTaskName = [string](Get-NestedReportValue -Object $ProductionEvent -Path @("operation", "taskName"))
    if (-not [string]::IsNullOrWhiteSpace($rawTaskName) -and
        -not [string]::IsNullOrWhiteSpace($productionTaskName) -and
        $rawTaskName -ne $productionTaskName) {
        return $false
    }

    $rawDuration = Get-IntOrNull (Get-EventDurationMs -Event $RawEvent)
    $productionDuration = Get-IntOrNull (Get-EventDurationMs -Event $ProductionEvent)
    if ($null -ne $rawDuration -and $null -ne $productionDuration -and $rawDuration -ne $productionDuration) {
        return $false
    }

    $rawSequence = Get-IntOrNull (Get-ReportValue -Object $RawEvent -Name "sequence")
    $productionSequence = Get-IntOrNull (Get-ReportValue -Object $ProductionEvent -Name "sequence")
    if ($null -ne $rawSequence -and $null -ne $productionSequence -and
        [Math]::Abs($productionSequence - $rawSequence) -le 2) {
        return $true
    }

    $rawTime = Get-EventTimestampOrNull -Event $RawEvent
    $productionTime = Get-EventTimestampOrNull -Event $ProductionEvent
    if ($null -ne $rawTime -and $null -ne $productionTime -and
        [Math]::Abs(($productionTime - $rawTime).TotalSeconds) -le 30) {
        return $true
    }

    return $false
}

function Select-OperationSampleEvents {
    param(
        [object[]]$Events,
        [object[]]$ProductionEvents
    )

    $rawOperationEvents = @($Events | Where-Object {
        $eventType = [string](Get-ReportValue -Object $_ -Name "eventType")
        $eventType -eq "mcp.tool" -or $eventType -eq "revit.command"
    })

    $uncoveredRawEvents = @($rawOperationEvents | Where-Object {
        $rawEvent = $_
        $covered = $false
        foreach ($productionEvent in $ProductionEvents) {
            if (Test-ProductionContextCoversRawEvent -RawEvent $rawEvent -ProductionEvent $productionEvent) {
                $covered = $true
                break
            }
        }
        -not $covered
    })

    $combined = @(@($ProductionEvents) + @($uncoveredRawEvents) |
        Sort-Object @{ Expression = { [string](Get-ReportValue -Object $_ -Name "timestampUtc") } })

    return Select-UniqueOperationSampleEvents -Events $combined
}

function Get-OperationSamplePriority {
    param([object]$Event)

    $eventType = [string](Get-ReportValue -Object $Event -Name "eventType")
    if ($eventType -eq "production.context") {
        return 3
    }
    if ($eventType -eq "mcp.tool") {
        return 2
    }
    return 1
}

function Get-OperationSampleGroupingKey {
    param([object]$Event)

    $eventType = [string](Get-ReportValue -Object $Event -Name "eventType")
    if ($eventType -eq "production.context") {
        $runId = [string](Get-ReportValue -Object $Event -Name "runId")
        if (-not [string]::IsNullOrWhiteSpace($runId)) {
            return "production|" + $runId
        }
    }

    $timestamp = Get-EventTimestampOrNull -Event $Event
    $timeBucket = [string](Get-ReportValue -Object $Event -Name "timestampUtc")
    if ($null -ne $timestamp) {
        $bucketSeconds = [Math]::Floor($timestamp.Second / 5) * 5
        $utc = $timestamp.ToUniversalTime()
        $bucket = [datetime]::new($utc.Year, $utc.Month, $utc.Day, $utc.Hour, $utc.Minute, [int]$bucketSeconds, [System.DateTimeKind]::Utc)
        $timeBucket = $bucket.ToString("yyyy-MM-ddTHH:mm:ssZ")
    }

    $operation = Get-EventOperationObject -Event $Event
    $state = [string](Get-ReportValue -Object $operation -Name "state")
    if ([string]::IsNullOrWhiteSpace($state)) {
        if (Test-EventGuarded -Event $Event) {
            $state = "guarded"
        }
        elseif (Test-EventFailed -Event $Event) {
            $state = "failed"
        }
        else {
            $state = "completed"
        }
    }

    return (@(
        "raw",
        [string](Get-ReportValue -Object $Event -Name "machineName"),
        [string](Get-ReportValue -Object $Event -Name "sessionId"),
        [string](Get-ReportValue -Object $Event -Name "taskName"),
        $state,
        $timeBucket
    ) -join "|")
}

function Select-UniqueOperationSampleEvents {
    param([object[]]$Events)

    $buckets = @{}
    foreach ($event in $Events) {
        $key = Get-OperationSampleGroupingKey -Event $event
        if ([string]::IsNullOrWhiteSpace($key)) {
            $key = [string](Get-ReportValue -Object $event -Name "eventId")
        }

        $priority = Get-OperationSamplePriority -Event $event
        if (-not $buckets.ContainsKey($key) -or $priority -gt $buckets[$key].priority) {
            $buckets[$key] = [ordered]@{
                priority = $priority
                event = $event
            }
        }
    }

    return @($buckets.Values |
        ForEach-Object { $_.event } |
        Sort-Object @{ Expression = { [string](Get-ReportValue -Object $_ -Name "timestampUtc") } })
}

try {
    $date = [datetime]::ParseExact(
        $DateUtc,
        "yyyy-MM-dd",
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AssumeUniversal
    ).ToUniversalTime()
}
catch {
    throw "DateUtc must use yyyy-MM-dd, got '$DateUtc'."
}

$dayPath = Join-Path $ReportsRoot ("events\{0}\{1}\{2}" -f $date.ToString("yyyy"), $date.ToString("MM"), $date.ToString("dd"))
$machineRoot = Join-Path $ReportsRoot "machines"

$machineReports = @()
if (Test-Path -LiteralPath $machineRoot -PathType Container) {
    $machineReports = @(Get-ChildItem -LiteralPath $machineRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name |
        ForEach-Object {
            $latestPath = Join-Path $_.FullName "latest.json"
            $report = Read-JsonFileOrNull -Path $latestPath
            if ($null -eq $report) {
                return
            }

            [ordered]@{
                machine = $_.Name
                computerName = Get-ReportValue -Object $report -Name "computerName"
                userName = Get-ReportValue -Object $report -Name "userName"
                status = Get-ReportValue -Object $report -Name "status"
                operation = Get-ReportValue -Object $report -Name "operation"
                operationMethod = Get-ReportValue -Object $report -Name "operationMethod"
                atUtc = Get-ReportValue -Object $report -Name "atUtc"
                previousVersion = Get-ReportValue -Object $report -Name "previousVersion"
                targetVersion = Get-ReportValue -Object $report -Name "targetVersion"
                installedVersion = Get-ReportValue -Object $report -Name "installedVersion"
                localVersion = Get-NestedReportValue -Object $report -Path @("localInstall", "version")
                localComponentCount = Get-NestedReportValue -Object $report -Path @("localInstall", "componentCount")
                localManifestPath = Get-NestedReportValue -Object $report -Path @("localInstall", "manifestPath")
                deferredForRevitClose = Get-NestedReportValue -Object $report -Path @("diagnostics", "deferredForRevitClose")
                revitPayloadChanged = Get-NestedReportValue -Object $report -Path @("diagnostics", "revitPayloadChanged")
                fastPackageOnlyUpdate = Get-NestedReportValue -Object $report -Path @("diagnostics", "fastPackageOnlyUpdate")
                logPath = Get-NestedReportValue -Object $report -Path @("machineReport", "logPath")
            }
        })
}

$eventFiles = @()
if (Test-Path -LiteralPath $dayPath -PathType Container) {
    $eventFiles = @(Get-ChildItem -LiteralPath $dayPath -Recurse -File -Filter "*.ndjson" -ErrorAction SilentlyContinue |
        Sort-Object FullName)
}

$events = New-Object System.Collections.Generic.List[object]
$badLines = 0
foreach ($file in $eventFiles) {
    $lineNumber = 0
    foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $file.FullName -ErrorAction SilentlyContinue) {
        $lineNumber++
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $event = $line | ConvertFrom-Json
            $events.Add($event)
        }
        catch {
            $badLines++
            Write-Warning "Could not parse telemetry line $lineNumber in '$($file.FullName)': $($_.Exception.Message)"
        }
    }
}

$eventArray = @($events.ToArray())
$eventTypeCounts = @{}
$machineCounts = @{}
$userCounts = @{}
$sessionCounts = @{}
$toolMetrics = @{}
$commandMetrics = @{}
$sendCodeWritePatterns = @{}
$taskNameCounts = @{}

foreach ($event in $eventArray) {
    $eventType = [string](Get-ReportValue -Object $event -Name "eventType")
    Add-Count -Map $eventTypeCounts -Key $eventType
    Add-Count -Map $machineCounts -Key ([string](Get-ReportValue -Object $event -Name "machineName"))
    Add-Count -Map $userCounts -Key ([string](Get-ReportValue -Object $event -Name "userName"))
    Add-Count -Map $sessionCounts -Key ([string](Get-ReportValue -Object $event -Name "sessionId"))

    if ($eventType -eq "mcp.tool") {
        $toolName = [string](Get-ReportValue -Object $event -Name "toolName")
        $result = Get-ReportValue -Object $event -Name "result"
        Add-Metric -Map $toolMetrics -Key $toolName `
            -Success (Get-ReportValue -Object $result -Name "success") `
            -Guarded (Get-ReportValue -Object $result -Name "guarded") `
            -DurationMs (Get-ReportValue -Object $event -Name "durationMs")

        $taskName = [string](Get-ReportValue -Object $event -Name "taskName")
        Add-Count -Map $taskNameCounts -Key $taskName

        $code = Get-NestedReportValue -Object $event -Path @("params", "code")
        foreach ($pattern in Get-CodeWritePatterns -Code $code) {
            Add-Count -Map $sendCodeWritePatterns -Key $pattern
        }
    }
    elseif ($eventType -eq "revit.command") {
        $commandName = [string](Get-ReportValue -Object $event -Name "commandName")
        $result = Get-ReportValue -Object $event -Name "result"
        Add-Metric -Map $commandMetrics -Key $commandName `
            -Success (Get-ReportValue -Object $result -Name "success") `
            -Guarded (Get-ReportValue -Object $result -Name "guarded") `
            -DurationMs (Get-ReportValue -Object $event -Name "durationMs")
    }
}

$productionEvents = Select-ProductionContextEvents -Events $eventArray
$operationSampleEvents = Select-OperationSampleEvents -Events $eventArray -ProductionEvents $productionEvents
$projectMetrics = @{}
$disciplineMetrics = @{}
$levelMetrics = @{}
$categoryMetrics = @{}
$machineUserMetrics = @{}
$outputFileCount = 0

foreach ($event in $productionEvents) {
    $operation = Get-ReportValue -Object $event -Name "operation"
    $related = Get-ReportValue -Object $event -Name "related"
    $project = Get-ReportValue -Object $event -Name "project"
    $view = Get-ReportValue -Object $event -Name "view"
    $location = Get-ReportValue -Object $event -Name "location"
    $elements = Get-ReportValue -Object $event -Name "elements"
    $outputs = Get-ReportValue -Object $event -Name "outputs"
    $contextText = Get-SummaryContextText -Operation $operation -Related $related -View $view -Elements $elements

    $success = Get-ReportValue -Object $operation -Name "success"
    $guarded = Get-ReportValue -Object $operation -Name "guarded"
    $durationMs = Get-ReportValue -Object $operation -Name "durationMs"

    $projectName = [string](Get-ReportValue -Object $project -Name "documentTitle")
    if ([string]::IsNullOrWhiteSpace($projectName)) {
        $projectName = [string](Get-ReportValue -Object $project -Name "title")
    }
    Add-Metric -Map $projectMetrics -Key $projectName -Success $success -Guarded $guarded -DurationMs $durationMs
    Add-Metric -Map $disciplineMetrics -Key (Get-InferredDiscipline -Current ([string](Get-ReportValue -Object $elements -Name "disciplineHint")) -ContextText $contextText) -Success $success -Guarded $guarded -DurationMs $durationMs
    Add-Metric -Map $levelMetrics -Key (Get-InferredLevelName -Current ([string](Get-ReportValue -Object $location -Name "levelName")) -ContextText $contextText) -Success $success -Guarded $guarded -DurationMs $durationMs

    $machineUser = ("{0}\{1}" -f (Get-ReportValue -Object $event -Name "machineName"), (Get-ReportValue -Object $event -Name "userName")).Trim("\")
    Add-Metric -Map $machineUserMetrics -Key $machineUser -Success $success -Guarded $guarded -DurationMs $durationMs

    foreach ($category in ConvertTo-StringArray (Get-ReportValue -Object $elements -Name "categories")) {
        Add-Metric -Map $categoryMetrics -Key $category -Success $success -Guarded $guarded -DurationMs $durationMs
    }

    $files = @(Get-ReportValue -Object $outputs -Name "files")
    $outputFileCount += $files.Count
}

$guardedOperations = @($operationSampleEvents |
    Where-Object { Test-EventGuarded -Event $_ } |
    Sort-Object @{ Expression = { [string](Get-ReportValue -Object $_ -Name "timestampUtc") }; Descending = $true } |
    Select-Object -First $Top |
    ForEach-Object { New-OperationBrief -Event $_ })

$failedOperations = @($operationSampleEvents |
    Where-Object { Test-EventFailed -Event $_ } |
    Sort-Object @{ Expression = { [string](Get-ReportValue -Object $_ -Name "timestampUtc") }; Descending = $true } |
    Select-Object -First $Top |
    ForEach-Object { New-OperationBrief -Event $_ })

$slowOperations = @($operationSampleEvents |
    Where-Object { $null -ne (Get-IntOrNull (Get-EventDurationMs -Event $_)) } |
    Sort-Object @{ Expression = { Get-IntOrNull (Get-EventDurationMs -Event $_) }; Descending = $true } |
    Select-Object -First $Top |
    ForEach-Object { New-OperationBrief -Event $_ })

$sendCodeEvents = @($eventArray | Where-Object {
    $eventType = [string](Get-ReportValue -Object $_ -Name "eventType")
    if ($eventType -ne "mcp.tool") {
        return $false
    }
    $toolName = [string](Get-ReportValue -Object $_ -Name "toolName")
    return $toolName -eq "send_code_to_revit" -or $toolName -eq "send_code_to_revit_safe"
})

$sendCodeSamples = @($sendCodeEvents |
    Select-Object -First $Top |
    ForEach-Object {
        $code = Get-NestedReportValue -Object $_ -Path @("params", "code")
        [ordered]@{
            timestampUtc = Get-ReportValue -Object $_ -Name "timestampUtc"
            machineName = Get-ReportValue -Object $_ -Name "machineName"
            userName = Get-ReportValue -Object $_ -Name "userName"
            toolName = Get-ReportValue -Object $_ -Name "toolName"
            taskName = Get-ReportValue -Object $_ -Name "taskName"
            hash = Get-ReportValue -Object $code -Name "hash"
            length = Get-ReportValue -Object $code -Name "length"
            lineCount = Get-ReportValue -Object $code -Name "lineCount"
            hasManualTransaction = Get-ReportValue -Object $code -Name "hasManualTransaction"
            writePatterns = Get-CodeWritePatterns -Code $code
            preview = Get-ReportValue -Object $code -Name "preview"
        }
    })

$promotionRepeatThreshold = Get-DynamicPromotionRepeatThreshold
$promotionRegistry = Get-DynamicPromotionRegistry
$sendCodePatternGroups = @{}
foreach ($event in $sendCodeEvents) {
    $code = Get-NestedReportValue -Object $event -Path @("params", "code")
    $hash = [string](Get-ReportValue -Object $code -Name "hash")
    if ([string]::IsNullOrWhiteSpace($hash)) {
        continue
    }

    if (-not $sendCodePatternGroups.ContainsKey($hash)) {
        $sendCodePatternGroups[$hash] = [ordered]@{
            hash = $hash
            count = 0
            toolNames = @{}
            taskNames = @{}
            writePatterns = @{}
            hasManualTransaction = $false
            maxLength = 0
            maxLineCount = 0
            preview = ""
        }
    }

    $entry = $sendCodePatternGroups[$hash]
    $entry.count++
    Add-Count -Map $entry.toolNames -Key ([string](Get-ReportValue -Object $event -Name "toolName"))
    Add-Count -Map $entry.taskNames -Key ([string](Get-ReportValue -Object $event -Name "taskName"))
    foreach ($pattern in Get-CodeWritePatterns -Code $code) {
        Add-Count -Map $entry.writePatterns -Key $pattern
    }
    if ((Get-BooleanOrNull (Get-ReportValue -Object $code -Name "hasManualTransaction")) -eq $true) {
        $entry.hasManualTransaction = $true
    }
    $length = Get-IntOrNull (Get-ReportValue -Object $code -Name "length")
    if ($null -ne $length -and $length -gt $entry.maxLength) {
        $entry.maxLength = $length
    }
    $lineCount = Get-IntOrNull (Get-ReportValue -Object $code -Name "lineCount")
    if ($null -ne $lineCount -and $lineCount -gt $entry.maxLineCount) {
        $entry.maxLineCount = $lineCount
    }
    if ([string]::IsNullOrWhiteSpace([string]$entry.preview)) {
        $entry.preview = [string](Get-ReportValue -Object $code -Name "preview")
    }
}

$sendCodePromotionCandidates = @($sendCodePatternGroups.Values |
    ForEach-Object {
        $reasons = [System.Collections.Generic.List[string]]::new()
        if ($_.count -ge $promotionRepeatThreshold) {
            [void]$reasons.Add("repeated_hash")
        }
        if ($_.writePatterns.Count -gt 0) {
            [void]$reasons.Add("write_patterns_present")
        }
        if ($_.hasManualTransaction -eq $true) {
            [void]$reasons.Add("manual_transaction")
        }
        if ($reasons.Count -eq 0) {
            return
        }
        $registryMatch = Resolve-DynamicPromotionRegistryMatch -Reasons $reasons.ToArray() -Registry $promotionRegistry

        [ordered]@{
            hash = $_.hash
            count = $_.count
            promotionReasons = $reasons.ToArray()
            candidateAction = $registryMatch.candidateAction
            registryMatches = @($registryMatch.registryMatches)
            toolNames = @(Convert-CountMapToRows -Map $_.toolNames -Limit 5)
            taskNames = @(Convert-CountMapToRows -Map $_.taskNames -Limit 5)
            writePatterns = @(Convert-CountMapToRows -Map $_.writePatterns -Limit 10)
            hasManualTransaction = $_.hasManualTransaction
            maxLength = $_.maxLength
            maxLineCount = $_.maxLineCount
            preview = $_.preview
        }
    } |
    Where-Object { $null -ne $_ } |
    Sort-Object @{ Expression = { $_.count }; Descending = $true }, hash |
    Select-Object -First $Top)

$taskNameSamples = @($taskNameCounts.GetEnumerator() |
    Sort-Object @{ Expression = { $_.Value }; Descending = $true }, Name |
    Select-Object -First $TaskSampleLimit |
    ForEach-Object {
        [ordered]@{
            taskName = [string]$_.Key
            count = [int]$_.Value
        }
    })

$searchPolicySamples = @($productionEvents |
    Where-Object { $null -ne (Get-ReportValue -Object $_ -Name "search") } |
    Select-Object -First $Top |
    ForEach-Object {
        $operation = Get-ReportValue -Object $_ -Name "operation"
        $related = Get-ReportValue -Object $_ -Name "related"
        $search = Get-ReportValue -Object $_ -Name "search"
        [ordered]@{
            timestampUtc = Get-ReportValue -Object $_ -Name "timestampUtc"
            machineName = Get-ReportValue -Object $_ -Name "machineName"
            userName = Get-ReportValue -Object $_ -Name "userName"
            tool = Get-ReportValue -Object $related -Name "toolName"
            taskName = Get-ReportValue -Object $operation -Name "taskName"
            riskLevel = Get-ReportValue -Object $search -Name "riskLevel"
            recommendedFirstScope = Get-ReportValue -Object $search -Name "recommendedFirstScope"
            requiresUserControl = Get-ReportValue -Object $search -Name "requiresUserControl"
            searchBudget = Get-ReportValue -Object $search -Name "searchBudget"
            linkScope = Get-ReportValue -Object $search -Name "linkScope"
            planCandidateMode = Get-ReportValue -Object $search -Name "planCandidateMode"
            allowExpensiveSearch = Get-ReportValue -Object $search -Name "allowExpensiveSearch"
            scannedElementCount = Get-ReportValue -Object $search -Name "scannedElementCount"
            partial = Get-ReportValue -Object $search -Name "partial"
            scanStoppedReason = Get-ReportValue -Object $search -Name "scanStoppedReason"
            needsScope = Get-ReportValue -Object $search -Name "needsScope"
        }
    })

$summary = [ordered]@{
    schemaVersion = "revagent.usage.summary.v1"
    dateUtc = $date.ToString("yyyy-MM-dd")
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    reportsRoot = $ReportsRoot
    source = [ordered]@{
        machineReportCount = $machineReports.Count
        eventFileCount = $eventFiles.Count
        eventCount = $eventArray.Count
        badEventLineCount = $badLines
    }
    machines = @($machineReports)
    totals = [ordered]@{
        byEventType = @(Convert-CountMapToRows -Map $eventTypeCounts -Limit $Top)
        byMachine = @(Convert-CountMapToRows -Map $machineCounts -Limit $Top)
        byUser = @(Convert-CountMapToRows -Map $userCounts -Limit $Top)
        sessionCount = $sessionCounts.Count
    }
    toolUsage = @(Convert-MetricMapToRows -Map $toolMetrics -Limit $Top)
    commandUsage = @(Convert-MetricMapToRows -Map $commandMetrics -Limit $Top)
    production = [ordered]@{
        operationCount = $productionEvents.Count
        byMachineUser = @(Convert-MetricMapToRows -Map $machineUserMetrics -Limit $Top)
        byProject = @(Convert-MetricMapToRows -Map $projectMetrics -Limit $Top)
        byDiscipline = @(Convert-MetricMapToRows -Map $disciplineMetrics -Limit $Top)
        byLevel = @(Convert-MetricMapToRows -Map $levelMetrics -Limit $Top)
        byCategory = @(Convert-MetricMapToRows -Map $categoryMetrics -Limit $Top)
        generatedFileCount = $outputFileCount
        taskNameSamples = @($taskNameSamples)
        searchPolicySamples = @($searchPolicySamples)
    }
    friction = [ordered]@{
        guarded = @($guardedOperations)
        failed = @($failedOperations)
        slow = @($slowOperations)
    }
    sendCode = [ordered]@{
        count = $sendCodeEvents.Count
        safeCount = @($sendCodeEvents | Where-Object { (Get-ReportValue -Object $_ -Name "toolName") -eq "send_code_to_revit_safe" }).Count
        rawCount = @($sendCodeEvents | Where-Object { (Get-ReportValue -Object $_ -Name "toolName") -eq "send_code_to_revit" }).Count
        manualTransactionCount = @($sendCodeEvents | Where-Object { (Get-NestedReportValue -Object $_ -Path @("params", "code", "hasManualTransaction")) -eq $true }).Count
        writePatterns = @(Convert-CountMapToRows -Map $sendCodeWritePatterns -Limit $Top)
        candidateRepeatThreshold = $promotionRepeatThreshold
        promotionCandidates = @($sendCodePromotionCandidates)
        samples = @($sendCodeSamples)
    }
}

$json = $summary | ConvertTo-Json -Depth 30
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    $outputDir = Split-Path -Parent $OutputPath
    if (-not [string]::IsNullOrWhiteSpace($outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }
    Set-Content -LiteralPath $OutputPath -Value $json -Encoding UTF8
}
else {
    $json
}
