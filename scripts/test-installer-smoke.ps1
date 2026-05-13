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
            "src\revit-plugin\SampleCommandSet\SampleCommandSet.csproj"
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

    Write-Host "Installer/updater smoke tests passed." -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
