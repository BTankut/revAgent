import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION =
  "revagent.m4-preproduction-credentials/v1" as const;

export const PRE_PRODUCTION_CREDENTIAL_PERMISSION_POLICY =
  "posix-owner-read-only-0400" as const;

const MAX_CREDENTIAL_FILE_BYTES = 16 * 1_024;
const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 4_096;

const CREDENTIAL_FIELDS = Object.freeze([
  "contractVersion",
  "profile",
  "mode",
  "northBearerToken",
  "identityTokenKey",
  "requestStateHmacKey",
] as const);

type CredentialField = (typeof CREDENTIAL_FIELDS)[number];

export const PRE_PRODUCTION_CREDENTIAL_FILE_ERROR_REASONS = Object.freeze([
  "invalid_path",
  "unsupported_platform",
  "file_unavailable",
  "symlink_refused",
  "not_regular_file",
  "path_not_canonical",
  "owner_mismatch",
  "invalid_permissions",
  "invalid_link_count",
  "invalid_size",
  "changed_during_read",
  "invalid_encoding",
  "malformed_document",
  "duplicate_field",
  "unknown_field",
  "missing_field",
  "unsupported_contract_version",
  "invalid_profile",
  "invalid_mode",
  "invalid_secret",
  "duplicate_secret",
] as const);

export type PreProductionCredentialFileErrorReason =
  (typeof PRE_PRODUCTION_CREDENTIAL_FILE_ERROR_REASONS)[number];

export const PRE_PRODUCTION_CREDENTIAL_FILE_ERROR_MESSAGES: Readonly<
  Record<PreProductionCredentialFileErrorReason, string>
> = Object.freeze({
  invalid_path: "credential file path must be absolute and normalized",
  unsupported_platform:
    "credential file permissions require a supported POSIX platform",
  file_unavailable: "credential file could not be read safely",
  symlink_refused: "credential file must not be a symbolic link",
  not_regular_file: "credential file must be a regular file",
  path_not_canonical:
    "credential file path must not traverse a symbolic-link ancestor",
  owner_mismatch: "credential file must be owned by the current user",
  invalid_permissions: "credential file must have exact mode 0400",
  invalid_link_count: "credential file must have exactly one hard link",
  invalid_size: "credential file size is outside the accepted range",
  changed_during_read: "credential file changed while it was being read",
  invalid_encoding: "credential file must be canonical UTF-8 text",
  malformed_document: "credential file must be a flat JSON string object",
  duplicate_field: "credential file contains a duplicate field",
  unknown_field: "credential file contains an unknown field",
  missing_field: "credential file is missing a required field",
  unsupported_contract_version:
    "credential file contract version is not supported",
  invalid_profile: "credential file requires the LAN/test profile",
  invalid_mode: "credential file requires explicit pre-production mode",
  invalid_secret: "credential file contains an invalid secret",
  duplicate_secret: "credential file secrets must be independent",
});

export class PreProductionCredentialFileError extends Error {
  readonly code = "preproduction_credential_file_refused" as const;

  constructor(readonly reason: PreProductionCredentialFileErrorReason) {
    super(PRE_PRODUCTION_CREDENTIAL_FILE_ERROR_MESSAGES[reason]);
    this.name = "PreProductionCredentialFileError";
    Object.freeze(this);
  }
}

export interface PreProductionCredentialMaterial {
  readonly contractVersion: typeof PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION;
  readonly profile: "lan_test";
  readonly mode: "preproduction";
  readonly northAuthorization: `Bearer ${string}`;
  readonly identityTokenKey: string;
  readonly requestStateHmacKey: string;
}

export interface PreProductionCredentialFileStat {
  readonly file: boolean;
  readonly symbolicLink: boolean;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface PreProductionCredentialFileHandle {
  stat(): Promise<PreProductionCredentialFileStat>;
  readFile(): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Injectable so Windows CI proves every POSIX refusal path instead of skipping it. */
export interface PreProductionCredentialFileIo {
  readonly platform: NodeJS.Platform;
  currentUid(): number | null;
  isAbsolute(filePath: string): boolean;
  resolve(filePath: string): string;
  lstat(filePath: string): Promise<PreProductionCredentialFileStat>;
  realpath(filePath: string): Promise<string>;
  open(
    filePath: string,
    flags: number,
  ): Promise<PreProductionCredentialFileHandle>;
}

function snapshot(value: Stats): PreProductionCredentialFileStat {
  return Object.freeze({
    file: value.isFile(),
    symbolicLink: value.isSymbolicLink(),
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    nlink: value.nlink,
    uid: value.uid,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  });
}

const NODE_CREDENTIAL_FILE_IO: PreProductionCredentialFileIo = Object.freeze({
  platform: process.platform,
  currentUid: () =>
    typeof process.getuid === "function" ? process.getuid() : null,
  isAbsolute,
  resolve,
  lstat: async (filePath: string) => snapshot(await lstat(filePath)),
  realpath,
  open: async (filePath: string, flags: number) => {
    const handle = await open(filePath, flags);
    return Object.freeze({
      stat: async () => snapshot(await handle.stat()),
      readFile: async () => handle.readFile(),
      close: async () => handle.close(),
    });
  },
});

function refused(reason: PreProductionCredentialFileErrorReason): never {
  throw new PreProductionCredentialFileError(reason);
}

async function safeFileCall<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch {
    return refused("file_unavailable");
  }
}

function validateStat(
  value: PreProductionCredentialFileStat,
  currentUid: number,
): void {
  if (value.symbolicLink) {
    refused("symlink_refused");
  }
  if (!value.file) {
    refused("not_regular_file");
  }
  if (value.uid !== currentUid) {
    refused("owner_mismatch");
  }
  if ((value.mode & 0o7777) !== 0o400) {
    refused("invalid_permissions");
  }
  if (value.nlink !== 1) {
    refused("invalid_link_count");
  }
  if (
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > MAX_CREDENTIAL_FILE_BYTES
  ) {
    refused("invalid_size");
  }
}

function sameFileState(
  left: PreProductionCredentialFileStat,
  right: PreProductionCredentialFileStat,
): boolean {
  return (
    left.file === right.file &&
    left.symbolicLink === right.symbolicLink &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readCredentialBytes(
  filePath: string,
  io: PreProductionCredentialFileIo,
): Promise<Uint8Array> {
  if (!io.isAbsolute(filePath) || io.resolve(filePath) !== filePath) {
    refused("invalid_path");
  }
  if (io.platform === "win32") {
    refused("unsupported_platform");
  }
  const currentUid = io.currentUid();
  if (currentUid === null) {
    refused("unsupported_platform");
  }

  const initial = await safeFileCall(() => io.lstat(filePath));
  validateStat(initial, currentUid);
  const canonicalPath = await safeFileCall(() => io.realpath(filePath));
  if (canonicalPath !== filePath) {
    refused("path_not_canonical");
  }

  const handle = await safeFileCall(() =>
    io.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW),
  );
  let bytes: Uint8Array | null = null;
  let failure: unknown = null;

  try {
    const beforeRead = await safeFileCall(() => handle.stat());
    validateStat(beforeRead, currentUid);
    if (!sameFileState(initial, beforeRead)) {
      refused("changed_during_read");
    }

    bytes = await safeFileCall(() => handle.readFile());
    const afterRead = await safeFileCall(() => handle.stat());
    validateStat(afterRead, currentUid);
    if (
      !sameFileState(beforeRead, afterRead) ||
      bytes.byteLength !== afterRead.size
    ) {
      refused("changed_during_read");
    }
    const canonicalPathAfterRead = await safeFileCall(() =>
      io.realpath(filePath),
    );
    if (canonicalPathAfterRead !== filePath) {
      refused("path_not_canonical");
    }
  } catch (error: unknown) {
    failure =
      error instanceof PreProductionCredentialFileError
        ? error
        : new PreProductionCredentialFileError("file_unavailable");
  }

  try {
    await handle.close();
  } catch {
    failure ??= new PreProductionCredentialFileError("file_unavailable");
  }

  if (failure !== null) {
    throw failure;
  }
  if (bytes === null) {
    return refused("file_unavailable");
  }
  return bytes;
}

function decodeCredentialDocument(bytes: Uint8Array): string {
  if (
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    bytes.includes(0)
  ) {
    refused("invalid_encoding");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refused("invalid_encoding");
  }
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (
    text[cursor] === " " ||
    text[cursor] === "\t" ||
    text[cursor] === "\r" ||
    text[cursor] === "\n"
  ) {
    cursor += 1;
  }
  return cursor;
}

function parseJsonString(
  text: string,
  start: number,
): readonly [value: string, next: number] {
  if (text[start] !== '"') {
    return refused("malformed_document");
  }
  let escaped = false;
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      const token = text.slice(start, cursor + 1);
      try {
        const value: unknown = JSON.parse(token);
        if (typeof value !== "string") {
          return refused("malformed_document");
        }
        return Object.freeze([value, cursor + 1] as const);
      } catch {
        return refused("malformed_document");
      }
    }
    if (character === undefined || character.charCodeAt(0) < 0x20) {
      return refused("malformed_document");
    }
  }
  return refused("malformed_document");
}

function parseFlatStringObject(text: string): ReadonlyMap<string, string> {
  let cursor = skipWhitespace(text, 0);
  if (text[cursor] !== "{") {
    return refused("malformed_document");
  }
  cursor = skipWhitespace(text, cursor + 1);
  const fields = new Map<string, string>();

  if (text[cursor] === "}") {
    cursor = skipWhitespace(text, cursor + 1);
    if (cursor !== text.length) {
      return refused("malformed_document");
    }
    return fields;
  }

  while (cursor < text.length) {
    const [key, afterKey] = parseJsonString(text, cursor);
    if (fields.has(key)) {
      return refused("duplicate_field");
    }
    cursor = skipWhitespace(text, afterKey);
    if (text[cursor] !== ":") {
      return refused("malformed_document");
    }
    cursor = skipWhitespace(text, cursor + 1);
    const [value, afterValue] = parseJsonString(text, cursor);
    fields.set(key, value);
    cursor = skipWhitespace(text, afterValue);
    if (text[cursor] === "}") {
      cursor = skipWhitespace(text, cursor + 1);
      if (cursor !== text.length) {
        return refused("malformed_document");
      }
      return fields;
    }
    if (text[cursor] !== ",") {
      return refused("malformed_document");
    }
    cursor = skipWhitespace(text, cursor + 1);
  }
  return refused("malformed_document");
}

function requiredField(
  fields: ReadonlyMap<string, string>,
  name: CredentialField,
): string {
  const value = fields.get(name);
  return value === undefined ? refused("missing_field") : value;
}

function isValidSecret(value: string): boolean {
  return (
    value.length >= MIN_SECRET_LENGTH &&
    value.length <= MAX_SECRET_LENGTH &&
    [...value].every((character) => character >= "!" && character <= "~")
  );
}

function parseCredentialMaterial(
  text: string,
): PreProductionCredentialMaterial {
  const fields = parseFlatStringObject(text);
  const allowedFields: ReadonlySet<string> = new Set(CREDENTIAL_FIELDS);
  if ([...fields.keys()].some((field) => !allowedFields.has(field))) {
    refused("unknown_field");
  }
  if (CREDENTIAL_FIELDS.some((field) => !fields.has(field))) {
    refused("missing_field");
  }

  if (
    requiredField(fields, "contractVersion") !==
    PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION
  ) {
    refused("unsupported_contract_version");
  }
  if (requiredField(fields, "profile") !== "lan_test") {
    refused("invalid_profile");
  }
  if (requiredField(fields, "mode") !== "preproduction") {
    refused("invalid_mode");
  }

  const northBearerToken = requiredField(fields, "northBearerToken");
  const identityTokenKey = requiredField(fields, "identityTokenKey");
  const requestStateHmacKey = requiredField(fields, "requestStateHmacKey");
  const secrets = [
    northBearerToken,
    identityTokenKey,
    requestStateHmacKey,
  ] as const;
  if (secrets.some((secret) => !isValidSecret(secret))) {
    refused("invalid_secret");
  }
  if (new Set(secrets).size !== secrets.length) {
    refused("duplicate_secret");
  }

  return Object.freeze({
    contractVersion: PRE_PRODUCTION_CREDENTIAL_FILE_CONTRACT_VERSION,
    profile: "lan_test" as const,
    mode: "preproduction" as const,
    northAuthorization: `Bearer ${northBearerToken}` as const,
    identityTokenKey,
    requestStateHmacKey,
  });
}

/**
 * Loads one explicit LAN/test credential file without opening a listener,
 * selecting a host, or changing the production Gateway entry point.
 */
export async function loadPreProductionCredentialFile(
  filePath: string,
  io: PreProductionCredentialFileIo = NODE_CREDENTIAL_FILE_IO,
): Promise<PreProductionCredentialMaterial> {
  const bytes = await readCredentialBytes(filePath, io);
  return parseCredentialMaterial(decodeCredentialDocument(bytes));
}
