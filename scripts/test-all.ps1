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

function Invoke-PackageCommand {
    param(
        [string]$PackageName,
        [string]$PackageRoot,
        [scriptblock]$Command
    )

    Write-Host "== $PackageName ==" -ForegroundColor Cyan
    Push-Location $PackageRoot
    try {
        & $Command
        if ($LASTEXITCODE -ne 0) {
            throw "$PackageName command failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

foreach ($package in $packages) {
    $packageRoot = Join-Path $RepoRoot $package.Path
    Invoke-PackageCommand -PackageName "$($package.Name) dependencies" -PackageRoot $packageRoot -Command {
        npm ci
    }
}

& (Join-Path $RepoRoot "scripts\test-installer-smoke.ps1") -RepoRoot $RepoRoot
& (Join-Path $RepoRoot "scripts\test-usage-intelligence.ps1") -RepoRoot $RepoRoot
& (Join-Path $RepoRoot "scripts\test-live-dashboard.ps1") -RepoRoot $RepoRoot
& (Join-Path $RepoRoot "scripts\test-typescript-nocheck-policy.ps1") -RepoRoot $RepoRoot

foreach ($package in $packages) {
    $packageRoot = Join-Path $RepoRoot $package.Path
    Invoke-PackageCommand -PackageName "$($package.Name) npm test" -PackageRoot $packageRoot -Command {
        npm run test
    }
}

& (Join-Path $RepoRoot "scripts\test-mcp-build-payload-freshness.ps1") -RepoRoot $RepoRoot

Write-Host "All local non-Revit tests passed." -ForegroundColor Green
