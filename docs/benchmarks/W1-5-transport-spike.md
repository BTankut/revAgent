# revAgent W1-5 Streamable HTTP Transport Spike Baseline

**Milestone:** M0

**Recorded:** 2026-07-21T22:59:20.453Z

**Status:** exploratory evidence; not a production SLA

## Result

An official MCP TypeScript SDK client connected over loopback Streamable HTTP and listed all **35** tools registered by the existing `installer/runtime-mcp-server/src/tools/register.ts` catalog. An additional second-process client/server run also returned the same 35 unique tool names.

| Measurement | Result |
|---|---:|
| MCP initialize/connect | 30.803 ms |
| `tools/list` iterations | 25 |
| `tools/list` minimum | 3.918 ms |
| `tools/list` mean | 6.559 ms |
| `tools/list` p50 | 5.994 ms |
| `tools/list` p95 | 13.946 ms |
| `tools/list` maximum | 18.240 ms |
| Observed / expected tools | 35 / 35 |

The separate-process cold proof measured 55.708 ms for connect and 24.602 ms for its first `tools/list` request. It exited zero after asserting a 35-tool response.

## Method

- Workstation: Windows x64, Node.js v22.22.2.
- Endpoint: ephemeral `127.0.0.1` port, `/mcp` path.
- Transport: `StreamableHTTPServerTransport` and `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk` 1.29.0, JSON response mode.
- Catalog source: the frozen runtime `registerTools` graph, bundled read-only into ignored Gateway build output.
- One MCP client connection was retained while 25 sequential `tools/list` calls were timed with `performance.now()`.
- The automated integration test also checks 35 unique names and rejects a non-loopback Host header with HTTP 403.

Reproduce after `npm run build`:

```powershell
npm run spike:benchmark --workspace @revagent/gateway -- 25
```

## Interpretation and limits

This proves the M0 transport seam and catalog parity only. The measurement excludes network transit, OAuth, tenant policy, persistence, audit writes, orchestration, bridge routing, and Revit execution. It uses a single stateful client because the spike is not a production session router. Do not use these loopback numbers as a user-facing latency budget or Phase-1 capacity claim.

The SDK's transitive `@hono/node-server` 1.19.x dependency has moderate advisory GHSA-frvp-7c67-39w9 in its Windows `serve-static` helper. This spike does not register or call `serve-static`; the advisory remains visible pending an SDK-compatible patched dependency range.
