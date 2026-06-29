<#
.SYNOPSIS
    Start the read-only revAgent live dashboard.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports",
    [string]$ReleaseRoot = "",
    [string]$HostName = "127.0.0.1",
    [int]$Port = 8765,
    [int]$StaleSeconds = 60,
    [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"

function Resolve-NodeExe {
    $candidates = @(
        (Join-Path ${env:ProgramFiles} "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
    )

    foreach ($candidate in $candidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return $candidate
        }
    }

    $command = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $command = Get-Command "node" -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    throw "Node.js was not found. Run the revAgent installer/update first, then start the dashboard again."
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Split-Path -Parent $ReportsRoot
}

$serverPath = Join-Path $RepoRoot "addons\dashboard\server\server.mjs"
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    throw "Dashboard server was not found: $serverPath"
}

$nodePath = Resolve-NodeExe
$arguments = @(
    $serverPath,
    "--reportsRoot", $ReportsRoot,
    "--releaseRoot", $ReleaseRoot,
    "--host", $HostName,
    "--port", ([string]$Port),
    "--staleSeconds", ([string]$StaleSeconds)
)

$url = "http://$HostName`:$Port"
Write-Host "Starting revAgent live dashboard: $url" -ForegroundColor Cyan
Write-Host "Reports root: $ReportsRoot" -ForegroundColor DarkGray

if ($OpenBrowser) {
    Start-Process $url | Out-Null
}

& $nodePath @arguments
