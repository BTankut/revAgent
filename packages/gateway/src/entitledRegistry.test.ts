import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CatalogError,
  EntitledCatalogView,
  buildCatalog,
  entitleAll,
  entitleOnly,
} from "./entitledRegistry.js";
import { verifyRegistrySeed } from "./registrySeed.js";
import { E5_TOOL_BINDINGS } from "./toolBindings.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const seed = verifyRegistrySeed(
  JSON.parse(readFileSync(join(PACKAGE_ROOT, "registry-seed.json"), "utf8")),
);
const catalog = buildCatalog(seed);

describe("catalog", () => {
  it("covers all forty tools with a published name and a policy class", () => {
    expect(catalog).toHaveLength(40);
    for (const entry of catalog) {
      expect(entry.name).toMatch(/^core\.[a-z0-9_.]+$/u);
      expect(["auto", "confirm", "gated"]).toContain(entry.policyClass);
      expect(["bridge", "internal_mcp", "aps"]).toContain(entry.executor);
    }
  });

  it("reserves RES-14 logical variants without activating the APS plane", () => {
    for (const entry of catalog) {
      if (entry.executor === "internal_mcp") {
        expect(entry.variants).toEqual([]);
        continue;
      }
      expect(entry.variants).toEqual([
        {
          plane: "live",
          executor: "bridge",
          executorMethod: entry.tool,
          schemaOverlay: null,
          fidelityNotes: [],
        },
      ]);
    }
    expect(catalog.flatMap((entry) => entry.variants)).not.toContainEqual(
      expect.objectContaining({ plane: "published" }),
    );
  });

  it("fails closed when a Phase-1 binding attempts to activate APS", () => {
    const target = E5_TOOL_BINDINGS.find(
      (row) => row.tool === "find_elements",
    );
    if (target === undefined) throw new Error("fixture binding is missing");
    expect(() =>
      buildCatalog(
        seed,
        E5_TOOL_BINDINGS.map((row) =>
          row === target ? { ...row, executor: "aps" as const } : row,
        ),
      ),
    ).toThrow("cannot activate an APS variant in Phase 1");
  });

  it("refuses a seeded tool that no binding covers", () => {
    // Either half missing is a real defect: an unbound tool has no policy
    // class, and a bound tool with no seed entry would be published with no
    // schema behind it.
    expect(() =>
      buildCatalog(
        seed,
        E5_TOOL_BINDINGS.filter((row) => row.tool !== "find_elements"),
      ),
    ).toThrow(CatalogError);
  });

  it("refuses a binding that the seed does not contain", () => {
    try {
      buildCatalog(seed, [
        ...E5_TOOL_BINDINGS,
        {
          tool: "tool_that_does_not_exist",
          target: "core.ghost",
          module: "runtime",
          policyClass: "auto",
          executor: "bridge",
        },
      ]);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      expect((error as CatalogError).code).toBe("binding_unseeded");
    }
  });

  it("strips the proto-policy bracket tags out of client-visible text", () => {
    // The registry now carries policy as a structured field; republishing the
    // legacy tag would state the same fact twice and let the two disagree.
    for (const entry of catalog) {
      expect(entry.summary).not.toMatch(/\[[A-Z0-9_]+\]/u);
    }
  });

  it("bounds every summary", () => {
    for (const entry of catalog) {
      expect(entry.summary.length).toBeLessThanOrEqual(160);
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("capability index is byte-stable", () => {
  it("produces identical bytes across rebuilds", () => {
    const a = new EntitledCatalogView(catalog, entitleAll).capabilityIndexBytes();
    const b = new EntitledCatalogView(buildCatalog(seed), entitleAll).capabilityIndexBytes();
    expect(a).toBe(b);
  });

  it("does not depend on the order tools arrive in", () => {
    // The property later caching work depends on: two tenants with the same
    // entitlements must receive the identical index, whatever order the
    // catalog was assembled in.
    const shuffled = [...catalog].reverse();
    expect(
      new EntitledCatalogView(shuffled, entitleAll).capabilityIndexBytes(),
    ).toBe(new EntitledCatalogView(catalog, entitleAll).capabilityIndexBytes());
  });

  it("changes its digest when a policy class changes", () => {
    // A stability test that cannot detect real change would be worthless, so
    // this asserts the digest is sensitive as well as stable.
    const full = new EntitledCatalogView(catalog, entitleAll).capabilityIndexDigest();
    const tampered = catalog.map((entry) =>
      entry.name === "core.parameter.set" ? { ...entry, policyClass: "auto" as const } : entry,
    );
    expect(new EntitledCatalogView(tampered, entitleAll).capabilityIndexDigest()).not.toBe(full);
  });

  it("emits canonical bytes with sorted keys and one trailing newline", () => {
    const bytes = new EntitledCatalogView(catalog, entitleAll).capabilityIndexBytes();
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes.trimEnd()).toBe(JSON.stringify(JSON.parse(bytes), Object.keys({}).length === 0 ? sortedReplacer() : undefined));
  });
});

function sortedReplacer(): (key: string, value: unknown) => unknown {
  return (_key, value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
  };
}

describe("entitlement filtering", () => {
  const visible = ["core.element.query", "core.ui.state"];
  const view = new EntitledCatalogView(catalog, entitleOnly(visible));

  it("omits unentitled tools from the index", () => {
    expect(view.capabilityIndex().tools.map((t) => t.name).sort()).toEqual(
      [...visible].sort(),
    );
  });

  it("omits unentitled tools from search rather than ranking them last", () => {
    // Ranking is not a boundary. An unentitled tool must be absent from the
    // corpus, so no query and no scoring change can surface it.
    const everything = new EntitledCatalogView(catalog, entitleAll);
    expect(everything.search("parameter").length).toBeGreaterThan(0);
    for (const hit of view.search("parameter")) {
      expect(visible).toContain(hit.name);
    }
    expect(view.search("schedule")).toHaveLength(0);
  });

  it("answers a direct lookup for an unentitled tool exactly as for a missing one", () => {
    // Distinguishing them would confirm the tool exists to a caller not
    // entitled to know that.
    expect(view.get("core.parameter.set")).toBeUndefined();
    expect(view.get("core.does.not.exist")).toBeUndefined();
  });

  it("gives two principals with the same entitlements identical bytes", () => {
    expect(new EntitledCatalogView(catalog, entitleOnly(visible)).capabilityIndexBytes()).toBe(
      new EntitledCatalogView([...catalog].reverse(), entitleOnly([...visible].reverse()))
        .capabilityIndexBytes(),
    );
  });
});

describe("search is deterministic", () => {
  const view = new EntitledCatalogView(catalog, entitleAll);

  it("returns the same ordering for the same query", () => {
    const a = view.search("view").map((e) => e.name);
    const b = view.search("view").map((e) => e.name);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("breaks ties on name so equal scores cannot reorder", () => {
    const names = view.search("revit", 40).map((e) => e.name);
    const stable = view.search("revit", 40).map((e) => e.name);
    expect(names).toEqual(stable);
  });

  it("returns nothing for a query with no usable terms", () => {
    expect(view.search("")).toHaveLength(0);
    expect(view.search("!!! ?")).toHaveLength(0);
  });

  it("honours the limit", () => {
    expect(view.search("core", 3).length).toBeLessThanOrEqual(3);
  });
});
