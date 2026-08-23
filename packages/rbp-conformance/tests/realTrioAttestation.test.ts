import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  assertRealBridgeWorkerExecutable,
  validateRealTrioAttestation,
  type RealTrioAttestation,
} from "../src/realTrioAttestation.js";

const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;

function evidence(worker: string): RealTrioAttestation {
  return {
    schemaVersion: "rbp-real-trio-attestation/v1",
    bindings: ["wss", "streamable_http_sse"],
    components: ["gateway", "bridge_worker", "addin_loopback_fixture"].map((componentId, index) => ({
      componentId: componentId as "gateway" | "bridge_worker" | "addin_loopback_fixture",
      executablePath: componentId === "bridge_worker" ? worker : process.execPath,
      executableSha256: digest,
      pid: index + 1,
      exitCode: 0,
      stdoutSha256: digest,
      stderrSha256: digest,
    })),
    csharpPublishSha256: digest,
    gatewayBuildSha256: digest,
    fixtureBuildSha256: digest,
  };
}

describe("WP-12 real trio attestation", () => {
  it("requires the published C# worker and both real transport bindings", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-real-trio-"));
    const worker = path.join(root, "revagent-bridge.exe");
    writeFileSync(worker, "published C# worker bytes\n", "utf8");
    expect(assertRealBridgeWorkerExecutable(worker)).toBe(worker);
    expect(() => validateRealTrioAttestation(evidence(worker))).not.toThrow();
  });

  it("rejects a simulator or a non-zero worker exit as real-trio evidence", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-real-trio-"));
    const simulator = path.join(root, "bridge-simulator.exe");
    writeFileSync(simulator, "not a C# worker\n", "utf8");
    expect(() => assertRealBridgeWorkerExecutable(simulator)).toThrow(/identity/u);

    const worker = path.join(root, "revagent-bridge.exe");
    writeFileSync(worker, "published C# worker bytes\n", "utf8");
    const invalid = evidence(worker) as { components: Array<{ exitCode: number }> };
    invalid.components[1]!.exitCode = 1;
    expect(() => validateRealTrioAttestation(invalid as RealTrioAttestation)).toThrow(/process evidence/u);
  });
});
