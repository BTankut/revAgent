param(
    [ValidateSet("2022", "2023", "2024", "2025")]
    [string]$RevitVersion = "2022",
    [string]$InstallRoot = "",
    [string]$ServerTarget = "",
    [string]$RevitInstallRoot = "",
    [string]$AllUsersAddinRoot = "",
    [string[]]$LegacyServerTargets = @(),
    [string]$WorkspaceAgentsTarget = "",
    [ValidateSet("", "managed-user-pack", "preserve-local")]
    [string]$CodexInstructionPolicy = "",
    [switch]$SkipCodexSkillInstall,
    [switch]$SkipCodexUserIntegration,
    [switch]$SkipLegacyCleanup,
    [switch]$SkipRevitPayloadInstall,
    [switch]$SkipRuntimePayloadInstall,
    [switch]$SuppressNextSteps,
    [switch]$Uninstall,
    [switch]$RemoveAgents
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$installerLibRoot = Join-Path $PSScriptRoot "lib"
Import-Module (Join-Path $installerLibRoot "RevAgent.HiddenLauncher.psm1") -Force
Import-Module (Join-Path $installerLibRoot "RevAgent.ScheduledTask.psm1") -Force
Import-Module (Join-Path $installerLibRoot "RevAgent.RevitVersions.psm1") -Force
Import-Module (Join-Path $installerLibRoot "RevAgent.Permissions.psm1") -Force
Import-Module (Join-Path $installerLibRoot "RevAgent.LogRetention.psm1") -Force
Import-Module (Join-Path $installerLibRoot "RevAgent.CodexRegistration.psm1") -Force
Import-Module (Join-Path $installerLibRoot "RevAgent.ConfigSync.psm1") -Force
Import-Module (Join-Path $installerLibRoot "RevAgent.DesktopLauncherCleanup.psm1") -Force
Set-RevAgentCurrentProcessUtf8Console | Out-Null

$repoRoot = Split-Path -Parent $PSScriptRoot
$revitVersionConfig = Get-RevAgentVersionConfig -Version $RevitVersion -RepoRoot $repoRoot
if (-not $Uninstall) {
    Assert-RevAgentInstallerPayloadAvailable -Version $RevitVersion -RepoRoot $repoRoot
}
$pluginSource = Join-Path $PSScriptRoot "revit-plugin"
$serverSource = Join-Path $PSScriptRoot "runtime-mcp-server"
$docsServerSource = Join-Path $PSScriptRoot "revit-api-docs-mcp"
$codexUserSourceRoot = Join-Path $PSScriptRoot "codex-user"
if (-not (Test-Path -LiteralPath (Join-Path $codexUserSourceRoot "SKILL.md") -PathType Leaf)) {
    $codexUserSourceRoot = $repoRoot
}
$programDataRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { "C:\ProgramData" } else { $env:ProgramData }
$defaultInstallRoot = Join-Path $programDataRoot "DPE\revAgent"
$legacyInstallRoot = Join-Path $programDataRoot "DPE\RevitMCP"
$legacyUpdaterConfigPath = Join-Path $legacyInstallRoot "updater\updater-config.json"
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = $defaultInstallRoot
}
if ([string]::IsNullOrWhiteSpace($ServerTarget)) {
    $ServerTarget = Join-Path $InstallRoot "runtime"
}
if ([string]::IsNullOrWhiteSpace($AllUsersAddinRoot)) {
    $AllUsersAddinRoot = Join-Path $programDataRoot "Autodesk\Revit\Addins\$RevitVersion"
}
$addinRoot = $AllUsersAddinRoot
$legacyUserAddinRoot = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$RevitVersion"
$pluginRoot = Join-Path $InstallRoot "revit-plugin"
$pluginFolderName = "revAgentPlugin"
$legacyPluginFolderName = "revit_mcp_plugin"
$pluginTarget = Join-Path $pluginRoot $pluginFolderName
$legacyPluginTarget = Join-Path $pluginRoot $legacyPluginFolderName
$addinManifestFileName = "revAgent.addin"
$legacyAddinManifestFileName = "mcp-servers-for-revit.addin"
$pluginDllFileName = "revAgentPlugin.dll"
$commandSetDllFileName = "revAgentCommandSet.dll"
$commandSetRoot = Join-Path $InstallRoot "commands\CommandSet"
$pluginCommandSetFolderName = "revAgentCommandSet"
$stateRoot = Join-Path $InstallRoot "state"
$updaterRoot = Join-Path $InstallRoot "updater"
$updaterConfigPath = Join-Path $updaterRoot "updater-config.json"
$codexMachineRoot = Join-Path $InstallRoot "codex"
$codexMachineSkillsRoot = Join-Path $codexMachineRoot "skills"
$codexSkillName = "revAgent"
$legacyCodexSkillName = "revit-mcp"
$codexMachineSkillTarget = Join-Path $codexMachineSkillsRoot $codexSkillName
$legacyCodexMachineSkillTarget = Join-Path $codexMachineSkillsRoot $legacyCodexSkillName
$legacyInstallRootMachineSkillTarget = Join-Path $legacyInstallRoot "codex\skills\$legacyCodexSkillName"
$codexMachineAgentsTarget = Join-Path $codexMachineRoot "AGENTS.md"
$codexRoot = Join-Path $env:USERPROFILE ".codex"
$codexSkillsRoot = Join-Path $codexRoot "skills"
$codexSkillTarget = Join-Path $codexSkillsRoot $codexSkillName
$legacyCodexSkillTarget = Join-Path $codexSkillsRoot $legacyCodexSkillName
$codexAgentsTarget = Join-Path $codexRoot "AGENTS.md"
$codexConfigTarget = Join-Path $codexRoot "config.toml"
$defaultLegacyServerTargets = @(
    "C:\Projects\revit-mcp",
    "C:\Projects\revit-mcp-server",
    "C:\Projects\mcp-server-for-revit",
    "C:\Projects\mcp-servers-for-revit"
)

function Resolve-CodexInstructionPolicy {
    param(
        [string]$RequestedPolicy,
        [string[]]$ConfigPaths
    )

    $policy = $RequestedPolicy
    foreach ($configPath in @($ConfigPaths)) {
        if (-not [string]::IsNullOrWhiteSpace($policy)) {
            break
        }
        if ([string]::IsNullOrWhiteSpace($configPath) -or -not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
            continue
        }
        try {
            $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
            if ($config.codexInstructionPolicy) {
                $policy = [string]$config.codexInstructionPolicy
            }
        }
        catch {}
    }
    if ([string]::IsNullOrWhiteSpace($policy) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_CODEX_INSTRUCTION_POLICY)) {
        $policy = [string]$env:REVIT_MCP_CODEX_INSTRUCTION_POLICY
    }
    if ([string]::IsNullOrWhiteSpace($policy)) {
        $policy = "managed-user-pack"
    }

    $normalized = $policy.Trim().ToLowerInvariant()
    if ($normalized -notin @("managed-user-pack", "preserve-local")) {
        throw "Unsupported CodexInstructionPolicy '$policy'. Use managed-user-pack or preserve-local."
    }

    return $normalized
}

$CodexInstructionPolicy = Resolve-CodexInstructionPolicy -RequestedPolicy $CodexInstructionPolicy -ConfigPaths @($updaterConfigPath, $legacyUpdaterConfigPath)
$preserveLocalCodexInstructions = [string]::Equals($CodexInstructionPolicy, "preserve-local", [System.StringComparison]::OrdinalIgnoreCase)

$runningRevit = Get-Process -Name "Revit" -ErrorAction SilentlyContinue
if ($runningRevit -and -not $SkipRevitPayloadInstall) {
    throw "Close Revit before running install-self-contained.ps1. The installer replaces files under $addinRoot and cannot do that safely while Revit is running."
}
elseif ($runningRevit) {
    Write-Warning "Revit is running; Revit add-in and command payload files will be left untouched."
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

function Resolve-ExistingDirectoryFromCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$Candidates,
        [switch]$Required
    )

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (-not [System.IO.Path]::IsPathRooted($expanded)) { continue }
        $full = [System.IO.Path]::GetFullPath($expanded).TrimEnd("\")
        if (-not $seen.Add($full)) { continue }
        if (Test-Path -LiteralPath $full -PathType Container) {
            Write-Host "$Label found: $full"
            return $full
        }
    }

    $message = "$Label could not be found. Checked: " + (($seen.ToArray()) -join "; ")
    if ($Required) {
        throw $message
    }

    Write-Warning $message
    return $null
}

function Get-RevitRegistryInstallCandidates {
    param([string]$Version)

    $candidates = [System.Collections.Generic.List[string]]::new()
    $registryRoots = @(
        "HKLM:\SOFTWARE\Autodesk\Revit\$Version",
        "HKLM:\SOFTWARE\Autodesk\Revit\Autodesk Revit $Version",
        "HKLM:\SOFTWARE\WOW6432Node\Autodesk\Revit\$Version",
        "HKLM:\SOFTWARE\WOW6432Node\Autodesk\Revit\Autodesk Revit $Version"
    )

    foreach ($root in $registryRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        try {
            $item = Get-ItemProperty -LiteralPath $root -ErrorAction Stop
            foreach ($name in @("InstallationLocation", "InstallLocation", "InstallDir", "ProductInstallPath")) {
                if ($item.PSObject.Properties.Name -contains $name) {
                    $value = [string]$item.$name
                    if (-not [string]::IsNullOrWhiteSpace($value)) {
                        $candidates.Add($value)
                    }
                }
            }
        }
        catch {}
    }

    return $candidates.ToArray()
}

function Resolve-RevitInstallRoot {
    param(
        [string]$RequestedRoot,
        [string]$Version
    )

    return Resolve-RevAgentInstallRoot -RequestedRoot $RequestedRoot -Version $Version -RepoRoot $repoRoot -RequireXmlDocs
}

function Write-AddinManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$AssemblyPath
    )

    $escapedAssembly = [System.Security.SecurityElement]::Escape($AssemblyPath)
    $content = @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>revAgent</Name>
    <Assembly>$escapedAssembly</Assembly>
    <FullClassName>revit_mcp_plugin.Core.Application</FullClassName>
    <ClientId>090A4C8C-61DC-426D-87DF-E4BAE0F80EC1</ClientId>
    <VendorId>DPE</VendorId>
    <VendorDescription>DPE internal revAgent add-in</VendorDescription>
  </AddIn>
</RevitAddIns>
"@

    Set-Content -LiteralPath $Path -Value $content -Encoding UTF8
}

function New-ReparsePointOrCopyDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if (Test-Path -LiteralPath $Destination) {
        Remove-RevAgentPath -Path $Destination -Label "Codex skill integration directory" -Recurse
    }

    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null

    try {
        New-Item -ItemType Junction -Path $Destination -Target $Source -Force | Out-Null
        Write-Host "Linked Codex skill to machine install: $Destination -> $Source"
    }
    catch {
        Write-Warning "Could not create Codex skill junction; copying instead. $($_.Exception.Message)"
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        Get-ChildItem -LiteralPath $Source -Force |
            Copy-Item -Destination $Destination -Recurse -Force
    }
}

function New-HardLinkOrCopyFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if (Test-Path -LiteralPath $Destination) {
        Remove-RevAgentPath -Path $Destination -Label "Codex AGENTS.md integration file" -AllowedNamePattern "(?i)(^AGENTS\.md$)"
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    try {
        New-Item -ItemType HardLink -Path $Destination -Target $Source -Force | Out-Null
        Write-Host "Linked Codex AGENTS.md to machine install: $Destination -> $Source"
    }
    catch {
        Write-Warning "Could not create AGENTS.md hard link; copying instead. $($_.Exception.Message)"
        Copy-Item -LiteralPath $Source -Destination $Destination -Force
    }
}

function Copy-RevAgentFilePayload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Required user-pack file was not found: $Source"
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-RevAgentDirectoryPayload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Required user-pack directory was not found: $Source"
    }

    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Copy-RevAgentRuntimeUserPayload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRoot,
        [Parameter(Mandatory = $true)]
        [string]$DestinationRoot
    )

    Copy-RevAgentDirectoryPayload -Source (Join-Path $SourceRoot "build") -Destination (Join-Path $DestinationRoot "build")
    foreach ($fileName in @("package.json", "package-lock.json")) {
        Copy-RevAgentFilePayload -Source (Join-Path $SourceRoot $fileName) -Destination (Join-Path $DestinationRoot $fileName)
    }
}

function Copy-RevAgentManagedUpdaterToolFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [bool]$Required = $true
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        return
    }

    try {
        Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
        return
    }
    catch {
        $copyError = $_.Exception.Message
        if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
            if ($Required) {
                throw
            }
            Write-Warning "Could not refresh optional updater tool '$Destination'. Copy error: $copyError"
            return
        }
        try {
            Remove-Item -LiteralPath $Destination -Force -ErrorAction Stop
            Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
            Write-Warning "Replaced updater tool after removing stale destination ACL: $Destination"
        }
        catch {
            $message = "Could not refresh updater tool '$Destination'. Initial copy error: $copyError; replace error: $($_.Exception.Message)"
            if ($Required) {
                throw $message
            }
            Write-Warning $message
        }
    }
}

function Install-UpdaterToolsFromPackage {
    param(
        [string]$SourceRoot,
        [string]$DestinationRoot,
        [string]$ConfigPath
    )

    if ([string]::IsNullOrWhiteSpace($SourceRoot) -or
        -not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
        return
    }

    New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
    foreach ($toolName in @("update-from-nas.ps1", "show-installed-version.ps1", "install-updater-task.ps1", "migrate-source-free-install.ps1")) {
        $source = Join-Path $SourceRoot $toolName
        Copy-RevAgentManagedUpdaterToolFile -Source $source -Destination (Join-Path $DestinationRoot $toolName) -Required:($toolName -ne "migrate-source-free-install.ps1")
    }
    $libSource = Join-Path (Split-Path -Parent $SourceRoot) "lib"
    if (Test-Path -LiteralPath $libSource -PathType Container) {
        $libDestination = Join-Path $DestinationRoot "lib"
        if (Test-Path -LiteralPath $libDestination) {
            Remove-Item -LiteralPath $libDestination -Recurse -Force
        }
        Copy-Item -LiteralPath $libSource -Destination $libDestination -Recurse -Force
    }
    $configSource = Join-Path (Split-Path -Parent $SourceRoot) "config"
    if (-not (Test-Path -LiteralPath $configSource -PathType Container)) {
        $configSource = Join-Path (Split-Path -Parent (Split-Path -Parent $SourceRoot)) "config"
    }
    Sync-RevAgentUpdaterConfigDirectory -SourceRoot $configSource -DestinationRoot (Join-Path $DestinationRoot "config")

    $updaterPath = Join-Path $DestinationRoot "update-from-nas.ps1"
    $versionToolPath = Join-Path $DestinationRoot "show-installed-version.ps1"
    if (Test-Path -LiteralPath $updaterPath -PathType Leaf) {
        @(
            "@echo off",
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$updaterPath`" -ConfigPath `"$ConfigPath`" -NoNotifyUser -AllowManualCodexSetup -OperationMethod manual-update",
            "pause"
        ) | Set-Content -LiteralPath (Join-Path $DestinationRoot "Update-revAgent-Now.cmd") -Encoding ASCII
    }
    if (Test-Path -LiteralPath $versionToolPath -PathType Leaf) {
        @(
            "@echo off",
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$versionToolPath`" -ConfigPath `"$ConfigPath`"",
            "pause"
        ) | Set-Content -LiteralPath (Join-Path $DestinationRoot "Show-revAgent-Version.cmd") -Encoding ASCII
    }
    foreach ($legacyCommandName in @("Update-Revit-MCP-Now.cmd", "Show-Revit-MCP-Version.cmd")) {
        $legacyCommandPath = Join-Path $DestinationRoot $legacyCommandName
        if (Test-Path -LiteralPath $legacyCommandPath -PathType Leaf) {
            Remove-Item -LiteralPath $legacyCommandPath -Force
            Write-Host "Removed legacy updater helper: $legacyCommandPath"
        }
    }
    foreach ($legacyLauncherPath in @(Get-RevAgentLegacyHiddenUpdaterLauncherPaths -ConfigPath $ConfigPath)) {
        if (Test-Path -LiteralPath $legacyLauncherPath -PathType Leaf) {
            Remove-Item -LiteralPath $legacyLauncherPath -Force
            Write-Host "Removed legacy hidden updater launcher: $legacyLauncherPath"
        }
    }

    Write-Host "Updater tools refreshed: $DestinationRoot"
}

function Repair-RevAgentScheduledTaskAction {
    param(
        [string]$ConfigPath,
        [string]$UpdaterPath
    )

    $taskName = "revAgent Auto Update"
    $dailyAt = "12:00"
    $configCandidates = @($ConfigPath, $legacyUpdaterConfigPath)
    foreach ($configCandidate in $configCandidates) {
        if ([string]::IsNullOrWhiteSpace($configCandidate) -or -not (Test-Path -LiteralPath $configCandidate -PathType Leaf)) {
            continue
        }
        try {
            $config = Get-Content -Raw -LiteralPath $configCandidate | ConvertFrom-Json
        }
        catch {
            continue
        }
        if ($config.taskName) {
            $taskName = [string]$config.taskName
        }
        if ([string]::Equals($taskName, "Revit MCP Auto Update", [System.StringComparison]::OrdinalIgnoreCase)) {
            $taskName = "revAgent Auto Update"
        }
        if ($config.dailyAt) {
            $dailyAt = [string]$config.dailyAt
        }
        break
    }

    Repair-RevAgentHiddenScheduledTaskAction -Name $taskName -LegacyNames @("Revit MCP Auto Update") -UpdaterPath $UpdaterPath -UpdaterConfigPath $ConfigPath -DailyAt $dailyAt
}

if ($Uninstall -and [string]::IsNullOrWhiteSpace($RevitInstallRoot)) {
    $revitInstallRoot = ""
}
else {
    $revitInstallRoot = Resolve-RevitInstallRoot -RequestedRoot $RevitInstallRoot -Version $RevitVersion
}

function Assert-RevAgentCleanupPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [string]$AllowedNamePattern = "(?i)(^revAgent$|^revAgentPlugin$|^revAgent\.addin$|^revAgentCommandSet(\.dll)?$|^revit[-_]mcp($|[-_.])|^revit_mcp_plugin$|^mcp[-_]servers?[-_]for[-_]revit|^mcp-server-for-revit|^RevitMCP|^runtime$|^package$|^updater$|^state$|^revit-plugin$|^codex$|^AGENTS\.md$)",
        [switch]$AllowBroadTarget
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
        (Get-NormalizedPath -Path $programDataRoot),
        (Get-NormalizedPath -Path (Join-Path $programDataRoot "Autodesk")),
        (Get-NormalizedPath -Path (Join-Path $programDataRoot "Autodesk\Revit")),
        (Get-NormalizedPath -Path (Join-Path $programDataRoot "Autodesk\Revit\Addins")),
        (Get-NormalizedPath -Path (Join-Path $env:APPDATA "Autodesk")),
        (Get-NormalizedPath -Path (Join-Path $env:APPDATA "Autodesk\Revit")),
        (Get-NormalizedPath -Path $addinRoot),
        (Get-NormalizedPath -Path $InstallRoot),
        (Get-NormalizedPath -Path $legacyInstallRoot),
        (Get-NormalizedPath -Path $codexRoot),
        (Get-NormalizedPath -Path $codexSkillsRoot),
        (Get-NormalizedPath -Path (Split-Path -Parent $ServerTarget))
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    foreach ($blocked in $blockedRoots) {
        if ((-not $AllowBroadTarget) -and [string]::Equals($fullPath, $blocked, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clean $Label because the target is too broad: $fullPath"
        }
    }

    if ($leaf -notmatch $AllowedNamePattern) {
        throw "Refusing to clean $Label because it is not a known revAgent managed path: $fullPath"
    }

    return $fullPath
}

function Remove-RevAgentPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [switch]$Recurse,
        [string]$AllowedNamePattern,
        [switch]$AllowBroadTarget
    )

    if ([string]::IsNullOrWhiteSpace($AllowedNamePattern)) {
        $fullPath = Assert-RevAgentCleanupPath -Path $Path -Label $Label -AllowBroadTarget:$AllowBroadTarget
    }
    else {
        $fullPath = Assert-RevAgentCleanupPath -Path $Path -Label $Label -AllowedNamePattern $AllowedNamePattern -AllowBroadTarget:$AllowBroadTarget
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

function Test-RevAgentPathInside {
    param(
        [string]$ChildPath,
        [string]$ParentPath
    )

    if ([string]::IsNullOrWhiteSpace($ChildPath) -or [string]::IsNullOrWhiteSpace($ParentPath)) {
        return $false
    }

    try {
        $child = Get-NormalizedPath -Path $ChildPath
        $parent = (Get-NormalizedPath -Path $ParentPath).TrimEnd("\")
        return $child.StartsWith($parent + "\", [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($child, $parent, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch {
        return $false
    }
}

function Remove-LegacyRevitMcpInstallRoot {
    if ($SkipLegacyCleanup) {
        return
    }

    if ([string]::Equals((Get-NormalizedPath -Path $InstallRoot), (Get-NormalizedPath -Path $legacyInstallRoot), [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }
    if (-not (Test-Path -LiteralPath $legacyInstallRoot -PathType Container)) {
        return
    }

    $activePaths = @(
        $PSScriptRoot,
        $PSCommandPath,
        $env:REVIT_MCP_LOG_PATH
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    foreach ($activePath in $activePaths) {
        if (Test-RevAgentPathInside -ChildPath $activePath -ParentPath $legacyInstallRoot) {
            Write-Warning "Legacy RevitMCP install root cleanup skipped because the current process is still using it: $legacyInstallRoot"
            return
        }
    }
    try {
        $currentProcess = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId={0}" -f $PID) -ErrorAction Stop
        $commandLine = [string]$currentProcess.CommandLine
        if ($commandLine.IndexOf($legacyInstallRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Write-Warning "Legacy RevitMCP install root cleanup skipped because the current PowerShell command line still references it: $legacyInstallRoot"
            return
        }
    }
    catch {}

    Remove-RevAgentPath -Path $legacyInstallRoot -Label "legacy RevitMCP install root" -Recurse -AllowedNamePattern "(?i)^RevitMCP$" -AllowBroadTarget
}

function Disable-LegacyAddinManifest {
    param(
        [string]$Root = $addinRoot
    )

    $legacyAddin = Join-Path $Root "revit-mcp.addin"
    if (-not (Test-Path -LiteralPath $legacyAddin)) {
        return
    }

    $disabledAddin = Join-Path $Root "revit-mcp.addin.disabled-self-contained"
    Assert-RevAgentCleanupPath -Path $legacyAddin -Label "legacy revAgent add-in manifest" | Out-Null
    Assert-RevAgentCleanupPath -Path $disabledAddin -Label "disabled legacy revAgent add-in manifest" | Out-Null

    if (Test-Path -LiteralPath $disabledAddin) {
        Remove-Item -LiteralPath $disabledAddin -Force
    }

    Move-Item -LiteralPath $legacyAddin -Destination $disabledAddin -Force
    Write-Host "Disabled legacy revAgent add-in manifest: $legacyAddin"
}

function Get-RuntimeCleanupTargets {
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $targets = [System.Collections.Generic.List[string]]::new()

    $candidates = @($ServerTarget)
    if (-not $SkipLegacyCleanup) {
        $candidates += $defaultLegacyServerTargets
    }
    $candidates += $LegacyServerTargets

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $normalized = Get-NormalizedPath -Path $candidate
        if ($seen.Add($normalized)) {
            $targets.Add($normalized)
        }
    }

    return $targets
}

function Test-RevAgentRuntimeDirectory {
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
            [string]$package.description -like "*self-contained revAgent*"
    }
    catch {
        return $false
    }
}

function Remove-CodexProfileBackupArtifacts {
    if (-not (Test-Path -LiteralPath $codexRoot)) {
        return
    }

    $removed = 0
    foreach ($pattern in @("AGENTS.md.backup-*", "config.toml.backup-*")) {
        Get-ChildItem -LiteralPath $codexRoot -File -Filter $pattern -ErrorAction SilentlyContinue |
            ForEach-Object {
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
                $removed++
            }
    }

    if (Test-Path -LiteralPath $codexSkillsRoot) {
        Get-ChildItem -LiteralPath $codexSkillsRoot -Directory -Filter "revit-mcp.backup-*" -ErrorAction SilentlyContinue |
            ForEach-Object {
                Remove-RevAgentPath -Path $_.FullName -Label "active skill backup directory" -Recurse
                $removed++
            }
    }

    $legacySkillBackupsRoot = Join-Path $codexRoot "skill-backups"
    if (Test-Path -LiteralPath $legacySkillBackupsRoot) {
        Remove-RevAgentPath -Path $legacySkillBackupsRoot -Label "legacy Codex skill backup root" -Recurse -AllowedNamePattern "(?i)(^skill-backups$)"
        $removed++
    }

    if ($removed -gt 0) {
        Write-Host ("Codex cleanup   : removed {0} old backup artifact(s)" -f $removed) -ForegroundColor Green
    }
}

function Remove-RevAgentManagedSourceLeakArtifacts {
    function Get-RevAgentPathParts {
        param([string]$Path)

        if ([string]::IsNullOrWhiteSpace($Path)) {
            return @()
        }

        return @($Path -split '[\\/]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }

    function Get-RevAgentRelativeManagedPath {
        param(
            [Parameter(Mandatory = $true)]
            [string]$Root,
            [Parameter(Mandatory = $true)]
            [string]$Path
        )

        $normalizedRoot = Get-NormalizedPath -Path $Root
        $normalizedPath = Get-NormalizedPath -Path $Path
        if ($normalizedPath.Length -le $normalizedRoot.Length) {
            return ""
        }

        return $normalizedPath.Substring($normalizedRoot.Length).TrimStart([char[]]@('\', '/'))
    }

    function Test-RevAgentIgnoredManagedPath {
        param([string]$RelativePath)

        foreach ($part in Get-RevAgentPathParts -Path $RelativePath) {
            if ($part -ieq "node_modules" -or $part -ieq "dependencies") {
                return $true
            }
        }

        return $false
    }

    function Test-RevAgentAllowedManagedDirectory {
        param(
            [Parameter(Mandatory = $true)]
            [string]$Root,
            [Parameter(Mandatory = $true)]
            [System.IO.DirectoryInfo]$Directory
        )

        $relative = Get-RevAgentRelativeManagedPath -Root $Root -Path $Directory.FullName
        $parts = Get-RevAgentPathParts -Path $relative
        return (
            $parts.Count -eq 3 -and
            $parts[0] -ieq "installer" -and
            $parts[1] -ieq "revit-api-docs-mcp" -and
            $parts[2] -ieq "scripts"
        )
    }

    $sourceLeakDirectoryNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @("src", "docs", "references", "evals", "dashboard", "addons", "scripts", ".github", ".githooks", ".tmp")) {
        [void]$sourceLeakDirectoryNames.Add($name)
    }
    $sourceLeakNamePattern = "(?i)(^src$|^docs$|^references$|^evals$|^dashboard$|^addons$|^scripts$|^\.github$|^\.githooks$|^\.tmp$)"
    $managedRoots = [System.Collections.Generic.List[string]]::new()

    foreach ($root in @(
            (Join-Path $InstallRoot "package")
        )) {
        if (-not [string]::IsNullOrWhiteSpace($root)) {
            $managedRoots.Add($root)
        }
    }

    if ($preserveLocalCodexInstructions) {
        Write-Host "Source cleanup  : Codex instruction roots skipped by preserve-local policy." -ForegroundColor Yellow
    }
    else {
        if (-not [string]::IsNullOrWhiteSpace($codexMachineSkillTarget)) {
            $managedRoots.Add($codexMachineSkillTarget)
        }
        if (-not $SkipCodexUserIntegration) {
            if (-not [string]::IsNullOrWhiteSpace($codexSkillTarget)) {
                $managedRoots.Add($codexSkillTarget)
            }
        }
    }

    if (-not $SkipRuntimePayloadInstall -and -not [string]::IsNullOrWhiteSpace($ServerTarget)) {
        if (Test-RevAgentRuntimeDirectory -Path $ServerTarget) {
            $managedRoots.Add($ServerTarget)
        }
        else {
            Write-Warning "Skipping runtime source cleanup because the directory does not look like a revAgent runtime install: $ServerTarget"
        }
    }

    $backupRoot = Join-Path $updaterRoot "backups"
    if (Test-Path -LiteralPath $backupRoot -PathType Container) {
        Get-ChildItem -LiteralPath $backupRoot -Directory -Filter "revit-mcp-skill.backup-*" -ErrorAction SilentlyContinue |
            ForEach-Object { $managedRoots.Add($_.FullName) }
    }

    $removed = 0
    foreach ($root in $managedRoots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }

        Get-ChildItem -LiteralPath $root -Recurse -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object {
                $relative = Get-RevAgentRelativeManagedPath -Root $root -Path $_.FullName
                $sourceLeakDirectoryNames.Contains($_.Name) -and
                -not (Test-RevAgentIgnoredManagedPath -RelativePath $relative) -and
                -not (Test-RevAgentAllowedManagedDirectory -Root $root -Directory $_)
            } |
            Sort-Object { $_.FullName.Length } -Descending |
            ForEach-Object {
                $artifactPath = $_.FullName
                try {
                    Remove-RevAgentPath -Path $artifactPath -Label "managed source/developer artifact directory" -Recurse -AllowedNamePattern $sourceLeakNamePattern
                    $removed++
                }
                catch {
                    Write-Warning "Could not remove managed source/developer artifact directory '$artifactPath': $($_.Exception.Message)"
                }
            }

        Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object {
                $relative = Get-RevAgentRelativeManagedPath -Root $root -Path $_.FullName
                $_.Extension -in @(".cs", ".csproj", ".sln", ".ts", ".tsx", ".pdb", ".map") -and
                -not (Test-RevAgentIgnoredManagedPath -RelativePath $relative)
            } |
            ForEach-Object {
                $artifactPath = $_.FullName
                try {
                    Remove-Item -LiteralPath $artifactPath -Force -ErrorAction Stop
                    $removed++
                }
                catch {
                    Write-Warning "Could not remove managed source/developer artifact file '$artifactPath': $($_.Exception.Message)"
                }
            }
    }

    if ($removed -gt 0) {
        Write-Host ("Source cleanup  : removed {0} managed source/developer artifact item(s)" -f $removed) -ForegroundColor Green
    }
}

function Repair-RevAgentManagedInstallPermissions {
    param([switch]$IncludeExistingPayloadTrees)

    $targets = Get-RevAgentManagedPermissionTargets `
        -InstallRoot $InstallRoot `
        -WorkRoot $updaterRoot `
        -PackageTarget (Join-Path $InstallRoot "package") `
        -ServerTarget $ServerTarget `
        -AllUsersAddinRoot $addinRoot `
        -RevitVersion $RevitVersion `
        -IncludeExistingPayloadTrees:$IncludeExistingPayloadTrees
    Invoke-RevAgentManagedPermissionRepair -Targets $targets
}

function Invoke-RevAgentCleanup {
    param(
        [switch]$ForUninstall
    )

    if (-not $SkipRevitPayloadInstall) {
        Remove-RevAgentPath -Path (Join-Path $addinRoot $addinManifestFileName) -Label "revAgent add-in manifest" -AllowedNamePattern "(?i)(^revAgent\.addin$)"
        Remove-RevAgentPath -Path (Join-Path $addinRoot $legacyAddinManifestFileName) -Label "legacy revAgent add-in manifest" -AllowedNamePattern "(?i)(^mcp[-_]servers?[-_]for[-_]revit\.addin$)"
        Remove-RevAgentPath -Path (Join-Path $addinRoot "revit-mcp.addin.disabled-self-contained") -Label "disabled legacy revAgent add-in manifest" -AllowedNamePattern "(?i)(^revit[-_]mcp\.addin(\.disabled-self-contained)?$)"
        if (-not $SkipLegacyCleanup) {
            Remove-RevAgentPath -Path (Join-Path $legacyUserAddinRoot $addinManifestFileName) -Label "legacy user revAgent add-in manifest" -AllowedNamePattern "(?i)(^revAgent\.addin$)"
            Remove-RevAgentPath -Path (Join-Path $legacyUserAddinRoot $legacyAddinManifestFileName) -Label "legacy user revAgent add-in manifest" -AllowedNamePattern "(?i)(^mcp[-_]servers?[-_]for[-_]revit\.addin$)"
            Remove-RevAgentPath -Path (Join-Path $legacyUserAddinRoot "revit-mcp.addin.disabled-self-contained") -Label "disabled legacy user revAgent add-in manifest" -AllowedNamePattern "(?i)(^revit[-_]mcp\.addin(\.disabled-self-contained)?$)"
            Remove-RevAgentPath -Path (Join-Path $legacyUserAddinRoot $pluginFolderName) -Label "legacy user revAgent add-in payload directory" -Recurse
            Remove-RevAgentPath -Path (Join-Path $legacyUserAddinRoot $legacyPluginFolderName) -Label "legacy user revAgent add-in payload directory" -Recurse
        }
        Remove-RevAgentPath -Path $pluginTarget -Label "revAgent add-in payload directory" -Recurse
        Remove-RevAgentPath -Path $legacyPluginTarget -Label "legacy revAgent add-in payload directory" -Recurse
        Remove-RevAgentPath -Path $commandSetRoot -Label "revAgent machine command directory" -Recurse -AllowedNamePattern "(?i)(^CommandSet$)"
        if (-not $SkipLegacyCleanup) {
            Remove-RevAgentPath -Path (Join-Path $env:LOCALAPPDATA "revit-mcp-plugin") -Label "revAgent LocalAppData command directory" -Recurse
        }
    }
    else {
        Write-Host "Revit add-in cleanup skipped; existing Revit files were left untouched." -ForegroundColor Yellow
    }

    if (-not $SkipRuntimePayloadInstall) {
        foreach ($target in Get-RuntimeCleanupTargets) {
            if (-not (Test-RevAgentRuntimeDirectory -Path $target)) {
                Write-Warning "Skipping runtime cleanup because the directory does not look like a revAgent runtime install: $target"
                continue
            }

            Remove-RevAgentPath -Path $target -Label "runtime MCP server directory" -Recurse
        }
    }
    else {
        Write-Host "Runtime payload cleanup skipped; existing runtime files were left untouched." -ForegroundColor Yellow
    }

    if (-not $SkipCodexUserIntegration) {
        Remove-CodexProfileBackupArtifacts
    }

    if ($ForUninstall) {
        Remove-RevAgentPath -Path $codexSkillTarget -Label "Codex revAgent skill directory" -Recurse
        Remove-RevAgentPath -Path $legacyCodexSkillTarget -Label "legacy Codex revAgent skill directory" -Recurse
        Remove-RevAgentPath -Path $codexMachineSkillTarget -Label "machine Codex revAgent skill directory" -Recurse
        Remove-RevAgentPath -Path $legacyCodexMachineSkillTarget -Label "legacy machine Codex revAgent skill directory" -Recurse
        Remove-RevAgentPath -Path $legacyInstallRootMachineSkillTarget -Label "legacy install-root Codex skill directory" -Recurse
        if ($RemoveAgents) {
            Remove-RevAgentPath -Path $codexAgentsTarget -Label "Codex global AGENTS.md" -AllowedNamePattern "(?i)(^AGENTS\.md$)"
            Remove-RevAgentPath -Path $codexMachineAgentsTarget -Label "machine AGENTS.md" -AllowedNamePattern "(?i)(^AGENTS\.md$)"
            if (-not [string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
                Remove-RevAgentPath -Path $WorkspaceAgentsTarget -Label "workspace AGENTS.md" -AllowedNamePattern "(?i)(^AGENTS\.md$)"
            }
        }
    }
    elseif (-not $SkipRevitPayloadInstall) {
        Disable-LegacyAddinManifest -Root $addinRoot
        if (-not $SkipLegacyCleanup) {
            Disable-LegacyAddinManifest -Root $legacyUserAddinRoot
        }
    }
}

Repair-RevAgentManagedInstallPermissions -IncludeExistingPayloadTrees:((-not $SkipRevitPayloadInstall) -and (-not $SkipRuntimePayloadInstall))
Invoke-RevAgentCleanup -ForUninstall:$Uninstall

if ($Uninstall) {
    Write-Host "Self-contained revAgent bundle uninstalled for Revit $RevitVersion" -ForegroundColor Green
    Write-Host "Autodesk Revit program files and Windows system files were not touched."
    Write-Host "If revAgent entries were registered in Codex, remove them with: codex mcp remove revAgent ; codex mcp remove revAgent-api-docs"
    return
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
New-Item -ItemType Directory -Path $ServerTarget -Force | Out-Null

if (-not $SkipRevitPayloadInstall) {
    New-Item -ItemType Directory -Path $addinRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $pluginRoot -Force | Out-Null

    if (Test-Path $pluginTarget) {
        Remove-Item -LiteralPath $pluginTarget -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $pluginSource $pluginFolderName) -Destination $pluginRoot -Recurse -Force
    Write-AddinManifest -Path (Join-Path $addinRoot $addinManifestFileName) -AssemblyPath (Join-Path $pluginTarget $pluginDllFileName)
}
else {
    Write-Host "Revit add-in payload install skipped; existing Revit files were left untouched." -ForegroundColor Yellow
}
if (-not $SkipRuntimePayloadInstall) {
    Copy-RevAgentRuntimeUserPayload -SourceRoot $serverSource -DestinationRoot $ServerTarget
    Remove-RevAgentPath -Path (Join-Path $ServerTarget ".revit-mcp-self-contained-install") -Label "legacy runtime install marker" -AllowedNamePattern "(?i)^\.revit-mcp-self-contained-install$"
    Set-Content -LiteralPath (Join-Path $ServerTarget ".revagent-self-contained-install") -Value ("Installed by revAgent at " + (Get-Date).ToString("s")) -Encoding UTF8
}
else {
    Write-Host "Runtime payload install skipped; existing runtime files were left untouched." -ForegroundColor Yellow
}
Remove-RevAgentPath -Path (Join-Path $InstallRoot ".revit-mcp-programdata-install") -Label "legacy ProgramData install marker" -AllowedNamePattern "(?i)^\.revit-mcp-programdata-install$"
Set-Content -LiteralPath (Join-Path $InstallRoot ".revagent-programdata-install") -Value ("Installed by revAgent at " + (Get-Date).ToString("s")) -Encoding UTF8

# The required revAgent API docs server remains in the repo under installer\revit-api-docs-mcp.
# It is registered from that path after npm install; see the final Next steps.
if (-not (Test-Path $docsServerSource)) {
    throw "Required docs server source was not found: $docsServerSource"
}

# Copy command payload so dynamic command compilation works after install.
$customDllDir = Join-Path $PSScriptRoot "command-payload"
if ((-not $SkipRevitPayloadInstall) -and (Test-Path $customDllDir)) {
    # 1. Machine-wide command cache locations
    $machineCmdSet2022 = Join-Path $commandSetRoot $RevitVersion
    $machineCmdSet = $commandSetRoot

    New-Item -ItemType Directory -Path $machineCmdSet2022 -Force | Out-Null

    Copy-Item -Path (Join-Path $customDllDir $commandSetDllFileName) -Destination $machineCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir $commandSetDllFileName) -Destination $machineCmdSet -Force
    Copy-Item -Path (Join-Path $customDllDir "command.json") -Destination $machineCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir "command.json") -Destination $machineCmdSet -Force

    # 2. Mirror the same files into the Revit add-in command folders
    $roamingCommandsRoot = Join-Path $pluginTarget "Commands"
    $roamingCmdSet2022 = Join-Path $roamingCommandsRoot "$pluginCommandSetFolderName\$RevitVersion"
    $roamingCmdSet = Join-Path $roamingCommandsRoot $pluginCommandSetFolderName
    $legacyRoamingCmdSet = Join-Path $roamingCommandsRoot "RevitMCPCommandSet"
    if (Test-Path -LiteralPath $legacyRoamingCmdSet) {
        Remove-RevAgentPath -Path $legacyRoamingCmdSet -Label "legacy revAgent command payload folder" -Recurse -AllowedNamePattern "(?i)^RevitMCPCommandSet$"
    }

    New-Item -ItemType Directory -Path $roamingCmdSet2022 -Force | Out-Null
    Copy-Item -Path (Join-Path $customDllDir $commandSetDllFileName) -Destination $roamingCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir $commandSetDllFileName) -Destination $roamingCmdSet -Force
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
        $machineCmdSet,
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

    $runtimeDestinations = @($machineCmdSet2022, $roamingCmdSet2022)
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
elseif ($SkipRevitPayloadInstall) {
    Write-Host "Command payload install skipped; existing Revit command files were left untouched." -ForegroundColor Yellow
}

$workspaceAgentsInstalled = $null
if ($preserveLocalCodexInstructions) {
    Write-Host "Codex instructions: preserved local developer instruction surface by policy." -ForegroundColor Yellow
    if (-not $SkipCodexUserIntegration) {
        New-Item -ItemType Directory -Path $codexRoot -Force | Out-Null
        [void](Set-RevAgentCodexMemoryConfig -ConfigPath $codexConfigTarget)
        $utf8ProfilePaths = @(Set-RevAgentPowerShellUtf8ConsoleConfig -UserProfileRoot $env:USERPROFILE -ConfigureConsoleRegistry)
        if ($utf8ProfilePaths.Count -gt 0) {
            Write-Host "PowerShell UTF-8 console profiles: $($utf8ProfilePaths -join '; ')"
        }
    }
}
else {
    if (-not $SkipCodexSkillInstall) {
        New-Item -ItemType Directory -Path $codexMachineSkillsRoot -Force | Out-Null

        if (Test-Path -LiteralPath $codexMachineSkillTarget) {
            Remove-RevAgentPath -Path $codexMachineSkillTarget -Label "machine Codex revAgent skill directory" -Recurse
        }
        Remove-RevAgentPath -Path $legacyCodexMachineSkillTarget -Label "legacy machine Codex revAgent skill directory" -Recurse
        Remove-RevAgentPath -Path $legacyInstallRootMachineSkillTarget -Label "legacy install-root Codex skill directory" -Recurse

        New-Item -ItemType Directory -Path $codexMachineSkillTarget -Force | Out-Null
        Copy-RevAgentFilePayload -Source (Join-Path $codexUserSourceRoot "SKILL.md") -Destination (Join-Path $codexMachineSkillTarget "SKILL.md")

        if (-not $SkipCodexUserIntegration) {
            New-Item -ItemType Directory -Path $codexSkillsRoot -Force | Out-Null

            if (Test-Path -LiteralPath $codexSkillTarget) {
                Remove-RevAgentPath -Path $codexSkillTarget -Label "Codex revAgent skill directory" -Recurse
            }
            Remove-RevAgentPath -Path $legacyCodexSkillTarget -Label "legacy Codex revAgent skill directory" -Recurse

            New-ReparsePointOrCopyDirectory -Source $codexMachineSkillTarget -Destination $codexSkillTarget
        }
    }

    $agentsSource = Join-Path $codexUserSourceRoot "AGENTS.md"
    if (-not (Test-Path -LiteralPath $agentsSource)) {
        throw "Required AGENTS.md was not found: $agentsSource"
    }

    New-Item -ItemType Directory -Path $codexMachineRoot -Force | Out-Null
    Copy-Item -LiteralPath $agentsSource -Destination $codexMachineAgentsTarget -Force

    if (-not $SkipCodexUserIntegration) {
        New-Item -ItemType Directory -Path $codexRoot -Force | Out-Null

        New-HardLinkOrCopyFile -Source $codexMachineAgentsTarget -Destination $codexAgentsTarget
        [void](Set-RevAgentCodexMemoryConfig -ConfigPath $codexConfigTarget)
        $utf8ProfilePaths = @(Set-RevAgentPowerShellUtf8ConsoleConfig -UserProfileRoot $env:USERPROFILE -ConfigureConsoleRegistry)
        if ($utf8ProfilePaths.Count -gt 0) {
            Write-Host "PowerShell UTF-8 console profiles: $($utf8ProfilePaths -join '; ')"
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
        $workspaceAgentsFullPath = [System.IO.Path]::GetFullPath($WorkspaceAgentsTarget)
        $machineAgentsFullPath = [System.IO.Path]::GetFullPath($codexMachineAgentsTarget)
    }

    if ((-not [string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) -and
        (-not [string]::Equals($workspaceAgentsFullPath, $machineAgentsFullPath, [System.StringComparison]::OrdinalIgnoreCase))) {
        $workspaceAgentsDir = Split-Path -Parent $workspaceAgentsFullPath
        if (-not [string]::IsNullOrWhiteSpace($workspaceAgentsDir)) {
            New-Item -ItemType Directory -Path $workspaceAgentsDir -Force | Out-Null
        }

        Copy-Item -LiteralPath $codexMachineAgentsTarget -Destination $workspaceAgentsFullPath -Force
        $workspaceAgentsInstalled = $workspaceAgentsFullPath
    }
}

Remove-RevAgentManagedSourceLeakArtifacts

function ConvertTo-VbsStringLiteral {
    param([string]$Value)

    return [string]::Concat('"', $Value.Replace('"', '""'), '"')
}

function Join-WindowsCommandArguments {
    param([string[]]$Arguments)

    $parts = [System.Collections.Generic.List[string]]::new()
    foreach ($argument in $Arguments) {
        $value = [string]$argument
        if ($value -match '[\s"]') {
            $parts.Add('"' + ($value -replace '"', '\"') + '"')
        }
        else {
            $parts.Add($value)
        }
    }

    return ($parts.ToArray() -join " ")
}

function Resolve-WindowsPowerShellPath {
    return Resolve-RevAgentWindowsPowerShellPath
}

function Resolve-WScriptPath {
    return Resolve-RevAgentWScriptPath
}

function Write-HiddenPowerShellLauncher {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LauncherPath,
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [string[]]$ScriptArguments = @(),
        [switch]$WaitForExit
    )

    Write-RevAgentHiddenPowerShellLauncher `
        -LauncherPath $LauncherPath `
        -ScriptPath $ScriptPath `
        -ScriptArguments $ScriptArguments `
        -WaitForExit:$WaitForExit
}

function Get-HiddenUpdaterLauncherPath {
    param([string]$ConfigPath)

    return Get-RevAgentHiddenUpdaterLauncherPath -ConfigPath $ConfigPath
}

function New-HiddenUpdaterScheduledTaskAction {
    param([string]$LauncherPath)

    return New-RevAgentHiddenUpdaterScheduledTaskAction -LauncherPath $LauncherPath
}

$nasToolsSource = Join-Path $PSScriptRoot "nas"
Repair-RevAgentManagedInstallPermissions
Install-UpdaterToolsFromPackage -SourceRoot $nasToolsSource -DestinationRoot $updaterRoot -ConfigPath $updaterConfigPath
Invoke-RevAgentLogRetention -LogsRoot (Join-Path $updaterRoot "logs") -KeepLast 10 -ActiveLogPath $env:REVIT_MCP_LOG_PATH
Repair-RevAgentManagedInstallPermissions
Repair-RevAgentScheduledTaskAction -ConfigPath $updaterConfigPath -UpdaterPath (Join-Path $updaterRoot "update-from-nas.ps1")
Remove-LegacyRevitMcpInstallRoot
try {
    $desktopLauncherCleanup = Invoke-RevAgentLegacyDesktopLauncherCleanup
    if ([int]$desktopLauncherCleanup.removedCount -gt 0) {
        Write-Host ("Desktop launchers: removed {0} legacy Revit MCP launcher shortcut(s)." -f $desktopLauncherCleanup.removedCount) -ForegroundColor Green
    }
    if ([int]$desktopLauncherCleanup.failedCount -gt 0) {
        Write-Warning ("Desktop launchers: failed to remove {0} legacy Revit MCP launcher shortcut(s)." -f $desktopLauncherCleanup.failedCount)
    }
}
catch {
    Write-Warning "Desktop launcher cleanup failed: $($_.Exception.Message)"
}

Write-Host "Self-contained revAgent bundle installed for Revit $RevitVersion" -ForegroundColor Green
Write-Host "Install root: $InstallRoot"
Write-Host "Revit install root: $revitInstallRoot"
if ($SkipRevitPayloadInstall) {
    Write-Host "Revit addin payload: skipped; existing Revit files were left untouched."
}
else {
    Write-Host "Revit addin manifest path: $addinRoot"
    Write-Host "Plugin payload path: $pluginTarget"
}
Write-Host "Runtime server path: $ServerTarget"
if ($SkipRuntimePayloadInstall) {
    Write-Host "Runtime payload: skipped; existing runtime files were left untouched."
}
Write-Host "Required docs server path: $docsServerSource"
Write-Host "Codex instruction policy: $CodexInstructionPolicy"
if ($preserveLocalCodexInstructions) {
    Write-Host "Machine Codex skill path: $codexMachineSkillTarget (preserved)"
    Write-Host "Machine AGENTS.md: $codexMachineAgentsTarget (preserved)"
    if (-not $SkipCodexUserIntegration) {
        Write-Host "Codex user skill integration: $codexSkillTarget (preserved)"
        Write-Host "Codex global AGENTS.md integration: $codexAgentsTarget (preserved)"
    }
}
else {
    if (-not $SkipCodexSkillInstall) {
        Write-Host "Machine Codex skill path: $codexMachineSkillTarget"
        if (-not $SkipCodexUserIntegration) {
            Write-Host "Codex user skill integration: $codexSkillTarget"
        }
    }
    Write-Host "Machine AGENTS.md: $codexMachineAgentsTarget"
    if (-not $SkipCodexUserIntegration) {
        Write-Host "Codex global AGENTS.md integration: $codexAgentsTarget"
    }
}
if ($workspaceAgentsInstalled) {
    Write-Host "Workspace AGENTS.md: $workspaceAgentsInstalled"
}
if (-not $SuppressNextSteps) {
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "1. cd $ServerTarget"
    Write-Host "2. npm install --omit=dev --no-audit --no-fund"
    Write-Host "3. codex mcp add revAgent -- node `"$ServerTarget\build\index.js`""
    Write-Host "4. cd $docsServerSource"
    Write-Host "5. npm install --omit=dev --no-audit --no-fund"
    Write-Host "6. powershell -ExecutionPolicy Bypass -File `"$docsServerSource\scripts\build-index.ps1`" -RevitRoot `"$revitInstallRoot`" -OutputPath `"$stateRoot\revit-api-docs\cache\revit-api-docs-$RevitVersion.json`""
    Write-Host "7. codex mcp add revAgent-api-docs -- node `"$docsServerSource\build\index.js`""
    Write-Host "8. Confirm both servers with: codex mcp list"
    Write-Host "9. Run /skills reload in Codex, or restart Codex"
    Write-Host "10. Open Revit; if prompted for the unsigned add-in, choose Always Load"
    Write-Host "11. revAgent starts automatically. Use the ribbon revAgent Info button to view active version metadata"
}
