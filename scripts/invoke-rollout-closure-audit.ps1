<#
.SYNOPSIS
    Run the read-only rollout closure audit and persist a timestamped snapshot.

.DESCRIPTION
    This is a read-only wrapper around check-rollout-readiness.ps1. It does not
    update workstations, run migration, connect over SSH, publish stable, or
    write to NAS unless the chosen output path is on NAS. It is intended for the
    final source-free office rollout closure step where the operator needs a
    durable JSON evidence snapshot.
#>

[CmdletBinding()]
param(
    [string]$ConfigPath = "",

    [string]$OutputRoot = "",

    [string]$OutputPath = "",

    [string]$ReleaseRoot = "",

    [string]$ReportsRoot = "",

    [string]$ExpectedMachines = "",

    [string]$OutOfScopeMachines = "",

    [datetime]$NowUtc = [datetime]::MinValue,

    [switch]$OutputJson,

    [switch]$FailOnActionRequired
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$auditScript = Join-Path $repoRoot "scripts\check-rollout-readiness.ps1"

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    if (-not [string]::IsNullOrWhiteSpace($env:REVAGENT_ROLLOUT_READINESS_CONFIG)) {
        $ConfigPath = $env:REVAGENT_ROLLOUT_READINESS_CONFIG
    }
    else {
        $ConfigPath = "C:\ProgramData\DPE\revAgentOps\rollout-readiness.json"
    }
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    if (-not [string]::IsNullOrWhiteSpace($env:REVAGENT_ROLLOUT_AUDIT_OUTPUT_ROOT)) {
        $OutputRoot = $env:REVAGENT_ROLLOUT_AUDIT_OUTPUT_ROOT
    }
    else {
        $OutputRoot = "C:\ProgramData\DPE\revAgentOps\readiness"
    }
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Rollout readiness config file was not found: $ConfigPath"
}

$runUtc = if ($NowUtc -eq [datetime]::MinValue) { (Get-Date).ToUniversalTime() } else { $NowUtc.ToUniversalTime() }
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $stamp = $runUtc.ToString("yyyyMMdd-HHmmss")
    $OutputPath = Join-Path $OutputRoot ("rollout-readiness-{0}.json" -f $stamp)
}

$auditArgs = @{
    ConfigPath = $ConfigPath
    OutputPath = $OutputPath
    OutputJson = $true
}
if (-not [string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $auditArgs.ReleaseRoot = $ReleaseRoot
}
if (-not [string]::IsNullOrWhiteSpace($ReportsRoot)) {
    $auditArgs.ReportsRoot = $ReportsRoot
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedMachines)) {
    $auditArgs.ExpectedMachines = $ExpectedMachines
}
if (-not [string]::IsNullOrWhiteSpace($OutOfScopeMachines)) {
    $auditArgs.OutOfScopeMachines = $OutOfScopeMachines
}
if ($NowUtc -ne [datetime]::MinValue) {
    $auditArgs.NowUtc = $runUtc
}

$jsonText = & $auditScript @auditArgs
$result = $jsonText | ConvertFrom-Json

if ($OutputJson) {
    $jsonText
}
else {
    Write-Host ("Rollout readiness snapshot: {0}" -f $OutputPath)
    Write-Host ("Stable: {0}" -f $result.summary.stable.version)
    Write-Host ("Ready: {0}; action required: {1}" -f $result.summary.ready, $result.summary.actionRequiredCount)
    Write-Host ("Live smoke: {0}" -f $result.summary.liveSmoke.state)
    if ([int]$result.summary.actionRequiredCount -gt 0) {
        $result.actions | Format-Table -AutoSize
    }
}

if ($FailOnActionRequired -and -not [bool]$result.summary.ready) {
    exit 2
}
