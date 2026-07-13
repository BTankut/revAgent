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

    $writePatternValues = @(ConvertTo-StringArray $WritePatterns)
    $writePatternCount = $writePatternValues.Count
    $writePatternText = ($writePatternValues -join " ")
    $text = (@($ToolName, $TaskName, $Preview, $writePatternText, $ErrorMessage) |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) -join " "
    $lower = $text.ToLowerInvariant()

    if ($lower -match 'rejected write-looking code') {
        return New-SendCodeClassification -Classification "tool_tuning_gap" -Subtype "safe_guard_false_positive_review" -Confidence "medium" -Reasons @("safe_guard_rejected_read_intent") -CoveredToolCandidates @("send_code_to_revit_safe", "inspect_schedules", "inspect_sheet_text") -SuggestedAction "Review the safe-code guard and route read-only extraction through bounded native readers before considering a new tool."
    }
    if ($lower -match 'document\.save|modeli kaydet|kaydet|save model|son kayit|son kayit') {
        return New-SendCodeClassification -Classification "policy_gap" -Subtype "model_save_policy" -Confidence "high" -Reasons @("document_save_pattern") -CoveredToolCandidates @() -SuggestedAction "Decide product policy for explicit model save before adding or recommending a native save tool."
    }
    if ($lower -match 'printmanager|print color|color depth|blackline|black line|test pdf|export active sheet test pdf|pdf') {
        return New-SendCodeClassification -Classification "policy_gap" -Subtype "pdf_print_settings_policy" -Confidence "medium" -Reasons @("pdf_or_print_setting_pattern") -CoveredToolCandidates @("export_revit_view_image") -SuggestedAction "Treat PDF and print-setting changes as a policy/design question; image export coverage alone is not enough."
    }
    if ($lower -match 'image type|reload placed|replace .*image|isometry|source view export|high resolution|white background|zoom out by view axes|view display style|views colored|make fcu views colored') {
        return New-SendCodeClassification -Classification "capability_gap" -Subtype "view_image_asset_workflow" -Confidence "medium" -Reasons @("view_or_image_asset_workflow") -CoveredToolCandidates @("export_revit_view_image", "activate_view") -SuggestedAction "Watch for repetition before designing a guarded view/image asset workflow."
    }
    if ($lower -match 'schedule table edit|setcellstyle|setmergedcell|insertrow|removerow|insertcolumn|removecolumn|border|borders|cerceve|cizgi|çizgi|grid|merged|merge|birles|birleştir|row height|font|text color|renk|style|width|genislik|genişlik|resize|fit sheet|create and place|recreate|manual schedule|visible schedule sections|split crsl|match uu02 block') {
        return New-SendCodeClassification -Classification "capability_gap" -Subtype "schedule_visual_structure" -Confidence "high" -Reasons @("schedule_visual_or_structure_pattern") -CoveredToolCandidates @("inspect_schedules", "set_schedule_cells") -SuggestedAction "Consider one guarded schedule-formatting design spike instead of one tool per table request."
    }

    $hasScheduleTextWrite = @($writePatternValues | Where-Object { $_ -eq "Schedule.SetCellText" }).Count -gt 0
    $hasParameterWrite = @($writePatternValues | Where-Object { $_ -eq "Parameter.Set" -or $_ -eq "Parameter.SetValueString" }).Count -gt 0
    $hasDestructiveWrite = @($writePatternValues | Where-Object { $_ -eq "Document.Delete" }).Count -gt 0 -or $lower -match 'document\s*\.\s*delete\s*\('
    if ($hasDestructiveWrite) {
        return New-SendCodeClassification -Classification "capability_gap" -Subtype "destructive_write_pattern" -Confidence "medium" -Reasons @("destructive_write_requires_human_review") -CoveredToolCandidates @() -SuggestedAction "Inspect the exact requested model mutation before deciding whether this is a real native capability, a policy gap, or an unsafe escape hatch."
    }
    if (($hasScheduleTextWrite -and $hasParameterWrite) -or $lower -match 'mixed renumber|header cells and body parameters|body parameters|body numbering') {
        return New-SendCodeClassification -Classification "capability_gap" -Subtype "mixed_schedule_parameter_workflow" -Confidence "medium" -Reasons @("mixed_schedule_cell_and_parameter_write") -CoveredToolCandidates @("set_schedule_cells", "set_element_parameter") -SuggestedAction "Review whether separate existing writes are enough or a guarded batch workflow is justified."
    }
    if ($HasManualTransaction -and ($hasScheduleTextWrite -or $hasParameterWrite)) {
        $coveredTools = @()
        if ($hasScheduleTextWrite) {
            $coveredTools += @("set_schedule_cells", "set_schedule_cells_by_text")
        }
        if ($hasParameterWrite) {
            $coveredTools += @("set_element_parameter")
        }
        return New-SendCodeClassification -Classification "routing_miss" -Subtype "manual_transaction_existing_write_tool_available" -Confidence "medium" -Reasons @("manual_transaction_with_existing_write_tool") -CoveredToolCandidates $coveredTools -SuggestedAction "Prefer the existing guarded write tools; inspect whether missing preflight, dry-run, or argument ergonomics pushed Codex into raw code."
    }
    if ($hasScheduleTextWrite) {
        return New-SendCodeClassification -Classification "routing_miss" -Subtype "schedule_cell_write_tool_available" -Confidence "medium" -Reasons @("schedule_cell_text_write_pattern") -CoveredToolCandidates @("set_schedule_cells", "set_schedule_cells_by_text") -SuggestedAction "Prefer existing schedule-cell write tools unless the task also needs unsupported formatting or batching."
    }
    if ($hasParameterWrite) {
        return New-SendCodeClassification -Classification "routing_miss" -Subtype "element_parameter_tool_available" -Confidence "medium" -Reasons @("parameter_write_pattern") -CoveredToolCandidates @("set_element_parameter") -SuggestedAction "Prefer set_element_parameter after inspect_parameter_schema preflight."
    }

    if (-not $HasManualTransaction -and $writePatternCount -eq 0) {
        if ($lower -match 'to tsv|export .*rows|export current|export placed|readable excel report|final qa tsv|schedule cells to') {
            return New-SendCodeClassification -Classification "tool_tuning_gap" -Subtype "export_friendly_read_output" -Confidence "medium" -Reasons @("read_only_export_or_report_shape") -CoveredToolCandidates @("inspect_schedules", "inspect_sheet_text", "reconcile_schedule_excel") -SuggestedAction "Improve read-tool output ergonomics or provide a standard local report adapter before adding a Revit tool."
        }
        if ($lower -match 'textnote|text note|sheet text|titleblock|title block|drawing list|sheet note|visible spl labels') {
            return New-SendCodeClassification -Classification "routing_miss" -Subtype "sheet_text_lookup_tool_available" -Confidence "medium" -Reasons @("sheet_or_textnote_read_pattern") -CoveredToolCandidates @("inspect_sheet_text") -SuggestedAction "Route sheet text, titleblock, and text note lookup through inspect_sheet_text first."
        }
        if ($lower -match 'schedule rows|schedule cells|header rows|placed schedules|inspect .*schedule|verify .*schedule|recheck .*schedule') {
            return New-SendCodeClassification -Classification "routing_miss" -Subtype "schedule_inspection_tool_available" -Confidence "medium" -Reasons @("schedule_read_pattern") -CoveredToolCandidates @("inspect_schedules") -SuggestedAction "Route schedule discovery and bounded cell reading through inspect_schedules first."
        }
        if ($lower -match 'count .*annotation|count .*convector|count .*fcu|nearest annotation|annotation texts') {
            return New-SendCodeClassification -Classification "routing_miss" -Subtype "annotation_or_element_count_tool_available" -Confidence "low" -Reasons @("count_or_annotation_read_pattern") -CoveredToolCandidates @("count_annotations", "find_elements") -SuggestedAction "Try count_annotations or find_elements with bounded scope before custom read-only code."
        }
    }

    if ($HasManualTransaction -or $writePatternCount -gt 0) {
        $triage = Get-SendCodeWriteReviewTriage -Preview $Preview -WritePatterns $writePatternValues -HasManualTransaction $HasManualTransaction
        return New-SendCodeClassification -Classification "capability_gap" -Subtype "unclassified_write_pattern" -Confidence "low" -Reasons @("write_pattern_requires_human_review") -CoveredToolCandidates @() -SuggestedAction "Manual triage required; use reviewBucket before deciding whether this is routing, tuning, acceptable escape hatch, or a real native capability gap." -ReviewBucket ([string]$triage.reviewBucket) -ReviewSignals @($triage.reviewSignals) -RequiresManualTriage $true
    }

    return New-SendCodeClassification -Classification "accepted_escape_hatch" -Subtype "custom_low_signal_dynamic_code" -Confidence "low" -Reasons @("insufficient_repetition_or_no_obvious_tool") -CoveredToolCandidates @() -SuggestedAction "Keep as an audited escape hatch unless the pattern repeats with clear production value."
}

function Get-SendCodeEventClassification {
    param([object]$Event)

    $code = Get-NestedReportValue -Object $Event -Path @("params", "code")
    $operation = Get-EventOperation -Event $Event
    return Get-SendCodeDiagnosticClassification `
        -ToolName ([string](Get-EventToolName -Event $Event)) `
        -TaskName ([string](Get-ReportValue -Object $Event -Name "taskName")) `
        -Preview ([string](Get-ReportValue -Object $code -Name "preview")) `
        -WritePatterns (Get-CodeWritePatterns -Code $code) `
        -HasManualTransaction ((Get-BooleanOrNull (Get-ReportValue -Object $code -Name "hasManualTransaction")) -eq $true) `
        -ErrorMessage ([string](Get-ReportValue -Object $operation -Name "errorMessage"))
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
    $lines.Add("# revAgent Session Correlation Evidence")
    $lines.Add("")
    $lines.Add("This deterministic file is LLM evidence, not the final product report.")
    $lines.Add("")
    $lines.Add("- Date UTC: $($Report.dateUtc)")
    $lines.Add("- Generated UTC: $($Report.generatedAtUtc)")
    $lines.Add("- Codex context files: $($Report.source.codexContextFileCount)")
    $lines.Add("- revAgent event files: $($Report.source.revAgentEventFileCount)")
    $lines.Add("- Correlations: $($Report.summary.correlationCount)")
    $lines.Add("- Correlations with revAgent events: $($Report.summary.correlationsWithRevAgentEvents)")
    $lines.Add("- Review signals: $($Report.summary.productSignalCount)")
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
                    $lines.Add("- Review signal: $($signal.signal) | $($signal.suggestedAction)")
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
    $MarkdownOutputPath = Join-Path (Join-Path $ReportsRoot "summaries\daily") ("{0}.session-correlation-evidence.md" -f $date.ToString("yyyy-MM-dd"))
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
    $sendCodeClassificationMap = @{}
    $sendCodeClassificationSubtypeMap = @{}
    $sendCodeUnclassifiedWriteReviewBucketMap = @{}
    foreach ($event in $matchedEvents) {
        $eventType = [string](Get-ReportValue -Object $event -Name "eventType")
        $toolName = Get-EventToolName -Event $event
        Add-Count -Map $revAgentToolMap -Key $toolName
        Add-Count -Map $projectMap -Key (Get-EventProject -Event $event)
        if ($eventType -eq "mcp.tool" -and ($toolName -eq "send_code_to_revit" -or $toolName -eq "send_code_to_revit_safe")) {
            $sendCodeCount++
            $classification = Get-SendCodeEventClassification -Event $event
            Add-Count -Map $sendCodeClassificationMap -Key ([string]$classification.classification)
            Add-Count -Map $sendCodeClassificationSubtypeMap -Key ([string]$classification.subtype)
            if ([string]$classification.subtype -eq "unclassified_write_pattern") {
                Add-Count -Map $sendCodeUnclassifiedWriteReviewBucketMap -Key ([string]$classification.reviewBucket)
            }
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
                suggestedAction = "classify as routing_miss, tool_tuning_gap, capability_gap, accepted_escape_hatch, or policy_gap before opening native-tool work"
                classificationCounts = @(Convert-CountMapToRows -Map $sendCodeClassificationMap -Limit 10)
                classificationSubtypes = @(Convert-CountMapToRows -Map $sendCodeClassificationSubtypeMap -Limit 10)
                unclassifiedWriteReviewBuckets = @(Convert-CountMapToRows -Map $sendCodeUnclassifiedWriteReviewBucketMap -Limit 10)
            })
    }

    $workspaceMatch = Get-WorkspaceMatch -Context $context -Events $matchedEvents
    $correlation = [ordered]@{
        codexSessionId = Get-ReportValue -Object $context -Name "codexSessionId"
        threadId = Get-ReportValue -Object $context -Name "threadId"
        threadTitle = Get-ReportValue -Object $context -Name "threadTitle"
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
        sendCode = [ordered]@{
            count = $sendCodeCount
            classificationCounts = @(Convert-CountMapToRows -Map $sendCodeClassificationMap -Limit 10)
            classificationSubtypes = @(Convert-CountMapToRows -Map $sendCodeClassificationSubtypeMap -Limit 10)
            unclassifiedWriteReviewBuckets = @(Convert-CountMapToRows -Map $sendCodeUnclassifiedWriteReviewBucketMap -Limit 10)
            countingNote = "Session correlation windows can overlap. Use daily summaries for factual send_code totals; use session counts only as intent-linked evidence."
        }
        friction = @($friction.ToArray())
        reviewSignals = @($productSignals.ToArray())
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
                classificationCounts = @(Get-ReportValue -Object $signal -Name "classificationCounts")
                classificationSubtypes = @(Get-ReportValue -Object $signal -Name "classificationSubtypes")
                unclassifiedWriteReviewBuckets = @(Get-ReportValue -Object $signal -Name "unclassifiedWriteReviewBuckets")
            })
    }

    [void]$correlations.Add($correlation)
}

$correlationsWithEvents = @($correlations.ToArray() | Where-Object { $_.revAgent.operationCount -gt 0 }).Count
$correlatedDynamicCodeCount = 0
foreach ($item in @($correlations.ToArray())) {
    $correlatedDynamicCodeCount += [int](Get-NestedReportValue -Object $item -Path @("outcome", "dynamicCodeCount"))
}
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
        reviewSignalCount = $allProductSignals.Count
        productSignalCount = $allProductSignals.Count
        timeWindowMinutes = $windowMinutes
        correlatedDynamicCodeCount = $correlatedDynamicCodeCount
        countingPolicy = [ordered]@{
            dailySummariesAreFactualCounts = $true
            sessionWindowsMayOverlap = $true
            note = "Do not sum session correlation operation or dynamic-code counts as daily totals; use them as intent-linked evidence."
        }
    }
    correlations = @($correlations.ToArray())
    reviewSignals = @($allProductSignals.ToArray())
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
