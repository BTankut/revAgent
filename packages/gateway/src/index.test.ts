import { describe, expect, it } from "vitest";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { gatewayScaffold } from "./index.js";

describe("gateway scaffold", () => {
  it("keeps the W1-5 transport spike separate from production transport", () => {
    expect(gatewayScaffold).toMatchObject({
      milestone: "M0",
      protocol: "RBP/1",
      transportImplemented: false,
      transportSpikeAvailable: true,
      m2FirstSliceAvailable: true,
    });
  });

  it("loads the pinned MCP SDK Streamable HTTP transport surface", () => {
    expect(StreamableHTTPServerTransport).toBeTypeOf("function");
  });
});
