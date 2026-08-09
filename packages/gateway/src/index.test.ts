import { describe, expect, it } from "vitest";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { gatewayScaffold } from "./index.js";

describe("gateway scaffold", () => {
  it("carries no M0 transport spike and declares the collected registry seed", () => {
    // GW-1 removed the W1-5 spike and the `bundle:legacy` graph it loaded:
    // the Gateway must never import the legacy stdio entry point or an M0
    // bundle, so the seed is the only legacy-derived input it declares.
    expect(gatewayScaffold).toMatchObject({
      milestone: "M2",
      protocol: "RBP/1",
      transportImplemented: false,
      registrySeedAvailable: true,
      m2FirstSliceAvailable: true,
      invocationAuthorityAvailable: true,
      modeADiscoveryAvailable: true,
    });
    expect(gatewayScaffold).not.toHaveProperty("transportSpikeAvailable");
  });

  it("loads the split MCP SDK v2 Node transport surface", () => {
    expect(NodeStreamableHTTPServerTransport).toBeTypeOf("function");
  });
});
