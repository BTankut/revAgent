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

function Get-RelativeFileHashMap {
    param(
        [string]$Root
    )

    $map = @{}
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return $map
    }

    $rootFullName = (Get-Item -LiteralPath $Root).FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $rootPrefix = $rootFullName + [System.IO.Path]::DirectorySeparatorChar

    Get-ChildItem -LiteralPath $rootFullName -Recurse -File -Filter "*.js" |
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

function Assert-BuildFresh {
    param(
        [string]$PackageRelativePath
    )

    $packageRoot = Join-Path $RepoRoot $PackageRelativePath
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot "tsconfig.json") -PathType Leaf)) {
        throw "MCP package tsconfig was not found: $packageRoot"
    }

    $tempRoot = Join-Path $env:TEMP ("revagent-mcp-build-check-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

    try {
        Push-Location $packageRoot
        try {
            & npx tsc --outDir $tempRoot
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

        $actualKeys = @($actual.Keys | Sort-Object)
        $expectedKeys = @($expected.Keys | Sort-Object)
        if (($actualKeys -join "|") -ne ($expectedKeys -join "|")) {
            $missing = @($expectedKeys | Where-Object { -not $actual.ContainsKey($_) })
            $stale = @($actualKeys | Where-Object { -not $expected.ContainsKey($_) })
            throw "Build payload file list is stale for $PackageRelativePath. Missing: $($missing -join ', ') Extra: $($stale -join ', ')"
        }

        $mismatched = @($expectedKeys | Where-Object { $actual[$_] -ne $expected[$_] })
        if ($mismatched.Count -gt 0) {
            throw "Build payload content is stale for $PackageRelativePath. Mismatched files: $($mismatched -join ', ')"
        }
    }
    finally {
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
