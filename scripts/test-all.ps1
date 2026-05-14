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

function Invoke-NpmTest {
    param(
        [string]$Path,
        [string]$Label
    )

    Push-Location $Path
    try {
        npm run test
        if ($LASTEXITCODE -ne 0) {
            throw "$Label failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

& (Join-Path $RepoRoot "scripts\test-installer-smoke.ps1") -RepoRoot $RepoRoot
& (Join-Path $RepoRoot "scripts\test-connector-graph.ps1") -RepoRoot $RepoRoot

Invoke-NpmTest -Path (Join-Path $RepoRoot "installer\runtime-mcp-server") -Label "Runtime MCP server tests"
Invoke-NpmTest -Path (Join-Path $RepoRoot "installer\revit-api-docs-mcp") -Label "Revit API docs MCP tests"

Write-Host "All local non-Revit tests passed." -ForegroundColor Green
