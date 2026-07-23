import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_SOURCE_ANCHOR_SCHEMA =
  "rbp-production-source-anchor/v1";
export const PRODUCTION_NODE_MINIMUM_VERSION = "22.15.0";

const NODE_SIGNER = "OpenJS Foundation";
const GIT_SIGNER = "Johannes Schindelin";
const SIGNATURE_TARGET_KEY = "RBP_PRODUCTION_SIGNATURE_TARGET";
const SIGNATURE_SIGNER_KEY = "RBP_PRODUCTION_SIGNATURE_SIGNER";

export const PRODUCTION_SOURCE_ANCHOR_PATHS = Object.freeze([
  "package-lock.json",
  "package.json",
  "packages/protocol/package.json",
  "packages/protocol/scripts/clean.mjs",
  "packages/protocol/scripts/generate-types.mjs",
  "packages/protocol/tsconfig.json",
  "packages/rbp-conformance/.gitattributes",
  "packages/rbp-conformance/package.json",
  "packages/rbp-conformance/scripts/bootstrap-identity.mjs",
  "packages/rbp-conformance/scripts/invoke-production.ps1",
  "packages/rbp-conformance/scripts/prepare-production.mjs",
  "packages/rbp-conformance/scripts/production-bootstrap-identity.json",
  "packages/rbp-conformance/scripts/production-cli-bootstrap.mjs",
  "packages/rbp-conformance/scripts/production-controller-bootstrap.mjs",
  "packages/rbp-conformance/scripts/production-launch-bootstrap.mjs",
  "packages/rbp-conformance/scripts/production-launch-attestation.mjs",
  "packages/rbp-conformance/scripts/production-source-anchor.mjs",
  "packages/rbp-conformance/src/productionLaunchAttestation.ts",
  "packages/rbp-conformance/tsconfig.json",
]);

const RESOLUTION_ENVIRONMENT_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_PRESERVE_SYMLINKS",
  "NODE_COMPILE_CACHE",
  "NODE_DISABLE_COMPILE_CACHE",
  "WS_NO_BUFFER_UTIL",
  "WS_NO_UTF_8_VALIDATE",
]);

const HARDENED_GIT_CONFIG = Object.freeze([
  "--no-replace-objects",
  "-c", "core.attributesfile=",
  "-c", "core.autocrlf=input",
  "-c", "core.excludesfile=",
  "-c", "core.fsmonitor=false",
  "-c", "core.ignorestat=false",
  "-c", "core.preloadindex=false",
  "-c", "core.useReplaceRefs=false",
  "-c", "core.safecrlf=false",
  "-c", "core.trustctime=true",
  "-c", "core.untrackedCache=false",
]);

const AUTHENTICODE_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable(
  'RBP_PRODUCTION_SIGNATURE_TARGET'
)
$expectedSigner = [Environment]::GetEnvironmentVariable(
  'RBP_PRODUCTION_SIGNATURE_SIGNER'
)
if (
  [string]::IsNullOrWhiteSpace($target) -or
  [string]::IsNullOrWhiteSpace($expectedSigner)
) {
  throw 'Authenticode probe inputs are unavailable'
}
$module = Join-Path $PSHOME (
  'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
)
$cmdletType = [Management.Automation.CommandTypes]::Cmdlet
$importModule = $ExecutionContext.InvokeCommand.GetCommand(
  'Microsoft.PowerShell.Core\Import-Module',
  $cmdletType
)
if ($null -eq $importModule) {
  throw 'Exact Import-Module cmdlet is unavailable'
}
& $importModule -Name $module -Force -ErrorAction Stop
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)) {
  throw 'Production binary authentication refuses an elevated token'
}
$target = [IO.Path]::GetFullPath($target)
$roots = @(
  [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),
  [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86),
  [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
) | Where-Object {
  -not [string]::IsNullOrWhiteSpace($_)
} | ForEach-Object {
  [IO.Path]::GetFullPath($_).TrimEnd('\')
} | Sort-Object -Unique
$trustedRoot = @($roots | Where-Object {
  [StringComparer]::OrdinalIgnoreCase.Equals($target, $_) -or
  $target.StartsWith($_ + '\', [StringComparison]::OrdinalIgnoreCase)
} | Sort-Object { $_.Length } -Descending | Select-Object -First 1)
if ($trustedRoot.Count -ne 1) {
  throw 'Authenticode target is outside protected Program Files/SystemRoot'
}
$trustedRoot = [string]$trustedRoot[0]
$trustedInstallerSid = ''
try {
  $trustedInstallerSid = [string](
    [Security.Principal.NTAccount]'NT SERVICE\TrustedInstaller'
  ).Translate([Security.Principal.SecurityIdentifier]).Value
}
catch {}
$trustedOwners = @('S-1-5-18', 'S-1-5-32-544')
if (-not [string]::IsNullOrWhiteSpace($trustedInstallerSid)) {
  $trustedOwners += $trustedInstallerSid
}
$trustedWriters = [Collections.Generic.HashSet[string]]::new(
  [StringComparer]::OrdinalIgnoreCase
)
foreach ($sid in $trustedOwners) { [void]$trustedWriters.Add($sid) }
$dangerousRights = [int64](
  [Security.AccessControl.FileSystemRights]::WriteData -bor
  [Security.AccessControl.FileSystemRights]::AppendData -bor
  [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
  [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
  [Security.AccessControl.FileSystemRights]::Delete -bor
  [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [Security.AccessControl.FileSystemRights]::TakeOwnership
)
$relative = $target.Substring($trustedRoot.Length).TrimStart('\')
$cursor = $trustedRoot
$chain = @($cursor)
foreach ($segment in @($relative -split '\\' | Where-Object {
  -not [string]::IsNullOrWhiteSpace($_)
})) {
  $cursor = Join-Path $cursor $segment
  $chain += $cursor
}
foreach ($chainPath in $chain) {
  $item = Get-Item -LiteralPath $chainPath -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw ('Protected path chain contains a reparse point: ' + $chainPath)
  }
  $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $chainPath -ErrorAction Stop
  $ownerSid = [string]$acl.GetOwner(
    [Security.Principal.SecurityIdentifier]
  ).Value
  if (@($trustedOwners | Where-Object {
    [StringComparer]::OrdinalIgnoreCase.Equals($_, $ownerSid)
  }).Count -eq 0) {
    throw ('Protected path chain has an untrusted owner: ' + $chainPath)
  }
  $rules = @($acl.GetAccessRules(
    $true,
    $true,
    [Security.Principal.SecurityIdentifier]
  ))
  $foreignWriter = @($rules | Where-Object {
    $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    (([int64]$_.FileSystemRights -band $dangerousRights) -ne 0) -and
    -not $trustedWriters.Contains([string]$_.IdentityReference.Value)
  } | Select-Object -First 1)
  if ($foreignWriter.Count -ne 0) {
    throw ('Protected path chain grants write to an untrusted SID: ' + $chainPath)
  }
}
$getSignature = $ExecutionContext.InvokeCommand.GetCommand(
  'Microsoft.PowerShell.Security\Get-AuthenticodeSignature',
  $cmdletType
)
if ($null -eq $getSignature) {
  throw 'Exact Get-AuthenticodeSignature cmdlet is unavailable'
}
$signature = & $getSignature -LiteralPath $target -ErrorAction Stop
if (
  $signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
  $null -eq $signature.SignerCertificate
) {
  throw ('Authenticode status is not Valid: ' + [string]$signature.Status)
}
$simpleName = $signature.SignerCertificate.GetNameInfo(
  [Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
  $false
)
if (-not [StringComparer]::Ordinal.Equals($simpleName, $expectedSigner)) {
  throw ('Authenticode signer is unexpected: ' + $simpleName)
}
$values = @(
  $trustedRoot,
  [string]$signature.Status,
  $simpleName,
  [string]$signature.SignerCertificate.Subject,
  [string]$signature.SignerCertificate.Thumbprint
)
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$encoded = foreach ($value in $values) {
  [Convert]::ToBase64String($utf8.GetBytes($value))
}
[Console]::Out.WriteLine([string]::Join([char]9, $encoded))
`;

const KNOWN_FOLDERS_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
$values = @(
  [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),
  [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
) | Where-Object {
  -not [string]::IsNullOrWhiteSpace($_)
} | ForEach-Object {
  [IO.Path]::GetFullPath($_).TrimEnd('\')
} | Select-Object -Unique
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$encoded = foreach ($value in $values) {
  [Convert]::ToBase64String($utf8.GetBytes($value))
}
[Console]::Out.WriteLine([string]::Join([char]9, $encoded))
`;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedPath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function isInside(parentValue, childValue) {
  const relative = path.relative(path.resolve(parentValue), path.resolve(childValue));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

function strictBase64Decode(value, label) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
    value,
  )) {
    throw new Error(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`${label} is not valid UTF-8`);
  }
  return text;
}

function cleanEnvironment({ preservePath = false } = {}) {
  const result = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase();
    if (
      RESOLUTION_ENVIRONMENT_KEYS.has(normalized) ||
      normalized.startsWith("GIT_") ||
      normalized.startsWith("NPM_CONFIG_") ||
      normalized === "NPM_EXECPATH" ||
      normalized === "NPM_NODE_EXECPATH" ||
      normalized.startsWith("NPM_LIFECYCLE_") ||
      normalized.startsWith("RBP_PRODUCTION_") ||
      (!preservePath && normalized === "PATH")
    ) {
      continue;
    }
    result[key] = value;
  }
  result.PATH = preservePath ? (process.env.PATH ?? "") : "";
  return result;
}

function gitEnvironment() {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    ...cleanEnvironment(),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function run(executable, args, {
  cwd,
  env = cleanEnvironment(),
  input,
  label,
  timeout = 30_000,
} = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env,
    input,
    shell: false,
    timeout,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error(`${label ?? executable} failed: ${result.error.message}`);
  }
  return result;
}

function assertNoReparsePathSegments(value, label) {
  const absolute = path.resolve(value);
  const root = path.parse(absolute).root;
  const relative = path.relative(root, absolute);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!existsSync(cursor)) {
      throw new Error(`${label} path segment does not exist: ${cursor}`);
    }
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} path contains a reparse point: ${cursor}`);
    }
  }
  return absolute;
}

function exactPhysicalRegularFile(value, label) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const lexical = assertNoReparsePathSegments(path.resolve(value), label);
  const stat = lstatSync(lexical);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical regular file: ${lexical}`);
  }
  const real = realpathSync(lexical);
  if (!samePath(real, lexical)) {
    throw new Error(`${label} final path is not its lexical path: ${lexical}`);
  }
  return {
    path: lexical,
    realPath: real,
    sha256: sha256File(real),
  };
}

function exactPhysicalDirectory(value, label) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const lexical = assertNoReparsePathSegments(path.resolve(value), label);
  const stat = lstatSync(lexical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory: ${lexical}`);
  }
  const real = realpathSync(lexical);
  if (!samePath(real, lexical)) {
    throw new Error(`${label} final path is not its lexical path: ${lexical}`);
  }
  return real;
}

function exactSystemPowerShell(powershellExecutable) {
  if (powershellExecutable !== undefined) {
    return exactPhysicalRegularFile(
      powershellExecutable,
      "authenticated SystemRoot Windows PowerShell",
    ).realPath;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("SystemRoot is unavailable for production authentication");
  }
  return exactPhysicalRegularFile(
    path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    "exact SystemRoot Windows PowerShell",
  ).realPath;
}

function verifyAuthenticode(file, expectedSigner, label, powershellExecutable) {
  const powershell = exactSystemPowerShell(powershellExecutable);
  const encoded = Buffer.from(AUTHENTICODE_HELPER, "utf16le").toString("base64");
  const result = run(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    {
      env: {
        SystemRoot: process.env.SystemRoot ?? process.env.WINDIR,
        WINDIR: process.env.WINDIR ?? process.env.SystemRoot,
        [SIGNATURE_TARGET_KEY]: file,
        [SIGNATURE_SIGNER_KEY]: expectedSigner,
      },
      label: `${label} Authenticode probe`,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `${label} Authenticode validation failed: ${String(result.stderr).trim()}`,
    );
  }
  const fields = String(result.stdout).trim().split("\t");
  if (fields.length !== 5) {
    throw new Error(`${label} Authenticode probe returned a malformed record`);
  }
  const values = fields.map((field, index) =>
    strictBase64Decode(field, `${label} Authenticode field ${String(index)}`)
  );
  if (values[1] !== "Valid" || values[2] !== expectedSigner) {
    throw new Error(`${label} Authenticode identity is not trusted`);
  }
  return {
    protectedRoot: values[0],
    status: values[1],
    signer: values[2],
    subject: values[3],
    thumbprint: values[4].toLowerCase(),
  };
}

function protectedProgramFilesRoots(powershellExecutable) {
  const powershell = exactSystemPowerShell(powershellExecutable);
  const encoded = Buffer.from(KNOWN_FOLDERS_HELPER, "utf16le").toString("base64");
  const result = run(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    {
      env: {},
      label: "protected Program Files known-folder probe",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      "protected Program Files known-folder probe failed: " +
        String(result.stderr).trim(),
    );
  }
  const fields = String(result.stdout).trim().split("\t").filter(Boolean);
  const roots = fields.map((field, index) =>
    strictBase64Decode(field, `Program Files field ${String(index)}`)
  );
  if (roots.length === 0 || roots.some((root) => !path.win32.isAbsolute(root))) {
    throw new Error("protected Program Files known-folder probe was incomplete");
  }
  return roots;
}

function parseVersion(value, label) {
  const match = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+].*)?$/u.exec(value);
  if (match === null) {
    throw new Error(`${label} returned an unexpected version: ${value}`);
  }
  return match.slice(1).map(Number);
}

function compareVersion(leftValue, rightValue) {
  const left = parseVersion(leftValue, "Node");
  const right = parseVersion(rightValue, "minimum Node");
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function nodeIdentity(nodeExecutable, powershellExecutable) {
  const programFilesRoots = protectedProgramFilesRoots(powershellExecutable);
  const canonicalNode = path.join(
    programFilesRoots[0],
    "nodejs",
    "node.exe",
  );
  if (!samePath(nodeExecutable, canonicalNode)) {
    throw new Error(
      `production Node must be the exact Program Files candidate: ${canonicalNode}`,
    );
  }
  const file = exactPhysicalRegularFile(canonicalNode, "production Node executable");
  const signature = verifyAuthenticode(
    file.realPath,
    NODE_SIGNER,
    "production Node",
    powershellExecutable,
  );
  const source = [
    "const moduleBuiltin = require('node:module');",
    "const value = {",
    "version: process.version,",
    "execPath: process.execPath,",
    "registerHooks: typeof moduleBuiltin.registerHooks,",
    "};",
    "process.stdout.write(JSON.stringify(value));",
  ].join("");
  const result = run(file.realPath, ["-e", source], {
    label: "production Node capability probe",
  });
  if (result.status !== 0) {
    throw new Error(
      `production Node capability probe failed: ${String(result.stderr).trim()}`,
    );
  }
  let probe;
  try {
    probe = JSON.parse(String(result.stdout));
  } catch {
    throw new Error("production Node capability probe returned malformed JSON");
  }
  if (
    probe === null ||
    typeof probe !== "object" ||
    typeof probe.version !== "string" ||
    typeof probe.execPath !== "string" ||
    probe.registerHooks !== "function" ||
    !samePath(probe.execPath, file.realPath) ||
    compareVersion(probe.version, PRODUCTION_NODE_MINIMUM_VERSION) < 0
  ) {
    throw new Error(
      `production launcher requires Node ${PRODUCTION_NODE_MINIMUM_VERSION}+ ` +
        "with synchronous module.registerHooks",
    );
  }
  return { ...file, version: probe.version, signature };
}

function gitVersion(file) {
  const result = run(file, ["--version"], {
    label: "Git identity probe",
  });
  if (result.status !== 0) {
    throw new Error(`Git identity probe failed: ${String(result.stderr).trim()}`);
  }
  const version = String(result.stdout).trim();
  if (!/^git version [0-9]+\.[0-9]+\.[0-9]+/u.test(version)) {
    throw new Error(`Git identity probe returned an unexpected version: ${version}`);
  }
  return version;
}

function resolveGitIdentity(powershellExecutable) {
  const powershell = exactSystemPowerShell(powershellExecutable);
  const candidates = protectedProgramFilesRoots(powershell)
    .map((root) => path.join(root, "Git", "bin", "git.exe"))
    .filter(existsSync);
  const trusted = [];
  const rejected = [];
  for (const candidate of candidates) {
    try {
      const file = exactPhysicalRegularFile(candidate, "Git executable candidate");
      const signature = verifyAuthenticode(
        file.realPath,
        GIT_SIGNER,
        "Git executable",
        powershell,
      );
      trusted.push({
        ...file,
        version: gitVersion(file.realPath),
        signature,
      });
    } catch (error) {
      rejected.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (trusted.length === 0) {
    const detail = rejected.length > 0 ? `: ${rejected.join("; ")}` : "";
    throw new Error(`no trusted protected Git executable candidate was found${detail}`);
  }
  if (trusted.length > 1) {
    throw new Error("multiple trusted canonical Program Files Git candidates exist");
  }
  return trusted[0];
}

function assertSameFile(expected, label) {
  const current = exactPhysicalRegularFile(expected.path, label);
  if (
    !samePath(current.realPath, expected.realPath) ||
    current.sha256 !== expected.sha256
  ) {
    throw new Error(`${label} changed while the source anchor was captured`);
  }
}

function assertSameGit(expected) {
  const current = exactPhysicalRegularFile(expected.path, "Git executable");
  if (
    !samePath(current.realPath, expected.realPath) ||
    current.sha256 !== expected.sha256 ||
    gitVersion(current.realPath) !== expected.version
  ) {
    throw new Error("Git executable changed while the source anchor was captured");
  }
}

function runGit(git, repoRoot, args, label, options = {}) {
  const result = run(
    git.realPath,
    [...HARDENED_GIT_CONFIG, ...args],
    {
      cwd: repoRoot,
      env: gitEnvironment(),
      label,
      ...options,
    },
  );
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${String(result.stderr).trim()}`);
  }
  return result;
}

function assertRepositoryGuards(git, repoRoot) {
  const topLevel = String(runGit(
    git,
    repoRoot,
    ["rev-parse", "--show-toplevel"],
    "Git worktree-root probe",
  ).stdout).trim();
  if (!samePath(topLevel, repoRoot)) {
    throw new Error("production source root is not the actual Git worktree root");
  }

  const filters = run(
    git.realPath,
    [
      ...HARDENED_GIT_CONFIG,
      "config",
      "--get-regexp",
      "^filter\\.",
    ],
    { cwd: repoRoot, env: gitEnvironment(), label: "Git effective-filter probe" },
  );
  if (filters.status === 0 && String(filters.stdout).trim().length > 0) {
    throw new Error("production source anchor rejects effective Git filters");
  }
  if (filters.status !== 0 && filters.status !== 1) {
    throw new Error(`Git effective-filter probe failed: ${String(filters.stderr).trim()}`);
  }

  const infoAttributesPath = String(runGit(
    git,
    repoRoot,
    ["rev-parse", "--git-path", "info/attributes"],
    "Git info-attributes path probe",
  ).stdout).trim();
  const absoluteInfoAttributes = path.isAbsolute(infoAttributesPath)
    ? infoAttributesPath
    : path.resolve(repoRoot, infoAttributesPath);
  if (
    existsSync(absoluteInfoAttributes) &&
    readFileSync(absoluteInfoAttributes, "utf8")
      .split(/\r?\n/u)
      .some((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"))
  ) {
    throw new Error("production source anchor rejects Git info attributes");
  }

  const treeRows = String(runGit(
    git,
    repoRoot,
    ["ls-tree", "-r", "-z", "--full-tree", "HEAD"],
    "Git protected HEAD tree probe",
  ).stdout).split("\0").filter(Boolean);
  const indexRows = String(runGit(
    git,
    repoRoot,
    ["ls-files", "--stage", "-z"],
    "Git protected index-tree probe",
  ).stdout).split("\0").filter(Boolean);
  if (treeRows.length !== indexRows.length) {
    throw new Error("Git index path set does not match protected HEAD");
  }
  treeRows.forEach((treeRow, index) => {
    const treeMatch = /^([0-7]{6}) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(treeRow);
    const indexMatch =
      /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t(.+)$/u.exec(indexRows[index] ?? "");
    if (
      treeMatch === null ||
      indexMatch === null ||
      !["100644", "100755"].includes(treeMatch[1]) ||
      treeMatch[1] !== indexMatch[1] ||
      treeMatch[2] !== indexMatch[2] ||
      treeMatch[3] !== indexMatch[3]
    ) {
      throw new Error(`Git index does not match protected HEAD at row ${String(index)}`);
    }
  });
  const trackedRows = treeRows.map((row) => {
    const match = /^([0-7]{6}) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(row);
    if (
      match === null ||
      !["100644", "100755"].includes(match[1]) ||
      /[\r\n]/u.test(match[3])
    ) {
      throw new Error(`unsupported protected HEAD tree entry: ${row}`);
    }
    return {
      objectId: match[2],
      path: match[3],
    };
  });
  for (const entry of trackedRows) {
    const absolute = path.join(repoRoot, ...entry.path.split("/"));
    const file = exactPhysicalRegularFile(
      absolute,
      `tracked worktree file ${entry.path}`,
    );
    if (!isInside(repoRoot, file.realPath)) {
      throw new Error(`tracked worktree file escapes the root: ${entry.path}`);
    }
  }
  const worktreeDiff = String(runGit(
    git,
    repoRoot,
    [
      "diff",
      "--raw",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
    ],
    "Git normalized tracked-worktree cleanliness probe",
  ).stdout);
  if (worktreeDiff.length > 0) {
    throw new Error("production source anchor requires a clean Git worktree");
  }
  const rawSourceRows = trackedRows.filter((entry) =>
    entry.path === "package.json" ||
    entry.path === "package-lock.json" ||
    entry.path === "tsconfig.base.json" ||
    entry.path.startsWith("packages/protocol/") ||
    entry.path.startsWith("packages/rbp-conformance/")
  );
  const rawSourceHashes = String(runGit(
    git,
    repoRoot,
    ["hash-object", "--no-filters", "--stdin-paths"],
    "Git raw production-source byte probe",
    { input: `${rawSourceRows.map((entry) => entry.path).join("\n")}\n` },
  ).stdout).trim().split(/\r?\n/u);
  if (rawSourceHashes.length !== rawSourceRows.length) {
    throw new Error("Git did not raw-hash every production source path");
  }
  rawSourceRows.forEach((entry, index) => {
    if (rawSourceHashes[index] !== entry.objectId) {
      throw new Error(`tracked worktree bytes do not match HEAD: ${entry.path}`);
    }
  });

  const visibleUntracked = String(runGit(
    git,
    repoRoot,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "Git visible-untracked worktree probe",
  ).stdout).split("\0").filter(Boolean);
  if (visibleUntracked.length > 0) {
    throw new Error(
      `production source anchor requires a clean Git worktree: ${visibleUntracked[0]}`,
    );
  }

  const assumed = String(runGit(
    git,
    repoRoot,
    ["ls-files", "-v", "-z"],
    "Git assume-unchanged probe",
  ).stdout).split("\0").filter(Boolean).find((record) => /^[a-z] /u.test(record));
  if (assumed !== undefined) {
    throw new Error(`production source anchor rejects assume-unchanged: ${assumed.slice(2)}`);
  }

  const skipped = String(runGit(
    git,
    repoRoot,
    ["ls-files", "-t", "-z"],
    "Git skip-worktree probe",
  ).stdout).split("\0").filter(Boolean).find((record) => record.startsWith("S "));
  if (skipped !== undefined) {
    throw new Error(`production source anchor rejects skip-worktree: ${skipped.slice(2)}`);
  }

  const replaceRefs = String(runGit(
    git,
    repoRoot,
    ["for-each-ref", "--format=%(refname)", "refs/replace"],
    "Git replace-ref probe",
  ).stdout).trim();
  if (replaceRefs.length > 0) {
    throw new Error("production source anchor rejects Git replace refs");
  }

  const graftsPath = String(runGit(
    git,
    repoRoot,
    ["rev-parse", "--git-path", "info/grafts"],
    "Git graft-path probe",
  ).stdout).trim();
  const absoluteGrafts = path.isAbsolute(graftsPath)
    ? graftsPath
    : path.resolve(repoRoot, graftsPath);
  if (
    existsSync(absoluteGrafts) &&
    readFileSync(absoluteGrafts, "utf8").trim().length > 0
  ) {
    throw new Error("production source anchor rejects legacy Git grafts");
  }

  const untrackedCompileInputs = String(runGit(
    git,
    repoRoot,
    [
      "ls-files",
      "--others",
      "-z",
      "--",
      "package.json",
      "package-lock.json",
      "tsconfig.base.json",
      "packages/protocol/package.json",
      "packages/protocol/tsconfig.json",
      "packages/protocol/scripts",
      "packages/protocol/schemas",
      "packages/protocol/src",
      "packages/rbp-conformance/.gitattributes",
      "packages/rbp-conformance/package.json",
      "packages/rbp-conformance/tsconfig.json",
      "packages/rbp-conformance/scripts",
      "packages/rbp-conformance/schemas",
      "packages/rbp-conformance/manifest",
      "packages/rbp-conformance/src",
    ],
    "Git untracked compile-input probe",
  ).stdout).split("\0").filter(Boolean);
  if (untrackedCompileInputs.length > 0) {
    throw new Error(
      `production source anchor rejects untracked compile input: ${
        untrackedCompileInputs[0]
      }`,
    );
  }
}

function trackedSourceReceipts(git, repoRoot, relativePaths) {
  const files = new Map();
  for (const relativePath of relativePaths) {
    if (
      path.isAbsolute(relativePath) ||
      relativePath.includes("\\") ||
      relativePath.split("/").some((segment) => segment === "" || segment === "..")
    ) {
      throw new Error(`production source-anchor path is not canonical: ${relativePath}`);
    }
    const absolute = path.join(repoRoot, ...relativePath.split("/"));
    const file = exactPhysicalRegularFile(absolute, `tracked source ${relativePath}`);
    if (!isInside(repoRoot, file.realPath)) {
      throw new Error(`tracked source escapes the Git worktree: ${relativePath}`);
    }
    files.set(relativePath, file);
  }

  const indexRows = String(runGit(
    git,
    repoRoot,
    ["ls-files", "--stage", "-z", "--", ...relativePaths],
    "Git tracked source-index probe",
  ).stdout).split("\0").filter(Boolean);
  const index = new Map();
  for (const row of indexRows) {
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t(.+)$/u.exec(row);
    if (match === null || index.has(match[3])) {
      throw new Error(`tracked source has an unsupported Git index record: ${row}`);
    }
    index.set(match[3], { mode: match[1], objectId: match[2] });
  }

  const treeRows = String(runGit(
    git,
    repoRoot,
    ["ls-tree", "-z", "HEAD", "--", ...relativePaths],
    "Git tracked source-HEAD probe",
  ).stdout).split("\0").filter(Boolean);
  const tree = new Map();
  for (const row of treeRows) {
    const match = /^([0-7]{6}) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(row);
    if (match === null || tree.has(match[3])) {
      throw new Error(`tracked source has an unsupported Git HEAD record: ${row}`);
    }
    tree.set(match[3], { mode: match[1], objectId: match[2] });
  }

  const hashes = String(runGit(
    git,
    repoRoot,
    ["hash-object", "--no-filters", "--stdin-paths"],
    "Git tracked source-byte probe",
    { input: `${relativePaths.join("\n")}\n` },
  ).stdout).trim().split(/\r?\n/u);
  if (hashes.length !== relativePaths.length) {
    throw new Error("Git did not hash every production source-anchor path");
  }

  return relativePaths.map((relativePath, position) => {
    const indexValue = index.get(relativePath);
    const treeValue = tree.get(relativePath);
    const file = files.get(relativePath);
    if (
      indexValue === undefined ||
      treeValue === undefined ||
      file === undefined ||
      !["100644", "100755"].includes(treeValue.mode) ||
      indexValue.mode !== treeValue.mode ||
      indexValue.objectId !== treeValue.objectId
    ) {
      throw new Error(`tracked source index does not match HEAD: ${relativePath}`);
    }
    if (hashes[position] !== treeValue.objectId) {
      throw new Error(`tracked source bytes do not match HEAD: ${relativePath}`);
    }
    return {
      relativePath,
      mode: treeValue.mode,
      objectId: treeValue.objectId,
      sha256: file.sha256,
    };
  });
}

export function productionSourceAnchorDigest(values) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string")
  ) {
    throw new Error("production source-anchor values must be strings");
  }
  return sha256Bytes(
    values.map((value) => Buffer.from(value, "utf8").toString("base64")).join("."),
  );
}

export function captureProductionSourceAnchor({
  repoRoot: repoRootValue,
  nodeExecutable = process.execPath,
  powershellExecutable,
} = {}) {
  if (process.platform !== "win32") {
    throw new Error("production source anchoring is Windows-only");
  }
  const repoRoot = exactPhysicalDirectory(
    path.resolve(repoRootValue),
    "production source root",
  );
  const powershell = exactSystemPowerShell(powershellExecutable);
  const node = nodeIdentity(nodeExecutable, powershell);
  const git = resolveGitIdentity(powershell);
  assertSameGit(git);
  assertRepositoryGuards(git, repoRoot);
  const commit = String(runGit(
    git,
    repoRoot,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "Git HEAD commit probe",
  ).stdout).trim();
  const tree = String(runGit(
    git,
    repoRoot,
    ["rev-parse", "--verify", "HEAD^{tree}"],
    "Git HEAD tree probe",
  ).stdout).trim();
  if (
    !/^[0-9a-f]{40,64}$/u.test(commit) ||
    !/^[0-9a-f]{40,64}$/u.test(tree)
  ) {
    throw new Error("production source anchor received malformed Git identities");
  }

  const sources = trackedSourceReceipts(
    git,
    repoRoot,
    PRODUCTION_SOURCE_ANCHOR_PATHS,
  );
  assertSameFile(node, "production Node executable");
  assertSameGit(git);

  const values = [
    PRODUCTION_SOURCE_ANCHOR_SCHEMA,
    normalizedPath(repoRoot),
    commit,
    tree,
    normalizedPath(git.path),
    normalizedPath(git.realPath),
    git.sha256,
    git.version,
    normalizedPath(git.signature.protectedRoot),
    git.signature.status,
    git.signature.signer,
    git.signature.subject,
    git.signature.thumbprint,
    normalizedPath(node.path),
    normalizedPath(node.realPath),
    node.sha256,
    node.version,
    normalizedPath(node.signature.protectedRoot),
    node.signature.status,
    node.signature.signer,
    node.signature.subject,
    node.signature.thumbprint,
    String(sources.length),
    ...sources.flatMap((source) => [
      source.relativePath,
      source.mode,
      source.objectId,
      source.sha256,
    ]),
  ];
  return {
    schemaVersion: PRODUCTION_SOURCE_ANCHOR_SCHEMA,
    repoRoot,
    commit,
    tree,
    git,
    node,
    sources,
    values,
    digestSha256: productionSourceAnchorDigest(values),
  };
}

if (
  process.argv[1] !== undefined &&
  samePath(process.argv[1], fileURLToPath(import.meta.url)) &&
  process.argv[2] === "__capture-production-source-anchor"
) {
  const repoRoot = process.argv[3];
  const powershellExecutable = process.argv[4];
  if (repoRoot === undefined || powershellExecutable === undefined) {
    throw new Error("production source-anchor CLI arguments are incomplete");
  }
  const anchor = captureProductionSourceAnchor({
    repoRoot,
    nodeExecutable: process.execPath,
    powershellExecutable,
  });
  process.stdout.write(JSON.stringify({
    digestSha256: anchor.digestSha256,
    values: anchor.values,
    repoRoot: anchor.repoRoot,
    commit: anchor.commit,
    tree: anchor.tree,
    git: anchor.git,
    node: anchor.node,
    sources: anchor.sources,
  }));
}
