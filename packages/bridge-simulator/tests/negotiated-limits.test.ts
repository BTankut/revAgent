import { Buffer } from "node:buffer";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { AddinLoopbackFixture } from "@revagent/addin-loopback-fixture";
import {
  makeBatchDigest,
  makeParamsDigest,
  type InvokeBatchEnvelope,
  type JsonValue,
} from "@revagent/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { atomicBatch, readInvoke, simulatorForFixture, temporaryRoot, uuid } from "./helpers.js";

describe("negotiated Bridge limits", () => {
  const fixtures: AddinLoopbackFixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.stop();
  });

  it("applies lowered params, result, artifact, and partial limits before durable delivery", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("fixture_structured_limit", "read_only", () => ({
      blob: "x".repeat(100),
    }));
    fixture.registerHandler("fixture_artifact_limit", "read_only", () => ({
      files: [{
        fileName: "bounded.bin",
        contentType: "application/octet-stream",
        contentBase64: Buffer.alloc(80, 7).toString("base64"),
      }],
    }));
    fixture.registerHandler("fixture_chunk_limit", "read_only", () => ({
      blob: "x".repeat(40),
    }));
    fixtures.push(fixture);
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    simulator.applyNegotiatedLimits({ maxParamsBytes: 16, maxResultBytes: 64, maxPartialBytes: 8 });

    const params = readInvoke({ rsid, seq: 1, params: { blob: "x".repeat(20) } });
    await expect(simulator.invoke(params)).resolves.toMatchObject({
      kind: "error",
      faultClass: "oversize",
      addinContacted: false,
    });
    expect(journal.getInvocation(rsid, params.payload.invocation_id)).toBeNull();
    expect(fixture.getExecutionCount(params.payload.invocation_id)).toBe(0);

    const structured = readInvoke({ rsid, seq: 1, method: "fixture_structured_limit" });
    await expect(simulator.invoke(structured)).resolves.toMatchObject({
      kind: "error",
      faultClass: "oversize",
      addinContacted: true,
    });
    await expect(simulator.invoke(structured)).resolves.toMatchObject({
      kind: "error",
      faultClass: "oversize",
      replayed: true,
      addinContacted: false,
    });

    const artifact = readInvoke({ rsid, seq: 2, method: "fixture_artifact_limit" });
    await expect(simulator.invoke(artifact)).resolves.toMatchObject({
      kind: "error",
      faultClass: "oversize",
      addinContacted: true,
    });
    const spool = join(root.path, "spool");
    expect(existsSync(join(spool, artifact.payload.invocation_id))).toBe(false);

    simulator.applyNegotiatedLimits({ maxParamsBytes: 16, maxResultBytes: 128, maxPartialBytes: 8 });
    const chunked = readInvoke({ rsid, seq: 3, method: "fixture_chunk_limit" });
    const outcome = await simulator.invoke(chunked);
    expect(outcome).toMatchObject({ kind: "result", status: "completed" });
    if (outcome.kind !== "result") throw new Error("chunk test did not complete");
    expect(outcome.partials.length).toBeGreaterThan(1);
    expect(outcome.partials.every((partial) => Buffer.from(partial.data, "base64").byteLength <= 8)).toBe(true);
    expect(readdirSync(spool).every((name) => name !== artifact.payload.invocation_id)).toBe(true);

    const originalBatch = atomicBatch(rsid, 4);
    const oversizedStepParams = { blob: "x".repeat(20) };
    const firstStep = originalBatch.payload.steps[0];
    const steps: InvokeBatchEnvelope["payload"]["steps"] = [{
      ...firstStep,
      params: oversizedStepParams,
      params_digest: makeParamsDigest(oversizedStepParams),
    }, ...originalBatch.payload.steps.slice(1)];
    const batch: InvokeBatchEnvelope = {
      ...originalBatch,
      payload: {
        ...originalBatch.payload,
        steps,
        batch_digest: makeBatchDigest({
          atomic: true,
          batch_id: originalBatch.payload.batch_id,
          recovery_clearances: [],
          steps: steps.map((step) => ({
            invocation_id: step.invocation_id,
            method: step.method,
            mutating: step.mutating,
            mutation_scope: step.mutation_scope as unknown as JsonValue,
            params_digest: step.params_digest,
            policy: step.policy,
          })),
          timeout_ms: originalBatch.payload.timeout_ms,
        }),
      },
    };
    await expect(simulator.invokeBatch(batch)).resolves.toMatchObject({
      kind: "error",
      faultClass: "oversize",
    });
    expect(journal.getBatchCoordination(batch.payload.batch_id)).toBeNull();
    expect(fixture.getExecutionCount(batch.payload.batch_id)).toBe(0);

    simulator.close();
    journal.close();
    root.cleanup();
  });
});
