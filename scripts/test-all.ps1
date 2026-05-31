<#
.SYNOPSIS
    Run local build and smoke checks that do not require admin rights or Revit.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

& (Join-Path $RepoRoot "scripts\test-installer-smoke.ps1") -RepoRoot $RepoRoot
& (Join-Path $RepoRoot "scripts\test-usage-intelligence.ps1") -RepoRoot $RepoRoot
& (Join-Path $RepoRoot "scripts\test-live-dashboard.ps1") -RepoRoot $RepoRoot

Push-Location (Join-Path $RepoRoot "installer\runtime-mcp-server")
try {
    npm run test
}
finally {
    Pop-Location
}

Push-Location (Join-Path $RepoRoot "installer\revit-api-docs-mcp")
try {
    npm run test
}
finally {
    Pop-Location
}

Write-Host "All local non-Revit tests passed." -ForegroundColor Green
