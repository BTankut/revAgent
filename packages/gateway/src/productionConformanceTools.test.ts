import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildConfirmationPreviewProjection } from "./confirmation.js";
import {
  MUTATION_PROBE_CONFORMANCE_TOOL_RECORDS,
  MUTATION_PROBE_TOOL_NAMES,
  productionConformanceCatalog,
  PRODUCTION_CONFORMANCE_TOOL_RECORDS,
} from "./productionConformanceTools.js";
import { GatewayToolRegistry, M2_BOOTSTRAP_TOOL_RECORDS } from "./registry.js";

describe("WP-12 production-conformance tools", () => {
  it("mounts fixed fixture tools only in the explicit conformance registry", () => {
    const defaultRegistry = new GatewayToolRegistry(M2_BOOTSTRAP_TOOL_RECORDS);
    const conformanceRegistry = new GatewayToolRegistry([
      ...M2_BOOTSTRAP_TOOL_RECORDS,
      ...PRODUCTION_CONFORMANCE_TOOL_RECORDS,
    ]);
    for (const tool of PRODUCTION_CONFORMANCE_TOOL_RECORDS) {
      expect(defaultRegistry.get(tool.name)).toBeUndefined();
      expect(conformanceRegistry.require(tool.name).executorMethod).toBe(tool.executorMethod);
    }
    expect(productionConformanceCatalog(
      conformanceRegistry.require("core.ui.state"),
      conformanceRegistry.require("core.dispatch.payload_recovery"),
    )
      .map((entry) => entry.name)).toEqual([
      "conformance.fixture.c28_mutation",
      "conformance.fixture.c29_atomic_batch",
      "conformance.fixture.c39_multifile",
      "core.dispatch.payload_recovery",
      "core.ui.state",
    ]);
  });

  it("admits C39 only as the normal fixed-argument recovery tool", () => {
    const registry = new GatewayToolRegistry(M2_BOOTSTRAP_TOOL_RECORDS);
    const recovery = registry.require("core.dispatch.payload_recovery");
    expect(recovery).toMatchObject({ policyClass: "auto", mutationScopePolicy: "none", executorMethod: "dispatch_payload_recovery" });
    expect(() => productionConformanceCatalog(registry.require("core.ui.state"), {
      ...recovery, name: "conformance.fixture.c39_multifile",
    })).toThrow(/exact normal C39 recovery record/u);
  });

  it("rejects arbitrary C28 code and non-fixture C29/C39 shapes at the executable boundary", () => {
    const registry = new GatewayToolRegistry([
      ...M2_BOOTSTRAP_TOOL_RECORDS,
      ...PRODUCTION_CONFORMANCE_TOOL_RECORDS,
    ]);
    const c28 = z.object(registry.require("conformance.fixture.c28_mutation").inputSchema).strict();
    expect(c28.safeParse({ vector: "O1-C28", fixtureOnly: true }).success).toBe(true);
    expect(c28.safeParse({ vector: "O1-C28", fixtureOnly: true, code: "return 1;" }).success).toBe(false);

    const c29 = z.object(registry.require("conformance.fixture.c29_atomic_batch").inputSchema).strict();
    expect(c29.safeParse({
      batchContractVersion: 1,
      batchId: "018f0d2e-9c45-7e91-8d33-1a2b3c4d5e6f",
      batchDigest: `sha256:${"a".repeat(64)}`,
      atomic: true,
      rollbackPolicy: "rollback_on_non_success",
      maxAggregateResultBytes: 1024,
      steps: [{
        index: 0,
        invocationId: "018f0d2e-9c46-7e91-8d33-1a2b3c4d5e6f",
        method: "delete_review_view",
        params: { viewName: "revAgent_QA_WP12_fixture", exactName: true, mode: "commit", confirmDelete: true },
        paramsDigest: `sha256:${"b".repeat(64)}`,
        effect: "model_transaction",
      }],
    }).success).toBe(true);
    expect(c29.safeParse({ steps: [] }).success).toBe(false);

    const c39 = z.object(registry.require("conformance.fixture.c39_multifile").inputSchema).strict();
    expect(c39.safeParse({ scenario: "valid_multifile", fileCount: 2, bytesPerFile: 64, contentType: "application/octet-stream" }).success).toBe(true);
    expect(c39.safeParse({ scenario: "traversal_path", fileCount: 2, bytesPerFile: 64, contentType: "application/octet-stream" }).success).toBe(false);
  });

  it("uses a read-only preview before C28/C29 commit confirmation", () => {
    const registry = new GatewayToolRegistry([
      ...M2_BOOTSTRAP_TOOL_RECORDS,
      ...PRODUCTION_CONFORMANCE_TOOL_RECORDS,
    ]);
    for (const name of ["conformance.fixture.c28_mutation", "conformance.fixture.c29_atomic_batch"] as const) {
      const projection = buildConfirmationPreviewProjection(registry.require(name),
        name.endsWith("c28_mutation")
          ? { vector: "O1-C28", fixtureOnly: true }
          : {
            batchContractVersion: 1,
            batchId: "018f0d2e-9c45-7e91-8d33-1a2b3c4d5e6f",
            batchDigest: `sha256:${"a".repeat(64)}`,
            atomic: true, rollbackPolicy: "rollback_on_non_success", maxAggregateResultBytes: 1024,
            steps: [],
          });
      expect(projection).toMatchObject({ ok: true, previewExecutorMethod: "get_ui_state", previewArgs: {} });
    }
  });

  it("keeps mutation-probe tools strict-empty and profile-only", () => {
    const defaultRegistry = new GatewayToolRegistry([
      ...M2_BOOTSTRAP_TOOL_RECORDS,
      ...PRODUCTION_CONFORMANCE_TOOL_RECORDS,
    ]);
    const profileRegistry = new GatewayToolRegistry([
      ...M2_BOOTSTRAP_TOOL_RECORDS,
      ...PRODUCTION_CONFORMANCE_TOOL_RECORDS,
      ...MUTATION_PROBE_CONFORMANCE_TOOL_RECORDS,
    ]);
    for (const tool of MUTATION_PROBE_CONFORMANCE_TOOL_RECORDS) {
      expect(defaultRegistry.get(tool.name)).toBeUndefined();
      const schema = z.object(profileRegistry.require(tool.name).inputSchema).strict();
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ expected: true }).success).toBe(false);
    }
    for (const name of [MUTATION_PROBE_TOOL_NAMES.origin, MUTATION_PROBE_TOOL_NAMES.next]) {
      expect(buildConfirmationPreviewProjection(profileRegistry.require(name), {})).toMatchObject({
        ok: true,
        previewExecutorMethod: "get_ui_state",
        previewArgs: {},
        commitArgs: {},
      });
    }
    expect(productionConformanceCatalog(
      profileRegistry.require("core.ui.state"),
      profileRegistry.require("core.dispatch.payload_recovery"),
      MUTATION_PROBE_CONFORMANCE_TOOL_RECORDS,
    ).map((entry) => entry.name)).toEqual(expect.arrayContaining([
      MUTATION_PROBE_TOOL_NAMES.origin,
      MUTATION_PROBE_TOOL_NAMES.verify,
      MUTATION_PROBE_TOOL_NAMES.next,
    ]));
  });
});
