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

Import-Module (Join-Path $libRoot "RevAgent.HiddenLauncher.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.ScheduledTask.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.Permissions.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.Package.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.RevitVersions.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.UpdatePolicy.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.Proxy.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.LogRetention.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.CodexRegistration.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.Reporting.psm1") -Force
Import-Module (Join-Path $libRoot "RevAgent.License.psm1") -Force

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

function Assert-NoLocalizedRevitPluginSourceText {
    param([string]$Root)

    $sourceFiles = Get-ChildItem -LiteralPath (Join-Path $Root "src\revit-plugin") -Recurse -File |
        Where-Object { $_.FullName -notmatch '\\(bin|obj)\\' -and @(".cs", ".xaml", ".json") -contains $_.Extension }
    $localizedPattern = '[\u4E00-\u9FFF]|[\u3000-\u303F]|[\uFF00-\uFFEF]|[\u00C0-\u00FF]|\uFFFD'
    $offenders = @()

    foreach ($file in $sourceFiles) {
        $content = Get-Content -Raw -LiteralPath $file.FullName
        if ($content -match $localizedPattern) {
            $offenders += $file.FullName.Substring($Root.Length + 1)
        }
    }

    Assert-Equal $offenders.Count 0 ("Revit plugin source must stay English-only. Offending files: " + ($offenders -join ", "))
}

function Assert-InstallerLibModuleRenameContract {
    param([string]$Root)

    $libRoot = Join-Path $Root "installer\lib"
    $moduleNames = @(
        "CodexRegistration",
        "ConfigSync",
        "DistributionIntegrity",
        "HiddenLauncher",
        "License",
        "LogRetention",
        "Package",
        "Permissions",
        "Proxy",
        "Reporting",
        "RevitVersions",
        "ScheduledTask",
        "SourceFreeMigration",
        "UpdatePolicy"
    )

    foreach ($moduleName in $moduleNames) {
        $canonicalName = "RevAgent.$moduleName.psm1"
        $legacyName = "RevitMcp.$moduleName.psm1"
        $canonicalPath = Join-Path $libRoot $canonicalName
        $legacyPath = Join-Path $libRoot $legacyName
        Assert-True (Test-Path -LiteralPath $canonicalPath -PathType Leaf) "Canonical installer lib module is missing: $canonicalName"
        Assert-True (Test-Path -LiteralPath $legacyPath -PathType Leaf) "Legacy compatibility installer lib wrapper is missing: $legacyName"
        $legacyText = Get-Content -Raw -LiteralPath $legacyPath
        Assert-True ($legacyText -match [regex]::Escape($canonicalName)) "Legacy installer lib wrapper must import $canonicalName."
        Assert-True ($legacyText -match 'Compatibility wrapper') "Legacy installer lib wrapper must declare compatibility intent."
    }
}

function Assert-InstallerLibFunctionAliasContract {
    param([string]$Root)

    $libRoot = Join-Path $Root "installer\lib"
    Get-ChildItem -LiteralPath $libRoot -Filter "RevAgent.*.psm1" |
        Sort-Object Name |
        ForEach-Object {
            $module = Import-Module $_.FullName -Force -PassThru
            $legacyFunctions = @($module.ExportedFunctions.Keys | Where-Object { $_ -match "RevitMcp" } | Sort-Object)
            foreach ($legacyFunction in $legacyFunctions) {
                $aliasName = $legacyFunction -replace "RevitMcp", "RevAgent"
                Assert-True ($module.ExportedAliases.ContainsKey($aliasName)) ("Missing revAgent function alias '$aliasName' for '$legacyFunction' in $($_.Name).")
            }
            if ($_.Name -eq "RevAgent.Proxy.psm1") {
                $canonicalFunctions = @($module.ExportedFunctions.Keys | Where-Object { $_ -match "RevAgent" } | Sort-Object)
                foreach ($canonicalFunction in $canonicalFunctions) {
                    $aliasName = $canonicalFunction -replace "RevAgent", "RevitMcp"
                    Assert-True ($module.ExportedAliases.ContainsKey($aliasName)) ("Missing legacy compatibility alias '$aliasName' for '$canonicalFunction' in $($_.Name).")
                }
            }
        }
}

$tempRoot = Join-Path $env:TEMP ("revit-mcp-smoke-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    Write-Host "Test installer lib module rename contract"
    Assert-InstallerLibModuleRenameContract -Root $RepoRoot

    Write-Host "Test installer lib function alias contract"
    Assert-InstallerLibFunctionAliasContract -Root $RepoRoot

    Write-Host "Test hidden VBS launcher"
    $exitScript = Join-Path $tempRoot "exit-7.ps1"
    Set-Content -LiteralPath $exitScript -Value "exit 7" -Encoding ASCII
    $launcher = Join-Path $tempRoot "hidden-launcher.vbs"
    Write-RevAgentHiddenPowerShellLauncher -LauncherPath $launcher -ScriptPath $exitScript -WaitForExit
    $launcherLines = @(Get-Content -LiteralPath $launcher)
    Assert-Equal $launcherLines.Count 1 "Hidden launcher must be a single VBS line."
    Assert-True ($launcherLines[0] -match '^WScript\.Quit CreateObject\("WScript\.Shell"\)\.Run\(') "Hidden launcher must propagate WScript exit code."
    $cscript = Join-Path $env:WINDIR "System32\cscript.exe"
    & $cscript //B //Nologo $launcher
    Assert-Equal $LASTEXITCODE 7 "Hidden launcher did not propagate child PowerShell exit code."

    Write-Host "Test scheduled task action"
    $action = New-RevAgentHiddenUpdaterScheduledTaskAction -LauncherPath $launcher
    Assert-True ([string]$action.Execute -match 'wscript\.exe$') "Scheduled task action must use wscript.exe."
    Assert-True ([string]$action.Execute -notmatch 'powershell\.exe$') "Scheduled task action must not execute powershell.exe directly."
    Assert-True ([string]$action.Arguments -match [regex]::Escape($launcher)) "Scheduled task action must point at the hidden VBS launcher."
    $dailyTrigger = New-RevAgentDailyUpdateTrigger -DailyAt "12:00"
    $dailyTriggerLocalTime = ([datetime]::Parse([string]$dailyTrigger.StartBoundary)).ToLocalTime().ToString("HH:mm")
    Assert-Equal $dailyTriggerLocalTime "12:00" "Scheduled task trigger must run at noon local time."
    Assert-Equal ([int]$dailyTrigger.DaysInterval) 1 "Scheduled task trigger must be daily."
    Assert-True (-not $dailyTrigger.Repetition) "Scheduled task trigger must not repeat during the day."

    Write-Host "Test permission repair target plan"
    $permissionsText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.Permissions.psm1")
    Assert-True ($permissionsText -match '\$Recurse -or \$CreateDirectory') "Managed directory permission repair must grant inheritable access for future child files."
    $targets = Get-RevAgentManagedPermissionTargets `
        -InstallRoot "C:\ProgramData\DPE\revAgent" `
        -WorkRoot "C:\ProgramData\DPE\revAgent\updater" `
        -PackageTarget "C:\ProgramData\DPE\revAgent\package" `
        -ServerTarget "C:\ProgramData\DPE\revAgent\runtime" `
        -AllUsersAddinRoot "C:\ProgramData\Autodesk\Revit\Addins\2022" `
        -RevitVersion 2022 `
        -IncludeExistingPayloadTrees
    Assert-True (($targets | Where-Object { $_.Path -match 'node_modules|backups' }).Count -eq 0) "Permission repair plan must not target node_modules or backups."
    $updaterLibPermissionTargets = @($targets | Where-Object {
            $leaf = Split-Path -Leaf $_.Path
            ($leaf -eq "lib") -and ([bool]$_.Recurse)
        })
    Assert-True ($updaterLibPermissionTargets.Count -eq 1) "Permission repair plan must recursively cover the local updater lib root."
    $migrationPermissionTargets = @($targets | Where-Object {
            $leaf = Split-Path -Leaf $_.Path
            ($leaf -eq "migrate-source-free-install.ps1") -and ([string]$_.Kind -eq "File")
        })
    Assert-True ($migrationPermissionTargets.Count -eq 1) "Permission repair plan must cover the local migration tool so non-admin updater repair can overwrite it."
    $recursiveLeaves = @($targets | Where-Object { $_.Recurse } | ForEach-Object { Split-Path -Leaf $_.Path })
    foreach ($leaf in $recursiveLeaves) {
        Assert-True ($leaf -in @("lib", "revAgentPlugin", "revit_mcp_plugin", "CommandSet", "runtime", "revAgent")) "Unexpected recursive permission target: $leaf"
    }

    Write-Host "Test Revit payload update policy"
    $changedRunning = Get-RevAgentUpdateDecision -HasReleaseManifest -HasReleaseComponents -RevitPayloadChangeCount 1 -IsRevitRunning
    Assert-True $changedRunning.RequiresRevitClosed "Changed Revit payload must require Revit closed."
    Assert-True $changedRunning.DeferForRevitClose "Changed Revit payload must defer while Revit is running."
    Assert-True (-not $changedRunning.SkipRevitPayloadInstall) "Changed Revit payload must not skip and continue."
    $unchangedRunning = Get-RevAgentUpdateDecision -HasReleaseManifest -HasReleaseComponents -RevitPayloadChangeCount 0 -IsRevitRunning
    Assert-True (-not $unchangedRunning.RequiresRevitClosed) "Unchanged Revit payload must not require Revit closed."
    Assert-True (-not $unchangedRunning.DeferForRevitClose) "Unchanged Revit payload must not defer while Revit is running."
    Assert-True $unchangedRunning.SkipRevitPayloadInstall "Unchanged Revit payload should skip active Revit files and continue."
    $unchangedClosed = Get-RevAgentUpdateDecision -HasReleaseManifest -HasReleaseComponents -RevitPayloadChangeCount 0
    Assert-True $unchangedClosed.SkipRevitPayloadInstall "Unchanged Revit payload should be skipped even when Revit is closed."

    Write-Host "Test package path and layout resolution"
    $packageRoot = Join-Path $tempRoot "package"
    New-Item -ItemType Directory -Path (Join-Path $packageRoot "installer\revit-api-docs-mcp") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $packageRoot "installer\install-self-contained.ps1") -Value "# test" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $packageRoot "installer\revit-api-docs-mcp\package.json") -Value "{}" -Encoding ASCII
    $layout = Resolve-RevAgentPackageLayout -Root $packageRoot
    Assert-Equal $layout.installerRelativePath "installer\install-self-contained.ps1" "Installer layout resolution failed."
    Assert-Equal $layout.docsServerRelativePath "installer\revit-api-docs-mcp" "Docs server layout resolution failed."
    $releasePath = Resolve-RevAgentReleasePath -Path "releases\pkg.zip" -BaseDirectory "\\nas\share\channels"
    Assert-Equal $releasePath "\\nas\share\channels\releases\pkg.zip" "Relative release path resolution failed."

    Write-Host "Test Revit version matrix"
    $v2022 = Get-RevAgentVersionConfig -Version 2022 -RepoRoot $RepoRoot
    Assert-Equal $v2022.targetFramework "net48" "Revit 2022 target framework changed."
    Assert-RevAgentInstallerPayloadAvailable -Version 2022 -RepoRoot $RepoRoot
    $matrix = Get-RevAgentVersionMatrix -RepoRoot $RepoRoot
    $configuredVersions = @($matrix.versions.PSObject.Properties.Name | Sort-Object)
    Assert-Equal ($configuredVersions -join ",") "2022,2023,2024,2025" "Only Revit 2022-2025 should be modeled in the branch matrix."
    $blocked = $false
    try {
        Assert-RevAgentInstallerPayloadAvailable -Version 2023 -RepoRoot $RepoRoot
    }
    catch {
        $blocked = $true
    }
    Assert-True $blocked "Revit 2023 must remain blocked until real payload artifacts are bundled."
    $portableRoot = Join-Path $tempRoot "portable-tools"
    New-Item -ItemType Directory -Path (Join-Path $portableRoot "lib") -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $libRoot "RevAgent.RevitVersions.psm1") -Destination (Join-Path $portableRoot "lib\RevAgent.RevitVersions.psm1") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "config") -Destination (Join-Path $portableRoot "config") -Recurse -Force
    Import-Module (Join-Path $portableRoot "lib\RevAgent.RevitVersions.psm1") -Force
    $portable2022 = RevAgent.RevitVersions\Get-RevAgentVersionConfig -Version 2022
    Assert-Equal $portable2022.buildConfiguration "Release R22" "Portable updater lib/config version matrix lookup failed."
    Import-Module (Join-Path $libRoot "RevAgent.RevitVersions.psm1") -Force

    Write-Host "Test C# Revit project configurations"
    $legacyRevitConfigPattern = '(?<!\d)(2020|2021)(?!\d)|\bR20\b|\bR21\b'
    foreach ($relativePath in @(
            "src\revit-plugin\revAgentPlugin.sln",
            "src\revit-plugin\revAgentPlugin\revAgentPlugin.csproj",
            "src\revit-plugin\revAgentCommandSet\revAgentCommandSet.csproj"
        )) {
        $projectText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot $relativePath)
        Assert-True ($projectText -notmatch $legacyRevitConfigPattern) "$relativePath still contains legacy Revit 2020/2021 build configuration."
    }

    Write-Host "Test revAgent environment alias contract"
    $connectionManagerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\ConnectionManager.ts")
    $socketClientText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\SocketClient.ts")
    $runtimePackageText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\package.json")
    $revAgentEnvironmentText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\RevAgentEnvironment.cs")
    $applicationText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\Application.cs")
    $socketServiceText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\SocketService.cs")
    $versionInfoText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\McpVersionInfo.cs")
    Assert-True ($connectionManagerText -match 'REVAGENT_HOST' -and $connectionManagerText -match 'REVIT_MCP_HOST') "Runtime connection manager must keep revAgent env names with legacy fallbacks."
    Assert-True ($connectionManagerText -match 'REVAGENT_TARGET' -and $connectionManagerText -match 'REVIT_MCP_TARGET') "Runtime target resolution must support revAgent and legacy target env names."
    Assert-True ($connectionManagerText -match 'REVAGENT_PORTS' -and $connectionManagerText -match 'REVIT_MCP_PORTS') "Runtime port scanning must support revAgent and legacy port-list env names."
    Assert-True ($socketClientText -match 'REVAGENT_FRAMING' -and $socketClientText -match 'REVIT_MCP_FRAMING') "Socket framing override must support revAgent and legacy env names."
    Assert-True ($runtimePackageText -match '"name"\s*:\s*"revagent-runtime"') "Runtime npm package identity must use the canonical revAgent package name."
    Assert-True ($runtimePackageText -match '"revagent-runtime"\s*:\s*"\./build/index\.js"' -and $runtimePackageText -match '"revit-mcp"\s*:\s*"\./build/index\.js"') "Runtime npm bin map must expose canonical revAgent command while retaining the legacy command alias."
    Assert-True ($runtimePackageText -match 'env-alias-test') "Runtime npm test must include the environment alias contract test."
    Assert-True ($revAgentEnvironmentText -match 'class RevAgentEnvironment' -and $revAgentEnvironmentText -match 'Environment\.GetEnvironmentVariable') "Revit add-in must centralize env alias reads."
    Assert-True ($applicationText -match 'REVAGENT_AUTOSTART' -and $applicationText -match 'REVIT_MCP_AUTOSTART') "Revit add-in autostart must support revAgent and legacy env names."
    Assert-True ($socketServiceText -match 'REVAGENT_MAX_MESSAGE_BYTES' -and $socketServiceText -match 'REVIT_MCP_MAX_MESSAGE_BYTES') "Revit add-in message size override must support revAgent and legacy env names."
    Assert-True ($socketServiceText -match 'REVAGENT_PLUGIN_PORT' -and $socketServiceText -match 'REVAGENT_PORT' -and $socketServiceText -match 'REVIT_MCP_PLUGIN_PORT' -and $socketServiceText -match 'REVIT_MCP_PORT') "Revit add-in port override must support revAgent and legacy env names."
    Assert-True ($versionInfoText -match 'REVAGENT_INSTALLED_STATE' -and $versionInfoText -match 'REVIT_MCP_INSTALLED_STATE') "Revit add-in installed-state override must support revAgent and legacy env names."

    Write-Host "Test dynamic commandset transaction and reference guards"
    $executeCodeHandler = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\ExecuteDynamicCode\ExecuteCodeEventHandler.cs")
    Assert-True ($executeCodeHandler -match 'ContainsManualTransaction') "Dynamic commandset must detect manual transaction snippets."
    Assert-True ($executeCodeHandler -match 'manual_transaction_requires_transactionMode_none') "Manual transaction snippets in auto mode must be classified as guarded safety blocks."
    Assert-True ($executeCodeHandler -match 'JsonProperty\("guarded"\)') "Dynamic execution results must expose guarded for the status UI."
    Assert-True ($executeCodeHandler -match 'GetMetadataReferences') "Dynamic commandset must centralize metadata reference collection."
    Assert-True ($executeCodeHandler -match 'Dictionary<string, Assembly> chosen') "Dynamic commandset must de-duplicate loaded assemblies by simple name."
    Assert-True ($executeCodeHandler -notmatch 'ResultInfo\.Result\s*=\s*JsonConvert\.SerializeObject\(result\)') "Dynamic execution must not double-encode JSON-looking object results."
    Assert-True ($executeCodeHandler -match 'public JToken Result \{ get; set; \}') "Dynamic execution result payload must carry a JSON token/object."
    Assert-True ($executeCodeHandler -match 'CreateSafeResultToken\(result\)') "Dynamic execution result payload must use the safe null/primitive/fallback token helper."
    $liveCommandsetTest = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\test-commandset-live.ps1")
    Assert-True ($liveCommandsetTest -match 'Assert-RevitMcpReady') "Live commandset integration gate must status-check before non-status commands."
    Assert-True ($liveCommandsetTest -match 'transactionMode auto') "Live commandset integration gate must cover transactionMode auto."
    Assert-True ($liveCommandsetTest -match 'transactionMode none') "Live commandset integration gate must cover transactionMode none."
    Assert-True ($liveCommandsetTest -match 'manual_transaction_requires_transactionMode_none') "Live commandset integration gate must assert the manual transaction guard reason."
    Assert-True ($liveCommandsetTest -match 'Newtonsoft\.Json\.JsonConvert') "Live commandset integration gate must cover Newtonsoft dynamic compilation."
    Assert-True ($liveCommandsetTest -match 'find_elements' -and $liveCommandsetTest -match 'needs_scope') "Live commandset integration gate must cover find_elements guarded needs_scope behavior."
    Assert-True ($liveCommandsetTest -match 'Mechanical Equipment' -and $liveCommandsetTest -match 'scanPolicy\.searchBudget') "Live commandset integration gate must cover category-bounded find_elements search policy metadata."
    Assert-True ($liveCommandsetTest -match 'scanStoppedReason' -and $liveCommandsetTest -match 'max_scanned') "Live commandset integration gate must cover bounded find_elements partial metadata."
    Assert-True ($liveCommandsetTest -match 'inspect_sheet_text' -and $liveCommandsetTest -match 'includeViewportTextNotes' -and $liveCommandsetTest -match 'includeViewportTags' -and $liveCommandsetTest -match 'viewportTag') "Live commandset integration gate must cover native sheet viewport text and tag evidence behavior."
    Assert-True ($liveCommandsetTest -match 'count_annotations' -and $liveCommandsetTest -match 'invalid_count_mode_for_sources' -and $liveCommandsetTest -match 'uniqueTag') "Live commandset integration gate must cover native annotation count inventory and tag count validation behavior."
    Assert-True ($liveCommandsetTest -match 'max_elapsed' -and $liveCommandsetTest -match 'max_bytes' -and $liveCommandsetTest -match 'max_schedule_cells') "Live commandset integration gate must cover native sheet annotation budget stop reasons."
    Assert-True ($liveCommandsetTest -match 'inspect_schedules' -and $liveCommandsetTest -match 'maxCells' -and $liveCommandsetTest -match 'lastReadRow' -and $liveCommandsetTest -match 'max_bytes') "Live commandset integration gate must cover native schedule partial and continuation behavior."
    Assert-True ($liveCommandsetTest -match 'schedule empty footer' -and $liveCommandsetTest -match 'rowCount' -and $liveCommandsetTest -match 'columnCount' -and $liveCommandsetTest -match 'readFailed' -and $liveCommandsetTest -match 'Object reference not set') "Live commandset integration gate must verify that missing schedule footer data is returned as a normal empty section."
    Assert-True ($liveCommandsetTest -match 'MTL fan coil' -and $liveCommandsetTest -match 'live broad MTL guard proof') "Live commandset integration gate must cover runtime MEP inference and broad-query guard behavior."
    Assert-True ($liveCommandsetTest -notmatch 'runtime\\build\\tools\\register\.js' -and $liveCommandsetTest -notmatch 'REVAGENT_LIVE_RUNTIME_REGISTER') "Live commandset integration gate must not depend on dev-only runtime register.js files in source-free installs."
    Assert-True ($liveCommandsetTest -match 'clear_selection' -and $liveCommandsetTest -match 'selectionCountAfter') "Live commandset integration gate must cover clear_selection cleanup behavior."
    Assert-True ($liveCommandsetTest -match 'delete_review_view' -and $liveCommandsetTest -match 'delete_confirmation_required' -and $liveCommandsetTest -match 'deleted') "Live commandset integration gate must cover guarded review-view delete dry-run and commit behavior."
    Assert-True ($liveCommandsetTest -match '\[string\]\$SmokeEvidencePath' -and $liveCommandsetTest -match 'live-smoke-latest\.json') "Live commandset integration gate must support writing rollout live-smoke evidence."
    Assert-True ($liveCommandsetTest -match 'stableVersion = \$StableVersion' -and $liveCommandsetTest -match 'stableCommit = \$StableCommit' -and $liveCommandsetTest -match 'passed = \$true') "Live smoke evidence must identify stable version/commit and a passed result."
    Assert-NoLocalizedRevitPluginSourceText -Root $RepoRoot
    $commandSetSourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet") -Recurse -File -Filter *.cs |
        Where-Object { $_.FullName -notmatch '\\(bin|obj)\\' } |
        ForEach-Object { $_.FullName.Substring($RepoRoot.Length + 1).Replace('/', '\') } |
        Sort-Object)
    $expectedCommandSetSourceFiles = @(
        "src\revit-plugin\revAgentCommandSet\Commands\Access\GetCurrentViewElementsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Access\GetCurrentViewInfoCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Access\GetSelectedElementsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\ExecuteDynamicCode\ExecuteCodeCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\ExecuteDynamicCode\ExecuteCodeEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\ExtractSpatialSnapshotCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\ExtractSpatialSnapshotEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\SpatialSnapshotContracts.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\Spatial\SpatialSnapshotHelpers.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ActivateViewCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ActivateViewEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\AnnotationEvidenceHelpers.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ClearSelectionCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ClearSelectionEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\CloseViewCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\CloseViewEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\CountAnnotationsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\CountAnnotationsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\Create3DViewForElementsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\Create3DViewForElementsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\DeleteReviewViewCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\DeleteReviewViewEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ElementDiscoveryHelpers.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ElementFocusHelpers.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\FindElementsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\FindElementsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\FocusElementsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\FocusElementsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\GetUiStateCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\GetUiStateEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSchedulesCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSchedulesEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSheetTextCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSheetTextEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ListOpenViewsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ListOpenViewsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\OpenExistingPlanForElementLevelCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\OpenExistingPlanForElementLevelEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\SectionBoxElementsCommand.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\SectionBoxElementsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Commands\View\ViewCommandHelpers.cs",
        "src\revit-plugin\revAgentCommandSet\Extensions\RevitApiCompatibilityExtensions.cs",
        "src\revit-plugin\revAgentCommandSet\Models\Common\ElementInfo.cs",
        "src\revit-plugin\revAgentCommandSet\Models\Common\ViewElementsResult.cs",
        "src\revit-plugin\revAgentCommandSet\Models\Common\ViewInfo.cs",
        "src\revit-plugin\revAgentCommandSet\Services\GetCurrentViewElementsEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Services\GetCurrentViewInfoEventHandler.cs",
        "src\revit-plugin\revAgentCommandSet\Services\GetSelectedElementsEventHandler.cs"
    )
    Assert-Equal ($commandSetSourceFiles -join "|") ($expectedCommandSetSourceFiles -join "|") "revAgentCommandSet must contain the complete production bridge command source surface."

    Write-Host "Test Revit command registry includes the unified bridge command tools"
    Assert-True (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revAgent.addin") -PathType Leaf) "revAgent add-in manifest must be packaged with the product name."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\mcp-servers-for-revit.addin"))) "Legacy mcp-servers-for-revit add-in manifest must not be packaged."
    Assert-True (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revAgentPlugin\revAgentPlugin.dll") -PathType Leaf) "revAgent plugin DLL must be packaged with the product name."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revit_mcp_plugin"))) "Legacy revit_mcp_plugin payload folder must not be packaged."
    Assert-True (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\command-payload\revAgentCommandSet.dll") -PathType Leaf) "revAgent command payload DLL must be packaged with the product name."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\command-payload\RevitMCPCommandSet.dll"))) "Legacy RevitMCPCommandSet command payload DLL must not be packaged."
    $bridgeCommandJson = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revAgentPlugin\Commands\revAgentCommandSet\command.json") | ConvertFrom-Json
    $commandRegistry = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revAgentPlugin\Commands\commandRegistry.json") | ConvertFrom-Json
    $registeredCommandNames = @($commandRegistry.Commands | ForEach-Object { [string]$_.commandName })
    foreach ($name in @($bridgeCommandJson.commands | ForEach-Object { [string]$_.commandName })) {
        Assert-True ($registeredCommandNames -contains $name) "commandRegistry.json is missing Revit bridge command '$name'."
    }
    Assert-True ($registeredCommandNames -contains "extract_spatial_snapshot") "commandRegistry.json must include the read-only Phase 0 spatial extractor."
    foreach ($path in @($commandRegistry.Commands | ForEach-Object { [string]$_.assemblyPath })) {
        Assert-Equal $path "revAgentCommandSet\\2022\\revAgentCommandSet.dll" "Bridge command registry must load every command from the revAgent bridge payload folder."
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revAgentPlugin\Commands\RevitMCPCommandSet"))) "Legacy RevitMCPCommandSet payload folder must not be packaged."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revAgentPlugin\Commands\RevitMCPViewCommandSet"))) "Legacy RevitMCPViewCommandSet payload folder must not be packaged."

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
            "CodexInstructionPolicy",
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
    foreach ($name in @("ChannelManifestPath", "RunNow", "ForceUpdate", "CodexInstructionPolicy", "RunSourceFreeMigration")) {
        Assert-True ($updaterTaskParams -contains $name) "install-updater-task.ps1 lost public parameter -$name."
    }

    Write-Host "Test GUI updater exposes update and restore actions"
    $guiText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Install-revAgent-Updater-GUI.ps1")
    Assert-True ($guiText -match 'Install/Repair') "GUI must expose a separate install/repair button."
    Assert-True ($guiText -match '-ForceUpdate') "GUI restore action must force the channel package install."
    Assert-True ($guiText -match '-OperationMethod", \$operationMethod') "GUI operations must pass the visible install/update method to child logs."
    Assert-True ($guiText -match 'UpdateEnabled') "GUI must gate the update button from channel status."
    Assert-True ($guiText -match '\$localUpdaterPath = Join-Path \$workRoot "update-from-nas\.ps1"' -and $guiText -match '\$hasLocalUpdater') "GUI update action must prefer the local trusted updater for installed workstations."
    Assert-True ($guiText -match '\$useDirectUpdate = \(\$Operation -eq "update"' -and $guiText -match '\$runSourceFreeMigration') "GUI must reserve direct updater execution for normal updates and explicit source-free migration."
    Assert-True ($guiText -match '"-File", \$directUpdaterPath') "Normal GUI updates must run update-from-nas.ps1 directly."
    Assert-True ($guiText -match '"-CodexInstructionPolicy", \$codexInstructionPolicy' -and $guiText -match '-PreserveLocalCodexInstructions:\$preserveLocalCodexInstructions') "GUI direct updates and migration inventory must honor updater-config Codex instruction policy."
    Assert-True ($guiText -match 'Test-LocalUpdaterSupportsSourceFreeMigration' -and $guiText -match '\$needsSourceFreeMigrationBootstrap') "GUI must detect older local updater tools before source-free migration."
    Assert-True ($guiText -match '\$arguments \+= "-RunSourceFreeMigration"') "GUI must bootstrap old local updater tools and run source-free migration in one confirmed action."
    Assert-True ($guiText.IndexOf('No update is available.') -lt $guiText.IndexOf('This workstation has an installed revAgent package')) "GUI should report no-op update status before warning about a missing local updater."
    Assert-True ($guiText -match 'Get-PackageDescriptionForGui' -and $guiText -match 'Standard user package' -and $guiText -match 'Developer machine' -and $guiText -match 'Codex instructions: preserve local') "GUI must label standard user packages and preserve-local developer machines distinctly."
    Assert-True ($guiText -match 'DPE\\revAgent' -and $guiText -match 'legacyConfigPath') "GUI must default to the revAgent install root while preserving legacy updater config policy."
    Assert-True ($guiText -match '"-File", \$installerPath') "First install and repair must still use install-updater-task.ps1."
    Assert-True ($guiText -match 'RevAgent\.SourceFreeMigration\.psm1' -and $guiText -match 'Get-RevAgentSourceFreeArtifactInventory') "GUI must check source-free migration inventory before install/update actions."
    Assert-True ($guiText -match 'UpdateButtonText = "Migrate"' -and $guiText -match 'SourceFreeMigrationRequired = \$true') "GUI must expose a migration-required state instead of hiding the update path."
    Assert-True ($guiText -match 'Confirm-SourceFreeMigrationForGui' -and $guiText -match 'Continue with source-free migration and update') "GUI must ask before running source-free migration."
    Assert-True ($guiText -match '\$arguments \+= "-SourceFreeMigration"') "GUI migration path must run update-from-nas.ps1 with -SourceFreeMigration."
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
    Assert-True ($updateText -match 'Resolve-RevAgentCanonicalNasTransitionPath' -and $updateText -match 'revAgent-deploy' -and $updateText -match 'revit-mcp-deploy' -and $updateText -match 'Canonical NAS release root detected') "Updater must migrate legacy NAS channel config to the canonical revAgent deploy root when it is available."
    Assert-True ($updateText -match '\$skipRevitPayloadInstall = \[bool\]\$updateDecision\.SkipRevitPayloadInstall') "Updater must skip unchanged Revit payload even when Revit is closed."
    Assert-True ($updateText -match '\$fastPackageOnlyUpdate = \$skipRevitPayloadInstall -and\s+\$skipRuntimePayloadInstall -and\s+\$skipDocsPayloadWork -and\s+\$skipCodexSkillInstallForThisUpdate -and\s+\$skipCodexMcpRegistrationForThisUpdate') "Fast path must require every payload surface to be unchanged."
    Assert-True ($updateText -match '\$runSelfContainedInstaller = \(-not \$fastPackageOnlyUpdate\)') "Any changed payload surface must route through the self-contained installer."
    Assert-True ($updateText -match 'Test-DirectoryPayloadUnchanged -Manifest \$releaseManifest -ComponentKey "runtimePayload"') "Updater must detect unchanged runtime payloads from the release manifest."
    Assert-True ($updateText -match '\$installArgs\["SkipRuntimePayloadInstall"\] = \$true') "Updater must pass runtime skip to the self-contained installer."
    Assert-True ($updateText -match 'ComponentKey "docsServerPayload"') "Updater must detect unchanged docs payloads from the release manifest."
    Assert-True ($updateText -match '\$installArgs\["SkipCodexSkillInstall"\] = \$true') "Updater must skip unchanged Codex skill integration when the existing install is present."
    Assert-True ($updateText -match '\$CodexInstructionPolicy = Resolve-CodexInstructionPolicy' -and $updateText -match 'CodexInstructionPolicy = \$CodexInstructionPolicy') "Updater must resolve Codex instruction policy and pass it to the self-contained installer."
    Assert-True ($updateText -match 'codexInstructionPolicy = \$CodexInstructionPolicy' -and $updateText -match 'codexInstructionCleanupSkipped') "Updater reports and installed state must expose Codex instruction policy behavior."
    Assert-True ($updateText -match 'Codex MCP registration: skipped; runtime/docs entry points unchanged') "Updater must skip MCP registration when runtime/docs entry points are unchanged."
    Assert-True ($updateText -match 'Revit API index: skipped; docs payload unchanged') "Updater must skip docs index rebuild when docs payload is unchanged and the cache exists."
    Assert-True ($updateText -match 'Fast update path : package/updater metadata only; self-contained installer skipped') "Updater must bypass the self-contained installer when all payload surfaces are unchanged."
    Assert-True ($updateText -match '\$localPackageBackupPolicyState = \[ordered\]@' -and $updateText -match 'policy = "disabled"' -and $updateText -match 'Workstation rollback uses signed NAS release archives') "Updater must expose a disabled local package backup policy."
    Assert-True ($updateText -match 'Invoke-RevAgentBackupRootReset -BackupRoot \$backupRoot -CacheRoot \$cacheRoot') "Updater must clear local package backups and stale cached release ZIPs before normal package replacement."
    Assert-True ($updateText -match 'localPackageBackupPolicy = \$localPackageBackupPolicyState') "Updater reports and installed state must expose local package backup policy diagnostics."
    Assert-True ($updateText -notmatch 'Move-Item -LiteralPath \$PackageTarget -Destination \$backupPath') "Updater must not retain local package backup directories on workstations."
    Assert-True ($updateText -notmatch 'Invoke-RevAgentDirectoryRetention -Root \$backupRoot') "Updater must not keep a rolling set of local package backups."
    Assert-True ($updateText -match 'Install-UpdaterToolsFromPackage -SourceRoot \$nasToolsSource -DestinationRoot \$WorkRoot') "Fast update path must still refresh local updater tools."
    Assert-True ($updateText -match 'Invoke-NpmInstallIfNeeded -NpmPath \$npmPath -WorkingDirectory \$docsServerPath -Label "Documentation server" -CacheRoot \$npmDependencyCacheRoot') "Fast and normal updates must restore docs server node_modules after replacing the package folder."
    Assert-True ($updateText -match 'Documentation server dependencies: skipped by -SkipNpmInstall') "Updater must only skip docs server dependencies when explicitly requested."
    Assert-True ($updateText -notmatch 'Documentation server dependencies: skipped; docs payload unchanged') "Updater must not skip docs server dependencies just because the docs payload is unchanged."
    Assert-True ($updateText -match 'Fast update path failed; falling back to the full repair/install path') "Fast update failures must warn and fall back to the full repair/install path."
    Assert-True ($updateText -match '\$runSelfContainedInstaller = \$true') "Fast update failure must enable the self-contained installer fallback."
    Assert-True ($updateText -match 'fastUpdateFallbackUsed') "Updater reports must record whether the fast path fell back."
    Assert-True ($updateText -match 'operationMethod = \$script:RevAgentOperationMethod') "Updater reports must record the install/update method used."
    Assert-True ($updateText -match 'release = \[ordered\]@') "Updater reports must include release version, commit, and package SHA metadata."
    Assert-True ($updateText -match 'localInstall = if \(\$InstalledState\)') "Updater reports must include a local install state summary."
    Assert-True ($updateText -match 'System\.Collections\.IDictionary' -and $updateText -match '\$Object\.Contains\(\$Name\)') "Updater report JSON helper must read ordered dictionary installed state after successful updates."
    Assert-True ($updateText -match 'diagnostics = \$Diagnostics') "Updater reports must include dashboard-ready update diagnostics."
    Assert-True ($updateText -match 'RevAgent\.DistributionIntegrity\.psm1') "Updater must import the distribution-integrity verifier."
    Assert-True ($updateText -match 'release-trusted-keys\.json') "Updater must look for packaged public release-key config."
    Assert-True ($updateText -match 'RevAgent\.ConfigSync\.psm1' -and $updateText -match 'Sync-RevAgentUpdaterConfigDirectory -SourceRoot \$configSource -DestinationRoot \(Join-Path \$DestinationRoot "config"\)') "Fast updater tool refresh must use the shared config sync helper."
    Assert-True ($updateText -notmatch 'Remove-Item -LiteralPath \$configDestination -Recurse -Force') "Fast updater tool refresh must not delete local config because that removes pinned release keys."
    $configSyncText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.ConfigSync.psm1")
    Assert-True ($configSyncText -match 'Mirror shipped config while preserving local trust/license material intentionally not shipped inside source-free release ZIPs') "Config sync helper must document local trust/license preservation."
    Assert-True ($configSyncText -match '\$preserveNames' -and $configSyncText -match 'release-trusted-keys\.json' -and $configSyncText -match 'license-trusted-keys\.json') "Config sync helper must explicitly preserve known local trust/license config files."
    Assert-True ($configSyncText -match '\$sourceNames\.Contains\(\$item\.Name\)' -and $configSyncText -match 'Copy-Item -LiteralPath \$item\.FullName -Destination \$DestinationRoot -Recurse -Force') "Config sync helper must mirror shipped config items without nesting existing directories."
    Assert-True ($updateText -match 'distributionIntegrity = \$script:RevAgentDistributionIntegrity') "Updater reports must include distribution integrity status."
    Assert-True ($updateText -match 'Test-RevAgentReleaseDistributionIntegrity') "Updater must evaluate release signatures through the shared integrity helper."
    Assert-True ($updateText -match 'Test-RevAgentReleaseAppIdentity' -and $updateText -match 'Channel manifest app is not revAgent or revit-mcp-skill') "Updater must accept revAgent and legacy release app identities during rolling app-id migration."
    Assert-True ($updateText -match '\[string\]\$DistributionIntegrityPolicy = ""') "Updater must expose an explicit distribution integrity policy override."
    Assert-True ($updateText -match '\[switch\]\$AllowSignedReleaseRollback') "Updater must require an explicit operator flag for signed rollback bypass."
    Assert-True ($updateText -match 'Get-InstalledHighestAcceptedReleaseSequence') "Updater must persist and reuse the highest accepted signed release sequence."
    Assert-True ($updateText -match '\$policy = if \(\$trustedKeys\.Count -gt 0\) \{ "enforce" \} else \{ "compatibility" \}') "Updater must default to enforce mode when trusted release keys are configured."
    Assert-True ($updateText -match 'Set-DistributionIntegrityBlockedReport' -and $updateText -match 'trusted_keys_missing' -and $updateText -match 'trustedKeysPath = \$TrustedKeysPath') "Updater must report missing pinned release keys as a structured fail-closed distribution-integrity state."
    Assert-True ($updateText -match '\$trustedKeys\.Count -gt 0 -and \[string\]::Equals\(\$policy, "compatibility"') "Updater must report enforce policy whenever trusted release keys make unsigned compatibility impossible."
    Assert-True ($updateText -notmatch '\$trustedKeys\.Count -le \$beforeCount') "Updater must not judge auto-discovered key files empty by cumulative count (C1 regression: collides with configured trustedKeysPath)."
    Assert-True ($updateText -match '\$consumedKeyPaths') "Updater must track already-consumed trusted-key file paths to skip duplicate auto-discovery candidates."
    Assert-True ($updateText -match '\.KeyCount -le 0') "Updater must judge auto-discovered key files empty by that file's own parsed key count."
    $distributionInitIndex = $updateText.IndexOf('Initialize-DistributionIntegrityConfig -Config $config')
    $mainTryBeforeDistributionInitIndex = $updateText.LastIndexOf('try {', $distributionInitIndex)
    $mainCatchAfterDistributionInitIndex = $updateText.IndexOf('catch {', $distributionInitIndex)
    Assert-True ($distributionInitIndex -ge 0 -and $mainTryBeforeDistributionInitIndex -ge 0 -and $mainTryBeforeDistributionInitIndex -lt $distributionInitIndex -and $mainCatchAfterDistributionInitIndex -gt $distributionInitIndex) "Updater must catch distribution-integrity initialization failures and write the normal failure report."
    Assert-True ($updateText -match 'HighestAcceptedReleaseSequence\s*=\s*\$highestAcceptedReleaseSequence') "Updater must pass anti-rollback state into integrity verification."
    Assert-True ($updateText -match 'hasAcceptedSignedRelease' -and $updateText -match 'Test-TruthyJsonValue' -and $updateText -match '\$highest\s*=\s*\[long\]1' -and $updateText -match '\[Math\]::Max\(\s+\$highestAcceptedReleaseSequence') "Updater must consume signed-acceptance state and not lower the stored signed-release high-watermark."
    Assert-True ($updateText -match 'RevAgent\.License\.psm1') "Updater must import the license verifier."
    Assert-True ($updateText -match '\[string\]\$LicensePolicy = ""' -and $updateText -match '\[string\]\$LicensePath = ""' -and $updateText -match '\[string\]\$LicenseSignaturePath = ""') "Updater must expose explicit license verification inputs."
    Assert-True ($updateText -match 'license-trusted-keys\.json') "Updater must look for packaged public license-key config."
    Assert-True ($updateText -match 'Initialize-LicenseConfig -Config \$config') "Updater must initialize license verification before package work."
    Assert-True ($updateText -match 'license = \$script:RevAgentLicense') "Updater reports must include license verification status."
    Assert-True ($updateText.IndexOf('Test-RevAgentReleaseDistributionIntegrity') -lt $updateText.IndexOf('Copy-Item -LiteralPath $packagePath')) "Updater must verify release integrity before copying the package into the local cache."
    Assert-True ($updateText.IndexOf('$actualSha = (Get-FileHash') -lt $updateText.IndexOf('Expand-ReleaseArchive -ZipPath $cachedPackage')) "Updater must verify the downloaded package hash before extracting it."
    Assert-True ($updateText -match 'elseif \(\$Force\) \{ "reinstall" \}') "Forced updater runs must be reported as reinstall operations."
    Assert-True ($updateText -match 'Publish-RevAgentMachineRunReport') "Updater must publish per-machine NAS reports and logs."
    Assert-True ($updateText -match '\.revagent-npm-dependencies\.json') "Updater payload fingerprints must ignore npm dependency marker files."
    Assert-True ($updateText -notmatch 'Repair-RevAgentScheduledTaskAction -Name \$TaskName') "Normal updates must not run an extra scheduled-task repair before the package installer."
    $installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
    Assert-True ($installTaskText -match 'installOperationMethod = \$script:RevAgentOperationMethod') "Updater installer config must record the install/repair method."
    Assert-True ($installTaskText -match 'function Get-EffectiveInstallOperation') "Updater installer must classify install versus reinstall operation type."
    Assert-True ($installTaskText -match 'diagnostics = \[ordered\]@') "Updater installer reports must include dashboard-ready diagnostics."
    Assert-True ($installTaskText -match 'Publish-RevAgentMachineRunReport') "Updater installer must publish per-machine NAS reports and logs."
    Assert-True ($installTaskText -match '-OperationMethod", "scheduled-update"') "Scheduled updater launcher must tag background runs in logs."
    Assert-True ($installTaskText -match 'trustedKeysPath = \$localTrustedReleaseKeysPath' -and $installTaskText -match 'policy = "enforce"') "Updater installer must pin the local trusted release key path and enforce distribution integrity."
    Assert-True ($installTaskText -match 'preserved previously pinned local trusted release keys' -and $installTaskText -match 'Restored previously pinned local trusted release keys' -and $installTaskText -match 'config remains pinned and fail-closed until keys are restored' -and $installTaskText -match 'trustedKeysMissing' -and $installTaskText -match 'Test-Path -LiteralPath \$localTrustedReleaseKeysPath -PathType Leaf\) -or \$previousReleaseIntegrityPinned') "Updater installer repair must preserve enforce-pinned distribution integrity when NAS trusted release keys are missing."
    $publishText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1")
    Assert-True ($publishText -match '\$components\["runtimePayload"\] = Get-DirectoryTreeHash') "Release manifest must include a runtime payload fingerprint."
    Assert-True ($publishText -match '\$components\["docsServerPayload"\] = Get-DirectoryTreeHash') "Release manifest must include a docs payload fingerprint."
    Assert-True ($publishText -match 'foreach \(\$payloadRoot in @\("installer\\revit-plugin", "installer\\command-payload"\)\)') "Release manifest must classify Revit add-in and command payload trees as Revit-close-required."
    Assert-True ($publishText -match 'revitClosedRequiredPaths = @\(\s+"installer\\revit-plugin"\s+"installer\\command-payload"\s+\)') "Release manifest must advertise Revit-close-required payload paths."
    Assert-True ($publishText -match '\.revagent-npm-dependencies\.json') "Release payload fingerprints must ignore npm dependency marker files."
    Assert-True ($publishText -match '\[string\]\$SigningPrivateKeyPath = ""' -and $publishText -match '\[string\]\$SigningKeyId = ""') "Release signing must be optional publish-time input."
    Assert-True ($publishText -match '\[long\]\$ReleaseSequence = 0' -and $publishText -match '\[long\]\$MinimumAcceptedReleaseSequence = 0') "Release publish signing must support signed anti-rollback sequence metadata."
    Assert-True ($publishText -match '\[switch\]\$RequireSigning') "Release publishing must expose an operator-enforced signing requirement."
    Assert-True ($publishText -match '\[string\]\$TrustedReleaseKeysPath = ""' -and $publishText -match 'release-trusted-keys\.json') "Release publishing must optionally copy public trusted release keys to tools config."
    Assert-True ($publishText -match '\$manifestMetadataPath' -and $publishText -match '\$zipMetadataPath') "Release publishing must write portable relative channel paths for signed CD artifacts."
    Assert-True ($publishText -match 'Signing private key must be stored outside the repository' -and $publishText -match 'Signing private key must be stored outside NAS tools') "Publish signing must reject private keys stored in shipped or tool roots."
    Assert-True ($publishText -match 'manifest\.sig\.json' -and $publishText -match '\{0\}\.sig\.json' -and $publishText -match 'Test-RevAgentDetachedJsonSignatureFile') "Publish signing must write and verify detached signature files."
    Assert-True ($publishText -notmatch 'kurulum|legacyEntryPoint|legacyInstaller') "Release publishing must not create the removed legacy kurulum package alias."
    $payloadFreshnessText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\test-mcp-build-payload-freshness.ps1")
    $testAllText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\test-all.ps1")
    $packageTestHelpersText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\McpPackageTestHelpers.psm1")
    $revitPayloadManifestText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\RevitPayloadManifest.psm1")
    $buildRevitPluginText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\build-revit-plugin.ps1")
    $ciText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\test-ci.ps1")
    $runtimePackageText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\package.json")
    $runtimePackageLockText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\package-lock.json")
    $runtimeReleasePackageText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\release\package.json")
    $runtimeReleasePackageLockText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\release\package-lock.json")
    $buildMcpReleaseText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\build-mcp-release-bundle.mjs")
    $docsPackageText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-api-docs-mcp\package.json")
    $docsPackageLockText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-api-docs-mcp\package-lock.json")
    $docsReleasePackageText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-api-docs-mcp\release\package.json")
    $docsReleasePackageLockText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-api-docs-mcp\release\package-lock.json")
    Assert-True ($payloadFreshnessText -match 'Assert-RevitPayloadManifestFresh') "Payload freshness gate must validate the Revit manifest."
    Assert-True ($payloadFreshnessText -match 'Assert-RevitPayloadNoDebugArtifacts') "Payload freshness gate must reject committed Revit .NET debug artifacts."
    Assert-True ($payloadFreshnessText -match 'New-McpPackageWorkCopy' -and $payloadFreshnessText -match 'Invoke-McpPackageNpmCi' -and $payloadFreshnessText -match 'Get-McpPackageTscPath') "Payload freshness gate must restore and compile MCP packages from isolated temporary work copies."
    Assert-True ($payloadFreshnessText -match 'build-mcp-release-bundle\.mjs' -and $payloadFreshnessText -match 'Release payload for \$PackageRelativePath') "Payload freshness gate must validate hardened MCP release artifacts."
    Assert-True ($revitPayloadManifestText -match 'function Get-RevitPayloadDebugArtifactPaths' -and $revitPayloadManifestText -match 'installer/revit-plugin' -and $revitPayloadManifestText -match 'installer/command-payload') "Revit payload manifest helpers must scan installer Revit payload roots for .NET debug artifacts."
    Assert-True ($revitPayloadManifestText -match '\$repoPrefix = \$repoRootFullName \+ \[System\.IO\.Path\]::DirectorySeparatorChar' -and $revitPayloadManifestText -notmatch '\$RepoRoot\.Length \+ 1') "Revit debug-artifact scanning must use a normalized repository prefix."
    Assert-True ($revitPayloadManifestText -notmatch '\$artifacts \+=') "Revit debug-artifact scanning must not use array += accumulation."
    Assert-True ($buildRevitPluginText -match 'Remove-RevitPayloadDebugArtifacts -RepoRoot \$RepoRoot' -and $buildRevitPluginText -match 'Assert-RevitPayloadNoDebugArtifacts -RepoRoot \$RepoRoot') "Revit payload build refresh must remove and reject stale .NET debug artifacts."
    Assert-True ($packageTestHelpersText -match 'node_modules' -and $packageTestHelpersText -match '\.package-lock\.json' -and $packageTestHelpersText -match 'GetTempPath' -and $packageTestHelpersText -match 'REVIT_MCP_REPO_ROOT') "MCP package test helpers must skip live dependency folders, use temporary work copies, and preserve repo-root context."
    Assert-True ($runtimePackageText -match '"@e965/xlsx"' -and $runtimePackageText -notmatch '"exceljs"') "Runtime Excel ingestion must avoid the deprecated exceljs transitive dependency chain."
    Assert-True ($runtimePackageText -match '"ajv"' -and $runtimePackageText -match '"ajv-formats"' -and $runtimePackageText -match '"schemas"') "Spatial response validation must declare its schema runtime dependencies and package the published schemas."
    Assert-True ($buildMcpReleaseText -match 'schemas.*spatial.*v0\.1' -and $buildMcpReleaseText -match 'cpSync') "Runtime release assembly must copy the published Spatial Phase 0 schemas."
    foreach ($schemaName in @("element-ref", "node-ref", "source-revision", "cursor-envelope", "spatial-snapshot", "extraction-page")) {
        Assert-True (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\schemas\spatial\v0.1\$schemaName.schema.json") -PathType Leaf) "Published Spatial Phase 0 schema is missing: $schemaName."
        Assert-True (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\release\schemas\spatial\v0.1\$schemaName.schema.json") -PathType Leaf) "Runtime release Spatial Phase 0 schema is missing: $schemaName."
    }
    Assert-True ($runtimePackageText -match '"build:release"' -and $docsPackageText -match '"build:release"') "MCP packages must expose a hardened release bundle build script."
    Assert-True ($runtimeReleasePackageText -notmatch '"(scripts|devDependencies|files)"' -and $docsReleasePackageText -notmatch '"(scripts|devDependencies|files)"') "Release MCP package manifests must be runtime-only."
    Assert-True ($runtimeReleasePackageLockText -notmatch '"dev": true' -and $docsReleasePackageLockText -notmatch '"dev": true') "Release MCP package locks must not include dev dependency entries."
    Assert-True ($docsPackageText -match '"rimraf": "\^6\.') "Docs MCP clean script dependency must use rimraf 6 or newer."
    Assert-True ($runtimePackageLockText -notmatch 'node_modules/(inflight|lodash\.isequal|fstream)' -and $docsPackageLockText -notmatch 'node_modules/(inflight|lodash\.isequal|fstream)') "MCP package locks must not include deprecated npm dependency packages that create CI warning noise."
    Assert-True ($runtimePackageLockText -notmatch '"version": "2\.7\.1"|node_modules/glob":\s*\{\s*"version": "7\.2\.3"' -and $docsPackageLockText -notmatch '"version": "2\.7\.1"|node_modules/glob":\s*\{\s*"version": "10\.5\.0"') "MCP package locks must not include deprecated rimraf/glob versions."
    Assert-True ($payloadFreshnessText -notmatch 'Get-NewestPayloadSourceFile|Assert-RevitPayloadFresh|LastWriteTimeUtc -gt') "Payload freshness gate must not use Revit source/payload mtimes."
    Assert-True ($ciText -match 'Get-McpPackageTscPath' -and $ciText -notmatch 'tsc\.cmd') "CI forced TypeScript checks must resolve the package-local compiler portably."
    Assert-True ($testAllText -match 'New-McpPackageWorkCopy' -and $testAllText -match 'Invoke-McpPackageNpmCi' -and $testAllText -match 'Invoke-McpPackageCommand -PackageName "\$\(\$package\.Name\) npm test"') "Local test-all gate must restore package npm dependencies in an isolated work copy before npm tests and payload freshness."
    Assert-True ($revitPayloadManifestText -match 'installer\\revit-payload-manifest\.json') "Revit payload manifest path must be centralized."
    Assert-True ($revitPayloadManifestText -match 'gitBlobSha' -and $revitPayloadManifestText -match 'hash-object' -and $revitPayloadManifestText -match '--path=') "Revit source freshness must use Git blob SHAs."
    Assert-True ($revitPayloadManifestText -match 'System\.Management\.Automation\.ErrorRecord') "Revit payload Git helper must filter stderr warning records from successful output."
    Assert-True ($revitPayloadManifestText -match '--untracked-files=all') "Revit payload manifest guard must inspect files inside untracked source folders."
    Assert-True ($revitPayloadManifestText -match 'manifest is empty or invalid JSON' -and $revitPayloadManifestText -match 'ConvertFrom-Json -ErrorAction Stop') "Revit payload manifest guard must report empty or invalid JSON clearly."
    Assert-True ($revitPayloadManifestText -match 'sha256' -and $revitPayloadManifestText -match 'sizeBytes') "Revit payload manifest must fingerprint payload DLL bytes."
    Assert-True ($buildRevitPluginText -match 'Write-RevitPayloadManifest') "Revit payload build must refresh the manifest with payload copies."
    Assert-True ($ciText -match 'test-mcp-build-payload-freshness\.ps1"\) -RepoRoot \$RepoRoot') "CI must run the payload freshness gate."
    Assert-True ($ciText -notmatch 'test-mcp-build-payload-freshness\.ps1"\) -RepoRoot \$RepoRoot -McpOnly') "CI must not skip the Revit manifest freshness gate."
    $packageLibText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.Package.psm1")
    Assert-True ($packageLibText -notmatch 'kurulum') "Package layout resolution must not keep the removed legacy kurulum path."
    Assert-True ($guiText -notmatch 'Guncelle|Surum|Kapat|Kurulum|Kanal|Hazir|Islem|Calisiyor|Baslatilamadi|bulunamadi|hata') "GUI product strings must remain English."
    Assert-True ($guiText -notmatch 'Revit MCP Installer|Revit MCP install and update|Stable Restore|Stable channel|Stable version') "GUI product labels must not expose internal MCP wording or legacy channel wording."

    Write-Host "Test revAgent user-facing MCP naming"
    $codexRegistrationText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.CodexRegistration.psm1")
    $runtimeIndexText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\index.ts")
    $statusToolText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\get_revit_mcp_status.ts")
    $listInstancesToolText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\list_revit_instances.ts")
    $userSkillText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\codex-user\SKILL.md")
    $userAgentsText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\codex-user\AGENTS.md")
    Assert-True ($codexRegistrationText -match '-Name "revAgent"' -and $codexRegistrationText -match '-Name "revAgent-api-docs"') "Codex MCP registration must use revAgent-facing names."
    Assert-True ($codexRegistrationText -match '"revit-mcp", "revit-api-docs"') "Codex MCP registration must remove legacy user-facing names."
    Assert-True ($codexRegistrationText -notmatch 'Set-RevAgentCodexMcpServerConfig[^\r\n]+-Name "revit-mcp"') "Codex MCP registration must not add the legacy runtime name."
    Assert-True ($runtimeIndexText -match 'name:\s*"revAgent"' -and $runtimeIndexText -notmatch 'name:\s*"revit-mcp"') "Runtime MCP server metadata must expose revAgent."
    Assert-True ($statusToolText -notmatch 'Read the Revit MCP task status' -and $statusToolText -match 'Read the revAgent task status') "Status tool description must use revAgent wording."
    Assert-True ($listInstancesToolText -notmatch 'Revit MCP socket instances' -and $listInstancesToolText -match 'revAgent Revit bridge instances') "Instance discovery tool description must use revAgent wording."
    Assert-True ($userSkillText -notmatch 'Revit MCP runtime|Revit MCP review|Revit MCP runtime tools|name: revit-mcp') "User-pack SKILL.md must not expose legacy product wording."
    Assert-True ($userAgentsText -notmatch 'Revit MCP runtime|Revit MCP work|Revit MCP Coordination|revAgent/Revit MCP') "User-pack AGENTS.md must not expose legacy product wording."

    Write-Host "Test Revit task status window product surface"
    $taskStatusXaml = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\UI\McpTaskStatusWindow.xaml")
    $taskStatusCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\UI\McpTaskStatusWindow.xaml.cs")
    $taskStatusController = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\McpTaskStatusWindowController.cs")
    $taskStatusService = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\McpTaskStatusService.cs")
    $socketServiceCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\SocketService.cs")
    $commandExecutorCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\CommandExecutor.cs")
    $bridgeResultContractCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\BridgeResultContract.cs")
    $applicationCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\Application.cs")
    $metadataCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\RevAgentMetadataCommand.cs")
    Assert-True ($taskStatusXaml -match 'Title="revAgent Status"') "Task status window title must use revAgent."
    Assert-True ($taskStatusXaml -match 'Your AI agent inside Revit\.') "Task status window must show the revAgent product tagline."
    Assert-True ($taskStatusXaml -match '2026 Baris Tankut') "Task status window must show the revAgent copyright footer."
    Assert-True ($taskStatusXaml -match 'www\.revagent\.app') "Task status window must show the official revAgent web address."
    Assert-True ($taskStatusXaml -match 'UpdateStatusText') "Task status window must expose the update state line."
    Assert-True ($taskStatusXaml -match 'Up to date') "Task status window must use user-facing update state wording."
    Assert-True ($taskStatusXaml -match 'WindowStyle="SingleBorderWindow"') "Task status window must expose a normal minimizable window frame."
    Assert-True ($taskStatusXaml -match 'ShowInTaskbar="True"') "Task status window must be visible in the taskbar."
    Assert-True ($taskStatusXaml -notmatch 'Revit MCP|Recent MCP') "Task status window XAML must not expose internal MCP wording."
    Assert-True ($taskStatusCode -notmatch 'Revit MCP is working|Revit MCP task|Revit MCP version') "Task status code must not expose internal MCP wording."
    Assert-True ($taskStatusCode -match 'VersionDisplay') "Task status code must present the installed product version label."
    Assert-True ($taskStatusCode -match 'FormatUpdateStatusLine') "Task status code must present a concise update-state label."
    Assert-True ($applicationCode -match 'ID_EXCMD_REVAGENT_INFO' -and $applicationCode -notmatch 'ID_EXCMD_TOGGLE_REVIT_MCP|ID_EXCMD_MCP_SETTINGS') "Revit ribbon must expose only the revAgent metadata button."
    Assert-True ($metadataCommandCode -match 'FormatMetadataDetails' -and $metadataCommandCode -match 'ProductWebsiteUrl') "Revit metadata button must show the shared revAgent version metadata and web address."
    $versionInfoCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentPlugin\Core\McpVersionInfo.cs")
    Assert-True ($versionInfoCode -match 'channelManifestPath') "Version info must read the configured channel manifest path."
    Assert-True ($versionInfoCode -match 'publishedAtUtc') "Version info must use release/channel publish timestamps when available."
    Assert-True ($versionInfoCode -match 'Version ') "Version info must label the installed product version clearly."
    Assert-True ($versionInfoCode -match '\(" \+ build \+ "\)"') "Version info must place the build identifier in the Version line."
    Assert-True ($versionInfoCode -match 'Installed on this PC') "Version info must keep local install time in support details only."
    Assert-True ($versionInfoCode -match 'FormatMetadataDetails' -and $versionInfoCode -match 'www\.revagent\.app' -and $versionInfoCode -match 'Copyright \(c\) 2026 Baris Tankut') "Version metadata must include active version, official web address, and copyright details."
    Assert-True ($versionInfoCode -notmatch 'Updated ') "Task status metadata must not expose local install time as the user-facing version."
    Assert-True ($versionInfoCode -match 'Up to date') "Version info must label current release state clearly."
    Assert-True ($versionInfoCode -notmatch 'Stable ') "Version info must not expose legacy channel labels in the product UI."
    Assert-True ($taskStatusController -match 'revAgent Task Status UI') "Task status UI thread should use the product name."
    Assert-True ($taskStatusCode -match 'ShowGuarded') "Task status window must display safety-guarded tasks separately from failures."
    Assert-True ($taskStatusController -match 'ShowGuarded') "Task status controller must route guarded task state to the UI."
    Assert-True ($taskStatusService -match 'GuardTask') "Task status service must support a guarded task state."
    Assert-True ($taskStatusService -match 'MaxRecentTasks = 100') "Task status service must retain enough recent tasks for full-test/debug runs."
    Assert-True ($taskStatusService -match 'JsonProperty\("wrapperAction"' -and $taskStatusService -match 'JsonProperty\("logicalToolName"') "Task status service must preserve wrapper/logical tool metadata in recentTasks."
    Assert-True ($socketServiceCode -match 'ExtractRequestParamText\(request, "wrapperAction"\)' -and $socketServiceCode -match 'ExtractRequestParamText\(request, "logicalToolName", "toolName"\)') "Socket service must forward wrapper/logical tool metadata into task status history."
    Assert-True ($taskStatusCode -match 'MaxHistoryItems = 100') "Task status window must keep enough visible history for full-test/debug runs."
    Assert-True ($taskStatusService -notmatch 'NormalizeErrorMessage|ContainsCjk') "Task status service must not hide localized source text with a sanitizer."
    Assert-True ($socketServiceCode -match 'IsCommandResultGuarded') "Socket service must classify expected safety blocks as guarded tasks."
    Assert-True ($bridgeResultContractCode -match 'public const int ResultContractVersion = 2') "Bridge result contract must expose the normalized payload floor."
    Assert-True ($bridgeResultContractCode -match 'CamelCaseNamingStrategy') "Bridge result contract must centralize native camelCase serialization."
    Assert-True ($bridgeResultContractCode -match 'ProcessDictionaryKeys = false') "Bridge result contract must not rewrite dictionary/domain payload keys."
    Assert-True ($bridgeResultContractCode -match 'obj\["resultContractVersion"\] = ResultContractVersion') "Bridge result payloads must be self-describing."
    Assert-True ($commandExecutorCode -match 'BridgeResultContract\.CreateResultPayload\(result\)') "CommandExecutor success responses must use the bridge result contract helper."
    Assert-True ($socketServiceCode -match 'BridgeResultContract\.CreateResultPayload\(result\)') "SocketService success responses must use the bridge result contract helper."
    Assert-True ($socketServiceCode -match 'BridgeResultContract\.ToCamelCaseToken\(result\)') "SocketService guarded/failure detection must inspect the same camelCase token shape."
    Assert-True ($commandExecutorCode -notmatch 'JToken\.FromObject' -and $socketServiceCode -notmatch 'JToken\.FromObject') "Bridge response/guard/failure paths must not bypass the central camelCase helper."
    Assert-True ($taskStatusCode -match 'Guarded / blocked by safety') "Task status window must describe guarded tasks as a safety block, not a failure."
    Assert-True ($taskStatusCode -match 'return "!"') "Task status history must render guarded tasks with the warning-style exclamation symbol."
    Assert-True ($taskStatusCode -match 'return "\\u2715"') "Failed task history must keep a distinct failure symbol."

    Write-Host "Test Revit view focus visibility guard"
    $focusHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\ElementFocusHelpers.cs")
    $focusHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\FocusElementsEventHandler.cs")
    $openPlanCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\OpenExistingPlanForElementLevelEventHandler.cs")
    $openPlanCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\OpenExistingPlanForElementLevelCommand.cs")
    $openPlanToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\open_existing_plan_for_element_level.ts")
    $smartFocusToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\smart_focus_elements.ts")
    $sendCodeToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\send_code_to_revit.ts")
    $closeViewCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\CloseViewEventHandler.cs")
    $clearSelectionToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\clear_selection.ts")
    $clearSelectionHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\ClearSelectionEventHandler.cs")
    $deleteReviewViewToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\delete_review_view.ts")
    $deleteReviewViewHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\DeleteReviewViewEventHandler.cs")
    $create3dHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\Create3DViewForElementsEventHandler.cs")
    $sectionBoxHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\SectionBoxElementsEventHandler.cs")
    $viewHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\ViewCommandHelpers.cs")
    $discoveryCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\ElementDiscoveryHelpers.cs")
    $findCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\FindElementsCommand.cs")
    $findHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\FindElementsEventHandler.cs")
    $inspectSheetTextCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSheetTextCommand.cs")
    $inspectSheetTextHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSheetTextEventHandler.cs")
    $annotationEvidenceHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\AnnotationEvidenceHelpers.cs")
    $findToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\find_elements.ts")
    $searchPolicyCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\searchPolicy.ts")
    $broadScanResultCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\broadScanResult.ts")
    $inspectElementsToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\inspect_elements.ts")
    $showPlan3dToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\show_element_in_plan_and_3d.ts")
    $sessionContextToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\get_revit_session_context.ts")
    $activeViewContextToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\get_active_view_context.ts")
    $instanceListToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\list_revit_instances.ts")
    $viewImageToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\export_revit_view_image.ts")
    $coordinationImageToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\export_revit_coordination_image.ts")
    $create3dToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\create_3d_view_for_elements.ts")
    $statusToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\get_revit_mcp_status.ts")
    $runtimeIdentityCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\runtimeIdentity.ts")
    $toolHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\revitToolHelpers.ts")
    $parameterSchemaToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\inspect_parameter_schema.ts")
    $inspectSheetTextToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\inspect_sheet_text.ts")
    $inspectSchedulesToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\inspect_schedules.ts")
    $reconcileScheduleAdapterCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\reconcile_schedule_adapter.ts")
    $countAnnotationsToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\count_annotations.ts")
    $countAnnotationsHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\CountAnnotationsEventHandler.cs")
    $inspectSchedulesHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\InspectSchedulesEventHandler.cs")
    $commandSetRegistryCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\command.json")
    $setParameterToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\set_element_parameter.ts")
    $setScheduleCellsToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\set_schedule_cells.ts")
    $setScheduleCellsByTextToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\set_schedule_cells_by_text.ts")
    $safeCodeGuardsCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\send_code_to_revit_safe_guards.ts")
    $telemetryCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\telemetry.ts")
    $captureSpatialToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\capture_spatial_snapshot.ts")
    $spatialPageCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\spatial\spatialPage.ts")
    $spatialPageSchemaCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\spatial\spatialPageSchema.ts")
    $safeCodeToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\send_code_to_revit_safe.ts")
    $apiDocsIndexCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-api-docs-mcp\src\utils\docIndex.ts")
    Assert-True ($captureSpatialToolCode -match 'extract_spatial_snapshot' -and $captureSpatialToolCode -match 'hasExplicitLevelScope' -and $captureSpatialToolCode -match 'invalid_spatial_page_contract') "capture_spatial_snapshot must remain an explicit-level, strict-contract wrapper over the native Phase 0 extractor."
    Assert-True ($spatialPageSchemaCode -match 'extraction-page\.schema\.json' -and $spatialPageSchemaCode -match 'canonicalJson' -and $spatialPageCode -match 'pagePayloadBytes') "Spatial page normalization must validate the published transport schema, recompute canonical hashes, and preserve page-vs-snapshot byte totals."
    Assert-True ($telemetryCode -match 'SPATIAL_EXTRACTION_NAMES' -and $telemetryCode -match 'summarizeSpatialExtractionTelemetryParams' -and $telemetryCode -match 'summarizeSpatialExtractionTelemetryResponse' -and $telemetryCode -match 'return null') "Spatial extraction telemetry must keep the strict no-model-data production-context boundary."
    Assert-True ($focusHelpersCode -match 'new FilteredElementCollector\(document, view\.Id\)') "View visibility helper must use a view-specific collector."
    Assert-True ($focusHelpersCode -match 'ElementIdSetFilter') "View visibility helper must filter directly by target element id instead of materializing all visible ids."
    Assert-True ($focusHelpersCode -match 'elementNotVisibleInTargetView') "View visibility helper must report non-visible target elements."
    Assert-True ($focusHandlerCode -notmatch 'get_BoundingBox\(view\)') "focus_elements must not use a view bounding box as visibility proof."
    Assert-True ($focusHandlerCode -match 'metadataOnlyFastGuard') "focus_elements guarded response must avoid slow verified plan scans."
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
    Assert-True ($findToolCode -match 'searchBudget: z\.enum\(\["fast", "balanced", "deep"\]\)') "find_elements must expose ergonomic searchBudget presets."
    Assert-True ($findToolCode -match 'allowExpensiveSearch') "find_elements must expose explicit expensive-search approval."
    Assert-True ($findToolCode -match 'modelSignals' -and $findToolCode -match 'cheap large-model signals') "find_elements must accept cheap prior model risk signals without collecting heavy counts."
    Assert-True ($findToolCode -match 'buildFindElementsSearchPolicy') "find_elements must infer MEP search scope before calling Revit."
    Assert-True ($findToolCode -match 'allowExpensiveSearch: policy\.allowExpensiveSearch') "find_elements must forward searchBudget=deep as expensive-search approval to the Revit bridge."
    Assert-True ($findToolCode -match 'riskPolicy') "find_elements must return explicit search risk policy metadata."
    Assert-True ($findToolCode -match 'writeSafetyWarning') "find_elements compact output must make discovery-only write risk visible."
    Assert-True ($findToolCode -match 'writeBlockedUntil: "exact_element_and_parameter_schema_preflight"') "find_elements write guidance must block writes until exact element and parameter schema preflight."
    Assert-True ($findToolCode -match 'set_element_parameter_dry_run_with_expected_current_value') "find_elements write guidance must require a guarded set_element_parameter dry-run before commit."
    Assert-True ($findToolCode -match 'broad_or_ambiguous_discovery_result') "find_elements write guidance must flag broad or ambiguous discovery output as unsafe for parameter writes."
    Assert-True ($findToolCode -match 'builtInParameterId') "find_elements write guidance must require stable parameter identity before writes."
    Assert-True ($findCommandCode -match 'planCandidateMode != "none"') "find_elements command must keep plan candidate scans opt-in."
    Assert-True ($findCommandCode -match 'maxElapsedMs' -and $findCommandCode -match 'timeoutMs - 1000') "find_elements command must keep Revit scan budget below socket timeout."
    Assert-True ($findHandlerCode -match 'ElementMulticategoryFilter') "find_elements bridge must use API-level category filters instead of only in-memory category filtering."
    Assert-True ($findHandlerCode -notmatch 'ElementLevelFilter' -and $findHandlerCode -notmatch 'BuildLevelParameterElementFilter' -and $findHandlerCode -notmatch 'ResolveCollectorLevelFilterIds') "find_elements bridge must not use API-level level prefilters that can silently drop MEP elements with fallback level parameters."
    Assert-True ($findHandlerCode -match 'MatchesAdditionalFilters\(searchDocument, element\)' -and $findHandlerCode -match 'ResolveElementLevel') "find_elements bridge must keep level filtering in the in-memory post-filter path."
    Assert-True ($findHandlerCode -match 'if \(_levelIds\.Count > 0 \|\| _levelNames\.Count > 0\)[\s\S]+ResolveElementLevel') "find_elements bridge must resolve levels only when level filters are requested."
    Assert-True ($findHandlerCode -match 'ScannedElementCount' -and $findHandlerCode -match 'Partial' -and $findHandlerCode -match 'ScanStoppedReason') "find_elements bridge must report scan budget and partial-result state."
    Assert-True ($findHandlerCode -match 'No matching elements found\.') "find_elements no-match result must not say matching elements were found."
    Assert-True ($findHandlerCode -match 'No matching elements found\. Narrow or adjust') "find_elements no-match selection hint must not claim there is a top match."
    Assert-True ($findHandlerCode -match 'VerifiedPlanCandidateMaxMatchesWithoutApproval' -and $findHandlerCode -match 'verified plan candidate visibility was downgraded to metadata') "find_elements bridge must downgrade broad verified plan visibility without explicit approval."
    Assert-True ($findHandlerCode -match 'IsExactTargetVerifiedMatchSet' -and $findHandlerCode -match 'exactTargetCount > 0 && matchCount <= exactTargetCount') "find_elements bridge must preserve verified mode for bounded exact element-id/unique-id targets."
    Assert-True ($findHandlerCode -match 'bool planCandidateStopped = false' -and $findHandlerCode -match 'ref planCandidateStopped' -and $findHandlerCode -match 'if \(planCandidateStopped\)') "find_elements bridge must track plan-candidate budget separately from earlier search partial state."
    Assert-True ($findHandlerCode -match 'IsLinkedOnlyHostElementIdSearch') "find_elements bridge must guard linkedOnly exact host element-id lookups."
    Assert-True ($findHandlerCode -match 'SearchLinkedUniqueIds') "find_elements bridge must preserve exact linked uniqueId lookups."
    Assert-True ($findHandlerCode -notmatch 'GetElement\(new ElementId\(id\)\)[\s\S]{0,200}linkDocument') "find_elements bridge must not apply host numeric element ids inside linked documents."
    Assert-True ($findHandlerCode -match 'WorksetTable table = document\.GetWorksetTable\(\)' -and $findHandlerCode -match 'if \(table == null\) return ""') "find_elements bridge must avoid exception-driven workset checks in non-workshared models."
    Assert-True ($searchPolicyCode -match 'preserveQueryWhenFullyStripped' -and $searchPolicyCode -match 'concept: "valve"') "Valve/vana search policy must preserve pure concept queries so fitting fallback cannot match by category alone."
    Assert-True ($discoveryCode -match 'AddValveAccessorySignal' -and $discoveryCode -match 'mepValveAccessoryCategory') "Element discovery must prioritize valve/vana Pipe Accessories category evidence."
    Assert-True ($commandSetRegistryCode -match '"commandName": "clear_selection"' -and $commandSetRegistryCode -match '"commandName": "delete_review_view"') "Commandset registry must expose clear_selection and delete_review_view."
    Assert-True ($clearSelectionToolCode -match 'LIVE_UI_SELECTION_CLEANUP' -and $clearSelectionHandlerCode -match 'SelectionCountBefore' -and $clearSelectionHandlerCode -match 'SetElementIds\(new List<ElementId>\(\)\)') "clear_selection must be a dedicated no-transaction selection cleanup tool."
    Assert-True ($deleteReviewViewToolCode -match 'REVIEW_VIEW_CLEANUP_GUARDED' -and $deleteReviewViewToolCode -match 'confirmDelete' -and $deleteReviewViewHandlerCode -match 'non_review_view_delete_blocked') "delete_review_view must default to guarded review-view cleanup with explicit confirmation."
    Assert-True ($deleteReviewViewHandlerCode -match 'mode=commit' -and $deleteReviewViewHandlerCode -match 'active_view_delete_blocked' -and $deleteReviewViewHandlerCode -match 'open_view_delete_blocked') "delete_review_view must guard active/open views and expose commit guidance."
    Assert-True ($deleteReviewViewHandlerCode -match 'CountPlacedViewports' -and $deleteReviewViewHandlerCode -match 'placed_review_view_delete_blocked') "delete_review_view must block deletion of sheet-placed review views."
    Assert-True ($deleteReviewViewHandlerCode -match 'ViewCommandHelpers\.GetReviewViewSignals') "delete_review_view must use the shared review-view recognition helper."
    Assert-True ($viewHelpersCode -match 'GetReviewViewSignals' -and $viewHelpersCode -match 'NormalizeReviewViewName' -and $viewHelpersCode -match 'revagent_review_view_name') "review-view recognition policy must be centralized and token-aware."
    Assert-True ($viewHelpersCode -match 'StartsWith\(" revagent "' -and $viewHelpersCode -match 'StartsWith\(" revit mcp "' -and $viewHelpersCode -notmatch 'StartsWith\(" dpe visual qa "') "Generic review-view token matching must not allow every DPE Visual QA view; only coordination/export-specific DPE names are cleanup candidates."
    Assert-True ($liveCommandsetTest -match 'revAgent_QA_DELETE_TEST_' -and $liveCommandsetTest -match 'delete_review_view recognizes create_3d_view_for_elements QA names') "Live commandset gate must cover cleanup of create_3d_view_for_elements revAgent_QA_* views."
    Assert-True ($showPlan3dToolCode.Contains('3D - Focus ${label} ${elementId}') -and -not $showPlan3dToolCode.Contains('3D - ${label} ${elementId}')) "show_element_in_plan_and_3d must default wrapper 3D views to cleanup-safe focus names."
    Assert-True ($viewHelpersCode -match 'StartsWith\("3D - Focus "' -and $viewHelpersCode -match 'default_focus_view_name') "delete_review_view must recognize default focus view names from workflow wrappers."
    Assert-True ($liveCommandsetTest -match '3D - Focus Element \$selectionTargetId DELETE_TEST_' -and $liveCommandsetTest -match 'delete_review_view recognizes show_element_in_plan_and_3d focus view names') "Live commandset gate must cover cleanup of show_element_in_plan_and_3d wrapper focus names."
    Assert-True ($searchPolicyCode -match 'riskLevel' -and $searchPolicyCode -match 'recommendedFirstScope' -and $searchPolicyCode -match 'requiresUserControl') "Search policy must expose risk level, first-scope recommendation, and user-control flag."
    Assert-True ($searchPolicyCode -match 'verified_visibility_expensive' -and $searchPolicyCode -match 'verified_visibility_requires_exact_targets_or_approval') "Search policy must require user control for broad verified plan visibility."
    Assert-True ($searchPolicyCode -match 'normalizeWithSourceIndex' -and $searchPolicyCode -match '\(\?<\!\[\\\\p\{L\}\\\\p\{N\}\]\)' -and $searchPolicyCode -match '\(\?!\[\\\\p\{L\}\\\\p\{N\}\]\)') "Search policy concept stripping must use index-aligned normalization and avoid stripping terms inside compact element tags."
    Assert-True ($discoveryCode -match 'ResolveBuiltInCategories') "Element discovery helper must map inferred MEP categories to BuiltInCategory filters."
    Assert-True ($discoveryCode -match 'queryTokens:all') "Element discovery helper must support token-aware matching for mixed queries like MTL fan coil."
    Assert-True ($discoveryCode -match 'verifyVisibility \? element : null') "metadata plan candidates must avoid expensive per-view element visibility checks."
    Assert-True ($discoveryCode -match 'deadlineUtc' -and $discoveryCode -match 'planCandidateBudgetStopped' -and $discoveryCode -match 'max_elapsed') "Verified plan candidate discovery must honor the Revit-side elapsed budget."
    Assert-True ($discoveryCode -match 'document == null \|\| element == null' -and $discoveryCode -match 'return new List<PlanCandidateSummary>\(\)') "Element discovery helpers must guard null documents before resolving levels or finding plan candidates."
    Assert-True ($focusHelpersCode -match 'document == null \|\| element == null \|\| view == null') "Element visibility checks must guard null document, element, and view inputs before collector access."
    Assert-True ($showPlan3dToolCode -match 'responseMode: z\.enum\(\["compact", "full"\]\)') "show_element_in_plan_and_3d must expose compact/full response modes."
    Assert-True ($showPlan3dToolCode -match 'responseMode: "compact"') "show_element_in_plan_and_3d must default successful responses to compact summaries."
    Assert-True ($showPlan3dToolCode -match 'action: "show_element_in_plan_and_3d"' -and $showPlan3dToolCode -match 'state:' -and $showPlan3dToolCode -match 'guarded') "show_element_in_plan_and_3d must expose the shared lowercase minimal response contract."
    Assert-True ($showPlan3dToolCode -match 'function isGuardedResult' -and $showPlan3dToolCode -match 'guarded: isGuardedResult\(planResult\)') "show_element_in_plan_and_3d must propagate guarded plan failures to the top-level contract."
    Assert-True ($showPlan3dToolCode -match 'readCasedField as readField') "show_element_in_plan_and_3d must read normalized bridge result fields case-insensitively."
    Assert-True ($showPlan3dToolCode -notmatch 'planResult\.Success === false') "show_element_in_plan_and_3d must not miss lower-case nested success=false values."
    Assert-True ($showPlan3dToolCode -notmatch 'threeDResult && threeDResult\.Success !== false') "show_element_in_plan_and_3d must compute 3D success from normalized result casing."
    Assert-True ($openPlanToolCode -match 'responseMode: z\.enum\(\["compact", "full"\]\)') "open_existing_plan_for_element_level must expose compact/full response modes."
    Assert-True ($openPlanToolCode -match 'function compactPlanResult') "open_existing_plan_for_element_level must compact successful routine responses."
    Assert-True ($openPlanToolCode -match 'readCasedField as readField') "open_existing_plan_for_element_level must read normalized bridge result fields case-insensitively."
    Assert-True ($openPlanToolCode -notmatch 'Success: payload\.Success') "open_existing_plan_for_element_level compact output must not miss lower-case success values."
    Assert-True ($openPlanToolCode -notmatch 'Element: compactElement\(payload\.ElementInfo\)') "open_existing_plan_for_element_level compact output must not miss lower-case elementInfo values."
    Assert-True ($openPlanToolCode -match 'ResponseMode: "compact"') "open_existing_plan_for_element_level compact response must identify its response mode."
    Assert-True ($openPlanToolCode -notmatch 'trimmedPayload && trimmedPayload\.Success === false') "open_existing_plan_for_element_level compact mode must stay compact for failure responses."
    Assert-True ($showPlan3dToolCode -match 'responseMode: "full"') "show_element_in_plan_and_3d must request the full nested plan result before building its own compact summary."
    Assert-True ($smartFocusToolCode -match 'responseMode: z\.enum\(\["compact", "full"\]\)') "smart_focus_elements must expose compact/full response modes."
    Assert-True ($smartFocusToolCode -match 'responseMode: "compact"') "smart_focus_elements must default successful responses to compact summaries."
    Assert-True ($smartFocusToolCode -match 'action: "smart_focus_elements"' -and $smartFocusToolCode -match 'state:' -and $smartFocusToolCode -match 'guarded') "smart_focus_elements must expose the shared lowercase minimal response contract."
    Assert-True ($smartFocusToolCode -match 'function isGuardedResult' -and $smartFocusToolCode -match 'guarded: isGuardedResult\(planFocus\)') "smart_focus_elements must propagate guarded fallback-plan failures to the top-level contract."
    Assert-True ($smartFocusToolCode -match 'function compactSmartFocusPayload') "smart_focus_elements must build a compact successful payload."
    Assert-True ($smartFocusToolCode -match 'activeOrRequestedViewThen3D') "smart_focus_elements must run the optional 3D step after active/requested focus when create3d=true."
    Assert-True ($smartFocusToolCode -match 'Smart focus optional 3D view after active/requested focus') "smart_focus_elements must name the post-active-focus 3D step clearly."
    Assert-True ($smartFocusToolCode -match 'readCasedField as readField') "smart_focus_elements must read normalized bridge result fields case-insensitively."
    Assert-True ($smartFocusToolCode -notmatch 'planFocus\.Success === false') "smart_focus_elements must not miss lower-case nested plan success=false values."
    Assert-True ($sessionContextToolCode -match 'apiProbeState') "Session context must move tool-probe modifiable state out of the document summary."
    Assert-True ($sessionContextToolCode -match 'documentIsModifiableDuringProbe') "Session context must label probe-time modifiable state clearly."
    Assert-True ($sessionContextToolCode -match 'detailLevel: z\.enum\(\["minimal", "counts", "full"\]\)') "Session context must expose minimal/counts/full detail levels."
    Assert-True ($sessionContextToolCode -match 'detailLevel \|\| "minimal"') "Session context must default to minimal detail for large-model document checks."
    Assert-True ($sessionContextToolCode -match 'linked room/space counts require detailLevel=full') "Session context must keep linked room/space scans explicit."
    Assert-True ($sessionContextToolCode -match 'GetElementCount\(\)' -and $sessionContextToolCode -notmatch 'ToElementIds\(\)\s*\.\s*Count') "Session context counts must use GetElementCount instead of allocating element id lists."
    Assert-True ($sessionContextToolCode -notmatch 'apiProbeState\s*=\s*new\s*\{\s*isModifiable\s*=') "Session context must not expose apiProbeState.isModifiable."
    Assert-True ($activeViewContextToolCode -match 'ScheduleSheetInstance') "Active sheet context must inspect placed schedule instances."
    Assert-True ($activeViewContextToolCode -match 'scheduleSheetInstances') "Active sheet context must expose scheduleSheetInstances."
    Assert-True ($activeViewContextToolCode -match 'includeSheetScheduleInstances') "Active sheet context must allow schedule instance collection to be disabled."
    Assert-True ($instanceListToolCode -match 'documentIsModifiableDuringProbe') "Instance list must label probe-time modifiable state clearly."
    Assert-True ($instanceListToolCode -notmatch 'apiProbeState\s*=\s*new\s*\{\s*isModifiable\s*=') "Instance list must not expose apiProbeState.isModifiable."
    Assert-True ($statusToolCode -match 'runtimeIdentity') "Status output must include runtime identity metadata."
    Assert-True ($statusToolCode -match 'packageJson\?\.name \|\| "revagent-runtime"') "Status runtime identity fallback must use the canonical revAgent runtime package name."
    Assert-True ($statusToolCode -match 'runtimeVersion') "Status output must include the active runtime version."
    Assert-True ($statusToolCode -match 'schemaVersion') "Status output must include the status/schema version."
    Assert-True ($statusToolCode -match 'toolSurfaceVersion') "Status output must include the registered tool surface version."
    Assert-True ($statusToolCode -match 'revit-mcp-runtime-tools\.40') "Runtime tool surface version must be bumped when exported tool behavior/schema changes."
    Assert-True ($statusToolCode -match 'processStartedAtUtc') "Status output must include the runtime process start time."
    Assert-True ($statusToolCode -match 'buildTimestampUtc') "Status output must include build/install timestamp metadata when available."
    Assert-True ($statusToolCode -match 'buildHash') "Status output must include the git build hash when encoded in the installed version."
    Assert-True ($statusToolCode -match 'readJsonFile' -and $runtimeIdentityCode -match 'replace\(/\^\\uFEFF/') "Status identity must tolerate PowerShell-written UTF-8 BOM JSON files through the shared runtime identity helper."
    Assert-True ($statusToolCode -match 'revit-mcp-status\.v3') "Status schema must be bumped when status field names change."
    Assert-True ($statusToolCode -match '\.max\(100\)') "Status tool must allow a longer recent history limit for full-test/debug runs."
    Assert-True ($toolHelpersCode -match 'recentHistoryCount') "Status compact payload must report recent history count instead of a misleading total."
    Assert-True ($toolHelpersCode -match 'recentLimit, 3, 0, 100') "Status compact payload must preserve up to 100 recent tasks when requested."
    Assert-True ($toolHelpersCode -notmatch 'clone\.recentTasksTotal =') "Status compact payload must not emit the legacy recentTasksTotal name."
    Assert-True ($toolHelpersCode -match 'BRIDGE_RESULT_CONTRACT_VERSION = 2') "Runtime formatter must know the normalized bridge result contract version."
    Assert-True ($toolHelpersCode -match 'getResultContractVersion') "Runtime formatter must read bridge capability from each response payload."
    Assert-True ($toolHelpersCode -match 'hasCanonicalBridgeResultContract\(parsed\)') "Runtime formatter must keep canonical bridge payload normalization idempotent."
    Assert-True ($toolHelpersCode -match 'export function readCasedField') "Runtime formatter helpers must expose one shared case-tolerant field reader."
    Assert-True ($toolHelpersCode -match 'normalizeSuccessCasing') "Runtime formatter must normalize response success casing."
    Assert-True ($toolHelpersCode -match '\["Success", "success"\]' -and $toolHelpersCode -match 'delete clone\[pascalName\]') "Runtime formatter must emit canonical lowercase contract fields instead of PascalCase duplicates."
    Assert-True ($toolHelpersCode -match 'key === "PlanCandidates" \|\| key === "planCandidates"') "Plan candidate trimming must handle canonical lower-case bridge payloads."
    Assert-True ($sendCodeToolCode -match 'parseJsonResult') "Raw send_code_to_revit must expose JSON-looking result parsing."
    Assert-True ($sendCodeToolCode -match 'normalizeRevitExecutionResponse\(response,\s*\{\s*parseResultStrings:\s*true\s*\}\)') "Raw send_code_to_revit must request JSON result-string parsing by default."
    Assert-True ($toolHelpersCode -match 'parseJsonLike\(parsed,\s*depth\s*\+\s*1\)') "Runtime formatter must parse double-encoded JSON-looking result strings."
    Assert-True ($sendCodeToolCode -match 'dynamic_snippet_type_declaration_not_supported') "Raw send_code_to_revit must guard C# type declarations before Revit compile time."
    Assert-True ($sendCodeToolCode -match 'Dynamic snippets are inserted inside Execute') "Raw send_code_to_revit guard must explain method-body snippet scope."
    Assert-True ($parameterSchemaToolCode -match 'duplicateDisplayNameWarnings') "Parameter schema inspection must report duplicate display-name warnings for write preflight."
    Assert-True ($parameterSchemaToolCode -match 'write_preflight_warning') "Duplicate parameter display names must be labeled as write-preflight risk."
    Assert-True ($setParameterToolCode -match 'PRODUCTION_PARAMETER_WRITE') "set_element_parameter must identify itself as a production parameter write tool."
    Assert-True ($setParameterToolCode -match 'duplicate_display_name_blocked') "set_element_parameter must block duplicate display-name matches."
    Assert-True ($setParameterToolCode -match 'read_only_parameter_blocked') "set_element_parameter must block read-only parameters."
    Assert-True ($setParameterToolCode -match 'mode: z\.enum\(\["dryRun", "commit"\]\)') "set_element_parameter must expose explicit dryRun/commit modes."
    Assert-True ($setParameterToolCode -match 'operation: z\.enum\(\["set", "clear", "clearVisibleValue"\]\)') "set_element_parameter must expose explicit set, true-clear, and visible-clear operations."
    Assert-True ($setParameterToolCode -match 'ClearValue') "set_element_parameter clear operation must use the Revit ClearValue API when supported."
    Assert-True ($setParameterToolCode -match 'clear_value_not_supported') "set_element_parameter must report unsupported no-value clear attempts explicitly."
    Assert-True ($setParameterToolCode -match 'visible_clear_requires_string_parameter' -and $setParameterToolCode -match 'clear_visible_value_sets_empty_string_and_does_not_restore_revit_has_value_false') "set_element_parameter visible clear must be explicit and must not claim HasValue=false restore."
    Assert-True ($setParameterToolCode -match 'noValueState' -and $setParameterToolCode -match 'visible_empty_has_value' -and $parameterSchemaToolCode -match 'clearability') "Parameter write/preflight tools must distinguish true no-value from visible empty string state."
    Assert-True ($setParameterToolCode -notmatch 'visibleEmptyFallback\s*=\s*"[^"\r\n]*value=\\?"\\?"') "set_element_parameter generated C# strings must not embed unescaped value=\"\" text."
    Assert-True ($setParameterToolCode -match 'dryRunWarnings\.Add\("empty_string_set_does_not_guarantee_revit_has_value_false_use_operation_clear_when_supported"\)') "set_element_parameter dry-runs must warn when an empty string set may leave HasValue=true."
    Assert-True ($setParameterToolCode -match 'transactionMode: mode === "commit" \? "auto" : "none"') "set_element_parameter dry-runs must execute without a transaction and commits must use the wrapper transaction."
    Assert-True ($setParameterToolCode -match 'ExpectedRawAfterSet') "set_element_parameter must calculate the expected readback value before commit."
    Assert-True ($setParameterToolCode -match 'verification') "set_element_parameter must report after-write verification."
    Assert-True ($setParameterToolCode -match 'expectedCurrentRaw') "set_element_parameter must support compare-and-set current-value guards."
    Assert-True ($setParameterToolCode -match 'type_parameter_write_requires_allowTypeParameterWrite') "set_element_parameter must require explicit approval for type parameter writes."
    Assert-True ($viewHelpersCode -match 'ActiveViewChanged') "View operation results must include active-view change state."
    Assert-True ($viewHelpersCode -match 'BeforeView') "View operation results must expose a stable before-view summary."
    Assert-True ($viewHelpersCode -match 'AfterView') "View operation results must expose a stable after-view summary."
    Assert-True ($viewHelpersCode -match 'PopulateViewTransition\(ElementFocusResult') "Element focus results must use the shared before/after active-view transition helper."
    Assert-True ($focusHandlerCode -match 'PopulateViewTransition\(result, _activeViewBefore, result\.ActiveView\)') "focus_elements must populate before/after active-view diagnostics on every response."
    Assert-True ($openPlanCode -match 'PopulateViewTransition\(result, _activeViewBefore, result\.ActiveView\)') "open_existing_plan_for_element_level must populate before/after active-view diagnostics on every response."
    Assert-True ($create3dHandlerCode -match 'PopulateViewTransition\(result, _activeViewBefore, result\.ActiveView\)') "create_3d_view_for_elements must populate before/after active-view diagnostics on every response."
    Assert-True ($sectionBoxHandlerCode -match 'PopulateViewTransition\(result, _activeViewBefore, result\.ActiveView\)') "section_box_elements must populate before/after active-view diagnostics on every response."
    Assert-True ($sectionBoxHandlerCode -match 'SectionBoxState = sectionBoxActive \? "active" : "inactive"') "section_box_elements must report the resulting section-box state."
    Assert-True ($sectionBoxHandlerCode -match 'SectionBoxNote = ElementFocusHelpers\.BuildSectionBoxNote\(true, sectionBoxActive, false\)') "section_box_elements must report the same section-box note semantics as 3D view creation."
    Assert-True ($inspectElementsToolCode -match 'connectorsIncluded = includeConnectors') "inspect_elements must report whether connector counting was requested."
    Assert-True ($inspectElementsToolCode -match 'int\? connectorCount = null') "inspect_elements must leave connectorCount null when connector counting is disabled."
    Assert-True ($inspectElementsToolCode -match 'int\? openConnectorCount = null') "inspect_elements must leave openConnectorCount null when connector counting is disabled."
    Assert-True ($inspectSheetTextToolCode -match 'SHEET_TEXT_INSPECTION_READ_ONLY') "inspect_sheet_text must identify itself as a read-only sheet text inspection tool."
    Assert-True ($inspectSheetTextToolCode -match 'normalizeBroadScanResult' -and $inspectSheetTextToolCode -match 'buildBroadScanGuardedResult') "inspect_sheet_text must use the shared broad-scan result contract."
    Assert-True ($inspectSheetTextToolCode -match 'maxTextNotesPerSheet') "inspect_sheet_text must bound text-note reads by sheet."
    Assert-True ($inspectSheetTextToolCode -match 'scanScheduleCells') "inspect_sheet_text must keep placed schedule cell scanning explicit."
    Assert-True ($inspectSheetTextToolCode -match 'includeViewportTextNotes' -and $inspectSheetTextToolCode -match 'includeViewportTags' -and $inspectSheetTextToolCode -match 'viewNameQuery') "inspect_sheet_text must expose viewport-linked text-note and tag inspection parameters."
    Assert-True ($inspectSheetTextToolCode -match 'maxTags' -and $inspectSheetTextToolCode -match 'maxViewports') "inspect_sheet_text must expose roadmap tag and viewport scan cap aliases."
    Assert-True ($inspectSheetTextToolCode -match 'maxResponseBytes' -and $inspectSheetTextToolCode -match 'scanStoppedReason=max_bytes') "inspect_sheet_text must expose a native response-size budget."
    Assert-True ($inspectSheetTextToolCode -match 'sendRevitCommand\("inspect_sheet_text"' -and $inspectSheetTextToolCode -notmatch 'executeRevitCode' -and $inspectSheetTextToolCode -notmatch 'buildInspectSheetTextCode') "inspect_sheet_text must call the native commandset path instead of generating dynamic C#."
    Assert-True ($inspectSheetTextToolCode -match 'allowExpensiveSearch' -and $inspectSheetTextToolCode -match 'reason: "needs_scope"') "inspect_sheet_text must guard project-wide broad scans without explicit approval."
    Assert-True ($inspectSheetTextToolCode -match 'generic send_code_to_revit') "inspect_sheet_text must steer agents away from broad custom C# sheet scans."
    Assert-True ($inspectSheetTextToolCode -match 'placed schedule text evidence' -and $inspectSheetTextToolCode -match 'set_schedule_cells_by_text') "inspect_sheet_text must route placed schedule evidence reads before accepted follow-up writes."
    Assert-True ($inspectSheetTextCommandCode -match 'CommandName[\s\S]+inspect_sheet_text' -and $inspectSheetTextCommandCode -match 'maxElapsedMs' -and $inspectSheetTextCommandCode -match 'timeoutMs - 1000') "inspect_sheet_text command must parse native elapsed budget below socket timeout."
    Assert-True ($inspectSheetTextHandlerCode -match 'ShouldGuardNeedsScope' -and $inspectSheetTextHandlerCode -match 'reason' -and $inspectSheetTextHandlerCode -match 'needs_scope') "inspect_sheet_text native handler must own broad-search guard policy."
    Assert-True ($inspectSheetTextHandlerCode -match 'DateTime deadlineUtc' -and $inspectSheetTextHandlerCode -match 'max_elapsed' -and $inspectSheetTextHandlerCode -match 'Partial' -and $inspectSheetTextHandlerCode -match 'ScanStoppedReason') "inspect_sheet_text native handler must enforce elapsed budgets and return partial metadata."
    Assert-True ($inspectSheetTextHandlerCode -match 'MaxResponseBytes' -and $inspectSheetTextHandlerCode -match 'max_bytes' -and $inspectSheetTextHandlerCode -match 'EstimatedResponseBytes') "inspect_sheet_text native handler must stop before oversized bridge responses."
    Assert-True ($inspectSheetTextHandlerCode -match 'AddRecordsIfWithinResponseBudget\(state, record, flat\)' -and $inspectSheetTextHandlerCode -match 'AddRecordsIfWithinResponseBudget\(state, cell, flat\)') "inspect_sheet_text must budget top-level match and inventory clones with their nested records."
    Assert-True ($annotationEvidenceHelpersCode -match 'IDictionary' -and $annotationEvidenceHelpersCode -match 'DictionaryEntry') "inspect_sheet_text response-size estimates must handle generic and non-generic dictionaries."
    Assert-True ($inspectSheetTextHandlerCode -match 'NormalizedTextQuery' -and $inspectSheetTextHandlerCode -match 'ContainsPreNormalized') "inspect_sheet_text must pre-normalize repeated query text before scan loops."
    Assert-True ($annotationEvidenceHelpersCode -match 'EstimateObjectBytes\(object value, AnnotationEvidenceByteEstimateKind kind\)' -and $inspectSheetTextHandlerCode -match 'AnnotationEvidenceByteEstimateKind\.SheetText' -and $inspectSchedulesHandlerCode -match 'AnnotationEvidenceByteEstimateKind\.Schedule') "sheet and schedule scans must share the annotation evidence byte estimator."
    Assert-True ($inspectSheetTextHandlerCode -match 'TableData tableData = schedule\.GetTableData\(\)' -and $inspectSheetTextHandlerCode -match 'Schedule body section data is not available') "inspect_sheet_text schedule cell scans must guard schedules without body section data."
    Assert-True ($inspectSheetTextHandlerCode -match '!hasExplicitIds && candidateCount > _request\.MaxSheets') "inspect_sheet_text must not truncate exact sheetIds with the broad maxSheets cap."
    Assert-True ($inspectSheetTextHandlerCode -match '!requestedIds\.Add\(id\)') "inspect_sheet_text must deduplicate exact sheetIds before Revit sheet lookup."
    Assert-True ($inspectSheetTextHandlerCode -match 'state\.ScannedTextNoteCount >= _request\.MaxTextNotesScanned[\s\S]+new FilteredElementCollector\(document, sheet\.Id\)' -and $inspectSheetTextHandlerCode -match 'state\.ScannedScheduleInstanceCount >= _request\.MaxScheduleInstancesScanned[\s\S]+new FilteredElementCollector\(document, sheet\.Id\)') "inspect_sheet_text must check global caps before expensive sheet collectors."
    Assert-True ($inspectSheetTextHandlerCode -match 'state\.ScannedScheduleCellCount >= _request\.MaxScheduleCellsScanned[\s\S]+BuildScheduleCellScan\(0, 0, true' -and $inspectSheetTextHandlerCode -match '!AddRecordIfWithinResponseBudget\(viewportRecord, state\)') "inspect_sheet_text must budget schedule-cell and viewport metadata scans before expensive work."
    Assert-True ($inspectSheetTextHandlerCode -match 'new FilteredElementCollector\(document, view\.Id\)' -and $inspectSheetTextHandlerCode -match 'viewportTextNote') "inspect_sheet_text native handler must scan viewport-linked view text notes."
    Assert-True ($inspectSheetTextHandlerCode -match 'IndependentTag' -and $inspectSheetTextHandlerCode -match 'TagText' -and $inspectSheetTextHandlerCode -match 'viewportTag') "inspect_sheet_text native handler must scan viewport-linked IndependentTag evidence."
    Assert-True ($inspectSheetTextHandlerCode -match 'IsViewValidForElementIteration' -and $inspectSheetTextHandlerCode -match 'view_not_valid_for_element_iteration' -and $inspectSheetTextHandlerCode -match 'Failed to scan viewport') "inspect_sheet_text native handler must skip viewport views that cannot be iterated instead of failing the full scan."
    Assert-True ($annotationEvidenceHelpersCode -match 'IsAnnotationElementVisibleInViewCrop' -and $annotationEvidenceHelpersCode -match 'GetAnnotationCropShape' -and $annotationEvidenceHelpersCode -match 'VIEWER_ANNOTATION_CROP_ACTIVE') "Viewport tag evidence must use a shared crop/annotation-crop visibility helper."
    Assert-True ($inspectSheetTextHandlerCode -match 'IsAnnotationElementVisibleInViewCrop\(view, tag' -and $countAnnotationsHandlerCode -match 'IsAnnotationElementVisibleInViewCrop\(view, tag') "Viewport tag evidence/count paths must filter tags against the placed view crop before returning rows."
    Assert-True ($inspectSheetTextHandlerCode -notmatch 'viewport_tags_deferred') "inspect_sheet_text must not regress viewport tags to the old deferred contract."
    Assert-True ($inspectSchedulesToolCode -match 'SCHEDULE_INSPECTION_READ_ONLY') "inspect_schedules must identify itself as a read-only schedule inspection tool."
    Assert-True ($inspectSchedulesToolCode -match 'normalizeBroadScanResult' -and $inspectSchedulesToolCode -match 'buildBroadScanGuardedResult') "inspect_schedules must use the shared broad-scan result contract."
    Assert-True ($inspectSchedulesToolCode -match 'sendRevitCommand\("inspect_schedules"') "inspect_schedules must route through the native commandset bridge."
    Assert-True ($commandSetRegistryCode -match '"commandName": "inspect_schedules"') "Command payload registry must include native inspect_schedules."
    Assert-True ($inspectSchedulesToolCode -match 'maxRowsPerSection') "inspect_schedules must bound schedule cell reads by row limit."
    Assert-True ($inspectSchedulesToolCode -match 'maxColumnsPerSection') "inspect_schedules must bound schedule cell reads by column limit."
    Assert-True ($inspectSchedulesToolCode -match 'maxElapsedMs' -and $inspectSchedulesToolCode -match 'maxCells' -and $inspectSchedulesToolCode -match 'maxResponseBytes') "inspect_schedules must expose elapsed, cell, and response-byte budgets."
    Assert-True ($inspectSchedulesToolCode -match 'startRow' -and $inspectSchedulesToolCode -match 'startColumn') "inspect_schedules must expose row/column continuation scope."
    Assert-True ($inspectSchedulesHandlerCode -match 'Stop\("max_elapsed"\)' -and $inspectSchedulesHandlerCode -match 'Stop\("max_cells"\)' -and $inspectSchedulesHandlerCode -match 'Stop\("max_bytes"\)') "Native inspect_schedules handler must own elapsed, cell, and byte stop reasons."
    Assert-True ($inspectSchedulesHandlerCode -match 'lastReadRow' -and $inspectSchedulesHandlerCode -match 'lastReadColumn') "Native inspect_schedules handler must expose schedule continuation position."
    Assert-True ($inspectSchedulesHandlerCode -notmatch 'schedule\.GetTableData\(\)\.GetSectionData') "Native inspect_schedules must not dereference schedule section data before checking for a missing section."
    Assert-True ($inspectSchedulesHandlerCode -match 'TableData tableData = schedule\.GetTableData\(\)' -and $inspectSchedulesHandlerCode -match 'if \(data != null\)' -and $inspectSchedulesHandlerCode -match 'sectionType != SectionType\.Footer') "Native inspect_schedules must treat only a missing footer as a normal empty section while preserving header/body failures."
    Assert-True ($annotationEvidenceHelpersCode -match 'BuildScheduleFieldRecords' -and $annotationEvidenceHelpersCode -match 'GetFieldOrder\(\)' -and $annotationEvidenceHelpersCode -match 'ColumnHeading' -and $annotationEvidenceHelpersCode -match 'GetName\(\)' -and $annotationEvidenceHelpersCode -match 'IsHidden') "Native inspect_schedules records must expose visible ViewSchedule field metadata for column-name mapping."
    Assert-True ($reconcileScheduleAdapterCode -match 'extractNativeFieldHeaderLabels' -and $reconcileScheduleAdapterCode -match 'readNativeResultArray\(schedule, "fields"\)' -and $reconcileScheduleAdapterCode -match 'readNativeResultField\(field, "columnHeading"\)') "Schedule reconciliation adapter must resolve string column mappings from native field metadata when table header cells are only schedule titles."
    Assert-True ($inspectSchedulesToolCode -match 'allowExpensiveSearch' -and $inspectSchedulesToolCode -match 'reason: "needs_scope"') "inspect_schedules must guard broad cell scans without explicit approval."
    Assert-True (($inspectSchedulesToolCode -match 'Cell scan is bounded') -or ($inspectSchedulesHandlerCode -match 'Cell scan is bounded')) "inspect_schedules must warn when broad cell scan is requested."
    Assert-True ($inspectSchedulesToolCode -match 'local TSV conversion' -and $inspectSchedulesToolCode -match 'Do not use raw C# only to dump schedule cells') "inspect_schedules must route schedule cell export/report needs through native reads and local conversion."
    Assert-True ($countAnnotationsToolCode -match 'ANNOTATION_COUNT_READ_ONLY') "count_annotations must identify itself as a read-only annotation count tool."
    Assert-True ($countAnnotationsToolCode -match 'sendRevitCommand\("count_annotations"') "count_annotations must call the native commandset bridge."
    Assert-True ($countAnnotationsToolCode -match 'normalizeBroadScanResult' -and $countAnnotationsToolCode -match 'readNativeResultArray\(payload, "evidenceRows"\)') "count_annotations must normalize native results through casing-robust ingest."
    Assert-True ($countAnnotationsToolCode -match 'invalid_count_mode_for_sources' -and $countAnnotationsToolCode -match 'uniqueTaggedElement') "count_annotations must enforce tag-count source semantics."
    Assert-True ($countAnnotationsToolCode -match 'maxRegexPatternLength' -and $countAnnotationsToolCode -match 'regexTimeoutMs') "count_annotations must expose bounded regex profile controls."
    Assert-True ($countAnnotationsToolCode -match 'viewport_text_notes' -and $countAnnotationsToolCode -match 'viewportTextNote') "count_annotations must expose viewport text-note source aliases and evidence source types."
    Assert-True ($countAnnotationsToolCode -match 'placed_schedule_cells' -and $countAnnotationsToolCode -match 'placed_schedule_cell' -and $countAnnotationsToolCode -match 'schedule_cells' -and $countAnnotationsToolCode -match 'schedule_cell' -and $countAnnotationsToolCode -match 'maxScheduleCellsScanned') "count_annotations must expose placed schedule-cell source aliases and cell scan caps."
    Assert-True ($countAnnotationsToolCode -match 'placedScheduleCell') "count_annotations wrapper must normalize placed schedule-cell evidence source types."
    Assert-True ($countAnnotationsHandlerCode -match 'Failed to scan viewport' -and $countAnnotationsHandlerCode -match 'new FilteredElementCollector\(document, view\.Id\)') "count_annotations viewport annotation scans must isolate per-viewport scan failures instead of failing the full command."
    Assert-True ($countAnnotationsHandlerCode -match 'ScanViewportAnnotations' -and $countAnnotationsHandlerCode -match 'viewportTextNote' -and $countAnnotationsHandlerCode -match 'viewport_text_note') "count_annotations native handler must scan viewport text-note evidence."
    Assert-True ($countAnnotationsHandlerCode -match 'ScanPlacedScheduleCells' -and $countAnnotationsHandlerCode -match 'BuildPlacedScheduleCellEvidenceRow' -and $countAnnotationsHandlerCode -match 'Stop\("max_cells"\)' -and $countAnnotationsHandlerCode -match 'Stop\("max_rows"\)' -and $countAnnotationsHandlerCode -match 'Stop\("max_columns"\)') "count_annotations native handler must scan placed schedule cells with shared evidence helpers and canonical row/column/cell caps."
    Assert-True ($countAnnotationsHandlerCode -match 'Failed to scan text notes on sheet') "count_annotations sheet text-note scans must isolate per-sheet failures with a warning."
    Assert-True ($countAnnotationsHandlerCode -match 'SheetIds\.Distinct\(\)' -and $countAnnotationsHandlerCode -match 'sheet == null \|\| sheet\.IsTemplate') "count_annotations must deduplicate exact sheetIds and skip template sheets before scanning."
    Assert-True ($commandSetRegistryCode -match '"commandName": "count_annotations"') "Command payload registry must include native count_annotations."
    foreach ($reason in @("completed", "max_elapsed", "max_rows", "max_columns", "max_cells", "max_items", "max_bytes", "read_failed", "needs_scope")) {
        Assert-True ($broadScanResultCode -match [regex]::Escape('"' + $reason + '"')) "Shared broad-scan result contract is missing stop reason '$reason'."
    }
    foreach ($field in @("summary", "evidenceRows", "lastReadSection", "lastReadRow", "lastReadColumn", "lastReadSheetId", "lastReadViewId", "lastReadViewportId", "lastReadItemId")) {
        Assert-True ($broadScanResultCode -match [regex]::Escape('"' + $field + '"')) "Shared broad-scan result contract is missing field '$field'."
    }
    Assert-True ($setScheduleCellsToolCode -match 'PRODUCTION_SCHEDULE_CELL_WRITE') "set_schedule_cells must identify itself as a production schedule-cell write tool."
    Assert-True ($setScheduleCellsToolCode -match 'Defaults to dryRun') "set_schedule_cells must default to dry-run behavior."
    Assert-True ($setScheduleCellsToolCode -match 'expectedCurrentText') "set_schedule_cells must support expected current value preflight."
    Assert-True ($setScheduleCellsToolCode -match 'transactionMode: mode === "commit" \? "auto" : "none"') "set_schedule_cells must use auto transactions only for commit mode."
    Assert-True ($setScheduleCellsToolCode -match 'non_writable_standard_body_cell') "set_schedule_cells dry-run must guard non-writable standard schedule body cells before commit."
    Assert-True ($setScheduleCellsToolCode -match 'Schedule cell text writes are not a raw-code reason' -and $setScheduleCellsToolCode -match 'Do not use this for visual schedule formatting') "set_schedule_cells must steer exact schedule text writes away from raw code while excluding formatting workflows."
    Assert-True ($setScheduleCellsToolCode -match 'IsStandardScheduleBodyCellWriteForbidden' -and $setScheduleCellsToolCode -match 'IsKeySchedule') "set_schedule_cells must distinguish standard body cells from writable key schedule/header/footer cells."
    Assert-True ($setScheduleCellsToolCode -match 'bool standardScheduleBodyCellWriteForbidden = IsStandardScheduleBodyCellWriteForbidden\(schedule, sectionType\);') "set_schedule_cells must compute the standard body-cell guard once per schedule section."
    Assert-True ($setScheduleCellsToolCode -match 'if \(!dryRun\)') "set_schedule_cells commit exceptions must escape the snippet so the wrapper transaction can roll back."
    Assert-True ($setScheduleCellsByTextToolCode -match 'PRODUCTION_SCHEDULE_CELL_WRITE_BY_TEXT') "set_schedule_cells_by_text must identify itself as a production schedule row-text write tool."
    Assert-True ($setScheduleCellsByTextToolCode -match 'rowTextQuery') "set_schedule_cells_by_text must require bounded row text matching."
    Assert-True ($setScheduleCellsByTextToolCode -match 'allowMultipleMatches') "set_schedule_cells_by_text must block ambiguous multi-row writes by default."
    Assert-True ($setScheduleCellsByTextToolCode -match 'expectedCurrentText') "set_schedule_cells_by_text must support compare-and-set target cell protection."
    Assert-True ($setScheduleCellsByTextToolCode -match 'transactionMode: mode === "commit" \? "auto" : "none"') "set_schedule_cells_by_text must use auto transactions only for commit mode."
    Assert-True ($setScheduleCellsByTextToolCode -match 'non_writable_standard_body_cell') "set_schedule_cells_by_text dry-run must guard non-writable standard schedule body cells before commit."
    Assert-True ($setScheduleCellsByTextToolCode -match 'IsStandardScheduleBodyCellWriteForbidden' -and $setScheduleCellsByTextToolCode -match 'IsKeySchedule') "set_schedule_cells_by_text must distinguish standard body cells from writable key schedule/header/footer cells."
    Assert-True ($setScheduleCellsByTextToolCode -match 'bool standardScheduleBodyCellWriteForbidden = IsStandardScheduleBodyCellWriteForbidden\(schedule, sectionType\);') "set_schedule_cells_by_text must compute the standard body-cell guard once per schedule."
    Assert-True ($setScheduleCellsByTextToolCode -match 'generic send_code_to_revit') "set_schedule_cells_by_text tool description must steer agents away from raw schedule write snippets."
    Assert-True ($setScheduleCellsByTextToolCode -match 'Schedule cell text writes are not a raw-code reason' -and $setScheduleCellsByTextToolCode -match 'visible row text, item code, equipment tag, or schedule line label') "set_schedule_cells_by_text must steer row-text schedule writes away from raw code."
    Assert-True ($safeCodeGuardsCode -match 'Schedule\.SetCellText') "send_code_to_revit_safe write guards must detect schedule cell text writes."
    $activateViewHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\ActivateViewEventHandler.cs")
    $viewCommandHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revAgentCommandSet\Commands\View\ViewCommandHelpers.cs")
    Assert-True ($activateViewHandlerCode -match 'Changed = true,\s+ActiveViewChanged = true') "activate_view must mark ActiveViewChanged when it successfully changes the active view."
    Assert-True ($viewCommandHelpersCode -match 'public bool\? DryRun' -and $viewCommandHelpersCode -match 'public bool\? Deleted' -and $viewCommandHelpersCode -match 'NullValueHandling = NullValueHandling.Ignore') "Navigation view results must not leak cleanup-only delete_review_view fields."
    Assert-True ($closeViewCode -match 'Changed = closed \|\| activeViewChanged') "close_view must mark Changed when a view is closed or active view changes."
    Assert-True ($viewImageToolCode -match 'enforcePixelSize') "View image export must expose enforcePixelSize."
    Assert-True ($viewImageToolCode -match 'resizeImageToRequestedPixelSize') "View image export must normalize exported image dimensions after Revit export."
    Assert-True ($viewImageToolCode -match 'finalPixelSizeMatchesRequest') "View image export must explicitly report whether the final image dimension matches the request."
    Assert-True ($viewImageToolCode -notmatch 'selectedView is ViewSheet') "View image export must allow DrawingSheet exports."
    Assert-True ($viewImageToolCode -match 'allowTemporaryScheduleSheet') "View image export must expose controlled direct Schedule export through a temporary sheet."
    Assert-True ($viewImageToolCode -match 'ViewSheet\.Create') "View image export must create a temporary sheet for direct Schedule export."
    Assert-True ($viewImageToolCode -match 'ScheduleSheetInstance\.Create') "View image export must place the Schedule on the temporary export sheet."
    Assert-True ($viewImageToolCode -match 'temporaryScheduleSheetDeletedBeforeCommit') "View image export must report whether temporary Schedule sheet cleanup was confirmed."
    Assert-True ($viewImageToolCode -match 'placedOnSheets') "Schedule export output should include sheets that already contain the schedule when available."
    Assert-True ($safeCodeToolCode -match 'formatSafetyBlock') "Safe dynamic execution wrapper must classify expected write rejections as guarded safety blocks."
    Assert-True ($safeCodeToolCode -match 'safe_wrapper_rejected_write_looking_code') "Safe dynamic execution wrapper must expose a stable safety reason for write-looking snippets."
    Assert-True ($telemetryCode -match 'normalizeMachineName') "Telemetry must normalize machine names before building NAS event paths."
    Assert-True ($telemetryCode -match 'REVAGENT_TELEMETRY_CODE_CHARS') "Telemetry must capture bounded code previews for semantic usage analysis."
    Assert-True ($telemetryCode -match 'production\.context') "Telemetry must emit production-context events for dashboard/master-LLM analysis."
    Assert-True ($telemetryCode -match 'REVAGENT_TELEMETRY_CONTEXT_ELEMENTS') "Telemetry must bound production-context element samples."
    Assert-True ($telemetryCode -match 'disciplineHint') "Production context must include a discipline hint for office workload analysis."
    Assert-True ($telemetryCode -match 'rejected write-looking code') "Telemetry must classify safe-wrapper write rejections as guarded outcomes."
    Assert-True ($telemetryCode -match 'revagent\.live\.status\.v1') "Telemetry must write live dashboard status snapshots."
    Assert-True ($telemetryCode -match 'revagent\.live\.activity\.v1') "Telemetry must write live dashboard activity events."
    Assert-True ($telemetryCode -match 'REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT') "Live dashboard writes must have a bounded in-flight limit."
    Assert-True ($telemetryCode -match 'recordLiveActivityStarted') "Live dashboard feed must record started activity."
    Assert-True ($telemetryCode -match 'recordLiveActivityFinished') "Live dashboard feed must record completed/guarded/failed activity."
    Assert-True ($toolHelpersCode -match 'recordLiveActivityStarted') "Revit command helpers must publish live activity starts."
    Assert-True ($toolHelpersCode -match 'recordLiveActivityFinished') "Revit command helpers must publish live activity finishes."
    Assert-True ($apiDocsIndexCode -match 'getMemberNameAliases') "API docs resolver must support common Revit member aliases."
    Assert-True ($apiDocsIndexCode -match 'revit_xml_docs_parameter_indexer_property') "API docs resolver must alias get_Parameter(...) to the Element.Parameter XML docs property."
    Assert-True ($create3dToolCode -match 'LIVE_VIEW_NAVIGATION_PRIMITIVE') "create_3d_view_for_elements must identify itself as the live 3D navigation primitive."
    Assert-True ($showPlan3dToolCode -match 'LIVE_VIEW_WORKFLOW_WRAPPER') "show_element_in_plan_and_3d must identify itself as the live plan+3D workflow wrapper."
    Assert-True ($coordinationImageToolCode -match 'VISUAL_ARTIFACT_EXPORT_ONLY') "Coordination image export must identify itself as an image artifact export tool."
    Assert-True ($coordinationImageToolCode -match 'allowFullViewFallback') "Coordination image export must require explicit full-view fallback when requested element ids are all missing."
    Assert-True ($coordinationImageToolCode -match 'no_requested_elements_found') "Coordination image export must return a stable guard reason when no requested elements are found."
    Assert-True ($coordinationImageToolCode -match 'requestedElementIds\.Count > 0 && targetElements\.Count == 0 && !allowFullViewFallback') "Coordination image export must guard missing requested element ids before full-view export."
    Assert-True ($coordinationImageToolCode -match 'parseElementIds') "Coordination image export must validate supplied elementIds before C# list generation."
    Assert-True ($coordinationImageToolCode -match 'invalid_element_ids') "Coordination image export must guard non-numeric supplied elementIds instead of silently exporting full view evidence."
    Assert-True ($coordinationImageToolCode -match 'Number\.isSafeInteger\(value\)') "Coordination image export must reject unsafe numeric element ids before C# list generation."
    Assert-True ($coordinationImageToolCode -match 'createdViews') "Coordination image export must report created review views for cleanup/audit."
    Assert-True ($coordinationImageToolCode -match 'cleanupAfterExport: z\.boolean') "Coordination image export must expose a user-controlled cleanupAfterExport parameter."
    Assert-True ($coordinationImageToolCode -match 'cleanupAfterExportRequested') "Coordination image export must report whether cleanupAfterExport was requested."
    Assert-True ($coordinationImageToolCode -match 'cleanupAfterExportApplied') "Coordination image export must report cleanup behavior explicitly."
    Assert-True ($coordinationImageToolCode -match 'deletedAfterExport') "Coordination image export must report whether a created review view was deleted after export."
    Assert-True ($coordinationImageToolCode -match 'documentMayRemainModified') "Coordination image export must report that cleanup is not a fully trace-free Revit dirty-flag mode."
    Assert-True ($coordinationImageToolCode -match 'persistentPhysicalElementChanges = false') "Coordination image export must report that it does not change physical MEP elements."
    Assert-True ($coordinationImageToolCode -match 'Do not use this as the primary tool for live view navigation') "Coordination image export must warn against live view navigation use."
    Assert-True ($coordinationImageToolCode -match 'targetVisualStyle') "Coordination image export must expose target visual style profiles."
    Assert-True ($coordinationImageToolCode -match 'resolveAutoTargetVisualStyle') "Coordination image export must resolve auto target visual style explicitly."
    Assert-True ($coordinationImageToolCode -match '(?s)intent === "coordination_overlay".*return "outline_only"') "Coordination image export auto style must not default coordination overlays to high-contrast QA."
    Assert-True ($coordinationImageToolCode -match '(?s)intent === "raw_evidence".*return "raw"') "Coordination image export auto style must keep raw evidence unhighlighted."
    Assert-True ($coordinationImageToolCode -match '(?s)intent === "system_focus".*return "technical_report"') "Coordination image export auto style must map system focus to technical report styling."
    Assert-True ($coordinationImageToolCode -match '(?s)intent === "clash_clearance".*return "technical_report"') "Coordination image export auto style must map clash clearance to technical report styling."
    Assert-True ($coordinationImageToolCode -match 'qa_high_contrast is used only when explicitly requested') "Coordination image export must keep high-contrast QA styling explicit-only."
    Assert-True ($coordinationImageToolCode -match 'isQaHighContrast \? 12 : 1') "Coordination image export must preserve thick QA linework only in high-contrast mode."
    Assert-True ($coordinationImageToolCode -match 'technical_report') "Coordination image export must support a softer technical-report target style."
    Assert-True ($coordinationImageToolCode -match 'outline_only') "Coordination image export must support outline-only target highlighting."
    Assert-True ($coordinationImageToolCode -match '\"raw\"') "Coordination image export must support raw target style with no target override."
    Assert-True ($coordinationImageToolCode -match 'targetOverrideApplied') "Coordination image export must report whether a target override was applied."
    Assert-True ($coordinationImageToolCode -match 'targetOverrideResetCount') "Coordination image export must clear stale target element overrides before applying the requested style."
    Assert-True ($coordinationImageToolCode -match 'isOutlineOnly \? 100 : 85') "Coordination image export must make outline-only target surfaces transparent and report surfaces highly transparent."
    Assert-True ($coordinationImageToolCode -match 'singleElementMarginMm') "Coordination image export must expose a tighter single-element margin."
    Assert-True ($coordinationImageToolCode -match 'preExportPixelSize') "Coordination image export must separate Revit source export resolution from final image size."
    Assert-True ($coordinationImageToolCode -match 'maxAutoPreExportPixelSize') "Coordination image export must cap automatic high-resolution source exports."
    Assert-True ($coordinationImageToolCode -match 'allowFinalUpscale') "Coordination image export must let callers control whether tiny source crops may be enlarged to the final image size."
    Assert-True ($coordinationImageToolCode -match 'width = width') "Coordination image export files must report width."
    Assert-True ($coordinationImageToolCode -match 'height = height') "Coordination image export files must report height."
    Assert-True ($coordinationImageToolCode -match 'resizeImageToRequestedPixelSize') "Coordination image export must normalize exported image dimensions after Revit export."
    Assert-True ($coordinationImageToolCode -match 'SetOrientation\(new ViewOrientation3D') "Coordination image export must frame the 3D camera to the target section box."
    Assert-True ($coordinationImageToolCode -match 'cameraFramedToTargets') "Coordination image export must report whether target camera framing was applied."
    Assert-True ($coordinationImageToolCode -match 'analyzeCoordinationImageQuality') "Coordination image export raster work must be a QA analysis step, not the primary framing mechanism."
    Assert-True ($coordinationImageToolCode -match 'targetMinFillRatio') "Coordination image export must expose a minimum target fill ratio for model-bbox projection crops."
    Assert-True ($coordinationImageToolCode -match 'actualHighlightFillRatio') "Coordination image export must report actual target-highlight fill only as a raster QA metric."
    Assert-True ($coordinationImageToolCode -match 'applySurfaceFill') "Coordination image export must limit surface fill to visual styles that request it."
    Assert-True ($coordinationImageToolCode -match 'surfaceTransparency = isQaHighContrast \? 1') "Coordination image export must preserve opaque QA highlighting only in high-contrast mode."
    Assert-True ($coordinationImageToolCode -match 'g >= 105') "Coordination image export must tolerate anti-aliased green target pixels."
    Assert-True ($coordinationImageToolCode -match 'isTargetYellow') "Coordination image export must detect non-green/yellow Revit target highlight output."
    Assert-True ($coordinationImageToolCode -match 'isTargetHighChroma') "Coordination image export must detect high-chroma Revit target highlight output when exact override colors drift."
    Assert-True ($coordinationImageToolCode -match 'model_bbox_projection') "Coordination image export must use model_bbox_projection as the primary single-target crop basis."
    Assert-True ($coordinationImageToolCode -match 'inverseCropTransform') "Coordination image export must map target model bounding boxes through the Revit view crop transform."
    Assert-True ($coordinationImageToolCode -match 'modelCropBoxApplied') "Coordination image export must report when the Revit 3D view crop box was tightened from model geometry."
    Assert-True ($coordinationImageToolCode -match 'reviewView\.CropBox = tightenedCrop') "Coordination image export must tighten the Revit view crop box before raster export for single-target model crops."
    Assert-True ($coordinationImageToolCode -match 'coordination_model_crop_box_tighten_failed') "Coordination image export must warn if model crop-box tightening fails."
    Assert-True ($coordinationImageToolCode -match 'target_highlight_pixels_not_detected') "Coordination image export must warn, not fail, when highlighted target pixels are not detected."
    Assert-True ($coordinationImageToolCode -match 'target_highlight_pixels_not_detected_visual_style_expected') "Coordination image export must report missing highlight pixels in raw/outline styles as an expected notice."
    Assert-True ($coordinationImageToolCode -match 'notices = notices') "Coordination image export must return notice-level diagnostics separately from warnings."
    Assert-True ($coordinationImageToolCode -match 'croppedToModelProjection') "Coordination image export must report whether model-projection framing was used."
    Assert-True ($coordinationImageToolCode -match 'postProcessedCropApplied') "Coordination image export must explicitly report post-process crop use."
    Assert-True ($coordinationImageToolCode -match 'rasterPostCropApplied') "Coordination image export must explicitly report raster-highlight fallback crop use."
    Assert-True ($coordinationImageToolCode -match 'cropBasis') "Coordination image export must report whether crop came from model projection or highlight pixels."
    Assert-True ($coordinationImageToolCode -match 'estimatedTargetFillRatio') "Coordination image export must expose model-estimated target fill separately from actual highlight fill."
    Assert-True ($coordinationImageToolCode -match '0\.04 / safeFillRatio') "Coordination image export model-bbox crop must use a tight center crop guard when target pixels cannot be measured."
    Assert-True ($coordinationImageToolCode -match 'IgnoreImageCache') "Coordination image export must bypass WPF URI caching so resize uses the cropped image, not the original wide export."
    Assert-True ($coordinationImageToolCode -notmatch 'bbox_center_fallback') "Coordination image export must no longer describe model-bbox projection as a fallback crop."
    Assert-True ($coordinationImageToolCode -match 'highlightCropPaddingPx: z\.number\(\)\.int\(\)\.min\(0\)\.max\(2000\)\.optional\(\)\.default\(24\)') "Coordination image export must use tight default highlight padding so small targets do not stay tiny."
    Assert-True ($coordinationImageToolCode -match 'model_bbox_projection_post_crop') "Coordination image export must keep model-projection post-crop only as a fallback path."
    Assert-True ($coordinationImageToolCode -match 'highlight_pixels_post_crop_fallback') "Coordination image export must keep raster-highlight cropping only as a fallback path."
    Assert-True ($coordinationImageToolCode -match 'projectionDesiredSide') "Coordination image export fallback crops must size model-projection crops from targetMinFillRatio."
    Assert-True ($coordinationImageToolCode -match 'auto_model_bbox_projection_source_resolution') "Coordination image export must automatically raise source export resolution before model-projection crop."
    Assert-True ($coordinationImageToolCode -match 'options\.PixelSize = revitExportPixelSize') "Coordination image export must use the pre-export resolution for Revit ExportImage."
    Assert-True ($coordinationImageToolCode -match 'image_source_crop_below_final_pixel_size') "Coordination image export must warn when a crop source is upscaled to final pixel size."
    Assert-True ($coordinationImageToolCode -match 'target_fill_limited_by_source_resolution') "Coordination image export must warn when it preserves source quality by widening the crop below the requested target fill ratio."
    Assert-True ($coordinationImageToolCode -match 'default\(10000\)') "Coordination image export automatic pre-export resolution must use a conservative default Revit source cap."
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
    Write-RevAgentJsonFile -Path (Join-Path $versionWorkRoot "installed.json") -Value ([ordered]@{
            version = "2026.05.22.localtest-abc"
        })
    Write-RevAgentJsonFile -Path $configPath -Value ([ordered]@{
            installRoot = $versionStatusRoot
            workRoot = $versionWorkRoot
            channelManifestPath = $channelPath
        })
    Write-RevAgentJsonFile -Path $channelPath -Value ([ordered]@{
            app = "revit-mcp-skill"
            channel = "stable"
            version = "2026.05.15.1259-b397869c"
        })
    $versionOutput = & (Join-Path $RepoRoot "installer\nas\show-installed-version.ps1") -ConfigPath $configPath 2>&1 6>&1 | Out-String
    Assert-True ($versionOutput -match 'install/repair available') "Newer local/dev install should be reported as install/repair available against an older release target."
    Assert-True ($versionOutput -match 'revAgent status') "Version status window must use the revAgent product name."
    Assert-True ($versionOutput -notmatch 'Revit MCP version status|Install root|Manual update|Config\s+:|Stable|Channel\s+:|Channel version') "Default version status must not expose internal product, path details, or legacy channel wording."

    Write-RevAgentJsonFile -Path $channelPath -Value ([ordered]@{
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
    Assert-True ($publishText -match 'function Copy-RevAgentUserPack') "Publish must build an allowlisted user pack instead of copying the repo root."
    Assert-True ($publishText -match 'installer\\codex-user\\SKILL\.md') "Publish must use the user orchestration SKILL.md."
    Assert-True ($publishText -match 'Copy-UserPackFile -SourceRelativePath "CHANGELOG\.md"' -and $publishText -match 'changelog = "CHANGELOG\.md"') "User pack must include the changelog and hash it in the release manifest."
    Assert-True ($publishText -match 'update-from-nas\.ps1' -and $publishText -match 'show-installed-version\.ps1' -and $publishText -match 'install-updater-task\.ps1') "User pack must include only workstation updater entrypoints from installer\\nas."
    Assert-True ($publishText -match 'revAgent Updater STABLE\.cmd' -and $publishText -match 'Install-revAgent-Updater-GUI\.cmd' -and $publishText -match 'Install-revAgent-Updater-GUI\.ps1' -and $publishText -match 'Install-revAgent-Updater\.cmd') "NAS tools must publish revAgent-named user launcher files."
    Assert-True ($publishText -match 'scripts\\publish-desktop-launcher-evidence\.ps1' -and $publishText -match 'toolsRoot "publish-desktop-launcher-evidence\.ps1"') "NAS tools must publish the desktop launcher evidence helper for rollout closure."
    Assert-True ($publishText -match 'scripts\\collect-rollout-evidence\.ps1' -and $publishText -match 'toolsRoot "collect-rollout-evidence\.ps1"') "NAS tools must publish the SSH rollout evidence collector for rollout closure."
    Assert-True ($publishText -match 'scripts\\invoke-live-smoke-over-ssh\.ps1' -and $publishText -match 'toolsRoot "invoke-live-smoke-over-ssh\.ps1"') "NAS tools must publish the SSH live smoke runner for representative Revit tests."
    Assert-True ($publishText -match 'scripts\\test-commandset-live\.ps1' -and $publishText -match 'toolsRoot "test-commandset-live\.ps1"') "NAS tools must publish the live smoke evidence helper for rollout closure."
    Assert-True ($publishText -match 'Copy-UserPackReleaseMcpPackage -SourceRelativePath "installer\\runtime-mcp-server"' -and $publishText -match 'Copy-UserPackReleaseMcpPackage -SourceRelativePath "installer\\revit-api-docs-mcp"') "User pack must use hardened MCP release bundles instead of developer build trees."
    Assert-True ($publishText -match '\$releaseSchemasPath' -and $publishText -match '\$destinationSchemasPath' -and $publishText -match 'missing published Spatial Phase 0 schema') "Source-free runtime packaging must copy and verify the published Spatial Phase 0 schemas."
    Assert-True ($publishText -match 'Assert-RevAgentUserPackNoSourceLeak -Root \$packageRoot') "Publish must gate the user pack against source/developer artifact leaks."
    Assert-True ($publishText -match '"addons"') "Publish source-leak gate must block admin add-on payloads from the workstation user pack."
    Assert-True ($publishText -match 'Assert-RevAgentUserPackDotNetPayloadHardened -Root \$packageRoot') "Publish must gate the user pack against .NET debug symbol artifacts."
    Assert-True ($publishText -match 'Assert-RevAgentUserPackHardenedJsPayload -Root \$packageRoot') "Publish must gate the user pack against unhardened JavaScript payloads."
    Assert-True ($publishText -match 'runtimeBundle = "installer\\runtime-mcp-server\\build\\index\.js"' -and $publishText -match 'docsServerBundle = "installer\\revit-api-docs-mcp\\build\\index\.js"') "Release manifest must hash hardened JavaScript bundle entrypoints."
    Assert-True ($publishText -match 'Get-RevAgentUserPackPathParts' -and $publishText -match 'Test-RevAgentUserPackIgnoredDependencyPath') "Publish source-leak gate must use path-component dependency exclusions."
    Assert-True ($publishText -notmatch 'Copy-DirectoryFiltered -Source \$RepoRoot -Destination \$packageRoot') "Publish must not stage releases by copying the repo root."
    Assert-True ($publishText -notmatch 'Copy-UserPackDirectory -SourceRelativePath "installer\\nas"') "Versioned user pack must not copy deployment tooling wholesale."
    Assert-True ($publishText -match 'Copy-RevAgentAdminAddonTools' -and $publishText -match 'toolsRoot "addons"') "Publish must copy admin add-ons only into NAS tools\\addons."
    Assert-True ($publishText -notmatch 'src\\revit-plugin\\revAgentPlugin\\revAgentPlugin\.csproj') "Release manifest components must not include developer source project files."
    $stableLauncherText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\revAgent Updater STABLE.cmd")
    Assert-True ($stableLauncherText -match 'revAgent-deploy' -and $stableLauncherText -notmatch 'revit-mcp-deploy' -and $stableLauncherText -notmatch 'LEGACY_ROOT') "Standalone stable launcher must use only the canonical revAgent NAS root after compatibility-root retirement."

    Write-Host "Test initial updater invocation binding"
    $installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
    Assert-True ($installTaskText -match 'Resolve-RevAgentCanonicalNasTransitionPath' -and $installTaskText -match 'revAgent-deploy' -and $installTaskText -match 'revit-mcp-deploy' -and $installTaskText -match 'Canonical NAS release root detected') "Updater installer must persist canonical NAS channel config when the new deploy root is available."
    Assert-True ($installTaskText -match '& \$UpdaterPath -ConfigPath \$UpdaterConfigPath -NoNotifyUser -AllowManualCodexSetup') "Initial update check must pass ConfigPath as a named parameter."
    Assert-True ($installTaskText -notmatch '& \$UpdaterPath @arguments') "Initial update check must not array-splat named parameter strings into a script call."
    Assert-True ($installTaskText -match '\[string\]\$DailyAt = "12:00"') "Updater scheduled-task installer must default to daily noon checks."
    Assert-True ($installTaskText -match '\[string\]\$TaskName = "revAgent Auto Update"') "Updater scheduled task must use the revAgent product name by default."
    Assert-True ($installTaskText -match 'DPE\\revAgent') "Updater scheduled-task installer must default to the revAgent install root."
    Assert-True ($installTaskText -match 'Update-revAgent-Now\.cmd' -and $installTaskText -match 'Show-revAgent-Version\.cmd') "Updater scheduled-task installer must create revAgent-named helper commands."
    Assert-True ($installTaskText -match 'New-RevAgentDailyUpdateTrigger -DailyAt \$DailyAt') "Updater scheduled-task installer must use the shared daily trigger helper."
    Assert-True ($installTaskText -notmatch 'New-ScheduledTaskTrigger -AtLogOn') "Updater scheduled task must not run at logon."
    Assert-True ($installTaskText -notmatch 'RepetitionInterval') "Updater scheduled task must not repeat through the day."
    Assert-True ($installTaskText -notmatch 'StartWhenAvailable') "Updater scheduled task must not start immediately for a missed noon trigger during GUI RunNow installs."
    Assert-True ($installTaskText -match 'dailyAt = \$DailyAt') "Updater config must persist the daily check time for future repairs."
    Assert-True ($installTaskText -match 'codexInstructionPolicy = \$CodexInstructionPolicy' -and $installTaskText -match 'Resolve-CodexInstructionPolicy') "Updater config must persist the Codex instruction policy for future repairs."
    Assert-True ($installTaskText -match 'Task schedule\s+: daily at \$DailyAt') "Updater install output must report the daily schedule."
    Assert-True ($installTaskText -match '"revAgent Auto Update\.vbs"') "Startup fallback reminder must use the revAgent product name."
    Assert-True ($installTaskText -match 'Revit MCP Auto Update\.cmd", "Revit MCP Auto Update\.vbs"') "Startup fallback must remove legacy Revit MCP reminder launchers."
    Assert-True ($installTaskText -match 'Removed legacy task: \$legacyTaskName') "Updater install must remove the legacy Revit MCP scheduled task after registering the revAgent task."
    $scheduledTaskModuleText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.ScheduledTask.psm1")
    Assert-True ($scheduledTaskModuleText -match '\[string\]\$Name = "revAgent Auto Update"') "Scheduled-task repair must default to the revAgent task name."
    Assert-True ($scheduledTaskModuleText -match '\[string\[\]\]\$LegacyNames = @\("Revit MCP Auto Update"\)') "Scheduled-task repair must know the legacy Revit MCP task name."
    Assert-True ($scheduledTaskModuleText -match 'Scheduled task migrated to revAgent product name') "Scheduled-task repair must migrate existing installed reminders to the revAgent task name."
    $hiddenLauncherModuleText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.HiddenLauncher.psm1")
    Assert-True ($hiddenLauncherModuleText -match 'Run-revAgent-Update-Hidden\.vbs' -and $scheduledTaskModuleText -match 'Removed legacy hidden updater launcher') "Scheduled-task repair must use and clean revAgent-named hidden launcher files."
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
    Assert-True ($updaterText -match '\[string\]\$TaskName = "revAgent Auto Update"') "Updater reminder task name must default to revAgent."
    Assert-True ($updaterText -match 'DPE\\revAgent' -and $updaterText -match 'Legacy install root detected in updater config') "Updater must migrate legacy RevitMCP configs to the revAgent root."
    Assert-True ($updaterText -match 'Then run the revAgent updater again') "Updater missing-dependency guidance must use the revAgent product name."
    Assert-True ($updaterText -notmatch 'Then run the Revit MCP updater again') "Updater reminder/error windows must not ask users to run the Revit MCP updater."
    Assert-True ($updaterText -match 'app = "revAgent"') "Notification throttle state must use the revAgent product name."
    Assert-True ($updaterText -match 'dependencies\\npm') "Updater must use the managed local npm dependency cache."
    Assert-True ($updaterText -match 'Restore-NpmDependenciesFromCache') "Updater must restore matching npm dependencies from cache before installing."
    Assert-True ($updaterText -match 'Remove-StaleNpmDependencyJunction') "Updater must remove stale cached dependency junctions before refreshing."
    Assert-True ($updaterText -match 'Invoke-NpmInstallIfNeeded -NpmPath \$npmPath -WorkingDirectory \$ServerTarget .* -CacheRoot \$npmDependencyCacheRoot') "Runtime npm install must use the dependency gate."
    Assert-True ($updaterText -match 'Invoke-NpmInstallIfNeeded -NpmPath \$npmPath -WorkingDirectory \$docsServerPath .* -CacheRoot \$npmDependencyCacheRoot') "Docs server npm install must use the dependency gate."
    Assert-True ($updaterText.IndexOf('Already up to date.') -lt $updaterText.IndexOf('Initialize-RevAgentWorkstationProxy -ProxyUrl')) "No-op current updates must return before proxy setup."
    Assert-True ($updaterText.IndexOf('Already up to date.') -lt $updaterText.IndexOf('Ensure-UpdateDependencies -SkipNpmInstall')) "No-op current updates must return before Node/Codex/npm dependency checks."
    Assert-True ($updaterText.IndexOf('deferred-revit-close-required') -lt $updaterText.IndexOf('Ensure-UpdateDependencies -SkipNpmInstall')) "Revit-close deferrals must return before Node/Codex/npm dependency checks."
    Assert-True ($updaterText -match 'if \(\$runningRevit\)\s*\{\s*Write-Warning "Revit is running, but this update does not change Revit add-in/command files') "Updater must only warn that Revit is running when Revit.exe is actually detected."
    Assert-True ($updaterText -match '\$Status -eq "updated"') "Completed version transition must only be reported for successful updates."
    Assert-True ($updaterText -match 'pendingVersionTransition') "Deferred or available updates must be reported as pending, not completed transitions."
    $statusText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\show-installed-version.ps1")
    Assert-True ($statusText -match 'Pending update') "Status output must label deferred updates as pending updates."

    Write-Host "Test proxy, Codex config, and report helpers"
    Assert-Equal (ConvertTo-RevAgentProxyUrl -Value "192.168.90.10 6588") "http://192.168.90.10:6588" "Proxy URL normalization failed."
    Assert-Equal (ConvertTo-RevAgentWinHttpProxyServer -Value "http://192.168.90.10:6588") "192.168.90.10:6588" "WinHTTP proxy normalization failed."
    Assert-Equal (ConvertTo-RevitMcpProxyUrl -Value "192.168.90.10 6588") "http://192.168.90.10:6588" "Legacy proxy URL alias must remain compatible."
    Assert-Equal (ConvertTo-RevitMcpWinHttpProxyServer -Value "http://192.168.90.10:6588") "192.168.90.10:6588" "Legacy WinHTTP proxy alias must remain compatible."
    $codexConfig = Join-Path $tempRoot "config.toml"
    Set-Content -LiteralPath $codexConfig -Value "model = `"gpt-5.5`"`r`nservice_tier = `"priority`"`r`n`r`n[mcp_servers.revit-mcp]`r`ncommand = `"old-node.exe`"`r`nargs = [`"old-runtime.js`"]`r`n`r`n[mcp_servers.revit-api-docs]`r`ncommand = `"old-node.exe`"`r`nargs = [`"old-docs.js`"]`r`n" -Encoding UTF8
    Register-RevAgentCodexMcpServersInConfig -ConfigPath $codexConfig -NodePath "node.exe" -RuntimeServerPath "runtime\build\index.js" -DocsServerPath "docs\build\index.js" | Out-Null
    $codexText = Get-Content -Raw -LiteralPath $codexConfig
    Assert-True ($codexText -match '(?m)^service_tier\s*=\s*"fast"\s*$') "Codex service_tier must be normalized to the current Codex CLI-supported fast tier."
    Assert-True ($codexText -notmatch '(?m)^service_tier\s*=\s*"priority"\s*$') "Codex service_tier must not keep the obsolete priority value."
    Assert-True ($codexText -match '\[mcp_servers\.revAgent\]') "Codex revAgent MCP section was not written."
    Assert-True ($codexText -match '\[mcp_servers\.revAgent-api-docs\]') "Codex revAgent API docs MCP section was not written."
    Assert-True ($codexText -notmatch '\[mcp_servers\.revit-mcp\]' -and $codexText -notmatch '\[mcp_servers\.revit-api-docs\]') "Legacy Codex MCP section names must be removed from user-facing config."
    Assert-True ($codexText -match '(?m)^\[features\]\s*$') "Codex features section was not written."
    Assert-True ($codexText -match '(?m)^memories\s*=\s*true\s*$') "Codex memories feature was not enabled."
    Assert-True ($codexText -match '(?m)^chronicle\s*=\s*false\s*$') "Codex chronicle feature was not disabled."
    Assert-True ($codexText -match '(?m)^\[memories\]\s*$') "Codex memories section was not written."
    Assert-True ($codexText -match '(?m)^disable_on_external_context\s*=\s*true\s*$') "Codex external-context memory guard was not enabled."
    Assert-True ($codexText -match '(?m)^generate_memories\s*=\s*true\s*$') "Codex memory generation was not enabled."
    Assert-True ($codexText -match '(?m)^use_memories\s*=\s*true\s*$') "Codex memory use was not enabled."
    Register-RevAgentCodexMcpServersInConfig -ConfigPath $codexConfig -NodePath "node.exe" -RuntimeServerPath "runtime\build\index.js" -DocsServerPath "docs\build\index.js" | Out-Null
    $codexTextAfterSecondWrite = Get-Content -Raw -LiteralPath $codexConfig
    Assert-Equal ([regex]::Matches($codexTextAfterSecondWrite, '(?m)^service_tier\s*=\s*"fast"\s*$').Count) 1 "Codex service_tier must not be duplicated."
    Assert-Equal ([regex]::Matches($codexTextAfterSecondWrite, '(?m)^\[features\]\s*$').Count) 1 "Codex features section must not be duplicated."
    Assert-Equal ([regex]::Matches($codexTextAfterSecondWrite, '(?m)^\[memories\]\s*$').Count) 1 "Codex memories section must not be duplicated."
    Assert-Equal ([regex]::Matches($codexTextAfterSecondWrite, '(?m)^memories\s*=\s*true\s*$').Count) 1 "Codex memories feature must not be duplicated."
    $codexProfileConfig = Join-Path $tempRoot "profile-config.toml"
    Set-Content -LiteralPath $codexProfileConfig -Value "[profiles.lite]`r`nservice_tier = `"flex`"`r`n" -Encoding UTF8
    Register-RevAgentCodexMcpServersInConfig -ConfigPath $codexProfileConfig -NodePath "node.exe" -RuntimeServerPath "runtime\build\index.js" -DocsServerPath "docs\build\index.js" | Out-Null
    $codexProfileText = Get-Content -Raw -LiteralPath $codexProfileConfig
    Assert-Equal ([regex]::Matches($codexProfileText, '(?m)^service_tier\s*=\s*"fast"\s*$').Count) 1 "Codex top-level service_tier must be added when only profile service_tier values exist."
    Assert-True ($codexProfileText -match '(?ms)^\[profiles\.lite\]\s*.*?^service_tier\s*=\s*"flex"\s*$') "Codex profile-specific service_tier override must be preserved."
    $codexStaleProfileConfig = Join-Path $tempRoot "stale-profile-config.toml"
    Set-Content -LiteralPath $codexStaleProfileConfig -Value "[profiles.legacy]`r`nservice_tier = `"priority`"`r`n" -Encoding UTF8
    Register-RevAgentCodexMcpServersInConfig -ConfigPath $codexStaleProfileConfig -NodePath "node.exe" -RuntimeServerPath "runtime\build\index.js" -DocsServerPath "docs\build\index.js" | Out-Null
    $codexStaleProfileText = Get-Content -Raw -LiteralPath $codexStaleProfileConfig
    Assert-True ($codexStaleProfileText -notmatch '(?m)^service_tier\s*=\s*"priority"\s*$') "Codex stale profile service_tier=priority must be normalized."
    Assert-True ($codexStaleProfileText -match '(?ms)^\[profiles\.legacy\]\s*.*?^service_tier\s*=\s*"fast"\s*$') "Codex stale profile service_tier must be normalized to fast."
    $profileUserRoot = Join-Path $tempRoot "profile-user"
    $windowsPowerShellProfile = Join-Path $profileUserRoot "Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1"
    New-Item -ItemType Directory -Path (Split-Path -Parent $windowsPowerShellProfile) -Force | Out-Null
    Set-Content -LiteralPath $windowsPowerShellProfile -Value "# existing operator profile`r`n`$x = 1`r`n" -Encoding UTF8
    $utf8Profiles = @(Set-RevAgentPowerShellUtf8ConsoleConfig -UserProfileRoot $profileUserRoot)
    Assert-Equal $utf8Profiles.Count 2 "UTF-8 console config must cover Windows PowerShell and PowerShell 7 profile paths."
    $windowsPowerShellProfileText = Get-Content -Raw -LiteralPath $windowsPowerShellProfile
    $powerShell7ProfileText = Get-Content -Raw -LiteralPath (Join-Path $profileUserRoot "Documents\PowerShell\Microsoft.PowerShell_profile.ps1")
    Assert-True ($windowsPowerShellProfileText -match '# existing operator profile') "UTF-8 console config must preserve existing profile content."
    Assert-True ($windowsPowerShellProfileText -match '\[Console\]::OutputEncoding = \$revAgentUtf8Encoding' -and $windowsPowerShellProfileText -match 'chcp\.com 65001') "Windows PowerShell profile must force UTF-8 console output."
    Assert-True ($powerShell7ProfileText -match '\[Console\]::OutputEncoding = \$revAgentUtf8Encoding' -and $powerShell7ProfileText -match 'PYTHONIOENCODING = "utf-8"') "PowerShell 7 profile must force UTF-8 console output."
    [void](Set-RevAgentPowerShellUtf8ConsoleConfig -UserProfileRoot $profileUserRoot)
    $windowsPowerShellProfileTextAfterSecondWrite = Get-Content -Raw -LiteralPath $windowsPowerShellProfile
    Assert-Equal ([regex]::Matches($windowsPowerShellProfileTextAfterSecondWrite, '# BEGIN revAgent UTF-8 console').Count) 1 "UTF-8 profile block must not be duplicated."
    $currentProcessUtf8 = Set-RevAgentCurrentProcessUtf8Console
    Assert-True ([bool]$currentProcessUtf8.success) "Current process UTF-8 setup should succeed."
    Assert-Equal ([Console]::InputEncoding.CodePage) 65001 "Current process input encoding must be UTF-8."
    Assert-Equal ([Console]::OutputEncoding.CodePage) 65001 "Current process output encoding must be UTF-8."
    Assert-Equal ($OutputEncoding.CodePage) 65001 "Current process PowerShell output encoding must be UTF-8."
    Assert-Equal $env:PYTHONUTF8 "1" "Current process must opt Python into UTF-8 mode."
    Assert-Equal $env:PYTHONIOENCODING "utf-8" "Current process must opt Python stdio into UTF-8."
    $codexRegistrationText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.CodexRegistration.psm1")
    Assert-True ($codexRegistrationText -match 'function Set-RevitMcpCurrentProcessUtf8Console' -and $codexRegistrationText -match '"Set-RevAgentCurrentProcessUtf8Console" = "Set-RevitMcpCurrentProcessUtf8Console"' -and $codexRegistrationText -match 'Export-ModuleMember -Alias @\(\$revAgentFunctionAliases\.Keys\)') "Codex registration module must keep the legacy UTF-8 helper and export the revAgent alias."
    $installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
    Assert-True ($installTaskText -match 'Set-RevAgentCurrentProcessUtf8Console') "Updater task installer entrypoint must force UTF-8 output even when launched with -NoProfile."
    Assert-True ($installTaskText -match 'function Copy-RevAgentManagedUpdaterToolFile' -and $installTaskText -match '\[bool\]\$Required = \$true' -and $installTaskText -match 'Remove-Item -LiteralPath \$Destination -Force' -and $installTaskText -match 'Copy-RevAgentManagedUpdaterToolFile -Source \(Join-Path \$PSScriptRoot "migrate-source-free-install\.ps1"\) -Destination \$localMigrationTool -Required:\(\[bool\]\$RunSourceFreeMigration\)') "Updater task installer must replace stale ACL-blocked updater files and require the migration tool only when source-free migration is requested."
    Assert-True ($installTaskText -match 'RevAgent\.DesktopLauncherCleanup\.psm1' -and $installTaskText -match 'Invoke-RevAgentLegacyDesktopLauncherCleanup' -and $installTaskText -match 'desktopLauncherCleanup') "Updater task installer must remove and report legacy revAgent desktop launchers."
    Assert-True ($updaterText -match 'Set-RevAgentCodexMemoryConfig') "Updater must enforce Codex memory config, including fast/no-op update paths."
    Assert-True ($updaterText -match 'Set-RevAgentCurrentProcessUtf8Console') "Updater entrypoint must force UTF-8 output even when launched with -NoProfile."
    Assert-True ($updaterText -match 'function Copy-RevAgentManagedUpdaterToolFile' -and $updaterText -match '\[bool\]\$Required = \$true' -and $updaterText -match 'Remove-Item -LiteralPath \$Destination -Force' -and $updaterText -match 'Copy-RevAgentManagedUpdaterToolFile -Source \$source -Destination \(Join-Path \$DestinationRoot \$toolName\) -Required:\(\$toolName -ne "migrate-source-free-install\.ps1"\)') "Updater fast-path tool refresh must replace stale ACL-blocked updater files and treat the migration tool as optional during normal updates."
    Assert-True ($updaterText -match 'RevAgent\.DesktopLauncherCleanup\.psm1' -and $updaterText -match 'Invoke-RevAgentLegacyDesktopLauncherCleanup' -and $updaterText -match 'desktopLauncherCleanup') "Updater must remove and report legacy revAgent desktop launchers."
    Assert-True ($updaterText -match 'Remove-CodexProfileBackupArtifacts') "Updater must clean old Codex profile backup artifacts."
    $installerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\install-self-contained.ps1")
    Assert-True ($installerText -match 'Set-RevAgentCodexMemoryConfig') "Installer must enforce Codex memory config."
    Assert-True ($installerText -match 'Set-RevAgentPowerShellUtf8ConsoleConfig .* -ConfigureConsoleRegistry' -and $installerText -match 'PowerShell UTF-8 console profiles') "Installer must enforce UTF-8 console defaults for Codex PowerShell sessions."
    Assert-True ($installerText -match 'Set-RevAgentCurrentProcessUtf8Console') "Self-contained installer entrypoint must force UTF-8 output even when launched with -NoProfile."
    Assert-True ($installerText -match 'function Copy-RevAgentManagedUpdaterToolFile' -and $installerText -match '\[bool\]\$Required = \$true' -and $installerText -match 'Remove-Item -LiteralPath \$Destination -Force' -and $installerText -match 'Copy-RevAgentManagedUpdaterToolFile -Source \$source -Destination \(Join-Path \$DestinationRoot \$toolName\) -Required:\(\$toolName -ne "migrate-source-free-install\.ps1"\)') "Self-contained installer updater tool refresh must replace stale ACL-blocked updater files and treat the migration tool as optional during normal updates."
    Assert-True ($installerText -match 'RevAgent\.DesktopLauncherCleanup\.psm1' -and $installerText -match 'Invoke-RevAgentLegacyDesktopLauncherCleanup') "Self-contained installer must remove legacy revAgent desktop launchers."
    Assert-True ($installTaskText -notmatch 'legacy Revit MCP launcher shortcut' -and $updaterText -notmatch 'legacy Revit MCP launcher shortcut' -and $installerText -notmatch 'legacy Revit MCP launcher shortcut') "Active installer/updater launcher cleanup messages must use revAgent wording."
    Assert-True ($installerText -match 'Remove-CodexProfileBackupArtifacts') "Installer must clean old Codex profile backup artifacts."
    Assert-True ($installerText -match 'RevAgent\.ConfigSync\.psm1' -and $installerText -match 'Sync-RevAgentUpdaterConfigDirectory -SourceRoot \$configSource -DestinationRoot \(Join-Path \$DestinationRoot "config"\)') "Self-contained installer must use the shared config sync helper."
    Assert-True ($installerText -notmatch 'Remove-Item -LiteralPath \$configDestination -Recurse -Force') "Self-contained installer must not delete local config because that removes pinned release keys."
    Assert-True ($installerText -match 'Copy-RevAgentRuntimeUserPayload') "Installer must copy only the runtime user payload."
    Assert-True ($installerText -match 'Copy-RevAgentDirectoryPayload -Source \(Join-Path \$SourceRoot "schemas"\) -Destination \(Join-Path \$DestinationRoot "schemas"\)') "Installer runtime payload must include the published Spatial Phase 0 schemas."
    Assert-True ($installerText -match 'revagent-runtime"\s*,\s*"revit-mcp"') "Installer runtime-directory validation must accept canonical and legacy runtime package identities during rolling updates."
    Assert-True ($installerText -match 'codexUserSourceRoot') "Installer must source Codex orchestration from the user pack."
    Assert-True ($installerText -match 'Resolve-CodexInstructionPolicy' -and $installerText -match 'Codex instructions: preserved local developer instruction surface by policy') "Installer must support preserve-local Codex instruction policy."
    Assert-True ($installerText -match 'Source cleanup\s+: Codex instruction roots skipped by preserve-local policy') "Installer source cleanup must skip Codex instruction roots under preserve-local policy."
    Assert-True ($installerText -match 'if \(-not \$SkipCodexUserIntegration\)' -and $installerText -match '\$managedRoots\.Add\(\$codexSkillTarget\)') "Installer source cleanup must not scan the user Codex skill root when user integration is skipped."
    Assert-True ($installerText -match 'Remove-RevAgentManagedSourceLeakArtifacts') "Installer must clean managed source/developer artifact leaks."
    Assert-True ($installerText -match '\^addons\$') "Installer source cleanup must treat admin add-on folders as non-workstation artifacts."
    Assert-True ($installerText -match 'if \(-not \$SkipRuntimePayloadInstall -and -not \[string\]::IsNullOrWhiteSpace\(\$ServerTarget\)\)' -and $installerText -match 'Test-RevAgentRuntimeDirectory -Path \$ServerTarget') "Installer source cleanup must honor runtime skip and validate ServerTarget before scanning it."
    Assert-True ($installerText -match 'Get-ChildItem -LiteralPath \$root -Recurse -Directory') "Installer source cleanup must recursively scan managed install roots."
    Assert-True ($installerText -match 'Sort-Object \{ \$_.FullName.Length \} -Descending') "Installer source cleanup must remove nested developer directories deepest-first."
    Assert-True ($installerText -match 'Test-RevAgentAllowedManagedDirectory' -and $installerText -match 'installer"\s+-and\s+\$parts\[1\] -ieq "revit-api-docs-mcp"') "Installer source cleanup must preserve allowed docs MCP runtime script directories."
    Assert-True ($installerText -match 'Test-RevAgentIgnoredManagedPath') "Installer source cleanup must use path-component dependency exclusions."
    Assert-True ($installerText -match 'Could not remove managed source/developer artifact directory' -and $installerText -match 'Could not remove managed source/developer artifact file') "Installer source cleanup must warn and continue when cleanup artifacts are locked."
    Assert-True ($installerText -notmatch 'Get-ChildItem -LiteralPath \$repoRoot -Force[\s\S]{0,160}Copy-Item -Destination \$codexMachineSkillTarget') "Installer must not copy the repo root into the Codex skill."
    Assert-True ($installerText -match '\$taskName = "revAgent Auto Update"') "Self-contained installer scheduled-task repair must use the revAgent task name."
    Assert-True ($installerText -match 'DPE\\revAgent' -and $installerText -match 'Remove-LegacyRevitMcpInstallRoot') "Self-contained installer must install under the revAgent root and clean the legacy RevitMCP root."
    Assert-True ($installerText -match 'AllowBroadTarget' -and $installerText -match 'legacy revAgent install root.*-AllowBroadTarget') "Legacy root cleanup must use an explicit broad-target override instead of weakening normal cleanup guards."
    Assert-True ($installerText -notmatch 'Legacy RevitMCP install root cleanup skipped' -and $installerText -notmatch 'legacy RevitMCP install root.*-AllowBroadTarget') "Active legacy-root cleanup logs must use revAgent wording while keeping the RevitMCP path guard."
    Assert-True ($installerText -match 'Update-revAgent-Now\.cmd' -and $installerText -match 'Show-revAgent-Version\.cmd') "Self-contained installer must create revAgent-named updater helper commands."
    Assert-True ($installerText -match 'LegacyNames @\("Revit MCP Auto Update"\)') "Self-contained installer must migrate the legacy Revit MCP task name."
    Assert-True ($installerText -notmatch 'Copy-Item[^\r\n]*AGENTS\.md\.backup-') "Installer must not create AGENTS.md backup files."
    Assert-True ($installerText -notmatch 'Move-Item[^\r\n]*revit-mcp\.backup|codexSkillBackupsRoot') "Installer must not create Codex skill backup directories."
    $dashboardAddonManifest = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\dashboard\addon.json") | ConvertFrom-Json
    $usageAddonManifest = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\usage-intelligence\addon.json") | ConvertFrom-Json
    Assert-Equal $dashboardAddonManifest.installRole "admin" "Dashboard add-on must be admin-scoped."
    Assert-Equal $usageAddonManifest.installRole "admin" "Usage-intelligence add-on must be admin-scoped."
    Assert-Equal ([bool]$dashboardAddonManifest.corePackage) $false "Dashboard add-on must not be part of the core standard user package."
    Assert-Equal ([bool]$usageAddonManifest.corePackage) $false "Usage-intelligence add-on must not be part of the core standard user package."
    $usageSummaryWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\summarize-usage-intelligence.ps1")
    $usagePublishWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\publish-usage-summary.ps1")
    $usageTaskWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-usage-summary-task.ps1")
    $usageLlmReviewPackWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\prepare-llm-review-pack.ps1")
    $usageExportWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\export-codex-session-context.ps1")
    $usageCodexPublishWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\publish-codex-session-context.ps1")
    $usageCodexTaskWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-codex-session-export-task.ps1")
    $usageCorrelationWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\correlate-usage-sessions.ps1")
    $usageAddonInstallerWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-usage-intelligence-addon.ps1")
    Assert-True ($usageSummaryWrapper -match 'addons\\usage-intelligence\\scripts\\summarize-usage-intelligence\.ps1') "Usage summary compatibility wrapper must delegate to the add-on script."
    Assert-True ($usagePublishWrapper -match 'addons\\usage-intelligence\\scripts\\publish-usage-summary\.ps1') "Usage publish compatibility wrapper must delegate to the add-on script."
    Assert-True ($usageTaskWrapper -match 'addons\\usage-intelligence\\scripts\\install-usage-summary-task\.ps1') "Usage task compatibility wrapper must delegate to the add-on script."
    Assert-True ($usageLlmReviewPackWrapper -match 'addons\\usage-intelligence\\scripts\\prepare-llm-review-pack\.ps1') "Usage LLM review pack wrapper must delegate to the add-on script."
    Assert-True ($usageExportWrapper -match 'addons\\usage-intelligence\\scripts\\export-codex-session-context\.ps1') "Usage Codex session export wrapper must delegate to the add-on script."
    Assert-True ($usageCodexPublishWrapper -match 'addons\\usage-intelligence\\scripts\\publish-codex-session-context\.ps1') "Usage Codex session publish wrapper must delegate to the add-on script."
    Assert-True ($usageCodexTaskWrapper -match 'addons\\usage-intelligence\\scripts\\install-codex-session-export-task\.ps1') "Usage Codex session export task wrapper must delegate to the add-on script."
    Assert-True ($usageCorrelationWrapper -match 'addons\\usage-intelligence\\scripts\\correlate-usage-sessions\.ps1') "Usage session correlation wrapper must delegate to the add-on script."
    Assert-Equal $usageAddonManifest.entrypoints.installScript "installer\install-usage-intelligence-addon.ps1" "Usage-intelligence add-on manifest must expose installer entrypoint."
    Assert-Equal $usageAddonManifest.entrypoints.prepareLlmReviewPack "scripts\prepare-llm-review-pack.ps1" "Usage-intelligence add-on manifest must expose LLM review pack preparer."
    Assert-Equal $usageAddonManifest.entrypoints.publishCodexSessionContext "scripts\publish-codex-session-context.ps1" "Usage-intelligence add-on manifest must expose Codex session publisher."
    Assert-Equal $usageAddonManifest.entrypoints.installCodexSessionExportTask "scripts\install-codex-session-export-task.ps1" "Usage-intelligence add-on manifest must expose Codex session export task installer."
    Assert-Equal $usageAddonManifest.entrypoints.exportCodexSessionContext "scripts\export-codex-session-context.ps1" "Usage-intelligence add-on manifest must expose Codex session exporter."
    Assert-Equal $usageAddonManifest.entrypoints.correlateSessions "scripts\correlate-usage-sessions.ps1" "Usage-intelligence add-on manifest must expose session correlator."
    $usageCodexSkills = @($usageAddonManifest.codexSkills)
    Assert-True (@($usageCodexSkills | Where-Object {
                $_.id -eq "revagent-usage-analyst" -and
                $_.source -eq "skills\revagent-usage-analyst" -and
                $_.target -eq "%USERPROFILE%\.codex\skills\revagent-usage-analyst" -and
                $_.installScope -eq "admin-user"
            }).Count -eq 1) "Usage-intelligence add-on manifest must declare the managed usage analyst Codex skill."
    Assert-True ($usageAddonInstallerWrapper -match 'addons\\usage-intelligence\\installer\\install-usage-intelligence-addon\.ps1') "Usage-intelligence add-on installer wrapper must delegate to the add-on installer."
    $report = New-RevAgentUpdateReport -Status "current" -Message "ok" -PreviousVersion "1" -InstalledVersion "1"
    $reportPath = Join-Path $tempRoot "report.json"
    Write-RevAgentJsonFile -Path $reportPath -Value $report
    $reportJson = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
    Assert-Equal $reportJson.app "revAgent" "Report JSON app identity must use revAgent."
    Assert-Equal $reportJson.status "current" "Report JSON status was not written."
    $reportingText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.Reporting.psm1")
    Assert-True ($reportingText -match 'app = "revAgent"' -and $reportingText -notmatch 'app = "revit-mcp-skill"') "Machine report helper must default to the revAgent app identity."
    Assert-True ($reportingText -match '\$operationLatestPath = Join-Path \$machineRoot \("\{0\}-latest\.json" -f \$safeOperation\)' -and $reportingText -match 'Write-RevitMcpJsonFile -Path \$operationLatestPath -Value \$published') "Machine report publishing must emit operation-specific latest files used by dashboard version fallback."
    $safePathCases = @(
        @{ input = "HAFIZE"; expected = "HAFIZE" },
        @{ input = "MARINA"; expected = "MARINA" },
        @{ input = "HAFİZE"; expected = "HAFİZE" },
        @{ input = "MARİNA"; expected = "MARİNA" },
        @{ input = "office machine/name"; expected = "office_machine_name" }
    )
    foreach ($case in $safePathCases) {
        Assert-Equal (ConvertTo-RevAgentSafePathSegment -Value $case.input -Fallback "fallback") $case.expected "Safe path segment conversion must preserve machine names across Turkish culture-sensitive letters."
    }
    $remoteReportsRoot = Join-Path $tempRoot "reports"
    $operationLog = Join-Path $tempRoot "install.log"
    Set-Content -LiteralPath $operationLog -Value "Operation method : gui-install" -Encoding ASCII
    Publish-RevAgentMachineRunReport -ReportsRoot $remoteReportsRoot -Report $report -Operation "install" -OperationMethod "gui-install" -LogPath $operationLog -KeepLastLogs 2 -WriteCompatibilityReport | Out-Null
    $safeComputer = ConvertTo-RevAgentSafePathSegment -Value $env:COMPUTERNAME -Fallback "unknown-computer"
    $machineLatest = Join-Path $remoteReportsRoot ("machines\{0}\latest.json" -f $safeComputer)
    Assert-True (Test-Path -LiteralPath $machineLatest -PathType Leaf) "Machine latest report must be written under reports\\machines\\<computer>."
    $machineReport = Get-Content -Raw -LiteralPath $machineLatest | ConvertFrom-Json
    Assert-Equal $machineReport.operationMethod "gui-install" "Machine report must record operationMethod."
    $machineLogsRoot = Join-Path $remoteReportsRoot ("machines\{0}\logs" -f $safeComputer)
    Assert-Equal (@(Get-ChildItem -LiteralPath $machineLogsRoot -File -Filter "*.log").Count) 1 "Machine report log must be copied to NAS report storage."

    Write-Host "Test updater log retention"
    $logsRoot = Join-Path $tempRoot "logs-retention"
    New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null
    for ($i = 1; $i -le 15; $i++) {
        $path = Join-Path $logsRoot ("update-{0:00}.log" -f $i)
        Set-Content -LiteralPath $path -Value ("log {0}" -f $i) -Encoding ASCII
        (Get-Item -LiteralPath $path).LastWriteTimeUtc = [datetime]::UtcNow.AddMinutes(-1 * (15 - $i))
    }
    Invoke-RevAgentLogRetention -LogsRoot $logsRoot -KeepLast 10 -ActiveLogPath (Join-Path $logsRoot "update-15.log")
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
    Invoke-RevAgentDirectoryRetention -Root $backupRoot -Filter "revit-mcp-skill.backup-*" -KeepLast 3
    $remainingBackups = @(Get-ChildItem -LiteralPath $backupRoot -Directory -Filter "revit-mcp-skill.backup-*" | Sort-Object Name | Select-Object -ExpandProperty Name)
    Assert-Equal $remainingBackups.Count 3 "Backup retention must keep exactly the latest 3 package backup folders."
    Assert-True ($remainingBackups -contains "revit-mcp-skill.backup-06") "Backup retention must keep the latest package backup folder."
    Assert-True (-not ($remainingBackups -contains "revit-mcp-skill.backup-01")) "Backup retention must remove old package backup folders."

    Write-Host "Test revAgent clean-install transition backup reset"
    $transitionBackupRoot = Join-Path $tempRoot "transition-backups"
    $transitionCacheRoot = Join-Path $tempRoot "transition-cache"
    New-Item -ItemType Directory -Path (Join-Path $transitionBackupRoot "revit-mcp-skill.backup-old\package") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $transitionBackupRoot "manual-backup") -Force | Out-Null
    New-Item -ItemType Directory -Path $transitionCacheRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $transitionBackupRoot "leftover.txt") -Value "old" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $transitionCacheRoot "revit-mcp-skill-old.zip") -Value "zip" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $transitionCacheRoot "keep.txt") -Value "keep" -Encoding ASCII
    $transitionReset = Invoke-RevAgentBackupRootReset -BackupRoot $transitionBackupRoot -CacheRoot $transitionCacheRoot
    Assert-Equal $transitionReset.failedBackupItemCount 0 "Transition backup reset must not fail on temp backup content."
    Assert-Equal $transitionReset.removedBackupItemCount 3 "Transition backup reset must remove all backup root children."
    Assert-Equal @(Get-ChildItem -LiteralPath $transitionBackupRoot -Force).Count 0 "Transition backup root must be empty after reset."
    Assert-Equal @(Get-ChildItem -LiteralPath $transitionCacheRoot -File -Filter "revit-mcp-skill-*.zip").Count 0 "Transition reset must clear stale release cache zips."
    Assert-True (Test-Path -LiteralPath (Join-Path $transitionCacheRoot "keep.txt") -PathType Leaf) "Transition reset must leave unrelated cache files alone."

    $updaterTextForCleanInstall = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
    Assert-True ($updaterTextForCleanInstall -match 'revagent-clean-install-transition\.json') "Updater must persist a one-time revAgent clean-install transition marker."
    Assert-True ($updaterTextForCleanInstall -match 'Test-RevAgentCleanInstallTransitionRequired') "Updater must decide when the revAgent clean-install transition is required."
    Assert-True ($updaterTextForCleanInstall -match 'Invoke-RevAgentBackupRootReset') "Updater must clear package backups through the workstation local-backup policy."
    Assert-True ($updaterTextForCleanInstall -match 'packageBackupSkipped') "Updater state/report diagnostics must expose skipped local package backup behavior."
    Assert-True ($updaterTextForCleanInstall -match 'Remove-Item -LiteralPath \$PackageTarget -Recurse -Force') "Updater must remove the previous managed package directly without retaining a local package backup."

    Write-Host "Installer/updater smoke tests passed." -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
