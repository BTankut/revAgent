Set-StrictMode -Version Latest

$script:RevAgentProductionReleaseRoot = [IO.Path]::GetFullPath('\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy').TrimEnd('\')
$script:RevAgentProductionKeyFingerprint = '32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33'
$script:RevAgentIntegrityModuleSha256 = 'C4B005D4333BD973C595D7590809D7BDA663807AF47A69ACDDF0E3955000D3E6'
$script:RevAgentNodeMsiName = 'node-v24.14.1-x64.msi'
$script:RevAgentNodeMsiSha256 = 'FD8BA3E8262738959CAD50E6F6E71D689EAB7DD09FC7231B51D78ABE7852D4EC'
$script:RevAgentNodeMsiSizeBytes = [long]32387072
$script:RevAgentSystemOnlySnapshotAccessPolicy = 'system-only-bootstrap-trust'
$script:RevAgentNodeMsiSignerSubject = 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'
$script:RevAgentSnapshotJsonSupportsDateKind = $null
$script:RevAgentSnapshotJsonRequiresNewtonsoft = $null

if (-not ('RevAgent.ReleaseSnapshotNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public static class ReleaseSnapshotNative {
        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME { public uint Low; public uint High; }

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION {
            public uint FileAttributes;
            public FILETIME CreationTime;
            public FILETIME LastAccessTime;
            public FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint GENERIC_READ = 0x80000000;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;

        private static BY_HANDLE_FILE_INFORMATION Read(SafeFileHandle handle) {
            if (handle == null || handle.IsInvalid) throw new ArgumentException("A valid file handle is required.");
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return information;
        }

        public static uint GetLinkCount(SafeFileHandle handle) { return Read(handle).NumberOfLinks; }
        public static uint GetAttributes(SafeFileHandle handle) { return Read(handle).FileAttributes; }
        public static SafeFileHandle OpenDirectoryNoDeleteShare(string path) {
            SafeFileHandle handle = CreateFileW(
                path,
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle == null || handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                if (handle != null) handle.Dispose();
                throw new Win32Exception(error, "Could not open the exact snapshot directory without FILE_SHARE_DELETE: " + path);
            }
            return handle;
        }
        public static string GetIdentity(SafeFileHandle handle) {
            BY_HANDLE_FILE_INFORMATION information = Read(handle);
            return String.Format("{0:X8}:{1:X8}{2:X8}", information.VolumeSerialNumber, information.FileIndexHigh, information.FileIndexLow);
        }
    }
}
'@
}

function Get-RevAgentSnapshotSha256Bytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '') }
    finally { $algorithm.Dispose() }
}

function Get-RevAgentSnapshotFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path -ErrorAction Stop).Hash
}

function Get-RevAgentSnapshotLockedStreamSha256 {
    param([Parameter(Mandatory = $true)][IO.FileStream]$Stream)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    $originalPosition = $Stream.Position
    try {
        $Stream.Position = 0
        $buffer = New-Object byte[] 1048576
        while (($read = $Stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            [void]$algorithm.TransformBlock($buffer, 0, $read, $null, 0)
        }
        [void]$algorithm.TransformFinalBlock((New-Object byte[] 0), 0, 0)
        return ([BitConverter]::ToString($algorithm.Hash)).Replace('-', '')
    }
    finally {
        $Stream.Position = $originalPosition
        $algorithm.Dispose()
    }
}

function New-RevAgentSnapshotJsonScanContext {
    param([Parameter(Mandatory = $true)][ValidateSet('object', 'array')][string]$Kind)

    if ($Kind -eq 'object') {
        return [pscustomobject][ordered]@{
            kind = 'object'
            state = 'keyOrEnd'
            keys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        }
    }
    return [pscustomobject][ordered]@{ kind = 'array'; state = 'valueOrEnd'; keys = $null }
}

function Set-RevAgentSnapshotJsonValueConsumed {
    param([Parameter(Mandatory = $true)][Collections.Generic.Stack[object]]$Stack)

    if ($Stack.Count -eq 0) { return }
    $context = $Stack.Peek()
    if ($context.kind -eq 'object' -and $context.state -eq 'value') { $context.state = 'commaOrEnd' }
    elseif ($context.kind -eq 'array' -and $context.state -in @('valueOrEnd', 'value')) { $context.state = 'commaOrEnd' }
}

function Read-RevAgentSnapshotJsonStringToken {
    param(
        [Parameter(Mandatory = $true)][string]$Json,
        [Parameter(Mandatory = $true)][ref]$Index
    )

    $builder = [Text.StringBuilder]::new()
    $i = $Index.Value + 1
    while ($i -lt $Json.Length) {
        $character = $Json[$i]
        if ($character -eq '"') { $Index.Value = $i; return $builder.ToString() }
        if ($character -eq '\') {
            $i++
            if ($i -ge $Json.Length) { throw 'Invalid JSON string escape.' }
            switch ($Json[$i]) {
                '"' { [void]$builder.Append('"'); break }
                '\' { [void]$builder.Append('\'); break }
                '/' { [void]$builder.Append('/'); break }
                'b' { [void]$builder.Append([char]8); break }
                'f' { [void]$builder.Append([char]12); break }
                'n' { [void]$builder.Append([char]10); break }
                'r' { [void]$builder.Append([char]13); break }
                't' { [void]$builder.Append([char]9); break }
                'u' {
                    if ($i + 4 -ge $Json.Length) { throw 'Invalid JSON unicode escape.' }
                    $hex = $Json.Substring($i + 1, 4)
                    if ($hex -notmatch '^[0-9a-fA-F]{4}$') { throw 'Invalid JSON unicode escape.' }
                    [void]$builder.Append([char]([Convert]::ToInt32($hex, 16)))
                    $i += 4
                    break
                }
                default { throw 'Invalid JSON string escape.' }
            }
            $i++
            continue
        }
        [void]$builder.Append($character)
        $i++
    }
    throw 'Unterminated JSON string.'
}

function Find-RevAgentSnapshotDuplicateJsonObjectKey {
    param([Parameter(Mandatory = $true)][string]$Json)

    $stack = [Collections.Generic.Stack[object]]::new()
    for ($i = 0; $i -lt $Json.Length; $i++) {
        $character = $Json[$i]
        if ([char]::IsWhiteSpace($character)) { continue }
        switch ($character) {
            '"' {
                $indexRef = [ref]$i
                $text = Read-RevAgentSnapshotJsonStringToken -Json $Json -Index $indexRef
                $i = $indexRef.Value
                if ($stack.Count -gt 0) {
                    $context = $stack.Peek()
                    if ($context.kind -eq 'object' -and $context.state -eq 'keyOrEnd') {
                        if (-not $context.keys.Add($text)) { return [pscustomobject]@{ found = $true; key = $text } }
                        $context.state = 'colon'
                    }
                    else { Set-RevAgentSnapshotJsonValueConsumed -Stack $stack }
                }
                continue
            }
            '{' { $stack.Push((New-RevAgentSnapshotJsonScanContext -Kind object)); continue }
            '[' { $stack.Push((New-RevAgentSnapshotJsonScanContext -Kind array)); continue }
            '}' {
                if ($stack.Count -gt 0 -and $stack.Peek().kind -eq 'object') { [void]$stack.Pop(); Set-RevAgentSnapshotJsonValueConsumed -Stack $stack }
                continue
            }
            ']' {
                if ($stack.Count -gt 0 -and $stack.Peek().kind -eq 'array') { [void]$stack.Pop(); Set-RevAgentSnapshotJsonValueConsumed -Stack $stack }
                continue
            }
            ':' {
                if ($stack.Count -gt 0 -and $stack.Peek().kind -eq 'object' -and $stack.Peek().state -eq 'colon') { $stack.Peek().state = 'value' }
                continue
            }
            ',' {
                if ($stack.Count -gt 0 -and $stack.Peek().state -eq 'commaOrEnd') {
                    if ($stack.Peek().kind -eq 'object') { $stack.Peek().state = 'keyOrEnd' } else { $stack.Peek().state = 'value' }
                }
                continue
            }
            default {
                while ($i + 1 -lt $Json.Length) {
                    $next = $Json[$i + 1]
                    if ([char]::IsWhiteSpace($next) -or $next -eq ',' -or $next -eq ']' -or $next -eq '}') { break }
                    $i++
                }
                Set-RevAgentSnapshotJsonValueConsumed -Stack $stack
            }
        }
    }
    return [pscustomobject]@{ found = $false; key = '' }
}

function ConvertFrom-RevAgentSnapshotNewtonsoftToken {
    param([AllowNull()][object]$Token)

    if ($null -eq $Token) { return $null }
    $runtimeType = $Token.GetType()
    if ($Token -is [string] -or $Token -is [bool] -or $runtimeType.IsPrimitive -or $Token -is [decimal] -or $runtimeType.FullName -ceq 'System.Numerics.BigInteger') { return $Token }
    if ($Token -is [Newtonsoft.Json.Linq.JObject]) {
        $properties = [ordered]@{}
        $propertyNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($property in @(([Newtonsoft.Json.Linq.JObject]$Token).Properties())) {
            $propertyName = [string]$property.get_Name()
            if (-not $propertyNames.Add($propertyName)) { throw "The PowerShell JSON runtime returned a case-insensitive duplicate JSON property '$propertyName'." }
            $properties[$propertyName] = ConvertFrom-RevAgentSnapshotNewtonsoftToken -Token $property.get_Value()
        }
        return [pscustomobject]$properties
    }
    if ($Token -is [Newtonsoft.Json.Linq.JArray]) {
        $items = [Collections.Generic.List[object]]::new()
        foreach ($item in @(([Newtonsoft.Json.Linq.JArray]$Token).Children())) { $items.Add((ConvertFrom-RevAgentSnapshotNewtonsoftToken -Token $item)) }
        return ,([object[]]$items.ToArray())
    }
    if ($Token -is [Newtonsoft.Json.Linq.JValue]) { return ([Newtonsoft.Json.Linq.JValue]$Token).get_Value() }
    throw "The PowerShell JSON runtime returned an unsupported Newtonsoft token type '$($runtimeType.FullName)'."
}

function ConvertFrom-RevAgentSnapshotJsonPreservingStrings {
    param([Parameter(Mandatory = $true)][string]$Json)

    if ($null -eq $script:RevAgentSnapshotJsonSupportsDateKind) {
        $command = Microsoft.PowerShell.Core\Get-Command -Name 'Microsoft.PowerShell.Utility\ConvertFrom-Json' -CommandType Cmdlet -ErrorAction Stop
        $script:RevAgentSnapshotJsonSupportsDateKind = [bool]$command.Parameters.ContainsKey('DateKind')
        $script:RevAgentSnapshotJsonRequiresNewtonsoft = $false
        if (-not $script:RevAgentSnapshotJsonSupportsDateKind) {
            $probe = '"2000-01-01T00:00:00.0000000Z"' | Microsoft.PowerShell.Utility\ConvertFrom-Json -ErrorAction Stop
            $script:RevAgentSnapshotJsonRequiresNewtonsoft = -not ($probe -is [string])
        }
    }
    if ($script:RevAgentSnapshotJsonSupportsDateKind) {
        return $Json | Microsoft.PowerShell.Utility\ConvertFrom-Json -DateKind String -ErrorAction Stop
    }
    if (-not $script:RevAgentSnapshotJsonRequiresNewtonsoft) {
        return $Json | Microsoft.PowerShell.Utility\ConvertFrom-Json -ErrorAction Stop
    }
    if ($null -eq ('Newtonsoft.Json.JsonConvert' -as [type])) { throw 'The PowerShell JSON runtime cannot preserve ISO date strings.' }
    $settings = [Newtonsoft.Json.JsonSerializerSettings]::new()
    $settings.DateParseHandling = [Newtonsoft.Json.DateParseHandling]::None
    $token = [Newtonsoft.Json.JsonConvert]::DeserializeObject($Json, $settings)
    return ConvertFrom-RevAgentSnapshotNewtonsoftToken -Token $token
}

function Read-RevAgentSnapshotLockedJson {
    param(
        [Parameter(Mandatory = $true)][IO.FileStream]$Stream,
        [Parameter(Mandatory = $true)][string]$Path,
        [long]$MaxBytes = 4194304
    )

    if ($Stream.Length -lt 2 -or $Stream.Length -gt $MaxBytes) {
        throw "Signed JSON size is outside the bounded policy. path=$Path size=$($Stream.Length)"
    }
    $bytes = New-Object byte[] ([int]$Stream.Length)
    $Stream.Position = 0
    [int]$offset = 0
    while ($offset -lt $bytes.Length) {
        $read = $Stream.Read($bytes, $offset, $bytes.Length - $offset)
        if ($read -le 0) { throw "Signed JSON ended before its locked length was read: $Path" }
        $offset += $read
    }
    $Stream.Position = 0
    try {
        $json = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        if ($json.Length -gt 0 -and $json[0] -eq [char]0xFEFF) { $json = $json.Substring(1) }
        $duplicate = Find-RevAgentSnapshotDuplicateJsonObjectKey -Json $json
        if ([bool]$duplicate.found) { throw "Signed JSON contains a duplicate decoded object property: $($duplicate.key)" }
        return ConvertFrom-RevAgentSnapshotJsonPreservingStrings -Json $json
    }
    catch {
        throw "Signed JSON could not be parsed from its locked bytes. path=$Path error=$($_.Exception.Message)"
    }
}

function Test-RevAgentSnapshotPathUnderRoot {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root)
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    return [string]::Equals($fullPath, $fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-RevAgentSnapshotPathNoLinks {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$StopRoot = '',
        [switch]$RequireLeaf
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    $stop = if ([string]::IsNullOrWhiteSpace($StopRoot)) { '' } else { [IO.Path]::GetFullPath($StopRoot).TrimEnd('\') }
    $cursor = $fullPath
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) {
                throw "Release snapshot path contains a filesystem link/reparse component: $cursor"
            }
        }
        elseif ($RequireLeaf -and [string]::Equals($cursor, $fullPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Required release snapshot file was not found: $fullPath"
        }
        if (-not [string]::IsNullOrWhiteSpace($stop) -and [string]::Equals($cursor.TrimEnd('\'), $stop, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or [string]::Equals($parent, $cursor, [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = $parent
    }
    return $fullPath
}

function Assert-RevAgentSnapshotExactProperties {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string[]]$Names,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($null -eq $Value) { throw "$Label is missing." }
    $actual = @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
    if ($actual.Count -ne $Names.Count -or
        @($actual | Where-Object { $Names -cnotcontains $_ }).Count -ne 0 -or
        @($Names | Where-Object { $actual -cnotcontains $_ }).Count -ne 0) {
        throw "$Label must contain exactly: $($Names -join ', ')."
    }
}

function Read-RevAgentSnapshotInboxState {
    param(
        [Parameter(Mandatory = $true)][string]$InboxPath,
        [Parameter(Mandatory = $true)][ValidateSet('stable', 'pilot')][string]$Channel
    )

    $inbox = [IO.Path]::GetFullPath($InboxPath).TrimEnd('\')
    $statePath = Assert-RevAgentSnapshotPathNoLinks -Path (Join-Path $inbox 'inbox-state.json') -StopRoot $inbox -RequireLeaf
    $stream = $null
    try {
        # FileShare.Read denies both writes and delete/rename while the exact
        # hostile-inbox bytes are bounded, duplicate-scanned, and parsed.
        $stream = [IO.FileStream]::new($statePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $attributes = [uint32][RevAgent.ReleaseSnapshotNative]::GetAttributes($stream.SafeFileHandle)
        if (($attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0 -or
            ($attributes -band [uint32][IO.FileAttributes]::Directory) -ne 0) {
            throw "Release inbox state must be an ordinary non-reparse file: $statePath"
        }
        $linkCount = [uint32][RevAgent.ReleaseSnapshotNative]::GetLinkCount($stream.SafeFileHandle)
        if ($linkCount -ne 1) { throw "Release inbox state must have exactly one hardlink reference. path=$statePath linkCount=$linkCount" }
        [void](Assert-RevAgentSnapshotPathNoLinks -Path $statePath -StopRoot $inbox -RequireLeaf)
        $state = Read-RevAgentSnapshotLockedJson -Stream $stream -Path $statePath -MaxBytes 262144
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }

    Assert-RevAgentSnapshotExactProperties -Value $state -Names @(
        'schemaVersion', 'app', 'stateType', 'transportTrust', 'inboxId', 'inboxRoot', 'createdAtUtc',
        'acquisitionChannelManifestPath', 'channelPolicy', 'release', 'files'
    ) -Label 'Release inbox state'
    if ([int]$state.schemaVersion -ne 1 -or
        [string]$state.app -cne 'revAgent' -or
        [string]$state.stateType -cne 'authenticated-release-inbox' -or
        [string]$state.transportTrust -cne 'signed_local_snapshot') {
        throw 'Release inbox state contract is invalid.'
    }
    $createdAt = [DateTimeOffset]::MinValue
    if ([string]$state.createdAtUtc -cnotmatch 'Z$' -or
        -not [DateTimeOffset]::TryParse([string]$state.createdAtUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$createdAt)) {
        throw 'Release inbox createdAtUtc must be an ISO UTC timestamp.'
    }

    $inboxId = [string]$state.inboxId
    $boundRoot = ''
    try { $boundRoot = [IO.Path]::GetFullPath([string]$state.inboxRoot).TrimEnd('\') }
    catch { throw 'Release inbox root is not a valid absolute path.' }
    if ($inboxId -cnotmatch '^[a-f0-9]{32}$' -or
        -not [string]::Equals([IO.Path]::GetFileName($inbox), $inboxId, [StringComparison]::Ordinal) -or
        -not [string]::Equals($boundRoot, $inbox, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Release inbox identity/path/leaf contract is invalid.'
    }

    Assert-RevAgentSnapshotExactProperties -Value $state.release -Names @(
        'channel', 'version', 'releaseSequence', 'minimumAcceptedReleaseSequence', 'highestAcceptedReleaseSequence',
        'channelManifestRelativePath', 'channelSignatureRelativePath', 'releaseManifestRelativePath',
        'releaseManifestSignatureRelativePath', 'packageRelativePath', 'packageSha256', 'packageSizeBytes'
    ) -Label 'Release inbox release state'
    if ([string]$state.release.channel -cne $Channel -or
        [string]$state.release.channelManifestRelativePath -cne "channels\$Channel.json" -or
        [string]$state.release.channelSignatureRelativePath -cne "channels\$Channel.sig.json" -or
        [string]$state.release.packageSha256 -cnotmatch '^[A-Fa-f0-9]{64}$' -or
        [long]$state.release.packageSizeBytes -lt 1) {
        throw "Release inbox channel/release state does not match the requested protected snapshot channel: $Channel"
    }

    $policyFields = if ($Channel -eq 'pilot') { @('channel', 'cohortEnforced', 'allowedMachineNames', 'machineName') } else { @('channel', 'cohortEnforced', 'allowedMachineNames') }
    Assert-RevAgentSnapshotExactProperties -Value $state.channelPolicy -Names $policyFields -Label 'Release inbox channel policy'
    if ([string]$state.channelPolicy.channel -cne $Channel) { throw 'Release inbox channel policy identity is invalid.' }

    $fileRoles = @('channelManifest', 'channelSignature', 'releaseManifest', 'releaseManifestSignature', 'package', 'nodeMsi')
    Assert-RevAgentSnapshotExactProperties -Value $state.files -Names $fileRoles -Label 'Release inbox file map'
    foreach ($role in $fileRoles) {
        $entry = $state.files.PSObject.Properties[$role].Value
        $fields = @('sourcePath', 'destinationPath', 'sha256', 'sizeBytes', 'sourceIdentity', 'sourceLinkCount')
        if ($role -eq 'nodeMsi') { $fields += @('signerSubject', 'authenticodeStatus') }
        Assert-RevAgentSnapshotExactProperties -Value $entry -Names $fields -Label "Release inbox file '$role'"
        $destination = ''
        try { $destination = [IO.Path]::GetFullPath([string]$entry.destinationPath) }
        catch { throw "Release inbox file '$role' destination path is invalid." }
        if (-not (Test-RevAgentSnapshotPathUnderRoot -Path $destination -Root $inbox) -or
            [string]$entry.sha256 -cnotmatch '^[A-Fa-f0-9]{64}$' -or
            [long]$entry.sizeBytes -lt 1 -or [uint32]$entry.sourceLinkCount -ne 1) {
            throw "Release inbox file '$role' evidence is invalid."
        }
    }
    return $state
}

function Resolve-RevAgentSnapshotRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$BaseDirectory,
        [Parameter(Mandatory = $true)][string]$Root
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath) -or $RelativePath.IndexOf([char]0) -ge 0) {
        throw "Signed release path must be a non-empty relative path: '$RelativePath'"
    }
    $resolved = [IO.Path]::GetFullPath((Join-Path $BaseDirectory $RelativePath))
    if (-not (Test-RevAgentSnapshotPathUnderRoot -Path $resolved -Root $Root)) {
        throw "Signed release path escaped its release root: $resolved"
    }
    return $resolved
}

function Get-RevAgentSignedNodeMsiMetadata {
    param(
        [Parameter(Mandatory = $true)][object]$Manifest,
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [switch]$AllowTestRoot
    )

    $externalProperty = $Manifest.PSObject.Properties['externalDependencies']
    $nodeProperty = if ($null -ne $externalProperty -and $null -ne $externalProperty.Value) { $externalProperty.Value.PSObject.Properties['nodeMsi'] } else { $null }
    if ($null -eq $nodeProperty -or $null -eq $nodeProperty.Value) {
        throw 'Signed release manifest is missing externalDependencies.nodeMsi.'
    }
    $metadata = $nodeProperty.Value
    if ([int]$metadata.schemaVersion -ne 1) { throw 'Signed Node.js MSI metadata requires schemaVersion 1.' }

    $relativePath = ([string]$metadata.relativePath).Replace('/', '\')
    $expectedRelativePath = "external\$($script:RevAgentNodeMsiName)"
    if (-not [string]::Equals($relativePath, $expectedRelativePath, [StringComparison]::Ordinal)) {
        throw "Signed Node.js MSI path must be the exact release-owned sidecar path '$expectedRelativePath'. actual='$relativePath'"
    }
    if ([IO.Path]::IsPathRooted($relativePath) -or $relativePath.IndexOf(':') -ge 0 -or @($relativePath.Split('\') | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count -gt 0) {
        throw "Signed Node.js MSI path is not a canonical relative path: '$relativePath'"
    }

    $manifestDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $ManifestPath)).TrimEnd('\')
    if (-not (Test-RevAgentSnapshotPathUnderRoot -Path $manifestDirectory -Root $ReleaseRoot)) {
        throw "Signed release manifest directory escaped the release root: $manifestDirectory"
    }
    $nodePath = Resolve-RevAgentSnapshotRelativePath -RelativePath $relativePath -BaseDirectory $manifestDirectory -Root $manifestDirectory
    $expectedPath = [IO.Path]::GetFullPath((Join-Path $manifestDirectory $expectedRelativePath))
    if (-not [string]::Equals($nodePath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Signed Node.js MSI did not resolve to the exact versioned release sidecar. expected=$expectedPath actual=$nodePath"
    }

    $sha256 = ([string]$metadata.sha256).Trim().ToUpperInvariant()
    [long]$sizeBytes = 0
    if ($sha256 -cnotmatch '^[A-F0-9]{64}$' -or -not [long]::TryParse([string]$metadata.sizeBytes, [ref]$sizeBytes) -or $sizeBytes -lt 1 -or $sizeBytes -gt 268435456) {
        throw 'Signed Node.js MSI hash/size metadata is invalid.'
    }
    $signerSubject = [string]$metadata.signerSubject
    $authenticodeStatus = [string]$metadata.authenticodeStatus
    if (-not $AllowTestRoot) {
        if (-not [string]::Equals($sha256, $script:RevAgentNodeMsiSha256, [StringComparison]::Ordinal) -or
            $sizeBytes -ne $script:RevAgentNodeMsiSizeBytes -or
            -not [string]::Equals($signerSubject, $script:RevAgentNodeMsiSignerSubject, [StringComparison]::Ordinal) -or
            -not [string]::Equals($authenticodeStatus, 'Valid', [StringComparison]::Ordinal)) {
            throw 'Signed Node.js MSI metadata does not match the pinned production asset identity.'
        }
    }
    elseif ([string]::IsNullOrWhiteSpace($signerSubject) -or [string]::IsNullOrWhiteSpace($authenticodeStatus)) {
        throw 'Test-only signed Node.js MSI metadata must still state signer/status evidence.'
    }

    return [pscustomobject][ordered]@{
        schemaVersion = 1
        relativePath = $expectedRelativePath
        path = $nodePath
        sha256 = $sha256
        sizeBytes = $sizeBytes
        signerSubject = $signerSubject
        authenticodeStatus = $authenticodeStatus
    }
}

function Assert-RevAgentSignedChannelPolicy {
    param(
        [Parameter(Mandatory = $true)][object]$ChannelDocument,
        [Parameter(Mandatory = $true)][ValidateSet('stable', 'pilot')][string]$RequestedChannel,
        [string]$MachineName = ''
    )

    $signedChannel = [string]$ChannelDocument.channel
    if (-not [string]::Equals($signedChannel, $RequestedChannel, [StringComparison]::Ordinal)) {
        throw "Signed channel identity does not match the requested channel. requested=$RequestedChannel signed=$signedChannel"
    }
    $pilotPolicy = if ($ChannelDocument.PSObject.Properties['pilotPolicy']) { $ChannelDocument.pilotPolicy } else { $null }
    if ([string]::Equals($RequestedChannel, 'stable', [StringComparison]::Ordinal)) {
        if ($null -ne $pilotPolicy) { throw 'Stable signed channel must not contain pilotPolicy.' }
        return [pscustomobject][ordered]@{ channel = 'stable'; cohortEnforced = $false; allowedMachineNames = @() }
    }
    if ($null -eq $pilotPolicy -or [int]$pilotPolicy.schemaVersion -ne 1) { throw 'Pilot signed channel requires pilotPolicy schemaVersion 1.' }
    $allowed = @($pilotPolicy.allowedMachineNames)
    if ($allowed.Count -eq 0) { throw 'Pilot signed channel requires a non-empty allowedMachineNames cohort.' }
    $normalized = [Collections.Generic.List[string]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $allowed) {
        $value = ([string]$name).Trim().ToUpperInvariant()
        if ($value -cnotmatch '^[A-Z0-9][A-Z0-9-]{0,62}$' -or
            -not [string]::Equals([string]$name, $value, [StringComparison]::Ordinal) -or
            -not $seen.Add($value)) {
            throw 'Pilot signed channel contains an invalid, non-normalized, or duplicate machine name.'
        }
        [void]$normalized.Add($value)
    }
    $machine = if ([string]::IsNullOrWhiteSpace($MachineName)) { [Environment]::MachineName.Trim().ToUpperInvariant() } else { $MachineName.Trim().ToUpperInvariant() }
    if ($machine -cnotmatch '^[A-Z0-9][A-Z0-9-]{0,62}$') { throw 'Pilot machine identity is invalid.' }
    if (-not $seen.Contains($machine)) { throw "pilot_machine_not_allowed: signed pilot channel does not authorize this computer: $machine" }
    return [pscustomobject][ordered]@{ channel = 'pilot'; cohortEnforced = $true; allowedMachineNames = @($normalized.ToArray()); machineName = $machine }
}

function Copy-RevAgentSnapshotFileHandleBound {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [long]$MaxBytes = 2147483648,
        [string]$ExpectedSha256 = '',
        [switch]$AllowMultipleLinks
    )

    $sourceFullPath = Assert-RevAgentSnapshotPathNoLinks -Path $SourcePath -RequireLeaf
    $destinationFullPath = [IO.Path]::GetFullPath($DestinationPath)
    $destinationParent = Split-Path -Parent $destinationFullPath
    if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) { throw "Snapshot destination parent was not found: $destinationParent" }
    if (Test-Path -LiteralPath $destinationFullPath) { throw "Snapshot destination already exists: $destinationFullPath" }

    $source = $null
    $destination = $null
    $algorithm = $null
    try {
        # FileShare.Read intentionally blocks concurrent write/delete while the
        # exact bytes are hashed and copied. The source path may be a writable
        # SMB transport or user inbox; the open handle, not the pathname, is
        # the acquisition identity.
        $source = [IO.FileStream]::new($sourceFullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($source.Length -lt 1 -or $source.Length -gt $MaxBytes) {
            throw "Snapshot source size is outside the bounded 1..$MaxBytes byte policy. path=$sourceFullPath size=$($source.Length)"
        }
        $linkCount = [uint32][RevAgent.ReleaseSnapshotNative]::GetLinkCount($source.SafeFileHandle)
        if (-not $AllowMultipleLinks -and $linkCount -ne 1) { throw "Snapshot source must have exactly one hardlink reference. path=$sourceFullPath linkCount=$linkCount" }
        $identity = [RevAgent.ReleaseSnapshotNative]::GetIdentity($source.SafeFileHandle)
        [void](Assert-RevAgentSnapshotPathNoLinks -Path $sourceFullPath -RequireLeaf)

        $destination = [IO.File]::Open($destinationFullPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $algorithm = [Security.Cryptography.SHA256]::Create()
        $buffer = New-Object byte[] 1048576
        [long]$total = 0
        while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $read
            if ($total -gt $MaxBytes) { throw "Snapshot source exceeded its byte bound while reading: $sourceFullPath" }
            [void]$algorithm.TransformBlock($buffer, 0, $read, $null, 0)
            $destination.Write($buffer, 0, $read)
        }
        [void]$algorithm.TransformFinalBlock((New-Object byte[] 0), 0, 0)
        $destination.Flush($true)
        $sha256 = ([BitConverter]::ToString($algorithm.Hash)).Replace('-', '')
        if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256) -and
            -not [string]::Equals($sha256, $ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Snapshot source hash mismatch. path=$sourceFullPath expected=$ExpectedSha256 actual=$sha256"
        }
        if ($source.Length -ne $total) { throw "Snapshot source changed length while reading: $sourceFullPath" }
        return [pscustomobject][ordered]@{
            sourcePath = $sourceFullPath
            destinationPath = $destinationFullPath
            sha256 = $sha256
            sizeBytes = $total
            sourceIdentity = $identity
            sourceLinkCount = $linkCount
        }
    }
    finally {
        if ($null -ne $algorithm) { $algorithm.Dispose() }
        if ($null -ne $destination) { $destination.Dispose() }
        if ($null -ne $source) { $source.Dispose() }
    }
}

function Write-RevAgentSnapshotJsonCreateNew {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][object]$Value, [int]$Depth = 30)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth $Depth))
    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Assert-RevAgentSnapshotTrustInputs {
    param(
        [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
        [Parameter(Mandatory = $true)][string]$IntegrityModulePath,
        [switch]$AllowTestRoot
    )

    foreach ($path in @($TrustedKeysPath, $IntegrityModulePath)) {
        [void](Assert-RevAgentSnapshotPathNoLinks -Path $path -RequireLeaf)
        $stream = [IO.FileStream]::new([IO.Path]::GetFullPath($path), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            if ([RevAgent.ReleaseSnapshotNative]::GetLinkCount($stream.SafeFileHandle) -ne 1) { throw "Protected trust input must have one hardlink reference: $path" }
        }
        finally { $stream.Dispose() }
    }
    $integrityHash = Get-RevAgentSnapshotFileSha256 -Path $IntegrityModulePath
    if (-not $AllowTestRoot -and -not [string]::Equals($integrityHash, $script:RevAgentIntegrityModuleSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Protected release integrity verifier hash mismatch. expected=$($script:RevAgentIntegrityModuleSha256) actual=$integrityHash"
    }
    $trustedKeysStream = $null
    try {
        $trustedKeysStream = [IO.File]::Open($TrustedKeysPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($trustedKeysStream.Length -lt 1 -or $trustedKeysStream.Length -gt 65536) {
            throw "Protected trust document size is outside the bounded 1..65536 policy: $TrustedKeysPath"
        }
        $trustedKeysBytes = New-Object byte[] ([int]$trustedKeysStream.Length)
        $trustedKeysOffset = 0
        while ($trustedKeysOffset -lt $trustedKeysBytes.Length) {
            $trustedKeysRead = $trustedKeysStream.Read($trustedKeysBytes, $trustedKeysOffset, $trustedKeysBytes.Length - $trustedKeysOffset)
            if ($trustedKeysRead -le 0) { throw "Protected trust document ended before its declared length: $TrustedKeysPath" }
            $trustedKeysOffset += $trustedKeysRead
        }
        if ($trustedKeysStream.ReadByte() -ne -1) { throw "Protected trust document grew while it was acquired: $TrustedKeysPath" }
    }
    finally { if ($null -ne $trustedKeysStream) { $trustedKeysStream.Dispose() } }
    $trustedKeysSha256 = Get-RevAgentSnapshotSha256Bytes -Bytes $trustedKeysBytes
    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $trustedKeysJson = $strictUtf8.GetString($trustedKeysBytes)
    if ($trustedKeysJson.Length -gt 0 -and $trustedKeysJson[0] -eq [char]0xFEFF) { $trustedKeysJson = $trustedKeysJson.Substring(1) }

    Microsoft.PowerShell.Utility\Add-Type -AssemblyName System.Runtime.Serialization -ErrorAction Stop
    $jsonBytes = $trustedKeysBytes
    if ($trustedKeysBytes.Length -ge 3 -and $trustedKeysBytes[0] -eq 0xEF -and $trustedKeysBytes[1] -eq 0xBB -and $trustedKeysBytes[2] -eq 0xBF) {
        $jsonBytes = New-Object byte[] ($trustedKeysBytes.Length - 3)
        [Array]::Copy($trustedKeysBytes, 3, $jsonBytes, 0, $jsonBytes.Length)
    }
    $reader = $null
    try {
        $reader = [Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader($jsonBytes, [Xml.XmlDictionaryReaderQuotas]::Max)
        $tokenDocument = [Xml.XmlDocument]::new()
        $tokenDocument.XmlResolver = $null
        $tokenDocument.Load($reader)
    }
    catch { throw "Protected trust bytes are not strict JSON: $($_.Exception.Message)" }
    finally { if ($null -ne $reader) { $reader.Dispose() } }
    $tokenRoot = $tokenDocument.DocumentElement
    if ($null -eq $tokenRoot -or
        -not [string]::Equals([string]$tokenRoot.LocalName, 'root', [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$tokenRoot.GetAttribute('type'), 'object', [StringComparison]::Ordinal)) {
        throw 'Protected trust document must be one JSON object.'
    }
    $topLevelTokenNodes = @($tokenRoot.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element })

    $trustedInputIntegrityModule = Import-Module $IntegrityModulePath -Force -PassThru
    $duplicateTrustedKeyProperty = & $trustedInputIntegrityModule { param($Value) Find-RevitMcpDuplicateJsonObjectKey -Json $Value } $trustedKeysJson
    if ([bool]$duplicateTrustedKeyProperty.found) {
        throw "Protected trust document contains a duplicate decoded JSON property: $($duplicateTrustedKeyProperty.key)"
    }
    $keys = ConvertFrom-RevAgentSnapshotJsonPreservingStrings -Json $trustedKeysJson
    $topLevelProperties = @($keys.PSObject.Properties)
    $allowedTopLevelFields = @('schemaVersion', 'app', 'generatedAtUtc', 'trustedKeys')
    $minimalTopLevel = $topLevelProperties.Count -eq 1 -and [string]::Equals([string]$topLevelProperties[0].Name, 'trustedKeys', [StringComparison]::Ordinal)
    $metadataTopLevel = $topLevelProperties.Count -eq $allowedTopLevelFields.Count -and
        @($topLevelProperties | Where-Object { $allowedTopLevelFields -cnotcontains [string]$_.Name }).Count -eq 0 -and
        @($allowedTopLevelFields | Where-Object { @($topLevelProperties.Name) -cnotcontains $_ }).Count -eq 0
    if (-not $minimalTopLevel -and -not $metadataTopLevel) {
        throw 'Protected trust document properties must be exactly trustedKeys, or exactly schemaVersion, app, generatedAtUtc, trustedKeys.'
    }
    if ($metadataTopLevel) {
        $generatedAtUtcNodes = @($topLevelTokenNodes | Where-Object {
                $propertyName = if ([string]::Equals([string]$_.LocalName, 'item', [StringComparison]::Ordinal) -and $_.HasAttribute('item')) {
                    [string]$_.GetAttribute('item')
                }
                else { [string]$_.LocalName }
                [string]::Equals($propertyName, 'generatedAtUtc', [StringComparison]::Ordinal)
            })
        $generatedAtUtcText = if ($generatedAtUtcNodes.Count -eq 1 -and
            [string]::Equals([string]$generatedAtUtcNodes[0].GetAttribute('type'), 'string', [StringComparison]::Ordinal)) {
            [string]$generatedAtUtcNodes[0].InnerText
        }
        else { $null }
        $generatedAt = [DateTimeOffset]::MinValue
        if (($keys.schemaVersion -isnot [int] -and $keys.schemaVersion -isnot [long]) -or
            [long]$keys.schemaVersion -ne 1 -or
            $keys.app -isnot [string] -or
            ([string]$keys.app -cne 'revAgent' -and [string]$keys.app -cne 'revit-mcp-skill') -or
            [string]$generatedAtUtcText -cnotmatch 'Z$' -or
            -not [DateTimeOffset]::TryParse([string]$generatedAtUtcText, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$generatedAt) -or
            $generatedAt.Offset -ne [TimeSpan]::Zero -or
            $generatedAt.UtcDateTime -gt [DateTime]::UtcNow.AddMinutes(5)) {
            throw 'Protected trust metadata must be schemaVersion 1, an accepted revAgent app identity, and ISO UTC generatedAtUtc.'
        }
    }
    $trustedKeyProperties = @($keys.trustedKeys.PSObject.Properties)
    if ($trustedKeyProperties.Count -lt 1 -or $trustedKeyProperties.Count -gt 2) {
        throw 'Protected trust document must contain one active key and at most one transition key.'
    }
    if (-not $AllowTestRoot -and $null -eq $keys.trustedKeys.PSObject.Properties['revagent-prod-rsa-2026q3']) {
        throw "Protected production trust document must contain the pinned 'revagent-prod-rsa-2026q3' key."
    }
    if (-not $AllowTestRoot -and $trustedKeyProperties.Count -eq 2) {
        $transitionKeyId = [string](@($trustedKeyProperties | Where-Object { -not [string]::Equals([string]$_.Name, 'revagent-prod-rsa-2026q3', [StringComparison]::Ordinal) })[0].Name)
        $transitionMatch = [regex]::Match($transitionKeyId, '^revagent-prod-rsa-(?<year>[0-9]{4})q(?<quarter>[1-4])$')
        $transitionOrdinal = if ($transitionMatch.Success) { ([int]$transitionMatch.Groups['year'].Value * 4) + [int]$transitionMatch.Groups['quarter'].Value } else { 0 }
        if (-not $transitionMatch.Success -or $transitionOrdinal -le ((2026 * 4) + 3)) {
            throw "Protected transition key must be later than revagent-prod-rsa-2026q3: $transitionKeyId"
        }
    }
    $trustedFingerprints = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($trustedKeyProperty in $trustedKeyProperties) {
        $trustedKey = $trustedKeyProperty.Value
        $recordProperties = @($trustedKey.PSObject.Properties)
        $requiredFields = @('algorithm', 'publicKeyFingerprint', 'publicKeyXml')
        $allowedFields = @('algorithm', 'publicKeyFingerprint', 'publicKeyXml', 'purpose')
        if ($recordProperties.Count -lt $requiredFields.Count -or $recordProperties.Count -gt $allowedFields.Count -or
            @($recordProperties | Where-Object { $allowedFields -cnotcontains [string]$_.Name }).Count -ne 0 -or
            @($requiredFields | Where-Object { @($recordProperties.Name) -cnotcontains $_ }).Count -ne 0 -or
            ($null -ne $trustedKey.PSObject.Properties['purpose'] -and [string]$trustedKey.purpose -cne 'release-signing') -or
            -not [string]::Equals([string]$trustedKey.algorithm, 'RS256', [StringComparison]::Ordinal) -or
            [string]$trustedKey.publicKeyFingerprint -notmatch '^[A-Fa-f0-9]{64}$') {
            throw "Protected trusted-key entry is not an exact public RS256 record: $($trustedKeyProperty.Name)"
        }
        $settings = [Xml.XmlReaderSettings]::new()
        $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
        $settings.XmlResolver = $null
        $stringReader = [IO.StringReader]::new([string]$trustedKey.publicKeyXml)
        $xmlReader = $null
        try {
            $xmlReader = [Xml.XmlReader]::Create($stringReader, $settings)
            $publicXml = [Xml.XmlDocument]::new()
            $publicXml.XmlResolver = $null
            $publicXml.Load($xmlReader)
        }
        finally {
            if ($null -ne $xmlReader) { $xmlReader.Dispose() }
            $stringReader.Dispose()
        }
        $elementNames = if ($null -eq $publicXml.DocumentElement) { @() } else {
            @($publicXml.DocumentElement.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element } | ForEach-Object { $_.Name })
        }
        if ($null -eq $publicXml.DocumentElement -or
            -not [string]::Equals([string]$publicXml.DocumentElement.Name, 'RSAKeyValue', [StringComparison]::Ordinal) -or
            $elementNames.Count -ne 2 -or
            @((Compare-Object @('Exponent', 'Modulus') @($elementNames | Sort-Object) -SyncWindow 0)).Count -ne 0) {
            throw "Protected trusted-key XML contains private or unexpected RSA parameters: $($trustedKeyProperty.Name)"
        }
        $normalizedTrustedKey = ([string]$trustedKey.publicKeyXml).Trim() -replace '\s+', ''
        $computedTrustedFingerprint = Get-RevAgentSnapshotSha256Bytes -Bytes ([Text.Encoding]::UTF8.GetBytes($normalizedTrustedKey))
        if (-not [string]::Equals($computedTrustedFingerprint, [string]$trustedKey.publicKeyFingerprint, [StringComparison]::OrdinalIgnoreCase) -or
            -not $trustedFingerprints.Add($computedTrustedFingerprint)) {
            throw "Protected trusted-key fingerprint is invalid or duplicated: $($trustedKeyProperty.Name)"
        }
    }
    $productionKeyProperty = if ($null -ne $keys.trustedKeys) { $keys.trustedKeys.PSObject.Properties['revagent-prod-rsa-2026q3'] } else { $null }
    $productionKey = if ($null -ne $productionKeyProperty) { $productionKeyProperty.Value } else { $null }
    if ($null -eq $productionKey -and -not $AllowTestRoot) { throw 'Protected trust document is missing the production release key.' }
    if ($null -ne $productionKey) {
        if (-not $AllowTestRoot -and
            (-not [string]::Equals([string]$productionKey.algorithm, 'RS256', [StringComparison]::Ordinal) -or
                -not [string]::Equals([string]$productionKey.publicKeyFingerprint, $script:RevAgentProductionKeyFingerprint, [StringComparison]::OrdinalIgnoreCase))) {
            throw 'Protected production release-key metadata does not match the pinned RS256 key.'
        }
        $normalized = ([string]$productionKey.publicKeyXml).Trim() -replace '\s+', ''
        $fingerprint = Get-RevAgentSnapshotSha256Bytes -Bytes ([Text.Encoding]::UTF8.GetBytes($normalized))
        if (-not $AllowTestRoot -and -not [string]::Equals($fingerprint, $script:RevAgentProductionKeyFingerprint, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Protected release-key fingerprint mismatch. expected=$($script:RevAgentProductionKeyFingerprint) actual=$fingerprint"
        }
    }
    return [pscustomobject][ordered]@{
        keys = $keys
        trustedKeysSha256 = $trustedKeysSha256
        verifierSha256 = $integrityHash
        productionKeyFingerprint = if ($null -ne $productionKey) { $fingerprint } else { '' }
    }
}

function Get-RevAgentVerifiedReleaseSet {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [ValidateSet('stable', 'pilot')][string]$Channel = 'stable',
        [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
        [Parameter(Mandatory = $true)][string]$IntegrityModulePath,
        [long]$HighestAcceptedReleaseSequence = 0,
        [switch]$AllowTestRoot,
        [scriptblock]$SignedSetLockedHook = $null,
        [Parameter(DontShow = $true)][string]$TestMachineName = ''
    )

    if ($null -ne $SignedSetLockedHook -and -not $AllowTestRoot) {
        throw 'SignedSetLockedHook is available only for disposable test roots.'
    }
    if (-not [string]::IsNullOrWhiteSpace($TestMachineName) -and -not $AllowTestRoot) {
        throw 'TestMachineName is available only for disposable test roots.'
    }

    $root = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
    $channelPath = [IO.Path]::GetFullPath((Join-Path $root ("channels\{0}.json" -f $Channel)))
    $channelSignaturePath = [IO.Path]::GetFullPath((Join-Path $root ("channels\{0}.sig.json" -f $Channel)))
    foreach ($selectedPath in @($channelPath, $channelSignaturePath)) {
        if (-not (Test-RevAgentSnapshotPathUnderRoot -Path $selectedPath -Root $root)) { throw "Selected channel path escaped the release root: $selectedPath" }
    }
    $locks = [Collections.Generic.List[IO.FileStream]]::new()
    try {
        # The channel pair must be locked before the channel is parsed. Paths to
        # the manifest/package are derived only from those exact locked bytes.
        # The verifier can then reopen every pathname while the deny-write/delete
        # handles keep the complete signed set coherent.
        foreach ($path in @($channelPath, $channelSignaturePath)) {
            [void](Assert-RevAgentSnapshotPathNoLinks -Path $path -StopRoot $root -RequireLeaf)
            $locked = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            if ([RevAgent.ReleaseSnapshotNative]::GetLinkCount($locked.SafeFileHandle) -ne 1 -or
                ([RevAgent.ReleaseSnapshotNative]::GetAttributes($locked.SafeFileHandle) -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) {
                $locked.Dispose()
                throw "Signed release input must be an ordinary file with exactly one hardlink reference: $path"
            }
            $locks.Add($locked)
        }
        if ($null -ne $SignedSetLockedHook) { & $SignedSetLockedHook $channelPath $channelSignaturePath }
        $channelDocument = Read-RevAgentSnapshotLockedJson -Stream $locks[0] -Path $channelPath -MaxBytes 1048576
        [void](Read-RevAgentSnapshotLockedJson -Stream $locks[1] -Path $channelSignaturePath -MaxBytes 262144)
        $channelDirectory = Split-Path -Parent $channelPath
        $manifestPath = Resolve-RevAgentSnapshotRelativePath -RelativePath ([string]$channelDocument.manifestPath) -BaseDirectory $channelDirectory -Root $root
        $packagePath = Resolve-RevAgentSnapshotRelativePath -RelativePath ([string]$channelDocument.packagePath) -BaseDirectory $channelDirectory -Root $root
        $manifestSignaturePath = Join-Path (Split-Path -Parent $manifestPath) (([IO.Path]::GetFileNameWithoutExtension($manifestPath)) + '.sig.json')
        foreach ($path in @($manifestPath, $manifestSignaturePath, $packagePath)) {
            [void](Assert-RevAgentSnapshotPathNoLinks -Path $path -StopRoot $root -RequireLeaf)
            $locked = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            if ([RevAgent.ReleaseSnapshotNative]::GetLinkCount($locked.SafeFileHandle) -ne 1 -or
                ([RevAgent.ReleaseSnapshotNative]::GetAttributes($locked.SafeFileHandle) -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) {
                $locked.Dispose()
                throw "Signed release input must be an ordinary file with exactly one hardlink reference: $path"
            }
            $locks.Add($locked)
        }
        $manifestDocument = Read-RevAgentSnapshotLockedJson -Stream $locks[2] -Path $manifestPath -MaxBytes 4194304
        [void](Read-RevAgentSnapshotLockedJson -Stream $locks[3] -Path $manifestSignaturePath -MaxBytes 262144)
        $nodeMsi = Get-RevAgentSignedNodeMsiMetadata -Manifest $manifestDocument -ManifestPath $manifestPath -ReleaseRoot $root -AllowTestRoot:$AllowTestRoot
        [void](Assert-RevAgentSnapshotPathNoLinks -Path $nodeMsi.path -StopRoot (Split-Path -Parent $manifestPath) -RequireLeaf)
        $locks.Add([IO.FileStream]::new([string]$nodeMsi.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
        if ([RevAgent.ReleaseSnapshotNative]::GetLinkCount($locks[5].SafeFileHandle) -ne 1 -or
            ([RevAgent.ReleaseSnapshotNative]::GetAttributes($locks[5].SafeFileHandle) -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Signed Node.js MSI sidecar must be an ordinary file with exactly one hardlink reference: $($nodeMsi.path)"
        }

        [long]$declaredPackageSize = 0
        if ($null -eq $manifestDocument.package.PSObject.Properties['sizeBytes'] -or
            -not [long]::TryParse([string]$manifestDocument.package.sizeBytes, [ref]$declaredPackageSize) -or
            $declaredPackageSize -lt 1 -or $declaredPackageSize -gt 4294967296L) {
            throw 'Signed release package size declaration is missing or outside the 1..4294967296 byte policy.'
        }
        if ($locks[4].Length -ne $declaredPackageSize -or $locks[4].Length -gt 4294967296L) {
            throw "Signed release package size mismatch before hashing. expected=$declaredPackageSize actual=$($locks[4].Length)"
        }
        if ($locks[5].Length -ne [long]$nodeMsi.sizeBytes -or $locks[5].Length -gt 268435456L) {
            throw "Signed Node.js MSI size mismatch before hashing. expected=$($nodeMsi.sizeBytes) actual=$($locks[5].Length)"
        }
        $trust = Assert-RevAgentSnapshotTrustInputs -TrustedKeysPath $TrustedKeysPath -IntegrityModulePath $IntegrityModulePath -AllowTestRoot:$AllowTestRoot
        $integrityModule = Import-Module $IntegrityModulePath -Force -PassThru
        $integrityCommand = Get-Command ("{0}\Test-RevAgentReleaseDistributionIntegrity" -f $integrityModule.Name) -ErrorAction Stop
        $integrity = & $integrityCommand -ChannelPath $channelPath -Channel $channelDocument -ReleaseManifestPath $manifestPath -ReleaseManifest $manifestDocument -TrustedKeys $trust.keys.trustedKeys -Policy enforce -HighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence
        if (-not [bool]$integrity.success) { throw "Signed release verification failed: $($integrity.reason). $($integrity.message)" }
        $channelPolicy = Assert-RevAgentSignedChannelPolicy -ChannelDocument $channelDocument -RequestedChannel $Channel -MachineName $TestMachineName

        # Preserve the hashes of the exact deny-write/delete locked objects. The
        # caller may copy from a user-writable inbox only after these handles have
        # closed, so every later handle-bound copy must match this verified set.
        $signedSetSha256 = [ordered]@{
            channelManifest = Get-RevAgentSnapshotLockedStreamSha256 -Stream $locks[0]
            channelSignature = Get-RevAgentSnapshotLockedStreamSha256 -Stream $locks[1]
            releaseManifest = Get-RevAgentSnapshotLockedStreamSha256 -Stream $locks[2]
            releaseManifestSignature = Get-RevAgentSnapshotLockedStreamSha256 -Stream $locks[3]
            package = Get-RevAgentSnapshotLockedStreamSha256 -Stream $locks[4]
            nodeMsi = Get-RevAgentSnapshotLockedStreamSha256 -Stream $locks[5]
        }
        $packageHash = [string]$signedSetSha256.package
        $expectedPackageHash = [string]$channelDocument.sha256
        if ([string]::IsNullOrWhiteSpace($expectedPackageHash)) { $expectedPackageHash = [string]$manifestDocument.package.sha256 }
        if ([string]::IsNullOrWhiteSpace($expectedPackageHash) -or
            -not [string]::Equals($packageHash, $expectedPackageHash, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($packageHash, [string]$manifestDocument.package.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Signed release package SHA-256 mismatch. expected=$expectedPackageHash actual=$packageHash"
        }
        $packageSizeBytes = [long]$locks[4].Length
        if (-not [string]::Equals([string]$signedSetSha256.nodeMsi, [string]$nodeMsi.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Signed Node.js MSI SHA-256 mismatch. expected=$($nodeMsi.sha256) actual=$($signedSetSha256.nodeMsi)"
        }
        $nodeValidation = Test-RevAgentNodeMsi -Path $nodeMsi.path -ExpectedSha256 $nodeMsi.sha256 -ExpectedSizeBytes $nodeMsi.sizeBytes -AllowTestRoot:$AllowTestRoot
        if (-not $AllowTestRoot -and
            (-not [string]::Equals([string]$nodeValidation.signerSubject, [string]$nodeMsi.signerSubject, [StringComparison]::Ordinal) -or
                -not [string]::Equals([string]$nodeValidation.authenticodeStatus, [string]$nodeMsi.authenticodeStatus, [StringComparison]::Ordinal))) {
            throw 'Signed Node.js MSI Authenticode evidence does not match the signed manifest metadata.'
        }
        return [pscustomobject][ordered]@{
            root = $root
            channelPath = $channelPath
            channelSignaturePath = $channelSignaturePath
            manifestPath = $manifestPath
            manifestSignaturePath = $manifestSignaturePath
            packagePath = $packagePath
            nodeMsiPath = [string]$nodeMsi.path
            channel = $channelDocument
            manifest = $manifestDocument
            integrity = $integrity
            channelPolicy = $channelPolicy
            trust = $trust
            signedSetSha256 = $signedSetSha256
            packageSha256 = $packageHash
            packageSizeBytes = $packageSizeBytes
            nodeMsi = $nodeValidation
        }
    }
    finally {
        foreach ($stream in $locks) { $stream.Dispose() }
    }
}

function Test-RevAgentNodeMsi {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$ExpectedSha256 = $script:RevAgentNodeMsiSha256,
        [long]$ExpectedSizeBytes = 0,
        [switch]$AllowTestRoot
    )

    $fullPath = Assert-RevAgentSnapshotPathNoLinks -Path $Path -RequireLeaf
    $stream = [IO.FileStream]::new($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ([RevAgent.ReleaseSnapshotNative]::GetLinkCount($stream.SafeFileHandle) -ne 1) {
            throw "Bundled Node.js MSI must have exactly one hardlink reference: $fullPath"
        }
        if ($ExpectedSizeBytes -gt 0 -and $stream.Length -ne $ExpectedSizeBytes) {
            throw "Bundled Node.js MSI size mismatch. expected=$ExpectedSizeBytes actual=$($stream.Length)"
        }
        $actualHash = Get-RevAgentSnapshotLockedStreamSha256 -Stream $stream
        if (-not [string]::Equals($actualHash, $ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Bundled Node.js MSI hash mismatch. expected=$ExpectedSha256 actual=$actualHash"
        }
        $signature = $null
        if (-not $AllowTestRoot) {
            $signature = Get-AuthenticodeSignature -LiteralPath $fullPath
            if ($null -eq $signature -or $signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
                throw "Bundled Node.js MSI signature is not valid: $fullPath"
            }
            if (-not [string]::Equals([string]$signature.SignerCertificate.Subject, $script:RevAgentNodeMsiSignerSubject, [StringComparison]::Ordinal)) {
                throw "Bundled Node.js MSI signer mismatch. expected='$($script:RevAgentNodeMsiSignerSubject)' actual='$($signature.SignerCertificate.Subject)'"
            }
        }
        return [pscustomobject][ordered]@{
            relativePath = "external\$($script:RevAgentNodeMsiName)"
            sha256 = $actualHash
            sizeBytes = [long]$stream.Length
            signerSubject = if ($null -ne $signature) { [string]$signature.SignerCertificate.Subject } else { 'TEST-ONLY' }
            authenticodeStatus = if ($null -ne $signature) { [string]$signature.Status } else { 'TestBypass' }
        }
    }
    finally {
        $stream.Dispose()
    }
}

function New-RevAgentAuthenticatedReleaseInbox {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
        [Parameter(Mandatory = $true)][string]$IntegrityModulePath,
        [ValidateSet('stable', 'pilot')][string]$Channel = 'stable',
        [string]$InboxRoot = '',
        [long]$HighestAcceptedReleaseSequence = 0,
        [string]$ExpectedNodeMsiSha256 = '',
        [switch]$AllowTestRoot,
        [Parameter(DontShow = $true)][string]$TestMachineName = '',
        [Parameter(DontShow = $true)][scriptblock]$TestBeforeInboxChildCreateHook = $null
    )

    if ((-not [string]::IsNullOrWhiteSpace($TestMachineName) -or $null -ne $TestBeforeInboxChildCreateHook) -and -not $AllowTestRoot) {
        throw 'Release inbox test seams are available only for disposable test roots.'
    }

    $releaseRootFullPath = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
    if (-not $AllowTestRoot -and -not [string]::Equals($releaseRootFullPath, $script:RevAgentProductionReleaseRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Production release inbox acquisition requires '$($script:RevAgentProductionReleaseRoot)'."
    }
    if ([string]::IsNullOrWhiteSpace($InboxRoot)) {
        $InboxRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'DPE\revAgent\release-inbox'
    }
    $InboxRoot = [IO.Path]::GetFullPath($InboxRoot).TrimEnd('\')
    New-Item -ItemType Directory -Path $InboxRoot -Force | Out-Null
    [void](Assert-RevAgentSnapshotPathNoLinks -Path $InboxRoot)

    $source = Get-RevAgentVerifiedReleaseSet -ReleaseRoot $releaseRootFullPath -Channel $Channel -TrustedKeysPath $TrustedKeysPath -IntegrityModulePath $IntegrityModulePath -HighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence -AllowTestRoot:$AllowTestRoot -TestMachineName $TestMachineName
    $expectedAcquisitionPath = [IO.Path]::GetFullPath((Join-Path $releaseRootFullPath "channels\$Channel.json"))
    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$source.channelPath), $expectedAcquisitionPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Authenticated release acquisition channel path is not the exact selected canonical path. expected=$expectedAcquisitionPath actual=$($source.channelPath)"
    }
    $snapshotId = [Guid]::NewGuid().ToString('N')
    $inboxPath = Join-Path $InboxRoot $snapshotId
    if (Test-Path -LiteralPath $inboxPath) { throw "Release inbox collision: $inboxPath" }
    if ($null -ne $TestBeforeInboxChildCreateHook) { & $TestBeforeInboxChildCreateHook $inboxPath $source }
    New-Item -ItemType Directory -Path $inboxPath | Out-Null

    try {
        $channelRelative = "channels\$Channel.json"
        $channelSignatureRelative = "channels\$Channel.sig.json"
        $version = [string]$source.channel.version
        if ([string]::IsNullOrWhiteSpace($version) -or $version.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) { throw "Invalid signed release version: '$version'" }
        $releaseRelativeRoot = "releases\$version"
        $manifestRelative = Join-Path $releaseRelativeRoot 'manifest.json'
        $manifestSignatureRelative = Join-Path $releaseRelativeRoot 'manifest.sig.json'
        $packageLeaf = [IO.Path]::GetFileName([string]$source.channel.packagePath)
        if ([string]::IsNullOrWhiteSpace($packageLeaf)) { throw 'Signed package path has no file name.' }
        $packageRelative = Join-Path $releaseRelativeRoot $packageLeaf
        $nodeMsiRelative = Join-Path $releaseRelativeRoot ([string]$source.nodeMsi.relativePath)
        foreach ($directory in @('channels', $releaseRelativeRoot, (Join-Path $releaseRelativeRoot 'external'))) { New-Item -ItemType Directory -Path (Join-Path $inboxPath $directory) -Force | Out-Null }

        $effectiveNodeHash = if ([string]::IsNullOrWhiteSpace($ExpectedNodeMsiSha256)) { [string]$source.nodeMsi.sha256 } else { $ExpectedNodeMsiSha256.Trim().ToUpperInvariant() }
        if (-not $AllowTestRoot -and -not [string]::Equals($effectiveNodeHash, $script:RevAgentNodeMsiSha256, [StringComparison]::OrdinalIgnoreCase)) { throw 'Production Node.js MSI hash override is forbidden.' }
        if (-not [string]::Equals($effectiveNodeHash, [string]$source.nodeMsi.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Requested Node.js MSI hash does not match the signed manifest. requested=$effectiveNodeHash signed=$($source.nodeMsi.sha256)"
        }

        $files = [ordered]@{}
        $copyMap = [ordered]@{
            channelManifest = @($source.channelPath, $channelRelative, 1048576, $source.signedSetSha256.channelManifest)
            channelSignature = @($source.channelSignaturePath, $channelSignatureRelative, 1048576, $source.signedSetSha256.channelSignature)
            releaseManifest = @($source.manifestPath, $manifestRelative, 4194304, $source.signedSetSha256.releaseManifest)
            releaseManifestSignature = @($source.manifestSignaturePath, $manifestSignatureRelative, 1048576, $source.signedSetSha256.releaseManifestSignature)
            package = @($source.packagePath, $packageRelative, 4294967296, $source.packageSha256)
            nodeMsi = @($source.nodeMsiPath, $nodeMsiRelative, 268435456, $source.signedSetSha256.nodeMsi)
        }
        foreach ($entry in $copyMap.GetEnumerator()) {
            $files[$entry.Key] = Copy-RevAgentSnapshotFileHandleBound -SourcePath $entry.Value[0] -DestinationPath (Join-Path $inboxPath $entry.Value[1]) -MaxBytes ([long]$entry.Value[2]) -ExpectedSha256 ([string]$entry.Value[3])
        }

        $files.nodeMsi | Add-Member -NotePropertyName signerSubject -NotePropertyValue $source.nodeMsi.signerSubject
        $files.nodeMsi | Add-Member -NotePropertyName authenticodeStatus -NotePropertyValue $source.nodeMsi.authenticodeStatus

        # Verify the copied set, not the mutable source paths. If any path was
        # swapped after its handle-bound copy, signature/hash verification of
        # this coherent local set fails before UAC is requested.
        $copied = Get-RevAgentVerifiedReleaseSet -ReleaseRoot $inboxPath -Channel $Channel -TrustedKeysPath $TrustedKeysPath -IntegrityModulePath $IntegrityModulePath -HighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence -AllowTestRoot:$AllowTestRoot -TestMachineName $TestMachineName
        $state = [ordered]@{
            schemaVersion = 1
            app = 'revAgent'
            stateType = 'authenticated-release-inbox'
            transportTrust = 'signed_local_snapshot'
            inboxId = $snapshotId
            inboxRoot = $inboxPath
            createdAtUtc = [DateTime]::UtcNow.ToString('o')
            acquisitionChannelManifestPath = $source.channelPath
            channelPolicy = $copied.channelPolicy
            release = [ordered]@{
                channel = [string]$copied.channel.channel
                version = [string]$copied.channel.version
                releaseSequence = [long]$copied.integrity.releaseSequence
                minimumAcceptedReleaseSequence = [long]$copied.integrity.minimumAcceptedReleaseSequence
                highestAcceptedReleaseSequence = [long]$copied.integrity.highestAcceptedReleaseSequence
                channelManifestRelativePath = $channelRelative
                channelSignatureRelativePath = $channelSignatureRelative
                releaseManifestRelativePath = $manifestRelative
                releaseManifestSignatureRelativePath = $manifestSignatureRelative
                packageRelativePath = $packageRelative
                packageSha256 = $copied.packageSha256
                packageSizeBytes = $copied.packageSizeBytes
            }
            files = $files
        }
        Write-RevAgentSnapshotJsonCreateNew -Path (Join-Path $inboxPath 'inbox-state.json') -Value $state
        return [pscustomobject]$state
    }
    catch {
        if (Test-Path -LiteralPath $inboxPath) { Remove-Item -LiteralPath $inboxPath -Recurse -Force -ErrorAction SilentlyContinue }
        throw
    }
}

function New-RevAgentSnapshotDirectorySecurity {
    param(
        [switch]$AllowTestRoot,
        [switch]$SystemOnlySnapshot
    )
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $ownerSid = if ($AllowTestRoot) { [Security.Principal.WindowsIdentity]::GetCurrent().User } else { [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544') }
    $acl.SetOwner($ownerSid)
    $entries = [Collections.Generic.List[object]]::new()
    if ($AllowTestRoot) { $entries.Add([pscustomobject]@{ Sid = [string]$ownerSid.Value; Rights = [Security.AccessControl.FileSystemRights]::FullControl }) }
    else {
        $entries.Add([pscustomobject]@{ Sid = 'S-1-5-18'; Rights = [Security.AccessControl.FileSystemRights]::FullControl })
        $entries.Add([pscustomobject]@{ Sid = 'S-1-5-32-544'; Rights = [Security.AccessControl.FileSystemRights]::FullControl })
    }
    if (-not $SystemOnlySnapshot) {
        $entries.Add([pscustomobject]@{ Sid = 'S-1-5-32-545'; Rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute })
    }
    foreach ($entry in $entries) {
        [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new([string]$entry.Sid),
                [Security.AccessControl.FileSystemRights]$entry.Rights,
                ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    return $acl
}

function Set-RevAgentSnapshotItemSecurity {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$AllowTestRoot,
        [switch]$SystemOnlySnapshot
    )

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $ownerSid = if ($AllowTestRoot) { [Security.Principal.WindowsIdentity]::GetCurrent().User } else { [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544') }
    $acl.SetOwner($ownerSid)
    $entries = [Collections.Generic.List[object]]::new()
    if ($AllowTestRoot) { $entries.Add([pscustomobject]@{ Sid = [string]$ownerSid.Value; Rights = [Security.AccessControl.FileSystemRights]::FullControl }) }
    else {
        $entries.Add([pscustomobject]@{ Sid = 'S-1-5-18'; Rights = [Security.AccessControl.FileSystemRights]::FullControl })
        $entries.Add([pscustomobject]@{ Sid = 'S-1-5-32-544'; Rights = [Security.AccessControl.FileSystemRights]::FullControl })
    }
    if (-not $SystemOnlySnapshot) {
        $entries.Add([pscustomobject]@{ Sid = 'S-1-5-32-545'; Rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute })
    }
    foreach ($entry in $entries) {
        $inheritance = if ($item.PSIsContainer) {
            [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        }
        else { [Security.AccessControl.InheritanceFlags]::None }
        [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new([string]$entry.Sid),
                [Security.AccessControl.FileSystemRights]$entry.Rights,
                $inheritance,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    if ('System.IO.FileSystemAclExtensions' -as [type]) {
        if ($item.PSIsContainer) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item, [Security.AccessControl.DirectorySecurity]$acl) }
        else { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]$item, [Security.AccessControl.FileSecurity]$acl) }
    }
    elseif ($item.PSIsContainer) { ([IO.DirectoryInfo]$item).SetAccessControl([Security.AccessControl.DirectorySecurity]$acl) }
    else { ([IO.FileInfo]$item).SetAccessControl([Security.AccessControl.FileSecurity]$acl) }
}

function New-RevAgentProtectedSnapshotChild {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$AllowTestRoot,
        [switch]$SystemOnlySnapshot
    )
    [void](Assert-RevAgentSnapshotPathNoLinks -Path $Parent)
    $path = Join-Path $Parent $Name
    if (Test-Path -LiteralPath $path) { throw "Protected snapshot child already exists: $path" }
    $security = New-RevAgentSnapshotDirectorySecurity -AllowTestRoot:$AllowTestRoot -SystemOnlySnapshot:$SystemOnlySnapshot
    $parentInfo = [IO.DirectoryInfo]::new($Parent)
    $aclCreateOverload = @($parentInfo.GetType().GetMethods() | Where-Object {
            $_.Name -eq 'CreateSubdirectory' -and $_.GetParameters().Count -eq 2
        } | Select-Object -First 1)
    if ($aclCreateOverload.Count -gt 0) {
        [void]$parentInfo.CreateSubdirectory($Name, $security)
    }
    elseif ('System.IO.FileSystemAclExtensions' -as [type]) {
        [void][IO.FileSystemAclExtensions]::CreateDirectory($security, $path)
    }
    else {
        throw 'No ACL-at-create directory API is available for the protected release snapshot.'
    }
    [void](Assert-RevAgentSnapshotPathNoLinks -Path $path)
    return [IO.Path]::GetFullPath($path)
}

function Open-RevAgentSnapshotDirectoryGuard {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $handle = $null
    try {
        $handle = [RevAgent.ReleaseSnapshotNative]::OpenDirectoryNoDeleteShare($fullPath)
        $attributes = [uint32][RevAgent.ReleaseSnapshotNative]::GetAttributes($handle)
        if (($attributes -band [uint32][IO.FileAttributes]::Directory) -eq 0 -or
            ($attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Protected snapshot parent is not an ordinary directory: $fullPath"
        }
        return [pscustomobject]@{
            Path = $fullPath
            Handle = $handle
            Identity = [string][RevAgent.ReleaseSnapshotNative]::GetIdentity($handle)
        }
    }
    catch {
        if ($null -ne $handle) { $handle.Dispose() }
        throw
    }
}

function Assert-RevAgentSnapshotDirectoryGuard {
    param(
        [Parameter(Mandatory = $true)][object]$Guard,
        [switch]$AllowTestRoot
    )

    $pathHandle = $null
    try {
        # Guard.Handle omits FILE_SHARE_DELETE. This second handle binds the
        # pathname and ACL inspection to the exact object that cannot be
        # renamed/deleted until snapshot promotion finishes.
        $pathHandle = [RevAgent.ReleaseSnapshotNative]::OpenDirectoryNoDeleteShare([string]$Guard.Path)
        $attributes = [uint32][RevAgent.ReleaseSnapshotNative]::GetAttributes($pathHandle)
        $pathIdentity = [string][RevAgent.ReleaseSnapshotNative]::GetIdentity($pathHandle)
        if (($attributes -band [uint32][IO.FileAttributes]::Directory) -eq 0 -or
            ($attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not [string]::Equals($pathIdentity, [string]$Guard.Identity, [StringComparison]::Ordinal)) {
            throw "Protected snapshot parent path/handle identity changed: $($Guard.Path)"
        }
    }
    finally { if ($null -ne $pathHandle) { $pathHandle.Dispose() } }

    [void](Assert-RevAgentSnapshotPathNoLinks -Path ([string]$Guard.Path))
    $item = Get-Item -LiteralPath ([string]$Guard.Path) -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "Protected snapshot parent is not a directory: $($Guard.Path)" }
    $acl = Get-Acl -LiteralPath ([string]$Guard.Path) -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected) { throw "Protected snapshot parent DACL must not inherit: $($Guard.Path)" }
    $trustedWriters = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) { [void]$trustedWriters.Add($sid) }
    if ($AllowTestRoot) { [void]$trustedWriters.Add([string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value) }
    $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (-not $trustedWriters.Contains($ownerSid)) { throw "Protected snapshot parent owner is not trusted. path=$($Guard.Path) owner=$ownerSid" }
    $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $sid = [string]$rule.IdentityReference.Value
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            -not $trustedWriters.Contains($sid) -and (($rule.FileSystemRights -band $writeMask) -ne 0)) {
            throw "Protected snapshot parent grants write/delete/ACL capability to an untrusted principal. path=$($Guard.Path) principal=$sid rights=$($rule.FileSystemRights)"
        }
    }
    return $true
}

function Initialize-RevAgentProtectedSnapshotParent {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$AllowTestRoot
    )

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    [void](Assert-RevAgentSnapshotPathNoLinks -Path $fullPath)
    if (-not (Test-Path -LiteralPath $fullPath)) {
        $ancestor = Split-Path -Parent $fullPath
        if (-not (Test-Path -LiteralPath $ancestor -PathType Container)) { throw "Protected snapshot parent ancestor is missing: $ancestor" }
        [void](Assert-RevAgentSnapshotPathNoLinks -Path $ancestor)
        $ancestorGuard = $null
        try {
            $ancestorGuard = Open-RevAgentSnapshotDirectoryGuard -Path $ancestor
            # Production snapshot creation is permitted only below the already
            # protected revAgent product root. Disposable test roots deliberately
            # trust their current-user ancestor but still require the new exact
            # snapshot parent to be ACL-at-create protected.
            if (-not $AllowTestRoot) { [void](Assert-RevAgentSnapshotDirectoryGuard -Guard $ancestorGuard) }
            [void](New-RevAgentProtectedSnapshotChild -Parent $ancestor -Name (Split-Path -Leaf $fullPath) -AllowTestRoot:$AllowTestRoot)
        }
        finally { if ($null -ne $ancestorGuard -and $null -ne $ancestorGuard.Handle) { $ancestorGuard.Handle.Dispose() } }
    }

    $guard = Open-RevAgentSnapshotDirectoryGuard -Path $fullPath
    try {
        [void](Assert-RevAgentSnapshotDirectoryGuard -Guard $guard -AllowTestRoot:$AllowTestRoot)
        return $guard
    }
    catch {
        $guard.Handle.Dispose()
        throw
    }
}

function Assert-RevAgentProtectedSnapshotParent {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$AllowTestRoot)
    $guard = $null
    try {
        $guard = Open-RevAgentSnapshotDirectoryGuard -Path $Path
        return (Assert-RevAgentSnapshotDirectoryGuard -Guard $guard -AllowTestRoot:$AllowTestRoot)
    }
    finally { if ($null -ne $guard -and $null -ne $guard.Handle) { $guard.Handle.Dispose() } }
}

function Get-RevAgentDirectoryTreeHash {
    param([Parameter(Mandatory = $true)][string]$Path)
    $relativePaths = [Collections.Generic.List[string]]::new()
    Get-ChildItem -LiteralPath $Path -Recurse -File -Force | Where-Object {
        $relative = $_.FullName.Substring($Path.Length).TrimStart('\', '/')
        $parts = $relative -split '[\\/]'
        $_.Name -notin @('.revagent-npm-dependencies.json', '.npm-deps.sha256') -and
            -not (@($parts | Where-Object { $_ -in @('node_modules', '.git') }).Count -gt 0)
    } | ForEach-Object {
        [void]$relativePaths.Add($_.FullName.Substring($Path.Length).TrimStart('\', '/').Replace('\', '/'))
    }
    # Match the signed producer independent of PowerShell/.NET collation rules.
    $orderedRelativePaths = $relativePaths.ToArray()
    [Array]::Sort($orderedRelativePaths, [StringComparer]::Ordinal)
    $lines = [Collections.Generic.List[string]]::new()
    foreach ($relative in $orderedRelativePaths) {
        $relativeOnDisk = $relative.Replace([char]'/', [IO.Path]::DirectorySeparatorChar)
        $filePath = Join-Path $Path $relativeOnDisk
        $file = Get-Item -LiteralPath $filePath -Force
        $lines.Add(("{0}|{1}|{2}" -f $relative, $file.Length, (Get-RevAgentSnapshotFileSha256 -Path $filePath)))
    }
    return [pscustomobject]@{ sha256 = Get-RevAgentSnapshotSha256Bytes -Bytes ([Text.Encoding]::UTF8.GetBytes(($lines.ToArray() -join "`n"))); fileCount = $lines.Count }
}

function Expand-RevAgentSnapshotArchiveSecure {
    param(
        [Parameter(Mandatory = $true)][string]$ZipPath,
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [int]$MaxEntries = 100000,
        [long]$MaxEntryBytes = 1073741824,
        [long]$MaxTotalBytes = 8589934592
    )

    Add-Type -AssemblyName System.IO.Compression
    $destinationRoot = [IO.Path]::GetFullPath($DestinationPath).TrimEnd('\') + '\'
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $stream = [IO.FileStream]::new($ZipPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false)
        try {
            if ($archive.Entries.Count -gt $MaxEntries) { throw "Signed package has too many archive entries: $($archive.Entries.Count)" }
            [long]$declaredTotal = 0
            foreach ($entry in $archive.Entries) {
                $rawName = [string]$entry.FullName
                if ([string]::IsNullOrWhiteSpace($rawName)) { continue }
                $normalized = $rawName.Replace('/', '\')
                if ($normalized.StartsWith('\') -or [IO.Path]::IsPathRooted($normalized) -or $normalized.Contains(':') -or $normalized.IndexOf([char]0) -ge 0) {
                    throw "Unsafe archive entry path: $rawName"
                }
                $segments = @($normalized -split '\\')
                if (@($segments | Where-Object { $_ -eq '..' -or $_ -eq '.' -or [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -and -not $normalized.EndsWith('\')) {
                    throw "Unsafe archive entry segments: $rawName"
                }
                $key = $normalized.TrimEnd('\')
                if (-not [string]::IsNullOrWhiteSpace($key) -and -not $seen.Add($key)) { throw "Duplicate/case-colliding archive entry: $rawName" }
                $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
                if ($unixType -eq 0xA000) { throw "Archive symbolic-link entry is forbidden: $rawName" }
                if ($entry.Length -gt $MaxEntryBytes) { throw "Archive entry exceeds byte bound: $rawName" }
                $declaredTotal += [long]$entry.Length
                if ($declaredTotal -gt $MaxTotalBytes) { throw 'Archive declared extraction size exceeds the total byte bound.' }
                $target = [IO.Path]::GetFullPath((Join-Path $DestinationPath $normalized))
                if (-not $target.StartsWith($destinationRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Archive entry escaped snapshot payload: $rawName" }
                if ($normalized.EndsWith('\')) {
                    New-Item -ItemType Directory -Path $target -Force | Out-Null
                    continue
                }
                New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
                $entryStream = $entry.Open()
                $targetStream = $null
                try {
                    $targetStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                    $buffer = New-Object byte[] 1048576
                    [long]$written = 0
                    while (($read = $entryStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $written += $read
                        if ($written -gt $entry.Length -or $written -gt $MaxEntryBytes) { throw "Archive entry expanded beyond its declared bound: $rawName" }
                        $targetStream.Write($buffer, 0, $read)
                    }
                    if ($written -ne $entry.Length) { throw "Archive entry length mismatch: $rawName" }
                    $targetStream.Flush($true)
                }
                finally {
                    if ($null -ne $targetStream) { $targetStream.Dispose() }
                    $entryStream.Dispose()
                }
            }
        }
        finally { $archive.Dispose() }
    }
    finally { $stream.Dispose() }
}

function Get-RevAgentSnapshotComponentState {
    param([Parameter(Mandatory = $true)][object]$Manifest, [Parameter(Mandatory = $true)][string]$PayloadRoot, [Parameter(Mandatory = $true)][string]$SnapshotRoot)
    $result = [ordered]@{}
    foreach ($property in $Manifest.components.PSObject.Properties) {
        $component = $property.Value
        if ($null -eq $component -or [string]::IsNullOrWhiteSpace([string]$component.path) -or [string]::IsNullOrWhiteSpace([string]$component.sha256)) { continue }
        $componentPath = Resolve-RevAgentSnapshotRelativePath -RelativePath ([string]$component.path) -BaseDirectory $PayloadRoot -Root $PayloadRoot
        if (Test-Path -LiteralPath $componentPath -PathType Leaf) {
            $actualHash = Get-RevAgentSnapshotFileSha256 -Path $componentPath
            if (-not [string]::Equals($actualHash, [string]$component.sha256, [StringComparison]::OrdinalIgnoreCase)) { throw "Snapshot payload component hash mismatch: $($property.Name)" }
            if ($component.PSObject.Properties['sizeBytes'] -and [long]$component.sizeBytes -ne [long](Get-Item -LiteralPath $componentPath).Length) { throw "Snapshot payload component size mismatch: $($property.Name)" }
        }
        elseif (Test-Path -LiteralPath $componentPath -PathType Container) {
            $tree = Get-RevAgentDirectoryTreeHash -Path $componentPath
            if (-not [string]::Equals($tree.sha256, [string]$component.sha256, [StringComparison]::OrdinalIgnoreCase)) { throw "Snapshot payload component tree hash mismatch: $($property.Name)" }
            if ($component.PSObject.Properties['fileCount'] -and [int]$component.fileCount -ne [int]$tree.fileCount) { throw "Snapshot payload component file-count mismatch: $($property.Name)" }
        }
        else { throw "Snapshot payload component was not extracted: $($property.Name) path=$($component.path)" }
        $relative = $componentPath.Substring($SnapshotRoot.Length).TrimStart('\')
        $result[$property.Name] = [ordered]@{ path = [string]$component.path; snapshotRelativePath = $relative; sha256 = [string]$component.sha256 }
    }
    return $result
}

function Read-RevAgentProtectedReleaseSnapshotState {
    param(
        [Parameter(Mandatory = $true)][string]$SnapshotRoot,
        [switch]$RequireSystemOnly
    )

    $root = [IO.Path]::GetFullPath($SnapshotRoot).TrimEnd('\')
    $statePath = Assert-RevAgentSnapshotPathNoLinks -Path (Join-Path $root 'snapshot-state.json') -StopRoot $root -RequireLeaf
    $stream = $null
    try {
        $stream = [IO.FileStream]::new($statePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $attributes = [uint32][RevAgent.ReleaseSnapshotNative]::GetAttributes($stream.SafeFileHandle)
        if (($attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0 -or
            ($attributes -band [uint32][IO.FileAttributes]::Directory) -ne 0) {
            throw "Protected release snapshot state must be an ordinary non-reparse file: $statePath"
        }
        $linkCount = [uint32][RevAgent.ReleaseSnapshotNative]::GetLinkCount($stream.SafeFileHandle)
        if ($linkCount -ne 1) { throw "Protected release snapshot state must have exactly one hardlink reference. path=$statePath linkCount=$linkCount" }
        $state = Read-RevAgentSnapshotLockedJson -Stream $stream -Path $statePath -MaxBytes 4194304
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }

    $requiredFields = @(
        'schemaVersion', 'app', 'stateType', 'transportTrust', 'snapshotId', 'snapshotRoot', 'createdAtUtc',
        'acquisitionChannelManifestPath', 'channelPolicy', 'release', 'trust', 'execution', 'components', 'externalDependencies'
    )
    $hasAccessPolicy = $null -ne $state.PSObject.Properties['accessPolicy']
    if ($hasAccessPolicy) { $requiredFields += 'accessPolicy' }
    Assert-RevAgentSnapshotExactProperties -Value $state -Names $requiredFields -Label 'Protected release snapshot state'

    $systemOnly = $hasAccessPolicy -and [string]$state.accessPolicy -ceq $script:RevAgentSystemOnlySnapshotAccessPolicy
    if ($hasAccessPolicy -and -not $systemOnly) { throw "Protected release snapshot accessPolicy is unsupported: $($state.accessPolicy)" }
    if ($RequireSystemOnly -and -not $systemOnly) { throw 'Protected release snapshot is not bound to the system-only bootstrap-trust access policy.' }
    if ([int]$state.schemaVersion -ne 1 -or
        [string]$state.app -cne 'revAgent' -or
        [string]$state.stateType -cne 'authenticated-release-snapshot' -or
        [string]$state.transportTrust -cne 'signed_local_snapshot') {
        throw 'Protected release snapshot state contract is invalid.'
    }
    $createdAt = [DateTimeOffset]::MinValue
    if ([string]$state.createdAtUtc -cnotmatch 'Z$' -or
        -not [DateTimeOffset]::TryParse([string]$state.createdAtUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$createdAt)) {
        throw 'Protected release snapshot createdAtUtc must be an ISO UTC timestamp.'
    }
    $boundRoot = ''
    try { $boundRoot = [IO.Path]::GetFullPath([string]$state.snapshotRoot).TrimEnd('\') }
    catch { throw 'Protected release snapshot root state is not a valid absolute path.' }
    if ([string]$state.snapshotId -cnotmatch '^[a-f0-9]{32}$' -or
        -not [string]::Equals([IO.Path]::GetFileName($root), [string]$state.snapshotId, [StringComparison]::Ordinal) -or
        -not [string]::Equals($boundRoot, $root, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Protected release snapshot identity/path/leaf contract is invalid.'
    }
    return [pscustomobject][ordered]@{
        state = $state
        statePath = $statePath
        accessPolicy = if ($systemOnly) { $script:RevAgentSystemOnlySnapshotAccessPolicy } else { 'authenticated-users-read' }
        systemOnly = [bool]$systemOnly
    }
}

function Assert-RevAgentProtectedReleaseSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$SnapshotRoot,
        [switch]$AllowTestRoot,
        [switch]$SystemOnlySnapshot
    )

    $root = [IO.Path]::GetFullPath($SnapshotRoot).TrimEnd('\')
    [void](Assert-RevAgentSnapshotPathNoLinks -Path $root)
    $stateEvidence = Read-RevAgentProtectedReleaseSnapshotState -SnapshotRoot $root -RequireSystemOnly:$SystemOnlySnapshot
    $enforceSystemOnly = [bool]$stateEvidence.systemOnly
    $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer) { throw "Protected release snapshot root is not a directory: $root" }
    $rootAcl = Get-Acl -LiteralPath $root -ErrorAction Stop
    if (-not $rootAcl.AreAccessRulesProtected) { throw "Protected release snapshot root DACL must not inherit: $root" }
    $trustedWriters = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) { [void]$trustedWriters.Add($sid) }
    if ($AllowTestRoot) { [void]$trustedWriters.Add([string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value) }
    $ownerSid = [string]$rootAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (-not $trustedWriters.Contains($ownerSid)) { throw "Protected release snapshot root owner is not trusted: $ownerSid" }
    $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    $readMask = [Security.AccessControl.FileSystemRights]::ReadData -bor
        [Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::ReadAttributes -bor
        [Security.AccessControl.FileSystemRights]::ReadPermissions -bor
        [Security.AccessControl.FileSystemRights]::ExecuteFile
    foreach ($item in @($rootItem) + @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop)) {
        $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) { throw "Protected release snapshot contains a filesystem link: $($item.FullName)" }
        if (-not $item.PSIsContainer) {
            $stream = [IO.FileStream]::new($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
                $linkCount = [uint32][RevAgent.ReleaseSnapshotNative]::GetLinkCount($stream.SafeFileHandle)
                if ($linkCount -ne 1) { throw "Protected release snapshot file must have exactly one hardlink reference. path=$($item.FullName) linkCount=$linkCount" }
            }
            finally { $stream.Dispose() }
        }
        $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
        $itemOwnerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if (-not $trustedWriters.Contains($itemOwnerSid) -or -not $acl.AreAccessRulesProtected) {
            throw "Protected release snapshot item owner/DACL is not trusted. path=$($item.FullName) owner=$itemOwnerSid"
        }
        $builtinUsersReadable = $false
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            $sid = [string]$rule.IdentityReference.Value
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                [string]::Equals($sid, 'S-1-5-32-545', [StringComparison]::OrdinalIgnoreCase) -and
                (($rule.FileSystemRights -band $readMask) -ne 0)) {
                $builtinUsersReadable = $true
            }
            if ($enforceSystemOnly -and
                $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                -not $trustedWriters.Contains($sid)) {
                throw "System-only protected release snapshot grants access to an untrusted principal. path=$($item.FullName) principal=$sid rights=$($rule.FileSystemRights)"
            }
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                -not $trustedWriters.Contains($sid) -and (($rule.FileSystemRights -band $writeMask) -ne 0)) {
                throw "Protected release snapshot grants write/delete/ACL capability to an untrusted principal. path=$($item.FullName) principal=$sid rights=$($rule.FileSystemRights)"
            }
        }
        if (-not $enforceSystemOnly -and -not $builtinUsersReadable) {
            throw "Protected release snapshot default access policy requires BUILTIN Users read access. path=$($item.FullName)"
        }
    }
    return $true
}

function Test-RevAgentSystemOnlyReleaseSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$SnapshotRoot,
        [switch]$AllowTestRoot
    )

    try { return [bool](Assert-RevAgentProtectedReleaseSnapshot -SnapshotRoot $SnapshotRoot -AllowTestRoot:$AllowTestRoot -SystemOnlySnapshot) }
    catch { return $false }
}

function Get-RevAgentCanonicalProtectedSnapshotParent {
    param([switch]$SystemOnlySnapshot)

    $relativePath = if ($SystemOnlySnapshot) { 'DPE\revAgent\bootstrap-broker\snapshots' } else { 'DPE\revAgent\execution-snapshots' }
    return [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) $relativePath)).TrimEnd('\')
}

function New-RevAgentProtectedReleaseSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InboxPath,
        [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
        [Parameter(Mandatory = $true)][string]$IntegrityModulePath,
        [string]$SnapshotParent = '',
        [ValidateSet('stable', 'pilot')][string]$Channel = 'stable',
        [long]$HighestAcceptedReleaseSequence = 0,
        [string]$ExpectedNodeMsiSha256 = '',
        [switch]$AllowTestRoot,
        [switch]$SystemOnlySnapshot,
        [scriptblock]$VerifiedInboxReleasedHook = $null,
        [scriptblock]$SnapshotParentLockedHook = $null,
        [Parameter(DontShow = $true)][string]$TestMachineName = ''
    )

    if (($null -ne $VerifiedInboxReleasedHook -or $null -ne $SnapshotParentLockedHook -or -not [string]::IsNullOrWhiteSpace($TestMachineName)) -and -not $AllowTestRoot) {
        throw 'Snapshot race hooks are available only for disposable test roots.'
    }
    if (-not $AllowTestRoot) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Protected release snapshot creation requires elevation.' }
    }
    $inbox = [IO.Path]::GetFullPath($InboxPath).TrimEnd('\')
    [void](Assert-RevAgentSnapshotPathNoLinks -Path $inbox)
    $inboxState = Read-RevAgentSnapshotInboxState -InboxPath $inbox -Channel $Channel
    $snapshotId = [string]$inboxState.inboxId
    if (-not $AllowTestRoot) {
        $expectedAcquisitionPath = [IO.Path]::GetFullPath((Join-Path $script:RevAgentProductionReleaseRoot "channels\$Channel.json"))
        if (-not [string]::Equals([IO.Path]::GetFullPath([string]$inboxState.acquisitionChannelManifestPath), $expectedAcquisitionPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Production inbox acquisition path is not the exact canonical selected channel. expected=$expectedAcquisitionPath actual=$($inboxState.acquisitionChannelManifestPath)"
        }
    }

    $verified = Get-RevAgentVerifiedReleaseSet -ReleaseRoot $inbox -Channel $Channel -TrustedKeysPath $TrustedKeysPath -IntegrityModulePath $IntegrityModulePath -HighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence -AllowTestRoot:$AllowTestRoot -TestMachineName $TestMachineName
    if ($null -ne $VerifiedInboxReleasedHook) { & $VerifiedInboxReleasedHook $verified }
    $canonicalSnapshotParent = Get-RevAgentCanonicalProtectedSnapshotParent -SystemOnlySnapshot:$SystemOnlySnapshot
    if ([string]::IsNullOrWhiteSpace($SnapshotParent)) { $SnapshotParent = $canonicalSnapshotParent }
    $SnapshotParent = [IO.Path]::GetFullPath($SnapshotParent).TrimEnd('\')
    if (-not $AllowTestRoot) {
        $canonicalParent = [IO.Path]::GetFullPath($canonicalSnapshotParent).TrimEnd('\')
        if (-not [string]::Equals($SnapshotParent, $canonicalParent, [StringComparison]::OrdinalIgnoreCase)) { throw "Production snapshot parent must be '$canonicalParent'." }
        $productRoot = Split-Path -Parent $SnapshotParent
        if (-not (Test-Path -LiteralPath $productRoot -PathType Container)) { throw "Protected revAgent product root is missing: $productRoot" }
    }

    $parentGuard = $null
    $stage = ''
    $final = Join-Path $SnapshotParent $snapshotId
    try {
        $parentGuard = Initialize-RevAgentProtectedSnapshotParent -Path $SnapshotParent -AllowTestRoot:$AllowTestRoot
        if ($null -ne $SnapshotParentLockedHook) { & $SnapshotParentLockedHook $parentGuard }
        [void](Assert-RevAgentSnapshotDirectoryGuard -Guard $parentGuard -AllowTestRoot:$AllowTestRoot)
        if (Test-Path -LiteralPath $final) { throw "Protected release snapshot already exists: $final" }
        $stageName = if ($SystemOnlySnapshot) { ".bootstrap-trust-stage-$snapshotId" } else { ".stage-$snapshotId" }
        $stage = New-RevAgentProtectedSnapshotChild -Parent $SnapshotParent -Name $stageName -AllowTestRoot:$AllowTestRoot -SystemOnlySnapshot:$SystemOnlySnapshot
        [void](Assert-RevAgentSnapshotDirectoryGuard -Guard $parentGuard -AllowTestRoot:$AllowTestRoot)
        foreach ($directory in @('channels', 'releases', 'trust', 'payload')) { New-Item -ItemType Directory -Path (Join-Path $stage $directory) -Force | Out-Null }
        $version = [string]$verified.channel.version
        $releaseRelativeRoot = "releases\$version"
        New-Item -ItemType Directory -Path (Join-Path $stage $releaseRelativeRoot) -Force | Out-Null
        $packageLeaf = [IO.Path]::GetFileName($verified.packagePath)
        $copyMap = [ordered]@{
            channelManifest = @($verified.channelPath, "channels\$Channel.json", 1048576, $verified.signedSetSha256.channelManifest)
            channelSignature = @($verified.channelSignaturePath, "channels\$Channel.sig.json", 1048576, $verified.signedSetSha256.channelSignature)
            releaseManifest = @($verified.manifestPath, "$releaseRelativeRoot\manifest.json", 4194304, $verified.signedSetSha256.releaseManifest)
            releaseManifestSignature = @($verified.manifestSignaturePath, "$releaseRelativeRoot\manifest.sig.json", 1048576, $verified.signedSetSha256.releaseManifestSignature)
            package = @($verified.packagePath, "$releaseRelativeRoot\$packageLeaf", 4294967296, $verified.packageSha256)
            nodeMsiReleaseSidecar = @($verified.nodeMsiPath, "$releaseRelativeRoot\$($verified.nodeMsi.relativePath)", 268435456, $verified.signedSetSha256.nodeMsi)
            trustedKeys = @($TrustedKeysPath, 'trust\release-trusted-keys.json', 1048576, $verified.trust.trustedKeysSha256)
            verifier = @($IntegrityModulePath, 'trust\RevAgent.DistributionIntegrity.psm1', 4194304, $verified.trust.verifierSha256)
        }
        $copied = [ordered]@{}
        foreach ($entry in $copyMap.GetEnumerator()) {
            $destination = Join-Path $stage $entry.Value[1]
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            $copied[$entry.Key] = Copy-RevAgentSnapshotFileHandleBound -SourcePath $entry.Value[0] -DestinationPath $destination -MaxBytes ([long]$entry.Value[2]) -ExpectedSha256 ([string]$entry.Value[3])
        }
        $payloadRoot = Join-Path $stage 'payload'
        Expand-RevAgentSnapshotArchiveSecure -ZipPath (Join-Path $stage "$releaseRelativeRoot\$packageLeaf") -DestinationPath $payloadRoot
        $componentState = Get-RevAgentSnapshotComponentState -Manifest $verified.manifest -PayloadRoot $payloadRoot -SnapshotRoot $stage

        $effectiveNodeHash = if ([string]::IsNullOrWhiteSpace($ExpectedNodeMsiSha256)) { [string]$verified.nodeMsi.sha256 } else { $ExpectedNodeMsiSha256.Trim().ToUpperInvariant() }
        if (-not $AllowTestRoot -and -not [string]::Equals($effectiveNodeHash, $script:RevAgentNodeMsiSha256, [StringComparison]::OrdinalIgnoreCase)) { throw 'Production Node.js MSI hash override is forbidden.' }
        if (-not [string]::Equals($effectiveNodeHash, [string]$verified.nodeMsi.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Requested Node.js MSI hash does not match the verified signed inbox. requested=$effectiveNodeHash signed=$($verified.nodeMsi.sha256)"
        }
        $nodeRelative = "payload\installer\nas\dependencies\$($script:RevAgentNodeMsiName)"
        $nodeDestination = Join-Path $stage $nodeRelative
        New-Item -ItemType Directory -Path (Split-Path -Parent $nodeDestination) -Force | Out-Null
        [void](Copy-RevAgentSnapshotFileHandleBound -SourcePath $verified.nodeMsiPath -DestinationPath $nodeDestination -MaxBytes 268435456 -ExpectedSha256 $verified.nodeMsi.sha256)
        $externalDependencies = [ordered]@{
            nodeMsi = [ordered]@{
                releaseRelativePath = "$releaseRelativeRoot\$($verified.nodeMsi.relativePath)"
                snapshotRelativePath = $nodeRelative
                sha256 = [string]$verified.nodeMsi.sha256
                sizeBytes = [long]$verified.nodeMsi.sizeBytes
                signerSubject = [string]$verified.nodeMsi.signerSubject
                authenticodeStatus = [string]$verified.nodeMsi.authenticodeStatus
            }
        }

        $state = [ordered]@{
            schemaVersion = 1
            app = 'revAgent'
            stateType = 'authenticated-release-snapshot'
            transportTrust = 'signed_local_snapshot'
            snapshotId = $snapshotId
            snapshotRoot = $final
            createdAtUtc = [DateTime]::UtcNow.ToString('o')
            acquisitionChannelManifestPath = [string]$inboxState.acquisitionChannelManifestPath
            channelPolicy = $verified.channelPolicy
            release = [ordered]@{
                channel = [string]$verified.channel.channel
                version = $version
                releaseSequence = [long]$verified.integrity.releaseSequence
                minimumAcceptedReleaseSequence = [long]$verified.integrity.minimumAcceptedReleaseSequence
                highestAcceptedReleaseSequence = [long]$verified.integrity.highestAcceptedReleaseSequence
                channelManifestRelativePath = "channels\$Channel.json"
                channelSignatureRelativePath = "channels\$Channel.sig.json"
                releaseManifestRelativePath = "$releaseRelativeRoot\manifest.json"
                releaseManifestSignatureRelativePath = "$releaseRelativeRoot\manifest.sig.json"
                packageRelativePath = "$releaseRelativeRoot\$packageLeaf"
                channelManifestSha256 = $copied.channelManifest.sha256
                channelSignatureSha256 = $copied.channelSignature.sha256
                releaseManifestSha256 = $copied.releaseManifest.sha256
                releaseManifestSignatureSha256 = $copied.releaseManifestSignature.sha256
                packageSha256 = $verified.packageSha256
                packageSizeBytes = $verified.packageSizeBytes
            }
            trust = [ordered]@{
                trustedKeysRelativePath = 'trust\release-trusted-keys.json'
                trustedKeysSha256 = $copied.trustedKeys.sha256
                productionKeyFingerprint = $verified.trust.productionKeyFingerprint
                verifierRelativePath = 'trust\RevAgent.DistributionIntegrity.psm1'
                verifierSha256 = $copied.verifier.sha256
                signaturesVerified = $true
            }
            execution = [ordered]@{ payloadRootRelativePath = 'payload' }
            components = $componentState
            externalDependencies = $externalDependencies
        }
        if ($SystemOnlySnapshot) { $state.Insert(4, 'accessPolicy', $script:RevAgentSystemOnlySnapshotAccessPolicy) }
        Write-RevAgentSnapshotJsonCreateNew -Path (Join-Path $stage 'snapshot-state.json') -Value $state
        $snapshotItems = @(Get-ChildItem -LiteralPath $stage -Recurse -Force -ErrorAction Stop) + @(Get-Item -LiteralPath $stage -Force -ErrorAction Stop)
        foreach ($item in @($snapshotItems | Sort-Object { $_.FullName.Length } -Descending)) {
            Set-RevAgentSnapshotItemSecurity -Path $item.FullName -AllowTestRoot:$AllowTestRoot -SystemOnlySnapshot:$SystemOnlySnapshot
        }
        Move-Item -LiteralPath $stage -Destination $final -ErrorAction Stop
        [void](Assert-RevAgentProtectedReleaseSnapshot -SnapshotRoot $final -AllowTestRoot:$AllowTestRoot -SystemOnlySnapshot:$SystemOnlySnapshot)
        $statePath = Join-Path $final 'snapshot-state.json'
        $persisted = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        if (-not [string]::Equals([string]$persisted.snapshotRoot, $final, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals((Get-RevAgentSnapshotFileSha256 -Path (Join-Path $final $persisted.release.packageRelativePath)), [string]$persisted.release.packageSha256, [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals((Get-RevAgentSnapshotFileSha256 -Path (Join-Path $final $persisted.externalDependencies.nodeMsi.snapshotRelativePath)), [string]$persisted.externalDependencies.nodeMsi.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Protected release snapshot failed post-promotion identity/hash verification.'
        }
        return [pscustomobject][ordered]@{ success = $true; action = 'protected-release-snapshot'; snapshotId = $snapshotId; snapshotRoot = $final; statePath = $statePath; channelManifestPath = (Join-Path $final $persisted.release.channelManifestRelativePath); releaseSequence = [long]$persisted.release.releaseSequence; state = $persisted }
    }
    catch {
        if (-not [string]::IsNullOrWhiteSpace($stage) -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
        if (-not [string]::IsNullOrWhiteSpace($final) -and (Test-Path -LiteralPath $final)) { Remove-Item -LiteralPath $final -Recurse -Force -ErrorAction SilentlyContinue }
        throw
    }
    finally { if ($null -ne $parentGuard -and $null -ne $parentGuard.Handle) { $parentGuard.Handle.Dispose() } }
}

Export-ModuleMember -Function `
    New-RevAgentAuthenticatedReleaseInbox, `
    New-RevAgentProtectedReleaseSnapshot, `
    Assert-RevAgentProtectedReleaseSnapshot, `
    Test-RevAgentSystemOnlyReleaseSnapshot, `
    Assert-RevAgentProtectedSnapshotParent, `
    Get-RevAgentVerifiedReleaseSet, `
    Expand-RevAgentSnapshotArchiveSecure
