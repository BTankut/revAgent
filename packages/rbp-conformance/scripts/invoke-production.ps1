#Requires -Version 5.1

[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [string]$NodeExecutable,

    [Parameter(Mandatory = $true)]
    [string]$Entrypoint,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArguments,

    [Parameter(DontShow = $true)]
    [string]$TrustedRepositoryRoot = '',

    [Parameter(DontShow = $true)]
    [string]$TrustedExpectedCommit = '',

    [Parameter(DontShow = $true)]
    [string]$TrustedExpectedTree = '',

    [Parameter(DontShow = $true)]
    [string]$TrustedLauncherMode = '',

    [Parameter(DontShow = $true)]
    [string]$TrustedLauncherObjectId = '',

    [Parameter(DontShow = $true)]
    [string]$TrustedLauncherSha256 = '',

    [Parameter(DontShow = $true)]
    [string]$TrustedBootstrapPayloadSha256 = '',

    [Parameter(DontShow = $true)]
    [string]$TrustedBootstrapSourceSha256 = '',

    [Parameter(DontShow = $true)]
    [string]$TrustedBootstrapTemplateSha256 = '',

    [Parameter(DontShow = $true)]
    [string]$TrustedBootstrapGitSha256 = ''
)

$ErrorActionPreference = 'Stop'

$attestationProtocol = 'rbp-production-launch-attestation/v4'
$authenticationProtocol = 'rbp-production-launch-authentication/v1'
$attestationEnvironmentKey = 'RBP_PRODUCTION_LAUNCH_PIPES'
$utf8Strict = [Text.UTF8Encoding]::new($false, $true)

function Assert-NoReparsePathSegments {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PathValue,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $fullPath = [IO.Path]::GetFullPath($PathValue)
    $root = [IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($root)) {
        throw "$Label must have an absolute filesystem root"
    }
    $relative = $fullPath.Substring($root.Length)
    $cursor = $root
    foreach ($segment in @($relative -split '\\' | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_)
    })) {
        $cursor = [IO.Path]::Combine($cursor, $segment)
        if (-not [IO.File]::Exists($cursor) -and -not [IO.Directory]::Exists($cursor)) {
            throw "$Label path segment does not exist: $cursor"
        }
        $attributes = [IO.File]::GetAttributes($cursor)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label path contains a reparse point: $cursor"
        }
    }
    return $fullPath
}

function Resolve-CanonicalRegularFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PathValue,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $pathRoot = [IO.Path]::GetPathRoot($PathValue)
    if (
        -not [IO.Path]::IsPathRooted($PathValue) -or
        [string]::IsNullOrWhiteSpace($pathRoot) -or
        $pathRoot -eq '\' -or
        $pathRoot -match '^[A-Za-z]:$'
    ) {
        throw "$Label must be an absolute path"
    }
    $fullPath = Assert-NoReparsePathSegments `
        -PathValue $PathValue `
        -Label $Label
    $item = [IO.FileInfo]::new($fullPath)
    if (-not $item.Exists) {
        throw "$Label does not exist: $fullPath"
    }
    if (($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        throw "$Label must be a regular file: $fullPath"
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label cannot be a reparse point: $fullPath"
    }
    return $item.FullName
}

function Get-CanonicalFileReceipt {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PathValue,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $resolved = Resolve-CanonicalRegularFile -PathValue $PathValue -Label $Label
    $stream = [IO.File]::OpenRead($resolved)
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            $hashBytes = $algorithm.ComputeHash($stream)
        }
        finally {
            $algorithm.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
    $hash = ([BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
    return [ordered]@{
        path = $resolved
        realPath = $resolved
        sha256 = $hash
    }
}

function ConvertTo-WindowsCommandLineArgument {
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes += 1
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) {
        [void]$builder.Append(('\' * ($backslashes * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Get-Sha256FromStream {
    param(
        [Parameter(Mandatory = $true)]
        [IO.Stream]$Stream
    )

    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $Stream.Position = 0
        $bytes = $algorithm.ComputeHash($Stream)
        $Stream.Position = 0
        return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
    }
}

function Invoke-ExactProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Executable,

        [AllowEmptyCollection()]
        [string[]]$Arguments = @(),

        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,

        [hashtable]$Environment = @{},

        [AllowNull()]
        [string]$StandardInput = $null,

        [int]$TimeoutMilliseconds = 30000
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $encodedArguments = [Collections.Generic.List[string]]::new()
    foreach ($argument in $Arguments) {
        [void]$encodedArguments.Add(
            (ConvertTo-WindowsCommandLineArgument -Value ([string]$argument))
        )
    }
    $startInfo.Arguments = [string]::Join(' ', $encodedArguments)
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.RedirectStandardInput = $null -ne $StandardInput
    $startInfo.EnvironmentVariables.Clear()
    foreach ($entry in $Environment.GetEnumerator()) {
        if ($null -ne $entry.Value) {
            $startInfo.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value
        }
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "Failed to start exact process: $Executable"
        }
        if ($null -ne $StandardInput) {
            $process.StandardInput.Write($StandardInput)
            $process.StandardInput.Close()
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill() } catch {}
            $process.WaitForExit()
            throw "Exact process timed out: $Executable"
        }
        [void]$stdoutTask.Wait(5000)
        [void]$stderrTask.Wait(5000)
        return [pscustomobject][ordered]@{
            exitCode = $process.ExitCode
            stdout = if ($stdoutTask.IsCompleted) { $stdoutTask.Result } else { '' }
            stderr = if ($stderrTask.IsCompleted) { $stderrTask.Result } else { '' }
        }
    }
    finally {
        $process.Dispose()
    }
}

function Test-PathWithinRoot {
    param(
        [Parameter(Mandatory = $true)][string]$PathValue,
        [Parameter(Mandatory = $true)][string]$RootValue
    )

    $pathFull = [IO.Path]::GetFullPath($PathValue)
    $rootFull = [IO.Path]::GetFullPath($RootValue).TrimEnd('\')
    return (
        [StringComparer]::OrdinalIgnoreCase.Equals($pathFull, $rootFull) -or
        $pathFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)
    )
}

function Get-ProtectedPathAttestation {
    param(
        [Parameter(Mandatory = $true)][string]$PathValue,
        [Parameter(Mandatory = $true)][string]$TrustedRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedSignerSubject,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $fullPath = Resolve-CanonicalRegularFile -PathValue $PathValue -Label $Label
    $fullRoot = [IO.Path]::GetFullPath($TrustedRoot).TrimEnd('\')
    if (-not (Test-PathWithinRoot -PathValue $fullPath -RootValue $fullRoot)) {
        throw "$Label is outside its protected known-folder root"
    }
    [void](Assert-NoReparsePathSegments -PathValue $fullRoot -Label "$Label root")

    $securityModule = [IO.Path]::Combine(
        $PSHOME,
        'Modules',
        'Microsoft.PowerShell.Security',
        'Microsoft.PowerShell.Security.psd1'
    )
    $cmdletType = [Management.Automation.CommandTypes]::Cmdlet
    $importModule = $ExecutionContext.InvokeCommand.GetCommand(
        'Microsoft.PowerShell.Core\Import-Module',
        $cmdletType
    )
    if ($null -eq $importModule) {
        throw "$Label exact Import-Module cmdlet is unavailable"
    }
    & $importModule -Name $securityModule -Force -ErrorAction Stop
    $getSignature = $ExecutionContext.InvokeCommand.GetCommand(
        'Microsoft.PowerShell.Security\Get-AuthenticodeSignature',
        $cmdletType
    )
    if ($null -eq $getSignature) {
        throw "$Label exact Get-AuthenticodeSignature cmdlet is unavailable"
    }
    $signature = & $getSignature -LiteralPath $fullPath -ErrorAction Stop
    if (
        $signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
        $null -eq $signature.SignerCertificate -or
        -not [StringComparer]::Ordinal.Equals(
            [string]$signature.SignerCertificate.Subject,
            $ExpectedSignerSubject
        )
    ) {
        throw "$Label does not have the required valid Authenticode publisher"
    }

    $trustedInstallerSid = ''
    try {
        $trustedInstallerSid = [string](
            [Security.Principal.NTAccount]'NT SERVICE\TrustedInstaller'
        ).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    catch {}
    $trustedOwners = @('S-1-5-18', 'S-1-5-32-544')
    if (-not [string]::IsNullOrWhiteSpace($trustedInstallerSid)) {
        $trustedOwners += $trustedInstallerSid
    }
    $trustedWriters = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    foreach ($sid in $trustedOwners) {
        [void]$trustedWriters.Add($sid)
    }
    $dangerousRights = [int64](
        [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    )
    $relative = $fullPath.Substring($fullRoot.Length).TrimStart('\')
    $cursor = $fullRoot
    $chain = [Collections.Generic.List[string]]::new()
    [void]$chain.Add($cursor)
    foreach ($segment in @($relative -split '\\' | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_)
    })) {
        $cursor = [IO.Path]::Combine($cursor, $segment)
        [void]$chain.Add($cursor)
    }
    foreach ($chainPath in $chain) {
        $item = Get-Item -LiteralPath $chainPath -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label protected path contains a reparse point: $chainPath"
        }
        $acl = Microsoft.PowerShell.Security\Get-Acl `
            -LiteralPath $chainPath `
            -ErrorAction Stop
        $ownerSid = [string]$acl.GetOwner(
            [Security.Principal.SecurityIdentifier]
        ).Value
        if (@($trustedOwners | Where-Object {
            [StringComparer]::OrdinalIgnoreCase.Equals($_, $ownerSid)
        }).Count -eq 0) {
            throw "$Label protected path has an untrusted owner: $chainPath"
        }
        $rules = @($acl.GetAccessRules(
            $true,
            $true,
            [Security.Principal.SecurityIdentifier]
        ))
        $foreignWriter = @($rules | Where-Object {
            $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            (([int64]$_.FileSystemRights -band $dangerousRights) -ne 0) -and
            -not $trustedWriters.Contains([string]$_.IdentityReference.Value)
        } | Select-Object -First 1)
        if ($foreignWriter.Count -ne 0) {
            throw "$Label protected path grants write to an untrusted SID: $chainPath"
        }
    }

    $stream = [IO.File]::Open(
        $fullPath,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    try {
        $sha256 = Get-Sha256FromStream -Stream $stream
    }
    catch {
        $stream.Dispose()
        throw
    }
    return [pscustomobject][ordered]@{
        path = $fullPath
        realPath = $fullPath
        sha256 = $sha256
        signerSubject = [string]$signature.SignerCertificate.Subject
        signerSimpleName = $signature.SignerCertificate.GetNameInfo(
            [Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
            $false
        )
        signatureStatus = [string]$signature.Status
        signatureThumbprint = (
            [string]$signature.SignerCertificate.Thumbprint
        ).ToLowerInvariant()
        protectedRoot = $fullRoot
        stream = $stream
    }
}

function New-GitEnvironment {
    param(
        [Parameter(Mandatory = $true)][string]$WindowsRoot,
        [Parameter(Mandatory = $true)][string]$ProgramFilesRoot,
        [AllowEmptyString()][string]$ProgramFilesX86Root
    )

    $result = @{
        'SystemRoot' = $WindowsRoot
        'WINDIR' = $WindowsRoot
        'ProgramFiles' = $ProgramFilesRoot
        'ProgramW6432' = $ProgramFilesRoot
        'PATH' = ''
        'GIT_ATTR_NOSYSTEM' = '1'
        'GIT_CONFIG_GLOBAL' = 'NUL'
        'GIT_CONFIG_NOSYSTEM' = '1'
        'GIT_CONFIG_SYSTEM' = 'NUL'
        'GIT_NO_REPLACE_OBJECTS' = '1'
        'GIT_OPTIONAL_LOCKS' = '0'
        'GIT_TERMINAL_PROMPT' = '0'
    }
    if (-not [string]::IsNullOrWhiteSpace($ProgramFilesX86Root)) {
        $result['ProgramFiles(x86)'] = $ProgramFilesX86Root
    }
    if (-not [string]::IsNullOrWhiteSpace($env:TEMP)) {
        $result['TEMP'] = $env:TEMP
    }
    if (-not [string]::IsNullOrWhiteSpace($env:TMP)) {
        $result['TMP'] = $env:TMP
    }
    return $result
}

function Invoke-AnchoredGit {
    param(
        [Parameter(Mandatory = $true)][object]$GitIdentity,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][hashtable]$Environment,
        [AllowNull()][string]$StandardInput = $null
    )

    $config = @(
        '--no-replace-objects',
        '-c', 'core.attributesfile=',
        '-c', 'core.autocrlf=input',
        '-c', 'core.excludesfile=',
        '-c', 'core.fsmonitor=false',
        '-c', 'core.ignorestat=false',
        '-c', 'core.preloadindex=false',
        '-c', 'core.useReplaceRefs=false',
        '-c', 'core.safecrlf=false',
        '-c', 'core.trustctime=true',
        '-c', 'core.untrackedCache=false'
    )
    $result = Invoke-ExactProcess `
        -Executable $GitIdentity.path `
        -Arguments @($config + $Arguments) `
        -WorkingDirectory $RepoRoot `
        -Environment $Environment `
        -StandardInput $StandardInput
    if ($result.exitCode -ne 0) {
        throw "Anchored Git command failed: $($result.stderr.Trim())"
    }
    return $result
}

function Assert-TrackedHeadBytes {
    param(
        [Parameter(Mandatory = $true)][object]$GitIdentity,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][hashtable]$Environment,
        [Parameter(Mandatory = $true)][string[]]$RelativePaths
    )

    foreach ($relativePath in $RelativePaths) {
        $stage = (
            Invoke-AnchoredGit `
                -GitIdentity $GitIdentity `
                -RepoRoot $RepoRoot `
                -Environment $Environment `
                -Arguments @('ls-files', '--stage', '--error-unmatch', '--', $relativePath)
        ).stdout.Trim()
        if ($stage -notmatch '^([0-7]{6}) ([0-9a-f]{40,64}) 0\t(.+)$') {
            throw "Tracked source has an unsupported index record: $relativePath"
        }
        $indexMode = $Matches[1]
        $indexObjectId = $Matches[2]
        $indexPath = $Matches[3]
        if (
            $indexMode -ne '100644' -or
            -not [StringComparer]::Ordinal.Equals($indexPath, $relativePath)
        ) {
            throw "Tracked source index path is not canonical: $relativePath"
        }
        $headRecord = (
            Invoke-AnchoredGit `
                -GitIdentity $GitIdentity `
                -RepoRoot $RepoRoot `
                -Environment $Environment `
                -Arguments @('ls-tree', '-z', 'HEAD', '--', $relativePath)
        ).stdout
        if ($headRecord -notmatch '^([0-7]{6}) blob ([0-9a-f]{40,64})\t(.+)\x00$') {
            throw "Tracked source has an unsupported HEAD record: $relativePath"
        }
        $headMode = $Matches[1]
        $headObjectId = $Matches[2]
        $headPath = $Matches[3]
        if (
            $headMode -ne '100644' -or
            -not [StringComparer]::Ordinal.Equals($headPath, $relativePath)
        ) {
            throw "Tracked source HEAD path is not canonical: $relativePath"
        }
        $absolute = [IO.Path]::Combine(
            $RepoRoot,
            $relativePath.Replace('/', '\')
        )
        [void](Resolve-CanonicalRegularFile `
            -PathValue $absolute `
            -Label "Tracked source $relativePath")
        $worktreeObjectId = (
            Invoke-AnchoredGit `
                -GitIdentity $GitIdentity `
                -RepoRoot $RepoRoot `
                -Environment $Environment `
                -Arguments @('hash-object', '--no-filters', '--', $absolute)
        ).stdout.Trim()
        if (
            -not [StringComparer]::Ordinal.Equals($indexMode, $headMode) -or
            -not [StringComparer]::Ordinal.Equals($indexObjectId, $headObjectId) -or
            -not [StringComparer]::Ordinal.Equals($headObjectId, $worktreeObjectId)
        ) {
            throw "Tracked source bytes do not match HEAD: $relativePath"
        }
    }
}

function Open-InitialProductionSourceMap {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][object]$SourceAnchor,
        [Parameter(Mandatory = $true)][string]$EntrypointRelativePath
    )

    $relativePaths = [string[]]@(
        $EntrypointRelativePath,
        'packages/rbp-conformance/scripts/bootstrap-identity.mjs',
        'packages/rbp-conformance/scripts/production-bootstrap-identity.json',
        'packages/rbp-conformance/scripts/production-controller-bootstrap.mjs',
        'packages/rbp-conformance/scripts/production-launch-attestation.mjs',
        'packages/rbp-conformance/scripts/production-launch-bootstrap.mjs',
        'packages/rbp-conformance/scripts/production-source-anchor.mjs'
    )
    $streams = [Collections.Generic.List[IO.FileStream]]::new()
    $records = [Collections.Generic.List[object]]::new()
    try {
        foreach ($relativePath in $relativePaths) {
            $matches = @($SourceAnchor.sources | Where-Object {
                [StringComparer]::Ordinal.Equals(
                    [string]$_.relativePath,
                    $relativePath
                )
            })
            if ($matches.Count -ne 1) {
                throw "Initial source anchor is missing: $relativePath"
            }
            $absolute = [IO.Path]::GetFullPath(
                [IO.Path]::Combine(
                    $RepoRoot,
                    $relativePath.Replace('/', '\')
                )
            )
            $resolved = Resolve-CanonicalRegularFile `
                -PathValue $absolute `
                -Label "Initial production source $relativePath"
            $stream = [IO.File]::Open(
                $resolved,
                [IO.FileMode]::Open,
                [IO.FileAccess]::Read,
                [IO.FileShare]::Read
            )
            [void]$streams.Add($stream)
            $sha256 = Get-Sha256FromStream -Stream $stream
            if (-not [StringComparer]::Ordinal.Equals(
                $sha256,
                [string]$matches[0].sha256
            )) {
                throw "Initial production source changed: $relativePath"
            }
            if ($stream.Length -gt 2MB) {
                throw "Initial production source is unexpectedly large: $relativePath"
            }
            $bytes = [byte[]]::new([int]$stream.Length)
            $stream.Position = 0
            $offset = 0
            while ($offset -lt $bytes.Length) {
                $read = $stream.Read(
                    $bytes,
                    $offset,
                    $bytes.Length - $offset
                )
                if ($read -le 0) {
                    throw "Initial production source read stopped: $relativePath"
                }
                $offset += $read
            }
            $stream.Position = 0
            [void]$records.Add([ordered]@{
                path = $resolved
                sha256 = $sha256
                sourceBase64 = [Convert]::ToBase64String($bytes)
            })
        }
        $wire = [ordered]@{
            schemaVersion = 'rbp-production-initial-source-map/v1'
            entrypoint = [IO.Path]::GetFullPath(
                [IO.Path]::Combine(
                    $RepoRoot,
                    $EntrypointRelativePath.Replace('/', '\')
                )
            )
            files = $records.ToArray()
        } | ConvertTo-Json -Depth 6 -Compress
        return [ordered]@{
            streams = $streams
            wire = $wire
        }
    }
    catch {
        foreach ($stream in $streams) {
            try { $stream.Dispose() } catch {}
        }
        throw
    }
}

function Test-ExactStringArray {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Actual,

        [AllowEmptyString()]
        [AllowEmptyCollection()]
        [Parameter(Mandatory = $true)]
        [string[]]$Expected
    )

    if ($Actual.Count -ne $Expected.Count) {
        return $false
    }
    for ($index = 0; $index -lt $Expected.Count; $index += 1) {
        if (-not [StringComparer]::Ordinal.Equals(
            [string]$Actual[$index],
            [string]$Expected[$index]
        )) {
            return $false
        }
    }
    return $true
}

function ConvertTo-ProtocolField {
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    return [Convert]::ToBase64String($utf8Strict.GetBytes($Value))
}

function ConvertFrom-ProtocolField {
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    try {
        return $utf8Strict.GetString([Convert]::FromBase64String($Value))
    }
    catch {
        throw 'Trusted production launcher received an invalid protocol field'
    }
}

function Read-LineWithTimeout {
    param(
        [Parameter(Mandatory = $true)]
        [IO.StreamReader]$Reader,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $readTask = $Reader.ReadLineAsync()
    if (-not $readTask.Wait(30000)) {
        throw "$Label timed out"
    }
    $line = $readTask.Result
    if ([string]::IsNullOrWhiteSpace($line)) {
        throw "$Label was empty"
    }
    if ($utf8Strict.GetByteCount($line) -gt (64 * 1024)) {
        throw "$Label exceeded 64 KiB"
    }
    return $line
}

function Stop-LauncherChild {
    param(
        [AllowNull()]
        [Diagnostics.Process]$Process
    )

    if ($null -eq $Process) {
        return
    }
    try {
        $Process.Refresh()
        if (-not $Process.HasExited) {
            $Process.Kill()
        }
    }
    catch {
        $Process.Refresh()
        if (-not $Process.HasExited) {
            throw
        }
    }
    $Process.WaitForExit()
}

function Wait-ForPipeConnection {
    param(
        [Parameter(Mandatory = $true)]
        [IO.Pipes.NamedPipeServerStream]$Pipe,

        [Parameter(Mandatory = $true)]
        [IAsyncResult]$AsyncResult,

        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$Process,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not $AsyncResult.IsCompleted) {
        $Process.Refresh()
        if ($Process.HasExited) {
            throw (
                "$Label failed because the production child exited before " +
                'the OS pipe handoff completed'
            )
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            Stop-LauncherChild -Process $Process
            throw "$Label timed out"
        }
        [Threading.Thread]::Sleep(25)
    }
    $Pipe.EndWaitForConnection($AsyncResult)
}

function New-PipeNativeType {
    $assemblyName = [Reflection.AssemblyName]::new(
        'RbpProductionPipeNative_' + [Guid]::NewGuid().ToString('N')
    )
    $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
        $assemblyName,
        [Reflection.Emit.AssemblyBuilderAccess]::Run
    )
    $moduleBuilder = $assemblyBuilder.DefineDynamicModule($assemblyName.Name)
    $typeBuilder = $moduleBuilder.DefineType(
        'RbpProductionPipeNative',
        (
            [Reflection.TypeAttributes]::Public -bor
            [Reflection.TypeAttributes]::Abstract -bor
            [Reflection.TypeAttributes]::Sealed
        )
    )
    $method = $typeBuilder.DefinePInvokeMethod(
        'GetNamedPipeClientProcessId',
        'kernel32.dll',
        (
            [Reflection.MethodAttributes]::Public -bor
            [Reflection.MethodAttributes]::Static -bor
            [Reflection.MethodAttributes]::PinvokeImpl
        ),
        [Reflection.CallingConventions]::Standard,
        [bool],
        [Type[]]@([IntPtr], [UInt32].MakeByRefType()),
        [Runtime.InteropServices.CallingConvention]::Winapi,
        [Runtime.InteropServices.CharSet]::Unicode
    )
    $method.SetImplementationFlags(
        $method.GetMethodImplementationFlags() -bor
        [Reflection.MethodImplAttributes]::PreserveSig
    )
    return $typeBuilder.CreateType()
}

function Get-ConnectedPipeClientProcessId {
    param(
        [Parameter(Mandatory = $true)]
        [IO.Pipes.NamedPipeServerStream]$Pipe,

        [Parameter(Mandatory = $true)]
        [Type]$NativeType
    )

    $arguments = [object[]]@(
        $Pipe.SafePipeHandle.DangerousGetHandle(),
        [uint32]0
    )
    $success = $NativeType.GetMethod(
        'GetNamedPipeClientProcessId'
    ).Invoke($null, $arguments)
    if (-not [bool]$success) {
        $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "GetNamedPipeClientProcessId failed with Win32 error $nativeError"
    }
    return [uint32]$arguments[1]
}

function New-CurrentUserPipeServer {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PipeName,

        [Parameter(Mandatory = $true)]
        [Security.Principal.SecurityIdentifier]$User
    )

    $pipeSecurity = [IO.Pipes.PipeSecurity]::new()
    $pipeSecurity.SetOwner($User)
    $pipeSecurity.SetAccessRuleProtection($true, $false)
    [void]$pipeSecurity.AddAccessRule(
        [IO.Pipes.PipeAccessRule]::new(
            $User,
            [IO.Pipes.PipeAccessRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow
        )
    )
    return [IO.Pipes.NamedPipeServerStream]::new(
        $PipeName,
        [IO.Pipes.PipeDirection]::InOut,
        1,
        [IO.Pipes.PipeTransmissionMode]::Byte,
        [IO.Pipes.PipeOptions]::Asynchronous,
        4096,
        4096,
        $pipeSecurity
    )
}

$windowsRoot = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::Windows
)
$expectedPowerShell = [IO.Path]::GetFullPath(
    [IO.Path]::Combine(
        $windowsRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
    )
)
if (
    [string]::IsNullOrWhiteSpace($TrustedRepositoryRoot) -or
    $TrustedExpectedCommit -notmatch '^[0-9a-f]{40,64}$' -or
    $TrustedExpectedTree -notmatch '^[0-9a-f]{40,64}$' -or
    $TrustedLauncherMode -ne '100644' -or
    $TrustedLauncherObjectId -notmatch '^[0-9a-f]{40,64}$' -or
    $TrustedLauncherSha256 -notmatch '^[0-9a-f]{64}$' -or
    $TrustedBootstrapPayloadSha256 -notmatch '^[0-9a-f]{64}$' -or
    $TrustedBootstrapSourceSha256 -notmatch '^[0-9a-f]{64}$' -or
    $TrustedBootstrapTemplateSha256 -notmatch '^[0-9a-f]{64}$' -or
    $TrustedBootstrapGitSha256 -notmatch '^[0-9a-f]{64}$'
) {
    throw (
        'Production launcher must be loaded from the canonical encoded ' +
        'SystemRoot PowerShell bootstrap'
    )
}
$repoRoot = [IO.Path]::GetFullPath($TrustedRepositoryRoot)
[void](Assert-NoReparsePathSegments `
    -PathValue $repoRoot `
    -Label 'Production repository root')
$currentPowerShell = [IO.Path]::GetFullPath(
    [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
)
if (-not [StringComparer]::OrdinalIgnoreCase.Equals(
    $currentPowerShell,
    $expectedPowerShell
)) {
    throw "Canonical production launcher requires exact SystemRoot Windows PowerShell: $expectedPowerShell"
}

[string[]]$boundCommandArguments = @()
if ($null -ne $CommandArguments) {
    $boundCommandArguments = [string[]]@($CommandArguments)
}
$actualHostArguments = [Environment]::GetCommandLineArgs()
if (
    $actualHostArguments.Count -ne 9 -or
    -not [StringComparer]::OrdinalIgnoreCase.Equals(
        [string]$actualHostArguments[0],
        $expectedPowerShell
    ) -or
    [string]$actualHostArguments[1] -ne '-NoProfile' -or
    [string]$actualHostArguments[2] -ne '-NonInteractive' -or
    [string]$actualHostArguments[3] -ne '-ExecutionPolicy' -or
    [string]$actualHostArguments[4] -ne 'Bypass' -or
    [string]$actualHostArguments[5] -ne '-EncodedArguments' -or
    [string]$actualHostArguments[7] -ne '-EncodedCommand'
) {
    throw (
        'Canonical production launcher host arguments must be exactly ' +
        '-NoProfile -NonInteractive -ExecutionPolicy Bypass ' +
        '-EncodedArguments <canonical payload> -EncodedCommand <fixed bootstrap>'
    )
}
try {
    $bootstrapCommandBytes = [Convert]::FromBase64String(
        [string]$actualHostArguments[8]
    )
}
catch {
    throw 'Canonical encoded bootstrap command is malformed'
}
$bootstrapCommandStream = [IO.MemoryStream]::new(
    $bootstrapCommandBytes,
    $false
)
try {
    $actualBootstrapSourceSha256 = Get-Sha256FromStream `
        -Stream $bootstrapCommandStream
}
finally {
    $bootstrapCommandStream.Dispose()
}
if (-not [StringComparer]::Ordinal.Equals(
    $actualBootstrapSourceSha256,
    $TrustedBootstrapSourceSha256
)) {
    throw 'Canonical encoded bootstrap source digest is not bound'
}

$resolvedNode = Resolve-CanonicalRegularFile `
    -PathValue $NodeExecutable `
    -Label 'Bound Node executable'
$resolvedEntrypoint = Resolve-CanonicalRegularFile `
    -PathValue $Entrypoint `
    -Label 'Production entrypoint'
$prepareEntrypoint = [IO.Path]::GetFullPath(
    [IO.Path]::Combine(
        $repoRoot,
        'packages',
        'rbp-conformance',
        'scripts',
        'prepare-production.mjs'
    )
)
$cliBootstrapEntrypoint = [IO.Path]::GetFullPath(
    [IO.Path]::Combine(
        $repoRoot,
        'packages',
        'rbp-conformance',
        'scripts',
        'production-cli-bootstrap.mjs'
    )
)
if ([StringComparer]::OrdinalIgnoreCase.Equals(
    $resolvedEntrypoint,
    $prepareEntrypoint
)) {
    $launchRole = 'prepare-wrapper'
}
elseif ([StringComparer]::OrdinalIgnoreCase.Equals(
    $resolvedEntrypoint,
    $cliBootstrapEntrypoint
)) {
    $launchRole = 'cli-bootstrap'
}
else {
    throw (
        'Production launcher accepts only the canonical tracked prepare wrapper ' +
        'or CLI bootstrap entrypoint'
    )
}

$currentPrincipal = [Security.Principal.WindowsPrincipal]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if ($currentPrincipal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)) {
    throw 'Canonical production launcher refuses an elevated Windows token'
}

$programFilesRoot = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::ProgramFiles
)
$programFilesX86Root = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::ProgramFilesX86
)
if ([string]::IsNullOrWhiteSpace($programFilesRoot)) {
    throw 'Canonical Program Files known folder is unavailable'
}
$expectedNode = [IO.Path]::GetFullPath(
    [IO.Path]::Combine($programFilesRoot, 'nodejs', 'node.exe')
)
if (-not [StringComparer]::OrdinalIgnoreCase.Equals(
    $resolvedNode,
    $expectedNode
)) {
    throw "Production Node must be the exact Program Files candidate: $expectedNode"
}
$expectedGit = [IO.Path]::GetFullPath(
    [IO.Path]::Combine($programFilesRoot, 'Git', 'bin', 'git.exe')
)
$nodeSignerSubject = (
    'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, ' +
    'S=California, C=US'
)
$gitSignerSubject = (
    'CN=Johannes Schindelin, O=Johannes Schindelin, ' +
    'S=Nordrhein-Westfalen, C=DE'
)
$nodeLaunchGuard = Get-ProtectedPathAttestation `
    -PathValue $expectedNode `
    -TrustedRoot $programFilesRoot `
    -ExpectedSignerSubject $nodeSignerSubject `
    -Label 'Production Node executable'
$gitLaunchGuard = Get-ProtectedPathAttestation `
    -PathValue $expectedGit `
    -TrustedRoot $programFilesRoot `
    -ExpectedSignerSubject $gitSignerSubject `
    -Label 'Production Git executable'

$baseProcessEnvironment = @{
    'SystemRoot' = $windowsRoot
    'WINDIR' = $windowsRoot
    'ProgramFiles' = $programFilesRoot
    'ProgramW6432' = $programFilesRoot
    'PATH' = ''
}
if (-not [string]::IsNullOrWhiteSpace($programFilesX86Root)) {
    $baseProcessEnvironment['ProgramFiles(x86)'] = $programFilesX86Root
}
if (-not [string]::IsNullOrWhiteSpace($env:TEMP)) {
    $baseProcessEnvironment['TEMP'] = $env:TEMP
}
if (-not [string]::IsNullOrWhiteSpace($env:TMP)) {
    $baseProcessEnvironment['TMP'] = $env:TMP
}

$nodeCapabilitySource = @'
const {
  createRequire,
  registerHooks,
} = require("node:module");
(async () => {
  const version = /^v([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(process.version);
  if (
    version === null ||
    Number(version[1]) < 22 ||
    (
      Number(version[1]) === 22 &&
      Number(version[2]) < 15
    ) ||
    typeof registerHooks !== "function"
  ) {
    throw new Error("Node 22.15+ with registerHooks is required");
  }
  let importResolve = false;
  let importLoad = false;
  let requireResolve = false;
  const probe = `data:text/javascript,export default ${process.pid}`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === probe) importResolve = true;
      if (specifier === "node:querystring") requireResolve = true;
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === probe) importLoad = true;
      return nextLoad(url, context);
    },
  });
  await import(probe);
  createRequire(process.cwd() + "\\capability-probe.cjs")("node:querystring");
  hooks.deregister();
  if (!importResolve || !importLoad || !requireResolve) {
    throw new Error("synchronous loader hooks did not observe both paths");
  }
  process.stdout.write(JSON.stringify({
    version: process.version,
    execPath: process.execPath,
    registerHooks: true,
  }));
})().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 93;
});
'@
$nodeCapability = Invoke-ExactProcess `
    -Executable $nodeLaunchGuard.path `
    -Arguments @('-e', $nodeCapabilitySource) `
    -WorkingDirectory $repoRoot `
    -Environment $baseProcessEnvironment
if ($nodeCapability.exitCode -ne 0) {
    throw (
        'Production Node capability validation failed: ' +
        $nodeCapability.stderr.Trim()
    )
}
try {
    $nodeCapabilityValue = $nodeCapability.stdout | ConvertFrom-Json
}
catch {
    throw 'Production Node capability validation returned malformed JSON'
}
if (
    -not [StringComparer]::OrdinalIgnoreCase.Equals(
        [string]$nodeCapabilityValue.execPath,
        $nodeLaunchGuard.path
    ) -or
    [string]$nodeCapabilityValue.version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$' -or
    $nodeCapabilityValue.registerHooks -ne $true
) {
    throw 'Production Node capability validation returned an unbound identity'
}

$gitEnvironment = New-GitEnvironment `
    -WindowsRoot $windowsRoot `
    -ProgramFilesRoot $programFilesRoot `
    -ProgramFilesX86Root $programFilesX86Root
$gitVersionResult = Invoke-ExactProcess `
    -Executable $gitLaunchGuard.path `
    -Arguments @('--version') `
    -WorkingDirectory $repoRoot `
    -Environment $gitEnvironment
$gitVersion = $gitVersionResult.stdout.Trim()
if (
    $gitVersionResult.exitCode -ne 0 -or
    $gitVersion -notmatch '^git version [0-9]+\.[0-9]+\.[0-9]+'
) {
    throw "Production Git identity probe failed: $($gitVersionResult.stderr.Trim())"
}
$actualGitRoot = (
    Invoke-AnchoredGit `
        -GitIdentity $gitLaunchGuard `
        -RepoRoot $repoRoot `
        -Environment $gitEnvironment `
        -Arguments @('rev-parse', '--show-toplevel')
).stdout.Trim()
if (-not [StringComparer]::OrdinalIgnoreCase.Equals(
    [IO.Path]::GetFullPath($actualGitRoot),
    $repoRoot
)) {
    throw 'Production launcher root is not the actual Git worktree root'
}
$actualCommit = (
    Invoke-AnchoredGit `
        -GitIdentity $gitLaunchGuard `
        -RepoRoot $repoRoot `
        -Environment $gitEnvironment `
        -Arguments @('rev-parse', '--verify', 'HEAD^{commit}')
).stdout.Trim()
$actualTree = (
    Invoke-AnchoredGit `
        -GitIdentity $gitLaunchGuard `
        -RepoRoot $repoRoot `
        -Environment $gitEnvironment `
        -Arguments @('rev-parse', '--verify', 'HEAD^{tree}')
).stdout.Trim()
$launcherRelativePath = 'packages/rbp-conformance/scripts/invoke-production.ps1'
$launcherObjectId = (
    Invoke-AnchoredGit `
        -GitIdentity $gitLaunchGuard `
        -RepoRoot $repoRoot `
        -Environment $gitEnvironment `
        -Arguments @(
            'rev-parse',
            ($TrustedExpectedCommit + ':' + $launcherRelativePath)
        )
).stdout.Trim()
if (
    -not [StringComparer]::Ordinal.Equals(
        $actualCommit,
        $TrustedExpectedCommit
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        $actualTree,
        $TrustedExpectedTree
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        $launcherObjectId,
        $TrustedLauncherObjectId
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        $gitLaunchGuard.sha256,
        $TrustedBootstrapGitSha256
    )
) {
    throw 'Production launcher bootstrap Git/blob identity is not bound to HEAD'
}

$sourceAnchorHelper = [IO.Path]::GetFullPath(
    [IO.Path]::Combine(
        $repoRoot,
        'packages',
        'rbp-conformance',
        'scripts',
        'production-source-anchor.mjs'
    )
)
$entrypointRelativePath = if ($launchRole -eq 'prepare-wrapper') {
    'packages/rbp-conformance/scripts/prepare-production.mjs'
}
else {
    'packages/rbp-conformance/scripts/production-cli-bootstrap.mjs'
}
Assert-TrackedHeadBytes `
    -GitIdentity $gitLaunchGuard `
    -RepoRoot $repoRoot `
    -Environment $gitEnvironment `
    -RelativePaths @(
        'packages/rbp-conformance/.gitattributes',
        'packages/rbp-conformance/scripts/invoke-production.ps1',
        'packages/rbp-conformance/scripts/production-source-anchor.mjs',
        'packages/rbp-conformance/scripts/production-launch-bootstrap.mjs',
        'packages/rbp-conformance/scripts/production-launch-attestation.mjs',
        $entrypointRelativePath
    )

$sourceAnchorHeadObject = (
    Invoke-AnchoredGit `
        -GitIdentity $gitLaunchGuard `
        -RepoRoot $repoRoot `
        -Environment $gitEnvironment `
        -Arguments @(
            'rev-parse',
            (
                $TrustedExpectedCommit +
                ':packages/rbp-conformance/scripts/production-source-anchor.mjs'
            )
        )
).stdout.Trim()
$sourceAnchorLock = [IO.File]::Open(
    $sourceAnchorHelper,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
)
try {
    $sourceAnchorLockedObject = (
        Invoke-AnchoredGit `
            -GitIdentity $gitLaunchGuard `
            -RepoRoot $repoRoot `
            -Environment $gitEnvironment `
            -Arguments @(
                'hash-object',
                '--no-filters',
                '--',
                $sourceAnchorHelper
            )
    ).stdout.Trim()
    if (-not [StringComparer]::Ordinal.Equals(
        $sourceAnchorLockedObject,
        $sourceAnchorHeadObject
    )) {
        throw 'Production source-anchor helper changed before execution'
    }
    $sourceAnchorResult = Invoke-ExactProcess `
        -Executable $nodeLaunchGuard.path `
        -Arguments @(
            $sourceAnchorHelper,
            '__capture-production-source-anchor',
            $repoRoot,
            $expectedPowerShell
        ) `
        -WorkingDirectory $repoRoot `
        -Environment $baseProcessEnvironment `
        -TimeoutMilliseconds 120000
}
finally {
    $sourceAnchorLock.Dispose()
}
if ($sourceAnchorResult.exitCode -ne 0) {
    throw (
        'Production source/Git anchor failed before pipe creation: ' +
        $sourceAnchorResult.stderr.Trim()
    )
}
try {
    $sourceAnchor = $sourceAnchorResult.stdout | ConvertFrom-Json
}
catch {
    throw 'Production source/Git anchor returned malformed JSON'
}
$sourceAnchorValues = [string[]]@($sourceAnchor.values | ForEach-Object {
    [string]$_
})
$sourceAnchorDigest = [string]$sourceAnchor.digestSha256
if (
    $sourceAnchorDigest -notmatch '^[0-9a-f]{64}$' -or
    $sourceAnchorValues.Count -lt 20 -or
    -not [StringComparer]::OrdinalIgnoreCase.Equals(
        [string]$sourceAnchor.repoRoot,
        $repoRoot
    ) -or
    -not [StringComparer]::OrdinalIgnoreCase.Equals(
        [string]$sourceAnchor.node.path,
        $nodeLaunchGuard.path
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$sourceAnchor.node.sha256,
        $nodeLaunchGuard.sha256
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$sourceAnchor.node.version,
        [string]$nodeCapabilityValue.version
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$sourceAnchor.node.signature.status,
        'Valid'
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$sourceAnchor.node.signature.subject,
        $nodeSignerSubject
    ) -or
    -not [StringComparer]::OrdinalIgnoreCase.Equals(
        [string]$sourceAnchor.git.path,
        $gitLaunchGuard.path
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$sourceAnchor.git.sha256,
        $gitLaunchGuard.sha256
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$sourceAnchor.git.version,
        $gitVersion
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$sourceAnchor.git.signature.status,
        'Valid'
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$sourceAnchor.git.signature.subject,
        $gitSignerSubject
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$sourceAnchor.commit,
        $TrustedExpectedCommit
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$sourceAnchor.tree,
        $TrustedExpectedTree
    )
) {
    throw 'Production source/Git anchor is not bound to authenticated Node/Git'
}
$launcherSource = @($sourceAnchor.sources | Where-Object {
    [StringComparer]::Ordinal.Equals(
        [string]$_.relativePath,
        $launcherRelativePath
    )
})
if (
    $launcherSource.Count -ne 1 -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$launcherSource[0].mode,
        $TrustedLauncherMode
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$launcherSource[0].objectId,
        $TrustedLauncherObjectId
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$launcherSource[0].sha256,
        $TrustedLauncherSha256
    )
) {
    throw 'Production launcher Git blob identity does not match the source anchor'
}

$initialSourceMap = Open-InitialProductionSourceMap `
    -RepoRoot $repoRoot `
    -SourceAnchor $sourceAnchor `
    -EntrypointRelativePath $entrypointRelativePath
$initialSourceStreams = $initialSourceMap.streams
$initialNodeBootstrap = @'
const { createHash } = require("node:crypto");
const net = require("node:net");
const { registerHooks } = require("node:module");
const { pathToFileURL } = require("node:url");
const pipeName = process.env.RBP_PRODUCTION_SOURCE_PIPE;
delete process.env.RBP_PRODUCTION_SOURCE_PIPE;
if (!/^rbp-production-source-[0-9a-f]{32}$/.test(pipeName ?? "")) {
  throw new Error("trusted initial source pipe is unavailable");
}
function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
async function receiveSourceMap() {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(`\\\\.\\pipe\\${pipeName}`);
    let value = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("trusted initial source map timed out"));
    }, 30_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      value += chunk;
      if (Buffer.byteLength(value, "utf8") > 4 * 1024 * 1024) {
        clearTimeout(timeout);
        socket.destroy();
        reject(new Error("trusted initial source map is too large"));
        return;
      }
      const newline = value.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timeout);
      socket.destroy();
      try {
        resolve(JSON.parse(value.slice(0, newline).replace(/\r$/, "")));
      } catch {
        reject(new Error("trusted initial source map is malformed"));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
(async () => {
  const wire = await receiveSourceMap();
  if (
    wire?.schemaVersion !== "rbp-production-initial-source-map/v1" ||
    !samePath(wire.entrypoint ?? "", process.argv[1] ?? "") ||
    !Array.isArray(wire.files) ||
    wire.files.length < 5
  ) {
    throw new Error("trusted initial source map metadata is invalid");
  }
  const sources = new Map();
  for (const record of wire.files) {
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.path !== "string" ||
      typeof record.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.sha256) ||
      typeof record.sourceBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        record.sourceBase64,
      )
    ) {
      throw new Error("trusted initial source record is invalid");
    }
    const bytes = Buffer.from(record.sourceBase64, "base64");
    if (bytes.toString("base64") !== record.sourceBase64) {
      throw new Error("trusted initial source is not canonical base64");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
      throw new Error("trusted initial source digest mismatch");
    }
    const url = pathToFileURL(record.path).href;
    if (sources.has(url)) {
      throw new Error("trusted initial source map has duplicate paths");
    }
    sources.set(url, bytes);
  }
  const entrypointUrl = pathToFileURL(wire.entrypoint).href;
  if (!sources.has(entrypointUrl)) {
    throw new Error("trusted initial source map omits the entrypoint");
  }
  const controllerHookProbe =
    `data:text/javascript,export default ${JSON.stringify(process.pid)}`;
  const initialHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier.startsWith("node:") ||
        specifier === controllerHookProbe
      ) {
        return nextResolve(specifier, context);
      }
      if (
        !specifier.startsWith("file:") &&
        !specifier.startsWith("./") &&
        !specifier.startsWith("../") &&
        !specifier.startsWith("/")
      ) {
        // Bootstrap identity capture uses createRequire.resolve() only to find
        // pinned package bytes. Any attempted code load still reaches load()
        // and is rejected unless the later full closure hook captured it.
        return nextResolve(specifier, context);
      }
      let candidate;
      try {
        candidate = specifier.startsWith("file:")
          ? new URL(specifier).href
          : new URL(specifier, context.parentURL).href;
      } catch {
        throw new Error(`untrusted initial module specifier: ${specifier}`);
      }
      if (!sources.has(candidate)) {
        throw new Error(`initial module is outside verified memory map: ${candidate}`);
      }
      return { url: candidate, shortCircuit: true };
    },
    load(url, context, nextLoad) {
      if (url.startsWith("node:") || url === controllerHookProbe) {
        return nextLoad(url, context);
      }
      const source = sources.get(url);
      if (source === undefined) {
        throw new Error(`initial module load is outside verified memory map: ${url}`);
      }
      return { format: "module", source, shortCircuit: true };
    },
  });
  const handoffKey = Symbol.for("rbp.production.initial-loader-handoff");
  Object.defineProperty(globalThis, handoffKey, {
    configurable: true,
    enumerable: false,
    value() {
      initialHooks.deregister();
      delete globalThis[handoffKey];
    },
    writable: false,
  });
  await import(entrypointUrl);
})().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 97;
});
'@
$initialNodeBootstrapBytes = [Text.UTF8Encoding]::new(
    $false,
    $true
).GetBytes($initialNodeBootstrap)
$initialNodeBootstrapStream = [IO.MemoryStream]::new(
    $initialNodeBootstrapBytes,
    $false
)
try {
    $initialNodeBootstrapSha256 = Get-Sha256FromStream `
        -Stream $initialNodeBootstrapStream
}
finally {
    $initialNodeBootstrapStream.Dispose()
}

$forbiddenEnvironmentKeys = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
)
$forbiddenEnvironmentKeyValues = [string[]]@(
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_PRESERVE_SYMLINKS',
    'NODE_COMPILE_CACHE',
    'NODE_DISABLE_COMPILE_CACHE',
    'WS_NO_BUFFER_UTIL',
    'WS_NO_UTF_8_VALIDATE',
    $attestationEnvironmentKey,
    'RBP_PRODUCTION_LAUNCH_PIPE'
)
for ($index = 0; $index -lt $forbiddenEnvironmentKeyValues.Count; $index += 1) {
    [void]$forbiddenEnvironmentKeys.Add($forbiddenEnvironmentKeyValues[$index])
}

$authenticationPipeName = 'rbp-production-auth-' + [Guid]::NewGuid().ToString('N')
$receiptPipeName = 'rbp-production-receipt-' + [Guid]::NewGuid().ToString('N')
$sourcePipeName = 'rbp-production-source-' + [Guid]::NewGuid().ToString('N')
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$authenticationPipe = New-CurrentUserPipeServer `
    -PipeName $authenticationPipeName `
    -User $currentIdentity.User
$receiptPipe = New-CurrentUserPipeServer `
    -PipeName $receiptPipeName `
    -User $currentIdentity.User
$sourcePipe = New-CurrentUserPipeServer `
    -PipeName $sourcePipeName `
    -User $currentIdentity.User
$pipeNativeType = New-PipeNativeType
$randomBytes = [byte[]]::new(32)
$randomNumberGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $randomNumberGenerator.GetBytes($randomBytes)
}
finally {
    $randomNumberGenerator.Dispose()
}
$sessionToken = ([BitConverter]::ToString($randomBytes)).Replace('-', '').ToLowerInvariant()

$child = $null
$authenticationReader = $null
$authenticationWriter = $null
$receiptReader = $null
$receiptWriter = $null
$sourceWriter = $null
try {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $resolvedNode
    $nativeArguments = [Collections.Generic.List[string]]::new()
    [void]$nativeArguments.Add('-e')
    [void]$nativeArguments.Add($initialNodeBootstrap)
    [void]$nativeArguments.Add($resolvedEntrypoint)
    for ($index = 0; $index -lt $boundCommandArguments.Count; $index += 1) {
        [void]$nativeArguments.Add($boundCommandArguments[$index])
    }
    $encodedNativeArguments = [Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $nativeArguments.Count; $index += 1) {
        [void]$encodedNativeArguments.Add(
            (ConvertTo-WindowsCommandLineArgument -Value $nativeArguments[$index])
        )
    }
    $startInfo.Arguments = [string]::Join(' ', $encodedNativeArguments)
    # The approved payload already binds $repoRoot. Make it the only process
    # working directory so relative plan/artifact arguments cannot be retargeted
    # by the ambient directory of the authority executor.
    $startInfo.WorkingDirectory = $repoRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    $environmentKeys = [object[]]@($startInfo.EnvironmentVariables.Keys)
    for ($index = 0; $index -lt $environmentKeys.Count; $index += 1) {
        $key = [string]$environmentKeys[$index]
        if (
            $forbiddenEnvironmentKeys.Contains($key) -or
            $key.StartsWith(
                'RBP_PRODUCTION_',
                [StringComparison]::OrdinalIgnoreCase
            )
        ) {
            [void]$startInfo.EnvironmentVariables.Remove($key)
        }
    }
    $startInfo.EnvironmentVariables[$attestationEnvironmentKey] = (
        $authenticationPipeName + '|' + $receiptPipeName
    )
    $startInfo.EnvironmentVariables['RBP_PRODUCTION_SOURCE_PIPE'] = (
        $sourcePipeName
    )
    $startInfo.EnvironmentVariables['SystemRoot'] = $windowsRoot
    $startInfo.EnvironmentVariables['WINDIR'] = $windowsRoot
    $startInfo.EnvironmentVariables['ProgramFiles'] = $programFilesRoot
    $startInfo.EnvironmentVariables['ProgramW6432'] = $programFilesRoot
    $startInfo.EnvironmentVariables['PATH'] = ''
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86Root)) {
        $startInfo.EnvironmentVariables['ProgramFiles(x86)'] = $programFilesX86Root
    }

    $sourceWait = $sourcePipe.BeginWaitForConnection($null, $null)
    $authenticationWait = $authenticationPipe.BeginWaitForConnection($null, $null)
    $child = [Diagnostics.Process]::Start($startInfo)
    Wait-ForPipeConnection `
        -Pipe $sourcePipe `
        -AsyncResult $sourceWait `
        -Process $child `
        -Label 'Trusted initial source-map connection'
    $sourceClientPid = Get-ConnectedPipeClientProcessId `
        -Pipe $sourcePipe `
        -NativeType $pipeNativeType
    if ($sourceClientPid -ne $child.Id) {
        throw (
            'Trusted production launcher rejected an initial source-map ' +
            'connection whose OS pipe client PID was not the launched child'
        )
    }
    $sourceWriter = [IO.StreamWriter]::new(
        $sourcePipe,
        [Text.UTF8Encoding]::new($false),
        4096,
        $true
    )
    $sourceWriter.AutoFlush = $true
    $sourceWriter.WriteLine([string]$initialSourceMap.wire)
    $sourcePipe.WaitForPipeDrain()
    $sourceWriter.Dispose()
    $sourceWriter = $null
    $sourcePipe.Dispose()
    $sourcePipe = $null
    Wait-ForPipeConnection `
        -Pipe $authenticationPipe `
        -AsyncResult $authenticationWait `
        -Process $child `
        -Label 'Trusted production launcher authentication connection'
    $authenticationClientPid = Get-ConnectedPipeClientProcessId `
        -Pipe $authenticationPipe `
        -NativeType $pipeNativeType
    $authenticationReader = [IO.StreamReader]::new(
        $authenticationPipe,
        $utf8Strict,
        $false,
        4096,
        $true
    )
    $authenticationWriter = [IO.StreamWriter]::new(
        $authenticationPipe,
        [Text.UTF8Encoding]::new($false),
        4096,
        $true
    )
    $authenticationWriter.AutoFlush = $true
    $authenticationLine = Read-LineWithTimeout `
        -Reader $authenticationReader `
        -Label 'Trusted production launcher authentication request'
    $authenticationFields = [string[]]$authenticationLine.Split([char]9)
    $parsedAuthenticationChildPid = 0
    $parsedAuthenticationHelperPid = 0
    if (
        $authenticationFields.Count -ne 4 -or
        $authenticationFields[0] -ne 'AUTH' -or
        $authenticationFields[1] -ne $authenticationProtocol -or
        -not [int]::TryParse(
            $authenticationFields[2],
            [Globalization.NumberStyles]::None,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$parsedAuthenticationChildPid
        ) -or
        -not [int]::TryParse(
            $authenticationFields[3],
            [Globalization.NumberStyles]::None,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$parsedAuthenticationHelperPid
        ) -or
        $parsedAuthenticationChildPid -ne $child.Id -or
        $parsedAuthenticationHelperPid -ne $authenticationClientPid
    ) {
        throw (
            'Trusted production launcher rejected an authentication helper ' +
            'whose OS pipe client PID was not bound to the launched child'
        )
    }
    $authenticationWriter.WriteLine('OK' + [char]9 + $sessionToken)
    $authenticationPipe.WaitForPipeDrain()
    $authenticationReader.Dispose()
    $authenticationReader = $null
    $authenticationWriter.Dispose()
    $authenticationWriter = $null
    $authenticationPipe.Dispose()
    $authenticationPipe = $null

    $receiptWait = $receiptPipe.BeginWaitForConnection($null, $null)
    Wait-ForPipeConnection `
        -Pipe $receiptPipe `
        -AsyncResult $receiptWait `
        -Process $child `
        -Label 'Trusted production launcher attestation connection'
    $receiptClientPid = Get-ConnectedPipeClientProcessId `
        -Pipe $receiptPipe `
        -NativeType $pipeNativeType
    if ($receiptClientPid -ne $child.Id) {
        throw (
            'Trusted production launcher rejected an attestation connection ' +
            'whose OS pipe client PID was not the launched Node child'
        )
    }
    $receiptReader = [IO.StreamReader]::new(
        $receiptPipe,
        $utf8Strict,
        $false,
        4096,
        $true
    )
    $receiptWriter = [IO.StreamWriter]::new(
        $receiptPipe,
        [Text.UTF8Encoding]::new($false),
        4096,
        $true
    )
    $receiptWriter.AutoFlush = $true
    $requestLine = Read-LineWithTimeout `
        -Reader $receiptReader `
        -Label 'Trusted production launcher attestation request'
    $requestFields = [string[]]$requestLine.Split([char]9)
    if ($requestFields.Count -lt 2 -or $requestFields[0] -ne 'REQUEST') {
        throw 'Trusted production launcher received a malformed attestation request'
    }
    $requestValues = [Collections.Generic.List[string]]::new()
    for ($index = 1; $index -lt $requestFields.Count; $index += 1) {
        [void]$requestValues.Add(
            (ConvertFrom-ProtocolField -Value $requestFields[$index])
        )
    }
    $expectedRequestValues = [Collections.Generic.List[string]]::new()
    [void]$expectedRequestValues.Add($attestationProtocol)
    [void]$expectedRequestValues.Add($sessionToken)
    [void]$expectedRequestValues.Add($resolvedNode)
    [void]$expectedRequestValues.Add($resolvedEntrypoint)
    [void]$expectedRequestValues.Add($sourceAnchorDigest)
    [void]$expectedRequestValues.Add($TrustedBootstrapPayloadSha256)
    [void]$expectedRequestValues.Add($TrustedBootstrapSourceSha256)
    [void]$expectedRequestValues.Add($TrustedBootstrapTemplateSha256)
    [void]$expectedRequestValues.Add($initialNodeBootstrapSha256)
    [void]$expectedRequestValues.Add(
        $boundCommandArguments.Count.ToString(
            [Globalization.CultureInfo]::InvariantCulture
        )
    )
    for ($index = 0; $index -lt $boundCommandArguments.Count; $index += 1) {
        [void]$expectedRequestValues.Add($boundCommandArguments[$index])
    }
    if (-not (Test-ExactStringArray `
        -Actual $requestValues.ToArray() `
        -Expected $expectedRequestValues.ToArray())) {
        throw 'Trusted production launcher rejected an unbound child request'
    }

    $nodeReceipt = Get-CanonicalFileReceipt `
        -PathValue $resolvedNode `
        -Label 'Bound Node executable'
    $entrypointReceipt = Get-CanonicalFileReceipt `
        -PathValue $resolvedEntrypoint `
        -Label 'Production entrypoint'
    $receiptValues = [Collections.Generic.List[string]]::new()
    [void]$receiptValues.Add($attestationProtocol)
    [void]$receiptValues.Add($launchRole)
    [void]$receiptValues.Add(
        $child.Id.ToString([Globalization.CultureInfo]::InvariantCulture)
    )
    [void]$receiptValues.Add(
        $PID.ToString([Globalization.CultureInfo]::InvariantCulture)
    )
    [void]$receiptValues.Add(
        $boundCommandArguments.Count.ToString(
            [Globalization.CultureInfo]::InvariantCulture
        )
    )
    for ($index = 0; $index -lt $boundCommandArguments.Count; $index += 1) {
        [void]$receiptValues.Add($boundCommandArguments[$index])
    }
    foreach ($fileReceipt in @($nodeReceipt, $entrypointReceipt)) {
        [void]$receiptValues.Add([string]$fileReceipt.path)
        [void]$receiptValues.Add([string]$fileReceipt.realPath)
        [void]$receiptValues.Add([string]$fileReceipt.sha256)
    }
    $bootstrapValues = [string[]]@(
        $TrustedBootstrapPayloadSha256,
        $TrustedBootstrapSourceSha256,
        $TrustedBootstrapTemplateSha256,
        $initialNodeBootstrapSha256,
        $TrustedExpectedCommit,
        $TrustedExpectedTree,
        $launcherRelativePath,
        $TrustedLauncherMode,
        $TrustedLauncherObjectId,
        $TrustedLauncherSha256,
        $TrustedBootstrapGitSha256
    )
    [void]$receiptValues.Add(
        $bootstrapValues.Count.ToString(
            [Globalization.CultureInfo]::InvariantCulture
        )
    )
    for ($index = 0; $index -lt $bootstrapValues.Count; $index += 1) {
        [void]$receiptValues.Add($bootstrapValues[$index])
    }
    [void]$receiptValues.Add(
        $sourceAnchorValues.Count.ToString(
            [Globalization.CultureInfo]::InvariantCulture
        )
    )
    for ($index = 0; $index -lt $sourceAnchorValues.Count; $index += 1) {
        [void]$receiptValues.Add($sourceAnchorValues[$index])
    }
    $encodedReceiptValues = [Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $receiptValues.Count; $index += 1) {
        [void]$encodedReceiptValues.Add(
            (ConvertTo-ProtocolField -Value $receiptValues[$index])
        )
    }
    $receiptWriter.WriteLine(
        'OK' + [char]9 + [string]::Join([char]9, $encodedReceiptValues)
    )
    $receiptPipe.WaitForPipeDrain()
    $child.WaitForExit()
    exit [int]$child.ExitCode
}
catch {
    $failureMessage = $_.Exception.Message
    if ($null -ne $authenticationWriter -and $authenticationPipe.IsConnected) {
        try {
            $authenticationWriter.WriteLine(
                'ERROR' + [char]9 +
                (ConvertTo-ProtocolField -Value $failureMessage)
            )
        }
        catch {
            # The authentication helper may already have closed the one-shot pipe.
        }
    }
    if ($null -ne $receiptWriter -and $receiptPipe.IsConnected) {
        try {
            $receiptWriter.WriteLine(
                'ERROR' + [char]9 +
                (ConvertTo-ProtocolField -Value $failureMessage)
            )
        }
        catch {
            # The child may already have closed the one-shot pipe.
        }
    }
    Stop-LauncherChild -Process $child
    throw
}
finally {
    foreach ($disposable in @(
        $authenticationReader,
        $authenticationWriter,
        $receiptReader,
        $receiptWriter,
        $sourceWriter,
        $authenticationPipe,
        $receiptPipe,
        $sourcePipe,
        $nodeLaunchGuard.stream,
        $gitLaunchGuard.stream,
        $initialSourceStreams
    )) {
        if ($null -ne $disposable) {
            try {
                if ($disposable -is [Collections.IEnumerable]) {
                    foreach ($nestedDisposable in $disposable) {
                        if ($null -ne $nestedDisposable) {
                            $nestedDisposable.Dispose()
                        }
                    }
                }
                else {
                    $disposable.Dispose()
                }
            }
            catch {
                # Broken-pipe cleanup must not replace the launcher failure.
            }
        }
    }
}
