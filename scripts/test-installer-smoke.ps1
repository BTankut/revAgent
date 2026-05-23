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
    $dailyTrigger = New-RevitMcpDailyUpdateTrigger -DailyAt "12:00"
    $dailyTriggerLocalTime = ([datetime]::Parse([string]$dailyTrigger.StartBoundary)).ToLocalTime().ToString("HH:mm")
    Assert-Equal $dailyTriggerLocalTime "12:00" "Scheduled task trigger must run at noon local time."
    Assert-Equal ([int]$dailyTrigger.DaysInterval) 1 "Scheduled task trigger must be daily."
    Assert-True (-not $dailyTrigger.Repetition) "Scheduled task trigger must not repeat during the day."

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
    $unchangedClosed = Get-RevitMcpUpdateDecision -HasReleaseManifest -HasReleaseComponents -RevitPayloadChangeCount 0
    Assert-True $unchangedClosed.SkipRevitPayloadInstall "Unchanged Revit payload should be skipped even when Revit is closed."

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
            "SkipRuntimePayloadInstall",
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
    Assert-True ($guiText -match '\$directUpdaterPath = Join-Path \$PSScriptRoot "update-from-nas\.ps1"') "GUI update action must use the direct updater instead of reinstalling the updater wrapper."
    Assert-True ($guiText -match '\$useDirectUpdate = \$Operation -eq "update"') "GUI must reserve direct updater execution for normal updates."
    Assert-True ($guiText -match '"-File", \$directUpdaterPath') "Normal GUI updates must run update-from-nas.ps1 directly."
    Assert-True ($guiText -match '"-File", \$installerPath') "First install and repair must still use install-updater-task.ps1."
    Assert-True ($guiText -match '\$form\.Text = "revAgent"') "GUI title must use the revAgent product name."
    Assert-True ($guiText -match 'Your AI agent inside Revit\.') "GUI must show the revAgent product tagline."
    Assert-True ($guiText -match '2026 Baris Tankut') "GUI must show the revAgent copyright footer."
    Assert-True ($guiText -match '\$form\.ShowInTaskbar = \$true') "GUI must be visible in the taskbar."
    Assert-True ($guiText -match '\$form\.MinimizeBox = \$true') "GUI must be minimizable."
    Assert-True ($guiText -match '\$logBox\.Text = \$text') "GUI must stream the live installer log into the terminal area."
    Assert-True ($guiText -match '\$logBox\.AppendText\("Operation completed') "GUI must append completion status without replacing the streamed log."
    Assert-True ($guiText -notmatch 'Operation is running\.\.\.`r`nThis can take a few minutes') "GUI must not replace live terminal output with a generic running message."

    Write-Host "Test updater skips unchanged payload surfaces"
    $updateText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
    Assert-True ($updateText -match '\$skipRevitPayloadInstall = \[bool\]\$updateDecision\.SkipRevitPayloadInstall') "Updater must skip unchanged Revit payload even when Revit is closed."
    Assert-True ($updateText -match '\$fastPackageOnlyUpdate = \$skipRevitPayloadInstall -and\s+\$skipRuntimePayloadInstall -and\s+\$skipDocsPayloadWork -and\s+\$skipCodexSkillInstallForThisUpdate -and\s+\$skipCodexMcpRegistrationForThisUpdate') "Fast path must require every payload surface to be unchanged."
    Assert-True ($updateText -match '\$runSelfContainedInstaller = \(-not \$fastPackageOnlyUpdate\)') "Any changed payload surface must route through the self-contained installer."
    Assert-True ($updateText -match 'Test-DirectoryPayloadUnchanged -Manifest \$releaseManifest -ComponentKey "runtimePayload"') "Updater must detect unchanged runtime payloads from the release manifest."
    Assert-True ($updateText -match '\$installArgs\["SkipRuntimePayloadInstall"\] = \$true') "Updater must pass runtime skip to the self-contained installer."
    Assert-True ($updateText -match 'ComponentKey "docsServerPayload"') "Updater must detect unchanged docs payloads from the release manifest."
    Assert-True ($updateText -match '\$installArgs\["SkipCodexSkillInstall"\] = \$true') "Updater must skip unchanged Codex skill integration when the existing install is present."
    Assert-True ($updateText -match 'Codex MCP registration: skipped; runtime/docs entry points unchanged') "Updater must skip MCP registration when runtime/docs entry points are unchanged."
    Assert-True ($updateText -match 'Revit API index: skipped; docs payload unchanged') "Updater must skip docs index rebuild when docs payload is unchanged and the cache exists."
    Assert-True ($updateText -match 'Fast update path : package/updater metadata only; self-contained installer skipped') "Updater must bypass the self-contained installer when all payload surfaces are unchanged."
    Assert-True ($updateText -match 'Install-UpdaterToolsFromPackage -SourceRoot \$nasToolsSource -DestinationRoot \$WorkRoot') "Fast update path must still refresh local updater tools."
    Assert-True ($updateText -match 'Invoke-NpmInstallIfNeeded -NpmPath \$npmPath -WorkingDirectory \$docsServerPath -Label "Documentation server" -CacheRoot \$npmDependencyCacheRoot') "Fast and normal updates must restore docs server node_modules after replacing the package folder."
    Assert-True ($updateText -match 'Documentation server dependencies: skipped by -SkipNpmInstall') "Updater must only skip docs server dependencies when explicitly requested."
    Assert-True ($updateText -notmatch 'Documentation server dependencies: skipped; docs payload unchanged') "Updater must not skip docs server dependencies just because the docs payload is unchanged."
    Assert-True ($updateText -match 'Fast update path failed; falling back to the full repair/install path') "Fast update failures must warn and fall back to the full repair/install path."
    Assert-True ($updateText -match '\$runSelfContainedInstaller = \$true') "Fast update failure must enable the self-contained installer fallback."
    Assert-True ($updateText -match 'fastUpdateFallbackUsed') "Updater reports must record whether the fast path fell back."
    Assert-True ($updateText -match '\.revagent-npm-dependencies\.json') "Updater payload fingerprints must ignore npm dependency marker files."
    Assert-True ($updateText -notmatch 'Repair-RevitMcpScheduledTaskAction -Name \$TaskName') "Normal updates must not run an extra scheduled-task repair before the package installer."
    $publishText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1")
    Assert-True ($publishText -match '\$components\["runtimePayload"\] = Get-DirectoryTreeHash') "Release manifest must include a runtime payload fingerprint."
    Assert-True ($publishText -match '\$components\["docsServerPayload"\] = Get-DirectoryTreeHash') "Release manifest must include a docs payload fingerprint."
    Assert-True ($publishText -match 'foreach \(\$payloadRoot in @\("installer\\revit-plugin", "installer\\command-payload"\)\)') "Release manifest must classify Revit add-in and command payload trees as Revit-close-required."
    Assert-True ($publishText -match 'revitClosedRequiredPaths = @\(\s+"installer\\revit-plugin"\s+"installer\\command-payload"\s+\)') "Release manifest must advertise Revit-close-required payload paths."
    Assert-True ($publishText -match '\.revagent-npm-dependencies\.json') "Release payload fingerprints must ignore npm dependency marker files."
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
    $openPlanCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPViewCommandSet\Commands\View\OpenExistingPlanForElementLevelCommand.cs")
    $openPlanToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\open_existing_plan_for_element_level.ts")
    $discoveryCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPViewCommandSet\Commands\View\ElementDiscoveryHelpers.cs")
    $findCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPViewCommandSet\Commands\View\FindElementsCommand.cs")
    $findToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\find_elements.ts")
    $showPlan3dToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\show_element_in_plan_and_3d.ts")
    $sessionContextToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\get_revit_session_context.ts")
    $instanceListToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\list_revit_instances.ts")
    $viewImageToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\export_revit_view_image.ts")
    $coordinationImageToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\export_revit_coordination_image.ts")
    $create3dToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\create_3d_view_for_elements.ts")
    $toolHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\revitToolHelpers.ts")
    $parameterSchemaToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\inspect_parameter_schema.ts")
    Assert-True ($focusHelpersCode -match 'new FilteredElementCollector\(document, view\.Id\)') "View visibility helper must use a view-specific collector."
    Assert-True ($focusHelpersCode -match 'elementNotVisibleInTargetView') "View visibility helper must report non-visible target elements."
    Assert-True ($focusHandlerCode -notmatch 'get_BoundingBox\(view\)') "focus_elements must not use a view bounding box as visibility proof."
    Assert-True ($openPlanCode -match 'FindPlanCandidates\(document, uiDocument, levelId, _planNameContains, _preferMechanical, element\)') "open_existing_plan_for_element_level must rank plans with the target element visibility."
    Assert-True ($openPlanCode -match 'FindPlanCandidates\(document, uiDocument, levelId, _planNameContains, _preferMechanical, null\)') "open_existing_plan_for_element_level metadata-first mode must avoid scanning every candidate view."
    Assert-True ($openPlanCode -match 'BuildVerifiedCandidateForPlan') "open_existing_plan_for_element_level metadata-first mode must verify the selected plan before focusing."
    Assert-True ($openPlanCode -match 'VerifyMetadataCandidatesInOrder') "open_existing_plan_for_element_level metadata-first mode must verify ranked candidates in order before fallback."
    Assert-True ($openPlanCode -match '_maxMetadataVerifyCandidates') "open_existing_plan_for_element_level metadata-first verification must use a bounded candidate count."
    Assert-True ($openPlanCode -match 'FallbackUsed') "open_existing_plan_for_element_level must report whether full verified fallback was used."
    Assert-True ($openPlanCode -match '_fallbackToVerified') "open_existing_plan_for_element_level must keep verified fallback available."
    Assert-True ($openPlanCommandCode -match 'planCandidateMode') "open_existing_plan_for_element_level command must parse planCandidateMode."
    Assert-True ($openPlanCommandCode -match 'maxMetadataVerifyCandidates') "open_existing_plan_for_element_level command must parse maxMetadataVerifyCandidates."
    Assert-True ($openPlanToolCode -match 'planCandidateMode: z\.enum\(\["metadataFirst", "verified"\]\)') "open_existing_plan_for_element_level tool must expose metadataFirst/verified plan selection."
    Assert-True ($openPlanToolCode -match 'maxMetadataVerifyCandidates: z\.number\(\)\.int\(\)\.min\(1\)\.max\(25\)') "open_existing_plan_for_element_level tool must expose a bounded metadata verification cap."
    Assert-True ($findToolCode -match 'planCandidateMode: z\.enum\(\["none", "metadata", "verified"\]\)') "find_elements must expose explicit plan candidate modes."
    Assert-True ($findCommandCode -match 'planCandidateMode != "none"') "find_elements command must keep plan candidate scans opt-in."
    Assert-True ($discoveryCode -match 'verifyVisibility \? element : null') "metadata plan candidates must avoid expensive per-view element visibility checks."
    Assert-True ($showPlan3dToolCode -match 'responseMode: z\.enum\(\["compact", "full"\]\)') "show_element_in_plan_and_3d must expose compact/full response modes."
    Assert-True ($showPlan3dToolCode -match 'ResponseMode: "compact"') "show_element_in_plan_and_3d must default successful responses to compact summaries."
    Assert-True ($openPlanToolCode -match 'responseMode: z\.enum\(\["compact", "full"\]\)') "open_existing_plan_for_element_level must expose compact/full response modes."
    Assert-True ($openPlanToolCode -match 'function compactPlanResult') "open_existing_plan_for_element_level must compact successful routine responses."
    Assert-True ($openPlanToolCode -match 'ResponseMode: "compact"') "open_existing_plan_for_element_level compact response must identify its response mode."
    Assert-True ($openPlanToolCode -notmatch 'trimmedPayload && trimmedPayload\.Success === false') "open_existing_plan_for_element_level compact mode must stay compact for failure responses."
    Assert-True ($showPlan3dToolCode -match 'responseMode: "full"') "show_element_in_plan_and_3d must request the full nested plan result before building its own compact summary."
    Assert-True ($sessionContextToolCode -match 'apiProbeState') "Session context must move tool-probe modifiable state out of the document summary."
    Assert-True ($sessionContextToolCode -match 'documentIsModifiableDuringProbe') "Session context must label probe-time modifiable state clearly."
    Assert-True ($sessionContextToolCode -notmatch 'apiProbeState\s*=\s*new\s*\{\s*isModifiable\s*=') "Session context must not expose apiProbeState.isModifiable."
    Assert-True ($instanceListToolCode -match 'documentIsModifiableDuringProbe') "Instance list must label probe-time modifiable state clearly."
    Assert-True ($instanceListToolCode -notmatch 'apiProbeState\s*=\s*new\s*\{\s*isModifiable\s*=') "Instance list must not expose apiProbeState.isModifiable."
    Assert-True ($toolHelpersCode -match 'normalizeSuccessCasing') "Runtime formatter must normalize response success casing."
    Assert-True ($toolHelpersCode -match 'delete clone\.Success') "Runtime formatter must emit canonical lowercase success instead of success/Success duplicates."
    Assert-True ($viewImageToolCode -match 'enforcePixelSize') "View image export must expose enforcePixelSize."
    Assert-True ($viewImageToolCode -match 'resizeImageToRequestedPixelSize') "View image export must normalize exported image dimensions after Revit export."
    Assert-True ($create3dToolCode -match 'LIVE_VIEW_NAVIGATION_PRIMITIVE') "create_3d_view_for_elements must identify itself as the live 3D navigation primitive."
    Assert-True ($showPlan3dToolCode -match 'LIVE_VIEW_WORKFLOW_WRAPPER') "show_element_in_plan_and_3d must identify itself as the live plan+3D workflow wrapper."
    Assert-True ($coordinationImageToolCode -match 'VISUAL_ARTIFACT_EXPORT_ONLY') "Coordination image export must identify itself as an image artifact export tool."
    Assert-True ($coordinationImageToolCode -match 'Do not use this as the primary tool for live view navigation') "Coordination image export must warn against live view navigation use."
    Assert-True ($coordinationImageToolCode -match 'singleElementMarginMm') "Coordination image export must expose a tighter single-element margin."
    Assert-True ($coordinationImageToolCode -match 'width = width') "Coordination image export files must report width."
    Assert-True ($coordinationImageToolCode -match 'height = height') "Coordination image export files must report height."
    Assert-True ($coordinationImageToolCode -match 'resizeImageToRequestedPixelSize') "Coordination image export must normalize exported image dimensions after Revit export."
    Assert-True ($coordinationImageToolCode -match 'SetOrientation\(new ViewOrientation3D') "Coordination image export must frame the 3D camera to the target section box."
    Assert-True ($coordinationImageToolCode -match 'cameraFramedToTargets') "Coordination image export must report whether target camera framing was applied."
    Assert-True ($coordinationImageToolCode -match 'cropImageToTargetHighlight') "Coordination image export must post-crop around target highlight pixels when Revit 3D export keeps a wide frame."
    Assert-True ($coordinationImageToolCode -match 'targetMinFillRatio') "Coordination image export must expose a minimum target fill ratio for focused QA crops."
    Assert-True ($coordinationImageToolCode -match 'actualHighlightFillRatio') "Coordination image export must report the actual target-highlight fill ratio."
    Assert-True ($coordinationImageToolCode -match 'SetSurfaceForegroundPatternColor') "Coordination image export must strengthen target overrides with surface fill color."
    Assert-True ($coordinationImageToolCode -match 'g >= 105') "Coordination image export must tolerate anti-aliased green target pixels."
    Assert-True ($coordinationImageToolCode -match 'isTargetYellow') "Coordination image export must detect non-green/yellow Revit target highlight output."
    Assert-True ($coordinationImageToolCode -match 'isTargetHighChroma') "Coordination image export must detect high-chroma Revit target highlight output when exact override colors drift."
    Assert-True ($coordinationImageToolCode -match 'bbox_center_fallback') "Coordination image export must fall back to bounding-box-centered crop when green pixels are not detected."
    Assert-True ($coordinationImageToolCode -match 'image_highlight_crop_bbox_fallback_used') "Coordination image export must report when bbox crop fallback is used."
    Assert-True ($coordinationImageToolCode -match 'image_highlight_crop_actual_pixels_unavailable') "Coordination image export bbox fallback must not present estimated fill ratio as actual pixel fill."
    Assert-True ($coordinationImageToolCode -match 'cropBasis') "Coordination image export must report whether crop came from highlight pixels or bbox fallback."
    Assert-True ($coordinationImageToolCode -match 'estimatedFallbackFillRatio') "Coordination image export must expose estimated fallback fill separately from actual highlight fill."
    Assert-True ($coordinationImageToolCode -match '0\.04 / fallbackSafeFillRatio') "Coordination image export bbox fallback must use a tight center crop when target pixels cannot be measured."
    Assert-True ($coordinationImageToolCode -match 'IgnoreImageCache') "Coordination image export must bypass WPF URI caching so resize uses the cropped image, not the original wide export."
    Assert-True ($coordinationImageToolCode -match 'fallbackSafeFillRatio') "Coordination image export bbox fallback variables must not collide with highlight-crop variables in generated C#."
    Assert-True ($coordinationImageToolCode -match 'highlightCropPaddingPx: z\.number\(\)\.int\(\)\.min\(0\)\.max\(2000\)\.optional\(\)\.default\(24\)') "Coordination image export must use tight default highlight padding so small targets do not stay tiny."
    Assert-True ($coordinationImageToolCode -match 'Math\.Ceiling\(\(double\)maxHighlightDimension / safeFillRatio\)') "Coordination image export must size highlight crops from the minimum fill ratio."
    Assert-True ($coordinationImageToolCode -match 'croppedToTargetHighlight') "Coordination image export must report target-highlight crop results."
    Assert-True ($parameterSchemaToolCode -match 'rawBuiltInParameterAlias') "Parameter schema output must keep raw Revit enum aliases as diagnostic data."
    Assert-True ($openPlanCode -match 'FirstOrDefault\(c => c\.ElementVisibleInView == true\)') "open_existing_plan_for_element_level must select only plans containing the element."
    Assert-True ($openPlanCode -match 'TryUseActivePlanWithoutCandidateScan') "open_existing_plan_for_element_level must short-circuit when the active plan already matches the element level."
    Assert-True ($openPlanCode -match 'active plan already matched element level') "open_existing_plan_for_element_level fast path must report the active-plan selection reason."
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
    Assert-True ($installTaskText -match '\[string\]\$DailyAt = "12:00"') "Updater scheduled-task installer must default to daily noon checks."
    Assert-True ($installTaskText -match 'New-RevitMcpDailyUpdateTrigger -DailyAt \$DailyAt') "Updater scheduled-task installer must use the shared daily trigger helper."
    Assert-True ($installTaskText -notmatch 'New-ScheduledTaskTrigger -AtLogOn') "Updater scheduled task must not run at logon."
    Assert-True ($installTaskText -notmatch 'RepetitionInterval') "Updater scheduled task must not repeat through the day."
    Assert-True ($installTaskText -notmatch 'StartWhenAvailable') "Updater scheduled task must not start immediately for a missed noon trigger during GUI RunNow installs."
    Assert-True ($installTaskText -match 'dailyAt = \$DailyAt') "Updater config must persist the daily check time for future repairs."
    Assert-True ($installTaskText -match 'Task schedule\s+: daily at \$DailyAt') "Updater install output must report the daily schedule."
    $scheduledTaskModuleText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevitMcp.ScheduledTask.psm1")
    Assert-True ($scheduledTaskModuleText -match 'Set-ScheduledTask -TaskName \$Name -Trigger \$trigger') "Updater repair must replace legacy repeated triggers with the daily trigger."
    Assert-True ($scheduledTaskModuleText -match 'Set-ScheduledTask -TaskName \$Name -Trigger \$trigger -Settings \$settings') "Updater repair must clear legacy StartWhenAvailable settings."
    Assert-True ($scheduledTaskModuleText -match 'Set-ScheduledTask -TaskName \$Name -Trigger \$trigger -Settings \$settings -ErrorAction Stop') "Scheduled-task repair permission errors must be caught as warnings."
    Assert-True ($scheduledTaskModuleText -notmatch 'StartWhenAvailable') "Updater scheduled-task repair must not preserve StartWhenAvailable."

    Write-Host "Test bundled Node MSI path quoting"
    $updaterText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
    Assert-True ($updaterText -match '\$msiArgument\s*=') "update-from-nas.ps1 must build a quoted MSI path argument."
    Assert-True ($updaterText -match 'ArgumentList\s+"/i \$msiArgument /qn /norestart"') "Bundled Node.js MSI install must quote the MSI path before calling msiexec."
    Assert-True ($updaterText -notmatch 'ArgumentList\s+@\("/i",\s*\$msiPath,\s*"/qn",\s*"/norestart"\)') "Bundled Node.js MSI install must not pass an unquoted space-containing path to msiexec."
    Assert-True ($updaterText -match 'function Invoke-NpmInstallIfNeeded') "Updater must gate npm install behind a dependency-current check."
    Assert-True ($updaterText -match 'function Test-NpmDependenciesCurrent') "Updater must check node_modules and the dependency fingerprint before npm install."
    Assert-True ($updaterText -match '\.revagent-npm-dependencies\.json') "Updater must persist an npm dependency marker for future skips."
    Assert-True ($updaterText -match 'npm install skipped') "Updater logs must make skipped npm dependency installs visible."
    Assert-True ($updaterText -match 'dependencies\\npm') "Updater must use the managed local npm dependency cache."
    Assert-True ($updaterText -match 'Restore-NpmDependenciesFromCache') "Updater must restore matching npm dependencies from cache before installing."
    Assert-True ($updaterText -match 'Remove-StaleNpmDependencyJunction') "Updater must remove stale cached dependency junctions before refreshing."
    Assert-True ($updaterText -match 'Invoke-NpmInstallIfNeeded -NpmPath \$npmPath -WorkingDirectory \$ServerTarget .* -CacheRoot \$npmDependencyCacheRoot') "Runtime npm install must use the dependency gate."
    Assert-True ($updaterText -match 'Invoke-NpmInstallIfNeeded -NpmPath \$npmPath -WorkingDirectory \$docsServerPath .* -CacheRoot \$npmDependencyCacheRoot') "Docs server npm install must use the dependency gate."
    Assert-True ($updaterText.IndexOf('Already up to date.') -lt $updaterText.IndexOf('Initialize-RevitMcpWorkstationProxy -ProxyUrl')) "No-op current updates must return before proxy setup."
    Assert-True ($updaterText.IndexOf('Already up to date.') -lt $updaterText.IndexOf('Ensure-UpdateDependencies -SkipNpmInstall')) "No-op current updates must return before Node/Codex/npm dependency checks."
    Assert-True ($updaterText.IndexOf('deferred-revit-close-required') -lt $updaterText.IndexOf('Ensure-UpdateDependencies -SkipNpmInstall')) "Revit-close deferrals must return before Node/Codex/npm dependency checks."
    Assert-True ($updaterText -match '\$Status -eq "updated"') "Completed version transition must only be reported for successful updates."
    Assert-True ($updaterText -match 'pendingVersionTransition') "Deferred or available updates must be reported as pending, not completed transitions."
    $statusText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\show-installed-version.ps1")
    Assert-True ($statusText -match 'Pending update') "Status output must label deferred updates as pending updates."

    Write-Host "Test proxy, Codex config, and report helpers"
    Assert-Equal (ConvertTo-RevitMcpProxyUrl -Value "192.168.90.10 6588") "http://192.168.90.10:6588" "Proxy URL normalization failed."
    Assert-Equal (ConvertTo-RevitMcpWinHttpProxyServer -Value "http://192.168.90.10:6588") "192.168.90.10:6588" "WinHTTP proxy normalization failed."
    $codexConfig = Join-Path $tempRoot "config.toml"
    Register-RevitMcpCodexMcpServersInConfig -ConfigPath $codexConfig -NodePath "node.exe" -RuntimeServerPath "runtime\build\index.js" -DocsServerPath "docs\build\index.js" | Out-Null
    $codexText = Get-Content -Raw -LiteralPath $codexConfig
    Assert-True ($codexText -match '\[mcp_servers\.revit-mcp\]') "Codex runtime MCP section was not written."
    Assert-True ($codexText -match '\[mcp_servers\.revit-api-docs\]') "Codex docs MCP section was not written."
    Assert-True ($codexText -match '(?m)^\[features\]\s*$') "Codex features section was not written."
    Assert-True ($codexText -match '(?m)^memories\s*=\s*true\s*$') "Codex memories feature was not enabled."
    Assert-True ($codexText -match '(?m)^chronicle\s*=\s*false\s*$') "Codex chronicle feature was not disabled."
    Assert-True ($codexText -match '(?m)^\[memories\]\s*$') "Codex memories section was not written."
    Assert-True ($codexText -match '(?m)^disable_on_external_context\s*=\s*true\s*$') "Codex external-context memory guard was not enabled."
    Assert-True ($codexText -match '(?m)^generate_memories\s*=\s*true\s*$') "Codex memory generation was not enabled."
    Assert-True ($codexText -match '(?m)^use_memories\s*=\s*true\s*$') "Codex memory use was not enabled."
    Register-RevitMcpCodexMcpServersInConfig -ConfigPath $codexConfig -NodePath "node.exe" -RuntimeServerPath "runtime\build\index.js" -DocsServerPath "docs\build\index.js" | Out-Null
    $codexTextAfterSecondWrite = Get-Content -Raw -LiteralPath $codexConfig
    Assert-Equal ([regex]::Matches($codexTextAfterSecondWrite, '(?m)^\[features\]\s*$').Count) 1 "Codex features section must not be duplicated."
    Assert-Equal ([regex]::Matches($codexTextAfterSecondWrite, '(?m)^\[memories\]\s*$').Count) 1 "Codex memories section must not be duplicated."
    Assert-Equal ([regex]::Matches($codexTextAfterSecondWrite, '(?m)^memories\s*=\s*true\s*$').Count) 1 "Codex memories feature must not be duplicated."
    Assert-True ($updaterText -match 'Set-RevitMcpCodexMemoryConfig') "Updater must enforce Codex memory config, including fast/no-op update paths."
    Assert-True ($updaterText -match 'Remove-CodexProfileBackupArtifacts') "Updater must clean old Codex profile backup artifacts."
    $installerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\install-self-contained.ps1")
    Assert-True ($installerText -match 'Set-RevitMcpCodexMemoryConfig') "Installer must enforce Codex memory config."
    Assert-True ($installerText -match 'Remove-CodexProfileBackupArtifacts') "Installer must clean old Codex profile backup artifacts."
    Assert-True ($installerText -notmatch 'Copy-Item[^\r\n]*AGENTS\.md\.backup-') "Installer must not create AGENTS.md backup files."
    Assert-True ($installerText -notmatch 'Move-Item[^\r\n]*revit-mcp\.backup|codexSkillBackupsRoot') "Installer must not create Codex skill backup directories."
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
    $backupRoot = Join-Path $tempRoot "backup-retention"
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    for ($i = 1; $i -le 6; $i++) {
        $path = Join-Path $backupRoot ("revit-mcp-skill.backup-{0:00}" -f $i)
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        (Get-Item -LiteralPath $path).LastWriteTimeUtc = [datetime]::UtcNow.AddMinutes(-1 * (6 - $i))
    }
    Invoke-RevitMcpDirectoryRetention -Root $backupRoot -Filter "revit-mcp-skill.backup-*" -KeepLast 3
    $remainingBackups = @(Get-ChildItem -LiteralPath $backupRoot -Directory -Filter "revit-mcp-skill.backup-*" | Sort-Object Name | Select-Object -ExpandProperty Name)
    Assert-Equal $remainingBackups.Count 3 "Backup retention must keep exactly the latest 3 package backup folders."
    Assert-True ($remainingBackups -contains "revit-mcp-skill.backup-06") "Backup retention must keep the latest package backup folder."
    Assert-True (-not ($remainingBackups -contains "revit-mcp-skill.backup-01")) "Backup retention must remove old package backup folders."

    Write-Host "Installer/updater smoke tests passed." -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
