<#
.SYNOPSIS
    Run the optional fast local pre-push gate.

.DESCRIPTION
    This script assumes package dependencies are already installed locally. It
    runs only fast TypeScript strict checks and the @ts-nocheck policy so local
    pushes fail early before the full CI-safe gate runs remotely.
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

$packages = @(
    [ordered]@{
        Name = "runtime-mcp-server"
        Path = "installer\runtime-mcp-server"
    },
    [ordered]@{
        Name = "revit-api-docs-mcp"
        Path = "installer\revit-api-docs-mcp"
    }
)

foreach ($package in $packages) {
    $packageRoot = Join-Path $RepoRoot $package.Path
    $tscPath = Join-Path $packageRoot "node_modules\.bin\tsc.cmd"
    if (-not (Test-Path -LiteralPath $tscPath -PathType Leaf)) {
        throw "TypeScript compiler was not found for $($package.Name). Run npm ci in $($package.Path) before using the pre-push hook."
    }

    Write-Host "== $($package.Name) forced strict ==" -ForegroundColor Cyan
    Push-Location $packageRoot
    try {
        & $tscPath `
            --noEmit `
            --strict `
            --noImplicitAny `
            --strictNullChecks `
            --useUnknownInCatchVariables `
            --pretty false
        if ($LASTEXITCODE -ne 0) {
            throw "$($package.Name) forced strict check failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

& (Join-Path $RepoRoot "scripts\test-typescript-nocheck-policy.ps1") -RepoRoot $RepoRoot

Write-Host "Pre-push TypeScript gates passed." -ForegroundColor Green
