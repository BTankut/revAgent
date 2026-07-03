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
    [string[]]$SessionFile = @(),
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports",
    [string[]]$DateUtc = @((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")),
    [switch]$IncludeYesterday,
    [int]$LookbackDays = 2,
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

$exportScript = Join-Path $PSScriptRoot "export-codex-session-context.ps1"
if (-not (Test-Path -LiteralPath $exportScript -PathType Leaf)) {
    throw "Codex session exporter was not found: $exportScript"
}

$dateList = [System.Collections.Generic.List[string]]::new()
foreach ($dateValue in $DateUtc) {
    $dateList.Add((ConvertTo-UtcDateString -Value $dateValue))
}
if ($IncludeYesterday) {
    $dateList.Add((Get-Date).ToUniversalTime().AddDays(-1).ToString("yyyy-MM-dd"))
}
if ($LookbackDays -gt 0) {
    $boundedLookbackDays = [Math]::Min(14, $LookbackDays)
    for ($offset = 1; $offset -le $boundedLookbackDays; $offset++) {
        $dateList.Add((Get-Date).ToUniversalTime().AddDays(-1 * $offset).ToString("yyyy-MM-dd"))
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
