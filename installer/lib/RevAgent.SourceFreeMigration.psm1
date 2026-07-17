Set-StrictMode -Version Latest

$permissionsModulePath = Join-Path $PSScriptRoot "RevAgent.Permissions.psm1"
if (-not (Test-Path -LiteralPath $permissionsModulePath -PathType Leaf)) {
    throw "Source-free cleanup requires the sibling permissions module: $permissionsModulePath"
}
$permissionsModule = Import-Module $permissionsModulePath -ErrorAction Stop -PassThru
if ($null -eq $permissionsModule -or
    -not [string]::Equals([IO.Path]::GetFullPath([string]$permissionsModule.Path), [IO.Path]::GetFullPath($permissionsModulePath), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Source-free cleanup did not load the exact sibling permissions module: $permissionsModulePath"
}
if (-not ("RevAgent.PermissionNativeFileInfo" -as [type])) {
    throw "Source-free cleanup could not initialize the sibling permissions module: $permissionsModulePath"
}

if (-not ("RevAgent.SourceFreeMigrationNative" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public static class SourceFreeMigrationNative {
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
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle handle,
            out BY_HANDLE_FILE_INFORMATION information);

        public static uint GetLinkCount(string path) {
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                BY_HANDLE_FILE_INFORMATION information;
                if (!GetFileInformationByHandle(stream.SafeFileHandle, out information)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return information.NumberOfLinks;
            }
        }
    }
}
"@
}

function Get-RevitMcpSourceFreeFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "A source-free migration path must not be empty."
    }
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Test-RevitMcpSourceFreePathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$AllowRoot
    )

    $pathFull = Get-RevitMcpSourceFreeFullPath -Path $Path
    $rootFull = Get-RevitMcpSourceFreeFullPath -Path $Root
    if ($AllowRoot -and [string]::Equals($pathFull, $rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $pathFull.StartsWith($rootFull + "\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RevitMcpSourceFreeFileLinkCount {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [uint32][RevAgent.SourceFreeMigrationNative]::GetLinkCount((Get-RevitMcpSourceFreeFullPath -Path $Path))
}

function Get-RevitMcpSourceFreeManagedRoots {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,

        [string]$PackageTarget = "",

        [string]$ServerTarget = "",

        [string]$UserProfileRoot = "",

        [switch]$PreserveLocalCodexInstructions,

        [switch]$SkipCodexUserIntegration,

        [switch]$SkipBackups,

        [ValidateSet("all", "machine", "user")]
        [string]$Scope = "all",

        [string]$TargetCodexHome = ""
    )

    $roots = [System.Collections.Generic.List[object]]::new()
    $scopeName = $Scope.ToLowerInvariant()
    $includeMachineRoots = $scopeName -in @("all", "machine")
    $includeUserRoots = $scopeName -in @("all", "user")

    if ([string]::IsNullOrWhiteSpace($PackageTarget)) {
        $PackageTarget = Join-Path $InstallRoot "package"
    }
    if ([string]::IsNullOrWhiteSpace($ServerTarget)) {
        $ServerTarget = Join-Path $InstallRoot "runtime"
    }
    if ($includeUserRoots -and (-not $PreserveLocalCodexInstructions) -and (-not $SkipCodexUserIntegration)) {
        if ([string]::IsNullOrWhiteSpace($UserProfileRoot)) {
            $UserProfileRoot = $env:USERPROFILE
        }
        if ([string]::IsNullOrWhiteSpace($UserProfileRoot)) {
            throw "User-scoped source-free inventory requires the authenticated user profile root."
        }
        $userProfileFull = Get-RevitMcpSourceFreeFullPath -Path $UserProfileRoot
        $codexHomeFull = if ([string]::IsNullOrWhiteSpace($TargetCodexHome)) {
            Get-RevitMcpSourceFreeFullPath -Path (Join-Path $userProfileFull ".codex")
        }
        else {
            Get-RevitMcpSourceFreeFullPath -Path $TargetCodexHome
        }
        if (-not (Test-RevitMcpSourceFreePathInside -Path $codexHomeFull -Root $userProfileFull)) {
            throw "TargetCodexHome must be strictly inside the authenticated user profile root '$userProfileFull'; refusing '$codexHomeFull'."
        }
    }

    if ($includeMachineRoots) {
        $roots.Add([pscustomobject]@{ Label = "managed package"; Path = $PackageTarget; Kind = "package"; Scope = "machine"; BoundaryRoot = $InstallRoot })
        $roots.Add([pscustomobject]@{ Label = "runtime MCP server"; Path = $ServerTarget; Kind = "runtime"; Scope = "machine"; BoundaryRoot = $InstallRoot })
    }

    if (-not $PreserveLocalCodexInstructions) {
        if ($includeMachineRoots) {
            $roots.Add([pscustomobject]@{ Label = "machine Codex skill"; Path = (Join-Path $InstallRoot "codex\skills\revAgent"); Kind = "codexSkill"; Scope = "machine"; BoundaryRoot = $InstallRoot })
            $roots.Add([pscustomobject]@{ Label = "legacy machine Codex skill"; Path = (Join-Path $InstallRoot "codex\skills\revit-mcp"); Kind = "codexSkill"; Scope = "machine"; BoundaryRoot = $InstallRoot })
        }

        # Current Codex instructions live under the workspace .agents surface.
        # Retired per-user .codex skill paths are not broad source-cleanup
        # roots: the bounded canonical legacy inventory below removes only a
        # positively identified historical junction and preserves real/custom
        # directories.
    }

    if ($includeMachineRoots -and -not $SkipBackups) {
        $installRootFull = Get-RevitMcpSourceFreeFullPath -Path $InstallRoot
        $backupRoot = Get-RevitMcpSourceFreeFullPath -Path (Join-Path $installRootFull "updater\backups")
        if (-not (Test-RevitMcpSourceFreePathInside -Path $backupRoot -Root $installRootFull)) {
            $roots.Add([pscustomobject]@{
                    Label = "updater package backups"
                    Path = $backupRoot
                    Kind = "backup"
                    Scope = "machine"
                    BoundaryRoot = $installRootFull
                    InventoryIssueKind = "unsafeTopology"
                    InventoryIssueReason = "backup_root_outside_install_root"
                    InventoryIssueError = "Updater backups root is not strictly inside InstallRoot."
                })
        }
        else {
            $backupRootItem = $null
            try {
                $backupRootItem = Get-Item -LiteralPath $backupRoot -Force -ErrorAction Stop
            }
            catch [System.Management.Automation.ItemNotFoundException] {
                $backupRootItem = $null
            }
            catch {
                $roots.Add([pscustomobject]@{
                        Label = "updater package backups"
                        Path = $backupRoot
                        Kind = "backup"
                        Scope = "machine"
                        BoundaryRoot = $installRootFull
                        InventoryIssueKind = "inventoryFailure"
                        InventoryIssueReason = "backup_root_discovery_failed"
                        InventoryIssueError = $_.Exception.Message
                    })
                $backupRootItem = $null
            }

            if ($null -ne $backupRootItem) {
                try {
                    if (-not [bool]$backupRootItem.PSIsContainer) {
                        throw "Updater backups root is not a directory: $backupRoot"
                    }
                    $unsafeBackupPath = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $backupRoot -BoundaryRoot $installRootFull
                    if (-not [string]::IsNullOrWhiteSpace($unsafeBackupPath)) {
                        $roots.Add([pscustomobject]@{
                                Label = "updater package backups"
                                Path = $unsafeBackupPath
                                Kind = "backup"
                                Scope = "machine"
                                BoundaryRoot = $installRootFull
                                InventoryIssueKind = "unsafeTopology"
                                InventoryIssueReason = "reparse_point_in_backup_root_path"
                                InventoryIssueError = "Updater backups discovery refused reparse point '$unsafeBackupPath'."
                            })
                    }
                    else {
                        foreach ($backupDirectory in @(Get-ChildItem -LiteralPath $backupRoot -Directory -Filter "revit-mcp-skill.backup-*" -Force -ErrorAction Stop)) {
                            $backupDirectoryFull = Get-RevitMcpSourceFreeFullPath -Path $backupDirectory.FullName
                            if (-not (Test-RevitMcpSourceFreePathInside -Path $backupDirectoryFull -Root $backupRoot)) {
                                $roots.Add([pscustomobject]@{
                                        Label = "updater package backup"
                                        Path = $backupDirectoryFull
                                        Kind = "backup"
                                        Scope = "machine"
                                        BoundaryRoot = $installRootFull
                                        InventoryIssueKind = "unsafeTopology"
                                        InventoryIssueReason = "backup_directory_outside_backup_root"
                                        InventoryIssueError = "Discovered backup directory is outside the validated updater backups root."
                                    })
                                continue
                            }
                            if (($backupDirectory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                                $roots.Add([pscustomobject]@{
                                        Label = "updater package backup"
                                        Path = $backupDirectoryFull
                                        Kind = "backup"
                                        Scope = "machine"
                                        BoundaryRoot = $installRootFull
                                        InventoryIssueKind = "unsafeTopology"
                                        InventoryIssueReason = "reparse_point_backup_directory"
                                        InventoryIssueError = "Discovered updater backup directory is a reparse point."
                                    })
                                continue
                            }
                            $roots.Add([pscustomobject]@{ Label = "updater package backup"; Path = $backupDirectoryFull; Kind = "backup"; Scope = "machine"; BoundaryRoot = $installRootFull; MustRemainPresent = $true })
                        }
                    }
                }
                catch {
                    $roots.Add([pscustomobject]@{
                            Label = "updater package backups"
                            Path = $backupRoot
                            Kind = "backup"
                            Scope = "machine"
                            BoundaryRoot = $installRootFull
                            InventoryIssueKind = "inventoryFailure"
                            InventoryIssueReason = "backup_root_enumeration_failed"
                            InventoryIssueError = $_.Exception.Message
                        })
                }
            }
        }
    }

    return @($roots.ToArray())
}

function Get-RevitMcpSourceFreePathParts {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return @()
    }

    return @($Path -split '[\\/]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Get-RevitMcpSourceFreeRelativePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    if ($pathFull.Length -le $rootFull.Length) {
        return ""
    }

    return $pathFull.Substring($rootFull.Length).TrimStart([char[]]@('\', '/')).Replace("/", "\")
}

function Test-RevitMcpSourceFreeIgnoredPath {
    param([string]$RelativePath)

    foreach ($part in Get-RevitMcpSourceFreePathParts -Path $RelativePath) {
        if ($part -ieq "node_modules" -or $part -ieq "dependencies") {
            return $true
        }
    }

    return $false
}

function Test-RevitMcpSourceFreeAllowedDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [System.IO.DirectoryInfo]$Directory
    )

    $relative = Get-RevitMcpSourceFreeRelativePath -Root $Root -Path $Directory.FullName
    $parts = @(Get-RevitMcpSourceFreePathParts -Path $relative)
    return (
        $parts.Count -eq 3 -and
        $parts[0] -ieq "installer" -and
        $parts[1] -ieq "revit-api-docs-mcp" -and
        $parts[2] -ieq "scripts"
    )
}

function Test-RevitMcpSourceFreePathUnderAnyDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [string[]]$Directories
    )

    if ($null -eq $Directories -or $Directories.Count -eq 0) {
        return $false
    }

    $pathFull = [System.IO.Path]::GetFullPath($Path)
    foreach ($directory in $Directories) {
        $directoryFull = [System.IO.Path]::GetFullPath($directory).TrimEnd("\", "/") + "\"
        if ($pathFull.StartsWith($directoryFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

function Assert-RevitMcpSourceFreeCleanupTarget {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = $rootFull + "\"

    if (-not $pathFull.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing source-free cleanup outside managed root '$rootFull': $pathFull"
    }
    if ([string]::Equals($pathFull.TrimEnd("\", "/"), $rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing source-free cleanup of broad managed root: $pathFull"
    }

    return $pathFull
}

function Get-RevitMcpSourceFreeArtifactInventory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,

        [string]$PackageTarget = "",

        [string]$ServerTarget = "",

        [string]$UserProfileRoot = "",

        [switch]$PreserveLocalCodexInstructions,

        [switch]$SkipCodexUserIntegration,

        [switch]$SkipBackups,

        [ValidateSet("all", "machine", "user")]
        [string]$Scope = "all",

        [string]$TargetCodexHome = ""
    )

    $blockedDirectoryNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @("src", "docs", "references", "evals", "dashboard", "addons", "scripts", ".github", ".githooks", ".tmp")) {
        [void]$blockedDirectoryNames.Add($name)
    }

    $blockedFileExtensions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($extension in @(".cs", ".csproj", ".sln", ".ts", ".tsx", ".pdb", ".mdb", ".map")) {
        [void]$blockedFileExtensions.Add($extension)
    }

    $artifacts = [System.Collections.Generic.List[object]]::new()
    foreach ($rootInfo in Get-RevitMcpSourceFreeManagedRoots -InstallRoot $InstallRoot -PackageTarget $PackageTarget -ServerTarget $ServerTarget -UserProfileRoot $UserProfileRoot -PreserveLocalCodexInstructions:$PreserveLocalCodexInstructions -SkipCodexUserIntegration:$SkipCodexUserIntegration -SkipBackups:$SkipBackups -Scope $Scope -TargetCodexHome $TargetCodexHome) {
        $rootPath = [string]$rootInfo.Path
        if ($null -ne $rootInfo.PSObject.Properties["InventoryIssueKind"]) {
            $artifacts.Add([pscustomobject]@{
                    rootLabel = [string]$rootInfo.Label
                    rootKind = [string]$rootInfo.Kind
                    rootScope = [string]$rootInfo.Scope
                    rootPath = [string]$rootInfo.BoundaryRoot
                    kind = [string]$rootInfo.InventoryIssueKind
                    reason = [string]$rootInfo.InventoryIssueReason
                    relativePath = ""
                    path = $rootPath
                    cleanupAllowed = $false
                    error = [string]$rootInfo.InventoryIssueError
                })
            continue
        }
        if ([string]::IsNullOrWhiteSpace($rootPath)) {
            continue
        }
        if (-not (Test-Path -LiteralPath $rootPath)) {
            if ($null -ne $rootInfo.PSObject.Properties["MustRemainPresent"] -and [bool]$rootInfo.MustRemainPresent) {
                $artifacts.Add([pscustomobject]@{
                        rootLabel = [string]$rootInfo.Label
                        rootKind = [string]$rootInfo.Kind
                        rootScope = [string]$rootInfo.Scope
                        rootPath = [string]$rootInfo.BoundaryRoot
                        kind = "inventoryFailure"
                        reason = "discovered_backup_root_disappeared"
                        relativePath = ""
                        path = $rootPath
                        cleanupAllowed = $false
                        error = "A backup directory disappeared after validated discovery and before inventory."
                    })
            }
            continue
        }

        $rootFull = [System.IO.Path]::GetFullPath($rootPath).TrimEnd([char[]]@('\', '/'))
        $boundaryFull = [System.IO.Path]::GetFullPath([string]$rootInfo.BoundaryRoot).TrimEnd([char[]]@('\', '/'))
        $rootScope = [string]$rootInfo.Scope
        $rootItem = Get-Item -LiteralPath $rootFull -Force -ErrorAction SilentlyContinue
        if ($null -eq $rootItem -or -not [bool]$rootItem.PSIsContainer) {
            $artifacts.Add([pscustomobject]@{
                    rootLabel = [string]$rootInfo.Label
                    rootKind = [string]$rootInfo.Kind
                    rootScope = $rootScope
                    rootPath = $rootFull
                    kind = "unsafeTopology"
                    reason = "managed_root_not_directory"
                    relativePath = ""
                    path = $rootFull
                    cleanupAllowed = $false
                })
            continue
        }

        try {
            $unsafeRootPath = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $rootFull -BoundaryRoot $boundaryFull
            if (-not [string]::IsNullOrWhiteSpace($unsafeRootPath)) {
                $artifacts.Add([pscustomobject]@{
                        rootLabel = [string]$rootInfo.Label
                        rootKind = [string]$rootInfo.Kind
                        rootScope = $rootScope
                        rootPath = $rootFull
                        kind = "unsafeTopology"
                        reason = "reparse_point_in_managed_root_path"
                        relativePath = ""
                        path = $unsafeRootPath
                        cleanupAllowed = $false
                    })
                continue
            }
        }
        catch {
            $artifacts.Add([pscustomobject]@{
                    rootLabel = [string]$rootInfo.Label
                    rootKind = [string]$rootInfo.Kind
                    rootScope = $rootScope
                    rootPath = $rootFull
                    kind = "inventoryFailure"
                    reason = "managed_root_topology_validation_failed"
                    relativePath = ""
                    path = $rootFull
                    cleanupAllowed = $false
                    error = $_.Exception.Message
                })
            continue
        }

        $rootArtifactStartIndex = $artifacts.Count
        $blockedDirectories = [System.Collections.Generic.List[string]]::new()
        $safeDirectories = [System.Collections.Generic.List[System.IO.DirectoryInfo]]::new()
        $safeFiles = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
        $pendingDirectories = [System.Collections.Generic.Stack[string]]::new()
        $pendingDirectories.Push($rootFull)

        try {
            while ($pendingDirectories.Count -gt 0) {
                $currentDirectory = $pendingDirectories.Pop()
                foreach ($child in @(Get-ChildItem -LiteralPath $currentDirectory -Force -ErrorAction Stop)) {
                    if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                        $artifacts.Add([pscustomobject]@{
                                rootLabel = [string]$rootInfo.Label
                                rootKind = [string]$rootInfo.Kind
                                rootScope = $rootScope
                                rootPath = $rootFull
                                kind = "unsafeTopology"
                                reason = "reparse_point_in_managed_tree"
                                relativePath = (Get-RevitMcpSourceFreeRelativePath -Root $rootFull -Path $child.FullName)
                                path = $child.FullName
                                cleanupAllowed = $false
                            })
                        continue
                    }

                    if ([bool]$child.PSIsContainer) {
                        $safeDirectories.Add($child)
                        $pendingDirectories.Push([string]$child.FullName)
                    }
                    else {
                        $safeFiles.Add($child)
                    }
                }
            }
        }
        catch {
            $artifacts.Add([pscustomobject]@{
                    rootLabel = [string]$rootInfo.Label
                    rootKind = [string]$rootInfo.Kind
                    rootScope = $rootScope
                    rootPath = $rootFull
                    kind = "inventoryFailure"
                    reason = "managed_tree_inventory_failed"
                    relativePath = ""
                    path = $rootFull
                    cleanupAllowed = $false
                    error = $_.Exception.Message
                })
            continue
        }

        @($safeDirectories.ToArray()) |
            Where-Object {
                $relative = Get-RevitMcpSourceFreeRelativePath -Root $rootFull -Path $_.FullName
                $blockedDirectoryNames.Contains($_.Name) -and
                -not (Test-RevitMcpSourceFreeIgnoredPath -RelativePath $relative) -and
                -not (Test-RevitMcpSourceFreeAllowedDirectory -Root $rootFull -Directory $_)
            } |
            Sort-Object { $_.FullName.Length } |
            ForEach-Object {
                $relative = Get-RevitMcpSourceFreeRelativePath -Root $rootFull -Path $_.FullName
                $blockedDirectories.Add($_.FullName)
                $artifacts.Add([pscustomobject]@{
                    rootLabel = [string]$rootInfo.Label
                    rootKind = [string]$rootInfo.Kind
                    rootScope = $rootScope
                    rootPath = $rootFull
                    kind = "directory"
                    reason = "source_or_developer_directory"
                    relativePath = $relative
                    path = $_.FullName
                    cleanupAllowed = $true
                })
            }

        @($safeFiles.ToArray()) |
            Where-Object {
                $relative = Get-RevitMcpSourceFreeRelativePath -Root $rootFull -Path $_.FullName
                -not (Test-RevitMcpSourceFreeIgnoredPath -RelativePath $relative) -and
                -not (Test-RevitMcpSourceFreePathUnderAnyDirectory -Path $_.FullName -Directories @($blockedDirectories.ToArray())) -and
                (
                    $blockedFileExtensions.Contains($_.Extension) -or
                    $_.Name -like "*.test.js" -or
                    $_.Name -like "*.guard-test.js" -or
                    $_.Name -like "*.test.mjs" -or
                    $_.Name -ieq "tsconfig.json"
                )
            } |
            ForEach-Object {
                $relative = Get-RevitMcpSourceFreeRelativePath -Root $rootFull -Path $_.FullName
                $artifacts.Add([pscustomobject]@{
                    rootLabel = [string]$rootInfo.Label
                    rootKind = [string]$rootInfo.Kind
                    rootScope = $rootScope
                    rootPath = $rootFull
                    kind = "file"
                    reason = "source_or_developer_file"
                    relativePath = $relative
                    path = $_.FullName
                    cleanupAllowed = $true
                })
            }

        $rootCleanupCandidates = [System.Collections.Generic.List[object]]::new()
        for ($artifactIndex = $rootArtifactStartIndex; $artifactIndex -lt $artifacts.Count; $artifactIndex++) {
            $candidate = $artifacts[$artifactIndex]
            if ($null -ne $candidate.PSObject.Properties["cleanupAllowed"] -and [bool]$candidate.cleanupAllowed) {
                $rootCleanupCandidates.Add($candidate)
            }
        }
        $seenHardlinkFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($candidate in @($rootCleanupCandidates.ToArray())) {
            try {
                foreach ($finding in @(Get-RevAgentCleanupCandidateHardlinkFindings -Path ([string]$candidate.path) -BoundaryRoot ([string]$candidate.rootPath))) {
                    $findingPath = Get-RevitMcpSourceFreeFullPath -Path ([string]$finding.path)
                    if (-not $seenHardlinkFiles.Add($findingPath)) {
                        continue
                    }
                    $artifacts.Add([pscustomobject]@{
                            rootLabel = [string]$rootInfo.Label
                            rootKind = [string]$rootInfo.Kind
                            rootScope = $rootScope
                            rootPath = $rootFull
                            kind = "unsafeTopology"
                            reason = "non_unit_hardlink_in_cleanup_candidate"
                            relativePath = (Get-RevitMcpSourceFreeRelativePath -Root $rootFull -Path $findingPath)
                            path = $findingPath
                            linkCount = [uint32]$finding.linkCount
                            cleanupAllowed = $false
                        })
                }
            }
            catch {
                $artifacts.Add([pscustomobject]@{
                        rootLabel = [string]$rootInfo.Label
                        rootKind = [string]$rootInfo.Kind
                        rootScope = $rootScope
                        rootPath = $rootFull
                        kind = "inventoryFailure"
                        reason = "candidate_hardlink_inventory_failed"
                        relativePath = [string]$candidate.relativePath
                        path = [string]$candidate.path
                        cleanupAllowed = $false
                        error = $_.Exception.Message
                    })
            }
        }
    }

    return @($artifacts.ToArray() | Sort-Object rootLabel, relativePath)
}

function Invoke-RevitMcpSourceFreeArtifactCleanup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,

        [string]$PackageTarget = "",

        [string]$ServerTarget = "",

        [string]$UserProfileRoot = "",

        [switch]$PreserveLocalCodexInstructions,

        [switch]$SkipCodexUserIntegration,

        [switch]$SkipBackups,

        [switch]$Commit,

        [ValidateSet("all", "machine", "user")]
        [string]$Scope = "all",

        [string]$TargetCodexHome = "",

        [scriptblock]$TestAfterTransactionPreflightHook = $null,

        [scriptblock]$TestBeforeRecursiveDeleteDirectoryEnumerationHook = $null
    )

    $artifacts = @(Get-RevitMcpSourceFreeArtifactInventory -InstallRoot $InstallRoot -PackageTarget $PackageTarget -ServerTarget $ServerTarget -UserProfileRoot $UserProfileRoot -PreserveLocalCodexInstructions:$PreserveLocalCodexInstructions -SkipCodexUserIntegration:$SkipCodexUserIntegration -SkipBackups:$SkipBackups -Scope $Scope -TargetCodexHome $TargetCodexHome)
    $removed = [System.Collections.Generic.List[object]]::new()
    $failed = [System.Collections.Generic.List[object]]::new()
    $cleanupCandidates = @($artifacts | Where-Object {
            $null -ne $_.PSObject.Properties["cleanupAllowed"] -and [bool]$_.cleanupAllowed
        })
    $unsafeArtifacts = @($artifacts | Where-Object {
            $null -ne $_.PSObject.Properties["cleanupAllowed"] -and -not [bool]$_.cleanupAllowed
        })

    if ($Commit) {
        if ($unsafeArtifacts.Count -gt 0) {
            # Inventory/topology failure is a transaction-wide guard. Do not
            # partially delete safe-looking siblings while a reparse point or
            # unreadable subtree could be hiding another managed artifact.
            foreach ($artifact in $unsafeArtifacts) {
                $failed.Add([pscustomobject]@{
                        path = [string]$artifact.path
                        relativePath = [string]$artifact.relativePath
                        rootLabel = [string]$artifact.rootLabel
                        error = "Source-free cleanup was blocked by unsafe or unreadable managed-root topology: $([string]$artifact.reason)"
                    })
            }
        }
        else {
            $transactionPreflightError = ""
            try {
                Assert-RevitMcpSourceFreeCandidateSetHasUnitHardlinks -Candidates $cleanupCandidates
                Assert-RevAgentCleanupCandidateSetHasNoRetainedMutationHandles -Entries $cleanupCandidates
                if ($null -ne $TestAfterTransactionPreflightHook) {
                    & $TestAfterTransactionPreflightHook
                    # Test hook models a race after initial inventory. Recheck
                    # the complete set once more before the first mutation.
                    Assert-RevitMcpSourceFreeCandidateSetHasUnitHardlinks -Candidates $cleanupCandidates
                    Assert-RevAgentCleanupCandidateSetHasNoRetainedMutationHandles -Entries $cleanupCandidates
                }
            }
            catch {
                $transactionPreflightError = $_.Exception.Message
                $failed.Add([pscustomobject]@{
                        path = ""
                        relativePath = ""
                        rootLabel = "transaction-wide preflight"
                        error = $transactionPreflightError
                    })
            }

            if (-not [string]::IsNullOrWhiteSpace($transactionPreflightError)) {
                # A pre-existing or deterministically injected hardlink,
                # topology, or read failure aborts before the first mutation.
            }
            else {
            foreach ($artifact in @($cleanupCandidates | Sort-Object { [string]$_.path } -Descending)) {
                try {
                    $safePath = Assert-RevitMcpSourceFreeCleanupTarget -Path ([string]$artifact.path) -Root ([string]$artifact.rootPath)
                    if (Test-Path -LiteralPath $safePath) {
                        $unsafeAncestor = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $safePath -BoundaryRoot ([string]$artifact.rootPath)
                        if (-not [string]::IsNullOrWhiteSpace($unsafeAncestor)) {
                            throw "Source-free cleanup candidate topology changed to a reparse point '$unsafeAncestor': $safePath"
                        }

                        $expectedItemType = if ([string]$artifact.kind -eq "directory") { "directory" } else { "file" }
                        $immediateHardlinkFindings = @(Get-RevAgentCleanupCandidateHardlinkFindings -Path $safePath -BoundaryRoot ([string]$artifact.rootPath))
                        if ($immediateHardlinkFindings.Count -gt 0) {
                            $firstFinding = $immediateHardlinkFindings[0]
                            throw "Source-free cleanup candidate acquired a non-unit hardlink before mutation. path=$($firstFinding.path) linkCount=$($firstFinding.linkCount)"
                        }
                        Remove-RevAgentCleanupPathWithoutForce `
                            -Path $safePath `
                            -BoundaryRoot ([string]$artifact.rootPath) `
                            -ExpectedItemType $expectedItemType `
                            -TestBeforeDirectoryEnumerationHook $TestBeforeRecursiveDeleteDirectoryEnumerationHook
                    }
                    $removed.Add($artifact)
                }
                catch {
                    $failed.Add([pscustomobject]@{
                            path = [string]$artifact.path
                            relativePath = [string]$artifact.relativePath
                        rootLabel = [string]$artifact.rootLabel
                        error = $_.Exception.Message
                    })
                    break
                }
            }
            }
        }
    }

    $remaining = @(if ($Commit) {
            Get-RevitMcpSourceFreeArtifactInventory -InstallRoot $InstallRoot -PackageTarget $PackageTarget -ServerTarget $ServerTarget -UserProfileRoot $UserProfileRoot -PreserveLocalCodexInstructions:$PreserveLocalCodexInstructions -SkipCodexUserIntegration:$SkipCodexUserIntegration -SkipBackups:$SkipBackups -Scope $Scope -TargetCodexHome $TargetCodexHome
        }
        else {
            $artifacts
        })

    return [pscustomobject][ordered]@{
        mode = if ($Commit) { "commit" } else { "dryRun" }
        scope = $Scope.ToLowerInvariant()
        success = ($failed.Count -eq 0 -and $remaining.Count -eq 0)
        codexInstructionCleanupSkipped = [bool]$PreserveLocalCodexInstructions
        artifactCount = $artifacts.Count
        removedCount = $removed.Count
        failedCount = $failed.Count
        remainingCount = $remaining.Count
        artifacts = @($artifacts)
        removed = @($removed.ToArray())
        failed = @($failed.ToArray())
        remaining = @($remaining)
    }
}

function Get-RevAgentCanonicalLegacyFullPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "A canonical legacy-surface path must not be empty."
    }

    return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Test-RevAgentCanonicalLegacySamePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Left,

        [Parameter(Mandatory = $true)]
        [string]$Right
    )

    return [string]::Equals(
        (Get-RevAgentCanonicalLegacyFullPath -Path $Left),
        (Get-RevAgentCanonicalLegacyFullPath -Path $Right),
        [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-RevAgentCanonicalLegacyPathInside {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Root,

        [switch]$AllowRoot
    )

    $pathFull = Get-RevAgentCanonicalLegacyFullPath -Path $Path
    $rootFull = Get-RevAgentCanonicalLegacyFullPath -Path $Root
    if ($AllowRoot -and [string]::Equals($pathFull, $rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    return $pathFull.StartsWith($rootFull + "\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RevAgentCanonicalLegacyReparseState {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileSystemInfo]$Item
    )

    return (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Get-RevAgentCanonicalLegacyFirstReparseAncestor {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$BoundaryRoot,

        [switch]$AllowLeafReparsePoint
    )

    $pathFull = Get-RevAgentCanonicalLegacyFullPath -Path $Path
    $boundaryFull = Get-RevAgentCanonicalLegacyFullPath -Path $BoundaryRoot
    if (-not (Test-RevAgentCanonicalLegacyPathInside -Path $pathFull -Root $boundaryFull -AllowRoot)) {
        throw "Refusing canonical legacy-surface inspection outside '$boundaryFull': $pathFull"
    }

    $pathsToCheck = [System.Collections.Generic.List[string]]::new()
    $pathsToCheck.Add($boundaryFull)
    if (-not (Test-RevAgentCanonicalLegacySamePath -Left $pathFull -Right $boundaryFull)) {
        $relativePath = $pathFull.Substring($boundaryFull.Length).TrimStart([char[]]@('\', '/'))
        $currentPath = $boundaryFull
        foreach ($part in Get-RevitMcpSourceFreePathParts -Path $relativePath) {
            $currentPath = Join-Path $currentPath $part
            $pathsToCheck.Add($currentPath)
        }
    }

    for ($index = 0; $index -lt $pathsToCheck.Count; $index++) {
        $candidatePath = $pathsToCheck[$index]
        $candidateItem = Get-Item -LiteralPath $candidatePath -Force -ErrorAction SilentlyContinue
        if ($null -eq $candidateItem) {
            continue
        }
        if (-not (Get-RevAgentCanonicalLegacyReparseState -Item $candidateItem)) {
            continue
        }

        $isLeaf = ($index -eq ($pathsToCheck.Count - 1))
        if ($isLeaf -and $AllowLeafReparsePoint) {
            continue
        }

        return [string]$candidateItem.FullName
    }

    return ""
}

function Get-RevAgentCanonicalLegacyFirstTreeReparsePoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $rootItem = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (Get-RevAgentCanonicalLegacyReparseState -Item $rootItem) {
        return [string]$rootItem.FullName
    }
    if (-not [bool]$rootItem.PSIsContainer) {
        return ""
    }

    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push([string]$rootItem.FullName)
    while ($pending.Count -gt 0) {
        $directoryPath = $pending.Pop()
        foreach ($child in @(Get-ChildItem -LiteralPath $directoryPath -Force -ErrorAction Stop)) {
            if (Get-RevAgentCanonicalLegacyReparseState -Item $child) {
                return [string]$child.FullName
            }
            if ([bool]$child.PSIsContainer) {
                $pending.Push([string]$child.FullName)
            }
        }
    }

    return ""
}

function Get-RevAgentCleanupCandidateFiles {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BoundaryRoot
    )

    $pathFull = Get-RevAgentCanonicalLegacyFullPath -Path $Path
    $boundaryFull = Get-RevAgentCanonicalLegacyFullPath -Path $BoundaryRoot
    if (-not (Test-RevAgentCanonicalLegacyPathInside -Path $pathFull -Root $boundaryFull)) {
        throw "Cleanup candidate is outside its exact boundary '$boundaryFull': $pathFull"
    }
    $unsafeAncestor = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $pathFull -BoundaryRoot $boundaryFull
    if (-not [string]::IsNullOrWhiteSpace($unsafeAncestor)) {
        throw "Cleanup candidate contains a reparse point in its path '$unsafeAncestor': $pathFull"
    }

    $rootItem = Get-Item -LiteralPath $pathFull -Force -ErrorAction Stop
    if (-not [bool]$rootItem.PSIsContainer) {
        return @($rootItem)
    }

    $files = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push([string]$rootItem.FullName)
    while ($pending.Count -gt 0) {
        $directoryPath = $pending.Pop()
        foreach ($child in @(Get-ChildItem -LiteralPath $directoryPath -Force -ErrorAction Stop)) {
            if (Get-RevAgentCanonicalLegacyReparseState -Item $child) {
                throw "Cleanup candidate contains a reparse point '$($child.FullName)': $pathFull"
            }
            if ([bool]$child.PSIsContainer) {
                $pending.Push([string]$child.FullName)
            }
            else {
                $files.Add([System.IO.FileInfo]$child)
            }
        }
    }
    return @($files.ToArray())
}

function Get-RevAgentCleanupCandidateHardlinkFindings {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BoundaryRoot
    )

    $findings = [System.Collections.Generic.List[object]]::new()
    foreach ($file in @(Get-RevAgentCleanupCandidateFiles -Path $Path -BoundaryRoot $BoundaryRoot)) {
        $linkCount = Get-RevitMcpSourceFreeFileLinkCount -Path $file.FullName
        if ($linkCount -ne 1) {
            $findings.Add([pscustomobject][ordered]@{
                    path = [string]$file.FullName
                    linkCount = [uint32]$linkCount
                })
        }
    }
    return @($findings.ToArray())
}

function Assert-RevAgentCleanupCandidateSetHasUnitHardlinks {
    param([Parameter(Mandatory = $true)][object[]]$Entries)

    $seenFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $Entries) {
        $deletionMode = [string]$entry.deletionMode
        if ($deletionMode -eq "reparsePoint") {
            continue
        }
        foreach ($file in @(Get-RevAgentCleanupCandidateFiles -Path ([string]$entry.path) -BoundaryRoot ([string]$entry.rootPath))) {
            $fileFull = Get-RevAgentCanonicalLegacyFullPath -Path $file.FullName
            if (-not $seenFiles.Add($fileFull)) {
                continue
            }
            $linkCount = Get-RevitMcpSourceFreeFileLinkCount -Path $fileFull
            if ($linkCount -ne 1) {
                throw "Cleanup transaction rejected a non-unit hardlink before mutation. path=$fileFull linkCount=$linkCount"
            }
        }
    }
}

function Remove-RevAgentCleanupPathWithoutForce {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BoundaryRoot,
        [Parameter(Mandatory = $true)][ValidateSet("file", "directory")][string]$ExpectedItemType,
        [scriptblock]$TestBeforeDirectoryEnumerationHook = $null
    )

    $pathFull = Get-RevAgentCanonicalLegacyFullPath -Path $Path
    $boundaryFull = Get-RevAgentCanonicalLegacyFullPath -Path $BoundaryRoot
    if (-not (Test-RevAgentCanonicalLegacyPathInside -Path $pathFull -Root $boundaryFull)) {
        throw "Refusing cleanup outside exact boundary '$boundaryFull': $pathFull"
    }
    $unsafeAncestor = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $pathFull -BoundaryRoot $boundaryFull
    if (-not [string]::IsNullOrWhiteSpace($unsafeAncestor)) {
        throw "Refusing cleanup through reparse point '$unsafeAncestor': $pathFull"
    }

    $rootItem = Get-Item -LiteralPath $pathFull -Force -ErrorAction Stop
    $rootType = if ([bool]$rootItem.PSIsContainer) { "directory" } else { "file" }
    if ($rootType -ne $ExpectedItemType) {
        throw "Cleanup candidate changed item type. expected=$ExpectedItemType actual=$rootType path=$pathFull"
    }
    $rootIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($pathFull, ($rootType -eq "directory"))

    if ($rootType -eq "file") {
        $linkCount = Get-RevitMcpSourceFreeFileLinkCount -Path $pathFull
        if ($linkCount -ne 1) {
            throw "Refusing file deletion with non-unit hardlink count. path=$pathFull linkCount=$linkCount"
        }
        $currentRootItem = Get-Item -LiteralPath $pathFull -Force -ErrorAction Stop
        if ([bool]$currentRootItem.PSIsContainer -or (Get-RevAgentCanonicalLegacyReparseState -Item $currentRootItem) -or
            -not [string]::Equals(
                $rootIdentity,
                [RevAgent.PermissionNativeFileInfo]::GetIdentity($pathFull, $false),
                [System.StringComparison]::Ordinal)) {
            throw "Cleanup file changed exact identity or topology before deletion: $pathFull"
        }
        # File.Delete never clears ReadOnly or rewrites the underlying file's
        # metadata. If the file is protected or changes concurrently it fails
        # closed instead of forcing attribute changes against a shared inode.
        [System.IO.File]::Delete($pathFull)
        return
    }

    $directories = [System.Collections.Generic.List[object]]::new()
    $files = [System.Collections.Generic.List[object]]::new()
    $pending = [System.Collections.Generic.Stack[object]]::new()
    $pending.Push([pscustomobject][ordered]@{ Path = $pathFull; Identity = $rootIdentity })
    while ($pending.Count -gt 0) {
        $directoryRecord = $pending.Pop()
        $directoryPath = [string]$directoryRecord.Path
        if ($null -ne $TestBeforeDirectoryEnumerationHook) {
            & $TestBeforeDirectoryEnumerationHook $directoryPath
        }
        # A directory may sit in the traversal stack while another process
        # swaps its lexical path. Re-fetch the leaf and bind it to the exact
        # file id captured when it was queued before enumerating any children.
        $directoryHandle = [RevAgent.PermissionNativeFileInfo]::OpenNoMutation($directoryPath, $true)
        try {
            $directoryItem = Get-Item -LiteralPath $directoryPath -Force -ErrorAction Stop
            $directoryAttributes = [System.IO.FileAttributes][RevAgent.PermissionNativeFileInfo]::GetAttributes($directoryHandle)
            if (-not [bool]$directoryItem.PSIsContainer -or
                (Get-RevAgentCanonicalLegacyReparseState -Item $directoryItem) -or
                ($directoryAttributes -band [System.IO.FileAttributes]::Directory) -eq 0 -or
                ($directoryAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                -not [string]::Equals(
                    [string]$directoryRecord.Identity,
                    [RevAgent.PermissionNativeFileInfo]::GetIdentity($directoryHandle),
                    [System.StringComparison]::Ordinal) -or
                -not [string]::Equals(
                    [string]$directoryRecord.Identity,
                    [RevAgent.PermissionNativeFileInfo]::GetIdentity($directoryPath, $true),
                    [System.StringComparison]::Ordinal)) {
                throw "Recursive cleanup queued directory changed exact identity or topology before enumeration: $directoryPath"
            }
            $directories.Add($directoryRecord)
            # Keep the no-delete-share handle alive for the entire listing so
            # the verified directory cannot be renamed and replaced by a
            # junction between identity validation and child enumeration.
            foreach ($child in @(Get-ChildItem -LiteralPath $directoryPath -Force -ErrorAction Stop)) {
                if (Get-RevAgentCanonicalLegacyReparseState -Item $child) {
                    throw "Refusing recursive cleanup with reparse point '$($child.FullName)': $pathFull"
                }
                $childIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($child.FullName, [bool]$child.PSIsContainer)
                if ([bool]$child.PSIsContainer) {
                    $pending.Push([pscustomobject][ordered]@{ Path = [string]$child.FullName; Identity = $childIdentity })
                }
                else {
                    $files.Add([pscustomobject][ordered]@{ Path = [string]$child.FullName; Identity = $childIdentity })
                }
            }
        }
        finally {
            $directoryHandle.Dispose()
        }
    }

    foreach ($fileRecord in @($files.ToArray() | Sort-Object Path)) {
        $filePath = [string]$fileRecord.Path
        # Re-fetch and revalidate immediately before mutation. Even if a
        # hardlink is introduced after the transaction-wide preflight, Force
        # is never used and a detected shared file aborts before unlinking.
        $fileItem = Get-Item -LiteralPath $filePath -Force -ErrorAction Stop
        if ([bool]$fileItem.PSIsContainer -or (Get-RevAgentCanonicalLegacyReparseState -Item $fileItem)) {
            throw "Recursive cleanup file changed type/topology before deletion: $filePath"
        }
        if (-not [string]::Equals(
                [string]$fileRecord.Identity,
                [RevAgent.PermissionNativeFileInfo]::GetIdentity($filePath, $false),
                [System.StringComparison]::Ordinal)) {
            throw "Recursive cleanup file changed exact identity before deletion: $filePath"
        }
        $linkCount = Get-RevitMcpSourceFreeFileLinkCount -Path $filePath
        if ($linkCount -ne 1) {
            throw "Refusing recursive file deletion with non-unit hardlink count. path=$filePath linkCount=$linkCount"
        }
        [System.IO.File]::Delete($filePath)
    }
    foreach ($directoryRecord in @($directories.ToArray() | Sort-Object { ([string]$_.Path).Length } -Descending)) {
        $directoryPath = [string]$directoryRecord.Path
        $directoryItem = Get-Item -LiteralPath $directoryPath -Force -ErrorAction Stop
        if (-not [bool]$directoryItem.PSIsContainer -or (Get-RevAgentCanonicalLegacyReparseState -Item $directoryItem)) {
            throw "Recursive cleanup directory changed type/topology before deletion: $directoryPath"
        }
        if (-not [string]::Equals(
                [string]$directoryRecord.Identity,
                [RevAgent.PermissionNativeFileInfo]::GetIdentity($directoryPath, $true),
                [System.StringComparison]::Ordinal)) {
            throw "Recursive cleanup directory changed exact identity before deletion: $directoryPath"
        }
        [System.IO.Directory]::Delete($directoryPath, $false)
    }
}

function Assert-RevitMcpSourceFreeCandidateSetHasUnitHardlinks {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Candidates)

    $seenFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $Candidates) {
        foreach ($file in @(Get-RevAgentCleanupCandidateFiles -Path ([string]$candidate.path) -BoundaryRoot ([string]$candidate.rootPath))) {
            $fileFull = Get-RevitMcpSourceFreeFullPath -Path $file.FullName
            if (-not $seenFiles.Add($fileFull)) {
                continue
            }
            $linkCount = Get-RevitMcpSourceFreeFileLinkCount -Path $fileFull
            if ($linkCount -ne 1) {
                throw "Source-free cleanup transaction rejected a non-unit hardlink before mutation. path=$fileFull linkCount=$linkCount"
            }
        }
    }
}

function Assert-RevAgentCleanupCandidateSetHasNoRetainedMutationHandles {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Entries)

    if (@($Entries).Count -eq 0) {
        return
    }
    if (-not ("RevAgent.PermissionNativeFileInfo" -as [type])) {
        throw "Cleanup retained-handle attestation requires RevAgent.PermissionNativeFileInfo."
    }

    $recordByPath = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $allHandles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
    $pending = [System.Collections.Generic.Stack[object]]::new()
    try {
        foreach ($entry in $Entries) {
            $pathFull = Get-RevAgentCanonicalLegacyFullPath -Path ([string]$entry.path)
            $boundaryFull = Get-RevAgentCanonicalLegacyFullPath -Path ([string]$entry.rootPath)
            $deletionMode = if ($null -ne $entry.PSObject.Properties["deletionMode"]) { [string]$entry.deletionMode } else { "" }
            if (-not (Test-RevAgentCanonicalLegacyPathInside -Path $pathFull -Root $boundaryFull -AllowRoot)) {
                throw "Cleanup retained-handle candidate is outside its exact boundary '$boundaryFull': $pathFull"
            }

            $parentPath = Split-Path -Parent $pathFull
            if (-not [string]::IsNullOrWhiteSpace($parentPath) -and
                (Test-RevAgentCanonicalLegacyPathInside -Path $parentPath -Root $boundaryFull -AllowRoot) -and
                (Test-Path -LiteralPath $parentPath -PathType Container)) {
                $pending.Push([pscustomobject][ordered]@{ Path = $parentPath; Recurse = $false; AllowReparse = $false })
            }
            $pending.Push([pscustomobject][ordered]@{
                    Path = $pathFull
                    Recurse = ($deletionMode -ne "reparsePoint")
                    AllowReparse = ($deletionMode -eq "reparsePoint")
                })
        }

        while ($pending.Count -gt 0) {
            $spec = $pending.Pop()
            $specPath = Get-RevAgentCanonicalLegacyFullPath -Path ([string]$spec.Path)
            $record = $null
            if ($recordByPath.TryGetValue($specPath, [ref]$record)) {
                if ([bool]$spec.Recurse -and [bool]$record.IsDirectory -and -not [bool]$record.IsReparse -and -not [bool]$record.Enumerated) {
                    $record.Enumerated = $true
                    foreach ($childPath in [System.IO.Directory]::EnumerateFileSystemEntries($specPath)) {
                        $pending.Push([pscustomobject][ordered]@{ Path = $childPath; Recurse = $true; AllowReparse = $false })
                    }
                }
                continue
            }

            $item = Get-Item -LiteralPath $specPath -Force -ErrorAction Stop
            $isDirectory = [bool]$item.PSIsContainer
            $isReparse = Get-RevAgentCanonicalLegacyReparseState -Item $item
            if ($isReparse -and -not [bool]$spec.AllowReparse) {
                throw "Cleanup retained-handle candidate contains a reparse point: $specPath"
            }

            $handle = [RevAgent.PermissionNativeFileInfo]::OpenNoMutation($specPath, $isDirectory)
            try {
                $attributes = [System.IO.FileAttributes][RevAgent.PermissionNativeFileInfo]::GetAttributes($handle)
                $handleIsDirectory = (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0)
                $handleIsReparse = (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
                if ($handleIsDirectory -ne $isDirectory -or $handleIsReparse -ne $isReparse) {
                    throw "Cleanup retained-handle candidate changed item type or reparse state while it was being pinned: $specPath"
                }
                if (-not $isDirectory -and [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($handle) -ne 1) {
                    throw "Cleanup retained-handle candidate is a non-unit hardlink: $specPath"
                }
                $handleIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($handle)
                $pathIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($specPath, $isDirectory)
                if (-not [string]::Equals($handleIdentity, $pathIdentity, [System.StringComparison]::Ordinal)) {
                    throw "Cleanup retained-handle candidate changed exact identity while it was being pinned: $specPath"
                }

                $record = [pscustomobject][ordered]@{
                    Path = $specPath
                    Identity = $handleIdentity
                    IsDirectory = $isDirectory
                    IsReparse = $isReparse
                    Enumerated = $false
                    Handle = $handle
                }
                $recordByPath[$specPath] = $record
                [void]$allHandles.Add($handle)
                $handle = $null
            }
            finally {
                if ($null -ne $handle) { $handle.Dispose() }
            }

            if ([bool]$spec.Recurse -and $isDirectory -and -not $isReparse) {
                $record.Enumerated = $true
                foreach ($childPath in [System.IO.Directory]::EnumerateFileSystemEntries($specPath)) {
                    $pending.Push([pscustomobject][ordered]@{ Path = $childPath; Recurse = $true; AllowReparse = $false })
                }
            }
        }

        $rootHandle = $null
        $identities = [System.Collections.Generic.List[string]]::new()
        foreach ($record in @($recordByPath.Values)) {
            if ($null -eq $rootHandle -and [bool]$record.IsDirectory) {
                $rootHandle = $record.Handle
            }
            [void]$identities.Add([string]$record.Identity)
        }
        if ($null -eq $rootHandle) {
            throw "Cleanup retained-handle attestation did not pin a directory boundary."
        }
        [RevAgent.PermissionNativeFileInfo]::AssertNoMutationHandles(
            $rootHandle,
            [string[]]$identities.ToArray(),
            [Microsoft.Win32.SafeHandles.SafeFileHandle[]]$allHandles.ToArray())

        # Keep every handle alive while paths are rebound. A rename/delete
        # swap cannot succeed through these no-delete-share handles; any data,
        # type, hardlink, or reparse change still fails this final check.
        foreach ($record in @($recordByPath.Values)) {
            $currentItem = Get-Item -LiteralPath ([string]$record.Path) -Force -ErrorAction Stop
            if ([bool]$currentItem.PSIsContainer -ne [bool]$record.IsDirectory -or
                (Get-RevAgentCanonicalLegacyReparseState -Item $currentItem) -ne [bool]$record.IsReparse -or
                -not [string]::Equals(
                    [string]$record.Identity,
                    [RevAgent.PermissionNativeFileInfo]::GetIdentity([string]$record.Path, [bool]$record.IsDirectory),
                    [System.StringComparison]::Ordinal)) {
                throw "Cleanup retained-handle candidate changed exact identity or topology during attestation: $($record.Path)"
            }
            if (-not [bool]$record.IsDirectory -and [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($record.Handle) -ne 1) {
                throw "Cleanup retained-handle candidate became a non-unit hardlink during attestation: $($record.Path)"
            }
        }
    }
    finally {
        foreach ($handle in $allHandles) {
            if ($null -ne $handle) { $handle.Dispose() }
        }
    }
}

function Get-RevAgentCanonicalLegacyLinkTargetPath {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileSystemInfo]$Item
    )

    $targetValues = @($Item.Target | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if ($targetValues.Count -ne 1) {
        return ""
    }

    $targetPath = [string]$targetValues[0]
    if (-not [System.IO.Path]::IsPathRooted($targetPath)) {
        $targetPath = Join-Path $Item.DirectoryName $targetPath
    }

    return Get-RevAgentCanonicalLegacyFullPath -Path $targetPath
}

function Test-RevAgentCanonicalLegacyLinkTargetAllowed {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileSystemInfo]$Item,

        [Parameter(Mandatory = $true)]
        [string]$AllowedTargetRoot
    )

    $targetPath = Get-RevAgentCanonicalLegacyLinkTargetPath -Item $Item
    if ([string]::IsNullOrWhiteSpace($targetPath)) {
        return $false
    }

    return Test-RevAgentCanonicalLegacyPathInside -Path $targetPath -Root $AllowedTargetRoot -AllowRoot
}

function New-RevAgentCanonicalLegacySurfaceEntry {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Scope,

        [Parameter(Mandatory = $true)]
        [string]$Surface,

        [Parameter(Mandatory = $true)]
        [string]$Reason,

        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$RootPath,

        [string]$ItemType = "unknown",

        [string]$DeletionMode = "none",

        [string]$BlockedByPath = "",

        [string]$AllowedReparseTargetRoot = ""
    )

    return [pscustomobject][ordered]@{
        scope = $Scope
        surface = $Surface
        reason = $Reason
        path = Get-RevAgentCanonicalLegacyFullPath -Path $Path
        rootPath = Get-RevAgentCanonicalLegacyFullPath -Path $RootPath
        itemType = $ItemType
        deletionMode = $DeletionMode
        blockedByPath = $BlockedByPath
        allowedReparseTargetRoot = $AllowedReparseTargetRoot
    }
}

function Add-RevAgentCanonicalLegacyCandidate {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Scope,

        [Parameter(Mandatory = $true)]
        [string]$Surface,

        [Parameter(Mandatory = $true)]
        [string]$Reason,

        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$BoundaryRoot,

        [Parameter(Mandatory = $true)]
        [ValidateSet("file", "directory")]
        [string]$ExpectedItemType,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Matched,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Preserved,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Failed,

        [switch]$AllowLeafReparsePoint,

        [string]$AllowedReparseTargetRoot = ""
    )

    try {
        $pathFull = Get-RevAgentCanonicalLegacyFullPath -Path $Path
        $boundaryFull = Get-RevAgentCanonicalLegacyFullPath -Path $BoundaryRoot
        if (-not (Test-RevAgentCanonicalLegacyPathInside -Path $pathFull -Root $boundaryFull)) {
            throw "Candidate is outside its exact legacy-surface boundary '$boundaryFull': $pathFull"
        }

        $item = Get-Item -LiteralPath $pathFull -Force -ErrorAction SilentlyContinue
        if ($null -eq $item) {
            return "missing"
        }

        $actualItemType = if ([bool]$item.PSIsContainer) { "directory" } else { "file" }
        if (-not [string]::Equals($actualItemType, $ExpectedItemType, [System.StringComparison]::OrdinalIgnoreCase)) {
            $Preserved.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $Scope -Surface $Surface -Reason "unexpected_item_type" -Path $pathFull -RootPath $boundaryFull -ItemType $actualItemType -BlockedByPath $pathFull))
            return "preserved"
        }

        $unsafeAncestor = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $pathFull -BoundaryRoot $boundaryFull -AllowLeafReparsePoint:$AllowLeafReparsePoint
        if (-not [string]::IsNullOrWhiteSpace($unsafeAncestor)) {
            $Preserved.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $Scope -Surface $Surface -Reason "reparse_point_in_candidate_path" -Path $pathFull -RootPath $boundaryFull -ItemType $actualItemType -BlockedByPath $unsafeAncestor))
            return "preserved"
        }

        $isReparsePoint = Get-RevAgentCanonicalLegacyReparseState -Item $item
        if ($isReparsePoint) {
            if (-not $AllowLeafReparsePoint) {
                $Preserved.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $Scope -Surface $Surface -Reason "candidate_is_reparse_point" -Path $pathFull -RootPath $boundaryFull -ItemType $actualItemType -BlockedByPath $pathFull))
                return "preserved"
            }

            if ([string]::IsNullOrWhiteSpace($AllowedReparseTargetRoot)) {
                throw "An allowed reparse-point candidate requires one exact allowed target root: $pathFull"
            }
            $allowedTargetRootFull = Get-RevAgentCanonicalLegacyFullPath -Path $AllowedReparseTargetRoot
            if (-not (Test-RevAgentCanonicalLegacyLinkTargetAllowed -Item $item -AllowedTargetRoot $allowedTargetRootFull)) {
                $actualTarget = Get-RevAgentCanonicalLegacyLinkTargetPath -Item $item
                $Preserved.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $Scope -Surface $Surface -Reason "custom_legacy_codex_skill_link_preserved" -Path $pathFull -RootPath $boundaryFull -ItemType $actualItemType -BlockedByPath $actualTarget -AllowedReparseTargetRoot $allowedTargetRootFull))
                return "preserved"
            }

            $Matched.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $Scope -Surface $Surface -Reason $Reason -Path $pathFull -RootPath $boundaryFull -ItemType $actualItemType -DeletionMode "reparsePoint" -AllowedReparseTargetRoot $allowedTargetRootFull))
            return "matched"
        }

        if ($AllowLeafReparsePoint) {
            $Preserved.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $Scope -Surface $Surface -Reason "real_legacy_codex_skill_preserved" -Path $pathFull -RootPath $boundaryFull -ItemType $actualItemType -BlockedByPath $pathFull))
            return "preserved"
        }

        if ([bool]$item.PSIsContainer) {
            $unsafeTreePath = Get-RevAgentCanonicalLegacyFirstTreeReparsePoint -Path $pathFull
            if (-not [string]::IsNullOrWhiteSpace($unsafeTreePath)) {
                $Preserved.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $Scope -Surface $Surface -Reason "nested_reparse_point_preserved" -Path $pathFull -RootPath $boundaryFull -ItemType $actualItemType -BlockedByPath $unsafeTreePath))
                return "preserved"
            }
        }

        $hardlinkFindings = @(Get-RevAgentCleanupCandidateHardlinkFindings -Path $pathFull -BoundaryRoot $boundaryFull)
        if ($hardlinkFindings.Count -gt 0) {
            foreach ($hardlinkFinding in $hardlinkFindings) {
                $Preserved.Add((New-RevAgentCanonicalLegacySurfaceEntry `
                            -Scope $Scope `
                            -Surface $Surface `
                            -Reason "non_unit_hardlink_in_candidate" `
                            -Path ([string]$hardlinkFinding.path) `
                            -RootPath $boundaryFull `
                            -ItemType "file" `
                            -BlockedByPath ([string]$hardlinkFinding.path)))
            }
            return "preserved"
        }

        $deletionMode = if ([bool]$item.PSIsContainer) { "recursiveDirectory" } else { "file" }
        $Matched.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $Scope -Surface $Surface -Reason $Reason -Path $pathFull -RootPath $boundaryFull -ItemType $actualItemType -DeletionMode $deletionMode))
        return "matched"
    }
    catch {
        $Failed.Add([pscustomobject][ordered]@{
                scope = $Scope
                surface = $Surface
                reason = "inventory_failed"
                path = $Path
                error = $_.Exception.Message
            })
        return "failed"
    }
}

function Add-RevAgentCanonicalLegacyAddinInventory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Scope,

        [Parameter(Mandatory = $true)]
        [string]$AddinsRoot,

        [Parameter(Mandatory = $true)]
        [string]$BoundaryRoot,

        [Parameter(Mandatory = $true)]
        [object[]]$ArtifactSpecs,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Matched,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Preserved,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[object]]$Failed
    )

    $addinsRootFull = Get-RevAgentCanonicalLegacyFullPath -Path $AddinsRoot
    $boundaryFull = Get-RevAgentCanonicalLegacyFullPath -Path $BoundaryRoot
    if (-not (Test-RevAgentCanonicalLegacyPathInside -Path $addinsRootFull -Root $boundaryFull)) {
        throw "Revit Addins root is outside the required canonical boundary '$boundaryFull': $addinsRootFull"
    }

    $addinsRootItem = Get-Item -LiteralPath $addinsRootFull -Force -ErrorAction SilentlyContinue
    if ($null -eq $addinsRootItem) {
        return
    }

    try {
        $unsafeAddinsAncestor = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $addinsRootFull -BoundaryRoot $boundaryFull
        if (-not [string]::IsNullOrWhiteSpace($unsafeAddinsAncestor)) {
            $Preserved.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $Scope -Surface "revit_addins_root" -Reason "reparse_point_in_addins_path" -Path $addinsRootFull -RootPath $boundaryFull -ItemType "directory" -BlockedByPath $unsafeAddinsAncestor))
            return
        }

        foreach ($versionDirectory in @(Get-ChildItem -LiteralPath $addinsRootFull -Directory -Force -ErrorAction Stop | Sort-Object Name)) {
            if ($versionDirectory.Name -notmatch '^20[0-9]{2}$') {
                continue
            }
            if (Get-RevAgentCanonicalLegacyReparseState -Item $versionDirectory) {
                $Preserved.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $Scope -Surface "revit_addin_version" -Reason "revit_addin_version_reparse_point" -Path $versionDirectory.FullName -RootPath $boundaryFull -ItemType "directory" -BlockedByPath $versionDirectory.FullName))
                continue
            }

            foreach ($artifactSpec in $ArtifactSpecs) {
                [void](Add-RevAgentCanonicalLegacyCandidate `
                        -Scope $Scope `
                        -Surface ([string]$artifactSpec.Surface) `
                        -Reason ([string]$artifactSpec.Reason) `
                        -Path (Join-Path $versionDirectory.FullName ([string]$artifactSpec.Name)) `
                        -BoundaryRoot $boundaryFull `
                        -ExpectedItemType ([string]$artifactSpec.ItemType) `
                        -Matched $Matched `
                        -Preserved $Preserved `
                        -Failed $Failed)
            }

            # Disabled legacy manifests were historically written only at the
            # Revit version root. Enumerate that one directory so a foreign
            # vendor's nested file can never match by basename.
            foreach ($directChild in @(Get-ChildItem -LiteralPath $versionDirectory.FullName -File -Force -ErrorAction Stop)) {
                if ($directChild.Name -notmatch '^revit-mcp\.addin\.disabled-[a-z0-9._-]+$') {
                    continue
                }

                [void](Add-RevAgentCanonicalLegacyCandidate `
                        -Scope $Scope `
                        -Surface "${Scope}_revit_addin_manifest" `
                        -Reason "bounded_legacy_revit_addin_disabled_manifest" `
                        -Path $directChild.FullName `
                        -BoundaryRoot $boundaryFull `
                        -ExpectedItemType "file" `
                        -Matched $Matched `
                        -Preserved $Preserved `
                        -Failed $Failed)
            }

            # These are the only historical loose-binary layouts. Do not
            # recursively search by basename: another add-in may legitimately
            # carry a DLL with the same filename under its own subtree.
            $historicalBinaryRelativePaths = @(
                "revit-mcp-plugin.dll",
                "revit-mcp-sdk.dll",
                ("Commands\SampleCommandset\{0}\revit-mcp-sdk.dll" -f $versionDirectory.Name)
            )
            foreach ($relativeBinaryPath in $historicalBinaryRelativePaths) {
                [void](Add-RevAgentCanonicalLegacyCandidate `
                        -Scope $Scope `
                        -Surface "${Scope}_revit_addin_binary" `
                        -Reason "exact_historical_legacy_revit_addin_binary" `
                        -Path (Join-Path $versionDirectory.FullName $relativeBinaryPath) `
                        -BoundaryRoot $boundaryFull `
                        -ExpectedItemType "file" `
                        -Matched $Matched `
                        -Preserved $Preserved `
                        -Failed $Failed)
            }
        }
    }
    catch {
        $Failed.Add([pscustomobject][ordered]@{
                scope = $Scope
                surface = "revit_addins_root"
                reason = "inventory_failed"
                path = $addinsRootFull
                error = $_.Exception.Message
            })
    }
}

function Test-RevAgentCanonicalLegacyPreservedEntryBlocksCleanup {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Entry
    )

    $surface = [string]$Entry.surface
    $reason = [string]$Entry.reason

    # Unknown siblings and operator-owned Codex surfaces are evidence only.
    # They are deliberately outside the exact managed cleanup allowlist.
    if ($reason -eq "not_allowlisted_legacy_install_child" -or
        $reason -eq "protected_legacy_state_preserved" -or
        $reason -eq "custom_legacy_codex_skill_link_preserved" -or
        $reason -eq "real_legacy_codex_skill_preserved" -or
        $surface -eq "user_codex_legacy_skill_reparse" -or
        $surface -eq "user_codex_retired_revagent_skill_reparse") {
        return $false
    }

    if ($surface -eq "legacy_install_root" -or
        $surface -eq "legacy_install_root_child" -or
        $surface -eq "canonical_npm_legacy_namespace") {
        return $true
    }

    # A reparse/type/topology problem at an add-in root, version, manifest,
    # binary, or exact payload can hide an active legacy product artifact.
    return $surface -match 'revit_addin'
}

function Get-RevAgentCanonicalLegacySurfaceInventoryInternal {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("machine", "user")]
        [string]$Scope,

        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,

        [string]$UserProfileRoot = "",

        [string]$RoamingAppDataRoot = "",

        [string]$TargetCodexHome = "",

        [switch]$PreserveLocalCodexInstructions,

        [Parameter(Mandatory = $true)]
        [string]$CommonAppDataRoot
    )

    $scopeName = $Scope.ToLowerInvariant()
    $commonRootFull = Get-RevAgentCanonicalLegacyFullPath -Path $CommonAppDataRoot
    $installRootFull = Get-RevAgentCanonicalLegacyFullPath -Path $InstallRoot
    $expectedInstallRoot = Get-RevAgentCanonicalLegacyFullPath -Path (Join-Path $commonRootFull "DPE\revAgent")
    if (-not (Test-RevAgentCanonicalLegacySamePath -Left $installRootFull -Right $expectedInstallRoot)) {
        throw "Canonical legacy-surface cleanup requires InstallRoot '$expectedInstallRoot'; refusing '$installRootFull'."
    }

    $userRootFull = ""
    $roamingRootFull = ""
    $targetCodexHomeFull = ""
    if ($scopeName -eq "user") {
        if ([string]::IsNullOrWhiteSpace($UserProfileRoot) -or [string]::IsNullOrWhiteSpace($RoamingAppDataRoot)) {
            throw "Canonical user legacy-surface cleanup requires explicit UserProfileRoot and RoamingAppDataRoot values."
        }
        $userRootFull = Get-RevAgentCanonicalLegacyFullPath -Path $UserProfileRoot
        $roamingRootFull = Get-RevAgentCanonicalLegacyFullPath -Path $RoamingAppDataRoot
        if (-not (Test-RevAgentCanonicalLegacyPathInside -Path $roamingRootFull -Root $userRootFull)) {
            throw "Canonical user legacy-surface cleanup requires RoamingAppDataRoot under UserProfileRoot; refusing '$roamingRootFull'."
        }
        $targetCodexHomeFull = if ([string]::IsNullOrWhiteSpace($TargetCodexHome)) {
            Get-RevAgentCanonicalLegacyFullPath -Path (Join-Path $userRootFull ".codex")
        }
        else {
            Get-RevAgentCanonicalLegacyFullPath -Path $TargetCodexHome
        }
        if (-not (Test-RevAgentCanonicalLegacyPathInside -Path $targetCodexHomeFull -Root $userRootFull)) {
            throw "Canonical user cleanup requires TargetCodexHome strictly inside the authenticated UserProfileRoot '$userRootFull'; refusing '$targetCodexHomeFull'."
        }
    }

    $matched = [System.Collections.Generic.List[object]]::new()
    $preserved = [System.Collections.Generic.List[object]]::new()
    $failed = [System.Collections.Generic.List[object]]::new()

    $machineAddinSpecs = @(
        [pscustomobject]@{ Name = "mcp-servers-for-revit.addin"; ItemType = "file"; Surface = "machine_revit_addin_manifest"; Reason = "exact_legacy_revit_addin_manifest" },
        [pscustomobject]@{ Name = "mcp_servers_for_revit.addin"; ItemType = "file"; Surface = "machine_revit_addin_manifest"; Reason = "exact_legacy_revit_addin_manifest" },
        [pscustomobject]@{ Name = "revit-mcp.addin"; ItemType = "file"; Surface = "machine_revit_addin_manifest"; Reason = "exact_legacy_revit_addin_manifest" },
        [pscustomobject]@{ Name = "revit_mcp_plugin"; ItemType = "directory"; Surface = "machine_revit_addin_payload"; Reason = "exact_legacy_revit_addin_payload" },
        [pscustomobject]@{ Name = "revit-mcp-plugin"; ItemType = "directory"; Surface = "machine_revit_addin_payload"; Reason = "exact_legacy_revit_addin_payload" }
    )
    $userAddinSpecs = @(
        [pscustomobject]@{ Name = "revAgent.addin"; ItemType = "file"; Surface = "user_revit_addin_manifest"; Reason = "exact_legacy_user_revit_addin_manifest" },
        [pscustomobject]@{ Name = "mcp-servers-for-revit.addin"; ItemType = "file"; Surface = "user_revit_addin_manifest"; Reason = "exact_legacy_user_revit_addin_manifest" },
        [pscustomobject]@{ Name = "mcp_servers_for_revit.addin"; ItemType = "file"; Surface = "user_revit_addin_manifest"; Reason = "exact_legacy_user_revit_addin_manifest" },
        [pscustomobject]@{ Name = "revit-mcp.addin"; ItemType = "file"; Surface = "user_revit_addin_manifest"; Reason = "exact_legacy_user_revit_addin_manifest" },
        [pscustomobject]@{ Name = "revAgentPlugin"; ItemType = "directory"; Surface = "user_revit_addin_payload"; Reason = "exact_legacy_user_revit_addin_payload" },
        [pscustomobject]@{ Name = "revit_mcp_plugin"; ItemType = "directory"; Surface = "user_revit_addin_payload"; Reason = "exact_legacy_user_revit_addin_payload" },
        [pscustomobject]@{ Name = "revit-mcp-plugin"; ItemType = "directory"; Surface = "user_revit_addin_payload"; Reason = "exact_legacy_user_revit_addin_payload" }
    )

    if ($scopeName -eq "machine") {
        $legacyInstallRoot = Get-RevAgentCanonicalLegacyFullPath -Path (Join-Path $commonRootFull "DPE\RevitMCP")
        $legacyInstallItem = Get-Item -LiteralPath $legacyInstallRoot -Force -ErrorAction SilentlyContinue
        if ($null -ne $legacyInstallItem) {
            $unsafeLegacyRoot = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $legacyInstallRoot -BoundaryRoot $commonRootFull
            if ((-not [bool]$legacyInstallItem.PSIsContainer) -or -not [string]::IsNullOrWhiteSpace($unsafeLegacyRoot)) {
                $preserved.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $scopeName -Surface "legacy_install_root" -Reason "legacy_install_root_not_safe_directory" -Path $legacyInstallRoot -RootPath $commonRootFull -ItemType $(if ([bool]$legacyInstallItem.PSIsContainer) { "directory" } else { "file" }) -BlockedByPath $(if ([string]::IsNullOrWhiteSpace($unsafeLegacyRoot)) { $legacyInstallRoot } else { $unsafeLegacyRoot })))
            }
            else {
                $legacyChildSpecs = @{
                    "package" = "directory"
                    "runtime" = "directory"
                    "updater" = "directory"
                    "revit-plugin" = "directory"
                    "commands" = "directory"
                    "codex" = "directory"
                    "dependencies" = "directory"
                    ".revit-mcp-programdata-install" = "file"
                    ".revagent-programdata-install" = "file"
                }
                $allChildrenMatched = $true
                $legacyChildren = @(Get-ChildItem -LiteralPath $legacyInstallRoot -Force -ErrorAction Stop)
                foreach ($legacyChild in $legacyChildren) {
                    if ([string]::Equals([string]$legacyChild.Name, "state", [System.StringComparison]::OrdinalIgnoreCase)) {
                        $stateBlockedBy = if ([bool]$legacyChild.PSIsContainer) {
                            Get-RevAgentCanonicalLegacyFirstTreeReparsePoint -Path $legacyChild.FullName
                        }
                        else {
                            [string]$legacyChild.FullName
                        }
                        $stateReason = if ([string]::IsNullOrWhiteSpace($stateBlockedBy)) {
                            "protected_legacy_state_preserved"
                        }
                        else {
                            "nested_reparse_point_preserved"
                        }
                        $preserved.Add((New-RevAgentCanonicalLegacySurfaceEntry `
                                -Scope $scopeName `
                                -Surface "legacy_install_root_child" `
                                -Reason $stateReason `
                                -Path $legacyChild.FullName `
                                -RootPath $legacyInstallRoot `
                                -ItemType $(if ([bool]$legacyChild.PSIsContainer) { "directory" } else { "file" }) `
                                -BlockedByPath $stateBlockedBy))
                        $allChildrenMatched = $false
                        continue
                    }
                    if (-not $legacyChildSpecs.ContainsKey([string]$legacyChild.Name)) {
                        $preserved.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $scopeName -Surface "legacy_install_root_child" -Reason "not_allowlisted_legacy_install_child" -Path $legacyChild.FullName -RootPath $legacyInstallRoot -ItemType $(if ([bool]$legacyChild.PSIsContainer) { "directory" } else { "file" }) -BlockedByPath $legacyChild.FullName))
                        $allChildrenMatched = $false
                        continue
                    }

                    $classification = Add-RevAgentCanonicalLegacyCandidate `
                        -Scope $scopeName `
                        -Surface "legacy_install_root_child" `
                        -Reason "exact_allowlisted_legacy_install_child" `
                        -Path $legacyChild.FullName `
                        -BoundaryRoot $legacyInstallRoot `
                        -ExpectedItemType ([string]$legacyChildSpecs[[string]$legacyChild.Name]) `
                        -Matched $matched `
                        -Preserved $preserved `
                        -Failed $failed
                    if ($classification -ne "matched") {
                        $allChildrenMatched = $false
                    }
                }

                if ($allChildrenMatched) {
                    $matched.Add((New-RevAgentCanonicalLegacySurfaceEntry -Scope $scopeName -Surface "legacy_install_root" -Reason "remove_legacy_install_root_only_after_empty" -Path $legacyInstallRoot -RootPath $commonRootFull -ItemType "directory" -DeletionMode "emptyDirectory"))
                }
            }
        }

        Add-RevAgentCanonicalLegacyAddinInventory `
            -Scope $scopeName `
            -AddinsRoot (Join-Path $commonRootFull "Autodesk\Revit\Addins") `
            -BoundaryRoot $commonRootFull `
            -ArtifactSpecs $machineAddinSpecs `
            -Matched $matched `
            -Preserved $preserved `
            -Failed $failed

        [void](Add-RevAgentCanonicalLegacyCandidate `
                -Scope $scopeName `
                -Surface "canonical_npm_legacy_namespace" `
                -Reason "exact_legacy_npm_cache_namespace" `
                -Path (Join-Path $installRootFull "dependencies\npm\revit-mcp") `
                -BoundaryRoot $installRootFull `
                -ExpectedItemType "directory" `
                -Matched $matched `
                -Preserved $preserved `
                -Failed $failed)
    }
    else {
        Add-RevAgentCanonicalLegacyAddinInventory `
            -Scope $scopeName `
            -AddinsRoot (Join-Path $roamingRootFull "Autodesk\Revit\Addins") `
            -BoundaryRoot $userRootFull `
            -ArtifactSpecs $userAddinSpecs `
            -Matched $matched `
            -Preserved $preserved `
            -Failed $failed

        if (-not $PreserveLocalCodexInstructions) {
            [void](Add-RevAgentCanonicalLegacyCandidate `
                    -Scope $scopeName `
                    -Surface "user_codex_retired_revagent_skill_reparse" `
                    -Reason "exact_retired_revagent_skill_reparse_point" `
                    -Path (Join-Path $targetCodexHomeFull "skills\revAgent") `
                    -BoundaryRoot $userRootFull `
                    -ExpectedItemType "directory" `
                    -Matched $matched `
                    -Preserved $preserved `
                    -Failed $failed `
                    -AllowLeafReparsePoint `
                    -AllowedReparseTargetRoot (Join-Path $installRootFull "codex\skills\revAgent"))

        }

        # preserve-local protects current/local instruction content, but an
        # exact retired installer-owned revit-mcp junction is not local-authored
        # content. Inspect only this leaf (never its target/tree) and remove it
        # only when the recorded target is the retired machine skill root.
        [void](Add-RevAgentCanonicalLegacyCandidate `
                -Scope $scopeName `
                -Surface "user_codex_legacy_skill_reparse" `
                -Reason "exact_legacy_codex_skill_reparse_point" `
                -Path (Join-Path $targetCodexHomeFull "skills\revit-mcp") `
                -BoundaryRoot $userRootFull `
                -ExpectedItemType "directory" `
                -Matched $matched `
                -Preserved $preserved `
                -Failed $failed `
                -AllowLeafReparsePoint `
                -AllowedReparseTargetRoot (Join-Path $commonRootFull "DPE\RevitMCP\codex\skills\revit-mcp"))
    }

    return [pscustomobject][ordered]@{
        matched = @($matched.ToArray() | Sort-Object path)
        preserved = @($preserved.ToArray() | Sort-Object path, reason)
        failed = @($failed.ToArray() | Sort-Object path, reason)
    }
}

function Get-RevAgentCanonicalLegacyAclPolicyContext {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity -or $null -eq $identity.User) {
        throw "Canonical legacy cleanup could not resolve the current Windows identity."
    }

    $systemSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
    $administratorsSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")
    $usersSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-545")
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    $isElevated = $identity.User.Equals($systemSid) -or $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

    return [pscustomobject][ordered]@{
        currentSid = $identity.User
        systemSid = $systemSid
        administratorsSid = $administratorsSid
        usersSid = $usersSid
        elevated = [bool]$isElevated
        ownerSid = if ($isElevated) { $administratorsSid } else { $identity.User }
    }
}

function New-RevAgentCanonicalLegacyProtectedAcl {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("file", "directory")]
        [string]$ItemType,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $security = if ($ItemType -eq "directory") {
        New-Object System.Security.AccessControl.DirectorySecurity
    }
    else {
        New-Object System.Security.AccessControl.FileSecurity
    }
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner([System.Security.Principal.SecurityIdentifier]$Policy.ownerSid)

    # Directory rules inherit while the tree is being protected top-down. This
    # keeps descendants reachable after inheritance is cut at the parent; each
    # descendant is then converted to the same exact protected descriptor.
    $inheritance = if ($ItemType -eq "directory") {
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else {
        [System.Security.AccessControl.InheritanceFlags]::None
    }
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    foreach ($trustedSid in @($Policy.systemSid, $Policy.administratorsSid)) {
        $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                    $trustedSid,
                    [System.Security.AccessControl.FileSystemRights]::FullControl,
                    $inheritance,
                    $propagation,
                    $allow)))
    }
    $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                $Policy.usersSid,
                ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [System.Security.AccessControl.FileSystemRights]::Synchronize),
                $inheritance,
                $propagation,
                $allow)))
    if (-not [bool]$Policy.elevated) {
        $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                    $Policy.currentSid,
                    [System.Security.AccessControl.FileSystemRights]::FullControl,
                    $inheritance,
                    $propagation,
                    $allow)))
    }

    return $security
}

function Get-RevAgentCanonicalLegacyAclOwnerSid {
    param(
        [Parameter(Mandatory = $true)]
        [System.Security.AccessControl.FileSystemSecurity]$Acl
    )

    try {
        return (New-Object System.Security.Principal.NTAccount([string]$Acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier])
    }
    catch {
        return New-Object System.Security.Principal.SecurityIdentifier([string]$Acl.Owner)
    }
}

function Test-RevAgentCanonicalLegacyProtectedAcl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    try {
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    }
    catch {
        return [pscustomobject][ordered]@{
            success = $false
            error = $_.Exception.Message
        }
    }

    if (-not $acl.AreAccessRulesProtected) {
        return [pscustomobject][ordered]@{
            success = $false
            error = "Canonical legacy cleanup ACL is not protected: $Path"
        }
    }

    $ownerSid = Get-RevAgentCanonicalLegacyAclOwnerSid -Acl $acl
    if (-not $ownerSid.Equals([System.Security.Principal.SecurityIdentifier]$Policy.ownerSid)) {
        return [pscustomobject][ordered]@{
            success = $false
            error = "Canonical legacy cleanup owner is not the exact protected owner: $Path"
        }
    }

    $allowedSids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($sid in @($Policy.systemSid, $Policy.administratorsSid, $Policy.usersSid)) {
        [void]$allowedSids.Add([string]$sid.Value)
    }
    if (-not [bool]$Policy.elevated) {
        [void]$allowedSids.Add([string]$Policy.currentSid.Value)
    }

    $rightsBySid = @{}
    $mutationMask = [int][System.Security.AccessControl.FileSystemRights]::WriteData `
        -bor [int][System.Security.AccessControl.FileSystemRights]::AppendData `
        -bor [int][System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes `
        -bor [int][System.Security.AccessControl.FileSystemRights]::WriteAttributes `
        -bor [int][System.Security.AccessControl.FileSystemRights]::Delete `
        -bor [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles `
        -bor [int][System.Security.AccessControl.FileSystemRights]::ChangePermissions `
        -bor [int][System.Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
        $sidValue = [string]$rule.IdentityReference.Value
        if (-not $allowedSids.Contains($sidValue)) {
            return [pscustomobject][ordered]@{
                success = $false
                error = "Canonical legacy cleanup ACL contains an unexpected explicit principal '$sidValue': $Path"
            }
        }
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            return [pscustomobject][ordered]@{
                success = $false
                error = "Canonical legacy cleanup ACL contains an unexpected deny rule for '$sidValue': $Path"
            }
        }
        $rawRights = [int]$rule.FileSystemRights
        if (-not $rightsBySid.ContainsKey($sidValue)) {
            $rightsBySid[$sidValue] = 0
        }
        $rightsBySid[$sidValue] = [int]$rightsBySid[$sidValue] -bor $rawRights
        if ($sidValue -eq [string]$Policy.usersSid.Value -and (($rawRights -band $mutationMask) -ne 0)) {
            return [pscustomobject][ordered]@{
                success = $false
                error = "Canonical legacy cleanup ACL grants write-capable access to BUILTIN\Users: $Path"
            }
        }
    }

    foreach ($fullControlSid in @($Policy.systemSid, $Policy.administratorsSid)) {
        $sidValue = [string]$fullControlSid.Value
        if (-not $rightsBySid.ContainsKey($sidValue) -or
            (([int]$rightsBySid[$sidValue] -band [int][System.Security.AccessControl.FileSystemRights]::FullControl) -ne [int][System.Security.AccessControl.FileSystemRights]::FullControl)) {
            return [pscustomobject][ordered]@{
                success = $false
                error = "Canonical legacy cleanup ACL lacks exact trusted FullControl for '$sidValue': $Path"
            }
        }
    }
    $usersSidValue = [string]$Policy.usersSid.Value
    $requiredReadRights = [int][System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [int][System.Security.AccessControl.FileSystemRights]::Synchronize
    if (-not $rightsBySid.ContainsKey($usersSidValue) -or
        (([int]$rightsBySid[$usersSidValue] -band $requiredReadRights) -ne $requiredReadRights)) {
        return [pscustomobject][ordered]@{
            success = $false
            error = "Canonical legacy cleanup ACL lacks BUILTIN\Users ReadAndExecute/Synchronize: $Path"
        }
    }
    if (-not [bool]$Policy.elevated) {
        $currentSidValue = [string]$Policy.currentSid.Value
        if (-not $rightsBySid.ContainsKey($currentSidValue) -or
            (([int]$rightsBySid[$currentSidValue] -band [int][System.Security.AccessControl.FileSystemRights]::FullControl) -ne [int][System.Security.AccessControl.FileSystemRights]::FullControl)) {
            return [pscustomobject][ordered]@{
                success = $false
                error = "Canonical legacy cleanup fixture ACL lacks current-user FullControl: $Path"
            }
        }
    }

    return [pscustomobject][ordered]@{
        success = $true
        error = ""
    }
}

function Assert-RevAgentCanonicalLegacyProtectedAcl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $result = Test-RevAgentCanonicalLegacyProtectedAcl -Path $Path -Policy $Policy
    if (-not [bool]$result.success) {
        throw ([string]$result.error)
    }
}

function Set-RevAgentCanonicalLegacyProtectedAcl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [ValidateSet("file", "directory")]
        [string]$ItemType,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    if ($ItemType -eq "file") {
        $linkCountBefore = Get-RevitMcpSourceFreeFileLinkCount -Path $Path
        if ($linkCountBefore -ne 1) {
            throw "Refusing canonical ACL mutation of a non-unit hardlink. path=$Path linkCount=$linkCountBefore"
        }
    }

    $protectionProbe = Test-RevAgentCanonicalLegacyProtectedAcl -Path $Path -Policy $Policy
    if ([bool]$protectionProbe.success) {
        return
    }

    # Replace only a descriptor that is not already the exact policy. Apart
    # from avoiding needless churn, this keeps PS5/non-admin fixtures from
    # requesting SACL privileges on a second Set-Acl of the same object.
    $originalAcl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $security = New-RevAgentCanonicalLegacyProtectedAcl -ItemType $ItemType -Policy $Policy
    Set-Acl -LiteralPath $Path -AclObject $security -ErrorAction Stop
    if ($ItemType -eq "file") {
        $linkCountAfter = 0
        $postAclInspectionError = ""
        try {
            $linkCountAfter = Get-RevitMcpSourceFreeFileLinkCount -Path $Path
        }
        catch {
            $postAclInspectionError = $_.Exception.Message
        }
        if (-not [string]::IsNullOrWhiteSpace($postAclInspectionError) -or $linkCountAfter -ne 1) {
            try {
                Set-Acl -LiteralPath $Path -AclObject $originalAcl -ErrorAction Stop
            }
            catch {
                throw "Canonical ACL post-mutation revalidation failed and original ACL restoration also failed. path=$Path linkCount=$linkCountAfter inspectionError=$postAclInspectionError restoreError=$($_.Exception.Message)"
            }
            throw "Canonical ACL post-mutation revalidation failed; original ACL was restored and cleanup stopped. path=$Path linkCount=$linkCountAfter inspectionError=$postAclInspectionError"
        }
    }
    Assert-RevAgentCanonicalLegacyProtectedAcl -Path $Path -Policy $Policy
}

function Protect-RevAgentCanonicalLegacyExactPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$BoundaryRoot,

        [Parameter(Mandatory = $true)]
        [ValidateSet("file", "directory")]
        [string]$ExpectedItemType,

        [Parameter(Mandatory = $true)]
        [object]$Policy,

        [switch]$Recursive
    )

    $pathFull = Get-RevAgentCanonicalLegacyFullPath -Path $Path
    $boundaryFull = Get-RevAgentCanonicalLegacyFullPath -Path $BoundaryRoot
    if (-not (Test-RevAgentCanonicalLegacyPathInside -Path $pathFull -Root $boundaryFull -AllowRoot)) {
        throw "Refusing ACL protection outside exact boundary '$boundaryFull': $pathFull"
    }
    $unsafeAncestor = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $pathFull -BoundaryRoot $boundaryFull
    if (-not [string]::IsNullOrWhiteSpace($unsafeAncestor)) {
        throw "Refusing ACL protection through reparse point '$unsafeAncestor': $pathFull"
    }

    $rootItem = Get-Item -LiteralPath $pathFull -Force -ErrorAction Stop
    $actualItemType = if ([bool]$rootItem.PSIsContainer) { "directory" } else { "file" }
    if ($actualItemType -ne $ExpectedItemType) {
        throw "Canonical legacy cleanup candidate changed item type before ACL protection: $pathFull"
    }
    Set-RevAgentCanonicalLegacyProtectedAcl -Path $pathFull -ItemType $actualItemType -Policy $Policy

    if ($actualItemType -ne "directory" -or -not $Recursive) {
        return
    }

    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($pathFull)
    while ($pending.Count -gt 0) {
        $directoryPath = $pending.Pop()
        foreach ($child in @(Get-ChildItem -LiteralPath $directoryPath -Force -ErrorAction Stop)) {
            if (Get-RevAgentCanonicalLegacyReparseState -Item $child) {
                throw "Refusing recursive ACL protection with reparse point '$($child.FullName)': $pathFull"
            }
            $childType = if ([bool]$child.PSIsContainer) { "directory" } else { "file" }
            Set-RevAgentCanonicalLegacyProtectedAcl -Path $child.FullName -ItemType $childType -Policy $Policy
            if ($childType -eq "directory") {
                $pending.Push([string]$child.FullName)
            }
        }
    }
}

function Assert-RevAgentCanonicalLegacyExactPathProtected {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Entry,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $pathFull = Get-RevAgentCanonicalLegacyFullPath -Path ([string]$Entry.path)
    $rootFull = Get-RevAgentCanonicalLegacyFullPath -Path ([string]$Entry.rootPath)
    $unsafeAncestor = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $pathFull -BoundaryRoot $rootFull
    if (-not [string]::IsNullOrWhiteSpace($unsafeAncestor)) {
        throw "Canonical legacy cleanup candidate topology changed to reparse point '$unsafeAncestor': $pathFull"
    }
    $item = Get-Item -LiteralPath $pathFull -Force -ErrorAction Stop
    $actualItemType = if ([bool]$item.PSIsContainer) { "directory" } else { "file" }
    if ($actualItemType -ne [string]$Entry.itemType) {
        throw "Canonical legacy cleanup candidate changed item type after ACL protection: $pathFull"
    }
    Assert-RevAgentCanonicalLegacyProtectedAcl -Path $pathFull -Policy $Policy
    if ($actualItemType -eq "directory") {
        $unsafeTreePath = Get-RevAgentCanonicalLegacyFirstTreeReparsePoint -Path $pathFull
        if (-not [string]::IsNullOrWhiteSpace($unsafeTreePath)) {
            throw "Canonical legacy cleanup candidate gained a nested reparse point '$unsafeTreePath': $pathFull"
        }
        foreach ($descendant in @(Get-ChildItem -LiteralPath $pathFull -Recurse -Force -ErrorAction Stop)) {
            Assert-RevAgentCanonicalLegacyProtectedAcl -Path $descendant.FullName -Policy $Policy
        }
    }
}

function Protect-RevAgentCanonicalLegacyMachineDeletionTopology {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Entries,

        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,

        [Parameter(Mandatory = $true)]
        [string]$CommonAppDataRoot
    )

    $policy = Get-RevAgentCanonicalLegacyAclPolicyContext
    $installRootFull = Get-RevAgentCanonicalLegacyFullPath -Path $InstallRoot
    if ([bool]$policy.elevated) {
        Assert-RevAgentCanonicalLegacyProtectedAcl -Path $installRootFull -Policy $policy
    }
    else {
        # Test fixtures are intentionally non-admin. Protect only the fixture
        # root and retain current-user FullControl as the explicit fallback.
        Protect-RevAgentCanonicalLegacyExactPath -Path $installRootFull -BoundaryRoot $installRootFull -ExpectedItemType "directory" -Policy $policy
    }

    $legacyInstallRoot = Get-RevAgentCanonicalLegacyFullPath -Path (Join-Path $CommonAppDataRoot "DPE\RevitMCP")
    $hasLegacyRootChildDeletion = @($Entries | Where-Object {
            Test-RevAgentCanonicalLegacyPathInside -Path ([string]$_.path) -Root $legacyInstallRoot -AllowRoot
        }).Count -gt 0
    if ($hasLegacyRootChildDeletion -and (Test-Path -LiteralPath $legacyInstallRoot -PathType Container)) {
        # Shallow protection closes parent DeleteChild/rename races without
        # traversing or changing preserved unknown siblings.
        Protect-RevAgentCanonicalLegacyExactPath -Path $legacyInstallRoot -BoundaryRoot $CommonAppDataRoot -ExpectedItemType "directory" -Policy $policy
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($Entries | Sort-Object { ([string]$_.path).Length })) {
        $pathFull = Get-RevAgentCanonicalLegacyFullPath -Path ([string]$entry.path)
        if (-not $seen.Add($pathFull)) {
            continue
        }
        Protect-RevAgentCanonicalLegacyExactPath `
            -Path $pathFull `
            -BoundaryRoot ([string]$entry.rootPath) `
            -ExpectedItemType ([string]$entry.itemType) `
            -Policy $policy `
            -Recursive:([string]$entry.itemType -eq "directory")
    }

    foreach ($entry in $Entries) {
        Assert-RevAgentCanonicalLegacyExactPathProtected -Entry $entry -Policy $policy
        if ([string]$entry.surface -match '^machine_revit_addin_' -and
            -not [string]::Equals([System.IO.Path]::GetPathRoot([string]$entry.path), [System.IO.Path]::GetPathRoot($installRootFull), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Machine add-in quarantine requires source and canonical InstallRoot on the same volume: $($entry.path)"
        }
    }

    return $policy
}

function New-RevAgentCanonicalLegacyMachineQuarantine {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $installRootFull = Get-RevAgentCanonicalLegacyFullPath -Path $InstallRoot
    $quarantinePath = Join-Path $installRootFull (".legacy-cleanup-quarantine-{0}" -f [Guid]::NewGuid().ToString("N"))
    [void][System.IO.Directory]::CreateDirectory($quarantinePath)
    Protect-RevAgentCanonicalLegacyExactPath -Path $quarantinePath -BoundaryRoot $installRootFull -ExpectedItemType "directory" -Policy $Policy
    return Get-RevAgentCanonicalLegacyFullPath -Path $quarantinePath
}

function Move-RevAgentCanonicalLegacyMachineAddinToQuarantine {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Entry,

        [Parameter(Mandatory = $true)]
        [string]$QuarantineRoot,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $stage = "source_revalidation"
    try {
        Assert-RevAgentCanonicalLegacyExactPathProtected -Entry $Entry -Policy $Policy
        $sourcePath = Get-RevAgentCanonicalLegacyFullPath -Path ([string]$Entry.path)
        $destinationPath = Join-Path $QuarantineRoot ("{0}-{1}" -f [Guid]::NewGuid().ToString("N"), [System.IO.Path]::GetFileName($sourcePath))
        $stage = "atomic_move"
        if ([string]$Entry.itemType -eq "directory") {
            [System.IO.Directory]::Move($sourcePath, $destinationPath)
        }
        else {
            [System.IO.File]::Move($sourcePath, $destinationPath)
        }

        $stage = "quarantine_revalidation"
        $quarantineEntry = New-RevAgentCanonicalLegacySurfaceEntry `
            -Scope ([string]$Entry.scope) `
            -Surface ([string]$Entry.surface) `
            -Reason ([string]$Entry.reason) `
            -Path $destinationPath `
            -RootPath $QuarantineRoot `
            -ItemType ([string]$Entry.itemType) `
            -DeletionMode ([string]$Entry.deletionMode)
        # A same-volume rename preserves the protected descriptor established
        # during preflight. Do not "bless" a swapped object here by rewriting
        # its ACL; require the moved identity/tree to retain that descriptor.
        Assert-RevAgentCanonicalLegacyExactPathProtected -Entry $quarantineEntry -Policy $Policy
        return $quarantineEntry
    }
    catch {
        throw "Machine add-in quarantine failed during $stage for '$($Entry.path)': $($_.Exception.Message) stack=$($_.ScriptStackTrace)"
    }
}

function Remove-RevAgentCanonicalLegacySurfaceEntry {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Entry
    )

    $pathFull = Get-RevAgentCanonicalLegacyFullPath -Path ([string]$Entry.path)
    $rootFull = Get-RevAgentCanonicalLegacyFullPath -Path ([string]$Entry.rootPath)
    if (-not (Test-RevAgentCanonicalLegacyPathInside -Path $pathFull -Root $rootFull)) {
        throw "Refusing canonical legacy-surface deletion outside '$rootFull': $pathFull"
    }

    $item = Get-Item -LiteralPath $pathFull -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) {
        return
    }

    switch ([string]$Entry.deletionMode) {
        "reparsePoint" {
            if ([string]$Entry.surface -notin @("user_codex_legacy_skill_reparse", "user_codex_retired_revagent_skill_reparse")) {
                throw "Only an exact positively identified retired user Codex skill link may be removed as a reparse point: $pathFull"
            }
            $unsafeAncestor = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $pathFull -BoundaryRoot $rootFull -AllowLeafReparsePoint
            if (-not [string]::IsNullOrWhiteSpace($unsafeAncestor)) {
                throw "Refusing legacy Codex skill link deletion through reparse ancestor '$unsafeAncestor': $pathFull"
            }
            if (-not (Get-RevAgentCanonicalLegacyReparseState -Item $item)) {
                throw "Legacy Codex skill candidate is no longer a reparse point: $pathFull"
            }
            if (-not [bool]$item.PSIsContainer) {
                throw "Legacy Codex skill reparse point is not a directory: $pathFull"
            }
            if ([string]::IsNullOrWhiteSpace([string]$Entry.allowedReparseTargetRoot) -or -not (Test-RevAgentCanonicalLegacyLinkTargetAllowed -Item $item -AllowedTargetRoot ([string]$Entry.allowedReparseTargetRoot))) {
                throw "Legacy Codex skill reparse target is not under the exact retired machine skill root: $pathFull"
            }
            [System.IO.Directory]::Delete($pathFull, $false)
        }
        "emptyDirectory" {
            $unsafeAncestor = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $pathFull -BoundaryRoot $rootFull
            if (-not [string]::IsNullOrWhiteSpace($unsafeAncestor)) {
                throw "Refusing empty legacy root deletion through reparse point '$unsafeAncestor': $pathFull"
            }
            if (-not [bool]$item.PSIsContainer) {
                throw "Legacy install root is no longer a directory: $pathFull"
            }
            if (@(Get-ChildItem -LiteralPath $pathFull -Force -ErrorAction Stop).Count -ne 0) {
                throw "Legacy install root is not empty after bounded child cleanup: $pathFull"
            }
            [System.IO.Directory]::Delete($pathFull, $false)
        }
        "recursiveDirectory" {
            $unsafeAncestor = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $pathFull -BoundaryRoot $rootFull
            if (-not [string]::IsNullOrWhiteSpace($unsafeAncestor)) {
                throw "Refusing legacy directory deletion through reparse point '$unsafeAncestor': $pathFull"
            }
            $unsafeTreePath = Get-RevAgentCanonicalLegacyFirstTreeReparsePoint -Path $pathFull
            if (-not [string]::IsNullOrWhiteSpace($unsafeTreePath)) {
                throw "Refusing legacy directory deletion with nested reparse point '$unsafeTreePath': $pathFull"
            }
            if (-not [bool]$item.PSIsContainer) {
                throw "Legacy directory candidate changed item type: $pathFull"
            }
            $immediateHardlinkFindings = @(Get-RevAgentCleanupCandidateHardlinkFindings -Path $pathFull -BoundaryRoot $rootFull)
            if ($immediateHardlinkFindings.Count -gt 0) {
                $firstFinding = $immediateHardlinkFindings[0]
                throw "Legacy directory acquired a non-unit hardlink before deletion. path=$($firstFinding.path) linkCount=$($firstFinding.linkCount)"
            }
            Remove-RevAgentCleanupPathWithoutForce -Path $pathFull -BoundaryRoot $rootFull -ExpectedItemType "directory"
        }
        "file" {
            $unsafeAncestor = Get-RevAgentCanonicalLegacyFirstReparseAncestor -Path $pathFull -BoundaryRoot $rootFull
            if (-not [string]::IsNullOrWhiteSpace($unsafeAncestor)) {
                throw "Refusing legacy file deletion through reparse point '$unsafeAncestor': $pathFull"
            }
            if ([bool]$item.PSIsContainer) {
                throw "Legacy file candidate changed item type: $pathFull"
            }
            $linkCount = Get-RevitMcpSourceFreeFileLinkCount -Path $pathFull
            if ($linkCount -ne 1) {
                throw "Legacy file acquired a non-unit hardlink before deletion. path=$pathFull linkCount=$linkCount"
            }
            Remove-RevAgentCleanupPathWithoutForce -Path $pathFull -BoundaryRoot $rootFull -ExpectedItemType "file"
        }
        default {
            throw "Unsupported canonical legacy-surface deletion mode '$($Entry.deletionMode)' for $pathFull"
        }
    }
}

function Invoke-RevAgentCanonicalLegacySurfaceCleanup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("machine", "user")]
        [string]$Scope,

        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,

        [string]$UserProfileRoot = "",

        [string]$RoamingAppDataRoot = "",

        [string]$CommonAppDataRoot = "",

        [switch]$Commit,

        [string]$TargetCodexHome = "",

        [switch]$PreserveLocalCodexInstructions
    )

    if ([string]::IsNullOrWhiteSpace($CommonAppDataRoot)) {
        $CommonAppDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    }
    $scopeName = $Scope.ToLowerInvariant()
    if ($scopeName -eq "user") {
        if ([string]::IsNullOrWhiteSpace($UserProfileRoot)) {
            $UserProfileRoot = $env:USERPROFILE
        }
        if ([string]::IsNullOrWhiteSpace($RoamingAppDataRoot)) {
            $RoamingAppDataRoot = $env:APPDATA
            if ([string]::IsNullOrWhiteSpace($RoamingAppDataRoot) -and -not [string]::IsNullOrWhiteSpace($UserProfileRoot)) {
                $RoamingAppDataRoot = Join-Path $UserProfileRoot "AppData\Roaming"
            }
        }
        if ([string]::IsNullOrWhiteSpace($UserProfileRoot) -or [string]::IsNullOrWhiteSpace($RoamingAppDataRoot)) {
            throw "Canonical user legacy-surface cleanup could not resolve UserProfileRoot and RoamingAppDataRoot."
        }
    }
    if ([string]::IsNullOrWhiteSpace($CommonAppDataRoot)) {
        throw "Canonical legacy-surface cleanup could not resolve CommonAppDataRoot."
    }

    $inventory = Get-RevAgentCanonicalLegacySurfaceInventoryInternal `
        -Scope $scopeName `
        -InstallRoot $InstallRoot `
        -UserProfileRoot $UserProfileRoot `
        -RoamingAppDataRoot $RoamingAppDataRoot `
        -TargetCodexHome $TargetCodexHome `
        -PreserveLocalCodexInstructions:$PreserveLocalCodexInstructions `
        -CommonAppDataRoot $CommonAppDataRoot
    $matched = @($inventory.matched)
    $preserved = [System.Collections.Generic.List[object]]::new()
    $preservedKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($preservedEntry in @($inventory.preserved)) {
        $preservedKey = "{0}|{1}|{2}" -f [string]$preservedEntry.surface, [string]$preservedEntry.reason, [string]$preservedEntry.path
        if ($preservedKeys.Add($preservedKey)) {
            $preserved.Add($preservedEntry)
        }
    }
    $failed = [System.Collections.Generic.List[object]]::new()
    foreach ($inventoryFailure in @($inventory.failed)) {
        $failed.Add($inventoryFailure)
    }
    $removed = [System.Collections.Generic.List[object]]::new()
    $initialBlockingPreserved = @($preserved.ToArray() | Where-Object {
            Test-RevAgentCanonicalLegacyPreservedEntryBlocksCleanup -Entry $_
        })
    $deletionAttempted = $false
    $deletionSkippedReason = ""
    $machinePolicy = $null
    $quarantinePath = ""
    $quarantinedCount = 0

    $deleteAuthorized = [bool]$Commit
    if ($deleteAuthorized -and $failed.Count -gt 0) {
        # Inventory is an all-or-nothing authorization step. A partial
        # inventory must never be followed by deletion of the rows it happened
        # to discover before failing.
        $deleteAuthorized = $false
        $deletionSkippedReason = "inventory_failed"
    }
    if ($deleteAuthorized -and $initialBlockingPreserved.Count -gt 0) {
        $deleteAuthorized = $false
        $deletionSkippedReason = "blocking_preserved"
    }

    if ($deleteAuthorized -and $matched.Count -gt 0) {
        try {
            # Revalidate the complete candidate file set before the first ACL
            # write, quarantine creation, rename, or delete. A hardlink present
            # at this mutation-edge check aborts with zero mutation; each file
            # is also revalidated immediately before ACL/delete work below.
            Assert-RevAgentCleanupCandidateSetHasUnitHardlinks -Entries $matched
            Assert-RevAgentCleanupCandidateSetHasNoRetainedMutationHandles -Entries $matched
        }
        catch {
            $failed.Add([pscustomobject][ordered]@{
                    scope = $scopeName
                    surface = "cleanup_transaction_preflight"
                    reason = "hardlink_preflight_failed"
                    path = Get-RevAgentCanonicalLegacyFullPath -Path $InstallRoot
                    error = $_.Exception.Message
                })
            $deleteAuthorized = $false
            $deletionSkippedReason = "hardlink_preflight_failed"
        }
    }

    if ($deleteAuthorized -and $scopeName -eq "machine" -and $matched.Count -gt 0) {
        try {
            $machinePolicy = Protect-RevAgentCanonicalLegacyMachineDeletionTopology `
                -Entries $matched `
                -InstallRoot $InstallRoot `
                -CommonAppDataRoot $CommonAppDataRoot
        }
        catch {
            $failed.Add([pscustomobject][ordered]@{
                    scope = $scopeName
                    surface = "machine_deletion_topology"
                    reason = "topology_protection_failed"
                    path = Get-RevAgentCanonicalLegacyFullPath -Path $InstallRoot
                    error = $_.Exception.Message
                })
            $deleteAuthorized = $false
            $deletionSkippedReason = "topology_protection_failed"
        }
    }

    if ($deleteAuthorized -and $matched.Count -gt 0) {
        try {
            # Machine ACL hardening may legitimately change descriptors, but it
            # must not change any candidate identity or leave a pre-existing
            # foreign handle capable of undoing or redirecting cleanup.
            Assert-RevAgentCleanupCandidateSetHasUnitHardlinks -Entries $matched
            Assert-RevAgentCleanupCandidateSetHasNoRetainedMutationHandles -Entries $matched
        }
        catch {
            $failed.Add([pscustomobject][ordered]@{
                    scope = $scopeName
                    surface = "cleanup_transaction_handle_recheck"
                    reason = "retained_handle_recheck_failed"
                    path = Get-RevAgentCanonicalLegacyFullPath -Path $InstallRoot
                    error = $_.Exception.Message
                })
            $deleteAuthorized = $false
            $deletionSkippedReason = "retained_handle_recheck_failed"
        }
    }

    $machineAddinEntries = @($matched | Where-Object { [string]$_.surface -match '^machine_revit_addin_' })
    if ($deleteAuthorized -and $machineAddinEntries.Count -gt 0) {
        try {
            $quarantinePath = New-RevAgentCanonicalLegacyMachineQuarantine -InstallRoot $InstallRoot -Policy $machinePolicy
        }
        catch {
            $failed.Add([pscustomobject][ordered]@{
                    scope = $scopeName
                    surface = "machine_revit_addin_quarantine"
                    reason = "quarantine_creation_failed"
                    path = Get-RevAgentCanonicalLegacyFullPath -Path $InstallRoot
                    error = $_.Exception.Message
                })
            $deleteAuthorized = $false
            $deletionSkippedReason = "quarantine_creation_failed"
        }
    }

    if ($deleteAuthorized -and $matched.Count -gt 0) {
        $deletionAttempted = $true
        foreach ($entry in @($matched | Sort-Object { ([string]$_.path).Length } -Descending)) {
            $quarantineEntry = $null
            try {
                if ($scopeName -eq "machine") {
                    Assert-RevAgentCanonicalLegacyExactPathProtected -Entry $entry -Policy $machinePolicy
                }
                if ($scopeName -eq "machine" -and [string]$entry.surface -match '^machine_revit_addin_') {
                    # The Autodesk year directory is shared and may retain a
                    # legacy writable ACL. Atomically detach the exact artifact
                    # to the protected canonical volume, then revalidate and
                    # delete only the quarantined object.
                    $quarantineEntry = Move-RevAgentCanonicalLegacyMachineAddinToQuarantine `
                        -Entry $entry `
                        -QuarantineRoot $quarantinePath `
                        -Policy $machinePolicy
                    $quarantinedCount++
                    Remove-RevAgentCanonicalLegacySurfaceEntry -Entry $quarantineEntry
                }
                else {
                    Remove-RevAgentCanonicalLegacySurfaceEntry -Entry $entry
                }
                $removed.Add($entry)
            }
            catch {
                $failed.Add([pscustomobject][ordered]@{
                        scope = $scopeName
                        surface = [string]$entry.surface
                        reason = "cleanup_failed"
                        path = [string]$entry.path
                        error = $_.Exception.Message
                        quarantinePath = if ($null -eq $quarantineEntry) { "" } else { [string]$quarantineEntry.path }
                    })
                # Once a protected deletion behaves unexpectedly, stop. The
                # post-inventory below reports the untouched exact candidates.
                break
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($quarantinePath) -and (Test-Path -LiteralPath $quarantinePath -PathType Container)) {
        try {
            $quarantineChildren = @(Get-ChildItem -LiteralPath $quarantinePath -Force -ErrorAction Stop)
            if ($quarantineChildren.Count -eq 0) {
                Assert-RevAgentCanonicalLegacyProtectedAcl -Path $quarantinePath -Policy $machinePolicy
                [System.IO.Directory]::Delete($quarantinePath, $false)
            }
        }
        catch {
            $failed.Add([pscustomobject][ordered]@{
                    scope = $scopeName
                    surface = "machine_revit_addin_quarantine"
                    reason = "quarantine_cleanup_failed"
                    path = $quarantinePath
                    error = $_.Exception.Message
                })
        }
    }

    $remaining = @(if ($Commit -and $deletionAttempted) {
            $postInventory = Get-RevAgentCanonicalLegacySurfaceInventoryInternal `
                -Scope $scopeName `
                -InstallRoot $InstallRoot `
                -UserProfileRoot $UserProfileRoot `
                -RoamingAppDataRoot $RoamingAppDataRoot `
                -TargetCodexHome $TargetCodexHome `
                -PreserveLocalCodexInstructions:$PreserveLocalCodexInstructions `
                -CommonAppDataRoot $CommonAppDataRoot
            foreach ($postFailure in @($postInventory.failed)) {
                $failed.Add([pscustomobject][ordered]@{
                        scope = $scopeName
                        surface = [string]$postFailure.surface
                        reason = "post_cleanup_inventory_failed"
                        path = [string]$postFailure.path
                        error = [string]$postFailure.error
                    })
            }
            foreach ($postPreservedEntry in @($postInventory.preserved)) {
                $postPreservedKey = "{0}|{1}|{2}" -f [string]$postPreservedEntry.surface, [string]$postPreservedEntry.reason, [string]$postPreservedEntry.path
                if ($preservedKeys.Add($postPreservedKey)) {
                    $preserved.Add($postPreservedEntry)
                }
            }
            @($postInventory.matched)
        }
        else {
            @($matched)
        })

    $blockingPreserved = @($preserved.ToArray() | Where-Object {
            Test-RevAgentCanonicalLegacyPreservedEntryBlocksCleanup -Entry $_
        })
    $actionRequired = ($failed.Count -gt 0 -or $blockingPreserved.Count -gt 0 -or ($Commit -and $remaining.Count -gt 0))

    return [pscustomobject][ordered]@{
        mode = if ($Commit) { "commit" } else { "dryRun" }
        scope = $scopeName
        success = (-not $actionRequired)
        actionRequired = [bool]$actionRequired
        deletionAttempted = [bool]$deletionAttempted
        deletionSkippedReason = $deletionSkippedReason
        matchedCount = $matched.Count
        removedCount = $removed.Count
        failedCount = $failed.Count
        preservedCount = $preserved.Count
        blockingPreservedCount = $blockingPreserved.Count
        remainingCount = $remaining.Count
        quarantinedCount = $quarantinedCount
        quarantinePath = $quarantinePath
        quarantineRetained = (-not [string]::IsNullOrWhiteSpace($quarantinePath) -and (Test-Path -LiteralPath $quarantinePath))
        matched = @($matched)
        removed = @($removed.ToArray())
        failed = @($failed.ToArray())
        preserved = @($preserved.ToArray())
        blockingPreserved = @($blockingPreserved)
        remaining = @($remaining)
    }
}

$revAgentFunctionAliases = @{
    "Get-RevAgentSourceFreeArtifactInventory" = "Get-RevitMcpSourceFreeArtifactInventory"
    "Get-RevAgentSourceFreeManagedRoots" = "Get-RevitMcpSourceFreeManagedRoots"
    "Invoke-RevAgentSourceFreeArtifactCleanup" = "Invoke-RevitMcpSourceFreeArtifactCleanup"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) {
    Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value
}

Export-ModuleMember -Function `
    Get-RevitMcpSourceFreeManagedRoots, `
    Get-RevitMcpSourceFreeArtifactInventory, `
    Invoke-RevitMcpSourceFreeArtifactCleanup, `
    Invoke-RevAgentCanonicalLegacySurfaceCleanup
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)
