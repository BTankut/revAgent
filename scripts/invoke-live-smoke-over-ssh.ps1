<#
.SYNOPSIS
    Run the live Revit smoke helper on a workstation over SSH.

.DESCRIPTION
    This coordinator-side helper stages the current live commandset test helper
    on a target workstation, starts Revit 2022 with the standard sample model
    when needed, waits for the local revAgent bridge port, runs the live smoke
    helper, and writes stdout/stderr plus a compact invocation report under the
    canonical NAS reports root.

    It is intended for an explicitly selected representative rollout target.
#>

[CmdletBinding()]
param(
    [string]$TargetsPath = "C:\ProgramData\DPE\revAgentOps\fleet.json",

    [string]$Computer = "",

    [string]$User = "",

    [string]$HostName = "",

    [string]$Key = "$env:USERPROFILE\.ssh\office_admin_access",

    [string]$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy",

    [string]$RevitExePath = "C:\Program Files\Autodesk\Revit 2022\Revit.exe",

    [string]$SampleModelPath = "C:\Program Files\Autodesk\Revit 2022\Samples\rme_basic_sample_project.rvt",

    [string]$ExpectedModelName = "rme_basic_sample_project",

    [ValidateSet("InteractiveTask", "SshProcess")]
    [string]$LaunchMode = "InteractiveTask",

    [string]$LiveHelperPath = "",

    [string]$RemoteStage = "C:\ProgramData\DPE\revAgent-live-smoke-stage",

    [int]$Port = 8080,

    [int]$BridgeTimeoutSec = 420,

    [int]$SshTimeoutSec = 900,

    [switch]$NoStartRevit,

    [switch]$OpenOnly,

    # Retained only to give older operator commands a deterministic security
    # error. Loose NAS scripts are mutable transport data and are never an
    # execution source.
    [switch]$UseNasHelper,

    [switch]$KeepRemoteStage,

    [switch]$ListOnly,

    [switch]$OutputJson
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if ($UseNasHelper) {
    throw "-UseNasHelper is retired. Run this coordinator wrapper from a clean repository checkout (or an independently protected local coordinator copy); it stages the exact local helper over SCP and never executes a loose NAS tools script."
}

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

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @()
    }

    $raw = Get-Content -LiteralPath $Path -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @()
    }

    $json = $raw | ConvertFrom-Json
    $items = @()
    if ($json -is [array]) {
        $items = @($json)
    }
    else {
        foreach ($name in @("targets", "fleet", "machines")) {
            $value = $json.PSObject.Properties[$name].Value
            if ($null -ne $value) {
                $items = @($value)
                break
            }
        }
    }

    foreach ($item in $items) {
        $computerName = Get-RevAgentValue -Object $item -Names @("computer", "name", "machine")
        if ([string]::IsNullOrWhiteSpace($computerName)) {
            continue
        }
        $excluded = [string](Get-RevAgentValue -Object $item -Names @("excluded", "disabled"))
        if ($excluded -match '^(true|1|yes)$') {
            continue
        }
        [pscustomobject][ordered]@{
            Computer = $computerName
            User = Get-RevAgentValue -Object $item -Names @("user", "userName", "username")
            Host = Get-RevAgentValue -Object $item -Names @("host", "address", "ip")
        }
    }
}

function Invoke-RevAgentNativeCommand {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [int]$TimeoutSec
    )

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $FilePath
    $argumentListProperty = $psi.PSObject.Properties["ArgumentList"]
    if ($null -ne $argumentListProperty) {
        foreach ($argument in $Arguments) {
            [void]$psi.ArgumentList.Add($argument)
        }
    }
    else {
        $psi.Arguments = ConvertTo-RevAgentNativeArgumentString -Arguments $Arguments
    }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    [void]$process.Start()

    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit([Math]::Max(1, $TimeoutSec) * 1000)) {
        try { $process.Kill($true) } catch {}
        throw "$FilePath timed out after $TimeoutSec seconds."
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    [pscustomobject][ordered]@{
        ExitCode = $process.ExitCode
        Stdout = $stdout
        Stderr = $stderr
    }
}

function ConvertTo-RevAgentNativeArgumentString {
    param([string[]]$Arguments)

    $quoted = foreach ($argument in $Arguments) {
        if ($null -eq $argument) {
            '""'
            continue
        }
        $text = [string]$argument
        if ($text -notmatch '[\s"]' -and -not $text.EndsWith("\")) {
            $text
            continue
        }
        $escaped = [System.Text.RegularExpressions.Regex]::Replace($text, '(\\*)"', '$1$1\"')
        $escaped = [System.Text.RegularExpressions.Regex]::Replace($escaped, '(\\+)$', '$1$1')
        '"' + $escaped + '"'
    }

    return ($quoted -join " ")
}

if ([string]::IsNullOrWhiteSpace($LiveHelperPath)) {
    $LiveHelperPath = Join-Path $repoRoot "scripts\test-commandset-live.ps1"
}

$targets = @(Read-RevAgentTargets -Path $TargetsPath)
if ($ListOnly) {
    $targets | Format-Table -AutoSize
    return
}

if (-not $PSBoundParameters.ContainsKey("Computer") -or [string]::IsNullOrWhiteSpace($Computer)) {
    throw "A live workstation target is required. Provide -Computer explicitly; no implicit target is selected."
}

$target = @($targets | Where-Object { [string]::Equals($_.Computer, $Computer, [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1)
if ($target.Count -eq 0) {
    $target = @([pscustomobject][ordered]@{
        Computer = $Computer
        User = $User
        Host = $HostName
    })
}

$target = $target[0]
if (-not [string]::IsNullOrWhiteSpace($User)) {
    $target.User = $User
}
if (-not [string]::IsNullOrWhiteSpace($HostName)) {
    $target.Host = $HostName
}
if ([string]::IsNullOrWhiteSpace($target.User)) {
    throw "No SSH user is known for $Computer. Provide -User or add it to $TargetsPath."
}
if ([string]::IsNullOrWhiteSpace($target.Host)) {
    $target.Host = $target.Computer
}

if (-not $OpenOnly -and -not (Test-Path -LiteralPath $LiveHelperPath -PathType Leaf)) {
    throw "Live helper was not found: $LiveHelperPath"
}

$sshOptions = @("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new")
if (-not [string]::IsNullOrWhiteSpace($Key) -and (Test-Path -LiteralPath $Key -PathType Leaf)) {
    $sshOptions += @("-i", $Key)
}
$sshTarget = "{0}@{1}" -f $target.User, $target.Host
$remoteHelperPath = Join-Path $RemoteStage "test-commandset-live.ps1"
$remoteRunnerPath = Join-Path $RemoteStage "invoke-live-smoke-remote.ps1"

$stageLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $RemoteStage
$mkdirScript = "New-Item -ItemType Directory -Path $stageLiteral -Force | Out-Null"
$mkdirEncoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($mkdirScript))
$mkdir = Invoke-RevAgentNativeCommand -FilePath "ssh.exe" -Arguments ($sshOptions + @($sshTarget, "powershell -NoProfile -EncodedCommand $mkdirEncoded")) -TimeoutSec 60
if ($mkdir.ExitCode -ne 0) {
    throw "Failed to create remote stage on $($target.Computer): $($mkdir.Stderr)"
}

if (-not $OpenOnly) {
    $remoteScpPath = $remoteHelperPath -replace '\\', '/'
    $scp = Invoke-RevAgentNativeCommand -FilePath "scp.exe" -Arguments ($sshOptions + @($LiveHelperPath, ("{0}:{1}" -f $sshTarget, $remoteScpPath))) -TimeoutSec 120
    if ($scp.ExitCode -ne 0) {
        throw "Failed to copy live helper to $($target.Computer): $($scp.Stderr)"
    }
}

$releaseRootLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $ReleaseRoot
$revitExeLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $RevitExePath
$sampleModelLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $SampleModelPath
$expectedModelNameLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $ExpectedModelName
$launchModeLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $LaunchMode
$helperLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $remoteHelperPath
$machineLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $target.Computer
$remoteStageLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $RemoteStage
$noStartLiteral = if ($NoStartRevit) { '$true' } else { '$false' }
$openOnlyLiteral = if ($OpenOnly) { '$true' } else { '$false' }
$keepStageLiteral = if ($KeepRemoteStage) { '$true' } else { '$false' }
$portLiteral = [int]$Port
$bridgeTimeoutLiteral = [int]$BridgeTimeoutSec

$remoteScript = @"
`$ErrorActionPreference = 'Stop'
`$releaseRoot = $releaseRootLiteral
`$revitExePath = $revitExeLiteral
`$sampleModelPath = $sampleModelLiteral
`$expectedModelName = $expectedModelNameLiteral
`$launchMode = $launchModeLiteral
`$helperPath = $helperLiteral
`$machineName = $machineLiteral
`$remoteStage = $remoteStageLiteral
`$port = $portLiteral
`$bridgeTimeoutSec = $bridgeTimeoutLiteral
`$noStartRevit = $noStartLiteral
`$openOnly = $openOnlyLiteral
`$keepStage = $keepStageLiteral
`$startedAtUtc = (Get-Date).ToUniversalTime()
`$reportsRoot = Join-Path `$releaseRoot 'reports'
New-Item -ItemType Directory -Path `$remoteStage -Force | Out-Null
`$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
`$remoteLogPath = Join-Path `$remoteStage ("live-smoke-ssh-{0}.log" -f `$stamp)
`$remoteReportPath = Join-Path `$remoteStage 'live-smoke-ssh-report.json'
`$remoteSmokeEvidencePath = if (`$openOnly) { '' } else { Join-Path `$remoteStage 'live-smoke-latest.json' }

function Test-RevAgentTcpPort {
    param([int]`$Port)
    `$client = [System.Net.Sockets.TcpClient]::new()
    try {
        `$async = `$client.BeginConnect('127.0.0.1', `$Port, `$null, `$null)
        if (-not `$async.AsyncWaitHandle.WaitOne(1000, `$false)) {
            return `$false
        }
        `$client.EndConnect(`$async)
        return `$true
    }
    catch {
        return `$false
    }
    finally {
        try { `$client.Close() } catch {}
    }
}

function Start-RevAgentRevitWithSample {
    if (-not (Test-Path -LiteralPath `$revitExePath -PathType Leaf)) {
        throw "Revit executable was not found: `$revitExePath"
    }
    `$revitArgumentList = '"' + `$sampleModelPath + '"'
    if (`$launchMode -eq 'SshProcess') {
        Start-Process -FilePath `$revitExePath -ArgumentList `$revitArgumentList | Out-Null
        return [pscustomobject][ordered]@{
            method = 'ssh_process'
            taskName = ''
            command = `$revitArgumentList
            exitCode = 0
        }
    }

    `$taskName = 'revAgent_LiveSmoke_Revit_' + [Guid]::NewGuid().ToString('N')
    `$launcherPath = Join-Path `$remoteStage ('launch-revit-sample-' + [Guid]::NewGuid().ToString('N') + '.cmd')
    `$launcherText = '@echo off' + [Environment]::NewLine + 'start "" "' + `$revitExePath + '" "' + `$sampleModelPath + '"' + [Environment]::NewLine
    [System.IO.File]::WriteAllText(`$launcherPath, `$launcherText, [System.Text.Encoding]::ASCII)
    `$taskCommand = `$launcherPath
    `$taskTime = (Get-Date).AddMinutes(5).ToString('HH:mm')
    `$createOutput = & schtasks.exe /Create /TN `$taskName /TR `$taskCommand /SC ONCE /ST `$taskTime /F /IT 2>&1
    `$createExitCode = if (`$null -ne `$LASTEXITCODE) { [int]`$LASTEXITCODE } else { 0 }
    if (`$createExitCode -ne 0) {
        throw "Failed to create interactive Revit launch task '`$taskName': `$((`$createOutput | ForEach-Object { [string]`$_ }) -join ' ')"
    }

    try {
        `$runOutput = & schtasks.exe /Run /TN `$taskName 2>&1
        `$runExitCode = if (`$null -ne `$LASTEXITCODE) { [int]`$LASTEXITCODE } else { 0 }
        if (`$runExitCode -ne 0) {
            throw "Failed to run interactive Revit launch task '`$taskName': `$((`$runOutput | ForEach-Object { [string]`$_ }) -join ' ')"
        }
        return [pscustomobject][ordered]@{
            method = 'interactive_task'
            taskName = `$taskName
            command = `$taskCommand
            launcherPath = `$launcherPath
            scheduledTime = `$taskTime
            exitCode = `$runExitCode
        }
    }
    finally {
        & schtasks.exe /Delete /TN `$taskName /F *> `$null
    }
}

function Assert-RevAgentRemoteTrue {
    param(
        [bool]`$Condition,
        [string]`$Message
    )

    if (-not `$Condition) {
        throw `$Message
    }
}

function Read-RevAgentExactBytes {
    param(
        [System.IO.Stream]`$Stream,
        [int]`$Count
    )

    `$buffer = New-Object byte[] `$Count
    `$offset = 0
    while (`$offset -lt `$Count) {
        `$read = `$Stream.Read(`$buffer, `$offset, `$Count - `$offset)
        if (`$read -le 0) {
            throw 'Socket closed while reading response.'
        }
        `$offset += `$read
    }
    return `$buffer
}

function ConvertFrom-RevAgentJsonLike {
    param(
        [object]`$Value,
        [int]`$Depth = 0
    )

    if (`$Depth -ge 4 -or -not (`$Value -is [string])) {
        return `$Value
    }

    `$text = `$Value.Trim()
    if ([string]::IsNullOrWhiteSpace(`$text)) {
        return `$Value
    }
    if (`$text -eq 'true') { return `$true }
    if (`$text -eq 'false') { return `$false }
    if (`$text -eq 'null') { return `$null }

    `$looksJsonLike = `$text.StartsWith('{') -or `$text.StartsWith('[') -or `$text.StartsWith('"')
    if (-not `$looksJsonLike) {
        return `$Value
    }

    try {
        `$parsed = `$text | ConvertFrom-Json
        if (`$parsed -is [string]) {
            return ConvertFrom-RevAgentJsonLike -Value `$parsed -Depth (`$Depth + 1)
        }
        return `$parsed
    }
    catch {
        return `$Value
    }
}

function Invoke-RevAgentBridgeRequest {
    param(
        [string]`$Method,
        [object]`$Params = @{}
    )

    `$client = [System.Net.Sockets.TcpClient]::new()
    `$client.ReceiveTimeout = 120000
    `$client.SendTimeout = 120000

    try {
        `$client.Connect('127.0.0.1', `$port)
        `$stream = `$client.GetStream()
        `$requestId = [Guid]::NewGuid().ToString('N')
        `$request = [ordered]@{
            jsonrpc = '2.0'
            method = `$Method
            params = `$Params
            id = `$requestId
        }
        `$json = `$request | ConvertTo-Json -Depth 30 -Compress
        `$payload = [System.Text.Encoding]::UTF8.GetBytes(`$json)
        `$header = [System.BitConverter]::GetBytes([uint32]`$payload.Length)
        if ([System.BitConverter]::IsLittleEndian) {
            [array]::Reverse(`$header)
        }
        `$stream.Write(`$header, 0, `$header.Length)
        `$stream.Write(`$payload, 0, `$payload.Length)
        `$stream.Flush()

        `$responseHeader = Read-RevAgentExactBytes -Stream `$stream -Count 4
        if ([System.BitConverter]::IsLittleEndian) {
            [array]::Reverse(`$responseHeader)
        }
        `$responseLength = [System.BitConverter]::ToUInt32(`$responseHeader, 0)
        Assert-RevAgentRemoteTrue (`$responseLength -gt 0 -and `$responseLength -le (32 * 1024 * 1024)) "Invalid response frame length: `$responseLength"

        `$responseBytes = Read-RevAgentExactBytes -Stream `$stream -Count ([int]`$responseLength)
        `$responseJson = [System.Text.Encoding]::UTF8.GetString(`$responseBytes)
        `$response = `$responseJson | ConvertFrom-Json
        if (`$response.error) {
            throw "revAgent request '`$Method' failed: `$(`$response.error.message)"
        }
        return `$response.result
    }
    finally {
        try { `$client.Close() } catch {}
    }
}

function Get-RevAgentBridgeStatus {
    return Invoke-RevAgentBridgeRequest -Method 'mcp_status' -Params @{}
}

function Assert-RevAgentBridgeReady {
    param([string]`$NextCommand)

    `$status = Get-RevAgentBridgeStatus
    if (`$status.activeTask) {
        `$taskName = `$status.activeTask.taskName
        if ([string]::IsNullOrWhiteSpace(`$taskName)) {
            `$taskName = `$status.activeTask.method
        }
        `$elapsedMs = `$status.activeTask.elapsedMs
        throw "revAgent is busy with '`$taskName' (`$elapsedMs ms). Wait before running '`$NextCommand'."
    }
    return `$status
}

function Invoke-RevAgentModelProbe {
    Assert-RevAgentBridgeReady -NextCommand 'sample model verification' | Out-Null
    `$code = @'
var activeView = document.ActiveView;
return Newtonsoft.Json.JsonConvert.SerializeObject(new {
    caseName = "sample_model_probe",
    title = document.Title,
    pathName = document.PathName,
    isFamilyDocument = document.IsFamilyDocument,
    isModifiable = document.IsModifiable,
    activeViewName = activeView == null ? "" : activeView.Name,
    activeViewId = activeView == null ? -1 : activeView.Id.IntegerValue,
    activeViewType = activeView == null ? "" : activeView.ViewType.ToString(),
    revitVersion = document.Application.VersionNumber,
    revitVersionName = document.Application.VersionName
});
'@
    `$params = [ordered]@{
        code = `$code
        parameters = @()
        transactionMode = 'none'
        taskName = 'revAgent live smoke sample model verification'
        parseJsonResult = `$true
    }
    `$probe = Invoke-RevAgentBridgeRequest -Method 'send_code_to_revit' -Params `$params
    if (`$null -eq `$probe) {
        throw 'Model verification returned no bridge result.'
    }
    if (-not [bool]`$probe.success) {
        throw "Model verification command failed: `$(`$probe.error)"
    }
    if ([bool]`$probe.guarded) {
        throw "Model verification command was guarded: `$(`$probe.guardReason)"
    }
    `$payload = ConvertFrom-RevAgentJsonLike -Value `$probe.result
    if (`$payload -is [string]) {
        throw "Model verification returned non-JSON payload: `$payload"
    }
    return `$payload
}

function Test-RevAgentExpectedModel {
    param([string]`$ExpectedModelName)

    `$payload = Invoke-RevAgentModelProbe
    `$title = [string]`$payload.title
    `$pathName = [string]`$payload.pathName
    `$activeViewName = [string]`$payload.activeViewName
    `$activeViewId = -1
    try { `$activeViewId = [int]`$payload.activeViewId } catch {}

    `$titleMatches = (-not [string]::IsNullOrWhiteSpace(`$title)) -and (`$title.IndexOf(`$ExpectedModelName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    `$pathMatches = (-not [string]::IsNullOrWhiteSpace(`$pathName)) -and (`$pathName.IndexOf(`$ExpectedModelName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    `$activeViewAvailable = (-not [string]::IsNullOrWhiteSpace(`$activeViewName)) -and (`$activeViewId -ne -1)
    `$matchesExpectedModel = `$titleMatches -or `$pathMatches

    return [pscustomobject][ordered]@{
        success = `$true
        ready = (`$matchesExpectedModel -and `$activeViewAvailable)
        expectedModelName = `$ExpectedModelName
        matchesExpectedModel = `$matchesExpectedModel
        titleMatches = `$titleMatches
        pathMatches = `$pathMatches
        activeViewAvailable = `$activeViewAvailable
        title = `$title
        pathName = `$pathName
        activeViewName = `$activeViewName
        activeViewId = `$activeViewId
        activeViewType = [string]`$payload.activeViewType
        revitVersion = [string]`$payload.revitVersion
        revitVersionName = [string]`$payload.revitVersionName
        isFamilyDocument = [bool]`$payload.isFamilyDocument
        isModifiable = [bool]`$payload.isModifiable
    }
}

function Wait-RevAgentExpectedModel {
    param(
        [string]`$ExpectedModelName,
        [int]`$TimeoutSec
    )

    `$deadline = (Get-Date).AddSeconds([Math]::Max(1, `$TimeoutSec))
    `$lastError = ''
    `$lastProbe = `$null
    while ((Get-Date) -lt `$deadline) {
        try {
            `$probe = Test-RevAgentExpectedModel -ExpectedModelName `$ExpectedModelName
            `$lastProbe = `$probe
            if ([bool]`$probe.ready) {
                return `$probe
            }
            `$lastError = "Active Revit document '`$(`$probe.title)' with active view '`$(`$probe.activeViewName)' did not match expected model '`$ExpectedModelName' or had no active view."
        }
        catch {
            `$lastError = `$_.Exception.Message
        }
        Start-Sleep -Seconds 3
    }

    if (`$null -ne `$lastProbe) {
        `$lastProbe | Add-Member -NotePropertyName ready -NotePropertyValue `$false -Force
        `$lastProbe | Add-Member -NotePropertyName lastError -NotePropertyValue `$lastError -Force
        return `$lastProbe
    }

    return [pscustomobject][ordered]@{
        success = `$false
        ready = `$false
        expectedModelName = `$ExpectedModelName
        matchesExpectedModel = `$false
        activeViewAvailable = `$false
        lastError = `$lastError
    }
}

`$startedRevit = `$false
`$launchEvents = @()
if (-not (Test-Path -LiteralPath `$sampleModelPath -PathType Leaf)) {
    throw "Sample model was not found: `$sampleModelPath"
}
if ((-not `$openOnly) -and (-not (Test-Path -LiteralPath `$helperPath -PathType Leaf))) {
    throw "Live helper was not found: `$helperPath"
}
if (-not (Test-RevAgentTcpPort -Port `$port)) {
    if (`$noStartRevit) {
        throw "revAgent bridge was not listening on localhost:`$port and -NoStartRevit was set."
    }
    `$launchEvents += Start-RevAgentRevitWithSample
    `$startedRevit = `$true
}

`$deadline = (Get-Date).AddSeconds(`$bridgeTimeoutSec)
while ((Get-Date) -lt `$deadline) {
    if (Test-RevAgentTcpPort -Port `$port) {
        break
    }
    Start-Sleep -Seconds 3
}
if (-not (Test-RevAgentTcpPort -Port `$port)) {
    throw "revAgent bridge did not become available on localhost:`$port within `$bridgeTimeoutSec seconds."
}

`$modelVerification = Wait-RevAgentExpectedModel -ExpectedModelName `$expectedModelName -TimeoutSec 12
if ((-not [bool]`$modelVerification.ready) -and (-not `$noStartRevit) -and (-not `$startedRevit)) {
    `$launchEvents += Start-RevAgentRevitWithSample
    `$startedRevit = `$true
    `$modelVerification = Wait-RevAgentExpectedModel -ExpectedModelName `$expectedModelName -TimeoutSec `$bridgeTimeoutSec
}
elseif (-not [bool]`$modelVerification.ready) {
    `$modelVerification = Wait-RevAgentExpectedModel -ExpectedModelName `$expectedModelName -TimeoutSec `$bridgeTimeoutSec
}
if (-not [bool]`$modelVerification.ready) {
    throw "Revit opened but expected model '`$expectedModelName' was not verified through revAgent. Last probe: `$(`$modelVerification | ConvertTo-Json -Depth 8 -Compress)"
}

if (`$openOnly) {
    `$output = @('Open/model verification passed.')
    `$exitCode = 0
}
else {
`$smokeNote = "`$machineName Revit 2022 sample-model live smoke passed"
`$cmd = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', `$helperPath,
    '-HostName', 'localhost',
    '-Port', [string]`$port,
    '-ReleaseRoot', `$releaseRoot,
    '-SmokeEvidencePath', `$remoteSmokeEvidencePath,
    '-SmokeNote', `$smokeNote
)
`$previousErrorActionPreference = `$ErrorActionPreference
`$ErrorActionPreference = 'Continue'
try {
    `$output = & powershell @cmd *>&1
    `$exitCode = if (`$null -ne `$LASTEXITCODE) { [int]`$LASTEXITCODE } else { 0 }
}
finally {
    `$ErrorActionPreference = `$previousErrorActionPreference
}
}
`$outputText = (`$output | ForEach-Object { [string]`$_ }) -join [Environment]::NewLine
`$outputText | Set-Content -LiteralPath `$remoteLogPath -Encoding UTF8
`$completedAtUtc = (Get-Date).ToUniversalTime()
`$report = [ordered]@{
    schemaVersion = 'revagent.liveSmokeSshInvocation.v1'
    machine = `$machineName
    passed = (`$exitCode -eq 0)
    exitCode = `$exitCode
    startedRevit = `$startedRevit
    launchMode = `$launchMode
    launchEvents = @(`$launchEvents)
    openOnly = `$openOnly
    modelVerified = [bool]`$modelVerification.ready
    modelVerification = `$modelVerification
    revitExePath = `$revitExePath
    sampleModelPath = `$sampleModelPath
    expectedModelName = `$expectedModelName
    helperPath = `$helperPath
    releaseRoot = `$releaseRoot
    port = `$port
    stamp = `$stamp
    startedAtUtc = `$startedAtUtc.ToString('o')
    completedAtUtc = `$completedAtUtc.ToString('o')
    remoteLogPath = `$remoteLogPath
    remoteReportPath = `$remoteReportPath
    remoteSmokeEvidencePath = `$remoteSmokeEvidencePath
    outputTail = @(`$output | Select-Object -Last 80 | ForEach-Object { [string]`$_ })
}
`$json = `$report | ConvertTo-Json -Depth 8 -Compress
[System.IO.File]::WriteAllText(`$remoteReportPath, `$json, [System.Text.UTF8Encoding]::new(`$false))
Write-Output `$json
if (`$exitCode -ne 0) {
    exit `$exitCode
}
"@

$localRunnerPath = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-live-smoke-remote-{0}.ps1" -f [Guid]::NewGuid().ToString("N"))
try {
    [System.IO.File]::WriteAllText($localRunnerPath, $remoteScript, [System.Text.UTF8Encoding]::new($false))
    $remoteRunnerScpPath = $remoteRunnerPath -replace '\\', '/'
    $scpRunner = Invoke-RevAgentNativeCommand -FilePath "scp.exe" -Arguments ($sshOptions + @($localRunnerPath, ("{0}:{1}" -f $sshTarget, $remoteRunnerScpPath))) -TimeoutSec 120
    if ($scpRunner.ExitCode -ne 0) {
        throw "Failed to copy remote live smoke runner to $($target.Computer): $($scpRunner.Stderr)"
    }
}
finally {
    if (Test-Path -LiteralPath $localRunnerPath) {
        Remove-Item -LiteralPath $localRunnerPath -Force -ErrorAction SilentlyContinue
    }
}

$remoteRunnerCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File $($remoteRunnerPath -replace '\\', '/')"
$remote = Invoke-RevAgentNativeCommand -FilePath "ssh.exe" -Arguments ($sshOptions + @("-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=20", $sshTarget, $remoteRunnerCommand)) -TimeoutSec $SshTimeoutSec

$remoteOutput = [string]$remote.Stdout
$remoteError = [string]$remote.Stderr
$result = $null
try {
    $jsonLine = @($remoteOutput -split "`r?`n" | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1)
    if ($jsonLine.Count -gt 0) {
        $result = $jsonLine[0] | ConvertFrom-Json
    }
}
catch {
    $result = $null
}

if ($null -ne $result) {
    $machineRoot = Join-Path (Join-Path (Join-Path $ReleaseRoot "reports") "machines") $target.Computer
    $logsRoot = Join-Path $machineRoot "logs"
    New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null

    $stamp = if (-not [string]::IsNullOrWhiteSpace([string]$result.stamp)) { [string]$result.stamp } else { Get-Date -Format "yyyyMMdd-HHmmss" }
    $centralLogPath = Join-Path $logsRoot ("live-smoke-ssh-{0}.log" -f $stamp)
    $centralLatestReportPath = Join-Path $machineRoot "live-smoke-ssh-latest.json"
    $centralHistoryReportPath = Join-Path $machineRoot ("live-smoke-ssh-{0}.json" -f $stamp)

    if (-not [string]::IsNullOrWhiteSpace([string]$result.remoteLogPath)) {
        $localLogPath = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-live-smoke-log-{0}.log" -f [Guid]::NewGuid().ToString("N"))
        try {
            $remoteLogScpPath = ([string]$result.remoteLogPath) -replace '\\', '/'
            $scpLog = Invoke-RevAgentNativeCommand -FilePath "scp.exe" -Arguments ($sshOptions + @(("{0}:{1}" -f $sshTarget, $remoteLogScpPath), $localLogPath)) -TimeoutSec 120
            if ($scpLog.ExitCode -eq 0 -and (Test-Path -LiteralPath $localLogPath -PathType Leaf)) {
                Copy-Item -LiteralPath $localLogPath -Destination $centralLogPath -Force
            }
        }
        finally {
            if (Test-Path -LiteralPath $localLogPath) {
                Remove-Item -LiteralPath $localLogPath -Force -ErrorAction SilentlyContinue
            }
        }
    }

    if ((-not [bool]$result.openOnly) -and -not [string]::IsNullOrWhiteSpace([string]$result.remoteSmokeEvidencePath)) {
        $localSmokePath = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-live-smoke-evidence-{0}.json" -f [Guid]::NewGuid().ToString("N"))
        try {
            $remoteSmokeScpPath = ([string]$result.remoteSmokeEvidencePath) -replace '\\', '/'
            $scpSmoke = Invoke-RevAgentNativeCommand -FilePath "scp.exe" -Arguments ($sshOptions + @(("{0}:{1}" -f $sshTarget, $remoteSmokeScpPath), $localSmokePath)) -TimeoutSec 120
            if ($scpSmoke.ExitCode -eq 0 -and (Test-Path -LiteralPath $localSmokePath -PathType Leaf)) {
                $stablePath = Join-Path (Join-Path $ReleaseRoot "channels") "stable.json"
                if (Test-Path -LiteralPath $stablePath -PathType Leaf) {
                    $stable = Get-Content -LiteralPath $stablePath -Raw | ConvertFrom-Json
                    $smokeEvidence = Get-Content -LiteralPath $localSmokePath -Raw | ConvertFrom-Json
                    if ([string]::IsNullOrWhiteSpace([string]$smokeEvidence.stableVersion)) {
                        $smokeEvidence | Add-Member -NotePropertyName stableVersion -NotePropertyValue ([string]$stable.version) -Force
                    }
                    if ([string]::IsNullOrWhiteSpace([string]$smokeEvidence.stableCommit)) {
                        $stableCommit = ""
                        if ($null -ne $stable.git) {
                            $stableCommit = [string]$stable.git.commit
                        }
                        $smokeEvidence | Add-Member -NotePropertyName stableCommit -NotePropertyValue $stableCommit -Force
                    }
                    $smokeJson = $smokeEvidence | ConvertTo-Json -Depth 10
                    [System.IO.File]::WriteAllText($localSmokePath, $smokeJson, [System.Text.UTF8Encoding]::new($false))
                }
                $rolloutRoot = Join-Path (Join-Path $ReleaseRoot "reports") "rollout"
                New-Item -ItemType Directory -Path $rolloutRoot -Force | Out-Null
                $centralSmokeLatestPath = Join-Path $rolloutRoot "live-smoke-latest.json"
                $centralSmokeHistoryPath = Join-Path $rolloutRoot ("live-smoke-{0}.json" -f $stamp)
                Copy-Item -LiteralPath $localSmokePath -Destination $centralSmokeLatestPath -Force
                Copy-Item -LiteralPath $localSmokePath -Destination $centralSmokeHistoryPath -Force
                $result | Add-Member -NotePropertyName smokeEvidencePath -NotePropertyValue $centralSmokeLatestPath -Force
            }
        }
        finally {
            if (Test-Path -LiteralPath $localSmokePath) {
                Remove-Item -LiteralPath $localSmokePath -Force -ErrorAction SilentlyContinue
            }
        }
    }

    $result | Add-Member -NotePropertyName logPath -NotePropertyValue $centralLogPath -Force
    $result | Add-Member -NotePropertyName reportPath -NotePropertyValue $centralLatestReportPath -Force
    $centralJson = $result | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($centralLatestReportPath, $centralJson, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($centralHistoryReportPath, $centralJson, [System.Text.UTF8Encoding]::new($false))

    if (-not $KeepRemoteStage) {
        $cleanupLiteral = ConvertTo-RevAgentSingleQuotedLiteral -Value $RemoteStage
        $cleanupScript = "Remove-Item -LiteralPath $cleanupLiteral -Recurse -Force -ErrorAction SilentlyContinue"
        $cleanupEncoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cleanupScript))
        [void](Invoke-RevAgentNativeCommand -FilePath "ssh.exe" -Arguments ($sshOptions + @($sshTarget, "powershell -NoProfile -EncodedCommand $cleanupEncoded")) -TimeoutSec 60)
    }
}

if ($OutputJson) {
    [ordered]@{
        computer = $target.Computer
        user = $target.User
        host = $target.Host
        sshExitCode = $remote.ExitCode
        result = $result
        stdout = $remote.Stdout
        stderr = $remote.Stderr
    } | ConvertTo-Json -Depth 10
}
else {
    if ($null -ne $result) {
        Write-Host ("Live smoke SSH passed: {0}" -f $result.passed)
        Write-Host ("Log: {0}" -f $result.logPath)
    }
    else {
        Write-Host $remoteOutput
    }
    if (-not [string]::IsNullOrWhiteSpace($remoteError)) {
        Write-Error $remoteError
    }
}

if ($remote.ExitCode -ne 0) {
    throw "Remote live smoke invocation failed on $($target.Computer) with exit code $($remote.ExitCode)."
}
