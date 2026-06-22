<#
.SYNOPSIS
    Verify committed MCP and Revit payloads match their source inputs.

.DESCRIPTION
    The installer and Codex registrations consume build/index.js. Because build
    output is currently part of the package contract, source changes must keep
    build output fresh. This test compiles each MCP package into a temporary
    folder and compares that output with the checked-in build folder.

    Revit payload freshness is validated through a committed content manifest
    written by scripts\build-revit-plugin.ps1. It uses Git blob SHAs for source
    inputs so checkout and merge mtimes cannot create false stale results.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [switch]$McpOnly
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

Import-Module (Join-Path $RepoRoot "scripts\RevitPayloadManifest.psm1") -Force
Import-Module (Join-Path $RepoRoot "scripts\McpPackageTestHelpers.psm1") -Force

function Get-RelativeFileHashMap {
    param(
        [string]$Root,
        [string[]]$Extensions = @(".js")
    )

    $map = @{}
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return $map
    }

    $rootFullName = (Get-Item -LiteralPath $Root).FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $rootPrefix = $rootFullName + [System.IO.Path]::DirectorySeparatorChar

    $extensionSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($extension in $Extensions) {
        if (-not [string]::IsNullOrWhiteSpace($extension)) {
            [void]$extensionSet.Add($extension)
        }
    }

    Get-ChildItem -LiteralPath $rootFullName -Recurse -File |
        Where-Object { $extensionSet.Count -eq 0 -or $extensionSet.Contains($_.Extension) } |
        Sort-Object FullName |
        ForEach-Object {
            if (-not $_.FullName.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "File '$($_.FullName)' is not under expected root '$rootFullName'."
            }
            $relative = $_.FullName.Substring($rootPrefix.Length).Replace("/", "\")
            $map[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
        }
    return $map
}

function Assert-HashMapsEqual {
    param(
        [string]$Label,
        [hashtable]$Actual,
        [hashtable]$Expected
    )

    $actualKeys = @($Actual.Keys | Sort-Object)
    $expectedKeys = @($Expected.Keys | Sort-Object)
    if (($actualKeys -join "|") -ne ($expectedKeys -join "|")) {
        $missing = @($expectedKeys | Where-Object { -not $Actual.ContainsKey($_) })
        $stale = @($actualKeys | Where-Object { -not $Expected.ContainsKey($_) })
        throw "$Label file list is stale. Missing: $($missing -join ', ') Extra: $($stale -join ', ')"
    }

    $mismatched = @($expectedKeys | Where-Object { $Actual[$_] -ne $Expected[$_] })
    if ($mismatched.Count -gt 0) {
        throw "$Label content is stale. Mismatched files: $($mismatched -join ', ')"
    }
}

function Assert-BuildFresh {
    param(
        [string]$PackageRelativePath
    )

    $packageRoot = Join-Path $RepoRoot $PackageRelativePath
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot "tsconfig.json") -PathType Leaf)) {
        throw "MCP package tsconfig was not found: $packageRoot"
    }

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-mcp-build-check-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $workCopy = New-McpPackageWorkCopy -PackageRoot $packageRoot -PackageRelativePath $PackageRelativePath

    try {
        Invoke-McpPackageNpmCi -PackageName $PackageRelativePath -PackageRoot $workCopy.PackageRoot -PackageRelativePath $PackageRelativePath

        Push-Location $workCopy.PackageRoot
        try {
            $tscPath = Get-McpPackageTscPath -PackageRoot $workCopy.PackageRoot -PackageRelativePath $PackageRelativePath

            & $tscPath --outDir $tempRoot
            if ($LASTEXITCODE -ne 0) {
                throw "TypeScript temp build failed for $PackageRelativePath"
            }
        }
        finally {
            Pop-Location
        }

        $actualBuild = Join-Path $packageRoot "build"
        $actual = Get-RelativeFileHashMap -Root $actualBuild
        $expected = Get-RelativeFileHashMap -Root $tempRoot
        Assert-HashMapsEqual -Label "Build payload for $PackageRelativePath" -Actual $actual -Expected $expected

        $releaseBuilder = Join-Path $RepoRoot "scripts\build-mcp-release-bundle.mjs"
        if (-not (Test-Path -LiteralPath $releaseBuilder -PathType Leaf)) {
            throw "Release bundle builder was not found: $releaseBuilder"
        }

        Invoke-McpPackageCommand -PackageName "$PackageRelativePath release bundle" -PackageRoot $workCopy.PackageRoot -RepoRoot $RepoRoot -Command {
            node $releaseBuilder
        }

        $actualRelease = Get-RelativeFileHashMap -Root (Join-Path $packageRoot "release") -Extensions @(".js", ".json")
        $expectedRelease = Get-RelativeFileHashMap -Root (Join-Path $workCopy.PackageRoot "release") -Extensions @(".js", ".json")
        Assert-HashMapsEqual -Label "Release payload for $PackageRelativePath" -Actual $actualRelease -Expected $expectedRelease
    }
    finally {
        Remove-McpPackageWorkCopy -WorkCopy $workCopy
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }
}

Assert-BuildFresh -PackageRelativePath "installer\runtime-mcp-server"
Assert-BuildFresh -PackageRelativePath "installer\revit-api-docs-mcp"

if (-not $McpOnly) {
    Assert-RevitPayloadManifestFresh -RepoRoot $RepoRoot
}

if ($McpOnly) {
    Write-Host "MCP build payload freshness passed." -ForegroundColor Green
}
else {
    Write-Host "MCP and Revit payload freshness passed." -ForegroundColor Green
}
