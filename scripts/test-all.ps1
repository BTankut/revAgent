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

Push-Location (Join-Path $RepoRoot "installer\runtime-mcp-server")
try {
    npm run test
    if ($LASTEXITCODE -ne 0) {
        throw "Runtime MCP tests failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Push-Location (Join-Path $RepoRoot "installer\revit-api-docs-mcp")
try {
    npm run test
    if ($LASTEXITCODE -ne 0) {
        throw "Revit API docs MCP tests failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Host "All local non-Revit tests passed." -ForegroundColor Green
