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

$ErrorActionPreference = 'Stop'

$attestationProtocol = 'rbp-production-launch-attestation/v2'
$authenticationProtocol = 'rbp-production-launch-authentication/v1'
$attestationEnvironmentKey = 'RBP_PRODUCTION_LAUNCH_PIPES'
$utf8Strict = [Text.UTF8Encoding]::new($false, $true)

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
$repoRoot = [IO.Path]::GetFullPath(
    [IO.Path]::Combine($PSScriptRoot, '..', '..', '..')
)
$expectedLauncher = [IO.Path]::GetFullPath(
    [IO.Path]::Combine(
        $repoRoot,
        'packages',
        'rbp-conformance',
        'scripts',
        'invoke-production.ps1'
    )
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
$expectedHostArguments = [Collections.Generic.List[string]]::new()
[void]$expectedHostArguments.Add($expectedPowerShell)
[void]$expectedHostArguments.Add('-NoProfile')
[void]$expectedHostArguments.Add('-NonInteractive')
[void]$expectedHostArguments.Add('-ExecutionPolicy')
[void]$expectedHostArguments.Add('Bypass')
[void]$expectedHostArguments.Add('-File')
[void]$expectedHostArguments.Add($expectedLauncher)
[void]$expectedHostArguments.Add('-NodeExecutable')
[void]$expectedHostArguments.Add($NodeExecutable)
[void]$expectedHostArguments.Add('-Entrypoint')
[void]$expectedHostArguments.Add($Entrypoint)
for ($index = 0; $index -lt $boundCommandArguments.Count; $index += 1) {
    [void]$expectedHostArguments.Add($boundCommandArguments[$index])
}
$actualHostArguments = [Environment]::GetCommandLineArgs()
if ($actualHostArguments.Count -ne $expectedHostArguments.Count) {
    throw (
        'Canonical production launcher host arguments must be exactly ' +
        '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
        '<canonical invoke-production.ps1> followed by the bound launcher arguments'
    )
}
for ($index = 0; $index -lt $expectedHostArguments.Count; $index += 1) {
    $comparer = if ($index -eq 0 -or $index -eq 6) {
        [StringComparer]::OrdinalIgnoreCase
    }
    else {
        [StringComparer]::Ordinal
    }
    if (-not $comparer.Equals(
        [string]$actualHostArguments[$index],
        [string]$expectedHostArguments[$index]
    )) {
        throw (
            'Canonical production launcher host arguments must be exactly ' +
            '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
            '<canonical invoke-production.ps1> followed by the bound launcher ' +
            "arguments (mismatch at argument index $index)"
        )
    }
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
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$authenticationPipe = New-CurrentUserPipeServer `
    -PipeName $authenticationPipeName `
    -User $currentIdentity.User
$receiptPipe = New-CurrentUserPipeServer `
    -PipeName $receiptPipeName `
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
try {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $resolvedNode
    $nativeArguments = [Collections.Generic.List[string]]::new()
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
    $startInfo.WorkingDirectory = [Environment]::CurrentDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    $environmentKeys = [object[]]@($startInfo.EnvironmentVariables.Keys)
    for ($index = 0; $index -lt $environmentKeys.Count; $index += 1) {
        $key = [string]$environmentKeys[$index]
        if ($forbiddenEnvironmentKeys.Contains($key)) {
            [void]$startInfo.EnvironmentVariables.Remove($key)
        }
    }
    $startInfo.EnvironmentVariables[$attestationEnvironmentKey] = (
        $authenticationPipeName + '|' + $receiptPipeName
    )
    $startInfo.EnvironmentVariables['SystemRoot'] = $windowsRoot
    $startInfo.EnvironmentVariables['WINDIR'] = $windowsRoot

    $authenticationWait = $authenticationPipe.BeginWaitForConnection($null, $null)
    $child = [Diagnostics.Process]::Start($startInfo)
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

    $launcherReceipt = Get-CanonicalFileReceipt `
        -PathValue $resolvedLauncher `
        -Label 'Production launcher'
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
    foreach ($fileReceipt in @(
        $launcherReceipt,
        $nodeReceipt,
        $entrypointReceipt
    )) {
        [void]$receiptValues.Add([string]$fileReceipt.path)
        [void]$receiptValues.Add([string]$fileReceipt.realPath)
        [void]$receiptValues.Add([string]$fileReceipt.sha256)
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
        $authenticationPipe,
        $receiptPipe
    )) {
        if ($null -ne $disposable) {
            try {
                $disposable.Dispose()
            }
            catch {
                # Broken-pipe cleanup must not replace the launcher failure.
            }
        }
    }
}
