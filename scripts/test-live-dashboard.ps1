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
    node .\addons\dashboard\tests\smoke-test.mjs
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
        $brief = node -e "import('./addons/dashboard/server/server.mjs').then(({buildDashboardBrief}) => { const brief = buildDashboardBrief({generatedAtUtc:'x', stable:{version:'v'}, summary:{dateUtc:'d', toolUsage:[], friction:{}}, overview:{machineCount:0}, machines:[], activity:[]}); console.log(JSON.stringify(brief)); })" | ConvertFrom-Json
    }
    finally {
        Pop-Location
    }
    Assert-Equal $brief.schemaVersion "revagent.dashboard.brief.v1" "Brief schema mismatch."

    $installedDashboardRoot = Join-Path $tempRoot "installed\addons\dashboard"
    $installResult = & (Join-Path $RepoRoot "addons\dashboard\installer\install-dashboard-addon.ps1") `
        -SourceRoot (Join-Path $RepoRoot "addons\dashboard") `
        -InstallRoot $installedDashboardRoot `
        -ReportsRoot $reportsRoot `
        -SkipScheduledTasks `
        -NoHealthCheck | ConvertFrom-Json
    Assert-Equal $installResult.schemaVersion "revagent.dashboard.addon.install.v1" "Dashboard add-on installer result schema mismatch."
    Assert-Equal ([bool]$installResult.installed) $true "Dashboard add-on installer should report installed=true."
    Assert-True (Test-Path -LiteralPath (Join-Path $installedDashboardRoot "server\server.mjs") -PathType Leaf) "Installed dashboard server missing."
    Assert-True (Test-Path -LiteralPath (Join-Path $installedDashboardRoot "server\revitTaskMerge.js") -PathType Leaf) "Installed dashboard must carry local Revit task merge helper."
    Assert-True (Test-Path -LiteralPath (Join-Path $installedDashboardRoot "public\index.html") -PathType Leaf) "Installed dashboard public UI missing."
    Assert-True (Test-Path -LiteralPath (Join-Path $installedDashboardRoot "installer\start-dashboard.ps1") -PathType Leaf) "Installed dashboard start script missing."
    $installedConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $installedDashboardRoot "config\dashboard.json") | ConvertFrom-Json
    Assert-Equal $installedConfig.schemaVersion "revagent.dashboard.addon.config.v1" "Dashboard add-on config schema mismatch."
    Assert-Equal $installedConfig.reportsRoot $reportsRoot "Dashboard add-on config must preserve reports root."

    $canonicalReleaseRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy"
    $canonicalReportsRoot = Join-Path $canonicalReleaseRoot "reports"
    $defaultDashboardRoot = Join-Path $tempRoot "installed-default\addons\dashboard"
    $defaultInstallResult = & (Join-Path $RepoRoot "addons\dashboard\installer\install-dashboard-addon.ps1") `
        -SourceRoot (Join-Path $RepoRoot "addons\dashboard") `
        -InstallRoot $defaultDashboardRoot `
        -SkipScheduledTasks `
        -NoHealthCheck | ConvertFrom-Json
    Assert-Equal $defaultInstallResult.reportsRoot $canonicalReportsRoot "Dashboard add-on default install must use the canonical revAgent reports root."
    Assert-Equal $defaultInstallResult.releaseRoot $canonicalReleaseRoot "Dashboard add-on default install must use the canonical revAgent release root."
    $defaultConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $defaultDashboardRoot "config\dashboard.json") | ConvertFrom-Json
    Assert-Equal $defaultConfig.reportsRoot $canonicalReportsRoot "Dashboard default config must persist the canonical revAgent reports root."

    $legacyDashboardRoot = Join-Path $tempRoot "installed-legacy\addons\dashboard"
    $legacyConfigPath = Join-Path $legacyDashboardRoot "config\dashboard.json"
    New-Item -ItemType Directory -Path (Split-Path -Parent $legacyConfigPath) -Force | Out-Null
    [ordered]@{
        schemaVersion = "revagent.dashboard.addon.config.v1"
        reportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports"
        releaseRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"
        hostName = "127.0.0.1"
        port = 8765
        staleSeconds = 60
        offlineSeconds = 300
        updatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $legacyConfigPath -Encoding UTF8
    $legacyMigrationResult = & (Join-Path $RepoRoot "addons\dashboard\installer\install-dashboard-addon.ps1") `
        -SourceRoot (Join-Path $RepoRoot "addons\dashboard") `
        -InstallRoot $legacyDashboardRoot `
        -SkipScheduledTasks `
        -NoHealthCheck | ConvertFrom-Json
    Assert-Equal ([bool]$legacyMigrationResult.migratedLegacyReportRoot) $true "Dashboard add-on installer must report legacy report-root migration."
    Assert-Equal $legacyMigrationResult.reportsRoot $canonicalReportsRoot "Dashboard add-on installer must migrate legacy reports root to canonical revAgent reports."
    Assert-Equal $legacyMigrationResult.releaseRoot $canonicalReleaseRoot "Dashboard add-on installer must migrate legacy release root to canonical revAgent release root."
    $legacyMigratedConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $legacyConfigPath | ConvertFrom-Json
    Assert-Equal $legacyMigratedConfig.reportsRoot $canonicalReportsRoot "Dashboard legacy config must be rewritten to canonical revAgent reports root."
    Assert-Equal $legacyMigratedConfig.releaseRoot $canonicalReleaseRoot "Dashboard legacy config must be rewritten to canonical revAgent release root."

    $legacyTunnelRoot = Join-Path $tempRoot "DPE\RevitMCP\cloudflared"
    New-Item -ItemType Directory -Path $legacyTunnelRoot -Force | Out-Null
    $legacyCloudflared = Join-Path $legacyTunnelRoot "cloudflared.exe"
    Set-Content -LiteralPath $legacyCloudflared -Value "fake-cloudflared" -Encoding ASCII
    $legacyCredentials = Join-Path $legacyTunnelRoot "dashboard-credentials.json"
    Set-Content -LiteralPath $legacyCredentials -Value '{"AccountTag":"redacted","TunnelSecret":"redacted"}' -Encoding ASCII
    $legacyConfig = Join-Path $legacyTunnelRoot "config.yml"
    @(
        "tunnel: dashboard",
        "credentials-file: ""$legacyCredentials""",
        "ingress:",
        "  - hostname: dashboard.revagent.app",
        "    service: http://127.0.0.1:8765",
        "  - service: http_status:404",
        "logfile: ""$(Join-Path $legacyTunnelRoot "old-cloudflared.log")"""
    ) | Set-Content -LiteralPath $legacyConfig -Encoding UTF8

    $installWithTunnelResult = & (Join-Path $RepoRoot "addons\dashboard\installer\install-dashboard-addon.ps1") `
        -SourceRoot (Join-Path $RepoRoot "addons\dashboard") `
        -InstallRoot $installedDashboardRoot `
        -ReportsRoot $reportsRoot `
        -SkipScheduledTasks `
        -NoHealthCheck `
        -MigrateTunnel `
        -LegacyTunnelRoot $legacyTunnelRoot `
        -SkipTunnelScheduledTasks `
        -NoTunnelHealthCheck | ConvertFrom-Json
    Assert-Equal $installWithTunnelResult.tunnel.schemaVersion "revagent.dashboard.tunnel.install.v1" "Dashboard tunnel installer result schema mismatch."
    Assert-Equal ([bool]$installWithTunnelResult.tunnel.installed) $true "Dashboard tunnel installer should report installed=true."
    Assert-True (Test-Path -LiteralPath (Join-Path $installedDashboardRoot "tunnel\bin\cloudflared.exe") -PathType Leaf) "Installed dashboard tunnel cloudflared.exe missing."
    Assert-True (Test-Path -LiteralPath (Join-Path $installedDashboardRoot "tunnel\config\config.yml") -PathType Leaf) "Installed dashboard tunnel config missing."
    Assert-True (Test-Path -LiteralPath (Join-Path $installedDashboardRoot "tunnel\config\dashboard-credentials.json") -PathType Leaf) "Installed dashboard tunnel credentials should be copied without printing contents."
    $installedTunnelConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $installedDashboardRoot "tunnel\config\config.yml")
    Assert-True ($installedTunnelConfig -match 'dashboard\.revagent\.app') "Installed dashboard tunnel config must preserve dashboard hostname."
    Assert-True ($installedTunnelConfig -match [regex]::Escape((Join-Path $installedDashboardRoot "tunnel\logs\cloudflared.log"))) "Installed dashboard tunnel config must rewrite logfile to the add-on log root."
    Assert-True ($installedTunnelConfig -match [regex]::Escape((Join-Path $installedDashboardRoot "tunnel\config\dashboard-credentials.json"))) "Installed dashboard tunnel config must rewrite credentials-file to the add-on config root."
    Assert-True ($installedTunnelConfig -match "credentials-file: '" -and $installedTunnelConfig -match "logfile: '") "Installed dashboard tunnel config must write Windows paths as YAML single-quoted scalars."
    Assert-True ($installedTunnelConfig -notmatch [regex]::Escape((Join-Path $legacyTunnelRoot "old-cloudflared.log"))) "Installed dashboard tunnel config must not keep the legacy logfile path."

    $previousUserProfile = $env:USERPROFILE
    $tunnelId = "02061634-3336-402b-8976-81ca9579ae81"
    try {
        $profileRoot = Join-Path $tempRoot "profile"
        $cloudflaredProfileRoot = Join-Path $profileRoot ".cloudflared"
        New-Item -ItemType Directory -Path $cloudflaredProfileRoot -Force | Out-Null
        $env:USERPROFILE = $profileRoot
        $profileCredential = Join-Path $cloudflaredProfileRoot "$tunnelId.json"
        Set-Content -LiteralPath $profileCredential -Value '{"AccountTag":"redacted","TunnelSecret":"redacted-from-profile"}' -Encoding ASCII
        @(
            "tunnel: $tunnelId",
            "credentials-file: C:\ProgramData\DPE\RevitMCP\cloudflared\$tunnelId.json",
            "ingress:",
            "  - hostname: dashboard.revagent.app",
            "    service: http://127.0.0.1:8765",
            "  - service: http_status:404"
        ) | Set-Content -LiteralPath $legacyConfig -Encoding UTF8

        $profileCredentialResult = & (Join-Path $RepoRoot "addons\dashboard\installer\install-dashboard-tunnel.ps1") `
            -InstallRoot $installedDashboardRoot `
            -LegacyTunnelRoot $legacyTunnelRoot `
            -SkipScheduledTasks `
            -NoHealthCheck | ConvertFrom-Json
        Assert-Equal $profileCredentialResult.credentialFileName "$tunnelId.json" "Tunnel installer must discover default user-profile Cloudflare credentials when legacy config points to a stale ProgramData path."
        Assert-True (Test-Path -LiteralPath (Join-Path $installedDashboardRoot "tunnel\config\$tunnelId.json") -PathType Leaf) "Tunnel installer must copy discovered user-profile credentials into the add-on config root."
        $profileCredentialConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $installedDashboardRoot "tunnel\config\config.yml")
        Assert-True ($profileCredentialConfig -match [regex]::Escape((Join-Path $installedDashboardRoot "tunnel\config\$tunnelId.json"))) "Tunnel installer must rewrite stale credentials-file paths to the discovered add-on-local credential path."
        Assert-True ($profileCredentialConfig -notmatch 'C:\\ProgramData\\DPE\\RevitMCP\\cloudflared') "Tunnel installer must not preserve stale legacy credential paths when user-profile credentials are discovered."
    }
    finally {
        $env:USERPROFILE = $previousUserProfile
    }

    Push-Location $installedDashboardRoot
    try {
        $installedBrief = node --input-type=module -e "import('./server/server.mjs').then(({buildDashboardBrief}) => { const brief = buildDashboardBrief({generatedAtUtc:'installed', stable:{version:'v'}, summary:{dateUtc:'d'}, overview:{machineCount:0}, machines:[], activity:[]}); console.log(JSON.stringify(brief)); })" | ConvertFrom-Json
    }
    finally {
        Pop-Location
    }
    Assert-Equal $installedBrief.schemaVersion "revagent.dashboard.brief.v1" "Installed dashboard server must import without repository-relative runtime dependencies."

    $dashboardApp = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\dashboard\public\app.js")
    $dashboardHtml = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\dashboard\public\index.html")
    $dashboardCss = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\dashboard\public\styles.css")
    $dashboardServer = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\dashboard\server\server.mjs")
    $dashboardInstaller = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\dashboard\installer\install-dashboard-addon.ps1")
    $dashboardTunnelInstaller = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\dashboard\installer\install-dashboard-tunnel.ps1")
    $dashboardTunnelStart = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\dashboard\installer\start-dashboard-tunnel.ps1")
    $dashboardInstallerWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-dashboard-addon.ps1")
    $dashboardTunnelInstallerWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-dashboard-tunnel.ps1")
    $dashboardManifest = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\dashboard\addon.json") | ConvertFrom-Json
    Assert-True ($dashboardApp -match 'ACTIVITY_DEFAULT_LIMIT = 50') "Dashboard must default all activity to 50 records."
    Assert-True ($dashboardApp -match 'ACTIVITY_EXPANDED_LIMIT = 200') "Dashboard expanded activity must cap at 200 records."
    Assert-True ($dashboardApp -match 'REFRESH_TIMEOUT_MS') "Dashboard refreshes must have a timeout."
    Assert-True ($dashboardApp -match 'refreshInFlight') "Dashboard refreshes must not overlap."
    Assert-True ($dashboardApp -match 'data-activity-toggle') "Dashboard must expose an activity expand/collapse control."
    Assert-True ($dashboardApp -match 'selectedMachines') "Dashboard must support multi-machine monitoring filters."
    Assert-True ($dashboardApp -match 'connectionLabels') "Machine cards must show connection state separately."
    Assert-True ($dashboardApp -match 'versionLabels') "Machine cards must show version state separately."
    Assert-True ($dashboardApp -match 'taskLabels') "Machine cards must show task state separately."
    Assert-True ($dashboardApp -match 'Up to date') "Machine cards must use clear up-to-date wording."
    Assert-True ($dashboardApp -match 'Running') "Machine cards must use clear running wording."
    Assert-True ($dashboardApp -match 'captureActivityScroll') "Dashboard refresh must capture activity scroll before rerendering."
    Assert-True ($dashboardApp -match 'restoreActivityScroll') "Dashboard refresh must restore manual activity scroll after rerendering."
    Assert-True ($dashboardApp -match 'activityScrollAwayFromTop') "Dashboard refresh must remember when the user manually scrolled activity away from the top."
    Assert-True ($dashboardApp -match 'suppressActivityScrollTracking') "Dashboard programmatic scroll resets must not overwrite manual scroll state."
    Assert-True ($dashboardApp -notmatch 'scrollStatusWindowsToTop') "Dashboard refresh must not force every status window back to the top."
    Assert-True ($dashboardApp -match 'formatDurationMs') "Dashboard durations must be formatted consistently in seconds."
    Assert-True ($dashboardApp -match 'formatBytes') "Dashboard task rows must be able to show payload size."
    Assert-True ($dashboardApp -match 'Last seen') "Machine cards must show user-facing last-seen wording."
    Assert-True ($dashboardApp -notmatch 'Current task|active-task') "Machine cards must not duplicate live task text."
    Assert-True ($dashboardApp -notmatch '>Heartbeat<|machine\.updateStatus') "Machine cards must not expose heartbeat age or update status fields."
    Assert-True ($dashboardHtml -match 'viewport-fit=cover') "Dashboard must support iPhone safe-area viewport rendering."
    Assert-True ($dashboardHtml -match '(?s)Machine Status Windows.*All Status Activity') "Dashboard layout must put machine status windows before all status activity."
    Assert-True ($dashboardHtml -match 'activityFilters') "Dashboard must expose machine filters for All Status Activity."
    Assert-True ($dashboardHtml -notmatch 'Tool Usage|Friction|Live Operations|metricMachines') "Dashboard must stay simplified without summary metrics, Tool Usage, or Friction panels."
    Assert-True ($dashboardCss -match 'grid-template-columns:\s*minmax\(280px,\s*1fr\)\s*minmax\(0,\s*2fr\)') "Dashboard must use a 1/2 machine-to-activity desktop layout."
    Assert-True ($dashboardCss -match 'activity-filters') "Dashboard must style the machine activity filters."
    Assert-True ($dashboardCss -match 'machine-badges') "Machine cards must lay out separate status badges."
    Assert-True ($dashboardCss -notmatch 'state-pill') "Machine cards must not use a single combined state pill."
    Assert-True ($dashboardCss -match 'grid-auto-rows:\s*max-content') "Mobile machine cards must not be vertically squeezed by CSS grid track stretching."
    Assert-True ($dashboardCss -match 'align-content:\s*start') "Mobile machine grid must keep cards at their content height."
    Assert-True ($dashboardCss -match '@media\s*\(max-width:\s*480px\)') "Dashboard must include iPhone-width responsive rules."
    Assert-True ($dashboardCss -match 'safe-area-inset') "Dashboard must account for iPhone safe-area insets."
    Assert-True ($dashboardCss -match '100svh') "Dashboard must use mobile-safe viewport height units."
    Assert-True ($dashboardCss -match '(?s)\.machines-panel\s*\{.*?max-height:\s*36svh') "Mobile machine list must be bounded so it does not bury activity."
    Assert-True ($dashboardCss -match 'overflow-x:\s*auto') "Mobile machine filters must remain horizontally scrollable."
    Assert-True ($dashboardCss -match '(?s)\.machine-card\s*\{.*?min-height:\s*0') "Machine status cards must stay compact for large office deployments."
    Assert-True ($dashboardCss -notmatch 'min-height:\s*136px') "Machine status cards must not keep the old tall-card spacing."
    Assert-True ($dashboardCss -match '(?s)\.status-line\s*\{.*?min-height:\s*28px') "All Status Activity rows must stay compact."
    Assert-True ($dashboardServer -match 'DEFAULT_ACTIVITY_READ_BYTES') "Dashboard must bound activity NDJSON tail reads."
    Assert-True ($dashboardServer -match 'revAgent-deploy\\\\reports') "Dashboard server default reports root must use the canonical revAgent NAS root."
    Assert-True ($dashboardServer -notmatch 'DEFAULT_REPORTS_ROOT = "\\\\\\\\DPE-NAS\\\\Dpe-Ortak\\\\Baris Tankut\\\\revit-mcp-deploy\\\\reports"') "Dashboard server default reports root must not fall back to the legacy NAS root."
    Assert-True ($dashboardServer -match 'compactActivity') "Dashboard overview must strip raw live activity payloads."
    Assert-True ($dashboardServer -match 'buildStatusActivities') "Dashboard must collapse raw live activity into status-window style task rows."
    Assert-True ($dashboardServer -match 'connectionStateFor') "Dashboard server must calculate connection state independently."
    Assert-True ($dashboardServer -match 'offlineSeconds') "Dashboard server must use a separate offline threshold instead of treating old heartbeat files as stale forever."
    Assert-True ($dashboardServer -match 'REVAGENT_DASHBOARD_OFFLINE_SECONDS') "Dashboard offline threshold must be configurable."
    Assert-True ($dashboardServer -match 'versionStateFor') "Dashboard server must calculate version state independently."
    Assert-True ($dashboardServer -match 'taskStateFor') "Dashboard server must calculate task state independently."
    Assert-True ($dashboardServer -match 'buildRevitStatusActivities') "Dashboard must prefer Revit status history when available."
    Assert-True ($dashboardServer -match 'revagent\.dashboard\.revit-status-task\.v1') "Dashboard must normalize Revit status tasks into status-window rows."
    Assert-True ($dashboardServer -notmatch 'shouldPreferTelemetryState') "Dashboard must not override Revit status-window state with inner telemetry state."
    Assert-True ($dashboardServer -match 'groupedEventCount') "Dashboard activity rows must report grouped raw event counts for diagnostics."
    Assert-True ($dashboardServer -match 'requestBytes') "Dashboard activity rows must preserve Revit status request/response byte counts."
    Assert-True ($dashboardServer -match 'summarizeLiveOperations') "Dashboard top activity metrics must be calculated from live activity."
    Assert-True ($dashboardServer -match 'metricSource: \"liveActivity\"') "Dashboard overview must expose the metric source."
    Assert-True ($dashboardServer -match 'x-content-type-options') "Dashboard responses must include nosniff headers."
    Assert-True ($dashboardServer -match '\./revitTaskMerge\.js') "Dashboard server must depend on add-on-local helper code for installed execution."
    Assert-Equal $dashboardManifest.entrypoints.installScript "installer\install-dashboard-addon.ps1" "Dashboard add-on manifest must expose installer entrypoint."
    Assert-True ($dashboardInstaller -match '\[string\]\$TaskName = "revAgent Dashboard Server"') "Dashboard add-on installer must own the dashboard scheduled task name."
    Assert-True ($dashboardInstaller -match 'CanonicalReportsRoot') "Dashboard add-on installer must define a canonical revAgent reports root."
    Assert-True ($dashboardInstaller -match 'migratedLegacyReportRoot') "Dashboard add-on installer must report legacy reports-root migration."
    Assert-True ($dashboardInstaller -notmatch '\[string\]\$ReportsRoot = "\\\\DPE-NAS\\Dpe-Ortak\\Baris Tankut\\revit-mcp-deploy\\reports"') "Dashboard add-on installer must not default to the legacy NAS reports root."
    Assert-True ($dashboardInstaller -match 'New-ScheduledTaskTrigger -AtLogOn') "Dashboard add-on installer must register a logon dashboard task."
    Assert-True ($dashboardInstaller -match 'Invoke-SchtasksCreateLogonTask') "Dashboard add-on installer must fall back to schtasks.exe for non-elevated coordinator installs."
    Assert-True ($dashboardInstaller -match 'Register-HkcuRunStartup') "Dashboard add-on installer must have a no-admin HKCU startup fallback."
    Assert-True ($dashboardInstaller -match 'Test-Path -LiteralPath \$runKey') "Dashboard add-on installer must preserve existing HKCU Run values when adding startup fallback."
    Assert-True ($dashboardInstaller -match 'scheduledTaskRegistrationMethod') "Dashboard add-on installer must report the scheduled task registration method."
    Assert-True ($dashboardInstaller -match 'startupRegistrationMethod') "Dashboard add-on installer must report the startup registration method."
    Assert-True ($dashboardInstaller -match 'Run-revAgent-Dashboard-Server-Hidden\.vbs') "Dashboard add-on installer must use a hidden revAgent dashboard launcher."
    Assert-True ($dashboardInstaller -match '\[switch\]\$MigrateTunnel') "Dashboard add-on installer must expose explicit tunnel migration."
    Assert-Equal $dashboardManifest.entrypoints.installTunnelScript "installer\install-dashboard-tunnel.ps1" "Dashboard add-on manifest must expose tunnel installer entrypoint."
    Assert-Equal $dashboardManifest.entrypoints.startTunnelScript "installer\start-dashboard-tunnel.ps1" "Dashboard add-on manifest must expose tunnel start entrypoint."
    Assert-True ($dashboardTunnelInstaller -match '\[string\]\$TaskName = "revAgent Dashboard Tunnel"') "Dashboard tunnel installer must own the tunnel scheduled task name."
    Assert-True ($dashboardTunnelInstaller -match 'Invoke-SchtasksCreateLogonTask') "Dashboard tunnel installer must fall back to schtasks.exe for non-elevated coordinator installs."
    Assert-True ($dashboardTunnelInstaller -match 'Register-HkcuRunStartup') "Dashboard tunnel installer must have a no-admin HKCU startup fallback."
    Assert-True ($dashboardTunnelInstaller -match 'Test-Path -LiteralPath \$runKey') "Dashboard tunnel installer must preserve existing HKCU Run values when adding startup fallback."
    Assert-True ($dashboardTunnelInstaller -match 'scheduledTaskRegistrationMethod') "Dashboard tunnel installer must report the scheduled task registration method."
    Assert-True ($dashboardTunnelInstaller -match 'startupRegistrationMethod') "Dashboard tunnel installer must report the startup registration method."
    Assert-True ($dashboardTunnelInstaller -match 'StopLegacyOnSuccess requires RunNow with successful health checks') "Dashboard tunnel installer must not stop legacy tunnel before the new tunnel is healthy."
    Assert-True ($dashboardTunnelInstaller -match 'RemoveLegacyOnSuccess requires RunNow with successful health checks') "Dashboard tunnel installer must not remove legacy tunnel before the new tunnel is healthy."
    Assert-True ($dashboardTunnelInstaller -match 'Assert-LegacyTunnelRootIsNarrow') "Dashboard tunnel installer must keep legacy cleanup scoped to the legacy cloudflared root."
    Assert-True ($dashboardTunnelInstaller -match 'Disable-LegacyTunnelScheduledTasks') "Dashboard tunnel installer must disable legacy tunnel tasks only after successful migration."
    Assert-True ($dashboardTunnelStart -match 'cloudflared\.exe' -and $dashboardTunnelStart -match 'tunnel --config') "Dashboard tunnel start script must run cloudflared with the installed config."
    Assert-True ($dashboardInstallerWrapper -match 'addons\\dashboard\\installer\\install-dashboard-addon\.ps1') "Dashboard root installer wrapper must delegate to the add-on installer."
    Assert-True ($dashboardTunnelInstallerWrapper -match 'addons\\dashboard\\installer\\install-dashboard-tunnel\.ps1') "Dashboard tunnel root installer wrapper must delegate to the add-on tunnel installer."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Live dashboard helper tests passed." -ForegroundColor Green
