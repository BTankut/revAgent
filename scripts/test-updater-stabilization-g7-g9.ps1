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

$functionNames = @(
    'Get-Sha256Hex',
    'Test-RevAgentStringEquals',
    'Test-RevAgentStringStartsWith',
    'Quote-Arg',
    'Join-CommandLine',
    'Test-IsAdmin',
    'Get-RevAgentBootstrapExitMessage',
    'Test-RevAgentUacDeclinedException',
    'Start-RevAgentElevatedProcess',
    'Get-RevAgentTokenElevationType',
    'Get-RevAgentDeElevationCapability',
    'Write-RevAgentDeElevationFailure',
    'Get-RevAgentBootstrapTempRoot',
    'Get-RevAgentRunningRefreshScriptPath',
    'Get-RevAgentBootstrapTemporaryPathInfo',
    'Open-RevAgentBootstrapTemporaryDirectoryGuard',
    'Clear-RevAgentBootstrapTemporaryDirectoryNoFollow',
    'Remove-RevAgentBootstrapTemporaryPath',
    'Remove-RevAgentBootstrapTemporaryInput',
    'Remove-StaleRevAgentBootstrapTemporaryItems',
    'Write-RevAgentCoordinatorResultMarker',
    'Read-RevAgentCoordinatorResultMarker',
    'Find-RevAgentActiveCoordinatorTask',
    'Wait-RevAgentBootstrapCoordinator',
    'New-RevAgentElevatedRefreshVerifierEncodedCommand',
    'Start-ElevatedApply',
    'Assert-RevAgentElevatedRefreshScript',
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
        $script:RevAgentExitUacDeclined = 79
        $script:RevAgentExitCoordinatorAlreadyRunning = 80
        $script:RevAgentExitCoordinatorTimeout = 81
        $script:RevAgentExitUacDisabled = 82
        $script:RevAgentExitBootstrapTrustRequired = 84
        $script:ReleaseRoot = 'C:\fixture\release'
        $script:Channel = 'stable'
        $script:FixtureTempRoot = $FixtureTempRoot
        $script:FixtureRefreshScriptPath = $FixtureRefreshScriptPath
        function script:Get-RevAgentBootstrapTempRoot { return $script:FixtureTempRoot }
        function script:Get-RevAgentRunningRefreshScriptPath { return $script:FixtureRefreshScriptPath }
    } $fixtureRoot $sourcePath

    Write-Host 'Test dormant G7 UAC classification and active G13 fail-closed main'
    $wrappedUacDecline = [InvalidOperationException]::new('wrapper', [ComponentModel.Win32Exception]::new(1223))
    Assert-True ([bool](& $fixtureModule { param($ErrorObject) Test-RevAgentUacDeclinedException -Exception $ErrorObject } $wrappedUacDecline)) 'Nested Win32 error 1223 was not recognized as UAC cancellation.'
    $uacOutput = @(& $fixtureModule {
            function Test-IsAdmin { return $false }
            function Start-RevAgentElevatedProcess { throw [ComponentModel.Win32Exception]::new(1223) }
            Start-ElevatedApply `
                -SourceRoot 'C:\fixture\source' `
                -EvidenceSource 'C:\fixture\evidence.json' `
                -EvidenceSha256 ('A' * 64) `
                -InstallerSha256 ('B' * 64) `
                -TrustedKeysSource 'C:\fixture\keys.json'
        } 6>&1)
    $uacExitCode = @($uacOutput | Where-Object { $_ -is [int] } | Select-Object -Last 1)
    Assert-True ($uacExitCode.Count -eq 1 -and [int]$uacExitCode[0] -eq 79) 'Dormant future-broker UAC cancellation coverage did not preserve exit code 79.'

    foreach ($elevatedMode in @($false, $true)) {
        $failClosedOutput = @(& $fixtureModule {
                param([bool]$ElevatedMode)
                $script:ElevatedApply = $ElevatedMode
                function Start-ElevatedApply { throw 'Production main reached dormant automatic apply.' }
                Invoke-RevAgentBootstrapRefreshMain
            } $elevatedMode 6>&1)
        $failClosedExitCode = @($failClosedOutput | Where-Object { $_ -is [int] } | Select-Object -Last 1)
        Assert-True ($failClosedExitCode.Count -eq 1 -and [int]$failClosedExitCode[0] -eq 84) 'Unsigned production bootstrap refresh main did not fail closed with exit code 84.'
        Assert-True ((@($failClosedOutput | ForEach-Object { [string]$_ }) -join ' ') -match 'no Authenticode or IT-managed trust anchor') 'Unsigned production bootstrap refresh main did not emit the supervised-prestage guidance.'
    }

    Write-Host 'Test dormant G6 verifier remains locally hash-bound for a future signed broker'
    $sourceRefreshSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash
    $encodedVerifier = & $fixtureModule {
        param($Path, $Sha256)
        New-RevAgentElevatedRefreshVerifierEncodedCommand `
            -ScriptPath $Path `
            -ExpectedSha256 $Sha256 `
            -ScriptArguments @('-ElevatedApply', '-ExpectedRefreshScriptSha256', $Sha256)
    } $sourcePath $sourceRefreshSha256
    $verifierText = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([string]$encodedVerifier))
    $payloadMarker = "FromBase64String('"
    $payloadStart = $verifierText.IndexOf($payloadMarker, [StringComparison]::Ordinal) + $payloadMarker.Length
    $payloadEnd = $verifierText.IndexOf("')", $payloadStart, [StringComparison]::Ordinal)
    Assert-True ($payloadStart -ge $payloadMarker.Length -and $payloadEnd -gt $payloadStart) 'Dormant elevated verifier did not contain a complete bound payload.'
    $payloadBase64 = $verifierText.Substring($payloadStart, $payloadEnd - $payloadStart)
    $verifierPayload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payloadBase64)) | ConvertFrom-Json
    Assert-True ([string]::Equals([string]$verifierPayload.scriptPath, $sourcePath, [StringComparison]::OrdinalIgnoreCase) -and [string]$verifierPayload.expectedSha256 -eq $sourceRefreshSha256) 'Dormant elevated verifier payload did not bind its local script path to the parent-computed SHA-256.'
    Assert-True ([string]$verifierPayload.childArguments -match '-ExpectedRefreshScriptSha256' -and [string]$verifierPayload.childArguments -match [regex]::Escape($sourceRefreshSha256)) 'Dormant elevated verifier child arguments lost the self-hash binding.'
    Assert-True ($verifierText -match '\[IO\.FileShare\]::Read' -and $verifierText -match '\$child\.WaitForExit\(\)') 'Dormant elevated verifier does not hold a no-write/no-delete read handle until its verified child exits.'
    & $fixtureModule { param($Path, $Sha256) Assert-RevAgentElevatedRefreshScript -ScriptPath $Path -ExpectedSha256 $Sha256 } $sourcePath $sourceRefreshSha256
    $hashMismatch = $null
    try { & $fixtureModule { param($Path) Assert-RevAgentElevatedRefreshScript -ScriptPath $Path -ExpectedSha256 ('0' * 64) } $sourcePath }
    catch { $hashMismatch = $_ }
    Assert-True ($null -ne $hashMismatch -and [string]$hashMismatch.Exception.Message -match 'changed before administrator execution') 'Elevated self-hash verification accepted a mismatched refresh script hash.'
    $uncRejected = $null
    try { & $fixtureModule { Assert-RevAgentElevatedRefreshScript -ScriptPath '\\fixture-server\share\refresh.ps1' -ExpectedSha256 ('0' * 64) } }
    catch { $uncRejected = $_ }
    Assert-True ($null -ne $uncRejected -and [string]$uncRejected.Exception.Message -match 'refused a UNC script path') 'Elevated self-verification accepted a UNC refresh script path.'

    Write-Host 'Test G9 EnableLUA and token elevation diagnosis'
    $nativeTokenElevationType = & $fixtureModule { Get-RevAgentTokenElevationType }
    Assert-True ([string]$nativeTokenElevationType -in @('Default', 'Full', 'Limited')) 'Native TokenElevationType probing returned an invalid value.'
    & $fixtureModule {
        $script:FixtureEnableLua = 0
        $script:FixtureTokenElevationType = 'Full'
        function script:Get-ItemProperty {
            param([string]$LiteralPath, [string]$Name, [object]$ErrorAction)
            return [pscustomobject]@{ EnableLUA = $script:FixtureEnableLua }
        }
        function script:Get-RevAgentTokenElevationType { return $script:FixtureTokenElevationType }
    }
    $uacDisabled = & $fixtureModule { Get-RevAgentDeElevationCapability }
    Assert-True (-not [bool]$uacDisabled.canDeElevate -and [string]$uacDisabled.reason -eq 'uac_disabled' -and [int]$uacDisabled.enableLUA -eq 0) 'EnableLUA=0 was not classified as non-de-elevatable.'
    $uacDisabledOutput = @(& $fixtureModule { param($Capability) Write-RevAgentDeElevationFailure -Capability $Capability } $uacDisabled 6>&1)
    Assert-True ((@($uacDisabledOutput | ForEach-Object { [string]$_ }) -join ' ') -match 'UAC disabled \(EnableLUA=0\)' -and (@($uacDisabledOutput | ForEach-Object { [string]$_ }) -join ' ') -match 'DPE revAgent administrator') 'EnableLUA=0 did not emit the stable operator remediation.'
    & $fixtureModule { $script:FixtureEnableLua = 1; $script:FixtureTokenElevationType = 'Default' }
    $defaultToken = & $fixtureModule { Get-RevAgentDeElevationCapability }
    Assert-True (-not [bool]$defaultToken.canDeElevate -and [string]$defaultToken.reason -eq 'token_elevation_type_default') 'TokenElevationTypeDefault was not classified as non-de-elevatable.'
    & $fixtureModule { $script:FixtureTokenElevationType = 'Full' }
    $splitToken = & $fixtureModule { Get-RevAgentDeElevationCapability }
    Assert-True ([bool]$splitToken.canDeElevate -and [string]$splitToken.reason -eq 'split_token_available') 'A normal UAC split token was rejected.'
    Assert-True ($sourceText -match 'EnableLUA=0' -and $sourceText -match 'DPE revAgent administrator' -and $sourceText -match '\$script:RevAgentExitUacDisabled = 82') 'The UAC-disabled operator diagnosis or dedicated exit code is missing.'

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
    & $fixtureModule { param($InputObject, $TempRoot) Remove-RevAgentBootstrapTemporaryInput -InputObject $InputObject -TempRoot $TempRoot } $cleanupInput $fixtureRoot
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
    & $fixtureModule { param($TempRoot) Remove-StaleRevAgentBootstrapTemporaryItems -TempRoot $TempRoot -MinimumAgeHours 1 } $fixtureRoot
    Assert-True ((Test-Path -LiteralPath $staleSource) -and (Test-Path -LiteralPath $staleEvidence) -and (Test-Path -LiteralPath $staleLockPath)) 'Stale cleanup removed an in-use bootstrap attempt.'
    $staleLock.Dispose()
    & $fixtureModule { param($TempRoot) Remove-StaleRevAgentBootstrapTemporaryItems -TempRoot $TempRoot -MinimumAgeHours 1 } $fixtureRoot
    Assert-True (-not (Test-Path -LiteralPath $staleSource) -and -not (Test-Path -LiteralPath $staleEvidence) -and -not (Test-Path -LiteralPath $staleLockPath)) 'Unlocked stale bootstrap TEMP items were not removed.'

    $junctionId = [Guid]::NewGuid().ToString('N')
    $junctionPath = Join-Path $fixtureRoot "revagent-bootstrap-install-source-$junctionId"
    $junctionTarget = Join-Path $fixtureRoot 'junction-target'
    New-Item -ItemType Directory -Path $junctionTarget | Out-Null
    [IO.File]::WriteAllText((Join-Path $junctionTarget 'keep.txt'), 'keep')
    New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget | Out-Null
    & $fixtureModule { param($TempRoot) Remove-StaleRevAgentBootstrapTemporaryItems -TempRoot $TempRoot -MinimumAgeHours 1 } $fixtureRoot
    Assert-True ((Test-Path -LiteralPath $junctionPath) -and (Test-Path -LiteralPath (Join-Path $junctionTarget 'keep.txt'))) 'Stale cleanup traversed or removed a reparse-point candidate.'
    [IO.Directory]::Delete($junctionPath)

    Write-Host 'Test G8 nonce marker plus task state and LastTaskResult synchronization'
    $bootstrapFixture = Join-Path $fixtureRoot 'Start-revAgent-Update.ps1'
    [IO.File]::WriteAllText($bootstrapFixture, '# fixture')
    & $fixtureModule {
        $script:FixtureTaskState = 'Ready'
        $script:FixtureLastTaskResult = 0
        function script:Get-ScheduledTask {
            param([string]$TaskName, [object]$ErrorAction)
            return [pscustomobject]@{ TaskName = $TaskName; State = $script:FixtureTaskState }
        }
        function script:Get-ScheduledTaskInfo {
            param([string]$TaskName, [object]$ErrorAction)
            return [pscustomobject]@{ LastTaskResult = $script:FixtureLastTaskResult; LastRunTime = (Get-Date).AddSeconds(-1) }
        }
        function script:Start-Sleep { param([int]$Milliseconds) }
    }

    $successNonce = [Guid]::NewGuid().ToString('N')
    $successMarker = Join-Path $fixtureRoot "revagent-bootstrap-coordinator-result-$successNonce.json"
    [void]$markerPaths.Add($successMarker)
    & $fixtureModule { param($Path, $Nonce) Write-RevAgentCoordinatorResultMarker -Path $Path -Nonce $Nonce -ExitCode 0 } $successMarker $successNonce
    $successWait = & $fixtureModule {
        param($Path, $Nonce, $BootstrapPath)
        Wait-RevAgentBootstrapCoordinator -TaskName 'fixture-task' -ResultPath $Path -Nonce $Nonce -BootstrapPath $BootstrapPath -TimeoutSeconds 0 -PollIntervalMilliseconds 1
    } $successMarker $successNonce $bootstrapFixture
    Assert-True ([bool]$successWait.completed -and -not [bool]$successWait.timedOut -and [int]$successWait.exitCode -eq 0 -and [long]$successWait.lastTaskResult -eq 0) 'Coordinator success returned before marker/task/LastTaskResult convergence.'

    & $fixtureModule { $script:FixtureLastTaskResult = 1 }
    $mismatchWait = & $fixtureModule {
        param($Path, $Nonce, $BootstrapPath)
        Wait-RevAgentBootstrapCoordinator -TaskName 'fixture-task' -ResultPath $Path -Nonce $Nonce -BootstrapPath $BootstrapPath -TimeoutSeconds 1 -PollIntervalMilliseconds 1
    } $successMarker $successNonce $bootstrapFixture
    Assert-True ([int]$mismatchWait.exitCode -eq 1 -and [string]$mismatchWait.message -match 'did not match LastTaskResult') 'Coordinator marker/LastTaskResult mismatch was accepted.'

    & $fixtureModule { $script:FixtureTaskState = 'Running'; $script:FixtureLastTaskResult = 0 }
    $wrongNonce = [Guid]::NewGuid().ToString('N')
    $wrongNonceWait = & $fixtureModule {
        param($Path, $Nonce, $BootstrapPath)
        Wait-RevAgentBootstrapCoordinator -TaskName 'fixture-task' -ResultPath $Path -Nonce $Nonce -BootstrapPath $BootstrapPath -TimeoutSeconds 0 -PollIntervalMilliseconds 1
    } $successMarker $wrongNonce $bootstrapFixture
    Assert-True (-not [bool]$wrongNonceWait.completed -and [bool]$wrongNonceWait.timedOut -and [int]$wrongNonceWait.exitCode -eq 81) 'A marker with the wrong nonce was accepted or did not use timeout code 81.'

    & $fixtureModule { $script:FixtureTaskState = 'Ready'; $script:FixtureLastTaskResult = 79 }
    $declinedNonce = [Guid]::NewGuid().ToString('N')
    $declinedMarker = Join-Path $fixtureRoot "revagent-bootstrap-coordinator-result-$declinedNonce.json"
    [void]$markerPaths.Add($declinedMarker)
    & $fixtureModule {
        param($Path, $Nonce)
        Write-RevAgentCoordinatorResultMarker -Path $Path -Nonce $Nonce -ExitCode 79 -Message 'Administrator approval was declined.'
    } $declinedMarker $declinedNonce
    $declinedWait = & $fixtureModule {
        param($Path, $Nonce, $BootstrapPath)
        Wait-RevAgentBootstrapCoordinator -TaskName 'fixture-task' -ResultPath $Path -Nonce $Nonce -BootstrapPath $BootstrapPath -TimeoutSeconds 0 -PollIntervalMilliseconds 1
    } $declinedMarker $declinedNonce $bootstrapFixture
    Assert-True ([int]$declinedWait.exitCode -eq 79 -and [long]$declinedWait.lastTaskResult -eq 79 -and [string]$declinedWait.message -match 'declined') 'Coordinator UAC-decline result was not propagated through marker and LastTaskResult.'

    $activeTask = & $fixtureModule {
        Find-RevAgentActiveCoordinatorTask -Tasks @(
            [pscustomobject]@{ TaskName = 'old'; State = 'Ready' },
            [pscustomobject]@{ TaskName = 'active'; State = 'Queued' }
        )
    }
    Assert-True ([string]$activeTask.TaskName -eq 'active') 'Queued/running coordinator detection did not prevent a duplicate task.'

    Write-Host 'Test launcher trust boundaries and exit-code propagation with real CMD children'
    $ascii = [Text.ASCIIEncoding]::new()
    $trustMessage = 'independent Windows signing trust anchor is unavailable'
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
    Assert-True ($refreshFixtureResult.exitCode -eq 84 -and $refreshFixtureResult.stdout -match [regex]::Escape($trustMessage) -and $refreshFixtureResult.stdout -match [regex]::Escape($administratorContact)) 'Refresh CMD did not preserve exit code 84 with its stable administrator guidance.'

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
    Assert-True ($stableFixtureResult.exitCode -eq 84 -and $stableFixtureResult.stdout -match [regex]::Escape($trustMessage) -and $stableFixtureResult.stdout -match [regex]::Escape($administratorContact) -and (Test-Path -LiteralPath $stableRefreshSentinel -PathType Leaf)) 'STABLE launcher did not preserve exit code 84 with its stable administrator guidance.'

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
    Assert-True ($localMissingScriptResult.exitCode -eq 84 -and $localMissingScriptResult.stdout -match 'bootstrap is not installed' -and $localMissingScriptResult.stdout -match [regex]::Escape($administratorContact) -and -not (Test-Path -LiteralPath $maliciousInvocationSentinel) -and -not (Test-Path -LiteralPath $localRefreshSentinel)) 'Protected local launcher did not give stable exit 84 guidance for a missing sibling PS1.'
    $localBootstrapInvocationSentinel = Join-Path $fixtureRoot 'local-bootstrap-invoked.txt'
    $localBootstrapFixtureText = @(
        'param([switch]$VerificationOnly)'
        ('[IO.File]::WriteAllText(''{0}'', ''invoked'', [Text.Encoding]::ASCII)' -f $localBootstrapInvocationSentinel.Replace("'", "''"))
        'exit 1'
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $localBootstrapRoot 'Start-revAgent-Update.ps1'), ($localBootstrapFixtureText + "`r`n"), $ascii)
    $localMissingStateResult = Invoke-CmdFixture -CommandPath $localFixtureLauncher -Environment @{ ProgramData = $localProgramData }
    Assert-True ($localMissingStateResult.exitCode -eq 84 -and $localMissingStateResult.stdout -match 'bootstrap state is not installed' -and $localMissingStateResult.stdout -match [regex]::Escape($administratorContact) -and -not (Test-Path -LiteralPath $localBootstrapInvocationSentinel) -and -not (Test-Path -LiteralPath $maliciousInvocationSentinel) -and -not (Test-Path -LiteralPath $localRefreshSentinel)) 'Protected local launcher did not fail before verification with stable exit 84 guidance for a missing sibling state.'
    [IO.File]::WriteAllText((Join-Path $localBootstrapRoot 'bootstrap-state.json'), '{"release":{"channel":"stable"}}', $ascii)
    $localFixtureResult = Invoke-CmdFixture -CommandPath $localFixtureLauncher -Environment @{
        ProgramData = $localProgramData
    }
    Assert-True ($localFixtureResult.exitCode -eq 84 -and $localFixtureResult.stdout -match 'Fixture channel: stable' -and $localFixtureResult.stdout -match [regex]::Escape($trustMessage) -and $localFixtureResult.stdout -match [regex]::Escape($administratorContact) -and (Test-Path -LiteralPath $localRefreshSentinel -PathType Leaf)) ("Protected local launcher did not resolve its sibling state and pass exit code 84 through its refresh path. exit={0} stdout={1} stderr={2}" -f $localFixtureResult.exitCode, ($localFixtureResult.stdout -replace '[\r\n]+', ' | '), ($localFixtureResult.stderr -replace '[\r\n]+', ' | '))
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
    $startLimitedAst = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-LimitedCoordinatorFromAdministrator' }, $true))[0]
    $startElevatedAst = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-ElevatedApply' }, $true))[0]
    $encodedVerifierAst = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-RevAgentElevatedRefreshVerifierEncodedCommand' }, $true))[0]
    $mainAst = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-RevAgentBootstrapRefreshMain' }, $true))[0]
    Assert-True ($startLimitedAst.Extent.Text -match 'Find-RevAgentActiveCoordinatorTask' -and $startLimitedAst.Extent.Text -match 'Wait-RevAgentBootstrapCoordinator' -and $startLimitedAst.Extent.Text -match "'-CoordinatorNonce'" -and $startLimitedAst.Extent.Text -match "'-CoordinatorResultPath'") 'Coordinator duplicate guard or nonce-bound wait is not wired into production.'
    Assert-True ($startLimitedAst.Extent.Text -match '-TimeoutSeconds 600' -and $sourceText -match '\$script:RevAgentExitCoordinatorAlreadyRunning = 80' -and $sourceText -match '\$script:RevAgentExitCoordinatorTimeout = 81') 'Coordinator bounded wait codes are missing or not unique.'
    Assert-True ($mainAst.Extent.Text -match 'Write-Host \(Get-RevAgentBootstrapExitMessage -ExitCode \$script:RevAgentExitBootstrapTrustRequired\)' -and $mainAst.Extent.Text -match 'return \$script:RevAgentExitBootstrapTrustRequired' -and $mainAst.Extent.Text -notmatch 'Test-IsAdmin|Start-LimitedCoordinatorFromAdministrator|Start-ElevatedApply|Invoke-AuthenticatedBootstrapApply|New-CleanInstallBootstrapInput|Get-ProtectedBootstrapState') 'Production bootstrap refresh main must unconditionally fail closed with exit code 84 before all automatic coordinator, UAC, and apply paths.'
    Assert-True ($sourceText -notmatch '(?m)^\s*Initialize-TrustedPowerShellModules\s*$') 'Production bootstrap refresh initialized optional trusted modules before its unconditional exit 84 trust stop.'
    Assert-True ($sourceText -notmatch 'Remove-Item[^\r\n]*-Recurse' -and $sourceText -match 'Clear-RevAgentBootstrapTemporaryDirectoryNoFollow' -and $sourceText -match 'FILE_FLAG_OPEN_REPARSE_POINT') 'Bootstrap TEMP cleanup regressed from bounded no-follow deletion to recursive path deletion.'
    Assert-True ($sourceText -match '\$script:RevAgentExitUacDeclined = 79' -and $sourceText -match 'NativeErrorCode\s+-eq\s+1223') 'UAC decline no longer has its dedicated code/classification.'
    Assert-True ($startElevatedAst.Extent.Text -match 'New-RevAgentElevatedRefreshVerifierEncodedCommand' -and $startElevatedAst.Extent.Text -match "'-EncodedCommand'" -and $startElevatedAst.Extent.Text -notmatch "'-File',\s*\`$(?:PSCommandPath|stagedRefreshScript)") 'Dormant future-broker apply helper lost the G6 locally staged, encoded-verifier elevation contract.'
    Assert-True ($encodedVerifierAst.Extent.Text -match '\[IO\.FileShare\]::Read' -and $encodedVerifierAst.Extent.Text -match '\$child\.WaitForExit\(\)' -and $sourceText -match 'function Assert-RevAgentElevatedRefreshScript') 'Dormant G6 verifier or elevated self-hash guard was removed instead of being retained for a future signed broker.'

    $friendlyLauncherExitMessages = [ordered]@{
        '79' = 'Administrator approval was declined'
        '80' = 'coordinator is already running'
        '81' = 'coordinator is still running'
        '82' = 'UAC disabled'
        '84' = 'independent Windows signing trust anchor is unavailable'
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
