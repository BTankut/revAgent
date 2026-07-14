Set-StrictMode -Version Latest

function Get-RevitMcpLexicalItem {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
    $parent = Split-Path -Parent $fullPath
    $leaf = Split-Path -Leaf $fullPath
    if ([string]::IsNullOrWhiteSpace($parent) -or -not [System.IO.Directory]::Exists($parent)) {
        return $null
    }
    foreach ($item in Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop) {
        if ([string]::Equals([string]$item.Name, $leaf, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $item
        }
    }
    return $null
}

function Assert-RevitMcpOrdinaryManagedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $item = Get-RevitMcpLexicalItem -Path $Path
    if ($null -eq $item -or $item.PSIsContainer) {
        throw "$Label is missing or is not a file: $Path"
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
        throw "$Label must not be a reparse point or symbolic link: $($item.FullName)"
    }
    $linkCount = [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($item.FullName)
    if ($linkCount -ne 1) {
        throw "$Label must have exactly one hardlink reference (found $linkCount): $($item.FullName)"
    }
    return $item.FullName
}

function Assert-RevitMcpMutationGuardIdentity {
    param(
        [Parameter(Mandatory = $true)][Microsoft.Win32.SafeHandles.SafeFileHandle]$MutationGuard,
        [Parameter(Mandatory = $true)][string]$ParentRoot
    )

    if ($MutationGuard.IsClosed -or $MutationGuard.IsInvalid) {
        throw "Managed mutation guard is closed or invalid: $ParentRoot"
    }
    $handleIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($MutationGuard)
    $pathIdentity = [RevAgent.PermissionNativeFileInfo]::GetIdentity($ParentRoot, $true)
    if (-not [string]::Equals($handleIdentity, $pathIdentity, [System.StringComparison]::Ordinal)) {
        throw "Managed mutation guard no longer identifies the destination parent: $ParentRoot"
    }
    [RevAgent.PermissionNativeFileInfo]::AssertNoMutationHandles($MutationGuard)
}

function Get-RevitMcpManagedTreeManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string[]]$AdditionalPreservedNames = @()
    )

    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
    [void](Assert-RevAgentManagedTreeLinkSafe -Root $fullRoot)
    $directories = [System.Collections.Generic.List[string]]::new()
    $files = [System.Collections.Generic.List[object]]::new()
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($fullRoot)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($entryPath in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $entry = Microsoft.PowerShell.Management\Get-Item -LiteralPath $entryPath -Force -ErrorAction Stop
            if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                -not [string]::IsNullOrWhiteSpace([string]$entry.LinkType)) {
                throw "Managed directory tree contains a reparse point or symbolic link: $($entry.FullName)"
            }
            $relative = $entry.FullName.Substring($fullRoot.Length).TrimStart("\")
            if ($entry.PSIsContainer) {
                $directories.Add($relative)
                $pending.Push($entry.FullName)
                continue
            }
            $linkCount = [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($entry.FullName)
            if ($linkCount -ne 1) {
                throw "Managed directory tree contains a hard-linked file (link count $linkCount): $($entry.FullName)"
            }
            $files.Add([pscustomobject][ordered]@{
                    RelativePath = $relative
                    Length = [int64]$entry.Length
                    Sha256 = (Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $entry.FullName).Hash
                })
        }
    }
    return [pscustomobject][ordered]@{
        Root = $fullRoot
        Directories = @($directories | Sort-Object)
        Files = @($files | Sort-Object RelativePath)
    }
}

function Assert-RevitMcpManagedTreeManifestEqual {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $expectedDirectories = @($Expected.Directories)
    $actualDirectories = @($Actual.Directories)
    if ($expectedDirectories.Count -ne $actualDirectories.Count) {
        throw "$Label directory count mismatch. Expected=$($expectedDirectories.Count) Actual=$($actualDirectories.Count)"
    }
    for ($i = 0; $i -lt $expectedDirectories.Count; $i++) {
        if (-not [string]::Equals([string]$expectedDirectories[$i], [string]$actualDirectories[$i], [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "$Label directory mismatch. Expected='$($expectedDirectories[$i])' Actual='$($actualDirectories[$i])'"
        }
    }
    $expectedFiles = @($Expected.Files)
    $actualFiles = @($Actual.Files)
    if ($expectedFiles.Count -ne $actualFiles.Count) {
        throw "$Label file count mismatch. Expected=$($expectedFiles.Count) Actual=$($actualFiles.Count)"
    }
    for ($i = 0; $i -lt $expectedFiles.Count; $i++) {
        $expectedFile = $expectedFiles[$i]
        $actualFile = $actualFiles[$i]
        if (-not [string]::Equals([string]$expectedFile.RelativePath, [string]$actualFile.RelativePath, [System.StringComparison]::OrdinalIgnoreCase) -or
            [int64]$expectedFile.Length -ne [int64]$actualFile.Length -or
            -not [string]::Equals([string]$expectedFile.Sha256, [string]$actualFile.Sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "$Label file mismatch. Expected='$($expectedFile.RelativePath)' Actual='$($actualFile.RelativePath)'"
        }
    }
}

function Copy-RevitMcpOrdinaryFileToNewPath {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $sourcePath = Assert-RevitMcpOrdinaryManagedFile -Path $Source -Label "Managed copy source"
    $destinationParent = Split-Path -Parent $Destination
    if (-not [System.IO.Directory]::Exists($destinationParent)) {
        [void][System.IO.Directory]::CreateDirectory($destinationParent)
    }
    if ($null -ne (Get-RevitMcpLexicalItem -Path $Destination)) {
        throw "Managed copy destination must be absent before CreateNew: $Destination"
    }
    $sourceStream = $null
    $destinationStream = $null
    try {
        $sourceStream = [System.IO.FileStream]::new($sourcePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $destinationStream = [System.IO.FileStream]::new($Destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $sourceStream.CopyTo($destinationStream)
        $destinationStream.Flush($true)
    }
    finally {
        if ($null -ne $destinationStream) { $destinationStream.Dispose() }
        if ($null -ne $sourceStream) { $sourceStream.Dispose() }
    }
    [void](Assert-RevitMcpOrdinaryManagedFile -Path $Destination -Label "Managed copy destination")
}

function Install-RevitMcpManagedUpdaterFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [bool]$Required = $true,
        [Microsoft.Win32.SafeHandles.SafeFileHandle]$MutationGuard
    )

    $sourceItem = Get-RevitMcpLexicalItem -Path $Source
    if ($null -eq $sourceItem -or $sourceItem.PSIsContainer) {
        $message = "Managed updater source is missing: $Source"
        if ($Required) { throw $message }
        if ($null -ne (Get-RevitMcpLexicalItem -Path $Destination)) {
            throw "$message A stale optional destination still exists and will not be trusted: $Destination"
        }
        return $null
    }
    $sourcePath = Assert-RevitMcpOrdinaryManagedFile -Path $Source -Label "Managed updater source"
    $destinationPath = [System.IO.Path]::GetFullPath($Destination)
    $destinationParent = Split-Path -Parent $destinationPath
    if (-not [System.IO.Directory]::Exists($destinationParent)) {
        throw "Managed updater destination parent is missing: $destinationParent"
    }
    $existing = Get-RevitMcpLexicalItem -Path $destinationPath
    if ($null -ne $existing) {
        [void](Assert-RevitMcpOrdinaryManagedFile -Path $destinationPath -Label "Existing managed updater destination")
    }

    $ownedGuard = $null
    $temporaryPath = Join-Path $destinationParent (".{0}.stage-{1}" -f ([System.IO.Path]::GetFileName($destinationPath)), [Guid]::NewGuid().ToString("N"))
    try {
        if ($null -eq $MutationGuard) {
            $ownedGuard = Open-RevAgentManagedMutationGuard -Path $destinationParent -ProtectedPaths @($destinationPath)
            $MutationGuard = $ownedGuard
        }
        Assert-RevitMcpMutationGuardIdentity -MutationGuard $MutationGuard -ParentRoot $destinationParent
        if ($null -ne (Get-RevitMcpLexicalItem -Path $destinationPath)) {
            [void](Assert-RevitMcpOrdinaryManagedFile -Path $destinationPath -Label "Existing managed updater destination")
        }
        Copy-RevitMcpOrdinaryFileToNewPath -Source $sourcePath -Destination $temporaryPath
        $sourceHash = (Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash
        $temporaryHash = (Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryPath).Hash
        if (-not [string]::Equals($sourceHash, $temporaryHash, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Managed updater staged-file verification failed. Source='$sourcePath' Stage='$temporaryPath'"
        }
        Assert-RevitMcpMutationGuardIdentity -MutationGuard $MutationGuard -ParentRoot $destinationParent
        if ($null -ne (Get-RevitMcpLexicalItem -Path $destinationPath)) {
            [void](Assert-RevitMcpOrdinaryManagedFile -Path $destinationPath -Label "Existing managed updater destination")
            $backupPath = Join-Path $destinationParent (".{0}.backup-{1}" -f ([System.IO.Path]::GetFileName($destinationPath)), [Guid]::NewGuid().ToString("N"))
            [System.IO.File]::Replace($temporaryPath, $destinationPath, $backupPath, $true)
            try { [System.IO.File]::Delete($backupPath) }
            catch { throw "Managed updater backup cleanup failed: $backupPath. $($_.Exception.Message)" }
        }
        else {
            [System.IO.File]::Move($temporaryPath, $destinationPath)
        }
        $installedPath = Assert-RevitMcpOrdinaryManagedFile -Path $destinationPath -Label "Installed managed updater destination"
        $destinationHash = (Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $installedPath).Hash
        if (-not [string]::Equals($sourceHash, $destinationHash, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Managed updater destination verification failed. Source='$sourcePath' Destination='$destinationPath'"
        }
        return [pscustomobject][ordered]@{ Path = $installedPath; Sha256 = $destinationHash }
    }
    finally {
        if ($null -ne (Get-RevitMcpLexicalItem -Path $temporaryPath)) {
            [System.IO.File]::Delete($temporaryPath)
        }
        if ($null -ne $ownedGuard) { $ownedGuard.Dispose() }
    }
}

function Sync-RevitMcpManagedDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot,
        [string[]]$PreserveTopLevelNames = @(),
        [Microsoft.Win32.SafeHandles.SafeFileHandle]$MutationGuard
    )

    $sourceItem = Get-RevitMcpLexicalItem -Path $SourceRoot
    if ($null -eq $sourceItem -or -not $sourceItem.PSIsContainer) {
        throw "Managed directory source is missing: $SourceRoot"
    }
    $sourceManifest = Get-RevitMcpManagedTreeManifest -Root $SourceRoot
    $destinationPath = [System.IO.Path]::GetFullPath($DestinationRoot).TrimEnd("\")
    $destinationParent = Split-Path -Parent $destinationPath
    if (-not [System.IO.Directory]::Exists($destinationParent)) {
        throw "Managed directory destination parent is missing: $destinationParent"
    }
    $existingDestination = Get-RevitMcpLexicalItem -Path $destinationPath
    $destinationManifest = $null
    if ($null -ne $existingDestination) {
        if (-not $existingDestination.PSIsContainer -or
            ($existingDestination.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not [string]::IsNullOrWhiteSpace([string]$existingDestination.LinkType)) {
            throw "Managed directory destination must be an ordinary directory: $destinationPath"
        }
        $destinationManifest = Get-RevitMcpManagedTreeManifest -Root $destinationPath
    }

    $ownedGuard = $null
    $leafName = [System.IO.Path]::GetFileName($destinationPath)
    $stagePath = Join-Path $destinationParent (".{0}.stage-{1}" -f $leafName, [Guid]::NewGuid().ToString("N"))
    $backupPath = Join-Path $destinationParent (".{0}.backup-{1}" -f $leafName, [Guid]::NewGuid().ToString("N"))
    $failedPath = Join-Path $destinationParent (".{0}.failed-{1}" -f $leafName, [Guid]::NewGuid().ToString("N"))
    $oldMoved = $false
    $stageMoved = $false
    try {
        if ($null -eq $MutationGuard) {
            $ownedGuard = Open-RevAgentManagedMutationGuard -Path $destinationParent -ProtectedPaths @($destinationPath)
            $MutationGuard = $ownedGuard
        }
        Assert-RevitMcpMutationGuardIdentity -MutationGuard $MutationGuard -ParentRoot $destinationParent
        [void][System.IO.Directory]::CreateDirectory($stagePath)
        foreach ($relativeDirectory in @($sourceManifest.Directories)) {
            [void][System.IO.Directory]::CreateDirectory((Join-Path $stagePath $relativeDirectory))
        }
        foreach ($sourceFile in @($sourceManifest.Files)) {
            Copy-RevitMcpOrdinaryFileToNewPath -Source (Join-Path $sourceManifest.Root $sourceFile.RelativePath) -Destination (Join-Path $stagePath $sourceFile.RelativePath)
        }

        $sourceTopLevelNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $sourceManifest.Root -Force -ErrorAction Stop) {
            [void]$sourceTopLevelNames.Add([string]$entry.Name)
        }
        if ($null -ne $destinationManifest) {
            foreach ($preserveName in @($PreserveTopLevelNames)) {
                if ([string]::IsNullOrWhiteSpace($preserveName) -or $sourceTopLevelNames.Contains($preserveName)) { continue }
                $preservePath = Join-Path $destinationPath $preserveName
                $preserveItem = Get-RevitMcpLexicalItem -Path $preservePath
                if ($null -eq $preserveItem) { continue }
                if ($preserveItem.PSIsContainer) {
                    throw "Preserved managed config entry must be a top-level ordinary file: $preservePath"
                }
                [void](Assert-RevitMcpOrdinaryManagedFile -Path $preservePath -Label "Preserved managed config file")
                Copy-RevitMcpOrdinaryFileToNewPath -Source $preservePath -Destination (Join-Path $stagePath $preserveName)
            }
        }

        $expectedManifest = Get-RevitMcpManagedTreeManifest -Root $stagePath
        Assert-RevitMcpMutationGuardIdentity -MutationGuard $MutationGuard -ParentRoot $destinationParent
        if ($null -ne (Get-RevitMcpLexicalItem -Path $destinationPath)) {
            [void](Get-RevitMcpManagedTreeManifest -Root $destinationPath)
            [System.IO.Directory]::Move($destinationPath, $backupPath)
            $oldMoved = $true
        }
        [System.IO.Directory]::Move($stagePath, $destinationPath)
        $stageMoved = $true
        $actualManifest = Get-RevitMcpManagedTreeManifest -Root $destinationPath
        Assert-RevitMcpManagedTreeManifestEqual -Expected $expectedManifest -Actual $actualManifest -Label "Managed directory installation"
        if ($oldMoved) {
            [System.IO.Directory]::Delete($backupPath, $true)
            $oldMoved = $false
        }
        return $actualManifest
    }
    catch {
        $originalError = $_
        if ($stageMoved -and $null -ne (Get-RevitMcpLexicalItem -Path $destinationPath)) {
            try { [System.IO.Directory]::Move($destinationPath, $failedPath) } catch { }
        }
        if ($oldMoved -and $null -ne (Get-RevitMcpLexicalItem -Path $backupPath) -and $null -eq (Get-RevitMcpLexicalItem -Path $destinationPath)) {
            try {
                [System.IO.Directory]::Move($backupPath, $destinationPath)
                $oldMoved = $false
            }
            catch { }
        }
        if ($null -ne (Get-RevitMcpLexicalItem -Path $failedPath)) {
            try { [System.IO.Directory]::Delete($failedPath, $true) } catch { }
        }
        throw $originalError
    }
    finally {
        if ($null -ne (Get-RevitMcpLexicalItem -Path $stagePath)) {
            [System.IO.Directory]::Delete($stagePath, $true)
        }
        if ($null -ne $ownedGuard) { $ownedGuard.Dispose() }
    }
}

function Sync-RevitMcpUpdaterConfigDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot,
        [Microsoft.Win32.SafeHandles.SafeFileHandle]$MutationGuard
    )

    return Sync-RevitMcpManagedDirectory `
        -SourceRoot $SourceRoot `
        -DestinationRoot $DestinationRoot `
        -PreserveTopLevelNames @("release-trusted-keys.json", "license-trusted-keys.json", "revagent-license.json", "revagent-license.sig.json") `
        -MutationGuard $MutationGuard
}

$revAgentFunctionAliases = @{
    "Install-RevAgentManagedUpdaterFile" = "Install-RevitMcpManagedUpdaterFile"
    "Sync-RevAgentManagedDirectory" = "Sync-RevitMcpManagedDirectory"
    "Sync-RevAgentManagedUpdaterDirectory" = "Sync-RevitMcpManagedDirectory"
    "Sync-RevAgentUpdaterConfigDirectory" = "Sync-RevitMcpUpdaterConfigDirectory"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) {
    Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value
}

Export-ModuleMember -Function `
    Install-RevitMcpManagedUpdaterFile, `
    Sync-RevitMcpManagedDirectory, `
    Sync-RevitMcpUpdaterConfigDirectory
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)
