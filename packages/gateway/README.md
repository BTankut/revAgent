# revAgent Gateway

This additive revAgent Gateway package retains the M0 transport spike and now
contains the M2 north/registry/dispatch surface, the GW-1 through GW-3
foundations it consumes, and the GW-4/GW-8/GW-10/GW-12/GW-13 vertical slices.
It mirrors the existing runtime's TypeScript ESM conventions (`ES2022`,
`NodeNext`, strict mode). The Gateway package uses the split MCP TypeScript SDK
v2 packages and Zod 4; frozen packages under `installer/**` retain their
independent v1 pins.

## GW-13 readiness evidence

`npm run readiness:gw13 --workspace @revagent/gateway` runs the deterministic
server-observable halves of WP9 C01-C14 and writes
`packages/gateway/artifacts/gw13-readiness.json`. Gateway CI uploads that JSON
as an exact-head artifact. The report is deliberately `authoritative:false`:
fixture identity cannot pass OAuth, hands-on client/UX/file/Revit observations
remain WP9 work, and P6-T1 evidence may move from `passed` to `accepted` only by
the milestone decision owner.

The post-M3/M5 live-smoke command can be configuration-checked without making
a network request:

```powershell
npm run smoke:gw13 --workspace @revagent/gateway -- --endpoint https://gateway.example/mcp --client selected-codex-desktop --client-build post-m3-m5 --target NET01 --token-env REVAGENT_GW13_SMOKE_TOKEN
```

Adding `--execute` performs only the server-observable north-MCP checks using
the named environment variable; it never prints the bearer token and does not
claim OAuth, client UX, file opening, or live-Revit acceptance.

## M2 north/registry/dispatch vertical slice

GW-10 implements the Mode-A north discovery and production-code Fastify mount:

- The verified 40-tool seed and E5 binding table build the immutable catalog;
  one `EntitledCatalogView` is the sole source for the principal's north MCP
  instructions and `revagent://capability-index` resource. The index is
  name-sorted and byte-stable, and every schema remains `deferred`.
- `buildGatewayExecutableRegistry` materializes all 40 reviewed tools from the
  verified registry seed, removes only the seven Gateway-authored root input
  fields, and fails closed if executable and catalog metadata disagree. The
  five `core.docs.*` tools retain their `internal_mcp` executor binding.
- `tool_search` searches only the entitled index. `tool_schema` returns and
  activates only entitled schemas. The four P-GW-7 tools are pinned; other
  schemas live in a bounded, session-sticky LRU and activation/eviction emits
  `notifications/tools/list_changed` through the SDK subscription bus.
- `GatewayDispatcher` resolves policy and executor metadata from the registry;
  client arguments cannot choose either value. It revalidates direct calls
  against the registry Zod shape, delegates confirmation to the GW-8 policy
  middleware, and preserves completed/guarded/failed executor outcomes.
- `createNorthMcpHttpHandler` owns authentication, entitlement projection,
  request-state verification, discovery state, dispatch, audit correlation,
  and graceful drain. `createGatewayApp` mounts that handler directly at
  `/mcp` when composed; without it the route remains a structured fail-closed
  503. `startNorthMcpEndpoint` remains the loopback proof wrapper around the
  same handler, not a second implementation.
- The GW-10 conformance test uses the official modern MCP client against the
  Fastify `/mcp` route. It proves the exact entitled index, initial meta+pinned
  set, runtime/docs search and activation, LRU eviction plus list-change
  delivery, calls through both `bridge` and `internal_mcp`, and fail-closed
  unentitled search/schema/direct-call behavior with actor/audit correlation.

## GW-4 invocation-authority vertical slice

The dispatcher now receives a structured `AuthContext` and an explicit
tenant/MCP-session/`rsid` route instead of inferring identity from a principal
string. It rejects cross-tenant or cross-session routes before executor
contact, carries RES-14 live or published document identity, computes a
frozen-RBP RFC 8785 SHA-256 parameter digest, uses UUIDv7 invocation/event
identities, and publishes the resulting context through `AsyncLocalStorage`
while the executor runs. Mutation scope uses the exact RBP shape (`null`,
`session`, or `document_id`). A north AuthContext whose
MCP session is not yet assigned is bound to the SDK session before route
validation; an already-bound or resolved route that names another session is
refused before executor contact. Route-resolution refusal remains inside the
dispatcher audit boundary and produces a failed terminal event. The dispatcher
deep-snapshots AuthContext before the first await, and a live document-scoped
mutation must name the same document as its routed live identity.

Execution is authoritative window=1 per `rsid`; independent `rsid` values may
still progress concurrently. Every terminal dispatcher outcome emits one
normalized `tool.invocation` envelope through the O7 event-sink seam without
including arguments, results, credentials, or raw tokens. If the audit sink is
unavailable after executor contact, the response reports both
`audit_unavailable` and `executorReached: true` so callers cannot safely treat
it as a never-dispatched retry.

The earlier GW-4 slice left durable conflict/hold recovery, restart survival,
batch invocation/digest propagation, verification and clearance correlation,
bridge acceptance, and production store adapters to their numbered plan rows;
GW-8 confirmation and GW-10 north discovery are now composed above.

M4-00 makes `@revagent/protocol.makeParamsDigest` the sole RFC 8785
parameter-digest implementation used by the Gateway invocation context. The
Gateway keeps its public digest wrapper for API compatibility, while frozen
RBP/1 vectors and malformed-input guards prove that the shared implementation
preserves the prior fail-closed behavior. The frozen protocol sources and root
workspace lockfile remain unchanged.

M4-01 adds a deterministic identity/device-authority adapter only for explicit
`preproduction` mode. Its north bearer and derivation key are synthetic,
caller-injected pre-production fixture inputs; enrollment/device tokens are
derived deterministically and retained only by SHA-256 digest after their one
success response. Enrollment issue, single-use exchange, active/seat-denied
identity, and idempotent revoke until explicit fresh enrollment replaces the
credential are in-memory, process-lifetime seams. They do not claim a durable
replay store, the real
`/bridge/v1/enroll` HTTP route, reboot evidence, or RES-30 completion.
Construction rejects `NODE_ENV=production`, and both the server starter and the
direct app factory reject an injected `preproduction` identity before ingress
or a listener can start. No default bearer, token key, host binding, or runtime
selection was added. The north MCP `NorthMcpAuthenticator` composition remains
a later slice so it can be bound to this same identity source without opening a
second, independently injectable pre-production credential path.

GW-10 is production-code MCP composition, not production OAuth. The handler
accepts only an injected token verifier and requires an HTTPS protected-resource
metadata URL. IdP/OIDC discovery, PKCE/DCR, JWKS rotation, and real production
identity adapters remain M5. GW-12 now supplies production WSS and provisioned
HTTP/SSE RBP ingress through one durable bridge-session authority.
The injected authenticator is contractually responsible for validating token
signature, expiry, audience/resource, scopes, revocation, and tenant/user
identity; the endpoint does not infer any of those from client claims.
`requestState` payloads are signed rather than encrypted and therefore must not
contain secrets.

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
