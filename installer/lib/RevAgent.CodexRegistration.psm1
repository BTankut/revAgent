Set-StrictMode -Version Latest

function ConvertTo-RevitMcpTomlString {
    param([string]$Value)

    return '"' + ([string]$Value).Replace('\', '\\').Replace('"', '\"') + '"'
}

function Set-RevitMcpCodexMcpServerConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$McpArgs = @()
    )

    $configDir = Split-Path -Parent $ConfigPath
    if (-not [string]::IsNullOrWhiteSpace($configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    $existing = if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
        Get-Content -Raw -LiteralPath $ConfigPath
    }
    else {
        ""
    }

    $sectionPattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($Name))\]\s*.*?(?=^\[|\z)"
    $argsToml = "[" + (($McpArgs | ForEach-Object { ConvertTo-RevitMcpTomlString -Value $_ }) -join ", ") + "]"
    $section = @(
        "[mcp_servers.$Name]",
        "command = $(ConvertTo-RevitMcpTomlString -Value $Command)",
        "args = $argsToml",
        ""
    ) -join "`r`n"

    if ($existing -match $sectionPattern) {
        $updated = [regex]::Replace($existing, $sectionPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $section })
    }
    else {
        $prefix = if ([string]::IsNullOrWhiteSpace($existing)) { "" } else { $existing.TrimEnd() + "`r`n`r`n" }
        $updated = $prefix + $section
    }

    Set-Content -LiteralPath $ConfigPath -Value $updated -Encoding UTF8
    return $ConfigPath
}

function Remove-RevitMcpCodexMcpServerConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        return $ConfigPath
    }

    $existing = Get-Content -Raw -LiteralPath $ConfigPath
    $sectionPattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($Name))\]\s*.*?(?=^\[|\z)"
    $updated = [regex]::Replace($existing, $sectionPattern, "")
    $updated = [regex]::Replace($updated, '(\r?\n){3,}', "`r`n`r`n").TrimEnd() + "`r`n"

    if ($updated -ne $existing) {
        Set-Content -LiteralPath $ConfigPath -Value $updated -Encoding UTF8
    }
    return $ConfigPath
}

function Set-RevitMcpTomlScalar {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content,
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Section,
        [Parameter(Mandatory = $true)]
        [string]$Key,
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $keyPattern = "(?m)^(\s*)$([regex]::Escape($Key))\s*=.*$"
    if ([string]::IsNullOrWhiteSpace($Section)) {
        $firstTableMatch = [regex]::Match($Content, "(?m)^\s*\[")
        $rootContent = if ($firstTableMatch.Success) {
            $Content.Substring(0, $firstTableMatch.Index)
        }
        else {
            $Content
        }
        $tableContent = if ($firstTableMatch.Success) {
            $Content.Substring($firstTableMatch.Index)
        }
        else {
            ""
        }

        if ($rootContent -match $keyPattern) {
            return [regex]::Replace($rootContent, $keyPattern, "`$1$Key = $Value") + $tableContent
        }

        if ([string]::IsNullOrWhiteSpace($rootContent)) {
            return "$Key = $Value`r`n" + $tableContent
        }

        return $rootContent.TrimEnd() + "`r`n$Key = $Value`r`n" + $tableContent
    }

    $sectionPattern = "(?ms)^\[$([regex]::Escape($Section))\]\s*.*?(?=^\[|\z)"
    if ($Content -match $sectionPattern) {
        return [regex]::Replace($Content, $sectionPattern, [System.Text.RegularExpressions.MatchEvaluator]{
            param($match)
            $block = [string]$match.Value
            if ($block -match $keyPattern) {
                return [regex]::Replace($block, $keyPattern, "`$1$Key = $Value")
            }

            return ($block.TrimEnd() + "`r`n$Key = $Value`r`n")
        })
    }

    $prefix = if ([string]::IsNullOrWhiteSpace($Content)) { "" } else { $Content.TrimEnd() + "`r`n`r`n" }
    return $prefix + "[$Section]`r`n$Key = $Value`r`n"
}

function Normalize-RevitMcpCodexServiceTier {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    $content = [regex]::Replace($Content, '(?m)^(\s*service_tier\s*=\s*)"priority"\s*$', '${1}"fast"')
    return Set-RevitMcpTomlScalar -Content $content -Section "" -Key "service_tier" -Value '"fast"'
}

function Set-RevitMcpCodexMemoryConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath
    )

    $configDir = Split-Path -Parent $ConfigPath
    if (-not [string]::IsNullOrWhiteSpace($configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    $content = if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
        Get-Content -Raw -LiteralPath $ConfigPath
    }
    else {
        ""
    }
    $original = $content

    $content = Normalize-RevitMcpCodexServiceTier -Content $content
    $content = Set-RevitMcpTomlScalar -Content $content -Section "features" -Key "memories" -Value "true"
    $content = Set-RevitMcpTomlScalar -Content $content -Section "features" -Key "chronicle" -Value "false"
    $content = Set-RevitMcpTomlScalar -Content $content -Section "memories" -Key "disable_on_external_context" -Value "true"
    $content = Set-RevitMcpTomlScalar -Content $content -Section "memories" -Key "generate_memories" -Value "true"
    $content = Set-RevitMcpTomlScalar -Content $content -Section "memories" -Key "use_memories" -Value "true"

    if ($content -ne $original) {
        Set-Content -LiteralPath $ConfigPath -Value $content -Encoding UTF8
    }
    return $ConfigPath
}

function Set-RevitMcpManagedPowerShellProfileBlock {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProfilePath,
        [Parameter(Mandatory = $true)]
        [string]$Block
    )

    $profileDir = Split-Path -Parent $ProfilePath
    if (-not [string]::IsNullOrWhiteSpace($profileDir)) {
        New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    }

    $existing = if (Test-Path -LiteralPath $ProfilePath -PathType Leaf) {
        Get-Content -Raw -LiteralPath $ProfilePath
    }
    else {
        ""
    }

    $begin = "# BEGIN revAgent UTF-8 console"
    $end = "# END revAgent UTF-8 console"
    $pattern = "(?ms)^$([regex]::Escape($begin))\r?\n.*?\r?\n$([regex]::Escape($end))\r?\n?"

    if ($existing -match $pattern) {
        $updated = [regex]::Replace($existing, $pattern, $Block + "`r`n")
    }
    else {
        $prefix = if ([string]::IsNullOrWhiteSpace($existing)) { "" } else { $existing.TrimEnd() + "`r`n`r`n" }
        $updated = $prefix + $Block + "`r`n"
    }

    if ($updated -ne $existing) {
        Set-Content -LiteralPath $ProfilePath -Value $updated -Encoding UTF8
    }

    return $ProfilePath
}

function Set-RevitMcpCurrentProcessUtf8Console {
    try {
        $revAgentUtf8Encoding = [System.Text.UTF8Encoding]::new($false)
        [Console]::InputEncoding = $revAgentUtf8Encoding
        [Console]::OutputEncoding = $revAgentUtf8Encoding
        $global:OutputEncoding = $revAgentUtf8Encoding
        $env:PYTHONUTF8 = "1"
        $env:PYTHONIOENCODING = "utf-8"
        $chcpPath = Join-Path ([Environment]::SystemDirectory) 'chcp.com'
        if (Test-Path -LiteralPath $chcpPath -PathType Leaf) {
            & $chcpPath 65001 > $null
        }

        return [ordered]@{
            success = $true
            codePage = 65001
            error = ""
        }
    }
    catch {
        return [ordered]@{
            success = $false
            codePage = 0
            error = $_.Exception.Message
        }
    }
}

function Set-RevitMcpPowerShellUtf8ConsoleConfig {
    param(
        [string]$UserProfileRoot = "",
        [switch]$ConfigureConsoleRegistry
    )

    if ([string]::IsNullOrWhiteSpace($UserProfileRoot)) {
        $UserProfileRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    }
    if ([string]::IsNullOrWhiteSpace($UserProfileRoot)) {
        return @()
    }

    $block = @(
        "# BEGIN revAgent UTF-8 console",
        'try {',
        '    $revAgentUtf8Encoding = [System.Text.UTF8Encoding]::new($false)',
        '    [Console]::InputEncoding = $revAgentUtf8Encoding',
        '    [Console]::OutputEncoding = $revAgentUtf8Encoding',
        '    $OutputEncoding = $revAgentUtf8Encoding',
        '    $env:PYTHONUTF8 = "1"',
        '    $env:PYTHONIOENCODING = "utf-8"',
        '    $revAgentChcpPath = Join-Path ([Environment]::SystemDirectory) "chcp.com"',
        '    if (Test-Path -LiteralPath $revAgentChcpPath -PathType Leaf) { & $revAgentChcpPath 65001 > $null }',
        '} catch {}',
        "# END revAgent UTF-8 console"
    ) -join "`r`n"

    $documentsRoot = Join-Path $UserProfileRoot "Documents"
    $profilePaths = @(
        (Join-Path $documentsRoot "WindowsPowerShell\Microsoft.PowerShell_profile.ps1"),
        (Join-Path $documentsRoot "PowerShell\Microsoft.PowerShell_profile.ps1")
    )

    $written = [System.Collections.Generic.List[string]]::new()
    foreach ($profilePath in $profilePaths) {
        [void]$written.Add((Set-RevitMcpManagedPowerShellProfileBlock -ProfilePath $profilePath -Block $block))
    }

    if ($ConfigureConsoleRegistry) {
        try {
            New-Item -Path "HKCU:\Console" -Force | Out-Null
            New-ItemProperty -Path "HKCU:\Console" -Name "CodePage" -Value 65001 -PropertyType DWord -Force | Out-Null
        }
        catch {
            Write-Warning "Could not set HKCU console UTF-8 code page: $($_.Exception.Message)"
        }
    }

    return @($written.ToArray())
}

function Register-RevitMcpCodexMcpServersInConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,
        [Parameter(Mandatory = $true)]
        [string]$NodePath,
        [Parameter(Mandatory = $true)]
        [string]$RuntimeServerPath,
        [Parameter(Mandatory = $true)]
        [string]$DocsServerPath
    )

    foreach ($legacyName in @("revit-mcp", "revit-api-docs")) {
        [void](Remove-RevitMcpCodexMcpServerConfig -ConfigPath $ConfigPath -Name $legacyName)
    }

    [void](Set-RevitMcpCodexMcpServerConfig -ConfigPath $ConfigPath -Name "revAgent" -Command $NodePath -McpArgs @($RuntimeServerPath))
    [void](Set-RevitMcpCodexMcpServerConfig -ConfigPath $ConfigPath -Name "revAgent-api-docs" -Command $NodePath -McpArgs @($DocsServerPath))
    [void](Set-RevitMcpCodexMemoryConfig -ConfigPath $ConfigPath)
    return $ConfigPath
}

$revAgentFunctionAliases = @{
    "ConvertTo-RevAgentTomlString" = "ConvertTo-RevitMcpTomlString"
    "Register-RevAgentCodexMcpServersInConfig" = "Register-RevitMcpCodexMcpServersInConfig"
    "Remove-RevAgentCodexMcpServerConfig" = "Remove-RevitMcpCodexMcpServerConfig"
    "Set-RevAgentCodexMcpServerConfig" = "Set-RevitMcpCodexMcpServerConfig"
    "Set-RevAgentCodexMemoryConfig" = "Set-RevitMcpCodexMemoryConfig"
    "Set-RevAgentCurrentProcessUtf8Console" = "Set-RevitMcpCurrentProcessUtf8Console"
    "Set-RevAgentPowerShellUtf8ConsoleConfig" = "Set-RevitMcpPowerShellUtf8ConsoleConfig"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) {
    Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value
}

Export-ModuleMember -Function ConvertTo-RevitMcpTomlString, Set-RevitMcpCodexMcpServerConfig, Remove-RevitMcpCodexMcpServerConfig, Set-RevitMcpCodexMemoryConfig, Set-RevitMcpCurrentProcessUtf8Console, Set-RevitMcpPowerShellUtf8ConsoleConfig, Register-RevitMcpCodexMcpServersInConfig
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)

$script:RevAgentUtf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:RevAgentManagedSkillMarker = ".revagent-managed.json"
$script:RevAgentManagedAgentsMarker = "AGENTS.md.revagent-managed.json"
$script:RevAgentOsSystemDirectory = [Environment]::SystemDirectory
$script:RevAgentOsProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$script:RevAgentOsProgramFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
$script:RevAgentOsUserProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$script:RevAgentOsLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$script:RevAgentOsCommonAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)

if (-not ("RevAgent.NativeFileInfo" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public static class NativeFileInfo {
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
            SafeFileHandle hFile,
            out BY_HANDLE_FILE_INFORMATION fileInformation);

        public static uint GetLinkCount(string path) {
            using (var stream = new System.IO.FileStream(
                path,
                System.IO.FileMode.Open,
                System.IO.FileAccess.Read,
                System.IO.FileShare.ReadWrite | System.IO.FileShare.Delete)) {
                BY_HANDLE_FILE_INFORMATION info;
                if (!GetFileInformationByHandle(stream.SafeFileHandle, out info)) {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                return info.NumberOfLinks;
            }
        }

        public static uint GetLinkCountFromHandle(SafeFileHandle handle) {
            if (handle == null || handle.IsInvalid || handle.IsClosed) {
                throw new ArgumentException("A valid open file handle is required.", "handle");
            }
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            return info.NumberOfLinks;
        }

        public static string GetIdentity(string path) {
            using (var stream = new System.IO.FileStream(
                path,
                System.IO.FileMode.Open,
                System.IO.FileAccess.Read,
                System.IO.FileShare.ReadWrite | System.IO.FileShare.Delete)) {
                BY_HANDLE_FILE_INFORMATION info;
                if (!GetFileInformationByHandle(stream.SafeFileHandle, out info)) {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                return String.Format(
                    System.Globalization.CultureInfo.InvariantCulture,
                    "{0:X8}:{1:X8}{2:X8}:{3}",
                    info.VolumeSerialNumber,
                    info.FileIndexHigh,
                    info.FileIndexLow,
                    info.NumberOfLinks);
            }
        }
    }
}
"@
}

if (-not ("RevAgent.NativeSessionInfo" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace RevAgent {
    public static class NativeSessionInfo {
        [DllImport("kernel32.dll")]
        private static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("Wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool WTSQuerySessionInformation(
            IntPtr server,
            uint sessionId,
            int infoClass,
            out IntPtr buffer,
            out uint bytesReturned);

        [DllImport("Wtsapi32.dll")]
        private static extern void WTSFreeMemory(IntPtr buffer);

        private static string Query(uint sessionId, int infoClass) {
            IntPtr buffer = IntPtr.Zero;
            uint bytes;
            try {
                if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, infoClass, out buffer, out bytes) || buffer == IntPtr.Zero) {
                    return String.Empty;
                }
                return Marshal.PtrToStringUni(buffer) ?? String.Empty;
            }
            finally {
                if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
            }
        }

        public static string GetActiveConsoleAccount() {
            uint sessionId = WTSGetActiveConsoleSessionId();
            if (sessionId == 0xFFFFFFFF) return String.Empty;
            string user = Query(sessionId, 5);
            string domain = Query(sessionId, 7);
            if (String.IsNullOrWhiteSpace(user)) return String.Empty;
            return String.IsNullOrWhiteSpace(domain) ? user : domain + "\\" + user;
        }
    }
}
"@
}

function Get-RevAgentFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
    if ([string]::IsNullOrWhiteSpace($expanded)) {
        throw "Path must not be empty."
    }
    return [System.IO.Path]::GetFullPath($expanded)
}

function Test-RevAgentPathWithinRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $fullPath = (Get-RevAgentFullPath -Path $Path).TrimEnd('\')
    $fullRoot = (Get-RevAgentFullPath -Path $Root).TrimEnd('\')
    return [string]::Equals($fullPath, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RevAgentFileLinkCount {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return 0
    }
    return [int][RevAgent.NativeFileInfo]::GetLinkCount((Get-RevAgentFullPath -Path $Path))
}

function Get-RevAgentFileIdentity {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return "MISSING"
    }
    return [string][RevAgent.NativeFileInfo]::GetIdentity((Get-RevAgentFullPath -Path $Path))
}

function Get-RevAgentObjectPropertyInfo {
    param(
        [AllowNull()][object]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $InputObject) { return $null }
    $member = Get-Member -InputObject $InputObject -Name $Name -MemberType Property, NoteProperty, AliasProperty, ScriptProperty -ErrorAction SilentlyContinue
    if ($null -eq $member) { return $null }
    return [pscustomobject]@{ Value = $InputObject.$Name }
}

function Assert-RevAgentSafeUserPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [ValidateSet("Any", "File", "Directory")][string]$LeafKind = "Any",
        [switch]$AllowMissing,
        [switch]$AllowHardLinkedLeaf
    )

    $fullPath = Get-RevAgentFullPath -Path $Path
    $fullRoot = Get-RevAgentFullPath -Path $AllowedRoot
    if (-not (Test-RevAgentPathWithinRoot -Path $fullPath -Root $fullRoot)) {
        throw "Refusing user-root access outside the allowed root. path=$fullPath root=$fullRoot"
    }

    $root = [System.IO.Path]::GetPathRoot($fullRoot)
    $relative = $fullPath.Substring($root.Length)
    $cursor = $root.TrimEnd('\')
    foreach ($segment in @($relative -split '\\' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $cursor = Join-Path $cursor $segment
        if (-not (Test-Path -LiteralPath $cursor)) {
            continue
        }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing user-root path containing a reparse point: $cursor"
        }
    }

    $exists = Test-Path -LiteralPath $fullPath
    if (-not $exists -and -not $AllowMissing) {
        throw "Required path does not exist: $fullPath"
    }
    if ($exists -and $LeafKind -eq "File" -and -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Expected a file path: $fullPath"
    }
    if ($exists -and $LeafKind -eq "Directory" -and -not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw "Expected a directory path: $fullPath"
    }
    if ($exists -and $LeafKind -ne "Directory" -and (Test-Path -LiteralPath $fullPath -PathType Leaf) -and -not $AllowHardLinkedLeaf) {
        $linkCount = Get-RevAgentFileLinkCount -Path $fullPath
        if ($linkCount -ne 1) {
            throw "Refusing user-root file with hard-link count ${linkCount}: $fullPath"
        }
    }
    return $fullPath
}

function New-RevAgentSafeUserDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot
    )

    $fullPath = Get-RevAgentFullPath $Path
    $fullRoot = Get-RevAgentFullPath $AllowedRoot
    if (-not (Test-RevAgentPathWithinRoot -Path $fullPath -Root $fullRoot)) {
        throw "Refusing to create a directory outside the allowed user root. path=$fullPath root=$fullRoot"
    }
    [void](Assert-RevAgentSafeUserPath -Path $fullRoot -AllowedRoot $fullRoot -LeafKind Directory)
    $relative = $fullPath.Substring($fullRoot.TrimEnd('\').Length).TrimStart('\')
    $cursor = $fullRoot.TrimEnd('\')
    foreach ($segment in @($relative -split '\\' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $next = Join-Path $cursor $segment
        if (Test-Path -LiteralPath $next) {
            [void](Assert-RevAgentSafeUserPath -Path $next -AllowedRoot $fullRoot -LeafKind Directory)
        }
        else {
            New-Item -ItemType Directory -Path $next -ErrorAction Stop | Out-Null
            [void](Assert-RevAgentSafeUserPath -Path $next -AllowedRoot $fullRoot -LeafKind Directory)
        }
        $cursor = $next
    }
    return $fullPath
}

function Test-RevAgentProcessElevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-RevAgentProfileListPath {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$ProfileImagePath)

    $value = $ProfileImagePath.Trim()
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "ProfileList ProfileImagePath must not be empty."
    }
    $canonicalSystemDrive = [System.IO.Path]::GetPathRoot([Environment]::SystemDirectory).TrimEnd('\')
    $value = [regex]::Replace($value, '(?i)%SystemDrive%', [System.Text.RegularExpressions.MatchEvaluator]{
        param($match)
        return $canonicalSystemDrive
    })
    if ($value.Contains('%')) {
        throw "ProfileList ProfileImagePath contains an unsupported environment token: $value"
    }
    if (-not [System.IO.Path]::IsPathRooted($value)) {
        throw "ProfileList ProfileImagePath must be absolute: $value"
    }
    return [System.IO.Path]::GetFullPath($value)
}

function Resolve-RevAgentInteractiveUser {
    [CmdletBinding()]
    param(
        [string]$TargetUserSid = "",
        [string]$TargetUserProfileRoot = ""
    )

    if (Test-RevAgentProcessElevated) {
        throw "Codex user integration must run unelevated. The elevated machine phase must return to the original user before invoking it."
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $currentSid = [string]$identity.User.Value
    $interactiveName = ""
    $interactiveSid = ""
    try {
        $interactiveName = [string](CimCmdlets\Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).UserName
        if (-not [string]::IsNullOrWhiteSpace($interactiveName)) {
            $interactiveSid = [string]([Security.Principal.NTAccount]$interactiveName).Translate([Security.Principal.SecurityIdentifier]).Value
        }
    }
    catch {}
    if ([string]::IsNullOrWhiteSpace($interactiveName)) {
        try {
            $interactiveName = [string][RevAgent.NativeSessionInfo]::GetActiveConsoleAccount()
            if (-not [string]::IsNullOrWhiteSpace($interactiveName)) {
                $interactiveSid = [string]([Security.Principal.NTAccount]$interactiveName).Translate([Security.Principal.SecurityIdentifier]).Value
            }
        }
        catch {}
    }

    $resolvedSid = if ([string]::IsNullOrWhiteSpace($TargetUserSid)) { $currentSid } else { $TargetUserSid.Trim() }
    if ([string]::IsNullOrWhiteSpace($TargetUserSid) -and -not [string]::IsNullOrWhiteSpace($interactiveSid) -and
        -not [string]::Equals($currentSid, $interactiveSid, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The unelevated process user does not match the interactive desktop user. current=$currentSid interactive=$interactiveSid"
    }
    if (-not [string]::Equals($currentSid, $resolvedSid, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The unelevated integration process SID does not match the target user SID. current=$currentSid target=$resolvedSid"
    }

    $profileKey = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$resolvedSid"
    $profileImagePath = [string](Microsoft.PowerShell.Management\Get-ItemPropertyValue -LiteralPath $profileKey -Name ProfileImagePath -ErrorAction Stop)
    $profileRoot = Resolve-RevAgentProfileListPath -ProfileImagePath $profileImagePath
    if (-not [string]::IsNullOrWhiteSpace($TargetUserProfileRoot)) {
        $targetProfileText = $TargetUserProfileRoot.Trim()
        if ($targetProfileText.Contains('%')) {
            throw "Target user profile root must be an absolute token-free path; ProfileList is the only environment-token authority. target=$targetProfileText"
        }
        if (-not [System.IO.Path]::IsPathRooted($targetProfileText)) {
            throw "Target user profile root must be absolute: $targetProfileText"
        }
        $targetProfile = [System.IO.Path]::GetFullPath($targetProfileText)
        if (-not [string]::Equals($targetProfile, $profileRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "The target user profile root does not match the SID's HKLM ProfileList binding. sid=$resolvedSid target=$targetProfile profileList=$profileRoot"
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($script:RevAgentOsUserProfile)) {
        $knownProfile = [System.IO.Path]::GetFullPath($script:RevAgentOsUserProfile)
        if (-not [string]::Equals($knownProfile, $profileRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "The current process user profile does not match the SID's HKLM ProfileList binding. sid=$resolvedSid current=$knownProfile profileList=$profileRoot"
        }
    }
    if (-not (Test-Path -LiteralPath $profileRoot -PathType Container)) {
        throw "Target user profile root was not found: $profileRoot"
    }

    return [pscustomobject][ordered]@{
        sid = $resolvedSid
        account = [string]$identity.Name
        profileRoot = $profileRoot
        interactiveAccount = $interactiveName
        interactiveSid = $interactiveSid
        interactiveMatchesCurrent = [string]::IsNullOrWhiteSpace($interactiveSid) -or
            [string]::Equals($interactiveSid, $currentSid, [System.StringComparison]::OrdinalIgnoreCase)
    }
}

function Resolve-RevAgentCodexHome {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$UserProfileRoot,
        [string]$CodexHome = ""
    )

    $source = "default"
    $candidate = $CodexHome
    if ([string]::IsNullOrWhiteSpace($candidate) -and -not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        $candidate = [string]$env:CODEX_HOME
        $source = "environment"
    }
    elseif (-not [string]::IsNullOrWhiteSpace($candidate)) {
        $source = "explicit"
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = Join-Path $UserProfileRoot ".codex"
    }

    $path = Get-RevAgentFullPath -Path $candidate
    $guardRoot = if (Test-RevAgentPathWithinRoot -Path $path -Root $UserProfileRoot) { $UserProfileRoot } else { $path }
    if (-not (Test-Path -LiteralPath $path)) {
        $parent = Split-Path -Parent $path
        if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
            throw "CODEX_HOME parent must already exist so its path can be guarded: $path"
        }
        $parentGuardRoot = if (Test-RevAgentPathWithinRoot -Path $parent -Root $guardRoot) { $guardRoot } else { $parent }
        [void](Assert-RevAgentSafeUserPath -Path $parent -AllowedRoot $parentGuardRoot -LeafKind Directory)
        New-Item -ItemType Directory -Path $path -ErrorAction Stop | Out-Null
    }
    [void](Assert-RevAgentSafeUserPath -Path $path -AllowedRoot $guardRoot -LeafKind Directory)
    return [pscustomobject][ordered]@{ path = $path; source = $source; guardRoot = $guardRoot }
}

function Get-RevAgentFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "MISSING" }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Get-RevAgentDirectoryTreeSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return "MISSING" }
    foreach ($directory in @(Get-ChildItem -LiteralPath $Path -Directory -Recurse -Force)) {
        if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Skill payload contains a reparse-point directory: $($directory.FullName)"
        }
    }
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($file in @(Get-ChildItem -LiteralPath $Path -File -Recurse -Force | Sort-Object FullName)) {
        if ($file.Name -eq $script:RevAgentManagedSkillMarker) { continue }
        if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Skill payload contains a reparse point: $($file.FullName)"
        }
        $linkCount = Get-RevAgentFileLinkCount -Path $file.FullName
        if ($linkCount -ne 1) {
            throw "Skill payload contains a hard-linked file (link count $linkCount): $($file.FullName)"
        }
        $relative = $file.FullName.Substring((Get-RevAgentFullPath -Path $Path).TrimEnd('\').Length + 1).Replace('\', '/')
        $lines.Add("$relative`t$(Get-RevAgentFileSha256 -Path $file.FullName)")
    }
    $bytes = $script:RevAgentUtf8NoBom.GetBytes(($lines -join "`n"))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '') }
    finally { $sha.Dispose() }
}

function Write-RevAgentFileCreateNew {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )

    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
}

function Copy-RevAgentDirectoryTreeCreateNew {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    $sourceRoot = (Get-RevAgentFullPath -Path $SourcePath).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
        throw "Directory staging source was not found: $sourceRoot"
    }
    if (Test-Path -LiteralPath $DestinationPath) {
        throw "CreateNew directory staging destination already exists: $DestinationPath"
    }
    New-Item -ItemType Directory -Path $DestinationPath -ErrorAction Stop | Out-Null
    foreach ($directory in @(Get-ChildItem -LiteralPath $sourceRoot -Directory -Recurse -Force | Sort-Object FullName)) {
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Directory staging source contains a reparse-point directory: $($directory.FullName)"
        }
        $relative = $directory.FullName.Substring($sourceRoot.Length + 1)
        $destinationDirectory = Join-Path $DestinationPath $relative
        if (Test-Path -LiteralPath $destinationDirectory) {
            throw "CreateNew directory staging path unexpectedly exists: $destinationDirectory"
        }
        New-Item -ItemType Directory -Path $destinationDirectory -ErrorAction Stop | Out-Null
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force | Sort-Object FullName)) {
        if ($file.Name -eq $script:RevAgentManagedSkillMarker) { continue }
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Directory staging source contains a reparse-point file: $($file.FullName)"
        }
        $linkCount = Get-RevAgentFileLinkCount -Path $file.FullName
        if ($linkCount -ne 1) {
            throw "Directory staging source contains a hard-linked file (link count $linkCount): $($file.FullName)"
        }
        $relative = $file.FullName.Substring($sourceRoot.Length + 1)
        $destinationFile = Join-Path $DestinationPath $relative
        $sourceStream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            $destinationStream = [IO.File]::Open($destinationFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $sourceStream.CopyTo($destinationStream)
                $destinationStream.Flush($true)
            }
            finally { $destinationStream.Dispose() }
        }
        finally { $sourceStream.Dispose() }
    }
}

function Get-RevAgentFileCommitState {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject][ordered]@{ exists = $false; kind = 'missing'; sha256 = 'MISSING'; identity = 'MISSING'; linkCount = 0; linkTarget = '' }
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        return [pscustomobject][ordered]@{
            exists = $true; kind = 'reparse'; sha256 = 'UNSAFE'; identity = 'REPARSE'; linkCount = 0
            linkTarget = [string]$item.Target
        }
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject][ordered]@{ exists = $true; kind = 'not_file'; sha256 = 'UNSAFE'; identity = 'UNSAFE'; linkCount = 0; linkTarget = '' }
    }
    return [pscustomobject][ordered]@{
        exists = $true; kind = 'file'; sha256 = (Get-RevAgentFileSha256 -Path $Path)
        identity = (Get-RevAgentFileIdentity -Path $Path); linkCount = (Get-RevAgentFileLinkCount -Path $Path); linkTarget = ''
    }
}

function Test-RevAgentFileCommitStateEqual {
    param([Parameter(Mandatory = $true)]$Expected, [Parameter(Mandatory = $true)]$Actual)

    return [bool]$Expected.exists -eq [bool]$Actual.exists -and
        [string]::Equals([string]$Expected.kind, [string]$Actual.kind, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$Expected.sha256, [string]$Actual.sha256, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$Expected.identity, [string]$Actual.identity, [StringComparison]::OrdinalIgnoreCase) -and
        [int]$Expected.linkCount -eq [int]$Actual.linkCount -and
        [string]::Equals([string]$Expected.linkTarget, [string]$Actual.linkTarget, [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-RevAgentAtomicFileCommit {
    param(
        [Parameter(Mandatory = $true)][string]$StagePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)]$BeforeState,
        [Parameter(Mandatory = $true)]$StagedState,
        [Parameter(Mandatory = $true)][string]$GuardRoot
    )

    $backupPresent = $false
    if (-not $BeforeState.exists) {
        [IO.File]::Move($StagePath, $DestinationPath)
    }
    elseif ($BeforeState.kind -eq 'file') {
        [IO.File]::Replace($StagePath, $DestinationPath, $BackupPath, $true)
        $backupPresent = $true
    }
    elseif ($BeforeState.kind -eq 'reparse') {
        # ReplaceFile may follow a symbolic link. Move the link object itself to
        # the backup name, verify it, then install the regular staged file.
        [IO.File]::Move($DestinationPath, $BackupPath)
        $backupPresent = $true
        $displacedLinkState = Get-RevAgentFileCommitState -Path $BackupPath
        if (-not (Test-RevAgentFileCommitStateEqual -Expected $BeforeState -Actual $displacedLinkState)) {
            if (-not (Test-Path -LiteralPath $DestinationPath)) { [IO.File]::Move($BackupPath, $DestinationPath) }
            throw "File destination changed during atomic link displacement; the displaced path was restored when safe: $DestinationPath"
        }
        [IO.File]::Move($StagePath, $DestinationPath)
    }
    else { throw "Refusing atomic file commit over a non-file destination: $DestinationPath" }

    [void](Assert-RevAgentSafeUserPath -Path $DestinationPath -AllowedRoot $GuardRoot -LeafKind File)
    $installedState = Get-RevAgentFileCommitState -Path $DestinationPath
    if (-not (Test-RevAgentFileCommitStateEqual -Expected $StagedState -Actual $installedState)) {
        throw "Atomic file commit did not preserve the verified CreateNew stage identity/hash: $DestinationPath"
    }
    if ($backupPresent) {
        $displacedState = Get-RevAgentFileCommitState -Path $BackupPath
        if (-not (Test-RevAgentFileCommitStateEqual -Expected $BeforeState -Actual $displacedState)) {
            # A non-cooperating writer landed after pre-commit revalidation.
            # Restore that exact displaced object only while our stage is still
            # the destination; otherwise preserve both paths and fail closed.
            $currentState = Get-RevAgentFileCommitState -Path $DestinationPath
            if (Test-RevAgentFileCommitStateEqual -Expected $StagedState -Actual $currentState) {
                if ($displacedState.kind -eq 'file') {
                    $discardPath = $BackupPath + '.discard-' + [Guid]::NewGuid().ToString('N')
                    try {
                        [IO.File]::Replace($BackupPath, $DestinationPath, $discardPath, $true)
                        $restoredState = Get-RevAgentFileCommitState -Path $DestinationPath
                        $discardState = Get-RevAgentFileCommitState -Path $discardPath
                        if (-not (Test-RevAgentFileCommitStateEqual -Expected $displacedState -Actual $restoredState) -or
                            -not (Test-RevAgentFileCommitStateEqual -Expected $StagedState -Actual $discardState)) {
                            throw "Atomic file race recovery could not be attested: $DestinationPath"
                        }
                        Remove-Item -LiteralPath $discardPath -Force -ErrorAction Stop
                    }
                    finally {
                        if (Test-Path -LiteralPath $discardPath -PathType Leaf) { Remove-Item -LiteralPath $discardPath -Force -ErrorAction SilentlyContinue }
                    }
                }
                elseif ($displacedState.kind -eq 'reparse') {
                    $discardPath = $DestinationPath + '.discard-' + [Guid]::NewGuid().ToString('N')
                    [IO.File]::Move($DestinationPath, $discardPath)
                    try { [IO.File]::Move($BackupPath, $DestinationPath) }
                    catch {
                        if (-not (Test-Path -LiteralPath $DestinationPath) -and (Test-Path -LiteralPath $discardPath)) { [IO.File]::Move($discardPath, $DestinationPath) }
                        throw
                    }
                    Remove-Item -LiteralPath $discardPath -Force -ErrorAction Stop
                }
            }
            throw "File destination changed during atomic replace; displaced writer data was restored when safe. path=$DestinationPath expectedHash=$($BeforeState.sha256) displacedHash=$($displacedState.sha256) expectedIdentity=$($BeforeState.identity) displacedIdentity=$($displacedState.identity) recoveryBackup=$BackupPath"
        }
    }
    return [pscustomobject][ordered]@{ installedState = $installedState; backupPresent = $backupPresent }
}

function Restore-RevAgentAtomicFileCommit {
    param(
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)]$BeforeState,
        [Parameter(Mandatory = $true)]$InstalledState
    )

    $currentState = Get-RevAgentFileCommitState -Path $DestinationPath
    if (-not (Test-RevAgentFileCommitStateEqual -Expected $InstalledState -Actual $currentState)) {
        return $false
    }
    if (-not $BeforeState.exists) {
        $discardPath = $DestinationPath + '.rollback-' + [Guid]::NewGuid().ToString('N')
        [IO.File]::Move($DestinationPath, $discardPath)
        $discardState = Get-RevAgentFileCommitState -Path $discardPath
        if (-not (Test-RevAgentFileCommitStateEqual -Expected $InstalledState -Actual $discardState)) {
            if (-not (Test-Path -LiteralPath $DestinationPath)) { [IO.File]::Move($discardPath, $DestinationPath) }
            return $false
        }
        Remove-Item -LiteralPath $discardPath -Force -ErrorAction Stop
        return $true
    }
    if (-not (Test-Path -LiteralPath $BackupPath)) { return $false }
    $backupState = Get-RevAgentFileCommitState -Path $BackupPath
    if (-not (Test-RevAgentFileCommitStateEqual -Expected $BeforeState -Actual $backupState)) { return $false }
    if ($BeforeState.kind -eq 'file') {
        $discardPath = $BackupPath + '.rollback-' + [Guid]::NewGuid().ToString('N')
        [IO.File]::Replace($BackupPath, $DestinationPath, $discardPath, $true)
        $restoredState = Get-RevAgentFileCommitState -Path $DestinationPath
        $discardState = Get-RevAgentFileCommitState -Path $discardPath
        if (-not (Test-RevAgentFileCommitStateEqual -Expected $BeforeState -Actual $restoredState) -or
            -not (Test-RevAgentFileCommitStateEqual -Expected $InstalledState -Actual $discardState)) {
            return $false
        }
        Remove-Item -LiteralPath $discardPath -Force -ErrorAction Stop
        return $true
    }
    $discardPath = $DestinationPath + '.rollback-' + [Guid]::NewGuid().ToString('N')
    [IO.File]::Move($DestinationPath, $discardPath)
    try { [IO.File]::Move($BackupPath, $DestinationPath) }
    catch {
        if (-not (Test-Path -LiteralPath $DestinationPath) -and (Test-Path -LiteralPath $discardPath)) { [IO.File]::Move($discardPath, $DestinationPath) }
        throw
    }
    Remove-Item -LiteralPath $discardPath -Force -ErrorAction Stop
    return $true
}

function Get-RevAgentSkillCommitState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$GuardRoot
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject][ordered]@{
            exists = $false; kind = 'missing'; treeSha256 = 'MISSING'; markerSha256 = 'MISSING'; markerIdentity = 'MISSING'
            skillSha256 = 'MISSING'; skillIdentity = 'MISSING'; linkTarget = ''
        }
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        return [pscustomobject][ordered]@{
            exists = $true; kind = 'reparse'; treeSha256 = 'UNSAFE'; markerSha256 = 'UNSAFE'; markerIdentity = 'REPARSE'
            skillSha256 = 'UNSAFE'; skillIdentity = 'REPARSE'; linkTarget = [string]$item.Target
        }
    }
    [void](Assert-RevAgentSafeUserPath -Path $Path -AllowedRoot $GuardRoot -LeafKind Directory)
    $markerPath = Join-Path $Path $script:RevAgentManagedSkillMarker
    $skillPath = Join-Path $Path 'SKILL.md'
    $markerState = Get-RevAgentFileCommitState -Path $markerPath
    $skillState = Get-RevAgentFileCommitState -Path $skillPath
    return [pscustomobject][ordered]@{
        exists = $true; kind = 'directory'; treeSha256 = (Get-RevAgentDirectoryTreeSha256 -Path $Path)
        markerSha256 = $markerState.sha256; markerIdentity = $markerState.identity
        skillSha256 = $skillState.sha256; skillIdentity = $skillState.identity; linkTarget = ''
    }
}

function Test-RevAgentSkillCommitStateEqual {
    param([Parameter(Mandatory = $true)]$Expected, [Parameter(Mandatory = $true)]$Actual)

    return [bool]$Expected.exists -eq [bool]$Actual.exists -and
        [string]::Equals([string]$Expected.kind, [string]$Actual.kind, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$Expected.treeSha256, [string]$Actual.treeSha256, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$Expected.markerSha256, [string]$Actual.markerSha256, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$Expected.markerIdentity, [string]$Actual.markerIdentity, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$Expected.skillSha256, [string]$Actual.skillSha256, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$Expected.skillIdentity, [string]$Actual.skillIdentity, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$Expected.linkTarget, [string]$Actual.linkTarget, [StringComparison]::OrdinalIgnoreCase)
}

function ConvertTo-RevAgentWindowsArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ([regex]::Replace($Value, '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-RevAgentProcessProbe {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 15,
        [hashtable]$Environment = @{}
    )

    $actualFile = $FilePath
    $actualArguments = @($Arguments)
    $batchArgumentLine = ''
    if ([System.IO.Path]::GetExtension($FilePath) -in @('.cmd', '.bat')) {
        $commandParts = [System.Collections.Generic.List[string]]::new()
        foreach ($value in @($FilePath) + @($Arguments)) {
            $text = [string]$value
            if ($text -match '[\r\n"%!]') {
                throw "Refusing unsafe batch-probe argument."
            }
            # Quote every token so cmd metacharacters in paths cannot become
            # command separators. Percent/bang expansion and embedded quotes
            # are rejected above instead of being ambiguously escaped.
            $commandParts.Add('"' + $text + '"')
        }
        $actualFile = Join-Path $script:RevAgentOsSystemDirectory 'cmd.exe'
        $batchArgumentLine = '/d /s /c call ' + ($commandParts -join ' ')
    }

    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $actualFile
    if (-not [string]::IsNullOrWhiteSpace($batchArgumentLine)) {
        $start.Arguments = $batchArgumentLine
    }
    else {
        $quotedArguments = @($actualArguments | ForEach-Object { ConvertTo-RevAgentWindowsArgument -Value ([string]$_) })
        $start.Arguments = $quotedArguments -join ' '
    }
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($key in $Environment.Keys) { $start.EnvironmentVariables[[string]$key] = [string]$Environment[$key] }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "Process did not start: $FilePath" }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch {}
            return [pscustomobject][ordered]@{ exitCode = -1; timedOut = $true; stdout = ""; stderr = "Timed out after $TimeoutSeconds seconds." }
        }
        $stdout = $stdoutTask.Result
        $stderr = $stderrTask.Result
        return [pscustomobject][ordered]@{ exitCode = $process.ExitCode; timedOut = $false; stdout = $stdout.Trim(); stderr = $stderr.Trim() }
    }
    catch {
        return [pscustomobject][ordered]@{ exitCode = -1; timedOut = $false; stdout = ""; stderr = $_.Exception.Message }
    }
    finally { $process.Dispose() }
}

function Get-RevAgentSignatureStatus {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
        $subject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { "" }
        $valid = [string]$signature.Status -eq 'Valid'
        $openAiSubject = 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US'
        $openJsSubject = 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'
        return [pscustomobject][ordered]@{
            status = [string]$signature.Status
            subject = $subject
            openAi = $valid -and [string]::Equals($subject, $openAiSubject, [System.StringComparison]::Ordinal)
            openJs = $valid -and [string]::Equals($subject, $openJsSubject, [System.StringComparison]::Ordinal)
        }
    }
    catch { return [pscustomobject][ordered]@{ status = 'UnknownError'; subject = ''; openAi = $false; openJs = $false } }
}

function Get-RevAgentCurrentEnabledTokenSidSet {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $administratorsSid = 'S-1-5-32-544'
    $result = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    [void]$result.Add([string]$identity.User.Value)
    [void]$result.Add('S-1-1-0')  # Everyone
    [void]$result.Add('S-1-5-11') # Authenticated Users
    foreach ($group in @($identity.Groups)) {
        $sid = [string]$group.Value
        if ([string]::Equals($sid, $administratorsSid, [StringComparison]::OrdinalIgnoreCase) -and
            -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            continue
        }
        [void]$result.Add($sid)
    }
    return $result
}

function Get-RevAgentProtectedPathAclStatus {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = Get-RevAgentFullPath $Path
    $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $fullPath -ErrorAction Stop
    $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $trustedInstallerSid = ''
    try {
        $trustedInstallerSid = [string]([Security.Principal.NTAccount]'NT SERVICE\TrustedInstaller').Translate([Security.Principal.SecurityIdentifier]).Value
    }
    catch {}
    $trustedOwners = @('S-1-5-18', 'S-1-5-32-544')
    if (-not [string]::IsNullOrWhiteSpace($trustedInstallerSid)) { $trustedOwners += $trustedInstallerSid }
    $ownerTrusted = @($trustedOwners | Where-Object { [string]::Equals($_, $ownerSid, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0

    $enabledSids = Get-RevAgentCurrentEnabledTokenSidSet
    $allowBits = 0L
    $denyBits = 0L
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    foreach ($rule in $rules) {
        if (-not $enabledSids.Contains([string]$rule.IdentityReference.Value)) { continue }
        $bits = [int64]$rule.FileSystemRights
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) { $denyBits = $denyBits -bor $bits }
        else { $allowBits = $allowBits -bor $bits }
    }
    $dangerousRights = [int64]([Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership)
    $effectiveWriteBits = ($allowBits -band (-bnot $denyBits)) -band $dangerousRights
    $trustedWriterSids = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($sid in $trustedOwners) { [void]$trustedWriterSids.Add($sid) }
    $foreignWriteRules = @($rules | Where-Object {
        $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        (([int64]$_.FileSystemRights -band $dangerousRights) -ne 0) -and
        -not $trustedWriterSids.Contains([string]$_.IdentityReference.Value)
    } | ForEach-Object {
        [pscustomobject]@{ sid = [string]$_.IdentityReference.Value; rights = [string]$_.FileSystemRights; inherited = [bool]$_.IsInherited }
    })
    return [pscustomobject][ordered]@{
        path = $fullPath
        ownerSid = $ownerSid
        ownerTrusted = $ownerTrusted
        daclProtected = [bool]$acl.AreAccessRulesProtected
        currentTokenEffectiveWriteBits = $effectiveWriteBits
        currentTokenCanWrite = $effectiveWriteBits -ne 0
        foreignWriteRules = @($foreignWriteRules)
        protected = $ownerTrusted -and $effectiveWriteBits -eq 0 -and $foreignWriteRules.Count -eq 0
    }
}

function Get-RevAgentProtectedPathChainAttestation {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$TrustedRoot,
        [ValidateSet('File', 'Directory')][string]$LeafKind = 'File'
    )

    $fullPath = Get-RevAgentFullPath $Path
    $fullRoot = (Get-RevAgentFullPath $TrustedRoot).TrimEnd('\')
    if (-not (Test-RevAgentPathWithinRoot -Path $fullPath -Root $fullRoot)) {
        throw "Protected path is outside its trusted root. path=$fullPath root=$fullRoot"
    }
    [void](Assert-RevAgentSafeUserPath -Path $fullPath -AllowedRoot $fullRoot -LeafKind $LeafKind)
    $chain = [System.Collections.Generic.List[object]]::new()
    $relative = $fullPath.Substring($fullRoot.Length).TrimStart('\')
    $cursor = $fullRoot
    $chain.Add((Get-RevAgentProtectedPathAclStatus -Path $cursor))
    foreach ($segment in @($relative -split '\\' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $cursor = Join-Path $cursor $segment
        $chain.Add((Get-RevAgentProtectedPathAclStatus -Path $cursor))
    }
    $unprotected = @($chain | Where-Object { -not $_.protected })
    return [pscustomobject][ordered]@{
        path = $fullPath
        trustedRoot = $fullRoot
        protected = $unprotected.Count -eq 0
        chain = @($chain)
        unprotectedPaths = @($unprotected | ForEach-Object path)
    }
}

function Get-RevAgentCodexCandidateOrigin {
    param([string]$Path, [string]$ExplicitPath, [string]$LocalAppData)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath) -and [string]::Equals((Get-RevAgentFullPath $Path), (Get-RevAgentFullPath $ExplicitPath), [System.StringComparison]::OrdinalIgnoreCase)) { return 'explicit' }
    if ($Path -match '(?i)\\npm\\codex\.cmd$|\\AppData\\Roaming\\npm\\codex\.cmd$') { return 'npm-shim' }
    if ($Path -match '(?i)\\OpenAI\\Codex\\bin\\[0-9a-f]{8,}\\codex\.exe$') { return 'desktop-bundled-hashed' }
    if ($Path -match '(?i)\\OpenAI\\Codex\\bin\\codex\.exe$') { return 'desktop-legacy-root' }
    if ($Path -match '(?i)\\Programs\\OpenAI\\Codex\\bin\\codex\.exe$') { return 'official-standalone' }
    if (-not [string]::IsNullOrWhiteSpace($script:RevAgentOsProgramFiles) -and $Path.StartsWith($script:RevAgentOsProgramFiles, [System.StringComparison]::OrdinalIgnoreCase)) { return 'program-files' }
    return 'path'
}

function Get-RevAgentCodexExecutableAttestation {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot
    )

    $fullPath = Get-RevAgentFullPath $Path
    $safe = $false
    $safetyError = ''
    try {
        [void](Assert-RevAgentSafeUserPath -Path $fullPath -AllowedRoot $AllowedRoot -LeafKind File)
        $safe = $true
    }
    catch { $safetyError = $_.Exception.Message }
    $signature = if ($safe) { Get-RevAgentSignatureStatus -Path $fullPath } else { [pscustomobject]@{ status = 'NotChecked'; subject = ''; openAi = $false; openJs = $false } }
    return [pscustomobject][ordered]@{
        path = $fullPath
        allowedRoot = Get-RevAgentFullPath $AllowedRoot
        safe = $safe
        safetyError = $safetyError
        linkCount = if ($safe) { Get-RevAgentFileLinkCount -Path $fullPath } else { 0 }
        fileIdentity = if ($safe) { Get-RevAgentFileIdentity -Path $fullPath } else { '' }
        sha256 = if ($safe) { Get-RevAgentFileSha256 -Path $fullPath } else { '' }
        signatureStatus = [string]$signature.status
        signerSubject = [string]$signature.subject
        openAiSigned = [bool]$signature.openAi
    }
}

function Assert-RevAgentCodexExecutableUnchanged {
    param([Parameter(Mandatory = $true)][object]$Candidate)

    $current = Get-RevAgentCodexExecutableAttestation -Path $Candidate.path -AllowedRoot $Candidate.attestationRoot
    if (-not $current.safe -or -not $current.openAiSigned -or $current.linkCount -ne 1 -or
        -not [string]::Equals([string]$current.fileIdentity, [string]$Candidate.fileIdentity, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$current.sha256, [string]$Candidate.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Codex CLI identity changed after attestation; refusing execution. path=$($Candidate.path) safety=$($current.safetyError)"
    }
    return $current
}

function ConvertTo-RevAgentCodexSemanticVersion {
    param([AllowEmptyString()][string]$VersionText)

    if ($VersionText -notmatch '(?i)^\s*codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?') {
        return [pscustomobject][ordered]@{ valid = $false; major = -1; minor = -1; patch = -1; prerelease = ''; prereleaseNumber = -1; isPrerelease = $true }
    }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    $patch = [int]$Matches[3]
    $prerelease = [string]$Matches[4]
    $prereleaseNumber = -1
    if ($prerelease -match '(?:^|\.)(\d+)$') { $prereleaseNumber = [int]$Matches[1] }
    return [pscustomobject][ordered]@{
        valid = $true
        major = $major
        minor = $minor
        patch = $patch
        prerelease = $prerelease
        prereleaseNumber = $prereleaseNumber
        isPrerelease = -not [string]::IsNullOrWhiteSpace($prerelease)
    }
}

function Test-RevAgentJsonText {
    param([AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    try {
        [void]($Text | ConvertFrom-Json -ErrorAction Stop)
        return $true
    }
    catch { return $false }
}

function Select-RevAgentCodexCandidate {
    param([Parameter(Mandatory = $true)][object[]]$Candidates)

    $best = $null
    foreach ($candidate in @($Candidates | Where-Object { [bool]$_.ready })) {
        if ($null -eq $best) { $best = $candidate; continue }
        $comparison = Compare-RevAgentCodexSemanticVersion -Left $candidate -Right $best
        if ($comparison -gt 0) { $best = $candidate; continue }
        if ($comparison -lt 0) { continue }
        if ([bool]$candidate.explicitOverride -and -not [bool]$best.explicitOverride) { $best = $candidate; continue }
        if ([bool]$candidate.explicitOverride -ne [bool]$best.explicitOverride) { continue }
        if ([int]$candidate.score -gt [int]$best.score) { $best = $candidate; continue }
        if ([int]$candidate.score -lt [int]$best.score) { continue }
        if ([string]::Compare([string]$candidate.path, [string]$best.path, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { $best = $candidate }
    }
    if ($null -ne $best) { return $best }
}

function Compare-RevAgentCodexSemanticVersion {
    param([Parameter(Mandatory = $true)][object]$Left, [Parameter(Mandatory = $true)][object]$Right)

    foreach ($property in @('versionMajor', 'versionMinor', 'versionPatch')) {
        $leftValue = [int]$Left.$property
        $rightValue = [int]$Right.$property
        if ($leftValue -gt $rightValue) { return 1 }
        if ($leftValue -lt $rightValue) { return -1 }
    }
    $leftPre = [string]$Left.versionPrerelease
    $rightPre = [string]$Right.versionPrerelease
    if ([string]::IsNullOrWhiteSpace($leftPre) -and -not [string]::IsNullOrWhiteSpace($rightPre)) { return 1 }
    if (-not [string]::IsNullOrWhiteSpace($leftPre) -and [string]::IsNullOrWhiteSpace($rightPre)) { return -1 }
    if ([string]::IsNullOrWhiteSpace($leftPre)) { return 0 }
    $leftParts = @($leftPre -split '\.')
    $rightParts = @($rightPre -split '\.')
    $count = [Math]::Max($leftParts.Count, $rightParts.Count)
    for ($index = 0; $index -lt $count; $index++) {
        if ($index -ge $leftParts.Count) { return -1 }
        if ($index -ge $rightParts.Count) { return 1 }
        $leftNumber = 0L; $rightNumber = 0L
        $leftNumeric = [long]::TryParse($leftParts[$index], [ref]$leftNumber)
        $rightNumeric = [long]::TryParse($rightParts[$index], [ref]$rightNumber)
        if ($leftNumeric -and $rightNumeric) {
            if ($leftNumber -gt $rightNumber) { return 1 }
            if ($leftNumber -lt $rightNumber) { return -1 }
            continue
        }
        if ($leftNumeric -and -not $rightNumeric) { return -1 }
        if (-not $leftNumeric -and $rightNumeric) { return 1 }
        $identifierComparison = [string]::Compare($leftParts[$index], $rightParts[$index], [System.StringComparison]::Ordinal)
        if ($identifierComparison -gt 0) { return 1 }
        if ($identifierComparison -lt 0) { return -1 }
    }
    return 0
}

function Get-RevAgentActiveUnifiedCodexCliAttestation {
    [CmdletBinding()]
    param([string]$LocalAppData = ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)))

    $result = [ordered]@{
        available = $false; success = $false; reason = 'active_package_not_found'
        packageName = ''; packageVersion = ''; packageFullName = ''; installLocation = ''
        packageCliPath = ''; packageCliSha256 = ''; userCliPath = ''; candidates = @()
    }
    try {
        $packages = @(Appx\Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop)
        if ($packages.Count -eq 0) { return [pscustomobject]$result }
        $package = @($packages | Sort-Object -Property @{ Expression = { try { [version]$_.Version } catch { [version]'0.0.0.0' } }; Descending = $true } | Select-Object -First 1)[0]
        $result.available = $true
        $result.packageName = [string]$package.Name
        $result.packageVersion = [string]$package.Version
        $result.packageFullName = [string]$package.PackageFullName
        $result.installLocation = Get-RevAgentFullPath ([string]$package.InstallLocation)
        $windowsAppsRoot = Join-Path $script:RevAgentOsProgramFiles 'WindowsApps'
        if (-not (Test-RevAgentPathWithinRoot -Path $result.installLocation -Root $windowsAppsRoot)) {
            $result.reason = 'package_install_location_not_windowsapps'
            return [pscustomobject]$result
        }
        $packageCli = Join-Path $result.installLocation 'app\resources\codex.exe'
        if (-not (Test-Path -LiteralPath $packageCli -PathType Leaf)) {
            $result.reason = 'package_cli_missing'
            return [pscustomobject]$result
        }
        $packageAttestation = Get-RevAgentCodexExecutableAttestation -Path $packageCli -AllowedRoot $result.installLocation
        if (-not $packageAttestation.safe -or -not $packageAttestation.openAiSigned -or $packageAttestation.linkCount -ne 1) {
            $result.reason = 'package_cli_attestation_failed'
            return [pscustomobject]$result
        }
        $result.packageCliPath = $packageAttestation.path
        $result.packageCliSha256 = $packageAttestation.sha256

        if ([string]::IsNullOrWhiteSpace($LocalAppData) -or -not (Test-Path -LiteralPath $LocalAppData -PathType Container)) {
            $result.reason = 'local_app_data_missing'
            return [pscustomobject]$result
        }
        $localRoot = Get-RevAgentFullPath $LocalAppData
        $bundleRoot = Join-Path $localRoot 'OpenAI\Codex\bin'
        if (-not (Test-Path -LiteralPath $bundleRoot -PathType Container)) {
            $result.reason = 'unified_user_bundle_root_missing'
            return [pscustomobject]$result
        }
        [void](Assert-RevAgentSafeUserPath -Path $bundleRoot -AllowedRoot $localRoot -LeafKind Directory)
        $rows = [System.Collections.Generic.List[object]]::new()
        foreach ($directory in @(Get-ChildItem -LiteralPath $bundleRoot -Directory -Force -ErrorAction Stop | Where-Object { $_.Name -match '^[0-9a-fA-F]{16}$' })) {
            $candidatePath = Join-Path $directory.FullName 'codex.exe'
            if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) { continue }
            $candidateAttestation = Get-RevAgentCodexExecutableAttestation -Path $candidatePath -AllowedRoot $localRoot
            $hashMatches = $candidateAttestation.safe -and [string]::Equals([string]$candidateAttestation.sha256, [string]$packageAttestation.sha256, [System.StringComparison]::OrdinalIgnoreCase)
            $matches = $hashMatches -and $candidateAttestation.openAiSigned -and $candidateAttestation.linkCount -eq 1
            $rows.Add([pscustomobject][ordered]@{
                path = $candidateAttestation.path; safe = $candidateAttestation.safe; signatureStatus = $candidateAttestation.signatureStatus
                signerSubject = $candidateAttestation.signerSubject; linkCount = $candidateAttestation.linkCount
                sha256 = $candidateAttestation.sha256; hashMatchesActivePackage = $hashMatches; matches = $matches
                safetyError = $candidateAttestation.safetyError
            })
        }
        $result.candidates = @($rows)
        $matches = @($rows | Where-Object matches)
        if ($matches.Count -ne 1) {
            $result.reason = if ($matches.Count -eq 0) { 'no_user_bundle_matches_active_package' } else { 'ambiguous_user_bundles_match_active_package' }
            return [pscustomobject]$result
        }
        $result.userCliPath = [string]$matches[0].path
        $result.success = $true
        $result.reason = 'attested'
        return [pscustomobject]$result
    }
    catch {
        $result.reason = 'attestation_error: ' + $_.Exception.Message
        return [pscustomobject]$result
    }
}

function Resolve-RevAgentCodexCli {
    [CmdletBinding()]
    param(
        [string]$ExplicitPath = "",
        [Parameter(Mandatory = $true)][string]$CodexHome,
        [string]$LocalAppData = ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData))
    )

    if (Test-RevAgentProcessElevated) { throw "Codex CLI discovery/execution is forbidden in an elevated process." }
    if ([string]::IsNullOrWhiteSpace($LocalAppData) -or -not (Test-Path -LiteralPath $LocalAppData -PathType Container)) {
        throw "LocalAppData must be an existing directory for isolated Codex CLI probing."
    }
    $localRoot = Get-RevAgentFullPath $LocalAppData
    [void](Assert-RevAgentSafeUserPath -Path $localRoot -AllowedRoot $localRoot -LeafKind Directory)
    $activeUnified = Get-RevAgentActiveUnifiedCodexCliAttestation -LocalAppData $localRoot
    $candidateInputs = [System.Collections.Generic.List[object]]::new()
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) { $candidateInputs.Add([pscustomobject]@{ path = $ExplicitPath; explicit = $true }) }
    foreach ($command in @(Get-Command codex -All -ErrorAction SilentlyContinue)) {
        if ($command.Path) { $candidateInputs.Add([pscustomobject]@{ path = [string]$command.Path; explicit = $false }) }
    }
    foreach ($canonical in @((Join-Path $localRoot 'Programs\OpenAI\Codex\bin\codex.exe'), (Join-Path $localRoot 'OpenAI\Codex\bin\codex.exe'))) {
        $candidateInputs.Add([pscustomobject]@{ path = $canonical; explicit = $false })
    }
    if ($activeUnified.success) {
        $candidateInputs.Add([pscustomobject]@{ path = $activeUnified.userCliPath; explicit = $false })
    }

    $results = [System.Collections.Generic.List[object]]::new()
    $deduplicated = @($candidateInputs | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.path) } | ForEach-Object {
        [pscustomobject]@{ path = Get-RevAgentFullPath ([string]$_.path); explicit = [bool]$_.explicit }
    } | Group-Object { $_.path.ToLowerInvariant() } | ForEach-Object {
        [pscustomobject]@{ path = [string]$_.Group[0].path; explicit = @($_.Group | Where-Object explicit).Count -gt 0 }
    })
    foreach ($inputCandidate in $deduplicated) {
        $path = [string]$inputCandidate.path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $origin = Get-RevAgentCodexCandidateOrigin -Path $path -ExplicitPath $ExplicitPath -LocalAppData $LocalAppData
        $systemRoot = if (Test-RevAgentPathWithinRoot -Path $path -Root $script:RevAgentOsProgramFiles) { $script:RevAgentOsProgramFiles } elseif (-not [string]::IsNullOrWhiteSpace($script:RevAgentOsProgramFilesX86) -and (Test-RevAgentPathWithinRoot -Path $path -Root $script:RevAgentOsProgramFilesX86)) { $script:RevAgentOsProgramFilesX86 } else { '' }
        $activeBundleMatch = $activeUnified.success -and [string]::Equals($path, [string]$activeUnified.userCliPath, [System.StringComparison]::OrdinalIgnoreCase)
        $attestationRoot = if ($activeBundleMatch) { $localRoot } elseif (-not [string]::IsNullOrWhiteSpace($systemRoot)) { $systemRoot } else { Split-Path -Parent $path }
        $attestation = Get-RevAgentCodexExecutableAttestation -Path $path -AllowedRoot $attestationRoot
        $originAttested = $attestation.safe -and $attestation.openAiSigned -and $attestation.linkCount -eq 1 -and (
            (-not [string]::IsNullOrWhiteSpace($systemRoot)) -or
            ($activeBundleMatch -and [string]::Equals([string]$attestation.sha256, [string]$activeUnified.packageCliSha256, [System.StringComparison]::OrdinalIgnoreCase))
        )
        if ($activeBundleMatch) { $origin = 'active-unified-user-bundle' }
        $baseScore = switch ($origin) {
            'program-files' { 115 }
            'active-unified-user-bundle' { 130 }
            default { 10 }
        }
        $results.Add([pscustomobject][ordered]@{
            path = $path; origin = $origin; explicitOverride = [bool]$inputCandidate.explicit; originAttested = $originAttested
            attestationRoot = $attestation.allowedRoot; signatureStatus = $attestation.signatureStatus; signerSubject = $attestation.signerSubject
            linkCount = $attestation.linkCount; fileIdentity = $attestation.fileIdentity; sha256 = $attestation.sha256
            version = ''; versionProbeExitCode = -1; capabilityProbeExitCode = -1; capabilityJsonValid = $false
            capabilityError = if ($originAttested) { 'not probed' } else { 'candidate origin was not attested; not executed' }
            trusted = $originAttested; ready = $false; score = $baseScore + $(if ($attestation.openAiSigned) { 10 } else { 0 })
            versionMajor = -1; versionMinor = -1; versionPatch = -1; versionIsPrerelease = $true; versionPrerelease = ''; versionPrereleaseNumber = -1
            actualConfigCapabilityProbeExitCode = -1; actualConfigCapabilityJsonValid = $false; actualConfigCapabilityError = ''
        })
    }

    $probeParent = Join-Path $localRoot 'revAgent\codex-cli-probe'
    $probeHome = Join-Path $probeParent ([Guid]::NewGuid().ToString('N'))
    [void](New-RevAgentSafeUserDirectory -Path $probeHome -AllowedRoot $localRoot)
    try {
        foreach ($candidate in @($results | Where-Object originAttested)) {
            try {
                [void](Assert-RevAgentCodexExecutableUnchanged -Candidate $candidate)
                $version = Invoke-RevAgentProcessProbe -FilePath $candidate.path -Arguments @('--version') -Environment @{ CODEX_HOME = $probeHome }
                $candidate.version = $version.stdout
                $candidate.versionProbeExitCode = $version.exitCode
                $semantic = ConvertTo-RevAgentCodexSemanticVersion -VersionText $version.stdout
                $candidate.versionMajor = $semantic.major; $candidate.versionMinor = $semantic.minor; $candidate.versionPatch = $semantic.patch
                $candidate.versionIsPrerelease = $semantic.isPrerelease; $candidate.versionPrerelease = $semantic.prerelease; $candidate.versionPrereleaseNumber = $semantic.prereleaseNumber
                if ($version.exitCode -ne 0 -or -not $semantic.valid) {
                    $candidate.capabilityError = ('version probe failed: ' + $version.stderr).Trim()
                    continue
                }
                [void](Assert-RevAgentCodexExecutableUnchanged -Candidate $candidate)
                $capability = Invoke-RevAgentProcessProbe -FilePath $candidate.path -Arguments @('mcp', 'list', '--json') -Environment @{ CODEX_HOME = $probeHome }
                $candidate.capabilityProbeExitCode = $capability.exitCode
                $candidate.capabilityJsonValid = $capability.exitCode -eq 0 -and (Test-RevAgentJsonText -Text $capability.stdout)
                $candidate.capabilityError = if ($candidate.capabilityJsonValid) { '' } else { ($capability.stderr + ' ' + $capability.stdout).Trim() }
                $candidate.ready = $semantic.valid -and $candidate.capabilityJsonValid
            }
            catch { $candidate.capabilityError = $_.Exception.Message; $candidate.ready = $false }
        }
    }
    finally {
        if (Test-Path -LiteralPath $probeHome) {
            [void](Assert-RevAgentSafeUserPath -Path $probeHome -AllowedRoot $localRoot -LeafKind Directory)
            Remove-Item -LiteralPath $probeHome -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    $selected = @(Select-RevAgentCodexCandidate -Candidates @($results))
    if ($selected.Count -eq 0) {
        $details = @($results | ForEach-Object { "$($_.path) origin=$($_.origin) originAttested=$($_.originAttested) signature=$($_.signatureStatus) versionExit=$($_.versionProbeExitCode) capabilityExit=$($_.capabilityProbeExitCode)" }) -join '; '
        throw "No Codex CLI candidate passed origin, signer/version, and mcp capability probes. $details"
    }
    $selectedCandidate = $selected[0]
    [void](Assert-RevAgentCodexExecutableUnchanged -Candidate $selectedCandidate)
    $actualCapability = Invoke-RevAgentProcessProbe -FilePath $selectedCandidate.path -Arguments @('mcp', 'list', '--json') -Environment @{ CODEX_HOME = $CodexHome }
    $selectedCandidate.actualConfigCapabilityProbeExitCode = $actualCapability.exitCode
    $selectedCandidate.actualConfigCapabilityJsonValid = $actualCapability.exitCode -eq 0 -and (Test-RevAgentJsonText -Text $actualCapability.stdout)
    $selectedCandidate.actualConfigCapabilityError = if ($selectedCandidate.actualConfigCapabilityJsonValid) { '' } else { ($actualCapability.stderr + ' ' + $actualCapability.stdout).Trim() }
    if (-not $selectedCandidate.actualConfigCapabilityJsonValid) {
        throw "The newest attested Codex CLI passed isolated discovery but rejected the selected CODEX_HOME; refusing silent downgrade or config mutation. path=$($selectedCandidate.path) version=$($selectedCandidate.version) error=$($selectedCandidate.actualConfigCapabilityError)"
    }
    return [pscustomobject][ordered]@{ selected = $selectedCandidate; candidates = @($results); activeUnifiedAttestation = $activeUnified; discoveryCodexHome = 'isolated-disposable'; actualConfigProbe = 'passed' }
}

function Resolve-RevAgentNodeRuntime {
    [CmdletBinding()]
    param([string]$ExplicitPath = "")

    if (Test-RevAgentProcessElevated) { throw "Node discovery/execution for Codex integration is forbidden in an elevated process." }
    $candidates = [System.Collections.Generic.List[object]]::new()
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) { $candidates.Add([pscustomobject]@{ path = $ExplicitPath; origin = 'explicit'; explicit = $true }) }
    $canonicalPaths = [System.Collections.Generic.List[object]]::new()
    foreach ($root in @($script:RevAgentOsProgramFiles, $script:RevAgentOsProgramFilesX86)) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $canonical = Join-Path $root 'nodejs\node.exe'
        $canonicalPaths.Add([pscustomobject]@{ path = (Get-RevAgentFullPath $canonical); root = (Get-RevAgentFullPath $root) })
        $candidates.Add([pscustomobject]@{ path = $canonical; origin = 'canonical-program-files-node'; explicit = $false })
    }

    $results = [System.Collections.Generic.List[object]]::new()
    foreach ($candidate in @($candidates | Group-Object { (Get-RevAgentFullPath $_.path).ToLowerInvariant() } | ForEach-Object {
        [pscustomobject]@{ path = $_.Group[0].path; origin = $_.Group[0].origin; explicit = @($_.Group | Where-Object explicit).Count -gt 0 }
    })) {
        $path = Get-RevAgentFullPath $candidate.path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $canonicalMatch = @($canonicalPaths | Where-Object { [string]::Equals($_.path, $path, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1)
        $exactCanonical = $canonicalMatch.Count -eq 1
        $trustedRoot = if ($exactCanonical) { [string]$canonicalMatch[0].root } else { Split-Path -Parent $path }
        $safe = $false
        $safetyError = ''
        $protection = $null
        try {
            [void](Assert-RevAgentSafeUserPath -Path $path -AllowedRoot $trustedRoot -LeafKind File)
            if ($exactCanonical) {
                $protection = Get-RevAgentProtectedPathChainAttestation -Path $path -TrustedRoot $trustedRoot -LeafKind File
                if (-not $protection.protected) { throw "Node path chain is owned or writable outside the trusted machine boundary: $($protection.unprotectedPaths -join ', ')" }
            }
            $safe = $true
        }
        catch { $safetyError = $_.Exception.Message }
        $signature = Get-RevAgentSignatureStatus -Path $path
        $eligibleForExecution = $exactCanonical -and $safe -and [bool]$signature.openJs
        $row = [pscustomobject][ordered]@{
            path = $path; origin = if ($exactCanonical) { 'canonical-program-files-node' } else { [string]$candidate.origin }
            explicitOverride = [bool]$candidate.explicit; exactCanonical = $exactCanonical; originAttested = $eligibleForExecution
            attestationRoot = $trustedRoot; signatureStatus = $signature.status; signerSubject = $signature.subject
            linkCount = if ($safe) { Get-RevAgentFileLinkCount -Path $path } else { 0 }
            fileIdentity = if ($safe) { Get-RevAgentFileIdentity -Path $path } else { '' }
            sha256 = if ($safe) { Get-RevAgentFileSha256 -Path $path } else { '' }
            protectedPath = $null -ne $protection -and [bool]$protection.protected
            protection = $protection; safetyError = $safetyError
            version = ''; major = 0; versionProbeExitCode = -1; systemManaged = $exactCanonical -and $safe
            capabilityProbeExitCode = -1; modulesAbi = ''; napiVersion = ''; platform = ''; architecture = ''; ready = $false
            score = if ($exactCanonical) { 130 } else { 0 }
        }
        $probe = if ($eligibleForExecution) {
            [void](Assert-RevAgentNodeExecutableUnchanged -Candidate $row)
            Invoke-RevAgentProcessProbe -FilePath $path -Arguments @('--version')
        } else { [pscustomobject]@{ exitCode = -1; timedOut = $false; stdout = ''; stderr = 'non-system or untrusted candidate was not executed' } }
        $capabilityProbe = if ($eligibleForExecution) {
            [void](Assert-RevAgentNodeExecutableUnchanged -Candidate $row)
            Invoke-RevAgentProcessProbe -FilePath $path -Arguments @('-e', 'process.stdout.write(JSON.stringify({node:process.versions.node,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch}))')
        } else { [pscustomobject]@{ exitCode = -1; timedOut = $false; stdout = ''; stderr = 'non-system or untrusted candidate was not executed' } }
        $capability = $null
        try { if ($capabilityProbe.exitCode -eq 0) { $capability = $capabilityProbe.stdout | ConvertFrom-Json } } catch {}
        $major = 0
        if ($probe.stdout -match '^v?(\d+)\.') { $major = [int]$Matches[1] }
        $abiReady = $null -ne $capability -and [string]$capability.platform -eq 'win32' -and
            [string]$capability.arch -in @('x64', 'arm64') -and -not [string]::IsNullOrWhiteSpace([string]$capability.modules) -and
            [int]$capability.napi -ge 8
        $row.version = $probe.stdout; $row.major = $major; $row.versionProbeExitCode = $probe.exitCode
        $row.capabilityProbeExitCode = $capabilityProbe.exitCode; $row.modulesAbi = if ($capability) { [string]$capability.modules } else { '' }
        $row.napiVersion = if ($capability) { [string]$capability.napi } else { '' }; $row.platform = if ($capability) { [string]$capability.platform } else { '' }
        $row.architecture = if ($capability) { [string]$capability.arch } else { '' }
        $row.ready = $eligibleForExecution -and $probe.exitCode -eq 0 -and $major -ge 20 -and $abiReady
        $results.Add($row)
    }
    $selected = @($results | Where-Object ready | Sort-Object -Property @{ Expression = 'major'; Descending = $true }, @{ Expression = 'explicitOverride'; Descending = $true }, @{ Expression = 'path'; Descending = $false } | Select-Object -First 1)
    if ($selected.Count -eq 0) { throw "No trusted Node.js 20+ candidate passed origin, Authenticode, version, and capability probes." }
    return [pscustomobject][ordered]@{ selected = $selected[0]; candidates = @($results) }
}

function Assert-RevAgentNodeExecutableUnchanged {
    param([Parameter(Mandatory = $true)][object]$Candidate)

    if (-not [bool]$Candidate.exactCanonical -or -not [bool]$Candidate.originAttested) {
        throw "Node candidate does not carry an exact canonical origin attestation: $($Candidate.path)"
    }
    [void](Assert-RevAgentSafeUserPath -Path $Candidate.path -AllowedRoot $Candidate.attestationRoot -LeafKind File)
    $protection = Get-RevAgentProtectedPathChainAttestation -Path $Candidate.path -TrustedRoot $Candidate.attestationRoot -LeafKind File
    $signature = Get-RevAgentSignatureStatus -Path $Candidate.path
    $identity = Get-RevAgentFileIdentity -Path $Candidate.path
    $sha256 = Get-RevAgentFileSha256 -Path $Candidate.path
    $linkCount = Get-RevAgentFileLinkCount -Path $Candidate.path
    if (-not $protection.protected -or -not $signature.openJs -or $linkCount -ne 1 -or
        -not [string]::Equals([string]$identity, [string]$Candidate.fileIdentity, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$sha256, [string]$Candidate.sha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Node executable identity/protection changed after attestation; refusing execution. path=$($Candidate.path)"
    }
    return [pscustomobject][ordered]@{ path = $Candidate.path; identity = $identity; sha256 = $sha256; linkCount = $linkCount; protection = $protection }
}

function Get-RevAgentProtectedMachineFileAttestation {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [string]$ExpectedSha256 = ''
    )

    $fullRoot = Get-RevAgentFullPath $InstallRoot
    $fullPath = Get-RevAgentFullPath $Path
    $protection = Get-RevAgentProtectedPathChainAttestation -Path $fullPath -TrustedRoot $fullRoot -LeafKind File
    if (-not $protection.protected) {
        throw "Machine execution path is not protected from the current user. path=$fullPath unprotected=$($protection.unprotectedPaths -join ',')"
    }
    $sha256 = Get-RevAgentFileSha256 -Path $fullPath
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256) -and
        -not [string]::Equals($sha256, $ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Machine execution file does not match installed release evidence. path=$fullPath expected=$ExpectedSha256 actual=$sha256"
    }
    return [pscustomobject][ordered]@{
        path = $fullPath
        installRoot = $fullRoot
        expectedSha256 = $ExpectedSha256
        sha256 = $sha256
        fileIdentity = Get-RevAgentFileIdentity -Path $fullPath
        linkCount = Get-RevAgentFileLinkCount -Path $fullPath
        protection = $protection
        protected = $true
    }
}

function Assert-RevAgentProtectedMachineFileUnchanged {
    param([Parameter(Mandatory = $true)][object]$Attestation)

    $current = Get-RevAgentProtectedMachineFileAttestation -Path $Attestation.path -InstallRoot $Attestation.installRoot -ExpectedSha256 $Attestation.sha256
    if ($current.linkCount -ne 1 -or
        -not [string]::Equals([string]$current.fileIdentity, [string]$Attestation.fileIdentity, [StringComparison]::Ordinal)) {
        throw "Machine execution file identity changed after release attestation. path=$($Attestation.path)"
    }
    return $current
}

function Get-RevAgentMcpServerEntrypointAttestations {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$RuntimeServerPath,
        [Parameter(Mandatory = $true)][string]$DocsServerPath
    )

    $root = Get-RevAgentFullPath $InstallRoot
    $statePath = Join-Path $root 'updater\installed.json'
    $stateAttestation = Get-RevAgentProtectedMachineFileAttestation -Path $statePath -InstallRoot $root
    $state = [IO.File]::ReadAllText($stateAttestation.path) | ConvertFrom-Json -ErrorAction Stop
    $componentsProperty = Get-RevAgentObjectPropertyInfo -InputObject $state -Name 'components'
    if ($null -eq $componentsProperty -or $null -eq $componentsProperty.Value) {
        throw "Installed release state does not contain component evidence: $statePath"
    }
    $componentDefinitions = @(
        [pscustomobject]@{ label = 'runtime'; key = 'runtimeBundle'; relativePath = 'installer\runtime-mcp-server\build\index.js'; entryPath = $RuntimeServerPath },
        [pscustomobject]@{ label = 'docs'; key = 'docsServerBundle'; relativePath = 'installer\revit-api-docs-mcp\build\index.js'; entryPath = $DocsServerPath }
    )
    $rows = [System.Collections.Generic.List[object]]::new()
    $packageRoot = Join-Path $root 'package'
    foreach ($definition in $componentDefinitions) {
        $componentProperty = Get-RevAgentObjectPropertyInfo -InputObject $componentsProperty.Value -Name $definition.key
        if ($null -eq $componentProperty -or $null -eq $componentProperty.Value) {
            throw "Installed release state is missing MCP component evidence: $($definition.key)"
        }
        $component = $componentProperty.Value
        $componentPath = [string]$component.path
        $expectedSha256 = [string]$component.sha256
        if (-not [string]::Equals($componentPath, $definition.relativePath, [StringComparison]::OrdinalIgnoreCase) -or
            $expectedSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
            throw "Installed MCP component evidence is malformed. component=$($definition.key) path=$componentPath sha256=$expectedSha256"
        }
        $sourcePath = Join-Path $packageRoot $componentPath
        if (-not (Test-RevAgentPathWithinRoot -Path $sourcePath -Root $packageRoot)) {
            throw "Installed MCP component source escapes the package root: $sourcePath"
        }
        $sourceAttestation = Get-RevAgentProtectedMachineFileAttestation -Path $sourcePath -InstallRoot $root -ExpectedSha256 $expectedSha256
        $entryAttestation = Get-RevAgentProtectedMachineFileAttestation -Path $definition.entryPath -InstallRoot $root -ExpectedSha256 $expectedSha256
        $rows.Add([pscustomobject][ordered]@{
            label = $definition.label; componentKey = $definition.key; expectedSha256 = $expectedSha256
            source = $sourceAttestation; entrypoint = $entryAttestation
        })
    }
    return [pscustomobject][ordered]@{
        success = $true
        statePath = $statePath
        stateVersion = [string]$state.version
        stateAttestation = $stateAttestation
        runtime = @($rows | Where-Object label -eq 'runtime')[0]
        docs = @($rows | Where-Object label -eq 'docs')[0]
    }
}

function ConvertTo-RevAgentTomlString {
    param([AllowEmptyString()][string]$Value)
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Set-RevAgentMcpSectionText {
    param([string]$Content, [string]$Name, [string]$Command, [string[]]$Arguments)
    $pattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($Name))\]\s*.*?(?=^\[|\z)"
    $argsText = (@($Arguments) | ForEach-Object { ConvertTo-RevAgentTomlString $_ }) -join ', '
    $block = "[mcp_servers.$Name]`r`ncommand = $(ConvertTo-RevAgentTomlString $Command)`r`nargs = [$argsText]`r`n"
    if ($Content -match $pattern) { return [regex]::Replace($Content, $pattern, $block) }
    $prefix = if ([string]::IsNullOrWhiteSpace($Content)) { '' } else { $Content.TrimEnd() + "`r`n`r`n" }
    return $prefix + $block
}

function Set-RevAgentCodexMcpConfigAtomic {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$CodexHome,
        [Parameter(Mandatory = $true)][string]$GuardRoot,
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string]$RuntimeServerPath,
        [Parameter(Mandatory = $true)][string]$DocsServerPath,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [int]$LockTimeoutSeconds = 20,
        [scriptblock]$BeforeDestinationCommit,
        [scriptblock]$BeforeAtomicCommit,
        [scriptblock]$BeforeRecoveryCommit
    )

    $configPath = Join-Path $CodexHome 'config.toml'
    $lockPath = Join-Path $CodexHome '.revagent-config.lock'
    [void](Assert-RevAgentSafeUserPath -Path $configPath -AllowedRoot $GuardRoot -LeafKind File -AllowMissing)
    # Do not open an existing lock path just to count links before acquiring it:
    # another healthy updater may already hold the path with FileShare.None.
    # Reparse components are still rejected here; the hard-link count is read
    # from our exclusive handle immediately after lock acquisition below.
    [void](Assert-RevAgentSafeUserPath -Path $lockPath -AllowedRoot $GuardRoot -LeafKind File -AllowMissing -AllowHardLinkedLeaf)
    $deadline = [DateTime]::UtcNow.AddSeconds($LockTimeoutSeconds)
    $lock = $null
    while ($null -eq $lock -and [DateTime]::UtcNow -lt $deadline) {
        try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { Start-Sleep -Milliseconds 200 }
    }
    if ($null -eq $lock) { throw "Timed out waiting for the Codex config lock: $lockPath" }

    $lockLinkCount = [int][RevAgent.NativeFileInfo]::GetLinkCountFromHandle($lock.SafeFileHandle)
    if ($lockLinkCount -ne 1) {
        $lock.Dispose()
        $lock = $null
        throw "Refusing Codex config lock with hard-link count ${lockLinkCount}: $lockPath"
    }

    $tempPath = Join-Path $CodexHome ('.config.toml.revagent-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $backupPath = Join-Path $CodexHome ('.config.toml.revagent-' + [Guid]::NewGuid().ToString('N') + '.bak')
    $backupSafeToRemove = $false
    try {
        [void](Assert-RevAgentSafeUserPath -Path $configPath -AllowedRoot $GuardRoot -LeafKind File -AllowMissing)
        $beforeHash = Get-RevAgentFileSha256 -Path $configPath
        $beforeIdentity = Get-RevAgentFileIdentity -Path $configPath
        if (-not [string]::Equals($beforeHash, $ExpectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Codex config changed after it was inspected. expected=$ExpectedSha256 actual=$beforeHash"
        }
        $content = if ($beforeHash -eq 'MISSING') { '' } else { [IO.File]::ReadAllText($configPath) }
        foreach ($legacyName in @('revit-mcp', 'revit-api-docs')) {
            $legacyPattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($legacyName))\]\s*.*?(?=^\[|\z)"
            $content = [regex]::Replace($content, $legacyPattern, '')
        }
        $content = Set-RevAgentMcpSectionText -Content $content -Name 'revAgent' -Command $NodePath -Arguments @($RuntimeServerPath)
        $content = Set-RevAgentMcpSectionText -Content $content -Name 'revAgent-api-docs' -Command $NodePath -Arguments @($DocsServerPath)
        $content = Normalize-RevitMcpCodexServiceTier -Content $content
        $content = Set-RevitMcpTomlScalar -Content $content -Section 'features' -Key 'memories' -Value 'true'
        $content = Set-RevitMcpTomlScalar -Content $content -Section 'features' -Key 'chronicle' -Value 'false'
        $content = Set-RevitMcpTomlScalar -Content $content -Section 'memories' -Key 'disable_on_external_context' -Value 'true'
        $content = Set-RevitMcpTomlScalar -Content $content -Section 'memories' -Key 'generate_memories' -Value 'true'
        $content = Set-RevitMcpTomlScalar -Content $content -Section 'memories' -Key 'use_memories' -Value 'true'
        $content = [regex]::Replace($content, '(\r?\n){3,}', "`r`n`r`n").TrimEnd() + "`r`n"

        $stream = [IO.File]::Open($tempPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = $script:RevAgentUtf8NoBom.GetBytes($content)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        [void](Assert-RevAgentSafeUserPath -Path $tempPath -AllowedRoot $GuardRoot -LeafKind File)
        $stagedHash = Get-RevAgentFileSha256 -Path $tempPath
        if ($null -ne $BeforeDestinationCommit) {
            & $BeforeDestinationCommit $configPath $beforeHash $beforeIdentity
        }

        # The lock coordinates revAgent writers, but ChatGPT and the operator do
        # not participate in it. Revalidate both file identity and content at
        # the commit boundary so their intervening write is never overwritten.
        [void](Assert-RevAgentSafeUserPath -Path $configPath -AllowedRoot $GuardRoot -LeafKind File -AllowMissing)
        $commitHash = Get-RevAgentFileSha256 -Path $configPath
        $commitIdentity = Get-RevAgentFileIdentity -Path $configPath
        if (-not [string]::Equals($commitHash, $beforeHash, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($commitIdentity, $beforeIdentity, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Codex config destination changed before atomic replace. expectedHash=$beforeHash actualHash=$commitHash expectedIdentity=$beforeIdentity actualIdentity=$commitIdentity"
        }
        if ($null -ne $BeforeAtomicCommit) {
            & $BeforeAtomicCommit $configPath $beforeHash $beforeIdentity
        }

        if ($beforeHash -ne 'MISSING') {
            [IO.File]::Replace($tempPath, $configPath, $backupPath, $true)

            # ReplaceFile leaves the displaced destination at backupPath. This
            # closes the final check/replace race: if a non-cooperating writer
            # landed there after revalidation, restore its exact file and fail.
            $displacedHash = Get-RevAgentFileSha256 -Path $backupPath
            $displacedIdentity = Get-RevAgentFileIdentity -Path $backupPath
            if (-not [string]::Equals($displacedHash, $beforeHash, [System.StringComparison]::OrdinalIgnoreCase) -or
                -not [string]::Equals($displacedIdentity, $beforeIdentity, [System.StringComparison]::OrdinalIgnoreCase)) {
                $discardPath = Join-Path $CodexHome ('.config.toml.revagent-' + [Guid]::NewGuid().ToString('N') + '.discard')
                try {
                    if ($null -ne $BeforeRecoveryCommit) {
                        & $BeforeRecoveryCommit $configPath $backupPath $displacedHash $displacedIdentity
                    }
                    [IO.File]::Replace($backupPath, $configPath, $discardPath, $true)
                    Remove-Item -LiteralPath $discardPath -Force -ErrorAction Stop
                }
                catch {
                    throw "Codex config recovery failed; displaced writer data was preserved at '$backupPath'. $($_.Exception.Message)"
                }
                finally {
                    if (Test-Path -LiteralPath $discardPath -PathType Leaf) { Remove-Item -LiteralPath $discardPath -Force -ErrorAction SilentlyContinue }
                }
                throw "Codex config destination changed during atomic replace; the displaced writer content was restored. expectedHash=$beforeHash displacedHash=$displacedHash expectedIdentity=$beforeIdentity displacedIdentity=$displacedIdentity"
            }
        }
        else { [IO.File]::Move($tempPath, $configPath) }
        [void](Assert-RevAgentSafeUserPath -Path $configPath -AllowedRoot $GuardRoot -LeafKind File)
        $afterHash = Get-RevAgentFileSha256 $configPath
        if (-not [string]::Equals($afterHash, $stagedHash, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Codex config changed before final installed-content attestation; recovery backup was preserved when available. expected=$stagedHash actual=$afterHash backup=$backupPath"
        }
        if ($beforeHash -ne 'MISSING') {
            $backupHash = Get-RevAgentFileSha256 -Path $backupPath
            $backupIdentity = Get-RevAgentFileIdentity -Path $backupPath
            if (-not [string]::Equals($backupHash, $beforeHash, [StringComparison]::OrdinalIgnoreCase) -or
                -not [string]::Equals($backupIdentity, $beforeIdentity, [StringComparison]::Ordinal)) {
                throw "Codex config recovery backup changed before cleanup; preserving it and failing closed. backup=$backupPath"
            }
            $backupSafeToRemove = $true
            Remove-Item -LiteralPath $backupPath -Force -ErrorAction Stop
            $backupSafeToRemove = $false
        }
        return [pscustomobject][ordered]@{ path = $configPath; beforeSha256 = $beforeHash; afterSha256 = $afterHash; atomicReplace = $true; lockPath = $lockPath }
    }
    finally {
        if ($lock) { $lock.Dispose() }
        if (Test-Path -LiteralPath $tempPath -PathType Leaf) { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
        if ($backupSafeToRemove -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
            try {
                $cleanupHash = Get-RevAgentFileSha256 -Path $backupPath
                $cleanupIdentity = Get-RevAgentFileIdentity -Path $backupPath
                if ([string]::Equals($cleanupHash, $beforeHash, [StringComparison]::OrdinalIgnoreCase) -and
                    [string]::Equals($cleanupIdentity, $beforeIdentity, [StringComparison]::Ordinal)) {
                    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
                }
            }
            catch {}
        }
    }
}

function Test-RevAgentManagedSkillPath {
    param([string]$Path, [string]$SourcePath, [string]$SourceHash)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $target = [string]$item.Target
        if (-not [string]::IsNullOrWhiteSpace($target)) {
            if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $Path) $target }
            return [string]::Equals((Get-RevAgentFullPath $target), (Get-RevAgentFullPath $SourcePath), [System.StringComparison]::OrdinalIgnoreCase)
        }
        return $false
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    $marker = Join-Path $Path $script:RevAgentManagedSkillMarker
    if (Test-Path -LiteralPath $marker -PathType Leaf) {
        try {
            [void](Assert-RevAgentSafeUserPath -Path $marker -AllowedRoot $Path -LeafKind File)
            $data = [IO.File]::ReadAllText($marker) | ConvertFrom-Json
            $currentHash = Get-RevAgentDirectoryTreeSha256 $Path
            if ($data.managedBy -eq 'revAgent' -and -not [string]::IsNullOrWhiteSpace([string]$data.payloadSha256) -and
                [string]::Equals([string]$data.payloadSha256, $currentHash, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $true
            }
        }
        catch {}
    }
    try { return [string]::Equals((Get-RevAgentDirectoryTreeSha256 $Path), $SourceHash, [System.StringComparison]::OrdinalIgnoreCase) }
    catch { return $false }
}

function Remove-RevAgentManagedSkillPath {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { [IO.Directory]::Delete($Path, $false) }
    else { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop }
}

function Remove-RevAgentManagedSkillPathAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$GuardRoot,
        [Parameter(Mandatory = $true)]$ExpectedState
    )

    $commitState = Get-RevAgentSkillCommitState -Path $Path -GuardRoot $GuardRoot
    if (-not (Test-RevAgentSkillCommitStateEqual -Expected $ExpectedState -Actual $commitState)) {
        throw "Managed legacy skill changed before atomic cleanup; preserving it. path=$Path"
    }
    $quarantine = Join-Path (Split-Path -Parent $Path) ('.revAgent-legacy-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::Move($Path, $quarantine)
    $displacedState = Get-RevAgentSkillCommitState -Path $quarantine -GuardRoot $GuardRoot
    if (-not (Test-RevAgentSkillCommitStateEqual -Expected $ExpectedState -Actual $displacedState)) {
        if (-not (Test-Path -LiteralPath $Path)) { [IO.Directory]::Move($quarantine, $Path) }
        throw "Managed legacy skill changed during atomic cleanup; the displaced directory was restored when safe. path=$Path quarantine=$quarantine"
    }
    Remove-RevAgentManagedSkillPath -Path $quarantine
}

function Sync-RevAgentCodexSkill {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$UserProfileRoot,
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [ValidateSet('managed-user-pack', 'preserve-local')][string]$Policy,
        [Parameter(Mandatory = $true)][string]$GuardRoot,
        [scriptblock]$BeforeDestinationCommit,
        [scriptblock]$BeforeAtomicCommit
    )

    $canonical = Join-Path $UserProfileRoot '.agents\skills\revAgent'
    $legacy = @((Join-Path $UserProfileRoot '.codex\skills\revAgent'), (Join-Path $UserProfileRoot '.codex\skills\revit-mcp'))
    if ($Policy -eq 'preserve-local') { return Get-RevAgentCodexSkillAttestation -UserProfileRoot $UserProfileRoot -GuardRoot $GuardRoot -Policy $Policy }
    if (-not (Test-Path -LiteralPath (Join-Path $SourcePath 'SKILL.md') -PathType Leaf)) { throw "Managed Codex skill source is invalid: $SourcePath" }
    $sourceHash = Get-RevAgentDirectoryTreeSha256 $SourcePath
    $skillsRoot = Split-Path -Parent $canonical
    [void](New-RevAgentSafeUserDirectory -Path $skillsRoot -AllowedRoot $UserProfileRoot)
    [void](Assert-RevAgentSafeUserPath -Path (Split-Path -Parent $canonical) -AllowedRoot $UserProfileRoot -LeafKind Directory)
    $beforeState = Get-RevAgentSkillCommitState -Path $canonical -GuardRoot $GuardRoot
    if ($beforeState.exists) {
        if (-not (Test-RevAgentManagedSkillPath -Path $canonical -SourcePath $SourcePath -SourceHash $sourceHash)) {
            throw "Canonical Codex skill exists but is not a verified revAgent-managed payload: $canonical"
        }
    }
    $staging = Join-Path $skillsRoot ('.revAgent-staging-' + [Guid]::NewGuid().ToString('N'))
    $backup = Join-Path $skillsRoot ('.revAgent-backup-' + [Guid]::NewGuid().ToString('N'))
    $backupExpected = $false
    $backupMayContainConcurrentData = $false
    try {
        Copy-RevAgentDirectoryTreeCreateNew -SourcePath $SourcePath -DestinationPath $staging
        $marker = [ordered]@{ managedBy = 'revAgent'; schemaVersion = 1; sourcePath = (Get-RevAgentFullPath $SourcePath); payloadSha256 = $sourceHash; installedAtUtc = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json
        Write-RevAgentFileCreateNew -Path (Join-Path $staging $script:RevAgentManagedSkillMarker) -Bytes $script:RevAgentUtf8NoBom.GetBytes($marker)
        [void](Assert-RevAgentSafeUserPath -Path $staging -AllowedRoot $UserProfileRoot -LeafKind Directory)
        $stagedHash = Get-RevAgentDirectoryTreeSha256 $staging
        if (-not [string]::Equals($stagedHash, $sourceHash, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Staged Codex skill hash did not match the trusted source. source=$sourceHash staged=$stagedHash"
        }
        $stagedState = Get-RevAgentSkillCommitState -Path $staging -GuardRoot $GuardRoot
        if ($null -ne $BeforeDestinationCommit) {
            & $BeforeDestinationCommit $canonical $beforeState
        }

        # ChatGPT and operators do not participate in a revAgent lock. Recheck
        # both the payload tree and stable file identities at the commit edge.
        $commitState = Get-RevAgentSkillCommitState -Path $canonical -GuardRoot $GuardRoot
        if (-not (Test-RevAgentSkillCommitStateEqual -Expected $beforeState -Actual $commitState)) {
            throw "Codex skill destination changed before atomic directory replace. expectedTree=$($beforeState.treeSha256) actualTree=$($commitState.treeSha256) expectedMarkerIdentity=$($beforeState.markerIdentity) actualMarkerIdentity=$($commitState.markerIdentity) expectedSkillIdentity=$($beforeState.skillIdentity) actualSkillIdentity=$($commitState.skillIdentity)"
        }
        if ($null -ne $BeforeAtomicCommit) {
            & $BeforeAtomicCommit $canonical $beforeState
        }

        if ($beforeState.exists) {
            [IO.Directory]::Move($canonical, $backup)
            $backupMayContainConcurrentData = $true
            $displacedState = Get-RevAgentSkillCommitState -Path $backup -GuardRoot $GuardRoot
            if (-not (Test-RevAgentSkillCommitStateEqual -Expected $beforeState -Actual $displacedState)) {
                if (-not (Test-Path -LiteralPath $canonical)) {
                    [IO.Directory]::Move($backup, $canonical)
                    $backupMayContainConcurrentData = $false
                }
                throw "Codex skill destination changed during atomic directory replace; the displaced directory was restored when safe. expectedTree=$($beforeState.treeSha256) displacedTree=$($displacedState.treeSha256) expectedSkillIdentity=$($beforeState.skillIdentity) displacedSkillIdentity=$($displacedState.skillIdentity)"
            }
            $backupExpected = $true
            $backupMayContainConcurrentData = $false
        }
        [IO.Directory]::Move($staging, $canonical)
        $installedState = Get-RevAgentSkillCommitState -Path $canonical -GuardRoot $GuardRoot
        if (-not (Test-RevAgentSkillCommitStateEqual -Expected $stagedState -Actual $installedState)) {
            throw "Installed Codex skill did not match the verified CreateNew stage. expectedTree=$($stagedState.treeSha256) actualTree=$($installedState.treeSha256)"
        }
        if ($backupExpected) {
            $backupState = Get-RevAgentSkillCommitState -Path $backup -GuardRoot $GuardRoot
            if (-not (Test-RevAgentSkillCommitStateEqual -Expected $beforeState -Actual $backupState)) {
                $backupMayContainConcurrentData = $true
                throw "Codex skill backup changed before cleanup; preserving it and failing closed: $backup"
            }
            Remove-RevAgentManagedSkillPath $backup
            $backupExpected = $false
        }
    }
    catch {
        # If an intervening writer created the destination after we moved the
        # old managed tree aside, leave the writer's tree intact. The old tree
        # is only removed when its full state is still the captured managed one.
        if ($backupExpected -and (Test-Path -LiteralPath $backup)) {
            try {
                $backupState = Get-RevAgentSkillCommitState -Path $backup -GuardRoot $GuardRoot
                if (Test-RevAgentSkillCommitStateEqual -Expected $beforeState -Actual $backupState) {
                    if (-not (Test-Path -LiteralPath $canonical)) {
                        [IO.Directory]::Move($backup, $canonical)
                    }
                    else {
                        Remove-RevAgentManagedSkillPath $backup
                    }
                    $backupExpected = $false
                }
                else { $backupMayContainConcurrentData = $true }
            }
            catch { $backupMayContainConcurrentData = $true }
        }
        throw
    }
    finally {
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
        if ((Test-Path -LiteralPath $backup) -and -not $backupMayContainConcurrentData) {
            try {
                $backupState = Get-RevAgentSkillCommitState -Path $backup -GuardRoot $GuardRoot
                if (Test-RevAgentSkillCommitStateEqual -Expected $beforeState -Actual $backupState) {
                    Remove-RevAgentManagedSkillPath $backup
                }
            }
            catch {}
        }
    }

    $removed = [System.Collections.Generic.List[string]]::new()
    $conflicts = [System.Collections.Generic.List[string]]::new()
    foreach ($path in $legacy) {
        $legacyParent = Split-Path -Parent $path
        if (-not (Test-Path -LiteralPath $legacyParent -PathType Container)) { continue }
        [void](Assert-RevAgentSafeUserPath -Path $legacyParent -AllowedRoot $UserProfileRoot -LeafKind Directory)
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $legacyBeforeState = Get-RevAgentSkillCommitState -Path $path -GuardRoot $GuardRoot
        if (Test-RevAgentManagedSkillPath -Path $path -SourcePath $SourcePath -SourceHash $sourceHash) {
            Remove-RevAgentManagedSkillPathAtomic -Path $path -GuardRoot $GuardRoot -ExpectedState $legacyBeforeState
            $removed.Add($path)
        }
        else { $conflicts.Add($path) }
    }
    $result = Get-RevAgentCodexSkillAttestation -UserProfileRoot $UserProfileRoot -GuardRoot $GuardRoot -Policy $Policy
    $result | Add-Member -NotePropertyName removedManagedLegacyPaths -NotePropertyValue @($removed)
    $result | Add-Member -NotePropertyName legacyConflicts -NotePropertyValue @($conflicts)
    return $result
}

function Get-RevAgentCodexSkillAttestation {
    [CmdletBinding()]
    param([string]$UserProfileRoot, [string]$GuardRoot, [string]$Policy)
    $paths = @(
        [pscustomobject]@{ path = (Join-Path $UserProfileRoot '.agents\skills\revAgent'); canonical = $true },
        [pscustomobject]@{ path = (Join-Path $UserProfileRoot '.codex\skills\revAgent'); canonical = $false },
        [pscustomobject]@{ path = (Join-Path $UserProfileRoot '.codex\skills\revit-mcp'); canonical = $false }
    )
    $found = [System.Collections.Generic.List[object]]::new()
    foreach ($candidate in $paths) {
        $parent = Split-Path -Parent $candidate.path
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) { continue }
        $parentSafe = $true
        try { [void](Assert-RevAgentSafeUserPath -Path $parent -AllowedRoot $GuardRoot -LeafKind Directory) } catch { $parentSafe = $false }
        if (-not $parentSafe -or -not (Test-Path -LiteralPath $candidate.path)) { continue }
        $safe = $true
        try { [void](Assert-RevAgentSafeUserPath -Path $candidate.path -AllowedRoot $GuardRoot -LeafKind Directory) } catch { $safe = $false }
        $hasSkill = $safe -and (Test-Path -LiteralPath (Join-Path $candidate.path 'SKILL.md') -PathType Leaf)
        if ($hasSkill -or -not $safe) {
            $found.Add([pscustomobject]@{ path = $candidate.path; canonical = $candidate.canonical; safe = $safe; hasSkill = $hasSkill })
        }
    }
    $selected = @($found | Sort-Object canonical -Descending | Select-Object -First 1)
    $selectedSafe = $selected.Count -gt 0 -and [bool]$selected[0].safe -and [bool]$selected[0].hasSkill
    $hash = if ($selectedSafe) { try { Get-RevAgentDirectoryTreeSha256 $selected[0].path } catch { 'UNSAFE' } } elseif ($selected.Count -gt 0) { 'UNSAFE' } else { 'MISSING' }
    if ($hash -eq 'UNSAFE') { $selectedSafe = $false }
    return [pscustomobject][ordered]@{
        policy = $Policy; present = $selected.Count -gt 0; loaded = $selectedSafe -and [bool]$selected[0].canonical
        path = if ($selected.Count -gt 0) { $selected[0].path } else { (Join-Path $UserProfileRoot '.agents\skills\revAgent') }
        hash = $hash; safe = $selectedSafe; loadBasis = if ($selectedSafe -and $selected[0].canonical) { 'official-home-.agents-skills' } elseif ($selected.Count -gt 0 -and -not $selectedSafe) { 'unsafe-path-not-loaded' } elseif ($selected.Count -gt 0) { 'legacy-path-not-counted-as-loaded' } else { 'absent' }
        discoveredPaths = @($found | ForEach-Object path)
    }
}

function Sync-RevAgentCodexAgents {
    [CmdletBinding()]
    param(
        [string]$CodexHome,
        [string]$GuardRoot,
        [string]$SourcePath,
        [ValidateSet('managed-user-pack', 'preserve-local')][string]$Policy,
        [scriptblock]$BeforeDestinationCommit,
        [scriptblock]$BeforeAtomicCommit
    )
    $target = Join-Path $CodexHome 'AGENTS.md'
    $marker = Join-Path $CodexHome $script:RevAgentManagedAgentsMarker
    if ($Policy -eq 'preserve-local') { return Get-RevAgentCodexAgentsAttestation -CodexHome $CodexHome -GuardRoot $GuardRoot -Policy $Policy }
    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) { throw "Managed AGENTS source was not found: $SourcePath" }
    [void](Assert-RevAgentSafeUserPath -Path $CodexHome -AllowedRoot $GuardRoot -LeafKind Directory)
    $sourceHash = Get-RevAgentFileSha256 $SourcePath
    $targetBeforeState = Get-RevAgentFileCommitState -Path $target
    if (Test-Path -LiteralPath $target) {
        $item = Get-Item -LiteralPath $target -Force
        $isReparse = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        $linkCount = if ($isReparse) { 0 } else { Get-RevAgentFileLinkCount $target }
        $existingHash = if ($isReparse) { 'UNSAFE' } else { Get-RevAgentFileSha256 $target }
        $managed = -not $isReparse -and [string]::Equals($existingHash, $sourceHash, [System.StringComparison]::OrdinalIgnoreCase)
        if (-not $managed -and -not $isReparse -and $linkCount -eq 1 -and (Test-Path -LiteralPath $marker -PathType Leaf)) {
            try {
                [void](Assert-RevAgentSafeUserPath -Path $marker -AllowedRoot $GuardRoot -LeafKind File)
                $markerData = [IO.File]::ReadAllText($marker) | ConvertFrom-Json
                $managed = $markerData.managedBy -eq 'revAgent' -and
                    [string]::Equals([string]$markerData.payloadSha256, $existingHash, [System.StringComparison]::OrdinalIgnoreCase)
            }
            catch { $managed = $false }
        }
        if (-not $managed -and $isReparse) {
            $targetValue = [string]$item.Target
            if (-not [string]::IsNullOrWhiteSpace($targetValue)) {
                if (-not [IO.Path]::IsPathRooted($targetValue)) { $targetValue = Join-Path (Split-Path -Parent $target) $targetValue }
                $managed = [string]::Equals((Get-RevAgentFullPath $targetValue), (Get-RevAgentFullPath $SourcePath), [System.StringComparison]::OrdinalIgnoreCase)
            }
        }
        if (-not $managed -and $linkCount -gt 1) {
            $managed = [string]::Equals((Get-RevAgentFileSha256 $target), $sourceHash, [System.StringComparison]::OrdinalIgnoreCase)
        }
        if (-not $managed) { throw "CODEX_HOME/AGENTS.md exists but is not a verified revAgent-managed file: $target" }
    }
    if (Test-Path -LiteralPath $marker) {
        [void](Assert-RevAgentSafeUserPath -Path $marker -AllowedRoot $GuardRoot -LeafKind File)
    }
    $markerBeforeState = Get-RevAgentFileCommitState -Path $marker
    $bytes = [IO.File]::ReadAllBytes($SourcePath)
    $temp = Join-Path $CodexHome ('.AGENTS.md.revagent-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $backup = Join-Path $CodexHome ('.AGENTS.md.revagent-' + [Guid]::NewGuid().ToString('N') + '.bak')
    $markerTemp = Join-Path $CodexHome ('.AGENTS.md.marker-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $markerBackup = Join-Path $CodexHome ('.AGENTS.md.marker-' + [Guid]::NewGuid().ToString('N') + '.bak')
    $targetCommit = $null
    $markerCommit = $null
    $targetBackupSafeToRemove = $false
    $markerBackupSafeToRemove = $false
    try {
        Write-RevAgentFileCreateNew -Path $temp -Bytes $bytes
        [void](Assert-RevAgentSafeUserPath -Path $temp -AllowedRoot $GuardRoot -LeafKind File)
        $targetStagedState = Get-RevAgentFileCommitState -Path $temp
        $markerBytes = $script:RevAgentUtf8NoBom.GetBytes(([ordered]@{ managedBy = 'revAgent'; schemaVersion = 1; payloadSha256 = $sourceHash; installedAtUtc = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json))
        Write-RevAgentFileCreateNew -Path $markerTemp -Bytes $markerBytes
        [void](Assert-RevAgentSafeUserPath -Path $markerTemp -AllowedRoot $GuardRoot -LeafKind File)
        $markerStagedState = Get-RevAgentFileCommitState -Path $markerTemp
        if ($null -ne $BeforeDestinationCommit) {
            & $BeforeDestinationCommit $target $marker $targetBeforeState $markerBeforeState
        }

        $targetCommitState = Get-RevAgentFileCommitState -Path $target
        $markerCommitState = Get-RevAgentFileCommitState -Path $marker
        if (-not (Test-RevAgentFileCommitStateEqual -Expected $targetBeforeState -Actual $targetCommitState) -or
            -not (Test-RevAgentFileCommitStateEqual -Expected $markerBeforeState -Actual $markerCommitState)) {
            throw "Codex AGENTS destination or marker changed before atomic replace. expectedTargetHash=$($targetBeforeState.sha256) actualTargetHash=$($targetCommitState.sha256) expectedTargetIdentity=$($targetBeforeState.identity) actualTargetIdentity=$($targetCommitState.identity) expectedMarkerHash=$($markerBeforeState.sha256) actualMarkerHash=$($markerCommitState.sha256) expectedMarkerIdentity=$($markerBeforeState.identity) actualMarkerIdentity=$($markerCommitState.identity)"
        }
        if ($null -ne $BeforeAtomicCommit) {
            & $BeforeAtomicCommit $target $marker $targetBeforeState $markerBeforeState
        }

        $targetCommit = Invoke-RevAgentAtomicFileCommit -StagePath $temp -DestinationPath $target -BackupPath $backup -BeforeState $targetBeforeState -StagedState $targetStagedState -GuardRoot $GuardRoot
        $targetBackupSafeToRemove = [bool]$targetCommit.backupPresent

        # Before the marker update, make sure neither the installed target nor
        # the old marker changed while the first atomic operation completed.
        $targetAfterFirstCommit = Get-RevAgentFileCommitState -Path $target
        $markerBeforeSecondCommit = Get-RevAgentFileCommitState -Path $marker
        if (-not (Test-RevAgentFileCommitStateEqual -Expected $targetCommit.installedState -Actual $targetAfterFirstCommit) -or
            -not (Test-RevAgentFileCommitStateEqual -Expected $markerBeforeState -Actual $markerBeforeSecondCommit)) {
            [void](Restore-RevAgentAtomicFileCommit -DestinationPath $target -BackupPath $backup -BeforeState $targetBeforeState -InstalledState $targetCommit.installedState)
            throw "Codex AGENTS target or marker changed between the paired atomic commits; concurrent data was preserved."
        }

        $markerCommit = Invoke-RevAgentAtomicFileCommit -StagePath $markerTemp -DestinationPath $marker -BackupPath $markerBackup -BeforeState $markerBeforeState -StagedState $markerStagedState -GuardRoot $GuardRoot
        $markerBackupSafeToRemove = [bool]$markerCommit.backupPresent

        $targetFinalState = Get-RevAgentFileCommitState -Path $target
        $markerFinalState = Get-RevAgentFileCommitState -Path $marker
        if (-not (Test-RevAgentFileCommitStateEqual -Expected $targetCommit.installedState -Actual $targetFinalState) -or
            -not (Test-RevAgentFileCommitStateEqual -Expected $markerCommit.installedState -Actual $markerFinalState)) {
            [void](Restore-RevAgentAtomicFileCommit -DestinationPath $marker -BackupPath $markerBackup -BeforeState $markerBeforeState -InstalledState $markerCommit.installedState)
            [void](Restore-RevAgentAtomicFileCommit -DestinationPath $target -BackupPath $backup -BeforeState $targetBeforeState -InstalledState $targetCommit.installedState)
            throw "Codex AGENTS target or marker changed before final paired attestation; concurrent data was preserved."
        }

        if ($targetBackupSafeToRemove) {
            $targetBackupState = Get-RevAgentFileCommitState -Path $backup
            if (-not (Test-RevAgentFileCommitStateEqual -Expected $targetBeforeState -Actual $targetBackupState)) {
                $targetBackupSafeToRemove = $false
                throw "Codex AGENTS displaced-target backup changed before cleanup; preserving it and failing closed: $backup"
            }
            Remove-Item -LiteralPath $backup -Force -ErrorAction Stop
            $targetBackupSafeToRemove = $false
        }
        if ($markerBackupSafeToRemove) {
            $markerBackupState = Get-RevAgentFileCommitState -Path $markerBackup
            if (-not (Test-RevAgentFileCommitStateEqual -Expected $markerBeforeState -Actual $markerBackupState)) {
                $markerBackupSafeToRemove = $false
                throw "Codex AGENTS displaced-marker backup changed before cleanup; preserving it and failing closed: $markerBackup"
            }
            Remove-Item -LiteralPath $markerBackup -Force -ErrorAction Stop
            $markerBackupSafeToRemove = $false
        }
    }
    catch {
        if ($null -ne $markerCommit) {
            try { [void](Restore-RevAgentAtomicFileCommit -DestinationPath $marker -BackupPath $markerBackup -BeforeState $markerBeforeState -InstalledState $markerCommit.installedState) } catch {}
        }
        if ($null -ne $targetCommit) {
            try { [void](Restore-RevAgentAtomicFileCommit -DestinationPath $target -BackupPath $backup -BeforeState $targetBeforeState -InstalledState $targetCommit.installedState) } catch {}
        }
        throw
    }
    finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $markerTemp) { Remove-Item -LiteralPath $markerTemp -Force -ErrorAction SilentlyContinue }
        if ((Test-Path -LiteralPath $backup) -and $targetBackupSafeToRemove) {
            $backupState = Get-RevAgentFileCommitState -Path $backup
            if (Test-RevAgentFileCommitStateEqual -Expected $targetBeforeState -Actual $backupState) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
        }
        if ((Test-Path -LiteralPath $markerBackup) -and $markerBackupSafeToRemove) {
            $backupState = Get-RevAgentFileCommitState -Path $markerBackup
            if (Test-RevAgentFileCommitStateEqual -Expected $markerBeforeState -Actual $backupState) { Remove-Item -LiteralPath $markerBackup -Force -ErrorAction SilentlyContinue }
        }
    }
    return Get-RevAgentCodexAgentsAttestation -CodexHome $CodexHome -GuardRoot $GuardRoot -Policy $Policy
}

function Get-RevAgentCodexAgentsAttestation {
    param([string]$CodexHome, [string]$GuardRoot, [string]$Policy)
    $path = Join-Path $CodexHome 'AGENTS.md'
    $present = Test-Path -LiteralPath $path -PathType Leaf
    $safe = $false
    if ($present) { try { [void](Assert-RevAgentSafeUserPath -Path $path -AllowedRoot $GuardRoot -LeafKind File); $safe = $true } catch {} }
    return [pscustomobject][ordered]@{ policy = $Policy; present = $present; loaded = $present -and $safe; path = $path; hash = if ($present -and $safe) { Get-RevAgentFileSha256 $path } elseif ($present) { 'UNSAFE' } else { 'MISSING' }; safe = $safe }
}

function Test-RevAgentCodexMcpReadback {
    [CmdletBinding()]
    param([string]$CodexCliPath, [string]$CodexHome, [string]$NodePath, [string]$RuntimeServerPath, [string]$DocsServerPath, [object]$CodexCliCandidate)
    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($server in @([pscustomobject]@{ name = 'revAgent'; entry = $RuntimeServerPath }, [pscustomobject]@{ name = 'revAgent-api-docs'; entry = $DocsServerPath })) {
        if ($null -ne $CodexCliCandidate) {
            if (-not [string]::Equals([string]$CodexCliPath, [string]$CodexCliCandidate.path, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Codex MCP readback path does not match its executable attestation. path=$CodexCliPath attested=$($CodexCliCandidate.path)"
            }
            [void](Assert-RevAgentCodexExecutableUnchanged -Candidate $CodexCliCandidate)
        }
        $probe = Invoke-RevAgentProcessProbe -FilePath $CodexCliPath -Arguments @('mcp', 'get', $server.name, '--json') -Environment @{ CODEX_HOME = $CodexHome }
        $data = $null
        try { if ($probe.exitCode -eq 0) { $data = $probe.stdout | ConvertFrom-Json } } catch {}
        $match = $null -ne $data -and $data.enabled -eq $true -and $data.transport.type -eq 'stdio' -and
            [string]::Equals([string]$data.transport.command, $NodePath, [System.StringComparison]::OrdinalIgnoreCase) -and
            @($data.transport.args).Count -eq 1 -and [string]::Equals([string]$data.transport.args[0], $server.entry, [System.StringComparison]::OrdinalIgnoreCase)
        $rows.Add([pscustomobject][ordered]@{ name = $server.name; success = $match; exitCode = $probe.exitCode; command = if ($data) { $data.transport.command } else { '' }; args = if ($data) { @($data.transport.args) } else { @() }; error = if ($match) { '' } else { ($probe.stderr + ' ' + $probe.stdout).Trim() } })
    }
    return [pscustomobject][ordered]@{ success = @($rows | Where-Object { -not $_.success }).Count -eq 0; servers = @($rows) }
}

function Test-RevAgentStrictJsonRpcId {
    param([AllowNull()][object]$Value, [Parameter(Mandatory = $true)][long]$Expected)
    $numeric = $Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or $Value -is [uint16] -or
        $Value -is [int32] -or $Value -is [uint32] -or $Value -is [int64] -or $Value -is [uint64] -or
        $Value -is [single] -or $Value -is [double] -or $Value -is [decimal]
    if (-not $numeric) { return $false }
    try { return [decimal]$Value -eq [decimal]$Expected }
    catch { return $false }
}

function Test-RevAgentMcpStdioHandshake {
    [CmdletBinding()]
    param(
        [string]$NodePath,
        [string]$ServerPath,
        [int]$TimeoutSeconds = 20,
        [string]$ExpectedProtocolVersion = '2025-03-26',
        [string[]]$ExpectedServerNames = @(),
        [string[]]$ExpectedToolNames = @(),
        [ValidateRange(1, 100000)][int]$MinimumToolCount = 1
    )
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $NodePath
    # Windows PowerShell 5.1 constructs redirected stdin with a BOM-emitting
    # UTF-8 StreamWriter and has no StandardInputEncoding property. Run a tiny
    # trusted Node proxy that removes only that leading BOM before forwarding
    # bytes to the real server; pwsh input passes through unchanged.
    $stdioProxy = "const{spawn}=require('child_process');const c=spawn(process.execPath,[process.argv[1]],{stdio:['pipe','inherit','inherit']});let f=true;process.stdin.on('data',b=>{if(f){f=false;if(b.length>=3&&b[0]===0xef&&b[1]===0xbb&&b[2]===0xbf)b=b.subarray(3)}c.stdin.write(b)});process.stdin.on('end',()=>c.stdin.end());c.on('exit',x=>{process.exitCode=x??1});"
    $start.Arguments = (@('-e', $stdioProxy, $ServerPath) | ForEach-Object { ConvertTo-RevAgentWindowsArgument ([string]$_) }) -join ' '
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    $started = $false
    try {
        if (-not $process.Start()) { throw 'MCP server did not start.' }
        $started = $true
        $request = [ordered]@{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = [ordered]@{ protocolVersion = $ExpectedProtocolVersion; capabilities = @{}; clientInfo = [ordered]@{ name = 'revAgent-installer'; version = '1.0' } } } | ConvertTo-Json -Compress -Depth 8
        $requestBytes = $script:RevAgentUtf8NoBom.GetBytes($request + "`n")
        $process.StandardInput.BaseStream.Write($requestBytes, 0, $requestBytes.Length); $process.StandardInput.BaseStream.Flush()
        $readTask = $process.StandardOutput.ReadLineAsync()
        if (-not $readTask.Wait($TimeoutSeconds * 1000)) { throw "MCP initialize handshake timed out after $TimeoutSeconds seconds." }
        $line = [string]$readTask.Result
        if ([string]::IsNullOrWhiteSpace($line)) {
            try { $process.StandardInput.Close() } catch {}
            [void]$process.WaitForExit(1000)
            $stderrText = $process.StandardError.ReadToEnd()
            throw "MCP server closed stdout before initialize response. request=$request stderr=$stderrText"
        }
        $response = $line | ConvertFrom-Json
        $resultProperty = Get-RevAgentObjectPropertyInfo -InputObject $response -Name 'result'
        $errorProperty = Get-RevAgentObjectPropertyInfo -InputObject $response -Name 'error'
        $idProperty = Get-RevAgentObjectPropertyInfo -InputObject $response -Name 'id'
        $jsonRpcProperty = Get-RevAgentObjectPropertyInfo -InputObject $response -Name 'jsonrpc'
        $resultValue = if ($null -ne $resultProperty) { $resultProperty.Value } else { $null }
        $errorValue = if ($null -ne $errorProperty) { $errorProperty.Value } else { $null }
        $responseId = if ($null -ne $idProperty) { $idProperty.Value } else { $null }
        $responseJsonRpc = if ($null -ne $jsonRpcProperty) { [string]$jsonRpcProperty.Value } else { '' }
        $protocolProperty = Get-RevAgentObjectPropertyInfo -InputObject $resultValue -Name 'protocolVersion'
        $serverInfoProperty = Get-RevAgentObjectPropertyInfo -InputObject $resultValue -Name 'serverInfo'
        $serverInfo = if ($null -ne $serverInfoProperty) { $serverInfoProperty.Value } else { $null }
        $serverNameProperty = Get-RevAgentObjectPropertyInfo -InputObject $serverInfo -Name 'name'
        $serverVersionProperty = Get-RevAgentObjectPropertyInfo -InputObject $serverInfo -Name 'version'
        $protocolVersion = if ($null -ne $protocolProperty) { [string]$protocolProperty.Value } else { '' }
        $serverName = if ($null -ne $serverNameProperty) { [string]$serverNameProperty.Value } else { '' }
        $serverVersion = if ($null -ne $serverVersionProperty) { [string]$serverVersionProperty.Value } else { '' }
        $serverIdentityMatches = @($ExpectedServerNames).Count -eq 0 -or @($ExpectedServerNames | Where-Object { [string]::Equals($_, $serverName, [System.StringComparison]::Ordinal) }).Count -gt 0
        $initializeSuccess = $responseJsonRpc -eq '2.0' -and (Test-RevAgentStrictJsonRpcId -Value $responseId -Expected 1) -and
            $null -ne $resultValue -and $null -eq $errorValue -and
            [string]::Equals($protocolVersion, $ExpectedProtocolVersion, [System.StringComparison]::Ordinal) -and
            -not [string]::IsNullOrWhiteSpace($serverName) -and -not [string]::IsNullOrWhiteSpace($serverVersion) -and $serverIdentityMatches
        $toolsListSuccess = $false
        $toolCount = 0
        $toolNames = @()
        $missingExpectedTools = @($ExpectedToolNames)
        $toolsError = ''
        if (-not $initializeSuccess) {
            $toolsError = "MCP initialize response failed strict validation. jsonrpc=$responseJsonRpc id=$responseId resultPresent=$($null -ne $resultValue) errorPresent=$($null -ne $errorValue) protocol=$protocolVersion expectedProtocol=$ExpectedProtocolVersion serverName=$serverName serverVersion=$serverVersion serverIdentityMatches=$serverIdentityMatches"
        }
        if ($initializeSuccess) {
            $initialized = [ordered]@{ jsonrpc = '2.0'; method = 'notifications/initialized'; params = @{} } | ConvertTo-Json -Compress
            $initializedBytes = $script:RevAgentUtf8NoBom.GetBytes($initialized + "`n")
            $process.StandardInput.BaseStream.Write($initializedBytes, 0, $initializedBytes.Length); $process.StandardInput.BaseStream.Flush()
            $toolsRequest = [ordered]@{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} } | ConvertTo-Json -Compress
            $toolsRequestBytes = $script:RevAgentUtf8NoBom.GetBytes($toolsRequest + "`n")
            $process.StandardInput.BaseStream.Write($toolsRequestBytes, 0, $toolsRequestBytes.Length); $process.StandardInput.BaseStream.Flush()
            $toolsTask = $process.StandardOutput.ReadLineAsync()
            if (-not $toolsTask.Wait($TimeoutSeconds * 1000)) { throw "MCP tools/list timed out after $TimeoutSeconds seconds." }
            $toolsResponse = ([string]$toolsTask.Result) | ConvertFrom-Json
            $toolsResultProperty = Get-RevAgentObjectPropertyInfo -InputObject $toolsResponse -Name 'result'
            $toolsErrorProperty = Get-RevAgentObjectPropertyInfo -InputObject $toolsResponse -Name 'error'
            $toolsIdProperty = Get-RevAgentObjectPropertyInfo -InputObject $toolsResponse -Name 'id'
            $toolsJsonRpcProperty = Get-RevAgentObjectPropertyInfo -InputObject $toolsResponse -Name 'jsonrpc'
            $toolsResult = if ($null -ne $toolsResultProperty) { $toolsResultProperty.Value } else { $null }
            $toolsErrorValue = if ($null -ne $toolsErrorProperty) { $toolsErrorProperty.Value } else { $null }
            $toolsResponseId = if ($null -ne $toolsIdProperty) { $toolsIdProperty.Value } else { $null }
            $toolsJsonRpc = if ($null -ne $toolsJsonRpcProperty) { [string]$toolsJsonRpcProperty.Value } else { '' }
            $toolsProperty = Get-RevAgentObjectPropertyInfo -InputObject $toolsResult -Name 'tools'
            $toolsIsArray = $null -ne $toolsProperty -and $null -ne $toolsProperty.Value -and $toolsProperty.Value -is [System.Array]
            $tools = if ($toolsIsArray) { @($toolsProperty.Value) } else { @() }
            $toolCount = @($tools).Count
            $toolNames = @($tools | ForEach-Object {
                $nameProperty = Get-RevAgentObjectPropertyInfo -InputObject $_ -Name 'name'
                if ($null -ne $nameProperty) { [string]$nameProperty.Value } else { '' }
            })
            $allToolNamesPresent = @($toolNames | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -eq 0
            $missingExpectedTools = @($ExpectedToolNames | Where-Object {
                $expected = $_
                @($toolNames | Where-Object { [string]::Equals($_, $expected, [System.StringComparison]::Ordinal) }).Count -eq 0
            })
            $toolsListSuccess = $toolsJsonRpc -eq '2.0' -and (Test-RevAgentStrictJsonRpcId -Value $toolsResponseId -Expected 2) -and
                $null -ne $toolsResult -and $null -eq $toolsErrorValue -and $toolsIsArray -and
                $toolCount -ge $MinimumToolCount -and $allToolNamesPresent -and $missingExpectedTools.Count -eq 0
            if ($toolsErrorValue) {
                $toolsErrorMessage = Get-RevAgentObjectPropertyInfo -InputObject $toolsErrorValue -Name 'message'
                if ($null -ne $toolsErrorMessage) { $toolsError = [string]$toolsErrorMessage.Value }
            }
            elseif (-not $toolsListSuccess) {
                $toolsError = "MCP tools/list response failed strict validation. jsonrpc=$toolsJsonRpc id=$toolsResponseId resultPresent=$($null -ne $toolsResult) errorPresent=$($null -ne $toolsErrorValue) toolsArray=$toolsIsArray toolCount=$toolCount minimum=$MinimumToolCount missingExpected=$($missingExpectedTools -join ',')"
            }
        }
        $success = $initializeSuccess -and $toolsListSuccess
        $errorMessageProperty = Get-RevAgentObjectPropertyInfo -InputObject $errorValue -Name 'message'
        return [pscustomobject][ordered]@{ success = $success; initializeSuccess = $initializeSuccess; toolsListSuccess = $toolsListSuccess; toolCount = $toolCount; toolNames = @($toolNames); missingExpectedTools = @($missingExpectedTools); serverPath = $ServerPath; protocolVersion = $protocolVersion; serverName = $serverName; serverVersion = $serverVersion; error = if ($null -ne $errorMessageProperty) { [string]$errorMessageProperty.Value } else { $toolsError } }
    }
    catch { return [pscustomobject][ordered]@{ success = $false; initializeSuccess = $false; toolsListSuccess = $false; toolCount = 0; toolNames = @(); missingExpectedTools = @($ExpectedToolNames); serverPath = $ServerPath; protocolVersion = ''; serverName = ''; serverVersion = ''; error = $_.Exception.Message } }
    finally {
        if ($started -and -not $process.HasExited) { try { $process.Kill() } catch {} }
        $process.Dispose()
    }
}

function Get-RevAgentCodexAppProcessState {
    [CmdletBinding()]
    param([string[]]$ProcessNames)

    $names = if ($PSBoundParameters.ContainsKey('ProcessNames')) {
        @($ProcessNames)
    }
    else {
        @(Get-Process -Name 'ChatGPT', 'Codex' -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.ProcessName })
    }
    $names = @($names | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    $recognized = @($names | Where-Object { $_ -in @('ChatGPT', 'Codex') })
    return [pscustomobject][ordered]@{
        running = $recognized.Count -gt 0
        processNames = $names
        recognizedProcessNames = $recognized
        unifiedChatGptDetected = @($recognized | Where-Object { $_ -eq 'ChatGPT' }).Count -gt 0
        uptakeRequiresNewTask = $recognized.Count -gt 0
    }
}

function Test-RevAgentCodexInstructionPolicySatisfied {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('managed-user-pack', 'preserve-local')][string]$Policy,
        [Parameter(Mandatory = $true)][object]$Skill,
        [Parameter(Mandatory = $true)][object]$Agents
    )
    if ($Policy -eq 'preserve-local') { return $true }
    return [bool]$Skill.present -and [bool]$Skill.loaded -and [bool]$Skill.safe -and
        [bool]$Agents.present -and [bool]$Agents.loaded -and [bool]$Agents.safe
}

function Invoke-RevAgentCodexUserIntegration {
    [CmdletBinding()]
    param(
        [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'DPE\revAgent'),
        [ValidateSet('managed-user-pack', 'preserve-local')][string]$CodexInstructionPolicy = 'managed-user-pack',
        [string]$TargetUserProfileRoot = '', [string]$TargetUserSid = '', [string]$CodexHome = '',
        [string]$CodexCliPath = '', [string]$NodePath = '', [string]$RuntimeServerPath = '', [string]$DocsServerPath = '',
        [string]$SkillSourcePath = '', [string]$AgentsSourcePath = '', [string]$ExpectedConfigSha256 = '', [switch]$SkipMcpHandshake
    )

    $appProcess = Get-RevAgentCodexAppProcessState
    $user = Resolve-RevAgentInteractiveUser -TargetUserSid $TargetUserSid -TargetUserProfileRoot $TargetUserProfileRoot
    $codexHomeInfo = Resolve-RevAgentCodexHome -UserProfileRoot $user.profileRoot -CodexHome $CodexHome
    if ([string]::IsNullOrWhiteSpace($RuntimeServerPath)) { $RuntimeServerPath = Join-Path $InstallRoot 'runtime\build\index.js' }
    if ([string]::IsNullOrWhiteSpace($DocsServerPath)) { $DocsServerPath = Join-Path $InstallRoot 'package\installer\revit-api-docs-mcp\build\index.js' }
    if ([string]::IsNullOrWhiteSpace($SkillSourcePath)) {
        $machineSkill = Join-Path $InstallRoot 'codex\skills\revAgent'
        $SkillSourcePath = if (Test-Path -LiteralPath (Join-Path $machineSkill 'SKILL.md')) { $machineSkill } else { Join-Path $InstallRoot 'package' }
    }
    if ([string]::IsNullOrWhiteSpace($AgentsSourcePath)) {
        $machineAgents = Join-Path $InstallRoot 'codex\AGENTS.md'
        $AgentsSourcePath = if (Test-Path -LiteralPath $machineAgents) { $machineAgents } else { Join-Path $InstallRoot 'package\AGENTS.md' }
    }
    foreach ($required in @($RuntimeServerPath, $DocsServerPath)) { if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required MCP entrypoint was not found: $required" } }
    $serverAttestations = Get-RevAgentMcpServerEntrypointAttestations -InstallRoot $InstallRoot -RuntimeServerPath $RuntimeServerPath -DocsServerPath $DocsServerPath
    $cli = Resolve-RevAgentCodexCli -ExplicitPath $CodexCliPath -CodexHome $codexHomeInfo.path
    $node = Resolve-RevAgentNodeRuntime -ExplicitPath $NodePath
    $skill = Sync-RevAgentCodexSkill -UserProfileRoot $user.profileRoot -SourcePath $SkillSourcePath -Policy $CodexInstructionPolicy -GuardRoot $user.profileRoot
    $agents = Sync-RevAgentCodexAgents -CodexHome $codexHomeInfo.path -GuardRoot $codexHomeInfo.guardRoot -SourcePath $AgentsSourcePath -Policy $CodexInstructionPolicy
    $configPath = Join-Path $codexHomeInfo.path 'config.toml'
    if ([string]::IsNullOrWhiteSpace($ExpectedConfigSha256)) { $ExpectedConfigSha256 = Get-RevAgentFileSha256 $configPath }
    $config = Set-RevAgentCodexMcpConfigAtomic -CodexHome $codexHomeInfo.path -GuardRoot $codexHomeInfo.guardRoot -NodePath $node.selected.path -RuntimeServerPath $RuntimeServerPath -DocsServerPath $DocsServerPath -ExpectedSha256 $ExpectedConfigSha256
    $readback = Test-RevAgentCodexMcpReadback -CodexCliPath $cli.selected.path -CodexHome $codexHomeInfo.path -NodePath $node.selected.path -RuntimeServerPath $RuntimeServerPath -DocsServerPath $DocsServerPath -CodexCliCandidate $cli.selected
    $handshakes = @()
    if (-not $SkipMcpHandshake) {
        $handshakeRows = [System.Collections.Generic.List[object]]::new()
        foreach ($server in @(
            [pscustomobject]@{ path = $RuntimeServerPath; expectedServer = 'revAgent'; expectedTool = 'get_revit_mcp_status'; attestation = $serverAttestations.runtime.entrypoint },
            [pscustomobject]@{ path = $DocsServerPath; expectedServer = 'revit-api-docs'; expectedTool = 'resolve_api_symbols_bulk'; attestation = $serverAttestations.docs.entrypoint }
        )) {
            [void](Assert-RevAgentNodeExecutableUnchanged -Candidate $node.selected)
            [void](Assert-RevAgentProtectedMachineFileUnchanged -Attestation $server.attestation)
            $handshakeRows.Add((Test-RevAgentMcpStdioHandshake -NodePath $node.selected.path -ServerPath $server.path -ExpectedServerNames @($server.expectedServer) -ExpectedToolNames @($server.expectedTool)))
        }
        $handshakes = @($handshakeRows)
    }
    $instructionPolicySatisfied = Test-RevAgentCodexInstructionPolicySatisfied -Policy $CodexInstructionPolicy -Skill $skill -Agents $agents
    $success = $instructionPolicySatisfied -and $readback.success -and ($SkipMcpHandshake -or @($handshakes | Where-Object { -not $_.success }).Count -eq 0)
    return [pscustomobject][ordered]@{
        success = $success; state = if ($success) { 'verified' } else { 'verification_failed' }; elevated = $false
        targetUser = $user; codexHome = $codexHomeInfo; codexCli = $cli; node = $node; config = $config; appProcess = $appProcess
        skill = $skill; agents = $agents; instructionPolicySatisfied = $instructionPolicySatisfied
        mcpServerAttestations = $serverAttestations; mcpReadback = $readback; mcpHandshakes = @($handshakes)
    }
}

Export-ModuleMember -Function Test-RevAgentProcessElevated, Resolve-RevAgentInteractiveUser, Resolve-RevAgentCodexHome, Assert-RevAgentSafeUserPath, Get-RevAgentFileSha256, Get-RevAgentDirectoryTreeSha256, Resolve-RevAgentCodexCli, Resolve-RevAgentNodeRuntime, Set-RevAgentCodexMcpConfigAtomic, Sync-RevAgentCodexSkill, Get-RevAgentCodexSkillAttestation, Sync-RevAgentCodexAgents, Get-RevAgentCodexAgentsAttestation, Test-RevAgentCodexMcpReadback, Test-RevAgentMcpStdioHandshake, Get-RevAgentCodexAppProcessState, Invoke-RevAgentCodexUserIntegration
