import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

export const PRODUCTION_LAUNCH_BOOTSTRAP_SCHEMA =
  "rbp-production-encoded-bootstrap/v2";
export const PRODUCTION_LAUNCH_REVIEW_CANDIDATE_SCHEMA =
  "rbp-production-launch-review-candidate/v1";
export const PRODUCTION_LAUNCH_AUTHORITY_VECTOR_SCHEMA =
  "rbp-production-launch-authority-vector/v2";
export const PRODUCTION_LAUNCH_COMMAND_LINE_LIMIT = 32_766;

const LAUNCHER_RELATIVE_PATH =
  "packages/rbp-conformance/scripts/invoke-production.ps1";
const ROLE_ENTRYPOINTS = Object.freeze({
  "cli-bootstrap":
    "packages/rbp-conformance/scripts/production-cli-bootstrap.mjs",
  "prepare-wrapper":
    "packages/rbp-conformance/scripts/prepare-production.mjs",
});

// This value is deliberately fixed: launch-specific data is carried only as one
// canonical -EncodedArguments value. This worktree module may produce a
// review-only vector, but canonical execution must receive the exact approved
// vector from an independently protected authority and must not execute this
// module before the fixed bootstrap starts.
const BOOTSTRAP_TEMPLATE = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:PSModulePath=''
$u8=[Text.UTF8Encoding]::new($false,$true)
$u16=[Text.UnicodeEncoding]::new($false,$false,$true)
function D([string]$v){
 $b=[Convert]::FromBase64String($v)
 if(-not [StringComparer]::Ordinal.Equals([Convert]::ToBase64String($b),$v)){throw 'B02'}
 $s=$u8.GetString($b)
 if([Convert]::ToBase64String($u8.GetBytes($s))-ne[Convert]::ToBase64String($b)){throw 'B03'}
 return $s
}
function HashBytes([byte[]]$b){
 $a=[Security.Cryptography.SHA256]::Create()
 try{return ([BitConverter]::ToString($a.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$a.Dispose()}
}
function P([string]$p,[string]$l){
 $f=[IO.Path]::GetFullPath($p);$r=[IO.Path]::GetPathRoot($f)
 if([string]::IsNullOrWhiteSpace($r)){throw ($l+' has no root')}
 $c=$r
 foreach($s in $f.Substring($r.Length).Split([char]92,[StringSplitOptions]::RemoveEmptyEntries)){
  $c=[IO.Path]::Combine($c,$s)
  if(-not [IO.File]::Exists($c)-and -not [IO.Directory]::Exists($c)){throw ($l+' is missing: '+$c)}
  if(([IO.File]::GetAttributes($c)-band [IO.FileAttributes]::ReparsePoint)-ne 0){throw ($l+' contains reparse point: '+$c)}
 }
 return $f
}
function Q([string]$v){
 if($v.Length-gt 0-and $v-notmatch '[\s"]'){return $v}
 $z=[Text.StringBuilder]::new();[void]$z.Append('"');$n=0
 foreach($x in $v.ToCharArray()){
  if($x-eq '\'){$n++;continue}
  if($x-eq '"'){[void]$z.Append(('\'*(2*$n+1)));[void]$z.Append('"');$n=0;continue}
  if($n-gt 0){[void]$z.Append(('\'*$n));$n=0};[void]$z.Append($x)
 }
 if($n-gt 0){[void]$z.Append(('\'*(2*$n)))};[void]$z.Append('"');return $z.ToString()
}
function G([string[]]$a){
 $all=[Collections.Generic.List[string]]::new()
 foreach($x in @('--no-pager','--no-replace-objects','-c','core.attributesfile=','-c','core.autocrlf=input','-c','core.excludesfile=','-c','core.fsmonitor=false','-c','core.ignorestat=false','-c','core.preloadindex=false','-c','core.useReplaceRefs=false','-c','core.safecrlf=false','-c','core.trustctime=true','-c','core.untrackedCache=false','-C',$repo)){[void]$all.Add($x)}
 foreach($x in $a){[void]$all.Add($x)}
 $e=[Collections.Generic.List[string]]::new();foreach($x in $all){[void]$e.Add((Q $x))}
 $i=[Diagnostics.ProcessStartInfo]::new();$i.FileName=$git;$i.Arguments=[string]::Join(' ',$e);$i.WorkingDirectory=$repo;$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;$i.EnvironmentVariables.Clear()
 foreach($x in @('SystemRoot','WINDIR')){$i.EnvironmentVariables[$x]=$win}
 foreach($x in @('GIT_ATTR_NOSYSTEM','GIT_CONFIG_NOSYSTEM','GIT_NO_REPLACE_OBJECTS','GIT_OPTIONAL_LOCKS')){$i.EnvironmentVariables[$x]='1'}
 $i.EnvironmentVariables['GIT_CONFIG_GLOBAL']='NUL';$i.EnvironmentVariables['GIT_CONFIG_SYSTEM']='NUL';$i.EnvironmentVariables['GIT_TERMINAL_PROMPT']='0';$i.EnvironmentVariables['PATH']=''
 $p=[Diagnostics.Process]::new();$p.StartInfo=$i;$m=[IO.MemoryStream]::new()
 try{
  if(-not $p.Start()){throw 'B04'}
  $ot=$p.StandardOutput.BaseStream.CopyToAsync($m);$et=$p.StandardError.ReadToEndAsync();$p.WaitForExit();[void]$ot.GetAwaiter().GetResult();$er=$et.GetAwaiter().GetResult()
  if($p.ExitCode-ne 0){throw ('B05 '+$er.Trim())}
  return ,$m.ToArray()
 }finally{$m.Dispose();$p.Dispose()}
}
function T([byte[]]$b){
 if($b-contains 0){throw 'B06'}
 $s=$u8.GetString($b)
 if([Convert]::ToBase64String($u8.GetBytes($s))-ne[Convert]::ToBase64String($b)){throw 'B07'}
 return $s.TrimEnd([char[]]@(13,10))
}
if($args.Count-ne 1){throw 'B08'}
$pb=[string]$args[0]
$pbx=[Convert]::FromBase64String($pb)
if(-not [StringComparer]::Ordinal.Equals([Convert]::ToBase64String($pbx),$pb)){throw 'B12'}
$pt=$u8.GetString($pbx)
if([Convert]::ToBase64String($u8.GetBytes($pt))-ne[Convert]::ToBase64String($pbx)){throw 'B13'}
$ef=$pt.Split([char]9,[StringSplitOptions]::None);$v=[Collections.Generic.List[string]]::new()
foreach($x in $ef){[void]$v.Add((D $x))}
$ac=0
if($v.Count-lt 7-or $v[0]-ne 'rbp-production-encoded-bootstrap/v2'-or -not [int]::TryParse($v[6],[Globalization.NumberStyles]::None,[Globalization.CultureInfo]::InvariantCulture,[ref]$ac)-or $ac-lt 0-or $ac.ToString([Globalization.CultureInfo]::InvariantCulture)-ne$v[6]-or $v.Count-ne 7+$ac-or $v[4]-notmatch '^[0-9a-f]{40,64}$'-or $v[5]-notmatch '^[0-9a-f]{40,64}$'){throw 'B14'}
$win=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$ps=P ([IO.Path]::Combine($win,'System32','WindowsPowerShell','v1.0','powershell.exe')) 'PowerShell'
if(-not [StringComparer]::OrdinalIgnoreCase.Equals([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,$ps)){throw 'B15'}
$id=[Security.Principal.WindowsIdentity]::GetCurrent();$pr=[Security.Principal.WindowsPrincipal]::new($id)
if($pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'B16'}
$repo=P $v[1] 'repo';if(-not [IO.Directory]::Exists($repo)){throw 'B17'}
$role=$v[2]
if($role-eq 'cli-bootstrap'){$ep=[IO.Path]::Combine($repo,'packages','rbp-conformance','scripts','production-cli-bootstrap.mjs')}
elseif($role-eq 'prepare-wrapper'){$ep=[IO.Path]::Combine($repo,'packages','rbp-conformance','scripts','prepare-production.mjs')}
else{throw 'B18'}
$pf=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$node=P ([IO.Path]::Combine($pf,'nodejs','node.exe')) 'Node'
$git=P ([IO.Path]::Combine($pf,'Git','bin','git.exe')) 'Git'
$ct=[Management.Automation.CommandTypes]::Cmdlet
$im=$ExecutionContext.InvokeCommand.GetCommand('Microsoft.PowerShell.Core\Import-Module',$ct)
if($null-eq $im){throw 'B19'}
$sm=[IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')
& $im -Name $sm -Force -ErrorAction Stop
$gs=$ExecutionContext.InvokeCommand.GetCommand('Microsoft.PowerShell.Security\Get-AuthenticodeSignature',$ct)
$ga=$ExecutionContext.InvokeCommand.GetCommand('Microsoft.PowerShell.Security\Get-Acl',$ct)
if($null-eq $gs-or $null-eq $ga){throw 'B20'}
$sig=& $gs -LiteralPath $git -ErrorAction Stop
$subs=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
[void]$subs.Add('CN=Johannes Schindelin, O=Johannes Schindelin, S=Nordrhein-Westfalen, C=DE')
[void]$subs.Add('CN=Johannes Schindelin, O=Johannes Schindelin, L=Bruehl, C=DE')
if($sig.Status-ne [Management.Automation.SignatureStatus]::Valid-or $null-eq $sig.SignerCertificate-or -not $subs.Contains([string]$sig.SignerCertificate.Subject)){throw 'B21'}
$ti='';try{$ti=[string]([Security.Principal.NTAccount]'NT SERVICE\TrustedInstaller').Translate([Security.Principal.SecurityIdentifier]).Value}catch{}
$owners=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);[void]$owners.Add('S-1-5-18');[void]$owners.Add('S-1-5-32-544');if($ti){[void]$owners.Add($ti)}
$rights=[int64]([Security.AccessControl.FileSystemRights]::WriteData-bor[Security.AccessControl.FileSystemRights]::AppendData-bor[Security.AccessControl.FileSystemRights]::WriteAttributes-bor[Security.AccessControl.FileSystemRights]::WriteExtendedAttributes-bor[Security.AccessControl.FileSystemRights]::Delete-bor[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles-bor[Security.AccessControl.FileSystemRights]::ChangePermissions-bor[Security.AccessControl.FileSystemRights]::TakeOwnership)
$c=$pf
foreach($s in $git.Substring($pf.TrimEnd('\').Length).TrimStart('\').Split([char]92,[StringSplitOptions]::RemoveEmptyEntries)){
 $acl=& $ga -LiteralPath $c -ErrorAction Stop;$o=[string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;if(-not $owners.Contains($o)){throw 'B22'}
 foreach($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType-eq[Security.AccessControl.AccessControlType]::Allow-and(([int64]$r.FileSystemRights-band$rights)-ne 0)-and -not $owners.Contains([string]$r.IdentityReference.Value)){throw 'B23'}}
 $c=[IO.Path]::Combine($c,$s)
}
$acl=& $ga -LiteralPath $git -ErrorAction Stop;$o=[string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;if(-not $owners.Contains($o)){throw 'B24'}
foreach($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType-eq[Security.AccessControl.AccessControlType]::Allow-and(([int64]$r.FileSystemRights-band$rights)-ne 0)-and -not $owners.Contains([string]$r.IdentityReference.Value)){throw 'B25'}}
$gl=[IO.File]::Open($git,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try{
 $gsha=HashBytes ([IO.File]::ReadAllBytes($git))
 $head=T (G @('rev-parse','--verify','HEAD^{commit}'));$tree=T (G @('rev-parse','--verify','HEAD^{tree}'))
 $ec=T (G @('rev-parse','--verify',($v[4]+'^{commit}')));$et=T (G @('rev-parse','--verify',($v[4]+'^{tree}')))
 if(-not [StringComparer]::Ordinal.Equals($head,$v[4])-or -not [StringComparer]::Ordinal.Equals($tree,$v[5])-or -not [StringComparer]::Ordinal.Equals($ec,$v[4])-or -not [StringComparer]::Ordinal.Equals($et,$v[5])){throw 'B26'}
 $lp='packages/rbp-conformance/scripts/invoke-production.ps1'
 $lr=$u8.GetString((G @('ls-tree','-z',$v[4],'--',$lp)))
 $m=[regex]::Match($lr,'^([0-7]{6}) blob ([0-9a-f]{40,64})\t(.+)\x00$')
 if(-not $m.Success-or $m.Groups[1].Value-ne '100644'-or $m.Groups[3].Value-ne $lp){throw 'B27'}
 $oid=$m.Groups[2].Value;$lb=[byte[]](G @('cat-file','blob',$oid))
 $hb=[Text.Encoding]::ASCII.GetBytes('blob '+$lb.Length+[char]0)
 if($oid.Length-eq 40){$ha=[Security.Cryptography.SHA1]::Create()}else{$ha=[Security.Cryptography.SHA256]::Create()}
 try{[void]$ha.TransformBlock($hb,0,$hb.Length,$hb,0);[void]$ha.TransformFinalBlock($lb,0,$lb.Length);$co=([BitConverter]::ToString($ha.Hash)).Replace('-','').ToLowerInvariant()}finally{$ha.Dispose()}
 if(-not [StringComparer]::Ordinal.Equals($co,$oid)-or ($lb.Length-ge 3-and $lb[0]-eq 239-and $lb[1]-eq 187-and $lb[2]-eq 191)-or $lb-contains 0){throw 'B28'}
 $ls=$u8.GetString($lb);if([Convert]::ToBase64String($u8.GetBytes($ls))-ne[Convert]::ToBase64String($lb)){throw 'B29'}
 $la=[Collections.Generic.List[string]]::new();for($n=7;$n-lt$v.Count;$n++){[void]$la.Add($v[$n])}
 $ctx=@{NodeExecutable=$node;Entrypoint=$ep;CommandArguments=$la.ToArray();TrustedRepositoryRoot=$repo;TrustedExpectedCommit=$v[4];TrustedExpectedTree=$v[5];TrustedLauncherMode=$m.Groups[1].Value;TrustedLauncherObjectId=$oid;TrustedLauncherSha256=(HashBytes $lb);TrustedBootstrapPayloadSha256=(HashBytes $pbx);TrustedBootstrapSourceSha256=$trustedBootstrapSourceSha256;TrustedBootstrapTemplateSha256=$trustedBootstrapTemplateSha256;TrustedBootstrapGitSha256=$gsha}
 & ([ScriptBlock]::Create($ls)) @ctx
}finally{$gl.Dispose()}`;

const BOOTSTRAP_TEMPLATE_SHA256 = createHash("sha256")
  .update(Buffer.from(BOOTSTRAP_TEMPLATE, "utf8"))
  .digest("hex");
const COMPRESSED_BOOTSTRAP_TEMPLATE = deflateRawSync(
  Buffer.from(BOOTSTRAP_TEMPLATE, "utf8"),
  { level: 9 },
).toString("base64");
const BOOTSTRAP_SOURCE = String.raw`$ErrorActionPreference='Stop'
$u8=[Text.UTF8Encoding]::new($false,$true)
$u16=[Text.UnicodeEncoding]::new($false,$false,$true)
$av=[Environment]::GetCommandLineArgs()
if($av.Count-ne 9-or $av[1]-ne '-NoProfile'-or $av[2]-ne '-NonInteractive'-or $av[3]-ne '-ExecutionPolicy'-or $av[4]-ne 'Bypass'-or $av[5]-ne '-EncodedArguments'-or $av[7]-ne '-EncodedCommand'-or $args.Count-ne 1){throw 'O01'}
$cb=[Convert]::FromBase64String($av[8])
if(-not [StringComparer]::Ordinal.Equals([Convert]::ToBase64String($cb),$av[8])){throw 'O02'}
$cs=$u16.GetString($cb)
if([Convert]::ToBase64String($u16.GetBytes($cs))-ne[Convert]::ToBase64String($cb)-or -not [StringComparer]::Ordinal.Equals($cs,[string]$MyInvocation.MyCommand.Definition)){throw 'O03'}
$c='${COMPRESSED_BOOTSTRAP_TEMPLATE}'
$x=[Convert]::FromBase64String($c)
if(-not [StringComparer]::Ordinal.Equals([Convert]::ToBase64String($x),$c)){throw 'O04'}
$mi=[IO.MemoryStream]::new($x,$false);$mo=[IO.MemoryStream]::new()
try{$ds=[IO.Compression.DeflateStream]::new($mi,[IO.Compression.CompressionMode]::Decompress);try{$ds.CopyTo($mo)}finally{$ds.Dispose()};$b=$mo.ToArray()}finally{$mi.Dispose();$mo.Dispose()}
$s=$u8.GetString($b)
if([Convert]::ToBase64String($u8.GetBytes($s))-ne[Convert]::ToBase64String($b)){throw 'O05'}
$a=[Security.Cryptography.SHA256]::Create()
try{$h=([BitConverter]::ToString($a.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$a.Dispose()}
if($h-ne '${BOOTSTRAP_TEMPLATE_SHA256}'){throw 'O06'}
$trustedBootstrapSourceSha256=''
$a=[Security.Cryptography.SHA256]::Create()
try{$trustedBootstrapSourceSha256=([BitConverter]::ToString($a.ComputeHash($cb))).Replace('-','').ToLowerInvariant()}finally{$a.Dispose()}
$trustedBootstrapTemplateSha256=$h
& ([ScriptBlock]::Create($s)) ([string]$args[0])`;

function strictBase64Decode(value, label, encoding) {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new Error(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  const text = bytes.toString(encoding);
  if (!Buffer.from(text, encoding).equals(bytes)) {
    throw new Error(`${label} has invalid ${encoding}`);
  }
  return text;
}

function encodeField(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function normalizePayload(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.hasOwn(input, "nodeExecutable") ||
    Object.hasOwn(input, "entrypoint") ||
    typeof input.repoRoot !== "string" ||
    !path.win32.isAbsolute(input.repoRoot) ||
    !Object.hasOwn(ROLE_ENTRYPOINTS, input.role) ||
    !Array.isArray(input.commandArguments) ||
    input.commandArguments.some((value) => typeof value !== "string") ||
    typeof input.expectedCommit !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test(input.expectedCommit) ||
    typeof input.expectedTree !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test(input.expectedTree)
  ) {
    throw new Error("production encoded-bootstrap payload is invalid");
  }
  return {
    schemaVersion: PRODUCTION_LAUNCH_BOOTSTRAP_SCHEMA,
    repoRoot: path.win32.normalize(input.repoRoot),
    role: input.role,
    expectedCommit: input.expectedCommit,
    expectedTree: input.expectedTree,
    commandArguments: [...input.commandArguments],
  };
}

function payloadValues(input) {
  const payload = normalizePayload(input);
  return [
    payload.schemaVersion,
    payload.repoRoot,
    payload.role,
    LAUNCHER_RELATIVE_PATH,
    payload.expectedCommit,
    payload.expectedTree,
    String(payload.commandArguments.length),
    ...payload.commandArguments,
  ];
}

function encodedArgumentsXml(payloadBase64) {
  return [
    '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
    '  <Obj RefId="0">',
    '    <TN RefId="0">',
    '      <T>System.Object[]</T>',
    '      <T>System.Array</T>',
    '      <T>System.Object</T>',
    "    </TN>",
    "    <LST>",
    `      <S>${payloadBase64}</S>`,
    "    </LST>",
    "  </Obj>",
    "</Objs>",
  ].join("\r\n");
}

function windowsArgument(value) {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\*)$/u, "$1$1")}"`;
}

export function productionLaunchBootstrapSource() {
  return BOOTSTRAP_SOURCE;
}

export function productionLaunchBootstrapTemplateSha256() {
  return BOOTSTRAP_TEMPLATE_SHA256;
}

export function productionLaunchEncodedCommand() {
  return Buffer.from(BOOTSTRAP_SOURCE, "utf16le").toString("base64");
}

export function productionLaunchPayloadBase64(input) {
  const wire = payloadValues(input).map(encodeField).join("\t");
  return Buffer.from(wire, "utf8").toString("base64");
}

export function productionLaunchEncodedArguments(input) {
  return Buffer.from(
    encodedArgumentsXml(productionLaunchPayloadBase64(input)),
    "utf16le",
  ).toString("base64");
}

export function productionLaunchEntrypoint(input) {
  const payload = normalizePayload(input);
  return path.win32.join(
    payload.repoRoot,
    ...ROLE_ENTRYPOINTS[payload.role].split("/"),
  );
}

export function productionLaunchPowerShellArguments(input) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedArguments",
    productionLaunchEncodedArguments(input),
    "-EncodedCommand",
    productionLaunchEncodedCommand(),
  ];
  const powershellExecutable = input.powershellExecutable;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const exactPowerShell = typeof systemRoot === "string"
    ? path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
    : undefined;
  if (
    typeof powershellExecutable !== "string" ||
    !path.win32.isAbsolute(powershellExecutable) ||
    exactPowerShell === undefined ||
    path.win32.normalize(powershellExecutable).toLowerCase() !==
      path.win32.normalize(exactPowerShell).toLowerCase()
  ) {
    throw new Error(
      "production encoded-bootstrap requires the exact SystemRoot PowerShell path",
    );
  }
  const commandLine = [
    windowsArgument(path.win32.normalize(powershellExecutable)),
    ...args.map(windowsArgument),
  ].join(" ");
  if (commandLine.length > PRODUCTION_LAUNCH_COMMAND_LINE_LIMIT) {
    throw new Error(
      `production encoded-bootstrap command line is ${String(commandLine.length)} ` +
        `characters; limit is ${String(PRODUCTION_LAUNCH_COMMAND_LINE_LIMIT)}`,
    );
  }
  return args;
}

export function parseProductionLaunchPayloadBase64(value) {
  const wire = strictBase64Decode(value, "production bootstrap payload", "utf8");
  const encoded = wire.split("\t");
  const values = encoded.map((field) =>
    strictBase64Decode(field, "production bootstrap field", "utf8")
  );
  if (values.length < 7) {
    throw new Error("production bootstrap payload field count is invalid");
  }
  const argumentCount = Number(values[6]);
  if (
    !Number.isSafeInteger(argumentCount) ||
    argumentCount < 0 ||
    String(argumentCount) !== values[6] ||
    values.length !== 7 + argumentCount
  ) {
    throw new Error("production bootstrap argument count is invalid");
  }
  const payload = normalizePayload({
    repoRoot: values[1],
    role: values[2],
    expectedCommit: values[4],
    expectedTree: values[5],
    commandArguments: values.slice(7),
  });
  if (
    values[0] !== payload.schemaVersion ||
    values[3] !== LAUNCHER_RELATIVE_PATH ||
    productionLaunchPayloadBase64(payload) !== value
  ) {
    throw new Error("production bootstrap payload is not canonical");
  }
  return payload;
}

export function parseProductionLaunchEncodedArguments(value) {
  const xml = strictBase64Decode(
    value,
    "production encoded arguments",
    "utf16le",
  );
  const match = /^<Objs Version="1\.1\.0\.1" xmlns="http:\/\/schemas\.microsoft\.com\/powershell\/2004\/04">\r\n  <Obj RefId="0">\r\n    <TN RefId="0">\r\n      <T>System\.Object\[\]<\/T>\r\n      <T>System\.Array<\/T>\r\n      <T>System\.Object<\/T>\r\n    <\/TN>\r\n    <LST>\r\n      <S>([A-Za-z0-9+/]+={0,2})<\/S>\r\n    <\/LST>\r\n  <\/Obj>\r\n<\/Objs>$/u.exec(xml);
  if (match === null) {
    throw new Error("production encoded arguments are not canonical CLIXML");
  }
  const payload = parseProductionLaunchPayloadBase64(match[1]);
  if (productionLaunchEncodedArguments(payload) !== value) {
    throw new Error("production encoded arguments do not round-trip canonically");
  }
  return payload;
}

export function productionLaunchBootstrapIdentity(input) {
  const payload = normalizePayload(input);
  const payloadBase64 = productionLaunchPayloadBase64(payload);
  const values = [
    payload.schemaVersion,
    payload.repoRoot.toLowerCase(),
    payload.role,
    payload.expectedCommit,
    payload.expectedTree,
    LAUNCHER_RELATIVE_PATH,
    createHash("sha256")
      .update(Buffer.from(payloadBase64, "base64"))
      .digest("hex"),
    createHash("sha256")
      .update(Buffer.from(productionLaunchEncodedCommand(), "base64"))
      .digest("hex"),
    BOOTSTRAP_TEMPLATE_SHA256,
  ];
  return {
    payload,
    values,
    digestSha256: createHash("sha256")
      .update(values.map(encodeField).join("."))
      .digest("hex"),
  };
}

function canonicalGenerationTimestamp(value) {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(
      "production launch review candidate requires a canonical ISO generation timestamp",
    );
  }
  return value;
}

function authorityLabel(value) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(
      "production launch review candidate requires a bounded authority label",
    );
  }
  return value;
}

export function productionLaunchReviewCandidate(input) {
  const payload = normalizePayload(input);
  const hostArguments = productionLaunchPowerShellArguments(input);
  const payloadBytes = Buffer.from(productionLaunchPayloadBase64(payload), "base64");
  const encodedArgumentBytes = Buffer.from(hostArguments[5], "base64");
  const commandBytes = Buffer.from(hostArguments[7], "base64");
  return {
    schemaVersion: PRODUCTION_LAUNCH_REVIEW_CANDIDATE_SCHEMA,
    authoritative: false,
    warning:
      "review-only: approve and retain this exact vector outside the mutable worktree before canonical execution",
    generationTimestamp: canonicalGenerationTimestamp(input.generationTimestamp),
    authorityLabel: authorityLabel(input.authorityLabel),
    powershellExecutable: path.win32.normalize(input.powershellExecutable),
    hostArguments,
    encodedArgumentsSha256: createHash("sha256")
      .update(encodedArgumentBytes)
      .digest("hex"),
    encodedCommandSha256: createHash("sha256")
      .update(commandBytes)
      .digest("hex"),
    bootstrapTemplateSha256: BOOTSTRAP_TEMPLATE_SHA256,
    payloadSha256: createHash("sha256")
      .update(payloadBytes)
      .digest("hex"),
    expectedCommit: payload.expectedCommit,
    expectedTree: payload.expectedTree,
    repoRoot: payload.repoRoot,
    workingDirectory: payload.repoRoot,
    role: payload.role,
    commandArguments: payload.commandArguments,
  };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) &&
  process.argv[2] === "__render-production-launch-review-candidate"
) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    throw new Error("production launch renderer input is malformed");
  }
  process.stdout.write(JSON.stringify(productionLaunchReviewCandidate(input)));
} else if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) &&
  process.argv[2] === "__render-production-launch"
) {
  throw new Error(
    "worktree launch rendering is non-canonical; use the review-candidate command and independently approve the exact vector",
  );
}
