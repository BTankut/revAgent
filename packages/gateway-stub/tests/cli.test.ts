import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RbpEnvelope } from "@revagent/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { GatewayStubCore } from "../src/core.js";
import {
  controlEnvelope,
  hello,
  sessionRegister,
  statePath,
  tokenTable,
} from "./helpers.js";

interface ReadyRecord {
  event: "ready";
  component: "@revagent/gateway-stub";
  component_version: "0.0.0";
  control_contract_version: 1;
  protocol_versions: number[];
  control_auth_header: "X-RBP-Test-Control";
  shutdown_signals: ["SIGINT", "SIGTERM"];
  deterministic_clock: boolean;
  pid: number;
  state_path: string;
  ws_url: string;
  http_connection_url: string;
  control_url: string;
}

interface SseReader {
  next(): Promise<RbpEnvelope>;
  close(): Promise<void>;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(packageRoot, "dist", "cli.js");
const cliToken = "test-device-token";
const controlToken = "rbp-test-control";

async function startCli(name: string, arguments_: string[] = []): Promise<{
  child: ChildProcessWithoutNullStreams;
  ready: ReadyRecord;
}> {
  const child = spawn(
    process.execPath,
    [cliPath, "--state", await statePath(name), ...arguments_],
    {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
      env: { ...process.env, NODE_ENV: "test" },
    },
  );
  let stdout = "";
  let stderr = "";
  const ready = await new Promise<ReadyRecord>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CLI readiness timed out: ${stderr}`)), 5_000);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeout);
      reject(new Error(`CLI exited before readiness: code=${String(code)} signal=${String(signal)} ${stderr}`));
    };
    child.once("exit", onExit);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolveReady(JSON.parse(stdout.slice(0, newline)) as ReadyRecord);
    });
  });
  return { child, ready };
}

async function control(ready: ReadyRecord, body: unknown): Promise<unknown> {
  const response = await fetch(ready.control_url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rbp-test-control": controlToken,
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function snapshot(ready: ReadyRecord): Promise<{
  sessions: Record<string, { liveness: string }>;
}> {
  const response = await fetch(ready.control_url, {
    headers: { "x-rbp-test-control": controlToken },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ sessions: Record<string, { liveness: string }> }>;
}

async function openSse(ready: ReadyRecord, connectionId: string): Promise<SseReader> {
  const abort = new AbortController();
  const response = await fetch(
    `${ready.http_connection_url}/${encodeURIComponent(connectionId)}/events`,
    {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${cliToken}`,
      },
      signal: abort.signal,
    },
  );
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<RbpEnvelope> {
      while (true) {
        const separator = buffered.indexOf("\n\n");
        if (separator >= 0) {
          const event = buffered.slice(0, separator);
          buffered = buffered.slice(separator + 2);
          const data = event.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (data !== undefined) return JSON.parse(data) as RbpEnvelope;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("CLI SSE stream ended before the next RBP event");
        buffered += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
      }
    },
    async close(): Promise<void> {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

async function stopCli(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  if (process.platform === "win32") {
    expect(child.send({ action: "emit_test_signal", signal: "SIGTERM" })).toBe(true);
  } else {
    expect(child.kill("SIGTERM")).toBe(true);
  }
  return exited;
}

async function assertListenerPortReleased(ready: ReadyRecord): Promise<void> {
  const endpoint = new URL(ready.control_url);
  const probe = createServer();
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    probe.once("error", onError);
    probe.listen(Number(endpoint.port), endpoint.hostname, () => {
      probe.off("error", onError);
      resolveListen();
    });
  });
  await new Promise<void>((resolveClose, reject) => {
    probe.close((error) => error === undefined ? resolveClose() : reject(error));
  });
}

async function persistedState(ready: ReadyRecord): Promise<{
  schemaVersion: number;
  sessions: Record<string, { liveness: string }>;
}> {
  return JSON.parse(await readFile(ready.state_path, "utf8")) as {
    schemaVersion: number;
    sessions: Record<string, { liveness: string }>;
  };
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
    const { child, ready } = await startCli("readiness");
    children.push(child);
    expect(ready).toMatchObject({
      event: "ready",
      component: "@revagent/gateway-stub",
      component_version: "0.0.0",
      control_contract_version: 1,
      protocol_versions: [1],
      control_auth_header: "X-RBP-Test-Control",
      shutdown_signals: ["SIGINT", "SIGTERM"],
      deterministic_clock: false,
      pid: child.pid,
    });
    expect(Buffer.byteLength(JSON.stringify(ready), "utf8")).toBeLessThan(64 * 1024);
    expect(JSON.stringify(ready)).not.toContain(cliToken);
    expect(JSON.stringify(ready)).not.toContain(controlToken);
    expect(new URL(ready.ws_url).pathname).toBe("/bridge/v1");
    expect(new URL(ready.http_connection_url).pathname).toBe("/bridge/v1/http/connections");

    await stopCli(child);
    await expect(fetch(ready.control_url)).rejects.toThrow();
    await assertListenerPortReleased(ready);
    expect(await persistedState(ready)).toMatchObject({ schemaVersion: 1 });
  }, 10_000);

  it("rejects unknown command-line options before opening a listener", async () => {
    const child = spawn(
      process.execPath,
      [cliPath, "--state", await statePath("unknown-argument"), "--bogus", "value"],
      { stdio: "pipe", windowsHide: true },
    );
    children.push(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    expect(code).toBe(1);
    expect(signal).toBeNull();
    expect(Buffer.concat(stdout).toString("utf8")).toBe("");
    expect(JSON.parse(Buffer.concat(stderr).toString("utf8"))).toEqual({
      event: "fatal",
      error: "unknown argument: --bogus",
    });
  });

  it("publishes readiness for the implemented RBP/2 and RBP/1 compatibility window", async () => {
    const { child, ready } = await startCli(
      "rbp2-window",
      ["--supported-protocols", "2,1"],
    );
    children.push(child);
    expect(ready).toMatchObject({
      event: "ready",
      protocol_versions: [2, 1],
    });
    expect(await stopCli(child)).toMatchObject({ code: 0 });
  });

  it("applies startup protocol/capability overrides and drives liveness from process control time", async () => {
    const { child, ready } = await startCli("deterministic-control", [
      "--supported-protocols", "1",
      "--connection-capabilities", "journal_v1,transport_streamable_http",
      "--session-capabilities", "doc_context_cached_v1",
      "--clock-start-ms", "0",
    ]);
    children.push(child);
    expect(ready).toMatchObject({
      protocol_versions: [1],
      deterministic_clock: true,
    });

    const createHello = hello(300);
    const created = await fetch(ready.http_connection_url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
        "x-rbp-versions": "1",
      },
      body: JSON.stringify(createHello),
    });
    expect(created.status).toBe(201);
    expect(await created.clone().json()).toMatchObject({
      type: "hello_ack",
      ts: "1970-01-01T00:00:00.000Z",
      payload: {
        protocol: 1,
        granted_capabilities: ["journal_v1", "transport_streamable_http"],
      },
    });
    const connectionId = created.headers.get("rbp-connection-id");
    expect(connectionId).not.toBeNull();
    const sse = await openSse(ready, connectionId!);

    try {
      const registration = sessionRegister();
      registration.machine.fingerprint = `sha256:${"0".repeat(64)}`;
      const response = await fetch(
        `${ready.http_connection_url}/${encodeURIComponent(connectionId!)}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${cliToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(controlEnvelope("session_register", registration, 301)),
        },
      );
      expect(response.status).toBe(202);
      const registered = await sse.next() as Extract<RbpEnvelope, { type: "session_registered" }>;
      expect(registered).toMatchObject({
        type: "session_registered",
        payload: { granted_session_capabilities: ["doc_context_cached_v1"] },
      });

      expect(await control(ready, { action: "set_clock", now_ms: 35_000 })).toEqual({ now_ms: 35_000 });
      expect(await control(ready, { action: "liveness_sweep" })).toEqual({ disconnected: [] });
      expect((await snapshot(ready)).sessions[registered.payload.rsid]).toMatchObject({ liveness: "degraded" });

      expect(await control(ready, { action: "set_clock", now_ms: 65_000 })).toEqual({ now_ms: 65_000 });
      expect(await control(ready, { action: "liveness_sweep" })).toEqual({ disconnected: [connectionId] });
      expect((await snapshot(ready)).sessions[registered.payload.rsid]).toMatchObject({ liveness: "disconnected" });
    } finally {
      await sse.close();
      await stopCli(child);
    }
  }, 15_000);

  it("survives 40 readiness-adjacent SIGTERM shutdowns without retaining listeners", async () => {
    const readiness: ReadyRecord[] = [];
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const started = await startCli(`sigterm-${iteration}`);
      children.push(started.child);
      readiness.push(started.ready);
      exits.push(await stopCli(started.child));
    }

    for (const exit of exits) expect(exit).toEqual({ code: 0, signal: null });
    await Promise.all(readiness.map(async (ready) => {
      await expect(fetch(ready.control_url)).rejects.toThrow();
      expect(await persistedState(ready)).toMatchObject({ schemaVersion: 1 });
    }));
    for (const ready of new Map(readiness.map((entry) => [new URL(entry.control_url).port, entry])).values()) {
      await assertListenerPortReleased(ready);
    }
  }, 60_000);

  it("shares one cleanup across sequential signals with active WSS and SSE transports", async () => {
    const { child, ready } = await startCli("active-signal-cleanup");
    children.push(child);
    const socket = new WebSocket(ready.ws_url, {
      headers: {
        authorization: `Bearer ${cliToken}`,
        "x-rbp-versions": "1",
      },
    });
    await new Promise<void>((resolveOpen, reject) => {
      socket.once("open", resolveOpen);
      socket.once("error", reject);
    });
    socket.on("error", () => undefined);
    const helloAck = new Promise<RbpEnvelope>((resolveMessage) => {
      socket.once("message", (data) => resolveMessage(JSON.parse(data.toString()) as RbpEnvelope));
    });
    socket.send(JSON.stringify(hello(400)));
    expect(await helloAck).toMatchObject({ type: "hello_ack", payload: { protocol: 1 } });

    const created = await fetch(ready.http_connection_url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json",
        "x-rbp-versions": "1",
      },
      body: JSON.stringify(hello(401)),
    });
    expect(created.status).toBe(201);
    const connectionId = created.headers.get("rbp-connection-id");
    expect(connectionId).not.toBeNull();
    const sse = await openSse(ready, connectionId!);

    try {
      const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
      if (process.platform === "win32") {
        expect(child.send({ action: "emit_test_signal", signal: "SIGINT" })).toBe(true);
        expect(child.send({ action: "emit_test_signal", signal: "SIGTERM" })).toBe(true);
      } else {
        expect(child.kill("SIGINT")).toBe(true);
        expect(child.kill("SIGTERM")).toBe(true);
      }
      const [code, signal] = await exited;
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      await expect(fetch(ready.control_url)).rejects.toThrow();
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      await sse.close();
    }
  }, 15_000);

  it("keeps the idempotent shutdown handler installed across same-signal bursts", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const { child, ready } = await startCli(`same-signal-${signal.toLowerCase()}`);
      children.push(child);
      const created = await fetch(ready.http_connection_url, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${cliToken}`,
          "content-type": "application/json",
          "x-rbp-versions": "1",
        },
        body: JSON.stringify(hello(signal === "SIGTERM" ? 500 : 510)),
      });
      expect(created.status).toBe(201);
      const connectionId = created.headers.get("rbp-connection-id");
      expect(connectionId).not.toBeNull();
      const sse = await openSse(ready, connectionId!);
      const registration = sessionRegister();
      registration.machine.fingerprint = `sha256:${"0".repeat(64)}`;
      const registrationAccepted = await fetch(
        `${ready.http_connection_url}/${encodeURIComponent(connectionId!)}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${cliToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(controlEnvelope(
            "session_register",
            registration,
            signal === "SIGTERM" ? 501 : 511,
          )),
        },
      );
      expect(registrationAccepted.status).toBe(202);
      const registered = await sse.next() as Extract<RbpEnvelope, { type: "session_registered" }>;
      try {
        const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
        if (process.platform === "win32") {
          expect(child.send({ action: "emit_test_signal", signal })).toBe(true);
          expect(child.send({ action: "emit_test_signal", signal })).toBe(true);
        } else {
          expect(child.kill(signal)).toBe(true);
          expect(child.kill(signal)).toBe(true);
        }
        const [code, exitSignal] = await exited;
        expect({ code, signal: exitSignal }).toEqual({ code: 0, signal: null });
        await expect(fetch(ready.control_url)).rejects.toThrow();
        await assertListenerPortReleased(ready);
        expect(await persistedState(ready)).toMatchObject({
          schemaVersion: 1,
          sessions: { [registered.payload.rsid]: { liveness: "disconnected" } },
        });
        const reopened = await GatewayStubCore.create({
          statePath: ready.state_path,
          tokenTable,
        });
        try {
          expect(reopened.snapshot().sessions).toMatchObject({
            [registered.payload.rsid]: { liveness: "disconnected" },
          });
        } finally {
          await reopened.close();
        }
      } finally {
        await sse.close();
      }
    }
  }, 15_000);
});
