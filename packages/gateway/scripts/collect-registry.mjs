#!/usr/bin/env node
// GW-1 build-only registry collector.
//
// Runs each legacy MCP server's own `registerTools()` against a collector that
// implements the 13-line `ToolServer` interface those tools already register
// through, and emits a content-hashed registry seed. Nothing here edits, moves,
// or imports a frozen source file: the collector is passed *into* the unmodified
// `registerTools()` exactly as the stdio server passes its real MCP server.
//
// P-GW-3: record (name, description, zodShape, handler identity); never
// serialize a handler function and never make the stdio entry point a
// production dependency.
// P-GW-4: serialize zod -> JSON Schema and emit a content-hashed
// `registry-seed.json`; a schema or handler change must produce a new seed.
//
// The collector deliberately runs inside each legacy package's own dependency
// context (zod 3), not the Gateway's (zod 4). The Gateway consumes only the
// emitted JSON and never imports zod from a legacy tree.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

/**
 * The two collection targets. `expected` is asserted, not discovered: a legacy
 * package that silently gains or loses a tool must fail the build rather than
 * quietly change the Gateway's callable surface.
 */
const SOURCES = [
  {
    module: "runtime",
    packageDir: join(REPO_ROOT, "installer", "runtime-mcp-server"),
    registerPath: join("build", "tools", "register.js"),
    expected: 35,
  },
  {
    module: "docs",
    packageDir: join(REPO_ROOT, "installer", "revit-api-docs-mcp"),
    registerPath: join("build", "tools", "register.js"),
    expected: 5,
  },
];

/**
 * Implements the `ToolServer` interface both legacy servers register through
 * (`src/tools/types.d.ts` in each installer package):
 *   tool(name, paramsSchema, cb)
 *   tool(name, description, paramsSchema, cb)
 */
class RegistryCollector {
  #records = new Map();

  tool(name, second, third, fourth) {
    const hasDescription = typeof second === "string";
    const description = hasDescription ? second : "";
    const paramsSchema = hasDescription ? third : second;
    const handler = hasDescription ? fourth : third;

    if (typeof name !== "string" || name.length === 0) {
      throw new Error("a collected tool must have a non-empty name");
    }
    if (typeof handler !== "function") {
      throw new Error(`tool ${name} registered without a handler function`);
    }
    if (this.#records.has(name)) {
      throw new Error(`tool ${name} was registered twice`);
    }

    this.#records.set(name, {
      name,
      description,
      paramsSchema: paramsSchema ?? {},
    });
    return undefined;
  }

  get records() {
    return [...this.#records.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }
}

function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * Handler identity is the built module that registers the tool, not the
 * function object handed to the collector.
 *
 * `registerTools()` routes every registration through
 * `wrapServerWithTelemetry`, so the callback the collector receives is the same
 * telemetry closure for every tool in a module — hashing it produced one digest
 * for 35 distinct tools and would have made the startup hash check vacuous.
 * The built per-tool module is the artifact the packager pins and startup
 * re-verifies, so that is what the seed records.
 */
function handlerDigestFor(source, toolName) {
  const modulePath = join(
    source.packageDir,
    dirname(source.registerPath),
    `${toolName}.js`,
  );
  return sha256(readFileSync(modulePath, "utf8"));
}

/**
 * RFC 8785-shaped canonical JSON: sorted keys, no insignificant whitespace.
 * The seed digest has to be reproducible across machines and orderings, so the
 * bytes that are hashed are canonical rather than however `JSON.stringify`
 * happened to walk the object.
 */
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

/**
 * Resolves a package's ESM entry from its own `package.json` rather than a
 * guessed path. The two legacy trees ship different zod minors with different
 * layouts (3.24 `lib/index.mjs`, 3.25 `index.js`), so hard-coding either one
 * would silently break the other surface.
 */
async function importFrom(packageDir, packageName) {
  const root = join(packageDir, "node_modules", packageName);
  const manifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const entry =
    pickExport(manifest.exports?.["."]) ?? manifest.module ?? manifest.main;
  if (typeof entry !== "string") {
    throw new Error(`${packageName} has no resolvable ESM entry in ${root}`);
  }
  return import(pathToFileURL(join(root, entry)).href);
}

function pickExport(node) {
  if (typeof node === "string") {
    return node;
  }
  if (node && typeof node === "object") {
    return pickExport(node.import ?? node.default);
  }
  return undefined;
}

/**
 * The converter is a build tool, not part of the registered surface, so one
 * copy may serve both modules. The zod *object* is always built from the
 * surface's own tree.
 */
async function loadZodToJsonSchema(packageDirs) {
  for (const packageDir of packageDirs) {
    try {
      const imported = await importFrom(packageDir, "zod-to-json-schema");
      const convert = imported.zodToJsonSchema ?? imported.default;
      if (typeof convert === "function") {
        return convert;
      }
    } catch {
      // Try the next tree; a hard failure is raised below.
    }
  }
  throw new Error(
    "zod-to-json-schema is not installed in any legacy MCP package tree",
  );
}

async function loadZodObject(packageDir) {
  const imported = await importFrom(packageDir, "zod");
  const z = imported.z ?? imported.default;
  if (!z || typeof z.object !== "function") {
    throw new Error(`zod is not callable from ${packageDir}`);
  }
  return z;
}

async function collectSource(source) {
  const registerUrl = pathToFileURL(
    join(source.packageDir, source.registerPath),
  ).href;
  const { registerTools } = await import(registerUrl);
  if (typeof registerTools !== "function") {
    throw new Error(`${source.module}: registerTools is not exported`);
  }

  const collector = new RegistryCollector();
  await registerTools(collector);

  const records = collector.records;
  if (records.length !== source.expected) {
    throw new Error(
      `${source.module}: expected ${source.expected} tools, collected ${records.length}`,
    );
  }

  const z = await loadZodObject(source.packageDir);
  const zodToJsonSchema = await loadZodToJsonSchema(
    SOURCES.map((item) => item.packageDir),
  );

  return records.map((record) => {
    const jsonSchema = zodToJsonSchema(z.object(record.paramsSchema), {
      $refStrategy: "none",
      target: "jsonSchema2020-12",
    });
    // `$schema` is emitted by the converter; the registry pins its own copy, so
    // dropping it here keeps the seed free of converter-version drift.
    delete jsonSchema.$schema;
    return {
      name: record.name,
      module: source.module,
      description: record.description,
      inputJsonSchema: jsonSchema,
      handlerModule: `${record.name}.js`,
      handlerDigest: handlerDigestFor(source, record.name),
    };
  });
}

async function main() {
  const tools = [];
  for (const source of SOURCES) {
    tools.push(...(await collectSource(source)));
  }
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const names = new Set();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`duplicate tool name across modules: ${tool.name}`);
    }
    names.add(tool.name);
  }

  const body = { seedVersion: 1, tools };
  const seed = { ...body, seedDigest: sha256(canonicalize(body)) };

  const outPath = join(HERE, "..", "registry-seed.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");

  const runtime = tools.filter((t) => t.module === "runtime").length;
  const docs = tools.filter((t) => t.module === "docs").length;
  process.stdout.write(
    `registry seed: ${tools.length} tools (${runtime} runtime, ${docs} docs)\n` +
      `digest: ${seed.seedDigest}\n` +
      `path: ${outPath}\n`,
  );
}

await main();
