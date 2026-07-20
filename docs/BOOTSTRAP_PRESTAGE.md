# Protected local bootstrap prestage

This document covers the normal STABLE entry point, the primary supervised IT
prestage kit, and the longer manual high-assurance recovery procedure.

The contract is `config/bootstrap-prestage-evidence.schema.json`; the adjacent
example contains non-production placeholder hashes.

The signed NAS tree is a data transport and bounded non-elevated coordinator
surface, not an elevated trust root. The exact-managed STABLE/refresh
coordinator may run from NAS, but no loose NAS GUI, installer, or module may be
elevated or installed as a trust anchor.

E2 establishes the independent machine verifier required by G13. A one-time
supervised IT prestage installs an administrator-owned trust core under
`C:\ProgramData\DPE\revAgent\trust` and the fixed SYSTEM task
`\DPE\revAgent\revAgent Bootstrap Trust Broker`. After that, missing or stale
protected bootstrap files use a standard-user staging phase plus the fixed
broker; they never elevate a NAS file or caller-supplied trust decision. A
machine without a healthy core/task remains deliberately fail-closed at exit 84
and is directed to the supervised kit.

## Open decisions and non-goals

E2 implements the currently selected independent machine verifier, but D2 --
whether that is the final G13 release bar or publisher proof/E3 is additionally
required -- remains an operator decision. D3, the actual MDM/GPO deployment
authority available for fleet prestage, is also open. D4, the q3-to-future-key
rotation date/window and two-key overlap, is open. The active signing identity
remains `revagent-prod-rsa-2026q3`; `2026q4` is only a future placeholder and is
not installed or activated. E3 Authenticode has not started.

## Normal STABLE entry point

After a signed stable publication passes canonical published-surface readiness,
a standard user runs only:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\revAgent Updater STABLE.cmd
```

If the protected bootstrap is current and verified, STABLE bypasses Refresh,
opens the protected local GUI, and the normal split-privilege updater proceeds
unchanged. If it is missing or stale, Refresh first loads only its pinned local
PowerShell modules, copies the complete signed release set into a user-local
`%LOCALAPPDATA%\DPE\revAgent\release-inbox\<inboxId>`, writes
`%LOCALAPPDATA%\DPE\revAgent\broker-requests\bootstrap-request-<nonce>.json`
containing only schema/app/request type, nonce, requester SID, inbox id, and
creation time, and starts the fixed task. The request carries no verifier path,
trusted key, expected hash, release root, or installer command.

The SYSTEM broker resolves profiles through the 64-bit HKLM
`SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList` inventory, derives
each inbox from the SID/profile path, reads only that local inbox, and never
accesses NAS. Its round-robin queue scan is bounded to 128 profiles and 16
candidates per profile. One invocation terminalizes at most two requests per
SID and handles 16 total by default, with a hard maximum of 64. It independently
verifies the detached channel and release signatures, rollback/release-sequence
policy, package hash, exact embedded `config\release-trusted-keys.json`
identity, and all signed bootstrap component hashes using the admin-owned trust
core. It then applies the protected bootstrap and writes
`%ProgramData%\DPE\revAgent\bootstrap-broker\results\principal-<SID>\bootstrap-result-<nonce>.json`.
Result retention is bounded to 16 files per SID, 128 principal buckets, and
2048 files globally. The broker reserves the requester's protected result
bucket before snapshot acquisition or privileged apply. At exactly 128
buckets, a new SID is rejected before apply without creating a 129th bucket;
an existing SID can continue while its own 16-file bucket has capacity. Success
cleans the user staging and starts the protected
local launcher with `--post-refresh`; that continuation verifies the new
binding before opening the GUI. This is the clean-machine and eight-file
stale-bootstrap self-heal path.

There is no ProgramData request queue. Any legacy
`bootstrap-broker\requests` directory is ignored and is not an authority.
`state\broker.lock`, `snapshots`, `apply`, and `trust-transactions` are
SYSTEM/Administrators-only. The broker lock is the single-instance authority;
snapshots and apply scratch are bounded private artifacts, not caller-selected
paths.

No UAC transport remains in Refresh. Exit 80 means another broker/coordinator
instance owns the bounded operation, 81 means the broker result timed out, and
84 means the machine trust core/task is absent or unhealthy and IT must use the
exact five-file E1 kit below. All missing/unhealthy trust checks use this same
exit-84 direction; the manual recovery procedure is not the primary exit-84
response. The old 79 UAC-decline and 82 LUA outcomes were removed with their
dormant transport. E3 Authenticode is not part of this flow.

## Primary path: supervised IT prestage kit

The signed source-free CD workflow produces a separate short-lived artifact
named `revagent-supervised-prestage-kit-<run-id>-<run-attempt>`. It is created
only by an explicit `workflow_dispatch`, has one-day retention, and is not an
input to either the pilot or stable NAS publisher. For a prestage-only run,
leave both `publish_to_pilot` and `publish_to_nas` false. The workflow records
the kit ZIP SHA-256 in the protected run summary.

The downloaded artifact contains the kit ZIP and its checksum sidecar. The ZIP
itself has exactly these five public/runtime files:

- `IT-Prestage-revAgent.cmd`
- `scripts\Invoke-RevAgentSupervisedPrestage.ps1`
- `scripts\New-RevAgentBootstrapPrestageEvidence.ps1`
- `installer\lib\RevAgent.DistributionIntegrity.psm1`
- `config\release-trusted-keys.json`

IT must compare the downloaded ZIP SHA-256 with the value in the protected
workflow run summary before distribution. Move the verified ZIP through an
IT-controlled channel such as MDM, a protected IT share, or supervised USB,
then extract it to an IT-controlled local NTFS directory; the kit wrapper moves
the hash-sealed inputs through an administrator-only local staging flow. Keep
the exact directory layout. Do **not** run it from Downloads,
Desktop, another standard-user-writable folder/share, the writable NAS `tools`
tree, or a signed release root/ZIP. This kit is an online coordinator: the
target still needs access to the canonical signed
NAS channel, manifest, package, and release-owned dependencies.

On the target workstation, close Revit and any revAgent installer/updater,
then double-click `IT-Prestage-revAgent.cmd`. Accept the single administrator
elevation prompt. The wrapper selects the canonical 64-bit Windows PowerShell
5.1 host, rejects non-`FullLanguage` policy with exit 78, and runs the exact
bundled driver. The driver performs evidence production, signed-package
extraction, the legacy shared-`DPE` ACL migration when required, protected
ProgramData staging, trust-core/broker/task installation and immediate health
attestation, then local-bootstrap installation, state/task verification, and
shortcut verification without a repository checkout, pasted code, or
hand-copied hash literals. The outer kit remains exactly five files; the signed
release manifest/evidence supplies and binds `RevAgent.BootstrapTrust.psm1`,
`RevAgent.ReleaseSnapshot.psm1`, the release-independent broker, and the exact
embedded public trusted-key document. Its supervised operating budget is under
five minutes; record and investigate any target that exceeds it.

Trust replacement stages and retains its rollback candidate below the
SYSTEM/Administrators-only `bootstrap-broker\trust-transactions` root. An exact,
healthy fixed task is preserved; only a missing or broken task is registered or
repaired. The installer must pass trust health before it starts local-bootstrap
replacement, so a later bootstrap failure leaves a healthy retry authority. A
single fixed `%ProgramData%\DPE\revAgent\.bootstrap-install.lock` is held from
before trust installation through immediate trust health and local-bootstrap
commit. A concurrent installer fails closed as `bootstrap_install_busy`
without performing trust or bootstrap mutation; do not run supervised kit
installs in parallel.
The local candidate and prior root live together below the private
SYSTEM/Administrators-only `.bootstrap-transactions\<random>` child. Candidate
ACLs, hashes, state bindings, readability, and hardlink identity are fully
attested before the rename promotion that commits it. Before that boundary, a
failure restores the exact prior directory identity. After commit, inability to
delete the prior root is a warning/deferred-cleanup condition and never rolls
back the healthy new bootstrap.

After success, use only the protected local launcher:

```text
C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd
```

This E2-enabled kit is the one-time trust-establishment step. It does not
authorize pilot/stable NAS publication and it does not carry private signing
material. Existing fleet machines need one planned kit pass because E2 itself
changes manifest-bound bootstrap components; after that pass, later changes to
all eight bound files self-heal through the broker with no additional IT touch.

## Emergency fallback: manual high-assurance/recovery prestage

Use this two-shell procedure only when the primary kit cannot be used, with a
clean merged checkout and verifier/key
material obtained by the administrator or IT through a channel independent of
the standard user being bootstrapped. Signed-release verification and evidence
production happen before elevation. The elevated shell only stages the already
verified bytes and runs the canonical ProgramData consumer; it must not derive
replacement hashes.

The coordinator verifies detached channel/release signatures and the package
hash with the pinned verifier/key fingerprint, then derives every bootstrap
source hash from the signed package. The evidence producer opens that verifier
without write/delete sharing, hashes the acquired bytes, and executes only
those exact bytes as an in-memory module; it never imports the pathname after
hashing.

### 1. Trusted coordinator shell

Run from a clean merged checkout after the selected signed channel has passed
its release gates. Use `pilot` only for the exact signed developer/NET01 cohort;
use `stable` only in a separately approved fleet window:

```powershell
$RepoRoot = "C:\Users\BT\Projects\revAgent"
$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
$Channel = "pilot"
$TrustedKeys = Join-Path $ReleaseRoot "tools\config\release-trusted-keys.json"
$EvidenceSource = Join-Path $env:TEMP ("revagent-bootstrap-evidence-{0}.json" -f [guid]::NewGuid().ToString("N"))
$evidenceResult = & "$RepoRoot\scripts\New-RevAgentBootstrapPrestageEvidence.ps1" `
  -ReleaseRoot $ReleaseRoot -TrustedKeysPath $TrustedKeys `
  -OutputPath $EvidenceSource -RepoRoot $RepoRoot -Channel $Channel

$channel = Get-Content -Raw -LiteralPath (Join-Path $ReleaseRoot "channels\$Channel.json") | ConvertFrom-Json
$packagePath = [IO.Path]::GetFullPath((Join-Path (Join-Path $ReleaseRoot "channels") ([string]$channel.packagePath)))
$evidence = Get-Content -Raw -LiteralPath $EvidenceSource | ConvertFrom-Json
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash -ne [string]$evidence.release.packageSha256) { throw "Signed package changed after evidence production." }
$SourceRoot = Join-Path $env:TEMP ("revagent-prestage-source-{0}" -f [guid]::NewGuid().ToString("N"))
Expand-Archive -LiteralPath $packagePath -DestinationPath $SourceRoot
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash -ne [string]$evidence.release.packageSha256) { throw "Signed package changed during extraction." }

# Copy these four literal values into the fresh elevated shell. Do not
# recompute EvidenceSha256 there.
[pscustomobject]@{
  SourceRoot = $SourceRoot
  EvidenceSource = $EvidenceSource
  EvidenceSha256 = [string]$evidenceResult.outputSha256
  InstallerSha256 = [string]$evidence.localBootstrapInstallerScript
}
```

### 2. Fresh elevated Windows PowerShell shell

Open `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` with **Run as
administrator**. Paste the following built-in-only block directly into that
shell. Replace only the four marked literals with step 1 output. Do not invoke
a repo-side script with `-Verb RunAs`.

```powershell
$SourceRoot = '<SourceRoot from step 1>'
$EvidenceSource = '<EvidenceSource from step 1>'
$ExpectedEvidenceSha256 = '<EvidenceSha256 from step 1>'
$ExpectedInstallerSha256 = '<InstallerSha256 from step 1>'
$ReleaseRoot = '\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy'
$TrustedKeys = Join-Path $ReleaseRoot 'tools\config\release-trusted-keys.json'
$ErrorActionPreference = 'Stop'
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not [Security.Principal.WindowsPrincipal]::new($currentIdentity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'This prestage block requires a fresh elevated Windows PowerShell shell.' }
$ProgramDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$trustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$danger = [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership

# Compile the directory-lock helper only from this literal block, with compiler
# scratch isolated in an ACL-at-create administrator directory under Windows Temp.
$windowsTemp = Join-Path ([IO.Directory]::GetParent([Environment]::SystemDirectory).FullName) 'Temp'
$compilerAcl = [Security.AccessControl.DirectorySecurity]::new()
$compilerAcl.SetAccessRuleProtection($true, $false)
$compilerAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
  [void]$compilerAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
}
$compilerTemp = [IO.DirectoryInfo]::new($windowsTemp).CreateSubdirectory(('revagent-prestage-native-' + [Guid]::NewGuid().ToString('N')), $compilerAcl).FullName
$oldTemp = $env:TEMP; $oldTmp = $env:TMP
try {
  $env:TEMP = $compilerTemp; $env:TMP = $compilerTemp
  if (-not ('RevAgent.Prestage.DirectoryLockNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace RevAgent.Prestage {
  public static class DirectoryLockNative {
    [StructLayout(LayoutKind.Sequential)] private struct FILETIME { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential)] private struct INFO { public uint Attributes; public FILETIME Creation; public FILETIME Access; public FILETIME Write; public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow; }
    [StructLayout(LayoutKind.Sequential)] private struct SECURITY_ATTRIBUTES { public int Length; public IntPtr SecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CreateDirectoryW(string path, ref SECURITY_ATTRIBUTES security);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out INFO info);
    [DllImport("advapi32.dll")] private static extern uint SetSecurityInfo(SafeFileHandle handle, int objectType, uint securityInformation, byte[] owner, byte[] group, byte[] dacl, byte[] sacl);
    private static SafeFileHandle OpenCore(string path, uint access, uint share, string purpose) { var h=CreateFileW(path,access,share,IntPtr.Zero,3,0x02200000,IntPtr.Zero); if(h==null||h.IsInvalid){int e=Marshal.GetLastWin32Error();if(h!=null)h.Dispose();throw new Win32Exception(e,purpose+": "+path);} return h; }
    public static SafeFileHandle Open(string path) { return OpenCore(path,0x80000000,3,"No-delete-share directory open failed"); }
    // SetSecurityInfo suppresses child ACE propagation only when this exact
    // supplied handle was opened with MAXIMUM_ALLOWED (0x02000000).
    public static SafeFileHandle OpenSecurity(string path) { return OpenCore(path,0x02000000,3,"MAXIMUM_ALLOWED no-delete-share directory open failed"); }
    public static SafeFileHandle OpenVerifier(string path) { return OpenCore(path,0,7,"Share-all directory identity open failed"); }
    private static INFO Read(SafeFileHandle h) { INFO i; if(h==null||h.IsInvalid||!GetFileInformationByHandle(h,out i)) throw new Win32Exception(Marshal.GetLastWin32Error()); return i; }
    public static uint Attributes(SafeFileHandle h) { return Read(h).Attributes; }
    public static string Identity(SafeFileHandle h) { var i=Read(h); return String.Format("{0:X8}:{1:X8}{2:X8}",i.Volume,i.IndexHigh,i.IndexLow); }
    public static int SetOwner(SafeFileHandle handle, byte[] owner) { if(owner==null||owner.Length==0) throw new ArgumentException("An owner SID is required.","owner"); return unchecked((int)SetSecurityInfo(handle,1,0x00000001,owner,null,null,null)); }
    public static int SetDaclUnprotected(SafeFileHandle handle, byte[] dacl) { if(dacl==null||dacl.Length==0) throw new ArgumentException("A non-null DACL is required.","dacl"); return unchecked((int)SetSecurityInfo(handle,1,0x20000004,null,null,dacl,null)); }
    public static int CreateDirectoryWithSecurityDescriptor(string path, byte[] descriptor) {
      if(descriptor==null||descriptor.Length==0) throw new ArgumentException("A self-relative security descriptor is required.","descriptor");
      GCHandle pin=GCHandle.Alloc(descriptor,GCHandleType.Pinned);
      try { var sa=new SECURITY_ATTRIBUTES { Length=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), SecurityDescriptor=pin.AddrOfPinnedObject(), InheritHandle=false }; if(CreateDirectoryW(path,ref sa)) return 0; return Marshal.GetLastWin32Error(); }
      finally { pin.Free(); }
    }
  }
}
'@
  }
} finally {
  $env:TEMP = $oldTemp; $env:TMP = $oldTmp
  if ([IO.Directory]::Exists($compilerTemp)) { [IO.Directory]::Delete($compilerTemp, $true) }
}

function Open-DirectoryGuard([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\'); $handle = $null
  try {
    $handle = [RevAgent.Prestage.DirectoryLockNative]::Open($full)
    $attributes = [RevAgent.Prestage.DirectoryLockNative]::Attributes($handle)
    if (($attributes -band [uint32][IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Guarded prestage path is not an ordinary directory: $full" }
    return [pscustomobject]@{ Path=$full; Handle=$handle; Identity=[RevAgent.Prestage.DirectoryLockNative]::Identity($handle) }
  } catch { if ($null -ne $handle) { $handle.Dispose() }; throw }
}

function Open-DpeSecurityGuard([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\'); $handle = $null
  try {
    $handle = [RevAgent.Prestage.DirectoryLockNative]::OpenSecurity($full)
    $attributes = [RevAgent.Prestage.DirectoryLockNative]::Attributes($handle)
    if (($attributes -band [uint32][IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Guarded shared DPE path is not an ordinary directory: $full" }
    return [pscustomobject]@{ Path=$full; Handle=$handle; Identity=[RevAgent.Prestage.DirectoryLockNative]::Identity($handle); SecurityMutation=$true }
  } catch { if ($null -ne $handle) { $handle.Dispose() }; throw }
}

function Assert-DirectoryGuardPath($Guard, [string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\'); $pathHandle = $null
  try {
    $pathHandle = [RevAgent.Prestage.DirectoryLockNative]::OpenVerifier($full)
    $attributes = [RevAgent.Prestage.DirectoryLockNative]::Attributes($pathHandle)
    $identity = [RevAgent.Prestage.DirectoryLockNative]::Identity($pathHandle)
    if (($attributes -band [uint32][IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::Equals($identity, [string]$Guard.Identity, [StringComparison]::Ordinal)) { throw "Prestage directory path/handle identity changed: $full" }
  } finally { if ($null -ne $pathHandle) { $pathHandle.Dispose() } }
}

function Assert-SafeExistingDirectory([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) { throw "Unsafe prestage ancestor: $Path" }
  $acl = Get-Acl -LiteralPath $Path
  $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($trustedOwners -notcontains $owner) { throw "Untrusted prestage ancestor owner: $Path owner=$owner" }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $trustedOwners -notcontains [string]$rule.IdentityReference.Value -and (($rule.FileSystemRights -band $danger) -ne 0)) { throw "Untrusted delete/ACL-capable ancestor rule: $Path principal=$($rule.IdentityReference.Value)" }
  }
}

function Get-AclRuleShape([string]$Sid, [Int64]$Rights, [int]$Type, [bool]$Inherited, [int]$Inheritance, [int]$Propagation) {
  return '{0}|{1}|{2}|{3}|{4}|{5}' -f $Sid, $Rights, $Type, $Inherited, $Inheritance, $Propagation
}

function Get-AclRuleShapeFromRule($Rule) {
  return Get-AclRuleShape ([string]$Rule.IdentityReference.Value) ([Int64]$Rule.FileSystemRights) ([int]$Rule.AccessControlType) ([bool]$Rule.IsInherited) ([int]$Rule.InheritanceFlags) ([int]$Rule.PropagationFlags)
}

function Get-RawAclAceShape($Ace) {
  if ($Ace -isnot [Security.AccessControl.CommonAce]) {
    return 'unsupported|{0}|{1}|{2}' -f ([int]$Ace.AceType), ([int]$Ace.AceFlags), ([int]$Ace.BinaryLength)
  }
  return '{0}|{1}|{2}|{3}|{4}|{5}' -f ([int]$Ace.AceType), ([int]$Ace.AceFlags), ([Int64]$Ace.AccessMask), ([string]$Ace.SecurityIdentifier.Value), ([bool]$Ace.IsCallback), ([int]$Ace.AceQualifier)
}

function Get-CanonicalSharedDpeRawShapes([string]$LegacyCreatorSid = '') {
  $legacy = if ([string]::IsNullOrWhiteSpace($LegacyCreatorSid)) { '' } else { '(A;ID;FA;;;{0})' -f $LegacyCreatorSid }
  $sddl = 'D:AI{0}(A;OICIIOID;GA;;;CO)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)(A;CIID;0x116;;;BU)' -f $legacy
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
  return @($raw.DiscretionaryAcl | ForEach-Object { Get-RawAclAceShape $_ } | Sort-Object)
}

function Get-CanonicalSharedDpeShapes([string]$LegacyCreatorSid = '') {
  $allow = [int][Security.AccessControl.AccessControlType]::Allow; $full = [Int64][Security.AccessControl.FileSystemRights]::FullControl
  $readExecute = [Int64]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
  $ciOi = [int]([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit)
  $noneI = [int][Security.AccessControl.InheritanceFlags]::None; $noneP = [int][Security.AccessControl.PropagationFlags]::None
  $shapes = @(
    (Get-AclRuleShape 'S-1-5-18' $full $allow $true $ciOi $noneP),
    (Get-AclRuleShape 'S-1-5-32-544' $full $allow $true $ciOi $noneP),
    (Get-AclRuleShape 'S-1-3-0' 268435456 $allow $true $ciOi ([int][Security.AccessControl.PropagationFlags]::InheritOnly)),
    (Get-AclRuleShape 'S-1-5-32-545' $readExecute $allow $true $ciOi $noneP),
    (Get-AclRuleShape 'S-1-5-32-545' ([Int64][Security.AccessControl.FileSystemRights]::Write) $allow $true ([int][Security.AccessControl.InheritanceFlags]::ContainerInherit) $noneP)
  )
  if (-not [string]::IsNullOrWhiteSpace($LegacyCreatorSid)) { $shapes += Get-AclRuleShape $LegacyCreatorSid $full $allow $true $noneI $noneP }
  return @($shapes | Sort-Object)
}

function Assert-CanonicalProgramDataCreatorOwner([string]$Path) {
  Assert-SafeExistingDirectory $Path
  $acl = Get-Acl -LiteralPath $Path
  $matches = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
    [string]$_.IdentityReference.Value -eq 'S-1-3-0' -and [Int64]$_.FileSystemRights -eq 268435456 -and
    $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    [int]$_.InheritanceFlags -eq [int]([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -and
    $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::InheritOnly
  })
  if ($matches.Count -ne 1) { throw "ProgramData lacks the exact canonical CREATOR OWNER inheritance template: $Path" }
}

function Get-SharedDpeAclState([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) { throw "Unsafe shared DPE ancestor: $Path" }
  $acl = Get-Acl -LiteralPath $Path
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  $control = $raw.ControlFlags
  return [pscustomobject]@{
    Item = $item; Acl = $acl; Owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    Shapes = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { Get-AclRuleShapeFromRule $_ } | Sort-Object)
    ExplicitCount = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])).Count
    Raw = $raw
    RawShapes = @($raw.DiscretionaryAcl | ForEach-Object { Get-RawAclAceShape $_ } | Sort-Object)
    DaclPresent = (($control -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0)
    DaclAutoInherited = (($control -band [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited) -ne 0)
  }
}

function Test-ExactAclShapes($Actual, $Expected) {
  return $Actual.Count -eq $Expected.Count -and @((Compare-Object $Expected $Actual -SyncWindow 0)).Count -eq 0
}

function Assert-FinalSharedDpe([string]$Path) {
  $state = Get-SharedDpeAclState $Path
  if ($state.Owner -notin @('S-1-5-18', 'S-1-5-32-544') -or $state.Acl.AreAccessRulesProtected -or -not $state.DaclPresent -or -not $state.DaclAutoInherited -or $state.ExplicitCount -ne 0 -or
      -not (Test-ExactAclShapes $state.Shapes @(Get-CanonicalSharedDpeShapes)) -or
      -not (Test-ExactAclShapes $state.RawShapes @(Get-CanonicalSharedDpeRawShapes))) { throw "Shared DPE is not canonical D:AI, inheritance-enabled, and trusted-owner safe: $Path" }
  return $state.Item.FullName
}

function Get-CanonicalSharedDpeDaclBytes($State, [string]$LegacyCreatorSid) {
  if (-not $State.DaclPresent -or -not $State.DaclAutoInherited -or $State.Acl.AreAccessRulesProtected -or
      -not (Test-ExactAclShapes $State.RawShapes @(Get-CanonicalSharedDpeRawShapes $LegacyCreatorSid))) { throw 'Cannot reconstruct a canonical shared DPE DACL from a non-exact legacy descriptor.' }
  $legacyDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new(('D:AI(A;ID;FA;;;{0})' -f $LegacyCreatorSid))
  $legacyShape = Get-RawAclAceShape $legacyDescriptor.DiscretionaryAcl[0]
  $replacement = [Security.AccessControl.RawAcl]::new($State.Raw.DiscretionaryAcl.Revision, $State.Raw.DiscretionaryAcl.Count - 1)
  $removed = 0
  foreach ($ace in $State.Raw.DiscretionaryAcl) {
    if ([string]::Equals((Get-RawAclAceShape $ace), $legacyShape, [StringComparison]::Ordinal)) { $removed++; continue }
    $aceBytes = New-Object byte[] $ace.BinaryLength; $ace.GetBinaryForm($aceBytes, 0)
    $replacement.InsertAce($replacement.Count, [Security.AccessControl.GenericAce]::CreateFromBinaryForm($aceBytes, 0))
  }
  $replacementShapes = @($replacement | ForEach-Object { Get-RawAclAceShape $_ } | Sort-Object)
  if ($removed -ne 1 -or -not (Test-ExactAclShapes $replacementShapes @(Get-CanonicalSharedDpeRawShapes))) { throw 'Canonical shared DPE DACL reconstruction did not remove exactly one legacy CREATOR OWNER materialization.' }
  $bytes = New-Object byte[] $replacement.BinaryLength; $replacement.GetBinaryForm($bytes, 0)
  return ,$bytes
}

function Set-SharedDpeOwnerAdministrators($Guard) {
  if ($null -eq $Guard -or -not $Guard.SecurityMutation) { throw 'Shared DPE owner migration requires the MAXIMUM_ALLOWED security guard.' }
  $sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $bytes = New-Object byte[] $sid.BinaryLength; $sid.GetBinaryForm($bytes, 0)
  $errorCode = [RevAgent.Prestage.DirectoryLockNative]::SetOwner($Guard.Handle, $bytes)
  if ($errorCode -ne 0) { throw [ComponentModel.Win32Exception]::new($errorCode, 'SetSecurityInfo owner migration failed for shared DPE.') }
}

function Refresh-SharedDpeInheritance($Guard, $State, [string]$LegacyCreatorSid) {
  if ($null -eq $Guard -or -not $Guard.SecurityMutation) { throw 'Shared DPE DACL migration requires the MAXIMUM_ALLOWED security guard.' }
  $daclBytes = Get-CanonicalSharedDpeDaclBytes $State $LegacyCreatorSid
  $errorCode = [RevAgent.Prestage.DirectoryLockNative]::SetDaclUnprotected($Guard.Handle, $daclBytes)
  if ($errorCode -ne 0) { throw [ComponentModel.Win32Exception]::new($errorCode, 'SetSecurityInfo DACL migration failed for shared DPE.') }
}

function Initialize-SafeSharedDpe([string]$Path, $ExistingGuard = $null) {
  Assert-CanonicalProgramDataCreatorOwner $ProgramDataRoot
  if ($null -ne $ExistingGuard) { Assert-DirectoryGuardPath $ExistingGuard $Path }
  $currentSid = [string]$currentIdentity.User.Value; $state = Get-SharedDpeAclState $Path
  if ($state.Owner -in @('S-1-5-18', 'S-1-5-32-544') -and -not $state.Acl.AreAccessRulesProtected -and $state.DaclPresent -and $state.DaclAutoInherited -and $state.ExplicitCount -eq 0 -and
      (Test-ExactAclShapes $state.Shapes @(Get-CanonicalSharedDpeShapes)) -and (Test-ExactAclShapes $state.RawShapes @(Get-CanonicalSharedDpeRawShapes))) {
    if ($null -ne $ExistingGuard) { Assert-DirectoryGuardPath $ExistingGuard $Path }
    return $state.Item.FullName
  }
  $initialOwnerAccepted = [string]::Equals($state.Owner, $currentSid, [StringComparison]::OrdinalIgnoreCase)
  $recoveryOwnerAccepted = [string]::Equals($state.Owner, 'S-1-5-32-544', [StringComparison]::OrdinalIgnoreCase)
  if ((-not $initialOwnerAccepted -and -not $recoveryOwnerAccepted) -or $state.Acl.AreAccessRulesProtected -or -not $state.DaclPresent -or -not $state.DaclAutoInherited -or $state.ExplicitCount -ne 0 -or
      -not (Test-ExactAclShapes $state.Shapes @(Get-CanonicalSharedDpeShapes $currentSid)) -or
      -not (Test-ExactAclShapes $state.RawShapes @(Get-CanonicalSharedDpeRawShapes $currentSid))) { throw "Legacy shared DPE does not match the exact current-caller CREATOR OWNER pattern: $Path owner=$($state.Owner) current=$currentSid" }

  $guard = $ExistingGuard; $ownsGuard = $false
  if ($null -eq $guard) { $guard = Open-DpeSecurityGuard $Path; $ownsGuard = $true }
  try {
    if (-not $guard.SecurityMutation) { throw 'Shared DPE migration was not given the MAXIMUM_ALLOWED security guard.' }
    Assert-DirectoryGuardPath $guard $Path
    $guarded = Get-SharedDpeAclState $Path
    if (($guarded.Owner -notin @($currentSid, 'S-1-5-32-544')) -or $guarded.Acl.AreAccessRulesProtected -or -not $guarded.DaclPresent -or -not $guarded.DaclAutoInherited -or $guarded.ExplicitCount -ne 0 -or
        -not (Test-ExactAclShapes $guarded.Shapes @(Get-CanonicalSharedDpeShapes $currentSid)) -or
        -not (Test-ExactAclShapes $guarded.RawShapes @(Get-CanonicalSharedDpeRawShapes $currentSid))) { throw "Guarded legacy shared DPE ACL changed before migration: $Path" }
    if ([string]::Equals($guarded.Owner, $currentSid, [StringComparison]::OrdinalIgnoreCase)) {
      Set-SharedDpeOwnerAdministrators $guard; Assert-DirectoryGuardPath $guard $Path
    }
    $afterOwner = Get-SharedDpeAclState $Path
    if (-not [string]::Equals($afterOwner.Owner, 'S-1-5-32-544', [StringComparison]::OrdinalIgnoreCase)) { throw "Legacy shared DPE owner migration failed: $Path" }
    if (-not $afterOwner.Acl.AreAccessRulesProtected -and $afterOwner.DaclPresent -and $afterOwner.DaclAutoInherited -and $afterOwner.ExplicitCount -eq 0 -and
        (Test-ExactAclShapes $afterOwner.Shapes @(Get-CanonicalSharedDpeShapes)) -and (Test-ExactAclShapes $afterOwner.RawShapes @(Get-CanonicalSharedDpeRawShapes))) { Assert-DirectoryGuardPath $guard $Path; return $afterOwner.Item.FullName }
    if ($afterOwner.Acl.AreAccessRulesProtected -or -not $afterOwner.DaclPresent -or -not $afterOwner.DaclAutoInherited -or $afterOwner.ExplicitCount -ne 0 -or
        -not (Test-ExactAclShapes $afterOwner.Shapes @(Get-CanonicalSharedDpeShapes $currentSid)) -or
        -not (Test-ExactAclShapes $afterOwner.RawShapes @(Get-CanonicalSharedDpeRawShapes $currentSid))) { throw "Legacy shared DPE partial migration state is not recoverable: $Path" }
    Refresh-SharedDpeInheritance $guard $afterOwner $currentSid; Assert-DirectoryGuardPath $guard $Path
    return Assert-FinalSharedDpe $Path
  } finally { if ($ownsGuard) { $guard.Handle.Dispose() } }
}

function New-InheritanceEnabledSharedDpe([string]$Parent) {
  Assert-CanonicalProgramDataCreatorOwner $Parent
  $ba = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  # Owner/group BA with no supplied DACL lets ProgramData inheritance construct
  # the DACL. This is not a NULL DACL: DiscretionaryAclPresent is deliberately
  # absent from the self-relative descriptor passed at CreateDirectoryW time.
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new([Security.AccessControl.ControlFlags]::SelfRelative, $ba, $ba, $null, $null)
  $descriptorBytes = New-Object byte[] $descriptor.BinaryLength; $descriptor.GetBinaryForm($descriptorBytes, 0)
  $path = Join-Path $Parent 'DPE'
  $createError = [RevAgent.Prestage.DirectoryLockNative]::CreateDirectoryWithSecurityDescriptor($path, $descriptorBytes)
  if ($createError -notin @(0, 183)) { throw [ComponentModel.Win32Exception]::new($createError, "CreateDirectoryW failed for shared DPE ancestor: $path") }
  $resolved = Initialize-SafeSharedDpe $path
  $guard = Open-DpeSecurityGuard $resolved
  try { Assert-DirectoryGuardPath $guard $resolved; return Assert-FinalSharedDpe $resolved }
  finally { $guard.Handle.Dispose() }
}

function Set-ProtectedProductRootAcl([string]$Path) {
  $guard = Open-DirectoryGuard $Path
  try {
    Assert-DirectoryGuardPath $guard $Path
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $currentAcl = Get-Acl -LiteralPath $Path
    $owner = [string]$currentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($trustedOwners -notcontains $owner) { throw "Refusing legacy product root with untrusted owner: $Path owner=$owner" }

    # This exact existing product root (or prestage child) may carry the
    # developer's legacy Modify/Delete ACE. The no-FILE_SHARE_DELETE handle
    # prevents rename/swap until the new DACL and identity are reverified.
    # Never apply this migration to the shared DPE ancestor.
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($entry in @(@('S-1-5-18', [Security.AccessControl.FileSystemRights]::FullControl), @('S-1-5-32-544', [Security.AccessControl.FileSystemRights]::FullControl), @('S-1-5-32-545', [Security.AccessControl.FileSystemRights]::ReadAndExecute))) {
      [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new([string]$entry[0]), [Security.AccessControl.FileSystemRights]$entry[1], ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    }
    if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item, $acl) } else { ([IO.DirectoryInfo]$item).SetAccessControl($acl) }

    Assert-DirectoryGuardPath $guard $Path
    $verified = Get-Acl -LiteralPath $Path
    if (-not $verified.AreAccessRulesProtected -or [string]$verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') { throw "Legacy product root ACL hardening failed: $Path" }
    $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $trustedOwners -notcontains [string]$rule.IdentityReference.Value -and (($rule.FileSystemRights -band $writeMask) -ne 0)) { throw "Legacy product root remains writable by an untrusted principal: $Path principal=$($rule.IdentityReference.Value)" }
    }
  } finally { $guard.Handle.Dispose() }
}

function New-ProtectedChild([string]$Parent, [string]$Name) {
  Assert-SafeExistingDirectory $Parent
  $path = Join-Path $Parent $Name
  if (Test-Path -LiteralPath $path) { Set-ProtectedProductRootAcl $path; return $path }
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach ($entry in @(@('S-1-5-18', [Security.AccessControl.FileSystemRights]::FullControl), @('S-1-5-32-544', [Security.AccessControl.FileSystemRights]::FullControl), @('S-1-5-32-545', [Security.AccessControl.FileSystemRights]::ReadAndExecute))) {
    [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new([string]$entry[0]), [Security.AccessControl.FileSystemRights]$entry[1], ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
  [void]([IO.DirectoryInfo]::new($Parent).CreateSubdirectory($Name, $acl))
  # Reattest through the same handle-bound hardening path so an exact-name
  # create race cannot turn an existing user-owned directory into a trust root.
  Set-ProtectedProductRootAcl $path
  return $path
}

function Read-VerifiedBytes([string]$Path, [string]$ExpectedHash, [int]$MaxBytes) {
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -lt 1 -or $stream.Length -gt $MaxBytes) { throw "Staging source size is outside policy: $Path" }
    $bytes = New-Object byte[] ([int]$stream.Length); $offset = 0
    while ($offset -lt $bytes.Length) { $offset += $stream.Read($bytes, $offset, $bytes.Length - $offset) }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '') } finally { $sha.Dispose() }
    if (-not [string]::Equals($actual, $ExpectedHash, [StringComparison]::OrdinalIgnoreCase)) { throw "Staging source hash mismatch: $Path" }
    return $bytes
  } finally { $stream.Dispose() }
}

$evidenceBytes = Read-VerifiedBytes $EvidenceSource $ExpectedEvidenceSha256 65536
$evidence = ([Text.UTF8Encoding]::new($false, $true)).GetString($evidenceBytes) | ConvertFrom-Json
if (-not [string]::Equals([string]$evidence.localBootstrapInstallerScript, $ExpectedInstallerSha256, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer hash does not match the independently verified evidence.' }
$installerBytes = Read-VerifiedBytes (Join-Path $SourceRoot 'installer\nas\install-revagent-local-bootstrap.ps1') $ExpectedInstallerSha256 1048576
$trustedKeysBytes = Read-VerifiedBytes $TrustedKeys ([string]$evidence.sources.trustedKeys) 65536
$dpePath = Join-Path $ProgramDataRoot 'DPE'
$dpeGuard = $null
try {
  if (Test-Path -LiteralPath $dpePath) {
    $dpeGuard = Open-DpeSecurityGuard $dpePath
    $dpe = Initialize-SafeSharedDpe $dpePath $dpeGuard
  } else {
    $dpe = New-InheritanceEnabledSharedDpe $ProgramDataRoot
    $dpeGuard = Open-DpeSecurityGuard $dpe
    $dpe = Initialize-SafeSharedDpe $dpe $dpeGuard
  }
} catch { if ($null -ne $dpeGuard) { $dpeGuard.Handle.Dispose() }; throw }
try {
  Assert-DirectoryGuardPath $dpeGuard $dpe
  $productPath = Join-Path $dpe 'revAgent'
  if (Test-Path -LiteralPath $productPath) { Set-ProtectedProductRootAcl $productPath; $product = $productPath } else { $product = New-ProtectedChild $dpe 'revAgent' }
  Assert-DirectoryGuardPath $dpeGuard $dpe
} finally { $dpeGuard.Handle.Dispose() }
$prestage = New-ProtectedChild $product 'prestage'
$stagedEvidence = Join-Path $prestage 'bootstrap-prestage-evidence.json'; $stagedInstaller = Join-Path $prestage 'install-revagent-local-bootstrap.ps1'; $stagedTrustedKeys = Join-Path $prestage 'release-trusted-keys.json'
function Set-AdminOnlyAcl([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false); $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $inheritance = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }
    [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
  if ($item.PSIsContainer) { ([IO.DirectoryInfo]$item).SetAccessControl($acl) } else { ([IO.FileInfo]$item).SetAccessControl($acl) }
}
Set-AdminOnlyAcl $prestage
foreach ($path in @($stagedEvidence, $stagedInstaller, $stagedTrustedKeys)) {
  if (Test-Path -LiteralPath $path) { if (((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing linked prestage leaf: $path" }; Remove-Item -LiteralPath $path -Force }
}
[IO.File]::WriteAllBytes($stagedEvidence, $evidenceBytes); [IO.File]::WriteAllBytes($stagedInstaller, $installerBytes); [IO.File]::WriteAllBytes($stagedTrustedKeys, $trustedKeysBytes)
foreach ($path in @($stagedEvidence, $stagedInstaller, $stagedTrustedKeys)) { Set-AdminOnlyAcl $path }

& $stagedInstaller -RepoRoot $SourceRoot -ReleaseRoot $ReleaseRoot `
  -TrustedKeysPath $stagedTrustedKeys -ExpectedHashesPath $stagedEvidence `
  -ConfirmIndependentlyAuthenticatedSource
```

The legacy shared-`DPE` migration is a supervised, quiescent one-time boundary.
The trusted-key bytes are hash-bound to the authenticated evidence before they
are written under the protected local prestage root. The installer receives
that single-link NTFS leaf instead of the UNC source because the local bootstrap
hardlink guard intentionally fails closed when a filesystem cannot enumerate
hardlinks.

The primary handle is opened with `MAXIMUM_ALLOWED` and without
`FILE_SHARE_DELETE`; a separate share-all handle verifies the path/object
identity. The owner is changed first and the exact raw canonical DACL is then
applied to that same primary handle as unprotected/auto-inherited. Microsoft
documents that `SetSecurityInfo` does not propagate ACEs to children when its
supplied handle was opened with `MAXIMUM_ALLOWED`; the block also verifies the
final `D:AI` state. It never recurses into or resets child ACLs. See
[SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo).

The no-delete-share guard prevents pathname replacement during the migration,
but it cannot revoke a hostile handle that the same legacy owner process opened
before the elevated block began. Run this block only after confirming that no
other same-user installer/updater process is active.

After success, close Revit and run only:

```text
C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd
```

Production NAS `tools` contains only the exact managed CMD allowlist documented
in `installer\nas\README.md`. A current, verified protected bootstrap stays on
the normal local GUI path. A missing bootstrap or a local launcher that is stale
against its signed manifest component enters Refresh; when the fixed machine
trust core and SYSTEM broker task are healthy, Refresh stages an authenticated
local inbox, submits a nonce-bound request, waits for the protected result, and
self-heals through the local `--post-refresh` launcher without UAC. Exit 84 is
reserved for a missing or unhealthy trust core/task. In that case, complete the
supervised E1 kit path (or this emergency two-shell procedure), then rerun the
protected local launcher.

The prestage evidence and protected bootstrap include the complete signed
module closure needed before the GUI can start:

- `lib\RevAgent.Permissions.psm1`, the authenticated sibling required by
  `RevAgent.SourceFreeMigration.psm1`. Its path and SHA-256 are recorded as the
  `permissions` role in `bootstrap-state.json`, verified against
  `installerLibPermissions` on every launch, and checked by the GUI before the
  migration module is imported;
- `lib\RevAgent.ReleaseSnapshot.psm1`, which copies and re-verifies the signed
  transport set into a user-local authenticated inbox before UAC, then creates
  the administrator-owned execution snapshot. For current releases this set
  includes the manifest-bound
  `releases\<version>\external\node-v24.14.1-x64.msi` sidecar; it never falls
  back to ambient shared `tools\dependencies`;
- `Invoke-revAgent-PrivilegedSnapshotUpdate.ps1`, the only file the GUI may
  elevate. It creates the protected snapshot and invokes the exact snapshot
  machine entrypoint.

The broker writes the immutable snapshot identity/path/hash binding into the
machine phase result. The unelevated GUI reads that binding, verifies
`snapshot-state.json`, and runs the exact local snapshot user entrypoint with
the snapshot-local `channels\stable.json`. It never falls back to a loose NAS
tool or a user-writable installed updater. This post-bootstrap snapshot broker
does not supply the missing clean-machine Authenticode trust anchor described
above.
