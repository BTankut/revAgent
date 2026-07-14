Set-StrictMode -Version Latest

if (-not ("RevAgent.ReportingNativeFileInfo" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent
{
public static class ReportingNativeFileInfo
{
    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint LowDateTime;
        public uint HighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out BY_HANDLE_FILE_INFORMATION information);

    private static uint ReadLinkCount(SafeFileHandle handle)
    {
        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(handle, out information))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return information.NumberOfLinks;
    }

    public static uint GetLinkCount(string path)
    {
        const uint shareReadWriteDelete = 0x00000001 | 0x00000002 | 0x00000004;
        const uint openExisting = 3;
        const uint backupSemantics = 0x02000000;
        using (SafeFileHandle handle = CreateFile(path, 0, shareReadWriteDelete, IntPtr.Zero, openExisting, backupSemantics, IntPtr.Zero))
        {
            if (handle.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return ReadLinkCount(handle);
        }
    }

    public static uint GetLinkCount(SafeFileHandle handle)
    {
        if (handle == null || handle.IsInvalid)
        {
            throw new ArgumentException("A valid file handle is required.", "handle");
        }
        return ReadLinkCount(handle);
    }
}
}
'@
}

function Get-RevAgentNormalizedFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::Equals($fullPath.TrimEnd("\"), $pathRoot.TrimEnd("\"), [System.StringComparison]::OrdinalIgnoreCase)) {
        return $pathRoot
    }
    return $fullPath.TrimEnd("\")
}

function Assert-RevAgentPathWithinRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $fullPath = Get-RevAgentNormalizedFullPath -Path $Path
    $fullRoot = Get-RevAgentNormalizedFullPath -Path $Root
    $rootPrefix = $fullRoot.TrimEnd("\") + "\"
    if (-not [string]::Equals($fullPath.TrimEnd("\"), $fullRoot.TrimEnd("\"), [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Reporting path must remain under the guarded root '$fullRoot': $fullPath"
    }

    return $fullPath
}

function Assert-RevAgentExistingPathNoLink {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$GuardRoot,
        [switch]$RequireLeaf,
        [switch]$RequireLeafSingleLink
    )

    $fullRoot = Get-RevAgentNormalizedFullPath -Path $GuardRoot
    $fullPath = Assert-RevAgentPathWithinRoot -Path $Path -Root $fullRoot
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) {
        throw "Guarded reporting root must already exist as a directory: $fullRoot"
    }

    $rootItem = Get-Item -LiteralPath $fullRoot -Force -ErrorAction Stop
    $rootLinkType = if ($rootItem.PSObject.Properties["LinkType"]) { [string]$rootItem.LinkType } else { "" }
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($rootLinkType)) {
        throw "Guarded reporting root is a link/reparse directory: $fullRoot"
    }

    $rootForRelative = $fullRoot.TrimEnd("\")
    $relative = if ([string]::Equals($fullPath.TrimEnd("\"), $rootForRelative, [System.StringComparison]::OrdinalIgnoreCase)) {
        ""
    }
    else {
        $fullPath.Substring($rootForRelative.Length).TrimStart("\")
    }
    $cursor = $fullRoot
    foreach ($segment in @($relative -split "\\" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $cursor = [System.IO.Path]::Combine($cursor, $segment)
        if (-not (Test-Path -LiteralPath $cursor)) {
            break
        }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        $linkType = if ($item.PSObject.Properties["LinkType"]) { [string]$item.LinkType } else { "" }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) {
            throw "Reporting path contains a link/reparse component: $($item.FullName)"
        }
    }

    if ($RequireLeaf -and -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Required reporting file does not exist: $fullPath"
    }
    if ($RequireLeafSingleLink -and (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        $linkCount = [uint32][RevAgent.ReportingNativeFileInfo]::GetLinkCount($fullPath)
        if ($linkCount -ne 1) {
            throw "Reporting file is hard-linked (link count $linkCount): $fullPath"
        }
    }

    return $fullPath
}

function New-RevAgentGuardedDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$GuardRoot
    )

    $fullRoot = Get-RevAgentNormalizedFullPath -Path $GuardRoot
    $fullPath = Assert-RevAgentPathWithinRoot -Path $Path -Root $fullRoot
    [void](Assert-RevAgentExistingPathNoLink -Path $fullRoot -GuardRoot $fullRoot)
    $rootForRelative = $fullRoot.TrimEnd("\")
    $relative = if ([string]::Equals($fullPath.TrimEnd("\"), $rootForRelative, [System.StringComparison]::OrdinalIgnoreCase)) { "" } else { $fullPath.Substring($rootForRelative.Length).TrimStart("\") }
    $cursor = $fullRoot
    foreach ($segment in @($relative -split "\\" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $cursor = [System.IO.Path]::Combine($cursor, $segment)
        [void](Assert-RevAgentExistingPathNoLink -Path (Split-Path -Parent $cursor) -GuardRoot $fullRoot)
        if (-not (Test-Path -LiteralPath $cursor)) {
            [void][System.IO.Directory]::CreateDirectory($cursor)
        }
        if (-not (Test-Path -LiteralPath $cursor -PathType Container)) {
            throw "Reporting directory path is not a directory: $cursor"
        }
        [void](Assert-RevAgentExistingPathNoLink -Path $cursor -GuardRoot $fullRoot)
    }

    return $fullPath
}

function Read-RevAgentBoundedFileBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [long]$MaxBytes = 4194304
    )

    if ($MaxBytes -lt 1) { throw "MaxBytes must be positive." }
    $fullPath = Assert-RevAgentExistingPathNoLink -Path $Path -GuardRoot $AllowedRoot -RequireLeaf -RequireLeafSingleLink
    $stream = $null
    try {
        $stream = [System.IO.FileStream]::new($fullPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $linkCount = [uint32][RevAgent.ReportingNativeFileInfo]::GetLinkCount($stream.SafeFileHandle)
        if ($linkCount -ne 1) {
            throw "Reporting source is hard-linked after open (link count $linkCount): $fullPath"
        }
        [void](Assert-RevAgentExistingPathNoLink -Path $fullPath -GuardRoot $AllowedRoot -RequireLeaf -RequireLeafSingleLink)
        if ($stream.Length -gt $MaxBytes) {
            throw "Reporting source exceeds the bounded size limit ($($stream.Length) > $MaxBytes): $fullPath"
        }
        $length = [int]$stream.Length
        $bytes = New-Object byte[] $length
        $offset = 0
        while ($offset -lt $length) {
            $read = $stream.Read($bytes, $offset, $length - $offset)
            if ($read -le 0) { throw "Unexpected end of reporting source: $fullPath" }
            $offset += $read
        }
        return $bytes
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Write-RevAgentGuardedAtomicBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][string]$GuardRoot
    )

    $fullRoot = Get-RevAgentNormalizedFullPath -Path $GuardRoot
    $fullPath = Assert-RevAgentPathWithinRoot -Path $Path -Root $fullRoot
    $directory = Split-Path -Parent $fullPath
    [void](New-RevAgentGuardedDirectory -Path $directory -GuardRoot $fullRoot)
    [void](Assert-RevAgentExistingPathNoLink -Path $directory -GuardRoot $fullRoot)
    if (Test-Path -LiteralPath $fullPath) {
        [void](Assert-RevAgentExistingPathNoLink -Path $fullPath -GuardRoot $fullRoot -RequireLeaf -RequireLeafSingleLink)
    }

    $leaf = [System.IO.Path]::GetFileName($fullPath)
    $temporaryPath = Join-Path $directory (".{0}.{1}.tmp" -f $leaf, [guid]::NewGuid().ToString("N"))
    $backupPath = Join-Path $directory (".{0}.{1}.bak" -f $leaf, [guid]::NewGuid().ToString("N"))
    $restoreDiscardPath = Join-Path $directory (".{0}.{1}.restore-discard" -f $leaf, [guid]::NewGuid().ToString("N"))
    $stream = $null
    $cleanupTemporary = $true
    try {
        $stream = [System.IO.FileStream]::new($temporaryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [void](Assert-RevAgentExistingPathNoLink -Path $temporaryPath -GuardRoot $fullRoot -RequireLeaf -RequireLeafSingleLink)
        [void](Assert-RevAgentExistingPathNoLink -Path $directory -GuardRoot $fullRoot)

        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            [void](Assert-RevAgentExistingPathNoLink -Path $fullPath -GuardRoot $fullRoot -RequireLeaf -RequireLeafSingleLink)
            $cleanupTemporary = $false
            try {
                [System.IO.File]::Replace($temporaryPath, $fullPath, $backupPath, $true)
                $cleanupTemporary = $true
            }
            catch {
                $replaceError = $_.Exception.Message
                $backupExists = Test-Path -LiteralPath $backupPath -PathType Leaf
                $destinationExists = Test-Path -LiteralPath $fullPath -PathType Leaf
                if (-not $backupExists -and $destinationExists) { $cleanupTemporary = $true }
                if ($backupExists -or -not $destinationExists) {
                    throw "Atomic report replacement may have partially displaced the destination; recovery artifacts were preserved. destination='$fullPath' temporary='$temporaryPath' backup='$backupPath'. $replaceError"
                }
                throw
            }
            [void](Assert-RevAgentExistingPathNoLink -Path $fullPath -GuardRoot $fullRoot -RequireLeaf -RequireLeafSingleLink)
            try {
                [void](Assert-RevAgentExistingPathNoLink -Path $backupPath -GuardRoot $fullRoot -RequireLeaf -RequireLeafSingleLink)
            }
            catch {
                $unsafeDestination = $_.Exception.Message
                try {
                    if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
                        [System.IO.File]::Replace($backupPath, $fullPath, $restoreDiscardPath, $true)
                        [void](Assert-RevAgentExistingPathNoLink -Path $fullPath -GuardRoot $fullRoot -RequireLeaf -RequireLeafSingleLink)
                        [void](Assert-RevAgentExistingPathNoLink -Path $restoreDiscardPath -GuardRoot $fullRoot -RequireLeaf -RequireLeafSingleLink)
                        [System.IO.File]::Delete($restoreDiscardPath)
                    }
                }
                catch {
                    throw "Atomic report replacement detected an unsafe displaced destination and restoration failed; recovery artifacts were preserved. unsafe=$unsafeDestination restore=$($_.Exception.Message) backup='$backupPath' discard='$restoreDiscardPath'"
                }
                throw "Atomic report replacement refused an unsafe displaced destination and restored it. $unsafeDestination"
            }
            [System.IO.File]::Delete($backupPath)
        }
        else {
            [System.IO.File]::Move($temporaryPath, $fullPath)
        }
        [void](Assert-RevAgentExistingPathNoLink -Path $fullPath -GuardRoot $fullRoot -RequireLeaf -RequireLeafSingleLink)
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($cleanupTemporary -and (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
            try {
                [void](Assert-RevAgentExistingPathNoLink -Path $temporaryPath -GuardRoot $fullRoot -RequireLeaf -RequireLeafSingleLink)
                [System.IO.File]::Delete($temporaryPath)
            }
            catch {}
        }
    }
}

function Test-RevAgentCurrentProcessElevated {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-RevitMcpJsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value,
        [int]$Depth = 12,
        [string]$GuardRoot = "",
        [int]$MaxBytes = 4194304
    )

    if ([string]::IsNullOrWhiteSpace($GuardRoot)) { $GuardRoot = Split-Path -Parent $Path }
    if ([string]::IsNullOrWhiteSpace($GuardRoot)) { throw "A guarded parent directory is required for JSON output." }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $bytes = $encoding.GetBytes(($Value | ConvertTo-Json -Depth $Depth))
    if ($bytes.Length -gt $MaxBytes) { throw "JSON report exceeds the bounded size limit ($($bytes.Length) > $MaxBytes): $Path" }
    Write-RevAgentGuardedAtomicBytes -Path $Path -Bytes $bytes -GuardRoot $GuardRoot
}

function Read-RevitMcpJsonReportFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [int]$MaxBytes = 4194304
    )

    $bytes = Read-RevAgentBoundedFileBytes -Path $Path -AllowedRoot $AllowedRoot -MaxBytes $MaxBytes
    $text = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    return $text | ConvertFrom-Json -ErrorAction Stop
}

function New-RevitMcpUpdateReport {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$PreviousVersion = "",
        [string]$InstalledVersion = "",
        [object]$Channel = $null,
        [object]$InstalledState = $null
    )

    return [ordered]@{
        schemaVersion = 1
        app = "revAgent"
        computerName = $env:COMPUTERNAME
        userName = $env:USERNAME
        status = $Status
        message = $Message
        previousVersion = $PreviousVersion
        installedVersion = $InstalledVersion
        channel = $Channel
        installedState = $InstalledState
        reportedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
}

function ConvertTo-RevitMcpSafePathSegment {
    param([string]$Value, [string]$Fallback = "unknown")

    if ([string]::IsNullOrWhiteSpace($Value)) { return $Fallback }
    $invalidCharacters = [System.IO.Path]::GetInvalidFileNameChars()
    $builder = [System.Text.StringBuilder]::new()
    foreach ($character in $Value.Trim().ToCharArray()) {
        if ([char]::IsControl($character) -or [char]::IsWhiteSpace($character) -or [Array]::IndexOf($invalidCharacters, $character) -ge 0) {
            [void]$builder.Append("_")
        }
        else { [void]$builder.Append($character) }
    }
    $safe = [System.Text.RegularExpressions.Regex]::Replace($builder.ToString(), "_{2,}", "_").Trim("._-")
    if ([string]::IsNullOrWhiteSpace($safe)) { return $Fallback }
    if ($safe.Length -gt 80) { return $safe.Substring(0, 80).TrimEnd("._-") }
    return $safe
}

function Get-RevitMcpReportValue {
    param([object]$Report, [string]$Name)
    if ($null -eq $Report -or [string]::IsNullOrWhiteSpace($Name)) { return $null }
    if ($Report -is [System.Collections.IDictionary] -and $Report.Contains($Name)) { return $Report[$Name] }
    $property = $Report.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Copy-RevitMcpReportToOrderedMap {
    param([object]$Report)
    $copy = [ordered]@{}
    if ($null -eq $Report) { return $copy }
    if ($Report -is [System.Collections.IDictionary]) {
        foreach ($key in $Report.Keys) { $copy[[string]$key] = $Report[$key] }
        return $copy
    }
    foreach ($property in $Report.PSObject.Properties) { $copy[$property.Name] = $property.Value }
    return $copy
}

function Invoke-RevitMcpRemoteLogRetention {
    param(
        [Parameter(Mandatory = $true)][string]$LogsRoot,
        [int]$KeepLast = 2,
        [string]$GuardRoot = ""
    )

    if ($KeepLast -lt 1 -or $KeepLast -gt 20) { throw "Remote log retention KeepLast must be between 1 and 20." }
    if ([string]::IsNullOrWhiteSpace($GuardRoot)) { $GuardRoot = $LogsRoot }
    $fullLogsRoot = Assert-RevAgentExistingPathNoLink -Path $LogsRoot -GuardRoot $GuardRoot
    if (-not (Test-Path -LiteralPath $fullLogsRoot -PathType Container)) { return }
    $logs = @(Get-ChildItem -LiteralPath $fullLogsRoot -File -Filter "*.log" -ErrorAction Stop | Sort-Object LastWriteTimeUtc, Name -Descending)
    foreach ($log in $logs) {
        [void](Assert-RevAgentExistingPathNoLink -Path $log.FullName -GuardRoot $GuardRoot -RequireLeaf -RequireLeafSingleLink)
    }
    if ($logs.Count -le $KeepLast) { return }
    foreach ($log in @($logs | Select-Object -Skip $KeepLast)) {
        [void](Assert-RevAgentExistingPathNoLink -Path $log.FullName -GuardRoot $GuardRoot -RequireLeaf -RequireLeafSingleLink)
        [System.IO.File]::Delete($log.FullName)
    }
}

function Publish-RevitMcpMachineRunReport {
    param(
        [Parameter(Mandatory = $true)][string]$ReportsRoot,
        [Parameter(Mandatory = $true)][object]$Report,
        [string]$Operation = "update",
        [string]$OperationMethod = "",
        [string]$LogPath = "",
        [string]$LocalLogAllowedRoot = "",
        [int]$KeepLastLogs = 2,
        [int]$MaxLogBytes = 26214400,
        [switch]$WriteCompatibilityReport
    )

    if (Test-RevAgentCurrentProcessElevated) {
        throw "Remote report publishing is forbidden in an elevated process; publish from the original unelevated user phase."
    }
    if ([string]::IsNullOrWhiteSpace($ReportsRoot)) { return $null }
    if ($KeepLastLogs -lt 1 -or $KeepLastLogs -gt 20) { throw "KeepLastLogs must be between 1 and 20." }
    $reportsRootFull = Assert-RevAgentExistingPathNoLink -Path $ReportsRoot -GuardRoot $ReportsRoot

    $safeComputer = ConvertTo-RevitMcpSafePathSegment -Value $env:COMPUTERNAME -Fallback "unknown-computer"
    $safeUser = ConvertTo-RevitMcpSafePathSegment -Value $env:USERNAME -Fallback "unknown-user"
    $safeOperation = ConvertTo-RevitMcpSafePathSegment -Value $Operation -Fallback "operation"
    $safeMethod = ConvertTo-RevitMcpSafePathSegment -Value $OperationMethod -Fallback "method"
    $status = [string](Get-RevitMcpReportValue -Report $Report -Name "status")
    $safeStatus = ConvertTo-RevitMcpSafePathSegment -Value $status -Fallback "status"
    $version = [string](Get-RevitMcpReportValue -Report $Report -Name "installedVersion")
    if ([string]::IsNullOrWhiteSpace($version)) { $version = [string](Get-RevitMcpReportValue -Report $Report -Name "targetVersion") }
    $safeVersion = ConvertTo-RevitMcpSafePathSegment -Value $version -Fallback "version"

    $machineRoot = Join-Path (Join-Path $reportsRootFull "machines") $safeComputer
    $logsRoot = Join-Path $machineRoot "logs"
    [void](New-RevAgentGuardedDirectory -Path $logsRoot -GuardRoot $reportsRootFull)

    $published = Copy-RevitMcpReportToOrderedMap -Report $Report
    $published["operation"] = $Operation
    $published["operationMethod"] = $OperationMethod
    $published["publishedAtUtc"] = (Get-Date).ToUniversalTime().ToString("o")

    $remoteLogPath = $null
    if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
        if ([string]::IsNullOrWhiteSpace($LocalLogAllowedRoot)) { $LocalLogAllowedRoot = Split-Path -Parent $LogPath }
        $logBytes = Read-RevAgentBoundedFileBytes -Path $LogPath -AllowedRoot $LocalLogAllowedRoot -MaxBytes $MaxLogBytes
        $stamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
        $logNonce = [guid]::NewGuid().ToString("N").Substring(0, 8)
        $remoteLogPath = Join-Path $logsRoot ("{0}-{1}-{2}-{3}-{4}-{5}.log" -f $stamp, $safeOperation, $safeMethod, $safeStatus, $safeVersion, $logNonce)
        Write-RevAgentGuardedAtomicBytes -Path $remoteLogPath -Bytes $logBytes -GuardRoot $reportsRootFull
        Invoke-RevitMcpRemoteLogRetention -LogsRoot $logsRoot -KeepLast $KeepLastLogs -GuardRoot $reportsRootFull
    }

    $published["machineReport"] = [ordered]@{
        machineRoot = $machineRoot
        logPath = $remoteLogPath
        keepLastLogs = $KeepLastLogs
    }
    $latestPath = Join-Path $machineRoot "latest.json"
    $operationLatestPath = Join-Path $machineRoot ("{0}-latest.json" -f $safeOperation)
    Write-RevitMcpJsonFile -Path $latestPath -Value $published -GuardRoot $reportsRootFull
    Write-RevitMcpJsonFile -Path $operationLatestPath -Value $published -GuardRoot $reportsRootFull

    $compatibilityPath = $null
    if ($WriteCompatibilityReport) {
        $compatibilityPath = Join-Path $reportsRootFull ("{0}_{1}.json" -f $safeComputer, $safeUser)
        Write-RevitMcpJsonFile -Path $compatibilityPath -Value $published -GuardRoot $reportsRootFull
    }

    return [pscustomobject]@{
        MachineRoot = $machineRoot
        LatestPath = $latestPath
        OperationLatestPath = $operationLatestPath
        LogPath = $remoteLogPath
        CompatibilityPath = $compatibilityPath
    }
}

$revAgentFunctionAliases = @{
    "ConvertTo-RevAgentSafePathSegment" = "ConvertTo-RevitMcpSafePathSegment"
    "Invoke-RevAgentRemoteLogRetention" = "Invoke-RevitMcpRemoteLogRetention"
    "New-RevAgentUpdateReport" = "New-RevitMcpUpdateReport"
    "Publish-RevAgentMachineRunReport" = "Publish-RevitMcpMachineRunReport"
    "Read-RevAgentJsonReportFile" = "Read-RevitMcpJsonReportFile"
    "Write-RevAgentJsonFile" = "Write-RevitMcpJsonFile"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) { Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value }

Export-ModuleMember -Function `
    Write-RevitMcpJsonFile, `
    Read-RevitMcpJsonReportFile, `
    New-RevitMcpUpdateReport, `
    ConvertTo-RevitMcpSafePathSegment, `
    Publish-RevitMcpMachineRunReport, `
    Invoke-RevitMcpRemoteLogRetention
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)
