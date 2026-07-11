<#
.SYNOPSIS
    Run the read-only Spatial Phase 1a live acceptance gate.

.DESCRIPTION
    Generates a short-lived local JSON config and delegates to the Node harness
    that exercises the built runtime's public capture_spatial_snapshot handler.
    The harness writes only a local SQLite test database and sanitized evidence;
    it never performs a Revit model write and never publishes, deploys, touches
    ProgramData, or accesses the NAS release channel.

    This opt-in live gate requires an open Revit test model and is deliberately
    excluded from test-all.ps1 and test-ci.ps1.
#>

[CmdletBinding()]
param(
    [string]$Target = "",
    [string]$HostName = "",
    [int]$Port = 0,
    [string[]]$LevelNames = @(),
    [int[]]$LevelIds = @(),
    [object[]]$LinkedSourceLevels = @(),
    [string[]]$LinkedSourceLevelNames = @(),
    [ValidateSet("hostOnly", "linkedOnly", "hostAndLinked")]
    [string]$SourceScope = "hostAndLinked",
    [int[]]$LinkInstanceIds = @(),
    [string[]]$LinkInstanceUniqueIds = @(),
    [bool]$IncludeHostMep = $true,
    [bool]$IncludeRoomsSpaces = $true,
    [bool]$IncludeLinkedObstructions = $true,
    [Nullable[double]]$BelowLevelMm = $null,
    [Nullable[double]]$AboveLevelMm = $null,
    [int]$PageTargetBytes = 262144,
    [int]$MaxElements = 25000,
    [int]$MaxElapsedMs = 1800,
    [int]$MaxCaptureElapsedMs = 45000,
    [int]$TimeoutMs = 60000,
    [int]$RepeatCount = 5,
    [int]$PageP95LimitMs = 2000,
    [int]$PageMaxLimitMs = 5000,
    [int]$CaptureP95LimitMs = 45000,
    [int]$CaptureMaxLimitMs = 60000,
    [string]$DatabasePath = "",
    [string]$EvidencePath = "",
    [switch]$PauseAfterCapture,
    [switch]$TestConcurrentEdit,
    [bool]$RequireConnectorEvidence = $true,
    [bool]$RequireDoublePlacedLinkEvidence = $true,
    [ValidateSet("stale", "unknown")]
    [string[]]$ExpectedPostEditLiveness = @("stale", "unknown"),
    [switch]$RecheckExisting,
    [string]$SnapshotId = "",
    [ValidateSet("current", "stale", "unknown")]
    [string]$ExpectedRecheckLiveness = "unknown"
)

$ErrorActionPreference = "Stop"
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Test-PathUnderRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $pathFull = [System.IO.Path]::GetFullPath($Path)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    return $pathFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-ExplicitLocalPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        throw "$Name must be an absolute local path."
    }
    if ($Path.StartsWith("\\")) {
        throw "$Name must not be a UNC/network path."
    }

    $resolved = [System.IO.Path]::GetFullPath($Path)
    $driveRoot = [System.IO.Path]::GetPathRoot($resolved)
    if ([string]::IsNullOrWhiteSpace($driveRoot)) {
        throw "$Name drive root could not be resolved."
    }
    try {
        $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
        $driveType = [int]$driveInfo.DriveType
        $driveReady = [bool]$driveInfo.IsReady
    }
    catch {
        throw "$Name drive type could not be verified; refusing a non-local or unknown root."
    }
    if (-not $driveReady -or $driveType -notin @(2, 3, 6)) {
        throw "$Name must be on a ready local Fixed, Removable, or RAM drive; Network/Unknown/NoRoot roots are rejected (DriveType=$driveType)."
    }
    if (Test-PathUnderRoot -Path $resolved -Root $RepoRoot) {
        throw "$Name must stay outside the Git repository."
    }
    return $resolved
}

if ([string]::IsNullOrWhiteSpace($HostName)) {
    $HostName = if (-not [string]::IsNullOrWhiteSpace($env:REVAGENT_HOST)) {
        $env:REVAGENT_HOST
    }
    else {
        "localhost"
    }
}
if ($Port -le 0) {
    $environmentPort = 0
    $Port = if ([int]::TryParse($env:REVAGENT_PORT, [ref]$environmentPort) -and $environmentPort -gt 0) {
        $environmentPort
    }
    else {
        8080
    }
}

if ($PauseAfterCapture.IsPresent -and $RecheckExisting.IsPresent) {
    throw "PauseAfterCapture cannot be combined with RecheckExisting."
}
if ($TestConcurrentEdit.IsPresent -and $RecheckExisting.IsPresent) {
    throw "TestConcurrentEdit cannot be combined with RecheckExisting."
}
if ($TestConcurrentEdit.IsPresent -and $PauseAfterCapture.IsPresent) {
    throw "TestConcurrentEdit already supplies the post-capture edit and cannot be combined with PauseAfterCapture."
}
if (-not $RecheckExisting.IsPresent -and $LevelNames.Count -eq 0 -and $LevelIds.Count -eq 0) {
    throw "Phase 1a live capture requires -LevelNames and/or -LevelIds. Whole-model capture is not allowed."
}
if ($RecheckExisting.IsPresent -and [string]::IsNullOrWhiteSpace($DatabasePath)) {
    throw "RecheckExisting requires -DatabasePath from a prior retained capture run."
}
if ($RepeatCount -lt 2) {
    throw "RepeatCount must be at least 2 so the frozen-scope stability gate is meaningful."
}
if ($PageP95LimitMs -gt 2000 -or $PageMaxLimitMs -gt 5000) {
    throw "Phase 1a page SLO limits may not be relaxed above p95=2000 ms or max=5000 ms."
}
if ($CaptureP95LimitMs -gt 45000) {
    throw "Phase 1a capture p95 limit may not be relaxed above 45000 ms."
}
if ($MaxElapsedMs -gt 1800) {
    throw "MaxElapsedMs may not exceed 1800 ms in this gate; native work must stay below the 2-second occupancy target."
}

if (-not [string]::IsNullOrWhiteSpace($DatabasePath)) {
    $DatabasePath = Resolve-ExplicitLocalPath -Path $DatabasePath -Name "DatabasePath"
}
if (-not [string]::IsNullOrWhiteSpace($EvidencePath)) {
    $EvidencePath = Resolve-ExplicitLocalPath -Path $EvidencePath -Name "EvidencePath"
}

$nodeScript = Join-Path $PSScriptRoot "test-spatial-phase1a-live.mjs"
if (-not (Test-Path -LiteralPath $nodeScript -PathType Leaf)) {
    throw "Phase 1a Node harness is missing: $nodeScript"
}
$nodeCommand = Get-Command node -ErrorAction Stop

$config = [ordered]@{
    target = $Target
    host = $HostName
    port = $Port
    levelNames = @($LevelNames)
    levelIds = @($LevelIds)
    linkedSourceLevels = @($LinkedSourceLevels)
    linkedSourceLevelNames = @($LinkedSourceLevelNames)
    sourceScope = $SourceScope
    linkInstanceIds = @($LinkInstanceIds)
    linkInstanceUniqueIds = @($LinkInstanceUniqueIds)
    includeHostMep = $IncludeHostMep
    includeRoomsSpaces = $IncludeRoomsSpaces
    includeLinkedObstructions = $IncludeLinkedObstructions
    pageTargetBytes = $PageTargetBytes
    maxElements = $MaxElements
    maxElapsedMs = $MaxElapsedMs
    maxCaptureElapsedMs = $MaxCaptureElapsedMs
    timeoutMs = $TimeoutMs
    repeatCount = $RepeatCount
    pageP95LimitMs = $PageP95LimitMs
    pageMaxLimitMs = $PageMaxLimitMs
    captureP95LimitMs = $CaptureP95LimitMs
    captureMaxLimitMs = $CaptureMaxLimitMs
    databasePath = $DatabasePath
    evidencePath = $EvidencePath
    pauseAfterCapture = $PauseAfterCapture.IsPresent
    testConcurrentEdit = $TestConcurrentEdit.IsPresent
    requireConnectorEvidence = $RequireConnectorEvidence
    requireDoublePlacedLinkEvidence = $RequireDoublePlacedLinkEvidence
    expectedPostEditLiveness = @($ExpectedPostEditLiveness)
    recheckExisting = $RecheckExisting.IsPresent
    snapshotId = $SnapshotId
    expectedRecheckLiveness = $ExpectedRecheckLiveness
}
if ($null -ne $BelowLevelMm) {
    $config["belowLevelMm"] = [double]$BelowLevelMm
}
if ($null -ne $AboveLevelMm) {
    $config["aboveLevelMm"] = [double]$AboveLevelMm
}

$configPath = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-phase1a-live-{0}.json" -f [Guid]::NewGuid().ToString("N"))
$configPath = Resolve-ExplicitLocalPath -Path $configPath -Name "Temporary config path"
try {
    $config | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $configPath -Encoding UTF8
    & $nodeCommand.Source $nodeScript --config $configPath
    if ($LASTEXITCODE -ne 0) {
        throw "Phase 1a live acceptance harness failed with exit code $LASTEXITCODE."
    }
}
finally {
    Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
}

Write-Host "Phase 1a live acceptance wrapper completed without any deploy or publish action." -ForegroundColor Green
