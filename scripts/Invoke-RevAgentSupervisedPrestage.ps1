<#
.SYNOPSIS
    Perform the supervised, single-principal revAgent bootstrap prestage.

.DESCRIPTION
    This IT-only driver runs in one elevated Windows PowerShell 5.1 process. It
    produces signed-release evidence itself, carries the derived hashes in
    memory, and applies the protected ProgramData prestage contract without
    manual transcription. It does not enable the dormant self-service refresh
    path or publish anything to the NAS release channel.
#>

[CmdletBinding()]
param(
    [string]$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy",
    [string]$TrustedKeysPath = "",
    [ValidateSet("stable", "pilot")][string]$Channel = "stable",
    [string]$RepoRoot = "",
    [switch]$AllowTestRoot,
    [Parameter(DontShow = $true)][switch]$StageSealedKit,
    [Parameter(DontShow = $true)][string]$SourceKitRoot = "",
    [Parameter(DontShow = $true)][string]$ExpectedDriverSha256 = "",
    [Parameter(DontShow = $true)][string]$ExpectedEvidenceSha256 = "",
    [Parameter(DontShow = $true)][string]$ExpectedIntegritySha256 = "",
    [Parameter(DontShow = $true)][string]$ExpectedTrustedKeysSha256 = "",
    [Parameter(DontShow = $true)][string]$SealedStageTestConfigPath = "",
    [Parameter(DontShow = $true)][string]$ExpectedSealedStageTestConfigSha256 = "",
    [Parameter(DontShow = $true)][string]$TestProgramDataRoot = "",
    [Parameter(DontShow = $true)][string]$TestWorkRoot = "",
    [Parameter(DontShow = $true)][string]$TestEvidenceProducerPath = "",
    [Parameter(DontShow = $true)][ValidateSet("", "elevated", "standard")][string]$TestAdministratorState = "",
    [Parameter(DontShow = $true)][switch]$TestSkipAclHardening
)

if ("$($ExecutionContext.SessionState.LanguageMode)" -ne 'FullLanguage') {
    Write-Host "revAgent supervised prestage cannot run: PowerShell is in $($ExecutionContext.SessionState.LanguageMode) mode."
    Write-Host "This is typically caused by Smart App Control or a WDAC/AppLocker policy on this machine."
    Write-Host "Ask IT to exempt/sign the revAgent prestage kit or disable Smart App Control, then retry."
    exit 78
}

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$systemDirectory = [Environment]::SystemDirectory
$trustedModuleRoots = [Collections.Generic.List[string]]::new()
foreach ($candidateModuleRoot in @(
    [IO.Path]::Combine($PSHOME, 'Modules'),
    [IO.Path]::Combine($systemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules')
)) {
    if ([IO.Directory]::Exists($candidateModuleRoot) -and -not $trustedModuleRoots.Contains($candidateModuleRoot)) {
        [void]$trustedModuleRoots.Add($candidateModuleRoot)
    }
}
$env:PSModulePath = [string]::Join([IO.Path]::PathSeparator, $trustedModuleRoots.ToArray())
foreach ($moduleName in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    $manifest = [IO.Path]::Combine($PSHOME, 'Modules', $moduleName, ($moduleName + '.psd1'))
    if (-not [IO.File]::Exists($manifest)) { throw "Required trusted PowerShell module was not found: $manifest" }
    Microsoft.PowerShell.Core\Import-Module -Name $manifest -Force -ErrorAction Stop
}
$archiveManifest = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Archive', 'Microsoft.PowerShell.Archive.psd1')
if (-not [IO.File]::Exists($archiveManifest)) { throw "Required trusted PowerShell archive module was not found: $archiveManifest" }
Microsoft.PowerShell.Core\Import-Module -Name $archiveManifest -Force -ErrorAction Stop

function Get-RevAgentSupervisedCanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $volumeRoot = [IO.Path]::GetPathRoot($fullPath)
    if ([string]::Equals($fullPath.TrimEnd('\'), $volumeRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        return $volumeRoot
    }
    return $fullPath.TrimEnd('\')
}

function Test-RevAgentSupervisedPathUnderRoot {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root)

    $fullPath = Get-RevAgentSupervisedCanonicalPath -Path $Path
    $fullRoot = Get-RevAgentSupervisedCanonicalPath -Path $Root
    return [string]::Equals($fullPath.TrimEnd("\"), $fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot.TrimEnd('\') + "\", [StringComparison]::OrdinalIgnoreCase)
}

function Assert-RevAgentSupervisedPathNoLinks {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$StopRoot)

    $cursor = Get-RevAgentSupervisedCanonicalPath -Path $Path
    $canonicalStopRoot = Get-RevAgentSupervisedCanonicalPath -Path $StopRoot
    while (Test-RevAgentSupervisedPathUnderRoot -Path $cursor -Root $StopRoot) {
        if (-not (Test-Path -LiteralPath $cursor)) { throw "Supervised prestage source path is missing: $cursor" }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) {
            throw "Supervised prestage source contains a filesystem link/reparse component: $cursor"
        }
        if ([string]::Equals($cursor.TrimEnd("\"), $canonicalStopRoot.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }
}

function New-RevAgentSupervisedWorkDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [switch]$UseTestAcl,
        [Security.Principal.SecurityIdentifier]$TestOwnerSid
    )

    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd("\")
    if (-not (Test-Path -LiteralPath $parentFull -PathType Container)) {
        throw "Supervised prestage work parent does not exist: $parentFull"
    }
    $parentItem = Get-Item -LiteralPath $parentFull -Force -ErrorAction Stop
    $parentLinkType = if ($parentItem.PSObject.Properties['LinkType']) { [string]$parentItem.LinkType } else { '' }
    if (-not $parentItem.PSIsContainer -or
        ($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not [string]::IsNullOrWhiteSpace($parentLinkType)) {
        throw "Supervised prestage work parent is a filesystem link/reparse point: $parentFull"
    }
    $name = 'revagent-supervised-prestage-' + [Guid]::NewGuid().ToString('N')
    if ($UseTestAcl) {
        return [IO.Directory]::CreateDirectory((Join-Path $parentFull $name)).FullName
    }

    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $ownerSid = if ($null -eq $TestOwnerSid) { [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544') } else { $TestOwnerSid }
    $acl.SetOwner($ownerSid)
    $aclSids = if ($null -eq $TestOwnerSid) { @('S-1-5-18', 'S-1-5-32-544') } else { @('S-1-5-18', [string]$TestOwnerSid.Value) }
    foreach ($sid in $aclSids) {
        [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid),
            [Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        ))
    }
    return [IO.DirectoryInfo]::new($parentFull).CreateSubdirectory($name, $acl).FullName
}

function Assert-RevAgentSupervisedKitTrust {
    param(
        [Parameter(Mandatory = $true)][string]$KitRoot,
        [Parameter(Mandatory = $true)][string[]]$RequiredPaths,
        [Security.Principal.SecurityIdentifier]$AdditionalTrustedSid
    )

    $trustedOwnerSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    if ($null -ne $AdditionalTrustedSid) { $trustedOwnerSids += [string]$AdditionalTrustedSid.Value }
    $dangerousRights = [Security.AccessControl.FileSystemRights]::Write -bor
        [Security.AccessControl.FileSystemRights]::Modify -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    $canonicalRoot = Get-RevAgentSupervisedCanonicalPath -Path $KitRoot
    foreach ($path in @($canonicalRoot) + @($RequiredPaths)) {
        $fullPath = [IO.Path]::GetFullPath($path)
        if (-not (Test-RevAgentSupervisedPathUnderRoot -Path $fullPath -Root $canonicalRoot)) {
            throw "Supervised prestage kit member escaped the kit root: $fullPath"
        }
        $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
        $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) {
            throw "Supervised prestage kit member is a filesystem link/reparse point: $fullPath"
        }
        $acl = Get-Acl -LiteralPath $fullPath
        $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($trustedOwnerSids -notcontains $ownerSid) {
            throw "Supervised prestage kit must be owned by SYSTEM, Administrators, or TrustedInstaller. path=$fullPath owner=$ownerSid"
        }
        if ([string]::Equals($fullPath.TrimEnd('\'), $canonicalRoot, [StringComparison]::OrdinalIgnoreCase) -and -not $acl.AreAccessRulesProtected) {
            throw "Supervised prestage kit root must have an inheritance-protected admin/IT-only ACL: $canonicalRoot"
        }
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $trustedOwnerSids -notcontains [string]$rule.IdentityReference.Value -and
                (($rule.FileSystemRights -band $dangerousRights) -ne 0)) {
                throw "Supervised prestage kit is writable by an untrusted principal. path=$fullPath principal=$($rule.IdentityReference.Value)"
            }
        }
    }
}

function Read-RevAgentSupervisedKitScriptBytes {
    param([Parameter(Mandatory = $true)][string]$Path, [int]$MaxBytes = 2097152)

    $stream = $null
    try {
        $stream = [IO.File]::Open([IO.Path]::GetFullPath($Path), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($stream.Length -lt 1 -or $stream.Length -gt $MaxBytes) { throw "Supervised prestage kit script size is outside policy: $Path" }
        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw "Supervised prestage kit script ended before its declared length: $Path" }
            $offset += $read
        }
        if ($stream.ReadByte() -ne -1) { throw "Supervised prestage kit script grew while it was being read: $Path" }
        return ,$bytes
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Get-RevAgentSupervisedSha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace('-', '') }
    finally { $sha256.Dispose() }
}

function Read-RevAgentSupervisedPinnedBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [int]$MaxBytes = 4194304
    )

    if ($ExpectedSha256 -cnotmatch '^[A-F0-9]{64}$') {
        throw "Supervised prestage expected SHA-256 is invalid for '$Path'."
    }
    $bytes = Read-RevAgentSupervisedKitScriptBytes -Path $Path -MaxBytes $MaxBytes
    $actualSha256 = Get-RevAgentSupervisedSha256 -Bytes $bytes
    if (-not [string]::Equals($actualSha256, $ExpectedSha256, [StringComparison]::Ordinal)) {
        throw "Supervised prestage sealed input hash mismatch. path=$Path expected=$ExpectedSha256 actual=$actualSha256"
    }
    return ,$bytes
}

function Write-RevAgentSupervisedPinnedBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )

    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Read-RevAgentSealedStageTestConfiguration {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$TempRoot
    )

    $configPath = [IO.Path]::GetFullPath($Path)
    if (-not (Test-RevAgentSupervisedPathUnderRoot -Path $configPath -Root $TempRoot)) {
        throw 'Sealed staging test configuration must remain below TEMP.'
    }
    Assert-RevAgentSupervisedPathNoLinks -Path $configPath -StopRoot $TempRoot
    $configBytes = Read-RevAgentSupervisedPinnedBytes -Path $configPath -ExpectedSha256 $ExpectedSha256 -MaxBytes 32768
    $configText = [Text.UTF8Encoding]::new($false, $true).GetString($configBytes)
    if ($configText.Length -gt 0 -and $configText[0] -eq [char]0xFEFF) { $configText = $configText.Substring(1) }
    $config = $configText | ConvertFrom-Json
    if ($config -isnot [pscustomobject]) { throw 'Sealed staging test configuration must be one JSON object.' }
    $expectedProperties = @(
        'schemaVersion',
        'mockElevation',
        'stagingParent',
        'releaseRoot',
        'programDataRoot',
        'workRoot',
        'evidenceProducerPath',
        'resultPath'
    )
    $actualProperties = @($config.PSObject.Properties)
    if ($actualProperties.Count -ne $expectedProperties.Count -or
        @($actualProperties | Where-Object { $expectedProperties -cnotcontains [string]$_.Name }).Count -ne 0 -or
        @($expectedProperties | Where-Object { @($actualProperties.Name) -cnotcontains $_ }).Count -ne 0) {
        throw 'Sealed staging test configuration properties do not match the exact fixture schema.'
    }
    if ([int]$config.schemaVersion -ne 1 -or $config.mockElevation -isnot [bool] -or -not [bool]$config.mockElevation) {
        throw 'Sealed staging test configuration requires schemaVersion=1 and mockElevation=true.'
    }

    $normalized = [ordered]@{}
    foreach ($propertyName in @('stagingParent', 'releaseRoot', 'programDataRoot', 'workRoot', 'evidenceProducerPath', 'resultPath')) {
        if ($config.$propertyName -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$config.$propertyName)) {
            throw "Sealed staging test configuration path is invalid: $propertyName"
        }
        $normalized[$propertyName] = [IO.Path]::GetFullPath([string]$config.$propertyName)
        if (-not (Test-RevAgentSupervisedPathUnderRoot -Path ([string]$normalized[$propertyName]) -Root $TempRoot)) {
            throw "Sealed staging test configuration path must remain below TEMP: $propertyName"
        }
    }
    foreach ($directoryProperty in @('stagingParent', 'releaseRoot', 'programDataRoot', 'workRoot')) {
        $directoryPath = [string]$normalized[$directoryProperty]
        if (-not (Test-Path -LiteralPath $directoryPath -PathType Container)) {
            throw "Sealed staging test configuration directory is missing: $directoryProperty"
        }
        Assert-RevAgentSupervisedPathNoLinks -Path $directoryPath -StopRoot $TempRoot
    }
    if (-not (Test-Path -LiteralPath ([string]$normalized.evidenceProducerPath) -PathType Leaf)) {
        throw 'Sealed staging test evidence producer is missing.'
    }
    Assert-RevAgentSupervisedPathNoLinks -Path ([string]$normalized.evidenceProducerPath) -StopRoot $TempRoot
    $resultParent = Split-Path -Parent ([string]$normalized.resultPath)
    if (-not (Test-Path -LiteralPath $resultParent -PathType Container)) {
        throw 'Sealed staging test result parent is missing.'
    }
    Assert-RevAgentSupervisedPathNoLinks -Path $resultParent -StopRoot $TempRoot
    if (Test-Path -LiteralPath ([string]$normalized.resultPath)) {
        throw 'Sealed staging test result path already exists.'
    }
    return [pscustomobject]$normalized
}

function Open-RevAgentSupervisedStagingLock {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not ('RevAgent.SupervisedStaging.NativeDirectoryLock' -as [type])) {
        Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent.SupervisedStaging {
    public static class NativeDirectoryLock {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        public static SafeFileHandle OpenWithoutDeleteShare(string path) {
            const uint GENERIC_READ = 0x80000000;
            const uint FILE_SHARE_READ = 0x00000001;
            const uint FILE_SHARE_WRITE = 0x00000002;
            const uint OPEN_EXISTING = 3;
            const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
            const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
            SafeFileHandle handle = CreateFileW(
                path,
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Could not lock the supervised prestage staging directory");
            }
            return handle;
        }
    }
}
'@ -Language CSharp -ErrorAction Stop
    }
    return [RevAgent.SupervisedStaging.NativeDirectoryLock]::OpenWithoutDeleteShare([IO.Path]::GetFullPath($Path))
}

function Invoke-RevAgentSupervisedSealedStaging {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][hashtable]$ExpectedHashes,
        [Parameter(Mandatory = $true)][ValidateSet('stable', 'pilot')][string]$TargetChannel,
        [pscustomobject]$TestConfiguration
    )

    $sourceRootFull = Get-RevAgentSupervisedCanonicalPath -Path $SourceRoot
    if ($sourceRootFull.StartsWith('\\', [StringComparison]::Ordinal)) {
        throw 'Supervised prestage source kit must be on a local filesystem.'
    }
    $sourceDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($sourceRootFull))
    if ($sourceDrive.DriveType -eq [IO.DriveType]::Network) {
        throw 'Supervised prestage source kit must not use a mapped network drive.'
    }
    Assert-RevAgentSupervisedPathNoLinks -Path $sourceRootFull -StopRoot ([IO.Path]::GetPathRoot($sourceRootFull))

    $relativeInputs = [ordered]@{
        Driver = 'scripts\Invoke-RevAgentSupervisedPrestage.ps1'
        Evidence = 'scripts\New-RevAgentBootstrapPrestageEvidence.ps1'
        Integrity = 'installer\lib\RevAgent.DistributionIntegrity.psm1'
        TrustedKeys = 'config\release-trusted-keys.json'
    }
    $capturedBytes = [ordered]@{}
    foreach ($entry in $relativeInputs.GetEnumerator()) {
        $sourcePath = [IO.Path]::GetFullPath((Join-Path $sourceRootFull ([string]$entry.Value)))
        if (-not (Test-RevAgentSupervisedPathUnderRoot -Path $sourcePath -Root $sourceRootFull)) {
            throw "Supervised prestage sealed input escaped the source kit root: $sourcePath"
        }
        Assert-RevAgentSupervisedPathNoLinks -Path $sourcePath -StopRoot $sourceRootFull
        $limit = if ([string]::Equals([string]$entry.Key, 'TrustedKeys', [StringComparison]::Ordinal)) { 1048576 } else { 4194304 }
        $capturedBytes[[string]$entry.Key] = Read-RevAgentSupervisedPinnedBytes `
            -Path $sourcePath `
            -ExpectedSha256 ([string]$ExpectedHashes[[string]$entry.Key]) `
            -MaxBytes $limit
    }

    $testStage = $null -ne $TestConfiguration
    $testOwnerSid = if ($testStage) { [Security.Principal.WindowsIdentity]::GetCurrent().User } else { $null }
    $windowsTemp = if ($testStage) {
        [string]$TestConfiguration.stagingParent
    }
    else {
        Join-Path ([IO.Directory]::GetParent([Environment]::SystemDirectory).FullName) 'Temp'
    }
    $stagingRoot = ''
    $stagingLock = $null
    $priorTemp = $env:TEMP
    $priorTmp = $env:TMP
    $stageCompleted = $false
    $stageOwnerSid = ''
    $stageAclProtected = $false
    $noDeleteShareVerified = $false
    try {
        $stagingRoot = New-RevAgentSupervisedWorkDirectory -Parent $windowsTemp -TestOwnerSid $testOwnerSid
        $env:TEMP = $stagingRoot
        $env:TMP = $stagingRoot
        $stagingLock = Open-RevAgentSupervisedStagingLock -Path $stagingRoot
        if ($testStage) {
            $renameProbe = $stagingRoot + '-rename-probe'
            $renameBlocked = $false
            try { [IO.Directory]::Move($stagingRoot, $renameProbe) }
            catch [IO.IOException] { $renameBlocked = $true }
            catch [UnauthorizedAccessException] { $renameBlocked = $true }
            if (-not $renameBlocked -or -not (Test-Path -LiteralPath $stagingRoot) -or (Test-Path -LiteralPath $renameProbe)) {
                throw 'Sealed staging test did not prove the no-delete-share directory guard.'
            }
            $noDeleteShareVerified = $true
        }

        foreach ($entry in $relativeInputs.GetEnumerator()) {
            $destinationPath = Join-Path $stagingRoot ([string]$entry.Value)
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destinationPath))
            Write-RevAgentSupervisedPinnedBytes -Path $destinationPath -Bytes ([byte[]]$capturedBytes[[string]$entry.Key])
            [void](Read-RevAgentSupervisedPinnedBytes `
                -Path $destinationPath `
                -ExpectedSha256 ([string]$ExpectedHashes[[string]$entry.Key]) `
                -MaxBytes $(if ([string]::Equals([string]$entry.Key, 'TrustedKeys', [StringComparison]::Ordinal)) { 1048576 } else { 4194304 }))
        }

        $requiredPaths = @($relativeInputs.Values | ForEach-Object { Join-Path $stagingRoot ([string]$_) })
        Assert-RevAgentSupervisedKitTrust -KitRoot $stagingRoot -RequiredPaths $requiredPaths -AdditionalTrustedSid $testOwnerSid
        $stagingAcl = Get-Acl -LiteralPath $stagingRoot
        $stageOwnerSid = [string]$stagingAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        $stageAclProtected = [bool]$stagingAcl.AreAccessRulesProtected
        $stagedDriver = Join-Path $stagingRoot ([string]$relativeInputs.Driver)
        if ($testStage) {
            # Add-Type has already compiled inside the protected stage. Restore
            # the fixture TEMP root before the staged driver's existing
            # AllowTestRoot checks; every supplied target remains independently
            # bounded and link-checked below the original process TEMP root.
            $env:TEMP = $priorTemp
            $env:TMP = $priorTmp
            & $stagedDriver `
                -ReleaseRoot ([string]$TestConfiguration.releaseRoot) `
                -Channel $TargetChannel `
                -AllowTestRoot `
                -TestProgramDataRoot ([string]$TestConfiguration.programDataRoot) `
                -TestWorkRoot ([string]$TestConfiguration.workRoot) `
                -TestEvidenceProducerPath ([string]$TestConfiguration.evidenceProducerPath) `
                -TestAdministratorState elevated `
                -TestSkipAclHardening
        }
        else {
            & $stagedDriver -Channel $TargetChannel
        }
        $stageCompleted = $true
    }
    finally {
        $env:TEMP = $priorTemp
        $env:TMP = $priorTmp
        if ($null -ne $stagingLock) { $stagingLock.Dispose() }
        if (-not [string]::IsNullOrWhiteSpace($stagingRoot) -and (Test-Path -LiteralPath $stagingRoot)) {
            Microsoft.PowerShell.Management\Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if ($testStage -and $stageCompleted) {
        $stageRemoved = -not (Test-Path -LiteralPath $stagingRoot)
        if (-not $stageRemoved) { throw 'Sealed staging test root cleanup did not complete.' }
        $result = [ordered]@{
            schemaVersion = 1
            sealedStageCompleted = $true
            stagedDriverCompleted = $true
            stageRoot = $stagingRoot
            stageRootRemoved = $stageRemoved
            aclProtected = $stageAclProtected
            ownerSid = $stageOwnerSid
            noDeleteShareVerified = $noDeleteShareVerified
        }
        $resultBytes = [Text.UTF8Encoding]::new($false).GetBytes(($result | ConvertTo-Json -Depth 4))
        Write-RevAgentSupervisedPinnedBytes -Path ([string]$TestConfiguration.resultPath) -Bytes $resultBytes
    }
}

if ($StageSealedKit) {
    if ($AllowTestRoot -or
        -not [string]::IsNullOrWhiteSpace($RepoRoot) -or
        -not [string]::IsNullOrWhiteSpace($TrustedKeysPath) -or
        -not [string]::IsNullOrWhiteSpace($TestProgramDataRoot) -or
        -not [string]::IsNullOrWhiteSpace($TestWorkRoot) -or
        -not [string]::IsNullOrWhiteSpace($TestEvidenceProducerPath) -or
        -not [string]::IsNullOrWhiteSpace($TestAdministratorState) -or
        $TestSkipAclHardening) {
        throw 'Sealed staging mode does not accept production-root overrides or test seams.'
    }
    $hasStageTestConfigPath = -not [string]::IsNullOrWhiteSpace($SealedStageTestConfigPath)
    $hasStageTestConfigHash = -not [string]::IsNullOrWhiteSpace($ExpectedSealedStageTestConfigSha256)
    if ($hasStageTestConfigPath -ne $hasStageTestConfigHash) {
        throw 'Sealed staging test configuration path and SHA-256 must be supplied together.'
    }
    $stageIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $stageAdministrator = [Security.Principal.WindowsPrincipal]::new($stageIdentity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($stageAdministrator -and $hasStageTestConfigPath) {
        throw 'Sealed staging test configuration is forbidden for an elevated token.'
    }
    $stageTestConfiguration = $null
    if ($hasStageTestConfigPath) {
        $originalTempRoot = Get-RevAgentSupervisedCanonicalPath -Path ([IO.Path]::GetTempPath())
        if ([string]::IsNullOrWhiteSpace($SourceKitRoot) -or
            -not (Test-RevAgentSupervisedPathUnderRoot -Path $SourceKitRoot -Root $originalTempRoot)) {
            throw 'Sealed staging mock-elevation mode requires the source kit below TEMP.'
        }
        $stageTestConfiguration = Read-RevAgentSealedStageTestConfiguration `
            -Path $SealedStageTestConfigPath `
            -ExpectedSha256 $ExpectedSealedStageTestConfigSha256 `
            -TempRoot $originalTempRoot
    }
    if (-not $stageAdministrator -and $null -eq $stageTestConfiguration) { throw 'revAgent sealed staging requires an elevated Windows PowerShell process.' }
    if ([string]::IsNullOrWhiteSpace($SourceKitRoot)) { throw 'Sealed staging requires SourceKitRoot.' }
    Invoke-RevAgentSupervisedSealedStaging -SourceRoot $SourceKitRoot -TargetChannel $Channel -TestConfiguration $stageTestConfiguration -ExpectedHashes @{
        Driver = $ExpectedDriverSha256
        Evidence = $ExpectedEvidenceSha256
        Integrity = $ExpectedIntegritySha256
        TrustedKeys = $ExpectedTrustedKeysSha256
    }
    exit 0
}

$kitRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = $kitRoot }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot).TrimEnd("\")
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\")
$canonicalReleaseRoot = [IO.Path]::GetFullPath("\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy").TrimEnd("\")
if ([string]::IsNullOrWhiteSpace($TrustedKeysPath)) {
    $TrustedKeysPath = Join-Path $RepoRoot 'config\release-trusted-keys.json'
}
$TrustedKeysPath = [IO.Path]::GetFullPath($TrustedKeysPath)

if (-not $AllowTestRoot) {
    $kitRoot = [IO.Path]::GetFullPath($kitRoot).TrimEnd("\")
    if (-not [string]::Equals($RepoRoot, $kitRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Production supervised prestage cannot override the IT kit root. expected=$kitRoot actual=$RepoRoot"
    }
    if ($RepoRoot.StartsWith('\\', [StringComparison]::Ordinal)) {
        throw 'Production supervised prestage kit must run from a local IT-controlled path, not UNC transport.'
    }
    $kitDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($RepoRoot))
    if ($kitDrive.DriveType -eq [IO.DriveType]::Network) {
        throw 'Production supervised prestage kit must not run from a mapped network drive.'
    }
    $expectedTrustedKeysPath = [IO.Path]::GetFullPath((Join-Path $kitRoot 'config\release-trusted-keys.json'))
    if (-not [string]::Equals($TrustedKeysPath, $expectedTrustedKeysPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Production supervised prestage cannot override the IT kit trusted-key path. expected=$expectedTrustedKeysPath actual=$TrustedKeysPath"
    }
    Assert-RevAgentSupervisedPathNoLinks -Path $kitRoot -StopRoot ([IO.Path]::GetPathRoot($kitRoot))
    Assert-RevAgentSupervisedPathNoLinks -Path $TrustedKeysPath -StopRoot $kitRoot
    Assert-RevAgentSupervisedKitTrust -KitRoot $kitRoot -RequiredPaths @(
        (Join-Path $kitRoot 'scripts\Invoke-RevAgentSupervisedPrestage.ps1'),
        (Join-Path $kitRoot 'scripts\New-RevAgentBootstrapPrestageEvidence.ps1'),
        (Join-Path $kitRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1'),
        $TrustedKeysPath
    )
}

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdministrator = [Security.Principal.WindowsPrincipal]::new($currentIdentity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not [string]::IsNullOrWhiteSpace($TestAdministratorState) -and -not $AllowTestRoot) {
    throw 'TestAdministratorState is available only with -AllowTestRoot.'
}
if ($AllowTestRoot) {
    $isAdministrator = if ([string]::Equals($TestAdministratorState, 'standard', [StringComparison]::Ordinal)) { $false } else { $true }
}
if (-not $isAdministrator) {
    throw 'revAgent supervised prestage requires an elevated Windows PowerShell process.'
}
if (-not $AllowTestRoot -and -not [string]::Equals($ReleaseRoot, $canonicalReleaseRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Production supervised prestage requires the canonical signed release root '$canonicalReleaseRoot'."
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\")
if ($AllowTestRoot) {
    foreach ($requiredTestPath in @($ReleaseRoot, $TestProgramDataRoot, $TestWorkRoot)) {
        if ([string]::IsNullOrWhiteSpace($requiredTestPath) -or -not (Test-RevAgentSupervisedPathUnderRoot -Path $requiredTestPath -Root $tempRoot)) {
            throw 'AllowTestRoot requires ReleaseRoot, TestProgramDataRoot, and TestWorkRoot below TEMP.'
        }
    }
    if (-not $TestSkipAclHardening) {
        throw 'AllowTestRoot requires -TestSkipAclHardening so fixtures never mutate production ACLs.'
    }
    if (-not [string]::IsNullOrWhiteSpace($TestEvidenceProducerPath) -and
        -not (Test-RevAgentSupervisedPathUnderRoot -Path $TestEvidenceProducerPath -Root $tempRoot)) {
        throw 'TestEvidenceProducerPath must remain below TEMP.'
    }
}
elseif (-not [string]::IsNullOrWhiteSpace($TestProgramDataRoot) -or
        -not [string]::IsNullOrWhiteSpace($TestWorkRoot) -or
        -not [string]::IsNullOrWhiteSpace($TestEvidenceProducerPath) -or
        -not [string]::IsNullOrWhiteSpace($TestAdministratorState) -or
        -not [string]::IsNullOrWhiteSpace($SealedStageTestConfigPath) -or
        -not [string]::IsNullOrWhiteSpace($ExpectedSealedStageTestConfigSha256) -or
        $TestSkipAclHardening) {
    throw 'Supervised prestage test seams are available only with -AllowTestRoot.'
}

$ProgramDataRoot = if ($AllowTestRoot) {
    [IO.Path]::GetFullPath($TestProgramDataRoot).TrimEnd("\")
}
else {
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
}
$windowsTemp = if ($AllowTestRoot) {
    [IO.Path]::GetFullPath($TestWorkRoot).TrimEnd("\")
}
else {
    Join-Path ([IO.Directory]::GetParent([Environment]::SystemDirectory).FullName) 'Temp'
}
$workRoot = New-RevAgentSupervisedWorkDirectory -Parent $windowsTemp -UseTestAcl:$AllowTestRoot
$SourceRoot = Join-Path $workRoot 'source'
$EvidenceSource = Join-Path $workRoot 'bootstrap-prestage-evidence.json'
$evidenceProducer = if (-not [string]::IsNullOrWhiteSpace($TestEvidenceProducerPath)) {
    [IO.Path]::GetFullPath($TestEvidenceProducerPath)
}
else {
    Join-Path $RepoRoot 'scripts\New-RevAgentBootstrapPrestageEvidence.ps1'
}

try {
    if (-not (Test-Path -LiteralPath $evidenceProducer -PathType Leaf)) {
        throw "Supervised prestage evidence producer was not found: $evidenceProducer"
    }
    if (-not $AllowTestRoot) {
        if (-not (Test-RevAgentSupervisedPathUnderRoot -Path $evidenceProducer -Root $RepoRoot)) {
            throw "Supervised prestage evidence producer escaped the IT kit root: $evidenceProducer"
        }
        Assert-RevAgentSupervisedPathNoLinks -Path $evidenceProducer -StopRoot $RepoRoot
    }

    $evidenceArguments = @{
        ReleaseRoot = $ReleaseRoot
        TrustedKeysPath = $TrustedKeysPath
        OutputPath = $EvidenceSource
        RepoRoot = $RepoRoot
        Channel = $Channel
        SupervisedAdminPrestage = $true
    }
    if ($AllowTestRoot) {
        $evidenceArguments.AllowTestRoot = $true
        $evidenceArguments.TestAdministratorState = 'elevated'
    }
    $evidenceProducerBytes = Read-RevAgentSupervisedKitScriptBytes -Path $evidenceProducer
    $strictProducerUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $evidenceProducerText = $strictProducerUtf8.GetString([byte[]]$evidenceProducerBytes)
    if ($evidenceProducerText.Length -gt 0 -and $evidenceProducerText[0] -eq [char]0xFEFF) { $evidenceProducerText = $evidenceProducerText.Substring(1) }
    $evidenceProducerScript = [ScriptBlock]::Create($evidenceProducerText)
    $producerOutput = @(& $evidenceProducerScript @evidenceArguments)
    $evidenceResult = @($producerOutput | Where-Object {
        $null -ne $_ -and $_.PSObject.Properties['success'] -and [bool]$_.success -and
        $_.PSObject.Properties['action'] -and [string]$_.action -eq 'bootstrap-prestage-evidence'
    } | Select-Object -Last 1)
    if ($evidenceResult.Count -ne 1) {
        throw 'Supervised prestage evidence producer did not return its successful result contract.'
    }
    $evidenceResult = $evidenceResult[0]
    if (-not $evidenceResult.PSObject.Properties['producerMode'] -or
        -not $evidenceResult.PSObject.Properties['supervisedAdminPrestage'] -or
        -not [string]::Equals([string]$evidenceResult.producerMode, 'supervised-admin-prestage', [StringComparison]::Ordinal) -or
        -not [bool]$evidenceResult.supervisedAdminPrestage) {
        throw 'Evidence producer result did not attest supervised administrator prestage mode.'
    }

    $evidence = Get-Content -Raw -LiteralPath $EvidenceSource | ConvertFrom-Json
    if (-not [bool]$evidence.supervisedAdminPrestage -or
        -not [string]::Equals([string]$evidence.producerMode, 'supervised-admin-prestage', [StringComparison]::Ordinal)) {
        throw 'Evidence producer did not attest supervised administrator prestage mode.'
    }
    $channelPath = Join-Path (Join-Path $ReleaseRoot 'channels') ($Channel + '.json')
    Assert-RevAgentSupervisedPathNoLinks -Path $channelPath -StopRoot $ReleaseRoot
    $channelDocument = Get-Content -Raw -LiteralPath $channelPath | ConvertFrom-Json
    if (-not [string]::Equals([string]$channelDocument.channel, $Channel, [StringComparison]::Ordinal)) {
        throw "Signed channel identity changed after evidence production. requested=$Channel actual=$($channelDocument.channel)"
    }
    $channelDirectory = Split-Path -Parent $channelPath
    $packagePath = if ([IO.Path]::IsPathRooted([string]$channelDocument.packagePath)) {
        [IO.Path]::GetFullPath([string]$channelDocument.packagePath)
    }
    else {
        [IO.Path]::GetFullPath((Join-Path $channelDirectory ([string]$channelDocument.packagePath)))
    }
    if (-not (Test-RevAgentSupervisedPathUnderRoot -Path $packagePath -Root $ReleaseRoot)) {
        throw "Signed package escaped ReleaseRoot after evidence production: $packagePath"
    }
    Assert-RevAgentSupervisedPathNoLinks -Path $packagePath -StopRoot $ReleaseRoot
    if (-not [string]::Equals((Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash, [string]$evidence.release.packageSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Signed package changed after supervised evidence production.'
    }

    Microsoft.PowerShell.Archive\Expand-Archive -LiteralPath $packagePath -DestinationPath $SourceRoot
    if (-not [string]::Equals((Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash, [string]$evidence.release.packageSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Signed package changed during supervised extraction.'
    }

    $ExpectedEvidenceSha256 = [string]$evidenceResult.outputSha256
    $ExpectedInstallerSha256 = [string]$evidence.localBootstrapInstallerScript
    $TrustedKeys = $TrustedKeysPath
    $trustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    $danger = [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership

# Compile the directory-lock helper only from this literal block, with compiler
# scratch isolated in an ACL-at-create administrator directory under Windows Temp.
if (-not ($AllowTestRoot -and $TestSkipAclHardening)) {
$windowsTemp = Join-Path ([IO.Directory]::GetParent([Environment]::SystemDirectory).FullName) 'Temp'
$compilerAcl = [Security.AccessControl.DirectorySecurity]::new()
$compilerAcl.SetAccessRuleProtection($true, $false)
$compilerAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
  [void]$compilerAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
}
$compilerTemp = [IO.DirectoryInfo]::new($windowsTemp).CreateSubdirectory(('revagent-prestage-native-' + [Guid]::NewGuid().ToString('N')), $compilerAcl).FullName
$oldTemp = $env:TEMP; $oldTmp = $env:TMP
try {
  $env:TEMP = $compilerTemp; $env:TMP = $compilerTemp
  if (-not ('RevAgent.Prestage.DirectoryLockNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace RevAgent.Prestage {
  public static class DirectoryLockNative {
    [StructLayout(LayoutKind.Sequential)] private struct FILETIME { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential)] private struct INFO { public uint Attributes; public FILETIME Creation; public FILETIME Access; public FILETIME Write; public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow; }
    [StructLayout(LayoutKind.Sequential)] private struct SECURITY_ATTRIBUTES { public int Length; public IntPtr SecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CreateDirectoryW(string path, ref SECURITY_ATTRIBUTES security);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out INFO info);
    [DllImport("advapi32.dll")] private static extern uint SetSecurityInfo(SafeFileHandle handle, int objectType, uint securityInformation, byte[] owner, byte[] group, byte[] dacl, byte[] sacl);
    private static SafeFileHandle OpenCore(string path, uint access, uint share, string purpose) { var h=CreateFileW(path,access,share,IntPtr.Zero,3,0x02200000,IntPtr.Zero); if(h==null||h.IsInvalid){int e=Marshal.GetLastWin32Error();if(h!=null)h.Dispose();throw new Win32Exception(e,purpose+": "+path);} return h; }
    public static SafeFileHandle Open(string path) { return OpenCore(path,0x80000000,3,"No-delete-share directory open failed"); }
    // SetSecurityInfo suppresses child ACE propagation only when this exact
    // supplied handle was opened with MAXIMUM_ALLOWED (0x02000000).
    public static SafeFileHandle OpenSecurity(string path) { return OpenCore(path,0x02000000,3,"MAXIMUM_ALLOWED no-delete-share directory open failed"); }
    public static SafeFileHandle OpenVerifier(string path) { return OpenCore(path,0,7,"Share-all directory identity open failed"); }
    private static INFO Read(SafeFileHandle h) { INFO i; if(h==null||h.IsInvalid||!GetFileInformationByHandle(h,out i)) throw new Win32Exception(Marshal.GetLastWin32Error()); return i; }
    public static uint Attributes(SafeFileHandle h) { return Read(h).Attributes; }
    public static string Identity(SafeFileHandle h) { var i=Read(h); return String.Format("{0:X8}:{1:X8}{2:X8}",i.Volume,i.IndexHigh,i.IndexLow); }
    public static int SetOwner(SafeFileHandle handle, byte[] owner) { if(owner==null||owner.Length==0) throw new ArgumentException("An owner SID is required.","owner"); return unchecked((int)SetSecurityInfo(handle,1,0x00000001,owner,null,null,null)); }
    public static int SetDaclUnprotected(SafeFileHandle handle, byte[] dacl) { if(dacl==null||dacl.Length==0) throw new ArgumentException("A non-null DACL is required.","dacl"); return unchecked((int)SetSecurityInfo(handle,1,0x20000004,null,null,dacl,null)); }
    public static int CreateDirectoryWithSecurityDescriptor(string path, byte[] descriptor) {
      if(descriptor==null||descriptor.Length==0) throw new ArgumentException("A self-relative security descriptor is required.","descriptor");
      GCHandle pin=GCHandle.Alloc(descriptor,GCHandleType.Pinned);
      try { var sa=new SECURITY_ATTRIBUTES { Length=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), SecurityDescriptor=pin.AddrOfPinnedObject(), InheritHandle=false }; if(CreateDirectoryW(path,ref sa)) return 0; return Marshal.GetLastWin32Error(); }
      finally { pin.Free(); }
    }
  }
}
'@
  }
} finally {
  $env:TEMP = $oldTemp; $env:TMP = $oldTmp
  if ([IO.Directory]::Exists($compilerTemp)) { [IO.Directory]::Delete($compilerTemp, $true) }
}
}

function Open-DirectoryGuard([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\'); $handle = $null
  try {
    $handle = [RevAgent.Prestage.DirectoryLockNative]::Open($full)
    $attributes = [RevAgent.Prestage.DirectoryLockNative]::Attributes($handle)
    if (($attributes -band [uint32][IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Guarded prestage path is not an ordinary directory: $full" }
    return [pscustomobject]@{ Path=$full; Handle=$handle; Identity=[RevAgent.Prestage.DirectoryLockNative]::Identity($handle) }
  } catch { if ($null -ne $handle) { $handle.Dispose() }; throw }
}

function Open-DpeSecurityGuard([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\'); $handle = $null
  try {
    $handle = [RevAgent.Prestage.DirectoryLockNative]::OpenSecurity($full)
    $attributes = [RevAgent.Prestage.DirectoryLockNative]::Attributes($handle)
    if (($attributes -band [uint32][IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Guarded shared DPE path is not an ordinary directory: $full" }
    return [pscustomobject]@{ Path=$full; Handle=$handle; Identity=[RevAgent.Prestage.DirectoryLockNative]::Identity($handle); SecurityMutation=$true }
  } catch { if ($null -ne $handle) { $handle.Dispose() }; throw }
}

function Assert-DirectoryGuardPath($Guard, [string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\'); $pathHandle = $null
  try {
    $pathHandle = [RevAgent.Prestage.DirectoryLockNative]::OpenVerifier($full)
    $attributes = [RevAgent.Prestage.DirectoryLockNative]::Attributes($pathHandle)
    $identity = [RevAgent.Prestage.DirectoryLockNative]::Identity($pathHandle)
    if (($attributes -band [uint32][IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::Equals($identity, [string]$Guard.Identity, [StringComparison]::Ordinal)) { throw "Prestage directory path/handle identity changed: $full" }
  } finally { if ($null -ne $pathHandle) { $pathHandle.Dispose() } }
}

function Assert-SafeExistingDirectory([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) { throw "Unsafe prestage ancestor: $Path" }
  $acl = Get-Acl -LiteralPath $Path
  $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($trustedOwners -notcontains $owner) { throw "Untrusted prestage ancestor owner: $Path owner=$owner" }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $trustedOwners -notcontains [string]$rule.IdentityReference.Value -and (($rule.FileSystemRights -band $danger) -ne 0)) { throw "Untrusted delete/ACL-capable ancestor rule: $Path principal=$($rule.IdentityReference.Value)" }
  }
}

function Get-AclRuleShape([string]$Sid, [Int64]$Rights, [int]$Type, [bool]$Inherited, [int]$Inheritance, [int]$Propagation) {
  return '{0}|{1}|{2}|{3}|{4}|{5}' -f $Sid, $Rights, $Type, $Inherited, $Inheritance, $Propagation
}

function Get-AclRuleShapeFromRule($Rule) {
  return Get-AclRuleShape ([string]$Rule.IdentityReference.Value) ([Int64]$Rule.FileSystemRights) ([int]$Rule.AccessControlType) ([bool]$Rule.IsInherited) ([int]$Rule.InheritanceFlags) ([int]$Rule.PropagationFlags)
}

function Get-RawAclAceShape($Ace) {
  if ($Ace -isnot [Security.AccessControl.CommonAce]) {
    return 'unsupported|{0}|{1}|{2}' -f ([int]$Ace.AceType), ([int]$Ace.AceFlags), ([int]$Ace.BinaryLength)
  }
  return '{0}|{1}|{2}|{3}|{4}|{5}' -f ([int]$Ace.AceType), ([int]$Ace.AceFlags), ([Int64]$Ace.AccessMask), ([string]$Ace.SecurityIdentifier.Value), ([bool]$Ace.IsCallback), ([int]$Ace.AceQualifier)
}

function Get-CanonicalSharedDpeRawShapes([string]$LegacyCreatorSid = '') {
  $legacy = if ([string]::IsNullOrWhiteSpace($LegacyCreatorSid)) { '' } else { '(A;ID;FA;;;{0})' -f $LegacyCreatorSid }
  $sddl = 'D:AI{0}(A;OICIIOID;GA;;;CO)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)(A;CIID;0x116;;;BU)' -f $legacy
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
  return @($raw.DiscretionaryAcl | ForEach-Object { Get-RawAclAceShape $_ } | Sort-Object)
}

function Get-CanonicalSharedDpeShapes([string]$LegacyCreatorSid = '') {
  $allow = [int][Security.AccessControl.AccessControlType]::Allow; $full = [Int64][Security.AccessControl.FileSystemRights]::FullControl
  $readExecute = [Int64]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
  $ciOi = [int]([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit)
  $noneI = [int][Security.AccessControl.InheritanceFlags]::None; $noneP = [int][Security.AccessControl.PropagationFlags]::None
  $shapes = @(
    (Get-AclRuleShape 'S-1-5-18' $full $allow $true $ciOi $noneP),
    (Get-AclRuleShape 'S-1-5-32-544' $full $allow $true $ciOi $noneP),
    (Get-AclRuleShape 'S-1-3-0' 268435456 $allow $true $ciOi ([int][Security.AccessControl.PropagationFlags]::InheritOnly)),
    (Get-AclRuleShape 'S-1-5-32-545' $readExecute $allow $true $ciOi $noneP),
    (Get-AclRuleShape 'S-1-5-32-545' ([Int64][Security.AccessControl.FileSystemRights]::Write) $allow $true ([int][Security.AccessControl.InheritanceFlags]::ContainerInherit) $noneP)
  )
  if (-not [string]::IsNullOrWhiteSpace($LegacyCreatorSid)) { $shapes += Get-AclRuleShape $LegacyCreatorSid $full $allow $true $noneI $noneP }
  return @($shapes | Sort-Object)
}

function Assert-CanonicalProgramDataCreatorOwner([string]$Path) {
  Assert-SafeExistingDirectory $Path
  $acl = Get-Acl -LiteralPath $Path
  $matches = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
    [string]$_.IdentityReference.Value -eq 'S-1-3-0' -and [Int64]$_.FileSystemRights -eq 268435456 -and
    $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    [int]$_.InheritanceFlags -eq [int]([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -and
    $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::InheritOnly
  })
  if ($matches.Count -ne 1) { throw "ProgramData lacks the exact canonical CREATOR OWNER inheritance template: $Path" }
}

function Get-SharedDpeAclState([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) { throw "Unsafe shared DPE ancestor: $Path" }
  $acl = Get-Acl -LiteralPath $Path
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  $control = $raw.ControlFlags
  return [pscustomobject]@{
    Item = $item; Acl = $acl; Owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    Shapes = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { Get-AclRuleShapeFromRule $_ } | Sort-Object)
    ExplicitCount = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])).Count
    Raw = $raw
    RawShapes = @($raw.DiscretionaryAcl | ForEach-Object { Get-RawAclAceShape $_ } | Sort-Object)
    DaclPresent = (($control -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0)
    DaclAutoInherited = (($control -band [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited) -ne 0)
  }
}

function Test-ExactAclShapes($Actual, $Expected) {
  return $Actual.Count -eq $Expected.Count -and @((Compare-Object $Expected $Actual -SyncWindow 0)).Count -eq 0
}

function Assert-FinalSharedDpe([string]$Path) {
  $state = Get-SharedDpeAclState $Path
  if ($state.Owner -notin @('S-1-5-18', 'S-1-5-32-544') -or $state.Acl.AreAccessRulesProtected -or -not $state.DaclPresent -or -not $state.DaclAutoInherited -or $state.ExplicitCount -ne 0 -or
      -not (Test-ExactAclShapes $state.Shapes @(Get-CanonicalSharedDpeShapes)) -or
      -not (Test-ExactAclShapes $state.RawShapes @(Get-CanonicalSharedDpeRawShapes))) { throw "Shared DPE is not canonical D:AI, inheritance-enabled, and trusted-owner safe: $Path" }
  return $state.Item.FullName
}

function Get-CanonicalSharedDpeDaclBytes($State, [string]$LegacyCreatorSid) {
  if (-not $State.DaclPresent -or -not $State.DaclAutoInherited -or $State.Acl.AreAccessRulesProtected -or
      -not (Test-ExactAclShapes $State.RawShapes @(Get-CanonicalSharedDpeRawShapes $LegacyCreatorSid))) { throw 'Cannot reconstruct a canonical shared DPE DACL from a non-exact legacy descriptor.' }
  $legacyDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new(('D:AI(A;ID;FA;;;{0})' -f $LegacyCreatorSid))
  $legacyShape = Get-RawAclAceShape $legacyDescriptor.DiscretionaryAcl[0]
  $replacement = [Security.AccessControl.RawAcl]::new($State.Raw.DiscretionaryAcl.Revision, $State.Raw.DiscretionaryAcl.Count - 1)
  $removed = 0
  foreach ($ace in $State.Raw.DiscretionaryAcl) {
    if ([string]::Equals((Get-RawAclAceShape $ace), $legacyShape, [StringComparison]::Ordinal)) { $removed++; continue }
    $aceBytes = New-Object byte[] $ace.BinaryLength; $ace.GetBinaryForm($aceBytes, 0)
    $replacement.InsertAce($replacement.Count, [Security.AccessControl.GenericAce]::CreateFromBinaryForm($aceBytes, 0))
  }
  $replacementShapes = @($replacement | ForEach-Object { Get-RawAclAceShape $_ } | Sort-Object)
  if ($removed -ne 1 -or -not (Test-ExactAclShapes $replacementShapes @(Get-CanonicalSharedDpeRawShapes))) { throw 'Canonical shared DPE DACL reconstruction did not remove exactly one legacy CREATOR OWNER materialization.' }
  $bytes = New-Object byte[] $replacement.BinaryLength; $replacement.GetBinaryForm($bytes, 0)
  return ,$bytes
}

function Set-SharedDpeOwnerAdministrators($Guard) {
  if ($null -eq $Guard -or -not $Guard.SecurityMutation) { throw 'Shared DPE owner migration requires the MAXIMUM_ALLOWED security guard.' }
  $sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $bytes = New-Object byte[] $sid.BinaryLength; $sid.GetBinaryForm($bytes, 0)
  $errorCode = [RevAgent.Prestage.DirectoryLockNative]::SetOwner($Guard.Handle, $bytes)
  if ($errorCode -ne 0) { throw [ComponentModel.Win32Exception]::new($errorCode, 'SetSecurityInfo owner migration failed for shared DPE.') }
}

function Refresh-SharedDpeInheritance($Guard, $State, [string]$LegacyCreatorSid) {
  if ($null -eq $Guard -or -not $Guard.SecurityMutation) { throw 'Shared DPE DACL migration requires the MAXIMUM_ALLOWED security guard.' }
  $daclBytes = Get-CanonicalSharedDpeDaclBytes $State $LegacyCreatorSid
  $errorCode = [RevAgent.Prestage.DirectoryLockNative]::SetDaclUnprotected($Guard.Handle, $daclBytes)
  if ($errorCode -ne 0) { throw [ComponentModel.Win32Exception]::new($errorCode, 'SetSecurityInfo DACL migration failed for shared DPE.') }
}

function Initialize-SafeSharedDpe([string]$Path, $ExistingGuard = $null) {
  Assert-CanonicalProgramDataCreatorOwner $ProgramDataRoot
  if ($null -ne $ExistingGuard) { Assert-DirectoryGuardPath $ExistingGuard $Path }
  $currentSid = [string]$currentIdentity.User.Value; $state = Get-SharedDpeAclState $Path
  if ($state.Owner -in @('S-1-5-18', 'S-1-5-32-544') -and -not $state.Acl.AreAccessRulesProtected -and $state.DaclPresent -and $state.DaclAutoInherited -and $state.ExplicitCount -eq 0 -and
      (Test-ExactAclShapes $state.Shapes @(Get-CanonicalSharedDpeShapes)) -and (Test-ExactAclShapes $state.RawShapes @(Get-CanonicalSharedDpeRawShapes))) {
    if ($null -ne $ExistingGuard) { Assert-DirectoryGuardPath $ExistingGuard $Path }
    return $state.Item.FullName
  }
  $initialOwnerAccepted = [string]::Equals($state.Owner, $currentSid, [StringComparison]::OrdinalIgnoreCase)
  $recoveryOwnerAccepted = [string]::Equals($state.Owner, 'S-1-5-32-544', [StringComparison]::OrdinalIgnoreCase)
  if ((-not $initialOwnerAccepted -and -not $recoveryOwnerAccepted) -or $state.Acl.AreAccessRulesProtected -or -not $state.DaclPresent -or -not $state.DaclAutoInherited -or $state.ExplicitCount -ne 0 -or
      -not (Test-ExactAclShapes $state.Shapes @(Get-CanonicalSharedDpeShapes $currentSid)) -or
      -not (Test-ExactAclShapes $state.RawShapes @(Get-CanonicalSharedDpeRawShapes $currentSid))) { throw "Legacy shared DPE does not match the exact current-caller CREATOR OWNER pattern: $Path owner=$($state.Owner) current=$currentSid" }

  $guard = $ExistingGuard; $ownsGuard = $false
  if ($null -eq $guard) { $guard = Open-DpeSecurityGuard $Path; $ownsGuard = $true }
  try {
    if (-not $guard.SecurityMutation) { throw 'Shared DPE migration was not given the MAXIMUM_ALLOWED security guard.' }
    Assert-DirectoryGuardPath $guard $Path
    $guarded = Get-SharedDpeAclState $Path
    if (($guarded.Owner -notin @($currentSid, 'S-1-5-32-544')) -or $guarded.Acl.AreAccessRulesProtected -or -not $guarded.DaclPresent -or -not $guarded.DaclAutoInherited -or $guarded.ExplicitCount -ne 0 -or
        -not (Test-ExactAclShapes $guarded.Shapes @(Get-CanonicalSharedDpeShapes $currentSid)) -or
        -not (Test-ExactAclShapes $guarded.RawShapes @(Get-CanonicalSharedDpeRawShapes $currentSid))) { throw "Guarded legacy shared DPE ACL changed before migration: $Path" }
    if ([string]::Equals($guarded.Owner, $currentSid, [StringComparison]::OrdinalIgnoreCase)) {
      Set-SharedDpeOwnerAdministrators $guard; Assert-DirectoryGuardPath $guard $Path
    }
    $afterOwner = Get-SharedDpeAclState $Path
    if (-not [string]::Equals($afterOwner.Owner, 'S-1-5-32-544', [StringComparison]::OrdinalIgnoreCase)) { throw "Legacy shared DPE owner migration failed: $Path" }
    if (-not $afterOwner.Acl.AreAccessRulesProtected -and $afterOwner.DaclPresent -and $afterOwner.DaclAutoInherited -and $afterOwner.ExplicitCount -eq 0 -and
        (Test-ExactAclShapes $afterOwner.Shapes @(Get-CanonicalSharedDpeShapes)) -and (Test-ExactAclShapes $afterOwner.RawShapes @(Get-CanonicalSharedDpeRawShapes))) { Assert-DirectoryGuardPath $guard $Path; return $afterOwner.Item.FullName }
    if ($afterOwner.Acl.AreAccessRulesProtected -or -not $afterOwner.DaclPresent -or -not $afterOwner.DaclAutoInherited -or $afterOwner.ExplicitCount -ne 0 -or
        -not (Test-ExactAclShapes $afterOwner.Shapes @(Get-CanonicalSharedDpeShapes $currentSid)) -or
        -not (Test-ExactAclShapes $afterOwner.RawShapes @(Get-CanonicalSharedDpeRawShapes $currentSid))) { throw "Legacy shared DPE partial migration state is not recoverable: $Path" }
    Refresh-SharedDpeInheritance $guard $afterOwner $currentSid; Assert-DirectoryGuardPath $guard $Path
    return Assert-FinalSharedDpe $Path
  } finally { if ($ownsGuard) { $guard.Handle.Dispose() } }
}

function New-InheritanceEnabledSharedDpe([string]$Parent) {
  Assert-CanonicalProgramDataCreatorOwner $Parent
  $ba = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  # Owner/group BA with no supplied DACL lets ProgramData inheritance construct
  # the DACL. This is not a NULL DACL: DiscretionaryAclPresent is deliberately
  # absent from the self-relative descriptor passed at CreateDirectoryW time.
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new([Security.AccessControl.ControlFlags]::SelfRelative, $ba, $ba, $null, $null)
  $descriptorBytes = New-Object byte[] $descriptor.BinaryLength; $descriptor.GetBinaryForm($descriptorBytes, 0)
  $path = Join-Path $Parent 'DPE'
  $createError = [RevAgent.Prestage.DirectoryLockNative]::CreateDirectoryWithSecurityDescriptor($path, $descriptorBytes)
  if ($createError -notin @(0, 183)) { throw [ComponentModel.Win32Exception]::new($createError, "CreateDirectoryW failed for shared DPE ancestor: $path") }
  $resolved = Initialize-SafeSharedDpe $path
  $guard = Open-DpeSecurityGuard $resolved
  try { Assert-DirectoryGuardPath $guard $resolved; return Assert-FinalSharedDpe $resolved }
  finally { $guard.Handle.Dispose() }
}

function Set-ProtectedProductRootAcl([string]$Path) {
  $guard = Open-DirectoryGuard $Path
  try {
    Assert-DirectoryGuardPath $guard $Path
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $currentAcl = Get-Acl -LiteralPath $Path
    $owner = [string]$currentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($trustedOwners -notcontains $owner) { throw "Refusing legacy product root with untrusted owner: $Path owner=$owner" }

    # This exact existing product root (or prestage child) may carry the
    # developer's legacy Modify/Delete ACE. The no-FILE_SHARE_DELETE handle
    # prevents rename/swap until the new DACL and identity are reverified.
    # Never apply this migration to the shared DPE ancestor.
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($entry in @(@('S-1-5-18', [Security.AccessControl.FileSystemRights]::FullControl), @('S-1-5-32-544', [Security.AccessControl.FileSystemRights]::FullControl), @('S-1-5-32-545', [Security.AccessControl.FileSystemRights]::ReadAndExecute))) {
      [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new([string]$entry[0]), [Security.AccessControl.FileSystemRights]$entry[1], ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    }
    if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item, $acl) } else { ([IO.DirectoryInfo]$item).SetAccessControl($acl) }

    Assert-DirectoryGuardPath $guard $Path
    $verified = Get-Acl -LiteralPath $Path
    if (-not $verified.AreAccessRulesProtected -or [string]$verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') { throw "Legacy product root ACL hardening failed: $Path" }
    $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $trustedOwners -notcontains [string]$rule.IdentityReference.Value -and (($rule.FileSystemRights -band $writeMask) -ne 0)) { throw "Legacy product root remains writable by an untrusted principal: $Path principal=$($rule.IdentityReference.Value)" }
    }
  } finally { $guard.Handle.Dispose() }
}

function New-ProtectedChild([string]$Parent, [string]$Name) {
  Assert-SafeExistingDirectory $Parent
  $path = Join-Path $Parent $Name
  if (Test-Path -LiteralPath $path) { Set-ProtectedProductRootAcl $path; return $path }
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach ($entry in @(@('S-1-5-18', [Security.AccessControl.FileSystemRights]::FullControl), @('S-1-5-32-544', [Security.AccessControl.FileSystemRights]::FullControl), @('S-1-5-32-545', [Security.AccessControl.FileSystemRights]::ReadAndExecute))) {
    [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new([string]$entry[0]), [Security.AccessControl.FileSystemRights]$entry[1], ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
  [void]([IO.DirectoryInfo]::new($Parent).CreateSubdirectory($Name, $acl))
  # Reattest through the same handle-bound hardening path so an exact-name
  # create race cannot turn an existing user-owned directory into a trust root.
  Set-ProtectedProductRootAcl $path
  return $path
}

function Read-VerifiedBytes([string]$Path, [string]$ExpectedHash, [int]$MaxBytes) {
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -lt 1 -or $stream.Length -gt $MaxBytes) { throw "Staging source size is outside policy: $Path" }
    $bytes = New-Object byte[] ([int]$stream.Length); $offset = 0
    while ($offset -lt $bytes.Length) { $offset += $stream.Read($bytes, $offset, $bytes.Length - $offset) }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '') } finally { $sha.Dispose() }
    if (-not [string]::Equals($actual, $ExpectedHash, [StringComparison]::OrdinalIgnoreCase)) { throw "Staging source hash mismatch: $Path" }
    return $bytes
  } finally { $stream.Dispose() }
}

$evidenceBytes = Read-VerifiedBytes $EvidenceSource $ExpectedEvidenceSha256 65536
$evidence = ([Text.UTF8Encoding]::new($false, $true)).GetString($evidenceBytes) | ConvertFrom-Json
if (-not [string]::Equals([string]$evidence.localBootstrapInstallerScript, $ExpectedInstallerSha256, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer hash does not match the independently verified evidence.' }
$installerBytes = Read-VerifiedBytes (Join-Path $SourceRoot 'installer\nas\install-revagent-local-bootstrap.ps1') $ExpectedInstallerSha256 1048576
$trustedKeysBytes = Read-VerifiedBytes $TrustedKeys ([string]$evidence.sources.trustedKeys) 65536
if ($AllowTestRoot -and $TestSkipAclHardening) {
  # This branch is deliberately unavailable in production. It exercises the
  # complete data flow below a disposable TEMP ProgramData fixture without
  # compiling native ACL helpers or changing any machine ACL.
  $prestage = Join-Path $ProgramDataRoot 'DPE\revAgent\prestage'
  [void][IO.Directory]::CreateDirectory($prestage)
  if (-not (Test-RevAgentSupervisedPathUnderRoot -Path $prestage -Root $ProgramDataRoot)) { throw 'Fixture prestage escaped TestProgramDataRoot.' }
  Assert-RevAgentSupervisedPathNoLinks -Path $prestage -StopRoot $ProgramDataRoot
  $stagedEvidence = Join-Path $prestage 'bootstrap-prestage-evidence.json'; $stagedInstaller = Join-Path $prestage 'install-revagent-local-bootstrap.ps1'; $stagedTrustedKeys = Join-Path $prestage 'release-trusted-keys.json'
  foreach ($path in @($stagedEvidence, $stagedInstaller, $stagedTrustedKeys)) {
    if (Test-Path -LiteralPath $path) {
      $item = Get-Item -LiteralPath $path -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing linked fixture prestage leaf: $path" }
      Remove-Item -LiteralPath $path -Force
    }
  }
  [IO.File]::WriteAllBytes($stagedEvidence, $evidenceBytes); [IO.File]::WriteAllBytes($stagedInstaller, $installerBytes); [IO.File]::WriteAllBytes($stagedTrustedKeys, $trustedKeysBytes)
}
else {
  $dpePath = Join-Path $ProgramDataRoot 'DPE'
  $dpeGuard = $null
  try {
    if (Test-Path -LiteralPath $dpePath) {
      $dpeGuard = Open-DpeSecurityGuard $dpePath
      $dpe = Initialize-SafeSharedDpe $dpePath $dpeGuard
    } else {
      $dpe = New-InheritanceEnabledSharedDpe $ProgramDataRoot
      $dpeGuard = Open-DpeSecurityGuard $dpe
      $dpe = Initialize-SafeSharedDpe $dpe $dpeGuard
    }
  } catch { if ($null -ne $dpeGuard) { $dpeGuard.Handle.Dispose() }; throw }
  try {
    Assert-DirectoryGuardPath $dpeGuard $dpe
    $productPath = Join-Path $dpe 'revAgent'
    if (Test-Path -LiteralPath $productPath) { Set-ProtectedProductRootAcl $productPath; $product = $productPath } else { $product = New-ProtectedChild $dpe 'revAgent' }
    Assert-DirectoryGuardPath $dpeGuard $dpe
  } finally { $dpeGuard.Handle.Dispose() }
  $prestage = New-ProtectedChild $product 'prestage'
  $stagedEvidence = Join-Path $prestage 'bootstrap-prestage-evidence.json'; $stagedInstaller = Join-Path $prestage 'install-revagent-local-bootstrap.ps1'; $stagedTrustedKeys = Join-Path $prestage 'release-trusted-keys.json'
  function Set-AdminOnlyAcl([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false); $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $inheritance = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }
    [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
  if ($item.PSIsContainer) { ([IO.DirectoryInfo]$item).SetAccessControl($acl) } else { ([IO.FileInfo]$item).SetAccessControl($acl) }
}
  Set-AdminOnlyAcl $prestage
  foreach ($path in @($stagedEvidence, $stagedInstaller, $stagedTrustedKeys)) {
    if (Test-Path -LiteralPath $path) { if (((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing linked prestage leaf: $path" }; Remove-Item -LiteralPath $path -Force }
  }
  [IO.File]::WriteAllBytes($stagedEvidence, $evidenceBytes); [IO.File]::WriteAllBytes($stagedInstaller, $installerBytes); [IO.File]::WriteAllBytes($stagedTrustedKeys, $trustedKeysBytes)
  foreach ($path in @($stagedEvidence, $stagedInstaller, $stagedTrustedKeys)) { Set-AdminOnlyAcl $path }
}

$installerOutput = @(& $stagedInstaller -RepoRoot $SourceRoot -ReleaseRoot $ReleaseRoot `
  -TrustedKeysPath $stagedTrustedKeys -ExpectedHashesPath $stagedEvidence `
  -ProgramDataRoot $ProgramDataRoot `
  -ConfirmIndependentlyAuthenticatedSource `
  -AllowTestRoot:$AllowTestRoot)
$installerResult = @($installerOutput | Where-Object { $null -ne $_ -and $_.PSObject.Properties['bootstrapTrustHealth'] } | Select-Object -Last 1)
if ($installerResult.Count -ne 1 -or -not [bool]$installerResult[0].bootstrapTrustHealth.success) {
  throw 'Local prestage installer did not return a healthy bootstrap trust-core attestation.'
}

$trustModuleBytes = Read-VerifiedBytes (Join-Path $SourceRoot 'installer\lib\RevAgent.BootstrapTrust.psm1') ([string]$evidence.sources.bootstrapTrust) 1048576
$trustModuleText = ([Text.UTF8Encoding]::new($false, $true)).GetString($trustModuleBytes)
if ($trustModuleText.Length -gt 0 -and $trustModuleText[0] -eq [char]0xFEFF) { $trustModuleText = $trustModuleText.Substring(1) }
$trustModule = New-Module -Name ('RevAgent.BootstrapTrust.Attest.' + [Guid]::NewGuid().ToString('N')) -ScriptBlock ([ScriptBlock]::Create($trustModuleText))
Microsoft.PowerShell.Core\Import-Module $trustModule -Force
try {
  $trustHealthCommand = Get-Command ("{0}\Test-RevAgentBootstrapTrustHealth" -f $trustModule.Name) -ErrorAction Stop
  if ($AllowTestRoot) {
    $installedTaskEvidence = $installerResult[0].bootstrapTrustInstall.task
    $taskProvider = { param($layout); $installedTaskEvidence }.GetNewClosure()
    $trustHealth = & $trustHealthCommand -ProgramDataRoot $ProgramDataRoot -AllowTestRoot -TaskProvider $taskProvider
  }
  else {
    $trustHealth = & $trustHealthCommand -ProgramDataRoot $ProgramDataRoot
  }
  if (-not $trustHealth.PSObject.Properties['success'] -or -not [bool]$trustHealth.success) {
    throw 'Supervised prestage driver could not attest the installed bootstrap trust core.'
  }
}
finally { Microsoft.PowerShell.Core\Remove-Module $trustModule -Force -ErrorAction SilentlyContinue }

[pscustomobject][ordered]@{
    success = $true
    action = 'supervised-bootstrap-prestage'
    channel = $Channel
    version = [string]$evidence.release.version
    producerMode = [string]$evidence.producerMode
    supervisedAdminPrestage = [bool]$evidence.supervisedAdminPrestage
    prestageRoot = $prestage
    bootstrapTrustHealthy = $true
}
} finally {
    if ([IO.Directory]::Exists($workRoot)) {
        [IO.Directory]::Delete($workRoot, $true)
    }
}
