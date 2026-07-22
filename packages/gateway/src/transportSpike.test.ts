import { request as requestHttp } from "node:http";

import { describe, expect, it } from "vitest";

import { measureToolCatalog } from "./toolListProbe.js";
import { startTransportSpike } from "./transportSpike.js";

describe("W1-5 Streamable HTTP transport spike", () => {
  it("lists the existing 35-tool runtime catalog through an external MCP client", async () => {
    const spike = await startTransportSpike();

    try {
      const measurement = await measureToolCatalog(spike.endpoint, 3);
      expect(measurement.observedToolCount).toBe(35);
      expect(new Set(measurement.toolNames).size).toBe(35);
      expect(measurement.toolNames).toContain("get_revit_mcp_status");
      expect(measurement.toolNames).toContain("inspect_schedules");
      expect(measurement.toolNames).toContain("summarize_spatial_state");
      expect(measurement.listTools.iterations).toBe(3);
    } finally {
      await spike.close();
    }
  }, 30_000);

  it("rejects a non-loopback Host header before the MCP transport", async () => {
    const spike = await startTransportSpike();

    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      const response = await new Promise<{ statusCode: number; body: string }>(
        (resolve, reject) => {
          const request = requestHttp(
            spike.endpoint,
            {
              headers: {
                accept: "application/json, text/event-stream",
                "content-length": Buffer.byteLength(body),
                "content-type": "application/json",
                host: "attacker.invalid",
              },
              method: "POST",
            },
            (incoming) => {
              const chunks: Buffer[] = [];
              incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
              incoming.on("end", () => {
                resolve({
                  statusCode: incoming.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                });
              });
            },
          );
          request.once("error", reject);
          request.end(body);
        },
      );
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: "invalid_host" });
    } finally {
      await spike.close();
    }
  });
});
