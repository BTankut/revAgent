#Requires -Version 5.1

[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [string]$NodeExecutable,

    [Parameter(Mandatory = $true)]
    [string]$Entrypoint,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$attestationProtocol = 'rbp-production-launch-attestation/v1'
$attestationEnvironmentKey = 'RBP_PRODUCTION_LAUNCH_PIPE'
$windowsRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$expectedPowerShell = [IO.Path]::GetFullPath(
    (Join-Path $windowsRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
)
$currentPowerShell = [IO.Path]::GetFullPath((Get-Process -Id $PID).Path)
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($currentPowerShell, $expectedPowerShell)) {
    throw "Canonical production launcher requires exact SystemRoot Windows PowerShell: $expectedPowerShell"
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
    $fullPath = [IO.Path]::GetFullPath($PathValue)
    $item = Get-Item -LiteralPath $fullPath -Force
    if ($item.PSIsContainer) {
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

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$expectedLauncher = [IO.Path]::GetFullPath(
    (Join-Path $repoRoot 'packages\rbp-conformance\scripts\invoke-production.ps1')
)
$resolvedLauncher = Resolve-CanonicalRegularFile `
    -PathValue $PSCommandPath `
    -Label 'Production launcher'
if (-not [StringComparer]::OrdinalIgnoreCase.Equals(
    $resolvedLauncher,
    $expectedLauncher
)) {
    throw "Production launcher is not the canonical tracked path: $expectedLauncher"
}

$resolvedNode = Resolve-CanonicalRegularFile `
    -PathValue $NodeExecutable `
    -Label 'Bound Node executable'
$resolvedEntrypoint = Resolve-CanonicalRegularFile `
    -PathValue $Entrypoint `
    -Label 'Production entrypoint'
$prepareEntrypoint = [IO.Path]::GetFullPath(
    (Join-Path $repoRoot 'packages\rbp-conformance\scripts\prepare-production.mjs')
)
$cliBootstrapEntrypoint = [IO.Path]::GetFullPath(
    (Join-Path $repoRoot 'packages\rbp-conformance\scripts\production-cli-bootstrap.mjs')
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

$forbiddenEnvironmentKeys = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
)
@(
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_PRESERVE_SYMLINKS',
    'NODE_COMPILE_CACHE',
    'NODE_DISABLE_COMPILE_CACHE',
    'WS_NO_BUFFER_UTIL',
    'WS_NO_UTF_8_VALIDATE',
    $attestationEnvironmentKey
) | ForEach-Object {
    [void]$forbiddenEnvironmentKeys.Add($_)
}

$pipeName = 'rbp-production-' + [Guid]::NewGuid().ToString('N')
$pipeSecurity = [IO.Pipes.PipeSecurity]::new()
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$pipeSecurity.SetOwner($currentIdentity.User)
$pipeSecurity.SetAccessRuleProtection($true, $false)
[void]$pipeSecurity.AddAccessRule(
    [IO.Pipes.PipeAccessRule]::new(
        $currentIdentity.User,
        [IO.Pipes.PipeAccessRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow
    )
)
$pipeServer = [IO.Pipes.NamedPipeServerStream]::new(
    $pipeName,
    [IO.Pipes.PipeDirection]::InOut,
    1,
    [IO.Pipes.PipeTransmissionMode]::Byte,
    [IO.Pipes.PipeOptions]::Asynchronous,
    4096,
    4096,
    $pipeSecurity
)
$child = $null
$reader = $null
$writer = $null
try {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $resolvedNode
    $nativeArguments = @($resolvedEntrypoint) + @($CommandArguments)
    $startInfo.Arguments = (
        $nativeArguments |
            ForEach-Object {
                ConvertTo-WindowsCommandLineArgument -Value ([string]$_)
            }
    ) -join ' '
    $startInfo.WorkingDirectory = (Get-Location).Path
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    foreach ($key in @($startInfo.EnvironmentVariables.Keys)) {
        if ($forbiddenEnvironmentKeys.Contains([string]$key)) {
            [void]$startInfo.EnvironmentVariables.Remove([string]$key)
        }
    }
    $startInfo.EnvironmentVariables[$attestationEnvironmentKey] = $pipeName

    $waitForConnection = $pipeServer.BeginWaitForConnection($null, $null)
    $child = [Diagnostics.Process]::Start($startInfo)
    if (-not $waitForConnection.AsyncWaitHandle.WaitOne(30000)) {
        Stop-LauncherChild -Process $child
        throw 'Trusted production launcher attestation connection timed out'
    }
    $pipeServer.EndWaitForConnection($waitForConnection)
    $reader = [IO.StreamReader]::new(
        $pipeServer,
        [Text.UTF8Encoding]::new($false),
        $false,
        4096,
        $true
    )
    $writer = [IO.StreamWriter]::new(
        $pipeServer,
        [Text.UTF8Encoding]::new($false),
        4096,
        $true
    )
    $writer.AutoFlush = $true
    $readTask = $reader.ReadLineAsync()
    if (-not $readTask.Wait(30000)) {
        Stop-LauncherChild -Process $child
        throw 'Trusted production launcher attestation request timed out'
    }
    $requestLine = $readTask.Result
    if ([string]::IsNullOrWhiteSpace($requestLine)) {
        throw 'Trusted production launcher received an empty attestation request'
    }
    $request = $requestLine | ConvertFrom-Json
    $requestArguments = @($request.arguments)
    if (
        $request.protocol -ne $attestationProtocol -or
        [int]$request.childPid -ne $child.Id -or
        [int]$request.launcherPid -ne $PID -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals(
            [IO.Path]::GetFullPath([string]$request.nodeExecutable),
            $resolvedNode
        ) -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals(
            [IO.Path]::GetFullPath([string]$request.entrypoint),
            $resolvedEntrypoint
        ) -or
        -not (Test-ExactStringArray `
            -Actual $requestArguments `
            -Expected @($CommandArguments))
    ) {
        throw 'Trusted production launcher rejected an unbound child request'
    }

    $receipt = [ordered]@{
        protocol = $attestationProtocol
        role = $launchRole
        childPid = $child.Id
        launcherPid = $PID
        arguments = @($CommandArguments)
        launcher = Get-CanonicalFileReceipt `
            -PathValue $resolvedLauncher `
            -Label 'Production launcher'
        node = Get-CanonicalFileReceipt `
            -PathValue $resolvedNode `
            -Label 'Bound Node executable'
        entrypoint = Get-CanonicalFileReceipt `
            -PathValue $resolvedEntrypoint `
            -Label 'Production entrypoint'
    }
    $writer.WriteLine((@{
        ok = $true
        receipt = $receipt
    } | ConvertTo-Json -Compress -Depth 8))
    $pipeServer.WaitForPipeDrain()
    $child.WaitForExit()
    exit [int]$child.ExitCode
}
catch {
    if ($null -ne $writer -and $pipeServer.IsConnected) {
        try {
            $writer.WriteLine((@{
                ok = $false
                error = $_.Exception.Message
            } | ConvertTo-Json -Compress))
        }
        catch {
            # The child may already have closed the one-shot pipe.
        }
    }
    Stop-LauncherChild -Process $child
    throw
}
finally {
    if ($null -ne $reader) {
        try {
            $reader.Dispose()
        }
        catch {
            # Broken-pipe cleanup must not replace the launcher failure.
        }
    }
    if ($null -ne $writer) {
        try {
            $writer.Dispose()
        }
        catch {
            # Broken-pipe cleanup must not replace the launcher failure.
        }
    }
    try {
        $pipeServer.Dispose()
    }
    catch {
        # Broken-pipe cleanup must not replace the launcher failure.
    }
}
