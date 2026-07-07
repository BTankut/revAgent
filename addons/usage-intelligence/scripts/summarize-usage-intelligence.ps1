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
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports",
    [string]$DateUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd"),
    [string]$OutputPath = "",
    [int]$Top = 20,
    [int]$TaskSampleLimit = 40
)

$ErrorActionPreference = "Stop"

function Resolve-RevAgentRepositoryRoot {
    param([string]$StartPath = $PSScriptRoot)

    $current = [System.IO.DirectoryInfo]::new((Resolve-Path -LiteralPath $StartPath).Path)
    while ($null -ne $current) {
        $configPath = Join-Path $current.FullName "config\dynamic-tool-promotion-registry.json"
        $installerLibPath = Join-Path $current.FullName "installer\lib"
        if ((Test-Path -LiteralPath $configPath -PathType Leaf) -or
            (Test-Path -LiteralPath $installerLibPath -PathType Container)) {
            return $current.FullName
        }

        $current = $current.Parent
    }

    return (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
}

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
        $rulesPath = Join-Path (Resolve-RevAgentRepositoryRoot) "config\dynamic-tool-promotion-rules.json"
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
        $registryPath = Join-Path (Resolve-RevAgentRepositoryRoot) "config\dynamic-tool-promotion-registry.json"
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

function New-SendCodeClassification {
    param(
        [string]$Classification,
        [string]$Subtype,
        [string]$Confidence,
        [string[]]$Reasons,
        [string[]]$CoveredToolCandidates,
        [string]$SuggestedAction,
        [string]$ReviewBucket = "",
        [string[]]$ReviewSignals = @(),
        [bool]$RequiresManualTriage = $false
    )

    $result = [ordered]@{
        classification = $Classification
        subtype = $Subtype
        confidence = $Confidence
        reasons = @($Reasons)
        coveredToolCandidates = @($CoveredToolCandidates)
        suggestedAction = $SuggestedAction
    }
    if (-not [string]::IsNullOrWhiteSpace($ReviewBucket)) {
        $result.reviewBucket = $ReviewBucket
    }
    if (@($ReviewSignals).Count -gt 0) {
        $result.reviewSignals = @($ReviewSignals)
    }
    if ($RequiresManualTriage) {
        $result.requiresManualTriage = $true
    }

    return $result
}

function Get-SendCodeWriteReviewTriage {
    param(
        [string]$Preview,
        [string[]]$WritePatterns,
        [bool]$HasManualTransaction = $false
    )

    $signals = [System.Collections.Generic.List[string]]::new()
    if ($HasManualTransaction) {
        Add-UniqueString -List $signals -Value "manual_transaction"
    }
    foreach ($pattern in @($WritePatterns)) {
        Add-UniqueString -List $signals -Value ("write_pattern:{0}" -f $pattern)
    }

    $writePatternText = (@($WritePatterns) -join " ")
    $lower = (@($Preview, $writePatternText) |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) -join " "
    $lower = $lower.ToLowerInvariant()

    $dbMutationPattern = 'document\s*\.\s*(delete|create|regenerate)\s*\(|\.create\s*\(|newfamilyinstance|newopening|elementtransformutils\s*\.\s*(move|rotate|copy|mirror)|\.set\s*\(|setvaluestring\s*\(|setcelltext\s*\(|setcellstyle\s*\(|setmergedcell\s*\(|insertrow\s*\(|removerow\s*\(|insertcolumn\s*\(|removecolumn\s*\(|viewsheet\s*\.\s*create|schedulesheetinstance\s*\.\s*create|imageinstance\s*\.\s*create|setelementoverrides\s*\(|overridegraphicsettings|pinned\s*=|location\s*\.'
    $localAdapterPattern = 'stringbuilder|datatable|dictionary\s*<|list\s*<|hashset\s*<|jobject|jsonconvert|serializeobject|file\s*\.\s*(write|append|read)|streamwriter|csv|tsv|clipboard|excel|workbook|worksheet|xlsx|html|markdown|report|debug|output'
    $readHelperPattern = 'filteredelementcollector|getelement\s*\(|getparameters\s*\(|lookupparameter\s*\(|getcelltext\s*\(|getitemtext\s*\(|boundingbox|getboundingbox|transform|xyz|solid|geometry|viewport|textnote|independenttag'

    $hasDbMutation = $lower -match $dbMutationPattern
    $hasLocalAdapter = $lower -match $localAdapterPattern
    $hasReadHelper = $lower -match $readHelperPattern

    if ($hasDbMutation) {
        Add-UniqueString -List $signals -Value "revit_db_mutation_signal"
        return [ordered]@{ reviewBucket = "revit_db_mutation_review"; reviewSignals = @($signals.ToArray()) }
    }
    if ($hasLocalAdapter) {
        Add-UniqueString -List $signals -Value "local_export_or_report_adapter"
        return [ordered]@{ reviewBucket = "local_export_adapter_review"; reviewSignals = @($signals.ToArray()) }
    }
    if ($hasReadHelper) {
        Add-UniqueString -List $signals -Value "read_or_geometry_helper"
        return [ordered]@{ reviewBucket = "read_helper_or_geometry_review"; reviewSignals = @($signals.ToArray()) }
    }

    Add-UniqueString -List $signals -Value "ambiguous_write_signal"
    return [ordered]@{ reviewBucket = "ambiguous_write_review"; reviewSignals = @($signals.ToArray()) }
}

function Get-SendCodeDiagnosticClassification {
    param(
        [string]$ToolName,
        [string]$TaskName,
        [string]$Preview,
        [string[]]$WritePatterns,
        [bool]$HasManualTransaction = $false,
        [string]$ErrorMessage = ""
    )

    $writePatternText = (@($WritePatterns) -join " ")
    $text = (@($ToolName, $TaskName, $Preview, $writePatternText, $ErrorMessage) |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) -join " "
    $lower = $text.ToLowerInvariant()

    if ($lower -match 'rejected write-looking code') {
        return New-SendCodeClassification `
            -Classification "tool_tuning_gap" `
            -Subtype "safe_guard_false_positive_review" `
            -Confidence "medium" `
            -Reasons @("safe_guard_rejected_read_intent") `
            -CoveredToolCandidates @("send_code_to_revit_safe", "inspect_schedules", "inspect_sheet_text") `
            -SuggestedAction "Review the safe-code guard and route read-only extraction through bounded native readers before considering a new tool."
    }

    if ($lower -match 'document\.save|modeli kaydet|kaydet|save model|son kayit|son kayit') {
        return New-SendCodeClassification `
            -Classification "policy_gap" `
            -Subtype "model_save_policy" `
            -Confidence "high" `
            -Reasons @("document_save_pattern") `
            -CoveredToolCandidates @() `
            -SuggestedAction "Decide product policy for explicit model save before adding or recommending a native save tool."
    }

    if ($lower -match 'printmanager|print color|color depth|blackline|black line|test pdf|export active sheet test pdf|pdf') {
        return New-SendCodeClassification `
            -Classification "policy_gap" `
            -Subtype "pdf_print_settings_policy" `
            -Confidence "medium" `
            -Reasons @("pdf_or_print_setting_pattern") `
            -CoveredToolCandidates @("export_revit_view_image") `
            -SuggestedAction "Treat PDF and print-setting changes as a policy/design question; image export coverage alone is not enough."
    }

    if ($lower -match 'image type|reload placed|replace .*image|isometry|source view export|high resolution|white background|zoom out by view axes|view display style|views colored|make fcu views colored') {
        return New-SendCodeClassification `
            -Classification "capability_gap" `
            -Subtype "view_image_asset_workflow" `
            -Confidence "medium" `
            -Reasons @("view_or_image_asset_workflow") `
            -CoveredToolCandidates @("export_revit_view_image", "activate_view") `
            -SuggestedAction "Watch for repetition before designing a guarded view/image asset workflow."
    }

    if ($lower -match 'schedule table edit|setcellstyle|setmergedcell|insertrow|removerow|insertcolumn|removecolumn|border|borders|cerceve|cizgi|çizgi|grid|merged|merge|birles|birleştir|row height|font|text color|renk|style|width|genislik|genişlik|resize|fit sheet|create and place|recreate|manual schedule|visible schedule sections|split crsl|match uu02 block') {
        return New-SendCodeClassification `
            -Classification "capability_gap" `
            -Subtype "schedule_visual_structure" `
            -Confidence "high" `
            -Reasons @("schedule_visual_or_structure_pattern") `
            -CoveredToolCandidates @("inspect_schedules", "set_schedule_cells") `
            -SuggestedAction "Consider one guarded schedule-formatting design spike instead of one tool per table request."
    }

    $hasScheduleTextWrite = @($WritePatterns | Where-Object { $_ -eq "Schedule.SetCellText" }).Count -gt 0
    $hasParameterWrite = @($WritePatterns | Where-Object { $_ -eq "Parameter.Set" -or $_ -eq "Parameter.SetValueString" }).Count -gt 0
    $hasDestructiveWrite = @($WritePatterns | Where-Object { $_ -eq "Document.Delete" }).Count -gt 0 -or $lower -match 'document\s*\.\s*delete\s*\('
    if ($hasDestructiveWrite) {
        return New-SendCodeClassification `
            -Classification "capability_gap" `
            -Subtype "destructive_write_pattern" `
            -Confidence "medium" `
            -Reasons @("destructive_write_requires_human_review") `
            -CoveredToolCandidates @() `
            -SuggestedAction "Inspect the exact requested model mutation before deciding whether this is a real native capability, a policy gap, or an unsafe escape hatch."
    }
    if (($hasScheduleTextWrite -and $hasParameterWrite) -or $lower -match 'mixed renumber|header cells and body parameters|body parameters|body numbering') {
        return New-SendCodeClassification `
            -Classification "capability_gap" `
            -Subtype "mixed_schedule_parameter_workflow" `
            -Confidence "medium" `
            -Reasons @("mixed_schedule_cell_and_parameter_write") `
            -CoveredToolCandidates @("set_schedule_cells", "set_element_parameter") `
            -SuggestedAction "Review whether separate existing writes are enough or a guarded batch workflow is justified."
    }
    if ($HasManualTransaction -and ($hasScheduleTextWrite -or $hasParameterWrite)) {
        $coveredTools = @()
        if ($hasScheduleTextWrite) {
            $coveredTools += @("set_schedule_cells", "set_schedule_cells_by_text")
        }
        if ($hasParameterWrite) {
            $coveredTools += @("set_element_parameter")
        }
        return New-SendCodeClassification `
            -Classification "routing_miss" `
            -Subtype "manual_transaction_existing_write_tool_available" `
            -Confidence "medium" `
            -Reasons @("manual_transaction_with_existing_write_tool") `
            -CoveredToolCandidates $coveredTools `
            -SuggestedAction "Prefer the existing guarded write tools; inspect whether missing preflight, dry-run, or argument ergonomics pushed Codex into raw code."
    }
    if ($hasScheduleTextWrite) {
        return New-SendCodeClassification `
            -Classification "routing_miss" `
            -Subtype "schedule_cell_write_tool_available" `
            -Confidence "medium" `
            -Reasons @("schedule_cell_text_write_pattern") `
            -CoveredToolCandidates @("set_schedule_cells", "set_schedule_cells_by_text") `
            -SuggestedAction "Prefer existing schedule-cell write tools unless the task also needs unsupported formatting or batching."
    }
    if ($hasParameterWrite) {
        return New-SendCodeClassification `
            -Classification "routing_miss" `
            -Subtype "element_parameter_tool_available" `
            -Confidence "medium" `
            -Reasons @("parameter_write_pattern") `
            -CoveredToolCandidates @("set_element_parameter") `
            -SuggestedAction "Prefer set_element_parameter after inspect_parameter_schema preflight."
    }

    if (-not $HasManualTransaction -and @($WritePatterns).Count -eq 0) {
        if ($lower -match 'to tsv|export .*rows|export current|export placed|readable excel report|final qa tsv|schedule cells to') {
            return New-SendCodeClassification `
                -Classification "tool_tuning_gap" `
                -Subtype "export_friendly_read_output" `
                -Confidence "medium" `
                -Reasons @("read_only_export_or_report_shape") `
                -CoveredToolCandidates @("inspect_schedules", "inspect_sheet_text", "reconcile_schedule_excel") `
                -SuggestedAction "Improve read-tool output ergonomics or provide a standard local report adapter before adding a Revit tool."
        }
        if ($lower -match 'textnote|text note|sheet text|titleblock|title block|drawing list|sheet note|visible spl labels') {
            return New-SendCodeClassification `
                -Classification "routing_miss" `
                -Subtype "sheet_text_lookup_tool_available" `
                -Confidence "medium" `
                -Reasons @("sheet_or_textnote_read_pattern") `
                -CoveredToolCandidates @("inspect_sheet_text") `
                -SuggestedAction "Route sheet text, titleblock, and text note lookup through inspect_sheet_text first."
        }
        if ($lower -match 'schedule rows|schedule cells|header rows|placed schedules|inspect .*schedule|verify .*schedule|recheck .*schedule') {
            return New-SendCodeClassification `
                -Classification "routing_miss" `
                -Subtype "schedule_inspection_tool_available" `
                -Confidence "medium" `
                -Reasons @("schedule_read_pattern") `
                -CoveredToolCandidates @("inspect_schedules") `
                -SuggestedAction "Route schedule discovery and bounded cell reading through inspect_schedules first."
        }
        if ($lower -match 'count .*annotation|count .*convector|count .*fcu|nearest annotation|annotation texts') {
            return New-SendCodeClassification `
                -Classification "routing_miss" `
                -Subtype "annotation_or_element_count_tool_available" `
                -Confidence "low" `
                -Reasons @("count_or_annotation_read_pattern") `
                -CoveredToolCandidates @("count_annotations", "find_elements") `
                -SuggestedAction "Try count_annotations or find_elements with bounded scope before custom read-only code."
        }
    }

    if ($HasManualTransaction -or @($WritePatterns).Count -gt 0) {
        $triage = Get-SendCodeWriteReviewTriage -Preview $Preview -WritePatterns $WritePatterns -HasManualTransaction $HasManualTransaction
        return New-SendCodeClassification `
            -Classification "capability_gap" `
            -Subtype "unclassified_write_pattern" `
            -Confidence "low" `
            -Reasons @("write_pattern_requires_human_review") `
            -CoveredToolCandidates @() `
            -SuggestedAction "Manual triage required; use reviewBucket before deciding whether this is routing, tuning, acceptable escape hatch, or a real native capability gap." `
            -ReviewBucket ([string]$triage.reviewBucket) `
            -ReviewSignals @($triage.reviewSignals) `
            -RequiresManualTriage $true
    }

    return New-SendCodeClassification `
        -Classification "accepted_escape_hatch" `
        -Subtype "custom_low_signal_dynamic_code" `
        -Confidence "low" `
        -Reasons @("insufficient_repetition_or_no_obvious_tool") `
        -CoveredToolCandidates @() `
        -SuggestedAction "Keep as an audited escape hatch unless the pattern repeats with clear production value."
}

function Get-SendCodeEventClassification {
    param([object]$Event)

    $code = Get-NestedReportValue -Object $Event -Path @("params", "code")
    $operation = Get-EventOperationObject -Event $Event
    return Get-SendCodeDiagnosticClassification `
        -ToolName ([string](Get-ReportValue -Object $Event -Name "toolName")) `
        -TaskName ([string](Get-ReportValue -Object $Event -Name "taskName")) `
        -Preview ([string](Get-ReportValue -Object $code -Name "preview")) `
        -WritePatterns (Get-CodeWritePatterns -Code $code) `
        -HasManualTransaction ((Get-BooleanOrNull (Get-ReportValue -Object $code -Name "hasManualTransaction")) -eq $true) `
        -ErrorMessage ([string](Get-ReportValue -Object $operation -Name "errorMessage"))
}

function Get-SendCodePatternGroupClassification {
    param([object]$Entry)

    $toolNames = @($Entry.toolNames.Keys) -join " | "
    $taskNames = @($Entry.taskNames.Keys) -join " | "
    $writePatterns = @($Entry.writePatterns.Keys)
    return Get-SendCodeDiagnosticClassification `
        -ToolName $toolNames `
        -TaskName $taskNames `
        -Preview ([string]$Entry.preview) `
        -WritePatterns $writePatterns `
        -HasManualTransaction ([bool]$Entry.hasManualTransaction)
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

function Get-PromotionEvidenceStrength {
    param(
        [int]$Count,
        [int]$RepeatThreshold = 2
    )

    $threshold = [Math]::Max(2, $RepeatThreshold)
    if ($Count -ge [Math]::Max(4, $threshold * 2)) {
        return "strong"
    }
    if ($Count -ge $threshold) {
        return "medium"
    }
    return "weak"
}

function Get-EvidenceStrengthRank {
    param([string]$Value)

    switch ([string]$Value) {
        "strong" { return 3 }
        "medium" { return 2 }
        "weak" { return 1 }
        default { return 0 }
    }
}

function Get-AggregateEvidenceStrength {
    param([object[]]$Candidates)

    $best = "none"
    $bestRank = 0
    foreach ($candidate in @($Candidates)) {
        $rank = Get-EvidenceStrengthRank -Value ([string](Get-ReportValue -Object $candidate -Name "evidenceStrength"))
        if ($rank -gt $bestRank) {
            $bestRank = $rank
            $best = [string](Get-ReportValue -Object $candidate -Name "evidenceStrength")
        }
    }

    return $best
}

function Get-PromotionEventText {
    param([object]$Event)

    $operation = Get-EventOperationObject -Event $Event
    $search = Get-ReportValue -Object $Event -Name "search"
    $parts = @(
        [string](Get-ReportValue -Object $Event -Name "toolName"),
        [string](Get-ReportValue -Object $Event -Name "commandName"),
        [string](Get-ReportValue -Object $Event -Name "logicalToolName"),
        [string](Get-ReportValue -Object $Event -Name "taskName"),
        [string](Get-ReportValue -Object $operation -Name "taskName"),
        [string](Get-ReportValue -Object $operation -Name "action"),
        [string](Get-ReportValue -Object $operation -Name "query"),
        [string](Get-ReportValue -Object $operation -Name "errorMessage"),
        [string](Get-ReportValue -Object $search -Name "scanStoppedReason")
    )

    return ((@($parts | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) -join " ").ToLowerInvariant())
}

function Get-PromotionEvidenceSnippet {
    param([object]$Event)

    if ($null -eq $Event) {
        return ""
    }

    $operation = Get-EventOperationObject -Event $Event
    $search = Get-ReportValue -Object $Event -Name "search"
    $result = Get-ReportValue -Object $Event -Name "result"
    $taskName = [string](Get-ReportValue -Object $Event -Name "taskName")
    if ([string]::IsNullOrWhiteSpace($taskName)) {
        $taskName = [string](Get-ReportValue -Object $operation -Name "taskName")
    }

    $partial = Get-ReportValue -Object $search -Name "partial"
    if ($null -eq $partial) {
        $partial = Get-ReportValue -Object $result -Name "partial"
    }
    $scanStoppedReason = [string](Get-ReportValue -Object $search -Name "scanStoppedReason")
    if ([string]::IsNullOrWhiteSpace($scanStoppedReason)) {
        $scanStoppedReason = [string](Get-ReportValue -Object $result -Name "scanStoppedReason")
    }

    $preview = [string](Get-NestedReportValue -Object $Event -Path @("params", "code", "preview"))
    $errorMessage = [string](Get-ReportValue -Object $operation -Name "errorMessage")
    if ([string]::IsNullOrWhiteSpace($errorMessage)) {
        $errorMessage = [string](Get-ReportValue -Object $result -Name "errorMessage")
    }

    $parts = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($taskName)) {
        [void]$parts.Add("task: $taskName")
    }
    $toolName = [string](Get-EventToolName -Event $Event)
    if (-not [string]::IsNullOrWhiteSpace($toolName)) {
        [void]$parts.Add("tool: $toolName")
    }
    if (-not [string]::IsNullOrWhiteSpace($scanStoppedReason)) {
        [void]$parts.Add("stop: $scanStoppedReason")
    }
    if ($null -ne $partial -and -not [string]::IsNullOrWhiteSpace([string]$partial)) {
        [void]$parts.Add("partial: $partial")
    }
    if (-not [string]::IsNullOrWhiteSpace($errorMessage)) {
        [void]$parts.Add("error: $errorMessage")
    }
    if (-not [string]::IsNullOrWhiteSpace($preview)) {
        [void]$parts.Add("code: $preview")
    }
    if ($parts.Count -eq 0) {
        [void]$parts.Add("event: $([string](Get-ReportValue -Object $Event -Name "eventId"))")
    }

    $snippet = $parts -join " | "
    if ($snippet.Length -gt 260) {
        return $snippet.Substring(0, 257) + "..."
    }
    return $snippet
}

function New-PromotionEvidenceContext {
    param([object]$Event)

    if ($null -eq $Event) {
        return [ordered]@{
            sessionContext = [ordered]@{}
            toolContext = [ordered]@{}
        }
    }

    $operation = Get-EventOperationObject -Event $Event
    $sourceEventType = [string](Get-ReportValue -Object $Event -Name "eventType")
    $taskName = [string](Get-ReportValue -Object $Event -Name "taskName")
    if ([string]::IsNullOrWhiteSpace($taskName)) {
        $taskName = [string](Get-ReportValue -Object $operation -Name "taskName")
    }

    return [ordered]@{
        sessionContext = [ordered]@{
            sessionId = Get-ReportValue -Object $Event -Name "sessionId"
            eventId = Get-ReportValue -Object $Event -Name "eventId"
            runId = Get-ReportValue -Object $Event -Name "runId"
            timestampUtc = Get-ReportValue -Object $Event -Name "timestampUtc"
            machineName = Get-ReportValue -Object $Event -Name "machineName"
            userName = Get-ReportValue -Object $Event -Name "userName"
        }
        toolContext = [ordered]@{
            toolName = Get-EventToolName -Event $Event
            sourceEventType = $sourceEventType
            taskName = $taskName
            commandName = Get-ReportValue -Object $Event -Name "commandName"
            logicalToolName = Get-ReportValue -Object $Event -Name "logicalToolName"
        }
    }
}

function New-PromotionCandidate {
    param(
        [string]$Category,
        [string]$Signal,
        [string]$Title,
        [int]$Count,
        [object[]]$Events,
        [string[]]$Reasons,
        [string]$CandidateAction = "surface_for_human_review",
        [int]$RepeatThreshold = 2,
        [object]$Extra = $null
    )

    $sampleEvent = @($Events | Where-Object { $null -ne $_ } |
        Sort-Object @{ Expression = { [string](Get-ReportValue -Object $_ -Name "timestampUtc") } } |
        Select-Object -First 1)
    $sample = if ($sampleEvent.Count -gt 0) { $sampleEvent[0] } else { $null }
    $context = New-PromotionEvidenceContext -Event $sample
    $candidate = [ordered]@{
        category = $Category
        signal = $Signal
        title = $Title
        count = $Count
        promotionReasons = @($Reasons)
        candidateAction = $CandidateAction
        evidenceStrength = Get-PromotionEvidenceStrength -Count $Count -RepeatThreshold $RepeatThreshold
        humanReviewRequired = $true
        evidenceSnippet = Get-PromotionEvidenceSnippet -Event $sample
        sessionContext = $context.sessionContext
        toolContext = $context.toolContext
    }

    if ($null -ne $Extra) {
        if ($Extra -is [System.Collections.IDictionary]) {
            foreach ($key in $Extra.Keys) {
                $candidate[$key] = $Extra[$key]
            }
        }
        else {
            foreach ($property in @($Extra.PSObject.Properties)) {
                $candidate[$property.Name] = $property.Value
            }
        }
    }

    return $candidate
}

function Get-ScanStopReasonForPromotion {
    param([object]$Event)

    $operation = Get-EventOperationObject -Event $Event
    $search = Get-ReportValue -Object $Event -Name "search"
    $result = Get-ReportValue -Object $Event -Name "result"
    $reason = [string](Get-ReportValue -Object $search -Name "scanStoppedReason")
    if ([string]::IsNullOrWhiteSpace($reason)) {
        $reason = [string](Get-ReportValue -Object $result -Name "scanStoppedReason")
    }
    if ([string]::IsNullOrWhiteSpace($reason)) {
        $reason = [string](Get-ReportValue -Object $operation -Name "scanStoppedReason")
    }
    if ([string]::IsNullOrWhiteSpace($reason)) {
        $error = [string](Get-ReportValue -Object $operation -Name "errorMessage")
        if ([string]::IsNullOrWhiteSpace($error)) {
            $error = [string](Get-ReportValue -Object $result -Name "errorMessage")
        }
        if ($error -match '(?i)timeout|timed out|max elapsed') {
            return "max_elapsed"
        }
    }
    return $reason
}

function Test-PartialOrTimeoutFriction {
    param([object]$Event)

    $operation = Get-EventOperationObject -Event $Event
    $search = Get-ReportValue -Object $Event -Name "search"
    $result = Get-ReportValue -Object $Event -Name "result"
    $partial = Get-BooleanOrNull (Get-ReportValue -Object $search -Name "partial")
    if ($null -eq $partial) {
        $partial = Get-BooleanOrNull (Get-ReportValue -Object $result -Name "partial")
    }
    $reason = Get-ScanStopReasonForPromotion -Event $Event
    $error = [string](Get-ReportValue -Object $operation -Name "errorMessage")
    if ([string]::IsNullOrWhiteSpace($error)) {
        $error = [string](Get-ReportValue -Object $result -Name "errorMessage")
    }

    return (
        $partial -eq $true -or
        $reason -match '^(max_elapsed|max_rows|max_columns|max_cells|max_items|max_bytes|read_failed)$' -or
        $error -match '(?i)timeout|timed out|max elapsed'
    )
}

function Add-PromotionSignalEvent {
    param(
        [hashtable]$Map,
        [string]$Key,
        [string]$ToolName,
        [string]$Reason,
        [object]$Event
    )

    if ([string]::IsNullOrWhiteSpace($Key)) {
        return
    }
    if (-not $Map.ContainsKey($Key)) {
        $Map[$Key] = [ordered]@{
            key = $Key
            toolName = $ToolName
            reason = $Reason
            count = 0
            events = [System.Collections.Generic.List[object]]::new()
        }
    }

    $entry = $Map[$Key]
    $entry.count++
    [void]$entry.events.Add($Event)
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

$sendCodeClassificationCounts = @{}
$sendCodeClassificationSubtypeCounts = @{}
$sendCodeUnclassifiedWriteReviewBucketCounts = @{}
foreach ($event in $sendCodeEvents) {
    $classification = Get-SendCodeEventClassification -Event $event
    Add-Count -Map $sendCodeClassificationCounts -Key ([string]$classification.classification)
    Add-Count -Map $sendCodeClassificationSubtypeCounts -Key ([string]$classification.subtype)
    if ([string]$classification.subtype -eq "unclassified_write_pattern") {
        Add-Count -Map $sendCodeUnclassifiedWriteReviewBucketCounts -Key ([string]$classification.reviewBucket)
    }
}

$sendCodeSamples = @($sendCodeEvents |
    Select-Object -First $Top |
    ForEach-Object {
        $code = Get-NestedReportValue -Object $_ -Path @("params", "code")
        $classification = Get-SendCodeEventClassification -Event $_
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
            classification = $classification
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
            events = [System.Collections.Generic.List[object]]::new()
        }
    }

    $entry = $sendCodePatternGroups[$hash]
    $entry.count++
    [void]$entry.events.Add($event)
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
        $classification = Get-SendCodePatternGroupClassification -Entry $_
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

        $extra = [ordered]@{
            hash = $_.hash
            registryMatches = @($registryMatch.registryMatches)
            toolNames = @(Convert-CountMapToRows -Map $_.toolNames -Limit 5)
            taskNames = @(Convert-CountMapToRows -Map $_.taskNames -Limit 5)
            writePatterns = @(Convert-CountMapToRows -Map $_.writePatterns -Limit 10)
            hasManualTransaction = $_.hasManualTransaction
            maxLength = $_.maxLength
            maxLineCount = $_.maxLineCount
            classification = $classification
            preview = $_.preview
        }

        New-PromotionCandidate `
            -Category "send_code" `
            -Signal "dynamic_code_pattern" `
            -Title ("Dynamic code pattern {0}" -f $_.hash) `
            -Count $_.count `
            -Events @($_.events.ToArray()) `
            -Reasons $reasons.ToArray() `
            -CandidateAction $registryMatch.candidateAction `
            -RepeatThreshold $promotionRepeatThreshold `
            -Extra $extra
    } |
    Where-Object { $null -ne $_ } |
    Sort-Object @{ Expression = { $_.count }; Descending = $true }, hash |
    Select-Object -First $Top)

$nativeToolCandidates = @($sendCodePatternGroups.Values |
    Where-Object { $_.count -ge $promotionRepeatThreshold } |
    ForEach-Object {
        $classification = Get-SendCodePatternGroupClassification -Entry $_
        if ([string]$classification.classification -eq "capability_gap" -and [string]$classification.subtype -ne "unclassified_write_pattern") {
            $reasons = @("repeated_raw_safe_code_pattern")
            $registryMatch = Resolve-DynamicPromotionRegistryMatch -Reasons @("repeated_hash") -Registry $promotionRegistry
            $extra = [ordered]@{
                hash = $_.hash
                toolNames = @(Convert-CountMapToRows -Map $_.toolNames -Limit 5)
                taskNames = @(Convert-CountMapToRows -Map $_.taskNames -Limit 5)
                writePatterns = @(Convert-CountMapToRows -Map $_.writePatterns -Limit 10)
                hasManualTransaction = $_.hasManualTransaction
                maxLength = $_.maxLength
                maxLineCount = $_.maxLineCount
                classification = $classification
            }

            New-PromotionCandidate `
                -Category "native_tool_candidate" `
                -Signal "repeated_raw_safe_code_pattern" `
                -Title ("Repeated raw/safe code pattern {0}" -f $_.hash) `
                -Count $_.count `
                -Events @($_.events.ToArray()) `
                -Reasons $reasons `
                -CandidateAction $registryMatch.candidateAction `
                -RepeatThreshold $promotionRepeatThreshold `
                -Extra $extra
        }
    } |
    Sort-Object @{ Expression = { $_.count }; Descending = $true }, title |
    Select-Object -First $Top)

$promotionCandidates = @($sendCodePatternGroups.Values |
    Where-Object { $_.hasManualTransaction -eq $true -or $_.writePatterns.Count -gt 0 } |
    ForEach-Object {
        $classification = Get-SendCodePatternGroupClassification -Entry $_
        $reasons = [System.Collections.Generic.List[string]]::new()
        if ($_.hasManualTransaction -eq $true) {
            [void]$reasons.Add("manual_transaction")
        }
        if ($_.writePatterns.Count -gt 0) {
            [void]$reasons.Add("write_guard_or_write_pattern")
        }
        $registryMatch = Resolve-DynamicPromotionRegistryMatch -Reasons $reasons.ToArray() -Registry $promotionRegistry
        $extra = [ordered]@{
            hash = $_.hash
            toolNames = @(Convert-CountMapToRows -Map $_.toolNames -Limit 5)
            taskNames = @(Convert-CountMapToRows -Map $_.taskNames -Limit 5)
            writePatterns = @(Convert-CountMapToRows -Map $_.writePatterns -Limit 10)
            hasManualTransaction = $_.hasManualTransaction
            maxLength = $_.maxLength
            maxLineCount = $_.maxLineCount
            classification = $classification
        }

        New-PromotionCandidate `
            -Category "promotion_candidate" `
            -Signal "manual_transaction_write_guard" `
            -Title ("Manual transaction/write guard pattern {0}" -f $_.hash) `
            -Count $_.count `
            -Events @($_.events.ToArray()) `
            -Reasons $reasons.ToArray() `
            -CandidateAction $registryMatch.candidateAction `
            -RepeatThreshold $promotionRepeatThreshold `
            -Extra $extra
    } |
    Sort-Object @{ Expression = { $_.count }; Descending = $true }, title |
    Select-Object -First $Top)

$partialFrictionGroups = @{}
$annotationRequestGroups = @{}
$reconciliationRequestGroups = @{}
foreach ($event in $operationSampleEvents) {
    $toolName = [string](Get-EventToolName -Event $event)
    if ([string]::IsNullOrWhiteSpace($toolName)) {
        $toolName = "unknown_tool"
    }
    $eventText = Get-PromotionEventText -Event $event

    if (Test-PartialOrTimeoutFriction -Event $event) {
        $reason = Get-ScanStopReasonForPromotion -Event $event
        if ([string]::IsNullOrWhiteSpace($reason)) {
            $reason = "partial_or_timeout"
        }
        Add-PromotionSignalEvent `
            -Map $partialFrictionGroups `
            -Key ("{0}|{1}" -f $toolName, $reason) `
            -ToolName $toolName `
            -Reason $reason `
            -Event $event
    }

    $isAnnotationRequest = (
        $toolName -eq "count_annotations" -or
        ($eventText -match '(annotation|count_annotations|text note|viewport tag|tag|etiket|metin)' -and
            $eventText -match '(count|inventory|adet|sayim|sayım)')
    )
    if ($isAnnotationRequest) {
        Add-PromotionSignalEvent `
            -Map $annotationRequestGroups `
            -Key ("annotation_inventory|{0}" -f $toolName) `
            -ToolName $toolName `
            -Reason "repeated_annotation_counting_request" `
            -Event $event
    }

    $isReconciliationRequest = (
        $toolName -eq "reconcile_schedule_excel" -or
        (($eventText -match '(schedule|çizelge|cizelge|metraj)') -and
            ($eventText -match '(excel|spreadsheet|xlsx|xls|csv|workbook)'))
    )
    if ($isReconciliationRequest) {
        Add-PromotionSignalEvent `
            -Map $reconciliationRequestGroups `
            -Key ("schedule_spreadsheet_reconciliation|{0}" -f $toolName) `
            -ToolName $toolName `
            -Reason "repeated_schedule_spreadsheet_reconciliation_request" `
            -Event $event
    }
}

$hotfixCandidates = @($partialFrictionGroups.Values |
    ForEach-Object {
        New-PromotionCandidate `
            -Category "hotfix_candidate" `
            -Signal "repeated_timeout_partial_result_friction" `
            -Title ("Repeated {0} friction in {1}" -f $_.reason, $_.toolName) `
            -Count $_.count `
            -Events @($_.events.ToArray()) `
            -Reasons @("timeout_or_partial_result_friction", $_.reason) `
            -CandidateAction "review_hotfix_or_budget_tuning" `
            -RepeatThreshold $promotionRepeatThreshold `
            -Extra ([ordered]@{ toolName = $_.toolName; scanStoppedReason = $_.reason })
    } |
    Sort-Object @{ Expression = { $_.count }; Descending = $true }, title |
    Select-Object -First $Top)

$annotationInventoryCandidates = @($annotationRequestGroups.Values |
    ForEach-Object {
        New-PromotionCandidate `
            -Category "annotation_inventory_candidate" `
            -Signal "repeated_annotation_counting_request" `
            -Title ("Repeated annotation counting requests via {0}" -f $_.toolName) `
            -Count $_.count `
            -Events @($_.events.ToArray()) `
            -Reasons @($_.reason) `
            -CandidateAction "review_annotation_inventory_workflow" `
            -RepeatThreshold $promotionRepeatThreshold `
            -Extra ([ordered]@{ toolName = $_.toolName })
    } |
    Sort-Object @{ Expression = { $_.count }; Descending = $true }, title |
    Select-Object -First $Top)

$reconciliationCandidates = @($reconciliationRequestGroups.Values |
    ForEach-Object {
        New-PromotionCandidate `
            -Category "reconciliation_candidate" `
            -Signal "repeated_schedule_spreadsheet_reconciliation_request" `
            -Title ("Repeated schedule-spreadsheet reconciliation via {0}" -f $_.toolName) `
            -Count $_.count `
            -Events @($_.events.ToArray()) `
            -Reasons @($_.reason) `
            -CandidateAction "review_reconciliation_workflow" `
            -RepeatThreshold $promotionRepeatThreshold `
            -Extra ([ordered]@{ toolName = $_.toolName })
    } |
    Sort-Object @{ Expression = { $_.count }; Descending = $true }, title |
    Select-Object -First $Top)

$allPromotionTrackingCandidates = @(
    @($promotionCandidates) +
    @($nativeToolCandidates) +
    @($hotfixCandidates) +
    @($reconciliationCandidates) +
    @($annotationInventoryCandidates)
)
$summaryEvidenceStrength = Get-AggregateEvidenceStrength -Candidates $allPromotionTrackingCandidates
$summaryHumanReviewRequired = $allPromotionTrackingCandidates.Count -gt 0

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
    promotionCandidates = @($promotionCandidates)
    nativeToolCandidates = @($nativeToolCandidates)
    hotfixCandidates = @($hotfixCandidates)
    reconciliationCandidates = @($reconciliationCandidates)
    annotationInventoryCandidates = @($annotationInventoryCandidates)
    evidenceStrength = $summaryEvidenceStrength
    humanReviewRequired = $summaryHumanReviewRequired
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
        classificationCounts = @(Convert-CountMapToRows -Map $sendCodeClassificationCounts -Limit $Top)
        classificationSubtypes = @(Convert-CountMapToRows -Map $sendCodeClassificationSubtypeCounts -Limit $Top)
        unclassifiedWriteReviewBuckets = @(Convert-CountMapToRows -Map $sendCodeUnclassifiedWriteReviewBucketCounts -Limit $Top)
        classificationPolicy = [ordered]@{
            nativeToolCandidatesRequireCapabilityGap = $true
            nativeToolCandidatesExcludeUnclassifiedWritePattern = $true
            note = "Repeated send_code is human-review evidence only. Use classification before opening native-tool work."
        }
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
