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

Import-Module (Join-Path $libRoot "RevitMcp.SourceFreeMigration.psm1") -Force

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
$installRoot = Join-Path $tempRoot "ProgramData\DPE\RevitMCP"
$packageTarget = Join-Path $installRoot "package"
$serverTarget = Join-Path $installRoot "runtime"
$userProfileRoot = Join-Path $tempRoot "Users\Operator"

try {
    foreach ($path in @(
            (Join-Path $packageTarget "src"),
            (Join-Path $packageTarget "docs"),
            (Join-Path $packageTarget "installer\revit-api-docs-mcp\scripts"),
            (Join-Path $packageTarget "installer\runtime-mcp-server"),
            (Join-Path $serverTarget "src"),
            (Join-Path $serverTarget "build"),
            (Join-Path $installRoot "codex\skills\revit-mcp\src"),
            (Join-Path $userProfileRoot ".codex\skills\revit-mcp\src"),
            (Join-Path $installRoot "updater\backups\revit-mcp-skill.backup-20260623\src")
        )) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }

    Set-Content -LiteralPath (Join-Path $packageTarget "src\tool.ts") -Value "export const x = 1;" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $packageTarget "docs\developer.md") -Value "developer notes" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $packageTarget "installer\revit-api-docs-mcp\scripts\build-index.ps1") -Value "# allowed runtime script" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $packageTarget "installer\runtime-mcp-server\tsconfig.json") -Value "{}" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $serverTarget "src\index.ts") -Value "export {};" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $serverTarget "build\index.js.map") -Value "{}" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $installRoot "codex\skills\revit-mcp\src\skill.ts") -Value "source" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $userProfileRoot ".codex\skills\revit-mcp\src\skill.ts") -Value "source" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $installRoot "updater\backups\revit-mcp-skill.backup-20260623\src\old.ts") -Value "source" -Encoding ASCII

    $dryRun = Invoke-RevitMcpSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot
    Assert-Equal $dryRun.mode "dryRun" "Default source-free cleanup mode must be dryRun."
    Assert-Equal $dryRun.artifactCount 8 "Dry-run should detect all managed source/developer artifacts."
    Assert-Equal $dryRun.removedCount 0 "Dry-run must not remove artifacts."
    Assert-True (Test-Path -LiteralPath (Join-Path $packageTarget "src")) "Dry-run removed package source unexpectedly."
    Assert-True (Test-Path -LiteralPath (Join-Path $packageTarget "installer\revit-api-docs-mcp\scripts\build-index.ps1")) "Allowed docs build-index script must stay present."

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
    Assert-Equal ([int]$report.before.artifactCount) 8 "Migration dry-run report should include source/developer artifact count."
    Assert-Equal ([string]$report.mode) "dryRun" "Migration dry-run report should preserve mode."

    $commit = Invoke-RevitMcpSourceFreeArtifactCleanup `
        -InstallRoot $installRoot `
        -PackageTarget $packageTarget `
        -ServerTarget $serverTarget `
        -UserProfileRoot $userProfileRoot `
        -Commit
    Assert-Equal $commit.mode "commit" "Commit source-free cleanup should report commit mode."
    Assert-Equal $commit.failedCount 0 "Commit cleanup should not fail in the isolated fixture."
    Assert-Equal $commit.remainingCount 0 "Commit cleanup should remove all managed source/developer artifacts."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $packageTarget "src"))) "Package src directory should be removed."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $serverTarget "src"))) "Runtime src directory should be removed."
    Assert-True (Test-Path -LiteralPath (Join-Path $packageTarget "installer\revit-api-docs-mcp\scripts\build-index.ps1")) "Allowed docs build-index script should not be removed by cleanup."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Test source-free migration installer/updater surface"
$migrationParams = Get-ScriptParamNames -Path (Join-Path $RepoRoot "installer\nas\migrate-source-free-install.ps1")
foreach ($name in @("Mode", "ConfigPath", "ChannelManifestPath", "InstallRoot", "WorkRoot", "PackageTarget", "ServerTarget", "ReportPath")) {
    Assert-True ($migrationParams -contains $name) "migrate-source-free-install.ps1 lost public parameter -$name."
}

$updaterParams = Get-ScriptParamNames -Path (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
Assert-True ($updaterParams -contains "SourceFreeMigration") "update-from-nas.ps1 must expose -SourceFreeMigration."

$updaterText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\update-from-nas.ps1")
Assert-True ($updaterText -match 'Source migration : runtime, docs, Codex skill, and MCP registration refresh forced') "Updater migration mode must force full managed payload refresh."
Assert-True ($updaterText -match 'Invoke-RevitMcpSourceFreeArtifactCleanup') "Updater migration mode must run source-free cleanup."
Assert-True ($updaterText -match 'sourceFreeMigration = \$sourceFreeMigrationState') "Updater installed state must include migration verification metadata."
Assert-True ($updaterText -match '-not \$SourceFreeMigration -and \$isPackageCurrent') "Updater must not return early as current during source-free migration."

$publishText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\publish-nas-release.ps1")
Assert-True ($publishText -match 'migrate-source-free-install\.ps1') "Publisher must include the source-free migration tool in user packs and NAS tools."
Assert-True ($publishText -match 'RevitMcp\.SourceFreeMigration\.psm1') "Publisher manifest must fingerprint the migration helper module."

$installText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\install-self-contained.ps1")
Assert-True ($installText -match 'migrate-source-free-install\.ps1') "Self-contained installer must refresh the migration tool in the local updater folder."

$installTaskText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\install-updater-task.ps1")
Assert-True ($installTaskText -match 'localMigrationTool' -and $installTaskText -match 'migrate-source-free-install\.ps1') "Updater task installer must copy the migration tool locally."

Write-Host "Source-free migration tests passed." -ForegroundColor Green
