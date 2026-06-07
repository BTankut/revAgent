<#
.SYNOPSIS
    Run optional live Revit commandset integration checks.

.DESCRIPTION
    This script connects directly to the Revit MCP socket and validates the
    shared bridge command payload in a real Revit session. It is intentionally not
    part of scripts/test-all.ps1 because it requires Revit 2022 with revAgent
    loaded and an active document.

    The checks are read/probe oriented: transactionMode auto/none, guarded
    manual-transaction blocking, manual transaction rollback in none mode, and
    dynamic Newtonsoft.Json compilation.
#>

[CmdletBinding()]
param(
    [string]$HostName = "",
    [int]$Port = 0,
    [int]$TimeoutMs = 120000
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($HostName)) {
    if ([string]::IsNullOrWhiteSpace($env:REVIT_MCP_HOST)) {
        $HostName = "localhost"
    }
    else {
        $HostName = $env:REVIT_MCP_HOST
    }
}

if ($Port -le 0) {
    if ([int]::TryParse($env:REVIT_MCP_PORT, [ref]$Port) -and $Port -gt 0) {
        # Use parsed environment port.
    }
    else {
        $Port = 8080
    }
}

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

function Read-ExactBytes {
    param(
        [System.IO.Stream]$Stream,
        [int]$Count
    )

    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $read = $Stream.Read($buffer, $offset, $Count - $offset)
        if ($read -le 0) {
            throw "Socket closed while reading response."
        }
        $offset += $read
    }
    return $buffer
}

function ConvertFrom-RevitJsonLike {
    param(
        [object]$Value,
        [int]$Depth = 0
    )

    if ($Depth -ge 4 -or -not ($Value -is [string])) {
        return $Value
    }

    $text = $Value.Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $Value
    }

    if ($text -eq "true") {
        return $true
    }
    if ($text -eq "false") {
        return $false
    }
    if ($text -eq "null") {
        return $null
    }

    $looksJsonLike =
        $text.StartsWith("{") -or
        $text.StartsWith("[") -or
        $text.StartsWith('"')

    if (-not $looksJsonLike) {
        return $Value
    }

    try {
        $parsed = $text | ConvertFrom-Json
        if ($parsed -is [string]) {
            return ConvertFrom-RevitJsonLike -Value $parsed -Depth ($Depth + 1)
        }
        return $parsed
    }
    catch {
        return $Value
    }
}

function Invoke-RevitMcpRequest {
    param(
        [string]$Method,
        [object]$Params = @{}
    )

    $client = New-Object System.Net.Sockets.TcpClient
    $client.ReceiveTimeout = $TimeoutMs
    $client.SendTimeout = $TimeoutMs

    try {
        $client.Connect($HostName, $Port)
        $stream = $client.GetStream()

        $requestId = [Guid]::NewGuid().ToString("N")
        $request = [ordered]@{
            jsonrpc = "2.0"
            method = $Method
            params = $Params
            id = $requestId
        }
        $json = $request | ConvertTo-Json -Depth 30 -Compress
        $payload = [System.Text.Encoding]::UTF8.GetBytes($json)
        $header = [System.BitConverter]::GetBytes([uint32]$payload.Length)
        if ([System.BitConverter]::IsLittleEndian) {
            [array]::Reverse($header)
        }

        $stream.Write($header, 0, $header.Length)
        $stream.Write($payload, 0, $payload.Length)
        $stream.Flush()

        $responseHeader = Read-ExactBytes -Stream $stream -Count 4
        if ([System.BitConverter]::IsLittleEndian) {
            [array]::Reverse($responseHeader)
        }
        $responseLength = [System.BitConverter]::ToUInt32($responseHeader, 0)
        Assert-True ($responseLength -gt 0 -and $responseLength -le (32 * 1024 * 1024)) "Invalid response frame length: $responseLength"

        $responseBytes = Read-ExactBytes -Stream $stream -Count ([int]$responseLength)
        $responseJson = [System.Text.Encoding]::UTF8.GetString($responseBytes)
        $response = $responseJson | ConvertFrom-Json

        if ($response.error) {
            throw "Revit MCP request '$Method' failed: $($response.error.message)"
        }

        return $response.result
    }
    finally {
        $client.Close()
    }
}

function Get-RevitMcpStatus {
    return Invoke-RevitMcpRequest -Method "mcp_status" -Params @{}
}

function Assert-RevitMcpReady {
    param([string]$NextCommand)

    $status = Get-RevitMcpStatus
    if ($status.activeTask) {
        $taskName = $status.activeTask.taskName
        if ([string]::IsNullOrWhiteSpace($taskName)) {
            $taskName = $status.activeTask.method
        }
        $elapsedMs = $status.activeTask.elapsedMs
        throw "Revit MCP is busy with '$taskName' ($elapsedMs ms). Wait before running '$NextCommand'."
    }
    return $status
}

function Invoke-RevitCode {
    param(
        [string]$Code,
        [ValidateSet("auto", "none")]
        [string]$TransactionMode,
        [string]$TaskName
    )

    Assert-RevitMcpReady -NextCommand "send_code_to_revit" | Out-Null
    $params = [ordered]@{
        code = $Code
        parameters = @()
        transactionMode = $TransactionMode
        taskName = $TaskName
    }
    return Invoke-RevitMcpRequest -Method "send_code_to_revit" -Params $params
}

function Invoke-FindElements {
    param(
        [object]$Params,
        [string]$TaskName
    )

    Assert-RevitMcpReady -NextCommand "find_elements" | Out-Null
    if ($Params -is [System.Collections.IDictionary]) {
        $Params["taskName"] = $TaskName
    }
    return Invoke-RevitMcpRequest -Method "find_elements" -Params $Params
}

function Invoke-InspectSheetText {
    param(
        [object]$Params,
        [string]$TaskName
    )

    Assert-RevitMcpReady -NextCommand "inspect_sheet_text" | Out-Null
    if ($Params -is [System.Collections.IDictionary]) {
        $Params["taskName"] = $TaskName
    }
    return Invoke-RevitMcpRequest -Method "inspect_sheet_text" -Params $Params
}

function Invoke-InspectSchedules {
    param(
        [object]$Params,
        [string]$TaskName
    )

    Assert-RevitMcpReady -NextCommand "inspect_schedules" | Out-Null
    if ($Params -is [System.Collections.IDictionary]) {
        $Params["taskName"] = $TaskName
    }
    return Invoke-RevitMcpRequest -Method "inspect_schedules" -Params $Params
}

function Invoke-CountAnnotations {
    param(
        [object]$Params,
        [string]$TaskName
    )

    Assert-RevitMcpReady -NextCommand "count_annotations" | Out-Null
    if ($Params -is [System.Collections.IDictionary]) {
        $Params["taskName"] = $TaskName
    }
    return Invoke-RevitMcpRequest -Method "count_annotations" -Params $Params
}

function Invoke-FocusElements {
    param(
        [object]$Params,
        [string]$TaskName
    )

    Assert-RevitMcpReady -NextCommand "focus_elements" | Out-Null
    if ($Params -is [System.Collections.IDictionary]) {
        $Params["taskName"] = $TaskName
    }
    return Invoke-RevitMcpRequest -Method "focus_elements" -Params $Params
}

function Invoke-ClearSelection {
    param(
        [object]$Params,
        [string]$TaskName
    )

    Assert-RevitMcpReady -NextCommand "clear_selection" | Out-Null
    if ($Params -is [System.Collections.IDictionary]) {
        $Params["taskName"] = $TaskName
    }
    return Invoke-RevitMcpRequest -Method "clear_selection" -Params $Params
}

function Invoke-DeleteReviewView {
    param(
        [object]$Params,
        [string]$TaskName
    )

    Assert-RevitMcpReady -NextCommand "delete_review_view" | Out-Null
    if ($Params -is [System.Collections.IDictionary]) {
        $Params["taskName"] = $TaskName
    }
    return Invoke-RevitMcpRequest -Method "delete_review_view" -Params $Params
}

function Assert-SuccessfulCodeResult {
    param(
        [object]$Result,
        [string]$CaseName
    )

    Assert-True ($null -ne $Result) "$CaseName returned no result."
    Assert-Equal ([bool]$Result.success) $true "$CaseName should succeed."
    Assert-Equal ([bool]$Result.guarded) $false "$CaseName should not be guarded."
}

function Assert-RuntimeFindElementsPolicy {
    $runtimeRegisterPath = "C:\ProgramData\DPE\RevitMCP\runtime\build\tools\register.js"
    Assert-True (Test-Path -LiteralPath $runtimeRegisterPath) "Installed runtime register.js was not found: $runtimeRegisterPath"

    $env:REVAGENT_LIVE_RUNTIME_REGISTER = $runtimeRegisterPath
$nodeScript = @'
const { performance } = await import('node:perf_hooks');
const { pathToFileURL } = await import('node:url');
console.error = () => {};
const registerUrl = pathToFileURL(process.env.REVAGENT_LIVE_RUNTIME_REGISTER).href;
const { registerTools } = await import(registerUrl);
const tools = new Map();
await registerTools({ tool: (name, description, schema, handler) => tools.set(name, { description, schema, handler }) });
const statusBefore = JSON.parse((await tools.get('get_revit_mcp_status').handler({ timeoutMs: 5000 })).content[0].text);
const inferredStart = performance.now();
const inferred = JSON.parse((await tools.get('find_elements').handler({
  query: 'MTL fan coil',
  searchBudget: 'fast',
  planCandidateMode: 'none',
  limit: 5,
  taskName: 'live MTL fan coil inference proof'
})).content[0].text);
const inferredElapsedMs = Math.round(performance.now() - inferredStart);
const statusAfterInferred = JSON.parse((await tools.get('get_revit_mcp_status').handler({ timeoutMs: 5000 })).content[0].text);
const broadStart = performance.now();
const broad = JSON.parse((await tools.get('find_elements').handler({
  query: 'MTL',
  searchBudget: 'fast',
  planCandidateMode: 'none',
  limit: 5,
  taskName: 'live broad MTL guard proof'
})).content[0].text);
const broadElapsedMs = Math.round(performance.now() - broadStart);
const statusAfterBroad = JSON.parse((await tools.get('get_revit_mcp_status').handler({ timeoutMs: 5000 })).content[0].text);
console.log(JSON.stringify({
  statusBefore: { recentHistoryCount: statusBefore.recentHistoryCount, activeTask: statusBefore.activeTask },
  inferred: {
    elapsedMs: inferredElapsedMs,
    success: inferred.success,
    guarded: inferred.guarded,
    query: inferred.query,
    categoryNames: inferred.categoryNames,
    count: inferred.count,
    scannedElementCount: inferred.scannedElementCount,
    partial: inferred.partial,
    planCandidateMode: inferred.planCandidateMode,
    riskPolicy: inferred.riskPolicy
  },
  broad: {
    elapsedMs: broadElapsedMs,
    success: broad.success,
    guarded: broad.guarded,
    state: broad.state,
    reason: broad.reason,
    riskPolicy: broad.riskPolicy
  },
  history: {
    afterInferred: statusAfterInferred.recentHistoryCount,
    afterBroad: statusAfterBroad.recentHistoryCount,
    activeTask: statusAfterBroad.activeTask
  }
}));
'@

    $nodeOutput = & node --input-type=module -e $nodeScript
    if ($LASTEXITCODE -ne 0) {
        throw "Node runtime find_elements policy proof failed with exit code $LASTEXITCODE."
    }

    $proof = ($nodeOutput -join "`n") | ConvertFrom-Json
    Assert-Equal ([bool]$proof.inferred.success) $true "Runtime MTL fan coil inference should succeed."
    Assert-Equal ([bool]$proof.inferred.guarded) $false "Runtime MTL fan coil inference should not be guarded."
    Assert-Equal ([string]$proof.inferred.query) "MTL" "Runtime MTL fan coil inference should strip the MEP concept token."
    Assert-True (@($proof.inferred.categoryNames) -contains "Mechanical Equipment") "Runtime MTL fan coil inference should use Mechanical Equipment scope."
    Assert-Equal ([string]$proof.inferred.planCandidateMode) "none" "Runtime inferred first pass should not request plan candidates."
    Assert-Equal ([string]$proof.inferred.riskPolicy.riskLevel) "low" "Runtime inferred first pass should report low search risk."
    Assert-Equal ([bool]$proof.inferred.riskPolicy.requiresUserControl) $false "Runtime inferred first pass should not require user control."
    Assert-Equal ([bool]$proof.broad.success) $true "Runtime broad MTL guard should return a protected result."
    Assert-Equal ([bool]$proof.broad.guarded) $true "Runtime broad MTL query should be guarded."
    Assert-Equal ([string]$proof.broad.state) "guarded" "Runtime broad MTL guard state changed."
    Assert-Equal ([string]$proof.broad.reason) "needs_scope" "Runtime broad MTL guard reason changed."
    Assert-Equal ([bool]$proof.broad.riskPolicy.requiresUserControl) $true "Runtime broad MTL query should require user control."
    Assert-Equal ([int]$proof.history.afterBroad) ([int]$proof.history.afterInferred) "Runtime broad guard should not add a Revit bridge task."
    Assert-True ($null -eq $proof.history.activeTask) "Runtime find_elements policy proof should leave no active Revit task."
}

Write-Host "Live commandset integration target: $HostName`:$Port"

$initialStatus = Assert-RevitMcpReady -NextCommand "live commandset tests"
Assert-True ($initialStatus.service.isRunning -eq $true) "Revit MCP service did not report running."

$prefix = "revAgent commandset live " + (Get-Date -Format "HHmmss")

Write-Host "Test find_elements guarded no-scope contract"
$noScopeProbe = Invoke-FindElements `
    -TaskName "$prefix find no scope" `
    -Params ([ordered]@{
        searchBudget = "fast"
        maxElementsScanned = 10
        maxElapsedMs = 1000
        timeoutMs = 5000
        limit = 1
    })
Assert-Equal ([bool]$noScopeProbe.success) $true "No-scope find_elements should return a protected result, not a transport failure."
Assert-Equal ([bool]$noScopeProbe.guarded) $true "No-scope find_elements should be guarded."
Assert-Equal ([string]$noScopeProbe.state) "guarded" "No-scope find_elements state changed."
Assert-Equal ([string]$noScopeProbe.reason) "needs_scope" "No-scope find_elements reason changed."
Assert-Equal ([string]$noScopeProbe.scanStoppedReason) "needs_scope" "No-scope find_elements scan stop reason changed."

Write-Host "Test find_elements category-bounded search contract"
$noMatchQuery = "__revagent_live_no_match_" + (Get-Date -Format "HHmmssfff")
$categoryProbe = Invoke-FindElements `
    -TaskName "$prefix find category bounded" `
    -Params ([ordered]@{
        query = $noMatchQuery
        categoryNames = @("Mechanical Equipment")
        planCandidateMode = "none"
        searchBudget = "fast"
        maxElementsScanned = 250
        maxElapsedMs = 2000
        timeoutMs = 6000
        limit = 3
    })
Assert-Equal ([bool]$categoryProbe.success) $true "Category-bounded find_elements should succeed."
Assert-Equal ([bool]$categoryProbe.guarded) $false "Category-bounded find_elements should not be guarded."
Assert-Equal ([string]$categoryProbe.state) "completed" "Category-bounded find_elements state changed."
Assert-Equal ([string]$categoryProbe.planCandidateMode) "none" "Category-bounded first pass should not request plan candidates."
Assert-Equal ([string]$categoryProbe.scanPolicy.searchBudget) "fast" "Category-bounded find_elements should report the search budget."
Assert-True ([int]$categoryProbe.scanPolicy.maxElapsedMs -lt 6000) "Revit-side find_elements budget must stay below socket timeout."
Assert-True ([int]$categoryProbe.scannedElementCount -ge 0) "Category-bounded find_elements should report scanned element count."
Assert-True ([int]$categoryProbe.candidateElementCount -ge 0) "Category-bounded find_elements should report candidate element count."
if ([int]$categoryProbe.count -eq 0) {
    Assert-Equal ([string]$categoryProbe.message) "No matching elements found." "No-match find_elements message changed."
}

Write-Host "Test find_elements bounded partial metadata when scan budget stops"
$budgetProbe = Invoke-FindElements `
    -TaskName "$prefix find scan budget" `
    -Params ([ordered]@{
        categoryNames = @("Ducts", "Pipes", "Mechanical Equipment", "Air Terminals")
        planCandidateMode = "none"
        searchBudget = "fast"
        maxElementsScanned = 1
        maxElapsedMs = 2000
        timeoutMs = 6000
        limit = 1
    })
Assert-Equal ([bool]$budgetProbe.success) $true "Budgeted find_elements should succeed or return a controlled partial result."
Assert-Equal ([string]$budgetProbe.planCandidateMode) "none" "Budgeted first pass should not request plan candidates."
if ([bool]$budgetProbe.partial) {
    Assert-Equal ([string]$budgetProbe.scanStoppedReason) "max_scanned" "Budgeted find_elements partial reason changed."
    Assert-True ([int]$budgetProbe.scannedElementCount -le 1) "Budgeted find_elements should stop at the configured scan cap."
}

Write-Host "Test native inspect_sheet_text guarded viewport no-scope contract"
$sheetViewportNoScope = Invoke-InspectSheetText `
    -TaskName "$prefix sheet viewport no scope guard" `
    -Params ([ordered]@{
        includeTextNotes = $false
        includeScheduleInstances = $false
        includeViewportTextNotes = $true
        searchBudget = "fast"
        maxElapsedMs = 1000
        timeoutMs = 5000
    })
Assert-Equal ([bool]$sheetViewportNoScope.success) $true "No-scope viewport sheet text scan should return a protected result, not a transport failure."
Assert-Equal ([bool]$sheetViewportNoScope.guarded) $true "No-scope viewport sheet text scan should be guarded."
Assert-Equal ([string]$sheetViewportNoScope.state) "guarded" "No-scope viewport sheet text guard state changed."
Assert-Equal ([string]$sheetViewportNoScope.reason) "needs_scope" "No-scope viewport sheet text guard reason changed."
Assert-Equal ([int]$sheetViewportNoScope.scannedSheetCount) 0 "No-scope viewport guard should not scan Revit sheets."

Write-Host "Discover one sheet for scoped native inspect_sheet_text checks"
$sheetInventory = Invoke-InspectSheetText `
    -TaskName "$prefix sheet inventory scoped seed" `
    -Params ([ordered]@{
        includeTextNotes = $false
        includeScheduleInstances = $false
        includeViewportTextNotes = $false
        maxSheets = 1
        searchBudget = "fast"
        maxElapsedMs = 2000
        timeoutMs = 7000
    })
Assert-Equal ([bool]$sheetInventory.success) $true "Sheet inventory seed should succeed."
Assert-True (@($sheetInventory.sheets).Count -ge 1) "Live commandset sheet checks require at least one sheet in the active test model."
$firstSheet = @($sheetInventory.sheets)[0]
$firstSheetId = [int]$firstSheet.id
$firstSheetNumber = [string]$firstSheet.sheetNumber

Write-Host "Discover one schedule for native inspect_schedules checks"
$scheduleInventory = Invoke-InspectSchedules `
    -TaskName "$prefix schedule inventory scoped seed" `
    -Params ([ordered]@{
        maxSchedules = 1
        searchBudget = "fast"
        maxElapsedMs = 2000
        timeoutMs = 7000
    })
Assert-Equal ([bool]$scheduleInventory.success) $true "Schedule inventory seed should succeed."
Assert-True (@($scheduleInventory.schedules).Count -ge 1) "Live commandset schedule checks require at least one schedule in the active test model."
$firstSchedule = @($scheduleInventory.schedules)[0]
$firstScheduleId = [int]$firstSchedule.id

Write-Host "Test native inspect_schedules scoped small read contract"
$scheduleSmallRead = Invoke-InspectSchedules `
    -TaskName "$prefix schedule scoped small read" `
    -Params ([ordered]@{
        scheduleIds = @($firstScheduleId)
        includeCells = $true
        sections = @("body")
        maxRowsPerSection = 2
        maxColumnsPerSection = 2
        maxCells = 10
        maxResponseBytes = 120000
        searchBudget = "fast"
        maxElapsedMs = 5000
        timeoutMs = 10000
    })
Assert-Equal ([bool]$scheduleSmallRead.success) $true "Scoped native schedule read should succeed."
Assert-Equal ([bool]$scheduleSmallRead.guarded) $false "Scoped native schedule read should not be guarded."
Assert-Equal ([string]$scheduleSmallRead.action) "inspect_schedules" "Scoped native schedule action changed."
Assert-True ([int]$scheduleSmallRead.returnedCount -ge 1) "Scoped native schedule read should return the requested schedule."
Assert-True ($scheduleSmallRead.scanPolicy.maxElapsedMs -lt $scheduleSmallRead.scanPolicy.timeoutMs) "Native schedule budget must stay below socket timeout."

Write-Host "Test native inspect_schedules max_cells partial metadata"
$scheduleCellCap = Invoke-InspectSchedules `
    -TaskName "$prefix schedule max cells" `
    -Params ([ordered]@{
        scheduleIds = @($firstScheduleId)
        includeCells = $true
        sections = @("body")
        maxRowsPerSection = 50
        maxColumnsPerSection = 50
        maxCells = 1
        maxResponseBytes = 120000
        searchBudget = "fast"
        maxElapsedMs = 5000
        timeoutMs = 10000
    })
Assert-Equal ([bool]$scheduleCellCap.success) $true "Small cell-budget schedule read should return a controlled result."
if ([bool]$scheduleCellCap.partial) {
    Assert-Equal ([string]$scheduleCellCap.scanStoppedReason) "max_cells" "Small cell-budget schedule scan partial reason changed."
    Assert-True ($null -ne $scheduleCellCap.lastReadSection) "Partial schedule read must report lastReadSection."
    Assert-True ($null -ne $scheduleCellCap.lastReadRow) "Partial schedule read must report lastReadRow."
    Assert-True ($null -ne $scheduleCellCap.lastReadColumn) "Partial schedule read must report lastReadColumn."
}

Write-Host "Test native inspect_schedules max_bytes pressure metadata"
$scheduleByteCap = Invoke-InspectSchedules `
    -TaskName "$prefix schedule max bytes" `
    -Params ([ordered]@{
        scheduleIds = @($firstScheduleId)
        includeCells = $true
        sections = @("body")
        maxRowsPerSection = 50
        maxColumnsPerSection = 50
        maxCells = 500
        maxResponseBytes = 4096
        searchBudget = "fast"
        maxElapsedMs = 5000
        timeoutMs = 10000
    })
Assert-Equal ([bool]$scheduleByteCap.success) $true "Small response-budget schedule read should return a controlled result."
if ([bool]$scheduleByteCap.partial) {
    Assert-Equal ([string]$scheduleByteCap.scanStoppedReason) "max_bytes" "Small response-budget schedule scan partial reason changed."
}

Write-Host "Test native inspect_sheet_text scoped viewport text-note contract"
$viewportScoped = Invoke-InspectSheetText `
    -TaskName "$prefix sheet viewport scoped" `
    -Params ([ordered]@{
        sheetIds = @($firstSheetId)
        includeTextNotes = $false
        includeScheduleInstances = $false
        includeViewportTextNotes = $true
        searchBudget = "fast"
        maxViewportsPerSheet = 5
        maxViewportTextNotesPerView = 25
        maxElapsedMs = 5000
        timeoutMs = 10000
    })
Assert-Equal ([bool]$viewportScoped.success) $true "Scoped viewport sheet text scan should succeed."
Assert-Equal ([bool]$viewportScoped.guarded) $false "Scoped viewport sheet text scan should not be guarded."
Assert-Equal ([string]$viewportScoped.action) "inspect_sheet_text" "Scoped viewport sheet text action changed."
Assert-True ([int]$viewportScoped.scannedSheetCount -le 1) "Scoped viewport sheet text scan should stay on the requested sheet."
Assert-True ($viewportScoped.scanPolicy.maxElapsedMs -lt $viewportScoped.scanPolicy.timeoutMs) "Native sheet text budget must stay below socket timeout."

Write-Host "Test native inspect_sheet_text max_elapsed partial metadata"
$elapsedProbe = Invoke-InspectSheetText `
    -TaskName "$prefix sheet max elapsed" `
    -Params ([ordered]@{
        sheetIds = @($firstSheetId)
        includeTextNotes = $true
        includeScheduleInstances = $true
        includeViewportTextNotes = $true
        searchBudget = "fast"
        maxElapsedMs = 1
        timeoutMs = 5000
    })
Assert-Equal ([bool]$elapsedProbe.success) $true "Small elapsed-budget sheet scan should return a controlled result."
if ([bool]$elapsedProbe.partial) {
    Assert-Equal ([string]$elapsedProbe.scanStoppedReason) "max_elapsed" "Small elapsed-budget sheet scan partial reason changed."
}

Write-Host "Test native inspect_sheet_text max_bytes pressure metadata"
$bytesProbe = Invoke-InspectSheetText `
    -TaskName "$prefix sheet max bytes" `
    -Params ([ordered]@{
        sheetIds = @($firstSheetId)
        includeTextNotes = $true
        includeScheduleInstances = $true
        includeViewportTextNotes = $true
        searchBudget = "fast"
        maxResponseBytes = 4096
        maxElapsedMs = 5000
        timeoutMs = 10000
    })
Assert-Equal ([bool]$bytesProbe.success) $true "Small response-budget sheet scan should return a controlled result."
if ([bool]$bytesProbe.partial) {
    Assert-Equal ([string]$bytesProbe.scanStoppedReason) "max_bytes" "Small response-budget sheet scan partial reason changed."
}

Write-Host "Test native inspect_sheet_text schedule cell cap metadata"
$scheduleCapProbe = Invoke-InspectSheetText `
    -TaskName "$prefix sheet schedule cell cap" `
    -Params ([ordered]@{
        sheetIds = @($firstSheetId)
        includeTextNotes = $false
        includeScheduleInstances = $true
        scanScheduleCells = $true
        maxScheduleCellsScanned = 1
        maxRowsPerSchedule = 10
        maxColumnsPerSchedule = 10
        searchBudget = "fast"
        maxElapsedMs = 5000
        timeoutMs = 10000
    })
Assert-Equal ([bool]$scheduleCapProbe.success) $true "Schedule-cell capped sheet scan should return a controlled result."
if ([bool]$scheduleCapProbe.partial) {
    Assert-Equal ([string]$scheduleCapProbe.scanStoppedReason) "max_schedule_cells" "Schedule-cell capped sheet scan partial reason changed."
}

Write-Host "Test native inspect_sheet_text scoped viewport tag contract"
$tagProbe = Invoke-InspectSheetText `
    -TaskName "$prefix sheet viewport tags scoped" `
    -Params ([ordered]@{
        sheetIds = @($firstSheetId)
        includeTextNotes = $false
        includeScheduleInstances = $false
        includeViewportTextNotes = $false
        includeViewportTags = $true
        searchBudget = "fast"
        maxViewports = 5
        maxTags = 250
        maxViewportTagsPerView = 25
        maxElapsedMs = 5000
        timeoutMs = 10000
    })
Assert-Equal ([bool]$tagProbe.success) $true "Scoped viewport tag scan should return a controlled result."
Assert-Equal ([bool]$tagProbe.guarded) $false "Scoped viewport tag scan should not be guarded."
Assert-Equal ([string]$tagProbe.action) "inspect_sheet_text" "Scoped viewport tag action changed."
Assert-True (-not (@($tagProbe.warnings) -contains "viewport_tags_deferred")) "Viewport tags must not regress to the old deferred warning."
Assert-True ([int]$tagProbe.scannedSheetCount -le 1) "Scoped viewport tag scan should stay on the requested sheet."
$tagRows = @($tagProbe.matches | Where-Object { ([string]$_.kind) -eq "viewportTag" -or ([string]$_.sourceType) -eq "viewportTag" })
if ($tagRows.Count -gt 0) {
    $firstTag = $tagRows[0]
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$firstTag.tagText)) "Viewport tag evidence must include tagText when readable tags are found."
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$firstTag.tagTextNormalized)) "Viewport tag evidence must include normalized tag text."
    Assert-True ([int]$firstTag.sheetId -eq $firstSheetId) "Viewport tag evidence should stay scoped to the requested sheet."
}

Write-Host "Test native count_annotations guarded no-scope contract"
$countNoScope = Invoke-CountAnnotations `
    -TaskName "$prefix annotation count no scope guard" `
    -Params ([ordered]@{
        query = "QHK"
        sources = @("sheet_text_notes", "viewport_tags")
        countMode = "occurrence"
        searchBudget = "fast"
        maxElapsedMs = 1000
        timeoutMs = 5000
    })
Assert-Equal ([bool]$countNoScope.success) $true "No-scope annotation count should return a protected result, not a transport failure."
Assert-Equal ([bool]$countNoScope.guarded) $true "No-scope annotation count should be guarded."
Assert-Equal ([string]$countNoScope.state) "guarded" "No-scope annotation count guard state changed."
Assert-Equal ([string]$countNoScope.reason) "needs_scope" "No-scope annotation count reason changed."
Assert-Equal ([int]$countNoScope.scannedSheetCount) 0 "No-scope annotation count guard should not scan Revit sheets."

Write-Host "Test native count_annotations scoped occurrence contract"
$countScoped = Invoke-CountAnnotations `
    -TaskName "$prefix annotation count scoped" `
    -Params ([ordered]@{
        sheetIds = @($firstSheetId)
        sources = @("sheet_text_notes", "viewport_tags")
        profiles = @(
            [ordered]@{
                profileName = "non-empty"
                patterns = @(
                    [ordered]@{
                        patternName = "non-empty-regex"
                        matchMode = "regex"
                        value = ".+"
                    }
                )
            }
        )
        countMode = "occurrence"
        groupBy = @("sourceType")
        searchBudget = "fast"
        maxViewports = 5
        maxTags = 250
        maxMatches = 500
        maxResponseBytes = 120000
        maxElapsedMs = 5000
        timeoutMs = 10000
    })
Assert-Equal ([bool]$countScoped.success) $true "Scoped native annotation count should succeed."
Assert-Equal ([bool]$countScoped.guarded) $false "Scoped native annotation count should not be guarded."
Assert-Equal ([string]$countScoped.action) "count_annotations" "Scoped native annotation count action changed."
Assert-True ([int]$countScoped.scannedSheetCount -le 1) "Scoped native annotation count should stay on the requested sheet."
Assert-True ($countScoped.scanPolicy.maxElapsedMs -lt $countScoped.scanPolicy.timeoutMs) "Native annotation count budget must stay below socket timeout."
Assert-True ([int]$countScoped.summary.count -ge 0) "Scoped native annotation count should report a summary count."
Assert-True ($countScoped.evidenceRows -is [array] -or $null -ne $countScoped.evidenceRows) "Scoped native annotation count should expose evidenceRows."
Assert-True ($countScoped.groups -is [array] -or $null -ne $countScoped.groups) "Scoped native annotation count should expose groups."

Write-Host "Test native count_annotations viewport text-note source"
$countViewportTextNotes = Invoke-CountAnnotations `
    -TaskName "$prefix annotation count viewport text notes" `
    -Params ([ordered]@{
        sheetIds = @($firstSheetId)
        sources = @("viewport_text_notes")
        profiles = @(
            [ordered]@{
                profileName = "non-empty-viewport-text"
                patterns = @(
                    [ordered]@{
                        patternName = "non-empty-viewport-text-regex"
                        matchMode = "regex"
                        value = ".+"
                    }
                )
            }
        )
        countMode = "occurrence"
        groupBy = @("sourceType")
        searchBudget = "fast"
        maxViewports = 5
        maxTextNotesScanned = 250
        maxMatches = 500
        maxResponseBytes = 120000
        maxElapsedMs = 5000
        timeoutMs = 10000
    })
Assert-Equal ([bool]$countViewportTextNotes.success) $true "Scoped native viewport text-note annotation count should succeed."
Assert-Equal ([bool]$countViewportTextNotes.guarded) $false "Scoped native viewport text-note annotation count should not be guarded."
Assert-True (@($countViewportTextNotes.scanPolicy.sources) -contains "viewport_text_notes") "Viewport text-note count should report viewport_text_notes in scan policy."
Assert-True (-not (@($countViewportTextNotes.scanPolicy.sources) -contains "sheet_text_notes")) "Explicit viewport text-note count should not add sheet_text_notes."
Assert-True ([int]$countViewportTextNotes.summary.scannedTextNoteCount -ge 0) "Viewport text-note count should report scannedTextNoteCount."
if (@($countViewportTextNotes.evidenceRows).Count -gt 0) {
    $firstViewportTextNote = @($countViewportTextNotes.evidenceRows)[0]
    Assert-Equal ([string]$firstViewportTextNote.sourceType) "viewportTextNote" "Viewport text-note evidence should expose viewportTextNote sourceType."
    Assert-True ($null -ne $firstViewportTextNote.viewId) "Viewport text-note evidence should include viewId."
    Assert-True ($null -ne $firstViewportTextNote.viewportId) "Viewport text-note evidence should include viewportId."
}

Write-Host "Test native count_annotations placed schedule-cell source"
$countPlacedScheduleCells = Invoke-CountAnnotations `
    -TaskName "$prefix annotation count placed schedule cells" `
    -Params ([ordered]@{
        sheetIds = @($firstSheetId)
        sources = @("placed_schedule_cells")
        profiles = @(
            [ordered]@{
                profileName = "non-empty-schedule-cells"
                patterns = @(
                    [ordered]@{
                        patternName = "non-empty-schedule-cell-regex"
                        matchMode = "regex"
                        value = ".+"
                    }
                )
            }
        )
        countMode = "occurrence"
        groupBy = @("sourceType")
        searchBudget = "fast"
        maxScheduleInstancesPerSheet = 5
        maxRowsPerSchedule = 10
        maxColumnsPerSchedule = 10
        maxScheduleInstancesScanned = 25
        maxScheduleCellsScanned = 50
        maxMatches = 100
        maxResponseBytes = 120000
        maxElapsedMs = 5000
        timeoutMs = 10000
    })
Assert-Equal ([bool]$countPlacedScheduleCells.success) $true "Scoped native placed schedule-cell annotation count should succeed."
Assert-Equal ([bool]$countPlacedScheduleCells.guarded) $false "Scoped native placed schedule-cell annotation count should not be guarded."
Assert-True (@($countPlacedScheduleCells.scanPolicy.sources) -contains "placed_schedule_cells") "Placed schedule-cell count should report placed_schedule_cells in scan policy."
Assert-True (-not (@($countPlacedScheduleCells.scanPolicy.sources) -contains "viewport_tags")) "Explicit placed schedule-cell count should not add viewport_tags."
Assert-True ([int]$countPlacedScheduleCells.summary.scannedScheduleCellCount -ge 0) "Placed schedule-cell count should report scannedScheduleCellCount."
if (@($countPlacedScheduleCells.evidenceRows).Count -gt 0) {
    $firstScheduleCellRow = @($countPlacedScheduleCells.evidenceRows)[0]
    Assert-Equal ([string]$firstScheduleCellRow.sourceType) "placedScheduleCell" "Placed schedule-cell evidence should expose placedScheduleCell sourceType."
    Assert-True ($null -ne $firstScheduleCellRow.scheduleId) "Placed schedule-cell evidence should include scheduleId."
    Assert-True ($null -ne $firstScheduleCellRow.row -and $null -ne $firstScheduleCellRow.column) "Placed schedule-cell evidence should include row and column."
}

Write-Host "Test native count_annotations tag count source validation"
$countInvalidTagMode = Invoke-CountAnnotations `
    -TaskName "$prefix annotation count invalid tag mode" `
    -Params ([ordered]@{
        sheetIds = @($firstSheetId)
        sources = @("sheet_text_notes")
        countMode = "uniqueTag"
        searchBudget = "fast"
        maxElapsedMs = 1000
        timeoutMs = 5000
    })
Assert-Equal ([bool]$countInvalidTagMode.success) $true "Invalid tag count source mix should return a protected result, not a transport failure."
Assert-Equal ([bool]$countInvalidTagMode.guarded) $true "Invalid tag count source mix should be guarded."
Assert-Equal ([string]$countInvalidTagMode.reason) "invalid_count_mode_for_sources" "Invalid tag count source mix reason changed."

Write-Host "Test native count_annotations uniqueTag default source contract"
$countUniqueTag = Invoke-CountAnnotations `
    -TaskName "$prefix annotation count unique tag default" `
    -Params ([ordered]@{
        sheetIds = @($firstSheetId)
        countMode = "uniqueTag"
        groupBy = @("sheet")
        searchBudget = "fast"
        maxViewports = 5
        maxTags = 250
        maxMatches = 500
        maxElapsedMs = 5000
        timeoutMs = 10000
    })
Assert-Equal ([bool]$countUniqueTag.success) $true "Scoped native uniqueTag annotation count should succeed."
Assert-Equal ([bool]$countUniqueTag.guarded) $false "Scoped native uniqueTag annotation count should not be guarded."
Assert-Equal ([string]$countUniqueTag.countMode) "uniqueTag" "Scoped native uniqueTag count mode changed."
Assert-True (@($countUniqueTag.scanPolicy.sources) -contains "viewport_tags") "uniqueTag without explicit sources should default to viewport_tags."
Assert-True (-not (@($countUniqueTag.scanPolicy.sources) -contains "sheet_text_notes")) "uniqueTag without explicit sources should not default to sheet_text_notes."

Write-Host "Test native count_annotations viewport query skips do not consume viewport budget"
$countViewportQueryNoMatch = Invoke-CountAnnotations `
    -TaskName "$prefix annotation count viewport query no match" `
    -Params ([ordered]@{
        sheetIds = @($firstSheetId)
        sources = @("viewport_tags")
        viewNameQuery = "__revagent_live_no_matching_view_" + (Get-Date -Format "HHmmssfff")
        countMode = "occurrence"
        searchBudget = "fast"
        maxViewports = 1
        maxTags = 25
        maxMatches = 25
        maxElapsedMs = 5000
        timeoutMs = 10000
    })
Assert-Equal ([bool]$countViewportQueryNoMatch.success) $true "Viewport-query no-match annotation count should succeed."
Assert-Equal ([bool]$countViewportQueryNoMatch.guarded) $false "Viewport-query no-match annotation count should not be guarded."
Assert-Equal ([int]$countViewportQueryNoMatch.scannedViewportCount) 0 "Viewports skipped by viewNameQuery must not consume the scanned viewport budget."
Assert-Equal ([int]$countViewportQueryNoMatch.summary.count) 0 "Viewport-query no-match annotation count should report zero count."

Write-Host "Test find_elements linkedOnly exact-id guard"
$linkedOnlyExactProbe = Invoke-FindElements `
    -TaskName "$prefix find linked exact guard" `
    -Params ([ordered]@{
        elementIds = @(1)
        linkScope = "linkedOnly"
        searchBudget = "fast"
        maxElementsScanned = 10
        maxElapsedMs = 1000
        timeoutMs = 5000
        limit = 1
    })
Assert-Equal ([bool]$linkedOnlyExactProbe.success) $true "linkedOnly exact-id find_elements should return a protected result, not a transport failure."
Assert-Equal ([bool]$linkedOnlyExactProbe.guarded) $true "linkedOnly exact-id find_elements should be guarded."
Assert-Equal ([string]$linkedOnlyExactProbe.state) "guarded" "linkedOnly exact-id guard state changed."
Assert-Equal ([string]$linkedOnlyExactProbe.reason) "needs_scope" "linkedOnly exact-id guard reason changed."
Assert-Equal ([int]$linkedOnlyExactProbe.scannedElementCount) 0 "linkedOnly exact-id guard should not scan host or linked documents."

Write-Host "Test runtime MEP-aware find_elements policy"
Assert-RuntimeFindElementsPolicy

Write-Host "Test clear_selection live cleanup"
$selectionSeed = Invoke-FindElements `
    -TaskName "$prefix selection cleanup seed" `
    -Params ([ordered]@{
        categoryNames = @("Mechanical Equipment", "Ducts", "Pipes", "Air Terminals")
        planCandidateMode = "none"
        searchBudget = "fast"
        maxElementsScanned = 5000
        maxElapsedMs = 3000
        timeoutMs = 8000
        limit = 1
    })
Assert-Equal ([bool]$selectionSeed.success) $true "Selection cleanup seed search should succeed."
Assert-True ([int]$selectionSeed.count -gt 0) "Selection cleanup live gate requires at least one MEP element in the test model."
$selectionTargetId = [int]$selectionSeed.elements[0].id
$selectionFocus = Invoke-FocusElements `
    -TaskName "$prefix select before clear_selection" `
    -Params ([ordered]@{
        elementIds = @($selectionTargetId)
        select = $true
        zoom = $false
        fitToScreen = $false
        allowPartial = $false
        timeoutMs = 10000
    })
Assert-Equal ([bool]$selectionFocus.success) $true "Focus before clear_selection should succeed."
Assert-Equal ([bool]$selectionFocus.selected) $true "Focus before clear_selection should select the target."
$clearSelectionProbe = Invoke-ClearSelection `
    -TaskName "$prefix clear_selection" `
    -Params ([ordered]@{
        timeoutMs = 10000
    })
Assert-Equal ([bool]$clearSelectionProbe.success) $true "clear_selection should succeed."
Assert-Equal ([string]$clearSelectionProbe.state) "completed" "clear_selection state changed."
Assert-True ([int]$clearSelectionProbe.selectionCountBefore -ge 1) "clear_selection should report a non-empty selection before cleanup."
Assert-Equal ([int]$clearSelectionProbe.selectionCountAfter) 0 "clear_selection should leave no selected elements."
Assert-Equal ([bool]$clearSelectionProbe.cleared) $true "clear_selection should report cleared=true."

Write-Host "Test delete_review_view dry-run and commit"
$reviewViewName = "3D - Focus revAgent DeleteReviewView Live Gate " + (Get-Date -Format "HHmmssfff")
$createReviewViewProbe = Invoke-RevitCode `
    -TransactionMode "auto" `
    -TaskName "$prefix create temporary review view" `
    -Code @"
var viewFamilyType = new FilteredElementCollector(document)
    .OfClass(typeof(ViewFamilyType))
    .Cast<ViewFamilyType>()
    .FirstOrDefault(v => v.ViewFamily == ViewFamily.ThreeDimensional);
if (viewFamilyType == null)
{
    return Newtonsoft.Json.JsonConvert.SerializeObject(new { caseName = "temporary_review_view_create_failed", error = "three_dimensional_view_family_type_not_found" });
}
var view = View3D.CreateIsometric(document, viewFamilyType.Id);
view.Name = "$reviewViewName";
return Newtonsoft.Json.JsonConvert.SerializeObject(new {
    caseName = "temporary_review_view_created",
    viewId = view.Id.IntegerValue,
    viewName = view.Name
});
"@
Assert-SuccessfulCodeResult -Result $createReviewViewProbe -CaseName "temporary review view creation"
$reviewViewPayload = ConvertFrom-RevitJsonLike -Value $createReviewViewProbe.result
Assert-Equal ([string]$reviewViewPayload.caseName) "temporary_review_view_created" "Temporary review view creation case changed."
$reviewViewId = [int]$reviewViewPayload.viewId
$deleteDryRun = Invoke-DeleteReviewView `
    -TaskName "$prefix delete_review_view dry-run" `
    -Params ([ordered]@{
        viewId = $reviewViewId
        mode = "dryRun"
        timeoutMs = 10000
    })
Assert-Equal ([bool]$deleteDryRun.success) $true "delete_review_view dry-run should succeed."
Assert-Equal ([bool]$deleteDryRun.dryRun) $true "delete_review_view dry-run should report dryRun=true."
Assert-Equal ([bool]$deleteDryRun.deleted) $false "delete_review_view dry-run must not delete the view."
Assert-Equal ([bool]$deleteDryRun.targetIsReviewView) $true "delete_review_view should recognize the temporary review view."
$deleteNeedsConfirm = Invoke-DeleteReviewView `
    -TaskName "$prefix delete_review_view confirm guard" `
    -Params ([ordered]@{
        viewId = $reviewViewId
        mode = "commit"
        confirmDelete = $false
        timeoutMs = 10000
    })
Assert-Equal ([bool]$deleteNeedsConfirm.success) $true "delete_review_view missing-confirm should return a guarded result."
Assert-Equal ([bool]$deleteNeedsConfirm.guarded) $true "delete_review_view missing-confirm should be guarded."
Assert-Equal ([string]$deleteNeedsConfirm.reason) "delete_confirmation_required" "delete_review_view confirmation guard reason changed."
$deleteCommit = Invoke-DeleteReviewView `
    -TaskName "$prefix delete_review_view commit" `
    -Params ([ordered]@{
        viewId = $reviewViewId
        mode = "commit"
        confirmDelete = $true
        timeoutMs = 15000
    })
Assert-Equal ([bool]$deleteCommit.success) $true "delete_review_view commit should succeed."
Assert-Equal ([bool]$deleteCommit.deleted) $true "delete_review_view commit should verify deletion."
Assert-Equal ([bool]$deleteCommit.changed) $true "delete_review_view commit should report changed=true."

Write-Host "Test delete_review_view blocks sheet-placed review views"
$placedReviewViewName = "3D - Focus revAgent Placed Delete Guard " + (Get-Date -Format "HHmmssfff")
$placedReviewProbe = Invoke-RevitCode `
    -TransactionMode "auto" `
    -TaskName "$prefix create placed temporary review view" `
    -Code @"
var viewFamilyType = new FilteredElementCollector(document)
    .OfClass(typeof(ViewFamilyType))
    .Cast<ViewFamilyType>()
    .FirstOrDefault(v => v.ViewFamily == ViewFamily.ThreeDimensional);
var titleBlockType = new FilteredElementCollector(document)
    .OfCategory(BuiltInCategory.OST_TitleBlocks)
    .WhereElementIsElementType()
    .FirstOrDefault();
if (viewFamilyType == null || titleBlockType == null)
{
    return Newtonsoft.Json.JsonConvert.SerializeObject(new { caseName = "placed_review_view_setup_skipped", reason = "missing_3d_view_type_or_title_block" });
}
var view = View3D.CreateIsometric(document, viewFamilyType.Id);
view.Name = "$placedReviewViewName";
var sheet = ViewSheet.Create(document, titleBlockType.Id);
sheet.Name = "revAgent delete_review_view guard sheet";
sheet.SheetNumber = "RA-DEL-" + DateTime.UtcNow.ToString("HHmmssfff");
var viewport = Viewport.Create(document, sheet.Id, view.Id, new XYZ(0, 0, 0));
return Newtonsoft.Json.JsonConvert.SerializeObject(new {
    caseName = "placed_review_view_created",
    viewId = view.Id.IntegerValue,
    sheetId = sheet.Id.IntegerValue,
    viewportId = viewport.Id.IntegerValue
});
"@
Assert-SuccessfulCodeResult -Result $placedReviewProbe -CaseName "placed temporary review view creation"
$placedReviewPayload = ConvertFrom-RevitJsonLike -Value $placedReviewProbe.result
if ([string]$placedReviewPayload.caseName -eq "placed_review_view_created") {
    $placedReviewViewId = [int]$placedReviewPayload.viewId
    $placedReviewSheetId = [int]$placedReviewPayload.sheetId
    $placedDeleteGuard = Invoke-DeleteReviewView `
        -TaskName "$prefix delete_review_view placed guard" `
        -Params ([ordered]@{
            viewId = $placedReviewViewId
            mode = "commit"
            confirmDelete = $true
            timeoutMs = 15000
        })
    Assert-Equal ([bool]$placedDeleteGuard.success) $true "Placed review view delete should return a guarded result."
    Assert-Equal ([bool]$placedDeleteGuard.guarded) $true "Placed review view delete should be guarded."
    Assert-Equal ([string]$placedDeleteGuard.reason) "placed_review_view_delete_blocked" "Placed review view guard reason changed."
    $cleanupPlacedReview = Invoke-RevitCode `
        -TransactionMode "auto" `
        -TaskName "$prefix cleanup placed delete guard artifacts" `
        -Code @"
var ids = new List<ElementId> { new ElementId($placedReviewSheetId), new ElementId($placedReviewViewId) };
var deleted = new List<int>();
foreach (var id in ids)
{
    var element = document.GetElement(id);
    if (element == null) continue;
    foreach (var deletedId in document.Delete(id))
    {
        deleted.Add(deletedId.IntegerValue);
    }
}
return Newtonsoft.Json.JsonConvert.SerializeObject(new {
    caseName = "placed_review_view_cleanup",
    deletedCount = deleted.Count
});
"@
    Assert-SuccessfulCodeResult -Result $cleanupPlacedReview -CaseName "placed review view cleanup"
}
else {
    Assert-Equal ([string]$placedReviewPayload.caseName) "placed_review_view_setup_skipped" "Unexpected placed review setup case."
}

Write-Host "Test transactionMode none and Newtonsoft.Json compile"
$noneProbe = Invoke-RevitCode `
    -TransactionMode "none" `
    -TaskName "$prefix none probe" `
    -Code @'
return Newtonsoft.Json.JsonConvert.SerializeObject(new {
    caseName = "none_read_probe",
    isModifiable = document.IsModifiable,
    title = document.Title
});
'@
Assert-SuccessfulCodeResult -Result $noneProbe -CaseName "transactionMode none probe"
$nonePayload = ConvertFrom-RevitJsonLike -Value $noneProbe.result
Assert-Equal ([bool]$nonePayload.isModifiable) $false "transactionMode none should run outside the wrapper transaction."

Write-Host "Test transactionMode auto wrapper transaction"
$autoProbe = Invoke-RevitCode `
    -TransactionMode "auto" `
    -TaskName "$prefix auto probe" `
    -Code @'
return Newtonsoft.Json.JsonConvert.SerializeObject(new {
    caseName = "auto_read_probe",
    isModifiable = document.IsModifiable,
    title = document.Title
});
'@
Assert-SuccessfulCodeResult -Result $autoProbe -CaseName "transactionMode auto probe"
$autoPayload = ConvertFrom-RevitJsonLike -Value $autoProbe.result
Assert-Equal ([bool]$autoPayload.isModifiable) $true "transactionMode auto should run inside the wrapper transaction."

Write-Host "Test guarded manual transaction under auto"
$guardTaskName = "$prefix guarded manual tx"
$guardedProbe = Invoke-RevitCode `
    -TransactionMode "auto" `
    -TaskName $guardTaskName `
    -Code @'
using (var tx = new Transaction(document, "revAgent live test should be guarded"))
{
    tx.Start();
    tx.RollBack();
}
return "unexpected";
'@
Assert-Equal ([bool]$guardedProbe.success) $false "Manual transaction under auto should not report success."
Assert-Equal ([bool]$guardedProbe.guarded) $true "Manual transaction under auto should be guarded."
Assert-Equal ([string]$guardedProbe.guardReason) "manual_transaction_requires_transactionMode_none" "Manual transaction guard reason changed."

$statusAfterGuard = Get-RevitMcpStatus
$guardedRecent = @($statusAfterGuard.recentTasks) | Where-Object { $_.taskName -eq $guardTaskName } | Select-Object -First 1
Assert-True ($null -ne $guardedRecent) "Guarded task was not found in recent task history."
Assert-Equal ([string]$guardedRecent.state) "guarded" "Guarded task history state changed."

Write-Host "Test manual transaction rollback under none"
$manualNoneProbe = Invoke-RevitCode `
    -TransactionMode "none" `
    -TaskName "$prefix none manual tx rollback" `
    -Code @'
string started;
string rolledBack;
using (var tx = new Transaction(document, "revAgent live rollback probe"))
{
    started = tx.Start().ToString();
    rolledBack = tx.RollBack().ToString();
}
return Newtonsoft.Json.JsonConvert.SerializeObject(new {
    caseName = "none_manual_transaction_rollback",
    started = started,
    rolledBack = rolledBack,
    isModifiableAfterRollback = document.IsModifiable
});
'@
Assert-SuccessfulCodeResult -Result $manualNoneProbe -CaseName "transactionMode none manual transaction rollback"
$manualNonePayload = ConvertFrom-RevitJsonLike -Value $manualNoneProbe.result
Assert-Equal ([string]$manualNonePayload.started) "Started" "Manual transaction under none did not start."
Assert-Equal ([string]$manualNonePayload.rolledBack) "RolledBack" "Manual transaction under none did not roll back."
Assert-Equal ([bool]$manualNonePayload.isModifiableAfterRollback) $false "Document should not remain modifiable after rollback."

$finalStatus = Get-RevitMcpStatus
Assert-True ($null -eq $finalStatus.activeTask) "Revit MCP active task should be clear after live commandset tests."

Write-Host "Live commandset integration tests passed." -ForegroundColor Green
