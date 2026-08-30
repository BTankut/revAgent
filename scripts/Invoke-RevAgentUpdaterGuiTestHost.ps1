<#
.SYNOPSIS
    Closed PowerShell 7 host for revAgent GUI and publisher fixture tests.

.DESCRIPTION
    Positive assurance is conditional on this fresh, exact host entry. It does
    not claim protection from arbitrary equal-trust hostile code executing in
    the child after authority handoff; that would require an external broker.
#>

[CmdletBinding()]
param(
    [ValidateSet('Gui', 'Publisher')][string]$Operation = 'Gui',
    [Parameter(Mandatory = $true)][Alias('GuiScriptPath')][string]$ConsumerScriptPath,
    [Parameter(Mandatory = $true)][string]$FixtureRoot,
    [string]$LogDirectory = '', [string]$DiscoveryRoot = '', [string]$ReportsRoot = '',
    [string]$PublisherArgumentsJson = '', [string]$ChannelManifestPath = '',
    [string]$InstallRoot = '', [string]$BootstrapStatePath = '',
    [switch]$SmokeTest, [switch]$ModulePathSecuritySmokeTest,
    [switch]$PreWindowBootstrapSmokeTest, [switch]$SuppressStartupFailureDialogForTest,
    [string]$TestStartupFailureMessage = '',
    [Parameter(DontShow = $true)][ValidateRange(0, 30000)][int]$TestHoldBeforeConsumerMilliseconds = 0,
    [ValidateSet('Valid', 'Malformed', 'Missing', 'ExistingTarget')][string]$AuthorityMode = 'Valid',
    [Parameter(Mandatory = $true)][string]$ExpectedPwshPath,
    [Parameter(Mandatory = $true)][string]$ExpectedPwshSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedBoundedEnvironmentSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedHostSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedModuleSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedConsumerSha256
)

$global:PSModuleAutoloadingPreference = 'None'
function Exit-RevAgentFixturePreIo {
    param([Parameter(Mandatory = $true)][string]$Reason)
    try { [Console]::Error.WriteLine($Reason) } catch { }
    exit 71
}

$reservedModuleNames = @('RevAgent.TestFixtureAuthority', 'RevAgent.TestFixtureAuthority.Hostile')
try {
    $loadedModules = @(Microsoft.PowerShell.Core\Get-Module -All)
    if (@($loadedModules | Where-Object { $reservedModuleNames -contains [string]$_.Name }).Count -ne 0) {
        Exit-RevAgentFixturePreIo 'fixture_authority_module_preloaded'
    }
}
catch { Exit-RevAgentFixturePreIo 'fixture_authority_preload_scan_uncertain' }

$reservedTypeNames = @(
    'RevAgent.TestFixtures.RevAgentTestFixtureAuthority',
    'RevAgent.TestFixtures.RevAgentTestFixtureOwnership',
    'RevAgent.TestFixtures.RevAgentGuiStartupFailureLogLease',
    'RevAgent.TestFixtures.RevAgentDesktopLauncherDiscoveryLease',
    'RevAgent.TestFixtures.RevAgentLauncherFileBatchLease',
    'RevAgent.TestFixtures.RevAgentPinnedLauncherFileLease'
)
try {
    foreach ($assembly in [AppDomain]::CurrentDomain.GetAssemblies()) {
        foreach ($name in $reservedTypeNames) {
            if ($null -ne $assembly.GetType($name, $false, $false)) {
                Exit-RevAgentFixturePreIo 'fixture_authority_type_preloaded'
            }
        }
    }
}
catch { Exit-RevAgentFixturePreIo 'fixture_authority_preload_scan_uncertain' }

try {
    $processArguments = [Environment]::GetCommandLineArgs()
    $expectedPrefix = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File')
    if ($processArguments.Count -lt 8) { Exit-RevAgentFixturePreIo 'fixture_host_invocation_refused' }
    for ($index = 0; $index -lt $expectedPrefix.Count; $index++) {
        if (-not [string]::Equals([string]$processArguments[$index + 1], $expectedPrefix[$index], [StringComparison]::Ordinal)) {
            Exit-RevAgentFixturePreIo 'fixture_host_invocation_refused'
        }
    }
    if (-not [string]::Equals([string]$processArguments[7], [string]$PSCommandPath, [StringComparison]::OrdinalIgnoreCase)) {
        Exit-RevAgentFixturePreIo 'fixture_host_invocation_refused'
    }
}
catch { Exit-RevAgentFixturePreIo 'fixture_host_invocation_refused' }

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$boundedEnvironmentNames = @('APPDATA','COMPUTERNAME','CommonProgramFiles','CommonProgramFiles(x86)','LOCALAPPDATA','OS','ProgramData','ProgramFiles','ProgramFiles(x86)','SystemDrive','SystemRoot','TEMP','TMP','USERPROFILE','WINDIR')
$boundedEnvironmentText = [string]::Join("`n", @($boundedEnvironmentNames | ForEach-Object { $_ + '=' + [string][Environment]::GetEnvironmentVariable($_, 'Process') }))
$boundedEnvironmentBytes = [Text.Encoding]::UTF8.GetBytes($boundedEnvironmentText)
$boundedEnvironmentHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($boundedEnvironmentBytes)).ToLowerInvariant()
if (-not [string]::Equals($boundedEnvironmentHash, $ExpectedBoundedEnvironmentSha256, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'fixture_host_environment_refused'
}
$expectedModuleLiteralSha256 = 'b21d81ae3ad015b82535ce449454b89ad5cc2fc1d8c9cd0a47820c4a5d6293cc'

$authority = $null
$hostProvenance = $null
$guiExitCode = 0
try {
    foreach ($inboxModule in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management')) {
        $inboxManifest = [IO.Path]::Combine($PSHOME, 'Modules', $inboxModule, ($inboxModule + '.psd1'))
        Microsoft.PowerShell.Core\Import-Module -Name $inboxManifest -ErrorAction Stop
    }

    $bootstrapSource = @'
using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace RevAgent.CleanFixtureHost
{
    internal sealed class Identity
    {
        internal readonly ulong Volume; internal readonly byte[] Id; internal readonly string Dos; internal readonly string Guid; internal readonly uint Links; internal readonly bool Directory;
        internal Identity(ulong volume, byte[] id, string dos, string guid, uint links, bool directory) { Volume=volume;Id=id;Dos=dos;Guid=guid;Links=links;Directory=directory; }
        internal bool Same(Identity other) => other!=null && Volume==other.Volume && Id.SequenceEqual(other.Id) && String.Equals(Dos,other.Dos,StringComparison.OrdinalIgnoreCase) && String.Equals(Guid,other.Guid,StringComparison.OrdinalIgnoreCase) && Links==other.Links && Directory==other.Directory;
    }
    internal static class Native
    {
        const uint GENERIC_READ=0x80000000, FILE_SHARE_READ=1, OPEN_EXISTING=3, FILE_FLAG_BACKUP_SEMANTICS=0x02000000, FILE_FLAG_OPEN_REPARSE_POINT=0x00200000, FILE_ATTRIBUTE_REPARSE_POINT=0x400;
        const int SE_FILE_OBJECT=1; const uint OWNER_SECURITY_INFORMATION=1, DACL_SECURITY_INFORMATION=4;
        [StructLayout(LayoutKind.Sequential)] internal struct FILE_ID_128 { [MarshalAs(UnmanagedType.ByValArray, SizeConst=16)] internal byte[] Identifier; }
        [StructLayout(LayoutKind.Sequential)] internal struct FILE_ID_INFO { internal ulong VolumeSerialNumber; internal FILE_ID_128 FileId; }
        [StructLayout(LayoutKind.Sequential)] internal struct FILE_ATTRIBUTE_TAG_INFO { internal uint FileAttributes; internal uint ReparseTag; }
        [StructLayout(LayoutKind.Sequential)] internal struct FILE_STANDARD_INFO { internal long AllocationSize,EndOfFile; internal uint NumberOfLinks; [MarshalAs(UnmanagedType.U1)] internal bool DeletePending; [MarshalAs(UnmanagedType.U1)] internal bool Directory; }
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int infoClass,IntPtr info,uint size);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,StringBuilder path,uint length,uint flags);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,SafeFileHandle source,IntPtr targetProcess,out SafeFileHandle target,uint access,bool inherit,uint options);
        [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle handle,int objectType,uint securityInfo,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
        [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
        [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr LocalFree(IntPtr value);
        static T Read<T>(SafeFileHandle handle,int infoClass) where T:struct { int size=Marshal.SizeOf(typeof(T));IntPtr memory=Marshal.AllocHGlobal(size);try{if(!GetFileInformationByHandleEx(handle,infoClass,memory,(uint)size))throw new IOException("fixture_identity_read_failed",Marshal.GetLastWin32Error());return(T)Marshal.PtrToStructure(memory,typeof(T));}finally{Marshal.FreeHGlobal(memory);} }
        static string Final(SafeFileHandle handle,uint flags){StringBuilder value=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(handle,value,(uint)value.Capacity,flags);if(n==0||n>=value.Capacity)throw new IOException("fixture_final_path_failed",Marshal.GetLastWin32Error());string path=value.ToString();if(path.StartsWith("\\\\?\\",StringComparison.OrdinalIgnoreCase))path=path.Substring(4);return path.TrimEnd('\\');}
        internal static Identity ReadIdentity(SafeFileHandle handle){FILE_ID_INFO id=Read<FILE_ID_INFO>(handle,18);FILE_STANDARD_INFO standard=Read<FILE_STANDARD_INFO>(handle,1);return new Identity(id.VolumeSerialNumber,id.FileId.Identifier,Final(handle,0),Final(handle,1),standard.NumberOfLinks,standard.Directory);}
        internal static SafeFileHandle Open(string path,bool directory){SafeFileHandle handle=CreateFileW(path,GENERIC_READ,FILE_SHARE_READ,IntPtr.Zero,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,IntPtr.Zero);if(handle.IsInvalid)throw new IOException("fixture_host_pin_open_failed",Marshal.GetLastWin32Error());try{FILE_ATTRIBUTE_TAG_INFO tag=Read<FILE_ATTRIBUTE_TAG_INFO>(handle,9);Identity id=ReadIdentity(handle);if((tag.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)!=0||tag.ReparseTag!=0)throw new InvalidOperationException("fixture_host_pin_reparse_refused");if(id.Directory!=directory||(!directory&&id.Links!=1))throw new InvalidOperationException("fixture_host_pin_identity_refused");VerifyAcl(handle,id);return handle;}catch{handle.Dispose();throw;}}
        internal static void Verify(SafeFileHandle handle,string path,Identity expected){if(handle==null||handle.IsInvalid||handle.IsClosed)throw new InvalidOperationException("fixture_host_pin_closed");Identity now=ReadIdentity(handle);if(!expected.Same(now)||!String.Equals(path.TrimEnd('\\'),now.Dos,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("fixture_host_pin_drift");VerifyAcl(handle,expected);if(!expected.Same(ReadIdentity(handle)))throw new InvalidOperationException("fixture_host_pin_drift");}
        internal static SafeFileHandle Duplicate(SafeFileHandle source){SafeFileHandle duplicate;IntPtr process=GetCurrentProcess();if(!DuplicateHandle(process,source,process,out duplicate,0,false,2))throw new IOException("fixture_host_pin_duplicate_failed",Marshal.GetLastWin32Error());return duplicate;}
        internal static void VerifyAcl(SafeFileHandle handle,Identity expected){if(!expected.Same(ReadIdentity(handle)))throw new InvalidOperationException("fixture_host_pin_drift");IntPtr owner,group,dacl,sacl,descriptor;uint status=GetSecurityInfo(handle,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,out owner,out group,out dacl,out sacl,out descriptor);if(status!=0||descriptor==IntPtr.Zero)throw new IOException("fixture_handle_acl_read_failed",unchecked((int)status));try{uint length=GetSecurityDescriptorLength(descriptor);if(length==0||length>1024*1024)throw new InvalidOperationException("fixture_acl_descriptor_uncertain");byte[] bytes=new byte[length];Marshal.Copy(descriptor,bytes,0,(int)length);RawSecurityDescriptor security=new RawSecurityDescriptor(bytes,0);SecurityIdentifier me=WindowsIdentity.GetCurrent().User,system=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),admins=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null);if(security.Owner==null||!security.Owner.Equals(me)||security.DiscretionaryAcl==null)throw new InvalidOperationException("fixture_acl_untrusted");const int writeMask=unchecked((int)0x500D0156);bool inherited=false;foreach(GenericAce generic in security.DiscretionaryAcl){if((generic.AceFlags&AceFlags.Inherited)!=0)inherited=true;else if(inherited)throw new InvalidOperationException("fixture_acl_noncanonical");QualifiedAce ace=generic as QualifiedAce;KnownAce known=generic as KnownAce;if(ace==null||known==null||ace.SecurityIdentifier==null||ace.AceQualifier!=AceQualifier.AccessAllowed)throw new InvalidOperationException("fixture_acl_unknown_or_deny");if((known.AccessMask&writeMask)!=0&&!ace.SecurityIdentifier.Equals(me)&&!ace.SecurityIdentifier.Equals(system)&&!ace.SecurityIdentifier.Equals(admins))throw new InvalidOperationException("fixture_acl_untrusted");}}finally{LocalFree(descriptor);}}
        internal static string Hash(SafeFileHandle handle){using(SafeFileHandle duplicate=Duplicate(handle))using(FileStream stream=new FileStream(duplicate,FileAccess.Read,65536,false))using(System.Security.Cryptography.SHA256 sha=System.Security.Cryptography.SHA256.Create()){stream.Position=0;return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}}
    }
    public sealed class PinnedFile:IDisposable
    {
        readonly string path;SafeFileHandle handle;readonly Identity identity;readonly string sha256;int disposed;
        public PinnedFile(string value,bool directory){path=Path.GetFullPath(value).TrimEnd('\\');handle=Native.Open(path,directory);identity=Native.ReadIdentity(handle);Native.Verify(handle,path,identity);sha256=directory?String.Empty:Native.Hash(handle);Native.Verify(handle,path,identity);}
        public string PathValue=>path;public string Sha256=>sha256;
        public void Verify(){if(disposed!=0)throw new ObjectDisposedException("fixture_host_pin");Native.Verify(handle,path,identity);if(!identity.Directory&&!String.Equals(sha256,Native.Hash(handle),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("fixture_host_pin_hash_drift");}
        public void Dispose(){if(System.Threading.Interlocked.Exchange(ref disposed,1)==0&&handle!=null){handle.Dispose();handle=null;}}
    }
    public sealed class HostProvenance:IDisposable
    {
        readonly PinnedFile pwsh,host,module,consumer;readonly string operation;object moduleInfo;int disposed;
        public HostProvenance(PinnedFile pwshPin,PinnedFile hostPin,PinnedFile modulePin,PinnedFile consumerPin,string selectedOperation){pwsh=pwshPin;host=hostPin;module=modulePin;consumer=consumerPin;operation=selectedOperation;}
        public string HostSha256=>host.Sha256;public string ModuleSha256=>module.Sha256;public string ConsumerSha256=>consumer.Sha256;public string PwshSha256=>pwsh.Sha256;
        public void BindModuleInfo(object value){if(value==null||System.Threading.Interlocked.CompareExchange(ref moduleInfo,value,null)!=null)throw new InvalidOperationException("fixture_module_reference_refused");}
        public bool VerifyConsumer(string expectedHost,string expectedModule,object liveModule,string expectedOperation){if(disposed!=0||liveModule==null||!Object.ReferenceEquals(moduleInfo,liveModule)||!String.Equals(operation,expectedOperation,StringComparison.Ordinal))return false;pwsh.Verify();host.Verify();module.Verify();consumer.Verify();return String.Equals(host.Sha256,expectedHost,StringComparison.OrdinalIgnoreCase)&&String.Equals(module.Sha256,expectedModule,StringComparison.OrdinalIgnoreCase);}
        public void Dispose(){if(System.Threading.Interlocked.Exchange(ref disposed,1)!=0)return;consumer.Dispose();module.Dispose();host.Dispose();pwsh.Dispose();moduleInfo=null;}
    }
}
'@
    Add-Type -TypeDefinition $bootstrapSource -Language CSharp -ErrorAction Stop

    $hostPath = [IO.Path]::GetFullPath($PSCommandPath)
    $modulePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'RevAgent.TestFixtureAuthority.psm1'))
    $consumerPath = [IO.Path]::GetFullPath($ConsumerScriptPath)
    $pwshPath = [IO.Path]::GetFullPath($ExpectedPwshPath)
    if (-not [string]::Equals([Environment]::ProcessPath, $pwshPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'fixture_pwsh_identity_refused' }
    $pwshPin = [RevAgent.CleanFixtureHost.PinnedFile]::new($pwshPath, $false)
    $hostPin = [RevAgent.CleanFixtureHost.PinnedFile]::new($hostPath, $false)
    $modulePin = [RevAgent.CleanFixtureHost.PinnedFile]::new($modulePath, $false)
    $consumerPin = [RevAgent.CleanFixtureHost.PinnedFile]::new($consumerPath, $false)
    $hostProvenance = [RevAgent.CleanFixtureHost.HostProvenance]::new($pwshPin, $hostPin, $modulePin, $consumerPin, $Operation)

    foreach ($pair in @(@([string]$hostProvenance.PwshSha256,$ExpectedPwshSha256,'fixture_pwsh_digest_refused'),@([string]$hostProvenance.HostSha256,$ExpectedHostSha256,'fixture_host_digest_refused'),@([string]$hostProvenance.ModuleSha256,$ExpectedModuleSha256,'fixture_module_digest_refused'),@([string]$hostProvenance.ModuleSha256,$expectedModuleLiteralSha256,'fixture_module_literal_digest_refused'),@([string]$hostProvenance.ConsumerSha256,$ExpectedConsumerSha256,'fixture_consumer_digest_refused'))) {
        if (-not [string]::Equals($pair[0],$pair[1],[StringComparison]::OrdinalIgnoreCase)) { throw $pair[2] }
    }
    $fixtureModule = @(Microsoft.PowerShell.Core\Import-Module -Name $modulePath -Force -PassThru -ErrorAction Stop)
    if ($fixtureModule.Count -ne 1 -or -not [object]::ReferenceEquals($fixtureModule[0],$fixtureModule[0].SessionState.Module) -or -not [string]::Equals([IO.Path]::GetFullPath([string]$fixtureModule[0].Path),$modulePath,[StringComparison]::OrdinalIgnoreCase)) { throw 'fixture_authority_module_identity_refused' }
    $hostProvenance.BindModuleInfo($fixtureModule[0])
    if (-not [string]::Equals([string]$hostProvenance.ModuleSha256,(Get-FileHash -LiteralPath $modulePath -Algorithm SHA256).Hash,[StringComparison]::OrdinalIgnoreCase)) { throw 'fixture_authority_module_hash_drift' }

    $authority = if ($AuthorityMode -in @('Valid','ExistingTarget')) {
        if ($Operation -eq 'Gui') {
            if ([string]::IsNullOrWhiteSpace($LogDirectory)) { throw 'fixture_gui_log_directory_required' }
            $collisionName = if ($AuthorityMode -eq 'ExistingTarget') { 'gui-startup-existing-target.log' } else { '' }
            if ($AuthorityMode -eq 'ExistingTarget') { [IO.File]::WriteAllText((Join-Path $LogDirectory $collisionName),'must-remain-unchanged',[Text.UTF8Encoding]::new($false)) }
            New-RevAgentGuiLogFixtureAuthority -FixtureRoot $FixtureRoot -LogDirectory $LogDirectory -ModuleInfo $fixtureModule[0] -HostProvenance $hostProvenance -CollisionLogNameForTest $collisionName
        } else {
            if ([string]::IsNullOrWhiteSpace($DiscoveryRoot) -or [string]::IsNullOrWhiteSpace($ReportsRoot)) { throw 'fixture_publisher_roots_required' }
            New-RevAgentDesktopDiscoveryFixtureAuthority -FixtureRoot $FixtureRoot -DiscoveryRoot $DiscoveryRoot -ReportsRoot $ReportsRoot -ModuleInfo $fixtureModule[0] -HostProvenance $hostProvenance
        }
    } elseif ($AuthorityMode -eq 'Malformed') { [pscustomobject]@{ purpose=$Operation;fixtureRoot=$FixtureRoot } } else { $null }

    if ($TestHoldBeforeConsumerMilliseconds -gt 0) { [Threading.Thread]::Sleep($TestHoldBeforeConsumerMilliseconds) }

    if ($Operation -eq 'Gui') {
        $consumerModuleInfo = if ($AuthorityMode -eq 'Missing') { $null } else { $fixtureModule[0] }
        $consumerHostProvenance = if ($AuthorityMode -eq 'Missing') { $null } else { $hostProvenance }
        $arguments = @{ ChannelManifestPath=$ChannelManifestPath;InstallRoot=$InstallRoot;BootstrapStatePath=$BootstrapStatePath;TestFixtureAuthority=$authority;TestFixtureModuleInfo=$consumerModuleInfo;TestFixtureHostProvenance=$consumerHostProvenance }
        if ($SmokeTest) { $arguments.SmokeTest=$true };if ($ModulePathSecuritySmokeTest) { $arguments.ModulePathSecuritySmokeTest=$true };if ($PreWindowBootstrapSmokeTest) { $arguments.PreWindowBootstrapSmokeTest=$true };if ($SuppressStartupFailureDialogForTest) { $arguments.SuppressStartupFailureDialogForTest=$true };if (-not [string]::IsNullOrWhiteSpace($TestStartupFailureMessage)) { $arguments.TestStartupFailureMessage=$TestStartupFailureMessage }
        $global:LASTEXITCODE=0;& $consumerPath @arguments;$guiExitCode=[int]$LASTEXITCODE
    } else {
        $publisherArguments = if ([string]::IsNullOrWhiteSpace($PublisherArgumentsJson)) { @{} } else { $PublisherArgumentsJson | ConvertFrom-Json -AsHashtable -Depth 30 }
        $publisherArguments.TestFixtureAuthority=$authority;$publisherArguments.TestFixtureModuleInfo=$fixtureModule[0];$publisherArguments.TestFixtureHostProvenance=$hostProvenance
        & $consumerPath @publisherArguments
    }
}
finally {
    if ($null -ne $authority -and $authority -is [IDisposable]) { $authority.Dispose() }
    if ($null -ne $hostProvenance) { $hostProvenance.Dispose() }
}
if ($Operation -eq 'Gui' -and $guiExitCode -ne 0) { exit $guiExitCode }
$global:LASTEXITCODE=0
