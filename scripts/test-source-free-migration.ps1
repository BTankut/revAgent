<#
.SYNOPSIS
    CI-safe tests for source-free workstation migration helpers.
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

Import-Module (Join-Path $libRoot "RevAgent.SourceFreeMigration.psm1") -Force

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

function Get-ScriptParamNames {
    param([string]$Path)

    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    Assert-Equal $errors.Count 0 "PowerShell parse errors found in $Path."
    return @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
}

Write-Host "Test source-free migration artifact scan and cleanup"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-source-free-migration-test-" + [Guid]::NewGuid().ToString("N"))
$installRoot = Join-Path $tempRoot "ProgramData\DPE\revAgent"
$packageTarget = Join-Path $installRoot "package"
$serverTarget = Join-Path $installRoot "runtime"
$userProfileRoot = Join-Path $tempRoot "Users\Operator"

try {
    foreach ($path in @(
            (Join-Path $packageTarget "src"),
            (Join-Path $packageTarget "docs"),
            (Join-Path $packageTarget "addons\dashboard"),
            (Join-Path $packageTarget "installer\revit-api-docs-mcp\scripts"),
            (Join-Path $packageTarget "installer\runtime-mcp-server"),
            (Join-Path $serverTarget "src"),
            (Join-Path $serverTarget "build"),
            (Join-Path $installRoot "codex\skills\revAgent\src"),
            (Join-Path $userProfileRoot ".codex\skills\revAgent\src"),
            (Join-Path $installRoot "updater\backups\revit-mcp-skill.backup-20260623\src")
        )) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }

    Set-Content -LiteralPath (Join-Path $packageTarget "src\tool.ts") -Value "export const x = 1;" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $packageTarget "docs\developer.md") -Value "developer notes" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $packageTarget "addons\dashboard\server.mjs") -Value "export {};" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $packageTarget "installer\revit-api-docs-mcp\scripts\build-index.ps1") -Value "# allowed runtime script" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $packageTarget "installer\runtime-mcp-server\tsconfig.json") -Value "{}" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $serverTarget "src\index.ts") -Value "export {};" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $serverTarget "build\index.js.map") -Value "{}" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $installRoot "codex\skills\revAgent\src\skill.ts") -Value "source" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $userProfileRoot ".codex\skills\revAgent\src\skill.ts") -Value "source" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $installRoot "updater\backups\revit-mcp-skill.backup-20260623\src\old.ts") -Value "source" -Encoding ASCII

    $dryRun = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot
    Assert-Equal $dryRun.mode "dryRun" "Default source-free cleanup mode must be dryRun."
    Assert-Equal $dryRun.artifactCount 10 "Dry-run should detect all managed source/developer artifacts."
    Assert-Equal $dryRun.removedCount 0 "Dry-run must not remove artifacts."
    Assert-True (Test-Path -LiteralPath (Join-Path $packageTarget "src")) "Dry-run removed package source unexpectedly."
    Assert-True (Test-Path -LiteralPath (Join-Path $packageTarget "installer\revit-api-docs-mcp\scripts\build-index.ps1")) "Allowed docs build-index script must stay present."

    $preserveDryRun = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -PreserveLocalCodexInstructions
    Assert-Equal $preserveDryRun.mode "dryRun" "Preserve-local source-free cleanup mode must remain dryRun by default."
    Assert-Equal $preserveDryRun.artifactCount 8 "Preserve-local cleanup should exclude machine/user Codex skill roots from source-free artifacts."
    Assert-True ([bool]$preserveDryRun.codexInstructionCleanupSkipped) "Preserve-local cleanup result must report skipped Codex instruction cleanup."
    Assert-Equal (@($preserveDryRun.artifacts | Where-Object { [string]$_.rootKind -eq "codexSkill" }).Count) 0 "Preserve-local cleanup must not classify Codex skill roots as cleanup artifacts."

    $skipUserDryRun = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -SkipCodexUserIntegration
    Assert-Equal $skipUserDryRun.artifactCount 9 "SkipCodexUserIntegration cleanup should exclude only the user Codex skill root from source-free artifacts."
    Assert-Equal (@($skipUserDryRun.artifacts | Where-Object { [string]$_.rootLabel -eq "user Codex skill" }).Count) 0 "SkipCodexUserIntegration cleanup must not classify user Codex skill roots as cleanup artifacts."
    Assert-Equal (@($skipUserDryRun.artifacts | Where-Object { [string]$_.rootLabel -eq "machine Codex skill" }).Count) 1 "SkipCodexUserIntegration cleanup must still inspect the machine Codex skill root."

    $reportPath = Join-Path $tempRoot "migration-dry-run-report.json"
    & (Join-Path $RepoRoot "installer\nas\migrate-source-free-install.ps1") `
        -Mode dryRun `
        -InstallRoot $installRoot `
        -WorkRoot (Join-Path $installRoot "updater") `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -ReportPath $reportPath
    Assert-True (Test-Path -LiteralPath $reportPath -PathType Leaf) "Migration dry-run should write a JSON report."
    $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
    Assert-Equal ([int]$report.before.artifactCount) 10 "Migration dry-run report should include source/developer artifact count."
    Assert-Equal ([string]$report.mode) "dryRun" "Migration dry-run report should preserve mode."

    $preserveReportPath = Join-Path $tempRoot "migration-preserve-dry-run-report.json"
    & (Join-Path $RepoRoot "installer\nas\migrate-source-free-install.ps1") `
        -Mode dryRun `
        -InstallRoot $installRoot `
        -WorkRoot (Join-Path $installRoot "updater") `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -CodexInstructionPolicy preserve-local `
        -MachineRole developer `
        -ReportPath $preserveReportPath
    $preserveReport = Get-Content -Raw -LiteralPath $preserveReportPath | ConvertFrom-Json
    Assert-Equal ([string]$preserveReport.codexInstructionPolicy) "preserve-local" "Migration report should include preserve-local policy."
    Assert-True ([bool]$preserveReport.codexInstructionCleanupSkipped) "Migration report should show that Codex instruction cleanup was skipped by policy."
    Assert-Equal ([string]$preserveReport.machineRole) "developer" "Migration report should include descriptive machine role."
    Assert-Equal ([int]$preserveReport.before.artifactCount) 8 "Migration preserve-local dry-run should exclude Codex skill roots from artifact count."

    $commit = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -Commit
    Assert-Equal $commit.mode "commit" "Commit source-free cleanup should report commit mode."
    Assert-Equal $commit.failedCount 0 "Commit cleanup should not fail in the isolated fixture."
    Assert-Equal $commit.remainingCount 0 "Commit cleanup should remove all managed source/developer artifacts."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $packageTarget "src"))) "Package src directory should be removed."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $packageTarget "addons"))) "Package admin add-on directory should be removed from source-free workstation installs."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $serverTarget "src"))) "Runtime src directory should be removed."
    Assert-True (Test-Path -LiteralPath (Join-Path $packageTarget "installer\revit-api-docs-mcp\scripts\build-index.ps1")) "Allowed docs build-index script should not be removed by cleanup."

    Write-Host "Test source-free migration child updater transcript host"
    $harnessRoot = Join-Path $tempRoot "encoded-host-harness"
    $harnessTools = Join-Path $harnessRoot "tools"
    $harnessLib = Join-Path $harnessTools "lib"
    New-Item -ItemType Directory -Path $harnessLib -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepoRoot "installer\nas\migrate-source-free-install.ps1") -Destination (Join-Path $harnessTools "migrate-source-free-install.ps1") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.CodexRegistration.psm1") -Destination (Join-Path $harnessLib "RevAgent.CodexRegistration.psm1") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.SourceFreeMigration.psm1") -Destination (Join-Path $harnessLib "RevAgent.SourceFreeMigration.psm1") -Force

    $harnessReportPath = Join-Path $harnessRoot "migration-report.json"
    $harnessInstallRoot = Join-Path $harnessRoot "install"
    $harnessWorkRoot = Join-Path $harnessInstallRoot "updater"
    $harnessPackageTarget = Join-Path $harnessInstallRoot "package"
    $harnessServerTarget = Join-Path $harnessInstallRoot "runtime"
    $harnessUserProfileRoot = Join-Path $harnessRoot "user"
    $harnessConfigPath = Join-Path $harnessWorkRoot "updater-config.json"
    $harnessChannelPath = Join-Path $harnessRoot "stable.json"
    $fakeTaskStatePath = Join-Path $harnessRoot "fake-task-state.txt"
    New-Item -ItemType Directory -Path $harnessWorkRoot -Force | Out-Null

    $fakeUpdaterPath = Join-Path $harnessWorkRoot "update-from-nas.ps1"
    $fakeUpdater = @'
param(
    [string]$ConfigPath = "",
    [string]$ChannelManifestPath = "",
    [string]$InstallRoot = "",
    [string]$WorkRoot = "",
    [string]$PackageTarget = "",
    [string]$ServerTarget = "",
    [string]$OperationMethod = "",
    [string]$RevitInstallRoot = "",
    [string]$ReportsRoot = "",
    [string]$CodexInstructionPolicy = "",
    [string]$MachineRole = "",
    [switch]$SourceFreeMigration,
    [switch]$SkipNpmInstall,
    [switch]$SkipCodexMcpRegistration,
    [switch]$SkipCodexUserIntegration,
    [switch]$SkipProxySetup,
    [switch]$NoNotifyUser
)

$ErrorActionPreference = "Stop"
$transcriptPath = Join-Path $PSScriptRoot "fake-updater-transcript.log"
Start-Transcript -Path $transcriptPath -Force | Out-Null
try {
    Write-Host "fake updater invoked"
    Write-Host "sourceFreeMigration=$([bool]$SourceFreeMigration)"
    Write-Host "codexInstructionPolicy=$CodexInstructionPolicy"
    if (-not [string]::IsNullOrWhiteSpace($env:REVAGENT_FAKE_TASK_STATE_FILE)) {
        "Ready" | Set-Content -LiteralPath $env:REVAGENT_FAKE_TASK_STATE_FILE -Encoding ASCII
    }
}
finally {
    Stop-Transcript | Out-Null
}
exit 0
'@
    Set-Content -LiteralPath $fakeUpdaterPath -Value $fakeUpdater -Encoding ASCII

    ([ordered]@{
            codexInstructionPolicy = "preserve-local"
            machineRole = "developer"
        } | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $harnessConfigPath -Encoding ASCII
    "{}" | Set-Content -LiteralPath $harnessChannelPath -Encoding ASCII
    "Disabled" | Set-Content -LiteralPath $fakeTaskStatePath -Encoding ASCII

    function ConvertTo-SingleQuotedPowerShellLiteral {
        param([string]$Value)
        return "'" + $Value.Replace("'", "''") + "'"
    }

    $encodedHarnessScript = @(
        "function Get-ScheduledTask { [CmdletBinding()] param([string]`$TaskName) `$state = (Get-Content -Raw -LiteralPath `$env:REVAGENT_FAKE_TASK_STATE_FILE).Trim(); [pscustomobject]@{ TaskName = `$TaskName; State = `$state } }"
        "function Disable-ScheduledTask { [CmdletBinding()] param([string]`$TaskName) 'Disabled' | Set-Content -LiteralPath `$env:REVAGENT_FAKE_TASK_STATE_FILE -Encoding ASCII; [pscustomobject]@{ TaskName = `$TaskName; State = 'Disabled' } }"
        "& " + (ConvertTo-SingleQuotedPowerShellLiteral (Join-Path $harnessTools "migrate-source-free-install.ps1")) + " ``"
        "  -Mode commit ``"
        "  -ConfigPath " + (ConvertTo-SingleQuotedPowerShellLiteral $harnessConfigPath) + " ``"
        "  -ChannelManifestPath " + (ConvertTo-SingleQuotedPowerShellLiteral $harnessChannelPath) + " ``"
        "  -InstallRoot " + (ConvertTo-SingleQuotedPowerShellLiteral $harnessInstallRoot) + " ``"
        "  -WorkRoot " + (ConvertTo-SingleQuotedPowerShellLiteral $harnessWorkRoot) + " ``"
        "  -PackageTarget " + (ConvertTo-SingleQuotedPowerShellLiteral $harnessPackageTarget) + " ``"
        "  -ServerTarget " + (ConvertTo-SingleQuotedPowerShellLiteral $harnessServerTarget) + " ``"
        "  -UserProfileRoot " + (ConvertTo-SingleQuotedPowerShellLiteral $harnessUserProfileRoot) + " ``"
        "  -ReportPath " + (ConvertTo-SingleQuotedPowerShellLiteral $harnessReportPath) + " ``"
        "  -NoNotifyUser"
        'if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'
    ) -join "`n"
    $encodedHarness = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($encodedHarnessScript))
    $encodedHarnessOutputPath = Join-Path $harnessRoot "encoded-wrapper-output.log"
    $env:REVAGENT_FAKE_TASK_STATE_FILE = $fakeTaskStatePath
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedHarness *> $encodedHarnessOutputPath
    Remove-Item Env:\REVAGENT_FAKE_TASK_STATE_FILE -ErrorAction SilentlyContinue
    Assert-Equal $LASTEXITCODE 0 "Encoded wrapper migration harness should succeed."

    $fakeTranscriptPath = Join-Path $harnessWorkRoot "fake-updater-transcript.log"
    Assert-True (Test-Path -LiteralPath $fakeTranscriptPath -PathType Leaf) "Fake updater transcript should be written."
    $fakeTranscript = Get-Content -Raw -LiteralPath $fakeTranscriptPath
    $hostLine = @($fakeTranscript -split "`r?`n" | Where-Object { $_ -like "Host Application:*" } | Select-Object -First 1)[0]
    Assert-True ($hostLine -match '-File' -and $hostLine -match 'update-from-nas\.ps1') "Child updater transcript host should show the update-from-nas.ps1 -File invocation."
    Assert-True ($hostLine -notmatch 'EncodedCommand') "Child updater transcript host must not inherit the outer EncodedCommand wrapper."
    Assert-True ($fakeTranscript -match 'codexInstructionPolicy=preserve-local') "Migration child updater should receive the preserve-local Codex instruction policy."
    $harnessReport = Get-Content -Raw -LiteralPath $harnessReportPath | ConvertFrom-Json
    Assert-True $harnessReport.success "Encoded wrapper migration harness report should succeed."
    Assert-Equal ([string]$harnessReport.codexInstructionPolicy) "preserve-local" "Encoded wrapper migration harness report should preserve Codex instruction policy from config."
    Assert-True ([bool]$harnessReport.codexInstructionCleanupSkipped) "Encoded wrapper migration harness report should mark Codex instruction cleanup skipped by policy."
    Assert-Equal ((Get-Content -Raw -LiteralPath $fakeTaskStatePath).Trim()) "Disabled" "Migration should preserve a previously disabled revAgent Auto Update task after the child updater runs."
    Assert-Equal ([string]$harnessReport.scheduledTask.before.state) "Disabled" "Migration report should capture the disabled scheduled task state before updater."
    Assert-True ([bool]$harnessReport.scheduledTask.restore.attempted) "Migration report should show that disabled scheduled task state was restored."
    Assert-Equal ([string]$harnessReport.scheduledTask.restore.state) "Disabled" "Migration report should capture the restored disabled scheduled task state."

    Write-Host "Test source-free migration dry-run NAS evidence publishing"
    $dryRunReportsRoot = Join-Path $harnessRoot "dry-run-reports"
    $dryRunReportPath = Join-Path $harnessRoot "dry-run-migration-report.json"
    & (Join-Path $harnessTools "migrate-source-free-install.ps1") `
        -Mode dryRun `
        -ConfigPath $harnessConfigPath `
        -ChannelManifestPath $harnessChannelPath `
        -InstallRoot $harnessInstallRoot `
        -WorkRoot $harnessWorkRoot `
        -PackageTarget $harnessPackageTarget `
        -ServerTarget $harnessServerTarget `
        -UserProfileRoot $harnessUserProfileRoot `
        -ReportPath $dryRunReportPath `
        -ReportsRoot $dryRunReportsRoot `
        -NoNotifyUser
    Assert-Equal $LASTEXITCODE 0 "Dry-run migration evidence publish should succeed."
    $safeComputer = $env:COMPUTERNAME -replace '[\\/:*?"<>|]', "_"
    $dryRunMachineRoot = Join-Path $dryRunReportsRoot ("machines\{0}" -f $safeComputer)
    $dryRunLatestPath = Join-Path $dryRunMachineRoot "source-free-migration-latest.json"
    Assert-True (Test-Path -LiteralPath $dryRunLatestPath -PathType Leaf) "Dry-run migration must publish source-free-migration-latest.json for rollout readiness."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $dryRunMachineRoot "latest.json") -PathType Leaf)) "Dry-run migration evidence must not overwrite dashboard latest.json version state."
    $dryRunEvidence = Get-Content -Raw -LiteralPath $dryRunLatestPath | ConvertFrom-Json
    Assert-Equal ([string]$dryRunEvidence.operation) "source-free-migration" "Dry-run evidence operation mismatch."
    Assert-Equal ([string]$dryRunEvidence.operationMethod) "source-free-migration-dry-run" "Dry-run evidence operation method mismatch."
    Assert-Equal ([int]$dryRunEvidence.after.artifactCount) 0 "Dry-run evidence should capture clean post-inventory count."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Test source-free migration installer/updater surface"
$migrationParams = Get-ScriptParamNames -Path (Join-Path $RepoRoot "installer\nas\migrate-source-free-install.ps1")
foreach ($name in @("Mode", "ConfigPath", "ChannelManifestPath", "InstallRoot", "WorkRoot", "PackageTarget", "ServerTarget", "ReportPath", "CodexInstructionPolicy")) {
    Assert-True ($migrationParams -contains $name) "migrate-source-free-install.ps1 lost public parameter -$name."
}

$migrationText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\migrate-source-free-install.ps1")
Assert-True ($migrationText -match 'Get-Command powershell\.exe' -and $migrationText -match '\[void\]\$updateArgs\.Add\("-File"\)' -and $migrationText -match '\[void\]\$updateArgs\.Add\(\$updaterPath\)') "Migration commit mode must launch the updater as a child PowerShell -File process so updater transcripts do not inherit encoded wrapper commands."
Assert-True ($migrationText -notmatch '& \$updaterPath @updateArgs') "Migration commit mode must not call update-from-nas.ps1 inside the current PowerShell process."
Assert-True ($migrationText -match 'local trusted updater under WorkRoot' -and $migrationText -notmatch 'Join-Path \$PSScriptRoot "update-from-nas\.ps1"') "Migration commit mode must fail closed instead of falling back to a NAS-side updater."
Assert-True ($migrationText -match 'update-from-nas\.ps1 exited with code') "Migration commit mode must treat non-zero child updater exit codes as failures."
Assert-True ($migrationText -match 'Set-RevAgentCurrentProcessUtf8Console') "Migration entrypoint must force UTF-8 output even when launched with -NoProfile."
Assert-True ($migrationText -match 'Resolve-RevAgentCodexInstructionPolicy' -and $migrationText -match 'Add-RevAgentChildProcessParameter -Arguments \$updateArgs -Name "CodexInstructionPolicy"') "Migration must resolve Codex instruction policy and pass it to child updater."
Assert-True ($migrationText -match '-SkipCodexUserIntegration:\$SkipCodexUserIntegration') "Migration inventory must honor SkipCodexUserIntegration when scanning source-free artifacts."
Assert-True ($migrationText -match 'codexInstructionCleanupSkipped = \[bool\]\$preserveLocalCodexInstructions') "Migration report must expose Codex instruction cleanup skip state."
Assert-True ($migrationText -match 'Publish-RevAgentSourceFreeMigrationEvidence' -and $migrationText -match 'source-free-migration-latest\.json') "Migration dry-run must be able to publish durable source-free evidence for rollout readiness."
Assert-True ($migrationText -notmatch 'Join-Path \$machineRoot "latest\.json"') "Migration dry-run evidence must not overwrite dashboard latest.json version state."

$updaterParams = Get-ScriptParamNames -Path (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
Assert-True ($updaterParams -contains "SourceFreeMigration") "update-from-nas.ps1 must expose -SourceFreeMigration."
Assert-True ($updaterParams -contains "CodexInstructionPolicy") "update-from-nas.ps1 must expose -CodexInstructionPolicy."

$updaterText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
Assert-True ($updaterText -match 'Source migration : runtime, docs, Codex skill, and MCP registration refresh forced') "Updater migration mode must force full managed payload refresh."
Assert-True ($updaterText -match 'Invoke-RevAgentSourceFreeArtifactCleanup') "Updater migration mode must run source-free cleanup."
Assert-True ($updaterText -match 'sourceFreeMigration = \$sourceFreeMigrationState') "Updater installed state must include migration verification metadata."
Assert-True ($updaterText -match 'Resolve-CodexInstructionPolicy' -and $updaterText -match 'CodexInstructionPolicy = \$CodexInstructionPolicy') "Updater must resolve and pass Codex instruction policy to the self-contained installer."
Assert-True ($updaterText -match '-PreserveLocalCodexInstructions:\$preserveLocalCodexInstructions') "Updater must exclude preserved Codex instruction roots from source-free cleanup and guard inventories."
Assert-True ($updaterText -match '-SkipCodexUserIntegration:\$SkipCodexUserIntegration') "Updater source-free inventories must honor SkipCodexUserIntegration."
Assert-True ($updaterText -match '-not \$SourceFreeMigration[\s\S]{0,160}\$isPackageCurrent') "Updater must not return early as current during source-free migration."
Assert-True ($updaterText -match 'source-free-migration-required' -and $updaterText -match 'Get-RevAgentSourceFreeArtifactInventory') "Normal updater runs must block before update when source-free migration inventory is not clean."
Assert-True ($updaterText -match 'migrate-source-free-install\.ps1 -Mode dryRun' -and $updaterText -match 'migrate-source-free-install\.ps1 -Mode commit') "Updater migration guard must tell operators to dry-run before commit."
Assert-True ($updaterText -match 'function Get-UpdaterDetachedSignaturePath' -and $updaterText -match 'Get-UpdaterDetachedSignaturePath -ContentPath \$configuredLicensePath') "Updater must compute default detached signature paths without relying on imported helper scope."
Assert-True ($updaterText -match 'RevAgentDistributionIntegrityModule = Import-Module .*RevAgent\.DistributionIntegrity\.psm1.*-PassThru' -and $updaterText -match 'function Get-UpdaterDistributionIntegrityCommand' -and $updaterText -match 'Get-UpdaterDistributionIntegrityCommand -Name "Test-RevAgentReleaseDistributionIntegrity" -Required') "Updater must call distribution integrity helpers through the imported module object during nested migration runs."
Assert-True ($updaterText -match 'function Resolve-UpdaterDistributionIntegrityAliasCommand' -and $updaterText -match 'CommandType -ne \[System\.Management\.Automation\.CommandTypes\]::Alias' -and $updaterText -match 'ExportedFunctions\.ContainsKey\(\$definition\)') "Updater must resolve RevAgent distribution-integrity aliases to real exported module functions before invoking them."
Assert-True ($updaterText -match 'Get-UpdaterDistributionIntegrityCommand -Name "ConvertTo-RevAgentTrustedKeyMap" -Required') "Updater trusted-key loading must keep using the revAgent helper name while relying on alias target resolution."

$publishText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1")
Assert-True ($publishText -match 'migrate-source-free-install\.ps1') "Publisher must include the source-free migration tool in user packs and NAS tools."
Assert-True ($publishText -match 'RevAgent\.SourceFreeMigration\.psm1') "Publisher manifest must fingerprint the migration helper module."

$installText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\install-self-contained.ps1")
Assert-True ($installText -match 'migrate-source-free-install\.ps1') "Self-contained installer must refresh the migration tool in the local updater folder."
Assert-True ($installText -match '\[string\]\$CodexInstructionPolicy = ""' -and $installText -match 'preserve-local') "Self-contained installer must expose Codex instruction policy."

$installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
Assert-True ($installTaskText -match 'localMigrationTool' -and $installTaskText -match 'migrate-source-free-install\.ps1') "Updater task installer must copy the migration tool locally."
Assert-True ($installTaskText -match 'codexInstructionPolicy = \$CodexInstructionPolicy') "Updater task installer must persist Codex instruction policy."

Write-Host "Source-free migration tests passed." -ForegroundColor Green
