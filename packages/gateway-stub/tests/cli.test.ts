import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { statePath } from "./helpers.js";

interface ReadyRecord {
  event: "ready";
  component: "@revagent/gateway-stub";
  component_version: "0.0.0";
  control_contract_version: 1;
  protocol_versions: [1];
  control_auth_header: "X-RBP-Test-Control";
  shutdown_signals: ["SIGINT", "SIGTERM"];
  pid: number;
  state_path: string;
  ws_url: string;
  http_connection_url: string;
  control_url: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(packageRoot, "dist", "cli.js");

async function startCli(): Promise<{
  child: ChildProcessWithoutNullStreams;
  ready: ReadyRecord;
}> {
  const child = spawn(process.execPath, [cliPath, "--state", await statePath("cli")], {
    stdio: "pipe",
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  const ready = await new Promise<ReadyRecord>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CLI readiness timed out: ${stderr}`)), 5_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      resolveReady(JSON.parse(stdout.slice(0, newline)) as ReadyRecord);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`CLI exited before readiness: code=${String(code)} signal=${String(signal)} ${stderr}`));
    });
  });
  return { child, ready };
}

describe("Gateway stub CLI", () => {
  const children: ChildProcessWithoutNullStreams[] = [];

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  });

  it("prints one machine-readable readiness record and releases its listener on shutdown", async () => {
    const { child, ready } = await startCli();
    children.push(child);
    expect(ready).toMatchObject({
      event: "ready",
      component: "@revagent/gateway-stub",
      component_version: "0.0.0",
      control_contract_version: 1,
      protocol_versions: [1],
      control_auth_header: "X-RBP-Test-Control",
      shutdown_signals: ["SIGINT", "SIGTERM"],
      pid: child.pid,
    });
    expect(Buffer.byteLength(JSON.stringify(ready), "utf8")).toBeLessThan(64 * 1024);
    expect(JSON.stringify(ready)).not.toContain("test-device-token");
    expect(JSON.stringify(ready)).not.toContain("rbp-test-control");
    expect(new URL(ready.ws_url).pathname).toBe("/bridge/v1");
    expect(new URL(ready.http_connection_url).pathname).toBe("/bridge/v1/http/connections");

    expect(child.kill("SIGTERM")).toBe(true);
    await once(child, "exit");
    await expect(fetch(ready.control_url)).rejects.toThrow();
  }, 10_000);
});
