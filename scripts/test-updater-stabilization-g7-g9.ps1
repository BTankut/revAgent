<#
.SYNOPSIS
    Focused executable coverage for updater stabilization work-order G7-G9.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$sourcePath = Join-Path $RepoRoot 'installer\nas\Refresh-revAgent-LocalBootstrap-STABLE.ps1'
$refreshCmdPath = Join-Path $RepoRoot 'installer\nas\Refresh-revAgent-LocalBootstrap-STABLE.cmd'
$stableLauncherPath = Join-Path $RepoRoot 'installer\nas\revAgent Updater STABLE.cmd'
$legacyStableLauncherPath = Join-Path $RepoRoot 'installer\nas\Revit MCP Updater STABLE.cmd'
$localLauncherPath = Join-Path $RepoRoot 'installer\nas\Start-revAgent-Update.cmd'
$guiPath = Join-Path $RepoRoot 'installer\nas\Install-revAgent-Updater-GUI.ps1'
$permissionsModulePath = Join-Path $RepoRoot 'installer\lib\RevAgent.Permissions.psm1'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Set-OldFixtureTimestamp {
    param([Parameter(Mandatory = $true)][string]$Path)
    $old = [DateTime]::UtcNow.AddDays(-3)
    $item = Get-Item -LiteralPath $Path -Force
    $item.CreationTimeUtc = $old
    $item.LastWriteTimeUtc = $old
}

function Invoke-CmdFixture {
    param(
        [Parameter(Mandatory = $true)][string]$CommandPath,
        [hashtable]$Environment = @{}
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $env:ComSpec
    $startInfo.Arguments = '/d /c call "{0}"' -f $CommandPath.Replace('"', '""')
    $startInfo.WorkingDirectory = Split-Path -Parent $CommandPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($name in $Environment.Keys) {
        $startInfo.EnvironmentVariables[[string]$name] = [string]$Environment[$name]
    }

    $process = [Diagnostics.Process]::Start($startInfo)
    try {
        $process.StandardInput.Close()
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        return [pscustomobject][ordered]@{
            exitCode = [int]$process.ExitCode
            stdout = [string]$stdout
            stderr = [string]$stderr
        }
    }
    finally {
        $process.Dispose()
    }
}

$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
Assert-True (@($parseErrors).Count -eq 0) 'Stable bootstrap refresh did not parse.'
$sourceText = Get-Content -Raw -LiteralPath $sourcePath
$refreshCmdText = Get-Content -Raw -LiteralPath $refreshCmdPath
$stableLauncherText = Get-Content -Raw -LiteralPath $stableLauncherPath
$legacyStableLauncherText = Get-Content -Raw -LiteralPath $legacyStableLauncherPath
$localLauncherText = Get-Content -Raw -LiteralPath $localLauncherPath
$guiText = Get-Content -Raw -LiteralPath $guiPath
$permissionsModule = Import-Module $permissionsModulePath -Force -PassThru
$staleCleanupCommand = Get-Command ("{0}\Remove-StaleRevAgentBootstrapTemporaryItems" -f $permissionsModule.Name) -ErrorAction Stop

$functionNames = @(
    'Test-RevAgentStringEquals',
    'Test-RevAgentStringStartsWith',
    'Get-RevAgentProgramDataRoot',
    'Get-RevAgentBootstrapExitMessage',
    'Get-RevAgentBootstrapTempRoot',
    'Get-RevAgentBootstrapTemporaryPathInfo',
    'Open-RevAgentBootstrapTemporaryDirectoryGuard',
    'Clear-RevAgentBootstrapTemporaryDirectoryNoFollow',
    'Remove-RevAgentBootstrapTemporaryPath',
    'Remove-StaleRevAgentBootstrapTemporaryItems',
    'Get-RevAgentLocalAppDataRoot',
    'Get-RevAgentBootstrapTrustClientContext',
    'New-RevAgentBootstrapAuthenticatedInbox',
    'Remove-RevAgentBootstrapAuthenticatedInbox',
    'Start-RevAgentPostRefreshLauncher',
    'Get-RevAgentBootstrapTrustMutexName',
    'Invoke-RevAgentBootstrapRefreshMain'
)
$functionAsts = @($ast.FindAll({
            param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $functionNames
        }, $true))
Assert-True ($functionAsts.Count -eq $functionNames.Count) 'G7-G9 helper functions could not be loaded for executable coverage.'
$fixtureModule = New-Module -ScriptBlock ([scriptblock]::Create((@($functionAsts | ForEach-Object { $_.Extent.Text }) -join "`r`n`r`n")))

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('revagent-g7-g9-fixture-' + [Guid]::NewGuid().ToString('N'))
$markerPaths = [Collections.Generic.List[string]]::new()
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null

try {
    & $fixtureModule {
        param($FixtureTempRoot, $FixtureRefreshScriptPath)
        $script:RevAgentExitCoordinatorAlreadyRunning = 80
        $script:RevAgentExitCoordinatorTimeout = 81
        $script:RevAgentExitBootstrapTrustRequired = 84
        $script:ReleaseRoot = 'C:\fixture\release'
        $script:Channel = 'stable'
        $script:FixtureTempRoot = $FixtureTempRoot
        function script:Get-RevAgentBootstrapTempRoot { return $script:FixtureTempRoot }
    } $fixtureRoot $sourcePath
    Write-Host 'Test active E2 trust-core dispatch, timeout mapping, and exact cleanup'
    $dispatchResult = & $fixtureModule {
        $script:DispatchOrder = [Collections.Generic.List[string]]::new()
        $script:PostRefreshCount = 0
        $script:RequestCleanupCount = 0
        $script:InboxCleanupCount = 0
        $script:MockWaitResult = [pscustomobject]@{ completed = $true; timedOut = $false; exitCode = 0; message = 'broker-ok' }
        function script:Initialize-TrustedPowerShellModules { [void]$script:DispatchOrder.Add('modules') }
        function script:Mock-NewTrustRequest {
            param([string]$InboxId)
            [void]$script:DispatchOrder.Add('request')
            return [pscustomobject]@{ inboxId = $InboxId; nonce = ('a' * 32); requestPath = 'request'; resultPath = 'result' }
        }
        function script:Mock-StartTrustTask { [void]$script:DispatchOrder.Add('task') }
        function script:Mock-WaitTrustResult {
            param([object]$Request, [int]$TimeoutSeconds)
            [void]$script:DispatchOrder.Add('wait')
            return $script:MockWaitResult
        }
        function script:Mock-RemoveTrustArtifacts {
            param([object]$Request)
            $script:RequestCleanupCount++
            [void]$script:DispatchOrder.Add('request-cleanup')
        }
        $script:MockTrustContext = [pscustomobject]@{
            commands = [ordered]@{
                'New-RevAgentBootstrapTrustRequest' = Get-Command Mock-NewTrustRequest
                'Start-RevAgentBootstrapTrustBrokerTask' = Get-Command Mock-StartTrustTask
                'Wait-RevAgentBootstrapTrustResult' = Get-Command Mock-WaitTrustResult
                'Remove-RevAgentBootstrapTrustClientArtifacts' = Get-Command Mock-RemoveTrustArtifacts
            }
        }
        function script:Get-RevAgentBootstrapTrustClientContext {
            [void]$script:DispatchOrder.Add('health')
            return $script:MockTrustContext
        }
        function script:New-RevAgentBootstrapAuthenticatedInbox {
            param([object]$TrustContext)
            [void]$script:DispatchOrder.Add('inbox')
            return [pscustomobject]@{ inboxId = ('b' * 32); inboxRoot = 'fixture-inbox' }
        }
        function script:Start-RevAgentPostRefreshLauncher {
            $script:PostRefreshCount++
            [void]$script:DispatchOrder.Add('post-refresh')
            return 0
        }
        function script:Remove-RevAgentBootstrapAuthenticatedInbox {
            param([object]$Inbox)
            $script:InboxCleanupCount++
            [void]$script:DispatchOrder.Add('inbox-cleanup')
        }
        function script:Remove-StaleRevAgentBootstrapTemporaryItems { }
        function script:Get-RevAgentBootstrapTrustMutexName { return 'Local\revAgentBootstrapTrustRefresh-fixture-' + [Guid]::NewGuid().ToString('N') }

        $exitCode = Invoke-RevAgentBootstrapRefreshMain
        return [pscustomobject]@{
            exitCode = [int]$exitCode
            order = @($script:DispatchOrder.ToArray())
            postRefreshCount = $script:PostRefreshCount
            requestCleanupCount = $script:RequestCleanupCount
            inboxCleanupCount = $script:InboxCleanupCount
        }
    }
    Assert-True ([int]$dispatchResult.exitCode -eq 0) 'Active E2 trust-core dispatch did not succeed.'
    Assert-True ([string]::Join(',', [string[]]$dispatchResult.order) -eq 'modules,health,inbox,request,task,wait,post-refresh,request-cleanup,inbox-cleanup') 'E2 trust-core dispatch order or finally cleanup order changed.'
    Assert-True ([int]$dispatchResult.postRefreshCount -eq 1 -and [int]$dispatchResult.requestCleanupCount -eq 1 -and [int]$dispatchResult.inboxCleanupCount -eq 1) 'E2 dispatch did not launch post-refresh or clean exact client artifacts exactly once.'

    $timeoutResult = & $fixtureModule {
        $script:DispatchOrder.Clear()
        $script:PostRefreshCount = 0
        $script:RequestCleanupCount = 0
        $script:InboxCleanupCount = 0
        $script:MockWaitResult = [pscustomobject]@{ completed = $false; timedOut = $true; exitCode = 0; message = '' }
        $exitCode = Invoke-RevAgentBootstrapRefreshMain
        [pscustomobject]@{ exitCode = [int]$exitCode; postRefreshCount = $script:PostRefreshCount; requestCleanupCount = $script:RequestCleanupCount; inboxCleanupCount = $script:InboxCleanupCount }
    }
    Assert-True ([int]$timeoutResult.exitCode -eq 81 -and [int]$timeoutResult.postRefreshCount -eq 0) 'E2 protected-result timeout did not map to exit 81 before post-refresh.'
    Assert-True ([int]$timeoutResult.requestCleanupCount -eq 1 -and [int]$timeoutResult.inboxCleanupCount -eq 1) 'E2 timeout did not clean the exact request/result and inbox artifacts.'

    $missingTrustOutput = @(& $fixtureModule {
            function script:Get-RevAgentBootstrapTrustClientContext { return $null }
            Invoke-RevAgentBootstrapRefreshMain
        } 6>&1)
    $missingTrustExit = @($missingTrustOutput | Where-Object { $_ -is [int] } | Select-Object -Last 1)
    Assert-True ($missingTrustExit.Count -eq 1 -and [int]$missingTrustExit[0] -eq 84) 'Missing or unhealthy IT-prestaged trust core did not return exit 84.'
    Assert-True ((@($missingTrustOutput | ForEach-Object { [string]$_ }) -join ' ') -match 'IT-prestaged machine trust core' -and (@($missingTrustOutput | ForEach-Object { [string]$_ }) -join ' ') -match 'IT prestage kit') 'Exit 84 did not provide the E1 prestage-kit remediation.'

    Write-Host 'Test G7 exact current TEMP cleanup'
    $cleanupId = [Guid]::NewGuid().ToString('N')
    $cleanupSource = Join-Path $fixtureRoot "revagent-bootstrap-install-source-$cleanupId"
    $cleanupEvidence = Join-Path $fixtureRoot "revagent-bootstrap-install-evidence-$cleanupId.json"
    $cleanupKeys = Join-Path $fixtureRoot "revagent-bootstrap-trusted-keys-$cleanupId.json"
    $cleanupLockPath = Join-Path $fixtureRoot "revagent-bootstrap-install-source-$cleanupId.lock"
    $cleanupJunctionTarget = Join-Path $fixtureRoot 'current-cleanup-junction-target'
    $cleanupChildJunction = Join-Path $cleanupSource 'raced-child-junction'
    New-Item -ItemType Directory -Path $cleanupSource | Out-Null
    [IO.File]::WriteAllText((Join-Path $cleanupSource 'payload.txt'), 'payload')
    New-Item -ItemType Directory -Path $cleanupJunctionTarget | Out-Null
    [IO.File]::WriteAllText((Join-Path $cleanupJunctionTarget 'sentinel.txt'), 'must-survive')
    New-Item -ItemType Junction -Path $cleanupChildJunction -Target $cleanupJunctionTarget | Out-Null
    [IO.File]::WriteAllText($cleanupEvidence, '{}')
    [IO.File]::WriteAllText($cleanupKeys, '{}')
    $cleanupLock = [IO.File]::Open($cleanupLockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $cleanupInput = [pscustomobject]@{
        SourceRoot = $cleanupSource
        EvidenceSource = $cleanupEvidence
        TrustedKeysSource = $cleanupKeys
        CleanupLockPath = $cleanupLockPath
        CleanupLock = $cleanupLock
    }
    $cleanupLock.Dispose()
    & $fixtureModule {
        param($InputObject, $TempRoot)
        foreach ($path in @($InputObject.SourceRoot, $InputObject.EvidenceSource, $InputObject.TrustedKeysSource, $InputObject.CleanupLockPath)) {
            Remove-RevAgentBootstrapTemporaryPath -Path ([string]$path) -TempRoot $TempRoot
        }
    } $cleanupInput $fixtureRoot
    Assert-True (-not (Test-Path -LiteralPath $cleanupSource) -and -not (Test-Path -LiteralPath $cleanupEvidence) -and -not (Test-Path -LiteralPath $cleanupKeys) -and -not (Test-Path -LiteralPath $cleanupLockPath)) 'Exact current bootstrap TEMP input was not fully removed.'
    Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $cleanupJunctionTarget 'sentinel.txt')) -eq 'must-survive') 'Exact TEMP cleanup traversed a raced child junction target.'

    Write-Host 'Test G7 stale cleanup age, lock, and reparse guards'
    $staleId = [Guid]::NewGuid().ToString('N')
    $staleSource = Join-Path $fixtureRoot "revagent-bootstrap-refresh-source-$staleId"
    $staleEvidence = Join-Path $fixtureRoot "revagent-bootstrap-refresh-evidence-$staleId.json"
    $staleLockPath = Join-Path $fixtureRoot "revagent-bootstrap-refresh-source-$staleId.lock"
    New-Item -ItemType Directory -Path $staleSource | Out-Null
    [IO.File]::WriteAllText((Join-Path $staleSource 'payload.txt'), 'payload')
    [IO.File]::WriteAllText($staleEvidence, '{}')
    [IO.File]::WriteAllText($staleLockPath, 'active')
    Set-OldFixtureTimestamp -Path (Join-Path $staleSource 'payload.txt')
    Set-OldFixtureTimestamp -Path $staleSource
    Set-OldFixtureTimestamp -Path $staleEvidence
    Set-OldFixtureTimestamp -Path $staleLockPath
    $staleLock = [IO.File]::Open($staleLockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    & $staleCleanupCommand -TempRoot $fixtureRoot -MinimumAgeHours 1
    Assert-True ((Test-Path -LiteralPath $staleSource) -and (Test-Path -LiteralPath $staleEvidence) -and (Test-Path -LiteralPath $staleLockPath)) 'Stale cleanup removed an in-use bootstrap attempt.'
    $staleLock.Dispose()
    & $staleCleanupCommand -TempRoot $fixtureRoot -MinimumAgeHours 1
    Assert-True (-not (Test-Path -LiteralPath $staleSource) -and -not (Test-Path -LiteralPath $staleEvidence) -and -not (Test-Path -LiteralPath $staleLockPath)) 'Unlocked stale bootstrap TEMP items were not removed.'

    $junctionId = [Guid]::NewGuid().ToString('N')
    $junctionPath = Join-Path $fixtureRoot "revagent-bootstrap-install-source-$junctionId"
    $junctionTarget = Join-Path $fixtureRoot 'junction-target'
    New-Item -ItemType Directory -Path $junctionTarget | Out-Null
    [IO.File]::WriteAllText((Join-Path $junctionTarget 'keep.txt'), 'keep')
    New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget | Out-Null
    & $staleCleanupCommand -TempRoot $fixtureRoot -MinimumAgeHours 1
    Assert-True ((Test-Path -LiteralPath $junctionPath) -and (Test-Path -LiteralPath (Join-Path $junctionTarget 'keep.txt'))) 'Stale cleanup traversed or removed a reparse-point candidate.'
    [IO.Directory]::Delete($junctionPath)

    Write-Host 'Test G7 cleanup is bound to post-Shown GUI maintenance and remains best-effort'
    $guiTokens = $null
    $guiParseErrors = $null
    $guiAst = [Management.Automation.Language.Parser]::ParseFile($guiPath, [ref]$guiTokens, [ref]$guiParseErrors)
    Assert-True (@($guiParseErrors).Count -eq 0) 'Updater GUI did not parse for startup-maintenance coverage.'
    $maintenanceFunction = @($guiAst.FindAll({
                param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-RevAgentGuiStartupMaintenance'
            }, $true))[0]
    Assert-True ($null -ne $maintenanceFunction) 'GUI startup-maintenance producer was not found.'
    $maintenanceModule = New-Module -ScriptBlock ([scriptblock]::Create($maintenanceFunction.Extent.Text))
    $maintenanceCalls = [Collections.Generic.List[int]]::new()
    $successfulCleanup = { param([int]$MinimumAgeHours) [void]$maintenanceCalls.Add($MinimumAgeHours) }.GetNewClosure()
    & $maintenanceModule { param($Command) Invoke-RevAgentGuiStartupMaintenance -CleanupCommand $Command -MinimumAgeHours 7 } $successfulCleanup
    Assert-True ($maintenanceCalls.Count -eq 1 -and $maintenanceCalls[0] -eq 7) 'GUI startup maintenance did not invoke the production cleanup command exactly once.'
    $throwingCleanup = { param([int]$MinimumAgeHours) throw "maintenance-only-$MinimumAgeHours" }
    $maintenanceFailureEscaped = $false
    try { & $maintenanceModule { param($Command) Invoke-RevAgentGuiStartupMaintenance -CleanupCommand $Command } $throwingCleanup }
    catch { $maintenanceFailureEscaped = $true }
    Assert-True (-not $maintenanceFailureEscaped) 'GUI startup maintenance allowed a cleanup-only failure to escape.'
    Assert-True ($guiText -match '(?s)\$form\.Add_Shown\(\{\s*\$script:GuiStartupCompleted\s*=\s*\$true\s*Start-RevAgentGuiStartupMaintenance\s*\}\)' -and $guiText -match 'GuiStaleBootstrapCleanupCommand' -and $guiText -match 'System\.Windows\.Forms\.Timer') 'GUI cleanup is not scheduled exactly after the Shown startup-complete marker.'
    Remove-Module $maintenanceModule -Force
    Write-Host 'Test G8 uses only the fixed prestaged broker task and protected nonce result API'
    Assert-True ($sourceText -match 'New-RevAgentBootstrapTrustRequest' -and $sourceText -match 'Start-RevAgentBootstrapTrustBrokerTask' -and $sourceText -match 'Wait-RevAgentBootstrapTrustResult') 'Refresh is not wired to the protected request/start/wait API.'
    Assert-True ($sourceText -notmatch 'New-ScheduledTaskAction|New-ScheduledTaskPrincipal|Register-ScheduledTask|Unregister-ScheduledTask|CoordinatorNonce|CoordinatorResultPath') 'Refresh must not create per-attempt tasks or caller-selected result paths after E2 activation.'

    Write-Host 'Test launcher trust boundaries and exit-code propagation with real CMD children'
    $ascii = [Text.ASCIIEncoding]::new()
    $machineTrustMessage = 'IT-prestaged revAgent machine trust core is missing or unhealthy'
    $machinePrestageMessage = 'run the revAgent IT prestage kit'
    $localTrustMessage = 'IT-prestaged revAgent machine trust core is missing or unhealthy'
    $administratorContact = 'Contact the DPE revAgent administrator'
    $canonicalKnownFolderProbeCommand = '$mode=$ExecutionContext.SessionState.LanguageMode; if($mode -ne ''FullLanguage''){ ''REVAGENT_LANGUAGE_MODE='' + $mode } else { ''REVAGENT_COMMON_APP_DATA='' + [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData) }'
    $constrainedKnownFolderProbeCommand = '$ExecutionContext.SessionState.LanguageMode=''ConstrainedLanguage''; ' + $canonicalKnownFolderProbeCommand
    Assert-True ([regex]::Matches($stableLauncherText, [regex]::Escape($canonicalKnownFolderProbeCommand)).Count -eq 1) 'STABLE launcher fixture could not bind its LanguageMode-first canonical CommonApplicationData probe.'
    Assert-True ([regex]::Matches($refreshCmdText, [regex]::Escape($canonicalKnownFolderProbeCommand)).Count -eq 1) 'Refresh CMD fixture could not bind its LanguageMode-first canonical CommonApplicationData probe.'

    $refreshFixtureRoot = Join-Path $fixtureRoot 'refresh-cmd'
    [IO.Directory]::CreateDirectory($refreshFixtureRoot) | Out-Null
    $refreshFixtureCmd = Join-Path $refreshFixtureRoot 'Refresh-revAgent-LocalBootstrap-STABLE.cmd'
    $refreshFixturePs1 = Join-Path $refreshFixtureRoot 'Refresh-revAgent-LocalBootstrap-STABLE.ps1'
    [IO.File]::WriteAllBytes($refreshFixtureCmd, [IO.File]::ReadAllBytes($refreshCmdPath))
    [IO.File]::WriteAllText($refreshFixturePs1, "exit 84`r`n", $ascii)
    $refreshFixtureResult = Invoke-CmdFixture -CommandPath $refreshFixtureCmd -Environment @{
        ProgramData = (Join-Path $fixtureRoot 'refresh-programdata')
    }
    Assert-True ($refreshFixtureResult.exitCode -eq 84 -and $refreshFixtureResult.stdout -match [regex]::Escape($machineTrustMessage) -and $refreshFixtureResult.stdout -match [regex]::Escape($machinePrestageMessage)) 'Refresh CMD did not preserve exit code 84 with E1 prestage-kit guidance.'

    Write-Host 'Test Refresh CMD LanguageMode-first probe with a real constrained PS5 child'
    $refreshConstrainedFixtureCmd = Join-Path $refreshFixtureRoot 'Refresh-revAgent-ConstrainedLanguage-STABLE.cmd'
    $refreshConstrainedFixtureText = $refreshCmdText.Replace($canonicalKnownFolderProbeCommand, $constrainedKnownFolderProbeCommand)
    Assert-True (-not [string]::Equals($refreshConstrainedFixtureText, $refreshCmdText, [StringComparison]::Ordinal)) 'Refresh CMD constrained-language fixture did not inject the real PS5 language mode.'
    [IO.File]::WriteAllText($refreshConstrainedFixtureCmd, $refreshConstrainedFixtureText, $ascii)
    $refreshConstrainedResult = Invoke-CmdFixture -CommandPath $refreshConstrainedFixtureCmd
    $refreshConstrainedOutput = $refreshConstrainedResult.stdout + "`n" + $refreshConstrainedResult.stderr
    Assert-True ($refreshConstrainedResult.exitCode -eq 78 -and $refreshConstrainedResult.stdout -match 'PowerShell is in ConstrainedLanguage mode' -and $refreshConstrainedResult.stdout -match 'Smart App Control or a WDAC/AppLocker policy') 'Refresh CMD did not return its friendly exact exit 78 diagnostic from a real constrained Windows PowerShell child.'
    Assert-True ($refreshConstrainedOutput -notmatch 'Method invocation is supported only on core types|MethodInvocationNotSupportedInConstrainedLanguage|CommonApplicationData could not be resolved') 'Refresh CMD invoked the FullLanguage-only KnownFolder method or masked the constrained-language diagnosis.'

    $stableReleaseRoot = Join-Path $fixtureRoot 'stable-release'
    $stableToolsRoot = Join-Path $stableReleaseRoot 'tools'
    $stableChannelsRoot = Join-Path $stableReleaseRoot 'channels'
    [IO.Directory]::CreateDirectory($stableToolsRoot) | Out-Null
    [IO.Directory]::CreateDirectory($stableChannelsRoot) | Out-Null
    [IO.File]::WriteAllText((Join-Path $stableChannelsRoot 'stable.json'), "{}`r`n", $ascii)
    $canonicalReleaseRootLine = 'set "RELEASE_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"'
    $fixtureReleaseRootLine = 'set "RELEASE_ROOT={0}"' -f $stableReleaseRoot
    $stableCanonicalProgramData = Join-Path $fixtureRoot 'stable-canonical-programdata'
    $fixtureKnownFolderProbeCommand = "'REVAGENT_COMMON_APP_DATA={0}'" -f $stableCanonicalProgramData.Replace("'", "''")
    Assert-True ([regex]::Matches($stableLauncherText, [regex]::Escape($canonicalReleaseRootLine)).Count -eq 1) 'STABLE launcher fixture could not bind its local release root.'
    $stableFixtureLauncher = Join-Path $stableToolsRoot 'revAgent Updater STABLE.cmd'
    $stableFixtureText = $stableLauncherText.Replace($canonicalReleaseRootLine, $fixtureReleaseRootLine).Replace($canonicalKnownFolderProbeCommand, $fixtureKnownFolderProbeCommand)
    [IO.File]::WriteAllText($stableFixtureLauncher, $stableFixtureText, $ascii)

    Write-Host 'Test STABLE launcher LanguageMode-first probe with a real constrained PS5 child'
    $stableConstrainedFixtureLauncher = Join-Path $stableToolsRoot 'revAgent Updater ConstrainedLanguage STABLE.cmd'
    $stableConstrainedFixtureText = $stableLauncherText.Replace($canonicalReleaseRootLine, $fixtureReleaseRootLine).Replace($canonicalKnownFolderProbeCommand, $constrainedKnownFolderProbeCommand)
    Assert-True (-not [string]::Equals($stableConstrainedFixtureText, $stableLauncherText, [StringComparison]::Ordinal)) 'STABLE constrained-language fixture did not inject the real PS5 language mode.'
    [IO.File]::WriteAllText($stableConstrainedFixtureLauncher, $stableConstrainedFixtureText, $ascii)
    $stableConstrainedResult = Invoke-CmdFixture -CommandPath $stableConstrainedFixtureLauncher
    $stableConstrainedOutput = $stableConstrainedResult.stdout + "`n" + $stableConstrainedResult.stderr
    Assert-True ($stableConstrainedResult.exitCode -eq 78 -and $stableConstrainedResult.stdout -match 'PowerShell is in ConstrainedLanguage mode' -and $stableConstrainedResult.stdout -match 'Smart App Control or a WDAC/AppLocker policy') 'STABLE launcher did not return its friendly exact exit 78 diagnostic from a real constrained Windows PowerShell child.'
    Assert-True ($stableConstrainedOutput -notmatch 'Method invocation is supported only on core types|MethodInvocationNotSupportedInConstrainedLanguage|CommonApplicationData could not be resolved') 'STABLE launcher invoked the FullLanguage-only KnownFolder method or masked the constrained-language diagnosis.'

    $stableRefreshSentinel = Join-Path $fixtureRoot 'stable-refresh-called.txt'
    $stableRefreshFixtureText = @(
        '@echo off'
        ('echo called>"{0}"' -f $stableRefreshSentinel)
        'exit /b 84'
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $stableToolsRoot 'Refresh-revAgent-LocalBootstrap-STABLE.cmd'), ($stableRefreshFixtureText + "`r`n"), $ascii)
    $stableFixtureResult = Invoke-CmdFixture -CommandPath $stableFixtureLauncher -Environment @{
        ProgramData = (Join-Path $fixtureRoot 'stable-poisoned-programdata')
    }
    Assert-True ($stableFixtureResult.exitCode -eq 84 -and $stableFixtureResult.stdout -match [regex]::Escape($machineTrustMessage) -and $stableFixtureResult.stdout -match [regex]::Escape($machinePrestageMessage) -and (Test-Path -LiteralPath $stableRefreshSentinel -PathType Leaf)) 'STABLE launcher did not preserve exit code 84 with E1 prestage-kit guidance.'

    Write-Host 'Test current STABLE bootstrap ignores poisoned ProgramData and bypasses refresh'
    Remove-Item -LiteralPath $stableRefreshSentinel -Force
    $currentCanonicalProgramData = Join-Path $fixtureRoot 'current-canonical-programdata'
    $currentBootstrapRoot = Join-Path $currentCanonicalProgramData 'DPE\revAgent\bootstrap'
    $poisonedProgramData = Join-Path $fixtureRoot 'current-poisoned-programdata'
    $poisonedBootstrapRoot = Join-Path $poisonedProgramData 'DPE\revAgent\bootstrap'
    [IO.Directory]::CreateDirectory($currentBootstrapRoot) | Out-Null
    [IO.Directory]::CreateDirectory($poisonedBootstrapRoot) | Out-Null
    $currentInvocationLog = Join-Path $fixtureRoot 'current-bootstrap-invocations.txt'
    $maliciousInvocationSentinel = Join-Path $fixtureRoot 'malicious-programdata-bootstrap-executed.txt'
    $currentBootstrapText = @(
        'param([string]$ChannelManifestPath = "", [switch]$VerificationOnly)'
        '$mode = if ($VerificationOnly) { "verification" } else { "normal" }'
        ('[IO.File]::AppendAllText(''{0}'', $mode + [Environment]::NewLine, [Text.Encoding]::ASCII)' -f $currentInvocationLog.Replace("'", "''"))
        'if ($VerificationOnly) { exit 0 }'
        'exit 37'
    ) -join "`r`n"
    $maliciousBootstrapText = @(
        'param([string]$ChannelManifestPath = "", [switch]$VerificationOnly)'
        ('[IO.File]::WriteAllText(''{0}'', ''executed'', [Text.Encoding]::ASCII)' -f $maliciousInvocationSentinel.Replace("'", "''"))
        'exit 0'
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $currentBootstrapRoot 'Start-revAgent-Update.ps1'), ($currentBootstrapText + "`r`n"), $ascii)
    [IO.File]::WriteAllText((Join-Path $poisonedBootstrapRoot 'Start-revAgent-Update.ps1'), ($maliciousBootstrapText + "`r`n"), $ascii)
    $currentFixtureKnownFolderCommand = "'REVAGENT_COMMON_APP_DATA={0}'" -f $currentCanonicalProgramData.Replace("'", "''")
    $currentStableFixtureLauncher = Join-Path $stableToolsRoot 'revAgent Updater Current STABLE.cmd'
    [IO.File]::WriteAllText($currentStableFixtureLauncher, $stableFixtureText.Replace($fixtureKnownFolderProbeCommand, $currentFixtureKnownFolderCommand), $ascii)
    $currentStableResult = Invoke-CmdFixture -CommandPath $currentStableFixtureLauncher -Environment @{ ProgramData = $poisonedProgramData }
    for ($attempt = 0; $attempt -lt 50 -and (-not (Test-Path -LiteralPath $currentInvocationLog -PathType Leaf) -or @([IO.File]::ReadAllLines($currentInvocationLog)).Count -lt 2); $attempt++) {
        Start-Sleep -Milliseconds 100
    }
    $currentInvocations = if (Test-Path -LiteralPath $currentInvocationLog -PathType Leaf) { @([IO.File]::ReadAllLines($currentInvocationLog)) } else { @() }
    Assert-True ($currentStableResult.exitCode -eq 37 -and $currentInvocations.Count -eq 2 -and $currentInvocations[0] -eq 'verification' -and $currentInvocations[1] -eq 'normal') ("Current STABLE bootstrap did not preserve the exact normal-child exit after verification. exit={0} invocations={1}" -f $currentStableResult.exitCode, [string]::Join(',', $currentInvocations))
    Assert-True (-not (Test-Path -LiteralPath $stableRefreshSentinel) -and -not (Test-Path -LiteralPath $maliciousInvocationSentinel)) 'Current STABLE path called refresh or executed the caller-controlled ProgramData bootstrap.'

    Write-Host 'Test protected local launcher sibling binding, missing-state guidance, and exact refresh exits'
    $localProgramData = Join-Path $fixtureRoot 'local-poisoned-programdata'
    $localPoisonedBootstrapRoot = Join-Path $localProgramData 'DPE\revAgent\bootstrap'
    $localBootstrapRoot = Join-Path $fixtureRoot 'local-bootstrap'
    [IO.Directory]::CreateDirectory($localPoisonedBootstrapRoot) | Out-Null
    [IO.Directory]::CreateDirectory($localBootstrapRoot) | Out-Null
    [IO.File]::WriteAllText((Join-Path $localPoisonedBootstrapRoot 'Start-revAgent-Update.ps1'), ($maliciousBootstrapText + "`r`n"), $ascii)
    [IO.File]::WriteAllText((Join-Path $localPoisonedBootstrapRoot 'bootstrap-state.json'), '{"release":{"channel":"stable"}}', $ascii)
    $localFixtureRefresh = Join-Path $fixtureRoot 'local-refresh.cmd'
    $localRefreshSentinel = Join-Path $fixtureRoot 'local-refresh-called.txt'
    $localFixtureRefreshText = @(
        '@echo off'
        'if /i not "%BOOTSTRAP_CHANNEL%"=="stable" exit /b 77'
        'echo Fixture channel: %BOOTSTRAP_CHANNEL%'
        ('echo called>"{0}"' -f $localRefreshSentinel)
        'exit /b 84'
    ) -join "`r`n"
    [IO.File]::WriteAllText($localFixtureRefresh, ($localFixtureRefreshText + "`r`n"), $ascii)
    $canonicalLocalRefreshLine = 'set "STABLE_REFRESH=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\Refresh-revAgent-LocalBootstrap-STABLE.cmd"'
    $fixtureLocalRefreshLine = 'set "STABLE_REFRESH={0}"' -f $localFixtureRefresh
    Assert-True ([regex]::Matches($localLauncherText, [regex]::Escape($canonicalLocalRefreshLine)).Count -eq 1) 'Protected local launcher fixture could not bind its local refresh command.'
    $canonicalChannelProbeLine = 'for /f "usebackq delims=" %%C in (`^""%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:REVAGENT_BOOTSTRAP_STATE; if(Test-Path -LiteralPath $p){ (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json).release.channel }"^"`) do set "BOOTSTRAP_CHANNEL=%%C"'
    Assert-True ([regex]::Matches($localLauncherText, [regex]::Escape($canonicalChannelProbeLine)).Count -eq 1) 'Protected local launcher lost the nested CMD quoting required by its canonical Windows PowerShell channel probe.'
    $localFixtureLauncher = Join-Path $localBootstrapRoot 'Start-revAgent-Update.cmd'
    $localFixtureText = $localLauncherText.Replace($canonicalLocalRefreshLine, $fixtureLocalRefreshLine)
    [IO.File]::WriteAllText($localFixtureLauncher, $localFixtureText, $ascii)
    $localMissingScriptResult = Invoke-CmdFixture -CommandPath $localFixtureLauncher -Environment @{ ProgramData = $localProgramData }
    Assert-True ($localMissingScriptResult.exitCode -eq 84 -and $localMissingScriptResult.stdout -match 'bootstrap is not installed' -and $localMissingScriptResult.stdout -match [regex]::Escape($administratorContact) -and $localMissingScriptResult.stdout -match [regex]::Escape($machinePrestageMessage) -and -not (Test-Path -LiteralPath $maliciousInvocationSentinel) -and -not (Test-Path -LiteralPath $localRefreshSentinel)) 'Protected local launcher did not give IT-prestage-kit exit 84 guidance for a missing sibling PS1.'
    $localBootstrapInvocationSentinel = Join-Path $fixtureRoot 'local-bootstrap-invoked.txt'
    $localBootstrapFixtureText = @(
        'param([switch]$VerificationOnly)'
        ('[IO.File]::WriteAllText(''{0}'', ''invoked'', [Text.Encoding]::ASCII)' -f $localBootstrapInvocationSentinel.Replace("'", "''"))
        'exit 1'
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $localBootstrapRoot 'Start-revAgent-Update.ps1'), ($localBootstrapFixtureText + "`r`n"), $ascii)
    $localMissingStateResult = Invoke-CmdFixture -CommandPath $localFixtureLauncher -Environment @{ ProgramData = $localProgramData }
    Assert-True ($localMissingStateResult.exitCode -eq 84 -and $localMissingStateResult.stdout -match 'bootstrap state is not installed' -and $localMissingStateResult.stdout -match [regex]::Escape($administratorContact) -and $localMissingStateResult.stdout -match [regex]::Escape($machinePrestageMessage) -and -not (Test-Path -LiteralPath $localBootstrapInvocationSentinel) -and -not (Test-Path -LiteralPath $maliciousInvocationSentinel) -and -not (Test-Path -LiteralPath $localRefreshSentinel)) 'Protected local launcher did not fail before verification with IT-prestage-kit exit 84 guidance for a missing sibling state.'
    [IO.File]::WriteAllText((Join-Path $localBootstrapRoot 'bootstrap-state.json'), '{"release":{"channel":"stable"}}', $ascii)
    $localFixtureResult = Invoke-CmdFixture -CommandPath $localFixtureLauncher -Environment @{
        ProgramData = $localProgramData
    }
    Assert-True ($localFixtureResult.exitCode -eq 84 -and $localFixtureResult.stdout -match 'Fixture channel: stable' -and $localFixtureResult.stdout -match [regex]::Escape($localTrustMessage) -and $localFixtureResult.stdout -match [regex]::Escape($administratorContact) -and $localFixtureResult.stdout -match [regex]::Escape($machinePrestageMessage) -and (Test-Path -LiteralPath $localRefreshSentinel -PathType Leaf)) ("Protected local launcher did not resolve its sibling state and pass IT-prestage-kit exit code 84 through its refresh path. exit={0} stdout={1} stderr={2}" -f $localFixtureResult.exitCode, ($localFixtureResult.stdout -replace '[\r\n]+', ' | '), ($localFixtureResult.stderr -replace '[\r\n]+', ' | '))
    Remove-Item -LiteralPath $localRefreshSentinel -Force
    $localFixtureRefresh78 = Join-Path $fixtureRoot 'local-refresh-78.cmd'
    [IO.File]::WriteAllText($localFixtureRefresh78, "@echo off`r`nexit /b 78`r`n", $ascii)
    $localFixtureLauncher78 = Join-Path $localBootstrapRoot 'Start-revAgent-Update-78.cmd'
    [IO.File]::WriteAllText($localFixtureLauncher78, $localLauncherText.Replace($canonicalLocalRefreshLine, ('set "STABLE_REFRESH={0}"' -f $localFixtureRefresh78)), $ascii)
    $localFixture78Result = Invoke-CmdFixture -CommandPath $localFixtureLauncher78 -Environment @{ ProgramData = $localProgramData }
    Assert-True ($localFixture78Result.exitCode -eq 78) 'Protected local launcher collapsed a distinct refresh exit code instead of preserving it.'

    $localCurrentInvocationLog = Join-Path $fixtureRoot 'local-current-bootstrap-invocations.txt'
    $localCurrentBootstrapText = @(
        'param([switch]$VerificationOnly)'
        '$mode = if ($VerificationOnly) { "verification" } else { "normal" }'
        ('[IO.File]::AppendAllText(''{0}'', $mode + [Environment]::NewLine, [Text.Encoding]::ASCII)' -f $localCurrentInvocationLog.Replace("'", "''"))
        'if ($VerificationOnly) { exit 0 }'
        'exit 37'
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $localBootstrapRoot 'Start-revAgent-Update.ps1'), ($localCurrentBootstrapText + "`r`n"), $ascii)
    $localCurrentResult = Invoke-CmdFixture -CommandPath $localFixtureLauncher -Environment @{ ProgramData = $localProgramData }
    $localCurrentInvocations = if (Test-Path -LiteralPath $localCurrentInvocationLog -PathType Leaf) { @([IO.File]::ReadAllLines($localCurrentInvocationLog)) } else { @() }
    Assert-True ($localCurrentResult.exitCode -eq 37 -and $localCurrentInvocations.Count -eq 2 -and $localCurrentInvocations[0] -eq 'verification' -and $localCurrentInvocations[1] -eq 'normal') 'Protected local launcher did not preserve the exact normal-child exit after sibling verification.'
    Assert-True (-not (Test-Path -LiteralPath $localRefreshSentinel) -and -not (Test-Path -LiteralPath $maliciousInvocationSentinel)) 'Protected local current path called refresh or executed the caller-controlled ProgramData bootstrap.'

    Write-Host 'Test G7-G9 static production wiring'
    $mainAst = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-RevAgentBootstrapRefreshMain' }, $true))[0]
    Assert-True ($mainAst.Extent.Text -match 'Initialize-TrustedPowerShellModules' -and $mainAst.Extent.Text -match 'Get-RevAgentBootstrapTrustClientContext' -and $mainAst.Extent.Text -match 'New-RevAgentBootstrapAuthenticatedInbox' -and $mainAst.Extent.Text -match 'New-RevAgentBootstrapTrustRequest' -and $mainAst.Extent.Text -match 'Start-RevAgentBootstrapTrustBrokerTask' -and $mainAst.Extent.Text -match 'Wait-RevAgentBootstrapTrustResult' -and $mainAst.Extent.Text -match 'Start-RevAgentPostRefreshLauncher') 'Production bootstrap refresh main is not wired to the complete E2 trust-core dispatch.'
    Assert-True ($mainAst.Extent.Text.IndexOf('Initialize-TrustedPowerShellModules') -lt $mainAst.Extent.Text.IndexOf('New-RevAgentBootstrapAuthenticatedInbox')) 'Trusted modules must initialize before authenticated inbox staging.'
    Assert-True ($mainAst.Extent.Text -match '-TimeoutSeconds 600' -and $sourceText -match '\$script:RevAgentExitCoordinatorAlreadyRunning = 80' -and $sourceText -match '\$script:RevAgentExitCoordinatorTimeout = 81') 'Broker duplicate and bounded-wait exit codes are missing or not unique.'
    Assert-True ($mainAst.Extent.Text -match 'Remove-RevAgentBootstrapTrustClientArtifacts' -and $mainAst.Extent.Text -match 'Remove-RevAgentBootstrapAuthenticatedInbox' -and $mainAst.Extent.Text -match 'Remove-StaleRevAgentBootstrapTemporaryItems') 'E2 finally cleanup is not wired to client artifacts, inbox, and K2 TEMP sweep.'
    Assert-True ($sourceText -notmatch 'Remove-Item[^\r\n]*-Recurse' -and $sourceText -match 'Clear-RevAgentBootstrapTemporaryDirectoryNoFollow' -and $sourceText -match 'FILE_FLAG_OPEN_REPARSE_POINT') 'Bootstrap TEMP cleanup regressed from bounded no-follow deletion to recursive path deletion.'
    Assert-True ($sourceText -notmatch 'ElevatedApply|CoordinatorRelaunchedFromAdmin|ExpectedEvidenceSha256|ExpectedInstallerSha256|ExpectedRefreshScriptSha256|TrustedKeysSource|Start-LimitedCoordinatorFromAdministrator|Start-ElevatedApply|Invoke-AuthenticatedBootstrapApply|New-RevAgentElevatedRefreshVerifierEncodedCommand|NativeErrorCode\s+-eq\s+1223|RunLevel Limited') 'Dormant UAC/de-elevation/caller-trust transport was not removed.'
    Assert-True ($sourceText -notmatch '\$script:RevAgentExitUacDeclined\s*=\s*79|\$script:RevAgentExitUacDisabled\s*=\s*82') 'Removed UAC exit codes 79 and 82 remain active.'
    Assert-True ($sourceText -notmatch '(?i)-EncodedCommand') 'G6 forbids EncodedCommand in the activated bootstrap refresh.'
    Assert-True ($sourceText -notmatch '(?is)-File\s+[''"]?\\\\') 'G6 forbids launching a UNC path through PowerShell -File.'
    Assert-True ($sourceText -notmatch 'New-ScheduledTaskAction|New-ScheduledTaskPrincipal|Register-ScheduledTask|Unregister-ScheduledTask') 'Refresh must start only the fixed IT-prestaged broker task; it must never register a per-attempt task.'

    $friendlyLauncherExitMessages = [ordered]@{
        '80' = 'trust broker request is already running'
        '81' = 'trust broker is still running'
        '84' = 'machine trust core is missing or unhealthy'
    }
    Assert-True ($refreshCmdText -match [regex]::Escape('set "REFRESH_EXIT=%ERRORLEVEL%"') -and $refreshCmdText -match [regex]::Escape('exit /b %REFRESH_EXIT%')) 'Refresh CMD must capture and return the exact PowerShell exit code.'
    Assert-True ($stableLauncherText -match [regex]::Escape('setlocal EnableExtensions EnableDelayedExpansion') -and ([regex]::Matches($stableLauncherText, [regex]::Escape('set "REFRESH_EXIT=!ERRORLEVEL!"'))).Count -eq 2 -and ([regex]::Matches($stableLauncherText, [regex]::Escape('exit /b !REFRESH_EXIT!'))).Count -eq 2) 'STABLE launcher must capture refresh results safely inside both parenthesized paths and return the exact code.'
    foreach ($exitCode in $friendlyLauncherExitMessages.Keys) {
        $refreshBranch = 'if "%REFRESH_EXIT%"=="{0}"' -f $exitCode
        $stableBranch = 'if "%REVAGENT_FAILURE_CODE%"=="{0}"' -f $exitCode
        $messageFragment = [string]$friendlyLauncherExitMessages[$exitCode]
        Assert-True ($refreshCmdText -match [regex]::Escape($refreshBranch) -and $refreshCmdText -match [regex]::Escape($messageFragment)) "Refresh CMD lost its distinct friendly exit-code $exitCode branch."
        Assert-True ($stableLauncherText -match [regex]::Escape($stableBranch) -and $stableLauncherText -match [regex]::Escape($messageFragment)) "STABLE launcher lost its distinct friendly exit-code $exitCode branch."
    }
    $languageModeProbePrefix = '$mode=$ExecutionContext.SessionState.LanguageMode'
    $knownFolderProbeCall = '[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)'
    Assert-True ($stableLauncherText.IndexOf($languageModeProbePrefix) -ge 0 -and $stableLauncherText.IndexOf($languageModeProbePrefix) -lt $stableLauncherText.IndexOf($knownFolderProbeCall) -and $stableLauncherText -match 'REVAGENT_LANGUAGE_MODE=' -and $stableLauncherText -match 'REVAGENT_COMMON_APP_DATA=' -and $stableLauncherText -match 'PowerShell is in !REVAGENT_LANGUAGE_MODE! mode' -and $stableLauncherText -match 'exit /b 78' -and $stableLauncherText -notmatch '%ProgramData%') 'STABLE launcher must emit a parseable real LanguageMode sentinel and exact exit 78 before its FullLanguage-only canonical CommonApplicationData call.'
    Assert-True ($refreshCmdText.IndexOf($languageModeProbePrefix) -ge 0 -and $refreshCmdText.IndexOf($languageModeProbePrefix) -lt $refreshCmdText.IndexOf($knownFolderProbeCall) -and $refreshCmdText -match 'REVAGENT_LANGUAGE_MODE=' -and $refreshCmdText -match 'REVAGENT_COMMON_APP_DATA=' -and $refreshCmdText -match 'PowerShell is in %REVAGENT_LANGUAGE_MODE% mode' -and $refreshCmdText -match 'exit /b 78' -and $refreshCmdText -notmatch '%ProgramData%') 'Refresh CMD must emit a parseable real LanguageMode sentinel and exact exit 78 before its FullLanguage-only canonical CommonApplicationData call.'
    Assert-True ($localLauncherText -match [regex]::Escape('set "BOOTSTRAP=%~dp0Start-revAgent-Update.ps1"') -and $localLauncherText -match [regex]::Escape('set "BOOTSTRAP_STATE=%~dp0bootstrap-state.json"') -and $localLauncherText -notmatch '(?:%ProgramData%|\$env:ProgramData)') 'Protected local launcher must bind its PS1 and state to protected siblings.'
    Assert-True (([regex]::Matches($localLauncherText, [regex]::Escape('set "REFRESH_EXIT=!ERRORLEVEL!"'))).Count -eq 2 -and ([regex]::Matches($localLauncherText, [regex]::Escape('exit /b !REFRESH_EXIT!'))).Count -eq 2 -and $localLauncherText -match [regex]::Escape($administratorContact)) 'Protected local launcher lost exact refresh exit propagation or stable administrator guidance.'
    Assert-True ($stableLauncherText -match [regex]::Escape('set "BOOTSTRAP_EXIT=!ERRORLEVEL!"') -and $stableLauncherText -match [regex]::Escape('exit /b !BOOTSTRAP_EXIT!') -and $stableLauncherText -notmatch 'start "revAgent"') 'STABLE launcher must synchronously preserve the verified bootstrap child exit code.'
    Assert-True ($localLauncherText -match [regex]::Escape('set "BOOTSTRAP_EXIT=!ERRORLEVEL!"') -and $localLauncherText -match [regex]::Escape('exit /b !BOOTSTRAP_EXIT!') -and $localLauncherText -notmatch 'start "revAgent"') 'Protected local launcher must synchronously preserve the verified bootstrap child exit code.'
    Assert-True ($sourceText -notmatch 'docs/BOOTSTRAP_PRESTAGE\.md' -and $refreshCmdText -notmatch 'docs/BOOTSTRAP_PRESTAGE\.md' -and $stableLauncherText -notmatch 'docs/BOOTSTRAP_PRESTAGE\.md' -and $localLauncherText -notmatch 'docs/BOOTSTRAP_PRESTAGE\.md') 'Production no-certificate guidance must not point operators to an unpublished relative docs path.'
    Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($stableLauncherPath), [byte[]][IO.File]::ReadAllBytes($legacyStableLauncherPath))) 'Canonical and legacy STABLE launchers must remain byte-identical after exit-code propagation changes.'

    Write-Host 'Updater stabilization G7-G9 tests passed.' -ForegroundColor Green
}
finally {
    if ($null -ne $permissionsModule) { Remove-Module $permissionsModule -Force -ErrorAction SilentlyContinue }
    foreach ($markerPath in $markerPaths) {
        if ([IO.File]::Exists($markerPath)) {
            try { [IO.File]::Delete($markerPath) }
            catch { }
        }
    }
    if ($null -ne $fixtureModule) { Remove-Module $fixtureModule.Name -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
