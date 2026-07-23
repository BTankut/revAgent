import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 190_000 });

// The production bootstrap is intentionally a plain ESM script consumed by
// both Node and the PowerShell launcher.
// @ts-expect-error -- the runtime bootstrap has no TypeScript declaration file.
import {
  PRODUCTION_LAUNCH_COMMAND_LINE_LIMIT,
  parseProductionLaunchEncodedArguments,
  productionLaunchPowerShellArguments,
  productionLaunchReviewCandidate,
} from "../scripts/production-launch-bootstrap.mjs";
// @ts-expect-error -- the internal production bootstrap has no declaration file.
import {
  classifyProductionModuleSpecifier,
  isCapturedWorkspacePackageRoot,
} from "../scripts/production-controller-bootstrap.mjs";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(packageRoot, "../..");
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
const sourceAnchorHelper = path.join(
  packageRoot,
  "scripts",
  "production-source-anchor.mjs",
);
const launchBootstrapRenderer = path.join(
  packageRoot,
  "scripts",
  "production-launch-bootstrap.mjs",
);
const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "";
const powershell = path.join(
  windowsRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const git = path.join(
  process.env.ProgramFiles ?? "",
  "Git",
  "bin",
  "git.exe",
);

function repositoryIdentity(root = repoRoot): {
  commit: string;
  tree: string;
} {
  const run = (revision: string): string => {
    const result = spawnSync(
      git,
      ["-C", root, "rev-parse", "--verify", revision],
      { encoding: "utf8", shell: false, windowsHide: true },
    );
    expect(result.status, String(result.stderr)).toBe(0);
    return String(result.stdout).trim();
  };
  return { commit: run("HEAD^{commit}"), tree: run("HEAD^{tree}") };
}

function canonicalLauncherArguments(
  commandArguments: string[],
  options: {
    repoRoot?: string;
    role?: "cli-bootstrap" | "prepare-wrapper";
    expectedCommit?: string;
    expectedTree?: string;
  } = {},
): string[] {
  const identity = repositoryIdentity();
  return productionLaunchPowerShellArguments({
    repoRoot: options.repoRoot ?? repoRoot,
    role: options.role ?? "cli-bootstrap",
    expectedCommit: options.expectedCommit ?? identity.commit,
    expectedTree: options.expectedTree ?? identity.tree,
    commandArguments,
    powershellExecutable: powershell,
  });
}

interface AsyncProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

interface AsyncProcessResult {
  error: Error | undefined;
  pid: number | undefined;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

function runProcessAsync(
  executable: string,
  args: string[],
  options: AsyncProcessOptions = {},
): Promise<AsyncProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(
      executable,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      },
    );
    let error: Error | undefined;
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (value) => {
      error = value;
    });
    if (options.input !== undefined) {
      child.stdin?.once("error", (value) => {
        error ??= value;
      });
      child.stdin?.end(options.input);
    }
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            if (child.pid === undefined || process.platform !== "win32") {
              child.kill("SIGKILL");
              return;
            }
            const taskkill = spawn(
              path.join(windowsRoot, "System32", "taskkill.exe"),
              ["/pid", String(child.pid), "/t", "/f"],
              {
                shell: false,
                stdio: "ignore",
                windowsHide: true,
              },
            );
            taskkill.once("error", () => {
              child.kill("SIGKILL");
            });
            taskkill.once("close", (status) => {
              if (status !== 0) child.kill("SIGKILL");
            });
          }, options.timeoutMs);
    child.once("close", (status, signal) => {
      if (timeout !== undefined) clearTimeout(timeout);
      resolve({
        error,
        pid: child.pid,
        signal,
        status,
        stderr,
        stdout,
        timedOut,
      });
    });
  });
}

function runCanonicalLauncher(
  commandArguments: string[],
  options: AsyncProcessOptions = {},
): Promise<AsyncProcessResult> {
  return runProcessAsync(
    powershell,
    canonicalLauncherArguments(commandArguments),
    options,
  );
}

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

  it("round-trips the fixed encoded host payload and guards the Windows command-line limit", () => {
    if (process.platform !== "win32") return;
    const commandArguments = [
      "--leading-switch",
      "value with spaces",
      "üretim",
      "embedded\"quote",
      "trailing\\",
      "",
    ];
    const encoded = canonicalLauncherArguments(commandArguments);
    expect(encoded.slice(0, 5)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedArguments",
    ]);
    expect(encoded[6]).toBe("-EncodedCommand");
    expect(parseProductionLaunchEncodedArguments(encoded[5])).toMatchObject({
      repoRoot,
      role: "cli-bootstrap",
      commandArguments,
    });
    const canonicalXml = Buffer.from(encoded[5], "base64").toString("utf16le");
    const decoyObjectXml = canonicalXml.replace(
      "    <LST>\r\n",
      [
        "    <LST>",
        '      <Obj RefId="1">',
        '        <TN RefId="1"><T>System.Uri</T><T>System.Object</T></TN>',
        "        <ToString>aHR0cHM6Ly9hdHRhY2tlci5leGFtcGxl</ToString>",
        "      </Obj>",
        "",
      ].join("\r\n"),
    );
    expect(() =>
      parseProductionLaunchEncodedArguments(
        Buffer.from(decoyObjectXml, "utf16le").toString("base64"),
      )
    ).toThrow(/not canonical CLIXML/u);
    expect([powershell, ...encoded].join(" ").length).toBeLessThan(
      PRODUCTION_LAUNCH_COMMAND_LINE_LIMIT - 2_000,
    );
    expect(() =>
      canonicalLauncherArguments(["x".repeat(20_000)])
    ).toThrow(/command line is .*limit/u);
    const identity = repositoryIdentity();
    const rendererInput = {
      repoRoot,
      role: "cli-bootstrap",
      expectedCommit: identity.commit,
      expectedTree: identity.tree,
      commandArguments,
      powershellExecutable: powershell,
      generationTimestamp: "2026-07-23T12:00:00.000Z",
      authorityLabel: "test-review-authority",
    };
    expect(() =>
      productionLaunchPowerShellArguments({
        ...rendererInput,
        powershellExecutable: "C:\\attacker\\powershell.exe",
      })
    ).toThrow(/exact SystemRoot PowerShell/u);
    const rendered = spawnSync(
      process.execPath,
      [
        launchBootstrapRenderer,
        "__render-production-launch-review-candidate",
      ],
      {
        encoding: "utf8",
        input: JSON.stringify(rendererInput),
        shell: false,
        windowsHide: true,
      },
    );
    expect(rendered.status, String(rendered.stderr)).toBe(0);
    expect(JSON.parse(String(rendered.stdout))).toEqual(
      productionLaunchReviewCandidate(rendererInput),
    );
    const reviewCandidate = productionLaunchReviewCandidate(rendererInput);
    expect(reviewCandidate).toMatchObject({
      authoritative: false,
      generationTimestamp: "2026-07-23T12:00:00.000Z",
      authorityLabel: "test-review-authority",
      expectedCommit: identity.commit,
      expectedTree: identity.tree,
      workingDirectory: repoRoot,
      hostArguments: encoded,
    });
    expect(reviewCandidate.encodedArgumentsSha256).toBe(
      createHash("sha256")
        .update(Buffer.from(encoded[5], "base64"))
        .digest("hex"),
    );
    const legacyRenderer = spawnSync(
      process.execPath,
      [launchBootstrapRenderer, "__render-production-launch"],
      {
        encoding: "utf8",
        input: JSON.stringify(rendererInput),
        shell: false,
        windowsHide: true,
      },
    );
    expect(legacyRenderer.status).not.toBe(0);
    expect(String(legacyRenderer.stderr)).toMatch(/non-canonical/u);
  });

  it("classifies file, absolute, and nested-package specifiers without filesystem fallback", () => {
    const exactFileUrl = pathToFileURL(
      path.join(packageRoot, "dist", "src", "cli.js"),
    ).href;
    expect(classifyProductionModuleSpecifier(exactFileUrl)).toMatchObject({
      kind: "file",
    });
    expect(() =>
      classifyProductionModuleSpecifier(`${exactFileUrl}?attacker=1`)
    ).toThrow(/rejected URL/u);
    expect(() =>
      classifyProductionModuleSpecifier(`${exactFileUrl}#attacker`)
    ).toThrow(/rejected URL/u);
    expect(() =>
      classifyProductionModuleSpecifier("data:text/javascript,export default 1")
    ).toThrow(/rejected scheme/u);
    expect(classifyProductionModuleSpecifier("ws")).toEqual({
      kind: "package",
      packageName: "ws",
      subpath: ".",
    });
    if (process.platform === "win32") {
      expect(
        classifyProductionModuleSpecifier(
          "C:\\captured\\node_modules\\ws\\index.js",
        ),
      ).toMatchObject({ kind: "absolute_path" });
    }
    expect(
      isCapturedWorkspacePackageRoot(
        path.join(repoRoot, "packages", "protocol"),
      ),
    ).toBe(true);
    expect(
      isCapturedWorkspacePackageRoot(
        path.join(repoRoot, "node_modules", "duplicate-package"),
      ),
    ).toBe(false);
    expect(
      isCapturedWorkspacePackageRoot(
        path.join(
          repoRoot,
          "packages",
          "nested",
          "node_modules",
          "duplicate-package",
        ),
      ),
    ).toBe(false);
  });

  it("clears parent Node injection before loading production JS and preserves argv and exit", async () => {
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
      const result = await runCanonicalLauncher(
        [
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
        workingDirectory: repoRoot,
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

  it("anchors the child working directory to the bound repository root", async () => {
    if (process.platform !== "win32") return;
    const ambientRoot = mkdtempSync(
      path.join(tmpdir(), "rbp-launcher-ambient-cwd-"),
    );
    const output = path.join(ambientRoot, "probe.json");
    try {
      const result = await runCanonicalLauncher(
        [
          "__launcher-attestation-probe",
          output,
          "0",
          "ambient-cwd-must-not-retarget-launch",
        ],
        { cwd: ambientRoot },
      );
      expect(result.status, String(result.stderr)).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
        nodeOptions: null,
        workingDirectory: repoRoot,
        forwarded: ["ambient-cwd-must-not-retarget-launch"],
      });
    } finally {
      rmSync(ambientRoot, { recursive: true, force: true });
    }
  });

  it("ignores hostile PSModulePath content in the fixed encoded trust root", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-bootstrap-psmodule-"));
    try {
      const moduleRoot = path.join(
        root,
        "Microsoft.PowerShell.Security",
      );
      const marker = path.join(root, "shadow-module-ran.txt");
      const output = path.join(root, "probe.json");
      mkdirSync(moduleRoot, { recursive: true });
      writeFileSync(
        path.join(moduleRoot, "Microsoft.PowerShell.Security.psm1"),
        `[IO.File]::WriteAllText(${JSON.stringify(marker)}, 'executed')\n`,
        "utf8",
      );
      const result = await runCanonicalLauncher(
        ["__launcher-attestation-probe", output, "0"],
        {
          env: {
            ...process.env,
            PSModulePath: root,
          },
        },
      );
      expect(result.status, String(result.stderr)).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(output)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects any one-byte mutation of encoded arguments or command source", async () => {
    if (process.platform !== "win32") return;
    const output = path.join(
      mkdtempSync(path.join(tmpdir(), "rbp-bootstrap-mutation-")),
      "must-not-exist.json",
    );
    try {
      const canonical = canonicalLauncherArguments([
        "__launcher-attestation-probe",
        output,
        "0",
      ]);
      for (const index of [5, 7]) {
        const mutated = [...canonical];
        const value = mutated[index];
        mutated[index] = `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
        const result = await runProcessAsync(powershell, mutated);
        expect(result.status).not.toBe(0);
        expect(existsSync(output)).toBe(false);
      }
    } finally {
      rmSync(path.dirname(output), { recursive: true, force: true });
    }
  });

  it("requires the caller to lock the exact current commit and tree", async () => {
    if (process.platform !== "win32") return;
    const identity = repositoryIdentity();
    const output = path.join(
      mkdtempSync(path.join(tmpdir(), "rbp-bootstrap-revision-")),
      "must-not-exist.json",
    );
    try {
      const args = ["__launcher-attestation-probe", output, "0"];
      for (const overrides of [
        { expectedCommit: "0".repeat(identity.commit.length) },
        { expectedTree: "0".repeat(identity.tree.length) },
      ]) {
        const result = await runProcessAsync(
          powershell,
          canonicalLauncherArguments(args, overrides),
        );
        expect(result.status).not.toBe(0);
        expect(existsSync(output)).toBe(false);
      }
    } finally {
      rmSync(path.dirname(output), { recursive: true, force: true });
    }
  });

  it("executes exact raw launcher blob bytes across Unicode and newline variants", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-raw-launcher-blob-"));
    const script = path.join(
      root,
      "packages",
      "rbp-conformance",
      "scripts",
      "invoke-production.ps1",
    );
    const output = path.join(root, "blob-record.txt");
    const runGit = (args: string[]): string => {
      const result = spawnSync(git, ["-C", root, ...args], {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      return String(result.stdout).trim();
    };
    try {
      mkdirSync(path.dirname(script), { recursive: true });
      runGit(["init"]);
      const body = [
        "param(",
        " [string]$NodeExecutable,[string]$Entrypoint,[string[]]$CommandArguments,",
        " [string]$TrustedRepositoryRoot,[string]$TrustedExpectedCommit,",
        " [string]$TrustedExpectedTree,[string]$TrustedLauncherMode,",
        " [string]$TrustedLauncherObjectId,[string]$TrustedLauncherSha256,",
        " [string]$TrustedBootstrapPayloadSha256,",
        " [string]$TrustedBootstrapSourceSha256,",
        " [string]$TrustedBootstrapTemplateSha256,",
        " [string]$TrustedBootstrapGitSha256",
        ")",
        "# üretim launcher blob — internal blank line follows",
        "",
        "$record=[string]::Join('|',@($PID,$PSCommandPath,$PSScriptRoot,$TrustedLauncherObjectId,$TrustedLauncherSha256))",
        "[IO.File]::WriteAllText($env:RBP_RAW_BLOB_OUTPUT,$record)",
      ].join("\n");
      for (const [index, bytes] of [
        Buffer.from(`${body}\n\n`, "utf8"),
        Buffer.from(body, "utf8"),
      ].entries()) {
        writeFileSync(script, bytes);
        runGit(["add", "--", "."]);
        runGit([
          "-c",
          "user.name=RBP Test",
          "-c",
          "user.email=rbp@example.invalid",
          "commit",
          "-m",
          `raw-${String(index)}`,
        ]);
        const expectedCommit = runGit(["rev-parse", "--verify", "HEAD^{commit}"]);
        const expectedTree = runGit(["rev-parse", "--verify", "HEAD^{tree}"]);
        const objectId = runGit(["hash-object", "--no-filters", "--", script]);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        rmSync(output, { force: true });
        const result = await runProcessAsync(
          powershell,
          canonicalLauncherArguments([], {
            repoRoot: root,
            expectedCommit,
            expectedTree,
          }),
          {
            env: { ...process.env, RBP_RAW_BLOB_OUTPUT: output },
          },
        );
        expect(result.status, String(result.stderr)).toBe(0);
        const [pid, scriptPath, scriptRoot, actualObjectId, actualSha256] =
          readFileSync(output, "utf8").split("|");
        expect(Number(pid)).toBe(result.pid);
        expect(scriptPath).toBe("");
        expect(scriptRoot).toBe("");
        expect(actualObjectId).toBe(objectId);
        expect(actualSha256).toBe(sha256);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a direct Node preload backed by a fake parent-owned pipe server", async () => {
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
      const result = await runProcessAsync(
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
          timeoutMs: 45_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.timedOut).toBe(false);
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

  it("rejects a profile-style cmdlet proxy host before starting Node", async () => {
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
      const result = await runProcessAsync(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          proxyHost,
        ],
      );
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(
        /canonical encoded/u,
      );
      expect(String(result.stderr)).not.toMatch(/proxy .* executed/u);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects direct -File launcher execution before starting Node", async () => {
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
      const result = await runProcessAsync(
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
      );
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(
        /canonical encoded/u,
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a launcher copy outside its canonical tracked path", async () => {
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
      const result = await runProcessAsync(
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
      );
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(
        /canonical encoded/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes the expected-commit launcher blob, never a tampered worktree PS1", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-blob-anchor-"));
    const original = readFileSync(launcher);
    const marker = path.join(root, "worktree-launcher-ran.txt");
    const output = path.join(root, "must-not-exist.json");
    try {
      writeFileSync(
        launcher,
        [
          `[IO.File]::WriteAllText(${JSON.stringify(marker)}, 'executed')`,
          original.toString("utf8"),
        ].join("\n"),
      );
      const result = await runCanonicalLauncher([
        "__launcher-attestation-probe",
        output,
        "0",
      ]);
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(
        /clean Git worktree|bytes do not match HEAD/u,
      );
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(output)).toBe(false);
      expect(String(result.stdout)).not.toContain("PASS");
    } finally {
      writeFileSync(launcher, original);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never executes a tampered worktree review renderer before the fixed bootstrap", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-renderer-pretrust-"));
    const original = readFileSync(launchBootstrapRenderer);
    const marker = path.join(root, "worktree-renderer-ran.txt");
    const output = path.join(root, "must-not-exist.json");
    const approvedHostArguments = canonicalLauncherArguments([
      "__launcher-attestation-probe",
      output,
      "0",
    ]);
    try {
      writeFileSync(
        launchBootstrapRenderer,
        [
          'import { writeFileSync as writeMarker } from "node:fs";',
          `writeMarker(${JSON.stringify(marker)}, "executed");`,
          original.toString("utf8"),
        ].join("\n"),
      );
      const result = await runProcessAsync(powershell, approvedHostArguments);
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(
        /clean Git worktree|bytes do not match HEAD/u,
      );
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(output)).toBe(false);
      expect(String(result.stdout)).not.toContain("PASS");
    } finally {
      writeFileSync(launchBootstrapRenderer, original);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink-mode source-anchor helper before Node can execute it", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-helper-mode-"));
    const clone = path.join(root, "repo");
    const marker = path.join(root, "symlink-helper-ran.txt");
    const output = path.join(root, "must-not-exist.json");
    const relativeHelper =
      "packages/rbp-conformance/scripts/production-source-anchor.mjs";
    try {
      let result = spawnSync(
        git,
        ["clone", "--no-local", "--quiet", repoRoot, clone],
        {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        },
      );
      expect(result.status, String(result.stderr)).toBe(0);
      const maliciousHelper = [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(marker)}, "executed");`,
        "",
      ].join("\n");
      result = spawnSync(git, ["-C", clone, "hash-object", "-w", "--stdin"], {
        encoding: "utf8",
        input: maliciousHelper,
        shell: false,
        windowsHide: true,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      const objectId = String(result.stdout).trim();
      result = spawnSync(
        git,
        [
          "-C",
          clone,
          "update-index",
          "--add",
          "--cacheinfo",
          `120000,${objectId},${relativeHelper}`,
        ],
        {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        },
      );
      expect(result.status, String(result.stderr)).toBe(0);
      result = spawnSync(
        git,
        [
          "-C",
          clone,
          "-c",
          "user.name=Conformance Test",
          "-c",
          "user.email=conformance@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "malicious helper mode",
        ],
        {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        },
      );
      expect(result.status, String(result.stderr)).toBe(0);
      writeFileSync(path.join(clone, ...relativeHelper.split("/")), maliciousHelper);
      const identity = repositoryIdentity(clone);
      const approvedHostArguments = productionLaunchPowerShellArguments({
        repoRoot: clone,
        role: "cli-bootstrap",
        expectedCommit: identity.commit,
        expectedTree: identity.tree,
        commandArguments: [
          "__launcher-attestation-probe",
          output,
          "0",
        ],
        powershellExecutable: powershell,
      });
      const launcherResult = await runProcessAsync(
        powershell,
        approvedHostArguments,
      );
      expect(launcherResult.status).not.toBe(0);
      expect(String(launcherResult.stderr)).toMatch(
        /unsupported index record|index path is not canonical/u,
      );
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(output)).toBe(false);
      expect(String(launcherResult.stdout)).not.toContain("PASS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a correctly shaped copied scripts tree before creating a child receipt", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-shaped-copy-"));
    try {
      const copiedPackageRoot = path.join(
        root,
        "packages",
        "rbp-conformance",
      );
      const copiedScripts = path.join(copiedPackageRoot, "scripts");
      mkdirSync(copiedScripts, { recursive: true });
      for (const name of [
        "invoke-production.ps1",
        "production-cli-bootstrap.mjs",
        "production-launch-attestation.mjs",
        "production-source-anchor.mjs",
      ]) {
        copyFileSync(
          path.join(packageRoot, "scripts", name),
          path.join(copiedScripts, name),
        );
      }
      const output = path.join(root, "must-not-exist.json");
      const result = await runProcessAsync(
        powershell,
        canonicalLauncherArguments(
          [
          "__launcher-attestation-probe",
          output,
          "0",
          ],
          { repoRoot: root },
        ),
      );
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(
        /B05|not a git repository|worktree/u,
      );
      expect(String(result.stdout)).not.toContain("PASS");
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a launcher reached through a parent junction before starting Node", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-junction-"));
    try {
      const linkedRepo = path.join(root, "repo-link");
      symlinkSync(repoRoot, linkedRepo, "junction");
      const output = path.join(root, "must-not-exist.json");
      const result = await runProcessAsync(
        powershell,
        canonicalLauncherArguments(
          ["__launcher-attestation-probe", output, "0"],
          { repoRoot: linkedRepo },
        ),
      );
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(/contains reparse point/u);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects caller-selected Node and ignores a user-writable PATH copy", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-fake-node-"));
    try {
      const copiedNode = path.join(root, "node.exe");
      const output = path.join(root, "probe.json");
      copyFileSync(process.execPath, copiedNode);
      const identity = repositoryIdentity();
      expect(() =>
        productionLaunchPowerShellArguments({
          repoRoot,
          role: "cli-bootstrap",
          expectedCommit: identity.commit,
          expectedTree: identity.tree,
          commandArguments: [],
          powershellExecutable: powershell,
          nodeExecutable: copiedNode,
        })
      ).toThrow(/payload is invalid/u);
      const result = await runCanonicalLauncher(
        ["__launcher-attestation-probe", output, "0"],
        { env: { ...process.env, PATH: root } },
      );
      expect(result.status, String(result.stderr)).toBe(0);
      expect(existsSync(output)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not execute a user-writable Git PATH shadow", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-fake-git-"));
    try {
      const fakeGit = path.join(root, "git.exe");
      const marker = path.join(root, "fake-git-ran.txt");
      const output = path.join(root, "probe.json");
      copyFileSync(process.execPath, fakeGit);
      const result = await runCanonicalLauncher(
        ["__launcher-attestation-probe", output, "0"],
        {
          env: {
            ...process.env,
            PATH: root,
            RBP_FAKE_GIT_MARKER: marker,
          },
        },
      );
      expect(result.status, String(result.stderr)).toBe(0);
      expect(existsSync(output)).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("raw-verifies the source-anchor helper before allowing it to execute", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-anchor-order-"));
    const original = readFileSync(sourceAnchorHelper);
    const marker = path.join(root, "tampered-helper-ran.txt");
    const output = path.join(root, "must-not-exist.json");
    try {
      writeFileSync(
        sourceAnchorHelper,
        [
          'import { writeFileSync as writeMarker } from "node:fs";',
          `writeMarker(${JSON.stringify(marker)}, "executed");`,
          original.toString("utf8"),
        ].join("\n"),
      );
      const result = await runCanonicalLauncher(
        ["__launcher-attestation-probe", output, "0"],
      );
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(/bytes do not match HEAD/u);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(output)).toBe(false);
      expect(String(result.stdout)).not.toContain("PASS");
    } finally {
      writeFileSync(sourceAnchorHelper, original);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects effective Git filters before any filter command can execute", () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-filter-pretrust-"));
    const clone = path.join(root, "repo");
    const marker = path.join(root, "filter-ran.txt");
    try {
      let result = spawnSync(
        git,
        ["clone", "--no-local", "--quiet", repoRoot, clone],
        {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        },
      );
      expect(result.status, String(result.stderr)).toBe(0);
      const filterSource = [
        `[IO.File]::WriteAllText(${JSON.stringify(marker)}, 'executed')`,
        "$inputStream = [Console]::OpenStandardInput()",
        "$outputStream = [Console]::OpenStandardOutput()",
        "$inputStream.CopyTo($outputStream)",
      ].join("\n");
      const filterCommand = [
        `"${powershell}"`,
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(filterSource, "utf16le").toString("base64"),
      ].join(" ");
      result = spawnSync(
        git,
        [
          "-C",
          clone,
          "config",
          "--local",
          "filter.rbpattack.clean",
          filterCommand,
        ],
        {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        },
      );
      expect(result.status, String(result.stderr)).toBe(0);
      const info = path.join(clone, ".git", "info");
      mkdirSync(info, { recursive: true });
      writeFileSync(
        path.join(info, "attributes"),
        "* filter=rbpattack\n",
        "utf8",
      );
      const clonedSourceAnchor = path.join(
        clone,
        "packages",
        "rbp-conformance",
        "scripts",
        "production-source-anchor.mjs",
      );
      result = spawnSync(
        process.execPath,
        [
          clonedSourceAnchor,
          "__capture-production-source-anchor",
          clone,
          powershell,
        ],
        {
          cwd: clone,
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        },
      );
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(/rejects effective Git filters/u);
      expect(existsSync(marker)).toBe(false);
      expect(String(result.stdout)).not.toContain("PASS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes and rebuilds an ignored malicious CLI before any attacker byte executes", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-malicious-cli-"));
    const cli = path.join(packageRoot, "dist", "src", "cli.js");
    const nestedManifest = path.join(packageRoot, "dist", "src", "package.json");
    const marker = path.join(root, "malicious-cli-ran.txt");
    try {
      mkdirSync(path.dirname(cli), { recursive: true });
      writeFileSync(
        cli,
        [
          'import { writeFileSync } from "node:fs";',
          "export async function runProductionCliMain() {",
          `  writeFileSync(${JSON.stringify(marker)}, "executed");`,
          '  process.stdout.write("ATTACKER_PASS\\n");',
          "}",
          "",
        ].join("\n"),
      );
      writeJson(nestedManifest, {
        name: "@revagent/rbp-conformance",
        type: "module",
      });
      const result = await runCanonicalLauncher(
        ["junit"],
        { timeoutMs: 180_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.timedOut).toBe(false);
      expect(result.status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(String(result.stdout)).not.toContain("ATTACKER_PASS");
      expect(existsSync(cli), String(result.stderr)).toBe(true);
      expect(readFileSync(cli, "utf8")).not.toContain("ATTACKER_PASS");
      expect(existsSync(nestedManifest)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 190_000);

  it("does not let a nested ignored package shadow the fixed attestation module", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-attestation-shadow-"));
    const compiledCli = path.join(packageRoot, "dist", "src", "cli.js");
    const nestedManifest = path.join(packageRoot, "dist", "src", "package.json");
    const fakeScripts = path.join(packageRoot, "dist", "src", "scripts");
    const fakeAttestation = path.join(
      fakeScripts,
      "production-launch-attestation.mjs",
    );
    const marker = path.join(root, "fake-attestation-ran.txt");
    try {
      expect(existsSync(compiledCli)).toBe(true);
      writeJson(nestedManifest, {
        name: "@revagent/rbp-conformance",
        type: "module",
      });
      mkdirSync(fakeScripts, { recursive: true });
      writeFileSync(
        fakeAttestation,
        [
          'import { rmSync, writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(marker)}, "executed");`,
          `rmSync(${JSON.stringify(fakeAttestation)}, { force: true });`,
          "export function assertTrustedProductionLaunch() {}",
          "",
        ].join("\n"),
      );
      const result = await runProcessAsync(process.execPath, [compiledCli, "junit"], {
        cwd: repoRoot,
      });
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(/tracked external PowerShell launcher/u);
      expect(String(result.stdout)).not.toContain("PASS");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(fakeScripts, { recursive: true, force: true });
      rmSync(nestedManifest, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates the receipt when process.argv changes after the handoff", async () => {
    if (process.platform !== "win32") return;
    const result = await runCanonicalLauncher(
      ["__launcher-attestation-argv-spoof"],
    );
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toMatch(
      /receipt is not bound to this process/u,
    );
    expect(String(result.stdout)).not.toContain("PASS");
  });

  it("invalidates the receipt when process.cwd changes after the handoff", async () => {
    if (process.platform !== "win32") return;
    const targetDirectory = mkdtempSync(
      path.join(tmpdir(), "rbp-launcher-cwd-spoof-"),
    );
    try {
      const result = await runCanonicalLauncher([
        "__launcher-attestation-cwd-spoof",
        targetDirectory,
      ]);
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toMatch(
        /working directory is not bound to this process/u,
      );
      expect(String(result.stdout)).not.toContain("PASS");
    } finally {
      rmSync(targetDirectory, { recursive: true, force: true });
    }
  });

  it("times out and terminates a child that connects without a request", async () => {
    if (process.platform !== "win32") return;
    const startedAt = Date.now();
    const result = await runCanonicalLauncher(
      ["__launcher-attestation-request-timeout-probe"],
      { timeoutMs: 45_000 },
    );
    const elapsedMs = Date.now() - startedAt;
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toMatch(/attestation request timed out/u);
    expect(elapsedMs).toBeGreaterThanOrEqual(28_000);
    expect(elapsedMs).toBeLessThan(45_000);
  }, 50_000);

  it("isolates concurrent one-shot launcher handoffs", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "rbp-launcher-concurrent-"));
    try {
      const launches = Array.from({ length: 4 }, (_, index) => {
        const output = path.join(root, `probe-${String(index)}.json`);
        const child = spawn(
          powershell,
          canonicalLauncherArguments([
            "__launcher-attestation-probe",
            output,
            "0",
            `invocation-${String(index)}`,
          ]),
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
          workingDirectory: repoRoot,
          forwarded: [`invocation-${String(index)}`],
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
