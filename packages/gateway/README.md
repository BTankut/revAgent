# revAgent Gateway

This additive revAgent Gateway package retains the M0 transport spike and now
contains the first bounded M2 north/registry/dispatch slice. It mirrors the
existing runtime's TypeScript ESM conventions (`ES2022`, `NodeNext`, strict
mode). The Gateway package uses the split MCP TypeScript SDK v2 packages and
Zod 4; frozen packages under `installer/**` retain their independent v1 pins.

## M2 first north/registry/dispatch slice

The first M2 slice is additive and intentionally narrow:

- `GatewayToolRegistry` owns the north name, summary, version, policy class,
  exact `bridge|internal_mcp|aps` executor binding, executor method, and
  executable Zod input shape.
- The compact capability index is derived from the registry, name-sorted, and
  byte-stable. Schemas are marked `deferred`; this slice does not yet activate
  the `tool_search` or `tool_schema` meta-tools.
- `GatewayDispatcher` resolves policy and executor metadata from the registry;
  client arguments cannot choose either value. It revalidates direct calls
  against the registry Zod shape, blocks `confirm`/`gated` tools until policy
  middleware exists, and preserves completed/guarded/failed executor outcomes.
- `startNorthMcpEndpoint` uses one `McpServer` and
  `NodeStreamableHTTPServerTransport` per MCP session, authenticates every request
  through an injected fail-closed boundary, binds the session to one immutable
  principal, and exposes the same capability-index bytes as server
  instructions and `revagent://capability-index`.
- The integration test calls `core.ui.state` through the official MCP client,
  dispatcher, a test-only Bridge executor, the M1 Bridge simulator, and the
  add-in loopback fixture. `fixture_counter` is not a production registry tool.

This is not production OAuth readiness. The endpoint accepts only an injected
token verifier, requires an HTTPS protected-resource metadata URL, and remains
loopback-bound for this first proof. IdP/OIDC discovery, PKCE/DCR, JWKS
rotation, public TLS/proxy binding, the full 40-tool immutable registry,
Mode-A search/schema activation, docs-MCP internalization, confirmation,
durable RBP ingress, and Mode-B interface stubs remain separate M2 tasks.
The injected authenticator is contractually responsible for validating token
signature, expiry, audience/resource, scopes, revocation, and tenant/user
identity; the endpoint does not infer any of those from client claims.

The Gateway test command builds the existing workspace Bridge simulator before
Vitest and consumes only its public built surface. It does not add a production
runtime dependency or modify the frozen RBP/1 package.

## W1-5 transport spike

The spike reads the frozen legacy source tree without modifying it.
`scripts/bundle-legacy-register.mjs` bundles the existing
`installer/runtime-mcp-server/src/tools/register.ts` graph into ignored
Gateway build output, copies the runtime schemas needed during module
initialization, and leaves package imports external so they resolve from the
Gateway package. A Gateway-owned compatibility adapter maps that exact graph's
legacy `.tool()` registration calls onto the v2 `McpServer`;
`NodeStreamableHTTPServerTransport` then serves the catalog on loopback HTTP.
This exercises the planned transport swap at the existing runtime
`src/index.ts` lines 19-20 without retaining the monolithic v1 SDK in the
Gateway package. No Revit tool handler is invoked by the catalog probe.

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

Side finding for P3: the legacy runtime declares `ws` but its source has no `ws` import. The Gateway spike therefore does not carry that dependency; confirm and drop it during relocation rather than changing the frozen runtime now.
