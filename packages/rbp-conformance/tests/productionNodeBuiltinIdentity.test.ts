import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalNodeBuiltinSpecifier,
  resolveInstalledRuntimeDependencyClosure,
  resolveNodeExecutableIdentity,
} from "../src/productionRuntimeIdentity.js";

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

describe("production Node builtin dependency identity", () => {
  it("canonicalizes exact builtin specifiers without classifying package subpaths", () => {
    expect(canonicalNodeBuiltinSpecifier("buffer")).toBe("node:buffer");
    expect(canonicalNodeBuiltinSpecifier("fs")).toBe("node:fs");
    expect(canonicalNodeBuiltinSpecifier("node:fs")).toBe("node:fs");
    expect(canonicalNodeBuiltinSpecifier("buffer/")).toBeUndefined();
    expect(canonicalNodeBuiltinSpecifier("node:not-a-real-builtin")).toBeUndefined();
  });

  it("binds exact builtins to Node even when a shadow package exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-node-builtin-"));
    try {
      writeJson(path.join(root, "app/package.json"), {
        name: "builtin-consumer",
        version: "1.0.0",
        dependencies: {
          buffer: "*",
          fs: "*",
        },
      });
      writeJson(path.join(root, "node_modules/buffer/package.json"), {
        name: "buffer",
        version: "99.0.0",
        main: "index.js",
      });
      writeFileSync(
        path.join(root, "node_modules/buffer/index.js"),
        "module.exports = 'shadow';\n",
        "utf8",
      );

      const closure = resolveInstalledRuntimeDependencyClosure(
        root,
        ["app"],
        resolveNodeExecutableIdentity(process.execPath),
      );

      expect(closure.resolutions).toEqual([
        expect.objectContaining({
          dependencyName: "buffer",
          status: "node_builtin",
          resolutionPath: "node:buffer",
          resolvedPackagePath: null,
          resolvedVersion: null,
        }),
        expect.objectContaining({
          dependencyName: "fs",
          status: "node_builtin",
          resolutionPath: "node:fs",
          resolvedPackagePath: null,
          resolvedVersion: null,
        }),
      ]);
      expect(closure.packages).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an optional module resolves without a package manifest", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-node-manifestless-"));
    try {
      writeJson(path.join(root, "app/package.json"), {
        name: "manifestless-consumer",
        version: "1.0.0",
        optionalDependencies: {
          mystery: "*",
        },
      });
      const moduleRoot = path.join(root, "app/node_modules/mystery");
      mkdirSync(moduleRoot, { recursive: true });
      writeFileSync(path.join(moduleRoot, "index.js"), "module.exports = 1;\n", "utf8");

      expect(() =>
        resolveInstalledRuntimeDependencyClosure(
          root,
          ["app"],
          resolveNodeExecutableIdentity(process.execPath),
        )).toThrow(/without a captured owning package manifest/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
