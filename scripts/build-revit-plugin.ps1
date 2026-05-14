<#
.SYNOPSIS
    Build the Revit MCP add-in source in this monorepo and refresh the installer payload binaries.

.DESCRIPTION
    The source of the Revit add-in and command sets lives under
    src\revit-plugin. The installer still consumes the stable payload paths
    under installer\revit-plugin and installer\command-payload. This script is
    the explicit bridge between source development and production packaging.
#>

[CmdletBinding()]
param(
    [string]$RevitVersion = "2022",

    [string]$RepoRoot = "",

    [string]$DotnetPath = "",

    [switch]$SkipPayloadCopy,

    [switch]$RefreshCommandSetPayload
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

function Update-ViewCommandRegistry {
    param(
        [string]$RegistryPath,
        [string]$ViewCommandJsonPath,
        [string]$Version
    )

    if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) {
        throw "Command registry was not found: $RegistryPath"
    }
    if (-not (Test-Path -LiteralPath $ViewCommandJsonPath -PathType Leaf)) {
        throw "View command json was not found: $ViewCommandJsonPath"
    }

    $registry = Get-Content -LiteralPath $RegistryPath -Raw | ConvertFrom-Json
    $viewCommandSet = Get-Content -LiteralPath $ViewCommandJsonPath -Raw | ConvertFrom-Json
    $viewCommandNames = @($viewCommandSet.commands | ForEach-Object { [string]$_.commandName })
    $viewDeveloper = [pscustomobject]@{
        name = "mcp-servers-for-revit"
        email = ""
        website = ""
        organization = "mcp-servers-for-revit"
    }

    $commands = @($registry.Commands | Where-Object {
            $viewCommandNames -notcontains [string]$_.commandName
        })

    foreach ($command in $viewCommandSet.commands) {
        $commands += [pscustomobject]@{
            commandName = [string]$command.commandName
            assemblyPath = "RevitMCPViewCommandSet\\$Version\\RevitMCPViewCommandSet.dll"
            enabled = $true
            supportedRevitVersions = @($Version)
            developer = $viewDeveloper
            description = [string]$command.description
        }
    }

    $registry.Commands = $commands
    $registry | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $RegistryPath -Encoding UTF8
}

$projectPath = Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\revit-mcp-plugin.csproj"
if (-not (Test-Path -LiteralPath $projectPath)) {
    throw "Revit plugin project was not found: $projectPath"
}
$viewCommandSetProjectPath = Join-Path $RepoRoot "src\revit-plugin\RevitMCPViewCommandSet\RevitMCPViewCommandSet.csproj"
if (-not (Test-Path -LiteralPath $viewCommandSetProjectPath)) {
    throw "Revit view command set project was not found: $viewCommandSetProjectPath"
}
$commandSetProjectPath = Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\RevitMCPCommandSet.csproj"
if (-not (Test-Path -LiteralPath $commandSetProjectPath)) {
    throw "Revit dynamic command set project was not found: $commandSetProjectPath"
}

$dotnet = Resolve-DotnetSdk -RequestedPath $DotnetPath
$configuration = Get-Configuration -Version $RevitVersion
$viewCommandSetConfiguration = "Release $RevitVersion"

Write-Host "Building Revit plugin"
Write-Host "Project      : $projectPath"
Write-Host "Configuration: $configuration"
Write-Host "dotnet       : $dotnet"

& $dotnet build $projectPath -c $configuration
if ($LASTEXITCODE -ne 0) {
    throw "Revit plugin build failed with exit code $LASTEXITCODE"
}

Write-Host "Building Revit view command set"
Write-Host "Project      : $viewCommandSetProjectPath"
Write-Host "Configuration: $viewCommandSetConfiguration"

& $dotnet build $viewCommandSetProjectPath -c $viewCommandSetConfiguration -p:Platform=x64
if ($LASTEXITCODE -ne 0) {
    throw "Revit view command set build failed with exit code $LASTEXITCODE"
}

Write-Host "Building Revit dynamic command set"
Write-Host "Project      : $commandSetProjectPath"
Write-Host "Configuration: $configuration"

& $dotnet build $commandSetProjectPath -c $configuration -p:Platform=x64 -p:RevitMcpDeployCommandSet=false
if ($LASTEXITCODE -ne 0) {
    throw "Revit dynamic command set build failed with exit code $LASTEXITCODE"
}

$builtDll = Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\bin\Release\$RevitVersion\revit-mcp-plugin.dll"
if (-not (Test-Path -LiteralPath $builtDll -PathType Leaf)) {
    throw "Build completed but output DLL was not found: $builtDll"
}
$builtViewCommandSetDll = Join-Path $RepoRoot "src\revit-plugin\RevitMCPViewCommandSet\bin\Release\$RevitVersion\RevitMCPViewCommandSet.dll"
if (-not (Test-Path -LiteralPath $builtViewCommandSetDll -PathType Leaf)) {
    throw "Build completed but output DLL was not found: $builtViewCommandSetDll"
}
$builtCommandSetDll = Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\bin\Release\$RevitVersion\RevitMCPCommandSet.dll"
if (-not (Test-Path -LiteralPath $builtCommandSetDll -PathType Leaf)) {
    throw "Build completed but output DLL was not found: $builtCommandSetDll"
}

if (-not $SkipPayloadCopy) {
    Assert-RevitMcpInstallerPayloadAvailable -Version $RevitVersion -RepoRoot $RepoRoot
    $payloadDir = Join-Path $RepoRoot ([string]$revitVersionConfig.payload.installerPluginPath)
    $commandPayloadDir = Join-Path $RepoRoot ([string]$revitVersionConfig.payload.commandPayloadPath)
    if (-not (Test-Path -LiteralPath $payloadDir -PathType Container)) {
        throw "Installer payload directory was not found: $payloadDir"
    }
    if (-not (Test-Path -LiteralPath $commandPayloadDir -PathType Container)) {
        throw "Command payload directory was not found: $commandPayloadDir"
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

    $viewCommandSetRoot = Join-Path $payloadDir "Commands\RevitMCPViewCommandSet"
    $viewCommandSetVersionRoot = Join-Path $viewCommandSetRoot $RevitVersion
    New-Item -ItemType Directory -Path $viewCommandSetVersionRoot -Force | Out-Null
    Copy-Item -LiteralPath $builtViewCommandSetDll -Destination (Join-Path $viewCommandSetRoot "RevitMCPViewCommandSet.dll") -Force
    Copy-Item -LiteralPath $builtViewCommandSetDll -Destination (Join-Path $viewCommandSetVersionRoot "RevitMCPViewCommandSet.dll") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPViewCommandSet\command.json") -Destination (Join-Path $viewCommandSetRoot "command.json") -Force
    Update-ViewCommandRegistry `
        -RegistryPath (Join-Path $payloadDir "Commands\commandRegistry.json") `
        -ViewCommandJsonPath (Join-Path $viewCommandSetRoot "command.json") `
        -Version $RevitVersion

    if ($RefreshCommandSetPayload) {
        $commandJsonPath = Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\command.json"
        if (-not (Test-Path -LiteralPath $commandJsonPath -PathType Leaf)) {
            throw "Revit dynamic command set command.json was not found: $commandJsonPath"
        }

        Copy-Item -LiteralPath $builtCommandSetDll -Destination (Join-Path $commandPayloadDir "RevitMCPCommandSet.dll") -Force
        Copy-Item -LiteralPath $commandJsonPath -Destination (Join-Path $commandPayloadDir "command.json") -Force

        $commandSetRoot = Join-Path $payloadDir "Commands\RevitMCPCommandSet"
        $commandSetVersionRoot = Join-Path $commandSetRoot $RevitVersion
        New-Item -ItemType Directory -Path $commandSetVersionRoot -Force | Out-Null
        Copy-Item -LiteralPath $builtCommandSetDll -Destination (Join-Path $commandSetVersionRoot "RevitMCPCommandSet.dll") -Force
        Copy-Item -LiteralPath $commandJsonPath -Destination (Join-Path $commandSetRoot "command.json") -Force
        Write-Host "Dynamic command set payload refreshed: $commandPayloadDir" -ForegroundColor Yellow
    }

    Write-Host "Installer payload refreshed: $payloadDir" -ForegroundColor Green
}

Write-Host "Built DLL: $builtDll" -ForegroundColor Green
Write-Host "Built dynamic command set DLL: $builtCommandSetDll" -ForegroundColor Green
Write-Host "Built view command set DLL: $builtViewCommandSetDll" -ForegroundColor Green
