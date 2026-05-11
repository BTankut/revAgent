<#
.SYNOPSIS
    Build the Revit MCP add-in source in this monorepo and refresh the installer payload binaries.

.DESCRIPTION
    The source of the Revit add-in lives under src\revit-plugin. The installer
    still consumes the stable payload path under installer\revit-plugin. This
    script is the explicit bridge between source development and production
    packaging.
#>

[CmdletBinding()]
param(
    [string]$RevitVersion = "2022",

    [string]$RepoRoot = "",

    [string]$DotnetPath = "",

    [switch]$SkipPayloadCopy
)

$ErrorActionPreference = "Stop"

$scriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptRoot)) {
    $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

Import-Module (Join-Path $RepoRoot "installer\lib\RevitMcp.RevitVersions.psm1") -Force
$revitVersionConfig = Get-RevitMcpVersionConfig -Version $RevitVersion -RepoRoot $RepoRoot

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

    throw "A .NET SDK was not found. Install .NET SDK 8.x or pass -DotnetPath."
}

function Get-Configuration {
    param([string]$Version)

    return [string](Get-RevitMcpVersionConfig -Version $Version -RepoRoot $RepoRoot).buildConfiguration
}

$projectPath = Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\revit-mcp-plugin.csproj"
if (-not (Test-Path -LiteralPath $projectPath)) {
    throw "Revit plugin project was not found: $projectPath"
}

$dotnet = Resolve-DotnetSdk -RequestedPath $DotnetPath
$configuration = Get-Configuration -Version $RevitVersion

Write-Host "Building Revit plugin"
Write-Host "Project      : $projectPath"
Write-Host "Configuration: $configuration"
Write-Host "dotnet       : $dotnet"

& $dotnet build $projectPath -c $configuration
if ($LASTEXITCODE -ne 0) {
    throw "Revit plugin build failed with exit code $LASTEXITCODE"
}

$builtDll = Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\bin\Release\$RevitVersion\revit-mcp-plugin.dll"
if (-not (Test-Path -LiteralPath $builtDll -PathType Leaf)) {
    throw "Build completed but output DLL was not found: $builtDll"
}

if (-not $SkipPayloadCopy) {
    Assert-RevitMcpInstallerPayloadAvailable -Version $RevitVersion -RepoRoot $RepoRoot
    $payloadDir = Join-Path $RepoRoot ([string]$revitVersionConfig.payload.installerPluginPath)
    if (-not (Test-Path -LiteralPath $payloadDir -PathType Container)) {
        throw "Installer payload directory was not found: $payloadDir"
    }

    $payloadCopies = [ordered]@{
        "revit-mcp-plugin.dll" = "RevitMCPPlugin.dll"
        "Newtonsoft.Json.dll" = "Newtonsoft.Json.dll"
        "RevitMCPSDK.dll" = "RevitMCPSDK.dll"
    }

    $buildOutputDir = Split-Path -Parent $builtDll
    foreach ($entry in $payloadCopies.GetEnumerator()) {
        $sourceFile = Join-Path $buildOutputDir $entry.Key
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
            throw "Build output was not found: $sourceFile"
        }
        Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $payloadDir $entry.Value) -Force
    }

    Write-Host "Installer payload refreshed: $payloadDir" -ForegroundColor Green
}

Write-Host "Built DLL: $builtDll" -ForegroundColor Green
