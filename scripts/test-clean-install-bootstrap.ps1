<#
.SYNOPSIS
    Execute clean-machine authenticated input production, supervised mocked
    elevation/apply, fail-closed self-service, and GUI pre-window fixtures.
#>

[CmdletBinding()]
param([string]$RepoRoot = "")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$refreshPath = Join-Path $RepoRoot 'installer\nas\Refresh-revAgent-LocalBootstrap-STABLE.ps1'
$windowsPowerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('revagent-clean-install-fixture-' + [Guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $fixtureRoot 'revAgent-deploy'
$packageSource = Join-Path $fixtureRoot 'package-source'
$packagePath = Join-Path $releaseRoot 'releases\fixture\revagent-fixture.zip'
$channelPath = Join-Path $releaseRoot 'channels\stable.json'
$trustedKeysPath = Join-Path $releaseRoot 'tools\config\release-trusted-keys.json'
$bootstrapTempRoot = Join-Path $fixtureRoot 'bootstrap-temp'
$bootstrapRoot = Join-Path $fixtureRoot 'protected-bootstrap'
$fixtureProgramDataRoot = Join-Path $fixtureRoot 'programdata'
$desktopRoot = Join-Path $fixtureRoot 'desktop'
$applySentinel = Join-Path $fixtureRoot 'mock-elevated-apply.json'
$fixtureModule = $null
$cleanInput = $null

[void][IO.Directory]::CreateDirectory($packageSource)
[void][IO.Directory]::CreateDirectory((Split-Path -Parent $packagePath))
[void][IO.Directory]::CreateDirectory((Split-Path -Parent $channelPath))
[void][IO.Directory]::CreateDirectory((Split-Path -Parent $trustedKeysPath))
[void][IO.Directory]::CreateDirectory($bootstrapTempRoot)

try {
    Write-Host 'Build clean-install signed-release fixture'
    $packageFiles = [ordered]@{
        'installer\nas\install-revagent-local-bootstrap.ps1' = 'scripts\install-revagent-local-bootstrap.ps1'
        'installer\nas\Start-revAgent-Update.ps1' = 'installer\nas\Start-revAgent-Update.ps1'
        'installer\nas\Start-revAgent-Update.cmd' = 'installer\nas\Start-revAgent-Update.cmd'
        'installer\nas\Install-revAgent-Updater-GUI.ps1' = 'installer\nas\Install-revAgent-Updater-GUI.ps1'
        'installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1' = 'installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1'
        'installer\lib\RevAgent.LocalBootstrap.psm1' = 'installer\lib\RevAgent.LocalBootstrap.psm1'
        'installer\lib\RevAgent.DistributionIntegrity.psm1' = 'installer\lib\RevAgent.DistributionIntegrity.psm1'
        'installer\lib\RevAgent.Permissions.psm1' = 'installer\lib\RevAgent.Permissions.psm1'
        'installer\lib\RevAgent.SourceFreeMigration.psm1' = 'installer\lib\RevAgent.SourceFreeMigration.psm1'
        'installer\lib\RevAgent.ReleaseSnapshot.psm1' = 'installer\lib\RevAgent.ReleaseSnapshot.psm1'
    }
    foreach ($entry in $packageFiles.GetEnumerator()) {
        $source = Join-Path $RepoRoot ([string]$entry.Value)
        $destination = Join-Path $packageSource ([string]$entry.Key)
        Assert-True (Test-Path -LiteralPath $source -PathType Leaf) "Clean-install package source is missing: $source"
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
        [IO.File]::Copy($source, $destination, $false)
    }

    # Keep the production installer logic, but bind its output paths to this
    # disposable fixture so the isolated supervised-apply test cannot touch
    # the workstation's real protected bootstrap.
    $fixtureInstallerPath = Join-Path $packageSource 'installer\nas\install-revagent-local-bootstrap.ps1'
    $fixtureInstallerText = [IO.File]::ReadAllText($fixtureInstallerPath)
    $fixtureBootstrapLiteral = $bootstrapRoot.Replace("'", "''")
    $fixtureDesktopLiteral = $desktopRoot.Replace("'", "''")
    $fixtureSentinelLiteral = $applySentinel.Replace("'", "''")
    $fixtureInstallerSetup = @"
`$ErrorActionPreference = "Stop"
`$BootstrapRoot = '$fixtureBootstrapLiteral'
`$DesktopShortcutRoot = '$fixtureDesktopLiteral'
`$AllowTestRoot = `$true
"@
    $fixtureInstallerPatched = $fixtureInstallerText.Replace('$ErrorActionPreference = "Stop"', $fixtureInstallerSetup.TrimEnd())
    Assert-True (-not [string]::Equals($fixtureInstallerPatched, $fixtureInstallerText, [StringComparison]::Ordinal)) 'Could not bind the fixture installer to disposable output roots.'
    $fixtureInstallerPatched += "`r`n[IO.File]::WriteAllText('$fixtureSentinelLiteral', '{`"completed`":true}', [Text.UTF8Encoding]::new(`$false))`r`n"
    [IO.File]::WriteAllText($fixtureInstallerPath, $fixtureInstallerPatched, [Text.UTF8Encoding]::new($false))

    $evidenceToolPath = Join-Path $packageSource 'installer\nas\New-RevAgentBootstrapPrestageEvidence.ps1'
    [IO.File]::WriteAllText($evidenceToolPath, @'
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Channel
)
$ErrorActionPreference = 'Stop'
$sourceFiles = [ordered]@{
    bootstrap = 'installer\nas\Start-revAgent-Update.ps1'
    launcher = 'installer\nas\Start-revAgent-Update.cmd'
    updaterGui = 'installer\nas\Install-revAgent-Updater-GUI.ps1'
    distributionIntegrity = 'installer\lib\RevAgent.DistributionIntegrity.psm1'
    permissions = 'installer\lib\RevAgent.Permissions.psm1'
    sourceFreeMigration = 'installer\lib\RevAgent.SourceFreeMigration.psm1'
    releaseSnapshot = 'installer\lib\RevAgent.ReleaseSnapshot.psm1'
    privilegedSnapshotUpdate = 'installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1'
}
$sourceHashes = [ordered]@{}
foreach ($entry in $sourceFiles.GetEnumerator()) {
    $sourceHashes[[string]$entry.Key] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $RepoRoot ([string]$entry.Value))).Hash
}
$sourceHashes.trustedKeys = (Get-FileHash -Algorithm SHA256 -LiteralPath $TrustedKeysPath).Hash
$installerPath = Join-Path $RepoRoot 'installer\nas\install-revagent-local-bootstrap.ps1'
$modulePath = Join-Path $RepoRoot 'installer\lib\RevAgent.LocalBootstrap.psm1'
$evidence = [ordered]@{
    schemaVersion = 1
    app = 'revAgent'
    evidenceType = 'bootstrap-prestage'
    producerMode = 'unelevated-coordinator'
    supervisedAdminPrestage = $false
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    generatedBySid = 'S-1-5-19'
    release = [ordered]@{
        root = $ReleaseRoot
        channel = $Channel
        version = '2099.01.01.clean-fixture'
        releaseSequence = 100
        minimumAcceptedReleaseSequence = 1
        highestAcceptedReleaseSequence = 100
        channelManifestSha256 = ('A' * 64)
        releaseManifestSha256 = ('B' * 64)
        packageSha256 = ('C' * 64)
        signatureVerified = $true
    }
    localBootstrapInstallerScript = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash
    localBootstrapInstallerModule = (Get-FileHash -Algorithm SHA256 -LiteralPath $modulePath).Hash
    sources = $sourceHashes
}
[IO.File]::WriteAllText($OutputPath, ($evidence | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ outputSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash }
'@, [Text.UTF8Encoding]::new($false))

    [IO.File]::WriteAllText($trustedKeysPath, '{"schemaVersion":1,"keys":[]}', [Text.UTF8Encoding]::new($false))
    Microsoft.PowerShell.Archive\Compress-Archive -Path (Join-Path $packageSource '*') -DestinationPath $packagePath -Force
    $packageSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash
    $channel = [ordered]@{
        channel = 'stable'
        version = '2099.01.01.clean-fixture'
        releaseSequence = 100
        packagePath = '..\releases\fixture\revagent-fixture.zip'
        sha256 = $packageSha256
    }
    [IO.File]::WriteAllText($channelPath, ($channel | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))

    $tokens = $null
    $parseErrors = $null
    $refreshAst = [Management.Automation.Language.Parser]::ParseFile($refreshPath, [ref]$tokens, [ref]$parseErrors)
    Assert-True (@($parseErrors).Count -eq 0) 'Clean-install refresh source did not parse.'
    $functionNames = @(
        'Get-Sha256Hex',
        'Test-RevAgentStringEquals',
        'Test-RevAgentStringStartsWith',
        'Get-RevAgentProgramDataRoot',
        'Get-RevAgentBootstrapExitMessage',
        'Resolve-ReleaseRootChildPath',
        'New-CleanInstallBootstrapInput',
        'Start-ElevatedApply',
        'Invoke-AuthenticatedBootstrapApply',
        'Invoke-RevAgentBootstrapRefreshMain'
    )
    $functionAsts = @($refreshAst.FindAll({
                param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $functionNames
            }, $true))
    Assert-True ($functionAsts.Count -eq $functionNames.Count) 'Clean-install production functions could not be loaded for executable coverage.'
    $fixtureModule = New-Module -ScriptBlock ([scriptblock]::Create((@($functionAsts | ForEach-Object { $_.Extent.Text }) -join "`r`n`r`n")))

    & $fixtureModule {
        param($FixtureReleaseRoot, $FixtureTempRoot, $FixtureBootstrapRoot, $FixtureProgramDataRoot, $FixtureDesktopRoot, $FixtureSentinel)
        $script:ReleaseRoot = $FixtureReleaseRoot
        $script:Channel = 'stable'
        $script:FixtureTempRoot = $FixtureTempRoot
        $script:FixtureBootstrapRoot = $FixtureBootstrapRoot
        $script:FixtureProgramDataRoot = $FixtureProgramDataRoot
        $script:FixtureDesktopRoot = $FixtureDesktopRoot
        $script:FixtureSentinel = $FixtureSentinel
        $script:RevAgentExitBootstrapTrustRequired = 84
        function script:Get-RevAgentBootstrapTempRoot { return $script:FixtureTempRoot }
        function script:Remove-RevAgentBootstrapTemporaryInput { param([object]$InputObject, [string]$TempRoot) }
        function script:Get-RevAgentProgramDataRoot { return $script:FixtureProgramDataRoot }
        function script:Set-AdminOnlyAcl { param([string]$Path) }
        function script:Test-IsAdmin { return $true }
    } $releaseRoot $bootstrapTempRoot $bootstrapRoot $fixtureProgramDataRoot $desktopRoot $applySentinel

    Write-Host 'Execute New-CleanInstallBootstrapInput against the fixture ZIP'
    $cleanInput = & $fixtureModule { New-CleanInstallBootstrapInput }
    Assert-True ($null -ne $cleanInput) 'Clean-install acquisition did not return authenticated input.'
    foreach ($path in @($cleanInput.SourceRoot, $cleanInput.EvidenceSource, $cleanInput.TrustedKeysSource)) {
        Assert-True ([IO.Path]::GetFullPath([string]$path).StartsWith([IO.Path]::GetFullPath($bootstrapTempRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) "Clean-install input escaped the fixture TEMP root: $path"
    }
    Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $cleanInput.EvidenceSource).Hash -eq [string]$cleanInput.EvidenceSha256) 'Clean-install evidence result hash is not bound to the produced file.'
    $extractedInstaller = Join-Path $cleanInput.SourceRoot 'installer\nas\install-revagent-local-bootstrap.ps1'
    Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $extractedInstaller).Hash -eq [string]$cleanInput.InstallerSha256) 'Clean-install installer result hash is not bound to the extracted installer.'
    Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $cleanInput.TrustedKeysSource).Hash -eq (Get-FileHash -Algorithm SHA256 -LiteralPath $trustedKeysPath).Hash) 'Clean-install trusted keys were not copied byte-for-byte before elevation.'

    Write-Host 'Execute supervised isolated manual apply into a protected fixture bootstrap'
    & $fixtureModule {
        param($InputObject)
        Invoke-AuthenticatedBootstrapApply `
            -SourceRoot ([string]$InputObject.SourceRoot) `
            -EvidenceSource ([string]$InputObject.EvidenceSource) `
            -ExpectedEvidenceSha256 ([string]$InputObject.EvidenceSha256) `
            -ExpectedInstallerSha256 ([string]$InputObject.InstallerSha256) `
            -TrustedKeysSource ([string]$InputObject.TrustedKeysSource)
    } $cleanInput
    $installedStatePath = Join-Path $bootstrapRoot 'bootstrap-state.json'
    Assert-True (Test-Path -LiteralPath $applySentinel -PathType Leaf) 'Supervised isolated manual apply did not complete its staged installer.'
    Assert-True (Test-Path -LiteralPath $installedStatePath -PathType Leaf) 'Supervised isolated manual apply did not install the fixture bootstrap.'
    $installedState = Get-Content -Raw -LiteralPath $installedStatePath | ConvertFrom-Json
    Assert-True ([bool]$installedState.sourceAuthentication.independentlyAuthenticated) 'Supervised isolated manual apply did not preserve independently authenticated bootstrap state.'

    Write-Host 'Execute protected GUI pre-window chain in a fresh Windows PowerShell 5.1 child'
    $protectedGui = Join-Path $bootstrapRoot 'Install-revAgent-Updater-GUI.ps1'
    $protectedState = Join-Path $bootstrapRoot 'bootstrap-state.json'
    $guiOutput = @(& $windowsPowerShell `
            -NoLogo `
            -NoProfile `
            -NonInteractive `
            -ExecutionPolicy Bypass `
            -File $protectedGui `
            -ChannelManifestPath $channelPath `
            -BootstrapStatePath $protectedState `
            -PreWindowBootstrapSmokeTest 2>&1 | ForEach-Object { [string]$_ })
    $guiExitCode = $LASTEXITCODE
    Assert-True ($guiExitCode -eq 0) "Clean-install GUI pre-window PS5 child failed. output=$($guiOutput -join ' | ')"
    $jsonLine = @($guiOutput | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1)
    Assert-True ($jsonLine.Count -eq 1) "Clean-install GUI pre-window child did not return JSON evidence. output=$($guiOutput -join ' | ')"
    $guiResult = $jsonLine[0] | ConvertFrom-Json
    Assert-True ([bool]$guiResult.success -and [string]$guiResult.action -eq 'pre-window-bootstrap-smoke-test') 'Clean-install GUI pre-window chain was not successful.'
    foreach ($loadedPath in @($guiResult.sourceFreeMigrationModule, $guiResult.releaseSnapshotModule, $guiResult.trustedKeysPath)) {
        Assert-True ([IO.Path]::GetFullPath([string]$loadedPath).StartsWith([IO.Path]::GetFullPath($bootstrapRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) "Clean-install GUI loaded evidence outside the fixture bootstrap: $loadedPath"
    }

    Write-Host 'Prove production clean-machine self-service fails closed before acquisition, elevation, or coordinator work'
    $failClosedState = & $fixtureModule {
        $script:ElevatedApply = $false
        $script:MockAcquisitionCallCount = 0
        $script:MockElevationCallCount = 0
        $script:MockApplyCallCount = 0
        $script:MockAdminProbeCallCount = 0
        $script:MockCoordinatorCallCount = 0
        $script:MockCleanupCallCount = 0
        function script:Remove-StaleRevAgentBootstrapTemporaryItems {
            $script:MockCleanupCallCount++
            throw 'Production fail-closed refresh must not perform temporary cleanup or acquisition work.'
        }
        function script:Get-RevAgentProgramDataRoot { return $script:FixtureProgramDataRoot }
        function script:New-CleanInstallBootstrapInput {
            $script:MockAcquisitionCallCount++
            throw 'Production clean-machine self-service must not prepare unanchored install input.'
        }
        function script:Start-ElevatedApply {
            param(
                [string]$SourceRoot,
                [string]$EvidenceSource,
                [string]$EvidenceSha256,
                [string]$InstallerSha256,
                [string]$TrustedKeysSource
            )
            $script:MockElevationCallCount++
            return 0
        }
        function script:Invoke-AuthenticatedBootstrapApply {
            $script:MockApplyCallCount++
            throw 'Production fail-closed refresh must not invoke authenticated apply.'
        }
        function script:Test-IsAdmin {
            $script:MockAdminProbeCallCount++
            return $true
        }
        function script:Start-LimitedCoordinatorFromAdministrator {
            $script:MockCoordinatorCallCount++
            return 0
        }

        $exitCode = Invoke-RevAgentBootstrapRefreshMain
        [pscustomobject][ordered]@{
            exitCode = [int]$exitCode
            acquisitionCallCount = $script:MockAcquisitionCallCount
            elevationCallCount = $script:MockElevationCallCount
            applyCallCount = $script:MockApplyCallCount
            adminProbeCallCount = $script:MockAdminProbeCallCount
            coordinatorCallCount = $script:MockCoordinatorCallCount
            cleanupCallCount = $script:MockCleanupCallCount
            exitMessage = Get-RevAgentBootstrapExitMessage -ExitCode ([int]$exitCode)
        }
    }
    Assert-True ([int]$failClosedState.exitCode -eq 84) "Clean-machine self-service did not return stable exit code 84: $($failClosedState.exitCode)"
    Assert-True ([int]$failClosedState.acquisitionCallCount -eq 0) 'Clean-machine fail-closed path prepared install input.'
    Assert-True ([int]$failClosedState.elevationCallCount -eq 0 -and [int]$failClosedState.applyCallCount -eq 0) 'Clean-machine fail-closed path attempted elevation/apply.'
    Assert-True ([int]$failClosedState.adminProbeCallCount -eq 0 -and [int]$failClosedState.coordinatorCallCount -eq 0) 'Clean-machine fail-closed path attempted administrator/coordinator work.'
    Assert-True ([int]$failClosedState.cleanupCallCount -eq 0) 'Clean-machine fail-closed path performed cleanup/acquisition work.'
    Assert-True ([string]$failClosedState.exitMessage -match 'no Authenticode or IT-managed trust anchor') 'Exit 84 does not explain the missing independent trust anchor.'
    Assert-True ([string]$failClosedState.exitMessage -match 'supervised manual high-assurance prestage') 'Exit 84 does not direct the operator to the supervised high-assurance flow.'
    Assert-True ([string]$failClosedState.exitMessage -match 'DPE revAgent administrator' -and [string]$failClosedState.exitMessage -notmatch 'docs/BOOTSTRAP_PRESTAGE\.md') 'Exit 84 does not provide stable field remediation through the DPE revAgent administrator.'

    Write-Host 'Prove Refresh also fails closed when a protected bootstrap state exists'
    $existingStatePath = Join-Path $fixtureProgramDataRoot 'DPE\revAgent\bootstrap\bootstrap-state.json'
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $existingStatePath))
    [IO.File]::WriteAllText($existingStatePath, '{}', [Text.UTF8Encoding]::new($false))
    $existingBootstrapState = & $fixtureModule {
        $script:MockAcquisitionCallCount = 0
        $script:MockElevationCallCount = 0
        $script:MockApplyCallCount = 0
        $script:MockAdminProbeCallCount = 0
        $script:MockCoordinatorCallCount = 0
        $script:MockCleanupCallCount = 0
        $exitCode = Invoke-RevAgentBootstrapRefreshMain
        [pscustomobject][ordered]@{
            exitCode = [int]$exitCode
            acquisitionCallCount = $script:MockAcquisitionCallCount
            elevationCallCount = $script:MockElevationCallCount
            applyCallCount = $script:MockApplyCallCount
            adminProbeCallCount = $script:MockAdminProbeCallCount
            coordinatorCallCount = $script:MockCoordinatorCallCount
            cleanupCallCount = $script:MockCleanupCallCount
        }
    }
    Assert-True ([int]$existingBootstrapState.exitCode -eq 84) "Existing-state Refresh did not fail closed with exit 84: $($existingBootstrapState.exitCode)"
    Assert-True ([int]$existingBootstrapState.acquisitionCallCount -eq 0 -and [int]$existingBootstrapState.cleanupCallCount -eq 0) 'Existing-state Refresh performed acquisition/cleanup work.'
    Assert-True ([int]$existingBootstrapState.elevationCallCount -eq 0 -and [int]$existingBootstrapState.applyCallCount -eq 0) 'Existing-state Refresh attempted elevation/apply.'
    Assert-True ([int]$existingBootstrapState.adminProbeCallCount -eq 0 -and [int]$existingBootstrapState.coordinatorCallCount -eq 0) 'Existing-state Refresh attempted administrator/coordinator work.'

    Write-Host 'Prove direct -ElevatedApply production entry also fails closed with no apply call'
    $elevatedApplyState = & $fixtureModule {
        $script:ElevatedApply = $true
        $script:MockAcquisitionCallCount = 0
        $script:MockElevationCallCount = 0
        $script:MockApplyCallCount = 0
        $script:MockAdminProbeCallCount = 0
        $script:MockCoordinatorCallCount = 0
        $script:MockCleanupCallCount = 0
        $exitCode = Invoke-RevAgentBootstrapRefreshMain
        [pscustomobject][ordered]@{
            exitCode = [int]$exitCode
            acquisitionCallCount = $script:MockAcquisitionCallCount
            elevationCallCount = $script:MockElevationCallCount
            applyCallCount = $script:MockApplyCallCount
            adminProbeCallCount = $script:MockAdminProbeCallCount
            coordinatorCallCount = $script:MockCoordinatorCallCount
            cleanupCallCount = $script:MockCleanupCallCount
        }
    }
    Assert-True ([int]$elevatedApplyState.exitCode -eq 84) "Direct -ElevatedApply did not fail closed with exit 84: $($elevatedApplyState.exitCode)"
    Assert-True ([int]$elevatedApplyState.acquisitionCallCount -eq 0 -and [int]$elevatedApplyState.cleanupCallCount -eq 0) 'Direct -ElevatedApply performed acquisition/cleanup work.'
    Assert-True ([int]$elevatedApplyState.elevationCallCount -eq 0 -and [int]$elevatedApplyState.applyCallCount -eq 0) 'Direct -ElevatedApply reached elevation/apply.'
    Assert-True ([int]$elevatedApplyState.adminProbeCallCount -eq 0 -and [int]$elevatedApplyState.coordinatorCallCount -eq 0) 'Direct -ElevatedApply attempted administrator/coordinator work.'

    Write-Host 'Execute the real production -ElevatedApply entry in a fresh Windows PowerShell 5.1 child'
    $productionElevatedOutput = @(& $windowsPowerShell `
            -NoLogo `
            -NoProfile `
            -NonInteractive `
            -ExecutionPolicy Bypass `
            -File $refreshPath `
            -ElevatedApply 2>&1 | ForEach-Object { [string]$_ })
    $productionElevatedExitCode = $LASTEXITCODE
    Assert-True ($productionElevatedExitCode -eq 84) "Production -ElevatedApply entry did not return 84. code=$productionElevatedExitCode output=$($productionElevatedOutput -join ' | ')"
    Assert-True (($productionElevatedOutput -join ' ') -match 'no Authenticode or IT-managed trust anchor') 'Production -ElevatedApply entry did not emit trust-anchor guidance.'

    Write-Host 'Clean-install bootstrap E2E fixture passed.' -ForegroundColor Green
}
finally {
    if ($null -ne $cleanInput -and $null -ne $cleanInput.PSObject.Properties['CleanupLock'] -and $null -ne $cleanInput.CleanupLock) {
        try { $cleanInput.CleanupLock.Dispose() }
        catch { }
    }
    if ($null -ne $fixtureModule) { Remove-Module $fixtureModule.Name -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
