Set-StrictMode -Version Latest

if (-not ("RevAgent.DesktopLauncherCleanupNative" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public sealed class DesktopLauncherPathInfo {
        public uint FileAttributes { get; set; }
        public uint NumberOfLinks { get; set; }
    }

    public static class DesktopLauncherCleanupNative {
        private const uint FILE_READ_ATTRIBUTES = 0x00000080;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const int ERROR_FILE_NOT_FOUND = 2;
        private const int ERROR_PATH_NOT_FOUND = 3;

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

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(
            string fileName,
            uint desiredAccess,
            FileShare shareMode,
            IntPtr securityAttributes,
            FileMode creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle handle,
            out BY_HANDLE_FILE_INFORMATION information);

        public static DesktopLauncherPathInfo Inspect(string path, bool allowMissing) {
            using (SafeFileHandle handle = CreateFile(
                path,
                FILE_READ_ATTRIBUTES,
                FileShare.ReadWrite | FileShare.Delete,
                IntPtr.Zero,
                FileMode.Open,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero)) {
                if (handle.IsInvalid) {
                    int error = Marshal.GetLastWin32Error();
                    if (allowMissing && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)) {
                        return null;
                    }
                    throw new Win32Exception(error);
                }

                BY_HANDLE_FILE_INFORMATION information;
                if (!GetFileInformationByHandle(handle, out information)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return new DesktopLauncherPathInfo {
                    FileAttributes = information.FileAttributes,
                    NumberOfLinks = information.NumberOfLinks
                };
            }
        }
    }
}
"@
}

$script:RevAgentLauncherCandidateExtensions = @(".cmd", ".bat", ".ps1", ".vbs", ".lnk", ".url")
$script:RevAgentLegacyLauncherPatterns = @(
    "Revit MCP Updater STABLE",
    "Install-Revit-MCP",
    "Update-Revit-MCP",
    "Show-Revit-MCP",
    "Run-Revit-MCP",
    "RevitMCP",
    "C:\ProgramData\DPE\RevitMCP"
)
$script:RevAgentExactLegacyStartupLauncherNames = @(
    "Revit MCP Auto Update.cmd",
    "Revit MCP Auto Update.vbs"
)

function Get-RevAgentLauncherCleanupFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "Launcher cleanup path must not be empty."
    }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if (-not [string]::Equals($fullPath, $pathRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $fullPath = $fullPath.TrimEnd([char[]]@('\', '/'))
    }
    return $fullPath
}

function Get-RevAgentLauncherCleanupPathChain {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = Get-RevAgentLauncherCleanupFullPath -Path $Path
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($pathRoot)) {
        throw "Launcher cleanup path has no filesystem root: $fullPath"
    }

    $paths = [System.Collections.Generic.List[string]]::new()
    [void]$paths.Add($pathRoot)
    if (-not [string]::Equals($fullPath, $pathRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $relativePath = $fullPath.Substring($pathRoot.Length)
        $currentPath = $pathRoot
        foreach ($part in @($relativePath -split '[\\/]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
            $currentPath = Join-Path $currentPath $part
            [void]$paths.Add($currentPath)
        }
    }
    return @($paths.ToArray())
}

function Test-RevAgentExactStartupRootSafety {
    param([Parameter(Mandatory = $true)][string]$StartupRoot)

    try {
        $startupRootFull = Get-RevAgentLauncherCleanupFullPath -Path $StartupRoot
        $chain = @(Get-RevAgentLauncherCleanupPathChain -Path $startupRootFull)
        foreach ($candidatePath in $chain) {
            $info = [RevAgent.DesktopLauncherCleanupNative]::Inspect($candidatePath, $true)
            if ($null -eq $info) {
                return [pscustomobject][ordered]@{
                    safe = $true
                    exists = $false
                    startupRoot = $startupRootFull
                    reason = "startup_root_missing"
                    blockedByPath = $candidatePath
                    error = ""
                }
            }
            if (([uint32]$info.FileAttributes -band [uint32][System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                return [pscustomobject][ordered]@{
                    safe = $false
                    exists = $true
                    startupRoot = $startupRootFull
                    reason = "unsafe_reparse_ancestor"
                    blockedByPath = $candidatePath
                    error = "Startup path contains a filesystem reparse point: $candidatePath"
                }
            }
            if (([uint32]$info.FileAttributes -band [uint32][System.IO.FileAttributes]::Directory) -eq 0) {
                return [pscustomobject][ordered]@{
                    safe = $false
                    exists = $true
                    startupRoot = $startupRootFull
                    reason = "startup_ancestor_not_directory"
                    blockedByPath = $candidatePath
                    error = "Startup path ancestor is not an ordinary directory: $candidatePath"
                }
            }
        }
        return [pscustomobject][ordered]@{
            safe = $true
            exists = $true
            startupRoot = $startupRootFull
            reason = "validated"
            blockedByPath = ""
            error = ""
        }
    }
    catch {
        return [pscustomobject][ordered]@{
            safe = $false
            exists = $false
            startupRoot = $StartupRoot
            reason = "startup_root_inspection_failed"
            blockedByPath = $StartupRoot
            error = $_.Exception.Message
        }
    }
}

function New-RevAgentExactStartupCleanupFailure {
    param(
        [string]$Path,
        [string]$Name,
        [string]$Extension,
        [string]$Source,
        [Parameter(Mandatory = $true)][string]$Reason,
        [Parameter(Mandatory = $true)][string]$ErrorMessage,
        [string]$BlockedByPath = "",
        [uint32]$LinkCount = 0,
        [uint32]$FileAttributes = 0
    )

    return [pscustomobject][ordered]@{
        path = $Path
        name = $Name
        extension = $Extension
        source = $Source
        reason = $Reason
        blockedByPath = $BlockedByPath
        linkCount = $LinkCount
        fileAttributes = $FileAttributes
        error = $ErrorMessage
    }
}

function Get-RevAgentLauncherCleanupPropertyValue {
    param(
        [object]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [object]$DefaultValue = $null
    )

    if ($null -eq $Object) {
        return $DefaultValue
    }
    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
        return $Object[$Name]
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $DefaultValue
    }
    return $property.Value
}

function Merge-RevAgentLauncherCleanupEvidence {
    [CmdletBinding()]
    param(
        [object]$Primary,
        [object]$Additional
    )

    $matched = New-Object System.Collections.Generic.List[object]
    $removed = New-Object System.Collections.Generic.List[object]
    $failed = New-Object System.Collections.Generic.List[object]
    $matchedSeen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $removedSeen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $failedSeen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($source in @($Primary, $Additional)) {
        if ($null -eq $source) { continue }
        foreach ($spec in @(
                [pscustomobject]@{ Name = "matched"; Target = $matched; Seen = $matchedSeen },
                [pscustomobject]@{ Name = "removed"; Target = $removed; Seen = $removedSeen },
                [pscustomobject]@{ Name = "failed"; Target = $failed; Seen = $failedSeen }
            )) {
            $items = Get-RevAgentLauncherCleanupPropertyValue -Object $source -Name ([string]$spec.Name)
            if ($null -eq $items) { continue }
            foreach ($item in @($items)) {
                if ($null -eq $item) { continue }
                $itemPath = [string](Get-RevAgentLauncherCleanupPropertyValue -Object $item -Name "path" -DefaultValue "")
                $itemError = [string](Get-RevAgentLauncherCleanupPropertyValue -Object $item -Name "error" -DefaultValue "")
                $key = if (-not [string]::IsNullOrWhiteSpace($itemPath)) {
                    $itemPath
                }
                elseif (-not [string]::IsNullOrWhiteSpace($itemError)) {
                    "error:" + $itemError
                }
                else {
                    "record:" + ($item | ConvertTo-Json -Compress -Depth 8)
                }
                if ($spec.Seen.Add($key)) {
                    [void]$spec.Target.Add($item)
                }
            }
        }
    }

    $primaryMode = [string](Get-RevAgentLauncherCleanupPropertyValue -Object $Primary -Name "mode" -DefaultValue "")
    $additionalMode = [string](Get-RevAgentLauncherCleanupPropertyValue -Object $Additional -Name "mode" -DefaultValue "")
    $effectiveMode = if (-not [string]::IsNullOrWhiteSpace($primaryMode) -and
        -not [string]::Equals($primaryMode, "not-run", [System.StringComparison]::OrdinalIgnoreCase)) {
        $primaryMode
    }
    elseif (-not [string]::IsNullOrWhiteSpace($additionalMode)) {
        $additionalMode
    }
    else {
        "not-run"
    }
    $startupRoot = [string](Get-RevAgentLauncherCleanupPropertyValue -Object $Additional -Name "startupRoot" -DefaultValue "")
    if ([string]::IsNullOrWhiteSpace($startupRoot)) {
        $startupRoot = [string](Get-RevAgentLauncherCleanupPropertyValue -Object $Primary -Name "startupRoot" -DefaultValue "")
    }
    if ($failed.Count -gt 0) {
        $effectiveMode = "failed"
    }

    return [pscustomobject][ordered]@{
        enabled = $true
        mode = $effectiveMode
        startupRoot = $startupRoot
        matchedCount = $matched.Count
        removedCount = $removed.Count
        failedCount = $failed.Count
        matched = @($matched.ToArray())
        removed = @($removed.ToArray())
        failed = @($failed.ToArray())
        removedPaths = @($removed.ToArray() | ForEach-Object { [string](Get-RevAgentLauncherCleanupPropertyValue -Object $_ -Name "path" -DefaultValue "") })
    }
}

function Merge-RevAgentDesktopLauncherCleanupEvidence {
    [CmdletBinding()]
    param(
        [object]$NestedUpdaterCleanup,
        [object]$ExactStartupCleanup
    )

    $merged = Merge-RevAgentLauncherCleanupEvidence -Primary $NestedUpdaterCleanup -Additional $ExactStartupCleanup
    $merged | Add-Member -NotePropertyName nestedUpdaterCleanup -NotePropertyValue $NestedUpdaterCleanup -Force
    $merged | Add-Member -NotePropertyName exactStartupCleanup -NotePropertyValue $ExactStartupCleanup -Force
    return $merged
}

function Invoke-RevAgentExactLegacyStartupLauncherCleanup {
    [CmdletBinding()]
    param(
        [string]$StartupRoot = "",
        [switch]$WhatIfOnly
    )

    if ([string]::IsNullOrWhiteSpace($StartupRoot)) {
        $StartupRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    }
    if ([string]::IsNullOrWhiteSpace($StartupRoot)) {
        return [pscustomobject][ordered]@{
            enabled = $true
            mode = if ($WhatIfOnly) { "whatIf" } else { "commit" }
            startupRoot = ""
            matchedCount = 0
            removedCount = 0
            failedCount = 0
            matched = @()
            removed = @()
            failed = @()
            removedPaths = @()
        }
    }

    $matched = New-Object System.Collections.Generic.List[object]
    $removed = New-Object System.Collections.Generic.List[object]
    $failed = New-Object System.Collections.Generic.List[object]

    $rootSafety = Test-RevAgentExactStartupRootSafety -StartupRoot $StartupRoot
    $startupRootFull = [string]$rootSafety.startupRoot
    if (-not [bool]$rootSafety.safe) {
        [void]$failed.Add((New-RevAgentExactStartupCleanupFailure `
                -Path $startupRootFull `
                -Name "" `
                -Extension "" `
                -Source "exact-legacy-startup-root" `
                -Reason ([string]$rootSafety.reason) `
                -ErrorMessage ([string]$rootSafety.error) `
                -BlockedByPath ([string]$rootSafety.blockedByPath)))
    }
    elseif (-not [bool]$rootSafety.exists) {
        return [pscustomobject][ordered]@{
            enabled = $true
            mode = if ($WhatIfOnly) { "whatIf" } else { "commit" }
            startupRoot = $startupRootFull
            matchedCount = 0
            removedCount = 0
            failedCount = 0
            matched = @()
            removed = @()
            failed = @()
            removedPaths = @()
        }
    }

    foreach ($legacyStartupName in $script:RevAgentExactLegacyStartupLauncherNames) {
        if ($failed.Count -gt 0 -and -not [bool]$rootSafety.safe) {
            break
        }

        $legacyStartupPath = Join-Path $startupRootFull $legacyStartupName
        try {
            $leafInfo = [RevAgent.DesktopLauncherCleanupNative]::Inspect($legacyStartupPath, $true)
        }
        catch {
            [void]$failed.Add((New-RevAgentExactStartupCleanupFailure `
                    -Path $legacyStartupPath `
                    -Name $legacyStartupName `
                    -Extension ([System.IO.Path]::GetExtension($legacyStartupName)) `
                    -Source "exact-legacy-startup-name" `
                    -Reason "leaf_inspection_failed" `
                    -ErrorMessage $_.Exception.Message `
                    -BlockedByPath $legacyStartupPath))
            continue
        }
        if ($null -eq $leafInfo) {
            continue
        }

        $record = [pscustomobject][ordered]@{
            path = Get-RevAgentLauncherCleanupFullPath -Path $legacyStartupPath
            name = $legacyStartupName
            extension = [System.IO.Path]::GetExtension($legacyStartupName)
            source = "exact-legacy-startup-name"
            linkCount = [uint32]$leafInfo.NumberOfLinks
            fileAttributes = [uint32]$leafInfo.FileAttributes
        }
        [void]$matched.Add($record)

        if (([uint32]$leafInfo.FileAttributes -band [uint32][System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            [void]$failed.Add((New-RevAgentExactStartupCleanupFailure `
                    -Path ([string]$record.path) `
                    -Name ([string]$record.name) `
                    -Extension ([string]$record.extension) `
                    -Source ([string]$record.source) `
                    -Reason "leaf_reparse_point" `
                    -ErrorMessage "Exact historical Startup launcher is a filesystem reparse point and was not followed or removed." `
                    -BlockedByPath ([string]$record.path) `
                    -LinkCount ([uint32]$leafInfo.NumberOfLinks) `
                    -FileAttributes ([uint32]$leafInfo.FileAttributes)))
            continue
        }
        if (([uint32]$leafInfo.FileAttributes -band [uint32][System.IO.FileAttributes]::Directory) -ne 0) {
            [void]$failed.Add((New-RevAgentExactStartupCleanupFailure `
                    -Path ([string]$record.path) `
                    -Name ([string]$record.name) `
                    -Extension ([string]$record.extension) `
                    -Source ([string]$record.source) `
                    -Reason "not_ordinary_file" `
                    -ErrorMessage "Exact historical Startup launcher is not an ordinary file." `
                    -BlockedByPath ([string]$record.path) `
                    -LinkCount ([uint32]$leafInfo.NumberOfLinks) `
                    -FileAttributes ([uint32]$leafInfo.FileAttributes)))
            continue
        }
        if ([uint32]$leafInfo.NumberOfLinks -ne 1) {
            [void]$failed.Add((New-RevAgentExactStartupCleanupFailure `
                    -Path ([string]$record.path) `
                    -Name ([string]$record.name) `
                    -Extension ([string]$record.extension) `
                    -Source ([string]$record.source) `
                    -Reason "non_unit_hardlink" `
                    -ErrorMessage ("Exact historical Startup launcher must have exactly one hardlink reference. linkCount={0}" -f [uint32]$leafInfo.NumberOfLinks) `
                    -BlockedByPath ([string]$record.path) `
                    -LinkCount ([uint32]$leafInfo.NumberOfLinks) `
                    -FileAttributes ([uint32]$leafInfo.FileAttributes)))
            continue
        }
        if ($WhatIfOnly) {
            continue
        }

        try {
            # Revalidate the complete directory chain and the no-follow leaf
            # handle immediately before mutation. File.Delete never clears
            # ReadOnly/Hidden attributes, so a protected or raced candidate
            # fails closed without rewriting metadata on an external sibling.
            $preDeleteRootSafety = Test-RevAgentExactStartupRootSafety -StartupRoot $startupRootFull
            if (-not [bool]$preDeleteRootSafety.safe -or -not [bool]$preDeleteRootSafety.exists) {
                throw "Startup root safety changed before exact launcher deletion. reason=$($preDeleteRootSafety.reason) blockedBy=$($preDeleteRootSafety.blockedByPath)"
            }
            $preDeleteLeafInfo = [RevAgent.DesktopLauncherCleanupNative]::Inspect($legacyStartupPath, $false)
            if (([uint32]$preDeleteLeafInfo.FileAttributes -band [uint32][System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                ([uint32]$preDeleteLeafInfo.FileAttributes -band [uint32][System.IO.FileAttributes]::Directory) -ne 0 -or
                [uint32]$preDeleteLeafInfo.NumberOfLinks -ne 1) {
                throw "Exact Startup launcher safety changed before deletion. attributes=$([uint32]$preDeleteLeafInfo.FileAttributes) linkCount=$([uint32]$preDeleteLeafInfo.NumberOfLinks)"
            }
            [System.IO.File]::Delete($legacyStartupPath)
            [void]$removed.Add($record)
            Write-Host "Removed legacy revAgent startup launcher: $legacyStartupPath"
        }
        catch {
            [void]$failed.Add((New-RevAgentExactStartupCleanupFailure `
                    -Path ([string]$record.path) `
                    -Name ([string]$record.name) `
                    -Extension ([string]$record.extension) `
                    -Source ([string]$record.source) `
                    -Reason "safe_delete_failed" `
                    -ErrorMessage $_.Exception.Message `
                    -BlockedByPath ([string]$record.path) `
                    -LinkCount ([uint32]$leafInfo.NumberOfLinks) `
                    -FileAttributes ([uint32]$leafInfo.FileAttributes)))
        }
    }

    return [pscustomobject][ordered]@{
        enabled = $true
        mode = if ($WhatIfOnly) { "whatIf" } elseif ($failed.Count -gt 0) { "failed" } else { "commit" }
        startupRoot = $startupRootFull
        matchedCount = $matched.Count
        removedCount = $removed.Count
        failedCount = $failed.Count
        matched = @($matched.ToArray())
        removed = @($removed.ToArray())
        failed = @($failed.ToArray())
        removedPaths = @($removed.ToArray() | ForEach-Object { [string]$_.path })
    }
}

function Test-RevAgentTextContainsAny {
    param(
        [string]$Text,
        [string[]]$Patterns
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $false
    }
    foreach ($pattern in $Patterns) {
        if ($Text.IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

function Get-RevAgentDefaultDesktopLauncherRoots {
    param([string]$ProfilesRoot = "")

    $paths = [System.Collections.Generic.List[string]]::new()
    $profileRoots = [System.Collections.Generic.List[string]]::new()
    foreach ($folder in @("DesktopDirectory", "CommonDesktopDirectory")) {
        try {
            $specialFolder = [Enum]::Parse([Environment+SpecialFolder], $folder)
            $value = [Environment]::GetFolderPath($specialFolder)
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                [void]$paths.Add($value)
            }
        }
        catch {}
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        [void]$paths.Add((Join-Path $env:USERPROFILE "Desktop"))
        [void]$profileRoots.Add($env:USERPROFILE)
    }
    foreach ($oneDriveRoot in @($env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer)) {
        if (-not [string]::IsNullOrWhiteSpace($oneDriveRoot)) {
            [void]$paths.Add((Join-Path $oneDriveRoot "Desktop"))
        }
    }

    if ([string]::IsNullOrWhiteSpace($ProfilesRoot)) {
        if (-not [string]::IsNullOrWhiteSpace($env:SystemDrive)) {
            $ProfilesRoot = Join-Path $env:SystemDrive "Users"
        }
        else {
            $ProfilesRoot = "C:\Users"
        }
    }
    if (Test-Path -LiteralPath $ProfilesRoot -PathType Container) {
        foreach ($profile in @(Get-ChildItem -LiteralPath $ProfilesRoot -Directory -ErrorAction SilentlyContinue)) {
            [void]$profileRoots.Add($profile.FullName)
            $desktop = Join-Path $profile.FullName "Desktop"
            if (Test-Path -LiteralPath $desktop -PathType Container) {
                [void]$paths.Add($desktop)
            }
        }
    }

    foreach ($profileRoot in @($profileRoots.ToArray() | Select-Object -Unique)) {
        foreach ($oneDriveFolder in @(Get-ChildItem -LiteralPath $profileRoot -Directory -Filter "OneDrive*" -ErrorAction SilentlyContinue)) {
            $oneDriveDesktop = Join-Path $oneDriveFolder.FullName "Desktop"
            if (Test-Path -LiteralPath $oneDriveDesktop -PathType Container) {
                [void]$paths.Add($oneDriveDesktop)
            }
        }
    }
    return @($paths.ToArray() | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
}

function Get-RevAgentDesktopLauncherFiles {
    param([string[]]$LauncherRoots = @())

    if ($LauncherRoots.Count -eq 0) {
        $LauncherRoots = @(Get-RevAgentDefaultDesktopLauncherRoots)
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $files = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
    foreach ($root in $LauncherRoots) {
        if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) {
            continue
        }
        foreach ($item in @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue)) {
            if ($script:RevAgentLauncherCandidateExtensions -contains $item.Extension.ToLowerInvariant() -and $seen.Add($item.FullName)) {
                [void]$files.Add($item)
            }
        }
    }
    return @($files.ToArray() | Sort-Object FullName)
}

function Read-RevAgentDesktopLauncherText {
    param([System.IO.FileInfo]$File)

    $parts = [System.Collections.Generic.List[string]]::new()
    [void]$parts.Add($File.Name)
    [void]$parts.Add($File.FullName)

    if ($File.Extension.ToLowerInvariant() -eq ".lnk") {
        try {
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut($File.FullName)
            foreach ($field in @($shortcut.TargetPath, $shortcut.Arguments, $shortcut.WorkingDirectory, $shortcut.Description, $shortcut.IconLocation)) {
                if (-not [string]::IsNullOrWhiteSpace([string]$field)) {
                    [void]$parts.Add([string]$field)
                }
            }
        }
        catch {
            [void]$parts.Add($_.Exception.Message)
        }
    }
    else {
        try {
            $text = Get-Content -Raw -LiteralPath $File.FullName -ErrorAction Stop
            if (-not [string]::IsNullOrWhiteSpace($text)) {
                [void]$parts.Add($text)
            }
        }
        catch {
            [void]$parts.Add($_.Exception.Message)
        }
    }

    return [string]::Join("`n", @($parts.ToArray()))
}

function Invoke-RevAgentLegacyDesktopLauncherCleanup {
    [CmdletBinding()]
    param(
        [string[]]$LauncherRoots = @(),
        [switch]$WhatIfOnly
    )

    $removed = [System.Collections.Generic.List[object]]::new()
    $failed = [System.Collections.Generic.List[object]]::new()
    $matched = [System.Collections.Generic.List[object]]::new()

    foreach ($file in @(Get-RevAgentDesktopLauncherFiles -LauncherRoots $LauncherRoots)) {
        $text = Read-RevAgentDesktopLauncherText -File $file
        if (-not (Test-RevAgentTextContainsAny -Text $text -Patterns $script:RevAgentLegacyLauncherPatterns)) {
            continue
        }

        $record = [pscustomobject][ordered]@{
            path = $file.FullName
            name = $file.Name
            extension = $file.Extension
        }
        [void]$matched.Add($record)

        if ($WhatIfOnly) {
            continue
        }

        try {
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
            [void]$removed.Add($record)
        }
        catch {
            [void]$failed.Add([pscustomobject][ordered]@{
                path = $file.FullName
                name = $file.Name
                extension = $file.Extension
                error = $_.Exception.Message
            })
        }
    }

    return [pscustomobject][ordered]@{
        enabled = $true
        mode = if ($WhatIfOnly) { "whatIf" } else { "commit" }
        matchedCount = $matched.Count
        removedCount = $removed.Count
        failedCount = $failed.Count
        matched = @($matched.ToArray())
        removed = @($removed.ToArray())
        failed = @($failed.ToArray())
    }
}

Export-ModuleMember -Function @(
    "Get-RevAgentDefaultDesktopLauncherRoots",
    "Invoke-RevAgentExactLegacyStartupLauncherCleanup",
    "Invoke-RevAgentLegacyDesktopLauncherCleanup",
    "Merge-RevAgentDesktopLauncherCleanupEvidence",
    "Merge-RevAgentLauncherCleanupEvidence"
)
