<#
.SYNOPSIS
    Run the read-only Phase 0 spatial extraction acceptance gate in live Revit.

.DESCRIPTION
    Calls the native extract_spatial_snapshot command one page at a time after
    an mcp_status preflight, repeats the capture to audit identity stability,
    and writes model-sensitive raw pages only to the local revAgent user-state
    directory. The compact evidence file contains counts, hashes, and gate
    results, never geometry, element ids, room/space names, or snapshot rows.

    This is an opt-in live gate. It is not part of CI because it requires Revit,
    a loaded reference model, an explicit level scope, and an independent
    manual geometry plus Room/Space audit.
#>

[CmdletBinding()]
param(
    [string]$HostName = "",
    [int]$Port = 0,
    [string[]]$LevelNames = @(),
    [int[]]$LevelIds = @(),
    [object[]]$LinkedSourceLevels = @(),
    [string[]]$LinkedSourceLevelNames = @(),
    [ValidateSet("hostOnly", "linkedOnly", "hostAndLinked")]
    [string]$SourceScope = "hostAndLinked",
    [int]$PageTargetBytes = 262144,
    [int]$MaxElements = 25000,
    [int]$MaxElapsedMs = 5000,
    [int]$TimeoutMs = 60000,
    [string]$EvidencePath = "",
    [string]$RawAuditPath = "",
    [switch]$ConfirmGeometryAudit,
    [switch]$ConfirmRoomSpaceAudit,
    [string]$AuditObserver = ""
)

$ErrorActionPreference = "Stop"
$startedAtUtc = (Get-Date).ToUniversalTime()

if ([string]::IsNullOrWhiteSpace($HostName)) {
    $HostName = if (-not [string]::IsNullOrWhiteSpace($env:REVAGENT_HOST)) { $env:REVAGENT_HOST } else { "localhost" }
}
if ($Port -le 0) {
    $parsedPort = 0
    if ([int]::TryParse($env:REVAGENT_PORT, [ref]$parsedPort) -and $parsedPort -gt 0) {
        $Port = $parsedPort
    }
    else {
        $Port = 8080
    }
}
if ($LevelNames.Count -eq 0 -and $LevelIds.Count -eq 0) {
    throw "Phase 0 live extraction requires -LevelNames and/or -LevelIds. Whole-model extraction is not allowed."
}
if ($PageTargetBytes -lt 65536 -or $PageTargetBytes -gt (8 * 1024 * 1024)) {
    throw "PageTargetBytes must be between 65536 and 8388608."
}
if ($MaxElements -lt 1 -or $MaxElements -gt 25000) {
    throw "MaxElements must be between 1 and 25000."
}
if ($MaxElapsedMs -lt 250 -or $MaxElapsedMs -gt 25000) {
    throw "MaxElapsedMs must be between 250 and 25000."
}
if ($TimeoutMs -lt 2000 -or $TimeoutMs -gt 60000 -or $MaxElapsedMs -gt ($TimeoutMs - 250)) {
    throw "TimeoutMs must be between 2000 and 60000 and leave at least 250 ms above MaxElapsedMs."
}

$localRoot = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase0"
$runStamp = $startedAtUtc.ToString("yyyyMMddTHHmmssZ")
if ([string]::IsNullOrWhiteSpace($EvidencePath)) {
    $EvidencePath = Join-Path $localRoot "phase0-live-evidence-latest.json"
}
if ([string]::IsNullOrWhiteSpace($RawAuditPath)) {
    $RawAuditPath = Join-Path $localRoot ("audit-" + $runStamp + ".json")
}
$localRootFull = [System.IO.Path]::GetFullPath($localRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$rawAuditFull = [System.IO.Path]::GetFullPath($RawAuditPath)
if (-not $rawAuditFull.StartsWith($localRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "RawAuditPath must stay under the local revAgent user-state root: $localRoot"
}
$RawAuditPath = $rawAuditFull

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Get-Field {
    param([object]$Object, [string[]]$Names)
    if ($null -eq $Object) { return $null }
    foreach ($name in $Names) {
        if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($name)) {
            return $Object[$name]
        }
        $property = $Object.PSObject.Properties[$name]
        if ($null -ne $property) { return $property.Value }
    }
    return $null
}

function Read-ExactBytes {
    param([System.IO.Stream]$Stream, [int]$Count)
    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $read = $Stream.Read($buffer, $offset, $Count - $offset)
        if ($read -le 0) { throw "Socket closed while reading a revAgent response." }
        $offset += $read
    }
    return $buffer
}

function Invoke-BridgeRequest {
    param([string]$Method, [object]$Params = @{})
    $client = New-Object System.Net.Sockets.TcpClient
    $client.ReceiveTimeout = $TimeoutMs
    $client.SendTimeout = $TimeoutMs
    try {
        $client.Connect($HostName, $Port)
        $stream = $client.GetStream()
        $request = [ordered]@{
            jsonrpc = "2.0"
            method = $Method
            params = $Params
            id = [Guid]::NewGuid().ToString("N")
        }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Depth 30 -Compress))
        $header = [System.BitConverter]::GetBytes([uint32]$bytes.Length)
        if ([System.BitConverter]::IsLittleEndian) { [array]::Reverse($header) }
        $stream.Write($header, 0, $header.Length)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()

        $responseHeader = Read-ExactBytes -Stream $stream -Count 4
        if ([System.BitConverter]::IsLittleEndian) { [array]::Reverse($responseHeader) }
        $responseLength = [System.BitConverter]::ToUInt32($responseHeader, 0)
        Assert-True ($responseLength -gt 0 -and $responseLength -le (32 * 1024 * 1024)) "Invalid bridge response length: $responseLength"
        $responseText = [System.Text.Encoding]::UTF8.GetString((Read-ExactBytes -Stream $stream -Count ([int]$responseLength)))
        $script:LastBridgeResponseText = $responseText
        $response = $responseText | ConvertFrom-Json
        if ($null -ne $response.error) {
            throw "revAgent request '$Method' failed: $($response.error.message)"
        }
        return $response.result
    }
    finally {
        $client.Close()
    }
}

function Assert-BridgeReady {
    param([string]$NextCommand)
    $status = Invoke-BridgeRequest -Method "mcp_status" -Params @{}
    $activeTask = Get-Field -Object $status -Names @("activeTask", "ActiveTask")
    if ($null -ne $activeTask) {
        $taskName = [string](Get-Field -Object $activeTask -Names @("taskName", "method", "TaskName", "Method"))
        $elapsedMs = Get-Field -Object $activeTask -Names @("elapsedMs", "ElapsedMs")
        throw "revAgent is busy with '$taskName' ($elapsedMs ms). Wait before '$NextCommand'."
    }
    return $status
}

function Get-NodeIdentity {
    param([object]$Node)
    return [string](Get-Field -Object $Node -Names @("nodeId", "NodeId"))
}

function Get-OmissionIdentity {
    param([object]$Omission)
    $elementRef = Get-Field -Object $Omission -Names @("elementRef", "ElementRef")
    $source = @(
        (Get-Field -Object $Omission -Names @("nodeId", "NodeId")),
        (Get-Field -Object $elementRef -Names @("documentKey", "DocumentKey")),
        (Get-Field -Object $elementRef -Names @("linkInstanceUniqueId", "LinkInstanceUniqueId")),
        (Get-Field -Object $elementRef -Names @("elementUniqueId", "ElementUniqueId")),
        (Get-Field -Object $Omission -Names @("documentKey", "DocumentKey")),
        (Get-Field -Object $Omission -Names @("linkInstanceUniqueId", "LinkInstanceUniqueId")),
        (Get-Field -Object $Omission -Names @("classification", "Classification"))
    ) -join "|"
    return $source
}

function Invoke-SpatialCapture {
    param([string]$RunName)
    $pages = New-Object System.Collections.Generic.List[object]
    $nodes = New-Object System.Collections.Generic.List[object]
    $omissions = New-Object System.Collections.Generic.List[object]
    $rawResponses = New-Object System.Collections.Generic.List[string]
    $cursor = ""
    $priorHash = ""
    $ordinal = 0
    $expectedCaptureId = ""
    $expectedScopeFingerprint = ""
    $expectedRevisionFingerprint = ""
    $expectedCapturedAt = ""
    do {
        Assert-BridgeReady -NextCommand "extract_spatial_snapshot" | Out-Null
        $params = [ordered]@{
            levelNames = @($LevelNames)
            levelIds = @($LevelIds)
            linkedSourceLevels = @($LinkedSourceLevels)
            linkedSourceLevelNames = @($LinkedSourceLevelNames)
            sourceScope = $SourceScope
            includeHostMep = $true
            includeRoomsSpaces = $true
            includeLinkedObstructions = $true
            pageTargetBytes = $PageTargetBytes
            maxElements = $MaxElements
            maxElapsedMs = $MaxElapsedMs
            timeoutMs = $TimeoutMs
            suppressTaskStatusWindow = $true
            taskName = "Phase 0 spatial extraction page"
        }
        if (-not [string]::IsNullOrWhiteSpace($cursor)) { $params.cursor = $cursor }
        $result = Invoke-BridgeRequest -Method "extract_spatial_snapshot" -Params $params
        $rawResponses.Add($script:LastBridgeResponseText)
        Assert-True ([bool](Get-Field -Object $result -Names @("success", "Success"))) "$RunName page $ordinal did not succeed."
        $guardReason = Get-Field -Object $result -Names @("reason", "Reason")
        $guardMessage = Get-Field -Object $result -Names @("message", "Message", "error", "Error")
        Assert-True (-not [bool](Get-Field -Object $result -Names @("guarded", "Guarded"))) "$RunName page $ordinal was guarded: $guardReason. $guardMessage"
        Assert-True ([string](Get-Field -Object $result -Names @("schemaVersion", "SchemaVersion")) -eq "0.1") "$RunName schemaVersion changed."
        Assert-True ([string](Get-Field -Object $result -Names @("coordinateFrame", "CoordinateFrame")) -eq "host_internal_mm") "$RunName coordinate frame changed."
        Assert-True ([string](Get-Field -Object $result -Names @("lengthUnit", "LengthUnit")) -eq "mm") "$RunName length unit changed."
        Assert-True (-not [bool](Get-Field -Object $result -Names @("atomic", "Atomic"))) "$RunName must remain explicitly non-atomic in Phase 0."
        Assert-True ([string](Get-Field -Object $result -Names @("liveness", "Liveness")) -eq "unknown") "$RunName must report unknown liveness in Phase 0."
        $coverageStatus = [string](Get-Field -Object $result -Names @("coverageStatus", "CoverageStatus"))
        Assert-True (@("complete", "incomplete_omissions", "incomplete_budget") -contains $coverageStatus) "$RunName returned invalid coverageStatus '$coverageStatus'."
        $scanStoppedReason = [string](Get-Field -Object $result -Names @("scanStoppedReason", "ScanStoppedReason"))
        $counts = Get-Field -Object $result -Names @("counts", "Counts")
        $coverage = Get-Field -Object $result -Names @("coverage", "Coverage")
        $totalCoverageOmissions = [int](Get-Field -Object $counts -Names @("omittedSupportedNodes", "OmittedSupportedNodes")) +
            [int](Get-Field -Object $coverage -Names @("sourceAvailabilityOmissionCount", "SourceAvailabilityOmissionCount"))
        $expectedCoverageStatus = if (@("max_elapsed", "max_items") -contains $scanStoppedReason) {
            "incomplete_budget"
        }
        elseif ($totalCoverageOmissions -gt 0) {
            "incomplete_omissions"
        }
        else {
            "complete"
        }
        Assert-True ($coverageStatus -eq $expectedCoverageStatus) "$RunName coverageStatus '$coverageStatus' conflicts with omission/budget evidence '$expectedCoverageStatus'."
        $captureId = [string](Get-Field -Object $result -Names @("captureId", "CaptureId"))
        $scopeFingerprint = [string](Get-Field -Object $result -Names @("scopeFingerprint", "ScopeFingerprint"))
        $revisionFingerprint = [string](Get-Field -Object $result -Names @("revisionFingerprint", "RevisionFingerprint"))
        $capturedAt = [string](Get-Field -Object $result -Names @("capturedAt", "CapturedAt"))
        if ($ordinal -eq 0) {
            $expectedCaptureId = $captureId
            $expectedScopeFingerprint = $scopeFingerprint
            $expectedRevisionFingerprint = $revisionFingerprint
            $expectedCapturedAt = $capturedAt
        }
        else {
            Assert-True ($captureId -eq $expectedCaptureId) "$RunName captureId changed between pages."
            Assert-True ($scopeFingerprint -eq $expectedScopeFingerprint) "$RunName scope fingerprint changed between pages."
            Assert-True ($revisionFingerprint -eq $expectedRevisionFingerprint) "$RunName revision fingerprint changed between pages."
            Assert-True ($capturedAt -eq $expectedCapturedAt) "$RunName capturedAt changed between pages."
        }
        $page = Get-Field -Object $result -Names @("page", "Page")
        Assert-True ($null -ne $page) "$RunName page envelope is missing."
        Assert-True ([int](Get-Field -Object $page -Names @("ordinal", "Ordinal")) -eq $ordinal) "$RunName page ordinal is not continuous."
        $pageHash = [string](Get-Field -Object $page -Names @("pageSha256", "PageSha256"))
        Assert-True ($pageHash -match '^sha256:[0-9a-fA-F]{64}$') "$RunName page hash is invalid."
        $reportedPriorHash = [string](Get-Field -Object $page -Names @("priorPageSha256", "PriorPageSha256"))
        if ($ordinal -gt 0) {
            Assert-True ($reportedPriorHash -eq $priorHash) "$RunName page hash chain broke at ordinal $ordinal."
        }
        $pageNodes = @(Get-Field -Object $result -Names @("nodes", "Nodes"))
        $pageOmissions = @(Get-Field -Object $result -Names @("omissions", "Omissions"))
        Assert-True ([int](Get-Field -Object $page -Names @("recordCount", "RecordCount")) -eq $pageNodes.Count) "$RunName page record count does not match nodes."
        foreach ($node in $pageNodes) { $nodes.Add($node) }
        foreach ($omission in $pageOmissions) { $omissions.Add($omission) }
        $pages.Add($result)

        $hasMore = [bool](Get-Field -Object $page -Names @("hasMore", "HasMore"))
        $cursor = [string](Get-Field -Object $page -Names @("nextCursor", "NextCursor"))
        if ($hasMore) { Assert-True (-not [string]::IsNullOrWhiteSpace($cursor)) "$RunName page $ordinal omitted nextCursor." }
        $priorHash = $pageHash
        $ordinal += 1
        Assert-True ($ordinal -le 500) "$RunName exceeded the 500-page safety limit."
    } while ($hasMore)
    Assert-True ([string]::IsNullOrWhiteSpace($cursor)) "$RunName final page must return a null/empty nextCursor."

    $nodeIds = @($nodes | ForEach-Object { Get-NodeIdentity -Node $_ })
    Assert-True (($nodeIds | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -eq 0) "$RunName contains a node without nodeId."
    Assert-True (($nodeIds | Sort-Object -Unique).Count -eq $nodeIds.Count) "$RunName contains duplicate node ids across pages."
    Assert-True (@($omissions | Where-Object { [string]::IsNullOrWhiteSpace([string](Get-Field -Object $_ -Names @('classification','Classification'))) }).Count -eq 0) "$RunName contains an unclassified omission."
    $omissionIds = @($omissions | ForEach-Object { Get-OmissionIdentity -Omission $_ })
    Assert-True (($omissionIds | Sort-Object -Unique).Count -eq $omissionIds.Count) "$RunName contains duplicate omissions across pages."
    if ($LinkedSourceLevels.Count -gt 0 -or $LinkedSourceLevelNames.Count -gt 0) {
        foreach ($node in $nodes) {
            if ([string](Get-Field -Object $node -Names @("categoryRole", "CategoryRole")) -ne "spatial") { continue }
            $elementRef = Get-Field -Object $node -Names @("elementRef", "ElementRef")
            if ([string](Get-Field -Object $elementRef -Names @("sourceKind", "SourceKind")) -ne "link") { continue }
            $placement = [string](Get-Field -Object $elementRef -Names @("linkInstanceUniqueId", "LinkInstanceUniqueId"))
            $levelRef = Get-Field -Object $node -Names @("levelRef", "LevelRef")
            $levelId = [int](Get-Field -Object $levelRef -Names @("sourceLevelId", "SourceLevelId"))
            $levelUniqueId = [string](Get-Field -Object $levelRef -Names @("sourceLevelUniqueId", "SourceLevelUniqueId"))
            $levelName = [string](Get-Field -Object $levelRef -Names @("sourceLevelName", "SourceLevelName"))
            $matches = @($LinkedSourceLevelNames | Where-Object { [string]::Equals($_, $levelName, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
            if (-not $matches) {
                foreach ($selector in $LinkedSourceLevels) {
                    if (-not [string]::Equals([string](Get-Field -Object $selector -Names @("linkInstanceUniqueId", "LinkInstanceUniqueId")), $placement, [System.StringComparison]::Ordinal)) { continue }
                    $selectorLevelId = Get-Field -Object $selector -Names @("levelId", "LevelId")
                    $selectorLevelUniqueId = [string](Get-Field -Object $selector -Names @("levelUniqueId", "LevelUniqueId"))
                    $selectorLevelName = [string](Get-Field -Object $selector -Names @("levelName", "LevelName"))
                    if ($null -ne $selectorLevelId -and [int]$selectorLevelId -ne $levelId) { continue }
                    if (-not [string]::IsNullOrWhiteSpace($selectorLevelUniqueId) -and -not [string]::Equals($selectorLevelUniqueId, $levelUniqueId, [System.StringComparison]::Ordinal)) { continue }
                    if (-not [string]::IsNullOrWhiteSpace($selectorLevelName) -and -not [string]::Equals($selectorLevelName, $levelName, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
                    $matches = $true
                    break
                }
            }
            Assert-True $matches "$RunName linked spatial node $($elementRef.elementId) escaped the exact linked source-level filter."
        }
    }

    return [pscustomobject]@{
        Pages = $pages.ToArray()
        Nodes = $nodes.ToArray()
        Omissions = $omissions.ToArray()
        RawResponses = $rawResponses.ToArray()
        NodeIds = @($nodeIds)
        CaptureId = $expectedCaptureId
        ScopeFingerprint = $expectedScopeFingerprint
        RevisionFingerprint = $expectedRevisionFingerprint
        CapturedAt = $expectedCapturedAt
    }
}

Write-Host "Phase 0 spatial live target: $HostName`:$Port"
$initialStatus = Assert-BridgeReady -NextCommand "Phase 0 spatial live gate"
$first = Invoke-SpatialCapture -RunName "capture A"
$second = Invoke-SpatialCapture -RunName "capture B"

$rawDirectory = Split-Path -Parent $RawAuditPath
if (-not [string]::IsNullOrWhiteSpace($rawDirectory)) { New-Item -ItemType Directory -Path $rawDirectory -Force | Out-Null }
[ordered]@{
    warning = "LOCAL MODEL-SENSITIVE PHASE 0 AUDIT DATA. DO NOT PUBLISH OR SEND TO USAGE INTELLIGENCE."
    capturedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    responseEncoding = "jsonrpc_response_text_v1"
    firstCaptureRawResponses = $first.RawResponses
    secondCaptureRawResponses = $second.RawResponses
} | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $RawAuditPath -Encoding UTF8
Write-Host "Local raw audit ready for independent review: $RawAuditPath"

$firstIds = @($first.NodeIds | Sort-Object)
$secondIds = @($second.NodeIds | Sort-Object)
$sameScope = $first.ScopeFingerprint -eq $second.ScopeFingerprint
$sameRevision = $first.RevisionFingerprint -eq $second.RevisionFingerprint
Assert-True $sameScope "Repeated captures did not use the same scope fingerprint."
Assert-True $sameRevision "The model revision changed between repeated captures; identity stability cannot be audited."
$stableIdentity = (($firstIds -join "`n") -ceq ($secondIds -join "`n"))
Assert-True $stableIdentity "Audited supported node identities changed between repeated captures."

$firstOmissions = @($first.Omissions | ForEach-Object { Get-OmissionIdentity -Omission $_ } | Sort-Object -Unique)
$secondOmissions = @($second.Omissions | ForEach-Object { Get-OmissionIdentity -Omission $_ } | Sort-Object -Unique)
Assert-True (($firstOmissions -join "`n") -ceq ($secondOmissions -join "`n")) "Classified omission identities changed between repeated captures."
$coverageRecord = Get-Field -Object $first.Pages[0] -Names @("coverage", "Coverage")
$firstCoverageStatus = [string](Get-Field -Object $first.Pages[0] -Names @("coverageStatus", "CoverageStatus"))
$coverage = [double](Get-Field -Object $coverageRecord -Names @("extractionCoverageRatio", "ExtractionCoverageRatio"))
$allOmissionsClassified = [bool](Get-Field -Object $coverageRecord -Names @("allEligibleOmissionsClassified", "AllEligibleOmissionsClassified"))
$phase0CoverageTarget = [bool](Get-Field -Object $coverageRecord -Names @("phase0TargetAtLeast0_995", "Phase0TargetAtLeast0_995"))
$expectedOrderedRows = [int](Get-Field -Object $coverageRecord -Names @("totalOrderedRowCount", "TotalOrderedRowCount"))
$actualOrderedRows = $first.Nodes.Count + $firstOmissions.Count
$omittedAcrossPages = $expectedOrderedRows - $actualOrderedRows
Assert-True $allOmissionsClassified "The native coverage contract reports an unclassified eligible omission."
Assert-True ($omittedAcrossPages -eq 0) "Pagination omitted $omittedAcrossPages ordered rows."
Assert-True $phase0CoverageTarget "The native extractor did not complete its bounded scan or did not meet the 99.5% coverage target."
Assert-True ($coverage -ge 0.995) "Extraction coverage is $([math]::Round($coverage * 100, 4))%, below the 99.5% Phase 0 gate."

$sourceRevisions = @(Get-Field -Object $first.Pages[0] -Names @("sourceRevisions", "SourceRevisions"))
$transformValidation = Get-Field -Object $first.Pages[0] -Names @("transformValidation", "TransformValidation")
$maxRoundTripErrorValue = Get-Field -Object $transformValidation -Names @("maxRoundTripErrorMm", "MaxRoundTripErrorMm")
$maxRoundTripErrorMm = if ($null -ne $maxRoundTripErrorValue) { [double]$maxRoundTripErrorValue } else { [double]::PositiveInfinity }
Assert-True ([bool](Get-Field -Object $transformValidation -Names @("allWithin0_5mm", "AllWithin0_5mm"))) "The native transform validation reports a failed source transform."
Assert-True ($maxRoundTripErrorMm -le 0.5) "Host/link transform round-trip error is $maxRoundTripErrorMm mm, above the 0.5 mm gate."

function Test-NodeRole {
    param([object]$Node, [string]$Role, [string]$SourceKind = "")
    $categoryRole = [string](Get-Field -Object $Node -Names @("categoryRole", "CategoryRole"))
    $elementRef = Get-Field -Object $Node -Names @("elementRef", "ElementRef")
    $resolvedSourceKind = [string](Get-Field -Object $elementRef -Names @("sourceKind", "SourceKind"))
    return $categoryRole -eq $Role -and ([string]::IsNullOrWhiteSpace($SourceKind) -or $resolvedSourceKind -eq $SourceKind)
}

$hostMepCount = @($first.Nodes | Where-Object { Test-NodeRole -Node $_ -Role 'host_mep' -SourceKind 'host' }).Count
$linkedRoomSpaceCount = @($first.Nodes | Where-Object { Test-NodeRole -Node $_ -Role 'spatial' -SourceKind 'link' }).Count
$linkedObstructionCount = @($first.Nodes | Where-Object { Test-NodeRole -Node $_ -Role 'linked_obstruction' -SourceKind 'link' }).Count
Assert-True ($hostMepCount -gt 0) "Reference level contains no extracted host MEP evidence."
Assert-True ($linkedRoomSpaceCount -gt 0) "Reference level contains no extracted linked Room/Space evidence."
Assert-True ($linkedObstructionCount -gt 0) "Reference level contains no extracted linked structural/architectural obstruction evidence."

$pageVerifier = Join-Path $PSScriptRoot "verify-spatial-phase0-pages.mjs"
Assert-True (Test-Path -LiteralPath $pageVerifier -PathType Leaf) "Phase 0 page verifier is missing: $pageVerifier"
Assert-True ($null -ne (Get-Command node -ErrorAction SilentlyContinue)) "Node.js is required to independently verify canonical page hashes."
$verificationText = (& node $pageVerifier $RawAuditPath 2>&1) -join "`n"
Assert-True ($LASTEXITCODE -eq 0) "Independent Phase 0 page verification failed: $verificationText"
$pageVerification = $verificationText | ConvertFrom-Json
Assert-True ([bool]$pageVerification.success) "Independent Phase 0 page verification did not report success."

Assert-True $ConfirmGeometryAudit.IsPresent "Manual geometry audit is not confirmed. Re-run with -ConfirmGeometryAudit after independent review."
Assert-True $ConfirmRoomSpaceAudit.IsPresent "Manual Room/Space audit is not confirmed. Re-run with -ConfirmRoomSpaceAudit after independent review."
Assert-True (-not [string]::IsNullOrWhiteSpace($AuditObserver)) "AuditObserver is required when manual audit confirmations are supplied."

$nodeIdentityHashInput = $firstIds -join "`n"
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $nodeIdentityHash = ([System.BitConverter]::ToString($sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($nodeIdentityHashInput)))).Replace("-", "").ToLowerInvariant()
}
finally {
    $sha256.Dispose()
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $observerHashMaterial = "$($startedAtUtc.ToString("o"))`n$AuditObserver"
    $observerHash = ([System.BitConverter]::ToString($sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($observerHashMaterial)))).Replace("-", "").ToLowerInvariant()
}
finally {
    $sha256.Dispose()
}

$completedAtUtc = (Get-Date).ToUniversalTime()
$evidence = [ordered]@{
    schemaVersion = "revagent.spatial.phase0.live-evidence.v1"
    passed = $true
    status = "passed"
    startedAtUtc = $startedAtUtc.ToString("o")
    completedAtUtc = $completedAtUtc.ToString("o")
    target = [ordered]@{
        port = $Port
        levelNameCount = $LevelNames.Count
        levelIdCount = $LevelIds.Count
        linkedSourceLevelSelectorCount = $LinkedSourceLevels.Count
        linkedSourceLevelNameCount = $LinkedSourceLevelNames.Count
    }
    contract = [ordered]@{ snapshotSchemaVersion = "0.1"; coordinateFrame = "host_internal_mm"; pageTargetBytes = $PageTargetBytes }
    identity = [ordered]@{ stable = $stableIdentity; auditedNodeCount = $firstIds.Count; nodeIdentitySetSha256 = $nodeIdentityHash }
    extraction = [ordered]@{
        pageCount = $first.Pages.Count
        nodeCount = $first.Nodes.Count
        omissionCount = $firstOmissions.Count
        omissionsClassified = $true
        coverage = $coverage
        coverageStatus = $firstCoverageStatus
        duplicateNodeCount = 0
        omittedAcrossPages = $omittedAcrossPages
    }
    paginationIntegrity = [ordered]@{
        canonicalPageHashesRecomputed = $true
        exactRowsMatchedSplitPayloads = $true
        totalCanonicalPayloadBytes = [int]$pageVerification.first.payloadBytes
        secondCapturePageCount = [int]$pageVerification.second.pageCount
    }
    transforms = [ordered]@{ sourceRevisionCount = $sourceRevisions.Count; maxRoundTripErrorMm = $maxRoundTripErrorMm }
    evidenceCounts = [ordered]@{ hostMep = $hostMepCount; linkedRoomSpace = $linkedRoomSpaceCount; linkedObstruction = $linkedObstructionCount }
    manualAudit = [ordered]@{ geometry = $true; roomSpace = $true; observerSha256 = $observerHash }
    rawAuditStoredLocally = $true
    notes = @(
        "Phase 0 capture is a non-atomic spike with liveness unknown; it is not a current-state production snapshot.",
        "The compact evidence contains no geometry, element ids, room/space names, or snapshot rows."
    )
}
$evidenceDirectory = Split-Path -Parent $EvidencePath
if (-not [string]::IsNullOrWhiteSpace($evidenceDirectory)) { New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null }
$evidence | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8

$finalStatus = Assert-BridgeReady -NextCommand "finish Phase 0 spatial live gate"
Assert-True ($null -eq (Get-Field -Object $finalStatus -Names @("activeTask", "ActiveTask"))) "revAgent active task was not clear after the live gate."

Write-Host "Phase 0 spatial live gate passed." -ForegroundColor Green
Write-Host "Compact evidence: $EvidencePath"
Write-Host "Local raw audit: $RawAuditPath"
