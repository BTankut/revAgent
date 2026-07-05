<#
.SYNOPSIS
    Publish bounded Codex session context for revAgent usage correlation.

.DESCRIPTION
    Runs the bounded Codex session exporter for one or more UTC dates. This is
    the script used by the workstation-side scheduled task; it does not export
    full raw chat transcripts.
#>

[CmdletBinding()]
param(
    [string]$SessionRoot = "",
    [string]$SessionIndexFile = "",
    [string[]]$SessionFile = @(),
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports",
    [string[]]$DateUtc = @((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")),
    [string]$StartDateUtc = "2026-06-29",
    [switch]$IncludeYesterday,
    [int]$LookbackDays = 0,
    [string]$OutputRoot = "",
    [string]$ReportPath = "",
    [string]$MachineName = $env:COMPUTERNAME,
    [string]$UserName = $env:USERNAME,
    [int]$MaxTextChars = 600,
    [int]$MaxUserRequests = 12,
    [int]$MaxAssistantOutcomes = 8,
    [int]$MaxToolCalls = 80
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

$exportScript = Join-Path $PSScriptRoot "export-codex-session-context.ps1"
if (-not (Test-Path -LiteralPath $exportScript -PathType Leaf)) {
    throw "Codex session exporter was not found: $exportScript"
}

$dateList = [System.Collections.Generic.List[string]]::new()
$dateSelectionMode = "explicit_dates"
$dateUtcWasExplicit = $PSBoundParameters.ContainsKey("DateUtc")
$todayUtc = (Get-Date).ToUniversalTime().Date
if (-not $dateUtcWasExplicit -and -not [string]::IsNullOrWhiteSpace($StartDateUtc)) {
    $dateSelectionMode = "start_date_to_today"
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
if ($LookbackDays -gt 0) {
    for ($offset = 1; $offset -le $LookbackDays; $offset++) {
        Add-UtcDateString -List $dateList -Value (Get-Date).ToUniversalTime().AddDays(-1 * $offset).ToString("yyyy-MM-dd")
    }
}
$dates = @($dateList.ToArray() | Sort-Object -Unique)
if ($dates.Count -eq 0) {
    throw "No Codex session export dates were requested."
}

$published = [System.Collections.Generic.List[object]]::new()
foreach ($dateValue in $dates) {
    $parameters = @{
        ReportsRoot = $ReportsRoot
        DateUtc = $dateValue
        MachineName = $MachineName
        UserName = $UserName
        MaxTextChars = $MaxTextChars
        MaxUserRequests = $MaxUserRequests
        MaxAssistantOutcomes = $MaxAssistantOutcomes
        MaxToolCalls = $MaxToolCalls
    }
    if (-not [string]::IsNullOrWhiteSpace($SessionRoot)) {
        $parameters.SessionRoot = $SessionRoot
    }
    if (-not [string]::IsNullOrWhiteSpace($SessionIndexFile)) {
        $parameters.SessionIndexFile = $SessionIndexFile
    }
    if ($SessionFile.Count -gt 0) {
        $parameters.SessionFile = $SessionFile
    }
    if (-not [string]::IsNullOrWhiteSpace($OutputRoot)) {
        $parameters.OutputRoot = $OutputRoot
    }

    $exportOutput = & $exportScript @parameters
    $exportReport = $exportOutput | ConvertFrom-Json
    [void]$published.Add($exportReport)
}

$totalSessionFiles = 0
$totalContexts = 0
foreach ($item in $published) {
    $totalSessionFiles += [int]$item.sessionFileCount
    $totalContexts += [int]$item.contextCount
}

$report = [ordered]@{
    schemaVersion = "revagent.codex.session.publish.v1"
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    reportsRoot = $ReportsRoot
    outputRoot = if ([string]::IsNullOrWhiteSpace($OutputRoot)) { (Join-Path $ReportsRoot "codex-sessions") } else { $OutputRoot }
    machineName = $MachineName
    userName = $UserName
    sessionRoot = $SessionRoot
    sessionIndexFile = $SessionIndexFile
    dateSelection = [ordered]@{
        mode = $dateSelectionMode
        startDateUtc = $StartDateUtc
        includeYesterday = [bool]$IncludeYesterday
        lookbackDays = $LookbackDays
        datesUtc = @($dates)
    }
    dateCount = $dates.Count
    sessionFileCount = $totalSessionFiles
    contextCount = $totalContexts
    published = @($published.ToArray())
}

if (-not [string]::IsNullOrWhiteSpace($ReportPath)) {
    $reportDir = Split-Path -Parent $ReportPath
    if (-not [string]::IsNullOrWhiteSpace($reportDir)) {
        New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
    }
    $report | ConvertTo-Json -Depth 24 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
}

$report | ConvertTo-Json -Depth 24
