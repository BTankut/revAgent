import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CodeExecMode,
  ModeBNotImplementedError,
  codeExecSandboxHost,
  generateToolWrapperTree,
} from "./modeB.js";
import type { GatewayRegistryView } from "./registry.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

describe("mode B fails closed", () => {
  it("refuses every EngineMode entry point with a typed error", () => {
    const mode = new CodeExecMode();
    expect(mode.mode).toBe("code_exec");

    for (const call of [
      () => mode.prepareTurn(),
      () => mode.interpretResponse(),
    ]) {
      let caught: unknown;
      try {
        call();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ModeBNotImplementedError);
      expect((caught as ModeBNotImplementedError).code).toBe("not_implemented");
      expect((caught as ModeBNotImplementedError).port).toBe("engine_mode");
    }
  });

  it("refuses the sandbox host without opening anything", () => {
    // The arguments are opaque brands with no constructible value, which is the
    // point: nothing here can describe a real sandbox scope or resource limit.
    // They are only needed to satisfy the published signature.
    const brand = <T>(): T => undefined as unknown as T;
    expect(codeExecSandboxHost.toolRpcEndpoint).toBeNull();
    expect(() => codeExecSandboxHost.createSession(brand())).toThrow(
      ModeBNotImplementedError,
    );
    expect(() => codeExecSandboxHost.exec(brand(), brand())).toThrow(
      ModeBNotImplementedError,
    );
  });

  it("refuses wrapper generation", () => {
    expect(() =>
      generateToolWrapperTree(undefined as unknown as GatewayRegistryView),
    ).toThrow(ModeBNotImplementedError);
  });

  it("throws a real error rather than failing as a missing function", () => {
    // A `declare`d function emits no JavaScript, so calling it would fail as
    // "undefined is not a function" -- an unstructured failure. These must be
    // real functions that throw a typed error.
    expect(typeof generateToolWrapperTree).toBe("function");
    expect(typeof codeExecSandboxHost.createSession).toBe("function");
  });
});

describe("mode B has no runtime footprint", () => {
  it("is imported by no shipped module", () => {
    // The acceptance criterion is that Mode B has no runtime side effects. The
    // way that stops being true is a shell module importing it "just to
    // register" something, so this asserts the import graph rather than trusting
    // the absence.
    const offenders: string[] = [];
    for (const entry of readdirSync(SRC_DIR)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
        continue;
      }
      if (entry === "modeB.ts" || entry === "index.ts") {
        continue;
      }
      const source = readFileSync(join(SRC_DIR, entry), "utf8");
      if (/from\s+"\.\/modeB\.js"/u.test(source)) {
        offenders.push(entry);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("exports no capability constant", () => {
    // A shipped value asserting what Mode B supports would be configuration,
    // which the acceptance criterion excludes alongside runtime side effects.
    const source = readFileSync(join(SRC_DIR, "modeB.ts"), "utf8");
    expect(source).not.toMatch(/export const (MODE_B|CODE_EXEC_MODE|MODE_B_STATUS)/u);
  });
});
