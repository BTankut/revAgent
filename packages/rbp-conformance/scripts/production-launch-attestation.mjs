import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";

const ATTESTATION_PROTOCOL = "rbp-production-launch-attestation/v1";
const PIPE_ENVIRONMENT_KEY = "RBP_PRODUCTION_LAUNCH_PIPE";
const PIPE_NAME_PATTERN = /^rbp-production-[0-9a-f]{32}$/u;

function normalizedPath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function exactRegularFile(value, label) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const lexical = path.resolve(value);
  if (!existsSync(lexical)) {
    throw new Error(`${label} does not exist: ${lexical}`);
  }
  const stat = lstatSync(lexical);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical regular file: ${lexical}`);
  }
  const real = realpathSync(lexical);
  return {
    path: lexical,
    realPath: real,
    sha256: sha256File(real),
  };
}

function connectToLauncher(pipeName) {
  return new Promise((resolve, reject) => {
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    const socket = net.createConnection(pipePath);
    let response = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("trusted production launcher attestation timed out"));
    }, 45_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error === undefined) resolve(value);
      else reject(error);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      if (
        process.argv[2] === "__launcher-attestation-request-timeout-probe"
      ) {
        return;
      }
      socket.write(`${JSON.stringify({
        protocol: ATTESTATION_PROTOCOL,
        childPid: process.pid,
        launcherPid: process.ppid,
        nodeExecutable: process.execPath,
        entrypoint: process.argv[1] ?? null,
        arguments: process.argv.slice(2),
      })}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline === -1) {
        if (Buffer.byteLength(response, "utf8") > 64 * 1024) {
          finish(new Error("trusted production launcher response is too large"));
        }
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(response.slice(0, newline));
      } catch {
        finish(new Error("trusted production launcher returned malformed JSON"));
        return;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        parsed.ok !== true ||
        typeof parsed.receipt !== "object" ||
        parsed.receipt === null
      ) {
        const reason =
          typeof parsed?.error === "string" ? `: ${parsed.error}` : "";
        finish(new Error(`trusted production launcher rejected the handoff${reason}`));
        return;
      }
      finish(undefined, parsed.receipt);
    });
    socket.on("error", (error) => {
      finish(
        new Error(
          `trusted production launcher handoff failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    });
    socket.on("end", () => {
      if (!settled) {
        finish(new Error("trusted production launcher closed without a receipt"));
      }
    });
  });
}

async function receiveLaunchReceipt() {
  const pipeName = process.env[PIPE_ENVIRONMENT_KEY];
  delete process.env[PIPE_ENVIRONMENT_KEY];
  if (pipeName === undefined) return undefined;
  if (process.platform !== "win32") {
    throw new Error("trusted production launcher attestation is Windows-only");
  }
  if (!PIPE_NAME_PATTERN.test(pipeName)) {
    throw new Error("trusted production launcher pipe name is malformed");
  }
  return await connectToLauncher(pipeName);
}

const launchReceipt = await receiveLaunchReceipt();

function assertFileReceipt(actual, expected, label) {
  if (
    typeof expected !== "object" ||
    expected === null ||
    !samePath(actual.path, expected.path) ||
    !samePath(actual.realPath, expected.realPath) ||
    actual.sha256 !== expected.sha256
  ) {
    throw new Error(`${label} does not match the trusted launcher receipt`);
  }
}

/**
 * Verifies the one-shot OS pipe receipt established before this process loaded
 * production JavaScript. There is intentionally no setter, test override, or
 * caller-provided capability: imported code without the live launcher handoff
 * cannot create production-valid evidence.
 */
export function assertTrustedProductionLaunch({ repoRoot, role }) {
  if (launchReceipt === undefined) {
    throw new Error(
      "production evidence commands require the tracked external PowerShell launcher",
    );
  }
  if (
    typeof launchReceipt !== "object" ||
    launchReceipt === null ||
    launchReceipt.protocol !== ATTESTATION_PROTOCOL ||
    launchReceipt.role !== role ||
    launchReceipt.childPid !== process.pid ||
    launchReceipt.launcherPid !== process.ppid ||
    !Array.isArray(launchReceipt.arguments) ||
    JSON.stringify(launchReceipt.arguments) !==
      JSON.stringify(process.argv.slice(2))
  ) {
    throw new Error("trusted production launcher receipt is not bound to this process");
  }

  const canonicalRepoRoot = realpathSync(path.resolve(repoRoot));
  const expectedLauncher = path.join(
    canonicalRepoRoot,
    "packages",
    "rbp-conformance",
    "scripts",
    "invoke-production.ps1",
  );
  const expectedEntrypoints = {
    "prepare-wrapper": path.join(
      canonicalRepoRoot,
      "packages",
      "rbp-conformance",
      "scripts",
      "prepare-production.mjs",
    ),
    cli: path.join(
      canonicalRepoRoot,
      "packages",
      "rbp-conformance",
      "dist",
      "src",
      "cli.js",
    ),
    "cli-bootstrap": path.join(
      canonicalRepoRoot,
      "packages",
      "rbp-conformance",
      "scripts",
      "production-cli-bootstrap.mjs",
    ),
  };
  const expectedEntrypoint = expectedEntrypoints[role];
  if (expectedEntrypoint === undefined) {
    throw new Error(`unsupported trusted production launcher role: ${String(role)}`);
  }

  const launcher = exactRegularFile(expectedLauncher, "production launcher");
  const node = exactRegularFile(process.execPath, "production controller Node");
  const entrypointValue = process.argv[1];
  if (entrypointValue === undefined) {
    throw new Error("trusted production entrypoint is unavailable");
  }
  const entrypoint = exactRegularFile(
    entrypointValue,
    "production process entrypoint",
  );
  if (!samePath(entrypoint.path, expectedEntrypoint)) {
    throw new Error(
      `trusted production launcher role ${role} requires ${expectedEntrypoint}`,
    );
  }
  assertFileReceipt(launcher, launchReceipt.launcher, "production launcher");
  assertFileReceipt(node, launchReceipt.node, "production controller Node");
  assertFileReceipt(
    entrypoint,
    launchReceipt.entrypoint,
    "production process entrypoint",
  );
}
