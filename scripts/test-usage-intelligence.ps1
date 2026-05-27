<#
.SYNOPSIS
    Smoke test for the revAgent usage-intelligence summary script.
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

    if ($Actual -ne $Expected) {
        throw "$Message Expected '$Expected', got '$Actual'."
    }
}

$tempRoot = Join-Path $env:TEMP ("revagent-usage-smoke-" + [Guid]::NewGuid().ToString("N"))
$reportsRoot = Join-Path $tempRoot "reports"
$machineRoot = Join-Path $reportsRoot "machines\TEST-PC"
$eventRoot = Join-Path $reportsRoot "events\2026\05\27\TEST-PC"
New-Item -ItemType Directory -Path $machineRoot -Force | Out-Null
New-Item -ItemType Directory -Path $eventRoot -Force | Out-Null

try {
    $latest = [ordered]@{
        operation = "update"
        operationMethod = "gui-update"
        status = "current"
        computerName = "TEST-PC"
        userName = "USER1"
        atUtc = "2026-05-27T08:00:00.000Z"
        previousVersion = "2026.05.27.191-test"
        targetVersion = "2026.05.27.191-test"
        installedVersion = "2026.05.27.191-test"
        localInstall = [ordered]@{
            version = "2026.05.27.191-test"
            componentCount = 43
            manifestPath = "\\nas\release\manifest.json"
        }
        diagnostics = [ordered]@{
            deferredForRevitClose = $false
            revitPayloadChanged = $false
            fastPackageOnlyUpdate = $false
        }
        machineReport = [ordered]@{
            logPath = "\\nas\reports\machines\TEST-PC\logs\latest.log"
        }
    }
    $latest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $machineRoot "latest.json") -Encoding UTF8

    $events = @(
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-1"
            eventType = "mcp.tool"
            timestampUtc = "2026-05-27T08:01:00.000Z"
            sessionId = "session-1"
            sequence = 1
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.27.191-test"; buildHash = "test" }
            toolName = "find_elements"
            taskName = "Find ducts on Level 02 Room 204"
            durationMs = 120
            result = [ordered]@{ success = $true; guarded = $false; responseKeys = @("Elements", "success") }
            params = [ordered]@{ query = [ordered]@{ text = "duct room 204" } }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-2"
            eventType = "production.context"
            timestampUtc = "2026-05-27T08:01:00.010Z"
            sessionId = "session-1"
            sequence = 2
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.27.191-test"; buildHash = "test" }
            contextSchemaVersion = "revagent.production.context.v1"
            related = [ordered]@{ sourceEventType = "mcp.tool"; toolName = "find_elements" }
            runId = "run-find"
            operation = [ordered]@{ taskName = "Find ducts on Level 02 Room 204"; action = "find_elements"; durationMs = 120; success = $true; guarded = $false }
            project = [ordered]@{ documentTitle = "Office Tower"; documentPath = "C:\Projects\Office Tower.rvt" }
            view = [ordered]@{ active = [ordered]@{ id = 10; name = "Level 02 HVAC"; type = "FloorPlan" } }
            location = [ordered]@{ levelName = "Level 02"; roomNumber = "204"; roomName = "Meeting" }
            elements = [ordered]@{
                categories = @("Ducts")
                disciplineHint = "mechanical_hvac"
                targetElementIds = @(101)
                samples = @([ordered]@{ id = 101; name = "Supply Duct"; category = "Ducts"; levelName = "Level 02"; roomNumber = "204" })
            }
            outputs = [ordered]@{ files = @() }
            response = [ordered]@{ responseKeys = @("Elements", "success") }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-3"
            eventType = "mcp.tool"
            timestampUtc = "2026-05-27T08:02:00.000Z"
            sessionId = "session-1"
            sequence = 3
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.27.191-test"; buildHash = "test" }
            toolName = "send_code_to_revit_safe"
            taskName = "Guarded write preview Level 02 Room 204"
            durationMs = 0
            result = [ordered]@{ success = $false; guarded = $true; state = "guarded"; responseKeys = @("guarded", "state") }
            params = [ordered]@{
                code = [ordered]@{
                    hash = "abc"
                    length = 90
                    lineCount = 3
                    hasManualTransaction = $true
                    writePatterns = @("Document.Delete", "Manual Transaction")
                    preview = "document.Delete(new ElementId(101));"
                }
            }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-4"
            eventType = "production.context"
            timestampUtc = "2026-05-27T08:02:00.010Z"
            sessionId = "session-1"
            sequence = 4
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.27.191-test"; buildHash = "test" }
            contextSchemaVersion = "revagent.production.context.v1"
            related = [ordered]@{ sourceEventType = "mcp.tool"; toolName = "send_code_to_revit_safe" }
            runId = "run-guarded"
            operation = [ordered]@{ taskName = "Guarded write preview Level 02 Room 204"; durationMs = 0; success = $false; guarded = $true; state = "guarded"; errorMessage = "write blocked" }
            project = [ordered]@{ documentTitle = "Office Tower" }
            view = [ordered]@{ active = [ordered]@{ id = 10; name = "Level 02 HVAC"; type = "FloorPlan" } }
            location = [ordered]@{ levelName = "Level 02"; roomNumber = "204" }
            elements = [ordered]@{ categories = @("Ducts"); disciplineHint = "mechanical_hvac"; samples = @() }
            outputs = [ordered]@{ files = @() }
            response = [ordered]@{ responseKeys = @("guarded", "state") }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-5"
            eventType = "production.context"
            timestampUtc = "2026-05-27T08:03:00.010Z"
            sessionId = "session-1"
            sequence = 5
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.27.191-test"; buildHash = "test" }
            contextSchemaVersion = "revagent.production.context.v1"
            related = [ordered]@{ sourceEventType = "mcp.tool"; toolName = "export_revit_view_image" }
            runId = "run-export"
            operation = [ordered]@{ taskName = "Export current 3D view"; durationMs = 980; success = $true; guarded = $false }
            project = [ordered]@{ documentTitle = "Office Tower" }
            view = [ordered]@{ active = [ordered]@{ id = 20; name = "{3D}"; type = "ThreeD" } }
            location = [ordered]@{}
            elements = [ordered]@{ categories = @(); disciplineHint = "mechanical_hvac"; samples = @() }
            outputs = [ordered]@{ files = @([ordered]@{ path = "C:\Temp\view.png"; fileName = "view.png"; bytes = 123; width = 600; height = 400 }) }
            response = [ordered]@{ responseKeys = @("files", "success") }
        }
    )

    $eventPath = Join-Path $eventRoot "session-1.ndjson"
    $events | ForEach-Object { ($_ | ConvertTo-Json -Depth 20 -Compress) } | Set-Content -LiteralPath $eventPath -Encoding UTF8

    $outputPath = Join-Path $tempRoot "summary.json"
    & (Join-Path $RepoRoot "scripts\summarize-usage-intelligence.ps1") `
        -ReportsRoot $reportsRoot `
        -DateUtc "2026-05-27" `
        -OutputPath $outputPath `
        -Top 10

    $summary = Get-Content -Raw -LiteralPath $outputPath | ConvertFrom-Json
    Assert-Equal $summary.schemaVersion "revagent.usage.summary.v1" "Summary schema version mismatch."
    Assert-Equal $summary.source.machineReportCount 1 "Machine report count mismatch."
    Assert-Equal $summary.source.eventFileCount 1 "Event file count mismatch."
    Assert-Equal $summary.source.eventCount 5 "Event count mismatch."
    Assert-Equal $summary.production.operationCount 3 "Production context de-dup/count mismatch."
    Assert-Equal $summary.sendCode.count 1 "send_code event count mismatch."
    Assert-Equal $summary.sendCode.manualTransactionCount 1 "Manual transaction count mismatch."
    Assert-True (($summary.sendCode.writePatterns | Where-Object { $_.name -eq "Document.Delete" }).count -eq 1) "Write pattern summary missing Document.Delete."
    Assert-True (($summary.production.byProject | Where-Object { $_.name -eq "Office Tower" }).count -eq 3) "Project rollup mismatch."
    Assert-True (($summary.production.byCategory | Where-Object { $_.name -eq "Ducts" }).count -eq 2) "Category rollup mismatch."
    Assert-Equal $summary.production.generatedFileCount 1 "Generated file count mismatch."
    Assert-Equal $summary.friction.guarded.Count 1 "Guarded operation count mismatch."

    $summaryRoot = Join-Path $reportsRoot "summaries"
    $publishOutput = & (Join-Path $RepoRoot "scripts\publish-usage-summary.ps1") `
        -ReportsRoot $reportsRoot `
        -DateUtc "2026-05-27" `
        -OutputRoot $summaryRoot `
        -Top 10

    $publishReport = $publishOutput | ConvertFrom-Json
    $dailyJson = Join-Path $summaryRoot "daily\2026-05-27.json"
    $dailyMarkdown = Join-Path $summaryRoot "daily\2026-05-27.md"
    $latestJson = Join-Path $summaryRoot "latest.json"
    $latestMarkdown = Join-Path $summaryRoot "latest.md"
    $publishLatest = Join-Path $summaryRoot "publish-latest.json"

    Assert-True (Test-Path -LiteralPath $dailyJson -PathType Leaf) "Daily JSON summary was not written."
    Assert-True (Test-Path -LiteralPath $dailyMarkdown -PathType Leaf) "Daily Markdown summary was not written."
    Assert-True (Test-Path -LiteralPath $latestJson -PathType Leaf) "Latest JSON summary was not written."
    Assert-True (Test-Path -LiteralPath $latestMarkdown -PathType Leaf) "Latest Markdown summary was not written."
    Assert-True (Test-Path -LiteralPath $publishLatest -PathType Leaf) "Publish report was not written."
    Assert-Equal $publishReport.schemaVersion "revagent.usage.publish.v1" "Publish schema version mismatch."
    Assert-Equal $publishReport.latestDateUtc "2026-05-27" "Publish latest date mismatch."
    Assert-True (Test-Path -LiteralPath $publishReport.logPath -PathType Leaf) "Publish log was not written."
    Assert-True (-not (Test-Path -LiteralPath $publishReport.lockPath -PathType Leaf)) "Publish lock was not released."

    $latestSummary = Get-Content -Raw -LiteralPath $latestJson | ConvertFrom-Json
    Assert-Equal $latestSummary.schemaVersion "revagent.usage.summary.v1" "Latest summary schema mismatch."
    Assert-Equal $latestSummary.source.eventCount 5 "Latest summary event count mismatch."
    $markdownText = Get-Content -Raw -LiteralPath $latestMarkdown
    Assert-True ($markdownText -match 'revAgent Usage Summary') "Markdown summary title missing."
    Assert-True ($markdownText -match 'Guarded write preview Level 02 Room 204') "Markdown guarded operation sample missing."

    $multiDateRoot = Join-Path $reportsRoot "summaries-multi"
    $multiDateOutput = & (Join-Path $RepoRoot "scripts\publish-usage-summary.ps1") `
        -ReportsRoot $reportsRoot `
        -DateUtc @("2026-05-26", "2026-05-27") `
        -OutputRoot $multiDateRoot `
        -Top 10
    $multiDateReport = $multiDateOutput | ConvertFrom-Json
    Assert-Equal $multiDateReport.latestDateUtc "2026-05-27" "Publish latest date must be the newest requested day."
    $multiLatest = Get-Content -Raw -LiteralPath (Join-Path $multiDateRoot "latest.json") | ConvertFrom-Json
    Assert-Equal $multiLatest.dateUtc "2026-05-27" "Latest JSON must point to the newest requested day."

    $publishScriptText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\publish-usage-summary.ps1")
    Assert-True ($publishScriptText -match 'publish\.lock') "Publish script must use a lock file."
    Assert-True ($publishScriptText -match 'usage-summary-\{0\}\.log') "Publish script must write per-run logs."
    Assert-True ($publishScriptText -match 'StaleLockMinutes') "Publish script must have stale lock handling."

    $taskScriptText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-usage-summary-task.ps1")
    Assert-True ($taskScriptText -match 'revAgent Usage Summary Publish') "Usage summary task must use the revAgent task name."
    Assert-True ($taskScriptText -match '\[string\]\$DailyAt = "20:30"') "Usage summary task must default to an after-hours schedule."
    Assert-True ($taskScriptText -match 'New-RevitMcpDailyUpdateTrigger -DailyAt \$DailyAt') "Usage summary task must use the shared daily trigger helper."
    Assert-True ($taskScriptText -match 'Write-RevitMcpHiddenPowerShellLauncher') "Usage summary task must run hidden through the shared launcher."
    Assert-True ($taskScriptText -match '\$publishParameters = @\{' -and $taskScriptText -match '& \$PublishScriptPath @publishParameters') "Usage summary task RunNow must use named splatting."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Usage intelligence summary smoke tests passed."
