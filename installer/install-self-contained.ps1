param(
    [ValidateSet("2022")]
    [string]$RevitVersion = "2022",
    [string]$InstallRoot = "",
    [string]$ServerTarget = "",
    [string]$RevitInstallRoot = "",
    [string]$AllUsersAddinRoot = "",
    [string[]]$LegacyServerTargets = @(),
    [string]$WorkspaceAgentsTarget = "",
    [switch]$SkipCodexSkillInstall,
    [switch]$SkipCodexUserIntegration,
    [switch]$SkipLegacyCleanup,
    [switch]$SkipRevitPayloadInstall,
    [switch]$SuppressNextSteps,
    [switch]$Uninstall,
    [switch]$RemoveAgents
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginSource = Join-Path $PSScriptRoot "revit-plugin"
$serverSource = Join-Path $PSScriptRoot "runtime-mcp-server"
$docsServerSource = Join-Path $PSScriptRoot "revit-api-docs-mcp"
$programDataRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { "C:\ProgramData" } else { $env:ProgramData }
$defaultInstallRoot = Join-Path $programDataRoot "DPE\RevitMCP"
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
$pluginTarget = Join-Path $pluginRoot "revit_mcp_plugin"
$commandSetRoot = Join-Path $InstallRoot "commands\CommandSet"
$stateRoot = Join-Path $InstallRoot "state"
$updaterRoot = Join-Path $InstallRoot "updater"
$updaterConfigPath = Join-Path $updaterRoot "updater-config.json"
$codexMachineRoot = Join-Path $InstallRoot "codex"
$codexMachineSkillsRoot = Join-Path $codexMachineRoot "skills"
$codexMachineSkillTarget = Join-Path $codexMachineSkillsRoot "revit-mcp"
$codexMachineAgentsTarget = Join-Path $codexMachineRoot "AGENTS.md"
$codexRoot = Join-Path $env:USERPROFILE ".codex"
$codexSkillsRoot = Join-Path $codexRoot "skills"
$codexSkillTarget = Join-Path $codexSkillsRoot "revit-mcp"
$codexSkillBackupsRoot = Join-Path $codexRoot "skill-backups"
$codexAgentsTarget = Join-Path $codexRoot "AGENTS.md"
$defaultLegacyServerTargets = @(
    "C:\Projects\revit-mcp",
    "C:\Projects\revit-mcp-server",
    "C:\Projects\mcp-server-for-revit",
    "C:\Projects\mcp-servers-for-revit"
)
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

    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
            $RequestedRoot,
            $env:REVIT_INSTALL_ROOT,
            (Join-Path ${env:ProgramFiles} "Autodesk\Revit $Version"),
            (Join-Path ${env:ProgramFiles} "Autodesk\Revit$Version"),
            (Join-Path ${env:ProgramFiles(x86)} "Autodesk\Revit $Version")
        )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $candidates.Add($candidate)
        }
    }
    foreach ($candidate in Get-RevitRegistryInstallCandidates -Version $Version) {
        $candidates.Add($candidate)
    }

    $resolved = Resolve-ExistingDirectoryFromCandidates -Label "Revit $Version install directory" -Candidates $candidates.ToArray() -Required
    foreach ($requiredFile in @("Revit.exe", "RevitAPI.dll", "RevitAPI.xml")) {
        $requiredPath = Join-Path $resolved $requiredFile
        if (-not (Test-Path -LiteralPath $requiredPath)) {
            throw "Revit $Version install directory was found, but required file is missing: $requiredPath"
        }
    }

    return $resolved
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
    <Name>mcp-servers-for-revit</Name>
    <Assembly>$escapedAssembly</Assembly>
    <FullClassName>revit_mcp_plugin.Core.Application</FullClassName>
    <ClientId>090A4C8C-61DC-426D-87DF-E4BAE0F80EC1</ClientId>
    <VendorId>DPE</VendorId>
    <VendorDescription>DPE internal Revit MCP add-in</VendorDescription>
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
        Remove-RevitMcpPath -Path $Destination -Label "Codex skill integration directory" -Recurse
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
        Remove-RevitMcpPath -Path $Destination -Label "Codex AGENTS.md integration file" -AllowedNamePattern "(?i)(^AGENTS\.md$)"
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
    foreach ($toolName in @("update-from-nas.ps1", "show-installed-version.ps1", "install-updater-task.ps1")) {
        $source = Join-Path $SourceRoot $toolName
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $DestinationRoot $toolName) -Force
        }
    }

    $updaterPath = Join-Path $DestinationRoot "update-from-nas.ps1"
    $versionToolPath = Join-Path $DestinationRoot "show-installed-version.ps1"
    if (Test-Path -LiteralPath $updaterPath -PathType Leaf) {
        @(
            "@echo off",
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$updaterPath`" -ConfigPath `"$ConfigPath`" -NoNotifyUser -AllowManualCodexSetup",
            "pause"
        ) | Set-Content -LiteralPath (Join-Path $DestinationRoot "Update-Revit-MCP-Now.cmd") -Encoding ASCII
    }
    if (Test-Path -LiteralPath $versionToolPath -PathType Leaf) {
        @(
            "@echo off",
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$versionToolPath`" -ConfigPath `"$ConfigPath`"",
            "pause"
        ) | Set-Content -LiteralPath (Join-Path $DestinationRoot "Show-Revit-MCP-Version.cmd") -Encoding ASCII
    }

    Write-Host "Updater tools refreshed: $DestinationRoot"
}

function Repair-RevitMcpScheduledTaskAction {
    param(
        [string]$ConfigPath,
        [string]$UpdaterPath
    )

    if ([string]::IsNullOrWhiteSpace($ConfigPath) -or
        [string]::IsNullOrWhiteSpace($UpdaterPath) -or
        -not (Test-Path -LiteralPath $ConfigPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $UpdaterPath -PathType Leaf)) {
        return
    }

    $taskName = "Revit MCP Auto Update"
    try {
        $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
        if ($config.taskName) {
            $taskName = [string]$config.taskName
        }
    }
    catch {}

    try {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (-not $task) {
            return
        }

        $launcherPath = Get-HiddenUpdaterLauncherPath -ConfigPath $ConfigPath
        Write-HiddenPowerShellLauncher -LauncherPath $launcherPath -ScriptPath $UpdaterPath -ScriptArguments @("-ConfigPath", $ConfigPath, "-NotifyUser") -WaitForExit
        $desiredExecute = Resolve-WScriptPath
        $desiredArgs = "//B //Nologo `"$launcherPath`""
        $currentAction = @($task.Actions | Select-Object -First 1)
        $currentArgs = if ($currentAction.Count -gt 0) { [string]$currentAction[0].Arguments } else { "" }
        $currentExecute = if ($currentAction.Count -gt 0) { [string]$currentAction[0].Execute } else { "" }
        $currentExecuteMatches = [string]::Equals($currentExecute, $desiredExecute, [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($currentExecute, "wscript.exe", [System.StringComparison]::OrdinalIgnoreCase)
        if ([string]::Equals($currentArgs, $desiredArgs, [System.StringComparison]::OrdinalIgnoreCase) -and
            $currentExecuteMatches) {
            return
        }

        $action = New-HiddenUpdaterScheduledTaskAction -LauncherPath $launcherPath
        Set-ScheduledTask -TaskName $taskName -Action $action | Out-Null
        Write-Host "Scheduled task action repaired for hidden background checks: $taskName"
    }
    catch {
        Write-Warning "Could not repair scheduled task action for hidden background checks: $($_.Exception.Message)"
    }
}

if ($Uninstall -and [string]::IsNullOrWhiteSpace($RevitInstallRoot)) {
    $revitInstallRoot = ""
}
else {
    $revitInstallRoot = Resolve-RevitInstallRoot -RequestedRoot $RevitInstallRoot -Version $RevitVersion
}

function Assert-RevitMcpCleanupPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [string]$AllowedNamePattern = "(?i)(^revit[-_]mcp($|[-_.])|^revit_mcp_plugin$|^mcp[-_]servers?[-_]for[-_]revit|^mcp-server-for-revit|^RevitMCP|^runtime$|^package$|^updater$|^state$|^revit-plugin$|^codex$|^AGENTS\.md$)"
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
    param(
        [string]$Root = $addinRoot
    )

    $legacyAddin = Join-Path $Root "revit-mcp.addin"
    if (-not (Test-Path -LiteralPath $legacyAddin)) {
        return
    }

    $disabledAddin = Join-Path $Root "revit-mcp.addin.disabled-self-contained"
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

    if (-not $SkipRevitPayloadInstall) {
        Remove-RevitMcpPath -Path (Join-Path $addinRoot "mcp-servers-for-revit.addin") -Label "Revit MCP addin manifest" -AllowedNamePattern "(?i)(^mcp[-_]servers?[-_]for[-_]revit\.addin$)"
        Remove-RevitMcpPath -Path (Join-Path $addinRoot "revit-mcp.addin.disabled-self-contained") -Label "disabled legacy Revit MCP addin manifest" -AllowedNamePattern "(?i)(^revit[-_]mcp\.addin(\.disabled-self-contained)?$)"
        if (-not $SkipLegacyCleanup) {
            Remove-RevitMcpPath -Path (Join-Path $legacyUserAddinRoot "mcp-servers-for-revit.addin") -Label "legacy user Revit MCP addin manifest" -AllowedNamePattern "(?i)(^mcp[-_]servers?[-_]for[-_]revit\.addin$)"
            Remove-RevitMcpPath -Path (Join-Path $legacyUserAddinRoot "revit-mcp.addin.disabled-self-contained") -Label "disabled legacy user Revit MCP addin manifest" -AllowedNamePattern "(?i)(^revit[-_]mcp\.addin(\.disabled-self-contained)?$)"
            Remove-RevitMcpPath -Path (Join-Path $legacyUserAddinRoot "revit_mcp_plugin") -Label "legacy user Revit MCP addin payload directory" -Recurse
        }
        Remove-RevitMcpPath -Path $pluginTarget -Label "Revit MCP addin payload directory" -Recurse
        Remove-RevitMcpPath -Path $commandSetRoot -Label "Revit MCP machine command directory" -Recurse -AllowedNamePattern "(?i)(^CommandSet$)"
        if (-not $SkipLegacyCleanup) {
            Remove-RevitMcpPath -Path (Join-Path $env:LOCALAPPDATA "revit-mcp-plugin") -Label "Revit MCP LocalAppData command directory" -Recurse
        }
    }
    else {
        Write-Host "Revit add-in cleanup skipped; active Revit files were left untouched." -ForegroundColor Yellow
    }

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
        Remove-RevitMcpPath -Path $codexMachineSkillTarget -Label "machine Codex Revit MCP skill directory" -Recurse
        if ($RemoveAgents) {
            Remove-RevitMcpPath -Path $codexAgentsTarget -Label "Codex global AGENTS.md" -AllowedNamePattern "(?i)(^AGENTS\.md$)"
            Remove-RevitMcpPath -Path $codexMachineAgentsTarget -Label "machine AGENTS.md" -AllowedNamePattern "(?i)(^AGENTS\.md$)"
            if (-not [string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
                Remove-RevitMcpPath -Path $WorkspaceAgentsTarget -Label "workspace AGENTS.md" -AllowedNamePattern "(?i)(^AGENTS\.md$)"
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

Invoke-RevitMcpCleanup -ForUninstall:$Uninstall

if ($Uninstall) {
    Write-Host "Self-contained Revit MCP bundle uninstalled for Revit $RevitVersion" -ForegroundColor Green
    Write-Host "Autodesk Revit program files and Windows system files were not touched."
    Write-Host "If MCP entries were registered in Codex, remove them with: codex mcp remove revit-mcp ; codex mcp remove revit-api-docs"
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
    Copy-Item -LiteralPath (Join-Path $pluginSource "revit_mcp_plugin") -Destination $pluginRoot -Recurse -Force
    Write-AddinManifest -Path (Join-Path $addinRoot "mcp-servers-for-revit.addin") -AssemblyPath (Join-Path $pluginTarget "RevitMCPPlugin.dll")
}
else {
    Write-Host "Revit add-in payload install skipped; existing Revit-loaded files were left untouched." -ForegroundColor Yellow
}
# Expand the bundled runtime server contents into the target directory.
Copy-Item -Path (Join-Path $serverSource "*") -Destination $ServerTarget -Recurse -Force
Set-Content -LiteralPath (Join-Path $ServerTarget ".revit-mcp-self-contained-install") -Value ("Installed by revit-mcp-skill at " + (Get-Date).ToString("s")) -Encoding UTF8
Set-Content -LiteralPath (Join-Path $InstallRoot ".revit-mcp-programdata-install") -Value ("Installed by revit-mcp-skill at " + (Get-Date).ToString("s")) -Encoding UTF8

# The required Revit API docs MCP server remains in the repo under installer\revit-api-docs-mcp.
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

    Copy-Item -Path (Join-Path $customDllDir "RevitMCPCommandSet.dll") -Destination $machineCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir "RevitMCPCommandSet.dll") -Destination $machineCmdSet -Force
    Copy-Item -Path (Join-Path $customDllDir "command.json") -Destination $machineCmdSet2022 -Force
    Copy-Item -Path (Join-Path $customDllDir "command.json") -Destination $machineCmdSet -Force

    # 2. Mirror the same files into the Revit add-in command folders
    $roamingCmdSet2022 = Join-Path $pluginTarget "Commands\RevitMCPCommandSet\$RevitVersion"
    $roamingCmdSet = Join-Path $pluginTarget "Commands\RevitMCPCommandSet"

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
if (-not $SkipCodexSkillInstall) {
    New-Item -ItemType Directory -Path $codexMachineSkillsRoot -Force | Out-Null

    if (Test-Path -LiteralPath $codexMachineSkillTarget) {
        Remove-RevitMcpPath -Path $codexMachineSkillTarget -Label "machine Codex Revit MCP skill directory" -Recurse
    }

    New-Item -ItemType Directory -Path $codexMachineSkillTarget -Force | Out-Null
    Get-ChildItem -LiteralPath $repoRoot -Force |
        Where-Object { $_.Name -notin @(".git", "node_modules") } |
        Copy-Item -Destination $codexMachineSkillTarget -Recurse -Force

    if (-not $SkipCodexUserIntegration) {
        New-Item -ItemType Directory -Path $codexSkillsRoot -Force | Out-Null

        if (Test-Path -LiteralPath $codexSkillTarget) {
            $backupStamp = Get-Date -Format "yyyyMMdd-HHmmss"
            New-Item -ItemType Directory -Path $codexSkillBackupsRoot -Force | Out-Null
            $skillBackup = Join-Path $codexSkillBackupsRoot "revit-mcp.backup-$backupStamp"
            Move-Item -LiteralPath $codexSkillTarget -Destination $skillBackup
        }

        New-ReparsePointOrCopyDirectory -Source $codexMachineSkillTarget -Destination $codexSkillTarget
    }
}

$agentsSource = Join-Path $repoRoot "AGENTS.md"
if (-not (Test-Path -LiteralPath $agentsSource)) {
    throw "Required AGENTS.md was not found: $agentsSource"
}

New-Item -ItemType Directory -Path $codexMachineRoot -Force | Out-Null
Copy-Item -LiteralPath $agentsSource -Destination $codexMachineAgentsTarget -Force

if (-not $SkipCodexUserIntegration) {
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

    New-HardLinkOrCopyFile -Source $codexMachineAgentsTarget -Destination $codexAgentsTarget
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

    if (Test-Path -LiteralPath $workspaceAgentsFullPath) {
        $existingWorkspaceAgents = Get-Item -LiteralPath $workspaceAgentsFullPath
        if ($existingWorkspaceAgents.Length -gt 0) {
            $workspaceAgentsBackup = $workspaceAgentsFullPath + ".backup-" + (Get-Date -Format "yyyyMMdd-HHmmss")
            Copy-Item -LiteralPath $workspaceAgentsFullPath -Destination $workspaceAgentsBackup -Force
        }
    }

    Copy-Item -LiteralPath $codexMachineAgentsTarget -Destination $workspaceAgentsFullPath -Force
    $workspaceAgentsInstalled = $workspaceAgentsFullPath
}

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
    return (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe")
}

function Resolve-WScriptPath {
    return (Join-Path $env:WINDIR "System32\wscript.exe")
}

function Grant-RevitMcpManagedPathAccess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [string]$Label = "managed path",
        [switch]$CreateDirectory,
        [switch]$Recurse
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }

    try {
        if ($CreateDirectory) {
            New-Item -ItemType Directory -Path $Path -Force | Out-Null
        }
        elseif (-not (Test-Path -LiteralPath $Path)) {
            return
        }

        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        if ([string]::IsNullOrWhiteSpace($identity)) {
            return
        }

        $grant = if ($Recurse) { "${identity}:(OI)(CI)M" } else { "${identity}:M" }
        $arguments = @($Path, "/grant", $grant, "/C")
        if ($Recurse) {
            $arguments += "/T"
        }

        & icacls @arguments | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not grant write access to $identity for $Label ($Path). icacls exit code: $LASTEXITCODE"
        }
    }
    catch {
        Write-Warning "Could not grant write access for $Label (${Path}): $($_.Exception.Message)"
    }
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

    $launcherDir = Split-Path -Parent $LauncherPath
    if (-not [string]::IsNullOrWhiteSpace($launcherDir)) {
        New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
    }

    $command = Join-WindowsCommandArguments -Arguments (@(
            (Resolve-WindowsPowerShellPath),
            "-STA",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $ScriptPath
        ) + $ScriptArguments)
    $waitText = if ($WaitForExit) { "True" } else { "False" }

    $runLine = [string]::Concat("exitCode = shell.Run(", (ConvertTo-VbsStringLiteral -Value $command), ", 0, ", $waitText, ")")

    @(
        "Option Explicit",
        "Dim shell",
        "Dim exitCode",
        "Set shell = CreateObject(""WScript.Shell"")",
        $runLine,
        "WScript.Quit exitCode"
    ) | Set-Content -LiteralPath $LauncherPath -Encoding ASCII
}

function Get-HiddenUpdaterLauncherPath {
    param([string]$ConfigPath)

    return Join-Path (Split-Path -Parent $ConfigPath) "Run-Revit-MCP-Update-Hidden.vbs"
}

function New-HiddenUpdaterScheduledTaskAction {
    param([string]$LauncherPath)

    return New-ScheduledTaskAction -Execute (Resolve-WScriptPath) -Argument ("//B //Nologo `"$LauncherPath`"")
}

$nasToolsSource = Join-Path $PSScriptRoot "nas"
Grant-RevitMcpManagedPathAccess -Path $InstallRoot -Label "Revit MCP install root" -CreateDirectory -Recurse
Grant-RevitMcpManagedPathAccess -Path $updaterRoot -Label "updater work root" -CreateDirectory -Recurse
Grant-RevitMcpManagedPathAccess -Path (Join-Path $addinRoot "mcp-servers-for-revit.addin") -Label "Revit addin manifest"
Install-UpdaterToolsFromPackage -SourceRoot $nasToolsSource -DestinationRoot $updaterRoot -ConfigPath $updaterConfigPath
Grant-RevitMcpManagedPathAccess -Path $InstallRoot -Label "Revit MCP install root" -CreateDirectory -Recurse
Grant-RevitMcpManagedPathAccess -Path $updaterRoot -Label "updater work root" -CreateDirectory -Recurse
Grant-RevitMcpManagedPathAccess -Path (Join-Path $addinRoot "mcp-servers-for-revit.addin") -Label "Revit addin manifest"
Repair-RevitMcpScheduledTaskAction -ConfigPath $updaterConfigPath -UpdaterPath (Join-Path $updaterRoot "update-from-nas.ps1")

Write-Host "Self-contained Revit MCP bundle installed for Revit $RevitVersion" -ForegroundColor Green
Write-Host "Install root: $InstallRoot"
Write-Host "Revit install root: $revitInstallRoot"
if ($SkipRevitPayloadInstall) {
    Write-Host "Revit addin payload: skipped; existing Revit-loaded files were left untouched."
}
else {
    Write-Host "Revit addin manifest path: $addinRoot"
    Write-Host "Plugin payload path: $pluginTarget"
}
Write-Host "Runtime server path: $ServerTarget"
Write-Host "Required docs server path: $docsServerSource"
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
if ($workspaceAgentsInstalled) {
    Write-Host "Workspace AGENTS.md: $workspaceAgentsInstalled"
}
if (-not $SuppressNextSteps) {
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "1. cd $ServerTarget"
    Write-Host "2. npm install --omit=dev --no-audit --no-fund"
    Write-Host "3. codex mcp add revit-mcp -- node `"$ServerTarget\build\index.js`""
    Write-Host "4. cd $docsServerSource"
    Write-Host "5. npm install --omit=dev --no-audit --no-fund"
    Write-Host "6. powershell -ExecutionPolicy Bypass -File `"$docsServerSource\scripts\build-index.ps1`" -RevitRoot `"$revitInstallRoot`" -OutputPath `"$stateRoot\revit-api-docs\cache\revit-api-docs-$RevitVersion.json`""
    Write-Host "7. codex mcp add revit-api-docs -- node `"$docsServerSource\build\index.js`""
    Write-Host "8. Confirm both servers with: codex mcp list"
    Write-Host "9. Run /skills reload in Codex, or restart Codex"
    Write-Host "10. Open Revit; if prompted for the unsigned add-in, choose Always Load"
    Write-Host "11. Revit MCP starts automatically. Use the ribbon Settings button only to review command availability"
}
