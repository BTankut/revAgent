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

function Import-ScriptFunctionForTest {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$FunctionName
    )

    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    Assert-Equal $errors.Count 0 "PowerShell parse errors found in $Path."
    $functionAst = @($ast.FindAll({
                param($node)
                return ($node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                    [string]::Equals($node.Name, $FunctionName, [System.StringComparison]::OrdinalIgnoreCase))
            }, $true) | Select-Object -First 1)
    Assert-Equal $functionAst.Count 1 "Function '$FunctionName' was not found exactly once in $Path."
    return [scriptblock]::Create([string]$functionAst[0].Extent.Text)
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
    Assert-Equal $dryRun.artifactCount 9 "Dry-run should detect all machine-managed source/developer artifacts."
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
    Assert-Equal $skipUserDryRun.artifactCount 9 "Retired per-user Codex skill roots must stay outside broad source cleanup."
    Assert-Equal (@($skipUserDryRun.artifacts | Where-Object { [string]$_.rootLabel -eq "user Codex skill" }).Count) 0 "SkipCodexUserIntegration cleanup must not classify user Codex skill roots as cleanup artifacts."
    Assert-Equal (@($skipUserDryRun.artifacts | Where-Object { [string]$_.rootLabel -eq "machine Codex skill" }).Count) 1 "SkipCodexUserIntegration cleanup must still inspect the machine Codex skill root."

    $machineScopeDryRun = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -Scope machine
    Assert-Equal $machineScopeDryRun.scope "machine" "Machine-scoped source-free cleanup must attest its scope."
    Assert-Equal $machineScopeDryRun.artifactCount 9 "Machine scope must exclude every user-profile source artifact even when UserProfileRoot is supplied."
    Assert-Equal (@($machineScopeDryRun.artifacts | Where-Object { [string]$_.rootScope -eq "user" }).Count) 0 "Machine scope must never inventory a user-profile managed root."

    $userScopeDryRun = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -Scope user
    Assert-Equal $userScopeDryRun.scope "user" "User-scoped source-free cleanup must attest its scope."
    Assert-Equal $userScopeDryRun.artifactCount 0 "User source cleanup must leave retired real/custom Codex skill directories to bounded canonical inventory."
    Assert-Equal (@($userScopeDryRun.artifacts | Where-Object { [string]$_.rootScope -ne "user" }).Count) 0 "User scope must not inventory machine roots."

    $preservedUserScopeDryRun = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -PreserveLocalCodexInstructions `
        -Scope user
    Assert-Equal $preservedUserScopeDryRun.artifactCount 0 "Developer preserve-local policy must make user-scoped source cleanup a no-op."

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
    Assert-Equal ([int]$report.before.artifactCount) 9 "Migration dry-run report should include machine source/developer artifact count."
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

    $outsideUserTree = Join-Path $tempRoot "outside-user-source-tree"
    New-Item -ItemType Directory -Path (Join-Path $outsideUserTree "src") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $outsideUserTree "src\must-survive.ts") -Value "external" -Encoding ASCII
    $userTreeJunction = Join-Path $userProfileRoot ".codex\skills\revAgent\linked-out"
    New-Item -ItemType Junction -Path $userTreeJunction -Target $outsideUserTree | Out-Null
    $machineScopeWithPoisonedUserTree = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -Scope machine
    Assert-Equal $machineScopeWithPoisonedUserTree.artifactCount 9 "Machine scope must not observe even an unsafe reparse point inside the supplied user profile."
    Assert-Equal (@($machineScopeWithPoisonedUserTree.artifacts | Where-Object { [string]$_.kind -eq "unsafeTopology" }).Count) 0 "A poisoned user tree must remain entirely outside elevated machine inventory."
    $unsafeUserCommit = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -Scope user `
        -Commit
    Assert-Equal $unsafeUserCommit.removedCount 0 "A reparse point anywhere in user scope must block the entire cleanup before deletion."
    Assert-Equal $unsafeUserCommit.failedCount 0 "Retired user Codex skill trees must not be traversed by broad source cleanup."
    Assert-True (Test-Path -LiteralPath (Join-Path $userProfileRoot ".codex\skills\revAgent\src\skill.ts") -PathType Leaf) "Broad user source cleanup must preserve a real retired skill copy."
    Assert-True (Test-Path -LiteralPath (Join-Path $outsideUserTree "src\must-survive.ts") -PathType Leaf) "User cleanup must never traverse a reparse point into external content."
    # Windows PowerShell 5.1's Remove-Item has a junction-specific null
    # reference bug. Directory.Delete removes only the reparse entry and does
    # not recurse into its target.
    [System.IO.Directory]::Delete($userTreeJunction)

    $outsideCodexHomeRejected = $false
    try {
        Invoke-RevAgentSourceFreeArtifactCleanup `
            -InstallRoot $installRoot `
            -PackageTarget $packageTarget `
            -ServerTarget $serverTarget `
            -UserProfileRoot $userProfileRoot `
            -TargetCodexHome (Join-Path $tempRoot "outside-codex-home") `
            -Scope user | Out-Null
    }
    catch {
        $outsideCodexHomeRejected = $_.Exception.Message -match "strictly inside the authenticated user profile"
    }
    Assert-True $outsideCodexHomeRejected "Managed user cleanup must reject TargetCodexHome outside the authenticated profile."

    $preservePoisonedCodexHome = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -TargetCodexHome (Join-Path $tempRoot "outside-preserve-local-codex-home") `
        -PreserveLocalCodexInstructions `
        -Scope user `
        -Commit
    Assert-True ([bool]$preservePoisonedCodexHome.success) "Preserve-local user cleanup must be a zero-traversal no-op even when an irrelevant TargetCodexHome is poisoned."

    Write-Host "Test transaction-wide source-free hardlink and updater-backup topology guards"
    $outsideHardlink = Join-Path $tempRoot "outside-hardlink-source.ts"
    Set-Content -LiteralPath $outsideHardlink -Value "shared source" -Encoding ASCII
    [System.IO.File]::SetAttributes($outsideHardlink, [System.IO.FileAttributes]::ReadOnly)
    $managedHardlink = Join-Path $packageTarget "src\shared.ts"
    New-Item -ItemType HardLink -Path $managedHardlink -Target $outsideHardlink | Out-Null
    $outsideHardlinkBytes = [System.IO.File]::ReadAllBytes($outsideHardlink)
    $outsideHardlinkAttributes = [System.IO.File]::GetAttributes($outsideHardlink)
    $outsideHardlinkSddl = (Get-Acl -LiteralPath $outsideHardlink).Sddl

    $hardlinkBlockedCommit = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -Commit
    Assert-Equal $hardlinkBlockedCommit.removedCount 0 "One non-unit hardlink under a matched source directory must abort every source-free deletion."
    Assert-True ($hardlinkBlockedCommit.failedCount -gt 0 -and @($hardlinkBlockedCommit.artifacts | Where-Object { [string]$_.reason -eq "non_unit_hardlink_in_cleanup_candidate" }).Count -eq 1) "Source-free hardlink preflight must be structured and transaction-wide."
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][System.IO.File]::ReadAllBytes($outsideHardlink), [byte[]]$outsideHardlinkBytes)) "Blocked source cleanup changed external hardlink bytes."
    Assert-Equal ([System.IO.File]::GetAttributes($outsideHardlink)) $outsideHardlinkAttributes "Blocked source cleanup changed external hardlink attributes."
    Assert-Equal ((Get-Acl -LiteralPath $outsideHardlink).Sddl) $outsideHardlinkSddl "Blocked source cleanup changed external hardlink ACL."
    Assert-True (Test-Path -LiteralPath (Join-Path $serverTarget "src\index.ts") -PathType Leaf) "Hardlink preflight must prevent partial deletion of unrelated candidates."
    [System.IO.File]::SetAttributes($outsideHardlink, [System.IO.FileAttributes]::Normal)
    [System.IO.File]::Delete($managedHardlink)

    $raceExternalHardlink = Join-Path $tempRoot "outside-race-hardlink-source.ts"
    Set-Content -LiteralPath $raceExternalHardlink -Value "race source" -Encoding ASCII
    [System.IO.File]::SetAttributes($raceExternalHardlink, [System.IO.FileAttributes]::ReadOnly)
    $raceManagedHardlink = Join-Path $packageTarget "src\race-shared.ts"
    $raceHookEvidence = [pscustomobject]@{ bytes = $null; attributes = $null; sddl = "" }
    $raceHook = {
        New-Item -ItemType HardLink -Path $raceManagedHardlink -Target $raceExternalHardlink | Out-Null
        $raceHookEvidence.bytes = [System.IO.File]::ReadAllBytes($raceExternalHardlink)
        $raceHookEvidence.attributes = [System.IO.File]::GetAttributes($raceExternalHardlink)
        $raceHookEvidence.sddl = (Get-Acl -LiteralPath $raceExternalHardlink).Sddl
    }.GetNewClosure()
    $raceBlockedCommit = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -Commit `
        -TestAfterTransactionPreflightHook $raceHook
    Assert-Equal $raceBlockedCommit.removedCount 0 "A hardlink introduced after the global preflight must be caught before the first deletion."
    Assert-True ($raceBlockedCommit.failedCount -gt 0 -and [string]$raceBlockedCommit.failed[0].error -match "non-unit hardlink") "Mutation-edge revalidation must report the injected hardlink race."
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][System.IO.File]::ReadAllBytes($raceExternalHardlink), [byte[]]$raceHookEvidence.bytes)) "Race guard changed external hardlink bytes."
    Assert-Equal ([System.IO.File]::GetAttributes($raceExternalHardlink)) $raceHookEvidence.attributes "Race guard changed external hardlink attributes."
    Assert-Equal ((Get-Acl -LiteralPath $raceExternalHardlink).Sddl) $raceHookEvidence.sddl "Race guard changed external hardlink ACL."
    Assert-True (Test-Path -LiteralPath (Join-Path $serverTarget "src\index.ts") -PathType Leaf) "Injected hardlink race must not allow partial deletion."
    [System.IO.File]::SetAttributes($raceExternalHardlink, [System.IO.FileAttributes]::Normal)
    [System.IO.File]::Delete($raceManagedHardlink)

    Write-Host "Test queued directory junction swap cannot escape the cleanup boundary"
    $junctionRaceRoot = Join-Path $tempRoot "queued-junction-race"
    $junctionRaceInstallRoot = Join-Path $junctionRaceRoot "ProgramData\DPE\revAgent"
    $junctionRacePackageTarget = Join-Path $junctionRaceInstallRoot "package"
    $junctionRaceServerTarget = Join-Path $junctionRaceInstallRoot "runtime"
    $junctionRaceQueuedPath = Join-Path $junctionRacePackageTarget "src\queued"
    $junctionRaceExternalRoot = Join-Path $junctionRaceRoot "external-target"
    $junctionRaceExternalFile = Join-Path $junctionRaceExternalRoot "must-survive.txt"
    New-Item -ItemType Directory -Path $junctionRaceQueuedPath, $junctionRaceServerTarget, $junctionRaceExternalRoot -Force | Out-Null
    Set-Content -LiteralPath $junctionRaceExternalFile -Value "external queued-junction evidence" -Encoding ASCII
    [System.IO.File]::SetAttributes($junctionRaceExternalFile, [System.IO.FileAttributes]::ReadOnly)
    $junctionRaceExternalBytes = [System.IO.File]::ReadAllBytes($junctionRaceExternalFile)
    $junctionRaceExternalAttributes = [System.IO.File]::GetAttributes($junctionRaceExternalFile)
    $junctionRaceExternalSddl = (Get-Acl -LiteralPath $junctionRaceExternalFile).Sddl
    $junctionSwapEvidence = [pscustomobject]@{ Performed = $false }
    $junctionRaceHook = {
        param([string]$DirectoryPath)
        if (-not [bool]$junctionSwapEvidence.Performed -and
            [string]::Equals(
                [System.IO.Path]::GetFullPath($DirectoryPath).TrimEnd("\"),
                [System.IO.Path]::GetFullPath($junctionRaceQueuedPath).TrimEnd("\"),
                [System.StringComparison]::OrdinalIgnoreCase)) {
            [System.IO.Directory]::Delete($junctionRaceQueuedPath, $false)
            New-Item -ItemType Junction -Path $junctionRaceQueuedPath -Target $junctionRaceExternalRoot | Out-Null
            $junctionSwapEvidence.Performed = $true
        }
    }.GetNewClosure()
    try {
        $junctionRaceCommit = Invoke-RevAgentSourceFreeArtifactCleanup `
            -InstallRoot $junctionRaceInstallRoot `
            -PackageTarget $junctionRacePackageTarget `
            -ServerTarget $junctionRaceServerTarget `
            -Scope machine `
            -Commit `
            -TestBeforeRecursiveDeleteDirectoryEnumerationHook $junctionRaceHook
        Assert-True ([bool]$junctionSwapEvidence.Performed) "Queued-directory race hook did not replace the pending directory with a junction."
        Assert-Equal $junctionRaceCommit.removedCount 0 "A queued-directory junction swap must abort before deleting the cleanup candidate."
        Assert-True ($junctionRaceCommit.failedCount -gt 0 -and [string]$junctionRaceCommit.failed[0].error -match "queued directory changed exact identity|topology") "Queued-directory junction swap must report an exact identity/topology failure."
        Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][System.IO.File]::ReadAllBytes($junctionRaceExternalFile), [byte[]]$junctionRaceExternalBytes)) "Queued-directory junction guard changed external bytes."
        Assert-Equal ([System.IO.File]::GetAttributes($junctionRaceExternalFile)) $junctionRaceExternalAttributes "Queued-directory junction guard changed external attributes."
        Assert-Equal ((Get-Acl -LiteralPath $junctionRaceExternalFile).Sddl) $junctionRaceExternalSddl "Queued-directory junction guard changed external ACL."
    }
    finally {
        if ($null -ne (Get-Item -LiteralPath $junctionRaceQueuedPath -Force -ErrorAction SilentlyContinue)) {
            [System.IO.Directory]::Delete($junctionRaceQueuedPath, $false)
        }
        [System.IO.File]::SetAttributes($junctionRaceExternalFile, [System.IO.FileAttributes]::Normal)
    }

    Write-Host "Test foreign retained candidate handle aborts before source-free deletion"
    $retainedRaceRoot = Join-Path $tempRoot "retained-handle-race"
    $retainedRaceInstallRoot = Join-Path $retainedRaceRoot "ProgramData\DPE\revAgent"
    $retainedRacePackageTarget = Join-Path $retainedRaceInstallRoot "package"
    $retainedRaceServerTarget = Join-Path $retainedRaceInstallRoot "runtime"
    $retainedRaceFile = Join-Path $retainedRacePackageTarget "src\retained.ts"
    New-Item -ItemType Directory -Path (Split-Path -Parent $retainedRaceFile), $retainedRaceServerTarget -Force | Out-Null
    Set-Content -LiteralPath $retainedRaceFile -Value "retained" -Encoding ASCII
    $retainedRaceSignal = Join-Path $retainedRaceRoot "foreign-ready.txt"
    $retainedRaceJob = Start-Job -ArgumentList $retainedRaceFile, $retainedRaceSignal -ScriptBlock {
        param([string]$CandidatePath, [string]$SignalPath)
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RevAgentSourceFreeForeignHandle {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    public static SafeFileHandle OpenWriteDac(string path) {
        SafeFileHandle handle = CreateFileW(path, 0x00040000u, 7u, IntPtr.Zero, 3u, 0x00200000u, IntPtr.Zero);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        return handle;
    }
}
'@
        $stream = [RevAgentSourceFreeForeignHandle]::OpenWriteDac($CandidatePath)
        try {
            [System.IO.File]::WriteAllText($SignalPath, "ready")
            Start-Sleep -Seconds 30
        }
        finally {
            $stream.Dispose()
        }
    }
    try {
        for ($waitIndex = 0; $waitIndex -lt 100 -and -not (Test-Path -LiteralPath $retainedRaceSignal); $waitIndex++) {
            Start-Sleep -Milliseconds 50
        }
        Assert-True (Test-Path -LiteralPath $retainedRaceSignal -PathType Leaf) "Foreign source-free retained-handle test process did not become ready."
        $retainedRaceCommit = Invoke-RevAgentSourceFreeArtifactCleanup `
            -InstallRoot $retainedRaceInstallRoot `
            -PackageTarget $retainedRacePackageTarget `
            -ServerTarget $retainedRaceServerTarget `
            -Scope machine `
            -Commit
        Assert-Equal $retainedRaceCommit.removedCount 0 "Foreign retained candidate handle must abort the transaction before deletion."
        Assert-True ($retainedRaceCommit.failedCount -gt 0 -and [string]$retainedRaceCommit.failed[0].error -match "Another process already retains a handle") "Foreign retained candidate handle must be reported without PROCESS_DUP_HANDLE inspection."
        Assert-True (Test-Path -LiteralPath $retainedRaceFile -PathType Leaf) "Foreign retained-handle rejection must leave candidate bytes untouched."
    }
    finally {
        Stop-Job -Job $retainedRaceJob -ErrorAction SilentlyContinue
        Remove-Job -Job $retainedRaceJob -Force -ErrorAction SilentlyContinue
    }

    $backupRoot = Join-Path $installRoot "updater\backups"
    Remove-Item -LiteralPath $backupRoot -Recurse -Force
    $outsideBackupTree = Join-Path $tempRoot "outside-backup-tree"
    New-Item -ItemType Directory -Path (Join-Path $outsideBackupTree "revit-mcp-skill.backup-unsafe\src") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $outsideBackupTree "revit-mcp-skill.backup-unsafe\src\must-survive.ts") -Value "external backup" -Encoding ASCII
    New-Item -ItemType Junction -Path $backupRoot -Target $outsideBackupTree | Out-Null
    $backupTopologyBlocked = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -Scope machine `
        -Commit
    Assert-Equal $backupTopologyBlocked.removedCount 0 "A reparse-backed updater/backups root must abort every source-free deletion."
    Assert-True (@($backupTopologyBlocked.artifacts | Where-Object { [string]$_.reason -eq "reparse_point_in_backup_root_path" }).Count -eq 1) "Updater backup reparse discovery must be structured unsafe inventory."
    Assert-True (Test-Path -LiteralPath (Join-Path $outsideBackupTree "revit-mcp-skill.backup-unsafe\src\must-survive.ts") -PathType Leaf) "Updater backup discovery must not traverse or mutate a reparse target."
    [System.IO.Directory]::Delete($backupRoot, $false)
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $nestedBackupJunction = Join-Path $backupRoot "revit-mcp-skill.backup-junction"
    New-Item -ItemType Junction -Path $nestedBackupJunction -Target (Join-Path $outsideBackupTree "revit-mcp-skill.backup-unsafe") | Out-Null
    $nestedBackupTopologyBlocked = Invoke-RevAgentSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -Scope machine `
        -Commit
    Assert-Equal $nestedBackupTopologyBlocked.removedCount 0 "A reparse-backed discovered backup directory must abort every source-free deletion."
    Assert-True (@($nestedBackupTopologyBlocked.artifacts | Where-Object { [string]$_.reason -eq "reparse_point_backup_directory" }).Count -eq 1) "Backup child reparse discovery must be unsafe inventory before target traversal."
    Assert-True (Test-Path -LiteralPath (Join-Path $outsideBackupTree "revit-mcp-skill.backup-unsafe\src\must-survive.ts") -PathType Leaf) "Backup child discovery must not mutate its external target."
    [System.IO.Directory]::Delete($nestedBackupJunction, $false)
    New-Item -ItemType Directory -Path (Join-Path $backupRoot "revit-mcp-skill.backup-20260623\src") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $backupRoot "revit-mcp-skill.backup-20260623\src\old.ts") -Value "source" -Encoding ASCII

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
    Assert-True (Test-Path -LiteralPath (Join-Path $userProfileRoot ".codex\skills\revAgent\src\skill.ts") -PathType Leaf) "Canonical user migration, not broad source cleanup, owns retired per-user skill handling."

    Write-Host "Test bounded canonical legacy-surface inventory and cleanup"
    $canonicalFixtureRoot = Join-Path $tempRoot "canonical-legacy-surface"
    $canonicalCommonRoot = Join-Path $canonicalFixtureRoot "ProgramData"
    $canonicalInstallRoot = Join-Path $canonicalCommonRoot "DPE\revAgent"
    $canonicalUserRoot = Join-Path $canonicalFixtureRoot "Users\Operator"
    $canonicalRoamingRoot = Join-Path $canonicalUserRoot "AppData\Roaming"
    $canonicalLegacyRoot = Join-Path $canonicalCommonRoot "DPE\RevitMCP"

    foreach ($relativePath in @(
            "package\payload",
            "runtime\build",
            "updater\logs",
            "state\managed",
            "revit-plugin\revit_mcp_plugin",
            "commands\CommandSet",
            "codex\skills\revit-mcp",
            "dependencies\npm",
            "addons\dashboard",
            "cloudflared",
            "reports",
            "unknown-owned-by-operator"
        )) {
        New-Item -ItemType Directory -Path (Join-Path $canonicalLegacyRoot $relativePath) -Force | Out-Null
    }
    foreach ($relativePath in @(
            "package\payload\package.txt",
            "runtime\build\index.js",
            "updater\logs\update.log",
            "state\managed\state.json",
            "revit-plugin\revit_mcp_plugin\plugin.dll",
            "commands\CommandSet\command.json",
            "codex\skills\revit-mcp\SKILL.md",
            "dependencies\npm\cache.txt",
            "addons\dashboard\keep.txt",
            "cloudflared\keep.json",
            "reports\keep.json",
            "unknown-owned-by-operator\keep.txt"
        )) {
        Set-Content -LiteralPath (Join-Path $canonicalLegacyRoot $relativePath) -Value "fixture" -Encoding ASCII
    }
    Set-Content -LiteralPath (Join-Path $canonicalLegacyRoot ".revit-mcp-programdata-install") -Value "legacy" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $canonicalLegacyRoot ".revagent-programdata-install") -Value "legacy" -Encoding ASCII

    $canonicalOutsideHardlink = Join-Path $canonicalFixtureRoot "external-canonical-hardlink.bin"
    Set-Content -LiteralPath $canonicalOutsideHardlink -Value "external canonical bytes" -Encoding ASCII
    [System.IO.File]::SetAttributes($canonicalOutsideHardlink, [System.IO.FileAttributes]::ReadOnly)
    $canonicalManagedHardlink = Join-Path $canonicalLegacyRoot "package\payload\shared-hardlink.bin"
    New-Item -ItemType HardLink -Path $canonicalManagedHardlink -Target $canonicalOutsideHardlink | Out-Null
    $canonicalOutsideBytes = [System.IO.File]::ReadAllBytes($canonicalOutsideHardlink)
    $canonicalOutsideAttributes = [System.IO.File]::GetAttributes($canonicalOutsideHardlink)
    $canonicalOutsideSddl = (Get-Acl -LiteralPath $canonicalOutsideHardlink).Sddl

    $machineNestedTarget = Join-Path $canonicalFixtureRoot "machine-nested-target"
    $machineNestedLink = Join-Path $canonicalLegacyRoot "state\managed\external-link"
    New-Item -ItemType Directory -Path $machineNestedTarget -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $machineNestedTarget "must-survive.txt") -Value "preserve" -Encoding ASCII
    New-Item -ItemType Junction -Path $machineNestedLink -Target $machineNestedTarget | Out-Null

    $machineAddinsRoot = Join-Path $canonicalCommonRoot "Autodesk\Revit\Addins"
    foreach ($version in @("2022", "2024")) {
        $versionRoot = Join-Path $machineAddinsRoot $version
        foreach ($payloadName in @("revit_mcp_plugin", "revit-mcp-plugin")) {
            New-Item -ItemType Directory -Path (Join-Path $versionRoot $payloadName) -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $versionRoot "$payloadName\plugin.dll") -Value "legacy" -Encoding ASCII
        }
        foreach ($manifestName in @("mcp-servers-for-revit.addin", "mcp_servers_for_revit.addin", "revit-mcp.addin", "revit-mcp.addin.disabled-self-contained", "revit-mcp.addin.disabled-20260410", "revit-mcp.addin.disabled-duplicate-20260410")) {
            Set-Content -LiteralPath (Join-Path $versionRoot $manifestName) -Value "legacy" -Encoding ASCII
        }
        Set-Content -LiteralPath (Join-Path $versionRoot "revit-mcp-plugin.dll") -Value "legacy binary" -Encoding ASCII
        New-Item -ItemType Directory -Path (Join-Path $versionRoot "Commands\SampleCommandset\$version") -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $versionRoot "Commands\SampleCommandset\$version\revit-mcp-sdk.dll") -Value "legacy nested binary" -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $versionRoot "Commands\SampleCommandset\$version\operator-owned.dll") -Value "preserve nested sibling" -Encoding ASCII
        New-Item -ItemType Directory -Path (Join-Path $versionRoot "ForeignVendor\lib") -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $versionRoot "ForeignVendor\lib\revit-mcp-sdk.dll") -Value "foreign vendor collision" -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $versionRoot "revAgent.addin") -Value "canonical" -Encoding ASCII
        New-Item -ItemType Directory -Path (Join-Path $versionRoot "revAgentPlugin") -Force | Out-Null
    }
    $machineVersionLinkTarget = Join-Path $canonicalFixtureRoot "machine-version-link-target"
    $machineVersionLink = Join-Path $machineAddinsRoot "2026"
    New-Item -ItemType Directory -Path $machineVersionLinkTarget -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $machineVersionLinkTarget "mcp-servers-for-revit.addin") -Value "must survive" -Encoding ASCII
    New-Item -ItemType Junction -Path $machineVersionLink -Target $machineVersionLinkTarget | Out-Null

    $legacyNpmNamespace = Join-Path $canonicalInstallRoot "dependencies\npm\revit-mcp"
    $canonicalNpmNamespace = Join-Path $canonicalInstallRoot "dependencies\npm\revagent-runtime"
    New-Item -ItemType Directory -Path (Join-Path $legacyNpmNamespace "legacy-hash") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $canonicalNpmNamespace "current-hash") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $legacyNpmNamespace "legacy-hash\cache.bin") -Value "legacy" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $canonicalNpmNamespace "current-hash\cache.bin") -Value "current" -Encoding ASCII
    New-Item -ItemType Directory -Path $canonicalRoamingRoot -Force | Out-Null

    $machineDryRun = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
        -Scope machine `
        -InstallRoot $canonicalInstallRoot `
        -UserProfileRoot $canonicalUserRoot `
        -RoamingAppDataRoot $canonicalRoamingRoot `
        -CommonAppDataRoot $canonicalCommonRoot
    Assert-Equal ([string]$machineDryRun.mode) "dryRun" "Canonical machine cleanup must default to dry-run."
    Assert-Equal ([string]$machineDryRun.scope) "machine" "Canonical machine cleanup must report explicit scope."
    Assert-Equal ([int]$machineDryRun.removedCount) 0 "Canonical machine dry-run must not remove anything."
    Assert-True ([int]$machineDryRun.matchedCount -gt 0) "Canonical machine dry-run must match exact managed legacy surfaces."
    Assert-True (@($machineDryRun.matched | Where-Object { [string]$_.surface -eq "canonical_npm_legacy_namespace" -and [string]$_.path -eq $legacyNpmNamespace }).Count -eq 1) "Canonical machine inventory must match only the exact legacy npm namespace."
    foreach ($preservedName in @("addons", "cloudflared", "reports", "unknown-owned-by-operator")) {
        Assert-True (@($machineDryRun.preserved | Where-Object { (Split-Path -Leaf ([string]$_.path)) -eq $preservedName -and [string]$_.reason -eq "not_allowlisted_legacy_install_child" }).Count -eq 1) "Canonical machine inventory must report preserved legacy-root child '$preservedName'."
    }
    Assert-True (@($machineDryRun.preserved | Where-Object { [string]$_.path -eq (Join-Path $canonicalLegacyRoot "state") -and [string]$_.reason -eq "nested_reparse_point_preserved" }).Count -eq 1) "A managed legacy-root child containing a nested reparse point must be preserved."
    Assert-True (@($machineDryRun.preserved | Where-Object { [string]$_.path -eq $machineVersionLink -and [string]$_.reason -eq "revit_addin_version_reparse_point" }).Count -eq 1) "A reparse-point Revit version folder must be preserved without traversal."
    Assert-True ([bool]$machineDryRun.actionRequired) "Unsafe exact managed legacy surfaces must require operator action."
    Assert-True ([int]$machineDryRun.blockingPreservedCount -ge 2) "Unsafe managed reparse surfaces must be classified as blocking preservation."
    Assert-True (@($machineDryRun.blockingPreserved | Where-Object { [string]$_.reason -eq "non_unit_hardlink_in_candidate" -and [string]$_.path -eq $canonicalManagedHardlink }).Count -eq 1) "Canonical inventory must inspect every file under a matched directory and classify non-unit hardlinks as blocking."
    Assert-Equal (@($machineDryRun.matched | Where-Object { [string]$_.path -like "*ForeignVendor*" }).Count) 0 "Foreign-vendor DLLs that collide by basename must never match canonical cleanup."
    Assert-True (Test-Path -LiteralPath (Join-Path $canonicalLegacyRoot "package")) "Canonical machine dry-run removed an allowlisted legacy child."

    $canonicalInstallAclBeforeBlockedCommit = (Get-Acl -LiteralPath $canonicalInstallRoot).Sddl
    $blockedMachineCommit = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
        -Scope machine `
        -InstallRoot $canonicalInstallRoot `
        -UserProfileRoot $canonicalUserRoot `
        -RoamingAppDataRoot $canonicalRoamingRoot `
        -CommonAppDataRoot $canonicalCommonRoot `
        -Commit
    Assert-True (-not [bool]$blockedMachineCommit.success) "Canonical cleanup must fail closed while unsafe exact managed legacy surfaces remain."
    Assert-True ([bool]$blockedMachineCommit.actionRequired) "Blocked canonical cleanup must report actionRequired."
    Assert-Equal ([int]$blockedMachineCommit.removedCount) 0 "A blocking preflight finding must prevent every destructive deletion."
    Assert-True (Test-Path -LiteralPath (Join-Path $canonicalLegacyRoot "package")) "Blocked preflight must leave otherwise removable legacy payloads untouched."
    Assert-Equal ((Get-Acl -LiteralPath $canonicalInstallRoot).Sddl) $canonicalInstallAclBeforeBlockedCommit "Canonical hardlink/topology preflight must complete before any InstallRoot ACL mutation."
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][System.IO.File]::ReadAllBytes($canonicalOutsideHardlink), [byte[]]$canonicalOutsideBytes)) "Blocked canonical cleanup changed external hardlink bytes."
    Assert-Equal ([System.IO.File]::GetAttributes($canonicalOutsideHardlink)) $canonicalOutsideAttributes "Blocked canonical cleanup changed external hardlink attributes."
    Assert-Equal ((Get-Acl -LiteralPath $canonicalOutsideHardlink).Sddl) $canonicalOutsideSddl "Blocked canonical cleanup changed external hardlink ACL."

    [System.IO.Directory]::Delete($machineNestedLink, $false)
    [System.IO.Directory]::Delete($machineVersionLink, $false)
    [System.IO.File]::SetAttributes($canonicalOutsideHardlink, [System.IO.FileAttributes]::Normal)
    [System.IO.File]::Delete($canonicalManagedHardlink)

    $canonicalTranscriptPath = Join-Path $tempRoot "canonical-cleanup-transcript.txt"
    $canonicalTranscriptStarted = $false
    try {
        Start-Transcript -LiteralPath $canonicalTranscriptPath -Force | Out-Null
        $canonicalTranscriptStarted = $true
        $machineCommit = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
            -Scope machine `
            -InstallRoot $canonicalInstallRoot `
            -UserProfileRoot $canonicalUserRoot `
            -RoamingAppDataRoot $canonicalRoamingRoot `
            -CommonAppDataRoot $canonicalCommonRoot `
            -Commit
    }
    finally {
        if ($canonicalTranscriptStarted) {
            Stop-Transcript | Out-Null
        }
    }
    $canonicalTranscript = Get-Content -LiteralPath $canonicalTranscriptPath -Raw
    Assert-True ($canonicalTranscript -notmatch 'PS>TerminatingError\(\): "Canonical legacy cleanup ACL is not protected') "Canonical cleanup must not use caught ACL assertion failures as normal probe control flow."
    Assert-Equal ([string]$machineCommit.mode) "commit" "Canonical machine commit must report commit mode."
    Assert-True ([bool]$machineCommit.success) "Canonical machine fixture cleanup must report success after blockers are removed."
    Assert-Equal ([int]$machineCommit.failedCount) 0 "Canonical machine fixture cleanup must not fail."
    Assert-Equal ([int]$machineCommit.remainingCount) 0 "Canonical machine fixture must have no remaining matched artifacts."
    Assert-True ([int]$machineCommit.removedCount -gt 0) "Canonical machine commit must report removed artifacts."
    foreach ($removedName in @("package", "runtime", "updater", "revit-plugin", "commands", "codex", "dependencies")) {
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $canonicalLegacyRoot $removedName))) "Allowlisted legacy-root child '$removedName' was not removed."
    }
    Assert-True (Test-Path -LiteralPath (Join-Path $canonicalLegacyRoot "state")) "Nested-reparse legacy state must be preserved."
    foreach ($preservedName in @("addons", "cloudflared", "reports", "unknown-owned-by-operator")) {
        Assert-True (Test-Path -LiteralPath (Join-Path $canonicalLegacyRoot $preservedName)) "Protected legacy-root child '$preservedName' was removed."
    }
    Assert-True (Test-Path -LiteralPath (Join-Path $machineNestedTarget "must-survive.txt") -PathType Leaf) "Nested junction target content must survive machine cleanup."
    Assert-True (Test-Path -LiteralPath (Join-Path $machineVersionLinkTarget "mcp-servers-for-revit.addin") -PathType Leaf) "Reparse-point Revit version target content must survive machine cleanup."
    Assert-True (-not (Test-Path -LiteralPath $legacyNpmNamespace)) "Exact legacy npm namespace must be removed."
    Assert-True (Test-Path -LiteralPath (Join-Path $canonicalNpmNamespace "current-hash\cache.bin") -PathType Leaf) "Canonical npm namespace sibling must be preserved."
    foreach ($version in @("2022", "2024")) {
        $versionRoot = Join-Path $machineAddinsRoot $version
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $versionRoot "mcp-servers-for-revit.addin"))) "Legacy machine add-in manifest was not removed for Revit $version."
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $versionRoot "revit_mcp_plugin"))) "Legacy machine add-in payload was not removed for Revit $version."
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $versionRoot "revit-mcp-plugin"))) "Hyphenated legacy machine add-in payload was not removed for Revit $version."
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $versionRoot "revit-mcp.addin.disabled-20260410"))) "Bounded disabled legacy machine add-in manifest was not removed for Revit $version."
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $versionRoot "revit-mcp-plugin.dll"))) "Exact legacy machine add-in binary was not removed for Revit $version."
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $versionRoot "Commands\SampleCommandset\$version\revit-mcp-sdk.dll"))) "Nested exact legacy machine SDK binary was not removed for Revit $version."
        Assert-True (Test-Path -LiteralPath (Join-Path $versionRoot "Commands\SampleCommandset\$version\operator-owned.dll") -PathType Leaf) "Nested non-legacy add-in sibling must be preserved for Revit $version."
        Assert-True (Test-Path -LiteralPath (Join-Path $versionRoot "ForeignVendor\lib\revit-mcp-sdk.dll") -PathType Leaf) "Foreign-vendor DLL with a colliding basename must be preserved for Revit $version."
        Assert-True (Test-Path -LiteralPath (Join-Path $versionRoot "revAgent.addin") -PathType Leaf) "Canonical machine revAgent add-in manifest must be preserved for Revit $version."
        Assert-True (Test-Path -LiteralPath (Join-Path $versionRoot "revAgentPlugin") -PathType Container) "Canonical machine revAgent add-in payload must be preserved for Revit $version."
    }

    Write-Host "Test canonical legacy root is removed only after bounded children leave it empty"
    $emptyRootFixture = Join-Path $tempRoot "canonical-empty-legacy-root"
    $emptyCommonRoot = Join-Path $emptyRootFixture "ProgramData"
    $emptyInstallRoot = Join-Path $emptyCommonRoot "DPE\revAgent"
    $emptyUserRoot = Join-Path $emptyRootFixture "Users\Operator"
    $emptyRoamingRoot = Join-Path $emptyUserRoot "AppData\Roaming"
    $emptyLegacyRoot = Join-Path $emptyCommonRoot "DPE\RevitMCP"
    New-Item -ItemType Directory -Path (Join-Path $emptyLegacyRoot "package\payload") -Force | Out-Null
    New-Item -ItemType Directory -Path $emptyInstallRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $emptyRoamingRoot -Force | Out-Null
    $emptyRootCommit = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
        -Scope machine `
        -InstallRoot $emptyInstallRoot `
        -UserProfileRoot $emptyUserRoot `
        -RoamingAppDataRoot $emptyRoamingRoot `
        -CommonAppDataRoot $emptyCommonRoot `
        -Commit
    Assert-Equal ([int]$emptyRootCommit.failedCount) 0 "Empty-after-cleanup legacy root fixture must not fail."
    Assert-True (-not (Test-Path -LiteralPath $emptyLegacyRoot)) "Legacy RevitMCP root must be removed after, and only after, exact allowlisted children leave it empty."
    Assert-True (@($emptyRootCommit.removed | Where-Object { [string]$_.surface -eq "legacy_install_root" -and [string]$_.deletionMode -eq "emptyDirectory" }).Count -eq 1) "Legacy root removal must be reported as an empty-directory-only operation."

    Write-Host "Test machine scope ignores poisoned user environment values"
    $savedUserProfile = $env:USERPROFILE
    $savedAppData = $env:APPDATA
    try {
        $env:USERPROFILE = ""
        $env:APPDATA = ""
        $machineWithoutUserRoots = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
            -Scope machine `
            -InstallRoot $emptyInstallRoot `
            -CommonAppDataRoot $emptyCommonRoot
        Assert-Equal ([string]$machineWithoutUserRoots.scope) "machine" "Machine-only cleanup must run without any user-root resolution."
        Assert-Equal ([int]$machineWithoutUserRoots.failedCount) 0 "Poisoned user environment values must not affect machine-only cleanup."
        Assert-Equal (@($machineWithoutUserRoots.matched | Where-Object { [string]$_.surface -like "user_*" }).Count) 0 "Machine-only inventory must never emit user artifacts."
    }
    finally {
        $env:USERPROFILE = $savedUserProfile
        $env:APPDATA = $savedAppData
    }

    Write-Host "Test user-scoped add-in cleanup and Codex skill link policy"
    $userAddinsRoot = Join-Path $canonicalRoamingRoot "Autodesk\Revit\Addins"
    foreach ($version in @("2022", "2025")) {
        $versionRoot = Join-Path $userAddinsRoot $version
        foreach ($payloadName in @("revAgentPlugin", "revit_mcp_plugin", "revit-mcp-plugin")) {
            New-Item -ItemType Directory -Path (Join-Path $versionRoot $payloadName) -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $versionRoot "$payloadName\plugin.dll") -Value "legacy user" -Encoding ASCII
        }
        foreach ($manifestName in @("revAgent.addin", "mcp-servers-for-revit.addin", "mcp_servers_for_revit.addin", "revit-mcp.addin", "revit-mcp.addin.disabled-self-contained", "revit-mcp.addin.disabled-20260410", "revit-mcp.addin.disabled-duplicate-20260410")) {
            Set-Content -LiteralPath (Join-Path $versionRoot $manifestName) -Value "legacy user" -Encoding ASCII
        }
        Set-Content -LiteralPath (Join-Path $versionRoot "revit-mcp-plugin.dll") -Value "legacy user binary" -Encoding ASCII
        New-Item -ItemType Directory -Path (Join-Path $versionRoot "Commands\SampleCommandset\$version") -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $versionRoot "Commands\SampleCommandset\$version\revit-mcp-sdk.dll") -Value "legacy user nested binary" -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $versionRoot "Commands\SampleCommandset\$version\operator-owned.dll") -Value "preserve user nested sibling" -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $versionRoot "operator-owned.addin") -Value "preserve" -Encoding ASCII
    }
    $realLegacySkill = Join-Path $canonicalUserRoot ".codex\skills\revit-mcp"
    $realRetiredRevAgentSkill = Join-Path $canonicalUserRoot ".codex\skills\revAgent"
    New-Item -ItemType Directory -Path $realLegacySkill -Force | Out-Null
    New-Item -ItemType Directory -Path $realRetiredRevAgentSkill -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $realLegacySkill "SKILL.md") -Value "operator-owned real directory" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $realRetiredRevAgentSkill "SKILL.md") -Value "operator-owned retired revAgent copy" -Encoding ASCII

    $userDryRun = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
        -Scope user `
        -InstallRoot $canonicalInstallRoot `
        -UserProfileRoot $canonicalUserRoot `
        -RoamingAppDataRoot $canonicalRoamingRoot `
        -CommonAppDataRoot $canonicalCommonRoot
    Assert-Equal ([string]$userDryRun.scope) "user" "Canonical user cleanup must report explicit user scope."
    Assert-Equal ([int]$userDryRun.removedCount) 0 "Canonical user dry-run must not remove anything."
    Assert-True (@($userDryRun.preserved | Where-Object { [string]$_.path -eq $realLegacySkill -and [string]$_.reason -eq "real_legacy_codex_skill_preserved" }).Count -eq 1) "A real user .codex legacy skill directory must be explicitly preserved."
    Assert-True (@($userDryRun.preserved | Where-Object { [string]$_.path -eq $realRetiredRevAgentSkill -and [string]$_.reason -eq "real_legacy_codex_skill_preserved" }).Count -eq 1) "A real retired .codex revAgent skill copy must be explicitly preserved."

    $userCommit = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
        -Scope user `
        -InstallRoot $canonicalInstallRoot `
        -UserProfileRoot $canonicalUserRoot `
        -RoamingAppDataRoot $canonicalRoamingRoot `
        -CommonAppDataRoot $canonicalCommonRoot `
        -Commit
    Assert-Equal ([int]$userCommit.failedCount) 0 "Canonical user fixture cleanup must not fail."
    Assert-Equal ([int]$userCommit.remainingCount) 0 "Canonical user fixture must have no remaining matched add-in artifacts."
    Assert-True (Test-Path -LiteralPath (Join-Path $realLegacySkill "SKILL.md") -PathType Leaf) "Real user legacy Codex skill directory must survive commit."
    Assert-True (Test-Path -LiteralPath (Join-Path $realRetiredRevAgentSkill "SKILL.md") -PathType Leaf) "Real retired revAgent skill copy must survive commit."
    foreach ($version in @("2022", "2025")) {
        $versionRoot = Join-Path $userAddinsRoot $version
        foreach ($legacyName in @("revAgent.addin", "mcp-servers-for-revit.addin", "mcp_servers_for_revit.addin", "revit-mcp.addin", "revit-mcp.addin.disabled-self-contained", "revit-mcp.addin.disabled-20260410", "revit-mcp.addin.disabled-duplicate-20260410", "revAgentPlugin", "revit_mcp_plugin", "revit-mcp-plugin", "revit-mcp-plugin.dll")) {
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $versionRoot $legacyName))) "Exact user legacy add-in artifact '$legacyName' was not removed for Revit $version."
        }
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $versionRoot "Commands\SampleCommandset\$version\revit-mcp-sdk.dll"))) "Nested exact legacy user SDK binary was not removed for Revit $version."
        Assert-True (Test-Path -LiteralPath (Join-Path $versionRoot "Commands\SampleCommandset\$version\operator-owned.dll") -PathType Leaf) "Nested non-legacy user add-in sibling must be preserved for Revit $version."
        Assert-True (Test-Path -LiteralPath (Join-Path $versionRoot "operator-owned.addin") -PathType Leaf) "Unknown user add-in must be preserved for Revit $version."
    }

    Remove-Item -LiteralPath $realRetiredRevAgentSkill -Recurse -Force
    $retiredRevAgentTarget = Join-Path $canonicalInstallRoot "codex\skills\revAgent\managed-target"
    New-Item -ItemType Directory -Path $retiredRevAgentTarget -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $retiredRevAgentTarget "must-survive.txt") -Value "retired target" -Encoding ASCII
    New-Item -ItemType Junction -Path $realRetiredRevAgentSkill -Target $retiredRevAgentTarget | Out-Null
    $retiredRevAgentLinkCommit = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
        -Scope user `
        -InstallRoot $canonicalInstallRoot `
        -UserProfileRoot $canonicalUserRoot `
        -RoamingAppDataRoot $canonicalRoamingRoot `
        -CommonAppDataRoot $canonicalCommonRoot `
        -Commit
    Assert-Equal ([int]$retiredRevAgentLinkCommit.matchedCount) 1 "Only the positively identified retired revAgent skill junction should match."
    Assert-Equal ([int]$retiredRevAgentLinkCommit.removedCount) 1 "Retired managed revAgent skill junction should be removed."
    Assert-True (-not (Test-Path -LiteralPath $realRetiredRevAgentSkill)) "Retired revAgent skill junction must be removed as a link."
    Assert-True (Test-Path -LiteralPath (Join-Path $retiredRevAgentTarget "must-survive.txt") -PathType Leaf) "Retired revAgent machine skill target must survive user cleanup."

    Remove-Item -LiteralPath $realLegacySkill -Recurse -Force
    $userSkillTarget = Join-Path $canonicalLegacyRoot "codex\skills\revit-mcp\managed-target"
    New-Item -ItemType Directory -Path $userSkillTarget -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $userSkillTarget "must-survive.txt") -Value "target" -Encoding ASCII
    New-Item -ItemType Junction -Path $realLegacySkill -Target $userSkillTarget | Out-Null
    $userLinkCommit = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
        -Scope user `
        -InstallRoot $canonicalInstallRoot `
        -UserProfileRoot $canonicalUserRoot `
        -RoamingAppDataRoot $canonicalRoamingRoot `
        -CommonAppDataRoot $canonicalCommonRoot `
        -Commit
    Assert-Equal ([int]$userLinkCommit.matchedCount) 1 "Only the exact user legacy Codex skill reparse point should match after add-in cleanup."
    Assert-Equal ([int]$userLinkCommit.removedCount) 1 "Exact user legacy Codex skill reparse point should be removed."
    Assert-True (-not (Test-Path -LiteralPath $realLegacySkill)) "Exact user legacy Codex skill junction must be removed as a link."
    Assert-True (Test-Path -LiteralPath (Join-Path $userSkillTarget "must-survive.txt") -PathType Leaf) "User legacy Codex skill junction target must survive cleanup."

    $customSkillTarget = Join-Path $canonicalFixtureRoot "custom-user-skill-target"
    New-Item -ItemType Directory -Path $customSkillTarget -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $customSkillTarget "must-survive.txt") -Value "custom target" -Encoding ASCII
    New-Item -ItemType Junction -Path $realLegacySkill -Target $customSkillTarget | Out-Null
    $customLinkCommit = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
        -Scope user `
        -InstallRoot $canonicalInstallRoot `
        -UserProfileRoot $canonicalUserRoot `
        -RoamingAppDataRoot $canonicalRoamingRoot `
        -CommonAppDataRoot $canonicalCommonRoot `
        -Commit
    Assert-Equal ([int]$customLinkCommit.removedCount) 0 "A custom-target user legacy skill junction must be preserved."
    Assert-True (@($customLinkCommit.preserved | Where-Object { [string]$_.path -eq $realLegacySkill -and [string]$_.reason -eq "custom_legacy_codex_skill_link_preserved" }).Count -eq 1) "Custom-target legacy Codex skill link must be reported as preserved."
    Assert-True (Test-Path -LiteralPath (Join-Path $customSkillTarget "must-survive.txt") -PathType Leaf) "Custom legacy Codex skill junction target must survive cleanup."
    [System.IO.Directory]::Delete($realLegacySkill, $false)

    $danglingLegacyTarget = Join-Path $canonicalLegacyRoot "codex\skills\revit-mcp\dangling-target"
    New-Item -ItemType Directory -Path $danglingLegacyTarget -Force | Out-Null
    New-Item -ItemType Junction -Path $realLegacySkill -Target $danglingLegacyTarget | Out-Null
    Remove-Item -LiteralPath $danglingLegacyTarget -Recurse -Force
    New-Item -ItemType Directory -Path $realRetiredRevAgentSkill -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $realRetiredRevAgentSkill "SKILL.md") -Value "current developer instructions" -Encoding ASCII
    $danglingLinkCommit = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
        -Scope user `
        -InstallRoot $canonicalInstallRoot `
        -UserProfileRoot $canonicalUserRoot `
        -RoamingAppDataRoot $canonicalRoamingRoot `
        -CommonAppDataRoot $canonicalCommonRoot `
        -PreserveLocalCodexInstructions `
        -Commit
    Assert-Equal ([int]$danglingLinkCommit.removedCount) 1 "Preserve-local must still remove the exact dangling retired-machine revit-mcp junction."
    Assert-True ($null -eq (Get-Item -LiteralPath $realLegacySkill -Force -ErrorAction SilentlyContinue)) "Dangling retired-machine skill junction must be removed without target traversal."
    Assert-True (Test-Path -LiteralPath (Join-Path $realRetiredRevAgentSkill "SKILL.md") -PathType Leaf) "Preserve-local must not inspect or remove current revAgent instruction content."

    $outsideCanonicalCodexHomeRejected = $false
    try {
        Invoke-RevAgentCanonicalLegacySurfaceCleanup `
            -Scope user `
            -InstallRoot $canonicalInstallRoot `
            -UserProfileRoot $canonicalUserRoot `
            -RoamingAppDataRoot $canonicalRoamingRoot `
            -CommonAppDataRoot $canonicalCommonRoot `
            -TargetCodexHome (Join-Path $canonicalFixtureRoot "outside-canonical-codex-home") | Out-Null
    }
    catch {
        $outsideCanonicalCodexHomeRejected = $_.Exception.Message -match "TargetCodexHome strictly inside the authenticated UserProfileRoot"
    }
    Assert-True $outsideCanonicalCodexHomeRejected "Canonical user inventory must reject TargetCodexHome outside the authenticated profile."

    $unsafeUserRoot = Join-Path $canonicalFixtureRoot "Users\UnsafeOperator"
    $unsafeRoamingRoot = Join-Path $unsafeUserRoot "AppData\Roaming"
    $unsafeSkillsTarget = Join-Path $canonicalFixtureRoot "unsafe-skills-target"
    $unsafeSkillsLink = Join-Path $unsafeUserRoot ".codex\skills"
    New-Item -ItemType Directory -Path (Join-Path $unsafeUserRoot ".codex") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $unsafeSkillsTarget "revit-mcp") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $unsafeSkillsTarget "revit-mcp\must-survive.txt") -Value "ancestor target" -Encoding ASCII
    New-Item -ItemType Junction -Path $unsafeSkillsLink -Target $unsafeSkillsTarget | Out-Null
    New-Item -ItemType Directory -Path $unsafeRoamingRoot -Force | Out-Null
    $preserveUnsafeCodexTree = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
        -Scope user `
        -InstallRoot $canonicalInstallRoot `
        -UserProfileRoot $unsafeUserRoot `
        -RoamingAppDataRoot $unsafeRoamingRoot `
        -CommonAppDataRoot $canonicalCommonRoot `
        -TargetCodexHome (Join-Path $unsafeUserRoot ".codex") `
        -PreserveLocalCodexInstructions `
        -Commit
    Assert-Equal (@($preserveUnsafeCodexTree.matched | Where-Object { [string]$_.surface -like "user_codex*" }).Count) 0 "Preserve-local canonical cleanup must never match a Codex path below an unsafe ancestor."
    Assert-Equal (@($preserveUnsafeCodexTree.preserved | Where-Object { [string]$_.surface -eq "user_codex_legacy_skill_reparse" -and [string]$_.reason -eq "reparse_point_in_candidate_path" }).Count) 1 "Preserve-local must inspect only the exact retired leaf and fail closed before traversing an unsafe Codex ancestor."
    Assert-True (Test-Path -LiteralPath (Join-Path $unsafeSkillsTarget "revit-mcp\must-survive.txt") -PathType Leaf) "Preserve-local cleanup must not traverse a poisoned Codex skill tree."
    $unsafeUserCommit = Invoke-RevAgentCanonicalLegacySurfaceCleanup `
        -Scope user `
        -InstallRoot $canonicalInstallRoot `
        -UserProfileRoot $unsafeUserRoot `
        -RoamingAppDataRoot $unsafeRoamingRoot `
        -CommonAppDataRoot $canonicalCommonRoot `
        -Commit
    Assert-Equal ([int]$unsafeUserCommit.removedCount) 0 "Cleanup must not traverse a reparse-point .codex ancestor."
    Assert-True (@($unsafeUserCommit.preserved | Where-Object { [string]$_.surface -eq "user_codex_legacy_skill_reparse" -and [string]$_.reason -eq "reparse_point_in_candidate_path" }).Count -eq 1) "Reparse-point Codex ancestor must be reported as preserved."
    Assert-True (Test-Path -LiteralPath (Join-Path $unsafeSkillsTarget "revit-mcp\must-survive.txt") -PathType Leaf) "Reparse-point ancestor target content must survive cleanup."

    $invalidInstallRejected = $false
    try {
        Invoke-RevAgentCanonicalLegacySurfaceCleanup `
            -Scope machine `
            -InstallRoot (Join-Path $canonicalCommonRoot "DPE\not-revAgent") `
            -UserProfileRoot $canonicalUserRoot `
            -RoamingAppDataRoot $canonicalRoamingRoot `
            -CommonAppDataRoot $canonicalCommonRoot | Out-Null
    }
    catch {
        $invalidInstallRejected = ($_.Exception.Message -match "requires InstallRoot")
    }
    Assert-True $invalidInstallRejected "Canonical legacy cleanup must reject a non-canonical InstallRoot."

    foreach ($junctionPath in @($machineNestedLink, $machineVersionLink, $unsafeSkillsLink)) {
        if ($null -ne (Get-Item -LiteralPath $junctionPath -Force -ErrorAction SilentlyContinue)) {
            [System.IO.Directory]::Delete($junctionPath, $false)
        }
    }

    Write-Host "Test standalone source-free migration commit fails closed"
    $harnessRoot = Join-Path $tempRoot "standalone-contract-harness"
    $harnessTools = Join-Path $harnessRoot "tools"
    $harnessLib = Join-Path $harnessTools "lib"
    New-Item -ItemType Directory -Path $harnessTools -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepoRoot "installer\nas\migrate-source-free-install.ps1") -Destination (Join-Path $harnessTools "migrate-source-free-install.ps1") -Force

    $noLibCommitError = ""
    try {
        & (Join-Path $harnessTools "migrate-source-free-install.ps1") -Mode commit
    }
    catch {
        $noLibCommitError = $_.Exception.Message
    }
    Assert-True ($noLibCommitError -match 'Standalone source-free migration commit mode is disabled' -and $noLibCommitError -match 'Start-revAgent-Update\.cmd') "Standalone commit must reach the protected-route guard even when no migration libraries are present."

    New-Item -ItemType Directory -Path $harnessLib -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.CodexRegistration.psm1") -Destination (Join-Path $harnessLib "RevAgent.CodexRegistration.psm1") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.Permissions.psm1") -Destination (Join-Path $harnessLib "RevAgent.Permissions.psm1") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.SourceFreeMigration.psm1") -Destination (Join-Path $harnessLib "RevAgent.SourceFreeMigration.psm1") -Force

    $harnessReportPath = Join-Path $harnessRoot "migration-report.json"
    $harnessInstallRoot = Join-Path $harnessRoot "install"
    $harnessWorkRoot = Join-Path $harnessInstallRoot "updater"
    $harnessPackageTarget = Join-Path $harnessInstallRoot "package"
    $harnessServerTarget = Join-Path $harnessInstallRoot "runtime"
    $harnessUserProfileRoot = Join-Path $harnessRoot "user"
    $harnessConfigPath = Join-Path $harnessWorkRoot "updater-config.json"
    $harnessChannelPath = Join-Path $harnessRoot "stable.json"
    $fakeUpdaterMarkerPath = Join-Path $harnessRoot "fake-updater-invoked.txt"
    New-Item -ItemType Directory -Path $harnessWorkRoot -Force | Out-Null

    $fakeUpdaterPath = Join-Path $harnessWorkRoot "update-from-nas.ps1"
    $fakeUpdater = '"invoked" | Set-Content -LiteralPath $env:REVAGENT_FAKE_UPDATER_MARKER -Encoding ASCII'
    Set-Content -LiteralPath $fakeUpdaterPath -Value $fakeUpdater -Encoding ASCII

    ([ordered]@{
            codexInstructionPolicy = "preserve-local"
            machineRole = "developer"
        } | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $harnessConfigPath -Encoding ASCII
    "{}" | Set-Content -LiteralPath $harnessChannelPath -Encoding ASCII

    $commitError = ""
    $env:REVAGENT_FAKE_UPDATER_MARKER = $fakeUpdaterMarkerPath
    try {
        & (Join-Path $harnessTools "migrate-source-free-install.ps1") `
            -Mode commit `
            -ConfigPath $harnessConfigPath `
            -ChannelManifestPath $harnessChannelPath `
            -InstallRoot $harnessInstallRoot `
            -WorkRoot $harnessWorkRoot `
            -PackageTarget $harnessPackageTarget `
            -ServerTarget $harnessServerTarget `
            -UserProfileRoot $harnessUserProfileRoot `
            -ReportPath $harnessReportPath `
            -NoNotifyUser
    }
    catch {
        $commitError = $_.Exception.Message
    }
    finally {
        Remove-Item Env:\REVAGENT_FAKE_UPDATER_MARKER -ErrorAction SilentlyContinue
    }
    Assert-True ($commitError -match 'Standalone source-free migration commit mode is disabled' -and $commitError -match 'protected local GUI and privileged snapshot broker' -and $commitError -match 'Start-revAgent-Update\.cmd' -and $commitError -match 'Migrate') "Standalone commit must fail with protected GUI/broker routing instructions."
    Assert-True (-not (Test-Path -LiteralPath $fakeUpdaterMarkerPath -PathType Leaf)) "Standalone commit must not invoke the local updater."
    Assert-True (-not (Test-Path -LiteralPath $harnessReportPath -PathType Leaf)) "Rejected standalone commit must fail before writing a misleading migration report."

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
$sourceFreeModulePath = Join-Path $RepoRoot "installer\lib\RevAgent.SourceFreeMigration.psm1"
$sourceFreeTokens = $null
$sourceFreeErrors = $null
$sourceFreeAst = [System.Management.Automation.Language.Parser]::ParseFile($sourceFreeModulePath, [ref]$sourceFreeTokens, [ref]$sourceFreeErrors)
Assert-Equal $sourceFreeErrors.Count 0 "Source-free migration module has parse errors."
$invokeCleanupAst = @($sourceFreeAst.FindAll({
            param($node)
            return ($node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Invoke-RevitMcpSourceFreeArtifactCleanup")
        }, $true) | Select-Object -First 1)[0]
$invokeCleanupParameterNames = @($invokeCleanupAst.Body.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
Assert-Equal ([Array]::IndexOf($invokeCleanupParameterNames, "Commit")) 7 "Pre-existing positional Commit parameter moved."
Assert-Equal ([Array]::IndexOf($invokeCleanupParameterNames, "Scope")) 8 "New Scope parameter must be appended after pre-existing Commit."
$sourceFreeModuleText = Get-Content -Raw -LiteralPath $sourceFreeModulePath
Assert-True ($sourceFreeModuleText -notmatch 'Remove-Item[^\r\n]*-Force' -and $sourceFreeModuleText -match 'Remove-RevAgentCleanupPathWithoutForce') "Source-free/canonical deletion must never use Force against a file that could become shared."
Assert-True ($sourceFreeModuleText -match 'TestAfterTransactionPreflightHook' -and $sourceFreeModuleText -match 'Get-RevitMcpSourceFreeFileLinkCount -Path \$filePath' -and $sourceFreeModuleText -match 'original ACL was restored') "Mutation-edge hardlink revalidation and ACL rollback evidence must remain in the module."

$migrationParams = Get-ScriptParamNames -Path (Join-Path $RepoRoot "installer\nas\migrate-source-free-install.ps1")
foreach ($name in @("Mode", "ConfigPath", "ChannelManifestPath", "InstallRoot", "WorkRoot", "PackageTarget", "ServerTarget", "ReportPath", "CodexInstructionPolicy")) {
    Assert-True ($migrationParams -contains $name) "migrate-source-free-install.ps1 lost public parameter -$name."
}

$migrationText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\migrate-source-free-install.ps1")
Assert-True ($migrationText -match 'Standalone source-free migration commit mode is disabled' -and $migrationText -match 'protected local GUI and privileged snapshot broker' -and $migrationText -match 'bootstrap\\Start-revAgent-Update\.cmd' -and $migrationText -match 'Use -Mode dryRun here for inventory only') "Standalone migration commit must fail closed and route mutations through the protected GUI/broker contract."
Assert-True ($migrationText.IndexOf('if ($Mode -eq "commit")') -ge 0 -and $migrationText.IndexOf('if ($Mode -eq "commit")') -lt $migrationText.IndexOf('$nasLibRoot = @(')) "Standalone commit guard must run before migration library discovery/import."
Assert-True ($migrationText -notmatch '& \$powerShellPath @updateArgs' -and $migrationText -notmatch 'Add-RevAgentChildProcessParameter' -and $migrationText -notmatch 'Add-RevAgentChildProcessSwitch') "Standalone migration must not retain a legacy mutating updater child-process path."
Assert-True ($migrationText -match 'Set-RevAgentCurrentProcessUtf8Console') "Migration entrypoint must force UTF-8 output even when launched with -NoProfile."
Assert-True ($migrationText -match 'Resolve-RevAgentCodexInstructionPolicy' -and $migrationText -match 'codexInstructionPolicy = \$CodexInstructionPolicy') "Migration dry-run must resolve and report Codex instruction policy."
Assert-True ($migrationText -match '-SkipCodexUserIntegration:\$SkipCodexUserIntegration') "Migration inventory must honor SkipCodexUserIntegration when scanning source-free artifacts."
Assert-True ($migrationText -match 'codexInstructionCleanupSkipped = \[bool\]\$preserveLocalCodexInstructions') "Migration report must expose Codex instruction cleanup skip state."
Assert-True ($migrationText -match 'Publish-RevAgentSourceFreeMigrationEvidence' -and $migrationText -match 'source-free-migration-latest\.json') "Migration dry-run must be able to publish durable source-free evidence for rollout readiness."
Assert-True ($migrationText -notmatch 'Join-Path \$machineRoot "latest\.json"') "Migration dry-run evidence must not overwrite dashboard latest.json version state."

$updaterParams = Get-ScriptParamNames -Path (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
Assert-True ($updaterParams -contains "SourceFreeMigration") "update-from-nas.ps1 must expose -SourceFreeMigration."
Assert-True ($updaterParams -contains "CodexInstructionPolicy") "update-from-nas.ps1 must expose -CodexInstructionPolicy."

$updaterText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
. (Import-ScriptFunctionForTest -Path (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1") -FunctionName "Test-RevAgentCanonicalRebaselineOperationMethod")
foreach ($method in @(
        "gui-install",
        "gui-install-user-integration",
        "gui-install-repair-machine",
        "install",
        "install-repair-user-integration",
        "source-free-migration",
        "source-free-migration-bootstrap-machine",
        "source-free-migration-bootstrap-user-integration"
    )) {
    Assert-True (Test-RevAgentCanonicalRebaselineOperationMethod -Method $method) "Canonical rebaseline operation matrix rejected '$method'."
}
foreach ($method in @("", "gui-update", "scheduled-update", "manual-update-audit", "initial-audit")) {
    Assert-True (-not (Test-RevAgentCanonicalRebaselineOperationMethod -Method $method)) "Canonical rebaseline operation matrix incorrectly accepted '$method'."
}
Assert-True ($updaterText -match 'Source migration : runtime, docs, Codex skill, and MCP registration refresh forced') "Updater migration mode must force full managed payload refresh."
Assert-True ($updaterText -match 'Invoke-RevAgentSourceFreeArtifactCleanup') "Updater migration mode must run source-free cleanup."
Assert-True ($updaterText -match '\$sourceFreeInventoryScope = if \(\$MachinePhaseOnly\) \{ "machine" \} else \{ "all" \}' -and $updaterText -match '-Scope \$sourceFreeInventoryScope') "Elevated machine inventory must explicitly exclude user-profile roots."
Assert-True ([regex]::Matches($updaterText, 'Invoke-RevAgentSourceFreeArtifactCleanup[\s\S]{0,500}-Scope machine').Count -ge 2) "Machine pre/post source cleanup must use explicit machine scope."
Assert-True ([regex]::Matches($updaterText, 'Invoke-RevAgentSourceFreeArtifactCleanup[\s\S]{0,500}-Scope user').Count -ge 2) "Canonical user rebaseline must move user-profile source cleanup into the unelevated user phase."
Assert-True ($updaterText -match 'sourceFreeUserCleanup = \$sourceFreeUserCleanupState') "Unelevated user cleanup scope and verification evidence must survive in the phase result."
Assert-True ($updaterText -match 'sourceFreeMigration = \$sourceFreeMigrationState') "Updater installed state must include migration verification metadata."
Assert-True ($updaterText -match 'Resolve-CodexInstructionPolicy' -and $updaterText -match 'CodexInstructionPolicy = \$CodexInstructionPolicy') "Updater must resolve and pass Codex instruction policy to the self-contained installer."
Assert-True ($updaterText -match '-PreserveLocalCodexInstructions:\$preserveLocalCodexInstructions') "Updater must exclude preserved Codex instruction roots from source-free cleanup and guard inventories."
Assert-True ($updaterText -match '-SkipCodexUserIntegration:\$SkipCodexUserIntegration') "Updater source-free inventories must honor SkipCodexUserIntegration."
Assert-True ($updaterText -match '-not \$SourceFreeMigration[\s\S]{0,160}\$isPackageCurrent') "Updater must not return early as current during source-free migration."
Assert-True ($updaterText -match 'source-free-migration-required' -and $updaterText -match 'Get-RevAgentSourceFreeArtifactInventory') "Normal updater runs must block before update when source-free migration inventory is not clean."
Assert-True ($updaterText -match 'migrate-source-free-install\.ps1 -Mode dryRun' -and $updaterText -match 'protected revAgent Updater GUI' -and $updaterText -match 'migrationCommitRoute' -and $updaterText -notmatch 'then run -Mode commit') "Updater migration guard must route mutation through the protected GUI and never recommend disabled standalone commit."
Assert-True ($updaterText -match 'Invoke-RevAgentCanonicalLegacySurfaceCleanup[\s\S]{0,160}-Scope user' -and $updaterText -match 'Invoke-RevAgentCanonicalLegacySurfaceCleanup[\s\S]{0,160}-Scope machine') "Canonical rebaseline must run bounded cleanup in both machine and user phases."
Assert-True ([regex]::Matches($updaterText, '-TargetCodexHome \$targetCodexHomeForCleanup').Count -ge 3 -and $updaterText -match '-PreserveLocalCodexInstructions:\$preserveLocalCodexInstructions') "User cleanup and canonical inventory must receive the explicit validated TargetCodexHome and preserve-local policy."
Assert-True ($updaterText -match 'Test-RevAgentCanonicalCleanupActionRequired' -and $updaterText -match 'blockingPreservedCount' -and $updaterText -match 'canonicalLegacySurfaceCleanup = \$canonicalLegacySurfaceCleanupState') "Canonical cleanup failures and blocking remnants must remain structured in reports and phase results."
Assert-True ($updaterText -match '\$effectiveRevitPayloadChangeCount = if \([^\r\n]*\$canonicalRebaselineRequested' -and $updaterText -match 'canonical rebaseline full Revit payload repair') "Canonical rebaseline must require the Revit-close decision even when current payload hashes match."
Assert-True ($updaterText -match 'desktopLauncherCleanup = \$desktopLauncherCleanupState' -and $updaterText -match 'Write-RevAgentPhaseResult -Status "completed"') "Updater user phase must attest the actual desktop/startup cleanup result."
Assert-True ($updaterText -match 'function Get-UpdaterDetachedSignaturePath' -and $updaterText -match 'Get-UpdaterDetachedSignaturePath -ContentPath \$configuredLicensePath') "Updater must compute default detached signature paths without relying on imported helper scope."
Assert-True ($updaterText -match 'RevAgentDistributionIntegrityModule = if \(\$MachinePhaseOnly -or \$UserPhaseOnly\)' -and $updaterText -match 'RevAgentPreImportIntegrityModule' -and $updaterText -match 'Import-Module .*RevAgent\.DistributionIntegrity\.psm1.*-PassThru' -and $updaterText -match 'function Get-UpdaterDistributionIntegrityCommand' -and $updaterText -match 'Get-UpdaterDistributionIntegrityCommand -Name "Test-RevAgentReleaseDistributionIntegrity" -Required') "Updater must reuse the snapshot-pinned pre-import verifier in both split phases and call helpers through the imported module object during nested migration runs."
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
Assert-True ($installTaskText -match 'Get-RevAgentNestedDesktopLauncherCleanup' -and ([regex]::Matches($installTaskText, 'Invoke-RevAgentLegacyDesktopLauncherCleanup').Count -eq 1)) "Install wrapper must consume nested launcher-cleanup evidence instead of running desktop cleanup twice."
Assert-True ($installTaskText -match 'Resolve-RevAgentNestedMachinePhaseOutcome' -and $installTaskText -match 'Set-RevAgentInstallRunReport -Status \$blockedReportStatus' -and $installTaskText -match 'Write-RevAgentInstallMachinePhaseResult\s+`\s+-Status "blocked"' -and $installTaskText -match 'updaterMachinePhase = \$script:RevAgentMachineUpdatePhase') "Install wrapper must preserve a nested blocked machine phase and its evidence instead of converting a safe Revit-close deferral into failure."
Assert-True ($installTaskText -match 'last-update-report\.json' -and $installTaskText -match 'New-RevAgentInstallRunDiagnostics' -and $installTaskText -match 'canonicalLegacySurfaceCleanup') "Install wrapper final report must inherit the nested updater diagnostics and canonical cleanup evidence."
Assert-True ($installTaskText -match 'exactStartupCleanup' -and $installTaskText -match 'Merge-RevAgentDesktopLauncherCleanupEvidence' -and $installTaskText -match '\$diagnostics\["desktopLauncherCleanup"\] = \$integrationDesktopLauncherCleanup') "Exact Startup launcher removals must be merged into the final desktopLauncherCleanup attestation."

. (Import-ScriptFunctionForTest -Path (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1") -FunctionName "Get-RevAgentInstallObjectPropertyValue")
. (Import-ScriptFunctionForTest -Path (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1") -FunctionName "Test-RevAgentInstallObjectProperty")
. (Import-ScriptFunctionForTest -Path (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1") -FunctionName "New-RevAgentInstallVersionEvidence")
. (Import-ScriptFunctionForTest -Path (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1") -FunctionName "Merge-RevAgentLauncherCleanupEvidence")
. (Import-ScriptFunctionForTest -Path (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1") -FunctionName "Merge-RevAgentDesktopLauncherCleanupEvidence")
. (Import-ScriptFunctionForTest -Path (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1") -FunctionName "New-RevAgentInstallRunDiagnostics")
. (Import-ScriptFunctionForTest -Path (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1") -FunctionName "Resolve-RevAgentNestedMachinePhaseOutcome")
$nestedLauncherEvidence = [pscustomobject]@{
    enabled = $true
    mode = "commit"
    matchedCount = 1
    removedCount = 1
    failedCount = 0
    matched = @([pscustomobject]@{ path = "C:\Desktop\legacy.lnk"; name = "legacy.lnk"; extension = ".lnk" })
    removed = @([pscustomobject]@{ path = "C:\Desktop\legacy.lnk"; name = "legacy.lnk"; extension = ".lnk" })
    failed = @()
}
$exactStartupEvidence = [pscustomobject]@{
    enabled = $true
    mode = "commit"
    startupRoot = "C:\Startup"
    matchedCount = 1
    removedCount = 1
    failedCount = 0
    matched = @([pscustomobject]@{ path = "C:\Startup\Revit MCP Auto Update.cmd"; name = "Revit MCP Auto Update.cmd"; extension = ".cmd"; source = "exact-legacy-startup-name" })
    removed = @([pscustomobject]@{ path = "C:\Startup\Revit MCP Auto Update.cmd"; name = "Revit MCP Auto Update.cmd"; extension = ".cmd"; source = "exact-legacy-startup-name" })
    failed = @()
}
$mergedLauncherEvidence = Merge-RevAgentDesktopLauncherCleanupEvidence -NestedUpdaterCleanup $nestedLauncherEvidence -ExactStartupCleanup $exactStartupEvidence
Assert-Equal ([int]$mergedLauncherEvidence.matchedCount) 2 "Merged launcher evidence must include nested desktop and exact Startup matches."
Assert-Equal ([int]$mergedLauncherEvidence.removedCount) 2 "Merged launcher evidence must include the exact Startup removal in its total."
Assert-Equal ([int]$mergedLauncherEvidence.exactStartupCleanup.removedCount) 1 "Merged launcher evidence must preserve exact Startup provenance."
$deduplicatedLauncherEvidence = Merge-RevAgentLauncherCleanupEvidence -Primary $nestedLauncherEvidence -Additional $nestedLauncherEvidence
Assert-Equal ([int]$deduplicatedLauncherEvidence.matchedCount) 1 "Merged launcher evidence must deduplicate repeated matched paths."
Assert-Equal ([int]$deduplicatedLauncherEvidence.removedCount) 1 "Merged launcher evidence must deduplicate repeated removed paths."

$nestedSuccessfulVersionFixture = [pscustomobject]@{
    previousVersion = "2026.07.14.599-old"
    targetVersion = "2026.07.14.600-new"
    installedVersion = "2026.07.14.600-new"
    versionTransition = "2026.07.14.599-old -> 2026.07.14.600-new"
    pendingVersionTransition = $null
}
$successfulVersionEvidence = New-RevAgentInstallVersionEvidence `
    -NestedMachineRunReport $nestedSuccessfulVersionFixture `
    -FallbackPreviousVersion "2026.07.14.600-new" `
    -FallbackTargetVersion "2026.07.14.600-new" `
    -FallbackInstalledVersion "2026.07.14.600-new"
Assert-Equal ([string]$successfulVersionEvidence["previousVersion"]) "2026.07.14.599-old" "Nested pre-update version must win over the post-update installed-state fallback."
Assert-Equal ([string]$successfulVersionEvidence["versionTransition"]) "2026.07.14.599-old -> 2026.07.14.600-new" "Nested version transition must survive the outer install report."
$firstInstallVersionEvidence = New-RevAgentInstallVersionEvidence `
    -NestedMachineRunReport ([pscustomobject]@{ previousVersion = $null; targetVersion = "2026.07.14.600-new"; installedVersion = "2026.07.14.600-new"; versionTransition = "not installed -> 2026.07.14.600-new" }) `
    -FallbackPreviousVersion "2026.07.14.600-new" `
    -FallbackTargetVersion "2026.07.14.600-new" `
    -FallbackInstalledVersion "2026.07.14.600-new"
Assert-True ($null -eq $firstInstallVersionEvidence["previousVersion"]) "Explicit nested first-install previousVersion=null must not be replaced by the newly installed version."

$nestedMachinePhaseFixture = [pscustomobject]@{
    phase = "machine"
    status = "blocked"
    success = $false
    continueUserPhase = $false
    message = "Close Revit and retry."
    details = [pscustomobject]@{
        canonicalLegacySurfaceCleanup = [pscustomobject]@{ success = $true; removedCount = 2 }
    }
}
$nestedMachineReportFixture = [pscustomobject]@{
    status = "deferred-revit-close-required"
    diagnostics = [pscustomobject]@{
        isFirstInstall = $true
        revitRunning = $true
        deferredForRevitClose = $true
        revitPayloadChanged = $true
        desktopLauncherCleanup = [pscustomobject]@{ mode = "deferred-to-user-phase" }
    }
}
$mergedInstallDiagnostics = New-RevAgentInstallRunDiagnostics `
    -NestedMachineRunReport $nestedMachineReportFixture `
    -UpdaterMachinePhase $nestedMachinePhaseFixture `
    -CodexUserIntegration $null `
    -DesktopLauncherCleanup ([ordered]@{ mode = "not-run" }) `
    -InstructionPolicy "preserve-local" `
    -ResolvedMachineRole "developer" `
    -FallbackIsFirstInstall $false
Assert-True ([bool]$mergedInstallDiagnostics.revitRunning -and [bool]$mergedInstallDiagnostics.deferredForRevitClose -and [bool]$mergedInstallDiagnostics.revitPayloadChanged) "Final install diagnostics must preserve nested Revit-close flags."
Assert-True ([bool]$mergedInstallDiagnostics.isFirstInstall) "Nested isFirstInstall truth must win over the installed-state fallback."
Assert-Equal ([int]$mergedInstallDiagnostics.canonicalLegacySurfaceCleanup.removedCount) 2 "Final install diagnostics must preserve canonical cleanup evidence from the nested phase."
Assert-Equal ([string]$mergedInstallDiagnostics.updaterMachinePhase.status) "blocked" "Final install diagnostics must preserve the nested machine-phase status."
Assert-Equal ([string]$mergedInstallDiagnostics.desktopLauncherCleanup.mode) "deferred-to-user-phase" "A not-run outer launcher state must not overwrite nested launcher diagnostics."
$blockedOutcomeFixture = Resolve-RevAgentNestedMachinePhaseOutcome -PhaseResult $nestedMachinePhaseFixture -NestedMachineRunReport $nestedMachineReportFixture
Assert-True ([bool]$blockedOutcomeFixture.accepted -and [bool]$blockedOutcomeFixture.blocked -and -not [bool]$blockedOutcomeFixture.continueUserPhase) "Nested Revit-close phase must resolve to an accepted blocked outcome with no user continuation."
Assert-Equal ([string]$blockedOutcomeFixture.reportStatus) "deferred-revit-close-required" "Nested blocked outcome must preserve the updater report status."

Write-Host "Source-free migration tests passed." -ForegroundColor Green
