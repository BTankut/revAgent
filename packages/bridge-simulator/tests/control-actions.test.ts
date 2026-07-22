import { join } from "node:path";

import {
  makeParamsDigest,
  type InvocationJournalBinding,
} from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import { BridgeDaemonRuntime } from "../src/control.js";
import { DurableBridgeJournal } from "../src/journal.js";
import { temporaryRoot, uuid } from "./helpers.js";

describe("Bridge daemon journal controls", () => {
  it("records and resolves durable late evidence, then emits its exact clearance", async () => {
    const root = temporaryRoot();
    const rsid = uuid();
    const originInvocationId = uuid();
    const evidenceDigest = `sha256:${"b".repeat(64)}`;
    const binding: InvocationJournalBinding = {
      rsid,
      invocationId: originInvocationId,
      method: "set_element_parameter",
      mutating: true,
      mutationScope: { kind: "document", document_id: "doc-late-control" },
      paramsDigest: makeParamsDigest({ element_id: 42 }),
      policy: {
        class: "confirm",
        decision: "confirmed",
        confirmation_id: "late-control-confirmation",
      },
      verification: null,
      recoveryClearances: [],
    };
    const journal = new DurableBridgeJournal(join(root.path, "bridge.db"));
    expect(journal.acceptInvocation(binding, `sha256:${"1".repeat(64)}`).kind).toBe("accepted");
    journal.markExecuting(rsid, originInvocationId, 1_721_600_000_000);
    const indeterminate = journal.markIndeterminate(rsid, originInvocationId, 1_721_600_000_001);
    const holdId = indeterminate.verificationHoldId as string;
    journal.recordTerminal(rsid, originInvocationId, {
      status: "completed",
      payloadRetained: true,
      payload: { committed: true },
      resultDigest: evidenceDigest,
    }, 1_721_600_000_002);
    journal.close();

    const runtime = new BridgeDaemonRuntime(root.path);
    const recorded = await runtime.execute({
      controlVersion: 1,
      id: "late-evidence",
      action: "record_late_evidence",
      rsid,
      holdId,
      originInvocationId,
      evidenceDigest,
      conclusion: "postcondition_verified",
      atMs: 1_721_600_000_003,
    }, "late-evidence");
    expect(recorded.value).toMatchObject({
      recorded: true,
      hold: {
        holdId,
        state: "evidence_recorded",
        evidenceAttemptCount: 1,
        selectedEvidence: { basis: "late_terminal", evidenceDigest },
      },
    });

    const authorizedDispatchIdentity = `sha256:${"2".repeat(64)}`;
    const resolved = await runtime.execute({
      controlVersion: 1,
      id: "late-resolution",
      action: "resolve_hold",
      rsid,
      holdId,
      basis: "late_terminal",
      verificationInvocationId: null,
      evidenceDigest,
      decision: "postcondition_verified",
      resolutionId: uuid(),
      auditId: uuid(),
      authorizedDispatchIdentity,
      atMs: 1_721_600_000_004,
    }, "late-resolution");
    expect(resolved.value).toMatchObject({
      resolved: true,
      hold: {
        holdId,
        state: "resolved_pending_bridge",
        resolution: { basis: "late_terminal", verificationInvocationId: null },
      },
    });

    const clearance = await runtime.execute({
      controlVersion: 1,
      id: "late-clearance",
      action: "clearance_for_hold",
      rsid,
      holdId,
    }, "late-clearance");
    expect(clearance.value).toMatchObject({
      clearance: {
        hold_id: holdId,
        basis: "late_terminal",
        verification_invocation_id: null,
        evidence_digest: evidenceDigest,
        decision: "postcondition_verified",
      },
    });
    await runtime.shutdown();
    root.cleanup();
  });
});
