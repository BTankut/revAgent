[CmdletBinding()]
param([string]$RepoRoot = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)

if ($PSVersionTable.PSVersion.Major -ne 5) {
    $windowsPowerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    & $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -RepoRoot $RepoRoot
    exit $LASTEXITCODE
}

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Assert-Equal { param($Actual, $Expected, [string]$Message) if ($Actual -ne $Expected) { throw "$Message Expected='$Expected' Actual='$Actual'" } }
function Write-Utf8Json { param([string]$Path, [object]$Value) [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false)) }
function Get-Sha256 { param([string]$Path) return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash }
function Assert-ThrowsLike {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $matched = $false
    try { & $Action }
    catch { $matched = $_.Exception.Message -match $Pattern }
    if (-not $matched) { throw $Message }
}

$trustModuleSource = Join-Path $RepoRoot 'installer\lib\RevAgent.BootstrapTrust.psm1'
$brokerSource = Join-Path $RepoRoot 'installer\nas\Invoke-RevAgent-BootstrapTrustBroker.ps1'
$integrityModuleSource = Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1'
$snapshotModuleSource = Join-Path $RepoRoot 'installer\lib\RevAgent.ReleaseSnapshot.psm1'
foreach ($path in @($trustModuleSource, $brokerSource, $integrityModuleSource, $snapshotModuleSource)) { Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Required broker test source is missing: $path" }

$tokens = $null; $parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($trustModuleSource, [ref]$tokens, [ref]$parseErrors)
Assert-Equal @($parseErrors).Count 0 'Bootstrap trust module must parse in Windows PowerShell 5.1.'
$tokens = $null; $parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($brokerSource, [ref]$tokens, [ref]$parseErrors)
Assert-Equal @($parseErrors).Count 0 'Bootstrap trust broker must parse in Windows PowerShell 5.1.'

Import-Module $integrityModuleSource -Force
Import-Module $snapshotModuleSource -Force
$bootstrapTrustModule = Import-Module $trustModuleSource -Force -PassThru

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('revagent-bootstrap-trust-test-' + [Guid]::NewGuid().ToString('N'))
$programDataRoot = Join-Path $tempRoot 'programdata'
$profileRoot = Join-Path $tempRoot 'profile'
$profileRootTwo = Join-Path $tempRoot 'profile-two'
$releaseRoot = Join-Path $tempRoot 'release'
$payloadRoot = Join-Path $tempRoot 'payload'
$inboxRoot = Join-Path $profileRoot 'AppData\Local\DPE\revAgent\release-inbox'
$inboxRootTwo = Join-Path $profileRootTwo 'AppData\Local\DPE\revAgent\release-inbox'
[void][IO.Directory]::CreateDirectory($programDataRoot)
[void][IO.Directory]::CreateDirectory($profileRoot)
[void][IO.Directory]::CreateDirectory($profileRootTwo)
[void][IO.Directory]::CreateDirectory($releaseRoot)
[void][IO.Directory]::CreateDirectory($payloadRoot)
[void][IO.Directory]::CreateDirectory($inboxRoot)
[void][IO.Directory]::CreateDirectory($inboxRootTwo)

$rsa = [Security.Cryptography.RSACryptoServiceProvider]::new(2048)
try {
    Write-Host 'Test public-only key policy and duplicate-preserving JSON rejection'
    $keyId = 'test-bootstrap-trust'
    $publicKeyXml = $rsa.ToXmlString($false)
    $fingerprint = Get-RevAgentPublicKeyFingerprint -PublicKeyXml $publicKeyXml
    $trustedKeys = [ordered]@{
        schemaVersion = 1
        app = 'revAgent'
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        trustedKeys = [ordered]@{
            $keyId = [ordered]@{ publicKeyXml = $publicKeyXml; publicKeyFingerprint = $fingerprint; algorithm = 'RS256'; purpose = 'release-signing' }
        }
    }
    $trustedKeysPath = Join-Path $tempRoot 'release-trusted-keys.json'
    Write-Utf8Json -Path $trustedKeysPath -Value $trustedKeys
    $keyBytes = [IO.File]::ReadAllBytes($trustedKeysPath)
    $validatedKeys = Assert-RevAgentBootstrapTrustedKeySet -Bytes $keyBytes -AllowTestRoot
    Assert-True ([bool]$validatedKeys.success -and [int]$validatedKeys.keyCount -eq 1) 'Valid metadata/public-purpose key document was rejected.'

    $legacyKeys = [ordered]@{ trustedKeys = $trustedKeys.trustedKeys }
    $legacyBytes = [Text.UTF8Encoding]::new($false).GetBytes(($legacyKeys | ConvertTo-Json -Depth 8))
    Assert-True ([bool](Assert-RevAgentBootstrapTrustedKeySet -Bytes $legacyBytes -AllowTestRoot).success) 'Exact legacy trustedKeys-only document was rejected.'
    foreach ($duplicate in @(
            '{"trustedKeys":{},"trustedKeys":{}}',
            '{"trustedKeys":{},"trusted\u004Beys":{}}',
            '{"trustedKeys":{"test":{"algorithm":"RS256","algorithm":"RS256"}}}'
        )) {
        $duplicateBytes = [Text.UTF8Encoding]::new($false).GetBytes($duplicate)
        Assert-ThrowsLike { [void](Assert-RevAgentBootstrapTrustedKeySet -Bytes $duplicateBytes -AllowTestRoot) } 'duplicate decoded JSON property' 'Duplicate or escaped-duplicate JSON property was not rejected before normalization.'
    }
    $secretDocument = $trustedKeys | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $secretDocument.trustedKeys.$keyId | Add-Member -NotePropertyName privateKeyXml -NotePropertyValue ($rsa.ToXmlString($true))
    $secretBytes = [Text.UTF8Encoding]::new($false).GetBytes(($secretDocument | ConvertTo-Json -Depth 10))
    Assert-ThrowsLike { [void](Assert-RevAgentBootstrapTrustedKeySet -Bytes $secretBytes -AllowTestRoot) } 'non-public|unknown' 'Trusted-key validator accepted a secret/unknown field.'
    $wrongPurpose = $trustedKeys | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $wrongPurpose.trustedKeys.$keyId.purpose = 'anything-else'
    $wrongPurposeBytes = [Text.UTF8Encoding]::new($false).GetBytes(($wrongPurpose | ConvertTo-Json -Depth 10))
    Assert-ThrowsLike { [void](Assert-RevAgentBootstrapTrustedKeySet -Bytes $wrongPurposeBytes -AllowTestRoot) } 'purpose must be release-signing' 'Trusted-key validator accepted a non-release-signing purpose.'

    $fakeQ3 = [ordered]@{ publicKeyXml = $publicKeyXml; publicKeyFingerprint = $fingerprint; algorithm = 'RS256'; purpose = 'release-signing' }
    $olderTransition = [ordered]@{ trustedKeys = [ordered]@{ 'revagent-prod-rsa-2026q3' = $fakeQ3; 'revagent-prod-rsa-2026q2' = $fakeQ3 } }
    $olderBytes = [Text.UTF8Encoding]::new($false).GetBytes(($olderTransition | ConvertTo-Json -Depth 10))
    Assert-ThrowsLike { [void](Assert-RevAgentBootstrapTrustedKeySet -Bytes $olderBytes) } 'strictly later than 2026q3' 'Production key policy accepted an older transition key.'
    $laterTransition = [ordered]@{ trustedKeys = [ordered]@{ 'revagent-prod-rsa-2026q3' = $fakeQ3; 'revagent-prod-rsa-2026q4' = [ordered]@{ publicKeyXml = ($rsa.ToXmlString($false)); publicKeyFingerprint = $fingerprint; algorithm = 'RS256'; purpose = 'release-signing' } } }
    $laterBytes = [Text.UTF8Encoding]::new($false).GetBytes(($laterTransition | ConvertTo-Json -Depth 10))
    Assert-ThrowsLike { [void](Assert-RevAgentBootstrapTrustedKeySet -Bytes $laterBytes) } 'duplicate public-key fingerprints|pinned identity' 'Production future-key path did not reach duplicate/pinned identity enforcement.'

    Write-Host 'Build a complete signed local release fixture'
    $componentMap = [ordered]@{
        localBootstrapInstaller = @('scripts\install-revagent-local-bootstrap.ps1', 'installer\nas\install-revagent-local-bootstrap.ps1')
        installerLibLocalBootstrap = @('installer\lib\RevAgent.LocalBootstrap.psm1', 'installer\lib\RevAgent.LocalBootstrap.psm1')
        localBootstrap = @('installer\nas\Start-revAgent-Update.ps1', 'installer\nas\Start-revAgent-Update.ps1')
        localBootstrapLauncher = @('installer\nas\Start-revAgent-Update.cmd', 'installer\nas\Start-revAgent-Update.cmd')
        updaterGui = @('installer\nas\Install-revAgent-Updater-GUI.ps1', 'installer\nas\Install-revAgent-Updater-GUI.ps1')
        installerLibDistributionIntegrity = @('installer\lib\RevAgent.DistributionIntegrity.psm1', 'installer\lib\RevAgent.DistributionIntegrity.psm1')
        installerLibPermissions = @('installer\lib\RevAgent.Permissions.psm1', 'installer\lib\RevAgent.Permissions.psm1')
        installerLibSourceFreeMigration = @('installer\lib\RevAgent.SourceFreeMigration.psm1', 'installer\lib\RevAgent.SourceFreeMigration.psm1')
        installerLibReleaseSnapshot = @('installer\lib\RevAgent.ReleaseSnapshot.psm1', 'installer\lib\RevAgent.ReleaseSnapshot.psm1')
        privilegedSnapshotUpdate = @('installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1', 'installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1')
        installerLibBootstrapTrust = @('installer\lib\RevAgent.BootstrapTrust.psm1', 'installer\lib\RevAgent.BootstrapTrust.psm1')
        bootstrapTrustBroker = @('installer\nas\Invoke-RevAgent-BootstrapTrustBroker.ps1', 'installer\nas\Invoke-RevAgent-BootstrapTrustBroker.ps1')
        releaseTrustedKeys = @('', 'config\release-trusted-keys.json')
    }
    $components = [ordered]@{}
    foreach ($entry in $componentMap.GetEnumerator()) {
        $source = if ([string]::IsNullOrWhiteSpace([string]$entry.Value[0])) { $trustedKeysPath } else { Join-Path $RepoRoot ([string]$entry.Value[0]) }
        $target = Join-Path $payloadRoot ([string]$entry.Value[1])
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $target))
        [IO.File]::WriteAllBytes($target, [IO.File]::ReadAllBytes($source))
        $components[$entry.Key] = [ordered]@{ path = [string]$entry.Value[1]; sha256 = Get-Sha256 $target; sizeBytes = (Get-Item -LiteralPath $target).Length }
    }
    $version = '2099.07.20.10-bootstrap-trust'
    $releaseSequence = 10L
    $releaseDirectory = Join-Path $releaseRoot "releases\$version"
    [void][IO.Directory]::CreateDirectory($releaseDirectory)
    [void][IO.Directory]::CreateDirectory((Join-Path $releaseRoot 'channels'))
    [void][IO.Directory]::CreateDirectory((Join-Path $releaseDirectory 'external'))
    $nodeMsiName = 'node-v24.14.1-x64.msi'
    $nodeRelative = "external\$nodeMsiName"
    $nodePath = Join-Path $releaseDirectory $nodeRelative
    [IO.File]::WriteAllBytes($nodePath, [Text.Encoding]::UTF8.GetBytes('BOOTSTRAP TRUST TEST NODE MSI'))
    $nodeHash = Get-Sha256 $nodePath
    $packageName = "revAgent-$version.zip"
    $packagePath = Join-Path $releaseDirectory $packageName
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($payloadRoot, $packagePath, [IO.Compression.CompressionLevel]::Optimal, $false)
    $manifest = [ordered]@{
        schemaVersion = 1; app = 'revAgent'; version = $version; channel = 'stable'; releaseSequence = $releaseSequence; minimumAcceptedReleaseSequence = 1
        package = [ordered]@{ fileName = $packageName; path = "..\releases\$version\$packageName"; sha256 = Get-Sha256 $packagePath; sizeBytes = (Get-Item -LiteralPath $packagePath).Length }
        components = $components
        externalDependencies = [ordered]@{ nodeMsi = [ordered]@{ schemaVersion = 1; relativePath = $nodeRelative; sha256 = $nodeHash; sizeBytes = (Get-Item -LiteralPath $nodePath).Length; signerSubject = 'TEST-ONLY'; authenticodeStatus = 'TestBypass' } }
    }
    $channel = [ordered]@{ schemaVersion = 1; app = 'revAgent'; channel = 'stable'; version = $version; releaseSequence = $releaseSequence; minimumAcceptedReleaseSequence = 1; manifestPath = "..\releases\$version\manifest.json"; packagePath = "..\releases\$version\$packageName"; sha256 = Get-Sha256 $packagePath }
    $manifestPath = Join-Path $releaseDirectory 'manifest.json'
    $channelPath = Join-Path $releaseRoot 'channels\stable.json'
    Write-Utf8Json $manifestPath $manifest
    Write-Utf8Json $channelPath $channel
    Write-Utf8Json (Join-Path $releaseDirectory 'manifest.sig.json') (New-RevAgentDetachedJsonSignature -Content $manifest -SignedObject 'release-manifest' -KeyId $keyId -PrivateKeyXml ($rsa.ToXmlString($true)) -App 'revAgent')
    Write-Utf8Json (Join-Path $releaseRoot 'channels\stable.sig.json') (New-RevAgentDetachedJsonSignature -Content $channel -SignedObject 'channel' -KeyId $keyId -PrivateKeyXml ($rsa.ToXmlString($true)) -App 'revAgent')

    $inboxes = @()
    1..6 | ForEach-Object { $inboxes += New-RevAgentAuthenticatedReleaseInbox -ReleaseRoot $releaseRoot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath $integrityModuleSource -InboxRoot $inboxRoot -ExpectedNodeMsiSha256 $nodeHash -AllowTestRoot }
    $secondProfileInbox = New-RevAgentAuthenticatedReleaseInbox -ReleaseRoot $releaseRoot -TrustedKeysPath $trustedKeysPath -IntegrityModulePath $integrityModuleSource -InboxRoot $inboxRootTwo -ExpectedNodeMsiSha256 $nodeHash -AllowTestRoot

    Write-Host 'Install and attest fixed ProgramData trust/task core'
    $taskEvidenceFactory = {
        param($layout)
        [pscustomobject][ordered]@{ exists = $true; taskName = [string]$layout.taskName; taskPath = [string]$layout.taskPath; execute = [string]$layout.taskPowerShellPath; arguments = [string]$layout.taskArguments; actionCount = 1; userId = 'SYSTEM'; logonType = 'ServiceAccount'; runLevel = 'Highest'; sddl = [string]$layout.taskSddl; state = 'Ready'; enabled = $true; allowDemandStart = $true; multipleInstances = 'IgnoreNew'; executionTimeLimit = 'PT30M' }
    }
    $trustHashes = [ordered]@{ bootstrapTrust = Get-Sha256 $trustModuleSource; bootstrapTrustBroker = Get-Sha256 $brokerSource; distributionIntegrity = Get-Sha256 $integrityModuleSource; releaseSnapshot = Get-Sha256 $snapshotModuleSource; trustedKeys = Get-Sha256 $trustedKeysPath }
    $authenticatedRelease = [pscustomobject][ordered]@{ signatureVerified = $true; root = $releaseRoot; channel = 'stable'; version = $version; releaseSequence = $releaseSequence; highestAcceptedReleaseSequence = $releaseSequence }
    $install = Install-RevAgentBootstrapTrustCore -BootstrapTrustModulePath $trustModuleSource -BrokerPath $brokerSource -DistributionIntegrityModulePath $integrityModuleSource -ReleaseSnapshotModulePath $snapshotModuleSource -TrustedKeysPath $trustedKeysPath -ExpectedSourceHashes $trustHashes -AuthenticatedRelease $authenticatedRelease -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskRegistrar $taskEvidenceFactory
    Assert-True ([bool]$install.success) 'Bootstrap trust core installation failed.'
    $health = Test-RevAgentBootstrapTrustHealth -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory
    Assert-True ([bool]$health.healthy) ("Installed bootstrap trust core is unhealthy: " + (($health.checks | Where-Object { -not $_.success } | ConvertTo-Json -Depth 8 -Compress) -join ''))
    $layout = Get-RevAgentBootstrapTrustLayout -ProgramDataRoot $programDataRoot -AllowTestRoot
    foreach ($publicTrustPath in @($layout.trustStatePath, $layout.bootstrapTrustModulePath, $layout.brokerPath, $layout.distributionIntegrityModulePath, $layout.releaseSnapshotModulePath, $layout.trustedKeysPath)) {
        $publicTrustAcl = Get-Acl -LiteralPath $publicTrustPath
        $usersReadRules = @($publicTrustAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
                [string]$_.IdentityReference.Value -eq 'S-1-5-32-545' -and
                $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                (($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -ne 0) -and
                (($_.FileSystemRights -band ([Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)) -eq 0)
            })
        Assert-True ($publicTrustAcl.AreAccessRulesProtected -and $usersReadRules.Count -eq 1) "Public trust-core file is not explicitly standard-user readable and write-protected: $publicTrustPath"
    }
    $brokerLockAcl = Get-Acl -LiteralPath $layout.brokerLockPath
    $brokerLockUsersRules = @($brokerLockAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { [string]$_.IdentityReference.Value -eq 'S-1-5-32-545' })
    Assert-True ($brokerLockAcl.AreAccessRulesProtected -and $brokerLockUsersRules.Count -eq 0) 'Broker lock remains standard-user readable/squattable.'
    $trustModuleText = [IO.File]::ReadAllText($trustModuleSource)
    Assert-True ($trustModuleText -match 'GetSecurityDescriptor\(0x7\)' -and $trustModuleText -notmatch 'GetSecurityDescriptor\(0xF\)') 'Standard-user task health requests SACL security information.'
    Assert-True ($trustModuleText -match 'if \(-not \$WriterIsRequester\)\s*\{(?s:.*?)SetOwner') 'Standard-user request creation still requires an owner rewrite instead of preserving the OS-assigned owner.'
    Assert-True ($trustModuleText -notmatch 'Global\\DPE\.revAgent\.BootstrapTrustBroker') 'Broker serialization still depends on a standard-user-squattable Global mutex.'
    $preFailureTrustStateHash = Get-Sha256 $layout.trustStatePath
    $preFailureBrokerHash = Get-Sha256 $layout.brokerPath
    $failingTaskRegistrar = { param($taskLayout); throw 'fixture task registration failed' }
    Assert-ThrowsLike {
        [void](Install-RevAgentBootstrapTrustCore -BootstrapTrustModulePath $trustModuleSource -BrokerPath $brokerSource -DistributionIntegrityModulePath $integrityModuleSource -ReleaseSnapshotModulePath $snapshotModuleSource -TrustedKeysPath $trustedKeysPath -ExpectedSourceHashes $trustHashes -AuthenticatedRelease $authenticatedRelease -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskRegistrar $failingTaskRegistrar)
    } 'fixture task registration failed' 'Bootstrap trust upgrade did not surface the injected task-registration failure.'
    Assert-Equal (Get-Sha256 $layout.trustStatePath) $preFailureTrustStateHash 'Task-registration failure did not restore the exact previous trust state.'
    Assert-Equal (Get-Sha256 $layout.brokerPath) $preFailureBrokerHash 'Task-registration failure did not restore the exact previous broker.'
    Assert-Equal @((Get-ChildItem -LiteralPath $layout.trustTransactionRoot -Force | Where-Object { $_.Name -like '.trust-stage-*' -or $_.Name -like '.trust-previous-*' })).Count 0 'Task-registration rollback left a trust staging/backup directory.'
    $health = Test-RevAgentBootstrapTrustHealth -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory
    Assert-True ([bool]$health.healthy) 'Task-registration rollback did not preserve a healthy previous trust core.'
    $unexpectedRegistrarProbe = [pscustomobject]@{ calls = 0 }
    $unexpectedRegistrar = { param($taskLayout); $unexpectedRegistrarProbe.calls++; throw 'healthy prior task must not be overwritten' }.GetNewClosure()
    $preservedTaskInstall = Install-RevAgentBootstrapTrustCore -BootstrapTrustModulePath $trustModuleSource -BrokerPath $brokerSource -DistributionIntegrityModulePath $integrityModuleSource -ReleaseSnapshotModulePath $snapshotModuleSource -TrustedKeysPath $trustedKeysPath -ExpectedSourceHashes $trustHashes -AuthenticatedRelease $authenticatedRelease -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -TaskRegistrar $unexpectedRegistrar
    Assert-True ([bool]$preservedTaskInstall.success -and $unexpectedRegistrarProbe.calls -eq 0) 'A healthy release-independent broker task was unnecessarily overwritten during trust-core refresh.'
    foreach ($brokenMode in @('disabled', 'demand-start-disabled')) {
        $repairProbe = [pscustomobject]@{ calls = 0 }
        $brokenProvider = {
            param($taskLayout)
            $evidence = & $taskEvidenceFactory $taskLayout
            if ($brokenMode -eq 'disabled') { $evidence.enabled = $false; $evidence.state = 'Disabled' }
            else { $evidence.allowDemandStart = $false }
            return $evidence
        }.GetNewClosure()
        $repairRegistrar = { param($taskLayout); $repairProbe.calls++; return & $taskEvidenceFactory $taskLayout }.GetNewClosure()
        $repairInstall = Install-RevAgentBootstrapTrustCore -BootstrapTrustModulePath $trustModuleSource -BrokerPath $brokerSource -DistributionIntegrityModulePath $integrityModuleSource -ReleaseSnapshotModulePath $snapshotModuleSource -TrustedKeysPath $trustedKeysPath -ExpectedSourceHashes $trustHashes -AuthenticatedRelease $authenticatedRelease -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $brokenProvider -TaskRegistrar $repairRegistrar
        Assert-True ([bool]$repairInstall.success -and $repairProbe.calls -eq 1) "Broken task mode '$brokenMode' was preserved instead of repaired."
    }
    Assert-Equal $layout.taskArguments ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $layout.brokerPath + '"') 'Fixed task arguments drifted.'
    Assert-True ($layout.taskArguments -notmatch '(?i)-(?:Inbox|Request|Result|Hash|Trusted|ReleaseRoot|EncodedCommand)') 'Fixed task action accepts caller-controlled trust/path/hash arguments.'
    Assert-True ($layout.taskSddl -match ';;;AU\)') 'Fixed task SDDL does not grant bounded Authenticated Users query/run access.'
    $brokerText = [IO.File]::ReadAllText($brokerSource)
    Assert-True ($brokerText -match '(?s)\[CmdletBinding\(\)\]\s*param\(\)' -and $brokerText -notmatch '(?i)\\\\dpe-nas|TrustedKeysPath|InboxPath|ReleaseRoot') 'Production broker entrypoint must accept no arguments and must not name NAS/caller trust inputs.'

    Write-Host 'Run broker from a complete local inbox after NAS transport disappears'
    Remove-Item -LiteralPath $releaseRoot -Recurse -Force
    $request = New-RevAgentBootstrapTrustRequest -InboxId ([string]$inboxes[0].inboxId) -ProgramDataRoot $programDataRoot -AllowTestRoot -ProfileRoot $profileRoot
    $startProbe = [pscustomobject]@{ calls = 0; argumentCount = -1 }
    $starter = { param($taskLayout); $startProbe.calls++; $startProbe.argumentCount = $args.Count }.GetNewClosure()
    $started = Start-RevAgentBootstrapTrustBrokerTask -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskStarter $starter
    Assert-True ([bool]$started.success -and $startProbe.calls -eq 1 -and $startProbe.argumentCount -eq 0 -and [int]$started.argumentsPassed -eq 0) 'Broker task starter passed caller arguments.'
    $applyProbe = [pscustomobject]@{ calls = 0; lastEvidence = $null }
    $apply = {
        param($snapshot, $evidence, $brokerRequest, $brokerLayout)
        $applyProbe.calls++
        $applyProbe.lastEvidence = $evidence
        [pscustomobject][ordered]@{ success = $true; releaseSequence = [long]$snapshot.releaseSequence; bootstrapStateSha256 = ('A' * 64); trustStateSha256 = ('B' * 64); message = 'fixture apply succeeded' }
    }.GetNewClosure()
    $profileResolver = { param($sid, $brokerLayout); return $profileRoot }.GetNewClosure()
    $brokerLockProbe = [IO.File]::Open($layout.brokerLockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    try {
        $busyQueue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileResolver $profileResolver -ApplySnapshot $apply
        Assert-True ([string]$busyQueue.state -eq 'busy' -and [int]$busyQueue.processed -eq 0 -and (Test-Path -LiteralPath $request.requestPath)) 'Protected broker file lock did not serialize queue work without consuming the request.'
    }
    finally { $brokerLockProbe.Dispose() }
    $legacyMutex = $null
    $legacyMutexAcquired = $false
    try {
        $legacyMutex = [Threading.Mutex]::new($false, 'Global\DPE.revAgent.BootstrapTrustBroker')
        try { $legacyMutexAcquired = $legacyMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $legacyMutexAcquired = $true }
        $queue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileResolver $profileResolver -ApplySnapshot $apply
    }
    finally {
        if ($legacyMutexAcquired -and $null -ne $legacyMutex) { try { $legacyMutex.ReleaseMutex() } catch { } }
        if ($null -ne $legacyMutex) { $legacyMutex.Dispose() }
    }
    $result = Wait-RevAgentBootstrapTrustResult -Request $request -TimeoutSeconds 1 -PollMilliseconds 10 -ProgramDataRoot $programDataRoot -AllowTestRoot
    Assert-True ([bool]$queue.success -and [int]$queue.succeeded -eq 1 -and $applyProbe.calls -eq 1) ("Broker did not apply the local signed inbox exactly once. queue=" + ($queue | ConvertTo-Json -Depth 8 -Compress) + ' result=' + ($result | ConvertTo-Json -Depth 6 -Compress))
    Assert-True ([bool]$result.completed -and [int]$result.exitCode -eq 0 -and [long]$result.releaseSequence -eq $releaseSequence) 'Broker protected success result contract failed.'
    Assert-True (-not (Test-Path -LiteralPath $request.requestPath)) 'Broker retained a processed request file.'
    Assert-Equal -Actual ([string]$applyProbe.lastEvidence.producerMode) -Expected 'machine-trust-broker' -Message 'Broker evidence producer mode mismatch.'
    Assert-Equal -Actual ([string]$applyProbe.lastEvidence.evidence.generatedBySid) -Expected 'S-1-5-18' -Message 'Broker evidence must be LocalSystem-attributed.'
    Assert-Equal -Actual ([string]$applyProbe.lastEvidence.evidence.sources.bootstrapTrust) -Expected ([string]$components.installerLibBootstrapTrust.sha256) -Message 'Broker evidence did not bind bootstrap-trust component hash.'
    Assert-Equal -Actual ([string]$applyProbe.lastEvidence.evidence.sources.bootstrapTrustBroker) -Expected ([string]$components.bootstrapTrustBroker.sha256) -Message 'Broker evidence did not bind broker component hash.'
    Assert-Equal @((Get-ChildItem -LiteralPath $layout.snapshotRoot -Directory -Force)).Count 0 'Completed broker apply retained a protected execution snapshot.'

    Write-Host 'Test replay ledger, strict request schema, profile derivation, high-water, and timeout'
    $requestDocumentBytes = [Text.UTF8Encoding]::new($false).GetBytes((([ordered]@{ schemaVersion = 1; app = 'revAgent'; requestType = 'bootstrap-trust-apply'; nonce = [string]$request.nonce; requesterSid = [string]$request.requesterSid; inboxId = [string]$request.inboxId; createdAtUtc = [DateTime]::UtcNow.ToString('o') }) | ConvertTo-Json -Depth 4))
    [IO.File]::WriteAllBytes([string]$request.requestPath, $requestDocumentBytes)
    $replayQueue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileResolver $profileResolver -ApplySnapshot $apply
    Assert-True ([int]$replayQueue.replayed -eq 1 -and $applyProbe.calls -eq 1) 'Processed nonce replay reached the apply seam.'

    $strictRequest = New-RevAgentBootstrapTrustRequest -InboxId ([string]$inboxes[1].inboxId) -ProgramDataRoot $programDataRoot -AllowTestRoot -ProfileRoot $profileRoot
    $strictDocument = Get-Content -Raw -LiteralPath $strictRequest.requestPath | ConvertFrom-Json
    $strictDocument | Add-Member -NotePropertyName trustedKeysPath -NotePropertyValue 'C:\attacker\keys.json'
    Write-Utf8Json -Path $strictRequest.requestPath -Value $strictDocument
    $strictQueue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileResolver $profileResolver -ApplySnapshot $apply
    $strictResult = Wait-RevAgentBootstrapTrustResult -Request $strictRequest -TimeoutSeconds 1 -PollMilliseconds 10 -ProgramDataRoot $programDataRoot -AllowTestRoot
    Assert-True ([int]$strictQueue.rejected -eq 1 -and [int]$strictResult.exitCode -eq 85 -and $applyProbe.calls -eq 1) 'Caller-supplied trust/path field was not rejected before apply.'

    $duplicateRequest = New-RevAgentBootstrapTrustRequest -InboxId ([string]$inboxes[2].inboxId) -ProgramDataRoot $programDataRoot -AllowTestRoot -ProfileRoot $profileRoot
    $duplicateJson = '{"schemaVersion":1,"app":"revAgent","requestType":"bootstrap-trust-apply","nonce":"' + $duplicateRequest.nonce + '","requesterSid":"' + $duplicateRequest.requesterSid + '","inboxId":"' + $duplicateRequest.inboxId + '","createdAtUtc":"' + [DateTime]::UtcNow.ToString('o') + '","inbox\u0049d":"' + $duplicateRequest.inboxId + '"}'
    [IO.File]::WriteAllText($duplicateRequest.requestPath, $duplicateJson, [Text.UTF8Encoding]::new($false))
    $duplicateQueue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileResolver $profileResolver -ApplySnapshot $apply
    Assert-True ([int]$duplicateQueue.rejected -eq 1 -and $applyProbe.calls -eq 1) 'Escaped duplicate request property was normalized into broker input.'

    $profileRequest = New-RevAgentBootstrapTrustRequest -InboxId ([string]$secondProfileInbox.inboxId) -ProgramDataRoot $programDataRoot -AllowTestRoot -ProfileRoot $profileRoot
    $profileQueue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileResolver $profileResolver -ApplySnapshot $apply
    $profileResult = Wait-RevAgentBootstrapTrustResult -Request $profileRequest -TimeoutSeconds 1 -PollMilliseconds 10 -ProgramDataRoot $programDataRoot -AllowTestRoot
    Assert-True ([int]$profileQueue.failed -eq 1 -and [int]$profileResult.exitCode -eq 85 -and $applyProbe.calls -eq 1) 'Broker accepted a non-local/non-profile-derived inbox root.'

    Write-Host 'Test per-profile queue fairness through 1024 locked hostile entries'
    $attackerSid = 'S-1-5-21-900000001-900000002-900000003-1001'
    $attackerProfileRoot = Join-Path $tempRoot 'attacker-profile'
    $attackerQueueRoot = Join-Path $attackerProfileRoot 'AppData\Local\DPE\revAgent\broker-requests'
    [void][IO.Directory]::CreateDirectory($attackerQueueRoot)
    $profileEnumerator = {
        param($brokerLayout)
        @(
            [pscustomobject][ordered]@{ requesterSid = $attackerSid; profileRoot = $attackerProfileRoot },
            [pscustomobject][ordered]@{ requesterSid = [string]$request.requesterSid; profileRoot = $profileRoot }
        )
    }.GetNewClosure()
    $lockedRequestStreams = [Collections.Generic.List[IO.FileStream]]::new()
    try {
        for ($lockedIndex = 0; $lockedIndex -lt 1024; $lockedIndex++) {
            $lockedNonce = (10000 + $lockedIndex).ToString('x32')
            $lockedPath = Join-Path $attackerQueueRoot ("bootstrap-request-$lockedNonce.json")
            $lockedStream = [IO.File]::Open($lockedPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $lockedBytes = [Text.UTF8Encoding]::new($false).GetBytes('{}')
            $lockedStream.Write($lockedBytes, 0, $lockedBytes.Length)
            $lockedStream.Flush($true)
            $lockedRequestStreams.Add($lockedStream)
        }
        $progressRequest = New-RevAgentBootstrapTrustRequest -InboxId ([string]$inboxes[4].inboxId) -ProgramDataRoot $programDataRoot -AllowTestRoot -ProfileRoot $profileRoot
        $progressQueue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileEnumerator $profileEnumerator -ProfileResolver $profileResolver -ApplySnapshot $apply
        $progressResult = Wait-RevAgentBootstrapTrustResult -Request $progressRequest -TimeoutSeconds 1 -PollMilliseconds 10 -ProgramDataRoot $programDataRoot -AllowTestRoot
        Assert-True ([int]$progressQueue.succeeded -eq 1 -and [int]$progressResult.exitCode -eq 0 -and $applyProbe.calls -eq 2) 'A hostile profile with 1024 locked files starved a legitimate request from another profile.'
        Assert-True ([int]$progressQueue.queueScan.profileCount -eq 2 -and [int]$progressQueue.queueScan.candidateCount -eq 17 -and [bool]$progressQueue.queueScan.truncated -and [int]$progressQueue.queueScan.maxCandidatesPerProfile -eq 16) 'Per-profile bounded queue scan did not expose its fairness/cap evidence.'
        Assert-True (@((Get-ChildItem -LiteralPath $layout.snapshotRoot -Directory -Force)).Count -eq 0) 'Completed private broker snapshot cleanup was incomplete.'
        Assert-True ([int]$progressQueue.resultRetention.retained -le 2048 -and [int]$progressQueue.resultRetention.hardLimit -eq 2048 -and [int]$progressQueue.resultRetention.perPrincipalHardLimit -eq 16) 'Protected per-principal result retention exceeded its hard caps.'
    }
    finally {
        foreach ($lockedStream in $lockedRequestStreams) { $lockedStream.Dispose() }
        foreach ($lockedPath in [IO.Directory]::EnumerateFiles($attackerQueueRoot, 'bootstrap-request-*.json', [IO.SearchOption]::TopDirectoryOnly)) { [IO.File]::Delete($lockedPath) }
    }

    Write-Host 'Test 1024 same-principal requests cannot explode protected results'
    $samePrincipalQueueRoot = [string]$request.requestQueueRoot
    $samePrincipalPaths = [Collections.Generic.List[string]]::new()
    try {
        for ($sameIndex = 0; $sameIndex -lt 1024; $sameIndex++) {
            $sameNonce = (20000 + $sameIndex).ToString('x32')
            $samePath = Join-Path $samePrincipalQueueRoot ("bootstrap-request-$sameNonce.json")
            $sameDocument = [ordered]@{ schemaVersion = 1; app = 'revAgent'; requestType = 'bootstrap-trust-apply'; nonce = $sameNonce; requesterSid = [string]$request.requesterSid; inboxId = [string]$inboxes[4].inboxId; createdAtUtc = [DateTime]::UtcNow.ToString('o') }
            Write-Utf8Json -Path $samePath -Value $sameDocument
            $samePrincipalPaths.Add($samePath)
        }
        $sameQueue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileResolver $profileResolver -ApplySnapshot $apply
        Assert-True ([int]$sameQueue.handled -le 2 -and [int]$sameQueue.processed -le 2 -and [int]$sameQueue.resultRetention.retained -le 16 -and [int]$sameQueue.resultRetention.perPrincipalHardLimit -eq 16) 'One principal produced unbounded work or protected results in one broker invocation.'
    }
    finally {
        foreach ($samePath in $samePrincipalPaths) { if ([IO.File]::Exists($samePath)) { [IO.File]::Delete($samePath) } }
    }

    Write-Host 'Test a principal-pinned full result bucket does not block another principal'
    $currentBucket = Split-Path -Parent ([string]$request.resultPath)
    $templateResultPath = @([IO.Directory]::EnumerateFiles($currentBucket, 'bootstrap-result-*.json', [IO.SearchOption]::TopDirectoryOnly) | Select-Object -First 1)[0]
    $templateResultAcl = Get-Acl -LiteralPath $templateResultPath
    $dummyResultPaths = [Collections.Generic.List[string]]::new()
    $resultLocks = [Collections.Generic.List[IO.FileStream]]::new()
    try {
        $existingCount = @([IO.Directory]::EnumerateFiles($currentBucket, 'bootstrap-result-*.json', [IO.SearchOption]::TopDirectoryOnly)).Count
        for ($resultIndex = $existingCount; $resultIndex -lt 16; $resultIndex++) {
            $dummyNonce = (50000 + $resultIndex).ToString('x32')
            $dummyPath = Join-Path $currentBucket ("bootstrap-result-$dummyNonce.json")
            [IO.File]::WriteAllText($dummyPath, '{}', [Text.UTF8Encoding]::new($false))
            Set-Acl -LiteralPath $dummyPath -AclObject $templateResultAcl
            $dummyResultPaths.Add($dummyPath)
        }
        foreach ($resultPath in [IO.Directory]::EnumerateFiles($currentBucket, 'bootstrap-result-*.json', [IO.SearchOption]::TopDirectoryOnly)) {
            $resultLocks.Add([IO.File]::Open($resultPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None))
        }
        $secondSid = 'S-1-5-21-900000001-900000002-900000003-1002'
        $secondRequest = New-RevAgentBootstrapTrustRequest -InboxId ([string]$secondProfileInbox.inboxId) -ProgramDataRoot $programDataRoot -AllowTestRoot -RequesterSid $secondSid -ProfileRoot $profileRootTwo
        $twoProfileEnumerator = {
            param($brokerLayout)
            @(
                [pscustomobject][ordered]@{ requesterSid = [string]$request.requesterSid; profileRoot = $profileRoot },
                [pscustomobject][ordered]@{ requesterSid = $secondSid; profileRoot = $profileRootTwo }
            )
        }.GetNewClosure()
        $crossPrincipalQueue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileEnumerator $twoProfileEnumerator -ApplySnapshot $apply
        $secondResult = Wait-RevAgentBootstrapTrustResult -Request $secondRequest -TimeoutSeconds 1 -PollMilliseconds 10 -ProgramDataRoot $programDataRoot -AllowTestRoot
        Assert-True ([int]$crossPrincipalQueue.resultPreflight.blockedBucketCount -eq 1 -and [int]$crossPrincipalQueue.succeeded -eq 1 -and [int]$secondResult.exitCode -eq 0) ("A pinned result bucket for one principal blocked another principal. queue=" + ($crossPrincipalQueue | ConvertTo-Json -Depth 8 -Compress) + ' result=' + ($secondResult | ConvertTo-Json -Depth 6 -Compress))
    }
    finally {
        foreach ($resultLock in $resultLocks) { $resultLock.Dispose() }
        foreach ($dummyPath in $dummyResultPaths) { if ([IO.File]::Exists($dummyPath)) { [IO.File]::Delete($dummyPath) } }
    }

    Write-Host 'Test locked legacy public prestage cannot block a second profile broker request'
    [void][IO.Directory]::CreateDirectory([string]$layout.prestageRoot)
    $legacyPrestageStreams = [Collections.Generic.List[IO.FileStream]]::new()
    try {
        foreach ($legacyLeaf in @('install-revagent-local-bootstrap.ps1', 'bootstrap-prestage-evidence.json', 'release-trusted-keys.json')) {
            $legacyPath = Join-Path ([string]$layout.prestageRoot) $legacyLeaf
            [IO.File]::WriteAllText($legacyPath, 'LOCKED LEGACY PUBLIC PRESTAGE FIXTURE', [Text.UTF8Encoding]::new($false))
            $legacyPrestageStreams.Add([IO.File]::Open($legacyPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None))
        }
        $legacyIsolationRequest = New-RevAgentBootstrapTrustRequest -InboxId ([string]$secondProfileInbox.inboxId) -ProgramDataRoot $programDataRoot -AllowTestRoot -RequesterSid $secondSid -ProfileRoot $profileRootTwo
        $legacyIsolationEnumerator = {
            param($brokerLayout)
            @([pscustomobject][ordered]@{ requesterSid = $secondSid; profileRoot = $profileRootTwo })
        }.GetNewClosure()
        $callsBeforeLegacyIsolation = [int]$applyProbe.calls
        $legacyIsolationQueue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileEnumerator $legacyIsolationEnumerator -ApplySnapshot $apply
        $legacyIsolationResult = Wait-RevAgentBootstrapTrustResult -Request $legacyIsolationRequest -TimeoutSeconds 1 -PollMilliseconds 10 -ProgramDataRoot $programDataRoot -AllowTestRoot
        $expectedPrivateEvidencePath = Join-Path (Join-Path ([string]$layout.applyRoot) ("apply-$([string]$legacyIsolationRequest.nonce)")) 'bootstrap-prestage-evidence.json'
        $expectedPrincipalResultPath = Join-Path (Join-Path ([string]$layout.resultsRoot) ("principal-$secondSid")) ("bootstrap-result-$([string]$legacyIsolationRequest.nonce).json")
        Assert-True ([int]$legacyIsolationQueue.succeeded -eq 1 -and [int]$legacyIsolationResult.exitCode -eq 0 -and [int]$applyProbe.calls -eq ($callsBeforeLegacyIsolation + 1)) 'Locked legacy public prestage files blocked or contaminated a legitimate second-profile broker request.'
        Assert-Equal ([string]$applyProbe.lastEvidence.outputPath) $expectedPrivateEvidencePath 'Broker evidence did not use the exact nonce-bound private apply path while legacy prestage was locked.'
        Assert-Equal ([string]$legacyIsolationRequest.resultPath) $expectedPrincipalResultPath 'Broker request result did not bind to the exact requester-SID bucket and nonce.'
        Assert-Equal ([string]$applyProbe.lastEvidence.producerMode) 'machine-trust-broker' 'Private broker evidence lost its producerMode binding.'
        Assert-True (@((Get-ChildItem -LiteralPath $layout.snapshotRoot -Directory -Force)).Count -eq 0 -and @((Get-ChildItem -LiteralPath $layout.applyRoot -Directory -Force)).Count -eq 0) 'Private system-only snapshot/apply cleanup was incomplete after the locked-prestage regression.'
    }
    finally { foreach ($legacyPrestageStream in $legacyPrestageStreams) { $legacyPrestageStream.Dispose() } }

    Write-Host 'Test exact 128-principal result capacity rejects a new SID without a 129th bucket or global outage'
    $capacityBucketPaths = [Collections.Generic.List[string]]::new()
    try {
        $existingBucketCount = @([IO.Directory]::EnumerateDirectories([string]$layout.resultsRoot, 'principal-*', [IO.SearchOption]::TopDirectoryOnly)).Count
        for ($bucketIndex = $existingBucketCount; $bucketIndex -lt 128; $bucketIndex++) {
            $capacitySid = "S-1-5-21-910000001-910000002-910000003-$($bucketIndex + 2000)"
            $capacityBucket = & $bootstrapTrustModule {
                param($innerLayout, $innerSid)
                Get-RevAgentBootstrapTrustResultBucket -Layout $innerLayout -RequesterSid $innerSid -Create -AllowTestRoot
            } $layout $capacitySid
            $capacityBucketPaths.Add([string]$capacityBucket.path)
        }
        Assert-True (@([IO.Directory]::EnumerateDirectories([string]$layout.resultsRoot, 'principal-*', [IO.SearchOption]::TopDirectoryOnly)).Count -eq 128) 'Result-capacity fixture did not reach exactly 128 protected principal buckets.'

        $overflowSid = 'S-1-5-21-910000001-910000002-910000003-9999'
        $overflowRequest = New-RevAgentBootstrapTrustRequest -InboxId ([string]$inboxes[5].inboxId) -ProgramDataRoot $programDataRoot -AllowTestRoot -RequesterSid $overflowSid -ProfileRoot $profileRootTwo
        $overflowEnumerator = {
            param($brokerLayout)
            @([pscustomobject][ordered]@{ requesterSid = $overflowSid; profileRoot = $profileRootTwo })
        }.GetNewClosure()
        $callsBeforeOverflow = [int]$applyProbe.calls
        $overflowQueue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileEnumerator $overflowEnumerator -ApplySnapshot $apply
        $bucketCountAfterOverflow = @([IO.Directory]::EnumerateDirectories([string]$layout.resultsRoot, 'principal-*', [IO.SearchOption]::TopDirectoryOnly)).Count
        Assert-True ([int]$overflowQueue.failed -eq 1 -and [int]$overflowQueue.succeeded -eq 0 -and [int]$overflowQueue.resultRetention.bucketCount -eq 128 -and $bucketCountAfterOverflow -eq 128) 'A new SID at exact global capacity created a 129th result bucket or wedged final retention.'
        Assert-True ($applyProbe.calls -eq $callsBeforeOverflow -and -not [IO.Directory]::Exists((Split-Path -Parent ([string]$overflowRequest.resultPath))) -and -not [IO.File]::Exists([string]$overflowRequest.resultPath)) 'Global result capacity was not reserved before privileged apply/result creation.'

        $existingCapacityRequest = New-RevAgentBootstrapTrustRequest -InboxId ([string]$secondProfileInbox.inboxId) -ProgramDataRoot $programDataRoot -AllowTestRoot -RequesterSid $secondSid -ProfileRoot $profileRootTwo
        $existingCapacityEnumerator = {
            param($brokerLayout)
            @([pscustomobject][ordered]@{ requesterSid = $secondSid; profileRoot = $profileRootTwo })
        }.GetNewClosure()
        $existingCapacityQueue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileEnumerator $existingCapacityEnumerator -ApplySnapshot $apply
        $existingCapacityResult = Wait-RevAgentBootstrapTrustResult -Request $existingCapacityRequest -TimeoutSeconds 1 -PollMilliseconds 10 -ProgramDataRoot $programDataRoot -AllowTestRoot
        Assert-True ([int]$existingCapacityQueue.succeeded -eq 1 -and [int]$existingCapacityResult.exitCode -eq 0 -and [int]$existingCapacityQueue.resultRetention.bucketCount -eq 128 -and $applyProbe.calls -eq ($callsBeforeOverflow + 1)) ("Exact global capacity blocked an already-established principal and became a global broker outage. queue=" + ($existingCapacityQueue | ConvertTo-Json -Depth 8 -Compress) + ' result=' + ($existingCapacityResult | ConvertTo-Json -Depth 6 -Compress) + " calls=$($applyProbe.calls) before=$callsBeforeOverflow")
    }
    finally {
        foreach ($capacityBucketPath in $capacityBucketPaths) {
            if ([IO.Directory]::Exists($capacityBucketPath)) { Remove-Item -LiteralPath $capacityBucketPath -Recurse -Force }
        }
    }

    $ledger = Get-Content -Raw -LiteralPath $layout.highWaterPath | ConvertFrom-Json
    $ledger.highestAcceptedReleaseSequence = $releaseSequence + 1
    Write-Utf8Json -Path $layout.highWaterPath -Value $ledger
    $callsBeforeHighWater = [int]$applyProbe.calls
    $highWaterRequest = New-RevAgentBootstrapTrustRequest -InboxId ([string]$inboxes[5].inboxId) -ProgramDataRoot $programDataRoot -AllowTestRoot -ProfileRoot $profileRoot
    $highWaterQueue = Invoke-RevAgentBootstrapTrustBrokerQueue -ProgramDataRoot $programDataRoot -AllowTestRoot -TaskProvider $taskEvidenceFactory -ProfileResolver $profileResolver -ApplySnapshot $apply
    $highWaterResult = Wait-RevAgentBootstrapTrustResult -Request $highWaterRequest -TimeoutSeconds 1 -PollMilliseconds 10 -ProgramDataRoot $programDataRoot -AllowTestRoot
    Assert-True ([int]$highWaterQueue.failed -eq 1 -and [int]$highWaterResult.exitCode -eq 85 -and $highWaterResult.message -match 'replay|older than highest accepted' -and $applyProbe.calls -eq $callsBeforeHighWater) 'Signed release below broker high-water was not rejected.'

    $timeoutRequest = New-RevAgentBootstrapTrustRequest -InboxId ('f' * 32) -ProgramDataRoot $programDataRoot -AllowTestRoot -ProfileRoot $profileRoot
    $timeout = Wait-RevAgentBootstrapTrustResult -Request $timeoutRequest -TimeoutSeconds 0 -PollMilliseconds 10 -ProgramDataRoot $programDataRoot -AllowTestRoot
    Assert-True (-not [bool]$timeout.completed -and [bool]$timeout.timedOut -and [int]$timeout.exitCode -eq 81) 'Broker result timeout contract drifted.'
    $cleanup = Remove-RevAgentBootstrapTrustClientArtifacts -Request $timeoutRequest -ProgramDataRoot $programDataRoot -AllowTestRoot
    Assert-True ([bool]$cleanup.success -and -not (Test-Path -LiteralPath $timeoutRequest.requestPath)) 'Bounded test client cleanup failed.'

    Write-Host 'Bootstrap trust broker tests passed.' -ForegroundColor Green
}
finally {
    $rsa.Dispose()
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
