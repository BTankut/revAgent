import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EntitledCatalogView,
  buildCatalog,
  entitleAll,
  entitleOnly,
} from "./entitledRegistry.js";
import {
  GATEWAY_O6_MODULE_MANIFEST_SCHEMA,
  PHASE1_INSTRUCTION_VERSION,
  GatewayInstructionPackageError,
  buildGatewayInstructionPackage,
  gatewayClientInstructions,
} from "./instructionPackage.js";
import { verifyRegistrySeed } from "./registrySeed.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = buildCatalog(
  verifyRegistrySeed(
    JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "registry-seed.json"), "utf8"),
    ) as unknown,
  ),
);
const fullView = new EntitledCatalogView(catalog, entitleAll);

describe("GW-19 instruction and O6 module package", () => {
  it("records every entitled tool with its policy and exact executor binding", () => {
    const instructionPackage = buildGatewayInstructionPackage(fullView);

    expect(instructionPackage.instructionVersion).toBe(
      PHASE1_INSTRUCTION_VERSION,
    );
    expect(instructionPackage.modules).toHaveLength(1);
    const core = instructionPackage.modules[0]!;
    expect(core.manifest).toMatchObject({
      schemaVersion: GATEWAY_O6_MODULE_MANIFEST_SCHEMA,
      module: "core",
      moduleVersion: PHASE1_INSTRUCTION_VERSION,
    });
    expect(core.manifest.tools).toHaveLength(41);
    for (const entry of fullView.entries()) {
      expect(core.manifest.tools).toContainEqual({
        name: entry.name,
        version: entry.version,
        policyClass: entry.policyClass,
        executor: entry.executor,
        executorMethod: entry.tool,
      });
    }
    expect(core.manifest.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(core.manifestBytes.endsWith("\n")).toBe(true);
  });

  it("is byte-stable even when entitled catalog rows arrive in reverse order", () => {
    const forward = buildGatewayInstructionPackage(fullView);
    const reverse = buildGatewayInstructionPackage({
      entries: () => [...fullView.entries()].reverse(),
    });

    expect(reverse.modules[0]!.manifestBytes).toBe(
      forward.modules[0]!.manifestBytes,
    );
    expect(reverse.modules[0]!.instruction).toEqual(
      forward.modules[0]!.instruction,
    );
  });

  it("derives module visibility and audit bytes from the entitled view only", () => {
    const subset = new EntitledCatalogView(
      catalog,
      entitleOnly(["core.ui.state", "core.docs.search"]),
    );
    const full = buildGatewayInstructionPackage(fullView).modules[0]!;
    const restricted = buildGatewayInstructionPackage(subset).modules[0]!;

    expect(restricted.manifest.tools.map((tool) => tool.name)).toEqual([
      "core.docs.search",
      "core.ui.state",
    ]);
    expect(restricted.manifestBytes).not.toContain("core.code.execute");
    expect(restricted.manifest.entitlementDigest).not.toBe(
      full.manifest.entitlementDigest,
    );
    expect(
      buildGatewayInstructionPackage(
        new EntitledCatalogView(catalog, entitleOnly([])),
      ).modules,
    ).toEqual([]);
  });

  it("pins instruction versions independently from tool schemas", () => {
    expect(() => buildGatewayInstructionPackage(fullView, "0.9.0")).toThrow(
      GatewayInstructionPackageError,
    );
    try {
      buildGatewayInstructionPackage(fullView, "0.9.0");
    } catch (error) {
      expect((error as GatewayInstructionPackageError).code).toBe(
        "instruction_version_unavailable",
      );
    }
    expect(fullView.get("core.ui.state")?.version).toBe("1.0.0");
  });

  it("publishes the Phase-1 external-client and resource boundaries", () => {
    const instructionPackage = buildGatewayInstructionPackage(fullView);
    const instructions = gatewayClientInstructions(instructionPackage);

    expect(instructions).toContain("remote, published tool names");
    expect(instructions).toContain("external MCP client owns");
    expect(instructions).toContain("server-issued confirmation token");
    expect(instructions).toContain("revagent://artifact");
    expect(instructions).toContain("does not run a model");
    expect(instructions).toContain(
      instructionPackage.modules[0]!.instruction.uri,
    );
    expect(instructions).toContain(
      instructionPackage.modules[0]!.manifestUri,
    );
  });
});
