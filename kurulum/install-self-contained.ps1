param(
    [ValidateSet("2022")]
    [string]$RevitVersion = "2022",
    [string]$ServerTarget = "C:\Projects\revit-mcp",
    [switch]$SkipCodexSkillInstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginSource = Join-Path $PSScriptRoot "revit-plugin"
$serverSource = Join-Path $PSScriptRoot "mcp-server"
$docsServerSource = Join-Path $PSScriptRoot "revit-api-docs-mcp"
$addinRoot = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$RevitVersion"
$pluginTarget = Join-Path $addinRoot "revit_mcp_plugin"
$revitInstallRoot = Join-Path ${env:ProgramFiles} "Autodesk\Revit $RevitVersion"

$runningRevit = Get-Process -Name "Revit" -ErrorAction SilentlyContinue
if ($runningRevit) {
    throw "Close Revit before running install-self-contained.ps1. The installer replaces files under $addinRoot and cannot do that safely while Revit is running."
}

function Resolve-DependencyPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FileName,
        [Parameter(Mandatory = $true)]
        [string[]]$SearchRoots
    )

    foreach ($root in $SearchRoots) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $candidate = Join-Path $root $FileName
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return $null
}

function Get-AssemblyVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    try {
        return ([System.Reflection.AssemblyName]::GetAssemblyName($Path)).Version.ToString()
    }
    catch {
        return $null
    }
}

function Resolve-CompatibleDependencyPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FileName,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedVersion,
        [Parameter(Mandatory = $true)]
        [string[]]$SearchRoots,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[string]]$RejectedVersions
    )

    foreach ($root in $SearchRoots) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $candidate = Join-Path $root $FileName
        if (-not (Test-Path $candidate)) { continue }

        $actualVersion = Get-AssemblyVersion -Path $candidate
        if ($actualVersion -eq $ExpectedVersion) {
            return $candidate
        }

        $RejectedVersions.Add(("{0} found at {1} but version is {2}; expected {3}" -f $FileName, $candidate, $actualVersion, $ExpectedVersion))
    }

    return $null
}

New-Item -ItemType Directory -Path $addinRoot -Force | Out-Null
New-Item -ItemType Directory -Path $ServerTarget -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $pluginSource "mcp-servers-for-revit.addin") -Destination (Join-Path $addinRoot "mcp-servers-for-revit.addin") -Force
if (Test-Path $pluginTarget) {
    Remove-Item -LiteralPath $pluginTarget -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $pluginSource "revit_mcp_plugin") -Destination $addinRoot -Recurse -Force
# Expand the bundled runtime server contents into the target directory.
Copy-Item -Path (Join-Path $serverSource "*") -Destination $ServerTarget -Recurse -Force

# The required Revit API docs MCP server remains in the repo under kurulum\revit-api-docs-mcp.
# It is registered from that path after npm install; see the final Next steps.
if (-not (Test-Path $docsServerSource)) {
    throw "Required docs server source was not found: $docsServerSource"
}

# Copy Custom_DLL payload so dynamic command compilation works after install.
$customDllDir = Join-Path $PSScriptRoot "Custom_DLL"
if (Test-Path $customDllDir) {
    # 1. LocalAppData command locations
    $localAppCmdSet2022 = Join-Path $env:LOCALAPPDATA "revit-mcp-plugin\commands\CommandSet\$RevitVersion"
    $localAppCmdSet = Join-Path $env:LOCALAPPDATA "revit-mcp-plugin\commands\CommandSet"

    New-Item -ItemType Directory -Path $localAppCmdSet2022 -Force | Out-Null

    # Copy files into LocalAppData
    Copy-Item -Path (Join-Path $customDllDir "RevitMCPCommandSet.dll") -Destination $localAppCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir "RevitMCPCommandSet.dll") -Destination $localAppCmdSet -Force
    Copy-Item -Path (Join-Path $customDllDir "command.json") -Destination $localAppCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir "command.json") -Destination $localAppCmdSet -Force

    # 2. Mirror the same files into the Revit add-in command folders
    $roamingCmdSet2022 = Join-Path $addinRoot "revit_mcp_plugin\Commands\RevitMCPCommandSet\$RevitVersion"
    $roamingCmdSet = Join-Path $addinRoot "revit_mcp_plugin\Commands\RevitMCPCommandSet"

    New-Item -ItemType Directory -Path $roamingCmdSet2022 -Force | Out-Null
    Copy-Item -Path (Join-Path $customDllDir "RevitMCPCommandSet.dll") -Destination $roamingCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir "RevitMCPCommandSet.dll") -Destination $roamingCmdSet -Force
    Copy-Item -Path (Join-Path $customDllDir "command.json") -Destination $roamingCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir "command.json") -Destination $roamingCmdSet -Force

    # 3. Mirror the exact Roslyn runtime dependencies that the command set needs.
    # Revit/AECGenerativeDesign can contain older Roslyn assemblies (for example
    # Microsoft.CodeAnalysis 2.8.0.0). Copying those next to the current command
    # DLL makes install appear successful but fails at runtime, so exact version
    # checks are required.
    $bundledRuntimeDir = Join-Path $customDllDir "runtime\$RevitVersion"
    $dependencySearchRoots = @(
        $bundledRuntimeDir,
        $localAppCmdSet,
        $revitInstallRoot,
        (Join-Path $revitInstallRoot "AddIns\CoordinationModel"),
        (Join-Path $revitInstallRoot "AddIns\DynamoForRevit"),
        (Join-Path ${env:ProgramFiles} "Autodesk\AECGenerativeDesign $RevitVersion\RestDynamoCore"),
        (Join-Path ${env:ProgramFiles} "Autodesk\AECGenerativeDesign\RestDynamoCore"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319")
    )

    $runtimeAssemblies = @(
        @{ File = "Microsoft.CodeAnalysis.dll"; Version = "4.8.0.0"; Required = $true },
        @{ File = "Microsoft.CodeAnalysis.CSharp.dll"; Version = "4.8.0.0"; Required = $true },
        @{ File = "System.Collections.Immutable.dll"; Version = "7.0.0.0"; Required = $true },
        @{ File = "System.Memory.dll"; Version = "4.0.1.2"; Required = $true },
        @{ File = "System.Reflection.Metadata.dll"; Version = "7.0.0.0"; Required = $true },
        @{ File = "System.Runtime.CompilerServices.Unsafe.dll"; Version = "6.0.0.0"; Required = $true },
        @{ File = "System.Threading.Tasks.Extensions.dll"; Version = "4.2.0.1"; Required = $true },
        @{ File = "System.Text.Encoding.CodePages.dll"; Version = "7.0.0.0"; Required = $true },
        @{ File = "System.Buffers.dll"; Version = "4.0.3.0"; Required = $true },
        @{ File = "System.Numerics.Vectors.dll"; Version = "4.1.4.0"; Required = $true }
    )

    $runtimeDestinations = @($localAppCmdSet2022, $roamingCmdSet2022)
    $missingRuntimeFiles = @()
    $rejectedRuntimeFiles = [System.Collections.Generic.List[string]]::new()

    foreach ($assembly in $runtimeAssemblies) {
        $fileName = $assembly.File
        $sourcePath = Resolve-CompatibleDependencyPath `
            -FileName $fileName `
            -ExpectedVersion $assembly.Version `
            -SearchRoots $dependencySearchRoots `
            -RejectedVersions $rejectedRuntimeFiles
        if (-not $sourcePath) {
            if ($assembly.Required) {
                $missingRuntimeFiles += ("{0} version {1}" -f $fileName, $assembly.Version)
            }
            continue
        }

        foreach ($destination in $runtimeDestinations) {
            Copy-Item -Path $sourcePath -Destination $destination -Force
        }
    }

    if ($missingRuntimeFiles.Count -gt 0) {
        $detail = ""
        if ($rejectedRuntimeFiles.Count -gt 0) {
            $detail = " Rejected incompatible assemblies: " + ($rejectedRuntimeFiles -join "; ")
        }
        throw ("Required Roslyn runtime files were not found with the exact versions needed for Revit {0}: {1}. " +
            "The self-contained package must include them under {2}; do not fall back to older Autodesk/Revit Roslyn assemblies." +
            "{3}") -f $RevitVersion, ($missingRuntimeFiles -join ", "), $bundledRuntimeDir, $detail
    }
}

$duplicateAddin = Join-Path $addinRoot "revit-mcp.addin"
if (Test-Path $duplicateAddin) {
    $disabled = Join-Path $addinRoot "revit-mcp.addin.disabled-self-contained"
    if (Test-Path $disabled) {
        Remove-Item -LiteralPath $disabled -Force
    }
    Move-Item -LiteralPath $duplicateAddin -Destination $disabled
}

$codexSkillTarget = $null
$codexAgentsTarget = $null
if (-not $SkipCodexSkillInstall) {
    $codexRoot = Join-Path $env:USERPROFILE ".codex"
    $codexSkillsRoot = Join-Path $codexRoot "skills"
    $codexSkillTarget = Join-Path $codexSkillsRoot "revit-mcp"
    $codexAgentsTarget = Join-Path $codexRoot "AGENTS.md"

    New-Item -ItemType Directory -Path $codexSkillsRoot -Force | Out-Null

    if (Test-Path -LiteralPath $codexSkillTarget) {
        $backupStamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $skillBackup = Join-Path $codexSkillsRoot "revit-mcp.backup-$backupStamp"
        Move-Item -LiteralPath $codexSkillTarget -Destination $skillBackup
    }

    New-Item -ItemType Directory -Path $codexSkillTarget -Force | Out-Null
    Get-ChildItem -LiteralPath $repoRoot -Force |
        Where-Object { $_.Name -notin @(".git", "node_modules") } |
        Copy-Item -Destination $codexSkillTarget -Recurse -Force

    $agentsSource = Join-Path $repoRoot "AGENTS.md"
    if (Test-Path -LiteralPath $agentsSource) {
        New-Item -ItemType Directory -Path $codexRoot -Force | Out-Null

        $shouldBackupAgents = $false
        if (Test-Path -LiteralPath $codexAgentsTarget) {
            $existingAgents = Get-Item -LiteralPath $codexAgentsTarget
            $shouldBackupAgents = $existingAgents.Length -gt 0
        }

        if ($shouldBackupAgents) {
            $agentsBackup = Join-Path $codexRoot ("AGENTS.md.backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
            Copy-Item -LiteralPath $codexAgentsTarget -Destination $agentsBackup -Force
        }

        Copy-Item -LiteralPath $agentsSource -Destination $codexAgentsTarget -Force
    }
}

Write-Host "Self-contained Revit MCP bundle installed for Revit $RevitVersion" -ForegroundColor Green
Write-Host "Plugin path: $addinRoot"
Write-Host "Runtime server path: $ServerTarget"
Write-Host "Required docs server path: $docsServerSource"
if (-not $SkipCodexSkillInstall) {
    Write-Host "Codex skill path: $codexSkillTarget"
    Write-Host "Codex global AGENTS.md: $codexAgentsTarget"
}
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. cd $ServerTarget"
Write-Host "2. npm install --omit=dev"
Write-Host "3. codex mcp add revit-mcp -- node `"$ServerTarget\build\index.js`""
Write-Host "4. cd $docsServerSource"
Write-Host "5. npm install --omit=dev"
Write-Host "6. npm run build-index"
Write-Host "7. codex mcp add revit-api-docs -- node `"$docsServerSource\build\index.js`""
Write-Host "8. Confirm both servers with: codex mcp list"
Write-Host "9. Run /skills reload in Codex, or restart Codex"
Write-Host "10. Open Revit; if prompted for the unsigned add-in, choose Always Load"
Write-Host "11. Revit MCP starts automatically. Use the ribbon Settings button only to review command availability"
