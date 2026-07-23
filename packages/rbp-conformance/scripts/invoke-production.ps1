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

$windowsRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$expectedPowerShell = [IO.Path]::GetFullPath(
    (Join-Path $windowsRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
)
$currentPowerShell = [IO.Path]::GetFullPath((Get-Process -Id $PID).Path)
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($currentPowerShell, $expectedPowerShell)) {
    throw "Canonical production launcher requires exact SystemRoot Windows PowerShell: $expectedPowerShell"
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
    'WS_NO_UTF_8_VALIDATE'
) | ForEach-Object {
    [void]$forbiddenEnvironmentKeys.Add($_)
}

foreach ($key in [Environment]::GetEnvironmentVariables(
    [EnvironmentVariableTarget]::Process
).Keys) {
    $name = [string]$key
    if ($forbiddenEnvironmentKeys.Contains($name)) {
        [Environment]::SetEnvironmentVariable(
            $name,
            $null,
            [EnvironmentVariableTarget]::Process
        )
    }
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

$resolvedNode = Resolve-CanonicalRegularFile `
    -PathValue $NodeExecutable `
    -Label 'Bound Node executable'
$resolvedEntrypoint = Resolve-CanonicalRegularFile `
    -PathValue $Entrypoint `
    -Label 'Production entrypoint'

& $resolvedNode $resolvedEntrypoint @CommandArguments
$childExitCode = $LASTEXITCODE
if ($null -eq $childExitCode) {
    throw 'Bound Node process did not return an exit code'
}
exit [int]$childExitCode
