<#
.SYNOPSIS
    CI-safe tests for the rollout evidence collector.
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
$scriptPath = Join-Path $RepoRoot "scripts\collect-rollout-evidence.ps1"

Assert-True (Test-Path -LiteralPath $scriptPath -PathType Leaf) "Rollout evidence collector script was not found."

$scriptText = Get-Content -Raw -LiteralPath $scriptPath -Encoding UTF8
Assert-True ($scriptText -match 'migrate-source-free-install\.ps1') "Collector must run the source-free migration helper."
Assert-True ($scriptText -match '-Mode dryRun') "Collector must run source-free migration in dryRun mode only."
Assert-True ($scriptText -match 'publish-desktop-launcher-evidence\.ps1') "Collector must run the desktop launcher evidence helper."
Assert-True ($scriptText -match '-Mode ScanLocal') "Collector must collect per-machine desktop launcher evidence."
Assert-True ($scriptText -match '-Mode\", \"Aggregate\"|-Mode", "Aggregate"') "Collector must aggregate desktop launcher evidence."
Assert-True ($scriptText -match '"-File", \$bundle\.LauncherSource') "Collector aggregate must use the tools-first launcher helper path."
Assert-True ($scriptText -notmatch 'Join-Path \$repoRoot "scripts\\publish-desktop-launcher-evidence\.ps1"') "Collector aggregate must not hardcode a repo-only helper path."
Assert-True ($scriptText -match 'Copy-RevAgentRemoteEvidenceFile') "Collector must retrieve remote evidence files back to the coordinator."
Assert-True ($scriptText -match 'Publish-RevAgentCentralEvidenceFile') "Collector must publish retrieved evidence centrally from the coordinator."
Assert-True ($scriptText -match 'source-free-migration-latest\.json') "Collector must centrally publish source-free latest evidence."
Assert-True ($scriptText -match 'desktop-launcher-latest\.json') "Collector must centrally publish desktop launcher latest evidence."
Assert-True ($scriptText -match '-OutputPath `\$desktopLauncherReportPath') "Remote desktop launcher scan must write to a local staged output file."
Assert-True ($scriptText -notmatch '-ReportsRoot `\$reportsRoot') "Remote evidence scans must not write directly to the NAS reports root."
Assert-True ($scriptText -notmatch 'install-updater-task\.ps1') "Collector must not run the updater installer."
Assert-True ($scriptText -notmatch 'ForceUpdate') "Collector must not force updates or repairs."
Assert-True ($scriptText -notmatch 'RunSourceFreeMigration') "Collector must not run source-free migration commit mode."

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-rollout-evidence-collector-test-" + [Guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $targetsPath = Join-Path $tempRoot "targets.json"
    @(
        [ordered]@{
            computer = "NET01"
            user = "Net01"
            host = "100.119.168.39"
        },
        [ordered]@{
            computer = "EMIN"
            user = "User21"
        },
        [ordered]@{
            computer = "OLD"
            user = "User00"
            excluded = $true
        }
    ) | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $targetsPath -Encoding UTF8

    $listOutput = & $scriptPath -TargetsPath $targetsPath -ListOnly | Out-String
    Assert-True ($listOutput -match 'NET01') "ListOnly should include NET01."
    Assert-True ($listOutput -match 'EMIN') "ListOnly should include EMIN."
    Assert-True ($listOutput -notmatch 'OLD') "ListOnly should exclude disabled targets."

    $filteredOutput = & $scriptPath -TargetsPath $targetsPath -Computer EMIN -ListOnly | Out-String
    Assert-True ($filteredOutput -match 'EMIN') "Computer filter should include the requested target."
    Assert-True ($filteredOutput -notmatch 'NET01') "Computer filter should exclude other targets."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Rollout evidence collector tests passed." -ForegroundColor Green
