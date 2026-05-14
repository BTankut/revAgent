<#
.SYNOPSIS
    Run connector graph schema, validator, fixture, and unit conversion checks.

.DESCRIPTION
    These tests build and execute a small .NET Framework 4.8 console test runner.
    They intentionally avoid Revit and use synthetic JSON fixtures only.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = "",

    [string]$DotnetPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

function Resolve-DotnetSdk {
    param([string]$RequestedPath)

    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
            $RequestedPath,
            (Join-Path $env:USERPROFILE ".dotnet-sdk-codex\dotnet.exe"),
            (Join-Path ${env:ProgramFiles} "dotnet\dotnet.exe")
        )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $candidates.Add($candidate)
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:DOTNET_ROOT)) {
        $candidates.Insert(1, (Join-Path $env:DOTNET_ROOT "dotnet.exe"))
    }

    foreach ($candidate in $candidates) {
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (-not (Test-Path -LiteralPath $expanded -PathType Leaf)) {
            continue
        }

        $sdks = & $expanded --list-sdks 2>$null
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace(($sdks | Out-String).Trim())) {
            return $expanded
        }
    }

    $command = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    throw "A .NET SDK was not found. Install .NET SDK 8.x or newer, or pass -DotnetPath."
}

$dotnet = Resolve-DotnetSdk -RequestedPath $DotnetPath
$testProject = Join-Path $RepoRoot "src\revit-plugin\MepConnectorGraph.Tests\MepConnectorGraph.Tests.csproj"
$fixtureRoot = Join-Path $RepoRoot "tests\fixtures\connector-graph"

Write-Host "Building connector graph tests"
& $dotnet build $testProject -c Release
if ($LASTEXITCODE -ne 0) {
    throw "Connector graph test build failed with exit code $LASTEXITCODE"
}

$testExe = Join-Path $RepoRoot "src\revit-plugin\MepConnectorGraph.Tests\bin\Release\net48\MepConnectorGraph.Tests.exe"
if (-not (Test-Path -LiteralPath $testExe -PathType Leaf)) {
    throw "Connector graph test executable was not found: $testExe"
}

Write-Host "Running connector graph tests"
& $testExe --fixtures $fixtureRoot
if ($LASTEXITCODE -ne 0) {
    throw "Connector graph tests failed with exit code $LASTEXITCODE"
}

Write-Host "Connector graph tests passed." -ForegroundColor Green
