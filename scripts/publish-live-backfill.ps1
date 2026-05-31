<#
.SYNOPSIS
    Backfill local revAgent live dashboard files to the NAS reports root.
#>

[CmdletBinding()]
param(
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports",
    [string]$LocalLiveRoot = "C:\ProgramData\DPE\RevitMCP\state\telemetry\live",
    [string]$MachineName = $env:COMPUTERNAME,
    [ValidateRange(1, 30)]
    [int]$Days = 2,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Get-UtcTimeValue {
    param($Value)
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return $null
    }
    try {
        return [DateTimeOffset]::Parse([string]$Value).UtcDateTime
    }
    catch {
        return $null
    }
}

function Merge-NdjsonFile {
    param(
        [string]$SourcePath,
        [string]$TargetPath
    )

    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        return [ordered]@{ source = $SourcePath; target = $TargetPath; added = 0; total = 0 }
    }

    $targetDir = Split-Path -Parent $TargetPath
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

    $existing = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $targetLines = @()
    if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
        $targetLines = @(Get-Content -LiteralPath $TargetPath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        foreach ($line in $targetLines) {
            [void]$existing.Add($line)
        }
    }

    $additions = [System.Collections.Generic.List[string]]::new()
    $sourceLines = @(Get-Content -LiteralPath $SourcePath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($line in $sourceLines) {
        if ($existing.Add($line)) {
            [void]$additions.Add($line)
        }
    }

    if ($additions.Count -gt 0) {
        Add-Content -LiteralPath $TargetPath -Value $additions -Encoding UTF8
    }

    return [ordered]@{
        source = $SourcePath
        target = $TargetPath
        added = $additions.Count
        total = $targetLines.Count + $additions.Count
    }
}

$normalizedMachineName = ([string]$MachineName).Trim().ToUpperInvariant()
if ([string]::IsNullOrWhiteSpace($normalizedMachineName)) {
    throw "MachineName cannot be empty."
}

$sourceMachineRoot = Join-Path $LocalLiveRoot "machines\$normalizedMachineName"
$targetMachineRoot = Join-Path $ReportsRoot "live\machines\$normalizedMachineName"
$activityResults = @()
$statusCopied = $false
$statusReason = "missing"

if (Test-Path -LiteralPath $sourceMachineRoot -PathType Container) {
    New-Item -ItemType Directory -Path $targetMachineRoot -Force | Out-Null

    $sourceStatusPath = Join-Path $sourceMachineRoot "status.json"
    $targetStatusPath = Join-Path $targetMachineRoot "status.json"
    $sourceStatus = Read-JsonFile -Path $sourceStatusPath
    $targetStatus = Read-JsonFile -Path $targetStatusPath
    if ($sourceStatus) {
        $sourceHeartbeat = Get-UtcTimeValue -Value $sourceStatus.lastHeartbeatUtc
        $targetHeartbeat = Get-UtcTimeValue -Value $targetStatus.lastHeartbeatUtc
        if ($Force -or $null -eq $targetHeartbeat -or ($sourceHeartbeat -and $sourceHeartbeat -gt $targetHeartbeat)) {
            Copy-Item -LiteralPath $sourceStatusPath -Destination $targetStatusPath -Force
            $statusCopied = $true
            $statusReason = "copied"
        }
        else {
            $statusReason = "target-newer-or-equal"
        }
    }

    for ($offset = 0; $offset -lt $Days; $offset++) {
        $date = (Get-Date).ToUniversalTime().Date.AddDays(-$offset).ToString("yyyy-MM-dd")
        $sourceActivityPath = Join-Path $sourceMachineRoot "activity\$date.ndjson"
        $targetActivityPath = Join-Path $targetMachineRoot "activity\$date.ndjson"
        $activityResults += Merge-NdjsonFile -SourcePath $sourceActivityPath -TargetPath $targetActivityPath
    }
}

$result = [ordered]@{
    schemaVersion = "revagent.live.backfill.v1"
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    machineName = $normalizedMachineName
    sourceMachineRoot = $sourceMachineRoot
    targetMachineRoot = $targetMachineRoot
    sourceExists = (Test-Path -LiteralPath $sourceMachineRoot -PathType Container)
    statusCopied = $statusCopied
    statusReason = $statusReason
    activity = $activityResults
}

$result | ConvertTo-Json -Depth 8
