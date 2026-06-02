<#
.SYNOPSIS
    Run CI-safe revAgent engineering gates.

.DESCRIPTION
    This script intentionally avoids Revit, NAS shares, ProgramData installs,
    admin-only writes, and live dashboard checks. It runs only deterministic
    package and policy gates that can execute on a GitHub Actions runner.
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
    Invoke-PackageCommand -PackageName $package.Name -PackageRoot $packageRoot -Command {
        npm ci
    }
}

foreach ($package in $packages) {
    $packageRoot = Join-Path $RepoRoot $package.Path
    Invoke-PackageCommand -PackageName "$($package.Name) forced strict" -PackageRoot $packageRoot -Command {
        & ".\node_modules\.bin\tsc.cmd" `
            --noEmit `
            --strict `
            --noImplicitAny `
            --strictNullChecks `
            --useUnknownInCatchVariables `
            --pretty false
    }
}

& (Join-Path $RepoRoot "scripts\test-typescript-nocheck-policy.ps1") -RepoRoot $RepoRoot
& (Join-Path $RepoRoot "scripts\test-mcp-build-payload-freshness.ps1") -RepoRoot $RepoRoot -McpOnly

foreach ($package in $packages) {
    $packageRoot = Join-Path $RepoRoot $package.Path
    Invoke-PackageCommand -PackageName "$($package.Name) npm test" -PackageRoot $packageRoot -Command {
        npm run test
    }
}

Write-Host "All CI-safe revAgent engineering gates passed." -ForegroundColor Green
