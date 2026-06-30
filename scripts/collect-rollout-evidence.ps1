<#
.SYNOPSIS
    Collect source-free and desktop-launcher rollout evidence over SSH.

.DESCRIPTION
    This helper is intentionally evidence-only. It stages the read-only
    rollout evidence tools on each target machine, runs source-free migration
    inventory in dry-run mode, runs local desktop launcher scanning, and then
    aggregates desktop launcher evidence on the coordinator machine.

    It does not install, repair, update, migrate in commit mode, stop
    processes, or touch Revit/Codex running state. Use it after machines are
    already on the desired stable version and the closure audit asks for
    source-free or desktop launcher evidence.

.PARAMETER TargetsPath
    JSON file containing either an array of targets or an object with a
    "targets", "fleet", or "machines" array. Each target supports:
    computer/name/machine, user/userName, and optional host.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collect-rollout-evidence.ps1 `
      -TargetsPath C:\ProgramData\DPE\revAgentOps\fleet.json `
      -ReleaseRoot "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
#>

[CmdletBinding()]
param(
    [string]$TargetsPath = "",

    [string[]]$Computer = @(),

    [string]$Key = "$env:USERPROFILE\.ssh\office_admin_access",

    [string]$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy",

    [string]$ReportsRoot = "",

    [string]$RemoteStage = "C:\ProgramData\DPE\revAgent-evidence-stage",

    [string]$InstallRoot = "C:\ProgramData\DPE\revAgent",

    [int]$SshTimeoutSec = 600,

    [switch]$ListOnly,

    [switch]$SkipSourceFree,

    [switch]$SkipDesktopLauncher,

    [switch]$SkipAggregate,

    [switch]$KeepRemoteStage,

    [switch]$FailOnEvidenceIssue,

    [switch]$OutputJson
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function ConvertTo-RevAgentSingleQuotedLiteral {
    param([string]$Value)

    return "'" + ([string]$Value).Replace("'", "''") + "'"
}

function ConvertTo-RevAgentSafePathSegment {
    param(
        [string]$Value,
        [string]$Fallback = "unknown"
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $Fallback
    }

    $safe = [string]$Value
    foreach ($invalid in [System.IO.Path]::GetInvalidFileNameChars()) {
        $safe = $safe.Replace([string]$invalid, "_")
    }
    $safe = [System.Text.RegularExpressions.Regex]::Replace($safe, "\s+", "_").Trim("._-")
    if ([string]::IsNullOrWhiteSpace($safe)) {
        return $Fallback
    }
    return $safe
}

function Get-RevAgentValue {
    param(
        [object]$Object,
        [string[]]$Names
    )

    if ($null -eq $Object) {
        return ""
    }
    foreach ($name in $Names) {
        if ($Object -is [System.Collections.IDictionary]) {
            if ($Object.Contains($name) -and -not [string]::IsNullOrWhiteSpace([string]$Object[$name])) {
                return [string]$Object[$name]
            }
        }
        else {
            $property = $Object.PSObject.Properties[$name]
            if ($null -ne $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
                return [string]$property.Value
            }
        }
    }
    return ""
}

function Read-RevAgentTargets {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "TargetsPath is required. Provide a JSON file with computer/user/host entries."
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Targets file was not found: $Path"
    }

    $raw = Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
    $items = @()
    if ($raw -is [array]) {
        $items = @($raw)
    }
    elseif ($null -ne $raw.PSObject.Properties["targets"]) {
        $items = @($raw.targets)
    }
    elseif ($null -ne $raw.PSObject.Properties["fleet"]) {
        $items = @($raw.fleet)
    }
    elseif ($null -ne $raw.PSObject.Properties["machines"]) {
        $items = @($raw.machines)
    }
    else {
        throw "Targets file must be a JSON array or contain targets, fleet, or machines."
    }

    $targets = [System.Collections.Generic.List[object]]::new()
    foreach ($item in $items) {
        $computerName = Get-RevAgentValue -Object $item -Names @("computer", "computerName", "machine", "machineName", "name")
        $userName = Get-RevAgentValue -Object $item -Names @("user", "userName", "sshUser")
        $hostName = Get-RevAgentValue -Object $item -Names @("host", "hostName", "address", "ip")
        $excludeText = Get-RevAgentValue -Object $item -Names @("excluded", "outOfScope", "disabled")
        $isExcluded = [string]::Equals($excludeText, "true", [System.StringComparison]::OrdinalIgnoreCase)

        if ($isExcluded) {
            continue
        }
        if ([string]::IsNullOrWhiteSpace($computerName)) {
            throw "A target is missing computer/name."
        }
        if ([string]::IsNullOrWhiteSpace($userName)) {
            throw "Target '$computerName' is missing user/userName."
        }
        if ([string]::IsNullOrWhiteSpace($hostName)) {
            $hostName = $computerName
        }

        [void]$targets.Add([pscustomobject]@{
                Computer = $computerName
                User = $userName
                Host = $hostName
            })
    }

    return @($targets.ToArray())
}

function Join-RevAgentNativeArguments {
    param([string[]]$Arguments)

    $parts = [System.Collections.Generic.List[string]]::new()
    foreach ($argument in $Arguments) {
        $value = [string]$argument
        if ($value -match '[\s"]') {
            [void]$parts.Add('"' + ($value -replace '"', '\"') + '"')
        }
        else {
            [void]$parts.Add($value)
        }
    }
    return ($parts.ToArray() -join " ")
}

function Invoke-RevAgentNativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 60
    )

    $process = $null
    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $FilePath
        $startInfo.Arguments = Join-RevAgentNativeArguments -Arguments $Arguments
        $startInfo.UseShellExecute = $false
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.CreateNoWindow = $true

        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $completed = $process.WaitForExit([Math]::Max(1, $TimeoutSec) * 1000)
        if (-not $completed) {
            try { $process.Kill() } catch {}
            return [pscustomobject]@{
                Code = 124
                TimedOut = $true
                Out = @("Timed out after $TimeoutSec second(s): $FilePath")
            }
        }
        $process.WaitForExit()
        $output = @()
        if ($stdoutTask.Result) {
            $output += @($stdoutTask.Result -split "\r?\n" | Where-Object { $_ -ne "" })
        }
        if ($stderrTask.Result) {
            $output += @($stderrTask.Result -split "\r?\n" | Where-Object { $_ -ne "" })
        }
        return [pscustomobject]@{
            Code = $process.ExitCode
            TimedOut = $false
            Out = @($output)
        }
    }
    finally {
        if ($process) {
            $process.Dispose()
        }
    }
}

function New-RevAgentEvidenceBundle {
    param(
        [string]$ReleaseRootPath,
        [string]$RepositoryRoot
    )

    $toolsRoot = Join-Path $ReleaseRootPath "tools"
    $migrationSource = Join-Path $toolsRoot "migrate-source-free-install.ps1"
    $launcherSource = Join-Path $toolsRoot "publish-desktop-launcher-evidence.ps1"
    if (-not (Test-Path -LiteralPath $migrationSource -PathType Leaf)) {
        throw "Source-free migration helper was not found in NAS tools: $migrationSource"
    }
    if (-not (Test-Path -LiteralPath $launcherSource -PathType Leaf)) {
        $launcherSource = Join-Path $RepositoryRoot "scripts\publish-desktop-launcher-evidence.ps1"
    }
    if (-not (Test-Path -LiteralPath $launcherSource -PathType Leaf)) {
        throw "Desktop launcher evidence helper was not found in NAS tools or repo scripts."
    }

    $libSource = Join-Path $toolsRoot "lib"
    if (-not (Test-Path -LiteralPath $libSource -PathType Container)) {
        throw "NAS tools lib folder was not found: $libSource"
    }

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-rollout-evidence-" + [guid]::NewGuid().ToString("N"))
    $bundleRoot = Join-Path $tempRoot "bundle"
    New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
    Copy-Item -LiteralPath $migrationSource -Destination (Join-Path $bundleRoot "migrate-source-free-install.ps1") -Force
    Copy-Item -LiteralPath $launcherSource -Destination (Join-Path $bundleRoot "publish-desktop-launcher-evidence.ps1") -Force
    Copy-Item -LiteralPath $libSource -Destination (Join-Path $bundleRoot "lib") -Recurse -Force

    $bundleZip = Join-Path $tempRoot "revagent-rollout-evidence-tools.zip"
    Compress-Archive -Path (Join-Path $bundleRoot "*") -DestinationPath $bundleZip -Force
    return [pscustomobject]@{
        Root = $tempRoot
        Zip = $bundleZip
        LauncherSource = $launcherSource
        MigrationSource = $migrationSource
    }
}

function Publish-RevAgentCentralEvidenceFile {
    param(
        [Parameter(Mandatory = $true)][string]$ReportsRootPath,
        [Parameter(Mandatory = $true)][string]$MachineName,
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$LatestFileName,
        [Parameter(Mandatory = $true)][string]$HistoryPrefix
    )

    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        throw "Evidence file was not retrieved: $SourcePath"
    }

    $json = Get-Content -Raw -LiteralPath $SourcePath -Encoding UTF8
    try {
        $null = $json | ConvertFrom-Json
    }
    catch {
        throw "Evidence file is not valid JSON: $SourcePath. $($_.Exception.Message)"
    }

    $safeMachine = ConvertTo-RevAgentSafePathSegment -Value $MachineName -Fallback "unknown"
    $machineRoot = Join-Path (Join-Path $ReportsRootPath "machines") $safeMachine
    New-Item -ItemType Directory -Path $machineRoot -Force | Out-Null

    $latestPath = Join-Path $machineRoot $LatestFileName
    $historyPath = Join-Path $machineRoot ("{0}-{1}.json" -f $HistoryPrefix, (Get-Date -Format "yyyyMMdd-HHmmss"))
    Set-Content -LiteralPath $latestPath -Value $json -Encoding UTF8
    Set-Content -LiteralPath $historyPath -Value $json -Encoding UTF8

    return [pscustomobject]@{
        LatestPath = $latestPath
        HistoryPath = $historyPath
    }
}

function Copy-RevAgentRemoteEvidenceFile {
    param(
        [Parameter(Mandatory = $true)][string]$SshTarget,
        [Parameter(Mandatory = $true)][string[]]$SshOptions,
        [Parameter(Mandatory = $true)][string]$RemotePath,
        [Parameter(Mandatory = $true)][string]$LocalPath,
        [int]$TimeoutSec = 120
    )

    $directory = Split-Path -Parent $LocalPath
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $remoteScpPath = $RemotePath -replace '\\', '/'
    $scp = Invoke-RevAgentNativeCommand -FilePath "scp.exe" -Arguments ($SshOptions + @(("{0}:{1}" -f $SshTarget, $remoteScpPath), $LocalPath)) -TimeoutSec $TimeoutSec
    if ($scp.Code -ne 0) {
        throw "remote evidence copy failed: $($scp.Out -join ' ')"
    }
}

function Invoke-RevAgentRemoteEvidence {
    param(
        [object]$Target,
        [string]$BundleZip,
        [string[]]$SshOptions,
        [string]$ReportsRootPath,
        [string]$RemoteStagePath,
        [string]$InstallRootPath,
        [int]$TimeoutSec,
        [bool]$RunSourceFree,
        [bool]$RunLauncherScan,
        [bool]$KeepStage
    )

    $sshTarget = "{0}@{1}" -f $Target.User, $Target.Host
    $safeComputer = ConvertTo-RevAgentSafePathSegment -Value $Target.Computer -Fallback "machine"
    $remoteZipPath = Join-Path $RemoteStagePath ("evidence-tools-{0}.zip" -f $safeComputer)
    $remoteSourceFreeReportPath = Join-Path $RemoteStagePath "source-free-migration-dryrun.json"
    $remoteDesktopLauncherReportPath = Join-Path $RemoteStagePath "desktop-launcher-scan.json"
    $remoteZipScpPath = $remoteZipPath -replace '\\', '/'
    $remoteStageLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $RemoteStagePath
    $remoteZipLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $remoteZipPath
    $remoteSourceFreeReportLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $remoteSourceFreeReportPath
    $remoteDesktopLauncherReportLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $remoteDesktopLauncherReportPath
    $installRootLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $InstallRootPath
    $machineLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $Target.Computer
    $runSourceFreeText = if ($RunSourceFree) { '$true' } else { '$false' }
    $runLauncherScanText = if ($RunLauncherScan) { '$true' } else { '$false' }
    $keepStageText = if ($KeepStage) { '$true' } else { '$false' }

    $mkdirScript = "New-Item -ItemType Directory -Path $remoteStageLiteral -Force | Out-Null"
    $mkdirEnc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($mkdirScript))
    $mkdir = Invoke-RevAgentNativeCommand -FilePath "ssh.exe" -Arguments ($SshOptions + @($sshTarget, "powershell -NoProfile -EncodedCommand $mkdirEnc")) -TimeoutSec 60
    if ($mkdir.Code -ne 0) {
        return [pscustomobject]@{
            Computer = $Target.Computer
            User = $Target.User
            Host = $Target.Host
            Success = $false
            SourceFree = "not-run"
            DesktopLauncher = "not-run"
            Detail = "remote stage directory failed: $($mkdir.Out -join ' ')"
        }
    }

    $scp = Invoke-RevAgentNativeCommand -FilePath "scp.exe" -Arguments ($SshOptions + @($BundleZip, ("{0}:{1}" -f $sshTarget, $remoteZipScpPath))) -TimeoutSec 300
    if ($scp.Code -ne 0) {
        return [pscustomobject]@{
            Computer = $Target.Computer
            User = $Target.User
            Host = $Target.Host
            Success = $false
            SourceFree = "not-run"
            DesktopLauncher = "not-run"
            Detail = "tool bundle copy failed: $($scp.Out -join ' ')"
        }
    }

    $remoteScript = @"
`$ErrorActionPreference = 'Stop'
Set-ExecutionPolicy -Scope Process Bypass -Force -ErrorAction SilentlyContinue
`$stage = $remoteStageLiteral
`$zip = $remoteZipLiteral
`$sourceFreeReportPath = $remoteSourceFreeReportLiteral
`$desktopLauncherReportPath = $remoteDesktopLauncherReportLiteral
`$installRoot = $installRootLiteral
`$machine = $machineLiteral
`$runSourceFree = $runSourceFreeText
`$runLauncherScan = $runLauncherScanText
`$keepStage = $keepStageText
`$tools = Join-Path `$stage 'tools'
if (Test-Path -LiteralPath `$tools) {
    Remove-Item -LiteralPath `$tools -Recurse -Force
}
New-Item -ItemType Directory -Path `$tools -Force | Out-Null
Expand-Archive -LiteralPath `$zip -DestinationPath `$tools -Force
Get-ChildItem -LiteralPath `$tools -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
`$migrationState = 'skipped'
`$launcherState = 'skipped'
if (`$runSourceFree) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path `$tools 'migrate-source-free-install.ps1') `
        -Mode dryRun `
        -InstallRoot `$installRoot `
        -WorkRoot (Join-Path `$installRoot 'updater') `
        -PackageTarget (Join-Path `$installRoot 'package') `
        -ServerTarget (Join-Path `$installRoot 'runtime') `
        -ReportPath `$sourceFreeReportPath `
        -NoNotifyUser
    if (`$LASTEXITCODE -ne 0) {
        throw "source-free dry-run exited with code `$LASTEXITCODE"
    }
    `$migrationState = 'ok'
}
if (`$runLauncherScan) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path `$tools 'publish-desktop-launcher-evidence.ps1') `
        -Mode ScanLocal `
        -OutputPath `$desktopLauncherReportPath `
        -MachineName `$machine | Out-Null
    if (`$LASTEXITCODE -ne 0) {
        throw "desktop launcher scan exited with code `$LASTEXITCODE"
    }
    `$launcherState = 'ok'
}
if (-not `$keepStage) {
    Remove-Item -LiteralPath `$tools -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath `$zip -Force -ErrorAction SilentlyContinue
}
Write-Output ('SOURCE_FREE=' + `$migrationState)
Write-Output ('DESKTOP_LAUNCHER=' + `$launcherState)
"@
    $remoteEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteScript))
    $aliveCount = [int][Math]::Ceiling($TimeoutSec / 30.0)
    $remote = Invoke-RevAgentNativeCommand -FilePath "ssh.exe" -Arguments ($SshOptions + @("-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=$aliveCount", $sshTarget, "powershell -NoProfile -EncodedCommand $remoteEncoded")) -TimeoutSec $TimeoutSec

    $sourceFreeState = "unknown"
    $launcherState = "unknown"
    foreach ($line in $remote.Out) {
        if ($line -match '^SOURCE_FREE=(.+)$') {
            $sourceFreeState = $Matches[1]
        }
        elseif ($line -match '^DESKTOP_LAUNCHER=(.+)$') {
            $launcherState = $Matches[1]
        }
    }

    $localEvidenceRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-rollout-evidence-result-" + [guid]::NewGuid().ToString("N"))
    $sourceFreeEvidence = $null
    $desktopLauncherEvidence = $null
    $copyErrors = [System.Collections.Generic.List[string]]::new()
    $stateErrors = [System.Collections.Generic.List[string]]::new()
    if ($remote.Code -eq 0 -and $RunSourceFree -and $sourceFreeState -ne "ok") {
        [void]$stateErrors.Add("source-free evidence state was '$sourceFreeState'")
    }
    if ($remote.Code -eq 0 -and $RunLauncherScan -and $launcherState -ne "ok") {
        [void]$stateErrors.Add("desktop launcher evidence state was '$launcherState'")
    }
    try {
        if ($remote.Code -eq 0 -and $RunSourceFree -and $sourceFreeState -eq "ok") {
            $localSourceFreeReportPath = Join-Path $localEvidenceRoot ("{0}-source-free-migration.json" -f $safeComputer)
            try {
                Copy-RevAgentRemoteEvidenceFile -SshTarget $sshTarget -SshOptions $SshOptions -RemotePath $remoteSourceFreeReportPath -LocalPath $localSourceFreeReportPath -TimeoutSec 120
                $sourceFreeEvidence = Publish-RevAgentCentralEvidenceFile `
                    -ReportsRootPath $ReportsRootPath `
                    -MachineName $Target.Computer `
                    -SourcePath $localSourceFreeReportPath `
                    -LatestFileName "source-free-migration-latest.json" `
                    -HistoryPrefix "source-free-migration"
            }
            catch {
                [void]$copyErrors.Add("source-free evidence publish failed: $($_.Exception.Message)")
            }
        }
        if ($remote.Code -eq 0 -and $RunLauncherScan -and $launcherState -eq "ok") {
            $localDesktopLauncherReportPath = Join-Path $localEvidenceRoot ("{0}-desktop-launcher.json" -f $safeComputer)
            try {
                Copy-RevAgentRemoteEvidenceFile -SshTarget $sshTarget -SshOptions $SshOptions -RemotePath $remoteDesktopLauncherReportPath -LocalPath $localDesktopLauncherReportPath -TimeoutSec 120
                $desktopLauncherEvidence = Publish-RevAgentCentralEvidenceFile `
                    -ReportsRootPath $ReportsRootPath `
                    -MachineName $Target.Computer `
                    -SourcePath $localDesktopLauncherReportPath `
                    -LatestFileName "desktop-launcher-latest.json" `
                    -HistoryPrefix "desktop-launcher"
            }
            catch {
                [void]$copyErrors.Add("desktop launcher evidence publish failed: $($_.Exception.Message)")
            }
        }
    }
    finally {
        if (Test-Path -LiteralPath $localEvidenceRoot -PathType Container) {
            Remove-Item -LiteralPath $localEvidenceRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    $success = ($remote.Code -eq 0 -and $copyErrors.Count -eq 0 -and $stateErrors.Count -eq 0)
    $detailParts = [System.Collections.Generic.List[string]]::new()
    if ($remote.Code -ne 0) {
        [void]$detailParts.Add(($remote.Out -join " | "))
    }
    foreach ($errorText in $stateErrors) {
        [void]$detailParts.Add($errorText)
    }
    foreach ($errorText in $copyErrors) {
        [void]$detailParts.Add($errorText)
    }

    return [pscustomobject]@{
        Computer = $Target.Computer
        User = $Target.User
        Host = $Target.Host
        Success = $success
        SourceFree = $sourceFreeState
        DesktopLauncher = $launcherState
        SourceFreeEvidencePath = if ($null -ne $sourceFreeEvidence) { $sourceFreeEvidence.LatestPath } else { "" }
        DesktopLauncherEvidencePath = if ($null -ne $desktopLauncherEvidence) { $desktopLauncherEvidence.LatestPath } else { "" }
        Detail = ($detailParts.ToArray() -join " | ")
    }
}

if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
    $ReportsRoot = Join-Path $ReleaseRoot "reports"
}

$targets = @(Read-RevAgentTargets -Path $TargetsPath)
if ($Computer.Count -gt 0) {
    $wanted = @($Computer | ForEach-Object { ([string]$_).ToUpperInvariant() })
    $targets = @($targets | Where-Object { $wanted -contains ([string]$_.Computer).ToUpperInvariant() })
}
if ($targets.Count -eq 0) {
    throw "No rollout evidence targets matched the request."
}

if ($ListOnly) {
    $targets | Format-Table -AutoSize
    return
}

$sshOptions = @(
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ConnectionAttempts=1",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=NUL",
    "-i", $Key
)

$bundle = $null
$results = @()
try {
    $bundle = New-RevAgentEvidenceBundle -ReleaseRootPath $ReleaseRoot -RepositoryRoot $repoRoot
    foreach ($target in $targets) {
        Write-Host ("Collecting evidence: {0}" -f $target.Computer)
        $results += Invoke-RevAgentRemoteEvidence `
            -Target $target `
            -BundleZip $bundle.Zip `
            -SshOptions $sshOptions `
            -ReportsRootPath $ReportsRoot `
            -RemoteStagePath $RemoteStage `
            -InstallRootPath $InstallRoot `
            -TimeoutSec $SshTimeoutSec `
            -RunSourceFree:(-not $SkipSourceFree) `
            -RunLauncherScan:(-not $SkipDesktopLauncher) `
            -KeepStage:([bool]$KeepRemoteStage)
    }
}
finally {
    if ($null -ne $bundle -and (Test-Path -LiteralPath $bundle.Root -PathType Container)) {
        Remove-Item -LiteralPath $bundle.Root -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$aggregate = $null
if (-not $SkipDesktopLauncher -and -not $SkipAggregate) {
    $aggregateArgs = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", $bundle.LauncherSource,
        "-Mode", "Aggregate",
        "-ReportsRoot", $ReportsRoot,
        "-ExpectedMachines"
    ) + @($targets | ForEach-Object { [string]$_.Computer }) + @("-OutputJson")
    $aggregateJson = & powershell @aggregateArgs
    $aggregate = $aggregateJson | ConvertFrom-Json
}

$failedTargets = @($results | Where-Object { -not [bool]$_.Success })
$evidenceIssues = [System.Collections.Generic.List[string]]::new()
if ($failedTargets.Count -gt 0) {
    [void]$evidenceIssues.Add(("{0} target(s) failed SSH evidence collection." -f $failedTargets.Count))
}
if ($null -ne $aggregate -and -not [bool]$aggregate.passed) {
    [void]$evidenceIssues.Add("Desktop launcher aggregate is not passing.")
}

$summary = [pscustomobject][ordered]@{
    schemaVersion = "revagent.rolloutEvidenceCollection.v1"
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    releaseRoot = $ReleaseRoot
    reportsRoot = $ReportsRoot
    targetCount = $targets.Count
    failedTargetCount = $failedTargets.Count
    desktopLauncherAggregatePassed = if ($null -ne $aggregate) { [bool]$aggregate.passed } else { $null }
    issues = @($evidenceIssues.ToArray())
    results = @($results)
    desktopLauncherAggregate = $aggregate
}

if ($OutputJson) {
    $summary | ConvertTo-Json -Depth 20
}
else {
    $results | Format-Table -AutoSize
    if ($null -ne $aggregate) {
        Write-Host ("Desktop launcher aggregate passed: {0}; missing: {1}; failed: {2}; legacy launchers: {3}; legacy roots: {4}" -f $aggregate.passed, $aggregate.missingMachineCount, $aggregate.failedMachineCount, $aggregate.legacyLauncherCount, $aggregate.legacyRootReferenceCount)
    }
}

if ($failedTargets.Count -gt 0 -or ($FailOnEvidenceIssue -and $evidenceIssues.Count -gt 0)) {
    exit 2
}
