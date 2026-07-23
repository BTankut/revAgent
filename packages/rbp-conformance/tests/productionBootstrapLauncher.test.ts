import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
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
const cliBootstrap = path.join(
  packageRoot,
  "scripts",
  "production-cli-bootstrap.mjs",
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

  it("clears parent Node injection before loading production JS and preserves argv and exit", () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-production-launcher-"));
    try {
      const marker = path.join(root, "attacker-loaded.txt");
      const attacker = path.join(root, "attacker.cjs");
      const output = path.join(root, "probe.json");
      writeFileSync(
        attacker,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(marker)}, 'loaded');`,
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
          cliBootstrap,
          "__launcher-attestation-probe",
          output,
          "23",
          "value with spaces",
          "--literal-argument",
          "trailing slash\\",
          "embedded\"quote",
          "",
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
        forwarded: [
          "value with spaces",
          "--literal-argument",
          "trailing slash\\",
          "embedded\"quote",
          "",
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a direct Node preload backed by a fake parent-owned pipe server", () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-fake-server-"));
    try {
      const marker = path.join(root, "preload-loaded.txt");
      const preload = path.join(root, "preload.cjs");
      const attackerParent = path.join(root, "attacker-parent.mjs");
      const output = path.join(root, "must-not-exist.json");
      writeFileSync(
        preload,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(marker)}, 'loaded');`,
          "",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        attackerParent,
        [
          'import { spawn } from "node:child_process";',
          'import net from "node:net";',
          "const [node, bootstrap, preload, output, suffix] = process.argv.slice(2);",
          "const authName = `rbp-production-auth-${suffix}`;",
          "const receiptName = `rbp-production-receipt-${suffix}`;",
          "const token = 'a'.repeat(64);",
          "const auth = net.createServer((socket) => {",
          "  let request = '';",
          "  socket.setEncoding('utf8');",
          "  socket.on('data', (chunk) => {",
          "    request += chunk;",
          "    if (request.includes('\\n')) socket.end(`OK\\t${token}\\n`);",
          "  });",
          "});",
          "const receipt = net.createServer((socket) => {",
          "  socket.end('ERROR\\tZmFrZSBzZXJ2ZXI=\\n');",
          "});",
          "await Promise.all([",
          "  new Promise((resolve, reject) => {",
          "    auth.once('error', reject);",
          "    auth.listen(`\\\\\\\\.\\\\pipe\\\\${authName}`, resolve);",
          "  }),",
          "  new Promise((resolve, reject) => {",
          "    receipt.once('error', reject);",
          "    receipt.listen(`\\\\\\\\.\\\\pipe\\\\${receiptName}`, resolve);",
          "  }),",
          "]);",
          "const child = spawn(",
          "  node,",
          "  [bootstrap, '__launcher-attestation-probe', output, '0'],",
          "  {",
          "    env: {",
          "      ...process.env,",
          "      NODE_OPTIONS: `--require=${preload.replaceAll('\\\\\\\\', '/')}`,",
          "      RBP_PRODUCTION_LAUNCH_PIPES: `${authName}|${receiptName}`,",
          "    },",
          "    shell: false,",
          "    stdio: ['ignore', 'inherit', 'inherit'],",
          "    windowsHide: true,",
          "  },",
          ");",
          "child.on('close', (status) => {",
          "  auth.close();",
          "  receipt.close();",
          "  process.exitCode = status ?? 99;",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );
      const suffix = randomBytes(16).toString("hex");
      const result = spawnSync(
        process.execPath,
        [
          attackerParent,
          process.execPath,
          cliBootstrap,
          preload,
          output,
          suffix,
        ],
        {
          encoding: "utf8",
          shell: false,
          timeout: 45_000,
          windowsHide: true,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(output)).toBe(false);
      expect(String(result.stderr)).toMatch(
        /server is not exact SystemRoot Windows PowerShell/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 50_000);

  it("rejects a profile-style cmdlet proxy host before starting Node", () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-proxy-host-"));
    try {
      const proxyHost = path.join(root, "proxy-host.ps1");
      const output = path.join(root, "must-not-exist.json");
      const quotePowerShell = (value: string): string =>
        `'${value.replaceAll("'", "''")}'`;
      writeFileSync(
        proxyHost,
        [
          "$ErrorActionPreference = 'Stop'",
          "function global:Get-Process { throw 'proxy Get-Process executed' }",
          "function global:Get-Item { throw 'proxy Get-Item executed' }",
          "function global:Get-FileHash { throw 'proxy Get-FileHash executed' }",
          "function global:ForEach-Object { throw 'proxy ForEach-Object executed' }",
          "function global:ConvertFrom-Json { throw 'proxy ConvertFrom-Json executed' }",
          "function global:ConvertTo-Json { throw 'proxy ConvertTo-Json executed' }",
          [
            "&",
            quotePowerShell(launcher),
            "-NodeExecutable",
            quotePowerShell(process.execPath),
            "-Entrypoint",
            quotePowerShell(cliBootstrap),
            "__launcher-attestation-probe",
            quotePowerShell(output),
            "0",
          ].join(" "),
          "",
        ].join("\r\n"),
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
          proxyHost,
        ],
        {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        },
      );
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(
        /host arguments must be exactly/u,
      );
      expect(String(result.stderr)).not.toMatch(/proxy .* executed/u);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects arbitrary entrypoints before starting Node", () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-entrypoint-"));
    try {
      const arbitrary = path.join(root, "arbitrary.mjs");
      const marker = path.join(root, "arbitrary-ran.txt");
      writeFileSync(
        arbitrary,
        `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
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
          arbitrary,
        ],
        {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        },
      );
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(
        /accepts only the canonical tracked prepare wrapper or CLI bootstrap/u,
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a launcher copy outside its canonical tracked path", () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-copy-"));
    try {
      const copiedLauncher = path.join(root, "invoke-production.ps1");
      copyFileSync(launcher, copiedLauncher);
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
          copiedLauncher,
          "-NodeExecutable",
          process.execPath,
          "-Entrypoint",
          cliBootstrap,
          "__launcher-attestation-probe",
          path.join(root, "should-not-exist.json"),
          "0",
        ],
        {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        },
      );
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(
        /launcher is not the canonical tracked path/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates the receipt when process.argv changes after the handoff", () => {
    if (process.platform !== "win32") return;
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
        cliBootstrap,
        "__launcher-attestation-argv-spoof",
      ],
      {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      },
    );
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toMatch(
      /receipt is not bound to this process/u,
    );
    expect(String(result.stdout)).not.toContain("PASS");
  });

  it("times out and terminates a child that connects without a request", () => {
    if (process.platform !== "win32") return;
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
    expect(windowsRoot).toBeTruthy();
    const powershell = path.join(
      windowsRoot!,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const startedAt = Date.now();
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
        cliBootstrap,
        "__launcher-attestation-request-timeout-probe",
      ],
      {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: 45_000,
      },
    );
    const elapsedMs = Date.now() - startedAt;
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toMatch(/attestation request timed out/u);
    expect(elapsedMs).toBeGreaterThanOrEqual(28_000);
    expect(elapsedMs).toBeLessThan(45_000);
  }, 50_000);

  it("isolates concurrent one-shot launcher handoffs", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-concurrent-"));
    try {
      const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
      expect(windowsRoot).toBeTruthy();
      const powershell = path.join(
        windowsRoot!,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const launches = Array.from({ length: 4 }, (_, index) => {
        const output = path.join(root, `probe-${String(index)}.json`);
        const child = spawn(
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
            cliBootstrap,
            "__launcher-attestation-probe",
            output,
            "0",
            `invocation-${String(index)}`,
          ],
          {
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        return new Promise<{ output: string; status: number | null; stderr: string }>(
          (resolve, reject) => {
            let stderr = "";
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk: string) => {
              stderr += chunk;
            });
            child.on("error", reject);
            child.on("close", (status) => resolve({ output, status, stderr }));
          },
        );
      });
      const results = await Promise.all(launches);
      results.forEach((result, index) => {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(result.output, "utf8"))).toEqual({
          nodeOptions: null,
          forwarded: [`invocation-${String(index)}`],
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
