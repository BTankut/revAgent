import { AddinLoopbackFixture } from "@revagent/addin-loopback-fixture";
import { afterEach, describe, expect, it } from "vitest";

import { readInvoke, simulatorForFixture, temporaryRoot, uuid } from "./helpers.js";

describe("Bridge add-in failure taxonomy", () => {
  const fixtures: AddinLoopbackFixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.stop();
  });

  it.each([
    { code: -32601 as const, expected: "unsupported" as const },
    { code: -32602 as const, expected: "parameter" as const },
  ])("maps JSON-RPC $code without losing the domain class", async ({ code, expected }) => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const envelope = readInvoke({ rsid, seq: 1 });
    fixture.planFault(envelope.payload.invocation_id, {
      jsonRpcError: { code, message: code === -32601 ? "method not found" : "invalid params" },
    });

    await expect(simulator.invoke(envelope)).resolves.toMatchObject({
      kind: "error",
      faultClass: expected,
      retryable: false,
      addinContacted: true,
    });
    expect(journal.getInvocation(rsid, envelope.payload.invocation_id)?.terminalOutcome?.payload)
      .toMatchObject({ fault_class: expected });

    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("keeps a reachable-idle deadline response as revit_timeout", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const envelope = readInvoke({ rsid, seq: 1 });
    fixture.planFault(envelope.payload.invocation_id, {
      jsonRpcError: { code: -32603, message: "deadline exceeded" },
    });

    await expect(simulator.invoke(envelope)).resolves.toMatchObject({
      kind: "error",
      faultClass: "revit_timeout",
      retryable: true,
      addinContacted: true,
    });
    expect(fixture.getMethodExecutionCount("mcp_status")).toBe(2);

    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("keeps other add-in domain failures as revit_api", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("fixture_failure", "read_only", () => ({
      state: "failed",
      error: { code: "command_failure", message: "fixture domain failure" },
    }));
    fixtures.push(fixture);
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const envelope = readInvoke({ rsid, seq: 1, method: "fixture_failure" });

    await expect(simulator.invoke(envelope)).resolves.toMatchObject({
      kind: "error",
      faultClass: "revit_api",
      retryable: false,
      addinContacted: true,
    });

    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("enriches a generic failure-shaped response as addin_unreachable when the status probe disconnects", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixture.registerHandler("fixture_failure", "read_only", () => ({
      state: "failed",
      error: { code: "command_failure", message: "fixture domain failure" },
    }));
    fixtures.push(fixture);
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    const envelope = readInvoke({ rsid, seq: 1, method: "fixture_failure" });
    fixture.planFault(`${envelope.payload.invocation_id}-failure-status`, { disconnect: "before_dispatch" });

    await expect(simulator.invoke(envelope)).resolves.toMatchObject({
      kind: "error",
      faultClass: "addin_unreachable",
      retryable: true,
      addinContacted: true,
    });
    expect(journal.getInvocation(rsid, envelope.payload.invocation_id)?.terminalOutcome?.payload)
      .toMatchObject({ fault_class: "addin_unreachable" });

    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("distinguishes a failed local status probe as addin_unreachable", async () => {
    const root = temporaryRoot();
    const fixture = new AddinLoopbackFixture();
    fixtures.push(fixture);
    const rsid = uuid();
    const { simulator, journal } = await simulatorForFixture({ fixture, root: root.path, rsid });
    await fixture.stop();
    const envelope = readInvoke({ rsid, seq: 1 });

    await expect(simulator.invoke(envelope)).resolves.toMatchObject({
      kind: "error",
      faultClass: "addin_unreachable",
      retryable: true,
      addinContacted: true,
    });
    expect(journal.getInvocation(rsid, envelope.payload.invocation_id)?.terminalOutcome?.payload)
      .toMatchObject({ fault_class: "addin_unreachable" });

    simulator.close();
    journal.close();
    root.cleanup();
  });
});
