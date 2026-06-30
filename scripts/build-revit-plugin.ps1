<#
.SYNOPSIS
    Build the revAgent add-in source in this monorepo and refresh the installer payload binaries.

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

Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.RevitVersions.psm1") -Force
Import-Module (Join-Path $RepoRoot "scripts\RevitPayloadManifest.psm1") -Force
$revitVersionConfig = Get-RevAgentVersionConfig -Version $RevitVersion -RepoRoot $RepoRoot

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

    return [string](Get-RevAgentVersionConfig -Version $Version -RepoRoot $RepoRoot).buildConfiguration
}

function Update-BridgeCommandRegistry {
    param(
        [string]$RegistryPath,
        [string]$CommandJsonPath,
        [string]$Version,
        [string]$CommandSetFolderName = "revAgentCommandSet",
        [string]$CommandSetDllFileName = "revAgentCommandSet.dll"
    )

    if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) {
        throw "Command registry was not found: $RegistryPath"
    }
    if (-not (Test-Path -LiteralPath $CommandJsonPath -PathType Leaf)) {
        throw "Bridge command json was not found: $CommandJsonPath"
    }

    $commandSet = Get-Content -LiteralPath $CommandJsonPath -Raw | ConvertFrom-Json
    $commandSetName = [string]$commandSet.name
    if ([string]::IsNullOrWhiteSpace($commandSetName)) {
        throw "Bridge command json is missing name: $CommandJsonPath"
    }

    $developer = $commandSet.developer
    if ($null -eq $developer) {
        $developer = [pscustomobject]@{
            name = "mcp-servers-for-revit"
            email = ""
            website = ""
            organization = "mcp-servers-for-revit"
        }
    }

    $commands = @()
    foreach ($command in $commandSet.commands) {
        $assemblyFile = [string]$command.assemblyPath
        $assemblyFile = $CommandSetDllFileName
        $commands += [pscustomobject]@{
            commandName = [string]$command.commandName
            assemblyPath = "$CommandSetFolderName\\$Version\\$assemblyFile"
            enabled = $true
            supportedRevitVersions = @($Version)
            developer = $developer
            description = [string]$command.description
        }
    }

    $registry = [pscustomobject]@{
        Commands = $commands
    }
    $registry | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $RegistryPath -Encoding UTF8
}

$projectPath = Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\revAgentPlugin.csproj"
if (-not (Test-Path -LiteralPath $projectPath)) {
    throw "Revit plugin project was not found: $projectPath"
}
$commandSetProjectPath = Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\revAgentCommandSet.csproj"
if (-not (Test-Path -LiteralPath $commandSetProjectPath)) {
    throw "Revit bridge command set project was not found: $commandSetProjectPath"
}

$dotnet = Resolve-DotnetSdk -RequestedPath $DotnetPath
$configuration = Get-Configuration -Version $RevitVersion
$commandSetConfiguration = $configuration

Write-Host "Building Revit plugin"
Write-Host "Project      : $projectPath"
Write-Host "Configuration: $configuration"
Write-Host "dotnet       : $dotnet"

& $dotnet build $projectPath -c $configuration
if ($LASTEXITCODE -ne 0) {
    throw "Revit plugin build failed with exit code $LASTEXITCODE"
}

Write-Host "Building Revit bridge command set"
Write-Host "Project      : $commandSetProjectPath"
Write-Host "Configuration: $commandSetConfiguration"

& $dotnet build $commandSetProjectPath -c $commandSetConfiguration -p:Platform=x64 -p:RevAgentDeployCommandSet=false
if ($LASTEXITCODE -ne 0) {
    throw "Revit bridge command set build failed with exit code $LASTEXITCODE"
}

$builtDll = Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\bin\Release\$RevitVersion\revAgentPlugin.dll"
if (-not (Test-Path -LiteralPath $builtDll -PathType Leaf)) {
    throw "Build completed but output DLL was not found: $builtDll"
}
$builtCommandSetDll = Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\bin\Release\$RevitVersion\revAgentCommandSet.dll"
if (-not (Test-Path -LiteralPath $builtCommandSetDll -PathType Leaf)) {
    throw "Build completed but output DLL was not found: $builtCommandSetDll"
}

if (-not $SkipPayloadCopy) {
    Assert-NoUntrackedRevitPayloadSourceInputs -RepoRoot $RepoRoot -RevitVersion $RevitVersion
    Assert-RevAgentInstallerPayloadAvailable -Version $RevitVersion -RepoRoot $RepoRoot
    $payloadDir = Join-Path $RepoRoot ([string]$revitVersionConfig.payload.installerPluginPath)
    if (-not (Test-Path -LiteralPath $payloadDir -PathType Container)) {
        throw "Installer payload directory was not found: $payloadDir"
    }

    $pluginDllFileName = "revAgentPlugin.dll"
    $commandSetDllFileName = "revAgentCommandSet.dll"

    $payloadCopies = [ordered]@{
        "revAgentPlugin.dll" = $pluginDllFileName
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

    $commandJsonSource = Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\command.json"
    $commandPayloadDir = Join-Path $RepoRoot "installer\command-payload"
    $commandPayloadRuntimeDir = Join-Path $commandPayloadDir "runtime\$RevitVersion"
    New-Item -ItemType Directory -Path $commandPayloadRuntimeDir -Force | Out-Null
    Copy-Item -LiteralPath $builtCommandSetDll -Destination (Join-Path $commandPayloadDir $commandSetDllFileName) -Force
    Copy-Item -LiteralPath $commandJsonSource -Destination (Join-Path $commandPayloadDir "command.json") -Force

    $runtimeAssemblies = @(
        "Microsoft.CodeAnalysis.dll",
        "Microsoft.CodeAnalysis.CSharp.dll",
        "System.Buffers.dll",
        "System.Collections.Immutable.dll",
        "System.Memory.dll",
        "System.Numerics.Vectors.dll",
        "System.Reflection.Metadata.dll",
        "System.Runtime.CompilerServices.Unsafe.dll",
        "System.Text.Encoding.CodePages.dll",
        "System.Threading.Tasks.Extensions.dll"
    )
    $commandSetOutputDir = Split-Path -Parent $builtCommandSetDll
    foreach ($assemblyName in $runtimeAssemblies) {
        $sourceFile = Join-Path $commandSetOutputDir $assemblyName
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
            throw "Command set runtime dependency was not found: $sourceFile"
        }
        Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $commandPayloadRuntimeDir $assemblyName) -Force
    }

    $commandsRoot = Join-Path $payloadDir "Commands"
    $commandSetPayloadFolderName = "revAgentCommandSet"
    $commandSetRoot = Join-Path $commandsRoot $commandSetPayloadFolderName
    $commandSetVersionRoot = Join-Path $commandSetRoot $RevitVersion
    $commandsRootFullPath = [System.IO.Path]::GetFullPath($commandsRoot)
    foreach ($legacyCommandSetRoot in @(
            (Join-Path $commandsRoot "RevitMCPViewCommandSet"),
            (Join-Path $commandsRoot "RevitMCPCommandSet")
        )) {
        if (-not (Test-Path -LiteralPath $legacyCommandSetRoot)) {
            continue
        }
        $legacyCommandSetRootFullPath = [System.IO.Path]::GetFullPath($legacyCommandSetRoot)
        if (-not $legacyCommandSetRootFullPath.StartsWith($commandsRootFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove legacy command set outside installer Commands payload: $legacyCommandSetRootFullPath"
        }
        Remove-Item -LiteralPath $legacyCommandSetRoot -Recurse -Force
    }

    foreach ($legacyRootCommandSetDll in @(
            (Join-Path $commandSetRoot "RevitMCPCommandSet.dll"),
            (Join-Path $commandSetVersionRoot "RevitMCPCommandSet.dll")
        )) {
        if (Test-Path -LiteralPath $legacyRootCommandSetDll) {
            Remove-Item -LiteralPath $legacyRootCommandSetDll -Force
        }
    }
    New-Item -ItemType Directory -Path $commandSetVersionRoot -Force | Out-Null
    Copy-Item -LiteralPath $builtCommandSetDll -Destination (Join-Path $commandSetVersionRoot $commandSetDllFileName) -Force
    Copy-Item -LiteralPath $commandJsonSource -Destination (Join-Path $commandSetRoot "command.json") -Force
    Update-BridgeCommandRegistry `
        -RegistryPath (Join-Path $payloadDir "Commands\commandRegistry.json") `
        -CommandJsonPath (Join-Path $commandSetRoot "command.json") `
        -Version $RevitVersion `
        -CommandSetFolderName $commandSetPayloadFolderName `
        -CommandSetDllFileName $commandSetDllFileName

    Remove-RevitPayloadDebugArtifacts -RepoRoot $RepoRoot
    Assert-RevitPayloadNoDebugArtifacts -RepoRoot $RepoRoot

    $manifestPath = Write-RevitPayloadManifest `
        -RepoRoot $RepoRoot `
        -RevitVersion $RevitVersion `
        -Configuration $configuration
    Write-Host "Installer payload refreshed: $payloadDir" -ForegroundColor Green
    Write-Host "Revit payload manifest refreshed: $manifestPath" -ForegroundColor Green
}

Write-Host "Built DLL: $builtDll" -ForegroundColor Green
Write-Host "Built bridge command set DLL: $builtCommandSetDll" -ForegroundColor Green
