<#
.SYNOPSIS
    Run the read-only Spatial Phase 1b live acceptance gate.

.DESCRIPTION
    Generates a short-lived local JSON config and delegates to the dedicated
    Node harness. The harness exercises only the built public
    get_revit_mcp_status, capture_spatial_snapshot, query_spatial_context,
    compare_spatial_snapshots, and summarize_spatial_state handlers.

    The required frozen fixture, database, sanitized evidence, and
    operator-approved ground truth manifest must be explicit local paths outside the repository. The
    harness never prepares fixture state, changes the Revit model, deploys,
    publishes, writes ProgramData, or accesses the NAS release channel.

    The ground-truth manifest is local-only because it contains fixture node
    identities and reviewed expected normalized outputs. It must declare the
    straight round-to-round Revit-measured distance case, rectangular
    screening-only evidence, operation gold cases, reciprocal topology,
    double-placement evidence, and all required fail-closed cases.

    This opt-in live gate is deliberately excluded from test-all.ps1 and
    test-ci.ps1.

.PARAMETER GroundTruthManifestPath
    Absolute local path to an operator-approved Phase 1b ground-truth manifest.
    The file must remain outside the Git repository.

.PARAMETER FixturePath
    Absolute local path to the frozen/disposable Revit fixture. Its SHA-256
    must match fixtureFileSha256 in the ground-truth manifest.

.PARAMETER DatabasePath
    Absolute local path to the retained SQLite acceptance database. The file is
    intentionally retained after the run.

.PARAMETER EvidencePath
    Absolute local path for sanitized acceptance evidence.

.PARAMETER AgentEvalEvidencePath
    Absolute local path to v2 actual-agent evidence for all required Phase 1b
    protocol variants. Prepare each run with spatial-phase1b-agent-evidence.mjs,
    use the permanent public-handler collector as the turn's only platform tool
    call, then assemble completed Codex Desktop JSONL transcripts. Validation
    binds exact eval/fixture hashes, manifest-selected run/turn ids, the
    call_id-paired collector stdout, immutable trace bytes, complete platform
    call inventory, final response, and deterministic semantic checks. Legacy
    temp/self-attested evidence is rejected. Evidence and source artifacts must
    remain outside Git.

.EXAMPLE
    $root = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1b"
    .\scripts\test-spatial-phase1b-live.ps1 `
      -LevelNames "Level 01" `
      -FixturePath (Join-Path $root "phase1b-fixture.rvt") `
      -DatabasePath (Join-Path $root "acceptance.db") `
      -EvidencePath (Join-Path $root "phase1b-live-evidence-latest.json") `
      -GroundTruthManifestPath (Join-Path $root "ground-truth.json") `
      -AgentEvalEvidencePath (Join-Path $root "phase1b-agent-evals.json") `
      -RepeatCount 20
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
    [ValidateRange(20, 100)]
    [int]$RepeatCount = 20,
    [ValidateRange(1, 750)]
    [int]$OperationLimitMs = 750,
    [ValidateRange(1, 3000)]
    [int]$DiffLimitMs = 3000,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$FixturePath,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DatabasePath,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$EvidencePath,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$GroundTruthManifestPath,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AgentEvalEvidencePath
)

$ErrorActionPreference = "Stop"
$nodeCommand = Get-Command node -ErrorAction Stop

function Get-NativePathState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $encodedPath = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Path))
    $previousEncodedPath = [Environment]::GetEnvironmentVariable(
        "REVAGENT_REALPATH_B64",
        [EnvironmentVariableTarget]::Process
    )
    try {
        $env:REVAGENT_REALPATH_B64 = $encodedPath
        # Template literals keep the JavaScript argument stable through Windows
        # PowerShell's native-command quoting rules.
        $nodeCode = 'const fs=require(`node:fs`);const p=Buffer.from(process.env.REVAGENT_REALPATH_B64,`base64`).toString(`utf8`);let entry=null;try{entry=fs.lstatSync(p);}catch(error){if(error?.code!==`ENOENT`)throw error;}const targetExists=fs.existsSync(p);let stat=null;let realPath=null;if(targetExists){stat=fs.statSync(p);realPath=fs.realpathSync.native(p);}process.stdout.write(JSON.stringify({entryExists:entry!==null,targetExists,isFile:stat?.isFile()===true,isDirectory:stat?.isDirectory()===true,realPath}));'
        $rawState = @(& $nodeCommand.Source -e $nodeCode)
        if ($LASTEXITCODE -ne 0) {
            throw "$Name native path state could not be resolved."
        }
        $stateText = ($rawState -join [Environment]::NewLine).Trim()
        if ([string]::IsNullOrWhiteSpace($stateText)) {
            throw "$Name native path state was empty."
        }
        return ($stateText | ConvertFrom-Json)
    }
    finally {
        if ($null -eq $previousEncodedPath) {
            Remove-Item Env:REVAGENT_REALPATH_B64 -ErrorAction SilentlyContinue
        }
        else {
            $env:REVAGENT_REALPATH_B64 = $previousEncodedPath
        }
    }
}

function Resolve-NativeRealPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$RequireDirectory
    )

    $state = Get-NativePathState -Path $Path -Name $Name
    if ($state.entryExists -and -not $state.targetExists) {
        throw "$Name must not be a dangling symlink or reparse-point path."
    }
    if (-not $state.targetExists -or [string]::IsNullOrWhiteSpace([string]$state.realPath)) {
        throw "$Name was not found."
    }
    if ($RequireDirectory.IsPresent -and -not $state.isDirectory) {
        throw "$Name must be a directory."
    }
    return [System.IO.Path]::GetFullPath([string]$state.realPath)
}

$RepoRootLexical = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RepoRoot = Resolve-NativeRealPath -Path $RepoRootLexical -Name "Git repository root" -RequireDirectory

function Test-PathUnderRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $pathFull = [System.IO.Path]::GetFullPath($Path).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if ($pathFull.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    $rootPrefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
    return $pathFull.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-ExplicitLocalPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$RequireExistingFile
    )

    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        throw "$Name must be an absolute local path."
    }
    if ($Path.StartsWith("\\")) {
        throw "$Name must not be a UNC/network path."
    }

    $requested = [System.IO.Path]::GetFullPath($Path)
    $requestedState = Get-NativePathState -Path $requested -Name $Name
    if ($requestedState.entryExists -and -not $requestedState.targetExists) {
        throw "$Name must not be a dangling symlink or reparse-point path."
    }
    if ($requestedState.targetExists) {
        if (-not $requestedState.isFile) {
            throw "$Name must resolve to a file path."
        }
        $resolved = [System.IO.Path]::GetFullPath([string]$requestedState.realPath)
    }
    else {
        if ($RequireExistingFile.IsPresent) {
            throw "$Name file was not found: $requested"
        }
        $requestedParent = [System.IO.Path]::GetDirectoryName($requested)
        if ([string]::IsNullOrWhiteSpace($requestedParent)) {
            throw "$Name parent directory could not be resolved."
        }
        $realParent = Resolve-NativeRealPath -Path $requestedParent -Name "$Name parent directory" -RequireDirectory
        $resolved = [System.IO.Path]::GetFullPath((Join-Path $realParent ([System.IO.Path]::GetFileName($requested))))
    }
    if ($resolved.StartsWith("\\")) {
        throw "$Name must not resolve to a UNC/network path."
    }
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
    $HostName = if (-not [string]::IsNullOrWhiteSpace($env:REVAGENT_HOST)) { $env:REVAGENT_HOST } else { "localhost" }
}
if ($Port -le 0) {
    $environmentPort = 0
    $Port = if ([int]::TryParse($env:REVAGENT_PORT, [ref]$environmentPort) -and $environmentPort -gt 0) { $environmentPort } else { 8080 }
}

if ($LevelNames.Count -eq 0 -and $LevelIds.Count -eq 0) {
    throw "Phase 1b live acceptance requires -LevelNames and/or -LevelIds. Whole-model capture is not allowed."
}
if ($RepeatCount -lt 20) {
    throw "RepeatCount must be at least 20 measured samples after warm-up."
}
if ($OperationLimitMs -gt 750) {
    throw "OperationLimitMs may not relax the Phase 1b p95 limit above 750 ms."
}
if ($DiffLimitMs -gt 3000) {
    throw "DiffLimitMs may not relax the Phase 1b p95 limit above 3000 ms."
}
if ($MaxElapsedMs -gt 1800) {
    throw "MaxElapsedMs may not exceed 1800 ms; native work must stay below the two-second occupancy target."
}

$FixturePath = Resolve-ExplicitLocalPath -Path $FixturePath -Name "FixturePath" -RequireExistingFile
$DatabasePath = Resolve-ExplicitLocalPath -Path $DatabasePath -Name "DatabasePath" -RequireExistingFile
$EvidencePath = Resolve-ExplicitLocalPath -Path $EvidencePath -Name "EvidencePath"
$GroundTruthManifestPath = Resolve-ExplicitLocalPath -Path $GroundTruthManifestPath -Name "GroundTruthManifestPath" -RequireExistingFile
$AgentEvalEvidencePath = Resolve-ExplicitLocalPath -Path $AgentEvalEvidencePath -Name "AgentEvalEvidencePath" -RequireExistingFile

$nodeScript = Join-Path $PSScriptRoot "test-spatial-phase1b-live.mjs"
if (-not (Test-Path -LiteralPath $nodeScript -PathType Leaf)) {
    throw "Phase 1b Node harness is missing: $nodeScript"
}
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
    operationLimitMs = $OperationLimitMs
    diffLimitMs = $DiffLimitMs
    fixturePath = $FixturePath
    databasePath = $DatabasePath
    evidencePath = $EvidencePath
    groundTruthManifestPath = $GroundTruthManifestPath
    agentEvalEvidencePath = $AgentEvalEvidencePath
}
if ($null -ne $BelowLevelMm) { $config["belowLevelMm"] = [double]$BelowLevelMm }
if ($null -ne $AboveLevelMm) { $config["aboveLevelMm"] = [double]$AboveLevelMm }

$configPath = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-phase1b-live-{0}.json" -f [Guid]::NewGuid().ToString("N"))
$configPath = Resolve-ExplicitLocalPath -Path $configPath -Name "Temporary config path"
try {
    $config | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $configPath -Encoding UTF8
    & $nodeCommand.Source $nodeScript --config $configPath
    if ($LASTEXITCODE -ne 0) {
        throw "Phase 1b live acceptance harness failed with exit code $LASTEXITCODE."
    }
}
finally {
    Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
}

Write-Host "Phase 1b live acceptance wrapper completed without any deploy or publish action." -ForegroundColor Green
