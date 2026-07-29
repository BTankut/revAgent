import { describe, expect, it } from "vitest";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { gatewayScaffold } from "./index.js";

describe("gateway scaffold", () => {
  it("keeps the W1-5 transport spike separate from production transport", () => {
    expect(gatewayScaffold).toMatchObject({
      milestone: "M0",
      protocol: "RBP/1",
      transportImplemented: false,
      transportSpikeAvailable: true,
      m2FirstSliceAvailable: true,
      modeADiscoveryAvailable: true,
    });
  });

  it("loads the split MCP SDK v2 Node transport surface", () => {
    expect(NodeStreamableHTTPServerTransport).toBeTypeOf("function");
  });
});
