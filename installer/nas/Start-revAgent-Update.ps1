<#
.SYNOPSIS
    Protected local trust anchor for launching the revAgent update GUI.
#>

[CmdletBinding()]
param(
    [string]$ChannelManifestPath = "",
    [string]$BootstrapRoot = "",
    [switch]$VerificationOnly,
    [switch]$RuntimePathSmokeTest,
    [switch]$AllowTestRoot,
    [Parameter(DontShow = $true)][string]$TestMachineName = "",
    [Parameter(DontShow = $true)][scriptblock]$TestBeforeGuiLaunchHook = $null
)

if ("$($ExecutionContext.SessionState.LanguageMode)" -ne 'FullLanguage') {
    Write-Host "revAgent updater cannot run: PowerShell is in $($ExecutionContext.SessionState.LanguageMode) mode."
    Write-Host "This is typically caused by Smart App Control or a WDAC/AppLocker policy on this machine."
    Write-Host "Ask IT to exempt/sign the revAgent deployment scripts or disable Smart App Control, then retry."
    exit 78
}

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function New-RevAgentBootstrapGuiStartInfo {
    param(
        [Parameter(Mandatory = $true)][string]$GuiPath,
        [Parameter(Mandatory = $true)][string]$ChannelPath,
        [Parameter(Mandatory = $true)][string]$BootstrapStatePath
    )

    $powershellPath = Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"
    if (-not [IO.File]::Exists($powershellPath)) { throw "Trusted Windows PowerShell runtime was not found: $powershellPath" }
    $arguments = @("-STA", "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $GuiPath, "-ChannelManifestPath", $ChannelPath, "-BootstrapStatePath", $BootstrapStatePath)
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $powershellPath
    $startInfo.Arguments = ($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join " "
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardError = $false
    $startInfo.WorkingDirectory = Split-Path -Parent $powershellPath
    return $startInfo
}

function New-RevAgentGuiLaunchStderrLogPath {
    $localAppDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ([string]::IsNullOrWhiteSpace($localAppDataRoot)) { throw 'Windows LocalApplicationData could not be resolved for GUI launch diagnostics.' }
    $logDirectory = [IO.Path]::Combine($localAppDataRoot, 'DPE', 'revAgent', 'logs')
    [void][IO.Directory]::CreateDirectory($logDirectory)
    $logName = 'gui-launch-stderr-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid().ToString('N') + '.log'
    return [IO.Path]::Combine($logDirectory, $logName)
}

function Write-RevAgentGuiLaunchFailureLog {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int]$ExitCode,
        [AllowEmptyString()][string]$StandardError
    )

    $content = @(
        'revAgent GUI launch failure',
        ('timestampUtc=' + [DateTime]::UtcNow.ToString('o')),
        ('exitCode=' + [string]$ExitCode),
        ('languageMode=' + [string]$ExecutionContext.SessionState.LanguageMode),
        ('psVersion=' + [string]$PSVersionTable.PSVersion),
        'stderr=',
        [string]$StandardError
    )
    [IO.File]::WriteAllLines($Path, [string[]]$content, [Text.UTF8Encoding]::new($false))
}

function Show-RevAgentGuiLaunchFailure {
    param([Parameter(Mandatory = $true)][string]$Message)

    try { [Console]::Error.WriteLine($Message) } catch { }
    try {
        [void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
        [void][System.Windows.Forms.MessageBox]::Show(
            $Message,
            'revAgent startup error',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error)
    }
    catch { }
}

function Start-RevAgentBootstrapGuiProcess {
    param(
        [Parameter(Mandatory = $true)][Diagnostics.ProcessStartInfo]$StartInfo,
        [ValidateRange(100, 10000)][int]$StartupWaitMilliseconds = 10000,
        [switch]$SuppressNotification
    )

    $stderrLogPath = New-RevAgentGuiLaunchStderrLogPath
    $guiProcess = $null
    $guiExitCode = $null
    try {
        $guiProcess = Microsoft.PowerShell.Management\Start-Process `
            -FilePath ([string]$StartInfo.FileName) `
            -ArgumentList ([string]$StartInfo.Arguments) `
            -WorkingDirectory ([string]$StartInfo.WorkingDirectory) `
            -WindowStyle Hidden `
            -RedirectStandardError $stderrLogPath `
            -PassThru `
            -ErrorAction Stop
        if ($null -eq $guiProcess) { throw 'revAgent updater GUI process did not start.' }

        # Pin the native handle before the quick-exit check. Windows PowerShell
        # 5.1 can otherwise surface an already-exited Start-Process result whose
        # ExitCode has not yet been associated with a process handle.
        [void]$guiProcess.Handle
        if (-not $guiProcess.WaitForExit($StartupWaitMilliseconds)) { return }

        $guiProcess.WaitForExit()
        $guiExitCode = [int]$guiProcess.ExitCode
    }
    finally {
        if ($null -ne $guiProcess) { $guiProcess.Dispose() }
    }

    if ($guiExitCode -eq 0) {
        try { [IO.File]::Delete($stderrLogPath) }
        catch { }
        return
    }

    $guiStandardError = ''
    try {
        if ([IO.File]::Exists($stderrLogPath)) {
            $guiStandardError = [IO.File]::ReadAllText($stderrLogPath)
        }
    }
    catch {
        $guiStandardError = 'stderr log read failed: ' + [string]$_.Exception.Message
    }
    Write-RevAgentGuiLaunchFailureLog -Path $stderrLogPath -ExitCode $guiExitCode -StandardError $guiStandardError
    $launchFailureMessage = "revAgent updater window exited during startup with code $guiExitCode. Diagnostic log: $stderrLogPath"
    if (-not $SuppressNotification) { Show-RevAgentGuiLaunchFailure -Message $launchFailureMessage }
    throw $launchFailureMessage
}

$systemDirectory = [Environment]::SystemDirectory
$trustedModuleRoots = @(
    (Join-Path $PSHOME "Modules"),
    (Join-Path $systemDirectory "WindowsPowerShell\v1.0\Modules")
) | Where-Object { [IO.Directory]::Exists($_) } | Select-Object -Unique
if (@($trustedModuleRoots).Count -eq 0) { throw "No trusted PowerShell module root was found for local bootstrap." }
$env:PSModulePath = [string]::Join([IO.Path]::PathSeparator, [string[]]$trustedModuleRoots)
foreach ($moduleName in @("Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Security")) {
    $manifest = Join-Path $PSHOME ("Modules\{0}\{0}.psd1" -f $moduleName)
    if (-not [IO.File]::Exists($manifest)) { throw "Required trusted PowerShell module was not found: $manifest" }
    Microsoft.PowerShell.Core\Import-Module -Name $manifest -Force -ErrorAction Stop
}

$programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$canonicalBootstrapRoot = Join-Path $programData "DPE\revAgent\bootstrap"
if ($RuntimePathSmokeTest) {
    $runtimeStartInfo = New-RevAgentBootstrapGuiStartInfo `
        -GuiPath 'C:\Program Files\revAgent Bootstrap Smoke\Install-revAgent-Updater-GUI.ps1' `
        -ChannelPath 'C:\Program Files\revAgent Bootstrap Smoke\channels\stable.json' `
        -BootstrapStatePath 'C:\Program Files\revAgent Bootstrap Smoke\bootstrap-state.json'
    [pscustomobject]@{
        success = $true
        powershellPath = [string]$runtimeStartInfo.FileName
        arguments = [string]$runtimeStartInfo.Arguments
        useShellExecute = [bool]$runtimeStartInfo.UseShellExecute
        createNoWindow = [bool]$runtimeStartInfo.CreateNoWindow
        workingDirectory = [string]$runtimeStartInfo.WorkingDirectory
        verb = [string]$runtimeStartInfo.Verb
        userName = [string]$runtimeStartInfo.UserName
        domain = [string]$runtimeStartInfo.Domain
        hasPassword = $null -ne $runtimeStartInfo.Password
        redirectStandardInput = [bool]$runtimeStartInfo.RedirectStandardInput
        redirectStandardOutput = [bool]$runtimeStartInfo.RedirectStandardOutput
        redirectStandardError = [bool]$runtimeStartInfo.RedirectStandardError
        stderrRedirectionMode = 'direct_file'
        processStartInfo = $runtimeStartInfo
    }
    return
}
if ([string]::IsNullOrWhiteSpace($BootstrapRoot)) { $BootstrapRoot = $canonicalBootstrapRoot }
$BootstrapRoot = [IO.Path]::GetFullPath($BootstrapRoot).TrimEnd("\")
if (-not $AllowTestRoot -and -not [string]::Equals($BootstrapRoot, [IO.Path]::GetFullPath($canonicalBootstrapRoot).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Local bootstrap must run from the canonical protected root: $canonicalBootstrapRoot"
}
if ((-not [string]::IsNullOrWhiteSpace($TestMachineName) -or $null -ne $TestBeforeGuiLaunchHook) -and -not $AllowTestRoot) {
    throw 'Bootstrap test seams are available only with -AllowTestRoot.'
}
$expectedEntrypoint = Join-Path $BootstrapRoot "Start-revAgent-Update.ps1"
if (-not [string]::Equals([IO.Path]::GetFullPath($PSCommandPath), [IO.Path]::GetFullPath($expectedEntrypoint), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Local bootstrap entrypoint mismatch. Expected=$expectedEntrypoint Actual=$PSCommandPath"
}

function Test-RevAgentBootstrapPathUnderRoot {
    param([string]$Path, [string]$Root)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd("\")
    return [string]::Equals($fullPath.TrimEnd("\"), $fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + "\", [StringComparison]::OrdinalIgnoreCase)
}

function Assert-RevAgentBootstrapPathSafe {
    param([string]$Path, [string]$Root, [switch]$RequireReadOnly)
    if (-not (Test-RevAgentBootstrapPathUnderRoot -Path $Path -Root $Root)) { throw "Bootstrap path escaped its root: $Path" }
    $cursor = [IO.Path]::GetFullPath($Path)
    while (Test-RevAgentBootstrapPathUnderRoot -Path $cursor -Root $Root) {
        if (-not (Test-Path -LiteralPath $cursor)) { throw "Bootstrap path is missing: $cursor" }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
            throw "Bootstrap path contains a filesystem link: $cursor"
        }
        if ($RequireReadOnly -and -not $item.PSIsContainer) {
            $fsutil = Join-Path ([Environment]::SystemDirectory) "fsutil.exe"
            $linkOutput = @(& $fsutil hardlink list $item.FullName 2>&1)
            if ($LASTEXITCODE -ne 0 -or @($linkOutput | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -ne 1) {
                throw "Protected local bootstrap file must have exactly one hardlink reference: $($item.FullName)"
            }
        }
        if ($RequireReadOnly) {
            $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
            $acl = Get-Acl -LiteralPath $cursor -ErrorAction Stop
            $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
            if (-not $AllowTestRoot -and $ownerSid -notin @("S-1-5-18", "S-1-5-32-544")) { throw "Protected local bootstrap owner must be SYSTEM or Administrators. path=$cursor owner=$ownerSid" }
            if (-not $acl.AreAccessRulesProtected) {
                throw "Protected local bootstrap DACL must be protected from inheritance: $cursor"
            }
            $trustedWriterSids = @("S-1-5-18", "S-1-5-32-544")
            foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
                if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                    $trustedWriterSids -notcontains [string]$rule.IdentityReference.Value -and
                    (($rule.FileSystemRights -band $writeMask) -ne 0)) {
                    throw "Protected local bootstrap grants write-capable access to an untrusted principal. path=$cursor principal=$($rule.IdentityReference.Value) rights=$($rule.FileSystemRights)"
                }
            }
        }
        if ([string]::Equals($cursor.TrimEnd("\"), [IO.Path]::GetFullPath($Root).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }
}

function Assert-RevAgentFileEffectivelyReadOnly {
    param([string]$Path, [string]$Label)
    $probes = @(
        [pscustomobject]@{ mode = [IO.FileMode]::Open; modeName = "FileMode.Open" },
        [pscustomobject]@{ mode = [IO.FileMode]::Append; modeName = "FileMode.Append" }
    )
    foreach ($probe in $probes) {
        $stream = $null
        $accessDenied = $false
        try { $stream = [IO.File]::Open($Path, $probe.mode, [IO.FileAccess]::Write, [IO.FileShare]::Read) }
        catch {
            $exception = $_.Exception
            while ($null -ne $exception) {
                if ($exception -is [UnauthorizedAccessException] -or (([int]$exception.HResult -band 0xFFFF) -eq 5)) {
                    $accessDenied = $true
                    break
                }
                $exception = $exception.InnerException
            }
            if (-not $accessDenied) {
                throw "$Label effective file-write probe failed unexpectedly through $($probe.modeName)/FileAccess.Write: $($_.Exception.Message)"
            }
        }
        finally { if ($null -ne $stream) { $stream.Dispose() } }
        if (-not $accessDenied) {
            throw "$Label is effectively writable through $($probe.modeName)/FileAccess.Write: $Path"
        }
    }
}

function Assert-RevAgentDirectoryEffectivelyReadOnly {
    param([string]$Directory, [string]$Label)
    $probe = Join-Path $Directory (".revagent-bootstrap-probe-{0}.tmp" -f [Guid]::NewGuid().ToString("N"))
    $stream = $null
    try {
        $stream = [IO.File]::Open($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    }
    catch {
        $exception = $_.Exception
        while ($null -ne $exception) {
            if ($exception -is [UnauthorizedAccessException] -or (([int]$exception.HResult -band 0xFFFF) -eq 5)) { return }
            $exception = $exception.InnerException
        }
        throw "$Label effective read-only probe failed unexpectedly: $($_.Exception.Message)"
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    [IO.File]::Delete($probe)
    if (Test-Path -LiteralPath $probe) { throw "$Label writable probe cleanup failed: $probe" }
    throw "$Label is effectively writable; CreateNew succeeded: $Directory"
}

$statePath = Join-Path $BootstrapRoot "bootstrap-state.json"
[void](Assert-RevAgentBootstrapPathSafe -Path $statePath -Root $BootstrapRoot -RequireReadOnly)
Assert-RevAgentDirectoryEffectivelyReadOnly -Directory $BootstrapRoot -Label "Protected local bootstrap"
Assert-RevAgentFileEffectivelyReadOnly -Path $statePath -Label "Protected local bootstrap state"
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
if ([int]$state.schemaVersion -ne 1 -or -not [bool]$state.sourceAuthentication.independentlyAuthenticated -or -not [bool]$state.sourceAuthentication.operatorConfirmed) {
    throw "Local bootstrap state does not prove independently authenticated administrator prestage."
}
if (-not [string]::Equals([IO.Path]::GetFullPath([string]$state.bootstrapRoot).TrimEnd("\"), $BootstrapRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Local bootstrap state root mismatch."
}

foreach ($property in $state.files.PSObject.Properties) {
    $filePath = Join-Path $BootstrapRoot ([string]$property.Value.relativePath)
    [void](Assert-RevAgentBootstrapPathSafe -Path $filePath -Root $BootstrapRoot -RequireReadOnly)
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $filePath).Hash
    if (-not [string]::Equals($actualHash, [string]$property.Value.sha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Protected local bootstrap hash mismatch: $($property.Name)"
    }
    Assert-RevAgentFileEffectivelyReadOnly -Path $filePath -Label "Protected local bootstrap file"
}

$localIntegrityModule = Join-Path $BootstrapRoot ([string]$state.files.distributionIntegrity.relativePath)
$pinnedIntegrityModuleHash = "C4B005D4333BD973C595D7590809D7BDA663807AF47A69ACDDF0E3955000D3E6"
if (-not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $localIntegrityModule).Hash, $pinnedIntegrityModuleHash, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Protected local distribution-integrity verifier does not match the bootstrap pin."
}
$localTrustedKeysPath = Join-Path $BootstrapRoot ([string]$state.files.trustedKeys.relativePath)
$trustedKeysStream = $null
try {
    $trustedKeysStream = [IO.File]::Open($localTrustedKeysPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($trustedKeysStream.Length -lt 1 -or $trustedKeysStream.Length -gt 65536) {
        throw "Protected trusted-key document size is outside the bounded 1..65536 policy: $localTrustedKeysPath"
    }
    $trustedKeysBytes = New-Object byte[] ([int]$trustedKeysStream.Length)
    $trustedKeysOffset = 0
    while ($trustedKeysOffset -lt $trustedKeysBytes.Length) {
        $trustedKeysRead = $trustedKeysStream.Read($trustedKeysBytes, $trustedKeysOffset, $trustedKeysBytes.Length - $trustedKeysOffset)
        if ($trustedKeysRead -le 0) { throw "Protected trusted-key document ended before its declared length: $localTrustedKeysPath" }
        $trustedKeysOffset += $trustedKeysRead
    }
    if ($trustedKeysStream.ReadByte() -ne -1) { throw "Protected trusted-key document grew while it was acquired: $localTrustedKeysPath" }
}
finally { if ($null -ne $trustedKeysStream) { $trustedKeysStream.Dispose() } }
$strictTrustedKeysUtf8 = [Text.UTF8Encoding]::new($false, $true)
$trustedKeysJson = $strictTrustedKeysUtf8.GetString($trustedKeysBytes)
if ($trustedKeysJson.Length -gt 0 -and $trustedKeysJson[0] -eq [char]0xFEFF) { $trustedKeysJson = $trustedKeysJson.Substring(1) }

Microsoft.PowerShell.Utility\Add-Type -AssemblyName System.Runtime.Serialization -ErrorAction Stop
$trustedKeysJsonBytes = $trustedKeysBytes
if ($trustedKeysBytes.Length -ge 3 -and $trustedKeysBytes[0] -eq 0xEF -and $trustedKeysBytes[1] -eq 0xBB -and $trustedKeysBytes[2] -eq 0xBF) {
    $trustedKeysJsonBytes = New-Object byte[] ($trustedKeysBytes.Length - 3)
    [Array]::Copy($trustedKeysBytes, 3, $trustedKeysJsonBytes, 0, $trustedKeysJsonBytes.Length)
}
$trustedKeysReader = $null
try {
    $trustedKeysReader = [Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader($trustedKeysJsonBytes, [Xml.XmlDictionaryReaderQuotas]::Max)
    $trustedKeysTokenDocument = [Xml.XmlDocument]::new()
    $trustedKeysTokenDocument.XmlResolver = $null
    $trustedKeysTokenDocument.Load($trustedKeysReader)
}
catch { throw "Protected trusted-key bytes are not strict JSON: $($_.Exception.Message)" }
finally { if ($null -ne $trustedKeysReader) { $trustedKeysReader.Dispose() } }
$trustedKeysTokenRoot = $trustedKeysTokenDocument.DocumentElement
if ($null -eq $trustedKeysTokenRoot -or
    -not [string]::Equals([string]$trustedKeysTokenRoot.LocalName, 'root', [StringComparison]::Ordinal) -or
    -not [string]::Equals([string]$trustedKeysTokenRoot.GetAttribute('type'), 'object', [StringComparison]::Ordinal)) {
    throw 'Protected trusted-key document must be one JSON object.'
}
$trustedKeysTopLevelTokenNodes = @($trustedKeysTokenRoot.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element })

$trustedInputIntegrityModule = Import-Module $localIntegrityModule -Force -PassThru
$duplicateTrustedKeyProperty = & $trustedInputIntegrityModule { param($Value) Find-RevitMcpDuplicateJsonObjectKey -Json $Value } $trustedKeysJson
if ([bool]$duplicateTrustedKeyProperty.found) {
    throw "Protected trusted-key document contains a duplicate decoded JSON property: $($duplicateTrustedKeyProperty.key)"
}
$trustedKeyDocument = $trustedKeysJson | ConvertFrom-Json
$trustedKeyTopLevelProperties = @($trustedKeyDocument.PSObject.Properties)
$trustedKeyTopLevelAllowlist = @('schemaVersion', 'app', 'generatedAtUtc', 'trustedKeys')
$trustedKeyMinimalTopLevel = $trustedKeyTopLevelProperties.Count -eq 1 -and [string]::Equals([string]$trustedKeyTopLevelProperties[0].Name, 'trustedKeys', [StringComparison]::Ordinal)
$trustedKeyMetadataTopLevel = $trustedKeyTopLevelProperties.Count -eq $trustedKeyTopLevelAllowlist.Count -and
    @($trustedKeyTopLevelProperties | Where-Object { $trustedKeyTopLevelAllowlist -cnotcontains [string]$_.Name }).Count -eq 0 -and
    @($trustedKeyTopLevelAllowlist | Where-Object { @($trustedKeyTopLevelProperties.Name) -cnotcontains $_ }).Count -eq 0
if (-not $trustedKeyMinimalTopLevel -and -not $trustedKeyMetadataTopLevel) {
    throw 'Protected trusted-key document properties must be exactly trustedKeys, or exactly schemaVersion, app, generatedAtUtc, trustedKeys.'
}
if ($trustedKeyMetadataTopLevel) {
    $trustedKeysGeneratedAtNodes = @($trustedKeysTopLevelTokenNodes | Where-Object {
            $propertyName = if ([string]::Equals([string]$_.LocalName, 'item', [StringComparison]::Ordinal) -and $_.HasAttribute('item')) {
                [string]$_.GetAttribute('item')
            }
            else { [string]$_.LocalName }
            [string]::Equals($propertyName, 'generatedAtUtc', [StringComparison]::Ordinal)
        })
    $trustedKeysGeneratedAtText = if ($trustedKeysGeneratedAtNodes.Count -eq 1 -and
        [string]::Equals([string]$trustedKeysGeneratedAtNodes[0].GetAttribute('type'), 'string', [StringComparison]::Ordinal)) {
        [string]$trustedKeysGeneratedAtNodes[0].InnerText
    }
    else { $null }
    $trustedKeysGeneratedAt = [DateTimeOffset]::MinValue
    if (($trustedKeyDocument.schemaVersion -isnot [int] -and $trustedKeyDocument.schemaVersion -isnot [long]) -or
        [long]$trustedKeyDocument.schemaVersion -ne 1 -or
        $trustedKeyDocument.app -isnot [string] -or
        ([string]$trustedKeyDocument.app -cne 'revAgent' -and [string]$trustedKeyDocument.app -cne 'revit-mcp-skill') -or
        [string]$trustedKeysGeneratedAtText -cnotmatch 'Z$' -or
        -not [DateTimeOffset]::TryParse([string]$trustedKeysGeneratedAtText, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$trustedKeysGeneratedAt) -or
        $trustedKeysGeneratedAt.Offset -ne [TimeSpan]::Zero -or
        $trustedKeysGeneratedAt.UtcDateTime -gt [DateTime]::UtcNow.AddMinutes(5)) {
        throw 'Protected trusted-key metadata must be schemaVersion 1, an accepted revAgent app identity, and ISO UTC generatedAtUtc.'
    }
}
$productionKeyId = "revagent-prod-rsa-2026q3"
$trustedKeyProperties = @($trustedKeyDocument.trustedKeys.PSObject.Properties)
if (-not $AllowTestRoot -and
    ($trustedKeyProperties.Count -lt 1 -or $trustedKeyProperties.Count -gt 2 -or
        $null -eq $trustedKeyDocument.trustedKeys.PSObject.Properties[$productionKeyId])) {
    throw "Protected production trusted-key set must contain '$productionKeyId' and at most one transition key."
}
if (-not $AllowTestRoot -and $trustedKeyProperties.Count -eq 2) {
    $transitionKeyId = [string](@($trustedKeyProperties | Where-Object { -not [string]::Equals([string]$_.Name, $productionKeyId, [StringComparison]::Ordinal) })[0].Name)
    $transitionMatch = [regex]::Match($transitionKeyId, '^revagent-prod-rsa-(?<year>[0-9]{4})q(?<quarter>[1-4])$')
    $transitionOrdinal = if ($transitionMatch.Success) { ([int]$transitionMatch.Groups['year'].Value * 4) + [int]$transitionMatch.Groups['quarter'].Value } else { 0 }
    if (-not $transitionMatch.Success -or $transitionOrdinal -le ((2026 * 4) + 3)) {
        throw "Protected transition key must be later than ${productionKeyId}: $transitionKeyId"
    }
}
$trustedFingerprints = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($trustedKeyProperty in $trustedKeyProperties) {
    $candidateKey = $trustedKeyProperty.Value
    $candidateFields = @($candidateKey.PSObject.Properties)
    $requiredKeyFields = @('algorithm', 'publicKeyFingerprint', 'publicKeyXml')
    $allowedKeyFields = @('algorithm', 'publicKeyFingerprint', 'publicKeyXml', 'purpose')
    if ($candidateFields.Count -lt $requiredKeyFields.Count -or $candidateFields.Count -gt $allowedKeyFields.Count -or
        @($candidateFields | Where-Object { $allowedKeyFields -cnotcontains [string]$_.Name }).Count -ne 0 -or
        @($requiredKeyFields | Where-Object { @($candidateFields.Name) -cnotcontains $_ }).Count -ne 0 -or
        ($null -ne $candidateKey.PSObject.Properties['purpose'] -and [string]$candidateKey.purpose -cne 'release-signing') -or
        -not [string]::Equals([string]$candidateKey.algorithm, 'RS256', [StringComparison]::Ordinal) -or
        [string]$candidateKey.publicKeyFingerprint -notmatch '^[A-Fa-f0-9]{64}$') {
        throw "Protected trusted-key entry is not an exact public RS256 record: $($trustedKeyProperty.Name)"
    }
    $candidateXmlSettings = [Xml.XmlReaderSettings]::new()
    $candidateXmlSettings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $candidateXmlSettings.XmlResolver = $null
    $candidateXmlStringReader = [IO.StringReader]::new([string]$candidateKey.publicKeyXml)
    $candidateXmlReader = $null
    try {
        $candidateXmlReader = [Xml.XmlReader]::Create($candidateXmlStringReader, $candidateXmlSettings)
        $candidateXml = [Xml.XmlDocument]::new()
        $candidateXml.XmlResolver = $null
        $candidateXml.Load($candidateXmlReader)
    }
    finally {
        if ($null -ne $candidateXmlReader) { $candidateXmlReader.Dispose() }
        $candidateXmlStringReader.Dispose()
    }
    $candidateElements = @($candidateXml.DocumentElement.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element } | ForEach-Object { $_.Name })
    if ($null -eq $candidateXml.DocumentElement -or
        -not [string]::Equals([string]$candidateXml.DocumentElement.Name, 'RSAKeyValue', [StringComparison]::Ordinal) -or
        $candidateElements.Count -ne 2 -or
        @((Compare-Object @('Exponent', 'Modulus') @($candidateElements | Sort-Object) -SyncWindow 0)).Count -ne 0) {
        throw "Protected trusted-key XML contains private or unexpected RSA parameters: $($trustedKeyProperty.Name)"
    }
    $normalizedCandidate = ([string]$candidateKey.publicKeyXml).Trim() -replace '\s+', ''
    $candidateSha = [Security.Cryptography.SHA256]::Create()
    try { $candidateFingerprint = ([BitConverter]::ToString($candidateSha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedCandidate)))).Replace('-', '') }
    finally { $candidateSha.Dispose() }
    if (-not [string]::Equals($candidateFingerprint, [string]$candidateKey.publicKeyFingerprint, [StringComparison]::OrdinalIgnoreCase) -or
        -not $trustedFingerprints.Add($candidateFingerprint)) {
        throw "Protected trusted-key fingerprint is invalid or duplicated: $($trustedKeyProperty.Name)"
    }
}
$trustedKey = $trustedKeyDocument.trustedKeys."revagent-prod-rsa-2026q3"
if ($null -eq $trustedKey) { throw "Protected local trusted-key set does not contain the production release key." }
if (-not $AllowTestRoot -and
    (-not [string]::Equals([string]$trustedKey.algorithm, "RS256", [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$trustedKey.publicKeyFingerprint, "32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33", [StringComparison]::OrdinalIgnoreCase))) {
    throw "Protected local release-key metadata does not match the pinned RS256 key."
}
$normalizedPublicKey = ([string]$trustedKey.publicKeyXml).Trim() -replace "\s+", ""
$sha = [Security.Cryptography.SHA256]::Create()
try { $fingerprint = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedPublicKey)))).Replace("-", "") } finally { $sha.Dispose() }
if ($fingerprint -ne "32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33") { throw "Protected local production release-key fingerprint mismatch." }

$bootstrapChannel = [string]$state.release.channel
if ($bootstrapChannel -notin @('stable', 'pilot')) { throw "Protected bootstrap state contains an unsupported release channel: $bootstrapChannel" }
if ([string]::IsNullOrWhiteSpace($ChannelManifestPath)) { $ChannelManifestPath = Join-Path ([string]$state.releaseRoot) "channels\$bootstrapChannel.json" }
$ChannelManifestPath = [IO.Path]::GetFullPath($ChannelManifestPath)
$channelRoot = Split-Path -Parent $ChannelManifestPath
$releaseRoot = [IO.Path]::GetFullPath((Split-Path -Parent $channelRoot)).TrimEnd("\")
if (-not $AllowTestRoot -and -not [string]::Equals($releaseRoot, "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Protected bootstrap requires the canonical NAS release root; refusing '$releaseRoot'."
}
if (-not [string]::Equals($releaseRoot, [IO.Path]::GetFullPath([string]$state.releaseRoot).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Bootstrap state release root does not match the requested channel."
}
$expectedChannelPath = Join-Path (Join-Path $releaseRoot "channels") "$bootstrapChannel.json"
if (-not [string]::Equals($ChannelManifestPath, [IO.Path]::GetFullPath($expectedChannelPath), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Protected bootstrap accepts only the exact state-bound channel data path: $expectedChannelPath"
}

[void](Assert-RevAgentBootstrapPathSafe -Path $ChannelManifestPath -Root $releaseRoot)
$channel = Get-Content -Raw -LiteralPath $ChannelManifestPath | ConvertFrom-Json
if (-not [string]::Equals([string]$channel.channel, $bootstrapChannel, [StringComparison]::Ordinal)) {
    throw "Signed channel identity does not match protected bootstrap state. state=$bootstrapChannel signed=$($channel.channel)"
}
$releaseManifestPath = [string]$channel.manifestPath
if (-not [IO.Path]::IsPathRooted($releaseManifestPath)) { $releaseManifestPath = Join-Path $channelRoot $releaseManifestPath }
$releaseManifestPath = [IO.Path]::GetFullPath($releaseManifestPath)
[void](Assert-RevAgentBootstrapPathSafe -Path $releaseManifestPath -Root $releaseRoot)
$releaseManifest = Get-Content -Raw -LiteralPath $releaseManifestPath | ConvertFrom-Json

$localCurrentReleaseBindings = [ordered]@{
    bootstrap = @("localBootstrap", "installer\nas\Start-revAgent-Update.ps1")
    launcher = @("localBootstrapLauncher", "installer\nas\Start-revAgent-Update.cmd")
    updaterGui = @("updaterGui", "installer\nas\Install-revAgent-Updater-GUI.ps1")
    distributionIntegrity = @("installerLibDistributionIntegrity", "installer\lib\RevAgent.DistributionIntegrity.psm1")
    permissions = @("installerLibPermissions", "installer\lib\RevAgent.Permissions.psm1")
    sourceFreeMigration = @("installerLibSourceFreeMigration", "installer\lib\RevAgent.SourceFreeMigration.psm1")
    releaseSnapshot = @("installerLibReleaseSnapshot", "installer\lib\RevAgent.ReleaseSnapshot.psm1")
    privilegedSnapshotUpdate = @("privilegedSnapshotUpdate", "installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1")
}
foreach ($binding in $localCurrentReleaseBindings.GetEnumerator()) {
    $localFile = $state.files.($binding.Key)
    $currentComponent = $releaseManifest.components.([string]$binding.Value[0])
    if ($null -eq $localFile -or $null -eq $currentComponent -or
        -not [string]::Equals(([string]$currentComponent.path).Replace("/", "\"), [string]$binding.Value[1], [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$localFile.sha256, [string]$currentComponent.sha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "bootstrap_refresh_required: protected local '$($binding.Key)' does not match current signed component '$($binding.Value[0])'. Administrator/coordinator prestage is required before this release can run."
    }
}

$packagePath = [string]$channel.packagePath
if ([string]::IsNullOrWhiteSpace($packagePath)) { throw "Signed stable channel does not declare packagePath." }
if (-not [IO.Path]::IsPathRooted($packagePath)) { $packagePath = Join-Path $channelRoot $packagePath }
$packagePath = [IO.Path]::GetFullPath($packagePath)
[void](Assert-RevAgentBootstrapPathSafe -Path $packagePath -Root $releaseRoot)

$channelSignaturePath = Join-Path $channelRoot (([IO.Path]::GetFileNameWithoutExtension($ChannelManifestPath)) + ".sig.json")
$manifestSignaturePath = Join-Path (Split-Path -Parent $releaseManifestPath) (([IO.Path]::GetFileNameWithoutExtension($releaseManifestPath)) + ".sig.json")
foreach ($signedTransportPath in @($ChannelManifestPath, $channelSignaturePath, $releaseManifestPath, $manifestSignaturePath, $packagePath)) {
    [void](Assert-RevAgentBootstrapPathSafe -Path $signedTransportPath -Root $releaseRoot)
}

$integrityModule = Import-Module $localIntegrityModule -Force -PassThru
$integrityCommand = Get-Command ("{0}\Test-RevAgentReleaseDistributionIntegrity" -f $integrityModule.Name) -ErrorAction Stop
$integrity = & $integrityCommand -ChannelPath $ChannelManifestPath -Channel $channel -ReleaseManifestPath $releaseManifestPath -ReleaseManifest $releaseManifest -TrustedKeys $trustedKeyDocument.trustedKeys -Policy enforce
if (-not [bool]$integrity.success) { throw "Protected bootstrap rejected the signed release: $($integrity.reason). $($integrity.message)" }
$pilotPolicy = if ($channel.PSObject.Properties['pilotPolicy']) { $channel.pilotPolicy } else { $null }
if ($bootstrapChannel -eq 'pilot') {
    if ($null -eq $pilotPolicy -or [int]$pilotPolicy.schemaVersion -ne 1) {
        throw 'Protected pilot channel requires pilotPolicy schemaVersion 1.'
    }
    $machineName = if ([string]::IsNullOrWhiteSpace($TestMachineName)) { [Environment]::MachineName.Trim().ToUpperInvariant() } else { $TestMachineName.Trim().ToUpperInvariant() }
    $allowedMachines = @($pilotPolicy.allowedMachineNames | ForEach-Object { ([string]$_).Trim().ToUpperInvariant() })
    if ($allowedMachines.Count -eq 0 -or $allowedMachines -notcontains $machineName) {
        throw "pilot_machine_not_allowed: protected pilot channel does not authorize this computer: $machineName"
    }
}
elseif ($null -ne $pilotPolicy) { throw 'Protected stable channel must not contain pilotPolicy.' }
$expectedPackageHash = [string]$channel.sha256
if ($expectedPackageHash -notmatch '^[A-Fa-f0-9]{64}$') { throw "Signed stable channel does not declare a valid package SHA-256." }
$actualPackageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash
if (-not [string]::Equals($actualPackageHash, $expectedPackageHash, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Signed release package transport hash mismatch. Expected=$expectedPackageHash Actual=$actualPackageHash"
}
foreach ($path in @($ChannelManifestPath, $channelSignaturePath, $releaseManifestPath, $manifestSignaturePath, $packagePath)) {
    [void](Assert-RevAgentBootstrapPathSafe -Path $path -Root $releaseRoot)
}

$result = [pscustomobject][ordered]@{
    success = $true
    action = "local-protected-update-bootstrap"
    bootstrapRoot = $BootstrapRoot
    bootstrapStatePath = $statePath
    channelManifestPath = $ChannelManifestPath
    releaseManifestPath = $releaseManifestPath
    packagePath = $packagePath
    packageSha256 = $actualPackageHash
    verifiedSurfaceCount = $localCurrentReleaseBindings.Count
    sourceAuthentication = $state.sourceAuthentication
    distributionIntegrity = $integrity
}
if ($VerificationOnly) { $result; return }

$guiPath = Join-Path $BootstrapRoot ([string]$state.files.updaterGui.relativePath)
$psi = New-RevAgentBootstrapGuiStartInfo -GuiPath $guiPath -ChannelPath $ChannelManifestPath -BootstrapStatePath $statePath
if ($null -ne $TestBeforeGuiLaunchHook) { & $TestBeforeGuiLaunchHook $psi }
Start-RevAgentBootstrapGuiProcess -StartInfo $psi -SuppressNotification:($null -ne $TestBeforeGuiLaunchHook)
$result
