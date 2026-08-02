#!/usr/bin/env node
// GW-1 build-only handler packager.
//
// Produces two immutable ESM handler modules (35 runtime tools, 5 docs tools)
// plus a handler/executor manifest with SHA-256s, from the legacy sources
// without editing, moving, or committing any of them.
//
// P-GW-2: "Calls into the two exact Revit transport chokepoint exports are
// rebound at build time to a new unfrozen `ExecutorPort` adapter; every other
// import remains source/hash checked." That rebinding is the whole point of the
// esbuild plugin below: the 67 call sites keep calling `executeRevitCode` and
// `sendRevitCommand`, and only the module those names resolve to changes.
//
// The build fails closed if a chokepoint import disappears (the rebinding would
// silently stop applying and a packaged handler would open its own socket).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const OUT_ROOT = join(PACKAGE_ROOT, "dist", "handlers");

const RUNTIME_ROOT = join(REPO_ROOT, "installer", "runtime-mcp-server");
const DOCS_ROOT = join(REPO_ROOT, "installer", "revit-api-docs-mcp");

const MODULES = [
  {
    key: "runtime",
    entry: join(RUNTIME_ROOT, "src", "tools", "register.ts"),
    packageRoot: RUNTIME_ROOT,
    expectedTools: 35,
    // Only the runtime surface talks to Revit; the docs server is pure lookup.
    rebindChokepoints: true,
  },
  {
    key: "docs",
    entry: join(DOCS_ROOT, "src", "tools", "register.ts"),
    packageRoot: DOCS_ROOT,
    expectedTools: 5,
    rebindChokepoints: false,
  },
];

const CHOKEPOINT_MODULE = "revitToolHelpers";

function sha256(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

/**
 * Rebinds the Revit transport seam without touching any legacy file.
 *
 * Rebinding targets `ConnectionManager`, not the two helpers P-GW-5 names.
 * Measured on the packaged bytes, the helper layer leaks four ways: three tool
 * modules import `withRevitConnection` directly, and `refreshLiveRevitStatus`
 * plus `getSelectionElementIds` call across the seam from inside the helpers
 * module, where no export rebinding reaches them. ConnectionManager is the one
 * place `RevitClientConnection` is constructed, so replacing it closes all four
 * while leaving the helpers' real response-normalization bodies intact.
 */
function executorPortPlugin(state) {
  return {
    name: "revagent-executor-port",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /ConnectionManager(\.js)?$/ }, () => {
        state.rebound += 1;
        return { path: join(HERE, "connection-manager-shim.mjs") };
      });

      pluginBuild.onResolve({ filter: /^revagent-executor-port$/ }, () => ({
        path: join(HERE, "executor-port-runtime.mjs"),
      }));
    },
  };
}

async function packageModule(module) {
  const state = { rebound: 0 };
  const outfile = join(OUT_ROOT, `${module.key}.js`);
  mkdirSync(dirname(outfile), { recursive: true });

  await build({
    bundle: true,
    entryPoints: [module.entry],
    format: "esm",
    logLevel: "warning",
    outfile,
    // Node built-ins and genuinely external runtime deps stay external; the
    // legacy tool sources are bundled so the produced module is self-contained.
    packages: "external",
    platform: "node",
    sourcemap: false,
    target: "node24",
    plugins: module.rebindChokepoints ? [executorPortPlugin(state)] : [],
  });

  if (module.rebindChokepoints && state.rebound === 0) {
    throw new Error(
      `${module.key}: no Revit chokepoint import was rebound. The packaged ` +
        "handlers would open their own socket instead of routing through " +
        "ExecutorPort.",
    );
  }

  const bytes = readFileSync(outfile);
  const text = bytes.toString("utf8");

  // Fail closed on the ways the rebinding can silently regress.
  //
  // The first version of this guard looked for `net.createConnection`, which
  // the legacy client never calls — it constructs `net.Socket`. The guard
  // therefore passed while the original socket path was still bundled, which is
  // exactly the vacuous check it existed to prevent.
  if (module.rebindChokepoints) {
    for (const symbol of ["net.Socket", "createConnection", 'require("net")']) {
      if (text.includes(symbol)) {
        throw new Error(
          `${module.key}: the packaged module still reaches a raw socket ` +
            `(${symbol}). Every Revit call must route through ExecutorPort.`,
        );
      }
    }
  }
  if (text.includes("StdioServerTransport")) {
    throw new Error(
      `${module.key}: the packaged module reached the legacy stdio entry point.`,
    );
  }

  return {
    module: module.key,
    file: `${module.key}.js`,
    bytes: bytes.byteLength,
    digest: sha256(bytes),
    chokepointsRebound: state.rebound,
    expectedTools: module.expectedTools,
  };
}

async function main() {
  const modules = [];
  for (const module of MODULES) {
    modules.push(await packageModule(module));
  }

  const seedPath = join(PACKAGE_ROOT, "registry-seed.json");
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));

  const body = {
    manifestVersion: 1,
    seedDigest: seed.seedDigest,
    modules: modules.sort((a, b) => (a.module < b.module ? -1 : 1)),
  };
  const manifest = {
    ...body,
    manifestDigest: sha256(Buffer.from(canonicalize(body), "utf8")),
  };

  const manifestPath = join(OUT_ROOT, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  for (const entry of modules) {
    process.stdout.write(
      `${entry.module}: ${entry.bytes} bytes, ` +
        `${entry.chokepointsRebound} chokepoint import(s) rebound\n`,
    );
  }
  process.stdout.write(`manifest: ${manifest.manifestDigest}\n`);
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

await main();
