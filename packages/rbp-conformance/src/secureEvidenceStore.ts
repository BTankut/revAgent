import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { canonicalManifest } from "./manifest.js";
import {
  resolvePowerShellIdentity,
  sanitizedProductionRuntimeEnvironment,
  verifyPowerShellIdentityCurrent,
  type ProductionPowerShellIdentity,
} from "./productionRuntimeIdentity.js";
import { resolveWindowsSystemPaths } from "./windowsSystemPaths.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NATIVE_HELPER_TIMEOUT_MS = 15_000;
const MAX_NATIVE_HELPER_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_NATIVE_HELPER_OUTPUT_BYTES = 4 * 1024;
export const MAX_SECURE_EVIDENCE_CONTENT_BYTES = 32 * 1024 * 1024;
export const SECURE_EVIDENCE_LEASE_MS = 10_000;

export type SecureEvidenceTestBoundary =
  | "constructor_baseline_pinned"
  | "directories_pinned"
  | "stage_complete"
  | "publish_complete"
  | "readback_complete"
  | "before_cleanup"
  | "after_verification_before_return"
  | "after_cleanup_before_return"
  | "final_handle_pinned"
  | "lease_verified_before_return";

export interface SecureEvidenceStoreTestOptions {
  readonly boundary?: SecureEvidenceTestBoundary;
  readonly reachedMarker?: string;
  readonly continueMarker?: string;
  readonly timeoutMs?: number;
  readonly helperFault?: "malformed_output" | "unknown_error_code" | "timeout" | "crash" | "cleanup_uncertain";
}

export interface SecureEvidenceStoreOptions {
  /** Deterministic native race/failure synchronization; tests only. */
  readonly test?: SecureEvidenceStoreTestOptions;
  /** Internal caller-owned directory mode used by bounded process evidence. */
  readonly directRootOnly?: boolean;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeWindowsIdentity(value: string): string {
  return value.replace(/^\\\\\?\\/u, "").replace(/[\\/]+$/u, "").toLowerCase();
}

function verifyWindowsControllerRoot(expected: string | null): void {
  if (expected === null) return;
  const current = resolveWindowsSystemPaths()?.windowsRoot ?? null;
  if (current === null || normalizeWindowsIdentity(current) !== normalizeWindowsIdentity(expected)) {
    throw new Error("Windows controller environment changed after identity planning");
  }
}

function boundedContentBytes(contents: string | Buffer): Buffer {
  const length = Buffer.isBuffer(contents) ? contents.length : Buffer.byteLength(contents, "utf8");
  if (length > MAX_SECURE_EVIDENCE_CONTENT_BYTES) throw new Error("secure evidence content exceeds its fixed bound");
  return Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(contents, "utf8");
}

function waitForTestBoundary(test: SecureEvidenceStoreTestOptions | undefined, boundary: SecureEvidenceTestBoundary): void {
  if (test?.boundary !== boundary || test.reachedMarker === undefined || test.continueMarker === undefined) return;
  writeFileSync(test.reachedMarker, boundary, { encoding: "utf8", flag: "wx" });
  const deadline = Date.now() + Math.max(1, test.timeoutMs ?? 2_000);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(test.continueMarker)) {
    if (Date.now() >= deadline) throw new Error("secure evidence test synchronization timed out");
    Atomics.wait(wait, 0, 0, 10);
  }
}

function pinnedDirectoryBaseline(directory: string, test: SecureEvidenceStoreTestOptions | undefined): {
  readonly realPath: string;
  readonly device: bigint;
  readonly inode: bigint;
} {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const pinned = fstatSync(descriptor, { bigint: true });
    if (!pinned.isDirectory()) throw new Error("evidence root is not a directory");
    waitForTestBoundary(test, "constructor_baseline_pinned");
    const lexicalBefore = lstatSync(directory, { bigint: true });
    if (!lexicalBefore.isDirectory() || lexicalBefore.isSymbolicLink() ||
        lexicalBefore.dev !== pinned.dev || lexicalBefore.ino !== pinned.ino) {
      throw new Error("evidence root identity changed during constructor baseline");
    }
    const realPath = realpathSync.native(directory);
    const lexicalAfter = lstatSync(directory, { bigint: true });
    if (!lexicalAfter.isDirectory() || lexicalAfter.isSymbolicLink() ||
        lexicalAfter.dev !== pinned.dev || lexicalAfter.ino !== pinned.ino) {
      throw new Error("evidence root identity changed during constructor baseline");
    }
    const lexicalIdentity = process.platform === "win32"
      ? normalizeWindowsIdentity(directory)
      : path.resolve(directory);
    const realIdentity = process.platform === "win32"
      ? normalizeWindowsIdentity(realPath)
      : realPath;
    if (lexicalIdentity !== realIdentity) throw new Error("evidence root resolves through a substituted directory identity");
    return { realPath, device: pinned.dev, inode: pinned.ino };
  } finally {
    closeSync(descriptor);
  }
}

const WINDOWS_HELPER = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$VerbosePreference='SilentlyContinue'
$DebugPreference='SilentlyContinue'
$WarningPreference='SilentlyContinue'
$InformationPreference='SilentlyContinue'
$source=@'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RevAgentPinnedEvidencePublisher {
  const uint FILE_READ_ATTRIBUTES=0x80, FILE_SHARE_READ=1, FILE_SHARE_WRITE=2, OPEN_EXISTING=3;
  const uint FILE_FLAG_BACKUP_SEMANTICS=0x02000000, FILE_FLAG_OPEN_REPARSE_POINT=0x00200000;
  const uint FILE_ATTRIBUTE_DIRECTORY=0x10, FILE_ATTRIBUTE_REPARSE_POINT=0x400;
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attr; public System.Runtime.InteropServices.ComTypes.FILETIME C1,C2,C3; public uint V1,V2,S1,S2,L1,L2,N1,N2; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,System.Text.StringBuilder b,uint n,uint f);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateHardLinkW(string n,string e,IntPtr x);
  static string Norm(string p) { if(p.StartsWith(@"\\?\"))p=p.Substring(4); return p.TrimEnd('\\').ToLowerInvariant(); }
  static string Final(SafeFileHandle h) { var b=new System.Text.StringBuilder(32768); var n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0); if(n==0||n>=b.Capacity)throw new IOException("FINAL_PATH"); return Norm(b.ToString()); }
  static SafeFileHandle Pin(string p,string expected,string expectedVolume,string expectedFileId) { var h=CreateFileW(p,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,IntPtr.Zero,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,IntPtr.Zero); if(h.IsInvalid)throw new IOException("PIN_FAILED"); Info i; ulong fileId; if(!GetFileInformationByHandle(h,out i)||(i.Attr&FILE_ATTRIBUTE_DIRECTORY)==0||(i.Attr&FILE_ATTRIBUTE_REPARSE_POINT)!=0||Final(h)!=Norm(expected)){h.Dispose();throw new IOException("IDENTITY_CHANGED");} fileId=((ulong)i.L1<<32)|i.L2; if(expectedVolume.Length>0 && (i.V1.ToString()!=expectedVolume || fileId.ToString()!=expectedFileId)){h.Dispose();throw new IOException("IDENTITY_CHANGED");} return h; }
  static Info AssertFile(FileStream stream,string expected,uint expectedLinks) { Info i; if(!GetFileInformationByHandle(stream.SafeFileHandle,out i)||(i.Attr&FILE_ATTRIBUTE_DIRECTORY)!=0||(i.Attr&FILE_ATTRIBUTE_REPARSE_POINT)!=0||Final(stream.SafeFileHandle)!=Norm(expected))throw new IOException("IDENTITY_CHANGED");if(i.S2!=expectedLinks)throw new IOException("LINK_COUNT_CHANGED");return i; }
  static string FileId(FileStream stream) { Info i; if(!GetFileInformationByHandle(stream.SafeFileHandle,out i))throw new IOException("IDENTITY_CHANGED"); return i.V1.ToString()+":"+((((ulong)i.L1)<<32)|i.L2).ToString(); }
  static string Verify(FileStream read,string target,byte[] bytes,uint expectedLinks) { AssertFile(read,target,expectedLinks);if(read.Length!=bytes.Length)throw new IOException("READBACK_MISMATCH");byte[] observed=new byte[bytes.Length];for(int o=0;o<observed.Length;){int n=read.Read(observed,o,observed.Length-o);if(n==0)throw new IOException("READBACK_MISMATCH");o+=n;}int mismatch=0;for(int i=0;i<bytes.Length;i++)mismatch|=bytes[i]^observed[i];if(mismatch!=0)throw new IOException("READBACK_MISMATCH");AssertFile(read,target,expectedLinks);return FileId(read); }
  static void Sync(string selected,string reached,string continued,int timeoutMs,string boundary) { if(selected!=boundary)return; File.WriteAllText(reached,boundary); var until=DateTime.UtcNow.AddMilliseconds(timeoutMs); while(!File.Exists(continued)){if(DateTime.UtcNow>=until)throw new IOException("SYNC_TIMEOUT");System.Threading.Thread.Sleep(10);} }
  public static void Run(string root,string expected,string expectedVolume,string expectedFileId,string[] directories,string operation,string fileName,byte[] bytes,string boundary,string reachedMarker,string continueMarker,int syncTimeoutMs,int helperTimeoutMs,string fault) {
    var held=new List<SafeFileHandle>(); string temp=null; bool published=false;
    try {
      held.Add(Pin(root,expected,expectedVolume,expectedFileId));
      string cursor=root, expectedCursor=expected;
      foreach(string segment in directories){cursor=Path.Combine(cursor,segment);expectedCursor=Path.Combine(expectedCursor,segment);if(!Directory.Exists(cursor))Directory.CreateDirectory(cursor);held.Add(Pin(cursor,expectedCursor,"",""));}
      Sync(boundary,reachedMarker,continueMarker,syncTimeoutMs,"directories_pinned");
      if(fault=="crash")Environment.Exit(73);
      if(fault=="timeout")System.Threading.Thread.Sleep(helperTimeoutMs+5000);
      if(operation=="ensure")return;
      string target=Path.Combine(cursor,fileName); temp=Path.Combine(cursor,"."+fileName+"."+Guid.NewGuid().ToString("N")+".tmp");
      using(var stream=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){AssertFile(stream,temp,1);stream.Write(bytes,0,bytes.Length);stream.Flush(true);AssertFile(stream,temp,1);Sync(boundary,reachedMarker,continueMarker,syncTimeoutMs,"stage_complete");AssertFile(stream,temp,1);if(!CreateHardLinkW(target,temp,IntPtr.Zero)){int e=Marshal.GetLastWin32Error();if(e==183)throw new IOException("EEXIST");throw new IOException("PUBLISH_FAILED");}AssertFile(stream,temp,2);published=true;}
      Sync(boundary,reachedMarker,continueMarker,syncTimeoutMs,"publish_complete");
      string verifiedId; using(var read=new FileStream(target,FileMode.Open,FileAccess.Read,FileShare.Read)){verifiedId=Verify(read,target,bytes,2);}
      Sync(boundary,reachedMarker,continueMarker,syncTimeoutMs,"readback_complete");Sync(boundary,reachedMarker,continueMarker,syncTimeoutMs,"before_cleanup");if(fault=="cleanup_uncertain")throw new IOException("CLEANUP_UNCERTAIN");
      using(var targetBeforeCleanup=new FileStream(target,FileMode.Open,FileAccess.Read,FileShare.Read))using(var tempBeforeCleanup=new FileStream(temp,FileMode.Open,FileAccess.Read,FileShare.Read)){if(Verify(targetBeforeCleanup,target,bytes,2)!=verifiedId||Verify(tempBeforeCleanup,temp,bytes,2)!=verifiedId)throw new IOException("IDENTITY_CHANGED");}
      File.Delete(temp); temp=null;
      Sync(boundary,reachedMarker,continueMarker,syncTimeoutMs,"after_cleanup_before_return");
      Sync(boundary,reachedMarker,continueMarker,syncTimeoutMs,"after_verification_before_return");
      using(var finalRead=new FileStream(target,FileMode.Open,FileAccess.Read,FileShare.Read)){Sync(boundary,reachedMarker,continueMarker,syncTimeoutMs,"final_handle_pinned");if(Verify(finalRead,target,bytes,1)!=verifiedId)throw new IOException("IDENTITY_CHANGED");}
    } finally { foreach(var h in held)h.Dispose(); if(temp!=null && !published){try{File.Delete(temp);}catch{}} }
  }
}
'@
try {
  $phase='input'
  $raw=[Console]::In.ReadToEnd()
  if([Text.Encoding]::UTF8.GetByteCount($raw)-gt ${MAX_NATIVE_HELPER_INPUT_BYTES}){throw 'INPUT_TOO_LARGE'}
  $q=$raw|ConvertFrom-Json
  if($q.fault-eq'malformed_output'){[Console]::Out.Write('{');exit 0}
  if($q.fault-eq'unknown_error_code'){[Console]::Out.Write('{"schema":"revagent-pinned-evidence-helper/v1","status":"error","code":"opaque_error"}');exit 71}
  $phase='compile'
  Add-Type -TypeDefinition $source | Out-Null
  $phase='run'
  [RevAgentPinnedEvidencePublisher]::Run([string]$q.rootPath,[string]$q.expectedRoot,[string]$q.expectedVolume,[string]$q.expectedFileId,[string[]]$q.directories,[string]$q.operation,[string]$q.fileName,[Convert]::FromBase64String([string]$q.contentsBase64),[string]$q.boundary,[string]$q.reachedMarker,[string]$q.continueMarker,[int]$q.syncTimeoutMs,[int]$q.helperTimeoutMs,[string]$q.fault)
  [Console]::Out.Write('{"schema":"revagent-pinned-evidence-helper/v1","status":"ok"}')
  exit 0
} catch {
  $code='operation_failed'
  foreach($known in @('EEXIST','CLEANUP_UNCERTAIN','FINAL_PATH','PIN_FAILED','IDENTITY_CHANGED','LINK_COUNT_CHANGED','SYNC_TIMEOUT','PUBLISH_FAILED','READBACK_MISMATCH')){if($_.Exception.ToString()-match$known){$code=$known}}
  if($code-eq'CLEANUP_UNCERTAIN'){$code='cleanup_uncertain'}
  if($code-eq'operation_failed'){$code='operation_failed'}
  [Console]::Out.Write('{"schema":"revagent-pinned-evidence-helper/v1","status":"error","code":"'+$code+'"}')
  exit 71
}`;

export interface StoredEvidenceFile {
  absolutePath: string;
  bytes: Buffer;
  identityLease: StoredEvidenceIdentityLease;
}

export interface StoredEvidenceIdentityLease {
  readonly expiresAt: string;
  readonly disposed: boolean;
  verify(): void;
  verifyAndDispose(): void;
  dispose(): void;
}

class FileIdentityLease implements StoredEvidenceIdentityLease {
  readonly expiresAt: string;
  #disposed = false;
  readonly #timer: NodeJS.Timeout;

  constructor(
    private readonly descriptor: number,
    private readonly target: string,
    private readonly expectedBytes: Buffer,
    private readonly device: bigint,
    private readonly inode: bigint,
  ) {
    const expiresAtMs = Date.now() + SECURE_EVIDENCE_LEASE_MS;
    this.expiresAt = new Date(expiresAtMs).toISOString();
    this.#timer = setTimeout(() => this.dispose(), SECURE_EVIDENCE_LEASE_MS);
    this.#timer.unref();
  }

  get disposed(): boolean { return this.#disposed; }

  verify(): void {
    if (this.#disposed) throw new Error("secure evidence identity lease is disposed");
    const handleStat = fstatSync(this.descriptor, { bigint: true });
    let lexicalStat;
    try { lexicalStat = lstatSync(this.target, { bigint: true }); } catch { throw new Error("secure evidence leased pathname changed"); }
    if (!handleStat.isFile() || !lexicalStat.isFile() || lexicalStat.isSymbolicLink() ||
        handleStat.dev !== this.device || handleStat.ino !== this.inode || lexicalStat.dev !== this.device || lexicalStat.ino !== this.inode ||
        handleStat.nlink !== 1n || lexicalStat.nlink !== 1n || handleStat.size !== BigInt(this.expectedBytes.length)) {
      throw new Error("secure evidence leased identity changed");
    }
    const observed = Buffer.alloc(this.expectedBytes.length);
    for (let offset = 0; offset < observed.length;) {
      const count = readSync(this.descriptor, observed, offset, observed.length - offset, offset);
      if (count === 0) throw new Error("secure evidence leased readback mismatch");
      offset += count;
    }
    if (!observed.equals(this.expectedBytes)) throw new Error("secure evidence leased readback mismatch");
  }

  verifyAndDispose(): void {
    try { this.verify(); } finally { this.dispose(); }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#timer);
    closeSync(this.descriptor);
  }
}

/** Parent-owned, identity-pinned, atomic no-clobber retained-evidence writer. */
export class SecureEvidenceStore {
  readonly artifactRoot: string;
  readonly retainedRoot: string;
  readonly #artifactRootReal: string;
  readonly #artifactRootDevice: bigint;
  readonly #artifactRootInode: bigint;
  readonly #powerShellIdentity: ProductionPowerShellIdentity | null;
  readonly #windowsControllerRoot: string | null;
  readonly #test: SecureEvidenceStoreTestOptions | undefined;

  constructor(artifactRoot: string, options: SecureEvidenceStoreOptions = {}) {
    this.artifactRoot = path.resolve(artifactRoot);
    if (!existsSync(this.artifactRoot)) mkdirSync(this.artifactRoot, { recursive: true, mode: DIRECTORY_MODE });
    const rootIdentity = pinnedDirectoryBaseline(this.artifactRoot, options.test);
    this.#artifactRootReal = rootIdentity.realPath;
    this.#artifactRootDevice = rootIdentity.device;
    this.#artifactRootInode = rootIdentity.inode;
    this.retainedRoot = path.resolve(this.artifactRoot, canonicalManifest.retainedEvidence.root);
    if (!isInside(this.artifactRoot, this.retainedRoot)) throw new Error("canonical retained evidence root escapes artifactRoot");
    this.#test = options.test;
    this.#windowsControllerRoot = resolveWindowsSystemPaths()?.windowsRoot ?? null;
    this.#powerShellIdentity = process.platform === "win32" ? resolvePowerShellIdentity() : null;
    if (this.#powerShellIdentity !== null && normalizeWindowsIdentity(this.#powerShellIdentity.path) !== normalizeWindowsIdentity(this.#powerShellIdentity.realPath)) {
      throw new Error("canonical PowerShell helper path resolves through a substituted directory identity");
    }
    if (options.directRootOnly !== true) {
      this.#operate(path.relative(this.artifactRoot, this.retainedRoot).split(path.sep), undefined, undefined);
    }
  }

  resolve(relativePath: string): string {
    const normalizedPrefix = `${canonicalManifest.retainedEvidence.root}/`;
    if (path.isAbsolute(relativePath) || !relativePath.replaceAll("\\", "/").startsWith(normalizedPrefix)) {
      throw new Error(`evidence path must remain below ${canonicalManifest.retainedEvidence.root}`);
    }
    const target = path.resolve(this.artifactRoot, relativePath);
    if (!isInside(this.retainedRoot, target)) throw new Error(`evidence path escapes retained root: ${relativePath}`);
    return target;
  }

  write(relativePath: string, contents: string | Buffer): StoredEvidenceFile {
    const bytes = boundedContentBytes(contents);
    const target = this.resolve(relativePath);
    this.#operate(path.relative(this.artifactRoot, path.dirname(target)).split(path.sep), path.basename(target), bytes);
    return this.#leaseResult(target, bytes);
  }

  writeDirect(fileName: string, contents: string | Buffer): StoredEvidenceFile {
    if (path.basename(fileName) !== fileName || fileName === "." || fileName === "..") {
      throw new Error("direct evidence filename must be one plain segment");
    }
    const bytes = boundedContentBytes(contents);
    const target = path.join(this.artifactRoot, fileName);
    this.#operate([], fileName, bytes);
    return this.#leaseResult(target, bytes);
  }

  #leaseResult(target: string, bytes: Buffer): StoredEvidenceFile {
    const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor, { bigint: true });
    const lease = new FileIdentityLease(descriptor, target, Buffer.from(bytes), stat.dev, stat.ino);
    try {
      lease.verify();
      waitForTestBoundary(this.#test, "lease_verified_before_return");
      lease.verify();
      return { absolutePath: target, bytes: Buffer.from(bytes), identityLease: lease };
    } catch (error) {
      lease.dispose();
      throw error;
    }
  }

  #operate(directories: string[], fileName: string | undefined, bytes: Buffer | undefined): void {
    if (directories.some((entry) => entry.length === 0 || entry === "." || entry === ".." || entry.includes("/") || entry.includes("\\"))) {
      throw new Error("evidence directory segment is invalid");
    }
    if (process.platform === "win32") this.#operateWindows(directories, fileName, bytes);
    else this.#operatePosix(directories, fileName, bytes);
  }

  #operateWindows(directories: string[], fileName: string | undefined, bytes: Buffer | undefined): void {
    if (this.#powerShellIdentity === null) throw new Error("canonical PowerShell helper identity is unavailable");
    verifyWindowsControllerRoot(this.#windowsControllerRoot);
    const identity = verifyPowerShellIdentityCurrent(this.#powerShellIdentity);
    const helperTimeoutMs = Math.max(1, this.#test?.timeoutMs ?? NATIVE_HELPER_TIMEOUT_MS);
    const input = Buffer.from(JSON.stringify({
      operation: fileName === undefined ? "ensure" : "write",
      rootPath: this.artifactRoot,
      expectedRoot: this.#artifactRootReal,
      expectedVolume: this.#artifactRootDevice.toString(),
      expectedFileId: this.#artifactRootInode.toString(),
      directories,
      fileName: fileName ?? "",
      contentsBase64: bytes?.toString("base64") ?? "",
      boundary: this.#test?.boundary ?? "",
      reachedMarker: this.#test?.reachedMarker ?? "",
      continueMarker: this.#test?.continueMarker ?? "",
      syncTimeoutMs: helperTimeoutMs,
      helperTimeoutMs,
      fault: this.#test?.helperFault ?? "",
    }), "utf8");
    if (input.length > MAX_NATIVE_HELPER_INPUT_BYTES) throw new Error("secure evidence helper input exceeds its fixed bound");
    const result = spawnSync(identity.realPath, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(WINDOWS_HELPER, "utf16le").toString("base64"),
    ], {
      input,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: helperTimeoutMs,
      maxBuffer: MAX_NATIVE_HELPER_OUTPUT_BYTES,
      env: sanitizedProductionRuntimeEnvironment(process.env, {
        SystemRoot: this.#windowsControllerRoot ?? undefined,
        WINDIR: this.#windowsControllerRoot ?? undefined,
      }),
    });
    if (result.error !== undefined) throw new Error("secure evidence native helper failed or exceeded its fixed bound", { cause: result.error });
    if (Buffer.byteLength(result.stdout, "utf8") > MAX_NATIVE_HELPER_OUTPUT_BYTES) {
      throw new Error("secure evidence native helper violated its output contract");
    }
    let response: unknown;
    try { response = JSON.parse(result.stdout) as unknown; } catch { throw new Error("secure evidence native helper returned malformed protocol"); }
    const record = response as { schema?: unknown; status?: unknown; code?: unknown };
    if (record.schema !== "revagent-pinned-evidence-helper/v1" || !["ok", "error"].includes(String(record.status))) {
      throw new Error("secure evidence native helper returned malformed protocol");
    }
    if (result.stderr.length !== 0 && record.status === "ok") {
      throw new Error("secure evidence native helper violated its output contract");
    }
    if (result.status !== 0 || record.status !== "ok") {
      if (!["EEXIST", "cleanup_uncertain", "operation_failed", "FINAL_PATH", "PIN_FAILED", "IDENTITY_CHANGED", "LINK_COUNT_CHANGED", "SYNC_TIMEOUT", "PUBLISH_FAILED", "READBACK_MISMATCH"].includes(String(record.code))) {
        throw new Error("secure evidence native helper returned an unknown error code");
      }
      if (record.code === "EEXIST") {
        const error = new Error("evidence target already exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      if (record.code === "cleanup_uncertain") throw new Error("secure evidence publication cleanup is uncertain");
      throw new Error(`secure evidence native helper failed closed (${String(record.code)})`);
    }
  }

  #operatePosix(directories: string[], fileName: string | undefined, bytes: Buffer | undefined): void {
    const fdRoot = "/proc/self/fd";
    if (!existsSync(fdRoot)) throw new Error("fd-relative secure evidence operations are unavailable on this platform");
    const held: number[] = [];
    let temporary: string | undefined;
    try {
      let descriptor = openSync(this.artifactRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      held.push(descriptor);
      const rootStat = fstatSync(descriptor, { bigint: true });
      if (!rootStat.isDirectory() || rootStat.dev !== this.#artifactRootDevice || rootStat.ino !== this.#artifactRootInode || realpathSync.native(path.join(fdRoot, String(descriptor))) !== this.#artifactRootReal) {
        throw new Error("evidence root identity changed during operation");
      }
      let expected = this.#artifactRootReal;
      for (const segment of directories) {
        const candidate = path.join(fdRoot, String(descriptor), segment);
        if (!existsSync(candidate)) mkdirSync(candidate, { mode: DIRECTORY_MODE });
        const child = openSync(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        held.push(child);
        expected = path.join(expected, segment);
        if (!fstatSync(child).isDirectory() || realpathSync.native(path.join(fdRoot, String(child))) !== expected) {
          throw new Error("evidence directory identity changed during operation");
        }
        chmodSync(path.join(fdRoot, String(child)), DIRECTORY_MODE);
        descriptor = child;
      }
      waitForTestBoundary(this.#test, "directories_pinned");
      if (fileName === undefined || bytes === undefined) return;
      const directory = path.join(fdRoot, String(descriptor));
      const target = path.join(directory, fileName);
      temporary = path.join(directory, `.${fileName}.${randomUUID()}.tmp`);
      const file = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE);
      try { writeFileSync(file, bytes); fsyncSync(file); } finally { closeSync(file); }
      chmodSync(temporary, FILE_MODE);
      waitForTestBoundary(this.#test, "stage_complete");
      linkSync(temporary, target);
      waitForTestBoundary(this.#test, "publish_complete");
      const read = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      let publishedDevice = -1n;
      let publishedInode = -1n;
      try {
        const stat = fstatSync(read, { bigint: true });
        if (!stat.isFile() || stat.size !== BigInt(bytes.length)) throw new Error("secure evidence readback mismatch");
        publishedDevice = stat.dev;
        publishedInode = stat.ino;
        const observed = Buffer.alloc(bytes.length);
        for (let offset = 0; offset < observed.length;) {
          const count = readSync(read, observed, offset, observed.length - offset, null);
          if (count === 0) throw new Error("secure evidence readback mismatch");
          offset += count;
        }
        if (!observed.equals(bytes)) throw new Error("secure evidence readback mismatch");
      } finally { closeSync(read); }
      waitForTestBoundary(this.#test, "readback_complete");
      waitForTestBoundary(this.#test, "before_cleanup");
      let identityCurrent = false;
      try {
        identityCurrent = realpathSync.native(path.join(fdRoot, String(held.at(-1)))) === expected &&
          realpathSync.native(path.join(fdRoot, String(held.at(0)))) === this.#artifactRootReal;
      } catch { /* a vanished lexical identity is fail-closed */ }
      if (!identityCurrent) {
        try { rmSync(target); } catch { /* fail closed below */ }
        throw new Error("evidence directory identity changed after validation");
      }
      if (this.#test?.helperFault === "cleanup_uncertain") throw new Error("secure evidence publication cleanup is uncertain");
      rmSync(temporary);
      temporary = undefined;
      waitForTestBoundary(this.#test, "after_cleanup_before_return");
      waitForTestBoundary(this.#test, "after_verification_before_return");
      const finalRead = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        waitForTestBoundary(this.#test, "final_handle_pinned");
        const assertFinalPathIdentity = (): void => {
          const handleStat = fstatSync(finalRead, { bigint: true });
          let lexicalStat;
          try { lexicalStat = lstatSync(target, { bigint: true }); } catch { throw new Error("secure evidence final pathname changed"); }
          if (!handleStat.isFile() || !lexicalStat.isFile() || lexicalStat.isSymbolicLink() ||
              handleStat.dev !== publishedDevice || handleStat.ino !== publishedInode ||
              lexicalStat.dev !== handleStat.dev || lexicalStat.ino !== handleStat.ino ||
              handleStat.nlink !== 1n || lexicalStat.nlink !== 1n || handleStat.size !== BigInt(bytes.length)) {
            throw new Error("secure evidence final pathname identity changed");
          }
        };
        assertFinalPathIdentity();
        const finalStat = fstatSync(finalRead, { bigint: true });
        if (!finalStat.isFile() || finalStat.dev !== publishedDevice || finalStat.ino !== publishedInode || finalStat.size !== BigInt(bytes.length)) {
          throw new Error("secure evidence final identity changed");
        }
        const finalBytes = Buffer.alloc(bytes.length);
        for (let offset = 0; offset < finalBytes.length;) {
          const count = readSync(finalRead, finalBytes, offset, finalBytes.length - offset, null);
          if (count === 0) throw new Error("secure evidence final readback mismatch");
          offset += count;
        }
        if (!finalBytes.equals(bytes)) throw new Error("secure evidence final readback mismatch");
        assertFinalPathIdentity();
      } finally { closeSync(finalRead); }
      fsyncSync(descriptor);
    } finally {
      if (temporary !== undefined) {
        try { rmSync(temporary); } catch { /* caller receives the original fail-closed error */ }
      }
      for (const descriptor of held.reverse()) closeSync(descriptor);
    }
  }
}
