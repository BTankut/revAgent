<#
.SYNOPSIS
    Verify OS-root and secure-temp trust boundaries under poisoned process state.

.DESCRIPTION
    The updater crosses a UAC boundary and must not derive machine paths from
    inherited, user-controlled environment variables. These tests run without
    elevation and combine executable fixtures, poisoned process variables, and
    source-order assertions so the elevated path cannot silently regress to
    environment-derived roots or a user TEMP/TMP directory.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
. (Join-Path $RepoRoot 'scripts\test-desktop-launcher-evidence.ps1') -RepoRoot $RepoRoot -LibraryOnly
Set-StrictMode -Off
$fixtureExpectedHostSha256 = '9305492a80f2ef82f8ceae9ac2ec3fb1dc5b6f686f46555253c385a2034a49f7'
$fixtureExpectedModuleSha256 = 'b21d81ae3ad015b82535ce449454b89ad5cc2fc1d8c9cd0a47820c4a5d6293cc'
$fixtureExpectedGuiSha256 = '2d92fc06fd192789420d6ec630d35548a835762e823c3a27998e9e0d35b4e2b2'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param([object]$Actual, [object]$Expected, [string]$Message)
    if ($Actual -ne $Expected) { throw "$Message Expected '$Expected', got '$Actual'." }
}

function Assert-ThrowsLike {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $caught = $null
    try { & $Action }
    catch { $caught = $_ }
    if ($null -eq $caught) { throw "$Message Expected an exception." }
    if (-not ([string]$caught.Exception.Message -match $Pattern)) {
        throw "$Message Unexpected exception: $($caught.Exception.Message)"
    }
}

function Get-Text {
    param([string]$RelativePath)
    return [IO.File]::ReadAllText((Join-Path $RepoRoot $RelativePath))
}

function Get-FunctionAssignmentValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$FunctionName,
        [Parameter(Mandatory = $true)][string]$VariableName
    )

    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$parseErrors)
    Assert-Equal @($parseErrors).Count 0 "Production ACL guard did not parse: $Path"
    $expectedLeft = '$' + $VariableName
    $assignments = @($ast.FindAll({
                param($node)
                if ($node -isnot [Management.Automation.Language.AssignmentStatementAst] -or
                    -not [string]::Equals($node.Left.Extent.Text, $expectedLeft, [StringComparison]::OrdinalIgnoreCase)) {
                    return $false
                }
                $cursor = $node.Parent
                while ($null -ne $cursor) {
                    if ($cursor -is [Management.Automation.Language.FunctionDefinitionAst]) {
                        return [string]::Equals($cursor.Name, $FunctionName, [StringComparison]::Ordinal)
                    }
                    $cursor = $cursor.Parent
                }
                return $false
            }, $true))
    Assert-Equal $assignments.Count 1 "Expected one $expectedLeft assignment in function $FunctionName."
    return & ([scriptblock]::Create($assignments[0].Right.Extent.Text))
}

function Invoke-ExtractedRightsPredicate {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$FunctionName,
        [Parameter(Mandatory = $true)][Security.AccessControl.FileSystemRights]$Rights
    )

    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$parseErrors)
    Assert-Equal @($parseErrors).Count 0 "Production ACL predicate did not parse: $Path"
    $functions = @($ast.FindAll({
                param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
                [string]::Equals($node.Name, $FunctionName, [StringComparison]::Ordinal)
            }, $true))
    Assert-Equal $functions.Count 1 "Expected one production ACL predicate named $FunctionName."
    $invokeText = $functions[0].Extent.Text + "`n" + $FunctionName + ' -Rights ([Security.AccessControl.FileSystemRights][int64]$args[0])'
    return [bool](& ([scriptblock]::Create($invokeText)) ([int64]$Rights))
}

function Assert-OrderedText {
    param(
        [string]$Text,
        [string]$Earlier,
        [string]$Later,
        [string]$Message
    )
    $earlierIndex = $Text.IndexOf($Earlier, [StringComparison]::OrdinalIgnoreCase)
    $laterIndex = $Text.IndexOf($Later, [StringComparison]::OrdinalIgnoreCase)
    if ($earlierIndex -lt 0 -or $laterIndex -lt 0 -or $earlierIndex -ge $laterIndex) {
        throw "$Message earlier='$Earlier' later='$Later'"
    }
}

function Import-ScriptFunctionForTest {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$FunctionName
    )

    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$parseErrors)
    Assert-Equal @($parseErrors).Count 0 "PowerShell parse errors found in $Path."
    $functions = @($ast.FindAll({
                param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
                [string]::Equals($node.Name, $FunctionName, [StringComparison]::OrdinalIgnoreCase)
            }, $true) | Select-Object -First 1)
    Assert-Equal $functions.Count 1 "Function '$FunctionName' was not found exactly once in $Path."
    return [scriptblock]::Create([string]$functions[0].Extent.Text)
}

$systemDirectory = [Environment]::SystemDirectory
$canonicalProgramData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$canonicalProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$canonicalInstallRoot = Join-Path $canonicalProgramData "DPE\revAgent"
$guiPath = Join-Path $RepoRoot "installer\nas\Install-revAgent-Updater-GUI.ps1"
$guiTestHost = Join-Path $RepoRoot 'scripts\Invoke-RevAgentUpdaterGuiTestHost.ps1'
$windowsPowerShellPath = Join-Path $systemDirectory 'WindowsPowerShell\v1.0\powershell.exe'
$channelFixture = Join-Path $RepoRoot "README.md"
$codexModulePath = Join-Path $RepoRoot "installer\lib\RevAgent.CodexRegistration.psm1"
$secureTempModulePath = Join-Path $RepoRoot "installer\lib\RevAgent.SecureTemp.psm1"
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("revagent-os-path-security-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
$script:GuiLogSequence = 0
$script:GuiFixtureRoots = @{}
function New-GuiFixtureLogRoot {
    $script:GuiLogSequence++
    $root = Join-Path $tempRoot ('gui-case-{0}' -f $script:GuiLogSequence)
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    Protect-FixtureRoot -Path $root
    $bundle = Join-Path $root 'trusted-bundle'
    $path = Join-Path $root 'logs'
    New-Item -ItemType Directory -Path $bundle, $path -Force | Out-Null
    Copy-RevAgentTrustedFixtureFile $guiTestHost (Join-Path $bundle (Split-Path -Leaf $guiTestHost)) $fixtureExpectedHostSha256
    Copy-RevAgentTrustedFixtureFile (Join-Path $RepoRoot 'scripts\RevAgent.TestFixtureAuthority.psm1') (Join-Path $bundle 'RevAgent.TestFixtureAuthority.psm1') $fixtureExpectedModuleSha256
    Copy-RevAgentTrustedFixtureFile $guiPath (Join-Path $bundle (Split-Path -Leaf $guiPath)) $fixtureExpectedGuiSha256
    $installTaskSource = Join-Path (Split-Path -Parent $guiPath) 'install-updater-task.ps1'
    Copy-RevAgentTrustedFixtureFile $installTaskSource (Join-Path $bundle 'install-updater-task.ps1') ((Get-FileHash -LiteralPath $installTaskSource -Algorithm SHA256).Hash)
    $script:GuiFixtureRoots[$path] = $root
    return $path
}

function Invoke-GuiFixtureChild {
    param(
        [Parameter(Mandatory = $true)][string]$LogDirectory,
        [hashtable]$HostArguments = @{},
        [hashtable]$EnvironmentOverrides = @{},
        [string]$ConsumerOverride = ''
    )
    $root = [string]$script:GuiFixtureRoots[$LogDirectory]
    if ([string]::IsNullOrWhiteSpace($root)) { throw 'fixture_gui_case_root_missing' }
    $bundle = Join-Path $root 'trusted-bundle'
    $selectedHost = Join-Path $bundle (Split-Path -Leaf $guiTestHost)
    $consumer = if ([string]::IsNullOrWhiteSpace($ConsumerOverride)) { Join-Path $bundle (Split-Path -Leaf $guiPath) } else { $ConsumerOverride }
    $arguments = @{ LogDirectory = $LogDirectory }
    foreach ($key in $HostArguments.Keys) { $arguments[$key] = $HostArguments[$key] }
    $result = @(Invoke-CleanFixtureHost -Operation Gui -ConsumerPath $consumer -FixtureRoot $root -HostArguments $arguments -EnvironmentOverrides $EnvironmentOverrides -SelectedHostPath $selectedHost -ExpectedHostLiteralSha256 $fixtureExpectedHostSha256 -ExpectedModuleLiteralSha256 $fixtureExpectedModuleSha256 -ExpectedConsumerLiteralSha256 $fixtureExpectedGuiSha256)
    return $result[-1]
}

$poisonNames = @(
    "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "CommonProgramFiles",
    "CommonProgramFiles(x86)", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemDrive", "OS"
)
$savedEnvironment = @{}
foreach ($name in $poisonNames + @("WINDIR", "SystemRoot", "TEMP", "TMP", "PATH", "PSModulePath")) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
$savedEnvironment["PSModulePath"] = [Environment]::GetEnvironmentVariable("PSModulePath", "Process")

try {
    Write-Host "Test SpecialFolder/SystemDirectory roots ignore inherited environment poisoning"
    $poisonRoot = Join-Path $tempRoot "poison"
    foreach ($name in $poisonNames) {
        [Environment]::SetEnvironmentVariable($name, (Join-Path $poisonRoot ($name -replace '[^A-Za-z0-9]', '_')), "Process")
    }
    $env:OS = "not-windows"

    Assert-Equal ([Environment]::SystemDirectory) $systemDirectory "SystemDirectory changed after environment poisoning."
    Assert-Equal ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) $canonicalProgramFiles "Program Files Known Folder changed after environment poisoning."
    Assert-Equal ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) $canonicalProgramData "ProgramData Known Folder changed after environment poisoning."
    foreach ($name in $poisonNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }

    $cleanGuiLogDirectory = New-GuiFixtureLogRoot
    $cleanGuiResult = Invoke-GuiFixtureChild -LogDirectory $cleanGuiLogDirectory -HostArguments @{ ChannelManifestPath = $channelFixture; SmokeTest = $true }
    Assert-True ($cleanGuiResult.state -eq 'COMPLETED' -and $cleanGuiResult.exitCode -eq 0) "GUI clean child failed: $($cleanGuiResult.stderr)"
    $cleanGuiOutput = $cleanGuiResult.stdout + $cleanGuiResult.stderr
    Assert-True ($cleanGuiOutput -match [regex]::Escape("Install  : $canonicalInstallRoot")) "GUI clean copied-pair smoke lost the canonical ProgramData install root. Output: $cleanGuiOutput"

    $guiLogDirectory = New-GuiFixtureLogRoot
    $machinePoison = @{}
    foreach ($name in $poisonNames) { $machinePoison[$name] = Join-Path $poisonRoot ($name -replace '[^A-Za-z0-9]', '_') }
    $machinePoison.OS = 'not-windows'
    $guiResult = Invoke-GuiFixtureChild -LogDirectory $guiLogDirectory -HostArguments @{ ChannelManifestPath = $channelFixture; SmokeTest = $true } -EnvironmentOverrides $machinePoison
    Assert-True ($guiResult.state -eq 'COMPLETED' -and $guiResult.exitCode -ne 0 -and $guiResult.stderr -match 'fixture_host_environment_refused') "Inherited machine-root poison was not refused before the consumer: $($guiResult.stderr)"
    $guiOutput = $guiResult.stdout + $guiResult.stderr
    Assert-True ($guiOutput -notmatch 'GUI smoke test OK|Install\s+:' -and @(Get-ChildItem -LiteralPath $guiLogDirectory -Filter 'gui-startup-*.log' -File).Count -eq 0) "Poison child invoked the GUI or created a log. Output: $guiOutput"
    $guiSource = Get-Content -Raw -LiteralPath $guiPath
    Assert-True ($guiSource -match '\$localAppDataRoot = \[Environment\]::GetFolderPath\(\[Environment\+SpecialFolder\]::LocalApplicationData\)' -and $guiSource -match '\[void\]\[IO\.Directory\]::CreateDirectory\(\$logDirectory\)' -and $guiSource -match '\[IO\.File\]::WriteAllLines' -and $guiSource -match 'Add-Type -AssemblyName System\.Windows\.Forms' -and $guiSource -match 'Get-RevAgentTestFixtureOwnership' -and $guiSource -notmatch ('TestStartupFailureLog' + 'Root|TestFixtureAuthority' + 'Path')) "GUI must preserve production LocalApplicationData/CreateDirectory/WriteAllLines/Add-Type behavior and accept only exact module-owned authority provenance."
    $guiLogDirectory = New-GuiFixtureLogRoot
    $guiLogsBefore = @{}
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $global:LASTEXITCODE = 0
        $invalidInstallRootResult = Invoke-GuiFixtureChild -LogDirectory $guiLogDirectory -HostArguments @{ ChannelManifestPath = $channelFixture; InstallRoot = (Join-Path $poisonRoot 'DPE\revAgent'); SmokeTest = $true }
        $invalidInstallRootOutput = @($invalidInstallRootResult.stdout, $invalidInstallRootResult.stderr)
        $invalidInstallRootExitCode = $invalidInstallRootResult.exitCode
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    $newGuiLogs = @(Get-ChildItem -LiteralPath $guiLogDirectory -Filter 'gui-startup-*.log' -File | Where-Object { -not $guiLogsBefore.ContainsKey($_.FullName) })
    Assert-True ($invalidInstallRootExitCode -ne 0) "GUI accepted an environment-poisoned InstallRoot."
    Assert-Equal $newGuiLogs.Count 1 "GUI rejected an environment-poisoned InstallRoot without exactly one startup diagnostic log."
    $invalidInstallRootLog = Get-Content -Raw -LiteralPath $newGuiLogs[0].FullName
    Assert-True ($invalidInstallRootLog -match 'InstallRoot must be the canonical revAgent machine root') "GUI startup log did not preserve the poisoned InstallRoot rejection reason."
    Remove-Item -LiteralPath $newGuiLogs[0].FullName -Force

    Write-Host "Test GUI rejects a malformed authority without touching LocalAppData"
    $malformedLogRoot = New-GuiFixtureLogRoot
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $outsideTestLogResult = Invoke-GuiFixtureChild -LogDirectory $malformedLogRoot -HostArguments @{ AuthorityMode = 'Malformed'; TestStartupFailureMessage = 'malformed-authority' }
        $outsideTestLogOutput = @($outsideTestLogResult.stdout, $outsideTestLogResult.stderr)
        $outsideTestLogExitCode = $outsideTestLogResult.exitCode
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    Assert-True ($outsideTestLogExitCode -ne 0 -and ((@($outsideTestLogOutput) -join ' | ') -match 'authority.*refused')) "GUI accepted a malformed authority or lost its stable rejection reason: $(@($outsideTestLogOutput) -join ' | ')"
    Assert-True (@(Get-ChildItem -LiteralPath $malformedLogRoot -Filter 'gui-startup-*.log' -File).Count -eq 0) 'Malformed authority caused a fixture or LocalAppData log claim.'

    Write-Host 'Test GUI rejects a missing authority before production logging'
    $missingAuthorityLogRoot = New-GuiFixtureLogRoot
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $missingAuthorityResult = Invoke-GuiFixtureChild -LogDirectory $missingAuthorityLogRoot -HostArguments @{ AuthorityMode = 'Missing'; TestStartupFailureMessage = 'missing-authority' }
        $missingAuthorityOutput = @($missingAuthorityResult.stdout, $missingAuthorityResult.stderr)
        $missingAuthorityExitCode = $missingAuthorityResult.exitCode
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    Assert-True ($missingAuthorityExitCode -ne 0 -and ((@($missingAuthorityOutput) -join ' | ') -match 'authority_required')) 'GUI accepted a missing authority or entered the production logger.'
    Assert-Equal (@(Get-ChildItem -LiteralPath $missingAuthorityLogRoot -Filter 'gui-startup-*.log' -File).Count) 0 'Missing authority created a fixture log.'

    Write-Host 'Append truthful global-fixture LocalAppData incident history'
    $incidentRoot = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData), 'DPE', 'revAgent', 'audit')
    [void][IO.Directory]::CreateDirectory($incidentRoot)
    $incidentPath = [IO.Path]::Combine($incidentRoot, 'global-fixture-isolation-incidents.jsonl')
    $priorIncidentBytes = if ([IO.File]::Exists($incidentPath)) { [IO.File]::ReadAllBytes($incidentPath) } else { [byte[]]@() }
    Assert-True ($priorIncidentBytes.Length -le 1048576) 'Global-fixture incident history exceeded its bounded audit size.'
    $incidentRecord = [ordered]@{
        schema = 'revagent.global-fixture-isolation-incident/v1'
        eventId = [Guid]::NewGuid().ToString('D')
        recordedAtUtc = [DateTime]::UtcNow.ToString('o')
        designSha256 = 'c6124febf2a04e291440060b1bbbfd69efb98ee6eeb572b2e5d6410ef98e3ee8'
        sourceAnchor = 'f8a20fb11d2d3ea4ef566b28cdfdeaf77aa76e3e'
        historicalPreliminaryMissingAuthorityLogsCreated = 2
        historicalPreliminaryMissingAuthorityLogsRemoved = 2
        currentMissingAuthorityFixtureLogsCreated = 0
        priorWriterPassSupersededBySecurityFailure = $true
        authoritative = $false
        disposition = 'append_only_incident_truth_preserved'
    }
    $incidentLine = ($incidentRecord | ConvertTo-Json -Compress -Depth 5) + [Environment]::NewLine
    $incidentBytes = [Text.UTF8Encoding]::new($false).GetBytes($incidentLine)
    $incidentStream = [IO.File]::Open($incidentPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $incidentStream.Write($incidentBytes, 0, $incidentBytes.Length); $incidentStream.Flush($true) }
    finally { $incidentStream.Dispose() }
    $currentIncidentBytes = [IO.File]::ReadAllBytes($incidentPath)
    Assert-True ($currentIncidentBytes.Length -eq $priorIncidentBytes.Length + $incidentBytes.Length) 'Incident record was not appended exactly once.'
    for ($incidentIndex = 0; $incidentIndex -lt $priorIncidentBytes.Length; $incidentIndex++) { if ($currentIncidentBytes[$incidentIndex] -ne $priorIncidentBytes[$incidentIndex]) { throw 'Existing incident history was rewritten.' } }

    Write-Host 'Test GUI CREATE_NEW refuses a pre-existing target without clobbering it'
    $existingTargetLogRoot = New-GuiFixtureLogRoot
    $existingTargetPath = Join-Path $existingTargetLogRoot 'gui-startup-existing-target.log'
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $existingTargetResult = Invoke-GuiFixtureChild -LogDirectory $existingTargetLogRoot -HostArguments @{ AuthorityMode = 'ExistingTarget'; TestStartupFailureMessage = 'existing-target' }
        $existingTargetOutput = @($existingTargetResult.stdout, $existingTargetResult.stderr)
        $existingTargetExitCode = $existingTargetResult.exitCode
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    Assert-True ($existingTargetExitCode -ne 0 -and ((@($existingTargetOutput) -join ' | ') -match 'fixture_file_create_new_failed')) 'GUI did not expose the exclusive create-new collision refusal.'
    Assert-Equal ([IO.File]::ReadAllText($existingTargetPath)) 'must-remain-unchanged' 'GUI clobbered or read-rewrote the pre-existing log target.'
    Assert-Equal (@(Get-ChildItem -LiteralPath $existingTargetLogRoot -Filter 'gui-startup-*.log' -File).Count) 1 'GUI created a second log after the forced collision.'

    Write-Host "Test GUI startup-log seam rejects a swapped junction root without writing it"
    $outsideLogTarget = Join-Path $tempRoot 'outside-log-target'
    $swappedLogRoot = New-GuiFixtureLogRoot
    New-Item -ItemType Directory -Path $outsideLogTarget -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $outsideLogTarget 'must-remain-unchanged.txt'), 'outside-log-target', [Text.UTF8Encoding]::new($false))
    [IO.Directory]::Delete($swappedLogRoot, $false)
    New-Item -ItemType Junction -Path $swappedLogRoot -Target $outsideLogTarget | Out-Null
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $swappedLogResult = Invoke-GuiFixtureChild -LogDirectory $swappedLogRoot -HostArguments @{ TestStartupFailureMessage = 'swapped-log-root' }
        $swappedLogOutput = @($swappedLogResult.stdout, $swappedLogResult.stderr)
        $swappedLogExitCode = $swappedLogResult.exitCode
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    Assert-True ($swappedLogExitCode -ne 0 -and ((@($swappedLogOutput) -join ' | ') -match 'reparse')) "GUI startup-log authority accepted a swapped fixture junction."
    Assert-True ([IO.File]::ReadAllText((Join-Path $outsideLogTarget 'must-remain-unchanged.txt')) -eq 'outside-log-target') "GUI startup-log seam wrote through the swapped junction target."
    Assert-True (@(Get-ChildItem -LiteralPath $outsideLogTarget -Filter 'gui-startup-*.log' -File).Count -eq 0) "GUI startup-log seam created a log through the swapped junction target."
    [IO.Directory]::Delete($swappedLogRoot, $false)

    Write-Host "Test copied GUI fails canonical-origin guard before bootstrap-selected module import"
    $copiedGuiRoot = Join-Path $tempRoot "copied-gui"
    $copiedGuiPath = Join-Path $copiedGuiRoot "Install-revAgent-Updater-GUI.ps1"
    $copiedStatePath = Join-Path $copiedGuiRoot "bootstrap-state.json"
    $copiedPoisonModule = Join-Path $copiedGuiRoot "poison-source-free.psm1"
    $copiedPoisonMarker = Join-Path $tempRoot "copied-gui-module-loaded.txt"
    New-Item -ItemType Directory -Path $copiedGuiRoot -Force | Out-Null
    Protect-FixtureRoot -Path $copiedGuiRoot
    Copy-Item -LiteralPath $guiPath -Destination $copiedGuiPath -Force
    [IO.File]::WriteAllText($copiedPoisonModule, '[IO.File]::WriteAllText($env:REVAGENT_GUI_PREIMPORT_MARKER, "loaded")', [Text.UTF8Encoding]::new($false))
    $poisonHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $copiedPoisonModule).Hash
    [IO.File]::WriteAllText($copiedStatePath, (@{
                sourceAuthentication = @{ independentlyAuthenticated = $true; operatorConfirmed = $true }
                files = @{
                    updaterGui = @{ relativePath = 'Install-revAgent-Updater-GUI.ps1'; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $copiedGuiPath).Hash }
                    sourceFreeMigration = @{ relativePath = 'poison-source-free.psm1'; sha256 = $poisonHash }
                }
            } | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $env:REVAGENT_GUI_PREIMPORT_MARKER = $copiedPoisonMarker
    $guiLogDirectory = New-GuiFixtureLogRoot
    $copiedGuiLogsBefore = @{}
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $copiedGuiResult = Invoke-GuiFixtureChild -LogDirectory $guiLogDirectory -ConsumerOverride $copiedGuiPath -HostArguments @{ ChannelManifestPath = $channelFixture; BootstrapStatePath = $copiedStatePath; SuppressStartupFailureDialogForTest = $true }
        $copiedGuiOutput = @($copiedGuiResult.stdout, $copiedGuiResult.stderr)
        $copiedGuiExitCode = $copiedGuiResult.exitCode
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    $newCopiedGuiLogs = @(Get-ChildItem -LiteralPath $guiLogDirectory -Filter 'gui-startup-*.log' -File | Where-Object { -not $copiedGuiLogsBefore.ContainsKey($_.FullName) })
    Assert-True ($copiedGuiExitCode -ne 0) "Copied GUI did not fail before loading its attacker-selected module."
    Assert-Equal $newCopiedGuiLogs.Count 1 "Copied GUI canonical-origin rejection did not create exactly one startup diagnostic log."
    $copiedGuiLog = Get-Content -Raw -LiteralPath $newCopiedGuiLogs[0].FullName
    Assert-True ($copiedGuiLog -match 'protected local bootstrap before module import') "Copied GUI startup log did not preserve the canonical-origin rejection reason."
    Remove-Item -LiteralPath $newCopiedGuiLogs[0].FullName -Force
    Assert-True (-not (Test-Path -LiteralPath $copiedPoisonMarker)) "Copied GUI executed a bootstrap-selected module before canonical-origin rejection."
    Remove-Item Env:\REVAGENT_GUI_PREIMPORT_MARKER -ErrorAction SilentlyContinue

    Remove-Module RevAgent.CodexRegistration -Force -ErrorAction SilentlyContinue
    Import-Module $codexModulePath -Force
    $elevationBefore = Test-RevAgentProcessElevated
    $env:OS = "definitely-not-windows"
    Assert-Equal (Test-RevAgentProcessElevated) $elevationBefore "Elevation detection must not depend on the OS environment variable."

    Write-Host "Test a copied signed Node under poisoned ProgramFiles is audited but never executed"
    $canonicalNode = Join-Path $canonicalProgramFiles "nodejs\node.exe"
    Assert-True (Test-Path -LiteralPath $canonicalNode -PathType Leaf) "The canonical Program Files Node runtime is required for this security fixture."
    $poisonedNode = Join-Path $poisonRoot "ProgramFiles\nodejs\node.exe"
    New-Item -ItemType Directory -Path (Split-Path -Parent $poisonedNode) -Force | Out-Null
    Copy-Item -LiteralPath $canonicalNode -Destination $poisonedNode -Force
    $nodeResolution = Resolve-RevAgentNodeRuntime -ExplicitPath $poisonedNode
    $poisonedCandidate = @($nodeResolution.candidates | Where-Object {
            [string]::Equals([string]$_.path, $poisonedNode, [StringComparison]::OrdinalIgnoreCase)
        }) | Select-Object -First 1
    Assert-True ($null -ne $poisonedCandidate) "Poisoned copied-Node fixture was not audited."
    Assert-True (-not [bool]$poisonedCandidate.systemManaged -and -not [bool]$poisonedCandidate.ready) "A signed executable under a poisoned ProgramFiles variable became executable/ready."
    Assert-Equal $poisonedCandidate.versionProbeExitCode -1 "Poisoned Node must not receive a version execution probe."
    Assert-True ([bool]$nodeResolution.selected.systemManaged) "Selected Node must remain system managed."
    Assert-True ([string]$nodeResolution.selected.path -notmatch [regex]::Escape($poisonRoot)) "Selected Node came from the poisoned root."

    Write-Host "Test WINDIR/SystemRoot poisoning fails closed without redirecting the canonical host path"
    $fakeWindows = Join-Path $poisonRoot "Windows"
    [Environment]::SetEnvironmentVariable('WINDIR', $fakeWindows, 'Process')
    [Environment]::SetEnvironmentVariable('SystemRoot', $fakeWindows, 'Process')
    Assert-Equal ([Environment]::SystemDirectory) $systemDirectory 'SystemDirectory changed after WINDIR/SystemRoot poisoning.'
    [Environment]::SetEnvironmentVariable('WINDIR', $savedEnvironment['WINDIR'], 'Process')
    [Environment]::SetEnvironmentVariable('SystemRoot', $savedEnvironment['SystemRoot'], 'Process')
    $guiLogDirectory = New-GuiFixtureLogRoot
    $rootPoisonLogsBefore = @{}
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $rootPoisonResult = Invoke-GuiFixtureChild -LogDirectory $guiLogDirectory -HostArguments @{ ChannelManifestPath = $channelFixture; SmokeTest = $true } -EnvironmentOverrides @{ WINDIR = $fakeWindows; SystemRoot = $fakeWindows }
        $rootPoisonOutput = @($rootPoisonResult.stdout, $rootPoisonResult.stderr)
        $rootPoisonExitCode = $rootPoisonResult.exitCode
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    $newRootPoisonLogs = @(Get-ChildItem -LiteralPath $guiLogDirectory -Filter 'gui-startup-*.log' -File | Where-Object { -not $rootPoisonLogsBefore.ContainsKey($_.FullName) })
    $rootPoisonText = @($rootPoisonOutput) -join ' | '
    Assert-True ($rootPoisonExitCode -ne 0) 'WINDIR/SystemRoot-poisoned GUI host unexpectedly succeeded.'
    Assert-Equal $newRootPoisonLogs.Count 0 'WINDIR/SystemRoot poisoning claimed a startup log after the provider failed closed.'
    Assert-True (-not [string]::IsNullOrWhiteSpace($rootPoisonText) -and $rootPoisonText -notmatch 'Diagnostic log:' -and $rootPoisonText -notmatch [regex]::Escape($fakeWindows) -and $rootPoisonText -notmatch '\\DPE\\revAgent\\logs') 'WINDIR/SystemRoot poisoning redirected GUI startup or disclosed a non-fixture log path.'

    Write-Host "Test secure machine TEMP/TMP contract and pre-import ordering"
    Remove-Module RevAgent.SecureTemp -Force -ErrorAction SilentlyContinue
    Import-Module $secureTempModulePath -Force
    $userTemp = Join-Path $tempRoot "user-temp\revAgent-elevated-attacker"
    New-Item -ItemType Directory -Path $userTemp -Force | Out-Null
    Assert-True (-not (Test-RevAgentSecureMachineTempPath -Path $userTemp)) "User-writable TEMP fixture passed the machine-temp trust predicate."
    if (-not (Test-RevitMcpSecureTempAdministrator)) {
        Assert-ThrowsLike -Action { Initialize-RevAgentSecureMachineTemp | Out-Null } -Pattern "requires an elevated process" -Message "Unelevated secure machine-temp initialization must fail closed."
    }

    $entrypoints = @(
        [pscustomobject]@{ Path = "installer\nas\update-from-nas.ps1"; Root = '$nasLibRoot' },
        [pscustomobject]@{ Path = "installer\nas\install-updater-task.ps1"; Root = '$nasLibRoot' },
        [pscustomobject]@{ Path = "installer\install-self-contained.ps1"; Root = '$installerLibRoot'; Protected = $true }
    )
    foreach ($entrypoint in $entrypoints) {
        $text = Get-Text $entrypoint.Path
        $importCommand = if ([bool]$entrypoint.Protected) { 'Import-RevAgentProtectedInstallerModule -Path (Join-Path ' } else { 'Import-Module (Join-Path ' }
        $secureImport = $importCommand + $entrypoint.Root + ' "RevAgent.SecureTemp.psm1")'
        $permissionsImport = $importCommand + $entrypoint.Root + ' "RevAgent.Permissions.psm1")'
        Assert-OrderedText -Text $text -Earlier $secureImport -Later $permissionsImport -Message "$($entrypoint.Path) must import SecureTemp before the Add-Type permissions module."
        Assert-OrderedText -Text $text -Earlier "Initialize-RevAgentSecureMachineTemp" -Later $permissionsImport -Message "$($entrypoint.Path) must initialize secure TEMP/TMP before importing permissions code."
    }
    $secureTempText = Get-Text "installer\lib\RevAgent.SecureTemp.psm1"
    Assert-True ($secureTempText -notmatch '(?im)^\s*Add-Type\b') "SecureTemp must remain a pure pre-Add-Type bootstrap module."

    Write-Host "Test elevated canonical Revit add-in path rejects reparse components"
    $selfContainedPath = Join-Path $RepoRoot "installer\install-self-contained.ps1"
    $safeAddinAncestor = Join-Path $tempRoot "safe-addin-ancestor"
    $outsideAddinTarget = Join-Path $tempRoot "outside-addin-target"
    New-Item -ItemType Directory -Path $safeAddinAncestor, $outsideAddinTarget -Force | Out-Null
    $safeMissingAddinPath = Join-Path $safeAddinAncestor "Autodesk\Revit\Addins\2022"
    $safeAddinOutput = (& $selfContainedPath -AddinPathSecuritySmokeTest $safeMissingAddinPath 6>&1 | Out-String)
    Assert-True ($safeAddinOutput -match '"action":"addin-path-security-smoke-test"') "Safe missing add-in path did not pass the read-only link check. Output: $safeAddinOutput"
    Assert-True (-not (Test-Path -LiteralPath $safeMissingAddinPath)) "Read-only add-in path smoke test created the missing destination."

    $addinJunction = Join-Path $safeAddinAncestor "redirected-addins"
    New-Item -ItemType Junction -Path $addinJunction -Target $outsideAddinTarget | Out-Null
    Assert-ThrowsLike -Action {
        & $selfContainedPath -AddinPathSecuritySmokeTest (Join-Path $addinJunction "2022") | Out-Null
    } -Pattern "reparse point or filesystem link" -Message "Canonical add-in destination must reject a planted parent junction."
    [System.IO.Directory]::Delete($addinJunction, $false)
    Assert-True (Test-Path -LiteralPath $outsideAddinTarget -PathType Container) "Add-in junction rejection damaged its external target."

    $selfContainedText = Get-Text "installer\install-self-contained.ps1"
    Assert-OrderedText -Text $selfContainedText -Earlier "Assert-RevAgentCanonicalAddinPathLinkSafe -Path `$addinRoot" -Later "Repair-RevAgentManagedInstallPermissions -IncludeExistingPayloadTrees" -Message "Self-contained installer must reject add-in reparse components before its first managed permission mutation."
    Assert-True ($selfContainedText -match '(?s)Invoke-RevAgentManagedPermissionRepair -Targets \$targets.*Assert-RevAgentCanonicalAddinPathLinkSafe -Path \$addinRoot') "Self-contained installer must revalidate the canonical add-in path after permission-driven creation."
    Assert-OrderedText -Text $selfContainedText -Earlier "Protect-RevAgentCanonicalAddinSurface" -Later "Invoke-RevAgentCleanup -ForUninstall:`$Uninstall" -Message "Self-contained installer must protect the shared Addins parent/year boundary before cleanup or manifest writes."
    Assert-OrderedText -Text $selfContainedText -Earlier "Write-AddinManifest -Path (Join-Path `$addinRoot `$addinManifestFileName)" -Later '-ProtectManifest `' -Message "Self-contained installer must protect the exact revAgent.addin file after writing it."
    Assert-True ($selfContainedText -match '(?s)Write-AddinManifest -Path \(Join-Path \$addinRoot \$addinManifestFileName\).*?-ProtectManifest\s+`.*?Assert-RevAgentCanonicalAddinManifestContent') "Self-contained installer must attest canonical manifest bytes/identity after ACL protection."
    Assert-True ($selfContainedText -match '(?s)if \(\$SkipRevitPayloadInstall\).*?Protect-RevAgentCanonicalAddinSurface.*?-ProtectManifestIfPresent') "An unchanged Revit payload must still rebaseline and attest an existing canonical manifest without rewriting it."
    Assert-True ($selfContainedText -notmatch '(?s)Get-RevAgentManagedPermissionTargets\s+`.*?-AllUsersAddinRoot') "Self-contained installer must not route the Autodesk Addins surface through generic grant-based permission repair."

    Write-Host "Test canonical Revit add-in ACL replacement and attestation without ProgramData mutation"
    $permissionsModulePath = Join-Path $RepoRoot "installer\lib\RevAgent.Permissions.psm1"
    Remove-Module RevAgent.Permissions -Force -ErrorAction SilentlyContinue
    $permissionsModule = Import-Module $permissionsModulePath -Force -PassThru
    $aclContract = & $permissionsModule {
        $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
        $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
        $usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
        $allow = [Security.AccessControl.AccessControlType]::Allow

        # Reproduce the live regression independently of ProgramData: protected
        # shape and trusted owner, but BUILTIN\Users still has FullControl.
        $unsafe = [Security.AccessControl.DirectorySecurity]::new()
        $unsafe.SetAccessRuleProtection($true, $false)
        $unsafe.SetOwner($administratorsSid)
        $unsafe.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, $allow))
        $unsafe.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($administratorsSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, $allow))
        $unsafe.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($usersSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, $allow))
        $unsafeBlocked = $false
        try {
            Assert-RevitMcpProtectedAddinAcl -Acl $unsafe -Path 'users-full-control-fixture' -Kind Directory | Out-Null
        }
        catch {
            $unsafeBlocked = ($_.Exception.Message -match 'rights mismatch')
        }

        $safeDirectory = New-RevitMcpProtectedAddinAcl -Kind Directory
        $safeFile = New-RevitMcpProtectedAddinAcl -Kind File
        [void](Assert-RevitMcpProtectedAddinAcl -Acl $safeDirectory -Path 'safe-directory-fixture' -Kind Directory)
        [void](Assert-RevitMcpProtectedAddinAcl -Acl $safeFile -Path 'safe-file-fixture' -Kind File)
        $canonicalRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'Autodesk\Revit\Addins\2022'
        $paths = Get-RevitMcpCanonicalAddinSurfacePaths -AddinRoot $canonicalRoot -RevitVersion '2022'
        $offRootBlocked = $false
        try {
            Get-RevitMcpCanonicalAddinSurfacePaths -AddinRoot (Join-Path ([IO.Path]::GetTempPath()) 'Autodesk\Revit\Addins\2022') -RevitVersion '2022' | Out-Null
        }
        catch {
            $offRootBlocked = ($_.Exception.Message -match 'only the canonical ProgramData year root')
        }

        [pscustomobject][ordered]@{
            UnsafeUsersFullControlBlocked = $unsafeBlocked
            SafeDirectoryProtected = [bool]$safeDirectory.AreAccessRulesProtected
            SafeFileProtected = [bool]$safeFile.AreAccessRulesProtected
            CanonicalAddinRoot = [string]$paths.AddinRoot
            CanonicalManifestPath = [string]$paths.ManifestPath
            OffRootBlocked = $offRootBlocked
        }
    }
    Assert-True ([bool]$aclContract.UnsafeUsersFullControlBlocked) "Canonical add-in ACL attestation accepted the live BUILTIN\Users FullControl regression."
    Assert-True ([bool]$aclContract.SafeDirectoryProtected -and [bool]$aclContract.SafeFileProtected) "Canonical add-in directory/file descriptors must have protected DACLs."
    Assert-Equal ([string]$aclContract.CanonicalAddinRoot) (Join-Path $canonicalProgramData 'Autodesk\Revit\Addins\2022') "Canonical add-in root followed poisoned environment state."
    Assert-Equal ([string]$aclContract.CanonicalManifestPath) (Join-Path $canonicalProgramData 'Autodesk\Revit\Addins\2022\revAgent.addin') "Canonical add-in manifest path followed poisoned environment state."
    Assert-True ([bool]$aclContract.OffRootBlocked) "Canonical add-in ACL helper accepted an off-ProgramData mutation root."
    $genericPermissionTargets = Get-RevAgentManagedPermissionTargets `
        -InstallRoot (Join-Path $canonicalProgramData 'DPE\revAgent') `
        -WorkRoot (Join-Path $canonicalProgramData 'DPE\revAgent\updater') `
        -PackageTarget (Join-Path $canonicalProgramData 'DPE\revAgent\package') `
        -ServerTarget (Join-Path $canonicalProgramData 'DPE\revAgent\runtime') `
        -AllUsersAddinRoot (Join-Path $canonicalProgramData 'Autodesk\Revit\Addins\2022') `
        -RevitVersion '2022'
    Assert-Equal @($genericPermissionTargets | Where-Object { [string]$_.Path -like '*\Autodesk\Revit\Addins\*' }).Count 0 "Generic grant-based permission repair still targets the protected Autodesk Addins surface."

    $atomicCreateFixture = Join-Path $tempRoot 'atomic-protected-addins-root'
    $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $atomicCreateAcl = & $permissionsModule { New-RevitMcpProtectedAddinAcl -Kind Directory }
    $atomicCreateAcl.SetOwner($currentUserSid)
    & $permissionsModule { param($Path, $Acl) New-RevitMcpDirectoryWithAcl -Path $Path -Acl $Acl } $atomicCreateFixture $atomicCreateAcl
    $createdFixtureAcl = Get-Acl -LiteralPath $atomicCreateFixture
    Assert-True (Test-Path -LiteralPath $atomicCreateFixture -PathType Container) "Cross-version atomic DirectorySecurity creation did not create the protected add-in fixture."
    Assert-True ([bool]$createdFixtureAcl.AreAccessRulesProtected) "Cross-version atomic DirectorySecurity creation inherited the writable parent DACL."

    $aclReplacementFixture = Join-Path $tempRoot 'addin-acl-users-full-control'
    New-Item -ItemType Directory -Path $aclReplacementFixture -Force | Out-Null
    $manifestReplacementFixture = Join-Path $aclReplacementFixture 'revAgent.addin'
    Set-Content -LiteralPath $manifestReplacementFixture -Value '<RevitAddIns />' -Encoding UTF8
    $usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $fixtureInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $fixtureAcl = [Security.AccessControl.DirectorySecurity]::new()
    $fixtureAcl.SetAccessRuleProtection($true, $false)
    $fixtureAcl.SetOwner($currentUserSid)
    $fixtureAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentUserSid, [Security.AccessControl.FileSystemRights]::FullControl, $fixtureInheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    $fixtureAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($usersSid, [Security.AccessControl.FileSystemRights]::FullControl, $fixtureInheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($aclReplacementFixture), $fixtureAcl) }
    else { ([IO.DirectoryInfo]::new($aclReplacementFixture)).SetAccessControl($fixtureAcl) }
    $manifestFixtureAcl = [Security.AccessControl.FileSecurity]::new()
    $manifestFixtureAcl.SetAccessRuleProtection($true, $false)
    $manifestFixtureAcl.SetOwner($currentUserSid)
    $manifestFixtureAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentUserSid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    $manifestFixtureAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($usersSid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($manifestReplacementFixture), $manifestFixtureAcl) }
    else { ([IO.FileInfo]::new($manifestReplacementFixture)).SetAccessControl($manifestFixtureAcl) }

    $replacementAcl = & $permissionsModule { New-RevitMcpProtectedAddinAcl -Kind Directory }
    # Keep the test non-elevated while exercising the same handle-bound DACL
    # replacement used in production; production independently attests the
    # canonical Administrators owner.
    $replacementAcl.SetOwner($currentUserSid)
    $fixtureHandle = [RevAgent.PermissionNativeFileInfo]::OpenNoDelete($aclReplacementFixture, $true)
    try {
        [RevAgent.PermissionNativeFileInfo]::ApplyOwnerAndProtectedDacl($fixtureHandle, $replacementAcl.GetSecurityDescriptorBinaryForm())
    }
    finally {
        $fixtureHandle.Dispose()
    }
    $replacedFixtureAcl = Get-Acl -LiteralPath $aclReplacementFixture
    $replacedRules = @($replacedFixtureAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $replacedUsersRules = @($replacedRules | Where-Object { [string]$_.IdentityReference.Value -eq 'S-1-5-32-545' })
    $replacedCurrentUserRules = @($replacedRules | Where-Object { [string]$_.IdentityReference.Value -eq [string]$currentUserSid.Value })
    $expectedUsersReadExecute = [int64]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
    Assert-True ([bool]$replacedFixtureAcl.AreAccessRulesProtected) "Handle-bound canonical add-in ACL replacement did not protect the DACL."
    Assert-Equal $replacedUsersRules.Count 1 "Handle-bound canonical add-in ACL replacement did not collapse BUILTIN\Users to one rule."
    Assert-Equal ([int64]$replacedUsersRules[0].FileSystemRights) $expectedUsersReadExecute "Handle-bound canonical add-in ACL replacement retained BUILTIN\Users mutation rights."
    Assert-Equal $replacedCurrentUserRules.Count 0 "Handle-bound canonical add-in ACL replacement retained an interactive-user FullControl rule."

    $manifestReplacementAcl = & $permissionsModule { New-RevitMcpProtectedAddinAcl -Kind File }
    $manifestReplacementAcl.SetOwner($currentUserSid)
    $manifestFixtureHandle = [RevAgent.PermissionNativeFileInfo]::OpenNoDelete($manifestReplacementFixture, $false)
    try {
        Assert-Equal ([int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($manifestFixtureHandle)) 1 "Manifest regression fixture unexpectedly has another hardlink."
        [RevAgent.PermissionNativeFileInfo]::ApplyOwnerAndProtectedDacl($manifestFixtureHandle, $manifestReplacementAcl.GetSecurityDescriptorBinaryForm())
        Assert-Equal ([int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($manifestFixtureHandle)) 1 "Manifest hardlink count changed during handle-bound ACL replacement."
    }
    finally {
        $manifestFixtureHandle.Dispose()
    }
    $replacedManifestAcl = Get-Acl -LiteralPath $manifestReplacementFixture
    $replacedManifestRules = @($replacedManifestAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $replacedManifestUsersRules = @($replacedManifestRules | Where-Object { [string]$_.IdentityReference.Value -eq 'S-1-5-32-545' })
    $replacedManifestCurrentUserRules = @($replacedManifestRules | Where-Object { [string]$_.IdentityReference.Value -eq [string]$currentUserSid.Value })
    Assert-True ([bool]$replacedManifestAcl.AreAccessRulesProtected) "Handle-bound revAgent.addin ACL replacement did not protect the file DACL."
    Assert-Equal $replacedManifestUsersRules.Count 1 "Handle-bound revAgent.addin ACL replacement did not collapse BUILTIN\Users to one rule."
    Assert-Equal ([int64]$replacedManifestUsersRules[0].FileSystemRights) $expectedUsersReadExecute "Handle-bound revAgent.addin ACL replacement retained BUILTIN\Users mutation rights."
    Assert-Equal $replacedManifestCurrentUserRules.Count 0 "Handle-bound revAgent.addin ACL replacement retained an interactive-user FullControl rule."

    Write-Host "Test canonical Revit add-in guard rejects retained parent/year/manifest mutation handles"
    if (-not ('RevAgentOsPathSecurity.RetainedMutationHandle' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace RevAgentOsPathSecurity {
    public static class RetainedMutationHandle {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        public static SafeFileHandle Open(string path, uint access, bool directory) {
            uint flags = 0x00200000u | (directory ? 0x02000000u : 0u);
            SafeFileHandle handle = CreateFileW(path, access, 0x00000007u, IntPtr.Zero, 3u, flags, IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Could not open retained mutation-handle fixture: " + path);
            }
            return handle;
        }
    }
}
'@
    }
    $retainedAddinsParent = Join-Path $tempRoot 'retained-handle-addins'
    $retainedAddinRoot = Join-Path $retainedAddinsParent '2022'
    $retainedManifest = Join-Path $retainedAddinRoot 'revAgent.addin'
    New-Item -ItemType Directory -Path $retainedAddinRoot -Force | Out-Null
    [IO.File]::WriteAllText($retainedManifest, '<RevitAddIns />', [Text.UTF8Encoding]::new($false))
    $retainedPaths = [pscustomobject]@{
        AddinsParent = $retainedAddinsParent
        AddinRoot = $retainedAddinRoot
        ManifestPath = $retainedManifest
    }
    $retainedDirectoryAcl = & $permissionsModule { New-RevitMcpProtectedAddinAcl -Kind Directory }
    $retainedDirectoryAcl.SetOwner($currentUserSid)
    $retainedFileAcl = & $permissionsModule { New-RevitMcpProtectedAddinAcl -Kind File }
    $retainedFileAcl.SetOwner($currentUserSid)
    foreach ($fixture in @(
            [pscustomobject]@{ Label = 'parent FILE_ADD_FILE'; Path = $retainedAddinsParent; Access = [uint32]0x00000002; Directory = $true; Property = 'ParentGuard'; Kind = 'Directory'; Acl = $retainedDirectoryAcl },
            [pscustomobject]@{ Label = 'parent DELETE_CHILD'; Path = $retainedAddinsParent; Access = [uint32]0x00000040; Directory = $true; Property = 'ParentGuard'; Kind = 'Directory'; Acl = $retainedDirectoryAcl },
            [pscustomobject]@{ Label = 'year WRITE_DAC'; Path = $retainedAddinRoot; Access = [uint32]0x00040000; Directory = $true; Property = 'RootGuard'; Kind = 'Directory'; Acl = $retainedDirectoryAcl },
            [pscustomobject]@{ Label = 'manifest GENERIC_WRITE'; Path = $retainedManifest; Access = [uint32]0x40000000; Directory = $false; Property = 'ManifestGuard'; Kind = 'File'; Acl = $retainedFileAcl }
        )) {
        $pathAclBefore = (Get-Acl -LiteralPath $fixture.Path).Sddl
        $manifestBytesBefore = [Convert]::ToBase64String([IO.File]::ReadAllBytes($retainedManifest))
        $retainedHandle = [RevAgentOsPathSecurity.RetainedMutationHandle]::Open($fixture.Path, $fixture.Access, $fixture.Directory)
        try {
            Assert-ThrowsLike -Action {
                & $permissionsModule {
                    param($Paths, $GuardProperty, $Path, $Kind, $Acl)
                    $context = New-RevitMcpCanonicalAddinMutationGuardContext -Paths $Paths
                    try {
                        Protect-RevitMcpCanonicalAddinItem -Context $context -Paths $Paths -GuardProperty $GuardProperty -Path $Path -Kind $Kind -Acl $Acl
                    }
                    finally {
                        Close-RevitMcpCanonicalAddinMutationGuard -Context $context
                    }
                } $retainedPaths $fixture.Property $fixture.Path $fixture.Kind $fixture.Acl
            } -Pattern 'mutation-capable filesystem handle|ACL mutation barrier|lock.*mutation|being used|used by another process|başka bir işlem' -Message "Canonical add-in guard accepted retained $($fixture.Label) access."
        }
        finally {
            $retainedHandle.Dispose()
        }
        Assert-Equal (Get-Acl -LiteralPath $fixture.Path).Sddl $pathAclBefore "Rejected retained $($fixture.Label) handle changed the target ACL."
        Assert-Equal ([Convert]::ToBase64String([IO.File]::ReadAllBytes($retainedManifest))) $manifestBytesBefore "Rejected retained $($fixture.Label) handle changed manifest bytes."
    }

    $permissionsText = Get-Text 'installer\lib\RevAgent.Permissions.psm1'
    Assert-True ($permissionsText -match 'OpenAclMutationBarrier' -and $permissionsText -match 'AssertNoMutationHandles\(\$barrier' -and $permissionsText -match 'Assert-RevitMcpCanonicalAddinMutationGuard') "Canonical add-in ACL mutation must combine an exact-item barrier, retained-handle inventory, and held exact identity-set guard."
    Assert-True ($selfContainedText -match '-RetainMutationGuard' -and $selfContainedText -match '-MutationGuardContext \$script:RevAgentCanonicalAddinMutationGuardContext' -and $selfContainedText -match 'finally \{[\s\S]*Close-RevAgentCanonicalAddinMutationGuard') "Self-contained installer must retain the exact add-in guard through manifest installation and dispose it in the outer finally."

    . (Import-ScriptFunctionForTest -Path $selfContainedPath -FunctionName 'New-RevAgentCanonicalAddinManifestContract')
    . (Import-ScriptFunctionForTest -Path $selfContainedPath -FunctionName 'Write-AddinManifest')
    . (Import-ScriptFunctionForTest -Path $selfContainedPath -FunctionName 'Assert-RevAgentCanonicalAddinManifestContent')

    Write-Host "Test retained canonical manifest guard blocks delete but permits identity-preserving rewrite"
    $guardedRewriteRoot = Join-Path $tempRoot 'retained-guard-rewrite'
    $guardedRewriteManifest = Join-Path $guardedRewriteRoot 'revAgent.addin'
    $guardedRewriteAssembly = 'C:\ProgramData\DPE\revAgent\revit-plugin\revAgentPlugin\revAgentPlugin.dll'
    New-Item -ItemType Directory -Path $guardedRewriteRoot -Force | Out-Null
    [IO.File]::WriteAllText($guardedRewriteManifest, 'old manifest bytes', [Text.UTF8Encoding]::new($false))
    $guardedRewriteHandle = [RevAgent.PermissionNativeFileInfo]::OpenNoMutation($guardedRewriteManifest, $false)
    try {
        $guardedRewriteIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($guardedRewriteHandle)
        Assert-ThrowsLike -Action {
            Remove-Item -LiteralPath $guardedRewriteManifest -Force -ErrorAction Stop
        } -Pattern 'being used|used by another process|eri.emiyor' -Message 'Retained canonical manifest guard unexpectedly allowed the pinned file to be deleted.'

        Write-AddinManifest -Path $guardedRewriteManifest -AssemblyPath $guardedRewriteAssembly
        $guardedRewriteAttestation = Assert-RevAgentCanonicalAddinManifestContent -Path $guardedRewriteManifest -AssemblyPath $guardedRewriteAssembly
        Assert-True ([bool]$guardedRewriteAttestation.verified -and [string]::Equals([string]$guardedRewriteAttestation.sha256, [string]$guardedRewriteAttestation.expectedSha256, [StringComparison]::OrdinalIgnoreCase)) "Production manifest writer did not produce the deterministic signed-package contract under the retained guard."
        Assert-Equal ([RevAgent.PermissionNativeFileInfo]::GetIdentity($guardedRewriteManifest, $false)) $guardedRewriteIdentity "Guarded canonical manifest rewrite replaced the pinned file identity."
    }
    finally {
        $guardedRewriteHandle.Dispose()
    }
    Assert-True ($selfContainedText -match '(?s)if \(\$ForUninstall\)\s*\{\s*#.*?Remove-RevAgentPath -Path \$canonicalAddinManifestPath.*?\}\s*elseif \(Test-Path -LiteralPath \$canonicalAddinManifestPath -PathType Leaf\).*?guarded in-place rewrite') "Install/Repair must retain the pinned canonical manifest for in-place rewrite while uninstall remains allowed to remove it."

    Write-Host "Test canonical revAgent.addin deterministic content and skip-path tamper guard"
    $canonicalManifestFixture = Join-Path $tempRoot 'canonical-manifest\revAgent.addin'
    New-Item -ItemType Directory -Path (Split-Path -Parent $canonicalManifestFixture) -Force | Out-Null
    $canonicalAssemblyFixture = 'C:\ProgramData\DPE\revAgent\revit-plugin\revAgentPlugin\revAgentPlugin.dll'
    Write-AddinManifest -Path $canonicalManifestFixture -AssemblyPath $canonicalAssemblyFixture
    $manifestAttestation = Assert-RevAgentCanonicalAddinManifestContent -Path $canonicalManifestFixture -AssemblyPath $canonicalAssemblyFixture
    Assert-True ([bool]$manifestAttestation.verified -and [string]::Equals([string]$manifestAttestation.sha256, [string]$manifestAttestation.expectedSha256, [StringComparison]::OrdinalIgnoreCase)) "Fresh canonical manifest did not satisfy its deterministic signed-package contract."
    $canonicalBytes = [IO.File]::ReadAllBytes($canonicalManifestFixture)
    Assert-True ($canonicalBytes.Length -gt 3 -and -not ($canonicalBytes[0] -eq 0xEF -and $canonicalBytes[1] -eq 0xBB -and $canonicalBytes[2] -eq 0xBF)) "Canonical manifest must use BOM-free UTF-8 consistently across PowerShell engines."
    $canonicalText = [Text.UTF8Encoding]::new($false, $true).GetString($canonicalBytes)
    Assert-True ($canonicalText -notmatch "`r" -and $canonicalText.EndsWith("`n")) "Canonical manifest must use deterministic LF line endings."

    [IO.File]::WriteAllText($canonicalManifestFixture, ($canonicalText -replace '090A4C8C-61DC-426D-87DF-E4BAE0F80EC1', '00000000-0000-0000-0000-000000000000'), [Text.UTF8Encoding]::new($false))
    Assert-ThrowsLike -Action {
        Assert-RevAgentCanonicalAddinManifestContent -Path $canonicalManifestFixture -AssemblyPath $canonicalAssemblyFixture | Out-Null
    } -Pattern 'expected deterministic manifest.*Install/Repair|Install/Repair.*untrusted manifest' -Message 'Tampered revAgent.addin ClientId must fail closed with Install/Repair guidance.'
    [IO.File]::WriteAllText($canonicalManifestFixture, ($canonicalText -replace [regex]::Escape($canonicalAssemblyFixture), 'C:\Users\BT\evil.dll'), [Text.UTF8Encoding]::new($false))
    Assert-ThrowsLike -Action {
        Assert-RevAgentCanonicalAddinManifestContent -Path $canonicalManifestFixture -AssemblyPath $canonicalAssemblyFixture | Out-Null
    } -Pattern 'expected deterministic manifest.*Install/Repair|Install/Repair.*untrusted manifest' -Message 'Tampered revAgent.addin Assembly must fail closed with Install/Repair guidance.'
    Write-AddinManifest -Path $canonicalManifestFixture -AssemblyPath $canonicalAssemblyFixture
    $repairedManifestAttestation = Assert-RevAgentCanonicalAddinManifestContent -Path $canonicalManifestFixture -AssemblyPath $canonicalAssemblyFixture
    Assert-True ([bool]$repairedManifestAttestation.verified) "Hard rebaseline manifest rewrite did not repair the tampered fixture."
    Assert-True ($selfContainedText -match '(?s)if \(\$SkipRevitPayloadInstall\).*?Protect-RevAgentCanonicalAddinSurface.*?-ProtectManifestIfPresent.*?Assert-RevAgentCanonicalAddinManifestContent' -and $selfContainedText -match 'unchanged-payload update cannot safely recreate') "SkipRevitPayloadInstall must attest exact canonical manifest bytes/identity and fail closed instead of blessing a missing or attacker-modified file."
    Assert-True ($selfContainedText -match '(?s)Write-AddinManifest.*?Protect-RevAgentCanonicalAddinSurface.*?-ProtectManifest.*?Assert-RevAgentCanonicalAddinManifestContent') "Hard Revit payload repair must rewrite, protect, and attest the canonical manifest in order."

    Write-Host "Test protected installer-origin ACL masks distinguish read access from mutation rights"
    $atomicMutationRights = @(
        [Security.AccessControl.FileSystemRights]::WriteData,
        [Security.AccessControl.FileSystemRights]::AppendData,
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes,
        [Security.AccessControl.FileSystemRights]::WriteAttributes,
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
        [Security.AccessControl.FileSystemRights]::Delete,
        [Security.AccessControl.FileSystemRights]::ChangePermissions,
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    )
    [int64]$expectedMutationMask = 0
    foreach ($right in $atomicMutationRights) { $expectedMutationMask = $expectedMutationMask -bor [int64]$right }
    $maskFixtures = @(
        [pscustomobject]@{
            Label = 'self-contained installer origin'
            Path = $selfContainedPath
            FunctionName = 'Test-RevAgentInstallerRightsAllowMutation'
            VariableName = 'writeMask'
        },
        [pscustomobject]@{
            Label = 'authenticated bootstrap evidence leaf'
            Path = (Join-Path $RepoRoot 'scripts\install-revagent-local-bootstrap.ps1')
            FunctionName = 'Test-RevAgentBootstrapRightsAllowMutation'
            VariableName = 'leafDangerMask'
        }
    )
    foreach ($fixture in $maskFixtures) {
        [int64]$actualMask = Get-FunctionAssignmentValue -Path $fixture.Path -FunctionName $fixture.FunctionName -VariableName $fixture.VariableName
        Assert-Equal $actualMask $expectedMutationMask "$($fixture.Label) must use exactly the atomic mutation-right mask."

        $usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
        $readExecuteRule = [Security.AccessControl.FileSystemAccessRule]::new(
            $usersSid,
            [Security.AccessControl.FileSystemRights]::ReadAndExecute,
            [Security.AccessControl.AccessControlType]::Allow)
        Assert-True (([int64]$readExecuteRule.FileSystemRights -band [int64][Security.AccessControl.FileSystemRights]::Synchronize) -ne 0) "$($fixture.Label) regression fixture did not reproduce the live ReadAndExecute, Synchronize ACE."
        Assert-True (([int64]$readExecuteRule.FileSystemRights -band $actualMask) -eq 0) "$($fixture.Label) misclassified BUILTIN\Users ReadAndExecute, Synchronize as mutation-capable."
        Assert-True (-not (Invoke-ExtractedRightsPredicate -Path $fixture.Path -FunctionName $fixture.FunctionName -Rights $readExecuteRule.FileSystemRights)) "$($fixture.Label) production predicate rejected the live BUILTIN\Users ReadAndExecute, Synchronize ACE."
        foreach ($readOnlyRight in @(
                [Security.AccessControl.FileSystemRights]::Read,
                [Security.AccessControl.FileSystemRights]::ReadAndExecute,
                [Security.AccessControl.FileSystemRights]::ReadPermissions,
                [Security.AccessControl.FileSystemRights]::Synchronize)) {
            Assert-True (([int64]$readOnlyRight -band $actualMask) -eq 0) "$($fixture.Label) mutation mask overlaps read-only right $readOnlyRight."
            Assert-True (-not (Invoke-ExtractedRightsPredicate -Path $fixture.Path -FunctionName $fixture.FunctionName -Rights $readOnlyRight)) "$($fixture.Label) production predicate rejected read-only right $readOnlyRight."
        }
        foreach ($mutationRight in $atomicMutationRights) {
            Assert-True (([int64]$mutationRight -band $actualMask) -ne 0) "$($fixture.Label) does not reject mutation right $mutationRight."
            Assert-True (Invoke-ExtractedRightsPredicate -Path $fixture.Path -FunctionName $fixture.FunctionName -Rights $mutationRight) "$($fixture.Label) production predicate accepted mutation right $mutationRight."
        }
        foreach ($aggregateMutationRight in @(
                [Security.AccessControl.FileSystemRights]::Modify,
                [Security.AccessControl.FileSystemRights]::FullControl)) {
            Assert-True (([int64]$aggregateMutationRight -band $actualMask) -ne 0) "$($fixture.Label) does not reject aggregate mutation right $aggregateMutationRight through atomic bits."
            Assert-True (Invoke-ExtractedRightsPredicate -Path $fixture.Path -FunctionName $fixture.FunctionName -Rights $aggregateMutationRight) "$($fixture.Label) production predicate accepted aggregate mutation right $aggregateMutationRight."
        }
    }
    Assert-True ($selfContainedText -match 'Test-RevAgentInstallerRightsAllowMutation -Rights \$rule\.FileSystemRights') "Protected installer-origin ACL traversal must call the tested production mutation predicate."
    $bootstrapText = Get-Text 'scripts\install-revagent-local-bootstrap.ps1'
    Assert-True ($bootstrapText -match 'Test-RevAgentBootstrapRightsAllowMutation -Rights \$rule\.FileSystemRights') "Bootstrap evidence ACL traversal must call the tested production mutation predicate."

    Write-Host "Test self-contained restricted-token CreateNew/append native probe"
    $nativeTypeMatch = [regex]::Match($selfContainedText, "(?s)Add-Type -TypeDefinition @'\r?\n(?<code>.*?)\r?\n'@")
    Assert-True $nativeTypeMatch.Success "Self-contained protected-origin native type definition was not found."
    if (-not ("RevAgent.ProtectedInstallerOriginNative" -as [type])) {
        Add-Type -TypeDefinition $nativeTypeMatch.Groups['code'].Value
    }
    $nativeProbeFile = Join-Path $tempRoot "native-probe-existing.ps1"
    [IO.File]::WriteAllText($nativeProbeFile, "# probe", [Text.UTF8Encoding]::new($false))
    $nativeProbe = [RevAgent.ProtectedInstallerOriginNative]::ProbeRestrictedWrite($tempRoot, $nativeProbeFile)
    Assert-True ([bool]$nativeProbe.CreateNewAllowed) "Restricted-token probe did not detect effective CreateNew access in the user-writable fixture."
    Assert-True ([bool]$nativeProbe.AppendAllowed) "Restricted-token probe did not detect effective append access in the user-writable fixture."
    $readOnlyProbeRoot = Join-Path $tempRoot "restricted-read-only"
    $readOnlyProbeFile = Join-Path $readOnlyProbeRoot "existing.ps1"
    New-Item -ItemType Directory -Path $readOnlyProbeRoot -Force | Out-Null
    [IO.File]::WriteAllText($readOnlyProbeFile, "# read only probe", [Text.UTF8Encoding]::new($false))
    $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $readOnlyFileAcl = [Security.AccessControl.FileSecurity]::new()
    $readOnlyFileAcl.SetAccessRuleProtection($true, $false)
    [void]$readOnlyFileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentUserSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, [Security.AccessControl.AccessControlType]::Allow))
    if ("System.IO.FileSystemAclExtensions" -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($readOnlyProbeFile), $readOnlyFileAcl) }
    else { ([IO.FileInfo]::new($readOnlyProbeFile)).SetAccessControl($readOnlyFileAcl) }
    $readOnlyDirectoryAcl = [Security.AccessControl.DirectorySecurity]::new()
    $readOnlyDirectoryAcl.SetAccessRuleProtection($true, $false)
    [void]$readOnlyDirectoryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $currentUserSid,
            [Security.AccessControl.FileSystemRights]::ReadAndExecute,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow))
    if ("System.IO.FileSystemAclExtensions" -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($readOnlyProbeRoot), $readOnlyDirectoryAcl) }
    else { ([IO.DirectoryInfo]::new($readOnlyProbeRoot)).SetAccessControl($readOnlyDirectoryAcl) }
    $readOnlyNativeProbe = [RevAgent.ProtectedInstallerOriginNative]::ProbeRestrictedWrite($readOnlyProbeRoot, $readOnlyProbeFile)
    Assert-True (-not [bool]$readOnlyNativeProbe.CreateNewAllowed) "Restricted-token probe incorrectly reported CreateNew access on a protected read-only fixture."
    Assert-True (-not [bool]$readOnlyNativeProbe.AppendAllowed) "Restricted-token probe incorrectly reported append access on a protected read-only fixture."
    $restoreAcl = [Security.AccessControl.DirectorySecurity]::new()
    $restoreAcl.SetAccessRuleProtection($true, $false)
    [void]$restoreAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $currentUserSid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow))
    if ("System.IO.FileSystemAclExtensions" -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($readOnlyProbeRoot), $restoreAcl) }
    else { ([IO.DirectoryInfo]::new($readOnlyProbeRoot)).SetAccessControl($restoreAcl) }

    Write-Host "Test launcher and source code do not derive privileged roots from environment variables"
    $criticalFiles = @(
        "installer\nas\Install-revAgent-Updater-GUI.ps1",
        "installer\nas\Invoke-revAgent-CodexUserIntegration.ps1",
        "installer\nas\update-from-nas.ps1",
        "installer\nas\install-updater-task.ps1",
        "installer\install-self-contained.ps1",
        "installer\lib\RevAgent.CodexRegistration.psm1",
        "installer\lib\RevAgent.HiddenLauncher.psm1",
        "installer\lib\RevAgent.Permissions.psm1"
    )
    foreach ($criticalFile in $criticalFiles) {
        $text = Get-Text $criticalFile
        Assert-True ($text -notmatch '(?i)\$env:(WINDIR|SystemRoot|ProgramFiles|ProgramData|CommonProgramFiles|USERPROFILE|LOCALAPPDATA|APPDATA|SystemDrive|OS)\b') "$criticalFile still derives a privileged root or platform decision from an inherited environment variable."
    }
    $guiText = Get-Text "installer\nas\Install-revAgent-Updater-GUI.ps1"
    $permissionsText = Get-Text "installer\lib\RevAgent.Permissions.psm1"
    foreach ($profileBindingText in @($guiText, $permissionsText)) {
        Assert-True ($profileBindingText -match 'GetPathRoot\(\[Environment\]::SystemDirectory\)' -and $profileBindingText -match '\(\?i\)%SystemDrive%') "ProfileImagePath normalization must derive SystemDrive only from canonical SystemDirectory."
        Assert-True ($profileBindingText -match 'unsupported environment token') "ProfileImagePath normalization must fail closed on non-SystemDrive environment tokens."
    }
    foreach ($commandWriter in @(
            "installer\nas\update-from-nas.ps1",
            "installer\nas\install-updater-task.ps1",
            "installer\install-self-contained.ps1"
        )) {
        $writerText = Get-Text $commandWriter
        Assert-True ($writerText -notmatch '(?im)^\s*"powershell\.exe\s+-NoProfile') "$commandWriter still emits a PATH-resolved PowerShell helper command."
        Assert-True ($writerText -match '(?i)%__APPDIR__%WindowsPowerShell\\v1\.0\\powershell\.exe') "$commandWriter does not emit helper commands through cmd.exe __APPDIR__."
    }
    foreach ($launcher in @(
            "installer\nas\Refresh-revAgent-LocalBootstrap-STABLE.cmd",
            "installer\nas\Revit MCP Updater STABLE.cmd",
            "installer\nas\revAgent Updater STABLE.cmd"
        )) {
        $launcherText = Get-Text $launcher
        Assert-True ($launcherText -match '(?i)%__APPDIR__%WindowsPowerShell\\v1\.0\\powershell\.exe') "$launcher does not pin Windows PowerShell through the cmd.exe __APPDIR__ root."
    }
    foreach ($legacyStub in @(
            "installer\nas\Install-revAgent-Updater-GUI.cmd",
            "installer\nas\Install-Revit-MCP-Updater-GUI.cmd",
            "installer\nas\Install-revAgent-Updater.cmd",
            "installer\nas\Install-Revit-MCP-Updater.cmd"
        )) {
        $stubText = Get-Text $legacyStub
        Assert-True ($stubText -match '(?im)^call\s+"%(STABLE|TARGET)%"\s+%\*') "$legacyStub does not delegate through the exact managed STABLE compatibility chain."
        Assert-True ($stubText -notmatch '(?i)powershell(?:\.exe)?') "$legacyStub duplicates PowerShell launch logic instead of remaining a thin STABLE delegate."
        Assert-True ($stubText -notmatch 'SECURITY STOP') "$legacyStub still exposes the retired clean-machine SECURITY STOP dead end."
    }
}
finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable([string]$name, [string]$savedEnvironment[$name], "Process")
    }
    Remove-Module RevAgent.CodexRegistration -Force -ErrorAction SilentlyContinue
    Remove-Module RevAgent.SecureTemp -Force -ErrorAction SilentlyContinue
    Remove-Module RevAgent.Permissions -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\REVAGENT_GUI_PREIMPORT_MARKER -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "OS path and secure-temp security tests passed." -ForegroundColor Green
$global:LASTEXITCODE = 0
