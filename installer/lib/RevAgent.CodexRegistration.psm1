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
$script:RevAgentUnifiedCodexPackageName = 'OpenAI.Codex'
$script:RevAgentUnifiedCodexPackageFamilyName = 'OpenAI.Codex_2p2nqsd0c76g0'
$script:RevAgentUnifiedCodexPackagePublisher = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'
$script:RevAgentUnifiedCodexPackagePublisherId = '2p2nqsd0c76g0'
$script:RevAgentOpenAiSignerSubject = 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US'
$script:RevAgentOpenJsSignerSubject = 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'
$script:RevAgentUnifiedCodexPackageCliLayouts = @(
    [pscustomobject][ordered]@{ id = 'chatgpt-unified-app-resources-v1'; relativePath = 'app\resources\codex.exe' }
)
$script:RevAgentStandaloneCodexLayoutId = 'official-user-standalone-package-v1'

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

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        private static string FormatIdentity(BY_HANDLE_FILE_INFORMATION info) {
            return String.Format(
                System.Globalization.CultureInfo.InvariantCulture,
                "{0:X8}:{1:X8}{2:X8}:{3}",
                info.VolumeSerialNumber,
                info.FileIndexHigh,
                info.FileIndexLow,
                info.NumberOfLinks);
        }

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

        public static string GetIdentityFromHandle(SafeFileHandle handle) {
            if (handle == null || handle.IsInvalid || handle.IsClosed) {
                throw new ArgumentException("A valid open file handle is required.", "handle");
            }
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            return FormatIdentity(info);
        }

        public static SafeFileHandle OpenDirectoryReadLock(string path) {
            const uint FILE_READ_ATTRIBUTES = 0x00000080;
            const uint FILE_SHARE_READ = 0x00000001;
            const uint FILE_SHARE_WRITE = 0x00000002;
            const uint OPEN_EXISTING = 3;
            const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
            const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
            SafeFileHandle handle = CreateFile(
                path,
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle == null || handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                if (handle != null) handle.Dispose();
                throw new System.ComponentModel.Win32Exception(error);
            }
            return handle;
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
                return FormatIdentity(info);
            }
        }
    }
}
"@
}

# A separately versioned type avoids stale-type collisions when an already
# running unelevated PowerShell process reloads this module after an updater
# replaces an older RevAgent.NativeFileInfo definition.
if (-not ("RevAgent.NativeLaunchLockV1" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public static class NativeLaunchLockV1 {
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
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(
            string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
            uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        public static string GetIdentityFromHandle(SafeFileHandle handle) {
            if (handle == null || handle.IsInvalid || handle.IsClosed) throw new ArgumentException("A valid file handle is required.", "handle");
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return String.Format(
                System.Globalization.CultureInfo.InvariantCulture,
                "{0:X8}:{1:X8}{2:X8}:{3}",
                info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow, info.NumberOfLinks);
        }

        public static SafeFileHandle OpenDirectoryReadLock(string path) {
            const uint FILE_READ_ATTRIBUTES = 0x00000080;
            const uint FILE_SHARE_READ = 0x00000001;
            const uint FILE_SHARE_WRITE = 0x00000002;
            const uint OPEN_EXISTING = 3;
            const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
            const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
            SafeFileHandle handle = CreateFile(
                path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero, OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            if (handle == null || handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                if (handle != null) handle.Dispose();
                throw new System.ComponentModel.Win32Exception(error);
            }
            return handle;
        }
    }
}
"@
}

if (-not ("RevAgent.NativeProcessJobV1" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public static class NativeProcessJobV1 {
        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        private const int JobObjectBasicAccountingInformation = 1;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            SafeFileHandle job, int informationClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(
            SafeFileHandle job, int informationClass,
            out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
            uint informationLength, IntPtr returnLength);

        public static SafeFileHandle CreateKillOnCloseJob() {
            SafeFileHandle job = CreateJobObject(IntPtr.Zero, null);
            if (job == null || job.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                if (job != null) job.Dispose();
                throw new Win32Exception(error);
            }
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(
                job, JobObjectExtendedLimitInformation, ref limits,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) {
                int error = Marshal.GetLastWin32Error();
                job.Dispose();
                throw new Win32Exception(error);
            }
            return job;
        }

        public static void Terminate(SafeFileHandle job, uint exitCode) {
            if (!TerminateJobObject(job, exitCode)) {
                int error = Marshal.GetLastWin32Error();
                // ERROR_ACCESS_DENIED is returned when every process already exited.
                if (error != 5) throw new Win32Exception(error);
            }
        }

        public static uint GetActiveProcessCount(SafeFileHandle job) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
            if (!QueryInformationJobObject(
                job, JobObjectBasicAccountingInformation, out accounting,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return accounting.ActiveProcesses;
        }
    }
}
"@
}

# Process.Start() begins executing before AssignProcessToJobObject can run. A
# fast child can therefore escape the job. This native launcher creates the
# process suspended, assigns it to the already configured kill-on-close job,
# wires redirected stdio, and only then permits the caller to resume it.
if (-not ("RevAgent.NativeSuspendedProcessV2" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public sealed class NativeSuspendedProcessV2 : IDisposable {
        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public int bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        private const int STARTF_USESTDHANDLES = 0x00000100;
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint HANDLE_FLAG_INHERIT = 0x00000001;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcessW(
            string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes,
            bool inheritHandles, uint creationFlags, IntPtr environment,
            string currentDirectory, ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeFileHandle process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(SafeFileHandle thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(SafeFileHandle process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private SafeFileHandle processHandle;
        private SafeFileHandle threadHandle;
        private bool resumed;
        private bool disposed;

        public Process Process { get; private set; }
        public StreamWriter StandardInput { get; private set; }
        public StreamReader StandardOutput { get; private set; }
        public StreamReader StandardError { get; private set; }

        private NativeSuspendedProcessV2() { }

        private static void ThrowLastError(string operation) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }

        private static string BuildEnvironmentBlock(IDictionary overrides) {
            SortedDictionary<string, string> values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
                values[Convert.ToString(entry.Key)] = Convert.ToString(entry.Value) ?? String.Empty;
            }
            if (overrides != null) {
                foreach (DictionaryEntry entry in overrides) {
                    string key = Convert.ToString(entry.Key);
                    if (String.IsNullOrWhiteSpace(key) || key.IndexOf('\0') >= 0 || key.IndexOf('=') >= 0) {
                        throw new ArgumentException("Invalid environment variable name.", "overrides");
                    }
                    string value = Convert.ToString(entry.Value) ?? String.Empty;
                    if (value.IndexOf('\0') >= 0) throw new ArgumentException("Environment value contains NUL.", "overrides");
                    values[key] = value;
                }
            }
            StringBuilder block = new StringBuilder();
            foreach (KeyValuePair<string, string> pair in values) {
                block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
            }
            block.Append('\0');
            return block.ToString();
        }

        public static NativeSuspendedProcessV2 CreateAssigned(
            SafeFileHandle job, string applicationPath, string commandLine,
            string currentDirectory, IDictionary environmentOverrides) {
            if (job == null || job.IsInvalid || job.IsClosed) throw new ArgumentException("A valid job handle is required.", "job");
            if (String.IsNullOrWhiteSpace(applicationPath) || !Path.IsPathRooted(applicationPath)) throw new ArgumentException("An absolute application path is required.", "applicationPath");
            if (String.IsNullOrWhiteSpace(currentDirectory) || !Path.IsPathRooted(currentDirectory)) throw new ArgumentException("An absolute current directory is required.", "currentDirectory");

            SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
            attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            attributes.bInheritHandle = 1;
            IntPtr stdinRead = IntPtr.Zero, stdinWrite = IntPtr.Zero;
            IntPtr stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero;
            IntPtr stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero;
            PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
            IntPtr environment = IntPtr.Zero;
            NativeSuspendedProcessV2 result = null;
            try {
                if (!CreatePipe(out stdinRead, out stdinWrite, ref attributes, 0)) ThrowLastError("CreatePipe(stdin) failed");
                if (!CreatePipe(out stdoutRead, out stdoutWrite, ref attributes, 0)) ThrowLastError("CreatePipe(stdout) failed");
                if (!CreatePipe(out stderrRead, out stderrWrite, ref attributes, 0)) ThrowLastError("CreatePipe(stderr) failed");
                if (!SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0)) ThrowLastError("SetHandleInformation(stdin) failed");
                if (!SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0)) ThrowLastError("SetHandleInformation(stdout) failed");
                if (!SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0)) ThrowLastError("SetHandleInformation(stderr) failed");

                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                startup.dwFlags = STARTF_USESTDHANDLES;
                startup.hStdInput = stdinRead;
                startup.hStdOutput = stdoutWrite;
                startup.hStdError = stderrWrite;
                string environmentBlock = BuildEnvironmentBlock(environmentOverrides);
                environment = Marshal.StringToHGlobalUni(environmentBlock);
                StringBuilder mutableCommandLine = new StringBuilder(commandLine);
                if (!CreateProcessW(
                    applicationPath, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                    environment, currentDirectory, ref startup, out pi)) {
                    ThrowLastError("CreateProcessW(CREATE_SUSPENDED) failed");
                }

                result = new NativeSuspendedProcessV2();
                result.processHandle = new SafeFileHandle(pi.hProcess, true); pi.hProcess = IntPtr.Zero;
                result.threadHandle = new SafeFileHandle(pi.hThread, true); pi.hThread = IntPtr.Zero;
                if (!AssignProcessToJobObject(job, result.processHandle)) ThrowLastError("AssignProcessToJobObject before resume failed");

                // Parent must not keep the child pipe endpoints alive.
                CloseHandle(stdinRead); stdinRead = IntPtr.Zero;
                CloseHandle(stdoutWrite); stdoutWrite = IntPtr.Zero;
                CloseHandle(stderrWrite); stderrWrite = IntPtr.Zero;

                SafeFileHandle stdinParent = new SafeFileHandle(stdinWrite, true); stdinWrite = IntPtr.Zero;
                SafeFileHandle stdoutParent = new SafeFileHandle(stdoutRead, true); stdoutRead = IntPtr.Zero;
                SafeFileHandle stderrParent = new SafeFileHandle(stderrRead, true); stderrRead = IntPtr.Zero;
                result.StandardInput = new StreamWriter(new FileStream(stdinParent, FileAccess.Write, 4096, false), new UTF8Encoding(false));
                result.StandardInput.AutoFlush = true;
                result.StandardOutput = new StreamReader(new FileStream(stdoutParent, FileAccess.Read, 4096, false), new UTF8Encoding(false), true, 4096);
                result.StandardError = new StreamReader(new FileStream(stderrParent, FileAccess.Read, 4096, false), new UTF8Encoding(false), true, 4096);
                result.Process = Process.GetProcessById(pi.dwProcessId);
                IntPtr ignored = result.Process.Handle;
                return result;
            }
            catch {
                if (result != null) {
                    try { if (result.processHandle != null && !result.processHandle.IsInvalid) TerminateProcess(result.processHandle, 137); } catch { }
                    result.Dispose();
                } else if (pi.hProcess != IntPtr.Zero) {
                    SafeFileHandle failedProcess = new SafeFileHandle(pi.hProcess, true); pi.hProcess = IntPtr.Zero;
                    try { TerminateProcess(failedProcess, 137); } catch { }
                    failedProcess.Dispose();
                }
                throw;
            }
            finally {
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
                if (stdinRead != IntPtr.Zero) CloseHandle(stdinRead);
                if (stdinWrite != IntPtr.Zero) CloseHandle(stdinWrite);
                if (stdoutRead != IntPtr.Zero) CloseHandle(stdoutRead);
                if (stdoutWrite != IntPtr.Zero) CloseHandle(stdoutWrite);
                if (stderrRead != IntPtr.Zero) CloseHandle(stderrRead);
                if (stderrWrite != IntPtr.Zero) CloseHandle(stderrWrite);
            }
        }

        public void Resume() {
            if (disposed) throw new ObjectDisposedException("NativeSuspendedProcessV2");
            if (resumed) return;
            uint previousSuspendCount = ResumeThread(threadHandle);
            if (previousSuspendCount == UInt32.MaxValue) ThrowLastError("ResumeThread failed");
            resumed = true;
        }

        public bool HasExited { get { return Process == null || Process.HasExited; } }
        public int ExitCode { get { return Process.ExitCode; } }
        public bool WaitForExit(int milliseconds) { return Process == null || Process.WaitForExit(milliseconds); }
        public void Kill() {
            if (processHandle != null && !processHandle.IsInvalid && !processHandle.IsClosed) {
                if (!TerminateProcess(processHandle, 137)) {
                    int error = Marshal.GetLastWin32Error();
                    if (error != 5) throw new Win32Exception(error);
                }
            }
        }

        public void Dispose() {
            if (disposed) return;
            disposed = true;
            try { if (StandardInput != null) StandardInput.Dispose(); } catch { }
            try { if (StandardOutput != null) StandardOutput.Dispose(); } catch { }
            try { if (StandardError != null) StandardError.Dispose(); } catch { }
            try { if (Process != null) Process.Dispose(); } catch { }
            if (threadHandle != null) threadHandle.Dispose();
            if (processHandle != null) processHandle.Dispose();
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

function Open-RevAgentSafeUserProbeRootGuard {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot
    )

    $fullPath = Get-RevAgentFullPath $Path
    $fullRoot = Get-RevAgentFullPath $AllowedRoot
    [void](Assert-RevAgentSafeUserPath -Path $fullPath -AllowedRoot $fullRoot -LeafKind Directory)
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing a reparse-point Codex probe root: $fullPath"
    }
    $handle = $null
    try {
        # This handle omits FILE_SHARE_DELETE and opens the directory itself
        # (including OPEN_REPARSE_POINT), preventing root rename/replacement for
        # the full probe and bounded child cleanup lifetime.
        $handle = [RevAgent.NativeFileInfo]::OpenDirectoryReadLock($fullPath)
        $identity = [string][RevAgent.NativeFileInfo]::GetIdentityFromHandle($handle)
        $after = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
        if (($after.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Codex probe root changed to a reparse point before its identity lock: $fullPath"
        }
        $pathHandle = [RevAgent.NativeFileInfo]::OpenDirectoryReadLock($fullPath)
        try { $pathIdentity = [string][RevAgent.NativeFileInfo]::GetIdentityFromHandle($pathHandle) }
        finally { $pathHandle.Dispose() }
        if (-not [string]::Equals($identity, $pathIdentity, [StringComparison]::Ordinal)) {
            throw "Codex probe root identity changed while its launch guard was acquired: $fullPath"
        }
        return [pscustomobject][ordered]@{ path = $fullPath; allowedRoot = $fullRoot; identity = $identity; handle = $handle }
    }
    catch {
        if ($null -ne $handle) { $handle.Dispose() }
        throw
    }
}

function Clear-RevAgentSafeUserProbeDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ProbeRoot,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [Parameter(Mandatory = $true)][object]$State,
        [int]$Depth = 0
    )

    if ($Depth -gt 32) { throw "Codex probe cleanup exceeded its maximum directory depth: $Path" }
    $fullPath = Get-RevAgentFullPath $Path
    $fullProbeRoot = Get-RevAgentFullPath $ProbeRoot
    if (-not (Test-RevAgentPathWithinRoot -Path $fullPath -Root $fullProbeRoot)) {
        throw "Codex probe cleanup escaped its exact root. path=$fullPath root=$fullProbeRoot"
    }
    [void](Assert-RevAgentSafeUserPath -Path $fullPath -AllowedRoot $AllowedRoot -LeafKind Directory)
    $directoryHandle = [RevAgent.NativeFileInfo]::OpenDirectoryReadLock($fullPath)
    try {
        $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Codex probe cleanup refuses to traverse a reparse directory: $fullPath"
        }
        foreach ($child in @([IO.DirectoryInfo]::new($fullPath).GetFileSystemInfos())) {
            $State.itemCount = [int]$State.itemCount + 1
            if ([int]$State.itemCount -gt [int]$State.maxItems) {
                throw "Codex probe cleanup exceeded its bounded item count under: $fullProbeRoot"
            }
            $childPath = Get-RevAgentFullPath $child.FullName
            if (-not (Test-RevAgentPathWithinRoot -Path $childPath -Root $fullProbeRoot)) {
                throw "Codex probe cleanup encountered an out-of-root child path: $childPath"
            }
            $isDirectory = ($child.Attributes -band [IO.FileAttributes]::Directory) -ne 0
            $isReparse = ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
            if ($isDirectory) {
                if ($isReparse) {
                    # Non-recursive Directory.Delete unlinks the reparse entry;
                    # it never enumerates or deletes the target tree.
                    [IO.Directory]::Delete($childPath, $false)
                }
                else {
                    Clear-RevAgentSafeUserProbeDirectory -Path $childPath -ProbeRoot $fullProbeRoot -AllowedRoot $AllowedRoot -State $State -Depth ($Depth + 1)
                    [IO.Directory]::Delete($childPath, $false)
                }
            }
            else {
                # File.Delete removes only this directory entry. Hard links and
                # file symlinks cannot cause target content traversal.
                [IO.File]::Delete($childPath)
            }
        }
        if (@([IO.DirectoryInfo]::new($fullPath).GetFileSystemInfos()).Count -ne 0) {
            throw "Codex probe cleanup remained non-empty after bounded leaf-first cleanup: $fullPath"
        }
    }
    finally { $directoryHandle.Dispose() }
}

function Close-RevAgentSafeUserProbeRootGuard {
    param(
        [AllowNull()][object]$Guard,
        [switch]$Remove
    )

    if ($null -eq $Guard) { return }
    $cleanupError = $null
    try {
        if ($Remove) {
            $lockedIdentity = [string][RevAgent.NativeFileInfo]::GetIdentityFromHandle($Guard.handle)
            if (-not [string]::Equals($lockedIdentity, [string]$Guard.identity, [StringComparison]::Ordinal)) {
                throw "Codex probe root identity changed while locked: $($Guard.path)"
            }
            $state = [pscustomobject]@{ itemCount = 0; maxItems = 2048 }
            Clear-RevAgentSafeUserProbeDirectory -Path $Guard.path -ProbeRoot $Guard.path -AllowedRoot $Guard.allowedRoot -State $state
        }
    }
    catch { $cleanupError = $_ }
    finally { $Guard.handle.Dispose() }

    if ($Remove -and $null -eq $cleanupError) {
        try {
            [void](Assert-RevAgentSafeUserPath -Path $Guard.path -AllowedRoot $Guard.allowedRoot -LeafKind Directory)
            $item = Get-Item -LiteralPath $Guard.path -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Codex probe root became a reparse point before final unlink: $($Guard.path)"
            }
            $finalHandle = [RevAgent.NativeFileInfo]::OpenDirectoryReadLock($Guard.path)
            try { $finalIdentity = [string][RevAgent.NativeFileInfo]::GetIdentityFromHandle($finalHandle) }
            finally { $finalHandle.Dispose() }
            if (-not [string]::Equals($finalIdentity, [string]$Guard.identity, [StringComparison]::Ordinal)) {
                throw "Codex probe root identity changed before final unlink: $($Guard.path)"
            }
            # The final delete is deliberately non-recursive. Any late child or
            # identity race fails without traversing attacker-controlled state.
            [IO.Directory]::Delete([string]$Guard.path, $false)
            if (Test-Path -LiteralPath $Guard.path) { throw "Codex probe root reappeared during final cleanup: $($Guard.path)" }
        }
        catch { $cleanupError = $_ }
    }
    if ($null -ne $cleanupError) {
        throw "Codex probe cleanup failed closed; user config must remain unchanged. path=$($Guard.path) error=$($cleanupError.Exception.Message)"
    }
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

    $stream = $null
    $sha256 = $null
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        $hashBytes = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($hashBytes) -replace "-", "").ToUpperInvariant()
    }
    finally {
        if ($null -ne $sha256) { $sha256.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
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
    if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($slashes * 2) + 1)))
            [void]$builder.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
        [void]$builder.Append($character)
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * ($slashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Stop-RevAgentGuardedProcessTree {
    [CmdletBinding()]
    param(
        [AllowNull()][object]$Process,
        [AllowNull()][object]$Job,
        [bool]$ProcessStarted,
        [switch]$ForceTerminate,
        [ValidateRange(100, 15000)][int]$WaitMilliseconds = 5000
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    $terminationRequested = $false
    $jobEmpty = $null -eq $Job
    $parentExited = -not $ProcessStarted
    if ($null -ne $Job) {
        try {
            $active = [uint32][RevAgent.NativeProcessJobV1]::GetActiveProcessCount($Job)
            if ($ForceTerminate -or $active -gt 0) {
                [RevAgent.NativeProcessJobV1]::Terminate($Job, 137)
                $terminationRequested = $true
            }
        }
        catch { $errors.Add('job termination failed: ' + $_.Exception.Message) }
    }
    elseif ($ProcessStarted -and $null -ne $Process) {
        try {
            if (-not $Process.HasExited) {
                $Process.Kill()
                $terminationRequested = $true
            }
        }
        catch { $errors.Add('parent termination failed: ' + $_.Exception.Message) }
    }

    $deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMilliseconds)
    if ($ProcessStarted -and $null -ne $Process) {
        try {
            $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
            if (-not $Process.HasExited) { [void]$Process.WaitForExit($remaining) }
            $parentExited = $Process.HasExited
        }
        catch { $errors.Add('parent wait failed: ' + $_.Exception.Message) }
    }
    if ($null -ne $Job) {
        while ([DateTime]::UtcNow -lt $deadline) {
            try {
                $jobEmpty = [uint32][RevAgent.NativeProcessJobV1]::GetActiveProcessCount($Job) -eq 0
                if ($jobEmpty) { break }
            }
            catch {
                $errors.Add('job drain check failed: ' + $_.Exception.Message)
                break
            }
            Start-Sleep -Milliseconds 25
        }
    }
    if (-not $parentExited) { $errors.Add('parent process did not exit before the cleanup deadline') }
    if (-not $jobEmpty) { $errors.Add('process job did not drain before the cleanup deadline') }
    return [pscustomobject][ordered]@{
        success = $parentExited -and $jobEmpty -and $errors.Count -eq 0
        parentExited = $parentExited
        jobEmpty = $jobEmpty
        terminationRequested = $terminationRequested
        error = $errors -join '; '
    }
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

    $fullActualFile = Get-RevAgentFullPath $actualFile
    $workingDirectory = Split-Path -Parent $fullActualFile
    if ([string]::IsNullOrWhiteSpace($workingDirectory) -or -not (Test-Path -LiteralPath $workingDirectory -PathType Container)) {
        throw "Executable directory is missing; refusing inherited current-directory launch. path=$fullActualFile"
    }
    $argumentLine = if (-not [string]::IsNullOrWhiteSpace($batchArgumentLine)) {
        (ConvertTo-RevAgentWindowsArgument -Value $fullActualFile) + ' ' + $batchArgumentLine
    }
    else {
        (@($fullActualFile) + @($actualArguments) | ForEach-Object { ConvertTo-RevAgentWindowsArgument -Value ([string]$_) }) -join ' '
    }

    $process = $null
    $job = $null
    $started = $false
    $cleanup = $null
    try {
        $job = [RevAgent.NativeProcessJobV1]::CreateKillOnCloseJob()
        $process = [RevAgent.NativeSuspendedProcessV2]::CreateAssigned($job, $fullActualFile, $argumentLine, $workingDirectory, $Environment)
        $started = $true
        $process.Resume()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $cleanup = Stop-RevAgentGuardedProcessTree -Process $process -Job $job -ProcessStarted $started -ForceTerminate
            $cleanupError = if ($cleanup.success) { '' } else { ' Cleanup failed: ' + $cleanup.error }
            return [pscustomobject][ordered]@{
                exitCode = -1; timedOut = $true; stdout = ''
                stderr = "Timed out after $TimeoutSeconds seconds.$cleanupError"
                processTreeTerminated = [bool]$cleanup.success
            }
        }
        $exitCode = $process.ExitCode
        # A successful parent may still have spawned a child which inherited
        # redirected handles. Drain/terminate the whole job before waiting on
        # output tasks so no orphan can outlive the executable/path guards.
        $cleanup = Stop-RevAgentGuardedProcessTree -Process $process -Job $job -ProcessStarted $started
        if (-not $cleanup.success) {
            return [pscustomobject][ordered]@{ exitCode = -1; timedOut = $false; stdout = ''; stderr = 'Process-tree cleanup failed: ' + $cleanup.error; processTreeTerminated = $false }
        }
        $stdout = if ($stdoutTask.Wait(2000)) { $stdoutTask.Result } else { '' }
        $stderr = if ($stderrTask.Wait(2000)) { $stderrTask.Result } else { 'Redirected process output did not drain after process-tree cleanup.' }
        return [pscustomobject][ordered]@{ exitCode = $exitCode; timedOut = $false; stdout = $stdout.Trim(); stderr = $stderr.Trim(); processTreeTerminated = $true }
    }
    catch {
        if ($started) { $cleanup = Stop-RevAgentGuardedProcessTree -Process $process -Job $job -ProcessStarted $started -ForceTerminate }
        $cleanupError = if ($null -eq $cleanup -or $cleanup.success) { '' } else { ' Cleanup failed: ' + $cleanup.error }
        return [pscustomobject][ordered]@{ exitCode = -1; timedOut = $false; stdout = ''; stderr = $_.Exception.Message + $cleanupError; processTreeTerminated = $null -ne $cleanup -and [bool]$cleanup.success }
    }
    finally {
        if ($started -and ($null -eq $cleanup -or -not $cleanup.success)) {
            [void](Stop-RevAgentGuardedProcessTree -Process $process -Job $job -ProcessStarted $started -ForceTerminate)
        }
        if ($null -ne $job) { $job.Dispose() }
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Get-RevAgentSignatureStatus {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
        $subject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { "" }
        $valid = [string]$signature.Status -eq 'Valid'
        return [pscustomobject][ordered]@{
            status = [string]$signature.Status
            subject = $subject
            openAi = $valid -and [string]::Equals($subject, $script:RevAgentOpenAiSignerSubject, [System.StringComparison]::Ordinal)
            openJs = $valid -and [string]::Equals($subject, $script:RevAgentOpenJsSignerSubject, [System.StringComparison]::Ordinal)
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
        # Protection is a property of the ACL, not of whether the current
        # caller is an authorized administrator. Elevated machine phase code
        # must be able to create/attest a ProgramData executable without
        # misclassifying its own Administrators write grant as user-writable.
        protected = $ownerTrusted -and $foreignWriteRules.Count -eq 0
    }
}

function Get-RevAgentProtectedPathChainAttestation {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$TrustedRoot,
        [ValidateSet('File', 'Directory')][string]$LeafKind = 'File',
        [switch]$AllowHardLinkedLeaf
    )

    $fullPath = Get-RevAgentFullPath $Path
    $fullRoot = (Get-RevAgentFullPath $TrustedRoot).TrimEnd('\')
    if (-not (Test-RevAgentPathWithinRoot -Path $fullPath -Root $fullRoot)) {
        throw "Protected path is outside its trusted root. path=$fullPath root=$fullRoot"
    }
    [void](Assert-RevAgentSafeUserPath -Path $fullPath -AllowedRoot $fullRoot -LeafKind $LeafKind -AllowHardLinkedLeaf:$AllowHardLinkedLeaf)
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

function Close-RevAgentExecutableLaunchGuard {
    param([AllowNull()][object]$Guard)

    if ($null -eq $Guard) { return }
    if ($null -ne $Guard.fileStream) {
        try { $Guard.fileStream.Dispose() } catch {}
    }
    $handles = @($Guard.directoryHandles)
    for ($index = $handles.Count - 1; $index -ge 0; $index--) {
        if ($null -ne $handles[$index]) {
            try { $handles[$index].Dispose() } catch {}
        }
    }
}

function Open-RevAgentExecutableLaunchGuard {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedFileIdentity,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [ValidateRange(1, 1024)][int]$ExpectedLinkCount = 1,
        [string]$ExpectedSignerSubject = '',
        [switch]$RequireProtectedPath,
        [switch]$AllowHardLinkedLeaf
    )

    $fullPath = Get-RevAgentFullPath $Path
    $fullRoot = (Get-RevAgentFullPath $AllowedRoot).TrimEnd('\')
    if (-not (Test-RevAgentPathWithinRoot -Path $fullPath -Root $fullRoot)) {
        throw "Executable launch path escaped its attested root. path=$fullPath root=$fullRoot"
    }
    [void](Assert-RevAgentSafeUserPath -Path $fullPath -AllowedRoot $fullRoot -LeafKind File -AllowHardLinkedLeaf:$AllowHardLinkedLeaf)

    $directoryHandles = [System.Collections.Generic.List[object]]::new()
    $fileStream = $null
    $guard = $null
    try {
        # Lock the allowed root and every descendant directory leading to the
        # executable without FILE_SHARE_DELETE. This prevents a pathname swap
        # through either the leaf or a renamed parent while Process.Start opens
        # the exact verified path.
        $directoryPaths = [System.Collections.Generic.List[string]]::new()
        $directoryPaths.Add($fullRoot)
        $parent = Split-Path -Parent $fullPath
        $relativeParent = $parent.Substring($fullRoot.Length).TrimStart('\')
        $cursor = $fullRoot
        foreach ($segment in @($relativeParent -split '\\' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
            $cursor = Join-Path $cursor $segment
            $directoryPaths.Add($cursor)
        }
        foreach ($directoryPath in $directoryPaths) {
            $item = Get-Item -LiteralPath $directoryPath -Force -ErrorAction Stop
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Executable launch directory is missing, non-directory, or a reparse point: $directoryPath"
            }
            $directoryHandles.Add([RevAgent.NativeLaunchLockV1]::OpenDirectoryReadLock($directoryPath))
        }

        $fileStream = [IO.File]::Open($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        [void](Assert-RevAgentSafeUserPath -Path $fullPath -AllowedRoot $fullRoot -LeafKind File -AllowHardLinkedLeaf:$AllowHardLinkedLeaf)
        $linkCount = [int][RevAgent.NativeFileInfo]::GetLinkCountFromHandle($fileStream.SafeFileHandle)
        $fileIdentity = [string][RevAgent.NativeLaunchLockV1]::GetIdentityFromHandle($fileStream.SafeFileHandle)
        $pathIdentity = Get-RevAgentFileIdentity -Path $fullPath
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $fileStream.Position = 0
            $sha256 = ([BitConverter]::ToString($sha.ComputeHash($fileStream))).Replace('-', '')
            $fileStream.Position = 0
        }
        finally { $sha.Dispose() }
        $signature = if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
            [pscustomobject]@{ status = 'NotRequired'; subject = '' }
        }
        else { Get-RevAgentSignatureStatus -Path $fullPath }
        $protection = if ($RequireProtectedPath) {
            Get-RevAgentProtectedPathChainAttestation -Path $fullPath -TrustedRoot $fullRoot -LeafKind File -AllowHardLinkedLeaf:$AllowHardLinkedLeaf
        }
        else { $null }

        if ($linkCount -ne $ExpectedLinkCount -or
            -not [string]::Equals($fileIdentity, $pathIdentity, [StringComparison]::Ordinal) -or
            -not [string]::Equals($fileIdentity, $ExpectedFileIdentity, [StringComparison]::Ordinal) -or
            -not [string]::Equals($sha256, $ExpectedSha256, [StringComparison]::OrdinalIgnoreCase) -or
            (-not [string]::IsNullOrWhiteSpace($ExpectedSignerSubject) -and
                (-not [string]::Equals([string]$signature.status, 'Valid', [StringComparison]::Ordinal) -or
                 -not [string]::Equals([string]$signature.subject, $ExpectedSignerSubject, [StringComparison]::Ordinal))) -or
            ($RequireProtectedPath -and ($null -eq $protection -or -not [bool]$protection.protected))) {
            throw "Executable identity, signer, protection, or pathname changed before guarded launch. path=$fullPath"
        }

        $guard = [pscustomobject][ordered]@{
            path = $fullPath
            allowedRoot = $fullRoot
            fileStream = $fileStream
            directoryHandles = @($directoryHandles)
            fileIdentity = $fileIdentity
            sha256 = $sha256
            linkCount = $linkCount
            signatureStatus = [string]$signature.status
            signerSubject = [string]$signature.subject
            protection = $protection
        }
        $fileStream = $null
        $directoryHandles.Clear()
        return $guard
    }
    catch {
        if ($null -ne $fileStream) { try { $fileStream.Dispose() } catch {} }
        for ($index = $directoryHandles.Count - 1; $index -ge 0; $index--) {
            try { $directoryHandles[$index].Dispose() } catch {}
        }
        throw
    }
}

function Invoke-RevAgentIdentityLockedProcessProbe {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedFileIdentity,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [ValidateRange(1, 1024)][int]$ExpectedLinkCount = 1,
        [string]$ExpectedSignerSubject = '',
        [switch]$RequireProtectedPath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 15,
        [hashtable]$Environment = @{},
        [Parameter(DontShow = $true)][scriptblock]$TestAfterLockHook
    )

    $guard = Open-RevAgentExecutableLaunchGuard -Path $Path -AllowedRoot $AllowedRoot `
        -ExpectedFileIdentity $ExpectedFileIdentity -ExpectedSha256 $ExpectedSha256 `
        -ExpectedLinkCount $ExpectedLinkCount -ExpectedSignerSubject $ExpectedSignerSubject `
        -RequireProtectedPath:$RequireProtectedPath
    try {
        if ($null -ne $TestAfterLockHook) { & $TestAfterLockHook $guard.path $guard }
        return Invoke-RevAgentProcessProbe -FilePath $guard.path -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds -Environment $Environment
    }
    finally { Close-RevAgentExecutableLaunchGuard -Guard $guard }
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
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [switch]$AllowHardLinkedLeaf
    )

    $fullPath = Get-RevAgentFullPath $Path
    $safe = $false
    $safetyError = ''
    try {
        [void](Assert-RevAgentSafeUserPath -Path $fullPath -AllowedRoot $AllowedRoot -LeafKind File -AllowHardLinkedLeaf:$AllowHardLinkedLeaf)
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
        allowHardLinkedLeaf = [bool]$AllowHardLinkedLeaf
    }
}

function Assert-RevAgentCodexPackageBindingUnchanged {
    param([Parameter(Mandatory = $true)][object]$Candidate)

    if ([string]::Equals([string]$Candidate.origin, 'official-standalone-user-package', [StringComparison]::Ordinal)) {
        throw "Windows standalone Codex execution is disabled because the official installer does not persist an authenticated package receipt/hash chain. Install the OpenAI.Codex Store package. path=$($Candidate.path)"
    }
    if (-not [string]::Equals([string]$Candidate.origin, 'protected-active-store-copy', [StringComparison]::Ordinal)) { return }
    $activePackage = Get-RevAgentActiveUnifiedCodexCliAttestation -IncludeLocalMirrorDiagnostics:$false
    if (-not [bool]$activePackage.success -or -not [bool]$Candidate.packageBound -or
        -not [string]::Equals([string]$activePackage.packageFullName, [string]$Candidate.packageFullName, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$activePackage.packageCliSha256, [string]$Candidate.packageCliSha256, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$activePackage.installLocation, [string]$Candidate.packageInstallLocation, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Codex CLI is no longer bound to the same active signed OpenAI.Codex package; refusing execution. path=$($Candidate.path)"
    }
    $protectedCopy = Get-RevAgentProtectedCodexCliAttestation -InstallRoot $Candidate.installRoot -ActivePackageAttestation $activePackage -TargetUserSid $Candidate.targetUserSid
    if (-not [bool]$protectedCopy.success -or -not [string]::Equals([string]$protectedCopy.path, [string]$Candidate.path, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Codex CLI protected receipt/user binding changed before execution. path=$($Candidate.path) sid=$($Candidate.targetUserSid) reason=$($protectedCopy.reason)"
    }
}

function Open-RevAgentCodexExecutableLaunchGuard {
    param([Parameter(Mandatory = $true)][object]$Candidate)

    if (-not [bool]$Candidate.originAttested -or -not [bool]$Candidate.trusted) {
        throw "Codex CLI candidate does not carry an executable origin attestation: $($Candidate.path)"
    }
    $origin = [string]$Candidate.origin
    if ($origin -ne 'protected-active-store-copy') {
        throw "Codex CLI candidate origin is not executable: $origin"
    }
    if ([int]$Candidate.linkCount -ne 1) {
        throw "Codex CLI executable must have exactly one hard link before launch: $($Candidate.path)"
    }
    $requireProtectedPath = $true
    $guard = Open-RevAgentExecutableLaunchGuard -Path $Candidate.path -AllowedRoot $Candidate.attestationRoot `
        -ExpectedFileIdentity $Candidate.fileIdentity -ExpectedSha256 $Candidate.sha256 -ExpectedLinkCount 1 `
        -ExpectedSignerSubject $script:RevAgentOpenAiSignerSubject -RequireProtectedPath:$requireProtectedPath
    try {
        Assert-RevAgentCodexPackageBindingUnchanged -Candidate $Candidate
        return $guard
    }
    catch {
        Close-RevAgentExecutableLaunchGuard -Guard $guard
        throw
    }
}

function Assert-RevAgentCodexExecutableUnchanged {
    param([Parameter(Mandatory = $true)][object]$Candidate)

    $guard = $null
    try {
        $guard = Open-RevAgentCodexExecutableLaunchGuard -Candidate $Candidate
        return [pscustomobject][ordered]@{
            path = $guard.path; safe = $true; safetyError = ''; linkCount = $guard.linkCount
            fileIdentity = $guard.fileIdentity; sha256 = $guard.sha256
            signatureStatus = $guard.signatureStatus; signerSubject = $guard.signerSubject; openAiSigned = $true
        }
    }
    catch {
        throw "Codex CLI identity changed after attestation; refusing execution. path=$($Candidate.path) error=$($_.Exception.Message)"
    }
    finally { Close-RevAgentExecutableLaunchGuard -Guard $guard }
}

function Invoke-RevAgentGuardedCodexProcessProbe {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Candidate,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 15,
        [hashtable]$Environment = @{},
        [Parameter(DontShow = $true)][scriptblock]$TestAfterLockHook
    )

    $guard = $null
    try {
        try { $guard = Open-RevAgentCodexExecutableLaunchGuard -Candidate $Candidate }
        catch { throw "Codex CLI identity changed after attestation; refusing execution. path=$($Candidate.path) error=$($_.Exception.Message)" }
        if ($null -ne $TestAfterLockHook) { & $TestAfterLockHook $guard.path $guard }
        return Invoke-RevAgentProcessProbe -FilePath $guard.path -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds -Environment $Environment
    }
    finally { Close-RevAgentExecutableLaunchGuard -Guard $guard }
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

function Test-RevAgentCodexUltraUnsupportedDiagnostic {
    param([AllowEmptyString()][string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text) -or $Text -notmatch '(?i)\bultra\b') { return $false }
    # Treat only an explicit value/variant rejection as evidence that this CLI
    # cannot parse Ultra. A timeout, malformed JSON response, unrelated config
    # error, or process failure must never authorize mutation of user config.
    return $Text -match '(?is)(?:(?:unknown\s+variant|unsupported(?:\s+(?:value|variant))?|not\s+supported|invalid\s+(?:value|variant))[^\r\n]{0,160}\bultra\b|\bultra\b[^\r\n]{0,160}(?:unsupported|not\s+supported|invalid))'
}

function Invoke-RevAgentCodexReasoningEffortCapabilityProbe {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Candidate,
        [Parameter(Mandatory = $true)][string]$LocalAppData,
        [Parameter(Mandatory = $true)][ValidateSet('ultra', 'xhigh')][string]$Effort
    )

    $localRoot = Get-RevAgentFullPath $LocalAppData
    $probeHome = Join-Path $localRoot ("revAgent\codex-reasoning-capability\$Effort\" + [Guid]::NewGuid().ToString('N'))
    [void](New-RevAgentSafeUserDirectory -Path $probeHome -AllowedRoot $localRoot)
    $probeRootGuard = Open-RevAgentSafeUserProbeRootGuard -Path $probeHome -AllowedRoot $localRoot
    $configPath = Join-Path $probeHome 'config.toml'
    $probe = $null
    $diagnostic = ''
    $configSha256 = ''
    try {
        [void](Assert-RevAgentSafeUserPath -Path $configPath -AllowedRoot $localRoot -LeafKind File -AllowMissing)
        $stream = [IO.File]::Open($configPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = $script:RevAgentUtf8NoBom.GetBytes("model_reasoning_effort = `"$Effort`"`r`n")
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        [void](Assert-RevAgentSafeUserPath -Path $configPath -AllowedRoot $localRoot -LeafKind File)
        $configSha256 = Get-RevAgentFileSha256 -Path $configPath
        $probe = Invoke-RevAgentGuardedCodexProcessProbe -Candidate $Candidate -Arguments @('mcp', 'list', '--json') -Environment @{ CODEX_HOME = $probeHome }
        $diagnostic = ([string]$probe.stderr + ' ' + [string]$probe.stdout).Trim()
    }
    catch {
        $diagnostic = $_.Exception.Message
    }
    finally {
        Close-RevAgentSafeUserProbeRootGuard -Guard $probeRootGuard -Remove
    }

    if ($diagnostic.Length -gt 2048) { $diagnostic = $diagnostic.Substring(0, 2048) }
    $exitCode = if ($null -ne $probe) { [int]$probe.exitCode } else { -1 }
    $jsonValid = $null -ne $probe -and $exitCode -eq 0 -and (Test-RevAgentJsonText -Text ([string]$probe.stdout))
    $accepted = $exitCode -eq 0 -and $jsonValid
    $unsupportedUltra = $Effort -eq 'ultra' -and -not $accepted -and (Test-RevAgentCodexUltraUnsupportedDiagnostic -Text $diagnostic)
    $rejectionClass = if ($accepted) { 'accepted' } elseif ($unsupportedUltra) { 'unsupported_or_unknown_ultra' } elseif ($null -eq $probe) { 'probe_failed' } elseif ($exitCode -eq 0) { 'invalid_json' } else { 'unclassified_rejection' }
    return [pscustomobject][ordered]@{
        effort = $Effort; attempted = $true; accepted = $accepted; exitCode = $exitCode; jsonValid = $jsonValid
        unsupportedUltra = $unsupportedUltra; rejectionClass = $rejectionClass; diagnostic = $diagnostic
        isolatedCodexHome = $true; rootOnlyConfig = $true; configSha256 = $configSha256
    }
}

function Get-RevAgentCodexReasoningEffortCompatibility {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Candidate,
        [Parameter(Mandatory = $true)][string]$LocalAppData
    )

    $ultra = Invoke-RevAgentCodexReasoningEffortCapabilityProbe -Candidate $Candidate -LocalAppData $LocalAppData -Effort ultra
    $xhigh = [pscustomobject][ordered]@{
        effort = 'xhigh'; attempted = $false; accepted = $false; exitCode = -1; jsonValid = $false
        unsupportedUltra = $false; rejectionClass = 'not_required'; diagnostic = ''
        isolatedCodexHome = $true; rootOnlyConfig = $true; configSha256 = ''
    }
    $decision = 'fail_closed'
    $compatible = $false
    if ([bool]$ultra.accepted) {
        $decision = 'preserve_supported_ultra'
        $compatible = $true
    }
    elseif ([bool]$ultra.unsupportedUltra) {
        $xhigh = Invoke-RevAgentCodexReasoningEffortCapabilityProbe -Candidate $Candidate -LocalAppData $LocalAppData -Effort xhigh
        if ([bool]$xhigh.accepted) {
            $decision = 'normalize_ultra_to_xhigh'
            $compatible = $true
        }
    }

    return [pscustomobject][ordered]@{
        schemaVersion = 1; probeMode = 'isolated-disposable-root-config'; guardedExecutable = $true
        cliPath = [string]$Candidate.path; cliSha256 = [string]$Candidate.sha256; cliFileIdentity = [string]$Candidate.fileIdentity
        packageFullName = [string]$Candidate.packageFullName; probeCommand = 'mcp list --json'
        ultra = $ultra; xhigh = $xhigh; decision = $decision; compatible = $compatible
    }
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

function Resolve-RevAgentUnifiedCodexPackageCliLayout {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Package,
        [Parameter(Mandatory = $true)][string]$WindowsAppsRoot
    )

    $result = [ordered]@{
        success = $false; reason = 'package_metadata_invalid'; layoutId = ''; relativePath = ''
        packageName = ''; packageVersion = ''; packageFullName = ''; packageFamilyName = ''
        publisher = ''; publisherId = ''; signatureKind = ''; status = ''; architecture = ''
        installLocation = ''; packageCliPath = ''
    }
    try {
        $required = @{}
        foreach ($name in @('Name', 'Version', 'PackageFullName', 'PackageFamilyName', 'Publisher', 'PublisherId', 'SignatureKind', 'Status', 'Architecture', 'InstallLocation', 'IsFramework', 'IsResourcePackage')) {
            $property = Get-RevAgentObjectPropertyInfo -InputObject $Package -Name $name
            if ($null -eq $property) {
                $result.reason = 'package_metadata_missing_' + $name.ToLowerInvariant()
                return [pscustomobject]$result
            }
            $required[$name] = $property.Value
        }

        $result.packageName = [string]$required.Name
        $result.packageVersion = [string]$required.Version
        $result.packageFullName = [string]$required.PackageFullName
        $result.packageFamilyName = [string]$required.PackageFamilyName
        $result.publisher = [string]$required.Publisher
        $result.publisherId = [string]$required.PublisherId
        $result.signatureKind = [string]$required.SignatureKind
        $result.status = [string]$required.Status
        $result.architecture = ([string]$required.Architecture).ToLowerInvariant()

        if (-not [string]::Equals($result.packageName, $script:RevAgentUnifiedCodexPackageName, [StringComparison]::Ordinal) -or
            -not [string]::Equals($result.packageFamilyName, $script:RevAgentUnifiedCodexPackageFamilyName, [StringComparison]::Ordinal) -or
            -not [string]::Equals($result.publisher, $script:RevAgentUnifiedCodexPackagePublisher, [StringComparison]::Ordinal) -or
            -not [string]::Equals($result.publisherId, $script:RevAgentUnifiedCodexPackagePublisherId, [StringComparison]::Ordinal) -or
            -not [string]::Equals($result.signatureKind, 'Store', [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($result.status, 'Ok', [StringComparison]::OrdinalIgnoreCase) -or
            [bool]$required.IsFramework -or [bool]$required.IsResourcePackage -or
            $result.architecture -notin @('x64', 'arm64') -or
            $result.packageVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
            return [pscustomobject]$result
        }

        $expectedFullName = '{0}_{1}_{2}__{3}' -f $result.packageName, $result.packageVersion, $result.architecture, $result.publisherId
        if (-not [string]::Equals($result.packageFullName, $expectedFullName, [StringComparison]::Ordinal)) {
            $result.reason = 'package_full_name_mismatch'
            return [pscustomobject]$result
        }

        $windowsApps = (Get-RevAgentFullPath $WindowsAppsRoot).TrimEnd('\')
        $result.installLocation = Get-RevAgentFullPath ([string]$required.InstallLocation)
        $expectedInstallLocation = Get-RevAgentFullPath (Join-Path $windowsApps $result.packageFullName)
        if (-not [string]::Equals($result.installLocation, $expectedInstallLocation, [StringComparison]::OrdinalIgnoreCase)) {
            $result.reason = 'package_install_location_mismatch'
            return [pscustomobject]$result
        }
        [void](Assert-RevAgentSafeUserPath -Path $result.installLocation -AllowedRoot $windowsApps -LeafKind Directory)

        $matches = [System.Collections.Generic.List[object]]::new()
        foreach ($layout in @($script:RevAgentUnifiedCodexPackageCliLayouts)) {
            $candidate = Get-RevAgentFullPath (Join-Path $result.installLocation ([string]$layout.relativePath))
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $matches.Add([pscustomobject][ordered]@{ id = [string]$layout.id; relativePath = [string]$layout.relativePath; path = $candidate })
            }
        }
        if ($matches.Count -ne 1) {
            $result.reason = if ($matches.Count -eq 0) { 'package_cli_missing' } else { 'package_cli_layout_ambiguous' }
            return [pscustomobject]$result
        }
        $result.layoutId = [string]$matches[0].id
        $result.relativePath = [string]$matches[0].relativePath
        $result.packageCliPath = [string]$matches[0].path
        $result.success = $true
        $result.reason = 'supported_package_layout'
        return [pscustomobject]$result
    }
    catch {
        $result.reason = 'package_layout_error: ' + $_.Exception.Message
        return [pscustomobject]$result
    }
}

function Test-RevAgentAppxBlockMapFileContent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][object]$FileRow,
        [Parameter(Mandatory = $true)][string]$HashMethod
    )

    $result = [ordered]@{ success = $false; reason = 'not_checked'; blockCount = 0; verifiedBytes = 0L }
    $stream = $null
    $sha = $null
    try {
        if (-not [string]::Equals($HashMethod, 'http://www.w3.org/2001/04/xmlenc#sha256', [StringComparison]::Ordinal)) {
            $result.reason = 'unsupported_block_map_hash_method'
            return [pscustomobject]$result
        }
        $expectedLength = [long]$FileRow.Size
        $blocks = @($FileRow.Block)
        if ($expectedLength -lt 0 -or $blocks.Count -eq 0) {
            $result.reason = 'invalid_block_map_file_row'
            return [pscustomobject]$result
        }
        $stream = [IO.File]::Open($FilePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($stream.Length -ne $expectedLength) {
            $result.reason = 'block_map_file_length_mismatch'
            return [pscustomobject]$result
        }
        $buffer = [byte[]]::new(65536)
        $sha = [Security.Cryptography.SHA256]::Create()
        foreach ($block in $blocks) {
            $remaining = $expectedLength - $result.verifiedBytes
            if ($remaining -le 0) {
                $result.reason = 'block_map_has_extra_blocks'
                return [pscustomobject]$result
            }
            $required = [int][Math]::Min([long]$buffer.Length, $remaining)
            $offset = 0
            while ($offset -lt $required) {
                $read = $stream.Read($buffer, $offset, $required - $offset)
                if ($read -le 0) {
                    $result.reason = 'block_map_file_ended_early'
                    return [pscustomobject]$result
                }
                $offset += $read
            }
            $actualHash = [Convert]::ToBase64String($sha.ComputeHash($buffer, 0, $required))
            if (-not [string]::Equals($actualHash, [string]$block.Hash, [StringComparison]::Ordinal)) {
                $result.reason = 'block_hash_mismatch'
                return [pscustomobject]$result
            }
            $result.verifiedBytes += $required
            $result.blockCount++
        }
        if ($result.verifiedBytes -ne $expectedLength -or $stream.ReadByte() -ne -1) {
            $result.reason = 'block_map_coverage_mismatch'
            return [pscustomobject]$result
        }
        $result.success = $true
        $result.reason = 'all_signed_blocks_match'
        return [pscustomobject]$result
    }
    catch {
        $result.reason = 'block_map_verification_error: ' + $_.Exception.Message
        return [pscustomobject]$result
    }
    finally {
        if ($null -ne $sha) { $sha.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-RevAgentActiveUnifiedCodexCliAttestation {
    [CmdletBinding()]
    param(
        [string]$LocalAppData = ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)),
        [switch]$IncludeLocalMirrorDiagnostics,
        [Parameter(DontShow = $true)][scriptblock]$PackageQuery
    )

    if (-not $PSBoundParameters.ContainsKey('IncludeLocalMirrorDiagnostics')) { $IncludeLocalMirrorDiagnostics = $true }

    $result = [ordered]@{
        available = $false; success = $false; reason = 'active_package_query_not_run'
        querySucceeded = $false; absenceConfirmed = $false; queryError = ''; packageCount = 0
        packageName = ''; packageVersion = ''; packageFullName = ''; packageFamilyName = ''
        packagePublisher = ''; packagePublisherId = ''; packageSignatureKind = ''; packageStatus = ''
        installLocation = ''; packageCliLayoutId = ''; packageCliRelativePath = ''
        packageCliPath = ''; packageCliSha256 = ''; packageCliFileIdentity = ''; packageCliLinkCount = 0
        packageCliProtected = $false; packageSignatureStatus = ''; packageSignerSubject = ''
        manifestIdentityAttested = $false; blockMapAttested = $false; blockMapBlockCount = 0; packageIdentityAttested = $false
        userCliPath = ''; localMirrorDiagnosticOnly = $true; localMirrorReason = 'not_checked'; candidates = @()
    }
    try {
        $packages = @()
        if ($null -ne $PackageQuery) {
            $packages = @(& $PackageQuery $script:RevAgentUnifiedCodexPackageName)
        }
        else { $packages = @(Appx\Get-AppxPackage -Name $script:RevAgentUnifiedCodexPackageName -ErrorAction Stop) }
        $result.querySucceeded = $true
        $result.packageCount = $packages.Count
        if ($packages.Count -eq 0) {
            $result.absenceConfirmed = $true
            $result.reason = 'active_package_absence_confirmed'
            return [pscustomobject]$result
        }
        $result.available = $true
        if ($packages.Count -ne 1) {
            $result.reason = 'multiple_active_store_packages_fail_closed'
            return [pscustomobject]$result
        }
        $package = $packages[0]
        $windowsAppsRoot = Join-Path $script:RevAgentOsProgramFiles 'WindowsApps'
        $layout = Resolve-RevAgentUnifiedCodexPackageCliLayout -Package $package -WindowsAppsRoot $windowsAppsRoot
        foreach ($propertyName in @('packageName', 'packageVersion', 'packageFullName', 'packageFamilyName', 'installLocation')) {
            $result[$propertyName] = $layout.$propertyName
        }
        $result.packagePublisher = $layout.publisher
        $result.packagePublisherId = $layout.publisherId
        $result.packageSignatureKind = $layout.signatureKind
        $result.packageStatus = $layout.status
        if (-not $layout.success) {
            $result.reason = $layout.reason
            return [pscustomobject]$result
        }
        $result.packageCliLayoutId = $layout.layoutId
        $result.packageCliRelativePath = $layout.relativePath
        $packageCli = $layout.packageCliPath

        $manifestPath = Join-Path $result.installLocation 'AppxManifest.xml'
        $blockMapPath = Join-Path $result.installLocation 'AppxBlockMap.xml'
        $packageSignaturePath = Join-Path $result.installLocation 'AppxSignature.p7x'
        foreach ($protectedPackageFile in @($manifestPath, $blockMapPath, $packageSignaturePath)) {
            [void](Assert-RevAgentSafeUserPath -Path $protectedPackageFile -AllowedRoot $result.installLocation -LeafKind File)
        }
        $packageSignature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $packageSignaturePath -ErrorAction Stop
        $result.packageSignatureStatus = [string]$packageSignature.Status
        $result.packageSignerSubject = if ($packageSignature.SignerCertificate) { [string]$packageSignature.SignerCertificate.Subject } else { '' }
        if (-not [string]::Equals($result.packageSignatureStatus, 'Valid', [StringComparison]::Ordinal) -or
            -not [string]::Equals($result.packageSignerSubject, $script:RevAgentUnifiedCodexPackagePublisher, [StringComparison]::Ordinal)) {
            $result.reason = 'package_signature_attestation_failed'
            return [pscustomobject]$result
        }

        [xml]$manifest = Get-Content -Raw -LiteralPath $manifestPath -ErrorAction Stop
        $manifestIdentity = $manifest.Package.Identity
        $result.manifestIdentityAttested = $null -ne $manifestIdentity -and
            [string]::Equals([string]$manifestIdentity.Name, $result.packageName, [StringComparison]::Ordinal) -and
            [string]::Equals([string]$manifestIdentity.Version, $result.packageVersion, [StringComparison]::Ordinal) -and
            [string]::Equals([string]$manifestIdentity.Publisher, $result.packagePublisher, [StringComparison]::Ordinal) -and
            [string]::Equals(([string]$manifestIdentity.ProcessorArchitecture).ToLowerInvariant(), $layout.architecture, [StringComparison]::Ordinal)
        if (-not $result.manifestIdentityAttested) {
            $result.reason = 'package_manifest_identity_mismatch'
            return [pscustomobject]$result
        }

        [xml]$blockMap = Get-Content -Raw -LiteralPath $blockMapPath -ErrorAction Stop
        $blockMapRows = @($blockMap.BlockMap.File | Where-Object { [string]::Equals(([string]$_.Name).Replace('/', '\'), $result.packageCliRelativePath, [StringComparison]::OrdinalIgnoreCase) })
        $blockMapVerification = if ($blockMapRows.Count -eq 1) {
            Test-RevAgentAppxBlockMapFileContent -FilePath $packageCli -FileRow $blockMapRows[0] -HashMethod ([string]$blockMap.BlockMap.HashMethod)
        }
        else { [pscustomobject]@{ success = $false; reason = 'package_cli_block_map_row_count_invalid'; blockCount = 0 } }
        $result.blockMapAttested = [bool]$blockMapVerification.success
        $result.blockMapBlockCount = [int]$blockMapVerification.blockCount
        if (-not $result.blockMapAttested) {
            $result.reason = 'package_cli_not_bound_to_signed_block_map: ' + [string]$blockMapVerification.reason
            return [pscustomobject]$result
        }

        $packageProtection = Get-RevAgentProtectedPathChainAttestation -Path $packageCli -TrustedRoot $result.installLocation -LeafKind File -AllowHardLinkedLeaf
        $packageAttestation = Get-RevAgentCodexExecutableAttestation -Path $packageCli -AllowedRoot $result.installLocation -AllowHardLinkedLeaf
        if (-not $packageProtection.protected -or -not $packageAttestation.safe -or -not $packageAttestation.openAiSigned -or $packageAttestation.linkCount -lt 1) {
            $result.reason = 'package_cli_attestation_failed'
            return [pscustomobject]$result
        }
        $result.packageCliPath = $packageAttestation.path
        $result.packageCliSha256 = $packageAttestation.sha256
        $result.packageCliFileIdentity = $packageAttestation.fileIdentity
        $result.packageCliLinkCount = $packageAttestation.linkCount
        $result.packageCliProtected = [bool]$packageProtection.protected
        $result.packageIdentityAttested = $true
        $result.success = $true
        $result.reason = 'attested_active_store_package'
        if (-not $IncludeLocalMirrorDiagnostics) {
            $result.localMirrorReason = 'diagnostics_disabled'
            return [pscustomobject]$result
        }

        # The LocalAppData mirror is attacker-controlled app-local DLL search
        # state. Audit it for diagnostics only; never let its presence, hash, or
        # signer authorize execution and never let malformed mirror state turn
        # a valid Store-package attestation into failure.
        try {
            if ([string]::IsNullOrWhiteSpace($LocalAppData) -or -not (Test-Path -LiteralPath $LocalAppData -PathType Container)) {
                $result.localMirrorReason = 'local_app_data_missing'
                return [pscustomobject]$result
            }
            $localRoot = Get-RevAgentFullPath $LocalAppData
            $bundleRoot = Join-Path $localRoot 'OpenAI\Codex\bin'
            if (-not (Test-Path -LiteralPath $bundleRoot -PathType Container)) {
                $result.localMirrorReason = 'unified_user_bundle_root_missing'
                return [pscustomobject]$result
            }
            [void](Assert-RevAgentSafeUserPath -Path $bundleRoot -AllowedRoot $localRoot -LeafKind Directory)
            $rows = [System.Collections.Generic.List[object]]::new()
            foreach ($directory in @(Get-ChildItem -LiteralPath $bundleRoot -Directory -Force -ErrorAction Stop | Where-Object { $_.Name -match '^[0-9a-fA-F]{16}$' })) {
                $candidatePath = Join-Path $directory.FullName 'codex.exe'
                if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) { continue }
                $candidateAttestation = Get-RevAgentCodexExecutableAttestation -Path $candidatePath -AllowedRoot $localRoot
                $hashMatches = $candidateAttestation.safe -and [string]::Equals([string]$candidateAttestation.sha256, [string]$packageAttestation.sha256, [System.StringComparison]::OrdinalIgnoreCase)
                $rows.Add([pscustomobject][ordered]@{
                    path = $candidateAttestation.path; safe = $candidateAttestation.safe; signatureStatus = $candidateAttestation.signatureStatus
                    signerSubject = $candidateAttestation.signerSubject; linkCount = $candidateAttestation.linkCount
                    sha256 = $candidateAttestation.sha256; hashMatchesActivePackage = $hashMatches; diagnosticOnly = $true
                    matches = $false; safetyError = $candidateAttestation.safetyError
                })
            }
            $result.candidates = @($rows)
            $hashMatches = @($rows | Where-Object hashMatchesActivePackage)
            if ($hashMatches.Count -eq 1) { $result.userCliPath = [string]$hashMatches[0].path }
            $result.localMirrorReason = if ($hashMatches.Count -eq 0) { 'no_hash_matching_user_mirror' } elseif ($hashMatches.Count -eq 1) { 'hash_matching_mirror_diagnostic_only' } else { 'ambiguous_hash_matching_user_mirrors' }
        }
        catch { $result.localMirrorReason = 'mirror_diagnostic_error: ' + $_.Exception.Message }
        return [pscustomobject]$result
    }
    catch {
        $result.queryError = $_.Exception.Message
        $result.reason = 'attestation_error: ' + $_.Exception.Message
        return [pscustomobject]$result
    }
}

function Get-RevAgentProtectedCodexCliPaths {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$PackageFullName,
        [Parameter(Mandatory = $true)][string]$Sha256,
        [Parameter(Mandatory = $true)][string]$TargetUserSid
    )

    if ($PackageFullName -notmatch '^OpenAI\.Codex_\d+\.\d+\.\d+\.\d+_(?:x64|arm64)__2p2nqsd0c76g0$') {
        throw "Unsafe OpenAI.Codex package full name for protected CLI path: $PackageFullName"
    }
    if ($Sha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw 'Protected Codex CLI SHA-256 must contain exactly 64 hexadecimal characters.' }
    try { $normalizedSid = [string]([Security.Principal.SecurityIdentifier]::new($TargetUserSid).Value) }
    catch { throw "Protected Codex CLI target SID is invalid: $TargetUserSid" }
    $root = Get-RevAgentFullPath $InstallRoot
    $storeRoot = Join-Path $root 'codex\cli\store'
    $packageRoot = Join-Path $storeRoot $PackageFullName
    $hashRoot = Join-Path $packageRoot $Sha256.ToUpperInvariant()
    return [pscustomobject][ordered]@{
        installRoot = $root; storeRoot = $storeRoot; packageRoot = $packageRoot; hashRoot = $hashRoot
        targetUserSid = $normalizedSid; cliPath = Join-Path $hashRoot 'codex.exe'; receiptPath = Join-Path $hashRoot ('receipt.' + $normalizedSid + '.json')
    }
}

function Test-RevAgentProtectedCodexReceiptBinding {
    param(
        [Parameter(Mandatory = $true)][object]$Receipt,
        [Parameter(Mandatory = $true)][object]$ActivePackageAttestation,
        [Parameter(Mandatory = $true)][string]$TargetUserSid
    )
    return [int]$Receipt.schemaVersion -eq 1 -and
        [string]::Equals([string]$Receipt.origin, 'OpenAI.Codex-Store-package', [StringComparison]::Ordinal) -and
        [string]::Equals([string]$Receipt.targetUserSid, $TargetUserSid, [StringComparison]::Ordinal) -and
        [string]::Equals([string]$Receipt.packageFullName, [string]$ActivePackageAttestation.packageFullName, [StringComparison]::Ordinal) -and
        [string]::Equals([string]$Receipt.packageVersion, [string]$ActivePackageAttestation.packageVersion, [StringComparison]::Ordinal) -and
        [string]::Equals([string]$Receipt.packageFamilyName, $script:RevAgentUnifiedCodexPackageFamilyName, [StringComparison]::Ordinal) -and
        [string]::Equals([string]$Receipt.packageCliRelativePath, [string]$ActivePackageAttestation.packageCliRelativePath, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$Receipt.packageCliSha256, [string]$ActivePackageAttestation.packageCliSha256, [StringComparison]::OrdinalIgnoreCase)
}

function Get-RevAgentProtectedCodexCliAttestation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][object]$ActivePackageAttestation,
        [Parameter(Mandatory = $true)][string]$TargetUserSid
    )

    $result = [ordered]@{
        available = $false; success = $false; reason = 'protected_store_copy_not_checked'; path = ''; receiptPath = ''
        sha256 = ''; fileIdentity = ''; linkCount = 0; signatureStatus = ''; signerSubject = ''; protectedPath = $false
        packageFullName = [string]$ActivePackageAttestation.packageFullName; packageVersion = [string]$ActivePackageAttestation.packageVersion
        packageCliSha256 = [string]$ActivePackageAttestation.packageCliSha256; receiptAttested = $false; protection = $null
    }
    try {
        if (-not [bool]$ActivePackageAttestation.success -or -not [bool]$ActivePackageAttestation.packageIdentityAttested -or
            -not [bool]$ActivePackageAttestation.blockMapAttested -or [string]::IsNullOrWhiteSpace($result.packageCliSha256)) {
            $result.reason = 'active_store_package_not_attested'
            return [pscustomobject]$result
        }
        $paths = Get-RevAgentProtectedCodexCliPaths -InstallRoot $InstallRoot -PackageFullName $result.packageFullName -Sha256 $result.packageCliSha256 -TargetUserSid $TargetUserSid
        $result.path = $paths.cliPath
        $result.receiptPath = $paths.receiptPath
        $result.available = (Test-Path -LiteralPath $paths.cliPath -PathType Leaf) -or (Test-Path -LiteralPath $paths.receiptPath -PathType Leaf)
        if (-not (Test-Path -LiteralPath $paths.cliPath -PathType Leaf) -or -not (Test-Path -LiteralPath $paths.receiptPath -PathType Leaf)) {
            $result.reason = 'protected_store_copy_missing'
            return [pscustomobject]$result
        }
        [void](Assert-RevAgentSafeUserPath -Path $paths.cliPath -AllowedRoot $paths.installRoot -LeafKind File)
        [void](Assert-RevAgentSafeUserPath -Path $paths.receiptPath -AllowedRoot $paths.installRoot -LeafKind File)
        $protection = Get-RevAgentProtectedPathChainAttestation -Path $paths.cliPath -TrustedRoot $paths.installRoot -LeafKind File
        $receiptProtection = Get-RevAgentProtectedPathChainAttestation -Path $paths.receiptPath -TrustedRoot $paths.installRoot -LeafKind File
        $result.protection = $protection
        $result.protectedPath = [bool]$protection.protected -and [bool]$receiptProtection.protected
        $attestation = Get-RevAgentCodexExecutableAttestation -Path $paths.cliPath -AllowedRoot $paths.installRoot
        $result.sha256 = $attestation.sha256; $result.fileIdentity = $attestation.fileIdentity; $result.linkCount = $attestation.linkCount
        $result.signatureStatus = $attestation.signatureStatus; $result.signerSubject = $attestation.signerSubject
        $receipt = Get-Content -Raw -LiteralPath $paths.receiptPath -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        $result.receiptAttested = Test-RevAgentProtectedCodexReceiptBinding -Receipt $receipt -ActivePackageAttestation $ActivePackageAttestation -TargetUserSid $paths.targetUserSid
        if (-not $result.protectedPath -or -not $attestation.safe -or -not $attestation.openAiSigned -or $attestation.linkCount -ne 1 -or
            -not [string]::Equals([string]$attestation.sha256, $result.packageCliSha256, [StringComparison]::OrdinalIgnoreCase) -or -not $result.receiptAttested) {
            $result.reason = 'protected_store_copy_attestation_failed'
            return [pscustomobject]$result
        }
        $result.success = $true
        $result.reason = 'attested_protected_store_copy'
        return [pscustomobject]$result
    }
    catch {
        $result.reason = 'protected_store_copy_error: ' + $_.Exception.Message
        return [pscustomobject]$result
    }
}

function Install-RevAgentProtectedCodexCliFromStore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$TargetUserSid
    )

    if (-not (Test-RevAgentProcessElevated)) { throw 'Protected Codex CLI materialization is an elevated machine-phase operation.' }
    try { $sid = [Security.Principal.SecurityIdentifier]::new($TargetUserSid) }
    catch { throw "TargetUserSid is not a valid SID: $TargetUserSid" }
    if ($null -eq $sid.AccountDomainSid -or $TargetUserSid -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')) {
        throw "TargetUserSid must identify an interactive local/domain user: $TargetUserSid"
    }
    $fullInstallRoot = Get-RevAgentFullPath $InstallRoot
    if (-not (Test-Path -LiteralPath $fullInstallRoot -PathType Container)) { throw "InstallRoot does not exist: $fullInstallRoot" }
    $rootProtection = Get-RevAgentProtectedPathChainAttestation -Path $fullInstallRoot -TrustedRoot $fullInstallRoot -LeafKind Directory
    if (-not [bool]$rootProtection.protected) { throw "InstallRoot is not administrator-protected; refusing Codex CLI materialization: $fullInstallRoot" }

    $targetSidText = [string]$sid.Value
    $activePackage = Get-RevAgentActiveUnifiedCodexCliAttestation -IncludeLocalMirrorDiagnostics:$false -PackageQuery {
        param($packageName)
        @(Appx\Get-AppxPackage -User $targetSidText -Name $packageName -ErrorAction Stop)
    }
    if (-not [bool]$activePackage.querySucceeded -or -not [bool]$activePackage.success) {
        throw "Target user's active OpenAI.Codex Store package could not be attested. sid=$targetSidText reason=$($activePackage.reason)"
    }
    $paths = Get-RevAgentProtectedCodexCliPaths -InstallRoot $fullInstallRoot -PackageFullName $activePackage.packageFullName -Sha256 $activePackage.packageCliSha256 -TargetUserSid $targetSidText
    foreach ($directory in @($paths.storeRoot, $paths.packageRoot, $paths.hashRoot)) {
        if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null }
        $directoryProtection = Get-RevAgentProtectedPathChainAttestation -Path $directory -TrustedRoot $fullInstallRoot -LeafKind Directory
        if (-not [bool]$directoryProtection.protected) { throw "Protected Codex CLI directory is writable by an untrusted principal: $directory" }
    }

    $sourceGuard = $null
    $stageCli = Join-Path $paths.hashRoot ('.codex-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $stageReceipt = Join-Path $paths.hashRoot ('.receipt-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $sourceGuard = Open-RevAgentExecutableLaunchGuard -Path $activePackage.packageCliPath -AllowedRoot $activePackage.installLocation `
            -ExpectedFileIdentity $activePackage.packageCliFileIdentity -ExpectedSha256 $activePackage.packageCliSha256 `
            -ExpectedLinkCount ([int]$activePackage.packageCliLinkCount) -ExpectedSignerSubject $script:RevAgentOpenAiSignerSubject `
            -RequireProtectedPath -AllowHardLinkedLeaf
        $sourceGuard.fileStream.Position = 0
        $destination = [IO.File]::Open($stageCli, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $sourceGuard.fileStream.CopyTo($destination); $destination.Flush($true) }
        finally { $destination.Dispose() }
        $stagedAttestation = Get-RevAgentCodexExecutableAttestation -Path $stageCli -AllowedRoot $fullInstallRoot
        if (-not $stagedAttestation.safe -or -not $stagedAttestation.openAiSigned -or $stagedAttestation.linkCount -ne 1 -or
            -not [string]::Equals([string]$stagedAttestation.sha256, [string]$activePackage.packageCliSha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Protected Codex CLI staged copy did not preserve the Store executable hash, signer, and single-link identity.'
        }

        $receipt = [ordered]@{
            schemaVersion = 1; origin = 'OpenAI.Codex-Store-package'; materializedAtUtc = [DateTime]::UtcNow.ToString('o')
            targetUserSid = $targetSidText; packageName = [string]$activePackage.packageName
            packageVersion = [string]$activePackage.packageVersion; packageFullName = [string]$activePackage.packageFullName
            packageFamilyName = [string]$activePackage.packageFamilyName; packagePublisher = [string]$activePackage.packagePublisher
            packageSignatureKind = [string]$activePackage.packageSignatureKind; packageCliLayoutId = [string]$activePackage.packageCliLayoutId
            packageCliRelativePath = [string]$activePackage.packageCliRelativePath; packageCliSha256 = [string]$activePackage.packageCliSha256
        }
        $receiptJson = $receipt | ConvertTo-Json -Depth 5
        $receiptStream = [IO.File]::Open($stageReceipt, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $receiptBytes = $script:RevAgentUtf8NoBom.GetBytes($receiptJson + "`n")
            $receiptStream.Write($receiptBytes, 0, $receiptBytes.Length); $receiptStream.Flush($true)
        }
        finally { $receiptStream.Dispose() }

        if (Test-Path -LiteralPath $paths.cliPath -PathType Leaf) {
            $existingSha = Get-RevAgentFileSha256 -Path $paths.cliPath
            if (-not [string]::Equals($existingSha, [string]$activePackage.packageCliSha256, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Existing protected Codex CLI content differs at its hash-qualified path: $($paths.cliPath)"
            }
            Remove-Item -LiteralPath $stageCli -Force -ErrorAction Stop
        }
        else { [IO.File]::Move($stageCli, $paths.cliPath) }
        if (Test-Path -LiteralPath $paths.receiptPath -PathType Leaf) {
            $existingReceipt = Get-Content -Raw -LiteralPath $paths.receiptPath | ConvertFrom-Json
            if (-not [string]::Equals([string]$existingReceipt.targetUserSid, $targetSidText, [StringComparison]::Ordinal) -or
                -not [string]::Equals([string]$existingReceipt.packageCliSha256, [string]$activePackage.packageCliSha256, [StringComparison]::OrdinalIgnoreCase) -or
                -not [string]::Equals([string]$existingReceipt.packageFullName, [string]$activePackage.packageFullName, [StringComparison]::Ordinal)) {
                throw "Existing protected Codex CLI receipt differs at its hash-qualified path: $($paths.receiptPath)"
            }
            Remove-Item -LiteralPath $stageReceipt -Force -ErrorAction Stop
        }
        else { [IO.File]::Move($stageReceipt, $paths.receiptPath) }

        $installed = Get-RevAgentProtectedCodexCliAttestation -InstallRoot $fullInstallRoot -ActivePackageAttestation $activePackage -TargetUserSid $targetSidText
        if (-not [bool]$installed.success) { throw "Protected Codex CLI final attestation failed: $($installed.reason)" }
        return [pscustomobject][ordered]@{
            success = $true; state = 'materialized'; action = 'install-protected-codex-cli'; targetUserSid = $targetSidText
            packageFullName = [string]$activePackage.packageFullName; packageVersion = [string]$activePackage.packageVersion
            packageCliSha256 = [string]$activePackage.packageCliSha256; path = [string]$installed.path; receiptPath = [string]$installed.receiptPath
            sourceExecuted = $false; protectedPath = [bool]$installed.protectedPath; receiptAttested = [bool]$installed.receiptAttested
        }
    }
    finally {
        Close-RevAgentExecutableLaunchGuard -Guard $sourceGuard
        foreach ($stagingPath in @($stageCli, $stageReceipt)) {
            if (Test-Path -LiteralPath $stagingPath -PathType Leaf) { Remove-Item -LiteralPath $stagingPath -Force -ErrorAction SilentlyContinue }
        }
    }
}

function Get-RevAgentOfficialStandaloneCodexAttestation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$CodexHome,
        [Parameter(Mandatory = $true)][string]$LocalAppData
    )

    $result = [ordered]@{
        available = $false; success = $false; reason = 'official_standalone_not_found'
        layoutId = $script:RevAgentStandaloneCodexLayoutId; codexHome = ''; localAppData = ''
        standaloneRoot = ''; releasesRoot = ''; currentPath = ''; currentTarget = ''
        visibleBinPath = ''; visibleBinTarget = ''; releasePath = ''; releaseName = ''
        version = ''; target = ''; manifestPath = ''; manifestSha256 = ''; codexPath = ''
        codexSha256 = ''; codexFileIdentity = ''; codexLinkCount = 0; signerSubject = ''
        packageLayoutAttested = $false; authenticatedReceiptAttested = $false
    }
    try {
        $result.codexHome = Get-RevAgentFullPath $CodexHome
        $result.localAppData = Get-RevAgentFullPath $LocalAppData
        $result.standaloneRoot = Join-Path $result.codexHome 'packages\standalone'
        $result.releasesRoot = Join-Path $result.standaloneRoot 'releases'
        $result.currentPath = Join-Path $result.standaloneRoot 'current'
        $result.visibleBinPath = Join-Path $result.localAppData 'Programs\OpenAI\Codex\bin'

        $standaloneItem = Get-Item -LiteralPath $result.standaloneRoot -Force -ErrorAction SilentlyContinue
        $currentItem = Get-Item -LiteralPath $result.currentPath -Force -ErrorAction SilentlyContinue
        $visibleItem = Get-Item -LiteralPath $result.visibleBinPath -Force -ErrorAction SilentlyContinue
        $result.available = $null -ne $standaloneItem -or $null -ne $currentItem -or $null -ne $visibleItem
        # OpenAI's Windows installer verifies remote release/checksum assets at
        # install time but does not persist a signed receipt that binds the
        # extracted manifest, CLI, and helper files. All of these paths are
        # user-writable, so layout shape plus one signed executable is not an
        # authenticated package origin. Never execute this surface.
        $result.reason = if ($result.available) {
            'standalone_disabled_no_authenticated_receipt'
        }
        else { 'store_package_required_standalone_not_authenticated' }
        return [pscustomobject]$result
    }
    catch {
        $result.reason = 'official_standalone_attestation_error: ' + $_.Exception.Message
        return [pscustomobject]$result
    }
}

function Get-RevAgentCodexOriginTrustDecision {
    param(
        [Parameter(Mandatory = $true)][bool]$ActiveUnifiedAvailable,
        [Parameter(Mandatory = $true)][bool]$ActiveBundleMatch,
        [Parameter(Mandatory = $true)][bool]$StandaloneMatch,
        [Parameter(Mandatory = $true)][object]$Attestation,
        [AllowNull()][object]$StandaloneAttestation,
        [string]$ActivePackageCliSha256 = '',
        [bool]$ProtectedStoreMatch = $false,
        [bool]$ProtectedPathAttested = $false
    )

    $baseReady = [bool]$Attestation.safe -and [bool]$Attestation.openAiSigned -and [int]$Attestation.linkCount -eq 1
    if ($ProtectedStoreMatch) {
        $trusted = $baseReady -and -not [string]::IsNullOrWhiteSpace($ActivePackageCliSha256) -and
            [string]::Equals([string]$Attestation.sha256, $ActivePackageCliSha256, [StringComparison]::OrdinalIgnoreCase) -and
            $ProtectedPathAttested
        return [pscustomobject][ordered]@{
            origin = 'protected-active-store-copy'; trusted = $trusted; packageBound = $trusted; protectedPath = $ProtectedPathAttested
        }
    }
    if ($ActiveBundleMatch) {
        return [pscustomobject][ordered]@{
            origin = 'user-mirror-diagnostic-only'; trusted = $false; packageBound = $false; protectedPath = $false
        }
    }
    # A Windows standalone layout is user-authored state. The current official
    # installer leaves no durable signed receipt/hash chain, so even an exact
    # layout containing a copied signed codex.exe is never an executable origin.
    return [pscustomobject][ordered]@{
        origin = 'unattested'; trusted = $false; packageBound = $false; protectedPath = $false
    }
}

function Resolve-RevAgentCodexCli {
    [CmdletBinding()]
    param(
        [string]$ExplicitPath = "",
        [Parameter(Mandatory = $true)][string]$CodexHome,
        [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'DPE\revAgent'),
        [string]$TargetUserSid = '',
        [string]$LocalAppData = ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)),
        [Parameter(DontShow = $true)][scriptblock]$PackageQuery,
        [Parameter(DontShow = $true)][switch]$DeferActualConfigProbe
    )

    if (Test-RevAgentProcessElevated) { throw "Codex CLI discovery/execution is forbidden in an elevated process." }
    $currentUserSid = [string]([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    if ([string]::IsNullOrWhiteSpace($TargetUserSid)) { $TargetUserSid = $currentUserSid }
    try { $TargetUserSid = [string]([Security.Principal.SecurityIdentifier]::new($TargetUserSid).Value) }
    catch { throw "TargetUserSid is not a valid SID: $TargetUserSid" }
    if (-not [string]::Equals($TargetUserSid, $currentUserSid, [StringComparison]::Ordinal)) {
        throw "Codex CLI user integration must attest and execute only for the current unelevated user. current=$currentUserSid target=$TargetUserSid"
    }
    if ([string]::IsNullOrWhiteSpace($LocalAppData) -or -not (Test-Path -LiteralPath $LocalAppData -PathType Container)) {
        throw "LocalAppData must be an existing directory for isolated Codex CLI probing."
    }
    $localRoot = Get-RevAgentFullPath $LocalAppData
    [void](Assert-RevAgentSafeUserPath -Path $localRoot -AllowedRoot $localRoot -LeafKind Directory)
    $activeUnified = Get-RevAgentActiveUnifiedCodexCliAttestation -LocalAppData $localRoot -PackageQuery $PackageQuery
    if (-not [bool]$activeUnified.querySucceeded) {
        throw "OpenAI.Codex Store package query failed closed; standalone or PATH fallback is forbidden. error=$($activeUnified.queryError)"
    }
    if ([bool]$activeUnified.absenceConfirmed) {
        throw "No OpenAI.Codex Store package is installed. Windows standalone/PATH Codex execution is disabled because no authenticated installed-package receipt/hash chain exists; install the OpenAI.Codex Store package."
    }
    if (-not [bool]$activeUnified.success) {
        throw "Active OpenAI.Codex package query/attestation failed closed; standalone or PATH fallback is forbidden. reason=$($activeUnified.reason) package=$($activeUnified.packageFullName)"
    }
    $protectedCopy = Get-RevAgentProtectedCodexCliAttestation -InstallRoot $InstallRoot -ActivePackageAttestation $activeUnified -TargetUserSid $TargetUserSid
    $standalone = [pscustomobject]@{ available = $false; success = $false; reason = 'store_package_authoritative'; codexPath = ''; authenticatedReceiptAttested = $false }
    $candidateInputs = [System.Collections.Generic.List[object]]::new()
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) { $candidateInputs.Add([pscustomobject]@{ path = $ExplicitPath; explicit = $true }) }
    foreach ($command in @(Get-Command codex -All -ErrorAction SilentlyContinue)) {
        if ($command.Path) { $candidateInputs.Add([pscustomobject]@{ path = [string]$command.Path; explicit = $false }) }
    }
    if ($protectedCopy.success) { $candidateInputs.Add([pscustomobject]@{ path = $protectedCopy.path; explicit = $false }) }
    foreach ($mirror in @($activeUnified.candidates)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$mirror.path)) { $candidateInputs.Add([pscustomobject]@{ path = [string]$mirror.path; explicit = $false }) }
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
        $protectedStoreMatch = $protectedCopy.success -and [string]::Equals($path, [string]$protectedCopy.path, [System.StringComparison]::OrdinalIgnoreCase)
        $activeBundleMatch = @($activeUnified.candidates | Where-Object { [string]::Equals($path, [string]$_.path, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
        $standaloneMatch = $false
        $attestationRoot = if ($protectedStoreMatch) { Get-RevAgentFullPath $InstallRoot } elseif ($activeBundleMatch) { $localRoot } elseif ($standaloneMatch) { [string]$standalone.releasePath } else { Split-Path -Parent $path }
        $attestation = Get-RevAgentCodexExecutableAttestation -Path $path -AllowedRoot $attestationRoot
        $trustDecision = Get-RevAgentCodexOriginTrustDecision `
            -ActiveUnifiedAvailable ([bool]$activeUnified.available) -ActiveBundleMatch $activeBundleMatch `
            -StandaloneMatch $standaloneMatch -Attestation $attestation -StandaloneAttestation $standalone `
            -ActivePackageCliSha256 ([string]$activeUnified.packageCliSha256) `
            -ProtectedStoreMatch $protectedStoreMatch -ProtectedPathAttested ([bool]$protectedCopy.protectedPath)
        $origin = [string]$trustDecision.origin
        $originAttested = [bool]$trustDecision.trusted
        $baseScore = switch ($origin) {
            'protected-active-store-copy' { 130 }
            default { 0 }
        }
        $results.Add([pscustomobject][ordered]@{
            path = $path; origin = $origin; explicitOverride = [bool]$inputCandidate.explicit; originAttested = $originAttested
            attestationRoot = $attestation.allowedRoot; signatureStatus = $attestation.signatureStatus; signerSubject = $attestation.signerSubject
            linkCount = $attestation.linkCount; fileIdentity = $attestation.fileIdentity; sha256 = $attestation.sha256
            allowHardLinkedLeaf = $false; packageBound = [bool]$trustDecision.packageBound; protectedPath = [bool]$trustDecision.protectedPath
            protection = if ($protectedStoreMatch) { $protectedCopy.protection } else { $null }; standaloneLayoutId = if ($standaloneMatch) { [string]$standalone.layoutId } else { '' }
            standaloneCodexHome = if ($standaloneMatch) { [string]$standalone.codexHome } else { '' }
            standaloneLocalAppData = if ($standaloneMatch) { [string]$standalone.localAppData } else { '' }
            standaloneReleasePath = if ($standaloneMatch) { [string]$standalone.releasePath } else { '' }
            standaloneManifestSha256 = if ($standaloneMatch) { [string]$standalone.manifestSha256 } else { '' }
            packageFullName = if ($protectedStoreMatch) { [string]$activeUnified.packageFullName } else { '' }
            packageVersion = if ($protectedStoreMatch) { [string]$activeUnified.packageVersion } else { '' }
            packageInstallLocation = if ($protectedStoreMatch) { [string]$activeUnified.installLocation } else { '' }
            packageCliLayoutId = if ($protectedStoreMatch) { [string]$activeUnified.packageCliLayoutId } else { '' }
            packageCliSha256 = if ($protectedStoreMatch) { [string]$activeUnified.packageCliSha256 } else { '' }
            installRoot = if ($protectedStoreMatch) { Get-RevAgentFullPath $InstallRoot } else { '' }
            targetUserSid = if ($protectedStoreMatch) { $TargetUserSid } else { '' }
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
    $probeRootGuard = Open-RevAgentSafeUserProbeRootGuard -Path $probeHome -AllowedRoot $localRoot
    try {
        foreach ($candidate in @($results | Where-Object originAttested)) {
            try {
                $version = Invoke-RevAgentGuardedCodexProcessProbe -Candidate $candidate -Arguments @('--version') -Environment @{ CODEX_HOME = $probeHome }
                $candidate.version = $version.stdout
                $candidate.versionProbeExitCode = $version.exitCode
                $semantic = ConvertTo-RevAgentCodexSemanticVersion -VersionText $version.stdout
                $candidate.versionMajor = $semantic.major; $candidate.versionMinor = $semantic.minor; $candidate.versionPatch = $semantic.patch
                $candidate.versionIsPrerelease = $semantic.isPrerelease; $candidate.versionPrerelease = $semantic.prerelease; $candidate.versionPrereleaseNumber = $semantic.prereleaseNumber
                if ($version.exitCode -ne 0 -or -not $semantic.valid) {
                    $candidate.capabilityError = ('version probe failed: ' + $version.stderr).Trim()
                    continue
                }
                $capability = Invoke-RevAgentGuardedCodexProcessProbe -Candidate $candidate -Arguments @('mcp', 'list', '--json') -Environment @{ CODEX_HOME = $probeHome }
                $candidate.capabilityProbeExitCode = $capability.exitCode
                $candidate.capabilityJsonValid = $capability.exitCode -eq 0 -and (Test-RevAgentJsonText -Text $capability.stdout)
                $candidate.capabilityError = if ($candidate.capabilityJsonValid) { '' } else { ($capability.stderr + ' ' + $capability.stdout).Trim() }
                $candidate.ready = $semantic.valid -and $candidate.capabilityJsonValid
            }
            catch { $candidate.capabilityError = $_.Exception.Message; $candidate.ready = $false }
        }
    }
    finally {
        Close-RevAgentSafeUserProbeRootGuard -Guard $probeRootGuard -Remove
    }

    $selected = @(Select-RevAgentCodexCandidate -Candidates @($results))
    if ($selected.Count -eq 0) {
        $details = @($results | ForEach-Object { "$($_.path) origin=$($_.origin) originAttested=$($_.originAttested) signature=$($_.signatureStatus) versionExit=$($_.versionProbeExitCode) capabilityExit=$($_.capabilityProbeExitCode)" }) -join '; '
        throw "No Codex CLI candidate passed origin, signer/version, and mcp capability probes. $details"
    }
    $selectedCandidate = $selected[0]
    $reasoningEffortCompatibility = Get-RevAgentCodexReasoningEffortCompatibility -Candidate $selectedCandidate -LocalAppData $localRoot
    $actualConfigProbe = 'deferred'
    if ($DeferActualConfigProbe) {
        $selectedCandidate.actualConfigCapabilityError = 'deferred until atomic config normalization'
    }
    else {
        $actualCapability = Invoke-RevAgentGuardedCodexProcessProbe -Candidate $selectedCandidate -Arguments @('mcp', 'list', '--json') -Environment @{ CODEX_HOME = $CodexHome }
        $selectedCandidate.actualConfigCapabilityProbeExitCode = $actualCapability.exitCode
        $selectedCandidate.actualConfigCapabilityJsonValid = $actualCapability.exitCode -eq 0 -and (Test-RevAgentJsonText -Text $actualCapability.stdout)
        $selectedCandidate.actualConfigCapabilityError = if ($selectedCandidate.actualConfigCapabilityJsonValid) { '' } else { ($actualCapability.stderr + ' ' + $actualCapability.stdout).Trim() }
        if (-not $selectedCandidate.actualConfigCapabilityJsonValid) {
            throw "The newest attested Codex CLI passed isolated discovery but rejected the selected CODEX_HOME; refusing silent downgrade or config mutation. path=$($selectedCandidate.path) version=$($selectedCandidate.version) error=$($selectedCandidate.actualConfigCapabilityError)"
        }
        $actualConfigProbe = 'passed'
    }
    return [pscustomobject][ordered]@{
        selected = $selectedCandidate; candidates = @($results); activeUnifiedAttestation = $activeUnified
        protectedStoreCopyAttestation = $protectedCopy; standaloneAttestation = $standalone
        discoveryCodexHome = 'isolated-disposable'; actualConfigProbe = $actualConfigProbe
        actualConfigProbePhase = if ($DeferActualConfigProbe) { 'deferred-until-atomic-normalization' } else { 'resolver' }
        reasoningEffortCompatibility = $reasoningEffortCompatibility
    }
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
            Invoke-RevAgentGuardedNodeProcessProbe -Candidate $row -Arguments @('--version')
        } else { [pscustomobject]@{ exitCode = -1; timedOut = $false; stdout = ''; stderr = 'non-system or untrusted candidate was not executed' } }
        $capabilityProbe = if ($eligibleForExecution) {
            Invoke-RevAgentGuardedNodeProcessProbe -Candidate $row -Arguments @('-e', 'process.stdout.write(JSON.stringify({node:process.versions.node,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch}))')
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
    $guard = $null
    try {
        $guard = Open-RevAgentExecutableLaunchGuard -Path $Candidate.path -AllowedRoot $Candidate.attestationRoot `
            -ExpectedFileIdentity $Candidate.fileIdentity -ExpectedSha256 $Candidate.sha256 -ExpectedLinkCount 1 `
            -ExpectedSignerSubject $script:RevAgentOpenJsSignerSubject -RequireProtectedPath
        return [pscustomobject][ordered]@{ path = $guard.path; identity = $guard.fileIdentity; sha256 = $guard.sha256; linkCount = $guard.linkCount; protection = $guard.protection }
    }
    catch {
        throw "Node executable identity/protection changed after attestation; refusing execution. path=$($Candidate.path) error=$($_.Exception.Message)"
    }
    finally { Close-RevAgentExecutableLaunchGuard -Guard $guard }
}

function Invoke-RevAgentGuardedNodeProcessProbe {
    param(
        [Parameter(Mandatory = $true)][object]$Candidate,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 15,
        [hashtable]$Environment = @{}
    )

    if (-not [bool]$Candidate.exactCanonical -or -not [bool]$Candidate.originAttested -or -not [bool]$Candidate.protectedPath) {
        throw "Node candidate does not carry a protected exact-canonical attestation: $($Candidate.path)"
    }
    return Invoke-RevAgentIdentityLockedProcessProbe -Path $Candidate.path -AllowedRoot $Candidate.attestationRoot `
        -ExpectedFileIdentity $Candidate.fileIdentity -ExpectedSha256 $Candidate.sha256 -ExpectedLinkCount 1 `
        -ExpectedSignerSubject $script:RevAgentOpenJsSignerSubject -RequireProtectedPath `
        -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds -Environment $Environment
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

function Resolve-RevAgentCodexRootReasoningEffortCompatibility {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content,
        [AllowNull()][object]$CompatibilityAttestation,
        [AllowEmptyString()][string]$ExpectedCodexCliSha256 = ''
    )

    # Ultra remains a valid app/task capability. Mutate the root TOML scalar
    # only when this exact protected CLI explicitly rejects Ultra as an unknown
    # or unsupported value and independently accepts xhigh.
    $firstTableMatch = [regex]::Match($Content, '(?m)^\s*\[')
    $rootContent = if ($firstTableMatch.Success) { $Content.Substring(0, $firstTableMatch.Index) } else { $Content }
    $tableContent = if ($firstTableMatch.Success) { $Content.Substring($firstTableMatch.Index) } else { '' }
    $pattern = '(?m)^(\s*model_reasoning_effort\s*=\s*)"ultra"(\s*(?:#.*)?)$'
    $matchCount = [regex]::Matches($rootContent, $pattern).Count
    if ($matchCount -eq 0) {
        return [pscustomobject][ordered]@{
            content = $Content; changed = $false; replacementCount = 0; rootUltraCount = 0; scope = 'root'
            from = ''; to = ''; action = 'no_root_ultra'; capabilityDecision = 'not_required'; capabilityCliSha256 = ''
        }
    }

    $schema = Get-RevAgentObjectPropertyInfo -InputObject $CompatibilityAttestation -Name schemaVersion
    $probeMode = Get-RevAgentObjectPropertyInfo -InputObject $CompatibilityAttestation -Name probeMode
    $guarded = Get-RevAgentObjectPropertyInfo -InputObject $CompatibilityAttestation -Name guardedExecutable
    $cliSha = Get-RevAgentObjectPropertyInfo -InputObject $CompatibilityAttestation -Name cliSha256
    $decisionInfo = Get-RevAgentObjectPropertyInfo -InputObject $CompatibilityAttestation -Name decision
    $compatibleInfo = Get-RevAgentObjectPropertyInfo -InputObject $CompatibilityAttestation -Name compatible
    $ultraInfo = Get-RevAgentObjectPropertyInfo -InputObject $CompatibilityAttestation -Name ultra
    $xhighInfo = Get-RevAgentObjectPropertyInfo -InputObject $CompatibilityAttestation -Name xhigh
    $envelopeValid = $null -ne $schema -and [int]$schema.Value -eq 1 -and
        $null -ne $probeMode -and [string]$probeMode.Value -eq 'isolated-disposable-root-config' -and
        $null -ne $guarded -and [bool]$guarded.Value -and
        $null -ne $cliSha -and [string]$cliSha.Value -match '^[0-9A-Fa-f]{64}$' -and
        $ExpectedCodexCliSha256 -match '^[0-9A-Fa-f]{64}$' -and
        [string]::Equals([string]$cliSha.Value, $ExpectedCodexCliSha256, [StringComparison]::OrdinalIgnoreCase) -and
        $null -ne $decisionInfo -and $null -ne $compatibleInfo -and $null -ne $ultraInfo
    if (-not $envelopeValid) {
        throw 'Root model_reasoning_effort="ultra" requires capability evidence bound to the exact selected protected Codex CLI; refusing config mutation.'
    }

    $ultra = $ultraInfo.Value
    $ultraEffort = Get-RevAgentObjectPropertyInfo -InputObject $ultra -Name effort
    $ultraAttempted = Get-RevAgentObjectPropertyInfo -InputObject $ultra -Name attempted
    $ultraAccepted = Get-RevAgentObjectPropertyInfo -InputObject $ultra -Name accepted
    $ultraExit = Get-RevAgentObjectPropertyInfo -InputObject $ultra -Name exitCode
    $ultraJson = Get-RevAgentObjectPropertyInfo -InputObject $ultra -Name jsonValid
    $ultraUnsupported = Get-RevAgentObjectPropertyInfo -InputObject $ultra -Name unsupportedUltra
    $ultraRejectionClass = Get-RevAgentObjectPropertyInfo -InputObject $ultra -Name rejectionClass
    $ultraIsolated = Get-RevAgentObjectPropertyInfo -InputObject $ultra -Name isolatedCodexHome
    $ultraRootOnly = Get-RevAgentObjectPropertyInfo -InputObject $ultra -Name rootOnlyConfig
    $commonUltraEvidence = $null -ne $ultraEffort -and [string]$ultraEffort.Value -eq 'ultra' -and
        $null -ne $ultraAttempted -and [bool]$ultraAttempted.Value -and
        $null -ne $ultraIsolated -and [bool]$ultraIsolated.Value -and $null -ne $ultraRootOnly -and [bool]$ultraRootOnly.Value
    $decision = [string]$decisionInfo.Value

    if ($decision -eq 'preserve_supported_ultra' -and [bool]$compatibleInfo.Value -and $commonUltraEvidence -and
        $null -ne $ultraAccepted -and [bool]$ultraAccepted.Value -and $null -ne $ultraExit -and [int]$ultraExit.Value -eq 0 -and
        $null -ne $ultraJson -and [bool]$ultraJson.Value) {
        return [pscustomobject][ordered]@{
            content = $Content; changed = $false; replacementCount = 0; rootUltraCount = $matchCount; scope = 'root'
            from = 'ultra'; to = 'ultra'; action = 'preserved_supported_ultra'; capabilityDecision = $decision
            capabilityCliSha256 = ([string]$cliSha.Value).ToUpperInvariant()
        }
    }

    $xhigh = if ($null -ne $xhighInfo) { $xhighInfo.Value } else { $null }
    $xhighEffort = Get-RevAgentObjectPropertyInfo -InputObject $xhigh -Name effort
    $xhighAttempted = Get-RevAgentObjectPropertyInfo -InputObject $xhigh -Name attempted
    $xhighAccepted = Get-RevAgentObjectPropertyInfo -InputObject $xhigh -Name accepted
    $xhighExit = Get-RevAgentObjectPropertyInfo -InputObject $xhigh -Name exitCode
    $xhighJson = Get-RevAgentObjectPropertyInfo -InputObject $xhigh -Name jsonValid
    $xhighIsolated = Get-RevAgentObjectPropertyInfo -InputObject $xhigh -Name isolatedCodexHome
    $xhighRootOnly = Get-RevAgentObjectPropertyInfo -InputObject $xhigh -Name rootOnlyConfig
    $canNormalize = $decision -eq 'normalize_ultra_to_xhigh' -and [bool]$compatibleInfo.Value -and $commonUltraEvidence -and
        $null -ne $ultraAccepted -and -not [bool]$ultraAccepted.Value -and $null -ne $ultraExit -and [int]$ultraExit.Value -ne 0 -and
        $null -ne $ultraJson -and -not [bool]$ultraJson.Value -and $null -ne $ultraUnsupported -and [bool]$ultraUnsupported.Value -and
        $null -ne $ultraRejectionClass -and [string]$ultraRejectionClass.Value -eq 'unsupported_or_unknown_ultra' -and
        $null -ne $xhighEffort -and [string]$xhighEffort.Value -eq 'xhigh' -and $null -ne $xhighAttempted -and [bool]$xhighAttempted.Value -and $null -ne $xhighAccepted -and [bool]$xhighAccepted.Value -and
        $null -ne $xhighExit -and [int]$xhighExit.Value -eq 0 -and $null -ne $xhighJson -and [bool]$xhighJson.Value -and
        $null -ne $xhighIsolated -and [bool]$xhighIsolated.Value -and $null -ne $xhighRootOnly -and [bool]$xhighRootOnly.Value
    if (-not $canNormalize) {
        $ultraDiagnostic = Get-RevAgentObjectPropertyInfo -InputObject $ultra -Name diagnostic
        $diagnostic = if ($null -ne $ultraDiagnostic) { [string]$ultraDiagnostic.Value } else { 'missing probe diagnostic' }
        throw "Selected protected Codex CLI did not provide safe evidence to preserve or conditionally normalize root Ultra; refusing config mutation. decision=$decision diagnostic=$diagnostic"
    }

    $updatedRoot = [regex]::Replace($rootContent, $pattern, '${1}"xhigh"${2}')
    return [pscustomobject][ordered]@{
        content = $updatedRoot + $tableContent
        changed = $true
        replacementCount = $matchCount
        rootUltraCount = $matchCount
        scope = 'root'
        from = 'ultra'
        to = 'xhigh'
        action = 'normalized_unsupported_ultra_to_xhigh'
        capabilityDecision = $decision
        capabilityCliSha256 = ([string]$cliSha.Value).ToUpperInvariant()
    }
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
        [AllowNull()][object]$ReasoningEffortCompatibility,
        [string]$ExpectedCodexCliSha256 = '',
        [int]$LockTimeoutSeconds = 20,
        [scriptblock]$BeforeDestinationCommit,
        [scriptblock]$BeforeAtomicCommit,
        [scriptblock]$BeforeRecoveryCommit,
        [Parameter(DontShow = $true)][scriptblock]$AfterAtomicCommitValidation,
        [Parameter(DontShow = $true)][scriptblock]$BeforePostCommitRollback
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
        $reasoningNormalization = Resolve-RevAgentCodexRootReasoningEffortCompatibility -Content $content `
            -CompatibilityAttestation $ReasoningEffortCompatibility -ExpectedCodexCliSha256 $ExpectedCodexCliSha256
        $content = [string]$reasoningNormalization.content
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
        $stagedIdentity = Get-RevAgentFileIdentity -Path $tempPath
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
        $afterIdentity = Get-RevAgentFileIdentity -Path $configPath
        $postCommitValidation = $null
        if ($null -ne $AfterAtomicCommitValidation) {
            try {
                # Keep the config lock and displaced original backup until the
                # exact selected Store package/receipt and guarded actual-config
                # CLI probe have both succeeded against the committed bytes.
                $postCommitValidation = & $AfterAtomicCommitValidation $configPath $afterHash $afterIdentity
                $validatedHash = Get-RevAgentFileSha256 -Path $configPath
                $validatedIdentity = Get-RevAgentFileIdentity -Path $configPath
                if (-not [string]::Equals($validatedHash, $stagedHash, [StringComparison]::OrdinalIgnoreCase) -or
                    -not [string]::Equals($validatedIdentity, $afterIdentity, [StringComparison]::Ordinal)) {
                    throw "Codex config changed during post-commit selected-CLI validation. expectedHash=$stagedHash actualHash=$validatedHash"
                }
            }
            catch {
                $validationError = $_.Exception.Message
                $rollbackHash = Get-RevAgentFileSha256 -Path $configPath
                $rollbackIdentity = Get-RevAgentFileIdentity -Path $configPath
                if ($null -ne $BeforePostCommitRollback) {
                    & $BeforePostCommitRollback $configPath $rollbackHash $rollbackIdentity $beforeHash $beforeIdentity
                }
                if ($beforeHash -eq 'MISSING') {
                    # Atomically displace whichever pathname entry exists now,
                    # then inspect that captured identity. Never check and then
                    # delete by pathname: a non-cooperating writer could replace
                    # the staged file in that gap and lose its new content.
                    $missingRollbackDiscard = Join-Path $CodexHome ('.config.toml.revagent-' + [Guid]::NewGuid().ToString('N') + '.missing-rollback')
                    try { [IO.File]::Move($configPath, $missingRollbackDiscard) }
                    catch {
                        throw "Post-commit selected-CLI validation failed and missing-config atomic displacement failed; refusing destructive rollback. error=$validationError displacementError=$($_.Exception.Message)"
                    }
                    $displacedMissingHash = Get-RevAgentFileSha256 -Path $missingRollbackDiscard
                    $displacedMissingIdentity = Get-RevAgentFileIdentity -Path $missingRollbackDiscard
                    if ([string]::Equals($displacedMissingHash, $stagedHash, [StringComparison]::OrdinalIgnoreCase) -and
                        [string]::Equals($displacedMissingIdentity, $stagedIdentity, [StringComparison]::Ordinal)) {
                        Remove-Item -LiteralPath $missingRollbackDiscard -Force -ErrorAction Stop
                        if ((Get-RevAgentFileSha256 -Path $configPath) -eq 'MISSING') {
                            throw "Post-commit selected-CLI validation failed; the atomically displaced staged config was removed and the original missing state was restored. error=$validationError"
                        }
                        throw "Post-commit selected-CLI validation failed; staged config was removed but a concurrent writer created a new config that was preserved. error=$validationError"
                    }
                    if ((Get-RevAgentFileSha256 -Path $configPath) -eq 'MISSING') {
                        try { [IO.File]::Move($missingRollbackDiscard, $configPath) }
                        catch {
                            throw "Post-commit selected-CLI validation failed; a competing writer was atomically displaced but could not be restored, so its bytes were preserved at '$missingRollbackDiscard'. error=$validationError restoreError=$($_.Exception.Message)"
                        }
                        $restoredWriterHash = Get-RevAgentFileSha256 -Path $configPath
                        $restoredWriterIdentity = Get-RevAgentFileIdentity -Path $configPath
                        if ([string]::Equals($restoredWriterHash, $displacedMissingHash, [StringComparison]::OrdinalIgnoreCase) -and
                            [string]::Equals($restoredWriterIdentity, $displacedMissingIdentity, [StringComparison]::Ordinal)) {
                            throw "Post-commit selected-CLI validation failed; a competing writer replaced the staged config and its exact bytes/identity were restored instead of deleted. error=$validationError"
                        }
                        throw "Post-commit selected-CLI validation failed; competing-writer restoration could not be verified. error=$validationError"
                    }
                    throw "Post-commit selected-CLI validation failed; a competing writer was displaced while another config appeared, so the displaced bytes were preserved at '$missingRollbackDiscard'. error=$validationError"
                }

                $rollbackBackupHash = Get-RevAgentFileSha256 -Path $backupPath
                $rollbackBackupIdentity = Get-RevAgentFileIdentity -Path $backupPath
                if (-not [string]::Equals($rollbackHash, $stagedHash, [StringComparison]::OrdinalIgnoreCase) -or
                    -not [string]::Equals($rollbackIdentity, $afterIdentity, [StringComparison]::Ordinal) -or
                    -not [string]::Equals($rollbackBackupHash, $beforeHash, [StringComparison]::OrdinalIgnoreCase) -or
                    -not [string]::Equals($rollbackBackupIdentity, $beforeIdentity, [StringComparison]::Ordinal)) {
                    throw "Post-commit selected-CLI validation failed and rollback was unsafe; preserving the original backup. backup=$backupPath error=$validationError"
                }
                $rollbackDiscard = Join-Path $CodexHome ('.config.toml.revagent-' + [Guid]::NewGuid().ToString('N') + '.discard')
                $rollbackOutcome = ''
                $displacedRollbackHash = ''
                $displacedRollbackIdentity = ''
                try {
                    [IO.File]::Replace($backupPath, $configPath, $rollbackDiscard, $true)
                    $restoredHash = Get-RevAgentFileSha256 -Path $configPath
                    $restoredIdentity = Get-RevAgentFileIdentity -Path $configPath
                    if (-not [string]::Equals($restoredHash, $beforeHash, [StringComparison]::OrdinalIgnoreCase) -or
                        -not [string]::Equals($restoredIdentity, $beforeIdentity, [StringComparison]::Ordinal)) {
                        throw "Original config bytes/identity were not restored after selected-CLI validation failed."
                    }
                    $discardHash = Get-RevAgentFileSha256 -Path $rollbackDiscard
                    $discardIdentity = Get-RevAgentFileIdentity -Path $rollbackDiscard
                    if ([string]::Equals($discardHash, $stagedHash, [StringComparison]::OrdinalIgnoreCase) -and
                        [string]::Equals($discardIdentity, $afterIdentity, [StringComparison]::Ordinal)) {
                        Remove-Item -LiteralPath $rollbackDiscard -Force -ErrorAction Stop
                        $rollbackOutcome = 'original_restored'
                    }
                    else {
                        # A writer landed after our precheck but before Replace.
                        # Restore that atomically displaced writer to config and
                        # move the original config back to backupPath.
                        $displacedRollbackHash = $discardHash
                        $displacedRollbackIdentity = $discardIdentity
                        [IO.File]::Replace($rollbackDiscard, $configPath, $backupPath, $true)
                        $writerRestoredHash = Get-RevAgentFileSha256 -Path $configPath
                        $writerRestoredIdentity = Get-RevAgentFileIdentity -Path $configPath
                        $preservedOriginalHash = Get-RevAgentFileSha256 -Path $backupPath
                        $preservedOriginalIdentity = Get-RevAgentFileIdentity -Path $backupPath
                        if (-not [string]::Equals($writerRestoredHash, $displacedRollbackHash, [StringComparison]::OrdinalIgnoreCase) -or
                            -not [string]::Equals($writerRestoredIdentity, $displacedRollbackIdentity, [StringComparison]::Ordinal) -or
                            -not [string]::Equals($preservedOriginalHash, $beforeHash, [StringComparison]::OrdinalIgnoreCase) -or
                            -not [string]::Equals($preservedOriginalIdentity, $beforeIdentity, [StringComparison]::Ordinal)) {
                            throw "Concurrent-writer restoration or original-backup preservation could not be verified. backup=$backupPath"
                        }
                        $rollbackOutcome = 'concurrent_writer_restored_original_preserved'
                    }
                }
                catch {
                    throw "Post-commit selected-CLI validation rollback failed closed. originalError=$validationError rollbackError=$($_.Exception.Message)"
                }
                if ($rollbackOutcome -eq 'concurrent_writer_restored_original_preserved') {
                    throw "Post-commit selected-CLI validation failed; a concurrent writer was restored exactly and the original config was preserved at '$backupPath'. error=$validationError"
                }
                throw "Post-commit selected-CLI validation failed; original config bytes/hash were restored under lock. error=$validationError"
            }
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
        return [pscustomobject][ordered]@{
            path = $configPath; beforeSha256 = $beforeHash; afterSha256 = $afterHash; atomicReplace = $true; lockPath = $lockPath
            postCommitValidation = $postCommitValidation
            modelReasoningEffortNormalization = [pscustomobject][ordered]@{
                changed = [bool]$reasoningNormalization.changed; replacementCount = [int]$reasoningNormalization.replacementCount
                scope = [string]$reasoningNormalization.scope; from = [string]$reasoningNormalization.from; to = [string]$reasoningNormalization.to
                action = [string]$reasoningNormalization.action; rootUltraCount = [int]$reasoningNormalization.rootUltraCount
            }
            modelReasoningEffortCompatibility = [pscustomobject][ordered]@{
                action = [string]$reasoningNormalization.action; capabilityDecision = [string]$reasoningNormalization.capabilityDecision
                capabilityCliSha256 = [string]$reasoningNormalization.capabilityCliSha256
                probe = $ReasoningEffortCompatibility
            }
        }
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
        }
        $probe = if ($null -ne $CodexCliCandidate) {
            Invoke-RevAgentGuardedCodexProcessProbe -Candidate $CodexCliCandidate -Arguments @('mcp', 'get', $server.name, '--json') -Environment @{ CODEX_HOME = $CodexHome }
        }
        else {
            Invoke-RevAgentProcessProbe -FilePath $CodexCliPath -Arguments @('mcp', 'get', $server.name, '--json') -Environment @{ CODEX_HOME = $CodexHome }
        }
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
        [ValidateRange(1, 100000)][int]$MinimumToolCount = 1,
        [AllowNull()][object]$NodeCandidate,
        [AllowNull()][object]$ServerAttestation
    )
    $fullNodePath = Get-RevAgentFullPath $NodePath
    $nodeWorkingDirectory = Split-Path -Parent $fullNodePath
    if ([string]::IsNullOrWhiteSpace($nodeWorkingDirectory) -or -not (Test-Path -LiteralPath $nodeWorkingDirectory -PathType Container)) {
        throw "Node executable directory is missing; refusing inherited current-directory launch. path=$fullNodePath"
    }
    $nodeArgumentLine = (@($fullNodePath, $ServerPath) | ForEach-Object { ConvertTo-RevAgentWindowsArgument ([string]$_) }) -join ' '
    $process = $null
    $started = $false
    $nodeGuard = $null
    $serverGuard = $null
    $job = $null
    $cleanup = $null
    $stderrTask = $null
    try {
        if ($null -ne $NodeCandidate) {
            if (-not [string]::Equals([string]$NodeCandidate.path, $NodePath, [StringComparison]::OrdinalIgnoreCase) -or
                -not [bool]$NodeCandidate.exactCanonical -or -not [bool]$NodeCandidate.originAttested) {
                throw 'MCP handshake Node path does not match its protected executable attestation.'
            }
            $nodeGuard = Open-RevAgentExecutableLaunchGuard -Path $NodeCandidate.path -AllowedRoot $NodeCandidate.attestationRoot `
                -ExpectedFileIdentity $NodeCandidate.fileIdentity -ExpectedSha256 $NodeCandidate.sha256 -ExpectedLinkCount 1 `
                -ExpectedSignerSubject $script:RevAgentOpenJsSignerSubject -RequireProtectedPath
        }
        if ($null -ne $ServerAttestation) {
            if (-not [string]::Equals([string]$ServerAttestation.path, $ServerPath, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'MCP handshake server path does not match its protected release attestation.'
            }
            $serverGuard = Open-RevAgentExecutableLaunchGuard -Path $ServerAttestation.path -AllowedRoot $ServerAttestation.installRoot `
                -ExpectedFileIdentity $ServerAttestation.fileIdentity -ExpectedSha256 $ServerAttestation.sha256 `
                -ExpectedLinkCount ([int]$ServerAttestation.linkCount) -RequireProtectedPath
        }
        $job = [RevAgent.NativeProcessJobV1]::CreateKillOnCloseJob()
        $process = [RevAgent.NativeSuspendedProcessV2]::CreateAssigned($job, $fullNodePath, $nodeArgumentLine, $nodeWorkingDirectory, @{})
        $started = $true
        $process.Resume()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $request = [ordered]@{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = [ordered]@{ protocolVersion = $ExpectedProtocolVersion; capabilities = @{}; clientInfo = [ordered]@{ name = 'revAgent-installer'; version = '1.0' } } } | ConvertTo-Json -Compress -Depth 8
        $requestBytes = $script:RevAgentUtf8NoBom.GetBytes($request + "`n")
        $process.StandardInput.BaseStream.Write($requestBytes, 0, $requestBytes.Length); $process.StandardInput.BaseStream.Flush()
        $readTask = $process.StandardOutput.ReadLineAsync()
        if (-not $readTask.Wait($TimeoutSeconds * 1000)) { throw "MCP initialize handshake timed out after $TimeoutSeconds seconds." }
        $line = [string]$readTask.Result
        if ([string]::IsNullOrWhiteSpace($line)) {
            try { $process.StandardInput.Close() } catch {}
            [void]$process.WaitForExit(1000)
            $stderrText = if ($null -ne $stderrTask -and $stderrTask.IsCompleted) { [string]$stderrTask.Result } else { '' }
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
        if ($started) {
            $cleanup = Stop-RevAgentGuardedProcessTree -Process $process -Job $job -ProcessStarted $started -ForceTerminate
        }
        if ($null -ne $job) { $job.Dispose() }
        if ($null -ne $process) { $process.Dispose() }
        # Release executable and full directory-chain guards only after the
        # entire Node proxy/server process job is confirmed empty (or after
        # the bounded cleanup attempt has completed).
        Close-RevAgentExecutableLaunchGuard -Guard $serverGuard
        Close-RevAgentExecutableLaunchGuard -Guard $nodeGuard
        if ($null -ne $cleanup -and -not $cleanup.success) {
            throw "MCP process-tree cleanup failed before launch guards were released: $($cleanup.error)"
        }
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
    # Candidate discovery also probes Ultra in a disposable root-only config.
    # The actual config probe is deferred until the atomic compatibility action
    # has either preserved supported Ultra or conditionally migrated an explicit
    # CLI rejection to independently accepted xhigh.
    $cli = Resolve-RevAgentCodexCli -ExplicitPath $CodexCliPath -CodexHome $codexHomeInfo.path -InstallRoot $InstallRoot -TargetUserSid $user.sid -DeferActualConfigProbe
    $node = Resolve-RevAgentNodeRuntime -ExplicitPath $NodePath
    $skill = Sync-RevAgentCodexSkill -UserProfileRoot $user.profileRoot -SourcePath $SkillSourcePath -Policy $CodexInstructionPolicy -GuardRoot $user.profileRoot
    $agents = Sync-RevAgentCodexAgents -CodexHome $codexHomeInfo.path -GuardRoot $codexHomeInfo.guardRoot -SourcePath $AgentsSourcePath -Policy $CodexInstructionPolicy
    $configPath = Join-Path $codexHomeInfo.path 'config.toml'
    if ([string]::IsNullOrWhiteSpace($ExpectedConfigSha256)) { $ExpectedConfigSha256 = Get-RevAgentFileSha256 $configPath }
    $preCommitCliBindingValidation = {
        param($CommittedPath, $BeforeHash, $BeforeIdentity)
        [void](Assert-RevAgentCodexExecutableUnchanged -Candidate $cli.selected)
    }.GetNewClosure()
    $postCommitActualConfigValidation = {
        param($CommittedPath, $CommittedHash, $CommittedIdentity)
        $probe = Invoke-RevAgentGuardedCodexProcessProbe -Candidate $cli.selected -Arguments @('mcp', 'list', '--json') -Environment @{ CODEX_HOME = $codexHomeInfo.path }
        $jsonValid = $probe.exitCode -eq 0 -and (Test-RevAgentJsonText -Text $probe.stdout)
        $error = if ($jsonValid) { '' } else { ($probe.stderr + ' ' + $probe.stdout).Trim() }
        if (-not $jsonValid) {
            throw "The newest attested Codex CLI rejected the atomically committed CODEX_HOME; refusing silent downgrade. path=$($cli.selected.path) version=$($cli.selected.version) error=$error"
        }
        return [pscustomobject][ordered]@{ exitCode = [int]$probe.exitCode; jsonValid = $true; error = ''; guardedPackageRebind = $true }
    }.GetNewClosure()
    $config = Set-RevAgentCodexMcpConfigAtomic -CodexHome $codexHomeInfo.path -GuardRoot $codexHomeInfo.guardRoot -NodePath $node.selected.path -RuntimeServerPath $RuntimeServerPath -DocsServerPath $DocsServerPath -ExpectedSha256 $ExpectedConfigSha256 `
        -ReasoningEffortCompatibility $cli.reasoningEffortCompatibility -ExpectedCodexCliSha256 $cli.selected.sha256 `
        -BeforeAtomicCommit $preCommitCliBindingValidation -AfterAtomicCommitValidation $postCommitActualConfigValidation
    $actualCapability = $config.postCommitValidation
    $cli.selected.actualConfigCapabilityProbeExitCode = $actualCapability.exitCode
    $cli.selected.actualConfigCapabilityJsonValid = [bool]$actualCapability.jsonValid
    $cli.selected.actualConfigCapabilityError = [string]$actualCapability.error
    $cli.actualConfigProbe = 'passed'
    $cli.actualConfigProbePhase = 'post-commit-under-config-lock-before-backup-cleanup'
    $readback = Test-RevAgentCodexMcpReadback -CodexCliPath $cli.selected.path -CodexHome $codexHomeInfo.path -NodePath $node.selected.path -RuntimeServerPath $RuntimeServerPath -DocsServerPath $DocsServerPath -CodexCliCandidate $cli.selected
    $handshakes = @()
    if (-not $SkipMcpHandshake) {
        $handshakeRows = [System.Collections.Generic.List[object]]::new()
        foreach ($server in @(
            [pscustomobject]@{ path = $RuntimeServerPath; expectedServer = 'revAgent'; expectedTool = 'get_revit_mcp_status'; attestation = $serverAttestations.runtime.entrypoint },
            [pscustomobject]@{ path = $DocsServerPath; expectedServer = 'revit-api-docs'; expectedTool = 'resolve_api_symbols_bulk'; attestation = $serverAttestations.docs.entrypoint }
        )) {
            $handshakeRows.Add((Test-RevAgentMcpStdioHandshake -NodePath $node.selected.path -ServerPath $server.path `
                -ExpectedServerNames @($server.expectedServer) -ExpectedToolNames @($server.expectedTool) `
                -NodeCandidate $node.selected -ServerAttestation $server.attestation))
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

Export-ModuleMember -Function Test-RevAgentProcessElevated, Resolve-RevAgentInteractiveUser, Resolve-RevAgentCodexHome, Assert-RevAgentSafeUserPath, Get-RevAgentFileSha256, Get-RevAgentDirectoryTreeSha256, Install-RevAgentProtectedCodexCliFromStore, Resolve-RevAgentCodexCli, Resolve-RevAgentNodeRuntime, Set-RevAgentCodexMcpConfigAtomic, Sync-RevAgentCodexSkill, Get-RevAgentCodexSkillAttestation, Sync-RevAgentCodexAgents, Get-RevAgentCodexAgentsAttestation, Test-RevAgentCodexMcpReadback, Test-RevAgentMcpStdioHandshake, Get-RevAgentCodexAppProcessState, Invoke-RevAgentCodexUserIntegration
