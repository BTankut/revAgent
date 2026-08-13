<#
.SYNOPSIS
    CI-safe tests for the SSH live smoke runner.
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

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$scriptPath = Join-Path $RepoRoot "scripts\invoke-live-smoke-over-ssh.ps1"

Assert-True (Test-Path -LiteralPath $scriptPath -PathType Leaf) "SSH live smoke runner script was not found."

$scriptText = Get-Content -Raw -LiteralPath $scriptPath -Encoding UTF8
Assert-True ($scriptText -match 'rme_basic_sample_project\.rvt') "SSH live smoke runner must default to the standard Revit 2022 sample model."
Assert-True ($scriptText -match 'ExpectedModelName') "SSH live smoke runner must expose the expected model name as a first-class check."
Assert-True ($scriptText -match 'OpenOnly') "SSH live smoke runner must support an open/model-verification-only gate before full smoke."
Assert-True ($scriptText -match 'LaunchMode' -and $scriptText -match 'InteractiveTask') "SSH live smoke runner must default to an interactive launch mode for visible workstation Revit startup."
Assert-True ($scriptText -match 'Revit 2022\\Revit\.exe') "SSH live smoke runner must default to Revit 2022."
Assert-True ($scriptText -match 'test-commandset-live\.ps1') "SSH live smoke runner must execute the live commandset smoke helper."
Assert-True ($scriptText -match 'scp\.exe' -and $scriptText -match 'LiveHelperPath') "SSH live smoke runner must stage the current helper instead of trusting stale remote copies."
Assert-True ($scriptText -match '-UseNasHelper is retired' -and $scriptText -match 'never executes a loose NAS tools script') "SSH live smoke runner must reject the retired loose-NAS-helper execution path."
Assert-True ($scriptText -notmatch 'Join-Path \(Join-Path \$ReleaseRoot "tools"\) "test-commandset-live\.ps1"') "SSH live smoke runner must never select the loose NAS helper as its remote execution path."
Assert-True ($scriptText -match 'live-smoke-ssh-latest\.json') "SSH live smoke runner must publish a per-machine invocation report."
Assert-True ($scriptText -match 'remoteSmokeEvidencePath' -and $scriptText -match 'reports"\) "rollout"') "SSH live smoke runner must retrieve smoke evidence and publish it centrally from the coordinator."
Assert-True ($scriptText -match 'Start-Process -FilePath `\$revitExePath') "SSH live smoke runner must be able to start Revit with the sample model."
Assert-True ($scriptText -match 'schtasks\.exe' -and $scriptText -match 'interactive_task') "SSH live smoke runner must support launching Revit in the logged-on workstation session."
Assert-True ($scriptText -match 'Test-RevAgentTcpPort') "SSH live smoke runner must wait for the local revAgent bridge before running tests."
Assert-True ($scriptText -match 'sample model verification' -and $scriptText -match "transactionMode = 'none'") "SSH live smoke runner must verify the active sample model through a read-only revAgent probe."
Assert-True ($scriptText -match 'modelVerification' -and $scriptText -match 'modelVerified') "SSH live smoke runner must record model verification evidence in the per-machine report."
Assert-True ($scriptText -notmatch 'install-updater-task\.ps1') "SSH live smoke runner must not install or repair updater scheduled tasks."
Assert-True ($scriptText -notmatch 'update-from-nas\.ps1') "SSH live smoke runner must not run workstation updates."
Assert-True ($scriptText -notmatch 'migrate-source-free-install\.ps1') "SSH live smoke runner must not run source-free migration."

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-live-smoke-ssh-test-" + [Guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $targetsPath = Join-Path $tempRoot "targets.json"
    @(
        [ordered]@{
            computer = "TEST-WORKSTATION"
            user = "TestUser"
            host = "192.0.2.10"
        },
        [ordered]@{
            computer = "OLD"
            user = "User00"
            excluded = $true
        }
    ) | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $targetsPath -Encoding UTF8

    $listOutput = & $scriptPath -TargetsPath $targetsPath -ListOnly | Out-String
    Assert-True ($listOutput -match 'TEST-WORKSTATION') "ListOnly should include the enabled test workstation without requiring -Computer."
    Assert-True ($listOutput -notmatch 'OLD') "ListOnly should exclude disabled targets."

    $missingTargetError = ""
    try {
        & $scriptPath -TargetsPath $targetsPath -OpenOnly *> $null
    }
    catch {
        $missingTargetError = $_.Exception.Message
    }
    Assert-True ([string]::Equals(
            $missingTargetError,
            "A live workstation target is required. Provide -Computer explicitly; no implicit target is selected.",
            [System.StringComparison]::Ordinal
        )) "Every live path must fail closed on a missing caller-supplied -Computer before SSH or SCP."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "SSH live smoke runner tests passed." -ForegroundColor Green
