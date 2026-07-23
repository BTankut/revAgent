import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bootstrapModuleUrl = pathToFileURL(
  path.join(packageRoot, "scripts", "bootstrap-identity.mjs"),
).href;
const launcher = path.join(
  packageRoot,
  "scripts",
  "invoke-production.ps1",
);

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runBootstrapModule(
  source: string,
  args: string[],
  input?: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source, bootstrapModuleUrl, ...args],
    {
      encoding: "utf8",
      input,
      shell: false,
      windowsHide: true,
    },
  );
}

function captureBootstrapIdentity(repoRoot: string): unknown {
  const result = runBootstrapModule(
    [
      "const module = await import(process.argv[1]);",
      "const value = module.captureProductionBootstrapIdentity(process.argv[2]);",
      "process.stdout.write(JSON.stringify(value));",
    ].join(""),
    [repoRoot],
  );
  expect(result.status, String(result.stderr)).toBe(0);
  return JSON.parse(String(result.stdout)) as unknown;
}

function assertBootstrapIdentity(
  repoRoot: string,
  expected: unknown,
): ReturnType<typeof spawnSync> {
  return runBootstrapModule(
    [
      "import fs from 'node:fs';",
      "const module = await import(process.argv[1]);",
      "const expected = JSON.parse(fs.readFileSync(0, 'utf8'));",
      "module.assertProductionBootstrapIdentityCurrent(process.argv[2], expected);",
    ].join(""),
    [repoRoot],
    JSON.stringify(expected),
  );
}

describe("canonical production bootstrap and external launcher", () => {
  it("binds the full compiler and physical generator closure and fails closed on mutation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-bootstrap-identity-"));
    try {
      writeJson(path.join(root, "packages", "protocol", "package.json"), {
        name: "@revagent/protocol",
        version: "0.0.0",
        devDependencies: {
          "json-schema-to-typescript": "15.0.4",
        },
      });
      writeJson(path.join(root, "node_modules", "typescript", "package.json"), {
        name: "typescript",
        version: "5.9.3",
      });
      mkdirSync(
        path.join(root, "node_modules", "typescript", "lib"),
        { recursive: true },
      );
      writeFileSync(
        path.join(root, "node_modules", "typescript", "lib", "tsc.js"),
        "require('./_tsc.js');\n",
        "utf8",
      );
      const typescriptImplementation = path.join(
        root,
        "node_modules",
        "typescript",
        "lib",
        "_tsc.js",
      );
      writeFileSync(typescriptImplementation, "module.exports = 1;\n", "utf8");

      const generatorRoot = path.join(
        root,
        "node_modules",
        "json-schema-to-typescript",
      );
      writeJson(path.join(generatorRoot, "package.json"), {
        name: "json-schema-to-typescript",
        version: "15.0.4",
        main: "index.js",
        dependencies: {
          "bootstrap-transitive": "1.0.0",
        },
      });
      writeFileSync(
        path.join(generatorRoot, "index.js"),
        "module.exports = require('bootstrap-transitive');\n",
        "utf8",
      );
      const transitiveRoot = path.join(
        root,
        "node_modules",
        "bootstrap-transitive",
      );
      writeJson(path.join(transitiveRoot, "package.json"), {
        name: "bootstrap-transitive",
        version: "1.0.0",
        main: "index.js",
      });
      const transitiveImplementation = path.join(transitiveRoot, "index.js");
      writeFileSync(transitiveImplementation, "module.exports = 1;\n", "utf8");

      const expected = captureBootstrapIdentity(root);

      writeFileSync(typescriptImplementation, "module.exports = 2;\n", "utf8");
      let result = assertBootstrapIdentity(root, expected);
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(
        /bootstrap build dependency identity changed/u,
      );
      writeFileSync(typescriptImplementation, "module.exports = 1;\n", "utf8");
      result = assertBootstrapIdentity(root, expected);
      expect(result.status, String(result.stderr)).toBe(0);

      writeFileSync(transitiveImplementation, "module.exports = 2;\n", "utf8");
      result = assertBootstrapIdentity(root, expected);
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(
        /bootstrap build dependency identity changed/u,
      );
      writeFileSync(transitiveImplementation, "module.exports = 1;\n", "utf8");
      result = assertBootstrapIdentity(root, expected);
      expect(result.status, String(result.stderr)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects caller-selected Git and appends the verified absolute path once", () => {
    const absoluteNpm = path.resolve("npm-cli.js");
    const absoluteGit = path.resolve("git.exe");
    const result = runBootstrapModule(
      [
        "const module = await import(process.argv[1]);",
        "const npm = process.argv[2];",
        "const git = process.argv[3];",
        "let rejected = 0;",
        "for (const value of ['--git-executable', '--git-executable=spoof']) {",
        "try { module.parsePrepareBootstrapArguments([",
        "'--npm-executable', npm, 'plan.json', value, 'spoof']); }",
        "catch { rejected += 1; }",
        "}",
        "const parsed = module.parsePrepareBootstrapArguments([",
        "'--npm-executable', npm, 'plan.json', '--run-id', 'run-1']);",
        "const inner = module.innerPrepareArguments(parsed.forwardedArgs, git);",
        "process.stdout.write(JSON.stringify({rejected, parsed, inner}));",
      ].join(""),
      [absoluteNpm, absoluteGit],
    );
    expect(result.status, String(result.stderr)).toBe(0);
    const value = JSON.parse(String(result.stdout)) as {
      rejected: number;
      parsed: { npmExecutable: string; forwardedArgs: string[] };
      inner: string[];
    };
    expect(value.rejected).toBe(2);
    expect(value.parsed).toEqual({
      npmExecutable: absoluteNpm,
      forwardedArgs: ["plan.json", "--run-id", "run-1"],
    });
    expect(value.inner).toEqual([
      "prepare-production",
      "plan.json",
      "--run-id",
      "run-1",
      "--git-executable",
      absoluteGit,
    ]);
  });

  it("clears parent Node injection before loading JS and preserves argv and exit", () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-production-launcher-"));
    try {
      const marker = path.join(root, "attacker-loaded.txt");
      const attacker = path.join(root, "attacker.cjs");
      const output = path.join(root, "probe.json");
      const probe = path.join(root, "probe.mjs");
      writeFileSync(
        attacker,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(marker)}, 'loaded');`,
          "",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        probe,
        [
          "import fs from 'node:fs';",
          "const [output, ...args] = process.argv.slice(2);",
          "fs.writeFileSync(output, JSON.stringify({",
          "  nodeOptions: process.env.NODE_OPTIONS ?? null,",
          "  args,",
          "}));",
          "process.exitCode = 23;",
          "",
        ].join("\n"),
        "utf8",
      );
      const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
      expect(windowsRoot).toBeTruthy();
      const powershell = path.join(
        windowsRoot!,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const result = spawnSync(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          launcher,
          "-NodeExecutable",
          process.execPath,
          "-Entrypoint",
          probe,
          output,
          "value with spaces",
          "--literal-argument",
        ],
        {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
          env: {
            ...process.env,
            NODE_OPTIONS: `--require=${attacker.replaceAll("\\", "/")}`,
          },
        },
      );
      expect(result.status, String(result.stderr)).toBe(23);
      expect(existsSync(marker)).toBe(false);
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
        nodeOptions: null,
        args: ["value with spaces", "--literal-argument"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
