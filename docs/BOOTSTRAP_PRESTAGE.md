# Protected local bootstrap prestage

Use this production two-shell procedure. Signed-release verification and
evidence production happen before elevation. The elevated shell only stages
the already verified bytes and runs the canonical ProgramData consumer; it
must not derive replacement hashes.

The contract is `config/bootstrap-prestage-evidence.schema.json`; the adjacent
example contains non-production placeholder hashes.

## 1. Normal coordinator shell

Run from a clean merged checkout while the NAS release root is sealed:

```powershell
$RepoRoot = "C:\Users\BT\Projects\revAgent"
$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
$TrustedKeys = Join-Path $ReleaseRoot "tools\config\release-trusted-keys.json"
$EvidenceSource = Join-Path $env:TEMP ("revagent-bootstrap-evidence-{0}.json" -f [guid]::NewGuid().ToString("N"))
$evidenceResult = & "$RepoRoot\scripts\New-RevAgentBootstrapPrestageEvidence.ps1" `
  -ReleaseRoot $ReleaseRoot -TrustedKeysPath $TrustedKeys `
  -OutputPath $EvidenceSource -RepoRoot $RepoRoot

$channel = Get-Content -Raw -LiteralPath (Join-Path $ReleaseRoot "channels\stable.json") | ConvertFrom-Json
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

## 2. Fresh elevated Windows PowerShell shell

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
$ProgramDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$trustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$danger = [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership

function Assert-SafeExistingDirectory([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Unsafe prestage ancestor: $Path" }
  $acl = Get-Acl -LiteralPath $Path
  $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($trustedOwners -notcontains $owner) { throw "Untrusted prestage ancestor owner: $Path owner=$owner" }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $trustedOwners -notcontains [string]$rule.IdentityReference.Value -and (($rule.FileSystemRights -band $danger) -ne 0)) { throw "Untrusted delete/ACL-capable ancestor rule: $Path principal=$($rule.IdentityReference.Value)" }
  }
}

function New-ProtectedChild([string]$Parent, [string]$Name) {
  Assert-SafeExistingDirectory $Parent
  $path = Join-Path $Parent $Name
  if (Test-Path -LiteralPath $path) { Assert-SafeExistingDirectory $path; return $path }
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach ($entry in @(@('S-1-5-18', [Security.AccessControl.FileSystemRights]::FullControl), @('S-1-5-32-544', [Security.AccessControl.FileSystemRights]::FullControl), @('S-1-5-32-545', [Security.AccessControl.FileSystemRights]::ReadAndExecute))) {
    [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new([string]$entry[0]), [Security.AccessControl.FileSystemRights]$entry[1], ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
  [void]([IO.DirectoryInfo]::new($Parent).CreateSubdirectory($Name, $acl))
  Assert-SafeExistingDirectory $path
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
$dpe = New-ProtectedChild $ProgramDataRoot 'DPE'; $product = New-ProtectedChild $dpe 'revAgent'; $prestage = New-ProtectedChild $product 'prestage'
$stagedEvidence = Join-Path $prestage 'bootstrap-prestage-evidence.json'; $stagedInstaller = Join-Path $prestage 'install-revagent-local-bootstrap.ps1'
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
foreach ($path in @($stagedEvidence, $stagedInstaller)) {
  if (Test-Path -LiteralPath $path) { if (((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing linked prestage leaf: $path" }; Remove-Item -LiteralPath $path -Force }
}
[IO.File]::WriteAllBytes($stagedEvidence, $evidenceBytes); [IO.File]::WriteAllBytes($stagedInstaller, $installerBytes)
foreach ($path in @($stagedEvidence, $stagedInstaller)) { Set-AdminOnlyAcl $path }

& $stagedInstaller -RepoRoot $SourceRoot -ReleaseRoot $ReleaseRoot `
  -TrustedKeysPath $TrustedKeys -ExpectedHashesPath $stagedEvidence `
  -ConfirmIndependentlyAuthenticatedSource
```

After success, close Revit and run only:

```text
C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd
```

Production NAS `tools` contains no `.cmd` launcher. A stale local launcher is
still checked against its signed manifest component and returns
`bootstrap_refresh_required`; repeat this two-shell procedure.
