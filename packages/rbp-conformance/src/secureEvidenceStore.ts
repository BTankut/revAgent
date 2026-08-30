import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { createInterface } from "node:readline";

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
  | "lease_verified_before_return"
  | "posix_linked_before_unlink"
  | "consumer_accepted_before_commit";

export interface SecureEvidenceStoreTestOptions {
  readonly boundary?: SecureEvidenceTestBoundary;
  readonly reachedMarker?: string;
  readonly continueMarker?: string;
  readonly timeoutMs?: number;
  readonly helperFault?: "malformed_output" | "invalid_ready" | "unknown_error_code" | "timeout" | "crash" | "cleanup_uncertain" | "initial_write_failure" | "commit_write_failure" | "abort_write_failure";
  readonly lifecycle?: { leasesOpened: number; leasesDisposed: number; helpersSpawned: number; helpersClosed: number };
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

function evidenceError(code: string, message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function beforeDeadline<T>(promise: Promise<T>, deadlineMs: number, onTimeout: () => void): Promise<T> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    onTimeout();
    throw evidenceError("EVIDENCE_DISPOSAL_FAILED", "evidence lifecycle deadline expired");
  }
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(evidenceError("EVIDENCE_DISPOSAL_FAILED", "evidence lifecycle deadline expired"));
    }, remaining);
    void promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
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
using System.Security.Cryptography;
using System.Threading.Tasks;
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
  static string Verify(FileStream read,string target,byte[] bytes,uint expectedLinks) { AssertFile(read,target,expectedLinks);if(read.Length!=bytes.Length)throw new IOException("READBACK_MISMATCH");read.Position=0;byte[] observed=new byte[bytes.Length];for(int o=0;o<observed.Length;){int n=read.Read(observed,o,observed.Length-o);if(n==0)throw new IOException("READBACK_MISMATCH");o+=n;}int mismatch=0;for(int i=0;i<bytes.Length;i++)mismatch|=bytes[i]^observed[i];if(mismatch!=0)throw new IOException("READBACK_MISMATCH");AssertFile(read,target,expectedLinks);return FileId(read); }
  static void CheckDeadline(long deadlineUnixMs) { if(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()>=deadlineUnixMs)throw new IOException("HELPER_DEADLINE"); }
  static string Sha256(byte[] bytes) { using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(); }
  static void Sync(string selected,string reached,string continued,int timeoutMs,string boundary) { if(selected!=boundary)return; File.WriteAllText(reached,boundary); var until=DateTime.UtcNow.AddMilliseconds(timeoutMs); while(!File.Exists(continued)){if(DateTime.UtcNow>=until)throw new IOException("SYNC_TIMEOUT");System.Threading.Thread.Sleep(10);} }
  public static void Run(string root,string expected,string expectedVolume,string expectedFileId,string[] directories,string operation,string fileName,byte[] bytes,string boundary,string reachedMarker,string continueMarker,int syncTimeoutMs,int helperTimeoutMs,string fault,long deadlineUnixMs) {
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
      using(var finalRead=new FileStream(target,FileMode.Open,FileAccess.Read,FileShare.Read)){
        Sync(boundary,reachedMarker,continueMarker,syncTimeoutMs,"final_handle_pinned");if(Verify(finalRead,target,bytes,1)!=verifiedId)throw new IOException("IDENTITY_CHANGED");
        CheckDeadline(deadlineUnixMs);Info finalInfo=AssertFile(finalRead,target,1);string nonce=Guid.NewGuid().ToString("N");ulong finalFileId=((ulong)finalInfo.L1<<32)|finalInfo.L2;
        Console.Out.WriteLine("{\"schema\":\"revagent-pinned-evidence-helper/v2\",\"status\":\"READY\",\"nonce\":\""+nonce+"\",\"volumeSerialNumber\":\""+finalInfo.V1.ToString()+"\",\"fileId\":\""+finalFileId.ToString()+"\",\"nlink\":1,\"byteLength\":"+bytes.Length.ToString()+",\"sha256\":\""+Sha256(bytes)+"\"}");Console.Out.Flush();
        int remaining=(int)Math.Max(1,Math.Min(Int32.MaxValue,deadlineUnixMs-DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));var controlTask=Task.Run(()=>Console.In.ReadLine());if(!controlTask.Wait(remaining))throw new IOException("HELPER_DEADLINE");string control=controlTask.Result;
        if(control=="COMMIT "+nonce){CheckDeadline(deadlineUnixMs);Verify(finalRead,target,bytes,1);Console.Out.WriteLine("{\"schema\":\"revagent-pinned-evidence-helper/v2\",\"status\":\"COMMITTED\",\"nonce\":\""+nonce+"\"}");Console.Out.Flush();}
        else if(control=="ABORT "+nonce){Verify(finalRead,target,bytes,1);Console.Out.WriteLine("{\"schema\":\"revagent-pinned-evidence-helper/v2\",\"status\":\"ABORTED\",\"nonce\":\""+nonce+"\"}");Console.Out.Flush();}
        else throw new IOException("CONTROL_PROTOCOL");
      }
    } finally { foreach(var h in held)h.Dispose(); if(temp!=null && !published){try{File.Delete(temp);}catch{}} }
  }
}
'@
try {
  $phase='input'
  $raw=[Console]::In.ReadLine()
  if([Text.Encoding]::UTF8.GetByteCount($raw)-gt ${MAX_NATIVE_HELPER_INPUT_BYTES}){throw 'INPUT_TOO_LARGE'}
  $q=$raw|ConvertFrom-Json
  if($q.fault-eq'malformed_output'){[Console]::Out.Write('{');exit 0}
  if($q.fault-eq'invalid_ready'){[Console]::Out.WriteLine('{"schema":"revagent-pinned-evidence-helper/v2","status":"READY","nonce":"invalid"}');exit 0}
  if($q.fault-eq'unknown_error_code'){[Console]::Out.Write('{"schema":"revagent-pinned-evidence-helper/v1","status":"error","code":"opaque_error"}');exit 71}
  $phase='compile'
  Add-Type -TypeDefinition $source | Out-Null
  $phase='run'
  [RevAgentPinnedEvidencePublisher]::Run([string]$q.rootPath,[string]$q.expectedRoot,[string]$q.expectedVolume,[string]$q.expectedFileId,[string[]]$q.directories,[string]$q.operation,[string]$q.fileName,[Convert]::FromBase64String([string]$q.contentsBase64),[string]$q.boundary,[string]$q.reachedMarker,[string]$q.continueMarker,[int]$q.syncTimeoutMs,[int]$q.helperTimeoutMs,[string]$q.fault,[long]$q.deadlineUnixMs)
  if($q.operation-eq'ensure'){[Console]::Out.Write('{"schema":"revagent-pinned-evidence-helper/v1","status":"ok"}')}
  exit 0
} catch {
  $code='operation_failed'
  foreach($known in @('EEXIST','CLEANUP_UNCERTAIN','FINAL_PATH','PIN_FAILED','IDENTITY_CHANGED','LINK_COUNT_CHANGED','SYNC_TIMEOUT','PUBLISH_FAILED','READBACK_MISMATCH')){if($_.Exception.ToString()-match$known){$code=$known}}
  if($code-eq'CLEANUP_UNCERTAIN'){$code='cleanup_uncertain'}
  if($code-eq'operation_failed'){$code='operation_failed'}
  [Console]::Out.Write('{"schema":"revagent-pinned-evidence-helper/v1","status":"error","code":"'+$code+'"}')
  exit 71
}`;

const acceptedEvidenceBrand: unique symbol = Symbol("accepted-evidence");

export interface AcceptedEvidence<T> {
  readonly [acceptedEvidenceBrand]: T;
}

export interface EvidenceConsumerBinding {
  readonly logicalPath: string;
  readonly absolutePath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

export type PublishedEvidenceIdentity = Readonly<{
  platform: "win32";
  volumeSerialNumber: string;
  fileId: string;
  nlink: 1;
  byteLength: number;
  sha256: string;
}> | Readonly<{
  platform: "posix";
  device: string;
  inode: string;
  nlink: 1;
  byteLength: number;
  sha256: string;
}>;

export interface LeasedEvidenceCandidate {
  readonly logicalPath: string;
  readonly absolutePath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  acceptExact<T>(expected: EvidenceConsumerBinding, value: T): AcceptedEvidence<T>;
}

export type VerifiedEvidenceConsumer<T> =
  (candidate: LeasedEvidenceCandidate) => AcceptedEvidence<T> | Promise<AcceptedEvidence<T>>;

class AcceptedEvidenceToken<T> implements AcceptedEvidence<T> {
  readonly [acceptedEvidenceBrand]: T;
  constructor(readonly leaseId: object, value: T) { this[acceptedEvidenceBrand] = value; }
}

class FileIdentityLease {
  #disposed = false;

  constructor(
    private readonly descriptor: number,
    private readonly target: string,
    private readonly expectedBytes: Buffer,
    private readonly device: bigint,
    private readonly inode: bigint,
    private readonly onDispose: () => void,
  ) {
  }

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

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try { closeSync(this.descriptor); } finally { this.onDispose(); }
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
  #acceptanceBoundaryConsumed = false;

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

  async writeAccepted<T>(
    relativePath: string,
    contents: string | Buffer,
    consume: VerifiedEvidenceConsumer<T>,
  ): Promise<T> {
    if (typeof consume !== "function") throw evidenceError("EVIDENCE_ACCEPTOR_REQUIRED", "evidence acceptor is required");
    const bytes = boundedContentBytes(contents);
    const target = this.resolve(relativePath);
    if (process.platform === "win32") {
      return await this.#writeWindowsAccepted(relativePath, target, path.relative(this.artifactRoot, path.dirname(target)).split(path.sep), path.basename(target), bytes, consume);
    }
    return await this.#writePosixAccepted(relativePath, target, path.relative(this.artifactRoot, path.dirname(target)).split(path.sep), path.basename(target), bytes, consume);
  }

  async writeDirectAccepted<T>(
    fileName: string,
    contents: string | Buffer,
    consume: VerifiedEvidenceConsumer<T>,
  ): Promise<T> {
    if (typeof consume !== "function") throw evidenceError("EVIDENCE_ACCEPTOR_REQUIRED", "evidence acceptor is required");
    if (path.basename(fileName) !== fileName || fileName === "." || fileName === "..") {
      throw new Error("direct evidence filename must be one plain segment");
    }
    const bytes = boundedContentBytes(contents);
    const target = path.join(this.artifactRoot, fileName);
    if (process.platform === "win32") return await this.#writeWindowsAccepted(fileName, target, [], fileName, bytes, consume);
    return await this.#writePosixAccepted(fileName, target, [], fileName, bytes, consume);
  }

  async #acceptPublished<T>(
    logicalPath: string,
    target: string,
    bytes: Buffer,
    consume: VerifiedEvidenceConsumer<T>,
    expectedIdentity?: PublishedEvidenceIdentity,
    finalizePublisher?: (accepted: boolean) => Promise<void>,
    publishedDescriptor?: number,
    deadlineMs: number = Date.now() + NATIVE_HELPER_TIMEOUT_MS,
  ): Promise<T> {
    const descriptor = publishedDescriptor ?? openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor, { bigint: true });
    if (this.#test?.lifecycle !== undefined) this.#test.lifecycle.leasesOpened += 1;
    const lease = new FileIdentityLease(descriptor, target, Buffer.from(bytes), stat.dev, stat.ino, () => {
      if (this.#test?.lifecycle !== undefined) this.#test.lifecycle.leasesDisposed += 1;
    });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expectedIdentity !== undefined) {
      const matches = expectedIdentity.platform === "win32"
        ? stat.dev.toString() === expectedIdentity.volumeSerialNumber && stat.ino.toString() === expectedIdentity.fileId
        : stat.dev.toString() === expectedIdentity.device && stat.ino.toString() === expectedIdentity.inode;
      if (!matches || stat.nlink !== 1n || stat.size !== BigInt(expectedIdentity.byteLength) || sha256 !== expectedIdentity.sha256) {
        let abortError: unknown;
        try { await finalizePublisher?.(false); } catch (error) { abortError = error; }
        finally { lease.dispose(); }
        const mismatch = evidenceError("EVIDENCE_PUBLISHED_IDENTITY_MISMATCH", "published evidence identity mismatch");
        if (abortError !== undefined) {
          throw evidenceError("EVIDENCE_CONSUMER_AND_LEASE_FAILED", "evidence consumer and lease both failed", new AggregateError([mismatch, abortError]));
        }
        throw mismatch;
      }
    }
    const leaseId = Object.freeze({});
    const binding = Object.freeze({ logicalPath, absolutePath: target, bytes: Buffer.from(bytes), sha256 });
    const candidate: LeasedEvidenceCandidate = Object.freeze({
      logicalPath,
      absolutePath: target,
      bytes: Buffer.from(bytes),
      sha256,
      acceptExact: <TValue>(expected: EvidenceConsumerBinding, value: TValue): AcceptedEvidence<TValue> => {
        if (expected.logicalPath !== binding.logicalPath || expected.absolutePath !== binding.absolutePath ||
            expected.sha256 !== binding.sha256 || !Buffer.isBuffer(expected.bytes) || !expected.bytes.equals(binding.bytes)) {
          throw evidenceError("EVIDENCE_CONSUMER_BINDING_MISMATCH", "evidence consumer binding mismatch");
        }
        return new AcceptedEvidenceToken(leaseId, value);
      },
    });
    let primaryError: unknown;
    let accepted: AcceptedEvidenceToken<T> | undefined;
    try {
      lease.verify();
      if (!this.#acceptanceBoundaryConsumed && this.#test?.boundary === "lease_verified_before_return") {
        this.#acceptanceBoundaryConsumed = true;
        waitForTestBoundary(this.#test, "lease_verified_before_return");
      }
      lease.verify();
      const value = await beforeDeadline(Promise.resolve(consume(candidate)), deadlineMs, () => undefined);
      if (!(value instanceof AcceptedEvidenceToken) || value.leaseId !== leaseId) {
        throw evidenceError("EVIDENCE_ACCEPTANCE_REQUIRED", "exact evidence acceptance is required");
      }
      accepted = value;
      if (this.#test?.boundary === "consumer_accepted_before_commit") {
        waitForTestBoundary(this.#test, "consumer_accepted_before_commit");
      }
    } catch (error) {
      primaryError = error;
    }
    let finalError: unknown;
    try {
      lease.verify();
      await finalizePublisher?.(primaryError === undefined && accepted !== undefined);
      lease.verify();
    } catch (error) {
      finalError = error;
    } finally {
      try { lease.dispose(); } catch (error) { finalError ??= error; }
    }
    if (primaryError !== undefined && finalError !== undefined) {
      throw evidenceError("EVIDENCE_CONSUMER_AND_LEASE_FAILED", "evidence consumer and lease both failed", new AggregateError([primaryError, finalError]));
    }
    if (primaryError !== undefined) throw primaryError;
    if (finalError !== undefined) throw evidenceError("EVIDENCE_IDENTITY_CHANGED", "evidence identity changed", finalError);
    if (accepted === undefined) throw evidenceError("EVIDENCE_ACCEPTANCE_REQUIRED", "exact evidence acceptance is required");
    return accepted[acceptedEvidenceBrand];
  }

  async #writeWindowsAccepted<T>(
    logicalPath: string,
    target: string,
    directories: string[],
    fileName: string,
    bytes: Buffer,
    consume: VerifiedEvidenceConsumer<T>,
  ): Promise<T> {
    if (this.#powerShellIdentity === null || this.#windowsControllerRoot === null) {
      throw evidenceError("EVIDENCE_DISPOSAL_FAILED", "bound Windows helper identity is unavailable");
    }
    verifyWindowsControllerRoot(this.#windowsControllerRoot);
    const identity = verifyPowerShellIdentityCurrent(this.#powerShellIdentity);
    const timeoutMs = Math.max(1, this.#test?.timeoutMs ?? NATIVE_HELPER_TIMEOUT_MS);
    const lifecycleDeadlineMs = Date.now() + timeoutMs;
    const helperJoinReserveMs = Math.min(
      Math.max(0, timeoutMs - 1),
      Math.min(1_000, Math.max(1, Math.floor(timeoutMs / 2))),
    );
    const deadlineMs = lifecycleDeadlineMs - helperJoinReserveMs;
    const request = Buffer.from(`${JSON.stringify({
      operation: "write",
      rootPath: this.artifactRoot,
      expectedRoot: this.#artifactRootReal,
      expectedVolume: this.#artifactRootDevice.toString(),
      expectedFileId: this.#artifactRootInode.toString(),
      directories,
      fileName,
      contentsBase64: bytes.toString("base64"),
      boundary: this.#test?.boundary ?? "",
      reachedMarker: this.#test?.reachedMarker ?? "",
      continueMarker: this.#test?.continueMarker ?? "",
      syncTimeoutMs: timeoutMs,
      helperTimeoutMs: timeoutMs,
      fault: this.#test?.helperFault ?? "",
      deadlineUnixMs: deadlineMs,
    })}\n`, "utf8");
    if (request.length > MAX_NATIVE_HELPER_INPUT_BYTES) throw new Error("secure evidence helper input exceeds its fixed bound");
    const child = spawn(identity.realPath, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(WINDOWS_HELPER, "utf16le").toString("base64"),
    ], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: sanitizedProductionRuntimeEnvironment(process.env, {
        SystemRoot: this.#windowsControllerRoot,
        WINDIR: this.#windowsControllerRoot,
      }),
    }) as ChildProcessWithoutNullStreams;
    if (this.#test?.lifecycle !== undefined) this.#test.lifecycle.helpersSpawned += 1;
    let stderrObserved = false;
    let stdinError: Error | undefined;
    child.stderr.on("data", () => { stderrObserved = true; });
    child.stdin.on("error", (error) => { stdinError = error; });
    let helperClosed = false;
    const exit = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        helperClosed = true;
        if (this.#test?.lifecycle !== undefined) this.#test.lifecycle.helpersClosed += 1;
        resolve(code ?? 1);
      });
    });
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    let helperStopRequested = false;
    const stopHelper = (): void => {
      if (helperStopRequested) return;
      helperStopRequested = true;
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    const nextRecord = async (): Promise<Record<string, unknown>> => {
      const next = await beforeDeadline(reader.next(), deadlineMs, stopHelper);
      if (next.done || typeof next.value !== "string" || Buffer.byteLength(next.value, "utf8") > MAX_NATIVE_HELPER_OUTPUT_BYTES) {
        throw evidenceError("EVIDENCE_DISPOSAL_FAILED", "evidence helper protocol ended unexpectedly");
      }
      let parsed: unknown;
      try { parsed = JSON.parse(next.value) as unknown; } catch { throw evidenceError("EVIDENCE_DISPOSAL_FAILED", "evidence helper protocol is malformed"); }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw evidenceError("EVIDENCE_DISPOSAL_FAILED", "evidence helper protocol is malformed");
      return parsed as Record<string, unknown>;
    };
    const writeInput = async (value: string | Buffer): Promise<void> => {
      if (Date.now() >= deadlineMs) throw evidenceError("EVIDENCE_DISPOSAL_FAILED", "evidence helper input deadline expired");
      if (stdinError !== undefined) throw stdinError;
      await beforeDeadline(new Promise<void>((resolve, reject) => {
        child.stdin.write(value, (error) => error == null ? resolve() : reject(error));
      }), deadlineMs, stopHelper);
      if (stdinError !== undefined) throw stdinError;
    };
    try {
      if (this.#test?.helperFault === "initial_write_failure") child.stdin.destroy();
      await writeInput(request);
      const ready = await nextRecord();
    if (ready.schema === "revagent-pinned-evidence-helper/v1" && ready.status === "error") {
      const exitCode = await beforeDeadline(exit, lifecycleDeadlineMs, stopHelper);
      if (ready.code === "EEXIST" && exitCode === 71) {
        const error = evidenceError("EEXIST", "evidence target already exists");
        throw error;
      }
      if (ready.code === "cleanup_uncertain") throw new Error("secure evidence publication cleanup is uncertain");
      throw evidenceError("EVIDENCE_DISPOSAL_FAILED", `evidence helper failed before READY (${String(ready.code ?? "unknown")})`);
    }
    if (ready.schema !== "revagent-pinned-evidence-helper/v2" || ready.status !== "READY" ||
        typeof ready.nonce !== "string" || !/^[a-f0-9]{32}$/u.test(ready.nonce) ||
        typeof ready.volumeSerialNumber !== "string" || !/^[0-9]+$/u.test(ready.volumeSerialNumber) ||
        typeof ready.fileId !== "string" || !/^[0-9]+$/u.test(ready.fileId) || ready.nlink !== 1 ||
        ready.byteLength !== bytes.length || typeof ready.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(ready.sha256) ||
        Object.keys(ready).sort().join(",") !== "byteLength,fileId,nlink,nonce,schema,sha256,status,volumeSerialNumber") {
      stopHelper();
      throw evidenceError("EVIDENCE_DISPOSAL_FAILED", "evidence helper READY protocol is invalid");
    }
      const nonce = ready.nonce;
      const published: PublishedEvidenceIdentity = Object.freeze({
      platform: "win32",
      volumeSerialNumber: ready.volumeSerialNumber,
      fileId: ready.fileId,
      nlink: 1,
      byteLength: bytes.length,
      sha256: ready.sha256,
    });
      const finalize = async (accepted: boolean): Promise<void> => {
      if (child.stdin.destroyed) throw evidenceError("EVIDENCE_DISPOSAL_FAILED", "evidence helper control channel is closed");
      if ((accepted && this.#test?.helperFault === "commit_write_failure") ||
          (!accepted && this.#test?.helperFault === "abort_write_failure")) child.stdin.destroy();
      await writeInput(`${accepted ? "COMMIT" : "ABORT"} ${nonce}\n`);
      const final = await nextRecord();
      const expectedStatus = accepted ? "COMMITTED" : "ABORTED";
      if (final.schema !== "revagent-pinned-evidence-helper/v2" || final.status !== expectedStatus || final.nonce !== nonce ||
          Object.keys(final).sort().join(",") !== "nonce,schema,status") {
        throw evidenceError("EVIDENCE_DISPOSAL_FAILED", `evidence helper final protocol is invalid (${String(final.status)}:${String(final.code ?? "none")})`);
      }
      child.stdin.end();
      const exitCode = await beforeDeadline(exit, lifecycleDeadlineMs, stopHelper);
      if (exitCode !== 0 || stderrObserved) throw evidenceError("EVIDENCE_DISPOSAL_FAILED", "evidence helper exit is not clean");
      };
      return await this.#acceptPublished(logicalPath, target, bytes, consume, published, finalize, undefined, deadlineMs);
    } finally {
      if (!helperClosed) stopHelper();
      try {
        await beforeDeadline(exit, lifecycleDeadlineMs, stopHelper);
      } catch (error) {
        throw evidenceError(
          "EVIDENCE_HELPER_REAP_UNCERTAIN",
          "evidence helper reap is uncertain at the fixed lifecycle deadline",
          error,
        );
      }
    }
  }

  async #writePosixAccepted<T>(
    logicalPath: string,
    absoluteTarget: string,
    directories: string[],
    fileName: string,
    bytes: Buffer,
    consume: VerifiedEvidenceConsumer<T>,
  ): Promise<T> {
    const fdRoot = "/proc/self/fd";
    if (!existsSync(fdRoot)) throw new Error("fd-relative secure evidence operations are unavailable on this platform");
    const held: number[] = [];
    const deadlineMs = Date.now() + Math.max(1, this.#test?.timeoutMs ?? NATIVE_HELPER_TIMEOUT_MS);
    let temporary: string | undefined;
    let finalDescriptor: number | undefined;
    try {
      let directoryDescriptor = openSync(this.artifactRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      held.push(directoryDescriptor);
      const rootStat = fstatSync(directoryDescriptor, { bigint: true });
      if (!rootStat.isDirectory() || rootStat.dev !== this.#artifactRootDevice || rootStat.ino !== this.#artifactRootInode) {
        throw evidenceError("EVIDENCE_IDENTITY_CHANGED", "evidence root identity changed");
      }
      for (const segment of directories) {
        const candidate = path.join(fdRoot, String(directoryDescriptor), segment);
        if (!existsSync(candidate)) mkdirSync(candidate, { mode: DIRECTORY_MODE });
        const child = openSync(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        held.push(child);
        if (!fstatSync(child).isDirectory()) throw evidenceError("EVIDENCE_IDENTITY_CHANGED", "evidence directory identity changed");
        chmodSync(path.join(fdRoot, String(child)), DIRECTORY_MODE);
        directoryDescriptor = child;
      }
      waitForTestBoundary(this.#test, "directories_pinned");
      const directory = path.join(fdRoot, String(directoryDescriptor));
      const target = path.join(directory, fileName);
      temporary = path.join(directory, `.${fileName}.${randomUUID()}.tmp`);
      const staged = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, FILE_MODE);
      finalDescriptor = staged;
      writeFileSync(staged, bytes);
      fsyncSync(staged);
      const stagedIdentity = fstatSync(staged, { bigint: true });
      if (!stagedIdentity.isFile() || stagedIdentity.nlink !== 1n || stagedIdentity.size !== BigInt(bytes.length)) {
        throw evidenceError("EVIDENCE_IDENTITY_CHANGED", "staged POSIX identity changed");
      }
      chmodSync(temporary, FILE_MODE);
      waitForTestBoundary(this.#test, "stage_complete");
      linkSync(temporary, target);
      const linkedIdentity = fstatSync(staged, { bigint: true });
      if (linkedIdentity.dev !== stagedIdentity.dev || linkedIdentity.ino !== stagedIdentity.ino || linkedIdentity.nlink !== 2n) {
        throw evidenceError("EVIDENCE_IDENTITY_CHANGED", "linked POSIX identity changed");
      }
      waitForTestBoundary(this.#test, "posix_linked_before_unlink");
      waitForTestBoundary(this.#test, "publish_complete");
      rmSync(temporary);
      temporary = undefined;
      const publishedIdentity = fstatSync(staged, { bigint: true });
      if (publishedIdentity.dev !== stagedIdentity.dev || publishedIdentity.ino !== stagedIdentity.ino || publishedIdentity.nlink !== 1n) {
        throw evidenceError("EVIDENCE_IDENTITY_CHANGED", "published POSIX identity changed");
      }
      waitForTestBoundary(this.#test, "after_cleanup_before_return");
      const publishedStat = fstatSync(finalDescriptor, { bigint: true });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const published: PublishedEvidenceIdentity = Object.freeze({
        platform: "posix",
        device: publishedStat.dev.toString(),
        inode: publishedStat.ino.toString(),
        nlink: 1,
        byteLength: bytes.length,
        sha256,
      });
      const verifyPublisher = async (): Promise<void> => {
        if (finalDescriptor === undefined) throw evidenceError("EVIDENCE_DISPOSAL_FAILED", "published descriptor is unavailable");
        const handleStat = fstatSync(finalDescriptor, { bigint: true });
        const lexicalStat = lstatSync(absoluteTarget, { bigint: true });
        if (!handleStat.isFile() || !lexicalStat.isFile() || lexicalStat.isSymbolicLink() ||
            handleStat.dev.toString() !== published.device || handleStat.ino.toString() !== published.inode ||
            lexicalStat.dev !== handleStat.dev || lexicalStat.ino !== handleStat.ino || handleStat.nlink !== 1n || lexicalStat.nlink !== 1n ||
            handleStat.size !== BigInt(bytes.length)) throw evidenceError("EVIDENCE_IDENTITY_CHANGED", "published POSIX identity changed");
        const observed = Buffer.alloc(bytes.length);
        for (let offset = 0; offset < observed.length;) {
          const count = readSync(finalDescriptor, observed, offset, observed.length - offset, offset);
          if (count === 0) throw evidenceError("EVIDENCE_IDENTITY_CHANGED", "published POSIX readback changed");
          offset += count;
        }
        if (!observed.equals(bytes)) throw evidenceError("EVIDENCE_IDENTITY_CHANGED", "published POSIX readback changed");
        fsyncSync(directoryDescriptor);
      };
      const result = await this.#acceptPublished(logicalPath, absoluteTarget, bytes, consume, published, verifyPublisher, finalDescriptor, deadlineMs);
      finalDescriptor = undefined; // ownership was disposed by #acceptPublished
      return result;
    } finally {
      if (finalDescriptor !== undefined) try { closeSync(finalDescriptor); } catch { /* primary error wins */ }
      if (temporary !== undefined) try { rmSync(temporary); } catch { /* primary error wins */ }
      for (const descriptor of held.reverse()) closeSync(descriptor);
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
