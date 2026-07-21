import { describe, expect, it } from "vitest";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { gatewayScaffold } from "./index.js";

describe("gateway scaffold", () => {
  it("keeps transport implementation outside W1-2", () => {
    expect(gatewayScaffold).toMatchObject({
      milestone: "M0",
      protocol: "RBP/1",
      transportImplemented: false,
    });
  });

  it("loads the pinned MCP SDK Streamable HTTP transport surface", () => {
    expect(StreamableHTTPServerTransport).toBeTypeOf("function");
  });
});
