<#
.SYNOPSIS
    CI-safe tests for desktop launcher evidence publishing.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$scriptPath = Join-Path $RepoRoot "scripts\publish-desktop-launcher-evidence.ps1"

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

    if (-not [object]::Equals($Actual, $Expected)) {
        throw "$Message Expected '$Expected', got '$Actual'."
    }
}

function Write-TestJson {
    param(
        [string]$Path,
        [object]$Value
    )

    $directory = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding UTF8
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-desktop-launcher-test-" + [Guid]::NewGuid().ToString("N"))
$reportsRoot = Join-Path $tempRoot "reports"
$desktopRoot = Join-Path $tempRoot "desktop"
$nowUtc = [datetime]"2026-06-30T10:00:00Z"

try {
    New-Item -ItemType Directory -Path $desktopRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $desktopRoot "revAgent Updater STABLE.cmd") `
        -Value '@echo off
set "PRIMARY_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
call "%PRIMARY_ROOT%\tools\Install-revAgent-Updater-GUI.cmd"' `
        -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $desktopRoot "Revit MCP Updater STABLE.cmd") `
        -Value '@echo off
set "RELEASE_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"
call "%RELEASE_ROOT%\tools\Install-Revit-MCP-Updater-GUI.cmd"' `
        -Encoding ASCII

    $legacyScan = & $scriptPath `
        -Mode ScanLocal `
        -ReportsRoot $reportsRoot `
        -MachineName "NET01" `
        -LauncherPath $desktopRoot `
        -NowUtc $nowUtc `
        -OutputJson | ConvertFrom-Json

    Assert-True (-not [bool]$legacyScan.passed) "Legacy launcher scan should fail."
    Assert-Equal ([int]$legacyScan.legacyLauncherCount) 1 "Legacy launcher count mismatch."
    Assert-Equal ([int]$legacyScan.legacyRootReferenceCount) 1 "Legacy root reference count mismatch."
    Assert-True (Test-Path -LiteralPath (Join-Path $reportsRoot "machines\NET01\desktop-launcher-latest.json") -PathType Leaf) "Per-machine launcher evidence was not published."

    Remove-Item -LiteralPath (Join-Path $desktopRoot "Revit MCP Updater STABLE.cmd") -Force
    $cleanScan = & $scriptPath `
        -Mode ScanLocal `
        -ReportsRoot $reportsRoot `
        -MachineName "NET01" `
        -LauncherPath $desktopRoot `
        -NowUtc $nowUtc.AddMinutes(1) `
        -OutputJson | ConvertFrom-Json

    Assert-True ([bool]$cleanScan.passed) "Clean revAgent launcher scan should pass."
    Assert-Equal ([int]$cleanScan.legacyLauncherCount) 0 "Clean legacy launcher count mismatch."
    Assert-Equal ([int]$cleanScan.legacyRootReferenceCount) 0 "Clean legacy root reference count mismatch."

    $discoveryRoot = Join-Path $tempRoot 'fixture-discovery'
    $knownDesktop = Join-Path $discoveryRoot 'known-folders\DesktopDirectory'
    $knownCommonDesktop = Join-Path $discoveryRoot 'known-folders\CommonDesktopDirectory'
    $currentProfileDesktop = Join-Path $discoveryRoot 'current-profile\Desktop'
    $currentProfileOneDriveDesktop = Join-Path $discoveryRoot 'current-profile\OneDrive - DPE\Desktop'
    $profilesRoot = Join-Path $discoveryRoot "profiles"
    $aliceDesktop = Join-Path $profilesRoot "Alice\Desktop"
    $bobDesktop = Join-Path $profilesRoot "Bob\Desktop"
    $bobOneDriveDesktop = Join-Path $profilesRoot "Bob\OneDrive - DPE\Desktop"
    New-Item -ItemType Directory -Path $knownDesktop, $knownCommonDesktop, $currentProfileDesktop, $currentProfileOneDriveDesktop, $aliceDesktop, $bobDesktop, $bobOneDriveDesktop -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $knownDesktop 'revAgent Updater STABLE.cmd') -Value '@echo off' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $currentProfileOneDriveDesktop 'revAgent Updater STABLE.cmd') -Value '@echo off' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $aliceDesktop "Revit MCP Updater STABLE.cmd") `
        -Value '@echo off
set "RELEASE_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"' `
        -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $bobDesktop "revAgent Updater STABLE.cmd") `
        -Value '@echo off
set "PRIMARY_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"' `
        -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $bobOneDriveDesktop "revAgent Updater STABLE.cmd") `
        -Value '@echo off
set "PRIMARY_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"' `
        -Encoding ASCII

    $allProfileScan = & $scriptPath `
        -Mode ScanLocal `
        -ReportsRoot $reportsRoot `
        -MachineName "PROFILESCAN" `
        -UserProfilesRoot $profilesRoot `
        -TestDiscoveryRoot $discoveryRoot `
        -NowUtc $nowUtc.AddMinutes(1) `
        -OutputJson | ConvertFrom-Json

    Assert-True (@($allProfileScan.scannedPaths) -contains $aliceDesktop) "Default scan did not include Alice desktop."
    Assert-True (@($allProfileScan.scannedPaths) -contains $bobDesktop) "Default scan did not include Bob desktop."
    Assert-True (@($allProfileScan.scannedPaths) -contains $bobOneDriveDesktop) "Default scan did not include Bob OneDrive desktop."
    Assert-True (@($allProfileScan.scannedPaths) -contains $knownDesktop) "Fixture-only known-folder Desktop discovery was not included."
    Assert-True (@($allProfileScan.scannedPaths) -contains $knownCommonDesktop) "Fixture-only known-folder CommonDesktop discovery was not included."
    Assert-True (@($allProfileScan.scannedPaths) -contains $currentProfileOneDriveDesktop) "Fixture-only current-profile OneDrive discovery was not included."
    Assert-True ([int]$allProfileScan.legacyLauncherCount -ge 1) "Default all-profile scan did not find the legacy launcher."
    Assert-True (@($allProfileScan.launchers | Where-Object { [string]$_.path -eq (Join-Path $aliceDesktop "Revit MCP Updater STABLE.cmd") }).Count -eq 1) "Default all-profile scan did not report Alice legacy launcher."
    $publisherText = Get-Content -Raw -LiteralPath $scriptPath
    Assert-True ($publisherText -match 'TestDiscoveryRoot is limited to a disposable path below the current TEMP directory' -and $publisherText -match '\[Environment\]::GetFolderPath\(\$specialFolder\)') "Desktop discovery seam must retain the production known-folder resolver and reject non-temp test roots."
    $outsideFixtureError = $null
    try {
        & $scriptPath -Mode ScanLocal -ReportsRoot $reportsRoot -MachineName 'FIXTUREGUARD' -TestDiscoveryRoot $RepoRoot -NowUtc $nowUtc -OutputJson | Out-Null
    }
    catch { $outsideFixtureError = $_ }
    Assert-True ($null -ne $outsideFixtureError -and $outsideFixtureError.Exception.Message -match 'limited to a disposable path') "Desktop discovery seam accepted a non-temp test root."

    $configPath = Join-Path $tempRoot "rollout-readiness.json"
    Write-TestJson -Path $configPath -Value ([ordered]@{
            reportsRoot = $reportsRoot
            expectedMachines = @("NET01", "EMIN", "OLD")
            outOfScopeMachines = @(
                [ordered]@{
                    name = "OLD"
                    reason = "Retired workstation."
                }
            )
        })

    $missingAggregate = & $scriptPath `
        -Mode Aggregate `
        -ConfigPath $configPath `
        -NowUtc $nowUtc.AddMinutes(2) `
        -OutputJson | ConvertFrom-Json

    Assert-True (-not [bool]$missingAggregate.passed) "Aggregate should fail while an expected machine is missing evidence."
    Assert-Equal ([int]$missingAggregate.expectedMachineCount) 2 "Aggregate expected machine count mismatch."
    Assert-Equal ([int]$missingAggregate.checkedMachineCount) 1 "Aggregate checked machine count mismatch."
    Assert-Equal ([int]$missingAggregate.missingMachineCount) 1 "Aggregate missing machine count mismatch."
    Assert-Equal $missingAggregate.missingMachines[0] "EMIN" "Aggregate missing machine mismatch."

    $eminRoot = Join-Path $reportsRoot "machines\EMIN"
    Write-TestJson -Path (Join-Path $eminRoot "desktop-launcher-latest.json") -Value ([ordered]@{
            schemaVersion = "revagent.desktopLauncherEvidence.v1"
            mode = "ScanLocal"
            machine = "EMIN"
            passed = $true
            expectedMachineCount = 1
            checkedMachineCount = 1
            missingMachineCount = 0
            failedMachineCount = 0
            legacyLauncherCount = 0
            legacyRootReferenceCount = 0
            completedAtUtc = $nowUtc.AddMinutes(3).ToString("o")
        })

    $passedAggregate = & $scriptPath `
        -Mode Aggregate `
        -ConfigPath $configPath `
        -NowUtc $nowUtc.AddMinutes(4) `
        -OutputJson | ConvertFrom-Json

    Assert-True ([bool]$passedAggregate.passed) "Aggregate should pass when all in-scope machines have clean launcher evidence."
    Assert-Equal ([int]$passedAggregate.expectedMachineCount) 2 "Passed aggregate expected machine count mismatch."
    Assert-Equal ([int]$passedAggregate.checkedMachineCount) 2 "Passed aggregate checked machine count mismatch."
    Assert-Equal ([int]$passedAggregate.missingMachineCount) 0 "Passed aggregate missing machine count mismatch."
    Assert-True (Test-Path -LiteralPath (Join-Path $reportsRoot "rollout\desktop-launcher-latest.json") -PathType Leaf) "Aggregate rollout launcher evidence was not published."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Desktop launcher evidence tests passed." -ForegroundColor Green
