<#
.SYNOPSIS
    CI-safe tests for legacy desktop launcher cleanup.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

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

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$modulePath = Join-Path $RepoRoot "installer\lib\RevAgent.DesktopLauncherCleanup.psm1"
Import-Module $modulePath -Force

$updaterText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1") -Encoding UTF8
$installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1") -Encoding UTF8
$installerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\install-self-contained.ps1") -Encoding UTF8
Assert-True ($updaterText -match 'RevAgent\.DesktopLauncherCleanup\.psm1' -and $updaterText -match 'Invoke-RevAgentLegacyDesktopLauncherCleanup' -and $updaterText -match 'desktopLauncherCleanup') "Updater must remove and report legacy desktop launchers."
Assert-True ($installTaskText -match 'RevAgent\.DesktopLauncherCleanup\.psm1' -and $installTaskText -match 'Invoke-RevAgentLegacyDesktopLauncherCleanup' -and $installTaskText -match 'desktopLauncherCleanup') "Updater task installer must remove and report legacy desktop launchers."
Assert-True ($installerText -match 'RevAgent\.DesktopLauncherCleanup\.psm1' -and $installerText -match 'Invoke-RevAgentLegacyDesktopLauncherCleanup') "Self-contained installer must remove legacy desktop launchers."

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-desktop-launcher-cleanup-test-" + [Guid]::NewGuid().ToString("N"))
try {
    $desktopRoot = Join-Path $tempRoot "Desktop"
    New-Item -ItemType Directory -Path $desktopRoot -Force | Out-Null

    $legacyCmd = Join-Path $desktopRoot "Revit MCP Updater STABLE.cmd"
    Set-Content -LiteralPath $legacyCmd -Value "@echo off`r`ncall `"\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Revit MCP Updater STABLE.cmd`"" -Encoding ASCII

    $productCmd = Join-Path $desktopRoot "revAgent Updater STABLE.cmd"
    Set-Content -LiteralPath $productCmd -Value @"
@echo off
set "PRIMARY_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
set "LEGACY_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"
set "RELEASE_ROOT=%PRIMARY_ROOT%"
if not exist "%RELEASE_ROOT%\tools\Install-revAgent-Updater-GUI.ps1" set "RELEASE_ROOT=%LEGACY_ROOT%"
call "%RELEASE_ROOT%\tools\revAgent Updater STABLE.cmd"
"@ -Encoding ASCII

    $unrelatedScript = Join-Path $desktopRoot "project-helper.ps1"
    Set-Content -LiteralPath $unrelatedScript -Value "Write-Host 'not a revAgent launcher'" -Encoding ASCII

    $legacyLink = Join-Path $desktopRoot "Revit MCP Updater STABLE.cmd - Kısayol.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($legacyLink)
    $shortcut.TargetPath = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Revit MCP Updater STABLE.cmd"
    $shortcut.WorkingDirectory = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools"
    $shortcut.Description = "Legacy Revit MCP updater"
    $shortcut.Save()

    $preview = Invoke-RevAgentLegacyDesktopLauncherCleanup -LauncherRoots @($desktopRoot) -WhatIfOnly
    Assert-Equal ([int]$preview.matchedCount) 2 "WhatIf cleanup must match legacy command and shortcut."
    Assert-Equal ([int]$preview.removedCount) 0 "WhatIf cleanup must not remove files."
    Assert-True (Test-Path -LiteralPath $legacyCmd -PathType Leaf) "Legacy command should still exist after WhatIf."
    Assert-True (Test-Path -LiteralPath $legacyLink -PathType Leaf) "Legacy shortcut should still exist after WhatIf."

    $result = Invoke-RevAgentLegacyDesktopLauncherCleanup -LauncherRoots @($desktopRoot)
    Assert-Equal ([int]$result.matchedCount) 2 "Cleanup must match legacy command and shortcut."
    Assert-Equal ([int]$result.removedCount) 2 "Cleanup must remove both legacy launcher files."
    Assert-Equal ([int]$result.failedCount) 0 "Cleanup should not fail for writable launchers."
    Assert-True (-not (Test-Path -LiteralPath $legacyCmd -PathType Leaf)) "Legacy command must be removed."
    Assert-True (-not (Test-Path -LiteralPath $legacyLink -PathType Leaf)) "Legacy shortcut must be removed."
    Assert-True (Test-Path -LiteralPath $productCmd -PathType Leaf) "revAgent launcher must be preserved."
    Assert-True (Test-Path -LiteralPath $unrelatedScript -PathType Leaf) "Unrelated desktop script must be preserved."
}
finally {
    if (Test-Path -LiteralPath $tempRoot -PathType Container) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Desktop launcher cleanup tests passed." -ForegroundColor Green
