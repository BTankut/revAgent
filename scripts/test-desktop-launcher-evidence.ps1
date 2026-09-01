<#
.SYNOPSIS
    CI-safe clean-host tests for desktop launcher evidence publishing.
#>
[CmdletBinding()]
param([string]$RepoRoot = '',[Parameter(DontShow=$true)][switch]$LibraryOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$publisherPath = Join-Path $RepoRoot 'scripts\publish-desktop-launcher-evidence.ps1'
$hostPath = Join-Path $RepoRoot 'scripts\Invoke-RevAgentUpdaterGuiTestHost.ps1'
$modulePath = Join-Path $RepoRoot 'scripts\RevAgent.TestFixtureAuthority.psm1'
$pwshCandidate = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $pwshCandidate -PathType Leaf)) {
    $pwshCandidate = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop |
        Select-Object -First 1).Source
}
$pwshPath = [IO.Path]::GetFullPath($pwshCandidate)
$expectedHostSha256 = '2c6ab614fc33c1bed2e878c8f3a6c6fcfdc10176aa7470b0703f49519c3d646c'
$expectedModuleSha256 = 'b21d81ae3ad015b82535ce449454b89ad5cc2fc1d8c9cd0a47820c4a5d6293cc'
$expectedPublisherSha256 = '762a84a595c8b2a630c1010b7e2af50a03f707fb8e1985e50542caf8db240d91'

function Assert-True { param([bool]$Condition,[string]$Message) if (-not $Condition) { throw $Message } }
function Assert-Equal { param([object]$Actual,[object]$Expected,[string]$Message) if (-not [object]::Equals($Actual,$Expected)) { throw "$Message Expected '$Expected', got '$Actual'." } }

function Get-Sha256Hex {
    param([Parameter(Mandatory=$true)][byte[]]$Bytes)
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}
function ConvertTo-PowerShellSingleQuotedLiteral {
    param([AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { $Value='' }
    return "'"+$Value.Replace("'","''")+"'"
}
function ConvertTo-WindowsCommandLineArgument {
    param([AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { $Value='' }
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder=New-Object Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes=0
    foreach($character in $Value.ToCharArray()) {
        if ($character -eq [char]0x5C) { $backslashes++;continue }
        if ($character -eq [char]0x22) {
            if ($backslashes -gt 0) { [void]$builder.Append((('\' * ($backslashes*2+1))-join'')) }
            else { [void]$builder.Append('\') }
            [void]$builder.Append('"');$backslashes=0;continue
        }
        if ($backslashes -gt 0) { [void]$builder.Append((('\' * $backslashes)-join''));$backslashes=0 }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) { [void]$builder.Append((('\' * ($backslashes*2))-join'')) }
    [void]$builder.Append('"')
    return $builder.ToString()
}
function Set-ProcessArguments {
    param(
        [Parameter(Mandatory=$true)][Diagnostics.ProcessStartInfo]$StartInfo,
        [Parameter(Mandatory=$true)][string[]]$Arguments
    )
    $quoted=@($Arguments|ForEach-Object{ConvertTo-WindowsCommandLineArgument $_})
    $StartInfo.Arguments=[string]::Join(' ',$quoted)
}
function Stop-TestProcess {
    param([Parameter(Mandatory=$true)][Diagnostics.Process]$Process)
    try { $Process.Kill($true) }
    catch { try { $Process.Kill() } catch {} }
}

function Protect-FixtureRoot {
    param([Parameter(Mandatory=$true)][string]$Path)
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent();$acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($identity.User);$acl.SetAccessRuleProtection($true,$false)
    $inheritance=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach($sid in @($identity.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}
    if ('System.IO.FileSystemAclExtensions' -as [type]) {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item,$acl)
    } else {
        ([IO.DirectoryInfo]$item).SetAccessControl($acl)
    }
}

$parentPinSource=@'
using System;using System.IO;using System.Linq;using System.Runtime.InteropServices;using System.Security.AccessControl;using System.Security.Principal;using System.Text;using Microsoft.Win32.SafeHandles;
namespace RevAgent.FixtureParent.Desktop {
internal sealed class Identity { internal readonly ulong V;internal readonly byte[] I;internal readonly string P;internal readonly uint L;internal Identity(ulong v,byte[] i,string p,uint l){V=v;I=i;P=p;L=l;}internal bool Same(Identity o){return o!=null&&V==o.V&&I.SequenceEqual(o.I)&&String.Equals(P,o.P,StringComparison.OrdinalIgnoreCase)&&L==o.L;} }
public sealed class Pin:IDisposable { const uint R=0x80000000,S=1,O=3,B=0x02000000,X=0x00200000,RP=0x400;const int SE=1;const uint OWNER=1,DACL=4;SafeFileHandle h;readonly Identity id;readonly string path,sha;readonly bool requireAcl;int disposed;
[StructLayout(LayoutKind.Sequential)]struct FID128{[MarshalAs(UnmanagedType.ByValArray,SizeConst=16)]public byte[] I;}[StructLayout(LayoutKind.Sequential)]struct FID{public ulong V;public FID128 I;}[StructLayout(LayoutKind.Sequential)]struct TAG{public uint A,T;}[StructLayout(LayoutKind.Sequential)]struct STD{public long A,E;public uint L;[MarshalAs(UnmanagedType.U1)]public bool D;[MarshalAs(UnmanagedType.U1)]public bool Dir;}
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr q,uint c,uint f,IntPtr t);[DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int c,IntPtr p,uint s);[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder p,uint n,uint f);[DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();[DllImport("kernel32.dll",SetLastError=true)]static extern bool DuplicateHandle(IntPtr a,SafeFileHandle b,IntPtr c,out SafeFileHandle d,uint e,bool f,uint g);[DllImport("advapi32.dll",SetLastError=true)]static extern uint GetSecurityInfo(SafeFileHandle h,int t,uint i,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr s,out IntPtr x);[DllImport("advapi32.dll",SetLastError=true)]static extern uint GetSecurityDescriptorLength(IntPtr p);[DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr p);
static T Read<T>(SafeFileHandle h,int c)where T:struct{int n=Marshal.SizeOf(typeof(T));IntPtr p=Marshal.AllocHGlobal(n);try{if(!GetFileInformationByHandleEx(h,c,p,(uint)n))throw new IOException("fixture_parent_identity_failed",Marshal.GetLastWin32Error());return(T)Marshal.PtrToStructure(p,typeof(T));}finally{Marshal.FreeHGlobal(p);}}
static string Final(SafeFileHandle h){StringBuilder b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0);if(n==0||n>=b.Capacity)throw new IOException("fixture_parent_final_path_failed",Marshal.GetLastWin32Error());string p=b.ToString();if(p.StartsWith("\\\\?\\"))p=p.Substring(4);return p.TrimEnd('\\');}
static Identity Id(SafeFileHandle h){FID f=Read<FID>(h,18);STD s=Read<STD>(h,1);if(s.Dir)throw new InvalidOperationException("fixture_parent_file_required");return new Identity(f.V,f.I.I,Final(h),s.L);}
static void Acl(SafeFileHandle h,Identity expected){if(!expected.Same(Id(h)))throw new InvalidOperationException("fixture_parent_identity_drift");IntPtr o,g,d,s,x;uint r=GetSecurityInfo(h,SE,OWNER|DACL,out o,out g,out d,out s,out x);if(r!=0||x==IntPtr.Zero)throw new IOException("fixture_parent_acl_failed",(int)r);try{uint n=GetSecurityDescriptorLength(x);byte[] b=new byte[n];Marshal.Copy(x,b,0,(int)n);RawSecurityDescriptor sd=new RawSecurityDescriptor(b,0);SecurityIdentifier me=WindowsIdentity.GetCurrent().User,sys=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),adm=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null),ti=new SecurityIdentifier("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");Func<SecurityIdentifier,bool> trusted=y=>y!=null&&(y.Equals(me)||y.Equals(sys)||y.Equals(adm)||y.Equals(ti));if(sd.Owner==null||!trusted(sd.Owner)||sd.DiscretionaryAcl==null)throw new InvalidOperationException("fixture_parent_acl_untrusted");const int W=unchecked((int)0x500D0156);foreach(GenericAce z in sd.DiscretionaryAcl){QualifiedAce q=z as QualifiedAce;KnownAce k=z as KnownAce;if(q==null||k==null||q.SecurityIdentifier==null||q.AceQualifier!=AceQualifier.AccessAllowed)throw new InvalidOperationException("fixture_parent_acl_unknown");if((k.AccessMask&W)!=0&&!trusted(q.SecurityIdentifier))throw new InvalidOperationException("fixture_parent_acl_untrusted");}}finally{LocalFree(x);}if(!expected.Same(Id(h)))throw new InvalidOperationException("fixture_parent_identity_drift");}
static SafeFileHandle Dup(SafeFileHandle h){SafeFileHandle d;IntPtr p=GetCurrentProcess();if(!DuplicateHandle(p,h,p,out d,0,false,2))throw new IOException("fixture_parent_duplicate_failed",Marshal.GetLastWin32Error());return d;}
public Pin(string value):this(value,true){}
public Pin(string value,bool validateAcl){requireAcl=validateAcl;path=Path.GetFullPath(value).TrimEnd('\\');h=CreateFileW(path,R,S,IntPtr.Zero,O,B|X,IntPtr.Zero);if(h.IsInvalid)throw new IOException("fixture_parent_pin_failed",Marshal.GetLastWin32Error());try{TAG t=Read<TAG>(h,9);id=Id(h);if((t.A&RP)!=0||t.T!=0||id.L!=1||!String.Equals(path,id.P,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("fixture_parent_pin_refused");if(requireAcl)Acl(h,id);using(SafeFileHandle d=Dup(h))using(FileStream f=new FileStream(d,FileAccess.Read,65536,false))using(System.Security.Cryptography.SHA256 a=System.Security.Cryptography.SHA256.Create()){f.Position=0;sha=BitConverter.ToString(a.ComputeHash(f)).Replace("-","").ToLowerInvariant();}Verify();}catch{h.Dispose();throw;}}
public string Sha256{get{return sha;}}public void Verify(){if(disposed!=0||h==null||h.IsClosed||!id.Same(Id(h)))throw new InvalidOperationException("fixture_parent_pin_drift");if(requireAcl)Acl(h,id);}public void Dispose(){if(System.Threading.Interlocked.Exchange(ref disposed,1)==0&&h!=null){h.Dispose();h=null;}}
}}
'@
if (-not ('RevAgent.FixtureParent.Desktop.Pin' -as [type])) { Add-Type -TypeDefinition $parentPinSource -Language CSharp -ErrorAction Stop }

function Copy-RevAgentTrustedFixtureFile {
    param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Destination,[Parameter(Mandatory=$true)][string]$ExpectedSha256)
    $sourcePin=[RevAgent.FixtureParent.Desktop.Pin]::new($Source,$false)
    try {
        if(-not[string]::Equals($sourcePin.Sha256,$ExpectedSha256,[StringComparison]::OrdinalIgnoreCase)){throw'fixture_source_literal_digest_refused'}
        [IO.File]::Copy($Source,$Destination,$true)
        $destinationPin=[RevAgent.FixtureParent.Desktop.Pin]::new($Destination)
        try {if(-not[string]::Equals($destinationPin.Sha256,$ExpectedSha256,[StringComparison]::OrdinalIgnoreCase)){throw'fixture_copy_digest_refused'};$sourcePin.Verify();$destinationPin.Verify()}
        finally{$destinationPin.Dispose()}
    }finally{$sourcePin.Dispose()}
}

function Invoke-CleanFixtureHost {
    param(
        [Parameter(Mandatory=$true)][ValidateSet('Gui','Publisher')][string]$Operation,
        [Parameter(Mandatory=$true)][string]$ConsumerPath,
        [Parameter(Mandatory=$true)][string]$FixtureRoot,
        [hashtable]$HostArguments=@{},[hashtable]$PublisherArguments=@{},[hashtable]$EnvironmentOverrides=@{},
        [string]$SelectedHostPath=$hostPath,[string]$SelectedPwshPath=$pwshPath,[string]$WorkingRoot=$RepoRoot,
        [string]$ExpectedHostLiteralSha256=$expectedHostSha256,[string]$ExpectedModuleLiteralSha256=$expectedModuleSha256,
        [string]$ExpectedConsumerLiteralSha256=$expectedPublisherSha256,[int]$TimeoutSeconds=60
    )
    $selectedModule=Join-Path (Split-Path -Parent $SelectedHostPath) 'RevAgent.TestFixtureAuthority.psm1'
    $pins=[Collections.Generic.List[IDisposable]]::new();$process=$null
    try {
        $pwshPin=[RevAgent.FixtureParent.Desktop.Pin]::new($SelectedPwshPath);[void]$pins.Add($pwshPin)
        $hostPin=[RevAgent.FixtureParent.Desktop.Pin]::new($SelectedHostPath);[void]$pins.Add($hostPin)
        $modulePin=[RevAgent.FixtureParent.Desktop.Pin]::new($selectedModule);[void]$pins.Add($modulePin)
        $consumerPin=[RevAgent.FixtureParent.Desktop.Pin]::new($ConsumerPath);[void]$pins.Add($consumerPin)
        if (-not [string]::Equals($hostPin.Sha256,$ExpectedHostLiteralSha256,[StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($modulePin.Sha256,$ExpectedModuleLiteralSha256,[StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($consumerPin.Sha256,$ExpectedConsumerLiteralSha256,[StringComparison]::OrdinalIgnoreCase)) {
            return [pscustomobject]@{state='REFUSED_BEFORE_LAUNCH';exitCode=-1;stdout='';stderr='fixture_parent_literal_digest_refused';processId=0}
        }
        $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$SelectedPwshPath;$psi.UseShellExecute=$false;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.CreateNoWindow=$true;$psi.WorkingDirectory=$WorkingRoot
        $boundedNames=@('APPDATA','COMPUTERNAME','CommonProgramFiles','CommonProgramFiles(x86)','LOCALAPPDATA','OS','ProgramData','ProgramFiles','ProgramFiles(x86)','SystemDrive','SystemRoot','TEMP','TMP','USERPROFILE','WINDIR')
        $processEnvironment=$null;if($null-ne$psi.PSObject.Properties['Environment']){$processEnvironment=$psi.Environment}else{$processEnvironment=$psi.EnvironmentVariables};$processEnvironment.Clear();foreach($name in $boundedNames){$value=[Environment]::GetEnvironmentVariable($name,'Process');if($null-ne$value){$processEnvironment[$name]=$value}}
        $boundedText=[string]::Join("`n",@($boundedNames|ForEach-Object{$_+'='+[string]$processEnvironment[$_]}));$boundedHash=Get-Sha256Hex ([Text.Encoding]::UTF8.GetBytes($boundedText))
        foreach($entry in $EnvironmentOverrides.GetEnumerator()){$processEnvironment[[string]$entry.Key]=[string]$entry.Value}
        $childArguments=[Collections.Generic.List[string]]::new();foreach($value in @('-Operation',$Operation,'-ConsumerScriptPath',$ConsumerPath,'-FixtureRoot',$FixtureRoot,'-ExpectedPwshPath',$SelectedPwshPath,'-ExpectedPwshSha256',$pwshPin.Sha256,'-ExpectedBoundedEnvironmentSha256',$boundedHash,'-ExpectedHostSha256',$hostPin.Sha256,'-ExpectedModuleSha256',$modulePin.Sha256,'-ExpectedConsumerSha256',$consumerPin.Sha256)){[void]$childArguments.Add([string]$value)}
        if($Operation-eq'Publisher'){[void]$childArguments.Add('-PublisherArgumentsJson');[void]$childArguments.Add(($PublisherArguments|ConvertTo-Json -Compress -Depth 30))}
        foreach($key in @($HostArguments.Keys|Sort-Object)){if($HostArguments[$key]-is[bool]){if([bool]$HostArguments[$key]){[void]$childArguments.Add('-'+$key)}}else{[void]$childArguments.Add('-'+$key);[void]$childArguments.Add([string]$HostArguments[$key])}}
        $launchArguments=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$SelectedHostPath)+@($childArguments);Set-ProcessArguments $psi $launchArguments
        $process=[Diagnostics.Process]::new();$process.StartInfo=$psi;[void]$process.Start();$stdoutTask=$process.StandardOutput.ReadToEndAsync();$stderrTask=$process.StandardError.ReadToEndAsync()
        if(-not$process.WaitForExit($TimeoutSeconds*1000)){Stop-TestProcess $process;return [pscustomobject]@{state='UNCERTAIN';exitCode=-1;stdout=($stdoutTask.GetAwaiter()).GetResult();stderr=($stderrTask.GetAwaiter()).GetResult();processId=$process.Id}}
        $process.WaitForExit();foreach($pin in $pins){$pin.GetType().GetMethod('Verify').Invoke($pin,@())}
        return [pscustomobject]@{state='COMPLETED';exitCode=$process.ExitCode;stdout=($stdoutTask.GetAwaiter()).GetResult();stderr=($stderrTask.GetAwaiter()).GetResult();processId=$process.Id}
    } finally {if($null-ne$process){$process.Dispose()};for($i=$pins.Count-1;$i-ge0;$i--){$pins[$i].Dispose()}}
}

function Invoke-HostPreloadProbe {
    param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][ValidateSet('Type','Module')][string]$Kind)
    $bundle=Join-Path $Root 'trusted-bundle';$selectedHost=Join-Path $bundle (Split-Path -Leaf $hostPath);$selectedModule=Join-Path $bundle (Split-Path -Leaf $modulePath);$consumer=Join-Path $bundle (Split-Path -Leaf $publisherPath)
    $pins=[Collections.Generic.List[IDisposable]]::new();$process=$null
    try {
        foreach($path in @($pwshPath,$selectedHost,$selectedModule,$consumer)){[void]$pins.Add([RevAgent.FixtureParent.Desktop.Pin]::new($path))}
        if(-not[string]::Equals($pins[1].Sha256,$expectedHostSha256,[StringComparison]::OrdinalIgnoreCase)-or-not[string]::Equals($pins[2].Sha256,$expectedModuleSha256,[StringComparison]::OrdinalIgnoreCase)-or-not[string]::Equals($pins[3].Sha256,$expectedPublisherSha256,[StringComparison]::OrdinalIgnoreCase)){throw'fixture_parent_literal_digest_refused'}
        $names=@('APPDATA','COMPUTERNAME','CommonProgramFiles','CommonProgramFiles(x86)','LOCALAPPDATA','OS','ProgramData','ProgramFiles','ProgramFiles(x86)','SystemDrive','SystemRoot','TEMP','TMP','USERPROFILE','WINDIR');$environment=@{};foreach($name in $names){$environment[$name]=[string][Environment]::GetEnvironmentVariable($name,'Process')};$text=[string]::Join("`n",@($names|ForEach-Object{$_+'='+$environment[$_]}));$environmentHash=Get-Sha256Hex ([Text.Encoding]::UTF8.GetBytes($text))
        $quote={param($value)"'"+[string]$value.Replace("'","''")+"'"}
        $discovery=Join-Path $Root 'discovery';$reports=Join-Path $Root 'reports';[void][IO.Directory]::CreateDirectory($discovery);[void][IO.Directory]::CreateDirectory($reports)
        $prefix=if($Kind-eq'Type'){"Add-Type -TypeDefinition 'namespace RevAgent.TestFixtures { public sealed class RevAgentTestFixtureAuthority { } }';"}else{$hostile=Join-Path $Root 'RevAgent.TestFixtureAuthority.Hostile.psm1';[IO.File]::WriteAllText($hostile,'# hostile reserved module preload',[Text.UTF8Encoding]::new($false));"Import-Module -Name $(& $quote $hostile) -Force;"}
        $command=$prefix+" & $(& $quote $selectedHost) -Operation Publisher -ConsumerScriptPath $(& $quote $consumer) -FixtureRoot $(& $quote $Root) -DiscoveryRoot $(& $quote $discovery) -ReportsRoot $(& $quote $reports) -PublisherArgumentsJson '{}' -ExpectedPwshPath $(& $quote $pwshPath) -ExpectedPwshSha256 $(& $quote $pins[0].Sha256) -ExpectedBoundedEnvironmentSha256 $(& $quote $environmentHash) -ExpectedHostSha256 $(& $quote $pins[1].Sha256) -ExpectedModuleSha256 $(& $quote $pins[2].Sha256) -ExpectedConsumerSha256 $(& $quote $pins[3].Sha256)"
        $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$pwshPath;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.WorkingDirectory=$RepoRoot;$processEnvironment=$null;if($null-ne$psi.PSObject.Properties['Environment']){$processEnvironment=$psi.Environment}else{$processEnvironment=$psi.EnvironmentVariables};$processEnvironment.Clear();foreach($name in $names){if($null-ne$environment[$name]){$processEnvironment[$name]=$environment[$name]}}
        Set-ProcessArguments $psi @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',$command)
        $process=[Diagnostics.Process]::new();$process.StartInfo=$psi;[void]$process.Start();$out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync();if(-not$process.WaitForExit(30000)){Stop-TestProcess $process;throw'fixture_preload_probe_timeout'};$process.WaitForExit();return [pscustomobject]@{exitCode=$process.ExitCode;stdout=($out.GetAwaiter()).GetResult();stderr=($err.GetAwaiter()).GetResult()}
    }finally{if($null-ne$process){$process.Dispose()};for($i=$pins.Count-1;$i-ge0;$i--){$pins[$i].Dispose()}}
}

function New-CaseRoot {
    param([string]$Name)
    $root=Join-Path ([IO.Path]::GetTempPath()) ('revagent-v3-desktop-'+$Name+'-'+[guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($root);Protect-FixtureRoot $root
    $bundle=Join-Path $root 'trusted-bundle';[void][IO.Directory]::CreateDirectory($bundle)
    Copy-RevAgentTrustedFixtureFile $hostPath (Join-Path $bundle (Split-Path -Leaf $hostPath)) $expectedHostSha256
    Copy-RevAgentTrustedFixtureFile $modulePath (Join-Path $bundle (Split-Path -Leaf $modulePath)) $expectedModuleSha256
    Copy-RevAgentTrustedFixtureFile $publisherPath (Join-Path $bundle (Split-Path -Leaf $publisherPath)) $expectedPublisherSha256
    return $root
}
function Invoke-PublisherCase {
    param([string]$Root,[string]$Discovery,[string]$Reports,[hashtable]$Arguments,[hashtable]$HostArguments=@{},[hashtable]$EnvironmentOverrides=@{},[string]$SelectedHostPath=$hostPath,[int]$TimeoutSeconds=60)
    if ([string]::Equals($SelectedHostPath,$hostPath,[StringComparison]::OrdinalIgnoreCase)) { $SelectedHostPath=Join-Path (Join-Path $Root 'trusted-bundle') (Split-Path -Leaf $hostPath) }
    $selectedConsumer=Join-Path (Split-Path -Parent $SelectedHostPath) (Split-Path -Leaf $publisherPath)
    $hostArgs=@{DiscoveryRoot=$Discovery;ReportsRoot=$Reports};foreach($key in $HostArguments.Keys){$hostArgs[$key]=$HostArguments[$key]}
    $result = @(Invoke-CleanFixtureHost -Operation Publisher -ConsumerPath $selectedConsumer -FixtureRoot $Root -HostArguments $hostArgs -PublisherArguments $Arguments -EnvironmentOverrides $EnvironmentOverrides -SelectedHostPath $SelectedHostPath -TimeoutSeconds $TimeoutSeconds)
    return $result[-1]
}
function Require-SuccessJson { param($Result,[string]$Context) Assert-True ($Result.state-eq'COMPLETED'-and$Result.exitCode-eq0) "$Context failed: $($Result.stderr)";return ($Result.stdout|ConvertFrom-Json) }

if ($LibraryOnly) { return }

$roots=[Collections.Generic.List[string]]::new();$pids=[Collections.Generic.HashSet[int]]::new();$now='2026-06-30T10:00:00Z'
try {
    $legacyRoot=New-CaseRoot legacy;$roots.Add($legacyRoot);$legacyDiscovery=Join-Path $legacyRoot 'discovery';$legacyReports=Join-Path $legacyRoot 'reports';$legacyDesktop=Join-Path $legacyDiscovery 'Desktop';[void][IO.Directory]::CreateDirectory($legacyDesktop);[void][IO.Directory]::CreateDirectory($legacyReports)
    [IO.File]::WriteAllText((Join-Path $legacyDesktop 'revAgent Updater STABLE.cmd'),'@echo off',[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText((Join-Path $legacyDesktop 'Revit MCP Updater STABLE.cmd'),'revit-mcp-deploy',[Text.UTF8Encoding]::new($false))
    $legacyResult=Invoke-PublisherCase $legacyRoot $legacyDiscovery $legacyReports @{Mode='ScanLocal';MachineName='NET01';LauncherPath=@($legacyDesktop);NowUtc=$now;OutputJson=$true};[void]$pids.Add($legacyResult.processId);$legacy=Require-SuccessJson $legacyResult legacy
    Assert-True (-not[bool]$legacy.passed) 'Legacy scan should fail.';Assert-Equal ([int]$legacy.legacyLauncherCount) 1 'Legacy launcher count mismatch.'

    $cleanRoot=New-CaseRoot clean;$roots.Add($cleanRoot);$cleanDiscovery=Join-Path $cleanRoot 'discovery';$cleanReports=Join-Path $cleanRoot 'reports';$cleanDesktop=Join-Path $cleanDiscovery 'Desktop';[void][IO.Directory]::CreateDirectory($cleanDesktop);[void][IO.Directory]::CreateDirectory($cleanReports);[IO.File]::WriteAllText((Join-Path $cleanDesktop 'revAgent Updater STABLE.cmd'),'revAgent-deploy',[Text.UTF8Encoding]::new($false))
    $cleanResult=Invoke-PublisherCase $cleanRoot $cleanDiscovery $cleanReports @{Mode='ScanLocal';MachineName='NET01';LauncherPath=@($cleanDesktop);NowUtc=$now;OutputJson=$true};[void]$pids.Add($cleanResult.processId);$clean=Require-SuccessJson $cleanResult clean;Assert-True ([bool]$clean.passed) 'Clean scan should pass.'

    $profileRoot=New-CaseRoot profiles;$roots.Add($profileRoot);$profileDiscovery=Join-Path $profileRoot 'discovery';$profileReports=Join-Path $profileRoot 'reports';$alice=Join-Path $profileDiscovery 'profiles\Alice\Desktop';$one=Join-Path $profileDiscovery 'current-profile\OneDrive - DPE\Desktop';$known=Join-Path $profileDiscovery 'known-folders\DesktopDirectory';[void][IO.Directory]::CreateDirectory($alice);[void][IO.Directory]::CreateDirectory($one);[void][IO.Directory]::CreateDirectory($known);[void][IO.Directory]::CreateDirectory($profileReports);[IO.File]::WriteAllText((Join-Path $alice 'Revit MCP Updater STABLE.cmd'),'revit-mcp-deploy',[Text.UTF8Encoding]::new($false))
    $profileResult=Invoke-PublisherCase $profileRoot $profileDiscovery $profileReports @{Mode='ScanLocal';MachineName='PROFILE';NowUtc=$now;OutputJson=$true};[void]$pids.Add($profileResult.processId);$profile=Require-SuccessJson $profileResult profiles;Assert-True (@($profile.scannedPaths)-contains$alice) 'All-profile fixture missed Alice.'

    $copyRoot=New-CaseRoot copied;$roots.Add($copyRoot);$copyHostDir=Join-Path $copyRoot 'trusted-bundle';$copyHost=Join-Path $copyHostDir (Split-Path -Leaf $hostPath);$copyModule=Join-Path $copyHostDir (Split-Path -Leaf $modulePath);$copyDiscovery=Join-Path $copyRoot 'discovery';$copyReports=Join-Path $copyRoot 'reports';[void][IO.Directory]::CreateDirectory($copyDiscovery);[void][IO.Directory]::CreateDirectory($copyReports)
    $copyResult=Invoke-PublisherCase $copyRoot $copyDiscovery $copyReports @{Mode='ScanLocal';MachineName='COPY';LauncherPath=@();NowUtc=$now;OutputJson=$true} @{} @{} $copyHost;[void]$pids.Add($copyResult.processId);[void](Require-SuccessJson $copyResult copied)

    $mutatedDir=Join-Path $copyRoot 'mutated-bundle';[void][IO.Directory]::CreateDirectory($mutatedDir);$mutatedHost=Join-Path $mutatedDir (Split-Path -Leaf $hostPath);[IO.File]::WriteAllBytes($mutatedHost,@([IO.File]::ReadAllBytes($hostPath)+[Text.Encoding]::UTF8.GetBytes("`n#mutated")));[IO.File]::Copy($modulePath,(Join-Path $mutatedDir (Split-Path -Leaf $modulePath)));[IO.File]::Copy($publisherPath,(Join-Path $mutatedDir (Split-Path -Leaf $publisherPath)))
    $refused=Invoke-PublisherCase $copyRoot $copyDiscovery $copyReports @{Mode='ScanLocal';MachineName='BAD';OutputJson=$true} @{} @{} $mutatedHost;Assert-Equal $refused.state 'REFUSED_BEFORE_LAUNCH' 'One-byte host mutation started a child.'

    $moduleMutationRoot=New-CaseRoot modulemutation;$roots.Add($moduleMutationRoot);$moduleMutationBundle=Join-Path $moduleMutationRoot 'trusted-bundle';$moduleMutationPath=Join-Path $moduleMutationBundle (Split-Path -Leaf $modulePath);[IO.File]::WriteAllBytes($moduleMutationPath,@([IO.File]::ReadAllBytes($moduleMutationPath)+[Text.Encoding]::UTF8.GetBytes("`n#mutated")));$moduleMutationDiscovery=Join-Path $moduleMutationRoot 'discovery';$moduleMutationReports=Join-Path $moduleMutationRoot 'reports';[void][IO.Directory]::CreateDirectory($moduleMutationDiscovery);[void][IO.Directory]::CreateDirectory($moduleMutationReports)
    $moduleRefused=Invoke-PublisherCase $moduleMutationRoot $moduleMutationDiscovery $moduleMutationReports @{Mode='ScanLocal';MachineName='BADMODULE';OutputJson=$true};Assert-Equal $moduleRefused.state 'REFUSED_BEFORE_LAUNCH' 'One-byte module mutation started a child.'

    $modulePathRoot=New-CaseRoot modulepath;$roots.Add($modulePathRoot);$modulePathDiscovery=Join-Path $modulePathRoot 'discovery';$modulePathReports=Join-Path $modulePathRoot 'reports';$hostileModuleRoot=Join-Path $modulePathRoot 'hostile-modules';[void][IO.Directory]::CreateDirectory($modulePathDiscovery);[void][IO.Directory]::CreateDirectory($modulePathReports);[void][IO.Directory]::CreateDirectory($hostileModuleRoot);$hostileMarker=Join-Path $modulePathRoot 'hostile-module-loaded.txt';$hostileModule=Join-Path $hostileModuleRoot 'RevAgent.TestFixtureAuthority.psm1';[IO.File]::WriteAllText($hostileModule,("[IO.File]::WriteAllText('"+$hostileMarker.Replace("'","''")+"','loaded')"),[Text.UTF8Encoding]::new($false))
    $modulePathResult=Invoke-PublisherCase $modulePathRoot $modulePathDiscovery $modulePathReports @{Mode='ScanLocal';MachineName='MODULEPATH';LauncherPath=@();OutputJson=$true} @{} @{PSModulePath=$hostileModuleRoot};[void](Require-SuccessJson $modulePathResult modulepath);Assert-True (-not(Test-Path -LiteralPath $hostileMarker)) 'Hostile PSModulePath module autoloaded.'

    $typePreloadRoot=New-CaseRoot typepreload;$roots.Add($typePreloadRoot);$typePreload=@(Invoke-HostPreloadProbe -Root $typePreloadRoot -Kind Type)[-1];Assert-True ($typePreload.exitCode-ne0-and$typePreload.stderr-match'fixture_authority_type_preloaded') 'Reserved authority type preload did not fail before host IO.';Assert-True (-not(Test-Path (Join-Path $typePreloadRoot '.revagent-test-fixture-owner'))) 'Type preload created a fixture marker.'
    $modulePreloadRoot=New-CaseRoot modulepreload;$roots.Add($modulePreloadRoot);$modulePreload=@(Invoke-HostPreloadProbe -Root $modulePreloadRoot -Kind Module)[-1];Assert-True ($modulePreload.exitCode-ne0-and$modulePreload.stderr-match'fixture_authority_module_preloaded') 'Reserved module preload did not fail before host IO.';Assert-True (-not(Test-Path (Join-Path $modulePreloadRoot '.revagent-test-fixture-owner'))) 'Module preload created a fixture marker.'

    $hardRoot=New-CaseRoot hardlink;$roots.Add($hardRoot);$hardDiscovery=Join-Path $hardRoot 'discovery';$hardReports=Join-Path $hardRoot 'reports';$hardDesktop=Join-Path $hardDiscovery 'Desktop';[void][IO.Directory]::CreateDirectory($hardDesktop);[void][IO.Directory]::CreateDirectory($hardReports);$source=Join-Path $hardDesktop 'revAgent Updater STABLE.cmd';[IO.File]::WriteAllText($source,'@echo off',[Text.UTF8Encoding]::new($false));New-Item -ItemType HardLink -Path (Join-Path $hardDesktop 'alias.cmd') -Target $source|Out-Null
    $hardResult=Invoke-PublisherCase $hardRoot $hardDiscovery $hardReports @{Mode='ScanLocal';MachineName='HARD';LauncherPath=@($hardDesktop);OutputJson=$true};Assert-True ($hardResult.exitCode-ne0-and$hardResult.stderr-match'hardlink') 'Hardlink was not fatal.'

    $shareRoot=New-CaseRoot sharing;$roots.Add($shareRoot);$shareDiscovery=Join-Path $shareRoot 'discovery';$shareReports=Join-Path $shareRoot 'reports';$shareDesktop=Join-Path $shareDiscovery 'Desktop';[void][IO.Directory]::CreateDirectory($shareDesktop);[void][IO.Directory]::CreateDirectory($shareReports);$shareFile=Join-Path $shareDesktop 'revAgent Updater STABLE.cmd';[IO.File]::WriteAllText($shareFile,'@echo off',[Text.UTF8Encoding]::new($false));$exclusive=[IO.File]::Open($shareFile,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try{$shareResult=Invoke-PublisherCase $shareRoot $shareDiscovery $shareReports @{Mode='ScanLocal';MachineName='SHARE';LauncherPath=@($shareDesktop);OutputJson=$true};Assert-True ($shareResult.exitCode-ne0-and$shareResult.stderr-match'native_open') 'Sharing violation became missing.'}finally{$exclusive.Dispose()}

    $batchRoot=New-CaseRoot batch;$roots.Add($batchRoot);$batchDiscovery=Join-Path $batchRoot 'discovery';$batchReports=Join-Path $batchRoot 'reports';$batchDesktop=Join-Path $batchDiscovery 'Desktop';[void][IO.Directory]::CreateDirectory($batchDesktop);[void][IO.Directory]::CreateDirectory($batchReports);foreach($n in 0..2){[IO.File]::WriteAllText((Join-Path $batchDesktop ("0$n.cmd")),'@echo off',[Text.UTF8Encoding]::new($false))}
    $batchResult=Invoke-PublisherCase $batchRoot $batchDiscovery $batchReports @{Mode='ScanLocal';MachineName='BATCH';LauncherPath=@($batchDesktop);OutputJson=$true;TestFixtureFailFirstLauncher=$true};Assert-True ($batchResult.exitCode-ne0-and$batchResult.stderr-match'injected_first') 'Injected first-file failure was not fatal.';Assert-True (-not(Test-Path (Join-Path $batchReports 'machines\BATCH\desktop-launcher-latest.json'))) 'Fatal batch published a report.'

    $uncertainRoot=New-CaseRoot uncertain;$roots.Add($uncertainRoot);$uncertainDiscovery=Join-Path $uncertainRoot 'discovery';$uncertainReports=Join-Path $uncertainRoot 'reports';[void][IO.Directory]::CreateDirectory($uncertainDiscovery);[void][IO.Directory]::CreateDirectory($uncertainReports)
    $uncertainResult=Invoke-PublisherCase $uncertainRoot $uncertainDiscovery $uncertainReports @{Mode='ScanLocal';MachineName='UNCERTAIN';LauncherPath=@();OutputJson=$true} @{TestHoldBeforeConsumerMilliseconds=10000} @{} $hostPath 1;Assert-Equal $uncertainResult.state 'UNCERTAIN' 'Killed child was not classified UNCERTAIN.';Assert-True (-not(Test-Path (Join-Path $uncertainReports 'machines\UNCERTAIN\desktop-launcher-latest.json'))) 'UNCERTAIN child output was accepted.'
    $afterUncertainRoot=New-CaseRoot afteruncertain;$roots.Add($afterUncertainRoot);$afterUncertainDiscovery=Join-Path $afterUncertainRoot 'discovery';$afterUncertainReports=Join-Path $afterUncertainRoot 'reports';[void][IO.Directory]::CreateDirectory($afterUncertainDiscovery);[void][IO.Directory]::CreateDirectory($afterUncertainReports);$afterUncertainResult=Invoke-PublisherCase $afterUncertainRoot $afterUncertainDiscovery $afterUncertainReports @{Mode='ScanLocal';MachineName='AFTER';LauncherPath=@();OutputJson=$true};[void](Require-SuccessJson $afterUncertainResult afteruncertain);Assert-True ($afterUncertainResult.processId-ne$uncertainResult.processId) 'Post-UNCERTAIN attempt reused the killed process.'

    $aggregateRoot=New-CaseRoot aggregate;$roots.Add($aggregateRoot);$aggregateDiscovery=Join-Path $aggregateRoot 'discovery';$aggregateReports=Join-Path $aggregateRoot 'reports';[void][IO.Directory]::CreateDirectory($aggregateDiscovery);$net=Join-Path $aggregateReports 'machines\NET01';[void][IO.Directory]::CreateDirectory($net);@{schemaVersion='revagent.desktopLauncherEvidence.v1';mode='ScanLocal';machine='NET01';passed=$true;legacyLauncherCount=0;legacyRootReferenceCount=0}|ConvertTo-Json|Set-Content (Join-Path $net 'desktop-launcher-latest.json') -Encoding UTF8
    $aggregateResult=Invoke-PublisherCase $aggregateRoot $aggregateDiscovery $aggregateReports @{Mode='Aggregate';ExpectedMachines=@('NET01','EMIN');NowUtc=$now;OutputJson=$true};$aggregate=Require-SuccessJson $aggregateResult aggregate;Assert-Equal ([int]$aggregate.missingMachineCount) 1 'Optional native missing did not remain missing.'

    Assert-Equal $pids.Count 4 'Positive fixture operations did not use distinct fresh child processes.'
    foreach($root in @($legacyRoot,$cleanRoot,$profileRoot,$copyRoot,$hardRoot,$shareRoot,$batchRoot,$aggregateRoot)){ $renamed=$root+'-closed';Move-Item -LiteralPath $root -Destination $renamed;Move-Item -LiteralPath $renamed -Destination $root }
    $combined=@($legacyResult,$cleanResult,$profileResult,$copyResult,$hardResult,$shareResult,$batchResult,$aggregateResult)|ForEach-Object{$_.stdout+$_.stderr}|Out-String
    Assert-True ($combined-notmatch'(?i)raw.?handle|file.?id|volume.?guid|security descriptor|sddl|S-1-5-21-|nonce') 'Fixture diagnostics leaked authority internals.'

    $defaultRoot=New-CaseRoot default;$roots.Add($defaultRoot);$defaultDesktop=Join-Path $defaultRoot 'Desktop';$defaultReports=Join-Path $defaultRoot 'reports';[void][IO.Directory]::CreateDirectory($defaultDesktop);[void][IO.Directory]::CreateDirectory($defaultReports);[IO.File]::WriteAllText((Join-Path $defaultDesktop 'revAgent Updater STABLE.cmd'),'revAgent-deploy',[Text.UTF8Encoding]::new($false));$defaultJson=& $publisherPath -Mode ScanLocal -MachineName DEFAULT -LauncherPath $defaultDesktop -ReportsRoot $defaultReports -OutputJson|ConvertFrom-Json;Assert-True ([bool]$defaultJson.passed) 'Default no-authority publisher changed.'
}
finally {foreach($root in $roots){if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}}}
Write-Host 'Desktop launcher evidence clean-host tests passed.' -ForegroundColor Green
$global:LASTEXITCODE=0
