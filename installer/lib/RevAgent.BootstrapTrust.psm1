Set-StrictMode -Version Latest

$script:RevAgentBootstrapTrustProductionReleaseRoot = '\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy'
$script:RevAgentBootstrapTrustProductionKeyId = 'revagent-prod-rsa-2026q3'
$script:RevAgentBootstrapTrustProductionKeyFingerprint = '32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33'
$script:RevAgentBootstrapTrustTaskName = 'revAgent Bootstrap Trust Broker'
$script:RevAgentBootstrapTrustTaskPath = '\DPE\revAgent\'
$script:RevAgentBootstrapTrustTaskSddl = 'O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;AU)'

function Get-RevAgentBootstrapTrustCanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $pathRoot = [IO.Path]::GetPathRoot($fullPath)
    if ([string]::Equals($fullPath, $pathRoot, [StringComparison]::OrdinalIgnoreCase)) { return $pathRoot }
    return $fullPath.TrimEnd('\', '/')
}

function Test-RevAgentBootstrapTrustPathUnderRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $fullPath = Get-RevAgentBootstrapTrustCanonicalPath -Path $Path
    $fullRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path $Root
    return [string]::Equals($fullPath, $fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-RevAgentBootstrapTrustTestRoot {
    param([Parameter(Mandatory = $true)][string]$ProgramDataRoot)

    $fullPath = Get-RevAgentBootstrapTrustCanonicalPath -Path $ProgramDataRoot
    $tempRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path ([IO.Path]::GetTempPath())
    if (-not (Test-RevAgentBootstrapTrustPathUnderRoot -Path $fullPath -Root $tempRoot) -or
        [string]::Equals($fullPath, $tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Bootstrap trust test roots must be disposable children below TEMP. root=$fullPath temp=$tempRoot"
    }
    return $fullPath
}

function ConvertTo-RevAgentBootstrapTrustQuotedArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.IndexOf([char]0) -ge 0 -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw 'Bootstrap trust task arguments cannot contain NUL or line breaks.'
    }
    return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Get-RevAgentBootstrapTrustLayout {
    [CmdletBinding()]
    param(
        [string]$ProgramDataRoot = '',
        [switch]$AllowTestRoot
    )

    $canonicalProgramData = Get-RevAgentBootstrapTrustCanonicalPath -Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData))
    if ([string]::IsNullOrWhiteSpace($ProgramDataRoot)) { $ProgramDataRoot = $canonicalProgramData }
    $ProgramDataRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path $ProgramDataRoot
    if ($AllowTestRoot) {
        $ProgramDataRoot = Assert-RevAgentBootstrapTrustTestRoot -ProgramDataRoot $ProgramDataRoot
    }
    elseif (-not [string]::Equals($ProgramDataRoot, $canonicalProgramData, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Production bootstrap trust uses only the canonical ProgramData root '$canonicalProgramData'."
    }

    $productRoot = Join-Path $ProgramDataRoot 'DPE\revAgent'
    $trustRoot = Join-Path $productRoot 'trust'
    $brokerDataRoot = Join-Path $productRoot 'bootstrap-broker'
    $brokerPath = Join-Path $trustRoot 'Invoke-RevAgent-BootstrapTrustBroker.ps1'
    $powershellPath = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $taskArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (ConvertTo-RevAgentBootstrapTrustQuotedArgument -Value $brokerPath)
    return [pscustomobject][ordered]@{
        programDataRoot = $ProgramDataRoot
        productRoot = $productRoot
        trustRoot = $trustRoot
        trustTransactionRoot = Join-Path $brokerDataRoot 'trust-transactions'
        trustStatePath = Join-Path $trustRoot 'trust-state.json'
        bootstrapTrustModulePath = Join-Path $trustRoot 'RevAgent.BootstrapTrust.psm1'
        brokerPath = $brokerPath
        distributionIntegrityModulePath = Join-Path $trustRoot 'RevAgent.DistributionIntegrity.psm1'
        releaseSnapshotModulePath = Join-Path $trustRoot 'RevAgent.ReleaseSnapshot.psm1'
        trustedKeysPath = Join-Path $trustRoot 'release-trusted-keys.json'
        brokerDataRoot = $brokerDataRoot
        resultsRoot = Join-Path $brokerDataRoot 'results'
        stateRoot = Join-Path $brokerDataRoot 'state'
        highWaterPath = Join-Path (Join-Path $brokerDataRoot 'state') 'release-high-water.json'
        brokerLockPath = Join-Path (Join-Path $brokerDataRoot 'state') 'broker.lock'
        snapshotRoot = Join-Path $brokerDataRoot 'snapshots'
        applyRoot = Join-Path $brokerDataRoot 'apply'
        prestageRoot = Join-Path $productRoot 'prestage'
        inboxRelativeRoot = 'AppData\Local\DPE\revAgent\release-inbox'
        requestQueueRelativeRoot = 'AppData\Local\DPE\revAgent\broker-requests'
        taskName = $script:RevAgentBootstrapTrustTaskName
        taskPath = $script:RevAgentBootstrapTrustTaskPath
        taskPowerShellPath = $powershellPath
        taskArguments = $taskArguments
        taskSddl = $script:RevAgentBootstrapTrustTaskSddl
    }
}

function Get-RevAgentBootstrapTrustBytesSha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '') }
    finally { $sha.Dispose() }
}

function Assert-RevAgentBootstrapTrustExactProperties {
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory = $true)][string[]]$Names,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($null -eq $Object) { throw "$Label is missing." }
    $actual = @($Object.PSObject.Properties | ForEach-Object { [string]$_.Name } | Sort-Object)
    $expected = @($Names | Sort-Object)
    if ($actual.Count -ne $expected.Count -or [string]::Join('|', $actual) -cne [string]::Join('|', $expected)) {
        throw "$Label must contain only the exact properties: $([string]::Join(', ', $Names)). actual=$([string]::Join(', ', $actual))"
    }
}

function Assert-RevAgentBootstrapTrustPathNoLinks {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$StopRoot = '',
        [switch]$RequireLeaf
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    $stop = if ([string]::IsNullOrWhiteSpace($StopRoot)) { [IO.Path]::GetPathRoot($fullPath) } else { [IO.Path]::GetFullPath($StopRoot) }
    if ($RequireLeaf -and -not [IO.File]::Exists($fullPath)) { throw "Bootstrap trust file was not found: $fullPath" }
    $cursor = if ([IO.File]::Exists($fullPath) -or [IO.Directory]::Exists($fullPath)) { $fullPath } else { Split-Path -Parent $fullPath }
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
            $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            $linkTypeProperty = $item.PSObject.Properties['LinkType']
            $linkType = if ($null -eq $linkTypeProperty) { '' } else { [string]$linkTypeProperty.Value }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) {
                throw "Bootstrap trust path contains a filesystem link/reparse component: $cursor"
            }
        }
        if ([string]::Equals([IO.Path]::GetFullPath($cursor).TrimEnd('\'), [IO.Path]::GetFullPath($stop).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or [string]::Equals($parent, $cursor, [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = $parent
    }
    return $fullPath
}

function Initialize-RevAgentBootstrapTrustNativeFileInformation {
    if (-not ('RevAgentBootstrapTrust.NativeFileInformation' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgentBootstrapTrust {
    public static class NativeFileInformation {
        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);

        public static uint GetLinkCount(SafeFileHandle handle) {
            BY_HANDLE_FILE_INFORMATION information;
            if (handle == null || handle.IsInvalid || !GetFileInformationByHandle(handle, out information)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return information.NumberOfLinks;
        }
    }
}
'@ -Language CSharp -ErrorAction Stop
    }
}

function Get-RevAgentBootstrapTrustHardlinkCount {
    param([Parameter(Mandatory = $true)][string]$Path)

    Initialize-RevAgentBootstrapTrustNativeFileInformation
    $stream = $null
    try {
        $stream = [IO.File]::Open([IO.Path]::GetFullPath($Path), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        return [int][RevAgentBootstrapTrust.NativeFileInformation]::GetLinkCount($stream.SafeFileHandle)
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Read-RevAgentBootstrapTrustBoundedBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateRange(1, 33554432)][int]$MaxBytes = 4194304,
        [string]$ExpectedSha256 = '',
        [switch]$RequireSingleLink
    )

    $fullPath = Assert-RevAgentBootstrapTrustPathNoLinks -Path $Path -RequireLeaf
    $stream = $null
    try {
        $stream = [IO.File]::Open($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($stream.Length -lt 1 -or $stream.Length -gt $MaxBytes) { throw "Bootstrap trust file size is outside policy. path=$fullPath length=$($stream.Length) max=$MaxBytes" }
        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw "Bootstrap trust file ended before its declared length: $fullPath" }
            $offset += $read
        }
        if ($stream.ReadByte() -ne -1) { throw "Bootstrap trust file grew while being read: $fullPath" }
        if ($RequireSingleLink -and (Get-RevAgentBootstrapTrustHardlinkCount -Path $fullPath) -ne 1) {
            throw "Bootstrap trust file must have exactly one hardlink reference: $fullPath"
        }
        $sha256 = Get-RevAgentBootstrapTrustBytesSha256 -Bytes $bytes
        if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256) -and
            -not [string]::Equals($sha256, $ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Bootstrap trust file SHA-256 mismatch. path=$fullPath expected=$ExpectedSha256 actual=$sha256"
        }
        return [pscustomobject][ordered]@{ path = $fullPath; bytes = $bytes; length = $bytes.Length; sha256 = $sha256 }
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function ConvertFrom-RevAgentBootstrapTrustJsonBytes {
    param(
        [Parameter(Mandatory = $true)][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][string]$Label
    )

    try {
        $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
        $text = $strictUtf8.GetString($Bytes)
        if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
        Assert-RevAgentBootstrapTrustJsonHasUniqueProperties -Json $text -Label $Label
        return $text | Microsoft.PowerShell.Utility\ConvertFrom-Json -ErrorAction Stop
    }
    catch { throw "$Label is not strict UTF-8 JSON: $($_.Exception.Message)" }
}

function Assert-RevAgentBootstrapTrustJsonHasUniqueProperties {
    param(
        [Parameter(Mandatory = $true)][string]$Json,
        [Parameter(Mandatory = $true)][string]$Label
    )

    function Skip-JsonWhiteSpace {
        param([Parameter(Mandatory = $true)][ref]$Position)
        while ($Position.Value -lt $Json.Length -and [char]::IsWhiteSpace($Json[$Position.Value])) { $Position.Value++ }
    }

    function Read-JsonStringToken {
        param([Parameter(Mandatory = $true)][ref]$Position)
        if ($Position.Value -ge $Json.Length -or $Json[$Position.Value] -ne '"') { throw "$Label contains an invalid JSON property/string token." }
        $start = $Position.Value
        $Position.Value++
        $escaped = $false
        while ($Position.Value -lt $Json.Length) {
            $character = $Json[$Position.Value]
            $Position.Value++
            if ($escaped) { $escaped = $false; continue }
            if ($character -eq '\') { $escaped = $true; continue }
            if ($character -eq '"') {
                $raw = $Json.Substring($start, $Position.Value - $start)
                try { return [string]($raw | Microsoft.PowerShell.Utility\ConvertFrom-Json -ErrorAction Stop) }
                catch { throw "$Label contains an invalid JSON string escape." }
            }
            if ([int][char]$character -lt 0x20) { throw "$Label contains an unescaped control character in a JSON string." }
        }
        throw "$Label contains an unterminated JSON string."
    }

    function Read-JsonValue {
        param([Parameter(Mandatory = $true)][ref]$Position)
        Skip-JsonWhiteSpace -Position $Position
        if ($Position.Value -ge $Json.Length) { throw "$Label ended before a JSON value was complete." }
        $character = $Json[$Position.Value]
        if ($character -eq '{') {
            $Position.Value++
            $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            Skip-JsonWhiteSpace -Position $Position
            if ($Position.Value -lt $Json.Length -and $Json[$Position.Value] -eq '}') { $Position.Value++; return }
            while ($true) {
                Skip-JsonWhiteSpace -Position $Position
                $name = Read-JsonStringToken -Position $Position
                if (-not $names.Add($name)) { throw "$Label contains a duplicate decoded JSON property '$name'." }
                Skip-JsonWhiteSpace -Position $Position
                if ($Position.Value -ge $Json.Length -or $Json[$Position.Value] -ne ':') { throw "$Label contains a JSON property without a colon." }
                $Position.Value++
                Read-JsonValue -Position $Position
                Skip-JsonWhiteSpace -Position $Position
                if ($Position.Value -ge $Json.Length) { throw "$Label contains an unterminated JSON object." }
                if ($Json[$Position.Value] -eq '}') { $Position.Value++; return }
                if ($Json[$Position.Value] -ne ',') { throw "$Label contains an invalid JSON object delimiter." }
                $Position.Value++
            }
        }
        if ($character -eq '[') {
            $Position.Value++
            Skip-JsonWhiteSpace -Position $Position
            if ($Position.Value -lt $Json.Length -and $Json[$Position.Value] -eq ']') { $Position.Value++; return }
            while ($true) {
                Read-JsonValue -Position $Position
                Skip-JsonWhiteSpace -Position $Position
                if ($Position.Value -ge $Json.Length) { throw "$Label contains an unterminated JSON array." }
                if ($Json[$Position.Value] -eq ']') { $Position.Value++; return }
                if ($Json[$Position.Value] -ne ',') { throw "$Label contains an invalid JSON array delimiter." }
                $Position.Value++
            }
        }
        if ($character -eq '"') { [void](Read-JsonStringToken -Position $Position); return }
        $primitiveStart = $Position.Value
        while ($Position.Value -lt $Json.Length -and $Json[$Position.Value] -notin @(',', '}', ']') -and -not [char]::IsWhiteSpace($Json[$Position.Value])) { $Position.Value++ }
        if ($Position.Value -eq $primitiveStart) { throw "$Label contains an invalid JSON primitive." }
    }

    $position = 0
    $positionReference = [ref]$position
    Skip-JsonWhiteSpace -Position $positionReference
    Read-JsonValue -Position $positionReference
    Skip-JsonWhiteSpace -Position $positionReference
    if ($position -ne $Json.Length) { throw "$Label contains trailing content after the JSON value." }
}

function Get-RevAgentBootstrapTrustCurrentSid {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { return [string]$identity.User.Value }
    finally { $identity.Dispose() }
}

function Get-RevAgentBootstrapTrustNormalizedSid {
    param([Parameter(Mandatory = $true)][string]$Sid)

    try { return [string][Security.Principal.SecurityIdentifier]::new($Sid).Value }
    catch { throw "Bootstrap trust SID is invalid: $Sid" }
}

function Get-RevAgentBootstrapTrustResultBucketPath {
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][string]$RequesterSid
    )

    $sid = Get-RevAgentBootstrapTrustNormalizedSid -Sid $RequesterSid
    return Join-Path ([string]$Layout.resultsRoot) ("principal-$sid")
}

function Get-RevAgentBootstrapTrustResultPath {
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][string]$RequesterSid,
        [Parameter(Mandatory = $true)][string]$Nonce
    )

    if ($Nonce -cnotmatch '^[a-f0-9]{32}$') { throw 'Bootstrap trust result nonce is invalid.' }
    return Join-Path (Get-RevAgentBootstrapTrustResultBucketPath -Layout $Layout -RequesterSid $RequesterSid) ("bootstrap-result-$Nonce.json")
}

function Get-RevAgentBootstrapTrustProfileRoot {
    param(
        [string]$ProfileRoot = '',
        [switch]$AllowTestRoot
    )

    if ([string]::IsNullOrWhiteSpace($ProfileRoot)) {
        $ProfileRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    }
    if ([string]::IsNullOrWhiteSpace($ProfileRoot) -or $ProfileRoot.Contains('%') -or
        -not [IO.Path]::IsPathRooted($ProfileRoot) -or $ProfileRoot.StartsWith('\\')) {
        throw 'Bootstrap trust profile root must be an absolute local path.'
    }
    $fullPath = Get-RevAgentBootstrapTrustCanonicalPath -Path $ProfileRoot
    if ($AllowTestRoot) { [void](Assert-RevAgentBootstrapTrustTestRoot -ProgramDataRoot $fullPath) }
    elseif ([IO.Path]::GetPathRoot($fullPath) -notmatch '^[A-Za-z]:\\$') { throw 'Bootstrap trust profile root must be on a local drive.' }
    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $fullPath)
    return $fullPath
}

function Get-RevAgentBootstrapTrustRequestQueueRoot {
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [string]$ProfileRoot = '',
        [switch]$AllowTestRoot
    )

    $profile = Get-RevAgentBootstrapTrustProfileRoot -ProfileRoot $ProfileRoot -AllowTestRoot:$AllowTestRoot
    return Get-RevAgentBootstrapTrustCanonicalPath -Path (Join-Path $profile ([string]$Layout.requestQueueRelativeRoot))
}

function New-RevAgentBootstrapTrustDirectorySecurity {
    param(
        [ValidateSet('protected-read', 'results', 'system-only', 'principal-results')][string]$Kind,
        [string]$ReaderSid = '',
        [switch]$AllowTestRoot
    )

    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $directoryOwnerSid = if ($AllowTestRoot) { Get-RevAgentBootstrapTrustCurrentSid } else { 'S-1-5-32-544' }
    $security.SetOwner([Security.Principal.SecurityIdentifier]::new($directoryOwnerSid))
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new($sid),
                [Security.AccessControl.FileSystemRights]::FullControl,
                $inherit,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    if ($AllowTestRoot) {
        $currentSid = Get-RevAgentBootstrapTrustCurrentSid
        if ($currentSid -notin @('S-1-5-18', 'S-1-5-32-544')) {
            [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                    [Security.Principal.SecurityIdentifier]::new($currentSid),
                    [Security.AccessControl.FileSystemRights]::FullControl,
                    $inherit,
                    [Security.AccessControl.PropagationFlags]::None,
                    [Security.AccessControl.AccessControlType]::Allow))
        }
    }
    if ($Kind -eq 'protected-read') {
        [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),
                [Security.AccessControl.FileSystemRights]::ReadAndExecute,
                $inherit,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    elseif ($Kind -eq 'results') {
        [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new('S-1-5-11'),
                [Security.AccessControl.FileSystemRights]::ReadAndExecute,
                [Security.AccessControl.InheritanceFlags]::None,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    elseif ($Kind -eq 'principal-results') {
        if ([string]::IsNullOrWhiteSpace($ReaderSid)) { throw 'Bootstrap trust principal result directories require an explicit reader SID.' }
        $normalizedReader = Get-RevAgentBootstrapTrustNormalizedSid -Sid $ReaderSid
        if ($normalizedReader -notin @('S-1-5-18', 'S-1-5-32-544')) {
            [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                    [Security.Principal.SecurityIdentifier]::new($normalizedReader),
                    [Security.AccessControl.FileSystemRights]::ReadAndExecute,
                    $inherit,
                    [Security.AccessControl.PropagationFlags]::None,
                    [Security.AccessControl.AccessControlType]::Allow))
        }
    }
    return $security
}

function New-RevAgentBootstrapTrustFileSecurity {
    param(
        [string]$ReaderSid = '',
        [switch]$WriterIsRequester,
        [switch]$AllowBuiltinUsersRead,
        [switch]$AllowTestRoot
    )

    $security = [Security.AccessControl.FileSecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    # A standard-user request creator owns its newly created file and may
    # protect its DACL, but it does not have WRITE_OWNER merely to restate that
    # same owner. Preserve the OS-assigned owner on that one path and attest it
    # when the SYSTEM broker consumes the request.
    if (-not $WriterIsRequester) {
        $fileOwnerSid = if ($AllowTestRoot) { Get-RevAgentBootstrapTrustCurrentSid } else { 'S-1-5-32-544' }
        $security.SetOwner([Security.Principal.SecurityIdentifier]::new($fileOwnerSid))
    }
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new($sid),
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    if ($AllowBuiltinUsersRead) {
        [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),
                [Security.AccessControl.FileSystemRights]::ReadAndExecute,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    if (-not [string]::IsNullOrWhiteSpace($ReaderSid) -and $ReaderSid -notin @('S-1-5-18', 'S-1-5-32-544')) {
        $rights = if ($WriterIsRequester) { [Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write } else { [Security.AccessControl.FileSystemRights]::Read }
        [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new($ReaderSid),
                $rights,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    if ($AllowTestRoot) {
        $currentSid = Get-RevAgentBootstrapTrustCurrentSid
        if ($currentSid -notin @('S-1-5-18', 'S-1-5-32-544') -and -not [string]::Equals($currentSid, $ReaderSid, [StringComparison]::OrdinalIgnoreCase)) {
            [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                    [Security.Principal.SecurityIdentifier]::new($currentSid),
                    [Security.AccessControl.FileSystemRights]::FullControl,
                    [Security.AccessControl.AccessControlType]::Allow))
        }
    }
    return $security
}

function Set-RevAgentBootstrapTrustDirectoryAcl {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Kind, [string]$ReaderSid = '', [switch]$AllowTestRoot)
    $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $security = New-RevAgentBootstrapTrustDirectorySecurity -Kind $Kind -ReaderSid $ReaderSid -AllowTestRoot:$AllowTestRoot
    if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item, $security) }
    else { ([IO.DirectoryInfo]$item).SetAccessControl($security) }
}

function Set-RevAgentBootstrapTrustFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$ReaderSid = '', [switch]$WriterIsRequester, [switch]$AllowBuiltinUsersRead, [switch]$AllowTestRoot)
    $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $security = New-RevAgentBootstrapTrustFileSecurity -ReaderSid $ReaderSid -WriterIsRequester:$WriterIsRequester -AllowBuiltinUsersRead:$AllowBuiltinUsersRead -AllowTestRoot:$AllowTestRoot
    if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]$item, $security) }
    else { ([IO.FileInfo]$item).SetAccessControl($security) }
}

function New-RevAgentBootstrapTrustProtectedDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet('protected-read', 'results', 'system-only', 'principal-results')][string]$Kind = 'protected-read',
        [string]$ReaderSid = '',
        [switch]$AllowTestRoot
    )

    if ([IO.Directory]::Exists($Path)) {
        [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $Path)
        Set-RevAgentBootstrapTrustDirectoryAcl -Path $Path -Kind $Kind -ReaderSid $ReaderSid -AllowTestRoot:$AllowTestRoot
        return [IO.Path]::GetFullPath($Path)
    }
    $parent = Split-Path -Parent $Path
    if (-not [IO.Directory]::Exists($parent)) { throw "Bootstrap trust protected directory parent is missing: $parent" }
    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $parent)
    $security = New-RevAgentBootstrapTrustDirectorySecurity -Kind $Kind -ReaderSid $ReaderSid -AllowTestRoot:$AllowTestRoot
    [void]([IO.DirectoryInfo]::new($parent).CreateSubdirectory((Split-Path -Leaf $Path), $security))
    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $Path)
    return [IO.Path]::GetFullPath($Path)
}

function Write-RevAgentBootstrapTrustFileCreateNew {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes,
        [string]$ReaderSid = '',
        [switch]$WriterIsRequester,
        [switch]$AllowBuiltinUsersRead,
        [switch]$AllowTestRoot
    )

    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    Set-RevAgentBootstrapTrustFileAcl -Path $Path -ReaderSid $ReaderSid -WriterIsRequester:$WriterIsRequester -AllowBuiltinUsersRead:$AllowBuiltinUsersRead -AllowTestRoot:$AllowTestRoot
}

function Assert-RevAgentBootstrapTrustedKeySet {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][byte[]]$Bytes,
        [switch]$AllowTestRoot
    )

    if ($Bytes.Length -lt 2 -or $Bytes.Length -gt 1048576) { throw 'Bootstrap trusted-key document size is outside the bounded policy.' }
    $document = ConvertFrom-RevAgentBootstrapTrustJsonBytes -Bytes $Bytes -Label 'Bootstrap trusted-key document'
    $topLevelNames = @($document.PSObject.Properties | ForEach-Object { [string]$_.Name } | Sort-Object)
    $topLevelShape = $topLevelNames -join '|'
    if ($topLevelShape -ceq 'trustedKeys') { }
    elseif ($topLevelShape -ceq 'app|generatedAtUtc|schemaVersion|trustedKeys') {
        if ([int]$document.schemaVersion -ne 1 -or [string]$document.app -notin @('revAgent', 'revit-mcp-skill')) { throw 'Bootstrap trusted-key document identity/version contract is invalid.' }
        $generatedAt = [DateTime]::MinValue
        if ([string]$document.generatedAtUtc -cnotmatch 'Z$' -or
            -not [DateTime]::TryParse([string]$document.generatedAtUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$generatedAt) -or
            $generatedAt.Kind -ne [DateTimeKind]::Utc -or $generatedAt -gt [DateTime]::UtcNow.AddMinutes(5)) {
            throw 'Bootstrap trusted-key document generatedAtUtc must be a valid UTC timestamp.'
        }
    }
    else {
        throw 'Bootstrap trusted-key document must contain either trustedKeys only or the exact schemaVersion/app/generatedAtUtc/trustedKeys metadata shape.'
    }
    $properties = @($document.trustedKeys.PSObject.Properties)
    if ($properties.Count -lt 1 -or $properties.Count -gt 2) { throw 'Bootstrap trusted-key document must contain one or two public keys.' }
    $fingerprints = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $records = [Collections.Generic.List[object]]::new()
    foreach ($property in $properties) {
        $keyId = [string]$property.Name
        if (-not $AllowTestRoot) {
            if ($keyId -cnotmatch '^revagent-prod-rsa-([0-9]{4})q([1-4])$') { throw "Bootstrap production trusted-key id is outside the rotation policy: $keyId" }
            if (-not [string]::Equals($keyId, $script:RevAgentBootstrapTrustProductionKeyId, [StringComparison]::Ordinal)) {
                $keyOrdinal = ([int]$Matches[1] * 4) + [int]$Matches[2]
                $q3Ordinal = (2026 * 4) + 3
                if ($keyOrdinal -le $q3Ordinal) { throw "Bootstrap transition key must be strictly later than 2026q3: $keyId" }
            }
        }
        $record = $property.Value
        $recordNames = @($record.PSObject.Properties | ForEach-Object { [string]$_.Name } | Sort-Object) -join '|'
        if ($recordNames -ceq 'algorithm|publicKeyFingerprint|publicKeyXml') { }
        elseif ($recordNames -ceq 'algorithm|publicKeyFingerprint|publicKeyXml|purpose') {
            if ([string]$record.purpose -cne 'release-signing') { throw "Bootstrap trusted-key '$keyId' purpose must be release-signing." }
        }
        else { throw "Bootstrap trusted-key '$keyId' contains a non-public or unknown property." }
        if (-not [string]::Equals([string]$record.algorithm, 'RS256', [StringComparison]::Ordinal)) { throw "Bootstrap trusted-key '$keyId' is not RS256." }
        $publicKeyXml = [string]$record.publicKeyXml
        if ([string]::IsNullOrWhiteSpace($publicKeyXml) -or $publicKeyXml -match '(?i)BEGIN\s+(?:RSA\s+)?PRIVATE|"(?:d|p|q|dp|dq|qi)"\s*:') {
            throw "Bootstrap trusted-key '$keyId' contains private or non-XML key material."
        }
        try {
            $settings = [Xml.XmlReaderSettings]::new()
            $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
            $settings.XmlResolver = $null
            $reader = [Xml.XmlReader]::Create([IO.StringReader]::new($publicKeyXml), $settings)
            try {
                $xml = [Xml.XmlDocument]::new()
                $xml.XmlResolver = $null
                $xml.Load($reader)
            }
            finally { $reader.Dispose() }
        }
        catch { throw "Bootstrap trusted-key '$keyId' publicKeyXml is invalid: $($_.Exception.Message)" }
        if ($null -eq $xml.DocumentElement -or $xml.DocumentElement.Name -cne 'RSAKeyValue') { throw "Bootstrap trusted-key '$keyId' is not an RSAKeyValue document." }
        $children = @($xml.DocumentElement.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element })
        $childNames = @($children | ForEach-Object { [string]$_.Name } | Sort-Object) -join '|'
        if ($children.Count -ne 2 -or $childNames -cne 'Exponent|Modulus') {
            throw "Bootstrap trusted-key '$keyId' must contain only Modulus and Exponent public RSA elements."
        }
        foreach ($elementName in @('Modulus', 'Exponent')) {
            $node = $xml.DocumentElement.SelectSingleNode($elementName)
            if ($null -eq $node -or [string]::IsNullOrWhiteSpace([string]$node.InnerText)) { throw "Bootstrap trusted-key '$keyId' is missing $elementName." }
            try { [void][Convert]::FromBase64String(([string]$node.InnerText -replace '\s+', '')) }
            catch { throw "Bootstrap trusted-key '$keyId' has invalid $elementName base64." }
        }
        $normalizedXml = $publicKeyXml.Trim() -replace '\s+', ''
        $computed = Get-RevAgentBootstrapTrustBytesSha256 -Bytes ([Text.Encoding]::UTF8.GetBytes($normalizedXml))
        $declared = ([string]$record.publicKeyFingerprint).Trim().ToUpperInvariant()
        if ($declared -notmatch '^[A-F0-9]{64}$' -or -not [string]::Equals($declared, $computed, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Bootstrap trusted-key '$keyId' fingerprint does not match publicKeyXml."
        }
        if (-not $fingerprints.Add($computed)) { throw "Bootstrap trusted-key document contains duplicate public-key fingerprints: $computed" }
        $records.Add([pscustomobject][ordered]@{ keyId = $keyId; algorithm = 'RS256'; fingerprint = $computed; publicKeyXml = $publicKeyXml })
    }
    if (-not $AllowTestRoot) {
        $productionProperty = $document.trustedKeys.PSObject.Properties[$script:RevAgentBootstrapTrustProductionKeyId]
        if ($null -eq $productionProperty) { throw "Bootstrap production trusted-key document is missing '$($script:RevAgentBootstrapTrustProductionKeyId)'." }
        $production = @($records.ToArray() | Where-Object { [string]::Equals([string]$_.keyId, $script:RevAgentBootstrapTrustProductionKeyId, [StringComparison]::Ordinal) })
        if ($production.Count -ne 1 -or -not [string]::Equals([string]$production[0].fingerprint, $script:RevAgentBootstrapTrustProductionKeyFingerprint, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Bootstrap production q3 trusted-key fingerprint does not match the pinned identity.'
        }
    }
    return [pscustomobject][ordered]@{
        success = $true
        action = 'bootstrap-trusted-key-validation'
        sha256 = Get-RevAgentBootstrapTrustBytesSha256 -Bytes $Bytes
        keyCount = $records.Count
        keys = @($records.ToArray())
        document = $document
    }
}

function ConvertTo-RevAgentBootstrapTrustCanonicalSddl {
    param([Parameter(Mandatory = $true)][string]$Sddl)
    try {
        $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
        return $descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::All)
    }
    catch { throw "Bootstrap trust task SDDL is invalid: $($_.Exception.Message)" }
}

function Test-RevAgentBootstrapTrustAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$Directory,
        [switch]$AllowTestRoot,
        [switch]$SkipHardlinkCheck,
        [string]$RequiredReaderSid = ''
    )

    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $Path -RequireLeaf:(-not $Directory))
    $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected) { throw "Bootstrap trust DACL must be inheritance-protected: $Path" }
    $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $trustedOwners = @('S-1-5-18', 'S-1-5-32-544')
    if ($AllowTestRoot) { $trustedOwners += Get-RevAgentBootstrapTrustCurrentSid }
    if ($trustedOwners -notcontains $owner) { throw "Bootstrap trust owner is not trusted. path=$Path owner=$owner" }
    $trustedWriters = @('S-1-5-18', 'S-1-5-32-544')
    if ($AllowTestRoot) { $trustedWriters += Get-RevAgentBootstrapTrustCurrentSid }
    $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    $readerFound = [string]::IsNullOrWhiteSpace($RequiredReaderSid)
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw "Bootstrap trust DACL contains a non-allow ACE: $Path" }
        $sid = [string]$rule.IdentityReference.Value
        if ([string]::Equals($sid, $RequiredReaderSid, [StringComparison]::OrdinalIgnoreCase) -and
            (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -ne 0)) { $readerFound = $true }
        if ($trustedWriters -notcontains $sid -and (($rule.FileSystemRights -band $writeMask) -ne 0)) {
            throw "Bootstrap trust path grants write/delete/ACL capability to an untrusted principal. path=$Path principal=$sid rights=$($rule.FileSystemRights)"
        }
    }
    if (-not $readerFound) { throw "Bootstrap trust path does not grant the required requester read access. path=$Path sid=$RequiredReaderSid" }
    if (-not $Directory -and -not $SkipHardlinkCheck -and (Get-RevAgentBootstrapTrustHardlinkCount -Path $Path) -ne 1) { throw "Bootstrap trust protected file must have exactly one hardlink: $Path" }
    return $true
}

function Test-RevAgentBootstrapTrustSystemOnlyAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$Directory,
        [switch]$SkipHardlinkCheck,
        [switch]$AllowTestRoot
    )

    [void](Test-RevAgentBootstrapTrustAcl -Path $Path -Directory:$Directory -SkipHardlinkCheck:$SkipHardlinkCheck -AllowTestRoot:$AllowTestRoot)
    $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path -ErrorAction Stop
    $allowed = @('S-1-5-18', 'S-1-5-32-544')
    if ($AllowTestRoot) { $allowed += Get-RevAgentBootstrapTrustCurrentSid }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $allowed -notcontains [string]$rule.IdentityReference.Value) {
            throw "Bootstrap trust system-only path grants access to an unexpected principal. path=$Path principal=$($rule.IdentityReference.Value)"
        }
    }
    return $true
}

function Get-RevAgentBootstrapTrustTaskEvidence {
    param([Parameter(Mandatory = $true)][object]$Layout)

    $scheduledTasksManifest = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1'
    if (-not [IO.File]::Exists($scheduledTasksManifest)) { throw "Canonical ScheduledTasks module was not found: $scheduledTasksManifest" }
    Microsoft.PowerShell.Core\Import-Module -Name $scheduledTasksManifest -Force -ErrorAction Stop
    $task = ScheduledTasks\Get-ScheduledTask -TaskName ([string]$Layout.taskName) -TaskPath ([string]$Layout.taskPath) -ErrorAction Stop
    $actions = @($task.Actions)
    $sddl = ''
    $service = $null
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $folder = $service.GetFolder(([string]$Layout.taskPath).TrimEnd('\'))
        $registered = $folder.GetTask([string]$Layout.taskName)
        # OWNER_SECURITY_INFORMATION (1) + GROUP (2) + DACL (4). Do not ask a
        # standard-user health probe for SACL (8), which requires
        # ACCESS_SYSTEM_SECURITY/SeSecurityPrivilege and would falsely force
        # every healthy machine back to exit 84.
        $sddl = [string]$registered.GetSecurityDescriptor(0x7)
    }
    finally {
        if ($null -ne $service) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($service) }
    }
    return [pscustomobject][ordered]@{
        exists = $true
        taskName = [string]$task.TaskName
        taskPath = [string]$task.TaskPath
        execute = if ($actions.Count -eq 1) { [string]$actions[0].Execute } else { '' }
        arguments = if ($actions.Count -eq 1) { [string]$actions[0].Arguments } else { '' }
        actionCount = $actions.Count
        userId = [string]$task.Principal.UserId
        logonType = [string]$task.Principal.LogonType
        runLevel = [string]$task.Principal.RunLevel
        sddl = $sddl
        state = [string]$task.State
        enabled = [bool]$task.Settings.Enabled
        allowDemandStart = [bool]$task.Settings.AllowDemandStart
        multipleInstances = [string]$task.Settings.MultipleInstances
        executionTimeLimit = [string]$task.Settings.ExecutionTimeLimit
    }
}

function Assert-RevAgentBootstrapTrustTaskEvidence {
    param(
        [Parameter(Mandatory = $true)][object]$Evidence,
        [Parameter(Mandatory = $true)][object]$Layout
    )

    if ($null -eq $Evidence -or -not [bool]$Evidence.exists -or [int]$Evidence.actionCount -ne 1) { throw 'Bootstrap trust broker task is missing or does not contain exactly one action.' }
    if (-not [string]::Equals([string]$Evidence.taskName, [string]$Layout.taskName, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$Evidence.taskPath, [string]$Layout.taskPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap trust broker task identity/path is not canonical.' }
    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$Evidence.execute), [IO.Path]::GetFullPath([string]$Layout.taskPowerShellPath), [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$Evidence.arguments, [string]$Layout.taskArguments, [StringComparison]::Ordinal)) { throw 'Bootstrap trust broker task action is not the fixed canonical PS5 broker command.' }
    if ([string]$Evidence.arguments -match '(?i)-(?:Expected|Trusted|ReleaseRoot|Inbox|Request|Result|Hash|Argument)' -or
        [string]$Evidence.arguments -match '(?i)-EncodedCommand') { throw 'Bootstrap trust broker task action contains caller-controlled or encoded security arguments.' }
    if ([string]$Evidence.userId -notin @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18') -or
        -not [string]::Equals([string]$Evidence.logonType, 'ServiceAccount', [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$Evidence.runLevel, 'Highest', [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap trust broker task must run as SYSTEM with service-account logon at highest privilege.' }
    if (-not [bool]$Evidence.enabled -or -not [bool]$Evidence.allowDemandStart -or
        [string]$Evidence.state -notin @('Ready', 'Running') -or
        -not [string]::Equals([string]$Evidence.multipleInstances, 'IgnoreNew', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Bootstrap trust broker task must be enabled, demand-startable, Ready/Running, and IgnoreNew.'
    }
    $executionLimit = [TimeSpan]::Zero
    try {
        $executionLimit = if ($Evidence.executionTimeLimit -is [TimeSpan]) { [TimeSpan]$Evidence.executionTimeLimit } else { [Xml.XmlConvert]::ToTimeSpan([string]$Evidence.executionTimeLimit) }
    }
    catch { throw 'Bootstrap trust broker task execution-time limit is invalid.' }
    if ($executionLimit -ne [TimeSpan]::FromMinutes(30)) { throw 'Bootstrap trust broker task execution-time limit must be exactly 30 minutes.' }
    $actualSddl = ConvertTo-RevAgentBootstrapTrustCanonicalSddl -Sddl ([string]$Evidence.sddl)
    $expectedSddl = ConvertTo-RevAgentBootstrapTrustCanonicalSddl -Sddl ([string]$Layout.taskSddl)
    if (-not [string]::Equals($actualSddl, $expectedSddl, [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap trust broker task DACL is not the exact SYSTEM/Admin plus Authenticated-Users query/run contract.' }
    return $true
}

function Register-RevAgentBootstrapTrustTask {
    param([Parameter(Mandatory = $true)][object]$Layout)

    $scheduledTasksManifest = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1'
    if (-not [IO.File]::Exists($scheduledTasksManifest)) { throw "Canonical ScheduledTasks module was not found: $scheduledTasksManifest" }
    Microsoft.PowerShell.Core\Import-Module -Name $scheduledTasksManifest -Force -ErrorAction Stop
    $service = $null
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $cursor = $service.GetFolder('\')
        foreach ($segment in @('DPE', 'revAgent')) {
            try { $cursor = $cursor.GetFolder($segment) }
            catch { $cursor = $cursor.CreateFolder($segment, [string]$Layout.taskSddl) }
        }
        $cursor.SetSecurityDescriptor([string]$Layout.taskSddl, 0)
    }
    finally {
        if ($null -ne $service) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($service) }
    }
    $action = ScheduledTasks\New-ScheduledTaskAction -Execute ([string]$Layout.taskPowerShellPath) -Argument ([string]$Layout.taskArguments) -WorkingDirectory (Split-Path -Parent ([string]$Layout.taskPowerShellPath))
    $principal = ScheduledTasks\New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = ScheduledTasks\New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
    ScheduledTasks\Register-ScheduledTask -TaskName ([string]$Layout.taskName) -TaskPath ([string]$Layout.taskPath) -Action $action -Principal $principal -Settings $settings -Description 'Runs the fixed revAgent machine bootstrap trust broker. Authenticated users may start but cannot alter this task.' -Force -ErrorAction Stop | Out-Null
    $service = $null
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $folder = $service.GetFolder(([string]$Layout.taskPath).TrimEnd('\'))
        $registered = $folder.GetTask([string]$Layout.taskName)
        $registered.SetSecurityDescriptor([string]$Layout.taskSddl, 0)
    }
    finally {
        if ($null -ne $service) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($service) }
    }
    return Get-RevAgentBootstrapTrustTaskEvidence -Layout $Layout
}

function Test-RevAgentBootstrapTrustHealth {
    [CmdletBinding()]
    param(
        [string]$ProgramDataRoot = '',
        [switch]$AllowTestRoot,
        [scriptblock]$TaskProvider = $null
    )

    if ($null -ne $TaskProvider -and -not $AllowTestRoot) { throw 'Bootstrap trust TaskProvider is available only with a disposable TEMP test root.' }
    $layout = Get-RevAgentBootstrapTrustLayout -ProgramDataRoot $ProgramDataRoot -AllowTestRoot:$AllowTestRoot
    $checks = [Collections.Generic.List[object]]::new()
    $taskEvidence = $null
    $state = $null
    function Add-HealthCheck {
        param([string]$Name, [scriptblock]$Action, [string]$Path = '')
        try {
            $value = & $Action
            $checks.Add([pscustomobject][ordered]@{ name = $Name; success = $true; reason = ''; message = 'ok'; path = $Path; evidence = $value })
            return $value
        }
        catch {
            $checks.Add([pscustomobject][ordered]@{ name = $Name; success = $false; reason = $Name; message = [string]$_.Exception.Message; path = $Path; evidence = $null })
            return $null
        }
    }
    [void](Add-HealthCheck -Name 'trust_root_protected' -Path $layout.trustRoot -Action { Test-RevAgentBootstrapTrustAcl -Path $layout.trustRoot -Directory -AllowTestRoot:$AllowTestRoot })
    [void](Add-HealthCheck -Name 'broker_results_root_protected' -Path $layout.resultsRoot -Action { Test-RevAgentBootstrapTrustAcl -Path $layout.resultsRoot -Directory -AllowTestRoot:$AllowTestRoot })
    [void](Add-HealthCheck -Name 'broker_state_root_protected' -Path $layout.stateRoot -Action { Test-RevAgentBootstrapTrustAcl -Path $layout.stateRoot -Directory -AllowTestRoot:$AllowTestRoot })
    $stateEvidence = Add-HealthCheck -Name 'trust_state_contract' -Path $layout.trustStatePath -Action {
        $read = Read-RevAgentBootstrapTrustBoundedBytes -Path $layout.trustStatePath -MaxBytes 262144 -RequireSingleLink
        [void](Test-RevAgentBootstrapTrustAcl -Path $layout.trustStatePath -AllowTestRoot:$AllowTestRoot -RequiredReaderSid 'S-1-5-32-545')
        $parsed = ConvertFrom-RevAgentBootstrapTrustJsonBytes -Bytes $read.bytes -Label 'Bootstrap trust state'
        Assert-RevAgentBootstrapTrustExactProperties -Object $parsed -Names @('schemaVersion', 'app', 'stateType', 'installedAtUtc', 'trustRoot', 'release', 'files', 'task') -Label 'Bootstrap trust state'
        if ([int]$parsed.schemaVersion -ne 1 -or [string]$parsed.app -cne 'revAgent' -or [string]$parsed.stateType -cne 'bootstrap-trust-core') { throw 'Bootstrap trust state identity/version contract is invalid.' }
        if (-not [string]::Equals((Get-RevAgentBootstrapTrustCanonicalPath -Path ([string]$parsed.trustRoot)), (Get-RevAgentBootstrapTrustCanonicalPath -Path $layout.trustRoot), [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap trust state root is not canonical.' }
        $script:RevAgentBootstrapTrustHealthState = $parsed
        return [pscustomobject]@{ sha256 = $read.sha256; state = $parsed }
    }
    if ($null -ne $stateEvidence) { $state = $stateEvidence.state }
    if ($null -ne $state) {
        $expectedFiles = [ordered]@{
            bootstrapTrust = @('RevAgent.BootstrapTrust.psm1', $layout.bootstrapTrustModulePath)
            bootstrapTrustBroker = @('Invoke-RevAgent-BootstrapTrustBroker.ps1', $layout.brokerPath)
            distributionIntegrity = @('RevAgent.DistributionIntegrity.psm1', $layout.distributionIntegrityModulePath)
            releaseSnapshot = @('RevAgent.ReleaseSnapshot.psm1', $layout.releaseSnapshotModulePath)
            trustedKeys = @('release-trusted-keys.json', $layout.trustedKeysPath)
        }
        foreach ($entry in $expectedFiles.GetEnumerator()) {
            $role = [string]$entry.Key
            $targetPath = [string]$entry.Value[1]
            [void](Add-HealthCheck -Name ("trust_file_{0}" -f $role) -Path $targetPath -Action {
                    $record = $state.files.$role
                    if ($null -eq $record -or [string]$record.relativePath -cne [string]$entry.Value[0] -or [string]$record.sha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw "Bootstrap trust state file record is invalid: $role" }
                    $read = Read-RevAgentBootstrapTrustBoundedBytes -Path $targetPath -MaxBytes 8388608 -ExpectedSha256 ([string]$record.sha256) -RequireSingleLink
                    [void](Test-RevAgentBootstrapTrustAcl -Path $targetPath -AllowTestRoot:$AllowTestRoot -RequiredReaderSid 'S-1-5-32-545')
                    if ($role -eq 'trustedKeys') { [void](Assert-RevAgentBootstrapTrustedKeySet -Bytes $read.bytes -AllowTestRoot:$AllowTestRoot) }
                    return [pscustomobject]@{ sha256 = $read.sha256; length = $read.length }
                })
        }
        [void](Add-HealthCheck -Name 'trust_state_task_binding' -Path $layout.trustStatePath -Action {
                Assert-RevAgentBootstrapTrustExactProperties -Object $state.task -Names @('taskName', 'taskPath', 'powerShellPath', 'arguments', 'sddl') -Label 'Bootstrap trust state task'
                if ([string]$state.task.taskName -cne [string]$layout.taskName -or
                    -not [string]::Equals([string]$state.task.taskPath, [string]$layout.taskPath, [StringComparison]::OrdinalIgnoreCase) -or
                    -not [string]::Equals([string]$state.task.powerShellPath, [string]$layout.taskPowerShellPath, [StringComparison]::OrdinalIgnoreCase) -or
                    [string]$state.task.arguments -cne [string]$layout.taskArguments -or
                    (ConvertTo-RevAgentBootstrapTrustCanonicalSddl -Sddl ([string]$state.task.sddl)) -cne (ConvertTo-RevAgentBootstrapTrustCanonicalSddl -Sddl ([string]$layout.taskSddl))) { throw 'Bootstrap trust state task binding is not canonical.' }
                return $true
            })
    }
    $taskEvidence = Add-HealthCheck -Name 'bootstrap_trust_task' -Path ($layout.taskPath + $layout.taskName) -Action {
        $task = if ($null -ne $TaskProvider) { & $TaskProvider $layout } else { Get-RevAgentBootstrapTrustTaskEvidence -Layout $layout }
        [void](Assert-RevAgentBootstrapTrustTaskEvidence -Evidence $task -Layout $layout)
        return $task
    }
    $failed = @($checks.ToArray() | Where-Object { -not [bool]$_.success })
    $reason = if ($failed.Count -gt 0) { [string]$failed[0].reason } else { '' }
    return [pscustomobject][ordered]@{
        success = ($failed.Count -eq 0)
        healthy = ($failed.Count -eq 0)
        reason = $reason
        checks = @($checks.ToArray())
        layout = $layout
        task = $taskEvidence
        taskName = $layout.taskName
        trustRoot = $layout.trustRoot
        releaseSnapshotModulePath = $layout.releaseSnapshotModulePath
        distributionIntegrityModulePath = $layout.distributionIntegrityModulePath
        trustedKeysPath = $layout.trustedKeysPath
        inboxRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'DPE\revAgent\release-inbox'
    }
}

function Install-RevAgentBootstrapTrustCore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BootstrapTrustModulePath,
        [Parameter(Mandatory = $true)][string]$BrokerPath,
        [Parameter(Mandatory = $true)][string]$DistributionIntegrityModulePath,
        [Parameter(Mandatory = $true)][string]$ReleaseSnapshotModulePath,
        [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ExpectedSourceHashes,
        [Parameter(Mandatory = $true)][object]$AuthenticatedRelease,
        [string]$ProgramDataRoot = '',
        [switch]$AllowTestRoot,
        [scriptblock]$TaskRegistrar = $null,
        [scriptblock]$TaskProvider = $null
    )

    if (($null -ne $TaskRegistrar -or $null -ne $TaskProvider) -and -not $AllowTestRoot) { throw 'Bootstrap trust task seams are available only with a disposable TEMP test root.' }
    if ("$($ExecutionContext.SessionState.LanguageMode)" -ne 'FullLanguage') { throw "Bootstrap trust installation requires FullLanguage PowerShell. actual=$($ExecutionContext.SessionState.LanguageMode)" }
    if (-not $AllowTestRoot) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try {
            if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Bootstrap trust installation requires an elevated administrator or SYSTEM process.' }
        }
        finally { $identity.Dispose() }
    }
    $layout = Get-RevAgentBootstrapTrustLayout -ProgramDataRoot $ProgramDataRoot -AllowTestRoot:$AllowTestRoot
    if ($null -eq $AuthenticatedRelease -or -not [bool]$AuthenticatedRelease.signatureVerified -or [long]$AuthenticatedRelease.releaseSequence -le 0 -or [long]$AuthenticatedRelease.highestAcceptedReleaseSequence -lt [long]$AuthenticatedRelease.releaseSequence) {
        throw 'Bootstrap trust installation requires independently verified positive release evidence.'
    }
    if ([string]$AuthenticatedRelease.channel -notin @('stable', 'pilot')) { throw 'Bootstrap trust installation release channel is invalid.' }
    if (-not $AllowTestRoot -and -not [string]::Equals((Get-RevAgentBootstrapTrustCanonicalPath -Path ([string]$AuthenticatedRelease.root)), (Get-RevAgentBootstrapTrustCanonicalPath -Path $script:RevAgentBootstrapTrustProductionReleaseRoot), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Bootstrap trust production release evidence does not name the canonical NAS root.'
    }

    $sourceMap = [ordered]@{
        bootstrapTrust = @($BootstrapTrustModulePath, 8388608, 'RevAgent.BootstrapTrust.psm1')
        bootstrapTrustBroker = @($BrokerPath, 8388608, 'Invoke-RevAgent-BootstrapTrustBroker.ps1')
        distributionIntegrity = @($DistributionIntegrityModulePath, 8388608, 'RevAgent.DistributionIntegrity.psm1')
        releaseSnapshot = @($ReleaseSnapshotModulePath, 8388608, 'RevAgent.ReleaseSnapshot.psm1')
        trustedKeys = @($TrustedKeysPath, 1048576, 'release-trusted-keys.json')
    }
    $sourceEvidence = [ordered]@{}
    foreach ($entry in $sourceMap.GetEnumerator()) {
        $role = [string]$entry.Key
        $expected = ''
        foreach ($key in $ExpectedSourceHashes.Keys) {
            if ([string]::Equals([string]$key, $role, [StringComparison]::OrdinalIgnoreCase)) { $expected = [string]$ExpectedSourceHashes[$key]; break }
        }
        if ($expected -notmatch '^[A-Fa-f0-9]{64}$') { throw "Bootstrap trust expected source SHA-256 is missing or invalid: $role" }
        $sourceEvidence[$role] = Read-RevAgentBootstrapTrustBoundedBytes -Path ([string]$entry.Value[0]) -MaxBytes ([int]$entry.Value[1]) -ExpectedSha256 $expected -RequireSingleLink
    }
    [void](Assert-RevAgentBootstrapTrustedKeySet -Bytes ([byte[]]$sourceEvidence.trustedKeys.bytes) -AllowTestRoot:$AllowTestRoot)

    # The broker task is release-independent. Preserve an already exact task
    # instead of overwriting it before the separate Scheduler DACL operation;
    # that removes the only rollback window in which a healthy prior task
    # could be replaced by a partially registered one.
    $existingTaskEvidence = $null
    $existingTaskHealthy = $false
    if (-not $AllowTestRoot -or $null -ne $TaskProvider) {
        try {
            $existingTaskEvidence = if ($null -ne $TaskProvider) { & $TaskProvider $layout } else { Get-RevAgentBootstrapTrustTaskEvidence -Layout $layout }
            [void](Assert-RevAgentBootstrapTrustTaskEvidence -Evidence $existingTaskEvidence -Layout $layout)
            $existingTaskHealthy = $true
        }
        catch {
            $existingTaskEvidence = $null
            $existingTaskHealthy = $false
        }
    }

    if (-not [IO.Directory]::Exists($layout.programDataRoot)) { throw "Bootstrap trust ProgramData root was not found: $($layout.programDataRoot)" }
    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $layout.programDataRoot)
    $dpeRoot = Join-Path $layout.programDataRoot 'DPE'
    if (-not [IO.Directory]::Exists($dpeRoot)) {
        if (-not $AllowTestRoot) { throw "Bootstrap trust shared DPE root must be created by supervised prestage first: $dpeRoot" }
        [void][IO.Directory]::CreateDirectory($dpeRoot)
    }
    if (-not [IO.Directory]::Exists($layout.productRoot)) {
        if (-not $AllowTestRoot) { throw "Bootstrap trust product root must be created by supervised prestage first: $($layout.productRoot)" }
        [void][IO.Directory]::CreateDirectory($layout.productRoot)
    }
    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $layout.productRoot -StopRoot $layout.programDataRoot)

    if (-not [IO.Directory]::Exists($layout.brokerDataRoot)) { [void](New-RevAgentBootstrapTrustProtectedDirectory -Path $layout.brokerDataRoot -Kind protected-read -AllowTestRoot:$AllowTestRoot) }
    else { Set-RevAgentBootstrapTrustDirectoryAcl -Path $layout.brokerDataRoot -Kind protected-read -AllowTestRoot:$AllowTestRoot }
    foreach ($directory in @(
            @($layout.resultsRoot, 'results'),
            @($layout.stateRoot, 'protected-read'),
            @($layout.snapshotRoot, 'system-only'),
            @($layout.applyRoot, 'system-only'),
            @($layout.trustTransactionRoot, 'system-only'))) {
        [void](New-RevAgentBootstrapTrustProtectedDirectory -Path ([string]$directory[0]) -Kind ([string]$directory[1]) -AllowTestRoot:$AllowTestRoot)
    }
    if (-not [IO.File]::Exists($layout.brokerLockPath)) {
        Write-RevAgentBootstrapTrustFileCreateNew -Path $layout.brokerLockPath -Bytes ([byte[]]@(0x52)) -AllowTestRoot:$AllowTestRoot
    }
    else {
        [void](Read-RevAgentBootstrapTrustBoundedBytes -Path $layout.brokerLockPath -MaxBytes 16 -RequireSingleLink)
        Set-RevAgentBootstrapTrustFileAcl -Path $layout.brokerLockPath -AllowTestRoot:$AllowTestRoot
    }

    $stage = Join-Path $layout.trustTransactionRoot ('.trust-stage-' + [Guid]::NewGuid().ToString('N'))
    $backup = Join-Path $layout.trustTransactionRoot ('.trust-previous-' + [Guid]::NewGuid().ToString('N'))
    $stageCreated = $false
    $trustCommitted = $false
    $installWarnings = [Collections.Generic.List[string]]::new()
    try {
        [void](New-RevAgentBootstrapTrustProtectedDirectory -Path $stage -Kind protected-read -AllowTestRoot:$AllowTestRoot)
        $stageCreated = $true
        $fileState = [ordered]@{}
        foreach ($entry in $sourceMap.GetEnumerator()) {
            $role = [string]$entry.Key
            $relativePath = [string]$entry.Value[2]
            $destination = Join-Path $stage $relativePath
            Write-RevAgentBootstrapTrustFileCreateNew -Path $destination -Bytes ([byte[]]$sourceEvidence[$role].bytes) -AllowBuiltinUsersRead -AllowTestRoot:$AllowTestRoot
            $written = Read-RevAgentBootstrapTrustBoundedBytes -Path $destination -MaxBytes ([int]$entry.Value[1]) -ExpectedSha256 ([string]$sourceEvidence[$role].sha256) -RequireSingleLink
            $fileState[$role] = [ordered]@{ relativePath = $relativePath; sha256 = [string]$written.sha256 }
        }
        $state = [ordered]@{
            schemaVersion = 1
            app = 'revAgent'
            stateType = 'bootstrap-trust-core'
            installedAtUtc = [DateTime]::UtcNow.ToString('o')
            trustRoot = $layout.trustRoot
            release = [ordered]@{
                root = [string]$AuthenticatedRelease.root
                channel = [string]$AuthenticatedRelease.channel
                version = [string]$AuthenticatedRelease.version
                releaseSequence = [long]$AuthenticatedRelease.releaseSequence
                highestAcceptedReleaseSequence = [long]$AuthenticatedRelease.highestAcceptedReleaseSequence
            }
            files = $fileState
            task = [ordered]@{
                taskName = $layout.taskName
                taskPath = $layout.taskPath
                powerShellPath = $layout.taskPowerShellPath
                arguments = $layout.taskArguments
                sddl = $layout.taskSddl
            }
        }
        $stateBytes = [Text.UTF8Encoding]::new($false).GetBytes(($state | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 12))
        Write-RevAgentBootstrapTrustFileCreateNew -Path (Join-Path $stage 'trust-state.json') -Bytes $stateBytes -AllowBuiltinUsersRead -AllowTestRoot:$AllowTestRoot

        if ([IO.Directory]::Exists($layout.trustRoot)) {
            [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $layout.trustRoot -StopRoot $layout.productRoot)
            Microsoft.PowerShell.Management\Move-Item -LiteralPath $layout.trustRoot -Destination $backup -ErrorAction Stop
        }
        Microsoft.PowerShell.Management\Move-Item -LiteralPath $stage -Destination $layout.trustRoot -ErrorAction Stop
        $stageCreated = $false
        $taskEvidence = if ($existingTaskHealthy) { $existingTaskEvidence } elseif ($null -ne $TaskRegistrar) { & $TaskRegistrar $layout } else { Register-RevAgentBootstrapTrustTask -Layout $layout }
        [void](Assert-RevAgentBootstrapTrustTaskEvidence -Evidence $taskEvidence -Layout $layout)
        $trustCommitted = $true
        if ([IO.Directory]::Exists($backup)) {
            try {
                [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $backup -StopRoot $layout.trustTransactionRoot)
                Microsoft.PowerShell.Management\Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop
            }
            catch { $installWarnings.Add("Committed bootstrap trust is healthy, but previous trust cleanup was deferred: $($_.Exception.Message)") }
        }
        return [pscustomobject][ordered]@{
            success = $true
            action = 'bootstrap-trust-core-install'
            installed = $true
            trustRoot = $layout.trustRoot
            trustStatePath = $layout.trustStatePath
            taskName = $layout.taskName
            taskPath = $layout.taskPath
            task = $taskEvidence
            releaseSequence = [long]$AuthenticatedRelease.releaseSequence
            files = $fileState
            warnings = @($installWarnings.ToArray())
        }
    }
    catch {
        $originalError = $_
        if ($trustCommitted) { throw }
        if ([IO.Directory]::Exists($backup)) {
            if ([IO.Directory]::Exists($layout.trustRoot)) {
                [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $layout.trustRoot -StopRoot $layout.productRoot)
                Microsoft.PowerShell.Management\Remove-Item -LiteralPath $layout.trustRoot -Recurse -Force -ErrorAction Stop
            }
            if (-not [IO.Directory]::Exists($layout.trustRoot)) {
                Microsoft.PowerShell.Management\Move-Item -LiteralPath $backup -Destination $layout.trustRoot -ErrorAction Stop
            }
            if (-not [IO.Directory]::Exists($layout.trustRoot)) { throw "Bootstrap trust rollback did not restore the canonical prior trust root. original=$($originalError.Exception.Message)" }
        }
        elseif (-not $stageCreated -and [IO.Directory]::Exists($layout.trustRoot)) {
            [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $layout.trustRoot -StopRoot $layout.productRoot)
            Microsoft.PowerShell.Management\Remove-Item -LiteralPath $layout.trustRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw $originalError
    }
    finally {
        if ($stageCreated -and [IO.Directory]::Exists($stage)) { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

function New-RevAgentBootstrapTrustRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InboxId,
        [string]$ProgramDataRoot = '',
        [switch]$AllowTestRoot,
        [string]$RequesterSid = '',
        [string]$ProfileRoot = '',
        [Nullable[DateTime]]$CreatedAtUtc = $null
    )

    if ((-not [string]::IsNullOrWhiteSpace($RequesterSid) -or -not [string]::IsNullOrWhiteSpace($ProfileRoot) -or $null -ne $CreatedAtUtc) -and -not $AllowTestRoot) { throw 'Bootstrap trust request identity/profile/time overrides are test-only.' }
    if ($InboxId -cnotmatch '^[a-f0-9]{32}$') { throw 'Bootstrap trust inbox id must be exactly 32 lowercase hexadecimal characters.' }
    $layout = Get-RevAgentBootstrapTrustLayout -ProgramDataRoot $ProgramDataRoot -AllowTestRoot:$AllowTestRoot
    if (-not [IO.Directory]::Exists($layout.resultsRoot)) { throw 'Bootstrap trust broker protected result root is not installed.' }
    [void](Test-RevAgentBootstrapTrustAcl -Path $layout.resultsRoot -Directory -AllowTestRoot:$AllowTestRoot)
    if ([string]::IsNullOrWhiteSpace($RequesterSid)) { $RequesterSid = Get-RevAgentBootstrapTrustCurrentSid }
    try {
        $normalizedRequesterSid = [string][Security.Principal.SecurityIdentifier]::new($RequesterSid).Value
    }
    catch { throw "Bootstrap trust requester SID is invalid: $RequesterSid" }
    if (-not $AllowTestRoot -and -not [string]::Equals($normalizedRequesterSid, (Get-RevAgentBootstrapTrustCurrentSid), [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap trust request SID must be the current interactive caller.' }
    $requestQueueRoot = Get-RevAgentBootstrapTrustRequestQueueRoot -Layout $layout -ProfileRoot $ProfileRoot -AllowTestRoot:$AllowTestRoot
    [void][IO.Directory]::CreateDirectory($requestQueueRoot)
    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $requestQueueRoot)
    $nonce = [Guid]::NewGuid().ToString('N')
    $requestPath = Join-Path $requestQueueRoot ("bootstrap-request-$nonce.json")
    $resultPath = Get-RevAgentBootstrapTrustResultPath -Layout $layout -RequesterSid $normalizedRequesterSid -Nonce $nonce
    $created = if ($null -eq $CreatedAtUtc) { [DateTime]::UtcNow } else { ([DateTime]$CreatedAtUtc).ToUniversalTime() }
    $document = [ordered]@{
        schemaVersion = 1
        app = 'revAgent'
        requestType = 'bootstrap-trust-apply'
        nonce = $nonce
        requesterSid = $normalizedRequesterSid
        inboxId = $InboxId
        createdAtUtc = $created.ToString('o')
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($document | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 4))
    Write-RevAgentBootstrapTrustFileCreateNew -Path $requestPath -Bytes $bytes -ReaderSid $normalizedRequesterSid -WriterIsRequester -AllowTestRoot:$AllowTestRoot
    return [pscustomobject][ordered]@{
        success = $true
        action = 'bootstrap-trust-request-created'
        inboxId = $InboxId
        nonce = $nonce
        requesterSid = $normalizedRequesterSid
        createdAtUtc = $created.ToString('o')
        requestQueueRoot = $requestQueueRoot
        requestPath = $requestPath
        resultPath = $resultPath
        taskName = $layout.taskName
        taskPath = $layout.taskPath
    }
}

function Start-RevAgentBootstrapTrustBrokerTask {
    [CmdletBinding()]
    param(
        [string]$ProgramDataRoot = '',
        [switch]$AllowTestRoot,
        [scriptblock]$TaskStarter = $null
    )

    if ($null -ne $TaskStarter -and -not $AllowTestRoot) { throw 'Bootstrap trust TaskStarter is available only with a disposable TEMP test root.' }
    $layout = Get-RevAgentBootstrapTrustLayout -ProgramDataRoot $ProgramDataRoot -AllowTestRoot:$AllowTestRoot
    if ($null -ne $TaskStarter) { & $TaskStarter $layout | Out-Null }
    else {
        $scheduledTasksManifest = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1'
        if (-not [IO.File]::Exists($scheduledTasksManifest)) { throw "Canonical ScheduledTasks module was not found: $scheduledTasksManifest" }
        Microsoft.PowerShell.Core\Import-Module -Name $scheduledTasksManifest -Force -ErrorAction Stop
        ScheduledTasks\Start-ScheduledTask -TaskName $layout.taskName -TaskPath $layout.taskPath -ErrorAction Stop
    }
    return [pscustomobject][ordered]@{ success = $true; action = 'bootstrap-trust-broker-task-start'; taskName = $layout.taskName; taskPath = $layout.taskPath; argumentsPassed = 0 }
}

function Get-RevAgentBootstrapTrustRequestContract {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][string]$ExpectedRequesterSid,
        [Parameter(Mandatory = $true)][string]$RequestQueueRoot,
        [switch]$AllowTestRoot
    )

    $fullPath = Get-RevAgentBootstrapTrustCanonicalPath -Path $Path
    $queueRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path $RequestQueueRoot
    if (-not [string]::Equals((Split-Path -Parent $fullPath), $queueRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($fullPath) -cnotmatch '^bootstrap-request-([a-f0-9]{32})\.json$') { throw "Bootstrap trust request path is outside the exact profile queue pattern: $fullPath" }
    $fileNonce = [regex]::Match([IO.Path]::GetFileName($fullPath), '^bootstrap-request-([a-f0-9]{32})\.json$').Groups[1].Value
    $read = Read-RevAgentBootstrapTrustBoundedBytes -Path $fullPath -MaxBytes 16384 -RequireSingleLink
    $document = ConvertFrom-RevAgentBootstrapTrustJsonBytes -Bytes $read.bytes -Label 'Bootstrap trust request'
    Assert-RevAgentBootstrapTrustExactProperties -Object $document -Names @('schemaVersion', 'app', 'requestType', 'nonce', 'requesterSid', 'inboxId', 'createdAtUtc') -Label 'Bootstrap trust request'
    if ([int]$document.schemaVersion -ne 1 -or [string]$document.app -cne 'revAgent' -or [string]$document.requestType -cne 'bootstrap-trust-apply') { throw 'Bootstrap trust request identity/version contract is invalid.' }
    if ([string]$document.nonce -cnotmatch '^[a-f0-9]{32}$' -or [string]$document.nonce -cne $fileNonce) { throw 'Bootstrap trust request nonce does not match its exact queue filename.' }
    if ([string]$document.inboxId -cnotmatch '^[a-f0-9]{32}$') { throw 'Bootstrap trust request inbox id is invalid.' }
    try { $requesterSid = [string][Security.Principal.SecurityIdentifier]::new([string]$document.requesterSid).Value }
    catch { throw 'Bootstrap trust request requesterSid is invalid.' }
    $expectedSid = Get-RevAgentBootstrapTrustNormalizedSid -Sid $ExpectedRequesterSid
    if (-not [string]::Equals($requesterSid, $expectedSid, [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap trust request requesterSid does not match its machine-enumerated profile queue.' }
    $createdAt = [DateTime]::MinValue
    if (-not [DateTime]::TryParse([string]$document.createdAtUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$createdAt)) { throw 'Bootstrap trust request createdAtUtc is invalid.' }
    $createdAt = $createdAt.ToUniversalTime()
    if ($createdAt -gt [DateTime]::UtcNow.AddMinutes(2) -or $createdAt -lt [DateTime]::UtcNow.AddMinutes(-30)) { throw 'Bootstrap trust request timestamp is outside the bounded 30-minute policy.' }
    $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $fullPath -ErrorAction Stop
    $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (-not [string]::Equals($owner, $requesterSid, [StringComparison]::OrdinalIgnoreCase) -and
        -not ($AllowTestRoot -and [string]::Equals($owner, (Get-RevAgentBootstrapTrustCurrentSid), [StringComparison]::OrdinalIgnoreCase))) { throw "Bootstrap trust request owner does not match requesterSid. owner=$owner requester=$requesterSid" }
    return [pscustomobject][ordered]@{
        schemaVersion = 1
        app = 'revAgent'
        requestType = 'bootstrap-trust-apply'
        nonce = [string]$document.nonce
        requesterSid = $requesterSid
        inboxId = [string]$document.inboxId
        createdAtUtc = $createdAt.ToString('o')
        requestQueueRoot = $queueRoot
        requestPath = $fullPath
        resultPath = Get-RevAgentBootstrapTrustResultPath -Layout $Layout -RequesterSid $requesterSid -Nonce ([string]$document.nonce)
    }
}

function Get-RevAgentBootstrapTrustResultBucket {
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][string]$RequesterSid,
        [switch]$Create,
        [switch]$AllowTestRoot
    )

    $sid = Get-RevAgentBootstrapTrustNormalizedSid -Sid $RequesterSid
    $bucketPath = Get-RevAgentBootstrapTrustResultBucketPath -Layout $Layout -RequesterSid $sid
    if (-not [IO.Directory]::Exists($bucketPath)) {
        if (-not $Create) { return [pscustomobject][ordered]@{ exists = $false; requesterSid = $sid; path = $bucketPath } }
        [void](New-RevAgentBootstrapTrustProtectedDirectory -Path $bucketPath -Kind principal-results -ReaderSid $sid -AllowTestRoot:$AllowTestRoot)
    }
    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $bucketPath -StopRoot ([string]$Layout.resultsRoot))
    [void](Test-RevAgentBootstrapTrustAcl -Path $bucketPath -Directory -AllowTestRoot:$AllowTestRoot -RequiredReaderSid $sid)
    return [pscustomobject][ordered]@{ exists = $true; requesterSid = $sid; path = $bucketPath }
}

function Get-RevAgentBootstrapTrustResultBucketFiles {
    param(
        [Parameter(Mandatory = $true)][object]$Bucket,
        [ValidateRange(1, 17)][int]$MaxFiles = 17
    )

    if (-not [bool]$Bucket.exists) { return @() }
    $files = [Collections.Generic.List[IO.FileInfo]]::new()
    foreach ($path in [IO.Directory]::EnumerateFiles([string]$Bucket.path, '*', [IO.SearchOption]::TopDirectoryOnly)) {
        if ($files.Count -ge $MaxFiles) { throw "Bootstrap trust principal result bucket exceeds its hard 16-file cap: $($Bucket.path)" }
        $name = [IO.Path]::GetFileName($path)
        if ($name -cnotmatch '^bootstrap-result-[a-f0-9]{32}\.json$') { throw "Bootstrap trust result bucket contains an invalid file: $path" }
        $files.Add([IO.FileInfo]::new($path))
    }
    foreach ($directory in [IO.Directory]::EnumerateDirectories([string]$Bucket.path, '*', [IO.SearchOption]::TopDirectoryOnly)) {
        throw "Bootstrap trust result bucket contains an unexpected directory: $directory"
    }
    return @($files.ToArray())
}

function Invoke-RevAgentBootstrapTrustResultBucketRetention {
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][object]$Bucket,
        [switch]$AllowTestRoot,
        [ValidateRange(1, 15)][int]$RetainNewest = 8
    )

    if (-not [bool]$Bucket.exists) { return [pscustomobject][ordered]@{ retained = 0; removed = 0; pinned = 0; blocked = $false } }
    $files = @(Get-RevAgentBootstrapTrustResultBucketFiles -Bucket $Bucket | Sort-Object LastWriteTimeUtc, Name)
    $removeCount = [Math]::Max(0, $files.Count - $RetainNewest)
    $removed = 0
    $pinned = 0
    for ($index = 0; $index -lt $removeCount; $index++) {
        $path = [string]$files[$index].FullName
        try {
            [void](Read-RevAgentBootstrapTrustBoundedBytes -Path $path -MaxBytes 65536 -RequireSingleLink)
            [void](Test-RevAgentBootstrapTrustAcl -Path $path -AllowTestRoot:$AllowTestRoot -RequiredReaderSid ([string]$Bucket.requesterSid))
            [IO.File]::Delete($path)
            if ([IO.File]::Exists($path)) { throw 'delete did not remove the exact protected result' }
            $removed++
        }
        catch { $pinned++ }
    }
    $remaining = @(Get-RevAgentBootstrapTrustResultBucketFiles -Bucket $Bucket)
    return [pscustomobject][ordered]@{ retained = $remaining.Count; removed = $removed; pinned = $pinned; blocked = ($remaining.Count -ge 16) }
}

function Assert-RevAgentBootstrapTrustResultWriteCapacity {
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][string]$RequesterSid,
        [switch]$AllowTestRoot
    )

    $bucket = Get-RevAgentBootstrapTrustResultBucket -Layout $Layout -RequesterSid $RequesterSid -AllowTestRoot:$AllowTestRoot
    if (-not [bool]$bucket.exists) {
        # Reserve the global principal-bucket capacity before creating a new
        # per-SID directory. The broker is single-instance, so this preflight
        # and create sequence cannot race another broker; rejecting at the
        # exact cap prevents a 129th bucket from wedging every later preflight.
        $globalCapacity = Invoke-RevAgentBootstrapTrustResultRetention -Layout $Layout -AllowTestRoot:$AllowTestRoot
        if ([int]$globalCapacity.bucketCount -ge 128) {
            throw 'Bootstrap trust result root has reached its hard 128-principal capacity; no new principal bucket was created.'
        }
        $bucket = Get-RevAgentBootstrapTrustResultBucket -Layout $Layout -RequesterSid $RequesterSid -Create -AllowTestRoot:$AllowTestRoot
    }
    $retention = Invoke-RevAgentBootstrapTrustResultBucketRetention -Layout $Layout -Bucket $bucket -AllowTestRoot:$AllowTestRoot
    if ([bool]$retention.blocked) { throw "Bootstrap trust principal result bucket has no protected capacity: $($bucket.path)" }
    return $bucket
}

function Write-RevAgentBootstrapTrustResult {
    param(
        [Parameter(Mandatory = $true)][object]$Request,
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][ValidateSet('succeeded', 'failed')][string]$State,
        [Parameter(Mandatory = $true)][int]$ExitCode,
        [AllowEmptyString()][string]$Message = '',
        [long]$ReleaseSequence = 0,
        [string]$BootstrapStateSha256 = '',
        [string]$TrustStateSha256 = '',
        [switch]$AllowTestRoot
    )

    $bucket = Assert-RevAgentBootstrapTrustResultWriteCapacity -Layout $Layout -RequesterSid ([string]$Request.requesterSid) -AllowTestRoot:$AllowTestRoot
    $resultPath = Get-RevAgentBootstrapTrustResultPath -Layout $Layout -RequesterSid ([string]$Request.requesterSid) -Nonce ([string]$Request.nonce)
    if (-not [string]::Equals((Split-Path -Parent $resultPath), [string]$bucket.path, [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap trust result path escaped its principal bucket.' }
    if ([IO.File]::Exists($resultPath)) { throw "Bootstrap trust result replay/collision detected: $resultPath" }
    $document = [ordered]@{
        schemaVersion = 1
        app = 'revAgent'
        resultType = 'bootstrap-trust-apply'
        nonce = [string]$Request.nonce
        requesterSid = [string]$Request.requesterSid
        inboxId = [string]$Request.inboxId
        completedAtUtc = [DateTime]::UtcNow.ToString('o')
        state = $State
        exitCode = $ExitCode
        message = $Message
        releaseSequence = $ReleaseSequence
        bootstrapStateSha256 = $BootstrapStateSha256
        trustStateSha256 = $TrustStateSha256
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($document | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 6))
    Write-RevAgentBootstrapTrustFileCreateNew -Path $resultPath -Bytes $bytes -ReaderSid ([string]$Request.requesterSid) -AllowTestRoot:$AllowTestRoot
    return [pscustomobject]$document
}

function Read-RevAgentBootstrapTrustResult {
    param(
        [Parameter(Mandatory = $true)][object]$Request,
        [Parameter(Mandatory = $true)][object]$Layout,
        [switch]$AllowTestRoot
    )

    $bucket = Get-RevAgentBootstrapTrustResultBucket -Layout $Layout -RequesterSid ([string]$Request.requesterSid) -AllowTestRoot:$AllowTestRoot
    $expectedPath = Get-RevAgentBootstrapTrustResultPath -Layout $Layout -RequesterSid ([string]$Request.requesterSid) -Nonce ([string]$Request.nonce)
    if (-not [bool]$bucket.exists) { return $null }
    if (-not [IO.File]::Exists($expectedPath)) { return $null }
    $read = Read-RevAgentBootstrapTrustBoundedBytes -Path $expectedPath -MaxBytes 65536 -RequireSingleLink
    [void](Test-RevAgentBootstrapTrustAcl -Path $expectedPath -AllowTestRoot:$AllowTestRoot -RequiredReaderSid ([string]$Request.requesterSid))
    $document = ConvertFrom-RevAgentBootstrapTrustJsonBytes -Bytes $read.bytes -Label 'Bootstrap trust result'
    Assert-RevAgentBootstrapTrustExactProperties -Object $document -Names @('schemaVersion', 'app', 'resultType', 'nonce', 'requesterSid', 'inboxId', 'completedAtUtc', 'state', 'exitCode', 'message', 'releaseSequence', 'bootstrapStateSha256', 'trustStateSha256') -Label 'Bootstrap trust result'
    if ([int]$document.schemaVersion -ne 1 -or [string]$document.app -cne 'revAgent' -or [string]$document.resultType -cne 'bootstrap-trust-apply' -or
        [string]$document.state -notin @('succeeded', 'failed') -or
        [string]$document.nonce -cne [string]$Request.nonce -or
        -not [string]::Equals([string]$document.requesterSid, [string]$Request.requesterSid, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$document.inboxId -cne [string]$Request.inboxId) { throw 'Bootstrap trust result identity/nonce/request binding is invalid.' }
    if ([string]$document.state -eq 'succeeded' -and [int]$document.exitCode -ne 0) { throw 'Bootstrap trust successful result has a nonzero exit code.' }
    return [pscustomobject][ordered]@{
        completed = $true
        timedOut = $false
        exitCode = [int]$document.exitCode
        message = [string]$document.message
        state = [string]$document.state
        releaseSequence = [long]$document.releaseSequence
        bootstrapStateSha256 = [string]$document.bootstrapStateSha256
        trustStateSha256 = [string]$document.trustStateSha256
        nonce = [string]$document.nonce
        requesterSid = [string]$document.requesterSid
        inboxId = [string]$document.inboxId
        resultPath = $expectedPath
    }
}

function Wait-RevAgentBootstrapTrustResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Request,
        [ValidateRange(0, 3600)][int]$TimeoutSeconds = 600,
        [ValidateRange(10, 10000)][int]$PollMilliseconds = 500,
        [string]$ProgramDataRoot = '',
        [switch]$AllowTestRoot
    )

    $layout = Get-RevAgentBootstrapTrustLayout -ProgramDataRoot $ProgramDataRoot -AllowTestRoot:$AllowTestRoot
    foreach ($propertyName in @('nonce', 'requesterSid', 'inboxId', 'requestQueueRoot', 'requestPath', 'resultPath')) {
        if ($null -eq $Request.PSObject.Properties[$propertyName] -or [string]::IsNullOrWhiteSpace([string]$Request.$propertyName)) { throw "Bootstrap trust wait request is missing '$propertyName'." }
    }
    if ([string]$Request.nonce -cnotmatch '^[a-f0-9]{32}$' -or [string]$Request.inboxId -cnotmatch '^[a-f0-9]{32}$') { throw 'Bootstrap trust wait request identifiers are invalid.' }
    $requestQueueRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path ([string]$Request.requestQueueRoot)
    if ($AllowTestRoot) { [void](Assert-RevAgentBootstrapTrustTestRoot -ProgramDataRoot $requestQueueRoot) }
    else {
        $expectedCurrentQueue = Get-RevAgentBootstrapTrustRequestQueueRoot -Layout $layout
        if (-not [string]::Equals($requestQueueRoot, $expectedCurrentQueue, [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap trust wait request queue is not the current user profile queue.' }
    }
    $expectedRequestPath = Join-Path $requestQueueRoot ("bootstrap-request-$([string]$Request.nonce).json")
    $expectedResultPath = Get-RevAgentBootstrapTrustResultPath -Layout $layout -RequesterSid ([string]$Request.requesterSid) -Nonce ([string]$Request.nonce)
    if (-not [string]::Equals((Get-RevAgentBootstrapTrustCanonicalPath -Path ([string]$Request.requestPath)), (Get-RevAgentBootstrapTrustCanonicalPath -Path $expectedRequestPath), [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals((Get-RevAgentBootstrapTrustCanonicalPath -Path ([string]$Request.resultPath)), (Get-RevAgentBootstrapTrustCanonicalPath -Path $expectedResultPath), [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap trust wait request/result paths are not canonical nonce-derived paths.' }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $result = Read-RevAgentBootstrapTrustResult -Request $Request -Layout $layout -AllowTestRoot:$AllowTestRoot
        if ($null -ne $result) { return $result }
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
            return [pscustomobject][ordered]@{ completed = $false; timedOut = $true; exitCode = 81; message = 'The revAgent bootstrap trust broker did not produce a protected result before the timeout.'; state = 'timed-out'; releaseSequence = 0; bootstrapStateSha256 = ''; trustStateSha256 = ''; nonce = [string]$Request.nonce; requesterSid = [string]$Request.requesterSid; inboxId = [string]$Request.inboxId; resultPath = $expectedResultPath }
        }
        Start-Sleep -Milliseconds $PollMilliseconds
    }
}

function Remove-RevAgentBootstrapTrustClientArtifacts {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Request,
        [string]$ProgramDataRoot = '',
        [switch]$AllowTestRoot
    )

    $layout = Get-RevAgentBootstrapTrustLayout -ProgramDataRoot $ProgramDataRoot -AllowTestRoot:$AllowTestRoot
    if ([string]$Request.nonce -cnotmatch '^[a-f0-9]{32}$') { throw 'Bootstrap trust cleanup request nonce is invalid.' }
    if ($null -eq $Request.PSObject.Properties['requestQueueRoot']) { throw 'Bootstrap trust cleanup request queue root is missing.' }
    $requestQueueRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path ([string]$Request.requestQueueRoot)
    if ($AllowTestRoot) { [void](Assert-RevAgentBootstrapTrustTestRoot -ProgramDataRoot $requestQueueRoot) }
    else {
        $expectedCurrentQueue = Get-RevAgentBootstrapTrustRequestQueueRoot -Layout $layout
        if (-not [string]::Equals($requestQueueRoot, $expectedCurrentQueue, [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap trust cleanup request queue is not the current user profile queue.' }
    }
    $expected = @(
        (Join-Path $requestQueueRoot ("bootstrap-request-$([string]$Request.nonce).json")),
        (Get-RevAgentBootstrapTrustResultPath -Layout $layout -RequesterSid ([string]$Request.requesterSid) -Nonce ([string]$Request.nonce))
    )
    $removed = [Collections.Generic.List[string]]::new()
    $retained = [Collections.Generic.List[string]]::new()
    foreach ($path in $expected) {
        if (-not [IO.File]::Exists($path)) { continue }
        try {
            [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $path -RequireLeaf)
            if (-not $AllowTestRoot -and (Test-RevAgentBootstrapTrustPathUnderRoot -Path $path -Root $layout.resultsRoot)) { $retained.Add($path); continue }
            [IO.File]::Delete($path)
            if ([IO.File]::Exists($path)) { throw 'delete did not remove the exact file' }
            $removed.Add($path)
        }
        catch { $retained.Add($path) }
    }
    return [pscustomobject][ordered]@{ success = $true; action = 'bootstrap-trust-client-cleanup'; removed = @($removed.ToArray()); retained = @($retained.ToArray()); inboxCleanupOwnedByCaller = $true }
}

function New-RevAgentMachineTrustBrokerEvidence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$SnapshotStatePath,
        [Parameter(Mandatory = $true)][string]$OutputPath,
        [string]$ReleaseRoot = $script:RevAgentBootstrapTrustProductionReleaseRoot,
        [switch]$AllowTestRoot
    )

    if (-not $AllowTestRoot -and -not [string]::Equals((Get-RevAgentBootstrapTrustCurrentSid), 'S-1-5-18', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Machine-trust-broker evidence may be generated only by LocalSystem.'
    }
    if (-not $AllowTestRoot -and -not [string]::Equals((Get-RevAgentBootstrapTrustCanonicalPath -Path $ReleaseRoot), (Get-RevAgentBootstrapTrustCanonicalPath -Path $script:RevAgentBootstrapTrustProductionReleaseRoot), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Machine-trust-broker evidence uses only the canonical production release identity.'
    }

    $stateFullPath = Get-RevAgentBootstrapTrustCanonicalPath -Path $SnapshotStatePath
    $outputFullPath = Get-RevAgentBootstrapTrustCanonicalPath -Path $OutputPath
    if ($AllowTestRoot) {
        [void](Assert-RevAgentBootstrapTrustTestRoot -ProgramDataRoot (Split-Path -Parent (Split-Path -Parent $stateFullPath)))
        $tempRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path ([IO.Path]::GetTempPath())
        if (-not (Test-RevAgentBootstrapTrustPathUnderRoot -Path $outputFullPath -Root $tempRoot)) { throw 'Test machine-trust-broker evidence output must remain below TEMP.' }
    }
    else {
        $layout = Get-RevAgentBootstrapTrustLayout
        if (-not (Test-RevAgentBootstrapTrustPathUnderRoot -Path $stateFullPath -Root $layout.snapshotRoot)) { throw 'Machine-trust-broker snapshot state is outside the protected canonical snapshot root.' }
        $outputParent = Get-RevAgentBootstrapTrustCanonicalPath -Path (Split-Path -Parent $outputFullPath)
        $expectedParentRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path $layout.applyRoot
        if ([IO.Path]::GetFileName($outputFullPath) -cne 'bootstrap-prestage-evidence.json' -or
            [IO.Path]::GetFileName($outputParent) -cnotmatch '^apply-[a-f0-9]{32}$' -or
            -not [string]::Equals((Split-Path -Parent $outputParent), $expectedParentRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Machine-trust-broker evidence output path is not an exact private nonce-derived apply child.'
        }
        [void](Test-RevAgentBootstrapTrustSystemOnlyAcl -Path $outputParent -Directory)
    }

    $stateRead = Read-RevAgentBootstrapTrustBoundedBytes -Path $stateFullPath -MaxBytes 4194304 -RequireSingleLink
    [void](Test-RevAgentBootstrapTrustAcl -Path $stateFullPath -AllowTestRoot:$AllowTestRoot)
    $state = ConvertFrom-RevAgentBootstrapTrustJsonBytes -Bytes $stateRead.bytes -Label 'Protected release snapshot state'
    Assert-RevAgentBootstrapTrustExactProperties -Object $state -Names @('schemaVersion', 'app', 'stateType', 'transportTrust', 'accessPolicy', 'snapshotId', 'snapshotRoot', 'createdAtUtc', 'acquisitionChannelManifestPath', 'channelPolicy', 'release', 'trust', 'execution', 'components', 'externalDependencies') -Label 'Protected release snapshot state'
    if ([int]$state.schemaVersion -ne 1 -or [string]$state.app -cne 'revAgent' -or [string]$state.stateType -cne 'authenticated-release-snapshot' -or
        [string]$state.transportTrust -cne 'signed_local_snapshot' -or [string]$state.accessPolicy -cne 'system-only-bootstrap-trust' -or
        [string]$state.snapshotId -cnotmatch '^[a-f0-9]{32}$') { throw 'Protected release snapshot identity/version/access-policy contract is invalid.' }
    $snapshotRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path ([string]$state.snapshotRoot)
    if (-not [string]::Equals($stateFullPath, (Join-Path $snapshotRoot 'snapshot-state.json'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Protected release snapshot state path/root binding is invalid.' }
    if (-not $AllowTestRoot) {
        $layout = Get-RevAgentBootstrapTrustLayout
        if (-not (Test-RevAgentBootstrapTrustPathUnderRoot -Path $snapshotRoot -Root $layout.snapshotRoot)) { throw 'Protected release snapshot root is not canonical.' }
    }
    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $snapshotRoot)
    Assert-RevAgentBootstrapTrustExactProperties -Object $state.trust -Names @('trustedKeysRelativePath', 'trustedKeysSha256', 'productionKeyFingerprint', 'verifierRelativePath', 'verifierSha256', 'signaturesVerified') -Label 'Protected release snapshot trust'
    if (-not [bool]$state.trust.signaturesVerified -or [string]$state.trust.trustedKeysSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or [string]$state.trust.verifierSha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Protected release snapshot signature/trust evidence is invalid.' }
    Assert-RevAgentBootstrapTrustExactProperties -Object $state.release -Names @('channel', 'version', 'releaseSequence', 'minimumAcceptedReleaseSequence', 'highestAcceptedReleaseSequence', 'channelManifestRelativePath', 'channelSignatureRelativePath', 'releaseManifestRelativePath', 'releaseManifestSignatureRelativePath', 'packageRelativePath', 'channelManifestSha256', 'channelSignatureSha256', 'releaseManifestSha256', 'releaseManifestSignatureSha256', 'packageSha256', 'packageSizeBytes') -Label 'Protected release snapshot release'
    if ([string]$state.release.channel -cne 'stable' -or [string]::IsNullOrWhiteSpace([string]$state.release.version) -or
        [long]$state.release.releaseSequence -le 0 -or [long]$state.release.minimumAcceptedReleaseSequence -gt [long]$state.release.releaseSequence -or
        [long]$state.release.highestAcceptedReleaseSequence -lt [long]$state.release.releaseSequence) { throw 'Protected release snapshot release sequence/channel contract is invalid.' }

    $signedFiles = [ordered]@{
        channelManifest = @([string]$state.release.channelManifestRelativePath, [string]$state.release.channelManifestSha256, 1048576L)
        releaseManifest = @([string]$state.release.releaseManifestRelativePath, [string]$state.release.releaseManifestSha256, 4194304L)
        package = @([string]$state.release.packageRelativePath, [string]$state.release.packageSha256, 4294967296L)
    }
    foreach ($signedFile in $signedFiles.GetEnumerator()) {
        $filePath = Resolve-RevAgentBootstrapTrustSnapshotRelativePath -SnapshotRoot $snapshotRoot -RelativePath ([string]$signedFile.Value[0])
        $actual = Get-RevAgentBootstrapTrustFileSha256Bounded -Path $filePath -MaxBytes ([long]$signedFile.Value[2]) -RequireSingleLink
        [void](Test-RevAgentBootstrapTrustAcl -Path $filePath -AllowTestRoot:$AllowTestRoot)
        if (-not [string]::Equals([string]$actual.sha256, [string]$signedFile.Value[1], [StringComparison]::OrdinalIgnoreCase)) { throw "Protected release snapshot signed file hash mismatch: $($signedFile.Key)" }
    }

    $componentMap = [ordered]@{
        localBootstrapInstallerScript = @('localBootstrapInstaller', 'installer\nas\install-revagent-local-bootstrap.ps1')
        localBootstrapInstallerModule = @('installerLibLocalBootstrap', 'installer\lib\RevAgent.LocalBootstrap.psm1')
        bootstrap = @('localBootstrap', 'installer\nas\Start-revAgent-Update.ps1')
        launcher = @('localBootstrapLauncher', 'installer\nas\Start-revAgent-Update.cmd')
        updaterGui = @('updaterGui', 'installer\nas\Install-revAgent-Updater-GUI.ps1')
        distributionIntegrity = @('installerLibDistributionIntegrity', 'installer\lib\RevAgent.DistributionIntegrity.psm1')
        permissions = @('installerLibPermissions', 'installer\lib\RevAgent.Permissions.psm1')
        sourceFreeMigration = @('installerLibSourceFreeMigration', 'installer\lib\RevAgent.SourceFreeMigration.psm1')
        releaseSnapshot = @('installerLibReleaseSnapshot', 'installer\lib\RevAgent.ReleaseSnapshot.psm1')
        privilegedSnapshotUpdate = @('privilegedSnapshotUpdate', 'installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1')
        bootstrapTrust = @('installerLibBootstrapTrust', 'installer\lib\RevAgent.BootstrapTrust.psm1')
        bootstrapTrustBroker = @('bootstrapTrustBroker', 'installer\nas\Invoke-RevAgent-BootstrapTrustBroker.ps1')
        trustedKeys = @('releaseTrustedKeys', 'config\release-trusted-keys.json')
    }
    $componentEvidence = [ordered]@{}
    foreach ($entry in $componentMap.GetEnumerator()) {
        $componentEvidence[$entry.Key] = Get-RevAgentBootstrapTrustSnapshotComponent -State $state -SnapshotRoot $snapshotRoot -ComponentName ([string]$entry.Value[0]) -ExpectedPath ([string]$entry.Value[1]) -AllowTestRoot:$AllowTestRoot
    }
    $protectedKeyPath = Resolve-RevAgentBootstrapTrustSnapshotRelativePath -SnapshotRoot $snapshotRoot -RelativePath ([string]$state.trust.trustedKeysRelativePath)
    $protectedKey = Read-RevAgentBootstrapTrustBoundedBytes -Path $protectedKeyPath -MaxBytes 1048576 -ExpectedSha256 ([string]$state.trust.trustedKeysSha256) -RequireSingleLink
    [void](Assert-RevAgentBootstrapTrustedKeySet -Bytes $protectedKey.bytes -AllowTestRoot:$AllowTestRoot)
    if (-not [string]::Equals([string]$componentEvidence.trustedKeys.sha256, [string]$protectedKey.sha256, [StringComparison]::OrdinalIgnoreCase)) { throw 'Signed package trusted-key component differs from the protected key set used to verify the release.' }

    $evidence = [ordered]@{
        schemaVersion = 1
        app = 'revAgent'
        evidenceType = 'bootstrap-prestage'
        producerMode = 'machine-trust-broker'
        supervisedAdminPrestage = $false
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        generatedBySid = 'S-1-5-18'
        release = [ordered]@{
            root = $ReleaseRoot
            channel = [string]$state.release.channel
            version = [string]$state.release.version
            releaseSequence = [long]$state.release.releaseSequence
            minimumAcceptedReleaseSequence = [long]$state.release.minimumAcceptedReleaseSequence
            highestAcceptedReleaseSequence = [long]$state.release.highestAcceptedReleaseSequence
            channelManifestSha256 = [string]$state.release.channelManifestSha256
            releaseManifestSha256 = [string]$state.release.releaseManifestSha256
            packageSha256 = [string]$state.release.packageSha256
            signatureVerified = $true
            pilotPolicy = $null
        }
        localBootstrapInstallerScript = [string]$componentEvidence.localBootstrapInstallerScript.sha256
        localBootstrapInstallerModule = [string]$componentEvidence.localBootstrapInstallerModule.sha256
        sources = [ordered]@{
            bootstrap = [string]$componentEvidence.bootstrap.sha256
            launcher = [string]$componentEvidence.launcher.sha256
            updaterGui = [string]$componentEvidence.updaterGui.sha256
            distributionIntegrity = [string]$componentEvidence.distributionIntegrity.sha256
            permissions = [string]$componentEvidence.permissions.sha256
            sourceFreeMigration = [string]$componentEvidence.sourceFreeMigration.sha256
            releaseSnapshot = [string]$componentEvidence.releaseSnapshot.sha256
            privilegedSnapshotUpdate = [string]$componentEvidence.privilegedSnapshotUpdate.sha256
            bootstrapTrust = [string]$componentEvidence.bootstrapTrust.sha256
            bootstrapTrustBroker = [string]$componentEvidence.bootstrapTrustBroker.sha256
            trustedKeys = [string]$componentEvidence.trustedKeys.sha256
        }
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($evidence | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 12))
    Write-RevAgentBootstrapTrustFileCreateNew -Path $outputFullPath -Bytes $bytes -AllowTestRoot:$AllowTestRoot
    return [pscustomobject][ordered]@{
        success = $true
        action = 'bootstrap-prestage-evidence'
        outputPath = $outputFullPath
        outputSha256 = Get-RevAgentBootstrapTrustBytesSha256 -Bytes $bytes
        version = [string]$state.release.version
        releaseSequence = [long]$state.release.releaseSequence
        signatureVerified = $true
        producerMode = 'machine-trust-broker'
        supervisedAdminPrestage = $false
        evidence = [pscustomobject]$evidence
        components = [pscustomobject]$componentEvidence
    }
}

function Get-RevAgentBootstrapTrustFileSha256Bounded {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateRange(1, 4294967296)][long]$MaxBytes,
        [switch]$RequireSingleLink
    )

    $fullPath = Assert-RevAgentBootstrapTrustPathNoLinks -Path $Path -RequireLeaf
    $stream = [IO.File]::Open($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt $MaxBytes) { throw "Bootstrap trust file size is outside policy. path=$fullPath length=$($stream.Length) max=$MaxBytes" }
        if ($RequireSingleLink -and (Get-RevAgentBootstrapTrustHardlinkCount -Path $fullPath) -ne 1) { throw "Bootstrap trust file must have exactly one hardlink reference: $fullPath" }
        $length = $stream.Length
        $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '')
        if ($stream.Length -ne $length) { throw "Bootstrap trust file changed size while being hashed: $fullPath" }
        return [pscustomobject][ordered]@{ path = $fullPath; length = $length; sha256 = $hash }
    }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function Resolve-RevAgentBootstrapTrustSnapshotRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$SnapshotRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath) -or $RelativePath -match '(^|[\\/])\.\.([\\/]|$)' -or $RelativePath.IndexOf(':') -ge 0) { throw "Protected snapshot relative path is invalid: $RelativePath" }
    $root = Get-RevAgentBootstrapTrustCanonicalPath -Path $SnapshotRoot
    $resolved = Get-RevAgentBootstrapTrustCanonicalPath -Path (Join-Path $root $RelativePath)
    if (-not (Test-RevAgentBootstrapTrustPathUnderRoot -Path $resolved -Root $root) -or [string]::Equals($resolved, $root, [StringComparison]::OrdinalIgnoreCase)) { throw "Protected snapshot path escaped its root: $RelativePath" }
    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $resolved -StopRoot $root -RequireLeaf)
    return $resolved
}

function Get-RevAgentBootstrapTrustSnapshotComponent {
    param(
        [Parameter(Mandatory = $true)][object]$State,
        [Parameter(Mandatory = $true)][string]$SnapshotRoot,
        [Parameter(Mandatory = $true)][string]$ComponentName,
        [Parameter(Mandatory = $true)][string]$ExpectedPath,
        [switch]$AllowTestRoot
    )

    $property = $State.components.PSObject.Properties[$ComponentName]
    if ($null -eq $property) { throw "Protected release snapshot is missing required component '$ComponentName'." }
    $record = $property.Value
    Assert-RevAgentBootstrapTrustExactProperties -Object $record -Names @('path', 'snapshotRelativePath', 'sha256') -Label "Protected snapshot component '$ComponentName'"
    $normalizedExpected = $ExpectedPath.Replace('/', '\')
    if (-not [string]::Equals(([string]$record.path).Replace('/', '\'), $normalizedExpected, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals(([string]$record.snapshotRelativePath).Replace('/', '\'), ('payload\' + $normalizedExpected), [StringComparison]::OrdinalIgnoreCase) -or
        [string]$record.sha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw "Protected snapshot component '$ComponentName' path/hash contract is invalid." }
    $path = Resolve-RevAgentBootstrapTrustSnapshotRelativePath -SnapshotRoot $SnapshotRoot -RelativePath ([string]$record.snapshotRelativePath)
    $read = Read-RevAgentBootstrapTrustBoundedBytes -Path $path -MaxBytes 33554432 -ExpectedSha256 ([string]$record.sha256) -RequireSingleLink
    [void](Test-RevAgentBootstrapTrustAcl -Path $path -AllowTestRoot:$AllowTestRoot)
    return [pscustomobject][ordered]@{ componentName = $ComponentName; relativePath = $normalizedExpected; path = $path; sha256 = $read.sha256; length = $read.length; bytes = $read.bytes }
}

function Get-RevAgentBootstrapTrustLedger {
    param([Parameter(Mandatory = $true)][object]$Layout, [switch]$AllowTestRoot)

    if (-not [IO.File]::Exists([string]$Layout.highWaterPath)) {
        return [pscustomobject][ordered]@{ schemaVersion = 1; app = 'revAgent'; stateType = 'bootstrap-trust-high-water'; updatedAtUtc = [DateTime]::UtcNow.ToString('o'); highestAcceptedReleaseSequence = 0L; processedNonces = @() }
    }
    $read = Read-RevAgentBootstrapTrustBoundedBytes -Path ([string]$Layout.highWaterPath) -MaxBytes 262144 -RequireSingleLink
    [void](Test-RevAgentBootstrapTrustAcl -Path ([string]$Layout.highWaterPath) -AllowTestRoot:$AllowTestRoot)
    $state = ConvertFrom-RevAgentBootstrapTrustJsonBytes -Bytes $read.bytes -Label 'Bootstrap trust replay/high-water state'
    Assert-RevAgentBootstrapTrustExactProperties -Object $state -Names @('schemaVersion', 'app', 'stateType', 'updatedAtUtc', 'highestAcceptedReleaseSequence', 'processedNonces') -Label 'Bootstrap trust replay/high-water state'
    if ([int]$state.schemaVersion -ne 1 -or [string]$state.app -cne 'revAgent' -or [string]$state.stateType -cne 'bootstrap-trust-high-water' -or [long]$state.highestAcceptedReleaseSequence -lt 0) { throw 'Bootstrap trust replay/high-water state identity/version contract is invalid.' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $records = [Collections.Generic.List[object]]::new()
    foreach ($record in @($state.processedNonces)) {
        Assert-RevAgentBootstrapTrustExactProperties -Object $record -Names @('nonce', 'requesterSid', 'inboxId', 'completedAtUtc', 'state', 'releaseSequence') -Label 'Bootstrap trust processed nonce record'
        if ([string]$record.nonce -cnotmatch '^[a-f0-9]{32}$' -or [string]$record.inboxId -cnotmatch '^[a-f0-9]{32}$' -or [string]$record.state -notin @('succeeded', 'failed') -or [long]$record.releaseSequence -lt 0 -or -not $seen.Add([string]$record.nonce)) { throw 'Bootstrap trust processed nonce record is invalid or duplicated.' }
        try { [void][Security.Principal.SecurityIdentifier]::new([string]$record.requesterSid) }
        catch { throw 'Bootstrap trust processed nonce requester SID is invalid.' }
        $records.Add($record)
    }
    if ($records.Count -gt 128) { throw 'Bootstrap trust replay ledger exceeds its bounded retention policy.' }
    return [pscustomobject][ordered]@{ schemaVersion = 1; app = 'revAgent'; stateType = 'bootstrap-trust-high-water'; updatedAtUtc = [string]$state.updatedAtUtc; highestAcceptedReleaseSequence = [long]$state.highestAcceptedReleaseSequence; processedNonces = @($records.ToArray()) }
}

function Set-RevAgentBootstrapTrustLedger {
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][object]$Ledger,
        [switch]$AllowTestRoot
    )

    $document = [ordered]@{ schemaVersion = 1; app = 'revAgent'; stateType = 'bootstrap-trust-high-water'; updatedAtUtc = [DateTime]::UtcNow.ToString('o'); highestAcceptedReleaseSequence = [long]$Ledger.highestAcceptedReleaseSequence; processedNonces = @($Ledger.processedNonces | Select-Object -Last 128) }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($document | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 8))
    $temporaryPath = Join-Path ([string]$Layout.stateRoot) ('.release-high-water-' + [Guid]::NewGuid().ToString('N') + '.json')
    $backupPath = Join-Path ([string]$Layout.stateRoot) ('.release-high-water-backup-' + [Guid]::NewGuid().ToString('N') + '.json')
    try {
        Write-RevAgentBootstrapTrustFileCreateNew -Path $temporaryPath -Bytes $bytes -AllowTestRoot:$AllowTestRoot
        if ([IO.File]::Exists([string]$Layout.highWaterPath)) {
            [IO.File]::Replace($temporaryPath, [string]$Layout.highWaterPath, $backupPath, $true)
            if ([IO.File]::Exists($backupPath)) { [IO.File]::Delete($backupPath) }
        }
        else { [IO.File]::Move($temporaryPath, [string]$Layout.highWaterPath) }
        [void](Test-RevAgentBootstrapTrustAcl -Path ([string]$Layout.highWaterPath) -AllowTestRoot:$AllowTestRoot)
    }
    finally {
        foreach ($path in @($temporaryPath, $backupPath)) { if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
    }
    return [pscustomobject]$document
}

function Get-RevAgentBootstrapTrustProfileInboxPath {
    param(
        [Parameter(Mandatory = $true)][string]$RequesterSid,
        [Parameter(Mandatory = $true)][string]$InboxId,
        [Parameter(Mandatory = $true)][object]$Layout,
        [string]$ProfileRoot = '',
        [scriptblock]$ProfileResolver = $null,
        [switch]$AllowTestRoot
    )

    if (-not [string]::IsNullOrWhiteSpace($ProfileRoot)) {
        $profilePath = $ProfileRoot
    }
    elseif ($null -ne $ProfileResolver) {
        $resolved = & $ProfileResolver $RequesterSid $Layout
        if ($resolved -is [string]) { $profilePath = [string]$resolved }
        elseif ($null -ne $resolved -and $null -ne $resolved.PSObject.Properties['profileRoot']) { $profilePath = [string]$resolved.profileRoot }
        else { throw 'Bootstrap trust test profile resolver must return only a profile root.' }
    }
    else {
        $registryPath = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$RequesterSid"
        $profilePath = [string](Microsoft.PowerShell.Management\Get-ItemPropertyValue -LiteralPath $registryPath -Name 'ProfileImagePath' -ErrorAction Stop)
        $profilePath = [Environment]::ExpandEnvironmentVariables($profilePath)
    }
    if ([string]::IsNullOrWhiteSpace($profilePath) -or $profilePath.Contains('%') -or -not [IO.Path]::IsPathRooted($profilePath) -or $profilePath.StartsWith('\\')) { throw 'Bootstrap trust requester profile root is not an absolute local path.' }
    $profileRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path $profilePath
    if ($AllowTestRoot) { [void](Assert-RevAgentBootstrapTrustTestRoot -ProgramDataRoot $profileRoot) }
    elseif ([IO.Path]::GetPathRoot($profileRoot) -notmatch '^[A-Za-z]:\\$') { throw 'Bootstrap trust production profile root must be on a local drive.' }
    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $profileRoot)
    $inboxRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path (Join-Path $profileRoot ([string]$Layout.inboxRelativeRoot))
    $inboxPath = Get-RevAgentBootstrapTrustCanonicalPath -Path (Join-Path $inboxRoot $InboxId)
    if (-not (Test-RevAgentBootstrapTrustPathUnderRoot -Path $inboxPath -Root $inboxRoot) -or -not [IO.Directory]::Exists($inboxPath)) { throw 'Bootstrap trust profile-derived authenticated inbox was not found.' }
    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $inboxPath -StopRoot $profileRoot)
    return $inboxPath
}

function Get-RevAgentBootstrapTrustMachineProfiles {
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [scriptblock]$ProfileEnumerator = $null,
        [scriptblock]$ProfileResolver = $null,
        [switch]$AllowTestRoot,
        [ValidateRange(1, 128)][int]$MaxProfiles = 128
    )

    if ($null -ne $ProfileEnumerator) {
        $rawProfiles = @(& $ProfileEnumerator $Layout)
    }
    elseif ($AllowTestRoot -and $null -ne $ProfileResolver) {
        $sid = Get-RevAgentBootstrapTrustCurrentSid
        $resolved = & $ProfileResolver $sid $Layout
        $root = if ($resolved -is [string]) { [string]$resolved } else { [string]$resolved.profileRoot }
        $rawProfiles = @([pscustomobject][ordered]@{ requesterSid = $sid; profileRoot = $root })
    }
    elseif ($AllowTestRoot) {
        throw 'Bootstrap trust test broker requires a bounded profile enumerator or resolver.'
    }
    else {
        $baseKey = $null
        $profileList = $null
        try {
            $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
            $profileList = $baseKey.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList', $false)
            if ($null -eq $profileList) { throw 'Bootstrap trust machine ProfileList registry key was not found.' }
            $subkeys = @($profileList.GetSubKeyNames() | Sort-Object)
            if ($subkeys.Count -gt $MaxProfiles) { throw "Bootstrap trust machine profile inventory exceeds its hard $MaxProfiles-profile cap." }
            $rows = [Collections.Generic.List[object]]::new()
            foreach ($name in $subkeys) {
                try { $sid = Get-RevAgentBootstrapTrustNormalizedSid -Sid ([string]$name) }
                catch { continue }
                $profileKey = $null
                try {
                    $profileKey = $profileList.OpenSubKey([string]$name, $false)
                    if ($null -eq $profileKey) { continue }
                    $value = [string]$profileKey.GetValue('ProfileImagePath', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                    $rows.Add([pscustomobject][ordered]@{ requesterSid = $sid; profileRoot = [Environment]::ExpandEnvironmentVariables($value) })
                }
                finally { if ($null -ne $profileKey) { $profileKey.Dispose() } }
            }
            $rawProfiles = @($rows.ToArray())
        }
        finally {
            if ($null -ne $profileList) { $profileList.Dispose() }
            if ($null -ne $baseKey) { $baseKey.Dispose() }
        }
    }

    if ($rawProfiles.Count -gt $MaxProfiles) { throw "Bootstrap trust machine profile inventory exceeds its hard $MaxProfiles-profile cap." }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $profiles = [Collections.Generic.List[object]]::new()
    foreach ($raw in @($rawProfiles | Sort-Object { [string]$_.requesterSid })) {
        if ($null -eq $raw -or $null -eq $raw.PSObject.Properties['requesterSid'] -or $null -eq $raw.PSObject.Properties['profileRoot']) { throw 'Bootstrap trust profile inventory rows require requesterSid and profileRoot only.' }
        $sid = Get-RevAgentBootstrapTrustNormalizedSid -Sid ([string]$raw.requesterSid)
        if (-not $seen.Add($sid)) { throw "Bootstrap trust profile inventory contains a duplicate SID: $sid" }
        $profileRoot = Get-RevAgentBootstrapTrustProfileRoot -ProfileRoot ([string]$raw.profileRoot) -AllowTestRoot:$AllowTestRoot
        $profiles.Add([pscustomobject][ordered]@{ requesterSid = $sid; profileRoot = $profileRoot })
    }
    return @($profiles.ToArray())
}

function Get-RevAgentBootstrapTrustFailureRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][string]$ExpectedRequesterSid,
        [Parameter(Mandatory = $true)][string]$RequestQueueRoot,
        [switch]$AllowTestRoot
    )

    try {
        $fileName = [IO.Path]::GetFileName($Path)
        $match = [regex]::Match($fileName, '^bootstrap-request-([a-f0-9]{32})\.json$')
        if (-not $match.Success) { return $null }
        if (-not [string]::Equals((Get-RevAgentBootstrapTrustCanonicalPath -Path (Split-Path -Parent $Path)), (Get-RevAgentBootstrapTrustCanonicalPath -Path $RequestQueueRoot), [StringComparison]::OrdinalIgnoreCase)) { return $null }
        $read = Read-RevAgentBootstrapTrustBoundedBytes -Path $Path -MaxBytes 16384 -RequireSingleLink
        $document = ConvertFrom-RevAgentBootstrapTrustJsonBytes -Bytes $read.bytes -Label 'Rejected bootstrap trust request'
        foreach ($name in @('nonce', 'requesterSid', 'inboxId')) { if ($null -eq $document.PSObject.Properties[$name]) { return $null } }
        if ([string]$document.nonce -cne $match.Groups[1].Value -or [string]$document.inboxId -cnotmatch '^[a-f0-9]{32}$') { return $null }
        $sid = [string][Security.Principal.SecurityIdentifier]::new([string]$document.requesterSid).Value
        if (-not [string]::Equals($sid, (Get-RevAgentBootstrapTrustNormalizedSid -Sid $ExpectedRequesterSid), [StringComparison]::OrdinalIgnoreCase)) { return $null }
        $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path -ErrorAction Stop
        $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if (-not [string]::Equals($sid, $owner, [StringComparison]::OrdinalIgnoreCase) -and -not ($AllowTestRoot -and [string]::Equals($owner, (Get-RevAgentBootstrapTrustCurrentSid), [StringComparison]::OrdinalIgnoreCase))) { return $null }
        return [pscustomobject][ordered]@{ nonce = [string]$document.nonce; requesterSid = $sid; inboxId = [string]$document.inboxId; requestQueueRoot = $RequestQueueRoot; requestPath = $Path; resultPath = Get-RevAgentBootstrapTrustResultPath -Layout $Layout -RequesterSid $sid -Nonce ([string]$document.nonce) }
    }
    catch { return $null }
}

function Invoke-RevAgentBootstrapTrustProtectedSnapshotApply {
    param(
        [Parameter(Mandatory = $true)][object]$Snapshot,
        [Parameter(Mandatory = $true)][object]$Evidence,
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][object]$Request,
        [Parameter(Mandatory = $true)][string]$ScratchRoot,
        [switch]$AllowTestRoot
    )

    if ($AllowTestRoot) { throw 'The production bootstrap apply path is not callable through a test root; use the explicit ApplySnapshot test seam.' }
    $scratch = Get-RevAgentBootstrapTrustCanonicalPath -Path $ScratchRoot
    $expectedScratch = Get-RevAgentBootstrapTrustCanonicalPath -Path (Join-Path ([string]$Layout.applyRoot) ("apply-$([string]$Request.nonce)"))
    if (-not [string]::Equals($scratch, $expectedScratch, [StringComparison]::OrdinalIgnoreCase)) { throw 'Machine broker scratch root is not the exact private nonce-derived apply directory.' }
    [void](Test-RevAgentBootstrapTrustSystemOnlyAcl -Path $scratch -Directory)
    $installerPath = Join-Path $scratch 'install-revagent-local-bootstrap.ps1'
    $evidencePath = Join-Path $scratch 'bootstrap-prestage-evidence.json'
    $trustedKeysPath = Join-Path $scratch 'release-trusted-keys.json'
    $installer = Get-RevAgentBootstrapTrustSnapshotComponent -State $Snapshot.state -SnapshotRoot ([string]$Snapshot.snapshotRoot) -ComponentName 'localBootstrapInstaller' -ExpectedPath 'installer\nas\install-revagent-local-bootstrap.ps1'
    Write-RevAgentBootstrapTrustFileCreateNew -Path $installerPath -Bytes $installer.bytes
    $coreKey = Read-RevAgentBootstrapTrustBoundedBytes -Path ([string]$Layout.trustedKeysPath) -MaxBytes 1048576 -RequireSingleLink
    Write-RevAgentBootstrapTrustFileCreateNew -Path $trustedKeysPath -Bytes $coreKey.bytes
    if (-not [string]::Equals([string]$Evidence.outputPath, $evidencePath, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($evidencePath)) { throw 'Machine broker evidence was not generated at the canonical protected path.' }
    [void](Read-RevAgentBootstrapTrustBoundedBytes -Path $evidencePath -MaxBytes 65536 -ExpectedSha256 ([string]$Evidence.outputSha256) -RequireSingleLink)

    $payloadRoot = Join-Path ([string]$Snapshot.snapshotRoot) 'payload'
    $arguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $installerPath,
        '-RepoRoot', $payloadRoot,
        '-ReleaseRoot', $script:RevAgentBootstrapTrustProductionReleaseRoot,
        '-TrustedKeysPath', $trustedKeysPath,
        '-ExpectedHashesPath', $evidencePath,
        '-ProgramDataRoot', ([string]$Layout.programDataRoot),
        '-ConfirmIndependentlyAuthenticatedSource'
    )
    $output = @(& ([string]$Layout.taskPowerShellPath) @arguments 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $message = (@($output | Select-Object -Last 8) -join ' ').Trim()
        if ($message.Length -gt 1024) { $message = $message.Substring(0, 1024) }
        throw "Protected local bootstrap installer failed with exit code $exitCode. $message"
    }
    $bootstrapStatePath = Join-Path (Join-Path ([string]$Layout.productRoot) 'bootstrap') 'bootstrap-state.json'
    $bootstrapState = Read-RevAgentBootstrapTrustBoundedBytes -Path $bootstrapStatePath -MaxBytes 1048576 -RequireSingleLink
    $trustState = Read-RevAgentBootstrapTrustBoundedBytes -Path ([string]$Layout.trustStatePath) -MaxBytes 262144 -RequireSingleLink
    return [pscustomobject][ordered]@{ success = $true; releaseSequence = [long]$Snapshot.releaseSequence; bootstrapStateSha256 = $bootstrapState.sha256; trustStateSha256 = $trustState.sha256; message = 'The independently authenticated local bootstrap was installed by the machine trust broker.' }
}

function Get-RevAgentBootstrapTrustBoundedQueueCandidates {
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [scriptblock]$ProfileEnumerator = $null,
        [scriptblock]$ProfileResolver = $null,
        [switch]$AllowTestRoot,
        [ValidateRange(1, 64)][int]$MaxCandidatesPerProfile = 16,
        [ValidateRange(1, 128)][int]$MaxProfiles = 128
    )

    $profiles = @(Get-RevAgentBootstrapTrustMachineProfiles -Layout $Layout -ProfileEnumerator $ProfileEnumerator -ProfileResolver $ProfileResolver -AllowTestRoot:$AllowTestRoot -MaxProfiles $MaxProfiles)
    $profileQueues = [Collections.Generic.List[object]]::new()
    $truncatedProfileCount = 0
    $unavailableProfileCount = 0
    foreach ($profile in $profiles) {
        $queueRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path (Join-Path ([string]$profile.profileRoot) ([string]$Layout.requestQueueRelativeRoot))
        $profileCandidates = [Collections.Generic.List[object]]::new()
        if ([IO.Directory]::Exists($queueRoot)) {
            try {
                [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $queueRoot -StopRoot ([string]$profile.profileRoot))
                foreach ($path in [IO.Directory]::EnumerateFiles($queueRoot, 'bootstrap-request-*', [IO.SearchOption]::TopDirectoryOnly)) {
                    if ($profileCandidates.Count -ge $MaxCandidatesPerProfile) { $truncatedProfileCount++; break }
                    $fullPath = [IO.Path]::GetFullPath($path)
                    $profileCandidates.Add([pscustomobject][ordered]@{ FullName = $fullPath; Name = [IO.Path]::GetFileName($fullPath); requesterSid = [string]$profile.requesterSid; profileRoot = [string]$profile.profileRoot; requestQueueRoot = $queueRoot })
                }
            }
            catch { $unavailableProfileCount++; $profileCandidates.Clear() }
        }
        $profileQueues.Add([pscustomobject][ordered]@{ requesterSid = [string]$profile.requesterSid; candidates = @($profileCandidates.ToArray()) })
    }
    $paths = [Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $MaxCandidatesPerProfile; $index++) {
        foreach ($profileQueue in $profileQueues) {
            if ($index -lt @($profileQueue.candidates).Count) { $paths.Add($profileQueue.candidates[$index]) }
        }
    }
    return [pscustomobject][ordered]@{
        candidates = @($paths.ToArray())
        candidateCount = $paths.Count
        profileCount = $profiles.Count
        truncated = ($truncatedProfileCount -gt 0)
        truncatedProfileCount = $truncatedProfileCount
        unavailableProfileCount = $unavailableProfileCount
        maxProfiles = $MaxProfiles
        maxCandidatesPerProfile = $MaxCandidatesPerProfile
    }
}

function Remove-RevAgentBootstrapTrustCompletedSnapshot {
    param(
        [Parameter(Mandatory = $true)][object]$Snapshot,
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][Management.Automation.CommandInfo]$SnapshotAssertCommand,
        [switch]$AllowTestRoot
    )

    if ($null -eq $Snapshot.PSObject.Properties['snapshotId'] -or
        $null -eq $Snapshot.PSObject.Properties['snapshotRoot'] -or
        [string]$Snapshot.snapshotId -cnotmatch '^[a-f0-9]{32}$') {
        throw 'Completed bootstrap snapshot identity is invalid for cleanup.'
    }
    $expectedRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path (Join-Path ([string]$Layout.snapshotRoot) ([string]$Snapshot.snapshotId))
    $actualRoot = Get-RevAgentBootstrapTrustCanonicalPath -Path ([string]$Snapshot.snapshotRoot)
    if (-not [string]::Equals($actualRoot, $expectedRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-RevAgentBootstrapTrustPathUnderRoot -Path $actualRoot -Root ([string]$Layout.snapshotRoot))) {
        throw 'Completed bootstrap snapshot cleanup path is not the exact nonce-derived child.'
    }
    if (-not [IO.Directory]::Exists($actualRoot)) { return $false }
    [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $actualRoot -StopRoot ([string]$Layout.snapshotRoot))
    [void](& $SnapshotAssertCommand -SnapshotRoot $actualRoot -AllowTestRoot:$AllowTestRoot -SystemOnlySnapshot)
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $actualRoot -Recurse -Force -ErrorAction Stop
    if ([IO.Directory]::Exists($actualRoot)) { throw "Completed bootstrap snapshot cleanup was incomplete: $actualRoot" }
    return $true
}

function Invoke-RevAgentBootstrapTrustSnapshotPreflight {
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][Management.Automation.CommandInfo]$SystemOnlySnapshotTestCommand,
        [switch]$AllowTestRoot,
        [ValidateRange(1, 32)][int]$MaxArtifacts = 16
    )

    [void](Test-RevAgentBootstrapTrustSystemOnlyAcl -Path ([string]$Layout.snapshotRoot) -Directory -AllowTestRoot:$AllowTestRoot)
    foreach ($file in [IO.Directory]::EnumerateFiles([string]$Layout.snapshotRoot, '*', [IO.SearchOption]::TopDirectoryOnly)) {
        throw "Bootstrap trust snapshot root contains an unexpected file: $file"
    }
    $artifacts = [Collections.Generic.List[string]]::new()
    foreach ($directory in [IO.Directory]::EnumerateDirectories([string]$Layout.snapshotRoot, '*', [IO.SearchOption]::TopDirectoryOnly)) {
        if ($artifacts.Count -ge $MaxArtifacts) { throw "Bootstrap trust system-only snapshot root exceeds its hard $MaxArtifacts-artifact cap." }
        $artifacts.Add([IO.Path]::GetFullPath($directory))
    }
    $removed = 0
    foreach ($path in $artifacts) {
        $name = [IO.Path]::GetFileName($path)
        [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $path -StopRoot ([string]$Layout.snapshotRoot))
        if ($name -cmatch '^\.bootstrap-trust-stage-[a-f0-9]{32}$') {
            [void](Test-RevAgentBootstrapTrustSystemOnlyAcl -Path $path -Directory -AllowTestRoot:$AllowTestRoot)
        }
        elseif ($name -cmatch '^[a-f0-9]{32}$') {
            if (-not [bool](& $SystemOnlySnapshotTestCommand -SnapshotRoot $path -AllowTestRoot:$AllowTestRoot)) { throw "Bootstrap trust snapshot root contains a non-attested final snapshot: $path" }
        }
        else { throw "Bootstrap trust snapshot root contains an unexpected directory: $path" }
        Microsoft.PowerShell.Management\Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
        if ([IO.Directory]::Exists($path)) { throw "Bootstrap trust snapshot preflight cleanup was incomplete: $path" }
        $removed++
    }
    return [pscustomobject][ordered]@{ scanned = $artifacts.Count; removed = $removed; retained = 0; hardLimit = $MaxArtifacts }
}

function Invoke-RevAgentBootstrapTrustApplyPreflight {
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [switch]$AllowTestRoot,
        [ValidateRange(1, 32)][int]$MaxArtifacts = 16
    )

    [void](Test-RevAgentBootstrapTrustSystemOnlyAcl -Path ([string]$Layout.applyRoot) -Directory -AllowTestRoot:$AllowTestRoot)
    foreach ($file in [IO.Directory]::EnumerateFiles([string]$Layout.applyRoot, '*', [IO.SearchOption]::TopDirectoryOnly)) { throw "Bootstrap trust apply root contains an unexpected file: $file" }
    $artifacts = [Collections.Generic.List[string]]::new()
    foreach ($directory in [IO.Directory]::EnumerateDirectories([string]$Layout.applyRoot, '*', [IO.SearchOption]::TopDirectoryOnly)) {
        if ($artifacts.Count -ge $MaxArtifacts) { throw "Bootstrap trust private apply root exceeds its hard $MaxArtifacts-artifact cap." }
        $path = [IO.Path]::GetFullPath($directory)
        if ([IO.Path]::GetFileName($path) -cnotmatch '^apply-[a-f0-9]{32}$') { throw "Bootstrap trust apply root contains an unexpected directory: $path" }
        [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $path -StopRoot ([string]$Layout.applyRoot))
        [void](Test-RevAgentBootstrapTrustSystemOnlyAcl -Path $path -Directory -AllowTestRoot:$AllowTestRoot)
        $artifacts.Add($path)
    }
    foreach ($path in $artifacts) {
        Microsoft.PowerShell.Management\Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
        if ([IO.Directory]::Exists($path)) { throw "Bootstrap trust private apply preflight cleanup was incomplete: $path" }
    }
    return [pscustomobject][ordered]@{ scanned = $artifacts.Count; removed = $artifacts.Count; retained = 0; hardLimit = $MaxArtifacts }
}

function Invoke-RevAgentBootstrapTrustResultRetention {
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [switch]$AllowTestRoot,
        [ValidateRange(1, 128)][int]$MaxBuckets = 128,
        [ValidateRange(16, 2048)][int]$MaxResultFiles = 2048
    )

    foreach ($file in [IO.Directory]::EnumerateFiles([string]$Layout.resultsRoot, '*', [IO.SearchOption]::TopDirectoryOnly)) {
        throw "Bootstrap trust result root contains an unexpected top-level file: $file"
    }
    $buckets = [Collections.Generic.List[object]]::new()
    foreach ($directory in [IO.Directory]::EnumerateDirectories([string]$Layout.resultsRoot, '*', [IO.SearchOption]::TopDirectoryOnly)) {
        if ($buckets.Count -ge $MaxBuckets) { throw "Bootstrap trust result root exceeds its hard $MaxBuckets-principal cap." }
        $name = [IO.Path]::GetFileName($directory)
        $match = [regex]::Match($name, '^principal-(S-1-[0-9]+(?:-[0-9]+)+)$')
        if (-not $match.Success) { throw "Bootstrap trust result root contains an invalid principal bucket: $directory" }
        $sid = Get-RevAgentBootstrapTrustNormalizedSid -Sid $match.Groups[1].Value
        $expected = Get-RevAgentBootstrapTrustResultBucketPath -Layout $Layout -RequesterSid $sid
        if (-not [string]::Equals((Get-RevAgentBootstrapTrustCanonicalPath -Path $directory), (Get-RevAgentBootstrapTrustCanonicalPath -Path $expected), [StringComparison]::OrdinalIgnoreCase)) { throw "Bootstrap trust result principal bucket path is not canonical: $directory" }
        $buckets.Add((Get-RevAgentBootstrapTrustResultBucket -Layout $Layout -RequesterSid $sid -AllowTestRoot:$AllowTestRoot))
    }
    $seen = 0
    $removed = 0
    $pinned = 0
    $blockedBuckets = 0
    foreach ($bucket in $buckets) {
        $retention = Invoke-RevAgentBootstrapTrustResultBucketRetention -Layout $Layout -Bucket $bucket -AllowTestRoot:$AllowTestRoot
        $seen += [int]$retention.retained + [int]$retention.removed
        $removed += [int]$retention.removed
        $pinned += [int]$retention.pinned
        if ([bool]$retention.blocked) { $blockedBuckets++ }
        if (($seen - $removed) -gt $MaxResultFiles) { throw 'Bootstrap trust result retention exceeded its global protected-file hard cap.' }
    }
    return [pscustomobject][ordered]@{ retained = ($seen - $removed); removed = $removed; pinned = $pinned; hardLimit = $MaxResultFiles; perPrincipalHardLimit = 16; bucketCount = $buckets.Count; blockedBucketCount = $blockedBuckets; scanned = $seen }
}

function Invoke-RevAgentBootstrapTrustBrokerQueue {
    [CmdletBinding()]
    param(
        [string]$ProgramDataRoot = '',
        [switch]$AllowTestRoot,
        [scriptblock]$TaskProvider = $null,
        [scriptblock]$ProfileEnumerator = $null,
        [scriptblock]$ProfileResolver = $null,
        [scriptblock]$ApplySnapshot = $null,
        [int]$MaxRequests = 16
    )

    if (($null -ne $TaskProvider -or $null -ne $ProfileEnumerator -or $null -ne $ProfileResolver -or $null -ne $ApplySnapshot) -and -not $AllowTestRoot) { throw 'Bootstrap trust broker test seams are available only with a disposable TEMP test root.' }
    if ($MaxRequests -lt 1 -or $MaxRequests -gt 64) { throw 'Bootstrap trust broker MaxRequests must be between 1 and 64.' }
    if (-not $AllowTestRoot -and -not [string]::Equals((Get-RevAgentBootstrapTrustCurrentSid), 'S-1-5-18', [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap trust broker must run as LocalSystem.' }
    $layout = Get-RevAgentBootstrapTrustLayout -ProgramDataRoot $ProgramDataRoot -AllowTestRoot:$AllowTestRoot

    $brokerLockStream = $null
    $releaseSnapshotModule = $null
    try {
        try {
            # The file is SYSTEM/Administrators-only. Read sharing permits the
            # broker's own identity/ACL attestation while another ReadWrite
            # broker handle remains excluded.
            $brokerLockStream = [IO.File]::Open([string]$layout.brokerLockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        }
        catch [IO.FileNotFoundException] { throw }
        catch [IO.DirectoryNotFoundException] { throw }
        catch [IO.IOException] {
            return [pscustomobject][ordered]@{ success = $true; action = 'bootstrap-trust-broker-queue'; state = 'busy'; processed = 0; succeeded = 0; failed = 0; rejected = 0; replayed = 0; highestAcceptedReleaseSequence = 0L }
        }
        if ($brokerLockStream.Length -ne 1) { throw 'Bootstrap trust broker lock file identity length is invalid.' }
        $brokerLockStream.Position = 0
        if ($brokerLockStream.ReadByte() -ne 0x52) { throw 'Bootstrap trust broker lock file identity byte is invalid.' }
        $brokerLockStream.Position = 0
        [void](Assert-RevAgentBootstrapTrustPathNoLinks -Path $layout.brokerLockPath -RequireLeaf)
        Initialize-RevAgentBootstrapTrustNativeFileInformation
        if ([int][RevAgentBootstrapTrust.NativeFileInformation]::GetLinkCount($brokerLockStream.SafeFileHandle) -ne 1) { throw 'Bootstrap trust broker lock must have exactly one hardlink.' }
        [void](Test-RevAgentBootstrapTrustSystemOnlyAcl -Path $layout.brokerLockPath -SkipHardlinkCheck -AllowTestRoot:$AllowTestRoot)
        $health = Test-RevAgentBootstrapTrustHealth -ProgramDataRoot $ProgramDataRoot -AllowTestRoot:$AllowTestRoot -TaskProvider $TaskProvider
        if (-not [bool]$health.healthy) { throw "Bootstrap trust core health check failed closed: $($health.reason)" }

        $ledger = Get-RevAgentBootstrapTrustLedger -Layout $layout -AllowTestRoot:$AllowTestRoot
        $trustStateRead = Read-RevAgentBootstrapTrustBoundedBytes -Path ([string]$layout.trustStatePath) -MaxBytes 262144 -RequireSingleLink
        $trustState = ConvertFrom-RevAgentBootstrapTrustJsonBytes -Bytes $trustStateRead.bytes -Label 'Bootstrap trust state'
        $highestAccepted = [Math]::Max([long]$ledger.highestAcceptedReleaseSequence, [Math]::Max([long]$trustState.release.releaseSequence, [long]$trustState.release.highestAcceptedReleaseSequence))
        $ledger.highestAcceptedReleaseSequence = $highestAccepted
        $processedSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($record in @($ledger.processedNonces)) { [void]$processedSet.Add([string]$record.nonce) }

        $releaseSnapshotModule = Microsoft.PowerShell.Core\Import-Module -Name ([string]$layout.releaseSnapshotModulePath) -Force -PassThru -ErrorAction Stop
        $snapshotCommand = Get-Command ("{0}\New-RevAgentProtectedReleaseSnapshot" -f $releaseSnapshotModule.Name) -ErrorAction Stop
        $snapshotAssertCommand = Get-Command ("{0}\Assert-RevAgentProtectedReleaseSnapshot" -f $releaseSnapshotModule.Name) -ErrorAction Stop
        $snapshotTestCommand = Get-Command ("{0}\Test-RevAgentSystemOnlyReleaseSnapshot" -f $releaseSnapshotModule.Name) -ErrorAction Stop
        $snapshotPreflight = Invoke-RevAgentBootstrapTrustSnapshotPreflight -Layout $layout -SystemOnlySnapshotTestCommand $snapshotTestCommand -AllowTestRoot:$AllowTestRoot
        $applyPreflight = Invoke-RevAgentBootstrapTrustApplyPreflight -Layout $layout -AllowTestRoot:$AllowTestRoot
        $resultPreflight = Invoke-RevAgentBootstrapTrustResultRetention -Layout $layout -AllowTestRoot:$AllowTestRoot
        $queueScan = Get-RevAgentBootstrapTrustBoundedQueueCandidates -Layout $layout -ProfileEnumerator $ProfileEnumerator -ProfileResolver $ProfileResolver -AllowTestRoot:$AllowTestRoot
        $requests = @($queueScan.candidates)
        $perOwnerTerminalized = [Collections.Generic.Dictionary[string, int]]::new([StringComparer]::OrdinalIgnoreCase)
        $processed = 0; $handled = 0; $succeeded = 0; $failed = 0; $rejected = 0; $replayed = 0
        $diagnostics = [Collections.Generic.List[string]]::new()
        foreach ($requestFile in $requests) {
            if ($handled -ge $MaxRequests) { break }
            $profileSid = [string]$requestFile.requesterSid
            $ownerTerminalized = if ($perOwnerTerminalized.ContainsKey($profileSid)) { [int]$perOwnerTerminalized[$profileSid] } else { 0 }
            if ($ownerTerminalized -ge 2) { continue }
            $request = $null
            $snapshot = $null
            $scratchRoot = ''
            $releaseSequence = 0L
            $state = 'failed'
            try {
                try { $request = Get-RevAgentBootstrapTrustRequestContract -Path $requestFile.FullName -Layout $layout -ExpectedRequesterSid $profileSid -RequestQueueRoot ([string]$requestFile.requestQueueRoot) -AllowTestRoot:$AllowTestRoot }
                catch {
                    $contractError = $_.Exception.Message
                    if ($diagnostics.Count -lt 8) { $diagnostics.Add($contractError.Substring(0, [Math]::Min(512, $contractError.Length))) }
                    $request = Get-RevAgentBootstrapTrustFailureRequest -Path $requestFile.FullName -Layout $layout -ExpectedRequesterSid $profileSid -RequestQueueRoot ([string]$requestFile.requestQueueRoot) -AllowTestRoot:$AllowTestRoot
                    if ($null -ne $request -and -not [IO.File]::Exists([string]$request.resultPath)) {
                        $handled++; $perOwnerTerminalized[$profileSid] = $ownerTerminalized + 1
                        [void](Write-RevAgentBootstrapTrustResult -Request $request -Layout $layout -State failed -ExitCode 85 -Message ("Bootstrap trust request was rejected: " + $contractError) -AllowTestRoot:$AllowTestRoot)
                    }
                    $rejected++; continue
                }
                if ($processedSet.Contains([string]$request.nonce)) { $replayed++; continue }
                if ([IO.File]::Exists([string]$request.resultPath)) {
                    $existingResult = Read-RevAgentBootstrapTrustResult -Request $request -Layout $layout -AllowTestRoot:$AllowTestRoot
                    $releaseSequence = [long]$existingResult.releaseSequence
                    $state = [string]$existingResult.state
                    $highestAccepted = [Math]::Max($highestAccepted, $releaseSequence)
                    $ledger.highestAcceptedReleaseSequence = $highestAccepted
                    $replayed++
                    continue
                }
                $handled++; $perOwnerTerminalized[$profileSid] = $ownerTerminalized + 1
                $processed++
                # Reserve/create the requester's protected result bucket before
                # snapshot acquisition or any privileged apply. A full global
                # principal set therefore rejects a new SID without applying a
                # release that the caller could never observe as completed.
                [void](Assert-RevAgentBootstrapTrustResultWriteCapacity -Layout $layout -RequesterSid ([string]$request.requesterSid) -AllowTestRoot:$AllowTestRoot)
                $inboxPath = Get-RevAgentBootstrapTrustProfileInboxPath -RequesterSid ([string]$request.requesterSid) -InboxId ([string]$request.inboxId) -Layout $layout -ProfileRoot ([string]$requestFile.profileRoot) -AllowTestRoot:$AllowTestRoot
                $snapshotArguments = @{
                    InboxPath = $inboxPath
                    TrustedKeysPath = [string]$layout.trustedKeysPath
                    IntegrityModulePath = [string]$layout.distributionIntegrityModulePath
                    SnapshotParent = [string]$layout.snapshotRoot
                    Channel = 'stable'
                    HighestAcceptedReleaseSequence = $highestAccepted
                    AllowTestRoot = [bool]$AllowTestRoot
                    SystemOnlySnapshot = $true
                }
                if (-not $AllowTestRoot) { $snapshotArguments.ExpectedNodeMsiSha256 = 'FD8BA3E8262738959CAD50E6F6E71D689EAB7DD09FC7231B51D78ABE7852D4EC' }
                $snapshot = & $snapshotCommand @snapshotArguments
                if (-not [bool]$snapshot.success -or [long]$snapshot.releaseSequence -le 0) { throw 'Protected release snapshot did not return positive authenticated evidence.' }
                $releaseSequence = [long]$snapshot.releaseSequence
                $highestAccepted = [Math]::Max($highestAccepted, $releaseSequence)
                $ledger.highestAcceptedReleaseSequence = $highestAccepted
                $ledger = Set-RevAgentBootstrapTrustLedger -Layout $layout -Ledger $ledger -AllowTestRoot:$AllowTestRoot

                $scratchRoot = Join-Path ([string]$layout.applyRoot) ("apply-$([string]$request.nonce)")
                [void](New-RevAgentBootstrapTrustProtectedDirectory -Path $scratchRoot -Kind system-only -AllowTestRoot:$AllowTestRoot)
                $evidencePath = Join-Path $scratchRoot 'bootstrap-prestage-evidence.json'
                $releaseIdentity = if ($AllowTestRoot) { [string]$trustState.release.root } else { $script:RevAgentBootstrapTrustProductionReleaseRoot }
                $evidence = New-RevAgentMachineTrustBrokerEvidence -SnapshotStatePath ([string]$snapshot.statePath) -OutputPath $evidencePath -ReleaseRoot $releaseIdentity -AllowTestRoot:$AllowTestRoot
                $applyResult = if ($null -ne $ApplySnapshot) { & $ApplySnapshot $snapshot $evidence $request $layout } else { Invoke-RevAgentBootstrapTrustProtectedSnapshotApply -Snapshot $snapshot -Evidence $evidence -Layout $layout -Request $request -ScratchRoot $scratchRoot -AllowTestRoot:$AllowTestRoot }
                if ($null -eq $applyResult -or -not [bool]$applyResult.success -or [long]$applyResult.releaseSequence -ne $releaseSequence -or [string]$applyResult.bootstrapStateSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or [string]$applyResult.trustStateSha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Bootstrap trust apply result did not satisfy the verified state/hash contract.' }
                [void](Write-RevAgentBootstrapTrustResult -Request $request -Layout $layout -State succeeded -ExitCode 0 -Message ([string]$applyResult.message) -ReleaseSequence $releaseSequence -BootstrapStateSha256 ([string]$applyResult.bootstrapStateSha256) -TrustStateSha256 ([string]$applyResult.trustStateSha256) -AllowTestRoot:$AllowTestRoot)
                $state = 'succeeded'; $succeeded++
            }
            catch {
                $failed++
                if ($null -ne $request -and -not [IO.File]::Exists([string]$request.resultPath)) {
                    $failureMessage = $_.Exception.Message
                    if ($failureMessage.Length -gt 2048) { $failureMessage = $failureMessage.Substring(0, 2048) }
                    try { [void](Write-RevAgentBootstrapTrustResult -Request $request -Layout $layout -State failed -ExitCode 85 -Message $failureMessage -ReleaseSequence $releaseSequence -AllowTestRoot:$AllowTestRoot) }
                    catch { }
                }
            }
            finally {
                if ($null -ne $request) {
                    if (-not $processedSet.Contains([string]$request.nonce)) {
                        $ledger.processedNonces = @($ledger.processedNonces) + @([pscustomobject][ordered]@{ nonce = [string]$request.nonce; requesterSid = [string]$request.requesterSid; inboxId = [string]$request.inboxId; completedAtUtc = [DateTime]::UtcNow.ToString('o'); state = $state; releaseSequence = $releaseSequence })
                        [void]$processedSet.Add([string]$request.nonce)
                        $ledger = Set-RevAgentBootstrapTrustLedger -Layout $layout -Ledger $ledger -AllowTestRoot:$AllowTestRoot
                    }
                }
                if ([IO.File]::Exists($requestFile.FullName)) { try { [IO.File]::Delete($requestFile.FullName) } catch { } }
                if ($null -ne $snapshot) {
                    [void](Remove-RevAgentBootstrapTrustCompletedSnapshot -Snapshot $snapshot -Layout $layout -SnapshotAssertCommand $snapshotAssertCommand -AllowTestRoot:$AllowTestRoot)
                }
                if (-not [string]::IsNullOrWhiteSpace($scratchRoot) -and [IO.Directory]::Exists($scratchRoot)) {
                    try { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $scratchRoot -Recurse -Force -ErrorAction Stop }
                    catch { }
                }
            }
        }
        if ($requests.Count -eq 0 -or $processed -eq 0) { $ledger.highestAcceptedReleaseSequence = $highestAccepted; $ledger = Set-RevAgentBootstrapTrustLedger -Layout $layout -Ledger $ledger -AllowTestRoot:$AllowTestRoot }
        $resultRetention = Invoke-RevAgentBootstrapTrustResultRetention -Layout $layout -AllowTestRoot:$AllowTestRoot
        return [pscustomobject][ordered]@{ success = $true; action = 'bootstrap-trust-broker-queue'; state = 'completed'; processed = $processed; handled = $handled; succeeded = $succeeded; failed = $failed; rejected = $rejected; replayed = $replayed; highestAcceptedReleaseSequence = [long]$highestAccepted; queueScan = $queueScan; snapshotPreflight = $snapshotPreflight; applyPreflight = $applyPreflight; resultPreflight = $resultPreflight; resultRetention = $resultRetention; diagnostics = @($diagnostics.ToArray()) }
    }
    finally {
        if ($null -ne $releaseSnapshotModule) { Microsoft.PowerShell.Core\Remove-Module -ModuleInfo $releaseSnapshotModule -Force -ErrorAction SilentlyContinue }
        if ($null -ne $brokerLockStream) { $brokerLockStream.Dispose() }
    }
}

Export-ModuleMember -Function `
    Get-RevAgentBootstrapTrustLayout, `
    Assert-RevAgentBootstrapTrustedKeySet, `
    Test-RevAgentBootstrapTrustHealth, `
    Install-RevAgentBootstrapTrustCore, `
    New-RevAgentBootstrapTrustRequest, `
    Start-RevAgentBootstrapTrustBrokerTask, `
    Wait-RevAgentBootstrapTrustResult, `
    Remove-RevAgentBootstrapTrustClientArtifacts, `
    New-RevAgentMachineTrustBrokerEvidence, `
    Invoke-RevAgentBootstrapTrustBrokerQueue
