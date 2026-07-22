> Part of the RevAgent implementation plan (see `00-INDEX.md`).
> Normativity: `docs/TARGET_ARCHITECTURE.md` → `00-INDEX.md` resolutions (RES-*/GAP-*) → this section.
> Where this section conflicts with a resolution in `00-INDEX.md`, the index wins.

# P2 — Gateway Core: Phase-1 North MCP, Registry, Policy, and Executor Dispatch

Long-term orchestration/provider/context architecture remains described here for traceability, but RES-23
changes what is implemented during Phase 1.

## (a) Scope & non-goals

**Phase-1 in scope (RES-23 authoritative)**
- Gateway service shell: health/config/logging, auth/licensing hooks, and container entry point. Phase-1 config
  MUST NOT require `LLM_API_KEY`, provider, model, prompt, or chat-session settings.
- Tool Registry and entitlement views: schema harvesting from the current 35-tool runtime plus five docs tools,
  namespaced names, policy classes, exact executor bindings (`bridge|aps|internal_mcp`), variants, versions,
  module metadata, a byte-stable capability index, deferred-schema search, and a session-scoped callable view.
- One north MCP surface over Streamable HTTP + OAuth for the selected existing ChatGPT/Codex Desktop client.
  The external client owns conversation context, planning, model calls, retries, and the agentic loop.
- Mode A discovery without a Gateway-owned loop: the capability index plus `tool_search` and `tool_schema`
  meta-tools, a small pinned callable set, session-sticky schema activation, and bounded LRU eviction. The
  Gateway supplies deterministic registry discovery; it does not choose tools or call a model.
- Mode B interface stubs only: `EngineMode`, `SandboxHost`, `generateToolWrapperTree`, and model-capability
  shape declarations are non-executable contracts. Sandbox runtime, egress, limits, and filesystem layout
  remain O2.
- Executor dispatch: authenticated actor/tenant/session context, exact tool/version binding, authoritative
  per-`rsid` serialization, idempotency propagation, `bridge|aps|internal_mcp` selection, and structured outcomes.
- Registry-backed entitlement/policy middleware, GAP-2 preview plus single-use confirmation-token round trip,
  the non-bypassable `gated` seam, and one audit/event record per invocation/approval.
- Production Gateway RBP ingress through O1: WSS primary plus the exact capability-gated Streamable HTTP/SSE
  fallback, durable connection/session/outbox/recovery state, and bridge-session executor delivery.
- Docs-MCP internalization (GAP-3), authenticated client upload, bounded result/artifact delivery, north-MCP
  resources, and WP9/Codex Desktop conformance support.

**Retained long-term scope, explicitly deferred until after Phase 1**
- The in-house agentic loop, Gateway LLM provider/model selection, provider credentials, conversation
  context projection/summarization, planner/router, sub-agents, Mode-B implementation, and Gateway
  chat/session API. A later in-house engine consumes the M2 Mode-A registry/discovery surface instead of
  creating a second one.
- D8/D9 remain the target architecture. Activating this lane requires a later milestone, a reopened
  provider/model/region/quota decision, and a dated R-F record before any Gateway LLM credential is introduced.

**Non-goals (owned by sibling packages; P2 consumes their interfaces)**
- Bridge↔Gateway protocol implementation and the bridge itself (O1 package). P2 defines and consumes an `Executor`/`RevitTransport` interface and develops against a fake + the existing local-TCP path.
- Auth·Licensing·Audit subsystem internals (OIDC, device tokens, seats — O3/O5 package). P2 consumes an `AuthContext` interface and an entitlement query.
- APS integration (O4), web chat client (O8), admin-plane migration (O11), deployment/Compose/warm-standby (Phase-1 ops package, O10), bridge self-update (O9), CSI module internals (only its `gated` policy hook is provided here).
- Mode B sandbox internals (O2), historical data migration (closed: none).
- No new end-user features: feature freeze per §8 holds; every task below is migration/relocation work.

### RES-23 Phase-1 execution boundary

RES-23 is a bounded use of D9's external-client path, not deletion of the long-term in-house-loop design.
During Phase 1:

| Concern | Phase-1 owner/path | Explicitly absent from Gateway |
|---|---|---|
| Agentic loop, model, conversation context | Authorized ChatGPT/Codex Desktop session | Provider adapter, model router, engine turn loop, prompt projection |
| Tool discovery and invocation | Gateway capability index + `tool_search`/`tool_schema` + entitled callable view | Gateway-authored LLM prompts or tool-selection loop |
| Safety | Registry policy → confirmation/gated middleware → executor | Trust in client/model claims or client-only approval settings |
| Execution | Dispatcher → `bridge|aps|internal_mcp` executor | Direct client access to bridge/add-in or bypass of audit/idempotency |
| Evidence | Invocation/approval/audit rows plus WP9 C01–C14 | Token usage, prompt-cache, or Gateway-model metrics |

The old GW-5, GW-6, and GW-11 identifiers are retained below so architecture history remains
traceable, but they are post-Phase-1 backlog. They are not dependencies of the Phase-1 north MCP path, are not
included in its estimate/gate, and MUST NOT introduce Phase-1 env vars, secrets, routes, containers, or CI
requirements. A failed WP9 client test blocks pilot/cutover; it does not authorize a silent Gateway-loop
fallback.

## (b) Plan-level design decisions

**P-GW-1 — Gateway is a TypeScript/Node event-loop service (Fastify + node:http, ESM, Node 24 LTS).** Justification vs alternatives: the entire tool layer — 75 TS files, ~26k lines, all input schemas as inline zod objects, all C# codegen helpers — already exists in TypeScript ESM (`installer/runtime-mcp-server/`), and §9 pins "all tool implementations" as unchanged; any non-Node gateway (Go, C#/.NET, Python) would force either a rewrite of that layer or an awkward out-of-process hop between dispatch and tools, recreating the very IPC the architecture removes. The Phase-1 Gateway is I/O-bound on north-MCP, database, object-store, and bridge traffic, which fits Node's event loop; the MCP SDK with `StreamableHTTPServerTransport` for the north boundary is already a pinned dependency; zod schemas are simultaneously the runtime validators and the source for client-visible JSON Schema generation. Fastify over NestJS (no DI framework needed for the bounded Phase-1 modules; keeps 12-factor config trivial) and over Express (native async, schema-validated routes, better perf under streaming). WP5 P5-T4 is authoritative for the `node:24-bookworm-slim` image; package engines, the dedicated Gateway CI job, local conformance, and the production image MUST run the same Node major.

**P-GW-2 — Phase 1 consumes the frozen runtime through explicit registry/executor boundaries; source
relocation is later.** The M0 spike proved the swap point by bundling the existing `registerTools()` surface,
but that bundle and its incidental dependency graph are not the M2 production boundary. M2 keeps
`installer/runtime-mcp-server/src/tools/**` and `src/revit-plugin/**` unchanged unless a separately recorded
protocol/transport adaptation or freeze exception names the exact paths. A build-only pipeline runs against
the exact frozen source commit and each legacy package's own lockfile. Its collector emits a content-hashed
registry seed, while its production packager compiles two immutable ESM handler modules (35 runtime tools and
five docs tools), a handler-to-executor manifest, an external/native dependency inventory, and SHA-256s. Calls
into the two exact Revit transport chokepoint exports are rebound at build time to a new unfrozen
`ExecutorPort` adapter; every other import remains source/hash checked. The Gateway image copies only those
manifest-listed artifacts and their deliberately owned runtime dependencies, verifies all hashes at startup,
and loads a handler only through its exact registry version/binding. This is build-time import/packaging, not a
`git mv`, legacy-source edit, generated-source commit, or runtime import from the old stdio entry point.

`@revagent/gateway` therefore does not ship or load the M0 `bundle:legacy` graph. The build must fail if an
expected entry/import hash drifts, an undeclared native dependency appears, a handler lacks a disposition, or
the produced module attempts to load workstation-only paths outside its named executor/store/file-ingress
boundary. The stdio runtime keeps building from its unchanged sources for rollback compatibility.

GW-1 records a per-tool local-dependency disposition before any handler is enabled. The temporary M0
`better-sqlite3`, `@e965/xlsx`, and `csv-parse` declarations and lock entries are removed from the Gateway/root
M0 carry. If equivalent functionality is still required, it is deliberately reintroduced under a named
spatial or file-ingress executor owner, with tenant/device/document scoping, data-location behavior, container
proof, and rollback impact recorded; none of the spike pins survives silently. Moving tool/utils/spatial sources
into a future shared `packages/revit-tool-core` is a post-Retire/freeze-lift task unless a dated R-F exception
names the paths, compatibility proof, and rollback impact.

`MIGRATION_RELEASE_FREEZE` is a fail-closed GitHub **repository variable** read through
`${{ vars.MIGRATION_RELEASE_FREEZE }}`, not an Environment variable or an environment-protection rule. Absence,
an empty value, or anything other than exact lowercase `off` leaves publishing frozen. Source-diff evidence
proves only that frozen code/workflow paths are unchanged; separate read-only repository-variable plus guarded
workflow-run evidence proves the release-freeze gate remains enforced.

**P-GW-3 — Tool onboarding via a `RegistryCollector` that implements the existing `ToolServer` interface — zero edits to the 35 tool files.** Every tool registers through `server.tool(name, description, zodShape, handler)` against the 13-line interface at `installer/runtime-mcp-server/src/tools/types.d.ts:10-22`. The build-only collector records `(name, description, zodShape, handler identity)` and emits serializable schema/binding metadata; it never attempts to serialize a handler function or make the legacy stdio entry point a production dependency. The paired packager emits the executable handler modules and manifest described by P-GW-2. Production dispatch resolves one content-hashed handler export and one executor port from that manifest; unknown hashes, exports, or bindings fail startup. `registerTools()` runs unmodified inside both controlled build phases. The interception pattern proven by `wrapServerWithTelemetry` (`src/utils/telemetry.ts:1820-1935`) is reused in the new dispatcher without importing its workstation writers.

**P-GW-4 — Registry = code-defined truth for schema+handler, DB-resident truth for governance.** The build-only collector serializes zod→JSON Schema (`zod-to-json-schema`) and emits a content-hashed `registry-seed.json` artifact per module; a deploy-time sync job upserts `tool` / `tool_version` rows. Policy class, namespace, exact executor binding (`bridge|aps|internal_mcp`), `variants[]`, entitlement mapping, and deprecation state live in Postgres and are editable without redeploy; schema/handler changes require a new seed (new `tool_version` row keyed by content hash). Per RES-14, `dynamic_code` can never select an `aps` variant, and this negative rule is enforced both at seed validation and dispatch. Phase 1 reserves the `aps` binding with a fail-closed adapter that returns structured `executor_unavailable` without making any APS call. Invocation/session/audit interfaces use a discriminated document identity capable of carrying live session document ids or the future `{acc_project_id,item_urn,version_urn,version_number}` published identity; Phase 1 does not populate a published identity. WP6 P6-T1 reviews and signs off these five seams before M2 closes or WP4 freezes its schema. The E5 table (35 tools → `core.*` names, policy classes, S/M/L schema sizes) is the initial metadata authoring input. The existing `config/dynamic-tool-promotion-registry.json` + `-rules.json` (dynamic-C#→native-tool promotion candidates) folds in later as `tool_candidate` records — same governance store, no separate file.

**P-GW-5 — Per-invocation execution context via `AsyncLocalStorage`; executor binding resolved at the two existing chokepoints.** All 30+ Revit-bound tools reach the socket exclusively through `executeRevitCode` (`src/utils/revitToolHelpers.ts:369`) and `sendRevitCommand` (`:472`; plus `get_selected_elements` at `:604` which calls the latter). These two functions are re-pointed at a `RevitTransport` interface with three implementations: `FakeRevitTransport` (test), `LocalTcpTransport` (wraps today's `withRevitConnection`, `src/utils/ConnectionManager.ts:323-366`, kept for the stdio shell and dev harness), and Gateway-side `BridgeSessionTransport`, which dispatches through an authenticated `rsid` already owned by the production RBP ingress. It is not an O1 client delivered by WP3: WP1 owns the shared protocol/vectors, WP2 owns the Gateway endpoint/session table, and WP3 owns the .NET bridge. Tenant, session, bridge-session id, canonical idempotency key, mutation scope, policy decision, recovery correlation, and audit correlation ride an `InvocationContext` in `AsyncLocalStorage` so the `(args, extra)` handler signature of all 35 tools stays untouched.

**P-GW-6 — Client-visible schemas are derived by stripping the two mixins; routing/audit fields are injected server-side.** `connectionTargetSchema` (target/host/port) and `taskMetadataSchema` (taskName/taskId/parentTaskName/parentTaskId) at `src/utils/revitToolHelpers.ts:50-65` disappear from every north-MCP `tools/list` schema (≈7 params × 35 tools removed); the dispatcher merges authenticated session-routing and audit fields into `args` before invoking the handler. Handlers keep reading them via `connectionOptionsFromArgs`/`taskOptionsFromArgs` (`:75-98`) unchanged. A later in-house loop consumes the same stripped registry view.

**P-GW-7 — Mode A discovery is a registry service, not a Gateway-owned agentic loop.** The capability index
contains one stable line per entitled tool and is available at initialization as the north MCP instruction/
resource payload. The initially callable view contains the meta-tools plus a pinned core set:
`core.element.query`, `core.document.context`, `core.view.context`, and `core.session.status`.
`tool_search(query)` ranks deterministically over name, description, and argument names/descriptions;
`tool_schema(names[])` returns the selected full JSON Schemas and activates them for that authenticated MCP
session. Activation is session-sticky, bounded by an LRU schema-byte budget, and reflected through the MCP
tool-list change mechanism. Entitlement and policy filtering apply before index/search/schema output, so a
hidden tool cannot be discovered or activated. The external client decides when to search, fetch, and call;
M2 contains no model request, prompt projection, or tool-selection loop. A later in-house engine consumes this
same surface internally.

**P-GW-8 — Mode B ships as non-executable interface stubs only.** M2 defines: (i) `EngineMode`
(`prepareTurn(projection) -> ProviderRequest`, `interpretResponse(response) -> EngineAction[]`);
(ii) `SandboxHost` (`createSession(scope)`, `exec(script, limits)`, `toolRpcEndpoint`);
(iii) `generateToolWrapperTree(registryView) -> FileManifest`; and (iv) the
`supports_tool_search`/`supports_code_exec` model-capability shape. `CodeExecMode` fails closed as
`not_implemented`; there is no sandbox process, provider adapter, credential, route, wrapper tree, egress
policy, resource limit, or filesystem decision in Phase 1. O2 reviews and freezes the concrete contract on
later activation.

**P-GW-9 [POST-PHASE-1] — Conversation context projection remains a future pure function over server-side
session state.** The six-segment design and turn-30 invariant are retained for the later in-house loop. Phase 1
stores only operational MCP/session/audit state needed for authorization, routing, replay, confirmation,
result references, and P-GW-7's callable-schema set; it does not store a Gateway-authored conversation
transcript, prompt projection, summary, or projection-token metrics.

**P-GW-10 — File ingress plus result/artifact hygiene is independent of any Gateway LLM.** Authenticated
client uploads become actor/tenant/MCP-session-scoped `artifact_ref` records with allowlisted content type,
size, digest, expiry, quarantine, and cleanup rules; executors receive authorized refs/bytes, never an arbitrary
client or workstation path. Oversize structured results become scoped `result_ref` resources with paging. The
Gateway RBP receiver accepts only the O1 multi-file output carrier: it verifies sanitized-result mappings,
artifact ids/indices, stream counts, sizes, digests, combined limits, and durable terminal acknowledgement before
publishing expiring north-MCP resources. There is no generic Gateway-to-workstation `file_fetch` message. The
north MCP response exposes bounded content/resource links to Codex Desktop. No Phase-1 code formats a
model-specific summary or assumes a Gateway prompt context; the future in-house loop may consume the same refs.

**P-GW-11 — Guardrails are enforced only at the dispatcher, keyed to registry policy — never trusted from
model, client, or args.** Phase-1 order is authentication/actor binding → entitlement → policy/confirmation →
idempotency → executor → audit. `auto` proceeds. `confirm` first runs the existing preview/dry-run path as its
own journaled Gateway invocation, then stores a single-use `pending_action` bound to actor, tenant, MCP session,
tool version, canonical args digest, preview digest/ref, mutation scope, **originating preview `invocation_id`**,
and 10-minute TTL. Per GAP-2, the selected external client presents the preview and explicitly re-invokes with
the issued `confirm_token`; the commit receives a new invocation id, while its policy/audit row and the separate
approval event retain both the immutable originating preview id and `confirmation_id`. The token authenticates
that exact linkage. Expiry, replay, changed args/tool/user/session/scope/preview id, an unrelated preview, or
direct commit without the token fails and is audited. A client “always allow” setting cannot bypass this server
check. `gated` remains out-of-band and role-checked, never in-channel or tenant-demotable. Existing write-pattern
guards also run before dispatch. Approval is an audit event separate from preview and execution.

**P-GW-12 — Structured dispatcher failures and durable mutation recovery in Phase 1; bounded model loop
later.** Every dispatch error is normalized to the O1/Gateway fault contract and returned through MCP. The
external Codex Desktop loop decides whether to continue, but the Gateway remains the recovery authority.
For every indeterminate mutation it persists one conflict hold per distinct affected scope, indexed by
`(rsid, mutation_scope)`, using the O1 session/document conflict rules and exact `verification_hold_id`
material. Before minting or dispatching every later mutation or batch it checks that index; a new
invocation/batch id, reconnect, or re-registration cannot bypass it. Only an O1-correlated verification read or
conclusive late terminal creates evidence for its exact hold. The Gateway owns each audited
`active -> evidence_recorded -> resolved_pending_bridge -> cleared` transition. For the one next authorized
mutating envelope it mints exactly one evidence-bound clearance per conflicting resolved hold and constructs
`recovery_clearances[]` with unique `hold_id`s in ascending Unicode-code-point order. The array MUST contain
every and only hold that conflicts with that envelope's mutation scopes: a missing, extra, duplicate, unsorted,
stale, or still-inconclusive entry blocks before executor contact. Bridge durable acceptance atomically clears
all matching holds before any add-in byte; there is no partial-clear subset. Inconclusive evidence leaves its
hold active. Idempotent redelivery consults durable O1 state, and Revit-bound writes are never blindly retried.
The three-strike plan-step breaker and user-answer synthesis activate only with the post-Phase-1 in-house loop.

**P-GW-13 [POST-PHASE-1] — Planner/router is part of the later in-house loop and fails open.** Its retained
design classifies `(discipline, data_plane, complexity)` only after a provider/engine milestone exists. Phase 1
does no model routing; registry entitlement and executor routing remain deterministic Gateway responsibilities.

**P-GW-14 [POST-PHASE-1] — Sub-agents remain a re-entrant future engine with namespace-scoped registry
views.** Phase 1 enforces module/namespace entitlement in the north MCP registry view but creates no Gateway
child agents, child prompts, or summaries.

**P-GW-15 — North MCP is the Phase-1 product surface.** The selected existing ChatGPT/Codex Desktop client
gets the entitled capability index, meta-tools, pinned core set, and on-demand schemas over Streamable HTTP +
OAuth and owns its context/loop. Every call enters the same deterministic dispatcher, so policy,
confirmation, licensing, audit, idempotency, and executor routing cannot be bypassed by client behavior. The
five docs tools attach as the first `executor=internal_mcp` registration and participate in the same
capability-index/search/schema path. A future in-house loop consumes the same registry/dispatcher rather than
creating a parallel execution path.

**P-GW-16 — Telemetry: keep the interception pattern, replace the writers.** `wrapServerWithTelemetry`'s wrapping approach survives as the dispatch middleware, but the workstation-era NDJSON writers (%ProgramData% + NAS reportsRoot, `telemetry.ts:1211-1231, 1754-1762`) are replaced by one O7 emitter interface. M2 uses a deterministic capture sink; WP4/M5 supplies the production Postgres event/audit identity sink and reruns the contract. Its existing event vocabulary (params/response summarization, spatial privacy boundary, element/document/view context extraction) is the O7 schema draft; the admin plane reads, never collects (arch §5.10).

## (c) Work breakdown

Estimates are dev-days for one senior developer plus an AI coding assistant. **[M2]** marks the Phase-1
external-client critical path. `M1-frozen` means `docs/plan/M1_O1_FREEZE_EVIDENCE.md` is green, O1 metadata
reads `1.0 / Frozen`, and the protected `main` merge matches that evidence. Per RES-28,
`rbp/v1.0.0` tag closure is a separate non-blocking lane and is not an M2 dependency. Planning, local branches,
and draft review may occur earlier, but **no GW-* implementation PR may merge before `M1-frozen`** (R-B).
Every task below names that dependency explicitly.

External interfaces are: EXT-O1 (the frozen RBP shared contract/vectors), EXT-AUTH-CONTRACT (the frozen
`AuthContext`/`DeviceAuthContext` interfaces plus deterministic fake identity provider delivered by GW-2 and
reviewed by WP4 for later substitution), EXT-AUTH-PROD (WP4/M5 real OIDC, device enrollment, seats, licensing,
and audit identities), EXT-DEPLOY (Compose/Postgres/object-store drivers), EXT-GATEWAY-CI (WP5 P5-T4's
dedicated `.github/workflows/gateway-ci.yml`, Node-24 image/build, and exact-head check), and
EXT-WP6-SEAM-SIGNOFF (P6-T1 review of the five RES-14 seams). M2 builds production endpoint code against the
frozen auth interfaces; it does not claim real OAuth/device-auth readiness. EXT-AUTH-PROD wiring and its
two-tenant negatives are an M5 gate before hands-on DP-10/pilot evidence. No task below may treat GW-5/6/11
as a Phase-1 dependency.

GW-2 and P5-T4 may co-develop as draft PRs, but no M2 code PR merges until the dedicated `gateway-ci.yml`
check is green on its exact head. The additive M0 `ci.yml` job is retained as a workspace regression net, not
accepted as the M2 Linux/container gate. P6-T1 is an exit review over GW-3/GW-4 outputs: its sign-off blocks M2
closure and the WP4 schema freeze, without creating a circular code dependency.

### Phase A — M2 / Phase-1 external-client core

**GW-1 [M2] Registry/executor boundary and legacy-dependency disposition — 3d — deps: M1-frozen.**
Replace the M0 `bundle:legacy` production path with P-GW-2's build-only collector/packager. Run both exact
`registerTools()` surfaces against their source commit and own lockfile; emit the registry seed, immutable
runtime/docs handler modules, handler/executor/dependency manifest, and hashes without moving or editing legacy
sources. Capture golden `(name, description, JSON Schema)` snapshots for 35 runtime and five docs tools.
Inventory every handler's local filesystem, SQLite, PowerShell, Excel/CSV, native-addon, and workstation-path
dependency and record its Phase-1 executor/store/file-ingress disposition. Remove the temporary M0
`better-sqlite3`, `@e965/xlsx`, and `csv-parse` declarations and lock entries from the Gateway/root carry; any
deliberately reintroduced equivalent lives only in its named handler/executor package with decision evidence.
Confirm by import scan that the legacy `ws` declaration is unused, but leave that frozen package and lockfile
unchanged in M2; record removal for the freeze-lift/retire backlog. Gateway WSS support owns an explicit direct
dependency under GW-12. *AC:* 40-tool schema and handler-export
snapshots are deterministic; a packaged read and confirm-class dry-run execute through `ExecutorPort`; startup
rejects a changed hash/export/undeclared dependency; Gateway never loads the stdio entry point or M0 bundle;
legacy build/tests remain unchanged; dependency and frozen-path diffs are clean.

**GW-2 [M2] Gateway service shell — 2d — deps: M1-frozen, EXT-GATEWAY-CI (co-developed with P5-T4; parallel GW-1).**
Extend `packages/gateway`: Fastify/HTTP process, 12-factor non-secret config, `/healthz`, structured logging,
Postgres/auth/object-store ports, north-MCP and RBP ingress hosts, and container entry point. Freeze the
WP4-reviewed `AuthContext`, `DeviceAuthContext`, event sink, and `GatewayProtocolStore` interfaces and provide
deterministic fake identity/event plus restartable test-store adapters; no real OIDC/device enrollment is
implemented here. Phase-1 modules
are `registry`, `dispatch`, `guardrails`, `north-mcp`, `rbp-ingress`, `events`, and `store`; there is no
provider, in-house engine, conversation context projection, or chat API activation. Add P-GW-8's
non-executable interfaces with no runtime side effects or configuration. Use Node 24 in package engines, CI, and the
`node:24-bookworm-slim` image. *AC:* the dedicated `gateway-ci.yml` exact-head check runs install, lint,
typecheck, tests, secret scan, and image build without editing `ci.yml`; the container boots with EXT-DEPLOY;
health is green; startup and `.env.example` contain no LLM/provider/model key or setting; Mode-B interfaces
typecheck and attempted `CodeExecMode` execution fails closed as `not_implemented`.

**GW-3 [M2] Registry, entitlement, policy, and executor seed — 5d — deps: M1-frozen, GW-1, GW-2.**
`RegistryCollector implements ToolServer`; zod→JSON Schema; mixin stripping; versioned seed sync for modules,
tools, policies, exact `bridge|aps|internal_mcp` executor bindings, `variants[]`, instruction metadata, and
entitlement joins owned with EXT-AUTH-CONTRACT/WP4. Generate P-GW-7's byte-stable capability index and
deterministic search corpus from that same entitled registry view. Author the E5 mapping for all 40 tools. Apply RES-14 at
seed validation and dispatch: `aps` is a valid future executor variant, but `dynamic_code` can never resolve to
it. Register the Phase-1 `aps` placeholder as an explicit fail-closed executor, not an omitted switch case.
*AC:* deterministic fake tenant/user views produce byte-stable capability indexes and search results;
unentitled tools are absent from index/search/schema output and forged calls are denied; all five
confirm-class tools are correctly classified; docs tools bind exactly to
`internal_mcp`; variants and the `dynamic_code` negative rule have contract tests; an `aps`-bound invocation
returns structured `executor_unavailable` without network access or process failure.

**GW-4 [M2] Invocation context, dispatcher, durable recovery authority, and audit seam — 6d — deps: M1-frozen, GW-1, GW-2, EXT-AUTH-CONTRACT (coordinate RES-14 types with GW-3).** Create `InvocationContext`; executor interfaces for
`FakeRevitTransport`, local compatibility, bridge session, `internal_mcp`, and fail-closed `aps`; enforce one
in-flight call per `rsid`; propagate exact `rsid + "/" + invocation_id`, canonical parameter/batch digests,
mutation scope, policy, verification, and clearance correlations. Define the discriminated live/published
document identity seam with URN-capable published fields required by RES-14, without implementing APS runtime.
Implement the durable Gateway conflict index and per-hold
`active -> evidence_recorded -> resolved_pending_bridge -> cleared` FSM, including session/document conflict,
fresh-id/batch bypass rejection, correlated verification, late-terminal evidence, inconclusive retention,
multi-hold every-and-only clearance arrays, and atomic bridge-acceptance completion. Emit one normalized event
through the O7 sink interface; the deterministic fake captures actor/audit evidence in M2 and EXT-AUTH-PROD
replaces it at M5. *AC:* every call binds actor, tenant, MCP session, tool/version, policy, executor, document
identity, params digest, scope, outcome, hold/resolution ids, and timestamps; cross-tenant/session routing and
every conflicting mutation fail before executor contact; restart preserves holds; missing/extra/duplicate/
unsorted/stale clearances and any partial subset fail closed; parallel sessions do not share mutable state.

**GW-8 [M2] Policy middleware + GAP-2 confirmation/audit round trip — 4d — deps: M1-frozen, GW-3, GW-4, EXT-AUTH-CONTRACT.**
Implement P-GW-11 `pending_action` and single-use `confirm_token` lifecycle through ordinary MCP tool
responses/re-invocation; journal the immutable originating preview `invocation_id`, preview digest/ref, and
scope, and link both approval and commit audit records to that id plus `confirmation_id`; retain `gated`
out-of-band role seam and server-side write guards. *AC:* preview does not write; one token matching the exact
originating preview commits once under a new invocation id; replay, expiry, foreign actor/session, changed
tool/version/args/scope/preview id, unrelated preview, direct commit, and client “always allow” bypass all fail
and are separately audited under the deterministic fake; M5 reruns the same matrix against EXT-AUTH-PROD.

**GW-10 [M2] North MCP surface for Codex Desktop — 3d — deps: M1-frozen, GW-3, GW-4, GW-8, EXT-AUTH-CONTRACT.** Implement the production Streamable HTTP endpoint and frozen OAuth/AuthContext seam with
per-connection entitled registry view, capability-index instruction/resource payload, `tool_search`,
`tool_schema`, the pinned core callable set, session-sticky bounded schema activation, tool-list change
notification, session-to-bridge selection, structured outcomes, and five `internal_mcp` docs tools. M2
conformance uses the deterministic fake identity provider; static bearer auth exists only in isolated protocol
fixtures. EXT-AUTH-PROD is wired and proven at M5, so neither M2 nor a fake-auth run may claim real OAuth or
pilot readiness. *AC:* Gateway fixture and the DP-10 harness can initialize, verify the exact entitled
capability index, observe only meta/pinned tools initially, search a non-pinned runtime tool and a docs tool,
activate their schemas, call both through their bound executors, evict beyond the schema-byte budget, exercise
confirmation, deny an unentitled/forged discovery or call, and retain actor/audit correlation; the same suite
is reusable unchanged at M5. Actual Codex Desktop hands-on evidence remains WP9 C01–C14.

**GW-9 [M2] Client file ingress, result refs, and multi-file artifact resources — 5d — deps: M1-frozen, GW-4, GW-10.** Accept authenticated north-client uploads into actor/tenant/MCP-session-scoped `artifact_ref`
records with content-type, size, digest, quarantine, expiry, and cleanup controls; pass authorized refs/bytes to
file-aware executors without leaking a client path. Bound structured responses into `result_ref` pages. Ingest
the O1 RBP multi-file output carrier only after validating sanitized-result mapping, contiguous artifact ids/
indices, independent streams, counts, sizes, digests, combined limits, and durable terminal acceptance; then
publish expiring MCP resources. Never implement a generic Gateway-to-workstation `file_fetch` path. *AC:* a
fixture uploads an Excel/CSV source for reconciliation and consumes it by ref; a two-image RBP result becomes
two authorized resources; oversized, cross-tenant/session, expired, raw-path, stream collision, partial sibling,
and digest-mismatch cases fail closed.

**GW-12 [M2] Production Gateway RBP ingress + bridge-session executor — 6d — deps: M1-frozen, GW-4, EXT-O1, EXT-AUTH-CONTRACT, EXT-DEPLOY.** Declare and lock the Gateway's own reviewed WSS library directly (the initial candidate is the M1-conformance-proven `ws` line; do not rely on the legacy runtime's unused transitive declaration). Terminate primary `wss://<configured-dns>/bridge/v1` and the exact capability-gated
`POST /bridge/v1/http/connections` + `GET /bridge/v1/http/connections/{connection_id}/events` +
`POST /bridge/v1/http/connections/{connection_id}/messages` HTTP/SSE fallback. The create call returns `201`
with matching header/body connection ids; the SSE stream uses `event: rbp` and never treats `Last-Event-ID` as
RBP sequence authority; uplink returns `202` only after durable acceptance. Both bindings
feed one RBP semantic/FSM implementation and enforce identical device-context authorization, TLS/version
refusals, `v(N)`/`v(N-1)`, capability intersection, sequence/ack/gap/duplicate rules, window=1, backpressure,
heartbeat/degraded/disconnected thresholds, reconnect, graceful drain, and error mapping. Persist connection,
`rsid`, resume-token lifetime, cumulative ack, unacked outbox, pending-window, and recovery/hold state through
the Phase-1 Postgres store contract so Gateway restart preserves resume and retransmission. The M2 suite uses
deterministic device identity and restartable Postgres; EXT-AUTH-PROD replaces identity at M5 without changing
RBP semantics. `BridgeSessionTransport` dispatches only to a registered authorized `rsid`; no invoke hot-path
`mcp_status` exists. *AC:* the O1 WSS and exact proxy HTTP/SSE corpus is green; WSS failure selects fallback
only when provisioned; one cycle has one active binding; restart resumes unacked frames and holds; 35 runtime
tools route through the fixture; kill-mid-write never becomes a retryable environment guess or duplicate.

**GW-13 [M2] External-client and RBP readiness harness — 4d — deps: M1-frozen, GW-8, GW-9, GW-10, GW-12.** Automate the server-observable halves of WP9 C01–C14: fake-auth/session binding, capability-index/search/schema activation and denial, pinned/read,
preview/token/commit/replay with originating-preview correlation, both RBP bindings,
progress/cancel/reconnect/restart, client upload, multi-file resource scope/expiry, single- and multi-hold
evidence/every-and-only-clearance recovery, APS `executor_unavailable`, URN-capable document-identity seams, and
audit correlation, plus Mode-B stub type/fail-closed evidence. *AC:* the dedicated Gateway CI emits machine-readable evidence; P6-T1 records WP6 sign-off
on all five RES-14 seams; and a live-smoke command is ready for the selected Codex Desktop and NET01 after
M3/M5 integration. Fake identity cannot mark OAuth passed, and manual account/UX/file/live-Revit observations
remain explicitly in WP9.

**M2 core total: 38 dev-days. Dependency-only critical path: GW-1 → GW-4 → GW-8 → GW-10 → GW-9 →
GW-13 ≈ 25 dev-days; GW-2/GW-3 and GW-12 run in parallel where their dependencies allow.** This estimate
includes immutable production handler packaging/loading, production-code RBP ingress, durable recovery, and
bidirectional file/resource work. It excludes
calendar wait for EXT-AUTH-PROD, WP3 live bridge/add-in delivery, and operator-owned WP9 observations; those
remain explicit M4/M5/pilot gates rather than hidden zero-day assumptions.

### Phase B — Phase-1 hardening after the M2 core

**GW-16 Batch primitive + write-retry policy — 3d — deps: M1-frozen, GW-12, EXT-O1 atomic batch support.**
Expose only registry-authorized batching paths; use one RBP transaction group and journal-governed redelivery.
*AC:* five-step fixture uses one bridge round trip/transaction group and forced redelivery executes no duplicate.

**GW-19 Instruction/module packaging hooks — 3d — deps: M1-frozen, GW-3.**
Version module-scoped instruction metadata and O6 manifests (tools + policies + exact executor bindings).
Rewrite the Phase-1 instruction layer for remote tool names, external-client ownership, server confirmation,
file resources, and the no-Gateway-loop boundary; run the relevant evals before pilot. Phase 1 does not inject
these documents into a Gateway prompt. *AC:* versions and module entitlement are stable and auditable; the
external client receives the correct instruction resource; later engines can pin a version without schema change.

**GW-20 Docs/promotion governance fold-in — 2d — deps: M1-frozen, GW-3.**
Ingest candidate/rule metadata into the registry and expose the admin-readable feed. It remains human-review
evidence, never automatic tool promotion or priority authorization. *AC:* fixture candidates preserve source
evidence and review state without changing the entitled catalog.

**Phase-1 hardening total: 8 dev-days. Phase-1 WP2 total: 46 dev-days.**

### Post-Phase-1 in-house-loop backlog (D8/D9 retained)

These IDs are deliberately retained, but none is a Phase-1 gate or dependency:

**GW-5 [POST-PHASE-1] LLM provider layer — 3d — deps: M1-frozen, reopened provider decision, GW-2.**
Implement the OpenAI-compatible adapter, streaming/usage, capability flags, queue/quota, and cloud/local
contract tests only after provider/model/region/quota approval. *AC:* no credential/config reaches Phase 1;
activation has a dated R-F/DP record and proves the D8 switch.

**GW-6 [POST-PHASE-1] Conversation store + minimal context projection — 3d — deps: M1-frozen, GW-3, GW-5.**
Add message/turn state and pure projection segments for the future engine. Operational MCP/audit rows remain
separate. *AC:* projection is deterministic and tenant-scoped; Phase-1 records require no backfill.

**GW-7 [POST-PHASE-1] In-house engine v0 consuming Mode A — 5d — deps: M1-frozen, GW-3, GW-4, GW-5, GW-6.**
Implement the five-stage tool-calling loop, consume M2's capability-index/search/schema surface, add bounded
failure-loop behavior, and reuse the idempotent dispatcher. *AC:* scripted fake-model sessions pass without
creating a second discovery, policy, or executor path.

**GW-11 [POST-PHASE-1] Gateway chat/session API — 3d — deps: M1-frozen, GW-7, GW-8.**
Create user-turn/event streaming endpoints for a future web client. *AC:* full conversation/approval tests reuse
the same pending action and dispatcher; the API is absent from Phase-1 routes/config.

**GW-14 [POST-PHASE-1] Full context projection — 5d — deps: M1-frozen, GW-6, GW-7.**
Add rolling summary, working set, result-ref eviction, budget allocation, and turn-30 invariant.

**GW-15 [POST-PHASE-1] Planner/router — 3d — deps: M1-frozen, GW-14.**
Add the optional small-model classifier only with measured value and deterministic registry enforcement.

**GW-17 [POST-PHASE-1] Sub-agents — 4d — deps: M1-frozen, GW-14.**
Add re-entrant namespace-scoped engines; only summaries return to the parent.

**GW-18 [POST-PHASE-1] Mode B/O2 interface activation review — 1d — deps: M1-frozen, GW-7, O2 activation.**
Review and freeze M2's sandbox/wrapper stubs against the then-current engine and dispatcher before adding any
executable sandbox behavior.

**Post-Phase-1 in-house-loop backlog: 27 dev-days.**

### Post-Retire or exception-only relocation

**GW-21 Frozen tool-core relocation — 3d — deps: M1-frozen, GW-1, M10 freeze lift or exact dated R-F exception.** Move shared tool code only after the release/migration freeze permits the named paths. Preserve the
stdio rollback shell and golden 40-tool snapshot. *AC:* exception/lift evidence is linked; old/new consumers
pass identical schema and behavior suites; no field rollout occurs from a topic branch. This task is outside the
Phase-1 total and is not a default Build/hardening activity.

**Combined long-term package estimate: 76 dev-days** (46 Phase-1 + 27 later in-house loop + 3 relocation),
excluding external-package wait and hands-on/operator calendar time.

## (d) Test strategy

1. **M1, freeze, and dedicated-CI entry gate.** Every GW implementation PR checks the retained M1 freeze
   evidence, metadata, protocol constant, and protected `main` identity, then passes P5-T4's dedicated
   `gateway-ci.yml` on Node 24 and
   its image build. GW-1 captures all 35 runtime and five docs-tool `(name, description, JSON Schema, handler
   export)` records, proves that the M0 bundle and three incidental dependency declarations/lock entries are
   absent, verifies the produced module/manifest hashes, and diffs the frozen source/workflow paths. Separate
   read-only GitHub repository-variable plus guarded-workflow evidence proves the fail-closed
   `MIGRATION_RELEASE_FREEZE` gate remains enforced; a source diff never claims to prove that variable.
2. **Registry/policy/packaging unit suite.** Cover mixin stripping, seed/module hash stability, manifest-only
   handler loading, unknown export/hash/dependency rejection, namespace/entitlement views, exact
   `bridge|aps|internal_mcp` bindings, `variants[]`, structured APS `executor_unavailable`, URN-capable document
   identities, `dynamic_code`-never-`aps`, canonical parameter/batch digests, the originating-preview invocation
   link through confirmation/commit audit rows, policy matrices, fault mapping, and tenant/session TTL isolation.
3. **North-MCP/auth-seam contract suite.** Exercise initialize/session handling, fake actor binding,
   capability-index bytes, pinned/meta `tools/list`, search ranking, schema activation/eviction and list-change,
   invocation, progress/cancel/error outcomes, upload, resources/paging, reconnect, and graceful shutdown.
   Static bearer credentials exist only in an isolated fixture. At M5 the unchanged suite runs against
   EXT-AUTH-PROD; fake-auth evidence cannot pass OAuth, DP-10, or pilot gates.
4. **Production RBP ingress suite.** Run the exact O1 corpus against primary `WSS /bridge/v1` and the frozen
   HTTP/SSE create/events/messages lifecycle through a buffering/proxy fixture. Assert provisioned-only fallback,
   one active binding, `v(N)`/`v(N-1)`, heartbeat 15 s/degraded 35 s/disconnected 65 s, seq/ack/gap/duplicate,
   durable outbox, resume after Gateway/Postgres restart, backpressure, drain, and identical semantic outcomes.
5. **Dispatcher/recovery E2E on `FakeRevitTransport`.** Run catalog→read, preview→token→commit, gated denial,
   idempotent terminal replay, session/document conflict holds, fresh-id and batch bypass rejection, correlated
   verification, inconclusive evidence, late terminal, single- and multi-hold clearance, restart, and audit
   correlation without a model, provider, prompt, or Gateway turn loop. For multi-scope envelopes, require the
   sorted every-and-only clearance set and reject missing, extra, duplicate, unsorted, stale, inconclusive, or
   partial-clear variants before executor contact.
6. **File/result security negatives.** Reject cross-actor/tenant/session `result_ref`, upload, artifact, and
   `pending_action` access; expired refs; raw paths; unsupported type/size; digest or stream collision; partial
   multi-file siblings; arbitrary workstation reads; and any attempted generic `file_fetch`. Verify one Excel/CSV
   input ref and independently authorized multi-file output resources.
7. **Executor and guardrail conformance.** Run the same executor contract against Fake, LocalTcp in the Windows
   compatibility lane, and Bridge after EXT-O1/WP3 land; run the reserved APS binding against the fail-closed
   no-network adapter and retain P6-T1 sign-off. Assert one in-flight call per `rsid`, no hot-path status probe,
   no duplicate write, exact batch behavior, confirmation replay/expiry/foreign/args/originating-preview
   mismatch rejection, and no in-channel `gated` approval or `core.code.execute` write-guard bypass.
8. **WP9 readiness evidence.** GW-13 automates only the server-observable halves of C01–C14 and emits a
   machine-readable report. Actual Codex Desktop account, OAuth, UX, confirmation, streaming, local-file,
   privacy, Gateway, and live-Revit observations remain hands-on WP9 evidence; a fixture cannot mark them passed.
9. **Post-Phase-1 activation suite.** Provider cloud/local contract smokes, in-house engine scripted sessions,
   model-side selection evals over M2's Mode-A discovery surface, prompt/instruction fidelity, and the turn-30
   projection invariant are added only when the in-house-loop milestone is approved. None is a Phase-1 build,
   CI, pilot, or cutover gate.

## (e) Risks specific to this package

1. **Module-level singleton and workstation-local state.** The runtime assumes one user/machine/process:
   telemetry session UUID + sequence counters (`telemetry.ts:55-56,145`), live-task maps, spatial-store singleton
   (`spatialStoreManager.ts:26-34`), per-connection framing mode, local SQLite, PowerShell, and file paths.
   Concurrent tenants/sessions in one Gateway process would cross-contaminate. *Mitigation:* GW-1's per-tool
   disposition is an M2 gate; GW-4 scopes mutable state by tenant/device/document/session and adds a lint rule.
   An unresolved local dependency is not silently packaged or deferred past pilot.
2. **Platform behavior shift Linux vs Windows and accidental M0 dependency adoption.** The spatial/file code
   has Windows assumptions, while the M0 bundle pulled exact `better-sqlite3`, `@e965/xlsx`, and `csv-parse`
   pins into Gateway only to load registration. *Mitigation:* GW-1 removes that carry first. Any equivalent is
   deliberately selected behind its named executor/store/ingress boundary and must pass Linux-container,
   tenancy, data-location, restore, and packaging tests; “it compiles in the container” alone is not disposition.
3. **Loose TCP response correlation is currently masked.** `SocketClient` broadcasts unmatched errors to all pending callbacks (`SocketClient.ts:223-238`); today safe only because there's one socket per call. Any gateway-side parallelism per session before O1 tightens correlation risks cross-wired results. *Mitigation:* the GW-4/GW-12 dispatcher enforces one in-flight call per `rsid`; batching (GW-16) starts only after O1 correlation and atomic-batch contracts pass.
4. **External-client behavior can drift independently of Gateway deploys.** Codex Desktop updates may change OAuth, streaming, confirmation presentation, resource handling, or local-file behavior. *Mitigation:* WP9 C01–C14 hands-on evidence is version/date stamped and blocks pilot/cutover on failure; GW-13 provides repeatable server-side diagnostics, never a silent Gateway-loop fallback.
5. **Confirmation semantics can be weakened by client UX.** A client may offer “always allow” or replay a tool call, but that is not server authorization. *Mitigation:* the dispatcher requires a single-use actor/tenant/session/tool-version/args-digest-bound token for `confirm`; `gated` is role-checked and out-of-band only; every denial and approval is separately audited.
6. **A production auth shortcut would defeat tenant and approval binding.** Static bearer or deterministic fake
   success could look like deploy readiness. *Mitigation:* both are fixture-only; production startup/pilot mode
   requires EXT-AUTH-PROD and fails closed when it is unavailable. M5 reruns the same actor/tenant/seat/token
   negatives before DP-10 hands-on evidence begins.
7. **Frozen-source relocation or rewrite could poison the rollback path.** Moving or editing the legacy stdio
   sources during the migration freeze would enlarge M2 and risk deployed behavior. *Mitigation:* GW-1 uses the
   hash-bound build-only collector/packager, runs the unchanged legacy suite, and mechanically asserts zero
   frozen-path edits; GW-21 sits outside Phase 1 and requires M10 freeze lift or an exact dated R-F exception
   plus golden behavior tests.
8. **Deferred discovery may not be honored consistently by the external client.** Phase 1 has a Gateway Mode-A
   registry surface but no Gateway model loop, so usability still depends on Codex Desktop consuming the
   capability index, invoking search/schema meta-tools, and refreshing the callable list correctly.
   *Mitigation:* keep the pinned set useful, bound the activated-schema budget, test list-change behavior in
   GW-10/GW-13, and treat WP9 conformance as a hard gate rather than silently reverting to all-schema preload.
9. **Scope creep can reintroduce an unapproved LLM control plane.** Provider/in-house-engine/context/chat code,
   config, or tests can quietly become a Phase-1 dependency. *Mitigation:* GW-2 and CI assert the absence of
   LLM credentials/settings and runtime engine routes; P-GW-8's fail-closed type-only stubs are the sole
   exception. GW-5/6/7/11/14/15/17/18 executable activation requires a later milestone, reopened decision
   record, and dated R-F.
