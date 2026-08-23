import { describe, expect, it } from "vitest";

import {
  callRealTrioNorthTool,
  realTrioNorthToolForCase,
} from "../src/realTrioCaseDriver.js";
import { runRealTrioCli } from "../src/realTrioCli.js";
import {
  buildRealTrioRuntimeFixture,
  startRealTrioRuntimeFixture,
} from "./realTrioRuntimeFixture.js";

describe.sequential("WP-12 direct real trio runtime fixture", () => {
  it.each(["wss", "streamable_http_sse"] as const)(
    "runs C38's public core UI probe against the real %s Worker binding",
    async (binding) => {
      buildRealTrioRuntimeFixture();
      const launched = await runRealTrioCli(["real-trio", binding], startRealTrioRuntimeFixture);
      const runtime = launched.result;
      try {
        const tool = realTrioNorthToolForCase("O1-C38");
        const result = await callRealTrioNorthTool({
          endpoint: runtime.endpoint,
          certificateSha256: runtime.certificateSha256,
          credential: runtime.credential,
          call: { toolName: tool.toolName, args: {}, requestId: `wp12-c38-${binding}` },
        });
        expect(result.state).toBe("completed");
        expect(result.commit).toBeNull();
        const audit = await runtime.supervisor.readRealCaseAudit();
        expect(audit).toMatchObject({ ok: true, action: "read_real_case_audit" });
        expect(audit.documentContextUpdates).toEqual([
          expect.objectContaining({
            contractVersion: "revagent.wp12-document-context-audit/v1",
            event: "gateway.doc_context_update_observation",
            stage: "accepted",
            rsidDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            routeDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          }),
        ]);
      } finally {
        await runtime.stop();
      }
    },
    240_000,
  );
});
