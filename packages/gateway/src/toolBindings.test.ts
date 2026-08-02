import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_CODE_TOOL,
  E5_CONFIRM_CLASS_TOOLS,
  E5_TOOL_BINDINGS,
  ToolBindingError,
  verifyToolBindings,
  type ToolBindingRow,
} from "./toolBindings.js";
import { verifyRegistrySeed } from "./registrySeed.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function expectRejection(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolBindingError);
    expect((error as ToolBindingError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}, but nothing threw`);
}

function mutate(
  tool: string,
  patch: Partial<ToolBindingRow>,
): readonly ToolBindingRow[] {
  return E5_TOOL_BINDINGS.map((row) => (row.tool === tool ? { ...row, ...patch } : row));
}

describe("E5 tool binding map", () => {
  it("accepts the shipped mapping", () => {
    expect(() => verifyToolBindings()).not.toThrow();
  });

  it("covers exactly the tools the collector actually found", () => {
    // The mapping and the seed are produced by different means -- one
    // transcribed from the spec, one collected from the legacy sources. Cross
    // checking them is what catches a tool that exists but was never mapped, or
    // a mapped tool that no longer exists.
    const seed = verifyRegistrySeed(
      JSON.parse(readFileSync(join(PACKAGE_ROOT, "registry-seed.json"), "utf8")),
    );
    const seeded = seed.tools.map((t) => t.name).sort();
    const mapped = E5_TOOL_BINDINGS.map((r) => r.tool).sort();
    expect(mapped).toEqual(seeded);

    for (const row of E5_TOOL_BINDINGS) {
      const seedTool = seed.tools.find((t) => t.name === row.tool);
      expect(seedTool?.module).toBe(row.module);
    }
  });

  it("binds every docs tool to the Gateway's own runtime", () => {
    for (const row of E5_TOOL_BINDINGS.filter((r) => r.module === "docs")) {
      expect(row.executor).toBe("internal_mcp");
    }
  });

  it("classifies exactly the five confirm-class tools E5 names", () => {
    expect(
      E5_TOOL_BINDINGS.filter((r) => r.policyClass === "confirm")
        .map((r) => r.tool)
        .sort(),
    ).toEqual([...E5_CONFIRM_CLASS_TOOLS].sort());
  });

  it("records the one row that knowingly departs from E5", () => {
    // The override has to be visible in the data, not only in a commit message:
    // a future reader comparing this table against E5 must find the reason
    // attached to the row that differs.
    const overrides = E5_TOOL_BINDINGS.filter((r) => r.overrideOfE5 !== undefined);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.tool).toBe("list_revit_instances");
    expect(overrides[0]?.overrideOfE5).toMatch(/DP-log/u);
  });
});

describe("the mapping fails closed", () => {
  it("refuses dynamic code bound to the cloud executor", () => {
    // RES-14. Running caller-supplied C# through a cloud executor is a
    // different trust boundary from running it on an enrolled workstation, so
    // this is an explicit refusal rather than an unhandled switch branch.
    expectRejection(
      () => verifyToolBindings(mutate(DYNAMIC_CODE_TOOL, { executor: "aps" })),
      "dynamic_code_bound_to_aps",
    );
  });

  it("refuses a docs tool routed away from the Gateway runtime", () => {
    expectRejection(
      () => verifyToolBindings(mutate("search_api", { executor: "bridge" })),
      "docs_tool_not_internal",
    );
  });

  it("refuses a silently downgraded write tool", () => {
    // The realistic regression: someone relaxes a confirm-class write to auto
    // and no reviewer catches it in a forty-row diff.
    expectRejection(
      () => verifyToolBindings(mutate("set_element_parameter", { policyClass: "auto" })),
      "total_mismatch",
    );
  });

  it("refuses a confirm class attached to the wrong tool", () => {
    expectRejection(
      () =>
        verifyToolBindings(
          mutate("set_element_parameter", { policyClass: "auto" }).map((row) =>
            row.tool === "find_elements" ? { ...row, policyClass: "confirm" } : row,
          ),
        ),
      "confirm_set_mismatch",
    );
  });

  it("refuses a dropped or duplicated row", () => {
    expectRejection(
      () => verifyToolBindings(E5_TOOL_BINDINGS.slice(1)),
      "tool_count_mismatch",
    );
    expectRejection(
      () =>
        verifyToolBindings([
          ...E5_TOOL_BINDINGS.slice(1),
          E5_TOOL_BINDINGS[1] as ToolBindingRow,
        ]),
      "tool_duplicate",
    );
  });

  it("refuses two tools claiming one target name", () => {
    expectRejection(
      () => verifyToolBindings(mutate("close_view", { target: "core.view.activate" })),
      "target_duplicate",
    );
  });
});
