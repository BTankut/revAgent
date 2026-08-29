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
$fixtureModulePath = Join-Path $RepoRoot 'scripts\RevAgent.TestFixtureAuthority.psm1'
Import-Module -Name $fixtureModulePath -Force -ErrorAction Stop

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

function Invoke-FixturePublisher {
    param(
        [Parameter(Mandatory = $true)][string]$FixtureRoot,
        [Parameter(Mandatory = $true)][string]$DiscoveryRoot,
        [Parameter(Mandatory = $true)][string]$FixtureReportsRoot,
        [Parameter(Mandatory = $true)][hashtable]$Arguments
    )
    $authority = New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $FixtureRoot -DiscoveryRoot $DiscoveryRoot -ReportsRoot $FixtureReportsRoot
    try { return & $scriptPath @Arguments -TestFixtureAuthority $authority }
    finally { $authority.Dispose() }
}

function Protect-FixtureRoot {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($identity.User)
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    }
    if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item, $acl) }
    else { ([IO.DirectoryInfo]$item).SetAccessControl($acl) }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-desktop-launcher-test-" + [Guid]::NewGuid().ToString("N"))
$reportsRoot = Join-Path $tempRoot "reports"
$fixtureSpace = Join-Path $tempRoot 'discovery-space'
$desktopRoot = Join-Path $fixtureSpace "desktop"
$nowUtc = [datetime]"2026-06-30T10:00:00Z"

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
Protect-FixtureRoot -Path $tempRoot
try {
    New-Item -ItemType Directory -Path $desktopRoot, $reportsRoot -Force | Out-Null
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

    $legacyScan = Invoke-FixturePublisher -FixtureRoot $tempRoot -DiscoveryRoot $fixtureSpace -FixtureReportsRoot $reportsRoot -Arguments @{
        Mode = 'ScanLocal'; MachineName = 'NET01'; LauncherPath = @($desktopRoot); NowUtc = $nowUtc; OutputJson = $true
    } | ConvertFrom-Json

    Assert-True (-not [bool]$legacyScan.passed) "Legacy launcher scan should fail."
    Assert-Equal ([int]$legacyScan.legacyLauncherCount) 1 "Legacy launcher count mismatch."
    Assert-Equal ([int]$legacyScan.legacyRootReferenceCount) 1 "Legacy root reference count mismatch."
    Assert-True (Test-Path -LiteralPath (Join-Path $reportsRoot "machines\NET01\desktop-launcher-latest.json") -PathType Leaf) "Per-machine launcher evidence was not published."

    Remove-Item -LiteralPath (Join-Path $desktopRoot "Revit MCP Updater STABLE.cmd") -Force
    $cleanScan = Invoke-FixturePublisher -FixtureRoot $tempRoot -DiscoveryRoot $fixtureSpace -FixtureReportsRoot $reportsRoot -Arguments @{
        Mode = 'ScanLocal'; MachineName = 'NET01'; LauncherPath = @($desktopRoot); NowUtc = $nowUtc.AddMinutes(1); OutputJson = $true
    } | ConvertFrom-Json

    Assert-True ([bool]$cleanScan.passed) "Clean revAgent launcher scan should pass."
    Assert-Equal ([int]$cleanScan.legacyLauncherCount) 0 "Clean legacy launcher count mismatch."
    Assert-Equal ([int]$cleanScan.legacyRootReferenceCount) 0 "Clean legacy root reference count mismatch."

    $discoveryRoot = Join-Path $fixtureSpace 'fixture-discovery'
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

    $allProfileScan = Invoke-FixturePublisher -FixtureRoot $tempRoot -DiscoveryRoot $discoveryRoot -FixtureReportsRoot $reportsRoot -Arguments @{
        Mode = 'ScanLocal'; MachineName = 'PROFILESCAN'; NowUtc = $nowUtc.AddMinutes(1); OutputJson = $true
    } | ConvertFrom-Json

    Assert-True (@($allProfileScan.scannedPaths) -contains $aliceDesktop) "Default scan did not include Alice desktop."
    Assert-True (@($allProfileScan.scannedPaths) -contains $bobDesktop) "Default scan did not include Bob desktop."
    Assert-True (@($allProfileScan.scannedPaths) -contains $bobOneDriveDesktop) "Default scan did not include Bob OneDrive desktop."
    Assert-True (@($allProfileScan.scannedPaths) -contains $knownDesktop) "Fixture-only known-folder Desktop discovery was not included."
    Assert-True (@($allProfileScan.scannedPaths) -contains $knownCommonDesktop) "Fixture-only known-folder CommonDesktop discovery was not included."
    Assert-True (@($allProfileScan.scannedPaths) -contains $currentProfileOneDriveDesktop) "Fixture-only current-profile OneDrive discovery was not included."
    Assert-True ([int]$allProfileScan.legacyLauncherCount -ge 1) "Default all-profile scan did not find the legacy launcher."
    Assert-True (@($allProfileScan.launchers | Where-Object { [string]$_.path -eq (Join-Path $aliceDesktop "Revit MCP Updater STABLE.cmd") }).Count -eq 1) "Default all-profile scan did not report Alice legacy launcher."
    $publisherText = Get-Content -Raw -LiteralPath $scriptPath
    $authorityModuleText = Get-Content -Raw -LiteralPath $fixtureModulePath
    Assert-True ($publisherText -match '\[Environment\]::GetFolderPath\(\$specialFolder\)' -and $publisherText -notmatch 'Import-Module.+TestFixtureAuthority' -and $publisherText -notmatch 'TestDiscoveryRoot') 'Publisher default discovery changed or retained a path-authority seam.'
    $forbiddenAuthorityCarrierPattern = ('TestFixtureAuthority' + 'Path|REVAGENT_.+AUTH' + 'ORITY|Raw' + 'Handle|caller' + 'Pid')
    Assert-True ($authorityModuleText -notmatch $forbiddenAuthorityCarrierPattern) 'Fixture module exposes a forbidden transferable authority carrier.'

    $windowsPowerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $escapedFixtureModulePath = $fixtureModulePath.Replace("'", "''")
    $fixedPreloadScript = @"
Add-Type -TypeDefinition @'
using System;
namespace RevAgent.TestFixtures {
  public sealed class FakeLease { public string WriteStartupFailureLog(string[] lines) { return @"C:\forged\gui.log"; } }
  public sealed class RevAgentTestFixtureAuthority {
    public static object IssueGui(string root, string log, string name) { return new RevAgentTestFixtureAuthority(); }
    public static object IssueDesktop(string root, string discovery, string reports) { return new RevAgentTestFixtureAuthority(); }
    public FakeLease ConsumeGuiStartupFailureLog() { return new FakeLease(); }
    public object ConsumeDesktopLauncherDiscovery() { return new object(); }
  }
}
'@
try { Import-Module '$escapedFixtureModulePath' -Force -ErrorAction Stop; exit 91 }
catch { if (`$_.Exception.Message -match 'fixture_authority_type_preloaded') { 'fixed-preload-refused'; exit 0 }; throw }
"@
    $fixedPreloadEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($fixedPreloadScript))
    $fixedPreloadOutput = @(& $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $fixedPreloadEncoded 2>&1 | ForEach-Object { [string]$_ })
    $fixedPreloadExit = $LASTEXITCODE
    Assert-True ($fixedPreloadExit -eq 0 -and ((@($fixedPreloadOutput) -join ' | ') -match 'fixed-preload-refused')) 'A forged fixed-name Issue/Consume authority type survived module import.'

    $duplicateRoot = Join-Path $tempRoot 'duplicate-type-root'
    $duplicateDiscovery = Join-Path $duplicateRoot 'discovery'
    $duplicateReports = Join-Path $duplicateRoot 'reports'
    $duplicateDesktop = Join-Path $duplicateDiscovery 'Desktop'
    $duplicateAssemblyPath = Join-Path $duplicateRoot 'forged-duplicate.dll'
    New-Item -ItemType Directory -Path $duplicateDesktop, $duplicateReports -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $duplicateDesktop 'revAgent Updater STABLE.cmd'), '@echo off', [Text.UTF8Encoding]::new($false))
    $escapedPublisherPath = $scriptPath.Replace("'", "''")
    $escapedDuplicateRoot = $duplicateRoot.Replace("'", "''")
    $escapedDuplicateDiscovery = $duplicateDiscovery.Replace("'", "''")
    $escapedDuplicateReports = $duplicateReports.Replace("'", "''")
    $escapedDuplicateDesktop = $duplicateDesktop.Replace("'", "''")
    $escapedDuplicateAssemblyPath = $duplicateAssemblyPath.Replace("'", "''")
    $duplicateTypeScript = @"
Import-Module '$escapedFixtureModulePath' -Force -ErrorAction Stop
`$authority = New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot '$escapedDuplicateRoot' -DiscoveryRoot '$escapedDuplicateDiscovery' -ReportsRoot '$escapedDuplicateReports'
try {
  `$ns = `$authority.GetType().Namespace
  `$source = 'namespace ' + `$ns + ' { public sealed class RevAgentTestFixtureAuthority { public object ConsumeDesktopLauncherDiscovery() { return new object(); } } }'
  Add-Type -TypeDefinition `$source -OutputAssembly '$escapedDuplicateAssemblyPath' -ErrorAction Stop
  [void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes('$escapedDuplicateAssemblyPath'))
  [IO.File]::Delete('$escapedDuplicateAssemblyPath')
  try { & '$escapedPublisherPath' -Mode ScanLocal -MachineName DUPLICATE -LauncherPath '$escapedDuplicateDesktop' -OutputJson -TestFixtureAuthority `$authority | Out-Null; exit 92 }
  catch { if (`$_.Exception.Message -match 'provenance_refused') { 'duplicate-type-refused'; exit 0 }; throw }
}
finally { `$authority.Dispose() }
"@
    $duplicateTypeEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($duplicateTypeScript))
    $duplicateTypeOutput = @(& $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $duplicateTypeEncoded 2>&1 | ForEach-Object { [string]$_ })
    $duplicateTypeExit = $LASTEXITCODE
    Assert-True ($duplicateTypeExit -eq 0 -and ((@($duplicateTypeOutput) -join ' | ') -match 'duplicate-type-refused')) 'A duplicate random full-name type survived exact Assembly/Module ownership binding.'

    $carrierPath = Join-Path $tempRoot 'cross-process-authority.clixml'
    $crossProcessAuthority = New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $duplicateRoot -DiscoveryRoot $duplicateDiscovery -ReportsRoot $duplicateReports
    try { $crossProcessAuthority | Export-Clixml -LiteralPath $carrierPath -Depth 4 }
    finally { $crossProcessAuthority.Dispose() }
    $escapedCarrierPath = $carrierPath.Replace("'", "''")
    $crossProcessScript = @"
Import-Module '$escapedFixtureModulePath' -Force -ErrorAction Stop
`$carrier = Import-Clixml -LiteralPath '$escapedCarrierPath'
try { & '$escapedPublisherPath' -Mode ScanLocal -MachineName CROSSPROCESS -TestFixtureAuthority `$carrier -OutputJson | Out-Null; exit 93 }
catch { if (`$_.Exception.Message -match 'provenance_refused') { 'cross-process-carrier-refused'; exit 0 }; throw }
"@
    $crossProcessEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($crossProcessScript))
    $crossProcessOutput = @(& $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $crossProcessEncoded 2>&1 | ForEach-Object { [string]$_ })
    $crossProcessExit = $LASTEXITCODE
    Assert-True ($crossProcessExit -eq 0 -and ((@($crossProcessOutput) -join ' | ') -match 'cross-process-carrier-refused')) 'A real cross-process CLIXML authority carrier was accepted.'

    $wrongShapeError = $null
    try {
        & $scriptPath -Mode ScanLocal -MachineName 'WRONGSHAPE' -TestFixtureAuthority ([pscustomobject]@{ purpose = 'DesktopLauncherDiscovery' }) -NowUtc $nowUtc -OutputJson | Out-Null
    }
    catch { $wrongShapeError = $_ }
    Assert-True ($null -ne $wrongShapeError -and $wrongShapeError.Exception.Message -match 'authority.*refused') 'Publisher accepted a shape-compatible object as authority.'

    $outsideDiscoveryTarget = Join-Path $tempRoot 'outside-discovery-target'
    $swappedDiscoveryRoot = Join-Path $tempRoot 'swapped-discovery-root'
    New-Item -ItemType Directory -Path $outsideDiscoveryTarget, $swappedDiscoveryRoot -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $outsideDiscoveryTarget 'must-remain-unchanged.txt'), 'outside-discovery-target', [Text.UTF8Encoding]::new($false))
    [IO.Directory]::Delete($swappedDiscoveryRoot, $false)
    New-Item -ItemType Junction -Path $swappedDiscoveryRoot -Target $outsideDiscoveryTarget | Out-Null
    $swappedFixtureError = $null
    try {
        New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $tempRoot -DiscoveryRoot $swappedDiscoveryRoot -ReportsRoot $reportsRoot | Out-Null
    }
    catch { $swappedFixtureError = $_ }
    Assert-True ($null -ne $swappedFixtureError -and $swappedFixtureError.Exception.Message -match 'reparse') 'Authority factory accepted a discovery junction.'
    Assert-True ([IO.File]::ReadAllText((Join-Path $outsideDiscoveryTarget 'must-remain-unchanged.txt')) -eq 'outside-discovery-target') "Desktop discovery seam touched the junction target."
    [IO.Directory]::Delete($swappedDiscoveryRoot, $false)

    $pinRoot = Join-Path $tempRoot 'pin-root'
    $pinDiscovery = Join-Path $pinRoot 'discovery'
    $pinReports = Join-Path $pinRoot 'reports'
    New-Item -ItemType Directory -Path $pinDiscovery, $pinReports -Force | Out-Null
    $pinAuthority = New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $pinRoot -DiscoveryRoot $pinDiscovery -ReportsRoot $pinReports
    $pinSwapError = $null
    try { Move-Item -LiteralPath $pinDiscovery -Destination (Join-Path $pinRoot 'moved-discovery') -ErrorAction Stop }
    catch { $pinSwapError = $_ }
    finally { $pinAuthority.Dispose() }
    Assert-True ($null -ne $pinSwapError) 'Pinned discovery root allowed an after-issuance rename/rebind.'

    $replayAuthority = New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $tempRoot -DiscoveryRoot $fixtureSpace -ReportsRoot $reportsRoot
    try {
        & $scriptPath -Mode ScanLocal -MachineName 'REPLAY1' -LauncherPath $desktopRoot -NowUtc $nowUtc -OutputJson -TestFixtureAuthority $replayAuthority | Out-Null
        $replayError = $null
        try { & $scriptPath -Mode ScanLocal -MachineName 'REPLAY2' -LauncherPath $desktopRoot -NowUtc $nowUtc -OutputJson -TestFixtureAuthority $replayAuthority | Out-Null }
        catch { $replayError = $_ }
        Assert-True ($null -ne $replayError -and $replayError.Exception.Message -match 'reuse') 'One-use authority was replayed.'
    }
    finally { $replayAuthority.Dispose() }

    $serializedAuthority = New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $tempRoot -DiscoveryRoot $fixtureSpace -ReportsRoot $reportsRoot
    try { $serializedClone = [Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($serializedAuthority)) }
    finally { $serializedAuthority.Dispose() }
    $serializedError = $null
    try { & $scriptPath -Mode ScanLocal -MachineName 'SERIALIZED' -TestFixtureAuthority $serializedClone -NowUtc $nowUtc -OutputJson | Out-Null }
    catch { $serializedError = $_ }
    Assert-True ($null -ne $serializedError -and $serializedError.Exception.Message -match 'authority.*refused') 'Serialized authority clone was accepted.'

    $wrongPurposeLog = Join-Path $tempRoot 'wrong-purpose-log'
    New-Item -ItemType Directory -Path $wrongPurposeLog -Force | Out-Null
    $wrongPurposeAuthority = New-RevAgentGuiLogFixtureAuthority -FixtureRoot $tempRoot -LogDirectory $wrongPurposeLog
    $wrongPurposeError = $null
    try { & $scriptPath -Mode ScanLocal -MachineName 'WRONGPURPOSE' -TestFixtureAuthority $wrongPurposeAuthority -NowUtc $nowUtc -OutputJson | Out-Null }
    catch { $wrongPurposeError = $_ }
    finally { $wrongPurposeAuthority.Dispose() }
    Assert-True ($null -ne $wrongPurposeError -and $wrongPurposeError.Exception.Message -match 'purpose') 'Publisher accepted a GUI-purpose authority.'

    $hardlinkRoot = Join-Path $tempRoot 'hardlink-root'
    $hardlinkDiscovery = Join-Path $hardlinkRoot 'discovery'
    $hardlinkDesktop = Join-Path $hardlinkDiscovery 'Desktop'
    $hardlinkReports = Join-Path $hardlinkRoot 'reports'
    New-Item -ItemType Directory -Path $hardlinkDesktop, $hardlinkReports -Force | Out-Null
    $hardlinkSource = Join-Path $hardlinkDesktop 'revAgent Updater STABLE.cmd'
    $hardlinkAlias = Join-Path $hardlinkDesktop 'revAgent Updater STABLE alias.cmd'
    Set-Content -LiteralPath $hardlinkSource -Value '@echo off' -Encoding ASCII
    New-Item -ItemType HardLink -Path $hardlinkAlias -Target $hardlinkSource | Out-Null
    $hardlinkError = $null
    try { Invoke-FixturePublisher -FixtureRoot $hardlinkRoot -DiscoveryRoot $hardlinkDiscovery -FixtureReportsRoot $hardlinkReports -Arguments @{ Mode='ScanLocal'; MachineName='HARDLINK'; LauncherPath=@($hardlinkDesktop); NowUtc=$nowUtc; OutputJson=$true } | Out-Null }
    catch { $hardlinkError = $_ }
    Assert-True ($null -ne $hardlinkError -and $hardlinkError.Exception.Message -match 'hardlink') 'Publisher accepted a multi-link launcher file.'

    $disposedAuthority = New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $tempRoot -DiscoveryRoot $fixtureSpace -ReportsRoot $reportsRoot
    $disposedAuthority.Dispose()
    $disposedError = $null
    try { $disposedAuthority.ConsumeDesktopLauncherDiscovery() | Out-Null }
    catch { $disposedError = $_ }
    Assert-True ($null -ne $disposedError -and $disposedError.Exception.Message -match 'reuse') 'Disposed authority was accepted.'

    foreach ($badCarrier in @('fixture-path', @{}, ('{"purpose":"DesktopLauncherDiscovery"}' | ConvertFrom-Json))) {
        $badCarrierError = $null
        try { & $scriptPath -Mode ScanLocal -MachineName 'BADCARRIER' -TestFixtureAuthority $badCarrier -NowUtc $nowUtc -OutputJson | Out-Null }
        catch { $badCarrierError = $_ }
        Assert-True ($null -ne $badCarrierError -and $badCarrierError.Exception.Message -match 'authority.*refused') 'A string/dictionary/JSON authority carrier was accepted.'
    }

    $wrongPidAuthority = New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $tempRoot -DiscoveryRoot $fixtureSpace -ReportsRoot $reportsRoot
    $creatorPidField = $wrongPidAuthority.GetType().GetField('creatorPid', [Reflection.BindingFlags]'Instance,NonPublic')
    $creatorPidField.SetValue($wrongPidAuthority, -1)
    $wrongPidError = $null
    try { $wrongPidAuthority.ConsumeDesktopLauncherDiscovery() | Out-Null }
    catch { $wrongPidError = $_ }
    finally { $wrongPidAuthority.Dispose() }
    Assert-True ($null -ne $wrongPidError -and $wrongPidError.Exception.Message -match 'process') 'Creator-PID mismatch did not poison the authority.'

    $foreignAclRoot = Join-Path $tempRoot 'foreign-writer-acl-root'
    $foreignAclDiscovery = Join-Path $foreignAclRoot 'discovery'
    $foreignAclReports = Join-Path $foreignAclRoot 'reports'
    New-Item -ItemType Directory -Path $foreignAclDiscovery, $foreignAclReports -Force | Out-Null
    $foreignAcl = Get-Acl -LiteralPath $foreignAclRoot
    $foreignSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-111111111-222222222-333333333-4242')
    $foreignAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($foreignSid, [Security.AccessControl.FileSystemRights]::Modify, [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo](Get-Item -LiteralPath $foreignAclRoot -Force), $foreignAcl) }
    else { ([IO.DirectoryInfo](Get-Item -LiteralPath $foreignAclRoot -Force)).SetAccessControl($foreignAcl) }
    $foreignAclError = $null
    try { New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $foreignAclRoot -DiscoveryRoot $foreignAclDiscovery -ReportsRoot $foreignAclReports | Out-Null }
    catch { $foreignAclError = $_ }
    Assert-True ($null -ne $foreignAclError -and $foreignAclError.Exception.Message -match 'fixture_acl_untrusted') 'A specific unrelated SID writer ACE was accepted.'

    $descendantRoot = Join-Path $tempRoot 'descendant-swap-root'
    $descendantDiscovery = Join-Path $descendantRoot 'discovery'
    $descendantDesktop = Join-Path $descendantDiscovery 'Desktop'
    $descendantReports = Join-Path $descendantRoot 'reports'
    $descendantOutside = Join-Path $tempRoot 'descendant-swap-outside'
    New-Item -ItemType Directory -Path $descendantDesktop, $descendantReports, $descendantOutside -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $descendantOutside 'must-remain-unchanged.txt'), 'descendant-outside', [Text.UTF8Encoding]::new($false))
    $descendantAuthority = New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $descendantRoot -DiscoveryRoot $descendantDiscovery -ReportsRoot $descendantReports
    [IO.Directory]::Delete($descendantDesktop, $false)
    New-Item -ItemType Junction -Path $descendantDesktop -Target $descendantOutside | Out-Null
    $descendantSwapError = $null
    try { & $scriptPath -Mode ScanLocal -MachineName 'DESCENDANTSWAP' -LauncherPath $descendantDesktop -NowUtc $nowUtc -OutputJson -TestFixtureAuthority $descendantAuthority | Out-Null }
    catch { $descendantSwapError = $_ }
    finally { $descendantAuthority.Dispose() }
    Assert-True ($null -ne $descendantSwapError -and $descendantSwapError.Exception.Message -match 'reparse') 'After-issuance descendant junction swap was accepted.'
    Assert-True ([IO.File]::ReadAllText((Join-Path $descendantOutside 'must-remain-unchanged.txt')) -eq 'descendant-outside') 'Descendant swap touched its outside target.'
    [IO.Directory]::Delete($descendantDesktop, $false)

    $filePinRoot = Join-Path $tempRoot 'file-pin-root'
    $filePinDiscovery = Join-Path $filePinRoot 'discovery'
    $filePinDesktop = Join-Path $filePinDiscovery 'Desktop'
    $filePinReports = Join-Path $filePinRoot 'reports'
    New-Item -ItemType Directory -Path $filePinDesktop, $filePinReports -Force | Out-Null
    $filePinPath = Join-Path $filePinDesktop 'revAgent Updater STABLE.cmd'
    [IO.File]::WriteAllText($filePinPath, '@echo off', [Text.UTF8Encoding]::new($false))
    $filePinAuthority = New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $filePinRoot -DiscoveryRoot $filePinDiscovery -ReportsRoot $filePinReports
    $filePinLease = $filePinAuthority.ConsumeDesktopLauncherDiscovery()
    $filePins = @($filePinLease.OpenLauncherFiles(@($filePinDesktop), $false, @('.cmd')))
    $fileWriteError = $null
    $fileMoveError = $null
    try { [IO.File]::WriteAllText($filePinPath, 'tampered', [Text.UTF8Encoding]::new($false)) }
    catch { $fileWriteError = $_ }
    try { Move-Item -LiteralPath $filePinPath -Destination (Join-Path $filePinDesktop 'moved.cmd') -ErrorAction Stop }
    catch { $fileMoveError = $_ }
    Assert-True ($null -ne $fileWriteError -and $null -ne $fileMoveError -and $filePins[0].ReadAllText() -eq '@echo off') 'Pinned launcher file allowed write/delete-share mutation.'
    foreach ($filePin in $filePins) { $filePin.Dispose() }
    $filePinLease.Dispose()
    $filePinAuthority.Dispose()

    $driftRoot = Join-Path $tempRoot 'file-drift-root'
    $driftDiscovery = Join-Path $driftRoot 'discovery'
    $driftDesktop = Join-Path $driftDiscovery 'Desktop'
    $driftReports = Join-Path $driftRoot 'reports'
    New-Item -ItemType Directory -Path $driftDesktop, $driftReports -Force | Out-Null
    $driftPath = Join-Path $driftDesktop 'revAgent Updater STABLE.cmd'
    [IO.File]::WriteAllText($driftPath, '@echo off', [Text.UTF8Encoding]::new($false))
    $driftAuthority = New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $driftRoot -DiscoveryRoot $driftDiscovery -ReportsRoot $driftReports
    $driftLease = $driftAuthority.ConsumeDesktopLauncherDiscovery()
    $driftFiles = @($driftLease.OpenLauncherFiles(@($driftDesktop), $false, @('.cmd')))
    $driftHandleField = $driftFiles[0].GetType().GetField('handle', [Reflection.BindingFlags]'Instance,NonPublic')
    $driftHandleField.GetValue($driftFiles[0]).Dispose()
    $driftReadError = $null
    $driftPoisonError = $null
    try { $driftFiles[0].ReadAllText() | Out-Null } catch { $driftReadError = $_ }
    try { $driftLease.GetDefaultLauncherDirectories() | Out-Null } catch { $driftPoisonError = $_ }
    Assert-True ($null -ne $driftReadError -and $null -ne $driftPoisonError -and $driftPoisonError.Exception.Message -match 'state_refused') 'Pinned read identity failure did not fail fatally and poison the authority.'
    foreach ($driftFile in $driftFiles) { $driftFile.Dispose() }
    $driftLease.Dispose()
    $driftAuthority.Dispose()
    Assert-True ($publisherText -match '(?s)catch\s*\{\s*if \(\$null -ne \$script:FixtureDiscoveryLease\) \{ throw \}') 'Fixture publisher still converts pinned read/verify failures into readWarning evidence.'

    foreach ($invalidRoot in @('relative-fixture', ('\\?\' + $tempRoot), ('\\.\' + $tempRoot), ('\\localhost\c$\fixture'), ($tempRoot + ':stream'), ($tempRoot + '\.'))) {
        $invalidPathError = $null
        try { New-RevAgentGuiLogFixtureAuthority -FixtureRoot $invalidRoot -LogDirectory $wrongPurposeLog | Out-Null }
        catch { $invalidPathError = $_ }
        Assert-True ($null -ne $invalidPathError -and $invalidPathError.Exception.Message -match 'fixture_path|noncanonical') "Alias/device/ADS path was accepted: $invalidRoot"
    }

    $substExe = Join-Path ([Environment]::SystemDirectory) 'subst.exe'
    $substDrive = @('R','S','T','U','V','W','X','Y','Z' | Where-Object { -not (Test-Path ($_.ToString() + ':\')) } | Select-Object -First 1)
    Assert-True ($substDrive.Count -eq 1 -and (Test-Path -LiteralPath $substExe -PathType Leaf)) 'No deterministic free drive letter or canonical subst.exe was available.'
    $substName = [string]$substDrive[0] + ':'
    $substFixtureRoot = Join-Path $tempRoot 'subst-fixture-root'
    $substFixtureLogs = Join-Path $substFixtureRoot 'logs'
    New-Item -ItemType Directory -Path $substFixtureLogs -Force | Out-Null
    & $substExe $substName $tempRoot | Out-Null
    Assert-Equal $LASTEXITCODE 0 'Could not create the disposable SUBST alias.'
    try {
        $substError = $null
        try { New-RevAgentGuiLogFixtureAuthority -FixtureRoot ($substName + '\subst-fixture-root') -LogDirectory ($substName + '\subst-fixture-root\logs') | Out-Null }
        catch { $substError = $_ }
        Assert-True ($null -ne $substError -and $substError.Exception.Message -match 'dos_alias') 'SUBST/DOS-device fixture alias was accepted.'
    }
    finally {
        & $substExe $substName /D | Out-Null
        Assert-Equal $LASTEXITCODE 0 'Could not remove the disposable SUBST alias.'
    }

    $missingAggregate = Invoke-FixturePublisher -FixtureRoot $tempRoot -DiscoveryRoot $fixtureSpace -FixtureReportsRoot $reportsRoot -Arguments @{
        Mode='Aggregate'; ExpectedMachines=@('NET01','EMIN','OLD'); OutOfScopeMachines=@('OLD'); NowUtc=$nowUtc.AddMinutes(2); OutputJson=$true
    } | ConvertFrom-Json

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

    $passedAggregate = Invoke-FixturePublisher -FixtureRoot $tempRoot -DiscoveryRoot $fixtureSpace -FixtureReportsRoot $reportsRoot -Arguments @{
        Mode='Aggregate'; ExpectedMachines=@('NET01','EMIN','OLD'); OutOfScopeMachines=@('OLD'); NowUtc=$nowUtc.AddMinutes(4); OutputJson=$true
    } | ConvertFrom-Json

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
$global:LASTEXITCODE = 0
