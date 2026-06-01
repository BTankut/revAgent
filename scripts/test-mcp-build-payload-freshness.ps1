<#
.SYNOPSIS
    Verify committed MCP build payloads match their TypeScript source.

.DESCRIPTION
    The installer and Codex registrations consume build/index.js. Because build
    output is currently part of the package contract, source changes must keep
    build output fresh. This test compiles each MCP package into a temporary
    folder and compares that output with the checked-in build folder.
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

function Get-RelativeFileHashMap {
    param(
        [string]$Root
    )

    $map = @{}
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return $map
    }

    Get-ChildItem -LiteralPath $Root -Recurse -File -Filter "*.js" |
        Sort-Object FullName |
        ForEach-Object {
            $relative = $_.FullName.Substring($Root.Length + 1).Replace("/", "\")
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

function Get-NewestPayloadSourceFile {
    param(
        [string]$SourceRoot
    )

    if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
        throw "Payload source root was not found: $SourceRoot"
    }

    $files = @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Include "*.cs", "*.csproj", "*.xaml", "*.json" |
        Where-Object { $_.FullName -notmatch '[\\\/](bin|obj)[\\\/]' } |
        Sort-Object LastWriteTimeUtc -Descending)

    if ($files.Count -eq 0) {
        throw "No payload source files were found under: $SourceRoot"
    }

    return $files[0]
}

function Assert-RevitPayloadFresh {
    param(
        [string]$SourceRelativePath,
        [string[]]$PayloadRelativePaths
    )

    $sourceRoot = Join-Path $RepoRoot $SourceRelativePath
    $newestSource = Get-NewestPayloadSourceFile -SourceRoot $sourceRoot

    foreach ($payloadRelativePath in $PayloadRelativePaths) {
        $payloadPath = Join-Path $RepoRoot $payloadRelativePath
        if (-not (Test-Path -LiteralPath $payloadPath -PathType Leaf)) {
            throw "Revit payload file is missing: $payloadRelativePath"
        }

        $payload = Get-Item -LiteralPath $payloadPath
        if ($payload.Length -le 0) {
            throw "Revit payload file is empty: $payloadRelativePath"
        }

        if ($newestSource.LastWriteTimeUtc -gt $payload.LastWriteTimeUtc) {
            throw "Revit payload may be stale. Source '$($newestSource.FullName)' is newer than payload '$payloadRelativePath'. Run scripts\build-revit-plugin.ps1 and refresh installer payloads before release."
        }
    }
}

Assert-BuildFresh -PackageRelativePath "installer\runtime-mcp-server"
Assert-BuildFresh -PackageRelativePath "installer\revit-api-docs-mcp"
Assert-RevitPayloadFresh -SourceRelativePath "src\revit-plugin\revit-mcp-plugin" -PayloadRelativePaths @(
    "installer\revit-plugin\revit_mcp_plugin\RevitMCPPlugin.dll"
)
Assert-RevitPayloadFresh -SourceRelativePath "src\revit-plugin\RevitMCPCommandSet" -PayloadRelativePaths @(
    "installer\command-payload\RevitMCPCommandSet.dll",
    "installer\revit-plugin\revit_mcp_plugin\Commands\RevitMCPCommandSet\2022\RevitMCPCommandSet.dll"
)

Write-Host "MCP and Revit payload freshness passed." -ForegroundColor Green
