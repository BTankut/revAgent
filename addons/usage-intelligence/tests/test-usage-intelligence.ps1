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
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$usageScriptsRoot = Join-Path $RepoRoot "addons\usage-intelligence\scripts"

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

function Assert-CandidateEvidenceContext {
    param(
        [object]$Candidate,
        [string]$Message
    )

    Assert-True ($null -ne $Candidate) "$Message Candidate was missing."
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$Candidate.evidenceSnippet)) "$Message Evidence snippet missing."
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$Candidate.sessionContext.sessionId)) "$Message Session context missing."
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$Candidate.toolContext.toolName)) "$Message Tool context missing."
    Assert-True ($Candidate.humanReviewRequired -eq $true) "$Message Human review flag must be true."
    Assert-True ($null -eq $Candidate.PSObject.Properties["priority"]) "$Message Candidate must not auto-escalate priority."
    Assert-True ($null -eq $Candidate.PSObject.Properties["priorityEscalated"]) "$Message Candidate must not report automatic priority escalation."
}

$tempRoot = Join-Path $env:TEMP ("revagent-usage-smoke-" + [Guid]::NewGuid().ToString("N"))
$reportsRoot = Join-Path $tempRoot "reports"
$machineRoot = Join-Path $reportsRoot "machines\TEST-PC"
$rawOnlyEventRoot = Join-Path $reportsRoot "events\2026\05\26\TEST-PC"
$eventRoot = Join-Path $reportsRoot "events\2026\05\27\TEST-PC"
$promotionEventRoot = Join-Path $reportsRoot "events\2026\05\28\TEST-PC"
New-Item -ItemType Directory -Path $machineRoot -Force | Out-Null
New-Item -ItemType Directory -Path $rawOnlyEventRoot -Force | Out-Null
New-Item -ItemType Directory -Path $eventRoot -Force | Out-Null
New-Item -ItemType Directory -Path $promotionEventRoot -Force | Out-Null
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

    $promotionEvents = @(
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-promo-native-1"
            eventType = "mcp.tool"
            timestampUtc = "2026-05-28T08:01:00.000Z"
            sessionId = "session-promotion"
            sequence = 1
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.28.200-test"; buildHash = "test" }
            toolName = "send_code_to_revit_safe"
            taskName = "Repeated raw code pattern for sheet note lookup"
            durationMs = 110
            result = [ordered]@{ success = $true; guarded = $false; state = "completed"; responseKeys = @("success") }
            params = [ordered]@{
                code = [ordered]@{
                    hash = "native-repeat"
                    length = 80
                    lineCount = 4
                    hasManualTransaction = $false
                    writePatterns = @()
                    preview = "FilteredElementCollector(document).OfClass(typeof(TextNote));"
                }
            }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-promo-native-2"
            eventType = "mcp.tool"
            timestampUtc = "2026-05-28T08:02:00.000Z"
            sessionId = "session-promotion"
            sequence = 2
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.28.200-test"; buildHash = "test" }
            toolName = "send_code_to_revit"
            taskName = "Repeated raw code pattern for sheet note lookup"
            durationMs = 120
            result = [ordered]@{ success = $true; guarded = $false; state = "completed"; responseKeys = @("success") }
            params = [ordered]@{
                code = [ordered]@{
                    hash = "native-repeat"
                    length = 82
                    lineCount = 4
                    hasManualTransaction = $false
                    writePatterns = @()
                    preview = "FilteredElementCollector(document).OfClass(typeof(TextNote));"
                }
            }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-promo-manual-1"
            eventType = "mcp.tool"
            timestampUtc = "2026-05-28T08:03:00.000Z"
            sessionId = "session-promotion"
            sequence = 3
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.28.200-test"; buildHash = "test" }
            toolName = "send_code_to_revit_safe"
            taskName = "Manual transaction write guard attempt"
            durationMs = 0
            result = [ordered]@{ success = $false; guarded = $true; state = "guarded"; responseKeys = @("guarded", "state") }
            params = [ordered]@{
                code = [ordered]@{
                    hash = "manual-repeat"
                    length = 140
                    lineCount = 6
                    hasManualTransaction = $true
                    writePatterns = @("Manual Transaction", "Schedule.SetCellText")
                    preview = "using (var t = new Transaction(document, ""manual"")) { t.Start(); section.SetCellText(1, 1, ""X""); }"
                }
            }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-promo-manual-2"
            eventType = "mcp.tool"
            timestampUtc = "2026-05-28T08:04:00.000Z"
            sessionId = "session-promotion"
            sequence = 4
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.28.200-test"; buildHash = "test" }
            toolName = "send_code_to_revit"
            taskName = "Manual transaction write guard attempt"
            durationMs = 0
            result = [ordered]@{ success = $false; guarded = $true; state = "guarded"; responseKeys = @("guarded", "state") }
            params = [ordered]@{
                code = [ordered]@{
                    hash = "manual-repeat"
                    length = 142
                    lineCount = 6
                    hasManualTransaction = $true
                    writePatterns = @("Manual Transaction", "Schedule.SetCellText")
                    preview = "using (var t = new Transaction(document, ""manual"")) { t.Start(); section.SetCellText(1, 1, ""X""); }"
                }
            }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-promo-hotfix-1"
            eventType = "production.context"
            timestampUtc = "2026-05-28T08:05:00.000Z"
            sessionId = "session-promotion"
            sequence = 5
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.28.200-test"; buildHash = "test" }
            contextSchemaVersion = "revagent.production.context.v1"
            related = [ordered]@{ sourceEventType = "mcp.tool"; toolName = "inspect_schedules" }
            runId = "run-hotfix-1"
            operation = [ordered]@{ taskName = "Broad schedule scan hit elapsed budget"; durationMs = 5000; success = $true; guarded = $false }
            project = [ordered]@{ documentTitle = "Office Tower" }
            view = [ordered]@{ active = [ordered]@{ id = 40; name = "M601 Schedules"; type = "Schedule" } }
            location = [ordered]@{}
            elements = [ordered]@{ categories = @("Schedules"); disciplineHint = "schedule_documentation"; samples = @() }
            outputs = [ordered]@{ files = @() }
            search = [ordered]@{ partial = $true; scanStoppedReason = "max_elapsed"; scannedElementCount = 5000; searchBudget = "bounded" }
            response = [ordered]@{ responseKeys = @("partial", "scanStoppedReason") }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-promo-hotfix-2"
            eventType = "production.context"
            timestampUtc = "2026-05-28T08:06:00.000Z"
            sessionId = "session-promotion"
            sequence = 6
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.28.200-test"; buildHash = "test" }
            contextSchemaVersion = "revagent.production.context.v1"
            related = [ordered]@{ sourceEventType = "mcp.tool"; toolName = "inspect_schedules" }
            runId = "run-hotfix-2"
            operation = [ordered]@{ taskName = "Broad schedule scan hit elapsed budget again"; durationMs = 5100; success = $true; guarded = $false }
            project = [ordered]@{ documentTitle = "Office Tower" }
            view = [ordered]@{ active = [ordered]@{ id = 41; name = "M602 Schedules"; type = "Schedule" } }
            location = [ordered]@{}
            elements = [ordered]@{ categories = @("Schedules"); disciplineHint = "schedule_documentation"; samples = @() }
            outputs = [ordered]@{ files = @() }
            search = [ordered]@{ partial = $true; scanStoppedReason = "max_elapsed"; scannedElementCount = 5200; searchBudget = "bounded" }
            response = [ordered]@{ responseKeys = @("partial", "scanStoppedReason") }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-promo-weak-hotfix"
            eventType = "production.context"
            timestampUtc = "2026-05-28T08:07:00.000Z"
            sessionId = "session-promotion"
            sequence = 7
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.28.200-test"; buildHash = "test" }
            contextSchemaVersion = "revagent.production.context.v1"
            related = [ordered]@{ sourceEventType = "mcp.tool"; toolName = "inspect_sheet_text" }
            runId = "run-weak-hotfix"
            operation = [ordered]@{ taskName = "One sheet text scan hit byte budget"; durationMs = 400; success = $true; guarded = $false }
            project = [ordered]@{ documentTitle = "Office Tower" }
            view = [ordered]@{ active = [ordered]@{ id = 50; name = "A101"; type = "DrawingSheet" } }
            location = [ordered]@{}
            elements = [ordered]@{ categories = @("TextNotes"); disciplineHint = "schedule_documentation"; samples = @() }
            outputs = [ordered]@{ files = @() }
            search = [ordered]@{ partial = $true; scanStoppedReason = "max_bytes"; scannedElementCount = 900; searchBudget = "bounded" }
            response = [ordered]@{ responseKeys = @("partial", "scanStoppedReason") }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-promo-annotation-1"
            eventType = "production.context"
            timestampUtc = "2026-05-28T08:08:00.000Z"
            sessionId = "session-promotion"
            sequence = 8
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.28.200-test"; buildHash = "test" }
            contextSchemaVersion = "revagent.production.context.v1"
            related = [ordered]@{ sourceEventType = "mcp.tool"; toolName = "count_annotations" }
            runId = "run-annotation-1"
            operation = [ordered]@{ taskName = "Count sheet annotations by tag"; durationMs = 200; success = $true; guarded = $false }
            project = [ordered]@{ documentTitle = "Office Tower" }
            view = [ordered]@{ active = [ordered]@{ id = 60; name = "A102"; type = "DrawingSheet" } }
            location = [ordered]@{}
            elements = [ordered]@{ categories = @("TextNotes", "Tags"); disciplineHint = "schedule_documentation"; samples = @() }
            outputs = [ordered]@{ files = @() }
            response = [ordered]@{ responseKeys = @("summary", "evidenceRows") }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-promo-annotation-2"
            eventType = "production.context"
            timestampUtc = "2026-05-28T08:09:00.000Z"
            sessionId = "session-promotion"
            sequence = 9
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.28.200-test"; buildHash = "test" }
            contextSchemaVersion = "revagent.production.context.v1"
            related = [ordered]@{ sourceEventType = "mcp.tool"; toolName = "count_annotations" }
            runId = "run-annotation-2"
            operation = [ordered]@{ taskName = "Count sheet annotations by tag again"; durationMs = 210; success = $true; guarded = $false }
            project = [ordered]@{ documentTitle = "Office Tower" }
            view = [ordered]@{ active = [ordered]@{ id = 61; name = "A103"; type = "DrawingSheet" } }
            location = [ordered]@{}
            elements = [ordered]@{ categories = @("TextNotes", "Tags"); disciplineHint = "schedule_documentation"; samples = @() }
            outputs = [ordered]@{ files = @() }
            response = [ordered]@{ responseKeys = @("summary", "evidenceRows") }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-promo-reconcile-1"
            eventType = "production.context"
            timestampUtc = "2026-05-28T08:10:00.000Z"
            sessionId = "session-promotion"
            sequence = 10
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.28.200-test"; buildHash = "test" }
            contextSchemaVersion = "revagent.production.context.v1"
            related = [ordered]@{ sourceEventType = "mcp.tool"; toolName = "reconcile_schedule_excel" }
            runId = "run-reconcile-1"
            operation = [ordered]@{ taskName = "Reconcile schedule against Excel workbook"; durationMs = 340; success = $true; guarded = $false }
            project = [ordered]@{ documentTitle = "Office Tower" }
            view = [ordered]@{ active = [ordered]@{ id = 70; name = "M701"; type = "Schedule" } }
            location = [ordered]@{}
            elements = [ordered]@{ categories = @("Schedules"); disciplineHint = "schedule_documentation"; samples = @() }
            outputs = [ordered]@{ files = @() }
            response = [ordered]@{ responseKeys = @("reviewRows", "reviewTable") }
        }
        [ordered]@{
            schemaVersion = "revagent.telemetry.v1"
            eventId = "evt-promo-reconcile-2"
            eventType = "production.context"
            timestampUtc = "2026-05-28T08:11:00.000Z"
            sessionId = "session-promotion"
            sequence = 11
            machineName = "TEST-PC"
            userName = "USER1"
            runtime = [ordered]@{ version = "2026.05.28.200-test"; buildHash = "test" }
            contextSchemaVersion = "revagent.production.context.v1"
            related = [ordered]@{ sourceEventType = "mcp.tool"; toolName = "reconcile_schedule_excel" }
            runId = "run-reconcile-2"
            operation = [ordered]@{ taskName = "Reconcile schedule against CSV export"; durationMs = 350; success = $true; guarded = $false }
            project = [ordered]@{ documentTitle = "Office Tower" }
            view = [ordered]@{ active = [ordered]@{ id = 71; name = "M702"; type = "Schedule" } }
            location = [ordered]@{}
            elements = [ordered]@{ categories = @("Schedules"); disciplineHint = "schedule_documentation"; samples = @() }
            outputs = [ordered]@{ files = @() }
            response = [ordered]@{ responseKeys = @("reviewRows", "reviewTable") }
        }
    )

    $promotionEventPath = Join-Path $promotionEventRoot "session-promotion.ndjson"
    $promotionEvents | ForEach-Object { ($_ | ConvertTo-Json -Depth 20 -Compress) } | Set-Content -LiteralPath $promotionEventPath -Encoding UTF8

    $codexSessionRoot = Join-Path $tempRoot "codex\sessions"
    $codexSessionDayRoot = Join-Path (Join-Path (Join-Path $codexSessionRoot "2026") "05") "27"
    New-Item -ItemType Directory -Path $codexSessionDayRoot -Force | Out-Null
    $codexSessionFile = Join-Path $codexSessionDayRoot "codex-session-1.jsonl"
    $codexEvents = @(
        [ordered]@{
            type = "session_meta"
            timestampUtc = "2026-05-27T08:00:30.000Z"
            payload = [ordered]@{
                id = "codex-session-1"
                thread_id = "thread-1"
            }
        }
        [ordered]@{
            type = "turn_context"
            timestampUtc = "2026-05-27T08:00:31.000Z"
            payload = [ordered]@{
                cwd = "C:\Projects\Office Tower"
            }
        }
        [ordered]@{
            type = "response_item"
            timestampUtc = "2026-05-27T08:00:40.000Z"
            payload = [ordered]@{
                item = [ordered]@{
                    type = "message"
                    role = "user"
                    content = @([ordered]@{ type = "input_text"; text = "Find ducts on Level 02 Room 204 and export evidence" })
                }
            }
        }
        [ordered]@{
            type = "response_item"
            timestampUtc = "2026-05-27T08:01:00.000Z"
            payload = [ordered]@{
                item = [ordered]@{ type = "function_call"; name = "find_elements" }
            }
        }
        [ordered]@{
            type = "response_item"
            timestampUtc = "2026-05-27T08:03:05.000Z"
            payload = [ordered]@{
                item = [ordered]@{ type = "function_call"; name = "export_revit_view_image" }
            }
        }
        [ordered]@{
            type = "response_item"
            timestampUtc = "2026-05-27T08:03:20.000Z"
            payload = [ordered]@{
                item = [ordered]@{
                    type = "message"
                    role = "assistant"
                    content = @([ordered]@{ type = "output_text"; text = "Found the duct context and exported a QA image." })
                }
            }
        }
    )
    $codexEvents | ForEach-Object { ($_ | ConvertTo-Json -Depth 20 -Compress) } | Set-Content -LiteralPath $codexSessionFile -Encoding UTF8

    $exportOutput = & (Join-Path $usageScriptsRoot "export-codex-session-context.ps1") `
        -SessionRoot $codexSessionRoot `
        -ReportsRoot $reportsRoot `
        -DateUtc "2026-05-27" `
        -MachineName "TEST-PC" `
        -UserName "USER1" `
        -MaxTextChars 80 | ConvertFrom-Json
    Assert-Equal $exportOutput.schemaVersion "revagent.codex.session.export.v1" "Codex session export schema mismatch."
    Assert-Equal $exportOutput.contextCount 1 "Codex session exporter should write one context."

    $codexContextPath = Join-Path $reportsRoot "codex-sessions\2026\05\27\TEST-PC\codex-session-1.context.json"
    Assert-True (Test-Path -LiteralPath $codexContextPath -PathType Leaf) "Codex session context was not written to the NAS-style path."
    $codexContext = Get-Content -Raw -Encoding UTF8 -LiteralPath $codexContextPath | ConvertFrom-Json
    Assert-Equal $codexContext.schemaVersion "revagent.codex.session.context.v1" "Codex context schema mismatch."
    Assert-Equal ([bool]$codexContext.source.rawTranscriptIncluded) $false "Codex context must not claim to include a raw transcript."
    Assert-True (@($codexContext.userRequests).Count -eq 1) "Codex context should include one bounded user request."
    Assert-True ($codexContext.userRequests[0].text -match 'Find ducts') "Codex context user request missing."
    Assert-True (@($codexContext.toolUsage | Where-Object { $_.name -eq "find_elements" -and $_.count -eq 1 }).Count -eq 1) "Codex context tool usage missing find_elements."

    $manualCorrelationPath = Join-Path $tempRoot "manual-session-correlations.json"
    $manualInsightsPath = Join-Path $tempRoot "manual-product-insights.md"
    $manualCorrelationOutput = & (Join-Path $usageScriptsRoot "correlate-usage-sessions.ps1") `
        -ReportsRoot $reportsRoot `
        -DateUtc "2026-05-27" `
        -OutputPath $manualCorrelationPath `
        -MarkdownOutputPath $manualInsightsPath `
        -TimeWindowMinutes 10 `
        -Top 10 | ConvertFrom-Json
    Assert-Equal $manualCorrelationOutput.schemaVersion "revagent.usage.sessionCorrelation.v1" "Session correlation schema mismatch."
    Assert-Equal $manualCorrelationOutput.summary.correlationCount 1 "Session correlation count mismatch."
    Assert-Equal $manualCorrelationOutput.summary.correlationsWithRevAgentEvents 1 "Session correlation should match revAgent events."
    $manualCorrelation = @($manualCorrelationOutput.correlations)[0]
    Assert-Equal $manualCorrelation.codexSessionId "codex-session-1" "Correlated Codex session id mismatch."
    Assert-True ($manualCorrelation.revAgent.operationCount -ge 3) "Correlation should include revAgent operations in the same time window."
    Assert-True ($manualCorrelation.outcome.guardedCount -ge 1) "Correlation should surface guarded revAgent operations."
    Assert-True (@($manualCorrelation.productSignals | Where-Object { $_.signal -eq "guarded_workflow_friction" }).Count -eq 1) "Correlation should create a guarded workflow product signal."
    Assert-True (Test-Path -LiteralPath $manualInsightsPath -PathType Leaf) "Product insights Markdown was not written."

    $outputPath = Join-Path $tempRoot "summary.json"
    & (Join-Path $usageScriptsRoot "summarize-usage-intelligence.ps1") `
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
    $publishOutput = & (Join-Path $usageScriptsRoot "publish-usage-summary.ps1") `
        -ReportsRoot $reportsRoot `
        -DateUtc "2026-05-27" `
        -OutputRoot $summaryRoot `
        -Top 10

    $publishReport = $publishOutput | ConvertFrom-Json
    $dailyJson = Join-Path $summaryRoot "daily\2026-05-27.json"
    $dailyMarkdown = Join-Path $summaryRoot "daily\2026-05-27.md"
    $dailyCorrelationJson = Join-Path $summaryRoot "daily\2026-05-27.session-correlations.json"
    $dailyProductInsights = Join-Path $summaryRoot "daily\2026-05-27.product-insights.md"
    $latestJson = Join-Path $summaryRoot "latest.json"
    $latestMarkdown = Join-Path $summaryRoot "latest.md"
    $publishLatest = Join-Path $summaryRoot "publish-latest.json"

    Assert-True (Test-Path -LiteralPath $dailyJson -PathType Leaf) "Daily JSON summary was not written."
    Assert-True (Test-Path -LiteralPath $dailyMarkdown -PathType Leaf) "Daily Markdown summary was not written."
    Assert-True (Test-Path -LiteralPath $dailyCorrelationJson -PathType Leaf) "Daily session correlation JSON was not written."
    Assert-True (Test-Path -LiteralPath $dailyProductInsights -PathType Leaf) "Daily product insights Markdown was not written."
    Assert-True (Test-Path -LiteralPath $latestJson -PathType Leaf) "Latest JSON summary was not written."
    Assert-True (Test-Path -LiteralPath $latestMarkdown -PathType Leaf) "Latest Markdown summary was not written."
    Assert-True (Test-Path -LiteralPath $publishLatest -PathType Leaf) "Publish report was not written."
    Assert-Equal $publishReport.schemaVersion "revagent.usage.publish.v1" "Publish schema version mismatch."
    Assert-Equal $publishReport.latestDateUtc "2026-05-27" "Publish latest date mismatch."
    Assert-True (Test-Path -LiteralPath $publishReport.logPath -PathType Leaf) "Publish log was not written."
    Assert-True (-not (Test-Path -LiteralPath $publishReport.lockPath -PathType Leaf)) "Publish lock was not released."
    $publishedDay = @($publishReport.published)[0]
    Assert-Equal $publishedDay.sessionCorrelationCount 1 "Publish report must include session correlation count."
    Assert-True ($publishedDay.productSignalCount -ge 1) "Publish report must include product signal count."

    $latestSummary = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestJson | ConvertFrom-Json
    Assert-Equal $latestSummary.schemaVersion "revagent.usage.summary.v1" "Latest summary schema mismatch."
    Assert-Equal $latestSummary.source.eventCount 5 "Latest summary event count mismatch."
    $markdownText = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestMarkdown
    Assert-True ($markdownText -match 'revAgent Usage Summary') "Markdown summary title missing."
    Assert-True ($markdownText -match 'Guarded write preview Level 02 Room 204') "Markdown guarded operation sample missing."

    $multiDateRoot = Join-Path $reportsRoot "summaries-multi"
    $multiDateOutput = & (Join-Path $usageScriptsRoot "publish-usage-summary.ps1") `
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

    $promotionOutputPath = Join-Path $tempRoot "promotion-summary.json"
    & (Join-Path $usageScriptsRoot "summarize-usage-intelligence.ps1") `
        -ReportsRoot $reportsRoot `
        -DateUtc "2026-05-28" `
        -OutputPath $promotionOutputPath `
        -Top 10

    $promotionSummary = Get-Content -Raw -Encoding UTF8 -LiteralPath $promotionOutputPath | ConvertFrom-Json
    Assert-Equal $promotionSummary.source.eventCount 11 "Promotion fixture event count mismatch."
    Assert-Equal $promotionSummary.evidenceStrength "medium" "Promotion summary should surface medium aggregate evidence."
    Assert-Equal ([bool]$promotionSummary.humanReviewRequired) $true "Promotion summary must require human review."

    $nativeRepeatCandidate = @($promotionSummary.nativeToolCandidates | Where-Object { $_.hash -eq "native-repeat" }) | Select-Object -First 1
    Assert-CandidateEvidenceContext -Candidate $nativeRepeatCandidate -Message "Native tool candidate"
    Assert-Equal $nativeRepeatCandidate.signal "repeated_raw_safe_code_pattern" "Native candidate signal mismatch."
    Assert-Equal $nativeRepeatCandidate.count 2 "Native candidate repeat count mismatch."
    Assert-Equal $nativeRepeatCandidate.evidenceStrength "medium" "Native candidate evidence strength mismatch."

    $manualPromotionCandidate = @($promotionSummary.promotionCandidates | Where-Object { $_.hash -eq "manual-repeat" }) | Select-Object -First 1
    Assert-CandidateEvidenceContext -Candidate $manualPromotionCandidate -Message "Manual transaction promotion candidate"
    Assert-Equal $manualPromotionCandidate.signal "manual_transaction_write_guard" "Manual transaction candidate signal mismatch."
    Assert-True (@($manualPromotionCandidate.promotionReasons | Where-Object { $_ -eq "manual_transaction" }).Count -eq 1) "Manual transaction reason missing."

    $hotfixCandidate = @($promotionSummary.hotfixCandidates | Where-Object { $_.scanStoppedReason -eq "max_elapsed" }) | Select-Object -First 1
    Assert-CandidateEvidenceContext -Candidate $hotfixCandidate -Message "Hotfix candidate"
    Assert-Equal $hotfixCandidate.signal "repeated_timeout_partial_result_friction" "Hotfix candidate signal mismatch."
    Assert-Equal $hotfixCandidate.count 2 "Hotfix candidate repeat count mismatch."

    $weakHotfixCandidate = @($promotionSummary.hotfixCandidates | Where-Object { $_.scanStoppedReason -eq "max_bytes" }) | Select-Object -First 1
    Assert-CandidateEvidenceContext -Candidate $weakHotfixCandidate -Message "Weak hotfix candidate"
    Assert-Equal $weakHotfixCandidate.evidenceStrength "weak" "Thin evidence must be weak-marked."
    Assert-Equal ([bool]$weakHotfixCandidate.humanReviewRequired) $true "Weak evidence must still require human review."

    $annotationCandidate = @($promotionSummary.annotationInventoryCandidates | Where-Object { $_.toolName -eq "count_annotations" }) | Select-Object -First 1
    Assert-CandidateEvidenceContext -Candidate $annotationCandidate -Message "Annotation inventory candidate"
    Assert-Equal $annotationCandidate.signal "repeated_annotation_counting_request" "Annotation candidate signal mismatch."
    Assert-Equal $annotationCandidate.count 2 "Annotation candidate repeat count mismatch."

    $reconciliationCandidate = @($promotionSummary.reconciliationCandidates | Where-Object { $_.toolName -eq "reconcile_schedule_excel" }) | Select-Object -First 1
    Assert-CandidateEvidenceContext -Candidate $reconciliationCandidate -Message "Reconciliation candidate"
    Assert-Equal $reconciliationCandidate.signal "repeated_schedule_spreadsheet_reconciliation_request" "Reconciliation candidate signal mismatch."
    Assert-Equal $reconciliationCandidate.count 2 "Reconciliation candidate repeat count mismatch."

    $promotionPublishOutput = & (Join-Path $usageScriptsRoot "publish-usage-summary.ps1") `
        -ReportsRoot $reportsRoot `
        -DateUtc "2026-05-28" `
        -OutputRoot $summaryRoot `
        -Top 10
    $promotionPublishReport = $promotionPublishOutput | ConvertFrom-Json
    Assert-Equal $promotionPublishReport.latestDateUtc "2026-05-28" "Promotion publish latest date mismatch."

    $publishedPromotionSummary = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $summaryRoot "latest.json") | ConvertFrom-Json
    Assert-Equal $publishedPromotionSummary.dateUtc "2026-05-28" "Published promotion latest date mismatch."
    $publishedNativeCandidate = @($publishedPromotionSummary.nativeToolCandidates | Where-Object { $_.hash -eq "native-repeat" }) | Select-Object -First 1
    Assert-CandidateEvidenceContext -Candidate $publishedNativeCandidate -Message "Published native tool candidate"
    Assert-Equal ([bool]$publishedPromotionSummary.humanReviewRequired) $true "Published promotion summary must require human review."

    Push-Location $RepoRoot
    try {
        $dashboardBriefJson = node --input-type=module -e "import { buildDashboardBrief, loadDashboardData } from './addons/dashboard/server/server.mjs'; const data = loadDashboardData({ reportsRoot: process.argv[1], releaseRoot: process.argv[2], staleSeconds: 60, offlineSeconds: 300, activityLimit: 20 }); console.log(JSON.stringify(buildDashboardBrief(data)));" $reportsRoot $tempRoot
    }
    finally {
        Pop-Location
    }
    $dashboardBrief = $dashboardBriefJson | ConvertFrom-Json
    Assert-Equal $dashboardBrief.schemaVersion "revagent.dashboard.brief.v1" "Promotion dashboard brief schema mismatch."
    Assert-Equal $dashboardBrief.summaryDateUtc "2026-05-28" "Dashboard brief must consume the published promotion summary."
    $dashboardNativeCandidate = @($dashboardBrief.nativeToolCandidates | Where-Object { $_.hash -eq "native-repeat" }) | Select-Object -First 1
    Assert-CandidateEvidenceContext -Candidate $dashboardNativeCandidate -Message "Dashboard native tool candidate"
    Assert-True (@($dashboardNativeCandidate.toolNames).Count -ge 1) "Dashboard native tool candidate must preserve toolNames."
    Assert-Equal $dashboardNativeCandidate.maxLength 82 "Dashboard native tool candidate must preserve maxLength."
    $dashboardManualCandidate = @($dashboardBrief.promotionCandidates | Where-Object { $_.hash -eq "manual-repeat" }) | Select-Object -First 1
    Assert-CandidateEvidenceContext -Candidate $dashboardManualCandidate -Message "Dashboard manual promotion candidate"
    Assert-True (@($dashboardManualCandidate.writePatterns | Where-Object { $_.name -eq "Schedule.SetCellText" }).Count -eq 1) "Dashboard manual candidate must preserve writePatterns."
    Assert-Equal $dashboardManualCandidate.maxLineCount 6 "Dashboard manual candidate must preserve maxLineCount."
    Assert-Equal $dashboardBrief.evidenceStrength "medium" "Dashboard brief evidence strength mismatch."
    Assert-Equal ([bool]$dashboardBrief.humanReviewRequired) $true "Dashboard brief must preserve human review."

    $publishScriptText = Get-Content -Raw -LiteralPath (Join-Path $usageScriptsRoot "publish-usage-summary.ps1")
    Assert-True ($publishScriptText -match 'publish\.lock') "Publish script must use a lock file."
    Assert-True ($publishScriptText -match 'usage-summary-\{0\}\.log') "Publish script must write per-run logs."
    Assert-True ($publishScriptText -match 'StaleLockMinutes') "Publish script must have stale lock handling."

    $taskScriptText = Get-Content -Raw -LiteralPath (Join-Path $usageScriptsRoot "install-usage-summary-task.ps1")
    Assert-True ($taskScriptText -match 'revAgent Usage Summary Publish') "Usage summary task must use the revAgent task name."
    Assert-True ($taskScriptText -match '\[string\]\$DailyAt = "20:30"') "Usage summary task must default to an after-hours schedule."
    Assert-True ($taskScriptText -match 'New-RevAgentDailyUpdateTrigger -DailyAt \$DailyAt') "Usage summary task must use the shared daily trigger helper."
    Assert-True ($taskScriptText -match 'Write-RevAgentHiddenPowerShellLauncher') "Usage summary task must run hidden through the shared launcher."
    Assert-True ($taskScriptText -match 'Invoke-SchtasksCreateDailyTask') "Usage summary task installer must fall back to schtasks.exe for non-elevated coordinator installs."
    Assert-True ($taskScriptText -match 'Register-HkcuRunStartup') "Usage summary task installer must have a no-admin HKCU startup fallback."
    Assert-True ($taskScriptText -match 'Test-Path -LiteralPath \$runKey') "Usage summary task installer must preserve existing HKCU Run values when adding startup fallback."
    Assert-True ($taskScriptText -match 'Task method') "Usage summary task installer must report the scheduled task registration method."
    Assert-True ($taskScriptText -match '\$publishParameters = @\{' -and $taskScriptText -match '& \$PublishScriptPath @publishParameters') "Usage summary task RunNow must use named splatting."
    Assert-True ($taskScriptText -match 'DPE\\revAgent\\addons\\usage-intelligence\\state') "Usage summary task must default work state under the installed add-on root."
    Assert-True ($taskScriptText -match 'app = "revAgent"') "Usage summary task config must use revAgent product identity."
    Assert-True ($taskScriptText -match '\$legacyCompatibilityLibRootCandidates') "Usage summary task installer must isolate legacy RevitMCP library fallbacks."
    Assert-True ($taskScriptText -match '\$legacyCompatibilityPublishScriptCandidates') "Usage summary task installer must isolate legacy RevitMCP publish-script fallbacks."

    $usageAddonInstallRoot = Join-Path $tempRoot "installed\addons\usage-intelligence"
    $usageAddonInstallResult = & (Join-Path $RepoRoot "addons\usage-intelligence\installer\install-usage-intelligence-addon.ps1") `
        -SourceRoot (Join-Path $RepoRoot "addons\usage-intelligence") `
        -InstallRoot $usageAddonInstallRoot `
        -ReportsRoot $reportsRoot `
        -SkipScheduledTasks | ConvertFrom-Json
    Assert-Equal $usageAddonInstallResult.schemaVersion "revagent.usage-intelligence.addon.install.v1" "Usage-intelligence add-on installer result schema mismatch."
    Assert-Equal ([bool]$usageAddonInstallResult.installed) $true "Usage-intelligence add-on installer should report installed=true."
    Assert-Equal ([bool]$usageAddonInstallResult.scheduledTaskInstalled) $false "Usage-intelligence add-on installer should honor SkipScheduledTasks."
    Assert-True (Test-Path -LiteralPath (Join-Path $usageAddonInstallRoot "scripts\publish-usage-summary.ps1") -PathType Leaf) "Installed usage publisher missing."
    Assert-True (Test-Path -LiteralPath (Join-Path $usageAddonInstallRoot "scripts\summarize-usage-intelligence.ps1") -PathType Leaf) "Installed usage summarizer missing."
    Assert-True (Test-Path -LiteralPath (Join-Path $usageAddonInstallRoot "scripts\install-usage-summary-task.ps1") -PathType Leaf) "Installed usage task installer missing."
    Assert-True (Test-Path -LiteralPath (Join-Path $usageAddonInstallRoot "scripts\export-codex-session-context.ps1") -PathType Leaf) "Installed Codex session exporter missing."
    Assert-True (Test-Path -LiteralPath (Join-Path $usageAddonInstallRoot "scripts\correlate-usage-sessions.ps1") -PathType Leaf) "Installed session correlator missing."
    Assert-True (Test-Path -LiteralPath (Join-Path $usageAddonInstallRoot "installer\install-usage-intelligence-addon.ps1") -PathType Leaf) "Installed usage add-on installer missing."
    Assert-True (Test-Path -LiteralPath (Join-Path $usageAddonInstallRoot "addon.json") -PathType Leaf) "Installed usage manifest missing."
    $usageAddonConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $usageAddonInstallRoot "config\usage-intelligence.json") | ConvertFrom-Json
    Assert-Equal $usageAddonConfig.schemaVersion "revagent.usage-intelligence.addon.config.v1" "Usage-intelligence add-on config schema mismatch."
    Assert-Equal $usageAddonConfig.reportsRoot $reportsRoot "Usage-intelligence add-on config must preserve reports root."
    Assert-Equal $usageAddonConfig.workRoot (Join-Path $usageAddonInstallRoot "state") "Usage-intelligence add-on config must default workRoot under the add-on state root."
    Assert-Equal $usageAddonConfig.correlationWindowMinutes 45 "Usage-intelligence add-on config must persist the default correlation window."

    $canonicalReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports"
    $usageAddonDefaultInstallRoot = Join-Path $tempRoot "installed-default\addons\usage-intelligence"
    $usageAddonDefaultResult = & (Join-Path $RepoRoot "addons\usage-intelligence\installer\install-usage-intelligence-addon.ps1") `
        -SourceRoot (Join-Path $RepoRoot "addons\usage-intelligence") `
        -InstallRoot $usageAddonDefaultInstallRoot `
        -SkipScheduledTasks | ConvertFrom-Json
    Assert-Equal $usageAddonDefaultResult.schemaVersion "revagent.usage-intelligence.addon.install.v1" "Usage-intelligence default install result schema mismatch."
    $usageAddonDefaultConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $usageAddonDefaultInstallRoot "config\usage-intelligence.json") | ConvertFrom-Json
    Assert-Equal $usageAddonDefaultConfig.reportsRoot $canonicalReportsRoot "Usage-intelligence default config must use the canonical revAgent reports root."

    $providerQualifiedUsageRoot = Join-Path $tempRoot "installed-provider\addons\usage-intelligence"
    $providerQualifiedUsageSourceRoot = "Microsoft.PowerShell.Core\FileSystem::$(Join-Path $RepoRoot "addons\usage-intelligence")"
    $providerQualifiedUsageResult = & (Join-Path $RepoRoot "addons\usage-intelligence\installer\install-usage-intelligence-addon.ps1") `
        -SourceRoot $providerQualifiedUsageSourceRoot `
        -InstallRoot $providerQualifiedUsageRoot `
        -SkipScheduledTasks | ConvertFrom-Json
    Assert-Equal ([bool]$providerQualifiedUsageResult.installed) $true "Usage-intelligence add-on installer must accept provider-qualified FileSystem source roots from NAS/tool launch contexts."
    Assert-True (Test-Path -LiteralPath (Join-Path $providerQualifiedUsageRoot "scripts\publish-usage-summary.ps1") -PathType Leaf) "Provider-qualified usage install should copy the publisher payload."

    $usageAddonManifest = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "addons\usage-intelligence\addon.json") | ConvertFrom-Json
    Assert-Equal $usageAddonManifest.entrypoints.installScript "installer\install-usage-intelligence-addon.ps1" "Usage-intelligence manifest must expose installer entrypoint."
    Assert-Equal $usageAddonManifest.entrypoints.exportCodexSessionContext "scripts\export-codex-session-context.ps1" "Usage-intelligence manifest must expose Codex session exporter entrypoint."
    Assert-Equal $usageAddonManifest.entrypoints.correlateSessions "scripts\correlate-usage-sessions.ps1" "Usage-intelligence manifest must expose session correlator entrypoint."
    $usageStartupEntries = @($usageAddonManifest.ownedStartupEntries)
    Assert-True (@($usageStartupEntries | Where-Object {
                $methods = @($_.supportedMethods)
                $_.name -eq "revAgent Usage Summary Publish" -and
                ($methods -contains "Register-ScheduledTask") -and
                ($methods -contains "schtasks.exe") -and
                ($methods -contains "HKCU Run")
            }).Count -eq 1) "Usage-intelligence manifest must declare scheduled publish startup ownership including HKCU Run fallback."
    $usageAddonWrapper = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-usage-intelligence-addon.ps1")
    Assert-True ($usageAddonWrapper -match 'addons\\usage-intelligence\\installer\\install-usage-intelligence-addon\.ps1') "Usage-intelligence root installer wrapper must delegate to the add-on installer."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Usage intelligence summary smoke tests passed."
