<#
.SYNOPSIS
    Exercise the live E2 stable-launcher chain for clean and stale bootstrap
    fixtures through real Windows PowerShell 5.1 child processes.
#>

[CmdletBinding()]
param([string]$RepoRoot = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Write-Utf8NoBom {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Text)
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function ConvertTo-SingleQuotedPowerShellLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Get-ProductionFunctionText {
    param(
        [Parameter(Mandatory = $true)][Management.Automation.Language.ScriptBlockAst]$Ast,
        [Parameter(Mandatory = $true)][string[]]$Names
    )

    $functions = @($Ast.FindAll({
                param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst]
            }, $true))
    $result = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $Names) {
        $match = @($functions | Where-Object { $_.Name -eq $name })
        Assert-True ($match.Count -eq 1) "Production refresh function was not found exactly once: $name"
        [void]$result.Add([string]$match[0].Extent.Text)
    }
    return [string]::Join(([Environment]::NewLine + [Environment]::NewLine), $result.ToArray())
}

$refreshSourcePath = Join-Path $RepoRoot 'installer\nas\Refresh-revAgent-LocalBootstrap-STABLE.ps1'
$stableLauncherSourcePath = Join-Path $RepoRoot 'installer\nas\revAgent Updater STABLE.cmd'
$refreshLauncherSourcePath = Join-Path $RepoRoot 'installer\nas\Refresh-revAgent-LocalBootstrap-STABLE.cmd'
$windowsPowerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'

$tokens = $null
$parseErrors = $null
$refreshAst = [Management.Automation.Language.Parser]::ParseFile($refreshSourcePath, [ref]$tokens, [ref]$parseErrors)
Assert-True (@($parseErrors).Count -eq 0) 'Production bootstrap refresh script did not parse.'
$productionFunctions = Get-ProductionFunctionText -Ast $refreshAst -Names @(
    'Get-RevAgentBootstrapExitMessage',
    'Start-RevAgentPostRefreshLauncher',
    'Invoke-RevAgentBootstrapRefreshMain'
)

$componentTargets = [ordered]@{
    bootstrap = 'Start-revAgent-Update.ps1'
    launcher = 'Start-revAgent-Update.cmd'
    updaterGui = 'Install-revAgent-Updater-GUI.ps1'
    distributionIntegrity = 'RevAgent.DistributionIntegrity.psm1'
    permissions = 'RevAgent.Permissions.psm1'
    sourceFreeMigration = 'RevAgent.SourceFreeMigration.psm1'
    releaseSnapshot = 'RevAgent.ReleaseSnapshot.psm1'
    privilegedSnapshotUpdate = 'Invoke-revAgent-PrivilegedSnapshotUpdate.ps1'
}
Assert-True ($componentTargets.Count -eq 8) 'The clean-install fixture must bind exactly eight bootstrap components.'

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('revagent-e2-clean-install-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixtureRoot)

try {
    foreach ($scenario in @('clean', 'stale')) {
        Write-Host "Execute E2 stable launcher fixture: $scenario"
        $scenarioRoot = Join-Path $fixtureRoot $scenario
        $releaseRoot = Join-Path $scenarioRoot 'release'
        $toolsRoot = Join-Path $releaseRoot 'tools'
        $payloadRoot = Join-Path $toolsRoot 'fixture-payload'
        $programDataRoot = Join-Path $scenarioRoot 'programdata'
        $localAppDataRoot = Join-Path $scenarioRoot 'localappdata'
        $bootstrapRoot = Join-Path $programDataRoot 'DPE\revAgent\bootstrap'
        $requestsRoot = Join-Path $programDataRoot 'DPE\revAgent\trust\broker\requests'
        $resultsRoot = Join-Path $programDataRoot 'DPE\revAgent\trust\broker\results'
        $eventLogPath = Join-Path $scenarioRoot 'events.log'
        $postRefreshLogPath = Join-Path $scenarioRoot 'post-refresh.log'
        $brokerPath = Join-Path $programDataRoot 'DPE\revAgent\trust\Invoke-RevAgent-BootstrapTrustBroker.ps1'
        $stableLauncherPath = Join-Path $scenarioRoot 'revAgent Updater STABLE.cmd'
        $refreshLauncherPath = Join-Path $toolsRoot 'Refresh-revAgent-LocalBootstrap-STABLE.cmd'
        $fixtureRefreshPath = Join-Path $toolsRoot 'Refresh-revAgent-LocalBootstrap-STABLE.ps1'
        $channelPath = Join-Path $releaseRoot 'channels\stable.json'
        $expectedMarker = 'revagent-e2-' + $scenario + '-' + [Guid]::NewGuid().ToString('N')

        foreach ($directory in @($payloadRoot, $bootstrapRoot, $requestsRoot, $resultsRoot, (Split-Path -Parent $channelPath))) {
            [void][IO.Directory]::CreateDirectory($directory)
        }
        Write-Utf8NoBom -Path $channelPath -Text '{"channel":"stable","fixture":true}'

        foreach ($entry in $componentTargets.GetEnumerator()) {
            $payloadPath = Join-Path $payloadRoot ([string]$entry.Value)
            if ([string]$entry.Key -eq 'bootstrap') {
                $payloadText = @"
param([string]`$ChannelManifestPath, [switch]`$VerificationOnly)
# $expectedMarker
exit 0
"@
            }
            elseif ([string]$entry.Key -eq 'launcher') {
                $checks = [System.Collections.Generic.List[string]]::new()
                foreach ($target in $componentTargets.Values) {
                    [void]$checks.Add(('findstr /l /c:"{0}" "%~dp0{1}" >nul || exit /b 91' -f $expectedMarker, [string]$target))
                }
                $payloadText = [string]::Join([Environment]::NewLine, @(
                        '@echo off',
                        ('rem ' + $expectedMarker),
                        'if /i not "%~1"=="--post-refresh" exit /b 90',
                        $checks.ToArray(),
                        ('>>"{0}" echo post-refresh' -f $eventLogPath),
                        ('>>"{0}" echo post-refresh' -f $postRefreshLogPath),
                        'exit /b 0'
                    ))
            }
            else {
                $payloadText = "# $expectedMarker`r`n"
            }
            Write-Utf8NoBom -Path $payloadPath -Text $payloadText
        }

        if ($scenario -eq 'stale') {
            foreach ($entry in $componentTargets.GetEnumerator()) {
                $targetPath = Join-Path $bootstrapRoot ([string]$entry.Value)
                if ([string]$entry.Key -eq 'bootstrap') {
                    Write-Utf8NoBom -Path $targetPath -Text "param([string]`$ChannelManifestPath, [switch]`$VerificationOnly)`r`n# stale-component`r`nexit 1`r`n"
                }
                elseif ([string]$entry.Key -eq 'launcher') {
                    Write-Utf8NoBom -Path $targetPath -Text "@echo off`r`nrem stale-component`r`nexit /b 92`r`n"
                }
                else {
                    Write-Utf8NoBom -Path $targetPath -Text "# stale-component`r`n"
                }
            }
            Write-Utf8NoBom -Path (Join-Path $bootstrapRoot 'bootstrap-state.json') -Text '{"stale":true}'
        }
        else {
            Remove-Item -LiteralPath $bootstrapRoot -Recurse -Force
        }

        $brokerTemplate = @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$requestsRoot = __REQUESTS_ROOT__
$resultsRoot = __RESULTS_ROOT__
$localAppDataRoot = __LOCAL_APP_DATA_ROOT__
$bootstrapRoot = __BOOTSTRAP_ROOT__
$eventLogPath = __EVENT_LOG__
[IO.File]::AppendAllText($eventLogPath, 'broker' + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$requests = @([IO.Directory]::GetFiles($requestsRoot, '*.json'))
if ($requests.Count -ne 1) { throw "Mock SYSTEM broker expected one exact request; found $($requests.Count)." }
$request = [IO.File]::ReadAllText($requests[0]) | ConvertFrom-Json
$inboxRoot = Join-Path $localAppDataRoot ('DPE\revAgent\release-inbox\' + [string]$request.inboxId)
if (-not [IO.Directory]::Exists($inboxRoot)) { throw "Authenticated inbox is missing: $inboxRoot" }
[void][IO.Directory]::CreateDirectory($bootstrapRoot)
$targets = @(
    'Start-revAgent-Update.ps1',
    'Start-revAgent-Update.cmd',
    'Install-revAgent-Updater-GUI.ps1',
    'RevAgent.DistributionIntegrity.psm1',
    'RevAgent.Permissions.psm1',
    'RevAgent.SourceFreeMigration.psm1',
    'RevAgent.ReleaseSnapshot.psm1',
    'Invoke-revAgent-PrivilegedSnapshotUpdate.ps1'
)
foreach ($target in $targets) {
    [IO.File]::Copy((Join-Path $inboxRoot $target), (Join-Path $bootstrapRoot $target), $true)
}
[IO.File]::WriteAllText((Join-Path $bootstrapRoot 'bootstrap-state.json'), '{"fixture":"broker-installed"}', [Text.UTF8Encoding]::new($false))
$result = [ordered]@{
    inboxId = [string]$request.inboxId
    nonce = [string]$request.nonce
    state = 'succeeded'
    exitCode = 0
    message = 'Mock SYSTEM trust broker installed the protected bootstrap.'
    releaseSequence = 100
}
$resultPath = Join-Path $resultsRoot (([string]$request.nonce) + '.json')
[IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
'@
        $brokerText = $brokerTemplate
        $brokerText = $brokerText.Replace('__REQUESTS_ROOT__', (ConvertTo-SingleQuotedPowerShellLiteral $requestsRoot))
        $brokerText = $brokerText.Replace('__RESULTS_ROOT__', (ConvertTo-SingleQuotedPowerShellLiteral $resultsRoot))
        $brokerText = $brokerText.Replace('__LOCAL_APP_DATA_ROOT__', (ConvertTo-SingleQuotedPowerShellLiteral $localAppDataRoot))
        $brokerText = $brokerText.Replace('__BOOTSTRAP_ROOT__', (ConvertTo-SingleQuotedPowerShellLiteral $bootstrapRoot))
        $brokerText = $brokerText.Replace('__EVENT_LOG__', (ConvertTo-SingleQuotedPowerShellLiteral $eventLogPath))
        Write-Utf8NoBom -Path $brokerPath -Text $brokerText

        $refreshFixtureTemplate = @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:ReleaseRoot = __RELEASE_ROOT__
$script:Channel = 'stable'
$script:ProgramDataRoot = __PROGRAM_DATA_ROOT__
$script:LocalAppDataRoot = __LOCAL_APP_DATA_ROOT__
$script:PayloadRoot = __PAYLOAD_ROOT__
$script:RequestsRoot = __REQUESTS_ROOT__
$script:ResultsRoot = __RESULTS_ROOT__
$script:BrokerPath = __BROKER_PATH__
$script:EventLogPath = __EVENT_LOG__
$script:PowerShellPath = __POWERSHELL_PATH__
$script:MutexName = __MUTEX_NAME__
$script:RevAgentExitCoordinatorAlreadyRunning = 80
$script:RevAgentExitCoordinatorTimeout = 81
$script:RevAgentExitBootstrapTrustRequired = 84
$script:BrokerProcess = $null

function Add-FixtureEvent {
    param([Parameter(Mandatory = $true)][string]$Name)
    [IO.File]::AppendAllText($script:EventLogPath, $Name + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Initialize-TrustedPowerShellModules { Add-FixtureEvent -Name 'modules' }
function Get-RevAgentProgramDataRoot { return $script:ProgramDataRoot }
function Get-RevAgentLocalAppDataRoot { return $script:LocalAppDataRoot }
function Get-RevAgentBootstrapTrustMutexName { return $script:MutexName }

function Get-RevAgentBootstrapTrustClientContext {
    Add-FixtureEvent -Name 'health'
    $commands = [ordered]@{}
    $commands['New-RevAgentBootstrapTrustRequest'] = {
        param([Parameter(Mandatory = $true)][string]$InboxId)
        Add-FixtureEvent -Name 'request'
        $nonce = [Guid]::NewGuid().ToString('N')
        $requestPath = Join-Path $script:RequestsRoot ($nonce + '.json')
        $resultPath = Join-Path $script:ResultsRoot ($nonce + '.json')
        $request = [ordered]@{ inboxId = $InboxId; nonce = $nonce; requestPath = $requestPath; resultPath = $resultPath }
        [IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        return [pscustomobject]$request
    }
    $commands['Start-RevAgentBootstrapTrustBrokerTask'] = {
        Add-FixtureEvent -Name 'task'
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $script:PowerShellPath
        $startInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script:BrokerPath + '"'
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $script:BrokerProcess = [Diagnostics.Process]::Start($startInfo)
        if ($null -eq $script:BrokerProcess) { throw 'Mock fixed SYSTEM broker task did not start.' }
        $brokerSeen = $false
        for ($index = 0; $index -lt 500; $index++) {
            if ([IO.File]::Exists($script:EventLogPath) -and @([IO.File]::ReadAllLines($script:EventLogPath)) -contains 'broker') { $brokerSeen = $true; break }
            Start-Sleep -Milliseconds 10
        }
        if (-not $brokerSeen) { throw 'Mock fixed SYSTEM broker task did not report activation.' }
        return [pscustomobject]@{ started = $true; taskName = '\DPE\revAgent\revAgent Bootstrap Trust Broker' }
    }
    $commands['Wait-RevAgentBootstrapTrustResult'] = {
        param([Parameter(Mandatory = $true)][object]$Request, [int]$TimeoutSeconds = 600)
        Add-FixtureEvent -Name 'wait'
        if ($null -eq $script:BrokerProcess) { throw 'Mock fixed SYSTEM broker process was not started.' }
        if (-not $script:BrokerProcess.WaitForExit([Math]::Min($TimeoutSeconds * 1000, 30000))) {
            return [pscustomobject]@{ completed = $false; timedOut = $true; exitCode = 81; message = 'timeout' }
        }
        $brokerExit = [int]$script:BrokerProcess.ExitCode
        $script:BrokerProcess.Dispose()
        $script:BrokerProcess = $null
        if ($brokerExit -ne 0 -or -not [IO.File]::Exists([string]$Request.resultPath)) {
            throw "Mock fixed SYSTEM broker failed. exit=$brokerExit"
        }
        $result = [IO.File]::ReadAllText([string]$Request.resultPath) | ConvertFrom-Json
        if ([string]$result.nonce -ne [string]$Request.nonce -or [string]$result.inboxId -ne [string]$Request.inboxId) {
            throw 'Mock fixed SYSTEM broker result was not bound to the exact request.'
        }
        return [pscustomobject]@{ completed = $true; timedOut = $false; exitCode = [int]$result.exitCode; message = [string]$result.message; state = [string]$result.state; releaseSequence = [int]$result.releaseSequence }
    }
    $commands['Remove-RevAgentBootstrapTrustClientArtifacts'] = {
        param([Parameter(Mandatory = $true)][object]$Request)
        foreach ($path in @([string]$Request.requestPath, [string]$Request.resultPath)) {
            if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
        }
        Add-FixtureEvent -Name 'request-cleanup'
    }
    return [pscustomobject]@{ commands = $commands; layout = [pscustomobject]@{}; health = [pscustomobject]@{ healthy = $true } }
}

function New-RevAgentBootstrapAuthenticatedInbox {
    param([Parameter(Mandatory = $true)][object]$TrustContext)
    Add-FixtureEvent -Name 'inbox'
    $inboxId = [Guid]::NewGuid().ToString('N')
    $inboxRoot = Join-Path $script:LocalAppDataRoot ('DPE\revAgent\release-inbox\' + $inboxId)
    [void][IO.Directory]::CreateDirectory($inboxRoot)
    foreach ($sourcePath in [IO.Directory]::GetFiles($script:PayloadRoot)) {
        [IO.File]::Copy($sourcePath, (Join-Path $inboxRoot ([IO.Path]::GetFileName($sourcePath))), $false)
    }
    return [pscustomobject]@{ inboxId = $inboxId; inboxRoot = $inboxRoot }
}

function Remove-RevAgentBootstrapAuthenticatedInbox {
    param([AllowNull()][object]$Inbox)
    if ($null -ne $Inbox -and [IO.Directory]::Exists([string]$Inbox.inboxRoot)) {
        [IO.Directory]::Delete([string]$Inbox.inboxRoot, $true)
    }
    Add-FixtureEvent -Name 'inbox-cleanup'
}

function Remove-StaleRevAgentBootstrapTemporaryItems { Add-FixtureEvent -Name 'sweep' }

__PRODUCTION_FUNCTIONS__

$exitCode = 1
try { $exitCode = [int](Invoke-RevAgentBootstrapRefreshMain) }
finally {
    if ($null -ne $script:BrokerProcess) { try { $script:BrokerProcess.Dispose() } catch { } }
}
exit $exitCode
'@
        $fixtureRefreshText = $refreshFixtureTemplate.Replace('__PRODUCTION_FUNCTIONS__', $productionFunctions)
        $fixtureRefreshText = $fixtureRefreshText.Replace('__RELEASE_ROOT__', (ConvertTo-SingleQuotedPowerShellLiteral $releaseRoot))
        $fixtureRefreshText = $fixtureRefreshText.Replace('__PROGRAM_DATA_ROOT__', (ConvertTo-SingleQuotedPowerShellLiteral $programDataRoot))
        $fixtureRefreshText = $fixtureRefreshText.Replace('__LOCAL_APP_DATA_ROOT__', (ConvertTo-SingleQuotedPowerShellLiteral $localAppDataRoot))
        $fixtureRefreshText = $fixtureRefreshText.Replace('__PAYLOAD_ROOT__', (ConvertTo-SingleQuotedPowerShellLiteral $payloadRoot))
        $fixtureRefreshText = $fixtureRefreshText.Replace('__REQUESTS_ROOT__', (ConvertTo-SingleQuotedPowerShellLiteral $requestsRoot))
        $fixtureRefreshText = $fixtureRefreshText.Replace('__RESULTS_ROOT__', (ConvertTo-SingleQuotedPowerShellLiteral $resultsRoot))
        $fixtureRefreshText = $fixtureRefreshText.Replace('__BROKER_PATH__', (ConvertTo-SingleQuotedPowerShellLiteral $brokerPath))
        $fixtureRefreshText = $fixtureRefreshText.Replace('__EVENT_LOG__', (ConvertTo-SingleQuotedPowerShellLiteral $eventLogPath))
        $fixtureRefreshText = $fixtureRefreshText.Replace('__POWERSHELL_PATH__', (ConvertTo-SingleQuotedPowerShellLiteral $windowsPowerShell))
        $fixtureRefreshText = $fixtureRefreshText.Replace('__MUTEX_NAME__', (ConvertTo-SingleQuotedPowerShellLiteral ('Local\revAgentE2Fixture-' + [Guid]::NewGuid().ToString('N'))))
        Write-Utf8NoBom -Path $fixtureRefreshPath -Text $fixtureRefreshText

        $commonDataExpression = '[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)'
        $fixtureCommonDataExpression = ConvertTo-SingleQuotedPowerShellLiteral $programDataRoot
        $stableText = [IO.File]::ReadAllText($stableLauncherSourcePath)
        $stableText = $stableText.Replace('\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy', $releaseRoot)
        $stableText = $stableText.Replace($commonDataExpression, $fixtureCommonDataExpression)
        Assert-True ($stableText.Contains($releaseRoot)) 'Could not bind the real STABLE launcher to the disposable release root.'
        Assert-True ($stableText.Contains($fixtureCommonDataExpression)) 'Could not bind the real STABLE launcher CommonApplicationData probe.'
        Write-Utf8NoBom -Path $stableLauncherPath -Text $stableText

        $refreshLauncherText = [IO.File]::ReadAllText($refreshLauncherSourcePath).Replace($commonDataExpression, $fixtureCommonDataExpression)
        Assert-True ($refreshLauncherText.Contains($fixtureCommonDataExpression)) 'Could not bind the real Refresh launcher CommonApplicationData probe.'
        Write-Utf8NoBom -Path $refreshLauncherPath -Text $refreshLauncherText

        $cmdPath = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
        $processInfo = [Diagnostics.ProcessStartInfo]::new()
        $processInfo.FileName = $cmdPath
        $processInfo.Arguments = '/d /s /c ""' + $stableLauncherPath + '""'
        $processInfo.WorkingDirectory = $scenarioRoot
        $processInfo.UseShellExecute = $false
        $processInfo.CreateNoWindow = $true
        $processInfo.RedirectStandardOutput = $true
        $processInfo.RedirectStandardError = $true
        $process = [Diagnostics.Process]::Start($processInfo)
        Assert-True ($null -ne $process) "Real STABLE launcher child did not start for $scenario."
        try {
            $stdoutTask = $process.StandardOutput.ReadToEndAsync()
            $stderrTask = $process.StandardError.ReadToEndAsync()
            Assert-True ($process.WaitForExit(60000)) "Real STABLE launcher child timed out for $scenario."
            $stdout = $stdoutTask.GetAwaiter().GetResult()
            $stderr = $stderrTask.GetAwaiter().GetResult()
            $launcherExit = [int]$process.ExitCode
        }
        finally { $process.Dispose() }
        Assert-True ($launcherExit -eq 0) "Real STABLE launcher failed for $scenario. code=$launcherExit stdout=$stdout stderr=$stderr"

        foreach ($entry in $componentTargets.GetEnumerator()) {
            $installedPath = Join-Path $bootstrapRoot ([string]$entry.Value)
            Assert-True ([IO.File]::Exists($installedPath)) "Broker did not install $($entry.Key) for $scenario. stdout=$stdout stderr=$stderr"
            Assert-True ([IO.File]::ReadAllText($installedPath).Contains($expectedMarker)) "Broker did not rebind $($entry.Key) to the authenticated eight-component set for $scenario."
        }
        Assert-True ([IO.File]::Exists((Join-Path $bootstrapRoot 'bootstrap-state.json'))) "Broker did not install bootstrap state for $scenario."

        $postRefreshLines = @(if ([IO.File]::Exists($postRefreshLogPath)) { [IO.File]::ReadAllLines($postRefreshLogPath) | Where-Object { $_ -eq 'post-refresh' } })
        Assert-True ($postRefreshLines.Count -eq 1) "Protected local launcher was not called with --post-refresh exactly once for $scenario. count=$($postRefreshLines.Count) events=$(if ([IO.File]::Exists($eventLogPath)) { [IO.File]::ReadAllText($eventLogPath) }) stdout=$stdout stderr=$stderr"

        $events = @([IO.File]::ReadAllLines($eventLogPath) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $expectedEvents = @('modules', 'health', 'inbox', 'request', 'task', 'broker', 'wait', 'post-refresh', 'request-cleanup', 'inbox-cleanup', 'sweep')
        Assert-True ($events.Count -eq $expectedEvents.Count) "Unexpected E2 event count for $scenario. actual=$($events -join ',')"
        for ($index = 0; $index -lt $expectedEvents.Count; $index++) {
            Assert-True ($events[$index] -eq $expectedEvents[$index]) "E2 event order mismatch for $scenario at $index. expected=$($expectedEvents[$index]) actual=$($events[$index]) all=$($events -join ',')"
        }
        Assert-True (@($events | Where-Object { $_ -eq 'broker' }).Count -eq 1) "Fixed mock SYSTEM broker did not run exactly once for $scenario."
        Assert-True (@([IO.Directory]::GetFiles($requestsRoot)).Count -eq 0) "Exact request cleanup was incomplete for $scenario."
        Assert-True (@([IO.Directory]::GetFiles($resultsRoot)).Count -eq 0) "Exact result cleanup was incomplete for $scenario."
        $releaseInboxRoot = Join-Path $localAppDataRoot 'DPE\revAgent\release-inbox'
        Assert-True (-not [IO.Directory]::Exists($releaseInboxRoot) -or @([IO.Directory]::GetDirectories($releaseInboxRoot)).Count -eq 0) "Authenticated inbox cleanup was incomplete for $scenario."
    }

    Write-Host 'Clean and stale E2 bootstrap launcher fixtures passed.' -ForegroundColor Green
}
finally {
    if ([IO.Directory]::Exists($fixtureRoot)) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
