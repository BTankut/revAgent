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

    $runtimePackageCopy = @($packageCopies | Where-Object { $_.Name -eq "runtime-mcp-server" }) | Select-Object -First 1
    & (Join-Path $RepoRoot "scripts\test-updater-npm-dependencies.ps1") -RepoRoot $RepoRoot -RuntimePackageRoot $runtimePackageCopy.WorkCopy.PackageRoot

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
    & (Join-Path $RepoRoot "scripts\test-bridge-contracts.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-bridge-service.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-codex-integration-security.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-os-path-security.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-license-seat.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-source-free-migration.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-desktop-launcher-evidence.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-desktop-launcher-cleanup.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-rollout-evidence-collector.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-live-smoke-ssh-runner.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-evals-branding.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-typescript-nocheck-policy.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-mcp-build-payload-freshness.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-publish-signing.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-signed-stable-readiness.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-signed-source-free-cd.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-release-snapshot.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-nas-release-acl.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-shared-ancestor-acl.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-updater-stabilization-g7-g9.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-local-update-bootstrap.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-clean-install-bootstrap.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-rollout-readiness.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-repo-rename-readiness.ps1") -RepoRoot $RepoRoot
    & (Join-Path $RepoRoot "scripts\test-ci-classifier.ps1") -RepoRoot $RepoRoot

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
