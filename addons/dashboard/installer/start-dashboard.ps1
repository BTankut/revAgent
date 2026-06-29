<#
.SYNOPSIS
    Start the installed revAgent dashboard add-on server.
#>

[CmdletBinding()]
param(
    [string]$AddonRoot = "",
    [string]$ConfigPath = "",
    [string]$ReportsRoot = "",
    [string]$ReleaseRoot = "",
    [string]$HostName = "",
    [int]$Port = 0,
    [int]$StaleSeconds = 0,
    [int]$OfflineSeconds = 0
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

    foreach ($name in @("node.exe", "node")) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    throw "Node.js was not found. Install Node.js before starting the revAgent dashboard add-on."
}

if ([string]::IsNullOrWhiteSpace($AddonRoot)) {
    $AddonRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$AddonRoot = [System.IO.Path]::GetFullPath($AddonRoot)

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $AddonRoot "config\dashboard.json"
}

$config = $null
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigPath | ConvertFrom-Json
}

if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
    $ReportsRoot = if ($config -and $config.reportsRoot) { [string]$config.reportsRoot } else { "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports" }
}
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = if ($config -and $config.releaseRoot) { [string]$config.releaseRoot } else { Split-Path -Parent $ReportsRoot }
}
if ([string]::IsNullOrWhiteSpace($HostName)) {
    $HostName = if ($config -and $config.hostName) { [string]$config.hostName } else { "127.0.0.1" }
}
if ($Port -le 0) {
    $Port = if ($config -and $config.port) { [int]$config.port } else { 8765 }
}
if ($StaleSeconds -le 0) {
    $StaleSeconds = if ($config -and $config.staleSeconds) { [int]$config.staleSeconds } else { 60 }
}
if ($OfflineSeconds -le 0) {
    $OfflineSeconds = if ($config -and $config.offlineSeconds) { [int]$config.offlineSeconds } else { 300 }
}

$serverPath = Join-Path $AddonRoot "server\server.mjs"
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
    "--staleSeconds", ([string]$StaleSeconds),
    "--offlineSeconds", ([string]$OfflineSeconds)
)

& $nodePath @arguments
