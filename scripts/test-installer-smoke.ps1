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

    Write-Host "Test dynamic commandset transaction and reference guards"
    $executeCodeHandler = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\Commands\ExecuteDynamicCode\ExecuteCodeEventHandler.cs")
    Assert-True ($executeCodeHandler -match 'ContainsManualTransaction') "Dynamic commandset must detect manual transaction snippets."
    Assert-True ($executeCodeHandler -match 'manual_transaction_requires_transactionMode_none') "Manual transaction snippets in auto mode must be classified as guarded safety blocks."
    Assert-True ($executeCodeHandler -match 'JsonProperty\("guarded"\)') "Dynamic execution results must expose guarded for the status UI."
    Assert-True ($executeCodeHandler -match 'GetMetadataReferences') "Dynamic commandset must centralize metadata reference collection."
    Assert-True ($executeCodeHandler -match 'Dictionary<string, Assembly> chosen') "Dynamic commandset must de-duplicate loaded assemblies by simple name."
    $liveCommandsetTest = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\test-commandset-live.ps1")
    Assert-True ($liveCommandsetTest -match 'Assert-RevitMcpReady') "Live commandset integration gate must status-check before non-status commands."
    Assert-True ($liveCommandsetTest -match 'transactionMode auto') "Live commandset integration gate must cover transactionMode auto."
    Assert-True ($liveCommandsetTest -match 'transactionMode none') "Live commandset integration gate must cover transactionMode none."
    Assert-True ($liveCommandsetTest -match 'manual_transaction_requires_transactionMode_none') "Live commandset integration gate must assert the manual transaction guard reason."
    Assert-True ($liveCommandsetTest -match 'Newtonsoft\.Json\.JsonConvert') "Live commandset integration gate must cover Newtonsoft dynamic compilation."
    Assert-NoLocalizedRevitPluginSourceText -Root $RepoRoot
    $commandSetSourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet") -Recurse -File -Filter *.cs |
        Where-Object { $_.FullName -notmatch '\\(bin|obj)\\' } |
        ForEach-Object { $_.FullName.Substring($RepoRoot.Length + 1).Replace('/', '\') } |
        Sort-Object)
    $expectedCommandSetSourceFiles = @(
        "src\revit-plugin\RevitMCPCommandSet\Commands\Access\GetCurrentViewElementsCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\Access\GetCurrentViewInfoCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\Access\GetSelectedElementsCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\ExecuteDynamicCode\ExecuteCodeCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\ExecuteDynamicCode\ExecuteCodeEventHandler.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\ActivateViewCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\ActivateViewEventHandler.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\CloseViewCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\CloseViewEventHandler.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\Create3DViewForElementsCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\Create3DViewForElementsEventHandler.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\ElementDiscoveryHelpers.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\ElementFocusHelpers.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\FindElementsCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\FindElementsEventHandler.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\FocusElementsCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\FocusElementsEventHandler.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\GetUiStateCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\GetUiStateEventHandler.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\ListOpenViewsCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\ListOpenViewsEventHandler.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\OpenExistingPlanForElementLevelCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\OpenExistingPlanForElementLevelEventHandler.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\SectionBoxElementsCommand.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\SectionBoxElementsEventHandler.cs",
        "src\revit-plugin\RevitMCPCommandSet\Commands\View\ViewCommandHelpers.cs",
        "src\revit-plugin\RevitMCPCommandSet\Extensions\RevitApiCompatibilityExtensions.cs",
        "src\revit-plugin\RevitMCPCommandSet\Models\Common\ElementInfo.cs",
        "src\revit-plugin\RevitMCPCommandSet\Models\Common\ViewElementsResult.cs",
        "src\revit-plugin\RevitMCPCommandSet\Models\Common\ViewInfo.cs",
        "src\revit-plugin\RevitMCPCommandSet\Services\GetCurrentViewElementsEventHandler.cs",
        "src\revit-plugin\RevitMCPCommandSet\Services\GetCurrentViewInfoEventHandler.cs",
        "src\revit-plugin\RevitMCPCommandSet\Services\GetSelectedElementsEventHandler.cs"
    )
    Assert-Equal ($commandSetSourceFiles -join "|") ($expectedCommandSetSourceFiles -join "|") "RevitMCPCommandSet must contain the complete production bridge command source surface."

    Write-Host "Test Revit command registry includes the unified bridge command tools"
    $bridgeCommandJson = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revit_mcp_plugin\Commands\RevitMCPCommandSet\command.json") | ConvertFrom-Json
    $commandRegistry = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revit_mcp_plugin\Commands\commandRegistry.json") | ConvertFrom-Json
    $registeredCommandNames = @($commandRegistry.Commands | ForEach-Object { [string]$_.commandName })
    foreach ($name in @($bridgeCommandJson.commands | ForEach-Object { [string]$_.commandName })) {
        Assert-True ($registeredCommandNames -contains $name) "commandRegistry.json is missing Revit bridge command '$name'."
    }
    foreach ($path in @($commandRegistry.Commands | ForEach-Object { [string]$_.assemblyPath })) {
        Assert-Equal $path "RevitMCPCommandSet\\2022\\RevitMCPCommandSet.dll" "Bridge command registry must load every command from the unified bridge DLL."
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "installer\revit-plugin\revit_mcp_plugin\Commands\RevitMCPViewCommandSet"))) "Legacy RevitMCPViewCommandSet payload folder must not be packaged."

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
    Assert-True ($guiText -match 'Install/Repair') "GUI must expose a separate install/repair button."
    Assert-True ($guiText -match '-ForceUpdate') "GUI restore action must force the channel package install."
    Assert-True ($guiText -match '-OperationMethod", \$operationMethod') "GUI operations must pass the visible install/update method to child logs."
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
    Assert-True ($updateText -match 'operationMethod = \$script:RevitMcpOperationMethod') "Updater reports must record the install/update method used."
    Assert-True ($updateText -match 'release = \[ordered\]@') "Updater reports must include release version, commit, and package SHA metadata."
    Assert-True ($updateText -match 'localInstall = if \(\$InstalledState\)') "Updater reports must include a local install state summary."
    Assert-True ($updateText -match 'diagnostics = \$Diagnostics') "Updater reports must include dashboard-ready update diagnostics."
    Assert-True ($updateText -match 'elseif \(\$Force\) \{ "reinstall" \}') "Forced updater runs must be reported as reinstall operations."
    Assert-True ($updateText -match 'Publish-RevitMcpMachineRunReport') "Updater must publish per-machine NAS reports and logs."
    Assert-True ($updateText -match '\.revagent-npm-dependencies\.json') "Updater payload fingerprints must ignore npm dependency marker files."
    Assert-True ($updateText -notmatch 'Repair-RevitMcpScheduledTaskAction -Name \$TaskName') "Normal updates must not run an extra scheduled-task repair before the package installer."
    $installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
    Assert-True ($installTaskText -match 'installOperationMethod = \$script:RevitMcpOperationMethod') "Updater installer config must record the install/repair method."
    Assert-True ($installTaskText -match 'function Get-EffectiveInstallOperation') "Updater installer must classify install versus reinstall operation type."
    Assert-True ($installTaskText -match 'diagnostics = \[ordered\]@') "Updater installer reports must include dashboard-ready diagnostics."
    Assert-True ($installTaskText -match 'Publish-RevitMcpMachineRunReport') "Updater installer must publish per-machine NAS reports and logs."
    Assert-True ($installTaskText -match '-OperationMethod", "scheduled-update"') "Scheduled updater launcher must tag background runs in logs."
    $publishText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1")
    Assert-True ($publishText -match '\$components\["runtimePayload"\] = Get-DirectoryTreeHash') "Release manifest must include a runtime payload fingerprint."
    Assert-True ($publishText -match '\$components\["docsServerPayload"\] = Get-DirectoryTreeHash') "Release manifest must include a docs payload fingerprint."
    Assert-True ($publishText -match 'foreach \(\$payloadRoot in @\("installer\\revit-plugin", "installer\\command-payload"\)\)') "Release manifest must classify Revit add-in and command payload trees as Revit-close-required."
    Assert-True ($publishText -match 'revitClosedRequiredPaths = @\(\s+"installer\\revit-plugin"\s+"installer\\command-payload"\s+\)') "Release manifest must advertise Revit-close-required payload paths."
    Assert-True ($publishText -match '\.revagent-npm-dependencies\.json') "Release payload fingerprints must ignore npm dependency marker files."
    Assert-True ($publishText -notmatch 'kurulum|legacyEntryPoint|legacyInstaller') "Release publishing must not create the removed legacy kurulum package alias."
    $packageLibText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevitMcp.Package.psm1")
    Assert-True ($packageLibText -notmatch 'kurulum') "Package layout resolution must not keep the removed legacy kurulum path."
    Assert-True ($guiText -notmatch 'Guncelle|Surum|Kapat|Kurulum|Kanal|Hazir|Islem|Calisiyor|Baslatilamadi|bulunamadi|hata') "GUI product strings must remain English."
    Assert-True ($guiText -notmatch 'Revit MCP Installer|Revit MCP install and update|Stable Restore|Stable channel|Stable version') "GUI product labels must not expose internal MCP wording or legacy channel wording."

    Write-Host "Test Revit task status window product surface"
    $taskStatusXaml = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\UI\McpTaskStatusWindow.xaml")
    $taskStatusCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\UI\McpTaskStatusWindow.xaml.cs")
    $taskStatusController = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\Core\McpTaskStatusWindowController.cs")
    $taskStatusService = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\Core\McpTaskStatusService.cs")
    $socketServiceCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\revit-mcp-plugin\Core\SocketService.cs")
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
    Assert-True ($taskStatusCode -match 'ShowGuarded') "Task status window must display safety-guarded tasks separately from failures."
    Assert-True ($taskStatusController -match 'ShowGuarded') "Task status controller must route guarded task state to the UI."
    Assert-True ($taskStatusService -match 'GuardTask') "Task status service must support a guarded task state."
    Assert-True ($taskStatusService -match 'MaxRecentTasks = 100') "Task status service must retain enough recent tasks for full-test/debug runs."
    Assert-True ($taskStatusCode -match 'MaxHistoryItems = 100') "Task status window must keep enough visible history for full-test/debug runs."
    Assert-True ($taskStatusService -notmatch 'NormalizeErrorMessage|ContainsCjk') "Task status service must not hide localized source text with a sanitizer."
    Assert-True ($socketServiceCode -match 'IsCommandResultGuarded') "Socket service must classify expected safety blocks as guarded tasks."
    Assert-True ($taskStatusCode -match 'Guarded / blocked by safety') "Task status window must describe guarded tasks as a safety block, not a failure."
    Assert-True ($taskStatusCode -match 'return "!"') "Task status history must render guarded tasks with the warning-style exclamation symbol."
    Assert-True ($taskStatusCode -match 'return "\\u2715"') "Failed task history must keep a distinct failure symbol."

    Write-Host "Test Revit view focus visibility guard"
    $focusHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\Commands\View\ElementFocusHelpers.cs")
    $focusHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\Commands\View\FocusElementsEventHandler.cs")
    $openPlanCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\Commands\View\OpenExistingPlanForElementLevelEventHandler.cs")
    $openPlanCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\Commands\View\OpenExistingPlanForElementLevelCommand.cs")
    $openPlanToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\open_existing_plan_for_element_level.ts")
    $smartFocusToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\smart_focus_elements.ts")
    $sendCodeToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\send_code_to_revit.ts")
    $closeViewCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\Commands\View\CloseViewEventHandler.cs")
    $create3dHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\Commands\View\Create3DViewForElementsEventHandler.cs")
    $sectionBoxHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\Commands\View\SectionBoxElementsEventHandler.cs")
    $viewHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\Commands\View\ViewCommandHelpers.cs")
    $discoveryCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\Commands\View\ElementDiscoveryHelpers.cs")
    $findCommandCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\Commands\View\FindElementsCommand.cs")
    $findToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\find_elements.ts")
    $inspectElementsToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\inspect_elements.ts")
    $showPlan3dToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\show_element_in_plan_and_3d.ts")
    $sessionContextToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\get_revit_session_context.ts")
    $instanceListToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\list_revit_instances.ts")
    $viewImageToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\export_revit_view_image.ts")
    $coordinationImageToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\export_revit_coordination_image.ts")
    $create3dToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\create_3d_view_for_elements.ts")
    $statusToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\get_revit_mcp_status.ts")
    $toolHelpersCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\revitToolHelpers.ts")
    $parameterSchemaToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\inspect_parameter_schema.ts")
    $telemetryCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\utils\telemetry.ts")
    $safeCodeToolCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\runtime-mcp-server\src\tools\send_code_to_revit_safe.ts")
    $apiDocsIndexCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\revit-api-docs-mcp\src\utils\docIndex.ts")
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
    Assert-True ($findCommandCode -match 'planCandidateMode != "none"') "find_elements command must keep plan candidate scans opt-in."
    Assert-True ($discoveryCode -match 'verifyVisibility \? element : null') "metadata plan candidates must avoid expensive per-view element visibility checks."
    Assert-True ($showPlan3dToolCode -match 'responseMode: z\.enum\(\["compact", "full"\]\)') "show_element_in_plan_and_3d must expose compact/full response modes."
    Assert-True ($showPlan3dToolCode -match 'ResponseMode: "compact"') "show_element_in_plan_and_3d must default successful responses to compact summaries."
    Assert-True ($openPlanToolCode -match 'responseMode: z\.enum\(\["compact", "full"\]\)') "open_existing_plan_for_element_level must expose compact/full response modes."
    Assert-True ($openPlanToolCode -match 'function compactPlanResult') "open_existing_plan_for_element_level must compact successful routine responses."
    Assert-True ($openPlanToolCode -match 'ResponseMode: "compact"') "open_existing_plan_for_element_level compact response must identify its response mode."
    Assert-True ($openPlanToolCode -notmatch 'trimmedPayload && trimmedPayload\.Success === false') "open_existing_plan_for_element_level compact mode must stay compact for failure responses."
    Assert-True ($showPlan3dToolCode -match 'responseMode: "full"') "show_element_in_plan_and_3d must request the full nested plan result before building its own compact summary."
    Assert-True ($smartFocusToolCode -match 'responseMode: z\.enum\(\["compact", "full"\]\)') "smart_focus_elements must expose compact/full response modes."
    Assert-True ($smartFocusToolCode -match 'ResponseMode: "compact"') "smart_focus_elements must default successful responses to compact summaries."
    Assert-True ($smartFocusToolCode -match 'function compactSmartFocusPayload') "smart_focus_elements must build a compact successful payload."
    Assert-True ($sessionContextToolCode -match 'apiProbeState') "Session context must move tool-probe modifiable state out of the document summary."
    Assert-True ($sessionContextToolCode -match 'documentIsModifiableDuringProbe') "Session context must label probe-time modifiable state clearly."
    Assert-True ($sessionContextToolCode -notmatch 'apiProbeState\s*=\s*new\s*\{\s*isModifiable\s*=') "Session context must not expose apiProbeState.isModifiable."
    Assert-True ($instanceListToolCode -match 'documentIsModifiableDuringProbe') "Instance list must label probe-time modifiable state clearly."
    Assert-True ($instanceListToolCode -notmatch 'apiProbeState\s*=\s*new\s*\{\s*isModifiable\s*=') "Instance list must not expose apiProbeState.isModifiable."
    Assert-True ($statusToolCode -match 'runtimeIdentity') "Status output must include runtime identity metadata."
    Assert-True ($statusToolCode -match 'runtimeVersion') "Status output must include the active runtime version."
    Assert-True ($statusToolCode -match 'schemaVersion') "Status output must include the status/schema version."
    Assert-True ($statusToolCode -match 'toolSurfaceVersion') "Status output must include the registered tool surface version."
    Assert-True ($statusToolCode -match 'processStartedAtUtc') "Status output must include the runtime process start time."
    Assert-True ($statusToolCode -match 'buildTimestampUtc') "Status output must include build/install timestamp metadata when available."
    Assert-True ($statusToolCode -match 'buildHash') "Status output must include the git build hash when encoded in the installed version."
    Assert-True ($statusToolCode -match 'replace\(/\^\\uFEFF/') "Status identity must tolerate PowerShell-written UTF-8 BOM JSON files."
    Assert-True ($statusToolCode -match 'revit-mcp-status\.v3') "Status schema must be bumped when status field names change."
    Assert-True ($statusToolCode -match '\.max\(100\)') "Status tool must allow a longer recent history limit for full-test/debug runs."
    Assert-True ($toolHelpersCode -match 'recentHistoryCount') "Status compact payload must report recent history count instead of a misleading total."
    Assert-True ($toolHelpersCode -match 'recentLimit, 3, 0, 100') "Status compact payload must preserve up to 100 recent tasks when requested."
    Assert-True ($toolHelpersCode -notmatch 'clone\.recentTasksTotal =') "Status compact payload must not emit the legacy recentTasksTotal name."
    Assert-True ($toolHelpersCode -match 'normalizeSuccessCasing') "Runtime formatter must normalize response success casing."
    Assert-True ($toolHelpersCode -match 'delete clone\.Success') "Runtime formatter must emit canonical lowercase success instead of success/Success duplicates."
    Assert-True ($sendCodeToolCode -match 'parseJsonResult') "Raw send_code_to_revit must expose JSON-looking result parsing."
    Assert-True ($sendCodeToolCode -match 'normalizeRevitExecutionResponse\(response\)') "Raw send_code_to_revit must parse double-encoded JSON-looking results by default."
    Assert-True ($parameterSchemaToolCode -match 'duplicateDisplayNameWarnings') "Parameter schema inspection must report duplicate display-name warnings for write preflight."
    Assert-True ($parameterSchemaToolCode -match 'write_preflight_warning') "Duplicate parameter display names must be labeled as write-preflight risk."
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
    $activateViewHandlerCode = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "src\revit-plugin\RevitMCPCommandSet\Commands\View\ActivateViewEventHandler.cs")
    Assert-True ($activateViewHandlerCode -match 'Changed = true,\s+ActiveViewChanged = true') "activate_view must mark ActiveViewChanged when it successfully changes the active view."
    Assert-True ($closeViewCode -match 'Changed = closed \|\| activeViewChanged') "close_view must mark Changed when a view is closed or active view changes."
    Assert-True ($viewImageToolCode -match 'enforcePixelSize') "View image export must expose enforcePixelSize."
    Assert-True ($viewImageToolCode -match 'resizeImageToRequestedPixelSize') "View image export must normalize exported image dimensions after Revit export."
    Assert-True ($viewImageToolCode -match 'finalPixelSizeMatchesRequest') "View image export must explicitly report whether the final image dimension matches the request."
    Assert-True ($safeCodeToolCode -match 'formatSafetyBlock') "Safe dynamic execution wrapper must classify expected write rejections as guarded safety blocks."
    Assert-True ($safeCodeToolCode -match 'safe_wrapper_rejected_write_looking_code') "Safe dynamic execution wrapper must expose a stable safety reason for write-looking snippets."
    Assert-True ($telemetryCode -match 'normalizeMachineName') "Telemetry must normalize machine names before building NAS event paths."
    Assert-True ($telemetryCode -match 'REVAGENT_TELEMETRY_CODE_CHARS') "Telemetry must capture bounded code previews for semantic usage analysis."
    Assert-True ($telemetryCode -match 'production\.context') "Telemetry must emit production-context events for dashboard/master-LLM analysis."
    Assert-True ($telemetryCode -match 'REVAGENT_TELEMETRY_CONTEXT_ELEMENTS') "Telemetry must bound production-context element samples."
    Assert-True ($telemetryCode -match 'disciplineHint') "Production context must include a discipline hint for office workload analysis."
    Assert-True ($telemetryCode -match 'rejected write-looking code') "Telemetry must classify safe-wrapper write rejections as guarded outcomes."
    Assert-True ($apiDocsIndexCode -match 'getMemberNameAliases') "API docs resolver must support common Revit member aliases."
    Assert-True ($apiDocsIndexCode -match 'revit_xml_docs_parameter_indexer_property') "API docs resolver must alias get_Parameter(...) to the Element.Parameter XML docs property."
    Assert-True ($create3dToolCode -match 'LIVE_VIEW_NAVIGATION_PRIMITIVE') "create_3d_view_for_elements must identify itself as the live 3D navigation primitive."
    Assert-True ($showPlan3dToolCode -match 'LIVE_VIEW_WORKFLOW_WRAPPER') "show_element_in_plan_and_3d must identify itself as the live plan+3D workflow wrapper."
    Assert-True ($coordinationImageToolCode -match 'VISUAL_ARTIFACT_EXPORT_ONLY') "Coordination image export must identify itself as an image artifact export tool."
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
    Assert-True ($versionOutput -match 'install/repair available') "Newer local/dev install should be reported as install/repair available against an older release target."
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
    Assert-True ($installTaskText -match '\[string\]\$TaskName = "revAgent Auto Update"') "Updater scheduled task must use the revAgent product name by default."
    Assert-True ($installTaskText -match 'New-RevitMcpDailyUpdateTrigger -DailyAt \$DailyAt') "Updater scheduled-task installer must use the shared daily trigger helper."
    Assert-True ($installTaskText -notmatch 'New-ScheduledTaskTrigger -AtLogOn') "Updater scheduled task must not run at logon."
    Assert-True ($installTaskText -notmatch 'RepetitionInterval') "Updater scheduled task must not repeat through the day."
    Assert-True ($installTaskText -notmatch 'StartWhenAvailable') "Updater scheduled task must not start immediately for a missed noon trigger during GUI RunNow installs."
    Assert-True ($installTaskText -match 'dailyAt = \$DailyAt') "Updater config must persist the daily check time for future repairs."
    Assert-True ($installTaskText -match 'Task schedule\s+: daily at \$DailyAt') "Updater install output must report the daily schedule."
    Assert-True ($installTaskText -match '"revAgent Auto Update\.vbs"') "Startup fallback reminder must use the revAgent product name."
    Assert-True ($installTaskText -match 'Revit MCP Auto Update\.cmd", "Revit MCP Auto Update\.vbs"') "Startup fallback must remove legacy Revit MCP reminder launchers."
    Assert-True ($installTaskText -match 'Removed legacy task: \$legacyTaskName') "Updater install must remove the legacy Revit MCP scheduled task after registering the revAgent task."
    $scheduledTaskModuleText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\lib\RevitMcp.ScheduledTask.psm1")
    Assert-True ($scheduledTaskModuleText -match '\[string\]\$Name = "revAgent Auto Update"') "Scheduled-task repair must default to the revAgent task name."
    Assert-True ($scheduledTaskModuleText -match '\[string\[\]\]\$LegacyNames = @\("Revit MCP Auto Update"\)') "Scheduled-task repair must know the legacy Revit MCP task name."
    Assert-True ($scheduledTaskModuleText -match 'Scheduled task migrated to revAgent product name') "Scheduled-task repair must migrate existing installed reminders to the revAgent task name."
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
    Assert-True ($updaterText -match 'Then run the revAgent updater again') "Updater missing-dependency guidance must use the revAgent product name."
    Assert-True ($updaterText -notmatch 'Then run the Revit MCP updater again') "Updater reminder/error windows must not ask users to run the Revit MCP updater."
    Assert-True ($updaterText -match 'app = "revAgent"') "Notification throttle state must use the revAgent product name."
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
    Assert-True ($installerText -match '\$taskName = "revAgent Auto Update"') "Self-contained installer scheduled-task repair must use the revAgent task name."
    Assert-True ($installerText -match 'LegacyNames @\("Revit MCP Auto Update"\)') "Self-contained installer must migrate the legacy Revit MCP task name."
    Assert-True ($installerText -notmatch 'Copy-Item[^\r\n]*AGENTS\.md\.backup-') "Installer must not create AGENTS.md backup files."
    Assert-True ($installerText -notmatch 'Move-Item[^\r\n]*revit-mcp\.backup|codexSkillBackupsRoot') "Installer must not create Codex skill backup directories."
    $report = New-RevitMcpUpdateReport -Status "current" -Message "ok" -PreviousVersion "1" -InstalledVersion "1"
    $reportPath = Join-Path $tempRoot "report.json"
    Write-RevitMcpJsonFile -Path $reportPath -Value $report
    $reportJson = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
    Assert-Equal $reportJson.status "current" "Report JSON status was not written."
    $safePathCases = @(
        @{ input = "HAFIZE"; expected = "HAFIZE" },
        @{ input = "MARINA"; expected = "MARINA" },
        @{ input = "HAFİZE"; expected = "HAFİZE" },
        @{ input = "MARİNA"; expected = "MARİNA" },
        @{ input = "office machine/name"; expected = "office_machine_name" }
    )
    foreach ($case in $safePathCases) {
        Assert-Equal (ConvertTo-RevitMcpSafePathSegment -Value $case.input -Fallback "fallback") $case.expected "Safe path segment conversion must preserve machine names across Turkish culture-sensitive letters."
    }
    $remoteReportsRoot = Join-Path $tempRoot "reports"
    $operationLog = Join-Path $tempRoot "install.log"
    Set-Content -LiteralPath $operationLog -Value "Operation method : gui-install" -Encoding ASCII
    Publish-RevitMcpMachineRunReport -ReportsRoot $remoteReportsRoot -Report $report -Operation "install" -OperationMethod "gui-install" -LogPath $operationLog -KeepLastLogs 2 -WriteCompatibilityReport | Out-Null
    $safeComputer = ConvertTo-RevitMcpSafePathSegment -Value $env:COMPUTERNAME -Fallback "unknown-computer"
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
