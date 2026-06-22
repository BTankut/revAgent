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

    & (Join-Path $RepoRoot "scripts\test-installer-smoke.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-distribution-integrity.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-usage-intelligence.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-live-dashboard.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-typescript-nocheck-policy.ps1") -RepoRoot $RepoRoot

    foreach ($package in $packageCopies) {
        Invoke-McpPackageCommand -PackageName "$($package.Name) npm test" -PackageRoot $package.WorkCopy.PackageRoot -RepoRoot $RepoRoot -Command {
            npm run test
        }
    }

    & (Join-Path $RepoRoot "scripts\test-mcp-build-payload-freshness.ps1") -RepoRoot $RepoRoot
}
finally {
    foreach ($package in $packageCopies) {
        Remove-McpPackageWorkCopy -WorkCopy $package.WorkCopy
    }
}

Write-Host "All local non-Revit tests passed." -ForegroundColor Green
