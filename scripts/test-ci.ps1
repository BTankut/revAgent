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
Import-Module (Join-Path $RepoRoot "scripts\McpPackageTestHelpers.psm1") -Force

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

$packageCopies = @()
try {
    foreach ($package in $packages) {
        $sourceRoot = Join-Path $RepoRoot $package.Path
        $workCopy = New-McpPackageWorkCopy -PackageRoot $sourceRoot -PackageRelativePath $package.Path
        $packageCopies += [pscustomobject]@{
            Name = [string]$package.Name
            Path = [string]$package.Path
            WorkCopy = $workCopy
        }

        Invoke-McpPackageNpmCi -PackageName $package.Name -PackageRoot $workCopy.PackageRoot -PackageRelativePath $package.Path
    }

    foreach ($package in $packageCopies) {
        $tscPath = Get-McpPackageTscPath -PackageRoot $package.WorkCopy.PackageRoot -PackageRelativePath $package.Path
        Invoke-McpPackageCommand -PackageName "$($package.Name) forced strict" -PackageRoot $package.WorkCopy.PackageRoot -RepoRoot $RepoRoot -Command {
            & $tscPath `
                --noEmit `
                --strict `
                --noImplicitAny `
                --strictNullChecks `
                --useUnknownInCatchVariables `
                --pretty false
        }
    }

    & (Join-Path $RepoRoot "scripts\test-distribution-integrity.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-license-seat.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-source-free-migration.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-typescript-nocheck-policy.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-mcp-build-payload-freshness.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-publish-signing.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-signed-stable-readiness.ps1") -RepoRoot $RepoRoot

    foreach ($package in $packageCopies) {
        Invoke-McpPackageCommand -PackageName "$($package.Name) npm test" -PackageRoot $package.WorkCopy.PackageRoot -RepoRoot $RepoRoot -Command {
            npm run test
        }
    }
}
finally {
    foreach ($package in $packageCopies) {
        Remove-McpPackageWorkCopy -WorkCopy $package.WorkCopy
    }
}

Write-Host "All CI-safe revAgent engineering gates passed." -ForegroundColor Green
