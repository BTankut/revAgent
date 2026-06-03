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
$rawOnlyEventRoot = Join-Path $reportsRoot "events\2026\05\26\TEST-PC"
$eventRoot = Join-Path $reportsRoot "events\2026\05\27\TEST-PC"
New-Item -ItemType Directory -Path $machineRoot -Force | Out-Null
New-Item -ItemType Directory -Path $rawOnlyEventRoot -Force | Out-Null
New-Item -ItemType Directory -Path $eventRoot -Force | Out-Null
$turkishTaskName = "Raw-only sheet text scan with Turkish dotless $([char]0x0131), cell $([char]0x00FC), view $([char]0x00F6)"

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

    $rawOnlyEvents = @(
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-raw-1"
            eventType = "mcp.tool"
            timestampUtc = "2026-05-26T08:01:00.000Z"
            sessionId = "session-raw"
            sequence = 1
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.27.191-test"; buildHash = "test" }
            toolName = "send_code_to_revit_safe"
            taskName = $turkishTaskName
            durationMs = 620
            result = [ordered]@{ success = $false; guarded = $false; state = "failed"; errorMessage = "compile failed"; responseKeys = @("success", "error") }
            params = [ordered]@{
                code = [ordered]@{
                    hash = "raw"
                    length = 55
                    lineCount = 2
                    hasManualTransaction = $false
                    writePatterns = @()
                    preview = "bad code"
                }
            }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-raw-1-command"
            eventType = "revit.command"
            timestampUtc = "2026-05-26T08:01:02.000Z"
            sessionId = "session-raw"
            sequence = 2
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.27.191-test"; buildHash = "test" }
            commandName = "send_code_to_revit_safe"
            logicalToolName = "send_code_to_revit_safe"
            taskName = $turkishTaskName
            durationMs = 618
            result = [ordered]@{ success = $false; guarded = $false; state = "failed"; errorMessage = "compile failed"; responseKeys = @("success", "error") }
            params = [ordered]@{}
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-raw-2"
            eventType = "mcp.tool"
            timestampUtc = "2026-05-26T08:02:00.000Z"
            sessionId = "session-raw"
            sequence = 3
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.27.191-test"; buildHash = "test" }
            toolName = "get_revit_session_context"
            taskName = "Raw-only slow session context"
            durationMs = 3665
            result = [ordered]@{ success = $true; guarded = $false; responseKeys = @("document", "activeView") }
            params = [ordered]@{}
        }
    )

    $rawOnlyEventPath = Join-Path $rawOnlyEventRoot "session-raw.ndjson"
    $rawOnlyEvents | ForEach-Object { ($_ | ConvertTo-Json -Depth 20 -Compress) } | Set-Content -LiteralPath $rawOnlyEventPath -Encoding UTF8

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
            search = [ordered]@{
                query = "duct room 204"
                inferredScope = [ordered]@{ categoryNames = @("Ducts"); residualQuery = "room 204" }
                effectiveScope = [ordered]@{ categoryNames = @("Ducts"); linkScope = "hostOnly" }
                riskPolicy = [ordered]@{
                    riskLevel = "low"
                    recommendedFirstScope = @("categoryNames=Ducts")
                    requiresUserControl = $false
                }
                riskLevel = "low"
                recommendedFirstScope = @("categoryNames=Ducts")
                requiresUserControl = $false
                scanPolicy = [ordered]@{ searchBudget = "fast"; maxElapsedMs = 4500; planCandidateMode = "none" }
                searchBudget = "fast"
                linkScope = "hostOnly"
                planCandidateMode = "none"
                allowExpensiveSearch = $false
                scannedElementCount = 18
                partial = $false
                scanStoppedReason = $null
                needsScope = $false
            }
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
                    preview = "document.Delete(new ElementId(101)); sectionData.SetCellText(1, 2, ""R914X023"");"
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
            operation = [ordered]@{ taskName = "M701 schedule export Level 03"; durationMs = 980; success = $true; guarded = $false }
            project = [ordered]@{ documentTitle = "Office Tower" }
            view = [ordered]@{ active = [ordered]@{ id = 20; name = "Level 03 Mechanical"; type = "DrawingSheet" } }
            location = [ordered]@{}
            elements = [ordered]@{ categories = @(); disciplineHint = $null; samples = @() }
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

    $summary = Get-Content -Raw -Encoding UTF8 -LiteralPath $outputPath | ConvertFrom-Json
    Assert-Equal $summary.schemaVersion "revagent.usage.summary.v1" "Summary schema version mismatch."
    Assert-Equal $summary.source.machineReportCount 1 "Machine report count mismatch."
    Assert-Equal $summary.source.eventFileCount 1 "Event file count mismatch."
    Assert-Equal $summary.source.eventCount 5 "Event count mismatch."
    Assert-Equal $summary.production.operationCount 3 "Production context de-dup/count mismatch."
    Assert-Equal $summary.sendCode.count 1 "send_code event count mismatch."
    Assert-Equal $summary.sendCode.manualTransactionCount 1 "Manual transaction count mismatch."
    Assert-True (($summary.sendCode.writePatterns | Where-Object { $_.name -eq "Document.Delete" }).count -eq 1) "Write pattern summary missing Document.Delete."
    Assert-True (($summary.sendCode.writePatterns | Where-Object { $_.name -eq "Schedule.SetCellText" }).count -eq 1) "Write pattern summary missing Schedule.SetCellText preview detection."
    Assert-Equal $summary.sendCode.candidateRepeatThreshold 2 "Dynamic promotion repeat threshold mismatch."
    $dynamicCandidate = @($summary.sendCode.promotionCandidates | Where-Object { $_.hash -eq "abc" }) | Select-Object -First 1
    Assert-True ($null -ne $dynamicCandidate) "Dynamic write/manual transaction pattern must be promoted as a native tool candidate."
    Assert-True (@($dynamicCandidate.promotionReasons | Where-Object { $_ -eq "write_patterns_present" }).Count -eq 1) "Dynamic candidate must include write pattern reason."
    Assert-True (@($dynamicCandidate.promotionReasons | Where-Object { $_ -eq "manual_transaction" }).Count -eq 1) "Dynamic candidate must include manual transaction reason."
    Assert-Equal $dynamicCandidate.candidateAction "design_native_tool_with_preflight_and_verification" "Dynamic candidate action should come from the promotion registry."
    Assert-True (@($dynamicCandidate.registryMatches).Count -ge 1) "Dynamic candidate must include registry matches."
    Assert-True (@(@($dynamicCandidate.writePatterns) | Where-Object { $_.name -eq "Schedule.SetCellText" }).Count -eq 1) "Dynamic candidate must carry Schedule.SetCellText pattern evidence."
    Assert-True (($summary.production.byProject | Where-Object { $_.name -eq "Office Tower" }).count -eq 3) "Project rollup mismatch."
    Assert-True (($summary.production.byDiscipline | Where-Object { $_.name -eq "mechanical_hvac" }).count -eq 3) "Discipline fallback rollup mismatch."
    Assert-True (($summary.production.byLevel | Where-Object { $_.name -eq "Level 03" }).count -eq 1) "Level fallback rollup mismatch."
    Assert-True (($summary.production.byCategory | Where-Object { $_.name -eq "Ducts" }).count -eq 2) "Category rollup mismatch."
    Assert-Equal $summary.production.generatedFileCount 1 "Generated file count mismatch."
    Assert-Equal @($summary.production.searchPolicySamples).Count 1 "Search policy sample count mismatch."
    Assert-Equal $summary.production.searchPolicySamples[0].searchBudget "fast" "Search policy budget was not preserved."
    Assert-Equal $summary.production.searchPolicySamples[0].riskLevel "low" "Search policy risk level was not preserved."
    Assert-Equal ([bool]$summary.production.searchPolicySamples[0].requiresUserControl) $false "Search policy user-control flag was not preserved."
    Assert-Equal $summary.production.searchPolicySamples[0].linkScope "hostOnly" "Search policy link scope was not preserved."
    Assert-Equal $summary.production.searchPolicySamples[0].scannedElementCount 18 "Search policy scanned count was not preserved."
    Assert-Equal ([bool]$summary.production.searchPolicySamples[0].partial) $false "Search policy partial flag was not preserved."
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

    $latestSummary = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestJson | ConvertFrom-Json
    Assert-Equal $latestSummary.schemaVersion "revagent.usage.summary.v1" "Latest summary schema mismatch."
    Assert-Equal $latestSummary.source.eventCount 5 "Latest summary event count mismatch."
    $markdownText = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestMarkdown
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
    $multiLatest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $multiDateRoot "latest.json") | ConvertFrom-Json
    Assert-Equal $multiLatest.dateUtc "2026-05-27" "Latest JSON must point to the newest requested day."

    $rawOnlySummary = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $multiDateRoot "daily\2026-05-26.json") | ConvertFrom-Json
    Assert-Equal $rawOnlySummary.source.eventCount 3 "Raw-only summary event count mismatch."
    Assert-Equal $rawOnlySummary.production.operationCount 0 "Raw-only day must not invent production context operations."
    Assert-Equal $rawOnlySummary.production.byProject.Count 0 "Raw-only project rollup must be an empty array."
    Assert-Equal $rawOnlySummary.production.byMachineUser.Count 0 "Raw-only machine-user rollup must be an empty array."
    Assert-Equal @($rawOnlySummary.friction.failed).Count 1 "Raw-only failed tool event must appear in failed samples."
    Assert-True (@(@($rawOnlySummary.friction.failed) | Where-Object { $_.taskName -eq $turkishTaskName }).Count -eq 1) "Raw-only failed sample task missing or not de-duplicated."
    Assert-True (@(@($rawOnlySummary.friction.failed) | Where-Object { $_.sourceEventType -eq "mcp.tool" }).Count -eq 1) "Raw-only duplicate mcp.tool/revit.command sample must prefer the MCP tool event."
    Assert-True (@(@($rawOnlySummary.friction.slow) | Where-Object { $_.taskName -eq "Raw-only slow session context" }).Count -eq 1) "Raw-only slow sample task missing."
    $rawOnlyMarkdown = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $multiDateRoot "daily\2026-05-26.md")
    Assert-True ($rawOnlyMarkdown -match [regex]::Escape($turkishTaskName)) "Raw-only failed sample missing from Markdown or UTF-8 text was corrupted."
    Assert-True ($rawOnlyMarkdown -notmatch 'Ä±|Ã¼|Ã¶') "Markdown summary must not contain mojibake for Turkish task text."
    Assert-True ($rawOnlyMarkdown -match '## Failed Operations') "Markdown failed operation section missing."
    Assert-True ($rawOnlyMarkdown -match 'No data.') "Raw-only empty rollups must render as No data."
    Assert-True ($rawOnlyMarkdown -notmatch '\| \s*\| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \|') "Markdown must not render blank zero metric rows."

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
