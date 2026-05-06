param(
    [ValidateSet("2022")]
    [string]$RevitVersion = "2022",
    [string]$ServerTarget = "C:\Projects\revit-mcp",
    [string[]]$LegacyServerTargets = @(),
    [string]$WorkspaceAgentsTarget = "",
    [switch]$SkipCodexSkillInstall,
    [switch]$Uninstall,
    [switch]$RemoveAgents
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
$codexRoot = Join-Path $env:USERPROFILE ".codex"
$codexSkillsRoot = Join-Path $codexRoot "skills"
$codexSkillTarget = Join-Path $codexSkillsRoot "revit-mcp"
$codexSkillBackupsRoot = Join-Path $codexRoot "skill-backups"
$codexAgentsTarget = Join-Path $codexRoot "AGENTS.md"
$defaultLegacyServerTargets = @(
    "C:\Projects\revit-mcp-server",
    "C:\Projects\mcp-server-for-revit",
    "C:\Projects\mcp-servers-for-revit"
)
if ([string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
    $serverParent = Split-Path -Parent $ServerTarget
    $WorkspaceAgentsTarget = Join-Path $serverParent "AGENTS.md"
}

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

function Get-NormalizedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    if (-not [System.IO.Path]::IsPathRooted($expanded)) {
        $expanded = Join-Path (Get-Location).Path $expanded
    }

    return [System.IO.Path]::GetFullPath($expanded).TrimEnd("\")
}

function Test-SamePath {
    param(
        [string]$Left,
        [string]$Right
    )

    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        return $false
    }

    return [string]::Equals(
        (Get-NormalizedPath -Path $Left),
        (Get-NormalizedPath -Path $Right),
        [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-RevitMcpCleanupPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [string]$AllowedNamePattern = "(?i)(^revit[-_]mcp($|[-_.])|^revit_mcp_plugin$|^mcp[-_]servers?[-_]for[-_]revit|^mcp-server-for-revit|^RevitMCP|^AGENTS\.md$)"
    )

    $fullPath = Get-NormalizedPath -Path $Path
    $rootPath = [System.IO.Path]::GetPathRoot($fullPath).TrimEnd("\")
    $leaf = Split-Path -Leaf $fullPath
    $blockedRoots = @(
        $rootPath,
        (Get-NormalizedPath -Path $env:USERPROFILE),
        (Get-NormalizedPath -Path $env:APPDATA),
        (Get-NormalizedPath -Path $env:LOCALAPPDATA),
        (Get-NormalizedPath -Path $env:ProgramFiles),
        (Get-NormalizedPath -Path (Join-Path $env:APPDATA "Autodesk")),
        (Get-NormalizedPath -Path (Join-Path $env:APPDATA "Autodesk\Revit")),
        (Get-NormalizedPath -Path $addinRoot),
        (Get-NormalizedPath -Path $codexRoot),
        (Get-NormalizedPath -Path $codexSkillsRoot),
        (Get-NormalizedPath -Path (Split-Path -Parent $ServerTarget))
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    foreach ($blocked in $blockedRoots) {
        if ([string]::Equals($fullPath, $blocked, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clean $Label because the target is too broad: $fullPath"
        }
    }

    if ($leaf -notmatch $AllowedNamePattern) {
        throw "Refusing to clean $Label because it is not a known Revit MCP path: $fullPath"
    }

    return $fullPath
}

function Remove-RevitMcpPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [switch]$Recurse,
        [string]$AllowedNamePattern
    )

    if ([string]::IsNullOrWhiteSpace($AllowedNamePattern)) {
        $fullPath = Assert-RevitMcpCleanupPath -Path $Path -Label $Label
    }
    else {
        $fullPath = Assert-RevitMcpCleanupPath -Path $Path -Label $Label -AllowedNamePattern $AllowedNamePattern
    }

    if (-not (Test-Path -LiteralPath $fullPath)) {
        return
    }

    if ($Recurse) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
    else {
        Remove-Item -LiteralPath $fullPath -Force
    }

    Write-Host "Removed ${Label}: $fullPath"
}

function Disable-LegacyAddinManifest {
    $legacyAddin = Join-Path $addinRoot "revit-mcp.addin"
    if (-not (Test-Path -LiteralPath $legacyAddin)) {
        return
    }

    $disabledAddin = Join-Path $addinRoot "revit-mcp.addin.disabled-self-contained"
    Assert-RevitMcpCleanupPath -Path $legacyAddin -Label "legacy Revit MCP addin manifest" | Out-Null
    Assert-RevitMcpCleanupPath -Path $disabledAddin -Label "disabled legacy Revit MCP addin manifest" | Out-Null

    if (Test-Path -LiteralPath $disabledAddin) {
        Remove-Item -LiteralPath $disabledAddin -Force
    }

    Move-Item -LiteralPath $legacyAddin -Destination $disabledAddin -Force
    Write-Host "Disabled legacy Revit MCP addin manifest: $legacyAddin"
}

function Get-RuntimeCleanupTargets {
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $targets = [System.Collections.Generic.List[string]]::new()

    foreach ($candidate in @($ServerTarget) + $defaultLegacyServerTargets + $LegacyServerTargets) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $normalized = Get-NormalizedPath -Path $candidate
        if ($seen.Add($normalized)) {
            $targets.Add($normalized)
        }
    }

    return $targets
}

function Test-RevitMcpRuntimeDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $true
    }

    if (Test-Path -LiteralPath (Join-Path $Path ".revit-mcp-self-contained-install")) {
        return $true
    }

    $packagePath = Join-Path $Path "package.json"
    if (-not ((Test-Path -LiteralPath $packagePath) -and
        (Test-Path -LiteralPath (Join-Path $Path "build\index.js")))) {
        return $false
    }

    try {
        $package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
        return $package.name -eq "revit-mcp" -and
            [string]$package.description -like "*self-contained Revit MCP*"
    }
    catch {
        return $false
    }
}

function Remove-StaleSkillBackups {
    if (-not (Test-Path -LiteralPath $codexSkillsRoot)) {
        return
    }

    Get-ChildItem -LiteralPath $codexSkillsRoot -Directory -Filter "revit-mcp.backup-*" -ErrorAction SilentlyContinue |
        ForEach-Object {
            Remove-RevitMcpPath -Path $_.FullName -Label "active skill backup directory" -Recurse
        }
}

function Invoke-RevitMcpCleanup {
    param(
        [switch]$ForUninstall
    )

    Remove-RevitMcpPath -Path (Join-Path $addinRoot "mcp-servers-for-revit.addin") -Label "Revit MCP addin manifest" -AllowedNamePattern "(?i)(^mcp[-_]servers?[-_]for[-_]revit\.addin$)"
    Remove-RevitMcpPath -Path (Join-Path $addinRoot "revit-mcp.addin.disabled-self-contained") -Label "disabled legacy Revit MCP addin manifest" -AllowedNamePattern "(?i)(^revit[-_]mcp\.addin(\.disabled-self-contained)?$)"
    Remove-RevitMcpPath -Path $pluginTarget -Label "Revit MCP addin payload directory" -Recurse
    Remove-RevitMcpPath -Path (Join-Path $env:LOCALAPPDATA "revit-mcp-plugin") -Label "Revit MCP LocalAppData command directory" -Recurse

    foreach ($target in Get-RuntimeCleanupTargets) {
        if (-not (Test-RevitMcpRuntimeDirectory -Path $target)) {
            Write-Warning "Skipping runtime cleanup because the directory does not look like a Revit MCP runtime install: $target"
            continue
        }

        Remove-RevitMcpPath -Path $target -Label "runtime MCP server directory" -Recurse
    }

    Remove-StaleSkillBackups

    if ($ForUninstall) {
        Remove-RevitMcpPath -Path $codexSkillTarget -Label "Codex Revit MCP skill directory" -Recurse
        if ($RemoveAgents) {
            Remove-RevitMcpPath -Path $codexAgentsTarget -Label "Codex global AGENTS.md" -AllowedNamePattern "(?i)(^AGENTS\.md$)"
            if (-not [string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
                Remove-RevitMcpPath -Path $WorkspaceAgentsTarget -Label "workspace AGENTS.md" -AllowedNamePattern "(?i)(^AGENTS\.md$)"
            }
        }
    }
    else {
        Disable-LegacyAddinManifest
    }
}

Invoke-RevitMcpCleanup -ForUninstall:$Uninstall

if ($Uninstall) {
    Write-Host "Self-contained Revit MCP bundle uninstalled for Revit $RevitVersion" -ForegroundColor Green
    Write-Host "Autodesk Revit program files and Windows system files were not touched."
    Write-Host "If MCP entries were registered in Codex, remove them with: codex mcp remove revit-mcp ; codex mcp remove revit-api-docs"
    return
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
Set-Content -LiteralPath (Join-Path $ServerTarget ".revit-mcp-self-contained-install") -Value ("Installed by revit-mcp-skill at " + (Get-Date).ToString("s")) -Encoding UTF8

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

$workspaceAgentsInstalled = $null
if (-not $SkipCodexSkillInstall) {
    New-Item -ItemType Directory -Path $codexSkillsRoot -Force | Out-Null

    if (Test-Path -LiteralPath $codexSkillTarget) {
        $backupStamp = Get-Date -Format "yyyyMMdd-HHmmss"
        New-Item -ItemType Directory -Path $codexSkillBackupsRoot -Force | Out-Null
        $skillBackup = Join-Path $codexSkillBackupsRoot "revit-mcp.backup-$backupStamp"
        Move-Item -LiteralPath $codexSkillTarget -Destination $skillBackup
    }

    New-Item -ItemType Directory -Path $codexSkillTarget -Force | Out-Null
    Get-ChildItem -LiteralPath $repoRoot -Force |
        Where-Object { $_.Name -notin @(".git", "node_modules") } |
        Copy-Item -Destination $codexSkillTarget -Recurse -Force
}

$agentsSource = Join-Path $repoRoot "AGENTS.md"
if (-not (Test-Path -LiteralPath $agentsSource)) {
    throw "Required AGENTS.md was not found: $agentsSource"
}

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

if (-not [string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
    $workspaceAgentsDir = Split-Path -Parent $WorkspaceAgentsTarget
    if (-not [string]::IsNullOrWhiteSpace($workspaceAgentsDir)) {
        New-Item -ItemType Directory -Path $workspaceAgentsDir -Force | Out-Null
    }

    if (Test-Path -LiteralPath $WorkspaceAgentsTarget) {
        $existingWorkspaceAgents = Get-Item -LiteralPath $WorkspaceAgentsTarget
        if ($existingWorkspaceAgents.Length -gt 0) {
            $workspaceAgentsBackup = $WorkspaceAgentsTarget + ".backup-" + (Get-Date -Format "yyyyMMdd-HHmmss")
            Copy-Item -LiteralPath $WorkspaceAgentsTarget -Destination $workspaceAgentsBackup -Force
        }
    }

    Copy-Item -LiteralPath $agentsSource -Destination $WorkspaceAgentsTarget -Force
    $workspaceAgentsInstalled = $WorkspaceAgentsTarget
}

Write-Host "Self-contained Revit MCP bundle installed for Revit $RevitVersion" -ForegroundColor Green
Write-Host "Plugin path: $addinRoot"
Write-Host "Runtime server path: $ServerTarget"
Write-Host "Required docs server path: $docsServerSource"
if (-not $SkipCodexSkillInstall) {
    Write-Host "Codex skill path: $codexSkillTarget"
}
Write-Host "Codex global AGENTS.md: $codexAgentsTarget"
if ($workspaceAgentsInstalled) {
    Write-Host "Workspace AGENTS.md: $workspaceAgentsInstalled"
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
