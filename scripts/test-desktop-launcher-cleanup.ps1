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

$moduleText = Get-Content -Raw -LiteralPath $modulePath -Encoding UTF8
$updaterText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1") -Encoding UTF8
$installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1") -Encoding UTF8
$installerText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\install-self-contained.ps1") -Encoding UTF8
Assert-True ($updaterText -match 'RevAgent\.DesktopLauncherCleanup\.psm1' -and $updaterText -match 'Invoke-RevAgentLegacyDesktopLauncherCleanup' -and $updaterText -match 'desktopLauncherCleanup') "Updater must remove and report legacy desktop launchers."
Assert-True ($updaterText -match 'SpecialFolder\]::Startup' -and $updaterText -match 'Get-RevAgentDefaultDesktopLauncherRoots') "Updater user phase must include the current user's Startup folder in legacy launcher cleanup."
Assert-True ($updaterText -match 'Invoke-RevAgentExactLegacyStartupLauncherCleanup' -and $updaterText -match 'Merge-RevAgentDesktopLauncherCleanupEvidence') "Direct updater user phase must use the shared exact Startup cleanup and merge its structured evidence."
Assert-True ($updaterText -match '\$canonicalRebaselineRequested -and \[int\]\$exactStartupLauncherCleanupState\.failedCount -gt 0' -and $updaterText -match 'exact historical Startup launcher could not be removed') "Canonical/source-free direct updater user phase must fail closed when exact legacy Startup cleanup fails."
Assert-True ($installTaskText -match 'RevAgent\.DesktopLauncherCleanup\.psm1' -and $installTaskText -match 'Invoke-RevAgentLegacyDesktopLauncherCleanup' -and $installTaskText -match 'desktopLauncherCleanup') "Updater task installer must remove and report legacy desktop launchers."
Assert-True ($installTaskText -match 'Invoke-RevAgentExactLegacyStartupLauncherCleanup' -and $installTaskText -match 'Legacy Startup launcher cleanup failed closed') "Install wrapper must use the shared exact Startup cleanup and fail closed on removal failure."
Assert-True ($installerText -match 'RevAgent\.DesktopLauncherCleanup\.psm1' -and $installerText -match 'Invoke-RevAgentLegacyDesktopLauncherCleanup') "Self-contained installer must remove legacy desktop launchers."
Assert-True ($moduleText -match 'FILE_FLAG_OPEN_REPARSE_POINT' -and $moduleText -match 'NumberOfLinks' -and $moduleText -match '\[System\.IO\.File\]::Delete\(\$legacyStartupPath\)') "Exact Startup cleanup must inspect leaf metadata without following reparses, require hardlink evidence, and delete without Force attribute mutation."
Assert-True ($moduleText -notmatch 'Remove-Item\s+-LiteralPath\s+\$legacyStartupPath\s+-Force') "Exact Startup cleanup must never use Force deletion against a potentially shared file record."

foreach ($commandName in @(
        "Invoke-RevAgentExactLegacyStartupLauncherCleanup",
        "Merge-RevAgentDesktopLauncherCleanupEvidence",
        "Merge-RevAgentLauncherCleanupEvidence"
    )) {
    Assert-True ($null -ne (Get-Command -Name $commandName -CommandType Function -ErrorAction SilentlyContinue)) "Shared launcher cleanup module must export $commandName."
}

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

    $startupRoot = Join-Path $tempRoot "Startup"
    New-Item -ItemType Directory -Path $startupRoot -Force | Out-Null
    $legacyStartup = Join-Path $startupRoot "Revit MCP Auto Update.cmd"
    Set-Content -LiteralPath $legacyStartup -Value '@echo off & powershell -File "C:\ProgramData\DPE\RevitMCP\updater\update-from-nas.ps1"' -Encoding ASCII

    $exactOnlyStartup = Join-Path $startupRoot "Revit MCP Auto Update.vbs"
    Set-Content -LiteralPath $exactOnlyStartup -Value "WScript.Quit 0" -Encoding ASCII
    $currentStartup = Join-Path $startupRoot "revAgent Auto Update.vbs"
    Set-Content -LiteralPath $currentStartup -Value "WScript.Quit 0" -Encoding ASCII
    $unrelatedStartup = Join-Path $startupRoot "project-reminder.cmd"
    Set-Content -LiteralPath $unrelatedStartup -Value "@echo off" -Encoding ASCII

    $exactPreview = Invoke-RevAgentExactLegacyStartupLauncherCleanup -StartupRoot $startupRoot -WhatIfOnly
    Assert-Equal ([int]$exactPreview.matchedCount) 2 "Exact Startup preview must match both historical names without inspecting file content."
    Assert-Equal ([int]$exactPreview.removedCount) 0 "Exact Startup preview must not remove files."
    Assert-True (Test-Path -LiteralPath $exactOnlyStartup -PathType Leaf) "Exact Startup preview must preserve the historical VBS file."

    $exactResult = Invoke-RevAgentExactLegacyStartupLauncherCleanup -StartupRoot $startupRoot
    Assert-Equal ([int]$exactResult.matchedCount) 2 "Exact Startup cleanup must match both historical names."
    Assert-Equal ([int]$exactResult.removedCount) 2 "Exact Startup cleanup must remove both historical names."
    Assert-Equal ([int]$exactResult.failedCount) 0 "Exact Startup cleanup should remove writable historical launchers."
    Assert-True (-not (Test-Path -LiteralPath $legacyStartup)) "Exact Startup cleanup must remove the historical CMD."
    Assert-True (-not (Test-Path -LiteralPath $exactOnlyStartup)) "Exact Startup cleanup must remove the historical VBS even when its content has no legacy token."
    Assert-True (Test-Path -LiteralPath $currentStartup -PathType Leaf) "Exact Startup cleanup must preserve the current revAgent launcher."
    Assert-True (Test-Path -LiteralPath $unrelatedStartup -PathType Leaf) "Exact Startup cleanup must preserve unrelated Startup files."

    # Recreate one content-matching historical file for the broader cleanup
    # fixture below. The exact-name behavior is tested independently above.
    Set-Content -LiteralPath $legacyStartup -Value '@echo off & powershell -File "C:\ProgramData\DPE\RevitMCP\updater\update-from-nas.ps1"' -Encoding ASCII

    $preview = Invoke-RevAgentLegacyDesktopLauncherCleanup -LauncherRoots @($desktopRoot, $startupRoot) -WhatIfOnly
    Assert-Equal ([int]$preview.matchedCount) 3 "WhatIf cleanup must match legacy desktop and Startup launchers."
    Assert-Equal ([int]$preview.removedCount) 0 "WhatIf cleanup must not remove files."
    Assert-True (Test-Path -LiteralPath $legacyCmd -PathType Leaf) "Legacy command should still exist after WhatIf."
    Assert-True (Test-Path -LiteralPath $legacyLink -PathType Leaf) "Legacy shortcut should still exist after WhatIf."

    $result = Invoke-RevAgentLegacyDesktopLauncherCleanup -LauncherRoots @($desktopRoot, $startupRoot)
    Assert-Equal ([int]$result.matchedCount) 3 "Cleanup must match legacy desktop and Startup launchers."
    Assert-Equal ([int]$result.removedCount) 3 "Cleanup must remove all legacy launcher files."
    Assert-Equal ([int]$result.failedCount) 0 "Cleanup should not fail for writable launchers."
    Assert-True (-not (Test-Path -LiteralPath $legacyCmd -PathType Leaf)) "Legacy command must be removed."
    Assert-True (-not (Test-Path -LiteralPath $legacyLink -PathType Leaf)) "Legacy shortcut must be removed."
    Assert-True (-not (Test-Path -LiteralPath $legacyStartup -PathType Leaf)) "Legacy Startup command must be removed."
    Assert-True (Test-Path -LiteralPath $productCmd -PathType Leaf) "revAgent launcher must be preserved."
    Assert-True (Test-Path -LiteralPath $unrelatedScript -PathType Leaf) "Unrelated desktop script must be preserved."

    $lockedStartupRoot = Join-Path $tempRoot "LockedStartup"
    New-Item -ItemType Directory -Path $lockedStartupRoot -Force | Out-Null
    $lockedLegacyStartup = Join-Path $lockedStartupRoot "Revit MCP Auto Update.cmd"
    Set-Content -LiteralPath $lockedLegacyStartup -Value "@echo off" -Encoding ASCII
    $lockedStream = $null
    try {
        $lockedStream = [System.IO.File]::Open(
            $lockedLegacyStartup,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read)
        $lockedResult = Invoke-RevAgentExactLegacyStartupLauncherCleanup -StartupRoot $lockedStartupRoot
        Assert-Equal ([int]$lockedResult.matchedCount) 1 "Locked exact Startup fixture must still be matched."
        Assert-Equal ([int]$lockedResult.removedCount) 0 "Locked exact Startup fixture must not be reported removed."
        Assert-Equal ([int]$lockedResult.failedCount) 1 "Locked exact Startup fixture must produce one structured failure."
        Assert-Equal ([string]$lockedResult.failed[0].source) "exact-legacy-startup-name" "Exact Startup failure must retain exact-name provenance."
        Assert-True (Test-Path -LiteralPath $lockedLegacyStartup -PathType Leaf) "Failed exact Startup cleanup must leave the locked file in place for a fail-closed caller."
    }
    finally {
        if ($null -ne $lockedStream) { $lockedStream.Dispose() }
    }

    $hardlinkStartupRoot = Join-Path $tempRoot "HardlinkStartup"
    $hardlinkExternalRoot = Join-Path $tempRoot "HardlinkExternal"
    New-Item -ItemType Directory -Path $hardlinkStartupRoot, $hardlinkExternalRoot -Force | Out-Null
    $hardlinkExternalFile = Join-Path $hardlinkExternalRoot "external-launcher.cmd"
    $hardlinkExternalBytes = [byte[]](0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255)
    [System.IO.File]::WriteAllBytes($hardlinkExternalFile, $hardlinkExternalBytes)
    $hardlinkOriginalAttributes = [System.IO.File]::GetAttributes($hardlinkExternalFile)
    $hardlinkCandidate = Join-Path $hardlinkStartupRoot "Revit MCP Auto Update.cmd"
    try {
        New-Item -ItemType HardLink -Path $hardlinkCandidate -Target $hardlinkExternalFile -Force | Out-Null
        [System.IO.File]::SetAttributes(
            $hardlinkExternalFile,
            ($hardlinkOriginalAttributes -bor [System.IO.FileAttributes]::Hidden -bor [System.IO.FileAttributes]::ReadOnly))
        $hardlinkBytesBefore = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($hardlinkExternalFile))
        $hardlinkAttributesBefore = [uint32][System.IO.File]::GetAttributes($hardlinkExternalFile)
        $hardlinkAclBefore = (Get-Acl -LiteralPath $hardlinkExternalFile).Sddl

        $hardlinkResult = Invoke-RevAgentExactLegacyStartupLauncherCleanup -StartupRoot $hardlinkStartupRoot
        Assert-Equal ([int]$hardlinkResult.matchedCount) 1 "Exact Startup hardlink fixture must be matched by name."
        Assert-Equal ([int]$hardlinkResult.removedCount) 0 "Exact Startup hardlink fixture must not be removed."
        Assert-Equal ([int]$hardlinkResult.failedCount) 1 "Exact Startup hardlink fixture must fail closed."
        Assert-Equal ([string]$hardlinkResult.failed[0].reason) "non_unit_hardlink" "Exact Startup hardlink failure must retain the security reason."
        Assert-True ([int]$hardlinkResult.failed[0].linkCount -gt 1) "Exact Startup hardlink failure must attest the non-unit link count."
        Assert-True (Test-Path -LiteralPath $hardlinkCandidate -PathType Leaf) "Blocked hardlink candidate must remain in place for operator remediation."
        Assert-True (Test-Path -LiteralPath $hardlinkExternalFile -PathType Leaf) "External hardlink sibling must remain in place."
        Assert-Equal ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($hardlinkExternalFile))) $hardlinkBytesBefore "Hardlink rejection must preserve external bytes."
        Assert-Equal ([uint32][System.IO.File]::GetAttributes($hardlinkExternalFile)) $hardlinkAttributesBefore "Hardlink rejection must preserve external file attributes."
        Assert-Equal ((Get-Acl -LiteralPath $hardlinkExternalFile).Sddl) $hardlinkAclBefore "Hardlink rejection must preserve external ACL metadata."
    }
    finally {
        if ([System.IO.File]::Exists($hardlinkExternalFile)) {
            [System.IO.File]::SetAttributes($hardlinkExternalFile, $hardlinkOriginalAttributes)
        }
        if ([System.IO.File]::Exists($hardlinkCandidate)) {
            [System.IO.File]::Delete($hardlinkCandidate)
        }
    }

    $leafJunctionStartupRoot = Join-Path $tempRoot "LeafJunctionStartup"
    $leafJunctionExternalRoot = Join-Path $tempRoot "LeafJunctionExternal"
    New-Item -ItemType Directory -Path $leafJunctionStartupRoot, $leafJunctionExternalRoot -Force | Out-Null
    $leafJunctionExternalMarker = Join-Path $leafJunctionExternalRoot "external-marker.bin"
    [System.IO.File]::WriteAllBytes($leafJunctionExternalMarker, [byte[]](9, 8, 7, 6, 5, 4, 3, 2, 1))
    $leafJunctionMarkerOriginalAttributes = [System.IO.File]::GetAttributes($leafJunctionExternalMarker)
    $leafJunctionCandidate = Join-Path $leafJunctionStartupRoot "Revit MCP Auto Update.vbs"
    try {
        New-Item -ItemType Junction -Path $leafJunctionCandidate -Target $leafJunctionExternalRoot -Force | Out-Null
        [System.IO.File]::SetAttributes(
            $leafJunctionExternalMarker,
            ($leafJunctionMarkerOriginalAttributes -bor [System.IO.FileAttributes]::Hidden -bor [System.IO.FileAttributes]::ReadOnly))
        $leafJunctionBytesBefore = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($leafJunctionExternalMarker))
        $leafJunctionAttributesBefore = [uint32][System.IO.File]::GetAttributes($leafJunctionExternalMarker)
        $leafJunctionAclBefore = (Get-Acl -LiteralPath $leafJunctionExternalMarker).Sddl

        $leafJunctionResult = Invoke-RevAgentExactLegacyStartupLauncherCleanup -StartupRoot $leafJunctionStartupRoot
        Assert-Equal ([int]$leafJunctionResult.matchedCount) 1 "Exact-name leaf junction fixture must be matched without traversal."
        Assert-Equal ([int]$leafJunctionResult.removedCount) 0 "Exact-name leaf junction fixture must not be removed."
        Assert-Equal ([int]$leafJunctionResult.failedCount) 1 "Exact-name leaf junction fixture must fail closed."
        Assert-Equal ([string]$leafJunctionResult.failed[0].reason) "leaf_reparse_point" "Leaf junction rejection must retain its no-follow reason."
        Assert-True (Test-Path -LiteralPath $leafJunctionCandidate -PathType Container) "Rejected leaf junction must remain in place."
        Assert-Equal ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($leafJunctionExternalMarker))) $leafJunctionBytesBefore "Leaf junction rejection must preserve external bytes."
        Assert-Equal ([uint32][System.IO.File]::GetAttributes($leafJunctionExternalMarker)) $leafJunctionAttributesBefore "Leaf junction rejection must preserve external attributes."
        Assert-Equal ((Get-Acl -LiteralPath $leafJunctionExternalMarker).Sddl) $leafJunctionAclBefore "Leaf junction rejection must preserve external ACL metadata."
    }
    finally {
        if ([System.IO.File]::Exists($leafJunctionExternalMarker)) {
            [System.IO.File]::SetAttributes($leafJunctionExternalMarker, $leafJunctionMarkerOriginalAttributes)
        }
        if ([System.IO.Directory]::Exists($leafJunctionCandidate)) {
            [System.IO.Directory]::Delete($leafJunctionCandidate, $false)
        }
    }

    $ancestorJunctionExternalRoot = Join-Path $tempRoot "AncestorJunctionExternal"
    $ancestorJunctionRealStartup = Join-Path $ancestorJunctionExternalRoot "Startup"
    New-Item -ItemType Directory -Path $ancestorJunctionRealStartup -Force | Out-Null
    $ancestorJunctionExternalFile = Join-Path $ancestorJunctionRealStartup "Revit MCP Auto Update.cmd"
    [System.IO.File]::WriteAllBytes($ancestorJunctionExternalFile, [byte[]](1, 3, 3, 7))
    $ancestorJunctionOriginalAttributes = [System.IO.File]::GetAttributes($ancestorJunctionExternalFile)
    $ancestorJunctionRoot = Join-Path $tempRoot "AncestorJunction"
    try {
        New-Item -ItemType Junction -Path $ancestorJunctionRoot -Target $ancestorJunctionExternalRoot -Force | Out-Null
        [System.IO.File]::SetAttributes(
            $ancestorJunctionExternalFile,
            ($ancestorJunctionOriginalAttributes -bor [System.IO.FileAttributes]::Hidden -bor [System.IO.FileAttributes]::ReadOnly))
        $ancestorJunctionStartupRoot = Join-Path $ancestorJunctionRoot "Startup"
        $ancestorJunctionBytesBefore = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($ancestorJunctionExternalFile))
        $ancestorJunctionAttributesBefore = [uint32][System.IO.File]::GetAttributes($ancestorJunctionExternalFile)
        $ancestorJunctionAclBefore = (Get-Acl -LiteralPath $ancestorJunctionExternalFile).Sddl

        $ancestorJunctionResult = Invoke-RevAgentExactLegacyStartupLauncherCleanup -StartupRoot $ancestorJunctionStartupRoot
        Assert-Equal ([int]$ancestorJunctionResult.matchedCount) 0 "Unsafe Startup ancestor must be rejected before exact leaf traversal."
        Assert-Equal ([int]$ancestorJunctionResult.removedCount) 0 "Unsafe Startup ancestor must not remove external content."
        Assert-Equal ([int]$ancestorJunctionResult.failedCount) 1 "Unsafe Startup ancestor must fail closed with structured evidence."
        Assert-Equal ([string]$ancestorJunctionResult.failed[0].reason) "unsafe_reparse_ancestor" "Ancestor junction rejection must retain its bounded-path reason."
        Assert-Equal ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($ancestorJunctionExternalFile))) $ancestorJunctionBytesBefore "Ancestor junction rejection must preserve external bytes."
        Assert-Equal ([uint32][System.IO.File]::GetAttributes($ancestorJunctionExternalFile)) $ancestorJunctionAttributesBefore "Ancestor junction rejection must preserve external attributes."
        Assert-Equal ((Get-Acl -LiteralPath $ancestorJunctionExternalFile).Sddl) $ancestorJunctionAclBefore "Ancestor junction rejection must preserve external ACL metadata."
    }
    finally {
        if ([System.IO.File]::Exists($ancestorJunctionExternalFile)) {
            [System.IO.File]::SetAttributes($ancestorJunctionExternalFile, $ancestorJunctionOriginalAttributes)
        }
        if ([System.IO.Directory]::Exists($ancestorJunctionRoot)) {
            [System.IO.Directory]::Delete($ancestorJunctionRoot, $false)
        }
    }
}
finally {
    if (Test-Path -LiteralPath $tempRoot -PathType Container) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Desktop launcher cleanup tests passed." -ForegroundColor Green
