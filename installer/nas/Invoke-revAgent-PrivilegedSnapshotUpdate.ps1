<#
.SYNOPSIS
    Promote an authenticated user inbox into a protected local release snapshot.

.DESCRIPTION
    This is the only supported UAC entrypoint for mutable NAS release transport.
    It must be independently prestaged below the administrator-owned revAgent
    bootstrap root. It never executes code from UNC or from the user inbox.
    The broker independently verifies the signed channel, release manifest,
    package ZIP, anti-rollback sequence, and pinned external Node MSI before it
    promotes a Users-RX / administrators-write snapshot and launches the exact
    machine-phase entrypoint from that snapshot.

    TargetArgumentsBase64 is UTF-8 Base64 JSON containing only arguments for the
    selected target script. The broker owns -File, -ChannelManifestPath,
    -MachinePhaseOnly, and -PhaseResultPath; callers must not provide them.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('updater', 'updaterTaskInstaller')]
    [string]$Target,

    [Parameter(Mandatory = $true)]
    [ValidateSet('stable', 'pilot')]
    [string]$Channel,

    [Parameter(Mandatory = $true)]
    [string]$InboxPath,

    [string]$TargetArgumentsBase64 = '',

    [string]$PhaseResultPath = '',

    [string]$TargetInteractiveUserSid = '',

    [string]$TargetUserProfileRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$systemDirectory = [Environment]::SystemDirectory
$trustedModuleRoots = @((Join-Path $PSHOME 'Modules'), (Join-Path $systemDirectory 'WindowsPowerShell\v1.0\Modules')) |
    Where-Object { [IO.Directory]::Exists($_) } |
    Select-Object -Unique
$env:PSModulePath = [string]::Join([IO.Path]::PathSeparator, [string[]]$trustedModuleRoots)
foreach ($moduleName in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    $manifest = [IO.Path]::Combine($PSHOME, 'Modules', $moduleName, ($moduleName + '.psd1'))
    if (-not [IO.File]::Exists($manifest)) { throw "Required trusted PowerShell module was not found: $manifest" }
    Microsoft.PowerShell.Core\Import-Module -Name $manifest -Force -ErrorAction Stop
}

function Test-RevAgentBrokerPathUnderRoot {
    param([string]$Path, [string]$Root)
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    return [string]::Equals($fullPath, $fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-RevAgentBrokerNoLinks {
    param([string]$Path, [string]$StopRoot = '')
    $cursor = [IO.Path]::GetFullPath($Path)
    $stop = if ([string]::IsNullOrWhiteSpace($StopRoot)) { '' } else { [IO.Path]::GetFullPath($StopRoot).TrimEnd('\') }
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (-not (Test-Path -LiteralPath $cursor)) { throw "Broker path is missing: $cursor" }
        $item = Get-Item -LiteralPath $cursor -Force
        $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) { throw "Broker path contains a filesystem link: $cursor" }
        if (-not [string]::IsNullOrWhiteSpace($stop) -and [string]::Equals($cursor.TrimEnd('\'), $stop, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Assert-RevAgentBrokerProtectedPath {
    param([string]$Path, [string]$Root)
    if (-not (Test-RevAgentBrokerPathUnderRoot -Path $Path -Root $Root)) { throw "Broker protected path escaped bootstrap root: $Path" }
    Assert-RevAgentBrokerNoLinks -Path $Path -StopRoot $Root
    $cursor = [IO.Path]::GetFullPath($Path)
    $rootFullPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $trustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    while (Test-RevAgentBrokerPathUnderRoot -Path $cursor -Root $rootFullPath) {
        $acl = Get-Acl -LiteralPath $cursor
        $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($trustedOwners -notcontains $ownerSid) { throw "Broker path has an untrusted owner. path=$cursor owner=$ownerSid" }
        if ([string]::Equals($cursor.TrimEnd('\'), $rootFullPath, [StringComparison]::OrdinalIgnoreCase) -and -not $acl.AreAccessRulesProtected) {
            throw "Broker protected root DACL must be protected from inheritance: $cursor"
        }
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            $sid = [string]$rule.IdentityReference.Value
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $trustedOwners -notcontains $sid -and (($rule.FileSystemRights -band $writeMask) -ne 0)) {
                throw "Broker path grants write/delete/ACL capability to an untrusted principal. path=$cursor principal=$sid"
            }
        }
        if ([string]::Equals($cursor.TrimEnd('\'), $rootFullPath, [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $fsutilPath = Join-Path ([Environment]::SystemDirectory) 'fsutil.exe'
        $links = @(& $fsutilPath hardlink list ([IO.Path]::GetFullPath($Path)) 2>&1 | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($LASTEXITCODE -ne 0 -or $links.Count -ne 1) {
            throw "Broker protected file must have exactly one hardlink reference: $Path"
        }
    }
}

function New-RevAgentBrokerProtectedFileSecurity {
    $security = [Security.AccessControl.FileSecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($entry in @(
            [pscustomobject]@{ Sid = 'S-1-5-18'; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
            [pscustomobject]@{ Sid = 'S-1-5-32-544'; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
            [pscustomobject]@{ Sid = 'S-1-5-32-545'; Rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
        )) {
        [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new([string]$entry.Sid),
                [Security.AccessControl.FileSystemRights]$entry.Rights,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    return $security
}

function New-RevAgentBrokerProtectedDirectorySecurity {
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($entry in @(
            [pscustomobject]@{ Sid = 'S-1-5-18'; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
            [pscustomobject]@{ Sid = 'S-1-5-32-544'; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
            [pscustomobject]@{ Sid = 'S-1-5-32-545'; Rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
        )) {
        [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new([string]$entry.Sid),
                [Security.AccessControl.FileSystemRights]$entry.Rights,
                $inheritance,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    return $security
}

function Write-RevAgentBrokerProtectedFileCreateNew {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][byte[]]$Bytes)
    $stream = $null
    try {
        $stream = [IO.FileStream]::new(
            [IO.Path]::GetFullPath($Path),
            [IO.FileMode]::CreateNew,
            [Security.AccessControl.FileSystemRights]::Write,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough,
            (New-RevAgentBrokerProtectedFileSecurity))
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Initialize-RevAgentBrokerProtectedDirectory {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Parent)
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
    if (-not (Test-RevAgentBrokerPathUnderRoot -Path $fullPath -Root $fullParent) -or
        [string]::Equals($fullPath, $fullParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Protected broker directory must be one exact child of its parent: $fullPath"
    }
    Assert-RevAgentBrokerProtectedPath -Path $fullParent -Root $fullParent
    if (-not [IO.Directory]::Exists($fullPath)) {
        [void]([IO.DirectoryInfo]::new($fullParent).CreateSubdirectory((Split-Path -Leaf $fullPath), (New-RevAgentBrokerProtectedDirectorySecurity)))
    }
    Assert-RevAgentBrokerProtectedPath -Path $fullPath -Root $fullParent
    return $fullPath
}

function Write-RevAgentBrokerHighWaterLedger {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][long]$ReleaseSequence,
        [Parameter(Mandatory = $true)][object]$Snapshot
    )
    if ($ReleaseSequence -le 0) { throw 'Broker high-water ledger requires a positive release sequence.' }
    $parent = Split-Path -Parent $Path
    $tempPath = Join-Path $parent ('.release-high-water-{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
    $backupPath = Join-Path $parent ('.release-high-water-{0}.bak' -f [Guid]::NewGuid().ToString('N'))
    $ledger = [ordered]@{
        schemaVersion = 1
        app = 'revAgent'
        stateType = 'broker-release-high-water'
        highestAcceptedReleaseSequence = $ReleaseSequence
        snapshotId = [string]$Snapshot.snapshotId
        version = [string]$Snapshot.state.release.version
        channel = [string]$Snapshot.state.release.channel
        channelManifestSha256 = [string]$Snapshot.state.release.channelManifestSha256
        acceptedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($ledger | ConvertTo-Json -Depth 8))
    try {
        Write-RevAgentBrokerProtectedFileCreateNew -Path $tempPath -Bytes $bytes
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            Assert-RevAgentBrokerProtectedPath -Path $Path -Root $parent
            [IO.File]::Replace($tempPath, $Path, $backupPath, $true)
        }
        else {
            [IO.File]::Move($tempPath, $Path)
        }
    }
    finally {
        foreach ($cleanupPath in @($tempPath, $backupPath)) {
            if (Test-Path -LiteralPath $cleanupPath -PathType Leaf) { [IO.File]::Delete($cleanupPath) }
        }
    }
    Assert-RevAgentBrokerProtectedPath -Path $Path -Root $parent
}

function Invoke-RevAgentBrokerSnapshotRetention {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$CurrentSnapshotRoot,
        [int]$RetainNewest = 3,
        [int]$MinimumAgeDays = 7,
        [int]$MaxPrunePerRun = 8
    )
    $removed = [Collections.Generic.List[string]]::new()
    if (-not (Test-Path -LiteralPath $Parent -PathType Container)) {
        return [pscustomobject][ordered]@{ policy = 'newest-and-age'; retainedNewest = $RetainNewest; minimumAgeDays = $MinimumAgeDays; removed = @() }
    }
    $current = [IO.Path]::GetFullPath($CurrentSnapshotRoot).TrimEnd('\')
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($directory in Get-ChildItem -LiteralPath $Parent -Directory -Force -ErrorAction Stop) {
        if ($directory.Name -notmatch '^[a-f0-9]{32}$') { continue }
        $statePath = Join-Path $directory.FullName 'snapshot-state.json'
        if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { continue }
        Assert-RevAgentBrokerProtectedPath -Path $statePath -Root $Parent
        $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        $createdAt = [DateTime]::MinValue
        if (-not [DateTime]::TryParse([string]$state.createdAtUtc, [ref]$createdAt)) { continue }
        $rows.Add([pscustomobject]@{ path = [IO.Path]::GetFullPath($directory.FullName).TrimEnd('\'); createdAtUtc = $createdAt.ToUniversalTime() })
    }
    $ordered = @($rows.ToArray() | Sort-Object createdAtUtc -Descending)
    $keep = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [void]$keep.Add($current)
    foreach ($row in @($ordered | Select-Object -First ([Math]::Max(1, $RetainNewest)))) { [void]$keep.Add([string]$row.path) }
    $cutoff = [DateTime]::UtcNow.AddDays(-[Math]::Max(1, $MinimumAgeDays))
    foreach ($row in $ordered) {
        if ($removed.Count -ge $MaxPrunePerRun) { break }
        if ($keep.Contains([string]$row.path) -or [DateTime]$row.createdAtUtc -gt $cutoff) { continue }
        [void](Assert-RevAgentProtectedReleaseSnapshot -SnapshotRoot ([string]$row.path))
        Assert-RevAgentBrokerProtectedPath -Path ([string]$row.path) -Root $Parent
        Remove-Item -LiteralPath ([string]$row.path) -Recurse -Force -ErrorAction Stop
        if (Test-Path -LiteralPath ([string]$row.path)) { throw "Protected snapshot retention cleanup was incomplete: $($row.path)" }
        $removed.Add([string]$row.path)
    }
    return [pscustomobject][ordered]@{
        policy = 'newest-and-age'
        retainedNewest = $RetainNewest
        minimumAgeDays = $MinimumAgeDays
        maxPrunePerRun = $MaxPrunePerRun
        removed = @($removed.ToArray())
    }
}

function ConvertFrom-RevAgentBrokerArguments {
    param([string]$Encoded)
    if ([string]::IsNullOrWhiteSpace($Encoded)) { return @() }
    try {
        $json = [Text.UTF8Encoding]::new($false, $true).GetString([Convert]::FromBase64String($Encoded))
        $decoded = $json | ConvertFrom-Json
    }
    catch { throw "TargetArgumentsBase64 is not valid Base64 UTF-8 JSON: $($_.Exception.Message)" }
    $arguments = @($decoded | ForEach-Object { [string]$_ })
    if ($arguments.Count -gt 128) { throw 'Too many broker target arguments.' }
    foreach ($argument in $arguments) {
        if ($argument.IndexOf([char]0) -ge 0 -or $argument.Contains("`r") -or $argument.Contains("`n")) { throw 'Broker target arguments cannot contain NUL or line breaks.' }
    }
    return $arguments
}

function Assert-RevAgentBrokerTargetArguments {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$TargetName,
        [Parameter(Mandatory = $true)][string]$CanonicalInstallRoot,
        [Parameter(Mandatory = $true)][string]$InteractiveSid,
        [Parameter(Mandatory = $true)][string]$InteractiveProfileRoot
    )

    $valueParameters = @(
        '-InstallRoot', '-WorkRoot', '-PackageTarget', '-ServerTarget',
        '-OperationMethod', '-LogPath', '-CodexInstructionPolicy', '-MachineRole',
        '-TargetInteractiveUser', '-TargetInteractiveUserSid',
        '-TargetUserProfileRoot', '-TargetCodexHome'
    )
    $switchParameters = if ($TargetName -eq 'updater') {
        @('-NoNotifyUser', '-SourceFreeMigration')
    }
    else {
        @('-RunNow', '-ForceUpdate', '-SourceFreeMigration')
    }
    $allowed = @($valueParameters) + @($switchParameters)
    $values = @{}
    $switches = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($index = 0; $index -lt $Arguments.Count; $index++) {
        $name = [string]$Arguments[$index]
        if ($allowed -notcontains $name) {
            throw "Broker target argument is not on the exact '$TargetName' allowlist: '$name'. Abbreviated, colon, equals, and security-control arguments are forbidden."
        }
        if ($values.ContainsKey($name) -or $switches.Contains($name)) { throw "Duplicate broker target argument is forbidden: $name" }
        if ($switchParameters -contains $name) {
            [void]$switches.Add($name)
            continue
        }
        if ($index + 1 -ge $Arguments.Count) { throw "Broker target argument requires a value: $name" }
        $index++
        $value = [string]$Arguments[$index]
        if ($allowed -contains $value) { throw "Broker target argument value is missing before '$value'." }
        $values[$name] = $value
    }

    foreach ($required in @('-InstallRoot', '-WorkRoot', '-PackageTarget', '-ServerTarget', '-OperationMethod', '-LogPath', '-CodexInstructionPolicy', '-TargetInteractiveUser', '-TargetInteractiveUserSid', '-TargetUserProfileRoot')) {
        if (-not $values.ContainsKey($required) -or [string]::IsNullOrWhiteSpace([string]$values[$required])) {
            throw "Broker target arguments are missing required value '$required'."
        }
    }
    $expectedPaths = @{
        '-InstallRoot' = $CanonicalInstallRoot
        '-WorkRoot' = (Join-Path $CanonicalInstallRoot 'updater')
        '-PackageTarget' = (Join-Path $CanonicalInstallRoot 'package')
        '-ServerTarget' = (Join-Path $CanonicalInstallRoot 'runtime')
        '-TargetUserProfileRoot' = $InteractiveProfileRoot
    }
    foreach ($binding in $expectedPaths.GetEnumerator()) {
        if (-not [string]::Equals([IO.Path]::GetFullPath([string]$values[$binding.Key]).TrimEnd('\'), [IO.Path]::GetFullPath([string]$binding.Value).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
            throw "Broker target path '$($binding.Key)' is not canonical. Expected=$($binding.Value) Actual=$($values[$binding.Key])"
        }
    }
    if (-not [string]::Equals([string]$values['-TargetInteractiveUserSid'], $InteractiveSid, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Broker target interactive SID does not match the independently validated user.'
    }
    $resolvedAccount = ([Security.Principal.SecurityIdentifier]::new($InteractiveSid)).Translate([Security.Principal.NTAccount]).Value
    if (-not [string]::Equals([string]$values['-TargetInteractiveUser'], $resolvedAccount, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Broker target interactive account does not match SID '$InteractiveSid'."
    }
    if ([string]$values['-OperationMethod'] -notin @('gui-update', 'gui-install', 'gui-install-repair', 'source-free-migration')) {
        throw "Broker target operation method is not allowed: $($values['-OperationMethod'])"
    }
    if ([string]$values['-CodexInstructionPolicy'] -notin @('managed-user-pack', 'preserve-local')) {
        throw "Broker target Codex instruction policy is not allowed: $($values['-CodexInstructionPolicy'])"
    }
    if ($values.ContainsKey('-MachineRole') -and [string]$values['-MachineRole'] -notmatch '^[A-Za-z0-9_-]{1,32}$') {
        throw 'Broker target machine role is outside the bounded token policy.'
    }
    if ($values.ContainsKey('-TargetCodexHome') -and -not [string]::IsNullOrWhiteSpace([string]$values['-TargetCodexHome'])) {
        $codexHome = [IO.Path]::GetFullPath([string]$values['-TargetCodexHome'])
        if (-not (Test-RevAgentBrokerPathUnderRoot -Path $codexHome -Root $InteractiveProfileRoot)) {
            throw "Broker target CODEX_HOME must remain below the independently validated interactive profile: $InteractiveProfileRoot"
        }
    }
    $expectedLogRoot = Join-Path (Join-Path $CanonicalInstallRoot 'updater') 'machine-logs'
    $logPath = [IO.Path]::GetFullPath([string]$values['-LogPath'])
    if (-not (Test-RevAgentBrokerPathUnderRoot -Path $logPath -Root $expectedLogRoot) -or
        [IO.Path]::GetFileName($logPath) -notmatch '^gui-machine-\d{8}-\d{6}-[a-f0-9]{32}\.log$') {
        throw "Broker target machine log path is outside the canonical per-run pattern: $logPath"
    }
    return [pscustomobject][ordered]@{ arguments = $Arguments; values = $values; switches = @($switches) }
}

function ConvertTo-RevAgentBrokerCommandLine {
    param([string[]]$Arguments)
    return ($Arguments | ForEach-Object {
            $value = [string]$_
            if ($value -notmatch '[\s"]') { $value }
            else { '"' + (($value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
        }) -join ' '
}

function Get-RevAgentJsonLong {
    param([object]$Object, [string]$Name)
    if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) { return [long]0 }
    $parsed = [long]0
    if ([long]::TryParse([string]$Object.$Name, [ref]$parsed)) { return $parsed }
    return [long]0
}

function New-RevAgentBrokerSecureTemp {
    $windowsRoot = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
    $windowsTempRoot = [IO.Path]::GetFullPath((Join-Path $windowsRoot 'Temp')).TrimEnd('\')
    if (-not [IO.Directory]::Exists($windowsTempRoot)) { throw "Canonical Windows Temp root was not found: $windowsTempRoot" }
    Assert-RevAgentBrokerNoLinks -Path $windowsTempRoot -StopRoot $windowsRoot

    $path = Join-Path $windowsTempRoot ('revagent-broker-' + [Guid]::NewGuid().ToString('N'))
    $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($administratorsSid)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @($administratorsSid, $systemSid)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        [void]$security.AddAccessRule($rule)
    }
    [void][IO.Directory]::CreateDirectory($path, $security)
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
        throw "Secure broker TEMP was created as a filesystem link: $path"
    }
    $actualAcl = Get-Acl -LiteralPath $path
    $ownerSid = [string]$actualAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (-not $actualAcl.AreAccessRulesProtected -or $ownerSid -notin @('S-1-5-18', 'S-1-5-32-544')) {
        throw "Secure broker TEMP ACL/owner attestation failed: $path"
    }
    return $path
}

$commonAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$BootstrapRoot = [IO.Path]::GetFullPath((Join-Path $commonAppData 'DPE\revAgent\bootstrap')).TrimEnd('\')
$canonicalInstallRoot = [IO.Path]::GetFullPath((Join-Path $commonAppData 'DPE\revAgent')).TrimEnd('\')
$SnapshotParent = [IO.Path]::GetFullPath((Join-Path $canonicalInstallRoot 'execution-snapshots')).TrimEnd('\')
$brokerStateRoot = [IO.Path]::GetFullPath((Join-Path $canonicalInstallRoot 'broker-state')).TrimEnd('\')
$brokerLedgerPath = [IO.Path]::GetFullPath((Join-Path $brokerStateRoot 'release-high-water.json'))
$brokerPath = [IO.Path]::GetFullPath($PSCommandPath)
$expectedBrokerPath = [IO.Path]::GetFullPath((Join-Path $BootstrapRoot 'Invoke-revAgent-PrivilegedSnapshotUpdate.ps1'))
$snapshotModulePath = [IO.Path]::GetFullPath((Join-Path $BootstrapRoot 'lib\RevAgent.ReleaseSnapshot.psm1'))
$trustedKeysPath = [IO.Path]::GetFullPath((Join-Path $BootstrapRoot 'config\release-trusted-keys.json'))
$integrityModulePath = [IO.Path]::GetFullPath((Join-Path $BootstrapRoot 'lib\RevAgent.DistributionIntegrity.psm1'))

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Privileged release snapshot broker requires elevation.' }
if (-not [string]::Equals($brokerPath, $expectedBrokerPath, [StringComparison]::OrdinalIgnoreCase)) { throw "Privileged release snapshot broker must run from '$expectedBrokerPath'." }
foreach ($path in @($brokerPath, $snapshotModulePath, $trustedKeysPath, $integrityModulePath)) { Assert-RevAgentBrokerProtectedPath -Path $path -Root $BootstrapRoot }
if ([string]::IsNullOrWhiteSpace($TargetInteractiveUserSid) -or $TargetInteractiveUserSid -notmatch '^S-\d-\d+-(?:\d+-){1,14}\d+$') {
    throw 'Production broker requires a valid TargetInteractiveUserSid.'
}
$profileRegistryPath = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$TargetInteractiveUserSid"
$profileRegistryValue = (Get-ItemProperty -LiteralPath $profileRegistryPath -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath
$systemDrive = [IO.Path]::GetPathRoot($systemDirectory).TrimEnd('\')
$validatedProfileRoot = [regex]::Replace([string]$profileRegistryValue, '(?i)%SystemDrive%', $systemDrive)
if ($validatedProfileRoot -match '%[^%]+%' -or -not [IO.Path]::IsPathRooted($validatedProfileRoot)) {
    throw "Target interactive profile registry path is not canonical: $profileRegistryValue"
}
$validatedProfileRoot = [IO.Path]::GetFullPath($validatedProfileRoot).TrimEnd('\')
if ([string]::IsNullOrWhiteSpace($TargetUserProfileRoot) -or
    -not [string]::Equals([IO.Path]::GetFullPath($TargetUserProfileRoot).TrimEnd('\'), $validatedProfileRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "TargetUserProfileRoot does not match the independently resolved ProfileList path for '$TargetInteractiveUserSid'."
}
$allowedInboxRoot = Join-Path $validatedProfileRoot 'AppData\Local\DPE\revAgent\release-inbox'
if (-not (Test-RevAgentBrokerPathUnderRoot -Path $InboxPath -Root $allowedInboxRoot)) { throw "InboxPath must remain below the target user's canonical release inbox: $allowedInboxRoot" }

$arguments = @(ConvertFrom-RevAgentBrokerArguments -Encoded $TargetArgumentsBase64)
$argumentContract = Assert-RevAgentBrokerTargetArguments -Arguments $arguments -TargetName $Target -CanonicalInstallRoot $canonicalInstallRoot -InteractiveSid $TargetInteractiveUserSid -InteractiveProfileRoot $validatedProfileRoot
$canonicalWorkRoot = Join-Path $canonicalInstallRoot 'updater'
$canonicalMachineStateRoot = Join-Path $canonicalWorkRoot 'machine-state'
if ([string]::IsNullOrWhiteSpace($PhaseResultPath)) { throw 'Launching a machine target requires PhaseResultPath.' }
$PhaseResultPath = [IO.Path]::GetFullPath($PhaseResultPath)
if (-not (Test-RevAgentBrokerPathUnderRoot -Path $PhaseResultPath -Root $canonicalMachineStateRoot) -or
    [IO.Path]::GetFileName($PhaseResultPath) -notmatch '^gui-machine-phase-[a-f0-9]{32}\.json$') {
    throw "PhaseResultPath must use the exact canonical machine-state per-run pattern: $PhaseResultPath"
}
if (Test-Path -LiteralPath $PhaseResultPath) { throw "PhaseResultPath must not exist before child launch: $PhaseResultPath" }

$brokerMutex = [Threading.Mutex]::new($false, 'Global\DPE.revAgent.PrivilegedSnapshotBroker')
$brokerMutexAcquired = $false
try {
try {
    $brokerMutexAcquired = $brokerMutex.WaitOne([TimeSpan]::FromMinutes(5))
}
catch [Threading.AbandonedMutexException] {
    $brokerMutexAcquired = $true
}
if (-not $brokerMutexAcquired) { throw 'Timed out waiting for the global privileged snapshot broker mutex.' }
[void](Initialize-RevAgentBrokerProtectedDirectory -Path $brokerStateRoot -Parent $canonicalInstallRoot)

$highest = [long]0
$bootstrapStatePath = Join-Path $BootstrapRoot 'bootstrap-state.json'
Assert-RevAgentBrokerProtectedPath -Path $bootstrapStatePath -Root $BootstrapRoot
$bootstrapState = Get-Content -Raw -LiteralPath $bootstrapStatePath | ConvertFrom-Json
if ($bootstrapState.PSObject.Properties['release']) {
    $highest = [Math]::Max($highest, (Get-RevAgentJsonLong -Object $bootstrapState.release -Name 'releaseSequence'))
    $highest = [Math]::Max($highest, (Get-RevAgentJsonLong -Object $bootstrapState.release -Name 'highestAcceptedReleaseSequence'))
}
if ($highest -le 0) {
    throw 'Authenticated bootstrap state does not contain a positive release sequence; refresh the protected bootstrap prestage before using the broker.'
}
$ledgerHighest = [long]0
if (Test-Path -LiteralPath $brokerLedgerPath -PathType Leaf) {
    Assert-RevAgentBrokerProtectedPath -Path $brokerLedgerPath -Root $brokerStateRoot
    $ledgerItem = Get-Item -LiteralPath $brokerLedgerPath -Force
    if ($ledgerItem.Length -lt 2 -or $ledgerItem.Length -gt 65536) { throw 'Broker release high-water ledger size is outside the bounded policy.' }
    $ledger = Get-Content -Raw -LiteralPath $brokerLedgerPath | ConvertFrom-Json
    if ([int]$ledger.schemaVersion -ne 1 -or [string]$ledger.app -ne 'revAgent' -or [string]$ledger.stateType -ne 'broker-release-high-water') {
        throw 'Broker release high-water ledger contract is invalid.'
    }
    $ledgerHighest = Get-RevAgentJsonLong -Object $ledger -Name 'highestAcceptedReleaseSequence'
    if ($ledgerHighest -le 0) { throw 'Broker release high-water ledger does not contain a positive sequence.' }
    $highest = [Math]::Max($highest, $ledgerHighest)
}
$installedStatePath = Join-Path $canonicalWorkRoot 'installed.json'
if (Test-Path -LiteralPath $installedStatePath -PathType Leaf) {
    try {
        Assert-RevAgentBrokerProtectedPath -Path $installedStatePath -Root $canonicalInstallRoot
        $installedState = Get-Content -Raw -LiteralPath $installedStatePath | ConvertFrom-Json
        $highest = [Math]::Max($highest, (Get-RevAgentJsonLong -Object $installedState -Name 'releaseSequence'))
        $highest = [Math]::Max($highest, (Get-RevAgentJsonLong -Object $installedState -Name 'highestAcceptedReleaseSequence'))
        if ($installedState.PSObject.Properties['distributionIntegrity']) {
            $highest = [Math]::Max($highest, (Get-RevAgentJsonLong -Object $installedState.distributionIntegrity -Name 'highestAcceptedReleaseSequence'))
        }
    }
    catch {
        # Legacy installs may have created installed.json below an inherited,
        # user-writable updater tree. It is never trusted as anti-rollback
        # evidence; the independently authenticated bootstrap state and the
        # broker-owned ledger remain authoritative until the machine phase
        # rewrites installed.json with a protected ACL.
        Write-Warning "Ignoring legacy unprotected installed state: $($_.Exception.Message)"
    }
}

$originalTemp = $env:TEMP
$originalTmp = $env:TMP
$secureBrokerTemp = ''
try {
$secureBrokerTemp = New-RevAgentBrokerSecureTemp
$env:TEMP = $secureBrokerTemp
$env:TMP = $secureBrokerTemp
Import-Module $snapshotModulePath -Force
$snapshot = New-RevAgentProtectedReleaseSnapshot `
    -InboxPath $InboxPath `
    -Channel $Channel `
    -TrustedKeysPath $trustedKeysPath `
    -IntegrityModulePath $integrityModulePath `
    -SnapshotParent $SnapshotParent `
    -HighestAcceptedReleaseSequence $highest `
    -ExpectedNodeMsiSha256 'FD8BA3E8262738959CAD50E6F6E71D689EAB7DD09FC7231B51D78ABE7852D4EC'

$acceptedHighWater = [Math]::Max($highest, [long]$snapshot.releaseSequence)
Write-RevAgentBrokerHighWaterLedger -Path $brokerLedgerPath -ReleaseSequence $acceptedHighWater -Snapshot $snapshot
$snapshotRetention = Invoke-RevAgentBrokerSnapshotRetention -Parent $SnapshotParent -CurrentSnapshotRoot $snapshot.snapshotRoot

$targetRelativePath = if ($Target -eq 'updater') { 'payload\installer\nas\update-from-nas.ps1' } else { 'payload\installer\nas\install-updater-task.ps1' }
$targetComponentKey = if ($Target -eq 'updater') { 'updater' } else { 'updaterTaskInstaller' }
$targetPath = [IO.Path]::GetFullPath((Join-Path $snapshot.snapshotRoot $targetRelativePath))
[void](Assert-RevAgentProtectedReleaseSnapshot -SnapshotRoot $snapshot.snapshotRoot)
$component = $snapshot.state.components.$targetComponentKey
if ($null -eq $component -or
    -not [string]::Equals([string]$component.snapshotRelativePath, $targetRelativePath, [StringComparison]::OrdinalIgnoreCase) -or
    -not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $targetPath).Hash, [string]$component.sha256, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Protected snapshot target component failed exact path/hash binding: $targetComponentKey"
}

$result = [ordered]@{
    success = $true
    action = 'privileged-snapshot-update'
    target = $Target
    targetPath = $targetPath
    channelManifestPath = $snapshot.channelManifestPath
    executionSnapshot = [ordered]@{
        stateType = 'authenticated-release-snapshot'
        transportTrust = 'signed_local_snapshot'
        snapshotId = $snapshot.snapshotId
        snapshotRoot = $snapshot.snapshotRoot
        statePath = $snapshot.statePath
        releaseSequence = [long]$snapshot.releaseSequence
        channel = [string]$snapshot.state.release.channel
        channelManifestRelativePath = [string]$snapshot.state.release.channelManifestRelativePath
        targetComponentKey = $targetComponentKey
        targetRelativePath = $targetRelativePath
        targetSha256 = [string]$component.sha256
    }
    snapshotRetention = $snapshotRetention
    launched = $false
    exitCode = $null
}
$targetArguments = [Collections.Generic.List[string]]::new()
foreach ($argument in @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $targetPath, '-ChannelManifestPath', $snapshot.channelManifestPath, '-ExecutionSnapshotStatePath', $snapshot.statePath, '-MachinePhaseOnly', '-PhaseResultPath', [IO.Path]::GetFullPath($PhaseResultPath))) { $targetArguments.Add([string]$argument) }
foreach ($argument in $arguments) { $targetArguments.Add([string]$argument) }

$powershellPath = Join-Path $systemDirectory 'WindowsPowerShell\v1.0\powershell.exe'
$signature = Get-AuthenticodeSignature -LiteralPath $powershellPath
if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) { throw "Canonical Windows PowerShell signature is not valid: $powershellPath" }
$psi = [Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $powershellPath
$psi.Arguments = ConvertTo-RevAgentBrokerCommandLine -Arguments $targetArguments.ToArray()
$psi.WorkingDirectory = Split-Path -Parent $powershellPath
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $psi
[void]$process.Start()
$process.WaitForExit()
$result.launched = $true
$result.exitCode = [int]$process.ExitCode
$process.Dispose()

if ($result.exitCode -ne 0) { throw "Protected snapshot machine target exited with code $($result.exitCode)." }
if (-not (Test-Path -LiteralPath $PhaseResultPath -PathType Leaf)) {
    throw "Protected snapshot machine target exited successfully without its required phase attestation: $PhaseResultPath"
}
Assert-RevAgentBrokerProtectedPath -Path $PhaseResultPath -Root $canonicalInstallRoot
$phaseItem = Get-Item -LiteralPath $PhaseResultPath -Force
if ($phaseItem.Length -lt 2 -or $phaseItem.Length -gt 8388608) { throw "Machine phase attestation size is outside the bounded policy: $($phaseItem.Length)" }
$fsutilPath = Join-Path $systemDirectory 'fsutil.exe'
$phaseLinks = @(& $fsutilPath hardlink list $phaseItem.FullName 2>&1 | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
if ($LASTEXITCODE -ne 0 -or $phaseLinks.Count -ne 1) { throw "Machine phase attestation must have exactly one hardlink reference: $PhaseResultPath" }
$phase = Get-Content -Raw -LiteralPath $PhaseResultPath | ConvertFrom-Json
$phaseSuccess = $phase.PSObject.Properties['success']
$phaseContinue = $phase.PSObject.Properties['continueUserPhase']
if ($null -eq $phaseSuccess -or -not [bool]$phaseSuccess.Value -or
    $null -eq $phaseContinue -or -not [bool]$phaseContinue.Value -or
    -not [string]::Equals([string]$phase.phase, 'machine', [StringComparison]::OrdinalIgnoreCase) -or
    [string]$phase.status -notin @('completed', 'current')) {
    throw "Machine phase child attestation is not a successful handoff. phase=$($phase.phase) status=$($phase.status)"
}
$phase | Add-Member -NotePropertyName executionSnapshot -NotePropertyValue ([pscustomobject]$result.executionSnapshot) -Force
$resultParent = Split-Path -Parent $PhaseResultPath
$tempResult = Join-Path $resultParent ('.snapshot-phase-result-{0}.json' -f [Guid]::NewGuid().ToString('N'))
$backupResult = Join-Path $resultParent ('.snapshot-phase-backup-{0}.json' -f [Guid]::NewGuid().ToString('N'))
$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($phase | ConvertTo-Json -Depth 30))
$stream = $null
try {
    Write-RevAgentBrokerProtectedFileCreateNew -Path $tempResult -Bytes $bytes
    Assert-RevAgentBrokerProtectedPath -Path $tempResult -Root $canonicalInstallRoot
    [IO.File]::Replace($tempResult, $PhaseResultPath, $backupResult, $true)
}
finally {
    if ($null -ne $stream) { $stream.Dispose() }
    foreach ($cleanupPath in @($tempResult, $backupResult)) {
        if (Test-Path -LiteralPath $cleanupPath -PathType Leaf) { [IO.File]::Delete($cleanupPath) }
    }
}
Assert-RevAgentBrokerProtectedPath -Path $PhaseResultPath -Root $canonicalInstallRoot
[pscustomobject]$result
}
finally {
    $env:TEMP = $originalTemp
    $env:TMP = $originalTmp
    if (-not [string]::IsNullOrWhiteSpace($secureBrokerTemp)) {
        $windowsTempRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Directory]::GetParent([Environment]::SystemDirectory).FullName) 'Temp')).TrimEnd('\')
        $secureFullPath = [IO.Path]::GetFullPath($secureBrokerTemp)
        if (-not (Test-RevAgentBrokerPathUnderRoot -Path $secureFullPath -Root $windowsTempRoot) -or
            [IO.Path]::GetFileName($secureFullPath) -notmatch '^revagent-broker-[a-f0-9]{32}$') {
            throw "Refusing unsafe secure broker TEMP cleanup path: $secureFullPath"
        }
        if ([IO.Directory]::Exists($secureFullPath)) {
            [IO.Directory]::Delete($secureFullPath, $true)
        }
        if ([IO.Directory]::Exists($secureFullPath)) { throw "Secure broker TEMP cleanup was incomplete: $secureFullPath" }
    }
}
}
finally {
    if ($brokerMutexAcquired) { try { $brokerMutex.ReleaseMutex() } catch {} }
    $brokerMutex.Dispose()
}
