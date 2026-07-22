# revAgent Gateway

This is the additive M0 package boundary for the revAgent Gateway. It mirrors the existing runtime's TypeScript ESM conventions (`ES2022`, `NodeNext`, strict mode) and pins the same MCP SDK major.

## W1-5 transport spike

The spike reads the frozen legacy source tree without modifying it. `scripts/bundle-legacy-register.mjs` bundles the existing `installer/runtime-mcp-server/src/tools/register.ts` graph into ignored Gateway build output, copies the runtime schemas needed during module initialization, and leaves package imports external so they resolve from the Gateway package. The server then connects that exact `registerTools` export to `StreamableHTTPServerTransport` on loopback HTTP. This exercises the planned transport swap at the existing runtime `src/index.ts` lines 19-20. No Revit tool handler is invoked by the catalog probe.

Build and run the one-client spike server:

```powershell
npm run build --workspace @revagent/gateway
npm run spike:server --workspace @revagent/gateway -- 43128
```

From a second process, list the catalog through the official MCP client transport:

```powershell
npm run spike:list-tools --workspace @revagent/gateway -- http://127.0.0.1:43128/mcp
```

Reproduce the loopback baseline (25 `tools/list` requests by default):

```powershell
npm run spike:benchmark --workspace @revagent/gateway -- 25
```

The measured baseline and limitations are recorded in `docs/benchmarks/W1-5-transport-spike.md`. The spike is intentionally loopback-only, stateful, single-client, unauthenticated, and JSON-response-only. It is not the M2 production Gateway transport, bridge dispatch, or an authorization surface.

### Temporary M0 legacy dependency carry

The spike keeps these dependencies in `@revagent/gateway` only because the bundled frozen registration graph
imports them during module loading:

- `better-sqlite3`
- `@e965/xlsx`
- `csv-parse`

They are not accepted as M2 Gateway ownership. M2 MUST remove all three from the Gateway package and root
lockfile when the legacy registration graph is replaced by executor/package boundaries. If an M2 capability
still needs equivalent functionality, it must add a deliberately owned dependency behind the relevant
spatial or file-ingress design; the spike pins must not be retained silently.

The MCP SDK 1.29 dependency graph currently includes `@hono/node-server` 1.19.x. GitHub advisory GHSA-frvp-7c67-39w9 affects that package's Windows-only `serve-static` helper; this spike exposes no static-file handler and uses only the SDK's Node request adapter. A forced 2.x override is intentionally avoided because it produces an invalid semver tree. Upgrade remains pending an SDK-compatible patched range.

Side finding for P3: the legacy runtime declares `ws` but its source has no `ws` import. The Gateway spike therefore does not carry that dependency; confirm and drop it during relocation rather than changing the frozen runtime now.
