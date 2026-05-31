<#
.SYNOPSIS
    Test read-only dashboard helpers that do not require Revit.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

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
        $Actual,
        $Expected,
        [string]$Message
    )
    if ($Actual -ne $Expected) {
        throw ("{0} Expected '{1}', got '{2}'." -f $Message, $Expected, $Actual)
    }
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

Push-Location $RepoRoot
try {
    node .\dashboard\smoke-test.mjs
}
finally {
    Pop-Location
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-live-backfill-test-" + [Guid]::NewGuid().ToString("N"))
$localLiveRoot = Join-Path $tempRoot "local\live"
$reportsRoot = Join-Path $tempRoot "reports"
$machine = "TESTPC"
$date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$localMachineRoot = Join-Path $localLiveRoot "machines\$machine"
$localActivityRoot = Join-Path $localMachineRoot "activity"
$remoteMachineRoot = Join-Path $reportsRoot "live\machines\$machine"
$remoteActivityRoot = Join-Path $remoteMachineRoot "activity"

try {
    New-Item -ItemType Directory -Path $localActivityRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $remoteActivityRoot -Force | Out-Null

    $olderStatus = [ordered]@{
        schemaVersion = "revagent.live.status.v1"
        machineName = $machine
        lastHeartbeatUtc = (Get-Date).ToUniversalTime().AddMinutes(-5).ToString("o")
    }
    $newerStatus = [ordered]@{
        schemaVersion = "revagent.live.status.v1"
        machineName = $machine
        lastHeartbeatUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    $olderStatus | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $remoteMachineRoot "status.json") -Encoding UTF8
    $newerStatus | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $localMachineRoot "status.json") -Encoding UTF8

    $event1 = '{"eventId":"1","phase":"started","taskName":"one"}'
    $event2 = '{"eventId":"2","phase":"completed","taskName":"two"}'
    $event1 | Set-Content -LiteralPath (Join-Path $remoteActivityRoot "$date.ndjson") -Encoding UTF8
    @($event1, $event2) | Set-Content -LiteralPath (Join-Path $localActivityRoot "$date.ndjson") -Encoding UTF8

    $first = & (Join-Path $RepoRoot "scripts\publish-live-backfill.ps1") `
        -ReportsRoot $reportsRoot `
        -LocalLiveRoot $localLiveRoot `
        -MachineName $machine `
        -Days 1 | ConvertFrom-Json

    Assert-True $first.statusCopied "Backfill should copy newer local status."
    Assert-Equal $first.activity[0].added 1 "Backfill should append only one missing activity line."

    $second = & (Join-Path $RepoRoot "scripts\publish-live-backfill.ps1") `
        -ReportsRoot $reportsRoot `
        -LocalLiveRoot $localLiveRoot `
        -MachineName $machine `
        -Days 1 | ConvertFrom-Json

    Assert-Equal $second.activity[0].added 0 "Backfill must not duplicate activity lines."
    $remoteLines = @(Get-Content -LiteralPath (Join-Path $remoteActivityRoot "$date.ndjson") | Where-Object { $_.Trim() })
    Assert-Equal $remoteLines.Count 2 "Remote activity line count mismatch."

    Push-Location $RepoRoot
    try {
        $brief = node -e "import('./dashboard/server.mjs').then(({buildDashboardBrief}) => { const brief = buildDashboardBrief({generatedAtUtc:'x', stable:{version:'v'}, summary:{dateUtc:'d', toolUsage:[], friction:{}}, overview:{machineCount:0}, machines:[], activity:[]}); console.log(JSON.stringify(brief)); })" | ConvertFrom-Json
    }
    finally {
        Pop-Location
    }
    Assert-Equal $brief.schemaVersion "revagent.dashboard.brief.v1" "Brief schema mismatch."

    $dashboardApp = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "dashboard\public\app.js")
    $dashboardHtml = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "dashboard\public\index.html")
    $dashboardCss = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "dashboard\public\styles.css")
    $dashboardServer = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "dashboard\server.mjs")
    Assert-True ($dashboardApp -match 'ACTIVITY_DEFAULT_LIMIT = 50') "Dashboard must default all activity to 50 records."
    Assert-True ($dashboardApp -match 'ACTIVITY_EXPANDED_LIMIT = 200') "Dashboard expanded activity must cap at 200 records."
    Assert-True ($dashboardApp -match 'REFRESH_TIMEOUT_MS') "Dashboard refreshes must have a timeout."
    Assert-True ($dashboardApp -match 'refreshInFlight') "Dashboard refreshes must not overlap."
    Assert-True ($dashboardApp -match 'data-activity-toggle') "Dashboard must expose an activity expand/collapse control."
    Assert-True ($dashboardHtml -match '(?s)activity-column.*All Status Activity.*Tool Usage.*Friction.*Machine Status Windows') "Dashboard layout must keep activity/tools/friction before machine status windows."
    Assert-True ($dashboardHtml -match 'Live Operations') "Dashboard top metrics must label live operations, not stale daily summary operations."
    Assert-True ($dashboardCss -match 'grid-template-columns:\s*minmax\(0,\s*2fr\)\s*minmax\(340px,\s*1fr\)') "Dashboard must use a 2/1 activity-to-machine status layout."
    Assert-True ($dashboardCss -match '(?s)\.bottom-grid\s*\{.*?grid-template-columns:\s*1fr;') "Dashboard must stack Tool Usage and Friction vertically."
    Assert-True ($dashboardServer -match 'DEFAULT_ACTIVITY_READ_BYTES') "Dashboard must bound activity NDJSON tail reads."
    Assert-True ($dashboardServer -match 'compactActivity') "Dashboard overview must strip raw live activity payloads."
    Assert-True ($dashboardServer -match 'summarizeLiveOperations') "Dashboard top activity metrics must be calculated from live activity."
    Assert-True ($dashboardServer -match 'metricSource: \"liveActivity\"') "Dashboard overview must expose the metric source."
    Assert-True ($dashboardServer -match 'x-content-type-options') "Dashboard responses must include nosniff headers."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Live dashboard helper tests passed." -ForegroundColor Green
