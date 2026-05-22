<#
.SYNOPSIS
    Local, non-admin smoke tests for installer/updater helper modules.

.DESCRIPTION
    These tests intentionally avoid Revit, NAS access, admin-only writes, and
    scheduled task registration. They validate the pure helper behavior that
    protects the public installer/updater entrypoints.
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
$libRoot = Join-Path $RepoRoot "installer\lib"

Import-Module (Join-Path $libRoot "RevitMcp.HiddenLauncher.psm1") -Force
Import-Module (Join-Path $libRoot "RevitMcp.ScheduledTask.psm1") -Force
Import-Module (Join-Path $libRoot "RevitMcp.Permissions.psm1") -Force
Import-Module (Join-Path $libRoot "RevitMcp.Package.psm1") -Force
Import-Module (Join-Path $libRoot "RevitMcp.RevitVersions.psm1") -Force
Import-Module (Join-Path $libRoot "RevitMcp.UpdatePolicy.psm1") -Force
Import-Module (Join-Path $libRoot "RevitMcp.Proxy.psm1") -Force
Import-Module (Join-Path $libRoot "RevitMcp.LogRetention.psm1") -Force
Import-Module (Join-Path $libRoot "RevitMcp.CodexRegistration.psm1") -Force
Import-Module (Join-Path $libRoot "RevitMcp.Reporting.psm1") -Force

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Equal {
    param(
        [object]$Actual,
        [object]$Expected,
        [string]$Message
    )

    if ($Actual -ne $Expected) {
        throw "$Message Expected '$Expected', got '$Actual'."
    }
}

function Get-ScriptParamNames {
    param([string]$Path)

    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    Assert-Equal $errors.Count 0 "PowerShell parse errors found in $Path."
    return @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
}

$tempRoot = Join-Path $env:TEMP ("revit-mcp-smoke-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    Write-Host "Test hidden VBS launcher"
    $exitScript = Join-Path $tempRoot "exit-7.ps1"
    Set-Content -LiteralPath $exitScript -Value "exit 7" -Encoding ASCII
    $launcher = Join-Path $tempRoot "hidden-launcher.vbs"
    Write-RevitMcpHiddenPowerShellLauncher -LauncherPath $launcher -ScriptPath $exitScript -WaitForExit
    $launcherLines = @(Get-Content -LiteralPath $launcher)
    Assert-Equal $launcherLines.Count 1 "Hidden launcher must be a single VBS line."
    Assert-True ($launcherLines[0] -match '^WScript\.Quit CreateObject\("WScript\.Shell"\)\.Run\(') "Hidden launcher must propagate WScript exit code."
    $cscript = Join-Path $env:WINDIR "System32\cscript.exe"
    & $cscript //B //Nologo $launcher
    Assert-Equal $LASTEXITCODE 7 "Hidden launcher did not propagate child PowerShell exit code."

    Write-Host "Test scheduled task action"
    $action = New-RevitMcpHiddenUpdaterScheduledTaskAction -LauncherPath $launcher
    Assert-True ([string]$action.Execute -match 'wscript\.exe$') "Scheduled task action must use wscript.exe."
    Assert-True ([string]$action.Execute -notmatch 'powershell\.exe$') "Scheduled task action must not execute powershell.exe directly."
    Assert-True ([string]$action.Arguments -match [regex]::Escape($launcher)) "Scheduled task action must point at the hidden VBS launcher."

    Write-Host "Test permission repair target plan"
    $targets = Get-RevitMcpManagedPermissionTargets `
        -InstallRoot "C:\ProgramData\DPE\RevitMCP" `
        -WorkRoot "C:\ProgramData\DPE\RevitMCP\updater" `
        -PackageTarget "C:\ProgramData\DPE\RevitMCP\package" `
        -ServerTarget "C:\ProgramData\DPE\RevitMCP\runtime" `
        -AllUsersAddinRoot "C:\ProgramData\Autodesk\Revit\Addins\2022" `
        -RevitVersion 2022 `
        -IncludeExistingPayloadTrees
    Assert-True (($targets | Where-Object { $_.Path -match 'node_modules|backups' }).Count -eq 0) "Permission repair plan must not target node_modules or backups."
    $recursiveLeaves = @($targets | Where-Object { $_.Recurse } | ForEach-Object { Split-Path -Leaf $_.Path })
    foreach ($leaf in $recursiveLeaves) {
        Assert-True ($leaf -in @("revit_mcp_plugin", "CommandSet", "runtime", "revit-mcp")) "Unexpected recursive permission target: $leaf"
    }

    Write-Host "Test Revit payload update policy"
    $changedRunning = Get-RevitMcpUpdateDecision -HasReleaseManifest -HasReleaseComponents -RevitPayloadChangeCount 1 -IsRevitRunning
    Assert-True $changedRunning.RequiresRevitClosed "Changed Revit payload must require Revit closed."
    Assert-True $changedRunning.DeferForRevitClose "Changed Revit payload must defer while Revit is running."
    Assert-True (-not $changedRunning.SkipRevitPayloadInstall) "Changed Revit payload must not skip and continue."
    $unchangedRunning = Get-RevitMcpUpdateDecision -HasReleaseManifest -HasReleaseComponents -RevitPayloadChangeCount 0 -IsRevitRunning
    Assert-True (-not $unchangedRunning.RequiresRevitClosed) "Unchanged Revit payload must not require Revit closed."
    Assert-True (-not $unchangedRunning.DeferForRevitClose) "Unchanged Revit payload must not defer while Revit is running."
    Assert-True $unchangedRunning.SkipRevitPayloadInstall "Unchanged Revit payload should skip active Revit files and continue."

    Write-Host "Test package path and layout resolution"
    $packageRoot = Join-Path $tempRoot "package"
    New-Item -ItemType Directory -Path (Join-Path $packageRoot "installer\revit-api-docs-mcp") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $packageRoot "installer\install-self-contained.ps1") -Value "# test" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $packageRoot "installer\revit-api-docs-mcp\package.json") -Value "{}" -Encoding ASCII
    $layout = Resolve-RevitMcpPackageLayout -Root $packageRoot
    Assert-Equal $layout.installerRelativePath "installer\install-self-contained.ps1" "Installer layout resolution failed."
    Assert-Equal $layout.docsServerRelativePath "installer\revit-api-docs-mcp" "Docs server layout resolution failed."
    $releasePath = Resolve-RevitMcpReleasePath -Path "releases\pkg.zip" -BaseDirectory "\\nas\share\channels"
    Assert-Equal $releasePath "\\nas\share\channels\releases\pkg.zip" "Relative release path resolution failed."

    Write-Host "Test Revit version matrix"
    $v2022 = Get-RevitMcpVersionConfig -Version 2022 -RepoRoot $RepoRoot
    Assert-Equal $v2022.targetFramework "net48" "Revit 2022 target framework changed."
    Assert-RevitMcpInstallerPayloadAvailable -Version 2022 -RepoRoot $RepoRoot
    $matrix = Get-RevitMcpVersionMatrix -RepoRoot $RepoRoot
    $configuredVersions = @($matrix.versions.PSObject.Properties.Name | Sort-Object)
    Assert-Equal ($configuredVersions -join ",") "2022,2023,2024,2025" "Only Revit 2022-2025 should be modeled in the branch matrix."
    $blocked = $false
    try {
        Assert-RevitMcpInstallerPayloadAvailable -Version 2023 -RepoRoot $RepoRoot
    }
    catch {
        $blocked = $true
    }
    Assert-True $blocked "Revit 2023 must remain blocked until real payload artifacts are bundled."
    $portableRoot = Join-Path $tempRoot "portable-tools"
    New-Item -ItemType Directory -Path (Join-Path $portableRoot "lib") -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $libRoot "RevitMcp.RevitVersions.psm1") -Destination (Join-Path $portableRoot "lib\RevitMcp.RevitVersions.psm1") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "config") -Destination (Join-Path $portableRoot "config") -Recurse -Force
    Import-Module (Join-Path $portableRoot "lib\RevitMcp.RevitVersions.psm1") -Force
    $portable2022 = RevitMcp.RevitVersions\Get-RevitMcpVersionConfig -Version 2022
    Assert-Equal $portable2022.buildConfiguration "Release R22" "Portable updater lib/config version matrix lookup failed."
    Import-Module (Join-Path $libRoot "RevitMcp.RevitVersions.psm1") -Force

    Write-Host "Test C# Revit project configurations"
    $legacyRevitConfigPattern = '(?<!\d)(2020|2021)(?!\d)|\bR20\b|\bR21\b'
    foreach ($relativePath in @(
            "src\revit-plugin\revit-mcp-plugin.sln",
            "src\revit-plugin\revit-mcp-plugin\revit-mcp-plugin.csproj",
            "src\revit-plugin\RevitMCPCommandSet\RevitMCPCommandSet.csproj"
        )) {
        $projectText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot $relativePath)
        Assert-True ($projectText -notmatch $legacyRevitConfigPattern) "$relativePath still contains legacy Revit 2020/2021 build configuration."
    }

    Write-Host "Test Revit command registry includes view command set tools"
    $viewCommandJson = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revit_mcp_plugin\Commands\RevitMCPViewCommandSet\command.json") | ConvertFrom-Json
    $commandRegistry = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revit_mcp_plugin\Commands\commandRegistry.json") | ConvertFrom-Json
    $registeredCommandNames = @($commandRegistry.Commands | ForEach-Object { [string]$_.commandName })
    foreach ($name in @($viewCommandJson.commands | ForEach-Object { [string]$_.commandName })) {
        Assert-True ($registeredCommandNames -contains $name) "commandRegistry.json is missing Revit view command '$name'."
    }

    Write-Host "Test installer public parameters"
    $installerParams = Get-ScriptParamNames -Path (Join-Path $RepoRoot "installer\install-self-contained.ps1")
    foreach ($name in @(
            "RevitVersion",
            "InstallRoot",
            "ServerTarget",
            "RevitInstallRoot",
            "AllUsersAddinRoot",
            "LegacyServerTargets",
            "WorkspaceAgentsTarget",
            "SkipCodexSkillInstall",
            "SkipCodexUserIntegration",
            "SkipLegacyCleanup",
            "SkipRevitPayloadInstall",
            "SuppressNextSteps",
            "Uninstall",
            "RemoveAgents"
        )) {
        Assert-True ($installerParams -contains $name) "install-self-contained.ps1 lost public parameter -$name."
    }
    $updaterTaskParams = Get-ScriptParamNames -Path (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
    foreach ($name in @("ChannelManifestPath", "RunNow", "ForceUpdate")) {
        Assert-True ($updaterTaskParams -contains $name) "install-updater-task.ps1 lost public parameter -$name."
    }

    Write-Host "Test GUI updater exposes update and restore actions"
    $guiText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Install-Revit-MCP-Updater-GUI.ps1")
    Assert-True ($guiText -match 'Repair/Reinstall') "GUI must expose a separate repair/reinstall button."
    Assert-True ($guiText -match '-ForceUpdate') "GUI restore action must force the channel package install."
    Assert-True ($guiText -match 'UpdateEnabled') "GUI must gate the update button from channel status."
    Assert-True ($guiText -match '\$form\.Text = "revAgent"') "GUI title must use the revAgent product name."
    Assert-True ($guiText -match 'Your AI agent inside Revit\.') "GUI must show the revAgent product tagline."
    Assert-True ($guiText -match '2026 Baris Tankut') "GUI must show the revAgent copyright footer."
    Assert-True ($guiText -match '\$form\.ShowInTaskbar = \$true') "GUI must be visible in the taskbar."
    Assert-True ($guiText -match '\$form\.MinimizeBox = \$true') "GUI must be minimizable."
    Assert-True ($guiText -notmatch 'Guncelle|Surum|Kapat|Kurulum|Kanal|Hazir|Islem|Calisiyor|Baslatilamadi|bulunamadi|hata') "GUI product strings must remain English."
    Assert-True ($guiText -notmatch 'Revit MCP Installer|Revit MCP install and update|Stable Restore|Stable channel|Stable version') "GUI product labels must not expose internal MCP wording or legacy channel wording."

    Write-Host "Test Revit task status window product surface"
    $taskStatusXaml = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\UI\McpTaskStatusWindow.xaml")
    $taskStatusCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\UI\McpTaskStatusWindow.xaml.cs")
    $taskStatusController = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\Core\McpTaskStatusWindowController.cs")
    Assert-True ($taskStatusXaml -match 'Title="revAgent Status"') "Task status window title must use revAgent."
    Assert-True ($taskStatusXaml -match 'Your AI agent inside Revit\.') "Task status window must show the revAgent product tagline."
    Assert-True ($taskStatusXaml -match '2026 Baris Tankut') "Task status window must show the revAgent copyright footer."
    Assert-True ($taskStatusXaml -match 'UpdateStatusText') "Task status window must expose the update state line."
    Assert-True ($taskStatusXaml -match 'Up to date') "Task status window must use user-facing update state wording."
    Assert-True ($taskStatusXaml -match 'WindowStyle="SingleBorderWindow"') "Task status window must expose a normal minimizable window frame."
    Assert-True ($taskStatusXaml -match 'ShowInTaskbar="True"') "Task status window must be visible in the taskbar."
    Assert-True ($taskStatusXaml -notmatch 'Revit MCP|Recent MCP') "Task status window XAML must not expose internal MCP wording."
    Assert-True ($taskStatusCode -notmatch 'Revit MCP is working|Revit MCP task|Revit MCP version') "Task status code must not expose internal MCP wording."
    Assert-True ($taskStatusCode -match 'VersionDisplay') "Task status code must present the installed product version label."
    Assert-True ($taskStatusCode -match 'FormatUpdateStatusLine') "Task status code must present a concise update-state label."
    $versionInfoCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\Core\McpVersionInfo.cs")
    Assert-True ($versionInfoCode -match 'channelManifestPath') "Version info must read the configured channel manifest path."
    Assert-True ($versionInfoCode -match 'publishedAtUtc') "Version info must use release/channel publish timestamps when available."
    Assert-True ($versionInfoCode -match 'Version ') "Version info must label the installed product version clearly."
    Assert-True ($versionInfoCode -match '\(" \+ build \+ "\)"') "Version info must place the build identifier in the Version line."
    Assert-True ($versionInfoCode -match 'Installed on this PC') "Version info must keep local install time in support details only."
    Assert-True ($versionInfoCode -notmatch 'Updated ') "Task status metadata must not expose local install time as the user-facing version."
    Assert-True ($versionInfoCode -match 'Up to date') "Version info must label current release state clearly."
    Assert-True ($versionInfoCode -notmatch 'Stable ') "Version info must not expose legacy channel labels in the product UI."
    Assert-True ($taskStatusController -match 'revAgent Task Status UI') "Task status UI thread should use the product name."

    Write-Host "Test Revit view focus visibility guard"
    $focusHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPViewCommandSet\Commands\View\ElementFocusHelpers.cs")
    $focusHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPViewCommandSet\Commands\View\FocusElementsEventHandler.cs")
    $openPlanCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPViewCommandSet\Commands\View\OpenExistingPlanForElementLevelEventHandler.cs")
    $discoveryCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPViewCommandSet\Commands\View\ElementDiscoveryHelpers.cs")
    Assert-True ($focusHelpersCode -match 'new FilteredElementCollector\(document, view\.Id\)') "View visibility helper must use a view-specific collector."
    Assert-True ($focusHelpersCode -match 'elementNotVisibleInTargetView') "View visibility helper must report non-visible target elements."
    Assert-True ($focusHandlerCode -notmatch 'get_BoundingBox\(view\)') "focus_elements must not use a view bounding box as visibility proof."
    Assert-True ($openPlanCode -match 'FindPlanCandidates\(document, uiDocument, levelId, _planNameContains, _preferMechanical, element\)') "open_existing_plan_for_element_level must rank plans with the target element visibility."
    Assert-True ($openPlanCode -match 'FirstOrDefault\(c => c\.ElementVisibleInView == true\)') "open_existing_plan_for_element_level must select only plans containing the element."
    Assert-True ($discoveryCode -match 'ElementVisibleInView') "Plan candidates must carry element-in-view diagnostics."
    Assert-True ($focusHelpersCode -match 'FocusWarning') "Focus results must expose active-view mismatch diagnostics."

    Write-Host "Test updater version status distinguishes update from restore"
    $versionStatusRoot = Join-Path $tempRoot "version-status"
    $versionWorkRoot = Join-Path $versionStatusRoot "updater"
    New-Item -ItemType Directory -Path $versionWorkRoot -Force | Out-Null
    $channelPath = Join-Path $versionStatusRoot "stable.json"
    $configPath = Join-Path $versionWorkRoot "updater-config.json"
    Write-RevitMcpJsonFile -Path (Join-Path $versionWorkRoot "installed.json") -Value ([ordered]@{
            version = "2026.05.22.localtest-abc"
        })
    Write-RevitMcpJsonFile -Path $configPath -Value ([ordered]@{
            installRoot = $versionStatusRoot
            workRoot = $versionWorkRoot
            channelManifestPath = $channelPath
        })
    Write-RevitMcpJsonFile -Path $channelPath -Value ([ordered]@{
            app = "revit-mcp-skill"
            channel = "stable"
            version = "2026.05.15.1259-b397869c"
        })
    $versionOutput = & (Join-Path $RepoRoot "installer\nas\show-installed-version.ps1") -ConfigPath $configPath 2>&1 6>&1 | Out-String
    Assert-True ($versionOutput -match 'repair/reinstall available') "Newer local/dev install should be reported as repair/reinstall available against an older release target."
    Assert-True ($versionOutput -match 'revAgent status') "Version status window must use the revAgent product name."
    Assert-True ($versionOutput -notmatch 'Revit MCP version status|Install root|Manual update|Config\s+:|Stable|Channel\s+:|Channel version') "Default version status must not expose internal product, path details, or legacy channel wording."

    Write-RevitMcpJsonFile -Path $channelPath -Value ([ordered]@{
            app = "revit-mcp-skill"
            channel = "stable"
            version = "2026.05.23.1000-next"
        })
    $versionOutput = & (Join-Path $RepoRoot "installer\nas\show-installed-version.ps1") -ConfigPath $configPath 2>&1 6>&1 | Out-String
    Assert-True ($versionOutput -match 'update available') "Older install should be reported as update available against a newer release target."

    Write-Host "Test release version identity"
    $publishText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1")
    Assert-True ($publishText -match 'rev-list", "--count", "HEAD"') "Default release version must use a monotonically increasing git build number."
    Assert-True ($publishText -notmatch 'yyyy\.MM\.dd\.HHmm') "Default release version must not use local wall-clock minutes as the version identity."

    Write-Host "Test initial updater invocation binding"
    $installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
    Assert-True ($installTaskText -match '& \$UpdaterPath -ConfigPath \$UpdaterConfigPath -NoNotifyUser -AllowManualCodexSetup') "Initial update check must pass ConfigPath as a named parameter."
    Assert-True ($installTaskText -notmatch '& \$UpdaterPath @arguments') "Initial update check must not array-splat named parameter strings into a script call."

    Write-Host "Test bundled Node MSI path quoting"
    $updaterText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
    Assert-True ($updaterText -match '\$msiArgument\s*=') "update-from-nas.ps1 must build a quoted MSI path argument."
    Assert-True ($updaterText -match 'ArgumentList\s+"/i \$msiArgument /qn /norestart"') "Bundled Node.js MSI install must quote the MSI path before calling msiexec."
    Assert-True ($updaterText -notmatch 'ArgumentList\s+@\("/i",\s*\$msiPath,\s*"/qn",\s*"/norestart"\)') "Bundled Node.js MSI install must not pass an unquoted space-containing path to msiexec."

    Write-Host "Test proxy, Codex config, and report helpers"
    Assert-Equal (ConvertTo-RevitMcpProxyUrl -Value "192.168.90.10 6588") "http://192.168.90.10:6588" "Proxy URL normalization failed."
    Assert-Equal (ConvertTo-RevitMcpWinHttpProxyServer -Value "http://192.168.90.10:6588") "192.168.90.10:6588" "WinHTTP proxy normalization failed."
    $codexConfig = Join-Path $tempRoot "config.toml"
    Register-RevitMcpCodexMcpServersInConfig -ConfigPath $codexConfig -NodePath "node.exe" -RuntimeServerPath "runtime\build\index.js" -DocsServerPath "docs\build\index.js" | Out-Null
    $codexText = Get-Content -Raw -LiteralPath $codexConfig
    Assert-True ($codexText -match '\[mcp_servers\.revit-mcp\]') "Codex runtime MCP section was not written."
    Assert-True ($codexText -match '\[mcp_servers\.revit-api-docs\]') "Codex docs MCP section was not written."
    $report = New-RevitMcpUpdateReport -Status "current" -Message "ok" -PreviousVersion "1" -InstalledVersion "1"
    $reportPath = Join-Path $tempRoot "report.json"
    Write-RevitMcpJsonFile -Path $reportPath -Value $report
    $reportJson = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
    Assert-Equal $reportJson.status "current" "Report JSON status was not written."

    Write-Host "Test updater log retention"
    $logsRoot = Join-Path $tempRoot "logs-retention"
    New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null
    for ($i = 1; $i -le 15; $i++) {
        $path = Join-Path $logsRoot ("update-{0:00}.log" -f $i)
        Set-Content -LiteralPath $path -Value ("log {0}" -f $i) -Encoding ASCII
        (Get-Item -LiteralPath $path).LastWriteTimeUtc = [datetime]::UtcNow.AddMinutes(-1 * (15 - $i))
    }
    Invoke-RevitMcpLogRetention -LogsRoot $logsRoot -KeepLast 10 -ActiveLogPath (Join-Path $logsRoot "update-15.log")
    $remainingLogs = @(Get-ChildItem -LiteralPath $logsRoot -File -Filter "*.log" | Sort-Object Name | Select-Object -ExpandProperty Name)
    Assert-Equal $remainingLogs.Count 10 "Log retention must keep exactly the latest 10 log files."
    Assert-True ($remainingLogs -contains "update-15.log") "Log retention must keep the active/latest log file."
    Assert-True (-not ($remainingLogs -contains "update-01.log")) "Log retention must remove old log files."

    Write-Host "Installer/updater smoke tests passed." -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
