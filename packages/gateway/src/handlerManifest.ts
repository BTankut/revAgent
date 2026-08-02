import { createHash } from "node:crypto";

/**
 * Startup verification for the packaged handler modules (GW-1 / P-GW-2).
 *
 * The registry seed says which tools exist; this says the code behind them is
 * the code the packager produced. Both are needed: a verified seed paired with
 * a swapped handler module would present a correct tool list backed by
 * arbitrary code, and every tool in the runtime module reaches Revit.
 *
 * Verification is fail-closed and total -- one bad module refuses the whole
 * manifest rather than disabling that module, because a Gateway serving a
 * partial tool set silently is worse than one that does not start.
 */
export interface HandlerManifestModule {
  readonly module: string;
  readonly file: string;
  readonly bytes: number;
  readonly digest: string;
  /**
   * How many Revit transport imports the packager rebound to `ExecutorPort`.
   *
   * Re-asserted here rather than trusted from build time: this is the field a
   * hand-edited manifest would zero out to describe a socket-carrying module as
   * acceptable.
   */
  readonly chokepointsRebound: number;
  readonly expectedTools: number;
}

export interface HandlerManifest {
  readonly manifestVersion: 1;
  /** Ties these modules to one registry seed; a mismatch refuses both. */
  readonly seedDigest: string;
  readonly modules: readonly HandlerManifestModule[];
  readonly manifestDigest: string;
}

export class HandlerManifestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HandlerManifestError";
  }
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/** Modules that talk to Revit and therefore must carry a rebound transport. */
const TRANSPORT_BEARING_MODULES: ReadonlySet<string> = new Set(["runtime"]);

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fail(code: string, message: string): never {
  throw new HandlerManifestError(code, message);
}

export interface VerifyHandlerManifestOptions {
  /** Digest of the already-verified registry seed these modules must match. */
  readonly seedDigest: string;
  /** Returns the bytes actually on disk for a manifest entry's `file`. */
  readonly readModule: (file: string) => Uint8Array;
}

/**
 * Verifies a manifest and the bytes it describes, or throws.
 *
 * Module bytes are supplied by the caller rather than read here so the check
 * runs against whatever the loader is really about to import -- verifying a
 * path this function opened itself would leave a window between the check and
 * the load.
 */
export function verifyHandlerManifest(
  raw: unknown,
  options: VerifyHandlerManifestOptions,
): HandlerManifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("manifest_not_an_object", "The handler manifest is not an object.");
  }
  const candidate = raw as Record<string, unknown>;

  if (candidate.manifestVersion !== 1) {
    fail(
      "manifest_version_unsupported",
      `Unsupported handler manifest version ${String(candidate.manifestVersion)}.`,
    );
  }

  const declaredDigest = candidate.manifestDigest;
  if (typeof declaredDigest !== "string" || !SHA256_PATTERN.test(declaredDigest)) {
    fail("manifest_digest_malformed", "The manifest digest is not a sha256 value.");
  }

  const body = { ...candidate };
  delete body.manifestDigest;
  const recomputed = sha256(Buffer.from(canonicalize(body), "utf8"));
  if (recomputed !== declaredDigest) {
    fail(
      "manifest_digest_mismatch",
      `The handler manifest digest is ${declaredDigest} but its content hashes to ${recomputed}.`,
    );
  }

  if (candidate.seedDigest !== options.seedDigest) {
    fail(
      "manifest_seed_mismatch",
      `The handler manifest was built for seed ${String(candidate.seedDigest)}, ` +
        `but the verified seed is ${options.seedDigest}.`,
    );
  }

  const modules = candidate.modules;
  if (!Array.isArray(modules) || modules.length === 0) {
    fail("manifest_modules_empty", "The handler manifest lists no modules.");
  }

  const seen = new Set<string>();
  for (const entry of modules as readonly HandlerManifestModule[]) {
    if (seen.has(entry.module)) {
      fail(
        "manifest_module_duplicate",
        `The handler manifest lists module ${entry.module} more than once.`,
      );
    }
    seen.add(entry.module);

    if (
      TRANSPORT_BEARING_MODULES.has(entry.module) &&
      !(entry.chokepointsRebound > 0)
    ) {
      fail(
        "manifest_transport_not_rebound",
        `Module ${entry.module} reaches Revit but declares no rebound transport ` +
          "import; its handlers would open their own socket.",
      );
    }

    const bytes = options.readModule(entry.file);
    if (bytes.byteLength !== entry.bytes) {
      fail(
        "module_size_mismatch",
        `Module ${entry.module} is ${bytes.byteLength} bytes on disk but the ` +
          `manifest declares ${entry.bytes}.`,
      );
    }

    const actual = sha256(bytes);
    if (actual !== entry.digest) {
      fail(
        "module_digest_mismatch",
        `Module ${entry.module} hashes to ${actual} but the manifest declares ${entry.digest}.`,
      );
    }
  }

  return candidate as unknown as HandlerManifest;
}
