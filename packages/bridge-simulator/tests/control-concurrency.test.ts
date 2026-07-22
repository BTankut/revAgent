import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  BridgeDaemonRuntime,
  BridgeJsonlControl,
} from "../src/control.js";

interface JsonObject {
  [key: string]: unknown;
}

describe("Bridge JSONL control scheduling", () => {
  it("runs independent requests concurrently, orders writes, and barriers shutdown", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const started: string[] = [];
    const records: JsonObject[] = [];
    let outputBuffer = Buffer.alloc(0);
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let shutdownStarted = false;
    let shutdownNotified = false;
    const runtime = {
      execute: async (_record: JsonObject, id: string) => {
        started.push(id);
        if (id === "slow") await slow;
        return { value: { completed: id }, shutdown: false };
      },
      shutdown: async () => {
        shutdownStarted = true;
        return { stopped: true };
      },
    } as unknown as BridgeDaemonRuntime;
    output.on("data", (chunk: Buffer) => {
      outputBuffer = outputBuffer.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([outputBuffer, chunk]);
      let newline = outputBuffer.indexOf(0x0a);
      while (newline >= 0) {
        records.push(JSON.parse(outputBuffer.subarray(0, newline).toString("utf8")) as JsonObject);
        outputBuffer = outputBuffer.subarray(newline + 1);
        newline = outputBuffer.indexOf(0x0a);
      }
    });

    const control = new BridgeJsonlControl(runtime, input, output, () => {
      shutdownNotified = true;
    });
    control.start();
    input.write([
      JSON.stringify({ controlVersion: 1, id: "slow", action: "invoke_local" }),
      JSON.stringify({ controlVersion: 1, id: "fast", action: "clearance_for_hold" }),
      JSON.stringify({ controlVersion: 1, id: "stop", action: "shutdown" }),
      JSON.stringify({ controlVersion: 1, id: "after", action: "invoke_local" }),
      "",
    ].join("\n"));

    await vi.waitFor(() => expect(started).toEqual(["slow", "fast"]));
    expect(records).toHaveLength(0);
    expect(shutdownStarted).toBe(false);

    releaseSlow?.();
    await vi.waitFor(() => expect(records).toHaveLength(3));
    expect(records.map((record) => record.id)).toEqual(["slow", "fast", "stop"]);
    expect(records.every((record) => record.ok === true)).toBe(true);
    expect(shutdownStarted).toBe(true);
    expect(shutdownNotified).toBe(true);
    await control.stopAndDrain();
    expect(started).toEqual(["slow", "fast"]);
    expect(records.map((record) => record.id)).not.toContain("after");
    input.destroy();
    output.destroy();
  });
});
