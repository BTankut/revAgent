[CmdletBinding()]
param([string]$RepoRoot = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    if (-not [object]::Equals($Actual, $Expected)) {
        throw "$Message Expected='$Expected' Actual='$Actual'"
    }
}

function Capture-Error {
    param([scriptblock]$Action)
    try { & $Action; return '' }
    catch { return [string]$_.Exception.Message }
}

function Get-Sha256ForBytes {
    param([byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '') }
    finally { $sha.Dispose() }
}

function Get-FunctionTextMap {
    param([Management.Automation.Language.Ast]$Ast)
    $map = @{}
    foreach ($functionAst in @($Ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst]
    }, $true))) {
        $normalizedLines = @((([string]$functionAst.Extent.Text -replace "`r`n", "`n").Trim() -split "`n") | ForEach-Object { $_.TrimStart() })
        $map[[string]$functionAst.Name] = $normalizedLines -join "`n"
    }
    return $map
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}
$repoRoot = [IO.Path]::GetFullPath($RepoRoot)
$driverPath = Join-Path $repoRoot 'scripts\Invoke-RevAgentSupervisedPrestage.ps1'
$wrapperPath = Join-Path $repoRoot 'scripts\IT-Prestage-revAgent.cmd'
$kitBuilderPath = Join-Path $repoRoot 'scripts\New-RevAgentBootstrapPrestageKit.ps1'
$producerPath = Join-Path $repoRoot 'scripts\New-RevAgentBootstrapPrestageEvidence.ps1'
$schemaPath = Join-Path $repoRoot 'config\bootstrap-prestage-evidence.schema.json'
$examplePath = Join-Path $repoRoot 'config\bootstrap-prestage-evidence.example.json'
$manualPath = Join-Path $repoRoot 'docs\BOOTSTRAP_PRESTAGE.md'
$windowsPowerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'

foreach ($path in @($driverPath, $wrapperPath, $kitBuilderPath, $producerPath, $schemaPath, $examplePath, $manualPath)) {
    Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Required supervised prestage file is missing: $path"
}

Write-Host 'Parse supervised prestage PowerShell surfaces'
foreach ($path in @($driverPath, $kitBuilderPath, $producerPath)) {
    $tokens = $null
    $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    Assert-Equal @($errors).Count 0 "PowerShell parser errors were found in $path."
}

Write-Host 'Lock the elevated manual ACL/migration implementation into the driver'
$manualText = Get-Content -Raw -LiteralPath $manualPath
$manualMatch = [regex]::Match($manualText, '(?s)### 2\. Fresh elevated Windows PowerShell shell.*?```powershell\s*(?<code>.*?)\s*```')
Assert-True $manualMatch.Success 'Could not extract the elevated manual prestage block.'
$manualTokens = $null
$manualErrors = $null
$manualAst = [Management.Automation.Language.Parser]::ParseInput($manualMatch.Groups['code'].Value, [ref]$manualTokens, [ref]$manualErrors)
Assert-Equal @($manualErrors).Count 0 'Manual elevated prestage block does not parse.'
$driverTokens = $null
$driverErrors = $null
$driverAst = [Management.Automation.Language.Parser]::ParseFile($driverPath, [ref]$driverTokens, [ref]$driverErrors)
$manualFunctions = Get-FunctionTextMap $manualAst
$driverFunctions = Get-FunctionTextMap $driverAst
$protectedFunctions = @(
    'Open-DirectoryGuard',
    'Open-DpeSecurityGuard',
    'Assert-DirectoryGuardPath',
    'Assert-SafeExistingDirectory',
    'Get-AclRuleShape',
    'Get-AclRuleShapeFromRule',
    'Get-RawAclAceShape',
    'Get-CanonicalSharedDpeRawShapes',
    'Get-CanonicalSharedDpeShapes',
    'Assert-CanonicalProgramDataCreatorOwner',
    'Get-SharedDpeAclState',
    'Test-ExactAclShapes',
    'Assert-FinalSharedDpe',
    'Get-CanonicalSharedDpeDaclBytes',
    'Set-SharedDpeOwnerAdministrators',
    'Refresh-SharedDpeInheritance',
    'Initialize-SafeSharedDpe',
    'New-InheritanceEnabledSharedDpe',
    'Set-ProtectedProductRootAcl',
    'New-ProtectedChild',
    'Read-VerifiedBytes',
    'Set-AdminOnlyAcl'
)
foreach ($name in $protectedFunctions) {
    Assert-True $manualFunctions.ContainsKey($name) "Manual elevated block no longer contains $name."
    Assert-True $driverFunctions.ContainsKey($name) "Supervised driver is missing $name."
    Assert-Equal $driverFunctions[$name] $manualFunctions[$name] "Supervised driver drifted from the manual elevated implementation for $name."
}
$driverText = Get-Content -Raw -LiteralPath $driverPath
foreach ($requiredText in @(
    'public static SafeFileHandle OpenSecurity',
    'SetDaclUnprotected',
    'CreateDirectoryWithSecurityDescriptor',
    "SupervisedAdminPrestage = `$true",
    "`$ExpectedEvidenceSha256 = [string]`$evidenceResult.outputSha256",
    "`$ExpectedInstallerSha256 = [string]`$evidence.localBootstrapInstallerScript"
)) {
    Assert-True ($driverText.Contains($requiredText)) "Supervised driver is missing required protected flow text: $requiredText"
}
Assert-True ($driverText -notmatch '<SourceRoot from step 1>|<EvidenceSource from step 1>|<EvidenceSha256 from step 1>|<InstallerSha256 from step 1>') 'Supervised driver must not contain the four manual transcription placeholders.'
Assert-True ($driverText -notmatch '(?i)Read-Host|Clipboard|Invoke-Expression|\biex\b') 'Supervised driver must not depend on prompts, clipboard transfer, or dynamic expression execution.'

Write-Host 'Validate evidence producer mode contract and schema/example parity'
$producerText = Get-Content -Raw -LiteralPath $producerPath
Assert-True ($producerText -match '\[switch\]\$SupervisedAdminPrestage') 'Evidence producer does not expose SupervisedAdminPrestage.'
Assert-True ($producerText -match 'Supervised administrator prestage evidence requires an elevated Windows PowerShell process') 'Evidence producer lacks the supervised non-elevated fail-closed guard.'
Assert-True ($producerText -match 'Bootstrap prestage evidence must be produced before elevation in the normal coordinator process') 'Evidence producer lost the normal elevated-process guard.'
Assert-True ($producerText -match 'Read-RevAgentEvidenceBoundedBytes' -and $producerText -match 'SequenceEqual\(\[byte\[\]\]\$entryBytes, \[byte\[\]\]\$trustedKeysEvidence\.Bytes\)' -and $producerText -match 'trustedKeys = \[string\]\$componentHashes\.trustedKeys' -and $producerText -notmatch 'Get-FileHash[^\r\n]*TrustedKeysPath') 'Evidence producer must parse and bind the same bounded trusted-key byte snapshot.'
$schema = Get-Content -Raw -LiteralPath $schemaPath | ConvertFrom-Json
$example = Get-Content -Raw -LiteralPath $examplePath | ConvertFrom-Json
Assert-True (@($schema.required) -contains 'producerMode') 'Evidence schema does not require producerMode.'
Assert-True (@($schema.required) -contains 'supervisedAdminPrestage') 'Evidence schema does not require supervisedAdminPrestage.'
Assert-Equal ([string]$example.producerMode) 'unelevated-coordinator' 'Evidence example producerMode drifted.'
Assert-Equal ([bool]$example.supervisedAdminPrestage) $false 'Evidence example supervisedAdminPrestage drifted.'

$policyFixture = Join-Path ([IO.Path]::GetTempPath()) ('revagent-supervised-policy-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($policyFixture)
try {
    $policyOutput = Join-Path $policyFixture 'evidence.json'
    $standardError = Capture-Error {
        & $producerPath -ReleaseRoot $policyFixture -TrustedKeysPath (Join-Path $policyFixture 'missing-keys.json') `
            -OutputPath $policyOutput -RepoRoot $repoRoot -AllowTestRoot -TestAdministratorState elevated
    }
    Assert-True ($standardError -match 'must be produced before elevation') 'Normal evidence mode did not reject an elevated policy state.'
    $supervisedError = Capture-Error {
        & $producerPath -ReleaseRoot $policyFixture -TrustedKeysPath (Join-Path $policyFixture 'missing-keys.json') `
            -OutputPath $policyOutput -RepoRoot $repoRoot -AllowTestRoot -SupervisedAdminPrestage -TestAdministratorState standard
    }
    Assert-True ($supervisedError -match 'requires an elevated Windows PowerShell process') 'Supervised evidence mode did not reject a standard-user policy state.'
    $acceptedModeError = Capture-Error {
        & $producerPath -ReleaseRoot $policyFixture -TrustedKeysPath (Join-Path $policyFixture 'missing-keys.json') `
            -OutputPath $policyOutput -RepoRoot $repoRoot -AllowTestRoot -SupervisedAdminPrestage -TestAdministratorState elevated
    }
    Assert-True (-not [string]::IsNullOrWhiteSpace($acceptedModeError) -and
        $acceptedModeError -notmatch 'requires an elevated Windows PowerShell process|must be produced before elevation') 'Supervised evidence mode did not pass its elevation gate before fixture source validation.'
}
finally {
    if (Test-Path -LiteralPath $policyFixture) { Remove-Item -LiteralPath $policyFixture -Recurse -Force }
}

$keySwapFixture = Join-Path ([IO.Path]::GetTempPath()) ('revagent-supervised-key-swap-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($keySwapFixture)
try {
    $swapReleaseRoot = Join-Path $keySwapFixture 'release'
    [void][IO.Directory]::CreateDirectory($swapReleaseRoot)
    $swapKeysPath = Join-Path $swapReleaseRoot 'release-trusted-keys.json'
    $swapRsa = [Security.Cryptography.RSACryptoServiceProvider]::new(2048)
    try {
        $swapPublicKeyXml = $swapRsa.ToXmlString($false)
        $swapPublicFingerprint = Get-Sha256ForBytes ([Text.Encoding]::UTF8.GetBytes(($swapPublicKeyXml.Trim() -replace '\s+', '')))
        $originalKeyRecord = [ordered]@{
            algorithm = 'RS256'
            publicKeyFingerprint = $swapPublicFingerprint
            publicKeyXml = $swapPublicKeyXml
        }
        $originalKeyBytes = [Text.UTF8Encoding]::new($false).GetBytes(([ordered]@{
            schemaVersion = 1
            app = 'revAgent'
            generatedAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ', [Globalization.CultureInfo]::InvariantCulture)
            trustedKeys = [ordered]@{
                original = $originalKeyRecord
            }
        } | ConvertTo-Json -Depth 6))
        $invalidMetadataKeyBytes = [Text.UTF8Encoding]::new($false).GetBytes(([ordered]@{
            schemaVersion = 1
            app = 'revAgent'
            generatedAtUtc = '2026-07-20T00:00:00+00:00'
            trustedKeys = [ordered]@{ original = $originalKeyRecord }
        } | ConvertTo-Json -Depth 6))
    }
    finally { $swapRsa.Dispose() }
    $replacementKeyBytes = [Text.UTF8Encoding]::new($false).GetBytes('{"trustedKeys":{"replacement":{"algorithm":"RS256"}}}')
    [IO.File]::WriteAllBytes($swapKeysPath, $invalidMetadataKeyBytes)
    $invalidMetadataError = Capture-Error {
        & $producerPath -ReleaseRoot $swapReleaseRoot -TrustedKeysPath $swapKeysPath `
            -OutputPath (Join-Path $keySwapFixture 'invalid-metadata-evidence.json') -RepoRoot $repoRoot `
            -AllowTestRoot -SupervisedAdminPrestage -TestAdministratorState elevated
    }
    Assert-True ($invalidMetadataError -match 'Trusted-key public metadata is invalid') 'Evidence producer accepted a non-literal-Z generatedAtUtc value.'
    [IO.File]::WriteAllBytes($swapKeysPath, $originalKeyBytes)
    $hookState = [pscustomobject]@{ Sha256 = '' }
    $keySwapHook = {
        param($Path, $Sha256)
        $hookState.Sha256 = [string]$Sha256
        [IO.File]::WriteAllBytes($Path, $replacementKeyBytes)
    }.GetNewClosure()
    $swapError = Capture-Error {
        & $producerPath -ReleaseRoot $swapReleaseRoot -TrustedKeysPath $swapKeysPath `
            -OutputPath (Join-Path $keySwapFixture 'evidence.json') -RepoRoot $repoRoot `
            -AllowTestRoot -SupervisedAdminPrestage -TestAdministratorState elevated `
            -TrustedKeysBytesVerifiedHook $keySwapHook
    }
    Assert-True (-not [string]::IsNullOrWhiteSpace($swapError)) 'Trusted-key swap fixture unexpectedly reached release verification.'
    Assert-Equal ([string]$hookState.Sha256) (Get-Sha256ForBytes $originalKeyBytes) 'Trusted-key hook did not receive the hash of the parsed byte snapshot.'
    Assert-Equal (Get-Sha256ForBytes ([IO.File]::ReadAllBytes($swapKeysPath))) (Get-Sha256ForBytes $replacementKeyBytes) 'Trusted-key swap fixture did not replace the pathname after acquisition.'
    Assert-True (-not [string]::Equals([string]$hookState.Sha256, (Get-Sha256ForBytes $replacementKeyBytes), [StringComparison]::OrdinalIgnoreCase)) 'Trusted-key evidence followed a post-acquisition pathname swap.'
}
finally {
    if (Test-Path -LiteralPath $keySwapFixture) { Remove-Item -LiteralPath $keySwapFixture -Recurse -Force }
}

Write-Host 'Validate sealed wrapper bootstrap, LanguageMode, elevation, and exit passthrough'
$wrapperText = Get-Content -Raw -LiteralPath $wrapperPath
$languageIndex = $wrapperText.IndexOf('$mode=$ExecutionContext.SessionState.LanguageMode')
$adminIndex = $wrapperText.IndexOf('[Security.Principal.WindowsIdentity]::GetCurrent()')
Assert-True ($wrapperText -match '%__APPDIR__%WindowsPowerShell\\v1\.0\\powershell\.exe') 'IT wrapper does not pin canonical Windows PowerShell 5.1.'
Assert-True ($wrapperText -match 'set "REVAGENT_PRESTAGE_DRIVER=%~dp0scripts\\Invoke-RevAgentSupervisedPrestage\.ps1"' -and $wrapperText -notmatch '%~dp0Invoke-RevAgentSupervisedPrestage\.ps1') 'IT wrapper does not use the exact root-kit scripts layout.'
Assert-True ($languageIndex -ge 0 -and $adminIndex -gt $languageIndex) 'IT wrapper must check LanguageMode before the administrator token.'
Assert-True ($wrapperText -match 'exit /b 78') 'IT wrapper does not preserve the LanguageMode exit 78 contract.'
Assert-True ($wrapperText -match '-Verb RunAs' -and $wrapperText -match '-Wait' -and $wrapperText -match '-PassThru') 'IT wrapper does not self-elevate and wait for the supervised driver.'
Assert-True ($wrapperText -match 'exit \[int\]\$p\.ExitCode' -and $wrapperText -match 'exit /b %PRESTAGE_EXIT%') 'IT wrapper does not pass the elevated driver exit code through.'
Assert-True ($wrapperText -notmatch '(?im)(?:^|[\s,''"])-File(?:[\s,''"]|$)') 'IT wrapper must never elevate or execute a source-kit script with -File.'
foreach ($placeholder in @(
    '__REVAGENT_DRIVER_SHA256__',
    '__REVAGENT_EVIDENCE_SHA256__',
    '__REVAGENT_INTEGRITY_SHA256__',
    '__REVAGENT_TRUSTED_KEYS_SHA256__'
)) {
    Assert-Equal ([regex]::Matches($wrapperText, [regex]::Escape($placeholder)).Count) 1 "IT wrapper must contain exactly one builder-sealed pin placeholder: $placeholder"
}
$encodedMatch = [regex]::Match($wrapperText, '(?m)^set "REVAGENT_PRESTAGE_STAGE_ENCODED=(?<encoded>[A-Za-z0-9+/=]+)"\s*$')
Assert-True $encodedMatch.Success 'IT wrapper does not contain its fixed sealed-staging command.'
$sealedStageCommand = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encodedMatch.Groups['encoded'].Value))
foreach ($requiredStageText in @(
    '[IO.File]::Open($driverPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
    '$sha256.ComputeHash($bytes)',
    '[ScriptBlock]::Create($driverText)',
    '-StageSealedKit',
    '-ExpectedDriverSha256 $expectedDriver',
    '-ExpectedEvidenceSha256 $env:REVAGENT_PRESTAGE_EVIDENCE_SHA256',
    '-ExpectedIntegritySha256 $env:REVAGENT_PRESTAGE_INTEGRITY_SHA256',
    '-ExpectedTrustedKeysSha256 $env:REVAGENT_PRESTAGE_TRUSTED_KEYS_SHA256'
)) {
    Assert-True ($sealedStageCommand.Contains($requiredStageText)) "Fixed wrapper staging command is missing: $requiredStageText"
}
$driverHashIndex = $sealedStageCommand.IndexOf('$sha256.ComputeHash($bytes)')
$driverParseIndex = $sealedStageCommand.IndexOf('[ScriptBlock]::Create($driverText)')
$driverInvokeIndex = $sealedStageCommand.IndexOf('& $driver -StageSealedKit')
Assert-True ($driverHashIndex -ge 0 -and $driverParseIndex -gt $driverHashIndex -and $driverInvokeIndex -gt $driverParseIndex) 'Wrapper staging command must hash, parse, and then invoke the captured driver bytes in that order.'
Assert-True ($sealedStageCommand -notmatch '(?i)(?:^|\s)-File(?:\s|$)') 'Fixed staging command must not execute the source driver pathname with -File.'
Assert-True ($sealedStageCommand -notmatch 'SealedStageTestConfigPath|REVAGENT_PRESTAGE_TEST_CONFIG') 'Production CMD encoded bootstrap must not expose the bounded mock-elevation test seam.'
Assert-True ($driverText -match '\$stageAdministrator -and \$hasStageTestConfigPath' -and $driverText -match 'test configuration is forbidden for an elevated token') 'Driver must fail closed when an elevated caller supplies the sealed-stage test seam.'

$quotedLaunchRoot = Join-Path ([IO.Path]::GetTempPath()) ('revagent quoted launch ' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($quotedLaunchRoot)
try {
    $exitEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('exit 23'))
    $quotedProcess = Start-Process -FilePath $windowsPowerShell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',$exitEncoded) -WorkingDirectory $quotedLaunchRoot -Wait -PassThru
    Assert-Equal ([int]$quotedProcess.ExitCode) 23 'Wrapper-equivalent encoded Start-Process launch did not preserve a path-with-spaces exit code.'
}
finally {
    if (Test-Path -LiteralPath $quotedLaunchRoot) { Remove-Item -LiteralPath $quotedLaunchRoot -Recurse -Force }
}

Write-Host 'Reject mutable direct production kits before evidence execution'
$unsafeKitRoot = Join-Path ([IO.Path]::GetTempPath()) ('revagent-unsafe-direct-kit-' + [Guid]::NewGuid().ToString('N'))
$unsafeMarker = Join-Path $unsafeKitRoot 'evidence-executed.txt'
try {
    foreach ($directory in @('scripts', 'installer\lib', 'config')) {
        [void][IO.Directory]::CreateDirectory((Join-Path $unsafeKitRoot $directory))
    }
    [IO.File]::Copy($driverPath, (Join-Path $unsafeKitRoot 'scripts\Invoke-RevAgentSupervisedPrestage.ps1'), $false)
    $unsafeMarkerLiteral = $unsafeMarker.Replace("'", "''")
    [IO.File]::WriteAllText(
        (Join-Path $unsafeKitRoot 'scripts\New-RevAgentBootstrapPrestageEvidence.ps1'),
        "[IO.File]::WriteAllText('$unsafeMarkerLiteral','executed'); throw 'unsafe evidence producer executed'",
        [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $unsafeKitRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1'), '# fixture', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $unsafeKitRoot 'config\release-trusted-keys.json'), '{}', [Text.UTF8Encoding]::new($false))
    $savedErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $unsafeOutput = @(& $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File (Join-Path $unsafeKitRoot 'scripts\Invoke-RevAgentSupervisedPrestage.ps1') 2>&1 | ForEach-Object { [string]$_ })
        $unsafeExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedErrorActionPreference }
    Assert-True ($unsafeExitCode -ne 0) 'A direct production driver accepted a user-writable TEMP kit.'
    Assert-True (($unsafeOutput -join ' ') -match 'owned by SYSTEM, Administrators, or TrustedInstaller|inheritance-protected admin/IT-only ACL|writable by an untrusted principal|filesystem link/reparse') "Direct mutable-kit rejection did not report the trust boundary. output=$($unsafeOutput -join ' | ')"
    Assert-True (-not (Test-Path -LiteralPath $unsafeMarker)) 'Direct mutable-kit rejection occurred after the evidence producer ran.'
}
finally {
    if (Test-Path -LiteralPath $unsafeKitRoot) { Remove-Item -LiteralPath $unsafeKitRoot -Recurse -Force }
}

Write-Host 'Reject a sealed driver mutation after pinning'
$mutationRoot = Join-Path ([IO.Path]::GetTempPath()) ('revagent-sealed-mutation-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($mutationRoot)
$mutatedDriverPath = Join-Path $mutationRoot 'Invoke-RevAgentSupervisedPrestage.ps1'
$oldSealedEnvironment = @{}
foreach ($name in @(
    'REVAGENT_PRESTAGE_DRIVER',
    'REVAGENT_PRESTAGE_DRIVER_SHA256',
    'REVAGENT_PRESTAGE_KIT_ROOT',
    'REVAGENT_PRESTAGE_EVIDENCE_SHA256',
    'REVAGENT_PRESTAGE_INTEGRITY_SHA256',
    'REVAGENT_PRESTAGE_TRUSTED_KEYS_SHA256'
)) {
    $oldSealedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $originalDriverBytes = [IO.File]::ReadAllBytes($driverPath)
    [IO.File]::WriteAllBytes($mutatedDriverPath, $originalDriverBytes)
    $pinnedDriverSha256 = Get-Sha256ForBytes $originalDriverBytes
    [IO.File]::AppendAllText($mutatedDriverPath, "`r`n# mutation after pinning", [Text.UTF8Encoding]::new($false))
    $env:REVAGENT_PRESTAGE_DRIVER = $mutatedDriverPath
    $env:REVAGENT_PRESTAGE_DRIVER_SHA256 = $pinnedDriverSha256
    $env:REVAGENT_PRESTAGE_KIT_ROOT = $mutationRoot
    $env:REVAGENT_PRESTAGE_EVIDENCE_SHA256 = ('A' * 64)
    $env:REVAGENT_PRESTAGE_INTEGRITY_SHA256 = ('B' * 64)
    $env:REVAGENT_PRESTAGE_TRUSTED_KEYS_SHA256 = ('C' * 64)
    $savedErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $mutationOutput = @(& $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -EncodedCommand $encodedMatch.Groups['encoded'].Value 2>&1 | ForEach-Object { [string]$_ })
        $mutationExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedErrorActionPreference }
    Assert-True ($mutationExitCode -ne 0 -and ($mutationOutput -join ' ') -match 'Sealed driver hash mismatch') "Wrapper bootstrap accepted mutated source bytes after pinning. output=$($mutationOutput -join ' | ')"
}
finally {
    foreach ($name in $oldSealedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable([string]$name, [string]$oldSealedEnvironment[$name], 'Process')
    }
    if (Test-Path -LiteralPath $mutationRoot) { Remove-Item -LiteralPath $mutationRoot -Recurse -Force }
}

Write-Host 'Run disposable end-to-end supervised driver fixture'
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('revagent-supervised-e2e-' + [Guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $fixtureRoot 'release'
$channelRoot = Join-Path $releaseRoot 'channels'
$packageRoot = Join-Path $releaseRoot 'packages'
$programDataRoot = Join-Path $fixtureRoot 'programdata'
$workRoot = Join-Path $fixtureRoot 'work'
$trustedKeysPath = Join-Path $fixtureRoot 'release-trusted-keys.json'
$fakeProducerPath = Join-Path $fixtureRoot 'New-TestEvidence.ps1'
$packagePath = Join-Path $packageRoot 'fixture.zip'
$packageSource = Join-Path $fixtureRoot 'package-source'
$bootstrapRoot = Join-Path $fixtureRoot 'protected-bootstrap'
$desktopRoot = Join-Path $fixtureRoot 'desktop with spaces'
$evidenceTemplatePath = Join-Path $fixtureRoot 'evidence-template.json'
$poisonMarker = Join-Path $fixtureRoot 'poison-module-loaded.txt'
$sealedKitBuildRoot = Join-Path $fixtureRoot 'sealed-kit-build'
$sealedKitExtractRoot = Join-Path $fixtureRoot 'sealed kit extracted with spaces'
$sealedStageParent = Join-Path $fixtureRoot 'sealed-stage-parent'
$sealedStageConfigPath = Join-Path $fixtureRoot 'sealed-stage-test-config.json'
$sealedStageResultPath = Join-Path $fixtureRoot 'sealed-stage-result.json'
foreach ($directory in @($channelRoot, $packageRoot, $programDataRoot, $workRoot, $packageSource, $sealedStageParent)) { [void][IO.Directory]::CreateDirectory($directory) }

$utf8 = [Text.UTF8Encoding]::new($false)
$packageFiles = [ordered]@{
    'installer\nas\install-revagent-local-bootstrap.ps1' = 'scripts\install-revagent-local-bootstrap.ps1'
    'installer\nas\Start-revAgent-Update.ps1' = 'installer\nas\Start-revAgent-Update.ps1'
    'installer\nas\Start-revAgent-Update.cmd' = 'installer\nas\Start-revAgent-Update.cmd'
    'installer\nas\Install-revAgent-Updater-GUI.ps1' = 'installer\nas\Install-revAgent-Updater-GUI.ps1'
    'installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1' = 'installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1'
    'installer\nas\Invoke-RevAgent-BootstrapTrustBroker.ps1' = 'installer\nas\Invoke-RevAgent-BootstrapTrustBroker.ps1'
    'installer\lib\RevAgent.LocalBootstrap.psm1' = 'installer\lib\RevAgent.LocalBootstrap.psm1'
    'installer\lib\RevAgent.BootstrapTrust.psm1' = 'installer\lib\RevAgent.BootstrapTrust.psm1'
    'installer\lib\RevAgent.DistributionIntegrity.psm1' = 'installer\lib\RevAgent.DistributionIntegrity.psm1'
    'installer\lib\RevAgent.Permissions.psm1' = 'installer\lib\RevAgent.Permissions.psm1'
    'installer\lib\RevAgent.SourceFreeMigration.psm1' = 'installer\lib\RevAgent.SourceFreeMigration.psm1'
    'installer\lib\RevAgent.ReleaseSnapshot.psm1' = 'installer\lib\RevAgent.ReleaseSnapshot.psm1'
}
foreach ($entry in $packageFiles.GetEnumerator()) {
    $source = Join-Path $repoRoot ([string]$entry.Value)
    $destination = Join-Path $packageSource ([string]$entry.Key)
    Assert-True (Test-Path -LiteralPath $source -PathType Leaf) "Supervised package source is missing: $source"
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
    [IO.File]::Copy($source, $destination, $false)
}

$fixtureInstallerPath = Join-Path $packageSource 'installer\nas\install-revagent-local-bootstrap.ps1'
$fixtureInstallerText = [IO.File]::ReadAllText($fixtureInstallerPath)
$fixtureBootstrapLiteral = $bootstrapRoot.Replace("'", "''")
$fixtureDesktopLiteral = $desktopRoot.Replace("'", "''")
$fixtureProgramDataLiteral = $programDataRoot.Replace("'", "''")
$fixtureInstallerSetup = @"
`$ErrorActionPreference = "Stop"
`$BootstrapRoot = '$fixtureBootstrapLiteral'
`$ProgramDataRoot = '$fixtureProgramDataLiteral'
`$DesktopShortcutRoot = '$fixtureDesktopLiteral'
`$AllowTestRoot = `$true
"@
$fixtureInstallerPatched = $fixtureInstallerText.Replace('$ErrorActionPreference = "Stop"', $fixtureInstallerSetup.TrimEnd())
Assert-True (-not [string]::Equals($fixtureInstallerPatched, $fixtureInstallerText, [StringComparison]::Ordinal)) 'Could not bind the real installer to disposable output roots.'
[IO.File]::WriteAllText($fixtureInstallerPath, $fixtureInstallerPatched, $utf8)

$testKeyParameters = [Security.Cryptography.CspParameters]::new(24)
$testKeyParameters.Flags = [Security.Cryptography.CspProviderFlags]::CreateEphemeralKey
$testRsa = [Security.Cryptography.RSACryptoServiceProvider]::new(2048, $testKeyParameters)
$testPublicKeyXml = $testRsa.ToXmlString($false)
$normalizedTestPublicKey = $testPublicKeyXml.Trim() -replace '\s+', ''
$testPublicKeyFingerprint = Get-Sha256ForBytes ([Text.Encoding]::UTF8.GetBytes($normalizedTestPublicKey))
$testTrustedKeys = [ordered]@{
    schemaVersion = 1
    app = 'revAgent'
    generatedAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ', [Globalization.CultureInfo]::InvariantCulture)
    trustedKeys = [ordered]@{
        fixture = [ordered]@{
            publicKeyXml = $testPublicKeyXml
            publicKeyFingerprint = $testPublicKeyFingerprint
            algorithm = 'RS256'
        }
    }
}
$keysBytes = $utf8.GetBytes(($testTrustedKeys | ConvertTo-Json -Depth 6))
[IO.File]::WriteAllBytes($trustedKeysPath, $keysBytes)
$invalidKitTrustedKeysPath = Join-Path $fixtureRoot 'invalid-metadata-trusted-keys.json'
$invalidKitTrustedKeys = [ordered]@{
    schemaVersion = 1
    app = 'revAgent'
    generatedAtUtc = '2026-07-20T00:00:00+00:00'
    trustedKeys = $testTrustedKeys.trustedKeys
}
[IO.File]::WriteAllBytes($invalidKitTrustedKeysPath, $utf8.GetBytes(($invalidKitTrustedKeys | ConvertTo-Json -Depth 6)))
$invalidKitMetadataError = Capture-Error {
    & $kitBuilderPath `
        -OutputDirectory (Join-Path $fixtureRoot 'invalid-metadata-kit') `
        -TrustedKeysPath $invalidKitTrustedKeysPath `
        -RepoRoot $repoRoot `
        -AllowTestTrustedKeys | Out-Null
}
Assert-True ($invalidKitMetadataError -match 'Prestage kit trusted-key public metadata is invalid') 'Prestage kit accepted a non-literal-Z generatedAtUtc value.'
$packageTrustedKeysPath = Join-Path $packageSource 'config\release-trusted-keys.json'
[void][IO.Directory]::CreateDirectory((Split-Path -Parent $packageTrustedKeysPath))
[IO.File]::WriteAllBytes($packageTrustedKeysPath, $keysBytes)

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($packageSource, $packagePath, [IO.Compression.CompressionLevel]::Optimal, $false)
$packageSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash

$sourcePaths = [ordered]@{
    bootstrap = 'installer\nas\Start-revAgent-Update.ps1'
    launcher = 'installer\nas\Start-revAgent-Update.cmd'
    updaterGui = 'installer\nas\Install-revAgent-Updater-GUI.ps1'
    distributionIntegrity = 'installer\lib\RevAgent.DistributionIntegrity.psm1'
    permissions = 'installer\lib\RevAgent.Permissions.psm1'
    sourceFreeMigration = 'installer\lib\RevAgent.SourceFreeMigration.psm1'
    releaseSnapshot = 'installer\lib\RevAgent.ReleaseSnapshot.psm1'
    privilegedSnapshotUpdate = 'installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1'
    bootstrapTrust = 'installer\lib\RevAgent.BootstrapTrust.psm1'
    bootstrapTrustBroker = 'installer\nas\Invoke-RevAgent-BootstrapTrustBroker.ps1'
    trustedKeys = 'config\release-trusted-keys.json'
}
$sourceHashes = [ordered]@{}
foreach ($entry in $sourcePaths.GetEnumerator()) {
    $sourceHashes[[string]$entry.Key] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageSource ([string]$entry.Value))).Hash
}
Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($packageTrustedKeysPath), [byte[]][IO.File]::ReadAllBytes($trustedKeysPath))) 'Supervised package fixture trusted-key bytes drifted from the external trust document.'
$evidenceTemplate = [ordered]@{
    schemaVersion = 1
    app = 'revAgent'
    evidenceType = 'bootstrap-prestage'
    producerMode = 'supervised-admin-prestage'
    supervisedAdminPrestage = $true
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    generatedBySid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    release = [ordered]@{
        root = $releaseRoot
        channel = 'stable'
        version = 'fixture.1'
        releaseSequence = 100
        minimumAcceptedReleaseSequence = 1
        highestAcceptedReleaseSequence = 100
        channelManifestSha256 = ('A' * 64)
        releaseManifestSha256 = ('B' * 64)
        packageSha256 = $packageSha
        signatureVerified = $true
        pilotPolicy = $null
    }
    localBootstrapInstallerScript = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixtureInstallerPath).Hash
    localBootstrapInstallerModule = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageSource 'installer\lib\RevAgent.LocalBootstrap.psm1')).Hash
    sources = $sourceHashes
}
[IO.File]::WriteAllText($evidenceTemplatePath, ($evidenceTemplate | ConvertTo-Json -Depth 10), $utf8)

$channelDocument = [ordered]@{
    channel = 'stable'
    version = 'fixture.1'
    packagePath = '..\packages\fixture.zip'
}
[IO.File]::WriteAllText((Join-Path $channelRoot 'stable.json'), ($channelDocument | ConvertTo-Json), $utf8)

$fakeProducer = @'
[CmdletBinding()]
param(
    [string]$ReleaseRoot,
    [string]$TrustedKeysPath,
    [string]$OutputPath,
    [string]$RepoRoot,
    [string]$Channel,
    [switch]$SupervisedAdminPrestage,
    [switch]$AllowTestRoot,
    [string]$TestAdministratorState
)
if (-not $SupervisedAdminPrestage -or -not $AllowTestRoot -or $TestAdministratorState -ne 'elevated') { throw 'fixture producer did not receive supervised mode' }
$channelDocument = Get-Content -Raw -LiteralPath (Join-Path (Join-Path $ReleaseRoot 'channels') ($Channel + '.json')) | ConvertFrom-Json
$packagePath = [IO.Path]::GetFullPath((Join-Path (Join-Path $ReleaseRoot 'channels') ([string]$channelDocument.packagePath)))
$evidence = Get-Content -Raw -LiteralPath $env:REVAGENT_SUPERVISED_EVIDENCE_TEMPLATE | ConvertFrom-Json
if (-not [string]::Equals([string]$evidence.release.packageSha256, (Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash, [StringComparison]::OrdinalIgnoreCase)) { throw 'fixture package changed' }
$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($evidence | ConvertTo-Json -Depth 8))
$stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
$resultMode = if ([string]::IsNullOrWhiteSpace($env:REVAGENT_SUPERVISED_RESULT_MODE)) { 'supervised-admin-prestage' } else { [string]$env:REVAGENT_SUPERVISED_RESULT_MODE }
[pscustomobject]@{ success=$true; action='bootstrap-prestage-evidence'; outputPath=$OutputPath; outputSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash; version=[string]$channelDocument.version; signatureVerified=$true; producerMode=$resultMode; supervisedAdminPrestage=$true }
'@
[IO.File]::WriteAllText($fakeProducerPath, $fakeProducer, $utf8)

$sealedStageConfig = [ordered]@{
    schemaVersion = 1
    mockElevation = $true
    stagingParent = $sealedStageParent
    releaseRoot = $releaseRoot
    programDataRoot = $programDataRoot
    workRoot = $workRoot
    evidenceProducerPath = $fakeProducerPath
    resultPath = $sealedStageResultPath
}
$sealedStageConfigBytes = $utf8.GetBytes(($sealedStageConfig | ConvertTo-Json -Depth 5))
[IO.File]::WriteAllBytes($sealedStageConfigPath, $sealedStageConfigBytes)
$sealedStageConfigSha256 = Get-Sha256ForBytes $sealedStageConfigBytes

$modulePathBeforeKitBuild = $env:PSModulePath
try {
    $sealedKitBuild = & $kitBuilderPath `
        -OutputDirectory $sealedKitBuildRoot `
        -TrustedKeysPath $trustedKeysPath `
        -RepoRoot $repoRoot `
        -AllowTestTrustedKeys `
        -EnableSealedStageTestMode
}
finally { $env:PSModulePath = $modulePathBeforeKitBuild }
Assert-True ([bool]$sealedKitBuild.success -and [int]$sealedKitBuild.entryCount -eq 5) 'Test-sealed kit builder did not emit the exact five-file artifact.'
[IO.Compression.ZipFile]::ExtractToDirectory([string]$sealedKitBuild.zipPath, $sealedKitExtractRoot)
$sealedBuiltWrapperPath = Join-Path $sealedKitExtractRoot 'IT-Prestage-revAgent.cmd'
$sealedBuiltWrapperText = [IO.File]::ReadAllText($sealedBuiltWrapperPath, $utf8)
Assert-True ($sealedBuiltWrapperText -notmatch '__REVAGENT_[A-Z0-9_]+__') 'Built supervised test kit retained an unsealed placeholder.'
$sealedBuiltEncodedMatch = [regex]::Match($sealedBuiltWrapperText, '(?m)^set "REVAGENT_PRESTAGE_STAGE_ENCODED=(?<encoded>[A-Za-z0-9+/=]+)"\r?$')
Assert-True $sealedBuiltEncodedMatch.Success 'Built supervised test kit has no encoded bootstrap.'
$sealedBuiltCommand = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($sealedBuiltEncodedMatch.Groups['encoded'].Value))
Assert-True ($sealedBuiltCommand -match '-StageSealedKit' -and
    $sealedBuiltCommand -match '-SealedStageTestConfigPath \$env:REVAGENT_PRESTAGE_TEST_CONFIG' -and
    $sealedBuiltCommand -match '-ExpectedSealedStageTestConfigSha256 \$env:REVAGENT_PRESTAGE_TEST_CONFIG_SHA256') 'Built supervised test kit encoded bootstrap does not traverse the pinned StageSealedKit test seam.'
$sealedBuiltPins = @{}
foreach ($name in @(
    'REVAGENT_PRESTAGE_DRIVER_SHA256',
    'REVAGENT_PRESTAGE_EVIDENCE_SHA256',
    'REVAGENT_PRESTAGE_INTEGRITY_SHA256',
    'REVAGENT_PRESTAGE_TRUSTED_KEYS_SHA256'
)) {
    $pinMatch = [regex]::Match($sealedBuiltWrapperText, ('(?m)^set "{0}=(?<value>[A-F0-9]{{64}})"\r?$' -f [regex]::Escape($name)))
    Assert-True $pinMatch.Success "Built supervised test kit is missing sealed pin $name."
    $sealedBuiltPins[$name] = $pinMatch.Groups['value'].Value
}

$oldTemplate = $env:REVAGENT_SUPERVISED_EVIDENCE_TEMPLATE
$oldResultMode = $env:REVAGENT_SUPERVISED_RESULT_MODE
$oldModulePath = $env:PSModulePath
$sealedEnvironmentNames = @(
    'REVAGENT_PRESTAGE_DRIVER',
    'REVAGENT_PRESTAGE_DRIVER_SHA256',
    'REVAGENT_PRESTAGE_KIT_ROOT',
    'REVAGENT_PRESTAGE_EVIDENCE_SHA256',
    'REVAGENT_PRESTAGE_INTEGRITY_SHA256',
    'REVAGENT_PRESTAGE_TRUSTED_KEYS_SHA256',
    'REVAGENT_PRESTAGE_TEST_CONFIG',
    'REVAGENT_PRESTAGE_TEST_CONFIG_SHA256'
)
$oldSealedStageEnvironment = @{}
foreach ($name in $sealedEnvironmentNames) {
    $oldSealedStageEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:REVAGENT_SUPERVISED_EVIDENCE_TEMPLATE = $evidenceTemplatePath
    $poisonRoot = Join-Path $fixtureRoot 'poison-modules'
    $poisonModuleRoot = Join-Path $poisonRoot 'Microsoft.PowerShell.Utility'
    [void][IO.Directory]::CreateDirectory($poisonModuleRoot)
    $poisonMarkerLiteral = $poisonMarker.Replace("'", "''")
    [IO.File]::WriteAllText((Join-Path $poisonModuleRoot 'Microsoft.PowerShell.Utility.psm1'), "[IO.File]::WriteAllText('$poisonMarkerLiteral','loaded'); function Get-FileHash { throw 'poisoned Get-FileHash executed' }", $utf8)
    [IO.File]::WriteAllText((Join-Path $poisonModuleRoot 'Microsoft.PowerShell.Utility.psd1'), "@{ RootModule='Microsoft.PowerShell.Utility.psm1'; ModuleVersion='99.0.0'; FunctionsToExport=@('Get-FileHash') }", $utf8)
    $env:PSModulePath = $poisonRoot + [IO.Path]::PathSeparator + $oldModulePath
    $env:REVAGENT_SUPERVISED_RESULT_MODE = 'unelevated-coordinator'
    $savedErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $badResultOutput = @(& $windowsPowerShell `
            -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $driverPath `
            -ReleaseRoot $releaseRoot -TrustedKeysPath $trustedKeysPath -RepoRoot $repoRoot -Channel stable `
            -AllowTestRoot -TestProgramDataRoot $programDataRoot -TestWorkRoot $workRoot `
            -TestEvidenceProducerPath $fakeProducerPath -TestAdministratorState elevated -TestSkipAclHardening 2>&1 | ForEach-Object { [string]$_ })
        $badResultExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedErrorActionPreference }
    Assert-True ($badResultExitCode -ne 0 -and ($badResultOutput -join ' ') -match 'Evidence producer result did not attest supervised administrator prestage mode') "Driver accepted a non-supervised producer result. output=$($badResultOutput -join ' | ')"

    $env:REVAGENT_SUPERVISED_RESULT_MODE = 'supervised-admin-prestage'
    $env:REVAGENT_PRESTAGE_DRIVER = Join-Path $sealedKitExtractRoot 'scripts\Invoke-RevAgentSupervisedPrestage.ps1'
    $env:REVAGENT_PRESTAGE_DRIVER_SHA256 = [string]$sealedBuiltPins.REVAGENT_PRESTAGE_DRIVER_SHA256
    $env:REVAGENT_PRESTAGE_KIT_ROOT = $sealedKitExtractRoot
    $env:REVAGENT_PRESTAGE_EVIDENCE_SHA256 = [string]$sealedBuiltPins.REVAGENT_PRESTAGE_EVIDENCE_SHA256
    $env:REVAGENT_PRESTAGE_INTEGRITY_SHA256 = [string]$sealedBuiltPins.REVAGENT_PRESTAGE_INTEGRITY_SHA256
    $env:REVAGENT_PRESTAGE_TRUSTED_KEYS_SHA256 = [string]$sealedBuiltPins.REVAGENT_PRESTAGE_TRUSTED_KEYS_SHA256
    $env:REVAGENT_PRESTAGE_TEST_CONFIG = $sealedStageConfigPath
    $env:REVAGENT_PRESTAGE_TEST_CONFIG_SHA256 = $sealedStageConfigSha256
    $driverOutput = @(& $windowsPowerShell `
        -NoLogo `
        -NoProfile `
        -NonInteractive `
        -ExecutionPolicy Bypass `
        -EncodedCommand $sealedBuiltEncodedMatch.Groups['encoded'].Value 2>&1 | ForEach-Object { [string]$_ })
    $driverExitCode = $LASTEXITCODE

    Assert-Equal $driverExitCode 0 "Built ZIP/CMD encoded bootstrap through sealed staging and the disposable PS5 driver failed. output=$($driverOutput -join ' | ')"
    Assert-True (Test-Path -LiteralPath $sealedStageResultPath -PathType Leaf) 'Built sealed-stage chain did not emit its bounded success evidence.'
    $sealedStageResult = Get-Content -Raw -LiteralPath $sealedStageResultPath | ConvertFrom-Json
    Assert-True ([bool]$sealedStageResult.sealedStageCompleted -and [bool]$sealedStageResult.stagedDriverCompleted) 'Built sealed-stage chain did not complete the staged driver.'
    Assert-True ([bool]$sealedStageResult.aclProtected) 'Built sealed-stage chain did not create an inheritance-protected staging ACL.'
    Assert-Equal ([string]$sealedStageResult.ownerSid) ([string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value) 'Bounded mock-elevation staging ACL owner drifted.'
    Assert-True ([bool]$sealedStageResult.noDeleteShareVerified) 'Built sealed-stage chain did not behaviorally prove its no-delete-share guard.'
    Assert-True ([bool]$sealedStageResult.stageRootRemoved -and -not (Test-Path -LiteralPath ([string]$sealedStageResult.stageRoot))) 'Built sealed-stage chain did not clean its secured staging root.'
    Assert-True (-not (Test-Path -LiteralPath $poisonMarker)) 'Driver loaded a user-controlled module from inherited PSModulePath.'
    $installedStatePath = Join-Path $bootstrapRoot 'bootstrap-state.json'
    Assert-True (Test-Path -LiteralPath $installedStatePath -PathType Leaf) 'Real staged installer did not install bootstrap-state.json.'
    $installedState = Get-Content -Raw -LiteralPath $installedStatePath | ConvertFrom-Json
    Assert-Equal ([string]$installedState.sourceAuthentication.method) 'supervised-admin-prestage' 'Installed bootstrap recorded the wrong source authentication mode.'
    Assert-True ([bool]$installedState.sourceAuthentication.independentlyAuthenticated) 'Installed bootstrap lost independent-authentication state.'
    foreach ($role in @('bootstrap','launcher','updaterGui','distributionIntegrity','permissions','sourceFreeMigration','releaseSnapshot','privilegedSnapshotUpdate','trustedKeys')) {
        Assert-True ($null -ne $installedState.files.PSObject.Properties[$role]) "Installed bootstrap state is missing role '$role'."
        $relativePath = [string]$installedState.files.$role.relativePath
        Assert-True (Test-Path -LiteralPath (Join-Path $bootstrapRoot $relativePath) -PathType Leaf) "Installed bootstrap role '$role' is missing on disk."
    }
    $trustRoot = Join-Path $programDataRoot 'DPE\revAgent\trust'
    $trustStatePath = Join-Path $trustRoot 'trust-state.json'
    foreach ($trustFile in @('RevAgent.BootstrapTrust.psm1', 'Invoke-RevAgent-BootstrapTrustBroker.ps1', 'RevAgent.DistributionIntegrity.psm1', 'RevAgent.ReleaseSnapshot.psm1', 'release-trusted-keys.json', 'trust-state.json')) {
        Assert-True (Test-Path -LiteralPath (Join-Path $trustRoot $trustFile) -PathType Leaf) "Supervised E2 prestage did not install trust-core file '$trustFile'."
    }
    $trustState = Get-Content -Raw -LiteralPath $trustStatePath | ConvertFrom-Json
    Assert-Equal ([string]$trustState.task.taskName) 'revAgent Bootstrap Trust Broker' 'Trust-core state did not bind the fixed production task name.'
    Assert-Equal ([string]$trustState.task.taskPath) '\DPE\revAgent\' 'Trust-core state did not bind the fixed production task path.'
    Assert-True ([string]$trustState.task.arguments -match '(?i)-File\s+".*Invoke-RevAgent-BootstrapTrustBroker\.ps1"$' -and [string]$trustState.task.arguments -notmatch '(?i)-(Expected|Trusted|ReleaseRoot|Inbox|Request|Result|Hash|EncodedCommand)') 'Trust-core task state contains mutable caller-supplied security arguments.'
    Assert-True (Test-Path -LiteralPath (Join-Path $desktopRoot 'revAgent Updater.lnk') -PathType Leaf) 'Real staged installer did not create the revAgent desktop shortcut.'
    $stagedEvidencePath = Join-Path $programDataRoot 'DPE\revAgent\prestage\bootstrap-prestage-evidence.json'
    Assert-True (Test-Path -LiteralPath $stagedEvidencePath -PathType Leaf) 'Driver did not stage evidence below the disposable ProgramData root.'
    $stagedEvidence = Get-Content -Raw -LiteralPath $stagedEvidencePath | ConvertFrom-Json
    Assert-Equal ([string]$stagedEvidence.producerMode) 'supervised-admin-prestage' 'Staged evidence lost producerMode.'
    Assert-True ([bool]$stagedEvidence.supervisedAdminPrestage) 'Staged evidence lost supervisedAdminPrestage.'

    $stagedInstallerPath = Join-Path $programDataRoot 'DPE\revAgent\prestage\install-revagent-local-bootstrap.ps1'
    $stagedTrustedKeysPath = Join-Path $programDataRoot 'DPE\revAgent\prestage\release-trusted-keys.json'
    $currentConsumerSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $differentValidSid = if ([string]::Equals($currentConsumerSid, 'S-1-5-18', [StringComparison]::OrdinalIgnoreCase)) { 'S-1-5-19' } else { 'S-1-5-18' }
    $negativeEvidenceCases = @(
        [pscustomobject]@{ Name='different producer SID'; Mutate={ param($document) $document.generatedBySid=$differentValidSid }.GetNewClosure() },
        [pscustomobject]@{ Name='malformed producer SID'; Mutate={ param($document) $document.generatedBySid='not-a-sid' } },
        [pscustomobject]@{ Name='inconsistent producer mode'; Mutate={ param($document) $document.supervisedAdminPrestage=$false } }
    )
    foreach ($negativeCase in $negativeEvidenceCases) {
        $negativeEvidence = (Get-Content -Raw -LiteralPath $stagedEvidencePath | ConvertFrom-Json)
        & $negativeCase.Mutate $negativeEvidence
        $negativePath = Join-Path $fixtureRoot (('negative-' + [Guid]::NewGuid().ToString('N') + '.json'))
        [IO.File]::WriteAllText($negativePath, ($negativeEvidence | ConvertTo-Json -Depth 10), $utf8)
        $savedErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $negativeOutput = @(& $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
                -File $stagedInstallerPath `
                -RepoRoot $packageSource `
                -ReleaseRoot $releaseRoot `
                -TrustedKeysPath $stagedTrustedKeysPath `
                -ExpectedHashesPath $negativePath `
                -ConfirmIndependentlyAuthenticatedSource 2>&1 | ForEach-Object { [string]$_ })
            $negativeExitCode = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $savedErrorActionPreference }
        Assert-True ($negativeExitCode -ne 0 -and ($negativeOutput -join ' ') -match 'does not satisfy the revAgent bootstrap-prestage schema/version/signature contract') "Consumer did not fail closed for $($negativeCase.Name). output=$($negativeOutput -join ' | ')"
    }

    $standardEvidence = (Get-Content -Raw -LiteralPath $stagedEvidencePath | ConvertFrom-Json)
    $standardEvidence.producerMode = 'unelevated-coordinator'
    $standardEvidence.supervisedAdminPrestage = $false
    $standardEvidence.generatedBySid = $differentValidSid
    Assert-True (-not [string]::Equals([string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value, [string]$standardEvidence.generatedBySid, [StringComparison]::OrdinalIgnoreCase)) 'Standard-mode regression fixture requires a producer SID different from the consumer SID.'
    $standardEvidencePath = Join-Path $fixtureRoot 'standard-mode-evidence.json'
    [IO.File]::WriteAllText($standardEvidencePath, ($standardEvidence | ConvertTo-Json -Depth 10), $utf8)
    $currentAccount = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'
    & $icacls $bootstrapRoot /grant:r ("$currentAccount`:(F)") /T /C /Q | Out-Null
    $standardOutput = @(& $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File $stagedInstallerPath `
        -RepoRoot $packageSource `
        -ReleaseRoot $releaseRoot `
        -TrustedKeysPath $stagedTrustedKeysPath `
        -ExpectedHashesPath $standardEvidencePath `
        -ConfirmIndependentlyAuthenticatedSource 2>&1 | ForEach-Object { [string]$_ })
    $standardExitCode = $LASTEXITCODE
    Assert-Equal $standardExitCode 0 "Consumer rejected a valid unelevated-coordinator evidence SID from a distinct principal. output=$($standardOutput -join ' | ')"
    $standardInstalledState = Get-Content -Raw -LiteralPath $installedStatePath | ConvertFrom-Json
    Assert-Equal ([string]$standardInstalledState.sourceAuthentication.method) 'unelevated-coordinator' 'Standard-mode consumer recorded the wrong authentication method.'
    Assert-Equal (Get-ChildItem -LiteralPath $workRoot -Force | Measure-Object).Count 0 'Driver left its supervised work directory behind.'
}
finally {
    $env:REVAGENT_SUPERVISED_EVIDENCE_TEMPLATE = $oldTemplate
    $env:REVAGENT_SUPERVISED_RESULT_MODE = $oldResultMode
    $env:PSModulePath = $oldModulePath
    foreach ($name in $sealedEnvironmentNames) {
        [Environment]::SetEnvironmentVariable($name, [string]$oldSealedStageEnvironment[$name], 'Process')
    }
    if ($null -ne $testRsa) { $testRsa.Dispose() }
    if (Test-Path -LiteralPath $bootstrapRoot -PathType Container) {
        $currentAccount = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'
        & $icacls $bootstrapRoot /grant:r ("$currentAccount`:(F)") /T /C /Q | Out-Null
    }
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}

Write-Host 'Supervised prestage tests passed.' -ForegroundColor Green
