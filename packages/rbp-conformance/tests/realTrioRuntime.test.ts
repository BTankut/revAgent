import { describe, expect, it } from "vitest";

import {
  callRealTrioNorthTool,
  realTrioNorthToolForCase,
} from "../src/realTrioCaseDriver.js";
import {
  buildRealTrioRuntimeFixture,
  startRealTrioRuntimeFixture,
} from "./realTrioRuntimeFixture.js";

describe.sequential("WP-12 direct real trio runtime fixture", () => {
  it.each(["wss", "streamable_http_sse"] as const)(
    "runs C38's public core UI probe against the real %s Worker binding",
    async (binding) => {
      buildRealTrioRuntimeFixture();
      const runtime = await startRealTrioRuntimeFixture(binding);
      try {
        const tool = realTrioNorthToolForCase("O1-C38");
        const result = await callRealTrioNorthTool({
          endpoint: runtime.endpoint,
          certificateSha256: runtime.certificateSha256,
          credential: runtime.credential,
          effectiveMcpSessionId: `wp12-c38-${binding}`,
          call: { toolName: tool.toolName, args: {}, requestId: `wp12-c38-${binding}` },
        });
        expect(result.state).toBe("completed");
        expect(result.commit).toBeNull();
        const audit = await runtime.supervisor.readRealCaseAudit();
        expect(audit).toMatchObject({ ok: true, action: "read_real_case_audit" });
      } finally {
        await runtime.stop();
      }
    },
    240_000,
  );
});
